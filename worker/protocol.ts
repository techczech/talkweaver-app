import { parsePollExtras } from './poll-ballots.ts'
import {
  BOARD_MESSAGE_TYPES, isPresenterBoardMessage, parseBoardSeed, parseBoardSettings, parseBoardStateView, parsePresenterBoardMessage,
  type BoardSeedCard, type BoardSettings, type BoardStateView, type PresenterBoardMessage,
} from './board-protocol.ts'

export type SlideFocusKind = 'reveal' | 'focus'

export interface SlideFocusState {
  kind: SlideFocusKind
  step: number
}

export interface SlideLightboxState {
  open: boolean
  index: number
}

export interface SlideState {
  slideId: string
  reveal: number
  focus: SlideFocusState | null
  lightbox?: SlideLightboxState
  /** The talk's QR overlay is up on the projector (venue screens mirror it; phones ignore it). */
  talkQr?: boolean
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

export type PointerPosition = { x: number; y: number; space: 'slide' | 'image'; slideId: string }
export type PointerMessage = { type: 'pointer.live'; pointer: PointerPosition | 'gone' }
export const POINTER_LIMITS = { bytes: 512, perSecond: 20 } as const
export function parsePointerMessage(value: unknown): PointerMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.type !== 'pointer.live') return null
  if (message.pointer === 'gone') return { type: 'pointer.live', pointer: 'gone' }
  if (!message.pointer || typeof message.pointer !== 'object') return null
  const p = message.pointer as Record<string, unknown>
  if ((p.space !== 'slide' && p.space !== 'image') || !nonEmptyString(p.slideId) || p.slideId.length > AUDIENCE_FEEDBACK_LIMITS.slideIdChars
    || typeof p.x !== 'number' || !Number.isFinite(p.x) || p.x < 0 || p.x > (p.space === 'image' ? 1 : 1280)
    || typeof p.y !== 'number' || !Number.isFinite(p.y) || p.y < 0 || p.y > (p.space === 'image' ? 1 : 720)) return null
  return { type: 'pointer.live', pointer: { x: p.x, y: p.y, space: p.space, slideId: p.slideId } }
}

// The Pen's live ink (ticket 08): one layer's strokes (a slide, or one zoomed image of it) and the
// stroke being drawn. Presenter to venue screens only, never stored in session state, never sent to
// phones. The deck runtime's validator is compiler/assets/runtime/pen-ink.js (penInkView); the two
// agree on every case in worker/protocol.test.ts.
export type InkTool = 'freehand' | 'arrow' | 'rectangle'
export type InkColour = 'red' | 'yellow' | 'green' | 'blue'
export type InkWidth = 'thin' | 'thick'
export type InkStroke = { tool: InkTool; ink: InkColour; width: InkWidth; points: Array<[number, number]> }
export type InkView = { slideId: string; space: 'slide' | 'image'; image?: number; strokes: InkStroke[]; draft: InkStroke | null }
export type InkMessage = { type: 'ink.live'; ink: InkView }
export const INK_LIMITS = { bytes: 64_000, pointsPerStroke: 400, strokesPerLayer: 100, pointsPerLayer: 2400, images: 1000, perSecond: 20 } as const
const INK_TOOLS: readonly string[] = ['freehand', 'arrow', 'rectangle']
const INK_COLOURS: readonly string[] = ['red', 'yellow', 'green', 'blue']
const INK_WIDTHS: readonly string[] = ['thin', 'thick']
function parseInkStroke(value: unknown, space: 'slide' | 'image'): InkStroke | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const s = value as Record<string, unknown>
  if (typeof s.tool !== 'string' || !INK_TOOLS.includes(s.tool) || typeof s.ink !== 'string' || !INK_COLOURS.includes(s.ink)
    || typeof s.width !== 'string' || !INK_WIDTHS.includes(s.width)) return null
  if (!Array.isArray(s.points) || s.points.length < 1 || s.points.length > INK_LIMITS.pointsPerStroke) return null
  if (s.tool !== 'freehand' && s.points.length !== 2) return null
  const [w, h] = space === 'image' ? [1, 1] : [1280, 720]
  const points: Array<[number, number]> = []
  for (const point of s.points as unknown[]) {
    if (!Array.isArray(point) || point.length !== 2) return null
    const [x, y] = point as unknown[]
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > w || y > h) return null
    points.push([x, y])
  }
  return { tool: s.tool as InkTool, ink: s.ink as InkColour, width: s.width as InkWidth, points }
}
export function parseInkMessage(value: unknown): InkMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.type !== 'ink.live' || !message.ink || typeof message.ink !== 'object' || Array.isArray(message.ink)) return null
  const v = message.ink as Record<string, unknown>
  if (!nonEmptyString(v.slideId) || v.slideId.length > AUDIENCE_FEEDBACK_LIMITS.slideIdChars) return null
  if (v.space !== 'slide' && v.space !== 'image') return null
  const space = v.space
  if (space === 'image' ? !Number.isSafeInteger(v.image) || Number(v.image) < 0 || Number(v.image) >= INK_LIMITS.images : v.image !== undefined) return null
  if (!Array.isArray(v.strokes) || v.strokes.length > INK_LIMITS.strokesPerLayer) return null
  const strokes: InkStroke[] = []
  let total = 0
  for (const raw of v.strokes) {
    const stroke = parseInkStroke(raw, space)
    if (!stroke) return null
    total += stroke.points.length
    strokes.push(stroke)
  }
  let draft: InkStroke | null = null
  if (v.draft != null) {
    draft = parseInkStroke(v.draft, space)
    if (!draft) return null
    total += draft.points.length
  }
  if (total > INK_LIMITS.pointsPerLayer) return null
  return { type: 'ink.live', ink: { slideId: v.slideId, space, ...(space === 'image' ? { image: Number(v.image) } : {}), strokes, draft } }
}

