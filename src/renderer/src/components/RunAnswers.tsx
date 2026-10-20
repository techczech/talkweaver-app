// The Pre-work answers and Post-work answers sections of a Run's page (work-files-and-sessions ticket 18;
// locked mockup S4). Each folds with a chevron and carries a 64px progress bar in its header. This is
// where the 0.37 History pre-work reading view moved: per-step answers, the quick check's spread,
// starring answers for a board, and the questions people asked about a step.
//
// Everything a participant typed (answers, questions, names) is rendered as text (React text nodes),
// never as markup. Stars and marks belong to the Run; participants see none of them. The numbers and
// rows come from src/shared/run-answers.ts; every write goes through main (one change at a time).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleHelp, Clock, CloudOff, Copy, Download, FileText, Gauge, Inbox, LayoutGrid, ListChecks, Lock, MessageCircleQuestion, MessageSquareHeart, Pencil, Presentation, RefreshCw, Send, Star, Video, WifiOff } from 'lucide-react'
import type { RecordingSession, RunPreworkPullResult, RunWorkPhase } from '../../../preload/index'
import type { RunPrework } from '../../../shared/run-prework'
import type { PhaseSteps, StarRow, StepBlock } from '../../../shared/run-answers'
import { answerSection, answeredText, answersCsv, answersMarkdown, answersText, starredCount, startsFolded } from '../../../shared/run-answers'
import { feedsForStep, type FedSlide } from '../../../shared/run-prework-results'
import { whenLabel, type RunPhase } from '../../../shared/run-checklist'
import { workOwnerUnknown } from '../../../shared/run-work'
import type { SessionSource } from '../../../shared/sessions-list'
import '../run-answers.css'

const SHOWN = 3
const NO_STEPS: StepBlock[] = []
const NO_PHASE_STEPS: PhaseSteps['steps'] = []

type Data = { pre?: PhaseSteps; post?: PhaseSteps; prework?: RunPrework; postwork?: RunPrework; writable?: boolean; ownerUnknown?: RunWorkPhase[] }

/**
 * Where a phase's answers stand with the live service on this page (2026-10-19 prework-responses, mockups
 * 05 and 06): no row (the phase was never sent), pulling, pulled, the service could not be reached (or did
 * not answer in time), the live service is an older build than this app's, the pull was refused (the
 * notice says why), or the work was deleted after 60 days. Every pull ends in one of these, never in
 * `pulling`. `pulledAt` is the work service's last pull of the phase.
 */
export type PullState = 'idle' | 'pulling' | 'pulled' | 'offline' | 'outdated' | 'refused' | 'purged'
type Link = { row: boolean; state: PullState; pulledAt?: number }

/** Said by the work service when it could not reach the live service (run-prework.ts pullNow). */
const UNREACHABLE = /could not be reached/
/** Said by the work service when the work was deleted after 60 days (PREWORK_PURGED_MESSAGE). */
const PURGED = /deleted after 60 days/

/**
 * How long the page waits for one pull before it says the live service did not answer. The work service
 * gives up on each request after 15 s, but a pull can wait its turn behind a count or a close and read
 * several pages; past this the page stops showing "Pulling…" (a late answer is still taken).
 */
export const PULL_TIMEOUT_MS = 45_000
const TIMED_OUT = Symbol('timed out')

/**
 * The pull of each Run and phase that has not answered yet, for every page (a remount, Try again): one request at a
 * time, kept until it settles. A page's timeout ends only its "Pulling…", never the request.
 */
const pendingPulls = new Map<string, Promise<RunPreworkPullResult>>()
function sharedPull(flight: string, start: () => Promise<RunPreworkPullResult>): Promise<RunPreworkPullResult> {
  const pending = pendingPulls.get(flight)
  if (pending) return pending
  const request = Promise.resolve().then(start)
  pendingPulls.set(flight, request)
  const drop = (): void => { if (pendingPulls.get(flight) === request) pendingPulls.delete(flight) }
  request.then(drop, drop)
  return request
}

/** The live service's line when it is an older build than this TalkWeaver carries. */
export const LIVE_SERVICE_OUTDATED = 'The live service needs an update before answers can be pulled'
/** The same words as the status line, for the note under it. */
const OUTDATED_NOTE = 'TalkWeaver updates the live service before you next go live. The answers below are the ones pulled last time.'

/** The Tools window hears that the read state changed (the rail badge and the Sessions list read again). */
export const RESPONSES_SEEN_EVENT = 'tw-responses-seen'

