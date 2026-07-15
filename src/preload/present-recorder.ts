/// <reference lib="dom" />
// Recording bridge — a preload TalkWeaver attaches to the PRESENT window only when it
// opens it (opt-in). A deck opened as a plain portable file has no preload, so it has no
// REC control and stays fully portable (spec, ADR-0035). Running here, the bridge:
//   • records the presenter's mic with MediaRecorder,
//   • builds the slide-time index by watching which slide id is in the URL hash,
//   • hands the audio + raw marks + session metadata to main on stop (recording:save).
//
// It shares the DOM with the deck runtime but lives in its own isolated JS world
// (contextIsolation), so it never touches the 6,400-line presenter template — it ADDS a
// control (Task 3) and reads the hash the runtime already maintains. Nothing here removes
// or moves an existing control, and no path can lose a saved recording: audio is buffered
// and written to local disk before any upload (main, Task 5/6).
//
// SLIDE CAPTURE — why polling, not `hashchange`: the runtime updates the slide hash via
// `history.replaceState` (template line ~5578), and replaceState/pushState DO NOT fire a
// `hashchange` event — that event only fires on real navigation. So a `hashchange`
// listener would miss every presenter-driven slide advance (arrow keys, Next). We instead
// poll `location.hash` (shared across isolated worlds) on a light interval and emit an
// `enter` mark when it changes, with a `hashchange` listener kept as belt-and-braces for
// any externally-driven change (audience sync, manual URL edit).

import { ipcRenderer } from 'electron'
import { mountEditBridge } from './present-edit-bridge'

// ── Types ────────────────────────────────────────────────────────────────────

// idle → recording ⇄ paused → (confirm if short) → saving → saved   (error is terminal-for-this-run).
// `confirm` = a short recording is waiting on a Keep/Discard choice — nothing is saved until then.
export type RecState = 'idle' | 'recording' | 'paused' | 'confirm' | 'saving' | 'saved' | 'error'
type RunKind = 'delivery' | 'rehearsal' | 'recording'

// A raw mark is stamped on the RAW recorder clock (ms since record start, paused time
// INCLUDED). The pure ledger module (16-presentation-ledger.mjs, in main) re-bases these
// onto the pause-aware recording clock — the bridge does no pause math for the marks.
// enter = slide change · reveal = an in-slide build step (fragments shown/hidden) ·
// highlight = a live highlight added/cleared — so replay can reproduce what was on screen.
type RawEvent = 'enter' | 'reveal' | 'highlight' | 'pause' | 'resume' | 'stop'
type HighlightRange = { block: number; start: number; end: number }
export interface RawMark {
  event: RawEvent
  slideId?: string
  tMs: number
  hidden?: number // reveal: fragments still hidden on the slide (fewer = more revealed)
  marks?: number // highlight: count of live highlight marks on the slide
  ranges?: HighlightRange[] // highlight: reconstructed text ranges; omitted if reconstruction fails
}

export interface RecContext {
  talkSlug: string
  talkTitle: string
  timerTargetMin: number
  pathwayId: string | null
  preferredPlannedRunId: string | null
  // Below this pause-aware length, stopping asks Keep/Discard instead of saving straight away
  // (a short recording is never silently dropped). Settings → Recording; default 20s.
  discardThresholdMs: number
  // Main sets this from an env flag for the e2e harness — synthesise audio instead of
  // opening a real mic, so the capture path is exercised headlessly. Never set in production.
  testMode: boolean
}

export interface SaveResult {
  ok: boolean
  sessionId?: string
  kind?: RunKind
  discarded?: boolean
  error?: string
}

type PlannedRunChoice = {
  id: string
  plannedDate?: string
  eventTitle?: string
  audience?: string
  slideSet?: { kind: 'full' } | { kind: 'pathway'; pathwayId: string }
  preferred?: boolean
}

export interface RecorderController {
  getState(): RecState
  /** Pause-aware recording length in ms (frozen while paused; final after stop). */
  displayMs(): number
  /** The slide id currently in the URL hash (the ledger `{id=…}`). */
  currentSlideId(): string
  start(): Promise<void>
  pause(): void
  resume(): void
  /** Stop recording. A run at/above the threshold saves; a short one enters `confirm` and awaits confirmSave. */
  stop(): Promise<SaveResult | null>
  /** Resolve a `confirm`: keep=true forces the save, keep=false discards. No-op outside `confirm`. */
  confirmSave(keep: boolean): Promise<SaveResult | null>
  /** Fired on every state transition and whenever the current slide changes. */
  onChange(cb: (state: RecState) => void): void
  /** Fired when the presenter moves to another slide WHILE paused (drives the resume offer). */
  onSlideMovedWhilePaused(cb: () => void): void
  /** Fired with a human-readable message when recording fails (mic denied, save error). */
  onError(cb: (message: string) => void): void
  /** Last save result (for the injected UI to reflect "saved" vs "discarded"). */
  lastSave(): SaveResult | null
  /** Persist the always-on wall-clock Run, or change the kind of an already-saved Run. */
  saveRun(kind: RunKind, plannedRunId?: string): Promise<SaveResult | null>
  plannedRuns(): Promise<PlannedRunChoice[]>
  setKind(kind: RunKind): Promise<SaveResult | null>
  finaliseRun(): Promise<void>
  currentKind(): RunKind
  runGate(): { gatePassed: boolean; lastSlideReached: boolean; wallMs: number; forwardAdvances: number; saved: boolean; audioArmed: boolean }
  onRunOffer(cb: () => void): void
  onCloseOffer(cb: () => void): void
  closeWindow(): Promise<void>
}

// ── Context from main ────────────────────────────────────────────────────────

async function loadContext(): Promise<RecContext> {
  try {
    const c = await ipcRenderer.invoke('recording:context')
    return {
      talkSlug: c?.talkSlug ?? 'talk',
      talkTitle: c?.talkTitle ?? c?.talkSlug ?? 'talk',
      timerTargetMin: typeof c?.timerTargetMin === 'number' ? c.timerTargetMin : 0,
      pathwayId: typeof c?.pathwayId === 'string' ? c.pathwayId : null,
      preferredPlannedRunId: typeof c?.preferredPlannedRunId === 'string' ? c.preferredPlannedRunId : null,
      discardThresholdMs: typeof c?.discardThresholdMs === 'number' ? c.discardThresholdMs : 20000,
      testMode: !!c?.testMode
    }
  } catch {
    // Handler not registered (older main / non-recording present) — degrade to inert defaults.
    return { talkSlug: 'talk', talkTitle: 'talk', timerTargetMin: 0, pathwayId: null, preferredPlannedRunId: null, discardThresholdMs: 20000, testMode: false }
  }
}

// ── Audio stream ─────────────────────────────────────────────────────────────

function hashSlideId(): string {
  return location.hash.startsWith('#') ? decodeURIComponent(location.hash.slice(1)) : ''
}

function normaliseKind(value: unknown): RunKind {
  return value === 'rehearsal' || value === 'recording' ? value : 'delivery'
}

