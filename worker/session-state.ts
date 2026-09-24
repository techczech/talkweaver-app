import { extendedDefinitionFields, extendedPollResults, validExtendedChoice } from './poll-ballots'
import type {
  PollChoice,
  PollDefinition,
  PollStateMessage,
  SessionClosedMessage,
  SlideState,
  SlideStateMessage,
} from './protocol'
import type { RecoveryState } from './recovery-state'

export interface StoredPoll extends PollDefinition {
  open: boolean
  revealed: boolean
  votes: Record<string, PollChoice>
  hiddenResponseIds: string[]
}

export interface StoredLiveSession {
  sessionId: string
  shortId: string
  talkSlug: string
  createdAt: number
  expiresAt: number
  status: 'open' | 'closed'
  slideState: SlideState | null
  revision: number
  polls: Record<string, StoredPoll>
  recovery?: RecoveryState
}

export function createSession(input: Omit<StoredLiveSession, 'status' | 'slideState' | 'revision' | 'polls'>): StoredLiveSession {
  return { ...input, status: 'open', slideState: null, revision: 0, polls: {} }
}

export function normaliseStoredSession(session: StoredLiveSession): StoredLiveSession {
  session.polls = session.polls && typeof session.polls === 'object' ? session.polls : {}
  for (const poll of Object.values(session.polls)) {
    const stored = poll.hiddenResponseIds as unknown
    poll.hiddenResponseIds = [...new Set(
      (stored instanceof Set ? [...stored] : Array.isArray(stored) ? stored : [])
        .filter((responseId): responseId is string => typeof responseId === 'string' && responseId.length > 0),
    )]
  }
  return session
}

export function publishSlideState(session: StoredLiveSession, state: SlideState): SlideStateMessage {
  if (session.status !== 'open') throw new Error('Session is closed.')
  session.slideState = state
  session.revision += 1
  return { type: 'slide.state', ...state, revision: session.revision }
}

export function currentStateMessage(session: StoredLiveSession): SlideStateMessage | null {
  return session.slideState ? { type: 'slide.state', ...session.slideState, revision: session.revision } : null
}

export function openPoll(session: StoredLiveSession, definition: PollDefinition): PollStateMessage {
  ensureOpenSession(session)
  for (const existing of Object.values(session.polls)) existing.open = false
  // Re-opening an accidentally closed poll must KEEP what it already collected — votes, the
  // moderation hidden-set and a held poll's revealed state — otherwise a mis-click wipes the room's
  // answers. A genuinely new pollId starts empty.
  const previous = session.polls[definition.pollId]
  // A reopened poll is the same round: its definition and limits remain fixed.
  if (previous) { previous.open = true; return pollStateMessage(previous, 'presenter') }
  const poll: StoredPoll = {
    ...definition,
    options: definition.options.map((option) => ({ ...option })),
    open: true,
    revealed: definition.visibility === 'live',
    votes: {},
    hiddenResponseIds: [],
  }
  session.polls[definition.pollId] = poll
  return pollStateMessage(poll, 'presenter')
}

export function closePoll(session: StoredLiveSession, pollId: string): PollStateMessage {
  const poll = requirePoll(session, pollId)
  poll.open = false
  return pollStateMessage(poll, 'presenter')
}

export function revealPoll(session: StoredLiveSession, pollId: string): PollStateMessage {
  const poll = requirePoll(session, pollId)
  poll.revealed = true
  return pollStateMessage(poll, 'presenter')
}

export function voteInPoll(
  session: StoredLiveSession,
  connectionId: string,
  pollId: string,
  choice: PollChoice,
): PollStateMessage {
  const poll = requireOpenPoll(session, pollId)
  poll.votes[connectionId] = validChoice(poll, choice)
  return pollStateMessage(poll, 'presenter')
}

export function hidePollResponse(
  session: StoredLiveSession,
  pollId: string,
  responseId: string,
  hidden = true,
): PollStateMessage {
  const poll = requirePoll(session, pollId)
  if (poll.type !== 'open') throw new Error('Only open poll responses can be hidden.')
  if (!(responseId in poll.votes)) throw new Error('Poll response not found.')
  if (hidden && !poll.hiddenResponseIds.includes(responseId)) poll.hiddenResponseIds.push(responseId)
  else if (!hidden) poll.hiddenResponseIds = poll.hiddenResponseIds.filter((candidate) => candidate !== responseId)
  return pollStateMessage(poll, 'presenter')
}

