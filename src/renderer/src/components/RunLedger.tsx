// A Run's ledger (consistency batch 3, house rule R5): what History used to show for a delivered Run, now the
// Run's detail in the one Runs view. The recording (length against the plan, upload, Studio, notes), the handout and
// whether its page is still reachable, the polls, the feedback board, the instant slides, the questions and the
// reactions. Read and write paths are History's, unchanged: the same window.tw.history / window.tw.recording calls,
// the same Run files. Nothing here writes a Run that History did not.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Clock, Copy, ExternalLink, FileText, HardDrive, Image as ImageIcon, Link2, ListPlus, Mic, Pencil, Play, Timer, Type, VolumeX, Zap } from 'lucide-react'
import type { HistoryLiveCheck, RecordingKind, RecordingSession, RunInstantSlide } from '../../../preload/index'
import { recordingRunHome, recordingRunKey } from '../../../shared/recording-run-home'
import { runAudioSummary } from '../../../shared/run-audio'
import { runBoardKey } from '../../../shared/run-board'
import { plainTalkTitle } from '../../../shared/plain-title'
import type { SessionSource } from '../../../shared/sessions-list'
import { RunQuestions, RunReactions, type FeedbackSlide } from './RunLedgerFeedback'
import { RunBoardBlock, RunPollsBlock, RunShareDialog } from './RunLedgerBoard'
import { StateBadge } from './StateBadge'
import { clearUploadFailure, showUploadFailure } from '../lib/upload-failure-toast'
import '../run-ledger.css'

type LiveUi = { status: 'live' | 'offline' | 'checking' | 'unpub'; checkedAt: string | null }
const KIND_ORDER: RecordingKind[] = ['delivery', 'rehearsal', 'recording']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function normaliseUrl(url: string | null): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '')
}

