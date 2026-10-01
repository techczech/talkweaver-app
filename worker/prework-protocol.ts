// Pre-work for a planned Run (ADR-0032 amendment points 2–4; feedback-boards ticket 09): what the app,
// the handout and the Worker say to each other, and the one reading of each message. Imported by the
// Worker (prework-state.ts, prework.ts) and by the app (src/shared/run-prework.ts), so the form the
// app pushes, the answers participants send and the entries the app mirrors onto the Run are checked
// by the same rules everywhere.
//
// Invariants:
//   - the form carries no right answer: a `right` key anywhere in a pushed form is refused outright;
//   - an answer names a step of the form and fits that step's kind and poll;
//   - a participant is only ever a hash on the Worker and on the Run (counts, never names);
//   - every text has a character cap and every list a length cap.
// Pure: no Workers runtime.
import { AUDIENCE_FEEDBACK_LIMITS, type PollChoice, type PollOption, type PollType } from './protocol.ts'
import { validExtendedChoice } from './poll-ballots.ts'
import { isShareId, SHARE_ID_SOURCE } from './share-id.ts'

export const PREWORK_DAY_MS = 24 * 60 * 60 * 1_000

export const PREWORK_LIMITS = {
  /** A pushed form (definition and window), read by the entry Worker before the object sees it. */
  formBytes: 256 * 1024,
  /** One submission from a participant. */
  submitBytes: 8 * 1024,
  /** "My answers": a participant id and nothing else. */
  mineBytes: 1024,
  closeBytes: 1024,
  titleChars: 300,
  introChars: 2_000,
  steps: 40,
  options: 30,
  labelChars: 300,
  idChars: 200,
  /** The participant id a device keeps: random, long enough not to be guessed. */
  participantIdMin: 16,
  participantIdMax: 100,
  /** An open answer. */
  answerChars: 1_000,
  questionChars: AUDIENCE_FEEDBACK_LIMITS.questionChars,
  nameChars: AUDIENCE_FEEDBACK_LIMITS.nameChars,
  /** People who can take part in one Run's pre-work. */
  participants: 2_000,
  /** Accepted submissions (that changed something) per participant. */
  participantSubmissions: 400,
  /** Questions about steps per participant. */
  participantQuestions: 20,
  /** UTF-8 bytes of every stored entry together. */
  entryBytes: 8 * 1024 * 1024,
  /** Rate: the whole form, and one participant. Tokens refill per minute up to the burst. */
  /** The whole form: a storage guard well above what one source may send, so no one source can starve it. */
  perMinute: 3_000,
  burst: 3_000,
  participantPerMinute: 60,
  participantBurst: 60,
  /**
   * One network source (the connecting IP, hashed): submissions per minute, and new participant ids
   * it may bring per hour. Participant ids are chosen by the device, so without this one host could
   * mint ids until the form is full. Sized for a room behind one address (a campus NAT).
   */
  sourcePerMinute: 300,
  sourceBurst: 300,
  sourceNewParticipantsPerHour: 400,
  /**
   * New participant ids one source may bring over the form's life: the form's own cap, so a large
   * lecture behind one campus address over several days is never refused; the hourly cap alone
   * limits a flooder.
   */
  sourceParticipantsTotal: 2_000,
  /** Entries per owner results page. */
  resultsPage: 500,
  /** The furthest ahead a window may close. */
  maxWindowMs: 400 * PREWORK_DAY_MS,
} as const

/** A pre-work object with no submission or push for this long is purged by its alarm. */
export const PREWORK_IDLE_PURGE_MS = 60 * PREWORK_DAY_MS

export type PreworkStepKind = 'slide' | 'check' | 'question' | 'task'
export type PreworkEntryKind = 'read' | 'answer' | 'done' | 'question'

/** A step's poll as participants answer it: never a right answer. */
export interface PreworkPoll {
  type: Exclude<PollType, 'board'>
  question: string
  options: PollOption[]
  labels?: PollOption[]
  rankCount?: number
  allowSkip?: boolean
  maxSelections?: number
}

export interface PreworkFormStep {
  id: string
  n: number
  title: string
  kind: PreworkStepKind
  /** "Ask about this" is on for the step. */
  questions: boolean
  /** Checks and questions only. */
  poll?: PreworkPoll
  /** Pre-tasks only: participants can mark it done. */
  done?: boolean
  /** Pre-tasks only: minutes it takes. */
  minutes?: number
}

