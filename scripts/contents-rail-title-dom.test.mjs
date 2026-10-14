// =============================================================================
// A slide with a sidebar title (data-title-layout="left") inside a section that shows its
// contents rail (.ct-rail-host) used to draw both in the same left strip: the rail sat on top of
// the title column and hid the start of the title. The title column now starts where the rail
// ends (compiler/assets/styles/contents-rail-title-column.css).
//
// This gate compiles a contents section whose slides carry a sidebar title at every Placement
// width (default, 30, 35, 40, 50) and asserts, from the browser's layout boxes at 1280x720:
//   1. the contents rail box and the title (head) box do not overlap;
//   2. the title box lies wholly inside the slide;
//   3. the body starts at or after the title column's right edge;
//   4. the title column is wider for 50 than for 30 (the widths still mean something).
// Mutation: with the contents-rail-title-column.css block removed from the deck styles, 1 fails.
// TW_SIDEBAR_SHOTS=<dir> saves screenshots.
// =============================================================================
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const shots = process.env.TW_SIDEBAR_SHOTS
if (shots) await mkdir(shots, { recursive: true })

const SOURCE = `---
title: Sidebar in contents probe
auto_title_slide: false
auto_thanks_slide: false
---

## Market day

### Fresh every week {id=sec contents}

#### Fresh every week {id=c-default sidebar}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village

#### Rain or shine {id=c-30 split=30}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village

#### Bring your own bag {id=c-35 split=35}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village

#### Meet the growers {id=c-40 split=40}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village

#### Pay what you can {id=c-50 split=50}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village

#### Plain slide for comparison {id=c-plain}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village

#### Top title for comparison {id=c-top titletop}

First paragraph about the stalls and what arrives each morning from local farms.

Second paragraph about how the prices are set on the day.

- Seasonal vegetables
- Eggs and honey
- Bread from the village
`

const IDS = ['c-default', 'c-30', 'c-35', 'c-40', 'c-50']

const dir = await mkdtemp(join(tmpdir(), 'tw-contents-rail-title-'))
const path = join(dir, 'fixture.md')
await writeFile(path, SOURCE)
const model = await prepareSource(path, SOURCE, 'fixture', statSync(path))
const out = join(dir, 'fixture.html')
await writeFile(out, model.fullHtml)

const MEASURE = () => {
  const slide = document.querySelector('.slide.active')
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const rail = slide.querySelector(':scope > .ct-rail')
  const head = slide.querySelector(':scope > .slide-content > .slide-head')
  const h1 = head.querySelector('h1')
  const body = slide.querySelector(':scope > .slide-content > :not(.slide-head)')
  return {
    layout: slide.dataset.titleLayout,
    rail: rail && box(rail), head: box(head), h1: box(h1), body: box(body), slide: box(slide),
    tintBands: getComputedStyle(slide).backgroundImage,
  }
}

const browser = await chromium.launch({ headless: true })
const errors = []
const widths = {}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (error) => errors.push(error.message))
  for (const id of IDS) {
    await page.goto(pathToFileURL(out).href + '#' + id)
    await page.waitForFunction((slideId) => document.querySelector('.slide.active')?.dataset.id === slideId && document.querySelector('.slide.active > .ct-rail'), id)
    await page.waitForTimeout(250)
    const m = await page.evaluate(MEASURE)
    if (shots) await page.screenshot({ path: join(shots, `contents-rail-title-${id}.png`) })
    assert.equal(m.layout, 'left', `${id}: fixture slide has a sidebar title`)
    assert.ok(m.rail, `${id}: the contents rail is painted`)
    const overlapW = Math.min(m.rail.r, m.head.r) - Math.max(m.rail.l, m.head.l)
    const overlapH = Math.min(m.rail.b, m.head.b) - Math.max(m.rail.t, m.head.t)
    assert.ok(!(overlapW > 0.5 && overlapH > 0.5), `${id}: rail and title overlap (${overlapW.toFixed(1)} x ${overlapH.toFixed(1)} px)`)
    assert.ok(m.h1.l >= m.rail.r - 0.5, `${id}: title starts at ${m.h1.l.toFixed(1)}, left of the rail's right edge ${m.rail.r.toFixed(1)}`)
    for (const [name, b] of [['head', m.head], ['title text', m.h1]]) {
      assert.ok(b.l >= m.slide.l - 0.5 && b.t >= m.slide.t - 0.5 && b.r <= m.slide.r + 0.5 && b.b <= m.slide.b + 0.5, `${id}: ${name} box is not inside the slide`)
    }
    assert.ok(m.body.l >= m.head.r - 0.5, `${id}: body starts at ${m.body.l.toFixed(1)}, inside the title column (right edge ${m.head.r.toFixed(1)})`)
    widths[id] = m.head.r - m.head.l
  }
  assert.ok(widths['c-50'] > widths['c-40'] && widths['c-40'] > widths['c-35'] && widths['c-35'] > widths['c-30'], `title column widths rise with the split: ${JSON.stringify(widths)}`)
  assert.deepEqual(errors, [], 'no page errors')
} finally {
  await browser.close()
}
console.log('contents-rail title column: ok', JSON.stringify(Object.fromEntries(Object.entries(widths).map(([k, v]) => [k, Math.round(v)]))))
