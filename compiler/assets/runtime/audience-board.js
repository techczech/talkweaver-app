// The board on the published audience page (ADR-0032 and its 2026-09-30 amendment; ticket "People add
// cards from a phone or laptop, and can edit or withdraw their own"; drawings round-2 F1-F14 and
// round-3 L1, L2). Every function here is one the page runtime embeds by `.toString()` (see
// audienceBoardRuntimeSource), so each is self-contained: no module-level constants of its own.
//
// The pure seams (what a board's poll.state may carry, the tabs and the column's list, the box's
// states, every refusal's sentence) are in audience-board-model.js, the look in
// audience-board-styles.js; both are re-exported from here. This file is the DOM seam:
//  - createAudienceBoard(options)     the panel: tabs, card box, own cards; a docked bar on a phone, a
//                                     panel beside the slide on a laptop
//
// Sending is not here: the follow client owns the socket and the offline queue
// (createAudienceFollowClient.sendCard in live-follow.js, the same first-in first-out queue as
// reactions and questions); the panel hands it `{op, pollId, column?, text?, cardId?, name?, slideId,
// tMs}` and hears back through onCardStatus. Card text, hints, instructions and names are untrusted:
// this file writes them with textContent only, never as HTML.

import { boardCardsLeft, boardChars, boardClip, boardColumnList, boardColumnTabs, boardComposerState, boardRefusal, boardSentNote, audienceBoardModelSource } from './audience-board-model.js'

export * from './audience-board-model.js'
export { audienceBoardStyles } from './audience-board-styles.js'

/**
 * The panel. Options: document, mount (the panel element), icons, isPhone(), isConnected(),
 * getSlideId() → the slide the person is on, getSlideInfo(id) → { number, title }, getName() → the
 * page's optional name, isAskAvailable(), onAsk(), sendCard(input) → submissionId | false,
 * pendingCards() → the cards waiting in the client's queue, onActiveChange(active), now(), schedule(),
 * cancelSchedule().
 * @param {any} options
 */
