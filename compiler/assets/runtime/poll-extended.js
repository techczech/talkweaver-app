/** Extended ballot controls. This module has no connection or submission side effects. */
export function extendedPollEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

export function isExtendedPoll(type) {
  return type === 'ranking' || type === 'rating' || type === 'categorisation'
}

/** Return public question metadata, or null for a malformed extended definition. */
export function normaliseExtendedPollFields(message) {
  if (!isExtendedPoll(message.pollType)) return {}
  if (message.pollType === 'ranking') {
    if (message.rankCount === undefined) return {}
    if (!Number.isInteger(message.rankCount) || message.rankCount < 1 || message.rankCount > message.options.length) return null
    return { rankCount: message.rankCount }
  }
  if (!Array.isArray(message.labels) || !message.labels.length
    || (message.allowSkip !== undefined && typeof message.allowSkip !== 'boolean')) return null
  const labels = message.labels.map(label => label && typeof label.optionId === 'string' && label.optionId.trim()
    && typeof label.label === 'string' && label.label.trim() ? { optionId: label.optionId, label: label.label } : null)
  if (labels.some(label => !label) || new Set(labels.map(label => label.optionId)).size !== labels.length) return null
  return { labels, ...(message.allowSkip !== undefined ? { allowSkip: message.allowSkip } : {}) }
}

/** Never call with presenter-only aggregates on an audience surface. */
export function renderExtendedPollResults(state, presenter = false) {
  if (!presenter && state.visibility === 'held' && !state.revealed) return '<p>Results are held until the speaker reveals them.</p>'
  const escape = extendedPollEscape
  const count = Math.max(0, Number(state.responseCount) || 0)
  if (state.pollType === 'ranking') {
    const positions = state.rankCount ?? state.options.length
    const sorted = state.options.map((option, index) => ({ ...option, index, points: state.tallies?.[option.optionId] || 0 }))
      .sort((a, b) => b.points - a.points || a.index - b.index)
    let previousPoints = null; let place = 0
    const rows = sorted.map((option, index) => {
      if (option.points !== previousPoints) place = index + 1
      previousPoints = option.points
      const joint = sorted.some(other => other.optionId !== option.optionId && other.points === option.points)
      const prefix = count > 0 ? `${joint ? 'Joint ' : ''}${place}. ` : ''
      const firsts = state.firstPlaces?.[option.optionId] || 0
      const width = count ? 100 * option.points / (count * positions) : 0
      return `<div class="poll-score-row"><div class="poll-score-label"><span>${prefix}${escape(option.label)}</span><span>${option.points} points · ${firsts} first-place ${firsts === 1 ? 'vote' : 'votes'}</span></div><div class="poll-score-track"><i style="width:${width}%"></i></div></div>`
    }).join('')
    return `<div class="poll-extended-results"><p>${count} ${count === 1 ? 'ballot' : 'ballots'}</p><p class="poll-score-rule">${positions === 1 ? 'First place earns 1 point.' : `Points per ballot: ${positions}, ${positions > 2 ? '… ' : ''}1, from first to last.`} Unranked choices earn 0. Equal points share a place.</p>${rows}</div>`
  }
  const rows = state.options.map(option => {
    const counts = state.categoryTallies?.[option.optionId] || {}
    const answered = (state.labels || []).reduce((sum, label) => sum + (counts[label.optionId] || 0), 0)
    const cells = (state.labels || []).map(label => {
      const votes = counts[label.optionId] || 0
      const percent = answered ? Math.round(100 * votes / answered) : 0
      return `<div class="poll-score-row"><div class="poll-score-label"><span>${escape(label.label)}</span><span>${votes} · ${percent}%</span></div><div class="poll-score-track"><i style="width:${percent}%"></i></div></div>`
    }).join('')
    return `<section class="poll-matrix-result"><h4>${escape(option.label)}</h4><p>${answered} answered${state.allowSkip ? ` · ${Math.max(0, count - answered)} skipped` : ''}</p>${cells}</section>`
  }).join('')
  return `<div class="poll-extended-results"><p>${count} ${count === 1 ? 'ballot' : 'ballots'} · percentages use answers to each item</p>${rows}</div>`
}

