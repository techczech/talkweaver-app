import {
  BOARD_DEFAULTS, BOARD_LIMITS, BOARD_SEED_MAX, cardLength,
  type BoardCardView, type BoardColumnView, type BoardGroupView, type BoardRelease, type BoardScreenEntry, type BoardSettings,
  type BoardSeedCard, type BoardStateView, type CardAck, type CardAddInput, type CardEditInput, type CardTarget, type CardWithdrawInput,
  type OwnBoardAllowance, type OwnBoardCard, type PresenterBoardMessage,
} from './board-protocol.ts'
import { compactHash, utf8Length } from './audience-feedback.ts'
import type { PollDefinition } from './protocol'
import type { StoredLiveSession } from './session-state'

// The board store of one live session (ADR-0032 amendment point 1).
//
// Each board poll keeps its cards, numbered groups, the frozen flag and what the presenter released
// past the big-screen limit. The big-screen view is derived here, so the big screen, the venue
// screens, the phones and the presenter all see the same cards on the screen and waiting. The
// participant is kept only as a hash and never leaves this module. Refusals store nothing, so a
// queued card refused while the board is closed can land when it is resent after a reopen.

interface StoredCard {
  cardId: string
  column: string
  text: string
  acceptedAt: number
  /** Arrival order; the oldest waiting card is the lowest. */
  seq: number
  /** Hash of the participant id. */
  participant: string
  name?: string
  group?: number
  /** Hidden on its own (card menu). */
  hidden: boolean
  /** Hidden with its whole group (group menu); putting the group back clears only this. */
  groupHidden?: true
  fromGroup?: number
  touched?: true
}

interface StoredGroup {
  n: number
  column: string
  cardIds: string[]
  /** The presenter's wording for the group (board.relabel); the cards keep their own text. */
  label?: string
}

interface StoredCardReceipt {
  fingerprint: string
  status: 'confirmed' | 'rejected'
  error?: string
  cardId?: string
  /** The sender's cards on this board once the submission was applied. */
  cardsUsed?: number
}

export interface StoredBoard {
  cards: StoredCard[]
  groups: StoredGroup[]
  /** The next card's number; cards are `card-<n>`. */
  nextCard: number
  /** The next group's number. Numbers only go up: a split or emptied group's number is retired. */
  nextGroup: number
  frozen: boolean
  limit: number | null
  release: BoardRelease
  receipts: Record<string, StoredCardReceipt>
  /** Stored submissions per participant hash. */
  submissions: Record<string, number>
}

type BoardPoll = Pick<PollDefinition, 'pollId' | 'options' | 'board'> & { open?: boolean }

function emptyRelease(): BoardRelease {
  return { extra: 0, all: false, groupsOnly: false, columns: {} }
}

export function emptyBoard(settings: BoardSettings | undefined): StoredBoard {
  return { cards: [], groups: [], nextCard: 1, nextGroup: 1, frozen: false, limit: settings ? settings.limit : BOARD_DEFAULTS.limit,
    release: emptyRelease(), receipts: {}, submissions: {} }
}

/** A card is off every public view when it was hidden on its own or with its group. */
function isHidden(card: StoredCard): boolean {
  return card.hidden || card.groupHidden === true
}

/**
 * Read back a stored board row; anything missing or malformed takes its default, and the limit's
 * default is the board definition's own (12, 24, 36 or All), not a fixed number.
 */
