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
  title: 'Live follow browser test',
  slug: 'live-follow-browser-test',
  liveTalkSlug: 'live-follow-browser-test',
  workerBaseUrl: 'https://live.example.test',
  includeNotes: false,
  license: null,
  styles: '',
  slides: [
    {
      html: `<section class="slide" data-id="slide-a" data-nav-title="Reveal slide">
        <div class="slide-content">
          <h1>Reveal slide</h1>
          <ul class="feature-list"><li>One</li><li>Two</li><li>Three</li><li>Four</li></ul>
        </div>
      </section>`,
      notes: '',
    },
    {
      html: '<section class="slide" data-id="slide-b" data-nav-title="Other slide"><div class="slide-content"><h1>Other slide</h1></div></section>',
      notes: '',
    },
  ],
})

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-live-follow-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, html)

async function runBrowserTest() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => {
    window.__liveSockets = []
    window.fetch = async () => ({ ok: true, json: async () => ({ live: true, sessionId: 'session-1' }) })
    window.WebSocket = class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      constructor(url) {
        this.url = url
        window.__liveSockets.push(this)
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.()
          this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 })
        })
      }
      send(raw) {
        const message = JSON.parse(raw)
        if (message.type === 'session.sync') queueMicrotask(() => this.emit({
          type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId,
          expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: [],
        }))
        if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
      }
      close() { this.readyState = 3 }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    }
  })

  try {
    await page.goto(pathToFileURL(htmlPath).href)
    await page.waitForFunction(() => window.__liveSockets.length === 1)

    const followButton = page.locator('#followLiveBtn')
    const returnButton = page.locator('#returnToPresenterBtn')
    assert.equal(await followButton.isVisible(), true, 'live discovery automatically exposes the follow control')
    assert.equal(await followButton.locator('.btn-label').textContent(), 'Stop following', 'live discovery automatically enters follow mode')
    assert.equal(await returnButton.isVisible(), false, 'Return is hidden while following at the live position')
    assert.equal(await page.locator('#nowLiveBadge').isVisible(), true, 'slide chrome shows Now live')
    assert.equal(await page.locator('#overviewNowLiveBadge').isVisible(), true, 'overview shows Now live next to the slides')

    await page.evaluate(() => window.__liveSockets[0].emit({
      type: 'slide.state', slideId: 'slide-a', reveal: 0,
      focus: { kind: 'reveal', step: 2 }, revision: 1,
    }))
    const modeStates = await page.locator('.slide[data-id="slide-a"] .feature-list > li').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-mode-state')),
    )
    assert.deepEqual(modeStates, ['soft', 'current', 'hidden', 'hidden'], 'real MODE_SELECTOR units reveal exactly the first two items at step 2')
    await page.evaluate(() => window.__liveSockets[0].emit({
      type: 'slide.state', slideId: 'slide-a', reveal: 0,
      focus: { kind: 'focus', step: 2 }, revision: 2,
    }))
    const focusStates = await page.locator('.slide[data-id="slide-a"] .feature-list > li').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-mode-state')),
    )
    assert.deepEqual(focusStates, ['soft', 'current', 'fuzzy', 'fuzzy'], 'real MODE_SELECTOR units focus the current item at step 2')

    await page.locator('#nextBtn').click()
    assert.equal(await returnButton.isVisible(), true, 'Return appears after the viewer steps away from the live reveal')
    assert.equal(await followButton.isVisible(), false, 'Stop is hidden while the viewer is diverged')

    await returnButton.click()
    assert.equal(await returnButton.isVisible(), false, 'Return hides after restoring the presenter position')
    assert.equal(await followButton.locator('.btn-label').textContent(), 'Stop following')

    await followButton.click()
    assert.equal(await followButton.locator('.btn-label').textContent(), 'Follow live', 'Stop following opts out without ending the live session')
    assert.equal(await returnButton.isVisible(), false, 'explicit opt-out is not represented as divergence')

    await page.evaluate(() => window.__liveSockets[0].emit({
      type: 'slide.state', slideId: 'slide-b', reveal: 0, focus: null, revision: 3,
    }))
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'slide-a', 'an opted-out viewer is not moved by presenter updates')
    await followButton.click()
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'slide-b', 'Follow live resumes at the latest presenter position')
    assert.equal(await followButton.locator('.btn-label').textContent(), 'Stop following')
  } finally {
    await browser.close()
  }
}