export interface PreworkForm {
  title: string
  intro: string
  steps: PreworkFormStep[]
}

/** What the owner pushes: the form and when it opens and closes (ms). */
export interface PreworkFormPush {
  opensAt: number
  closesAt: number
  form: PreworkForm
}

/** One participant's submission. `participantId` never leaves the Worker; it is stored as a hash. */
export interface PreworkSubmission {
  participantId: string
  submissionId: string
  stepId: string
  kind: PreworkEntryKind
  choice?: PollChoice
  text?: string
  name?: string
  done?: boolean
}

/**
 * What the Worker keeps and the owner mirrors: the latest state of one thing one participant did.
 * `id` is stable (`<participant>:<kind>:<step>` for reads, answers and done marks, which a later
 * submission replaces; `<participant>:q:<submissionId>` for each question), so mirroring merges by id.
 */
export interface PreworkEntry {
  id: string
  seq: number
  participant: string
  stepId: string
  kind: PreworkEntryKind
  choice?: PollChoice
  text?: string
  name?: string
  done?: boolean
  /** When it last changed (ms). */
  at: number
}

export type PreworkPhase = 'not_yet' | 'open' | 'closed'

/** The public answer to "is pre-work open?" — no form, no answers. `people` only once it has closed. */
export interface PreworkStatus {
  state: PreworkPhase
  opensAt: number
  closesAt: number
  people?: number
}

export type Parsed<T> = { value: T } | { error: { code: string; message: string } }
const fail = (code: string, message: string): { error: { code: string; message: string } } => ({ error: { code, message } })

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max: number, required = true): string | null {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > max) return null
  const trimmed = value.trim()
  return trimmed || !required ? trimmed : null
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/

export function validPreworkId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/** A key named `right` anywhere in a value: a quick check's right answer, which never leaves the app. */
export function carriesRightAnswer(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => carriesRightAnswer(item, depth + 1))
  return Object.entries(value).some(([key, item]) => key.toLowerCase() === 'right' || carriesRightAnswer(item, depth + 1))
}

function parseOptions(value: unknown): PollOption[] | null {
  if (!Array.isArray(value) || value.length > PREWORK_LIMITS.options) return null
  const options: PollOption[] = []
  for (const option of value) {
    if (!record(option) || !validPreworkId(option.optionId)) return null
    const label = text(option.label, PREWORK_LIMITS.labelChars)
    if (label === null) return null
    options.push({ optionId: option.optionId, label })
  }
  return new Set(options.map((option) => option.optionId)).size === options.length ? options : null
}

const POLL_TYPES = new Set(['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation'])

function parsePoll(value: unknown): PreworkPoll | null {
  if (!record(value) || typeof value.type !== 'string' || !POLL_TYPES.has(value.type)) return null
  const type = value.type as PreworkPoll['type']
  const question = text(value.question, PREWORK_LIMITS.labelChars, false)
  const options = parseOptions(value.options)
  if (question === null || !options || (type === 'open' ? options.length !== 0 : options.length < 1)) return null
  const poll: PreworkPoll = { type, question, options }
  if (type === 'rating' || type === 'categorisation') {
    const labels = parseOptions(value.labels)
    if (!labels || labels.length < 1) return null
    poll.labels = labels
    if (value.allowSkip !== undefined) {
      if (typeof value.allowSkip !== 'boolean') return null
      poll.allowSkip = value.allowSkip
    }
  } else if (value.labels !== undefined || value.allowSkip !== undefined) return null
  if (value.rankCount !== undefined) {
    if (type !== 'ranking' || !Number.isInteger(value.rankCount) || Number(value.rankCount) < 1 || Number(value.rankCount) > options.length) return null
    poll.rankCount = Number(value.rankCount)
  }
  if (value.maxSelections !== undefined) {
    if (type !== 'multiple' || !Number.isInteger(value.maxSelections) || Number(value.maxSelections) < 1 || Number(value.maxSelections) > options.length) return null
    poll.maxSelections = Number(value.maxSelections)
  }
  return poll
}