export function normaliseBoard(value: unknown, settings: BoardSettings | undefined): StoredBoard {
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<StoredBoard> : {}
  const release = stored.release && typeof stored.release === 'object' ? stored.release : emptyRelease()
  const object = <T>(candidate: unknown): Record<string, T> => candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, T> : {}
  const cards = Array.isArray(stored.cards) ? stored.cards : []
  const groups = Array.isArray(stored.groups) ? stored.groups : []
  const highestGroup = Math.max(0, ...groups.map((group) => Number(group.n) || 0), ...cards.map((card) => Number(card.fromGroup) || 0))
  return {
    cards, groups,
    nextCard: Number.isSafeInteger(stored.nextCard) ? Number(stored.nextCard) : cards.length + 1,
    nextGroup: Math.max(Number.isSafeInteger(stored.nextGroup) ? Number(stored.nextGroup) : 1, highestGroup + 1),
    frozen: stored.frozen === true,
    limit: stored.limit === null || Number.isSafeInteger(stored.limit) ? stored.limit ?? null : emptyBoard(settings).limit,
    release: { extra: Number.isSafeInteger(release.extra) ? Number(release.extra) : 0, all: release.all === true,
      groupsOnly: release.groupsOnly === true, columns: object<'all' | 'groupsOnly'>(release.columns) },
    receipts: object<StoredCardReceipt>(stored.receipts),
    submissions: object<number>(stored.submissions),
  }
}

export function sessionBoards(session: StoredLiveSession): Record<string, StoredBoard> {
  return session.boards ??= {}
}

/** The board of an open or reopened board poll; a reopened board keeps its cards, groups and numbers. */
export function ensureBoard(session: StoredLiveSession, poll: BoardPoll): StoredBoard {
  return sessionBoards(session)[poll.pollId] ??= emptyBoard(poll.board)
}

/** The participant hash that seeded cards carry: no participant's own, so nobody can edit or withdraw one. */
export const SEED_PARTICIPANT = 'seed:prework'

function seedCard(board: StoredBoard, card: BoardSeedCard, now: number): StoredCard {
  return { cardId: `card-${board.nextCard}`, column: card.column, text: card.text, acceptedAt: now, seq: board.nextCard, participant: SEED_PARTICIPANT, hidden: false }
}

/**
 * How many of these seed cards a fresh board can hold: the seed cap and the row's byte cap, the same
 * rule `seedBoard` applies. The Run page says so when a step has more answers than this.
 */
export function seedCapacity(seed: BoardSeedCard[]): number {
  const board = emptyBoard(undefined)
  let taken = 0
  for (const card of seed.slice(0, BOARD_SEED_MAX)) {
    if (!fitsBoardRow(board, [card.text])) break
    board.cards.push(seedCard(board, card, 0))
    board.nextCard += 1
    taken += 1
  }
  return taken
}

/**
 * Put a board's opening cards on it (pre-work answers). Only a board that has never held a card
 * takes them (`nextCard` is 1), so a reopened or replayed board never doubles, and a first open whose
 * save failed can be seeded again while the board is still empty. Each card is like an accepted one,
 * owned by no one.
 */
export function seedBoard(board: StoredBoard, seed: BoardSeedCard[] | undefined, now: number): void {
  if (!seed?.length || board.cards.length || board.nextCard !== 1) return
  for (const card of seed.slice(0, BOARD_SEED_MAX)) {
    if (!fitsBoardRow(board, [card.text])) break
    board.cards.push(seedCard(board, card, now))
    board.nextCard += 1
  }
}

// ── The big-screen view ────────────────────────────────────────────────────────────────────────

interface Derived {
  visible: StoredCard[]
  groups: Array<StoredGroup & { visibleIds: string[] }>
  /** Singles on the big screen. */
  shown: Set<string>
  /** Singles past the allowance (not masked by "groups only"): what "Show next" can release. */
  overflow: number
}

function columnMode(board: StoredBoard, column: string): 'all' | 'groupsOnly' | 'limit' {
  const own = board.release.columns[column]
  if (own) return own
  if (board.release.all || board.limit === null) return 'all'
  return board.release.groupsOnly ? 'groupsOnly' : 'limit'
}

