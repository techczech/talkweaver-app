// 0.38 ticket 11.2 — embedded local pages run in a sandbox, and only on the slide being presented
// (design test matrix rows 2 to 6, 8, 13, 15). A compiled talk served from http://127.0.0.1
// (scripts/fixtures/embed-deck-fixture.mjs says why not file://), in headless Chromium.
//
//   1. the page does not run outside its live slide: nothing at deck load, once on its slide, the
//      placeholder everywhere else; leaving unloads it and coming back starts it again (row 8);
//   2. the live frame has an opaque origin, and storage and cookies it can use (rows 2, 15);
//   3. a hostile page cannot add to, read or change the deck's document, storage or address,
//      reach the presenter's bridge object, run a script in the deck, navigate the top window or
//      itself to a file, or learn the deck's session from its messages: in the plain deck, the
//      projector, the presenter's Current pane and a share page (rows 3 to 6, reproductions 1 to 4);
//   4. previews: the presenter's Next and Then panes, a preview document and a replay hold the
//      placeholder and no document (row 8);
//   5. `#anchor` links scroll inside the page (row 13); Interact and Escape;
//   6. print shows the placeholder;
//   7. a share page runs a page only on the current slide of the slide view, while that view is
//      the one showing: the phone's slide list, its full-screen picture and the home page's
//      Handout pane run nothing, their copies of a slide hold no document, and the page under
//      them stops and starts again on return.
// The page under test is read through the browser's debugging connection (Playwright frames),
// never through the deck: the deck has no way into the frame.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { serveEmbedFixture, embedFrames } from './fixtures/embed-deck-fixture.mjs'
import { presenterSelectors, audienceSelectors } from './lib/mode-selectors.mjs'

const fx = await serveEmbedFixture()
const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page of the fixture. The deck window gets a stand-in for the presenter's bridge object and a
 *  storage key of its own, both before any script of the deck runs. */
