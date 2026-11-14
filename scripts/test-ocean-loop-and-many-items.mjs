// =============================================================================
// test:ocean-loop-and-many-items — two 0.44.0 regressions in the Ocean look (fit or fall back), measured in Chromium.
//
//   1. The loop ({cycle}): a stop's labels sit in one box outward from the ring, and no label box meets another
//      label, any stop, the ring or the title. Loops of 3 to 8 stops with labels of one, four and eight words, with and
//      without a role line, in the Ocean and Bold palettes: every state either keeps the look with nothing meeting, or
//      has fallen back to the safe drawing (data-look="ocean-safe").
//   2. Icon lists, boxes and rows of 4 to 8 items, short and long labels, beside the title and under it, and panels whose
//      labels are single long words: in every state that keeps the look, no word is broken inside itself and every line
//      of text lies inside its own item box; the panels keep the look (their labels step down, the words stay whole).
//      A passed stop of {focus} is not faded (its labels keep the muted ink, not the generic .6 opacity).
//   2b. Words no box holds whole (an e-mail and a web address, a file path, a German compound) in an icon row, a boxed
//      icon list and an org chart: in either drawing every line stays inside its own box. A loop with a sentence on the
//      slide: no label meets the sentence. A loop of long roles keeps the look; loops of single long words: no word runs
//      out of its label. Chinese items (a language written without spaces) in a list, a row, boxes, an org chart and
//      stats, and the links slide (its addresses break anywhere on purpose): drawn whole, they keep the look.
//   2c. Print: each case keeps on paper the drawing it shows on screen, and afterprint restores its markup exactly.
//   3. The decision is stable: a slide's look is the same at every reveal step and at 1600 x 900 and 1280 x 720, and
//      the handout page (the share page) decides the same as the deck.
//   4. The fixture shapes (scripts/fixtures/ocean-look/review-cases-outline.md r-loop5*, r-icon7*): the five-stop loop
//      with long labels keeps the look; the seven long icon items beside the title fall back.
//   5. palette: classic never gets the label box or a fit decision.
// The measures here are written apart from slide-fit.js's own predicates, so a predicate that stops seeing a fault
// fails this test.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { inClassicLook } from './lib/slide-markup-identity.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'tw-ocean-loop-items-'))
const HARD_LIMIT_MS = 600_000
const VIEWPORTS = [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]

const ROLES = ['Planner', 'Drafter', 'Reviewer', 'Editor', 'Layout', 'Printer', 'Courier', 'Archive']
const CAPS = {
  1: ['Plans', 'Drafts', 'Checks', 'Tidies', 'Arranges', 'Prints', 'Delivers', 'Stores'],
  4: ['Writes the first brief', 'Turns brief into draft', 'Reads and returns notes', 'Tidies the final wording', 'Sets out every page', 'Prints the bound copies', 'Carries copies to readers', 'Keeps one copy safe'],
  8: ['Writes the brief and hands it to the drafting desk', 'Turns the brief into a first full version for review', 'Reads the version and returns careful notes to the drafter', 'Tidies the wording and passes the text on to layout', 'Sets the pages and sends them back to the planner', 'Prints the copies and checks every page for faults', 'Carries the finished copies to readers across the region', 'Keeps one copy safe in the archive for later years'],
}
const ITEMS = {
  short: ['Soil', 'Water', 'Light', 'Seeds', 'Tools', 'Time', 'Notes', 'Help'],
  long: ['Responsibility for what neighbours need', 'Readiness to follow planting directions', 'Shelves of maps and seed catalogues', 'Patience with slow results', 'Talent for explaining choices clearly', 'Willingness to rethink the plan', 'Care for the soil underneath', 'Fairness in sharing the harvest'],
}
const ICONS = ['sprout', 'cloud-rain', 'map', 'hourglass', 'message-square', 'refresh-cw', 'shovel', 'basket']