export function createExtendedBallot(mount, poll, onChange, draft) {
  const escape = extendedPollEscape
  const ranking = poll.pollType === 'ranking'
  const limit = poll.rankCount ?? poll.options.length
  const all = ranking && poll.rankCount === undefined
  const labels = poll.labels || []
  const doc = mount.ownerDocument
  let ordered = ranking && Array.isArray(draft) ? [...draft] : all ? poll.options.map(option => option.optionId) : []
  let answers = !ranking && draft && typeof draft === 'object' && !Array.isArray(draft) ? { ...draft } : Object.create(null)
  let dragged = null
  let ghost = null
  let pointer = null
  let announcement = ''
  const labelFor = id => poll.options.find(option => option.optionId === id)?.label || ''

  function value() {
    if (ranking) return ordered.length === limit ? [...ordered] : null
    const entries = Object.entries(answers)
    return entries.length > 0 && (poll.allowSkip || entries.length === poll.options.length) ? Object.fromEntries(entries) : null
  }
  function changed() { onChange(value(), ranking ? [...ordered] : { ...answers }) }
  function rankRow(id, index) {
    const label = escape(labelFor(id)); const safeId = escape(id)
    return `<li class="poll-rank-row" data-rank-id="${safeId}">
      <button class="poll-rank-handle" type="button" draggable="true" data-rank-handle="${safeId}" aria-label="Reorder ${label}" title="Drag to reorder; arrow keys also move this item">⠿</button>
      <span class="poll-rank-position" aria-hidden="true">${index + 1}</span><span class="poll-rank-label">${label}</span>
      <span class="poll-rank-actions"><button type="button" data-rank-up="${safeId}" aria-label="Move ${label} up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-rank-down="${safeId}" aria-label="Move ${label} down" ${index === ordered.length - 1 ? 'disabled' : ''}>↓</button>${!all ? `<button type="button" data-rank-remove="${safeId}" aria-label="Remove ${label} from ranking">×</button>` : ''}</span></li>`
  }
  function render(focusId, focusAction = 'handle') {
    if (ranking) {
      const available = poll.options.filter(option => !ordered.includes(option.optionId))
      mount.innerHTML = `<div class="poll-ranking"><p>${all ? 'Rank all choices.' : `Choose and rank exactly ${limit} choices.`} Drag the handles to reorder, or use the move buttons.</p><ol class="poll-rank-list" data-rank-zone="ordered" aria-label="Your ranking">${ordered.map(rankRow).join('')}</ol>${!all ? `<div class="poll-unranked" data-rank-zone="unranked"><h4>Unranked choices</h4>${available.map(option => `<div class="poll-rank-row" data-rank-id="${escape(option.optionId)}"><button class="poll-rank-handle" type="button" draggable="true" data-rank-handle="${escape(option.optionId)}" aria-label="Drag ${escape(option.label)} into ranking">⠿</button><span class="poll-rank-label">${escape(option.label)}</span><button type="button" data-rank-add="${escape(option.optionId)}" ${ordered.length >= limit ? 'disabled' : ''} aria-label="Rank ${escape(option.label)}">Rank</button></div>`).join('')}</div>` : ''}<div class="poll-rank-status" role="status" aria-live="polite">${escape(announcement || `${ordered.length} of ${limit} ranked`)}</div></div>`
    } else {
      mount.innerHTML = `<div class="poll-matrix"><p>${poll.allowSkip ? 'Answer any items you wish; answer at least one.' : 'Choose one answer for every item.'}</p>${poll.options.map(option => `<fieldset class="poll-matrix-item"><legend>${escape(option.label)}</legend>${labels.map(label => `<label class="poll-matrix-choice"><input type="radio" name="matrix-${escape(option.optionId)}" data-matrix-row="${escape(option.optionId)}" value="${escape(label.optionId)}" ${answers[option.optionId] === label.optionId ? 'checked' : ''}><span>${escape(label.label)}</span></label>`).join('')}${poll.allowSkip ? `<button type="button" data-matrix-clear="${escape(option.optionId)}" aria-label="Clear answer for ${escape(option.label)}">Clear answer</button>` : ''}</fieldset>`).join('')}<div class="poll-rank-status" role="status" aria-live="polite">${escape(announcement)}</div></div>`
    }
    if (focusId) {
      const target = [...mount.querySelectorAll(`[data-rank-${focusAction}]`)].find(el => el.getAttribute(`data-rank-${focusAction}`) === focusId && !el.disabled)
        || [...mount.querySelectorAll('[data-rank-handle]')].find(el => el.getAttribute('data-rank-handle') === focusId)
      target?.focus()
    }
    changed()
  }
  function move(id, index, focusAction = 'handle') {
    const previous = ordered.indexOf(id)
    if (previous < 0 && ordered.length >= limit) { announcement = `Remove a choice before adding another; rank exactly ${limit}.`; render(); return }
    ordered = ordered.filter(item => item !== id)
    ordered.splice(Math.max(0, Math.min(index, ordered.length)), 0, id)
    announcement = `${labelFor(id)} moved to position ${ordered.indexOf(id) + 1} of ${limit}.`
    render(id, focusAction)
  }
  function remove(id) {
    ordered = ordered.filter(item => item !== id)
    announcement = `${labelFor(id)} is unranked. ${ordered.length} of ${limit} ranked.`
    render()
    ;[...mount.querySelectorAll('[data-rank-add]')].find(el => el.getAttribute('data-rank-add') === id)?.focus()
  }
  function click(event) {
    const button = event.target.closest('button')
    if (!button || !mount.contains(button) || button.matches(':disabled')) return
    if (button.hasAttribute('data-rank-up')) { const id = button.getAttribute('data-rank-up'); move(id, ordered.indexOf(id) - 1, 'up') }
    if (button.hasAttribute('data-rank-down')) { const id = button.getAttribute('data-rank-down'); move(id, ordered.indexOf(id) + 1, 'down') }
    if (button.hasAttribute('data-rank-add')) move(button.getAttribute('data-rank-add'), ordered.length)
    if (button.hasAttribute('data-rank-remove')) remove(button.getAttribute('data-rank-remove'))
    if (button.hasAttribute('data-matrix-clear')) {
      const id = button.getAttribute('data-matrix-clear'); delete answers[id]
      for (const input of mount.querySelectorAll('input[data-matrix-row]')) if (input.getAttribute('data-matrix-row') === id) input.checked = false
      changed()
    }
  }
  function change(event) {
    const input = event.target
    if (!input.hasAttribute('data-matrix-row')) return
    answers[input.getAttribute('data-matrix-row')] = input.value
    changed()
  }
  function keydown(event) {
    const id = event.target.getAttribute('data-rank-handle'); const index = ordered.indexOf(id)
    if (!id || index < 0) return
    const destination = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: ordered.length - 1 }[event.key]
    if (destination === undefined) return
    event.preventDefault(); event.stopPropagation(); move(id, destination)
  }
  function dropAt(id, target, y) {
    const zone = target?.closest('[data-rank-zone]')
    if (!zone || !mount.contains(zone)) return
    if (zone.getAttribute('data-rank-zone') === 'unranked') { if (!all) remove(id); return }
    const row = target.closest('[data-rank-id]')
    if (!row) { move(id, ordered.length); return }
    const targetId = row.getAttribute('data-rank-id')
    if (targetId === id) return
    const remaining = ordered.filter(candidate => candidate !== id)
    const rect = row.getBoundingClientRect()
    move(id, remaining.indexOf(targetId) + (y > rect.top + rect.height / 2 ? 1 : 0))
  }
  function dragstart(event) {
    const handle = event.target.closest('[data-rank-handle]')
    if (!handle || handle.matches(':disabled')) return
    dragged = handle.getAttribute('data-rank-handle')
    event.dataTransfer?.setData('text/plain', dragged)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }
  function dragover(event) { if (dragged) event.preventDefault() }
  function drop(event) {
    if (!dragged) return
    event.preventDefault(); const id = dragged; dragged = null; dropAt(id, event.target, event.clientY)
  }
  function dragend() { dragged = null }
  function pointerdown(event) {
    if (event.pointerType === 'mouse') return // Native HTML drag handles mouse input.
    const handle = event.target.closest('[data-rank-handle]')
    if (!handle || handle.matches(':disabled') || event.button > 0) return
    event.preventDefault()
    pointer = { id: handle.getAttribute('data-rank-handle'), pointerId: event.pointerId }
    mount.setPointerCapture?.(event.pointerId)
    ghost = doc.createElement('div'); ghost.className = 'poll-rank-ghost'; ghost.setAttribute('aria-hidden', 'true'); ghost.textContent = labelFor(pointer.id)
    doc.body.appendChild(ghost); pointermove(event)
  }
  function pointermove(event) {
    if (!pointer || event.pointerId !== pointer.pointerId || !ghost) return
    event.preventDefault(); ghost.style.left = `${event.clientX + 12}px`; ghost.style.top = `${event.clientY + 12}px`
    for (const row of mount.querySelectorAll('.poll-drop-target')) row.classList.remove('poll-drop-target')
    doc.elementFromPoint(event.clientX, event.clientY)?.closest('[data-rank-id], [data-rank-zone]')?.classList.add('poll-drop-target')
    const edge = 55
    if (event.clientY < edge) mount.closest('#audiencePollSurface')?.scrollBy(0, -24)
    if (event.clientY > doc.defaultView.innerHeight - edge) mount.closest('#audiencePollSurface')?.scrollBy(0, 24)
  }
  function clearPointer() {
    ghost?.remove(); ghost = null
    for (const row of mount.querySelectorAll('.poll-drop-target')) row.classList.remove('poll-drop-target')
    if (pointer && mount.hasPointerCapture?.(pointer.pointerId)) mount.releasePointerCapture(pointer.pointerId)
    pointer = null
  }
  function pointerup(event) {
    if (!pointer || pointer.pointerId !== event.pointerId) return
    const id = pointer.id; const target = doc.elementFromPoint(event.clientX, event.clientY)
    clearPointer(); dropAt(id, target, event.clientY)
  }
  const listeners = { click, change, keydown, dragstart, dragover, drop, dragend, pointerdown, pointermove, pointerup, pointercancel: clearPointer }
  for (const [name, handler] of Object.entries(listeners)) mount.addEventListener(name, handler)
  render()
  return {
    value,
    draft: () => ranking ? [...ordered] : { ...answers },
    destroy() { clearPointer(); for (const [name, handler] of Object.entries(listeners)) mount.removeEventListener(name, handler) },
  }
}

