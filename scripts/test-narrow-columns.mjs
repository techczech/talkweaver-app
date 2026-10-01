// =============================================================================
// test:narrow-columns — ADR-0033 §5 (slide design round 2, ticket 07)
//
// Columns that would fall under 22cqw change shape, as a setting (on by default, {narrowcols=off}
// per slide, `narrow_columns: off` talk-wide), and an authored shape always wins.
//
//   1. The deciding module (compiler/scripts/lib/narrow-columns.mjs): setting precedence, usable
//      width, which card counts and icon-row counts are too narrow.
//   2. The compile step: the specimen slides of the design pack (it16 five roles, it107 what this
//      means, ex42 model families) stamp the shape; every switch and every authored shape leaves
//      today's markup alone.
//   3. The look, in Chromium at 1280x720 after the runtime fit pass: it16 renders 3 + 2 with no clipped
//      label, it107 and ex42 render as rows, "Anthropic - Claude" stays on one line with its models
//      inline; with the setting off the columns are today's.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import {
  NARROW_COLUMN_CQW, cardsTooNarrow, iconRowPerRow, resolveNarrowColumns, usableWidthCqw, withColumnWidth
} from '../compiler/scripts/lib/narrow-columns.mjs'

// ── 1. The deciding module ────────────────────────────────────────────────────
const RAIL = { mode: 'left', split: '35' }
const TOP = { mode: 'top', split: '' }
assert.equal(NARROW_COLUMN_CQW, 22, 'the threshold is 22cqw')
assert.equal(resolveNarrowColumns({}, {}), true, 'on by default')
assert.equal(resolveNarrowColumns({}, { narrow_columns: false }), false, 'deck off (boolean)')
assert.equal(resolveNarrowColumns({}, { narrow_columns: 'off' }), false, 'deck off (word)')
assert.equal(resolveNarrowColumns({}, { 'narrow-columns': 'no' }), false, 'deck off (alias)')
assert.equal(resolveNarrowColumns({ narrowcols: 'off' }, {}), false, 'slide off')
assert.equal(resolveNarrowColumns({ narrowcols: 'on' }, { narrow_columns: 'off' }), true, 'slide on beats deck off')
assert.equal(resolveNarrowColumns({ narrowcols: 'off' }, { narrow_columns: 'on' }), false, 'slide off beats deck on')
assert.equal(resolveNarrowColumns({ narrowcols: 'perhaps' }, { narrow_columns: 'perhaps' }), true, 'unreadable values keep the default')
assert(Math.abs(usableWidthCqw(RAIL) - 54.4) < 0.01, `a 35 rail leaves 54.4cqw (got ${usableWidthCqw(RAIL)})`)
assert(usableWidthCqw(TOP) > usableWidthCqw(RAIL), 'no rail leaves more room')
assert.equal(cardsTooNarrow(3, usableWidthCqw(RAIL)), true, 'three cards beside a rail are too narrow')
assert.equal(cardsTooNarrow(2, usableWidthCqw(RAIL)), false, 'two cards beside a rail still fit')
assert.equal(cardsTooNarrow(3, usableWidthCqw(TOP)), false, 'three cards at full width fit')
assert.equal(cardsTooNarrow(1, usableWidthCqw({ mode: 'left', split: '50' })), false, 'one card is never a row of columns')
assert.equal(iconRowPerRow(5, usableWidthCqw(TOP)), 3, 'five icon columns at full width wrap to rows of three')
assert.equal(iconRowPerRow(6, usableWidthCqw(TOP)), 3, 'six wrap 3 + 3')
assert.equal(iconRowPerRow(4, usableWidthCqw(TOP)), 0, 'four icon columns keep one line (the ADR names five)')
assert.equal(iconRowPerRow(5, usableWidthCqw(RAIL)), 2, 'beside a rail an icon row wraps by two')
const blocks = [{ type: 'feature-list', items: ['a'] }, { type: 'paragraph', text: 'p' }]
assert.strictEqual(withColumnWidth(blocks, { enabled: false, titlePlacement: RAIL }), blocks, 'off marks nothing')
assert.equal(withColumnWidth(blocks, { enabled: true, titlePlacement: RAIL })[0].columnsUsableCqw, usableWidthCqw(RAIL), 'on marks a list with its width')
assert.equal(withColumnWidth(blocks, { enabled: true, titlePlacement: RAIL })[1].columnsUsableCqw, undefined, 'a paragraph is not marked')
console.log('PASS narrow-columns module: setting precedence, widths, thresholds')

