// =============================================================================
// test:compare-contrast-look — 0.41 ticket 08 (ADR-0039: compare and contrast are two subtle panels with a dark
// "vs" disc between them; panel heads in the section accent and the second hue; regular-weight rows with one icon
// each; the rows of the two panels share heights; a row with no icon still renders and the compiler warns)
//
// Measured in Chromium on the 1280 x 720 stage at two window sizes (rects are divided by the stage scale):
//   1. Compare (three rows, and five rows with one wrapping), contrast (head pair + three rows, and five rows with one
//      wrapping): two panels side by side, the disc centred between them and on their vertical middle, the left
//      head in the section accent and the right in the second hue, rows regular weight and at least the type
//      floor, every row's icon sitting inside its panel, and row n of the left panel the same height and top as row n
//      of the right (a wrapped row keeps its partner level).
//   2. Palette: the same slide in each of the four deck colours takes its heads from that section's hues.
//   3. Compiler: a row with no icon renders without one and `vs-row-no-icon:<slide-id>:<count>` is in the warnings;
//      a compare half with a picture keeps the old halves; contrast variants keep their own device.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { formatWarning } from '../compiler/scripts/lib/warning-registry.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-vs-'))
const HEAD = ['---', 'title: Vs look', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '']
const SLIDES = [
  '### Compare short', '{compare}{id=cmp}', '',
  '#### ChatGPT', '', '- Web-based app {globe}', '- Uses basic tools {wrench}', '- Works on uploaded files {file-plus}', '',
  '#### Codex', '', '- Desktop app {computer}', '- Uses tools in local sandbox {terminal}', '- Works on local files {folder-open}', '',
  '### Compare long', '{compare}{id=cmp-long}', '',
  '#### ChatGPT', '', '- Web-based app {globe}', '- Uses basic tools {wrench}', '- Works on uploaded files {file-plus}', '- Chat history in the browser {history}', '- You copy results out by hand {clipboard-copy}', '',
  '#### Codex', '', '- Desktop app {computer}', '- Uses tools in local sandbox {terminal}', '- Works on local files {folder-open}', '- Project folder on your computer {hard-drive}', '- Writes results straight into files in the folder you choose {file-pen}', '',
  '### Contrast short', '{contrast}{id=con}', '',
  '- Chatbot / Agent', '- Answers {message-square} / Acts {bot}', '- Waits for you {user} / Makes a plan {workflow}', '- One reply {send} / Many steps {repeat}', '',
  '### Contrast long', '{contrast}{id=con-long}', '',
  '- Chatbot / Agent', '- Answers {message-square} / Acts {bot}', '- Waits for you {user} / Makes a plan {workflow}', '- One reply {send} / Many steps {repeat}',
  '- Uses what you paste in {clipboard-paste} / Reads and writes files in the folder you give it {folder-sync}', '- You check each answer {eye} / Asks before it runs a command {shield-check}', '',
]
async function compile(name, body, extraFrontmatter = []) {
  const source = [...HEAD.slice(0, 5).slice(0, 4), ...extraFrontmatter, '---', ...HEAD.slice(5), ...body].join('\n')
  const path = join(dir, `${name}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, name, statSync(path))
  const deckPath = join(dir, `${name}.html`)
  writeFileSync(deckPath, model.fullHtml, 'utf8')
  return { model, deckPath }
}

let checks = 0
function check(condition, label) { checks += 1; assert.ok(condition, label) }

const { model, deckPath } = await compile('vs', SLIDES)

// ---- 3 (first: needs no browser). The compiler's side ----
{
  const bare = await compile('bare', [
    '### No icons', '{contrast}{id=bare}', '', '- Zzq / Qqz', '- Xyzzy plugh / Frobozz', '',
    '### Picture half', '{compare}{id=pic}', '',
    '#### One', '', '![](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)', '',
    '#### Two', '', '- Plain {globe}', '',
    '### Ledger', '{contrast=ledger}{id=ledger}', '', '- Old / New', '- A {globe} / B {wrench}', '',
  ])
  check(bare.model.warnings.includes('vs-row-no-icon:bare:4'), 'two bare pairs (four sides) raise vs-row-no-icon:bare:4')
  check(!bare.model.warnings.some((w) => w.startsWith('vs-row-no-icon:pic') || w.startsWith('vs-row-no-icon:ledger')), 'a picture half and a contrast variant raise no vs warning')
  check(/<div class="vs-row L vs-bare">/.test(bare.model.fullHtml), 'a row with no icon is still drawn, marked vs-bare')
  check(bare.model.fullHtml.includes('Zzq') && bare.model.fullHtml.includes('Frobozz'), 'bare rows keep their text')
  check(/class="compare-half half-a"/.test(bare.model.fullHtml), 'a compare half with a picture keeps the old halves')
  check(/contrast-grid contrast-ledger/.test(bare.model.fullHtml), 'contrast=ledger keeps its own device')
  check(!model.warnings.some((w) => w.startsWith('vs-row-no-icon')), 'rows that carry an icon raise no vs warning')
  const message = formatWarning('vs-row-no-icon:bare:4')
  check(message && /Slide bare/.test(JSON.stringify(message)) && /4/.test(JSON.stringify(message)), 'the warning is registered and names the slide and the count')
}

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    // Presenter stepping reads these (MODE_SELECTOR): a contrast row is one step with both sides in it, compare's half B one beat.
    const steps = await page.evaluate(() => ({
      pairs: [...document.querySelectorAll('.stage > .slide')].filter((n) => n.dataset.navTitle === 'Contrast short').map((n) => n.querySelectorAll('.contrast-grid > .contrast-pair').length)[0],
      pairCells: [...document.querySelectorAll('.stage > .slide')].filter((n) => n.dataset.navTitle === 'Contrast short').map((n) => [...n.querySelectorAll('.contrast-grid > .contrast-pair')].every((p) => p.querySelectorAll(':scope > .vs-row').length === 2))[0],
      halfB: [...document.querySelectorAll('.stage > .slide')].filter((n) => n.dataset.navTitle === 'Compare short').map((n) => n.querySelectorAll('.layout-compare .compare-half.half-b').length)[0],
    }))
    check(steps.pairs === 3 && steps.pairCells, 'contrast: three direct .contrast-pair steps, each holding both sides')
    check(steps.halfB === 1, 'compare: half B is the one reveal beat')
    for (const title of ['Compare short', 'Compare long', 'Contrast short', 'Contrast long']) {
      await page.evaluate((name) => {
        document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node.dataset.navTitle === name))
      }, title)
      await page.waitForTimeout(250)
      const m = await page.evaluate(() => {
        const stageEl = document.querySelector('.stage')
        const k = stageEl.getBoundingClientRect().width / stageEl.offsetWidth
        const slide = document.querySelector('.stage > .slide.active')
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x / k, y: b.y / k, w: b.width / k, h: b.height / k } }
        const grid = slide.querySelector('.vs-grid')
        const isCompare = grid.classList.contains('compare-vs')
        const panels = isCompare ? [...grid.querySelectorAll('.vs-panel')].map(r) : [...grid.querySelectorAll('.vs-bg')].map(r)
        const cols = ['L', 'R'].map((side) => [...grid.querySelectorAll(`.vs-row.${side}`)])
        const colour = (el) => getComputedStyle(el).color
        return {
          isCompare, panels,
          disc: r(grid.querySelector('.vs-disc')),
          heads: [...grid.querySelectorAll('.vs-head')].map((h) => ({ colour: colour(h), rect: r(h) })),
          rows: cols.map((col) => col.map((row) => ({ rect: r(row), weight: getComputedStyle(row).fontWeight, size: parseFloat(getComputedStyle(row).fontSize), icon: row.querySelector('.vs-ico svg') ? r(row.querySelector('.vs-ico svg')) : null }))),
          accent: getComputedStyle(slide).getPropertyValue('--accent').trim(),
          hue2: getComputedStyle(slide).getPropertyValue('--hue-2').trim(),
          grid: r(grid), stage: { w: stageEl.offsetWidth, h: stageEl.offsetHeight },
        }
      })
      const label = `${title} @${viewport.width}`
      check(m.panels.length === 2, `${label}: two panels`)
      check(m.panels[0].x + m.panels[0].w < m.panels[1].x, `${label}: panels side by side`)
      check(Math.abs(m.panels[0].y - m.panels[1].y) <= 1 && Math.abs(m.panels[0].h - m.panels[1].h) <= 1, `${label}: both panels the same top and height`)
      const gapMid = (m.panels[0].x + m.panels[0].w + m.panels[1].x) / 2
      check(Math.abs(m.disc.x + m.disc.w / 2 - gapMid) <= 1.5, `${label}: the disc is centred between the panels`)
      check(Math.abs(m.disc.y + m.disc.h / 2 - (m.panels[0].y + m.panels[0].h / 2)) <= 1.5, `${label}: the disc is on the panels' vertical middle`)
      check(m.heads.length === 2, `${label}: both panels have a head`)
      const rgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` }
      check(m.heads[0].colour === rgb(m.accent), `${label}: the left head is the section accent (${m.heads[0].colour} vs ${m.accent})`)
      check(m.heads[1].colour === rgb(m.hue2), `${label}: the right head is the second hue (${m.heads[1].colour} vs ${m.hue2})`)
      check(m.rows[0].length === m.rows[1].length, `${label}: both panels have the same number of rows`)
      m.rows[0].forEach((left, i) => {
        const right = m.rows[1][i]
        check(left.weight === '400' && right.weight === '400', `${label}: row ${i + 1} is regular weight`)
        check(left.size >= 0.019375 * m.stage.w - 0.5, `${label}: row ${i + 1} text is at or above the type floor (${left.size.toFixed(1)}px)`)
        check(Math.abs(left.rect.y - right.rect.y) <= 1 && Math.abs(left.rect.h - right.rect.h) <= 1, `${label}: row ${i + 1} shares its top and height across the panels`)
        check(left.icon && right.icon, `${label}: row ${i + 1} has an icon on both sides`)
        check(left.icon.x >= m.panels[0].x && left.icon.x + left.icon.w <= m.panels[0].x + m.panels[0].w, `${label}: row ${i + 1} left icon is inside its panel`)
        check(right.icon.x >= m.panels[1].x && right.icon.x + right.icon.w <= m.panels[1].x + m.panels[1].w, `${label}: row ${i + 1} right icon is inside its panel`)
      })
      check(m.panels[0].x >= 0 && m.panels[1].x + m.panels[1].w <= m.stage.w && m.panels[0].y >= 0 && m.panels[0].y + m.panels[0].h <= m.stage.h, `${label}: the panels sit inside the stage`)
      if (title.endsWith('long')) {
        const heights = m.rows[0].map((row) => row.rect.h)
        check(Math.max(...heights) - Math.min(...heights) > 5, `${label}: one row wraps, so row heights differ down the panel (and still match across)`)
      }
    }
    await page.close()
  }

  // ---- 2. Palette: the heads follow the section's hues in each deck colour (sheet-palette.png) ----
  // Sections take cobalt, emerald, vermilion in turn; a green deck takes forest. The second panel is the next
  // hue of the cycle, never the section's own.
  const HUES = { cobalt: '#0f4bd8', emerald: '#0a7a5c', vermilion: '#c2410c', forest: '#166534', 'green emerald': '#15803d' }
  const NEXT = { cobalt: 'emerald', emerald: 'vermilion', vermilion: 'cobalt', forest: 'vermilion' } // the foundations' cycle (slide-foundations.css)
  const slideFor = (n) => ['### Chatbot or agent? ' + n, `{contrast}{id=pal-${n}}`, '', '- Chatbot / Agent', '- Answers {message-square} / Acts {bot}', '- Waits {user} / Plans {workflow}', '- One {send} / Many {repeat}', '']
  const decks = [
    { name: 'pal-cycle', extra: [], body: ['## A', ...slideFor(1), '## B', ...slideFor(2), '## C', ...slideFor(3)], expect: [null, null, null] },
    { name: 'pal-green', extra: ['palette: green'], body: ['## A', ...slideFor(1), '## B', ...slideFor(2), '## C', ...slideFor(3), '## D', ...slideFor(4)], expect: [null, null, null, null] },
  ]
  const rgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` }
  const seen = new Set()
  for (const deck of decks) {
    const { deckPath: palettePath } = await compile(deck.name, deck.body, deck.extra)
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.goto(`file://${palettePath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    for (const [index, expected] of deck.expect.entries()) {
      await page.evaluate((id) => document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node.dataset.id === id)), `pal-${index + 1}`)
      await page.waitForTimeout(200)
      const m = await page.evaluate(() => {
        const slide = document.querySelector('.stage > .slide.active')
        return {
          accent: getComputedStyle(slide).getPropertyValue('--accent').trim(),
          hue2: getComputedStyle(slide).getPropertyValue('--hue-2').trim(),
          heads: [...slide.querySelectorAll('.vs-head')].map((h) => getComputedStyle(h).color),
          boxes: [...slide.querySelectorAll('.vs-bg')].map((b) => getComputedStyle(b).borderTopColor),
          icons: [...slide.querySelectorAll('.vs-row')].map((r) => getComputedStyle(r.querySelector('.vs-ico')).color),
        }
      })
      const colour = Object.keys(HUES).find((name) => HUES[name] === m.accent)
      check(colour && (!expected || colour === expected), `${deck.name}: section ${index + 1} takes a deck colour (${m.accent})`)
      seen.add(colour)
      check(m.heads[0] === rgb(HUES[colour]), `${deck.name}: the left head is ${colour} (${m.heads[0]})`)
      check(m.heads[1] === rgb(m.hue2) && m.hue2 !== m.accent, `${deck.name}: the right head is the second hue, not the accent (${m.heads[1]})`)
      if (deck.name === 'pal-cycle' || colour === 'forest') check(m.hue2 === HUES[NEXT[colour]], `${deck.name}: ${colour} is followed by ${NEXT[colour]}`)
      check(m.boxes[0] !== m.boxes[1], `${deck.name}: ${colour}: the two panel outlines differ`)
      check(m.icons.filter((c) => c === rgb(m.accent)).length === 3 && m.icons.filter((c) => c === rgb(m.hue2)).length === 3, `${deck.name}: ${colour}: icons take their panel's hue`)
    }
    await page.close()
  }
  check(['cobalt', 'emerald', 'vermilion', 'forest'].every((name) => seen.has(name)), `all four deck colours were drawn (${[...seen].join(', ')})`)
} finally {
  await browser.close()
}
console.log(`compare/contrast look: ${checks} checks passed`)
