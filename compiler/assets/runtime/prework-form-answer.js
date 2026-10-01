// The answer controls of a pre-work step that has a poll (feedback-boards ticket 10; drawings W6, W9, L5):
// options to tap for single, multiple and ranking, a label per item for rating and categorisation, and a
// text box for an open question. What the person has chosen is `draft`; `preworkAnswerReady` (the
// Worker's own rule) decides when it is complete, and the form is told to save through `commit`.
// Self-contained like every runtime function the page embeds by `.toString()` (see prework-form.js).
// Option labels and typed text are untrusted: written with textContent, never as HTML.

/**
 * Options: document, step, draft() → the draft, set(value), commit() (a choice is complete enough to
 * save), typing(text) (an open answer changed; the form debounces the save), blur() (the text box lost
 * focus: save now), clear() (the draft was reset).
 * @param {any} ctx
 */
export function createPreworkAnswerControls(ctx) {
  const document = ctx.document
  const step = ctx.step
  const poll = step.poll
  function make(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = String(text)
    return node
  }
  const box = make('div', 'pw-answer')
  box.dataset.type = poll.type
  if (poll.type === 'open') {
    const text = document.createElement('textarea')
    text.className = 'pw-text'
    text.rows = 4
    text.maxLength = 1000
    text.setAttribute('aria-label', step.title || 'Your answer')
    const held = ctx.draft()
    text.value = typeof held === 'string' ? held : ''
    text.addEventListener('input', () => { ctx.set(text.value); ctx.typing(text.value) })
    text.addEventListener('blur', () => ctx.blur())
    box.appendChild(text)
    return box
  }
  const paint = () => {
    const current = ctx.draft()
    for (const node of Array.from(box.querySelectorAll('[data-option]'))) {
      const id = node.dataset.option
      let on = false
      if (poll.type === 'single') on = current === id
      else if (poll.type === 'multiple') on = Array.isArray(current) && current.includes(id)
      else if (poll.type === 'ranking') {
        const at = Array.isArray(current) ? current.indexOf(id) : -1
        on = at >= 0
        const mark = node.querySelector('.pw-mark')
        if (mark) mark.textContent = on ? String(at + 1) : ''
      }
      node.setAttribute('aria-checked', on ? 'true' : 'false')
      node.classList.toggle('is-on', on)
    }
    const map = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
    for (const node of Array.from(box.querySelectorAll('[data-row]'))) {
      const on = map[node.dataset.row] === node.dataset.label
      node.setAttribute('aria-checked', on ? 'true' : 'false')
      node.classList.toggle('is-on', on)
    }
  }
  if (poll.type === 'single' || poll.type === 'multiple' || poll.type === 'ranking') {
    box.setAttribute('role', poll.type === 'single' ? 'radiogroup' : 'group')
    for (const option of poll.options) {
      const node = make('button', 'pw-opt')
      node.type = 'button'
      node.setAttribute('role', poll.type === 'multiple' ? 'checkbox' : 'radio')
      node.dataset.option = option.optionId
      node.appendChild(make('span', 'pw-mark'))
      node.appendChild(make('span', 'pw-opt-label', option.label))
      node.addEventListener('click', () => {
        const id = option.optionId
        const current = ctx.draft()
        if (poll.type === 'single') ctx.set(id)
        else {
          const list = Array.isArray(current) ? current.slice() : []
          const at = list.indexOf(id)
          const most = poll.type === 'multiple' ? (poll.maxSelections || poll.options.length) : (poll.rankCount || poll.options.length)
          if (at >= 0) list.splice(at, 1)
          else if (list.length < most) list.push(id)
          ctx.set(list)
        }
        paint()
        ctx.commit()
      })
      box.appendChild(node)
    }
    if (poll.type === 'ranking') {
      const again = make('button', 'pw-link pw-restart', 'Start again')
      again.type = 'button'
      again.addEventListener('click', () => { ctx.set([]); paint(); ctx.clear() })
      box.appendChild(again)
    }
  } else {
    for (const option of poll.options) {
      const row = make('div', 'pw-rate')
      row.appendChild(make('p', 'pw-rate-label', option.label))
      const labels = make('div', 'pw-rate-labels')
      labels.setAttribute('role', 'radiogroup')
      labels.setAttribute('aria-label', option.label)
      for (const label of poll.labels || []) {
        const node = make('button', 'pw-opt pw-opt-small')
        node.type = 'button'
        node.setAttribute('role', 'radio')
        node.dataset.row = option.optionId
        node.dataset.label = label.optionId
        node.appendChild(make('span', 'pw-opt-label', label.label))
        node.addEventListener('click', () => {
          const current = ctx.draft()
          const map = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
          map[option.optionId] = label.optionId
          ctx.set(map)
          paint()
          ctx.commit()
        })
        labels.appendChild(node)
      }
      row.appendChild(labels)
      box.appendChild(row)
    }
  }
  paint()
  return box
}

export function preworkAnswerControlsSource() {
  return createPreworkAnswerControls.toString()
}
