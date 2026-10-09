// 0.38 ticket 11.2, after the security review — the deck takes peer traffic only from the window it
// established as its peer itself. A real chain of windows, served from http://127.0.0.1:
// a plain deck opens its presenter (the Presenter button), the presenter opens its projector
// (F5), so every `opener` is what it is in the app.
//
//   1. the windows pair: the projector follows the presenter;
//   2. a hostile page live in the PROJECTOR reaches the presenter as `top.opener` and posts to it,
//      and to every other window it can name, what the deck's own windows post to each other
//      (state with a forged slide and a huge sequence number, every command, with the session's
//      real message names), before and after a real key press in the presenter, and from a frame
//      inside itself: the presenter's slide and state do not change, the page never becomes "the
//      peer" (it is sent nothing), and the real projector still follows;
//   3. the mirror case: the same page live in the PRESENTER's Current pane has no reference to the
//      projector at all, and what it posts to the windows it can name changes nothing;
//   4. a refresh of the projector, and of the presenter, leaves the two following each other;
//   5. a projector opened late pairs; the plain deck that opened the presenter is not a peer.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { serveEmbedFixture, embedFrames } from './fixtures/embed-deck-fixture.mjs'

const fx = await serveEmbedFixture()
const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const activeId = (page) => page.evaluate(() => document.querySelector('.slide.active')?.dataset.id ?? null)
const follows = (page, id) => page.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want, id, { timeout: 5000 })