type Filter = 'all' | 'new' | 'starred' | 'questions'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "14 Oct 10:12" in this machine's zone. */
function stamp(ms: number): string {
  const date = new Date(ms)
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "Tue 20 Oct 18:30" in this machine's zone. */
function dayStamp(ms: number): string {
  return `${DAYS[new Date(ms).getDay()]} ${stamp(ms)}`
}
/** "09:12" today, else "Tue 20 Oct 17:40". */
function shortStamp(ms: number): string {
  const date = new Date(ms)
  return date.toDateString() === new Date().toDateString() ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : dayStamp(ms)
}

function stepIcon(block: StepBlock): JSX.Element {
  if (block.kind === 'video') return <Video aria-hidden />
  if (block.kind === 'slide') return <Presentation aria-hidden />
  if (block.kind === 'check') return <ListChecks aria-hidden />
  if (block.kind === 'task') return <Pencil aria-hidden />
  if (block.label === 'Rating') return <Gauge aria-hidden />
  return <MessageCircleQuestion aria-hidden />
}

export function RunAnswers({ source, runPhase, onPulled, onOpenWorkFile, pullTimeoutMs = PULL_TIMEOUT_MS }: {
  source: SessionSource
  runPhase: RunPhase
  /** A phase's answers were pulled onto the Run: the Sessions list is read again (the Unpublish sentence counts from it). */
  onPulled?: () => void
  /** "Open work file" when every answer step is Local only. */
  onOpenWorkFile?: (phase: RunWorkPhase) => void
  /** Tests only: how long one pull may take before the page says the service did not answer. */
  pullTimeoutMs?: number
}): JSX.Element {
  const { vaultId, talkSlug, runId } = source
  const key = `${vaultId}|${talkSlug}/${runId}`
  const [loaded, setLoaded] = useState<{ key: string; data: Data } | null>(null)
  const [links, setLinks] = useState<{ key: string; pre?: Link; post?: Link } | null>(null)
  const [liveMissing, setLiveMissing] = useState<{ key: string; missing: boolean } | null>(null)
  // The phases whose answers were on show: leaving the Run marks them read (decision 14), never a phase not looked at.
  const viewed = useRef<{ key: string; phases: Set<RunWorkPhase>; writable: boolean }>({ key, phases: new Set(), writable: false })
  const [folds, setFolds] = useState<{ key: string; pre?: boolean; post?: boolean } | null>(null)
  const [notice, setNotice] = useState<{ key: string; phase: RunWorkPhase; text: string } | null>(null)
  const current = useRef(key)
  current.current = key

  const data: Data | null = loaded?.key === key ? loaded.data : null
  const apply = useCallback((forKey: string, patch: Partial<Data>): void => {
    if (current.current !== forKey) return
    setLoaded((previous) => ({ key: forKey, data: { ...(previous?.key === forKey ? previous.data : {}), ...patch } }))
  }, [])
  const takeRun = useCallback((forKey: string, phase: RunWorkPhase, run: RecordingSession): void => {
    apply(forKey, phase === 'post' ? { postwork: run.postwork } : { prework: run.prework })
  }, [apply])
  const setLink = useCallback((forKey: string, phase: RunWorkPhase, patch: Partial<Link>): void => {
    if (current.current !== forKey) return
    setLinks((previous) => {
      const base = previous?.key === forKey ? previous : { key: forKey }
      return { ...base, [phase]: { row: false, state: 'idle', ...base[phase], ...patch } }
    })
  }, [])

  // The parent passes a new onPulled on every render (SessionsView reads its list again after each pull). Held in
  // a ref, so the pull and the opening effect keep their identity: before, each pull re-rendered the parent, gave
  // a new pullPhase, re-ran the opening effect and pulled again, without end, and the strip stayed on "Pulling…".
  const onPulledRef = useRef(onPulled)
  onPulledRef.current = onPulled
  // Which pull of a Run and phase this page shows: a late answer is applied only by the pull still shown, while the
  // page is mounted and on that Run (never to a newer pull's state, another Run, or after the page is gone).
  const pulls = useRef(new Map<string, number>())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  /**
   * Pull one phase from the live service onto the Run (on opening, and Pull now / Try again). Always ends in a
   * state within `pullTimeoutMs`: the request and each lookup after it are raced against the same deadline. The
   * request itself is shared (sharedPull): a timeout ends only "Pulling…", never the request, so Try again or the
   * page opened again while it is unresolved waits for that same request instead of sending another.
   */
  const pullPhase = useCallback(async (forKey: string, phase: RunWorkPhase): Promise<void> => {
    const flight = `${forKey}#${phase}`
    const turn = (pulls.current.get(flight) ?? 0) + 1
    pulls.current.set(flight, turn)
    const alive = (): boolean => mounted.current && current.current === forKey && pulls.current.get(flight) === turn
    setLink(forKey, phase, { state: 'pulling' })
    /** A promise that says TIMED_OUT after `pullTimeoutMs`, and the way to stop its timer. */
    const deadline = (): { limit: Promise<typeof TIMED_OUT>; stop: () => void } => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), pullTimeoutMs) })
      return { limit, stop: () => { if (timer !== undefined) clearTimeout(timer) } }
    }
    /** Apply a reply to this pull, if it is still the one on show; each lookup after it has its own deadline. */
    const applyReply = async (pulled: RunPreworkPullResult): Promise<void> => {
      if (!alive()) return
      const { limit, stop } = deadline()
      try {
        let state: PullState = 'pulled'
        if (!pulled.ok) {
          state = UNREACHABLE.test(pulled.error) ? 'offline' : PURGED.test(pulled.error) ? 'purged' : 'refused'
          // A refusal from an older live service (one that does not know a route this app uses) reads as the update it needs.
          if (state === 'refused') {
            const row = await Promise.race([window.tw.liveService.status().catch(() => null), limit])
            if (!alive()) return
            if (row !== TIMED_OUT && row?.build && row.appBuild && row.build !== row.appBuild) state = 'outdated'
          }
        }
        if (pulled.ok) takeRun(forKey, phase, pulled.run)
        else if (pulled.run) takeRun(forKey, phase, pulled.run)
        if (!pulled.ok && (state === 'refused' || state === 'purged')) setNotice({ key: forKey, phase, text: pulled.error })
        // The state is set before the last lookup: a status that never answers leaves the pull ended all the same.
        setLink(forKey, phase, { state, ...(pulled.ok ? { pulledAt: Date.now() } : {}) })
        if (pulled.ok) onPulledRef.current?.()
        const status = await Promise.race([window.tw.history.preworkStatus(talkSlug, runId, phase, vaultId).catch(() => null), limit])
        if (alive() && status !== TIMED_OUT && status?.pulledAt) setLink(forKey, phase, { pulledAt: status.pulledAt })
      } finally { stop() }
    }
    const request = sharedPull(flight, () => window.tw.history.preworkRefresh(talkSlug, runId, phase, vaultId))
    const { limit, stop } = deadline()
    let pulled: RunPreworkPullResult | typeof TIMED_OUT
    try { pulled = await Promise.race([request, limit]) } catch { if (alive()) setLink(forKey, phase, { state: 'offline' }); return } finally { stop() }
    if (pulled === TIMED_OUT) {
      if (alive()) setLink(forKey, phase, { state: 'offline' })
      // The request goes on, but this pull returns now: the opening routine moves on to the next phase. Its answer,
      // when it comes, is applied by applyReply under the same checks (still this pull, this Run, the page open).
      void request.then(applyReply, () => {}).catch(() => {})
      return
    }
    await applyReply(pulled)
  }, [talkSlug, runId, vaultId, takeRun, setLink, pullTimeoutMs])

  // Leaving the Run (another Run, another view, the window closing) marks what was on show read.
  useEffect(() => {
    viewed.current = { key, phases: new Set(), writable: false }
    return () => {
      const seen = viewed.current
      if (seen.key !== key || !seen.writable || !seen.phases.size) return
      void Promise.all([...seen.phases].map((phase) => window.tw.history.preworkSeen(talkSlug, runId, { type: 'leave' }, phase, vaultId).catch(() => null)))
        .then(() => window.dispatchEvent(new Event(RESPONSES_SEEN_EVENT)))
    }
  }, [key, talkSlug, runId, vaultId])

  // Opening the page reads the Run's steps and answers, then pulls each phase that is on a handout (ticket 13).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let loadedPhases: RunWorkPhase[] = []
      let writable = false
      try {
        const result = await window.tw.sessions.runAnswers({ vaultId, talkSlug, runId })
        if (cancelled) return
        if (!result.ok) { apply(key, {}); return }
        const { ok: _ok, ...rest } = result
        writable = rest.writable
        apply(key, rest)
        loadedPhases = (['pre', 'post'] as const).filter((phase) => rest[phase])
      } catch { apply(key, {}); return }
      // A Run whose own vault cannot be written now is read as it stands: nothing is pulled into it from here.
      if (!writable) return
      let anyMissing = false
      for (const phase of loadedPhases) {
        try {
          const status = await window.tw.history.preworkStatus(talkSlug, runId, phase, vaultId)
          if (cancelled) return
          if (!status) { anyMissing = true; setLink(key, phase, { row: false }); continue }
          setLink(key, phase, { row: true, ...(status.pulledAt ? { pulledAt: status.pulledAt } : {}) })
          await pullPhase(key, phase)
          if (cancelled) return
        } catch { /* the answers already on the Run stay on show */ }
      }
      // A phase never sent: is that because there is no live service to send it through (mockup 06c)?
      if (anyMissing && !cancelled) {
        try {
          const row = await window.tw.liveService.status()
          if (!cancelled) setLiveMissing({ key, missing: row.state === 'not-set-up' })
        } catch { /* said nothing: the ordinary empty state stands */ }
      }
    })()
    return () => { cancelled = true }
  }, [vaultId, talkSlug, runId, key, apply, setLink, pullPhase])

  const hasPre = Boolean(source.work?.pre)
  const hasPost = Boolean(source.work?.post)
  const postOpen = runPhase === 'post-open'
  const writable = data?.writable !== false
  const folded = (phase: RunWorkPhase): boolean => {
    const own = folds?.key === key ? folds[phase] : undefined
    return own ?? startsFolded(phase, hasPost, postOpen)
  }
  const fold = (phase: RunWorkPhase): void => setFolds((previous) => ({ ...(previous?.key === key ? previous : { key }), key, [phase]: !folded(phase) }))
  const linkOf = (phase: RunWorkPhase): Link | null => (links?.key === key ? links[phase] ?? null : null)
  const noLiveService = liveMissing?.key === key && liveMissing.missing
  const sectionProps = (phase: RunWorkPhase) => ({
    phase, source, runPhase, data, writable, folded: folded(phase), onFold: () => fold(phase),
    notice: notice?.key === key && notice.phase === phase ? notice.text : null,
    setNotice: (text: string | null) => setNotice(text ? { key, phase, text } : null),
    takeRun: (run: RecordingSession) => takeRun(key, phase, run),
    link: linkOf(phase), noLiveService,
    onPull: () => { void pullPhase(key, phase) },
    onViewed: () => { if (viewed.current.key === key) { viewed.current.phases.add(phase); viewed.current.writable = writable } },
    onOpenWorkFile: onOpenWorkFile ? () => onOpenWorkFile(phase) : undefined
  })

  return (
    <>
      {hasPre && <AnswerSection {...sectionProps('pre')} />}
      {hasPost && <AnswerSection {...sectionProps('post')} />}
    </>
  )
}

