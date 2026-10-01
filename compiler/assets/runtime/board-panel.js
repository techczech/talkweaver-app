// The presenter's board panel (ADR-0032 decision 4 and its 2026-09-30 amendment; feedback-boards
// ticket 05, drawn in docs/design/2026-09-28-feedback-boards/round-2/shots D1–D24).
//
// Two parts, both embedded in the presenter template by `.toString()` (boardPanelRuntimeSource), so
// each is self-contained:
//  - createBoardController: one per presenter window. It holds the board as the worker last sent it,
//    the cards marked sorted here, the last change's undo, the keyboard pick and the toast, and sends
//    every change as exactly ONE worker operation (bpMessage, board-panel-model.js).
//  - createBoardPanel: draws the controller's board into one document, beside the slide, full screen
//    in the presenter window, or in the board's own window (a second document the presenter window
//    opened; the same code draws there). Drag a card onto a card or group to merge, onto a column to
//    move; every drag has a keyboard way (⌥↵ picks up and drops; the card's menu, opened with ↵ or
//    Space, moves, merges, hides, splits); ⌘Z undoes the last change.
// Card text, names and column labels are untrusted: written with textContent only, never as HTML.

export function createBoardController(options) {
  const send = options.send
  const store = options.store || null
  const now = options.now || (() => Date.now())
  let poll = null
  let state = null
  let view = null
  let sorted = new Set()
  let last = null // { intent, undo, before }
  let waitingUndo = null // an undo pressed before the state it needs arrived
  let toast = null // { tone, text, detail, undo }
  let toastTimer = 0
  let pick = null // { target, text }
  const listeners = new Set()
  const sortedKey = (pollId) => `tw-board-sorted:${pollId}`
  function loadSorted(pollId) {
    try { const raw = store && store.getItem(sortedKey(pollId)); return new Set(raw ? JSON.parse(raw) : []) } catch { return new Set() }
  }
  function saveSorted() {
    try { if (store && poll) store.setItem(sortedKey(poll.pollId), JSON.stringify([...sorted])) } catch { /* a per-window convenience only */ }
  }
  function changed() { for (const listener of listeners) { try { listener() } catch { /* one panel's failure never stops another */ } } }
  function rebuild() { view = poll ? bpView(poll, state, sorted) : null }
  function say(next, ms) {
    toast = next
    clearTimeout(toastTimer)
    if (next) toastTimer = setTimeout(() => { toast = null; changed() }, ms || 6000)
    changed()
  }
  async function dispatch(intent, { undoable = true } = {}) {
    if (!poll || !view) return false
    const message = bpMessage(poll.pollId, intent)
    if (!message) return false
    const before = view
    if (undoable) waitingUndo = null
    const undo = undoable ? bpUndo(intent, before) : null
    last = { intent, undo, before, message }
    const words = bpToast(intent, before)
    say({ tone: 'done', text: words.text, detail: words.detail, undo: Boolean(undo) })
    let result
    try { result = await send(message) } catch { result = { success: false, error: 'storage_failed' } }
    if (!result || result.success === false || result.status === 'rejected') {
      if (last && last.message === message) last = null
      // A refused change leaves nothing to undo: an undo waiting for its state is dropped too.
      waitingUndo = null
      say({ tone: 'error', text: bpRefusal(result && result.error), detail: '', undo: false }, 8000)
      return false
    }
    return true
  }
  return {
    /** The board to show: its definition and the worker's latest presenter poll.state (or null). */
    set(nextPoll, nextState) {
      // The board has gone (another slide, the session ended): its undo goes with it.
      if (!nextPoll) { poll = null; state = null; view = null; pick = null; last = null; waitingUndo = null; changed(); return }
      if (!poll || poll.pollId !== nextPoll.pollId) { sorted = loadSorted(nextPoll.pollId); last = null; waitingUndo = null; pick = null; toast = null }
      poll = nextPoll
      state = nextState || null
      // A card that has gone (withdrawn) no longer needs its sorted mark.
      const present = new Set((state && state.boardState && state.boardState.cards || []).map((card) => card.cardId))
      if (state && state.boardState) for (const id of [...sorted]) if (!present.has(id)) sorted.delete(id)
      rebuild()
      if (pick && !bpFind(view, pick.target)) pick = null
      if (waitingUndo) {
        const intent = bpResolve(waitingUndo, view)
        if (intent) { waitingUndo = null; void dispatch(intent, { undoable: false }) }
      }
      changed()
    },
    poll: () => poll,
    view: () => view,
    toast: () => toast,
    pick: () => pick,
    hasUndo: () => Boolean(last && last.undo),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    /** One gesture: one worker operation. */
    apply: (intent) => dispatch(intent),
    /** ⌘Z: undo the last change, where one operation can. */
    undo() {
      if (!last || !last.undo) return false
      const intent = bpResolve(last.undo, view)
      if (!intent) {
        // Undo pressed before the worker's answer: a merge of two singles has no group number yet.
        // The undo waits for the state that carries the new group (set() sends it), never lost.
        if (last.undo.groupOf) { waitingUndo = last.undo; last = null; say({ tone: 'done', text: 'Undoing…', detail: 'waiting for the board', undo: false }); return true }
        last = null
        say({ tone: 'error', text: 'That change cannot be undone now.', detail: '', undo: false })
        return false
      }
      last = null
      void dispatch(intent, { undoable: false })
      return true
    },
    /** "Mark all sorted": the inbox is emptied here; nothing changes on any screen. */
    markAllSorted() {
      if (!view) return
      for (const entry of view.inbox) sorted.add(entry.cardId)
      saveSorted(); rebuild(); changed()
    },
    /** A rejected or confirmed board operation reported by the live bridge. */
    operation(update) {
      if (!update || !update.message || !String(update.message.type || '').startsWith('board.')) return
      if (update.status === 'rejected') {
        if (last && last.message && JSON.stringify(last.message) === JSON.stringify(update.message)) last = null
        waitingUndo = null
        say({ tone: 'error', text: bpRefusal(update.error), detail: '', undo: false }, 8000)
      }
    },
    dismissToast() { say(null) },
    /** The keyboard's drag: pick up a card or group, then drop it on a card, group or column. */
    pickUp(target) {
      const entry = bpFind(view, target)
      if (!entry || entry.hidden || (view && view.frozen)) return false
      pick = { target: entry.kind === 'group' ? { group: entry.n } : { cardId: entry.cardId }, text: entry.text, group: entry.kind === 'group' ? entry.n : null }
      changed()
      return true
    },
    drop(target) {
      if (!pick) return false
      // As with a pointer drop: a hidden card or group is no target (the pick stays held).
      const onto = target && !target.column ? bpFind(view, target) : null
      if (target && !target.column && (!onto || onto.hidden)) return true
      const intent = bpDrop(pick.target, target)
      pick = null
      changed()
      if (intent) void dispatch(intent)
      return Boolean(intent)
    },
    cancelPick() { if (!pick) return false; pick = null; changed(); return true },
    now,
  }
}

