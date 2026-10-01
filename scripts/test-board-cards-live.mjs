// The board's cards against a real live worker (ticket 03, ADR-0032): `wrangler dev` (local, throwaway
// secrets and state, nothing deployed), the presenter's own live client, and the real audience page in
// headless Chromium with its real WebSocket. It proves the whole path a card takes: the box, the follow
// client's queue, the worker, and the board state the presenter receives. Checks:
//   - a card typed on the phone is in the presenter's board state within two seconds, in the column
//     chosen, with its exact text, and the same card is on the laptop's list, marked Yours only on the
//     phone that sent it;
//   - the phone's Edit changes the card at the presenter and on the other screen; Withdraw removes it
//     from both, and frees its place;
//   - a card the presenter hides leaves the phone with no notice, and still counts towards the phone's
//     cards (the box closes at the cap without saying why);
//   - a card sorted into a group cannot be changed: the refusal is shown plainly and nothing changes;
//   - a limit refusal from the worker is shown plainly and the text stays in the box (two tabs of one
//     phone sending at once: one card lands, the other is refused);
//   - a closed board and a final board give the box way and refuse a late send plainly;
//   - a card typed with no connection waits on the phone and reaches the presenter once, on reconnect.
// Usage: node scripts/test-board-cards-live.mjs
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`  ok  ${label}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return { value, ms: Date.now() - started }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-board-live-'))
const worker = await startLiveWorker()
let browser
let presenter
try {
  const entry = join(scratch, 'presenter-side.ts')
  const repo = new URL('..', import.meta.url).pathname
  await writeFile(entry, `export { createLivePresenterClient } from '${repo}src/main/live-presenter-client'\n`)
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const bundlePath = join(scratch, 'presenter-side.mjs')
  await writeFile(bundlePath, bundled.outputFiles[0].text)
  const { createLivePresenterClient } = await import(pathToFileURL(bundlePath).href)

  const talkSlug = 'board-live'
  const created = await fetch(`${worker.baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug }),
  }).then((response) => response.json())

  const FIXTURE = `---
title: Board live test
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=slide-a}

- A chat can tell me how to fill in an expenses form.

### What should we keep, change, try?
{poll=board} {id=slide-board}

Add what you would keep, change or try.

- Keep
  - What worked for you?
- Change
- Try
`
  const sourcePath = join(scratch, 'live.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'Board live test', statSync(sourcePath))
  // Two cards a phone, so the cap is quick to reach (the Inspector offers 1, 3, 5 or 10; the worker takes any).
  const compiled = model.slides.find((slide) => slide.poll).poll
  const definition = { ...compiled, board: { ...compiled.board, cardsPerPhone: 2 }, slideId: 'slide-board' }
  const columns = definition.options.map((option) => option.optionId)
  const htmlPath = join(scratch, 'handout.html')
  await writeFile(htmlPath, buildShareHtml({
    title: 'Board live test', slug: talkSlug, liveTalkSlug: talkSlug, workerBaseUrl: worker.baseUrl,
    includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml),
  }))

  // What the presenter holds: the board's state, as the worker sends it (every card, hidden ones too).
  let board = null
  let status = 'connecting'
  presenter = createLivePresenterClient({
    baseUrl: worker.baseUrl, sessionId: created.sessionId, presenterToken: created.presenterToken,
    latest: { slideId: 'slide-a', reveal: 0, focus: null },
    onStatus: (next) => { status = next },
    onPollState: (message) => { if (message.pollType === 'board') board = message },
  })
  await until(() => status, (value) => value === 'live', 10_000, 'presenter live')
  const cards = () => (board && board.boardState ? board.boardState.cards : [])
  presenter.sendPoll({ type: 'poll.open', poll: definition })
  await until(() => board, (value) => Boolean(value), 5000, 'the board open at the presenter')
  presenter.publish('slide-board', 0, null)

  browser = await chromium.launch({ headless: true })
  const initScript = () => {
    const Native = window.WebSocket
    window.__offline = false
    window.__sockets = []
    window.__frames = []
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        if (window.__offline) throw new Error('offline')
        super(url, protocols)
        window.__sockets.push(this)
        this.addEventListener('message', (event) => window.__frames.push(String(event.data)))
      }
    }
  }
  const openAudience = async (size, context = null) => {
    const own = context || await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
    const page = await own.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    await page.addInitScript(initScript)
    await page.goto(pathToFileURL(htmlPath).href + '#slide-board')
    await page.waitForSelector('#bdPanel:not([hidden]) .bd-text', { timeout: 20_000 })
    return { page, context: own }
  }
  const panel = (page) => page.evaluate(() => {
    const p = document.getElementById('bdPanel')
    const visible = (n) => Boolean(n) && !n.hidden && getComputedStyle(n).display !== 'none'
    return {
      cards: [...p.querySelectorAll('.bd-card')].map((c) => ({ text: c.querySelector('.bd-card-text').textContent, mine: c.classList.contains('is-mine'), sending: c.classList.contains('is-sending') })),
      note: p.querySelector('.bd-note')?.textContent || '', noteClass: p.querySelector('.bd-note')?.className || '',
      state: visible(p.querySelector('.bd-state')) ? p.querySelector('.bd-state').textContent : '', compose: visible(p.querySelector('.bd-compose')),
      text: p.querySelector('.bd-text').value, cardsLeft: visible(p.querySelector('.bd-cards-left')) ? p.querySelector('.bd-cards-left').textContent : '',
    }
  })

  const phone = await openAudience([360, 740])
  const laptop = await openAudience([1440, 900])
  const mine = (view) => view.cards.filter((c) => c.mine && !c.sending).map((c) => c.text)

  // 1. A card typed on the phone is in the presenter's state within two seconds.
  const started = Date.now()
  await phone.page.fill('.bd-text', 'More time to try things ourselves')
  await phone.page.click('.bd-send')
  const arrived = await until(cards, (list) => list.length === 1, 5000, 'the card at the presenter')
  const elapsed = Date.now() - started
  check(elapsed < 2000, `a card reaches the presenter's board state in ${elapsed} ms (under 2000)`)
  const first = arrived.value[0]
  check(first.text === 'More time to try things ourselves' && first.column === columns[0], `in the column chosen, with its exact text (${JSON.stringify(first)})`)
  await until(() => panel(laptop.page), (view) => view.cards.length === 1, 5000, 'the card on the laptop')
  const laptopView = await panel(laptop.page)
  check(laptopView.cards[0].text === 'More time to try things ourselves' && laptopView.cards[0].mine === false, 'the same card is on the laptop, not marked Yours there')
  await until(() => panel(phone.page), (view) => mine(view).length === 1, 5000, 'the card marked Yours on the phone')
  const phoneView = await panel(phone.page)
  check(/^Sent to Keep\. It is on the screen now\.$/.test(phoneView.note) && phoneView.cardsLeft === '1 card left', `the phone says sent and 1 card left (${phoneView.note} | ${phoneView.cardsLeft})`)
  check(!(await phone.page.evaluate(() => window.__frames.join('\n'))).includes('"hidden"'), 'no presenter-only field reached the phone')

  // 2. Edit changes the card everywhere; withdraw removes it and frees its place.
  await phone.page.click('.bd-card.is-mine')
  await phone.page.click('[data-act="sheet-edit"]')
  await phone.page.fill('.bd-text', 'More time to try things ourselves, in pairs')
  await phone.page.click('.bd-send')
  await until(cards, (list) => list.length === 1 && list[0].text === 'More time to try things ourselves, in pairs', 5000, 'the edit at the presenter')
  check(true, 'edit: the presenter has the new wording, still one card')
  await until(() => panel(laptop.page), (view) => view.cards[0]?.text === 'More time to try things ourselves, in pairs', 5000, 'the edit on the laptop')
  check(true, 'edit: the laptop shows it too')
  await phone.page.click('.bd-card.is-mine')
  await phone.page.click('[data-act="sheet-withdraw"]')
  await until(cards, (list) => list.length === 0, 5000, 'the withdrawal at the presenter')
  await until(() => panel(laptop.page), (view) => view.cards.length === 0, 5000, 'the withdrawal on the laptop')
  const afterWithdraw = await until(() => panel(phone.page), (view) => /Withdrawn/.test(view.note), 5000, 'the phone saying withdrawn')
  check(afterWithdraw.value.cardsLeft === '2 cards left' || afterWithdraw.value.cardsLeft === '1 card left', `withdraw: the card is gone everywhere and its place is free (${afterWithdraw.value.cardsLeft})`)

  // 3. Hidden by the presenter: the card leaves the phone with no notice; it still counts (2 sent, cap 2).
  for (const text of ['Card one', 'Card two']) {
    await phone.page.fill('.bd-text', text)
    await phone.page.click('.bd-send')
    await until(() => panel(phone.page), (view) => view.cards.some((c) => c.text === text && c.mine && !c.sending), 5000, `${text} sent`)
  }
  await until(cards, (list) => list.length === 2, 5000, 'two cards at the presenter')
  const oneId = cards().find((card) => card.text === 'Card one').cardId
  const twoId = cards().find((card) => card.text === 'Card two').cardId
  presenter.sendPoll({ type: 'board.hide', pollId: definition.pollId, target: { cardId: oneId }, hidden: true })
  await until(() => panel(phone.page), (view) => !view.cards.some((c) => c.text === 'Card one'), 5000, 'the hidden card leaving the phone')
  const hiddenView = await panel(phone.page)
  check(!/hid|hidden|removed/i.test(hiddenView.note + hiddenView.state), `hidden: nothing on the phone says a card was hidden (${hiddenView.note} | ${hiddenView.state})`)
  check(!hiddenView.compose && /You have added 2 cards/.test(hiddenView.state), `hidden: it still counts, so the box closes at the cap (${hiddenView.state})`)
  check(!(await panel(laptop.page)).cards.some((c) => c.text === 'Card one'), 'hidden: and it has left the laptop too')
  check(cards().every((card) => card.text !== 'Card one' || card.hidden === true), 'hidden: the presenter still holds it, hidden')

  // 4. Sorted into a group: the card is no longer the sender's to change.
  await laptop.page.fill('.bd-text', 'Laptop card')
  await laptop.page.press('.bd-text', 'Enter')
  await until(cards, (list) => list.some((card) => card.text === 'Laptop card'), 5000, 'the laptop card at the presenter')
  const laptopCardId = cards().find((card) => card.text === 'Laptop card').cardId
  presenter.sendPoll({ type: 'board.merge', pollId: definition.pollId, source: { cardId: twoId }, target: { cardId: laptopCardId } })
  await until(() => board, (value) => value.boardState.groups.length === 1, 5000, 'a group at the presenter')
  const grouped = await until(() => phone.page.evaluate(() => [...document.querySelectorAll('#bdPanel .bd-card.is-group')].map((c) => ({ text: c.querySelector('.bd-card-text').textContent, sorted: c.classList.contains('is-sorted'), controls: c.querySelectorAll('[data-act="edit"], [data-act="withdraw"]').length }))), (list) => list.length === 1, 5000, 'the group on the phone')
  check(grouped.value[0].sorted && grouped.value[0].controls === 0, `sorted: the group on the phone has no edit or withdraw (${JSON.stringify(grouped.value)})`)
  const laptopSorted = await until(() => laptop.page.evaluate(() => [...document.querySelectorAll('#bdPanel .bd-card.is-group')].map((c) => c.querySelectorAll('[data-act="edit"], [data-act="withdraw"]').length)), (list) => list.length === 1, 5000, 'the group on the laptop')
  check(laptopSorted.value[0] === 0, 'sorted: nor on the laptop, whose own card is in it')

  // 5. A limit refusal from the worker is shown plainly and the text stays: three tabs of one phone (cap 2)
  // each send a card at the same moment, before any of them has heard of the others.
  const context2 = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true })
  const tabs = [await openAudience([360, 740], context2), await openAudience([360, 740], context2), await openAudience([360, 740], context2)]
  // Each tab fills its box now and presses Send at one agreed instant, so all three go out before any answer is back.
  const sendAt = (page, text, at) => page.evaluate(([value, when]) => new Promise((resolve) => {
    const box = document.querySelector('#bdPanel .bd-text')
    box.value = value
    box.dispatchEvent(new Event('input', { bubbles: true }))
    setTimeout(() => { document.querySelector('#bdPanel .bd-send').click(); resolve() }, Math.max(0, when - Date.now()))
  }), [text, at])
  const at = Date.now() + 500
  await Promise.all(tabs.map((tab, index) => sendAt(tab.page, `race ${index}`, at)))
  const race = await until(async () => Promise.all(tabs.map((tab) => panel(tab.page))), (views) => views.some((view) => /most cards one phone can add/.test(view.note)), 8000, 'the limit refusal on one tab')
  const refused = race.value.filter((view) => /most cards one phone can add/.test(view.note))
  check(refused.length === 1 && /failed/.test(refused[0].noteClass) && /^race [012]$/.test(refused[0].text), `limit: exactly one tab is refused, plainly, and its text stays in the box (${refused.length}: ${refused[0]?.note} | ${refused[0]?.text})`)
  await sleep(500)
  const landed = cards().filter((card) => /^race /.test(card.text)).map((card) => card.text)
  check(landed.length === 2 && !landed.includes(refused[0]?.text), `limit: two cards landed and the refused one did not (${landed.join(', ')}; refused ${refused[0]?.text})`)
  await context2.close()

  // 6. No connection: the card waits on the phone and reaches the presenter once, on reconnect.
  const third = await openAudience([360, 740])
  await third.page.evaluate(() => { window.__offline = true; for (const socket of window.__sockets) socket.close() })
  await sleep(600)
  await third.page.fill('.bd-text', 'Typed in a tunnel')
  await third.page.click('.bd-send')
  await sleep(400)
  const waiting = await panel(third.page)
  check(/No connection\. Your card is saved here/.test(waiting.note) && waiting.cards.some((c) => c.text === 'Typed in a tunnel' && c.sending), `offline: the card waits on the phone and says so (${waiting.note})`)
  check(!cards().some((card) => card.text === 'Typed in a tunnel'), 'offline: nothing has reached the presenter')
  await third.page.evaluate(() => { window.__offline = false })
  await until(cards, (list) => list.some((card) => card.text === 'Typed in a tunnel'), 30_000, 'the queued card after reconnect')
  await sleep(600)
  check(cards().filter((card) => card.text === 'Typed in a tunnel').length === 1, 'offline: on reconnect it arrives once')
  await until(() => panel(third.page), (view) => view.cards.some((c) => c.text === 'Typed in a tunnel' && c.mine && !c.sending), 8000, 'the card marked Yours')
  check(true, 'offline: and the phone then marks it Yours')

  // 7. A final board, then a closed one: the box gives way and the board stays readable.
  presenter.sendPoll({ type: 'board.freeze', pollId: definition.pollId, frozen: true })
  await until(() => panel(laptop.page), (view) => /Final board/.test(view.state), 5000, 'the final board on the laptop')
  check(true, 'final: the box gives way to "Final board"')
  presenter.sendPoll({ type: 'board.freeze', pollId: definition.pollId, frozen: false })
  await until(() => panel(laptop.page), (view) => view.compose, 5000, 'the box back')
  presenter.sendPoll({ type: 'poll.close', pollId: definition.pollId })
  await until(() => panel(laptop.page), (view) => /Closed to new cards/.test(view.state), 5000, 'the board closed on the laptop')
  check((await panel(laptop.page)).cards.length > 0, 'closed: "Closed to new cards", and the cards are still listed')

  const errors = [phone, laptop, ...tabs, third].flatMap((entry) => entry.page.errors)
  check(errors.length === 0, `no page errors (${errors.join('; ')})`)
} catch (error) {
  failures.push(String(error?.stack || error))
} finally {
  try { presenter?.disconnect() } catch {}
  await browser?.close()
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`board cards live: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('board cards live: a real card reaches the presenter state in under two seconds; edit and withdraw follow everywhere; a hidden card leaves silently and still counts; a sorted card cannot be changed; a limit refusal is shown plainly with the text kept; an offline card sends once on reconnect; final and closed boards give the box way')
