// History, the selected Run's card: its feedback boards and poll results (feedback-boards ticket 06;
// drawings R1, R3–R5, R7–R9 and H1 in docs/design/2026-09-28-feedback-boards/round-2/shots).
// Every card, answer and question is audience or author text: rendered as React text, never markup.
// A card's name (when a board took names) is never shown here; hidden cards are listed apart,
// "kept here and never on the share link", with Put back.
import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, CheckCircle2, Clipboard, EyeOff, Eye, Hourglass, LayoutGrid, Link2, Lock, RefreshCw } from 'lucide-react'
import type { RecordingSession, RunBoard, RunResultsShareState } from '../../../preload/index'
import { runBoardMarkdown, runBoardState, runBoardView, type RunBoardEntry } from '../../../shared/run-board'
import { pollTypeWord, runPollSummaries, type RunPollSummary } from '../../../shared/run-poll-results'
import { DEFAULT_RUN_SHARE_LIFETIME, runShareOptions, type RunShareLifetime } from '../../../shared/run-results-share'
import { preworkEnabled } from '../../../shared/prework-flag'

type Slide = { slideNumber: number; title: string } | null | undefined
const ENTRIES_SHOWN = 7

// Date words fixed here ("Sep", never the locale's "Sept"), as the drawings write them.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function shortTime(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function dayDate(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}
function dayMonthYear(ms: number): string {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}
function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "Board open · 4 late cards" for the ledger row (R9), or null when no board of the Run is left open. */
export function boardLedgerBadge(run: RecordingSession, now: number): string | null {
  const open = (run.boards ?? []).filter((board) => runBoardState(board, now) === 'open')
  if (!open.length) return null
  const late = open.reduce((sum, board) => sum + runBoardView(board).lateCount, 0)
  return `Board open${late ? ` · ${late} late card${late === 1 ? '' : 's'}` : ''}`
}

function Entry({ entry }: { entry: RunBoardEntry }): JSX.Element {
  if (entry.kind === 'group') {
    return (
      <div className={`rb-card group${entry.late ? ' late' : ''}`} data-board-group={entry.n}>
        <span className="rb-n">{entry.n}</span>
        <span className="rb-t">{entry.text}</span>
        {entry.late ? <span className="rb-late">LATE</span> : null}
        {entry.count > 1 ? <span className="rb-x">×{entry.count}</span> : null}
      </div>
    )
  }
  return (
    <div className={`rb-card${entry.late ? ' late' : ''}`} data-board-card={entry.id}>
      <span className="rb-n" />
      <span className="rb-t">{entry.text}</span>
      {entry.late ? <span className="rb-late">LATE</span> : null}
    </div>
  )
}

