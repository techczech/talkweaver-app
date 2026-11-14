// =============================================================================
// Section lead colours, rendered in Chromium (skin/zz-x-ocean-70-section-colours.css). 1600x900.
//
//   1. scripts/fixtures/ocean-look/section-colours-outline.md has five sections, so the default rotation gives the five
//      leads once each. Walked with Next from the first slide to the last; on each slide the computed paint of what
//      takes the lead is compared with the design (handoff-0.44-basics.md, frames l1 to l5, S01, S02, S04, S13):
//      the divider's field, title and number (the light-amber disc), the full statement's field and type, the light
//      statement's rule, the side rail and its title, the title tab and its type, the title slide's disc. The current
//      item of a reveal stays an Ocean fill with a white label in every section.
//   2. `palette: bold`: every section amber (no section-colours line).
//   3. `palette: classic`: no slide carries the lead stamp, and the deck's pixels are the same with and without the
//      section-colours stylesheet (every slide, every step, animations settled). The compiled classic markup is
//      compared with main's in test-section-colours-classic.mjs's recorded reference.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { walkSlides } from './lib/slide-readability.mjs'

const hardStop = setTimeout(() => { console.error('test-section-colours-dom: hard timeout'); process.exit(124) }, 15 * 60 * 1000)
hardStop.unref()

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repo, '.audit-local'), { recursive: true })
const work = mkdtempSync(join(repo, '.audit-local/section-colours-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
writeDeckStyles()
const FIXTURE = join(repo, 'scripts/fixtures/ocean-look/section-colours-outline.md')
const SKIN = readFileSync(join(repo, 'compiler/assets/styles/skin/zz-x-ocean-70-section-colours.css'), 'utf8')

async function compile(name, text, { withoutSkin = false } = {}) {
  const model = await prepareSource(FIXTURE, text, name, statSync(FIXTURE), undefined, { allowedAssetRoots: [dirname(FIXTURE)] })
  let html = String(model.fullHtml)
  if (withoutSkin) {
    assert.ok(html.includes(SKIN), 'the deck carries the section-colours stylesheet')
    html = html.replace(SKIN, '')
  }
  const path = join(work, `${name}.html`)
  writeFileSync(path, html, 'utf8')
  return { model, path, html }
}

const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const OCEAN = rgb('#1273C4'), DEEP = rgb('#0D5A9E'), AMBER = rgb('#FF9F1C'), WHITE = rgb('#FFFFFF'), LIGHT = rgb('#F2F4F7'), INK = rgb('#16181D')
// What each lead paints (design record: frames l1-1..l5-3, S13 in four leads; light-amber's rail as built, see the build record).
const EXPECT = {
  blue:          { field: OCEAN, dividerTitle: WHITE, number: WHITE, statement: WHITE, rule: OCEAN, rail: OCEAN, railTitle: WHITE, tab: OCEAN, tabType: WHITE },
  amber:         { field: AMBER, dividerTitle: INK, number: INK, statement: INK, rule: AMBER, rail: AMBER, railTitle: INK, tab: AMBER, tabType: INK },
  light:         { field: WHITE, dividerTitle: INK, number: OCEAN, statement: OCEAN, rule: OCEAN, rail: LIGHT, railTitle: OCEAN, railEdge: OCEAN, tab: OCEAN, tabType: WHITE },
  'deep-blue':   { field: DEEP, dividerTitle: WHITE, number: WHITE, statement: WHITE, rule: DEEP, rail: DEEP, railTitle: WHITE, tab: DEEP, tabType: WHITE },
  'light-amber': { field: WHITE, dividerTitle: INK, number: INK, numberDisc: AMBER, statement: DEEP, rule: AMBER, rail: LIGHT, railTitle: DEEP, railEdge: AMBER, tab: AMBER, tabType: INK },
}
const ROTATION = ['blue', 'amber', 'light', 'deep-blue', 'light-amber']

function probe() {
  const slide = document.querySelector('.stage > .slide.active')
  if (!slide) return null
  const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo) : null)
  const content = slide.querySelector(':scope > .slide-content')
  const head = content?.querySelector(':scope > .slide-head > h1')
  const firstP = content?.querySelector(':scope > p:not(.kicker)')
  const current = slide.querySelector('[data-mode-state="current"]')
  const poster = content?.querySelector('.tp.tp-poster:not(.tp-closing)')
  return {
    id: slide.dataset.id, lead: slide.dataset.lead ?? null, ctRail: slide.classList.contains('ct-rail-host'), layout: slide.dataset.layout, role: slide.dataset.role,
    titleLayout: slide.dataset.titleLayout ?? '', titleLook: slide.dataset.titleLook ?? '',
    background: cs(slide).backgroundColor, backgroundImage: cs(slide).backgroundImage,
    headColor: head ? cs(head).color : null, tabFill: head ? cs(head, '::after').backgroundColor : null,
    numberColor: content?.matches('[data-section-number]') ? cs(content, '::before').color : null,
    numberBackground: content?.matches('[data-section-number]') ? cs(content, '::before').backgroundColor : null,
    firstPColor: firstP ? cs(firstP).color : null, ruleFill: firstP ? cs(firstP, '::before').backgroundColor : null,
    currentFill: current ? cs(current).backgroundColor : null,
    currentLabel: current ? cs(current.querySelector('.fl-text, .fl-label, span, p') || current).color : null,
    disc: poster ? cs(poster, '::after').backgroundColor : null,
  }
}

