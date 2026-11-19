// =============================================================================
// test:presenter-pane-swap-dom (second part) — the pane rule under input and stalled loads
//
// The rule (previewSlide, presenter-popup-single-html.html): a pane shows either the picture of where
// the talk is, or the previous picture for at most a bounded time during which it accepts no input;
// never the previous picture as current, and never input from one picture applied to another.
//
// A slide's image is served by this test and can be held back, so the successor picture of that slide
// cannot finish loading. Then:
//   - input during a pending swap: Alpha's picture is on show, the talk is on Bravo. The pointer, the
//     pen, the highlighter (selecting "Alpha") and a click on a disclosure in Alpha's conversation
//     must do nothing; the review of PR 413 found each of them applied to Bravo. After the swap they
//     work on Bravo's picture again.
//   - a load that never finishes: the Current pane shows Bravo's picture (as far as it has got) by
//     the deadline, never Alpha's; also when the window's timers are held back (a hidden window),
//     where it settles when the window comes back.
//   - a slide video stays in the picture on show until its successor takes its place: the same
//     element, playing on (or paused) at its own time, and no dropped picture keeps one playing.
//   - a pane with the ink mark (Next, Then) keeps its picture on show while the next one is drawn.
// Browser: Playwright's bundled Chromium (never the installed Chrome).
// =============================================================================
import assert from 'node:assert/strict'
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
const clip = await readFile(join(root, 'e2e/fixtures/video-playback-12s.webm'))
const held = [] // image responses held back
let holding = true
const server = createServer((req, res) => {
  if (req.url.startsWith('/stall.svg')) {
    const send = () => { res.setHeader('content-type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c33"/></svg>') }
    if (holding) held.push(send); else send()
    return
  }
  if (req.url.startsWith('/clip.webm')) {
    // With byte ranges, as the app serves a slide's video, so it can be sought.
    res.setHeader('content-type', 'video/webm'); res.setHeader('accept-ranges', 'bytes')
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
    if (range) {
      const a = Number(range[1]), b = range[2] ? Number(range[2]) : clip.length - 1
      res.statusCode = 206; res.setHeader('content-range', `bytes ${a}-${b}/${clip.length}`); res.end(clip.subarray(a, b + 1)); return
    }
    res.end(clip); return
  }
  res.setHeader('content-type', 'text/html')
  res.end(deckHtml)
})
let deckHtml = ''
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
const origin = `http://127.0.0.1:${server.address().port}`

