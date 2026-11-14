// =============================================================================
// 0.44 Ocean look (the default for a talk with no `palette:`), rendered in Chromium.
//
//   1. The ten kinds the design rounds drew (scripts/fixtures/ocean-look/ten-kinds-outline.md, the
//      round-1 test content) clip nothing and put no running text below the type floor, at 1600×900
//      and 1280×720 (the layout doctor's own measures).
//   2. Their geometry holds the design: boxed lists and icon rows fill the band; the equation's result
//      stays on the row; the current item of a reveal is filled amber with near-black type; highlighted
//      bars are amber; white on the main colour and near-black on amber reach WCAG AA.
//   3. "Never worse", element by element: the layout sampler and the fixtures below are walked with Next from the
//      first slide to the last, through every reveal step (lib/ocean-clip-walk.mjs). Every element clipped in the
//      default (Ocean) look or in the classic look must have been clipped at the same slide and step in
//      the reference compiler's output for the same outlines (scripts/fixtures/ocean-look/main-clips.json, recorded
//      with this walker by `node scripts/test-ocean-look-dom.mjs --record-main=<checkout at 6771720b>`; slides its Next
//      never reaches are listed in main-states-unreached.json). Known failures (known-clip-failures.json) must match
//      exactly. Every section runs; all failures are reported at the end.
//   4. The review cases (fixtures/ocean-look/review-cases-outline.md): branch fans of 2 to 12 children, long and
//      two-part statements, cards with several detail lines, reveal-capable layouts, stats prose; and in
//      `palette: bold`, light-statement key words that pass contrast.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { doctorDeck } from './layout-doctor-render.mjs'
import { inClassicLook } from './lib/slide-markup-identity.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { clipWalk, knownClipProblems, unreachedStates } from './lib/ocean-clip-walk.mjs'
import { newFloorFailures } from './lib/readability-acceptance.mjs'
import { readabilityProbe, walkSlides as rawWalkSlides } from './lib/slide-readability.mjs'