function derive(board: StoredBoard): Derived {
  const visible = board.cards.filter((card) => !isHidden(card)).sort((a, b) => a.seq - b.seq)
  const visibleIds = new Set(visible.map((card) => card.cardId))
  const groups = board.groups.map((group) => ({ ...group, visibleIds: group.cardIds.filter((id) => visibleIds.has(id)) }))
  const liveGroups = groups.filter((group) => group.visibleIds.length > 0)
  // The limit counts entries: a group once. Groups are always on the big screen; singles fill the
  // rest, oldest first, and the presenter's "Show next" adds to that allowance.
  let allowance = board.limit === null ? Infinity : Math.max(0, board.limit - liveGroups.length) + board.release.extra
  const shown = new Set<string>()
  let overflow = 0
  for (const card of visible) {
    if (card.group !== undefined) continue
    const mode = columnMode(board, card.column)
    if (mode === 'all') { shown.add(card.cardId); continue }
    // "Groups only" masks a column after the allowance is taken, as drawn: its oldest singles still
    // take their places, so hiding one column's overflow never promotes another column's newest cards.
    if (allowance > 0) {
      allowance--
      if (mode === 'limit') shown.add(card.cardId)
    } else overflow++
  }
  return { visible, groups, shown, overflow }
}

function groupOrder(a: { n: number; visibleIds: string[] }, b: { n: number; visibleIds: string[] }): number {
  return b.visibleIds.length - a.visibleIds.length || a.n - b.n
}

/**
 * The board as one role sees it. The presenter gets every card (hidden ones marked), names, split
 * history and every group; the audience gets visible cards and groups only, with nothing that
 * identifies or marks a participant.
 */
export function boardView(board: StoredBoard, columnIds: string[], role: 'presenter' | 'audience'): BoardStateView {
  const { visible, groups, shown } = derive(board)
  const presenter = role === 'presenter'
  const ordered = presenter ? [...board.cards].sort((a, b) => a.seq - b.seq) : visible
  const cards: BoardCardView[] = ordered.map((card) => ({
    cardId: card.cardId, column: card.column, text: card.text, acceptedAt: card.acceptedAt,
    ...(card.group !== undefined ? { group: card.group } : {}),
    ...(!isHidden(card) && card.group === undefined && !shown.has(card.cardId) ? { waiting: true as const } : {}),
    ...(presenter && isHidden(card) ? { hidden: true as const } : {}),
    ...(presenter && card.name ? { name: card.name } : {}),
    ...(presenter && card.fromGroup !== undefined ? { fromGroup: card.fromGroup } : {}),
    ...(presenter && card.touched ? { touched: true as const } : {}),
  }))
  const liveGroups = groups.filter((group) => group.visibleIds.length > 0).sort(groupOrder)
  const listedGroups = (presenter ? [...groups].sort(groupOrder) : liveGroups)
  const groupViews: BoardGroupView[] = listedGroups.map((group) => ({ n: group.n, column: group.column,
    cardIds: presenter ? [...group.cardIds] : [...group.visibleIds], count: group.visibleIds.length,
    ...(typeof group.label === 'string' && group.label ? { label: group.label } : {}) }))
  const known = new Set(columnIds)
  const columnOrder = [...columnIds, ...[...new Set(visible.map((card) => card.column))].filter((id) => !known.has(id))]
  const columns: BoardColumnView[] = columnOrder.map((columnId) => {
    const singles = visible.filter((card) => card.column === columnId && card.group === undefined)
    const onScreen: BoardScreenEntry[] = [
      ...liveGroups.filter((group) => group.column === columnId).map((group) => ({ group: group.n })),
      ...singles.filter((card) => shown.has(card.cardId)).reverse().map((card) => ({ cardId: card.cardId })),
    ]
    return { columnId, onScreen, waiting: singles.filter((card) => !shown.has(card.cardId)).length,
      cards: visible.filter((card) => card.column === columnId).length }
  })
  const singles = visible.filter((card) => card.group === undefined).length
  return {
    frozen: board.frozen, limit: board.limit,
    release: { ...board.release, columns: { ...board.release.columns } },
    cards, groups: groupViews, columns,
    entries: liveGroups.length + singles, shown: liveGroups.length + shown.size,
    waiting: singles - shown.size, cardCount: visible.length,
  }
}

