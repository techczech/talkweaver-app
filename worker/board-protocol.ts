// Wire types and parsers for feedback boards (ADR-0032, amendment 2026-09-30 point 1).
//
// A board is a poll of type `board`. Its definition carries the columns as `options` and the board's
// settings as `board`; its `poll.state` carries the settings and, as `boardState`, the cards, the
// numbered groups and the big-screen view the worker derived. Presenter sockets get the full board;
// audience sockets get the public board: no hidden cards and nothing that names or marks a participant.
// This file has no runtime imports so both protocol.ts and the reducer can use it.

export const BOARD_DEFAULTS = {
  /** Entries (a group counts once) on the big screen before new cards wait; null is "All". */
  limit: 24 as number | null,
  cardChars: 140,
  cardsPerPhone: 5,
  names: false,
  closesAfterDays: 7,
} as const

export const BOARD_LIMITS = {
  /**
   * Bounds on a definition. The compiler warns about columns outside 2–4 and over-long names, hints,
   * instructions and examples, but still emits the board; the worker only refuses what is absurd.
   */
  columns: 10,
  instructionsChars: 1_000,
  exampleChars: 500,
  hintChars: 300,
  maxLimit: 1_000,
  maxCardChars: 1_000,
  maxCardsPerPhone: 100,
  maxClosesAfterDays: 365,
  nameChars: 60,
  /** Column, card and poll ids (column ids are the compiler's option ids, which embed the slide id). */
  idChars: 200,
  /** "Show next 12". */
  releaseStep: 12,
  /** Storage guards for one board's row. */
  cardsPerBoard: 1_000,
  /** Card submissions (add, edit, withdraw) one participant may store on one board. */
  participantSubmissions: 200,
  /** UTF-8 bytes of one board's row; half the Durable Object's 2 MB value limit. */
  boardRowBytes: 1_000_000,
  /** Bytes an audience submission may never take: room left for the presenter's own operations. */
  presenterReserveBytes: 64_000,
} as const

/** The board's settings, as the compiler writes them onto the poll definition (defaults filled in). */
export interface BoardSettings {
  /** The paragraph under the question. */
  instructions?: string
  /** The `>` line: a dashed, never-counted example card. */
  example?: string
  /** A column's hint, keyed by the column's optionId. */
  hints?: Record<string, string>
  limit: number | null
  cardChars: number
  cardsPerPhone: number
  /** Names optional: a card may carry a name only the presenter sees. */
  names: boolean
  closesAfterDays: number
}

/** A card as a client receives it. Presenter-only fields are marked. */
export interface BoardCardView {
  cardId: string
  column: string
  text: string
  acceptedAt: number
  /** The number of the group the card is in. */
  group?: number
  /** Past the big-screen limit: on phones and in the presenter's panel, not on the big screen. */
  waiting?: true
  /** Presenter only. */
  hidden?: true
  /** Presenter only: the name the sender typed, when the board takes names. */
  name?: string
  /** Presenter only: the group this card was split out of (that number is retired). */
  fromGroup?: number
  /** Presenter only: the presenter has moved, merged, split or hidden it (not new any more). */
  touched?: true
}

export interface BoardGroupView {
  n: number
  column: string
  /** The group's cards, first the card others were merged onto. Public: visible cards only. */
  cardIds: string[]
  /** Visible cards in the group: the "×3". */
  count: number
  /**
   * The presenter's wording for the group (D13, "Edit the group's wording"), shown on every screen in
   * place of its first card's text; the cards keep their own. Public: the presenter wrote it.
   */
  label?: string
}

export type BoardScreenEntry = { group: number } | { cardId: string }

export interface BoardColumnView {
  columnId: string
  /** What the big screen shows in this column, in order: groups (largest first), then singles, newest first. */
  onScreen: BoardScreenEntry[]
  /** Visible single cards in this column that wait: "+ n more on your phone". */
  waiting: number
  /** Visible cards in this column, grouped or not. */
  cards: number
}