class FakeClassList {
  values = new Set()
  toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name) }
}
class FakeElement {
  hidden = false
  value = ''
  textContent = ''
  classList = new FakeClassList()
  children = new Map()
  listeners = new Map()
  querySelector(selector) { return this.children.get(selector) ?? null }
  addEventListener(type, callback) { this.listeners.set(type, callback) }
  click() { this.listeners.get('click')?.() }
}

async function runGeneratedDocumentFallback() {
  const parsed = new DOMParser({ errorHandler: () => {} }).parseFromString(html, 'text/html')
  const featureList = Array.from(parsed.getElementsByTagName('ul')).find((node) => node.getAttribute('class') === 'feature-list')
  const units = Array.from(featureList?.getElementsByTagName('li') ?? [])
  assert.equal(units.length, 4, 'the generated document contains four real feature-list reveal units')

  const emittedScript = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1] ?? ''
  const grammarStart = emittedScript.indexOf('function maxStepFor')
  const grammarEnd = emittedScript.indexOf('// Diff, do not reset', grammarStart)
  const grammar = emittedScript.slice(grammarStart, grammarEnd)
  const unitState = new Function(`${grammar}; return unitState`)()
  units.forEach((unit, index) => unit.setAttribute('data-mode-state', unitState('reveal', 2, units.length, index)))
  assert.deepEqual(units.map((unit) => unit.getAttribute('data-mode-state')), ['soft', 'current', 'hidden', 'hidden'])
  units.forEach((unit, index) => unit.setAttribute('data-mode-state', unitState('focus', 2, units.length, index)))
  assert.deepEqual(units.map((unit) => unit.getAttribute('data-mode-state')), ['soft', 'current', 'fuzzy', 'fuzzy'])
  assert.match(emittedScript, /const MODE_SELECTOR = "[^"]*\.feature-list > li/)
  assert.match(emittedScript, /function setModeState[\s\S]*applyModeDimming\(\)/)
  assert.match(emittedScript, /function applyLiveSlideState[\s\S]*setModeState\(message\.focus/)

  const controls = new Map(['followLiveBtn', 'liveFollowStatus', 'returnToPresenterBtn', 'nowLiveBadge', 'overviewNowLiveBadge', 'liveNameWrap', 'liveName'].map((id) => [id, new FakeElement()]))
  controls.get('followLiveBtn').children.set('.btn-label', new FakeElement())
  const document = {
    getElementById: (id) => controls.get(id) ?? null,
    querySelectorAll: (selector) => selector === '.now-live-badge' ? [controls.get('nowLiveBadge'), controls.get('overviewNowLiveBadge')] : [],
  }
  let viewer = { slideId: 'slide-a', reveal: 0, focus: null }
  let socket
  const controller = liveRuntime.createAudienceFollowRuntime({
    document,
    liveConfig: { workerBaseUrl: 'https://live.example.test', talkSlug: 'talk' },
    getViewerPosition: () => viewer,
    applyLiveSlideState(message) { viewer = { slideId: message.slideId, reveal: message.reveal, focus: message.focus }; return true },
    fetchSession: async () => ({ live: true, sessionId: 'session-1' }),
    scheduleDiscovery() {},
    createClient(options) { socket = { end() {}, emit: options.onSlideState }; return socket },
  })
  await controller.discoverSession()
  assert.equal(controls.get('followLiveBtn').children.get('.btn-label').textContent, 'Stop following')
  assert.equal(controls.get('nowLiveBadge').hidden, false)
  assert.equal(controls.get('overviewNowLiveBadge').hidden, false)
  socket.emit({ type: 'slide.state', slideId: 'slide-a', reveal: 0, focus: { kind: 'reveal', step: 2 }, revision: 1 })
  viewer = { slideId: 'slide-b', reveal: 0, focus: null }
  controller.viewerMoved()
  assert.equal(controls.get('returnToPresenterBtn').hidden, false)
  assert.equal(controls.get('followLiveBtn').hidden, true)
  controls.get('returnToPresenterBtn').click()
  assert.equal(controls.get('returnToPresenterBtn').hidden, true)
  controls.get('followLiveBtn').click()
  assert.equal(controls.get('followLiveBtn').children.get('.btn-label').textContent, 'Follow live')
  socket.emit({ type: 'slide.state', slideId: 'slide-b', reveal: 0, focus: null, revision: 2 })
  assert.equal(viewer.slideId, 'slide-a')
  controls.get('followLiveBtn').click()
  assert.equal(viewer.slideId, 'slide-b')
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

console.log(`live-follow DOM: full generated handout passed real reveal mode, auto-follow, divergence, opt-out, and both live badges (${usedBrowser ? 'Playwright' : 'generated-document fallback'})`)
