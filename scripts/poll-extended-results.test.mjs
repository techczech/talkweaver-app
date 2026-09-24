import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { renderExtendedPollResults } from '../compiler/assets/runtime/poll-extended.js'
const options = ['a','b','c'].map(optionId => ({ optionId, label: optionId }))
const ranking = { pollType: 'ranking', options, rankCount: 2, responseCount: 2, visibility: 'live', revealed: true, tallies: { a:3,b:3,c:0 }, firstPlaces: { a:1,b:1,c:0 } }
const text = html => new JSDOM(html).window.document.body.textContent
const html = renderExtendedPollResults(ranking)
assert.match(text(html), /2 ballots/)
assert.match(text(html), /Joint 1\. a.*Joint 1\. b.*3\. c/)
assert.match(text(html), /3 points/)
const labels = [{ optionId:'low',label:'A little' },{ optionId:'high',label:'A lot' }]
const matrix = { pollType:'rating',options: options.slice(0,2), labels, allowSkip: true, responseCount:3, visibility:'live', revealed: true, categoryTallies: { a:{low:1,high:1},b:{low:0,high:1} } }
const result = text(renderExtendedPollResults(matrix))
assert.match(result, /2 answered · 1 skipped/)
assert.match(result, /1 · 50%/)
assert.match(result, /1 answered · 2 skipped/)
assert.match(result, /1 · 100%/)
for (const state of [ranking,matrix]) {
  const held = renderExtendedPollResults({ ...state, visibility:'held', revealed:false })
  assert.doesNotMatch(text(held), /3 points|50%|100%/)
  assert.match(text(renderExtendedPollResults({ ...state, visibility:'held', revealed:false }, true)), /ballots/)
}
const injection = renderExtendedPollResults({ ...ranking, options: [{optionId:'a',label:'<img src=x onerror=alert(1)>'}] })
assert.equal(new JSDOM(injection).window.document.querySelector('img'), null)
console.log('Extended results: tied placements, explicit scores, row denominators, skips, held privacy and escaping passed')

const emptyRanking = new JSDOM(renderExtendedPollResults({ ...ranking, responseCount: 0, tallies: {}, firstPlaces: {} })).window.document
assert.deepEqual([...emptyRanking.querySelectorAll('.poll-score-label > span:first-child')].map(el => el.textContent), ['a', 'b', 'c'])

const omitted = text(renderExtendedPollResults({ ...ranking, responseCount: 1, options: [...options, { optionId: 'd', label: 'd' }], tallies: { a: 2, b: 1, c: 0, d: 0 } }))
assert.match(omitted, /Joint 3\. c.*Joint 3\. d/)
