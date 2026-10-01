// Instant clock/countdown slide: no label by default, a preset or typed label shows (TalkWeaver 0.37).
// Seam: createInstantSlideSurface (compiler/assets/runtime/instant-slide.js), the one renderer every screen uses.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createInstantSlideSurface } from '../compiler/assets/runtime/instant-slide.js'

const { document } = new JSDOM('<body></body>').window
const surface = createInstantSlideSurface(document.body, { now: () => 1000 })
const kicker = () => surface.element.querySelector('.instant-slide-kicker')
const countdown = (label) => ({ kind: 'countdown', startedAt: 1000, durationMs: 300000, label, shownAt: 1000 })

for (const label of [undefined, '', '   ']) {
  surface.show(countdown(label))
  assert.equal(kicker(), null, `countdown with label ${JSON.stringify(label)} renders no label element`)
  assert.doesNotMatch(surface.element.textContent, /Countdown/)
  assert.equal(surface.element.querySelector('.instant-slide-digits').textContent, '05:00')
  assert.ok(surface.element.querySelector('.instant-slide-bar'))
}
for (const label of ['Break', 'Discussion', 'Group work']) {
  surface.show(countdown(label))
  assert.equal(kicker().textContent, label)
}
surface.show({ kind: 'time', shownAt: 1000 })
assert.equal(kicker(), null, 'the clock slide has no default word either')
assert.doesNotMatch(surface.element.textContent, /Current time/)
assert.ok(surface.element.querySelector('.instant-slide-digits').textContent.length > 0)
surface.show({ kind: 'link', url: 'https://example.test/a', qrSvg: '', shownAt: 1000 })
assert.equal(kicker().textContent, 'Link', 'link slides keep their kicker')
surface.destroy()
console.log('instant-slide label tests passed')
