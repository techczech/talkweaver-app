// The board's pure seams on the published audience page (ADR-0032 and its 2026-09-30 amendment; ticket
// "People add cards from a phone or laptop, and can edit or withdraw their own"). Each function is one
// the page runtime embeds by `.toString()` (see audienceBoardModelSource), so each is self-contained:
// no module-level constants, no imports. Unit-tested in scripts/audience-board.test.mjs.
//
//  - normaliseBoardPoll(message)      a board's `poll.state` fields, or null; never shows a presenter-only field
//  - normaliseOwnBoards(snapshot)     the phone's own cards and allowances from its snapshot
//  - normaliseCardAck(message)        the sender's receipt for a card add, edit or withdrawal
//  - boardChars / boardClip           card length as people count it (an emoji is one)
//  - boardColumnTabs / boardColumnList  the tabs and the chosen column's entries: groups first, then newest
//  - boardCardsLeft / boardComposerState  what the box offers: open, closed, final, or at the cap
//  - boardRefusal(error, context)     the plain sentence for a refused card
//  - boardSentNote(...)               what the box says once a card, edit or withdrawal is confirmed
// Card text, hints, instructions and names are untrusted: the panel (audience-board.js) writes them
// with textContent only, never as HTML.

/** The icons the panel draws beyond the reaction bar's: lucide bodies, checked against
 *  compiler/assets/icons/lucide.json by scripts/audience-board.test.mjs. */
export function audienceBoardIcons() {
  return {
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    'trash-2': '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    snowflake: '<path d="m10 20-1.25-2.5L6 18"/><path d="M10 4 8.75 6.5 6 6"/><path d="m14 20 1.25-2.5L18 18"/><path d="m14 4 1.25 2.5L18 6"/><path d="m17 21-3-6h-4"/><path d="m17 3-3 6 1.5 3"/><path d="M2 12h6.5L10 9"/><path d="m20 10-1.5 2 1.5 2"/><path d="M22 12h-6.5L14 15"/><path d="m4 10 1.5 2L4 14"/><path d="m7 21 3-6-1.5-3"/><path d="m7 3 3 6h4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    'corner-down-left': '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
  }
}

/** Characters as people count them: one per code point, so an emoji is one (as the worker counts). */
export function boardChars(text) {
  return Array.from(String(text == null ? '' : text)).length
}

/** The text cut to at most `max` characters. */
export function boardClip(text, max) {
  const value = String(text == null ? '' : text)
  const chars = Array.from(value)
  return chars.length > max ? chars.slice(0, max).join('') : value
}

/**
 * A board's fields on a `poll.state` (`board` settings and, when the worker sent it, `boardState`), or
 * null when malformed. The audience gets the public board only: a hidden card, a name, or split
 * history in a card makes the whole board invalid, so a page never shows what the room must not see.
 * @param {any} message
 */
export function normaliseBoardPoll(message) {
  const whole = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high
  const board = message && message.board
  if (!board || typeof board !== 'object') return null
  if (!(board.limit === null || whole(board.limit, 1, 1000)) || !whole(board.cardChars, 1, 1000) || !whole(board.cardsPerPhone, 1, 100)
    || typeof board.names !== 'boolean' || !whole(board.closesAfterDays, 1, 365)) return null
  if (board.instructions !== undefined && typeof board.instructions !== 'string') return null
  if (board.example !== undefined && typeof board.example !== 'string') return null
  let hints
  if (board.hints !== undefined) {
    if (!board.hints || typeof board.hints !== 'object' || Array.isArray(board.hints)) return null
    hints = {}
    for (const [id, hint] of Object.entries(board.hints)) {
      if (typeof hint !== 'string') return null
      hints[id] = hint
    }
  }
  const settings = {
    limit: board.limit, cardChars: board.cardChars, cardsPerPhone: board.cardsPerPhone, names: board.names, closesAfterDays: board.closesAfterDays,
    ...(board.instructions ? { instructions: board.instructions } : {}),
    ...(board.example ? { example: board.example } : {}),
    ...(hints ? { hints } : {}),
  }
  if (message.boardState === undefined) return { board: settings }
  const state = message.boardState
  if (!state || typeof state.frozen !== 'boolean' || !Array.isArray(state.cards) || !Array.isArray(state.groups) || !Array.isArray(state.columns)) return null
  const cards = []
  for (const card of state.cards) {
    if (!card || typeof card.cardId !== 'string' || !card.cardId || typeof card.column !== 'string' || typeof card.text !== 'string'
      || !Number.isFinite(card.acceptedAt)) return null
    if (card.hidden !== undefined || card.name !== undefined || card.fromGroup !== undefined || card.touched !== undefined) return null
    if (card.group !== undefined && !whole(card.group, 1, Number.MAX_SAFE_INTEGER)) return null
    cards.push({ cardId: card.cardId, column: card.column, text: card.text, acceptedAt: Number(card.acceptedAt),
      ...(card.group !== undefined ? { group: Number(card.group) } : {}), ...(card.waiting === true ? { waiting: true } : {}) })
  }
  const groups = []
  for (const group of state.groups) {
    if (!group || !whole(group.n, 1, Number.MAX_SAFE_INTEGER) || typeof group.column !== 'string' || !whole(group.count, 0, Number.MAX_SAFE_INTEGER)
      || !Array.isArray(group.cardIds) || group.cardIds.some((id) => typeof id !== 'string')) return null
    if (group.label !== undefined && typeof group.label !== 'string') return null
    groups.push({ n: Number(group.n), column: group.column, cardIds: group.cardIds.slice(), count: Number(group.count),
      ...(typeof group.label === 'string' && group.label.trim() ? { label: group.label } : {}) })
  }
  const columns = []
  for (const column of state.columns) {
    if (!column || typeof column.columnId !== 'string' || !whole(column.cards, 0, Number.MAX_SAFE_INTEGER) || !whole(column.waiting, 0, Number.MAX_SAFE_INTEGER)) return null
    columns.push({ columnId: column.columnId, cards: Number(column.cards), waiting: Number(column.waiting) })
  }
  return { board: settings, boardState: { frozen: state.frozen, cards, groups, columns, limit: state.limit === null ? null : Number(state.limit), cardCount: Number(state.cardCount) || cards.length } }
}

