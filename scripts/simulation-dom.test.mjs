#!/usr/bin/env node
// {chat} {chat-lanes} {terminal} {terminal-agent} in the deck runtime (Playwright's headless shell,
// never the installed Chrome). Spec 5.1, 5.2 and invariants 2-4: a disclosure click or Enter/Space
// never moves the slide; the open state resets on arrival; reveal=steps has one press per part and
// no dead "all full" press; nothing on screen moves between steps; the handout is static and open.
// Paired windows (presenter + audience, and a late-joining audience) share one browser context on a
// routed https origin, so localStorage and BroadcastChannel pair them as in the app. A 22-command
// terminal under reveal=steps checks the overflow rule: no press moves revealed content down, and
// it moves up only once the window is full, just far enough to show the newest command.
// Owner check of 0.38.1-preview.2: a click or the wheel in the presenter's Current pane reaches the
// conversation, a long chat keeps its text size and scrolls (and the windows follow each other), and
// the terminals type / stream=on chats stream (runtime/sim-typing.js) on Playwright's fake clock.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractStyles, extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'

const CHAT = `user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes.
context-retrieval:
  Refund Policy v4.2
tool-call: search_policy_docs {"topic": "refunds"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
bot: The refund window shrank from 30 to 14 days.`
const md = `# Sim deck

## Sims

### Rows {id=rows}
{chat}

\`\`\`chat
${CHAT}
\`\`\`

### Plain shell {id=plainshell}
{terminal}

\`\`\`terminal
$ ls
change-log.md  refund-policy.md
$ git log --oneline -1
a41c9e2 Cut refund window to 14 days
\`\`\`

### Lanes steps {id=lanes}
{chat-lanes reveal=steps}

\`\`\`chat
${CHAT}
\`\`\`

### Agent {id=agent}
{terminal-agent reveal=steps}

\`\`\`terminal
${CHAT}
\`\`\`

### Shell {id=shell}
{terminal reveal=steps}

\`\`\`terminal
$ ls
a
$ pwd
/x
\`\`\`

### Long shell {id=longshell}
{terminal reveal=steps}

\`\`\`terminal
${Array.from({ length: 22 }, (_, i) => `$ step-${i + 1} --run\noutput line for step ${i + 1}`).join('\n')}
\`\`\`

### Panel fit {id=panelfit}
{chat-lanes reveal=steps}

\`\`\`chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering, then compare both.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
  Shipping policy notes
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
model-reasoning: ${Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')}
bot: The refund window shrank from 30 to 14 days.
user: Does that apply to orders placed in August?
model-reasoning (2s): The change log should say when the new window took effect.
bot: No. Orders placed before 1 September keep the 30-day window.
\`\`\`

### Twelve cards {id=twelve}
{chat-lanes reveal=steps}

\`\`\`chat
user: Look everything up.
${Array.from({ length: 12 }, (_, i) => `tool-call: lookup_${i + 1} {"item": ${i + 1}}`).join('\n')}
bot: Done.
\`\`\`

### Long chat {id=longchat}
{chat}

\`\`\`chat
${Array.from({ length: 6 }, (_, i) => `user: Question ${i + 1}: what changed in the refund policy, and why does it matter for orders placed before the change?
bot: Answer ${i + 1}: the refund window shrank from 30 to 14 days, digital goods are refundable only if unused, and refunds over £200 need manager sign-off.`).join('\n')}
\`\`\`

### Stream {id=stream}
{chat-lanes stream=on reveal=steps}

\`\`\`chat
${CHAT}
\`\`\`

### After {id=after}

Plain slide.
`

writeDeckStyles()
const dir = await mkdtemp(join(tmpdir(), 'tw-sim-dom-'))
const outline = join(dir, 'sim-outline.md')
await writeFile(outline, md)
const model = await prepareSource(outline, md, 'sim', { mtimeMs: 0, size: md.length, isDirectory: () => false })
const deckPath = join(dir, 'deck.html')
const handoutPath = join(dir, 'handout.html')
await writeFile(deckPath, model.fullHtml)
await writeFile(handoutPath, buildShareHtml({ title: 'sim', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'sim' }))

