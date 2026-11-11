import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { DOMParser } from '@xmldom/xmldom'
import { embedAgentSource } from '../compiler/assets/runtime/embed-agent.js'
import * as liveRuntime from '../compiler/assets/runtime/live-follow.js'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const widget = `<!doctype html><html><head><script>setTimeout(function () { ${embedAgentSource()} }, 200)</script></head><body style="height:5000px"><button id="next" onclick="document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1)">Next</button><span id="count">0</span><div id="one" style="overflow:auto;height:100px;width:100px"><div style="height:1000px"></div></div><div id="two" style="overflow:auto;height:100px;width:100px"><div style="height:1000px"></div></div></body></html>`
const attr = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const html = buildShareHtml({
  title: 'Live follow browser test',
  slug: 'live-follow-browser-test',
  liveTalkSlug: 'live-follow-browser-test',
  workerBaseUrl: 'https://live.example.test',
  includeNotes: false,
  license: null,
  styles: '',
  slides: [
    { html: `<section class="slide" data-id="widget"><div class="slide-content"><figure class="slide-embed" data-embed="local"><iframe sandbox="allow-scripts" data-embed-doc="${attr(widget)}"></iframe></figure></div></section>`, notes: '' },
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
      html: '<section class="slide" data-id="slide-b" data-nav-title="Other slide"><div class="slide-content"><h1>Other slide</h1><figure class="slide-figure"><img alt="Fixture" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22/%3E"></figure></div></section>',
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
    window.__sessionId = 'session-1'
    window.fetch = async () => ({ ok: true, json: async () => ({ live: true, sessionId: window.__sessionId }) })
    const interval = window.setInterval.bind(window)
    window.setInterval = (callback, ms, ...args) => {
      if (ms === 5000) { window.__discover = callback; return 0 }
      return interval(callback, ms, ...args)
    }
    window.WebSocket = class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      constructor(url) {
        this.url = url
        this.sessionId = window.__sessionId
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
          type: 'session.snapshot', protocol: 2, sessionId: this.sessionId, syncId: message.syncId,
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

    await page.evaluate(() => window.__liveSockets[0].emit({type:'pointer.live',pointer:{x:640,y:360,space:'slide',slideId:'slide-a'}}))
    assert.equal(await page.locator('.tw-pointer-ring').isVisible(),true,'online follower sees presenter pointer')
    await page.evaluate(() => window.__liveSockets[0].emit({type:'ink.live',ink:{slideId:'slide-a',space:'slide',strokes:[{tool:'arrow',ink:'red',width:'thin',points:[[1,1],[600,300]]}],draft:null}}))
    assert.equal(await page.locator('[data-pen-stroke]').count(),1,'online follower sees presenter ink')
    await page.locator('#nextBtn').click()
    assert.equal(await page.locator('.tw-live-overlay').isVisible(), false, 'browsing hides presenter marks')
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
    await page.evaluate(() => {
      window.__liveSockets[0].emit({ type: 'slide.state', slideId: 'widget', reveal: 0, focus: null, revision: 4 })
      // In one task, before the new iframe can announce readiness.
      for (let n = 0; n < 34; n++) window.__liveSockets[0].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'click', el: { path: [1, 0], tag: 'button', id: 'next' } } })
    })
    const frame = page.frameLocator('.slide.active iframe')
    await frame.locator('#next').waitFor()
    await frame.locator('#count').filter({ hasText: /^32$/ }).waitFor({ timeout: 3000 })
    assert.equal(await frame.locator('#count').textContent(), '32', 'pre-ready events flush through the bounded 32-event frame queue')
    await frame.locator('#count').evaluate(el => { el.textContent = '0' })
    await page.waitForTimeout(50)
    await page.evaluate(() => window.__liveSockets[0].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'click', el: { path: [1, 0], tag: 'button', id: 'next' } } }))
    await frame.locator('#count').filter({ hasText: '1' }).waitFor()
    assert.equal(await frame.locator('#count').textContent(), '1', 'presenter step reaches the online widget copy')
    await page.evaluate(() => window.__liveSockets[0].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'scroll', el: { path: [], tag: '' }, fx: 0, fy: 0.5 } }))
    assert.ok(await frame.locator('body').evaluate(() => window.scrollY > 1000), 'presenter scroll reaches the online widget copy')
    await followButton.click()
    await page.evaluate(() => {
      for (const [index, id, fy] of [[2, 'one', 0.3], [3, 'two', 0.7]]) window.__liveSockets[0].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'scroll', el: { path: [1, index], tag: 'div', id }, fx: 0, fy } })
    })
    await page.evaluate(() => window.__liveSockets[0].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'scroll', el: { path: [], tag: '' }, fx: 0, fy: 0.75 } }))
    await page.evaluate(() => window.__liveSockets[0].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'unavailable', reason: 'frozen' } }))
    assert.equal(await page.locator('.live-embed-note').count(), 0, 'unavailable notice is held while opted out')
    await followButton.click()
    const restoredScroll = await frame.locator('body').evaluate(async () => {
      const until = performance.now() + 1000
      const fraction = () => window.scrollY / (document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight)
      while (Math.abs(fraction() - 0.75) > 0.01 && performance.now() < until) await new Promise(resolve => requestAnimationFrame(resolve))
      return fraction()
    })
    assert.ok(Math.abs(restoredScroll - 0.75) < 0.01, 'resuming applies the newest scroll received while paused: ' + restoredScroll)
    const containers = await frame.locator('body').evaluate(() => ['one', 'two'].map(id => { const element = document.getElementById(id); return element.scrollTop / (element.scrollHeight - element.clientHeight) }))
    assert.ok(Math.abs(containers[0] - 0.3) < 0.01 && Math.abs(containers[1] - 0.7) < 0.01, 'independent scroll containers are both restored: ' + containers)
    assert.match(await page.locator('.live-embed-note').textContent(), /cannot show those marks online/, 'unavailable freeze uses plain text')
    // Direct live-to-live discovery: same slide IDs, no non-live response between sessions.
    // Browsing away unloads the first session's widget so any old scroll replay is observable.
    await page.evaluate(() => window.__liveSockets[0].emit({type:'ink.live',ink:{slideId:'widget',space:'slide',strokes:[{tool:'arrow',ink:'red',width:'thin',points:[[1,1],[600,300]]}],draft:null}}))
    assert.equal(await page.locator('[data-pen-stroke]').count(),1,'first session ink is visible on the reused slide')
    await page.locator('#nextBtn').click()
    await page.evaluate(async () => { window.__sessionId = 'session-2'; await window.__discover() })
    await page.waitForFunction(() => window.__liveSockets.length === 2)
    assert.equal(await page.evaluate(() => window.__liveSockets[0].readyState), 3, 'handover ends the old client')
    assert.equal(await page.locator('.live-embed-note').count(), 0, 'handover clears the old frozen note before replacement state')
    await page.evaluate(() => window.__liveSockets[1].emit({ type: 'slide.state', slideId: 'widget', reveal: 0, focus: null, revision: 1 }))
    assert.equal(await page.locator('[data-pen-stroke]').count(),0,'direct handover cannot resurrect ink from the prior session')
    const replacementFrame = page.frameLocator('.slide.active iframe')
    await replacementFrame.locator('#next').waitFor()
    await page.waitForTimeout(100)
    assert.equal(await replacementFrame.locator('body').evaluate(() => window.scrollY), 0, 'direct handover cannot replay prior-session document scroll')
    assert.deepEqual(await replacementFrame.locator('body').evaluate(() => ['one', 'two'].map(id => document.getElementById(id).scrollTop)), [0, 0], 'direct handover cannot replay prior-session panel scroll')
    assert.equal(await page.locator('.live-embed-note').count(), 0, 'replacement slide cannot resurrect prior-session frozen notice')
    await followButton.click(); await followButton.click()
    assert.equal(await page.locator('.live-embed-note').count(), 0, 'Return to presenter cannot resurrect a prior-session notice')
    assert.equal(await replacementFrame.locator('body').evaluate(() => window.scrollY), 0, 'Return to presenter cannot resurrect a prior-session scroll')
    // New-session messages still work after the cache reset.
    await page.evaluate(() => window.__liveSockets[1].emit({ type: 'embed.live', slideId: 'widget', index: 0, event: { k: 'scroll', el: { path: [], tag: '' }, fx: 0, fy: 0.25 } }))
    assert.ok(await replacementFrame.locator('body').evaluate(async () => {
      const deadline = performance.now() + 2000
      while (window.scrollY <= 500 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      return window.scrollY > 500
    }), 'replacement session can drive its own widget scroll')
    await page.evaluate(() => window.__liveSockets[1].emit({ type: 'slide.state', slideId: 'slide-b', reveal: 0, focus: null, lightbox: { open: true, index: 0 }, revision: 2 }))
    assert.equal(await page.locator('#lightbox').evaluate(el => el.classList.contains('open')), true, 'the live gallery opens online')
    await page.evaluate(() => window.__liveSockets[1].emit({ type: 'session.closed' }))
    assert.equal(await page.locator('#lightbox').evaluate(el => el.classList.contains('open')), false, 'ending live closes the live-applied gallery even without focus')
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
  let discoveredSession = 'session-1'
  const appliedEmbeds = []
  const heldEmbeds = []
  const clientSnapshots = []
  const controller = liveRuntime.createAudienceFollowRuntime({
    document,
    liveConfig: { workerBaseUrl: 'https://live.example.test', talkSlug: 'talk' },
    getViewerPosition: () => viewer,
    applyLiveSlideState(message) { viewer = { slideId: message.slideId, reveal: message.reveal, focus: message.focus }; return true },
    fetchSession: async () => ({ live: true, sessionId: discoveredSession }),
    onEmbed: message => { appliedEmbeds.push(message); heldEmbeds.push(message) },
    resetLiveEmbeds: () => { heldEmbeds.length = 0 },
    scheduleDiscovery() {},
    createClient(options) { clientSnapshots.push([...heldEmbeds]); socket = { end() {}, emit: options.onSlideState, embed: options.onEmbed }; return socket },
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
  socket.embed({type:'embed.live',slideId:'slide-b',index:0,event:{k:'scroll',el:{path:[],tag:''},fx:0,fy:0.5}})
  socket.embed({type:'embed.live',slideId:'slide-b',index:0,event:{k:'unavailable',reason:'frozen'}})
  assert.equal(appliedEmbeds.length, 2, 'first session delivered its widget state')
  appliedEmbeds.length = 0
  discoveredSession = 'session-2'
  await controller.discoverSession()
  socket.emit({type:'slide.state',slideId:'slide-b',reveal:0,focus:null,revision:1})
  assert.deepEqual(appliedEmbeds, [], 'direct handover cannot replay cached scroll or frozen notice from the prior session')
  assert.deepEqual(clientSnapshots.at(-1), [], 'page-side held embed state resets before the replacement client starts')
  controller.returnToSpeaker()
  assert.deepEqual(appliedEmbeds, [], 'Return to presenter cannot replay prior-session embed state')
  socket.embed({type:'embed.live',slideId:'slide-b',index:0,event:{k:'scroll',el:{path:[],tag:''},fx:0,fy:0.25}})
  assert.equal(appliedEmbeds.length, 1, 'replacement session events are still delivered')
}

let usedBrowser = true
try {
  await runGeneratedDocumentFallback()
  await runBrowserTest()
} catch (error) {
  const message = String(error?.message || error)
  if (!/MachPortRendezvousServer|bootstrap_check_in[^\n]*Permission denied/.test(message)) throw error
  usedBrowser = false
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(`live-follow DOM: full generated handout passed real reveal mode, auto-follow, divergence, opt-out, both live badges, and direct session handover (${usedBrowser ? 'Playwright' : 'generated-document fallback'})`)