function kindLabel(kind: RunKind): string {
  return kind === 'delivery' ? 'Delivery' : kind === 'rehearsal' ? 'Rehearsal' : 'Recording'
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function pickMimeType(): string | undefined {
  // Prefer explicit opus; fall back to bare webm. undefined lets MediaRecorder choose.
  const prefs = ['audio/webm;codecs=opus', 'audio/webm']
  for (const m of prefs) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

// A deterministic, mic-free stream for the e2e harness: a 440Hz tone routed into a
// MediaStream. Produces a real, non-empty webm so the whole capture→save→upload path is
// tested without hardware or an OS permission prompt.
function syntheticStream(): MediaStream {
  const Ctor: typeof AudioContext =
    (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ac = new Ctor()
  void ac.resume?.() // ensure the context runs so the tone actually produces samples (headless)
  const osc = ac.createOscillator()
  const dest = ac.createMediaStreamDestination()
  osc.frequency.value = 440
  osc.connect(dest)
  osc.start()
  return dest.stream
}

// ── Controller ───────────────────────────────────────────────────────────────

export function createRecorderController(ctx: RecContext): RecorderController {
  let state: RecState = 'idle'
  const rawMarks: RawMark[] = []
  let chunks: Blob[] = []
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let mime: string | undefined
  let startedAtIso = ''

  // Timing on the raw clock (performance.now). Marks use rawNow(); the visible clock is
  // pause-aware and freezes while paused (pauseStartRaw), so it matches the audio length.
  let t0 = 0
  let pausedAccum = 0
  let pauseStartRaw: number | null = null
  let frozenDisplayMs: number | null = null

  let lastHash = hashSlideId()
  let lastReveal = 0 // fragments hidden on the current slide (reveal build state)
  let lastHl = 0 // live highlight marks on the current slide
  let saveResult: SaveResult | null = null
  let pendingBlob: Blob | null = null // a stopped recording awaiting save (or a Keep/Discard choice)
  let savedRunSessionId: string | null = null
  let savedRunKind: RunKind = 'delivery'
  let savedRunCanFinalise = false
  let toastDismissed = false
  let finaliseTimer: number | null = null

  // Always-on Run capture. This is wall-clock and local-only until L / save-offer commits it.
  const runMarks: RawMark[] = []
  let runStartedAtIso = new Date().toISOString()
  let runT0 = performance.now()
  let runLastHash = hashSlideId()
  let runLastSlideIndex = -1
  let runForwardAdvances = 0
  let runLastSlideReached = false
  let runLastReveal = 0
  let runLastHl = 0

  const changeCbs: Array<(s: RecState) => void> = []
  const pausedMoveCbs: Array<() => void> = []
  const errorCbs: Array<(m: string) => void> = []
  const runOfferCbs: Array<() => void> = []
  const closeOfferCbs: Array<() => void> = []

  const emitChange = (): void => { for (const cb of changeCbs) cb(state) }
  const emitPausedMove = (): void => { for (const cb of pausedMoveCbs) cb() }
  const emitError = (m: string): void => { for (const cb of errorCbs) cb(m) }
  const emitRunOffer = (): void => { for (const cb of runOfferCbs) cb() }
  const emitCloseOffer = (): void => { for (const cb of closeOfferCbs) cb() }

  const rawNow = (): number => (t0 ? performance.now() - t0 : 0)
  const runNow = (): number => Math.max(0, performance.now() - runT0)

  function displayMs(): number {
    if (frozenDisplayMs !== null) return frozenDisplayMs
    if (state === 'idle') return 0
    const openPause = pauseStartRaw !== null ? rawNow() - pauseStartRaw : 0
    return Math.max(0, rawNow() - pausedAccum - openPause)
  }

  const activeSlide = (): Element | null => document.querySelector('.slide.active')
  const allSlides = (): Element[] => Array.from(document.querySelectorAll('.slide'))
  const hiddenCount = (el: Element | null): number => (el ? el.querySelectorAll('.hidden-fragment').length : 0)
  const markCount = (el: Element | null): number => (el ? el.querySelectorAll('mark.hl-mark').length : 0)
  const HIGHLIGHT_BLOCK_SELECTOR = 'h1,h2,h3,h4,p,li,blockquote,figcaption,.statement,.fl-text,.card-comment,th,td,.tl-text,.smartart-node > .smartart-label'
  const activeSlideIndex = (): number => {
    const active = activeSlide()
    if (!active) return -1
    return allSlides().indexOf(active)
  }
  const isAudioArmed = (): boolean => state === 'recording' || state === 'paused' || state === 'confirm' || (state === 'saving' && !!pendingBlob)
  const gatePassed = (): boolean => runLastSlideReached || (runNow() >= 5 * 60_000 && runForwardAdvances >= 5)

  function highlightableBlocks(slide: Element | null): Element[] {
    if (!slide) return []
    return Array.from(slide.querySelectorAll(HIGHLIGHT_BLOCK_SELECTOR))
      .filter((el) => !el.closest('aside.notes'))
  }

  function blockTextNodes(block: Element): Text[] {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null)
    const nodes: Text[] = []
    let node: Node | null
    while ((node = walker.nextNode())) nodes.push(node as Text)
    return nodes
  }

  function charOffsetOf(block: Element, node: Node, offset: number): number {
    let acc = 0
    const nodes = blockTextNodes(block)
    for (const tn of nodes) {
      if (tn === node) return acc + offset
      acc += tn.nodeValue?.length ?? 0
    }
    const pre = document.createRange()
    pre.selectNodeContents(block)
    try { pre.setEnd(node, offset) } catch { return acc }
    return pre.toString().length
  }

  function serializeHighlightMark(slide: Element, mark: Element): HighlightRange | null {
    const blocks = highlightableBlocks(slide)
    const block = mark.closest(HIGHLIGHT_BLOCK_SELECTOR)
    if (!block) return null
    const blockIndex = blocks.indexOf(block)
    if (blockIndex < 0) return null
    const markedTextNodes = blockTextNodes(mark)
    if (markedTextNodes.length === 0) return null
    const first = markedTextNodes[0]
    const last = markedTextNodes[markedTextNodes.length - 1]
    let start = charOffsetOf(block, first, 0)
    let end = charOffsetOf(block, last, last.nodeValue?.length ?? 0)
    if (end < start) [start, end] = [end, start]
    if (end <= start) return null
    return { block: blockIndex, start, end }
  }

  function currentHighlightRanges(slide: Element | null): HighlightRange[] | undefined {
    try {
      if (!slide) return undefined
      const marks = Array.from(slide.querySelectorAll('mark.hl-mark'))
      const ranges: HighlightRange[] = []
      for (const mark of marks) {
        const range = serializeHighlightMark(slide, mark)
        if (!range) return undefined
        ranges.push(range)
      }
      return ranges
    } catch {
      return undefined
    }
  }

  function highlightMark(slideId: string, marks: number, tMs: number, ranges: HighlightRange[] | undefined): RawMark {
    const mark: RawMark = { event: 'highlight', slideId, marks, tMs }
    if (ranges) mark.ranges = ranges
    return mark
  }

  function pushRunState(): void {
    void ipcRenderer.invoke('recording:run-state', {
      talkSlug: ctx.talkSlug,
      sessionId: savedRunSessionId ?? undefined,
      saved: !!savedRunSessionId,
      gatePassed: gatePassed(),
      audioArmed: isAudioArmed(),
      lastSlideReached: runLastSlideReached,
      wallMs: runNow(),
      forwardAdvances: runForwardAdvances
    }).catch(() => {})
  }

  function scheduleFinalise(): void {
    if (!savedRunSessionId || !savedRunCanFinalise || isAudioArmed()) return
    if (finaliseTimer !== null) window.clearTimeout(finaliseTimer)
    finaliseTimer = window.setTimeout(() => { void finaliseRun() }, 250)
  }

  function noteRunOfferBoundary(): void {
    pushRunState()
    if (!savedRunSessionId && !isAudioArmed() && gatePassed() && !toastDismissed) {
      toastDismissed = true
      emitRunOffer()
    }
  }

  function initialiseRunCapture(): void {
    runMarks.length = 0
    runStartedAtIso = new Date().toISOString()
    runT0 = performance.now()
    runLastHash = hashSlideId()
    const active = activeSlide()
    runLastSlideIndex = activeSlideIndex()
    runForwardAdvances = 0
    runLastSlideReached = runLastSlideIndex >= 0 && runLastSlideIndex === allSlides().length - 1
    runLastReveal = hiddenCount(active)
    runLastHl = markCount(active)
    runMarks.push({ event: 'enter', slideId: runLastHash, tMs: 0 })
    pushRunState()
  }

  async function getStream(): Promise<MediaStream> {
    if (ctx.testMode) return syntheticStream()
    // Lazy — the mic is only opened on the first Record, so opening the presenter never
    // prompts. Permission is granted for THIS window by main (setupRecordingPermissions).
    return navigator.mediaDevices.getUserMedia({ audio: true })
  }

  async function start(): Promise<void> {
    // Allowed from idle and from the terminal states of a previous run (saved/error) so
    // ⇧R can begin a fresh recording without reloading the presenter. Not while a run is live
    // or waiting on a Keep/Discard choice.
    if (state === 'recording' || state === 'paused' || state === 'saving' || state === 'confirm') return
    frozenDisplayMs = null
    saveResult = null
    savedRunSessionId = null
    savedRunKind = 'delivery'
    savedRunCanFinalise = false
    runMarks.length = 0
    try {
      stream = await getStream()
    } catch (e) {
      state = 'error'
      emitError('Microphone unavailable — enable mic access for TalkWeaver to record. Presenting is unaffected.')
      emitChange()
      // Reset to idle so a later attempt (after granting) can retry without reload.
      state = 'idle'
      return
    }
    mime = pickMimeType()
    chunks = []
    rawMarks.length = 0
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    } catch (e) {
      state = 'error'
      emitError('Recording could not start on this machine (codec unsupported). Presenting is unaffected.')
      emitChange()
      stopTracks()
      state = 'idle'
      return
    }
    recorder.ondataavailable = (ev: BlobEvent): void => { if (ev.data && ev.data.size > 0) chunks.push(ev.data) }
    // A 1s timeslice keeps chunks flowing rather than one blob at the end. (Incremental
    // streaming of chunks to disk mid-talk is a Phase-2 hardening; Phase 1 buffers then
    // writes locally on stop, before any network — main, Task 5.)
    recorder.start(1000)
    t0 = performance.now()
    pausedAccum = 0
    pauseStartRaw = null
    frozenDisplayMs = null
    startedAtIso = new Date().toISOString()
    // First mark: the slide we start on, at the recording origin. Baseline its reveal/highlight
    // state so an in-progress build isn't misread as a step the moment recording begins.
    lastHash = hashSlideId()
    const activeAtStart = document.querySelector('.slide.active')
    lastReveal = activeAtStart ? activeAtStart.querySelectorAll('.hidden-fragment').length : 0
    lastHl = activeAtStart ? activeAtStart.querySelectorAll('mark.hl-mark').length : 0
    rawMarks.push({ event: 'enter', slideId: lastHash, tMs: 0 })
    state = 'recording'
    pushRunState()
    emitChange()
  }

  function pause(): void {
    if (state !== 'recording' || !recorder) return
    try { recorder.pause() } catch { /* already paused / unsupported — state still freezes the clock */ }
    rawMarks.push({ event: 'pause', tMs: rawNow() })
    pauseStartRaw = rawNow()
    state = 'paused'
    emitChange()
  }

  function resume(): void {
    if (state !== 'paused' || !recorder) return
    try { recorder.resume() } catch { /* ignore */ }
    const now = rawNow()
    rawMarks.push({ event: 'resume', tMs: now })
    if (pauseStartRaw !== null) { pausedAccum += now - pauseStartRaw; pauseStartRaw = null }
    state = 'recording'
    emitChange()
  }

  function stopTracks(): void {
    try { stream?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    stream = null
  }

  async function stop(): Promise<SaveResult | null> {
    if (state !== 'recording' && state !== 'paused') return null
    if (!recorder) return null
    // Close any open pause into the accumulator so displayMs freezes at the true length.
    if (pauseStartRaw !== null) { pausedAccum += rawNow() - pauseStartRaw; pauseStartRaw = null }
    rawMarks.push({ event: 'stop', tMs: rawNow() })
    frozenDisplayMs = Math.max(0, rawNow() - pausedAccum)

    const rec = recorder
    const finished = new Promise<Blob>((resolve) => {
      rec.onstop = (): void => resolve(new Blob(chunks, { type: mime ?? 'audio/webm' }))
    })
    try { rec.stop() } catch { /* onstop may still fire; guarded by the race below */ }
    // Guard against a recorder that never fires onstop — resolve from whatever we have.
    pendingBlob = await Promise.race([
      finished,
      new Promise<Blob>((resolve) => setTimeout(() => resolve(new Blob(chunks, { type: mime ?? 'audio/webm' })), 4000))
    ])
    stopTracks()
    pushRunState()

    // A short recording is NEVER silently dropped — ask Keep/Discard first. At/above the
    // threshold it saves straight away (frozenDisplayMs is the pause-aware length).
    if (frozenDisplayMs < ctx.discardThresholdMs) {
      state = 'confirm'
      emitChange()
      return null
    }
    return doSave(false)
  }

  // Persist the pending recording. `force` skips main's own discard check (a kept short run).
  async function doSave(force: boolean): Promise<SaveResult | null> {
    if (!pendingBlob) return null
    state = 'saving'
    pushRunState()
    emitChange()
    let result: SaveResult
    try {
      const payload: Record<string, unknown> = {
        talkSlug: ctx.talkSlug,
        talkTitle: ctx.talkTitle,
        startedAt: startedAtIso,
        rawMarks: rawMarks.slice(),
        timerTargetMin: ctx.timerTargetMin,
        pathwayId: ctx.pathwayId,
        wallClockMs: frozenDisplayMs ?? displayMs(),
        mode: 'recording',
        kind: 'delivery',
        force
      }
      payload.audio = await pendingBlob.arrayBuffer()
      payload.mimeType = mime ?? 'audio/webm'
      const res = (await ipcRenderer.invoke('recording:save', payload)) as SaveResult
      result = res ?? { ok: false, error: 'no-response' }
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
    pendingBlob = null
    saveResult = result
    if (result.ok && !result.discarded && result.sessionId) {
      savedRunSessionId = result.sessionId
      savedRunKind = normaliseKind(result.kind)
      savedRunCanFinalise = false
    }
    if (!result.ok) {
      state = 'error'
      emitError('Recording could not be saved. It stayed on this machine — check disk space.')
    } else {
      state = 'saved'
    }
    pushRunState()
    emitChange()
    return result
  }

  // Resolve a Keep/Discard on a short recording. Keep forces the save; Discard drops it.
  async function confirmSave(keep: boolean): Promise<SaveResult | null> {
    if (state !== 'confirm') return null
    if (keep) return doSave(true)
    pendingBlob = null
    saveResult = { ok: true, discarded: true }
    state = 'idle'
    frozenDisplayMs = null
    initialiseRunCapture()
    emitChange()
    return saveResult
  }

  async function saveRun(kind: RunKind, plannedRunId?: string): Promise<SaveResult | null> {
    if (isAudioArmed()) return null
    if (savedRunSessionId) return setKind(kind)
    state = 'saving'
    pushRunState()
    emitChange()
    let result: SaveResult
    try {
      const res = (await ipcRenderer.invoke('recording:save', {
        talkSlug: ctx.talkSlug,
        talkTitle: ctx.talkTitle,
        startedAt: runStartedAtIso,
        rawMarks: runMarks.slice(),
        timerTargetMin: ctx.timerTargetMin,
        pathwayId: ctx.pathwayId,
        wallClockMs: runNow(),
        mode: 'run',
        kind,
        plannedRunId,
        force: true
      })) as SaveResult
      result = res ?? { ok: false, error: 'no-response' }
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
    saveResult = result
    if (!result.ok) {
      state = 'error'
      emitError('Run could not be saved to History. Check disk space and try again.')
    } else if (!result.discarded && result.sessionId) {
      savedRunSessionId = result.sessionId
      savedRunKind = normaliseKind(result.kind ?? kind)
      savedRunCanFinalise = true
      state = 'saved'
      scheduleFinalise()
    } else {
      state = 'idle'
    }
    pushRunState()
    emitChange()
    return result
  }

  async function setKind(kind: RunKind): Promise<SaveResult | null> {
    if (!savedRunSessionId) return saveRun(kind)
    await finaliseRun()
    let result: SaveResult
    try {
      const res = (await ipcRenderer.invoke('recording:set-kind', {
        talkSlug: ctx.talkSlug,
        sessionId: savedRunSessionId,
        kind
      })) as SaveResult
      result = res ?? { ok: false, error: 'no-response' }
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
    saveResult = result.ok ? { ok: true, sessionId: savedRunSessionId, kind } : result
    if (result.ok) {
      savedRunKind = kind
      state = 'saved'
    } else {
      emitError('Run kind could not be changed. It is still saved.')
    }
    pushRunState()
    emitChange()
    return saveResult
  }

  async function finaliseRun(): Promise<void> {
    if (!savedRunSessionId || !savedRunCanFinalise || isAudioArmed()) return
    if (finaliseTimer !== null) {
      window.clearTimeout(finaliseTimer)
      finaliseTimer = null
    }
    try {
      await ipcRenderer.invoke('recording:finalise-run', {
        talkSlug: ctx.talkSlug,
        sessionId: savedRunSessionId,
        rawMarks: runMarks.slice(),
        endedAt: new Date().toISOString(),
        wallClockMs: runNow()
      })
    } catch {
      /* best-effort; the next mark/tick will retry */
    }
  }

  // Capture — poll the shared DOM (see file header for why not `hashchange`). Beyond slide
  // changes we watch the ACTIVE slide for in-slide animation: reveal build steps show/hide
  // `.hidden-fragment` items, and live highlights wrap text in `<mark.hl-mark>`. Both are real
  // DOM changes the runtime makes (no template edit), so replay can reproduce what was on screen.
  function checkState(): void {
    const now = hashSlideId()
    const active = activeSlide()
    const idx = activeSlideIndex()
    const slides = allSlides()
    const lastReachedNow = idx >= 0 && idx === slides.length - 1
    if (now !== lastHash) {
      lastHash = now
      // New slide — re-baseline reveal/highlight so entering never emits a spurious build step.
      lastReveal = hiddenCount(active)
      lastHl = markCount(active)
      if (state === 'recording') {
        rawMarks.push({ event: 'enter', slideId: now, tMs: rawNow() })
        emitChange()
      } else if (state === 'paused') {
        emitPausedMove()
      }
    }
    if (now !== runLastHash) {
      if (idx === runLastSlideIndex + 1) runForwardAdvances += 1
      runLastHash = now
      runLastSlideIndex = idx
      runLastReveal = hiddenCount(active)
      runLastHl = markCount(active)
      if (!isAudioArmed()) {
        runMarks.push({ event: 'enter', slideId: now, tMs: runNow() })
        scheduleFinalise()
      }
    }
    if (lastReachedNow && !runLastSlideReached) {
      runLastSlideReached = true
      noteRunOfferBoundary()
    }
    if (!active) {
      pushRunState()
      return
    }
    const hidden = hiddenCount(active)
    if (hidden !== lastReveal) {
      lastReveal = hidden
      if (state === 'recording') rawMarks.push({ event: 'reveal', slideId: now, hidden, tMs: rawNow() })
    }
    const marks = markCount(active)
    if (marks !== lastHl) {
      lastHl = marks
      if (state === 'recording') rawMarks.push(highlightMark(now, marks, rawNow(), currentHighlightRanges(active)))
    }
    const runHidden = hiddenCount(active)
    if (!isAudioArmed() && runHidden !== runLastReveal) {
      runLastReveal = runHidden
      runMarks.push({ event: 'reveal', slideId: now, hidden: runHidden, tMs: runNow() })
      scheduleFinalise()
    }
    const runMarksCount = markCount(active)
    if (!isAudioArmed() && runMarksCount !== runLastHl) {
      runLastHl = runMarksCount
      runMarks.push(highlightMark(now, runMarksCount, runNow(), currentHighlightRanges(active)))
      scheduleFinalise()
    }
    if (gatePassed()) noteRunOfferBoundary()
  }
  const pollId = setInterval(checkState, 150)
  window.addEventListener('hashchange', checkState) // belt-and-braces for external hash changes
  const stateTickId = setInterval(() => {
    pushRunState()
    scheduleFinalise()
  }, 2000)
  window.addEventListener('beforeunload', () => {
    clearInterval(pollId)
    clearInterval(stateTickId)
    void finaliseRun()
  })
  ipcRenderer.on('recording:show-close-offer', () => emitCloseOffer())
  initialiseRunCapture()

  return {
    getState: () => state,
    displayMs,
    currentSlideId: () => lastHash,
    start,
    pause,
    resume,
    stop,
    confirmSave,
    onChange: (cb) => { changeCbs.push(cb) },
    onSlideMovedWhilePaused: (cb) => { pausedMoveCbs.push(cb) },
    onError: (cb) => { errorCbs.push(cb) },
    lastSave: () => saveResult,
    saveRun,
    plannedRuns: async () => {
      try {
        const rows = await ipcRenderer.invoke('recording:planned-runs', ctx.talkSlug, ctx.pathwayId)
        return Array.isArray(rows) ? rows as PlannedRunChoice[] : []
      } catch { return [] }
    },
    setKind,
    finaliseRun,
    currentKind: () => savedRunKind,
    runGate: () => ({
      gatePassed: gatePassed(),
      lastSlideReached: runLastSlideReached,
      wallMs: runNow(),
      forwardAdvances: runForwardAdvances,
      saved: !!savedRunSessionId,
      audioArmed: isAudioArmed()
    }),
    onRunOffer: (cb) => { runOfferCbs.push(cb) },
    onCloseOffer: (cb) => { closeOfferCbs.push(cb) },
    closeWindow: async () => { await ipcRenderer.invoke('recording:close-window') }
  }
}

// ── REC control (injected into the real dark presenter, per locked mockup) ─────
// Built to docs/design/2026-07-05-recording/direction-4-presenter-rec.html. Chrome +
// colours mirror presenter-popup-single-html.html; the REC module borrows Light Table
// amber. Nothing existing is removed — the pacing clock-bar is reparented into a cluster
// so the two clocks sit side-by-side exactly as the mockup shows, but keeps every id,
// listener and behaviour (it is the same node, moved, not rebuilt).

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

const REC_CSS = `
  #twrec-module, .twrec-toast { --lt-amber:#a3630e; --lt-amber-bright:#d98a2b; --lt-red-live:#ec5b56;
    --twrec-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,monospace;
    --twrec-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  /* The controls set display:inline-flex, which outranks the UA [hidden]{display:none} rule —
     so state-hidden buttons need this explicit !important, or every control shows at once. */
  #twrec-module [hidden], .twrec-toast [hidden] { display: none !important; }
  .tw-center-cluster { display:flex; align-items:center; gap:12px; flex:0 0 auto; }
  .tw-center-cluster .cluster-divider { width:1px; height:30px; background:#ffffff1f; flex:none; }
  #twrec-module { display:inline-flex; align-items:center; gap:10px; padding:5px 6px 5px 11px;
    border-radius:9px; background:#14202b; border:1px solid #ffffff1f;
    transition:border-color .2s ease, background .2s ease, box-shadow .2s ease; }
  #twrec-module[data-rec="idle"] { border-color:#4a4234; }
  #twrec-module[data-rec="recording"] { border-color:#7d3b37; background:#241417;
    box-shadow:0 0 0 1px #ec5b5622, 0 6px 20px rgba(236,91,86,0.14); }
  #twrec-module[data-rec="paused"] { border-color:#7a5a22; background:#241f14; }
  #twrec-module[data-rec="saving"], #twrec-module[data-rec="saved"] { border-color:#2f5a8a; background:#12212f; }
  #twrec-module[data-rec="error"] { border-color:#7d3b37; background:#241417; }
  .rec-dot { width:12px; height:12px; border-radius:50%; flex:none; background:#6f6753; }
  #twrec-module[data-rec="recording"] .rec-dot { background:var(--lt-red-live);
    box-shadow:0 0 0 0 #ec5b5688; animation:twrec-pulse 1.15s ease-out infinite; }
  #twrec-module[data-rec="paused"] .rec-dot { background:var(--lt-amber-bright); }
  #twrec-module[data-rec="saving"] .rec-dot, #twrec-module[data-rec="saved"] .rec-dot { background:#2f6db5; }
  @keyframes twrec-pulse { 0%{box-shadow:0 0 0 0 rgba(236,91,86,0.55);} 70%{box-shadow:0 0 0 7px rgba(236,91,86,0);} 100%{box-shadow:0 0 0 0 rgba(236,91,86,0);} }
  .rec-label { font-family:var(--twrec-sans); font-size:0.64rem; font-weight:800; letter-spacing:0.16em;
    text-transform:uppercase; color:#b0a184; }
  #twrec-module[data-rec="recording"] .rec-label { color:#f0a9a5; }
  #twrec-module[data-rec="paused"] .rec-label { color:var(--lt-amber-bright); }
  .rec-clock { font-family:var(--twrec-mono); font-variant-numeric:tabular-nums; font-weight:600;
    font-size:1.02rem; letter-spacing:0.01em; color:#dfe7ef; min-width:4.4ch; text-align:right; }
  #twrec-module[data-rec="idle"] .rec-clock { color:#8b93a0; }
  #twrec-module[data-rec="paused"] .rec-clock { color:#e6c88a; }
  .rec-frozen-tag { font-family:var(--twrec-sans); font-size:0.6rem; font-weight:800; letter-spacing:0.1em;
    text-transform:uppercase; color:#241f14; background:var(--lt-amber-bright); border-radius:4px; padding:2px 5px; }
  .rec-saved-msg { font-family:var(--twrec-sans); font-size:0.82rem; font-weight:600; color:#bcd6f2;
    letter-spacing:0.01em; padding-right:2px; }
  .rec-btn { display:inline-flex; align-items:center; gap:6px; background:#26333f; border:1px solid #ffffff26;
    color:#eef3f9; border-radius:6px; padding:5px 9px; font-size:0.76rem; font-weight:600; white-space:nowrap; }
  .rec-btn:hover { border-color:#6ea8e6; background:#2c3b49; }
  .rec-btn.amber { background:#3a2c12; border-color:#7a5a22; color:#f0d5a0; }
  .rec-btn.amber:hover { border-color:var(--lt-amber-bright); background:#46340f; }
  .rec-btn.start { background:#2a1618; border-color:#7d3b37; color:#f4b9b5; }
  .rec-btn.start:hover { border-color:var(--lt-red-live); background:#331a1c; }
  .rec-btn.keep { background:#12261a; border-color:#2f6b45; color:#a8e0bf; }
  .rec-btn.keep:hover { border-color:#3fa066; background:#173224; }
  .rec-btn.ghost { background:#17212b; border-color:#ffffff20; color:#d9e3ed; }
  .rec-btn.ghost:hover { border-color:#6ea8e6; background:#1d2b38; }
  .rec-confirm-msg { font-family:var(--twrec-sans); font-size:0.82rem; font-weight:600; color:#e6c88a;
    letter-spacing:0.01em; padding-right:2px; }
  #twrec-module .kbd { font-family:var(--twrec-mono); font-size:0.62rem; line-height:1; font-weight:600;
    padding:3px 5px; border-radius:4px; background:#0f1620; border:1px solid #ffffff26; border-bottom-width:2px;
    color:#9fb1c4; white-space:nowrap; margin-left:1px; }
  .rec-spinner { width:13px; height:13px; border-radius:50%; flex:none; border:2px solid #2f6db555;
    border-top-color:#6ea8e6; animation:twrec-spin 0.8s linear infinite; }
  @keyframes twrec-spin { to { transform:rotate(360deg); } }
  .twrec-toast { position:fixed; top:86px; right:26px; z-index:120; display:flex; align-items:center; gap:12px;
    background:#241f14ee; border:1px solid #7a5a22; border-left:3px solid var(--lt-amber-bright); border-radius:10px;
    padding:11px 12px 11px 14px; box-shadow:0 14px 40px rgba(0,0,0,0.5); backdrop-filter:blur(3px); max-width:340px;
    transform:translateY(-8px); opacity:0; pointer-events:none; transition:opacity .22s ease, transform .22s ease; }
  .twrec-toast.show { transform:translateY(0); opacity:1; pointer-events:auto; }
  .twrec-toast .rt-dot { width:10px; height:10px; border-radius:50%; background:var(--lt-amber-bright); flex:none; }
  .twrec-toast .rt-text { font-family:var(--twrec-sans); font-size:0.86rem; line-height:1.3; color:#f1e6cf; }
  .twrec-toast .rt-text b { font-weight:700; color:#fff; }
  .twrec-toast .rt-dismiss { background:none; border:0; color:#b6a789; font-size:1rem; line-height:1; padding:2px 4px; cursor:pointer; }
  .twrec-toast .rt-dismiss:hover { color:#fff; }
  .twrec-toast .kbd { font-family:var(--twrec-mono); font-size:0.62rem; font-weight:600; padding:3px 5px; border-radius:4px;
    background:#0f1620; border:1px solid #ffffff26; border-bottom-width:2px; color:#9fb1c4; margin-left:4px; }
  .twrec-error { position:fixed; left:50%; bottom:96px; transform:translateX(-50%); background:#2a1618;
    border:1px solid #7d3b37; color:#f4b9b5; padding:9px 16px; border-radius:9px; font-size:0.86rem; z-index:210;
    box-shadow:0 12px 34px rgba(0,0,0,.5); font-family:var(--twrec-sans); max-width:60ch; }
  .twrec-picker, .twrec-close-modal { position:fixed; inset:0; z-index:230; display:flex; align-items:center; justify-content:center;
    background:rgba(6,10,15,0.54); backdrop-filter:blur(4px); font-family:var(--twrec-sans); }
  .twrec-picker-panel, .twrec-close-panel { min-width:min(440px, calc(100vw - 44px)); max-width:520px; border-radius:12px;
    background:#111a24; border:1px solid #ffffff24; box-shadow:0 24px 80px rgba(0,0,0,.58); padding:16px; color:#eef3f9; }
  .twrec-picker-title, .twrec-close-title { font-size:0.95rem; font-weight:800; letter-spacing:0.01em; margin-bottom:4px; }
  .twrec-picker-sub, .twrec-close-sub { color:#aab8c6; font-size:0.82rem; line-height:1.35; margin-bottom:13px; }
  .twrec-kind-row, .twrec-close-row { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
  .twrec-kind { border:1px solid #ffffff24; background:#1a2632; color:#eef3f9; border-radius:7px; padding:8px 11px;
    font-size:0.82rem; font-weight:750; }
  .twrec-kind.active { border-color:#d98a2b; background:#3a2c12; color:#f0d5a0; box-shadow:0 0 0 1px #d98a2b33; }
  .twrec-planned-list { display:grid; gap:7px; margin:0 0 13px; max-height:230px; overflow:auto; }
  .twrec-planned { display:flex; align-items:baseline; justify-content:space-between; gap:18px; text-align:left;
    border:1px solid #ffffff24; background:#1a2632; color:#eef3f9; border-radius:8px; padding:9px 11px; }
  .twrec-planned:hover, .twrec-planned:focus, .twrec-planned.active { border-color:#d98a2b; background:#3a2c12; outline:none; }
  .twrec-planned b { font-size:.84rem; }
  .twrec-planned span { color:#aab8c6; font-size:.75rem; }
  .twrec-close-panel .danger { color:#ffd6d2; border-color:#7d3b37; background:#2a1618; }
  .tw-shortcuts-section.twrec-sheet-section { color:#d98a2b; }
`

function mountRecUi(controller: RecorderController): void {
  // 1) Styles — once.
  if (!document.getElementById('twrec-styles')) {
    const style = document.createElement('style')
    style.id = 'twrec-styles'
    style.textContent = REC_CSS
    document.head.appendChild(style)
  }

  // 2) The REC module — inserted beside the pacing clock inside a center cluster.
  const module = document.createElement('div')
  module.id = 'twrec-module'
  module.dataset.rec = 'idle'
  module.setAttribute('role', 'group')
  module.setAttribute('aria-label', 'Recording')
  module.innerHTML = `
    <span class="rec-dot" aria-hidden="true"></span>
    <span class="rec-label" id="twrec-label">REC</span>
    <span class="rec-clock" id="twrec-clock">00:00</span>
    <span class="rec-frozen-tag" id="twrec-frozen" hidden>Paused</span>
    <span class="rec-saved-msg" id="twrec-saved" hidden>Saved</span>
    <span class="rec-confirm-msg" id="twrec-confirm-msg" hidden>Short recording &mdash; keep it?</span>
    <button type="button" class="rec-btn start" id="twrec-primary" aria-label="Start recording (Shift R)" title="Start recording (⇧R)">Record<span class="kbd">⇧R</span></button>
    <button type="button" class="rec-btn ghost" id="twrec-change-kind" aria-label="Change run kind" title="Change run kind" hidden>change</button>
    <button type="button" class="rec-btn amber" id="twrec-pause" aria-label="Pause recording (Shift P)" title="Pause recording (⇧P)" hidden>&#10073;&#10073; Pause<span class="kbd">⇧P</span></button>
    <button type="button" class="rec-btn amber" id="twrec-resume" aria-label="Resume recording (Shift P)" title="Resume recording (⇧P)" hidden>&#9654; Resume<span class="kbd">⇧P</span></button>
    <button type="button" class="rec-btn" id="twrec-stop" aria-label="Stop and save (Shift R)" title="Stop &amp; save (⇧R)" hidden>&#9209; Stop</button>
    <button type="button" class="rec-btn keep" id="twrec-keep" aria-label="Keep this recording" title="Keep this recording" hidden>Keep</button>
    <button type="button" class="rec-btn" id="twrec-discard" aria-label="Discard this recording" title="Discard this recording" hidden>Discard</button>
    <span class="rec-spinner" id="twrec-spinner" hidden></span>`

  const clockBar = document.querySelector<HTMLElement>('#presenterRoot header .tw-clock-bar')
  const divider = document.createElement('span')
  divider.className = 'cluster-divider'
  divider.setAttribute('aria-hidden', 'true')
  if (clockBar && clockBar.parentElement) {
    // Reparent the existing clock-bar into a cluster so the two clocks group tightly,
    // exactly as the mockup shows. Same node moved — every id/listener stays live.
    const cluster = document.createElement('div')
    cluster.className = 'tw-center-cluster'
    clockBar.parentElement.insertBefore(cluster, clockBar)
    cluster.appendChild(clockBar)
    cluster.appendChild(divider)
    cluster.appendChild(module)
  } else {
    // Fallback: no clock-bar found — pin the module top-centre so recording still works.
    module.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:150;'
    document.body.appendChild(module)
  }

  // 3) The non-blocking resume toast — fixed to the viewport corner (never dims the talk).
  const toast = document.createElement('div')
  toast.className = 'twrec-toast'
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  toast.innerHTML = `
    <span class="rt-dot" aria-hidden="true"></span>
    <span class="rt-text"><b>Recording is paused</b> — resume?</span>
    <button type="button" class="rec-btn amber" id="twrec-toast-yes" aria-label="Resume recording">&#9654; Resume<span class="kbd">⇧P</span></button>
    <button type="button" class="rt-dismiss" id="twrec-toast-no" aria-label="Stay paused" title="Stay paused">&times;</button>`
  document.body.appendChild(toast)

  const saveToast = document.createElement('div')
  saveToast.className = 'twrec-toast'
  saveToast.setAttribute('role', 'status')
  saveToast.setAttribute('aria-live', 'polite')
  saveToast.innerHTML = `
    <span class="rt-dot" aria-hidden="true"></span>
    <span class="rt-text"><b>Save this run to History?</b></span>
    <button type="button" class="rec-btn keep" id="twrec-save-delivery" aria-label="Save this run as a delivery">Save<span class="kbd">Enter</span></button>
    <button type="button" class="rec-btn ghost" id="twrec-save-as" aria-label="Choose run kind">as…</button>
    <button type="button" class="rt-dismiss" id="twrec-save-dismiss" aria-label="Dismiss save offer" title="Dismiss">&times;</button>`
  document.body.appendChild(saveToast)

  // Refs
  const $ = (id: string): HTMLElement | null => document.getElementById(id)
  const label = $('twrec-label'), clock = $('twrec-clock'), frozen = $('twrec-frozen')
  const savedMsg = $('twrec-saved'), spinner = $('twrec-spinner'), confirmMsg = $('twrec-confirm-msg')
  const primary = $('twrec-primary'), btnChangeKind = $('twrec-change-kind'), btnPause = $('twrec-pause'), btnResume = $('twrec-resume'), btnStop = $('twrec-stop')
  const btnKeep = $('twrec-keep'), btnDiscard = $('twrec-discard')

  const showToast = (): void => toast.classList.add('show')
  const hideToast = (): void => toast.classList.remove('show')
  const showSaveToast = (): void => saveToast.classList.add('show')
  const hideSaveToast = (): void => saveToast.classList.remove('show')

  function chooseKind(initial: RunKind = 'delivery'): Promise<RunKind | null> {
    return new Promise((resolve) => {
      let selected = initial
      const overlay = document.createElement('div')
      overlay.className = 'twrec-picker'
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.innerHTML = `
        <div class="twrec-picker-panel">
          <div class="twrec-picker-title">Save run to History</div>
          <div class="twrec-picker-sub">Choose how this run should appear in History.</div>
          <div class="twrec-kind-row">
            <button type="button" class="twrec-kind" data-kind="delivery">Delivery</button>
            <button type="button" class="twrec-kind" data-kind="rehearsal">Rehearsal</button>
            <button type="button" class="twrec-kind" data-kind="recording">Recording</button>
          </div>
        </div>`
      const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.twrec-kind'))
      const sync = (): void => {
        buttons.forEach((button) => button.classList.toggle('active', button.dataset.kind === selected))
      }
      const close = (value: RunKind | null): void => {
        window.removeEventListener('keydown', onKey, true)
        overlay.remove()
        resolve(value)
      }
      const confirm = (): void => close(selected)
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(null); return }
        if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); confirm(); return }
        const idx = buttons.findIndex((button) => button.dataset.kind === selected)
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          selected = normaliseKind(buttons[(idx + 1) % buttons.length]?.dataset.kind)
          sync()
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          selected = normaliseKind(buttons[(idx + buttons.length - 1) % buttons.length]?.dataset.kind)
          sync()
        }
      }
      buttons.forEach((button) => {
        button.addEventListener('click', () => {
          selected = normaliseKind(button.dataset.kind)
          sync()
          confirm()
        })
      })
      sync()
      document.body.appendChild(overlay)
      window.addEventListener('keydown', onKey, true)
      buttons.find((button) => button.dataset.kind === selected)?.focus()
    })
  }

  async function saveWithPicker(closeAfter = false): Promise<boolean> {
    hideSaveToast()
    const picked = await chooseKind(controller.currentKind())
    if (!picked) return false
    const result = await controller.saveRun(picked)
    const ok = !!result?.ok && !result.discarded
    if (ok && closeAfter) await controller.closeWindow()
    return ok
  }

  async function showCloseModal(): Promise<void> {
    if (document.querySelector('.twrec-close-modal')) return
    hideSaveToast()
    const overlay = document.createElement('div')
    overlay.className = 'twrec-close-modal'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    const planned = await controller.plannedRuns()
    const preferred = planned.find((run) => run.preferred)
    const plannedHtml = planned.length ? `
      <div class="twrec-planned-list" role="listbox" aria-label="Attach delivery to a planned Run">
        ${planned.map((run) => `<button type="button" class="twrec-planned${run.id === preferred?.id ? ' active' : ''}" data-planned-run="${escapeHtml(run.id)}"><b>${escapeHtml(run.eventTitle || 'Planned Run')}</b><span>${escapeHtml(run.plannedDate || '')}${run.audience ? ` · ${escapeHtml(run.audience)}` : ''}</span></button>`).join('')}
      </div>` : ''
    overlay.innerHTML = `
      <div class="twrec-close-panel">
        <div class="twrec-close-title">Save this run to History?</div>
        <div class="twrec-close-sub">${planned.length ? 'Attach this delivery to a planned Run, or save it as a new delivery.' : 'This looks like a delivered run. Save it now, choose another kind, or close without saving.'}</div>
        ${plannedHtml}
        <div class="twrec-close-row">
          <button type="button" class="rec-btn keep" id="twrec-close-save">${planned.length ? 'Save new delivery' : 'Save delivery'}</button>
          <button type="button" class="rec-btn ghost" id="twrec-close-save-as">Save as…</button>
          <button type="button" class="rec-btn danger" id="twrec-close-discard">Don't save</button>
        </div>
      </div>`
    document.body.appendChild(overlay)
    const close = (): void => overlay.remove()
    overlay.querySelectorAll<HTMLButtonElement>('[data-planned-run]').forEach((button) => {
      button.addEventListener('click', () => {
        void (async () => {
          const result = await controller.saveRun('delivery', button.dataset.plannedRun)
          if (result?.ok && !result.discarded) await controller.closeWindow()
        })()
      })
    })
    overlay.querySelector<HTMLButtonElement>('#twrec-close-save')?.addEventListener('click', () => {
      void (async () => {
        const result = await controller.saveRun('delivery')
        if (result?.ok && !result.discarded) await controller.closeWindow()
      })()
    })
    overlay.querySelector<HTMLButtonElement>('#twrec-close-save-as')?.addEventListener('click', () => {
      void (async () => {
        close()
        const ok = await saveWithPicker(true)
        if (!ok) await showCloseModal()
      })()
    })
    overlay.querySelector<HTMLButtonElement>('#twrec-close-discard')?.addEventListener('click', () => {
      void controller.closeWindow()
    })
    window.addEventListener('keydown', function onCloseKey(event: KeyboardEvent) {
      if (!document.body.contains(overlay)) {
        window.removeEventListener('keydown', onCloseKey, true)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
        window.removeEventListener('keydown', onCloseKey, true)
      }
    }, true)
    ;(overlay.querySelector<HTMLButtonElement>('.twrec-planned.active') ?? overlay.querySelector<HTMLButtonElement>('[data-planned-run]') ?? overlay.querySelector<HTMLButtonElement>('#twrec-close-save'))?.focus()
  }

  function render(): void {
    const st = controller.getState()
    module.dataset.rec = st
    const saved = st === 'saving' || st === 'saved'
    const confirming = st === 'confirm'
    // In confirm, the clock shows the short length and the message replaces REC; in saving/saved
    // the saved message replaces both.
    if (label) label.textContent = 'REC'
    if (label) label.hidden = saved || confirming
    if (clock) { clock.hidden = saved; clock.textContent = fmtClock(controller.displayMs()) }
    if (frozen) frozen.hidden = st !== 'paused'
    if (savedMsg) {
      savedMsg.hidden = !saved // a kept short run still saves; discard goes to idle, no message
      savedMsg.textContent = `Saved as ${kindLabel(controller.currentKind())}`
    }
    if (confirmMsg) {
      confirmMsg.hidden = !confirming
      confirmMsg.innerHTML = `Short recording (${fmtClock(controller.displayMs())}) &mdash; keep it?`
    }
    if (spinner) spinner.hidden = !saved
    if (primary) primary.hidden = !(st === 'idle' || st === 'saved' || st === 'error')
    if (btnChangeKind) btnChangeKind.hidden = st !== 'saved'
    if (btnPause) btnPause.hidden = st !== 'recording'
    if (btnResume) btnResume.hidden = st !== 'paused'
    if (btnStop) {
      btnStop.hidden = !(st === 'recording' || st === 'paused')
      btnStop.setAttribute('aria-label', 'Stop and save recording (Shift R)')
      btnStop.setAttribute('title', 'Stop & save recording (⇧R)')
    }
    if (btnKeep) btnKeep.hidden = !confirming
    if (btnDiscard) btnDiscard.hidden = !confirming
    if (st !== 'paused') hideToast()
    if (controller.runGate().saved || controller.runGate().audioArmed) hideSaveToast()
  }

  controller.onChange(render)
  controller.onSlideMovedWhilePaused(showToast)
  controller.onRunOffer(showSaveToast)
  controller.onCloseOffer(() => { void showCloseModal() })
  controller.onError((msg) => {
    const n = document.createElement('div')
    n.className = 'twrec-error'
    n.textContent = msg
    document.body.appendChild(n)
    setTimeout(() => n.remove(), 4200)
  })

  // Clock tick — the visible REC clock advances while recording; render() keeps it correct otherwise.
  setInterval(() => { if (controller.getState() === 'recording' && clock) clock.textContent = fmtClock(controller.displayMs()) }, 200)

  // 4) Controls
  primary?.addEventListener('click', () => { void controller.start() })
  btnChangeKind?.addEventListener('click', () => { void saveWithPicker(false) })
  btnPause?.addEventListener('click', () => controller.pause())
  btnResume?.addEventListener('click', () => controller.resume())
  btnStop?.addEventListener('click', () => { void controller.stop() })
  btnKeep?.addEventListener('click', () => { void controller.confirmSave(true) })
  btnDiscard?.addEventListener('click', () => { void controller.confirmSave(false) })
  $('twrec-toast-yes')?.addEventListener('click', () => { controller.resume(); hideToast() })
  $('twrec-toast-no')?.addEventListener('click', hideToast)
  $('twrec-save-delivery')?.addEventListener('click', () => { hideSaveToast(); void controller.saveRun('delivery') })
  $('twrec-save-as')?.addEventListener('click', () => { void saveWithPicker(false) })
  $('twrec-save-dismiss')?.addEventListener('click', hideSaveToast)

  // 5) Keyboard — ⇧R record/stop, ⇧P pause/resume. Capture phase so we act before the
  // presenter's own handler; plain P/R stay the presenter's (pacing timer / reveal).
  function toggleRecord(): void {
    const st = controller.getState()
    if (st === 'recording' || st === 'paused') void controller.stop()
    else if (st === 'idle' || st === 'saved' || st === 'error') void controller.start()
  }
  function togglePause(): void {
    const st = controller.getState()
    if (st === 'recording') controller.pause()
    else if (st === 'paused') controller.resume()
  }
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const t = e.target
    if (t instanceof HTMLElement && t.matches('input, textarea, select, [contenteditable="true"]')) return
    // Resolve a short-recording Keep/Discard from the keyboard: Enter keeps, Esc discards.
    if (controller.getState() === 'confirm') {
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); void controller.confirmSave(true) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); void controller.confirmSave(false) }
      return
    }
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault()
      e.stopImmediatePropagation()
      void saveWithPicker(false)
      return
    }
    if (saveToast.classList.contains('show') && e.key === 'Enter') {
      e.preventDefault()
      e.stopImmediatePropagation()
      hideSaveToast()
      void controller.saveRun('delivery')
      return
    }
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'R' || e.key === 'r') { e.preventDefault(); e.stopImmediatePropagation(); toggleRecord() }
    else if (e.key === 'P' || e.key === 'p') { e.preventDefault(); e.stopImmediatePropagation(); togglePause() }
  }, true)

  // 6) Cheat-sheet parity — the real "?" sheet rebuilds its body on each open, so re-append
  // a Recording section whenever it opens (MutationObserver on the hidden attribute).
  const sheet = $('twShortcuts')
  if (sheet) {
    const injectSheet = (): void => {
      const body = $('twShortcutsBody')
      if (!body || body.querySelector('.twrec-sheet-section')) return
      const head = document.createElement('div')
      head.className = 'tw-shortcuts-section twrec-sheet-section'
      head.textContent = 'Recording'
      const mk = (keys: string, text: string): HTMLElement => {
        const row = document.createElement('div'); row.className = 'tw-shortcuts-row'
        const k = document.createElement('kbd'); k.className = 'tw-shortcuts-keys'; k.textContent = keys
        const l = document.createElement('span'); l.textContent = text
        row.append(k, l); return row
      }
      body.prepend(
        head,
        mk('⇧ R', 'Start / stop recording'),
        mk('⇧ P', 'Pause / resume recording'),
        mk('L', 'Save run to History')
      )
    }
    new MutationObserver(() => { if (!sheet.hidden) injectSheet() })
      .observe(sheet, { attributes: true, attributeFilter: ['hidden'] })
  }

  render()
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

let controller: RecorderController | null = null

async function init(): Promise<void> {
  const ctx = await loadContext()
  controller = createRecorderController(ctx)
  mountRecUi(controller)
  // The presenter view also gets the ⌘E "edit this slide" bridge (a plain presentation window gets
  // it via present-edit.ts). Mounted after the REC UI so both controls coexist.
  mountEditBridge()
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { void init() })
} else {
  void init()
}
