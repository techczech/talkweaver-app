/** Type-specific Quick poll fields. Parent composer owns options, opening and visibility. */
export function createQuickPollExtras(host, onChange) {
  host.innerHTML = `<p data-quick-guide></p><fieldset data-quick-ranking hidden class="quick-poll-field"><legend>Ranking</legend>
    <label><input type="radio" name="quick-ranking-mode" data-rank-mode="all" checked> Rank all</label>
    <label><input type="radio" name="quick-ranking-mode" data-rank-mode="top"> Rank your top <input type="number" data-quick-rank-count min="1" step="1" value="3" aria-label="Number of choices to rank" style="width:5em"></label>
    </fieldset><fieldset data-quick-matrix hidden class="quick-poll-field"><legend data-quick-labels-title>Scale labels</legend>
    <label>Labels, separated by commas <input type="text" data-quick-matrix-labels value="A lot, A little, Never" placeholder="A lot, A little, Never" autocomplete="off"></label>
    <label><input type="checkbox" data-quick-matrix-skip> Allow skipped items</label></fieldset>
    <p data-quick-extra-error role="status" hidden></p>`
  const all = host.querySelector('[data-rank-mode="all"]')
  const top = host.querySelector('[data-rank-mode="top"]')
  const count = host.querySelector('[data-quick-rank-count]')
  const labelsInput = host.querySelector('[data-quick-matrix-labels]')
  const skip = host.querySelector('[data-quick-matrix-skip]')
  const error = host.querySelector('[data-quick-extra-error]')
  const labelValues = () => labelsInput.value.split(',').map(label => label.trim())
  function setType(type) {
    host.hidden = !['ranking', 'rating', 'categorisation'].includes(type)
    host.querySelector('[data-quick-guide]').textContent = type === 'ranking'
      ? 'Add each choice under Options. People rank all choices by default, or exactly the number you set below.'
      : type === 'rating'
        ? 'Add each item to rate under Options. Enter the scale labels below, separated by commas; each person chooses one label per item.'
        : 'Add each item under Options. Enter the category labels below, separated by commas; each person chooses one category per item.'
    host.querySelector('[data-quick-ranking]').hidden = type !== 'ranking'
    host.querySelector('[data-quick-matrix]').hidden = type !== 'rating' && type !== 'categorisation'
    host.querySelector('[data-quick-labels-title]').textContent = type === 'categorisation' ? 'Category labels' : 'Scale labels'
  }
  function valid(type, optionCount) {
    let message = ''
    if (type === 'ranking' && top.checked && (!Number.isInteger(Number(count.value)) || Number(count.value) < 1 || Number(count.value) > optionCount)) {
      message = `Choose a whole number from 1 to ${optionCount}.`
    }
    if (type === 'rating' || type === 'categorisation') {
      const labels = labelValues()
      if (labels.some(label => !label) || new Set(labels.map(label => label.toLowerCase())).size !== labels.length) message = 'Enter non-empty, different labels separated by commas.'
    }
    error.textContent = message; error.hidden = !message
    count.max = String(optionCount)
    return !message
  }
  function fields(type, pollId) {
    if (type === 'ranking') return top.checked ? { rankCount: Number(count.value) } : {}
    if (type === 'rating' || type === 'categorisation') {
      return { labels: labelValues().map((label, index) => ({ optionId: `${pollId}-label-${index + 1}`, label })), allowSkip: skip.checked }
    }
    return {}
  }
  function reset() {
    all.checked = true; top.checked = false; count.value = '3'
    labelsInput.value = 'A lot, A little, Never'; skip.checked = false; error.hidden = true
    setType('single')
  }
  host.addEventListener('input', onChange)
  host.addEventListener('change', onChange)
  reset()
  return { setType, valid, fields, reset }
}

export function quickPollRuntimeSource() { return createQuickPollExtras.toString() }
