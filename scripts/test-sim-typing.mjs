// Typing and streaming on the chat and terminal simulation slides (compiler/assets/runtime/sim-typing.js),
// at the runtime seam with an injected clock and frame queue (no real timers): the rate, the queue of
// parts, which text types, finishing, restoring the text exactly, that typing ignores reduced motion, and the runtime source.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  simTypingCharsPerSecond, simTypedChars, simTypingStates, normaliseSimType, simTypingUnits,
  createSimTyping, simTypingRuntimeSource
} from '../compiler/assets/runtime/sim-typing.js'
import { annotateSimulationLayout, renderSimulation } from '../compiler/scripts/lib/simulation-layout.mjs'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`) }

const CHAT = `user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes.
context-retrieval:
  Refund Policy v4.2
tool-call: search_policy_docs {"topic": "refunds"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
bot: The refund window shrank from 30 to 14 days.`

function slideFor(layout, text, attrs = {}) {
  const block = { type: 'code', lang: layout.startsWith('terminal') ? 'terminal' : 'chat', text }
  annotateSimulationLayout([block], layout, attrs, { id: 's1', title: 'Refunds' }, () => {})
  const dom = new JSDOM(`<section class="slide" data-id="s1"><div class="slide-content">${renderSimulation(block)}</div></section>`)
  return dom.window.document.querySelector('.slide')
}
function harness(options = {}) {
  const clock = { t: 1000 }
  const frames = []
  const typer = createSimTyping({
    now: () => clock.t,
    frame: (fn) => { frames.push(fn); return frames.length },
    cancelFrame: (handle) => { frames[handle - 1] = null },
    reducedMotion: options.reducedMotion // a stale option: the animator must not read it
  })
  // Advance the clock and run the frames that were waiting (one paint per advance).
  const advance = (ms) => {
    clock.t += ms
    const waiting = frames.splice(0)
    waiting.forEach((fn) => fn && fn())
  }
  return { clock, typer, advance, frames }
}
const visible = (el) => {
  let n = 0
  const walker = el.ownerDocument.createTreeWalker(el, 4)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement.closest('.sim-typing-rest')) n += node.data.length
  return n
}

test('the rate is one constant: 40 tokens a second at 4 characters a token', () => {
  assert.equal(simTypingCharsPerSecond(), 160)
  assert.equal(simTypedChars(1000), 160)
  assert.equal(simTypedChars(100), 16)
  assert.equal(simTypedChars(0), 0)
  assert.equal(simTypedChars(-50), 0, 'a clock behind the move types nothing yet')
  assert.equal(simTypedChars(NaN), 0)
})

test('the queue: parts type one after another; a part with nothing to type is done when its turn comes', () => {
  assert.deepEqual(simTypingStates([10, 0, 5], 0), [{ state: 'typing', shown: 0 }, { state: 'wait', shown: 0 }, { state: 'wait', shown: 0 }])
  assert.deepEqual(simTypingStates([10, 0, 5], 4), [{ state: 'typing', shown: 4 }, { state: 'wait', shown: 0 }, { state: 'wait', shown: 0 }])
  assert.deepEqual(simTypingStates([10, 0, 5], 10), [{ state: 'done', shown: 10 }, { state: 'done', shown: 0 }, { state: 'typing', shown: 0 }])
  assert.deepEqual(simTypingStates([10, 0, 5], 99), [{ state: 'done', shown: 10 }, { state: 'done', shown: 0 }, { state: 'done', shown: 5 }])
  assert.deepEqual(simTypingStates([0, 3], 0), [{ state: 'done', shown: 0 }, { state: 'typing', shown: 0 }], 'a leading part with nothing to type shows at once')
})

test('a move is validated before it is used', () => {
  assert.deepEqual(normaliseSimType({ slideId: 'a', from: -1, to: 0, at: 5 }), { slideId: 'a', from: -1, to: 0, at: 5, done: false })
  assert.equal(normaliseSimType({ slideId: '', from: 0, to: 1, at: 5 }), null)
  assert.equal(normaliseSimType({ slideId: 'a', from: -2, to: 1, at: 5 }), null)
  assert.equal(normaliseSimType({ slideId: 'a', from: 0, to: 1, at: 'x' }), null)
  assert.equal(normaliseSimType(null), null)
})

test('terminal-agent: a step types the part it reveals, an arrival types nothing; text in controls and closed bodies is skipped', () => {
  const slide = slideFor('terminal-agent', CHAT, { reveal: 'steps' })
  const first = simTypingUnits(slide, { from: 0, to: 1, stepped: true })
  assert.deepEqual(first.map((u) => u.el.classList.contains('sim-reasoning')), [true], 'the first step types its one part')
  const every = simTypingUnits(slide, { from: 0, to: 9, stepped: true })
  assert.ok(every.length > 0 && every.every((u) => u.el.classList.contains('sim-step')), 'only step parts type: the anchor prompt on screen from arrival never does')
  assert.ok(!every.some((u) => u.el.classList.contains('sim-promptbox')), 'no prompt box in a step move')
  const tool = simTypingUnits(slide, { from: 2, to: 3, stepped: true })
  assert.equal(tool.length, 1)
  assert.ok(tool[0].el.classList.contains('sim-tool'))
  const text = tool[0].nodes.map((n) => n.data).join('')
  assert.ok(!text.includes('click to'), 'the "+N lines" control text never types')
  tool[0].el.querySelector('.sim-results').parentElement.classList.add('is-closed')
  const closed = simTypingUnits(slide, { from: 2, to: 3, stepped: true })[0].nodes.map((n) => n.data).join('')
  assert.ok(!closed.includes('Digital goods'), 'a closed part body never types')
  assert.ok(closed.includes('Refund window cut'), 'the first result line (always shown) types')
})

test('chat: nothing types without stream=on; with it only the answer and reasoning text of the parts a step reveals', () => {
  assert.deepEqual(simTypingUnits(slideFor('chat-lanes', CHAT, { reveal: 'steps' }), { from: 0, to: 4, stepped: true }), [])
  const units = simTypingUnits(slideFor('chat-lanes', CHAT, { stream: 'on', reveal: 'steps' }), { from: 0, to: 4, stepped: true })
  assert.deepEqual(units.map((u) => u.el.className.split(' ')[1]), ['sim-reasoning', 'sim-context', 'sim-tool', 'sim-answer'], 'the question is on screen from arrival and never streams')
  assert.deepEqual(units.map((u) => u.length > 0), [true, false, false, true], 'context and tool call appear whole when their turn comes')
  assert.equal(units[3].nodes.map((n) => n.data).join(''), 'The refund window shrank from 30 to 14 days.')
  const rows = slideFor('chat', CHAT, { stream: 'on' })
  rows.querySelector('.sim-reasoning').classList.add('is-closed')
  assert.equal(simTypingUnits(rows, { from: 0, to: 1, stepped: true })[0].length, 0, 'a closed reasoning row has nothing to stream')
})

test('sync on an injected clock: types at the rate, keeps every node in place, restores the text exactly', () => {
  const slide = slideFor('terminal-agent', CHAT, { reveal: 'steps' })
  const before = slide.innerHTML
  const { clock, typer, advance } = harness()
  const move = { slideId: 's1', from: 0, to: 1, at: clock.t, done: false, stepped: true }
  const thinking = slide.querySelector('.sim-reasoning')
  const total = simTypingUnits(slide, move)[0].length
  typer.sync(slide, move)
  assert.equal(visible(thinking), 0, 'at the press nothing is typed yet')
  assert.ok(thinking.classList.contains('sim-typing'))
  assert.equal(thinking.textContent.length, total, 'the untyped rest stays in the DOM (it keeps its place)')
  advance(50)
  assert.equal(visible(thinking), 8)
  assert.equal(typer.busy(slide, move), true)
  typer.sync(slide, move)
  assert.equal(visible(thinking), 8, 'the same move again carries on, it does not restart')
  advance(10000)
  assert.equal(visible(thinking), total)
  assert.equal(typer.busy(slide, move), false)
  assert.equal(slide.innerHTML, before, 'finished: the markup is exactly as compiled')
})

test('parts that arrive together type in order: a later part waits, hidden with its space kept', () => {
  const slide = slideFor('terminal', '$ whoami\n$ ls\na.md  b.md\n$ pwd\n/home/policy', { reveal: 'steps' })
  const { clock, typer, advance } = harness()
  const move = { slideId: 's1', from: 0, to: 2, at: clock.t, done: false, stepped: true }
  const [first, second] = slide.querySelectorAll('.sim-cmd.sim-step')
  const firstLength = simTypingUnits(slide, move)[0].length
  typer.sync(slide, move)
  assert.ok(first.classList.contains('sim-typing') && second.classList.contains('sim-typing-wait'))
  advance(1000 * (firstLength + 1) / 160)
  assert.ok(!first.classList.contains('sim-typing') && second.classList.contains('sim-typing'), 'the second command starts when the first is typed')
})

test('a finished move or no move shows the text whole at once', () => {
  const slide = slideFor('terminal-agent', CHAT, { reveal: 'steps' })
  const before = slide.innerHTML
  const { clock, typer, advance } = harness()
  const move = { slideId: 's1', from: 0, to: 1, at: clock.t, done: false, stepped: true }
  typer.sync(slide, move)
  advance(20)
  typer.sync(slide, { ...move, done: true })
  assert.equal(slide.innerHTML, before, 'done: the Next press finished it')
  typer.sync(slide, move)
  typer.sync(slide, null)
  assert.equal(slide.innerHTML, before, 'no move (Back, a jump): complete')
})

test('typing ignores reduced motion: an option for it is not read, and a move types either way', () => {
  const slide = slideFor('terminal-agent', CHAT, { reveal: 'steps' })
  const before = slide.innerHTML
  const { clock, typer, advance } = harness({ reducedMotion: () => true })
  const move = { slideId: 's1', from: 0, to: 1, at: clock.t, done: false, stepped: true }
  typer.sync(slide, move)
  assert.notEqual(slide.innerHTML, before, 'reduced motion on: the part still types')
  assert.ok(slide.querySelector('.sim-typing-rest, .sim-typing-wait'), 'untyped text waits in the DOM')
  assert.equal(typer.busy(slide, move), true, 'and Next would finish it first')
  advance(30000)
  assert.equal(slide.innerHTML, before, 'it finishes on its own, text restored exactly')
})

test('a new picture of the same slide (the Current pane rebuilt) continues from the shared timestamp', () => {
  const a = slideFor('terminal-agent', CHAT, { reveal: 'steps' })
  const b = slideFor('terminal-agent', CHAT, { reveal: 'steps' })
  const beforeA = a.innerHTML
  const { clock, typer, advance } = harness()
  const move = { slideId: 's1', from: 0, to: 1, at: clock.t, done: false, stepped: true }
  typer.sync(a, move)
  advance(50)
  typer.sync(b, move)
  assert.equal(a.innerHTML, beforeA, 'the old picture is put back')
  assert.equal(visible(b.querySelector('.sim-reasoning')), 8, 'the new one shows the same characters')
})

test('a surrogate pair is never split', () => {
  const slide = slideFor('terminal', '$ echo 😀😀😀😀')
  const { clock, typer, advance } = harness()
  typer.sync(slide, { slideId: 's1', from: 0, to: 0, at: clock.t, done: false, stepped: false })
  for (let i = 0; i < 6; i++) {
    advance(1000 / 160)
    const shown = slide.querySelector('.sim-typed').firstChild.data
    assert.ok(!/[\uD800-\uDBFF]$/.test(shown), `no lone high surrogate at the cut (${JSON.stringify(shown)})`)
  }
})

test('the runtime source is self-contained', () => {
  const make = new Function(`${simTypingRuntimeSource()}; return { createSimTyping, simTypingCharsPerSecond };`)
  const api = make()
  assert.equal(api.simTypingCharsPerSecond(), 160)
  assert.equal(typeof api.createSimTyping, 'function')
})

console.log(`sim typing: ${passed} checks passed`)