const failures = []
async function section(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures.push(`${name}: ${error?.message ?? error}`); console.error(`FAIL ${name}: ${error?.message ?? error}`) }
}

console.log('section colours (dom)')
const fixtureText = readFileSync(FIXTURE, 'utf8')

// ---- 1. the five leads -----------------------------------------------------------------------------------
await section('1. the five leads paint the divider, statements, rail, tab and disc as drawn', async () => {
  const { path } = await compile('default', fixtureText)
  const seen = new Map()
  const currents = []
  const coverage = await walkSlides(path, async (page) => {
    const state = await page.evaluate(probe)
    if (!state) return
    if (state.currentFill) currents.push(state)
    if (!seen.has(state.id)) seen.set(state.id, state)
  })
  assert.ok(coverage.complete, JSON.stringify(coverage.issues))
  const sectionIds = [...seen.values()].filter((s) => s.role === 'section-title').map((s) => s.id)
  assert.equal(sectionIds.length, 7, 'seven dividers (five in the rotation, two set by {section-colour=…})')
  const problems = []
  const want = (what, got, expected) => { if (got !== expected) problems.push(`${what}: ${got} (want ${expected})`) }
  const title = seen.get('deck-title')
  want('deck-title lead', title?.lead, 'blue')
  want('deck-title disc', title?.disc, OCEAN)
  for (const [at, sectionId] of sectionIds.slice(0, 5).entries()) {
    const lead = ROTATION[at]
    const e = EXPECT[lead]
    const k = at + 1
    const divider = seen.get(sectionId)
    want(`${sectionId} lead`, divider.lead, lead)
    want(`${sectionId} field`, divider.background, e.field)
    want(`${sectionId} title`, divider.headColor, e.dividerTitle)
    want(`${sectionId} number`, divider.numberColor, e.number)
    if (e.numberDisc) want(`${sectionId} number disc`, divider.numberBackground, e.numberDisc)
    const statement = seen.get(`sc${k}-statement`)
    want(`sc${k}-statement field`, statement?.background, e.field)
    want(`sc${k}-statement type`, statement?.firstPColor, e.statement)
    const light = seen.get(`sc${k}-light`)
    want(`sc${k}-light rule`, light?.ruleFill, e.rule)
    want(`sc${k}-light tab`, light?.tabFill, e.tab)
    want(`sc${k}-light tab type`, light?.headColor, e.tabType)
    const rail = seen.get(`sc${k}-rail`)
    want(`sc${k}-rail title layout`, rail?.titleLayout, 'left')
    if (!rail?.backgroundImage?.startsWith(`linear-gradient(to right, ${e.rail} 0px`)) problems.push(`sc${k}-rail paint: ${rail?.backgroundImage}`)
    if (e.railEdge && !rail?.backgroundImage?.includes(`, ${e.railEdge} `)) problems.push(`sc${k}-rail edge: ${rail?.backgroundImage}`)
    want(`sc${k}-rail title`, rail?.headColor, e.railTitle)
    const reveal = seen.get(`sc${k}-reveal`)
    want(`sc${k}-reveal rail title`, reveal?.headColor, e.railTitle)
    const tab = seen.get(`sc${k}-tab`)
    want(`sc${k}-tab title look`, tab?.titleLook, 'tab')
    want(`sc${k}-tab fill`, tab?.tabFill, e.tab)
    want(`sc${k}-tab type`, tab?.headColor, e.tabType)
  }
  // a slide on its own ground ({bg=…}) keeps the stage's tint rail and a dark title; a kicker title on a field takes
  // the field's type colour (near-black on amber, Ocean on the light lead's white)
  const bg = seen.get('sc6-bg')
  want('sc6-bg lead', bg?.lead, 'amber')
  if (bg?.headColor === WHITE) problems.push(`sc6-bg title: ${bg?.headColor}`)
  if (bg?.backgroundImage?.includes(AMBER)) problems.push(`sc6-bg rail painted amber over its own ground: ${bg?.backgroundImage}`)
  want('sc6-kicker title', seen.get('sc6-kicker')?.headColor, INK)
  // beside the section's contents rail the title column comes after it, and the lead paints that column
  const ct = seen.get('sc6-ct')
  want('sc6-ct contents rail', ct?.ctRail, true)
  if (!ct?.backgroundImage?.startsWith('linear-gradient(to right, rgba(0, 0, 0, 0) 0px') || !ct.backgroundImage.includes(AMBER)) problems.push(`sc6-ct paint: ${ct?.backgroundImage}`)
  want('sc6-ct title', ct?.headColor, INK)
  want('sc7-kicker title', seen.get('sc7-kicker')?.headColor, OCEAN)
  // the current item of a reveal stays Ocean with a white label, whatever the section's lead (owner, S85/S86)
  for (const k of [1, 2, 3, 4, 5]) {
    const state = currents.find((s) => s.id === `sc${k}-reveal`)
    want(`sc${k}-reveal current fill`, state?.currentFill, OCEAN)
    want(`sc${k}-reveal current label`, state?.currentLabel, WHITE)
  }
  assert.deepEqual(problems, [])
})