/** A participant's own cards on every board, for their snapshot. Hidden and withdrawn cards are left out. */
export function ownBoardCards(session: StoredLiveSession, participantId: string): OwnBoardCard[] {
  const participant = participantHash(participantId)
  const own: OwnBoardCard[] = []
  for (const [pollId, board] of Object.entries(session.boards ?? {})) {
    const { shown } = derive(board)
    for (const card of board.cards) {
      if (card.participant !== participant || isHidden(card)) continue
      own.push({ pollId, cardId: card.cardId, column: card.column, text: card.text, sorted: card.group !== undefined,
        waiting: card.group === undefined && !shown.has(card.cardId) })
    }
  }
  return own
}

/** Cards that count towards a participant's allowance on one board: hidden ones included, withdrawn ones not. */
function cardsUsed(board: StoredBoard, participant: string): number {
  return board.cards.filter((card) => card.participant === participant).length
}

/**
 * A participant's allowance on every board, for their snapshot. `cardsUsed` counts hidden cards too
 * (hiding a card never grants another), so the phone can close its box at the cap without being told
 * that any card was hidden.
 */
export function ownBoardAllowances(session: StoredLiveSession, participantId: string): OwnBoardAllowance[] {
  const participant = participantHash(participantId)
  return Object.entries(session.boards ?? {}).flatMap(([pollId, board]) => {
    const settings = session.polls[pollId]?.board
    return settings ? [{ pollId, cardsUsed: cardsUsed(board, participant), cardsPerPhone: settings.cardsPerPhone }] : []
  })
}

// ── Audience: add, edit, withdraw own cards ────────────────────────────────────────────────────

export type CardSubmission =
  | { kind: 'card.add'; submissionId: string; input: CardAddInput }
  | { kind: 'card.edit'; submissionId: string; input: CardEditInput }
  | { kind: 'card.withdraw'; submissionId: string; input: CardWithdrawInput }

export interface CardOutcome {
  ack: CardAck
  /** False when the submissionId was seen before; the ack is the original receipt. */
  fresh: boolean
  /** True when the board changed and must be stored and sent out. */
  stored: boolean
}

function participantHash(participantId: string): string {
  return compactHash('participant\u0000' + participantId)
}

/**
 * One card submission from one participant. `poll` is the board's definition and open state; the
 * caller checks the session is live. Idempotent by participant and submissionId.
 */
export function acceptCard(board: StoredBoard, poll: BoardPoll, participantId: string, submission: CardSubmission, now: number): CardOutcome {
  const { submissionId, input } = submission
  const reply = (status: 'confirmed' | 'rejected', error?: string, cardId?: string, used?: number): CardAck => ({ type: 'card.ack', submissionId,
    pollId: input.pollId, status, ...(error ? { error } : {}), ...(cardId ? { cardId } : {}), ...(used !== undefined ? { cardsUsed: used } : {}) })
  const receiptKey = compactHash('card\u0000' + participantId + '\u0000' + submissionId)
  const fingerprint = compactHash(JSON.stringify([submission.kind, input]))
  const prior = board.receipts[receiptKey]
  if (prior) return { fresh: false, stored: false,
    ack: prior.fingerprint === fingerprint ? reply(prior.status, prior.error, prior.cardId, prior.cardsUsed) : reply('rejected', 'submission_id_conflict') }
  const refuse = (error: string): CardOutcome => ({ fresh: true, stored: false, ack: reply('rejected', error) })
  const settings = poll.board
  if (!settings) return refuse('not_a_board')
  if (poll.open === false) return refuse('board_closed')
  if (board.frozen) return refuse('board_frozen')
  const participant = participantHash(participantId)
  if ((board.submissions[participant] ?? 0) >= BOARD_LIMITS.participantSubmissions) return refuse('participant_limit_reached')

  let card: StoredCard | undefined
  let remove = false
  // Card text is untrusted: trimmed, kept as text, never HTML.
  let text = 'text' in submission.input ? submission.input.text.trim() : ''
  if (submission.kind !== 'card.withdraw' && !text) return refuse('empty_card')
  if (submission.kind === 'card.add') {
    const add = submission.input
    if (!poll.options.some((option) => option.optionId === add.column)) return refuse('unknown_column')
    if (cardLength(text) > settings.cardChars) return refuse('card_too_long')
    // Hidden cards still count: hiding a card never gives its sender another one.
    if (cardsUsed(board, participant) >= settings.cardsPerPhone) return refuse('card_limit_reached')
    if (board.cards.length >= BOARD_LIMITS.cardsPerBoard) return refuse('board_full')
    const name = settings.names ? add.name?.trim().slice(0, BOARD_LIMITS.nameChars) : undefined
    card = { cardId: `card-${board.nextCard}`, column: add.column, text, acceptedAt: now, seq: board.nextCard,
      participant, ...(name ? { name } : {}), hidden: false }
  } else {
    // Another participant's card, a hidden card and a withdrawn one all answer the same: it has gone.
    card = board.cards.find((candidate) => candidate.cardId === submission.input.cardId && candidate.participant === participant && !isHidden(candidate))
    if (!card) return refuse('card_not_found')
    if (card.group !== undefined) return refuse('card_sorted')
    if (submission.kind === 'card.edit') {
      if (cardLength(text) > settings.cardChars) return refuse('card_too_long')
    } else remove = true
  }
  const receipt: StoredCardReceipt = { fingerprint, status: 'confirmed', cardId: card.cardId }
  const grows = submission.kind === 'card.add' ? card : submission.kind === 'card.edit' ? text : null
  if (!fitsBoardRow(board, [grows, receiptKey, receipt, participant])) return refuse('board_full')

  if (submission.kind === 'card.add') {
    board.cards.push(card)
    board.nextCard += 1
  } else if (remove) board.cards = board.cards.filter((candidate) => candidate !== card)
  else card.text = text
  board.submissions[participant] = (board.submissions[participant] ?? 0) + 1
  receipt.cardsUsed = cardsUsed(board, participant)
  board.receipts[receiptKey] = receipt
  return { fresh: true, stored: true, ack: reply('confirmed', undefined, card.cardId, receipt.cardsUsed) }
}

