// The recording editor (slice 3, shape A; docs/design/2026-11-10-record-and-edit-video/hifi/): the talk
// slide by slide with the words spoken on each, edited by selecting words; a player that equals the
// export; Tidy up's proposals; an overview strip that opens into a timeline. One bar above the content.
//
// Every change is one operation on the Run's edit sidecar (applyEditOp), shown at once and confirmed by
// main, which is the only writer. Nothing is cut without an explicit action: selecting, dragging and
// opening Tidy up change nothing until Cut, Leave this slide out, a moved slide start or "Cut the n
// ticked". Trims made in the recording panel and cuts made here are one edit list; the player and the
// export all read one resolved edit state (resolveRecording): cuts on the 30 fps grid, word times from
// precise word timing where it placed a word, slide starts from edit boundaries, slides left out.
//
// Logic lives in src/shared/recording-editor.ts (rows, clean or close, cut operations, Tidy up).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsLeftRight, ChevronsRightLeft, Clock, Download, Ear, EyeOff, Flag, GripVertical,
  Image as ImageIcon, ListChecks, SquareUser, CircleDot, Loader2, MessageSquareOff, Pause, Play, Presentation, Redo2, RefreshCw, RotateCcw, Scissors, Settings, SlidersHorizontal, TextCursorInput, Undo2, Video, AudioLines, Check, X
} from 'lucide-react'
import type { RecordingSession, Transcript } from '../../../../preload/index'
import type { RecordingOpen } from '../../../../main/recording-video-ipc'
import type { EditsSnapshot } from '../../../../main/recording-edits-store'
import { applyEditOp, DEFAULT_FINISH, emptyFaces, faceOf, normaliseRanges, type EditOp, type TimeRange } from '../../../../shared/recording-edits'
import { chaptersFor, faceTrack, faceTrackOnClock, keptSpans, type FaceSegment, planEditedToRun, planRunToEdited, withoutCamera } from '../../../../shared/recording-video'
import {
  boundaryTargets, coveredMs, cutWordsOp, joinsAtSentence, edgeQuality, EDITOR_THRESHOLDS, editorWords, leaveOutOp, moveBoundaryOp, nearestCleanEdge,
  markedStretch, planDigest, putBackOp, putBoundaryBackOp, quoteWords, resolveRecording, restoreOp, TARGET_WORDS, targetKind, tidyProposals, wordAt, wordsRange,
  type CutView, type EditorRow, type EditorWords, type TidyKind, type TidyProposal
} from '../../../../shared/recording-editor'
import { recordingRunHome } from '../../../../shared/recording-run-home'
import { rangesToVideoClock, rowTakeControls, takesInUse, toVideoClock } from '../../../../shared/recording-takes'
import { shortcutEventMatches } from '../../../../shared/shortcut-registry'
import { commandRan } from '../../commands/command-ran'
import { LayeredPlayer, type LayeredPlayerHandle, type PlayerSource } from './LayeredPlayer'
import { useRecordingExport } from './useRecordingExport'
import { LookAndSoundSheet, useEvenVoice } from './LookAndSound'
import { FacePositionSheet, faceLabel } from './FacePosition'
import { chosenTakes, missingTakeNotice, missingTakeText, TakesPanel, unavailableTakes, useTakes, useTakeSource } from './RecordSlideAgain'
import './recording-panel.css'
import './recording-editor.css'

export type EditorSlide = { title: string; section?: string; thumbUrl: string | null; n: number }
export type WritingState = { busy: boolean; note: string | null; error: string | null }

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

// Keys of the editor, all from the shortcut registry (scope studio), matched by its own matcher.
const KEYS = ['studio.editor-play', 'studio.editor-cut', 'studio.editor-previous-word', 'studio.editor-next-word', 'studio.editor-extend-previous', 'studio.editor-extend-next', 'studio.trim-undo', 'studio.trim-redo', 'studio.trim-start', 'studio.trim-end'] as const

type Selection = { anchor: number; focus: number }
type Pop =
  | { kind: 'selection' }
  | { kind: 'cut'; cut: number }
  | null
type Drag = { row: number; word: number; any: boolean; x: number; y: number } | null
type Preview = { cuts: TimeRange[]; until: number } | null
const selRange = (s: Selection | null): [number, number] | null => (s ? [Math.min(s.anchor, s.focus), Math.max(s.anchor, s.focus)] : null)

/** Shared by every row: the parts of the editor's state a row reads, and the handlers it calls. */
export type RowCtx = {
  ctx: EditorWords
  rows: EditorRow[]
  cuts: CutView[]
  byWord: Int32Array
  slides: Record<string, EditorSlide>
  flagsAfter: Map<number, number>
  stepsBefore: Map<number, number[]>
  clickBefore: Map<number, { row: number; moved: boolean }>
  sidecarCuts: TimeRange[]
}