function matrixOutline(palette) {
  const out = ['---', 'title: Loop and many items', 'auto_title_slide: false', 'auto_thanks_slide: false', ...(palette ? [`palette: ${palette}`] : []), '---', '', '## Cases', '']
  for (let n = 3; n <= 8; n += 1) {
    for (const words of [1, 4, 8]) {
      out.push(`### Loop ${n} with ${words}`, `{cycle}${words === 8 ? '{reveal}' : words === 4 ? '{focus}' : ''}{id=loop-${n}-${words}}`, '')
      for (let i = 0; i < n; i += 1) out.push(`- ${ROLES[i]}`, `  - ${CAPS[words][i]}`)
      out.push('')
    }
    out.push(`### Loop ${n} plain`, `{cycle}{id=loop-${n}-plain}`, '')
    for (let i = 0; i < n; i += 1) out.push(`- ${CAPS[4][i]}`)
    out.push('')
  }
  for (let n = 4; n <= 8; n += 1) {
    for (const length of ['short', 'long']) {
      for (const [kind, token] of [['list', '{iconlist}'], ['list-top', '{iconlist=list}{titletop}'], ['boxes', '{iconlist=boxes}'], ['row', '{iconrow}']]) {
        out.push(`### Items ${n} ${length} ${kind}`, `${token}${n === 7 && length === 'long' ? '{reveal}' : ''}{id=items-${n}-${length}-${kind}}`, '')
        for (let i = 0; i < n; i += 1) out.push(`- ${ITEMS[length][i]} {icon=lucide:${ICONS[i]}}`)
        out.push('')
      }
    }
  }
  // panels whose labels are single long words, in a narrow row beside the title (the 0.44 drawing broke them inside)
  const PANEL_WORDS = ['Horticultural', 'Environmental', 'Groundbreaking']
  out.push('### Panels of long words', '{iconrow}{sidebar}{id=panels-words}', '')
  PANEL_WORDS.forEach((word, i) => out.push(`- ${word} {icon=lucide:${ICONS[i]}}`, '  - what it does in the world'))
  out.push('', '### Panels of long words with details', '{sidebar}{iconrow}{id=panels-words-details}', '')
  for (const [i, label] of ['Gardener Productivity', 'Garden instrument', 'Garden subject'].entries()) out.push(`- ${label} {icon=lucide:${ICONS[i]}}`, '  - Visitor experience', '  - Seasonal performance', '  - Plant evaluation')
  out.push('', '### Rows of long names beside a wide title', '{sidebar}{split=45}{iconrow}{id=panels-rows}', '')
  for (const [i, label] of ['Neighbourhood Productivity', 'Garden instrument', 'Garden subject'].entries()) out.push(`- ${label} {icon=lucide:${ICONS[i]}}`, '  - Planting', '  - Watering')
  out.push('', '### Boxes with a long word', '{icons=top}{iconrow}{id=boxes-word}', '')
  for (const [i, label] of ['Garden Planning', 'Garden capabilities', 'Garden use', 'Garden characterisations', 'Garden Ecosystem'].entries()) out.push(`- ${label} {icon=lucide:${ICONS[i]}}`, '  - What are gardens like?')
  out.push('')
  // words no box holds whole (the review of PR 367): an e-mail and a web address, a file path and a German compound,
  // in an icon row, a boxed icon list and an org chart
  const TOKENS = { email: 'volunteer.coordinator@community-garden.example.org', web: 'https://community-garden.example.org/allotments/waiting-list', path: '/shared/garden-records/2026/allotment-waiting-list.xlsx', compound: 'Kleingartenvereinsvorstandssitzungsprotokoll' }
  for (const [kind, token] of Object.entries(TOKENS)) {
    out.push(`### Row with ${kind}`, `{iconrow}{id=tok-row-${kind}}`, '', `- Write to ${token} {icon=lucide:${ICONS[0]}}`, `- Soil and compost {icon=lucide:${ICONS[1]}}`, `- Seeds and tools {icon=lucide:${ICONS[2]}}`, '')
    out.push(`### Boxes with ${kind}`, `{iconlist=boxes}{id=tok-boxes-${kind}}`, '', `- Write to ${token} {icon=lucide:${ICONS[0]}}`, `- Soil and compost {icon=lucide:${ICONS[1]}}`, `- Seeds and tools {icon=lucide:${ICONS[2]}}`, `- Rain records {icon=lucide:${ICONS[3]}}`, '')
    out.push(`### Org chart with ${kind}`, `{orgchart}{id=tok-org-${kind}}`, '', '- Garden committee', `  - ${token}`, '  - Soil and compost', '  - Seeds and tools', '')
  }
  // a loop with a sentence on the same slide: no label may print over the sentence
  for (const n of [3, 4]) {
    out.push(`### Loop ${n} with a sentence`, `{cycle}{id=loop-sentence-${n}}`, '', 'Each season the garden committee goes round the same steps again.', '')
    for (let i = 0; i < n; i += 1) out.push(`- ${ROLES[i]}`, `  - ${CAPS[4][i]}`)
    out.push('')
  }
  // a short loop under or over a sentence (the review of PR 367): the top label goes beside its stop rather than fall back
  out.push('### Loop with sentence after', '{cycle}{id=loop-sentence-after}', '', '- Plan the beds', '- Sow the seeds', '- Water daily', '- Share the harvest', '', 'The committee repeats these steps every season, whatever the weather.', '')
  out.push('### Loop under a two-line sentence', '{cycle}{id=loop-sentence-two}', '', 'The garden committee repeats these four steps every single season, whatever the weather brings.', '', '- Plan the beds', '- Sow the seeds', '- Water daily', '- Share the harvest', '')
  // steps of 4 to 7 items of 4 to 10 words (the review of PR 367: 0.44 kept the look for most of them)
  const STEP_WORDS = 'The garden committee meets every second week to plan the next season of planting carefully'.split(' ')
  for (let n = 4; n <= 7; n += 1) {
    for (const words of [4, 5, 6, 7, 10]) {
      out.push(`### Steps ${n} by ${words}`, `{steps}{id=steps-${n}-${words}}`, '')
      for (let i = 0; i < n; i += 1) out.push(`- ${STEP_WORDS.slice(i, i + words).join(' ')}`)
      out.push('')
    }
  }
  // long roles with one-word texts take the smaller ring like long texts
  out.push('### Loop of long roles', '{cycle}{id=loop-long-roles}', '')
  for (let i = 0; i < 5; i += 1) out.push(`- ${CAPS[4][i]} today`, `  - ${CAPS[1][i]}`)
  out.push('')
  // a single long word per stop, seven and eight stops: no word may run out of its label box
  for (const n of [7, 8]) {
    out.push(`### Loop ${n} of long words`, `{cycle}{id=loop-words-${n}}`, '')
    for (let i = 0; i < n; i += 1) out.push(`- ${['Horticulturalists', 'Environmentalists', 'Groundbreaking', 'Neighbourhoods', 'Responsibilities', 'Characterisations', 'Transplantation', 'Recommendations'][i]}`)
    out.push('')
  }
  // a language written without spaces: drawn whole, so the slide keeps the look
  const ZH = ['学习如何照顾社区花园里的植物和土壤', '记录每个季节的降雨量和温度变化', '和邻居一起分享收获的蔬菜和水果']
  out.push('### Chinese list', '{id=zh-list}', '', ...ZH.map((t) => `- ${t}`), '')
  out.push('### Chinese row', '{iconrow}{id=zh-row}', '', ...ZH.map((t, i) => `- ${t} {icon=lucide:${ICONS[i]}}`), '')
  out.push('### Chinese boxes', '{iconlist=boxes}{id=zh-boxes}', '', ...ZH.map((t, i) => `- ${t} {icon=lucide:${ICONS[i]}}`), `- ${ZH[0]} {icon=lucide:${ICONS[3]}}`, '')
  out.push('### Chinese org chart', '{orgchart}{id=zh-org}', '', '- 社区花园委员会', ...ZH.map((t) => `  - ${t}`), '')
  out.push('### Chinese numbers', '{stats}{id=zh-stats}', '', '- 120: 个家庭参加了今年春天的种植活动', '- 3×: 比去年多的志愿者每周来帮忙', '')
  // the links slide: a long address wraps there on purpose
  out.push('### Where to read more', '{id=links-source}', '', '- The [allotment waiting list and its rules](https://community-garden.example.org/allotments/waiting-list/how-it-works-and-who-decides)', '')
  out.push('### Links', '{links}{id=links-slide}', '')
  return out.join('\n')
}