function parseStep(value: unknown, index: number): PreworkFormStep | null {
  if (!record(value) || !validPreworkId(value.id) || typeof value.questions !== 'boolean') return null
  const title = text(value.title, PREWORK_LIMITS.titleChars, false)
  if (title === null) return null
  const kind = value.kind
  if (kind !== 'slide' && kind !== 'check' && kind !== 'question' && kind !== 'task') return null
  const step: PreworkFormStep = { id: value.id, n: index + 1, title, kind, questions: value.questions }
  if (kind === 'check' || kind === 'question') {
    const poll = parsePoll(value.poll)
    if (!poll || (kind === 'check' && poll.type !== 'single')) return null
    step.poll = poll
  } else if (value.poll !== undefined) return null
  if (kind === 'task') {
    if (typeof value.done !== 'boolean') return null
    step.done = value.done
    if (value.minutes !== undefined) {
      if (!Number.isInteger(value.minutes) || Number(value.minutes) < 1 || Number(value.minutes) > 600) return null
      step.minutes = Number(value.minutes)
    }
  } else if (value.done !== undefined || value.minutes !== undefined) return null
  return step
}

/** The form, rebuilt from its allowed fields only. A right answer anywhere refuses the whole form. */
export function parsePreworkForm(value: unknown): Parsed<PreworkForm> {
  if (!record(value)) return fail('invalid_form', 'The form must be an object.')
  if (carriesRightAnswer(value)) return fail('right_answer_not_allowed', 'A quick check\'s right answer never leaves the app.')
  const title = text(value.title, PREWORK_LIMITS.titleChars, false)
  const intro = text(value.intro, PREWORK_LIMITS.introChars, false)
  if (title === null || intro === null) return fail('invalid_form', 'The title or introduction is too long.')
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > PREWORK_LIMITS.steps) {
    return fail('invalid_steps', `A form has 1 to ${PREWORK_LIMITS.steps} steps.`)
  }
  const steps = value.steps.map(parseStep)
  if (steps.some((step) => !step)) return fail('invalid_step', 'A step is malformed.')
  const ids = new Set(steps.map((step) => step!.id))
  if (ids.size !== steps.length) return fail('duplicate_step', 'Two steps share an id.')
  return { value: { title, intro, steps: steps as PreworkFormStep[] } }
}

/** The owner's push: a form and a window that opens before it closes, closing within 400 days. */
export function parsePreworkFormPush(value: unknown, now: number): Parsed<PreworkFormPush> {
  if (!record(value)) return fail('invalid_push', 'The push must be an object.')
  const { opensAt, closesAt } = value
  if (!Number.isSafeInteger(opensAt) || !Number.isSafeInteger(closesAt) || Number(opensAt) < 0) return fail('invalid_window', 'opensAt and closesAt are times in ms.')
  if (Number(closesAt) <= Number(opensAt)) return fail('invalid_window', 'Pre-work must close after it opens.')
  if (Number(closesAt) > now + PREWORK_LIMITS.maxWindowMs) return fail('invalid_window', 'Pre-work may close at most 400 days ahead.')
  const form = parsePreworkForm(value.form)
  if ('error' in form) return form
  return { value: { opensAt: Number(opensAt), closesAt: Number(closesAt), form: form.value } }
}

export function validParticipantId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= PREWORK_LIMITS.participantIdMin && value.length <= PREWORK_LIMITS.participantIdMax
    && /^[A-Za-z0-9_-]+$/.test(value)
}

function parseChoiceShape(value: unknown): PollChoice | null {
  const option = (item: unknown) => typeof item === 'string' && validPreworkId(item)
  if (option(value)) return value as string
  if (Array.isArray(value) && value.length >= 1 && value.length <= PREWORK_LIMITS.options && value.every(option)) return [...value] as string[]
  if (record(value)) {
    const entries = Object.entries(value)
    if (entries.length >= 1 && entries.length <= PREWORK_LIMITS.options && entries.every(([key, label]) => option(key) && option(label))) {
      return Object.fromEntries(entries) as Record<string, string>
    }
  }
  return null
}

