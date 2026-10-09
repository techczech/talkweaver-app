// 0.38 ticket 11.2 — mirroring an embedded local page from the presenter's Current pane to the
// projector through the embed channel, and the keys pressed inside a page (design test matrix rows
// 9, 11, 12). The compiled fixture talk, served from http://127.0.0.1, in a real presenter and
// projector pair in one browser context (scripts/fixtures/embed-deck-fixture.mjs).
//
//   1. a click, typing, a <select> change, a key in a non-text target and scrolling in the
//      presenter's copy appear in the projector's copy; a password does not (row 9);
//   2. going back to the slide restarts the page on both screens;
//   3. a projector opened late starts from the page's beginning and is sent the last scroll;
//   4. keys: once the presenter has clicked on the Current pane (or pressed E in the projector or
//      the plain deck), ArrowRight inside the page advances the deck and Escape hands the keyboard
//      back; Space typed in a text field does neither; Home and End never move the deck (row 11);
//   5. a `key` message a page posts by itself moves nothing: with no press anywhere, and also when
//      the page focuses itself straight after the presenter's own key press brought the deck to
//      its slide (the security review's reproduction) (row 11);
//   6. a hostile page that floods and names another embed: the other embed's copy is untouched, at
//      most the limit reaches the projector, the deck's slide does not change (row 12).
//   7. the focus rule (an embedded page's frame the deck has not engaged never holds the deck's
//      focus): after stepping on from inside an engaged page the focus is the deck's at once, and a
//      page that then focuses itself does not take the keyboard (the defect of 2026-10-07, presenter
//      only); a page with an autofocus field; a page that focuses itself four times a second; and a deck
//      text field keeps what is typed into it while such a page is live; and a page that takes the
//      focus while the deck document does not hold it loses it within the rule's interval;
//   8. two pages on one slide: while one is in use the other is suspended (unloaded), in the deck
//      and on a share page, and runs again afterwards; the audience window is not affected by the
//      presenter's choice; a field the person left on purpose is not given the focus back; and a
//      lone page that keeps focusing itself is given no key in any state tried.
//   9. scrolling by the person: a REAL wheel gesture over the page scrolls it in the presenter's
//      pane once the cover is clicked (and the audience copy follows), in the plain deck and on a
//      share page while Interact is on, and nowhere before the page is chosen.
// A SCRIPTED SCROLL PASSES ON A FRAME A PERSON CANNOT SCROLL: `scrollTo` and in-page anchors work
// in a frame with scrolling="no", the wheel does not. The mirroring cases above scroll by script and
// passed while the presenter could not scroll the page at all; scrolling is checked with
// `page.mouse.wheel` here.
//  10. the focus budget: a page that keeps taking the keyboard (loops at 40, 10, 1 and 0 ms, and a
//      requestAnimationFrame loop) is unloaded to its placeholder while the person types, and every
//      typed character lands in the deck's field; a page that focuses itself once is left alone;
//  11. touch: a tap or a drag outside the page in use ends it (share page and plain deck);
//  12. the keyboard's way in: Tab to the Current pane's cover or the Interact chip, then Enter or
//      Space, engages the page and does not step the talk.
//  13. the budget is the SLIDE's: a page that puts the focus on its neighbour gets both stopped, and
//      the person can run one of them again; in the presenter a stopped page stays stopped when
//      the Current pane is rebuilt, and the next slide starts clean; the fast loops again, before
//      and after they are stopped; the keyboard-origin record of a button; the Pointer tool.
//  14. the person's own presses are never counted as a page's grabs (cover and deck clicked in quick
//      succession); and in the presenter every frame is under the rule unless the person pressed in
//      it: a page in the AUDIENCE window that puts the focus on the presenter's frames (through
//      top.opener) takes nothing, a remote site outside Interact keeps nothing, a video the person
//      clicked keeps the keyboard, and text is still selected in the Current preview for a highlight.
//  15. a press inside a frame allows ONE arrival of the focus there: after a click in the Current
//      preview and then a click on the deck, a page that puts the focus back on the preview gets
//      nothing (K opens the composer, the typing lands in it); without the click on the deck the
//      preview keeps the keyboard. And a video that a page focused once (taken back) still takes
//      the keyboard when the person then clicks it, and gives it up when they click the deck.
//  16. a second press inside the preview that already has the keyboard leaves nothing behind: when
//      a script then moves the focus to the composer and puts it back on the preview, the preview
//      is refused and the typing lands in the composer (ten rounds).
// The looping page of the main fixture deck (slides `loop`, `two`) focuses itself every
// EMBED_FIXTURE_LOOP_MS, under the budget: it runs for as long as its slide is shown.
// WHO HAS THE KEYBOARD is asserted by behaviour: which page or field received the characters, and
// whether a real stepping key moved the deck. What the deck REPORTS (`document.activeElement`,
// `document.hasFocus()`) is recorded beside it as supplementary evidence only: with two frames it
// can name one frame while the other receives every key.
// Input is real (Playwright mouse and keyboard). "No press" cases are driven by the page itself:
// a script run from the test counts as a user gesture.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { serveEmbedFixture, embedFrames, EMBED_FIXTURE_LOOP_MS, EMBED_FIXTURE_VIDEO_HOST, EMBED_FIXTURE_REMOTE_URL } from './fixtures/embed-deck-fixture.mjs'
import { embedLimits } from '../compiler/assets/runtime/embed-protocol.js'

const L = embedLimits()
const fx = await serveEmbedFixture({ focusPages: true })
const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const activeId = (page) => page.evaluate(() => document.querySelector('.slide.active')?.dataset.id ?? null)

async function open(context, path, warnings = null) {
  const page = await context.newPage()
  page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error (${path}): ${error.message}`) })
  if (warnings) page.on('console', (message) => { if (message.type() === 'warning' && message.text().includes('too many messages')) warnings.push(message.text()) })
  await page.goto(`${fx.origin}${path}`, { waitUntil: 'load' })
  return page
}
async function goTo(driver, id, page = driver, key = 'ArrowRight') {
  for (let presses = 0; presses < 12 && await activeId(page) !== id; presses += 1) {
    const before = await activeId(page)
    await driver.keyboard.press(key)
    await page.waitForFunction((was) => document.querySelector('.slide.active')?.dataset.id !== was, before, { timeout: 5000 }).catch(() => {})
  }
  assert.equal(await activeId(page), id, `reached slide ${id}`)
}
/** The live frames of a window, once each holds its page: the presenter's pane copy, or the slide's own. */
async function live(page, count = 1) {
  for (let tries = 0; tries < 80; tries += 1) {
    const found = (await embedFrames(page)).filter((entry) => entry.live && entry.url.startsWith('about:srcdoc'))
    if (found.length >= count) {
      for (const entry of found) await entry.frame.waitForFunction(() => document.readyState === 'complete' && typeof window.clicks === 'number')
      return found
    }
    await sleep(50)
  }
  throw new Error(`fewer than ${count} live embedded frame(s)`)
}
async function pair(warnings = null) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  const session = `embed-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const projector = await open(context, `/deck.html?audience=1&session=${session}`, warnings)
  const presenter = await open(context, `/deck.html?presenter=1&session=${session}`, warnings)
  await presenter.waitForSelector('#currentPreview')
  return { context, presenter, projector, session }
}
/** The presenter chooses to use the page in the Current pane: a real click on its cover, in the deck's own document. */
const usePane = (presenter) => presenter.click('#currentPreview .live-sim-cover')
const paneCover = (presenter) => presenter.evaluate(() => {
  const pane = document.getElementById('currentPreview')
  const cover = pane.querySelector('.live-sim-cover')
  // Ticket 13: the pane shows the slide around the page, so the page (its frame) is a part of the
  // pane, not all of it, and the pane's first frame is the slide's picture. The press is tried at
  // the middle of the page.
  const frame = pane.querySelector('iframe.live-sim-frame')
  const box = frame.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return { shown: Boolean(cover) && getComputedStyle(cover).display !== 'none', takesThePress: hit === cover, engaged: pane.classList.contains('embed-engaged'), tabStop: frame.tabIndex }
})
/**
 * What the deck window REPORTS about the focus. Supplementary evidence only (see the header): every
 * use is beside a behavioural assertion (step(), typed text, a page's own record of its keys).
 */
const focusState = (page) => page.evaluate(() => {
  const el = document.activeElement
  return { onEmbedFrame: Boolean(el && el.tagName === 'IFRAME'), deckHasFocus: document.hasFocus() }
})
const DECK_HAS_THE_KEYBOARD = { onEmbedFrame: false, deckHasFocus: true }
/** One real key press that must move `page` (and `follower`) to slide `id`. */
async function step(page, key, id, follower = page) {
  await page.keyboard.press(key)
  await follower.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want, id, { timeout: 5000 })
    .catch(() => { throw new Error(`a real ${JSON.stringify(key)} did not reach the deck: expected slide ${id}`) })
  assert.equal(await activeId(page), id)
}
/** The keys a page has been given, by its own record. */
const keysOf = (frame) => frame.evaluate(() => window.keys.slice())
/** The state of each local-page figure on the slide being shown: "live" or "idle" (its placeholder). */
const embedStates = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.slide.active figure.slide-embed[data-embed="local"]')).map((figure) => figure.getAttribute('data-embed-state')))
/** The live page with this title on `page`, once it has loaded. */
async function livePage(page, title, count = 1) {
  const found = await live(page, count)
  for (const entry of found) if (await entry.frame.evaluate(() => document.title) === title) return entry
  throw new Error(`no live page titled ${title}`)
}
/** Shift pressed `times` times at uneven gaps: a key that does nothing in the deck, and that a page would record. */
async function pressShift(page, times) {
  for (let i = 0; i < times; i += 1) { await page.keyboard.press('Shift'); await sleep(7 + (i * 13) % 41) }
}
const scrollTopOf = (frame) => frame.evaluate(() => document.scrollingElement.scrollTop)
/** A real wheel gesture with the pointer over the middle of the element `selector` of `page`. */
async function wheelOver(page, selector, deltaY = 400) {
  const box = await page.locator(selector).first().boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, deltaY)
  await sleep(400)
}
const scrollingAttribute = (page, selector) => page.evaluate((query) => document.querySelector(query).getAttribute('scrolling'), selector)
assert.equal(EMBED_FIXTURE_LOOP_MS, 250, 'the counts of grabs below assume four a second')
const STOPPED_LINE = 'Stopped: a page on this slide kept taking the keyboard'
/** What a deck shortcut would change: the slide, the modes (classes on the body, the presenter root and the slide). */
const deckLook = (page) => page.evaluate(() => ({
  slide: document.querySelector('.slide.active')?.dataset.id ?? null,
  body: Array.from(document.body.classList).filter((name) => name !== 'chrome-idle').sort().join(' '),
  root: document.querySelector('.presenter-root')?.className ?? null,
  slideClass: document.querySelector('.slide.active')?.className ?? null,
  outlineOpen: Boolean(document.getElementById('presenterSearch')?.getClientRects().length) && document.activeElement?.id === 'presenterSearch'
}))
/** Tab until the element matching `selector` has the keyboard focus; the number of Tab presses. */
async function tabTo(page, selector, limit = 25) {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((query) => Boolean(document.activeElement && document.activeElement.matches(query)), selector)) return presses
  }
  throw new Error(`Tab did not reach ${selector} in ${limit} presses`)
}
/** For each local-page figure of the slide shown: is it marked stopped? */
const stoppedFlags = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.slide.active figure.slide-embed[data-embed="local"]')).map((figure) => figure.hasAttribute('data-embed-stopped')))
/** The presenter's Current pane, as far as a stopped page is concerned. */
const paneState = (page) => page.evaluate(() => {
  const pane = document.getElementById('currentPreview')
  const frame = pane.querySelector('iframe.live-sim-frame[data-embed-local]')
  return { stopped: pane.classList.contains('embed-stopped'), engaged: pane.classList.contains('embed-engaged'), loaded: Boolean(frame && frame.hasAttribute('srcdoc')), frameShown: Boolean(frame) && getComputedStyle(frame).visibility !== 'hidden', label: pane.querySelector('.live-sim-cover-label')?.textContent ?? null, note: pane.querySelector('.live-sim-cover-note')?.textContent ?? null }
})
const PANE_STOPPED = { stopped: true, engaged: false, loaded: false, frameShown: false, label: 'Click to run again', note: STOPPED_LINE }
const PANE_RUNNING = { stopped: false, engaged: false, loaded: true, frameShown: true, label: 'Click to interact', note: null }
const waitPaneStopped = (page, timeout = 4000) => page.waitForFunction(() => document.getElementById('currentPreview')?.classList.contains('embed-stopped'), null, { timeout })
const pointerOn = (page) => page.evaluate(() => document.getElementById('presenterPointer').getAttribute('aria-pressed') === 'true')
const SIM_TITLE = 'Counter & anchors: a page with a title that is rather longer than eighty characters in all, so it is cut'
const fraction = (frame) => frame.evaluate(() => document.scrollingElement.scrollTop / (document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight))

