// The board on the real published audience page (buildShareHtml with its follow runtime), in headless
// Chromium at 360x740 (a stack under the slide) and 1440x900 (a panel beside it), against a fake live
// socket that plays a small board service: it stores cards, answers card.ack, and sends the public
// poll.state first, as the worker does. Seams: the page DOM (tabs, the box, the counter, cards left,
// own cards with edit and withdraw, every state: sent, waiting, offline, refused, closed, final, at the
// cap, hidden), the layout at both sizes, and card text as text. The pure module and the client's queue
// have their own unit test (audience-board.test.mjs); the whole path to a presenter is
// test-board-cards-live.mjs.
// Usage: node scripts/audience-board-dom.test.mjs
//   SHOTS=<dir> saves the drawn states, named for the drawings (F1..F13, L1, L2).
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const FIXTURE = `---
title: Feedback board test
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=slide-a}

- A chat can tell me how to fill in an expenses form.

### What should we keep, change, try?
{poll=board} {id=slide-board}

Add what you would keep, change or try. One idea per card; no names are shown.

> Example: More time to try things ourselves

- Keep
  - What worked for you?
- Change
  - What should be different?
- Try
  - What could we do next time?

### Where this leaves us {id=slide-c}

- Agents work with your files and software to complete a task.
`
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-board-src-'))
const sourcePath = join(sourceDir, 'board.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'Feedback board test', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-board-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, buildShareHtml({
  title: 'Board browser test', slug: 'board-test', liveTalkSlug: 'board-test',
  workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null, styles, slides,
}))
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }

// The page's side: a fake socket and a small board service. `window.__srv` is the test's handle on it.
const initScript = () => {
  const settings = { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 }
  const srv = window.__srv = {
    sockets: [], sent: [], offline: false, open: true, frozen: false, refuse: null, settings,
    cards: [], groups: [], nextCard: 1, used: 0, hiddenIds: new Set(), waitingIds: new Set(), otherCards: 0,
    withhold: false, // do not answer (a slow worker)
  }
  window.__capabilities = { protocol: 2, build: '15-feedback-boards' }
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => window.__capabilities }
    if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
    return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
  }
  const pollState = () => {
    const visible = srv.cards.filter((card) => !srv.hiddenIds.has(card.cardId))
    const groups = srv.groups.map((g) => ({ n: g.n, column: g.column, cardIds: g.cardIds.filter((id) => !srv.hiddenIds.has(id)), count: g.cardIds.filter((id) => !srv.hiddenIds.has(id)).length })).filter((g) => g.cardIds.length)
    const cards = visible.map((card) => {
      const group = srv.groups.find((g) => g.cardIds.includes(card.cardId))
      return { cardId: card.cardId, column: card.column, text: card.text, acceptedAt: card.acceptedAt, ...(group ? { group: group.n } : {}), ...(srv.waitingIds.has(card.cardId) ? { waiting: true } : {}) }
    })
    const columns = ['keep', 'change', 'try'].map((id) => ({ columnId: id, onScreen: [], waiting: 0, cards: cards.filter((c) => c.column === id).length }))
    return {
      type: 'poll.state', pollId: 'poll-board', slideId: 'slide-board', pollType: 'board', question: 'What should we keep, change, try?',
      options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }],
      visibility: 'live', open: srv.open, revealed: false,
      board: { ...srv.settings, instructions: 'Add what you would keep, change or try. One idea per card; no names are shown.', example: 'More time to try things ourselves',
        hints: { keep: 'What worked for you?', change: 'What should be different?', try: 'What could we do next time?' } },
      boardState: { frozen: srv.frozen, limit: srv.settings.limit, release: { extra: 0, all: false, groupsOnly: false, columns: {} }, cards, groups, columns, entries: cards.length, shown: cards.length, waiting: 0, cardCount: cards.length },
    }
  }
  srv.broadcast = () => { for (const socket of srv.sockets) if (socket.readyState === 1) socket.emit(pollState()) }
  srv.seed = (column, text, extra = {}) => { const id = 'card-' + srv.nextCard++; srv.cards.push({ cardId: id, column, text, acceptedAt: 1000 + srv.nextCard, mine: false, ...extra }); srv.broadcast(); return id }
  srv.group = (n, column, ids) => { srv.groups.push({ n, column, cardIds: ids }); srv.broadcast() }
  window.WebSocket = class FakeWebSocket {
    static OPEN = 1
    readyState = 0
    constructor(url) {
      this.url = url
      srv.sockets.push(this)
      queueMicrotask(() => {
        if (srv.offline) { this.readyState = 3; this.onclose?.(); return }
        this.readyState = 1
        this.onopen?.()
        this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 600000 })
      })
    }
    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'session.sync') {
        queueMicrotask(() => this.emit({
          type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId, expiresAt: Date.now() + 600000,
          slideState: null, polls: [pollState()], receipts: [],
          myCards: srv.cards.filter((c) => c.mine && !srv.hiddenIds.has(c.cardId)).map((c) => ({ pollId: 'poll-board', cardId: c.cardId, column: c.column, text: c.text, sorted: srv.groups.some((g) => g.cardIds.includes(c.cardId)), waiting: srv.waitingIds.has(c.cardId) })),
          myBoards: [{ pollId: 'poll-board', cardsUsed: srv.used, cardsPerPhone: srv.settings.cardsPerPhone }],
        }))
      }
      if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
      if (!/^card\./.test(message.type)) return
      srv.sent.push(message)
      if (srv.withhold) return
      setTimeout(() => this.emit(this.handle(message)), 20)
    }
    handle(message) {
      const reply = (status, error, extra = {}) => ({ type: 'card.ack', submissionId: message.submissionId, pollId: message.pollId, status, ...(error ? { error } : {}), ...extra })
      if (srv.refuse) return reply('rejected', srv.refuse)
      if (!srv.open) return reply('rejected', 'board_closed')
      if (srv.frozen) return reply('rejected', 'board_frozen')
      if (message.type === 'card.add') {
        if (srv.used >= srv.settings.cardsPerPhone) return reply('rejected', 'card_limit_reached')
        if (Array.from(message.text).length > srv.settings.cardChars) return reply('rejected', 'card_too_long')
        const card = { cardId: 'card-' + srv.nextCard++, column: message.column, text: message.text, acceptedAt: Date.now(), mine: true, ...(message.name ? { name: message.name } : {}) }
        srv.cards.push(card); srv.used += 1
        srv.broadcast()
        return reply('confirmed', undefined, { cardId: card.cardId, cardsUsed: srv.used })
      }
      const card = srv.cards.find((c) => c.cardId === message.cardId && c.mine && !srv.hiddenIds.has(c.cardId))
      if (!card) return reply('rejected', 'card_not_found')
      if (srv.groups.some((g) => g.cardIds.includes(card.cardId))) return reply('rejected', 'card_sorted')
      if (message.type === 'card.edit') card.text = message.text
      else { srv.cards = srv.cards.filter((c) => c !== card) }
      srv.broadcast()
      return reply('confirmed', undefined, { cardId: card.cardId, cardsUsed: srv.used })
    }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()) }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}

