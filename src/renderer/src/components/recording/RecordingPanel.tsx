// The Run view's recording panel for a layered Run (slice 3a): play it back, trim the ends, export one
// video. One bar above the player; a scrub bar with slide ticks and two trim handles under it. Every
// change is an explicit click and goes to the Run's edit sidecar through main; nothing is cut or
// exported by itself. Where the 0.45 editor will go, this panel shows nothing.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeftToLine, ArrowRightToLine, Download, Loader2, Pause, Play, Redo2, RotateCcw, SquarePen, Undo2, Video, VideoOff, X } from 'lucide-react'
import type { RecordingSession, Transcript } from '../../../../preload/index'
import type { RecordingOpen } from '../../../../main/recording-video-ipc'
import type { EditsSnapshot } from '../../../../main/recording-edits-store'
import { trimEndAt, trimStartAt, type EditOp, type TimeRange } from '../../../../shared/recording-edits'
import { planDigest, resolveRecording } from '../../../../shared/recording-editor'
import { chaptersFor, faceTrack, faceTrackOnClock, planRunToEdited, silentEndSuggestions } from '../../../../shared/recording-video'
import { recordingRunHome } from '../../../../shared/recording-run-home'
import { LayeredPlayer, type LayeredPlayerHandle, type PlayerSource } from './LayeredPlayer'
import { useEvenVoice } from './LookAndSound'
import { chosenTakes, missingTakeNotice, unavailableTakes, useTakes, useTakeSource } from './RecordSlideAgain'
import { takesInUse } from '../../../../shared/recording-takes'
import { useRecordingExport } from './useRecordingExport'
import './recording-panel.css'