/**
 * parseInkMessage plus the byte cap, for ink that does not arrive as a frame (the recorder, a
 * recording checkpoint, a stored recording): the checked message, rebuilt from known fields only
 * (bounded by the stroke and point caps), must serialise within INK_LIMITS.bytes. Never throws.
 */
export function parseCappedInkMessage(value: unknown): InkMessage | null {
  try {
    const message = parseInkMessage(value)
    if (!message) return null
    return new TextEncoder().encode(JSON.stringify(message)).length <= INK_LIMITS.bytes ? message : null
  } catch {
    return null
  }
}

export type EndSound = 'none' | 'chime' | 'alarm'
export type InstantSlide =
  | { kind: 'text'; text: string; link?: string; linkQrSvg?: string; shownAt: number }
  | { kind: 'link'; url: string; qrSvg: string; shownAt: number }
  | { kind: 'time'; shownAt: number }
  | { kind: 'countdown'; startedAt: number; durationMs: number; label?: string; endSound?: EndSound; soundAtEnd?: boolean; link?: string; linkQrSvg?: string; shownAt: number }
  | { kind: 'image'; dataUrl: string; width: number; height: number; shownAt: number }
export type InstantSlideMessage = { type: 'instant.state'; slide: InstantSlide | null }
export type PresenterInstantMessage = { type: 'instant.show'; slide: InstantSlide } | { type: 'instant.clear' }

// Feedback boards (ADR-0032): wire types and parsers live in board-protocol.ts.
export { isPresenterBoardMessage }
export type { BoardSettings, BoardStateView, PresenterBoardMessage }

/** `board` is a feedback board: its options are the columns and it takes cards, not votes. */
export type PollType = 'single' | 'multiple' | 'open' | 'ranking' | 'rating' | 'categorisation' | 'board'
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
  /** A board's settings (type `board` only; the parser fills in defaults). */
  board?: BoardSettings
  /** A board's opening cards (type `board` only): pre-work answers. Used once, when the board is first made. */
  seed?: BoardSeedCard[]
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
  /** A board's settings. */
  board?: BoardSettings
  /** A board's cards, groups and big-screen view: full for the presenter, public for the audience. */
  boardState?: BoardStateView
}

// ── Reactions and questions (ADR-0027 with its 2026-09-29 amendment) ──────────────────────
// Audience devices send them through the acknowledged recovery path (`reaction.send`,
// `question.submit` with a submissionId); counts and questions go to presenter sockets only.

/** The registered reaction vocabulary; any other reaction is `custom:<label>`. */
export const REGISTERED_REACTIONS = ['puzzled', 'helped', 'bookmark', 'agree', 'disagree', 'yes', 'no', 'more', 'slower'] as const
export type RegisteredReaction = typeof REGISTERED_REACTIONS[number]
export type ReactionId = RegisteredReaction | `custom:${string}`

export const AUDIENCE_FEEDBACK_LIMITS = {
  customLabelChars: 40,
  questionChars: 500,
  nameChars: 60,
  slideIdChars: 100,
  /** Question and reaction ids as clients and Runs keep them. */
  idChars: 100,
  /** Storage guards for one session's feedback row, not abuse policy (ADR-0027 leaves that open). */
  /** Reaction submissions that changed state (accepted and stored), per session and per participant. */
  reactionSubmissions: 4_000,
  participantReactionSubmissions: 300,
  /** Accepted questions, per session and per participant. */
  questions: 400,
  participantQuestions: 20,
  /** Stored receipts per participant, reactions and questions together. */
  participantReceipts: 600,
  /** UTF-8 bytes of the serialised feedback row; half the Durable Object's 2 MB value limit. */
  feedbackRowBytes: 1_000_000,
} as const

