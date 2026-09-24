import { parsePollExtras } from './poll-ballots.ts'

export type SlideFocusKind = 'reveal' | 'focus'

export interface SlideFocusState {
  kind: SlideFocusKind
  step: number
}

export interface SlideState {
  slideId: string
  reveal: number
  focus: SlideFocusState | null
}

export interface SlideStateMessage extends SlideState {
  type: 'slide.state'
  revision: number
}

export interface SessionClosedMessage {
  type: 'session.closed'
}

export interface SlidePublishMessage extends SlideState {
  type: 'slide.publish'
}

export type PollType = 'single' | 'multiple' | 'open' | 'ranking' | 'rating' | 'categorisation'
export type PollVisibility = 'live' | 'held'
export type PollChoice = string | string[] | Record<string, string>

export interface PollOption {
  optionId: string
  label: string
}

export interface PollDefinition {
  pollId: string
  slideId?: string
  type: PollType
  question: string
  options: PollOption[]
  visibility: PollVisibility
  rankCount?: number
  labels?: PollOption[]
  allowSkip?: boolean
  /** Maximum distinct options in a multiple-choice answer; omitted means all options. */
  maxSelections?: number
  /** Free-text submissions per participant; omitted means one, null means unlimited. */
  maxSubmissions?: number | null
}

export type PresenterPollMessage =
  | { type: 'poll.open'; poll: PollDefinition }
  | { type: 'poll.close'; pollId: string }
  | { type: 'poll.reveal'; pollId: string }
  | { type: 'poll.hide'; pollId: string; responseId: string; hidden?: boolean }

export interface PollVoteMessage {
  type: 'poll.vote'
  pollId: string
  choice: PollChoice
}

export interface PollVoteRecordMessage {
  type: 'poll.vote-record'
  pollId: string
  choice: PollChoice
}

export interface PollStateMessage {
  type: 'poll.state'
  pollId: string
  slideId?: string
  pollType: PollType
  question: string
  options: PollOption[]
  visibility: PollVisibility
  /** Maximum distinct options in a multiple-choice answer; omitted means all options. */
  maxSelections?: number
  /** Free-text submissions per participant; omitted means one, null means unlimited. */
  maxSubmissions?: number | null
  open: boolean
  revealed: boolean
  recorded?: true
  rankCount?: number
  labels?: PollOption[]
  allowSkip?: boolean
  responseCount?: number
  firstPlaces?: Record<string, number>
  categoryTallies?: Record<string, Record<string, number>>
  tallies?: Record<string, number>
  responses?: Array<{ responseId: string; text: string; name?: string; hidden?: boolean }>
}

// Reserved for later parcels. Polls are active; questions and reactions remain inert.
export type QuestionMessage =
  | { type: 'question.submit'; questionId: string; text: string; name?: string }
  | { type: 'question.answer'; questionId: string }

export type ReactionMessage =
  | { type: 'reaction.send'; emoji: string }
  | { type: 'reaction.echo'; emoji: string }

export type PresenterMessage = SlidePublishMessage | PresenterPollMessage
export type AudienceMessage = PollVoteMessage
export type PresenterServerMessage = PollStateMessage | PollVoteRecordMessage
export type ServerMessage = SlideStateMessage | SessionClosedMessage | PresenterServerMessage | QuestionMessage | ReactionMessage

export function parsePresenterMessage(value: string): PresenterMessage | null {
  try {
    const message = JSON.parse(value) as Record<string, unknown>
    if (message.type === 'poll.open') {
      const poll = parsePollDefinition(message.poll)
      return poll ? { type: 'poll.open', poll } : null
    }
    if (message.type === 'poll.close' || message.type === 'poll.reveal') {
      return nonEmptyString(message.pollId) ? { type: message.type, pollId: message.pollId } : null
    }
    if (message.type === 'poll.hide') {
      if (
        !nonEmptyString(message.pollId)
        || !nonEmptyString(message.responseId)
        || (message.hidden !== undefined && typeof message.hidden !== 'boolean')
      ) return null
      return {
        type: 'poll.hide', pollId: message.pollId, responseId: message.responseId,
        ...(typeof message.hidden === 'boolean' ? { hidden: message.hidden } : {}),
      }
    }
    const focus = message.focus == null ? null : parseSlideFocus(message.focus)
    if (
      message.type !== 'slide.publish'
      || !nonEmptyString(message.slideId)
      || typeof message.reveal !== 'number'
      || !Number.isInteger(message.reveal)
      || message.reveal < 0
      || (message.focus != null && !focus)
    ) return null
    return { type: 'slide.publish', slideId: message.slideId, reveal: message.reveal, focus }
  } catch {
    return null
  }
}