async function compile(name, path, text) {
  const model = await prepareSource(path, text, name, statSync(path), undefined, { allowedAssetRoots: [dirname(path)] })
  const htmlPath = join(work, `${name}.html`)
  writeFileSync(htmlPath, String(model.fullHtml), 'utf8')
  return { model, htmlPath }
}

// Measured in the page, apart from slide-fit.js. Rects in painted px; t is two canvas px at the stage's scale.
function measureActive() {
  // transitions (a passed stop fading) are measured at their end
  document.getAnimations().forEach((animation) => { try { animation.finish() } catch {} })
  const slide = document.querySelector('.slide.active') || document.querySelector('.stage > .slide')
  const scale = slide.getBoundingClientRect().width / (slide.offsetWidth || 1)
  const t = 2 * scale
  const meet = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > t && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > t
  const faults = []
  // text outside a staircase step (.step-col): a finding of the review of PR 377, recorded and printed, not a failure
  // here; 0.44.0 draws it the same (a long label runs below a short step, a long word past a narrow column)
  const stepOverhang = []
  const look = slide.dataset.look || ''
  const range = document.createRange()
  if (look === 'ocean') {
    for (const ring of slide.querySelectorAll('.cycle-diagram')) {
      const nodes = [...ring.querySelectorAll(':scope > .cycle-node')]
      const discs = nodes.map((node) => node.getBoundingClientRect())
      const labels = nodes.map((node) => node.querySelector('.oc-loop-label'))
      if (labels.some((label) => !label)) faults.push('a stop has no label box')
      const boxes = labels.map((label) => label?.getBoundingClientRect())
      const cx = discs.reduce((s, d) => s + (d.left + d.right) / 2, 0) / discs.length
      const cy = discs.reduce((s, d) => s + (d.top + d.bottom) / 2, 0) / discs.length
      const r = discs.reduce((s, d) => s + Math.hypot((d.left + d.right) / 2 - cx, (d.top + d.bottom) / 2 - cy), 0) / discs.length
      const head = slide.querySelector('.slide-head')?.getBoundingClientRect()
      const content = slide.querySelector('.slide-content')
      // the slide's other blocks, each widened by the 1.5cqw gap a label keeps from them
      const gap = slide.getBoundingClientRect().width * 0.015
      const others = [...content.children].filter((el) => !el.contains(ring) && !el.matches('.slide-head, .notes, .sr-only, script, style, template') && getComputedStyle(el).display !== 'none').map((el) => el.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({ left: rect.left - gap, right: rect.right + gap, top: rect.top - gap, bottom: rect.bottom + gap }))
      labels.forEach((label, i) => { if (label && label.scrollWidth > label.clientWidth + 1) faults.push(`a word runs out of label ${i + 1}`) })
      boxes.forEach((box, i) => {
        if (!box) return
        boxes.forEach((other, j) => { if (j > i && other && meet(box, other)) faults.push(`label ${i + 1} meets label ${j + 1}`) })
        discs.forEach((disc, j) => { if (meet(box, disc)) faults.push(`label ${i + 1} meets stop ${j + 1}`) })
        if (head && head.width > 0 && meet(box, head)) faults.push(`label ${i + 1} meets the title`)
        if (others.some((other) => meet(box, other))) faults.push(`label ${i + 1} meets another block of the slide`)
        const nx = Math.max(box.left, Math.min(cx, box.right))
        const ny = Math.max(box.top, Math.min(cy, box.bottom))
        if (discs.length > 2 && Math.hypot(nx - cx, ny - cy) < r - t) faults.push(`label ${i + 1} crosses the ring`)
      })
    }
  }
  // in both drawings: no line of text outside its own drawn box; in the look, no word broken inside itself (words as the
  // platform segments them; text that breaks anywhere on purpose is not looked at)
  if (look === 'ocean' || look === 'ocean-safe') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    for (const box of slide.querySelectorAll('.feature-list > li, .icon-row > .ir-item, .steps-diagram > .step-col, .orgchart .org-box, .stats-row > .stat, .cycle-diagram .oc-loop-label')) {
      const own = box.getBoundingClientRect()
      const cs = getComputedStyle(box)
      const drawn = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
      for (let node; (node = walker.nextNode());) {
        if (!node.data.trim() || node.parentElement.closest('svg, .sr-only')) continue
        range.selectNodeContents(node)
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5)
        if (drawn && rects.some((rect) => rect.left < own.left - t || rect.right > own.right + t || rect.top < own.top - t || rect.bottom > own.bottom + t)) {
          if (box.matches('.steps-diagram > .step-col')) stepOverhang.push(Math.round(Math.max(...rects.map((rect) => Math.max(rect.bottom - own.bottom, rect.right - own.right, own.left - rect.left))) / scale))
          else faults.push(`"${node.data.trim().slice(0, 24)}" stands outside its box`)
        }
        // an emergency break only: text that may take one (overflow-wrap: break-word) and whose break goes away when
        // emergency breaks are off (a break between the characters of a word written without spaces is allowed)
        const el = node.parentElement
        const ecs = getComputedStyle(el)
        if (el.closest('.link-url') || ecs.wordBreak === 'break-all' || ecs.overflowWrap === 'anywhere') continue
        const twoLines = () => { const lines = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5); return lines.some((rect) => Math.abs(rect.top - lines[0].top) > rect.height / 2) }
        for (const seg of segmenter.segment(node.data)) {
          if (!seg.isWordLike || seg.segment.length < 2) continue
          range.setStart(node, seg.index)
          range.setEnd(node, seg.index + seg.segment.length)
          if (!twoLines()) continue
          el.style.setProperty('overflow-wrap', 'normal', 'important')
          el.style.setProperty('word-break', 'normal', 'important')
          const legal = twoLines()
          // the last resort's own break: a run between spaces that is itself wider than its box's content
          let start = seg.index, end = seg.index + seg.segment.length
          while (start > 0 && !/\s/.test(node.data[start - 1])) start -= 1
          while (end < node.data.length && !/\s/.test(node.data[end])) end += 1
          range.setStart(node, start)
          range.setEnd(node, end)
          const bcs = getComputedStyle(box)
          const inner = own.width - (parseFloat(bcs.paddingLeft) + parseFloat(bcs.paddingRight) + parseFloat(bcs.borderLeftWidth) + parseFloat(bcs.borderRightWidth)) * scale
          const tooLong = [...range.getClientRects()].some((rect) => rect.width > inner + 1)
          el.style.removeProperty('overflow-wrap')
          el.style.removeProperty('word-break')
          if (!legal && !tooLong) faults.push(`"${seg.segment}" is broken inside the word`)
        }
      }
    }
  }
  if (look === 'ocean' && slide.classList.contains('mode-focus')) {
    for (const stop of slide.querySelectorAll('.cycle-diagram .cycle-node[data-mode-state="soft"]')) {
      if (parseFloat(getComputedStyle(stop).opacity) < 1) faults.push('a passed stop is faded')
    }
  }
  return { id: slide.dataset.id, look, faults: [...new Set(faults)], stepOverhang: stepOverhang.length ? Math.max(...stepOverhang) : 0, states: [...slide.querySelectorAll('[data-mode-state]')].map((e) => e.dataset.modeState[0]).join('') }
}

