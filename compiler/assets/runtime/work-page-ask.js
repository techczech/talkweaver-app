// "Ask about this step" and what a person has asked (work-files ticket 15; mockup section 13): the laptop's
// column, the phone's sheet, the person's own questions and the done note. Kept apart from work-page.js,
// which hands it the page's state through `ctx`. Self-contained like every runtime function the page embeds
// by `.toString()`. Every text is written with textContent.
import { preworkDay } from './prework-form-model.js'

/**
 * ctx: document, el(tag, cls, text), icon(name), button(cls, label, icon, onClick), words (workPageWords),
 * asks (Map of what is typed and not sent), entries(), now(), zone, els() (the screen's live elements),
 * sheet(), setSheet(value), closeSheet(), render(focus), sendQuestion(step, text, name, then, failed), stepIndex(id).
 * @param {any} ctx
 */
export function createWorkPageAsk(ctx) {
  const document = ctx.document
  const el = ctx.el
  const icon = ctx.icon
  const button = ctx.button
  const words = ctx.words
  const asks = ctx.asks
  function questionCards(row) {
    return row.questions.map((q) => {
      const card = el('div', 'wp-yourq')
      card.dataset.wpQuestion = '1'
      const head = el('p', 'wp-yourq-head')
      head.appendChild(icon('message-circle-question-mark'))
      head.appendChild(el('span', '', 'Your question'))
      card.appendChild(head)
      card.appendChild(el('p', 'wp-yourq-text', q.text || ''))
      card.appendChild(el('p', 'wp-small', 'With the speaker' + (q.name ? ' \u00b7 ' + q.name : '')))
      return card
    })
  }
  function doneNote(row) {
    if (!row.done) return null
    const entry = ctx.entries().find((item) => item.ref === 'done:' + row.step.id)
    const box = el('div', 'wp-donenote')
    box.setAttribute('role', 'status')
    box.appendChild(el('p', 'wp-donenote-head', 'Done \u00b7 marked ' + preworkDay(entry ? entry.at : ctx.now(), ctx.zone)))
    box.appendChild(el('p', 'wp-small', 'The speaker sees how many people have done each task, not who.'))
    return box
  }
  function askFields(step, compact) {
    const held = asks.get(step.id) || { text: '', name: '' }
    const text = document.createElement('textarea')
    text.className = 'wp-asktext'
    text.rows = compact ? 4 : 3
    text.maxLength = 500
    text.placeholder = 'Your question'
    text.setAttribute('aria-label', 'Your question')
    text.value = held.text
    const name = document.createElement('input')
    name.className = 'wp-name'
    name.type = 'text'
    name.maxLength = 60
    name.placeholder = 'Your name (optional)'
    name.autocomplete = 'off'
    name.setAttribute('aria-label', 'Your name (optional)')
    name.value = held.name
    const send = button('wp-btn is-primary wp-send', 'Send', 'send', null)
    send.disabled = !text.value.trim()
    const keep = () => { asks.set(step.id, { text: text.value, name: name.value }); send.disabled = !text.value.trim() }
    text.addEventListener('input', keep)
    name.addEventListener('input', keep)
    return { text, name, send }
  }
  function askColumn(step, row) {
    const col = el('aside', 'wp-askcol')
    col.appendChild(el('h2', 'wp-ask-title', 'Ask about this step'))
    if (!step.questions) {
      col.appendChild(el('p', 'wp-small', 'Questions are off for this step.'))
      return col
    }
    if (row.questions.length === 0) col.appendChild(el('p', 'wp-small', words.askHint))
    for (const card of questionCards(row)) col.appendChild(card)
    const done = doneNote(row)
    if (done) col.appendChild(done)
    const fields = askFields(step, false)
    fields.send.addEventListener('click', () => {
      fields.send.disabled = true
      ctx.sendQuestion(step, fields.text.value, fields.name.value, () => { asks.delete(step.id); ctx.render('.wp-asktext') }, () => { fields.send.disabled = !fields.text.value.trim() })
    })
    fields.text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !fields.send.disabled) { event.preventDefault(); fields.send.click() }
    })
    col.appendChild(fields.text)
    col.appendChild(fields.name)
    const line = el('div', 'wp-askline')
    line.appendChild(fields.send)
    col.appendChild(line)
    const sending = el('p', 'wp-small wp-askstatus')
    sending.hidden = true
    sending.setAttribute('role', 'status')
    ctx.els().askStatus = sending
    col.appendChild(sending)
    return col
  }
  function sheetView(step) {
    const wrap = el('div', 'wp-sheet-wrap')
    wrap.addEventListener('click', (event) => { if (event.target === wrap) ctx.closeSheet() })
    const panel = el('div', 'wp-sheet')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', 'Ask about this step')
    const head = el('div', 'wp-sheet-head')
    head.appendChild(el('h2', 'wp-ask-title', 'Ask about this step'))
    const x = button('wp-x', null, 'x', () => ctx.closeSheet())
    x.setAttribute('aria-label', 'Close')
    head.appendChild(x)
    panel.appendChild(head)
    if (ctx.sheet().phase === 'sent') {
      const ok = el('p', 'wp-sent')
      ok.appendChild(icon('circle-check'))
      ok.appendChild(el('span', '', 'Sent to the speaker'))
      panel.appendChild(ok)
      panel.appendChild(el('blockquote', 'wp-quote', ctx.sheet().sent.text || ''))
      panel.appendChild(el('p', 'wp-small', 'Only the speaker sees it.'))
      const actions = el('div', 'wp-sheet-actions')
      actions.appendChild(button('wp-btn', 'Ask another', 'message-circle-question-mark', () => { ctx.setSheet({ stepId: step.id, phase: 'compose' }); ctx.render('.wp-sheet textarea') }))
      actions.appendChild(button('wp-btn is-primary', 'Done', null, () => ctx.closeSheet()))
      panel.appendChild(actions)
    } else {
      panel.appendChild(el('p', 'wp-small', 'Step ' + (ctx.stepIndex(step.id) + 1) + ' \u00b7 ' + step.title))
      const fields = askFields(step, true)
      fields.send.classList.add('is-wide')
      fields.send.addEventListener('click', () => {
        fields.send.disabled = true
        ctx.sendQuestion(step, fields.text.value, fields.name.value, (entry) => {
          const open = ctx.sheet(); if (open && open.stepId === step.id) { ctx.setSheet({ stepId: step.id, phase: 'sent', sent: { text: entry.text } }); ctx.render('.wp-sheet .is-primary') }
        }, () => { fields.send.disabled = !fields.text.value.trim() })
      })
      panel.appendChild(fields.text)
      panel.appendChild(fields.name)
      panel.appendChild(el('p', 'wp-small', 'Only the speaker sees this. Nobody else in the room does.'))
      panel.appendChild(fields.send)
      const sending = el('p', 'wp-small wp-askstatus')
      sending.hidden = true
      sending.setAttribute('role', 'status')
      ctx.els().askStatus = sending
      panel.appendChild(sending)
    }
    wrap.appendChild(panel)
    return wrap
  }
  return { questionCards, doneNote, askColumn, sheetView }
}

export function workPageAskSource() {
  return createWorkPageAsk.toString()
}
