import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createQuickPollExtras } from '../compiler/assets/runtime/poll-quick.js'
const dom = new JSDOM('<div id="host"></div>')
const host = dom.window.document.querySelector('#host')
const controls = createQuickPollExtras(host, () => {})
controls.setType('ranking')
assert.equal(controls.valid('ranking', 3), true)
assert.deepEqual(controls.fields('ranking', 'p'), {})
host.querySelector('[data-rank-mode="top"]').checked = true
host.querySelector('[data-quick-rank-count]').value = '2'
assert.deepEqual(controls.fields('ranking', 'p'), { rankCount: 2 })
host.querySelector('[data-quick-rank-count]').value = '4'
assert.equal(controls.valid('ranking', 3), false)
controls.setType('rating')
host.querySelector('[data-quick-matrix-labels]').value = 'A lot, A little, Never'
assert.equal(controls.valid('rating', 2), true)
assert.deepEqual(controls.fields('rating', 'p'), { labels: [
  { optionId: 'p-label-1', label: 'A lot' }, { optionId: 'p-label-2', label: 'A little' }, { optionId: 'p-label-3', label: 'Never' },
], allowSkip: false })
host.querySelector('[data-quick-matrix-skip]').checked = true
assert.equal(controls.fields('categorisation', 'p').allowSkip, true)
for (const invalid of ['', 'A,,B', 'A,a']) {
  host.querySelector('[data-quick-matrix-labels]').value = invalid
  assert.equal(controls.valid('categorisation', 2), false)
}
controls.reset(); controls.setType('ranking')
assert.deepEqual(controls.fields('ranking', 'p'), {})
console.log('Quick extended polls: Rank all default, bounded Top N, labels, duplicate rejection and reset passed')
