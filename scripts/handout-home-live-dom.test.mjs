// The handout home page, live first (design 2026-10-02, direction B "Live takes over"). The page the QR
// code and short link open (index.html) is built by buildHandoutHomePageHtml and runs the handout's own
// live client against a stubbed live service: not live → the handout home; live → the Live tab with the
// slide the speaker is on; a poll → answered on the home page through the same vote path; a person on
// the Handout tab when a poll opens → the Live tab says so; the session ends → the handout, no reload.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildHandoutHomePageHtml } from '../compiler/scripts/lib/handout-home-page.mjs'

const slide = (id, title, body = '') => ({
  html: `<section class="slide" data-id="${id}" data-nav-title="${title}"><div class="slide-content"><h1>${title}</h1>${body}</div></section>`, notes: '',
})
const slides = [
  slide('title', 'The current state of AI agents', '<p><a href="https://handouts.example.test/k7m2" target="_blank" rel="noopener">handouts.example.test/k7m2</a></p>'),
  slide('agent', 'What makes something an agent?'),
  slide('news', 'Join MondAI for Latest News', '<p><a href="https://news.example.test/" target="_blank" rel="noopener">news</a></p>'),
  slide('agentpoll', 'Which of these would you call an agent?'),
]
const startsAt = Date.now() + 3 * 3600_000
const html = buildHandoutHomePageHtml({
  title: 'The current state of **AI agents**', slides, styles: '', slug: 'agents-2026', license: null,
  workerBaseUrl: 'https://live.example.test', liveTalkSlug: 'agents-2026',
  home: {
    url: 'https://handouts.example.test/k7m2', qr: '<svg aria-label="QR code"></svg>',
    meta: 'Tue 6 Oct 2026 · ITSS Briefing · Dominik Lukeš', startsAt,
    notLive: { today: 'Not live yet. The talk starts at 10:00.', later: 'Not live yet. The talk starts on Mon 6 Oct at 10:00.' },
  },
})
const poll = (pollId, extra = {}) => ({
  type: 'poll.state', pollId, slideId: 'agentpoll', pollType: 'single', question: 'Which of these would you call an agent?',
  options: [{ optionId: 'o1', label: 'A chatbot' }, { optionId: 'o2', label: 'A tool that does the steps' }],
  visibility: 'held', open: true, revealed: false, ...extra,
})

// The live service: discovery answers from window.__live; the socket is recorded so the test can push.
function stub() {
  window.__liveSockets = []
  window.__live = window.__live ?? false
  window.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '20' }) }
    return { ok: true, status: 200, json: async () => (window.__live ? { live: true, sessionId: 'session-1', protocol: 2 } : { live: false }) }
  }
  window.WebSocket = class {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) {
      this.url = url
      window.__liveSockets.push(this)
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 6e6 }) })
    }
    send(raw) {
      const m = JSON.parse(raw)
      this.sent.push(m)
      if (m.type === 'session.ping') this.emit({ type: 'session.pong', nonce: m.nonce })
      if (m.type === 'session.sync') queueMicrotask(() => this.emit({ type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: m.syncId, expiresAt: Date.now() + 6e6, slideState: null, polls: [], receipts: [] }))
      if (m.type === 'card.add') queueMicrotask(() => this.emit({ type: 'card.ack', submissionId: m.submissionId, pollId: m.pollId, status: 'confirmed', cardId: 'card-x', cardsUsed: 1 }))
      if (m.type === 'vote.submit') queueMicrotask(() => this.emit({ type: 'vote.ack', submissionId: m.submissionId, pollId: m.pollId, status: 'confirmed', choice: m.choice }))
    }
    close() { this.readyState = 3 }
    emit(m) { this.onmessage?.({ data: JSON.stringify(m) }) }
  }
}
const boardPoll = (pollId, extra = {}) => ({
  type: 'poll.state', pollId, slideId: 'agentpoll', pollType: 'board', question: 'What should we keep, change, try?',
  options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }],
  visibility: 'live', open: true, revealed: false,
  board: { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7, instructions: 'Add one idea per card.', example: 'More time to try things', hints: {} },
  boardState: { frozen: false, limit: 24, release: { extra: 0, all: false, groupsOnly: false, columns: {} }, cards: [], groups: [],
    columns: [{ columnId: 'keep', onScreen: [], waiting: 0, cards: 0 }, { columnId: 'change', onScreen: [], waiting: 0, cards: 0 }], entries: 0, shown: 0, waiting: 0, cardCount: 0 },
  ...extra,
})
const emit = (page, message) => page.evaluate((m) => window.__liveSockets.at(-1).emit(m), message)

