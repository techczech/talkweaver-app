// The Run page for a planned Run's pre-work (feedback-boards ticket 11; drawings round-3 R1–R5).
// A rail (Overview, the steps, Questions) and a detail pane: the overview, each open question's
// answers with stars that pick answers for the talk's board slide, the quick check's spread with the
// right answer marked (for the author only), and the questions people asked about steps.
//
// Everything a participant or the author typed is rendered as text (React text nodes), never as
// markup. Picked answers and marks belong to the Run; participants see none of them.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CheckSquare, CircleHelp, Copy, EyeOff, LayoutGrid, ListChecks, Lock, MessageSquare, Pencil, RefreshCw, Star, Users } from 'lucide-react'
import type { RecordingSession, RunPreworkState } from '../../../preload/index'
import { preworkFromOutline, PREWORK_KIND_LABELS, type PreworkStep } from '../../../../compiler/scripts/lib/prework.mjs'
import { dayAndTime, preworkWindow } from '../../../shared/plan-run'
import {
  answerRows, checkSummary, feedsForStep, pickedAnswers, pickMode, preworkOverview, questionCounts, questionGroups, seedPlan,
  type FedSlide, type PickChange, type QuestionFilter,
} from '../../../shared/run-prework-results'
import '../history-prework.css'

type View = { kind: 'overview' } | { kind: 'step'; id: string } | { kind: 'questions' }

const KIND_ICON = { slide: MessageSquare, check: ListChecks, question: CircleHelp, task: CheckSquare } as const

