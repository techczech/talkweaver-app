// The Run checklist as one pure state machine (work-files-and-sessions ticket 04; ADR-0040 decision 6).
// A Run, the time now and whether a live session is running go in; the checklist steps, the publication
// status and the status pill come out. The Run page, the Sessions rows and the status bar chip all
// render from this, so none of them re-derives a state. No Electron, no fs, no clock: `now` is passed.
//
//   Planned > Pre-work ready* > Published > Pre-work closes* > Delivered > Post-work open† > Post-work closes† > Results kept
//   (* only with a pre attachment, † only with a post attachment; an unattached phase is absent, not greyed)

import { SESSION_END, normaliseTimeZone, workPageUrl, type RunWork, type RunWorkSet } from './run-work.ts'

export type StepState = 'done' | 'current' | 'todo' | 'live' | 'warn'
export type StepId =
  | 'planned' | 'pre-ready' | 'published' | 'pre-closes' | 'delivered'
  | 'post-open' | 'post-closes' | 'results'
export type ActionId =
  | 'edit-plan' | 'open-pre-file' | 'open-post-file' | 'publish' | 'publish-again' | 'preview-page'
  | 'change-pre-time' | 'change-post-time' | 'go-live' | 'open-live-view' | 'mark-delivered' | 'open-results'
export type Publication = 'not-published' | 'publishing' | 'published' | 'unpublished'
export type PillKind = 'grey' | 'blue' | 'green' | 'amber' | 'red'
/** The drawn Run states (mockup `ACTIVE` plus the two before publishing). */
export type RunPhase =
  | 'planned' | 'publishing' | 'published' | 'unpublished' | 'pre-closed' | 'live' | 'delivered' | 'post-open' | 'post-closed'

export interface ChecklistAction { id: ActionId; label: string; primary?: boolean; disabled?: boolean; reason?: string }
export interface ChecklistLink { kind: 'handout' | 'pre-work' | 'post-work'; label: string; url: string }
export interface ChecklistStep {
  id: StepId
  state: StepState
  title: string
  detail: string
  actions: ChecklistAction[]
  /** The Published step, once published: the links block (each with its own copy button). */
  links?: ChecklistLink[]
  /** Which link the QR code encodes. */
  qr?: ChecklistLink['kind']
}
export interface RunChecklist {
  steps: ChecklistStep[]
  /** Steps done, and steps present (8 with both files, 6 with pre-work only). */
  done: number
  total: number
  counter: string
  publication: Publication
  phase: RunPhase
  pill: { kind: PillKind; label: string }
}

/** What the caller read of an attached work file. `blocking` is the first blocking finding in words. */
export interface WorkFileState { title: string; steps: number; blocking?: string }

export interface ChecklistRun {
  status: 'planned' | 'delivered'
  plannedDate?: string
  startTime?: string
  expectedPeople?: number
  timeZone?: string
  handoutUrl?: string
  /** When Unpublish last replaced the Run's pages (ticket 17 D1), whatever its phases carry. */
  unpublishedAt?: string
  /** ISO instant the session ended, when it was delivered. */
  endedAt?: string
  work?: RunWorkSet
}

