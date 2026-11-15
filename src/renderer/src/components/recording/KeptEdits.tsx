// Kept edits (0.45, second Mac): the copies of a recording's edits that TalkWeaver set aside rather than lose
// (Start new edits, a restore, a version changed on another Mac while these edits were open, what an older
// release saved, a sync service's copies, each version of a Git conflict). The sheet lists them with when,
// which Mac and which TalkWeaver saved each; one opens read only in the editor or is restored as the edits
// (main keeps the edits it replaces as another copy). Nothing here deletes a copy. Wording:
// src/shared/recording-edits-kept.ts.
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, History, Loader2, X } from 'lucide-react'
import { ModalSheet } from './LookAndSound'
import './recording-editor.css'
import type { EditsSnapshot } from '../../../../main/recording-edits-store'
import type { RecordingEdits } from '../../../../shared/recording-edits'
import {
  KEPT_SHEET_FOOT, KEPT_SHEET_INTRO, START_NEW_TITLE, keptByline, keptReasonWords, keptSameWords, keptStateWords, noticeWords, startNewBody,
  type EditsNotice, type KeptEdits
} from '../../../../shared/recording-edits-kept'

type RunRef = { talkSlug: string; runId: string; home?: string | null }

/** The list. `onOpen` (the editor): show one read only. `onRestored`: main made one the edits. */
export function KeptEditsSheet({ runRef, onOpen, onRestored, onClose }: {
  runRef: RunRef
  onOpen?: (kept: KeptEdits, edits: RecordingEdits) => void
  onRestored: (snapshot: EditsSnapshot) => void
  onClose: () => void
}): ReactNode {
  const [list, setList] = useState<KeptEdits[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.tw.recordingVideo.keptList(runRef).then((r) => { if (!alive) return; if (r.ok) setList(r.kept); else setError(r.error) }).catch((e) => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [runRef])
  const open = (k: KeptEdits): void => {
    setBusy(k.id); setError(null)
    void window.tw.recordingVideo.keptOpen(runRef, k.id).then((r) => { setBusy(null); if (r.ok) onOpen?.(r.kept, r.edits); else setError(r.error) }).catch((e) => { setBusy(null); setError(String(e)) })
  }
  const restore = (k: KeptEdits): void => {
    setBusy(k.id); setError(null)
    void window.tw.recordingVideo.keptRestore(runRef, k.id).then((r) => { setBusy(null); if (r.ok) onRestored(r.edits); else setError(r.error) }).catch((e) => { setBusy(null); setError(String(e)) })
  }
  return (
    <ModalSheet className="tre-kept" labelledBy="tre-kept-title" onClose={onClose}>
      <header>
        <h2 id="tre-kept-title">Kept edits</h2>
        <p className="tre-kept-intro">{KEPT_SHEET_INTRO}</p>
      </header>
      <div className="tre-sheet-body" data-kept-list>
        {error ? <div className="tre-kept-error" role="alert"><AlertTriangle className="lt-icon" /> {error}</div> : null}
        {list === null && !error ? <div className="tre-kept-empty"><Loader2 className="lt-icon spin" /> Reading the kept edits…</div> : null}
        {list?.length === 0 ? <div className="tre-kept-empty">No kept edits for this recording.</div> : null}
        {list?.map((k) => {
          const why = keptStateWords(k)
          const opens = k.state === 'ok' || k.state === 'other-recording' || k.state === 'unknown'
          const same = keptSameWords(k.same?.length ?? 0)
          return (
            <div key={k.id} className="tre-kept-row" data-kept-id={k.id} data-kept-state={k.state}>
              <div className="tre-kept-text">
                <div className="tre-kept-when">{keptByline(k)}</div>
                <div className="tre-kept-why">{keptReasonWords(k)}</div>
                <div className={`tre-kept-what${why && k.state !== 'unknown' ? ' warn' : ''}`}>{why ?? k.summary ?? 'Open it to see its edits.'}</div>
                {same ? <div className="tre-kept-why" data-kept-same={k.same?.length}>{same}</div> : null}
              </div>
              <div className="tre-kept-acts">
                {onOpen && opens ? <button className="tw-btn tw-btn--sm" disabled={!!busy} onClick={() => open(k)}>Open</button> : null}
                {k.state === 'ok' || k.state === 'unknown' ? <button className="tw-btn tw-btn--sm" disabled={!!busy} onClick={() => restore(k)}>{busy === k.id ? 'Restoring…' : 'Restore'}</button> : null}
              </div>
            </div>
          )
        })}
      </div>
      <footer>
        <span className="tre-look-foot">{KEPT_SHEET_FOOT}</span>
        <span className="tre-sp" />
        <button className="tw-btn tw-btn--primary" onClick={onClose}>Done</button>
      </footer>
    </ModalSheet>
  )
}

/** Start new edits, asked: where the old edits go and how to get them back. */
export function StartNewEditsSheet({ where, gitConflict, onStart, onClose }: { where: 'editor' | 'panel'; gitConflict: boolean; onStart: () => void; onClose: () => void }): ReactNode {
  return (
    <ModalSheet className="tre-kept tre-start-new" labelledBy="tre-start-new-title" onClose={onClose}>
      <header><h2 id="tre-start-new-title">{START_NEW_TITLE}</h2></header>
      <div className="tre-sheet-body">
        <p className="tre-kept-intro">{startNewBody(where)}</p>
        {gitConflict ? <p className="tre-kept-intro">The file holds two versions from a Git conflict. Kept edits lists each of them, and either can be restored.</p> : null}
      </div>
      <footer>
        <span className="tre-sp" />
        <button className="tw-btn" onClick={onClose}>Cancel</button>
        <button className="tw-btn tw-btn--primary" data-start-new-confirm onClick={onStart}>Start new edits</button>
      </footer>
    </ModalSheet>
  )
}

/** One notice line: a version kept instead of lost, a restore, new edits started. */
export function EditsNoticeNote({ notice, onKept, onDismiss }: { notice: EditsNotice; onKept: () => void; onDismiss: () => void }): ReactNode {
  return (
    <div className="tre-note" role="status" data-edits-notice={notice.kind}>
      <History className="lt-icon" />
      <span className="tre-grow">{noticeWords(notice)}</span>
      <button className="tw-btn tw-btn--sm" onClick={onKept}>Kept edits…</button>
      <button className="tw-btn tw-btn--quiet tw-btn--icon tw-btn--sm" aria-label="Dismiss" onClick={onDismiss}><X className="lt-icon" /></button>
    </div>
  )
}

/** Outside the editor (the Studio panel): the editor's own look for these parts, without its layout. */
export function EditorLook({ children }: { children: ReactNode }): ReactNode {
  return <div className="tre lt tre-look-host">{children}</div>
}

/** The notices a snapshot carries, in the order to show them. */
export const noticesOf = (s: EditsSnapshot | null | undefined): EditsNotice[] => [s?.notice, s?.also, ...(s?.more ?? [])].filter((n): n is EditsNotice => !!n)