// ---- 2. bold -------------------------------------------------------------------------------------------
await section('2. palette: bold leads every section in amber; a section’s own colour still wins', async () => {
  const { path } = await compile('bold', fixtureText.replace(/^title: .*$/m, (line) => `${line}\npalette: bold`))
  const dividers = new Map()
  const coverage = await walkSlides(path, async (page) => {
    const state = await page.evaluate(probe)
    if (state?.role === 'section-title' && !dividers.has(state.id)) dividers.set(state.id, state)
  })
  assert.ok(coverage.complete, JSON.stringify(coverage.issues))
  assert.equal(dividers.size, 7)
  // amber everywhere with no section-colours line; a section's own {section-colour=…} still wins (the last is light)
  const states = [...dividers.values()]
  for (const state of states.slice(0, 6)) {
    assert.equal(state.lead, 'amber', state.id)
    assert.equal(state.background, AMBER, state.id)
  }
  assert.equal(states[6].lead, 'light')
  assert.equal(states[6].background, WHITE)
})

// ---- 3. classic ------------------------------------------------------------------------------------------
await section('3. palette: classic carries no lead and its pixels are the same without the section-colours stylesheet', async () => {
  const classicText = fixtureText.replace(/^title: .*$/m, (line) => `${line}\npalette: classic`)
  const withSkin = await compile('classic', classicText)
  const withoutSkin = await compile('classic-without', classicText, { withoutSkin: true })
  assert.ok(!/<section class="slide"[^>]*data-lead=/.test(withSkin.html), 'no classic slide carries data-lead')
  assert.ok(!/<section class="slide"[^>]*data-look=/.test(withSkin.html), 'no classic slide carries data-look')
  const shots = async (path) => {
    const out = []
    const coverage = await walkSlides(path, async (page, state) => {
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => { try { a.finish() } catch { /* infinite */ } return a.finished.catch(() => {}) })))
      // the deck's own bar under the stage (counter, progress line, buttons) is not slide paint: masked
      out.push([state.at, createHash('sha256').update(await page.screenshot({ mask: [page.locator('main.deck > footer.footer, .progress, .deck-progress')] })).digest('hex')])
    })
    assert.ok(coverage.complete, JSON.stringify(coverage.issues))
    return out
  }
  // The same deck walked twice can differ at a state whose paint is still settling (the first rail slide, sc1-rail#0,
  // under load); such a state says nothing about the stylesheet, so it is left out and counted, and must stay rare.
  // Both decks are walked twice: a state that settled late in the one walk of the deck without the stylesheet was
  // otherwise read as a difference (2 of 3 parallel DOM runs on the Studio, never alone). A state the stylesheet
  // really changes is the same in both walks of each deck, so it is still caught.
  const a = await shots(withSkin.path)
  const again = await shots(withSkin.path)
  const b = await shots(withoutSkin.path)
  const bAgain = await shots(withoutSkin.path)
  assert.equal(a.length, b.length)
  assert.equal(a.length, again.length)
  assert.equal(b.length, bAgain.length)
  const differsAt = (one, two) => one.filter(([at, hash], i) => two[i][0] !== at || two[i][1] !== hash).map(([at]) => at)
  const unstable = [...new Set([...differsAt(a, again), ...differsAt(b, bAgain)])]
  assert.ok(unstable.length <= 3, `too many states differ between two walks of the same deck: ${unstable.join(', ')}`)
  const differing = a.filter(([at, hash], i) => !unstable.includes(at) && (b[i][0] !== at || b[i][1] !== hash)).map(([at]) => at)
  assert.deepEqual(differing, [], 'classic states whose pixels change with the section-colours stylesheet')
  if (unstable.length) console.log(`  (classic: ${unstable.length} state(s) unsettled between two walks of the same deck, left out: ${unstable.join(', ')})`)
})

if (failures.length) {
  console.error(`\nsection colours (dom): ${failures.length} failed\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('section colours (dom): all passed')
process.exit(0)
