// Ticket 04 (feedback boards, ADR-0032): the board on the big screen, the audience window and the
// presenter's own preview. Every screen renders the worker's `boardView` (the states below are made
// by the worker's own code, scripts/fixtures/board-screen-states.ts, run with bun); none recomputes
// what waits. Three layers:
//   1. the frame renderer for a board, unit level: columns, numbered groups with counts, "+ n more on
//      your phone", the three foot states, the join strip, text-only rendering;
//   2. the audience-window boundary (poll-display.js safeState): hidden cards, names and ids never
//      pass, a group shows its first visible card;
//   3. a headless render at the fixed 1280×720 canvas of 6, 24 and 40 cards (and past the limit,
//      hidden, empty, closed, frozen): no overflow, no clipped card, the slide never zooms, and the
//      card text holds BOARD_MIN_CARD_PX up to the default limit of 24 entries.
// TW_BOARD_SHOTS=<dir> saves screenshots.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { makeQrSvg } from '../compiler/scripts/lib/01-cli-utils.mjs'
import { BOARD_MIN_CARD_PX, pollFrameRuntimeSource, renderPollFrame } from '../compiler/scripts/lib/poll-frame.mjs'

const shots = process.env.TW_BOARD_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const repo = fileURLToPath(new URL('..', import.meta.url))

const OUTLINE = `---
title: Board screen probe
auto_title_slide: false
auto_thanks_slide: false
---

### What should we keep, change, try? {id=kctbd}
{poll=board}

Add what you would keep, change or try. One idea per card; no names are shown.

> Example: More time to try things ourselves

- Keep
  - What worked for you?
- Change
  - What should be different?
- Try
  - What could we do next time?
`

const scratch = await mkdtemp(join(tmpdir(), 'tw-board-screen-'))
const outlinePath = join(scratch, 'board.md')
await writeFile(outlinePath, OUTLINE)
const model = await prepareSource(outlinePath, OUTLINE, 'board', statSync(outlinePath))
const definition = model.slides.find((slide) => slide.poll).poll
const deckPath = join(scratch, 'board.html')
await writeFile(deckPath, model.fullHtml)
const definitionPath = join(scratch, 'definition.json')
await writeFile(definitionPath, JSON.stringify({ ...definition, slideId: 'kctbd' }))