export function pollStateMessage(
  poll: StoredPoll,
  role: 'presenter' | 'audience',
  recorded = false,
): PollStateMessage {
  const base: PollStateMessage = {
    ...extendedDefinitionFields(poll),
    type: 'poll.state',
    pollId: poll.pollId,
    pollType: poll.type,
    question: poll.question,
    options: poll.options.map((option) => ({ ...option })),
    visibility: poll.visibility,
    ...(poll.maxSelections !== undefined ? { maxSelections: poll.maxSelections } : {}),
    ...(poll.maxSubmissions !== undefined ? { maxSubmissions: poll.maxSubmissions } : {}),
    open: poll.open,
    revealed: poll.revealed,
    ...(poll.slideId ? { slideId: poll.slideId } : {}),
    ...(recorded ? { recorded: true as const } : {}),
  }
  const maySeeResults = role === 'presenter' || poll.visibility === 'live' || poll.revealed
  if (!maySeeResults) return base
  if (poll.type === 'open') return { ...base, responses: responsesFor(poll, role) }
  if (poll.type === 'ranking' || poll.type === 'rating' || poll.type === 'categorisation') {
    return { ...base, ...extendedPollResults(poll, poll.votes) }
  }
  return { ...base, tallies: talliesFor(poll) }
}

export function currentPollStateMessages(
  session: StoredLiveSession,
  role: 'presenter' | 'audience',
): PollStateMessage[] {
  return Object.values(session.polls)
    .map((poll) => pollStateMessage(poll, role))
}

export function closeSession(session: StoredLiveSession): SessionClosedMessage {
  session.status = 'closed'
  return { type: 'session.closed' }
}

export function socketRoleReceivesSlideState(role: 'presenter' | 'audience'): boolean {
  return role === 'audience'
}

export function socketRoleEndsSession(role: 'presenter' | 'audience'): boolean {
  return false
}

function ensureOpenSession(session: StoredLiveSession): void {
  if (session.status !== 'open') throw new Error('Session is closed.')
  normaliseStoredSession(session)
}

function requirePoll(session: StoredLiveSession, pollId: string): StoredPoll {
  ensureOpenSession(session)
  const poll = session.polls[pollId]
  if (!poll) throw new Error('Poll not found.')
  return poll
}

function requireOpenPoll(session: StoredLiveSession, pollId: string): StoredPoll {
  const poll = requirePoll(session, pollId)
  if (!poll.open) throw new Error('Poll is closed.')
  return poll
}

function validChoice(poll: StoredPoll, choice: PollChoice): PollChoice {
  if (poll.type === 'ranking' || poll.type === 'rating' || poll.type === 'categorisation') return validExtendedChoice(poll, choice)
  if (poll.type === 'open') {
    if (typeof choice !== 'string' || !choice.trim()) throw new Error('Open poll response is invalid.')
    return choice.trim()
  }
  const optionIds = new Set(poll.options.map((option) => option.optionId))
  if (poll.type === 'single') {
    if (typeof choice !== 'string' || !optionIds.has(choice)) throw new Error('Single-choice vote is invalid.')
    return choice
  }
  if (!Array.isArray(choice) || choice.length < 1 || choice.some((optionId) => !optionIds.has(optionId))) {
    throw new Error('Multiple-choice vote is invalid.')
  }
  const unique = [...new Set(choice)]
  if (unique.length > (poll.maxSelections ?? poll.options.length)) throw new Error(`Select up to ${poll.maxSelections} options.`)
  return unique
}

function talliesFor(poll: StoredPoll): Record<string, number> {
  const tallies = Object.fromEntries(poll.options.map((option) => [option.optionId, 0]))
  for (const choice of Object.values(poll.votes)) {
    for (const optionId of Array.isArray(choice) ? choice : typeof choice === 'string' ? [choice] : []) {
      if (optionId in tallies) tallies[optionId] += 1
    }
  }
  return tallies
}

function responsesFor(
  poll: StoredPoll,
  role: 'presenter' | 'audience',
): Array<{ responseId: string; text: string; name?: string; hidden?: boolean }> {
  return Object.entries(poll.votes)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([responseId]) => role === 'presenter' || !poll.hiddenResponseIds.includes(responseId))
    .map(([responseId, text]) => ({
      responseId,
      text,
      ...(role === 'presenter' && poll.hiddenResponseIds.includes(responseId) ? { hidden: true as const } : {}),
    }))
}