/**
 * The phone's own cards and allowances from its `session.snapshot` (`myCards`, `myBoards`); entries
 * that are malformed are dropped. `myCards` never lists a hidden or withdrawn card; `myBoards`
 * counts hidden ones in `cardsUsed`.
 * @param {any} snapshot
 */
export function normaliseOwnBoards(snapshot) {
  const cards = []
  const boards = []
  if (snapshot && Array.isArray(snapshot.myCards)) {
    for (const card of snapshot.myCards) {
      if (card && typeof card.pollId === 'string' && typeof card.cardId === 'string' && typeof card.column === 'string' && typeof card.text === 'string') {
        cards.push({ pollId: card.pollId, cardId: card.cardId, column: card.column, text: card.text, sorted: card.sorted === true, waiting: card.waiting === true })
      }
    }
  }
  if (snapshot && Array.isArray(snapshot.myBoards)) {
    for (const board of snapshot.myBoards) {
      if (board && typeof board.pollId === 'string' && Number.isSafeInteger(board.cardsUsed) && board.cardsUsed >= 0
        && Number.isSafeInteger(board.cardsPerPhone) && board.cardsPerPhone >= 1) boards.push({ pollId: board.pollId, cardsUsed: board.cardsUsed, cardsPerPhone: board.cardsPerPhone })
    }
  }
  return { myCards: cards, myBoards: boards }
}

/**
 * The sender's receipt for a card add, edit or withdrawal (`card.ack`), or null when malformed.
 * @param {any} message
 */
export function normaliseCardAck(message) {
  if (!message || message.type !== 'card.ack' || typeof message.submissionId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(message.submissionId) || typeof message.pollId !== 'string'
    || (message.status !== 'confirmed' && message.status !== 'rejected')) return null
  return {
    submissionId: message.submissionId, pollId: message.pollId, status: message.status,
    ...(typeof message.error === 'string' ? { error: message.error } : {}),
    ...(typeof message.cardId === 'string' && message.cardId ? { cardId: message.cardId } : {}),
    ...(Number.isSafeInteger(message.cardsUsed) && message.cardsUsed >= 0 ? { cardsUsed: message.cardsUsed } : {}),
  }
}

/**
 * The tabs: one per column, in slide order, with the column's hint (the box's placeholder) and how many
 * cards it holds. Counts come from the board's own column view; a board with no state yet counts none.
 * @param {any} poll a normalised board poll.state
 */
export function boardColumnTabs(poll) {
  const state = poll && poll.boardState
  const hints = (poll && poll.board && poll.board.hints) || {}
  return (poll && Array.isArray(poll.options) ? poll.options : []).map((option) => {
    const view = state ? state.columns.find((column) => column.columnId === option.optionId) : null
    const counted = state ? state.cards.filter((card) => card.column === option.optionId).length : 0
    return { id: option.optionId, label: option.label, hint: typeof hints[option.optionId] === 'string' ? hints[option.optionId] : '', count: view ? view.cards : counted }
  })
}

/**
 * The chosen column's entries as the phone and laptop list them: every visible card, waiting ones too
 * (the room's screen may hold some back; a phone never does). Groups come first (the largest first),
 * then single cards, newest first. A group shows its number, its count and the card the others were
 * merged onto. `ownIds` is the set of card ids this device sent; `mine` marks them, and a group that
 * holds one is `mine` but never editable (a card in a group is sorted).
 * @param {any} poll @param {string} columnId @param {Set<string>|string[]} ownIds
 */