const bun = spawnSync('bun', [join(repo, 'scripts/fixtures/board-screen-states.ts'), definitionPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
assert.equal(bun.status, 0, `the worker fixture builds: ${bun.stderr}`)
const STATES = JSON.parse(bun.stdout)
const join_ = { shortUrl: 'https://handouts.fyi/737u', qrSvg: makeQrSvg('https://handouts.fyi/737u') }
const columnIds = definition.options.map((option) => option.optionId)

// ── 2 (loaded first: layer 1 uses it). poll-display.js as the deck runs it ─────────────────────────
const runtime = readFileSync(new URL('../compiler/assets/runtime/poll-display.js', import.meta.url), 'utf8')
const display = vm.runInNewContext(`${pollFrameRuntimeSource()}; ${runtime}; createPollDisplay()`, { URL })
const plain = (value) => JSON.parse(JSON.stringify(value))
const text = (html) => html.replace(/<[^>]+>/g, '\u0001').split('\u0001').filter(Boolean)

// ── 1. The frame renderer for a board ───────────────────────────────────────────────────────────────
{
  const view = { open: true, frozen: false, cardCount: 5, columns: [
    { columnId: columnIds[0], count: 4, waiting: 2, entries: [{ group: 1, count: 3, text: 'More time for hands-on' }, { text: 'The pace of <b>the</b> first half' }] },
    { columnId: columnIds[1], count: 1, waiting: 0, entries: [{ text: '<img src=x onerror=alert(1)>' }] },
    { columnId: columnIds[2], count: 0, waiting: 0, entries: [] },
  ] }
  const html = renderPollFrame(definition, { live: true, state: 'open', join: join_, board: view })
  assert.match(html, /data-board-state="open"/, 'a live board frame states its foot state')
  assert.equal((html.match(/poll-frame-board-column"/g) || []).length, 3, 'one column per authored column, in order')
  assert.match(html, /<span class="poll-frame-board-count">4<\/span>/, 'a column counts every visible card, waiting ones included')
  assert.match(html, /is-group" data-group="1"><span class="poll-frame-board-num">1<\/span><p>More time for hands-on<\/p><span class="poll-frame-board-x">×3<\/span>/, 'a group is numbered and carries its count')
  assert.match(html, /<p class="poll-frame-board-more"><b>\+ 2 more<\/b> on your phone<\/p>/, 'the column with waiting cards says so')
  assert.equal((html.match(/poll-frame-board-more/g) || []).length, 1, 'a column with nothing waiting says nothing')
  assert.ok(!html.includes('<b>the</b>') && !html.includes('<img'), 'card text is text only: markup in a card is escaped')
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'and shown as typed')
  assert.match(html, /poll-frame-board-hint">What could we do next time\?/, 'an empty column keeps its hint')
  assert.ok(!html.includes('poll-frame-board-hint">What worked'), 'a column with cards drops its hint')
  assert.ok(!html.includes('is-example'), 'the example card is for an empty board only')
  assert.match(html, /poll-frame-board-qr"><svg/, 'the join QR is in the foot')
  assert.match(html, /Add a card: open the link or scan<\/span><span class="poll-frame-board-join-url">handouts\.fyi\/737u/, 'and the link beside it, without the scheme')
  assert.match(html, /Open · 5 cards/, 'the chip counts the board')
  assert.ok(!html.includes('poll-frame-join"'), 'a live board has no join column in the body')
  assert.ok(!html.includes('poll-frame-instruction'), 'nor the phone instruction line: the foot is the join strip')

  const closed = renderPollFrame(definition, { live: true, state: 'stopped', join: join_, board: { ...view, open: false } })
  assert.match(closed, /data-board-state="closed"/)
  assert.match(closed, /Closed to new cards\. Read the whole board at <b>handouts\.fyi\/737u<\/b>/)
  assert.match(closed, /Closed to new cards · 5/)
  const frozen = renderPollFrame(definition, { live: true, state: 'stopped', join: join_, board: { ...view, frozen: true } })
  assert.match(frozen, /data-board-state="frozen"/)
  assert.match(frozen, /The board as the room left it\. Slides and links: <b>handouts\.fyi\/737u<\/b>/)
  assert.match(frozen, /Final board · 5 cards/)
  assert.doesNotMatch(frozen, /poll-frame-board-qr/, 'a frozen board has no QR strip')

  const empty = renderPollFrame(definition, { live: true, state: 'open', join: join_, board: { open: true, frozen: false, cardCount: 0, columns: [] } })
  assert.match(empty, /poll-frame-board-empty/, 'an empty open board makes the join the content')
  assert.match(empty, /poll-frame-board-bigjoin/)
  assert.match(empty, /is-example"><p>More time to try things ourselves<\/p><small>Example<\/small>/, 'with the dashed example in the first column')
  assert.match(empty, /Cards appear here as they arrive\. No names are shown\./)
  assert.equal((empty.match(/poll-frame-board-hint/g) || []).length, 3, 'every empty column shows its hint')
  assert.match(empty, /Open · 0 cards/)
  const noJoin = renderPollFrame(definition, { live: true, state: 'open', board: { open: true, frozen: false, cardCount: 2, columns: [] } })
  assert.ok(noJoin.includes('Join link appears when the session is live'), 'no invented link before the live join exists')
  assert.equal(renderPollFrame(definition, { live: true, state: 'open', board: view, join: { shortUrl: 'https://handouts.fyi/737u' } }).includes('poll-frame-board-qr'), false, 'no QR without a drawing')
  const atRest = renderPollFrame(definition, {})
  assert.ok(!atRest.includes('data-board-state') && atRest.includes('poll-frame-board-count">0<'), 'without a board view the frame stays the at-rest columns')
}

// ── 2. The audience-window boundary ─────────────────────────────────────────────────────────────────
{
  const presenter = STATES.hidden.presenter
  assert.ok(JSON.stringify(presenter).includes('Person 0-0'), 'the fixture carries names on the presenter side (the boundary has something to strip)')
  const safe = plain(display.safeState(presenter))
  const blob = JSON.stringify(safe)
  assert.ok(!/Person \d|Secret Sam|Other Person|"name"|hidden|touched|acceptedAt|participant/.test(blob), `no name, hidden marker or timestamp passes: ${blob.slice(0, 300)}`)
  assert.ok(!blob.includes(STATES.hidden.hiddenText), 'a hidden card is not on the screen')
  assert.ok(!blob.includes(STATES.hidden.hiddenGroupFirst), 'a group whose first card is hidden shows another visible card, or nothing')
  assert.equal(safe.pollType, 'board')
  assert.equal(safe.board.hints[columnIds[0]], 'What worked for you?', 'the column hints reach the screen')
  const twice = plain(display.safeState(safe))
  assert.deepEqual(twice.boardView, safe.boardView, 'the resolved view survives the second pass (snapshot and storage)')
  const audience = plain(display.safeState(STATES.overLimit.audience))
  const view = STATES.overLimit.audience.boardState
  audience.boardView.columns.forEach((column, index) => {
    assert.equal(column.entries.length, view.columns[index].onScreen.length, 'the screen draws exactly the worker\'s onScreen entries, never a recomputed set')
    assert.equal(column.waiting, view.columns[index].waiting)
    assert.equal(column.count, view.columns[index].cards)
  })
  assert.equal(display.safeState({ ...presenter, boardState: { ...presenter.boardState, columns: 'nope' } }).boardView, undefined, 'a malformed view is dropped, not guessed')
  const markup = display.markup(presenter, { started: true, view: 'results', join: join_ })
  assert.match(markup, /data-poll-view="question"/, 'a board has no results view')
  assert.ok(!display.markup(presenter, { started: false }).includes('data-board-state'), 'before the board opens the frame is the at-rest one')
}

// ── 3. Headless render at 1280×720 ──────────────────────────────────────────────────────────────────
const errors = []
const browser = await chromium.launch({ headless: true })
const MEASURE = () => {
  const slide = document.querySelector('.slide.active')
  const content = slide.querySelector('.slide-content')
  const frame = content.querySelector(':scope > .poll-frame[data-poll-frame="live"]')
  const px = (el) => parseFloat(getComputedStyle(el).fontSize)
  const cards = [...frame.querySelectorAll('.poll-frame-board-card:not(.is-example)')]
  const areas = [...frame.querySelectorAll('.poll-frame-board-cards')]
  const stage = document.querySelector('.stage')
  return {
    fitStep: frame.dataset.fitStep || null,
    boardState: frame.dataset.boardState || null,
    zoom: content.style.zoom || '1',
    slideOverflow: [slide.scrollHeight - slide.clientHeight, slide.scrollWidth - slide.clientWidth],
    frameFits: frame.getBoundingClientRect().bottom <= slide.getBoundingClientRect().bottom + 1,
    stageWidth: stage ? stage.getBoundingClientRect().width : null,
    cardCount: cards.length,
    groupCount: frame.querySelectorAll('.is-group').length,
    minCardPx: cards.length ? Math.min(...cards.map((card) => px(card.querySelector('p')))) : null,
    overflowingColumns: areas.filter((area) => area.scrollHeight > area.clientHeight + 1).length,
    clippedCards: cards.filter((card) => { const a = card.closest('.poll-frame-board-cards').getBoundingClientRect(); const r = card.getBoundingClientRect(); return r.bottom > a.bottom + 1 || r.right > a.right + 1 || r.left < a.left - 1 }).length,
    columns: [...frame.querySelectorAll('.poll-frame-board-column')].map((column) => ({
      name: column.querySelector('.poll-frame-board-label')?.textContent,
      count: column.querySelector('.poll-frame-board-count')?.textContent,
      more: column.querySelector('.poll-frame-board-more')?.textContent || '',
      cards: column.querySelectorAll('.poll-frame-board-card:not(.is-example)').length,
      hint: column.querySelector('.poll-frame-board-hint')?.textContent || '',
      example: column.querySelector('.is-example p')?.textContent || '',
    })),
    foot: frame.querySelector('.poll-frame-foot').textContent.replace(/\s+/g, ' ').trim(),
    chip: frame.querySelector('.poll-frame-chip').textContent,
    qr: Boolean(frame.querySelector('.poll-frame-foot .poll-frame-board-qr svg')),
    bigJoinQr: Boolean(frame.querySelector('.poll-frame-board-bigjoin .poll-frame-board-qr svg')),
    bigJoin: Boolean(frame.querySelector('.poll-frame-board-bigjoin')),
    text: frame.textContent,
    canvasFrame: (() => { const s = slide.getBoundingClientRect(); const f = frame.getBoundingClientRect(); return [Math.round(f.top - s.top), Math.round(s.bottom - f.bottom)] })(),
  }
}

async function show(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  context.setDefaultTimeout(10000)
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`)))
  await context.addInitScript(() => {
    if (!location.search.includes('presenter=1')) return
    window.twLivePollBridge = {
      action: async () => ({ success: true, status: 'confirmed' }),
      onState: (cb) => { window.__pollStateApply = cb }, onStatus: (cb) => { window.__pollStatusApply = cb },
      onJoin: (cb) => { window.__pollJoinApply = cb }, onOperation: (cb) => { window.__pollOperationApply = cb },
    }
  })
  const presenter = await context.newPage()
  await presenter.goto(`${pathToFileURL(deckPath).href}?presenter=1&session=board-${name}#kctbd`)
  const audiencePromise = context.waitForEvent('page')
  await presenter.locator('#presenterMenuLive').click()
  await presenter.locator('#presenterAudienceApp').click()
  const audience = await audiencePromise
  await audience.waitForLoadState()
  await audience.setViewportSize({ width: 1280, height: 720 })
  await presenter.evaluate((value) => window.__pollJoinApply(value), join_)
  // The presenter's message is the presenter-role state, exactly what the worker sends it.
  await presenter.evaluate((message) => window.__pollStateApply(message), STATES[name].presenter)
  await audience.locator('.slide.active .slide-content > [data-poll-frame="live"][data-board-state]').waitFor({ state: 'visible' })
  await audience.waitForTimeout(400)
  if (process.env.TW_DEBUG) console.log(name, await audience.evaluate(() => { const f=document.querySelector('.poll-frame[data-board-state]'); const a=[...f.querySelectorAll('.poll-frame-board-cards')]; return JSON.stringify({step:f.dataset.fitStep, sh:a.map(x=>[x.scrollHeight,x.clientHeight]), fh:f.clientHeight, fn: typeof pollFrameFitBoard}) }))
  const measured = await audience.evaluate(MEASURE)
  if (shots) await audience.screenshot({ path: join(shots, `board-${name}-1280x720.png`) })
  return { context, presenter, audience, measured }
}

const report = []
try {
  for (const name of ['six', 'twentyFour', 'forty', 'overLimit', 'hidden', 'empty', 'closed', 'frozen']) {
    const { context, presenter, audience, measured: m } = await show(name)
    const view = STATES[name].audience.boardState
    const entries = view.columns.reduce((sum, column) => sum + column.onScreen.length, 0)
    report.push(`${name}: ${m.cardCount} entries on screen, fit ${m.fitStep}, smallest card ${m.minCardPx === null ? '-' : m.minCardPx.toFixed(1) + 'px'}`)

    assert.deepEqual(m.slideOverflow.map((n) => Math.max(0, n)), [0, 0], `${name}: the slide is not overflowed (${m.slideOverflow})`)
    assert.equal(m.zoom, '1', `${name}: the whole slide never zooms to fit a board`)
    assert.ok(m.frameFits, `${name}: the frame stays inside the slide`)
    assert.equal(m.overflowingColumns, 0, `${name}: no column overflows`)
    assert.equal(m.clippedCards, 0, `${name}: no card is clipped`)
    assert.equal(m.cardCount, entries, `${name}: the screen shows exactly the worker's on-screen entries (${entries})`)
    assert.equal(m.groupCount, view.columns.reduce((sum, column) => sum + column.onScreen.filter((entry) => entry.group !== undefined).length, 0), `${name}: every group is numbered on the screen`)
    view.columns.forEach((column, index) => {
      assert.equal(m.columns[index].count, String(column.cards), `${name}: column ${index + 1} counts its visible cards`)
      assert.equal(m.columns[index].more, column.waiting ? `+ ${column.waiting} more on your phone` : '', `${name}: column ${index + 1} says how many wait`)
    })

    if (m.cardCount) {
      assert.notEqual(m.fitStep, 'overflow', `${name}: a fit step was found`)
      if (name === 'six') assert.ok(m.minCardPx >= m.stageWidth * 31 / 1600 - 0.5, `six: cards stay at the stage type floor (${m.minCardPx})`)
      if (m.cardCount <= 24) assert.ok(m.minCardPx >= BOARD_MIN_CARD_PX - 0.05, `${name}: card text holds ${BOARD_MIN_CARD_PX}px up to the limit of 24 (got ${m.minCardPx.toFixed(2)}px at ${m.fitStep})`)
      assert.ok(m.minCardPx >= 12 - 0.05, `${name}: even a released board stays readable (${m.minCardPx.toFixed(2)}px)`)
    }
    assert.ok(!/Person \d|Secret Sam|Other Person/.test(m.text), `${name}: no participant name reaches the screen`)
    assert.ok(m.qr || m.bigJoinQr || name === 'closed' || name === 'frozen', `${name}: the join QR is on the screen`)

    if (name === 'overLimit') {
      assert.equal(m.cardCount, 24, 'overLimit: 24 entries at the limit, the rest wait')
      assert.ok(m.columns.every((column) => column.cards > 0 || /more on your phone/.test(column.more)) && m.columns.some((column) => /more on your phone/.test(column.more)), 'overLimit: columns with waiting cards say so')
    }
    if (name === 'twentyFour') assert.equal(m.cardCount, 24)
    if (name === 'forty') assert.equal(m.cardCount, 40)
    if (name === 'empty') {
      assert.ok(m.bigJoin && m.bigJoinQr && m.qr === false, 'empty: the big join, not the foot strip')
      assert.equal(m.columns[0].example, 'More time to try things ourselves', 'empty: the example card')
      assert.ok(m.columns.every((column) => column.hint), 'empty: every column keeps its hint')
      assert.match(m.foot, /Cards appear here as they arrive\. No names are shown\./)
    }
    if (name === 'closed') { assert.equal(m.boardState, 'closed'); assert.match(m.foot, /Closed to new cards\. Read the whole board at handouts\.fyi\/737u/) }
    if (name === 'frozen') { assert.equal(m.boardState, 'frozen'); assert.match(m.foot, /The board as the room left it\./); assert.match(m.chip, /Final board · 7 cards/) }
    if (name === 'hidden') {
      assert.ok(!m.text.includes(STATES.hidden.hiddenText), 'hidden: the hidden card is not on the screen')
      assert.ok(!m.text.includes(STATES.hidden.hiddenGroupFirst), 'hidden: nor the hidden first card of a group')
    }

    // The presenter's own Current preview shows the same board (an iframe running the same fit).
    if (name === 'twentyFour' || name === 'overLimit') {
      const frame = presenter.frameLocator('#currentPreview iframe')
      await frame.locator('.poll-frame[data-board-state]').waitFor({ state: 'attached' })
      await presenter.waitForTimeout(700)
      const preview = await presenter.frames().find((f) => f !== presenter.mainFrame() && f.url() === 'about:srcdoc' && f.parentFrame() === presenter.mainFrame()).evaluate(() => {
        const frameEl = document.querySelector('.poll-frame[data-board-state]:not([hidden])')
        return { step: frameEl.dataset.fitStep, cards: frameEl.querySelectorAll('.poll-frame-board-card:not(.is-example)').length,
          overflow: [...frameEl.querySelectorAll('.poll-frame-board-cards')].filter((a) => a.scrollHeight > a.clientHeight + 1).length }
      })
      assert.equal(preview.cards, m.cardCount, `${name}: the presenter's preview shows the same entries`)
      assert.equal(preview.step, m.fitStep, `${name}: and fits them to the same step`)
      assert.equal(preview.overflow, 0, `${name}: with no column overflowing`)
      if (shots) await presenter.screenshot({ path: join(shots, `board-${name}-presenter.png`) })
    }
    await context.close()
  }
  // ── 4. The venue screen (the published venue page, a follower of the live session) ───────────────
  const slides = extractSlides(model.fullHtml)
  const styles = extractStyles(model.fullHtml)
  const build = (extra = {}) => buildShareHtml({ title: 'Board venue probe', slug: 'board-probe', liveTalkSlug: 'board-probe',
    workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null, styles, slides, ...extra })
  const venuePath = join(scratch, 'venue.html')
  const phonePath = join(scratch, 'phone.html')
  await writeFile(venuePath, build({ venue: true, venueQr: join_.qrSvg, venueUrl: join_.shortUrl }))
  await writeFile(phonePath, build())
  const socketScript = () => {
    window.__sockets = []
    window.fetch = async (url) => {
      const path = String(url)
      if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '15-feedback-boards' }) }
      if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
      return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
    }
    window.WebSocket = class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      constructor(url) {
        this.url = url
        window.__sockets.push(this)
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 600000 }) })
      }
      send(raw) {
        const message = JSON.parse(raw)
        if (message.type === 'session.sync') queueMicrotask(() => this.emit({ type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId,
          expiresAt: Date.now() + 600000, slideState: null, polls: [], receipts: [] }))
        if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
      }
      close() { this.readyState = 3 }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    }
  }
  const openPage = async (path, size) => {
    const context = await browser.newContext({ viewport: { width: size[0], height: size[1] } })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(`venue page: ${error.message}`))
    if (process.env.TW_DEBUG) page.on('console', (m) => console.log('console:', m.text()))
    if (process.env.TW_DEBUG) page.on('pageerror', (error) => console.log('pageerror:', error.message))
    await page.addInitScript(socketScript)
    await page.goto(pathToFileURL(path).href)
    await page.waitForFunction(() => window.__sockets.length >= 1)
    if (process.env.TW_DEBUG) { await page.waitForTimeout(700); console.log('status', await page.evaluate(() => document.getElementById('liveFollowStatus')?.textContent)) }
    await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    return { context, page }
  }
  const emit = (page, message) => page.evaluate((m) => window.__sockets.at(-1).emit(m), message)
  const venueMeasure = () => {
    const slide = document.querySelector('.slide.active')
    const frame = slide.querySelector('.poll-frame[data-poll-frame="live"][data-board-state]')
    if (!frame) return null
    const cards = [...frame.querySelectorAll('.poll-frame-board-card:not(.is-example)')]
    return {
      id: slide.dataset.id, cards: cards.length, step: frame.dataset.fitStep, text: frame.textContent, state: frame.dataset.boardState,
      more: [...frame.querySelectorAll('.poll-frame-board-more')].map((el) => el.textContent),
      minPx: cards.length ? Math.min(...cards.map((card) => parseFloat(getComputedStyle(card.querySelector('p')).fontSize))) : null,
      overflow: [...frame.querySelectorAll('.poll-frame-board-cards')].filter((a) => a.scrollHeight > a.clientHeight + 1).length,
      compiledHidden: slide.querySelector('[data-poll-frame="compiled"]')?.hidden === true,
      qr: Boolean(frame.querySelector('.poll-frame-board-qr svg')), foot: frame.querySelector('.poll-frame-foot').textContent.replace(/\s+/g, ' ').trim(),
      zoom: slide.querySelector('.slide-content').style.zoom || '1',
    }
  }
  for (const name of ['twentyFour', 'overLimit', 'closed']) {
    const { context, page } = await openPage(venuePath, [1280, 720])
    await emit(page, { type: 'slide.state', slideId: 'kctbd', reveal: 0, focus: null, revision: 1 })
    await emit(page, STATES[name].audience)
    if (process.env.TW_DEBUG) { await page.waitForTimeout(800); console.log(await page.evaluate(() => JSON.stringify({ active: document.querySelector('.slide.active')?.dataset.id, frames: [...document.querySelectorAll('.poll-frame')].map((f) => f.dataset.pollFrame + ':' + f.hidden), n: window.__sockets.length }))) }
    if (process.env.TW_DEBUG) { await page.waitForTimeout(600); console.log('venue', name, await page.evaluate(() => JSON.stringify({ active: document.querySelector('.slide.active')?.dataset.id, frames: [...document.querySelectorAll('.poll-frame')].map((f) => f.dataset.pollFrame + ':' + f.hidden + ':' + f.dataset.boardState), live: document.getElementById('liveFollowStatus')?.textContent }))) }
    await page.waitForFunction(() => document.querySelector('.slide.active .poll-frame[data-board-state]'))
    await page.waitForTimeout(400)
    const v = await page.evaluate(venueMeasure)
    const view = STATES[name].audience.boardState
    const shown = view.columns.reduce((sum, column) => sum + column.onScreen.length, 0)
    assert.equal(v.cards, shown, `venue ${name}: the venue draws the worker's on-screen entries (${shown})`)
    assert.equal(v.overflow, 0, `venue ${name}: no column overflows`)
    assert.equal(v.zoom, '1', `venue ${name}: the slide does not zoom`)
    assert.ok(v.compiledHidden, `venue ${name}: the at-rest frame gives way to the live one`)
    if (name !== 'closed') assert.ok(v.qr && /handouts\.fyi\/737u/.test(v.foot), `venue ${name}: the join QR and link are in the foot`)
    if (name === 'twentyFour') assert.ok(v.minPx >= BOARD_MIN_CARD_PX - 0.05, `venue twentyFour: card text holds ${BOARD_MIN_CARD_PX}px (${v.minPx})`)
    if (name === 'overLimit') assert.deepEqual(v.more, view.columns.filter((c) => c.waiting).map((c) => `+ ${c.waiting} more on your phone`), 'venue overLimit: each column says how many wait')
    if (name === 'closed') { assert.equal(v.state, 'closed'); assert.match(v.foot, /Closed to new cards/) }
    // The next board state replaces the drawing in place (a card arrives).
    if (name === 'twentyFour') {
      await emit(page, STATES.frozen.audience)
      await page.waitForFunction(() => document.querySelector('.slide.active .poll-frame[data-board-state="frozen"]'))
      const frozen = await page.evaluate(venueMeasure)
      assert.match(frozen.foot, /The board as the room left it\./, 'venue: a later state redraws the frame')
    }
    if (shots) await page.screenshot({ path: join(shots, `board-venue-${name}-1280x720.png`) })
    await context.close()
  }
  {
    // A phone page never gets a poll popup for a board (the phone board view is its own work).
    const { context, page } = await openPage(phonePath, [390, 780])
    await emit(page, { type: 'slide.state', slideId: 'kctbd', reveal: 0, focus: null, revision: 1 })
    await emit(page, STATES.twentyFour.audience)
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => document.getElementById('audiencePollSurface').hidden), true, 'a phone page shows no poll popup for a board')
    assert.equal(await page.evaluate(() => Boolean(document.querySelector('.poll-frame[data-board-state]'))), false, 'and draws no big-screen board')
    await context.close()
  }
  assert.deepEqual(errors, [], 'no runtime errors in any window')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
console.log(`poll board screen: unit + boundary + render OK\n  ${report.join('\n  ')}`)
