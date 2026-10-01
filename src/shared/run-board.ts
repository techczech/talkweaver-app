// A feedback board as a Run keeps it (ADR-0032 point 7; feedback-boards ticket 06, drawings R1–R9).
//
// Shared by main (the flush from the live session, normalising a Run on read, the share link) and
// History (the Run card, Copy as Markdown), so it carries no Node or DOM code. The board is the
// worker's presenter view of it, mirrored: columns, cards (hidden ones included and marked, so the
// Run keeps every card), numbered groups and their counts. A card's text and a name are untrusted:
// they are always rendered as text, a name is never shown outside the app, and a hidden card never
// leaves it (not in Markdown, not on the share link).
import type { PollStateMessage } from '../../worker/protocol'

export interface RunBoardCard {
  /** The worker's card id (`card-<n>`), stable for the board. */
  id: string
  column: string
  text: string
  /** When the worker accepted it (ms since the epoch). */
  acceptedAt: number
  /** The number of the group it is in. */
  group?: number
  /** Hidden by the presenter, on its own or with its group. */
  hidden?: true
  /** "Put back" in History: shown here and on the share link although the board hid it. */
  putBack?: true
  /** Only when the board took names; shown to the speaker only. */
  name?: string
}

export interface RunBoardGroup {
  n: number
  column: string
  /** First the card the others were merged onto. */
  cardIds: string[]
  /** The presenter's wording for the group (board.relabel), shown in place of its first card's text. */
  label?: string
}

export interface RunBoard {
  /** The board poll's id. */
  id: string
  slideId?: string
  question: string
  columns: Array<{ id: string; label: string }>
  /** Oldest first. */
  cards: RunBoardCard[]
  groups: RunBoardGroup[]
  frozen?: true
  /**
   * The live session it came from (not a secret: the token stays in the app's encrypted store). A
   * board's identity on the Run is its poll id AND its session: the same authored board shown in two
   * live sessions of one Run is two boards.
   */
  sessionId?: string
  /** When that live session started (ms): History's subtitle when a Run holds the same board twice. */
  liveStartedAt?: number
  /** Why a board left open closed: its time came, Close it now, or a new live session took the join link. */
  closedBy?: 'expired' | 'closed' | 'superseded'
  /** When End live happened (ms): cards accepted after it are late cards. */
  liveEndedAt?: number
  /** Left open for late cards: when the board closes by itself (ms). */
  openUntil?: number
  /** When the app learned the board left open had closed (Close it now, or by itself). */
  closedAt?: number
  /** The last pull from the board left open (ms). */
  refreshedAt?: number
}

const ID_CHARS = 200
const TEXT_CHARS = 2_000
const MAX_CARDS = 5_000

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= ID_CHARS
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normaliseCard(value: unknown, columns: Set<string>): RunBoardCard | null {
  if (!record(value) || !id(value.id) || !id(value.column) || !columns.has(value.column) || typeof value.text !== 'string'
    || !value.text.trim() || value.text.length > TEXT_CHARS || !time(value.acceptedAt)) return null
  if (value.group !== undefined && !positive(value.group)) return null
  if ((value.hidden !== undefined && value.hidden !== true) || (value.putBack !== undefined && value.putBack !== true)) return null
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 60)) return null
  return {
    id: value.id, column: value.column, text: value.text, acceptedAt: Math.round(value.acceptedAt),
    ...(value.group !== undefined ? { group: Number(value.group) } : {}),
    ...(value.hidden ? { hidden: true as const } : {}),
    ...(value.putBack ? { putBack: true as const } : {}),
    ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}),
  }
}

/** One board from a Run file (JSON anyone can edit): every field checked; null when it cannot be read. */
export function normaliseRunBoard(value: unknown): RunBoard | null {
  if (!record(value) || !id(value.id) || typeof value.question !== 'string' || value.question.length > TEXT_CHARS
    || !Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 10
    || !Array.isArray(value.cards) || value.cards.length > MAX_CARDS || !Array.isArray(value.groups)) return null
  const columns: RunBoard['columns'] = []
  for (const column of value.columns) {
    if (!record(column) || !id(column.id) || typeof column.label !== 'string' || !column.label.trim() || column.label.length > 300) return null
    if (columns.some((known) => known.id === column.id)) return null
    columns.push({ id: column.id, label: column.label })
  }
  const columnIds = new Set(columns.map((column) => column.id))
  const seen = new Set<string>()
  const cards: RunBoardCard[] = []
  for (const candidate of value.cards) {
    const card = normaliseCard(candidate, columnIds)
    // A card that cannot be read is dropped; the rest of the board is kept.
    if (!card || seen.has(card.id)) continue
    seen.add(card.id)
    cards.push(card)
  }
  const numbers = new Set<number>()
  const groups: RunBoardGroup[] = []
  for (const group of value.groups) {
    if (!record(group) || !positive(group.n) || numbers.has(Number(group.n)) || !id(group.column) || !columnIds.has(group.column)
      || !Array.isArray(group.cardIds)) continue
    const cardIds = group.cardIds.filter((cardId): cardId is string => typeof cardId === 'string' && seen.has(cardId))
    if (!cardIds.length) continue
    numbers.add(Number(group.n))
    // A wording that cannot be read is dropped (the group then shows its first card), never the group.
    const label = typeof group.label === 'string' && group.label.trim() && group.label.length <= TEXT_CHARS ? group.label.trim() : ''
    groups.push({ n: Number(group.n), column: group.column, cardIds, ...(label ? { label } : {}) })
  }
  // A card's group must be a group that lists it; otherwise it is a single.
  for (const card of cards) {
    if (card.group !== undefined && !groups.some((group) => group.n === card.group && group.cardIds.includes(card.id))) delete card.group
  }
  const board: RunBoard = { id: value.id, question: value.question, columns, cards: cards.sort((a, b) => a.acceptedAt - b.acceptedAt), groups }
  if (id(value.slideId)) board.slideId = value.slideId
  if (value.frozen === true) board.frozen = true
  if (id(value.sessionId)) board.sessionId = value.sessionId
  for (const key of TIME_KEYS) {
    if (time(value[key])) board[key] = Math.round(value[key] as number)
  }
  if (value.closedBy === 'expired' || value.closedBy === 'closed' || value.closedBy === 'superseded') board.closedBy = value.closedBy
  return board
}

