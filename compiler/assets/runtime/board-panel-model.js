// The presenter's board panel, its pure seams (ADR-0032 and its 2026-09-30 amendment; feedback-boards
// ticket 05, drawn in docs/design/2026-09-28-feedback-boards/round-2/shots D1–D24). Each function is
// one the presenter template embeds by `.toString()` (see boardPanelModelSource), so each is
// self-contained: no module-level constants, no imports. Unit-tested in scripts/board-panel-model.test.ts.
//
// The panel never recomputes the board: what is on the big screen, what waits, the groups and their
// counts are the worker's (`poll.state` → `boardState`). The model only arranges that view for the
// panel and turns each of the presenter's gestures into exactly one worker operation.
//
//  - bpView(poll, state, sorted)      the panel's view: header, big-screen strip, inbox, columns
//  - bpDrop(source, target)           what a drop does: merge onto a card or group, move onto a column
//  - bpMessage(pollId, intent)        the ONE worker operation an intent sends (board.*), or null
//  - bpUndo(intent, view)             the one intent that undoes it, or null where none can
//  - bpResolve(intent, view)          an undo intent made concrete against the board as it is now
//  - bpToast(intent, view)            what the toast says once a change is sent
//    (intents: move, merge, split, hide, freeze, release, limit, relabel — the group's own wording)
//  - bpRefusal(error)                 the plain sentence for a refused operation
// Card text, names and column labels are untrusted: the panel writes them with textContent only.

/**
 * The panel's view of one board. `poll` is the definition (pollId, question, options, board);
 * `state` the worker's latest presenter `poll.state` for it, or null before it opens; `sorted` the
 * cards the presenter marked sorted here ("Mark all sorted"), a Set of cardIds.
 */
