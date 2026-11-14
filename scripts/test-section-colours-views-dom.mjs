// =============================================================================
// Section lead colours: the same slide shows the same lead wherever it is drawn. Chromium, 1600x900. The print group
// needs pdfinfo and pdftoppm (poppler), as test-handout-print does; without them it is skipped with a message (laptop only).
//
// The fixture (scripts/fixtures/ocean-look/section-colours-outline.md, five sections in the rotation) gains a slide
// pasted from another talk (`{from=other-talk#abc12}`) in its fourth section. Compiled once, it is drawn as:
//   1. the single-file deck (the compiled presenter HTML every export and the editor's preview draw);
//   2. the handout (buildShareHtml over the deck's slides, as the Download handout is);
//   3. a Pathway cut of sections 3 and 5 (injectPathwayRuntime over the full compile, as presenting a pathway does):
//      a cut keeps the colour each section has in the whole talk, it does not count its sections again;
//   4. the fall-back drawing: section-colours-fallback-outline.md overfills a divider, a full statement, a light
//      statement, a list beside the rail and a list under a title tab in an amber and a light section, so the runtime
//      fitter itself sends them to data-look="ocean-safe"; each keeps its lead on the same elements;
//   5. print: page.pdf() of the handout with backgrounds, each page rasterised; the field of each divider and the side
//      rail are printed in the lead colour, and the stamp is still on every slide after printing.
// In each, every slide's data-lead equals the compiled model's, and the paint of the dividers and rails is the lead's.
// =============================================================================
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { injectPathwayRuntime } from '../src/main/pathways.ts'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { walkSlides } from './lib/slide-readability.mjs'