/** A participant's submission, shape only (the step and its kind are checked against the form by the reducer). */
export function parsePreworkSubmission(value: unknown): Parsed<PreworkSubmission> {
  if (!record(value)) return fail('invalid_submission', 'A submission must be an object.')
  if (!validParticipantId(value.participantId)) return fail('invalid_participant', 'participantId must be 16 to 100 letters, digits, - or _.')
  if (!validPreworkId(value.submissionId)) return fail('invalid_submission_id', 'submissionId is required.')
  if (!validPreworkId(value.stepId)) return fail('invalid_step', 'stepId is required.')
  const base = { participantId: value.participantId, submissionId: value.submissionId, stepId: value.stepId }
  const extra = (allowed: string[]) => Object.keys(value).some((key) => !['participantId', 'submissionId', 'stepId', 'kind', ...allowed].includes(key))
  switch (value.kind) {
    case 'read':
      if (extra([])) return fail('invalid_submission', 'A read carries nothing else.')
      return { value: { ...base, kind: 'read' } }
    case 'done':
      if (extra(['done']) || typeof value.done !== 'boolean') return fail('invalid_done', 'done must be true or false.')
      return { value: { ...base, kind: 'done', done: value.done } }
    case 'question': {
      if (extra(['text', 'name'])) return fail('invalid_submission', 'A question carries text and an optional name.')
      const body = text(value.text, PREWORK_LIMITS.questionChars)
      if (body === null) return fail('invalid_question', `A question is 1 to ${PREWORK_LIMITS.questionChars} characters.`)
      if (value.name !== undefined && value.name !== null && typeof value.name !== 'string') return fail('invalid_name', 'Name must be a string.')
      const name = typeof value.name === 'string' ? value.name.trim() : ''
      if (name.length > PREWORK_LIMITS.nameChars) return fail('invalid_name', `A name is at most ${PREWORK_LIMITS.nameChars} characters.`)
      return { value: { ...base, kind: 'question', text: body, ...(name ? { name } : {}) } }
    }
    case 'answer': {
      if (extra(['choice', 'text'])) return fail('invalid_submission', 'An answer carries a choice or a text.')
      if (value.text !== undefined) {
        if (value.choice !== undefined) return fail('invalid_answer', 'An answer is a choice or a text, not both.')
        const body = text(value.text, PREWORK_LIMITS.answerChars)
        return body === null ? fail('invalid_answer', `An answer is 1 to ${PREWORK_LIMITS.answerChars} characters.`) : { value: { ...base, kind: 'answer', text: body } }
      }
      const choice = parseChoiceShape(value.choice)
      return choice === null ? fail('invalid_answer', 'The choice is malformed.') : { value: { ...base, kind: 'answer', choice } }
    }
    default:
      return fail('invalid_kind', 'kind is read, answer, done or question.')
  }
}

/**
 * The answer as the step's poll takes it, or an error. Single: one option id; multiple: distinct
 * option ids up to the cap; open: a text; ranking, rating and categorisation: the live poll's rules.
 */
export function validPreworkAnswer(poll: PreworkPoll, submission: Pick<PreworkSubmission, 'choice' | 'text'>): { choice?: PollChoice; text?: string } | null {
  if (poll.type === 'open') return typeof submission.text === 'string' && submission.text ? { text: submission.text } : null
  const choice = submission.choice
  if (choice === undefined) return null
  const optionIds = new Set(poll.options.map((option) => option.optionId))
  if (poll.type === 'single') return typeof choice === 'string' && optionIds.has(choice) ? { choice } : null
  if (poll.type === 'multiple') {
    if (!Array.isArray(choice) || choice.some((id) => !optionIds.has(id))) return null
    const unique = [...new Set(choice)]
    return unique.length >= 1 && unique.length <= (poll.maxSelections ?? poll.options.length) ? { choice: unique } : null
  }
  try {
    return { choice: validExtendedChoice({ pollId: 'prework', visibility: 'live', ...poll }, choice) }
  } catch {
    return null
  }
}

