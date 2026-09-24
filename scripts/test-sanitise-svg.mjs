import { strict as assert } from 'node:assert'
import { CLEAN_SVG, HISTORICAL_SVG_BYPASSES } from './fixtures/svg-sanitiser-cases.mjs'
const { sanitiseSvg, svgPreflightError, isSvgFence } =
  await import(new URL('../src/shared/objects/sanitise-svg.ts', import.meta.url))

assert.equal(typeof svgPreflightError, 'function', 'the source preflight is a named export')
assert.equal(svgPreflightError(CLEAN_SVG), null, 'clean svg passes the source preflight')
const domless = sanitiseSvg(CLEAN_SVG)
assert.ok('error' in domless && /DOM parser/i.test(domless.error), 'Node fails closed without a DOM parser')

for (const [bad, why] of [
  ['<div>x</div>', /<svg> root/],
  ['<svg><script>alert(1)</script></svg>', /Scripts and foreignObject/],
  ['<svg onload="x()"></svg>', /event-handler/],
  ['<svg><a href="https://evil.example">x</a></svg>', /local #fragment/],
  ['<svg><style>@import url(x)</style></svg>', /CSS and animated/],
  ['<?xml version="1.0"?><svg></svg>', /declarations, doctypes/],
  ['<svg><rect></svg>', /not well formed/]
]) {
  const error = svgPreflightError(bad)
  assert.ok(error && why.test(error), `rejects: ${bad} → ${error}`)
}

for (const { name, source } of HISTORICAL_SVG_BYPASSES) {
  assert.ok(svgPreflightError(source), `rejects historical bypass ${name}: ${source}`)
}
assert.equal(isSvgFence(' SVG '), true)
assert.equal(isSvgFence('mermaid'), false)
console.log('test:sanitise-svg OK')
