// The fixture is synthetic. Optional --evidence=<folder> retains 1920x1080 PNGs;
// --compiler=<root> captures an unchanged baseline without asserting the new rule.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { readabilityProbe } from './lib/slide-readability.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const repo = resolve(import.meta.dirname, '..')
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const baseline = option('compiler')
const captureOnly = baseline && !process.argv.includes('--verify-baseline')
const evidence = option('evidence')
if (!baseline) writeDeckStyles()
const { prepareSource } = await import(pathToFileURL(join(baseline || repo, 'compiler/scripts/lib/08-source-adapters.mjs')))
const fixture = join(repo, 'scripts/fixtures/ocean-look/reading-weight-outline.md')
const source = readFileSync(fixture, 'utf8')
mkdirSync(join(repo, '.audit-local'), { recursive: true })
const work = mkdtempSync(join(repo, '.audit-local/reading-weight-'))
if (evidence) mkdirSync(resolve(evidence), { recursive: true })
const bodies = '.slide-content > p:not(.kicker), .fl-text, .fl-sublist > li, .ir-label, .ir-desc > li, .vs-text, .tl-body, .proc-label, .step-label, .cycle-cap, .fl-ann, .slide-table tbody td, blockquote p, .card-points > .feature-list > li, .card.card-claim > h4'
let checks = 0
const captures = {}
const browser = await chromium.launch({ headless: true })
try {
  for (const palette of ['ocean', 'bold', 'forest', 'slate', 'classic', 'green']) {
    const text = palette === 'ocean' ? source : source.replace('title: Reading weight fixture', `title: Reading weight fixture\npalette: ${palette}`)
    const model = await prepareSource(fixture, text, 'Reading weight', statSync(fixture))
    assert(!model.warnings.some(w => w.startsWith('palette-unknown:')), 'the fixture uses a supported palette')
    const handout = buildShareHtml({ title: 'Reading weight', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'reading-weight', license: null })
    for (const [output, html] of baseline ? [['deck', model.fullHtml]] : [['deck', model.fullHtml], ['handout', handout]]) {
      const deck = join(work, `${palette}-${output}.html`)
      writeFileSync(deck, html)
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
      await page.goto(pathToFileURL(deck).href)
      await page.evaluate(() => document.fonts.ready)
      if (evidence) await page.addStyleTag({ content: '.footer { display: none !important; }' })
      const ids = await page.locator('.stage > .slide').evaluateAll(ss => ss.map(s => s.dataset.id))
      assert.equal(ids.length, 19, `${palette}/${output}: every fixture slide compiled`)
      for (const mode of baseline ? ['light'] : ['light', 'dark', 'print', 'thumbnail']) {
        await page.emulateMedia({ media: mode === 'print' ? 'print' : 'screen', colorScheme: mode === 'dark' ? 'dark' : 'light' })
        await page.setViewportSize(mode === 'thumbnail' ? { width: 320, height: 180 } : { width: 1920, height: 1080 })
        await page.evaluate(dark => document.querySelector('.deck')?.classList.toggle('is-dark', dark), mode === 'dark')
        for (const id of ids) {
          await page.evaluate(id => { location.hash = id }, id)
          await page.waitForFunction(id => document.querySelector('.stage > .slide.active')?.dataset.id === id, id)
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          if (evidence && palette === 'ocean' && output === 'deck' && mode === 'light') {
            await page.screenshot({ path: join(resolve(evidence), `${id}.png`), animations: 'disabled' })
            captures[id] = await page.locator('.stage > .slide.active').evaluate((slide, bodies) => ({
              look: slide.dataset.look, layout: slide.dataset.layout,
              bodies: [...slide.querySelectorAll(bodies)].map(e => ({ tag: e.tagName, role: e.className, weight: getComputedStyle(e).fontWeight })),
            }), bodies)
            writeFileSync(join(resolve(evidence), 'measurements.json'), JSON.stringify(captures, null, 2) + '\n')
          }
          if (captureOnly) continue
          const result = await page.locator('.stage > .slide.active').evaluate((slide, bodies) => {
            const structuralTitle = e => e.matches('.fl-text') && (e.nextElementSibling?.matches('.fl-sublist') || e.closest('.fl-lead'))
            const running = [...slide.querySelectorAll(bodies)].filter(e => !structuralTitle(e) && !e.closest('.slide-head') && !(e.matches('.ir-label') && e.parentElement.querySelector(':scope > .ir-desc')))
            return {
              heavy: running.filter(e => Number(getComputedStyle(e).fontWeight) > 400).map(e => `${e.className || e.tagName}:${getComputedStyle(e).fontWeight}`),
              emphasis: [...slide.querySelectorAll('.slide-content :is(strong, u)')].filter(e => !e.closest('.slide-head')).map(e => ({ weight: getComputedStyle(e).fontWeight, line: getComputedStyle(e).textDecorationLine })),
              italic: [...slide.querySelectorAll('em')].map(e => getComputedStyle(e).fontStyle),
              mark: slide.querySelector('mark.ink-marker')?.textContent,
              count: running.length,
            }
          }, bodies)
          const where = `${palette}/${output}/${mode}/${id}`
          assert.deepEqual(result.heavy, [], `${where}: running text uses the reading weight`)
          for (const em of result.emphasis) {
            assert.equal(em.weight, '700', `${where}: authored emphasis is bold`)
            assert(!em.line.includes('underline'), `${where}: bold emphasis is not underlined`)
          }
          for (const style of result.italic) assert.equal(style, 'italic', `${where}: italic emphasis stays italic`)
          if (id === 'inline') assert.equal(result.mark, 'a distinct highlight', `${where}: mark syntax stays distinct`)
          checks += result.count + result.emphasis.length * 2
        }
      }
      await page.close()
    }
  }
  // Quick slides have their own runtime surface outside .slide; exercise that real component too.
  const instant = await import(pathToFileURL(join(baseline || repo, 'compiler/assets/runtime/instant-slide.js')))
  const quick = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await quick.setContent('<!doctype html><html><head><style>body{margin:0}.stage,.slide{position:relative;width:1920px;height:1080px}</style></head><body><div class="stage"><section class="slide active"></section></div></body></html>')
  await quick.addStyleTag({ content: instant.instantSlideStyles })
  await quick.addScriptTag({ content: instant.instantSlideRuntimeSource() + `\nwindow.readingQuick = createInstantSlideSurface(document.querySelector('.slide'), { showQr: false }); readingQuick.show({ kind: 'text', text: 'A clear route helps the group stay together throughout the walk.' });` })
  const quickWeight = await quick.locator('.instant-slide-text').evaluate(e => getComputedStyle(e).fontWeight)
  if (!captureOnly) {
    assert.equal(quickWeight, '400', 'quick-slide sentences use the shared reading weight')
    const reading = await quick.evaluate(readabilityProbe)
    assert.deepEqual(reading.contrast, [], 'quick-slide regular text passes contrast')
    assert.deepEqual(reading.floor, [], 'quick-slide regular text passes the reading floor')
    assert.deepEqual(reading.unresolved, [], 'quick-slide text has a resolved colour ground')
    const box = await quick.locator('.instant-slide-text').boundingBox()
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1921 && box.y + box.height <= 1081, 'quick-slide text fits the stage')
  }
  if (evidence) {
    await quick.screenshot({ path: join(resolve(evidence), 'instant.png') })
    captures.instant = { look: 'shared runtime', layout: 'quick text', bodies: [{ tag: 'P', role: 'instant-slide-text', weight: quickWeight }] }
    writeFileSync(join(resolve(evidence), 'measurements.json'), JSON.stringify(captures, null, 2) + '\n')
  }
  checks++
  await quick.close()
  console.log(captureOnly ? 'CAPTURE baseline: synthetic slides at 1920x1080; new weight rule not asserted' : `PASS reading weight: ${checks} element checks across six palettes`)
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