/** `{reaction, slideId, tMs}`; an undo is the same with `withdrawn: true`. */
export interface ReactionInput {
  reaction: ReactionId
  slideId: string
  tMs: number
  withdrawn?: true
}

/** `{text, name?, slideId, tMs}`: untrusted text, trimmed, never HTML. */
export interface QuestionInput {
  text: string
  name?: string
  slideId: string
  tMs: number
}

export interface ReactionSendMessage extends ReactionInput { type: 'reaction.send' }
export interface QuestionSubmitMessage extends QuestionInput { type: 'question.submit' }

/** One accepted change to a participant's reactions, as the Run stores it (no participant). */
export interface ReactionRecord extends ReactionInput {
  sequence: number
  acceptedAt: number
}

/** Current holders per reaction on one slide; reactions nobody holds are left out. */
export type ReactionCounts = Record<string, number>

export interface AudienceQuestion extends QuestionInput {
  questionId: string
  acceptedAt: number
  answered: boolean
}

export interface AudienceSwitches {
  questionsAllowed: boolean
  reactionsAllowed: boolean
}

/** Presenter only: a slide's counts after an accepted reaction, with the records it produced. */
export interface ReactionCountsMessage { type: 'reaction.counts'; slideId: string; counts: ReactionCounts; records: ReactionRecord[] }
/** Presenter only: every question, after each new question or answered mark. */
export interface QuestionsStateMessage { type: 'questions.state'; questions: AudienceQuestion[] }
/** Every protocol-2 socket: the session's pause switches. */
export interface SwitchesStateMessage extends AudienceSwitches { type: 'switches.state' }

export type PresenterAudienceMessage =
  | { type: 'question.answer'; questionId: string; answered: boolean }
  | { type: 'switches.set'; questionsAllowed?: boolean; reactionsAllowed?: boolean }

export type AudienceFeedbackServerMessage = ReactionCountsMessage | QuestionsStateMessage | SwitchesStateMessage

export type PresenterMessage = PointerMessage | InkMessage | SlidePublishMessage | PresenterPollMessage | PresenterInstantMessage | PresenterAudienceMessage | PresenterBoardMessage
export type AudienceMessage = PollVoteMessage | ReactionSendMessage | QuestionSubmitMessage
export type PresenterServerMessage = PollStateMessage | PollVoteRecordMessage
export type ServerMessage = PointerMessage | InkMessage | SlideStateMessage | InstantSlideMessage | SessionClosedMessage | PresenterServerMessage | AudienceFeedbackServerMessage

const END_SOUNDS: readonly string[] = ['none', 'chime', 'alarm']

// An optional web link on a text or countdown slide, with the QR code of it. Returns the fields to
// carry, or null when either is present but malformed (the whole slide is then refused).
// The canonical form of a web link: http(s), no username or password, and `new URL(...).href`, which
// percent-encodes < > " and (in paths) backticks. Anything that still holds one of those or a control
// character is refused, so a link can never open an HTML comment or a Markdown construct downstream.
function canonicalWebLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return url.href.length <= 2048 && !/[<>"`\u0000-\u001f\u007f]/.test(url.href) ? url.href : null
  } catch { return null }
}

function parseSlideLink(v: Record<string, unknown>): { link?: string; linkQrSvg?: string } | null {
  if (v.link === undefined && v.linkQrSvg === undefined) return {}
  const link = canonicalWebLink(v.link)
  if (!link) return null
  if (v.linkQrSvg !== undefined && (typeof v.linkQrSvg !== 'string' || v.linkQrSvg.length > 100_000 || !/^<svg\b/i.test(v.linkQrSvg.trim()))) return null
  return { link, ...(typeof v.linkQrSvg === 'string' ? { linkQrSvg: v.linkQrSvg } : {}) }
}