/**
 * Draw the controller's board into `host` (an element of `doc`). `mode` is 'beside', 'full' or
 * 'window'. `actions`: primary() opens, closes or reopens the board (Q); fullScreen(on); popOut();
 * putBack(); close() hides the panel; monitor(el) draws what the room sees into `el` (full screen
 * and the board window); place(root) positions the panel (beside and full screen); toastBox() the
 * top-left the toast sits at. `icon(name)` returns a lucide SVG element. `keys` names Q, ⌘Z, ⌥↵.
 */
export function createBoardPanel(options) {
  const { doc, host, controller, actions } = options
  const icon = (name) => { const svg = options.icon(name); return svg ? doc.importNode(svg, true) : doc.createElement('span') }
  const keys = Object.assign({ primary: 'Q', undo: '⌘Z', pick: '⌥↵' }, options.keys || {})
  let mode = options.mode || 'beside'
  let shown = false
  let menu = null // { kind, key, anchor }
  let drag = null
  let slideLabel = ''
  const root = host
  root.classList.add('bp')
  root.setAttribute('role', 'region')
  root.setAttribute('aria-label', 'Board')

  const el = (tag, className, text) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }
  const button = (className, label, iconName, onClick, extra) => {
    const node = el('button', className)
    node.type = 'button'
    if (iconName) node.append(icon(iconName))
    if (label) node.append(el('span', 'bp-label', label))
    if (extra && extra.kbd) node.append(el('span', 'bp-kbd', extra.kbd))
    if (extra && extra.tip) { node.dataset.tip = extra.tip; node.setAttribute('aria-label', extra.tip) }
    if (extra && extra.id) node.id = extra.id
    if (extra && extra.disabled) node.disabled = true
    // A mouse press never takes the keyboard from the slides (Space still moves to the next slide).
    node.addEventListener('mousedown', (event) => { if (event.button === 0) event.preventDefault() })
    node.addEventListener('click', (event) => { event.stopPropagation(); onClick(event) })
    return node
  }
  const targetOf = (node) => { try { return JSON.parse(node.dataset.target) } catch { return null } }
  const keyOf = (target) => target ? (target.cardId ? `c:${target.cardId}` : target.group !== undefined ? `g:${target.group}` : `k:${target.column}`) : ''

  // ── Header ─────────────────────────────────────────────────────────────────────────────
  function header(view) {
    const head = el('header', 'bp-head')
    const title = el('div', 'bp-title')
    title.append(icon('layout-grid'), el('b', '', 'Board'))
    const counts = el('span', 'bp-counts', `${view.cardCount} ${view.cardCount === 1 ? 'card' : 'cards'}`)
    if (view.newCount && !view.frozen) counts.append(doc.createTextNode(' · '), el('span', 'bp-new', `${view.newCount} new`))
    title.append(counts)
    const chip = el('span', `bp-chip is-${view.phase}`)
    if (view.phase === 'closed') chip.append(icon('lock'))
    if (view.phase === 'frozen') chip.append(icon('snowflake'))
    chip.append(doc.createTextNode({ open: 'Open', closed: 'Closed', frozen: 'Frozen', ready: 'Not open yet' }[view.phase]))
    title.append(chip)
    head.append(title, el('span', 'bp-spacer'))
    if (view.phase === 'frozen') head.append(button('bp-btn', 'Unfreeze', 'lock-open', () => controller.apply({ op: 'freeze', frozen: false }), { id: 'boardUnfreeze' }))
    else if (view.phase === 'open') head.append(button('bp-btn', 'Close to new cards', 'lock', () => actions.primary(), { kbd: keys.primary, id: 'boardPrimary' }))
    else head.append(button('bp-btn', view.phase === 'closed' ? 'Reopen' : 'Open board', 'lock-open', () => actions.primary(), { kbd: keys.primary, id: 'boardPrimary' }))
    if (mode === 'beside') {
      head.append(button('bp-icon-btn', '', 'maximize-2', () => actions.fullScreen(true), { tip: 'Board full screen', id: 'boardFullScreen' }))
      head.append(button('bp-icon-btn', '', 'picture-in-picture-2', () => actions.popOut(), { tip: 'Pop out the board · its own window, for another screen', id: 'boardPopOut' }))
      head.append(button('bp-icon-btn', '', 'x', () => actions.close(), { tip: 'Close the board panel', id: 'boardClose' }))
    } else if (mode === 'full') {
      head.append(button('bp-btn', 'Exit full screen', 'minimize-2', () => actions.fullScreen(false), { id: 'boardExitFullScreen' }))
      head.append(button('bp-btn', 'Pop out', 'picture-in-picture-2', () => actions.popOut(), { id: 'boardPopOut' }))
      head.append(button('bp-icon-btn', '', 'x', () => actions.close(), { tip: 'Close the board panel', id: 'boardClose' }))
    } else {
      head.append(button('bp-btn', 'Put back in the presenter window', 'picture-in-picture-2', () => actions.putBack(),
        { id: 'boardPutBack', tip: 'Put back · the board returns beside the slide in the presenter window' }))
    }
    return head
  }

  // ── The big-screen strip and its menu ──────────────────────────────────────────────────
  function strip(view, stacked) {
    const box = el('div', stacked ? 'bp-strip is-stacked' : 'bp-strip')
    const words = el('span', 'bp-strip-words')
    words.append(icon('monitor'), doc.createTextNode(' '))
    words.append(el('span', 'bp-strip-text', view.strip.text), doc.createTextNode(' · '))
    words.append(el('span', view.strip.waiting ? 'bp-strip-waiting' : 'bp-strip-detail', view.strip.detail))
    box.append(words)
    const controls = el('span', 'bp-strip-controls')
    if (view.strip.waiting > 0) {
      controls.append(button('bp-btn', `Show next ${view.strip.next}`, 'list-end', () => controller.apply({ op: 'release', mode: 'next', count: 12 }), { id: 'boardShowNext' }))
      controls.append(button('bp-btn', 'Show all', 'monitor-up', () => controller.apply({ op: 'release', mode: 'all' }), { id: 'boardShowAll' }))
    } else if (view.strip.back !== null) {
      controls.append(button('bp-btn', `Back to ${view.strip.back}`, 'monitor-off', () => controller.apply({ op: 'release', mode: 'limit' }), { id: 'boardBackToLimit' }))
    }
    const more = button('bp-icon-btn', '', 'chevron-down', (event) => toggleMenu({ kind: 'screen', key: 'screen' }, event.currentTarget), { tip: 'Big screen', id: 'boardScreenMenu' })
    more.setAttribute('aria-haspopup', 'menu')
    controls.append(more)
    box.append(controls)
    return box
  }

  // ── The inbox ──────────────────────────────────────────────────────────────────────────
  function inbox(view, oneColumn) {
    const box = el('section', 'bp-inbox')
    const head = el('div', 'bp-inbox-head')
    const title = el('span', 'bp-inbox-title')
    title.append(icon('inbox'), el('b', '', 'New'), el('span', 'bp-num-muted', String(view.newCount)), doc.createTextNode(' · not sorted, already on screen'))
    head.append(title)
    if (view.newCount) head.append(button('bp-link', 'Mark all sorted', '', () => controller.markAllSorted(), { id: 'boardMarkSorted' }))
    box.append(head)
    if (!view.inbox.length) {
      box.append(el('p', 'bp-empty', view.frozen ? 'The board is frozen. Nothing new arrives.' : 'Nothing new. Cards you have not sorted arrive here, newest first.'))
      return box
    }
    const list = el('div', oneColumn ? 'bp-inbox-list is-one' : 'bp-inbox-list')
    for (const entry of view.inbox) list.append(card(view, entry, { inbox: true }))
    box.append(list)
    return box
  }

  // ── Cards and groups ───────────────────────────────────────────────────────────────────
  function card(view, entry, where) {
    const group = entry.kind === 'group'
    const target = group ? { group: entry.n } : { cardId: entry.cardId }
    const node = el('div', 'bp-card')
    node.classList.toggle('is-group', group)
    node.classList.toggle('is-waiting', !!entry.waiting)
    node.classList.toggle('is-hidden', !!entry.hidden)
    node.classList.toggle('is-from-group', entry.fromGroup !== undefined)
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-haspopup', 'menu')
    node.dataset.target = JSON.stringify(target)
    node.dataset.key = keyOf(target)
    if (!entry.hidden) node.dataset.drop = 'entry'
    const pick = controller.pick()
    if (pick && keyOf(pick.target) === keyOf(target)) node.classList.add('is-picked')
    const draggable = !entry.hidden && !view.frozen
    if (draggable) node.dataset.drag = '1'
    const grip = el('span', 'bp-grip')
    grip.append(icon('grip-vertical'))
    const body = el('span', 'bp-card-body')
    const line = el('span', 'bp-card-line')
    if (group) line.append(el('span', 'bp-n', String(entry.n)))
    line.append(el('span', 'bp-text', entry.text))
    body.append(line)
    const meta = []
    if (where && where.inbox) {
      const to = el('span', 'bp-meta')
      to.append(icon('arrow-right'), el('b', '', (view.columns.find((column) => column.id === entry.column) || {}).label || entry.column),
        doc.createTextNode(` · ${bpAgo(entry.acceptedAt, controller.now())}`))
      meta.push(to)
    }
    if (entry.hidden) { const m = el('span', 'bp-meta is-hidden-note'); m.append(icon('eye-off'), doc.createTextNode(group ? 'Group hidden · kept in the Run' : 'Hidden · kept in the Run')); meta.push(m) }
    else if (entry.waiting && !(where && where.inbox)) { const m = el('span', 'bp-meta is-waiting-note'); m.append(icon('monitor-off'), doc.createTextNode('Waiting')); meta.push(m) }
    if (entry.fromGroup !== undefined) { const m = el('span', 'bp-meta is-from'); m.append(icon('ungroup'), doc.createTextNode(`From group ${entry.fromGroup}`)); meta.push(m) }
    if (view.names && entry.name) meta.push(el('span', 'bp-meta is-name', entry.name))
    for (const m of meta) body.append(m)
    node.append(grip, body)
    if (group) node.append(el('span', 'bp-x', `×${entry.count}`))
    const words = group ? `Group ${entry.n}, ${entry.count} cards: ${entry.text}` : entry.text
    node.setAttribute('aria-label', `${words}${entry.waiting ? ', waiting' : ''}${entry.hidden ? ', hidden' : ''}`)
    return node
  }

  function column(view, col) {
    const node = el('section', 'bp-col')
    node.dataset.drop = 'column'
    node.dataset.target = JSON.stringify({ column: col.id })
    node.dataset.key = keyOf({ column: col.id })
    const head = el('div', 'bp-col-head')
    const name = el('span', 'bp-col-name')
    name.tabIndex = 0
    name.dataset.target = node.dataset.target
    name.dataset.dropHead = '1'
    name.setAttribute('aria-label', `${col.label} column, ${col.count} cards${col.waiting ? `, ${col.waiting} waiting` : ''}`)
    name.append(el('b', '', col.label), el('span', 'bp-num-muted', String(col.count)))
    if (col.waiting) name.append(el('span', 'bp-col-waiting', ` · ${col.waiting} waiting`))
    if (col.mode === 'groupsOnly') name.append(el('span', 'bp-col-mode', ' · groups only'))
    if (col.mode === 'all') name.append(el('span', 'bp-col-mode', ' · every card'))
    head.append(name)
    const more = button('bp-icon-btn is-small', '', 'ellipsis', (event) => toggleMenu({ kind: 'column', key: col.id }, event.currentTarget), { tip: `${col.label} on the big screen` })
    more.setAttribute('aria-haspopup', 'menu')
    more.dataset.columnMenu = col.id
    head.append(more)
    const list = el('div', 'bp-col-list')
    for (const entry of col.entries) list.append(card(view, entry))
    node.append(head, list)
    return node
  }

  // ── Menus ──────────────────────────────────────────────────────────────────────────────
  function toggleMenu(next, anchor) {
    if (menu && menu.kind === next.kind && menu.key === next.key) { menu = null; render(); return }
    menu = { ...next, anchorKey: anchor && (anchor.dataset.key || anchor.id || anchor.dataset.columnMenu) }
    render()
    const first = root.querySelector('.bp-menu button:not(:disabled)')
    if (first && next.focus) first.focus()
  }
  function closeMenu() { if (!menu) return false; menu = null; render(); return true }
  function item(label, sub, iconName, run, extra) {
    const node = button(`bp-mi${extra && extra.checked ? ' is-checked' : ''}`, label, iconName, () => { menu = null; run(); render() }, extra)
    node.setAttribute('role', extra && extra.checked !== undefined ? 'menuitemcheckbox' : 'menuitem')
    if (extra && extra.checked !== undefined) node.setAttribute('aria-checked', String(!!extra.checked))
    if (sub) node.append(el('span', 'bp-mi-sub', sub))
    return node
  }
  function chips(label, columns, current, run) {
    const row = el('div', 'bp-mi-row')
    row.append(el('span', 'bp-mi-sec', label))
    const set = el('span', 'bp-chips')
    for (const col of columns) set.append(button(`bp-chip-btn${col.id === current ? ' is-current' : ''}`, col.label, '', () => { menu = null; run(col.id); render() }))
    row.append(set)
    return row
  }
  function menuBody(view) {
    const box = el('div', 'bp-menu')
    box.setAttribute('role', 'menu')
    if (menu.kind === 'screen') {
      box.setAttribute('aria-label', 'Big screen')
      box.append(el('div', 'bp-mi-sec', 'Big screen'))
      box.append(item(`Show next ${view.strip.next || 12}`, 'oldest waiting first', 'list-end', () => controller.apply({ op: 'release', mode: 'next', count: 12 }), { disabled: !view.strip.waiting }))
      box.append(item(view.strip.waiting ? `Show all ${view.strip.waiting} waiting` : 'Show every card', 'type gets smaller', 'monitor-up', () => controller.apply({ op: 'release', mode: 'all' }), { checked: view.strip.all }))
      box.append(item('Groups only', 'singles stay on phones', 'group', () => controller.apply({ op: 'release', mode: view.strip.groupsOnly ? 'limit' : 'groupsOnly' }), { checked: view.strip.groupsOnly }))
      box.append(item(`Back to the limit${view.strip.limit === null ? '' : ` (${view.strip.limit})`}`, 'newest leave the screen', 'monitor-off', () => controller.apply({ op: 'release', mode: 'limit' }), { disabled: !view.strip.released }))
      const row = el('div', 'bp-mi-row')
      const label = el('span', 'bp-mi-sec')
      label.append(icon('monitor'), doc.createTextNode(` Limit: ${view.strip.limit === null ? 'all cards' : `${view.strip.limit} cards`}`))
      row.append(label)
      const set = el('span', 'bp-chips')
      for (const value of [12, 24, 36, null]) {
        set.append(button(`bp-chip-btn${value === view.strip.limit ? ' is-current' : ''}`, value === null ? 'All' : String(value), '',
          () => { menu = null; if (value !== view.strip.limit) controller.apply({ op: 'limit', limit: value }); render() }))
      }
      row.append(set)
      box.append(row)
      return box
    }
    if (menu.kind === 'column') {
      const col = view.columns.find((item) => item.id === menu.key)
      if (!col) return null
      box.setAttribute('aria-label', `${col.label} on the big screen`)
      box.append(el('div', 'bp-mi-sec', `${col.label} on the big screen`))
      if (col.waiting) box.append(item(`Show ${col.label}’s ${col.waiting} waiting`, '', 'list-end', () => controller.apply({ op: 'release', mode: 'all', column: col.id })))
      box.append(item(`${col.label}: groups only`, 'hide its overflow', 'group', () => controller.apply({ op: 'release', mode: col.mode === 'groupsOnly' ? 'limit' : 'groupsOnly', column: col.id }), { checked: col.mode === 'groupsOnly' }))
      if (!col.waiting) box.append(item(`${col.label}: every card`, '', 'monitor-up', () => controller.apply({ op: 'release', mode: col.mode === 'all' ? 'limit' : 'all', column: col.id }), { checked: col.mode === 'all' }))
      if (col.mode) box.append(item(`${col.label}: back to the limit`, '', 'monitor-off', () => controller.apply({ op: 'release', mode: 'limit', column: col.id })))
      return box
    }
    const menuAnchor = menu.anchorKey
    if (menu.kind === 'relabel') {
      // "Edit the group's wording" (D13): the words every screen shows for the group; its cards keep theirs.
      const group = bpFind(view, { group: Number(menu.key) })
      if (!group || group.kind !== 'group' || view.frozen) return null
      box.setAttribute('role', 'dialog')
      box.setAttribute('aria-label', `Group ${group.n}: its wording`)
      box.append(el('div', 'bp-mi-sec', `Group ${group.n} · its wording on every screen`))
      const form = el('form', 'bp-relabel')
      const input = el('input', 'bp-relabel-input')
      input.type = 'text'
      input.maxLength = view.cardChars
      // A draft survives the panel being drawn again as cards arrive while the presenter types.
      input.value = typeof menu.draft === 'string' ? menu.draft : group.label || group.leadText || ''
      input.id = 'boardRelabelInput'
      input.setAttribute('aria-label', `Wording for group ${group.n}`)
      input.dataset.relabelInput = '1'
      const draftOf = menu
      input.addEventListener('input', () => { draftOf.draft = input.value })
      const row = el('div', 'bp-relabel-row')
      const save = button('bp-btn', 'Save', 'check', () => form.requestSubmit(), { id: 'boardRelabelSave' })
      const reset = button('bp-btn', 'Use the first card’s words', 'undo-2', () => { menu = null; controller.apply({ op: 'relabel', group: group.n, text: '' }); render() },
        { id: 'boardRelabelClear', disabled: !group.label })
      row.append(save, reset)
      form.append(input, row, el('p', 'bp-note', `Up to ${view.cardChars} characters. The cards in the group keep their own words.`))
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const text = input.value.trim()
        menu = null
        if (text !== (group.label || '') && !(text === group.leadText && !group.label)) controller.apply({ op: 'relabel', group: group.n, text })
        render()
      })
      box.append(form)
      return box
    }
    const target = menu.kind === 'group' ? { group: Number(menu.key) } : { cardId: menu.key }
    const entry = bpFind(view, target)
    if (!entry) return null
    if (entry.kind === 'group') {
      box.setAttribute('aria-label', `Group ${entry.n}`)
      box.append(el('div', 'bp-mi-sec', `Group ${entry.n} · ${entry.cardIds.length} cards`))
      if (entry.hidden) {
        box.append(item('Put the group back', 'on every screen again', 'eye', () => controller.apply({ op: 'hide', target, hidden: false })))
        return box
      }
      box.append(item(`Split into its ${entry.cardIds.length} cards`, 'number retires', 'ungroup', () => controller.apply({ op: 'split', group: entry.n }), { disabled: view.frozen }))
      box.append(item('Merge into…', `or drag onto a card · ${keys.pick}`, 'group', () => { controller.pickUp(target); focusKey(keyOf(target)) }, { disabled: view.frozen }))
      if (!view.frozen) box.append(chips('Move the whole group to', view.columns, entry.column, (column) => controller.apply({ op: 'move', target, column })))
      box.append(item('Edit the group’s wording', 'cards keep theirs', 'pencil', () => { menu = { kind: 'relabel', key: String(entry.n), anchorKey: menuAnchor, focus: true } }, { disabled: view.frozen, id: 'boardRelabel' }))
      box.append(item('Hide the group', `all ${entry.cardIds.length} cards, kept in the Run`, 'eye-off', () => controller.apply({ op: 'hide', target, hidden: true })))
      return box
    }
    box.setAttribute('aria-label', 'Card')
    if (entry.hidden) {
      box.append(item('Put back on the board', 'on every screen again', 'eye', () => controller.apply({ op: 'hide', target, hidden: false })))
      return box
    }
    box.append(item('Merge into…', `or drag onto a card · ${keys.pick}`, 'group', () => { controller.pickUp(target); focusKey(keyOf(target)) }, { disabled: view.frozen }))
    if (!view.frozen) box.append(chips('Move to column', view.columns, null, (column) => controller.apply({ op: 'move', target, column })))
    box.append(item('Hide from the board', 'kept in the Run', 'eye-off', () => controller.apply({ op: 'hide', target, hidden: true }), { danger: true }))
    return box
  }
  function placeMenu(box) {
    const anchor = menu.anchorKey && [...root.querySelectorAll('[data-key], [id], [data-column-menu]')]
      .find((node) => node.dataset.key === menu.anchorKey || node.id === menu.anchorKey || node.dataset.columnMenu === menu.anchorKey)
    const rootBox = root.getBoundingClientRect()
    const a = anchor ? anchor.getBoundingClientRect() : rootBox
    const width = Math.min(360, rootBox.width - 16)
    box.style.width = `${width}px`
    let left = Math.min(Math.max(8, a.right - rootBox.left - width), rootBox.width - width - 8)
    let top = a.bottom - rootBox.top + 4
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    // Keep it inside the panel: open upward when it would run off the bottom.
    const h = box.getBoundingClientRect().height
    if (top + h > rootBox.height - 8) { top = Math.max(8, a.top - rootBox.top - h - 4); box.style.top = `${top}px` }
  }

  // ── Toast and the keyboard pick ────────────────────────────────────────────────────────
  function toastEl() {
    const toast = controller.toast()
    if (!toast || !toast.text) return null
    const box = el('div', `bp-toast is-${toast.tone}`)
    box.setAttribute('role', 'status')
    box.append(icon(toast.tone === 'error' ? 'circle-alert' : 'circle-check'))
    const words = el('span', 'bp-toast-words')
    words.append(el('b', '', toast.text))
    if (toast.detail) words.append(doc.createTextNode(' '), el('span', 'bp-toast-detail', toast.detail))
    box.append(words)
    if (toast.undo && controller.hasUndo()) box.append(button('bp-btn is-undo', 'Undo', 'undo-2', () => controller.undo(), { kbd: keys.undo, id: 'boardUndo' }))
    return box
  }
  function pickEl() {
    const pick = controller.pick()
    if (!pick) return null
    const box = el('div', 'bp-pickbar')
    box.setAttribute('role', 'status')
    box.append(icon('hand'), el('b', '', `Holding ${pick.group !== null ? `group ${pick.group}` : 'a card'}: `), el('span', 'bp-pick-text', pick.text))
    box.append(el('span', 'bp-pick-help', ` · ${keys.pick} on a card or group to merge, on a column name to move · Esc puts it down`))
    return box
  }

  // ── Render ─────────────────────────────────────────────────────────────────────────────
  function focusKey(key) {
    const node = key && [...root.querySelectorAll('[data-key]')].find((item) => item.dataset.key === key && item.tabIndex >= 0)
    if (node) node.focus({ preventScroll: false })
  }
  // The panel's frame is kept between draws: the monitor holds an iframe, which would reload if it
  // were moved or rebuilt on every change of the board.
  let frame = null
  function skeleton() {
    if (frame && frame.mode === mode && frame.rail === (mode !== 'beside')) return frame
    root.replaceChildren()
    frame = { mode, rail: mode !== 'beside' }
    if (frame.rail) {
      frame.railEl = el('aside', 'bp-rail')
      const monitorWrap = el('div', 'bp-monitor-wrap')
      frame.monitor = el('div', 'bp-monitor preview')
      monitorWrap.append(frame.monitor)
      frame.railBody = el('div', 'bp-rail-body')
      frame.railEl.append(monitorWrap, frame.railBody)
      root.append(frame.railEl)
    }
    frame.main = el('div', 'bp-main')
    frame.layer = el('div', 'bp-layer')
    root.append(frame.main, frame.layer)
    return frame
  }
  function render() {
    if (drag) return // the board is redrawn when the drag ends
    const view = controller.view()
    root.hidden = !shown || !view
    root.dataset.mode = mode
    if (root.hidden) return
    const active = doc.activeElement && root.contains(doc.activeElement) ? (doc.activeElement.dataset.key || doc.activeElement.id || '') : ''
    const scrolls = [...root.querySelectorAll('.bp-col-list, .bp-inbox-list')].map((node) => node.scrollTop)
    const parts = skeleton()
    if (actions.place) actions.place(root, mode)
    root.classList.toggle('is-frozen', view.frozen)
    root.classList.toggle('is-picking', Boolean(controller.pick()))
    const main = parts.main
    main.replaceChildren(header(view))
    if (mode === 'beside') {
      main.append(strip(view, false), inbox(view, false))
    } else {
      const screen = el('div', 'bp-screen')
      const heading = el('div', 'bp-screen-head')
      heading.append(icon('presentation'), doc.createTextNode(`On the big screen now${slideLabel ? ` · ${slideLabel}` : ''}`))
      screen.append(heading, strip(view, true))
      const note = el('p', 'bp-note')
      note.append(icon('monitor-off'), doc.createTextNode('Cards past the limit wait with a dashed edge. Phones show every card at once.'))
      screen.append(note)
      parts.railBody.replaceChildren(screen, inbox(view, true))
      try { actions.monitor(parts.monitor) } catch { /* the monitor is a picture of the room's screen only */ }
    }
    const cols = el('div', 'bp-cols')
    cols.style.setProperty('--bp-columns', String(Math.max(1, view.columns.length)))
    for (const col of view.columns) cols.append(column(view, col))
    main.append(cols)
    const pickBar = pickEl()
    if (pickBar) main.append(pickBar)
    parts.layer.replaceChildren()
    const toast = toastEl()
    if (toast) { parts.layer.append(toast); placeToast(toast) }
    if (menu) {
      const box = menuBody(view)
      if (box) {
        parts.layer.append(box); placeMenu(box)
        if (menu.focus) { menu.focus = false; const field = box.querySelector('[data-relabel-input]'); if (field) { field.focus(); field.select() } }
      } else menu = null
    }
    ;[...root.querySelectorAll('.bp-col-list, .bp-inbox-list')].forEach((node, index) => { if (scrolls[index]) node.scrollTop = scrolls[index] })
    if (active) {
      const back = [...root.querySelectorAll('[data-key], [id]')].find((node) => node.dataset.key === active || node.id === active)
      if (back && (back.tabIndex >= 0 || back.tagName === 'BUTTON')) {
        back.focus({ preventScroll: true })
        if (back.tagName === 'INPUT') { const end = back.value.length; back.setSelectionRange(end, end) }
      }
    }
  }
  function placeToast(toast) {
    const box = mode === 'beside' && actions.toastBox ? actions.toastBox() : null
    if (box) { toast.style.position = 'fixed'; toast.style.left = `${box.left}px`; toast.style.top = `${box.top}px` }
  }

  // ── Drag and drop (pointer) ────────────────────────────────────────────────────────────
  function dropAt(x, y) {
    const hit = doc.elementFromPoint(x, y)
    if (!hit || !root.contains(hit)) return null
    const entry = hit.closest('[data-drop="entry"]')
    if (entry) return { node: entry, target: targetOf(entry) }
    const col = hit.closest('[data-drop="column"]')
    if (col) return { node: col, target: targetOf(col) }
    return null
  }
  function dropWords(view, source, target) {
    const intent = bpDrop(source, target)
    if (!intent) return ''
    if (intent.op === 'move') return `Move to ${(view.columns.find((column) => column.id === intent.column) || {}).label || intent.column}`
    const into = bpFind(view, intent.target)
    const from = bpFind(view, source)
    const adds = from && from.kind === 'group' ? from.count : 1
    return `Merge · ×${(into && into.kind === 'group' ? into.count : 1) + adds}`
  }
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const node = event.target.closest('[data-drag]')
    if (!node || event.target.closest('button')) return
    event.preventDefault()
    drag = { node, source: targetOf(node), x: event.clientX, y: event.clientY, moved: false, ghost: null, over: null, pill: null, pointerId: event.pointerId }
    try { node.setPointerCapture(event.pointerId) } catch { /* synthetic pointers */ }
  })
  root.addEventListener('pointermove', (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    const view = controller.view()
    if (!drag.moved) {
      drag.moved = true
      const rect = drag.node.getBoundingClientRect()
      drag.ghost = drag.node.cloneNode(true)
      drag.ghost.classList.add('bp-ghost')
      drag.ghost.style.width = `${rect.width}px`
      drag.offset = { x: drag.x - rect.left, y: drag.y - rect.top }
      root.append(drag.ghost)
      drag.node.classList.add('is-dragging')
      root.classList.add('is-dragging')
    }
    const rootBox = root.getBoundingClientRect()
    drag.ghost.style.left = `${event.clientX - rootBox.left - drag.offset.x + 8}px`
    drag.ghost.style.top = `${event.clientY - rootBox.top - drag.offset.y + 6}px`
    const over = dropAt(event.clientX, event.clientY)
    const valid = over && bpDrop(drag.source, over.target) ? over : null
    if (drag.over && drag.over.node !== (valid && valid.node)) drag.over.node.classList.remove('is-drop-card', 'is-drop-column')
    if (drag.pill) { drag.pill.remove(); drag.pill = null }
    drag.over = valid
    if (valid) {
      valid.node.classList.add(valid.target.column ? 'is-drop-column' : 'is-drop-card')
      const pill = el('div', 'bp-drop-pill')
      pill.append(icon(valid.target.column ? 'arrow-right' : 'group'), doc.createTextNode(dropWords(view, drag.source, valid.target)))
      const r = valid.node.getBoundingClientRect()
      pill.style.left = `${Math.max(4, r.left - rootBox.left + 50)}px`
      pill.style.top = `${Math.max(4, r.top - rootBox.top - 16)}px`
      root.append(pill)
      drag.pill = pill
    }
  })
  function endDrag(event, cancelled) {
    if (!drag) return
    const current = drag
    drag = null
    try { current.node.releasePointerCapture(current.pointerId) } catch { /* released already */ }
    if (current.ghost) current.ghost.remove()
    if (current.pill) current.pill.remove()
    root.classList.remove('is-dragging')
    current.node.classList.remove('is-dragging')
    if (!current.moved) {
      // A press without a move opens the card's menu.
      render()
      if (!cancelled) openEntryMenu(current.source, current.node.dataset.key)
      return
    }
    const intent = !cancelled && current.over ? bpDrop(current.source, current.over.target) : null
    render()
    if (intent) void controller.apply(intent)
  }
  root.addEventListener('pointerup', (event) => endDrag(event, false))
  root.addEventListener('pointercancel', (event) => endDrag(event, true))
  root.addEventListener('contextmenu', (event) => {
    const node = event.target.closest('.bp-card')
    if (!node) return
    event.preventDefault()
    openEntryMenu(targetOf(node), node.dataset.key)
  })
  function openEntryMenu(target, key) {
    if (!target) return
    menu = target.group !== undefined ? { kind: 'group', key: String(target.group), anchorKey: key } : { kind: 'card', key: target.cardId, anchorKey: key }
    render()
  }
  // A press outside an open menu closes it.
  doc.addEventListener('pointerdown', (event) => {
    if (!menu) return
    if (event.target.closest && (event.target.closest('.bp-menu') || event.target.closest('[aria-haspopup="menu"]'))) return
    closeMenu()
  }, true)

  // ── Keys (registry: presenter.board-pick, presenter.board-undo, presenter.close, picker.choose) ──
  root.addEventListener('keydown', (event) => { if (boardPanelKey(event)) { event.preventDefault(); event.stopPropagation() } })
  doc.addEventListener('keydown', (event) => {
    if (!shown || root.hidden) return
    if (boardUndoKey(event)) { event.preventDefault(); event.stopPropagation() }
  }, true)
  function boardUndoKey(event) {
    const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)
    if (typing) return false
    // ⌘Z while the panel shows is the board's undo, even with nothing to undo (never the gallery's Z).
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') { controller.undo(); return true }
    // In the board's own window Q still opens, closes or reopens the board, as it does beside the slide.
    if (mode === 'window' && (event.key === 'q' || event.key === 'Q') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) { actions.primary(); return true }
    // Esc in the board's own window: the most local thing first (menu, then the pick).
    if (mode === 'window' && event.key === 'Escape') return closeMenu() || controller.cancelPick()
    return false
  }
  function boardPanelKey(event) {
    const node = event.target
    if (event.key === 'Escape') {
      if (closeMenu()) return true
      if (controller.cancelPick()) return true
      if (mode === 'full') { actions.fullScreen(false); return true }
      return false
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'Enter') {
      const target = node && node.dataset && node.dataset.target ? targetOf(node) : null
      if (!target) return false
      const key = keyOf(target)
      if (controller.pick()) { controller.drop(target); focusKey(key); return true }
      if (target.column) return false
      controller.pickUp(target)
      focusKey(key)
      return true
    }
    // ↵ or Space on a focused card opens its menu; on a button they press it (and never reach the
    // presenter's own ↵ / Space, which move to the next slide).
    if ((event.key === 'Enter' || event.key === ' ') && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (node && node.classList && node.classList.contains('bp-card')) {
        openEntryMenu(targetOf(node), node.dataset.key)
        const first = root.querySelector('.bp-menu button:not(:disabled)')
        if (first) first.focus()
        return true
      }
      if (node && node.tagName === 'BUTTON') { event.stopPropagation(); return false }
    }
    return false
  }

  return {
    el: root,
    show(value) { shown = Boolean(value); if (!shown) menu = null; render() },
    setMode(next) { mode = next; menu = null; render() },
    mode: () => mode,
    setSlideLabel(value) { slideLabel = value || '' },
    render,
    isOpen: () => shown && !root.hidden,
  }
}

export function boardPanelRuntimeSource(modelSource) {
  return [modelSource, createBoardController.toString(), createBoardPanel.toString()].join('\n')
}