export function RunBoardBlock(props: {
  run: RecordingSession
  /** The talk's title as History shows it. */
  talkTitle: string
  board: RunBoard
  /** The Run holds this authored board from more than one live session: name the session. */
  sameBoardTwice?: boolean
  slide: Slide
  now: number
  busy: 'refresh' | 'close' | null
  /** The last refresh's result, shown in the green banner (R4). */
  pulled: number | null
  onRefresh: () => void
  onCloseNow: () => void
  onPutBack: (cardId: string, putBack: boolean) => void
  onShare: () => void
  flash: (message: string) => void
}): JSX.Element {
  const { board, run } = props
  const view = useMemo(() => runBoardView(board), [board])
  const state = runBoardState(board, props.now)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showHidden, setShowHidden] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const popover = useRef<HTMLDivElement>(null)
  const hiddenRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!copied) return
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !popover.current?.contains(event.target as Node)) setCopied(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [copied])

  useEffect(() => { if (showHidden) hiddenRef.current?.scrollIntoView({ block: 'nearest' }) }, [showHidden])

  const copyMarkdown = async (): Promise<void> => {
    const started = Date.parse(run.startedAt)
    const text = runBoardMarkdown(board, { talkTitle: props.talkTitle || run.talkTitle, event: run.eventTitle,
      date: Number.isFinite(started) ? dayMonthYear(started) : run.plannedDate })
    try { await navigator.clipboard.writeText(text) } catch { props.flash('The clipboard could not be written'); return }
    setCopied(text)
  }

  const where = [props.slide ? `slide ${props.slide.slideNumber}` : null,
    props.sameBoardTwice && board.liveStartedAt ? `live session from ${shortTime(board.liveStartedAt)}` : null,
    state === 'open' ? 'still open' : board.closedAt ? `closed ${dayDate(board.closedAt)}` : board.liveEndedAt ? 'closed at End live' : 'live'].filter(Boolean).join(' · ')

  return (
    <div className="rb" data-history-board={board.id} data-board-session={board.sessionId ?? ''} onClick={(e) => e.stopPropagation()}>
      <div className="rb-h">
        <span className="t"><LayoutGrid className="lt-icon" /> Board · {view.cardCount} card{view.cardCount === 1 ? '' : 's'}</span>
        <span className="q">“{board.question || 'Board'}” · {where}</span>
        <span className="push" />
        <button className="rb-act" data-board-copy onClick={() => void copyMarkdown()}><Clipboard className="lt-icon" /> Copy as Markdown</button>
        <button className="rb-act" data-board-share onClick={props.onShare}><Link2 className="lt-icon" /> Share read-only link</button>
      </div>

      {state === 'open' ? (
        props.pulled !== null ? (
          <div className="rb-banner pulled" data-board-banner="pulled">
            <CheckCircle2 className="lt-icon" />
            <span><b>{props.pulled} late card{props.pulled === 1 ? '' : 's'} pulled in just now.</b> The board is still open; refresh again later, or close it.</span>
            <span className="push" />
            <button className="rb-bt" disabled={props.busy !== null} onClick={props.onRefresh}><RefreshCw className="lt-icon" /> {props.busy === 'refresh' ? 'Refreshing…' : 'Refresh from the board'}</button>
            <button className="rb-bt ghost" disabled={props.busy !== null} onClick={props.onCloseNow}><Lock className="lt-icon" /> {props.busy === 'close' ? 'Closing…' : 'Close it now'}</button>
          </div>
        ) : (
          <div className="rb-banner open" data-board-banner="open">
            <Hourglass className="lt-icon" />
            <span><b>Still open for late cards.</b> Pulled into this Run {board.refreshedAt ? `last at ${shortTime(board.refreshedAt)}` : board.liveEndedAt ? `when the talk ended, ${shortTime(board.liveEndedAt)}` : 'when the talk ended'}. It closes by itself on {dayDate(board.openUntil!)} unless you close it here first.</span>
            <span className="push" />
            <button className="rb-bt dark" disabled={props.busy !== null} onClick={props.onRefresh}><RefreshCw className="lt-icon" /> {props.busy === 'refresh' ? 'Refreshing…' : 'Refresh from the board'}</button>
            <button className="rb-bt ghost" disabled={props.busy !== null} onClick={props.onCloseNow}><Lock className="lt-icon" /> {props.busy === 'close' ? 'Closing…' : 'Close it now'}</button>
          </div>
        )
      ) : board.closedBy === 'superseded' && board.closedAt !== undefined ? (
        <div className="rb-banner open" data-board-banner="superseded">
          <Lock className="lt-icon" />
          <span><b>Starting a new live session closed the board left open from {board.liveEndedAt ? shortTime(board.liveEndedAt) : 'the talk'}.</b> Its cards are kept here.</span>
        </div>
      ) : board.openUntil !== undefined && board.closedAt === undefined ? (
        <div className="rb-banner open" data-board-banner="closing">
          <Hourglass className="lt-icon" />
          <span><b>Closed by itself on {dayDate(board.openUntil)}.</b> Refresh once to pull the last late cards into this Run.</span>
          <span className="push" />
          <button className="rb-bt dark" disabled={props.busy !== null} onClick={props.onRefresh}><RefreshCw className="lt-icon" /> {props.busy === 'refresh' ? 'Refreshing…' : 'Refresh from the board'}</button>
        </div>
      ) : null}

      <div className="rb-cols" style={{ gridTemplateColumns: `repeat(${Math.max(1, view.columns.length)}, minmax(0, 1fr))` }}>
        {view.columns.map((column) => {
          const open = expanded[column.id]
          const shown = open ? column.entries : column.entries.slice(0, ENTRIES_SHOWN)
          const more = column.entries.length - shown.length
          return (
            <div className="rb-col" key={column.id} data-board-column={column.id}>
              <div className="rb-col-h"><b>{column.label}</b><small>{column.count}</small></div>
              {shown.map((entry) => <Entry key={entry.kind === 'group' ? `g${entry.n}` : entry.id} entry={entry} />)}
              {more > 0 ? <button className="rb-more" onClick={() => setExpanded((prev) => ({ ...prev, [column.id]: true }))}>+ {more} more</button> : null}
              {open && column.entries.length > ENTRIES_SHOWN ? <button className="rb-more" onClick={() => setExpanded((prev) => ({ ...prev, [column.id]: false }))}>Show fewer</button> : null}
              {!column.entries.length ? <div className="rb-empty">No cards</div> : null}
            </div>
          )
        })}
      </div>

      {view.hidden.length ? (
        <div className="rb-hidden" ref={hiddenRef} data-board-hidden={view.hidden.length}>
          <div className="rb-hidden-line">
            <EyeOff className="lt-icon" />
            <span>{view.hidden.length} hidden card{view.hidden.length === 1 ? '' : 's'}, kept here and never on the share link.</span>
            <button onClick={() => setShowHidden((value) => !value)}>{showHidden ? 'Hide these' : 'Show'}</button>
          </div>
          {showHidden ? view.hidden.map((card) => (
            <div className="rb-hidden-row" key={card.id} data-hidden-card={card.id}>
              <div>
                <div className="rb-t">{card.text}</div>
                <small>{card.columnLabel} · hidden during the talk{board.liveEndedAt && card.acceptedAt > board.liveEndedAt ? ' · a late card' : ` · sent ${clock(card.acceptedAt)}`} · kept here only</small>
              </div>
              <button onClick={() => props.onPutBack(card.id, true)}><Eye className="lt-icon" /> Put back</button>
            </div>
          )) : null}
        </div>
      ) : null}
      {board.cards.some((card) => card.putBack) ? (
        <div className="rb-putback-note">
          {board.cards.filter((card) => card.putBack).map((card) => (
            <span key={card.id} data-put-back={card.id}>Put back: “{card.text}” <button onClick={() => props.onPutBack(card.id, false)}>Hide again</button></span>
          ))}
        </div>
      ) : null}

      {copied !== null ? (
        <div className="rb-pop" ref={popover} role="dialog" aria-label="Copied as Markdown" data-board-markdown>
          <div className="rb-pop-h"><CheckCircle2 className="lt-icon" /> Copied as Markdown</div>
          <pre>{copied}</pre>
          <small>Groups keep their numbers and counts; hidden cards are left out.</small>
        </div>
      ) : null}
    </div>
  )
}