export type BoardColumnRelease = 'all' | 'groupsOnly'

/** How much the presenter has released past the limit. */
export interface BoardRelease {
  /** Singles released past the limit by "Show next 12". */
  extra: number
  /** "Show all": every card, including ones still to come. */
  all: boolean
  /** "Groups only": singles stay on phones. */
  groupsOnly: boolean
  /** Per-column overrides from a column's own menu. */
  columns: Record<string, BoardColumnRelease>
}

export interface BoardStateView {
  frozen: boolean
  limit: number | null
  release: BoardRelease
  /** Oldest first. Public: visible cards only. */
  cards: BoardCardView[]
  /** Public: groups with at least one visible card. */
  groups: BoardGroupView[]
  columns: BoardColumnView[]
  /** Entries on the board (a group counts once) and how many of them the big screen shows. */
  entries: number
  shown: number
  waiting: number
  /** Visible cards on the board. */
  cardCount: number
}

/** A participant's own card, as their own snapshot lists it (hidden and withdrawn cards are left out). */
export interface OwnBoardCard {
  pollId: string
  cardId: string
  column: string
  text: string
  /** In a group: no longer editable. */
  sorted: boolean
  waiting: boolean
}

/** A participant's allowance on one board, as their own snapshot gives it. Hidden cards count. */
export interface OwnBoardAllowance {
  pollId: string
  cardsUsed: number
  cardsPerPhone: number
}

export function parseOwnBoardAllowance(value: unknown): OwnBoardAllowance | null {
  if (!record(value) || !shortId(value.pollId) || !Number.isSafeInteger(value.cardsUsed) || Number(value.cardsUsed) < 0
    || !boundedInteger(value.cardsPerPhone, 1, BOARD_LIMITS.maxCardsPerPhone)) return null
  return { pollId: value.pollId, cardsUsed: Number(value.cardsUsed), cardsPerPhone: Number(value.cardsPerPhone) }
}

export type CardTarget = { cardId: string } | { group: number }

/** The presenter's board operations; each goes through `operation` with an operationId. */
export type PresenterBoardMessage =
  | { type: 'board.move'; pollId: string; target: CardTarget; column: string }
  | { type: 'board.merge'; pollId: string; source: CardTarget; target: CardTarget }
  | { type: 'board.split'; pollId: string; group: number }
  | { type: 'board.hide'; pollId: string; target: CardTarget; hidden: boolean }
  | { type: 'board.freeze'; pollId: string; frozen: boolean }
  | { type: 'board.release'; pollId: string; mode: 'next'; count: number }
  | { type: 'board.release'; pollId: string; mode: 'all' | 'groupsOnly' | 'limit' }
  | { type: 'board.release'; pollId: string; mode: 'all' | 'groupsOnly' | 'limit'; column: string }
  | { type: 'board.limit'; pollId: string; limit: number | null }
  /** The group's own wording; an empty text clears it (the first card's text shows again). */
  | { type: 'board.relabel'; pollId: string; group: number; text: string }

export type BoardMessageType = PresenterBoardMessage['type']
export const BOARD_MESSAGE_TYPES: readonly BoardMessageType[] = ['board.move', 'board.merge', 'board.split', 'board.hide', 'board.freeze', 'board.release', 'board.limit', 'board.relabel']

/** Whether a parsed presenter message is a board operation. */
export function isPresenterBoardMessage<T extends { type: string }>(message: T): message is Extract<T, PresenterBoardMessage> {
  return (BOARD_MESSAGE_TYPES as readonly string[]).includes(message.type)
}

export interface CardAddInput { pollId: string; column: string; text: string; name?: string }
export interface CardEditInput { pollId: string; cardId: string; text: string }
export interface CardWithdrawInput { pollId: string; cardId: string }