export interface ChecklistOptions {
  /** A publish is in flight (transient: never stored on the Run). */
  publishing?: boolean
  /** The live session bound to this Run is running; `liveSince` is its local `HH:MM`. */
  live?: boolean
  liveSince?: string
  /** The reading of each attached file; an attached file with no entry is reported as not found. */
  files?: { pre?: WorkFileState; post?: WorkFileState }
  answers?: { pre?: number; post?: number }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `YYYY-MM-DDTHH:MM` as the wall clock reads in `timeZone` (the machine's zone when it is unknown). */
export function localTimeIn(instant: Date, timeZone: string | undefined): string {
  const zone = timeZone ? normaliseTimeZone(timeZone) : ''
  if (!Number.isFinite(instant.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    ...(zone ? { timeZone: zone } : {}), hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/** "Wed 21 Oct" from `YYYY-MM-DD`. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`
}
/** "Wed 21 Oct 13:00" from `YYYY-MM-DDTHH:MM`. */
export function whenLabel(local: string): string {
  return `${dayLabel(local.slice(0, 10))} ${local.slice(11, 16)}`
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/**
 * Which link the Published step's QR code encodes (locked mockup, Amendment 1 and 2): the pre-work page
 * while pre-work is open, the post-work page while post-work is open, and otherwise the handout.
 */
export function runQrTarget(state: { preOpen: boolean; postOpen: boolean }): ChecklistLink['kind'] {
  return state.preOpen ? 'pre-work' : state.postOpen ? 'post-work' : 'handout'
}

function fileDetail(work: RunWork, file: WorkFileState | undefined): string {
  return file ? `${plural(file.steps, 'step')} · file “${file.title}”` : `file ${work.fileId} not found`
}

/** The answers an unpublished Run keeps: the people who answered, pre-work and post-work together. */
export function answersKept(answers: { pre?: number; post?: number } | undefined): number {
  const count = (value: number | undefined): number => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0)
  return count(answers?.pre) + count(answers?.post)
}

/**
 * Whether a Run's pages are up, from its stamps alone (no publish in flight): the newer of the phases'
 * `publishedAt` and the `unpublishedAt` stamps (the Run's own counts too: a Run whose sent phases are
 * known only from the work service's record has no phase stamp to carry it, ticket 17 D1). The checklist
 * and the post-work opening rule (post-work-opening.ts) both read it.
 */
export function runPublication(run: Pick<ChecklistRun, 'handoutUrl' | 'unpublishedAt' | 'work'>): Exclude<Publication, 'publishing'> {
  const pre = run.work?.pre
  const post = run.work?.post
  const stamps = (key: 'publishedAt' | 'unpublishedAt') =>
    [pre?.[key], post?.[key]].filter((v): v is string => !!v).map((v) => Date.parse(v)).filter(Number.isFinite)
  const published = stamps('publishedAt')
  const publishedAt = published.length ? Math.max(...published) : null
  const runUnpublished = run.unpublishedAt ? Date.parse(run.unpublishedAt) : NaN
  const unpublishedStamps = [...stamps('unpublishedAt'), ...(Number.isFinite(runUnpublished) ? [runUnpublished] : [])]
  const unpublishedAt = unpublishedStamps.length ? Math.max(...unpublishedStamps) : null
  if (unpublishedAt !== null && (publishedAt === null || unpublishedAt >= publishedAt)) return 'unpublished'
  return publishedAt !== null || run.handoutUrl ? 'published' : 'not-published'
}

/**
 * THE post-work open test (ticket 19), read by the checklist and by Published pages (ticket 22).
 * Post-work that opens when the session ends has opened once the app pushed its opening and noted it on
 * the Run (`openedAt`), from that instant on; post-work at a set time opens at that time, delivered or
 * not, once the Run has been published (its window went out with the publish). It is open only while the
 * Run is not unpublished (participants are shown "not available" then), and closed from its closing
 * time, whether it ever opened or not. `publication` defaults to the Run's stamps (no publish in flight).
 *   reached: its opening has come; opens: reached and the Run not unpublished; open: opens and not past;
 *   past: its closing time has come. All false for a Run with no post-work.
 */
export function postWorkWindow(
  run: Pick<ChecklistRun, 'handoutUrl' | 'unpublishedAt' | 'work' | 'timeZone'>, nowInstant: Date,
  publication: Publication = runPublication(run),
): { reached: boolean; opens: boolean; open: boolean; past: boolean } {
  const post = run.work?.post
  if (!post) return { reached: false, opens: false, open: false, past: false }
  const runZone = run.timeZone || run.work?.pre?.timeZone || post.timeZone
  const postNow = localTimeIn(nowInstant, post.timeZone || runZone)
  const sent = publication === 'published' || publication === 'unpublished'
  const openedMs = Date.parse(post.openedAt ?? '')
  const reached = post.opens === SESSION_END
    ? Number.isFinite(openedMs) && openedMs <= nowInstant.getTime()
    : sent && postNow >= post.opens
  const past = postNow >= post.closes
  const opens = reached && runPublication(run) !== 'unpublished'
  return { reached, opens, open: opens && !past, past }
}

export function runChecklist(run: ChecklistRun, nowInstant: Date, options: ChecklistOptions = {}): RunChecklist {
  const pre = run.work?.pre
  const post = run.work?.post
  const live = options.live === true
  const delivered = run.status === 'delivered'
  const runZone = run.timeZone || pre?.timeZone || post?.timeZone
  const nowIn = (work: RunWork | undefined) => localTimeIn(nowInstant, work?.timeZone || runZone)
  const preNow = nowIn(pre)

  // --- publication
  const publication: Publication = options.publishing ? 'publishing' : runPublication(run)
  const publishedStamps = [pre?.publishedAt, post?.publishedAt].map((v) => Date.parse(v ?? '')).filter(Number.isFinite)
  const publishedAt = publishedStamps.length ? Math.max(...publishedStamps) : null

  // --- windows
  const preOpen = !!pre && publication === 'published' && preNow >= pre.opens && preNow < pre.closes
  const preClosed = !!pre && preNow >= pre.closes
  // Post-work: the one open test (postWorkWindow), with this checklist's publication (a publish in flight
  // counts as not sent). `postNeverOpened`: closed without opening.
  const { reached: postReached, opens: postOpens, open: postOpen, past: postPast } = postWorkWindow(run, nowInstant, publication)
  const postClosed = postPast
  const postNeverOpened = postPast && !postReached

  const steps: ChecklistStep[] = []
  const add = (step: Omit<ChecklistStep, 'actions'> & { actions?: ChecklistAction[] }) => steps.push({ actions: [], ...step })
  const expected = run.expectedPeople
  const planDetail = [expected ? `${expected} expected` : '', runZone ?? ''].filter(Boolean).join(' · ')
  add({ id: 'planned', state: 'done', title: 'Planned', detail: planDetail, actions: [{ id: 'edit-plan', label: 'Edit plan' }] })

  if (pre) {
    const file = options.files?.pre
    const blocked = !file || !!file.blocking
    add({
      id: 'pre-ready', state: blocked ? 'current' : 'done', title: 'Pre-work ready',
      detail: blocked ? (file?.blocking ?? `file ${pre.fileId} not found`) : fileDetail(pre, file),
      actions: [{ id: 'open-pre-file', label: 'Open file' }]
    })
  }

  // Published
  const lastPublished = publishedAt === null ? '' : localTimeIn(new Date(publishedAt), runZone)
  const publishActions = (again: boolean): ChecklistAction[] => [
    { id: again ? 'publish-again' : 'publish', label: again ? 'Publish again' : 'Publish for this run', primary: true },
    { id: 'preview-page', label: 'Preview page' }
  ]
  const qr = runQrTarget({ preOpen, postOpen })
  if (publication === 'not-published') add({ id: 'published', state: 'todo', title: 'Published', detail: 'Not published', actions: publishActions(false) })
  else if (publication === 'publishing') add({ id: 'published', state: 'todo', title: 'Published', detail: 'Publishing…', actions: [{ id: 'publish', label: 'Publishing…', primary: true, disabled: true }] })
  else if (publication === 'unpublished') {
    const kept = answersKept(options.answers)
    add({ id: 'published', state: 'warn', title: 'Unpublished', detail: kept ? `${plural(kept, 'answer')} kept` : 'Answers kept', actions: publishActions(true) })
  } else {
    const base = run.handoutUrl ?? ''
    const links: ChecklistLink[] = [{ kind: 'handout', label: 'Handout', url: base }]
    if (pre) links.push({ kind: 'pre-work', url: workPageUrl(base, 'pre'), label: preOpen ? 'Pre-work' : preNow < pre.opens ? `Pre-work · opens ${whenLabel(pre.opens)}` : 'Pre-work · closed' })
    if (post) links.push({ kind: 'post-work', url: workPageUrl(base, 'post'), label: postOpen ? 'Post-work · open' : postClosed ? 'Post-work · closed' : post.opens === SESSION_END ? 'Post-work · opens after the session' : `Post-work · opens ${whenLabel(post.opens)}` })
    add({ id: 'published', state: 'done', title: 'Published', detail: lastPublished ? `Since ${whenLabel(lastPublished)}` : 'Published', links, qr })
  }

  if (pre) {
    add({
      id: 'pre-closes', state: preClosed ? 'done' : 'todo', title: preClosed ? 'Pre-work closed' : 'Pre-work closes',
      detail: preClosed || publication === 'published' ? whenLabel(pre.closes) : `${whenLabel(pre.closes)} · opens ${whenLabel(pre.opens)}`,
      // Also after close: a later closing time reopens the window (ADR-0040 decision 3).
      actions: [{ id: 'change-pre-time', label: 'Change time' }]
    })
  }

  // Delivered
  const startLocal = run.plannedDate ? `${run.plannedDate}T${run.startTime || '00:00'}` : ''
  const startDetail = run.plannedDate ? `${dayLabel(run.plannedDate)}${run.startTime ? ` · ${run.startTime}` : ''}` : ''
  if (live) {
    add({ id: 'delivered', state: 'live', title: 'Live now', detail: options.liveSince ? `Since ${options.liveSince}` : 'Live now', actions: [{ id: 'open-live-view', label: 'Open live view', primary: true }] })
  } else if (delivered) {
    const ended = run.endedAt ? localTimeIn(new Date(run.endedAt), runZone) : ''
    add({ id: 'delivered', state: 'done', title: 'Delivered', detail: ended ? whenLabel(ended) : startDetail })
  } else {
    add({ id: 'delivered', state: 'todo', title: 'Delivered', detail: startDetail, actions: [{ id: 'go-live', label: 'Go live', primary: true }, { id: 'mark-delivered', label: 'Mark as delivered' }] })
  }

  if (post) {
    const file = options.files?.post
    if (postNeverOpened) {
      // Its closing time passed before it opened (the app was not running, or the Run was never published):
      // said plainly, and the steps after it go on.
      add({ id: 'post-open', state: 'warn', title: 'Post-work never opened', detail: fileDetail(post, file), actions: [{ id: 'open-post-file', label: 'Open file' }] })
    } else if (postOpens) {
      const since = post.opens === SESSION_END ? localTimeIn(new Date(post.openedAt as string), post.timeZone || runZone) : post.opens
      add({ id: 'post-open', state: 'done', title: 'Post-work open', detail: `${since ? `Since ${whenLabel(since)} · ` : ''}${fileDetail(post, file)}`, actions: [{ id: 'open-post-file', label: 'Open file' }] })
    } else {
      // Delivered, but its opening not pushed yet: the app opens it on its next pull (or once the Run is published).
      const when = post.opens !== SESSION_END ? whenLabel(post.opens)
        : delivered && publication === 'published' ? 'Opening now the session has ended'
        : delivered ? 'Opens once this run is published'
        : 'When the session ends'

      add({ id: 'post-open', state: 'todo', title: 'Post-work open', detail: `${when} · ${fileDetail(post, file)}`, actions: [{ id: 'open-post-file', label: 'Open file' }] })
    }
    const answered = options.answers?.post
    const progress = postOpen && answered !== undefined ? ` · ${answered}${expected ? `/${expected}` : ''} answered` : ''
    add({
      id: 'post-closes', state: postClosed ? 'done' : 'todo', title: postClosed ? 'Post-work closed' : 'Post-work closes',
      detail: `${whenLabel(post.closes)}${postNeverOpened ? ' · it never opened' : ''}${progress}`, actions: [{ id: 'change-post-time', label: 'Change time' }]
    })
  }

  const resultsDone = post ? postClosed && (delivered || postReached) : delivered
  const resultsOpen = delivered || live
  add({
    id: 'results', state: resultsDone ? 'done' : 'todo', title: 'Results kept',
    detail: resultsDone ? (post ? 'Board, polls, pre-work and post-work answers' : pre ? 'Board, polls and pre-work answers' : 'Board and polls')
      : postOpen ? 'Board and polls kept · post-work answers still coming in' : 'Board, polls and answers',
    actions: [resultsOpen
      ? { id: 'open-results', label: 'Open results', primary: resultsDone }
      : { id: 'open-results', label: 'Open results', disabled: true, reason: 'Available after the session' }]
  })

  // The first step that is neither done, live nor warn is the current one; the rest wait.
  let currentTaken = false
  for (const step of steps) {
    if (step.state === 'done' || step.state === 'live' || step.state === 'warn') { if (step.state !== 'done') currentTaken = true; continue }
    if (step.state === 'current') { currentTaken = true; continue }
    if (!currentTaken) { step.state = 'current'; currentTaken = true }
  }

  const done = steps.filter((s) => s.state === 'done').length
  const phase: RunPhase = live ? 'live'
    : postClosed && (delivered || postReached) ? 'post-closed'
    : postOpen ? 'post-open'
    : delivered ? 'delivered'
    : publication === 'publishing' ? 'publishing'
    : publication === 'unpublished' ? 'unpublished'
    : publication === 'not-published' ? 'planned'
    : preClosed ? 'pre-closed'
    : 'published'
  const pills: Record<RunPhase, { kind: PillKind; label: string }> = {
    planned: { kind: 'grey', label: 'Not published' }, publishing: { kind: 'blue', label: 'Publishing…' },
    published: { kind: 'green', label: 'Published' }, unpublished: { kind: 'amber', label: 'Unpublished' },
    'pre-closed': { kind: 'green', label: 'Published' }, live: { kind: 'red', label: 'Live now' },
    delivered: { kind: 'blue', label: 'Delivered' }, 'post-open': { kind: 'blue', label: 'Delivered' }, 'post-closed': { kind: 'blue', label: 'Delivered' }
  }
  return { steps, done, total: steps.length, counter: `${done} of ${steps.length}`, publication, phase, pill: pills[phase] }
}
