// Ask the speaker, on the published audience page (ADR-0027 and its 2026-09-29 amendment; ticket
// "Anyone can ask the speaker a question from phone or laptop"). Two seams, each a function the page
// runtime embeds by `.toString()` (see audienceAskRuntimeSource), so every function here is
// self-contained: no module-level constants, no imports.
//
//  - askRefusal(error)             pure: the plain sentence for a refusal, and whether Try again applies
//  - createAudienceAsk(options)    the question box: a sheet over the phone page, a centred dialog on a
//                                  laptop, the draft kept per slide, the name kept on the device, and
//                                  the A key
//
// Sending is not here: the follow client owns the socket and the offline queue
// (createAudienceFollowClient.sendQuestion in live-follow.js, the same first-in first-out queue as
// reactions); the box hands it `{text, name, slideId, tMs, submissionId?}` and hears back through
// onQuestionStatus. Question text and names are untrusted: this file writes them with textContent
// only, never as HTML.

/**
 * The sentence shown for a refused or unanswered question, and whether "Try again" makes sense.
 * A question refused while paused, over a limit or malformed stored nothing (see worker/README.md);
 * the client drops it from its queue, so a retry is a deliberate new send by the person.
 * @param {string | undefined} error
 * @returns {{ text: string, retry: boolean }}
 */
export function askRefusal(error) {
  if (error === 'questions_paused') return { text: 'The speaker is not taking questions right now. Your text is kept; try again if they turn questions back on.', retry: true }
  if (error === 'participant_limit_reached') return { text: 'You have sent the most questions allowed for this talk.', retry: false }
  if (error === 'question_limit_reached' || error === 'reaction_limit_reached') return { text: 'This talk has reached the most questions it can take.', retry: false }
  if (error === 'question_too_long') return { text: 'That question is too long. Shorten it to 500 characters or fewer.', retry: false }
  if (error === 'empty_question') return { text: 'Type a question first.', retry: false }
  if (error === 'not_kept') return { text: 'Could not keep your question on this device. Copy it, then try again.', retry: true }
  if (error === 'ended') return { text: 'The live session has ended, so the speaker can no longer receive questions.', retry: true }
  if (error === 'no_answer' || error === 'protocol_error') return { text: 'The live session did not answer. Your text is kept; try again.', retry: true }
  return { text: 'The question could not be sent. Your text is kept; try again.', retry: true }
}

/**
 * The question box. Options: document, storage, nameKey (the device's remembered name, shared with
 * the page's own name field), nameField (that field's input element, kept in step), isPhone(),
 * isConnected(), getSlideId() → the slide the person is on, getSlideInfo(id) → { number, title },
 * isAvailable() → whether Ask is offered right now, isBlocked() → whether another overlay owns the
 * keyboard, sendQuestion(input) → submissionId | false, notify(note, ms), now(),
 * onQuestionKept(record) → called once a question is confirmed, with { submissionId, slideId, text, name, at }
 * (the page keeps it on this device for My Notes), onNoteQuestion(receipt) → true when a note owns
 * the question (sent through sendNote), so the box neither shows nor logs it.
 * The same sheet is the phone's note sheet (openNote, from the bar's Note button): onSlideNote({ slideId, words, send })
 * → { sent: false | 'queued' | 'failed' } keeps the note on this device (page-side) and, when `send`, sends it as a
 * question through sendNote; the sheet says nothing more than the bar's line (notify) and closes.
 * @param {any} options
 */