async function open(browser, size, hash = '#slide-a') {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(initScript)
  await page.goto(pathToFileURL(htmlPath).href + hash)
  await page.waitForFunction(() => window.__srv.sockets.length >= 1)
  return { page, context }
}
const live = (page, slideId, revision) => page.evaluate(([id, rev]) => window.__srv.sockets.at(-1).emit({ type: 'slide.state', slideId: id, reveal: 0, focus: null, revision: rev }), [slideId, revision])
const settle = (page, ms = 150) => page.waitForTimeout(ms)
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const sent = (page) => page.evaluate(() => window.__srv.sent.map((m) => ({ ...m })))
const view = (page) => page.evaluate(() => {
  const panel = document.getElementById('bdPanel')
  const q = (sel) => panel.querySelector(sel)
  const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
  const visible = (node) => Boolean(node) && !node.hidden && getComputedStyle(node).display !== 'none'
  const targets = [...panel.querySelectorAll('button, textarea')].filter((n) => visible(n) && n.closest('[hidden]') === null && getComputedStyle(n).visibility !== 'hidden')
  return {
    shown: !panel.hidden && getComputedStyle(panel).display !== 'none',
    panelRect: rect(panel), stageRect: rect(document.getElementById('stageFit')),
    tabs: [...panel.querySelectorAll('.bd-tab')].map((t) => ({ label: t.firstChild.textContent, n: t.querySelector('.n').textContent, on: t.getAttribute('aria-selected') === 'true' })),
    instructions: q('.bd-instr-text')?.textContent || '', example: q('.bd-ex')?.textContent || '',
    placeholder: q('.bd-text')?.placeholder || '', text: q('.bd-text')?.value ?? '',
    composeVisible: visible(q('.bd-compose')), to: visible(q('.bd-to')) ? q('.bd-to-text').textContent : '', left: q('.bd-left')?.textContent || '',
    cardsLeft: visible(q('.bd-cards-left')) ? q('.bd-cards-left').textContent : '',
    sendLabel: q('.bd-send')?.textContent.trim(), sendDisabled: q('.bd-send')?.disabled, cancelShown: visible(q('.bd-cancel')),
    note: q('.bd-note')?.textContent || '', noteClass: q('.bd-note')?.className || '',
    state: visible(q('.bd-state')) ? q('.bd-state').textContent : '',
    askShown: visible(q('.bd-ask')), askText: q('.bd-ask')?.textContent || '',
    head: visible(q('.bd-head')) ? q('.bd-title').textContent : '', eyebrow: visible(q('.bd-head')) ? q('.bd-eyebrow').textContent : '',
    readHead: q('.bd-read-head')?.textContent || '', yours: q('.bd-yours')?.textContent || '',
    cards: [...panel.querySelectorAll('.bd-card')].map((c) => ({
      text: c.querySelector('.bd-card-text').textContent, group: c.querySelector('.num')?.textContent ?? null, x: c.querySelector('.x')?.textContent ?? null,
      mine: c.classList.contains('is-mine'), sending: c.classList.contains('is-sending'), sorted: c.classList.contains('is-sorted'),
      edit: rect(c.querySelector('[data-act="edit"]')) && visible(c.querySelector('[data-act="edit"]')), drop: visible(c.querySelector('[data-act="withdraw"]')), tag: c.querySelector('.bd-mine')?.textContent || '',
    })),
    minTarget: Math.min(...targets.map((n) => { const b = n.getBoundingClientRect(); return Math.min(b.width, b.height) })),
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight,
    rxDock: (() => { const d = document.getElementById('rxDock'); return Boolean(d) && !d.hidden && getComputedStyle(d).display !== 'none' })(),
    body: [...document.body.classList].join(' '),
  }
})
const sheet = (page) => page.evaluate(() => {
  const s = document.querySelector('.bd-sheet')
  return s ? { title: s.querySelector('.bd-sheet-t').textContent, kind: s.querySelector('.bd-sheet-k').textContent, buttons: [...s.querySelectorAll('button')].map((b) => b.textContent.trim()), rect: (({ top, bottom, width }) => ({ top, bottom, width }))(s.getBoundingClientRect()) } : null
})
const type = async (page, text) => { await page.fill('.bd-text', text) }
const cardTexts = (v) => v.cards.map((c) => c.text)

