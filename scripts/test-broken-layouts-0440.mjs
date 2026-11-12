// =============================================================================
// 0.44 slide redesign, step 1: the eight layouts the current-state gallery found broken
// Each case is
// the registry's own syntax, compiled by the real compiler; each assertion names the fault it guards.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckStyles } from './build-deck-styles.mjs'
import { parseStatItem } from '../compiler/scripts/lib/06-block-renderers.mjs'

const source = `---
title: Broken layouts
---
# Section

## Group

### CTA
{cta-screenshots}{id=cta}

- Try an agent on one real task
- [Action: Get the starter kit -> https://example.com]

### Branch
{flow}{flow=branch}{id=branch}

- Task
- Search the web
- Read the files
- Run the code

### Vertical
{flow}{flow=vertical}{id=vertical}

- Task
- Plan
- Act

### Map
{system-map}{id=map}

- AI agent
  - Model
  - Harness
  - Tools
  - Memory
  - Instructions

### Map colours
{system-map}{multicolour}{id=map-multi}

- AI agent
  - Model
  - Harness

### Compact
{timeline=compact}{id=compact}

- 2022: Chat goes mainstream
- 2023: Tool calling in the APIs
- 2024: Models use computers
- 2025: Coding agents work for hours
- 2026: Background agents

### Horizontal
{timeline=horizontal}{id=horizontal}

- 2022
  - Chat goes mainstream
- 2023
  - Tool calling in the APIs
- 2024
  - Models use computers
- 2025
  - Coding agents work for hours

### After
{id=after}

The end.
`

const dir = mkdtempSync(join(tmpdir(), 'tw-broken-layouts-'))
const file = join(dir, 'broken-outline.md')
writeFileSync(file, source)
const model = await prepareSource(file, source, 'broken', statSync(file))
const html = String(model.fullHtml)
const slideHtml = (id) => {
  const start = html.indexOf(`data-id="${id}"`)
  assert(start >= 0, `slide ${id} is in the deck`)
  const end = html.indexOf('<section class="slide"', start + 10)
  return html.slice(start, end < 0 ? undefined : end)
}

// 1. {cta-screenshots}: a list-item action token is a button, never raw "[Action: …]" text.
{
  const cta = slideHtml('cta')
  assert(!cta.includes('[Action:'), 'cta-screenshots: the action token is not shown as raw text')
  assert.match(cta, /class="slide-action[^"]*"[^>]*href="https:\/\/example\.com"|href="https:\/\/example\.com"[^>]*class="slide-action/, 'cta-screenshots: the action renders as a button link')
  assert.match(cta, /Get the starter kit/, 'cta-screenshots: the button carries its label')
  assert.match(cta, /Try an agent on one real task/, 'cta-screenshots: the plain callout stays a callout')
}

// 2. {flow=branch} over a flat list: the first item fans out to the others.
{
  const branch = slideHtml('branch')
  assert.match(branch, /class="flow flow-branch"/, 'flow=branch: the branch flow is drawn')
  assert.match(branch, /class="flow-fan"/, 'flow=branch: a fan joins the root to its branches')
  assert.equal((branch.match(/flow-node flow-child/g) ?? []).length, 3, 'flow=branch: the three later items are the branches')
}

// 3. {flow=vertical}: the connector between stacked boxes owns the arrow's length (no overlap).
const css = buildDeckStyles()
assert.match(css, /\.flow\.flow-vertical \.flow-connector\s*\{[^}]*height:\s*calc\(/, 'flow=vertical: the connector has a height, so its arrow sits between the boxes')

// 4–5. {system-map} (plain and multicolour): parent bullet = centre, sub-bullets = satellites.
for (const id of ['map', 'map-multi']) {
  const map = slideHtml(id)
  assert.match(map, /class="system-centre">AI agent</, `${id}: the parent bullet is the centre`)
  assert(!/system-centre">result</.test(map), `${id}: no placeholder "result" centre`)
  assert.equal((map.match(/class="system-sat"/g) ?? []).length, id === 'map' ? 5 : 2, `${id}: every sub-bullet is a satellite`)
}
assert.match(slideHtml('map-multi'), /system-map system-multicolour/, 'multicolour still marks the map')

// 6. {timeline=compact}: two columns read down the first column, then the second.
{
  const compact = slideHtml('compact')
  assert.match(compact, /--tl-compact-rows:3/, 'timeline=compact: five rows split 3 + 2, column by column')
  assert.match(css, /\.timeline\.timeline-compact \.tl-entries\s*\{[^}]*grid-auto-flow:\s*column/, 'timeline=compact: the grid flows down columns')
}

// 7. {timeline=horizontal}: the continuation slide is drawn AND presented.
{
  const ids = model.slides.map((s) => s.id)
  const beats = model.beats.map((b) => b.slideId)
  assert(ids.includes('horizontal-2'), 'timeline=horizontal: four stops over the cap emit a continuation slide')
  assert(beats.includes('horizontal-2'), 'timeline=horizontal: the continuation is in the presented sequence')
  assert.equal(beats.indexOf('horizontal-2'), beats.indexOf('horizontal') + 1, 'timeline=horizontal: the continuation follows its first part')
  assert(!model.warnings.some((w) => String(w).startsWith('beats-records-mismatch')), 'no beats-records-mismatch')
}

// 8. {stats}: the documented `- 1 billion: weekly users` keeps the whole value and drops the colon.
assert.deepEqual(parseStatItem('1 billion: weekly users'), { value: '1 billion', label: 'weekly users' }, 'stats: value with its unit, no colon')
assert.deepEqual(parseStatItem('12: steps in a typical run'), { value: '12', label: 'steps in a typical run' }, 'stats: the colon leaves the number')
assert.deepEqual(parseStatItem('10:30 meeting starts'), { value: '10:30', label: 'meeting starts' }, 'stats: a time keeps its colon')
// Review (Sol, 6af2df9c): the colon form only takes a value that begins with a number; prose with a digit stays a caption.
assert.deepEqual(parseStatItem('ISO 9001: quality management'), { value: '', label: 'ISO 9001: quality management' }, 'stats: prose with a digit is a caption')
assert.deepEqual(parseStatItem('Version 2: now available'), { value: '', label: 'Version 2: now available' }, 'stats: prose with a digit is a caption')
assert.deepEqual(parseStatItem('1 000: users'), { value: '1 000', label: 'users' }, 'stats: grouped digits')
assert.deepEqual(parseStatItem('1,5: litres'), { value: '1,5', label: 'litres' }, 'stats: a decimal comma')
assert.deepEqual(parseStatItem('40 min: of work while you sleep'), { value: '40 min', label: 'of work while you sleep' }, 'stats: a unit word')

console.log('broken layouts 0.44: 7 slide checks passed (cta, branch, vertical, system-map x2, compact, horizontal)')