export function parseInstantSlide(value: unknown): InstantSlide | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Number.isSafeInteger(v.shownAt) || Number(v.shownAt) < 0) return null
  if (v.kind === 'text' && nonEmptyString(v.text) && v.text.length <= 2000) {
    const link = parseSlideLink(v)
    return link ? { kind: 'text', text: v.text, ...link, shownAt: Number(v.shownAt) } : null
  }
  if (v.kind === 'link' && canonicalWebLink(v.url)
    && typeof v.qrSvg === 'string' && v.qrSvg.length <= 100_000 && /^<svg\b/i.test(v.qrSvg.trim()))
    return { kind: 'link', url: canonicalWebLink(v.url) as string, qrSvg: v.qrSvg, shownAt: Number(v.shownAt) }
  if (v.kind === 'time') return { kind: 'time', shownAt: Number(v.shownAt) }
  if (v.kind === 'image' && typeof v.dataUrl === 'string' && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(v.dataUrl)
    && v.dataUrl.length <= 120_000 && Number.isSafeInteger(v.width) && Number.isSafeInteger(v.height)
    && Number(v.width) > 0 && Number(v.height) > 0 && Math.max(Number(v.width), Number(v.height)) <= 1600)
    return { kind: 'image', dataUrl: v.dataUrl, width: Number(v.width), height: Number(v.height), shownAt: Number(v.shownAt) }
  if (v.kind === 'countdown' && Number.isSafeInteger(v.startedAt) && Number.isSafeInteger(v.durationMs)
    && Number(v.durationMs) >= 1000 && Number(v.durationMs) <= 86_400_000
    && (v.label === undefined || (typeof v.label === 'string' && v.label.length <= 120))
    && (v.soundAtEnd === undefined || typeof v.soundAtEnd === 'boolean')
    && (v.endSound === undefined || (typeof v.endSound === 'string' && END_SOUNDS.includes(v.endSound)))) {
    const link = parseSlideLink(v)
    if (!link) return null
    return { kind: 'countdown', startedAt: Number(v.startedAt), durationMs: Number(v.durationMs),
      ...(typeof v.label === 'string' ? { label: v.label } : {}),
      ...(typeof v.endSound === 'string' ? { endSound: v.endSound as EndSound } : {}),
      ...(typeof v.soundAtEnd === 'boolean' ? { soundAtEnd: v.soundAtEnd } : {}), ...link, shownAt: Number(v.shownAt) }
  }
  return null
}

export function parsePresenterMessage(value: string): PresenterMessage | null {
  try {
    const message = JSON.parse(value) as Record<string, unknown>
    if (message.type === 'pointer.live') return new TextEncoder().encode(value).length <= POINTER_LIMITS.bytes ? parsePointerMessage(message) : null
    if (message.type === 'ink.live') return new TextEncoder().encode(value).length <= INK_LIMITS.bytes ? parseInkMessage(message) : null
    if (message.type === 'instant.clear') return { type: 'instant.clear' }
    if ((BOARD_MESSAGE_TYPES as readonly unknown[]).includes(message.type)) return parsePresenterBoardMessage(message)
    if (message.type === 'question.answer') {
      if (!nonEmptyString(message.questionId) || (message.answered !== undefined && typeof message.answered !== 'boolean')) return null
      return { type: 'question.answer', questionId: message.questionId, answered: message.answered !== false }
    }
    if (message.type === 'switches.set') {
      const { questionsAllowed, reactionsAllowed } = message
      if (questionsAllowed === undefined && reactionsAllowed === undefined) return null
      if ((questionsAllowed !== undefined && typeof questionsAllowed !== 'boolean')
        || (reactionsAllowed !== undefined && typeof reactionsAllowed !== 'boolean')) return null
      return { type: 'switches.set',
        ...(typeof questionsAllowed === 'boolean' ? { questionsAllowed } : {}),
        ...(typeof reactionsAllowed === 'boolean' ? { reactionsAllowed } : {}) }
    }
    if (message.type === 'instant.show') {
      const slide = parseInstantSlide(message.slide)
      return slide ? { type: 'instant.show', slide } : null
    }
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
    const lightbox = message.lightbox === undefined ? undefined : parseSlideLightbox(message.lightbox)
    if (
      message.type !== 'slide.publish'
      || !nonEmptyString(message.slideId)
      || typeof message.reveal !== 'number'
      || !Number.isInteger(message.reveal)
      || message.reveal < 0
      || (message.focus != null && !focus)
      || (message.lightbox !== undefined && !lightbox)
      || (message.talkQr !== undefined && typeof message.talkQr !== 'boolean')
    ) return null
    return { type: 'slide.publish', slideId: message.slideId, reveal: message.reveal, focus,
      ...(lightbox ? { lightbox } : {}), ...(message.talkQr ? { talkQr: true } : {}) }
  } catch {
    return null
  }
}

export function parseAudienceMessage(value: string): AudienceMessage | null {
  try {
    const message = JSON.parse(value) as Record<string, unknown>
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null
    if (message.type === 'reaction.send') {
      const reaction = parseReactionInput(message)
      return 'value' in reaction ? { type: 'reaction.send', ...reaction.value } : null
    }
    if (message.type === 'question.submit') {
      const question = parseQuestionInput(message)
      return 'value' in question ? { type: 'question.submit', ...question.value } : null
    }
    if (message.type !== 'poll.vote' || !nonEmptyString(message.pollId)) return null
    const choice = parsePollChoice(message.choice)
    return choice !== null ? { type: 'poll.vote', pollId: message.pollId, choice } : null
  } catch {
    return null
  }
}