type Result<T> = { value: T } | { error: { code: string; message: string } }
function fail<T>(code: string, message: string): Result<T> { return { error: { code, message } } }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function shortId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= BOARD_LIMITS.idChars
}
function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
}
function optionalText(value: unknown, max: number): Result<string | undefined> {
  if (value === undefined || value === null) return { value: undefined }
  if (typeof value !== 'string' || value.length > max) return fail('invalid_board', 'Board text is too long.')
  const trimmed = value.trim()
  return { value: trimmed || undefined }
}

/** Characters as a person counts them: code points, so an emoji is one. */
export function cardLength(text: string): number {
  let length = 0
  for (const _ of text) length++
  return length
}

/** A card a board opens with (pre-work answers put on a board slide): the column's optionId and the text. */
export interface BoardSeedCard {
  column: string
  text: string
}

/** The most seed cards one board opens with. */
export const BOARD_SEED_MAX = 500

/**
 * Cards a board poll opens with, read against the poll's columns. Text is trimmed and cut to the
 * board's card length; a card for an unknown column or without text is dropped. Null when it is not a list.
 */
export function parseBoardSeed(value: unknown, columnIds: string[], cardChars: number): BoardSeedCard[] | null {
  if (!Array.isArray(value)) return null
  const cards: BoardSeedCard[] = []
  for (const candidate of value) {
    if (cards.length >= BOARD_SEED_MAX) break
    if (!candidate || typeof candidate !== 'object') continue
    const { column, text } = candidate as Record<string, unknown>
    if (typeof column !== 'string' || !columnIds.includes(column) || typeof text !== 'string') continue
    const trimmed = [...text.trim()].slice(0, cardChars).join('').trim()
    if (trimmed) cards.push({ column, text: trimmed })
  }
  return cards
}

/**
 * A board definition's settings. Absent settings take their defaults; `columnIds` are the poll's
 * option ids (hints for other ids are refused). Null when a present setting is invalid.
 */
export function parseBoardSettings(value: unknown, columnIds: string[]): BoardSettings | null {
  if (columnIds.length < 1 || columnIds.length > BOARD_LIMITS.columns) return null
  if (value !== undefined && !record(value)) return null
  const board = (value ?? {}) as Record<string, unknown>
  const instructions = optionalText(board.instructions, BOARD_LIMITS.instructionsChars)
  const example = optionalText(board.example, BOARD_LIMITS.exampleChars)
  if ('error' in instructions || 'error' in example) return null
  let hints: Record<string, string> | undefined
  if (board.hints !== undefined) {
    if (!record(board.hints)) return null
    const entries: Array<[string, string]> = []
    for (const [columnId, hint] of Object.entries(board.hints)) {
      const parsed = optionalText(hint, BOARD_LIMITS.hintChars)
      if (!columnIds.includes(columnId) || 'error' in parsed) return null
      if (parsed.value) entries.push([columnId, parsed.value])
    }
    if (entries.length) hints = Object.fromEntries(entries)
  }
  const limit = board.limit === undefined ? BOARD_DEFAULTS.limit : board.limit
  if (limit !== null && !boundedInteger(limit, 1, BOARD_LIMITS.maxLimit)) return null
  const cardChars = board.cardChars ?? BOARD_DEFAULTS.cardChars
  const cardsPerPhone = board.cardsPerPhone ?? BOARD_DEFAULTS.cardsPerPhone
  const closesAfterDays = board.closesAfterDays ?? BOARD_DEFAULTS.closesAfterDays
  const names = board.names ?? BOARD_DEFAULTS.names
  if (!boundedInteger(cardChars, 1, BOARD_LIMITS.maxCardChars) || !boundedInteger(cardsPerPhone, 1, BOARD_LIMITS.maxCardsPerPhone)
    || !boundedInteger(closesAfterDays, 1, BOARD_LIMITS.maxClosesAfterDays) || typeof names !== 'boolean') return null
  return {
    ...(instructions.value ? { instructions: instructions.value } : {}),
    ...(example.value ? { example: example.value } : {}),
    ...(hints ? { hints } : {}),
    limit: limit as number | null, cardChars, cardsPerPhone, names, closesAfterDays,
  }
}