export function parseAudienceMessage(value: string): AudienceMessage | null {
  try {
    const message = JSON.parse(value) as Record<string, unknown>
    if (message.type !== 'poll.vote' || !nonEmptyString(message.pollId)) return null
    const choice = parsePollChoice(message.choice)
    return choice !== null ? { type: 'poll.vote', pollId: message.pollId, choice } : null
  } catch {
    return null
  }
}

export function parsePresenterServerMessage(value: string): PresenterServerMessage | null {
  try {
    const message = JSON.parse(value) as Record<string, unknown>
    if (message.type === 'poll.vote-record') {
      const choice = parsePollChoice(message.choice)
      return nonEmptyString(message.pollId) && choice !== null
        ? { type: 'poll.vote-record', pollId: message.pollId, choice }
        : null
    }
    if (
      message.type !== 'poll.state'
      || !nonEmptyString(message.pollId)
      || !isPollType(message.pollType)
      || typeof message.question !== 'string'
      || (message.visibility !== 'live' && message.visibility !== 'held')
      || typeof message.open !== 'boolean'
      || typeof message.revealed !== 'boolean'
      || !Array.isArray(message.options)
    ) return null
    if (!validPollLimits(message, message.pollType, message.options.length)) return null
    const options = message.options.map(parsePollOption)
    if (options.some((option) => option === null)) return null
    const extras = parsePollExtras({ ...message, type: message.pollType }, options as PollOption[])
    if (extras === null) return null
    const firstPlaces = parseTallies(message.firstPlaces)
    const categoryTallies = parseCategoryTallies(message.categoryTallies)
    if (message.firstPlaces !== undefined && firstPlaces === null) return null
    if (message.categoryTallies !== undefined && categoryTallies === null) return null
    if (message.responseCount !== undefined && (!Number.isInteger(message.responseCount) || Number(message.responseCount) < 0)) return null
    const tallies = parseTallies(message.tallies)
    const responses = parseResponses(message.responses)
    if (message.tallies !== undefined && tallies === null) return null
    if (message.responses !== undefined && responses === null) return null
    if (message.recorded !== undefined && message.recorded !== true) return null
    return {
      type: 'poll.state',
      pollId: message.pollId,
      ...(nonEmptyString(message.slideId) ? { slideId: message.slideId } : {}),
      pollType: message.pollType,
      question: message.question,
      options: options as PollOption[],
      visibility: message.visibility,
      ...pollLimits(message),
      open: message.open,
      revealed: message.revealed,
      ...extras,
      ...(message.responseCount !== undefined ? { responseCount: Number(message.responseCount) } : {}),
      ...(firstPlaces ? { firstPlaces } : {}),
      ...(categoryTallies ? { categoryTallies } : {}),
      ...(message.recorded === true ? { recorded: true as const } : {}),
      ...(tallies ? { tallies } : {}),
      ...(responses ? { responses } : {}),
    }
  } catch {
    return null
  }
}

export function parsePollChoice(value: unknown): PollChoice | null {
  if (nonEmptyString(value)) return value
  if (Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)) return [...value]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (entries.length > 0 && entries.every(([key, label]) => nonEmptyString(key) && nonEmptyString(label))) {
      return Object.fromEntries(entries) as Record<string, string>
    }
  }
  return null
}

function parseCategoryTallies(value: unknown): Record<string, Record<string, number>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result: Array<[string, Record<string, number>]> = []
  for (const [key, counts] of Object.entries(value)) {
    const parsed = parseTallies(counts)
    if (!nonEmptyString(key) || !parsed) return null
    result.push([key, parsed])
  }
  return Object.fromEntries(result)
}