/** plain deck → presenter → projector, each opened by the one before, as a person does it. */
async function chain({ broadcastChannel = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  // Without a BroadcastChannel the two windows have only postMessage for commands (state also
  // travels in localStorage): that is the path this file is about.
  if (!broadcastChannel) await context.addInitScript(() => { if (window === window.top) delete window.BroadcastChannel })
  // The chromeless launch asks a local server that is not there: make the presenter fall back to
  // its own window.open, which is what the app (file://) always does. And note what would print.
  await context.addInitScript(() => {
    if (window !== window.top) return
    navigator.sendBeacon = () => false
    window.print = () => { window.__printed = (window.__printed || 0) + 1 }
  })
  const plain = await context.newPage()
  plain.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  await plain.goto(`${fx.origin}/deck.html`, { waitUntil: 'load' })
  const [presenter] = await Promise.all([context.waitForEvent('page'), plain.click('#presenterBtn')])
  await presenter.waitForLoadState('load')
  await presenter.waitForSelector('#currentPreview')
  presenter.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  const openProjector = async () => {
    const [projector] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
    await projector.waitForLoadState('load')
    return projector
  }
  const types = await presenter.evaluate(() => {
    const session = new URL(location.href).searchParams.get('session')
    const base = `html-presentations:${document.body.dataset.deckId || location.pathname}:${session}`
    return { message: `${base}:state`, command: `${base}:command`, audienceName: `html-audience-${session}` }
  })
  return { context, plain, presenter, openProjector, types }
}
async function liveHostile(page, pane = false) {
  for (let tries = 0; tries < 80; tries += 1) {
    const found = (await embedFrames(page)).find((entry) => entry.live && entry.pane === pane && entry.url.startsWith('about:srcdoc'))
    if (found) { await found.frame.waitForFunction(() => window.results && window.results.stillHere !== undefined && typeof window.peerAttack === 'function'); return found.frame }
    await sleep(50)
  }
  throw new Error('no live hostile page')
}
/** What a forged message would change in a deck window, if it were accepted. */
const deckState = (page) => page.evaluate(() => ({
  slide: document.querySelector('.slide.active')?.dataset.id ?? null,
  path: location.pathname,
  printed: window.__printed || 0,
  forgedInstant: document.body.textContent.includes('FORGED-INSTANT'),
  highlights: document.querySelectorAll('mark.tw-highlight, .tw-highlight').length
}))
const press = async (presenter, key, projector, id) => { await presenter.keyboard.press(key); await follows(projector, id); await follows(presenter, id) }

try {
  await check('a page in the projector posts to the presenter through top.opener: nothing moves, it never becomes the peer', async () => {
    const { context, plain, presenter, openProjector, types } = await chain()
    const projector = await openProjector()
    await follows(projector, 'start')
    assert.equal(await projector.evaluate(() => window.opener !== null), true, 'the projector was opened by the presenter')
    await press(presenter, 'ArrowRight', projector, 'sim')
    await press(presenter, 'ArrowRight', projector, 'attack')

    const hostile = await liveHostile(projector)
    const before = await deckState(presenter)
    // It can name the presenter, and its frames.
    const first = await hostile.evaluate((t) => window.peerAttack(t), types)
    assert.ok(first.targets.includes('top.opener'), `the page reaches the presenter as top.opener: ${first.targets.join(', ')}`)
    assert.ok(first.sent >= 22, `it posted to every window it can name (${first.sent} messages)`)
    assert.notEqual(first.openerNavigate, 'assigned', 'it cannot send the presenter window elsewhere')
    assert.equal(first.namedWindow, 'blocked', 'nor open or find a window by the projector\'s name')
    // And a frame inside it does the same.
    await hostile.evaluate((t) => window.peerAttackInner(t), types)
    await hostile.waitForFunction(() => window.innerResult)
    assert.ok((await hostile.evaluate(() => window.innerResult.targets)).includes('top.opener'), 'a frame inside the page reaches the presenter too')
    await sleep(500)
    assert.deepEqual(await deckState(presenter), before, 'the presenter is as it was: same slide, nothing printed, no instant slide')
    assert.equal(before.slide, 'attack')
    assert.deepEqual(await deckState(projector), { ...before }, 'and so is the projector')
    assert.equal((await deckState(plain)).slide, 'start', 'and the plain deck that opened the presenter')

    // A real key press in the presenter that publishes state without leaving the slide, then again.
    // If the page had become the presenter's peer, this publish would have been sent to it.
    await presenter.keyboard.press('+')
    await presenter.keyboard.press('-')
    await sleep(300)
    await hostile.evaluate((t) => { window.peerAttack(t); window.peerAttackInner(t) }, types)
    await sleep(500)
    assert.deepEqual(await deckState(presenter), before, 'after a real press in the presenter: still as it was')
    assert.deepEqual(await hostile.evaluate(() => window.received), [], 'the page was sent none of the deck\'s traffic: it is not the peer')
    assert.equal(await hostile.evaluate(() => document.querySelector('iframe[name="inner"]') !== null), true)
    assert.deepEqual(fx.hijacked(), [])

    // Not even a window of the deck's OWN origin is the peer unless the deck made it so: the plain
    // deck that opened the presenter finds it by its window name and posts the same forged state.
    // (Over http this is the case the origin cannot decide; opened from file:// no origin can.)
    const posted = await plain.evaluate(({ t, name }) => {
      const target = window.open('', name)
      if (!target || target === window) return 'no window'
      target.postMessage({ type: t.message, state: { index: 0, beat: 0, reveal: 0, fontSize: 100, lightbox: { open: false, index: 0 }, talkQr: { open: false, url: '', svg: '' }, mode: { kind: null, step: 0 }, seq: 999999999, updatedAt: Date.now() * 2 } }, '*')
      target.postMessage({ type: t.command, command: 'print' }, '*')
      return target.location.pathname
    }, { t: types, name: types.audienceName.replace('html-audience-', 'html-presenter-') })
    assert.equal(posted, '/deck.html', 'the plain deck did reach the presenter window, same origin')
    await sleep(500)
    assert.deepEqual(await deckState(presenter), before, 'a same-origin window that is not the peer moves nothing either')

    // The real projector still follows the presenter, both ways it can be driven.
    await press(presenter, 'ArrowRight', projector, 'both')
    await press(presenter, 'ArrowLeft', projector, 'attack')
    await press(presenter, 'ArrowLeft', projector, 'sim')
    await context.close()
  })

  await check('the same page in the presenter\'s Current pane has no way to the projector', async () => {
    const { context, plain, presenter, openProjector, types } = await chain()
    const projector = await openProjector()
    await press(presenter, 'ArrowRight', projector, 'sim')
    await press(presenter, 'ArrowRight', projector, 'attack')
    const pane = await liveHostile(presenter, true)
    const before = await deckState(projector)
    const result = await pane.evaluate((t) => window.peerAttack(t), types)
    await pane.evaluate((t) => window.peerAttackInner(t), types)
    await pane.waitForFunction(() => window.innerResult)
    // What it can name: the presenter (its parent), the plain deck that opened the presenter, and
    // frames of those. The projector is not among them: the presenter holds that reference, and
    // nothing of the presenter can be read.
    assert.deepEqual(result.targets.filter((name) => !/^(parent|top|top\.opener|top\.opener\.top)(\[\d+\])?$/.test(name)), [], `nothing else: ${result.targets.join(', ')}`)
    assert.equal(result.namedWindow, 'blocked', 'it cannot open or find the projector by its window name')
    assert.notEqual(result.openerNavigate, 'assigned')
    await sleep(500)
    assert.deepEqual(await deckState(projector), before, 'the projector is as it was')
    assert.deepEqual(await deckState(presenter), { ...before }, 'and the presenter')
    assert.equal((await deckState(plain)).slide, 'start', 'and the plain deck (it is in no session)')
    assert.deepEqual(await pane.evaluate(() => window.received), [])
    await press(presenter, 'ArrowRight', projector, 'both')
    await context.close()
  })

  await check('refreshing either window, and opening the projector late, leaves the pair following each other', async () => {
    const { context, presenter, openProjector, types } = await chain()
    // No projector yet: the presenter works alone.
    await presenter.keyboard.press('ArrowRight')
    await follows(presenter, 'sim')
    // Opened late: it starts on the presenter's slide and follows.
    let projector = await openProjector()
    await follows(projector, 'sim')
    await press(presenter, 'ArrowRight', projector, 'attack')
    // The projector is refreshed: its opener is still the presenter.
    await projector.reload({ waitUntil: 'load' })
    await follows(projector, 'attack')
    await press(presenter, 'ArrowRight', projector, 'both')
    // The presenter is refreshed: it has no window reference until it opens the projector again;
    // the session's BroadcastChannel and stored state keep the two together.
    await presenter.reload({ waitUntil: 'load' })
    await presenter.waitForSelector('#currentPreview')
    await follows(presenter, 'both')
    await press(presenter, 'ArrowLeft', projector, 'attack')
    // In that state too a hostile projector page moves nothing.
    const hostile = await liveHostile(projector)
    await hostile.evaluate((t) => { window.peerAttack(t); window.peerAttackInner(t) }, types)
    await sleep(500)
    assert.equal(await activeId(presenter), 'attack')
    assert.deepEqual(await hostile.evaluate(() => window.received), [])
    // Pressing F5 again re-uses the named window and pairs with it again.
    const pages = context.pages().length
    await presenter.keyboard.press('F5')
    await sleep(800)
    assert.equal(context.pages().length, pages, 'the same projector window, not a second one')
    await follows(projector, 'attack')
    await press(presenter, 'ArrowRight', projector, 'both')
    await context.close()
  })
  await check('with no BroadcastChannel the pair talks by postMessage alone, both ways, and only to each other', async () => {
    const { context, presenter, openProjector, types } = await chain({ broadcastChannel: false })
    assert.equal(await presenter.evaluate(() => 'BroadcastChannel' in window), false)
    await presenter.keyboard.press('ArrowRight')
    await follows(presenter, 'sim')
    const paneOf = async () => { for (let i = 0; i < 80; i += 1) { const found = (await embedFrames(presenter)).find((entry) => entry.pane && entry.url.startsWith('about:srcdoc')); if (found) return found.frame; await sleep(50) } throw new Error('no pane') }
    const pane = await paneOf()
    await pane.waitForFunction(() => typeof window.clicks === 'number')
    await presenter.click('#currentPreview .live-sim-cover')
    await pane.evaluate(() => window.scrollTo(0, 1800))
    await sleep(300)
    // The projector opens late. Its page tells the presenter it is ready (projector → presenter,
    // a command by postMessage to its opener); the presenter answers with the scroll position
    // (presenter → projector, to the window its own window.open returned).
    await presenter.mouse.click(3, 3) // back in the deck, so F5 is the deck's key
    const projector = await openProjector()
    await follows(projector, 'sim')
    let copy
    for (let i = 0; i < 80 && !copy; i += 1) { copy = (await embedFrames(projector)).find((entry) => entry.live && entry.url.startsWith('about:srcdoc')); if (!copy) await sleep(50) }
    await copy.frame.waitForFunction(() => document.scrollingElement && document.scrollingElement.scrollTop > 0, null, { timeout: 5000 })
    // And a click in the presenter's copy is mirrored.
    await presenter.click('#currentPreview .live-sim-cover')
    await pane.click('#inc')
    await copy.frame.waitForFunction(() => window.clicks === 1, null, { timeout: 5000 })
    // The hostile page in the projector, on this path alone.
    await presenter.mouse.click(3, 3)
    await press(presenter, 'ArrowRight', projector, 'attack')
    const hostile = await liveHostile(projector)
    await hostile.evaluate((t) => { window.peerAttack(t); window.peerAttackInner(t) }, types)
    await sleep(600)
    assert.equal(await activeId(presenter), 'attack', 'forged state and commands from the projector\'s page moved nothing')
    assert.equal((await deckState(presenter)).printed, 0)
    assert.deepEqual(await hostile.evaluate(() => window.received), [])
    await press(presenter, 'ArrowRight', projector, 'both')
    await context.close()
  })
} finally {
  await browser.close()
  await fx.close()
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('embed-peer-dom passed')