async function open(context, path) {
  const page = await context.newPage()
  page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error (${path}): ${error.message}`) })
  await page.addInitScript(() => {
    if (window !== window.top) return
    window.twLivePollBridge = { readClipboard: () => 'CLIPBOARD-SECRET', go: () => 'went' }
    try { localStorage.setItem('deck-key', 'untouched') } catch { /* not the deck */ }
  })
  await page.goto(`${fx.origin}${path}`, { waitUntil: 'load' })
  return page
}
const activeId = (page) => page.evaluate(() => document.querySelector('.slide.active')?.dataset.id ?? null)
/** Press Next (or Back) in `driver` until `page` shows the slide. */
async function goTo(driver, id, page = driver, key = 'ArrowRight') {
  for (let presses = 0; presses < 12 && await activeId(page) !== id; presses += 1) {
    const before = await activeId(page)
    await driver.keyboard.press(key)
    await page.waitForFunction((was) => document.querySelector('.slide.active')?.dataset.id !== was, before, { timeout: 5000 }).catch(() => {})
  }
  assert.equal(await activeId(page), id, `reached slide ${id}`)
}
const liveFrames = async (page) => (await embedFrames(page)).filter((entry) => entry.live)
async function liveFrame(page, where = () => true) {
  for (let tries = 0; tries < 60; tries += 1) {
    const found = (await liveFrames(page)).filter(where)
    if (found.length && found[0].url.startsWith('about:srcdoc')) return found[0]
    await sleep(50)
  }
  throw new Error('no live embedded frame')
}
const posterState = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.slide figure.slide-embed[data-embed="local"]')).map((figure) => ({
  slide: figure.closest('.slide').dataset.id,
  state: figure.getAttribute('data-embed-state'),
  poster: getComputedStyle(figure.querySelector('.embed-poster')).display !== 'none',
  frameHidden: getComputedStyle(figure.querySelector('iframe')).visibility === 'hidden',
  chip: getComputedStyle(figure.querySelector('.embed-interact-chip')).display !== 'none'
})))
const EXPECTED = {
  origin: 'null',
  appendImage: 'SecurityError', appendFrame: 'SecurityError',           // reproduction 1
  bridge: 'SecurityError', bridgeKeys: 'SecurityError',                 // reproduction 2
  appendScript: 'SecurityError', parentEval: 'SecurityError',           // reproduction 4
  parentDocument: 'SecurityError', parentStorage: 'SecurityError', parentHref: 'SecurityError', parentState: 'SecurityError',
  topNavigate: 'SecurityError', topHref: 'SecurityError',
  frameElement: 'DONE: null', popup: 'DONE: blocked', alert: 'DONE: undefined', postGuess: 'DONE: posted',
  peerAtLoad: 'DONE: posted',                                            // to every window it can name; see embed-peer-dom
  selfToFile: 'DONE: assigned', stillHere: 'Hostile'                    // reproduction 3: Chromium refuses; the page is still there
}
/** The hostile page's own record of what it tried, once it has tried everything. */
async function hostileResults(entry) {
  await entry.frame.waitForFunction(() => window.results && window.results.stillHere !== undefined, null, { timeout: 5000 })
  return entry.frame.evaluate(() => window.results)
}
/** The deck after the attack: nothing added, nothing run, nothing changed. */
const deckAfterAttack = (page) => page.evaluate(() => ({
  added: document.querySelectorAll('[data-attack]').length,
  ran: window.__attackRan === undefined,
  path: location.pathname,
  key: localStorage.getItem('deck-key'),
  slide: document.querySelector('.slide.active')?.dataset.id ?? null,
  bridge: typeof window.twLivePollBridge.readClipboard
}))

try {
  // ── 1 and 2. Runs only on its live slide; opaque origin; storage ────────────────────────────
  await check('plain deck: nothing runs at load; the page runs once on its slide, restarts on return, and is unloaded on leaving', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await open(context, '/deck.html')
    await sleep(600)
    assert.equal(await activeId(page), 'start')
    assert.deepEqual([fx.ran('sim'), fx.ran('hostile'), fx.ran('flood')], [0, 0, 0], 'no embedded page ran when the deck loaded')
    const idle = await embedFrames(page)
    assert.equal(idle.length, 4, 'four local-page frames in the deck')
    for (const entry of idle) {
      assert.deepEqual([entry.live, entry.url, entry.hasSrc, entry.hasSrcdoc, entry.sandbox], [false, 'about:blank', false, false, 'allow-scripts allow-forms'], `slide ${entry.slide}: an empty sandboxed frame`)
      assert.equal(await entry.frame.evaluate(() => document.documentElement.outerHTML), '<html><head></head><body></body></html>', 'the frame holds no document')
    }
    assert.ok((await posterState(page)).every((figure) => figure.state === 'idle' && figure.poster && figure.frameHidden && !figure.chip), 'every figure shows its placeholder')

    await goTo(page, 'sim')
    const live = await liveFrame(page)
    await live.frame.waitForFunction(() => window.storage)
    assert.equal(fx.ran('sim'), 1, 'the page ran once, on its slide')
    assert.deepEqual([live.slide, live.sandbox, live.hasSrc, live.visible], ['sim', 'allow-scripts allow-forms', false, true])
    assert.deepEqual(await live.frame.evaluate(() => [self.origin, document.compatMode, document.querySelector('base').getAttribute('href')]), ['null', 'CSS1Compat', 'about:srcdoc'], 'an opaque origin, standards mode, the srcdoc base')
    assert.deepEqual(await live.frame.evaluate(() => window.storage), { before: null, cookie: '', error: null, after: '1' }, 'the page reads and writes storage and cookies with no error')
    assert.deepEqual((await posterState(page)).filter((figure) => figure.slide === 'sim'), [{ slide: 'sim', state: 'live', poster: false, frameHidden: false, chip: true }], 'on its slide the page shows, not the placeholder')
    assert.deepEqual((await liveFrames(page)).map((entry) => entry.slide), ['sim'], 'only the current slide\'s frame is live')
    // Its state so far.
    await page.keyboard.press('e')
    await live.frame.click('#inc')
    assert.equal(await live.frame.evaluate(() => window.clicks), 1)

    // Leaving unloads it.
    await goTo(page, 'attack')
    await page.waitForFunction(() => document.querySelector('.slide[data-id="sim"] figure.slide-embed').getAttribute('data-embed-state') === 'idle')
    await sleep(200)
    const left = (await embedFrames(page)).find((entry) => entry.slide === 'sim')
    assert.deepEqual([left.live, left.url, left.hasSrcdoc], [false, 'about:blank', false], 'after leaving: an empty frame again')
    assert.equal(await left.frame.evaluate(() => document.documentElement.outerHTML), '<html><head></head><body></body></html>')
    assert.equal(await page.evaluate(() => document.body.classList.contains('embed-interacting')), false, 'leaving the slide ends Interact')

    // Coming back starts the page from its beginning: a new run, no kept state, no kept storage.
    await goTo(page, 'sim', page, 'ArrowLeft')
    const again = await liveFrame(page)
    await again.frame.waitForFunction(() => window.storage)
    assert.equal(fx.ran('sim'), 2, 'a second run')
    assert.deepEqual(await again.frame.evaluate(() => [window.clicks, window.storage.before, document.getElementById('count').textContent]), [0, null, '0'], 'the page starts again; nothing survives')
    await context.close()
  })

  // ── 3. The reproductions, in every runtime ──────────────────────────────────────────────────
  for (const runtime of ['plain deck', 'share page']) {
    await check(`${runtime}: a hostile page reaches nothing of the page that embeds it`, async () => {
      fx.resetRuns()
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, runtime === 'plain deck' ? '/deck.html' : '/handout.html')
      await sleep(300)
      assert.equal(fx.ran('hostile') + fx.ran('sim') + fx.ran('flood'), 0, 'nothing ran at load')
      await goTo(page, 'attack')
      const live = await liveFrame(page)
      assert.deepEqual(await hostileResults(live), EXPECTED)
      assert.equal(fx.ran('hostile'), 1)
      assert.deepEqual(await deckAfterAttack(page), { added: 0, ran: true, path: runtime === 'plain deck' ? '/deck.html' : '/handout.html', key: 'untouched', slide: 'attack', bridge: 'function' })
      assert.deepEqual(fx.hijacked(), [], 'neither the top window nor a new window went anywhere')
      assert.deepEqual(await live.frame.evaluate(() => window.received), [], 'the page was sent nothing it can read')
      assert.deepEqual((await liveFrames(page)).map((entry) => entry.slide), ['attack'])
      await context.close()
    })
  }

  await check('presenter and projector: the hostile page reaches neither window, and learns nothing of the session', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const session = `embed-sandbox-${Date.now()}`
    const projector = await open(context, `/deck.html?audience=1&session=${session}`)
    const presenter = await open(context, `/deck.html?presenter=1&session=${session}`)
    await presenter.waitForSelector('#currentPreview')
    await sleep(500)
    assert.deepEqual([fx.ran('sim'), fx.ran('hostile'), fx.ran('flood')], [0, 0, 0], 'two windows open on the first slide: no page ran, not even for the Next and Then panes')

    await goTo(presenter, 'attack', projector)
    const pane = await liveFrame(presenter, (entry) => entry.pane)
    const projected = await liveFrame(projector)
    assert.deepEqual(await hostileResults(pane), EXPECTED, 'in the presenter\'s Current pane')
    assert.deepEqual(await hostileResults(projected), EXPECTED, 'in the projector')
    assert.equal(pane.sandbox, 'allow-scripts allow-forms', 'the pane\'s frame carries the compiled sandbox')
    assert.deepEqual(await deckAfterAttack(presenter), { added: 0, ran: true, path: '/deck.html', key: 'untouched', slide: 'attack', bridge: 'function' })
    assert.deepEqual(await deckAfterAttack(projector), { added: 0, ran: true, path: '/deck.html', key: 'untouched', slide: 'attack', bridge: 'function' })
    // The presenter's own hidden deck never runs a page: its slide frames are all idle.
    assert.deepEqual((await embedFrames(presenter)).filter((entry) => !entry.pane).map((entry) => [entry.live, entry.url]), [[false, 'about:blank'], [false, 'about:blank'], [false, 'about:blank'], [false, 'about:blank']])
    assert.equal(fx.ran('hostile'), 2, 'one run in the pane, one in the projector')

    // A real click in the pane makes the presenter send an event to its peer. The page's frame has
    // posted to the deck (its agent's ready, its own guesses), and must not have become "the peer":
    // nothing of the deck's command traffic, and so nothing of the session, reaches the page.
    await presenter.click('#currentPreview .live-sim-cover')
    await pane.frame.click('#inc')
    await projected.frame.waitForFunction(() => window.clicks === 1)
    await presenter.keyboard.press('ArrowRight')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'both')
    await presenter.keyboard.press('ArrowLeft')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'attack')
    const paneAgain = await liveFrame(presenter, (entry) => entry.pane)
    await hostileResults(paneAgain)
    await presenter.click('#currentPreview .live-sim-cover')
    await paneAgain.frame.click('#inc')
    await sleep(300)
    assert.deepEqual(await paneAgain.frame.evaluate(() => window.received), [], 'the page in the pane received no deck message')
    assert.deepEqual(await (await liveFrame(projector)).frame.evaluate(() => window.received), [], 'nor did the projector\'s copy')
    assert.equal(await activeId(presenter), 'attack', 'and its guessed state message moved nothing')
    assert.deepEqual(fx.hijacked(), [])
    await context.close()
  })

  // ── 4. Previews ─────────────────────────────────────────────────────────────────────────────
  await check('the presenter\'s Next and Then panes, and its Current pane off an embed slide, hold the placeholder and no document', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const presenter = await open(context, `/deck.html?presenter=1&session=embed-panes-${Date.now()}`)
    await presenter.waitForSelector('#nextPreview iframe')
    await sleep(600)
    // On "start": Next is "sim", Then is "attack".
    const panes = async () => {
      const out = {}
      for (const id of ['currentPreview', 'nextPreview', 'followingPreview']) {
        const handle = await presenter.$(`#${id} > iframe`)
        const frame = handle ? await handle.contentFrame() : null
        out[id] = frame ? await frame.evaluate(() => ({
          slide: document.querySelector('.slide')?.dataset.id ?? null,
          doc: document.querySelectorAll('[data-embed-doc], iframe[srcdoc], iframe[src]').length,
          frames: Array.from(document.querySelectorAll('figure.slide-embed iframe')).map((el) => [el.getAttribute('sandbox'), el.contentWindow.length]),
          poster: Array.from(document.querySelectorAll('.embed-poster')).map((el) => getComputedStyle(el).display !== 'none' && el.querySelector('.embed-poster-kind').textContent),
          state: Array.from(document.querySelectorAll('figure.slide-embed')).map((el) => el.getAttribute('data-embed-state'))
        })).catch(() => 'opaque') : null
      }
      return out
    }
    const atStart = await panes()
    assert.deepEqual(atStart.nextPreview, { slide: 'sim', doc: 0, frames: [['allow-scripts allow-forms', 0]], poster: ['Interactive page'], state: ['idle'] }, 'Next: the labelled box, an empty sandboxed frame')
    assert.deepEqual(atStart.followingPreview, { slide: 'attack', doc: 0, frames: [['allow-scripts allow-forms', 0]], poster: ['Interactive page'], state: ['idle'] }, 'Then: the same')
    assert.deepEqual([fx.ran('sim'), fx.ran('hostile'), fx.ran('flood')], [0, 0, 0], 'no page ran for a preview')

    // On "sim": the Current pane IS the live page; Next ("attack") and Then ("both") are placeholders.
    await goTo(presenter, 'sim')
    await liveFrame(presenter, (entry) => entry.pane)
    await sleep(500)
    const atSim = await panes()
    assert.deepEqual(atSim.nextPreview.poster, ['Interactive page'])
    assert.deepEqual(atSim.followingPreview.poster, ['Interactive page', 'Interactive page'])
    assert.deepEqual([atSim.nextPreview.doc, atSim.followingPreview.doc], [0, 0])
    assert.deepEqual([fx.ran('sim'), fx.ran('hostile'), fx.ran('flood')], [1, 0, 0], 'only the Current pane\'s page ran, once')
    // The pane is not rebuilt while it shows the same slide: the page is not restarted by a re-render.
    await presenter.evaluate(() => window.dispatchEvent(new Event('resize')))
    await presenter.keyboard.press('?'); await presenter.keyboard.press('Escape')
    await sleep(300)
    assert.equal(fx.ran('sim'), 1, 'still one run')
    // Past the embed slides the Current pane is an ordinary preview again and the page is gone.
    await goTo(presenter, 'end')
    await sleep(300)
    assert.deepEqual((await embedFrames(presenter)).filter((entry) => entry.live), [], 'no live frame is left in the presenter')
    await context.close()
  })

  await check('a preview document and a replay never run a page', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    assert.equal(fx.pages['/preview.html'].includes(' data-embed-doc="'), false, 'markSlidePreviewHtml leaves no data-embed-doc')
    for (const path of ['/preview.html#sim', '/preview.html#attack', '/deck.html?replay=1#sim']) {
      const page = await open(context, path)
      await sleep(500)
      const want = path.split('#')[1]
      assert.equal(await activeId(page), want, `${path}: on the embed slide`)
      assert.deepEqual((await embedFrames(page)).map((entry) => [entry.live, entry.url]), [[false, 'about:blank'], [false, 'about:blank'], [false, 'about:blank'], [false, 'about:blank']], `${path}: no frame holds a page`)
      const shown = await page.evaluate(() => {
        const figure = document.querySelector('.slide.active figure.slide-embed')
        return { state: figure.getAttribute('data-embed-state'), poster: getComputedStyle(figure.querySelector('.embed-poster')).display !== 'none', frame: figure.querySelector('iframe').contentWindow.length === 0 && !figure.querySelector('iframe').hasAttribute('srcdoc'), docs: document.querySelectorAll('[data-embed-doc]').length }
      })
      assert.deepEqual(shown, { state: 'idle', poster: true, frame: true, docs: path.startsWith('/preview') ? 0 : 4 }, `${path}: the placeholder`)
      // Keys and the Interact key change nothing about that.
      await page.keyboard.press('e')
      await sleep(150)
      assert.deepEqual((await embedFrames(page)).filter((entry) => entry.live), [])
      await page.close()
    }
    assert.deepEqual([fx.ran('sim'), fx.ran('hostile'), fx.ran('flood')], [0, 0, 0], 'no page ran in a preview or a replay')
    await context.close()
  })

  // ── 5. Anchors, Interact, Escape ────────────────────────────────────────────────────────────
  for (const runtime of ['plain deck', 'share page']) {
    await check(`${runtime}: an #anchor link scrolls inside the page; Interact gives it the pointer, Escape takes it back`, async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, runtime === 'plain deck' ? '/deck.html' : '/handout.html')
      await goTo(page, 'sim')
      const live = await liveFrame(page)
      await live.frame.waitForFunction(() => window.storage)
      const element = await live.frame.frameElement()
      // Before Interact the page takes no pointer.
      assert.equal(await element.evaluate((el) => getComputedStyle(el).pointerEvents), 'none', 'a page takes no pointer until Interact')
      if (runtime === 'plain deck') await page.keyboard.press('e')
      else await page.click('.slide.active figure.slide-embed .embed-interact-chip')
      assert.equal(await element.evaluate((el) => getComputedStyle(el).pointerEvents), 'auto')
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.slide.active figure.slide-embed iframe')), true, 'Interact puts the focus on the frame')

      await live.frame.click('#jump')
      await live.frame.waitForFunction(() => document.scrollingElement.scrollTop > 2000 && location.hash === '#far' && window.hashChanges === 1, null, { timeout: 5000 })
      assert.deepEqual(await live.frame.evaluate(() => [location.hash, window.hashChanges, document.querySelector(':target')?.id ?? null, document.querySelector('h1').textContent, window.clicks]),
        ['#far', 1, 'far', 'Sim', 0], 'the link scrolled to its target; the frame still holds the page, not the deck')
      assert.equal(await activeId(page), 'sim', 'the deck did not move')
      assert.equal(await page.evaluate(() => location.pathname), runtime === 'plain deck' ? '/deck.html' : '/handout.html')

      // Escape, pressed inside the page, hands the keyboard back.
      await live.frame.click('#keybox')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.activeElement !== document.querySelector('.slide.active figure.slide-embed iframe'), null, { timeout: 5000 })
      assert.equal(await element.evaluate((el) => getComputedStyle(el).pointerEvents), 'none', 'Escape ends Interact')
      assert.equal(await activeId(page), 'sim')
      assert.equal(await live.frame.evaluate(() => window.storage.error), null, 'the page is still running')
      await context.close()
    })
  }

  // ── Step plans (row 22) ─────────────────────────────────────────────────────────────────────
  await check('the placeholder is no Reveal or Focus unit, in the deck or on a share page', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    for (const [path, selectors] of [['/deck.html', presenterSelectors], ['/handout.html', audienceSelectors]]) {
      const page = await open(context, path)
      const lists = ['MODE_SELECTOR', 'CARD_UNIT_SELECTOR'].map((name) => selectors(name).join(','))
      const found = await page.evaluate((all) => all.map((selector) => {
        const units = Array.from(document.querySelectorAll(selector))
        return { units: units.length, inPoster: units.filter((el) => el.closest('.embed-poster')).length, posters: document.querySelectorAll('.embed-poster').length }
      }), lists)
      for (const entry of found) assert.deepEqual([entry.inPoster, entry.posters], [0, 4], `${path}: no unit is, or is inside, a placeholder (${entry.units} units in all)`)
      await page.close()
    }
    await context.close()
  })

  // ── 6. Print ────────────────────────────────────────────────────────────────────────────────
  await check('print: the placeholder, live or not; no frame', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await open(context, '/deck.html')
    await goTo(page, 'sim')
    await liveFrame(page)
    await page.emulateMedia({ media: 'print' })
    const printed = await page.evaluate(() => Array.from(document.querySelectorAll('figure.slide-embed[data-embed="local"]')).map((figure) => [
      getComputedStyle(figure.querySelector('.embed-poster')).display, getComputedStyle(figure.querySelector('iframe')).display, getComputedStyle(figure.querySelector('.embed-interact-chip')).display
    ]))
    assert.deepEqual(printed, [['flex', 'none', 'none'], ['flex', 'none', 'none'], ['flex', 'none', 'none'], ['flex', 'none', 'none']])
    await context.close()
  })

  // ── 7. Share page views: one live page, on the stage, while the stage shows ─────────────────
  const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
  const runs = () => [fx.ran('sim'), fx.ran('hostile'), fx.ran('flood')]
  // The stage's own current slide (the phone list's copies carry .active too, and come first).
  const stageId = (page) => page.evaluate(() => document.querySelector('#stage > .slide.active')?.dataset.id ?? null)
  /** Every local-page frame of a share page: where it sits, and what it carries. */
  const shareFrames = (page) => page.evaluate(() => Array.from(document.querySelectorAll('figure.slide-embed[data-embed="local"] > iframe')).map((frame) => ({
    where: frame.closest('#stage') ? 'stage' : frame.closest('#phoneList') ? 'list' : frame.closest('#fsInner') ? 'full' : 'other',
    slide: frame.closest('.slide')?.dataset.id ?? null,
    doc: frame.hasAttribute('data-embed-doc'),
    loaded: frame.hasAttribute('srcdoc') || frame.hasAttribute('src'),
    state: frame.parentElement.getAttribute('data-embed-state')
  })))
  const loadedIn = async (page) => (await shareFrames(page)).filter((entry) => entry.loaded).map((entry) => `${entry.where}:${entry.slide}`)
  /** The copies of slides (everything outside the stage) carry no document and are idle. */
  async function copiesAreInert(page, where, atLeast) {
    const copies = (await shareFrames(page)).filter((entry) => entry.where !== 'stage')
    assert.ok(copies.filter((entry) => entry.where === where).length >= atLeast, `${where}: ${atLeast} or more copied frames to check (found ${copies.length})`)
    assert.deepEqual(copies.filter((entry) => entry.doc || entry.loaded || entry.state !== 'idle'), [], `${where}: no copy carries a document or is live`)
    assert.ok((await embedFrames(page)).every((entry) => entry.url === 'about:blank' || entry.active && entry.live), 'no copied frame holds a page')
  }
  /** The stage's frame for `slide` is idle and empty again. */
  async function stageIdle(page, slide) {
    await page.waitForFunction((id) => document.querySelector(`#stage .slide[data-id="${id}"] figure.slide-embed`).getAttribute('data-embed-state') === 'idle', slide)
    await sleep(250)
    assert.deepEqual(await loadedIn(page), [], 'no frame holds a document')
    for (const entry of await embedFrames(page)) {
      assert.equal(entry.url, 'about:blank')
      assert.equal(await entry.frame.evaluate(() => document.documentElement.outerHTML), '<html><head></head><body></body></html>', 'the frame holds no document: the page has stopped')
    }
  }
  const fillPhoneList = async (page) => {
    await page.evaluate(() => { const list = document.getElementById('phoneList'); list.scrollTo(0, list.scrollHeight) })
    await page.waitForFunction(() => document.querySelectorAll('#phoneList .slide figure.slide-embed[data-embed="local"] > iframe').length === 4)
  }

  await check('share page, desktop: the slide view runs the current slide\'s page; the overview runs nothing more', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await open(context, '/handout.html')
    await sleep(400)
    assert.deepEqual(runs(), [0, 0, 0])
    await goTo(page, 'sim')
    const live = await liveFrame(page)
    await live.frame.waitForFunction(() => window.storage)
    assert.deepEqual([runs(), await loadedIn(page)], [[1, 0, 0], ['stage:sim']])
    await page.click('#overviewBtn')
    await sleep(400)
    assert.deepEqual([runs(), await loadedIn(page)], [[1, 0, 0], ['stage:sim']], 'the overview adds no page and does not restart this one')
    await context.close()
  })

  await check('share page, phone: the slide list runs no page, before or after a slide is opened; its copies hold no document', async () => {
    fx.resetRuns()
    const context = await browser.newContext(PHONE)
    const page = await open(context, '/handout.html')
    assert.equal(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), true, 'a phone opens on the slide list')
    await fillPhoneList(page)
    await sleep(400)
    await copiesAreInert(page, 'list', 4)
    assert.deepEqual([runs(), await loadedIn(page)], [[0, 0, 0], []], 'the list ran nothing')
    // Opening ANY slide re-renders the page; the copies in the list carry .active for their layout.
    await page.click('.pslide-row[data-index="0"]')
    await page.waitForFunction(() => document.body.classList.contains('phone-detail-mode'))
    await sleep(500)
    assert.deepEqual([await stageId(page), runs(), await loadedIn(page)], ['start', [0, 0, 0], []], 'a slide without a page was opened: still nothing ran')
    await page.click('#phoneBack')
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await sleep(400)
    await copiesAreInert(page, 'list', 4)
    assert.deepEqual([runs(), await loadedIn(page)], [[0, 0, 0], []], 'back on the list: nothing ran')
    await context.close()
  })

  await check('share page, phone: the page runs on the opened slide only, stops under the list and the full-screen picture, and starts again on return', async () => {
    fx.resetRuns()
    const context = await browser.newContext(PHONE)
    const page = await open(context, '/handout.html')
    await fillPhoneList(page)
    await page.click('.pslide-row[data-index="1"]')
    const live = await liveFrame(page)
    await live.frame.waitForFunction(() => window.storage)
    assert.deepEqual([await stageId(page), runs(), await loadedIn(page), live.visible], ['sim', [1, 0, 0], ['stage:sim'], true], 'one page, on the stage')

    // The list covers the stage: the page stops.
    await page.click('#phoneBack')
    await stageIdle(page, 'sim')
    await copiesAreInert(page, 'list', 4)
    assert.deepEqual(runs(), [1, 0, 0])
    // Back on the slide: it starts from its beginning.
    await page.click('.pslide-row[data-index="1"]')
    const again = await liveFrame(page)
    await again.frame.waitForFunction(() => window.storage)
    assert.deepEqual([runs(), await loadedIn(page), await again.frame.evaluate(() => window.clicks)], [[2, 0, 0], ['stage:sim'], 0], 'a second run, from the start')

    // The full-screen picture covers the stage too, and is itself a copy.
    await page.click('#phoneFull')
    await stageIdle(page, 'sim')
    await copiesAreInert(page, 'full', 1)
    await page.click('#fsNext')
    await page.waitForFunction(() => document.querySelector('#fsInner .slide')?.dataset.id === 'attack')
    await sleep(400)
    await copiesAreInert(page, 'full', 1)
    assert.deepEqual([await stageId(page), runs(), await loadedIn(page)], ['attack', [2, 0, 0], []], 'stepping the full-screen picture runs nothing')
    await page.click('#fsClose')
    await liveFrame(page)
    for (let tries = 0; tries < 40 && fx.ran('hostile') < 1; tries += 1) await sleep(50)
    assert.deepEqual([runs(), await loadedIn(page)], [[2, 1, 0], ['stage:attack']], 'closing it shows the stage again: its page runs')
    await context.close()
  })

  await check('share page, phone: a list built while a page is live copies no running page', async () => {
    fx.resetRuns()
    const context = await browser.newContext(PHONE)
    const page = await open(context, '/handout.html#sim')
    const live = await liveFrame(page)
    await live.frame.waitForFunction(() => window.storage)
    assert.deepEqual([await page.evaluate(() => document.body.classList.contains('phone-detail-mode')), runs(), await loadedIn(page)], [true, [1, 0, 0], ['stage:sim']], 'a link to a slide opens that slide, and its page runs once')
    await page.click('#phoneBack')
    await fillPhoneList(page)
    await stageIdle(page, 'sim')
    await copiesAreInert(page, 'list', 4)
    assert.deepEqual(runs(), [1, 0, 0], 'the copy of the slide did not run its page')
    await context.close()
  })

  await check('home page: the stage\'s page runs only while the Live pane shows', async () => {
    // The live service, as scripts/handout-home-live-dom.test.mjs stubs it: discovery answers from
    // window.__live; the socket greets and answers a sync with an empty snapshot.
    const stub = () => {
      if (window !== window.top) return
      window.fetch = async (url) => (String(url).endsWith('/capabilities')
        ? { ok: true, status: 200, json: async () => ({ protocol: 2, build: '20' }) }
        : { ok: true, status: 200, json: async () => (window.__live ? { live: true, sessionId: 'session-1', protocol: 2 } : { live: false }) })
      window.WebSocket = class {
        static OPEN = 1
        readyState = 0
        constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 6e6 }) }) }
        send(raw) {
          const m = JSON.parse(raw)
          if (m.type === 'session.ping') this.emit({ type: 'session.pong', nonce: m.nonce })
          if (m.type === 'session.sync') queueMicrotask(() => this.emit({ type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: m.syncId, expiresAt: Date.now() + 6e6, slideState: null, polls: [], receipts: [] }))
        }
        close() { this.readyState = 3 }
        emit(m) { this.onmessage?.({ data: JSON.stringify(m) }) }
      }
    }
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      // Not live: the Handout pane; the stage (on "sim") is not showing.
      fx.resetRuns()
      const context = await browser.newContext({ viewport })
      await context.addInitScript(stub)
      const quiet = await open(context, '/home.html')
      await sleep(700)
      assert.deepEqual(await quiet.evaluate(() => [document.querySelector('.slide.active')?.dataset.id, document.getElementById('hhLive').hidden]), ['sim', true])
      assert.deepEqual([runs(), await loadedIn(quiet)], [[0, 0, 0], []], `${viewport.width}px, not live: the hidden stage runs nothing`)
      await quiet.close()

      // Live: the Live pane shows the stage, and its page runs; the Handout tab stops it.
      await context.addInitScript(() => { if (window === window.top) window.__live = true })
      const page = await open(context, '/home.html')
      await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
      const live = await liveFrame(page)
      await live.frame.waitForFunction(() => window.storage)
      assert.deepEqual([runs(), await loadedIn(page), live.visible], [[1, 0, 0], ['stage:sim'], true], `${viewport.width}px, live: the page on the speaker's slide runs`)
      await page.click('#hhTabHandout')
      await stageIdle(page, 'sim')
      await page.click('#hhTabLive')
      const again = await liveFrame(page)
      await again.frame.waitForFunction(() => window.storage)
      assert.deepEqual([runs(), await loadedIn(page)], [[2, 0, 0], ['stage:sim']], 'back on Live: it starts again')
      await context.close()
    }
  })
} finally {
  await browser.close()
  await fx.close()
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('embed-sandbox-dom passed')
