import { createPortal } from 'react-dom'
import { ArrowUpCircle, Download, RotateCw, AlertTriangle } from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { noteReducer, availableMarkText, versionLabel, dateText } from '@app-patterns/updates'
import { WhatsNewMark, UpdatesProvider } from '@app-patterns/updates-react'
import { DOWNLOAD_FOOT, REFUSAL_TEXT, blockersSentence, installMarkText, reopenText, sizeText, updateFoot } from '../../../shared/update-install'
import { UPDATE_ANSWER_EVENT, type AnswerEventDetail, type TwAnswerView, type UpdateSnapshot, useUpdateSnapshot, updateActions, answerOf, installAnswer } from '../lib/updateNotices'

// The status-bar mark and its popover (ADR-0044; was ADR-0041's tell-and-link mark). One mark, whose text
// follows the click's state: "0.45.0 is available" → "Downloading 0.45.0 · 42%" → "Restart to finish
// updating" / "Restarting into 0.45.0…" / "Update to 0.45.0 failed" / "Reopen TalkWeaver to update". Hidden while presenting.
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
  const working = snap ? snap.install.phase !== 'idle' : false
  useEffect(() => { if ((!snap?.mark && !working) || snap?.busy) setOpen(false) }, [snap?.mark, snap?.busy, working])
  if (!snap || !api) return null
  const latest = snap.mark
  const showMark = !snap.busy && (working || latest !== null)
  const installText = installMarkText(snap.install)
  const failed = snap.install.phase === 'failed'
  return <UpdatesProvider snapshot={snap as never} actions={updateActions(api) as never}>
    {showMark && <>
      <span style={{ margin: '0 8px', color: 'var(--line)' }}>|</span>
      <span className="apu-update-anchor" ref={anchor}>
        <button type="button" className={`apu-update-mark${failed ? ' tw-update-mark--failed' : ''}`} data-update-mark data-update-phase={snap.install.phase} aria-expanded={open}
          title={working ? 'Updating TalkWeaver' : 'A new version of TalkWeaver is out'} onClick={() => setOpen((v) => !v)}>
          {failed || snap.install.phase === 'reopen' ? <AlertTriangle size={11} aria-hidden /> : snap.install.phase === 'waiting' || snap.install.phase === 'restarting' ? <RotateCw size={11} aria-hidden /> : <ArrowUpCircle size={11} aria-hidden />}
          {' '}{installText ?? (latest ? availableMarkText(latest) : '')}
        </button>
        {open && place && !snap.busy && createPortal(
          <div className="apu-update-pop" ref={popover} style={{ position: 'fixed', left: place.left, bottom: place.bottom }} role="dialog" aria-label="Updating TalkWeaver" data-update-popover>
            <PopoverBody snap={snap} close={() => setOpen(false)} />
          </div>, document.body
        )}
      </span>
    </>}
    {snap.whatsNew && <>
      <span style={{ margin: '0 8px', color: 'var(--line)' }}>|</span>
      <UpdatesProvider snapshot={{ ...snap, busy: false } as never} actions={updateActions(api) as never}><span title="What changed in this version"><WhatsNewMark /></span></UpdatesProvider>
    </>}
  </UpdatesProvider>
}