async function walkSlides(...args) {
  const coverage = await rawWalkSlides(...args)
  assert.ok(coverage.complete, `incomplete readability walk: ${JSON.stringify(coverage.issues)}`)
  return coverage
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIEWPORTS = [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]
mkdirSync(join(repo, '.audit-local'), { recursive: true })
const work = mkdtempSync(join(repo, '.audit-local/ocean-look-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
for (const [signal, code] of Object.entries({ SIGINT: 130, SIGTERM: 143 })) process.once(signal, () => process.exit(code))
const FIXTURES = join(repo, 'scripts/fixtures/ocean-look')
const MAIN_CLIPS = join(FIXTURES, 'main-clips.json')
// The outlines walked for section 3, all compiled from these paths.
const WALKED = [
  ['sampler', join(repo, 'docs/layout-sampler-outline.md')],
  ['ten-kinds', join(FIXTURES, 'ten-kinds-outline.md')],
  ['edge-cases', join(FIXTURES, 'edge-cases-outline.md')],
  ['review-cases', join(FIXTURES, 'review-cases-outline.md')],
  ['statement-combinations', join(FIXTURES, 'statement-combinations-outline.md')],
  ['talk-combinations', join(FIXTURES, 'talk-combinations-outline.md')],
]
const outlineFingerprint = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const fixtureIds = (text) => [...text.matchAll(/\{id=([a-z0-9-]+)\}/g)].map((m) => m[1])
const recordMain = process.argv.find((arg) => arg.startsWith('--record-main='))?.slice('--record-main='.length)
if (recordMain) {
  // Compile every walked outline with an older checkout's compiler (its own stylesheets ship in its template)
  // and record its clips. Run against origin/main whenever the walked outlines change.
  const { prepareSource: mainPrepare } = await import(pathToFileURL(join(recordMain, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  // Slides the older compiler's Next never reaches, each with its reason (main-states-unreached.json): the recording
  // fails if any other slide is unreached, or if a listed one is reached.
  const unreachedAtRecord = JSON.parse(readFileSync(join(FIXTURES, 'main-states-unreached.json'), 'utf8'))
  const recorded = {}
  for (const [name, path] of WALKED) {
    const model = await mainPrepare(path, readFileSync(path, 'utf8'), name, statSync(path), undefined, { allowedAssetRoots: [dirname(path), join(repo, 'e2e/fixtures')] })
    const htmlPath = join(work, `main-${name}.html`)
    writeFileSync(htmlPath, String(model.fullHtml), 'utf8')
    recorded[name] = await clipWalk(htmlPath, { allowUnreached: unreachedAtRecord.filter((entry) => entry.outline === name).map((entry) => entry.slide) })
  }
  // What the reference was recorded from: the older checkout's commit and a fingerprint of each outline,
  // so a reference that no longer matches its inputs is refused instead of quietly comparing less.
  recorded._baseline = {
    revision: execFileSync('git', ['-C', recordMain, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    outlines: Object.fromEntries(WALKED.map(([name, path]) => [name, outlineFingerprint(path)])),
  }
  writeFileSync(MAIN_CLIPS, `${JSON.stringify(recorded, null, 1)}\n`)
  console.log(`recorded origin/main clips for ${WALKED.length} outlines to ${MAIN_CLIPS}`)
  process.exit(0)
}
writeDeckStyles()

async function compileTo(name, sourcePath, text, extraRoots = []) {
  const model = await prepareSource(sourcePath, text, name, statSync(sourcePath), undefined, { allowedAssetRoots: [dirname(sourcePath), ...extraRoots] })
  const htmlPath = join(work, `${name}.html`)
  writeFileSync(htmlPath, String(model.fullHtml), 'utf8')
  return { model, htmlPath }
}

// Record neutral fixture floors with an actual 0.43 compiler, never the current safe renderer.
const V043_REVISION = '6771720babdb12bb0802e676f51f57c369243154'
const floorPath = join(FIXTURES, 'v043-floors.json')
const floorSource = join(FIXTURES, 'talk-combinations-outline.md')
const recordFloor = process.argv.find(a => a.startsWith('--record-floor='))?.slice('--record-floor='.length)
if (recordFloor) {
  const revision = execFileSync('git', ['-C', recordFloor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(revision, V043_REVISION)
  assert.equal(execFileSync('git', ['-C', recordFloor, 'status', '--porcelain', '--', 'compiler'], { encoding: 'utf8' }).trim(), '', 'the historical compiler must be unmodified')
  const { prepareSource: oldPrepare } = await import(pathToFileURL(join(recordFloor, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  const floors = {}
  for (const look of ['ocean', 'bold']) {
    let text = readFileSync(floorSource, 'utf8')
    if (look === 'bold') text = text.replace(/^title: .*$/m, line => `${line}\npalette: bold`)
    const model = await oldPrepare(floorSource, text, 'floor-reference', statSync(floorSource))
    const html = join(work, `floor-${look}.html`)
    writeFileSync(html, model.fullHtml)
    floors[look] = {}
    const coverage = await walkSlides(html, async (page, state) => {
      floors[look][state.at] = (await page.evaluate(readabilityProbe)).floor
    })
    assert.ok(coverage.complete, JSON.stringify(coverage.issues))
  }
  writeFileSync(floorPath, JSON.stringify({ revision, fingerprint: outlineFingerprint(floorSource), floors }, null, 2) + '\n')
  process.exit(0)
}
const floorReference = JSON.parse(readFileSync(floorPath, 'utf8'))
assert.equal(floorReference.revision, V043_REVISION)
assert.equal(floorReference.fingerprint, outlineFingerprint(floorSource))

// Every section runs, whatever an earlier one found; the failures are reported together at the end.
const failures = []
async function section(name, fn) {
  try { await fn() } catch (error) { failures.push(`${name}: ${error?.message ?? error}`); console.error(`FAIL ${name}`) }
}
const tenPath = join(repo, 'scripts/fixtures/ocean-look/ten-kinds-outline.md')
let ten
let edgeIds = []
let walkedStates = 0

// ---- 1. the ten kinds: no clips, nothing under the floor ------------------------------------------
// (tenPath and ten are declared before the sections)
await section('1. ten kinds', async () => {
  ten = await compileTo('ten-kinds', tenPath, readFileSync(tenPath, 'utf8'))
assert(ten.model.slides.some((slide) => slide.id === 'k01-six'), 'the ten-kinds fixture compiled')
assert(/data-look="ocean"/.test(String(ten.model.fullHtml)), 'a talk with no palette draws the Ocean look')
const tenReport = await doctorDeck(ten.htmlPath, { outputDir: join(work, 'ten-report'), viewports: VIEWPORTS, talkDir: dirname(tenPath) })
for (const record of tenReport.slides.filter((slide) => /^k/.test(slide.id))) {
  for (const viewport of Object.keys(record.viewports)) {
    const got = record.viewports[viewport]
    assert.equal(got.clips.length, 0, `${record.id} ${viewport}: nothing clips (${JSON.stringify(got.clips.slice(0, 2))})`)
    assert.equal(got.subFloorText.length, 0, `${record.id} ${viewport}: no running text below the floor (${JSON.stringify(got.subFloorText.slice(0, 2))})`)
  }
}
})

// ---- 1b. edge cases: smallest and largest counts, six-word labels and twelve-word detail lines ------------
// (scripts/fixtures/ocean-look/edge-cases-outline.md). Nothing clips, nothing falls under the floor, and every
// box, panel and contrast keeps the locked minimums at 1600 x 900: box icon 96px, label 44px, detail 30px;
// panel (three or fewer) icon 200px, label 56px; contrast head 72px, rows 36px.
await section('1b. edge cases and minimum sizes', async () => {
const edgePath = join(repo, 'scripts/fixtures/ocean-look/edge-cases-outline.md')
const edge = await compileTo('edge-cases', edgePath, readFileSync(edgePath, 'utf8'))
const edgeReport = await doctorDeck(edge.htmlPath, { outputDir: join(work, 'edge-report'), viewports: VIEWPORTS, talkDir: dirname(edgePath) })
for (const record of edgeReport.slides.filter((slide) => /^e-/.test(slide.id))) {
  for (const viewport of Object.keys(record.viewports)) {
    const got = record.viewports[viewport]
    assert.equal(got.clips.length, 0, `${record.id} ${viewport}: nothing clips (${JSON.stringify(got.clips.slice(0, 2))})`)
    assert.equal(got.subFloorText.length, 0, `${record.id} ${viewport}: no running text below the floor`)
  }
}
const MIN = {
  box: { icon: 96, label: 44, detail: 30 },
  panel: { icon: 200, label: 56, detail: 30 },
  // an icon-row panel that carries detail lines (round 2, the owner's review): the icon steps down so the detail
  // lines, the slide's reading content, are 36px and up
  'panel-detail': { icon: 76, label: 56, detail: 31 }, // icon 120px, 96px with four panels, 80px with five or more lines; detail by line count (38px fixture check in section 6)
  contrast: { label: 72, detail: 36 },
}
async function minimums(htmlPath, ids) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    const out = {}
    for (const id of ids) {
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      const index = await page.evaluate((wanted) => [...document.querySelectorAll('.stage > .slide')].findIndex((slide) => slide.dataset.id === wanted), id)
      for (let tries = 0; tries < 200; tries += 1) {
        const current = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].findIndex((slide) => slide.classList.contains('active')))
        if (current >= index) break
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(20)
      }
      await page.waitForTimeout(300)
      out[id] = await page.evaluate(() => {
        const slide = document.querySelector('.stage > .slide.active')
        const scale = slide.getBoundingClientRect().width / slide.offsetWidth * (1600 / slide.getBoundingClientRect().width)
        const fonts = (sel) => [...slide.querySelectorAll(sel)].map((e) => parseFloat(getComputedStyle(e).fontSize) * scale)
        const icons = [...slide.querySelectorAll('.fl-icon svg, .ir-icon svg')].map((e) => e.getBoundingClientRect().width * (1600 / slide.getBoundingClientRect().width))
        const panels = !slide.querySelector('.feature-list.fl-cards > li:nth-child(4), .icon-row > .ir-item:nth-child(4), .icon-row.ir-rows')
        return {
          kind: slide.querySelector('.vs-grid') ? 'contrast' : panels ? (slide.querySelector('.icon-row:not(.ir-rows) > .ir-item .ir-desc > li') ? 'panel-detail' : 'panel') : 'box',
          icon: Math.min(...icons),
          label: Math.min(...fonts('.fl-cards > li > .fl-text, .ir-label, .vs-head-text')),
          detail: Math.min(...fonts('.fl-cards .fl-sublist > li, .ir-desc > li, .vs-row .vs-text')),
          autoIcons: slide.querySelectorAll('.vs-grid :is(.vs-ico, .vs-head-ico)').length,
        }
      })
    }
    return out
  } finally {
    await browser.close()
  }
}
edgeIds = edgeReport.slides.map((slide) => slide.id).filter((id) => /^e-/.test(id))
const sizes = await minimums(edge.htmlPath, edgeIds)
for (const [id, got] of Object.entries(sizes)) {
  const min = MIN[got.kind]
  if (min.icon) assert(got.icon >= min.icon - 0.5, `${id} (${got.kind}): icons at least ${min.icon}px (${got.icon.toFixed(1)})`)
  assert(got.label >= min.label - 0.5, `${id} (${got.kind}): labels at least ${min.label}px (${got.label.toFixed(1)})`)
  assert(got.detail >= min.detail - 0.5, `${id} (${got.kind}): detail at least ${min.detail}px (${got.detail.toFixed(1)})`)
  if (got.kind === 'contrast') assert.equal(got.autoIcons, 0, `${id}: no icon the author did not name`)
}
const tenSizes = await minimums(ten.htmlPath, ['k01-six', 'k01-three', 'k02', 'k10'])
for (const [id, got] of Object.entries(tenSizes)) {
  const min = MIN[got.kind]
  if (min.icon) assert(got.icon >= min.icon - 0.5, `${id}: icons at least ${min.icon}px (${got.icon.toFixed(1)})`)
  assert(got.label >= min.label - 0.5, `${id}: labels at least ${min.label}px (${got.label.toFixed(1)})`)
  assert(got.detail >= min.detail - 0.5, `${id}: detail at least ${min.detail}px (${got.detail.toFixed(1)})`)
}
assert.equal(tenSizes.k10.autoIcons, 0, 'k10: no brand mark or guessed icon on the contrast (heads carry none in the Ocean look)')
})

// ---- 2. geometry and colour ----------------------------------------------------------------------
const luminance = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

await section('2. geometry and colour', async () => {
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  await page.goto(pathToFileURL(ten.htmlPath).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const goTo = async (id, steps = 0) => {
    await page.goto(pathToFileURL(ten.htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const index = await page.evaluate((wanted) => [...document.querySelectorAll('.stage > .slide')].findIndex((slide) => slide.dataset.id === wanted), id)
    assert(index >= 0, `${id} is in the deck`)
    for (let tries = 0; tries < 200; tries += 1) {
      const current = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].findIndex((slide) => slide.classList.contains('active')))
      if (current >= index) break
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(20)
    }
    for (let step = 0; step < steps; step += 1) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120) }
    await page.waitForTimeout(250)
  }
  const fill = (id, selector) => page.evaluate(([wanted, sel]) => {
    const slide = [...document.querySelectorAll('.stage > .slide')].find((s) => s.dataset.id === wanted)
    const block = slide.querySelector(sel).getBoundingClientRect()
    const head = slide.querySelector('.slide-head').getBoundingClientRect()
    const stage = slide.getBoundingClientRect()
    return { height: block.height / (stage.bottom - head.bottom), width: block.width / stage.width }
  }, [id, selector])

  for (const [id, selector] of [['k01-six', '.feature-list.fl-cards'], ['k01-three', '.feature-list.fl-cards'], ['k02', '.icon-row'], ['k09', '.chart-cols'], ['k07', '.feature-list.fl-annotated']]) {
    await goTo(id)
    const got = await fill(id, selector)
    assert(got.height >= 0.6, `${id}: the block fills the band under the title (${got.height.toFixed(2)} of its height)`)
    assert(got.width >= 0.8, `${id}: the block uses the stage width (${got.width.toFixed(2)})`)
  }

  await goTo('k04')
  const equation = await page.evaluate(() => {
    const slide = document.querySelector('.stage > .slide.active')
    const terms = [...slide.querySelectorAll('.eq-term')].map((term) => term.getBoundingClientRect())
    const result = slide.querySelector('.eq-result').getBoundingClientRect()
    return { firstTop: terms[0].top, resultTop: result.top, rows: new Set(terms.map((rect) => Math.round(rect.top))).size }
  })
  assert.equal(equation.rows, 1, 'the equation terms and the result share one row')
  assert(Math.abs(equation.firstTop - equation.resultTop) < 2, 'the result stays on the row')

  await goTo('k01-current', 3)
  const current = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.stage > .slide.active .feature-list.fl-cards > li')]
    return cards.map((card) => ({ bg: getComputedStyle(card).backgroundColor, ink: getComputedStyle(card.querySelector('.fl-text')).color, visible: getComputedStyle(card).visibility !== 'hidden' && Number(getComputedStyle(card).opacity) > 0 && card.querySelector('.fl-text').getBoundingClientRect().height > 0 }))
  })
  assert.equal(current[2].bg, 'rgb(18, 115, 196)', 'the third (current) item is filled Ocean (owner, 12 Nov: the current item is full blue, not orange)')
  assert.equal(current[2].ink, 'rgb(255, 255, 255)', 'with a white label')
  assert(contrast(current[2].ink, current[2].bg) >= 4.5, `the current item's type reaches AA on Ocean (${contrast(current[2].ink, current[2].bg).toFixed(2)})`)
  assert.notEqual(current[1].bg, 'rgb(18, 115, 196)', 'an earlier item is not filled')

  await goTo('k09')
  const bars = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide.active .chart-bar')].map((bar) => getComputedStyle(bar).backgroundColor))
  assert.deepEqual(bars.slice(4), ['rgb(255, 159, 28)', 'rgb(255, 159, 28)'], 'the bold-labelled bars are highlighted amber')
  assert.equal(bars[0], 'rgb(18, 115, 196)', 'the other bars are Ocean')

  await goTo('k-statement')
  const statement = await page.evaluate(() => {
    const slide = document.querySelector('.stage > .slide.active')
    const p = slide.querySelector('.content-p')
    return { bg: getComputedStyle(slide).backgroundColor, ink: getComputedStyle(p).color, size: parseFloat(getComputedStyle(p).fontSize), stage: slide.getBoundingClientRect().width }
  })
  assert.equal(statement.bg, 'rgb(18, 115, 196)', 'a full statement fills the slide with Ocean')
  assert(contrast(statement.ink, statement.bg) >= 4.5, `white on Ocean reaches AA (${contrast(statement.ink, statement.bg).toFixed(2)})`)
  await page.close()
} finally {
  await browser.close()
}
})

// ---- 6. combinations real talks use (fixtures/ocean-look/talk-combinations-outline.md, found by audit-talks-look) --------
// Icon lists in their list form beside the rail and with {focus} or a reveal, plain lists, a statement holding a list:
// in the default look and in Bold, at every step, every text run reaches AA against what is painted behind it, nothing
// falls under the floor, and once everything is shown no single empty band takes more than 30% of the content area.
const talkPath = join(FIXTURES, 'talk-combinations-outline.md')
const talkText = readFileSync(talkPath, 'utf8')
let talkStates = 0
const talkIds = fixtureIds(talkText)
const talkStatesByLook = {}
const passedRatios = {}
async function talkCombinationProblems(look, text, mutateHtml) {
  const deck = await compileTo(`talk-combos-${look}`, talkPath, text)
  if (mutateHtml) {
    const original = readFileSync(deck.htmlPath, 'utf8')
    const mutated = mutateHtml(original)
    assert.notEqual(mutated, original, 'R3 mutation reached generated fallback')
    writeFileSync(deck.htmlPath, mutated)
  }
  const problems = []
  const seen = new Set()
  if (!mutateHtml) talkStatesByLook[look] = 0
  await walkSlides(deck.htmlPath, async (page, state) => {
    if (!mutateHtml) { talkStates += 1; talkStatesByLook[look] += 1 }
    seen.add(state.id)
    const got = await page.evaluate(readabilityProbe, { floorPx: 30, smallFloorPx: 24 })
    // Keep all measurements; historical exceptions require the same run and no reduction in size.
    const fellBack = await page.evaluate(() => document.querySelector('.stage > .slide.active')?.dataset.look === 'ocean-safe')
    if (mutateHtml && state.id === 'tc-long-items') {
      assert.ok(fellBack, 'R3 mutation is measured after actual fallback')
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('.stage > .slide.active li')].some(li => parseFloat(getComputedStyle(li).fontSize) === 20)), 'R3 mutation rendered an injected 20px LI')
    }
    const floorFailures = fellBack ? newFloorFailures(got.floor, floorReference.floors[look][state.at]) : got.floor
    if (fellBack && got.floor.length) assert.ok(got.floor.every(run => run.key), 'fallback runs have stable identities')
    if (/^tc-long-/.test(state.id) && !fellBack) problems.push(`${look} ${state.at}: content too long for the look did not fall back to the safe drawing`)
    for (const run of got.unresolved) problems.push(`${look} ${state.at}: "${run.text}" sits on a background image or gradient (unresolved)`)
    // an icon-list band: the label (with its detail line, if any) centres on the icon, within 4px at 1600 x 900
    if (/^tc-(bands|iconlist-details)$/.test(state.id)) {
      const off = await page.evaluate(() => {
        const s = document.querySelector('.stage > .slide.active'); const k = 1600 / s.getBoundingClientRect().width
        return [...s.querySelectorAll('.feature-list > li')].filter((li) => li.querySelector('.fl-icon')).map((li) => {
          const icon = li.querySelector('.fl-icon').getBoundingClientRect()
          const parts = [li.querySelector('.fl-text'), li.querySelector('.fl-sublist')].filter(Boolean).map((e) => e.getBoundingClientRect())
          const top = Math.min(...parts.map((r) => r.top)), bottom = Math.max(...parts.map((r) => r.bottom))
          return Math.abs((top + bottom) / 2 - (icon.top + icon.bottom) / 2) * k
        })
      })
      for (const [i, px] of off.entries()) if (px > 4) problems.push(`${look} ${state.at}: band ${i + 1}'s words sit ${px.toFixed(1)}px off the icon's centre`)
    }
    // the current item of every revealing layout exists; icon lists and icon rows fill it Ocean with a white label and
    // icon; a plain list keeps its current row as full-strength near-black words with no fill (owner's decision, 12 Nov)
    const cur = await page.evaluate(() => {
      const s = document.querySelector('.stage > .slide.active')
      const units = s.querySelectorAll('[data-mode-state]')
      if (!units.length) return { reveals: false }
      const el = s.querySelector('[data-mode-state="current"]')
      if (!el) return { reveals: true, found: false, states: [...new Set([...units].map((u) => u.dataset.modeState))] }
      const label = el.querySelector('.fl-text, .ir-label') || el
      const icon = el.querySelector('.fl-icon, .ir-icon')
      return { reveals: true, found: true, fill: getComputedStyle(el).backgroundColor, label: getComputedStyle(label).color, icon: icon ? getComputedStyle(icon).color : null }
    })
    // (the last state of a reveal shows everything with no current item: every unit is "full")
    const revealedOnce = state.step >= 1 && !(cur.states || []).every((st) => st === 'full')
    if (cur.reveals && revealedOnce && !cur.found && !/^tc-(long-|end)/.test(state.id)) problems.push(`${look} ${state.at}: a revealing layout has no current item (${cur.states.join(', ')})`)
    if (cur.found && cur.icon && /^tc-(iconlist-focus|iconlist-eight|bands|iconrow-focus)/.test(state.id)) {
      const want = ['rgb(18, 115, 196)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)']
      if (JSON.stringify([cur.fill, cur.label, cur.icon]) !== JSON.stringify(want)) problems.push(`${look} ${state.at}: the current item is ${cur.fill} / ${cur.label} / ${cur.icon}, not Ocean with a white label and icon`)
    }
    // an icon list whose author named no icons is drawn as a plain list
    if (cur.found && (/^tc-plain/.test(state.id) || (/^tc-iconlist/.test(state.id) && !cur.icon))) {
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cur.fill)) problems.push(`${look} ${state.at}: the current plain row is filled (${cur.fill})`)
      if (cur.label !== 'rgb(22, 24, 29)') problems.push(`${look} ${state.at}: the current plain row's words are ${cur.label}, not near-black`)
    }
    // a passed band ({focus}) and its label: the ratio, recorded for the report
    if (state.id === 'tc-bands' && state.step === 2) {
      passedRatios[look] = await page.evaluate(() => { const li = document.querySelector('.stage > .slide.active .feature-list > li[data-mode-state="soft"]'); return li ? [getComputedStyle(li).backgroundColor, getComputedStyle(li.querySelector('.fl-text')).color] : null })
    }
    // icon-row panels with detail lines: the lines are at least 38px at 1600 wide, one size in every panel of the
    // row, and spread down the panel (the last line ends in its lower third)
    if (/^tc-panel-lines-/.test(state.id)) {
      const panels = await page.evaluate(() => {
        const s = document.querySelector('.stage > .slide.active'); const k = 1600 / s.getBoundingClientRect().width
        return [...s.querySelectorAll('.icon-row > .ir-item')].map((it) => {
          const lis = [...it.querySelectorAll('.ir-desc > li')]; const pr = it.getBoundingClientRect(); const last = lis[lis.length - 1].getBoundingClientRect()
          return { px: Math.round(parseFloat(getComputedStyle(lis[0]).fontSize) * k * 10) / 10, end: (last.bottom - pr.top) / pr.height }
        })
      })
      if (!fellBack) {
        for (const [i, panel] of panels.entries()) {
          if (panel.px < 38) problems.push(`${look} ${state.at}: panel ${i + 1}'s detail lines are ${panel.px}px (needs 38)`)
          if (panel.end < 2 / 3) problems.push(`${look} ${state.at}: panel ${i + 1}'s list ends at ${Math.round(panel.end * 100)}% of the panel (needs the lower third)`)
        }
        if (new Set(panels.map((panel) => panel.px)).size > 1) problems.push(`${look} ${state.at}: the panels' detail lines differ in size (${panels.map((panel) => panel.px).join(', ')})`)
      } else problems.push(`${look} ${state.at}: two or three panels with a few detail lines fell back instead of fitting`)
    }
    // a statement holding a picture: the picture is shown inside the stage at a usable size and covers no words
    if (/^tc-(quote|title-para|title-paras)-picture$/.test(state.id)) {
      const pic = await page.evaluate(() => {
        const s = document.querySelector('.stage > .slide.active'); const st = s.getBoundingClientRect()
        const img = s.querySelector('.slide-figure img').getBoundingClientRect()
        const words = [...s.querySelectorAll('.slide-content > :is(p, blockquote, .slide-head h1:not(.sr-only))')].map((e) => e.getBoundingClientRect())
        const hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
        const overlap = words.some((w) => hit(w, img)) || words.some((a, i) => words.some((b, j) => j > i && hit(a, b)))
        return { share: (img.width * img.height) / (st.width * st.height), inside: img.top >= st.top - 1 && img.bottom <= st.bottom + 1 && img.left >= st.left - 1 && img.right <= st.right + 1, overlap }
      })
      if (pic.share < 0.12 || !pic.inside || pic.overlap) problems.push(`${look} ${state.at}: the picture is ${Math.round(pic.share * 100)}% of the stage, ${pic.inside ? 'inside' : 'outside'} it${pic.overlap ? ', with words drawn over the picture or each other' : ''}`)
    }
    for (const run of got.contrast) problems.push(`${look} ${state.at}: "${run.text}" ${run.ratio}:1 (needs ${run.need}; ${run.ink} on ${run.behind})`)
    for (const run of floorFailures) problems.push(`${look} ${state.at}: "${run.text}" at ${run.px}px is under the floor`)
    const shown = await page.evaluate(() => !document.querySelector('.stage > .slide.active [data-mode-state="hidden"], .stage > .slide.active [data-mode-state="before"]'))
    if (/^tc-(iconlist|plain)/.test(state.id) && shown && got.emptyBand > 0.3) problems.push(`${look} ${state.at}: an empty band of ${Math.round(got.emptyBand * 100)}% of the content area`)
    if (state.id === 'tc-statement-list' && /rgb\(18, 115, 196\)|rgb\(255, 159, 28\)/.test(got.ground)) problems.push(`${look} ${state.at}: a statement holding a list is a full-colour field`)
  })
  assert.deepEqual(talkIds.filter((id) => !seen.has(id)), [], `talk combinations (${look}): every fixture slide is walked`)
  return problems
}
// Reuse the full section-6 acceptance path: reintroducing a fallback waiver must make this test fail.
await section('6a. fallback floor mutation is rejected', async () => {
const mutantProblems = await talkCombinationProblems('ocean', talkText, html => html.replace('slide.dataset.look = "ocean-safe";', 'slide.dataset.look = "ocean-safe"; content.querySelectorAll("li").forEach(el => el.style.setProperty("font-size", "20px", "important"));'))
const mutantFloorFailures = mutantProblems.filter(problem => problem.includes('tc-long-items#') && problem.includes('is under the floor'))
assert.ok(mutantFloorFailures.length > 0, 'R3: injected 20px fallback must fail the actual section-6 floor acceptance')
console.log(`PASS fallback floor mutation: section 6 rejects injected 20px fallback in tc-long-items (${mutantFloorFailures.length} floor failures)`)
})