const browser = await chromium.launch({ headless: true })
const errors = []
const ORIGIN = 'https://sim-dom.example.test/'
// The structural checks (steps, disclosures, overflow) run WITH reduced motion emulated: typing
// ignores it (spec decision 10), so the terminals type here too. `settle` waits for the typing to
// finish before the next press, so a press is a step and not the "Next finishes typing" press.
// Typing has its own section below, on an injected clock.
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
await context.route(`${ORIGIN}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: model.fullHtml }))
const openPaired = async (query, id = '') => {
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${query}: ${e}`))
  await page.goto(`${ORIGIN}deck.html?${query}${id ? `#${id}` : ''}`)
  await page.waitForTimeout(400)
  return page
}
const previewState = (page) => page.evaluate(() => {
  const doc = document.querySelector('#currentPreview iframe')?.contentDocument
  return doc ? [...doc.querySelectorAll('.sim-toggle')].map((b) => b.getAttribute('aria-expanded')).join(',') : 'no preview'
})
const open = async (file, id, motion = 'reduce') => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: motion })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${pathToFileURL(file).href}#${id}`)
  await page.waitForTimeout(300)
  return page
}
const activeId = (page) => page.evaluate(() => document.querySelector('.slide.active')?.dataset.id)
const expanded = (page) => page.evaluate(() => [...document.querySelectorAll('.slide.active .sim-toggle')].map((b) => b.getAttribute('aria-expanded')).join(','))
const typingDone = (page) => page.waitForFunction(() => !document.querySelector('.slide.active .sim-typing-rest, .slide.active .sim-typing-wait, .slide.active .sim-typing'), null, { timeout: 30000 })
const settle = async (page) => { await typingDone(page); await page.waitForTimeout(150) }