// ── 2. The compile step ───────────────────────────────────────────────────────
const ROLES = [
  '- Assistant {icon=lucide:headset}', '  - Reduce time-consuming distracting tasks',
  '- Tutor {icon=tabler:chalkboard-teacher}', '  - Stage cognitive load through chunking and repetition',
  '- Consultant {icon=lucide:briefcase-business}', '  - Promote dialogic engagement to target cognitive load to learning',
  '- Translator {icon=lucide:languages}', '  - Reduce cognitive load taking away from task',
  '- Tool maker {icon=tabler:tools}', '  - Create useful tools for yourself and others to use in your research and study.'
]
const MEANS = ['- I am still using AI', '- I am using the same model power in a different context', '- ChatGPT is no longer my main interface to the large language model']
const FAMILIES = [
  '- OpenAI - GPT', '  - Luna', '  - Terra', '  - Sol', '  - Astra',
  '- Anthropic - Claude', '  - Haiku', '  - Sonnet', '  - Opus', '  - Fable',
  '- Google - Gemini', '  - Flash Lite', '  - Flash', '  - Pro', '  - Ultra'
]
const slides = (extra = '') => [
  '## Probe', '',
  '### Five roles AI can play to help you change your brain', `{iconrow} {id=roles}${extra}`, '', ...ROLES, '',
  '### Four roles', `{iconrow} {id=four}${extra}`, '', ...ROLES.slice(0, 8), '',
  '### What this means', `{iconlist} {id=means}${extra}`, '', ...MEANS, '',
  '### Two things beside the rail', '{iconlist} {id=two}', '', ...MEANS.slice(0, 2), '',
  '### What this means, authored boxes', '{iconlist=boxes} {id=means-boxes}', '', ...MEANS, '',
  '### What this means, on top', '{iconlist} {titletop} {id=means-top}', '', ...MEANS, '',
  '### Models come in families by size', `{logolist} {id=families}${extra}`, '', ...FAMILIES, ''
]
const compile = async (dir, name, { frontmatter = [], extra = '' } = {}) => {
  const source = ['---', 'title: Narrow columns probe', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '', ...slides(extra)].join('\n')
  const path = join(dir, `${name}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Narrow columns probe', statSync(path))
  const htmlPath = join(dir, `${name}.html`)
  writeFileSync(htmlPath, model.fullHtml, 'utf8')
  return { html: model.fullHtml, htmlPath, warnings: model.warnings ?? [] }
}
const section = (html, id) => html.match(new RegExp(`<section[^>]*data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''
const dir = mkdtempSync(join(tmpdir(), 'tw-narrow-columns-'))
const on = await compile(dir, 'on')
assert.match(section(on.html, 'roles'), /class="icon-row count-5 ir-rows ir-rows-3"/, 'it16: five roles stamp rows of three')
assert.doesNotMatch(section(on.html, 'four'), /ir-rows/, 'four icon-row columns keep today\'s shape')
assert.match(section(on.html, 'means'), /class="feature-list fl-iconlist-list fl-narrow-cols"/, 'it107: three cards beside a rail take the row shape')
assert.match(section(on.html, 'families'), /fl-iconlist-list fl-narrow-cols/, 'ex42: the logolist cards take the row shape')
assert.doesNotMatch(section(on.html, 'two'), /fl-iconlist-list/, 'two cards beside a rail still fit')
assert.doesNotMatch(section(on.html, 'means-boxes'), /fl-iconlist-list/, 'an authored {iconlist=boxes} wins')
assert.doesNotMatch(section(on.html, 'means-top'), /fl-iconlist-list/, 'three cards at full width keep their columns')
assert.equal(on.warnings.filter((w) => /narrow|unknown/i.test(String(w))).length, 0, `the new token raises no warning (${on.warnings})`)

const slideOff = await compile(dir, 'slide-off', { extra: ' {narrowcols=off}' })
for (const id of ['roles', 'means', 'families']) assert.doesNotMatch(section(slideOff.html, id), /ir-rows|fl-narrow-cols/, `{narrowcols=off} keeps ${id}'s columns`)
const deckOff = await compile(dir, 'deck-off', { frontmatter: ['narrow_columns: off'] })
for (const id of ['roles', 'means', 'families']) assert.doesNotMatch(section(deckOff.html, id), /ir-rows|fl-narrow-cols/, `narrow_columns: off keeps ${id}'s columns`)
const deckOffSlideOn = await compile(dir, 'deck-off-slide-on', { frontmatter: ['narrow_columns: off'], extra: ' {narrowcols=on}' })
assert.match(section(deckOffSlideOn.html, 'roles'), /ir-rows-3/, '{narrowcols=on} beats a deck that switched it off')
const deckBad = await compile(dir, 'deck-bad', { frontmatter: ['narrow_columns: perhaps'] })
assert.match(section(deckBad.html, 'roles'), /ir-rows-3/, 'an unreadable deck value keeps the default')
assert(deckBad.warnings.some((w) => /deck-flag-unknown:narrow_columns/.test(String(w))), 'an unreadable deck value says so')
console.log('PASS narrow-columns compile: stamps, switches, authored shapes')

// ── 3. The look ───────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true })
try {
  const open = async (htmlPath) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    return page
  }
  const probe = (page, id, selector) => page.evaluate(({ slideId, selector }) => {
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const slide = slides.find((node) => node.dataset.id === slideId)
    slides.forEach((node) => node.classList.toggle('active', node === slide))
    window.__autofitForTest?.()
    const stageEl = slide.parentElement, sr = stageEl.getBoundingClientRect(), k = sr.width / stageEl.offsetWidth
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
    const lines = (el) => {
      const range = document.createRange(); range.selectNodeContents(el)
      const bottoms = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => r.bottom)
      return bottoms.filter((b, i) => bottoms.findIndex((o) => Math.abs(o - b) < 4) === i).length
    }
    const list = slide.querySelector(`:scope > .slide-content > ${selector}`)
    return {
      cls: list.className,
      items: [...list.children].map((li) => {
        const text = li.querySelector('.fl-text, .ir-label')
        const sub = li.querySelector(':scope > .fl-sublist')
        return {
          box: rect(li),
          label: text ? { ...rect(text), lines: lines(text), clipped: text.scrollWidth > text.clientWidth + 1, whiteSpace: getComputedStyle(text).whiteSpace } : null,
          sub: sub ? { display: getComputedStyle(sub).display, items: [...sub.children].map((s) => ({ ...rect(s), after: getComputedStyle(s, '::after').content, before: getComputedStyle(s, '::before').content })) } : null
        }
      })
    }
  }, { slideId: id, selector })
  const tops = (items) => [...new Set(items.map((item) => Math.round(item.box.top)))]

  const onPage = await open(on.htmlPath)
  const roles = await probe(onPage, 'roles', '.icon-row')
  assert.equal(roles.items.length, 5)
  assert.equal(tops(roles.items).length, 2, 'it16: two rows')
  const firstRow = roles.items.filter((item) => Math.round(item.box.top) === tops(roles.items)[0])
  assert.equal(firstRow.length, 3, 'it16: three on the first row, two on the second')
  for (const item of roles.items) {
    assert(!item.label.clipped, 'it16: a label is never clipped')
    assert.equal(item.label.lines, 1, 'it16: a label stays on one line')
    assert(item.box.width / 12.8 >= NARROW_COLUMN_CQW, `it16: every column is at least 22cqw wide (got ${(item.box.width / 12.8).toFixed(1)})`)
  }
  const four = await probe(onPage, 'four', '.icon-row')
  assert.equal(tops(four.items).length, 1, 'four roles stay on one line')

  const means = await probe(onPage, 'means', '.feature-list')
  assert.equal(means.items.length, 3)
  assert.equal(new Set(means.items.map((item) => Math.round(item.box.left))).size, 1, 'it107: the three items stack in one column (rows)')
  assert(means.items[0].box.bottom <= means.items[1].box.top + 1 && means.items[1].box.bottom <= means.items[2].box.top + 1, 'it107: rows do not overlap')
  for (const item of means.items) assert(item.box.width / 12.8 >= 30, `it107: a row is wide (${(item.box.width / 12.8).toFixed(1)}cqw)`)
  const boxes = await probe(onPage, 'means-boxes', '.feature-list')
  assert.equal(tops(boxes.items).length, 1, 'an authored {iconlist=boxes} keeps its columns')

  const families = await probe(onPage, 'families', '.feature-list')
  assert.equal(families.items.length, 3)
  for (const [i, item] of families.items.entries()) {
    assert.equal(item.label.lines, 1, `ex42 family ${i + 1}: the name stays on one line`)
    assert.equal(item.label.whiteSpace, 'nowrap', `ex42 family ${i + 1}: the name never breaks (not after the dash)`)
    assert.equal(item.sub.display, 'flex', `ex42 family ${i + 1}: the models run inline`)
    assert(new Set(item.sub.items.map((s) => Math.round(s.top))).size === 1, `ex42 family ${i + 1}: the models share one line`)
    for (const [j, s] of item.sub.items.entries()) {
      assert.equal(s.before === 'none' || s.before === 'normal', true, `ex42 family ${i + 1} model ${j + 1}: no bullet`)
      assert.equal(s.after, j < item.sub.items.length - 1 ? '"·"' : 'none', `ex42 family ${i + 1} model ${j + 1}: a middle dot between models only`)
    }
  }
  await onPage.close()

  // Setting off: today's columns.
  const offPage = await open(deckOff.htmlPath)
  const offRoles = await probe(offPage, 'roles', '.icon-row')
  assert.equal(tops(offRoles.items).length, 1, 'off: the five roles stay on one line')
  const offMeans = await probe(offPage, 'means', '.feature-list')
  assert.equal(tops(offMeans.items).length, 1, 'off: the three cards stay side by side')
  const offFamilies = await probe(offPage, 'families', '.feature-list')
  assert.notEqual(offFamilies.items[0].sub.display, 'flex', 'off: the family sub-list is today\'s list, not inline')
  await offPage.close()
  console.log('PASS narrow-columns look: it16 3 + 2, it107 and ex42 rows, off restores today')
} finally {
  await browser.close()
}
console.log('narrow columns (ADR-0033 §5): all checks passed')