function PopoverBody({ snap, close }: { snap: UpdateSnapshot; close: () => void }) {
  const api = window.tw!.updates
  const s = snap.install
  if (s.phase === 'downloading') {
    const pct = s.total > 0 ? Math.floor((s.received / s.total) * 100) : 0
    return <>
      <h3>Downloading TalkWeaver {s.version}</h3>
      <div className="tw-update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-update-progress={pct}><span style={{ width: `${pct}%` }} /></div>
      <div className="apu-update-sub">{sizeText(s.received)} of {sizeText(s.total)}. You can keep working.</div>
      <div className="apu-update-actions">
        <button type="button" className="apu-update-btn" data-update-cancel onClick={() => { void api.cancel() }}>Cancel</button>
      </div>
      <div className="apu-update-foot">TalkWeaver restarts into {s.version} when the download is finished and checked, unless you are presenting, recording or exporting.</div>
    </>
  }
  if (s.phase === 'waiting') {
    const held = snap.blockers.length > 0
    return <>
      <h3>TalkWeaver {s.version} is ready</h3>
      <div className="apu-update-sub" data-update-held={held ? snap.blockers.join(' ') : ''}>It opens when you restart. {held ? blockersSentence(snap.blockers) : 'Your talks are saved first.'}</div>
      <div className="apu-update-actions">
        <button type="button" className="apu-update-btn apu-update-btn--primary" data-update-restart disabled={held} title={held ? blockersSentence(snap.blockers) : undefined} onClick={() => { void api.restart() }}><RotateCw size={13} aria-hidden /> Restart</button>
        <button type="button" className="apu-update-btn" data-update-later onClick={close}>Later</button>
      </div>
    </>
  }
  if (s.phase === 'restarting') {
    return <>
      <h3>Restarting into {s.version}…</h3>
      <div className="apu-update-sub" data-update-restarting>macOS checks the new version; then TalkWeaver closes and opens again as {s.version}. This takes a few seconds.</div>
    </>
  }
  if (s.phase === 'reopen') {
    const text = reopenText(s)
    return <>
      <h3>{text.title}</h3>
      <div className="apu-update-sub" data-update-reopen={s.pending ? 'pending' : 'clear'} data-update-reopen-cause={s.cause}>{text.detail}</div>
    </>
  }
  if (s.phase === 'failed') {
    const view = answerOf(snap)
    return <>
      <h3>{view.title}</h3>
      <div className="apu-update-sub" data-update-failed={s.reason}>{view.detail}</div>
      <div className="apu-update-actions">
        <button type="button" className="apu-update-btn apu-update-btn--primary" data-update-retry onClick={() => { void api.update(s.version) }}>Try again</button>
        <button type="button" className="apu-update-btn" data-update-download onClick={() => { void api.download(); close() }}><Download size={13} aria-hidden /> Download from talkweaver.app</button>
      </div>
    </>
  }
  const latest = snap.mark
  if (!latest) return null
  const inPlace = snap.refusal === null && snap.file !== null
  return <>
    <h3>TalkWeaver {latest.version} is available</h3>
    <div className="apu-update-sub">You have {versionLabel(snap.running)}. Released {dateText(latest.released)}.</div>
    <ul>{latest.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
    {!inPlace && snap.refusal && snap.refusal !== 'no-file' && <div className="apu-update-sub" data-update-refusal={snap.refusal}>{REFUSAL_TEXT[snap.refusal]}</div>}
    <div className="apu-update-actions">
      {inPlace
        ? <button type="button" className="apu-update-btn apu-update-btn--primary" data-update-update onClick={() => { void api.update(latest.version) }}><ArrowUpCircle size={13} aria-hidden /> Update</button>
        : <button type="button" className="apu-update-btn apu-update-btn--primary" data-update-download onClick={() => { void api.download(); close() }}><Download size={13} aria-hidden /> Download from talkweaver.app</button>}
      <button type="button" className="apu-update-btn" data-update-not-now onClick={() => { void api.notNow(); close() }}>Not now</button>
      <button type="button" className="apu-update-btn apu-update-btn--quiet" data-update-skip onClick={() => { void api.skip(latest.version); close() }}>Skip this version</button>
    </div>
    <div className="apu-update-foot">{inPlace && snap.file ? updateFoot(latest.version, snap.file) : DOWNLOAD_FOOT}{' '}
      <button type="button" className="apu-update-link" data-update-notes onClick={() => void api.openNotes(latest.version)}>What&rsquo;s new in {latest.version}</button>
    </div>
  </>
}

/** A deliberate check's answer as a note at the bottom right: it waits for a click when it offers a button, else a few seconds. */
export function UpdateAnswerNote() {
  const snap = useUpdateSnapshot()
  const presenting = snap?.busy === true
  const presentingNow = useRef(presenting)
  presentingNow.current = presenting
  const [note, dispatch] = useReducer(noteReducer<TwAnswerView>, { shown: null, held: null })
  // An answer about an update under way follows the snapshot, as the status-bar mark does (it used
  // to keep the numbers of the moment Update was pressed: "0 MB of 289 MB" beside a mark at 21%).
  // When that update is over (cancelled elsewhere), the note goes.
  const following = note.shown?.live === true && snap !== null
  const current = following ? installAnswer(snap) : note.shown
  const ended = following && current === null
  useEffect(() => { if (ended) dispatch({ kind: 'dismiss' }) }, [ended])
  const view = presenting ? null : current
  useEffect(() => {
    const take = (event: Event): void => { const d = (event as CustomEvent<AnswerEventDetail>).detail; dispatch({ kind: 'answer', view: d?.view ?? null, busy: presentingNow.current || d?.busy === true }) }
    window.addEventListener(UPDATE_ANSWER_EVENT, take)
    // The answer of a check that waited for a talk to end: held if another talk has started since.
    const off = window.tw?.updates?.onAnswer?.((snap) => dispatch({ kind: 'answer', view: answerOf(snap), busy: presentingNow.current || snap.busy }))
    return () => { window.removeEventListener(UPDATE_ANSWER_EVENT, take); off?.() }
  }, [])
  useEffect(() => { dispatch({ kind: 'busy', busy: presenting }) }, [presenting])
  const setView = (next: TwAnswerView | null): void => dispatch(next ? { kind: 'answer', view: next, busy: presentingNow.current } : { kind: 'dismiss' })
  // A note without a button goes after six seconds. Keyed on what the note says, not on the view
  // object: a followed answer is a new object at every render (the status bar renders each second),
  // which would start the six seconds again for ever.
  const timed = view !== null && view.action === null ? `${view.tone}|${view.title}|${view.detail}` : null
  useEffect(() => {
    if (timed === null) return
    const timer = setTimeout(() => dispatch({ kind: 'dismiss' }), 6000)
    return () => clearTimeout(timer)
  }, [timed])
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

/** The buttons under an answer (the note and the Settings card). Every action goes through window.tw.updates. */
export function AnswerButtons({ view, onDone, onView, size }: { view: TwAnswerView; onDone?: () => void; onView?: (view: TwAnswerView) => void; size?: 'card' }) {
  const api = window.tw?.updates
  if (!api || view.action === null) return null
  const cls = (primary: boolean): string => `apu-update-btn${primary ? ' apu-update-btn--primary' : ''}`
  const again = async (): Promise<void> => { const snap = await api.check(); onView?.(answerOf(snap)) }
  const after = (snap: UpdateSnapshot): void => onView?.(answerOf(snap))
  const downloadButton = <button type="button" className={cls(view.action === 'download')} data-update-download onClick={() => { void api.download(); onDone?.() }}><Download size={13} aria-hidden /> {size === 'card' ? 'Download…' : 'Download from talkweaver.app'}</button>
  return (
    <div className="apu-update-actions">
      {view.action === 'update' && <button type="button" className={cls(true)} data-update-update onClick={() => { void api.update(view.version ?? '').then(after); }}><ArrowUpCircle size={13} aria-hidden /> Update</button>}
      {view.action === 'download' && downloadButton}
      {view.action === 'cancel' && <button type="button" className={cls(false)} data-update-cancel onClick={() => { void api.cancel().then(after) }}>Cancel</button>}
      {view.action === 'restart' && <button type="button" className={cls(true)} data-update-restart onClick={() => { void api.restart().then(after) }}><RotateCw size={13} aria-hidden /> Restart</button>}
      {view.action === 'retry-update' && <button type="button" className={cls(true)} data-update-retry onClick={() => { void api.update(view.version ?? '').then(after) }}>Try again</button>}
      {view.downloadLink && view.action !== 'download' && downloadButton}
      {view.action === 'stop-skipping' && <button type="button" className={cls(false)} data-update-stop-skipping onClick={() => { void api.stopSkipping().then(after) }}>Stop skipping</button>}
      {view.action === 'try-again' && <button type="button" className={cls(false)} data-update-try-again onClick={() => void again()}>Try again</button>}
      {view.action === 'open-store' && <button type="button" className={cls(false)} data-update-open-store onClick={() => { void api.openStore(); onDone?.() }}>Open in Microsoft Store</button>}
      {view.action === 'check' && <button type="button" className={cls(false)} data-update-check onClick={() => void again()}>Check for updates</button>}
      {view.whatsNew && view.version && <button type="button" className="apu-update-link" data-update-notes onClick={() => void api.openNotes(view.version!)}>What&rsquo;s new in {view.version}</button>}
    </div>
  )
}