export function bpView(poll, state, sorted) {
  const marked = sorted instanceof Set ? sorted : new Set()
  const board = state && state.boardState && typeof state.boardState === 'object' ? state.boardState : null
  const settings = (state && state.board) || (poll && poll.board) || {}
  const options = Array.isArray(state && state.options) && state.options.length ? state.options : (Array.isArray(poll && poll.options) ? poll.options : [])
  const cards = board && Array.isArray(board.cards) ? board.cards : []
  const groups = board && Array.isArray(board.groups) ? board.groups : []
  const release = board && board.release ? board.release : { extra: 0, all: false, groupsOnly: false, columns: {} }
  const limit = board ? board.limit : (settings.limit === undefined ? 24 : settings.limit)
  const byId = new Map(cards.map((card) => [card.cardId, card]))
  const phase = !state ? 'ready' : board && board.frozen ? 'frozen' : state.open ? 'open' : 'closed'
  // New: visible single cards the presenter has not moved, merged, split or hidden, and not marked
  // sorted here. Newest first.
  const isNew = (card) => !card.hidden && card.group === undefined && !card.touched && !marked.has(card.cardId)
  const inbox = cards.filter(isNew).sort((a, b) => b.acceptedAt - a.acceptedAt || (a.cardId < b.cardId ? 1 : -1))
    .map((card) => ({ kind: 'card', cardId: card.cardId, text: card.text, column: card.column, acceptedAt: card.acceptedAt,
      ...(card.name ? { name: card.name } : {}), ...(card.waiting ? { waiting: true } : {}) }))
  const inboxIds = new Set(inbox.map((entry) => entry.cardId))
  const labelOf = (columnId) => (options.find((option) => option.optionId === columnId) || {}).label || columnId
  const screenColumns = new Map((board && Array.isArray(board.columns) ? board.columns : []).map((column) => [column.columnId, column]))
  const columns = options.map((option) => {
    const id = option.optionId
    const screen = screenColumns.get(id) || { onScreen: [], waiting: 0 }
    const groupEntries = groups.filter((group) => group.column === id).map((group) => {
      const members = group.cardIds.map((cardId) => byId.get(cardId)).filter(Boolean)
      const lead = members.find((card) => !card.hidden) || members[0] || { text: '' }
      // The presenter's wording (board.relabel) in place of the first card's text, as every screen shows it.
      const label = typeof group.label === 'string' && group.label.trim() ? group.label : ''
      return { kind: 'group', n: group.n, text: label || lead.text, label, leadText: lead.text, count: group.count, cardIds: group.cardIds.slice(),
        hidden: group.count === 0, column: id }
    })
    const singles = cards.filter((card) => card.column === id && card.group === undefined && !inboxIds.has(card.cardId))
    const single = (card) => ({ kind: 'card', cardId: card.cardId, text: card.text, column: id, acceptedAt: card.acceptedAt,
      ...(card.name ? { name: card.name } : {}), ...(card.fromGroup !== undefined ? { fromGroup: card.fromGroup } : {}),
      ...(card.waiting ? { waiting: true } : {}), ...(card.hidden ? { hidden: true } : {}) })
    // The worker's own order: what the big screen shows (singles newest first), then what waits
    // (oldest first, the order "Show next" releases them), then hidden cards and groups.
    const shownOrder = new Map(screen.onScreen.filter((entry) => entry.cardId).map((entry, index) => [entry.cardId, index]))
    const onScreen = singles.filter((card) => !card.hidden && !card.waiting)
      .sort((a, b) => (shownOrder.has(a.cardId) ? shownOrder.get(a.cardId) : 1e9) - (shownOrder.has(b.cardId) ? shownOrder.get(b.cardId) : 1e9) || b.acceptedAt - a.acceptedAt)
    const waiting = singles.filter((card) => !card.hidden && card.waiting).sort((a, b) => a.acceptedAt - b.acceptedAt)
    const hidden = singles.filter((card) => card.hidden)
    const entries = [...groupEntries.filter((group) => !group.hidden), ...onScreen.map(single), ...waiting.map(single),
      ...groupEntries.filter((group) => group.hidden), ...hidden.map(single)]
    const count = groupEntries.reduce((sum, group) => sum + group.count, 0) + onScreen.length + waiting.length
    const own = release.columns && release.columns[id]
    return { id, label: labelOf(id), count, waiting: screen.waiting || 0, mode: own || null, entries }
  })
  const entries = board ? board.entries : 0
  const shown = board ? board.shown : 0
  const waitingTotal = board ? board.waiting : 0
  const released = release.all || release.groupsOnly || release.extra > 0 || Object.keys(release.columns || {}).length > 0
  const strip = {
    limit, entries, shown, waiting: waitingTotal, released,
    all: !!release.all, groupsOnly: !!release.groupsOnly,
    // "Big screen every card · 16 · limit 24" (D1), "Big screen 24 of 40 · 16 waiting" (D7),
    // "Big screen every card · 40, past the limit of 24" (D12).
    text: waitingTotal > 0 ? `Big screen ${shown} of ${entries}` : 'Big screen every card',
    detail: waitingTotal > 0 ? `${waitingTotal} waiting`
      : limit === null ? `${shown} · no limit`
        : shown > limit ? `${shown}, past the limit of ${limit}` : `${shown} · limit ${limit}`,
    next: waitingTotal > 0 ? Math.min(12, waitingTotal) : 0,
    back: released && limit !== null ? limit : null,
  }
  const cardCount = board ? board.cardCount : 0
  return {
    pollId: poll ? poll.pollId : state && state.pollId, question: (state && state.question) || (poll && poll.question) || '',
    phase, cardCount, newCount: inbox.length, frozen: phase === 'frozen', names: !!settings.names,
    cardChars: Number.isSafeInteger(settings.cardChars) && settings.cardChars > 0 ? settings.cardChars : 140,
    inbox, columns, strip, columnIds: options.map((option) => option.optionId),
  }
}

/** Find an entry of the view by target: `{ cardId }` or `{ group }`. */
export function bpFind(view, target) {
  if (!view || !target) return null
  for (const entry of view.inbox) if (target.cardId && entry.cardId === target.cardId) return entry
  for (const column of view.columns) {
    for (const entry of column.entries) {
      if (target.group !== undefined && entry.kind === 'group' && entry.n === target.group) return entry
      if (target.cardId && entry.kind === 'card' && entry.cardId === target.cardId) return entry
    }
  }
  return null
}

/**
 * What a drop does. `source` is `{ cardId }` or `{ group }`; `target` is `{ cardId }`, `{ group }`
 * or `{ column }`. Onto a card or group: merge. Onto a column: move. Onto itself: nothing.
 */
export function bpDrop(source, target) {
  if (!source || !target) return null
  const same = (source.cardId && source.cardId === target.cardId) || (source.group !== undefined && source.group === target.group)
  if (same) return null
  const from = source.cardId ? { cardId: source.cardId } : { group: source.group }
  if (target.column) return { op: 'move', target: from, column: target.column }
  if (target.cardId) return { op: 'merge', source: from, target: { cardId: target.cardId } }
  if (target.group !== undefined) return { op: 'merge', source: from, target: { group: target.group } }
  return null
}

