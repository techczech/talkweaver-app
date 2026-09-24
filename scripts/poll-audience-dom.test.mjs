import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { DOMParser } from '@xmldom/xmldom'
import * as liveRuntime from '../compiler/assets/runtime/live-follow.js'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const html = buildShareHtml({
  title: 'Poll audience browser test',
  slug: 'poll-audience-browser-test',
  liveTalkSlug: 'poll-audience-browser-test',
  workerBaseUrl: 'https://live.example.test',
  includeNotes: false,
  license: null,
  styles: '',
  slides: [{
    html: '<section class="slide" data-id="slide-a" data-nav-title="Poll slide"><div class="slide-content"><h1>Poll slide</h1></div></section>',
    notes: '',
  }],
})

const single = {
  type: 'poll.state', pollId: 'poll-single', pollType: 'single', question: 'Choose one',
  options: [{ optionId: 'a', label: 'First' }, { optionId: 'b', label: 'Second' }],
  visibility: 'live', open: true, revealed: true, tallies: { a: 0, b: 0 },
}
const multiple = {
  type: 'poll.state', pollId: 'poll-multiple', pollType: 'multiple', question: 'Choose any',
  options: [{ optionId: 'a', label: 'Alpha' }, { optionId: 'b', label: 'Beta' }],
  visibility: 'held', open: true, revealed: false,
}
const open = {
  type: 'poll.state', pollId: 'poll-open', pollType: 'open', question: 'What matters?',
  options: [], visibility: 'live', open: true, revealed: true, responses: [],
}

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-poll-audience-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, html)

async function runBrowserTest() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(() => {
    window.__liveSockets = []
    window.fetch = async () => ({ ok: true, json: async () => ({ live: true, sessionId: 'session-1' }) })
    window.WebSocket = class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      sent = []
      constructor(url) {
        this.url = url
        window.__liveSockets.push(this)
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.()
          this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60_000 })
        })
      }
      close() { this.readyState = 3 }
      send(message) {
        const parsed = JSON.parse(message)
        this.sent.push(parsed)
        if (parsed.type === 'session.sync') queueMicrotask(() => this.emit({
          type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: parsed.syncId,
          expiresAt: Date.now() + 60_000, slideState: null, polls: [], receipts: [],
        }))
        if (parsed.type === 'vote.submit') queueMicrotask(() => this.emit({
          type: 'vote.ack', submissionId: parsed.submissionId, pollId: parsed.pollId,
          status: 'confirmed', choice: parsed.choice,
        }))
      }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    }
  })

  try {
    await page.goto(pathToFileURL(htmlPath).href)
    await page.waitForFunction(() => window.__liveSockets.length === 1)
    await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    const surface = page.locator('#audiencePollSurface')

    await page.evaluate((message) => window.__liveSockets[0].emit(message), single)
    assert.equal(await surface.isVisible(), true)
    assert.equal(await surface.locator('input[type="radio"]').count(), 2)
    await surface.getByText('First', { exact: true }).click()
    await surface.locator('.poll-submit').click()
    const singleVote = await page.evaluate(() => window.__liveSockets[0].sent.at(-1))
    assert.deepEqual(
      { type: singleVote.type, pollId: singleVote.pollId, choice: singleVote.choice },
      { type: 'vote.submit', pollId: 'poll-single', choice: 'a' },
    )
    assert.match(singleVote.submissionId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/, 'the browser sends a valid submission ID')
    await page.waitForFunction(() => localStorage.getItem('talkweaver:poll-vote:session-1:poll-single') === '"a"')
    await page.evaluate((message) => window.__liveSockets[0].emit(message), { ...single, tallies: { a: 1, b: 0 } })
    assert.equal(await surface.locator('.poll-bar.mine').count(), 1)
    assert.match(await surface.locator('.poll-bar.mine').textContent(), /First/)
    assert.equal(await page.evaluate(() => localStorage.getItem('talkweaver:poll-vote:session-1:poll-single')), '"a"')

    await page.evaluate((message) => window.__liveSockets[0].emit(message), multiple)
    assert.equal(await surface.locator('input[type="checkbox"]').count(), 2)
    await surface.getByText('Alpha', { exact: true }).click()
    await surface.getByText('Beta', { exact: true }).click()
    await surface.locator('.poll-submit').click()
    await page.waitForFunction(() => localStorage.getItem('talkweaver:poll-vote:session-1:poll-multiple') != null)
    await page.evaluate((message) => window.__liveSockets[0].emit(message), multiple)
    assert.match(await surface.textContent(), /Answer recorded/)
    assert.match(await surface.textContent(), /speaker will share the results/)
    await page.evaluate((message) => window.__liveSockets[0].emit(message), {
      ...multiple, revealed: true, tallies: { a: 1, b: 1 },
    })
    assert.equal(await surface.locator('.poll-bar.mine').count(), 2)

    await page.evaluate((message) => window.__liveSockets[0].emit(message), open)
    assert.equal(await surface.locator('textarea').count(), 1)
    await surface.locator('textarea').fill('Accountability')
    await surface.locator('.poll-submit').click()
    await page.waitForFunction(() => localStorage.getItem('talkweaver:poll-vote:session-1:poll-open') != null)
    await page.evaluate((message) => window.__liveSockets[0].emit(message), {
      ...open, responses: [
        { responseId: 'connection-1', text: 'Accountability' },
        { responseId: 'connection-2', text: 'Judgement', name: 'Priya' },
      ],
    })
    assert.equal(await surface.locator('.poll-response.mine').count(), 1)
    assert.match(await surface.locator('.poll-response.mine').textContent(), /your answer/)
    await page.evaluate((message) => window.__liveSockets[0].emit(message), {
      ...open, responses: [{ responseId: 'connection-2', text: 'Judgement', name: 'Priya' }],
    })
    assert.doesNotMatch(await surface.textContent(), /Accountability/, 'a hidden response drops from the board')
    assert.match(await surface.textContent(), /Your answer is recorded/, 'the hidden response owner keeps local answer state')

    // Closing keeps the safe final state visible; reveal can still replace a held confirmation.
    await page.evaluate((message) => window.__liveSockets[0].emit(message), { ...open, open: false })
    assert.equal(await surface.isVisible(), true, 'closing a poll retains the audience card')
    assert.match(await surface.textContent(), /0 responses/)

    // A new poll still appears after an auto-hide.
    await page.evaluate((message) => window.__liveSockets[0].emit(message), {
      ...single, pollId: 'poll-second', tallies: undefined,
    })
    assert.equal(await surface.isVisible(), true, 'a new poll appears after a close')

    // Manual dismiss remains available while a poll is open.
    assert.equal(await surface.locator('.poll-dismiss').count(), 1, 'an open poll offers a dismiss control')
    await surface.locator('.poll-dismiss').click()
    assert.equal(await surface.isVisible(), false, 'dismissing hides the poll surface')

    // Moving to the next slide also clears a live poll card.
    await page.evaluate((message) => window.__liveSockets[0].emit(message), {
      ...single, pollId: 'poll-third', tallies: undefined,
    })
    assert.equal(await surface.isVisible(), true, 'poll-third is showing before the slide moves')
    await page.evaluate(() => window.__liveSockets[0].emit({
      type: 'slide.state', slideId: 'slide-b', reveal: 0, focus: null, revision: 99,
    }))
    assert.equal(await surface.isVisible(), false, 'moving to the next slide clears the poll card')

    await page.evaluate(() => window.__liveSockets[0].emit({ type: 'session.closed' }))
    assert.equal(await surface.isVisible(), false, 'session end tears the surface down')
  } finally {
    await browser.close()
  }
}

