// =============================================================================
// test:stats-chart-table-look — 0.41 ticket 10 (ADR-0039: stats, line chart and table in the scene design)
//
// Measured in Chromium at 1280 x 720 and 1600 x 900:
//   1. Stats: each figure is a bold accent number centred over its label; a short accent mark sits between figure and
//      label; the label is regular weight (not bold) and at the type floor or above; the row is centred on the stage; the
//      longest figure ("10,000,000") stays on one line inside its column.
//   2. Line chart: the line, dots and baseline are drawn (accent line, accent dots, ink baseline); the value and month
//      text is regular weight; the chart is centred on the stage and sits inside the stage.
//   3. Table: banded rows (every second body row tinted), first column in the accent at regular weight, no bold cell,
//      mono uppercase column head over an ink rule, hairline rules between rows, no column rules; a long table keeps the
//      banding and fits the stage.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-sct-'))
const ROWS = Array.from({ length: 8 }, (_, i) => `| Row ${i + 1} | Outputs are easier to find later | You need to save and name things well |`)
const source = [
  '---', 'title: Stats chart table look', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### Codex user growth', '{stats} {id=stats}', '', '- 100,000 users in January', '- 10,000,000 users in July', '',
  '### Codex user growth chart', '{linechart} {id=chart}', '', '- January: 0.1', '- February: 1', '- June: 5', '- July: 10', '',
  '### Bike hire by year', '{linechart} {id=chart-long}', '', ...[2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y, i) => `- ${y}: ${10 + i * 3}`), '',
  '### Trade-offs of local work', '{table} {id=table}', '', '| Aspect | Advantage | Trade-off |', '| --- | --- | --- |',
  '| Retrieval | Outputs are easier to find later | You need to save and name things well |',
  '| Scale | Easier to work across many local files | You must know what folder you share |',
  '| Privacy | Some tasks stay mostly local | Some tasks still use remote models |', '',
  '### Plain first column', '{table}{table-first-column=off} {id=table-plain-first}', '', '| Aspect | Advantage | Trade-off |', '| --- | --- | --- |',
  '| Retrieval | Outputs are easier to find later | You need to save and name things well |',
  '| Scale | Easier to work across many local files | You must know what folder you share |', '',
  '### Trade-offs long', '{table} {id=table-long}', '', '| Aspect | Advantage | Trade-off |', '| --- | --- | --- |', ...ROWS, ''
].join('\n')
const path = join(dir, 'sct.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Stats chart table look', statSync(path))
const deckPath = join(dir, 'sct.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')

