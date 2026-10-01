// The questions tray in the presenter window (ADR-0027 and its 2026-09-29 amendment, ticket "Anyone
// can ask the speaker"; drawn in round-2 shots D5, D7, D8, D9, D10). The compiled presenter window in
// headless Chromium, with the recording preload (and through it the live bridge) bundled against a
// stub of electron and injected as the app injects it, so the questions arrive through the bridge's
// own live:audience push and Mark answered leaves through its own live:question-answer call. Seams:
//  1. availability: the Poll menu's "Open questions" is disabled until a session is live, then enabled
//     with the waiting count and key A; key A does nothing before a session;
//  2. the tray: opens with key A, the menu item and the counter; lists the waiting questions newest
//     first, each with its slide, time and name (or No name), a "This slide" marker on the one about
//     the slide on screen, and Mark answered; answered ones fold into "Answered · n"; empty state text;
//     Esc and A close it; it sits over the Next and Then previews; a long list scrolls under a header
//     that keeps the count;
//  3. Mark answered sends the worker call, waits for the worker's state, and says so when refused;
//  4. question text and names are text: nothing in them is parsed as HTML or runs;
//  5. the deck keys still move the slides while the tray is open, and the marker follows the slide.
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-questions.mjs
//   SHOTS=<dir> also saves D5 (open with questions, 1440x900 and 1280x800), D7 (empty), D8 (fourteen),
//   the answered fold open, and the Poll menu with the count (D10).
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const FIXTURE = `---
title: The current state of AI agents
duration: 30min
auto_title_slide: false
auto_thanks_slide: false
---

## Where agents came from
{timer=10min}

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
Three stages, and the room will know the first two.
:::

### Have you let an agent work on your files? {id=poll poll=single pollresults=held}

- Yes
- No

### Wrap-up {id=three}

The end.
`
const EVIL = '<img src=x onerror="window.__pwned=1"> and <b>bold</b>'
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-questions-'))
let browser
try {
  const sourcePath = join(scratch, 'questions.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
  const fixturePath = join(scratch, 'questions-present.html')
  await writeFile(fixturePath, model.fullHtml)
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = {
  'recording:context': { testMode: true, talkSlug: 'questions', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {},
  'live:go': { success: true, shortUrl: 'https://handouts.fyi/737u/live', qrSvg: '<svg data-test="join-qr"></svg>', status: 'connecting' },
  'live:end': { success: true, status: 'ended' },
  'live:question-answer': { success: true, operationId: 'op-1', status: 'pending' }
}
window.__ipcCalls = []; window.__ipcArgs = []; window.__ipcOn = {}; window.__answerResult = null
export const ipcRenderer = {
  invoke: async (channel, ...args) => { window.__ipcArgs.push([channel, ...args]); window.__ipcCalls.push(channel); if (channel === 'live:question-answer' && window.__answerResult) return window.__answerResult; return channel in answers ? answers[channel] : {} },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {}, readText() { return '' }, readImage() { return { isEmpty: () => true } } }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text
  browser = await chromium.launch({ headless: true })
  const open = async ([width, height], slide = 'two') => {
    const context = await browser.newContext({ viewport: { width, height } })
    context.setDefaultTimeout(5000)
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\nwindow.__pwned = 0; window.open = () => null\n}` })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(fixturePath).href}?presenter=1#${slide}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    if (await page.isVisible('#twResume')) await page.click('#twResumeNo').catch(() => {})
    await page.mouse.move(5, 500)
    return { page, context }
  }
  const settle = (page, ms = 200) => page.waitForTimeout(ms)
  const guard = async (name, fn) => { try { await fn() } catch (error) { failures.push(`${name}: stopped: ${String(error.message).split('\n')[0]}`) } }
  const goLive = async (page) => { await page.evaluate(() => window.__push('live:status', 'live')); await settle(page) }
  // A question as the worker sends it. `ago` is minutes before now.
  const q = (id, text, { slide = 'two', name, ago = 1, answered = false } = {}) => ({ questionId: id, text, ...(name ? { name } : {}), slideId: slide, tMs: 1000, acceptedAt: Date.now() - ago * 60000, answered })
  const push = (page, questions) => page.evaluate((list) => window.__push('live:audience', { kind: 'questions', questions: list }), questions)
  const tray = (page) => page.evaluate(() => {
    const el = document.getElementById('presenterQuestionsTray')
    if (!el || el.hidden) return null
    const r = el.getBoundingClientRect()
    const list = el.querySelector('.qt-list')
    return {
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      count: el.querySelector('.qt-count')?.textContent, title: el.querySelector('.qt-title')?.textContent,
      items: [...el.querySelectorAll('.qt-list > .qt-item')].map((i) => ({
        id: i.dataset.questionId, slide: i.querySelector('.qt-slide')?.textContent, stitle: i.querySelector('.qt-stitle')?.textContent, here: !!i.querySelector('.qt-here'),
        text: i.querySelector('.qt-text')?.textContent, who: i.querySelector('.qt-who')?.textContent, anon: i.querySelector('.qt-who')?.classList.contains('anon'), time: i.querySelector('.qt-time')?.textContent,
        done: i.querySelector('.qt-done')?.textContent, disabled: i.querySelector('.qt-done')?.disabled })),
      folded: [...el.querySelectorAll('.qt-answered-list > .qt-item')].map((i) => ({ id: i.dataset.questionId, text: i.querySelector('.qt-text')?.textContent, done: i.querySelector('.qt-done')?.textContent })),
      fold: el.querySelector('.qt-answered')?.textContent || null, foldOpen: el.querySelector('.qt-answered')?.getAttribute('aria-expanded'),
      empty: el.querySelector('.qt-empty')?.textContent || null, error: el.querySelector('.qt-error:not([hidden])')?.textContent || null,
      scrolls: list ? list.scrollHeight > list.clientHeight : false, imgs: el.querySelectorAll('img').length, bolds: el.querySelectorAll('.qt-list b').length,
      winH: innerHeight, winW: innerWidth,
      panels: [document.getElementById('nextPreview')?.closest('.presenter-panel'), document.getElementById('presenterFollowing')].filter(Boolean).map((p) => { const b = p.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }),
      counterOpen: document.getElementById('presenterQuestions')?.classList.contains('qt-open')
    }
  })
  // The menu syncs its items as it opens, so it is opened to be read.
  const menu = async (page) => {
    await page.click('#presenterMenuPoll'); await settle(page, 120)
    const read = await page.evaluate(() => { const b = document.getElementById('pollMenuQuestions'); return { disabled: b.disabled, sub: document.getElementById('pollMenuQuestionsSub')?.textContent, key: b.dataset.key } })
    await page.keyboard.press('Escape'); await settle(page, 100)
    return read
  }
  const calls = (page) => page.evaluate(() => window.__ipcArgs.filter(([c]) => c === 'live:question-answer'))
  const slideNow = (page) => page.evaluate(() => document.querySelector('#presenterCount')?.textContent)

  // The key is registered once, in the presenter scope, and nothing else in that scope uses it.
  const entries = SHORTCUT_REGISTRY.filter((entry) => entry.id === 'presenter.questions')
  check(entries.length === 1 && entries[0].scope === 'presenter' && entries[0].keys === 'A', 'registry: presenter.questions is A, once')
  check(SHORTCUT_REGISTRY.filter((entry) => entry.scope === 'presenter' && entry.id !== 'presenter.questions' && entry.keys.split(/\s+/).includes('A')).length === 0, 'registry: no other presenter key is A')

  await guard('availability', async () => {
    const { page, context } = await open([1440, 900])
    let m = await menu(page)
    check(m.disabled && m.sub === 'While live', `before a session the item is disabled and says While live (${JSON.stringify(m)})`)
    await page.keyboard.press('a'); await settle(page)
    check((await tray(page)) === null, 'before a session key A opens nothing')
    await goLive(page)
    await push(page, [q('q1', 'First', { ago: 5 }), q('q2', 'Second', { answered: true })])
    await settle(page)
    m = await menu(page)
    check(!m.disabled && m.sub === '1 waiting' && m.key === 'A', `live: the item is enabled with the waiting count and key A (${JSON.stringify(m)})`)
    check(await page.evaluate(() => document.getElementById('presenterQuestions').dataset.key) === 'A' && await page.evaluate(() => document.getElementById('presenterQuestions').textContent.trim()) === '1', 'live: the counter shows the waiting count and carries the key in its tooltip')
    check(page.errors.length === 0, `availability: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  await guard('tray', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    // Empty first.
    await push(page, [])
    await page.keyboard.press('a'); await settle(page)
    let t = await tray(page)
    check(t && t.empty === 'No questions yet. They arrive here, and nowhere else.' && t.count === 'none yet' && t.items.length === 0, `empty: the empty state reads as drawn (${t?.empty})`)
    check(t && t.counterOpen === true, 'the counter is marked while the tray is open')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'D7-tray-empty-1440x900.png') })
    await page.keyboard.press('Escape'); await settle(page)
    check((await tray(page)) === null, 'Esc closes the tray')
    // Questions arrive: newest first, slide, time, name, this slide.
    await push(page, [
      q('old', 'What does the agent do when it gets stuck?', { slide: 'three', name: 'Priya', ago: 12 }),
      q('mid', 'Is there a recording?', { slide: 'two', ago: 6 }),
      q('new', 'Who pays for the tokens?', { slide: 'poll', name: 'Sam', ago: 1 }),
      q('done1', 'Answered before', { slide: 'two', name: 'Ana', ago: 30, answered: true }),
      q('done2', 'Answered earlier still', { slide: 'three', ago: 40, answered: true })
    ])
    await settle(page)
    await page.keyboard.press('a'); await settle(page)
    t = await tray(page)
    check(t && t.items.map((i) => i.id).join() === 'new,mid,old', `newest first (${t?.items.map((i) => i.id)})`)
    check(t && t.count === '3 waiting', `the header keeps the waiting count (${t?.count})`)
    const byId = Object.fromEntries((t?.items || []).map((i) => [i.id, i]))
    check(byId.new?.slide === 'Slide 3' && /Have you let an agent/.test(byId.new?.stitle) && byId.new?.who === 'Sam', `slide number, slide title and name (${JSON.stringify(byId.new)})`)
    check(byId.mid?.anon === true && byId.mid?.who === 'No name', `no name reads No name (${byId.mid?.who})`)
    check(/\d{1,2}[:.]\d{2}/.test(byId.old?.time || '') && /12 min ago/.test(byId.old?.time), `time and how long ago (${byId.old?.time})`)
    check(byId.mid?.here === true && !byId.new?.here && !byId.old?.here, `This slide marks only the question about the slide on screen (${JSON.stringify(t?.items.map((i) => [i.id, i.here]))})`)
    check(t?.items.every((i) => i.done === 'Mark answered'), 'every waiting question has Mark answered')
    check(t?.fold === 'Answered · 2' && t?.foldOpen === 'false' && t?.folded.length === 0, `answered are folded into Answered · 2 (${t?.fold})`)
    // Over the Next and Then previews.
    const left = Math.min(...t.panels.map((p) => p.left)), top = Math.min(...t.panels.map((p) => p.top))
    check(Math.abs(t.rect.left - left) <= 2 && Math.abs(t.rect.top - top) <= 2 && t.rect.bottom <= t.winH && t.rect.right <= t.winW, `the tray sits over the Next and Then previews, inside the window (${JSON.stringify(t.rect)} vs ${left},${top})`)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'D5-tray-drawer-1440x900.png') })
    // The fold opens.
    await page.click('.qt-answered'); await settle(page)
    t = await tray(page)
    check(t.foldOpen === 'true' && t.folded.map((i) => i.id).join() === 'done1,done2', `the fold opens onto the answered, newest first (${t.folded.map((i) => i.id)})`)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'D5-tray-answered-open-1440x900.png') })
    await page.click('.qt-answered'); await settle(page)
    // Keys: the deck still moves while the tray is open, A and Esc close, a modifier does not.
    const before = await slideNow(page)
    await page.keyboard.press('ArrowRight'); await settle(page, 300)
    check(await slideNow(page) !== before && (await tray(page)) !== null, `the deck keys still move the slides with the tray open (${before} → ${await slideNow(page)})`)
    t = await tray(page)
    check(t.items.find((i) => i.id === 'new')?.here === true && t.items.find((i) => i.id === 'mid')?.here === false, 'the This slide marker follows the slide')
    await page.keyboard.press('Meta+a'); await settle(page)
    check((await tray(page)) !== null, 'Cmd+A does not toggle the tray')
    await page.keyboard.press('a'); await settle(page)
    check((await tray(page)) === null, 'A closes the tray')
    await page.click('#presenterQuestions'); await settle(page)
    check((await tray(page)) !== null, 'the counter opens the tray')
    await page.click('.qt-x'); await settle(page)
    check((await tray(page)) === null, 'the close button closes it')
    await page.click('#presenterMenuPoll'); await settle(page, 150)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'D10-poll-menu-questions-1440x900.png') })
    await page.click('#pollMenuQuestions'); await settle(page)
    check((await tray(page)) !== null, 'the Poll menu item opens the tray')
    check(page.errors.length === 0, `tray: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  await guard('mark answered', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    const list = [q('a', 'Alpha?', { ago: 3 }), q('b', 'Beta?', { ago: 2 })]
    await push(page, list)
    await page.keyboard.press('a'); await settle(page)
    await page.click('.qt-item[data-question-id="a"] .qt-done'); await settle(page)
    check(JSON.stringify(await calls(page)) === JSON.stringify([['live:question-answer', 'a', true]]), `Mark answered sends the worker call (${JSON.stringify(await calls(page))})`)
    let t = await tray(page)
    check(t.items.find((i) => i.id === 'a')?.disabled === true && t.items.length === 2, 'the item waits for the worker rather than vanishing')
    check(await page.evaluate(() => !document.getElementById('presenterQuestionsTray').contains(document.activeElement)), 'clicking Mark answered never moves focus into the tray')
    await push(page, [{ ...list[0], answered: true }, list[1]]); await settle(page)
    t = await tray(page)
    check(t.items.map((i) => i.id).join() === 'b' && t.fold === 'Answered · 1' && t.count === '1 waiting', `the worker's state folds it into Answered · 1 (${t.items.map((i) => i.id)} / ${t.fold})`)
    const counter = await page.evaluate(() => document.getElementById('presenterQuestions').textContent.trim())
    check(counter === '1', `the counter follows (${counter})`)
    // Undo from the fold.
    await page.click('.qt-answered'); await settle(page)
    await page.click('.qt-answered-list .qt-done'); await settle(page)
    const c = await calls(page)
    check(JSON.stringify(c.at(-1)) === JSON.stringify(['live:question-answer', 'a', false]), `Not answered sends the opposite call (${JSON.stringify(c.at(-1))})`)
    await push(page, list); await settle(page)
    t = await tray(page)
    check(t.items.length === 2 && t.fold === null, 'and the question is waiting again')
    // A refusal is said and the button comes back.
    await page.evaluate(() => { window.__answerResult = { success: false, status: 'rejected', error: 'No live session.' } })
    await page.click('.qt-item[data-question-id="b"] .qt-done'); await settle(page)
    t = await tray(page)
    check(t.error === 'No live session.' && t.items.find((i) => i.id === 'b')?.disabled === false, `a refusal is shown and the button comes back (${t.error})`)
    // The worker refusing the queued operation says so too.
    await page.evaluate(() => { window.__answerResult = null; window.__push('live:poll-operation', { operationId: 'op-9', status: 'rejected', message: { type: 'question.answer', questionId: 'b', answered: true }, error: 'Question not found.' }) })
    await settle(page)
    t = await tray(page)
    check(t.error === 'Question not found.', `a rejected operation is shown (${t?.error})`)
    // The session ending closes the tray.
    await page.evaluate(() => window.__push('live:status', 'ended')); await settle(page)
    check((await tray(page)) === null, 'the tray closes when the session ends')
    check(page.errors.length === 0, `mark answered: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  await guard('counter focus, wording, names, Esc order', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    await push(page, [q('a', 'Alpha?', { ago: 2 })])
    await page.click('#presenterQuestions'); await settle(page)
    check(await page.evaluate(() => document.activeElement !== document.getElementById('presenterQuestions')), 'a mouse click leaves no focus on the counter')
    const before = await slideNow(page)
    await page.keyboard.press('Space'); await settle(page, 300)
    check(await slideNow(page) !== before && (await tray(page)) !== null, `Space after clicking the counter advances the slide and the tray stays open (${before} to ${await slideNow(page)})`)
    await page.keyboard.press('a'); await settle(page)
    await page.focus('#presenterQuestions'); await page.keyboard.press('Enter'); await settle(page)
    check((await tray(page)) !== null, 'Enter on the keyboard-focused counter toggles the tray')
    check(await page.evaluate(() => document.getElementById('presenterQuestions').dataset.tip) === 'Questions', 'the counter tooltip reads Questions (with its key A)')
    // All answered.
    await push(page, [q('a', 'Alpha?', { answered: true })]); await settle(page)
    let t = await tray(page)
    check(t.empty === 'All questions answered.' && t.fold === 'Answered · 1', `all answered says so above the fold (${t.empty} / ${t.fold})`)
    // Long and short names, and Esc order.
    const long = 'Bartholomew-Alexander Featherstonehaugh-Cholmondeley-Smythe-Wellington'.slice(0, 60)
    await push(page, [q('n1', 'Anonymous one', { ago: 1 }), q('n2', 'A long name', { name: long, ago: 2 }), q('n3', 'Twenty chars', { name: 'ABCDEFGHIJKLMNOPQRST', ago: 3 })]); await settle(page)
    const names = await page.evaluate(() => [...document.querySelectorAll('.qt-list .qt-item')].map((i) => { const w = i.querySelector('.qt-who > span'); return [w.textContent, w.scrollWidth <= w.clientWidth] }))
    check(names[0][0] === 'No name' && names[0][1], `No name shows in full (${names[0]})`)
    check(names[2][1], 'a 20-character name shows in full')
    check(await page.evaluate(() => [...document.querySelectorAll('.qt-who > span')].some((w) => w.textContent.length === 21 && w.textContent.endsWith('…'))), 'a 60-character name is cut to 20 characters and an ellipsis')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'fix', 'names-1440x900.png') })
    await page.evaluate(() => { document.getElementById('navQuickPoll').click() }); await settle(page)
    const composerOpen = await page.evaluate(() => !document.getElementById('presenterQuickPollCompose').hidden)
    await page.keyboard.press('Escape'); await settle(page)
    check(composerOpen && await page.evaluate(() => document.getElementById('presenterQuickPollCompose').hidden) && (await tray(page)) !== null, 'Esc closes the Quick poll composer first, the tray stays')
    await page.keyboard.press('Escape'); await settle(page)
    check((await tray(page)) === null, 'the next Esc closes the tray')
    await context.close()
    const small = await open([1280, 800], 'two')
    await goLive(small.page)
    await push(small.page, [q('n1', 'Anonymous one', { ago: 1 }), q('n2', 'A long name', { name: long, ago: 2 })])
    await small.page.keyboard.press('a'); await settle(small.page)
    if (SHOTS) await small.page.screenshot({ path: join(SHOTS, 'fix', 'names-1280x800.png') })
    const cut = await small.page.evaluate(() => [...document.querySelectorAll('.qt-who > span')].map((w) => w.textContent + '|' + (w.scrollWidth <= w.clientWidth)))
    check(cut[0] === 'No name|true', `1280x800: No name in full (${cut})`)
    await small.context.close()
  })

  await guard('menus over the tray', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    await push(page, [q('a', 'Alpha?', { ago: 2 })])
    await page.keyboard.press('a'); await settle(page)
    const topmost = (id) => page.evaluate((menuId) => {
      const menu = document.getElementById(menuId); const r = menu.getBoundingClientRect()
      if (menu.hidden || r.width === 0) return { open: false }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      const tray = document.getElementById('presenterQuestionsTray').getBoundingClientRect()
      return { open: true, on: !!hit && menu.contains(hit), overlapsTray: r.left < tray.right && r.right > tray.left && r.top < tray.bottom && r.bottom > tray.top }
    }, id)
    for (const [button, menu] of [['presenterMenuLive', 'presenterLiveMenu'], ['presenterMenuPoll', 'presenterPollMenu'], ['presenterMenuView', 'presenterViewMenu']]) {
      await page.click(`#${button}`); await settle(page, 150)
      let m = await topmost(menu)
      check(m.open && m.on && m.overlapsTray, `tray open: the ${button} dropdown opens by click and is topmost over the tray (${JSON.stringify(m)})`)
      if (SHOTS && button === 'presenterMenuLive') await page.screenshot({ path: join(SHOTS, 'tray-live-menu-1440x900.png') })
      await page.keyboard.press('Escape'); await settle(page, 100)
      await page.focus(`#${button}`); await page.keyboard.press('Enter'); await settle(page, 150)
      m = await topmost(menu)
      check(m.open && m.on, `tray open: the ${button} dropdown opens by keyboard and is topmost (${JSON.stringify(m)})`)
      await page.keyboard.press('Escape'); await settle(page, 100)
    }
    if ((await tray(page)) === null) await page.keyboard.press('a')
    await settle(page)
    // Items run with the tray open: the Poll menu's two switches.
    for (const id of ['liveAllowQuestions', 'liveAllowReactions']) {
      await page.click('#presenterMenuPoll'); await settle(page, 150)
      const was = await page.getAttribute(`#${id}`, 'aria-checked')
      await page.click(`#${id}`); await settle(page, 200)
      const now = await page.getAttribute(`#${id}`, 'aria-checked')
      check(was === 'true' && now === 'false', `tray open: the ${id} switch turns off (${was} to ${now})`)
      await page.keyboard.press('Escape'); await settle(page, 100)
    }
    // Poll > Open questions, with the tray open, closes it; and Live > the two switches are not in this build.
    if ((await tray(page)) === null) await page.keyboard.press('a')
    await settle(page)
    await page.click('#presenterMenuPoll'); await settle(page, 150)
    await page.click('#pollMenuQuestions'); await settle(page, 200)
    check((await tray(page)) === null, 'tray open: Poll > Open questions closes the tray')
    check(page.errors.length === 0, `menus over the tray: no page errors (${page.errors.join('; ')})`)
    // A click on the stage outside the tray still reaches the presenter.
    await page.keyboard.press('a'); await settle(page)
    check(await page.evaluate(() => { const r = document.getElementById('currentPreview').getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 40, r.top + 40); return !document.getElementById('presenterQuestionsTray').contains(hit) }), 'the stage outside the tray is not covered by it')
    await context.close()
  })

  await guard('untrusted text', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    await push(page, [q('e1', EVIL, { name: '<i onclick="window.__pwned=2">Mallory</i>' })])
    await page.keyboard.press('a'); await settle(page, 300)
    const t = await tray(page)
    check(t.items[0]?.text === EVIL && t.items[0]?.who === '<i onclick="window._…', 'the question shows exactly as sent and the name as text, cut at 20')
    check(t.imgs === 0 && t.bolds === 0 && await page.evaluate(() => window.__pwned === 0 && !document.querySelector('#presenterQuestionsTray i')), 'nothing in them became an element or ran')
    await context.close()
  })

  await guard('many questions', async () => {
    for (const size of [[1440, 900], [1280, 800]]) {
      const { page, context } = await open(size, 'two')
      await goLive(page)
      await push(page, Array.from({ length: 14 }, (_, i) => q(`m${i}`, `Question number ${i + 1}: how does this work in practice when the room is full?`, { name: i % 3 ? 'Guest' : undefined, slide: ['two', 'poll', 'three'][i % 3], ago: 40 - i * 2 })))
      await page.keyboard.press('a'); await settle(page)
      const t = await tray(page)
      check(t && t.count === '14 waiting' && t.scrolls && t.rect.bottom <= t.winH, `${size[0]}x${size[1]}: fourteen questions scroll under a header that keeps the count (${t?.count} scroll ${t?.scrolls})`)
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${size[0] === 1440 ? 'D8-tray-many' : 'D5-tray-drawer'}-${size[0]}x${size[1]}.png`) })
      await context.close()
    }
  })

  // Pre-work questions put in the talk's questions (feedback-boards ticket 11): the Run's own list, beside the phones'.
  await guard('pre-work questions', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    const pw = (id, text, { slide = '', name, ago = 3, answered = false } = {}) => ({ questionId: `pw:${id}`, text, ...(name ? { name } : {}), slideId: slide, tMs: 0, acceptedAt: Date.now() - ago * 60000, answered, fromPrework: true })
    const pushPw = (list) => page.evaluate((value) => window.__push('live:prework-questions', value), list)
    await push(page, [q('phone', 'A question from a phone', { slide: 'two' })])
    await pushPw([pw('a:q:one', 'Copilot will not open my drafts. A licence thing?', { slide: 'three' }), pw('b:q:two', EVIL, { name: 'Sam <b>x</b>' })])
    await settle(page)
    check(await page.evaluate(() => document.getElementById('presenterQuestions').textContent.trim()) === '3', 'the counter counts the phones\' question and both pre-work ones')
    await page.keyboard.press('a'); await settle(page)
    const read = () => page.evaluate(() => [...document.querySelectorAll('#presenterQuestionsTray .qt-list > .qt-item')].map((i) => ({
      id: i.dataset.questionId, pre: i.dataset.fromPrework === '1', chip: i.querySelector('.qt-pw')?.textContent || null, slide: i.querySelector('.qt-slide')?.textContent,
      here: !!i.querySelector('.qt-here:not(.qt-pw)'), text: i.querySelector('.qt-text')?.textContent, who: i.querySelector('.qt-who')?.textContent, done: i.querySelector('.qt-done')?.textContent,
      imgs: i.querySelectorAll('img').length, bolds: i.querySelectorAll('b').length })))
    let items = await read()
    const byId = Object.fromEntries(items.map((item) => [item.id, item]))
    check(items.length === 3, `the tray lists the phones' question and the two pre-work ones (${items.length})`)
    check(byId['pw:a:q:one']?.chip === 'From pre-work' && byId['pw:a:q:one']?.slide === 'Slide 4', `a pre-work question is flagged From pre-work and sits on its slide (${JSON.stringify(byId['pw:a:q:one'])})`)
    check(byId['pw:a:q:one']?.who === 'No name', 'no name unless one was typed')
    check(byId['pw:b:q:two']?.slide === 'Any slide' && byId['pw:b:q:two']?.chip === 'From pre-work', 'one with no slide of its own says so')
    check(byId['pw:b:q:two']?.text === EVIL && byId['pw:b:q:two']?.imgs === 0 && byId['pw:b:q:two']?.bolds === 0 && byId['pw:b:q:two']?.who === 'Sam <b>x</b>', 'its text and name are text: nothing parsed as HTML')
    check(byId['pw:b:q:two']?.here === true, 'a question with no slide of its own is marked This slide, whichever slide is on screen')
    check(!byId.phone?.pre && byId.phone?.chip === null, 'the phones\' question is not flagged')
    check(await page.evaluate(() => window.__pwned) === 0, 'nothing in a pre-work question ran')
    // Mark answered goes to the app (which writes the Run), not as a worker question the phones could see; the list it returns folds it.
    const before = (await calls(page)).length
    await page.click('#presenterQuestionsTray .qt-item[data-question-id="pw:a:q:one"] .qt-done'); await settle(page)
    const sent = (await calls(page)).slice(before)
    check(sent.length === 1 && sent[0][1] === 'pw:a:q:one' && sent[0][2] === true, `Mark answered sends the pre-work id to the app (${JSON.stringify(sent)})`)
    await pushPw([pw('a:q:one', 'Copilot will not open my drafts. A licence thing?', { slide: 'three', answered: true }), pw('b:q:two', EVIL, { name: 'Sam <b>x</b>' })])
    await settle(page)
    items = await read()
    check(items.length === 2 && !items.some((item) => item.id === 'pw:a:q:one'), 'once the Run says answered, it folds away')
    check(await page.evaluate(() => document.getElementById('presenterQuestions').textContent.trim()) === '2', 'and the counter drops by one')
    // A question a bad push carries is ignored.
    await pushPw([{ questionId: 'not-pw', text: 'x', slideId: '', acceptedAt: 1, answered: false }, { questionId: 'pw:z', text: 42 }, null])
    await settle(page)
    check((await read()).length === 1, 'malformed pre-work questions are ignored (only the phones\' remains)')
    check(page.errors.length === 0, `no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  assert.deepEqual(failures, [], `presenter questions:\n  ${failures.join('\n  ')}`)
  console.log('presenter questions: key A, the Poll menu item and the counter open the tray over Next and Then; newest first with slide, time, name and This slide; answered fold into Answered · n; Mark answered goes to the worker and waits for its state; Esc closes; text stays text')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
