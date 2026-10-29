// A hostile web page on a slide (`[Embed: http://<another origin>/…]`), in the real compiled deck in
// headless Chromium: the deck is served from one origin, the page from another. The page tries, with
// and without a click inside it (a real user activation), to move the deck (top.location, a _top link),
// to open a window (window.open, a _blank link), to download, and to read the deck page (parent.document,
// parent.tw). None of it may work; the deck stays on its slide and opens nothing. The Open link beside
// the frame is still an ordinary link to the address as written.
// Usage: node scripts/test-remote-page-sandbox-dom.mjs   (TW_HEADLESS_SHELL=<chrome-headless-shell> where Playwright's build is missing)
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-remote-sandbox-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const HOSTILE = `<!doctype html><title>Hostile</title><body style="height:4000px">
<a id="top" href="/escaped" target="_top">top</a> <a id="blank" href="/popup" target="_blank">blank</a> <a id="dl" href="/file.bin" download>dl</a>
<script>
window.tries = {}
const attempt = (name, fn) => { try { const v = fn(); window.tries[name] = v === undefined || v === null ? 'no effect' : 'returned ' + typeof v } catch (e) { window.tries[name] = 'threw ' + e.name } }
attempt('parentDocument', () => parent.document.title)
attempt('parentTw', () => parent.tw)
attempt('open', () => window.open('/popup-script'))
attempt('topLocation', () => { top.location.href = '/escaped-script' })
</script>`
const pageServer = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/file.bin') ? 'x' : HOSTILE) })
await new Promise((done) => pageServer.listen(0, 'localhost', done))
const REMOTE = `http://localhost:${pageServer.address().port}/page?q=1#frag`
// Review finding (2026-10-27): an address that only CONTAINS a player path was drawn as an unsandboxed player.
const LOOKALIKE = `http://localhost:${pageServer.address().port}/youtube-nocookie.com/embed/x`

const outline = `---\ntitle: Sandbox\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Before {id=before}\n\n- Before\n\n### Page {layout=media id=page}\n\n[Embed: ${REMOTE}]\n\n### Lookalike {layout=media id=lookalike}\n\n[Embed: ${LOOKALIKE}]\n\n### After {id=after}\n\n- After\n`
const outlinePath = join(dir, 'sandbox-outline.md')
writeFileSync(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, null, statSync(outlinePath), {}, {})
const deckServer = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url.startsWith('/deck') ? model.fullHtml : '<title>ESCAPED</title>') })
await new Promise((done) => deckServer.listen(0, '127.0.0.1', done))
const DECK = `http://127.0.0.1:${deckServer.address().port}/deck.html`

let browser
let failures = 0
try {
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const deck = await context.newPage()
  const popups = []
  const downloads = []
  context.on('page', (p) => { if (p !== deck) popups.push(p.url()) })
  deck.on('download', (d) => downloads.push(d.url()))
  await deck.goto(DECK + '#page')
  await deck.waitForFunction(() => document.querySelector('.slide.active figure.slide-embed iframe')?.src)
  const handle = await deck.$('.slide.active figure.slide-embed iframe')
  const frame = await handle.contentFrame()
  await frame.waitForFunction(() => window.tries && Object.keys(window.tries).length === 4)
  const check = (ok, label, detail) => { if (!ok) { failures++; console.error(`  FAIL ${label} (${detail})`) } else console.log(`  ok  ${label}`) }
  const tries = await frame.evaluate(() => window.tries)
  check(tries.parentDocument.startsWith('threw'), 'the page cannot read the deck page', tries.parentDocument)
  check(tries.parentTw !== 'returned object', 'the page cannot reach a deck bridge', tries.parentTw)
  check(tries.open === 'no effect', 'window.open from the page opens nothing', tries.open)
  check(await handle.getAttribute('sandbox') === 'allow-scripts allow-same-origin allow-forms allow-presentation', 'the frame carries the remote sandbox', await handle.getAttribute('sandbox'))
  // With a real user activation inside the page: the Interact chip, then clicks in the page.
  await deck.click('.slide.active .embed-interact-chip')
  for (const id of ['#top', '#blank', '#dl']) await frame.click(id).catch(() => {})
  await frame.evaluate(() => { try { top.location.href = '/escaped-activated' } catch { /* refused */ } try { window.open('/popup-activated') } catch { /* refused */ } })
  await deck.waitForTimeout(1200)
  check(deck.url().startsWith(DECK) && deck.url().endsWith('#page'), 'the deck is never moved, with or without a click in the page', deck.url())
  check(popups.length === 0, 'no window is opened', JSON.stringify(popups))
  check(downloads.length === 0, 'no download starts', JSON.stringify(downloads))
  const link = await deck.$eval('.slide.active .embed-open-link', (a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel }))
  check(link.href === REMOTE && link.target === '_blank' && link.rel.includes('noopener'), 'the Open link is the address as written, query and fragment kept', JSON.stringify(link))
  // Return hands the keys back to the deck.
  await deck.click('.embed-return-btn')
  await deck.keyboard.press('ArrowRight')
  await deck.waitForTimeout(400)
  check(await deck.evaluate(() => document.querySelector('.slide.active')?.dataset.id) === 'lookalike', 'after Return the arrow key moves the deck on', await deck.evaluate(() => location.hash))
  // The lookalike player address: the same page, in the same sandbox, clicked with a real activation.
  await deck.waitForFunction(() => document.querySelector('.slide.active figure.slide-embed iframe')?.src)
  const fake = await deck.$('.slide.active figure.slide-embed iframe')
  check(await fake.getAttribute('sandbox') === 'allow-scripts allow-same-origin allow-forms allow-presentation' && await fake.getAttribute('data-embed-video') === null, 'a lookalike player address is a sandboxed page, not a player', `${await fake.getAttribute('sandbox')} ${await fake.getAttribute('data-embed-video')}`)
  const fakeFrame = await fake.contentFrame()
  await fakeFrame.waitForFunction(() => window.tries && Object.keys(window.tries).length === 4)
  // A player has no Interact chip; its frame takes clicks directly, so a missing chip is not the failure.
  await deck.click('.slide.active .embed-interact-chip', { timeout: 2000 }).catch(() => {})
  for (const id of ['#top', '#blank', '#dl']) await fakeFrame.click(id).catch(() => {})
  await fakeFrame.evaluate(() => { try { top.location.href = '/escaped-lookalike' } catch { /* refused */ } try { window.open('/popup-lookalike') } catch { /* refused */ } })
  await deck.waitForTimeout(1200)
  check(deck.url().startsWith(DECK) && deck.url().endsWith('#lookalike'), 'the lookalike page never moves the deck', deck.url())
  check(popups.length === 0 && downloads.length === 0, 'the lookalike page opens no window and starts no download', JSON.stringify({ popups, downloads }))
  check(await deck.$('.slide.active .embed-open-link') !== null, 'the lookalike page keeps its Open link', 'missing')
} finally {
  await browser?.close()
  pageServer.close()
  deckServer.close()
}
if (failures) { console.error(`remote page sandbox: ${failures} failed`); process.exit(1) }
console.log('remote page sandbox: all checks passed')