function AnswerSection({ phase, source, runPhase, data, writable, folded, onFold, notice, setNotice, takeRun, link, noLiveService, onPull, onViewed, onOpenWorkFile }: {
  phase: RunWorkPhase
  source: SessionSource
  runPhase: RunPhase
  data: Data | null
  /** The Run is in the current vault: stars, marks and pulls are allowed. */
  writable: boolean
  folded: boolean
  onFold: () => void
  notice: string | null
  setNotice: (text: string | null) => void
  takeRun: (run: RecordingSession) => void
  /** The phase and the live service on this page; null until known. */
  link: Link | null
  /** The phase was never sent and there is no live service to send it through. */
  noLiveService: boolean
  onPull: () => void
  /** The section's answers are on show (leaving the Run marks them read). */
  onViewed: () => void
  onOpenWorkFile?: () => void
}): JSX.Element {
  const work = source.work?.[phase]
  const prework = phase === 'post' ? data?.postwork : data?.prework
  const phaseSteps = phase === 'post' ? data?.post : data?.pre
  const steps = phaseSteps?.steps ?? NO_PHASE_STEPS
  const section = useMemo(() => answerSection(steps, prework ?? null, source.expectedPeople ?? null), [steps, prework, source.expectedPeople])
  // The header counts people from the list's own number until the Run's answers have been read.
  const headerCount = data ? section : { answered: source.answers?.[phase] ?? 0, expected: source.expectedPeople ?? null, percent: 0, starred: 0 }
  const percent = data ? section.percent : headerCount.expected ? Math.min(100, Math.round((headerCount.answered / headerCount.expected) * 100)) : 0
  const Icon = phase === 'post' ? MessageSquareHeart : Inbox
  const title = phase === 'post' ? 'Post-work answers' : 'Pre-work answers'
  const word = phase === 'post' ? 'post-work' : 'pre-work'
  const closedPre = phase === 'pre' && ['pre-closed', 'live', 'delivered', 'post-open', 'post-closed'].includes(runPhase)
  const [feeds, setFeeds] = useState<FedSlide[] | null | undefined>(undefined)
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [asking, setAsking] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState(false)
  const stepsFromOutline = phaseSteps?.source === 'outline'
  const hasEntries = (prework?.entries.length ?? 0) > 0
  // Every step that takes an answer or a tick is Local only: nothing is collected, by design (mockup 06d).
  const allLocal = section.answerSteps > 0 && section.localSteps === section.answerSteps && !hasEntries
  // Never sent, and no live service to send it through (06c).
  const needsLive = noLiveService && link?.row === false && !hasEntries && !allLocal
  const offline = link?.state === 'offline'
  const pulling = link?.state === 'pulling'
  const closedPhase = closedPre || (phase === 'post' && runPhase === 'post-closed')

  useEffect(() => {
    if (!writable || !stepsFromOutline || phase !== 'pre') { setFeeds(undefined); return }
    let cancelled = false
    void window.tw.history.preworkFeeds(source.talkSlug, source.vaultId).then((result) => { if (!cancelled) setFeeds(result.ok ? result.feeds : null) }, () => { if (!cancelled) setFeeds(null) })
    return () => { cancelled = true }
  }, [writable, stepsFromOutline, phase, source.talkSlug, source.vaultId])

  // Answers on show: leaving the Run marks them read.
  useEffect(() => { if (data && !folded && hasEntries) onViewed() })

  // The Copy and Export menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event.type === 'mousedown' && (event.target as Element | null)?.closest?.('[data-run-export-menu], [data-run-export]')) return
      setMenu(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [menu])

  const change = async (stepId: string, next: { type: 'toggle'; id: string } | { type: 'mode'; mode: 'picked' | 'all' }): Promise<boolean> => {
    try {
      const result = await window.tw.history.preworkPick(source.talkSlug, source.runId, stepId, next, phase, source.vaultId)
      if (result.ok) { takeRun(result.run); return true }
      setNotice(result.error)
    } catch { setNotice('That did not go through. Try again.') }
    return false
  }
  const mark = async (entryId: string, patch: { answered?: boolean; inTalk?: { slideId: string | null } | null }): Promise<void> => {
    try {
      const result = await window.tw.history.preworkQuestion(source.talkSlug, source.runId, entryId, patch, phase, source.vaultId)
      if (result.ok) takeRun(result.run)
      else setNotice(result.error)
    } catch { setNotice('That did not go through. Try again.') }
  }
  /** Mark all read, or keep one response unread by its dot. */
  const seen = async (next: { type: 'all' } | { type: 'keep'; id: string; unread: boolean }): Promise<void> => {
    try {
      const result = await window.tw.history.preworkSeen(source.talkSlug, source.runId, next, phase, source.vaultId)
      if (result.ok) { takeRun(result.run); window.dispatchEvent(new Event(RESPONSES_SEEN_EVENT)) }
      else setNotice(result.error)
    } catch { setNotice('That did not go through. Try again.') }
  }
  // "Use N starred on a board": every step with stars opens its board with only those; a board slide takes them by naming the step.
  const useOnBoard = async (): Promise<void> => {
    const starredSteps = section.steps.filter((block) => block.body.type === 'answers' && block.body.rows.some((row) => row.starred))
    for (const block of starredSteps) { if (!await change(block.id, { type: 'mode', mode: 'picked' })) return }
    const boards = starredSteps.flatMap((block) => feedsForStep(feeds, block.id, source.work?.[phase]?.fileId).map((feed) => `“${feed.title}”`))
    const n = section.starred
    setNotice(phase === 'post' ? 'Starred answers are kept on the Run.'
      : boards.length
      ? `${n} starred ${n === 1 ? 'answer opens' : 'answers open'} the board ${boards.join(', ')}.`
      : `${n} starred ${n === 1 ? 'answer is' : 'answers are'} kept on this Run. A board slide takes them when it names the step it shows answers for.`)
  }
  // Copy and Export (decision 15): built from the section as shown, with no participant ids.
  const copyText = async (starredOnly: boolean): Promise<void> => {
    setMenu(false)
    try { await navigator.clipboard.writeText(answersText(section, starredOnly)); setNotice(starredOnly ? 'Starred answers copied.' : 'Answers copied.') } catch { setNotice('The answers could not be copied.') }
  }
  const download = (kind: 'csv' | 'md'): void => {
    setMenu(false)
    const text = kind === 'csv' ? answersCsv(section) : answersMarkdown(section, `${title}: ${source.eventTitle || source.talkTitle}`)
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${source.talkSlug}-${source.runId}-${word}-answers.${kind}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const meta = (
    <span className="meta">
      {allLocal ? <span data-run-answered>0 collected by design</span>
        : needsLive ? null
          : <span data-run-answered>{answeredText(headerCount)}{offline ? ' when last pulled' : ''}</span>}
      {data && !allLocal && section.toAnswer > 0 && <span data-run-to-answer>· {section.toAnswer} {section.toAnswer === 1 ? 'question' : 'questions'} to answer</span>}
      {!allLocal && !needsLive && <span className="bar" style={{ width: 64 }}><i style={{ width: `${percent}%` }} /></span>}
      {folded && closedPre && <span> · closed</span>}
    </span>
  )
  const stars = section.starred
  const section_ = `${phase}-answers`
  const starredToCopy = starredCount(section)

  const closesText = work ? whenLabel(work.closes) : ''
  // The status line's words for each way a pull ends (every pull ends in one; none stays on "Pulling…").
  const lastPulled = link?.pulledAt ? `Last pulled ${shortStamp(link.pulledAt)}` : 'Not pulled yet'
  const whenText = !link || pulling ? ''
    : link.state === 'pulled'
      ? closedPhase ? `${phase === 'post' ? 'Post-work' : 'Pre-work'} closed · ${link.pulledAt ? `last pulled ${shortStamp(link.pulledAt)}` : 'not pulled yet'}`
        : `${link.pulledAt ? `Pulled ${shortStamp(link.pulledAt)}` : 'Pulled'} · live service reached`
      : link.state === 'idle' ? (link.pulledAt ? `Pulled ${shortStamp(link.pulledAt)}` : 'Not pulled yet')
        : lastPulled
  const stateChip = link?.state === 'offline' ? 'Cannot reach the live service' : link?.state === 'outdated' ? LIVE_SERVICE_OUTDATED : ''
  const pullLabel = offline || link?.state === 'outdated' || link?.state === 'refused' ? 'Try again' : 'Pull now'
  // Deleted after 60 days: there is nothing left on the live service to pull.
  const canPull = writable && link?.state !== 'purged'
  const empty = ((): JSX.Element | null => {
    if (!data) return <div className="tw-ans-empty"><Clock aria-hidden />Reading the answers…</div>
    if (allLocal) {
      return (
        <div className="tw-ans-state" data-run-answers-local>
          <span className="ic"><Lock aria-hidden /></span>
          <h3>Every answer step is Local only</h3>
          <p>Participants work through this page and keep their answers on their own phones. You see no answers, only that the page is open. Change a step to Sent to you in Work files if you want its answers here. Runs already sent keep the version they went out with.</p>
          {onOpenWorkFile && <div className="acts"><button type="button" className="tw-sess-btn sm" data-run-open-work-file={phase} onClick={onOpenWorkFile}><FileText aria-hidden />Open work file</button></div>}
        </div>
      )
    }
    if (needsLive) {
      return (
        <div className="tw-ans-state" data-run-answers-nolive>
          <span className="ic warm"><CloudOff aria-hidden /></span>
          <h3>Responses need the live service</h3>
          <p>Sent to you answers travel through the live service, the same one live questions use. It is not set up on this Mac, so this Run’s page cannot be published and nothing can reach you.</p>
          <div className="acts"><button type="button" className="tw-sess-btn sm pri" data-run-set-up-live onClick={() => { void window.tw.liveService.setUp().then(onPull, () => {}) }}>Set up the live service</button></div>
          <p className="tw-ans-aside"><Lock aria-hidden /><span>Work files whose steps are all <b>Local only</b> need no live service for answers. They still need Cloudflare to publish the page.</span></p>
        </div>
      )
    }
    if (headerCount.answered > 0 || hasEntries) return null
    if (phase === 'post' && work && !['post-open', 'post-closed'].includes(runPhase)) {
      const opens = work.opens === 'session-end' ? 'Opens when the session ends' : `Opens ${whenLabel(work.opens)}`
      return <div className="tw-ans-empty" data-run-answers-wait><Clock aria-hidden />{opens} · closes {whenLabel(work.closes)}</div>
    }
    return (
      <div className="tw-ans-state" data-run-answers-none>
        <span className="ic"><Inbox aria-hidden /></span>
        <h3>No responses yet</h3>
        <p>{closesText ? `The ${word} page closes ${closesText}. ` : ''}When someone sends an answer or a question it is kept on the live service and shows here the next time you open this Run.</p>
        {writable && link?.row && <div className="acts"><button type="button" className="tw-sess-btn sm" data-run-pull={phase} disabled={pulling} onClick={onPull}><RefreshCw aria-hidden />{pullLabel}</button></div>}
        {link?.row && <small data-run-pull-state={link.state}>{pulling ? 'Pulling responses from the live service…' : [stateChip, whenText].filter(Boolean).join(' · ')}</small>}
        {section.localSteps > 0 && <small data-run-local-count>Steps marked Local only never appear here: {section.localSteps} of {section.answerSteps} steps.</small>}
      </div>
    )
  })()

  // The status strip: what is new, when the answers were last pulled, Pull now, Mark all read and the filters.
  const strip = data && !empty && link?.row ? (
    <div className="tw-ans-strip" data-run-strip={phase}>
      <div className="row">
        {pulling ? <span className="chip busy" data-run-pulling><RefreshCw aria-hidden />Pulling responses from the live service…</span>
          : offline ? <span className="chip warn" data-run-offline><WifiOff aria-hidden />{stateChip}</span>
            : link.state === 'outdated' ? <span className="chip warn" data-run-outdated><CloudOff aria-hidden />{stateChip}</span>
              : section.fresh > 0 && <span className="chip new" data-run-new-count>{section.fresh} new since you last looked</span>}
        {!pulling && <span className="when" data-run-pulled data-run-pull-state={link.state}>{whenText}</span>}
        {canPull && <button type="button" className="tw-sess-btn sm" data-run-pull={phase} disabled={pulling} onClick={onPull}><RefreshCw aria-hidden />{pullLabel}</button>}
      </div>
      {link.state === 'outdated' && (
        <div className="tw-ans-warn" role="status" data-run-outdated-note>
          <CloudOff aria-hidden />
          <span>{OUTDATED_NOTE}</span>
        </div>
      )}
      {offline && (
        <div className="tw-ans-warn" role="status" data-run-offline-note>
          <WifiOff aria-hidden />
          <span><b>New responses may be waiting, but this Mac is offline or the service did not answer.</b> Nothing is lost: participants’ answers are kept on the live service until you pull them (for 60 days after the last activity). What you see below was pulled last time.</span>
        </div>
      )}
      {!offline && (
        <div className="row">
          {writable && <button type="button" className="tw-sess-btn sm" data-run-mark-all-read disabled={section.fresh === 0} onClick={() => { void seen({ type: 'all' }) }}><Check aria-hidden />Mark all read</button>}
          <span className="tw-ans-filters" role="group" aria-label="Show">
            {(['all', 'new', 'starred', 'questions'] as const).map((id) => {
              const count = id === 'new' ? section.fresh : id === 'starred' ? starredToCopy : id === 'questions' ? section.steps.reduce((sum, block) => sum + block.questions.length, 0) : null
              return (
                <button key={id} type="button" className={`tw-sess-chip${filter === id ? ' on' : ''}`} data-run-filter={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {id === 'all' ? 'All' : id === 'new' ? 'New' : id === 'starred' ? 'Starred' : 'Questions'}{count !== null ? ` · ${count}` : ''}
                </button>
              )
            })}
          </span>
        </div>
      )}
    </div>
  ) : null

  /** The blocks the filter keeps, with the rows it keeps. */
  const shown = (empty ? NO_STEPS : section.steps).flatMap((block): Array<{ block: StepBlock; rows: StarRow[]; questions: StepBlock['questions']; open: boolean }> => {
    const rows = block.body.type === 'answers' ? block.body.rows : []
    if (filter === 'all') return [{ block, rows, questions: block.questions, open: asking[block.id] === true }]
    if (filter === 'new') {
      if (!block.fresh) return []
      const fresh = new Set(block.newQuestions)
      return [{ block, rows: rows.filter((row) => row.isNew), questions: block.questions.filter((question) => fresh.has(question.id)), open: true }]
    }
    if (filter === 'starred') {
      const starred = rows.filter((row) => row.starred)
      return starred.length ? [{ block, rows: starred, questions: [], open: false }] : []
    }
    return block.questions.length ? [{ block, rows: [], questions: block.questions, open: true }] : []
  })

  const answerRow = (block: StepBlock, row: StarRow): JSX.Element => {
    const kept = prework?.unread?.includes(row.id) === true
    return (
      <div key={row.id} className={`ans${row.starred ? ' starred' : ''}${row.isNew ? ' new' : ''}`} data-run-answer={row.id} data-new={row.isNew ? 'true' : undefined}>
        {row.isNew && (writable
          ? <button type="button" className={`dot${kept ? ' kept' : ''}`} data-run-keep-unread aria-pressed={kept} aria-label={kept ? 'Kept unread: let it be read when you leave' : 'New: keep unread'} title={kept ? 'Kept unread' : 'Keep unread'} onClick={() => { void seen({ type: 'keep', id: row.id, unread: !kept }) }} />
          : <span className="dot" aria-label="New" />)}
        <span className="tx">{row.text}</span>
        <span className="at">{stamp(row.at)}</span>
        {writable
          ? <button type="button" className={`star${row.starred ? ' on' : ''}`} data-run-star aria-pressed={row.starred} aria-label={row.starred ? 'Remove from the board list' : 'Use on a board'} title={row.starred ? 'Remove from board list' : 'Use on a board'}
            onClick={() => { void change(block.id, { type: 'toggle', id: row.id }) }}><Star aria-hidden /></button>
          : row.starred && <span className="star on" aria-label="Starred"><Star aria-hidden /></span>}
      </div>
    )
  }

  return (
    <section className="tw-run-sec" data-run-section={section_} data-folded={folded ? 'true' : 'false'}>
      <header>
        <button type="button" className="tog" data-run-fold={phase} aria-expanded={!folded} aria-label={`${folded ? 'Unfold' : 'Fold'} ${title}`} title={folded ? 'Unfold' : 'Fold'} onClick={onFold}>
          {folded ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
        </button>
        <Icon aria-hidden /><span>{title}</span>{meta}
        {!folded && data && !empty && (
          <span className="r">
            <span className="tw-ans-menuwrap">
              <button type="button" className="tw-sess-btn sm" data-run-export="copy" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Copy aria-hidden />Copy</button>
              <button type="button" className="tw-sess-btn sm" data-run-export="export" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Download aria-hidden />Export</button>
              {menu && (
                <div className="tw-ans-menu" role="menu" data-run-export-menu>
                  <button type="button" role="menuitem" data-run-copy="text" onClick={() => { void copyText(false) }}><Copy aria-hidden /><span><b>Copy as text</b><small>Every answer in this section, one per line under its step. No names.</small></span></button>
                  <button type="button" role="menuitem" data-run-copy="starred" disabled={starredToCopy === 0} onClick={() => { void copyText(true) }}><Copy aria-hidden /><span><b>Copy starred only</b><small>{starredToCopy} {starredToCopy === 1 ? 'answer' : 'answers'}</small></span></button>
                  <button type="button" role="menuitem" data-run-download="csv" onClick={() => download('csv')}><Download aria-hidden /><span><b>Export section as CSV</b><small>Step, answer, time, starred, read. No participant ids.</small></span></button>
                  <button type="button" role="menuitem" data-run-download="md" onClick={() => download('md')}><Download aria-hidden /><span><b>Export section as Markdown</b><small>Grouped per step, for notes or a slide.</small></span></button>
                </div>
              )}
            </span>
            {writable && (
              <button type="button" className="tw-sess-btn sm" data-run-use-starred={phase} disabled={stars === 0} title={stars === 0 ? 'Star answers to use them on a board' : undefined} onClick={() => { void useOnBoard() }}>
                <LayoutGrid aria-hidden />{stars === 0 ? 'Use starred on a board' : `Use ${stars} starred on a board`}
              </button>
            )}
          </span>
        )}
      </header>
      {!folded && (
        <div className="tw-ans-body">
          {!writable && <div className="tw-run-notice" data-run-answers-readonly={phase}>Open this vault to pull answers or star them.</div>}
          {notice && <div className="tw-run-notice" role="status" data-run-answers-notice={phase}>{notice}</div>}
          {data?.ownerUnknown?.includes(phase) && <div className="tw-run-notice" role="status" data-run-owner-unknown={phase}>{workOwnerUnknown(phase)}</div>}
          {strip}
          {empty}
          {!empty && steps.length === 0 && <div className="tw-ans-empty" data-run-answers-nosteps><CircleHelp aria-hidden />The file for this phase could not be read, so its steps are not shown.</div>}
          {!empty && filter !== 'all' && shown.length === 0 && <div className="tw-ans-empty" data-run-filter-none><Inbox aria-hidden />{filter === 'new' ? 'Nothing new since you last looked.' : filter === 'starred' ? 'No starred answers.' : 'No questions about steps.'}</div>}
          {shown.map(({ block, rows, questions, open }) => {
            const old = rows.filter((row) => !row.isNew)
            const fresh = rows.filter((row) => row.isNew)
            const oldShown = showAll[block.id] || filter !== 'all' ? old : old.slice(0, Math.max(0, SHOWN - fresh.length))
            const hidden = old.length - oldShown.length
            const freshQuestions = new Set(block.newQuestions)
            return (
              <div key={block.id} data-run-answer-step={block.id}>
                <div className="stephd">{stepIcon(block)}<span>{block.n} · {block.label}</span><span className="what">{block.title}</span>
                  {block.route === 'local' && <span className="tw-ans-route local" data-run-route="local"><Lock aria-hidden />Local only</span>}
                  {block.route === 'sent' && <span className="tw-ans-route sent" data-run-route="sent"><Send aria-hidden />Sent to you</span>}
                  <span className="sum">{block.sum}{block.fresh > 0 ? ` · ${block.fresh} new` : ''}</span></div>
                {block.body.type === 'local' && filter === 'all' && <div className="tw-ans-local" data-run-local-step={block.id}><Lock aria-hidden />Marked Local only. Answers stay on each phone, so there is nothing to show here.</div>}
                {block.body.type === 'spread' && filter === 'all' && block.body.rows.map((row) => (
                  <div key={row.key} className={`qrow${row.right ? ' right' : ''}`} data-run-spread={row.key}>
                    <span className="q">{row.right && <Check aria-hidden />}{row.label}</span>
                    <span className="bar"><i style={{ width: `${row.percent}%` }} /></span>
                    <span className="v">{row.count} of {(block.body as { answered: number }).answered}</span>
                  </div>
                ))}
                {oldShown.map((row) => answerRow(block, row))}
                {fresh.length > 0 && filter === 'all' && (
                  <div className="tw-ans-divider" data-run-new-divider={block.id}><span>{fresh.length} new{prework?.seen ? ` · arrived since ${dayStamp(prework.seen.at)}` : ''}</span></div>
                )}
                {fresh.map((row) => answerRow(block, row))}
                {hidden > 0 && (
                  <button type="button" className="more" data-run-show-all={block.id} onClick={() => setShowAll((previous) => ({ ...previous, [block.id]: true }))}>
                    {`Show all ${rows.length}`}
                  </button>
                )}
                {showAll[block.id] && filter === 'all' && rows.length > SHOWN && (
                  <button type="button" className="more" data-run-show-all={block.id} onClick={() => setShowAll((previous) => ({ ...previous, [block.id]: false }))}>Show fewer</button>
                )}
                {questions.length > 0 && (
                  <>
                    {filter === 'all' && (
                      <button type="button" className="more" data-run-questions-toggle={block.id} aria-expanded={open} onClick={() => setAsking((previous) => ({ ...previous, [block.id]: !previous[block.id] }))}>
                        {questions.length} {questions.length === 1 ? 'question' : 'questions'} about this step{block.newQuestions.length ? ` · ${block.newQuestions.length} new` : ''}{open ? '' : ' · Show'}
                      </button>
                    )}
                    {open && questions.map((question) => (
                      <div key={question.id} className={`ask${question.answered ? ' done' : ''}${freshQuestions.has(question.id) ? ' new' : ''}`} data-run-question={question.id} data-new={freshQuestions.has(question.id) ? 'true' : undefined}>
                        {freshQuestions.has(question.id) && (writable
                          ? <button type="button" className={`dot${prework?.unread?.includes(question.id) ? ' kept' : ''}`} data-run-keep-unread aria-pressed={prework?.unread?.includes(question.id) === true} aria-label="New: keep unread" title="Keep unread" onClick={() => { void seen({ type: 'keep', id: question.id, unread: prework?.unread?.includes(question.id) !== true }) }} />
                          : <span className="dot" aria-label="New" />)}
                        <div className="tx"><span>{question.text}</span><small>{stamp(question.at)} · {question.name ? question.name : 'no name'}{question.inTalk ? ' · in the talk' : ''}</small></div>
                        <div className="acts">
                          {question.answered
                            ? <><span className="was"><Check aria-hidden /> Answered</span>{writable && <button type="button" className="tw-sess-btn sm" data-run-question-undo onClick={() => { void mark(question.id, { answered: false }) }}>Undo</button>}</>
                            : writable && <>
                              {phase === 'pre' && !question.inTalk && <button type="button" className="tw-sess-btn sm" data-run-question-intalk onClick={() => { void mark(question.id, { inTalk: { slideId: feedsForStep(feeds, block.id, source.work?.[phase]?.fileId)[0]?.slideId ?? null } }) }}>Put in the talk’s questions</button>}
                              <button type="button" className="tw-sess-btn sm" data-run-question-answered onClick={() => { void mark(question.id, { answered: true }) }}><Check aria-hidden />Mark answered</button>
                            </>}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