function parseFeedbackSlideId(value: unknown): Parsed<string> {
  if (value === undefined || value === null || value === '') return invalid('missing_slide_id', 'slideId is required.')
  if (!nonEmptyString(value) || value.length > AUDIENCE_FEEDBACK_LIMITS.slideIdChars) return invalid('invalid_slide_id', 'slideId must be a short string.')
  return { value }
}

function parseFeedbackTime(value: unknown): Parsed<number> {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? { value: Number(value) } : invalid('invalid_time', 'tMs must be a non-negative integer.')
}

/** A registered identifier, or `custom:<label>` with a trimmed label of 1–40 characters. */
export function parseReactionId(value: unknown): Parsed<ReactionId> {
  if (typeof value !== 'string') return invalid('unknown_reaction', 'reaction must be a registered identifier or custom:<label>.')
  if ((REGISTERED_REACTIONS as readonly string[]).includes(value)) return { value: value as RegisteredReaction }
  if (!value.startsWith('custom:')) return invalid('unknown_reaction', 'reaction must be a registered identifier or custom:<label>.')
  const label = value.slice('custom:'.length).trim()
  if (!label || label.length > AUDIENCE_FEEDBACK_LIMITS.customLabelChars) {
    return invalid('invalid_custom_label', `A custom label must be 1–${AUDIENCE_FEEDBACK_LIMITS.customLabelChars} characters.`)
  }
  return { value: `custom:${label}` }
}

export function parseReactionInput(value: unknown): Parsed<ReactionInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_reaction', 'A reaction must be an object.')
  const body = value as Record<string, unknown>
  const reaction = parseReactionId(body.reaction); if ('error' in reaction) return reaction
  const slideId = parseFeedbackSlideId(body.slideId); if ('error' in slideId) return slideId
  const tMs = parseFeedbackTime(body.tMs); if ('error' in tMs) return tMs
  if (body.withdrawn !== undefined && typeof body.withdrawn !== 'boolean') return invalid('invalid_withdrawn', 'withdrawn must be true or absent.')
  return { value: { reaction: reaction.value, slideId: slideId.value, tMs: tMs.value, ...(body.withdrawn === true ? { withdrawn: true as const } : {}) } }
}

export function parseQuestionInput(value: unknown): Parsed<QuestionInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_question', 'A question must be an object.')
  const body = value as Record<string, unknown>
  if (typeof body.text !== 'string') return invalid('empty_question', 'The question text is required.')
  const text = body.text.trim()
  if (!text) return invalid('empty_question', 'The question text is required.')
  if (text.length > AUDIENCE_FEEDBACK_LIMITS.questionChars) return invalid('question_too_long', `A question is at most ${AUDIENCE_FEEDBACK_LIMITS.questionChars} characters.`)
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') return invalid('invalid_name', 'Name must be a string.')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length > AUDIENCE_FEEDBACK_LIMITS.nameChars) return invalid('name_too_long', `A name is at most ${AUDIENCE_FEEDBACK_LIMITS.nameChars} characters.`)
  const slideId = parseFeedbackSlideId(body.slideId); if ('error' in slideId) return slideId
  const tMs = parseFeedbackTime(body.tMs); if ('error' in tMs) return tMs
  return { value: { text, ...(name ? { name } : {}), slideId: slideId.value, tMs: tMs.value } }
}

export function parseReactionRecord(value: unknown): ReactionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const input = parseReactionInput(record)
  if ('error' in input || input.value.reaction !== record.reaction
    || !Number.isSafeInteger(record.sequence) || Number(record.sequence) < 1 || !Number.isFinite(record.acceptedAt)) return null
  return { ...input.value, sequence: Number(record.sequence), acceptedAt: Number(record.acceptedAt) }
}

export function parseReactionCounts(value: unknown): ReactionCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.some(([reaction, count]) => 'error' in parseReactionId(reaction) || !Number.isSafeInteger(count) || Number(count) < 1)) return null
  return Object.fromEntries(entries) as ReactionCounts
}

export function parseAudienceQuestion(value: unknown): AudienceQuestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const question = value as Record<string, unknown>
  const input = parseQuestionInput(question)
  if ('error' in input || input.value.text !== question.text || !nonEmptyString(question.questionId)
    || question.questionId.length > AUDIENCE_FEEDBACK_LIMITS.idChars
    || !Number.isFinite(question.acceptedAt) || typeof question.answered !== 'boolean') return null
  return { questionId: question.questionId, ...input.value, acceptedAt: Number(question.acceptedAt), answered: question.answered }
}

export function parseAudienceSwitches(value: unknown): AudienceSwitches | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const switches = value as Record<string, unknown>
  return typeof switches.questionsAllowed === 'boolean' && typeof switches.reactionsAllowed === 'boolean'
    ? { questionsAllowed: switches.questionsAllowed, reactionsAllowed: switches.reactionsAllowed } : null
}

