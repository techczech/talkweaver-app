import { createPortal } from 'react-dom'
import { ArrowUpCircle, Download } from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { noteReducer, answerView, availableMarkText, versionLabel, dateText, type UpdateSnapshot, type AnswerView } from '@app-patterns/updates'
import { WhatsNewMark, AnswerButtons as SharedAnswerButtons, UpdatesProvider } from '@app-patterns/updates-react'
import { UPDATE_ANSWER_EVENT, type AnswerEventDetail, useUpdateSnapshot, viewContext, updateActions, answerOf } from '../lib/updateNotices'

// 0.4.1 fixes its footer to “documents”; TalkWeaver keeps “talks” and its existing local-note mark.
export function UpdateMarks() {
  const snap = useUpdateSnapshot()
  const api = window.tw?.updates
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) setPlace({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 400)), bottom: window.innerHeight - rect.top + 8 })
    const away = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!anchor.current?.contains(target) && !popover.current?.contains(target)) setOpen(false)
    }
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  useEffect(() => { if (!snap?.mark || snap.busy) setOpen(false) }, [snap?.mark, snap?.busy])
  if (!snap || !api) return null
  const latest = snap.mark
  return <UpdatesProvider snapshot={snap} actions={updateActions(api)}>
    {latest && <>
      <span style={{ margin: '0 8px', color: 'var(--line)' }}>|</span>
      <span className="apu-update-anchor" ref={anchor}>
        <button type="button" className="apu-update-mark" data-update-mark aria-expanded={open} title="A new version of TalkWeaver is out" onClick={() => setOpen((v) => !v)}>
          <ArrowUpCircle size={11} aria-hidden /> {availableMarkText(latest)}
        </button>
        {open && place && !snap.busy && createPortal(
          <div className="apu-update-pop" ref={popover} style={{ position: 'fixed', left: place.left, bottom: place.bottom }} role="dialog" aria-label="A new version is available" data-update-popover>
            <h3>TalkWeaver {latest.version} is available</h3>
            <div className="apu-update-sub">You have {versionLabel(snap.running)}. Released {dateText(latest.released)}.</div>
            <ul>{latest.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
            <div className="apu-update-actions">
              <button type="button" className="apu-update-btn apu-update-btn--primary" data-update-download onClick={() => { void api.download(); setOpen(false) }}><Download size={13} aria-hidden /> Download from talkweaver.app</button>
              <button type="button" className="apu-update-btn" data-update-not-now onClick={() => { void api.notNow(); setOpen(false) }}>Not now</button>
              <button type="button" className="apu-update-btn apu-update-btn--quiet" data-update-skip onClick={() => { void api.skip(latest.version); setOpen(false) }}>Skip this version</button>
            </div>
            <div className="apu-update-foot">Download opens the download page in your browser. Install it as you installed this one; your talks and settings stay as they are.{' '}
              <button type="button" className="apu-update-link" data-update-notes onClick={() => void api.openNotes(latest.version)}>What&rsquo;s new in {latest.version}</button>
            </div>
          </div>, document.body
        )}
      </span>
    </>}
    {snap.whatsNew && <>
      <span style={{ margin: '0 8px', color: 'var(--line)' }}>|</span>
      <UpdatesProvider snapshot={{ ...snap, busy: false }} actions={updateActions(api)}><span title="What changed in this version"><WhatsNewMark /></span></UpdatesProvider>
    </>}
  </UpdatesProvider>
}

/** A deliberate check's answer as a note at the bottom right: it waits for a click when it offers a button, else a few seconds. */
export function UpdateAnswerNote() {
  const presenting = useUpdateSnapshot()?.busy === true
  const presentingNow = useRef(presenting)
  presentingNow.current = presenting
  const [note, dispatch] = useReducer(noteReducer<AnswerView>, { shown: null, held: null })
  const view = presenting ? null : note.shown
  useEffect(() => {
    const take = (event: Event): void => { const d = (event as CustomEvent<AnswerEventDetail>).detail; dispatch({ kind: 'answer', view: d?.view ?? null, busy: presentingNow.current || d?.busy === true }) }
    window.addEventListener(UPDATE_ANSWER_EVENT, take)
    // The answer of a check that waited for a talk to end: held if another talk has started since.
    const off = window.tw?.updates?.onAnswer?.((snap) => dispatch({ kind: 'answer', view: answerView(snap.state, viewContext(snap)), busy: presentingNow.current || snap.busy }))
    return () => { window.removeEventListener(UPDATE_ANSWER_EVENT, take); off?.() }
  }, [])
  useEffect(() => { dispatch({ kind: 'busy', busy: presenting }) }, [presenting])
  const setView = (next: AnswerView | null): void => dispatch(next ? { kind: 'answer', view: next, busy: presentingNow.current } : { kind: 'dismiss' })
  useEffect(() => {
    if (!view || view.action !== null) return
    const timer = setTimeout(() => dispatch({ kind: 'dismiss' }), 6000)
    return () => clearTimeout(timer)
  }, [view])
  const api = window.tw?.updates
  if (!view || !api) return null
  return (
    <div className={`tw-update-note tw-update-note--${view.tone}`} role="status" aria-live="polite" data-update-note data-update-note-tone={view.tone}>
      <button type="button" className="tw-update-note-close" aria-label="Dismiss" onClick={() => setView(null)}>×</button>
      <div className="tw-update-note-title">{view.title}</div>
      <div className="tw-update-note-detail">{view.detail}</div>
      {view.action !== null && <AnswerButtons view={view} onDone={() => setView(null)} onView={setView} />}
    </div>
  )
}


export function AnswerButtons(props: Parameters<typeof SharedAnswerButtons>[0]) {
  const snap = useUpdateSnapshot()
  const api = window.tw?.updates
  if (!snap || !api) return null
  // The shared retry button uses generic busy wording; keep TalkWeaver's presentation wording.
  let checked: UpdateSnapshot | null = null
  const actions = { ...updateActions(api), check: async () => { checked = await api.check(); return checked } }
  return <UpdatesProvider snapshot={snap} actions={actions}><SharedAnswerButtons {...props} onView={(view) => props.onView?.(checked ? answerOf(checked) : view)} /></UpdatesProvider>
}
