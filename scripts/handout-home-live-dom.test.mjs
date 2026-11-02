// The handout home page (locked design 2026-10-07, "Handout 4b"). The page the QR code and short link open
// (index.html) is built by buildHandoutHomePageHtml and runs the handout's own live client against a
// stubbed live service. One page, three layouts: before the talk (a planned start ahead, or pre-work and
// no start time); live (no Live | Handout switch: the speaker's slide, the poll answered in place, the
// reaction tiles, Note, Ask); the handout (everything else, and always after a session ends, no reload).
// Fix round 2026-10-09: the page scrolls at every width; the reactions sit straight under the slide and stay
// with a board open; one column up to 1200px; the slide goes full screen; the person steps back and forward
// and returns to the speaker's slide, and a talk with live_look_ahead: false keeps them from stepping past it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
// The deck's own base stylesheet, as a published page carries it (it locks the body's scrolling for the slides view).
const baseCss = readFileSync(new URL('../compiler/assets/styles/base.css', import.meta.url), 'utf8')
const common = {
  title: 'The current state of **AI agents**', slides, styles: baseCss, slug: 'agents-2026', license: null,
  workerBaseUrl: 'https://live.example.test', liveTalkSlug: 'agents-2026',
}
// What handoutHomeDetails gives the publishers for a planned Run (scripts/test-handout-home-details.mjs).
const details = { day: 'Tue 6 Oct', date: 'Tue 6 Oct 2026', startTime: '10:00', event: 'ITSS Briefing', author: 'Dominik Lukeš', subtitle: 'What changed this year', affiliation: 'University of Oxford' }
const share = { url: 'https://handouts.example.test/k7m2', qr: '<svg aria-label="QR code"></svg>' }
const prework = { label: 'Get ready', detail: '15 min', minutes: 15, steps: [{ label: 'Try one agent', minutes: 10, kind: 'task' }, { label: 'Read: what an agent is', minutes: 5, kind: 'slide' }, { label: 'One question for you', minutes: null, kind: 'question' }] }
const pages = {
  // A planned start three hours ahead, no pre-work.
  planned: buildHandoutHomePageHtml({ ...common, home: { ...share, ...details, startsAt: Date.now() + 3 * 3600_000 } }),
  // Pre-work and no start time.
  prework: buildHandoutHomePageHtml({ ...common, home: { ...share, ...details, startTime: '', startsAt: null, prework } }),
  // Pre-work, and a planned start that has passed.
  past: buildHandoutHomePageHtml({ ...common, home: { ...share, ...details, startsAt: Date.now() - 3 * 3600_000, prework } }),
  // A talk published on its own: no Run, no pre-work.
  plain: buildHandoutHomePageHtml({ ...common, home: { ...share, event: 'ITSS Briefing', author: 'Dominik Lukeš' } }),
  // The same with live_look_ahead: false (handoutHomeDetails gives lookAhead: false).
  noahead: buildHandoutHomePageHtml({ ...common, home: { ...share, event: 'ITSS Briefing', author: 'Dominik Lukeš', lookAhead: false } }),
}
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
      if (m.type === 'reaction.send') queueMicrotask(() => this.emit({ type: 'reaction.ack', submissionId: m.submissionId, status: 'confirmed' }))
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

const layoutOf = (page) => page.evaluate(() => document.getElementById('handoutHome').dataset.layout)
const untilLayout = (page, want) => page.waitForFunction((w) => document.getElementById('handoutHome').dataset.layout === w, want)
// Every control a person can press in the layout that shows is at least 44px tall.
async function assertTapTargets(page, label) {
  const small = await page.evaluate(() => Array.from(document.querySelectorAll('#handoutHome a, #handoutHome button'))
    .filter((el) => el.getClientRects().length && !el.closest('.slide'))
    .map((el) => [el.textContent.trim().slice(0, 30), Math.round(el.getBoundingClientRect().height)])
    .filter(([, height]) => height < 44))
  assert.deepEqual(small, [], label + ': no tap target under 44px')
}
// Nothing on the page is a serif face, and nothing the design leaves for later is drawn.
async function assertPlainPage(page, label) {
  const fonts = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('#handoutHome *')).filter((el) => el.getClientRects().length && !el.closest('.slide')).map((el) => getComputedStyle(el).fontFamily))))
  assert.deepEqual(fonts.filter((font) => /georgia|serif/i.test(font.replace(/sans-serif/gi, ''))), [], label + ': no serif type')
  const words = await page.locator('#handoutHome').innerText()
  assert.doesNotMatch(words, /Feedback|Add to calendar|About the talk|Email me|Recording|Search|Download PDF|Talk ended|Answered|Notes only|Slides only/, label + ': nothing without behaviour is drawn')
  assert.equal(await page.locator('#handoutHome [role="tablist"], #handoutHome [role="tab"], #hhTabs').count(), 0, label + ': no Live | Handout switch')
}