function nodesByTag(markup, tag) {
  const parsed = new DOMParser({ errorHandler: () => {} }).parseFromString(`<root>${markup}</root>`, 'text/xml')
  return Array.from(parsed.getElementsByTagName(tag))
}

async function runGeneratedDocumentFallback() {
  assert.equal(typeof liveRuntime.renderAudiencePollMarkup, 'function', 'the audience runtime exports its DOM renderer')
  assert.equal(typeof liveRuntime.shouldRenderAudiencePollUpdate, 'function', 'the runtime exposes its in-progress update policy')
  assert.match(html, /id="audiencePollSurface"/)
  assert.match(html, /--tw-touch-target:\s*44px/)
  assert.match(html, /100dvh/)
  assert.match(html, /env\(safe-area-inset-bottom\)/)

  const singleMarkup = liveRuntime.renderAudiencePollMarkup(single, null)
  assert.equal(nodesByTag(singleMarkup, 'input').filter((node) => node.getAttribute('type') === 'radio').length, 2)
  const multipleMarkup = liveRuntime.renderAudiencePollMarkup(multiple, null)
  assert.equal(nodesByTag(multipleMarkup, 'input').filter((node) => node.getAttribute('type') === 'checkbox').length, 2)
  const openMarkup = liveRuntime.renderAudiencePollMarkup(open, null)
  assert.equal(nodesByTag(openMarkup, 'textarea').length, 1)

  const liveResult = liveRuntime.renderAudiencePollMarkup({ ...single, tallies: { a: 2, b: 1 } }, 'a')
  assert.match(liveResult, /poll-bar mine/)
  const heldResult = liveRuntime.renderAudiencePollMarkup({ ...multiple, recorded: true }, ['a', 'b'])
  assert.match(heldResult, /Answer recorded/)
  assert.match(heldResult, /speaker will share the results/)
  const openResult = liveRuntime.renderAudiencePollMarkup({
    ...open, responses: [
      { responseId: 'connection-1', text: 'Accountability' },
      { responseId: 'connection-2', text: 'Judgement' },
    ],
  }, 'Accountability')
  assert.match(openResult, /poll-response mine/)
  assert.match(openResult, /your answer/)
  const hiddenOwnResponse = liveRuntime.renderAudiencePollMarkup({
    ...open, responses: [{ responseId: 'connection-2', text: 'Judgement' }],
  }, 'Accountability')
  assert.doesNotMatch(hiddenOwnResponse, /Accountability/)
  assert.match(hiddenOwnResponse, /Your answer is recorded/)
  const closed = liveRuntime.renderAudiencePollMarkup({ ...open, open: false }, 'Accountability')
  assert.doesNotMatch(closed, /poll-submit/)
  assert.equal(
    liveRuntime.shouldRenderAudiencePollUpdate(single, { ...single, tallies: { a: 1, b: 0 } }, null),
    false,
    'new live tallies do not clear an unanswered in-progress selection',
  )
  assert.equal(
    liveRuntime.shouldRenderAudiencePollUpdate(single, { ...single, tallies: { a: 1, b: 0 } }, 'a'),
    true,
    'an answered device re-renders new live tallies as results',
  )
}

let usedBrowser = true
try {
  await runBrowserTest()
} catch (error) {
  const message = String(error?.message || error)
  if (!/MachPortRendezvousServer|bootstrap_check_in[^\n]*Permission denied/.test(message)) throw error
  usedBrowser = false
  await runGeneratedDocumentFallback()
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(`poll audience DOM: all poll types, live/held results, local mine state, close and end passed (${usedBrowser ? 'Playwright' : 'generated-document fallback'})`)