export function RecordingEditor({ run, slides, transcript, writing, parakeetReady, suspended = false, onWriteOut, onStopWriting, onBack, onHelp, onSettings, onReloadWords, onRecordSlideAgain }: {
  run: RecordingSession
  slides: Record<string, EditorSlide>
  transcript: Transcript | null
  writing: WritingState
  parakeetReady: boolean
  /** Another surface (the shortcut sheet) has the keys. */
  suspended?: boolean
  onWriteOut: (choice?: 'native' | 'parakeet') => void
  onStopWriting: () => void
  onBack: () => void
  onHelp: () => void
  onSettings: () => void
  /** Read the Run's words again (an export found them changed). */
  onReloadWords?: () => void
  /** Record one slide again: open the presenter view for a new take; resolves to an error to show, or null. */
  onRecordSlideAgain?: (retake: { change: number; slideId: string; slideN: number; camera: boolean }) => Promise<string | null>
}): ReactNode {
  const home = recordingRunHome(run)
  const runRef = useMemo(() => ({ talkSlug: run.talkSlug, runId: run.id, home }), [run.talkSlug, run.id, home])
  const [opened, setOpened] = useState<RecordingOpen | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [source, setSource] = useState<PlayerSource | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [edits, setEdits] = useState<EditsSnapshot | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [runMs, setRunMs] = useState(0)
  const [videoMs, setVideoMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)
  const [pop, setPop] = useState<Pop>(null)
  const [popAt, setPopAt] = useState<{ left: number; top: number; up: boolean; arrow: number } | null>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [choose, setChoose] = useState<number | null>(null)
  const [timeline, setTimeline] = useState(false)
  const [tidyOpen, setTidyOpen] = useState(false)
  const [lookOpen, setLookOpen] = useState(false)
  const [faceRow, setFaceRow] = useState<number | null>(null)
  const [kept, setKept] = useState<Set<string>>(() => new Set())
  const [preview, setPreview] = useState<Preview>(null)
  const [models, setModels] = useState<import('../../../../shared/alignment-status').AlignmentModelRow[]>([])
  const [focusCheck, setFocusCheck] = useState<string | null>(null)
  const player = useRef<LayeredPlayerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const playUntil = useRef<number | null>(null)

  // ---- Open the Run: layers and edits, then playback copies ---------------------------------------
  useEffect(() => {
    let alive = true
    setOpened(null); setOpenError(null); setSource(null); setEdits(null); setEditError(null)
    if (!window.tw.recordingVideo) { setOpenError('Playback is not available in this window.'); return }
    void window.tw.recordingVideo.open(runRef).then((r) => {
      if (!alive) return
      if (!r.ok) { setOpenError(r.error); return }
      setOpened(r); setEdits(r.edits); confirmed.current = r.edits; shown.current = r.edits
      setPreparing(true)
      return window.tw.recordingVideo.prepare(runRef).then((p) => {
        if (!alive) return
        if (!p.ok) { setOpenError(p.error); return }
        setSource({ voice: p.voice, slides: p.slides, camera: p.camera })
      })
    }).catch((e) => { if (alive) setOpenError(String(e)) }).finally(() => { if (alive) setPreparing(false) })
    return () => { alive = false }
  }, [runRef])

  useEffect(() => {
    if (!window.tw.alignment?.models) return
    let alive = true
    void window.tw.alignment.models().then((rows) => { if (alive) setModels(rows) }).catch(() => {})
    const off = window.tw.alignment.onModels?.((rows) => setModels(rows))
    return () => { alive = false; off?.() }
  }, [])

  // ---- Edits: shown at once, confirmed by main one at a time ----------------------------------------
  const durationMs = opened?.durationMs ?? run.recordingMs
  const confirmed = useRef<EditsSnapshot | null>(null)
  const shown = useRef<EditsSnapshot | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const generation = useRef(0)
  /** The last save that failed (cleared by the next one that succeeds): Export and leaving wait on it. */
  const saveFailed = useRef<string | null>(null)
  const editStarted = useRef<number | null>(null)
  const edit = useCallback((op: EditOp): boolean => {
    const cur = shown.current
    if (!cur || cur.problem) return false
    let next
    try { next = applyEditOp(cur.edits, op, durationMs) } catch (e) { setEditError((e as Error).message); return false }
    if (next === cur.edits) return false
    setEditError(null)
    editStarted.current = performance.now()
    const optimistic = { ...cur, edits: next }
    shown.current = optimistic; setEdits(optimistic)
    pending.current++
    const gen = generation.current
    queue.current = queue.current.then(async () => {
      if (gen !== generation.current) return
      const base = confirmed.current
      if (!base) return
      const r = await window.tw.recordingVideo.edit(runRef, op, base.edits.revision)
      if (r.ok) {
        confirmed.current = r.edits
        saveFailed.current = null
        if (pending.current === 1) { shown.current = r.edits; setEdits(r.edits) }
      } else {
        // Refused or failed: nothing was saved; show what is on disk and say why.
        generation.current++
        saveFailed.current = r.error
        shown.current = confirmed.current; setEdits(confirmed.current)
        setEditError(r.error)
      }
    }).catch((e) => { generation.current++; saveFailed.current = String(e); shown.current = confirmed.current; setEdits(confirmed.current) }).finally(() => { pending.current = Math.max(0, pending.current - 1) })
    return true
  }, [runRef, durationMs])
  /** Wait until every edit made so far has been saved (or one failed). */
  // The digest of the saved state as this window resolves it (with the words it has now).
  const planOf = useRef<(e: EditsSnapshot) => string>(() => '')
  const settle = useCallback(async (): Promise<{ revision: number; plan: string } | { error: string }> => {
    for (;;) { const q = queue.current; await q; if (q === queue.current) break }
    if (saveFailed.current) return { error: `An edit could not be saved, so nothing was exported: ${saveFailed.current}` }
    const c = confirmed.current
    return c ? { revision: c.edits.revision, plan: planOf.current(c) } : { error: 'The recording is not open.' }
  }, [])
  // Main found the saved state differs from the screen: read the edits and the words again.
  const refresh = useCallback(() => {
    onReloadWords?.()
    if (pending.current) return
    void window.tw.recordingVideo.open(runRef).then((r) => { if (r.ok && !pending.current) { confirmed.current = r.edits; shown.current = r.edits; setEdits(r.edits) } }).catch(() => {})
  }, [onReloadWords, runRef])
  const leave = useCallback(async (): Promise<void> => {
    const r = await settle()
    if ('error' in r && saveFailed.current) { setEditError(`An edit could not be saved: ${saveFailed.current} The editor stays open; undo or redo the edit, or reopen the recording.`); return }
    onBack()
  }, [settle, onBack])

  // ---- Derived: words, rows, cuts, plan ---------------------------------------------------------------
  // While "Export without captions" is open (the words could not be read), the plan is shown without words: the plan both sides then use.
  const [withoutWords, setWithoutWords] = useState(false)
  const words = withoutWords ? null : transcript
  const ctx = useMemo(() => editorWords(words, durationMs), [words, durationMs])
  const n = ctx.words.length
  const sidecarCuts = edits?.edits.cuts ?? EMPTY
  const boundaries = edits?.edits.boundaries ?? EMPTY_B
  const leftOutFacts = edits?.edits.leftOut ?? EMPTY_N
  const restoredTrims = edits?.edits.restoredTrims ?? EMPTY
  // Record this slide again: the takes on disk, and the ones the edits choose that can be played.
  // Record one slide again is off unless main says otherwise (takesEnabled): take choices in the edits file are then kept but not used.
  const takesOn = !!opened?.recordAgain
  const takesList = useTakes(runRef, opened?.takes, takesOn)
  const savedChoices = edits?.edits.takes ?? EMPTY_TAKES
  const chosenList = useMemo(() => (takesOn ? savedChoices : EMPTY_TAKES), [takesOn, savedChoices])
  const takes = useMemo(() => chosenTakes(chosenList, takesList), [chosenList, takesList])
  const missingTakes = useMemo(() => unavailableTakes(chosenList, takesList), [chosenList, takesList])
  // The one resolved edit state: what the words show, the length, the player and the export all read.
  const resolved = useMemo(() => resolveRecording({ durationMs, ctx, edits: { cuts: sidecarCuts, boundaries, leftOut: leftOutFacts, restoredTrims }, runTrims: run.trims as TimeRange[] | undefined, marks: run.slideTimeIndex, takes, segments: words?.segments }),
    [durationMs, ctx, sidecarCuts, boundaries, leftOutFacts, restoredTrims, run.trims, run.slideTimeIndex, takes, words?.segments])
  const { rows, cuts, spans, views, leftOutRows, editedMs } = resolved
  planOf.current = (e) => planDigest(resolveRecording({ durationMs, ctx, edits: e.edits, runTrims: run.trims as TimeRange[] | undefined, marks: run.slideTimeIndex, takes: chosenTakes(takesInUse(takesOn, e.edits.takes), takesList), segments: words?.segments }))
  // Words or their timing that change while the editor is open (writing out, precise word timing) are
  // followed at once: the plan is resolved again, and a quiet note says so.
  const wordsKey = `${transcript?.createdAt ?? ''}|${transcript?.alignment?.alignedAt ?? ''}|${n}`
  const lastWordsKey = useRef<string | null>(null)
  const [wordsNote, setWordsNote] = useState(false)
  useEffect(() => {
    if (lastWordsKey.current !== null && lastWordsKey.current !== wordsKey && n) { setWordsNote(true); const t = setTimeout(() => setWordsNote(false), 8000); lastWordsKey.current = wordsKey; return () => clearTimeout(t) }
    lastWordsKey.current = wordsKey
  }, [wordsKey, n])
  const byWord = useMemo(() => {
    const out = new Int32Array(n).fill(-1)
    views.forEach((v, i) => { for (let w = v.firstWord; w < v.endWord; w++) out[w] = i })
    return out
  }, [views, n])
  const playSpans = useMemo(() => (preview ? keptSpans(normaliseRanges(rangesToVideoClock(resolved.clock, normaliseRanges([...cuts, ...preview.cuts], durationMs)), resolved.clockMs), resolved.clockMs) : spans), [preview, cuts, spans, durationMs, resolved.clock, resolved.clockMs])
  const camera = edits?.edits.finish.camera !== false
  const finish = edits?.edits.finish ?? DEFAULT_FINISH
  // The player plays the evened voice when Even out the volume is on (made in main on first use).
  const even = useEvenVoice(runRef, source, finish.evenVolume)
  // With a new take chosen for a slide, the player plays on the video clock (recording-takes.ts).
  const composed = useTakeSource(runRef, even.source, resolved.clock, durationMs, finish.evenVolume)
  const faces = edits?.edits.faces ?? EMPTY_FACES
  const track = useMemo(() => faceTrack(rows, faces, durationMs), [rows, faces, durationMs])
  const clockTrack = useMemo(() => faceTrackOnClock(track, resolved.clock), [track, resolved.clock])
  const enters = useMemo(() => (run.slideTimeIndex ?? []).filter((m) => m.event === 'enter' && Number.isFinite(m.tMs)).sort((a, b) => a.tMs - b.tMs), [run.slideTimeIndex])
  const flagsAfter = useMemo(() => {
    const out = new Map<number, number>()
    for (const m of run.slideTimeIndex ?? []) {
      if (m.event !== 'flag' || !Number.isFinite(m.tMs)) continue
      let w = wordAt(ctx, m.tMs + EDITOR_THRESHOLDS.flagGraceMs)
      while (w >= 0 && ctx.words[w].end > m.tMs + EDITOR_THRESHOLDS.flagGraceMs) w--
      out.set(w, (out.get(w) ?? 0) + 1)
    }
    return out
  }, [run.slideTimeIndex, ctx])
  const stepsBefore = useMemo(() => {
    const out = new Map<number, number[]>()
    for (const r of rows) r.steps.forEach((s, i) => out.set(s.word, [...(out.get(s.word) ?? []), i + 1]))
    return out
  }, [rows])
  const clickBefore = useMemo(() => {
    const out = new Map<number, { row: number; moved: boolean }>()
    for (const r of rows) if (r.click !== null) out.set(r.click, { row: r.index, moved: !!r.moved })
    return out
  }, [rows])
  const rowCtx: RowCtx = useMemo(() => ({ ctx, rows, cuts: views, byWord, slides, flagsAfter, stepsBefore, clickBefore, sidecarCuts }), [ctx, rows, views, byWord, slides, flagsAfter, stepsBefore, clickBefore, sidecarCuts])
  const tidy = useMemo(() => (tidyOpen ? tidyProposals(ctx, rows, run.slideTimeIndex, cuts) : null), [tidyOpen, ctx, rows, run.slideTimeIndex, cuts])
  // Leaving a slide out is refused when nothing would be left to play.
  const leaveOut = useCallback((row: EditorRow) => {
    const after = resolveRecording({ durationMs, ctx, edits: { cuts: sidecarCuts, boundaries, leftOut: [...leftOutFacts, row.change], restoredTrims }, runTrims: run.trims as TimeRange[] | undefined, marks: run.slideTimeIndex, takes })
    if (after.editedMs <= 0) { setEditError('That would leave nothing in the video.'); return }
    edit(leaveOutOp(row))
  }, [durationMs, ctx, sidecarCuts, boundaries, leftOutFacts, restoredTrims, run.trims, run.slideTimeIndex, takes, edit])
  // ---- Record this slide again ----------------------------------------------------------------------------
  const [retakeNote, setRetakeNote] = useState<{ text: string; warn: boolean } | null>(null)
  const recordAgain = useCallback(async (row: EditorRow): Promise<void> => {
    if (!onRecordSlideAgain) return
    const n = slides[row.slideId]?.n ?? row.index + 1
    setRetakeNote({ text: `Opening the presenter view at slide ${n}…`, warn: false })
    const error = await onRecordSlideAgain({ change: row.change, slideId: row.slideId, slideN: n, camera: !!opened?.hasCamera }).catch((e) => String(e))
    setRetakeNote(error ? { text: error, warn: true } : { text: `Record slide ${n} in the presenter view, then come back here to choose the take.`, warn: false })
  }, [onRecordSlideAgain, slides, opened?.hasCamera])
  const takesOfRow = (row: EditorRow) => takesList.filter((t) => t.change === row.change)
  const takesKeyOf = (row: EditorRow): string => { const list = takesOfRow(row); const gone = missingTakes.find((t) => t.change === row.change); if (gone) return `missing:${gone.run}:${gone.reason}|${!!problem}`; return list.length ? `${list.map((t) => t.run).join(',')}|${chosenList.find((c) => c.change === row.change)?.run ?? ''}|${!!problem}` : '' }
  const takesNodeOf = (row: EditorRow): ReactNode => {
    if (!takesOn) return null
    const missing = missingTakes.find((t) => t.change === row.change)
    if (missing) return (
      <div className="tre-inrow warn" role="alert" data-take-missing><AlertTriangle className="lt-icon" /><span className="tre-grow">{missingTakeText(missing.reason)}</span>
        <button className="tw-btn tw-btn--sm" disabled={!!problem} onClick={() => edit({ kind: 'take', change: row.change, run: null })}>Use the first take</button></div>
    )
    const list = takesOfRow(row)
    if (!rowTakeControls(takesOn, { hasPicture: true, slideId: row.slideId, leftOut: leftOutRows.has(row.index), takes: list.length }).chooser) return null
    const chosenRun = resolved.replacedRows.get(row.index) ?? null
    const n = slides[row.slideId]?.n ?? row.index + 1
    return <TakesPanel runRef={runRef} slideN={n} firstMs={Math.max(0, row.end - row.start)} takes={list} chosen={chosenRun} disabled={!!problem}
      firstVoice={source?.voice ? { url: source.voice, from: row.start, to: row.end } : null}
      onPlayInVideo={() => { player.current?.seekRun(row.start); player.current?.play() }}
      onChoose={(take) => edit({ kind: 'take', change: row.change, run: take })} />
  }
  const rowAtMs = useCallback((t: number): number => { let r = 0; for (let i = 0; i < rows.length; i++) if (rows[i].start <= t) r = i; return r }, [rows])
  const range = useMemo(() => selRange(sel), [sel])
  const currentRow = rowAtMs(runMs)

  // How long an edit took to show (from the action to the next painted frame), for measurement.
  useLayoutEffect(() => {
    if (editStarted.current === null) return
    const started = editStarted.current
    editStarted.current = null
    requestAnimationFrame(() => { if (rootRef.current) rootRef.current.dataset.lastEditMs = (performance.now() - started).toFixed(1) })
  }, [edits])

  // ---- Playing follows the words ------------------------------------------------------------------------
  const nowWord = useRef(-1)
  const nowRow = useRef(-1)
  const onTime = useCallback((t: number, v: number) => {
    setRunMs(t); setVideoMs(v)
    if (playUntil.current !== null && t >= playUntil.current) { playUntil.current = null; player.current?.pause(); setPreview(null) }
    let w = n ? wordAt(ctx, t) : -1
    while (w >= 0 && !ctx.words[w].timed) w--
    const root = listRef.current
    if (root && w !== nowWord.current) {
      root.querySelector(`[data-w="${nowWord.current}"]`)?.classList.remove('is-now')
      const el = root.querySelector(`[data-w="${w}"]`)
      el?.classList.add('is-now')
      nowWord.current = w
    }
    const r = rowAtMs(t)
    if (r !== nowRow.current) {
      nowRow.current = r
      if (player.current?.playing()) root?.querySelector(`[data-row="${r}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [ctx, n, rowAtMs])
  const onPlaying = useCallback((p: boolean) => { setPlaying(p); if (!p) { playUntil.current = null; setPreview(null) } }, [])
  const playRange = useCallback((from: number, until: number, withCuts?: TimeRange[]) => {
    if (withCuts) setPreview({ cuts: withCuts, until })
    // Let the preview spans reach the player before it starts.
    requestAnimationFrame(() => {
      player.current?.pause()
      player.current?.seekRun(from)
      playUntil.current = until
      player.current?.play()
    })
  }, [])
  /** One second either side of a join, as it will sound: across the cut. */
  const playJoin = useCallback((cut: TimeRange, extra?: TimeRange[]) => {
    const all = normaliseRanges([...cuts, ...(extra ?? [])], durationMs)
    const plan = keptSpans(all, durationMs)
    const join = planRunToEdited(plan, cut.start)
    playRange(planEditedToRun(plan, Math.max(0, join - 1000)), planEditedToRun(plan, join + 1000), extra)
  }, [cuts, durationMs, playRange])
  const playSelection = useCallback(() => {
    if (!range) return
    const r = wordsRange(ctx, range[0], range[1])
    playRange(r.start, r.end)
  }, [range, ctx, playRange])

  // ---- Actions --------------------------------------------------------------------------------------
  const cutSelection = useCallback(() => {
    if (!range || !n) return
    const made = cutWordsOp(ctx, range[0], range[1])
    if ('error' in made) { setEditError(made.error); setPop(null); return }
    if (!edit(made.op)) return
    setSel(null); setPop(null)
    // A close cut plays a second either side of the join it made, so the owner hears it; clean cuts are silent.
    if (edgeQuality(ctx, made.range.start, 'start') === 'close' || edgeQuality(ctx, made.range.end, 'end') === 'close') playJoin(made.range, [made.range])
  }, [range, n, ctx, edit, playJoin])
  const moveSel = useCallback((delta: number, extend: boolean) => {
    if (!n) return
    setPop(null)
    setSel((s) => {
      const from = s ? s.focus : Math.max(0, wordAt(ctx, player.current?.runMs() ?? runMs))
      const focus = Math.max(0, Math.min(n - 1, from + (s ? delta : 0)))
      const next = extend && s ? { anchor: s.anchor, focus } : { anchor: focus, focus }
      listRef.current?.querySelector(`[data-w="${focus}"]`)?.scrollIntoView({ block: 'nearest' })
      if (!extend) player.current?.seekRun(ctx.words[focus].start)
      return next
    })
  }, [n, ctx, runMs])
  const goToRow = useCallback((r: number, seek = true) => {
    listRef.current?.querySelector(`[data-row="${r}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (seek && rows[r]) player.current?.seekRun(rows[r].start)
  }, [rows])

  // ---- Keyboard (registry ids, behind the text-field guard) ------------------------------------------
  // While a sheet (Tidy up, Export, the shortcut sheet) or the cut popover owns the keys, the editor's keys
  // wait; Escape closes the topmost of them first and focus goes back where it was.
  const exportState = useRef<{ open: boolean; close: () => void }>({ open: false, close: () => {} })
  const cutPopRef = useRef<{ playJoin: () => void } | null>(null)
  const sheetUp = lookOpen || faceRow !== null
  const keyState = useRef({ range, cutSelection, moveSel, playSelection, edit, pop, choose, tidyOpen, lookOpen, faceRow, sheetUp, leave, suspended })
  keyState.current = { range, cutSelection, moveSel, playSelection, edit, pop, choose, tidyOpen, lookOpen, faceRow, sheetUp, leave, suspended }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      // Text entry keeps its keys; a sheet's tick box or option still closes with Escape.
      const typing = !!t && !!t.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]')
      const inChoice = !!t && !!t.closest('input[type="checkbox"], input[type="radio"]')
      if (typing || (inChoice && e.key !== 'Escape')) return
      const k = keyState.current
      if (k.suspended) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (exportState.current.open) exportState.current.close()
        else if (k.tidyOpen) setTidyOpen(false)
        else if (k.lookOpen) setLookOpen(false)
        else if (k.faceRow !== null) setFaceRow(null)
        else if (k.pop) setPop(null)
        else if (k.choose !== null) setChoose(null)
        else if (k.range) setSel(null)
        else void k.leave()
        return
      }
      if (exportState.current.open || k.tidyOpen || k.sheetUp) return
      // The cut popover owns the keys: Space plays across the join (its hint), nothing else acts behind it.
      if (k.pop?.kind === 'cut') {
        if (shortcutEventMatches(e, 'studio.editor-play')) { e.preventDefault(); cutPopRef.current?.playJoin() }
        return
      }
      const hit = KEYS.find((id) => shortcutEventMatches(e, id))
      if (!hit) return
      e.preventDefault()
      switch (hit) {
        case 'studio.editor-play': if (k.range && !player.current?.playing()) k.playSelection(); else player.current?.toggle(); break
        case 'studio.editor-cut': k.cutSelection(); break
        case 'studio.editor-previous-word': k.moveSel(-1, false); break
        case 'studio.editor-next-word': k.moveSel(1, false); break
        case 'studio.editor-extend-previous': k.moveSel(-1, true); break
        case 'studio.editor-extend-next': k.moveSel(1, true); break
        case 'studio.trim-undo': k.edit({ kind: 'undo' }); break
        case 'studio.trim-redo': k.edit({ kind: 'redo' }); break
        case 'studio.trim-start': k.edit({ kind: 'trim-start', at: player.current?.runMs() ?? 0 }); break
        case 'studio.trim-end': k.edit({ kind: 'trim-end', at: player.current?.runMs() ?? 0 }); break
      }
      commandRan(hit)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus goes into a sheet when it opens and back where it was when it closes.
  const focusBack = useRef<HTMLElement | null>(null)
  // Tidy up moves focus itself; Look and sound and the face sheet are modal dialogs that put focus back on their opener.
  const sheetOpen = tidyOpen
  useEffect(() => {
    if (sheetOpen) {
      focusBack.current = document.activeElement as HTMLElement | null
      requestAnimationFrame(() => (rootRef.current?.querySelector('.tre-sheet input:not(:disabled), .tre-sheet button, .twrp-sheet button') as HTMLElement | null)?.focus())
    } else if (focusBack.current) { focusBack.current.focus?.(); focusBack.current = null }
  }, [sheetOpen])

  // A word or slide-start drag in progress: its listeners, so they can be removed if the words change under it.
  const dragCleanup = useRef<(() => void) | null>(null)
  // When the words (or their timing) change, indices from the old words mean other words: clear the
  // selection, close popovers and stop any drag. Operations already queued hold times and stay.
  const lastCtx = useRef(ctx)
  useEffect(() => {
    if (lastCtx.current === ctx) return
    lastCtx.current = ctx
    dragCleanup.current?.(); dragCleanup.current = null
    setSel(null); setPop(null); setDrag(null); setChoose(null)
  }, [ctx])

  // ---- Pointer: select words by drag and shift-click; click a word to seek ------------------------------
  const wordFromPoint = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-w]') as HTMLElement | null
    return el ? Number(el.dataset.w) : null
  }
  const onListPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, .tre-pop, .tre-handle')) return
    const cutEl = target.closest('[data-cut]') as HTMLElement | null
    if (cutEl) { e.preventDefault(); setSel(null); setPop({ kind: 'cut', cut: Number(cutEl.dataset.cut) }); return }
    const w = target.closest('[data-w]') ? Number((target.closest('[data-w]') as HTMLElement).dataset.w) : null
    if (w === null) { setPop(null); return }
    e.preventDefault()
    if (choose !== null) {
      const row = rows[choose]
      if (row && w > rows[choose - 1].firstWord && w < row.endWord) { edit(moveBoundaryOp(ctx, row, w, true)); setChoose(null) }
      return
    }
    setPop(null)
    if (e.shiftKey && sel) { setSel({ anchor: sel.anchor, focus: w }); setPop({ kind: 'selection' }); return }
    setSel({ anchor: w, focus: w })
    let moved = false, last = w
    const move = (ev: PointerEvent): void => {
      const over = wordFromPoint(ev.clientX, ev.clientY)
      if (over !== null && over !== w) moved = true
      if (over !== null) { last = over; setSel((s) => (s ? { anchor: s.anchor, focus: over } : s)) }
    }
    const stop = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    dragCleanup.current = stop
    const up = (): void => {
      stop(); dragCleanup.current = null
      // The playhead goes to the selection (so its row is the current one and Play starts there).
      const at = ctx.words[moved ? Math.min(w, last) : w]
      if (!player.current?.playing() && at.timed) player.current?.seekRun(at.start)
      setPop({ kind: 'selection' })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // Dragging a slide's start: snaps to clear pauses and sentence starts (blue bars); with Option any word.
  const startBoundaryDrag = (rowIndex: number) => (e: React.PointerEvent): void => {
    e.preventDefault(); e.stopPropagation()
    const row = rows[rowIndex]
    const list = listRef.current
    if (!row || !list) return
    const pick = (ev: PointerEvent | React.PointerEvent): Drag => {
      const any = ev.altKey
      const targets = boundaryTargets(ctx, rows, rowIndex, any)
      const over = wordFromPoint(ev.clientX, ev.clientY)
      const box = list.getBoundingClientRect()
      const at = { x: ev.clientX - box.left + list.scrollLeft, y: ev.clientY - box.top + list.scrollTop }
      if (!targets.length) return { row: rowIndex, word: row.firstWord, any, ...at }
      const want = over ?? row.firstWord
      let best = targets[0]
      for (const t of targets) if (Math.abs(t.word - want) < Math.abs(best.word - want)) best = t
      return { row: rowIndex, word: best.word, any, ...at }
    }
    setDrag(pick(e))
    const move = (ev: PointerEvent): void => setDrag(pick(ev))
    const stop = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    dragCleanup.current = stop
    const up = (ev: PointerEvent): void => {
      stop(); dragCleanup.current = null
      const d = pick(ev)
      setDrag(null)
      if (d && d.word !== row.firstWord) edit(moveBoundaryOp(ctx, row, d.word, d.any))
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  // ---- Popover placement ------------------------------------------------------------------------------
  useLayoutEffect(() => {
    const list = listRef.current
    if (!pop || !list) { setPopAt(null); return }
    let anchor: Element | null = null
    if (pop.kind === 'selection' && range) anchor = list.querySelector(`[data-w="${range[1]}"]`)
    if (pop.kind === 'cut') anchor = list.querySelector(`[data-close="${pop.cut}"]`) ?? list.querySelector(`[data-cut="${pop.cut}"]`)
    if (!anchor) { setPopAt(null); return }
    const a = anchor.getBoundingClientRect(), box = list.getBoundingClientRect()
    const left = Math.max(8, Math.min(box.width - 380, a.left - box.left - 40))
    const below = a.bottom - box.top + list.scrollTop + 10
    const next = { left, top: below, up: false, arrow: Math.max(14, Math.min(340, a.left - box.left - left + Math.min(a.width, 40) / 2)) }
    setPopAt((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.arrow === next.arrow ? cur : next))
  }, [pop, range, edits, rows])
  // Keep the popover inside the list: measured once it is drawn.
  useLayoutEffect(() => {
    const el = popRef.current, list = listRef.current
    if (!el || !list || !popAt) return
    const room = list.clientWidth - 10
    if (popAt.left + el.offsetWidth > room) {
      const left = Math.max(8, room - el.offsetWidth)
      setPopAt({ ...popAt, left, arrow: Math.max(14, popAt.arrow + popAt.left - left) })
    }
  }, [popAt])

  // ---- States of the words ---------------------------------------------------------------------------
  const modelNote = writing.note?.match(/Preparing this Mac's speech model:?\s*(\d+)%/)
  const hasWords = n > 0
  const state: 'ready' | 'writing' | 'writing-model' | 'nowords' = hasWords ? 'ready' : writing.busy ? (modelNote ? 'writing-model' : 'writing') : 'nowords'
  const language = (transcript?.locale ?? '').split(/[-_]/)[0].toLowerCase()
  const model = models.find((m) => m.language === language) ?? null
  const offer = hasWords && !transcript?.alignment && model && (model.state === 'absent' || model.state === 'failed' || model.state === 'downloading') ? model : null
  const mb = (b?: number): string => (b ? `${Math.round(b / 1e6)} MB` : '')
  const downloadOffer = (): void => { if (offer) void window.tw.alignment.download(offer.language).then(() => window.tw.alignment.run(run.talkSlug, run.id, home)).catch(() => {}) }

  // ---- To check (recomputed only when what it lists changes, not on every frame) ------------------------
  type Check = { id: string; kind: 'flag' | 'close' | 'boundary' | 'timing'; title: string; sub: string; go?: () => void; action?: ReactNode }
  const checks = useMemo((): Check[] => {
    const out: Check[] = []
    if (!hasWords) return out
    for (const m of run.slideTimeIndex ?? []) {
      if (m.event !== 'flag') continue
      const r = rows[rowAtMs(m.tMs)]
      const marked = markedStretch(ctx, m.tMs)
      const isCut = marked ? coveredMs(cuts, marked.range) * 2 >= marked.range.end - marked.range.start : false
      const slideN = r ? slides[r.slideId]?.n ?? r.index + 1 : 1
      out.push({ id: `flag:${m.tMs}`, kind: 'flag', title: `You marked a mistake on slide ${slideN}`, sub: isCut && marked ? `Cut: ${plural(marked.lastWord + 1 - marked.firstWord, 'word')} before the mark` : `“${marked ? quoteWords(ctx, Math.max(marked.firstWord, marked.lastWord - 5), marked.lastWord + 1) : ''}” · ${clock(planRunToEdited(spans, toVideoClock(resolved.clock, m.tMs)))}`, go: () => { goToRow(r?.index ?? 0, false); player.current?.seekRun(Math.max(0, m.tMs - 3000)) } })
    }
    views.forEach((v, i) => {
      if (!v.close || kept.has(`${v.start}-${v.end}`)) return
      const r = rows[rowAtMs(v.start)]
      out.push({ id: `close:${v.start}`, kind: 'close', title: `A cut on slide ${r ? slides[r.slideId]?.n ?? r.index + 1 : 1} is close to a word`, sub: 'Listen to the join before you export', go: () => { goToRow(r?.index ?? 0, false); setSel(null); setPop({ kind: 'cut', cut: i }) } })
    })
    for (const r of rows) if (r.noClearPause && !leftOutRows.has(r.index)) {
      const sn = slides[r.slideId]?.n ?? r.index + 1
      const sub = r.sentenceNear === null ? 'Choose the word where it starts' : r.sentenceNear === r.firstWord ? 'It starts at a sentence start; listen to check it' : 'A sentence starts nearby; choose where it starts'
      out.push({ id: `boundary:${r.change}`, kind: 'boundary', title: `Slide ${sn} has no clear pause where it starts`, sub, go: () => { goToRow(r.index, false); setChoose(r.index) } })
    }
    // A slide left out, or played from a new take, whose stretch starts or ends at a sentence start rather
    // than a clear pause: the join falls inside speech, so it is listed to listen to.
    for (const i of joinsAtSentence(rows, leftOutRows, resolved.replacedRows)) {
      const r = rows[i]
      const sn = slides[r.slideId]?.n ?? r.index + 1
      out.push({ id: `sentence:${r.change}`, kind: 'close', title: leftOutRows.has(i) ? `Slide ${sn} is left out at a sentence start` : `Slide ${sn}'s new take goes in at a sentence start`, sub: 'There is no clear pause there; listen to the join before you export', go: () => goToRow(r.index, false) })
    }
    if (offer) out.unshift({ id: 'timing', kind: 'timing', title: 'Cuts in this recording snap to pauses', sub: `With precise word timing for ${offer.label}, you can cut cleanly between any two words. One download, kept on this Mac.`,
      action: offer.state === 'downloading' ? <span className="tre-quiet"><Loader2 className="lt-icon spin" /> Downloading… {offer.received && offer.bytes ? `${Math.round((100 * offer.received) / offer.bytes)}%` : ''}</span>
        : <button className="tw-btn tw-btn--sm" onClick={downloadOffer}><Download className="lt-icon" /> Download for {offer.label}{offer.bytes ? ` (${mb(offer.bytes)})` : ''}</button> })
    return out
    // downloadOffer and goToRow change with the Run and rows only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWords, run.slideTimeIndex, rows, ctx, cuts, views, kept, slides, spans, offer, rowAtMs, leftOutRows, resolved.clock, resolved.replacedRows])

  // ---- Render -----------------------------------------------------------------------------------------
  const problem = edits?.problem ?? null
  const audioOnly = !!opened && opened.slides.length === 0
  const exportCtl = useRecordingExport({
    runRef, title: run.talkTitle, slides, audioOnly, hasCamera: !!opened?.hasCamera, camera, editedMs,
    chapterCount: audioOnly ? 0 : chaptersFor(resolved.chapterMarks, slides, spans).length, hasCaptionText: !!transcript?.segments?.length, captionNote: resolved.takesWithoutWords ? (resolved.takesWithoutWords === 1 ? 'The new take in this video has no words written out yet, so that part has no captions.' : `${resolved.takesWithoutWords} new takes in this video have no words written out yet, so those parts have no captions.`) : null, settle, onStale: refresh, withoutWords, setWithoutWords
  })
  const exportOpen = exportCtl.exporting.state !== 'closed' && !(exportCtl.exporting.state === 'working' && exportCtl.exporting.hidden)
  exportState.current = { open: exportOpen, close: () => { const x = exportCtl.exporting; if (x.state === 'working') exportCtl.setExporting({ ...x, hidden: true }); else exportCtl.setExporting({ state: 'closed' }) } }
  useEffect(() => {
    if (exportOpen) { focusBack.current = document.activeElement as HTMLElement | null; requestAnimationFrame(() => (rootRef.current?.querySelector('.twrp-sheet button') as HTMLElement | null)?.focus()) }
    else if (focusBack.current && !sheetOpen) { focusBack.current.focus?.(); focusBack.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportOpen])
  const when = (() => {
    const d = new Date(run.startedAt)
    if (isNaN(d.getTime())) return ''
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return new Date().toDateString() === d.toDateString() ? `recorded today, ${hm}` : `recorded ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hm}`
  })()
  const curRow = rows[currentRow]
  const curSlide = curRow ? slides[curRow.slideId] : undefined
  const slideCount = Object.keys(slides).length || rows.length

  return (
    <div className="tre lt" ref={rootRef} data-recording-editor data-state={state} data-edits-revision={edits?.edits.revision ?? -1}>
      <header className="tw-tools-bar tre-bar">
        <button className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Back to the recording" title="Back to the recording (Esc)" onClick={() => void leave()}><ChevronLeft className="lt-icon" /></button>
        <h2>Studio</h2>
        <span className="tre-what" title={run.talkTitle}>{run.talkTitle}{when ? ` · ${when}` : ''}</span>
        <span className="tre-sp" />
        <button className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Undo" title="Undo (⌘Z)" disabled={!!problem || !edits?.edits.undo.length} onClick={() => edit({ kind: 'undo' })}><Undo2 className="lt-icon" /></button>
        <button className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!!problem || !edits?.edits.redo.length} onClick={() => edit({ kind: 'redo' })}><Redo2 className="lt-icon" /></button>
        <span className="tre-sep" />
        <button className="tw-btn" disabled={!hasWords || !!problem} onClick={() => { setPop(null); setTidyOpen(true) }}><ListChecks className="lt-icon" /> Tidy up…</button>
        <button className="tw-btn" disabled={!opened || !!problem} onClick={() => { setPop(null); setLookOpen(true) }}><SlidersHorizontal className="lt-icon" /> Look and sound…</button>
        <span className="tre-len" data-edited-ms={Math.round(editedMs)} title="Length of the video / of the recording">{cuts.length ? <><b>{clock(editedMs)}</b> of {clock(durationMs)}</> : <b>{clock(durationMs)}</b>}</span>
        <button className="tw-btn tw-btn--primary" disabled={!opened || !!problem || exportCtl.exporting.state === 'working'} onClick={() => void exportCtl.open()}><Download className="lt-icon" /> {exportCtl.exporting.state === 'working' ? `Exporting ${Math.round(exportCtl.exporting.fraction * 100)}%` : 'Export…'}</button>
        <span className="tre-sep" />
        <button className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Open settings for Studio" title="Open settings for Studio" onClick={onSettings}><Settings className="lt-icon" /></button>
        <button className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Keyboard cheat-sheet" title="Keyboard cheat-sheet (?)" onClick={onHelp}>?</button>
      </header>

      <div className="tre-work">
        <div className="tre-list" ref={listRef} onPointerDown={onListPointerDown} data-choosing={choose !== null ? 'yes' : undefined}>
          {openError ? <div className="tre-note warn" role="alert"><AlertTriangle className="lt-icon" /><span className="tre-grow">{openError}</span></div> : null}
          {problem ? (
            <div className="tre-note warn" role="alert"><AlertTriangle className="lt-icon" /><span className="tre-grow">{problem.message} It is kept unchanged.</span>
              <button className="tw-btn tw-btn--sm" onClick={() => void window.tw.recordingVideo.startFresh(runRef).then((r) => { if (r.ok) { confirmed.current = r.edits; shown.current = r.edits; setEdits(r.edits) } else setEditError(r.error) })}>Start new edits</button></div>
          ) : null}
          {retakeNote ? <div className={`tre-note${retakeNote.warn ? ' warn' : ''}`} role="status"><CircleDot className="lt-icon tre-rec-ico" /><span className="tre-grow">{retakeNote.text}</span><button className="tw-btn tw-btn--quiet tw-btn--icon tw-btn--sm" aria-label="Dismiss" onClick={() => setRetakeNote(null)}><X className="lt-icon" /></button></div> : null}
          {editError ? <div className="tre-note warn" role="alert"><AlertTriangle className="lt-icon" /><span className="tre-grow">{editError}</span><button className="tw-btn tw-btn--quiet tw-btn--icon tw-btn--sm" aria-label="Dismiss" onClick={() => { setEditError(null); saveFailed.current = null }} title="The edit was not saved; what you see is what is saved"><X className="lt-icon" /></button></div> : null}
          {state === 'writing' ? (
            <div className="tre-note tre-progress-note" role="status"><Loader2 className="lt-icon spin" /><div className="tre-grow"><div><b>Writing out your words</b> · about a minute</div><div className="tre-progress indeterminate"><i /></div></div><button className="tw-btn tw-btn--quiet tw-btn--sm" onClick={onStopWriting}>Stop</button></div>
          ) : state === 'writing-model' ? (
            <div className="tre-note tre-progress-note" role="status"><Download className="lt-icon" /><div className="tre-grow"><div><b>Preparing this Mac's speech model</b> · a one-time download by macOS, then your words are written out</div><div className="tre-progress"><i style={{ width: `${Number(modelNote?.[1] ?? 0)}%` }} /></div></div><button className="tw-btn tw-btn--quiet tw-btn--sm" onClick={onStopWriting}>Stop</button></div>
          ) : withoutWords ? (
            <div className="tre-note warn" role="status"><AlertTriangle className="lt-icon" /><span className="tre-grow"><b>Shown without words, as it will be exported.</b> The words for this recording could not be read, so the video follows the slides and cuts without them, and has no captions.</span></div>
          ) : state === 'nowords' ? (
            <div className="tre-note warn" role="status"><AlertTriangle className="lt-icon" /><span className="tre-grow"><b>Your words could not be written out.</b> {writing.error ? writing.error.replace(/^Words could not be written out:\s*/, '') : transcript ? 'This transcript has no word timings.' : 'They have not been written out yet.'} You can still leave slides out and export.</span>
              <button className="tw-btn tw-btn--sm" onClick={() => onWriteOut()}><RefreshCw className="lt-icon" /> Try again</button>
              {parakeetReady ? <button className="tw-btn tw-btn--sm" onClick={() => onWriteOut('parakeet')}>Write out with Parakeet</button> : null}</div>
          ) : null}

          {rows.map((row) => (
            <RowView key={`${row.index}:${row.change}`} row={row} rc={rowCtx} state={state} on={row.index === currentRow}
              leftOut={leftOutRows.has(row.index)} keptMs={resolved.replacedRows.has(row.index) ? takes.find((t) => t.change === row.change)?.durationMs ?? 0 : Math.max(0, row.end - row.start - coveredMs(cuts, row))}
              selA={range && range[1] >= row.firstWord && range[0] < Math.max(row.endWord, row.firstWord + 1) ? range[0] : -1} selB={range ? range[1] : -1}
              drag={drag && (drag.row === row.index || drag.row === row.index + 1) ? drag : null} choosing={choose === row.index || choose === row.index + 1}
              faceText={faceLabel(opened?.hasCamera && camera ? faceOf(faces, row.change) : withoutCamera(faceOf(faces, row.change)))} onFace={opened && opened.slides.length ? () => { setPop(null); setFaceRow(row.index) } : undefined}
              onLeaveOut={() => leaveOut(row)} onPutBack={() => edit(putBackOp(row))}
              onPutBoundaryBack={() => edit(putBoundaryBackOp(row))} onChoose={() => setChoose(row.index)} onDragStart={startBoundaryDrag(row.index)}
              onSentence={() => { if (row.sentenceNear !== null) edit(moveBoundaryOp(ctx, row, row.sentenceNear, false)) }}
              onRestore={(c) => edit(restoreOp(c))}
              onRetake={onRecordSlideAgain && rowTakeControls(takesOn, { hasPicture: !!opened?.slides.length, slideId: row.slideId, leftOut: leftOutRows.has(row.index), takes: 0 }).recordAgain ? () => void recordAgain(row) : undefined}
              replacedMs={resolved.replacedRows.has(row.index) ? takes.find((t) => t.change === row.change)?.durationMs ?? 0 : -1}
              replacedWords={resolved.replacedRows.has(row.index) ? takes.find((t) => t.change === row.change)?.words?.map((w) => w.text).join(' ') ?? null : null}
              takesKey={takesKeyOf(row)} takesNode={takesNodeOf(row)} />
          ))}

          {drag ? <div className="tre-ghost" style={{ left: drag.x + 14, top: drag.y - 34 }}><GripVertical className="lt-icon" />Slide {slides[rows[drag.row].slideId]?.n ?? drag.row + 1} starts here<span className="tre-gsub" data-target-kind={ctx.gaps[drag.word] ? targetKind(ctx.gaps[drag.word]) : 'word'}>{targetText(ctx, drag.word)} · ⌥ any word</span></div> : null}

          {pop && popAt ? (
            <div className="tre-pop" ref={popRef} style={{ left: popAt.left, top: popAt.top, ['--arrow' as string]: `${popAt.arrow}px` }} onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={pop.kind === 'selection' ? 'Selected words' : 'Cut'}>
              {pop.kind === 'selection' && range ? <SelectionPop ctx={ctx} range={range} aligned={!!transcript?.alignment} offer={offer} offerLabel={offer ? `Download for ${offer.label}${offer.bytes ? ` (${mb(offer.bytes)})` : ''}` : ''} onOffer={downloadOffer} onCut={cutSelection} onPlay={playSelection} />
                : pop.kind === 'cut' && views[pop.cut] ? <CutPop view={views[pop.cut]} ctx={ctx} registerPlay={(fn) => { cutPopRef.current = { playJoin: fn } }}
                  onPlay={() => playJoin(views[pop.cut])} onKeep={() => { setKept((k) => new Set(k).add(`${views[pop.cut].start}-${views[pop.cut].end}`)); setPop(null) }}
                  onRestore={() => { const r = views[pop.cut].restore; if (r) edit(restoreOp(r)); setPop(null) }} onMove={(op) => { edit(op); setPop(null) }} /> : null}
            </div>
          ) : null}
        </div>

        <aside className="tre-side">
          <div className="tre-player">
            {composed.source ? <LayeredPlayer ref={player} source={composed.source} spans={playSpans} durationMs={resolved.clockMs} clock={resolved.clock} camera={camera} dissolve={finish.smoothJoins} faces={clockTrack} notice={composed.problem ?? missingTakeNotice(missingTakes) ?? (composed.pending ? 'Preparing the new take…' : null)} onTime={onTime} onPlaying={onPlaying} />
              : <div className="twrp-player"><div className="twrp-frame twrp-wait">{preparing ? <><Loader2 className="lt-icon spin" /> Preparing playback…</> : null}</div></div>}
          </div>
          <div className="tre-transport">
            <button className="tre-playbtn" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!source} onClick={() => player.current?.toggle()}>{playing ? <Pause className="lt-icon" /> : <Play className="lt-icon" />}</button>
            <button className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Back five seconds" title="Back five seconds" disabled={!source} onClick={() => player.current?.seekVideo(planEditedToRun(spans, Math.max(0, planRunToEdited(spans, videoMs) - 5000)))}><RotateCcw className="lt-icon" /></button>
            <span className="tre-time" aria-live="off"><b>{clock(planRunToEdited(spans, videoMs))}</b> <span>/ {clock(editedMs)}</span></span>
            <span className="tre-sp" />
            <span className="tre-where">{curSlide ? `Slide ${curSlide.n} of ${slideCount}` : ''}</span>
          </div>
          {wordsNote ? <div className="tre-quiet tre-words-note" role="status">The words were updated; the cuts follow them.</div> : null}
          {checks.length ? (
            <section className="tre-panel" aria-label="To check">
              <header><h3>To check</h3><span className="tre-count">{checks.length}</span></header>
              <div className="tre-checks">
                {checks.map((c) => (
                  <div key={c.id} className={`tre-check ${c.kind}${focusCheck === c.id ? ' on' : ''}`}>
                    {c.kind === 'flag' ? <Flag className="lt-icon" /> : c.kind === 'close' ? <Ear className="lt-icon" /> : c.kind === 'boundary' ? <AlertTriangle className="lt-icon" /> : <AudioLines className="lt-icon" />}
                    <div className="tre-grow"><div>{c.title}</div><div className="tre-subtle">{c.sub}</div>{c.action ? <div className="tre-check-act">{c.action}</div> : null}</div>
                    {c.go ? <button className="tre-go" onClick={() => { setFocusCheck(c.id); c.go?.() }}>Go to</button> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      <footer className="tre-foot">
        {timeline ? (
          <Timeline rows={rows} leftOut={leftOutRows} slides={slides} durationMs={durationMs} editedMs={editedMs} cuts={views} ctx={ctx} runMs={runMs} range={range} marks={run.slideTimeIndex ?? []}
            hasCamera={!!opened?.hasCamera && camera} cameraClips={source?.camera ?? []} faces={track} currentRow={currentRow} curSlideN={curSlide?.n}
            onSeek={(t) => player.current?.seekRun(t)} onSelect={(a, b) => { setSel({ anchor: a, focus: b }); setPop(null); listRef.current?.querySelector(`[data-w="${a}"]`)?.scrollIntoView({ block: 'center' }) }}
            onCut={cutSelection} onPlay={playSelection} onClose={() => setTimeline(false)} />
        ) : (
          <div className="tre-strip">
            <button className="tw-btn tw-btn--sm" onClick={() => setTimeline(true)} aria-expanded={false}><ChevronUp className="lt-icon" /> Timeline</button>
            <Overview rows={rows} leftOut={leftOutRows} slides={slides} durationMs={durationMs} cuts={views} runMs={runMs} range={range ? wordsRange(ctx, range[0], range[1]) : null} marks={run.slideTimeIndex ?? []} currentRow={currentRow} onSeek={(t) => player.current?.seekRun(t)} />
            <span className="tre-tot">{clock(editedMs)}</span>
          </div>
        )}
      </footer>

      {tidyOpen && tidy ? <TidySheet tidy={tidy} ctx={ctx} rows={rows} slides={slides} onClose={() => setTidyOpen(false)}
        onPlay={(p) => playJoin(p.range, [p.range])} onApply={(ranges) => { if (edit({ kind: 'cut', ranges })) setTidyOpen(false) }} /> : null}
      {faceRow !== null && rows[faceRow] ? <FacePositionSheet row={{ index: faceRow, change: rows[faceRow].change, n: slides[rows[faceRow].slideId]?.n ?? faceRow + 1 }}
        rows={rows.filter((r) => !leftOutRows.has(r.index)).map((r) => ({ index: r.index, change: r.change, n: slides[r.slideId]?.n ?? r.index + 1 }))}
        faces={faces} hasCamera={!!opened?.hasCamera} cameraOn={camera} disabled={!!problem}
        onApply={(changes, face) => edit({ kind: 'face', changes, face })} onClose={() => setFaceRow(null)} /> : null}
      {lookOpen ? <LookAndSoundSheet finish={finish} hasVoice={source ? !!source.voice : true} evening={even.evening} evenError={even.error} disabled={!!problem}
        onChange={(f) => edit({ kind: 'finish', finish: f })} onClose={() => setLookOpen(false)} /> : null}
      {exportCtl.sheet}
    </div>
  )
}

const EMPTY: TimeRange[] = []
const EMPTY_B: import('../../../../shared/recording-edits').EditBoundary[] = []
const EMPTY_N: number[] = []
const EMPTY_FACES = emptyFaces()
const EMPTY_TAKES: import('../../../../shared/recording-edits').ChosenTake[] = []

// ---- One slide row --------------------------------------------------------------------------------------

type RowProps = {
  row: EditorRow; rc: RowCtx; state: string; on: boolean; leftOut: boolean; keptMs: number; selA: number; selB: number
  drag: Drag; choosing: boolean
  /** The face control's words ("Face: corner"); the control is there when the Run has a picture. */
  faceText: string; onFace?: () => void
  /** Record this slide again (absent: not offered); the row plays a new take (its length) or not (-1); the takes panel. */
  onRetake?: () => void; replacedMs: number; takesKey: string; takesNode: ReactNode
  /** The words of the take in the video (its own transcript), or null while they are being written out. */
  replacedWords?: string | null
  onLeaveOut: () => void; onPutBack: () => void; onPutBoundaryBack: () => void; onChoose: () => void; onSentence: () => void; onDragStart: (e: React.PointerEvent) => void; onRestore: (c: TimeRange) => void
}
/** A row re-renders only when something it shows changed (its words, cuts in it, the selection in it). */
const RowView = memo(function RowView({ row, rc, state, on, leftOut, keptMs, selA, selB, drag, choosing, faceText, onFace, onRetake, replacedMs, replacedWords, takesNode, onLeaveOut, onPutBack, onPutBoundaryBack, onChoose, onSentence, onDragStart, onRestore }: RowProps) {
  const { ctx, slides } = rc
  const slide = slides[row.slideId]
  const n = slide?.n ?? row.index + 1
  const title = slide?.title ?? 'Slide'
  const span = Math.max(1, row.end - row.start)
  if (leftOut) return (
    <div className="tre-leftout" data-row={row.index}>
      <span className="tre-n">{n}</span>
      <div className="tre-thumb">{slide?.thumbUrl ? <img src={slide.thumbUrl} alt="" /> : null}</div>
      <div className="tre-lo-t"><b>{title}</b><span>Left out of the video · {clock(row.end - row.start)} of words and picture</span></div>
      <button className="tw-btn tw-btn--sm" onClick={onPutBack}><RotateCcw className="lt-icon" /> Put this slide back</button>
    </div>
  )
  // The slide-start handle: in the words when moved or being dragged; otherwise it appears over the row's
  // top edge on hover (no shift of the words), as the mockup shows no handle at rest.
  const marker = row.index > 0 && state === 'ready'
  const markerInFlow = marker && (!!row.moved || drag?.row === row.index)
  return (
    <div className={`tre-row${on ? ' on' : ''}`} data-row={row.index} data-slide={row.slideId}>
      <span className="tre-n">{n}</span>
      <div className="tre-thumbcol">
        <div className="tre-thumb">{slide?.thumbUrl ? <img src={slide.thumbUrl} alt="" loading="lazy" /> : null}</div>
        {row.steps.length ? <div className="tre-steps">{row.steps.map((s, i) => <i key={i} style={{ left: `${Math.max(0, Math.min(98, (100 * (s.tMs - row.start)) / span))}%` }} />)}</div> : null}
        <div className="tre-tmeta"><b>{clock(keptMs)}</b>{row.steps.length ? <span>· {plural(row.steps.length, 'step')}</span> : null}</div>
      </div>
      <div className="tre-wcol">
        {marker ? (
          <div className={`tre-marker${markerInFlow ? '' : ' floating'}`}>
            <span className="tre-handle" role="slider" aria-label={`Where slide ${n} starts`} aria-valuenow={row.firstWord} tabIndex={0} onPointerDown={onDragStart} title={`Drag to move where this slide starts; it snaps to clear pauses${ctx.sentences ? ' and sentence starts' : ''}. Hold Option for any word.`}>
              <GripVertical className="lt-icon" /> Slide {n} starts here
            </span>
            {row.moved ? <><span className="tre-moved">Moved</span><button className="tw-btn tw-btn--text" onClick={onPutBoundaryBack}>Put back</button></> : null}
            {markerInFlow ? <span className="tre-rule" /> : null}
          </div>
        ) : null}
        <div className="tre-stitle">{title}</div>
        {row.noClearPause && state === 'ready' ? (
          <div className="tre-inrow" {...(row.sentenceNear !== null ? { 'data-sentence-near': row.sentenceNear } : {})}><AlertTriangle className="lt-icon" /><span className="tre-grow">No clear pause within two seconds of this slide change. {row.sentenceNear === null ? `Choose the word where slide ${n} starts.`
              : row.sentenceNear === row.firstWord ? `Slide ${n} starts at a sentence start; listen to check it.`
              : `A sentence starts at “${quoteWords(ctx, row.sentenceNear, Math.min(ctx.words.length, row.sentenceNear + 3), 3)}…”.`}</span>
            {row.sentenceNear !== null && row.sentenceNear !== row.firstWord ? <button className="tw-btn tw-btn--sm" data-start-at-sentence onClick={onSentence}>Start at the sentence</button> : null}
            <button className="tw-btn tw-btn--sm" aria-pressed={choosing} onClick={onChoose}><TextCursorInput className="lt-icon" /> {choosing ? 'Click a word' : 'Choose the word'}</button></div>
        ) : null}
        {replacedMs >= 0 ? <>
          <div className="tre-waiting tre-replaced"><CircleDot className="lt-icon tre-rec-ico" /> This slide plays its new take ({clock(replacedMs)}). The first take and its words are kept.</div>
          {replacedWords ? <div className="tre-words tre-take-words" data-take-words>{replacedWords}</div>
            : <div className="tre-waiting" data-take-words-pending><Clock className="lt-icon" /> The new take's words are not written out yet, so this slide has no captions.</div>}
        </>
          : state === 'ready' ? <Words row={row} rc={rc} selA={selA} selB={selB} drag={drag} choosing={choosing} onRestore={onRestore} />
          : state === 'nowords' ? <div className="tre-waiting"><MessageSquareOff className="lt-icon" /> No words for this slide.</div>
          : <><div className="tre-waiting">{state === 'writing' ? <><Loader2 className="lt-icon spin" /> Writing out the words on this slide</> : <><Clock className="lt-icon" /> Waiting for words</>}</div><div className="tre-skel"><i style={{ width: '82%' }} /><i style={{ width: '74%' }} /><i style={{ width: '51%' }} /></div></>}
        {takesNode}
        <div className="tre-acts">
          {onFace ? <button className="tw-btn tw-btn--sm" data-face-control onClick={onFace} title="Choose where your face appears on this slide"><SquareUser className="lt-icon" /> {faceText}</button> : null}
          {onRetake ? <button className="tw-btn tw-btn--sm" data-record-again onClick={onRetake} title="Record what you say on this slide again; the rest of the video is kept"><CircleDot className="lt-icon tre-rec-ico" /> Record this slide again</button> : null}
          <button className="tw-btn tw-btn--sm" onClick={onLeaveOut} title="Leave this slide's words and picture out of the video"><EyeOff className="lt-icon" /> Leave this slide out</button>
        </div>
      </div>
    </div>
  )
}, (a, b) => a.row === b.row && a.rc === b.rc && a.state === b.state && a.on === b.on && a.leftOut === b.leftOut && a.keptMs === b.keptMs && a.selA === b.selA && (a.selA < 0 || a.selB === b.selB) && a.drag === b.drag && a.choosing === b.choosing && a.faceText === b.faceText && !!a.onFace === !!b.onFace && !!a.onRetake === !!b.onRetake && a.replacedMs === b.replacedMs && a.replacedWords === b.replacedWords && a.takesKey === b.takesKey)

/** The row's words with its marks: pauses of a second or more, steps, the real click, flags, cuts. */
/** A row's words with its marks (pauses, sentence starts, where the picture changed, steps, cuts); exported for the DOM test. */
export function Words({ row, rc, selA, selB, drag, choosing, onRestore }: { row: EditorRow; rc: RowCtx; selA: number; selB: number; drag: Drag; choosing: boolean; onRestore: (c: TimeRange) => void }): ReactNode {
  const { ctx, cuts, byWord, flagsAfter, stepsBefore, clickBefore } = rc
  const out: ReactNode[] = []
  const last = ctx.words.length
  const snapTargets = drag ? new Set(boundaryTargets(ctx, rc.rows, drag.row, drag.any).map((t) => t.word)) : null
  const pauseChip = (g: number): boolean => {
    const gap = ctx.gaps[g]
    if (!gap?.pause || gap.pauseMs < EDITOR_THRESHOLDS.pauseMarkerMs) return false
    const covered = coveredMs(cuts, gap.pause)
    const keptP = gap.pauseMs - covered
    const lead = g === 0 ? ' before your first word' : g === last ? ' after your last word' : ''
    const cutIdx = covered > 0 ? cuts.findIndex((c) => c.start < gap.pause!.end && c.end > gap.pause!.start) : -1
    out.push(
      <span key={`p${g}`} className={`tre-pz${gap.pauseMs >= 2000 ? ' long' : ''}${covered > 0 ? ' short' : ''}`} {...(cutIdx >= 0 ? { 'data-cut': cutIdx } : {})} title={covered > 0 ? 'A pause you shortened. Click to put it back.' : `A pause of ${secs(gap.pauseMs)}`}>
        {covered > 0 && keptP <= 0 ? <Scissors className="lt-icon" /> : <Pause className="lt-icon" />}
        {covered > 0 ? (keptP > 0 ? <><s>{(gap.pauseMs / 1000).toFixed(1)}</s> → {secs(keptP)}</> : <s>{secs(gap.pauseMs)}{lead}</s>) : <>{secs(gap.pauseMs)}{lead}</>}
      </span>
    )
    return true
  }
  if (row.index === 0) pauseChip(0)
  for (let i = row.firstWord; i < row.endWord; i++) {
    // A sentence starts here (stored with the transcript): a thin mark, unless a pause or snap mark already shows the place.
    if (i > row.firstWord && !pauseChip(i) && ctx.gaps[i].sentence && !snapTargets?.has(i)) out.push(<span key={`b${i}`} className="tre-sb" data-sentence={i} aria-hidden="true" title="A sentence starts here" />)
    if (snapTargets?.has(i)) out.push(<span key={`s${i}`} className={`tre-snap${drag?.word === i ? ' hit' : ''}`} data-snap={i} data-snap-kind={targetKind(ctx.gaps[i])} />)
    const click = clickBefore.get(i)
    if (click) out.push(<span key={`c${i}`} className="tre-pic" title="Where the picture changed">{click.moved ? <span className="tre-picnote"><ImageIcon className="lt-icon" />picture changed</span> : null}</span>)
    const steps = stepsBefore.get(i)
    if (steps) for (const s of steps) out.push(<span key={`t${i}-${s}`} className="tre-tick" data-n={s} title={`Step ${s}`} />)
    const c = byWord[i]
    if (c >= 0) {
      const v = cuts[c]
      if (v.endWord - v.firstWord > EDITOR_THRESHOLDS.foldWords) {
        out.push(<span key={`f${i}`} className="tre-cutchip" data-cut={c}><Scissors className="lt-icon" />{plural(v.endWord - v.firstWord, 'word')} cut<button onClick={(e) => { e.stopPropagation(); onRestore(v) }}>Restore</button></span>)
        if (v.close) out.push(<CloseChip key={`k${i}`} c={c} />)
        // Skip the folded words (they may continue into the next row).
        const end = Math.min(v.endWord, row.endWord)
        for (let j = i; j < end; j++) { const f = flagsAfter.get(j); if (f) out.push(<FlagChip key={`g${j}`} />) }
        i = end - 1
        continue
      }
    }
    const inSel = selA >= 0 && i >= selA && i <= selB
    out.push(<span key={i} data-w={i} {...(c >= 0 ? { 'data-cut': c } : {})} className={`${c >= 0 ? 'tre-cut' : ''}${inSel ? ' tre-sel' : ''}${choosing ? ' tre-pickable' : ''}${ctx.words[i].timed ? '' : ' tre-untimed'}`} {...(ctx.words[i].timed ? {} : { title: 'Precise word timing could not place this word; it is cut only with a word next to it.' })}>{ctx.words[i].text}</span>)
    out.push(' ')
    if (c >= 0 && i === cuts[c].endWord - 1 && cuts[c].close) out.push(<CloseChip key={`k${i}`} c={c} />)
    if (flagsAfter.get(i)) out.push(<FlagChip key={`g${i}`} />)
  }
  // Cuts without words (a shortened pause is shown on its pause; a cut between words gets a close mark).
  if (row.index === rc.rows.length - 1) pauseChip(last)
  if (row.endWord === row.firstWord && !out.length) return <div className="tre-words dim">No words on this slide.</div>
  return <div className="tre-words">{out}</div>
}

/** What the place before word `w` is, for the drag label: "after a pause of 1.2 s", "at a sentence start", "on a word". */
function targetText(ctx: EditorWords, w: number): string {
  const g = ctx.gaps[w]
  if (!g) return TARGET_WORDS.word
  const kind = targetKind(g)
  if (kind === 'pause') return `${TARGET_WORDS.pause} of ${secs(g.pauseMs)}`
  return kind === 'sentence' && g.quality === 'close' ? `${TARGET_WORDS.sentence} · needs a listen` : TARGET_WORDS[kind]
}

function CloseChip({ c }: { c: number }): ReactNode {
  return <span className="tre-close" data-close={c} data-cut={c} title="This cut is close to a spoken word and may clip it."><Ear className="lt-icon" />Close cut</span>
}
function FlagChip(): ReactNode {
  return <span className="tre-flag" title="You marked a mistake here while recording"><Flag className="lt-icon" />Marked</span>
}

// ---- Popovers -------------------------------------------------------------------------------------------

function SelectionPop({ ctx, range, aligned, offer, offerLabel, onOffer, onCut, onPlay }: { ctx: EditorWords; range: [number, number]; aligned: boolean; offer: unknown; offerLabel: string; onOffer: () => void; onCut: () => void; onPlay: () => void }): ReactNode {
  const r = wordsRange(ctx, range[0], range[1])
  const close = edgeQuality(ctx, r.start, 'start') === 'close' || edgeQuality(ctx, r.end, 'end') === 'close'
  return <>
    <div className="tre-pop-row">
      <button className="tw-btn tw-btn--primary tw-btn--sm" onClick={onCut}><Scissors className="lt-icon" /> Cut</button>
      <button className="tw-btn tw-btn--sm" onClick={onPlay}><Play className="lt-icon" /> Play</button>
    </div>
    {close ? <div className="tre-say"><Ear className="lt-icon" /><span>No pause at {edgeQuality(ctx, r.start, 'start') === 'close' && edgeQuality(ctx, r.end, 'end') === 'close' ? 'either end' : 'this end'}, so this cut may clip a word.{!aligned && offer ? ' Precise word timing makes cuts like this clean.' : ''}</span></div> : null}
    {close && !aligned && offer ? <div className="tre-pop-row"><button className="tw-btn tw-btn--sm" onClick={onOffer}><Download className="lt-icon" /> {offerLabel}</button></div> : null}
    <div className="tre-hint"><span><kbd>⌫</kbd> cut</span><span><kbd>Space</kbd> play</span><span><kbd>⌘Z</kbd> undo</span><span>{plural(range[1] - range[0] + 1, 'word')}</span></div>
  </>
}

function CutPop({ view, ctx, registerPlay, onPlay, onKeep, onRestore, onMove }: { view: CutView; ctx: EditorWords; registerPlay: (fn: () => void) => void; onPlay: () => void; onKeep: () => void; onRestore: () => void; onMove: (op: EditOp) => void }): ReactNode {
  registerPlay(onPlay)
  const side: 'start' | 'end' = view.startQuality === 'close' ? 'start' : 'end'
  // Moves act on the saved cut that makes this stretch.
  const saved = view.restore ?? view
  const outward = view.close && view.restore ? nearestCleanEdge(ctx, saved, side, 'outward') : null
  const inward = view.close && view.restore ? nearestCleanEdge(ctx, saved, side, 'inward') : null
  const why = view.restore ? undefined : view.leftOut ? 'This is part of a slide left out: use Put this slide back.' : 'This was trimmed in Studio’s transcript; put it back there.'
  return <>
    {view.close ? <div className="tre-say">This cut is close to a spoken word and may clip it.</div> : <div className="tre-say">{view.endWord > view.firstWord ? `${plural(view.endWord - view.firstWord, 'word')} cut` : `${secs(view.end - view.start)} cut`}{ctx.aligned || view.startQuality === 'clean' ? ', at clean pauses.' : '.'}</div>}
    <div className="tre-menu">
      <button className="tre-mi" onClick={onPlay}><Play className="lt-icon" />Play across the join<kbd className="tre-k">Space</kbd></button>
      {view.close ? <div className="tre-mi tre-mi-split"><AudioLines className="lt-icon" /><span>Move to the nearest pause</span>
        <button className="tw-btn tw-btn--sm" disabled={!outward} onClick={() => outward && onMove(outward.op)} title={outward ? `Make the cut longer, to a pause at ${clock(outward.at)}` : 'No clear pause within five seconds'}><ChevronsLeftRight className="lt-icon" /> Outward</button>
        <button className="tw-btn tw-btn--sm" disabled={!inward} onClick={() => inward && onMove(inward.op)} title={inward ? `Make the cut shorter, to a pause at ${clock(inward.at)}` : 'No clear pause inside the cut'}><ChevronsRightLeft className="lt-icon" /> Inward</button></div> : null}
      <div className="tre-msep" />
      {view.close ? <button className="tre-mi" onClick={onKeep}><Check className="lt-icon" />Keep this cut</button> : null}
      <button className="tre-mi" disabled={!view.restore} onClick={onRestore} title={why}><RotateCcw className="lt-icon" />Put the words back</button>
    </div>
  </>
}

// ---- Overview strip and timeline ------------------------------------------------------------------------

function Overview({ rows, leftOut, slides, durationMs, cuts, runMs, range, marks, currentRow, onSeek }: { rows: EditorRow[]; leftOut: Set<number>; slides: Record<string, EditorSlide>; durationMs: number; cuts: CutView[]; runMs: number; range: TimeRange | null; marks: RecordingSession['slideTimeIndex']; currentRow: number; onSeek: (t: number) => void }): ReactNode {
  const pct = (t: number): string => `${((100 * t) / Math.max(1, durationMs)).toFixed(3)}%`
  const track = useRef<HTMLDivElement>(null)
  const seek = (e: React.PointerEvent): void => {
    const go = (x: number): void => { const r = track.current?.getBoundingClientRect(); if (r?.width) onSeek(Math.max(0, Math.min(durationMs, ((x - r.left) / r.width) * durationMs))) }
    go(e.clientX)
    const move = (ev: PointerEvent): void => go(ev.clientX)
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return (
    <div className="tre-ovtrack" ref={track} onPointerDown={seek} data-testid="editor-overview">
      {rows.map((r) => <div key={r.index} className={`tre-seg${r.index === currentRow ? ' on' : ''}${leftOut.has(r.index) ? ' out' : ''}`} style={{ width: pct(r.end - r.start) }}>{slides[r.slideId]?.n ?? r.index + 1}</div>)}
      {cuts.map((c, i) => !rows.some((r) => r.start >= c.start && r.end <= c.end) ? <span key={`c${i}`} className="tre-mk cutr" style={{ left: pct(c.start), width: pct(c.end - c.start) }} /> : null)}
      {cuts.map((c, i) => c.close ? <span key={`k${i}`} className="tre-mk cl" style={{ left: pct(c.end) }} /> : null)}
      {marks.filter((m) => m.event === 'flag').map((m, i) => <span key={`f${i}`} className="tre-mk fl" style={{ left: pct(m.tMs) }} />)}
      {range ? <span className="tre-mk selr" style={{ left: pct(range.start), width: pct(range.end - range.start) }} /> : null}
      <span className="tre-mk ph" style={{ left: pct(runMs) }} />
    </div>
  )
}

function Timeline({ rows, leftOut, slides, durationMs, editedMs, cuts, ctx, runMs, range, marks, hasCamera, cameraClips, faces, currentRow, curSlideN, onSeek, onSelect, onCut, onPlay, onClose }: {
  rows: EditorRow[]; leftOut: Set<number>; slides: Record<string, EditorSlide>; durationMs: number; editedMs: number; cuts: CutView[]; ctx: EditorWords; runMs: number; range: [number, number] | null
  marks: RecordingSession['slideTimeIndex']; hasCamera: boolean; cameraClips: Array<{ startMs: number; endMs: number }>; faces: FaceSegment[]; currentRow: number; curSlideN?: number
  onSeek: (t: number) => void; onSelect: (a: number, b: number) => void; onCut: () => void; onPlay: () => void; onClose: () => void
}): ReactNode {
  const pct = (t: number): string => `${((100 * t) / Math.max(1, durationMs)).toFixed(3)}%`
  const tracks = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<TimeRange | null>(null)
  const timeAt = (x: number): number => { const r = tracks.current?.getBoundingClientRect(); return r?.width ? Math.max(0, Math.min(durationMs, ((x - r.left) / r.width) * durationMs)) : 0 }
  const scrub = (e: React.PointerEvent): void => {
    onSeek(timeAt(e.clientX))
    const move = (ev: PointerEvent): void => onSeek(timeAt(ev.clientX))
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  // Select on the voice and cuts tracks: the words whose middles fall inside become the selection.
  const latestCtx = useRef(ctx); latestCtx.current = ctx
  // The selection drag in progress, so it can be stopped at once when the words change under it.
  const stopSelecting = useRef<(() => void) | null>(null)
  useEffect(() => { stopSelecting.current?.() }, [ctx])
  useEffect(() => () => stopSelecting.current?.(), [])
  const select = (e: React.PointerEvent): void => {
    const started = ctx
    const from = timeAt(e.clientX)
    let to = from
    setDraft({ start: from, end: from })
    const move = (ev: PointerEvent): void => { to = timeAt(ev.clientX); setDraft({ start: Math.min(from, to), end: Math.max(from, to) }) }
    const stop = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); stopSelecting.current = null; setDraft(null) }
    stopSelecting.current = stop
    const up = (): void => {
      stop()
      const lo = Math.min(from, to), hi = Math.max(from, to)
      if (hi - lo < 50) { onSeek(lo); return }
      // Words that changed during the drag: their indices mean other words now; select nothing.
      if (latestCtx.current !== started) return
      let a = -1, b = -1
      for (let i = 0; i < ctx.words.length; i++) { const m = ctx.words[i].mid; if (m >= lo && m <= hi) { if (a < 0) a = i; b = i } }
      if (a >= 0) onSelect(a, b)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const step = durationMs > 3_600_000 ? 600_000 : durationMs > 1_200_000 ? 120_000 : durationMs > 300_000 ? 30_000 : durationMs > 60_000 ? 10_000 : 5000
  const ticks: number[] = []
  for (let t = step; t < durationMs; t += step) ticks.push(t)
  // Voice: how much of each slice is speech (measured silence removed).
  const bars = useMemo(() => {
    const N = 360, out: number[] = []
    for (let i = 0; i < N; i++) {
      const a = (i * durationMs) / N, b = ((i + 1) * durationMs) / N
      out.push(Math.max(0, 1 - coveredMs(ctx.silence, { start: a, end: b }) / Math.max(1, b - a)))
    }
    return out
  }, [ctx.silence, durationMs])
  const sel = range ? wordsRange(ctx, range[0], range[1]) : null
  const shownSel = draft ?? sel
  const selectedMs = sel ? sel.end - sel.start - coveredMs(cuts, sel) : 0
  return (
    <div className="tre-tl" data-testid="editor-timeline">
      <div className="tre-tlhead">
        <h3>Timeline</h3><span className="tre-quiet">{clock(runMs)}{curSlideN ? ` · slide ${curSlideN}` : ''}</span>
        <span className="tre-sp" />
        {sel ? <><span className="tre-quiet">Selected {clock(selectedMs)}</span><button className="tw-btn tw-btn--sm" onClick={onCut}><Scissors className="lt-icon" /> Cut</button><button className="tw-btn tw-btn--sm" onClick={onPlay}><Play className="lt-icon" /> Play</button><span className="tre-sep" /></> : null}
        <span className="tre-len"><b>{clock(editedMs)}</b> of {clock(durationMs)}</span>
        <button className="tw-btn tw-btn--quiet tw-btn--sm" onClick={onClose} aria-expanded={true}><ChevronDown className="lt-icon" /> Close</button>
      </div>
      <div className="tre-tlbody">
        <div className="tre-tllabels">
          <div style={{ height: 22 }} />
          <div className="slides"><Presentation className="lt-icon" />Slides</div>
          <div className="camtrk"><Video className="lt-icon" />Camera</div>
          <div className="voice"><AudioLines className="lt-icon" />Voice</div>
          <div className="cuts"><Scissors className="lt-icon" />Cuts</div>
        </div>
        <div className="tre-tltracks" ref={tracks}>
          <div className="tre-ruler" onPointerDown={scrub}>{ticks.map((t) => <span key={t} style={{ left: pct(t) }}>{clock(t)}</span>)}</div>
          <div className="tre-trk slides" onPointerDown={scrub}>
            {rows.map((r) => {
              const s = slides[r.slideId]
              return <div key={r.index} className={`tre-tblk${leftOut.has(r.index) ? ' out' : ''}${r.index === currentRow ? ' on' : ''}`} style={{ left: pct(r.start), width: pct(r.end - r.start) }} title={s?.title}>
                {s?.thumbUrl ? <img src={s.thumbUrl} alt="" /> : null}<b>{s?.n ?? r.index + 1}</b><span>{s?.title ?? ''}</span></div>
            })}
          </div>
          <div className="tre-trk camtrk" onPointerDown={scrub}>
            {hasCamera && cameraClips.length ? cameraClips.flatMap((c, i) => faces.filter((f) => f.end > c.startMs && f.start < c.endMs).map((f, j) => {
              const a = Math.max(c.startMs, f.start), b = Math.min(durationMs, c.endMs, f.end)
              const name = f.face.layout === 'corner' ? 'Corner' : f.face.layout === 'side' ? 'Side by side' : f.face.layout === 'face' ? 'Face only' : 'Hidden'
              return <div key={`${i}:${j}`} className={`tre-cblk${f.face.layout === 'slide' ? ' off' : ''}`} style={{ left: pct(a), width: pct(b - a) }}><Video className="lt-icon" />{name}</div>
            }))
              : <div className="tre-cblk" style={{ left: 0, width: '100%' }}>No camera</div>}
          </div>
          <div className="tre-trk voice" onPointerDown={select} title="Drag to select">
            <svg className="tre-wave" viewBox={`0 0 ${bars.length} 100`} preserveAspectRatio="none" aria-hidden="true">
              {bars.map((v, i) => <rect key={i} x={i + 0.15} width={0.7} y={50 - Math.max(2, v * 44)} height={Math.max(4, v * 88)} />)}
            </svg>
            {cuts.map((c, i) => <span key={i} className="tre-wave-cut" style={{ left: pct(c.start), width: pct(c.end - c.start) }} />)}
          </div>
          <div className="tre-trk cuts" onPointerDown={select}>
            {cuts.map((c, i) => <span key={i} className={`tre-cutmark ${c.close ? 'close' : 'clean'}`} style={{ left: pct(c.start), width: `max(18px, ${pct(c.end - c.start)})` }} title={c.close ? 'Close cut' : 'Cut'}>{c.close ? <><Ear className="lt-icon" />Close</> : <Scissors className="lt-icon" />}</span>)}
            {marks.filter((m) => m.event === 'flag').map((m, i) => <span key={`f${i}`} className="tre-cutmark flagm" style={{ left: pct(m.tMs) }}><Flag className="lt-icon" /></span>)}
          </div>
          {shownSel ? <span className="tre-tlsel" style={{ left: pct(shownSel.start), width: pct(shownSel.end - shownSel.start) }} /> : null}
          <span className="tre-tlph" style={{ left: pct(runMs) }} />
        </div>
      </div>
    </div>
  )
}

// ---- Tidy up ---------------------------------------------------------------------------------------------

const GROUPS: Array<{ kind: TidyKind; name: string }> = [
  { kind: 'marked', name: 'Marked while recording' },
  { kind: 'pauses', name: 'Long pauses' },
  { kind: 'repeats', name: 'Said twice' },
  { kind: 'ends', name: 'Silence at the start and end' }
]

function TidySheet({ tidy, ctx, rows, slides, onClose, onPlay, onApply }: { tidy: ReturnType<typeof tidyProposals>; ctx: EditorWords; rows: EditorRow[]; slides: Record<string, EditorSlide>; onClose: () => void; onPlay: (p: TidyProposal) => void; onApply: (ranges: TimeRange[]) => void }): ReactNode {
  const clean = tidy.proposals.filter((p) => p.quality === 'clean')
  const listen = tidy.proposals.filter((p) => p.quality === 'close')
  // Clean proposals are ticked; Needs a listen never is until the owner ticks it.
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(clean.map((p) => p.id)))
  const [open, setOpen] = useState<Set<TidyKind>>(() => new Set())
  const toggle = (ids: string[], on: boolean): void => setTicked((t) => { const next = new Set(t); for (const id of ids) { if (on) next.add(id); else next.delete(id) } return next })
  const slideN = (p: TidyProposal): number => slides[rows[p.row]?.slideId]?.n ?? p.row + 1
  const chosen = tidy.proposals.filter((p) => ticked.has(p.id))
  const saves = coveredMs(normaliseRanges(chosen.map((p) => p.range), ctx.durationMs), { start: 0, end: ctx.durationMs })
  const describe = (kind: TidyKind, items: TidyProposal[]): ReactNode => {
    if (!items.length) return null
    if (kind === 'pauses') return <>Shorten each to half a second · longest {secs(Math.max(...items.map((p) => p.pauseMs ?? 0)))}, slide {slideN(items.reduce((a, b) => ((a.pauseMs ?? 0) >= (b.pauseMs ?? 0) ? a : b)))}</>
    if (kind === 'ends') return items.map((p) => p.text).join(' · ')
    return <><q>{items[0].text}</q> · slide {slideN(items[0])}{items.length > 1 ? ` · and ${items.length - 1} more` : ''}</>
  }
  const Box = ({ on, mixed, onClick, label, disabled }: { on: boolean; mixed?: boolean; onClick: () => void; label: string; disabled?: boolean }): ReactNode => (
    <button className={`tre-cb${on ? ' on' : ''}${mixed ? ' mixed' : ''}`} role="checkbox" aria-checked={mixed ? 'mixed' : on} aria-label={label} disabled={disabled} onClick={onClick}>{on ? <Check className="lt-icon" /> : mixed ? <span className="tre-cb-dash" /> : null}</button>
  )
  return (
    <div className="tre-scrim" onPointerDown={onClose}>
      <div className="tre-sheet" role="dialog" aria-modal="true" aria-label="Tidy up" onPointerDown={(e) => e.stopPropagation()}>
        <header><h2>Tidy up</h2><p className="tre-lead">{tidy.proposals.length ? `TalkWeaver found ${plural(tidy.proposals.length, 'place')} you may want to cut. Nothing changes until you choose.` : 'TalkWeaver found nothing to tidy. Nothing changes.'}</p></header>
        <div className="tre-sheet-body">
          {GROUPS.map(({ kind, name }) => {
            const items = clean.filter((p) => p.kind === kind)
            if (!items.length) return null
            const onCount = items.filter((p) => ticked.has(p.id)).length
            const expanded = open.has(kind)
            return <div key={kind} className="tre-grp-wrap" data-group={kind}>
              <div className="tre-grp">
                <Box on={onCount === items.length} mixed={onCount > 0 && onCount < items.length} label={name} onClick={() => toggle(items.map((p) => p.id), onCount < items.length)} />
                <span className="tre-gname">{name}</span><span className="tre-gcnt">{items.length}</span><span className="tre-gex">{describe(kind, items)}</span>
                <button className="tw-btn tw-btn--sm" onClick={() => onPlay(items[0])}><Play className="lt-icon" /> Play</button>
                <button className="tre-chev" aria-label={expanded ? `Hide ${name}` : `Show each of ${name}`} aria-expanded={expanded} onClick={() => setOpen((o) => { const s = new Set(o); if (s.has(kind)) s.delete(kind); else s.add(kind); return s })}>{expanded ? <ChevronDown className="lt-icon" /> : <ChevronRight className="lt-icon" />}</button>
              </div>
              {expanded ? items.map((p) => <div key={p.id} className="tre-item">
                <Box on={ticked.has(p.id)} label={p.text} onClick={() => toggle([p.id], !ticked.has(p.id))} />
                <span className="tre-gex"><q>{p.text}</q> · slide {slideN(p)} · {secs(p.savesMs)}</span>
                <button className="tw-btn tw-btn--sm" onClick={() => onPlay(p)}><Play className="lt-icon" /> Play</button>
              </div>) : null}
            </div>
          })}
          <div className="tre-grp-wrap" data-group="fillers">
            <div className="tre-grp disabled">
              <Box on={false} label="Um and er the transcript caught" disabled onClick={() => {}} />
              <span className="tre-gname">Um and er the transcript caught</span><span className="tre-gcnt">{tidy.fillers.proposals.length}</span><span className="tre-gex" />
              <span /><span />
            </div>
            {tidy.fillers.reason ? <div className="tre-gnote"><AlertTriangle className="lt-icon" />{tidy.fillers.reason}</div> : null}
          </div>
          {listen.length ? <>
            <div className="tre-sub-h"><Ear className="lt-icon" /><h3>Needs a listen</h3><span className="tre-gcnt amber">{listen.length}</span></div>
            <p className="tre-sub-lead">Each of these cuts is close to a word and may clip it. Play one before you tick it.</p>
            {listen.map((p) => <div key={p.id} className="tre-grp listen" data-listen={p.id}>
              <Box on={ticked.has(p.id)} label={p.text} onClick={() => toggle([p.id], !ticked.has(p.id))} />
              <span className="tre-gex"><q>{p.text}</q> · slide {slideN(p)}</span>
              <button className="tw-btn tw-btn--sm" onClick={() => onPlay(p)}><Play className="lt-icon" /> Play</button><span />
            </div>)}
          </> : null}
        </div>
        <footer>
          <span className="tre-sp" />
          <span className="tre-sum">{chosen.length ? `Cuts ${Math.max(1, Math.round(saves / 1000))} ${Math.round(saves / 1000) === 1 ? 'second' : 'seconds'}` : 'Nothing ticked'}</span>
          <button className="tw-btn" onClick={onClose}>Cancel</button>
          <button className="tw-btn tw-btn--primary" disabled={!chosen.length} onClick={() => onApply(chosen.map((p) => p.range))}><Scissors className="lt-icon" /> Cut the {chosen.length} ticked</button>
        </footer>
      </div>
    </div>
  )
}