function ago(ms: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

const dayName = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export default function HistoryRunPrework({ run, talk, onBack, onEditPlan, onRunChanged, flash }: {
  run: RecordingSession
  talk: { title: string; outlinePath: string | null }
  onBack: () => void
  onEditPlan: (run: RecordingSession) => void
  onRunChanged: (run: RecordingSession) => void
  flash: (message: string) => void
}): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'overview' })
  const [outline, setOutline] = useState<string | null | undefined>(undefined)
  // The board slides each step feeds, from the compiler's own model (its slide ids); null = the talk could not be compiled just now.
  const [feeds, setFeeds] = useState<FedSlide[] | null | undefined>(undefined)
  const [state, setState] = useState<RunPreworkState | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'close' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const prework = run.prework ?? null

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    setBusy('refresh')
    try {
      const result = await window.tw.history.preworkRefresh(run.talkSlug, run.id)
      if (result.ok) { setError(null); onRunChanged(result.run); if (!quiet) flash(result.added ? `${result.added} new ${result.added === 1 ? 'entry' : 'entries'}` : 'Up to date') }
      else { setError(result.error); if (result.run) onRunChanged(result.run) }
    } catch { setError('The pre-work service could not be reached. Try again.') }
    setBusy(null)
  }, [flash, onRunChanged, run.id, run.talkSlug])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setOutline(talk.outlinePath ? await window.tw.talk.readOutline(talk.outlinePath) : null)
      const compiled = await window.tw.history.preworkFeeds(run.talkSlug).catch(() => ({ ok: false as const }))
      if (!cancelled) setFeeds(compiled.ok ? compiled.feeds : null)
      const status = await window.tw.history.preworkStatus(run.talkSlug, run.id)
      if (!cancelled) setState(status)
      if (status && !cancelled) void refresh(true)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.talkSlug, talk.outlinePath])

  const definition = useMemo(() => (outline ? preworkFromOutline(outline) : null), [outline])
  const overview = useMemo(() => (definition ? preworkOverview(definition, prework, run.expectedPeople) : null), [definition, prework, run.expectedPeople])
  const window_ = preworkWindow(run)

  const closeNow = async (): Promise<void> => {
    setBusy('close')
    const result = await window.tw.history.preworkClose(run.talkSlug, run.id)
    if (result.ok) { onRunChanged(result.run); setState(await window.tw.history.preworkStatus(run.talkSlug, run.id)); flash('Pre-work closed') }
    else setError(result.error)
    setBusy(null)
  }

  const closed = state?.closedAt !== undefined
  const open = state && !closed && state.purgedAt === undefined && Date.now() >= state.opensAt && Date.now() <= state.closesAt
  const title = run.eventTitle || run.talkTitle

  const body = (): JSX.Element => {
    if (outline === undefined) return <p className="pwr-note">Reading the talk…</p>
    if (!definition || !overview) return <p className="pwr-note" data-pwr-nodef>This talk has no “Before the session” section any more, so there are no steps to read the answers against.</p>
    if (view.kind === 'questions') return <QuestionsPane run={run} definition={definition} feeds={feeds ?? null} onRunChanged={onRunChanged} flash={flash} />
    if (view.kind === 'step') {
      const step = definition.steps.find((candidate) => candidate.id === view.id)
      if (step) return <StepPane run={run} step={step} feeds={feeds} onRunChanged={onRunChanged} flash={flash} onQuestions={() => setView({ kind: 'questions' })} />
    }
    return <OverviewPane run={run} overview={overview} onStep={(id) => setView({ kind: 'step', id })} onQuestions={() => setView({ kind: 'questions' })} closesText={window_ ? dayAndTime(window_.closes) : ''} />
  }

  return (
    <div className="twh-run-detail pwr" role="dialog" aria-label={`Pre-work · ${title}`} data-prework-page={run.id}>
      <header>
        <span><button className="pwr-back" data-pwr-back onClick={onBack}>← Runs</button> <small>/ {talk.title}</small></span>
      </header>
      <div className="pwr-body">
        <div className="pwr-titlebar">
          <div>
            <h1>{title}</h1>
            <div className="pwr-badges">
              <span className="pwr-badge planned">Planned{run.plannedDate ? ` · ${new Date(`${run.plannedDate}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${run.startTime ? `, ${run.startTime}` : ''}` : ''}</span>
              <span className={`pwr-badge ${open ? 'open' : 'shut'}`} data-pwr-state>{state?.purgedAt !== undefined ? 'Pre-work deleted' : closed ? 'Pre-work closed' : open ? 'Pre-work open' : state ? (Date.now() < state.opensAt ? 'Pre-work not open yet' : 'Pre-work closed') : 'Not on a handout yet'}</span>
            </div>
            <p className="pwr-sub">{[run.audience, run.expectedPeople ? `${run.expectedPeople} expected` : ''].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="pwr-actions">
            {run.handoutUrl && <button className="twh-btn" data-pwr-copy onClick={() => { void navigator.clipboard.writeText(run.handoutUrl!); flash('Link copied') }}><Copy className="lt-icon" /> Copy the link</button>}
            <button className="twh-btn" data-pwr-refresh disabled={busy !== null || !state} onClick={() => void refresh()}><RefreshCw className="lt-icon" /> {busy === 'refresh' ? 'Reading…' : 'Refresh'}</button>
            <button className="twh-btn" data-pwr-edit onClick={() => onEditPlan(run)}><Pencil className="lt-icon" /> Edit plan</button>
            {state && !closed && state.purgedAt === undefined && <button className="twh-btn" data-pwr-close disabled={busy !== null} onClick={() => void closeNow()}><Lock className="lt-icon" /> Close pre-work now</button>}
          </div>
        </div>
        <div className="pwr-window" data-pwr-window>
          <b>{closed ? 'Closed' : open ? 'Open' : state ? 'Shut' : 'Not published'}</b>
          <span>{window_ ? `${dayAndTime(window_.opens)} to ${dayAndTime(window_.closes)}${run.preworkCloses ? '' : ', when the talk starts'}` : 'No pre-work window on this Run.'}</span>
          {run.handoutUrl && <span className="pwr-mono">{run.handoutUrl.replace(/^https?:\/\//, '')}</span>}
          {prework?.lastActivityAt ? <span>Last activity {ago(prework.lastActivityAt)}</span> : null}
        </div>
        {error && <div className="pwr-error" role="alert" data-pwr-error>{error}</div>}
        <div className="pwr-main">
          <nav className="pwr-rail" aria-label="Pre-work steps">
            <button className={view.kind === 'overview' ? 'on' : ''} data-pwr-rail="overview" onClick={() => setView({ kind: 'overview' })}><Users className="lt-icon" /><span>Overview</span><b>{overview ? `${overview.started}${overview.expected ? ` of ${overview.expected}` : ''}` : ''}</b></button>
            <h2>Steps</h2>
            {overview?.steps.map((progress) => {
              const Icon = KIND_ICON[progress.step.kind]
              return (
                <button key={progress.step.id} className={view.kind === 'step' && view.id === progress.step.id ? 'on' : ''} data-pwr-rail={progress.step.id} onClick={() => setView({ kind: 'step', id: progress.step.id })}>
                  <i>{progress.step.n}</i><Icon className="lt-icon" /><span>{progress.step.title}</span>
                  {progress.toAnswer > 0 && <em title="Questions to answer">{progress.toAnswer}</em>}
                  <b>{progress.step.kind === 'check' && progress.step.right ? `${progress.rightCount ?? 0}/${progress.count}` : progress.step.kind === 'task' ? `${progress.count}/${overview.started}` : progress.count}</b>
                </button>
              )
            })}
            <h2>From participants</h2>
            <button className={view.kind === 'questions' ? 'on' : ''} data-pwr-rail="questions" onClick={() => setView({ kind: 'questions' })}><CircleHelp className="lt-icon" /><span>Questions</span>{overview && <b>{overview.questions.toAnswer} of {overview.questions.total}</b>}</button>
          </nav>
          <section className="pwr-pane">{body()}</section>
        </div>
      </div>
    </div>
  )
}

// ── R2: the overview ────────────────────────────────────────────────────────────────────────

function OverviewPane({ run, overview, onStep, onQuestions, closesText }: {
  run: RecordingSession
  overview: NonNullable<ReturnType<typeof preworkOverview>>
  onStep: (id: string) => void
  onQuestions: () => void
  closesText: string
}): JSX.Element {
  const max = Math.max(1, ...overview.perDay.map((day) => day.count))
  const started = Math.max(1, overview.started)
  const taskLine = overview.tasks.map((task, index) => `Task ${index + 1}`).join(' · ')
  return (
    <div data-pwr-overview>
      <div className="pwr-stats">
        <div className="pwr-stat"><small>Started</small><b data-pwr-started>{overview.started}</b><span>{overview.expected ? `of ${overview.expected} expected` : 'people'}</span>{overview.expected && <em>{Math.round((overview.started / overview.expected) * 100)}% · {Math.max(0, overview.expected - overview.started)} more to come</em>}</div>
        <div className="pwr-stat"><small>Did all {overview.steps.length === 7 ? 'seven' : overview.steps.length}</small><b data-pwr-finished>{overview.finished}</b><span>of {overview.started} started</span><em>{Math.max(0, overview.started - overview.finished)} still on the way</em></div>
        <div className="pwr-stat"><small>Tasks marked done</small><b>{overview.tasks.reduce((sum, task) => sum + task.done, 0)}</b><span>{overview.tasks.map((task) => task.done).join(' · ') || 'no tasks'}</span><em>{taskLine ? `${taskLine}, of ${overview.started} started` : ''}</em></div>
        <div className="pwr-stat"><small>Questions</small><b data-pwr-questions>{overview.questions.total}</b><span>{overview.questions.toAnswer} to answer</span><em>in {overview.questions.steps} {overview.questions.steps === 1 ? 'step' : 'steps'}</em></div>
      </div>
      <div className="pwr-two">
        <div>
          <h3 className="pwr-label">Step by step</h3>
          <div className="pwr-steps">
            {overview.steps.map((progress) => {
              const step = progress.step
              const Icon = KIND_ICON[step.kind]
              const total = step.kind === 'check' && step.right ? Math.max(1, progress.count) : started
              const value = step.kind === 'check' && step.right ? (progress.rightCount ?? 0) : progress.count
              const verb = step.kind === 'slide' ? 'read' : step.kind === 'task' ? 'marked done' : step.kind === 'check' && step.right ? 'right' : 'answered'
              return (
                <button key={step.id} className="pwr-step" data-pwr-step={step.id} onClick={() => onStep(step.id)}>
                  <i>{step.n}</i>
                  <span className="pwr-kind"><Icon className="lt-icon" /> {PREWORK_KIND_LABELS[step.kind]}</span>
                  <span className="pwr-step-title"><b>{step.title}</b>{progress.asked > 0 && <small>{progress.asked} {progress.asked === 1 ? 'question' : 'questions'}</small>}{step.kind === 'task' && <small>about {step.minutes ?? 10} min</small>}</span>
                  <span className="pwr-bar"><span className={step.kind === 'check' ? 'right' : ''} style={{ width: `${Math.min(100, Math.round((value / total) * 100))}%` }} /></span>
                  <span className="pwr-count">{step.kind === 'check' && step.right ? `${value} of ${progress.count} right` : `${value} of ${overview.started} ${verb}`}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div>
          <h3 className="pwr-label">Started, day by day</h3>
          <div className="pwr-days" data-pwr-days>
            {overview.perDay.length === 0 ? <p className="pwr-note">Nobody has started yet.</p> : overview.perDay.map((day) => (
              <div key={day.day} title={`${day.count} on ${dayName(day.day)}`}><span style={{ height: `${Math.max(6, Math.round((day.count / max) * 56))}px` }} /><b>{day.count}</b><small>{dayName(day.day)}</small></div>
            ))}
          </div>
          <p className="pwr-callout"><b>Counts, not names.</b> Nobody signs in. A name appears only where a person typed one on a question.</p>
          {closesText && <p className="pwr-callout">The form closes {closesText}{run.preworkCloses ? '' : ', when the talk starts'}. Answers keep coming in until then; open a step to read them.</p>}
          {overview.questions.toAnswer > 0 && <p className="pwr-callout"><button className="pwr-link" onClick={onQuestions}>{overview.questions.toAnswer} {overview.questions.toAnswer === 1 ? 'question is' : 'questions are'} waiting for an answer</button></p>}
        </div>
      </div>
    </div>
  )
}

// ── R3 / R4: one step ───────────────────────────────────────────────────────────────────────

function StepPane({ run, step, feeds, onRunChanged, flash, onQuestions }: {
  run: RecordingSession
  step: PreworkStep
  feeds: FedSlide[] | null | undefined
  onRunChanged: (run: RecordingSession) => void
  flash: (message: string) => void
  onQuestions: () => void
}): JSX.Element {
  const prework = run.prework ?? null
  const overview = { started: Math.max(prework?.people ?? 0, new Set((prework?.entries ?? []).map((entry) => entry.participant)).size) }
  const asked = (prework?.entries ?? []).filter((entry) => entry.kind === 'question' && entry.stepId === step.id).length
  const head = (
    <>
      <p className="pwr-eyebrow">Step {step.n} · {step.kind === 'question' && step.pollType === 'open' ? 'Open answer' : PREWORK_KIND_LABELS[step.kind]}</p>
      <h2>{step.title}</h2>
    </>
  )
  const questionsLink = asked > 0 ? <p className="pwr-callout"><button className="pwr-link" onClick={onQuestions}>{asked} {asked === 1 ? 'question' : 'questions'} about this step</button></p> : null

  if (step.kind === 'check') {
    const summary = checkSummary(step, prework)
    return (
      <div data-pwr-check>
        {head}
        <p className="pwr-sub">{summary.answered} answered of {overview.started} started · single choice</p>
        <div className="pwr-marks"><span className="pwr-only"><EyeOff className="lt-icon" /> Only you see the marks</span>
          {step.right ? <span>Right answer: <b>{step.right.label}</b></span> : <span>No right answer is marked in the outline. Mark one with <code>{'{right}'}</code>.</span>}</div>
        <div className="pwr-spread">
          {summary.options.map((option) => (
            <div key={option.index} className={option.right ? 'right' : ''} data-pwr-option={option.index}>
              <span className="pwr-opt">{option.right ? <Check className="lt-icon" /> : null}<span>{option.label}</span></span>
              <span className="pwr-bar"><span className={option.right ? 'right' : ''} style={{ width: `${option.percent}%` }} /></span>
              <span className="pwr-count">{option.count} · {option.percent}%</span>
            </div>
          ))}
        </div>
        {summary.hasRight && summary.answered > 0 && (
          <p className="pwr-callout" data-pwr-check-note><b>{summary.rightCount} of {summary.answered} right ({summary.rightPercent}%).</b>
            {summary.commonWrong ? ` The most common wrong answer, “${summary.commonWrong.label}”, was chosen by ${summary.commonWrong.count}.` : ''}</p>
        )}
        <p className="pwr-callout"><b>What participants see:</b> “Saved. You will see how everyone answered in the session.” No mark, no count, before or after they answer.</p>
        {questionsLink}
      </div>
    )
  }

  if (step.kind === 'question' && step.pollType === 'open') return <OpenAnswers run={run} step={step} feeds={feeds} onRunChanged={onRunChanged} flash={flash} head={head} extra={questionsLink} />

  const count = step.kind === 'slide'
    ? new Set((prework?.entries ?? []).filter((entry) => entry.stepId === step.id && (entry.kind === 'read' || entry.kind === 'answer')).map((entry) => entry.participant)).size
    : new Set((prework?.entries ?? []).filter((entry) => entry.stepId === step.id && (step.kind === 'task' ? (entry.kind === 'done' && entry.done === true) || (step.done === false && entry.kind === 'read') : entry.kind === 'answer')).map((entry) => entry.participant)).size
  const verb = step.kind === 'slide' ? 'read it' : step.kind === 'task' ? (step.done === false ? 'read it' : 'marked it done') : 'answered'
  return (
    <div data-pwr-plain={step.kind}>
      {head}
      <p className="pwr-sub"><b data-pwr-count>{count}</b> of {overview.started} started {verb}{step.kind === 'task' ? ` · about ${step.minutes ?? 10} min` : ''}</p>
      {step.kind === 'question' && <p className="pwr-callout">The spread of a {step.pollType} question is read live; the answers are kept on the Run.</p>}
      {questionsLink}
    </div>
  )
}

function OpenAnswers({ run, step, feeds, onRunChanged, flash, head, extra }: {
  run: RecordingSession
  step: PreworkStep
  feeds: FedSlide[] | null | undefined
  onRunChanged: (run: RecordingSession) => void
  flash: (message: string) => void
  head: JSX.Element
  extra: JSX.Element | null
}): JSX.Element {
  const prework = run.prework ?? null
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'picked'>('all')
  const [group, setGroup] = useState(false)
  const rows = answerRows(prework, step.id, { group, query })
  const all = answerRows(prework, step.id)
  const picked = pickedAnswers(prework, step.id)
  const mode = pickMode(prework, step.id)
  const people = new Set(all.length ? (prework?.entries ?? []).filter((entry) => entry.kind === 'answer' && entry.stepId === step.id).map((entry) => entry.participant) : []).size
  const shown = filter === 'picked' ? rows.filter((row) => row.picked) : rows

  // One change at a time: main applies it to the Run as it then is, so two quick clicks never lose one.
  const change = async (next: PickChange): Promise<void> => {
    const result = await window.tw.history.preworkPick(run.talkSlug, run.id, step.id, next)
    if (result.ok) onRunChanged(result.run)
    else flash(result.error)
  }
  const fed = feedsForStep(feeds, step.id)
  const feed = fed[0]
  const plan = seedPlan(prework, step.id)

  return (
    <div data-pwr-answers>
      {head}
      <p className="pwr-sub">{all.length} {all.length === 1 ? 'answer' : 'answers'} from {people} {people === 1 ? 'person' : 'people'}{feed ? ` · feeds Board slide “${feed.title}” in the talk` : ''}</p>
      <div className="pwr-two answers">
        <div>
          <div className="pwr-tools">
            <input type="search" placeholder="Search the answers" aria-label="Search the answers" value={query} onChange={(event) => setQuery(event.target.value)} />
            <span className="pwr-seg"><button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <b>{all.length}</b></button><button className={filter === 'picked' ? 'on' : ''} data-pwr-picked-tab onClick={() => setFilter('picked')}>Picked <b>{picked.length}</b></button></span>
            <button className={`pwr-toggle ${group ? 'on' : ''}`} data-pwr-group onClick={() => setGroup((value) => !value)}>Group similar</button>
            <span className="pwr-hint">Click the star to show an answer in the talk</span>
          </div>
          <div className="pwr-answer-list">
            {shown.length === 0 && <p className="pwr-note">{all.length === 0 ? 'No answers yet.' : 'No answers match.'}</p>}
            {shown.map((row) => (
              <div key={row.id} className={`pwr-answer ${row.picked ? 'picked' : ''}`} data-pwr-answer={row.id}>
                <button className="pwr-star" aria-pressed={row.picked} aria-label={row.picked ? 'Remove from the talk' : 'Show in the talk'} data-pwr-star onClick={() => void change({ type: 'toggle', id: row.id })}><Star className="lt-icon" /></button>
                <div><p>{row.text}</p><small>{dayName(new Date(row.at).toISOString().slice(0, 10))}{row.ids.length > 1 ? ` · ${row.ids.length} people said this` : ''}</small></div>
                {row.ids.length > 1 && <span className="pwr-times">×{row.ids.length}</span>}
              </div>
            ))}
          </div>
        </div>
        <aside className="pwr-talk" data-pwr-in-talk>
          <h3><LayoutGrid className="lt-icon" /> In the talk</h3>
          {feeds === undefined ? <p>Reading the talk…</p> : feed || feeds === null ? (
            <>
              <p>{feed ? <>Board slide “{feed.title}”{feed.number ? ` (slide ${feed.number})` : ''} opens with:</> : 'The talk could not be read just now, so its board slide is not shown. Your choice is kept and used when the board opens:'}</p>
              <label className="pwr-radio"><input type="radio" name={`mode-${step.id}`} checked={mode === 'picked'} data-pwr-mode="picked" onChange={() => void change({ type: 'mode', mode: 'picked' })} /> <span><b>Only the answers I pick</b> · {picked.length}</span></label>
              <label className="pwr-radio"><input type="radio" name={`mode-${step.id}`} checked={mode === 'all'} data-pwr-mode="all" onChange={() => void change({ type: 'mode', mode: 'all' })} /> <span><b>Every answer</b> · {all.length}</span></label>
              {mode === 'picked' && (
                <ol className="pwr-picks">
                  {picked.map((answer, index) => (
                    <li key={answer.id} data-pwr-pick={answer.id}><i>{index + 1}</i><span>{answer.text}</span>
                      <button aria-label="Earlier" disabled={index === 0} onClick={() => void change({ type: 'move', id: answer.id, by: -1 })}><ArrowUp className="lt-icon" /></button>
                      <button aria-label="Later" disabled={index === picked.length - 1} onClick={() => void change({ type: 'move', id: answer.id, by: 1 })}><ArrowDown className="lt-icon" /></button>
                    </li>
                  ))}
                </ol>
              )}
              {mode === 'picked' && picked.length === 0 && <p className="pwr-hint">Nothing is picked, so the board opens empty.</p>}
              {plan.fits < plan.texts.length && <p className="pwr-hint" data-pwr-seed-cap>The board opens with the first {plan.fits} answers; {plan.texts.length - plan.fits} more do not fit on it.</p>}
              <p className="pwr-hint">Picks are kept with this Run, not in the outline. The room can add cards once the slide is live. Participants see none of it. A change counts from the next time the board opens.</p>
            </>
          ) : (
            <p>No board slide takes these answers yet. Write <code>{`{results=${step.id}}`}</code> on a board slide of the talk and it opens with them.</p>
          )}
        </aside>
      </div>
      {extra}
    </div>
  )
}

// ── R5: questions about steps ───────────────────────────────────────────────────────────────

function QuestionsPane({ run, definition, feeds, onRunChanged, flash }: {
  run: RecordingSession
  definition: NonNullable<ReturnType<typeof preworkFromOutline>>
  feeds: FedSlide[] | null
  onRunChanged: (run: RecordingSession) => void
  flash: (message: string) => void
}): JSX.Element {
  const [filter, setFilter] = useState<QuestionFilter>('all')
  const prework = run.prework ?? null
  const counts = questionCounts(definition, prework)
  const groups = questionGroups(definition, prework, filter)
  const mark = async (entryId: string, patch: { answered?: boolean; inTalk?: { slideId: string | null } | null }, message: string): Promise<void> => {
    const result = await window.tw.history.preworkQuestion(run.talkSlug, run.id, entryId, patch)
    if (result.ok) { onRunChanged(result.run); flash(message) } else flash(result.error)
  }
  const tabs: Array<[QuestionFilter, string]> = [['all', 'All'], ['to-answer', 'To answer'], ['answered', 'Answered'], ['in-talk', 'In the talk']]
  const steps = new Set(groups.map((group) => group.stepId)).size
  return (
    <div data-pwr-questions-pane>
      <p className="pwr-eyebrow"><CircleHelp className="lt-icon" /> From participants</p>
      <h2>Questions about the steps</h2>
      <p className="pwr-sub">{counts.all} in {new Set(questionGroups(definition, prework).map((group) => group.stepId)).size} steps, newest last. The person who asked is named only if they typed a name.</p>
      <div className="pwr-seg wide">{tabs.map(([key, label]) => <button key={key} className={filter === key ? 'on' : ''} data-pwr-qfilter={key} onClick={() => setFilter(key)}>{label} <b>{counts[key]}</b></button>)}</div>
      {steps === 0 && <p className="pwr-note">No questions{filter === 'all' ? ' yet' : ' here'}.</p>}
      {groups.map((group) => (
        <div key={group.stepId} className="pwr-qgroup" data-pwr-qgroup={group.stepId}>
          <h3>Step {group.step?.n ?? '?'} · {group.step?.title ?? group.stepId} <small>{group.questions.length} {group.questions.length === 1 ? 'question' : 'questions'}</small></h3>
          {group.questions.map((question) => (
            <div key={question.id} className={`pwr-question ${question.answered ? 'done' : ''}`} data-pwr-question={question.id}>
              <div><p>{question.text}</p><small>{ago(question.at)} · {question.name ? question.name : 'no name'}{question.inTalk ? ' · in the talk' : ''}</small></div>
              <div className="pwr-qactions">
                {question.answered
                  ? <><span className="pwr-answered"><Check className="lt-icon" /> Answered</span><button className="twh-btn" data-pwr-undo onClick={() => void mark(question.id, { answered: false }, 'Marked as not answered')}>Undo</button></>
                  : <>
                    {!question.inTalk && <button className="twh-btn" data-pwr-intalk onClick={() => void mark(question.id, { inTalk: { slideId: feedsForStep(feeds, group.stepId)[0]?.slideId ?? null } }, 'Put in the talk’s questions')}><MessageSquare className="lt-icon" /> Put in the talk’s questions</button>}
                    <button className="twh-btn" data-pwr-answer-mark onClick={() => void mark(question.id, { answered: true }, 'Marked answered')}><Check className="lt-icon" /> Mark answered</button>
                  </>}
              </div>
            </div>
          ))}
        </div>
      ))}
      <p className="pwr-callout"><b>Put in the talk’s questions</b> adds the question to the presenter’s questions tray for the Run, on the slide the step feeds (or the slide you are on, when it feeds none), so it comes up in the room. <b>Mark answered</b> is for one you have dealt with yourself, by email or in the talk.</p>
    </div>
  )
}