let checks = 0
const ok = (name) => { checks += 1; console.log(`PASS ${name}`) }

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const look = async (id, fn) => page.evaluate(({ id, src }) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((s) => s.dataset.id === id)
      slides.forEach((s) => s.classList.toggle('active', s === slide))
      window.__autofitForTest?.()
      const stage = slide.parentElement
      const sr = stage.getBoundingClientRect(), k = sr.width / stage.offsetWidth
      const R = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
      const cs = (el, p) => getComputedStyle(el, p)
      const floor = (() => { const el = document.createElement('span'); el.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--type-floor)'; slide.append(el); const v = parseFloat(getComputedStyle(el).fontSize); el.remove(); return v })()
      return new Function('slide', 'stage', 'R', 'cs', 'k', 'floor', `return (${src})(slide, stage, R, cs, k, floor)`)(slide, stage, R, cs, k, floor)
    }, { id, src: fn.toString() })

    // 1. stats
    const st = await look('stats', (slide, stage, R, cs, k, floor) => {
      const row = slide.querySelector('.stats-row')
      const cells = [...row.querySelectorAll('.stat')]
      return {
        stageW: stage.offsetWidth, row: R(row),
        cells: cells.map((c) => {
          const v = c.querySelector('.stat-value'), l = c.querySelector('.stat-label')
          const mark = cs(v, '::after')
          return {
            vW: cs(v).fontWeight, vColor: cs(v).color, vPx: parseFloat(cs(v).fontSize), vBox: R(v), vLines: Math.round(R(v).height / (parseFloat(cs(v).fontSize) * parseFloat(cs(v).lineHeight === 'normal' ? '1' : String(parseFloat(cs(v).lineHeight) / parseFloat(cs(v).fontSize))))),
            markW: parseFloat(mark.width), markH: parseFloat(mark.height), markBg: mark.backgroundColor,
            lW: cs(l).fontWeight, lPx: parseFloat(cs(l).fontSize), lBox: R(l), cell: R(c), vTextAlign: cs(c).textAlign, accent: cs(slide).getPropertyValue('--accent').trim()
          }
        }), floor
      }
    })
    assert.equal(st.cells.length, 2, `${key} stats: two figures`)
    st.cells.forEach((c, i) => {
      assert(parseInt(c.vW, 10) >= 600, `${key} stats ${i + 1}: figure is bold (${c.vW})`)
      assert(c.vColor !== 'rgb(0, 0, 0)', `${key} stats ${i + 1}: figure in the accent (${c.vColor})`)
      assert(parseInt(c.lW, 10) <= 400, `${key} stats ${i + 1}: label is regular weight (${c.lW})`)
      assert(c.lPx >= st.floor - 0.01, `${key} stats ${i + 1}: label at the type floor or above (${c.lPx.toFixed(1)} vs ${st.floor.toFixed(1)})`)
      assert(Math.abs(c.markW - 44 * st.stageW / 1920) < 1, `${key} stats ${i + 1}: accent mark 44/1920 wide (${c.markW.toFixed(1)})`)
      assert(c.markH > 2 && c.markBg === c.vColor, `${key} stats ${i + 1}: the mark is in the accent (${c.markBg})`)
      assert(c.vBox.height < c.vPx * 1.6, `${key} stats ${i + 1}: figure stays on one line (${c.vBox.height.toFixed(0)} vs ${c.vPx.toFixed(0)})`)
      assert(Math.abs((c.vBox.left + c.vBox.right) / 2 - (c.lBox.left + c.lBox.right) / 2) < 2, `${key} stats ${i + 1}: figure and label share a centre`)
      assert(c.vBox.bottom <= c.lBox.top, `${key} stats ${i + 1}: figure above its label`)
    })
    const rowMid = (st.row.left + st.row.right) / 2
    assert(Math.abs(rowMid - st.stageW / 2) < 4, `${key} stats: row centred on the stage`)
    ok(`${key} stats: bold figures, accent marks, regular labels, centred`)

    // 2. line chart
    const ch = await look('chart', (slide, stage, R, cs, k, floor) => {
      const c = slide.querySelector('.chart-line'), svg = c.querySelector('svg')
      const txt = (sel) => [...svg.querySelectorAll(sel)].map((t) => ({ w: cs(t).fontWeight, px: parseFloat(cs(t).fontSize) * R(svg).width / 1000 }))
      return {
        stageW: stage.offsetWidth, stageH: stage.offsetHeight, box: R(c), svg: R(svg), floor,
        poly: { stroke: cs(svg.querySelector('.chart-poly')).stroke, w: parseFloat(cs(svg.querySelector('.chart-poly')).strokeWidth) },
        dot: { fill: cs(svg.querySelector('.chart-dot')).fill, n: svg.querySelectorAll('.chart-dot').length },
        base: cs(svg.querySelector('.chart-baseline')).stroke, accent: cs(svg.querySelector('.chart-poly')).stroke,
        vals: txt('.chart-val-svg'), labs: txt('.chart-label-svg')
      }
    })
    assert.equal(ch.dot.n, 4, `${key} chart: four dots`)
    assert.equal(ch.dot.fill, ch.poly.stroke, `${key} chart: dots and line share the accent`)
    assert.notEqual(ch.base, ch.poly.stroke, `${key} chart: the baseline is ink, not the accent`)
    ;[...ch.vals, ...ch.labs].forEach((t) => assert(parseInt(t.w, 10) <= 400, `${key} chart: text is regular weight (${t.w})`))
    ;[...ch.vals, ...ch.labs].forEach((t) => assert(t.px >= ch.floor - 0.7, `${key} chart: text at the type floor (${t.px.toFixed(1)}px vs ${ch.floor.toFixed(1)}px)`))
    assert(Math.abs((ch.box.left + ch.box.right) / 2 - ch.stageW / 2) < 4, `${key} chart: centred on the stage`)
    assert(ch.svg.top >= 0 && ch.svg.bottom <= ch.stageH, `${key} chart: inside the stage`)
    ok(`${key} chart: accent line and dots, regular text, centred`)

    // 2b. issue #233: with the title in a left rail the chart must stay inside the slide's content box (it once
    // forced the grid wider than the stage, so the last years were drawn past the right edge)
    const rail = await look('chart-long', (slide, stage, R) => {
      slide.dataset.titleLayout = 'left'
      window.__autofitForTest?.()
      const c = slide.querySelector('.chart-line'), svg = c.querySelector('svg')
      const vb = svg.viewBox.baseVal, dots = [...svg.querySelectorAll('.chart-dot')]
      const lastCx = parseFloat(dots[dots.length - 1].getAttribute('cx'))
      const sr = svg.getBoundingClientRect(), k = stage.getBoundingClientRect().width / stage.offsetWidth
      const content = R(slide.querySelector('.slide-content'))
      return {
        stageW: stage.offsetWidth, n: dots.length, vbW: vb.width, lastCx,
        lastX: R(dots[dots.length - 1]).right, svg: R(svg), content, scrollW: slide.querySelector('.slide-content').scrollWidth,
        scale: sr.width / k / vb.width
      }
    })
    assert.equal(rail.n, 8, `${key} rail chart: eight dots`)
    assert(rail.lastCx <= rail.vbW, `${key} rail chart: last point inside the viewBox (${rail.lastCx} of ${rail.vbW})`)
    assert(rail.svg.right <= rail.stageW + 0.5, `${key} rail chart: drawing inside the stage (${rail.svg.right.toFixed(1)} of ${rail.stageW})`)
    assert(rail.content.right <= rail.stageW + 0.5, `${key} rail chart: content box not pushed past the stage (${rail.content.right.toFixed(1)})`)
    assert(rail.lastX <= rail.content.right + 0.5, `${key} rail chart: last point (${rail.lastX.toFixed(1)}) inside the content box (${rail.content.right.toFixed(1)})`)
    ok(`${key} rail chart: last data point inside the slide`)

    // 3. tables
    for (const id of ['table', 'table-long']) {
      const t = await look(id, (slide, stage, R, cs, k, floor) => {
        const table = slide.querySelector('.slide-table')
        const bodyRows = [...table.querySelectorAll('tbody tr')]
        const th = table.querySelector('thead th')
        return {
          stageH: stage.offsetHeight, box: R(table), floor,
          rows: bodyRows.map((r) => ({ bg: cs(r.children[1]).backgroundColor, bgFirst: cs(r.children[0]).backgroundColor })),
          weights: [...table.querySelectorAll('tbody td, tbody th')].map((c) => cs(c).fontWeight),
          first: bodyRows.map((r) => ({ color: cs(r.children[0]).color, w: cs(r.children[0]).fontWeight })),
          other: cs(bodyRows[0].children[1]).color, accent: cs(slide).getPropertyValue('--accent').trim(),
          th: { family: cs(th).fontFamily, transform: cs(th).textTransform, w: cs(th).fontWeight, rule: parseFloat(cs(th).borderBottomWidth), ruleStyle: cs(th).borderBottomStyle, px: parseFloat(cs(th).fontSize) },
          td: { bottom: parseFloat(cs(bodyRows[0].children[1]).borderBottomWidth), left: parseFloat(cs(bodyRows[0].children[1]).borderLeftWidth) },
          hasNonEmpty: bodyRows.length
        }
      })
      const label = `${key} ${id}`
      const clear = 'rgba(0, 0, 0, 0)'
      t.rows.forEach((r, i) => {
        if (i % 2 === 1) assert.notEqual(r.bg, clear, `${label}: row ${i + 1} is banded`)
        else assert.equal(r.bg, clear, `${label}: row ${i + 1} is plain`)
      })
      t.weights.forEach((w) => assert(parseInt(w, 10) <= 400, `${label}: no bold body cell (${w})`))
      t.first.forEach((f, i) => { assert.notEqual(f.color, t.other, `${label}: row ${i + 1} first column is in the accent`) })
      assert.equal(t.th.transform, 'uppercase', `${label}: column head uppercase`)
      assert(parseInt(t.th.w, 10) <= 400, `${label}: column head regular weight`)
      assert(t.th.rule >= (id === 'table' ? 1.5 : 1) && t.th.ruleStyle === 'solid', `${label}: ink rule under the head (${t.th.rule.toFixed(2)}px)`)
      assert(t.td.bottom >= 0.5 && t.td.bottom < 3, `${label}: hairline between rows (${t.td.bottom.toFixed(2)}px)`)
      assert.equal(t.td.left, 0, `${label}: no column rule`)
      assert(t.th.px >= t.floor - 0.01, `${label}: column head at the type floor or above`)
      assert(t.box.top >= 0 && t.box.bottom <= t.stageH, `${label}: table inside the stage`)
      ok(`${label}: banded rows, accent first column, no bold`)
    }
    // {table-first-column=off}: same table, first column reads like the others (no accent), banding and weights unchanged
    const pf = await look('table-plain-first', (slide, stage, R, cs) => {
      const table = slide.querySelector('.slide-table')
      const rows = [...table.querySelectorAll('tbody tr')]
      return {
        cls: table.className, accent: cs(slide).getPropertyValue('--accent').trim(),
        first: rows.map((r) => ({ color: cs(r.children[0]).color, w: cs(r.children[0]).fontWeight })), other: cs(rows[0].children[1]).color,
        banded: cs(rows[1].children[1]).backgroundColor
      }
    })
    assert(/table-plain-first/.test(pf.cls), `${key} plain-first: the table carries table-plain-first`)
    pf.first.forEach((f, i) => { assert.equal(f.color, pf.other, `${key} plain-first: row ${i + 1} first column is the same ink as the others`); assert(parseInt(f.w, 10) <= 400, `${key} plain-first: regular weight`) })
    assert.notEqual(pf.banded, 'rgba(0, 0, 0, 0)', `${key} plain-first: banding kept`)
    ok(`${key} plain-first: first column not emphasised`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log(`stats-chart-table-look: ${checks} checks passed`)