export function boardColumnList(poll, columnId, ownIds) {
  const own = ownIds instanceof Set ? ownIds : new Set(ownIds || [])
  const state = poll && poll.boardState
  if (!state) return { total: 0, entries: [] }
  const cards = state.cards.filter((card) => card.column === columnId)
  const byId = new Map(state.cards.map((card) => [card.cardId, card]))
  const numeric = (id) => Number(String(id).replace(/\D+/g, '')) || 0
  const groups = state.groups.filter((group) => group.column === columnId && group.cardIds.length)
    .map((group) => {
      const lead = byId.get(group.cardIds[0])
      return { key: 'group-' + group.n, group: group.n, count: group.count, text: group.label || (lead ? lead.text : ''), cardId: null, mine: group.cardIds.some((id) => own.has(id)), sorted: true, waiting: false }
    })
    .sort((a, b) => b.count - a.count || a.group - b.group)
  const singles = cards.filter((card) => card.group === undefined)
    .sort((a, b) => b.acceptedAt - a.acceptedAt || numeric(b.cardId) - numeric(a.cardId))
    .map((card) => ({ key: card.cardId, group: null, count: 1, text: card.text, cardId: card.cardId, mine: own.has(card.cardId), sorted: false, waiting: card.waiting === true }))
  return { total: cards.length, entries: groups.concat(singles) }
}

/** How many more cards this phone may add: the board's allowance, less what it has used (hidden cards
 *  count) and what waits in its queue. */
export function boardCardsLeft(settings, cardsUsed, queued) {
  const allowance = settings && Number.isSafeInteger(settings.cardsPerPhone) ? settings.cardsPerPhone : 0
  return Math.max(0, allowance - (Number(cardsUsed) || 0) - (Number(queued) || 0))
}

/**
 * What the box offers: 'frozen' (the final board), 'closed' (the speaker closed it to new cards),
 * 'maxcards' (this phone is at its allowance, and says nothing about why) or 'open'. Changing a card
 * you are already editing is always 'open' unless the board is closed or final.
 * @param {any} poll @param {{ cardsUsed?: number, queued?: number, editing?: boolean }} own
 */
export function boardComposerState(poll, own) {
  if (poll && poll.boardState && poll.boardState.frozen) return 'frozen'
  if (poll && poll.open === false) return 'closed'
  if (own && own.editing) return 'open'
  return boardCardsLeft(poll && poll.board, own && own.cardsUsed, own && own.queued) <= 0 ? 'maxcards' : 'open'
}

/**
 * The sentence shown for a refused card, and whether the person's text is worth keeping to try again.
 * A refusal stored nothing (worker/README.md § boards), so a retry is a deliberate new send. Nothing
 * here says a card was hidden: a card that is gone is only ever "no longer on the board".
 * @param {string | undefined} error
 * @param {{ max?: number, phone?: boolean }} [context]
 * @returns {{ text: string, retry: boolean }}
 */
export function boardRefusal(error, context) {
  const max = context && context.max ? context.max : 140
  if (error === 'board_closed') return { text: 'This board is closed to new cards. You can still read it.', retry: false }
  if (error === 'board_frozen') return { text: 'This board is final. Nothing more can be added or changed.', retry: false }
  if (error === 'card_limit_reached') return { text: 'You have added the most cards one phone can add to this board.', retry: false }
  if (error === 'participant_limit_reached') return { text: 'You have made the most card changes this board allows.', retry: false }
  if (error === 'card_too_long') return { text: 'That card is too long. Shorten it to ' + max + ' characters or fewer.', retry: false }
  if (error === 'empty_card') return { text: 'Type a card first.', retry: false }
  if (error === 'card_sorted') return { text: 'The speaker has already sorted this card into a group, so it can no longer be changed.', retry: false }
  if (error === 'card_not_found') return { text: 'That card is no longer on the board.', retry: false }
  if (error === 'board_full') return { text: 'This board has reached the most cards it can take.', retry: false }
  if (error === 'unknown_column') return { text: 'That column is no longer on this board.', retry: false }
  if (error === 'board_not_found' || error === 'not_a_board') return { text: 'The speaker has not opened this board. Try again in a moment.', retry: true }
  if (error === 'not_kept') return { text: 'Could not keep your card on this ' + (context && context.phone ? 'phone' : 'device') + '. Copy it, then try again.', retry: true }
  if (error === 'ended') return { text: 'The live session has ended, so the speaker can no longer receive cards.', retry: false }
  return { text: 'The card could not be sent. Your text is kept; try again.', retry: true }
}

/**
 * What the box says once a change is confirmed. A card the speaker has not released yet is "on the
 * board soon"; an edit and a withdrawal say what the room sees.
 * @param {'add'|'edit'|'withdraw'} op @param {string} column @param {boolean} waiting
 */
export function boardSentNote(op, column, waiting) {
  if (op === 'edit') return 'Saved. Your card is changed on every screen.'
  if (op === 'withdraw') return 'Withdrawn. It has gone from every screen.'
  return 'Sent to ' + column + '. ' + (waiting ? 'It is on the board soon.' : 'It is on the screen now.')
}

export function audienceBoardModelSource() {
  return [audienceBoardIcons, boardChars, boardClip, normaliseBoardPoll, normaliseOwnBoards, normaliseCardAck, boardColumnTabs, boardColumnList, boardCardsLeft, boardComposerState, boardRefusal, boardSentNote]
    .map((fn) => fn.toString()).join('\n')
}