const browser = await chromium.launch({ headless: true })
try {
  // ── Phone, 360x740 ───────────────────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-a', 1); await settle(page)
    let v = await view(page)
    check(!v.shown, 'phone: no board panel on an ordinary slide')
    await live(page, 'slide-board', 2); await settle(page, 300)
    // The board arrives after the presenter opens it: seed some cards, one group.
    await page.evaluate(() => {
      const s = window.__srv
      const a = s.seed('keep', 'More time for hands-on'), b = s.seed('keep', 'Hands-on time please'), c = s.seed('keep', 'Small tables for discussion')
      s.seed('change', 'Shorter breaks'); s.seed('try', 'Try pair work')
      s.group(1, 'keep', [a, b])
    })
    await settle(page)
    v = await view(page)
    check(v.shown && /phone-detail-mode/.test(v.body) && /has-bd-bar/.test(v.body), `phone: the board panel is up on a board slide (${v.body})`)
    check(JSON.stringify(v.tabs) === JSON.stringify([{ label: 'Keep', n: '3', on: true }, { label: 'Change', n: '1', on: false }, { label: 'Try', n: '1', on: false }]), `phone: a tab per column with its count (${JSON.stringify(v.tabs)})`)
    check(/One idea per card/.test(v.instructions) && /More time to try things ourselves/.test(v.example), `phone: the instructions and the example line sit above the tabs (${v.instructions} | ${v.example})`)
    check(v.placeholder === 'What worked for you?', `phone: the column's hint is the box's placeholder (${v.placeholder})`)
    check(v.to === 'Your card goes to Keep. No name is shown.', `phone: says where the card goes and that no name is shown (${v.to})`)
    check(v.cardsLeft === '5 cards left', `phone: says how many cards are left (${v.cardsLeft})`)
    check(!v.rxDock, 'phone: the reaction bar is hidden on a board slide')
    check(v.askShown && /Not a card\? Ask the speaker a question/.test(v.askText), `phone: Ask stays as a link under the box (${v.askText})`)
    check(v.sendDisabled === true, 'phone: Send waits for some text')
    check(JSON.stringify(cardTexts(v)) === JSON.stringify(['More time for hands-on', 'Small tables for discussion']) || v.cards[0].group === '1', `phone: the column lists a group first (${JSON.stringify(v.cards)})`)
    check(v.cards[0].group === '1' && v.cards[0].x === '×2', `phone: the group shows its number and count (${JSON.stringify(v.cards[0])})`)
    check(v.readHead.startsWith('Keep') && /3 cards/.test(v.readHead), `phone: the column's heading and count (${v.readHead})`)
    check(v.minTarget >= 44 && v.scrollW <= v.innerW, `phone: every control at least 44px, no horizontal scroll (${v.minTarget}, ${v.scrollW}>${v.innerW})`)
    await shot(page, 'F1-a-board-360x740.png')

    // A card: typed, counted, sent.
    await type(page, 'More time to try things ourselves')
    v = await view(page)
    check(v.left === '107 left', `phone: the counter says how many characters are left (${v.left})`)
    check(v.sendDisabled === false, 'phone: Send is ready')
    await shot(page, 'F1-compose-360x740.png')
    await page.click('.bd-send'); await settle(page, 120)
    let out = await sent(page)
    check(out.length === 1 && out[0].type === 'card.add' && out[0].column === 'keep' && out[0].text === 'More time to try things ourselves' && out[0].pollId === 'poll-board' && !('name' in out[0]), `phone: the card goes out as card.add with its column and text (${JSON.stringify(out)})`)
    await settle(page, 200)
    v = await view(page)
    check(/^Sent to Keep\. It is on the screen now\.$/.test(v.note), `phone: says sent (${v.note})`)
    const mine = v.cards.find((c) => c.text === 'More time to try things ourselves')
    check(mine && mine.mine && /Yours/.test(mine.tag) && !mine.sending, `phone: the card is marked Yours (${JSON.stringify(mine)})`)
    check(v.text === '' && v.cardsLeft === '4 cards left', `phone: the box is empty again and 4 cards are left (${JSON.stringify(v.text)}, ${v.cardsLeft})`)
    check(v.tabs[0].n === '4', 'phone: the tab counts it')
    await shot(page, 'F2-sent-360x740.png')

    // Own card: tap -> sheet; edit -> Save/Cancel; save.
    await page.click('.bd-card.is-mine'); await settle(page)
    let sh = await sheet(page)
    check(sh && /Your card in Keep/.test(sh.kind) && sh.title === 'More time to try things ourselves' && sh.buttons.join('|') === 'Edit the wording|Withdraw it|Cancel', `phone: tapping your own card offers edit or withdraw (${JSON.stringify(sh)})`)
    check(sh && Math.abs(sh.rect.bottom - 740) <= 1 && sh.rect.width >= 359, 'phone: the menu is a sheet at the foot of the screen')
    await shot(page, 'F11-own-card-menu-360x740.png')
    await page.click('[data-act="sheet-edit"]'); await settle(page)
    v = await view(page)
    check(v.cancelShown && v.sendLabel === 'Save' && v.text === 'More time to try things ourselves' && /Editing your card in Keep/.test(v.to), `phone: editing puts the card in the box with Save and Cancel (${v.sendLabel}, ${v.to})`)
    await shot(page, 'F12-editing-own-card-360x740.png')
    await type(page, 'More time to try things ourselves, in pairs')
    await page.click('.bd-send'); await settle(page, 300)
    out = await sent(page)
    check(out.at(-1).type === 'card.edit' && out.at(-1).cardId === (await page.evaluate(() => window.__srv.cards.find((c) => c.mine).cardId)) && out.at(-1).text === 'More time to try things ourselves, in pairs', `phone: Save sends card.edit (${JSON.stringify(out.at(-1))})`)
    v = await view(page)
    check(/Saved/.test(v.note) && v.sendLabel === 'Send' && !v.cancelShown && v.text === '', `phone: the edit is confirmed and the box is back to Send (${v.note})`)
    check(cardTexts(v).includes('More time to try things ourselves, in pairs'), 'phone: the list shows the new wording')
    // Cancel an edit puts the box back.
    await page.click('.bd-card.is-mine'); await page.click('[data-act="sheet-edit"]'); await settle(page)
    await page.click('.bd-cancel'); await settle(page)
    v = await view(page)
    check(!v.cancelShown && v.text === '' && v.sendLabel === 'Send', 'phone: Cancel leaves the edit and sends nothing')
    check((await sent(page)).length === 2, 'phone: cancelling sent nothing')

    // Waiting: the next card is held back by the speaker.
    await page.evaluate(() => { window.__srv.waitingIds.add('card-' + (window.__srv.nextCard)) })
    await type(page, 'A late idea'); await page.click('.bd-send'); await settle(page, 300)
    v = await view(page)
    check(/^Sent to Keep\. It is on the board soon\.$/.test(v.note), `phone: a card the room does not see yet is "on the board soon" (${v.note})`)
    const late = v.cards.find((c) => c.text === 'A late idea')
    check(late && /on the board soon/.test(late.tag), `phone: and is tagged in the list (${late && late.tag})`)
    await page.click('.bd-card.is-mine >> text=A late idea'); await settle(page)
    await page.click('[data-act="sheet-withdraw"]'); await settle(page, 300)
    out = await sent(page)
    check(out.at(-1).type === 'card.withdraw' && out.at(-1).cardId, `phone: Withdraw sends card.withdraw (${JSON.stringify(out.at(-1))})`)
    v = await view(page)
    check(/Withdrawn/.test(v.note) && !cardTexts(v).includes('A late idea'), `phone: the card has gone from the list (${v.note})`)
    check(v.cardsLeft === '3 cards left', `phone: a withdrawn card was counted (2 used: ${v.cardsLeft})`)
    await shot(page, 'F13-a-withdrawn-360x740.png')

    // Sorted by the speaker: no longer editable.
    const myId = await page.evaluate(() => window.__srv.cards.find((c) => c.mine).cardId)
    await page.evaluate((id) => window.__srv.group(2, 'keep', [id]), myId); await settle(page)
    v = await view(page)
    const sorted = v.cards.find((c) => c.group === '2')
    check(sorted && sorted.sorted && !sorted.edit, `phone: a card sorted into a group cannot be changed (${JSON.stringify(sorted)})`)
    await page.click('.bd-card.is-group').catch(() => {}); await settle(page)
    check(!(await sheet(page)), 'phone: tapping it opens no menu')

    // Hidden by the speaker: gone, with no notice; the box still counts it.
    await page.evaluate(() => { const s = window.__srv; s.hiddenIds.add(s.cards.find((c) => c.mine).cardId); s.broadcast() }); await settle(page)
    v = await view(page)
    check(!v.cards.some((c) => c.mine), 'phone: a card the speaker hid leaves the list')
    check(v.note === '' || !/hid/i.test(v.note), 'phone: and nothing says so')
    check(v.cardsLeft === '3 cards left' || v.cardsLeft === '4 cards left', `phone: cards left kept counting it (${v.cardsLeft})`)

    // The cap: five cards and the box gives way, without saying why.
    for (const words of ['The third', 'The fourth', 'The fifth']) { await type(page, words); await page.click('.bd-send'); await settle(page, 300) }
    v = await view(page)
    check(!v.composeVisible && /You have added 5 cards/.test(v.state) && /most one phone can add/.test(v.state), `phone: at the cap the box gives way (${v.state})`)
    check(!/hid|hidden/i.test(v.state), 'phone: and does not say a card was hidden')
    await shot(page, 'F10-card-limit-360x740.png')
    check(v.askShown, 'phone: Ask is still there at the cap')
    await context.close()
  }

  // ── Phone: offline, refusals, closed, final, not following, text as text ────────────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-board', 1); await settle(page, 300)
    await page.evaluate(() => { const s = window.__srv; s.seed('keep', 'Real examples'); s.seed('change', 'Shorter breaks') }); await settle(page)
    // Length: cut at 140, "0 left".
    await type(page, 'x'.repeat(200))
    let v = await view(page)
    let out
    check(v.text.length === 140 && v.left === '0 left', `phone: typing stops at the limit (${v.text.length}, ${v.left})`)
    await shot(page, 'F9-length-limit-360x740.png')
    await page.fill('.bd-text', '👍'.repeat(140))
    v = await view(page)
    check(Array.from(v.text).length === 140 && v.left === '0 left', 'phone: an emoji counts as one character')
    await type(page, '')

    // Offline: kept on the phone, sent once on reconnect.
    await page.evaluate(() => { window.__srv.offline = true; for (const socket of window.__srv.sockets) socket.close(); window.__srv.sockets.length = 0 })
    await settle(page, 400)
    await type(page, 'Sent from a tunnel'); await page.click('.bd-send'); await settle(page, 300)
    v = await view(page)
    check(/^No connection\. Your card is saved here and sends when the phone is back online\.$/.test(v.note), `phone: offline says the card is saved here (${v.note})`)
    const waiting = v.cards.find((c) => c.text === 'Sent from a tunnel')
    check(waiting && waiting.sending && /Sending/.test(waiting.tag), `phone: the card is listed dashed, Sending… (${JSON.stringify(waiting)})`)
    check((await sent(page)).length === 0, 'phone: nothing has gone yet')
    check(v.cardsLeft === '4 cards left', `phone: the waiting card counts against the cards left (${v.cardsLeft})`)
    await shot(page, 'F8-offline-360x740.png')
    await page.evaluate(() => { window.__srv.offline = false })
    await page.waitForFunction(() => window.__srv.sent.length === 1, null, { timeout: 30000 })
    await settle(page, 400)
    out = await sent(page)
    v = await view(page)
    check(out.length === 1 && out[0].text === 'Sent from a tunnel', 'phone: on reconnect it is sent once')
    check(/^Sent to Keep/.test(v.note) && v.cards.some((c) => c.text === 'Sent from a tunnel' && c.mine && !c.sending), `phone: and then it is Yours (${v.note})`)

    // A refusal is said plainly and the text stays.
    await page.evaluate(() => { window.__srv.refuse = 'card_limit_reached' })
    await type(page, 'One too many'); await page.click('.bd-send'); await settle(page, 300)
    v = await view(page)
    check(/most cards one phone can add/.test(v.note) && /failed/.test(v.noteClass), `phone: a refusal is shown plainly (${v.note})`)
    check(v.text === 'One too many', `phone: and the text is kept (${v.text})`)
    await page.evaluate(() => { window.__srv.refuse = null })

    // Closed, then final; the box gives way, the board stays readable.
    await page.evaluate(() => { window.__srv.open = false; window.__srv.broadcast() }); await settle(page)
    v = await view(page)
    check(!v.composeVisible && /Closed to new cards/.test(v.state) && v.cards.length > 0, `phone: closed to new cards, still readable (${v.state})`)
    check(!v.cards.some((c) => c.edit), 'phone: nothing can be changed on a closed board')
    await shot(page, 'F4-closed-360x740.png')
    await page.evaluate(() => { window.__srv.open = true; window.__srv.frozen = true; window.__srv.broadcast() }); await settle(page)
    v = await view(page)
    check(!v.composeVisible && /Final board/.test(v.state), `phone: a frozen board says final (${v.state})`)
    await shot(page, 'F5-frozen-360x740.png')
    await page.evaluate(() => { window.__srv.frozen = false; window.__srv.broadcast() }); await settle(page)
    check((await view(page)).composeVisible, 'phone: reopened, the box comes back')

    // Card text is text.
    await type(page, '<img src=x onerror="window.__pwned=1"><b>bold</b>')
    await page.click('.bd-send'); await settle(page, 300)
    v = await view(page)
    check(v.cards.some((c) => c.text === '<img src=x onerror="window.__pwned=1"><b>bold</b>') && !(await page.evaluate(() => window.__pwned)) && (await page.locator('#bdPanel img, #bdPanel b.injected').count()) === 0, 'phone: card text is set as text, never markup')

    // Not following: the board bar goes.
    await page.click('#followLiveBtn').catch(() => {}); await settle(page)
    v = await view(page)
    check(!v.shown, `phone: not following, the board panel is hidden (${v.shown})`)
    await shot(page, 'F6-not-following-360x740.png')
    await context.close()
  }

  // ── Phone: a name, when the board takes names ────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await page.evaluate(() => { window.__srv.settings = { ...window.__srv.settings, names: true } })
    await live(page, 'slide-board', 1); await settle(page, 300)
    await page.evaluate(() => window.__srv.broadcast()); await settle(page)
    await page.fill('#liveName', 'Priya')
    let v = await view(page)
    check(/Only the speaker sees a name, if you give one/.test(v.to), `phone: a board that takes names says who sees one (${v.to})`)
    await type(page, 'With a name'); await page.click('.bd-send'); await settle(page, 300)
    const out = await sent(page)
    check(out.at(-1).name === 'Priya', `phone: the page's name goes with the card (${JSON.stringify(out.at(-1))})`)
    await context.close()
  }

  // ── Phone: Ask from a board slide ────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-board', 1); await settle(page, 300)
    await page.click('.bd-ask'); await settle(page)
    const opened = await page.evaluate(() => ({ panel: Boolean(document.querySelector('.ask-panel')), about: document.querySelector('.ask-about')?.textContent || '' }))
    check(opened.panel && /What should we keep, change, try\?/.test(opened.about), `phone: the Ask link opens the question box about this slide (${opened.about})`)
    await shot(page, 'F14-ask-sheet-from-board-360x740.png')
    await page.keyboard.press('Escape'); await settle(page)
    await page.evaluate(() => window.__srv.sockets.at(-1).emit({ type: 'switches.state', questionsAllowed: false, reactionsAllowed: true })); await settle(page)
    check(!(await view(page)).askShown, 'phone: with questions paused the Ask link goes')
    // Back on an ordinary slide the reaction bar returns.
    await live(page, 'slide-c', 4); await settle(page, 300)
    const back = await view(page)
    check(!back.shown && back.rxDock, `phone: on an ordinary slide the reaction bar returns (${back.shown}, ${back.rxDock})`)
    await context.close()
  }

  // ── Phone, 430x932, and a busy board: the phone lists every card ────────────────────────────
  {
    const { page, context } = await open(browser, [430, 932])
    await live(page, 'slide-board', 1); await settle(page, 300)
    await page.evaluate(() => { const s = window.__srv; for (let i = 1; i <= 61; i++) s.seed(['keep', 'change', 'try'][i % 3], 'Idea number ' + i + ' for the room to read') }); await settle(page, 300)
    await page.fill('.bd-text', 'More time to try things ourselves')
    const v = await view(page)
    check(v.shown && v.scrollW <= v.innerW && v.minTarget >= 44, `phone 430: the panel fits, every control at least 44px (${v.scrollW}>${v.innerW}, ${v.minTarget})`)
    check(v.cards.length === 20 && /20 cards/.test(v.readHead), `phone 430: a busy board lists every card of the column (${v.cards.length}, ${v.readHead})`)
    await shot(page, 'F1-compose-430x932.png')
    await page.click('.bd-tab >> text=Try'); await settle(page)
    check((await view(page)).cards.length === 20, 'phone 430: another column, its own cards')
    await context.close()
  }

  // ── A phone that joins after End live with the board kept open: no slide state, only the board ─
  {
    const { page, context } = await open(browser, [360, 740], '')
    await settle(page, 500)
    const v = await view(page)
    check(v.shown && /phone-detail-mode/.test(v.body) && v.tabs.length === 3, `late phone: with no slide state the open board is shown, on its slide (${v.body})`)
    await page.fill('.bd-text', 'Late idea'); await page.click('.bd-send'); await settle(page, 300)
    check((await sent(page)).length === 1 && /^Sent to Keep/.test((await view(page)).note), 'late phone: and a card can be added')
    await context.close()
    const laptop = await open(browser, [1440, 900], '')
    await settle(laptop.page, 500)
    check((await view(laptop.page)).shown, 'late laptop: the panel is up beside the board slide')
    await laptop.context.close()
  }

  // ── Laptop, 1440x900: the slide at the left, the panel at the right ─────────────────────────
  {
    const { page, context } = await open(browser, [1440, 900])
    await live(page, 'slide-a', 1); await settle(page)
    let v = await view(page)
    check(!v.shown && v.rxDock, `laptop: on an ordinary slide the reaction bar is up and there is no panel (${v.shown}, ${v.rxDock})`)
    await live(page, 'slide-board', 2); await settle(page, 300)
    await page.evaluate(() => {
      const s = window.__srv
      const a = s.seed('keep', 'More time for hands-on'), b = s.seed('keep', 'Hands-on time please')
      s.seed('keep', 'Small tables for discussion'); s.seed('change', 'Shorter breaks'); s.seed('try', 'Try pair work')
      s.group(1, 'keep', [a, b])
    })
    await settle(page)
    v = await view(page)
    check(v.shown && !v.rxDock, `laptop: the panel replaces the reaction bar on a board slide (${v.shown}, ${v.rxDock})`)
    check(v.panelRect && v.panelRect.width >= 395 && v.panelRect.width <= 405 && v.panelRect.left > 900 && v.stageRect.right <= v.panelRect.left + 1, `laptop: the slide is at the left and the panel at the right (${JSON.stringify(v.panelRect)} | ${JSON.stringify(v.stageRect)})`)
    check(v.head === 'What should we keep, change, try?' && /Board · slide 2/.test(v.eyebrow), `laptop: the panel is headed with the question (${v.head} | ${v.eyebrow})`)
    check(/One idea per card/.test(v.instructions) && /More time to try things ourselves/.test(v.example), 'laptop: instructions and example are in the panel')
    check(v.scrollW <= v.innerW && v.scrollH <= v.innerH + 1, `laptop: the page does not scroll (${v.scrollW}x${v.scrollH} in ${v.innerW}x${v.innerH})`)
    check(v.minTarget >= 36, `laptop: every control is at least 36px (${v.minTarget})`)
    const slideBox = await page.evaluate(() => { const r = document.querySelector('.slide.active').getBoundingClientRect(); return { w: r.width, h: r.height } })
    check(slideBox.w > 900 && Math.abs(slideBox.w / slideBox.h - 16 / 9) < 0.05, `laptop: the slide keeps 16:9 and refits (${JSON.stringify(slideBox)})`)
    await page.fill('.bd-text', 'More time to try things ourselves')
    await shot(page, 'L1-add-a-card-1440x900.png')
    // Enter sends; Shift+Enter is a new line.
    await page.press('.bd-text', 'Shift+Enter'); await page.keyboard.type('and pairs')
    v = await view(page)
    check(/\n/.test(v.text) && (await sent(page)).length === 0, 'laptop: Shift+Enter is a new line and sends nothing')
    await page.fill('.bd-text', 'More time to try things ourselves')
    await page.press('.bd-text', 'Enter'); await settle(page, 300)
    const out = await sent(page)
    check(out.length === 1 && out[0].type === 'card.add' && out[0].text === 'More time to try things ourselves', `laptop: Enter sends the card (${JSON.stringify(out)})`)
    v = await view(page)
    const mine = v.cards.find((c) => c.mine)
    check(mine && mine.edit && mine.drop && /Yours/.test(mine.tag), `laptop: your own card carries visible edit and withdraw buttons (${JSON.stringify(mine)})`)
    check(/Your cards: 1 of 5/.test(v.yours), `laptop: says how many of yours are on the board (${v.yours})`)
    check(v.minTarget >= 36, `laptop: buttons are at least 36px (${v.minTarget})`)
    await shot(page, 'L2-own-card-listed-1440x900.png')
    await page.click('.bd-card.is-mine [data-act="edit"]'); await settle(page)
    v = await view(page)
    check(v.cancelShown && v.sendLabel === 'Save' && v.text === 'More time to try things ourselves', 'laptop: the edit button puts the card in the box')
    await page.fill('.bd-text', 'More time to try things ourselves, in pairs')
    await shot(page, 'L2-editing-own-card-1440x900.png')
    await page.press('.bd-text', 'Enter'); await settle(page, 300)
    v = await view(page)
    check(/Saved/.test(v.note) && cardTexts(v).includes('More time to try things ourselves, in pairs'), 'laptop: Enter saves the edit')
    await page.click('.bd-card.is-mine [data-act="withdraw"]'); await settle(page, 300)
    v = await view(page)
    check(!v.cards.some((c) => c.mine) && (await sent(page)).at(-1).type === 'card.withdraw', 'laptop: the withdraw button withdraws the card')
    // Switching tab changes where the card goes and keeps each tab's draft.
    await page.click('.bd-tab >> text=Change'); await settle(page)
    v = await view(page)
    check(v.tabs[1].on && v.placeholder === 'What should be different?' && /goes to Change/.test(v.to), 'laptop: another tab, another hint and destination')
    await page.fill('.bd-text', 'a draft for Change')
    await page.click('.bd-tab >> text=Keep'); await settle(page)
    check((await view(page)).text === '', 'laptop: a draft belongs to its column')
    await page.click('.bd-tab >> text=Change'); await settle(page)
    check((await view(page)).text === 'a draft for Change', 'laptop: and comes back with it')
    // Ask.
    await page.click('.bd-ask'); await settle(page)
    check(await page.evaluate(() => Boolean(document.querySelector('.ask-panel'))), 'laptop: Ask opens from the panel')
    await page.keyboard.press('Escape'); await settle(page)
    // 1280 wide.
    await page.setViewportSize({ width: 1280, height: 800 }); await settle(page, 300)
    v = await view(page)
    check(v.panelRect.width >= 375 && v.panelRect.width <= 385 && v.scrollW <= 1280, `laptop: 380px panel at 1280 (${v.panelRect.width})`)
    await shot(page, 'L1-add-a-card-1280x800.png')
    await context.close()
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`audience-board-dom: ${failures.length} failure(s)`)
  for (const failure of failures) console.error('  FAIL ' + failure)
  process.exit(1)
}
console.log('audience-board-dom: all checks passed')