await section('6. talk combinations', async () => {
for (const [look, text] of [['ocean', talkText], ['bold', talkText.replace(/^title: .*$/m, (line) => `${line}\npalette: bold`)]]) {
  const problems = await talkCombinationProblems(look, text)
  assert.deepEqual(problems, [], `talk combinations (${look}):\n${problems.join('\n')}`)
}
assert.ok(talkStatesByLook.ocean >= talkIds.length + 20, `talk combinations: every reveal state walked (${talkStatesByLook.ocean})`)
assert.equal(talkStatesByLook.bold, talkStatesByLook.ocean, 'talk combinations: the same reveal states in the default look and Bold')
assert.ok(passedRatios.ocean, 'a passed band was measured')
})


// ---- 3. never worse than origin/main, element by element, through every reveal step ---------------------
await section('3. never worse than origin/main', async () => {
const mainClips = JSON.parse(readFileSync(MAIN_CLIPS, 'utf8'))
assert(/^[0-9a-f]{40}$/.test(mainClips._baseline?.revision ?? ''), 'the reference names the commit it was recorded from')
for (const [name, path] of WALKED) {
  assert(mainClips[name], `the reference has the outline "${name}"; record it again with --record-main=<origin/main checkout>`)
  assert.equal(mainClips._baseline.outlines?.[name], outlineFingerprint(path), `the outline "${name}" changed since the reference was recorded; record it again with --record-main=<origin/main checkout>`)
}
// Reference states this branch no longer has, each for a stated reason. Anything else unreached fails.
const INTENDED_GONE = new Map(JSON.parse(readFileSync(join(FIXTURES, 'main-states-gone.json'), 'utf8')).map((entry) => [`${entry.outline} ${entry.look} ${entry.state}`, entry.why]))
// Known clipping failures still on main: real faults the product owns, listed with their reason and count. The list
// must match exactly, occurrence by occurrence (lib/ocean-clip-walk.mjs knownClipProblems): a new clip fails, a listed
// key clipping more often than its count fails, and so does a listed case that stops clipping.
const KNOWN = JSON.parse(readFileSync(join(FIXTURES, 'known-clip-failures.json'), 'utf8'))
const clipProblems = []
const unreached = []
walkedStates = 0
for (const [name, path] of WALKED) {
  const text = readFileSync(path, 'utf8')
  for (const [look, source] of [['ocean', text], ['classic', inClassicLook(text)]]) {
    const deck = await compileTo(`walk-${name}-${look}`, path, source, [join(repo, 'e2e/fixtures')])
    const walked = await clipWalk(deck.htmlPath)
    walkedStates += Object.keys(walked).length
    clipProblems.push(...knownClipProblems(walked, mainClips[name], KNOWN, name, look))
    for (const at of unreachedStates(walked, mainClips[name])) if (!INTENDED_GONE.has(`${name} ${look} ${at}`)) unreached.push(`${name} ${look} ${at}`)
  }
}
const problems = [
  ...unreached.map((line) => `unreached (a state origin/main had: a renamed slide, a lost reveal step, or a walk cut short): ${line}`),
  ...clipProblems,
]
assert.deepEqual(problems, [], problems.join('\n'))
})

