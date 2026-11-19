// =============================================================================
// test:presenter-pane-swap-dom (third part) — the pane rule under real input
//
// The rule (above previewSlide, presenter-popup-single-html.html): when a pane is asked for a new
// picture, whatever was in progress on it is cancelled and the pane takes no input until that picture
// is shown. A pane never applies input from one picture to another.
//
// Every gesture here is made with Playwright's real mouse and keyboard (the second review of PR 413
// reproduced its findings that way), while the incoming picture cannot finish loading (one image of it
// is held back by this server), so the pane is in its pending swap until the 250 ms deadline:
//   1. a pen stroke in progress across a reveal step, a slide change and a card change: nothing is
//      published for it, the draft already sent is withdrawn, the audience has no ink for it, and the
//      pen draws again after the swap;
//   2. under Highlight mode, a link click, a click on the running page's "Click to interact" cover and
//      a text selection on the picture still on show reach nothing in the pane;
//   3. the shared stylesheet withheld at the deadline: the picture shown then is styled.
// Browser: Playwright's bundled Chromium (never the installed Chrome).
// =============================================================================
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createServer } from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const root = resolve(args.root || join(dirname(fileURLToPath(import.meta.url)), '..'))
const { prepareSource } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/08-source-adapters.mjs')).href)

const DEADLINE_MS = 250 // PANE_SWAP_DEADLINE_MS
const held = [] // responses held back (an image, a stylesheet)
let holding = true
const server = createServer((req, res) => {
  if (req.url.startsWith('/stall.svg')) {
    const send = () => { res.setHeader('content-type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c33"/></svg>') }
    if (holding) held.push(send); else send()
    return
  }
  if (req.url.startsWith('/held.css')) {
    // The deck's stylesheet, as late as the test likes.
    const send = () => { res.setHeader('content-type', 'text/css'); res.end(heldCss) }
    if (holding) held.push(send); else send()
    return
  }
  if (req.url.startsWith('/linked')) { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>linked</title><p id="linked">navigated</p>'); return }
  res.setHeader('content-type', 'text/html')
  res.end(deckHtml)
})
let deckHtml = '', heldCss = ''
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
const origin = `http://127.0.0.1:${server.address().port}`
const scratch = await mkdtemp(join(tmpdir(), 'tw-pane-input-'))
const embedPage = join(scratch, 'page.html')
await writeFile(embedPage, '<!doctype html><title>page</title><p>A running page.</p>')

const md = `---
title: Pane input
auto_title_slide: false
auto_thanks_slide: false
---
# Deck
## Section {id=sec}

### Alpha {id=alpha}

Alpha words to select, and [a link](${origin}/linked) to follow.

### Bravo {id=bravo}

Bravo words to select.

![Slow](${origin}/stall.svg)

### Steps {id=steps}
{reveal}

- Step one
- Step two
- Step three

![Slow](${origin}/stall.svg)

### Cards {id=cards}
{carousel}{reveal}

#### First card {id=cards-a}

- One

![Slow](${origin}/stall.svg)

#### Second card {id=cards-b}

- Two

![Slow](${origin}/stall.svg)

### Page {id=page}
{reveal}

- Page point one
- Page point two

[Embed: ${embedPage}]

![Slow](${origin}/stall.svg)

### Last {id=last}

Done.
`

let browser
let failures = 0
const check = (ok, message) => { if (ok) console.log(`PASS ${message}`); else { failures++; console.error(`FAIL ${message}`) } }
const release = () => { holding = false; held.splice(0).forEach((send) => send()) }
try {
  const sourcePath = join(scratch, 'pane-input.md')
  await writeFile(sourcePath, md)
  deckHtml = (await prepareSource(sourcePath, md, null, await stat(sourcePath), {}, {})).fullHtml
  browser = await chromium.launch({ headless: true })

  // A presenter and its audience, every message to the peer recorded.
  const open = async (session, hash) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      window.__sent = []
      const Native = window.BroadcastChannel
      window.BroadcastChannel = class extends Native {
        postMessage(message) { window.__sent.push(JSON.parse(JSON.stringify(message))); super.postMessage(message) }
      }
    })
    const errors = []
    const aud = await context.newPage()
    aud.on('pageerror', (e) => errors.push(`audience: ${e.message}`))
    await aud.goto(`${origin}/deck?audience=1&session=${session}#${hash}`)
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${origin}/deck?presenter=1&session=${session}#${hash}`)
    await page.waitForSelector('#currentPreview > iframe')
    await settled(page)
    await page.waitForTimeout(400)
    return { context, page, aud, errors }
  }
  const settled = (page) => page.waitForFunction(() => ['currentPreview', 'nextPreview', 'followingPreview'].every((id) => {
    const t = document.getElementById(id)
    return !t || !t.querySelector(':scope > iframe.preview-incoming, :scope > iframe.preview-outgoing')
  }), null, { timeout: 5000 })
  // A new address for a slide's held image, so no cached copy lets its picture finish loading.
  const holdFresh = async (page, slideId) => {
    holding = true
    await page.evaluate(({ origin, slideId }) => {
      const n = (window.__stallN = (window.__stallN || 0) + 1)
      document.querySelectorAll(`.slide[data-id="${slideId}"] img`).forEach((img) => {
        for (const attr of ['src', 'data-lazy-src', 'data-src']) if (img.getAttribute(attr)?.includes('/stall.svg')) img.setAttribute(attr, `${origin}/stall.svg?n=${n}`)
      })
    }, { origin, slideId })
  }
  const pane = (page) => page.evaluate(() => {
    const t = document.getElementById('currentPreview')
    const shown = t.querySelector(':scope > iframe:not(.preview-incoming):not(.live-sim-frame)')
    return { pending: Boolean(t.querySelector(':scope > iframe.preview-incoming')), inert: t.inert,
      shown: shown?.dataset.slideId || 'none', key: shown?.dataset.renderKey || '' }
  })
  const shownBox = (page) => page.locator('#currentPreview > iframe:not(.preview-incoming):not(.live-sim-frame)').first().boundingBox()
  const inkSent = (page) => page.evaluate(() => window.__sent.filter((m) => m.command === 'ink').map((m) => ({ slideId: m.ink?.slideId, strokes: m.ink?.strokes?.length || 0, draft: Boolean(m.ink?.draft) })))
  const audienceInk = (aud) => aud.evaluate(() => document.querySelectorAll('[data-pen-stroke]').length)

  // ---- 1. A pen stroke in progress across a request -----------------------------------------
  // From where, the step, the slide whose picture is held back, and what the pane shows after.
  const strokeCases = [
    { name: 'a reveal step', from: 'steps', hold: 'steps', after: 'steps' },
    { name: 'a slide change', from: 'alpha', hold: 'bravo', after: 'bravo' },
    { name: 'a card change', from: 'cards', hold: 'cards', after: 'cards' }
  ]
  for (const c of strokeCases) {
    holding = false
    const { context, page, aud, errors } = await open(`stroke-${c.from}`, c.from)
    const before = await pane(page)
    await holdFresh(page, c.hold)
    await page.keyboard.press('d')
    const box = await shownBox(page)
    const at = (fx, fy = 0.45) => [box.x + box.width * fx, box.y + box.height * fy]
    await page.evaluate(() => { window.__sent.length = 0 })
    // Before the request: the stroke is being drawn on the picture of where the talk is.
    await page.mouse.move(...at(0.2))
    await page.mouse.down()
    for (const fx of [0.25, 0.3, 0.35]) await page.mouse.move(...at(fx))
    await page.waitForTimeout(80)
    const drafting = (await inkSent(page)).some((m) => m.draft)
    // The request, with the button still down; the incoming picture cannot finish loading.
    await page.evaluate(() => { window.__sentAt = window.__sent.length })
    await page.keyboard.press('ArrowRight')
    const during = await pane(page)
    // During the pending swap: the stroke goes on.
    for (const fx of [0.4, 0.45, 0.5]) await page.mouse.move(...at(fx))
    const stillPending = (await pane(page)).pending
    // Across the swap (the deadline): the stroke goes on, then is released.
    await page.waitForTimeout(DEADLINE_MS + 120)
    const committed = await pane(page)
    for (const fx of [0.55, 0.6, 0.65]) await page.mouse.move(...at(fx))
    await page.mouse.up()
    await page.waitForTimeout(250)
    const sent = await page.evaluate(() => window.__sent.filter((m) => m.command === 'ink').map((m) => ({ slideId: m.ink?.slideId, strokes: m.ink?.strokes?.length || 0, draft: Boolean(m.ink?.draft) })))
    const afterRequest = await page.evaluate(() => window.__sent.slice(window.__sentAt).filter((m) => m.command === 'ink').map((m) => ({ strokes: m.ink?.strokes?.length || 0, draft: Boolean(m.ink?.draft) })))
    const live = await page.evaluate(() => { try { return JSON.parse(document.documentElement.dataset.twLiveInk || 'null') } catch { return null } })
    const audStrokes = await audienceInk(aud)
    check(drafting && during.pending && during.inert && stillPending && during.shown === before.shown,
      `stroke across ${c.name}: drawn on ${before.shown}, the draft was sent, then the request left the old picture pending and the pane inert (${JSON.stringify({ drafting, during, stillPending })})`)
    check(!committed.pending && committed.shown === c.after && !committed.inert, `stroke across ${c.name}: the new picture is shown by the deadline and the pane is live (${JSON.stringify(committed)})`)
    check(sent.every((m) => m.strokes === 0), `stroke across ${c.name}: no stroke is published (${JSON.stringify(sent.filter((m) => m.strokes))})`)
    check(afterRequest.length > 0 && afterRequest.every((m) => !m.draft && m.strokes === 0) && !afterRequest.at(-1).draft,
      `stroke across ${c.name}: the draft already sent is withdrawn and none is sent after the request (${JSON.stringify(afterRequest)})`)
    check(!live || ((live.strokes?.length || 0) === 0 && !live.draft), `stroke across ${c.name}: the venue's live ink holds nothing (${JSON.stringify(live)})`)
    check(audStrokes === 0, `stroke across ${c.name}: the audience shows no ink (${audStrokes} strokes drawn)`)
    // After the swap the pen draws on the new picture.
    release()
    await settled(page)
    const box2 = await shownBox(page)
    await page.evaluate(() => { window.__sent.length = 0 })
    await page.mouse.move(box2.x + box2.width * 0.2, box2.y + box2.height * 0.6)
    await page.mouse.down()
    for (const fx of [0.3, 0.4, 0.5]) await page.mouse.move(box2.x + box2.width * fx, box2.y + box2.height * 0.6)
    await page.mouse.up()
    await page.waitForTimeout(250)
    const drawn = (await inkSent(page)).filter((m) => m.strokes > 0).map((m) => m.slideId)
    const audAfter = await audienceInk(aud)
    check(drawn.length > 0 && drawn.every((id) => id === c.after) && audAfter > 0, `stroke across ${c.name}: after the swap the pen draws on ${c.after} (${JSON.stringify([...new Set(drawn)])}, audience ${audAfter})`)
    check(errors.length === 0, `stroke across ${c.name}: no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // ---- 2. Highlight mode: nothing reaches the picture still on show --------------------------
  {
    holding = false
    const { context, page, aud, errors } = await open('highlight-native', 'alpha')
    await holdFresh(page, 'bravo')
    await page.keyboard.press('h')
    // Every event that reaches Alpha's picture is counted there.
    const where = await page.evaluate(() => {
      const frame = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      const doc = frame.contentDocument
      window.__oldWindow = frame.contentWindow
      frame.contentWindow.__reached = []
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'selectstart', 'auxclick', 'contextmenu']) {
        doc.addEventListener(type, (e) => frame.contentWindow.__reached.push(`${type}:${e.target.nodeName}`), true)
      }
      const f = frame.getBoundingClientRect(), s = f.width / 1280
      const link = doc.querySelector('.slide a[href*="/linked"]')
      const r = link.getBoundingClientRect()
      const walker = doc.createTreeWalker(doc.querySelector('.slide'), NodeFilter.SHOW_TEXT)
      let node = null
      while (walker.nextNode()) if (walker.currentNode.textContent.includes('Alpha words')) { node = walker.currentNode; break }
      const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, 11)
      const t = range.getBoundingClientRect()
      return { link: [f.left + (r.left + r.width / 2) * s, f.top + (r.top + r.height / 2) * s],
        text: [f.left + (t.left + 1) * s, f.top + (t.top + t.height / 2) * s, f.left + (t.right - 1) * s] }
    })
    await page.evaluate(() => { window.__sent.length = 0 })
    await page.keyboard.press('ArrowRight')
    const during = await pane(page)
    await page.mouse.click(...where.link)
    await page.mouse.move(where.text[0], where.text[1])
    await page.mouse.down()
    await page.mouse.move(where.text[2], where.text[1], { steps: 4 })
    await page.mouse.up()
    const stillPending = (await pane(page)).pending
    const reached = await page.evaluate(() => {
      const w = window.__oldWindow
      let sel = ''
      try { sel = String(w.getSelection()) } catch {}
      let url = ''
      try { url = w.location.href } catch { url = 'gone' }
      return { events: w.__reached || [], sel, url }
    })
    check(during.pending && during.inert && during.shown === 'alpha' && stillPending, `highlight mode: Alpha's picture is on show, pending and inert, through the clicks and the drag (${JSON.stringify({ during, stillPending })})`)
    check(reached.events.length === 0, `highlight mode: no click, press or selection reaches Alpha's picture (${JSON.stringify(reached.events)})`)
    check(!reached.url.includes('/linked'), `highlight mode: the link in Alpha's picture is not followed (${reached.url})`)
    check(reached.sel === '', `highlight mode: nothing is selected in Alpha's picture (${JSON.stringify(reached.sel)})`)
    await page.waitForTimeout(DEADLINE_MS + 150)
    const sentHl = await page.evaluate(() => window.__sent.filter((m) => m.command === 'highlight' && m.highlight?.ranges?.length).map((m) => m.highlight.slideId))
    const marks = await aud.evaluate(() => document.querySelectorAll('.slide mark.hl-mark').length)
    check(sentHl.length === 0 && marks === 0, `highlight mode: no highlight is sent and the audience has no mark (${JSON.stringify(sentHl)}, ${marks} marks)`)
    // After the swap a selection in Bravo's picture highlights Bravo.
    release()
    await settled(page)
    const bravo = await page.evaluate(() => {
      const frame = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      const doc = frame.contentDocument
      const walker = doc.createTreeWalker(doc.querySelector('.slide'), NodeFilter.SHOW_TEXT)
      let node = null
      while (walker.nextNode()) if (walker.currentNode.textContent.includes('Bravo words')) { node = walker.currentNode; break }
      const range = doc.createRange(); range.setStart(node, 0); range.setEnd(node, 11)
      const t = range.getBoundingClientRect(), f = frame.getBoundingClientRect(), s = f.width / 1280
      return [f.left + (t.left + 1) * s, f.top + (t.top + t.height / 2) * s, f.left + (t.right - 1) * s]
    })
    await page.mouse.move(bravo[0], bravo[1])
    await page.mouse.down()
    await page.mouse.move(bravo[2], bravo[1], { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const hlAfter = await page.evaluate(() => window.__sent.filter((m) => m.command === 'highlight' && m.highlight?.ranges?.length).map((m) => m.highlight.slideId))
    check(hlAfter.length > 0 && hlAfter.every((id) => id === 'bravo'), `highlight mode: after the swap a selection highlights Bravo (${JSON.stringify(hlAfter)})`)
    check(errors.length === 0, `highlight mode: no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // ---- 2b. The running page's cover ("Click to interact") during a pending swap --------------
  {
    holding = false
    const { context, page, errors } = await open('cover', 'page')
    const ready = await page.evaluate(() => Boolean(document.querySelector('#currentPreview .live-sim-cover')))
    check(ready, 'cover: the Current pane runs the slide\'s page with its "Click to interact" cover')
    if (ready) {
      await holdFresh(page, 'page')
      await page.keyboard.press('h')
      await page.evaluate(() => {
        window.__coverClicks = 0
        document.querySelector('#currentPreview .live-sim-cover').addEventListener('click', (e) => { if (e.isTrusted) window.__coverClicks++ }, true)
      })
      const cover = await page.locator('#currentPreview .live-sim-cover').boundingBox()
      await page.keyboard.press('ArrowRight')
      const during = await page.evaluate(() => {
        const t = document.getElementById('currentPreview')
        return { pending: Boolean(t.querySelector(':scope > iframe.preview-incoming')), inert: t.inert }
      })
      await page.mouse.click(cover.x + cover.width / 2, cover.y + cover.height / 2)
      const result = await page.evaluate(() => ({ clicks: window.__coverClicks, engaged: document.getElementById('currentPreview').classList.contains('embed-engaged') }))
      check(during.pending && during.inert, `cover: a reveal step leaves the slide's picture pending and the pane inert (${JSON.stringify(during)})`)
      check(result.clicks === 0 && !result.engaged, `cover: a click on it during the pending swap does nothing (${JSON.stringify(result)})`)
      release()
      await settled(page)
      await page.keyboard.press('h')
      await page.mouse.click(cover.x + cover.width / 2, cover.y + cover.height / 2)
      const after = await page.evaluate(() => window.__coverClicks)
      check(after === 1, `cover: after the swap a click reaches it (${after})`)
    }
    check(errors.length === 0, `cover: no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // ---- 3. The stylesheet withheld at the deadline ---------------------------------------------
  {
    holding = false
    const { context, page, errors } = await open('styles-late', 'alpha')
    // From now on the presenter's shared stylesheet is an address this server holds back.
    heldCss = await page.evaluate(() => Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n'))
    holding = true
    await page.evaluate((origin) => {
      let n = 0
      URL.createObjectURL = () => `${origin}/held.css?n=${++n}`
      const bump = document.createElement('style'); bump.textContent = '/* new text: a new stylesheet */'; document.head.append(bump)
    }, origin)
    heldCss += '\n/* new text: a new stylesheet */'
    const started = Date.now()
    await page.keyboard.press('ArrowRight')
    const during = await pane(page)
    await page.waitForTimeout(DEADLINE_MS + 150)
    const at = await page.evaluate(() => {
      const frame = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      const doc = frame?.contentDocument
      const stage = doc?.querySelector('.stage')
      return { slide: frame?.dataset.slideId, inline: frame?.dataset.previewStylesInline === '1', pending: Boolean(document.querySelector('#currentPreview > iframe.preview-incoming')),
        styled: Boolean(stage?.querySelector('.slide') && doc.defaultView.getComputedStyle(stage).containerType === 'size') }
    })
    check(during.pending && during.shown === 'alpha', `stylesheet withheld: the step waits with Alpha on show (${JSON.stringify(during)})`)
    check(at.slide === 'bravo' && !at.pending && at.styled && at.inline, `stylesheet withheld: ${Date.now() - started} ms after the step Bravo is shown, styled with the stylesheet inline (${JSON.stringify(at)})`)
    check(held.some(Boolean), 'stylesheet withheld: the shared stylesheet was still held back')
    release()
    check(errors.length === 0, `stylesheet withheld: no page errors (${errors.join(' | ')})`)
    await context.close()
  }
} finally {
  held.splice(0).forEach((send) => send())
  await browser?.close()
  server.close()
  await rm(scratch, { recursive: true, force: true })
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('PASS a pane takes no input from the moment it is asked for a new picture until that picture is shown')