const md = `---
title: Pane rule
auto_title_slide: false
auto_thanks_slide: false
---
# Deck
## Section {id=sec}

### Alpha {id=alpha}
{chat}

\`\`\`chat
user: Alpha question here
model-reasoning (4s): Alpha thinking.
bot: Alpha answer.
\`\`\`

### Bravo {id=bravo}
{chat}

\`\`\`chat
user: Bravo question here
model-reasoning (4s): Bravo thinking.
bot: Bravo answer.
\`\`\`

![Slow](${origin}/stall.svg)

### Clip {id=clip}
{reveal}

- One
- Two

![Clip](${origin}/clip.webm){controls}

![Slow](${origin}/stall.svg)

### Plain {id=plain}

A plain slide.

### Inked {id=inked}

A slide to draw on.

### Last {id=last}

Done.
`
const scratch = await mkdtemp(join(tmpdir(), 'tw-pane-rule-'))
let browser
let failures = 0
const check = (ok, message) => { if (ok) console.log(`PASS ${message}`); else { failures++; console.error(`FAIL ${message}`) } }
try {
  const sourcePath = join(scratch, 'pane-rule.md')
  await writeFile(sourcePath, md)
  deckHtml = (await prepareSource(sourcePath, md, null, await stat(sourcePath), {}, {})).fullHtml
  browser = await chromium.launch({ headless: true })

  // A presenter (and its audience) with every message to the peer recorded.
  const open = async (session, hash, { audience = false } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript(() => {
      window.__sent = []
      const Native = window.BroadcastChannel
      window.BroadcastChannel = class extends Native {
        postMessage(message) { window.__sent.push(JSON.parse(JSON.stringify(message))); super.postMessage(message) }
      }
    })
    const errors = []
    let aud = null
    if (audience) {
      aud = await context.newPage()
      aud.on('pageerror', (e) => errors.push(`audience: ${e.message}`))
      await aud.goto(`${origin}/deck?audience=1&session=${session}#${hash}`)
    }
    const page = await context.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${origin}/deck?presenter=1&session=${session}#${hash}`)
    await page.waitForSelector('#currentPreview > iframe')
    await page.waitForTimeout(600)
    return { context, page, aud, errors }
  }
  const settled = (page) => page.waitForFunction(() => ['currentPreview', 'nextPreview', 'followingPreview'].every((id) => {
    const t = document.getElementById(id)
    return !t || !t.querySelector(':scope > iframe.preview-incoming, :scope > iframe.preview-outgoing')
  }), null, { timeout: 5000 })
  // The slide of the picture on show in a pane (never a waiting successor).
  const shownSlide = (page, id = 'currentPreview') => page.evaluate((id) => {
    const t = document.getElementById(id)
    const f = t.querySelector(':scope > iframe:not(.preview-incoming):not(.live-sim-frame)')
    return f?.contentDocument?.querySelector('.stage .slide')?.dataset.id || 'none'
  }, id)

  // ---- 1. Input during a pending swap -------------------------------------------------------
  // Each case: on Alpha, settled, the tool armed; then in ONE task (no load, no timer can intervene)
  // the talk steps to Bravo, whose picture cannot finish loading, and the input is made on the
  // picture on show (Alpha's). Recorded: what was sent to the audience and what the presenter holds.
  // A new address for Bravo's image, held back, so no copy in the cache lets Bravo's picture finish.
  const holdFresh = async (page, slideId = 'bravo') => {
    holding = true
    await page.evaluate(({ origin, slideId }) => {
      const n = (window.__stallN = (window.__stallN || 0) + 1)
      document.querySelectorAll(`.slide[data-id="${slideId}"] img`).forEach((img) => {
        for (const attr of ['src', 'data-lazy-src', 'data-src']) if (img.getAttribute(attr)?.includes('/stall.svg')) img.setAttribute(attr, `${origin}/stall.svg?n=${n}`)
      })
    }, { origin, slideId })
  }
  const release = () => { holding = false; held.splice(0).forEach((send) => send()) }
  {
    holding = false
    const { context, page, aud, errors } = await open('rule-input', 'alpha', { audience: true })
    await settled(page)
    check(await shownSlide(page) === 'alpha', 'setup: the Current pane shows Alpha')
    await holdFresh(page)

    // Pointer.
    await page.keyboard.press('i')
    const pointer = await page.evaluate(async () => {
      window.__sent.length = 0
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      const pane = document.getElementById('currentPreview')
      const pending = Boolean(pane.querySelector(':scope > iframe.preview-incoming'))
      const shown = pane.querySelector(':scope > iframe:not(.preview-incoming)')
      const r = shown.getBoundingClientRect()
      const root = document.querySelector('.tw-pointer-overlay') || [...document.body.children].find((el) => el.querySelector?.('.tw-pointer-ring'))
      for (const dx of [0.3, 0.31]) root?.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * dx, clientY: r.top + r.height * 0.5, bubbles: true }))
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
      const sent = window.__sent.filter((m) => m.command === 'pointer' && m.pointer !== 'gone')
      return { pending, shown: shown.contentDocument?.querySelector('.slide')?.dataset.id, root: Boolean(root), sent }
    })
    check(pointer.pending && pointer.shown === 'alpha' && pointer.root, `pointer: the swap is pending with Alpha on show (${JSON.stringify({ pending: pointer.pending, shown: pointer.shown, root: pointer.root })})`)
    check(pointer.sent.length === 0, `pointer: no point is sent while Alpha's picture is on show for Bravo (${JSON.stringify(pointer.sent.map((m) => m.pointer.slideId))})`)
    // After the swap the pointer points at Bravo again.
    release()
    await settled(page)
    const after = await page.evaluate(async () => {
      window.__sent.length = 0
      const shown = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      const r = shown.getBoundingClientRect()
      const root = [...document.body.children].find((el) => el.querySelector?.('.tw-pointer-ring'))
      for (const dx of [0.3, 0.31]) root?.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * dx, clientY: r.top + r.height * 0.5, bubbles: true }))
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))
      return window.__sent.filter((m) => m.command === 'pointer' && m.pointer !== 'gone').map((m) => m.pointer.slideId)
    })
    check(after.length > 0 && after.every((id) => id === 'bravo'), `pointer: after the swap it points at Bravo (${JSON.stringify(after)})`)
    await page.keyboard.press('i')

    // Back to Alpha for the next case, with Bravo's image held back again.
    const reset = async () => {
      await page.keyboard.press('ArrowLeft')
      await settled(page)
      assert.equal(await shownSlide(page), 'alpha')
      await holdFresh(page)
    }

    // Pen.
    await reset()
    await page.keyboard.press('d')
    const pen = await page.evaluate(async () => {
      window.__sent.length = 0
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      const pane = document.getElementById('currentPreview')
      const pending = Boolean(pane.querySelector(':scope > iframe.preview-incoming'))
      const shown = pane.querySelector(':scope > iframe:not(.preview-incoming)')
      const r = shown.getBoundingClientRect()
      const root = [...document.body.children].find((el) => el.querySelector?.('.tw-pointer-ring'))
      const at = (fx) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * 0.4, bubbles: true, pointerId: 7, button: 0, buttons: 1 })
      root?.dispatchEvent(new PointerEvent('pointerdown', at(0.2)))
      for (const fx of [0.3, 0.4, 0.5, 0.6]) root?.dispatchEvent(new PointerEvent('pointermove', at(fx)))
      root?.dispatchEvent(new PointerEvent('pointerup', { ...at(0.6), buttons: 0 }))
      await new Promise((ok) => setTimeout(ok, 120))
      const inked = window.__sent.filter((m) => m.command === 'ink' && ((m.ink?.strokes?.length || 0) > 0 || m.ink?.draft))
      const live = (() => { try { return JSON.parse(document.documentElement.dataset.twLiveInk || 'null') } catch { return null } })()
      return { pending, shown: shown.contentDocument?.querySelector('.slide')?.dataset.id, inked: inked.map((m) => m.ink.slideId), live: live && (live.strokes?.length || 0) }
    })
    check(pen.pending && pen.shown === 'alpha', `pen: the swap is pending with Alpha on show (${JSON.stringify({ pending: pen.pending, shown: pen.shown })})`)
    check(pen.inked.length === 0 && !pen.live, `pen: a line drawn on Alpha's picture is not put on Bravo (${JSON.stringify(pen)})`)
    release()
    await settled(page)
    // After the swap the pen draws on Bravo.
    const box = await page.locator('#currentPreview > iframe:not(.preview-incoming)').boundingBox()
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4)
    await page.mouse.down()
    for (const fx of [0.3, 0.4, 0.5]) await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.4)
    await page.mouse.up()
    await page.waitForTimeout(200)
    const drawn = await page.evaluate(() => window.__sent.filter((m) => m.command === 'ink' && (m.ink?.strokes?.length || 0) > 0).map((m) => m.ink.slideId))
    check(drawn.length > 0 && drawn.every((id) => id === 'bravo'), `pen: after the swap it draws on Bravo (${JSON.stringify([...new Set(drawn)])})`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('d')
    await page.evaluate(() => { window.__sent.length = 0 })

    // Highlighter: "Alpha" selected in Alpha's picture while the talk is on Bravo.
    await reset()
    await page.keyboard.press('h')
    const highlight = await page.evaluate(async () => {
      window.__sent.length = 0
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      const pane = document.getElementById('currentPreview')
      const pending = Boolean(pane.querySelector(':scope > iframe.preview-incoming'))
      const shown = pane.querySelector(':scope > iframe:not(.preview-incoming)')
      const doc = shown.contentDocument
      const walker = doc.createTreeWalker(doc.querySelector('.slide'), NodeFilter.SHOW_TEXT)
      let node = null
      while (walker.nextNode()) if (walker.currentNode.textContent.includes('Alpha answer')) { node = walker.currentNode; break }
      const at = node ? node.textContent.indexOf('Alpha') : -1
      if (node) {
        const range = doc.createRange(); range.setStart(node, at); range.setEnd(node, at + 5)
        const sel = shown.contentWindow.getSelection(); sel.removeAllRanges(); sel.addRange(range)
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      }
      await new Promise((ok) => setTimeout(ok, 60))
      return { pending, shown: doc.querySelector('.slide')?.dataset.id, found: Boolean(node), sent: window.__sent.filter((m) => m.command === 'highlight').map((m) => m.highlight) }
    })
    check(highlight.pending && highlight.shown === 'alpha' && highlight.found, `highlight: "Alpha" selected in Alpha's picture while the swap is pending (${JSON.stringify({ pending: highlight.pending, shown: highlight.shown, found: highlight.found })})`)
    check(highlight.sent.every((h) => !h.ranges?.length), `highlight: no highlight is sent for Bravo from Alpha's picture (${JSON.stringify(highlight.sent)})`)
    await page.waitForTimeout(150)
    const audienceMarks = await aud.evaluate(() => document.querySelectorAll('.slide[data-id="bravo"] mark, .slide[data-id="bravo"] .tw-highlight, .slide[data-id="bravo"] [data-highlight]').length)
    check(audienceMarks === 0, `highlight: the audience's Bravo slide carries no mark (${audienceMarks})`)
    release()
    await settled(page)
    await page.keyboard.press('h')

    // A disclosure click in Alpha's conversation while the talk is on Bravo.
    await reset()
    const sim = await page.evaluate(async () => {
      window.__sent.length = 0
      const live = () => [...document.querySelectorAll('.slide[data-id="bravo"] .sim-toggle')].map((b) => b.getAttribute('aria-expanded')).join(',')
      const before = live()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      const pane = document.getElementById('currentPreview')
      const pending = Boolean(pane.querySelector(':scope > iframe.preview-incoming'))
      const shown = pane.querySelector(':scope > iframe:not(.preview-incoming)')
      const f = shown.getBoundingClientRect(), s = f.width / 1280
      const el = shown.contentDocument.querySelector('.slide .sim-reasoning .sim-toggle')
      const r = el?.getBoundingClientRect()
      if (r) pane.dispatchEvent(new MouseEvent('click', { clientX: f.left + (r.left + r.width / 2) * s, clientY: f.top + (r.top + r.height / 2) * s, bubbles: true, detail: 1 }))
      await new Promise((ok) => setTimeout(ok, 60))
      return { pending, shown: shown.contentDocument.querySelector('.slide')?.dataset.id, found: Boolean(r), before, after: live() }
    })
    check(sim.pending && sim.shown === 'alpha' && sim.found, `simulation: a disclosure in Alpha's picture is clicked while the swap is pending (${JSON.stringify({ pending: sim.pending, shown: sim.shown, found: sim.found })})`)
    check(sim.after === sim.before, `simulation: Bravo's conversation does not change (${sim.before} -> ${sim.after})`)
    release()
    await settled(page)
    // After the swap a click on Bravo's disclosure works.
    const at = await page.evaluate(() => {
      const frame = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      const el = frame.contentDocument.querySelector('.slide .sim-reasoning .sim-toggle')
      const f = frame.getBoundingClientRect(), r = el.getBoundingClientRect(), s = f.width / 1280
      return { x: f.left + (r.left + r.width / 2) * s, y: f.top + (r.top + r.height / 2) * s }
    })
    await page.mouse.click(at.x, at.y)
    await page.waitForTimeout(200)
    const opened = await page.evaluate(() => [...document.querySelectorAll('.slide[data-id="bravo"] .sim-toggle')].map((b) => b.getAttribute('aria-expanded')).join(','))
    check(opened !== sim.after, `simulation: after the swap a click opens Bravo's part (${sim.after} -> ${opened})`)
    check(errors.length === 0, `input: no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // ---- 2. A load that never finishes --------------------------------------------------------
  {
    holding = false
    const { context, page, errors } = await open('rule-stall', 'alpha')
    await settled(page)
    await holdFresh(page)
    const started = Date.now()
    await page.keyboard.press('ArrowRight')
    // Never Alpha's picture as current past the deadline; by then Bravo's, as far as it has got.
    await page.waitForTimeout(DEADLINE_MS + 150)
    const at = await shownSlide(page)
    const outgoing = await page.evaluate(() => document.querySelectorAll('#currentPreview > iframe.preview-outgoing').length)
    check(at === 'bravo' && outgoing === 0, `stalled load: ${Date.now() - started} ms after the step the Current pane shows Bravo (${at}, ${outgoing} previous picture)`)
    await page.waitForTimeout(900)
    check(await shownSlide(page) === 'bravo', 'stalled load: and still Bravo after 1.2 s')
    check(held.length > 0, `stalled load: Bravo's image was still held back (${held.length})`)
    // Its image arrives later: the picture completes in place.
    release()
    await page.waitForFunction(() => document.querySelector('#currentPreview > iframe:not(.preview-incoming)')?.contentDocument?.readyState === 'complete', null, { timeout: 5000 })
    check(await shownSlide(page) === 'bravo', 'stalled load: once the image arrives the pane still shows Bravo')

    // The window's timers held back (as in a hidden window): the pane settles when the window comes
    // back, and no input reaches the previous picture meanwhile.
    await page.keyboard.press('ArrowLeft')
    await settled(page)
    await holdFresh(page)
    const hidden = await page.evaluate(async (deadline) => {
      const native = window.setTimeout
      window.setTimeout = () => 0 // every timer from now on is held back
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      await new Promise((ok) => native(ok, deadline + 150))
      const before = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')?.dataset.slideId
      document.dispatchEvent(new Event('visibilitychange'))
      const after = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')?.dataset.slideId
      window.setTimeout = native
      return { before, after }
    }, DEADLINE_MS)
    check(hidden.after === 'bravo', `held-back timers: on coming back the pane shows Bravo at once (before ${hidden.before}, after ${hidden.after})`)
    release()
    check(errors.length === 0, `stalled load: no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // ---- 3. A slide video stays in the picture on show until the swap -------------------------
  // The same video element plays on: in the picture on show while its successor waits, then in the
  // successor, with its playback time going on and its paused state kept; and no picture that is
  // dropped (a successor replaced by a newer one, the previous picture at the swap) keeps a video playing.
  {
    holding = false
    const { context, page, errors } = await open('rule-video', 'clip')
    await settled(page)
    const started = await page.evaluate(async () => {
      const frame = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      const v = frame?.contentDocument?.querySelector('video')
      if (!v) return { found: false }
      window.__video = v
      window.__seenVideos = new Set([v])
      v.muted = true
      try { await v.play() } catch {}
      const t0 = performance.now()
      while (v.currentTime < 0.4 && performance.now() - t0 < 4000) await new Promise((ok) => setTimeout(ok, 50))
      return { found: true, playing: !v.paused, time: v.currentTime }
    })
    check(started.found && started.playing && started.time >= 0.4, `video: the slide's video plays in the Current pane (${JSON.stringify(started)})`)
    await holdFresh(page, 'clip')
    // The pointer is armed too: the picture on show is of the same slide, one step behind.
    await page.keyboard.press('i')
    const video = await page.evaluate(async () => {
      window.__sent.length = 0
      const pane = document.getElementById('currentPreview')
      const seen = () => pane.querySelectorAll(':scope > iframe').forEach((f) => f.contentDocument?.querySelectorAll('video').forEach((v) => window.__seenVideos.add(v)))
      const shownDoc = () => pane.querySelector(':scope > iframe:not(.preview-incoming)')?.contentDocument
      const before = { time: window.__video.currentTime }
      // Two steps in one task: the first successor is dropped for the second while the swap is pending.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      seen()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      seen()
      const result = { pending: Boolean(pane.querySelector(':scope > iframe.preview-incoming')),
        during: window.__video.ownerDocument === shownDoc() && window.__video.isConnected }
      const r = pane.querySelector(':scope > iframe:not(.preview-incoming)').getBoundingClientRect()
      const root = [...document.body.children].find((el) => el.querySelector?.('.tw-pointer-ring'))
      for (const dx of [0.3, 0.31]) root?.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * dx, clientY: r.top + r.height * 0.5, bubbles: true }))
      await new Promise((ok) => setTimeout(ok, 120))
      seen()
      result.playingDuring = !window.__video.paused && window.__video.currentTime > before.time
      result.points = window.__sent.filter((m) => m.command === 'pointer' && m.pointer !== 'gone').length
      result.time = window.__video.currentTime
      return result
    })
    check(video.pending, `video: two steps on the video slide leave the swap pending (${JSON.stringify(video)})`)
    check(video.during && video.playingDuring, `video: the picture on show keeps the same video, still playing, while its successor waits (${JSON.stringify(video)})`)
    check(video.points === 0, `same slide, one step behind: the picture on show takes no pointer while its successor waits (${video.points} points sent)`)
    release()
    await settled(page)
    await page.waitForTimeout(150)
    const after = await page.evaluate((timeDuring) => {
      const doc = document.querySelector('#currentPreview > iframe:not(.live-sim-frame)')?.contentDocument
      const v = window.__video
      doc?.querySelectorAll('video').forEach((x) => window.__seenVideos.add(x))
      const others = [...window.__seenVideos].filter((x) => x !== v)
      return { same: Boolean(doc) && v.ownerDocument === doc && v.isConnected, playing: !v.paused, onward: v.currentTime >= timeDuring,
        othersPlaying: others.filter((x) => !x.paused).length, others: others.length,
        inShown: doc ? [...doc.querySelectorAll('video')].filter((x) => x === v).length : 0 }
    }, video.time)
    check(after.same && after.inShown === 1, `video: after the swap the same video element is in the new picture (${JSON.stringify(after)})`)
    check(after.playing && after.onward, `video: it is still playing and its time has gone on (${JSON.stringify(after)})`)
    check(after.othersPlaying === 0, `video: no other video plays, in a dropped picture or anywhere in the pane (${after.othersPlaying} of ${after.others})`)
    // Paused stays paused across a step.
    await holdFresh(page, 'clip')
    const paused = await page.evaluate(async () => {
      const v = window.__video
      v.pause()
      const t = v.currentTime
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true }))
      return { t }
    })
    release()
    await settled(page)
    await page.waitForTimeout(150)
    const pausedAfter = await page.evaluate((t) => {
      const doc = document.querySelector('#currentPreview > iframe:not(.live-sim-frame)')?.contentDocument
      const v = window.__video
      return { same: v.ownerDocument === doc && v.isConnected, paused: v.paused, time: Math.abs(v.currentTime - t) < 0.05 }
    }, paused.t)
    check(pausedAfter.same && pausedAfter.paused && pausedAfter.time, `video: a paused video stays the same element, paused at the same time, across a step (${JSON.stringify(pausedAfter)})`)
    await page.keyboard.press('i')
    check(errors.length === 0, `video: no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // ---- 4. The ink mark does not stop a swap -------------------------------------------------
  {
    holding = false
    const { context, page, errors } = await open('rule-ink', 'inked')
    await settled(page)
    await page.keyboard.press('d')
    const box = await page.locator('#currentPreview > iframe').boundingBox()
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4)
    await page.mouse.down()
    for (const fx of [0.3, 0.4, 0.5]) await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.4)
    await page.mouse.up()
    await page.keyboard.press('d')
    // Back one slide: Inked is in Next, with the ink mark; a step forward replaces Next's picture.
    await page.keyboard.press('ArrowLeft')
    await settled(page)
    const marked = await page.evaluate(() => Boolean(document.querySelector('#nextPreview > .tw-ink-mark')))
    check(marked, 'ink mark: Next shows the mark on Inked')
    const sample = await page.evaluate(async () => {
      const t = document.getElementById('nextPreview')
      // 1: a drawn, styled picture on show; 0: the pane is empty or its picture blank or unstyled.
      const count = () => {
        const shown = [...t.querySelectorAll(':scope > iframe')].filter((f) => getComputedStyle(f).visibility !== 'hidden')
        const doc = shown[shown.length - 1]?.contentDocument
        const stage = doc?.querySelector('.stage')
        return stage?.querySelector('.slide') && doc.defaultView.getComputedStyle(stage).containerType === 'size' ? 1 : 0
      }
      const out = []
      const tick = () => { out.push(count()); if (out.length < 40) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))
      out.push(count())
      await new Promise((ok) => setTimeout(ok, 800))
      return out
    })
    check(sample.every((n) => n >= 1), `ink mark: the Next pane never shows an empty, blank or unstyled picture while it changes (${sample.join('')})`)
    check(errors.length === 0, `ink mark: no page errors (${errors.join(' | ')})`)
    await context.close()
  }
} finally {
  held.splice(0).forEach((send) => send())
  await browser?.close()
  server.close()
  await rm(scratch, { recursive: true, force: true })
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('PASS the pane rule holds under input, stalled loads, videos and ink marks')