const hardStop = setTimeout(() => { console.error('test-section-colours-views-dom: hard timeout'); process.exit(124) }, 12 * 60 * 1000)
hardStop.unref()

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repo, '.audit-local'), { recursive: true })
const work = mkdtempSync(join(repo, '.audit-local/section-colours-views-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
writeDeckStyles()
const FIXTURE = join(repo, 'scripts/fixtures/ocean-look/section-colours-outline.md')

const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const FIELD = { blue: '#1273C4', amber: '#FF9F1C', 'deep-blue': '#0D5A9E', light: '#FFFFFF', 'light-amber': '#FFFFFF' }
const RAIL = { blue: '#1273C4', amber: '#FF9F1C', 'deep-blue': '#0D5A9E', light: '#F2F4F7', 'light-amber': '#F2F4F7' }

const failures = []
async function section(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures.push(`${name}: ${error?.message ?? error}`); console.error(`FAIL ${name}: ${error?.message ?? error}`) }
}

// the fixture with a slide copied from another talk in the fourth section (deep-blue in the rotation)
const text = readFileSync(FIXTURE, 'utf8').replace('### Office tasks an agent can finish\n{chart=bar}{id=sc4-tab}', '### A slide copied from another talk {from=other-talk#abc12}\n{id=sc4-copied}\n\n- It keeps the words it had\n- It takes this section\'s colour\n\n### Office tasks an agent can finish\n{chart=bar}{id=sc4-tab}')
assert.ok(text.includes('sc4-copied'), 'the copied slide is in the fixture')
const model = await prepareSource(FIXTURE, text, 'views', statSync(FIXTURE), undefined, { allowedAssetRoots: [dirname(FIXTURE)] })
const deck = String(model.fullHtml)
const expected = Object.fromEntries(model.slides.map((s) => [s.id, s.sectionLead]))
const deckPath = join(work, 'deck.html'); writeFileSync(deckPath, deck)
const handout = buildShareHtml({ title: 'Views', slug: 'views', includeNotes: false, license: null, slides: extractSlides(await buildDeckHtmlFromModel(model)), styles: extractStyles(deck) })
const handoutPath = join(work, 'handout.html'); writeFileSync(handoutPath, handout)

// every slide's stamp and the paint of dividers and rails, read in the page
function paint() {
  return [...document.querySelectorAll('.slide[data-id]')].map((slide) => {
    const cs = getComputedStyle(slide)
    const head = slide.querySelector(':scope > .slide-content > .slide-head > h1')
    return { id: slide.dataset.id, lead: slide.dataset.lead ?? null, look: slide.dataset.look ?? null, role: slide.dataset.role, titleLayout: slide.dataset.titleLayout ?? '', ground: slide.dataset.ground ?? '', background: cs.backgroundColor, image: cs.backgroundImage, head: head ? getComputedStyle(head).color : null }
  })
}
function check(where, rows, ids = null) {
  const problems = []
  const seen = rows.filter((row) => !ids || ids.includes(row.id))
  assert.ok(seen.length > 0, `${where}: no slides found`)
  for (const row of seen) {
    if (!(row.id in expected)) continue
    if (row.lead !== expected[row.id]) problems.push(`${row.id} lead ${row.lead} (want ${expected[row.id]})`)
    if (row.role === 'section-title' && row.ground === 'lead' && row.background !== rgb(FIELD[row.lead])) problems.push(`${row.id} divider ${row.background} (want ${FIELD[row.lead]})`)
    if (row.titleLayout === 'left' && row.role === 'content' && /-rail$/.test(row.id) && !row.image.startsWith(`linear-gradient(to right, ${rgb(RAIL[row.lead])} 0px`)) problems.push(`${row.id} rail ${row.image.slice(0, 60)}`)
  }
  assert.deepEqual(problems, [], `${where}: ${problems.join('; ')}`)
  return seen.length
}

console.log('section colours: the same lead in every view (dom)')
const browser = await chromium.launch({ headless: true })
try {
  const open = async (path) => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(pathToFileURL(path).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(300)
    return page
  }

  await section('1. the single-file deck: every slide carries the model\'s lead and paints it', async () => {
    const page = await open(deckPath)
    const n = check('deck', await page.evaluate(paint))
    assert.ok(n >= 30, `deck: ${n} slides`)
    await page.close()
  })

  await section('2. the handout draws the same lead on every slide', async () => {
    const page = await open(handoutPath)
    const rows = await page.evaluate(paint)
    check('handout', rows)
    for (const id of ['sc1-statement', 'sc2-statement', 'sc3-rail', 'sc4-copied', 'sc5-tab']) assert.ok(rows.some((row) => row.id === id), `handout: ${id} is drawn`)
    await page.close()
  })

  await section('3. a slide copied from another talk ({from=…}) takes the colour of the section it sits in', async () => {
    assert.equal(expected['sc4-copied'], expected['sc4-statement'])
    assert.equal(expected['sc4-copied'], 'deep-blue')
    assert.ok(!model.warnings.some((w) => /from/.test(w)), model.warnings.join(', '))
  })

  await section('4. a Pathway cut keeps the colours of the whole talk (sections 3 and 5 stay light and light-amber)', async () => {
    const ids = model.slides.filter((s) => /^sc[35]-/.test(s.id) || (s.role === 'section-title' && ['light', 'light-amber'].includes(s.sectionLead))).map((s) => s.id)
    const cut = injectPathwayRuntime(deck, ids, 'cut')
    const cutPath = join(work, 'cut.html'); writeFileSync(cutPath, cut)
    const page = await open(cutPath)
    const rows = await page.evaluate(paint)
    assert.deepEqual(rows.map((row) => row.id).filter((id) => !ids.includes(id)), [], 'only the pathway\'s slides are in the cut')
    check('pathway', rows, ids)
    assert.deepEqual([...new Set(rows.map((row) => row.lead))].sort(), ['light', 'light-amber'])
    await page.close()
    // presented: walking the cut with Next shows each of its slides in its whole-talk colour
    const shown = new Map()
    const coverage = await walkSlides(cutPath, async (p) => { const s = await p.evaluate(() => { const a = document.querySelector('.stage > .slide.active'); return a ? [a.dataset.id, a.dataset.lead] : null }); if (s) shown.set(s[0], s[1]) })
    assert.ok(coverage.complete, JSON.stringify(coverage.issues))
    for (const [id, lead] of shown) assert.equal(lead, expected[id], `presented ${id}`)
  })

  await section('5. a slide the fitter sends to the fall-back drawing, and one whose look it keeps after comparing, both show the lead (amber and light)', async () => {
    // section-colours-fallback-outline.md: in an amber and a light section, a divider, a full statement, a light statement,
    // a list beside the rail and a list under the title tab, each overfilled so the runtime fitter gives up on the look
    const source = join(repo, 'scripts/fixtures/ocean-look/section-colours-fallback-outline.md')
    const fb = await prepareSource(source, readFileSync(source, 'utf8'), 'fallback', statSync(source), undefined, { allowedAssetRoots: [dirname(source)] })
    const fbPath = join(work, 'fallback.html'); writeFileSync(fbPath, String(fb.fullHtml))
    const divider = (k) => fb.slides.filter((x) => x.role === 'section-title')[k - 1].id
    const INK = rgb('#16181D'), WHITE = rgb('#FFFFFF'), OCEAN = rgb('#1273C4')
    // per slide: [lead, what is painted, its colour, the title or text colour]
    const want = {
      [divider(1)]: ['amber', 'field', rgb('#FF9F1C'), INK], 'fb1-statement': ['amber', 'field', rgb('#FF9F1C'), INK],
      'fb1-light': ['amber', 'rail', rgb('#FF9F1C'), INK], 'fb1-rail': ['amber', 'rail', rgb('#FF9F1C'), INK], 'fb1-tab': ['amber', 'tab', rgb('#FF9F1C'), INK],
      'fb1-kept-a': ['amber', 'tab', rgb('#FF9F1C'), INK, 'kept'], 'fb1-kept-b': ['amber', 'tab', rgb('#FF9F1C'), INK, 'kept'],
      'fb2-kept-a': ['light', 'tab', OCEAN, WHITE, 'kept'], 'fb2-kept-b': ['light', 'tab', OCEAN, WHITE, 'kept'],
      [divider(2)]: ['light', 'field', WHITE, INK], 'fb2-statement': ['light', 'field', WHITE, OCEAN],
      'fb2-light': ['light', 'rail', rgb('#F2F4F7'), OCEAN], 'fb2-rail': ['light', 'rail', rgb('#F2F4F7'), OCEAN], 'fb2-tab': ['light', 'tab', OCEAN, WHITE],
    }
    const seen = new Map()
    const coverage = await walkSlides(fbPath, async (p, state) => {
      if (!state.terminal) return
      const row = await p.evaluate(() => {
        const s = document.querySelector('.stage > .slide.active'); if (!s) return null
        const cs = getComputedStyle(s); const h = s.querySelector('.slide-head h1'); const t = s.querySelector(':scope > .slide-content > p, :scope > .slide-content > .feature-list li')
        return { id: s.dataset.id, look: s.dataset.look, kept: 'ocKept' in s.dataset, lead: s.dataset.lead, background: cs.backgroundColor, image: cs.backgroundImage, head: h && getComputedStyle(h).color, tab: h && getComputedStyle(h, '::after').backgroundColor, text: t && getComputedStyle(t).color, role: s.dataset.role }
      })
      if (row && !seen.has(row.id)) seen.set(row.id, row)
    })
    assert.ok(coverage.complete, JSON.stringify(coverage.issues))
    const problems = []
    for (const [id, [lead, what, colour, type, outcome = 'fell back']] of Object.entries(want)) {
      const row = seen.get(id)
      if (!row) { problems.push(`${id} not shown`); continue }
      // two outcomes of the fitter's comparison, both in the section's lead: the safe drawing, or the look kept
      if (outcome === 'fell back' && row.look !== 'ocean-safe') problems.push(`${id} did not fall back (${row.look})`)
      if (outcome === 'kept' && !(row.look === 'ocean' && row.kept)) problems.push(`${id} was not kept after a comparison (${row.look}${row.kept ? ', kept' : ''})`)
      if (row.lead !== lead) problems.push(`${id} lead ${row.lead}`)
      if (what === 'field' && row.background !== colour) problems.push(`${id} field ${row.background} (want ${colour})`)
      if (what === 'rail' && !row.image.startsWith(`linear-gradient(to right, ${colour} 0px`)) problems.push(`${id} rail ${row.image.slice(0, 60)}`)
      if (what === 'tab' && row.tab !== colour) problems.push(`${id} tab ${row.tab} (want ${colour})`)
      const typeOf = what === 'field' && row.role !== 'section-title' ? row.text : row.head
      if (typeOf !== type) problems.push(`${id} type ${typeOf} (want ${type})`)
    }
    assert.deepEqual(problems, [])
  })

  // The print group needs poppler (pdfinfo, pdftoppm), as test-handout-print does. Machines without it (the Mac Studio
  // runner) skip it and say so; it runs on the laptop.
  const poppler = ['pdfinfo', 'pdftoppm'].every((tool) => { try { execFileSync('which', [tool], { stdio: 'ignore' }); return true } catch { return false } })
  if (!poppler) console.log('  skip 6. print: needs pdfinfo and pdftoppm (poppler), not on this machine; run it on the laptop')
  if (poppler) await section('6. print: page.pdf() prints each divider\'s field and each rail in its lead, and the stamp stays', async () => {
    const page = await open(handoutPath)
    await page.emulateMedia({ media: 'print' })
    const order = await page.evaluate(() => [...document.querySelectorAll('.slide[data-id]')].map((s) => s.dataset.id))
    const pdfPath = join(work, 'handout.pdf')
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true })
    const after = await page.evaluate(paint)
    assert.deepEqual(after.map((row) => [row.id, row.lead]), order.map((id) => [id, expected[id] ?? after.find((r) => r.id === id)?.lead]), 'the stamp is on every slide after printing')
    await page.close()
    const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' }))[1])
    assert.equal(pages, order.length, `one slide per page (${pages} pages for ${order.length} slides)`)
    const pngDir = join(work, 'pages'); mkdirSync(pngDir)
    execFileSync('pdftoppm', ['-r', '30', '-png', pdfPath, join(pngDir, 'p')])
    const files = readdirSync(pngDir).sort()
    const near = (a, hex) => [1, 3, 5].every((i, k) => Math.abs(a[k] - parseInt(hex.slice(i, i + 2), 16)) <= 10)
    const problems = []
    for (const [index, id] of order.entries()) {
      const lead = expected[id]
      if (!lead) continue
      const isDivider = model.slides.find((s) => s.id === id)?.role === 'section-title'
      const isRail = /-rail$/.test(id)
      if (!isDivider && !isRail) continue
      const { data, info } = await sharp(join(pngDir, files[index])).raw().toBuffer({ resolveWithObject: true })
      // a point in the field (divider: upper right, inside light-amber's disc too) or in the rail (left edge, half way down)
      const [x, y] = isDivider ? [Math.round(info.width * 0.8), Math.round(info.height * 0.2)] : [Math.round(info.width * 0.03), Math.round(info.height * 0.5)]
      const i = (y * info.width + x) * info.channels
      const px = [data[i], data[i + 1], data[i + 2]]
      const want = isDivider ? (lead === 'light-amber' ? '#FF9F1C' : FIELD[lead]) : RAIL[lead]
      if (want && !near(px, want)) problems.push(`page ${index + 1} (${id}, ${lead}) printed rgb(${px.join(', ')}) where ${want} was drawn`)
    }
    assert.deepEqual(problems, [])
  })
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\nsection colours (views): ${failures.length} failed\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('section colours (views): all passed')
process.exit(0)