try {
  // Disclosures
  const page = await open(deckPath, 'rows')
  assert.equal(await expanded(page), 'false,false,false', 'data-open="none": the deck closes every row on arrival')
  await page.click('.slide.active .sim-reasoning .sim-toggle'); await settle(page)
  assert.equal(await expanded(page), 'true,false,false', 'a click opens one row')
  assert.equal(await activeId(page), 'rows', 'a toggle click leaves the slide where it is')
  await page.focus('.slide.active .sim-tool .sim-toggle')
  await page.keyboard.press('Enter'); await settle(page)
  assert.equal(await expanded(page), 'true,false,true', 'Enter on a focused toggle opens it')
  assert.equal(await activeId(page), 'rows', 'Enter on a toggle does not advance')
  await page.keyboard.press(' '); await settle(page)
  assert.equal(await expanded(page), 'true,false,false', 'Space on a focused toggle closes it')
  assert.equal(await activeId(page), 'rows', 'Space on a toggle does not advance')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .sim-tool .sim-body')).display), 'none', 'a closed part hides its body')
  await page.evaluate(() => document.activeElement.blur())
  await page.keyboard.press('ArrowRight'); await settle(page)
  await page.keyboard.press('ArrowLeft'); await settle(page)
  assert.equal(await activeId(page), 'rows')
  assert.equal(await expanded(page), 'false,false,false', 'arriving again resets to the authored default')
  await page.emulateMedia({ media: 'print' })
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.slide.active .sim-body')].every((b) => getComputedStyle(b).display !== 'none')), 'print shows every part open')
  await page.close()

  // Step reveal: one press per part, no dead press, nothing moves
  for (const [id, units] of [['lanes', 4], ['agent', 4], ['shell', 1]]) {
    const p = await open(deckPath, id)
    const boxes = () => p.evaluate(() => JSON.stringify([...document.querySelectorAll('.slide.active .sim-step, .slide.active .sim-user, .slide.active .sim-promptbox, .slide.active .sim-cmd')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })))
    const hidden = () => p.evaluate(() => document.querySelectorAll('.slide.active .sim-step[data-mode-state="hidden"]').length)
    const before = await boxes()
    assert.equal(await hidden(), units, `${id}: arrival shows only the anchor`)
    for (let i = 1; i <= units; i++) {
      await p.keyboard.press('ArrowRight'); await settle(p)
      assert.equal(await activeId(p), id, `${id}: press ${i} stays on the slide`)
      assert.equal(await hidden(), units - i, `${id}: press ${i} shows one more part`)
    }
    assert.equal(await boxes(), before, `${id}: nothing on screen moves between steps`)
    await p.keyboard.press('ArrowRight'); await settle(p)
    assert.notEqual(await activeId(p), id, `${id}: the press after the last part leaves the slide (no dead press)`)
    await p.close()
  }

  // A disclosure click during step reveal never steps the slide
  {
    const p = await open(deckPath, 'agent')
    for (let i = 0; i < 4; i++) { await p.keyboard.press('ArrowRight'); await settle(p) }
    await p.click('.slide.active .sim-more'); await settle(p)
    assert.equal(await activeId(p), 'agent')
    assert.equal(await p.evaluate(() => document.querySelectorAll('.slide.active .sim-step[data-mode-state="hidden"]').length), 0, 'the click did not change the step')
    assert.equal(await p.evaluate(() => document.querySelector('.slide.active .sim-more').getAttribute('aria-expanded')), 'true')
    await p.close()
  }

  // Paired windows: an audience click reaches the presenter's Current preview (finding 1), and a
  // late-joining audience window adopts the open set with the presenter's slide (finding 3).
  {
    const presenter = await openPaired('presenter=1&session=sim-pair', 'rows')
    const audience = await openPaired('audience=1&session=sim-pair', 'rows')
    assert.equal(await activeId(audience), 'rows')
    assert.equal(await previewState(presenter), 'false,false,false', 'presenter preview starts at the authored default')
    await audience.click('.slide.active .sim-reasoning .sim-toggle')
    await audience.waitForTimeout(600)
    assert.equal(await expanded(audience), 'true,false,false')
    assert.equal(await previewState(presenter), 'true,false,false', "the presenter's Current preview mirrors the audience's open row")
    const late = await openPaired('audience=1&session=sim-pair')
    await late.waitForTimeout(500)
    assert.equal(await activeId(late), 'rows', 'the late joiner follows the presenter to the slide')
    assert.equal(await expanded(late), 'true,false,false', 'the late joiner adopts the open row')
    // Leaving and coming back still resets to the authored default.
    await presenter.keyboard.press('ArrowRight'); await presenter.waitForTimeout(400)
    await presenter.keyboard.press('ArrowLeft'); await presenter.waitForTimeout(600)
    assert.equal(await activeId(audience), 'rows')
    assert.equal(await expanded(audience), 'false,false,false', 'arriving again resets the paired windows')
    // The presenter steps the long terminal: its Current preview shows the newest revealed
    // command inside the terminal window, as the audience does (at step 6 the CSS bottom anchor
    // alone would show only the still-hidden end of the session).
    await presenter.evaluate(() => { location.hash = 'longshell' }); await presenter.waitForTimeout(500)
    for (let i = 0; i < 5; i++) { await presenter.keyboard.press('ArrowRight'); await typingDone(audience); await presenter.waitForTimeout(150) }
    await presenter.waitForTimeout(900)
    const inView = (page, inFrame) => page.evaluate((inFrame) => {
      const doc = inFrame ? document.querySelector('#currentPreview iframe')?.contentDocument : document
      const slide = doc?.querySelector('.slide.active') || doc?.querySelector('.slide')
      const scroller = slide?.querySelector('.sim-scroll')
      if (!scroller) return 'no scroller'
      const shown = [...scroller.querySelectorAll('.sim-cmd')].filter((c) => !['hidden', 'fuzzy'].includes(c.getAttribute('data-mode-state')))
      const box = scroller.getBoundingClientRect(), last = shown.at(-1).getBoundingClientRect()
      return `${shown.length}:${last.top >= box.top - 1 && last.bottom <= box.bottom + 1}`
    }, inFrame)
    assert.equal(await inView(audience, false), '6:true', 'the audience shows command 6 on screen')
    assert.equal(await inView(presenter, true), '6:true', "the presenter's Current preview shows command 6 on screen")
    await Promise.all([presenter.close(), audience.close(), late.close()])
  }

  // The presenter's Current pane is a picture (an iframe with pointer-events:none and no runtime):
  // owner check 0.38.1-preview.2 found that clicking a row there did nothing. A click on a
  // disclosure in the pane flips that part for both windows and never moves the slide; the wheel
  // over the pane's conversation scrolls it in both windows, and a scroll in the audience window
  // reaches the pane.
  {
    // A fresh context: the deck's stored progress from the windows above would offer "Resume".
    const fresh = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    await fresh.route(`${ORIGIN}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: model.fullHtml }))
    const openFresh = async (query, id) => {
      const page = await fresh.newPage()
      page.on('pageerror', (e) => errors.push(`${query}: ${e}`))
      await page.goto(`${ORIGIN}deck.html?${query}#${id}`)
      await page.waitForTimeout(400)
      return page
    }
    const presenter = await openFresh('presenter=1&session=sim-pane', 'rows')
    const audience = await openFresh('audience=1&session=sim-pane', 'rows')
    const paneToggle = (page, selector) => page.evaluate((selector) => {
      const frame = document.querySelector('#currentPreview iframe')
      const el = frame.contentDocument.querySelector(`.slide ${selector}`)
      const f = frame.getBoundingClientRect(), r = el.getBoundingClientRect(), s = f.width / 1280
      return { x: f.left + (r.left + r.width / 2) * s, y: f.top + (r.top + r.height / 2) * s }
    }, selector)
    const at = await paneToggle(presenter, '.sim-reasoning .sim-toggle')
    await presenter.mouse.click(at.x, at.y); await presenter.waitForTimeout(500)
    assert.equal(await previewState(presenter), 'true,false,false', 'a click on "Thought for" in the Current pane opens it there')
    assert.equal(await expanded(audience), 'true,false,false', '… and in the audience window')
    assert.equal(await presenter.evaluate(() => document.querySelector('.slide.active')?.dataset.id || document.querySelector('#currentPreview iframe')?.contentDocument.querySelector('.slide')?.dataset.id), 'rows', 'the pane click leaves the slide where it is')
    assert.equal(await activeId(audience), 'rows')
    const again = await paneToggle(presenter, '.sim-reasoning .sim-toggle')
    await presenter.mouse.click(again.x, again.y); await presenter.waitForTimeout(500)
    assert.equal(await previewState(presenter), 'false,false,false', 'a second click in the pane closes it')
    assert.equal(await expanded(audience), 'false,false,false')
    // Long chat: the wheel over the pane scrolls the conversation in both windows.
    await presenter.evaluate(() => { location.hash = 'longchat' }); await presenter.waitForTimeout(700)
    const scrolled = (page, inFrame) => page.evaluate((inFrame) => {
      const doc = inFrame ? document.querySelector('#currentPreview iframe')?.contentDocument : document
      const scroller = (doc.querySelector('.slide.active') || doc.querySelector('.slide')).querySelector('.sim-scroll')
      const first = scroller.querySelector('.sim-bubble').getBoundingClientRect(), box = scroller.getBoundingClientRect()
      return { overflow: scroller.scrollHeight - scroller.clientHeight, firstInView: first.top >= box.top - 1, font: getComputedStyle(scroller.querySelector('.sim-bubble')).fontSize }
    }, inFrame)
    const before = await scrolled(audience, false)
    assert.ok(before.overflow > 50, 'the long chat overflows its window')
    assert.equal(before.firstInView, false, 'on arrival the latest turn is in view, the first question is above it')
    assert.equal(before.font, '18.6667px', 'text keeps its size (28 on the 1920 canvas): it scrolls, it does not shrink')
    const pane = await presenter.evaluate(() => { const r = document.querySelector('#currentPreview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
    await presenter.mouse.move(pane.x, pane.y)
    for (let i = 0; i < 12; i++) await presenter.mouse.wheel(0, -400)
    await presenter.waitForTimeout(600)
    assert.equal((await scrolled(presenter, true)).firstInView, true, 'the wheel over the Current pane scrolls its conversation back to the first question')
    assert.equal((await scrolled(audience, false)).firstInView, true, '… and the audience window follows')
    const box = await audience.evaluate(() => { const r = document.querySelector('.slide.active .sim-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
    await audience.mouse.move(box.x, box.y)
    for (let i = 0; i < 12; i++) await audience.mouse.wheel(0, 400)
    await audience.waitForTimeout(600)
    assert.equal((await scrolled(audience, false)).firstInView, false, 'the wheel scrolls the audience window down again')
    assert.equal((await scrolled(presenter, true)).firstInView, false, '… and the Current pane follows')
    await fresh.close()
  }

  // Typing and streaming (runtime/sim-typing.js) on an injected clock: Playwright's fake clock
  // drives Date.now and requestAnimationFrame, paused, so each check reads an exact moment.
  {
    const typed = (page, selector, inFrame = false) => page.evaluate(({ selector, inFrame }) => {
      const doc = inFrame ? document.querySelector('#currentPreview iframe')?.contentDocument : document
      const el = (doc.querySelector('.slide.active') || doc.querySelector('.slide')).querySelector(selector)
      let shown = 0, total = 0
      const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        total += n.data.length
        if (!n.parentElement.closest('.sim-typing-rest')) shown += n.data.length
      }
      return { shown, total, waiting: el.classList.contains('sim-typing-wait'), visibility: getComputedStyle(el).visibility }
    }, { selector, inFrame })
    const clocked = async (url) => {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
      await ctx.clock.install({ time: new Date('2026-10-09T10:00:00Z') })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => errors.push(`typing: ${e}`))
      await page.goto(url)
      await page.clock.pauseAt(new Date('2026-10-09T10:00:05Z'))
      return { ctx, page }
    }
    const { ctx, page } = await clocked(`${pathToFileURL(deckPath).href}#longshell`)
    const press = async (key) => { await page.keyboard.press(key); await page.clock.runFor(16) }
    const hiddenSteps = () => page.evaluate(() => document.querySelectorAll('.slide.active .sim-step[data-mode-state="hidden"]').length)
    // Arrived by a jump: complete at once.
    const anchor = await typed(page, '.sim-cmd')
    assert.ok(anchor.total > 0 && anchor.shown === anchor.total && !anchor.waiting, 'a slide arrived at by a jump shows its text complete')
    await press('ArrowRight')
    const second = '.sim-cmd.sim-step'
    let t = await typed(page, second)
    assert.ok(t.total > 30 && t.shown < 8, `Next starts typing the revealed command (${t.shown} of ${t.total} at 16 ms)`)
    await page.clock.runFor(84)
    t = await typed(page, second)
    // 40 tokens a second at 4 characters a token = 16 characters in 100 ms; the text is painted once
    // a frame (16 ms on the fake clock), so the last paint is at most one frame (2.6 characters) behind.
    assert.ok(t.shown >= 13 && t.shown <= 16, `about 100 ms after the press, 16 characters are typed, within one frame (${t.shown})`)
    const box = () => page.evaluate(() => [...document.querySelectorAll('.slide.active .sim-cmd')].map((c) => { const r = c.getBoundingClientRect(); return [r.top, r.height].join() }).join('|'))
    const typingBoxes = await box()
    const hiddenBefore = await hiddenSteps()
    await press('ArrowRight')
    assert.equal(await hiddenSteps(), hiddenBefore, 'Next while typing does not step')
    t = await typed(page, second)
    assert.equal(t.shown, t.total, '… it finishes the typing at once')
    assert.equal(await box(), typingBoxes, 'typing never moves anything: the untyped text keeps its place')
    await press('ArrowRight')
    assert.equal(await hiddenSteps(), hiddenBefore - 1, 'the next press reveals the next command')
    assert.ok((await typed(page, '.sim-cmd.sim-step:nth-child(3)')).shown < 8, '… and types it')
    await press('ArrowLeft')
    assert.equal(await hiddenSteps(), hiddenBefore)
    assert.equal(await page.evaluate(() => document.querySelectorAll('.slide.active .sim-typing-rest, .slide.active .sim-typing-wait').length), 0, 'Back shows every part complete')
    // Arriving at a step slide, by Next from the slide before or by a jump, shows its anchor complete.
    await page.evaluate(() => { location.hash = 'agent' }); await page.clock.runFor(50)
    for (let i = 0; i < 4; i++) { await press('ArrowRight'); await page.clock.runFor(10000) }
    await press('ArrowRight')
    assert.equal(await activeId(page), 'shell')
    const arrived = await typed(page, '.sim-cmd')
    assert.ok(arrived.total > 0 && arrived.shown === arrived.total && !arrived.waiting, `Next onto a step terminal shows its first command complete (${arrived.shown} of ${arrived.total})`)
    assert.equal(await page.evaluate(() => document.querySelectorAll('.slide.active .sim-typing-rest, .slide.active .sim-typing-wait, .slide.active .sim-typing').length), 0, 'arrival leaves nothing typing')
    await page.clock.runFor(10000)
    await page.evaluate(() => { location.hash = 'agent' }); await page.clock.runFor(50)
    await press('ArrowRight')
    const thinking = await typed(page, '.sim-reasoning')
    assert.ok(thinking.shown < thinking.total, 'the agent terminal types its thinking line')
    await page.clock.runFor(10000)
    assert.equal((await typed(page, '.sim-reasoning')).shown, thinking.total, 'and finishes on its own')
    // Print shows full text, even mid-typing.
    await press('ArrowRight')
    await page.emulateMedia({ media: 'print' })
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.slide.active .sim-typing-rest')].every((el) => getComputedStyle(el).visibility === 'visible')), true, 'print shows the untyped rest')
    await page.emulateMedia({ media: 'screen' })
    // Streaming chat: it streams only the parts a step reveals, never on arrival; a chat without
    // stream=on never types.
    await page.evaluate(() => { location.hash = 'longchat' }); await page.clock.runFor(50)
    await press('ArrowRight')
    assert.equal(await activeId(page), 'stream')
    assert.equal(await page.evaluate(() => document.querySelectorAll('.slide.active .sim-typing-rest, .slide.active .sim-typing-wait, .slide.active .sim-typing').length), 0, 'stream=on: arriving with Next shows the conversation complete')
    await press('ArrowRight')
    const reasoning = await typed(page, '.sim-reasoning')
    assert.ok(reasoning.shown < reasoning.total, `stream=on: the first step streams its reasoning (${reasoning.shown} of ${reasoning.total})`)
    await page.clock.runFor(10000)
    for (let i = 0; i < 2; i++) { await press('ArrowRight'); await page.clock.runFor(10000) }
    await press('ArrowRight')
    const answer = await typed(page, '.sim-answer')
    assert.ok(answer.shown < answer.total && answer.total > 30, `stream=on: the answer streams (${answer.shown} of ${answer.total})`)
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .sim-answer .sim-actions')).visibility), 'hidden', 'the action row waits for the answer')
    await page.clock.runFor(10000)
    assert.equal((await typed(page, '.sim-answer')).shown, answer.total)
    await page.evaluate(() => { location.hash = 'lanes' }); await page.clock.runFor(50)
    for (let i = 0; i < 4; i++) await press('ArrowRight')
    assert.equal(await page.evaluate(() => document.querySelectorAll('.slide.active .sim-typing-rest').length), 0, 'a chat without stream=on never types')
    await ctx.close()

    // Next onto a terminal without step reveal shows the whole session complete; so does a jump.
    {
      const { ctx: c2, page: p2 } = await clocked(`${pathToFileURL(deckPath).href}#rows`)
      await p2.keyboard.press('ArrowRight'); await p2.clock.runFor(16)
      assert.equal(await activeId(p2), 'plainshell')
      const cmds = () => p2.evaluate(() => [...document.querySelectorAll('.slide.active .sim-cmd')].map((c) => c.classList.contains('sim-typing-wait') ? 'wait' : c.classList.contains('sim-typing') ? 'typing' : 'done').join(','))
      assert.equal(await cmds(), 'done,done', 'arriving with Next shows both commands complete, nothing typing')
      await p2.keyboard.press('ArrowLeft'); await p2.clock.runFor(16)
      await p2.evaluate(() => { location.hash = 'plainshell' }); await p2.clock.runFor(50)
      assert.equal(await cmds(), 'done,done', 'arriving by a jump shows the session complete')
      await c2.close()
    }

    // Reduced motion does not stop typing (spec decision 10): with it emulated, the part still types
    // over time (characters appear), and has all its text once finished.
    {
      const p = await open(deckPath, 'shell')
      assert.equal(await p.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true, 'reduced motion is emulated')
      await p.keyboard.press('ArrowRight')
      await p.waitForFunction(() => document.querySelector('.slide.active .sim-typing-rest'), null, { timeout: 5000 })
      const first = await p.evaluate(() => [...document.querySelectorAll('.slide.active .sim-typing-rest')].reduce((n, e) => n + e.textContent.length, 0))
      assert.ok(first > 0, `reduced motion: the part is typing (${first} characters still to come)`)
      await p.waitForTimeout(120)
      const later = await p.evaluate(() => [...document.querySelectorAll('.slide.active .sim-typing-rest')].reduce((n, e) => n + e.textContent.length, 0))
      assert.ok(later < first, `reduced motion: characters appear over time (${first} then ${later} to come)`)
      await typingDone(p)
      assert.equal(await p.evaluate(() => document.querySelectorAll('.slide.active .sim-typing-rest, .slide.active .sim-typing-wait').length), 0, 'and it finishes complete')
      await p.close()
    }

    // Presenter and audience type in step: both derive the characters from the published move.
    {
      const pctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
      await pctx.route(`${ORIGIN}**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: model.fullHtml }))
      await pctx.clock.install({ time: new Date('2026-10-09T10:00:00Z') })
      const presenter = await pctx.newPage()
      presenter.on('pageerror', (e) => errors.push(`typing presenter: ${e}`))
      await presenter.goto(`${ORIGIN}deck.html?presenter=1&session=sim-type#longshell`)
      const audience = await pctx.newPage()
      audience.on('pageerror', (e) => errors.push(`typing audience: ${e}`))
      await audience.goto(`${ORIGIN}deck.html?audience=1&session=sim-type#longshell`)
      await presenter.waitForTimeout(600)
      await presenter.clock.pauseAt(new Date('2026-10-09T10:00:30Z'))
      await presenter.keyboard.press('ArrowRight')
      await presenter.clock.runFor(16)
      // The pane's picture is rebuilt for the new step; let its load (a real event) land.
      await presenter.waitForTimeout(300); await presenter.clock.runFor(16)
      const inPane = await typed(presenter, '.sim-cmd.sim-step', true)
      const onScreen = await typed(audience, '.sim-cmd.sim-step')
      assert.ok(inPane.shown > 0 && inPane.shown < inPane.total, `the presenter's Current pane types (${inPane.shown} of ${inPane.total})`)
      assert.equal(inPane.shown, onScreen.shown, 'the pane and the audience window show the same characters')
      await presenter.keyboard.press('ArrowRight'); await presenter.clock.runFor(16); await presenter.waitForTimeout(300); await presenter.clock.runFor(16)
      assert.equal((await typed(audience, '.sim-cmd.sim-step')).shown, onScreen.total, "the presenter's Next finishes the typing in the audience window too")
      assert.equal(await activeId(audience), 'longshell')
      await pctx.close()
    }
  }

  // Overflowing terminal under step reveal (finding 2).
  {
    const p = await open(deckPath, 'longshell')
    const geometry = () => p.evaluate(() => {
      const scroller = document.querySelector('.slide.active .sim-scroll')
      const box = scroller.getBoundingClientRect()
      const cmds = [...scroller.querySelectorAll('.sim-cmd')]
      return {
        top: box.top, bottom: box.bottom, scrollTop: scroller.scrollTop,
        cmds: cmds.map((c) => { const r = c.getBoundingClientRect(); return [r.top, r.bottom] }),
        shown: cmds.filter((c) => !c.classList.contains('mode-el') || c.getAttribute('data-mode-state') !== 'hidden').length
      }
    })
    let g = await geometry()
    assert.equal(g.shown, 1, 'arrival shows the first command only')
    assert.ok(g.cmds[0][0] >= g.top - 0.5 && g.cmds[0][1] <= g.bottom + 0.5, 'the anchor command is on screen at arrival')
    let full = false
    for (let press = 1; press < 22; press++) {
      await p.keyboard.press('ArrowRight'); await settle(p)
      const next = await geometry()
      assert.equal(next.shown, press + 1, `press ${press} reveals one command`)
      const newest = next.cmds[press]
      assert.ok(newest[0] >= next.top - 0.5 && newest[1] <= next.bottom + 0.5, `press ${press}: the newest command is on screen`)
      const scrolled = Math.abs(next.cmds[0][0] - g.cmds[0][0]) > 0.5
      for (let i = 0; i < press; i++) {
        const moved = next.cmds[i][0] - g.cmds[i][0]
        assert.ok(moved <= 0.5, `press ${press}: command ${i + 1} never moves down (moved ${moved})`)
      }
      // Content moves only when the newest command would pass the bottom edge, and then only far
      // enough to show it: it ends at the bottom of the window.
      if (scrolled) {
        full = true
        assert.ok(next.bottom - newest[1] < 8, `press ${press}: a scroll stops with the newest command at the bottom edge (gap ${next.bottom - newest[1]})`)
      } else if (full) assert.fail(`press ${press}: once full, each press shows the newest command by scrolling`)
      g = next
    }
    assert.ok(full, 'the fixture overflows the terminal window')
    assert.equal(await activeId(p), 'longshell')
    await p.close()
  }

  // Step reveal against each column's own limit (review round 2): before a press the next unit is
  // measured (hidden units keep their space); if it already fits, nothing may move; after the press
  // the newest unit must be on screen within its column (chat-lanes chat column: above the composer,
  // 104; Behind the scenes cards and other layouts: the box edge, 4).
  const stepCheck = async (id, label) => {
    const p = await open(deckPath, id)
    const measure = () => p.evaluate(() => {
      const scroller = document.querySelector('.slide.active .sim-scroll')
      const root = scroller.closest('.sim')
      const u = root.clientWidth / 1920
      const box = scroller.getBoundingClientRect()
      const steps = [...scroller.querySelectorAll('.sim-step')]
      const shown = steps.filter((el) => el.getAttribute('data-mode-state') !== 'hidden').length
      // An answer is measured by its text block: in chat-lanes its grid cell stretches beside the panel.
      const rect = (el) => { const r = (el.matches('.sim-answer') && el.querySelector('.sim-answer-text') || el).getBoundingClientRect(); return [r.top, r.bottom] }
      const limit = (el) => box.bottom - (root.classList.contains('sim-chat-lanes') && !el.closest('.sim-behind') ? 104 : 4) * u * (box.height / scroller.clientHeight)
      return { top: box.top, steps: steps.map((el) => [...rect(el), limit(el)]), shown }
    })
    let before = await measure()
    let fittingPresses = 0
    for (let press = 1; press <= before.steps.length; press++) {
      const next = before.steps[before.shown]
      const fits = next[0] >= before.top - 0.5 && next[1] <= next[2] + 0.5
      await p.keyboard.press('ArrowRight'); await settle(p)
      const after = await measure()
      assert.equal(after.shown, before.shown + 1, `${label} press ${press} reveals one unit`)
      const newest = after.steps[after.shown - 1]
      assert.ok(newest[0] >= after.top - 1 && newest[1] <= newest[2] + 1, `${label} press ${press}: the newest unit is on screen within its column (top ${newest[0].toFixed(1)}, bottom ${newest[1].toFixed(1)}, window ${after.top.toFixed(1)} to ${newest[2].toFixed(1)})`)
      if (fits) {
        fittingPresses += 1
        for (let i = 0; i < before.shown; i++) assert.ok(Math.abs(after.steps[i][0] - before.steps[i][0]) <= 0.5, `${label} press ${press}: the new unit fitted, so unit ${i + 1} must not move (moved ${(after.steps[i][0] - before.steps[i][0]).toFixed(1)})`)
      }
      before = after
    }
    await p.close()
    return fittingPresses
  }
  // panelfit: its fourth card ends inside the panel's edge but below the composer line, and a second
  // exchange below makes the box scrollable, so a composer reserve wrongly applied to the panel moves it.
  assert.ok(await stepCheck('panelfit', 'chat-lanes panel') >= 4, 'the panel fixture reveals its four cards without moving anything')
  await stepCheck('twelve', 'twelve cards')
  await stepCheck('longshell', 'long terminal')
  await stepCheck('lanes', 'short chat-lanes')

  // Print at a mid-reveal step (review round 2): paper shows the same as at any other step, and the
  // step position returns after printing. Playwright's print emulation fires no print events, so the
  // test dispatches them as the browser does around window.print().
  {
    const p = await open(deckPath, 'longshell')
    const printed = async () => {
      await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
      await p.emulateMedia({ media: 'print' })
      const r = await p.evaluate(() => {
        const scroller = document.querySelector('.slide.active .sim-scroll')
        const box = scroller.getBoundingClientRect()
        const cmds = [...scroller.querySelectorAll('.sim-cmd')].map((c) => c.getBoundingClientRect())
        return { scrollTop: scroller.scrollTop, lastIn: cmds.at(-1).bottom <= box.bottom + 1 && cmds.at(-1).top >= box.top - 1, tops: cmds.map((c) => Math.round(c.top - box.top)).join(',') }
      })
      await p.emulateMedia({ media: 'screen' })
      await p.evaluate(() => window.dispatchEvent(new Event('afterprint'))); await settle(p)
      return r
    }
    await p.keyboard.press('ArrowRight'); await settle(p)
    const atStep1 = await printed()
    assert.equal(atStep1.scrollTop, 0, 'print resets the scroll box to its static anchor')
    assert.ok(atStep1.lastIn, 'printed at step 1, the end of the session is on the page, as in the handout')
    const anchor = await p.evaluate(() => { const s = document.querySelector('.slide.active .sim-scroll'); const c = s.querySelector('.sim-cmd').getBoundingClientRect(); const b = s.getBoundingClientRect(); return c.top >= b.top - 1 && c.bottom <= b.bottom + 1 })
    assert.ok(anchor, 'after printing the step position is back: the first command is on screen')
    for (let i = 0; i < 9; i++) await p.keyboard.press('ArrowRight')
    await settle(p)
    assert.equal((await printed()).tops, atStep1.tops, 'printed output does not depend on the reveal step')
    await p.close()
  }

  // Handout: static, everything open, no runtime closing
  {
    const p = await open(handoutPath, 'rows')
    const state = await p.evaluate(() => {
      const root = document.querySelector('.slide[data-id="rows"] .sim')
      return {
        statik: root.classList.contains('sim-static'),
        bodies: [...root.querySelectorAll('.sim-body')].every((b) => getComputedStyle(b).display !== 'none'),
        chevrons: [...root.querySelectorAll('.sim-chevron')].every((c) => getComputedStyle(c).display === 'none'),
        tabbable: [...root.querySelectorAll('.sim-toggle')].some((b) => b.tabIndex >= 0)
      }
    })
    assert.deepEqual(state, { statik: true, bodies: true, chevrons: true, tabbable: false })
    await p.close()
  }
  assert.deepEqual(errors, [], 'no page errors')
  console.log('simulation dom: disclosures, step reveal, Current pane input, scrolling, typing and handout static all hold')
} finally {
  await context.close()
  await browser.close()
  await rm(dir, { recursive: true, force: true })
}