const ENTRY_ID_RE = /^[0-9a-f]{16}:(?:read|answer|done|q):[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/

/**
 * An entry as the owner reads it (and as the Run keeps it): rebuilt from its allowed fields, or null.
 * The Run file is JSON anyone can edit, so the app reads its own copy through this too.
 */
export function parsePreworkEntry(value: unknown): PreworkEntry | null {
  if (!record(value)) return null
  const { id, seq, participant, stepId, kind, at } = value
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id) || typeof participant !== 'string' || !/^[0-9a-f]{16}$/.test(participant)
    || !id.startsWith(`${participant}:`) || !validPreworkId(stepId) || !Number.isSafeInteger(seq) || Number(seq) < 0
    || !Number.isSafeInteger(at) || Number(at) < 0) return null
  const entry: PreworkEntry = { id, seq: Number(seq), participant, stepId, kind: kind as PreworkEntryKind, at: Number(at) }
  if (kind === 'read') {
    if (id !== `${participant}:read:${stepId}`) return null
  } else if (kind === 'done') {
    if (id !== `${participant}:done:${stepId}` || typeof value.done !== 'boolean') return null
    entry.done = value.done
  } else if (kind === 'answer') {
    if (id !== `${participant}:answer:${stepId}`) return null
    if (value.text !== undefined) {
      const body = text(value.text, PREWORK_LIMITS.answerChars)
      if (body === null || value.choice !== undefined) return null
      entry.text = body
    } else {
      const choice = parseChoiceShape(value.choice)
      if (choice === null) return null
      entry.choice = choice
    }
  } else if (kind === 'question') {
    if (!id.startsWith(`${participant}:q:`)) return null
    const body = text(value.text, PREWORK_LIMITS.questionChars)
    if (body === null) return null
    entry.text = body
    if (value.name !== undefined) {
      const name = text(value.name, PREWORK_LIMITS.nameChars)
      if (name === null) return null
      entry.name = name
    }
  } else return null
  return entry
}

export function parsePreworkStatus(value: unknown): PreworkStatus | null {
  if (!record(value)) return null
  if (value.state !== 'not_yet' && value.state !== 'open' && value.state !== 'closed') return null
  if (!Number.isSafeInteger(value.opensAt) || !Number.isSafeInteger(value.closesAt)) return null
  if (value.people !== undefined && !(Number.isSafeInteger(value.people) && Number(value.people) >= 0)) return null
  return { state: value.state, opensAt: Number(value.opensAt), closesAt: Number(value.closesAt), ...(value.people !== undefined ? { people: Number(value.people) } : {}) }
}

/**
 * The network source a connecting address counts as: an IPv4 address itself; an IPv6 address by its
 * /64 prefix (one host usually holds a whole /64, so each address in it must not be a new source);
 * an IPv4-mapped IPv6 address as its IPv4 address. Anything unreadable is kept as written.
 */
export function preworkSourceKey(address: string): string {
  const ip = address.trim().toLowerCase()
  if (!ip.includes(':')) return ip
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (mapped) return mapped[1]
  const [head, tail, extra] = ip.split('::')
  if (extra !== undefined) return ip
  const left = head ? head.split(':') : []
  const right = tail !== undefined && tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  if ((tail === undefined && missing !== 0) || missing < 0) return ip
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return ip
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

export type PreworkAction = 'status' | 'submit' | 'mine' | 'form' | 'results' | 'close'
export interface PreworkRoute { preworkId: string; action: PreworkAction }

const ROUTE = new RegExp(`^/prework/(${SHARE_ID_SOURCE})(?:/(submit|mine|form|results|close))?$`)

/** `/prework/<id>` (status), `/prework/<id>/submit|mine|form|results|close`; nothing else. */
export function parsePreworkRoute(pathname: string): PreworkRoute | null {
  const match = pathname.match(ROUTE)
  if (!match || !isShareId(match[1])) return null
  return { preworkId: match[1], action: (match[2] as PreworkAction | undefined) ?? 'status' }
}

/** The one method each route takes; anything else is refused before the object is reached. */
export function preworkRouteMethod(route: PreworkRoute): 'GET' | 'POST' | 'PUT' {
  if (route.action === 'form') return 'PUT'
  return route.action === 'status' || route.action === 'results' ? 'GET' : 'POST'
}

/** Public routes take no credential; the rest are the owner's. */
export function preworkRouteIsPublic(route: PreworkRoute): boolean {
  return route.action === 'status' || route.action === 'submit' || route.action === 'mine'
}

/** The byte cap for the route's body, or null when it takes none. */
export function preworkBodyLimit(route: PreworkRoute): number | null {
  switch (route.action) {
    case 'form': return PREWORK_LIMITS.formBytes
    case 'submit': return PREWORK_LIMITS.submitBytes
    case 'mine': return PREWORK_LIMITS.mineBytes
    case 'close': return PREWORK_LIMITS.closeBytes
    default: return null
  }
}