/** Reaction counts, questions and pause switches as clients receive them. */
export function parseAudienceFeedbackServerMessage(value: unknown): AudienceFeedbackServerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (message.type === 'switches.state') {
    const switches = parseAudienceSwitches(message)
    return switches ? { type: 'switches.state', ...switches } : null
  }
  if (message.type === 'questions.state') {
    if (!Array.isArray(message.questions)) return null
    const questions = message.questions.map(parseAudienceQuestion)
    return questions.every(Boolean) ? { type: 'questions.state', questions: questions as AudienceQuestion[] } : null
  }
  if (message.type === 'reaction.counts') {
    const slideId = parseFeedbackSlideId(message.slideId)
    const counts = parseReactionCounts(message.counts)
    if ('error' in slideId || !counts || !Array.isArray(message.records)) return null
    const records = message.records.map(parseReactionRecord)
    return records.every(Boolean) ? { type: 'reaction.counts', slideId: slideId.value, counts, records: records as ReactionRecord[] } : null
  }
  return null
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
    const board = message.pollType === 'board' ? parseBoardSettings(message.board, (options as PollOption[]).map((option) => option.optionId)) : null
    if ((message.pollType === 'board') !== (message.board !== undefined) || (message.board !== undefined && !board)) return null
    const boardState = message.boardState === undefined ? null : parseBoardStateView(message.boardState)
    if (message.boardState !== undefined && (!boardState || message.pollType !== 'board')) return null
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
      ...(board ? { board } : {}),
      ...(boardState ? { boardState } : {}),
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
  // A board's columns are its options; only a board carries board settings.
  const board = poll.type === 'board' ? parseBoardSettings(poll.board, validOptions.map((option) => option.optionId)) : null
  if (poll.type === 'board' ? !board : poll.board !== undefined) return null
  const seed = poll.seed === undefined ? null : poll.type === 'board' && board ? parseBoardSeed(poll.seed, validOptions.map((option) => option.optionId), board.cardChars) : null
  if (poll.seed !== undefined && !seed) return null
  return {
    ...extras,
    pollId: poll.pollId,
    ...(nonEmptyString(poll.slideId) ? { slideId: poll.slideId } : {}),
    type: poll.type,
    question: poll.question,
    options: validOptions,
    visibility: poll.visibility,
    ...pollLimits(poll),
    ...(board ? { board } : {}),
    ...(seed && seed.length ? { seed } : {}),
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

export function parseSlideLightbox(value: unknown): SlideLightboxState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const lightbox = value as Record<string, unknown>
  return typeof lightbox.open === 'boolean' && Number.isSafeInteger(lightbox.index) && Number(lightbox.index) >= 0
    ? { open: lightbox.open, index: Number(lightbox.index) } : null
}