export function createAudienceAsk(options) {
  const document = options.document
  const win = document.defaultView || (typeof window !== 'undefined' ? window : null)
  const icons = options.icons || {}
  const storage = options.storage || null
  const now = options.now || (() => Date.now())
  const MAX = 500
  const NAME_MAX = 60
  const drafts = new Map() // slideId → the text typed and not yet sent (this page only, never stored)
  const pending = new Map() // submissionId → { slideId, text, name } for a question in the queue
  let view = null // { slideId, text, name, remembered, state, error, retry, submissionId, copied }
  let scrim = null
  let panel = null
  let opener = null
  let viewportSync = null
  const noteDrafts = new Map() // slideId → the note typed and not yet saved (this page only, never stored)
  let noteView = null // the note sheet: { slideId, text, ticked, name, remembered }

  const phone = () => Boolean(options.isPhone && options.isPhone())
  const device = () => (phone() ? 'phone' : 'device')
  const svg = (name) => '<svg class="lucide lucide-' + name + '" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || '') + '</svg>'
  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  function withIcon(node, name, before) {
    const holder = el('span', 'ask-ico')
    holder.innerHTML = svg(name)
    if (before) node.insertBefore(holder, node.firstChild)
    else node.appendChild(holder)
    return node
  }
  function button(cls, label, act, icon) {
    const node = el('button', cls)
    node.type = 'button'
    node.setAttribute('data-act', act)
    if (icon) withIcon(node, icon, true)
    node.appendChild(document.createTextNode(label))
    return node
  }
  const readName = () => {
    try { return String((storage && storage.getItem(options.nameKey)) || '').slice(0, NAME_MAX) } catch { return '' }
  }
  function writeName(value) {
    try { if (storage) storage.setItem(options.nameKey, value) } catch { /* full or blocked: the name lives for this page */ }
    const field = options.nameField
    if (field && field.value !== value) field.value = value
  }
  const isOpen = () => Boolean(panel)
  const shownState = () => (view && view.state === 'sending' && options.isConnected && !options.isConnected() ? 'offline' : view ? view.state : 'compose')

  function freshView(slideId) {
    const name = readName()
    return { slideId, text: drafts.get(slideId) || '', name, remembered: Boolean(name), state: 'compose', error: '', retry: true, submissionId: '', copied: false }
  }

  const questionsOpen = () => Boolean(options.isAvailable && options.isAvailable())

  function renderNote() {
    const info = (options.getSlideInfo && options.getSlideInfo(noteView.slideId)) || {}
    const previous = panel.querySelector('.ask-text')
    if (previous) noteView.text = previous.value
    const previousName = panel.querySelector('.ask-name')
    if (previousName) noteView.name = previousName.value.trim().slice(0, NAME_MAX)
    const open = questionsOpen()
    const send = noteView.ticked && open
    panel.textContent = ''
    panel.classList.add('mn-sheet')
    panel.setAttribute('data-state', 'note')
    panel.setAttribute('aria-labelledby', 'askTitle')
    panel.appendChild(el('div', 'ask-grip'))
    const head = el('div', 'ask-head')
    const title = el('h2', '', 'Note on slide ' + (info.number || ''))
    title.id = 'askTitle'
    const close = el('button', 'ask-x')
    close.type = 'button'
    close.setAttribute('data-act', 'close')
    close.setAttribute('aria-label', 'Close')
    close.innerHTML = svg('x')
    head.append(title, close)
    panel.appendChild(head)

    const body = el('div', 'ask-body')
    const about = el('div', 'ask-about')
    about.innerHTML = svg('pen-line')
    about.append(el('span', 'num', 'Slide ' + (info.number || '')), el('span', 'ttl', info.title || ''))
    const label = el('label', 'ask-label', 'Your note')
    label.setAttribute('for', 'askText')
    const text = el('textarea', 'ask-text')
    text.id = 'askText'
    text.setAttribute('placeholder', 'Write your note')
    text.setAttribute('maxlength', String(MAX))
    text.value = noteView.text
    body.append(about, label, text)
    if (open) {
      const tick = el('button', 'mn-tick')
      tick.type = 'button'
      tick.setAttribute('role', 'checkbox')
      tick.setAttribute('aria-checked', noteView.ticked ? 'true' : 'false')
      tick.setAttribute('data-act', 'tick')
      const box = el('span', 'box')
      box.innerHTML = svg('check')
      tick.append(box, el('span', '', 'Also send to the speaker as a question'))
      body.appendChild(tick)
    } else {
      const paused = el('p', 'mn-paused')
      paused.innerHTML = svg('pause')
      paused.appendChild(el('span', '', 'The speaker is not taking questions right now.'))
      body.appendChild(paused)
    }
    if (send) {
      const nameRow = el('div', 'ask-name-row')
      const nameLabel = el('label', 'ask-label', 'Your name (optional)')
      nameLabel.setAttribute('for', 'askName')
      const name = el('input', 'ask-name')
      name.id = 'askName'
      name.type = 'text'
      name.setAttribute('autocomplete', 'name')
      name.setAttribute('maxlength', String(NAME_MAX))
      name.setAttribute('placeholder', 'Leave empty to ask without a name')
      name.value = noteView.name
      nameRow.append(nameLabel, name)
      if (noteView.remembered && noteView.name) {
        const remembered = el('div', 'ask-remembered')
        remembered.innerHTML = svg('check')
        remembered.appendChild(document.createTextNode('Remembered on this ' + device() + ' from your last question'))
        nameRow.appendChild(remembered)
      }
      body.appendChild(nameRow)
    }
    const fine = el('div', 'mn-fine')
    fine.innerHTML = svg('eye-off')
    fine.appendChild(el('span', '', send
      ? 'The speaker sees this note, your name if you give one, and slide ' + (info.number || '') + '. Nobody else does.'
      : 'Saved on this ' + device() + '. Nothing leaves it.'))
    body.appendChild(fine)
    const foot = el('div', 'ask-foot')
    const save = button('ask-send', send ? 'Save and send to the speaker' : 'Save note', 'save-note', send ? 'send-horizontal' : 'check')
    save.disabled = !text.value.trim()
    foot.appendChild(save)
    panel.append(body, foot)
    syncInset()
  }

  function render() {
    if (!panel) return
    if (noteView) { renderNote(); return }
    if (!view) return
    const state = shownState()
    const info = (options.getSlideInfo && options.getSlideInfo(view.slideId)) || {}
    const previous = panel.querySelector('.ask-text')
    if (previous) view.text = previous.value
    const previousName = panel.querySelector('.ask-name')
    if (previousName) view.name = previousName.value.trim().slice(0, NAME_MAX)
    panel.textContent = ''
    panel.setAttribute('data-state', state)

    panel.appendChild(el('div', 'ask-grip'))
    const head = el('div', 'ask-head')
    const title = el('h2', '', 'Ask the speaker')
    title.id = 'askTitle'
    const close = el('button', 'ask-x')
    close.type = 'button'
    close.setAttribute('data-act', 'close')
    close.setAttribute('aria-label', 'Close')
    close.innerHTML = svg('x')
    head.append(title, close)
    panel.appendChild(head)

    const body = el('div', 'ask-body')
    const foot = el('div', 'ask-foot')
    const about = el('div', 'ask-about')
    about.innerHTML = svg('message-circle-question-mark')
    about.append(el('span', 'num', 'Slide ' + (info.number || '')), el('span', 'ttl', info.title || ''))

    if (state === 'sent') {
      const mark = el('div', 'ask-sent-mark')
      mark.innerHTML = svg('circle-check')
      mark.appendChild(el('span', '', 'Sent to the speaker'))
      const quote = el('p', 'ask-quote', view.text)
      const meta = el('p', 'ask-meta')
      meta.appendChild(document.createTextNode('About slide ' + (info.number || '') + (info.title ? ' · ' + info.title : '') + (view.name ? ' · from ' + view.name : ' · no name')))
      meta.appendChild(document.createElement('br'))
      meta.appendChild(document.createTextNode('Only the speaker sees it.'))
      body.append(mark, quote, meta)
      foot.append(button('ask-secondary', 'Ask another', 'another', 'message-circle-question-mark'), button('ask-send', 'Done', 'done'))
    } else {
      body.appendChild(about)
      if (state === 'offline') {
        const banner = el('div', 'ask-banner offline')
        banner.setAttribute('role', 'status')
        banner.innerHTML = svg('wifi-off')
        const words = el('span')
        words.append(el('b', '', 'Not sent yet'), document.createTextNode('Your ' + (phone() ? 'phone' : 'browser') + ' is offline. The question will send when it reconnects; you can close this.'))
        banner.appendChild(words)
        body.appendChild(banner)
      } else if (state === 'failed') {
        const banner = el('div', 'ask-banner failed')
        banner.setAttribute('role', 'alert')
        banner.innerHTML = svg('circle-x')
        const words = el('span')
        words.append(el('b', '', 'Could not send'), document.createTextNode(askRefusal(view.error).text))
        banner.appendChild(words)
        body.appendChild(banner)
      }
      const label = el('label', 'ask-label', 'Your question')
      label.setAttribute('for', 'askText')
      const text = el('textarea', 'ask-text')
      text.id = 'askText'
      text.setAttribute('placeholder', 'Type your question')
      text.setAttribute('maxlength', String(MAX))
      text.value = view.text
      if (state === 'sending' || state === 'offline') text.readOnly = true
      const count = el('div', 'ask-count')
      const nameRow = el('div', 'ask-name-row')
      const nameLabel = el('label', 'ask-label', 'Your name (optional)')
      nameLabel.setAttribute('for', 'askName')
      const name = el('input', 'ask-name')
      name.id = 'askName'
      name.type = 'text'
      name.setAttribute('autocomplete', 'name')
      name.setAttribute('maxlength', String(NAME_MAX))
      name.setAttribute('placeholder', 'Leave empty to ask without a name')
      name.value = view.name
      if (state === 'sending' || state === 'offline') name.readOnly = true
      nameRow.append(nameLabel, name)
      if (view.remembered && state === 'compose') {
        const remembered = el('div', 'ask-remembered')
        remembered.innerHTML = svg('check')
        remembered.appendChild(document.createTextNode('Remembered on this ' + device() + ' from your last question'))
        nameRow.appendChild(remembered)
      }
      const priv = el('div', 'ask-private')
      priv.innerHTML = svg('eye-off')
      priv.appendChild(el('span', '', 'Only the speaker sees this. Nobody else in the room does.'))
      body.append(label, text, count, nameRow, priv)

      const mac = Boolean(win && win.navigator && /Mac|iPhone|iPad/.test(String(win.navigator.platform || win.navigator.userAgent || '')))
      const hint = el('span', 'ask-hint')
      hint.innerHTML = '<kbd></kbd> sends · <kbd>Esc</kbd> closes'
      hint.firstChild.textContent = mac ? '⌘ ↵' : 'Ctrl ↵'
      if (state === 'offline') {
        foot.append(button('ask-secondary ask-close-btn', 'Close', 'close'))
        const waiting = button('ask-send', 'Waiting to send…', 'waiting', 'loader-circle')
        waiting.disabled = true
        foot.appendChild(waiting)
      } else if (state === 'sending') {
        const sending = button('ask-send', 'Sending…', 'waiting', 'loader-circle')
        sending.disabled = true
        foot.appendChild(sending)
      } else if (state === 'failed') {
        foot.append(hint, button('ask-secondary', view.copied ? 'Copied' : 'Copy question', 'copy', 'copy'))
        if (view.retry) foot.appendChild(button('ask-send', 'Try again', 'send', 'refresh-cw'))
      } else {
        const send = button('ask-send', 'Send', 'send', 'send-horizontal')
        send.disabled = !text.value.trim()
        foot.append(hint, send)
      }
      updateCount(text, count)
    }
    panel.append(body, foot)
    syncInset()
  }

  function updateCount(text, count) {
    const length = text.value.length
    count.textContent = length >= 400 ? length + ' / ' + MAX : ''
  }

  function focusFirst() {
    if (!panel) return
    if (noteView) {
      const field = panel.querySelector('.ask-text')
      if (field && field.focus) field.focus({ preventScroll: true })
      if (field && field.setSelectionRange) field.setSelectionRange(field.value.length, field.value.length)
      return
    }
    const state = shownState()
    const target = state === 'sent' ? panel.querySelector('[data-act="another"]')
      : state === 'compose' || state === 'failed' ? panel.querySelector('.ask-text')
        : panel.querySelector('.ask-x')
    if (target && target.focus) target.focus({ preventScroll: true })
    if (target && target.classList.contains('ask-text') && target.setSelectionRange) target.setSelectionRange(target.value.length, target.value.length)
  }

  // On a phone the on-screen keyboard does not resize a fixed sheet (iOS Safari, and Android Chrome
  // by default, resize only the visual viewport), so the sheet's bottom inset is the gap between the
  // layout viewport's bottom and the visual viewport's bottom. A real-device check is owed.
  function syncInset() {
    if (!panel) return
    const viewport = win && win.visualViewport
    let inset = 0
    if (phone() && viewport) {
      const layoutHeight = document.documentElement.clientHeight || (win && win.innerHeight) || 0
      inset = Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
    }
    panel.style.setProperty('--kb', inset + 'px')
    panel.classList.toggle('kb-open', inset > 0)
  }

  function open() {
    if (panel) { focusFirst(); return }
    const slideId = String(options.getSlideId ? options.getSlideId() : '')
    if (!slideId) return
    if (!(view && ((view.slideId === slideId && (view.state === 'failed' || view.state === 'sending')) || (view.late && view.state === 'failed')))) view = freshView(slideId)
    mount()
  }

  /** The phone's note sheet for the slide the person is on (the bar's Note button). */
  function openNote() {
    if (panel) { focusFirst(); return }
    const slideId = String(options.getSlideId ? options.getSlideId() : '')
    if (!slideId) return
    const name = readName()
    noteView = { slideId, text: noteDrafts.get(slideId) || '', ticked: false, name, remembered: Boolean(name) }
    mount()
  }

  function mount() {
    opener = document.activeElement
    scrim = el('div', 'ask-scrim')
    panel = el('div', 'ask-panel')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-labelledby', 'askTitle')
    scrim.appendChild(panel)
    scrim.addEventListener('click', (event) => { if (event.target === scrim) close() })
    panel.addEventListener('click', onPanelClick)
    panel.addEventListener('input', onPanelInput)
    panel.addEventListener('keydown', onPanelKey)
    document.body.appendChild(scrim)
    if (document.body) document.body.classList.add('ask-open')
    viewportSync = () => syncInset()
    if (win && win.visualViewport) { win.visualViewport.addEventListener('resize', viewportSync); win.visualViewport.addEventListener('scroll', viewportSync) }
    if (win) win.addEventListener('resize', viewportSync)
    render()
    focusFirst()
  }

  // Closing keeps what was typed for this slide until it is sent (in this page only, not stored).
  function close() {
    if (!panel) return
    const text = panel.querySelector('.ask-text')
    if (noteView) {
      const typed = text ? text.value : noteView.text
      if (typed.trim()) noteDrafts.set(noteView.slideId, typed); else noteDrafts.delete(noteView.slideId)
    } else if (text && view) {
      view.text = text.value
      if (view.state === 'compose' || view.state === 'failed') { if (text.value.trim()) drafts.set(view.slideId, text.value); else drafts.delete(view.slideId) }
    }
    const nameField = panel.querySelector('.ask-name')
    if (nameField && view && !noteView) view.name = nameField.value
    const wasNote = Boolean(noteView)
    noteView = null
    panel.classList.remove('mn-sheet')
    if (!wasNote && view && (view.state === 'sent' || view.state === 'compose' || (view.late && view.state === 'failed'))) view = null
    if (win && win.visualViewport && viewportSync) { win.visualViewport.removeEventListener('resize', viewportSync); win.visualViewport.removeEventListener('scroll', viewportSync) }
    if (win && viewportSync) win.removeEventListener('resize', viewportSync)
    viewportSync = null
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim)
    scrim = null
    panel = null
    if (document.body) document.body.classList.remove('ask-open')
    // Focus goes back to the control that opened the box (Ask on the bar).
    const back = opener && opener.isConnected !== false && opener.focus ? opener : document.querySelector(wasNote ? '.rx-notebtn' : '.rx-ask')
    if (back && back.focus) back.focus({ preventScroll: true })
    opener = null
  }

  function send() {
    if (!panel || !view) return
    const text = panel.querySelector('.ask-text')
    const nameField = panel.querySelector('.ask-name')
    if (!text) return
    const body = text.value.trim()
    if (!body) return
    view.text = text.value
    view.name = nameField ? nameField.value.trim().slice(0, NAME_MAX) : view.name
    writeName(view.name)
    // A retry after silence keeps its submission id, so a question the worker already stored is
    // answered from its receipt; a refused one stored nothing, so its id is safe to reuse too.
    const id = options.sendQuestion({ text: body, name: view.name, slideId: view.slideId, tMs: now(), ...(view.submissionId ? { submissionId: view.submissionId } : {}) })
    if (id === false) {
      view.state = 'failed'; view.error = options.refusalReason ? options.refusalReason() : 'ended'; view.retry = true; view.submissionId = ''
      drafts.set(view.slideId, body)
      render(); focusFirst()
      return
    }
    view.submissionId = id
    view.state = 'sending'
    view.error = ''
    pending.set(id, { slideId: view.slideId, text: body, name: view.name })
    drafts.set(view.slideId, body)
    render()
    focusFirst()
  }

  /**
   * Send one question on behalf of a highlight's note (the popup on the laptop): the quote is folded into `text`
   * by the caller. Goes through the same queue as the box, under the device's remembered name. Returns the
   * submission id, or false when it cannot be kept (see refusalReason). The answer comes to options.onNoteQuestion.
   */
  function sendNote(input) {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || typeof input.slideId !== 'string') return false
    const name = readName()
    const id = options.sendQuestion({ text: input.text.trim(), name, slideId: input.slideId, tMs: now(), ...(input.submissionId ? { submissionId: input.submissionId } : {}) })
    if (id === false) return false
    pending.set(id, { slideId: input.slideId, text: input.text.trim(), name, note: true })
    return id
  }

  // Save the note on this device and, when ticked and the speaker is taking questions, send it as a question
  // (the page does both: onSlideNote). The bar's line says what happened; the sheet closes.
  function saveNote() {
    if (!panel || !noteView) return
    const text = panel.querySelector('.ask-text')
    const nameField = panel.querySelector('.ask-name')
    const words = (text ? text.value : noteView.text).trim()
    if (!words || !options.onSlideNote) return
    const wantsSend = noteView.ticked
    const send = wantsSend && questionsOpen()
    if (send) writeName((nameField ? nameField.value : noteView.name).trim().slice(0, NAME_MAX))
    const slideId = noteView.slideId
    noteDrafts.delete(slideId)
    noteView.text = ''
    const saved = options.onSlideNote({ slideId, words, send })
    close()
    if (!options.notify) return
    const here = 'Saved on this ' + device() + '.'
    if (send && saved && saved.sent === 'queued') options.notify({ tone: 'ok', icon: 'loader-circle', text: here + ' Sending to the speaker\u2026' }, 0)
    else if (send) options.notify({ tone: 'failed', icon: 'circle-x', text: here + ' Not sent to the speaker. Open My Notes to try again.' }, 8000)
    else if (wantsSend) options.notify({ tone: 'paused', icon: 'pause', text: here + ' Not sent: the speaker is not taking questions right now.' }, 8000)
    else options.notify({ tone: 'ok', icon: 'circle-check', text: here }, 4000)
  }

  function onPanelClick(event) {
    const target = event.target && event.target.closest ? event.target.closest('[data-act]') : null
    if (!target || !panel.contains(target)) return
    const act = target.getAttribute('data-act')
    if (act === 'tick' && noteView) { noteView.ticked = !noteView.ticked; renderNote(); const again = panel.querySelector('[data-act="tick"]'); if (again && again.focus) again.focus({ preventScroll: true }) }
    else if (act === 'save-note') saveNote()
    else if (act === 'close' || act === 'done') close()
    else if (act === 'send') send()
    else if (act === 'another') { view = freshView(view.slideId); view.remembered = Boolean(view.name); render(); focusFirst() }
    else if (act === 'copy') {
      const text = view ? view.text : ''
      try { if (win && win.navigator && win.navigator.clipboard) win.navigator.clipboard.writeText(text) } catch { /* copying is a courtesy */ }
      view.copied = true
      render()
      const again = panel.querySelector('[data-act="copy"]')
      if (again && again.focus) again.focus({ preventScroll: true })
    }
  }

  function onPanelInput(event) {
    const text = event.target && event.target.classList && event.target.classList.contains('ask-text') ? event.target : null
    if (text) {
      const send = panel.querySelector('[data-act="send"], [data-act="save-note"]')
      if (send) send.disabled = !text.value.trim()
      const count = panel.querySelector('.ask-count')
      if (count) updateCount(text, count)
    }
    if (event.target && event.target.classList && event.target.classList.contains('ask-name')) writeName(event.target.value.trim().slice(0, NAME_MAX))
  }

  // The box owns the keyboard while it is open: nothing typed here reaches the page's deck keys.
  function onPanelKey(event) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (noteView) { const save = panel.querySelector('[data-act="save-note"]'); if (save && !save.disabled) saveNote(); return }
      if (panel.querySelector('[data-act="send"]') && !panel.querySelector('[data-act="send"]').disabled) send()
      return
    }
    if (event.key === 'Tab') {
      const stops = Array.from(panel.querySelectorAll('button, input, textarea')).filter((node) => !node.disabled && node.getClientRects().length > 0)
      if (!stops.length) return
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
  }

  /** The follow client's answer for one queued question: `{ submissionId, status, error?, item }`. */
  function onQuestionStatus(receipt) {
    // A question sent from a highlight's note belongs to that note, not to this box: the page hears it
    // (options.onNoteQuestion(receipt) → true when a note owns the submission) and nothing is logged twice.
    if (options.onNoteQuestion && options.onNoteQuestion(receipt)) { pending.delete(receipt.submissionId); return }
    // A result with no entry in memory (after a reload, or a question another tab sent) still carries
    // its item from the stored queue: text, name and slide.
    const stored = receipt.item && receipt.item.kind === 'question' ? { slideId: receipt.item.slideId, text: receipt.item.text, name: receipt.item.name || '' } : null
    const info = pending.get(receipt.submissionId) || stored
    const late = !pending.has(receipt.submissionId)
    pending.delete(receipt.submissionId)
    if (!info) return
    // A confirmed question is kept on this device for My Notes, whether or not anyone is watching the box.
    if (receipt.status === 'confirmed' && options.onQuestionKept) {
      options.onQuestionKept({ submissionId: receipt.submissionId, slideId: info.slideId, text: info.text, name: info.name || '', at: new Date(now()).toISOString() })
    }
    // A confirmation nobody was waiting for needs nothing shown.
    if (late && receipt.status === 'confirmed') return
    const mine = Boolean(view && view.submissionId === receipt.submissionId)
    if (receipt.status === 'confirmed') {
      drafts.delete(info.slideId)
      if (mine) { view.state = 'sent'; view.submissionId = ''; view.text = info.text; view.name = info.name; if (panel) { render(); focusFirst() } else view = null }
      if (!panel && options.notify) options.notify({ tone: 'ok', icon: 'circle-check', text: phone() ? 'Question sent to the speaker. Only they see it.' : 'Question sent to the speaker' }, 5000)
      return
    }
    // Refused or unanswered: nothing was stored, the text is kept for this slide, and the person is
    // told plainly. A refusal is shown once; nothing here retries by itself.
    const refusal = askRefusal(receipt.error)
    drafts.set(info.slideId, info.text)
    // A box already open on another slide is not taken over: its typing stays, and the bar says so.
    if (!mine && panel) {
      if (options.notify) options.notify({ tone: 'failed', icon: 'circle-x', text: 'A question you sent earlier was not sent. Open Ask afterwards to see why.' }, 8000)
      return
    }
    if (!mine) view = { slideId: info.slideId, text: info.text, name: info.name, remembered: false, state: 'compose', error: '', retry: true, submissionId: '', copied: false, late }
    view.state = 'failed'; view.error = receipt.error || ''; view.retry = refusal.retry
    // A stored id is only worth reusing when the worker may have stored the question.
    view.submissionId = receipt.error === 'no_answer' || receipt.error === 'protocol_error' ? receipt.submissionId : ''
    if (panel) { render(); focusFirst() }
    else if (options.notify) options.notify({ tone: 'failed', icon: 'circle-x', text: (phone() ? 'Your question was not sent. Tap Ask to see why.' : 'Your question was not sent. Open Ask to see why.') }, 8000)
  }

  // A (no Cmd, Ctrl, Alt or Shift; not in a text field) opens Ask when it is offered on this page.
  function onWindowKey(event) {
    if (event.defaultPrevented || event.repeat) return
    if (event.key !== 'a' && event.key !== 'A') return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const target = event.target
    const tag = target && target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
    if (panel || !options.isAvailable || !options.isAvailable()) return
    if (options.isBlocked && options.isBlocked()) return
    event.preventDefault()
    open()
  }
  if (win) win.addEventListener('keydown', onWindowKey)

  return {
    open,
    openNote,
    close,
    isOpen,
    onQuestionStatus,
    sendNote,
    /** Why the last send returned false ('ended' or 'not_kept'). */
    refusalReason: () => (options.refusalReason ? options.refusalReason() : 'ended'),
    /** The speaker's switches changed: an open note sheet gains or loses its tick. */
    refresh() { if (noteView && panel) render() },
    /** The connection changed: a question waiting to send says so, or goes when it reconnects. */
    connectionChanged() { if (panel) { const focused = document.activeElement; render(); if (focused && focused.isConnected === false) focusFirst() } },
    /** The talk ended: an open box stays so the text is not lost; a send then says the session has ended. */
    end() { for (const [id, info] of Array.from(pending)) if (info.note && options.onNoteQuestion) options.onNoteQuestion({ submissionId: id, status: 'failed', error: 'ended' }); pending.clear(); if (view && view.state === 'sending') { view.state = 'failed'; view.error = 'ended'; view.retry = true; view.submissionId = ''; if (panel) render() } else if (noteView && panel) render() },
    /** The text typed and not sent for a slide (for tests). */
    draftFor(slideId) { return drafts.get(slideId) || '' },
  }
}