export function createAudienceBoard(options) {
  const document = options.document
  const mount = options.mount
  const icons = options.icons || {}
  const now = options.now || (() => Date.now())
  const schedule = options.schedule || ((fn, ms) => setTimeout(fn, ms))
  const cancelSchedule = options.cancelSchedule || ((handle) => clearTimeout(handle))
  const polls = new Map() // pollId → the board's normalised poll.state
  const pollBySlide = new Map() // slideId → pollId
  const owned = new Map() // cardId → { pollId, column, text } cards this device sent (its snapshot and its acks)
  const used = new Map() // pollId → cardsUsed (hidden cards count)
  const pending = new Map() // submissionId → { op, pollId, column, text, cardId }
  const chosen = new Map() // pollId → the column the person is adding to
  const drafts = new Map() // `${pollId}:${column}` → the text typed and not yet sent (this page only, never stored)
  let visible = false
  let active = false
  let built = false
  let sessionId = ''
  let editing = null // { pollId, cardId, column, before } while a card of the person's own is being changed
  let note = null // { tone, icon, text }
  let noteTimer = null
  let sheetCard = null // the own card whose menu is open (phone)
  let seenSlide = '' // the slide the person was last on, so a repeat of the same slide clears nothing
  let boxKey = null // what the box holds: a draft key, or 'edit:<cardId>' while a card is changed
  let els = null

  const phone = () => Boolean(options.isPhone && options.isPhone())
  const slideId = () => String(options.getSlideId ? options.getSlideId() : '')
  const svg = (name) => '<svg class="lucide lucide-' + name + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  function icon(name) {
    const holder = el('span', 'bd-ico')
    holder.innerHTML = svg(name)
    return holder
  }
  function button(cls, label, act, iconName) {
    const node = el('button', cls)
    node.type = 'button'
    node.setAttribute('data-act', act)
    if (iconName) node.appendChild(icon(iconName))
    node.appendChild(document.createTextNode(label))
    return node
  }
  const currentPoll = () => {
    const id = slideId()
    const pollId = id ? pollBySlide.get(id) : null
    return pollId ? polls.get(pollId) || null : null
  }
  const activeColumn = (poll) => {
    const tabs = boardColumnTabs(poll)
    const wanted = chosen.get(poll.pollId)
    return (tabs.find((tab) => tab.id === wanted) || tabs[0] || { id: '', label: '', hint: '', count: 0 })
  }
  const draftKey = (poll, column) => poll.pollId + ':' + column.id
  const queuedAdds = (poll) => (options.pendingCards ? options.pendingCards() : []).filter((item) => item.op === 'add' && item.pollId === poll.pollId).length
  const usedOn = (poll) => used.get(poll.pollId) || 0
  const ownIds = (poll) => {
    const ids = new Set()
    for (const [cardId, card] of owned) if (card.pollId === poll.pollId) ids.add(cardId)
    return ids
  }
  const say = (next, ms) => {
    if (noteTimer !== null) cancelSchedule(noteTimer)
    noteTimer = null
    note = next
    if (next && ms) noteTimer = schedule(() => { noteTimer = null; note = null; renderNote() }, ms)
    renderNote()
  }

  function build() {
    mount.textContent = ''
    const head = el('div', 'bd-head')
    const eyebrow = el('p', 'bd-eyebrow')
    const title = el('h2', 'bd-title')
    head.append(eyebrow, title)
    const top = el('div', 'bd-top')
    const instr = el('div', 'bd-instr')
    const tabs = el('div', 'bd-tabs')
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'Board columns')
    const comp = el('div', 'bd-comp')
    const to = el('div', 'bd-to')
    const toText = el('span', 'bd-to-text')
    const left = el('span', 'bd-left')
    to.append(icon('corner-down-left'), toText)
    const cancel = button('bd-cancel', 'Cancel', 'cancel')
    to.append(cancel, left)
    const compose = el('div', 'bd-compose')
    const text = el('textarea', 'bd-text')
    text.rows = 2
    text.setAttribute('autocomplete', 'off')
    text.setAttribute('spellcheck', 'true')
    const send = button('bd-send', 'Send', 'send', 'send-horizontal')
    const keys = el('p', 'bd-keys')
    compose.append(text, keys, send)
    const state = el('div', 'bd-state')
    state.setAttribute('role', 'status')
    const cardsLeft = el('p', 'bd-cards-left')
    const noteBox = el('div', 'bd-note')
    noteBox.setAttribute('role', 'status')
    noteBox.setAttribute('aria-live', 'polite')
    const ask = el('button', 'bd-ask')
    ask.type = 'button'
    ask.setAttribute('data-act', 'ask')
    ask.append(icon('message-circle-question-mark'), document.createTextNode('Not a card? '), el('b', '', 'Ask the speaker a question'))
    comp.append(to, compose, state, cardsLeft, noteBox, ask)
    top.append(instr, tabs, comp)
    const read = el('div', 'bd-read')
    read.setAttribute('aria-live', 'off')
    mount.append(head, top, read)
    els = { eyebrow, title, instr, tabs, to, toText, left, cancel, compose, text, send, keys, state, cardsLeft, note: noteBox, ask, read }
    tabs.addEventListener('click', onTabClick)
    text.addEventListener('input', onInput)
    text.addEventListener('keydown', onKeydown)
    send.addEventListener('click', submit)
    cancel.addEventListener('click', cancelEdit)
    ask.addEventListener('click', () => { if (options.onAsk) options.onAsk() })
    read.addEventListener('click', onReadClick)
    built = true
  }

  function onTabClick(event) {
    const tab = event.target.closest && event.target.closest('[data-column]')
    const poll = currentPoll()
    if (!tab || !poll || tab.getAttribute('aria-disabled') === 'true') return
    if (editing) return
    stashDraft()
    chosen.set(poll.pollId, tab.getAttribute('data-column'))
    say(null)
    render()
    if (!phone()) focusText()
  }
  function stashDraft() {
    if (!els || !boxKey || boxKey.indexOf('edit:') === 0) return
    drafts.set(boxKey, els.text.value)
  }
  function onInput() {
    const poll = currentPoll()
    if (!poll) return
    const max = poll.board.cardChars
    if (boardChars(els.text.value) > max) els.text.value = boardClip(els.text.value, max)
    if (note && note.tone !== 'offline') say(null)
    renderCompose()
  }
  function onKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !phone()) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape' && editing) {
      event.preventDefault()
      cancelEdit()
    }
  }
  function focusText() {
    if (els && els.text && !els.text.disabled && els.text.focus) els.text.focus({ preventScroll: true })
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────────────
  function submit() {
    const poll = currentPoll()
    if (!poll || !els) return
    const column = activeColumn(poll)
    const body = els.text.value.trim()
    if (!body || boardChars(body) > poll.board.cardChars) return
    if (boardComposerState(poll, { cardsUsed: usedOn(poll), queued: queuedAdds(poll), editing: Boolean(editing) }) !== 'open') return
    const name = poll.board.names && options.getName ? String(options.getName() || '').trim() : ''
    if (editing) {
      const target = editing
      const id = options.sendCard({ op: 'edit', pollId: poll.pollId, cardId: target.cardId, text: body, slideId: slideId(), tMs: now() })
      if (!id) { say({ tone: 'failed', icon: 'circle-x', text: boardRefusal('not_kept', { phone: phone() }).text }); return }
      pending.set(id, { op: 'edit', pollId: poll.pollId, column: column.id, text: body, cardId: target.cardId })
      say({ tone: 'sending', icon: 'clock', text: 'Saving your change…' })
      render()
      return
    }
    const id = options.sendCard({ op: 'add', pollId: poll.pollId, column: column.id, text: body, ...(name ? { name } : {}), slideId: slideId(), tMs: now() })
    if (!id) { say({ tone: 'failed', icon: 'circle-x', text: boardRefusal('not_kept', { phone: phone() }).text }); return }
    pending.set(id, { op: 'add', pollId: poll.pollId, column: column.id, text: body })
    drafts.delete(draftKey(poll, column))
    els.text.value = ''
    boxKey = draftKey(poll, column)
    say(offlineNote())
    render()
  }
  const offlineNote = () => (options.isConnected && !options.isConnected()
    ? { tone: 'offline', icon: 'wifi-off', text: 'No connection. Your card is saved here and sends when the ' + (phone() ? 'phone' : 'device') + ' is back online.' } : null)
  function withdraw(cardId) {
    const poll = currentPoll()
    if (!poll) return
    const id = options.sendCard({ op: 'withdraw', pollId: poll.pollId, cardId, slideId: slideId(), tMs: now() })
    if (!id) { say({ tone: 'failed', icon: 'circle-x', text: boardRefusal('not_kept', { phone: phone() }).text }); return }
    pending.set(id, { op: 'withdraw', pollId: poll.pollId, column: (owned.get(cardId) || {}).column || '', text: '', cardId })
    sheetCard = null
    say(offlineNote())
    render()
  }
  function startEdit(cardId) {
    const poll = currentPoll()
    const card = poll && poll.boardState ? poll.boardState.cards.find((entry) => entry.cardId === cardId) : null
    if (!poll || !card || card.group !== undefined) return
    if (!editing) stashDraft()
    editing = { pollId: poll.pollId, cardId, column: card.column }
    chosen.set(poll.pollId, card.column)
    sheetCard = null
    say(null)
    boxKey = 'edit:' + cardId
    els.text.value = card.text
    render()
    focusText()
  }
  function leaveEdit() {
    editing = null
    boxKey = null
    if (els) els.text.value = ''
  }
  function cancelEdit() {
    if (!editing) return
    leaveEdit()
    say(null)
    render()
  }
  function onReadClick(event) {
    const target = event.target
    const row = target.closest && target.closest('.bd-card.is-mine')
    if (!row) return
    const cardId = row.getAttribute('data-card')
    if (!cardId || row.classList.contains('is-sorted') || row.classList.contains('is-sending')) return
    const act = target.closest && target.closest('[data-act]')
    if (act && act.getAttribute('data-act') === 'edit') startEdit(cardId)
    else if (act && act.getAttribute('data-act') === 'withdraw') withdraw(cardId)
    else if (phone() && !editing && boardComposerState(currentPoll(), { editing: true }) === 'open') { sheetCard = cardId; renderSheet() }
  }

  // ── Receipts ────────────────────────────────────────────────────────────────────────────────
  function onCardStatus(receipt) {
    if (!receipt || typeof receipt.submissionId !== 'string') return
    const item = pending.get(receipt.submissionId) || (receipt.item && receipt.item.kind === 'card' ? { op: receipt.item.op, pollId: receipt.item.pollId, column: receipt.item.column || '', text: receipt.item.text || '', cardId: receipt.item.cardId } : null)
    pending.delete(receipt.submissionId)
    if (!item) {
      // Another tab of this device sent a card: only the allowance is known here.
      if (receipt.item === null && typeof receipt.pollId === 'string' && Number.isSafeInteger(receipt.cardsUsed)) { used.set(receipt.pollId, receipt.cardsUsed); render() }
      return
    }
    const poll = polls.get(item.pollId)
    if (Number.isSafeInteger(receipt.cardsUsed)) used.set(item.pollId, receipt.cardsUsed)
    const tab = poll ? boardColumnTabs(poll).find((entry) => entry.id === item.column) : null
    if (receipt.status === 'confirmed') {
      if (item.op === 'add' && receipt.cardId) owned.set(receipt.cardId, { pollId: item.pollId, column: item.column, text: item.text })
      if (item.op === 'withdraw' && item.cardId) owned.delete(item.cardId)
      if (item.op === 'edit' && item.cardId && owned.has(item.cardId)) owned.get(item.cardId).text = item.text
      if (item.op === 'edit') leaveEdit()
      const shown = poll && poll.boardState && receipt.cardId ? poll.boardState.cards.find((card) => card.cardId === receipt.cardId) : null
      say({ tone: 'ok', icon: 'circle-check', text: boardSentNote(item.op, tab ? tab.label : '', Boolean(shown && shown.waiting)) }, 10000)
      render()
      return
    }
    const refusal = boardRefusal(receipt.error, { max: poll ? poll.board.cardChars : 140, phone: phone() })
    if (item.op === 'add' && els && poll) {
      // The text comes back into the box so nothing typed is lost; a refusal stored nothing.
      const key = draftKey(poll, { id: item.column })
      if (!drafts.get(key)) drafts.set(key, item.text)
      if (boxKey === key && !els.text.value) els.text.value = drafts.get(key)
    }
    if (item.op === 'edit' && (receipt.error === 'card_sorted' || receipt.error === 'card_not_found')) leaveEdit()
    say({ tone: 'failed', icon: 'circle-x', text: refusal.text }, 12000)
    render()
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────
  function renderNote() {
    if (!els) return
    els.note.textContent = ''
    els.note.className = 'bd-note' + (note ? ' ' + note.tone : '')
    if (!note) return
    els.note.appendChild(icon(note.icon))
    els.note.appendChild(el('span', '', note.text))
  }

  function renderTabs(poll, tabs, column) {
    els.tabs.textContent = ''
    for (const tab of tabs) {
      const node = el('button', 'bd-tab')
      node.type = 'button'
      node.setAttribute('role', 'tab')
      node.setAttribute('data-column', tab.id)
      node.setAttribute('aria-selected', tab.id === column.id ? 'true' : 'false')
      if (editing && tab.id !== column.id) node.setAttribute('aria-disabled', 'true')
      node.append(document.createTextNode(tab.label), el('span', 'n', String(tab.count)))
      els.tabs.appendChild(node)
    }
  }

  function renderCompose() {
    const poll = currentPoll()
    if (!poll || !els) return
    const column = activeColumn(poll)
    const state = boardComposerState(poll, { cardsUsed: usedOn(poll), queued: queuedAdds(poll), editing: Boolean(editing) })
    const max = poll.board.cardChars
    const typed = els.text.value
    const left = max - boardChars(typed)
    const isOpen = state === 'open'
    els.compose.hidden = !isOpen
    els.cardsLeft.hidden = !isOpen || Boolean(editing)
    els.to.hidden = !isOpen
    els.cancel.hidden = !editing
    els.text.setAttribute('aria-label', (editing ? 'Change your card in ' : 'Your card for ') + column.label)
    els.text.placeholder = column.hint || 'Add to ' + column.label + '…'
    els.compose.classList.toggle('is-full', left <= 0)
    els.toText.textContent = ''
    if (editing) els.toText.append(document.createTextNode('Editing your card in '), el('b', '', column.label))
    else els.toText.append(document.createTextNode('Your card goes to '), el('b', '', column.label), document.createTextNode(poll.board.names ? '. Only the speaker sees a name, if you give one.' : '. No name is shown.'))
    els.left.textContent = typed ? left + ' left' : ''
    els.send.textContent = ''
    els.send.appendChild(icon(editing ? 'check' : 'send-horizontal'))
    els.send.appendChild(document.createTextNode(editing ? 'Save' : 'Send'))
    els.send.disabled = !typed.trim() || left < 0
    els.keys.textContent = 'Enter to send · Shift+Enter for a new line'
    const remaining = boardCardsLeft(poll.board, usedOn(poll), queuedAdds(poll))
    els.cardsLeft.textContent = remaining === 1 ? '1 card left' : remaining + ' cards left'
    els.state.textContent = ''
    els.state.hidden = isOpen
    els.state.className = 'bd-state'
    if (isOpen) return
    els.state.classList.add('is-' + state)
    const words = {
      closed: ['lock', 'Closed to new cards', 'You can still read the board. Pick a column to see its cards.'],
      frozen: ['snowflake', 'Final board', 'Nothing more changes. The speaker can share it after the session.'],
      maxcards: ['circle-check', 'You have added ' + poll.board.cardsPerPhone + (poll.board.cardsPerPhone === 1 ? ' card' : ' cards'),
        'That is the most one phone can add to this board.' + (ownEditable(poll) ? ' Tap one of yours to change it.' : '')],
    }[state]
    const body = el('span', '')
    body.append(el('b', '', words[1]), document.createTextNode(words[2]))
    els.state.append(icon(words[0]), body)
  }

  // The cards this device sent that the speaker has not sorted into a group: the ones it may still change.
  function ownEditable(poll) {
    if (!poll.boardState) return false
    const own = ownIds(poll)
    return poll.boardState.cards.some((card) => own.has(card.cardId) && card.group === undefined)
  }

  function renderRead(poll, column) {
    const list = boardColumnList(poll, column.id, ownIds(poll))
    const open = boardComposerState(poll, { editing: true }) === 'open'
    els.read.textContent = ''
    const mineCount = poll.boardState ? poll.boardState.cards.filter((card) => ownIds(poll).has(card.cardId)).length : 0
    if (mineCount) {
      const yours = el('div', 'bd-yours')
      yours.appendChild(icon('user-round'))
      const words = el('span', '')
      words.append(el('b', '', 'Your cards: ' + mineCount + ' of ' + poll.board.cardsPerPhone + '. '), document.createTextNode(open ? 'You can change or withdraw one until the speaker sorts it into a group.' : ''))
      yours.appendChild(words)
      els.read.appendChild(yours)
    }
    const head = el('div', 'bd-read-head')
    head.append(el('h3', '', column.label), el('span', '', list.total + (list.total === 1 ? ' card' : ' cards') + ' · groups first, then newest'))
    els.read.appendChild(head)
    const cards = el('div', 'bd-cards')
    const waitingHere = (options.pendingCards ? options.pendingCards() : []).filter((item) => item.op === 'add' && item.pollId === poll.pollId && item.column === column.id)
    for (const item of waitingHere.slice().reverse()) {
      const row = el('div', 'bd-card is-mine is-sending')
      row.append(el('span', 'bd-card-text', item.text))
      const tag = el('span', 'bd-mine sending')
      tag.append(icon('clock'), document.createTextNode('Sending…'))
      row.appendChild(tag)
      cards.appendChild(row)
    }
    for (const entry of list.entries) {
      const gone = entry.cardId && Array.from(pending.values()).some((item) => item.op === 'withdraw' && item.cardId === entry.cardId)
      const row = el('div', 'bd-card' + (entry.group !== null ? ' is-group' : '') + (entry.mine ? ' is-mine' : '') + (entry.sorted ? ' is-sorted' : '') + (gone ? ' is-going' : '')
        + (editing && editing.cardId === entry.cardId ? ' is-editing' : ''))
      if (entry.cardId) row.setAttribute('data-card', entry.cardId)
      if (entry.group !== null) row.appendChild(el('span', 'num', String(entry.group)))
      row.appendChild(el('span', 'bd-card-text', entry.text))
      if (entry.mine && !entry.sorted) {
        const acts = el('span', 'bd-acts')
        const mine = el('span', 'bd-mine')
        mine.append(icon('user-round'), document.createTextNode(entry.waiting ? 'Yours · on the board soon' : 'Yours'))
        acts.appendChild(mine)
        if (open) {
          const edit = button('bd-ic', '', 'edit', 'pencil')
          edit.setAttribute('aria-label', 'Change your card')
          edit.title = 'Change'
          const drop = button('bd-ic danger', '', 'withdraw', 'trash-2')
          drop.setAttribute('aria-label', 'Withdraw your card')
          drop.title = 'Withdraw'
          acts.append(edit, drop)
        }
        row.appendChild(acts)
      } else if (entry.count > 1) row.appendChild(el('span', 'x', '×' + entry.count))
      else row.appendChild(el('span', ''))
      cards.appendChild(row)
    }
    els.read.appendChild(cards)
  }

  function renderSheet() {
    const old = document.querySelector('.bd-sheet-scrim')
    if (old) old.remove()
    if (!sheetCard) return
    const poll = currentPoll()
    const card = poll && poll.boardState ? poll.boardState.cards.find((entry) => entry.cardId === sheetCard) : null
    if (!card || card.group !== undefined) { sheetCard = null; return }
    const column = boardColumnTabs(poll).find((tab) => tab.id === card.column)
    const scrim = el('div', 'bd-sheet-scrim')
    const sheet = el('div', 'bd-sheet')
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-modal', 'true')
    sheet.setAttribute('aria-label', 'Your card')
    sheet.appendChild(el('div', 'bd-grip'))
    const kind = el('p', 'bd-sheet-k')
    kind.append(icon('user-round'), document.createTextNode('Your card in ' + (column ? column.label : '')))
    sheet.append(kind, el('p', 'bd-sheet-t', card.text))
    const editButton = button('bd-sheet-b', 'Edit the wording', 'sheet-edit', 'pencil')
    const dropButton = button('bd-sheet-b danger', 'Withdraw it', 'sheet-withdraw', 'trash-2')
    const cancelButton = button('bd-sheet-b plain', 'Cancel', 'sheet-cancel')
    sheet.append(editButton, dropButton, el('p', 'bd-sheet-n', 'Possible until the speaker sorts it into a group. It goes from every screen at once.'), cancelButton)
    scrim.appendChild(sheet)
    scrim.addEventListener('click', (event) => {
      const act = event.target.closest && event.target.closest('[data-act]')
      const what = act ? act.getAttribute('data-act') : event.target === scrim ? 'sheet-cancel' : ''
      if (what === 'sheet-edit') { const id = sheetCard; sheetCard = null; renderSheet(); startEdit(id) }
      else if (what === 'sheet-withdraw') { const id = sheetCard; renderSheet(); withdraw(id) }
      else if (what === 'sheet-cancel') { sheetCard = null; renderSheet() }
    })
    document.body.appendChild(scrim)
    editButton.focus()
  }

  function render() {
    const poll = visible ? currentPoll() : null
    const next = Boolean(poll)
    if (next !== active) {
      active = next
      mount.hidden = !next
      if (document.body) document.body.classList.toggle('has-bd-bar', next)
      if (options.onActiveChange) options.onActiveChange(next)
    }
    if (!poll) { sheetCard = null; renderSheet(); return }
    if (!built) build()
    if (editing && (editing.pollId !== poll.pollId || boardComposerState(poll, { editing: true }) !== 'open'
      || !(poll.boardState && poll.boardState.cards.some((card) => card.cardId === editing.cardId && card.group === undefined)))) leaveEdit()
    const column = activeColumn(poll)
    const info = (options.getSlideInfo && options.getSlideInfo(slideId())) || {}
    els.eyebrow.textContent = 'Board' + (info.number ? ' · slide ' + info.number : '')
    els.title.textContent = poll.question
    els.instr.textContent = ''
    els.instr.hidden = !(poll.board.instructions || poll.board.example)
    if (poll.board.instructions) els.instr.appendChild(el('p', 'bd-instr-text', poll.board.instructions))
    if (poll.board.example) {
      const example = el('p', 'bd-ex')
      example.append(el('span', '', 'Example'), document.createTextNode(poll.board.example))
      els.instr.appendChild(example)
    }
    // The box holds the draft of the column the person is on (or the card being changed).
    if (!editing && boxKey !== draftKey(poll, column)) {
      stashDraft()
      boxKey = draftKey(poll, column)
      els.text.value = drafts.get(boxKey) || ''
    }
    renderTabs(poll, boardColumnTabs(poll), column)
    renderCompose()
    els.ask.hidden = !(options.isAskAvailable && options.isAskAvailable())
    renderNote()
    renderRead(poll, column)
    renderSheet()
  }

  return {
    startSession(id) {
      if (id === sessionId) return
      sessionId = id
      polls.clear(); pollBySlide.clear(); owned.clear(); used.clear(); pending.clear(); chosen.clear(); drafts.clear()
      editing = null; sheetCard = null; note = null; boxKey = null
      if (els) els.text.value = ''
      render()
    },
    /** A board's `poll.state` (normalised by normalisePollState): every change of the board arrives here. */
    receive(message) {
      if (!message || message.pollType !== 'board' || !message.board) return
      polls.set(message.pollId, message)
      if (message.slideId) pollBySlide.set(message.slideId, message.pollId)
      render()
    },
    /** The phone's own cards and allowances from its snapshot (normaliseOwnBoards). */
    setOwn(own) {
      if (!own) return
      owned.clear()
      for (const card of own.myCards) owned.set(card.cardId, { pollId: card.pollId, column: card.column, text: card.text })
      for (const board of own.myBoards) used.set(board.pollId, board.cardsUsed)
      render()
    },
    onCardStatus,
    /** Whether the panel should show (following live). */
    setVisible(next) { visible = Boolean(next); render() },
    slideChanged() {
      const id = slideId()
      if (id !== seenSlide) { seenSlide = id; if (editing) leaveEdit(); sheetCard = null; say(null) }
      render()
    },
    /** The socket came up or went down: the offline line follows, and cards waiting in the queue are listed. */
    connectionChanged() {
      const waiting = options.pendingCards ? options.pendingCards().length : 0
      if (waiting && offlineNote()) say(offlineNote())
      else if (note && note.tone === 'offline') say(null)
      render()
    },
    /** Draw again from what the panel holds (the page resized, or the speaker's switches changed). */
    refresh() { render() },
    /** Whether the person is on a live board slide and the panel is showing. */
    isActive() { return active },
    end() {
      sessionId = ''; polls.clear(); pollBySlide.clear(); owned.clear(); used.clear(); pending.clear(); chosen.clear(); drafts.clear()
      editing = null; sheetCard = null; note = null; boxKey = null; visible = false
      if (els) els.text.value = ''
      render()
    },
  }
}

export function audienceBoardRuntimeSource() {
  return audienceBoardModelSource() + '\n' + createAudienceBoard.toString()
}