function parseTallies(value: unknown): Record<string, number> | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.some(([key, count]) => !nonEmptyString(key) || !Number.isInteger(count) || Number(count) < 0)) return null
  return Object.fromEntries(entries) as Record<string, number>
}

function parseResponses(value: unknown): Array<{ responseId: string; text: string; name?: string; hidden?: boolean }> | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) return null
  const responses: Array<{ responseId: string; text: string; name?: string; hidden?: boolean }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const response = item as Record<string, unknown>
    if (
      !nonEmptyString(response.responseId)
      || !nonEmptyString(response.text)
      || (response.name !== undefined && !nonEmptyString(response.name))
      || (response.hidden !== undefined && typeof response.hidden !== 'boolean')
    ) return null
    responses.push({
      responseId: response.responseId,
      text: response.text,
      ...(nonEmptyString(response.name) ? { name: response.name } : {}),
      ...(response.hidden === true ? { hidden: true as const } : {}),
    })
  }
  return responses
}

export function parsePollDefinition(value: unknown): PollDefinition | null {
  if (!value || typeof value !== 'object') return null
  const poll = value as Record<string, unknown>
  if (
    !nonEmptyString(poll.pollId)
    || !isPollType(poll.type)
    // The question is OPTIONAL (a bare Yes/No asked aloud needs no wording) — it must be a
    // string, but may be empty. Surfaces skip the question element when it is blank.
    || typeof poll.question !== 'string'
    || (poll.visibility !== 'live' && poll.visibility !== 'held')
    || !Array.isArray(poll.options)
  ) return null
  if (!validPollLimits(poll, poll.type, poll.options.length)) return null
  const options = poll.options.map(parsePollOption)
  if (options.some((option) => option === null)) return null
  const validOptions = options as PollOption[]
  if (poll.type === 'open' ? validOptions.length !== 0 : validOptions.length < 1) return null
  if (new Set(validOptions.map((option) => option.optionId)).size !== validOptions.length) return null
  const extras = parsePollExtras(poll, validOptions)
  if (extras === null) return null
  return {
    ...extras,
    pollId: poll.pollId,
    ...(nonEmptyString(poll.slideId) ? { slideId: poll.slideId } : {}),
    type: poll.type,
    question: poll.question,
    options: validOptions,
    visibility: poll.visibility,
    ...pollLimits(poll),
  }
}

function parsePollOption(value: unknown): PollOption | null {
  if (!value || typeof value !== 'object') return null
  const option = value as Record<string, unknown>
  return nonEmptyString(option.optionId) && nonEmptyString(option.label)
    ? { optionId: option.optionId, label: option.label }
    : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseSlideFocus(value: unknown): SlideFocusState | null {
  if (!value || typeof value !== 'object') return null
  const focus = value as Record<string, unknown>
  if (
    (focus.kind !== 'reveal' && focus.kind !== 'focus')
    || typeof focus.step !== 'number'
    || !Number.isInteger(focus.step)
    || focus.step < 0
  ) return null
  return { kind: focus.kind, step: focus.step }
}

export function isPollType(value: unknown): value is PollType {
  return typeof value === 'string' && ['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation'].includes(value)
}

/** Limits are optional for existing authored polls; reject invalid explicit configuration. */
function validPollLimits(poll: Record<string, unknown>, type: unknown, optionCount: number): boolean {
  if (poll.maxSelections !== undefined && (type !== 'multiple' || !Number.isSafeInteger(poll.maxSelections)
    || Number(poll.maxSelections) < 1 || Number(poll.maxSelections) > optionCount)) return false
  if (poll.maxSubmissions !== undefined && (type !== 'open' || (poll.maxSubmissions !== null
    && (!Number.isSafeInteger(poll.maxSubmissions) || Number(poll.maxSubmissions) < 1)))) return false
  return true
}
function pollLimits(poll: Record<string, unknown>): Pick<PollDefinition, 'maxSelections' | 'maxSubmissions'> {
  return {
    ...(poll.maxSelections !== undefined ? { maxSelections: poll.maxSelections as number } : {}),
    ...(poll.maxSubmissions !== undefined ? { maxSubmissions: poll.maxSubmissions as number | null } : {}),
  }
}