// ---- 4. the review cases ---------------------------------------------------------------------------------
await section('4. review cases', async () => {
const reviewPath = join(FIXTURES, 'review-cases-outline.md')
const reviewText = readFileSync(reviewPath, 'utf8')
{
  // Default look: fans of 2 to 12 children (short and long labels), the two statements, the multi-detail cards
  // and every reveal step of the stepped layouts clip nothing. (The classic look is held to origin/main in 3:
  // six cards with three detail lines each already overflowed there and still do in classic.)
  const deck = await compileTo('review-ocean', reviewPath, reviewText)
  const walked = await clipWalk(deck.htmlPath)
  for (const [at, keys] of Object.entries(walked)) {
    if (/^r-/.test(at)) assert.deepEqual(keys, [], `ocean ${at}: nothing clipped`)
  }
}
{
  const deck = await compileTo('review-ocean-stats', reviewPath, reviewText)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(pathToFileURL(deck.htmlPath).href, { waitUntil: 'load' })
    const values = await page.evaluate(() => [...document.querySelectorAll('.slide[data-id="r-stats"] .stat')].map((stat) => [stat.querySelector('.stat-value')?.textContent ?? '', stat.querySelector('.stat-label')?.textContent ?? '']))
    assert.deepEqual(values[0], ['1 billion', 'weekly users'], 'stats: a value with its unit')
    assert.equal(values[1][0], '', 'stats: "ISO 9001: quality management" is a caption, not a number')
    assert.equal(values[2][0], '', 'stats: "Version 2: now available" is a caption, not a number')
  } finally {
    await browser.close()
  }
}
{
  // palette: bold — light-statement key words keep a text colour that passes AA on white; the amber is an underline.
  const boldText = ['---', 'title: Bold', 'palette: bold', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Part', '',
    '### Light', '{statement}{statement-bg=rule}{id=b-light}', '', 'An agent is a model using **tools** in a **loop**.', ''].join('\n')
  const boldPath = join(work, 'bold.md')
  writeFileSync(boldPath, boldText)
  const deck = await compileTo('bold', boldPath, boldText)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(pathToFileURL(deck.htmlPath).href, { waitUntil: 'load' })
    const got = await page.evaluate(() => { const strong = document.querySelector('.slide[data-id="b-light"] strong'); const cs = getComputedStyle(strong); return { color: cs.color, line: cs.textDecorationLine, mark: cs.textDecorationColor } })
    assert(contrast(got.color, 'rgb(255, 255, 255)') >= 4.5, `bold: key words pass AA on white (${got.color}, ${contrast(got.color, 'rgb(255, 255, 255)').toFixed(2)}:1)`)
    assert.equal(got.line, 'underline', 'bold: the amber is carried by an underline')
    assert.equal(got.mark, 'rgb(255, 159, 28)', 'bold: the underline is amber')
  } finally {
    await browser.close()
  }
}
})
// ---- 5. statements as real talks combine them (fixtures/ocean-look/statement-combinations-outline.md) ------------
// In the default look and in Bold, at every reveal step: every text run reaches AA against the colour painted behind
// it (key words and highlights included; the 0.43 highlight on a full-colour statement was white type on a white
// box); a quote uses the statement's measure, with a title or without, with {focus} or without; a statement whose
// body is a picture is drawn on the light ground with the picture filling its share of the stage.
const combosPath = join(FIXTURES, 'statement-combinations-outline.md')
const combosText = readFileSync(combosPath, 'utf8')
let comboStates = 0
const combosIds = fixtureIds(combosText)
const combosStatesByLook = {}
await section('5. statement combinations', async () => {
for (const [look, text] of [['ocean', combosText], ['bold', combosText.replace(/^title: .*$/m, (line) => `${line}\npalette: bold`)]]) {
  const deck = await compileTo(`combos-${look}`, combosPath, text)
  const problems = []
  const seen = new Set()
  const matched = { quotes: 0, pictures: 0, keyWords: 0 }
  combosStatesByLook[look] = 0
  await walkSlides(deck.htmlPath, async (page, state) => {
    comboStates += 1
    combosStatesByLook[look] += 1
    seen.add(state.id)
    const got = await page.evaluate(readabilityProbe, { floorPx: 30, smallFloorPx: 24 })
    const found = await page.evaluate(() => { const s = document.querySelector('.stage > .slide.active'); return { quotes: s.querySelectorAll('.slide-content blockquote').length, pictures: s.querySelectorAll('.slide-content .slide-figure img').length, keyWords: s.querySelectorAll('.slide-content > :not(.slide-head) :is(strong, b)').length } })
    for (const k of Object.keys(matched)) matched[k] += found[k]
    for (const run of got.unresolved) problems.push(`${look} ${state.at}: "${run.text}" sits on a background image or gradient (unresolved)`)
    for (const run of got.contrast) problems.push(`${look} ${state.at}: "${run.text}" ${run.ratio}:1 (needs ${run.need}; ${run.ink} on ${run.behind})${run.overImage ? ' over a picture' : ''}`)
    for (const run of got.floor) problems.push(`${look} ${state.at}: "${run.text}" at ${run.px}px is under the floor`)
    const shape = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active')
      const content = slide.querySelector('.slide-content').getBoundingClientRect()
      const quotes = [...slide.querySelectorAll('.slide-content > blockquote')].map((q) => q.getBoundingClientRect().width / content.width)
      const figure = slide.querySelector('.slide-figure')?.getBoundingClientRect()
      const stage = slide.getBoundingClientRect()
      const keyFills = [...slide.querySelectorAll('.slide-content > :not(.slide-head) :is(strong, b, mark)')].map((e) => getComputedStyle(e).backgroundColor).filter((bg) => !/rgba\(0, 0, 0, 0\)|transparent/.test(bg))
      return { quotes, figureShare: figure ? (figure.width * figure.height) / (stage.width * stage.height) : 0, ground: getComputedStyle(slide).backgroundColor, keyFills }
    })
    if (shape.quotes.some((w) => w < 0.85)) problems.push(`${look} ${state.at}: a quote uses ${Math.round(Math.min(...shape.quotes) * 100)}% of the measure (narrow column)`)
    if (/^sc-picture/.test(state.id)) {
      if (['rgb(18, 115, 196)', 'rgb(255, 159, 28)'].includes(shape.ground)) problems.push(`${look} ${state.at}: a picture statement is a full-colour field`)
      if (shape.figureShare < 0.3) problems.push(`${look} ${state.at}: the picture covers ${Math.round(shape.figureShare * 100)}% of the stage`)
    }
    if (/^sc-(quote|focus|plain)/.test(state.id) && shape.keyFills.length) problems.push(`${look} ${state.at}: key words on the field are drawn as filled boxes (${shape.keyFills[0]})`)
  })
  // not vacuous: every fixture slide was reached, and quotes, pictures and key words were all measured
  assert.deepEqual(combosIds.filter((id) => !seen.has(id)), [], `statement combinations (${look}): every fixture slide is walked`)
  assert.ok(matched.quotes > 0 && matched.pictures > 0 && matched.keyWords > 0, `statement combinations (${look}): quotes, pictures and key words were measured (${JSON.stringify(matched)})`)
  assert.deepEqual(problems, [], `statement combinations (${look}):\n${problems.join('\n')}`)
}
assert.ok(combosStatesByLook.ocean >= combosIds.length + 6, `statement combinations: every reveal state walked (${combosStatesByLook.ocean})`)
assert.equal(combosStatesByLook.bold, combosStatesByLook.ocean, 'statement combinations: the same reveal states in the default look and Bold')
})

