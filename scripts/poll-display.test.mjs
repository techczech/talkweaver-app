import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { pollFrameRuntimeSource, renderPollFrame } from '../compiler/scripts/lib/poll-frame.mjs'

const path = new URL('../compiler/assets/runtime/poll-display.js', import.meta.url)
const runtime = existsSync(path) ? readFileSync(path, 'utf8') : ''
// The deck injects the frame renderer before poll-display.js (01-cli-utils pollDisplayRuntimeSource).
const frame = pollFrameRuntimeSource()
const api = vm.runInNewContext(`${frame}; ${runtime}; typeof createPollDisplay === 'function' ? createPollDisplay() : {}`, { URL })
const plain = (value) => JSON.parse(JSON.stringify(value))
const held = {
  type: 'poll.state', pollId: 'poll-reading', slideId: 'reading', pollType: 'single', question: 'What takes the most time?',
  options: [{ optionId: 'a', label: 'Finding sources' }, { optionId: 'b', label: 'Taking notes' }],
  visibility: 'held', open: true, revealed: false, tallies: { a: 14, b: 7 },
  presenterToken: 'must-never-leave-presenter', votes: { person: 'a' },
}

test('held result data and unrecognised fields never enter the audience snapshot', () => {
  assert.equal(typeof api.safeState, 'function', 'the audience privacy boundary must exist')
  const safe = api.safeState(held)
  assert.equal(safe.pollId, held.pollId)
  assert.equal(safe.slideId, 'reading')
  assert.equal(safe.tallies, undefined)
  assert.equal(safe.responses, undefined)
  assert.doesNotMatch(JSON.stringify(safe), /presenterToken|votes|must-never|14/)
})

test('public tallies include only declared choices and finite nonnegative counts', () => {
  assert.equal(typeof api.safeState, 'function')
  const safe = api.safeState({ ...held, revealed: true, tallies: { a: 14, b: -2, private: 77 } })
  assert.deepEqual(plain(safe.tallies), { a: 14, b: 0 })
})

test('moderated text, names, and private flags are absent from every public response', () => {
  assert.equal(typeof api.safeState, 'function')
  const safe = api.safeState({ ...held, pollType: 'open', options: [], revealed: true, responses: [
    { responseId: '1', text: 'Public response', name: 'Private name', secret: 'extra' },
    { responseId: '2', text: 'Hidden response', hidden: true },
  ] })
  assert.deepEqual(plain(safe.responses), [{ responseId: '1', text: 'Public response' }])
  assert.doesNotMatch(JSON.stringify(safe), /Hidden|Private name|secret|extra|hidden/)
})

test('rendering held data cannot disclose results even when results view was requested', () => {
  assert.equal(typeof api.markup, 'function')
  const html = api.markup(held, { view: 'results', started: true })
  assert.match(html, /data-poll-view="question"/)
  assert.match(html, /Finding sources/)
  assert.doesNotMatch(html, /poll-frame-bar|14|67%/)
})

test('closed revealed results remain available and question view stays independently selectable', () => {
  assert.equal(typeof api.markup, 'function')
  const closed = { ...held, open: false, revealed: true }
  const results = api.markup(closed, { view: 'results', started: true })
  assert.match(results, /data-poll-view="results"/)
  assert.match(results, /Responses closed/)
  assert.match(results, /67%/)
  assert.match(results, /21 votes/)
  const question = api.markup(closed, { view: 'question', started: true })
  assert.match(question, /data-poll-view="question"/)
  assert.doesNotMatch(question, /poll-frame-bar/)
})

test('open text results escape HTML, omit hidden responses and support pages without truncating text', () => {
  assert.equal(typeof api.markup, 'function')
  const responses = Array.from({ length: 9 }, (_, i) => ({ responseId: String(i), text: `Answer ${i} <script>alert(1)</script>` }))
  const poll = { ...held, pollType: 'open', options: [], revealed: true, responses }
  const first = api.markup(poll, { view: 'results', page: 0, started: true })
  const second = api.markup(poll, { view: 'results', page: 1, started: true })
  assert.match(first, /Answer 0 &lt;script&gt;/)
  assert.doesNotMatch(first, /<script>|Answer 4 /)
  assert.match(second, /Answer 4 /)
  assert.doesNotMatch(second, /Answer 0 /)
  assert.equal(api.pageInfo(poll, 'results', 99).page, 2)
  assert.equal(api.pageInfo(poll, 'results', 0).pages, 3)
})