async function walkDeck(browser, htmlPath, viewport) {
  const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(300)
    const seen = []
    let last = ''
    for (let press = 0, stuck = 0; press < 2000 && stuck < 4; press += 1) {
      const got = await page.evaluate(measureActive)
      const key = `${got.id}|${got.states}`
      if (key === last) stuck += 1
      else { stuck = 0; last = key; seen.push(got) }
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(120)
    }
    return seen
  } finally {
    await page.close()
  }
}

// Print (slide-fit.js preparePrint / restorePrint on the browser's beforeprint and afterprint): each case keeps on paper
// the drawing it shows on screen (its look, its loop label boxes, its last-resort and stacking marks), and afterwards
// its markup is exactly what it was. The cases: a loop that keeps the look, a loop that falls back, an icon row on the
// last resort in the look, a boxed list on the last resort in the safe drawing, the long icon list that falls back, a
// stacked panel row; and (the review of PR 377) the loops beside a sentence and steps whose look was kept after a
// comparison (data-oc-kept), which paper must keep without comparing the drawings again.
const PRINT_CASES = ['loop-5-4', 'loop-sentence-3', 'tok-row-email', 'tok-boxes-web', 'items-7-long-list', 'panels-rows', 'loop-sentence-after', 'loop-sentence-two', 'steps-6-4', 'steps-4-10']
const PRINT_KEPT = ['steps-6-4', 'steps-4-10']
function markupOf(id) {
  const walk = (e) => e.nodeType === 3 ? e.data : [e.nodeName, [...(e.attributes || [])].filter((a) => a.name !== 'style' || a.value.trim()).map((a) => [a.name, a.value]).sort(), [...e.childNodes].map(walk)]
  return JSON.stringify(walk(document.querySelector(`.slide[data-id="${id}"]`)))
}
function drawingOf(id) {
  const s = document.querySelector(`.slide[data-id="${id}"]`)
  return JSON.stringify({ look: s.dataset.look, lastResort: 'ocLastResort' in s.dataset, kept: 'ocKept' in s.dataset, labels: s.querySelectorAll('.oc-loop-label').length, stacked: s.querySelectorAll('[data-oc-stack]').length,
    topBeside: s.querySelectorAll('[data-oc-top-beside]').length, tight: s.querySelectorAll('[data-oc-tight]').length })
}
async function printRoundTrip(browser, htmlPath, ids) {
  const problems = []
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    for (const id of ids) {
      await page.evaluate((target) => { location.hash = target }, id)
      await page.waitForTimeout(700)
      const markup = await page.evaluate(markupOf, id)
      const drawing = await page.evaluate(drawingOf, id)
      // a look kept after a comparison is not compared again on paper: its data-look never changes while print prepares
      const switched = await page.evaluate((target) => {
        const slide = document.querySelector(`.slide[data-id="${target}"]`)
        const watch = new MutationObserver(() => {})
        watch.observe(slide, { attributes: true, attributeFilter: ['data-look'], attributeOldValue: true })
        const before = slide.dataset.look
        dispatchEvent(new Event('beforeprint'))
        const records = watch.takeRecords()
        watch.disconnect()
        // a comparison passes through the other drawing; writing the same value again (the authored restore) is no switch
        return records.filter((record) => record.oldValue !== before).length + (slide.dataset.look !== before ? 1 : 0)
      }, id)
      const printed = await page.evaluate(drawingOf, id)
      if (PRINT_KEPT.includes(id) && !JSON.parse(drawing).kept) problems.push(`print ${id}: the screen should keep the look after a comparison (${drawing})`)
      if (JSON.parse(drawing).kept && switched) problems.push(`print ${id}: paper compared the drawings again (data-look changed ${switched} times)`)
      await page.evaluate(() => dispatchEvent(new Event('afterprint')))
      await page.waitForTimeout(200)
      const restored = await page.evaluate(markupOf, id)
      if (printed !== drawing) problems.push(`print ${id}: paper draws ${printed}, the screen ${drawing}`)
      if (restored !== markup) problems.push(`print ${id}: afterprint does not restore the screen markup exactly`)
    }
  } finally {
    await page.close()
  }
  return problems
}