// ---- 7. the opening poster with a long title: the title steps down so subtitle and byline stay on the stage ------------
// (Sol's review of PR 354: a 180-character title pushed the subtitle and byline below the stage; at 220 the title clipped.)
await section('7. opening poster', async () => {
const posterChecks = []
{
  const browser = await chromium.launch({ headless: true })
  try {
    for (const length of [180, 220]) {
      for (const palette of ['', 'bold']) {
        const title = ('A title about models and tools '.repeat(10)).slice(0, length).trim()
        const text = `---\ntitle: ${title}\nsubtitle: A subtitle that says what the talk covers\nauthor: A. Speaker\naffiliation: A University\nauto_thanks_slide: false\n${palette ? `palette: ${palette}\n` : ''}---\n\n# ${title}\n\n## Next\n\nWords.\n`
        const deck = await compileTo(`poster-${length}-${palette || 'ocean'}`, tenPath, text)
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
        await page.goto(pathToFileURL(deck.htmlPath).href)
        await page.waitForTimeout(500)
        const got = await page.evaluate(() => {
          const s = document.querySelector('.stage > .slide.active'); const st = s.getBoundingClientRect()
          const r = (sel) => s.querySelector(sel)?.getBoundingClientRect()
          const parts = { title: r('.tp-title'), sub: r('.tp-sub'), who: r('.tp-who') }
          const out = Object.entries(parts).filter(([, b]) => !b || b.top < st.top - 1 || b.bottom > st.bottom + 1).map(([k]) => k)
          const meet = parts.title && parts.sub && parts.who && (parts.title.bottom > parts.sub.top + 1 || parts.sub.bottom > parts.who.top + 1)
          const t = s.querySelector('.tp-title'); const clipped = t.scrollHeight > t.clientHeight + 1 && getComputedStyle(t).overflow !== 'visible'
          return { look: s.dataset.look, out, meet, clipped }
        })
        await page.close()
        if (got.out.length || got.meet || got.clipped) posterChecks.push(`${length} characters${palette ? ' (bold)' : ''}: ${got.out.length ? `${got.out.join(', ')} off the stage` : ''}${got.meet ? ' slots meet' : ''}${got.clipped ? ' title clipped' : ''} (${got.look})`)
        if (got.look !== 'ocean') posterChecks.push(`${length} characters${palette ? ' (bold)' : ''}: fell back instead of fitting the title`)
      }
    }
  } finally {
    await browser.close()
  }
}
assert.deepEqual(posterChecks, [], `opening poster with a long title:\n${posterChecks.join('\n')}`)
})

if (failures.length) {
  console.error(`FAIL ocean look: ${failures.length} of the sections failed; every section ran:\n\n${failures.join('\n\n')}`)
  process.exit(1)
}
console.log(`PASS ocean look: ten kinds and ${edgeIds.length} edge cases clean at ${VIEWPORTS.length} sizes, minimum sizes hold, geometry and contrast hold; ${walkedStates} slide states (every reveal step, both looks) clip nothing origin/main did not; review cases clean in the default look; bold key words pass AA; ${comboStates} statement-combination states readable in the default look and Bold; ${talkStates} talk-combination states readable and filling the band; passed band ${JSON.stringify(passedRatios.ocean)}`)