export function isPollType(value: unknown): value is PollType {
  return typeof value === 'string' && ['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation', 'board'].includes(value)
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

// ── Shared talk (share for comments) ─────────────────────────────────────────────────────────
// Wire types for the SharedTalk Durable Object: the owner's pushes, the colleague's items, and
// the socket events both sides receive. Parsers return a value or a `{error}` naming the first
// rule the input broke, so the Worker can answer with a precise 400 and clients can reuse them.

export const SHARED_TALK_LIMITS = {
  htmlChars: 16 * 1024 * 1024,
  slides: 1_000,
  slideIdChars: 200,
  slideTitleChars: 500,
  slideTextChars: 50_000,
  itemIdChars: 100,
  itemTextChars: 20_000,
  reasonChars: 2_000,
  sectionChars: 200,
  nameChars: 80,
  titleChars: 300,
  itemsPerShare: 5_000,
  /** Total UTF-8 bytes of item JSON one share holds; sized well inside Durable Object memory. */
  itemBytesPerShare: 8 * 1024 * 1024,
  /** Token bucket on new items per share: `itemBurst` at once, refilled at `itemsPerMinute`. */
  itemBurst: 30,
  itemsPerMinute: 30,
} as const

export interface SharedSlide {
  slideId: string
  title: string
  text: string
}

export interface SharedTalkPush {
  revision: number
  html: string
  slides: SharedSlide[]
}

export type SharedItemKind = 'note' | 'replace' | 'delete' | 'insert'
export const SHARED_ITEM_KINDS: readonly SharedItemKind[] = ['note', 'replace', 'delete', 'insert']

export type SharedItemBody =
  | { kind: 'note'; slideId: string; text: string }
  | { kind: 'replace'; slideId: string; baseRevision: number; text: string }
  | { kind: 'delete'; slideId: string; baseRevision: number; reason?: string }
  | { kind: 'insert'; afterSlideId: string; baseRevision: number; text: string; section?: string }

/** What the colleague's page posts: the body plus an idempotency key and an optional name. */
export type SharedItemPost = SharedItemBody & { itemId: string; name?: string }

/** `done` closes a note; `new` reverts (Undo). The owner may move an item between any two. */
export type SharedItemStatus = 'new' | 'accepted' | 'dismissed' | 'done'
export const SHARED_ITEM_STATUSES: readonly SharedItemStatus[] = ['new', 'accepted', 'dismissed', 'done']
export type SharedItemStatusUpdate = SharedItemStatus

function sharedItemStatus(value: unknown): value is SharedItemStatus {
  return typeof value === 'string' && (SHARED_ITEM_STATUSES as readonly string[]).includes(value)
}

/** An item as the Worker stores it and as the owner receives it. */
export type SharedItem = SharedItemPost & {
  createdAt: number
  /** Share event sequence at which the item arrived. */
  seq: number
  status: SharedItemStatus
  statusAt?: number
  /** Share event sequence of the latest status change; equals `seq` while the item is new. */
  statusSeq: number
}

export interface SharedTalkJson {
  shareId: string
  title: string
  revision: number
  updatedAt: number | null
  slides: SharedSlide[]
}

/** Audience socket: the owner pushed a new revision; fetch talk.json (or reload the page). */
export interface TalkUpdatedMessage { type: 'talk.updated'; revision: number; seq: number }
/** Audience socket: the owner changed an item's status. */
export interface ItemStatusMessage { type: 'item.status'; itemId: string; status: SharedItemStatus; at: number; seq: number }
/** Owner socket: an item arrived (live or replayed after `?since=`). */
export interface ItemNewMessage { type: 'item.new'; item: SharedItem; seq: number }
/** Both sockets: Stop sharing or retirement. */
export interface ShareClosedMessage { type: 'share.closed'; reason: 'stopped' | 'retired' }

export type SharedTalkAudienceMessage = TalkUpdatedMessage | ItemStatusMessage | ShareClosedMessage
export type SharedTalkOwnerMessage = ItemNewMessage | ShareClosedMessage

export type Parsed<T> = { value: T } | { error: { code: string; message: string } }

function invalid<T>(code: string, message: string): Parsed<T> {
  return { error: { code, message } }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export function parseSharedTalkPush(value: unknown): Parsed<SharedTalkPush> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_push', 'Push body must be an object.')
  const body = value as Record<string, unknown>
  if (!positiveInteger(body.revision)) return invalid('invalid_revision', 'Revision must be a positive integer.')
  if (!nonEmptyString(body.html)) return invalid('invalid_html', 'The handout HTML is required.')
  if (body.html.length > SHARED_TALK_LIMITS.htmlChars) return invalid('html_too_large', 'The handout HTML is too large.')
  if (!Array.isArray(body.slides)) return invalid('invalid_slides', 'Slides must be an array.')
  if (body.slides.length > SHARED_TALK_LIMITS.slides) return invalid('too_many_slides', 'The talk has too many slides.')
  const slides: SharedSlide[] = []
  const seen = new Set<string>()
  for (const entry of body.slides) {
    if (!entry || typeof entry !== 'object') return invalid('invalid_slide', 'Each slide must be an object.')
    const slide = entry as Record<string, unknown>
    if (!nonEmptyString(slide.slideId) || slide.slideId.length > SHARED_TALK_LIMITS.slideIdChars) {
      return invalid('invalid_slide', 'Each slide needs a slideId.')
    }
    if (!boundedString(slide.title, SHARED_TALK_LIMITS.slideTitleChars)) return invalid('invalid_slide', 'Slide titles must be short strings.')
    if (typeof slide.text !== 'string') return invalid('invalid_slide', 'Slide text must be a string.')
    if (slide.text.length > SHARED_TALK_LIMITS.slideTextChars) return invalid('slide_too_large', 'A slide\'s text is too large.')
    if (seen.has(slide.slideId)) return invalid('duplicate_slide_id', 'Slide ids must be unique.')
    seen.add(slide.slideId)
    slides.push({ slideId: slide.slideId, title: slide.title, text: slide.text })
  }
  return { value: { revision: body.revision, html: body.html, slides } }
}

export function parseSharedItemPost(value: unknown): Parsed<SharedItemPost> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('invalid_item', 'Item body must be an object.')
  const body = value as Record<string, unknown>
  if (typeof body.itemId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.itemId) || body.itemId.length > SHARED_TALK_LIMITS.itemIdChars) {
    return invalid('invalid_item_id', 'itemId must be letters, numbers, hyphens or underscores.')
  }
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') return invalid('invalid_name', 'Name must be a string.')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length > SHARED_TALK_LIMITS.nameChars) return invalid('invalid_name', 'Name is too long.')
  const common = { itemId: body.itemId, ...(name ? { name } : {}) }
  if (typeof body.kind !== 'string' || !(SHARED_ITEM_KINDS as readonly string[]).includes(body.kind)) {
    return invalid('invalid_item_kind', 'Item kind must be note, replace, delete or insert.')
  }
  const kind = body.kind as SharedItemKind

  const text = (): Parsed<string> => {
    if (!nonEmptyString(body.text)) return invalid('invalid_text', 'Text is required.')
    if (body.text.length > SHARED_TALK_LIMITS.itemTextChars) return invalid('item_too_large', 'Text is too long.')
    return { value: body.text }
  }
  const slideId = (field: 'slideId' | 'afterSlideId'): Parsed<string> => {
    const candidate = body[field]
    return nonEmptyString(candidate) && candidate.length <= SHARED_TALK_LIMITS.slideIdChars
      ? { value: candidate }
      : invalid('invalid_slide_id', `${field} is required.`)
  }
  const baseRevision = (): Parsed<number> => positiveInteger(body.baseRevision)
    ? { value: body.baseRevision }
    : invalid('invalid_base_revision', 'baseRevision must be a positive integer.')

  if (kind === 'note') {
    const s = slideId('slideId'); if ('error' in s) return s
    const t = text(); if ('error' in t) return t
    return { value: { ...common, kind, slideId: s.value, text: t.value } }
  }
  if (kind === 'replace') {
    const s = slideId('slideId'); if ('error' in s) return s
    const b = baseRevision(); if ('error' in b) return b
    const t = text(); if ('error' in t) return t
    return { value: { ...common, kind, slideId: s.value, baseRevision: b.value, text: t.value } }
  }
  if (kind === 'delete') {
    const s = slideId('slideId'); if ('error' in s) return s
    const b = baseRevision(); if ('error' in b) return b
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') return invalid('invalid_reason', 'Reason must be a string.')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length > SHARED_TALK_LIMITS.reasonChars) return invalid('item_too_large', 'Reason is too long.')
    return { value: { ...common, kind, slideId: s.value, baseRevision: b.value, ...(reason ? { reason } : {}) } }
  }
  const a = slideId('afterSlideId'); if ('error' in a) return a
  const b = baseRevision(); if ('error' in b) return b
  const t = text(); if ('error' in t) return t
  if (body.section !== undefined && body.section !== null && typeof body.section !== 'string') return invalid('invalid_section', 'Section must be a string.')
  const section = typeof body.section === 'string' ? body.section.trim() : ''
  if (section.length > SHARED_TALK_LIMITS.sectionChars) return invalid('invalid_section', 'Section title is too long.')
  return { value: { ...common, kind, afterSlideId: a.value, baseRevision: b.value, text: t.value, ...(section ? { section } : {}) } }
}