// the handout page: every slide's look after the share page has fitted it
async function handoutLooks(browser, path, text) {
  const model = await prepareSource(path, text, 'handout', statSync(path), undefined, { allowedAssetRoots: [dirname(path)] })
  const deck = await buildDeckHtmlFromModel(model)
  const html = buildShareHtml({ title: 'Talk', slug: 't', includeNotes: false, license: null, slides: extractSlides(deck), styles: extractStyles(deck) })
  const htmlPath = join(work, 'handout.html')
  writeFileSync(htmlPath, html)
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, reducedMotion: 'reduce' })
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(300)
    const looks = {}
    const count = await page.evaluate(() => document.querySelectorAll('.stage > .slide').length)
    for (let i = 0; i < count; i += 1) {
      const got = await page.evaluate(() => { const s = document.querySelector('.stage > .slide.active'); return s ? { id: s.dataset.id, look: s.dataset.look } : null })
      if (got?.id) looks[got.id] = got.look
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(150)
    }
    return looks
  } finally {
    await page.close()
  }
}

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const timer = setTimeout(() => { console.error(`test:ocean-loop-and-many-items: over ${HARD_LIMIT_MS / 1000}s, stopped`); process.exit(2) }, HARD_LIMIT_MS)
const browser = await chromium.launch({ headless: true })
try {
  writeDeckStyles()
  const results = {}
  for (const palette of ['', 'bold']) {
    const path = join(work, `matrix-${palette || 'ocean'}.md`)
    const text = matrixOutline(palette)
    writeFileSync(path, text)
    const { htmlPath } = await compile(`matrix-${palette || 'ocean'}`, path, text)
    const byViewport = []
    for (const viewport of VIEWPORTS) byViewport.push(await walkDeck(browser, htmlPath, viewport))
    const lookOf = new Map()
    for (const [v, states] of byViewport.entries()) {
      for (const state of states.filter((s) => /^(loop|items|panels|boxes|tok|zh|links|steps)-/.test(s.id))) {
        const where = `${palette || 'ocean'} ${state.id} @${VIEWPORTS[v].width} [${state.states}]`
        check(['ocean', 'ocean-safe'].includes(state.look), `${where}: drawn in the look or its safe drawing (got "${state.look}")`)
        check(!state.faults.length, `${where}: keeps the look with nothing wrong (${state.faults.slice(0, 3).join('; ')})`)
        const before = lookOf.get(state.id)
        check(!before || before === state.look, `${where}: the same decision at every reveal step and stage size (${before} then ${state.look})`)
        lookOf.set(state.id, state.look)
      }
    }
    results[palette || 'ocean'] = lookOf
    const overhang = new Map()
    for (const states of byViewport) for (const state of states) if (state.stepOverhang) overhang.set(state.id, Math.max(overhang.get(state.id) || 0, state.stepOverhang))
    console.log(`${palette || 'ocean'} finding, text outside a step (canvas px, largest): ${[...overhang].map(([id, px]) => `${id}=${px}`).join(' ') || 'none'}`)
    console.log(`${palette || 'ocean'} decisions: ${[...lookOf].filter(([id]) => /^(steps|loop-sentence)/.test(id)).map(([id, look]) => `${id}=${look === 'ocean' ? 'look' : 'safe'}`).join(' ')}`)
    check(lookOf.size >= 6 * 4 + 5 * 8 + 4 + 12 + 5 + 7 + 2 + 20, `${palette || 'ocean'}: every case was reached (${lookOf.size})`)
    if (!palette) {
      const handout = await handoutLooks(browser, path, text)
      for (const [id, look] of lookOf) check(handout[id] === look, `handout ${id}: the share page decides as the deck (${handout[id]} vs ${look})`)
      for (const problem of await printRoundTrip(browser, htmlPath, PRINT_CASES)) failures.push(problem)
    }
  }
  // the short cases keep the look: the fix is not "always fall back"
  // and panels of long single words fit by stepping their labels down, never by breaking the word
  for (const id of ['loop-5-1', 'loop-5-4', 'loop-6-4', 'loop-4-plain', 'items-4-short-list', 'items-7-short-list', 'items-8-short-boxes', 'panels-words', 'panels-words-details', 'panels-rows', 'boxes-word', 'loop-long-roles', 'zh-list', 'zh-row', 'zh-boxes', 'zh-org', 'zh-stats', 'links-slide', 'links-source', 'loop-sentence-after', 'loop-sentence-two']) {
    check(results.ocean.get(id) === 'ocean', `ocean ${id}: short labels keep the look (got ${results.ocean.get(id)})`)
  }
  // steps that kept the look in 0.44.0 keep it (the review of PR 367); the rest may fall back, with whole words (the
  // broken-word check above covers both drawings)
  for (const palette of ['ocean', 'bold']) {
    for (let n = 4; n <= 6; n += 1) {
      for (const words of n === 4 ? [4, 5, 6, 7, 10] : [4, 5, 6]) {
        const id = `steps-${n}-${words}`
        check(results[palette].get(id) === 'ocean', `${palette} ${id}: kept the look in 0.44.0 and keeps it (got ${results[palette].get(id)})`)
      }
    }
  }

  // 4. the fixture shapes
  const edgePath = join(repo, 'scripts/fixtures/ocean-look/review-cases-outline.md')
  const edge = await compile('review-cases', edgePath, readFileSync(edgePath, 'utf8'))
  const edgeStates = await walkDeck(browser, edge.htmlPath, VIEWPORTS[0])
  const edgeLook = (id) => edgeStates.find((s) => s.id === id)?.look
  for (const state of edgeStates.filter((s) => /^r-(loop|icon)/.test(s.id))) check(!state.faults.length, `fixture ${state.id} [${state.states}]: ${state.faults.join('; ')}`)
  check(edgeLook('r-loop5-long') === 'ocean', `fixture r-loop5-long keeps the look (got ${edgeLook('r-loop5-long')})`)
  check(edgeStates.filter((s) => s.id === 'r-loop5-long-reveal').every((s) => s.look === 'ocean'), 'fixture r-loop5-long-reveal keeps the look in every reveal state')
  check(edgeLook('r-icon7-long') === 'ocean-safe', `fixture r-icon7-long (seven long items beside the title) falls back (got ${edgeLook('r-icon7-long')})`)

  // 5. classic: no label box, no decision
  const classicText = inClassicLook(readFileSync(edgePath, 'utf8'))
  const classicPath = join(work, 'classic.md')
  writeFileSync(classicPath, classicText)
  const classic = await compile('classic', classicPath, classicText)
  const classicHtml = String(classic.model.fullHtml)
  const slidesHtml = classicHtml.slice(classicHtml.indexOf('<section class="slide"'))
  check(!/class="oc-loop-label"|data-oc-at=/.test(slidesHtml), 'classic: the loop has no label box and no direction stamp')
  const classicStates = await walkDeck(browser, classic.htmlPath, VIEWPORTS[0])
  check(classicStates.every((s) => !s.look), `classic: no slide is given a look (${classicStates.filter((s) => s.look).map((s) => s.id).slice(0, 3)})`)

  // 6. the comparison's words and code agree (the review of PR 377): "at most four fifths" includes four fifths, and
  // "the same faults" means the same signatures, not equal totals
  {
    const page = await browser.newPage()
    try {
      await page.setContent('<div class="stage"><div class="slide"><div class="slide-content"></div></div></div>')
      await page.addScriptTag({ content: readFileSync(join(repo, 'compiler/assets/runtime/slide-fit.js'), 'utf8') })
      const got = await page.evaluate(() => {
        const c = createSlideFit().oceanCompare
        if (!c) return null
        const t = (n, px, sig, cut = { n: 0, px: 0 }) => ({ n, px, sig, cut })
        return {
          atFourFifths: c.lessThan(t(1, 8, []), t(1, 10, [])),
          aboveFourFifths: c.lessThan(t(1, 8.01, []), t(1, 10, [])),
          equalTotalsOtherKinds: c.sameFaults(t(1, 20, ['label-label|0.1+0.2|13']), t(1, 20, ['outside-box|0.3+0.3.0|13'])),
          equalTotalsOtherSizes: c.sameFaults(t(2, 20, ['blocks|0.1+0.2|3', 'blocks|0.1+0.3|10']), t(2, 20, ['blocks|0.1+0.2|7', 'blocks|0.1+0.3|7'])),
          sameInAnyOrder: c.sameFaults(t(2, 20, ['a|0.1|3', 'b|0.2|10']), t(2, 20, ['b|0.2|10', 'a|0.1|3'])),
          tieKeepsSafe: c.safeIsBetter(t(2, 20, ['a|0.1|3', 'b|0.2|10']), t(2, 20, ['b|0.2|10', 'a|0.1|3'])),
          equalTotalsKeepLook: c.safeIsBetter(t(1, 20, ['label-label|0.1+0.2|13']), t(1, 20, ['outside-box|0.3+0.3.0|13']))
        }
      })
      check(got !== null, 'slide-fit.js exposes oceanCompare for this check')
      if (got) {
        check(got.atFourFifths === true, 'four fifths of the size is "less" (at most four fifths)')
        check(got.aboveFourFifths === false, 'just over four fifths is not "less"')
        check(got.equalTotalsOtherKinds === false, 'one label collision and one overhang of the same size are not the same faults')
        check(got.equalTotalsOtherSizes === false, '5 + 15 and 10 + 10 on the same elements are not the same faults')
        check(got.sameInAnyOrder === true, 'the same signatures in another order are the same faults')
        check(got.tieKeepsSafe === true, 'the same faults in both drawings keep the safe drawing')
        check(got.equalTotalsKeepLook === false, 'equal totals of other faults keep the look')
      }
    } finally {
      await page.close()
    }
  }
} finally {
  clearTimeout(timer)
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`test:ocean-loop-and-many-items: ${failures.length} failure(s)\n  ${failures.slice(0, 40).join('\n  ')}`)
  process.exit(1)
}
console.log('test:ocean-loop-and-many-items: loops 3 to 8 stops and icon lists 4 to 8 items keep the look whole or fall back, the same in every state and output; classic unchanged')
