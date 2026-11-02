// The deck side of a live web page (?livepage=1, decks TalkWeaver opens itself; main's half is
// src/main/live-page-host.ts): the presenter's Current pane shows an empty slot and the strip under
// it (title, state, Open, Reload, Interact) instead of a frame; the audience slide shows the slot over
// its never-loaded frame; window.__twLivePageSlot() reports the slot's box, whether it is covered,
// Interact and Reload; window.__twLivePageState() renders text only. Without ?livepage=1 the deck is
// unchanged (the page stays a frame). No network: the frame is never loaded in live-page mode.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const URL_A = 'https://example.org/'
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const dir = mkdtempSync(join(process.cwd(), 'research/scratch-live-page-dom-'))
let browser
try {
  const outline = `---\ntitle: Live page\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Before {id=before}\n\n- A slide before\n\n### Radio Times {id=page}\n\n[Embed: ${URL_A}]\n\n### Composed {id=composed}\n\n- A point beside the page\n- Another point\n\n[Embed: https://audioarchive.semanticmachines.fyi]\n\n### After {id=after}\n\n- A slide after\n`
  const path = join(dir, 'live-page-outline.md'); writeFileSync(path, outline)
  const model = await prepareSource(path, outline, null, statSync(path), {}, {})
  const deckPath = join(dir, 'live-page-deck.html'); writeFileSync(deckPath, model.fullHtml)
  const deck = pathToFileURL(deckPath).href
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const errors = []
  const open = async (query, hash) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    const requests = []
    page.on('request', (r) => requests.push(r.url()))
    await page.goto(`${deck}?${query}#${hash}`)
    await page.waitForTimeout(700)
    return { page, requests }
  }
  const slot = async (page) => page.evaluate(() => window.__twLivePageSlot ? window.__twLivePageSlot() : 'no function')

  // Presenter, live-page mode.
  const { page: p, requests: pReq } = await open('presenter=1&livepage=1', 'page')
  const pane = p.locator('#currentPreview')
  await pane.locator('.live-page-slot').waitFor()
  assert.equal(await pane.locator('iframe').count(), 0, 'no frame in the Current pane')
  assert.equal(await pane.locator('.remote-preview-title').textContent(), 'Radio Times')
  assert.match(await pane.locator('.live-page-status').textContent(), /example\.org — Loading/)
  const link = pane.locator('.live-page-tools .embed-open-link')
  assert.equal(await link.getAttribute('href'), URL_A)
  assert.equal(await link.getAttribute('rel'), 'noopener')
  assert.ok(await pane.locator('.live-page-reload').isVisible())
  assert.ok(await pane.locator('.live-page-interact').isVisible())
  let r = await slot(p)
  const box = await pane.locator('.live-page-slot').boundingBox()
  assert.equal(r.v, 1); assert.equal(r.slideId, 'page'); assert.equal(r.url, URL_A); assert.equal(r.layoutWidth, null)
  assert.ok(Math.abs(r.rect.x - box.x) < 1 && Math.abs(r.rect.y - box.y) < 1 && Math.abs(r.rect.w - box.width) < 1 && Math.abs(r.rect.h - box.height) < 1, 'report = slot box')
  assert.equal(r.visible, true)
  const strip = await pane.locator('.live-page-tools').boundingBox()
  assert.ok(box.y + box.height <= strip.y + 1, 'the strip is never under the view')
  assert.ok(!pReq.some((u) => u.startsWith(URL_A)), 'the presenter deck never loads the page itself')
  // Interact: e, Esc; the strip button too.
  await p.keyboard.press('e'); r = await slot(p); assert.equal(r.interact, true)
  assert.match(await pane.locator('.live-page-interact').textContent(), /Esc/)
  await p.keyboard.press('Escape'); r = await slot(p); assert.equal(r.interact, false)
  await pane.locator('.live-page-interact').click(); r = await slot(p); assert.equal(r.interact, true)
  await p.evaluate(() => window.__twLivePageInteract(false)); r = await slot(p); assert.equal(r.interact, false, 'main ends Interact (Esc in the view)')
  // Reload.
  await pane.locator('.live-page-reload').click(); r = await slot(p); assert.equal(r.reloadSeq, 1)
  // State: text only.
  await p.evaluate(() => window.__twLivePageState(JSON.stringify({ v: 1, slideId: 'page', state: 'failed', host: 'x', message: '<img src=x onerror="window.__pwned=1">' })))
  assert.match(await pane.locator('.live-page-status').textContent(), /Couldn't load: <img src=x/)
  assert.equal(await pane.locator('img').count(), 0)
  assert.equal(await p.evaluate(() => window.__pwned), undefined)
  await p.evaluate(() => window.__twLivePageState(JSON.stringify({ v: 1, slideId: 'page', state: 'live', host: 'x', httpStatus: 403 })))
  assert.match(await pane.locator('.live-page-status').textContent(), /Live — the site answered 403/)
  await p.evaluate(() => window.__twLivePageState('{"v":1,"state":"pwned"}'))
  assert.match(await pane.locator('.live-page-status').textContent(), /403/, 'an unknown state is ignored')
  // Occlusion: the command palette and the outline cover the slot.
  await p.keyboard.press('Meta+Shift+KeyP'); await p.waitForTimeout(300)
  const paletteOpen = await p.evaluate(() => !!document.querySelector('.tw-palette:not([hidden]), [role="dialog"]:not([hidden])'))
  r = await slot(p); assert.equal(r.visible, false, `covered by the palette (palette open: ${paletteOpen})`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(300)
  r = await slot(p); assert.equal(r.visible, true, 'uncovered again')
  // The outline is a side panel: the Current pane makes room for it, so the slot (and the view main
  // lays over it) shrinks clear of the panel rather than being covered.
  await p.keyboard.press('o'); await p.waitForTimeout(400)
  r = await slot(p)
  const panelLeft = await p.evaluate(() => { const r = document.getElementById('presenterOutlineDrawer')?.getBoundingClientRect(); return r && r.width > 100 && r.left < innerWidth ? r.left : null })
  assert.ok(panelLeft !== null, 'the outline panel is open')
  assert.equal(r.visible, true)
  assert.ok(r.rect.x + r.rect.w <= panelLeft + 1, `slot ends at ${r.rect.x + r.rect.w}, panel starts at ${panelLeft}`)
  await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  r = await slot(p); assert.equal(r.visible, true)
  // Arrow keys move the deck; another slide has no slot.
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(500)
  assert.equal(await slot(p), null, 'a composed slide is not a live page slide')
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(500)
  r = await slot(p); assert.equal(r?.slideId, 'page', 'back on the page')
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(500)
  assert.equal(await slot(p), null)
  await p.close()

  // Audience, live-page mode.
  const { page: a, requests: aReq } = await open('audience=1&livepage=1', 'page')
  r = await slot(a)
  const aSlot = a.locator('.slide.active .live-page-slot')
  await aSlot.waitFor()
  const aBox = await aSlot.boundingBox()
  const fBox = await a.locator('.slide.active figure.slide-embed > iframe').boundingBox()
  assert.ok(Math.abs(aBox.x - fBox.x) < 1 && Math.abs(aBox.width - fBox.width) < 1 && Math.abs(aBox.height - fBox.height) < 1, 'slot laid over the frame\'s box')
  assert.equal(r.visible, true); assert.ok(r.layoutWidth > 400); assert.equal(r.interact, false)
  assert.equal(await a.locator('.slide.active figure.slide-embed > iframe').getAttribute('src'), null, 'the frame is never loaded')
  assert.ok(!aReq.some((u) => u.startsWith(URL_A)))
  await a.evaluate(() => window.__twLivePageState(JSON.stringify({ v: 1, slideId: 'page', state: 'blocked', host: 'x', message: 'nope' })))
  assert.match(await aSlot.textContent(), /Radio Times.*Blocked: nope.*example\.org/s)
  await a.keyboard.press('e'); r = await slot(a); assert.equal(r.interact, false, 'no Interact on the audience side')
  assert.equal(await a.evaluate(() => document.body.classList.contains('embed-interacting')), false)
  await a.keyboard.press('ArrowRight'); await a.waitForTimeout(400)
  assert.equal(await slot(a), null, 'the composed slide keeps its frame')
  assert.equal(await a.locator('.slide.active figure.slide-embed > iframe').count(), 1)
  await a.close()

  // Without ?livepage=1: unchanged.
  const { page: plain } = await open('presenter=1', 'page')
  assert.equal(await slot(plain), 'no function')
  await plain.locator('#currentPreview iframe[data-remote-embed]').waitFor()
  assert.equal(await plain.locator('#currentPreview .live-page-slot').count(), 0)
  await plain.close()
  const { page: plainAudience } = await open('audience=1', 'page')
  assert.equal(await plainAudience.locator('.live-page-slot').count(), 0)
  await plainAudience.close()

  assert.deepEqual(errors, [], 'no page errors')
  console.log('live page dom: presenter slot + strip, audience slot, report, occlusion, Interact/Esc, Reload, text-only state, unchanged without livepage=1')
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
