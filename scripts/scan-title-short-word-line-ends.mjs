// Scan compiled decks for titles where a short word (a, an, the, at, of, in, on, to, and, or, for, by, with, is)
// ends a line that is not the last (ADR-0033 §7). Give-way cases (the runtime released a short-word bond because
// keeping it would leave a word alone on a line; h1[data-short-word-give-way]) are listed, not counted.
// Usage: node scripts/scan-title-short-word-line-ends.mjs DECK.html [DECK.html ...]   (exit 1 when any line end is found)
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const decks = process.argv.slice(2)
if (!decks.length) { console.error('usage: scan-title-short-word-line-ends.mjs DECK.html [...]'); process.exit(2) }
const SHORT = new Set('a an the at of in on to and or for by with is'.split(' '))
const browser = await chromium.launch({ headless: true })
let violations = 0
let giveWays = 0
let titles = 0
try {
  for (const deck of decks) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(deck).href + '?audience=1')
    await page.evaluate(() => document.fonts?.ready)
    const ids = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].map((s, i) => [i + 1, s.dataset.id]))
    for (const [n, id] of ids) {
      await page.evaluate((target) => { location.hash = target }, id)
      await page.waitForTimeout(150)
      const found = await page.evaluate(() => {
        const h1 = document.querySelector('.stage > .slide.active h1:not(.sr-only)')
        if (!h1 || !h1.offsetParent) return null
        const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT)
        const words = []
        while (walker.nextNode()) {
          const node = walker.currentNode
          for (const m of node.nodeValue.matchAll(/[^\s ]+/g)) {
            const range = document.createRange()
            range.setStart(node, m.index)
            range.setEnd(node, m.index + m[0].length)
            const rect = range.getClientRects()[0]
            if (rect) words.push({ w: m[0], top: Math.round(rect.top / 6) })
          }
        }
        return { words, giveWay: h1.dataset.shortWordGiveWay || '', size: parseFloat(getComputedStyle(h1).fontSize) }
      })
      if (!found) continue
      titles++
      const lines = []
      for (const x of found.words) {
        if (!lines.length || lines[lines.length - 1].top !== x.top) lines.push({ top: x.top, ws: [] })
        lines[lines.length - 1].ws.push(x.w)
      }
      const ends = lines.slice(0, -1).filter((l) => SHORT.has(l.ws[l.ws.length - 1].toLowerCase().replace(/[^a-z]/g, '')))
      const text = lines.map((l) => l.ws.join(' ')).join(' / ')
      if (found.giveWay) { giveWays++; console.log(`GIVE-WAY  ${deck.split('/').pop()} ${n} ${id} | ${text}`) }
      if (ends.length && !found.giveWay) { violations++; console.log(`LINE-END  ${deck.split('/').pop()} ${n} ${id} | ${text}`) }
    }
    await page.close()
  }
} finally { await browser.close() }
console.log(`${titles} titles scanned; ${violations} short-word line ends; ${giveWays} give-way titles listed`)
process.exit(violations ? 1 : 0)