const dir = await mkdtemp(join(tmpdir(), 'tw-handout-home-'))
const browser = await chromium.launch({ headless: true })
try {
  const file = {}
  for (const [name, html] of Object.entries(pages)) { file[name] = pathToFileURL(join(dir, name + '.html')).href; await writeFile(join(dir, name + '.html'), html) }
  const open = async (name, viewport, { live = false, init } = {}) => {
    const page = await browser.newPage({ viewport })
    if (live) await page.addInitScript(() => { window.__live = true })
    if (init) await page.addInitScript(init)
    await page.addInitScript(stub)
    await page.goto(file[name])
    if (live) await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    else await page.waitForTimeout(300)
    return page
  }
  const phone = { width: 390, height: 844 }
  const laptop = { width: 1440, height: 900 }

  // 1. Handout (a talk on its own, not live): band, cover, links, download, share.
  {
    const page = await open('plain', phone)
    assert.equal(await layoutOf(page), 'handout', 'no start time, no pre-work, not live: the handout')
    assert.equal(await page.locator('#hhLive').isVisible(), false)
    assert.equal(await page.locator('#hhTitle').innerHTML(), 'The current state of <strong>AI agents</strong>')
    assert.equal(await page.locator('.hh-event:visible').textContent(), 'Given at ITSS Briefing')
    assert.equal(await page.locator('.hh-speaker').textContent(), 'Dominik Lukeš')
    assert.equal(await page.locator('.hh-chip:visible').count(), 0, 'no status chip on the handout')
    const main = page.locator('.hh-band-actions:visible a.hh-btn.primary')
    assert.equal((await main.textContent()).trim(), 'Open slides')
    assert.equal(await main.getAttribute('href'), 'agents-2026.html', 'Slides opens the slides view')
    assert.equal(await page.locator('#hhNotesCount').isVisible(), false, 'nothing kept: My notes has no count')
    assert.equal(await page.locator('#hhSession').isVisible(), false, 'nothing kept: no "From your session" card')
    await page.locator('#hhCoverSlot .slide.active[data-id="title"]').waitFor()
    const cover = await page.locator('#hhCoverSlot #stageFit').boundingBox()
    assert.ok(cover && cover.width > 300 && cover.height > 150, 'the cover is the first slide, drawn ' + JSON.stringify(cover))
    assert.equal(await page.locator('.hh-cover-row span').textContent(), '4 slides')
    assert.equal(await page.locator('.hh-cover-row a').getAttribute('href'), 'agents-2026.html#title', 'Start from slide 1 names the first slide')
    const links = await page.locator('#hhLinks a.hh-row').evaluateAll((rows) => rows.map((row) => [row.textContent.trim(), row.getAttribute('href')]))
    assert.deepEqual(links, [['news', 'https://news.example.test/']], 'links mentioned, never the page\'s own address')
    assert.equal((await page.locator('#hhDownload').textContent()).trim(), 'Download slides')
    assert.equal(await page.locator('#hhDownload').getAttribute('download'), 'agents-2026.html')
    assert.equal(await page.locator('.hh-share-text b').textContent(), 'handouts.example.test/k7m2')
    assert.equal(await page.locator('.share-shell').isVisible(), false, 'the slides view chrome is not on the home page')
    await assertTapTargets(page, 'handout')
    await assertPlainPage(page, 'handout')
    const size = await page.locator('.hh-row').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    assert.ok(size >= 16, 'row text is the design\'s 16px')
    await page.locator('#hhMyNotes').click()
    await page.waitForFunction(() => document.getElementById('myNotesPanel').classList.contains('open'))
    await page.close()
  }

  // 2. Before the talk: a planned start ahead (no pre-work: Slides is the main button).
  {
    const page = await open('planned', phone)
    assert.equal(await layoutOf(page), 'before', 'a planned start ahead: before the talk')
    assert.equal((await page.locator('.hh-chip:visible').textContent()).trim(), 'Tue 6 Oct, 10:00', 'the chip has the day and the start time, no room')
    assert.equal(await page.locator('.hh-event:visible').textContent(), 'ITSS Briefing', 'the event has its own line')
    assert.equal(await page.locator('.hh-sub').textContent(), 'What changed this year')
    assert.equal(await page.locator('.hh-speaker').textContent(), 'Dominik Lukeš · University of Oxford')
    const buttons = await page.locator('.hh-band-actions:visible .hh-btn').evaluateAll((els) => els.map((el) => [el.textContent.trim(), el.getAttribute('href')]))
    assert.deepEqual(buttons, [['Open slides', 'agents-2026.html']], 'no pre-work: Open slides is the one band button')
    assert.equal(await page.locator('#hhAbout').count(), 0, 'before the talk the slides are not out, so the page does not say how many there are')
    assert.ok(!/\d+\s+slides?\b/i.test(await page.locator('#handoutHome :visible').evaluateAll((els) => els.map((el) => el.children.length ? '' : el.textContent).join(' '))), 'no slide count is visible before the talk')
    assert.equal(await page.locator('#hhPrework').count(), 0)
    assert.equal(await page.locator('#hhCover').isVisible(), false, 'no cover before the talk')
    assert.equal(await page.locator('#hhLinks').isVisible(), false)
    assert.equal(await page.locator('#hhDownload').isVisible(), false)
    assert.equal(await page.locator('#hhShare').isVisible(), true)
    await assertTapTargets(page, 'before')
    await assertPlainPage(page, 'before')
    await page.close()
  }

  // Before the talk: pre-work and no start time. The steps are listed with their minutes.
  {
    const page = await open('prework', laptop)
    assert.equal(await layoutOf(page), 'before', 'pre-work and no start time: before the talk')
    assert.equal((await page.locator('.hh-chip:visible').textContent()).trim(), 'Tue 6 Oct', 'no start time: the chip has the day alone')
    const main = page.locator('.hh-band-actions:visible .hh-btn')
    assert.deepEqual(await main.evaluateAll((els) => els.map((el) => [el.textContent.trim(), el.getAttribute('href')])), [['Start the pre-work', 'agents-2026.html']], 'pre-work: it is the main button and opens the slides view, where the form is')
    assert.equal(await page.locator('#hhPrework .hh-tag').textContent(), 'About 15 min')
    const steps = await page.locator('#hhPrework a.hh-row').evaluateAll((rows) => rows.map((row) => [row.querySelector('.hh-row-text').textContent, row.querySelector('.hh-row-detail')?.textContent ?? null, row.getAttribute('href')]))
    assert.deepEqual(steps, [['Try one agent', '10 min', 'agents-2026.html'], ['Read: what an agent is', '5 min', 'agents-2026.html'], ['One question for you', null, 'agents-2026.html']])
    // Laptop: the band's button and the pre-work card are in the right-hand column.
    const titleBox = await page.locator('#hhTitle').boundingBox()
    const buttonBox = await main.boundingBox()
    const preworkBox = await page.locator('#hhPrework').boundingBox()
    assert.ok(buttonBox.x > titleBox.x + titleBox.width - 1 && preworkBox.x > titleBox.x, 'laptop: two columns ' + JSON.stringify([titleBox, buttonBox, preworkBox]))
    await page.close()
  }

  // A planned start that has passed is the handout, pre-work or not.
  {
    const page = await open('past', phone)
    assert.equal(await layoutOf(page), 'handout', 'the start has passed: the handout')
    assert.equal(await page.locator('.hh-event:visible').textContent(), 'Given at ITSS Briefing · Tue 6 Oct 2026')
    assert.equal(await page.locator('#hhPrework').isVisible(), false)
    await page.close()
  }

  // A page left open past the planned start becomes the handout without a reload.
  {
    const page = await browser.newPage({ viewport: phone })
    await page.clock.install({ time: Date.now() })
    await page.addInitScript(stub)
    await page.goto(file.planned)
    await untilLayout(page, 'before')
    await page.clock.fastForward(3 * 3600_000 + 60_000)
    await untilLayout(page, 'handout')
    await page.close()
  }

  // 3. Live, at phone width: the live layout → poll answered in place → reactions and a note → session ends → handout.
  {
    const page = await open('planned', phone, { live: true })
    await page.evaluate(() => { window.__sameDocument = 'yes' })
    assert.equal(await layoutOf(page), 'live', 'live: the live layout, whatever the planned start says')
    assert.equal(await page.locator('#hhPage').isVisible(), false, 'live: no handout below or beside the slide')
    assert.equal((await page.locator('.hh-livenow').textContent()).trim(), 'Live now')
    assert.equal(await page.locator('#hhTitle').isVisible(), true, 'live: the band keeps the title')
    assert.equal(await page.locator('.hh-band .hh-btn:visible').count(), 0, 'live: the band has no buttons')
    assert.equal(await page.locator('.hh-speaker').isVisible(), false)
    assert.match(await page.locator('#hhAnnounce').textContent(), /The talk is live/, 'going live is announced')
    await assertPlainPage(page, 'live')

    await emit(page, { type: 'slide.state', slideId: 'agent', reveal: 0, focus: null, revision: 1 })
    await page.locator('#hhLive .slide.active[data-id="agent"]').waitFor()
    assert.equal(await page.locator('#hhSlideNum').textContent(), 'Slide 2 of 4 · moves with the speaker')
    const stageBox = await page.locator('#hhLive #stageFit').boundingBox()
    assert.ok(stageBox && stageBox.width > 300 && stageBox.height > 150, 'the current slide is drawn')
    await page.locator('#hhLive #rxDock').waitFor({ state: 'visible' })
    const bar = await page.locator('#hhLive .rx').evaluateAll((els) => els.map((el) => [el.querySelector('.rx-w').textContent, el.getAttribute('aria-label')]))
    assert.deepEqual(bar, [['Puzzled', 'Puzzled by this'], ['Helped me', 'Helped me understand'], ['Bookmark', 'Bookmark: I need to return to this']], 'short labels on the tiles, the full words for a screen reader')
    assert.equal((await page.locator('#hhLive .rx-ask > span').first().textContent()).trim(), 'Ask a question')
    assert.equal((await page.locator('#hhLive .rx-notebtn .rx-w').textContent()).trim(), 'Note')
    await assertTapTargets(page, 'live')
    // Stepping (Dominik 2026-10-08): forward to see what is coming, back to catch up, one control back.
    const activeId = () => page.locator('#hhLive .slide.active').getAttribute('data-id')
    const toSpeaker = page.locator('#hhToSpeaker')
    assert.equal(await toSpeaker.isVisible(), false, 'following: no "back to the speaker" control')
    await page.keyboard.press('ArrowRight')
    assert.equal(await activeId(), 'news', 'the right arrow steps ahead of the speaker')
    assert.equal(await page.locator('#hhSlideNum').textContent(), 'Slide 3 of 4 · the speaker is on slide 2', 'the page says it is not following')
    assert.equal(await toSpeaker.isVisible(), true)
    assert.equal(await page.locator('#hhCap').evaluate((el) => el.classList.contains('hh-away')), true)
    await page.keyboard.press('ArrowLeft')
    assert.equal(await activeId(), 'agent', 'stepping back onto the speaker\'s slide')
    assert.equal(await page.locator('#hhSlideNum').textContent(), 'Slide 2 of 4 · moves with the speaker', '... follows the speaker again')
    assert.equal(await toSpeaker.isVisible(), false)
    await page.locator('#hhStepBack').click()
    assert.equal(await activeId(), 'title', 'the back button steps back')
    assert.equal(await page.locator('#hhStepBack').isDisabled(), true, 'no step back from the first slide')
    // The speaker moves on while the person is behind: the page stays where the person is.
    await emit(page, { type: 'slide.state', slideId: 'news', reveal: 0, focus: null, revision: 2 })
    await page.waitForFunction(() => document.getElementById('hhSlideNum').textContent === 'Slide 1 of 4 · the speaker is on slide 3')
    assert.equal(await activeId(), 'title')
    await toSpeaker.click()
    await page.waitForFunction(() => document.querySelector('#hhLive .slide.active')?.dataset.id === 'news')
    assert.equal(await page.locator('#hhSlideNum').textContent(), 'Slide 3 of 4 · moves with the speaker', 'one control returns to the speaker\'s slide')
    // Following again: the next slide the speaker shows is shown.
    await emit(page, { type: 'slide.state', slideId: 'agent', reveal: 0, focus: null, revision: 3 })
    await page.waitForFunction(() => document.querySelector('#hhLive .slide.active')?.dataset.id === 'agent')

    // A poll opens: answered in place, through the same vote path as the slides view.
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 4 })
    await emit(page, poll('poll-1'))
    const card = page.locator('#hhLive #audiencePollSurface .poll-card')
    await card.waitFor({ state: 'visible' })
    const order = await page.evaluate(() => ['stageFit', 'rxDock', 'audiencePollSurface'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top)))
    assert.ok(order[0] < order[1] && order[1] < order[2], 'phone: slide, then the reactions, then the poll ' + JSON.stringify(order))
    // The poll stays on the speaker's slide: a person who steps back still has it to answer.
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.locator('#hhLive .slide.active').getAttribute('data-id'), 'news')
    assert.equal(await card.isVisible(), true, 'stepped back: the poll is still there')
    // Reactions, Bookmark and Note follow the slide the person is looking at (Dominik 2026-10-09), unlike the
    // poll and the board: stepped back to slide 2 while the speaker is on slide 4, they belong to slide 2.
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.locator('#hhLive .slide.active').getAttribute('data-id'), 'agent', 'stepped back to slide 2 of 4')
    const rxSent = () => page.evaluate(() => window.__liveSockets.flatMap((s) => s.sent).filter((m) => m.type === 'reaction.send').filter((m, i, all) => all.findIndex((o) => o.submissionId === m.submissionId) === i).map((m) => [m.reaction, m.slideId, m.withdrawn === true]))
    const rxHeld = () => page.evaluate(() => ['puzzled', 'bookmark'].map((id) => document.querySelector('#hhLive .rx[data-rx="' + id + '"]').getAttribute('aria-pressed')))
    const rxStored = () => page.evaluate(() => Object.keys(localStorage).filter((k) => /reaction/i.test(k)).map((k) => localStorage.getItem(k)).join(' '))
    await page.locator('#hhLive .rx[data-rx="puzzled"]').click()
    await page.locator('#hhLive .rx[data-rx="bookmark"]').click()
    await page.waitForFunction(() => window.__liveSockets.flatMap((s) => s.sent).some((m) => m.reaction === 'bookmark'))
    assert.deepEqual(await rxSent(), [['puzzled', 'agent', false], ['bookmark', 'agent', false]], 'the taps are sent against the slide on screen, not the speaker\'s')
    assert.match(await rxStored(), /"agent"/, 'the stored marks are on the viewed slide')
    assert.doesNotMatch(await rxStored(), /"agentpoll"/, 'nothing is stored against the speaker\'s slide')
    assert.deepEqual(await rxHeld(), ['true', 'true'], 'the bar holds both on the viewed slide')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('#hhLive .slide.active').getAttribute('data-id'), 'news')
    assert.deepEqual(await rxHeld(), ['false', 'false'], 'stepping to another slide: the bar shows that slide\'s marks')
    await page.keyboard.press('ArrowLeft')
    assert.deepEqual(await rxHeld(), ['true', 'true'], 'stepping back: the held marks return')
    // Note: the sheet writes the note to the slide on screen.
    await page.locator('#hhLive .rx-notebtn').click()
    await page.locator('.ask-panel .ask-text').fill('Note on slide two')
    await page.locator('.ask-panel .ask-send').click()
    await page.locator('.ask-panel').waitFor({ state: 'detached' })
    const noteOn = await page.evaluate(() => JSON.parse(localStorage.getItem('html-presentations:notes:agents-2026') || '[]'))
    assert.deepEqual(noteOn.filter((n) => /Note on slide two/.test(JSON.stringify(n))).map((n) => n.slideId), ['agent'], 'the note is on the viewed slide')
    await page.locator('#hhToSpeaker').click()
    await page.waitForFunction(() => document.querySelector('#hhLive .slide.active')?.dataset.id === 'agentpoll')
    assert.equal(await card.locator('.poll-dismiss').isVisible().catch(() => false), false, 'the poll sits in the page: nothing to dismiss')
    await page.locator('#hhLive .rx[data-rx="helped"]').click()
    await page.waitForFunction(() => window.__liveSockets.flatMap((s) => s.sent).some((m) => m.reaction === 'helped'))
    assert.equal(await page.evaluate(() => window.__liveSockets.flatMap((s) => s.sent).find((m) => m.reaction === 'helped').slideId), 'agentpoll', 'back on the speaker\'s slide a tap goes to slide 4')
    assert.deepEqual(await rxHeld(), ['false', 'false'], 'back on the speaker\'s slide the bar shows its own marks')
    await card.getByText('A tool that does the steps', { exact: true }).click()
    await card.locator('.poll-submit').click()
    await page.waitForFunction(() => window.__liveSockets.at(-1).sent.some((m) => m.type === 'vote.submit' && m.pollId === 'poll-1' && m.choice === 'o2'))
    await page.waitForFunction(() => localStorage.getItem('talkweaver:poll-vote:session-1:poll-1') === '"o2"')
    // A second poll takes its place, with no switch to find it behind.
    await emit(page, poll('poll-2', { question: 'And now?' }))
    await page.locator('#hhLive #audiencePollSurface .poll-card').getByText('And now?').waitFor()
    await emit(page, poll('poll-2', { question: 'And now?', open: false }))

    // The person bookmarks this slide and writes a note on it.
    await page.locator('#hhLive .rx[data-rx="bookmark"]').click()
    await page.waitForFunction(() => document.querySelector('#hhLive .rx[data-rx="bookmark"]').getAttribute('aria-pressed') === 'true')
    await page.locator('#hhLive .rx-notebtn').click()
    await page.locator('.ask-panel .ask-text').fill('Look this up')
    await page.locator('.ask-panel .ask-send').click()
    await page.locator('.ask-panel').waitFor({ state: 'detached' })

    // The session ends: the page is the handout, in the same document, with what the person kept.
    await page.evaluate(() => { window.__live = false })
    await emit(page, { type: 'session.closed' })
    await untilLayout(page, 'handout')
    assert.equal(await page.locator('#hhLive').isVisible(), false)
    assert.equal(await page.evaluate(() => window.__sameDocument), 'yes', 'no reload')
    assert.match(await page.locator('#hhAnnounce').textContent(), /The live session has ended/, 'the end is announced')
    await page.locator('#hhCoverSlot .slide.active[data-id="title"]').waitFor()
    assert.equal(await page.locator('.hh-event:visible').textContent(), 'Given at ITSS Briefing · Tue 6 Oct 2026', 'a session this page saw has ended: the handout, though the planned start is still ahead')
    assert.equal(await page.locator('#hhNotesCount').textContent(), '2', 'My notes counts the slides with something kept')
    const rows = await page.locator('#hhSession .hh-row:visible').evaluateAll((els) => els.map((el) => [el.querySelector('.hh-row-text').textContent, el.querySelector('[data-hh-count]').textContent]))
    assert.deepEqual(rows, [['Your notes', '2 slides'], ['Bookmarked slides', '2']], 'From your session: the rows with something in them')
    await assertTapTargets(page, 'handout after a session')
    await page.locator('#hhSession .hh-row:visible').first().click()
    await page.waitForFunction(() => document.getElementById('myNotesPanel').classList.contains('open'))
    assert.match(await page.locator('#myNotesPanel').innerText(), /Look this up/)
    await page.close()
  }

  // "From your session" counts what the device holds: notes by slide, bookmarks, questions.
  {
    const page = await open('plain', laptop, { init: () => {
      localStorage.setItem('html-presentations:questions:agents-2026', JSON.stringify({ v: 1, items: [{ slideId: 'agent', text: 'Why?', submissionId: 'q1' }, { slideId: 'news', text: 'And then?', submissionId: 'q2' }] }))
      localStorage.setItem('html-presentations:notes:agents-2026', JSON.stringify([
        { id: 'n1', type: 'slide', slideId: 'agent', slideIndex: 1, note: 'one', createdAt: '2026-10-06T10:00:00Z' },
        { id: 'n2', type: 'slide', slideId: 'agent', slideIndex: 1, note: 'two', createdAt: '2026-10-06T10:01:00Z' },
        { id: 'n3', type: 'slide', slideId: 'agentpoll', slideIndex: 3, note: 'three', createdAt: '2026-10-06T10:02:00Z' },
      ]))
    } })
    await page.locator('#hhSession').waitFor({ state: 'visible' })
    const rows = await page.locator('#hhSession .hh-row:visible').evaluateAll((els) => els.map((el) => [el.querySelector('.hh-row-text').textContent, el.querySelector('[data-hh-count]').textContent]))
    assert.deepEqual(rows, [['Your notes', '2 slides'], ['Your questions', '2']], 'three notes on two slides, no bookmark, two questions')
    assert.equal(await page.locator('#hhNotesCount').textContent(), '3', 'three slides hold something')
    // Laptop: cover and links on the left, the rest in the right-hand column.
    const box = async (id) => page.locator(id).boundingBox()
    const [cover, links, session, download, shareBox] = [await box('#hhCover'), await box('#hhLinks'), await box('#hhSession'), await box('#hhDownload'), await box('#hhShare')]
    assert.ok(links.x === cover.x && links.y > cover.y, 'links under the cover')
    assert.ok(session.x > cover.x + cover.width && download.x === session.x && shareBox.x === session.x && session.y < download.y && download.y < shareBox.y, 'session, download and share stacked on the right ' + JSON.stringify([cover, session, download, shareBox]))
    await page.close()
  }

  // Boards and instant slides, phone then laptop, as on the old Live tab: the board takes a card; an instant
  // slide covers the page while it is up.
  for (const viewport of [phone, laptop]) {
    const viewportWide = () => viewport.width >= 1200
    const page = await open('plain', viewport, { live: true })
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 1 })
    await emit(page, boardPoll('board-1'))
    const panel = page.locator('#hhLive #bdPanel')
    await panel.waitFor({ state: 'visible' })
    const box = await panel.boundingBox()
    assert.ok(box && box.width > 250 && box.height > 120, 'the board is drawn in the live layout ' + JSON.stringify(box))
    // The reactions, Note and Ask stay while the board is open (Dominik 2026-10-08), straight under the slide.
    await page.locator('#hhLive #rxDock').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#hhLive .rx-notebtn').isVisible(), true, 'board open: Note is still there')
    assert.equal(await page.locator('#hhLive .rx-ask').isVisible(), true, 'board open: Ask is still there')
    const [slideTop, barTop, boardTop] = await page.evaluate(() => ['stageFit', 'rxDock', 'bdPanel'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().top)))
    assert.ok(slideTop < barTop && (viewportWide() ? boardTop < barTop : barTop < boardTop), 'the bar is under the slide; the board below it, or beside the slide on a wide window')
    // Stepped back, the board is still the speaker's slide's.
    await page.locator('#hhStepBack').click()
    assert.notEqual(await page.locator('#hhLive .slide.active').getAttribute('data-id'), 'agentpoll')
    assert.equal(await panel.isVisible(), true, 'stepped back: the board stays')
    await page.locator('#hhToSpeaker').click()
    await page.waitForFunction(() => document.querySelector('#hhLive .slide.active')?.dataset.id === 'agentpoll')
    await page.fill('#hhLive .bd-text', 'More time to try things ourselves')
    await page.click('#hhLive .bd-send')
    await page.waitForFunction(() => window.__liveSockets.at(-1).sent.some((m) => m.type === 'card.add' && m.pollId === 'board-1' && m.text === 'More time to try things ourselves'))
    const withCard = boardPoll('board-1')
    withCard.boardState = { ...withCard.boardState, cardCount: 1, entries: 1, shown: 1, cards: [{ cardId: 'card-x', column: 'keep', text: 'More time to try things ourselves', acceptedAt: 100 }],
      columns: [{ columnId: 'keep', onScreen: [{ cardId: 'card-x' }], waiting: 0, cards: 1 }, { columnId: 'change', onScreen: [], waiting: 0, cards: 0 }] }
    await emit(page, withCard)
    await page.locator('#hhLive .bd-card').getByText('More time to try things ourselves').waitFor()

    const instant = { kind: 'text', text: 'Back at 11:15', shownAt: 1 }
    await emit(page, { type: 'instant.state', slide: instant })
    await page.locator('.instant-slide-surface').waitFor({ state: 'visible' })
    assert.match(await page.locator('.instant-slide-surface').textContent(), /Back at 11:15/)
    await emit(page, { type: 'instant.state', slide: null })
    await page.waitForFunction(() => document.querySelector('.instant-slide-surface')?.hidden !== false)
    await page.close()
  }

  // Laptop, live: the slide on the left with its title, the poll and the reactions in the right-hand column.
  {
    const page = await open('plain', laptop, { live: true })
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 1 })
    await page.locator('#hhLive #rxDock').waitFor({ state: 'visible' })
    assert.equal(await page.locator('#hhSlideTitle').textContent(), 'Which of these would you call an agent?')
    assert.equal(await page.locator('#hhSlideTitle').isVisible(), true, 'laptop: the slide\'s title is under it')
    await emit(page, poll('poll-3'))
    await page.locator('#hhLive .poll-card').waitFor({ state: 'visible' })
    const slideBox = await page.locator('#hhLive #stageFit').boundingBox()
    const pollBox = await page.locator('#hhLive .poll-card').boundingBox()
    const barBox = await page.locator('#hhLive #rxDock').boundingBox()
    assert.ok(pollBox.x > slideBox.x + slideBox.width, 'the poll is beside the slide ' + JSON.stringify([slideBox, pollBox]))
    assert.ok(Math.abs(barBox.x - slideBox.x) < 2 && barBox.y > slideBox.y + slideBox.height && barBox.y < slideBox.y + slideBox.height + 90 && barBox.x + barBox.width <= slideBox.x + slideBox.width + 2, 'the reactions are straight under the slide, not under the poll ' + JSON.stringify([slideBox, barBox]))
    // Note is offered on a laptop too, and saves a note.
    await page.locator('#hhLive .rx-notebtn').click()
    await page.locator('.ask-panel .ask-text').fill('From the laptop')
    await page.locator('.ask-panel .ask-send').click()
    await page.locator('.ask-panel').waitFor({ state: 'detached' })
    await page.waitForFunction(() => /From the laptop/.test(localStorage.getItem('html-presentations:notes:agents-2026') || ''))
    await assertTapTargets(page, 'live on a laptop')
    // Everything in the live layout is reachable by keyboard, with a visible focus ring.
    await page.locator('#hhLive .rx[data-rx="puzzled"]').focus()
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return [el.getAttribute('data-rx'), cs.outlineStyle, parseFloat(cs.outlineWidth)] })
    assert.deepEqual(ring, ['helped', 'solid', 3], 'Tab moves along the tiles and the focus ring shows')
    await page.close()
  }
  // One column up to 1200px: at 1100 the poll is under the slide (and the reactions between them).
  {
    const page = await open('plain', { width: 1100, height: 800 }, { live: true })
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 1 })
    await emit(page, poll('poll-4'))
    await page.locator('#hhLive .poll-card').waitFor({ state: 'visible' })
    const [slideBox, barBox, pollBox] = [await page.locator('#hhLive #stageFit').boundingBox(), await page.locator('#hhLive #rxDock').boundingBox(), await page.locator('#hhLive .poll-card').boundingBox()]
    assert.ok(barBox.y > slideBox.y + slideBox.height && pollBox.y > barBox.y + barBox.height, '1100px: one column, slide, reactions, poll ' + JSON.stringify([slideBox, barBox, pollBox]))
    assert.ok(slideBox.width > 800, '1100px: the slide takes the column ' + JSON.stringify(slideBox))
    assert.equal(await page.locator('#hhSlideTitle').isVisible(), false, 'one column: no title repeated under the slide')

    // Full screen: the slide fills the window; Esc and the same control leave it.
    await page.locator('#hhFull').click()
    await page.waitForFunction(() => document.getElementById('hhSlideBox').classList.contains('hh-full'))
    const fullBox = await page.locator('#hhSlideBox').boundingBox()
    assert.deepEqual([fullBox.x, fullBox.y, fullBox.width, fullBox.height], [0, 0, 1100, 800], 'full screen covers the window')
    const fullSlide = await page.locator('#hhLive .stage').boundingBox()
    assert.ok(fullSlide.width > 1000, 'the slide is drawn at the window\'s size ' + JSON.stringify(fullSlide))
    assert.equal((await page.locator('#hhFullWord').textContent()).trim(), 'Exit full screen', 'a visible control leaves it')
    assert.equal(await page.locator('#hhFull').getAttribute('aria-pressed'), 'true')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.getElementById('hhSlideBox').classList.contains('hh-full'))
    assert.equal((await page.locator('#hhFullWord').textContent()).trim(), 'Full screen')
    await page.locator('#hhFull').click()
    await page.locator('#hhFull').click()
    assert.equal(await page.locator('#hhSlideBox').evaluate((el) => el.classList.contains('hh-full')), false, 'the same control leaves full screen')
    // A poll that opens takes the person out of full screen, to answer it.
    await page.locator('#hhFull').click()
    await emit(page, poll('poll-4', { open: false }))
    await emit(page, { type: 'slide.state', slideId: 'news', reveal: 0, focus: null, revision: 2 })
    await page.waitForFunction(() => document.getElementById('audiencePollSurface').hidden)
    assert.equal(await page.locator('#hhSlideBox').evaluate((el) => el.classList.contains('hh-full')), true)
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 3 })
    await emit(page, poll('poll-5', { question: 'A new question' }))
    await page.waitForFunction(() => !document.getElementById('hhSlideBox').classList.contains('hh-full'))
    await page.close()
  }

  // The page scrolls with the mouse wheel at every width, and nothing is wider than the window (Dominik's
  // 525px window, 2026-10-08).
  for (const width of [390, 525, 700, 900, 1100, 1300, 1400]) {
    const page = await open('plain', { width, height: 640 }, { live: true })
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 1 })
    await emit(page, boardPoll('board-2'))
    await page.locator('#hhLive #bdPanel').waitFor({ state: 'visible' })
    const [scrollWidth, scrollHeight] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight])
    assert.equal(scrollWidth, width, width + 'px: nothing wider than the window')
    assert.ok(scrollHeight > 640, width + 'px: the page is taller than the window')
    await page.mouse.move(width / 2, 300)
    await page.mouse.wheel(0, 400)
    await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 3000 }).catch(() => {})
    assert.ok(await page.evaluate(() => window.scrollY > 0), width + 'px: the mouse wheel scrolls the page')
    assert.equal(await page.evaluate(() => window.scrollX), 0, width + 'px: no sideways scroll')
    const stage = await page.locator('#hhLive #stageFit').boundingBox()
    assert.ok(stage.x >= 0 && stage.x + stage.width <= width, width + 'px: the slide is inside the window ' + JSON.stringify(stage))
    await page.close()
  }

  // A talk with live_look_ahead: false: back is allowed, never past the speaker's slide.
  {
    const page = await open('noahead', laptop, { live: true })
    await emit(page, { type: 'slide.state', slideId: 'news', reveal: 0, focus: null, revision: 1 })
    await page.locator('#hhLive .slide.active[data-id="news"]').waitFor()
    const activeId = () => page.locator('#hhLive .slide.active').getAttribute('data-id')
    assert.equal(await page.locator('#hhStepForward').isDisabled(), true, 'on the speaker\'s slide: no step forward')
    await page.keyboard.press('ArrowRight')
    assert.equal(await activeId(), 'news', 'the right arrow does not go past the speaker')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await activeId(), 'title', 'stepping back is allowed')
    assert.equal(await page.locator('#hhStepForward').isDisabled(), false, 'behind the speaker: forward is allowed')
    await page.locator('#hhStepForward').click()
    assert.equal(await activeId(), 'agent')
    // The speaker goes back past the person: the page goes back with them, and follows.
    await emit(page, { type: 'slide.state', slideId: 'title', reveal: 0, focus: null, revision: 2 })
    await page.waitForFunction(() => document.querySelector('#hhLive .slide.active')?.dataset.id === 'title')
    assert.equal(await page.locator('#hhSlideNum').textContent(), 'Slide 1 of 4 · moves with the speaker')
    assert.equal(await page.locator('#hhStepForward').isDisabled(), true)
    await page.close()
  }
  console.log('PASS handout home: handout, before the talk (start ahead / pre-work), live with no switch, poll answered in place, short reaction labels, note and bookmark counted in "From your session", session end → handout without reload, boards and instant slides, laptop columns, stepping back and forward, back to the speaker, looking ahead off, full screen, one column to 1200px, reactions under the slide and with a board, scrolling at every width')
} finally {
  await browser.close()
  await rm(dir, { recursive: true, force: true })
}
