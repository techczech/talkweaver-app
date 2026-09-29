/// <reference lib="dom" />
// Recording bridge — a preload TalkWeaver attaches to the PRESENT window only when it
// opens it (opt-in). A deck opened as a plain portable file has no preload, so it has no
// REC control and stays fully portable (spec, ADR-0035). Running here, the bridge:
//   • records the presenter's mic with MediaRecorder,
//   • builds the slide-time index by watching which slide id is in the URL hash,
//   • hands the audio + raw marks + session metadata to main on stop (recording:save).
//
// It shares the DOM with the deck runtime but lives in its own isolated JS world
// (contextIsolation), so it never touches the presenter template's code — it ADDS the REC
// cluster and its toasts (present-rec-ui.ts, mounted in the status bar's recording slot) and
// reads the hash the runtime already maintains. Nothing here removes
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
import { mountLiveBridge } from './present-live-bridge'
import type { PresentationCloseOffer, LiveCloseAction } from './present-close-flow'
import { shouldOfferRecordingStart } from './present-recording-offer'
import { mountRecUi } from './present-rec-ui'
import type { RunKind } from './present-rec-view'

// ── Types ────────────────────────────────────────────────────────────────────

// idle → recording ⇄ paused → (confirm if short) → saving → saved   (error is terminal-for-this-run).
// `confirm` = a short recording is waiting on a Keep/Discard choice — nothing is saved until then.
export type RecState = 'idle' | 'recording' | 'paused' | 'confirm' | 'saving' | 'saved' | 'error'

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
  /** Stop recording; forceKeep explicitly keeps short clips, otherwise they await confirmSave. */
  stop(forceKeep?: boolean): Promise<SaveResult | null>
  /** Resolve a short recording or retry a failed audio save; keep=false explicitly discards pending audio. */
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
  /** Fired at most once per session: the talk left a long-held title slide with no recording running. */
  onRecordingStartOffer(cb: () => void): void
  onCloseOffer(cb: (offer: PresentationCloseOffer) => void): void
  closeWindow(liveAction?: LiveCloseAction): Promise<void>
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

  // The start-recording offer (present-recording-offer.ts): which slide index is showing, and
  // when the presenter arrived on the title slide (null while elsewhere).
  let offerSlideIndex = -1
  let titleArrivedAt: number | null = null
  let startOffered = false

  const changeCbs: Array<(s: RecState) => void> = []
  const pausedMoveCbs: Array<() => void> = []
  const errorCbs: Array<(m: string) => void> = []
  const runOfferCbs: Array<() => void> = []
  const startOfferCbs: Array<() => void> = []
  const closeOfferCbs: Array<(offer: PresentationCloseOffer) => void> = []

  const emitChange = (): void => { for (const cb of changeCbs) cb(state) }
  const emitPausedMove = (): void => { for (const cb of pausedMoveCbs) cb() }
  const emitError = (m: string): void => { for (const cb of errorCbs) cb(m) }
  const emitRunOffer = (): void => { for (const cb of runOfferCbs) cb() }
  const emitStartOffer = (): void => { for (const cb of startOfferCbs) cb() }
  const emitCloseOffer = (offer: PresentationCloseOffer): void => { for (const cb of closeOfferCbs) cb(offer) }

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
  const isAudioArmed = (): boolean => state === 'recording' || state === 'paused' || state === 'confirm' || ((state === 'saving' || state === 'error') && !!pendingBlob)
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
    if (isAudioArmed() || state === 'saving') return
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

  async function stop(forceKeep = false): Promise<SaveResult | null> {
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
    if (!forceKeep && frozenDisplayMs < ctx.discardThresholdMs) {
      state = 'confirm'
      emitChange()
      return null
    }
    return doSave(forceKeep)
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
    // A changed main-process threshold may reject a clip the preload expected to keep.
    // Retain the captured audio until a kept save succeeds or the presenter discards it.
    if (result.discarded) result = { ok: false, error: 'Recording was not saved. Try saving again to keep it.' }
    if (result.ok) pendingBlob = null
    saveResult = result
    if (result.ok && !result.discarded && result.sessionId) {
      savedRunSessionId = result.sessionId
      savedRunKind = normaliseKind(result.kind)
      savedRunCanFinalise = false
    }
    if (!result.ok) {
      state = 'error'
      emitError('Recording could not be saved. Keep this presentation open and try saving again after checking disk space.')
    } else {
      state = 'saved'
    }
    pushRunState()
    emitChange()
    return result
  }

  // Resolve a Keep/Discard on a short recording. Keep forces the save; Discard drops it.
  async function confirmSave(keep: boolean): Promise<SaveResult | null> {
    if (state !== 'confirm' && !(state === 'error' && pendingBlob)) return null
    if (keep) return doSave(true)
    pendingBlob = null
    saveResult = { ok: true, discarded: true }
    state = 'idle'
    frozenDisplayMs = null
    initialiseRunCapture()
    pushRunState()
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

  // Index-based (not hash-based) so the rule sees exactly "title slide → slide 2". A moment with
  // no active slide is ignored rather than read as leaving the title.
  function noteSlideIndexForStartOffer(idx: number): void {
    if (idx < 0 || idx === offerSlideIndex) return
    const t = performance.now()
    if (shouldOfferRecordingStart({
      titleArrivedAtMs: titleArrivedAt,
      nowMs: t,
      fromIndex: offerSlideIndex,
      toIndex: idx,
      recordingState: state,
      alreadyOffered: startOffered
    })) {
      startOffered = true
      emitStartOffer()
    }
    offerSlideIndex = idx
    titleArrivedAt = idx === 0 ? t : null
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
    noteSlideIndexForStartOffer(idx)
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
  ipcRenderer.on('recording:show-close-offer', (_event, offer?: PresentationCloseOffer) => emitCloseOffer(offer ?? { live: false, offerRunSave: true, audioArmed: isAudioArmed() }))
  noteSlideIndexForStartOffer(activeSlideIndex())
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
    onRecordingStartOffer: (cb) => { startOfferCbs.push(cb) },
    onCloseOffer: (cb) => { closeOfferCbs.push(cb) },
    closeWindow: async (liveAction) => {
      if (isAudioArmed()) throw new Error('Save the recording before closing the presentation.')
      await finaliseRun()
      const result = await ipcRenderer.invoke('recording:close-window', liveAction)
      if (!result?.ok) throw new Error(result?.error || 'The presentation could not be closed. Please try again.')
    }
  }
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
  mountLiveBridge()
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { void init() })
} else {
  void init()
}