function PollBars({ summary }: { summary: Extract<RunPollSummary, { kind: 'bars' }> }): JSX.Element {
  const max = Math.max(1, ...summary.rows.map((row) => row.count))
  return (
    <div className="rp-bars">
      {summary.rows.map((row, i) => (
        <div className="rp-bar" key={i}><span className="l">{row.label}</span><span className="track"><span style={{ width: `${Math.round(row.count / max * 100)}%` }} /></span><b>{row.count}</b></div>
      ))}
    </div>
  )
}

const SHADES = ['#eadbcf', '#e9a57c', '#c9531c', '#7a2e12', '#4a1a0a', '#2b0f06']

function PollScale({ summary }: { summary: Extract<RunPollSummary, { kind: 'scale' }> }): JSX.Element {
  return (
    <div className="rp-scale">
      {summary.rows.map((row, i) => {
        const total = row.counts.reduce((sum, n) => sum + n, 0)
        return (
          <div className="rp-srow" key={i}>
            <span className="l">{row.label}</span>
            <span className="stack">{row.counts.map((n, j) => n ? <span key={j} title={`${summary.labels[j]}: ${n}`} style={{ width: `${n / Math.max(1, total) * 100}%`, background: SHADES[j % SHADES.length] }} /> : null)}</span>
            <b>{total}</b>
          </div>
        )
      })}
      <div className="rp-legend">{summary.labels.map((label, j) => <span key={j}><i style={{ background: SHADES[j % SHADES.length] }} />{label}</span>)}</div>
    </div>
  )
}

/** H1: the Run's live polls with their counts ("Compare with other runs" comes with ticket 12). */
export function RunPollsBlock({ run, slides }: { run: RecordingSession; slides: Record<string, Slide> | undefined }): JSX.Element | null {
  const summaries = useMemo(() => runPollSummaries(run), [run])
  if (!summaries.length) return null
  return (
    <div className="rp" data-history-polls onClick={(e) => e.stopPropagation()}>
      <div className="rb-h"><span className="t"><BarChart3 className="lt-icon" /> Polls · {summaries.length}</span><span className="q">as the room answered, live</span></div>
      {summaries.map((summary) => {
        const slide = summary.slideId ? slides?.[summary.slideId] : null
        return (
          <div className="rp-poll" key={summary.pollId} data-history-poll={summary.pollId}>
            <div className="rp-h"><b>{summary.question || 'Poll'}</b><small>{[pollTypeWord(summary.type), `${summary.people} ${summary.people === 1 ? 'person' : 'people'}`, slide ? `slide ${slide.slideNumber}` : null].filter(Boolean).join(' · ')}</small></div>
            {summary.kind === 'bars' ? <PollBars summary={summary} />
              : summary.kind === 'scale' ? <PollScale summary={summary} />
                : <ul className="rp-text">{summary.responses.map((response, i) => <li key={i}>{response}</li>)}</ul>}
          </div>
        )
      })}
    </div>
  )
}