const TIME_KEYS = ['liveStartedAt', 'liveEndedAt', 'openUntil', 'closedAt', 'refreshedAt'] as const

/** A board's identity on the Run: its poll and its live session (a Run from before sessions were named: the poll alone). */
export function runBoardKey(board: Pick<RunBoard, 'id' | 'sessionId'>): string {
  return `${board.id}\u0000${board.sessionId ?? ''}`
}

export function normaliseRunBoards(value: unknown): RunBoard[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((candidate) => {
    const board = normaliseRunBoard(candidate)
    if (!board || seen.has(runBoardKey(board))) return []
    seen.add(runBoardKey(board))
    return [board]
  })
}

/** Where the board stands after the talk, as History says it. */
export interface RunBoardTimes {
  sessionId?: string
  liveStartedAt?: number
  closedBy?: 'expired' | 'closed' | 'superseded'
  liveEndedAt?: number
  openUntil?: number
  closedAt?: number
  refreshedAt?: number
}

/**
 * The Run's copy of a board from the live session's presenter view of its poll: every card with its
 * hidden flag, the groups with their numbers. Null when the poll is not a board or carries no board.
 */
export function runBoardFromPollState(poll: PollStateMessage, times: RunBoardTimes = {}): RunBoard | null {
  if (poll.pollType !== 'board' || !poll.boardState) return null
  const state = poll.boardState
  const groups = state.groups.map((group) => ({ n: group.n, column: group.column, cardIds: [...group.cardIds], ...(group.label ? { label: group.label } : {}) }))
  return normaliseRunBoard({
    id: poll.pollId, ...(poll.slideId ? { slideId: poll.slideId } : {}), question: poll.question,
    columns: poll.options.map((option) => ({ id: option.optionId, label: option.label })),
    cards: state.cards.map((card) => ({ id: card.cardId, column: card.column, text: card.text, acceptedAt: card.acceptedAt,
      ...(card.group !== undefined ? { group: card.group } : {}), ...(card.hidden ? { hidden: true } : {}),
      ...(card.name ? { name: card.name } : {}) })),
    groups, ...(state.frozen ? { frozen: true } : {}), ...times,
  })
}

/**
 * Merge boards by identity: poll id AND live session (runBoardKey). A fresh copy of a board is the
 * whole board as that session's worker holds it now, so its cards and groups replace that session's
 * copy on the Run (a withdrawn card is gone, a merge or a hide lands) and never another session's
 * board of the same poll. What only History knows is kept: "Put back" on a card that is still there,
 * and the times and reasons the fresh copy does not name. A board with no sessionId keeps its own
 * key: a fresh copy of the same poll from a named session is appended beside it, never over it.
 * Boards the fresh list does not name are kept as they are.
 */
export function mergeRunBoards(existing: RunBoard[], incoming: RunBoard[]): RunBoard[] {
  const result = [...existing]
  for (const next of incoming) {
    const index = result.findIndex((board) => runBoardKey(board) === runBoardKey(next))
    if (index < 0) { result.push(next); continue }
    const board = result[index]
    const putBack = new Set(board.cards.filter((card) => card.putBack).map((card) => card.id))
    const merged: RunBoard = { ...next, cards: next.cards.map((card) => putBack.has(card.id) ? { ...card, putBack: true as const } : card) }
    for (const key of TIME_KEYS) {
      if (merged[key] === undefined && board[key] !== undefined) merged[key] = board[key]
    }
    if (merged.closedBy === undefined && board.closedBy !== undefined) merged.closedBy = board.closedBy
    result[index] = merged
  }
  return result
}

/** A card is off the Run card and the share link when the board hid it and History has not put it back. */
export function isHiddenCard(card: RunBoardCard): boolean {
  return card.hidden === true && card.putBack !== true
}