const dir = await mkdtemp(join(tmpdir(), 'tw-handout-home-'))
const browser = await chromium.launch({ headless: true })
try {
  const path = join(dir, 'index.html')
  await writeFile(path, html)

  // 1. Not live: the handout home, as today, with the quiet line about the planned start.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.addInitScript(stub)
    await page.goto(pathToFileURL(path).href)
    await page.waitForTimeout(300)
    assert.equal(await page.locator('#hhHandout').isVisible(), true, 'not live: the handout home shows')
    assert.equal(await page.locator('#hhTabs').isVisible(), false, 'not live: no Live | Handout switch')
    assert.equal(await page.locator('#hhLive').isVisible(), false)
    assert.equal(await page.locator('.hh-home h1').innerHTML(), 'The current state of <strong>AI agents</strong>')
    assert.equal(await page.locator('.hh-meta').textContent(), 'Tue 6 Oct 2026 · ITSS Briefing · Dominik Lukeš')
    assert.equal(await page.locator('a.hh-btn.primary').getAttribute('href'), 'agents-2026.html', 'Open slides opens the slides view')
    assert.equal(await page.locator('a.hh-btn[download]').getAttribute('download'), 'agents-2026.html')
    assert.equal(await page.locator('#hhNotLive').isVisible(), true, 'a planned start ahead: the quiet line shows')
    assert.match(await page.locator('#hhNotLive').textContent(), /Not live yet\. The talk starts (at|on)/)
    const links = await page.locator('.hh-card a.hh-row').evaluateAll((rows) => rows.map((row) => [row.textContent.replace('›', '').trim(), row.getAttribute('href')]))
    assert.deepEqual(links, [['Join MondAI for Latest News', 'https://news.example.test/']], 'links from the talk, never the page\'s own address')
    assert.equal(await page.locator('.hh-share b').textContent(), 'handouts.example.test/k7m2')
    assert.equal(await page.locator('.share-shell').isVisible(), false, 'the slides view chrome is not on the home page')
    await page.locator('.hh-actions [data-hh-my-notes]').click()
    await page.waitForFunction(() => document.getElementById('myNotesPanel').classList.contains('open'))
    await page.close()
  }

  // 2–5. Live, at phone width: Live tab → poll answered on the home page → Handout tab + a new poll → session ends.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.addInitScript(() => { window.__live = true })
    await page.addInitScript(stub)
    await page.goto(pathToFileURL(path).href)
    await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    await page.evaluate(() => { window.__sameDocument = 'yes' })
    assert.equal(await page.locator('#hhTabs').isVisible(), true, 'live: the switch shows')
    assert.equal(await page.locator('#hhTabLive').getAttribute('aria-selected'), 'true', 'live: the page opens on Live')
    assert.equal(await page.locator('#hhHandout').isVisible(), false)
    assert.equal(await page.locator('#hhNotLive').isVisible(), false, 'live: no "not live yet" line')

    await emit(page, { type: 'slide.state', slideId: 'agent', reveal: 0, focus: null, revision: 1 })
    await page.locator('#hhLive .slide.active[data-id="agent"]').waitFor()
    assert.equal(await page.locator('#hhSlideNum').textContent(), 'Slide 2 of 4 · follows the speaker')
    assert.equal(await page.locator('#hhSlideTitle').textContent(), 'What makes something an agent?')
    const stageBox = await page.locator('#hhLive #stageFit').boundingBox()
    assert.ok(stageBox && stageBox.width > 300 && stageBox.height > 150, 'the current slide is drawn on the Live tab')
    await page.locator('#hhLive #rxDock').waitFor({ state: 'visible' })
    assert.ok(await page.locator('#hhLive .rx-ask').isVisible(), 'Ask is on the Live tab')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'agent', 'the home page follows the speaker; keys do not move it')

    // A poll opens: answered in place on the Live tab, through the same vote path as the slides view.
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 2 })
    await emit(page, poll('poll-1'))
    const card = page.locator('#hhLive #audiencePollSurface .poll-card')
    await card.waitFor({ state: 'visible' })
    await card.getByText('A tool that does the steps', { exact: true }).click()
    await card.locator('.poll-submit').click()
    await page.waitForFunction(() => window.__liveSockets.at(-1).sent.some((m) => m.type === 'vote.submit' && m.pollId === 'poll-1' && m.choice === 'o2'))
    await page.waitForFunction(() => localStorage.getItem('talkweaver:poll-vote:session-1:poll-1') === '"o2"')

    // The person switches to Handout; a new poll opens: they stay on Handout and the Live tab says so.
    await page.locator('#hhTabHandout').click()
    assert.equal(await page.locator('#hhHandout').isVisible(), true)
    assert.equal(await page.locator('#hhPollBadge').isVisible(), false, 'no badge for a poll already answered')
    await emit(page, poll('poll-2', { question: 'And now?' }))
    await page.locator('#hhPollBadge').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#hhPollBadge').textContent(), 'Poll open — answer')
    assert.equal(await page.locator('#hhTabHandout').getAttribute('aria-selected'), 'true', 'a poll does not pull the person off Handout')
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 3 })
    assert.equal(await page.locator('#hhHandout').isVisible(), true, 'the speaker moving does not pull them off Handout either')
    await page.locator('#hhTabLive').click()
    await page.locator('#hhLive #audiencePollSurface .poll-card').getByText('And now?').waitFor()
    assert.equal(await page.locator('#hhPollBadge').isVisible(), false, 'on Live the badge goes')

    // The session ends: the page is the handout again, in the same document.
    await page.evaluate(() => { window.__live = false })
    await emit(page, { type: 'session.closed' })
    await page.locator('#hhHandout').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#hhTabs').isVisible(), false, 'ended: the switch goes')
    assert.equal(await page.locator('#hhLive').isVisible(), false)
    assert.equal(await page.evaluate(() => window.__sameDocument), 'yes', 'no reload')
    await page.close()
  }

  // Boards and instant slides, phone then laptop: the board is on the Live tab and takes a card; an instant
  // slide waits behind the Handout tab with a badge and comes up on return to Live.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport })
    await page.addInitScript(() => { window.__live = true })
    await page.addInitScript(stub)
    await page.goto(pathToFileURL(path).href)
    await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 1 })
    await emit(page, boardPoll('board-1'))
    const panel = page.locator('#hhLive #bdPanel')
    await panel.waitFor({ state: 'visible' })
    const box = await panel.boundingBox()
    assert.ok(box && box.width > 250 && box.height > 120, 'the board is drawn on the Live tab ' + JSON.stringify(box))
    await page.fill('#hhLive .bd-text', 'More time to try things ourselves')
    await page.click('#hhLive .bd-send')
    await page.waitForFunction(() => window.__liveSockets.at(-1).sent.some((m) => m.type === 'card.add' && m.pollId === 'board-1' && m.text === 'More time to try things ourselves'))
    const withCard = boardPoll('board-1')
    withCard.boardState = { ...withCard.boardState, cardCount: 1, entries: 1, shown: 1, cards: [{ cardId: 'card-x', column: 'keep', text: 'More time to try things ourselves', acceptedAt: 100 }],
      columns: [{ columnId: 'keep', onScreen: [{ cardId: 'card-x' }], waiting: 0, cards: 1 }, { columnId: 'change', onScreen: [], waiting: 0, cards: 0 }] }
    await emit(page, withCard)
    await page.locator('#hhLive .bd-card').getByText('More time to try things ourselves').waitFor()

    // On Handout: the Live tab badge says the board is open.
    await page.locator('#hhTabHandout').click()
    await page.locator('#hhPollBadge').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#hhPollBadge').textContent(), 'Board open \u2014 add a card')
    await page.locator('#hhTabLive').click()

    // Instant slide while on Live: the overlay covers the page, as before.
    const instant = { kind: 'text', text: 'Back at 11:15', shownAt: 1 }
    await emit(page, { type: 'instant.state', slide: instant })
    await page.locator('.instant-slide-surface').waitFor({ state: 'visible' })
    await emit(page, { type: 'instant.state', slide: null })
    await page.waitForFunction(() => document.querySelector('.instant-slide-surface')?.hidden !== false)
    await emit(page, boardPoll('board-1', { open: false, boardState: { ...boardPoll('x').boardState, frozen: true } }))

    // On Handout: no overlay, a badge; back on Live the slide is there.
    await page.locator('#hhTabHandout').click()
    await emit(page, { type: 'instant.state', slide: instant })
    await page.waitForFunction(() => document.getElementById('hhPollBadge').textContent === 'New on screen' && !document.getElementById('hhPollBadge').hidden)
    assert.equal(await page.locator('.instant-slide-surface').isVisible().catch(() => false), false, 'on Handout there is no instant overlay')
    assert.equal(await page.locator('#hhHandout').isVisible(), true)
    await page.locator('#hhTabLive').click()
    await page.locator('.instant-slide-surface').waitFor({ state: 'visible' })
    assert.match(await page.locator('.instant-slide-surface').textContent(), /Back at 11:15/)
    await page.close()
  }

  // Laptop: the poll sits in the panel beside the slide (the drawing's two columns).
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => { window.__live = true })
    await page.addInitScript(stub)
    await page.goto(pathToFileURL(path).href)
    await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    await page.locator('#hhLive .hh-idle').getByText('Nothing to answer right now').waitFor()
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 1 })
    await emit(page, poll('poll-3'))
    await page.locator('#hhLive .poll-card').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#hhLive .hh-idle').isVisible(), false)
    const slideBox = await page.locator('#hhLive #stageFit').boundingBox()
    const pollBox = await page.locator('#hhLive .poll-card').boundingBox()
    assert.ok(pollBox.x > slideBox.x + slideBox.width, 'the poll is beside the slide ' + JSON.stringify([slideBox, pollBox]))
    assert.ok(await page.locator('#hhTabs [data-hh-my-notes]').isVisible(), 'laptop: My Notes sits with the tabs')
    await page.close()
  }
  console.log('PASS handout home live: not live → handout; live → Live tab with the current slide; poll answered on the home page; Handout tab badge; session end → handout without reload')
} finally {
  await browser.close()
  await rm(dir, { recursive: true, force: true })
}