function parseTarget(value: unknown): CardTarget | null {
  if (!record(value)) return null
  if (value.cardId !== undefined) return shortId(value.cardId) && value.group === undefined ? { cardId: value.cardId } : null
  return boundedInteger(value.group, 1, Number.MAX_SAFE_INTEGER) ? { group: Number(value.group) } : null
}

/** A presenter board operation, or null. */
export function parsePresenterBoardMessage(message: Record<string, unknown>): PresenterBoardMessage | null {
  const pollId = message.pollId
  if (typeof pollId !== 'string' || !pollId.trim()) return null
  switch (message.type) {
    case 'board.move': {
      const target = parseTarget(message.target)
      return target && shortId(message.column) ? { type: 'board.move', pollId, target, column: message.column } : null
    }
    case 'board.merge': {
      const source = parseTarget(message.source)
      const target = parseTarget(message.target)
      return source && target ? { type: 'board.merge', pollId, source, target } : null
    }
    case 'board.split':
      return boundedInteger(message.group, 1, Number.MAX_SAFE_INTEGER) ? { type: 'board.split', pollId, group: Number(message.group) } : null
    case 'board.hide': {
      const target = parseTarget(message.target)
      if (!target || (message.hidden !== undefined && typeof message.hidden !== 'boolean')) return null
      return { type: 'board.hide', pollId, target, hidden: message.hidden !== false }
    }
    case 'board.freeze':
      if (message.frozen !== undefined && typeof message.frozen !== 'boolean') return null
      return { type: 'board.freeze', pollId, frozen: message.frozen !== false }
    case 'board.release': {
      if (message.mode === 'next') {
        if (message.column !== undefined) return null
        const count = message.count ?? BOARD_LIMITS.releaseStep
        return boundedInteger(count, 1, BOARD_LIMITS.cardsPerBoard) ? { type: 'board.release', pollId, mode: 'next', count } : null
      }
      if (message.mode !== 'all' && message.mode !== 'groupsOnly' && message.mode !== 'limit') return null
      if (message.column === undefined) return { type: 'board.release', pollId, mode: message.mode }
      return shortId(message.column) ? { type: 'board.release', pollId, mode: message.mode, column: message.column } : null
    }
    case 'board.limit':
      return message.limit === null || boundedInteger(message.limit, 1, BOARD_LIMITS.maxLimit)
        ? { type: 'board.limit', pollId, limit: message.limit as number | null } : null
    case 'board.relabel': {
      // Text only, trimmed; the board's own card length is applied by the reducer (card_too_long).
      if (!boundedInteger(message.group, 1, Number.MAX_SAFE_INTEGER) || typeof message.text !== 'string'
        || message.text.length > BOARD_LIMITS.maxCardChars * 2) return null
      return { type: 'board.relabel', pollId, group: Number(message.group), text: message.text.trim() }
    }
    default:
      return null
  }
}

function parseCardText(value: unknown): Result<string> {
  if (typeof value !== 'string') return fail('empty_card', 'The card needs some text.')
  // The board's own length limit is applied by the reducer; this bound only keeps garbage out.
  if (value.length > BOARD_LIMITS.maxCardChars * 2) return fail('card_too_long', 'The card is too long.')
  const text = value.trim()
  return text ? { value: text } : fail('empty_card', 'The card needs some text.')
}

function parsePollIdField(value: unknown): Result<string> {
  return shortId(value) ? { value } : fail('invalid_poll_id', 'pollId is required.')
}