/** The one worker operation an intent sends, or null when the intent is not one. */
export function bpMessage(pollId, intent) {
  if (!pollId || !intent) return null
  const target = (value) => value && typeof value.cardId === 'string' ? { cardId: value.cardId }
    : value && Number.isSafeInteger(value.group) ? { group: value.group } : null
  switch (intent.op) {
    case 'move': return target(intent.target) && intent.column ? { type: 'board.move', pollId, target: target(intent.target), column: intent.column } : null
    case 'merge': return target(intent.source) && target(intent.target) ? { type: 'board.merge', pollId, source: target(intent.source), target: target(intent.target) } : null
    case 'split': return Number.isSafeInteger(intent.group) ? { type: 'board.split', pollId, group: intent.group } : null
    case 'hide': return target(intent.target) ? { type: 'board.hide', pollId, target: target(intent.target), hidden: intent.hidden !== false } : null
    case 'freeze': return { type: 'board.freeze', pollId, frozen: intent.frozen !== false }
    case 'release': {
      if (intent.column) return ['all', 'groupsOnly', 'limit'].includes(intent.mode) ? { type: 'board.release', pollId, mode: intent.mode, column: intent.column } : null
      if (intent.mode === 'next') return { type: 'board.release', pollId, mode: 'next', count: Number.isSafeInteger(intent.count) && intent.count > 0 ? intent.count : 12 }
      return ['all', 'groupsOnly', 'limit'].includes(intent.mode) ? { type: 'board.release', pollId, mode: intent.mode } : null
    }
    case 'limit': return intent.limit === null || (Number.isSafeInteger(intent.limit) && intent.limit > 0) ? { type: 'board.limit', pollId, limit: intent.limit } : null
    case 'relabel': return Number.isSafeInteger(intent.group) && typeof intent.text === 'string' ? { type: 'board.relabel', pollId, group: intent.group, text: intent.text.trim() } : null
    default: return null
  }
}

/**
 * The one intent that undoes `intent`, judged against the view before it was sent; null where no
 * single operation can (a merged or split group's number is retired for good, and a release on top
 * of another release cannot be stepped back one step).
 */
export function bpUndo(intent, view) {
  if (!intent || !view) return null
  const before = (target) => bpFind(view, target)
  switch (intent.op) {
    case 'hide': return { op: 'hide', target: intent.target, hidden: !(intent.hidden !== false) }
    case 'freeze': return { op: 'freeze', frozen: !(intent.frozen !== false) }
    case 'move': {
      const entry = before(intent.target)
      if (!entry) return null
      if (entry.kind === 'group') return { op: 'move', target: { group: entry.n }, column: entry.column }
      const group = view.columns.flatMap((column) => column.entries).find((item) => item.kind === 'group' && item.cardIds.includes(entry.cardId))
      if (group) return { op: 'merge', source: { cardId: entry.cardId }, target: { group: group.n } }
      return { op: 'move', target: { cardId: entry.cardId }, column: entry.column }
    }
    case 'merge': {
      if (intent.source.group !== undefined) return null
      const source = before(intent.source)
      if (!source) return null
      // Onto a single card: the merge made a new group, whose number is known only once the worker
      // has made it; the undo splits the group that card is in then.
      if (intent.target.cardId && before(intent.target) && before(intent.target).kind === 'card') {
        return { op: 'split', groupOf: intent.target.cardId }
      }
      return { op: 'move', target: { cardId: source.cardId }, column: source.column }
    }
    case 'release': {
      if (intent.column) {
        const column = view.columns.find((item) => item.id === intent.column)
        return column && !column.mode ? { op: 'release', mode: 'limit', column: intent.column } : null
      }
      return view.strip.released ? null : { op: 'release', mode: 'limit' }
    }
    case 'limit': return view.strip.released ? null : { op: 'limit', limit: view.strip.limit }
    case 'relabel': {
      const group = before({ group: intent.group })
      return group && group.kind === 'group' ? { op: 'relabel', group: intent.group, text: group.label || '' } : null
    }
    default: return null
  }
}

/** An undo intent made concrete against the board as it is now (a split names its group). */
export function bpResolve(intent, view) {
  if (!intent) return null
  if (intent.op === 'split' && intent.groupOf) {
    const group = view && view.columns.flatMap((column) => column.entries).find((entry) => entry.kind === 'group' && entry.cardIds.includes(intent.groupOf))
    return group ? { op: 'split', group: group.n } : null
  }
  return intent
}