export function isLateCard(board: RunBoard, card: RunBoardCard): boolean {
  return board.liveEndedAt !== undefined && card.acceptedAt > board.liveEndedAt
}

/** `live`: the talk is on (or the Run has no end yet); `open`: left open and not closed yet; `closed`. */
export function runBoardState(board: RunBoard, now: number): 'live' | 'open' | 'closed' {
  if (board.openUntil !== undefined && board.closedAt === undefined && board.openUntil > now) return 'open'
  return board.liveEndedAt === undefined && board.openUntil === undefined && board.closedAt === undefined ? 'live' : 'closed'
}

/** A board left open whose closing the app has not recorded yet (it may have closed by itself since). */
export function runBoardAwaitsRefresh(board: RunBoard): boolean {
  return board.openUntil !== undefined && board.closedAt === undefined
}

export type RunBoardEntry =
  | { kind: 'group'; n: number; text: string; count: number; cardIds: string[]; late: boolean }
  | { kind: 'card'; id: string; text: string; late: boolean }

export interface RunBoardColumnView {
  id: string
  label: string
  /** Visible cards in the column, grouped or not. */
  count: number
  /** Groups largest first, then single cards newest first (as the big screen orders them). */
  entries: RunBoardEntry[]
}

export interface RunBoardView {
  columns: RunBoardColumnView[]
  /** Visible cards on the board. */
  cardCount: number
  /** Hidden cards, oldest first, with their column's label. */
  hidden: Array<RunBoardCard & { columnLabel: string }>
  lateCount: number
}

/** The board as the Run card and the share link show it: hidden cards left out and listed apart. */
export function runBoardView(board: RunBoard): RunBoardView {
  const visible = board.cards.filter((card) => !isHiddenCard(card))
  const visibleIds = new Set(visible.map((card) => card.id))
  const byId = new Map(board.cards.map((card) => [card.id, card]))
  const columns = board.columns.map((column) => {
    const groups = board.groups.filter((group) => group.column === column.id)
      .map((group) => ({ group, shown: group.cardIds.filter((cardId) => visibleIds.has(cardId)) }))
      .filter((entry) => entry.shown.length > 0)
      .sort((a, b) => b.shown.length - a.shown.length || a.group.n - b.group.n)
    const inGroups = new Set(groups.flatMap((entry) => entry.shown))
    const singles = visible.filter((card) => card.column === column.id && !inGroups.has(card.id)).reverse()
    const entries: RunBoardEntry[] = [
      ...groups.map(({ group, shown }) => ({ kind: 'group' as const, n: group.n, text: group.label || byId.get(shown[0])!.text, count: shown.length,
        cardIds: shown, late: shown.every((cardId) => isLateCard(board, byId.get(cardId)!)) })),
      ...singles.map((card) => ({ kind: 'card' as const, id: card.id, text: card.text, late: isLateCard(board, card) })),
    ]
    const count = groups.reduce((sum, entry) => sum + entry.shown.length, 0) + singles.length
    return { id: column.id, label: column.label, count, entries }
  })
  const labels = new Map(board.columns.map((column) => [column.id, column.label]))
  return {
    columns,
    cardCount: visible.length,
    hidden: board.cards.filter(isHiddenCard).map((card) => ({ ...card, columnLabel: labels.get(card.column) ?? card.column })),
    lateCount: visible.filter((card) => isLateCard(board, card)).length,
  }
}

/** Put a hidden card back (or hide it again) in the Run: History only; the live board is not changed. */
export function setRunBoardCardPutBack(board: RunBoard, cardId: string, putBack: boolean): RunBoard {
  if (!board.cards.some((card) => card.id === cardId && card.hidden)) throw new Error('card-not-hidden')
  return { ...board, cards: board.cards.map((card) => {
    if (card.id !== cardId) return card
    const { putBack: _was, ...rest } = card
    return putBack ? { ...rest, putBack: true as const } : rest
  }) }
}

// Markdown text is untrusted too: a card with a line break must stay one item, and markup in it
// must not become HTML wherever the copy is pasted. Every item follows its own marker ("- ", "1. ",
// "### "), so a card that starts like a heading or a list item stays inside its item.
function markdownText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * "Copy as Markdown" (R5): the question, one line of context, then each column with its count;
 * groups keep their numbers and counts, single cards are bullets; hidden cards and names are left out.
 */
export function runBoardMarkdown(board: RunBoard, context: { talkTitle: string; event?: string; date?: string }): string {
  const view = runBoardView(board)
  const lines = [`## ${markdownText(board.question || 'Board')}`,
    [context.talkTitle, context.event, context.date, `${view.cardCount} card${view.cardCount === 1 ? '' : 's'}`].filter(Boolean).map((part) => markdownText(String(part))).join(' · ')]
  for (const column of view.columns) {
    lines.push('', `### ${markdownText(column.label)} (${column.count})`)
    for (const entry of column.entries) {
      lines.push(entry.kind === 'group'
        ? `${entry.n}. ${markdownText(entry.text)}${entry.count > 1 ? ` (×${entry.count})` : ''}`
        : `- ${markdownText(entry.text)}`)
    }
  }
  return `${lines.join('\n')}\n`
}