export function normaliseBallotChoice(choice) {
  if (typeof choice === 'string' && choice.trim()) return choice
  if (Array.isArray(choice) && choice.length && choice.every(id => typeof id === 'string' && id.trim())) return [...choice]
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    const entries = Object.entries(choice)
    if (entries.length && entries.every(([row, label]) => row.trim() && typeof label === 'string' && label.trim())) return Object.fromEntries(entries)
  }
  return null
}

export function samePollChoice(left, right) {
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

export function normaliseExtendedPollAggregates(message) {
  const result = {}
  if (message.responseCount !== undefined) {
    if (!Number.isSafeInteger(message.responseCount) || message.responseCount < 0) return null
    result.responseCount = message.responseCount
  }
  const countsFor = (raw, ids) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (Object.values(raw).some(count => !Number.isSafeInteger(count) || count < 0)) return null
    return Object.fromEntries(ids.map(id => [id, raw[id] || 0]))
  }
  if (message.firstPlaces !== undefined) {
    const firstPlaces = countsFor(message.firstPlaces, message.options.map(option => option.optionId))
    if (!firstPlaces) return null
    result.firstPlaces = firstPlaces
  }
  if (message.categoryTallies !== undefined) {
    if (!message.categoryTallies || typeof message.categoryTallies !== 'object' || Array.isArray(message.categoryTallies)) return null
    const categories = []
    for (const option of message.options) {
      const counts = countsFor(message.categoryTallies[option.optionId] || {}, (message.labels || []).map(label => label.optionId))
      if (!counts) return null
      categories.push([option.optionId, counts])
    }
    result.categoryTallies = Object.fromEntries(categories)
  }
  return result
}

export function extendedPollRuntimeSource() {
  return [extendedPollEscape, isExtendedPoll, normaliseExtendedPollFields, normaliseExtendedPollAggregates, normaliseBallotChoice, samePollChoice, renderExtendedPollResults, createExtendedBallot]
    .map(fn => fn.toString()).join('\n')
}