// ── Presenter: move, merge, split, hide, freeze, release, limit ───────────────────────────────

function findCard(board: StoredBoard, cardId: string): StoredCard {
  const card = board.cards.find((candidate) => candidate.cardId === cardId)
  if (!card) throw new Error('card_not_found')
  return card
}

function findGroup(board: StoredBoard, n: number): StoredGroup {
  const group = board.groups.find((candidate) => candidate.n === n)
  if (!group) throw new Error('group_not_found')
  return group
}

function targetCards(board: StoredBoard, target: CardTarget): StoredCard[] {
  if ('cardId' in target) return [findCard(board, target.cardId)]
  return findGroup(board, target.group).cardIds.map((id) => findCard(board, id))
}

/** Take a card out of its group; an emptied group is deleted and its number retired. */
function leaveGroup(board: StoredBoard, card: StoredCard): void {
  if (card.group === undefined) return
  const group = board.groups.find((candidate) => candidate.n === card.group)
  delete card.group
  if (!group) return
  group.cardIds = group.cardIds.filter((id) => id !== card.cardId)
  if (!group.cardIds.length) board.groups = board.groups.filter((candidate) => candidate !== group)
}

function touch(cards: StoredCard[]): void {
  for (const card of cards) card.touched = true
}

/**
 * Apply one presenter operation. Throws an Error whose message is the refusal code; nothing changes
 * on a refusal. A frozen board refuses moving, merging, splitting cards and rewording a group; hide and put back
 * (moderation), release and limit still work.
 */
