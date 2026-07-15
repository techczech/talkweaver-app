import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const [outputRootArg, ...deckArgs] = process.argv.slice(2)

if (!outputRootArg || deckArgs.length === 0) {
  throw new Error('Usage: node scripts/capture-deck-slides.mjs OUTPUT_ROOT DECK.html [DECK.html ...]')
}

const outputRoot = resolve(outputRootArg)
const decks = deckArgs.map((deck) => resolve(deck))
mkdirSync(outputRoot, { recursive: true })

const manifest = { viewport: { width: 1600, height: 900 }, decks: [] }

function staticDeckManifest(deckPath) {
  const deckName = basename(deckPath, '.html')
  const html = readFileSync(deckPath, 'utf8')
  const slides = [...html.matchAll(/<section\b[^>]*\bclass="[^"]*\bslide\b[^"]*"[^>]*>/g)].map((match, index) => {
    const id = match[0].match(/\bdata-id="([^"]+)"/)?.[1] || `slide-${index + 1}`
    const safeId = id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || `slide-${index + 1}`
    return { index, id, file: `${deckName}/${String(index + 1).padStart(3, '0')}-${safeId}.png` }
  })
  return { name: deckName, source: deckPath, slideCount: slides.length, captures: slides }
}

let browser
try {
  browser = await chromium.launch({ headless: true })
} catch (error) {
  manifest.hostRunRequired = true
  manifest.launchError = String(error?.message || error)
  manifest.decks = decks.map(staticDeckManifest)
  writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`chromium unavailable; wrote host-run manifest for ${manifest.decks.reduce((sum, deck) => sum + deck.slideCount, 0)} slides → ${outputRoot}`)
  process.exit(0)
}

try {
  for (const deckPath of decks) {
    const deckName = basename(deckPath, '.html')
    const deckOutput = join(outputRoot, deckName)
    mkdirSync(deckOutput, { recursive: true })
    const page = await browser.newPage({ viewport: manifest.viewport })
    await page.goto(pathToFileURL(deckPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const slides = await page.locator('.stage > .slide').evaluateAll((nodes) => nodes.map((node, index) => ({
      index,
      id: node.getAttribute('data-id') || node.id || `slide-${index + 1}`
    })))
    const captures = []
    for (const slide of slides) {
      await page.locator('.stage > .slide').evaluateAll((nodes, activeIndex) => {
        nodes.forEach((node, index) => node.classList.toggle('active', index === activeIndex))
      }, slide.index)
      await page.waitForTimeout(40)
      const safeId = slide.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || `slide-${slide.index + 1}`
      const file = `${String(slide.index + 1).padStart(3, '0')}-${safeId}.png`
      await page.screenshot({ path: join(deckOutput, file), fullPage: false })
      captures.push({ ...slide, file: `${deckName}/${file}` })
    }
    manifest.decks.push({ name: deckName, source: deckPath, slideCount: slides.length, captures })
    await page.close()
  }
} finally {
  await browser.close()
}

writeFileSync(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`captured ${manifest.decks.reduce((sum, deck) => sum + deck.slideCount, 0)} slides from ${manifest.decks.length} decks → ${outputRoot}`)
