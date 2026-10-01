// =============================================================================
// test:readable-cards-look — ADR-0028 decision 5 (slide design, 2026-09-25)
//
// What must hold:
//   1. Icon rows read at the body size (3.2cqw) with no whole-slide zoom; each column heading is
//      bold (≥700) and ≥1.1× its items; the icon is 1.35em of the body (~55px at 1280).
//   2. Icon-row columns share one heading row: when one heading wraps and its neighbour does not,
//      both columns' items still start at the same height.
//   3. Cards (logolist with sub-items): no word runs past its card; the heading is bold and 1.15×
//      its items at whatever size the width step reached (never under the dense step); cards whose
//      words fit keep the body size.
//   4. A crowded icon row or card list spends spacing before type: no whole-slide zoom, and type
//      steps only once --list-gap has reached the spaced floor (.3).
//   5. Tables and timeline entries are untouched: no width step on them, table cells at the body
//      token, timeline entries still below it.
//
// Compiles a real deck (prepareSource → model.fullHtml) with the round-2 specimens and reads
// computed styles and rects in Chromium at 1280×720 and 1600×900 after the runtime fit pass.
// ADR-0030: both windows show the one 1280×720 canvas; rects are read in canvas px.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const BODY_CQW = 3.2
const DENSE_CQW = 2.6
// Slide round 2 (0.37, ADR-0033 1): a table's text is 2.2cqw (42px at 1920), tighter than the 3.2cqw list body.
const TABLE_CQW = 2.2
const SPACED_GAP_MIN = 0.3
const dir = mkdtempSync(join(tmpdir(), 'tw-readable-cards-'))
const source = [
  '---', 'title: Readable cards probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Specimens', '',
  // Round-2 specimens (current-state-ai-agents-2026): f01qg, lbbyz, model-families.
  '### ChatGPT Web v Desktop key differences', '{iconrow}{id=f01qg}', '',
  '- ChatGPT Web', '  - Web-based app', '  - Uses basic tools', '  - Works on uploaded files',
  '- ChatGPT Desktop', '  - Desktop app', '  - Uses tools in local sandbox', '  - Works on local files', '',
  '### The Evolution of Agents', '{iconrow} {id=lbbyz}', '',
  '- AI as oracle  {icon=lucide:brain-circuit}', '  - Ask a question; get an answer, translation or summary.',
  '- AI as tool maker  {icon=tabler:tools}', '  - Ask it to write code, visualise data or make a small app.',
  '- AI as tool user  {icon=lucide:monitor-cloud}', '  - It can work with files and software to complete a task.', '',
  '### Current models families', '{logolist} {narrowcols=off} {id=model-families}', '',
  '- OpenAI – GPT 6', '  - Luna', '  - Sol', '  - Astra',
  '- Anthropic – Claude 5', '  - Sonnet', '  - Opus', '  - Fable',
  '- Google – Gemini 3', '  - Flash Lite', '  - Flash', '  - Pro', '',
  // One heading wraps, the other does not.
  '### Uneven headings', '{iconrow} {id=uneven}', '',
  '- Web {icon=lucide:globe}', '  - Runs in a browser tab', '  - Nothing to install',
  '- A desktop app with a much longer heading {icon=lucide:monitor}', '  - Runs on your machine', '  - Reads local files', '',
  // Cards whose words all fit at the body size.
  '### Short card words', '{logolist} {narrowcols=off} {id=cards-short}', '',
  '- OpenAI', '  - Luna', '  - Sol',
  '- Anthropic', '  - Opus', '  - Fable', '',
  // Crowded: more than the band holds at the drawn spacing.
  '### Crowded icon row', '{iconrow} {id=row-crowded}', '',
  '- Read {icon=lucide:book-open}', '  - Opens the file', '  - Finds the section', '  - Quotes the passage', '  - Checks the source', '  - Notes the page', '  - Cross-checks the date', '  - Files the reference',
  '- Plan {icon=lucide:list-checks}', '  - Lists the steps', '  - Orders the work', '  - Names the risks', '  - Sets the checks', '  - Asks for approval', '  - Splits the task', '  - Estimates the cost',
  '- Act {icon=lucide:hammer}', '  - Edits the file', '  - Runs the tests', '  - Reads the output', '  - Fixes the failure', '  - Reports the result', '  - Logs the change', '  - Cleans the workspace', '',
  '### Crowded cards', '{logolist} {narrowcols=off} {id=cards-crowded}', '',
  '- OpenAI', '  - Luna', '  - Sol', '  - Astra', '  - Nova', '  - Terra', '  - Vega', '  - Lyra', '  - Orion', '  - Rhea',
  '- Meta', '  - Haiku', '  - Sonnet', '  - Opus', '  - Fable', '  - Verse', '  - Prose', '  - Ode', '  - Epic', '  - Saga',
  '- Google', '  - Flash', '  - Pro', '  - Ultra', '  - Nano', '  - Gemma', '  - Lite', '  - Mini', '  - Max', '  - Edge', '',
  // Untouched structures.
  '### A table', '{table}{table-header=off}{id=table}', '',
  '| Oracle | answer questions, summarise, translate |', '| --- | --- |',
  '| Tool maker | write code, manage a code base |', '| Tool user | plan, work with files, run utilities |', '',
  '### A timeline', '{timelinehorizontal}{id=timeline}', '', '**Timeline:**', '',
  '- 2022', '  - ChatGPT released', '- 2024', '  - Mass adoption', '- 2026', '  - AI agents happen'
].join('\n')
const path = join(dir, 'readable-cards.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Readable cards probe', statSync(path))
const htmlPath = join(dir, 'readable-cards.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const close = (a, b, tolerance = 0.6) => Math.abs(a - b) <= tolerance
const weight = (value) => parseInt(value, 10)

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const probe = (id) => page.evaluate((slideId) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.id === slideId)
      if (!slide) return null
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      window.__autofitForTest?.()
      const content = slide.querySelector(':scope > .slide-content')
      const stageWidth = slide.parentElement.clientWidth
      // Canvas px (ADR-0030): the slide lives on the 1280×720 stage, scaled to the window; a painted
      // rect is read relative to the stage and divided by the stage's scale.
      const sr = slide.parentElement.getBoundingClientRect(), k = sr.width / slide.parentElement.offsetWidth
      const R = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
      const token = (name) => {
        const inline = content.style.getPropertyValue(name)
        content.style.removeProperty(name)
        const el = document.createElement('span')
        el.style.cssText = `position:absolute;visibility:hidden;font-size:var(${name})`
        content.append(el)
        const value = parseFloat(getComputedStyle(el).fontSize)
        el.remove()
        if (inline) content.style.setProperty(name, inline)
        return value
      }
      const style = (el) => getComputedStyle(el)
      const range = document.createRange()
      const inkRight = (el) => {
        range.selectNodeContents(el)
        return Math.max(-Infinity, ...[...range.getClientRects()].filter((r) => r.width > 0).map((r) => (r.right - sr.left) / k))
      }
      const slideStyle = style(slide)
      const contentStyle = style(content)
      const band = slide.clientHeight - parseFloat(slideStyle.paddingTop) - parseFloat(slideStyle.paddingBottom)
        - parseFloat(contentStyle.paddingTop) - parseFloat(contentStyle.paddingBottom)
      const railHead = slide.dataset.titleLayout === 'left' ? content.querySelector(':scope > .slide-head') : null
      let top = Infinity; let bottom = -Infinity
      for (const child of content.children) {
        if (child === railHead) continue
        const r = R(child)
        if (r.height <= 0) continue
        top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom)
      }
      const row = content.querySelector(':scope > .icon-row')
      const cards = content.querySelector(':scope > .feature-list')
      return {
        stageWidth,
        body: token('--fs-body'),
        dense: token('--fs-dense'),
        zoom: Number(style(content).zoom || 1),
        listFit: content.dataset.listFit || null,
        widthFit: content.dataset.listWidthFit || null,
        listGap: parseFloat(style(content).getPropertyValue('--list-gap')) || 1,
        overflowPx: bottom - top - band,
        columns: row && [...row.querySelectorAll(':scope > .ir-item')].map((item) => {
          const label = item.querySelector(':scope > .ir-label')
          const icon = item.querySelector(':scope > .ir-icon')
          const firstDesc = item.querySelector('.ir-desc > li')
          return {
            labelPx: parseFloat(style(label).fontSize), labelWeight: style(label).fontWeight,
            labelHeight: R(label).height,
            iconWidth: R(icon).width,
            descPx: [...item.querySelectorAll('.ir-desc > li')].map((li) => parseFloat(style(li).fontSize)),
            descTop: R(firstDesc).top,
            wordOverflow: [label, ...item.querySelectorAll('.ir-desc > li')].some((el) => inkRight(el) > R(item).right + 0.5)
          }
        }),
        cards: cards && [...cards.querySelectorAll(':scope > li')].map((card) => {
          const heading = card.querySelector(':scope > .fl-text')
          const limit = R(card).right - parseFloat(style(card).paddingRight) + 0.5
          return {
            headingPx: parseFloat(style(heading).fontSize), headingWeight: style(heading).fontWeight,
            subPx: [...card.querySelectorAll(':scope > .fl-sublist > li')].map((li) => parseFloat(style(li).fontSize)),
            wordOverflow: [heading, ...card.querySelectorAll('.fl-subtext')].some((el) => inkRight(el) > limit)
          }
        }),
        tableCellPx: [...content.querySelectorAll('.slide-table td')].map((td) => parseFloat(style(td).fontSize)),
        timelineEntryPx: [...content.querySelectorAll('.timeline li li, .tl-entries li')].map((li) => parseFloat(style(li).fontSize))
      }
    }, id)

    // 1. Icon rows at the body size, no zoom, prominent headings, larger icons.
    for (const id of ['f01qg', 'lbbyz']) {
      const slide = await probe(id)
      assert(slide?.columns?.length >= 2, `${key} ${id}: compiles to an icon row`)
      const bodyPx = slide.stageWidth * BODY_CQW / 100
      assert(close(slide.body, bodyPx), `${key} ${id}: body token is 3.2cqw`)
      assert.equal(slide.zoom, 1, `${key} ${id}: no whole-slide zoom (got ${slide.zoom})`)
      for (const [i, column] of slide.columns.entries()) {
        const label = `${key} ${id} column ${i + 1}`
        column.descPx.forEach((px) => assert(close(px, bodyPx), `${label}: item reads at the body size (${px}px vs ${bodyPx.toFixed(2)}px)`))
        assert(column.labelPx >= 1.1 * column.descPx[0] - 0.01, `${label}: heading ≥1.1× its items (${column.labelPx} vs ${column.descPx[0]})`)
        assert(weight(column.labelWeight) >= 700, `${label}: heading is bold (${column.labelWeight})`)
        assert(close(column.iconWidth, 1.35 * bodyPx, 1), `${label}: icon is 1.35em of the body (${column.iconWidth.toFixed(1)}px vs ${(1.35 * bodyPx).toFixed(1)}px)`)
        assert(!column.wordOverflow, `${label}: no word runs out of its column`)
      }
      console.log(`PASS ${key} ${id}: body ${slide.columns[0].descPx[0]}px, heading ${slide.columns[0].labelPx}px/${slide.columns[0].labelWeight}, icon ${slide.columns[0].iconWidth.toFixed(1)}px, zoom 1`)
    }

    // 2. Shared heading row: the items start at one height when only one heading wraps.
    const uneven = await probe('uneven')
    const [short, long] = uneven.columns
    assert(long.labelHeight > short.labelHeight * 1.5, `${key}: the long heading wraps and the short one does not (${long.labelHeight.toFixed(1)} vs ${short.labelHeight.toFixed(1)})`)
    assert(close(short.descTop, long.descTop, 1), `${key}: both columns' items start at one height (${short.descTop.toFixed(1)} vs ${long.descTop.toFixed(1)})`)
    console.log(`PASS ${key}: icon-row columns share a heading row (items at y=${short.descTop.toFixed(1)})`)

    // 3. Cards: width step keeps every word inside its card, heading ratio held.
    const families = await probe('model-families')
    assert.equal(families.cards.length, 3, `${key}: three cards`)
    for (const [i, card] of families.cards.entries()) {
      const label = `${key} model-families card ${i + 1}`
      assert(!card.wordOverflow, `${label}: no word overflows its card`)
      card.subPx.forEach((px) => {
        assert(close(card.headingPx / px, 1.15, 0.01), `${label}: heading is 1.15× its items (${card.headingPx} / ${px})`)
        assert(px <= families.body + 0.01 && px >= families.dense - 0.01, `${label}: items between the dense step and the body (${px}px)`)
      })
      assert(weight(card.headingWeight) >= 700, `${label}: heading is bold (${card.headingWeight})`)
    }
    assert.equal(families.zoom, 1, `${key}: model-families is not zoomed`)
    console.log(`PASS ${key} model-families: no word overflows; items ${families.cards[0].subPx[0]}px (width step ${families.widthFit ?? 'none'}), heading ${families.cards[0].headingPx}px`)
    const shortCards = await probe('cards-short')
    shortCards.cards.forEach((card, i) => card.subPx.forEach((px) => assert(close(px, shortCards.body), `${key} cards-short card ${i + 1}: words that fit keep the body size (${px}px vs ${shortCards.body}px)`)))
    assert.equal(shortCards.widthFit, null, `${key}: cards whose words fit take no width step`)
    console.log(`PASS ${key} cards-short: items at the body size ${shortCards.body}px, no width step`)

    // 4. Crowded rows and cards: spacing before type, never a whole-slide zoom while spacing gives.
    for (const id of ['row-crowded', 'cards-crowded']) {
      const slide = await probe(id)
      assert(['leading', 'gap', 'type'].includes(slide.listFit), `${key} ${id}: the fitter had to work (${slide.listFit})`)
      assert(slide.overflowPx <= 1, `${key} ${id}: fits its band (${slide.overflowPx.toFixed(1)}px over)`)
      assert.equal(slide.zoom, 1, `${key} ${id}: no whole-slide zoom (got ${slide.zoom})`)
      if (slide.listFit === 'type') assert(close(slide.listGap, SPACED_GAP_MIN, 0.001), `${key} ${id}: type stepped only after spacing reached its floor (--list-gap ${slide.listGap})`)
      console.log(`PASS ${key} ${id}: fitted by ${slide.listFit}, --list-gap ${slide.listGap}, no zoom`)
    }

    // 5. Tables keep their own size, timeline entries read at the body size (ADR-0033 §8); the width step never touches them.
    const table = await probe('table')
    assert.equal(table.widthFit, null, `${key}: no width step on a table`)
    table.tableCellPx.forEach((px) => assert(close(px, table.stageWidth * TABLE_CQW / 100), `${key}: table cells at the table token (${px}px)`))
    const timeline = await probe('timeline')
    assert(timeline.timelineEntryPx.length >= 3, `${key}: timeline entries render`)
    assert.equal(timeline.widthFit, null, `${key}: no width step on a timeline`)
    timeline.timelineEntryPx.forEach((px) => assert(close(px, timeline.stageWidth * BODY_CQW / 100) || px <= timeline.stageWidth * BODY_CQW / 100, `${key}: timeline entries at the body size, never above it (${px}px; ADR-0033 §8)`))
    console.log(`PASS ${key}: tables (${table.tableCellPx[0]}px) and timeline entries (${timeline.timelineEntryPx[0]}px) untouched`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('readable cards look (ADR-0028 §5): all checks passed')