try {
  await check('click, type, select, key and scroll in the presenter\'s copy appear in the projector\'s copy; a password does not', async () => {
    fx.resetRuns()
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    const [copy] = await live(projector)
    assert.equal(pane.pane, true, 'the presenter\'s live copy is the Current pane\'s')
    assert.deepEqual(await paneCover(presenter), { shown: true, takesThePress: true, engaged: false, tabStop: -1 }, 'until the presenter chooses the page, a press on the pane lands on the deck\'s own cover')
    await usePane(presenter)
    assert.deepEqual(await paneCover(presenter), { shown: false, takesThePress: false, engaged: true, tabStop: -1 }, 'one click on the cover and the page takes the pointer')
    await presenter.click('#presenterPointer')
    assert.equal((await paneCover(presenter)).engaged, false, 'Pointer exits an engaged page and restores its cover')
    const box = await presenter.locator('#currentPreview iframe.live-sim-frame').boundingBox()
    await presenter.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await projector.waitForFunction(() => getComputedStyle(document.querySelector('.tw-pointer-ring')).display !== 'none')
    await presenter.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    assert.equal(await pane.frame.evaluate(() => window.clicks),0,'Pointer takes presses instead of delivering them to the page')
    await presenter.click('#presenterPointer')
    assert.deepEqual(await paneCover(presenter), { shown: true, takesThePress: true, engaged: false, tabStop: -1 }, 'Pointer off restores Click to interact')
    await usePane(presenter)
    assert.equal(fx.ran('sim'), 2, 'one run in each window')
    // The two copies are different sizes: positions travel as fractions.
    assert.notDeepEqual(await pane.frame.evaluate(() => [innerWidth, innerHeight]), await copy.frame.evaluate(() => [innerWidth, innerHeight]))

    await pane.frame.click('#inc')
    await pane.frame.click('#inc')
    await copy.frame.waitForFunction(() => window.clicks === 2)

    await pane.frame.click('#name')
    await presenter.keyboard.type('hello there')
    await copy.frame.waitForFunction(() => document.getElementById('name').value === 'hello there')

    await pane.frame.focus('#sel')
    await presenter.keyboard.type('b')
    await copy.frame.waitForFunction(() => document.getElementById('sel').value === 'b' && window.changes === 1)

    await pane.frame.click('#keybox')
    await presenter.keyboard.press('x')
    await copy.frame.waitForFunction(() => window.keys.includes('x'))

    await pane.frame.click('#pw')
    await presenter.keyboard.type('s3cret-word')
    await pane.frame.click('#keybox')
    await sleep(300)
    assert.equal(await pane.frame.evaluate(() => document.getElementById('pw').value), 's3cret-word')
    assert.equal(await copy.frame.evaluate(() => document.getElementById('pw').value), '', 'the password stays in the presenter\'s copy')

    await pane.frame.evaluate(() => { document.getElementById('panel').scrollTop = 450; })
    await copy.frame.waitForFunction(() => document.getElementById('panel').scrollTop === 450)
    await pane.frame.evaluate(() => window.scrollTo(0, 1500))
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop > 0)
    await sleep(300)
    const [at, mirrored] = [await fraction(pane.frame), await fraction(copy.frame)]
    assert.ok(at > 0.1 && Math.abs(at - mirrored) < 0.005, `both copies at the same fraction of their own height: ${at} and ${mirrored}`)
    // An in-page anchor in the presenter's copy: the projector's copy follows the click.
    await pane.frame.click('#top')
    await pane.frame.evaluate(() => window.scrollTo(0, 0))
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop === 0)
    await pane.frame.click('#jump')
    await copy.frame.waitForFunction(() => location.hash === '#far' && document.scrollingElement.scrollTop > 1000, null, { timeout: 5000 })

    // The projector's copy captured nothing of what was replayed into it: the presenter's state is its own.
    assert.equal(await pane.frame.evaluate(() => window.clicks), 2)
    assert.equal(await copy.frame.evaluate(() => window.clicks), 2, 'two clicks, replayed once each')

    // Going to the next slide and back restarts the page on both screens.
    await goTo(presenter, 'attack', projector)
    await goTo(presenter, 'sim', projector, 'ArrowLeft')
    const [paneAgain] = await live(presenter)
    const [copyAgain] = await live(projector)
    assert.deepEqual([await paneAgain.frame.evaluate(() => [window.clicks, document.getElementById('name').value, document.scrollingElement.scrollTop]),
      await copyAgain.frame.evaluate(() => [window.clicks, document.getElementById('name').value, document.scrollingElement.scrollTop])], [[0, '', 0], [0, '', 0]], 'both copies start again')
    assert.equal(fx.ran('sim'), 4)
    // And the new pair mirrors: the new activation has its own token on each side.
    assert.equal((await paneCover(presenter)).shown, true, 'coming back, the page has to be chosen again')
    await usePane(presenter)
    await paneAgain.frame.click('#inc')
    await copyAgain.frame.waitForFunction(() => window.clicks === 1)
    await context.close()
  })

  await check('a projector opened late starts from the page\'s beginning and is sent the last scroll position', async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const session = `embed-late-${Date.now()}`
    const presenter = await open(context, `/deck.html?presenter=1&session=${session}`)
    await presenter.waitForSelector('#currentPreview')
    await goTo(presenter, 'sim')
    const [pane] = await live(presenter)
    await usePane(presenter)
    await pane.frame.click('#inc')
    await pane.frame.evaluate(() => window.scrollTo(0, 1800))
    await sleep(400)
    const at = await fraction(pane.frame)
    assert.ok(at > 0.2)

    const projector = await open(context, `/deck.html?audience=1&session=${session}`)
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'sim', null, { timeout: 5000 })
    const [copy] = await live(projector)
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop > 0, null, { timeout: 5000 })
    await sleep(200)
    assert.ok(Math.abs(await fraction(copy.frame) - at) < 0.005, 'the late copy is at the presenter\'s scroll position')
    assert.equal(await copy.frame.evaluate(() => window.clicks), 0, 'earlier clicks are not replayed')
    // From here on it follows.
    await pane.frame.click('#top', { force: true }).catch(() => {})
    await pane.frame.evaluate(() => window.scrollTo(0, 0))
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop === 0)
    await context.close()
  })

  await check('keys pressed inside a live page drive the deck; Escape hands the keyboard back; a text field keeps its keys', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    // The presenter clicks on the pane (its cover, in the deck's own document), then into the page:
    // the deck's focus is on the pane's frame, and the deck knows the person chose the page.
    await usePane(presenter)
    await pane.frame.click('#name')
    assert.equal(await presenter.evaluate(() => document.activeElement === document.querySelector('#currentPreview iframe.live-sim-frame')), true)
    // Typing: Space and the arrows belong to the text field.
    await presenter.keyboard.type('a b')
    await presenter.keyboard.press('ArrowLeft')
    await presenter.keyboard.press('Home')
    await sleep(300)
    assert.equal(await pane.frame.evaluate(() => document.getElementById('name').value), 'a b')
    assert.equal(await activeId(presenter), 'sim', 'Space and arrows typed in a text field do not move the deck')
    // Escape inside the page, outside a text field: the keyboard goes back to the deck.
    await pane.frame.click('#keybox')
    await presenter.keyboard.press('Escape')
    await presenter.waitForFunction(() => document.activeElement !== document.querySelector('#currentPreview iframe.live-sim-frame'), null, { timeout: 5000 })
    assert.equal(await activeId(presenter), 'sim')
    assert.deepEqual(await paneCover(presenter), { shown: true, takesThePress: true, engaged: false, tabStop: -1 }, 'Escape gives the pane back to the deck')
    // With the keyboard back in the deck, its own keys work directly: forward one step and back.
    await presenter.keyboard.press('ArrowRight')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'attack', null, { timeout: 5000 })
    await presenter.keyboard.press('ArrowLeft')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'sim', null, { timeout: 5000 })
    const [paneBack] = await live(presenter)
    // Home and End pressed inside the page are the page's own keys: the deck does not jump.
    await usePane(presenter)
    await paneBack.frame.click('#keybox')
    await presenter.keyboard.press('End')
    await presenter.keyboard.press('Home')
    await sleep(300)
    assert.equal(await activeId(presenter), 'sim', 'End and Home inside a page never move the deck')
    assert.deepEqual(await paneBack.frame.evaluate(() => window.keys.slice(-2)), ['End', 'Home'], 'the page received them as its own')
    // A click elsewhere in the presenter window ends the page's turn; clicking the pane again restores it.
    await presenter.mouse.click(3, 3)
    assert.equal((await paneCover(presenter)).shown, true, 'a press elsewhere in the presenter gives the pane back to the deck')
    await usePane(presenter)
    // In the page, outside a text field: ArrowRight advances the deck, on both screens, one step.
    await paneBack.frame.click('#keybox')
    await presenter.keyboard.press('ArrowRight')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'attack', null, { timeout: 5000 })
    assert.equal(await activeId(presenter), 'attack')

    // The projector window itself (Interact with E, since its page takes no pointer otherwise).
    await goTo(presenter, 'sim', projector, 'ArrowLeft')
    const [copy] = await live(projector)
    await projector.bringToFront()
    await projector.keyboard.press('e')
    await copy.frame.click('#keybox')
    await projector.keyboard.press('Escape')
    await projector.waitForFunction(() => !document.body.classList.contains('embed-interacting'), null, { timeout: 5000 })
    assert.equal(await activeId(projector), 'sim', 'Escape in the projector\'s page leaves Interact and moves nothing')
    await context.close()

    // The plain deck window: PageDown inside the page advances it.
    const solo = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const deck = await open(solo, '/deck.html')
    await goTo(deck, 'sim')
    const [own] = await live(deck)
    await deck.keyboard.press('e')
    await own.frame.click('#keybox')
    await deck.keyboard.press('PageDown')
    await deck.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'attack', null, { timeout: 5000 })
    await solo.close()
  })

  await check('a key message a page posts by itself, with no press anywhere, moves nothing', async () => {
    // The deck opens straight on the two-embed slide. Its first embed asks for ArrowRight three times
    // the moment it has its token. Nothing touches the window from outside until that is over.
    for (const path of ['/deck.html#both', '/handout.html#both']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, path)
      await sleep(1500)
      assert.equal(await activeId(page), 'both', `${path}: still on the slide`)
      const flood = (await embedFrames(page)).filter((entry) => entry.live)[0]
      assert.deepEqual(await flood.frame.evaluate(() => [typeof window.stolen, window.keysSent]), ['string', 3], `${path}: the page did focus itself and send its key messages, with its own token`)
      await context.close()
    }
  })

  await check('a hostile page that floods and names another embed: the other copy is untouched, the limit holds, the deck stays', async () => {
    fx.resetRuns()
    const warnings = []
    const { context, presenter, projector } = await pair(warnings)
    await goTo(presenter, 'both', projector)
    // Presenter: the pane shows the slide's FIRST embed, the flooding page (role capture).
    // Projector: both embeds of the slide are live (role replay): the flooding page's copy and the ordinary page.
    const [pane] = await live(presenter)
    const copies = await live(projector, 2)
    const floodCopy = copies.find((entry) => entry.frame !== null && entry.slide === 'both' && copies.indexOf(entry) === 0)
    const other = copies[1]
    assert.equal(await pane.frame.evaluate(() => document.title), 'Flood')
    assert.deepEqual([await floodCopy.frame.evaluate(() => document.title), await other.frame.evaluate(() => document.querySelector('h1').textContent)], ['Flood', 'Sim'])
    // THE REVIEWER'S CASE. The presenter arrived here by a real key press, so the deck window has a
    // live user activation; the page put the focus on itself and asked for End, ArrowRight, Home,
    // PageDown and Space, three times. Nothing moved: the deck never saw a press aimed at the page.
    await pane.frame.waitForFunction(() => window.keysSent === 3)
    await sleep(300)
    assert.equal(await presenter.evaluate(() => navigator.userActivation.isActive), true, 'the deck window is active (the presenter\'s own key press)')
    assert.equal(await activeId(presenter), 'both', 'a page that focused itself after the presenter\'s arrival moves nothing')
    assert.equal(await activeId(projector), 'both')
    // Nor does it keep the keyboard: the deck took the focus back from a frame it had not engaged,
    // so the presenter's next key presses reach the deck.
    assert.equal(await presenter.evaluate(() => document.activeElement === document.querySelector('#currentPreview iframe.live-sim-frame')), false, 'the deck took the focus back')
    await presenter.keyboard.press('ArrowRight')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'end', null, { timeout: 5000 })
    await presenter.keyboard.press('ArrowLeft')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'both', null, { timeout: 5000 })
    const [paneNow] = await live(presenter)
    const copiesNow = await live(projector, 2)
    await paneNow.frame.waitForFunction(() => window.keysSent === 3)
    await sleep(300)
    assert.equal(await activeId(presenter), 'both')
    // The same in the projector window, whose copy also asked.
    assert.equal(await copiesNow[0].frame.evaluate(() => window.keysSent), 3)
    // The presenter now chooses the page.
    await usePane(presenter)

    // One ordinary mirrored click first: the channel works for this page.
    await paneNow.frame.click('#inc')
    await copiesNow[0].frame.waitForFunction(() => window.clicks === 1)

    // The attack, started by a real click on the page's own button: forged events naming the other
    // embed, wrong and missing tokens, then 10,000 valid events.
    await paneNow.frame.click('#go')
    await paneNow.frame.waitForFunction(() => window.attacked === true)
    await presenter.waitForTimeout(800)
    const reached = await copiesNow[0].frame.evaluate(() => window.clicks) - 1
    assert.ok(reached >= 60 && reached <= L.rateBurst + 40, `of 10,000 events at most the burst reached the projector's copy: ${reached}`)
    assert.deepEqual(await copiesNow[1].frame.evaluate(() => [window.clicks, document.getElementById('name').value, window.keys.length]), [0, '', 0], 'the other embed\'s copy is untouched')
    assert.equal(await activeId(presenter), 'both', 'the presenter\'s slide did not change')
    assert.equal(await activeId(projector), 'both', 'nor the projector\'s')
    assert.ok(warnings.length >= 1 && warnings.length <= 2, `one console warning per window that was flooded: ${warnings.length}`)

    // Mirroring from that frame is off until its slide is left: a real click is not copied.
    const before = await copiesNow[0].frame.evaluate(() => window.clicks)
    await paneNow.frame.click('#inc')
    await presenter.waitForTimeout(400)
    assert.equal(await copiesNow[0].frame.evaluate(() => window.clicks), before, 'after the cut-off nothing from that page is mirrored')

    // Leaving and coming back: a new activation, mirroring again.
    await goTo(presenter, 'end', projector)
    await goTo(presenter, 'both', projector, 'ArrowLeft')
    const [paneAgain] = await live(presenter)
    const [floodAgain] = await live(projector, 2)
    await paneAgain.frame.waitForFunction(() => window.keysSent === 3)
    await sleep(200)
    assert.equal(await activeId(presenter), 'both')
    await usePane(presenter)
    await paneAgain.frame.click('#inc')
    await floodAgain.frame.waitForFunction(() => window.clicks === 1, null, { timeout: 5000 })
    await context.close()
  })

  await check('presenter: stepping on from inside an engaged page, then arriving on a page that focuses itself, leaves the keyboard with the deck', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    // The exact sequence of the defect: the cover, a click in the page, ArrowRight inside it.
    await usePane(presenter)
    await pane.frame.click('#keybox')
    await presenter.keyboard.press('x')
    assert.deepEqual(await keysOf(pane.frame), ['x'], 'the engaged page has the keyboard: it was given the key')
    await step(presenter, 'ArrowRight', 'attack', projector)
    // The engaged frame was unloaded while it held the focus: the focus is the deck document's at
    // once. This is the deck's own report, and it is the state the defect turned on (hasFocus was
    // false here); the behaviour it protects is the steps that follow.
    assert.deepEqual(await focusState(presenter), DECK_HAS_THE_KEYBOARD, 'straight after the engaged page is unloaded the deck document has the focus')
    // On to the slide whose page focuses itself (at once, at 150 ms and at 600 ms).
    await step(presenter, 'ArrowRight', 'both', projector)
    const [flood] = await live(presenter)
    await flood.frame.waitForFunction(() => window.keysSent === 3)
    await sleep(300)
    assert.deepEqual(await focusState(presenter), DECK_HAS_THE_KEYBOARD, 'the page that focused itself is not reported as holding the focus (supplementary)')
    assert.deepEqual(await paneCover(presenter), { shown: true, takesThePress: true, engaged: false, tabStop: -1 }, 'and it is not engaged: the cover is shown')
    // Every stepping key the presenter presses now reaches the deck.
    await step(presenter, 'ArrowRight', 'end', projector)
    await step(presenter, 'ArrowLeft', 'both', projector)
    await sleep(900)
    await step(presenter, 'PageDown', 'end', projector)
    await step(presenter, 'ArrowLeft', 'both', projector)
    await sleep(900)
    await step(presenter, ' ', 'end', projector)
    await context.close()
  })

  // NOT a regression test for the defect: the projector and the plain deck already returned the focus
  // when Interact ended, and this case passed before the fix. It is kept so the rule stays uniform.
  await check('projector and plain deck: the same sequence with Interact (E)', async () => {
    for (const path of ['/deck.html?audience=1&session=embed-focus-solo', '/deck.html']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const deck = await open(context, path)
      await goTo(deck, 'sim')
      const [own] = await live(deck)
      await deck.keyboard.press('e')
      await own.frame.click('#keybox')
      await step(deck, 'ArrowRight', 'attack')
      assert.deepEqual(await focusState(deck), DECK_HAS_THE_KEYBOARD, `${path}: straight after the engaged page is unloaded the deck document has the focus`)
      await step(deck, 'ArrowRight', 'both')
      const [flood] = await live(deck, 2)
      await flood.frame.waitForFunction(() => window.keysSent === 3)
      await sleep(300)
      assert.deepEqual(await focusState(deck), DECK_HAS_THE_KEYBOARD, `${path}: the page that focused itself does not hold the focus`)
      await step(deck, 'ArrowRight', 'end')
      await step(deck, 'ArrowLeft', 'both')
      await step(deck, 'PageDown', 'end')
      await context.close()
    }
  })

  // NOT a regression test for the defect either: Chromium does not honour `autofocus` in a sandboxed
  // frame of another origin, so this case passed before the fix. It is kept as the record of that.
  await check('a page with an autofocus field: the deck keeps the keyboard on arrival; once the page is chosen, the field works', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'auto', projector)
    const [pane] = await live(presenter)
    await sleep(700)
    assert.deepEqual(await focusState(presenter), DECK_HAS_THE_KEYBOARD, 'presenter: the autofocus field did not take the keyboard')
    await step(presenter, 'ArrowRight', 'loop', projector)
    await step(presenter, 'ArrowLeft', 'auto', projector)
    assert.deepEqual(await pane.frame.isDetached(), true, 'the page was unloaded on leaving')
    const [paneBack] = await live(presenter)
    await sleep(300)
    await usePane(presenter)
    await paneBack.frame.click('#field')
    await presenter.keyboard.type('a b')
    await presenter.keyboard.press('ArrowLeft')
    await sleep(700)
    assert.equal(await paneBack.frame.evaluate(() => document.getElementById('field').value), 'a b', 'typing reaches the field after the cover is clicked')
    assert.equal(await activeId(presenter), 'auto', 'and Space and the arrows typed there are the field\'s')
    // The engaged page keeps the keyboard for longer than the rule's interval: more typing still lands.
    await presenter.keyboard.press('End')
    await presenter.keyboard.type('c')
    assert.equal(await paneBack.frame.evaluate(() => document.getElementById('field').value), 'a bc', 'the rule leaves an engaged page alone')
    await context.close()

    // The plain deck: the same, with E.
    const solo = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const deck = await open(solo, '/deck.html')
    await goTo(deck, 'auto')
    await live(deck)
    await sleep(700)
    assert.deepEqual(await focusState(deck), DECK_HAS_THE_KEYBOARD, 'plain deck: the autofocus field did not take the keyboard')
    await step(deck, 'ArrowRight', 'loop')
    await step(deck, 'ArrowLeft', 'auto')
    const [ownBack] = await live(deck)
    await deck.keyboard.press('e')
    await ownBack.frame.click('#field')
    await deck.keyboard.type('c d')
    await sleep(500)
    assert.equal(await ownBack.frame.evaluate(() => document.getElementById('field').value), 'c d')
    assert.equal(await activeId(deck), 'auto')
    await solo.close()
  })

  await check('a page that focuses itself four times a second: for two seconds and after, every real key reaches the deck and none reaches the page', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'auto', projector)
    const [auto] = await live(presenter)
    // Arrive by a key pressed inside an engaged page: the frame that held the focus is unloaded and
    // the looping page is loaded in the same step.
    await usePane(presenter)
    await auto.frame.click('#keybox')
    await step(presenter, 'ArrowRight', 'loop', projector)
    const [loop] = await live(presenter)
    await live(projector)
    const grabsAtStart = await loop.frame.evaluate(() => window.grabs)
    // Two seconds of the loop with a real key pressed about every 30 ms: the page is given none.
    // (The deck's own report is sampled beside it, as supplementary evidence.)
    const held = []
    for (const started = Date.now(); Date.now() - started < 2000;) { held.push((await focusState(presenter)).onEmbedFrame); await pressShift(presenter, 2) }
    assert.ok(await loop.frame.evaluate(() => window.grabs) - grabsAtStart >= 6, 'the page did keep focusing itself')
    assert.deepEqual(await keysOf(loop.frame), [], `of ${held.length * 2} real key presses over two seconds the looping page was given none`)
    assert.equal(held.filter(Boolean).length, 0, `and in ${held.length} samples it was never reported as holding the focus (supplementary)`)
    await step(presenter, 'ArrowRight', 'tail', projector)
    for (const key of ['PageDown', ' ', 'ArrowRight']) {
      await step(presenter, 'ArrowLeft', 'loop', projector)
      const [again] = await live(presenter)
      await sleep(400)
      assert.deepEqual(await again.frame.evaluate(() => window.keys), [], 'the looping page was given no key')
      await step(presenter, key, 'tail', projector)
    }
    await context.close()

    // The projector and the plain deck by themselves: the same page, the same keys.
    for (const path of ['/deck.html?audience=1&session=embed-loop-solo', '/deck.html']) {
      const solo = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const deck = await open(solo, path)
      await goTo(deck, 'loop')
      const [own] = await live(deck)
      await pressShift(deck, 25)
      assert.deepEqual(await keysOf(own.frame), [], `${path}: the looping page was given none of 25 real key presses`)
      await step(deck, 'ArrowRight', 'tail')
      await step(deck, 'ArrowLeft', 'loop')
      await step(deck, 'PageDown', 'tail')
      await solo.close()
    }
  })

  await check('a deck text field is not robbed: typing in the poll composer goes on while a page keeps focusing itself', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'loop', projector)
    const [loop] = await live(presenter)
    // K opens the presenter's quick-poll composer and puts the focus in its Question field.
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => document.activeElement && document.activeElement.id === 'quickPollQuestion')
    const grabsBefore = await loop.frame.evaluate(() => window.grabs)
    const text = 'Which of these, typed slowly?'
    await presenter.keyboard.type(text, { delay: 45 })
    assert.ok(await loop.frame.evaluate(() => window.grabs) - grabsBefore >= 4, 'the page kept focusing itself throughout')
    assert.deepEqual(await presenter.evaluate(() => [document.getElementById('quickPollQuestion').value, document.activeElement && document.activeElement.id]), [text, 'quickPollQuestion'], 'every character reached the deck\'s field, in order, and the field still has the focus')
    assert.deepEqual(await loop.frame.evaluate(() => window.keys), [], 'the page was given none of it')
    assert.equal(await activeId(presenter), 'loop', 'typing (with its spaces) did not move the deck')
    await context.close()
  })

  await check('a page that takes the focus while the deck document does not hold it (no event reaches the deck) still loses it', async () => {
    // When the focus is not in the deck document itself, the browser raises nothing in the deck as
    // a page takes it: no `blur` (the window has had one already), no `focusin`. In the app that is
    // a deck window behind another application; here a frame of the test's own stands in for it,
    // added to the presenter and clicked into with the real mouse. Only the rule's interval sees this.
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'end', projector)
    await presenter.evaluate(() => {
      const other = document.createElement('iframe')
      other.id = 'test-other-frame'
      other.srcdoc = '<button style="position:fixed;inset:0;width:100%;height:100%">elsewhere</button>'
      other.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:60px;z-index:2147483647;border:0'
      document.body.appendChild(other)
    })
    await presenter.frameLocator('#test-other-frame').locator('button').waitFor()
    // Arrive on the autofocus page, then on the looping page, with the deck's own keys.
    await step(presenter, 'ArrowRight', 'auto', projector)
    await step(presenter, 'ArrowRight', 'loop', projector)
    const [loop] = await live(presenter)
    await sleep(300)
    const grabsBefore = await loop.frame.evaluate(() => window.grabs)
    await presenter.mouse.click(30, 30)
    // Within a few intervals the looping page has taken the focus from that frame and lost it again.
    await sleep(900)
    assert.ok(await loop.frame.evaluate(() => window.grabs) - grabsBefore >= 3, 'the page kept focusing itself meanwhile')
    await step(presenter, 'ArrowRight', 'tail', projector)
    assert.deepEqual(await loop.frame.evaluate(() => window.keys).catch(() => []), [], 'the page was given no key')
    await context.close()
  })

  await check('two pages on one slide (plain deck): while one is in use the other is suspended; typing and the stepping key belong to the page in use', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const deck = await open(context, '/deck.html')
    await goTo(deck, 'two')
    await live(deck, 2)
    assert.deepEqual(await embedStates(deck), ['live', 'live'], 'before anything is chosen both pages run')
    // Runs are counted from here (the way to this slide passes other slides with the same pages).
    await sleep(300)
    fx.resetRuns()
    // The reader chooses the SECOND page (its chip); the first is the one that focuses itself four times a second.
    await deck.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1).click()
    assert.deepEqual(await embedStates(deck), ['idle', 'live'], 'the other page is unloaded to its placeholder at once')
    const sim = await livePage(deck, SIM_TITLE)
    assert.equal((await embedFrames(deck)).filter((entry) => entry.live).length, 1, 'one page is running')
    await sim.frame.click('#name')
    await sleep(300)
    await deck.keyboard.type('xyz', { delay: 60 })
    assert.equal(await sim.frame.evaluate(() => document.getElementById('name').value), 'xyz', 'the typed text is in the field of the page in use')
    // The stepping key pressed in the page in use moves the deck, once.
    await sim.frame.click('#keybox')
    await sleep(300)
    await step(deck, 'ArrowRight', 'after')
    await sleep(500)
    assert.equal(await activeId(deck), 'after', 'one step, not two')
    assert.equal(fx.ran('loop'), 0, 'the suspended page did not run again on the way out')

    // Back on the slide both run again; choose the page, then leave it with Escape: the other returns.
    await step(deck, 'ArrowLeft', 'two')
    await live(deck, 2)
    await sleep(300)
    assert.deepEqual([await embedStates(deck), fx.ran('loop'), fx.ran('sim')], [['live', 'live'], 1, 1])
    await deck.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1).click()
    assert.deepEqual(await embedStates(deck), ['idle', 'live'])
    const simAgain = await livePage(deck, SIM_TITLE)
    await simAgain.frame.click('#keybox')
    await deck.keyboard.press('Escape')
    await deck.waitForFunction(() => !document.body.classList.contains('embed-interacting'), null, { timeout: 5000 })
    const loopBack = await livePage(deck, 'Focus loop', 2)
    assert.deepEqual([await embedStates(deck), fx.ran('loop'), fx.ran('sim')], [['live', 'live'], 2, 1], 'the suspended page runs again, from its beginning; the page that was in use was not restarted')
    // And with nothing in use the keyboard is the deck's, whatever the looping page does.
    await pressShift(deck, 20)
    assert.deepEqual([await keysOf(loopBack.frame), (await keysOf(simAgain.frame)).filter((key) => key === 'Shift')], [[], []], 'neither page is given the deck\'s keys')
    await step(deck, 'ArrowRight', 'after')
    await context.close()
  })

  await check('two pages on one slide (presenter and audience): the presenter choosing a page suspends nothing in the audience window; E there suspends there only', async () => {
    fx.resetRuns()
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'two', projector)
    // Presenter: the pane shows the slide's first page (the looping one). Audience: both.
    const pane = await livePage(presenter, 'Focus loop')
    await live(projector, 2)
    assert.deepEqual(await embedStates(projector), ['live', 'live'])
    // Runs are counted from here (the way to this slide passes other slides with the same pages).
    await sleep(300)
    fx.resetRuns()
    const runs = [0, 0]
    await usePane(presenter)
    await pane.frame.click('#grab')
    await presenter.keyboard.press('x')
    await sleep(600)
    assert.deepEqual(await keysOf(pane.frame), ['x'], 'the presenter is using the page in the pane')
    assert.deepEqual([await embedStates(projector), fx.ran('loop'), fx.ran('sim')], [['live', 'live'], ...runs], 'the audience window still shows both pages, and neither was restarted')
    // Interact in the audience window itself (E takes the slide's first page): the other is suspended there.
    await projector.bringToFront()
    await projector.keyboard.press('e')
    assert.deepEqual(await embedStates(projector), ['live', 'idle'], 'E in the audience window suspends the other page there')
    assert.equal((await paneCover(presenter)).engaged, true, 'and changes nothing in the presenter')
    // Escape (the keyboard is in the page now) ends it: the suspended page runs again.
    await projector.keyboard.press('Escape')
    await projector.waitForFunction(() => !document.body.classList.contains('embed-interacting'), null, { timeout: 5000 })
    await live(projector, 2)
    await sleep(300)
    assert.deepEqual([await embedStates(projector), fx.ran('sim')], [['live', 'live'], runs[1] + 1], 'Escape there: the suspended page runs again')
    await context.close()
  })

  await check('two pages on one slide (share page): while one is in use the other is suspended; typing and the stepping key belong to the page in use', async () => {
    fx.resetRuns()
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await open(context, '/handout.html#two')
    await live(page, 2)
    assert.deepEqual([await activeId(page), await embedStates(page)], ['two', ['live', 'live']])
    await page.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1).click()
    assert.deepEqual(await embedStates(page), ['idle', 'live'], 'the other page is unloaded to its placeholder at once')
    const sim = await livePage(page, SIM_TITLE)
    await sim.frame.click('#name')
    await sleep(300)
    await page.keyboard.type('xyz', { delay: 60 })
    assert.equal(await sim.frame.evaluate(() => document.getElementById('name').value), 'xyz', 'the typed text is in the field of the page in use')
    // Escape (outside a text field) leaves the page: the other runs again, and the keys are the share page's.
    await sim.frame.click('#keybox')
    await page.keyboard.press('Escape')
    const loopBack = await livePage(page, 'Focus loop', 2)
    assert.deepEqual([await embedStates(page), fx.ran('loop'), fx.ran('sim')], [['live', 'live'], 2, 1], 'the suspended page runs again; the page that was in use was not restarted')
    await pressShift(page, 20)
    assert.deepEqual(await keysOf(loopBack.frame), [], 'the looping page is given none of the reader\'s keys')
    // Chosen again: the stepping key pressed in it moves the share page on, once.
    await page.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1).click()
    const simAgain = await livePage(page, SIM_TITLE)
    await simAgain.frame.click('#keybox')
    await sleep(300)
    await step(page, 'ArrowRight', 'after')
    await sleep(500)
    assert.equal(await activeId(page), 'after', 'one step, not two')
    // And the share page's own keys work after the page in use was unloaded while it held the focus.
    await step(page, 'ArrowRight', 'last')
    await step(page, 'ArrowLeft', 'after')
    await context.close()
  })

  await check('a field the person leaves on purpose is not given the focus back, with a self-focusing page live: a click away, and Tab', async () => {
    for (const leave of ['click', 'Tab']) {
      const { context, presenter, projector } = await pair()
      await goTo(presenter, 'loop', projector)
      const [loop] = await live(presenter)
      await presenter.keyboard.press('k')
      await presenter.waitForFunction(() => document.activeElement && document.activeElement.id === 'quickPollQuestion')
      await presenter.keyboard.type('abc', { delay: 45 })
      // Leave the field deliberately: a click on the composer's own title (nothing focusable), or Tab.
      if (leave === 'click') await presenter.click('#presenterQuickPollCompose .quick-poll-title')
      else await presenter.keyboard.press('Tab')
      // The page goes on focusing itself: a second and a half of it, with keys typed meanwhile.
      const grabsBefore = await loop.frame.evaluate(() => window.grabs)
      await sleep(700)
      await pressShift(presenter, 20)
      assert.ok(await loop.frame.evaluate(() => window.grabs) - grabsBefore >= 3, 'the page kept focusing itself')
      // A character typed now must not land in the field (it is not a key the deck acts on).
      await presenter.keyboard.type(';')
      assert.equal(await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), 'abc', `${leave}: nothing typed afterwards lands in the field that was left`)
      assert.equal(await presenter.evaluate(() => document.activeElement && document.activeElement.id === 'quickPollQuestion'), false, `${leave}: nor is it reported as focused (supplementary)`)
      assert.deepEqual(await keysOf(loop.frame), [], `${leave}: and the page was given no key`)
      // The deck's own keys work: Escape closes the composer, the arrow steps.
      await presenter.keyboard.press('Escape')
      await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
      await step(presenter, 'ArrowRight', 'tail', projector)
      await context.close()
    }
  })

  await check('a lone page that keeps focusing itself is given no key: deck body, a deck button, after its own engagement ended', async () => {
    // The probe asked for in the review: is there a state in which the keys reach an unengaged page
    // while the deck reports an element of its own as focused? Every key is real; the page's own
    // record says what it was given. (A deck text field: the poll-composer case above. Focus in
    // another frame: the case before that.)
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'loop', projector)
    const [loop] = await live(presenter)
    await pressShift(presenter, 40)
    assert.deepEqual(await keysOf(loop.frame), [], 'presenter, focus on the deck body: none of 40')
    // A deck button holds the focus (a real click on the outline toggle or any bar button would
    // act; the composer's type buttons are harmless): K, then Tab to a button.
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => document.activeElement && document.activeElement.id === 'quickPollQuestion')
    await presenter.keyboard.press('Tab')
    await pressShift(presenter, 40)
    assert.deepEqual(await keysOf(loop.frame), [], 'presenter, focus last put on a deck button: none of 40')
    await presenter.keyboard.press('Escape')
    await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
    // The page is chosen, used, and left with Escape: after that it is an unengaged page again.
    await usePane(presenter)
    await loop.frame.click('#grab')
    await presenter.keyboard.press('x')
    assert.deepEqual(await keysOf(loop.frame), ['x'], 'while it is in use the page has the keyboard')
    await presenter.keyboard.press('Escape')
    await presenter.waitForFunction(() => !document.getElementById('currentPreview').classList.contains('embed-engaged'))
    await pressShift(presenter, 40)
    assert.deepEqual((await keysOf(loop.frame)).filter((key) => key === 'Shift'), [], 'presenter, after its engagement ended: none of 40')
    await step(presenter, 'ArrowRight', 'tail', projector)
    await context.close()

    for (const path of ['/deck.html#loop', '/handout.html#loop']) {
      const solo = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(solo, path)
      const [own] = await live(page)
      await pressShift(page, 40)
      assert.deepEqual(await keysOf(own.frame), [], `${path}, focus on the body: none of 40`)
      // Chosen with its chip, used, left with Escape.
      await page.locator('.slide.active figure.slide-embed .embed-interact-chip').first().click()
      await own.frame.click('#grab')
      await page.keyboard.press('x')
      assert.deepEqual(await keysOf(own.frame), ['x'], `${path}: while it is in use the page has the keyboard`)
      await page.keyboard.press('Escape')
      await sleep(300)
      await pressShift(page, 40)
      assert.deepEqual((await keysOf(own.frame)).filter((key) => key === 'Shift'), [], `${path}, after its engagement ended: none of 40`)
      await step(page, 'ArrowRight', 'tail')
      await solo.close()
    }
  })

  await check('a real wheel gesture scrolls the page in the presenter\'s pane once it is chosen, and the audience copy follows; not before', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    const [copy] = await live(projector)
    const PANE = '#currentPreview iframe.live-sim-frame'
    const SLIDE_FRAME = '.slide.active figure.slide-embed iframe'
    // Before the cover is clicked the wheel is the deck's: the page does not move.
    await wheelOver(presenter, PANE)
    assert.equal(await scrollTopOf(pane.frame), 0, 'before the page is chosen a wheel over the pane does not scroll it')
    await usePane(presenter)
    await wheelOver(presenter, PANE)
    const top = await scrollTopOf(pane.frame)
    assert.ok(top > 100, `after the cover is clicked the wheel scrolls the page: scrollTop ${top}`)
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop > 0, null, { timeout: 5000 })
    await sleep(300)
    const [at, mirrored] = [await fraction(pane.frame), await fraction(copy.frame)]
    assert.ok(Math.abs(at - mirrored) < 0.005, `the audience copy is at the same fraction of its own height: ${at} and ${mirrored}`)
    // The keys keep the design's rule (5.6): End and Home are the page's own and scroll it; Space,
    // PageDown and the arrows pressed in the page step the deck (asserted in the keys case above).
    await pane.frame.click('#keybox')
    await presenter.keyboard.press('Home')
    await pane.frame.waitForFunction(() => document.scrollingElement.scrollTop === 0)
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop === 0, null, { timeout: 5000 })
    // Where the scrollbars are: the pane's frame may show them, the projected copy's may not while
    // nobody interacts there. The measurable fact is the attribute (this machine draws overlay
    // scrollbars, which take no width); the picture is compared as well: straight after a scroll
    // that was mirrored to it, the right-hand edge of the projected copy looks as it does at rest.
    assert.deepEqual([await scrollingAttribute(presenter, PANE), await scrollingAttribute(projector, SLIDE_FRAME)], [null, 'no'], 'the pane\'s frame can be scrolled by the person; the audience copy shows no scrollbar')
    const edge = async () => {
      const box = await projector.locator(SLIDE_FRAME).first().boundingBox()
      return (await projector.screenshot({ clip: { x: box.x + box.width - 24, y: box.y, width: 24, height: box.height } })).toString('base64')
    }
    await sleep(1500)
    const atRest = await edge()
    await wheelOver(presenter, PANE, 3)
    await wheelOver(presenter, PANE, -3)
    await copy.frame.waitForFunction(() => document.scrollingElement.scrollTop === 0, null, { timeout: 5000 })
    assert.equal(await edge(), atRest, 'no scrollbar is drawn on the audience copy when it is scrolled from the presenter')
    await context.close()
  })

  await check('a real wheel gesture scrolls the page in the plain deck, the audience window and a share page while Interact is on, and not while it is off', async () => {
    for (const path of ['/deck.html', '/deck.html?audience=1&session=embed-wheel-solo', '/handout.html#sim']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, path)
      if (!path.startsWith('/handout')) await goTo(page, 'sim')
      const [own] = await live(page)
      const FRAME = '.slide.active figure.slide-embed iframe'
      await wheelOver(page, FRAME)
      assert.deepEqual([await scrollTopOf(own.frame), await scrollingAttribute(page, FRAME)], [0, 'no'], `${path}: Interact off, the wheel does not scroll the page`)
      // Interact on: E in a deck window (the audience window has no chip), the chip on a share page.
      if (path.startsWith('/handout')) await page.locator('.slide.active figure.slide-embed .embed-interact-chip').first().click()
      else await page.keyboard.press('e')
      await wheelOver(page, FRAME)
      const top = await scrollTopOf(own.frame)
      assert.ok(top > 100, `${path}: Interact on, the wheel scrolls the page: scrollTop ${top}`)
      assert.equal(await scrollingAttribute(page, FRAME), null)
      // Interact off again (Escape in the page): the wheel does nothing, and the page stays where it was.
      await own.frame.click('#keybox')
      const before = await scrollTopOf(own.frame)
      await page.keyboard.press('Escape')
      await page.waitForFunction((query) => !document.querySelector(query).classList.contains('embed-live'), FRAME, { timeout: 5000 })
      await wheelOver(page, FRAME)
      assert.deepEqual([await scrollTopOf(own.frame), await scrollingAttribute(page, FRAME)], [before, 'no'], `${path}: Interact off again, the wheel does not scroll the page`)
      await context.close()
    }
  })

  await check('the focus budget: a page that keeps taking the keyboard is stopped, and every character the person types lands in the deck\'s field', async () => {
    // 30 characters with r, o and spaces in them: in the deck r is Reveal, o the outline, Space the next step.
    const text = 'roar or soar: do not go for it'
    assert.equal(text.length, 30)
    for (const how of ['40', '10', '1', '0', 'raf']) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
      const presenter = await open(context, `/grab-${how}.html?presenter=1&session=grab-${how}-${Date.now()}#grab`)
      await presenter.waitForSelector('#currentPreview iframe.live-sim-frame')
      // Straight away, while the page is still running and taking the focus: K, then type.
      await presenter.keyboard.press('k')
      await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden)
      const before = await deckLook(presenter)
      await presenter.keyboard.type(text, { delay: 25 })
      assert.equal(await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), text, `${how}: all 30 characters are in the field, in order`)
      assert.deepEqual(await deckLook(presenter), before, `${how}: none reached the deck: same slide, no mode, no outline`)
      // The page is unloaded within the budget (more than 10 grabs within 2 seconds), and says so.
      await presenter.waitForFunction(() => document.getElementById('currentPreview').classList.contains('embed-stopped'), null, { timeout: 3000 })
        .catch(() => { throw new Error(`${how}: the page was not stopped within 3 seconds`) })
      assert.deepEqual(await presenter.evaluate(() => { const pane = document.getElementById('currentPreview'); return [pane.querySelector('iframe.live-sim-frame').hasAttribute('srcdoc'), pane.querySelector('.live-sim-cover-label').textContent, pane.querySelector('.live-sim-cover-note').textContent] }),
        [false, 'Click to run again', STOPPED_LINE], `${how}: the pane's frame is empty and its cover says what happened`)
      // With the offender gone, typing goes on, and the deck's own keys work.
      await presenter.keyboard.type(' more', { delay: 25 })
      assert.equal(await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), `${text} more`, `${how}: typing goes on after the page is stopped`)
      await presenter.keyboard.press('Escape')
      await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
      await step(presenter, 'ArrowRight', 'tail')
      await step(presenter, 'ArrowLeft', 'grab')
      // Coming back is a new visit: it runs again (and is stopped again). The cover runs it for the
      // person, engaged: then it may hold the keyboard, and is not stopped.
      await presenter.waitForFunction(() => document.getElementById('currentPreview').classList.contains('embed-stopped'), null, { timeout: 4000 })
      await usePane(presenter)
      const [again] = await live(presenter)
      await again.frame.click('#grab')
      await presenter.keyboard.press('x')
      await sleep(2300)
      await presenter.keyboard.press('y')
      assert.deepEqual([(await keysOf(again.frame)).join(''), await presenter.evaluate(() => document.getElementById('currentPreview').className.includes('embed-stopped'))], ['xy', false], `${how}: chosen by the person, the page runs, has the keyboard, and is not stopped`)
      await context.close()
    }
  })

  await check('the focus budget: a page that focuses itself once, or three times, at load is not stopped; a stopped page in the plain deck, the audience window and a share page', async () => {
    // Well behaved: once at load (script), an autofocus field, and the three grabs of the flooding page.
    for (const [path, slide] of [['/grab-once.html', 'grab'], ['/deck.html', 'auto'], ['/deck.html', 'both']]) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
      const presenter = await open(context, `${path}?presenter=1&session=calm-${slide}-${Date.now()}#${slide}`)
      await live(presenter)
      await sleep(2600)
      assert.equal(await presenter.evaluate(() => document.getElementById('currentPreview').classList.contains('embed-stopped')), false, `${path}#${slide} (presenter): not stopped`)
      const deck = await open(context, `${path}#${slide}`)
      await live(deck)
      await sleep(2600)
      assert.equal(await deck.evaluate(() => document.querySelectorAll('figure.slide-embed[data-embed-stopped]').length), 0, `${path}#${slide} (plain deck): not stopped`)
      await context.close()
    }
    // Stopped, in a window that shows the slide's own frame: the placeholder with its second line.
    // (The line is CSS on the placeholder; a page can be stopped a quarter of a second after it
    // opens, so the styles are given a moment to be in place before the picture is read.)
    const stoppedFigure = async (page) => {
      await page.waitForFunction(() => { const poster = document.querySelector('.slide.active figure.slide-embed[data-embed-stopped] .embed-poster'); return poster && getComputedStyle(poster, '::after').content !== 'none' }, null, { timeout: 5000 }).catch(() => {})
      return readStoppedFigure(page)
    }
    const readStoppedFigure = (page) => page.evaluate(() => {
      const figure = document.querySelector('.slide.active figure.slide-embed[data-embed="local"]')
      const poster = figure.querySelector('.embed-poster')
      return [figure.hasAttribute('data-embed-stopped'), figure.getAttribute('data-embed-state'), figure.querySelector('iframe').hasAttribute('srcdoc'), getComputedStyle(poster).display !== 'none', getComputedStyle(poster, '::after').content]
    })
    const STOPPED = [true, 'idle', false, true, JSON.stringify(STOPPED_LINE)]
    for (const path of ['/grab-10.html', '/grab-10-handout.html']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, `${path}#grab`)
      await page.waitForFunction(() => document.querySelector('.slide.active figure.slide-embed[data-embed-stopped]'), null, { timeout: 3000 })
      assert.deepEqual(await stoppedFigure(page), STOPPED, `${path}: the page is unloaded and its placeholder says why`)
      // It stays stopped for this visit, the keys are the deck's, and a new visit runs it again.
      await sleep(600)
      fx.resetRuns()
      await step(page, 'ArrowRight', 'tail')
      await step(page, 'ArrowLeft', 'grab')
      await page.waitForFunction(() => document.querySelector('.slide.active figure.slide-embed[data-embed-stopped]'), null, { timeout: 4000 })
      assert.equal(fx.ran('loop'), 1, `${path}: back on the slide it ran again, once, and was stopped again`)
      if (path === '/grab-10.html') {
        // Interact (E) is the person choosing the page: it runs, engaged, and is not stopped.
        await page.keyboard.press('e')
        const [own] = await live(page)
        await own.frame.click('#grab')
        await page.keyboard.press('x')
        await sleep(2300)
        assert.deepEqual([(await keysOf(own.frame)).join(''), await page.evaluate(() => document.querySelectorAll('figure.slide-embed[data-embed-stopped]').length)], ['x', 0], 'plain deck: chosen with E, the page runs and keeps the keyboard')
      }
      await context.close()
    }
    // Presenter and audience: each window decides for its own copy. Here both windows report the
    // focus (headless), so the audience copy takes it too and is stopped there; in use the audience
    // window is not the focused window, nothing is counted there, and its copy keeps running.
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const session = `grab-pair-${Date.now()}`
    const projector = await open(context, `/grab-10.html?audience=1&session=${session}#grab`)
    const presenter = await open(context, `/grab-10.html?presenter=1&session=${session}#grab`)
    await presenter.waitForFunction(() => document.getElementById('currentPreview')?.classList.contains('embed-stopped'), null, { timeout: 4000 })
    await projector.waitForFunction(() => document.querySelector('.slide.active figure.slide-embed[data-embed-stopped]'), null, { timeout: 4000 })
    assert.deepEqual(await stoppedFigure(projector), STOPPED, 'audience window: its own copy, stopped by its own count, shows the placeholder and the line')
    await usePane(presenter)
    await live(presenter)
    await sleep(800)
    assert.deepEqual(await stoppedFigure(projector), STOPPED, 'the presenter running the page again changes nothing in the audience window')
    await context.close()
  })

  await check('touch: a tap or a drag outside the page in use ends it and the suspended page runs again; a tap inside it does not (share page, plain deck)', async () => {
    for (const path of ['/handout.html#two', '/deck.html#two']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, hasTouch: true })
      const page = await open(context, path)
      await live(page, 2)
      const cdp = await context.newCDPSession(page)
      const tapOn = async (locator) => { const box = await locator.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2) }
      const inUse = () => page.evaluate(() => Array.from(document.querySelectorAll('.slide.active figure.slide-embed[data-embed="local"] > iframe')).map((frame) => frame.classList.contains('embed-live')))
      const chip = page.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1)
      const frame = page.locator('.slide.active figure.slide-embed iframe').nth(1)
      // A tap on the chip chooses the page (the chip is hidden while its page is in use: the way out is elsewhere).
      await tapOn(chip)
      await sleep(200)
      assert.deepEqual([await inUse(), await embedStates(page)], [[false, true], ['idle', 'live']], `${path}: a tap on the chip chooses the page; the other is suspended`)
      // A tap inside the page in use is the page's.
      await tapOn(frame)
      await sleep(300)
      assert.deepEqual([await inUse(), await embedStates(page)], [[false, true], ['idle', 'live']], `${path}: a tap inside the page leaves it in use`)
      // A touch that becomes a drag, outside: the browser sends pointerdown and no mouse events.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 8, y: 300 }] })
      for (let i = 1; i <= 5; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 8 + i * 12, y: 300 + i * 6 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await live(page, 2)
      assert.deepEqual([await inUse(), await embedStates(page)], [[false, false], ['live', 'live']], `${path}: a drag outside ends it, and the suspended page runs again`)
      // Chosen again, then a plain tap outside.
      await tapOn(chip)
      await sleep(200)
      assert.deepEqual(await embedStates(page), ['idle', 'live'])
      await page.touchscreen.tap(8, 300)
      await live(page, 2)
      assert.deepEqual([await inUse(), await embedStates(page)], [[false, false], ['live', 'live']], `${path}: a tap outside ends it, and the suspended page runs again`)
      await context.close()
    }
  })

  await check('keyboard: Tab to the Current pane\'s cover or the Interact chip, then Enter or Space, engages the page and does not step the talk', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    const COVER = '#currentPreview .live-sim-cover'
    for (const key of ['Enter', ' ']) {
      const presses = await tabTo(presenter, COVER)
      // The cover is the first stop inside the Current pane (the frame itself is not a tab stop).
      assert.equal(await presenter.evaluate(() => { const pane = document.getElementById('currentPreview'); return Array.from(pane.querySelectorAll('button, a[href], input, iframe, [tabindex]')).filter((el) => el.tabIndex >= 0)[0] === pane.querySelector('.live-sim-cover') }), true)
      await presenter.keyboard.press(key)
      await presenter.waitForFunction(() => document.getElementById('currentPreview').classList.contains('embed-engaged'), null, { timeout: 3000 })
        .catch(() => { throw new Error(`${JSON.stringify(key)} on the cover (reached with ${presses} Tab presses) did not engage the page`) })
      assert.equal(await activeId(presenter), 'sim', `${JSON.stringify(key)} on the cover is not a step`)
      // The page takes what is typed next.
      const had = (await keysOf(pane.frame)).length
      await presenter.keyboard.press('x')
      assert.deepEqual((await keysOf(pane.frame)).slice(had), ['x'], `after ${JSON.stringify(key)} on the cover the page has the keyboard`)
      // Escape: the cover is back.
      await presenter.keyboard.press('Escape')
      await presenter.waitForFunction(() => !document.getElementById('currentPreview').classList.contains('embed-engaged'), null, { timeout: 3000 })
      assert.equal((await paneCover(presenter)).shown, true)
    }
    assert.equal(await activeId(projector), 'sim')
    // A button that has the focus only because it was CLICKED keeps nothing: Enter still steps the
    // talk (a clicker sends it), as before. Previous was clicked: had Enter activated it again the
    // deck would stay on the first slide. (Space is not asserted: before this change, and still,
    // Space on a clicked button steps the talk on key-down AND activates the button on key-up.)
    await presenter.click('#presenterPrev')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'start', null, { timeout: 5000 })
    assert.equal(await presenter.evaluate(() => document.activeElement && document.activeElement.id), 'presenterPrev')
    await step(presenter, 'Enter', 'sim', projector)
    await context.close()

    // The plain deck: the Interact chip.
    const solo = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const deck = await open(solo, '/deck.html')
    await goTo(deck, 'sim')
    const [own] = await live(deck)
    for (const key of ['Enter', ' ']) {
      await tabTo(deck, '.slide.active .embed-interact-chip')
      await deck.keyboard.press(key)
      await deck.waitForFunction(() => document.body.classList.contains('embed-interacting'), null, { timeout: 3000 })
        .catch(() => { throw new Error(`${JSON.stringify(key)} on the Interact chip did not start Interact`) })
      assert.equal(await activeId(deck), 'sim', `${JSON.stringify(key)} on the chip is not a step`)
      const had = (await keysOf(own.frame)).length
      await deck.keyboard.press('x')
      assert.deepEqual((await keysOf(own.frame)).slice(had), ['x'])
      await deck.keyboard.press('Escape')
      await deck.waitForFunction(() => !document.body.classList.contains('embed-interacting'), null, { timeout: 3000 })
    }
    await solo.close()
  })

  await check('the budget is the slide\'s: a page that keeps putting the focus on its neighbour gets every page of the slide stopped; the person can run one again', async () => {
    // The reviewer's case: page A never focuses itself; every 40 ms it calls focus() on page B's
    // window. A count per frame stopped B (the ordinary page) and left A running.
    for (const path of ['/grab-cross-next.html#grab', '/grab-cross-next-handout.html#grab']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, path)
      await page.waitForFunction(() => document.querySelectorAll('.slide.active figure.slide-embed[data-embed-stopped]').length === 2, null, { timeout: 4000 })
        .catch(() => { throw new Error(`${path}: the two pages were not both stopped within 4 seconds`) })
      await sleep(400)
      assert.deepEqual([await stoppedFlags(page), await embedStates(page)], [[true, true], ['idle', 'idle']], `${path}: both pages are unloaded`)
      assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('.slide.active figure.slide-embed[data-embed-stopped] .embed-poster')).map((poster) => getComputedStyle(poster, '::after').content)),
        [JSON.stringify(STOPPED_LINE), JSON.stringify(STOPPED_LINE)], `${path}: each placeholder carries the neutral line`)
      fx.resetRuns()
      // The person runs B again (its chip): B runs, engaged; A stays stopped.
      await page.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1).click()
      const sim = await livePage(page, SIM_TITLE)
      await sim.frame.click('#name')
      await page.keyboard.type('xyz', { delay: 40 })
      assert.equal(await sim.frame.evaluate(() => document.getElementById('name').value), 'xyz', `${path}: B has the keyboard`)
      assert.deepEqual([await stoppedFlags(page), await embedStates(page), fx.ran('cross')], [[true, false], ['idle', 'live'], 0], `${path}: A stays stopped and has not run again`)
      // B left alone again (Escape): it is an ordinary page and is not stopped; A is still not running.
      await sim.frame.click('#keybox')
      await page.keyboard.press('Escape')
      await sleep(2500)
      assert.deepEqual([await stoppedFlags(page), await embedStates(page), fx.ran('cross')], [[true, false], ['idle', 'live'], 0], `${path}: afterwards B runs on, A does not`)
      await step(page, 'ArrowRight', 'tail')
      await context.close()
    }
    // The presenter, where the pane shows the first page only: that page puts the focus on every
    // other frame of the window (the Next and Then previews). Typing is intact, the page is stopped,
    // and its cover runs it again.
    const text = 'roar or soar: do not go for it'
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const presenter = await open(context, `/grab-cross-all.html?presenter=1&session=cross-${Date.now()}#grab`)
    await presenter.waitForSelector('#currentPreview iframe.live-sim-frame')
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden)
    const before = await deckLook(presenter)
    await presenter.keyboard.type(text, { delay: 25 })
    assert.equal(await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), text, 'presenter: all 30 characters are in the field')
    assert.deepEqual(await deckLook(presenter), before, 'presenter: none reached the deck')
    await waitPaneStopped(presenter)
    assert.deepEqual(await paneState(presenter), PANE_STOPPED)
    await presenter.keyboard.press('Escape')
    await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
    await step(presenter, 'ArrowRight', 'tail')
    await step(presenter, 'ArrowLeft', 'grab')
    await waitPaneStopped(presenter)
    await usePane(presenter)
    assert.deepEqual([(await paneState(presenter)).engaged, (await paneState(presenter)).stopped], [true, false], 'presenter: the cover runs that page again, engaged')
    await context.close()
  })

  await check('presenter: a stopped page belongs to the visit to its slide: it stays stopped when the pane is rebuilt, and the next slide starts clean', async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const presenter = await open(context, `/grab-10.html?presenter=1&session=visit-${Date.now()}#grab`)
    await waitPaneStopped(presenter)
    await sleep(500)
    assert.deepEqual(await paneState(presenter), PANE_STOPPED)
    fx.resetRuns()
    // (a) The pane is rebuilt without leaving the slide: a Quick poll takes the Current pane, and
    // dismissing it gives the pane back to the page. The page is NOT loaded again.
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden)
    await presenter.keyboard.type('Have you tried it?')
    await presenter.locator('#quickPollPresetsField button').first().click()
    await presenter.click('#quickPollOpen')
    await presenter.waitForFunction(() => !document.querySelector('#currentPreview iframe.live-sim-frame[data-embed-local]'), null, { timeout: 5000 })
      .catch(() => { throw new Error('the Quick poll did not take the Current pane (the pane was not rebuilt)') })
    await presenter.click('#presenterQuickPollDismiss')
    await presenter.waitForFunction(() => document.querySelector('#currentPreview iframe.live-sim-frame[data-embed-local]'), null, { timeout: 5000 })
    await sleep(500)
    assert.deepEqual([await paneState(presenter), fx.ran('loop')], [PANE_STOPPED, 0], 'rebuilt after a Quick poll: still stopped, and the page did not run')
    // Other things that lay the pane out again: the window resized, the preview size cycled.
    // (Neither rebuilds the pane here; the page stays stopped.)
    await presenter.setViewportSize({ width: 1240, height: 780 })
    for (const key of ['[', ']']) { await presenter.keyboard.press(key); await sleep(200) }
    await presenter.setViewportSize({ width: 1500, height: 900 })
    await sleep(400)
    assert.deepEqual([await paneState(presenter), fx.ran('loop')], [PANE_STOPPED, 0], 'resized, preview size cycled: still stopped')
    // (b) The next slide with a page starts clean: its page is loaded and shown, its cover is the
    // ordinary one, and clicking it engages the page that is already running (it is not run again).
    await step(presenter, 'ArrowRight', 'tail')
    assert.equal((await paneState(presenter)).stopped, false, 'a slide without a page: nothing of the stopped state is left on the pane')
    await step(presenter, 'ArrowRight', 'calm')
    const [calm] = await live(presenter)
    await sleep(300)
    assert.deepEqual([await paneState(presenter), fx.ran('sim')], [PANE_RUNNING, 1], 'the next slide\'s page runs, is shown, and has the ordinary cover')
    await usePane(presenter)
    await calm.frame.click('#inc')
    assert.deepEqual([await calm.frame.evaluate(() => window.clicks), fx.ran('sim'), (await paneState(presenter)).engaged], [1, 1, true], 'its cover engages the page that is running; it is not loaded a second time')
    // (c) Back on the slide is a new visit: the page runs again (and, being what it is, is stopped again).
    await presenter.mouse.click(3, 3)
    await step(presenter, 'ArrowLeft', 'tail')
    await step(presenter, 'ArrowLeft', 'grab')
    await waitPaneStopped(presenter)
    assert.equal(fx.ran('loop'), 1, 'coming back, the page ran again, once')
    // A jump away (End) ends the visit as a step does.
    await presenter.keyboard.press('End')
    await presenter.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'close', null, { timeout: 5000 })
    assert.equal((await paneState(presenter)).stopped, false, 'after a jump the pane is clean')
    await context.close()
  })

  await check('fast loops, before and after they are stopped: the keyboard stays the deck\'s, a field left on purpose stays left, the page in use keeps its keys', async () => {
    // The main deck's looping page is slow enough to keep running; these are the 40 ms loops, which
    // are stopped within about half a second. The page reports every key it is given to the server,
    // so the count covers the time before it was unloaded.
    {
      // Sustained: real keys from the moment the page is there, through the stop, and after.
      fx.resetRuns()
      const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
      const presenter = await open(context, `/grab-40.html?presenter=1&session=fast-a-${Date.now()}#grab`)
      await presenter.waitForSelector('#currentPreview iframe.live-sim-frame')
      await pressShift(presenter, 60)
      await waitPaneStopped(presenter)
      await pressShift(presenter, 20)
      await sleep(300)
      assert.equal(fx.ran('loopkey'), 0, 'of 80 real key presses, before and after the page was stopped, the page was given none')
      await step(presenter, 'ArrowRight', 'tail')
      await context.close()
    }
    {
      // A field left on purpose (a click away) is not given the focus back, before or after the stop.
      fx.resetRuns()
      const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
      const presenter = await open(context, `/grab-40.html?presenter=1&session=fast-b-${Date.now()}#grab`)
      await presenter.waitForSelector('#currentPreview iframe.live-sim-frame')
      await presenter.keyboard.press('k')
      await presenter.waitForFunction(() => document.activeElement && document.activeElement.id === 'quickPollQuestion')
      await presenter.keyboard.type('abc', { delay: 20 })
      await presenter.click('#presenterQuickPollCompose .quick-poll-title')
      await presenter.keyboard.type(';')
      assert.equal(await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), 'abc', 'straight after the click away: nothing lands in the field')
      await waitPaneStopped(presenter)
      await presenter.keyboard.type(';')
      assert.deepEqual([await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), fx.ran('loopkey')], ['abc', 0], 'after the page is stopped: nothing lands in the field, and the page was given no key')
      await presenter.keyboard.press('Escape')
      await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
      await step(presenter, 'ArrowRight', 'tail')
      await context.close()
    }
    for (const path of ['/grab-two40.html#grab', '/grab-two40-handout.html#grab']) {
      // The sibling: a 40 ms loop beside the ordinary page. The person chooses the ordinary page at once.
      fx.resetRuns()
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
      const page = await open(context, path)
      const chip = page.locator('.slide.active figure.slide-embed .embed-interact-chip').nth(1)
      await chip.click()
      const sim = await livePage(page, SIM_TITLE)
      await sim.frame.click('#name')
      await page.keyboard.type('xyz', { delay: 40 })
      assert.deepEqual([await sim.frame.evaluate(() => document.getElementById('name').value), (await embedStates(page))[0]], ['xyz', 'idle'], `${path}: the page in use has the keyboard; the loop beside it is not running`)
      // Left with Escape: the loop may run again, goes over the budget, and the slide's pages are stopped.
      await sim.frame.click('#keybox')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('.slide.active figure.slide-embed[data-embed-stopped]').length === 2, null, { timeout: 5000 })
        .catch(() => { throw new Error(`${path}: the slide's pages were not stopped`) })
      await pressShift(page, 20)
      // Chosen again from its placeholder: it runs, engaged, and the loop stays stopped.
      await chip.click()
      const again = await livePage(page, SIM_TITLE)
      await again.frame.click('#name')
      await page.keyboard.type('q')
      await sleep(600)
      assert.deepEqual([await again.frame.evaluate(() => document.getElementById('name').value), await stoppedFlags(page), fx.ran('loopkey')], ['q', [true, false], 0], `${path}: chosen again, the ordinary page has the keyboard; the loop stays stopped and was given no key at any time`)
      await context.close()
    }
  })

  await check('keyboard: a button keeps Enter only while its focus came from the keyboard; a click on it, or Escape, gives Enter back to the talk', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    // Tab to Previous, then CLICK it (no new focus event): Enter steps the talk on.
    await tabTo(presenter, '#presenterPrev', 80)
    await presenter.click('#presenterPrev')
    await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'start', null, { timeout: 5000 })
    await step(presenter, 'Enter', 'sim', projector)
    await step(presenter, 'Enter', 'attack', projector)
    // (All of this on slides whose pages do not focus themselves: a page that takes the focus while
    // the person is tabbing sends the next Tab back to the start, which is not what is tested here.)
    // Tab to Previous, Enter: activates Previous (unchanged).
    await presenter.mouse.click(3, 3)
    await tabTo(presenter, '#presenterPrev', 80)
    await step(presenter, 'Enter', 'sim', projector)
    // Tab to Previous, Escape, Enter: steps on.
    await presenter.mouse.click(3, 3)
    await tabTo(presenter, '#presenterPrev', 80)
    await presenter.keyboard.press('Escape')
    await step(presenter, 'Enter', 'attack', projector)
    await context.close()
  })

  await check('the Pointer tool and a page: the cover by keyboard turns Pointer off and engages; turning Pointer on ends an engagement; an armed Pointer owns the pane; a stopped page stays stopped', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    const coverCentre = async () => { const box = await presenter.locator('#currentPreview .live-sim-cover').boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2] }
    await presenter.click('#presenterPointer')
    assert.equal(await pointerOn(presenter), true)
    // Decided: an armed Pointer owns the slide area. A mouse press on the pane is the Pointer's; the
    // cover is not clickable until Pointer is off.
    await presenter.mouse.click(...await coverCentre())
    await sleep(300)
    assert.deepEqual([await pointerOn(presenter), (await paneCover(presenter)).engaged], [true, false], 'Pointer armed: a click on the pane does not reach the cover')
    // The keyboard reaches the cover: Enter engages the page and turns Pointer off.
    await tabTo(presenter, '#currentPreview .live-sim-cover')
    await presenter.keyboard.press('Enter')
    await presenter.waitForFunction(() => document.getElementById('currentPreview').classList.contains('embed-engaged'), null, { timeout: 3000 })
    assert.equal(await pointerOn(presenter), false, 'engaging the page turns Pointer off')
    await presenter.keyboard.press('x')
    assert.deepEqual((await keysOf(pane.frame)).slice(-1), ['x'], 'and the page has the keyboard')
    // Turning Pointer on ends the engagement. (In the presenter the pane holds one page: there is no
    // suspended sibling to resume here; the release goes through the same function that resumes them.)
    await presenter.click('#presenterPointer')
    await sleep(300)
    assert.deepEqual([await pointerOn(presenter), await paneCover(presenter)], [true, { shown: true, takesThePress: false, engaged: false, tabStop: -1 }], 'Pointer on: the page is no longer in use; the cover is back, under the Pointer\'s layer')
    await presenter.click('#presenterPointer')
    assert.equal((await paneCover(presenter)).takesThePress, true, 'Pointer off: the cover takes the press again')
    await step(presenter, 'ArrowRight', 'attack', projector)
    await context.close()

    // A stopped page stays stopped when Pointer is toggled, is not reachable by the mouse while
    // Pointer is armed, and runs again from its cover once Pointer is off.
    const solo = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const stopped = await open(solo, `/grab-10.html?presenter=1&session=pointer-${Date.now()}#grab`)
    await waitPaneStopped(stopped)
    await sleep(500)
    fx.resetRuns()
    await stopped.click('#presenterPointer')
    await sleep(300)
    const box = await stopped.locator('#currentPreview .live-sim-cover').boundingBox()
    await stopped.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await sleep(300)
    assert.deepEqual([await paneState(stopped), fx.ran('loop')], [PANE_STOPPED, 0], 'Pointer armed: the stopped page stays stopped; a click on the pane does not run it')
    await stopped.click('#presenterPointer')
    await sleep(300)
    assert.deepEqual([await paneState(stopped), fx.ran('loop')], [PANE_STOPPED, 0], 'Pointer off again: still stopped')
    await usePane(stopped)
    await live(stopped)
    assert.deepEqual([(await paneState(stopped)).engaged, fx.ran('loop')], [true, 1], 'with Pointer off the cover runs the page again')
    await solo.close()
  })

  await check('the person\'s own presses are not grabs: thirty quick cover and deck clicks on an ordinary page never stop it', async () => {
    const { context, presenter, projector } = await pair()
    await goTo(presenter, 'sim', projector)
    const [pane] = await live(presenter)
    await sleep(300)
    fx.resetRuns()
    const box = await presenter.locator('#currentPreview .live-sim-cover').boundingBox()
    for (let cycle = 1; cycle <= 30; cycle += 1) {
      await presenter.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await sleep(50)
      await presenter.mouse.click(3, 3)
      await sleep(50)
      assert.equal((await paneState(presenter)).stopped, false, `cycle ${cycle}: the ordinary page is not stopped`)
    }
    await sleep(400)
    assert.deepEqual([await paneState(presenter), fx.ran('sim'), pane.frame.isDetached()], [PANE_RUNNING, 0, false], 'after thirty cycles: still the same running page (it was never loaded again)')
    // And it still works: chosen, it takes a click.
    await usePane(presenter)
    await pane.frame.click('#inc')
    assert.equal(await pane.frame.evaluate(() => window.clicks), 1)
    await context.close()
  })

  await check('presenter: every frame is under the rule unless the person pressed in it (a page in the audience window reaching through top.opener; a remote site; a clicked video; a highlight)', async () => {
    // A real chain: a plain deck opens the presenter, the presenter opens the audience window (F5),
    // so a page in the audience window can name the presenter's frames as top.opener.frames.
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const framePage = (title, script = '') => `<!doctype html><title>${title}</title><body><button id="b">${title}</button><script>window.keys=[];document.addEventListener('keydown',function(e){window.keys.push(e.key)},true);${script}</script></body>`
    await context.route(`https://${EMBED_FIXTURE_VIDEO_HOST}/**`, (route) => route.fulfill({ contentType: 'text/html', body: framePage('Video') }))
    // The remote site focuses itself every 40 ms.
    await context.route(`${EMBED_FIXTURE_REMOTE_URL}**`, (route) => route.fulfill({ contentType: 'text/html', body: framePage('Remote', 'setInterval(function(){window.focus();document.getElementById("b").focus()},40);') }))
    await context.addInitScript(() => { if (window === window.top) navigator.sendBeacon = () => false })
    const plain = await open(context, '/frames.html')
    const [presenter] = await Promise.all([context.waitForEvent('page'), plain.click('#presenterBtn')])
    await presenter.waitForLoadState('load')
    await presenter.waitForSelector('#currentPreview')
    presenter.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error (presenter): ${error.message}`) })
    const titled = async (page, title) => {
      for (let tries = 0; tries < 60; tries += 1) {
        for (const frame of page.frames()) { try { if (frame !== page.mainFrame() && await frame.evaluate(() => document.title) === title) return frame } catch { /* gone */ } }
        await sleep(50)
      }
      throw new Error(`no frame titled ${title}`)
    }
    const paneCentre = async () => { const box = await presenter.locator('#currentPreview iframe').first().boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2] }

    // A video in the Current pane: the person clicks its controls, and the keyboard is the video's.
    await step(presenter, 'ArrowRight', 'video')
    const video = await titled(presenter, 'Video')
    await presenter.mouse.click(...await paneCentre())
    await sleep(700)
    await presenter.keyboard.press('x')
    await presenter.keyboard.press('ArrowRight')
    assert.deepEqual([await video.evaluate(() => window.keys), await activeId(presenter)], [['x', 'ArrowRight'], 'video'], 'a video the person clicked keeps the keyboard (longer than the rule\'s interval)')
    await presenter.mouse.click(3, 3)

    // A remote site outside Interact that keeps focusing itself (every 40 ms): the focus is taken
    // back each time. NOT "it is given no key": a remote site runs in a process of its own, so the
    // deck hears of a grab a few milliseconds after it, and a key pressed in that gap is the
    // site's (measured: 0 to 3 of 50). Before this rule it kept the keyboard: every key, and the
    // arrow never stepped. Asserted: it does not keep it.
    await step(presenter, 'ArrowRight', 'remote')
    const remote = await titled(presenter, 'Remote')
    await sleep(500)
    await pressShift(presenter, 40)
    const strays = (await remote.evaluate(() => window.keys)).length
    assert.ok(strays <= 8, `the remote site that focuses itself does not keep the keyboard: it was given ${strays} of 40 real key presses`)
    for (let presses = 0; presses < 4 && await activeId(presenter) === 'remote'; presses += 1) { await presenter.keyboard.press('ArrowRight'); await sleep(250) }
    assert.equal(await activeId(presenter), 'words', 'and the arrow steps the talk')

    // Text is selected in the Current preview for a highlight (H arms it), as before.
    await presenter.keyboard.press('h')
    await sleep(300)
    const line = await presenter.frameLocator('#currentPreview iframe').locator('li').first().boundingBox()
    await presenter.mouse.move(line.x + 10, line.y + line.height / 2)
    await presenter.mouse.down()
    await presenter.mouse.move(line.x + line.width * 0.5, line.y + line.height / 2, { steps: 8 })
    await presenter.mouse.up()
    await presenter.waitForFunction(() => document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('mark, .tw-highlight'), null, { timeout: 5000 })
      .catch(() => { throw new Error('dragging over text in the Current preview made no highlight') })
    await presenter.keyboard.press('h')
    await presenter.mouse.click(3, 3)

    // THE REVIEWER'S CASE. The audience window is opened by the presenter; on the next slide its
    // page puts the focus on every frame of the presenter, 25 times a second.
    const [projector] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
    await projector.waitForLoadState('load')
    assert.equal(await projector.evaluate(() => window.opener !== null), true, 'the audience window was opened by the presenter')
    await presenter.bringToFront()
    await step(presenter, 'ArrowRight', 'opener', projector)
    const attacker = await titled(projector, 'Opener focus')
    await attacker.waitForFunction(() => window.asked > 20)
    // A Quick poll is opened: its preview takes the Current pane (a frame that is not a page).
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden)
    await presenter.keyboard.type('Have you tried it?', { delay: 20 })
    await presenter.locator('#quickPollPresetsField button').first().click()
    await presenter.click('#quickPollOpen')
    await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
    await sleep(600)
    // K opens the composer again, and what is typed lands in it.
    const askedBefore = await attacker.evaluate(() => window.asked)
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden, null, { timeout: 3000 })
      .catch(() => { throw new Error('K did not open the composer: the key did not reach the deck') })
    const before = await deckLook(presenter)
    await presenter.keyboard.type('xyz or so', { delay: 60 })
    assert.equal(await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), 'xyz or so', 'every character is in the composer\'s field')
    assert.deepEqual(await deckLook(presenter), before, 'and none reached the deck')
    assert.ok(await attacker.evaluate(() => window.asked) - askedBefore > 20, 'the page in the audience window kept asking throughout')
    await context.close()
  })
  await check('presenter: a press inside the Current preview allows one arrival of the focus: the preview keeps the keyboard until the person presses elsewhere, and a page cannot put the focus back on it afterwards', async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const framePage = (title) => `<!doctype html><title>${title}</title><body><button id="b">${title}</button><script>window.keys=[];document.addEventListener('keydown',function(e){window.keys.push(e.key)},true);</script></body>`
    await context.route(`https://${EMBED_FIXTURE_VIDEO_HOST}/**`, (route) => route.fulfill({ contentType: 'text/html', body: framePage('Video') }))
    await context.route(`${EMBED_FIXTURE_REMOTE_URL}**`, (route) => route.fulfill({ contentType: 'text/html', body: framePage('Remote') }))
    await context.addInitScript(() => { if (window === window.top) navigator.sendBeacon = () => false })
    const plain = await open(context, '/frames.html')
    const [presenter] = await Promise.all([context.waitForEvent('page'), plain.click('#presenterBtn')])
    await presenter.waitForLoadState('load')
    await presenter.waitForSelector('#currentPreview')
    presenter.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error (presenter): ${error.message}`) })
    // The keys the Current preview's document is given, by a record put in it before the person
    // does anything (the person's own actions below are all real mouse and keyboard input).
    const recordPaneKeys = () => presenter.evaluate(() => { const inner = document.querySelector('#currentPreview iframe').contentWindow; inner.__keys = []; inner.addEventListener('keydown', (event) => inner.__keys.push(event.key), true) })
    const paneKeys = () => presenter.evaluate(() => document.querySelector('#currentPreview iframe').contentWindow.__keys.slice())
    const marks = () => presenter.evaluate(() => document.querySelector('#currentPreview iframe').contentDocument.querySelectorAll('mark, .tw-highlight').length)
    const armed = () => presenter.evaluate(() => document.getElementById('presenterHighlight').getAttribute('aria-pressed'))

    // NOT pressing elsewhere: the preview the person clicked in keeps the keyboard (longer than the
    // rule's interval), its keys go to it as before, and a drag there still makes a highlight.
    await step(presenter, 'ArrowRight', 'video')
    await step(presenter, 'ArrowRight', 'remote')
    await step(presenter, 'ArrowRight', 'words')
    await recordPaneKeys()
    await presenter.keyboard.press('h')
    await sleep(300)
    assert.equal(await armed(), 'true', 'H armed Highlight')
    const line = await presenter.frameLocator('#currentPreview iframe').locator('li').first().boundingBox()
    await presenter.mouse.click(line.x + line.width * 0.8, line.y + line.height / 2)
    await sleep(700)
    await presenter.keyboard.press('x')
    await presenter.keyboard.press('ArrowRight')
    await sleep(700)
    await presenter.keyboard.press('y')
    assert.deepEqual([await paneKeys(), await activeId(presenter)], [['x', 'ArrowRight', 'y'], 'words'], 'the preview the person clicked in keeps the keyboard: its keys go to it and the talk does not step')
    const before = await marks()
    await presenter.mouse.move(line.x + 10, line.y + line.height / 2)
    await presenter.mouse.down()
    await presenter.mouse.move(line.x + line.width * 0.5, line.y + line.height / 2, { steps: 8 })
    await presenter.mouse.up()
    await presenter.waitForFunction((had) => document.querySelector('#currentPreview iframe').contentDocument.querySelectorAll('mark, .tw-highlight').length > had, before, { timeout: 5000 })
      .catch(() => { throw new Error('dragging over text in the Current preview made no highlight') })
    await presenter.mouse.click(3, 3)

    // PRESSING ELSEWHERE, with a page in the audience window putting the focus on every frame of
    // the presenter 25 times a second. A Quick poll's preview is in the Current pane (a frame of
    // the deck's own origin, not a page). Highlight is still armed, so a click lands inside it.
    const [projector] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
    await projector.waitForLoadState('load')
    await presenter.bringToFront()
    await step(presenter, 'ArrowRight', 'opener', projector)
    let attacker = null
    for (let tries = 0; tries < 60 && !attacker; tries += 1) {
      for (const frame of projector.frames()) { try { if (frame !== projector.mainFrame() && await frame.evaluate(() => document.title) === 'Opener focus') attacker = frame } catch { /* gone */ } }
      if (!attacker) await sleep(50)
    }
    assert.ok(attacker, 'the page in the audience window is running')
    await attacker.waitForFunction(() => window.asked > 20)
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden)
    await presenter.keyboard.type('Have you tried it?', { delay: 20 })
    await presenter.locator('#quickPollPresetsField button').first().click()
    await presenter.click('#quickPollOpen')
    await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden)
    await sleep(600)
    assert.equal(await armed(), 'true', 'Highlight is still armed')
    await recordPaneKeys()
    const askedBefore = await attacker.evaluate(() => window.asked)
    const pane = await presenter.locator('#currentPreview iframe').first().boundingBox()
    // Click inside the Current preview, click the deck, press K.
    await presenter.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2)
    await presenter.mouse.click(3, 3)
    await presenter.keyboard.press('k')
    await presenter.waitForFunction(() => !document.getElementById('presenterQuickPollCompose').hidden, null, { timeout: 3000 })
      .catch(() => { throw new Error('after a click in the Current preview and a click on the deck, K did not open the composer: the key did not reach the deck') })
    await sleep(1200)
    await presenter.keyboard.type('xyz', { delay: 60 })
    assert.deepEqual([await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), await paneKeys()], ['xyz', []], 'what is typed lands in the composer; the Current preview is given none of it')
    assert.ok(await attacker.evaluate(() => window.asked) - askedBefore > 20, 'the page in the audience window kept asking throughout')
    await context.close()
  })

  await check('presenter: a video that a page focused (taken back) still takes the keyboard when the person clicks it, and gives it up when they click the deck', async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    // The page in the video's frame puts the focus on that frame once, with no press, a little after it loads.
    await context.route(`https://${EMBED_FIXTURE_VIDEO_HOST}/**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Video</title><body><button id="b">Video</button><script>window.keys=[];window.grabs=0;document.addEventListener("keydown",function(e){window.keys.push(e.key)},true);setTimeout(function(){window.focus();document.getElementById("b").focus();window.grabs+=1},900);</script></body>' }))
    await context.route(`${EMBED_FIXTURE_REMOTE_URL}**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Remote</title>' }))
    await context.addInitScript(() => { if (window === window.top) navigator.sendBeacon = () => false })
    const presenter = await open(context, `/frames.html?presenter=1&session=video-${Date.now()}#video`)
    await presenter.waitForSelector('#currentPreview iframe')
    assert.equal(await activeId(presenter), 'video')
    await presenter.mouse.move(3, 3)
    let video = null
    for (let tries = 0; tries < 60 && !video; tries += 1) {
      for (const frame of presenter.frames()) { try { if (frame !== presenter.mainFrame() && await frame.evaluate(() => window.grabs > 0)) video = frame } catch { /* gone */ } }
      if (!video) await sleep(50)
    }
    assert.ok(video, 'the page in the video frame asked for the focus')
    await sleep(300)
    // The pointer is elsewhere: the focus is taken back, and a key is the deck's.
    await presenter.keyboard.press('Shift')
    assert.deepEqual(await video.evaluate(() => window.keys), [], 'a video focused by a page, with the pointer elsewhere, is given no key')
    // A real click on the video: it holds the keyboard, for longer than the rule's interval.
    const box = await presenter.locator('#currentPreview iframe').first().boundingBox()
    await presenter.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await sleep(700)
    await presenter.keyboard.press('x')
    await presenter.keyboard.press('ArrowRight')
    assert.equal(await activeId(presenter), 'video', 'after a real click on the video, the arrow is the video\'s: the talk does not step')
    assert.deepEqual(await video.evaluate(() => window.keys), ['x', 'ArrowRight'], 'a video the person clicked after a rejected grab keeps the keyboard')
    // A real click on the deck: the keys are the deck's again.
    await presenter.mouse.click(3, 3)
    await step(presenter, 'ArrowRight', 'remote')
    await context.close()
  })
  await check('presenter: two presses inside the Current preview leave no press behind: after a script moves the focus to the composer, a script cannot put it back on the preview (ten rounds)', async () => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const blank = (title) => ({ contentType: 'text/html', body: `<!doctype html><title>${title}</title>` })
    await context.route(`https://${EMBED_FIXTURE_VIDEO_HOST}/**`, (route) => route.fulfill(blank('Video')))
    await context.route(`${EMBED_FIXTURE_REMOTE_URL}**`, (route) => route.fulfill(blank('Remote')))
    await context.addInitScript(() => { if (window === window.top) navigator.sendBeacon = () => false })
    const presenter = await open(context, `/frames.html?presenter=1&session=twice-${Date.now()}#words`)
    await presenter.waitForSelector('#currentPreview iframe')
    assert.equal(await activeId(presenter), 'words')
    await presenter.frameLocator('#currentPreview iframe').locator('li').first().waitFor()
    await presenter.keyboard.press('h')
    await sleep(300)
    assert.equal(await presenter.evaluate(() => document.getElementById('presenterHighlight').getAttribute('aria-pressed')), 'true', 'H armed Highlight')
    // The preview's own record of the keys it is given (read by the test; the person's actions are real input).
    const recordPaneKeys = () => presenter.evaluate(() => {
      const inner = document.querySelector('#currentPreview iframe').contentWindow
      if (inner.__keys) inner.__keys.length = 0
      else { inner.__keys = []; inner.addEventListener('keydown', (event) => inner.__keys.push(event.key), true) }
    })
    const paneKeys = () => presenter.evaluate(() => document.querySelector('#currentPreview iframe').contentWindow.__keys.slice())
    for (let round = 1; round <= 10; round += 1) {
      await recordPaneKeys()
      // The person: two real clicks inside the Current preview (the second while it has the keyboard).
      const line = await presenter.frameLocator('#currentPreview iframe').locator('li').nth(1).boundingBox()
      await presenter.mouse.click(line.x + line.width * 0.7, line.y + line.height / 2)
      await sleep(120)
      await presenter.mouse.click(line.x + line.width * 0.9, line.y + line.height / 2)
      // The page, with no press: the composer is shown and its field focused; 50 ms and 500 ms
      // later the focus is put on the Current preview (its frame, and its window).
      await presenter.evaluate(() => {
        setTimeout(() => {
          const field = document.getElementById('quickPollQuestion')
          document.getElementById('presenterQuickPollCompose').hidden = false
          field.value = ''
          field.focus()
          const back = () => { const frame = document.querySelector('#currentPreview iframe'); frame.focus(); frame.contentWindow.focus() }
          setTimeout(back, 50)
          setTimeout(back, 500)
        }, 0)
      })
      await sleep(750)
      await presenter.keyboard.type('xyz', { delay: 40 })
      assert.deepEqual([await presenter.evaluate(() => document.getElementById('quickPollQuestion').value), await paneKeys()], ['xyz', []], `round ${round}: what is typed lands in the composer; the Current preview, focused again by a script, is given none of it`)
      await presenter.keyboard.press('Escape')
      await presenter.waitForFunction(() => document.getElementById('presenterQuickPollCompose').hidden, null, { timeout: 3000 })
    }
    await context.close()
  })
} finally {
  await browser.close()
  await fx.close()
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('embed-mirroring-dom passed')