const LIFETIME_LABEL: Record<RunShareLifetime, string> = { '7': '7 days', '30': '30 days', forever: 'Until I stop it' }

/** R7: Share a read-only link — what goes on it and for how long; one address per Run. */
export function RunShareDialog({ run, talkTitle, onClose, flash }: { run: RecordingSession; talkTitle: string; onClose: () => void; flash: (message: string) => void }): JSX.Element {
  const options = useMemo(() => runShareOptions(run), [run])
  const [current, setCurrent] = useState<RunResultsShareState | null | undefined>(undefined)
  const [board, setBoard] = useState(options.boards > 0)
  const [polls, setPolls] = useState(options.polls.length > 0)
  const [lifetime, setLifetime] = useState<RunShareLifetime>(DEFAULT_RUN_SHARE_LIFETIME)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.tw.history.resultsShareStatus(run.talkSlug, run.id).then((state) => {
      if (cancelled) return
      setCurrent(state)
      if (state) { setBoard(state.include.board && options.boards > 0); setPolls(state.include.polls && options.polls.length > 0); setLifetime(state.lifetime) }
    }).catch(() => { if (!cancelled) setCurrent(null) })
    return () => { cancelled = true }
  }, [run.talkSlug, run.id, options.boards, options.polls.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copy = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await window.tw.history.resultsShare(run.talkSlug, run.id, { board, polls }, lifetime, talkTitle).catch(() => ({ ok: false as const, error: 'The link could not be shared.' }))
    setBusy(false)
    if (!result.ok) { setError(result.error); return }
    setCurrent(result.share)
    try { await navigator.clipboard.writeText(result.share.url) } catch { /* the link is shown in the field */ }
    flash('Read-only link copied')
    onClose()
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await window.tw.history.resultsShareStop(run.talkSlug, run.id)
    setBusy(false)
    if (!result.ok) { setError(result.error); return }
    setCurrent(null)
    flash('Sharing stopped: the link no longer works')
  }

  const pollNames = options.polls.map((poll) => poll.question || 'Poll').join(' · ')
  return (
    <div className="rs-dialog" role="dialog" aria-label="Share a read-only link" data-share-dialog onClick={(e) => e.stopPropagation()}>
      <div className="rs-h"><Link2 className="lt-icon" /> Share a read-only link</div>
      <p className="rs-sub">Anyone with the link can read it. No names are ever on it; hidden cards never are.</p>
      <label className={`rs-opt${options.boards ? '' : ' off'}`}>
        <input type="checkbox" checked={board} disabled={!options.boards || busy} onChange={(e) => setBoard(e.target.checked)} data-share-board />
        <span><b>The board</b><small>{options.boards ? `${options.boardCards} card${options.boardCards === 1 ? '' : 's'}, groups and counts` : 'No board on this Run'}</small></span>
      </label>
      <label className={`rs-opt${options.polls.length ? '' : ' off'}`}>
        <input type="checkbox" checked={polls} disabled={!options.polls.length || busy} onChange={(e) => setPolls(e.target.checked)} data-share-polls />
        <span><b>The poll results</b><small>{options.polls.length ? pollNames : 'No poll results on this Run'}</small></span>
      </label>
      {preworkEnabled() && (
        <label className="rs-opt off">
          <input type="checkbox" checked={false} disabled data-share-prework />
          <span><b>The pre-work answers</b><small>No pre-work answers on this Run</small></span>
        </label>
      )}
      <div className="rs-url" data-share-url>{current ? current.url.replace(/^https?:\/\//, '') : current === undefined ? 'Checking…' : 'The link is made when you copy it'}</div>
      <div className="rs-life">
        <span>Open for</span>
        <div className="rs-seg">
          {(['7', '30', 'forever'] as RunShareLifetime[]).map((value) => (
            <button key={value} className={lifetime === value ? 'active' : ''} disabled={busy} onClick={() => setLifetime(value)} data-share-lifetime={value}>{LIFETIME_LABEL[value]}</button>
          ))}
        </div>
      </div>
      {current?.expiresAt ? <p className="rs-note">Works until {dayDate(current.expiresAt)}. Changing “Open for” starts it again from today.</p> : null}
      {error ? <p className="rs-err" role="alert">{error}</p> : null}
      <div className="rs-actions">
        {current ? <button className="rs-stop" disabled={busy} onClick={() => void stop()} data-share-stop>Stop sharing</button> : null}
        <span className="push" />
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || (!board && !polls)} onClick={() => void copy()} data-share-copy><Clipboard className="lt-icon" /> {busy ? 'Sharing…' : 'Copy the link'}</button>
      </div>
    </div>
  )
}