/** The question box's look: a bottom sheet at 699px and below (the page's own breakpoint), a centred dialog above. */
export const audienceAskStyles = `
.ask-scrim{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:24px 16px;background:#17202a66}
.ask-panel{box-sizing:border-box;display:flex;flex-direction:column;width:min(520px,100%);max-height:calc(100dvh - 48px);background:#fff;border:1px solid #e7e3d5;border-radius:14px;box-shadow:0 18px 54px #0004;padding:20px 24px 22px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17202a}
.ask-panel svg{flex:none}
.ask-panel button:focus-visible,.ask-panel input:focus-visible,.ask-panel textarea:focus-visible{outline:3px solid #0f4bd8;outline-offset:2px}
.ask-panel textarea:focus-visible,.ask-panel input:focus-visible{outline-offset:0}
.ask-grip{display:none}
.ask-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.ask-head h2{margin:0;font-size:20px;letter-spacing:-.01em}
.ask-x{width:36px;height:36px;margin-right:-8px;border:0;border-radius:8px;background:transparent;color:#5b6572;display:flex;align-items:center;justify-content:center;cursor:pointer}
.ask-x:hover{background:#f0efe8}
.ask-x svg{width:20px;height:20px}
.ask-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.ask-about{display:flex;align-items:center;gap:8px;margin:0 0 14px;padding:8px 10px;border-radius:8px;background:#e8eefc;color:#17202a;font-size:14px;line-height:1.3}
.ask-about svg{width:18px;height:18px;color:#0f4bd8}
.ask-about .num{font-weight:700;color:#0f4bd8;white-space:nowrap}
.ask-about .ttl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ask-label{display:block;margin:0 0 5px;font-size:13px;font-weight:700;color:#3d4753}
.ask-text{display:block;box-sizing:border-box;width:100%;min-height:112px;resize:none;border:1px solid #c9ccd2;border-radius:10px;background:#fff;color:#17202a;padding:10px 12px;font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.ask-text[readonly],.ask-name[readonly]{background:#f6f5ef;color:#3d4753}
.ask-count{min-height:0;margin-top:3px;text-align:right;font-size:12.5px;color:#5b6572}
.ask-count:empty{display:none}
.ask-name-row{margin-top:14px}
.ask-name{display:block;box-sizing:border-box;width:100%;height:40px;border:1px solid #c9ccd2;border-radius:10px;background:#fff;color:#17202a;padding:0 12px;font:15px system-ui,-apple-system,"Segoe UI",sans-serif}
.ask-remembered{display:flex;align-items:center;gap:5px;margin-top:5px;font-size:12.5px;color:#5b6572}
.ask-remembered svg{width:14px;height:14px}
.ask-private{display:flex;align-items:center;gap:8px;margin:14px 0 16px;font-size:14px;color:#3d4753}
.ask-private svg{width:18px;height:18px}
.ask-foot{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px}
.ask-foot .ask-hint{margin-right:auto;font-size:12.5px;color:#5b6572}
.ask-foot .ask-hint kbd{padding:1px 6px;border:1px solid #c9ccd2;border-radius:4px;background:#f7f6f1;font:600 12px/1.3 ui-monospace,Menlo,monospace;color:#3d4753}
.ask-send,.ask-secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 18px;border-radius:9px;font:700 15px system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
.ask-send{border:0;background:#0f4bd8;color:#fff}
.ask-send svg{width:18px;height:18px}
.ask-send[disabled]{background:#c9d3e8;color:#33415c;cursor:default}
.ask-secondary{border:1px solid #c9ccd2;background:#fff;color:#17202a}
.ask-secondary svg{width:18px;height:18px}
.ask-ico{display:inline-flex}
.mn-tick{appearance:none;display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;min-height:52px;margin:12px 0 0;padding:4px 12px;border:1px solid #c9ccd2;border-radius:10px;background:#fff;color:#17202a;font:500 16px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left;cursor:pointer}
.mn-tick .box{flex:none;width:24px;height:24px;box-sizing:border-box;border:2px solid #7b8494;border-radius:6px;background:#fff;display:flex;align-items:center;justify-content:center}
.mn-tick .box svg{width:16px;height:16px;color:#fff;stroke-width:3;display:none}
.mn-tick[aria-checked="true"]{border-color:#0f4bd8;background:#f3f6fd}
.mn-tick[aria-checked="true"] .box{background:#0f4bd8;border-color:#0f4bd8}
.mn-tick[aria-checked="true"] .box svg{display:block}
.mn-paused{display:flex;align-items:flex-start;gap:8px;margin:12px 0 0;font-size:14px;line-height:1.35;color:#5b6572}
.mn-paused svg{width:18px;height:18px;margin-top:1px}
.mn-fine{display:flex;align-items:flex-start;gap:8px;margin:12px 0 12px;font-size:14px;line-height:1.4;color:#3d4753}
.mn-fine svg{width:18px;height:18px;margin-top:1px}
.mn-sheet .ask-text{min-height:120px}
.ask-banner{display:flex;align-items:flex-start;gap:9px;margin:0 0 14px;padding:10px 12px;border-radius:10px;font-size:14px;line-height:1.35}
.ask-banner svg{width:19px;height:19px;margin-top:1px}
.ask-banner.offline{background:#fdf3dc;color:#7a4d06;border:1px solid #f1d9a0}
.ask-banner.failed{background:#fdecea;color:#8c2a20;border:1px solid #f3c3bc}
.ask-banner b{display:block}
.ask-sent-mark{display:flex;align-items:center;gap:10px;margin:2px 0 12px;font-size:18px;font-weight:700}
.ask-sent-mark svg{width:28px;height:28px;color:#15803d}
.ask-quote{margin:0 0 8px;padding:10px 12px;border-left:3px solid #0f4bd8;background:#fbfbf8;font-size:16px;line-height:1.45;border-radius:0 8px 8px 0;overflow-wrap:anywhere;white-space:pre-wrap}
.ask-meta{margin:0 0 18px;font-size:13px;color:#5b6572;overflow-wrap:anywhere}
.ask-panel[data-state="sending"] .ask-send svg,.ask-panel[data-state="offline"] .ask-send svg{animation:ask-spin 1.1s linear infinite}
@keyframes ask-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ask-panel[data-state="sending"] .ask-send svg,.ask-panel[data-state="offline"] .ask-send svg{animation:none}}
@media print{.ask-scrim{display:none!important}}

/* Phone: a sheet over the page. Its bottom inset is set from visualViewport so Send stays above the keyboard. */
@media (max-width:699px){
  .ask-scrim{display:block;padding:0;background:#0b111766}
  .ask-panel{position:fixed;left:0;right:0;bottom:var(--kb,0px);z-index:91;width:auto;max-height:calc(100% - var(--kb,0px) - 8px);border:0;border-radius:16px 16px 0 0;box-shadow:0 -12px 32px #0003;padding:8px 16px 18px;background:#fdfdfb}
  .ask-panel:not(.kb-open){padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}
  .ask-panel.kb-open{padding-bottom:10px}
  .ask-grip{display:block;flex:none;width:38px;height:4px;border-radius:4px;background:#d5d2c9;margin:0 auto 8px}
  .ask-head{margin-bottom:0}
  .ask-head h2{font-size:18px}
  .ask-x{width:44px;height:44px;margin-right:-10px}
  .ask-x svg{width:22px;height:22px}
  .ask-text{min-height:104px;font-size:17px}
  .ask-name{height:44px;font-size:16px}
  .ask-private{margin:14px 0 12px}
  .ask-hint,.ask-close-btn{display:none!important}
  .ask-foot{gap:8px}
  .ask-foot>*{flex:1 1 0}
  .ask-send,.ask-secondary{height:50px;font-size:16px}
  .ask-panel.kb-open .ask-body{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent);padding-bottom:10px}
}
`

export function audienceAskRuntimeSource() {
  return [askRefusal, createAudienceAsk].map((fn) => fn.toString()).join('\n')
}