export function parseCardAddInput(value: unknown): Result<CardAddInput> {
  if (!record(value)) return fail('invalid_card', 'A card must be an object.')
  const pollId = parsePollIdField(value.pollId); if ('error' in pollId) return pollId
  if (!shortId(value.column)) return fail('invalid_column', 'column is required.')
  const text = parseCardText(value.text); if ('error' in text) return text
  if (value.name !== undefined && value.name !== null && typeof value.name !== 'string') return fail('invalid_name', 'Name must be a string.')
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (name.length > BOARD_LIMITS.nameChars) return fail('name_too_long', `A name is at most ${BOARD_LIMITS.nameChars} characters.`)
  return { value: { pollId: pollId.value, column: value.column, text: text.value, ...(name ? { name } : {}) } }
}

export function parseCardEditInput(value: unknown): Result<CardEditInput> {
  if (!record(value)) return fail('invalid_card', 'A card must be an object.')
  const pollId = parsePollIdField(value.pollId); if ('error' in pollId) return pollId
  if (!shortId(value.cardId)) return fail('invalid_card_id', 'cardId is required.')
  const text = parseCardText(value.text); if ('error' in text) return text
  return { value: { pollId: pollId.value, cardId: value.cardId, text: text.value } }
}

export function parseCardWithdrawInput(value: unknown): Result<CardWithdrawInput> {
  if (!record(value)) return fail('invalid_card', 'A card must be an object.')
  const pollId = parsePollIdField(value.pollId); if ('error' in pollId) return pollId
  if (!shortId(value.cardId)) return fail('invalid_card_id', 'cardId is required.')
  return { value: { pollId: pollId.value, cardId: value.cardId } }
}