/** What the toast says once a change is sent (judged against the view before it). */
export function bpToast(intent, view) {
  const entry = (target) => bpFind(view, target)
  const label = (id) => ((view && view.columns.find((column) => column.id === id)) || {}).label || id
  const name = (item) => item ? (item.kind === 'group' ? `${item.n} · ${item.text}` : item.text) : 'the card'
  switch (intent && intent.op) {
    case 'merge': {
      const target = entry(intent.target)
      const source = entry(intent.source)
      const adds = source ? (source.kind === 'group' ? source.count : 1) : 1
      if (target && target.kind === 'group') return { text: `Merged into ${target.n} · ${target.text}`, detail: `now ×${target.count + adds}` }
      return { text: `Merged with ${target ? target.text : 'the card'}`, detail: `now ×${1 + adds}` }
    }
    case 'move': {
      const item = entry(intent.target)
      return { text: item && item.kind === 'group' ? `Group ${item.n} moved to ${label(intent.column)}` : `Moved to ${label(intent.column)}`, detail: item && item.kind === 'card' ? item.text : '' }
    }
    case 'split': {
      const item = entry({ group: intent.group })
      return { text: `Group ${intent.group} split into its ${item ? item.cardIds.length : ''} cards.`.replace('  ', ' '), detail: `Number ${intent.group} retires` }
    }
    case 'hide': {
      const item = entry(intent.target)
      return intent.hidden !== false
        ? { text: item && item.kind === 'group' ? `Group ${item.n} hidden from the board` : 'Hidden from the board', detail: 'kept in the Run' }
        : { text: 'Back on the board', detail: name(item) }
    }
    case 'freeze': return intent.frozen !== false ? { text: 'Board frozen', detail: 'final: no new cards, no changes' } : { text: 'Board unfrozen', detail: 'sorting and new cards again' }
    case 'release': {
      if (intent.column) {
        const column = label(intent.column)
        return intent.mode === 'all' ? { text: `${column}: every card on the big screen`, detail: 'type smaller' }
          : intent.mode === 'groupsOnly' ? { text: `${column}: groups only on the big screen`, detail: 'its singles stay on phones' }
            : { text: `${column}: back to the limit`, detail: '' }
      }
      const strip = view ? view.strip : { entries: 0, waiting: 0, limit: 24 }
      if (intent.mode === 'next') return { text: `Showing ${Math.min(intent.count || 12, strip.waiting)} more on the big screen`, detail: 'oldest waiting first' }
      if (intent.mode === 'all') return { text: 'Every card on the big screen.', detail: `${strip.entries} of ${strip.entries} · type smaller` }
      if (intent.mode === 'groupsOnly') return { text: 'Groups only on the big screen', detail: 'singles stay on phones' }
      return { text: `Back to the limit${strip.limit === null ? '' : ` of ${strip.limit}`}`, detail: 'newest leave the screen' }
    }
    case 'limit': return { text: intent.limit === null ? 'No limit on the big screen' : `Big-screen limit: ${intent.limit} cards`, detail: '' }
    case 'relabel': return intent.text && intent.text.trim()
      ? { text: `Group ${intent.group} now reads: ${intent.text.trim()}`, detail: 'the cards keep theirs' }
      : { text: `Group ${intent.group} shows its first card again`, detail: '' }
    default: return { text: '', detail: '' }
  }
}

/** The plain sentence for a refused board operation. */
export function bpRefusal(error) {
  const reasons = {
    board_frozen: 'The board is frozen. Unfreeze it to move, merge or split cards.',
    already_merged: 'Those cards are already together.',
    card_not_found: 'That card has gone from the board.',
    card_too_long: 'That wording is longer than a card on this board.',
    group_not_found: 'That group has gone from the board.',
    unknown_column: 'That column is not on this board.',
    board_not_found: 'This board is not open in the live session.',
    storage_failed: 'The live service could not save that. Try again.',
  }
  return reasons[error] || 'The board did not take that change. Try again.'
}

/** "just now", "20 s", "1 min", "3 min", "1 h": how long ago a card came in. */
export function bpAgo(acceptedAt, now) {
  const seconds = Math.max(0, Math.round((now - acceptedAt) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h`
}

export function boardPanelModelSource() {
  return [bpView, bpFind, bpDrop, bpMessage, bpUndo, bpResolve, bpToast, bpRefusal, bpAgo]
    .map((fn) => fn.toString().replace(/^export /, '')).join('\n')
}
