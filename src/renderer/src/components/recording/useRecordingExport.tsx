// The export sheet and job of a layered Run (slice 3a), shared by the recording panel and the editor:
// choose extras, start the export through main (the save panel opens there), follow its progress, show
// the result. The export reads the Run's edit sidecar in main, so whatever the panel or the editor cut
// is what is exported.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Captions, Check, FolderOpen } from 'lucide-react'
import type { ExportProgress } from '../../../../main/recording-video-ipc'
import type { PanelSlide } from './RecordingPanel'

const minutes = (ms: number): string => { const s = Math.round(ms / 1000), m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s` }
const size = (bytes: number): string => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`

export type Exporting =
  | { state: 'closed' }
  | { state: 'choose' }
  | { state: 'working'; jobId: string; name: string; fraction: number; hidden: boolean }
  | { state: 'done'; jobId: string; name: string; bytes: number; durationMs: number; extras: number; captionsLeftOut: number }
  | { state: 'failed'; message: string; retry?: boolean; offerWithoutWords?: boolean }

export type RecordingExportOptions = {
  runRef: { talkSlug: string; runId: string; home: string | null | undefined }
  title: string
  slides: Record<string, PanelSlide>
  /** The sheet sits over the whole window (a Run without a picture, whose button is in Studio's row). */
  fixed?: boolean
  audioOnly: boolean
  hasCamera: boolean
  camera: boolean
  editedMs: number
  chapterCount: number
  hasCaptionText: boolean
  /**
   * Wait for every edit the window has made to be saved, then name the saved revision the export must use.
   * An error (a save failed) stops the export before the sheet opens, and says what failed.
   */
  settle?: () => Promise<{ revision: number; plan?: string } | { error: string }>
  /** Main found the saved state differs from what the window shows: reload the words and edits. */
  onStale?: () => void
  /**
   * The words could not be read: the caller shows the plan without words while this is on (the plan both
   * sides then use), and the export goes without captions.
   */
  withoutWords?: boolean
  setWithoutWords?: (on: boolean) => void
}

export function useRecordingExport({ runRef, title, slides, fixed = false, audioOnly, hasCamera, camera, editedMs, chapterCount, hasCaptionText, settle, onStale, withoutWords = false, setWithoutWords }: RecordingExportOptions): {
  exporting: Exporting
  setExporting: (e: Exporting) => void
  /** Open the sheet once every edit is saved (Export… buttons call this). */
  open: () => Promise<void>
  sheet: ReactNode
} {
  const [exporting, setExporting] = useState<Exporting>({ state: 'closed' })
  const [extras, setExtras] = useState({ captions: true, chapterList: true, sound: false })
  useEffect(() => { setExporting({ state: 'closed' }) }, [runRef])
  // The plan without words is shown only while its export sheet is open or its export runs.
  useEffect(() => { if (exporting.state === 'closed' && withoutWords) setWithoutWords?.(false) }, [exporting.state, withoutWords, setWithoutWords])

  // The last report of each job, in case one arrives before the window has taken the job's id.
  const lastReport = useRef(new Map<string, ExportProgress>())
  useEffect(() => window.tw.recordingVideo?.onExportProgress((p) => {
    lastReport.current.set(p.jobId, p)
    setExporting((cur) => {
      if (cur.state !== 'working' || cur.jobId !== p.jobId) return cur
      if (p.state === 'working') return { ...cur, fraction: p.fraction }
      if (p.state === 'done') return { state: 'done', jobId: p.jobId, name: p.name, bytes: p.bytes, durationMs: p.durationMs, extras: p.extras.length, captionsLeftOut: p.captionsLeftOut }
      if (p.state === 'cancelled') return { state: 'closed' }
      return { state: 'failed', message: p.message }
    })
  }), [])

  // The saved state is settled before the sheet opens and again before the export starts; main refuses an
  // export whose saved revision is not the one settled here, so the file always matches the summary.
  const settled = useCallback(async (): Promise<{ revision?: number; plan?: string } | null> => {
    if (!settle) return {}
    const r = await settle()
    if ('error' in r) { setExporting({ state: 'failed', message: r.error, retry: false }); return null }
    return { revision: r.revision, plan: r.plan }
  }, [settle])
  const open = useCallback(async (): Promise<void> => {
    if (await settled()) setExporting({ state: 'choose' })
  }, [settled])
  const startExport = useCallback(async (): Promise<void> => {
    const ready = await settled()
    if (!ready) return
    const chapterSlides = Object.fromEntries(Object.entries(slides).map(([id, s]) => [id, { title: s.title, ...(s.section ? { section: s.section } : {}) }]))
    const r = await window.tw.recordingVideo.export(runRef, { ...extras, title: title, slides: chapterSlides, ...(ready.revision !== undefined ? { revision: ready.revision } : {}), ...(ready.plan !== undefined ? { plan: ready.plan } : {}), ...(withoutWords ? { withoutWords: true, captions: false } : {}) })
    if (r.ok) {
      const early = lastReport.current.get(r.jobId)
      setExporting(early?.state === 'done' ? { state: 'done', jobId: r.jobId, name: early.name, bytes: early.bytes, durationMs: early.durationMs, extras: early.extras.length, captionsLeftOut: early.captionsLeftOut }
        : early?.state === 'failed' ? { state: 'failed', message: early.message }
        : early?.state === 'cancelled' ? { state: 'closed' }
        : { state: 'working', jobId: r.jobId, name: r.name, fraction: early?.state === 'working' ? early.fraction : 0, hidden: false })
    }
    else if (r.cancelled) setExporting({ state: 'choose' })
    else if (r.wordsUnreadable) setExporting({ state: 'failed', message: r.error ?? 'The words for this recording could not be read.', retry: false, offerWithoutWords: !!setWithoutWords })
    else if (r.stale) { setExporting({ state: 'failed', message: r.error ?? 'The recording changed. Choose Export again.', retry: false }); onStale?.() }
    else setExporting({ state: 'failed', message: r.error ?? 'Could not start the export.' })
  }, [extras, runRef, title, slides, settled, onStale, withoutWords, setWithoutWords])

  const sheet = exporting.state !== 'closed' && !(exporting.state === 'working' && exporting.hidden) ? (
    <div className={`twrp-sheet-back${fixed ? ' twrp-sheet-fixed' : ''}`}>
          <div className="twrp-sheet" role="dialog" aria-modal="true" aria-label="Export">
            {exporting.state === 'choose' ? <>
              <h3>{audioOnly ? 'Export sound' : 'Export video'}</h3>
              <p className="twrp-summary">{minutes(editedMs)}{audioOnly ? ' · sound only' : ` · Full HD · ${hasCamera ? (camera ? 'camera in the corner · ' : 'no camera · ') : ''}${chapterCount} ${chapterCount === 1 ? 'chapter' : 'chapters'}`}</p>
              <fieldset>
                <legend>Also save</legend>
                {withoutWords
                  ? <p className="twrp-quiet" role="note">Without captions: the words could not be read. The editor shows the video as it will be exported, without words.</p>
                  : <label><input type="checkbox" checked={extras.captions} onChange={(e) => setExtras({ ...extras, captions: e.target.checked })} /> <Captions className="lt-icon" /> Captions file (SRT and WebVTT){hasCaptionText ? '' : ' — no words yet'}</label>}
                {!audioOnly ? <label><input type="checkbox" checked={extras.chapterList} onChange={(e) => setExtras({ ...extras, chapterList: e.target.checked })} /> Chapter list to paste into YouTube</label> : null}
                {!audioOnly ? <label><input type="checkbox" checked={extras.sound} onChange={(e) => setExtras({ ...extras, sound: e.target.checked })} /> Sound only (M4A)</label> : null}
              </fieldset>
              <p className="twrp-quiet">Saved where you choose; nothing is uploaded.</p>
              <div className="twrp-sheet-acts">
                <button className="twrp-btn" onClick={() => setExporting({ state: 'closed' })}>Cancel</button>
                <button className="twrp-primary" onClick={() => void startExport()}>Export…</button>
              </div>
            </> : exporting.state === 'working' ? <>
              <h3>{audioOnly ? 'Making your sound file…' : 'Making your video…'} {Math.round(exporting.fraction * 100)}%</h3>
              <progress value={exporting.fraction} max={1} aria-label="Export progress" />
              <p className="twrp-quiet">{exporting.name}</p>
              <div className="twrp-sheet-acts">
                <button className="twrp-btn" onClick={() => void window.tw.recordingVideo.cancelExport(exporting.jobId)}>Stop</button>
                <button className="twrp-btn" onClick={() => setExporting({ ...exporting, hidden: true })}>Keep editing</button>
              </div>
            </> : exporting.state === 'done' ? <>
              <h3><Check className="lt-icon twrp-ok" /> Saved: {exporting.name}</h3>
              <p className="twrp-summary">{minutes(exporting.durationMs)} · {size(exporting.bytes)}{exporting.extras ? ` · ${exporting.extras} more ${exporting.extras === 1 ? 'file' : 'files'} beside it` : ''}{exporting.captionsLeftOut ? `. ${exporting.captionsLeftOut} caption ${exporting.captionsLeftOut === 1 ? 'line was' : 'lines were'} left out because a trim cuts through ${exporting.captionsLeftOut === 1 ? 'it' : 'them'} (no word timings).` : ''}</p>
              <div className="twrp-sheet-acts">
                <button className="twrp-btn" onClick={() => void window.tw.recordingVideo.reveal(exporting.jobId)}><FolderOpen className="lt-icon" /> Show in Finder</button>
                <button className="twrp-primary" onClick={() => setExporting({ state: 'closed' })}>Done</button>
              </div>
            </> : exporting.state === 'failed' ? <>
              <h3><AlertTriangle className="lt-icon twrp-warn" /> {exporting.message}</h3>
              <div className="twrp-sheet-acts">
                <button className="twrp-btn" onClick={() => setExporting({ state: 'closed' })}>Close</button>
                {exporting.retry !== false ? <button className="twrp-primary" onClick={() => void startExport()}>Choose another place…</button> : null}
                {exporting.offerWithoutWords ? <button className="twrp-primary" onClick={() => { setWithoutWords?.(true); setExporting({ state: 'choose' }) }}>Export without captions</button> : null}
              </div>
            </> : null}
          </div>
    </div>
  ) : null


  return { exporting, setExporting, open, sheet }
}