test('joining URLs are allowlisted and QR markup cannot carry script or handlers', () => {
  assert.equal(typeof api.safeJoin, 'function')
  assert.deepEqual(plain(api.safeJoin({ shortUrl: 'javascript:alert(1)', qrSvg: '<svg onload="alert(1)"></svg>' })), { shortUrl: '', qrSvg: '' })
  const join = api.safeJoin({ shortUrl: 'https://example.test/abc', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z" fill="#000"/></svg>' })
  assert.equal(join.shortUrl, 'https://example.test/abc')
  assert.match(join.qrSvg, /<path/)
  assert.equal(api.safeJoin({ shortUrl: join.shortUrl, qrSvg: '<svg><foreignObject>secret</foreignObject></svg>' }).qrSvg, '')
})

test('the presenter can reveal held results after stopping responses', () => {
  const template = readFileSync(new URL('../compiler/assets/templates/presenter-popup-single-html.html', import.meta.url), 'utf8')
  const source = template.split('// PRESENTER_POLL_VIEW_MODEL_START')[1].split('// PRESENTER_POLL_VIEW_MODEL_END')[0]
  const viewModel = new Function(`${source}; return presenterPollViewModel`)()
  assert.equal(viewModel({ ...held, open: false }).showReveal, true)
  assert.equal(viewModel({ ...held, open: false }).showHeldNote, true)
})


test('ready authored polls show every option on one page, exactly as the compiled frame does', () => {
  // Ticket 23: options never page — the compiled frame shows them all, and the live frame must agree.
  const projection = readFileSync(new URL('../compiler/assets/runtime/poll-projection.js', import.meta.url), 'utf8')
  const definition = { ...held, type: 'single', options: Array.from({ length: 6 }, (_, i) => ({ optionId: String(i), label: `Choice ${i + 1}` })) }
  const slide = { dataset: { poll: JSON.stringify(definition), id: 'reading' } }
  const p = vm.runInNewContext(`${frame}; ${runtime}; ${projection}; createPollProjection(options)`, { URL,
    options: { storageKey: 'test', sessionId: 'test', isPresenter: true, isPaired: false },
  })
  const key = p.previewKey(slide, true)
  assert.equal(p.info(definition.pollId).pages, 1)
  assert.match(key, /Choice 1[\s\S]*Choice 6/)
  assert.equal((key.match(/class="poll-frame-option"/g) || []).length, 6)
  assert.match(key, /data-poll-frame="live"/)
  assert.equal(p.info(definition.pollId).started, false)
})

test('the live markup is the compiled frame: same grammar, state slots filled', () => {
  const closed = { ...held, open: false, revealed: true }
  const live = api.markup(closed, { view: 'results', started: true })
  const compiled = renderPollFrame({ pollId: held.pollId, type: 'single', question: held.question, options: held.options })
  const grammar = (html) => [...html.matchAll(/<(section|header|h2|div|ol|li|footer|p|aside)[^>]*class="([\w- ]+)"/g)].map((m) => `${m[1]}.${m[2].split(' ')[0]}`)
  assert.deepEqual(grammar(live).filter((tag) => !/poll-frame-(count|bar|total|page)/.test(tag)), grammar(compiled).filter((tag) => tag !== 'span.poll-frame-instruction'))
  assert.match(live, /data-poll-frame="live"/)
  assert.match(compiled, /data-poll-frame="compiled"/)
  assert.doesNotMatch(live + compiled, /poll-display-/)
})


test('projection keeps the same per-participant limit instructions as the poll', () => {
  const choices = { ...held, pollType:'multiple', maxSelections:1 }
  assert.equal(api.safeState(choices).maxSelections, 1)
  assert.match(api.markup(choices, {view:'question', started:true}), /Select up to 1 options/)
  const text = { ...held, pollType:'open', options:[], maxSubmissions:null }
  assert.equal(api.safeState(text).maxSubmissions, null)
  assert.match(api.markup(text, {view:'question', started:true}), /as many answers as you like/)
})