function fmtMins(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

function fmtDate(iso: string): { dow: string; day: number; mon: string; year: number; time: string; monthName: string } {
  const d = new Date(iso)
  if (isNaN(d.getTime())) {
    return { dow: '—', day: 0, mon: '—', year: 0, time: '—', monthName: 'Unknown date' }
  }
  return {
    dow: DOW[d.getDay()],
    day: d.getDate(),
    mon: MON[d.getMonth()],
    year: d.getFullYear(),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    monthName: `${MON_LONG[d.getMonth()]} ${d.getFullYear()}`
  }
}

function checkedAgo(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

function hasRecordedAudio(s: RecordingSession): boolean {
  return s.audio !== null
}

function trimMs(s: RecordingSession): number {
  if (!s.trims?.length) return 0
  return s.trims.reduce((sum, trim) => {
    const start = Math.max(0, Math.min(s.recordingMs, trim.start))
    const end = Math.max(0, Math.min(s.recordingMs, trim.end))
    return end > start ? sum + end - start : sum
  }, 0)
}

function normaliseKind(kind: RecordingSession['kind'] | undefined): RecordingKind {
  return kind === 'rehearsal' || kind === 'recording' ? kind : 'delivery'
}

function kindLabel(kind: RecordingKind): string {
  return kind === 'delivery' ? 'Delivery' : kind === 'rehearsal' ? 'Rehearsal' : 'Recording'
}

function deliveredMs(s: RecordingSession): number {
  return hasRecordedAudio(s) ? Math.max(0, s.recordingMs - trimMs(s)) : s.wallClockMs
}

function deltaOf(s: RecordingSession): { cls: string; text: string } | null {
  if (!s.timerTargetMin) return null
  const actual = Math.round(deliveredMs(s) / 60000)
  const delta = actual - s.timerTargetMin
  if (Math.abs(delta) < 1) return { cls: 'onpar', text: 'on par' }
  return delta > 0 ? { cls: 'over', text: `+${delta}m` } : { cls: 'under', text: `−${Math.abs(delta)}m` }
}

function waveBars(session: RecordingSession): number[] {
  const seed = session.id.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) + Math.round(deliveredMs(session) / 1000)
  return Array.from({ length: 11 }, (_v, i) => 4 + ((seed * (i + 3)) % 12))
}


type InstantAnchor = { slideNumber: number; title: string }

function clockTime(ms: number): string {
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
}

function countdownDigits(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function instantKind(entry: RunInstantSlide): { icon: JSX.Element; label: string; text: string } {
  if (entry.kind === 'link') return { icon: <Link2 className="lt-icon" />, label: 'Link', text: entry.url ?? '' }
  if (entry.kind === 'countdown') {
    const minutes = Math.round((entry.durationMs ?? 0) / 60_000)
    return { icon: <Timer className="lt-icon" />, label: `Countdown · ${minutes >= 1 ? `${minutes} min` : `${Math.round((entry.durationMs ?? 0) / 1000)} s`}`, text: (entry.label || 'Countdown') + (entry.link ? ` · ${entry.link.replace(/^https?:\/\//, '')}` : '') }
  }
  if (entry.kind === 'time') return { icon: <Clock className="lt-icon" />, label: 'Clock', text: 'Current time' }
  if (entry.kind === 'image') return { icon: <ImageIcon className="lt-icon" />, label: 'Image', text: `Image shown live · ${entry.width ?? '?'} × ${entry.height ?? '?'}` }
  return { icon: <Type className="lt-icon" />, label: entry.link ? 'Text and link' : 'Text', text: entry.link ? `${entry.text ?? ''} · ${entry.link.replace(/^https?:\/\//, '')}` : entry.text ?? '' }
}

function InstantThumb({ entry }: { entry: RunInstantSlide }): JSX.Element {
  if (entry.kind === 'image' && entry.dataUrl) return <img className="isl-th-img" src={entry.dataUrl} alt="" />
  if (entry.kind === 'countdown') return <span className="isl-th-clock"><small>{entry.label || 'Countdown'}</small>{countdownDigits(entry.durationMs ?? 0)}</span>
  if (entry.kind === 'time') return <span className="isl-th-clock">{clockTime(entry.shownAt)}</span>
  if (entry.kind === 'link') return <span className="isl-th-link"><Link2 className="lt-icon" />{(entry.url ?? '').replace(/^https?:\/\//, '')}</span>
  return <span className="isl-th-text">{entry.text}{entry.link ? ` · ${entry.link.replace(/^https?:\/\//, '')}` : ''}</span>
}

// Frame L6: the instant slides shown during the Run, inside the selected Run's card.
function InstantSlidesShown(props: {
  entries: RunInstantSlide[]
  anchors: Record<string, InstantAnchor | null> | undefined
  busyId: string | null
  errors: Record<string, string>
  onAdd: (entry: RunInstantSlide) => void
}): JSX.Element {
  return (
    <div className="isl" data-history-instant onClick={(e) => e.stopPropagation()}>
      <div className="isl-h">
        <span className="t"><Zap className="lt-icon" /> Instant slides shown · {props.entries.length}</span>
        <small>“Add to talk” puts the slide into the talk after the slide it followed.</small>
      </div>
      {props.entries.map((entry) => {
        const kind = instantKind(entry)
        const anchor = props.anchors?.[entry.id]
        const resolved = props.anchors !== undefined
        const error = props.errors[entry.id]
        return (
          <div className="isl-row" key={entry.id} data-instant-id={entry.id}>
            <div className="isl-th"><InstantThumb entry={entry} /></div>
            <div className="isl-what">
              <div className="isl-kind">{kind.icon} {kind.label}</div>
              <div className="isl-text" title={kind.text}>{kind.text}</div>
            </div>
            <div className="isl-when">
              <b>{clockTime(entry.shownAt)}</b>
              {!entry.afterSlideId ? <> · before the first slide</>
                : anchor ? <> · after slide {anchor.slideNumber}<span>{anchor.title}</span></>
                  : entry.added ? <> · after slide {entry.added.afterSlideNumber}<span>{entry.added.afterSlideTitle}</span></>
                    : resolved ? <> · after a slide no longer in the talk<span>{entry.afterSlideId}</span></>
                      : <> · after <span>{entry.afterSlideId}</span></>}
            </div>
            {entry.added ? (
              <StateBadge state="published" small className="isl-add done"><Check className="lt-icon" /> Added after slide {entry.added.afterSlideNumber}</StateBadge>
            ) : (
              <button
                className="tw-btn tw-btn--sm isl-add"
                disabled={props.busyId === entry.id || entry.kind === 'time'}
                title={entry.kind === 'time' ? 'A live clock has no slide form in the talk' : 'Insert this slide into the talk after the slide it followed'}
                onClick={(e) => { e.stopPropagation(); props.onAdd(entry) }}
              >
                <ListPlus className="lt-icon" /> {props.busyId === entry.id ? 'Adding…' : 'Add to talk'}
              </button>
            )}
            {error ? <div className="isl-err" role="alert">{error}</div> : null}
          </div>
        )
      })}
    </div>
  )
}


function LiveBadge({ live, onRecheck }: { live: LiveUi; onRecheck: () => void }): JSX.Element {
  if (live.status === 'checking') return <StateBadge state="planned" small>Checking…</StateBadge>
  if (live.status === 'unpub') return <StateBadge state="planned" small>Not published</StateBadge>
  return (
    <>
      <StateBadge state={live.status === 'live' ? 'published' : 'notset'} small>{live.status === 'live' ? 'Still live' : 'Offline'}</StateBadge>
      <span className="rl-dim">checked {checkedAgo(live.checkedAt)}</span>
      <button type="button" className="tw-btn tw-btn--text" data-run-recheck title="Re-check whether it is still live (L)" onClick={(e) => { e.stopPropagation(); onRecheck() }}>Re-check</button>
    </>
  )
}

type Handouts = Record<string, { title?: string; handoutUrl?: string | null; outlinePath?: string }>

/**
 * The selected Run's ledger sections. `source` is the Runs-list entry; the full Run is read from its own vault
 * (or from this computer's app data for a kept Run) with the calls History made. `version` changes when the list
 * is read again, so the sections read the Run again too. It returns the sections only; the page around them is RunPage's.
 */
export function RunLedger({ source, version, onOpenStudio, onOpenNotes, onChanged, flash, onAskDelete }: {
  source: SessionSource
  version: number
  onOpenStudio: (run: RecordingSession) => void
  onOpenNotes: (run: RecordingSession) => void
  /** The Run changed on disk (kind, context, upload, board): the list is read again. */
  onChanged: () => void
  flash: (message: string) => void
  /** Delete this Run: the Runs view asks first with the one confirm card. */
  onAskDelete: (run: RecordingSession) => void
}): JSX.Element | null {
  const kept = source.kept === 'app-data'
  const [run, setRun] = useState<RecordingSession | null>(null)
  const [talk, setTalk] = useState<Handouts[string] | null>(null)
  const [live, setLive] = useState<LiveUi>({ status: 'checking', checkedAt: null })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [instantAnchors, setInstantAnchors] = useState<Record<string, InstantAnchor | null>>({})
  const [feedbackSlides, setFeedbackSlides] = useState<Record<string, FeedbackSlide | null>>({})
  const [instantBusy, setInstantBusy] = useState<string | null>(null)
  const [instantErrors, setInstantErrors] = useState<Record<string, string>>({})
  const [boardBusy, setBoardBusy] = useState<'refresh' | 'close' | null>(null)
  const [boardPulled, setBoardPulled] = useState<number | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  // Studio lists the primary vault's recordings and kept ones only; another open vault's Run cannot be opened there.
  // Unknown until Studio's list has answered for THIS Run: both actions stay disabled meanwhile.
  const [studioAnswer, setStudioAnswer] = useState<{ key: string; listed: boolean } | null>(null)

  // One read at a time is the current one: a reply for a Run that is no longer on show (or an older read) is dropped,
  // so the sections and the actions below always belong to the selected Run.
  const readId = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const mine = ++readId.current
    try {
      const vaultArg = kept ? undefined : source.vaultId
      const [runs, talks] = await Promise.all([window.tw.history.listRuns(source.talkSlug, vaultArg), kept ? Promise.resolve({} as Handouts) : window.tw.history.talkHandouts(vaultArg)])
      if (mine !== readId.current) return
      const found = runs.find((candidate) => candidate.id === source.runId && (kept ? candidate.kept === 'app-data' : candidate.kept !== 'app-data')) ?? null
      setRun(found)
      setTalk((talks as Handouts)[source.talkSlug] ?? null)
    } catch (cause) {
      if (mine !== readId.current) return
      console.error('[runs] the Run could not be read', cause)
      setRun(null)
    }
  }, [kept, source.runId, source.talkSlug, source.vaultId])
  useEffect(() => { void load(); return () => { readId.current += 1 } }, [load, version])
  // A different Run: nothing of the last one stays open.
  useEffect(() => { setRun(null); setEditing(false); setBoardPulled(null); setShareOpen(false); setInstantErrors({}); setInstantAnchors({}); setFeedbackSlides({}) }, [source.vaultId, source.talkSlug, source.runId])

  const runKey = run ? recordingRunKey(run) : null
  useEffect(() => {
    if (!run?.audio || !runKey) return
    let gone = false
    void window.tw.recording.listAllSessions().then((all) => { if (!gone) setStudioAnswer({ key: runKey, listed: all.some((candidate) => recordingRunKey(candidate) === runKey) }) }).catch(() => { if (!gone) setStudioAnswer({ key: runKey, listed: false }) })
    return () => { gone = true }
  }, [run, runKey])
  const studioState: 'checking' | 'yes' | 'no' = studioAnswer && studioAnswer.key === runKey ? (studioAnswer.listed ? 'yes' : 'no') : 'checking'
  const inStudio = studioState === 'yes'
  const studioWhy = (what: string): string | undefined => studioState === 'yes' ? undefined : studioState === 'checking' ? 'Checking…' : `${what} reads recordings from the main vault and from this Mac only. This Run belongs to another open vault.`
  const home = run ? recordingRunHome(run) : undefined
  const handoutUrl = normaliseUrl(run?.handoutUrl ?? null)
  const evergreenUrl = normaliseUrl(talk?.handoutUrl ?? null)
  const title = plainTalkTitle(talk?.title || run?.talkTitle || source.talkTitle)

  const checkLive = useCallback(async (url: string, force: boolean): Promise<HistoryLiveCheck> => {
    setLive({ status: 'checking', checkedAt: null })
    const res = await window.tw.history.checkLive(url, force)
    setLive({ status: res.status, checkedAt: res.checkedAt })
    return res
  }, [])
  useEffect(() => {
    if (!handoutUrl) { setLive({ status: 'unpub', checkedAt: null }); return }
    let cancelled = false
    setLive({ status: 'checking', checkedAt: null })
    void window.tw.history.checkLive(handoutUrl, false).then((res) => { if (!cancelled) setLive({ status: res.status, checkedAt: res.checkedAt }) })
      .catch(() => { if (!cancelled) setLive({ status: 'offline', checkedAt: new Date().toISOString() }) })
    return () => { cancelled = true }
  }, [handoutUrl])

  // The slides the Run's instant slides, questions, reactions, polls and boards name, as the talk is now.
  const instantKey = run && home !== null && run.instantSlides?.length ? run.instantSlides.map((e) => e.id + (e.added ? '+' : '')).join(',') : ''
  useEffect(() => {
    if (!instantKey || !run) return
    let cancelled = false
    void window.tw.history.instantAnchors(run.talkSlug, run.id, home).then((anchors) => { if (!cancelled) setInstantAnchors(anchors ?? {}) }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instantKey, run?.id])
  const feedbackKey = run && home !== null && (run.questions?.length || run.reactions?.length || run.boards?.length || run.polls?.length)
    ? `${run.questions?.length ?? 0}|${run.reactions?.length ?? 0}|${run.boards?.length ?? 0}|${run.polls?.length ?? 0}` : ''
  useEffect(() => {
    if (!feedbackKey || !run) return
    let cancelled = false
    void window.tw.history.feedbackSlides(run.talkSlug, run.id, home).then((slides) => { if (!cancelled) setFeedbackSlides(slides ?? {}) }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackKey, run?.id])

  const addInstantSlide = useCallback(async (entry: RunInstantSlide): Promise<void> => {
    if (!run || recordingRunHome(run) === null) return
    setInstantBusy(entry.id)
    setInstantErrors((prev) => { const next = { ...prev }; delete next[entry.id]; return next })
    try {
      const result = await window.tw.history.addInstantSlide(run.talkSlug, run.id, entry.id, recordingRunHome(run))
      if (result.ok) {
        setRun({ ...result.run, home: run.home, kept: run.kept })
        flash(result.warning ?? `Added to the talk after slide ${result.afterSlideNumber}.`)
      } else setInstantErrors((prev) => ({ ...prev, [entry.id]: result.error }))
    } catch {
      setInstantErrors((prev) => ({ ...prev, [entry.id]: 'The slide could not be added. Nothing was changed.' }))
    } finally { setInstantBusy(null) }
  }, [flash, run])

  const replaceRun = useCallback((next: RecordingSession): void => {
    setRun((current) => current ? { ...next, home: current.home, kept: current.kept } : current)
    onChanged()
  }, [onChanged])

  const pullBoard = useCallback(async (kind: 'refresh' | 'close'): Promise<void> => {
    if (!run || boardBusy || recordingRunHome(run) === null) return
    setBoardBusy(kind)
    try {
      const result = kind === 'close'
        ? await window.tw.history.boardClose(run.talkSlug, run.id, recordingRunHome(run))
        : await window.tw.history.boardRefresh(run.talkSlug, run.id, recordingRunHome(run))
      if (result.run) replaceRun(result.run)
      if (!result.ok) { flash(result.error); return }
      if (kind === 'close') {
        setBoardPulled(null)
        flash(result.added ? `Board closed · ${result.added} late card${result.added === 1 ? '' : 's'} pulled in` : 'Board closed · the Run keeps it as it is')
      } else {
        setBoardPulled(result.added)
        flash(result.warning ?? (result.added ? `${result.added} late card${result.added === 1 ? '' : 's'} pulled in` : 'No new cards on the board'))
      }
    } catch { flash('The board could not be reached') } finally { setBoardBusy(null) }
  }, [boardBusy, flash, replaceRun, run])

  const putBackCard = useCallback(async (boardId: string, sessionId: string | undefined, cardId: string, putBack: boolean): Promise<void> => {
    if (!run || recordingRunHome(run) === null) return
    const result = await window.tw.history.boardPutBack(run.talkSlug, run.id, boardId, sessionId, cardId, putBack, recordingRunHome(run))
      .catch(() => ({ ok: false as const, error: 'The card could not be changed.' }))
    if (!result.ok) { flash(result.error); return }
    replaceRun(result.run)
    flash(result.warning ?? (putBack ? 'Card put back: on the board and the share link' : 'Card hidden again'))
  }, [flash, replaceRun, run])

  const commitContext = useCallback(async (): Promise<void> => {
    if (!run) { setEditing(false); return }
    const next = draft.trim()
    if (next !== (run.context ?? '')) {
      const res = await window.tw.recording.setContext(run.talkSlug, run.id, next, recordingRunHome(run))
      if (res.ok) { setRun({ ...run, context: next }); flash('Context updated'); onChanged() } else flash('Context could not be updated')
    }
    setEditing(false)
  }, [draft, flash, onChanged, run])

  const changeKind = useCallback(async (kind: RecordingKind): Promise<void> => {
    if (!run || normaliseKind(run.kind) === kind) return
    const res = await window.tw.recording.setKind(run.talkSlug, run.id, kind, recordingRunHome(run))
    if (res.ok) { setRun({ ...run, kind: res.kind ?? kind }); flash(`Changed to ${kindLabel(res.kind ?? kind)}`); onChanged() } else flash('Kind could not be changed')
  }, [flash, onChanged, run])

  const upload = useCallback(async (): Promise<void> => {
    if (!run?.audio || run.audio.uploaded || uploadBusy) return
    setUploadBusy(true)
    try {
      const res = await window.tw.recording.upload(run.talkSlug, run.id, recordingRunHome(run))
      if (res.ok && res.uploaded) { clearUploadFailure(); flash('Uploaded'); await load(); onChanged() } else showUploadFailure(res.error)
    } finally { setUploadBusy(false) }
  }, [flash, load, onChanged, run, uploadBusy])

  if (!run) return null
  const recorded = hasRecordedAudio(run)
  const kind = normaliseKind(run.kind)
  const delta = deltaOf(run)
  const audio = runAudioSummary(run)
  const started = fmtDate(run.startedAt)
  const rkey = recordingRunKey(run)
  const hasResults = !!(run.polls?.length || run.boards?.length || (home !== null && run.instantSlides?.length) || run.questions?.length || run.reactions?.length)

  return (
    <>
      <section className="tw-run-sec tw-run-ledger" data-run-ledger={rkey} data-history-sid={run.id}>
        <header><Mic aria-hidden /><span>Delivery</span><span className="meta">{started.day ? `${started.dow} ${started.day} ${started.mon} ${started.year} · ${started.time}` : ''}</span></header>
        <div className="rl-body">
          <div className="rl-row" data-run-kind={kind}>
            <span className="rl-lab">Kind</span>
            <span className="rl-ctl" role="group" aria-label="Kind of Run">
              {KIND_ORDER.map((candidate) => (
                <button key={candidate} type="button" className="tw-btn tw-btn--chip" aria-pressed={kind === candidate} onClick={() => void changeKind(candidate)}>{kindLabel(candidate)}</button>
              ))}
            </span>
          </div>
          <div className="rl-row">
            <span className="rl-lab">Context</span>
            <span className="rl-ctl rl-context">
              {run.kept === 'app-data' ? <StateBadge state="notset" small>Kept on this Mac</StateBadge> : null}
              {editing ? (
                <input className="rl-input" value={draft} autoFocus aria-label="Context" onChange={(e) => setDraft(e.target.value)} onBlur={() => void commitContext()}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitContext(); else if (e.key === 'Escape') setEditing(false) }} />
              ) : (
                <>
                  <span className="rl-text">{run.audience ? `${run.audience}` : run.context || title}</span>
                  <button type="button" className="tw-btn tw-btn--quiet tw-btn--sm tw-btn--icon" data-run-edit-context aria-label="Edit context" title="Edit context (E)" onClick={() => { setDraft(run.context ?? ''); setEditing(true) }}><Pencil aria-hidden /></button>
                </>
              )}
            </span>
          </div>
          <div className="rl-row" data-run-recording={recorded ? 'yes' : 'no'}>
            <span className="rl-lab">Audio</span>
            <span className="rl-ctl rl-rec">
              <span className={`rl-wave${recorded ? '' : ' muted'}`} aria-hidden>
                {recorded ? waveBars(run).map((h, i) => <span key={i} style={{ height: h }} />) : <VolumeX />}
              </span>
              {recorded ? (
                <>
                  <b>{fmtMins(deliveredMs(run))}</b>
                  {run.trims?.length ? <span className="rl-dim">raw {fmtMins(run.recordingMs)}</span> : null}
                  {audio.label ? <span className="rl-warn" title="The audio is shorter than the recording: the microphone input was lost.">{audio.label}</span> : null}
                </>
              ) : (<><span className="rl-dim">Not recorded</span><b>{fmtMins(run.wallClockMs)} delivered</b></>)}
              {run.timerTargetMin ? <span className="rl-dim">planned {run.timerTargetMin}m</span> : null}
              {delta ? <span className={`rl-delta ${delta.cls}`}>{delta.text}</span> : null}
            </span>
          </div>
          {recorded && (
            <div className="rl-row rl-actions">
              <span className="rl-lab" />
              <span className="rl-ctl">
                <button type="button" className="tw-btn tw-btn--sm" data-run-open-studio disabled={!inStudio} title={studioWhy('Studio plays')} onClick={() => onOpenStudio(run)}><Play aria-hidden />Open in Studio</button>
                <button type="button" className="tw-btn tw-btn--sm" data-run-open-notes disabled={!inStudio} title={studioWhy('Manage notes')} onClick={() => onOpenNotes(run)}><FileText aria-hidden />Manage notes</button>
                {run.audio?.uploaded ? <StateBadge state="published" small><Check aria-hidden />Uploaded</StateBadge> : (
                  <>
                    <StateBadge state="planned" small><HardDrive aria-hidden />On this Mac</StateBadge>
                    <button type="button" className="tw-btn tw-btn--sm" data-run-upload title="Upload the local audio (U)" disabled={uploadBusy} onClick={() => void upload()}>{uploadBusy ? 'Uploading…' : 'Upload'}</button>
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="tw-run-sec tw-run-ledger" data-run-handout-status={live.status}>
        <header><ExternalLink aria-hidden /><span>Handout</span></header>
        <div className="rl-body">
          <div className="rl-row">
            <span className="rl-lab">Run handout</span>
            <span className="rl-ctl rl-ho">
              {handoutUrl ? (
                <>
                  <button type="button" className="tw-btn tw-btn--text rl-url" data-run-open-handout title={`${handoutUrl} (O)`} onClick={() => { void window.tw.shell.openExternal(handoutUrl); flash('Opening handout in your browser') }}>{displayUrl(handoutUrl)}</button>
                  <button type="button" className="tw-btn tw-btn--quiet tw-btn--sm tw-btn--icon" data-run-copy-handout aria-label="Copy handout link" title="Copy handout link (C)" onClick={() => { void navigator.clipboard?.writeText(handoutUrl); flash('Handout link copied') }}><Copy aria-hidden /></button>
                  <LiveBadge live={live} onRecheck={() => { void checkLive(handoutUrl, true).then((res) => flash(`Handout re-checked — ${res.status === 'live' ? 'still live' : 'offline'}`)) }} />
                </>
              ) : (<><span className="rl-dim">No handout published</span><LiveBadge live={live} onRecheck={() => {}} /></>)}
            </span>
          </div>
          {evergreenUrl && (
            <div className="rl-row">
              <span className="rl-lab">Talk handout</span>
              <span className="rl-ctl rl-ho"><button type="button" className="tw-btn tw-btn--text rl-url" onClick={() => void window.tw.shell.openExternal(evergreenUrl)}>{displayUrl(evergreenUrl)}</button><span className="rl-dim">the talk's latest full version</span></span>
            </div>
          )}
        </div>
      </section>

      {hasResults && (
        <section className="tw-run-sec tw-run-ledger tw-run-results" data-run-results>
          <header><Zap aria-hidden /><span>During the talk</span></header>
          <div className="rl-body rl-blocks">
            {run.polls?.length ? <RunPollsBlock run={run} slides={feedbackSlides} /> : null}
            {home !== null ? (run.boards ?? []).map((board) => (
              <RunBoardBlock
                key={runBoardKey(board)}
                sameBoardTwice={(run.boards ?? []).filter((other) => other.id === board.id).length > 1}
                run={run}
                talkTitle={title}
                board={board}
                slide={board.slideId ? feedbackSlides[board.slideId] : undefined}
                now={Date.now()}
                busy={boardBusy}
                pulled={boardPulled}
                onRefresh={() => void pullBoard('refresh')}
                onCloseNow={() => void pullBoard('close')}
                onPutBack={(cardId, putBack) => void putBackCard(board.id, board.sessionId, cardId, putBack)}
                onShare={() => setShareOpen(true)}
                flash={flash}
              />
            )) : null}
            {home !== null && run.instantSlides?.length ? (
              <InstantSlidesShown entries={run.instantSlides} anchors={instantAnchors} busyId={instantBusy} errors={instantErrors} onAdd={(entry) => void addInstantSlide(entry)} />
            ) : null}
            {run.questions?.length ? <RunQuestions questions={run.questions} startedAt={run.startedAt} slides={feedbackSlides} /> : null}
            {run.reactions?.length ? <RunReactions reactions={run.reactions} slides={feedbackSlides} /> : null}
          </div>
        </section>
      )}

      <div className="tw-run-ledger-foot">
        <button type="button" className="tw-btn tw-btn--quiet tw-btn--sm" data-run-delete onClick={() => onAskDelete(run)}>Delete this Run…</button>
      </div>
      {shareOpen && <div className="rs-scrim" onClick={() => setShareOpen(false)}><RunShareDialog run={run} talkTitle={title} onClose={() => setShareOpen(false)} flash={flash} /></div>}
    </>
  )
}