export function parseItemStatusPatch(value: unknown): Parsed<SharedItemStatusUpdate> {
  const status = value && typeof value === 'object' ? (value as Record<string, unknown>).status : undefined
  return sharedItemStatus(status)
    ? { value: status }
    : invalid('invalid_status', 'Status must be new, accepted, dismissed or done.')
}

export function parseSharedTalkServerMessage(value: string): SharedTalkAudienceMessage | SharedTalkOwnerMessage | null {
  try {
    const message = JSON.parse(value) as Record<string, unknown>
    if (message.type === 'talk.updated') {
      return positiveInteger(message.revision) && positiveInteger(message.seq)
        ? { type: 'talk.updated', revision: message.revision, seq: message.seq }
        : null
    }
    if (message.type === 'item.status') {
      return nonEmptyString(message.itemId)
        && sharedItemStatus(message.status)
        && typeof message.at === 'number' && positiveInteger(message.seq)
        ? { type: 'item.status', itemId: message.itemId, status: message.status, at: message.at, seq: message.seq }
        : null
    }
    if (message.type === 'item.new') {
      const item = message.item as Record<string, unknown> | undefined
      const parsed = parseSharedItemPost(item)
      if ('error' in parsed || !item || !positiveInteger(message.seq)) return null
      if (typeof item.createdAt !== 'number' || !positiveInteger(item.seq) || !positiveInteger(item.statusSeq)) return null
      if (!sharedItemStatus(item.status)) return null
      return {
        type: 'item.new',
        seq: message.seq,
        item: {
          ...parsed.value,
          createdAt: item.createdAt,
          seq: item.seq,
          status: item.status,
          statusSeq: item.statusSeq,
          ...(typeof item.statusAt === 'number' ? { statusAt: item.statusAt } : {}),
        },
      }
    }
    if (message.type === 'share.closed') {
      return message.reason === 'stopped' || message.reason === 'retired' ? { type: 'share.closed', reason: message.reason } : null
    }
    return null
  } catch {
    return null
  }
}