function parseCardView(value: unknown, role: 'presenter' | 'audience'): BoardCardView | null {
  if (!record(value) || !shortId(value.cardId) || !shortId(value.column) || typeof value.text !== 'string'
    || !Number.isFinite(value.acceptedAt)) return null
  if (value.group !== undefined && !boundedInteger(value.group, 1, Number.MAX_SAFE_INTEGER)) return null
  if (value.waiting !== undefined && value.waiting !== true) return null
  const presenterOnly = value.hidden !== undefined || value.name !== undefined || value.fromGroup !== undefined || value.touched !== undefined
  if (role === 'audience' && presenterOnly) return null
  if ((value.hidden !== undefined && value.hidden !== true) || (value.touched !== undefined && value.touched !== true)
    || (value.name !== undefined && typeof value.name !== 'string')
    || (value.fromGroup !== undefined && !boundedInteger(value.fromGroup, 1, Number.MAX_SAFE_INTEGER))) return null
  return {
    cardId: value.cardId, column: value.column, text: value.text, acceptedAt: Number(value.acceptedAt),
    ...(value.group !== undefined ? { group: Number(value.group) } : {}),
    ...(value.waiting ? { waiting: true as const } : {}),
    ...(value.hidden ? { hidden: true as const } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(value.fromGroup !== undefined ? { fromGroup: Number(value.fromGroup) } : {}),
    ...(value.touched ? { touched: true as const } : {}),
  }
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/**
 * A board's content as a client receives it. With `role: 'audience'` anything presenter-only
 * (a hidden card, a name, split history) makes the whole board invalid, so a client never shows it.
 */
export function parseBoardStateView(value: unknown, role: 'presenter' | 'audience' = 'presenter'): BoardStateView | null {
  if (!record(value) || typeof value.frozen !== 'boolean' || !Array.isArray(value.cards) || !Array.isArray(value.groups)
    || !Array.isArray(value.columns) || !record(value.release)) return null
  if (value.limit !== null && !boundedInteger(value.limit, 1, BOARD_LIMITS.maxLimit)) return null
  if (![value.entries, value.shown, value.waiting, value.cardCount].every(count)) return null
  const release = value.release
  if (!count(release.extra) || typeof release.all !== 'boolean' || typeof release.groupsOnly !== 'boolean' || !record(release.columns)
    || Object.values(release.columns).some((mode) => mode !== 'all' && mode !== 'groupsOnly')) return null
  const cards = value.cards.map((card) => parseCardView(card, role))
  if (cards.some((card) => !card)) return null
  const groups: BoardGroupView[] = []
  for (const group of value.groups) {
    if (!record(group) || !boundedInteger(group.n, 1, Number.MAX_SAFE_INTEGER) || !shortId(group.column) || !count(group.count)
      || !Array.isArray(group.cardIds) || !group.cardIds.every(shortId)) return null
    if (group.label !== undefined && (typeof group.label !== 'string' || !group.label.trim() || group.label.length > BOARD_LIMITS.maxCardChars * 2)) return null
    groups.push({ n: Number(group.n), column: group.column, cardIds: [...group.cardIds], count: group.count,
      ...(typeof group.label === 'string' ? { label: group.label } : {}) })
  }
  const columns: BoardColumnView[] = []
  for (const column of value.columns) {
    if (!record(column) || !shortId(column.columnId) || !count(column.waiting) || !count(column.cards) || !Array.isArray(column.onScreen)) return null
    const onScreen: BoardScreenEntry[] = []
    for (const entry of column.onScreen) {
      if (record(entry) && shortId(entry.cardId) && entry.group === undefined) onScreen.push({ cardId: entry.cardId })
      else if (record(entry) && boundedInteger(entry.group, 1, Number.MAX_SAFE_INTEGER) && entry.cardId === undefined) onScreen.push({ group: Number(entry.group) })
      else return null
    }
    columns.push({ columnId: column.columnId, onScreen, waiting: column.waiting, cards: column.cards })
  }
  return {
    frozen: value.frozen, limit: value.limit as number | null,
    release: { extra: release.extra, all: release.all, groupsOnly: release.groupsOnly,
      columns: { ...(release.columns as Record<string, BoardColumnRelease>) } },
    cards: cards as BoardCardView[], groups, columns,
    entries: Number(value.entries), shown: Number(value.shown), waiting: Number(value.waiting), cardCount: Number(value.cardCount),
  }
}

export function parseOwnBoardCard(value: unknown): OwnBoardCard | null {
  if (!record(value) || !shortId(value.pollId) || !shortId(value.cardId) || !shortId(value.column) || typeof value.text !== 'string'
    || typeof value.sorted !== 'boolean' || typeof value.waiting !== 'boolean') return null
  return { pollId: value.pollId, cardId: value.cardId, column: value.column, text: value.text, sorted: value.sorted, waiting: value.waiting }
}

/** The sender's receipt for a card add, edit or withdrawal; a retry with the same submissionId repeats it. */
export interface CardAck {
  type: 'card.ack'
  submissionId: string
  pollId: string
  status: 'confirmed' | 'rejected'
  error?: string
  /** The card the submission made or changed. */
  cardId?: string
  /** Confirmed only: the sender's cards on this board afterwards, hidden ones included. */
  cardsUsed?: number
}

export function parseCardAck(value: unknown): CardAck | null {
  // pollId is empty on the receipt for a submission that named no valid board.
  if (!record(value) || value.type !== 'card.ack' || typeof value.submissionId !== 'string'
    || typeof value.pollId !== 'string' || value.pollId.length > BOARD_LIMITS.idChars
    || (value.status !== 'confirmed' && value.status !== 'rejected')
    || (value.error !== undefined && typeof value.error !== 'string')
    || (value.cardId !== undefined && !shortId(value.cardId))
    || (value.cardsUsed !== undefined && (!Number.isSafeInteger(value.cardsUsed) || Number(value.cardsUsed) < 0))) return null
  return { type: 'card.ack', submissionId: value.submissionId, pollId: value.pollId, status: value.status,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.cardId === 'string' ? { cardId: value.cardId } : {}),
    ...(value.cardsUsed !== undefined ? { cardsUsed: Number(value.cardsUsed) } : {}) }
}