export function applyBoardOperation(board: StoredBoard, poll: BoardPoll, action: PresenterBoardMessage): void {
  const columns = new Set(poll.options.map((option) => option.optionId))
  const cardChange = action.type === 'board.move' || action.type === 'board.merge' || action.type === 'board.split' || action.type === 'board.relabel'
  if (cardChange && board.frozen) throw new Error('board_frozen')
  switch (action.type) {
    case 'board.move': {
      if (!columns.has(action.column)) throw new Error('unknown_column')
      if ('group' in action.target) {
        const group = findGroup(board, action.target.group)
        const cards = targetCards(board, action.target)
        group.column = action.column
        for (const card of cards) card.column = action.column
        touch(cards)
        return
      }
      const card = findCard(board, action.target.cardId)
      leaveGroup(board, card)
      card.column = action.column
      touch([card])
      return
    }
    case 'board.merge': {
      const sources = targetCards(board, action.source)
      const targets = targetCards(board, action.target)
      const lead = targets[0]
      if (!lead) throw new Error('card_not_found')
      // Dropping onto a card that is in a group merges into that group.
      let group = lead.group !== undefined ? board.groups.find((candidate) => candidate.n === lead.group) : undefined
      if (sources.some((card) => card === lead || (group && card.group === group.n))) throw new Error('already_merged')
      if (!group) {
        group = { n: board.nextGroup, column: lead.column, cardIds: [lead.cardId] }
        board.nextGroup += 1
        board.groups.push(group)
        lead.group = group.n
      }
      // Incoming cards take the target group's group-level hide: into a hidden group they are hidden
      // with it, into a shown group they are shown with it. Their own card-menu hide is untouched.
      const members = group.cardIds.map((id) => findCard(board, id))
      const groupHidden = members.every((card) => card.groupHidden === true)
      for (const card of sources) {
        leaveGroup(board, card)
        card.group = group.n
        card.column = group.column
        delete card.fromGroup
        if (groupHidden) card.groupHidden = true
        else delete card.groupHidden
        group.cardIds.push(card.cardId)
      }
      touch([...sources, ...targets])
      return
    }
    case 'board.split': {
      const group = findGroup(board, action.group)
      const cards = targetCards(board, { group: group.n })
      for (const card of cards) {
        delete card.group
        card.column = group.column
        card.fromGroup = group.n
      }
      board.groups = board.groups.filter((candidate) => candidate !== group)
      touch(cards)
      return
    }
    case 'board.hide': {
      const cards = targetCards(board, action.target)
      if ('group' in action.target) {
        // The group menu hides or puts back the group; a card hidden on its own stays hidden.
        for (const card of cards) {
          if (action.hidden) card.groupHidden = true
          else delete card.groupHidden
        }
      } else {
        // The card menu: putting a card back shows it, whether it was hidden alone or with its group.
        cards[0].hidden = action.hidden
        if (!action.hidden) delete cards[0].groupHidden
      }
      touch(cards)
      return
    }
    case 'board.relabel': {
      // The group's wording (D13): text only, no longer than a card on this board; empty clears it.
      const group = findGroup(board, action.group)
      const text = action.text.trim()
      const max = poll.board?.cardChars ?? BOARD_DEFAULTS.cardChars
      if (text && cardLength(text) > max) throw new Error('card_too_long')
      if (text) group.label = text
      else delete group.label
      return
    }
    case 'board.freeze':
      board.frozen = action.frozen
      return
    case 'board.limit':
      board.limit = action.limit
      board.release = emptyRelease()
      return
    case 'board.release': {
      if ('column' in action) {
        if (!columns.has(action.column)) throw new Error('unknown_column')
        if (action.mode === 'limit') delete board.release.columns[action.column]
        else board.release.columns[action.column] = action.mode
        return
      }
      if (action.mode === 'next') {
        // Release only cards that are waiting now: "Show next 12" never pre-releases cards still to come.
        board.release.extra += Math.min(action.count, derive(board).overflow)
        return
      }
      if (action.mode === 'limit') board.release = emptyRelease()
      else board.release = { ...board.release, all: action.mode === 'all', groupsOnly: action.mode === 'groupsOnly' }
      return
    }
  }
}

// ── Row size ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whether an audience submission still fits the board's row, leaving the presenter's reserve free.
 * Measured exactly before any change, every time (one serialisation of at most 1 MB); the
 * additions' JSON over-counts their share of the row.
 */
function fitsBoardRow(board: StoredBoard, additions: unknown): boolean {
  const cap = BOARD_LIMITS.boardRowBytes - BOARD_LIMITS.presenterReserveBytes
  return boardRowSize(board) + utf8Length(JSON.stringify(additions)) + 256 <= cap
}

export function boardRowSize(board: StoredBoard): number {
  return utf8Length(JSON.stringify(board))
}
