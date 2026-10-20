// =============================================================================
// Strong colour on a statement slide under a TOP title (review fix, slide redesign): the whole slide is the
// accent, so everything drawn in the head must read on it. For the plain title and every title style the
// test reads the computed foreground and the background it sits on (the Tab's fill is its ::after layer,
// the Kicker's line is the h1 background stripe) in the real runtime at 1280x720, and asserts a contrast of
// at least 4.5:1 for text and 3:1 for the shapes, plus that the Tab and the Action button are distinguishable
// from the slide. Screenshots are written when SHOTS_DIR is set.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const STATEMENT = 'Agents need a place to keep their work.'
const slides = {
  plain: '{titletop}{titlelook=full}', kicker: '{titletop}{titlelook=kicker}', label: '{titletop}{titlelook=label}',
  tabstrong: '{titletop}{titlelook=tab}', tabsoft: '{titletop}{titlelook=tab}{titlelook-tone=soft}', nosidebar: '{statement-sidebar=off}'
}
const shotNames = { plain: 'strong-top-title', kicker: 'strong-top-kicker', tabstrong: 'strong-top-tab', label: 'strong-top-label' }
const lines = ['---', 'title: Strong top head', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
for (const [id, tokens] of Object.entries(slides)) {
  lines.push('### Where to start', `{id=${id}}{statement}{statement-bg=strong}${tokens}`, '', STATEMENT, '', 'A second, quieter paragraph.', '', '[Action: Get the handout → https://example.com/handout]', '')
}
lines.push('### Next slide', '{id=after}', '', '- one', '- two', '')
const dir = mkdtempSync(join(tmpdir(), 'tw-strong-head-'))
const outlinePath = join(dir, 'strong-head-outline.md')
const source = lines.join('\n')
writeFileSync(outlinePath, source, 'utf8')
const model = await prepareSource(outlinePath, source, 'strong-head', statSync(outlinePath))
const htmlPath = join(dir, 'strong-head.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')
const shotsDir = process.env.SHOTS_DIR
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const read = {}
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(`file://${htmlPath}?audience=1`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  for (const id of Object.keys(slides)) {
    await page.evaluate(() => { location.hash = 'after' })
    await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
    await page.evaluate((target) => { location.hash = target }, id)
    await page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id)
    await page.waitForTimeout(400)
    read[id] = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active')
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      // Any CSS colour (oklab, color-mix) -> [r, g, b, a] by painting it.
      const rgba = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
      const over = (fg, bg) => { const a = fg[3] / 255; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) }
      const h1 = slide.querySelector(':scope > .slide-content > .slide-head > h1')
      const cs = getComputedStyle(h1)
      const after = getComputedStyle(h1, '::after')
      const slideBg = rgba(getComputedStyle(slide).backgroundColor)
      const fillCss = after.content !== 'none' && after.content !== 'normal' ? after.backgroundColor : cs.backgroundColor
      const fillRaw = rgba(fillCss)
      const fill = fillRaw[3] ? over(fillRaw, slideBg) : slideBg
      const stripe = cs.backgroundImage.match(/rgba?\([^)]*\)/)?.[0]
      const quiet = slide.querySelector(':scope > .slide-content > p:nth-of-type(2)')
      const action = slide.querySelector('.slide-action')
      const actionCs = getComputedStyle(action)
      return {
        slideBg, fill, ink: over(rgba(cs.color), fill), stripe: stripe ? over(rgba(stripe), slideBg) : null,
        border: over(rgba(cs.borderLeftColor), slideBg), borderW: parseFloat(cs.borderLeftWidth),
        quiet: over(rgba(getComputedStyle(quiet).color), slideBg),
        actionFg: over(rgba(actionCs.color), over(rgba(actionCs.backgroundColor), slideBg)), actionBg: over(rgba(actionCs.backgroundColor), slideBg)
      }
    })
    if (shotsDir && shotNames[id]) await page.screenshot({ path: join(shotsDir, `${shotNames[id]}.png`) })
  }
} finally {
  await browser.close()
}

const lum = ([r, g, b]) => { const [x, y, z] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }); return 0.2126 * x + 0.7152 * y + 0.0722 * z }
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05) }
const report = []
const atLeast = (name, a, b, min) => { const value = ratio(a, b); report.push(`${name} ${value.toFixed(2)}`); assert.ok(value >= min, `${name}: contrast ${value.toFixed(2)} is below ${min}:1`) }

for (const id of ['plain', 'nosidebar', 'kicker', 'label', 'tabstrong', 'tabsoft']) {
  const r = read[id]
  atLeast(`${id} title text on its ground`, r.ink, r.fill, 4.5)
  atLeast(`${id} quieter paragraph`, r.quiet, r.slideBg, 4.5)
  atLeast(`${id} action button text`, r.actionFg, r.actionBg, 4.5)
  atLeast(`${id} action button against the slide`, r.actionBg, r.slideBg, 3)
}
atLeast('kicker line on the slide', read.kicker.stripe, read.kicker.slideBg, 3)
atLeast('label fill against the slide', read.label.fill, read.label.slideBg, 3)
if (read.label.borderW > 0) atLeast('label line against the note it marks', read.label.border, read.label.fill, 3)
atLeast('strong tab fill against the slide', read.tabstrong.fill, read.tabstrong.slideBg, 3)
atLeast('soft tab fill against the slide', read.tabsoft.fill, read.tabsoft.slideBg, 3)
if (process.env.DEBUG_SHOTS) console.log(report.join('\n'))
console.log('PASS strong statement with a top title: the plain title and every title style (Kicker, Label, Tab strong and soft), the quieter paragraph and the Action button read on the accent (>= 4.5:1 text, >= 3:1 shapes)')