export type PanelSlide = { title: string; section?: string; n: number }
/** The player's handle plus the trim commands Studio's keys reach (I, O, ⌘Z, ⇧⌘Z). */
export type RecordingPanelHandle = LayeredPlayerHandle & { trimStart: () => void; trimEnd: () => void; undo: () => void; redo: () => void }

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
const tenths = (ms: number): string => `${clock(ms)}.${Math.floor((Math.max(0, ms) % 1000) / 100)}`
const minutes = (ms: number): string => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s` }

export const RecordingPanel = forwardRef<RecordingPanelHandle, {
  run: RecordingSession
  slides: Record<string, PanelSlide>
  transcript: Transcript | null
  onTime: (runMs: number) => void
  onPlaying: (playing: boolean) => void
  /** A Run without a picture keeps Studio's own player; it gets only Export sound… and its sheet. */
  exportOnly?: boolean
  /** Opens the recording editor (slice 3): the panel's main button when given. */
  onEdit?: () => void
  /** Read the Run's words again (an export found them changed). */
  onReloadWords?: () => void
}>(function RecordingPanel({ run, slides, transcript, onTime, onPlaying, exportOnly = false, onEdit, onReloadWords }, ref) {
  const home = recordingRunHome(run)
  // Stable across Studio's list reloads, so a reload never reopens or resets the player.
  const runRef = useMemo(() => ({ talkSlug: run.talkSlug, runId: run.id, home }), [run.talkSlug, run.id, home])
  const [opened, setOpened] = useState<RecordingOpen | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [source, setSource] = useState<PlayerSource | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [unreadable, setUnreadable] = useState<string[]>([])
  const [edits, setEdits] = useState<EditsSnapshot | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [runMs, setRunMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [drag, setDrag] = useState<{ side: 'start' | 'end'; at: number } | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const player = useRef<LayeredPlayerHandle>(null)
  const track = useRef<HTMLDivElement>(null)

  // Commands for Studio's keys; set each render so they always act on the current edits.
  const actions = useRef({ trimStart: () => {}, trimEnd: () => {}, undo: () => {}, redo: () => {} })
  useImperativeHandle(ref, () => ({
    play: () => player.current?.play(), pause: () => player.current?.pause(), toggle: () => player.current?.toggle(),
    seekRun: (ms: number) => player.current?.seekRun(ms), runMs: () => player.current?.runMs() ?? runMs, playing: () => player.current?.playing() ?? false,
    seekVideo: (ms: number) => player.current?.seekVideo(ms), videoMs: () => player.current?.videoMs() ?? runMs,
    trimStart: () => actions.current.trimStart(), trimEnd: () => actions.current.trimEnd(), undo: () => actions.current.undo(), redo: () => actions.current.redo()
  }), [runMs])

  // Open the Run's layers and edits, then prepare playback copies (seconds, once per recording).
  useEffect(() => {
    let alive = true
    setOpened(null); setOpenError(null); setSource(null); setEdits(null); setUnreadable([]); setEditError(null); setDismissed(new Set())
    // A window without this bridge (an older preload, a test double) shows no panel rather than failing.
    if (!window.tw.recordingVideo) { setOpenError('Playback is not available in this window.'); return }
    void window.tw.recordingVideo.open(runRef).then((r) => {
      if (!alive) return
      if (!r.ok) { setOpenError(r.error); return }
      setOpened(r); setEdits(r.edits)
      if (exportOnly) return
      setPreparing(true)
      return window.tw.recordingVideo.prepare(runRef).then((p) => {
        if (!alive) return
        if (!p.ok) { setOpenError(p.error); return }
        setSource({ voice: p.voice, slides: p.slides, camera: p.camera })
        setUnreadable(p.unreadable.map((m) => m.file))
      })
    }).catch((e) => { if (alive) setOpenError(String(e)) }).finally(() => { if (alive) setPreparing(false) })
    return () => { alive = false }
  }, [runRef, exportOnly])

  const durationMs = opened?.durationMs ?? run.recordingMs
  const sidecarCuts = edits?.edits.cuts ?? []
  const restoredTrims = edits?.edits.restoredTrims
  const planOf = useRef<(e: EditsSnapshot) => string>(() => '')
  // While "Export without captions" is open (the words could not be read), the plan is the one without words.
  const [withoutWords, setWithoutWords] = useState(false)
  const words = withoutWords ? null : transcript
  // The one resolved edit state the editor and the export use: the editor's cuts, slides left out and
  // moved slide starts play here exactly as they export.
  const boundaries = edits?.edits.boundaries, leftOut = edits?.edits.leftOut
  // New takes chosen in the editor (Record this slide again) play here too, as they export.
  // Off unless main says otherwise (takesEnabled): take choices in the edits file are kept but not used.
  const takesOn = !!opened?.recordAgain
  const takesList = useTakes(runRef, opened?.takes, takesOn)
  const savedChoices = edits?.edits.takes
  const chosenList = useMemo(() => takesInUse(takesOn, savedChoices), [takesOn, savedChoices])
  const takes = useMemo(() => chosenTakes(chosenList ?? [], takesList), [chosenList, takesList])
  const missingTakes = useMemo(() => unavailableTakes(chosenList ?? [], takesList), [chosenList, takesList])
  const resolved = useMemo(() => resolveRecording({ durationMs, edits: { cuts: sidecarCuts, boundaries: boundaries ?? [], leftOut: leftOut ?? [], restoredTrims: restoredTrims ?? [] }, runTrims: run.trims as TimeRange[] | undefined, marks: run.slideTimeIndex, transcript: words, takes }),
    [durationMs, sidecarCuts, boundaries, leftOut, restoredTrims, run.trims, run.slideTimeIndex, words, takes])
  planOf.current = (e) => planDigest(resolveRecording({ durationMs, edits: e.edits, runTrims: run.trims as TimeRange[] | undefined, marks: run.slideTimeIndex, transcript: words, takes: chosenTakes(takesInUse(takesOn, e.edits.takes), takesList) }), words?.segments)
  // Words or their timing that change while the panel is open are followed at once, with a quiet note.
  const wordsKey = `${transcript?.createdAt ?? ''}|${transcript?.alignment?.alignedAt ?? ''}|${transcript?.words?.length ?? 0}`
  const lastWordsKey = useRef<string | null>(null)
  const [wordsNote, setWordsNote] = useState(false)
  useEffect(() => {
    if (lastWordsKey.current !== null && lastWordsKey.current !== wordsKey && transcript?.words?.length) { setWordsNote(true); const t = setTimeout(() => setWordsNote(false), 8000); lastWordsKey.current = wordsKey; return () => clearTimeout(t) }
    lastWordsKey.current = wordsKey
  }, [wordsKey, transcript?.words?.length])
  const cuts = resolved.cuts
  const spans = resolved.spans
  const editedMs = resolved.editedMs
  const faces = useMemo(() => edits ? faceTrackOnClock(faceTrack(resolved.rows, edits.edits.faces, durationMs), resolved.clock) : undefined, [edits, resolved.rows, resolved.clock, durationMs])
  const startAt = drag?.side === 'start' ? drag.at : trimStartAt(sidecarCuts)
  const endAt = drag?.side === 'end' ? drag.at : trimEndAt(sidecarCuts, durationMs)
  const camera = edits?.edits.finish.camera !== false
  // Even out the volume (chosen in the editor's Look and sound) plays here too.
  const even = useEvenVoice(runRef, source, edits?.edits.finish.evenVolume !== false)
  const composed = useTakeSource(runRef, even.source, resolved.clock, durationMs, edits?.edits.finish.evenVolume !== false)
  const [videoMs, setVideoMs] = useState(0)
  const enters = useMemo(() => (run.slideTimeIndex ?? []).filter((m) => m.event === 'enter' && Number.isFinite(m.tMs)).sort((a, b) => a.tMs - b.tMs), [run.slideTimeIndex])
  const slideAt = useCallback((t: number): PanelSlide | null => {
    let found: string | undefined
    for (const e of enters) if (e.tMs <= t + 1) found = e.slideId
    return found ? slides[found] ?? null : null
  }, [enters, slides])
  const suggestions = useMemo(() => silentEndSuggestions(transcript?.silence, durationMs, trimStartAt(sidecarCuts), trimEndAt(sidecarCuts, durationMs)).filter((s) => !dismissed.has(`${s.side}:${s.at}`)), [transcript?.silence, durationMs, sidecarCuts, dismissed])

  // Edits go to main one at a time, each based on the revision the previous one returned, so quick
  // clicks are applied in order rather than refused as a conflict.
  const editsRef = useRef<EditsSnapshot | null>(null); editsRef.current = edits
  const queue = useRef<Promise<void>>(Promise.resolve())
  const saveFailed = useRef<string | null>(null)
  const edit = useCallback((op: EditOp): Promise<void> => {
    queue.current = queue.current.then(async () => {
      const current = editsRef.current
      if (!current) return
      setEditError(null)
      const r = await window.tw.recordingVideo.edit(runRef, op, current.edits.revision)
      if (r.ok) { editsRef.current = r.edits; setEdits(r.edits); saveFailed.current = null }
      else { setEditError(r.error); saveFailed.current = r.error }
    }).catch((e) => { saveFailed.current = String(e) })
    return queue.current
  }, [runRef])
  // Export waits for every queued edit and does not start after a failed save.
  const settle = useCallback(async (): Promise<{ revision: number; plan: string } | { error: string }> => {
    await queue.current
    if (saveFailed.current) return { error: `An edit could not be saved, so the video was not exported: ${saveFailed.current}` }
    const current = editsRef.current
    return current ? { revision: current.edits.revision, plan: planOf.current(current) } : { error: 'The recording is not open.' }
  }, [])
  const refresh = useCallback(() => {
    onReloadWords?.()
    void window.tw.recordingVideo?.open(runRef).then((r) => { if (r.ok) { editsRef.current = r.edits; setEdits(r.edits) } }).catch(() => {})
  }, [onReloadWords, runRef])

  const time = useCallback((t: number, v: number) => { setRunMs(t); setVideoMs(v); onTime(t) }, [onTime])
  const playingChanged = useCallback((p: boolean) => { setPlaying(p); onPlaying(p) }, [onPlaying])

  const atPointer = (clientX: number): number => {
    const r = track.current?.getBoundingClientRect()
    if (!r || !r.width) return 0
    return Math.max(0, Math.min(durationMs, ((clientX - r.left) / r.width) * durationMs))
  }
  const startDrag = (side: 'start' | 'end') => (e: React.PointerEvent): void => {
    e.preventDefault(); e.stopPropagation()
    const move = (ev: PointerEvent): void => {
      const t = atPointer(ev.clientX)
      setDrag({ side, at: side === 'start' ? Math.min(t, endAt - 500) : Math.max(t, startAt + 500) })
    }
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      const t = atPointer(ev.clientX)
      setDrag(null)
      void edit(side === 'start' ? { kind: 'trim-start', at: Math.min(t, endAt - 500) } : { kind: 'trim-end', at: Math.max(t, startAt + 500) })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    move(e.nativeEvent)
  }
  const seekTrack = (e: React.PointerEvent): void => {
    const go = (x: number): void => player.current?.seekRun(atPointer(x))
    go(e.clientX)
    const move = (ev: PointerEvent): void => go(ev.clientX)
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const trimStartHere = (): void => { void edit({ kind: 'trim-start', at: player.current?.runMs() ?? runMs }) }
  const trimEndHere = (): void => { void edit({ kind: 'trim-end', at: player.current?.runMs() ?? runMs }) }
  actions.current = { trimStart: trimStartHere, trimEnd: trimEndHere, undo: () => { void edit({ kind: 'undo' }) }, redo: () => { void edit({ kind: 'redo' }) } }

  const audioOnlyRun = !!opened && opened.slides.length === 0
  const exportCtl = useRecordingExport({
    runRef, title: run.talkTitle, slides, fixed: exportOnly, audioOnly: audioOnlyRun, hasCamera: !!opened?.hasCamera, camera,
    editedMs, chapterCount: audioOnlyRun ? 0 : chaptersFor(resolved.chapterMarks, slides, spans).length, hasCaptionText: !!transcript?.segments?.length, captionNote: resolved.takesWithoutWords ? (resolved.takesWithoutWords === 1 ? 'The new take in this video has no words written out yet, so that part has no captions.' : `${resolved.takesWithoutWords} new takes in this video have no words written out yet, so those parts have no captions.`) : null, settle, onStale: refresh, withoutWords, setWithoutWords
  })
  const { exporting, setExporting, sheet } = exportCtl

  if (exportOnly && (openError || !opened || !edits)) return null
  if (openError) return <div className="twrp-panel"><div className="twrp-error" role="alert"><AlertTriangle className="lt-icon" /> {openError}</div></div>
  if (!opened || !edits) return <div className="twrp-panel"><div className="twrp-loading"><Loader2 className="lt-icon spin" /> Opening the recording…</div></div>

  const audioOnly = opened.slides.length === 0
  const pct = (t: number): string => `${((100 * t) / Math.max(1, durationMs)).toFixed(3)}%`
  const missingText = [...opened.missing.map((m) => m.file), ...unreadable]
  const notice = missingText.length ? `${missingText.length === 1 ? 'A recorded file is' : 'Recorded files are'} missing or unreadable: ${missingText.join(', ')}. Playing what is there.` : audioOnly ? 'This Run has no picture: sound only.' : null
  const startSlide = slideAt(startAt), endSlide = slideAt(Math.max(0, endAt - 1))
  const trimmed = startAt > 0 || endAt < durationMs
  const busy = exporting.state === 'working'
  const problem = edits.problem

  if (exportOnly) return (
    <span className="twrp-export-only" data-recording-export>
      <button className="tw-btn tw-btn--sm" disabled={busy || !!problem} onClick={() => { if (exporting.state === 'working') setExporting({ ...exporting, hidden: false }); else void exportCtl.open() }} title="Export this Run's sound, with captions if you like">
        <Download className="lt-icon" /> {exporting.state === 'working' ? `Exporting ${Math.round(exporting.fraction * 100)}%` : 'Export sound…'}
      </button>
      {sheet}
    </span>
  )

  return (
    <div className="twrp-panel" data-recording-panel>
      <div className="twrp-bar" role="toolbar" aria-label="Recording">
        <button className="twrp-play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={!source} onClick={() => player.current?.toggle()}>
          {playing ? <Pause className="lt-icon" /> : <Play className="lt-icon" />}
        </button>
        <span className="twrp-clock" aria-live="off"><b>{clock(planRunToEdited(spans, videoMs))}</b> / {clock(editedMs)}{cuts.length ? <span className="twrp-of"> of {clock(durationMs)}</span> : null}</span>
 <span className="twrp-sep" />
        <button className="twrp-icon" aria-label="Undo" title="Undo (⌘Z)" disabled={!!problem || !edits.edits.undo.length} onClick={() => void edit({ kind: 'undo' })}><Undo2 className="lt-icon" /></button>
        <button className="twrp-icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!!problem || !edits.edits.redo.length} onClick={() => void edit({ kind: 'redo' })}><Redo2 className="lt-icon" /></button>
        <span className="twrp-grow" />
        {opened.hasCamera ? (
          <button className={`twrp-switch ${camera ? 'on' : ''}`} role="switch" aria-checked={camera} aria-label="Camera" disabled={!!problem} onClick={() => void edit({ kind: 'finish', finish: { camera: !camera } })} title={camera ? 'Your camera is in the video. Click to leave it out.' : 'Your camera is left out of the video. Click to put it in.'}>
            {camera ? <Video className="lt-icon" /> : <VideoOff className="lt-icon" />}<span>Camera</span><span className="twrp-switch-track" aria-hidden="true"><span className="twrp-switch-knob" /></span><span className="twrp-switch-state">{camera ? 'On' : 'Off'}</span>
          </button>
        ) : null}
        {onEdit && !audioOnly ? <button className="twrp-primary" data-edit-video disabled={!!problem} onClick={() => { player.current?.pause(); onEdit() }} title="Edit the video by its words, slide by slide"><SquarePen className="lt-icon" /><span className="twrp-label">Edit video</span></button> : null}
        <button className={onEdit && !audioOnly ? 'twrp-btn' : 'twrp-primary'} aria-label={audioOnly ? 'Export sound…' : 'Export video…'} disabled={busy || !!problem} onClick={() => void exportCtl.open()}><Download className="lt-icon" /><span className="twrp-label twrp-l-export">{audioOnly ? 'Export sound…' : 'Export video…'}</span></button>
      </div>

      {problem ? (
        <div className="twrp-problem" role="alert">
          <AlertTriangle className="lt-icon" />
          <span>{problem.message} It is kept unchanged.</span>
          <button className="twrp-btn" onClick={() => void window.tw.recordingVideo.startFresh(runRef).then((r) => { if (r.ok) setEdits(r.edits); else setEditError(r.error) })}>Start new edits</button>
        </div>
      ) : null}

      <div className="twrp-stage">
        <div className="twrp-unit">
        {composed.source ? (
          <LayeredPlayer ref={player} source={composed.source} spans={spans} durationMs={resolved.clockMs} clock={resolved.clock} camera={camera} dissolve={edits?.edits.finish.smoothJoins !== false} faces={faces} notice={composed.problem ?? missingTakeNotice(missingTakes) ?? notice} onTime={time} onPlaying={playingChanged} />
        ) : (
          <div className="twrp-player"><div className="twrp-frame twrp-wait">{preparing ? <><Loader2 className="lt-icon spin" /> Preparing playback…</> : null}</div></div>
        )}
      <div className="twrp-scrub">
        <div className="twrp-track" ref={track} onPointerDown={seekTrack} data-testid="recording-scrub">
          {cuts.map((c) => <span key={`${c.start}-${c.end}`} className="twrp-cut" style={{ left: pct(c.start), width: pct(c.end - c.start) }} />)}
          {drag ? <span className="twrp-cut twrp-cut-draft" style={drag.side === 'start' ? { left: 0, width: pct(drag.at) } : { left: pct(drag.at), width: pct(durationMs - drag.at) }} /> : null}
          {enters.map((e, i) => {
            const s = e.slideId ? slides[e.slideId] : undefined
            return <button key={`${e.tMs}-${i}`} className="twrp-tick" style={{ left: pct(e.tMs) }} title={`${s ? `${s.n} · ${s.title}` : 'Slide'} at ${clock(e.tMs)}`} aria-label={`Go to slide ${s?.n ?? i + 1}`} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => player.current?.seekRun(e.tMs)}><span>{s?.n ?? ''}</span></button>
          })}
          <span className="twrp-head" style={{ left: pct(runMs) }} aria-hidden="true"><span className="twrp-head-knob" /></span>
          <span className="twrp-handle start" role="slider" aria-label="Trim start" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={Math.round(startAt)} tabIndex={0} style={{ left: pct(startAt) }} onPointerDown={startDrag('start')} />
          <span className="twrp-handle end" role="slider" aria-label="Trim end" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={Math.round(endAt)} tabIndex={0} style={{ left: pct(endAt) }} onPointerDown={startDrag('end')} />
        </div>
        <div className="twrp-trims">
          <span className="twrp-trim-side">
            <button className="twrp-btn twrp-trim" disabled={!!problem} onClick={trimStartHere} title="Start the video at the playhead (I)"><ArrowLeftToLine className="lt-icon" />Trim start here</button>
            <span title="Where the video starts"><b>{tenths(startAt)}</b>{startSlide ? ` · slide ${startSlide.n}` : ''}</span>
          </span>
          <span className="twrp-trim-side end">
            <span title="Where the video ends"><b>{tenths(endAt)}</b>{endSlide ? ` · slide ${endSlide.n}` : ''}</span>
            <button className="twrp-btn twrp-trim" disabled={!!problem} onClick={trimEndHere} title="End the video at the playhead (O)">Trim end here<ArrowRightToLine className="lt-icon" /></button>
          </span>
        </div>
        <div className="twrp-notes">
          {trimmed ? <button className="twrp-link" disabled={!!problem} onClick={() => void edit({ kind: 'restore-all' })}><RotateCcw className="lt-icon" /> Use the whole recording</button> : null}
          {run.trims?.length ? <span className="twrp-quiet">{run.trims.length === 1 ? 'A trim' : `${run.trims.length} trims`} made in the transcript also apply.</span> : null}
          {suggestions.map((s) => (
            <span key={`${s.side}:${s.at}`} className="twrp-suggest">
              {s.side === 'start' ? `Silent start: ${(s.silentMs / 1000).toFixed(1)} s.` : `Silent end: ${(s.silentMs / 1000).toFixed(1)} s.`}
              <button className="twrp-link" onClick={() => void edit(s.side === 'start' ? { kind: 'trim-start', at: s.at } : { kind: 'trim-end', at: s.at })}>{s.side === 'start' ? `Start at ${tenths(s.at)}` : `End at ${tenths(s.at)}`}</button>
              <button className="twrp-x" aria-label="Dismiss suggestion" onClick={() => setDismissed((d) => new Set(d).add(`${s.side}:${s.at}`))}><X className="lt-icon" /></button>
            </span>
          ))}
          {wordsNote ? <span className="twrp-quiet" role="status">The words were updated; the video follows them.</span> : null}
          {editError ? <span className="twrp-err" role="alert">{editError}</span> : null}
          {exporting.state === 'working' && exporting.hidden ? <span className="twrp-quiet" role="status">Exporting {Math.round(exporting.fraction * 100)}% <button className="twrp-link" onClick={() => setExporting({ ...exporting, hidden: false })}>Show</button></span> : null}
        </div>
      </div>
      </div>
      </div>

      {sheet}
    </div>
  )
})
