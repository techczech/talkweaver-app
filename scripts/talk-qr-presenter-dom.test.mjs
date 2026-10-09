// Live-presenting ticket 04 (frame V6): "Show the talk's QR code" from any slide. Drives the
// compiled presenter template in jsdom: the U key and the palette command, the overlay on the
// presenter and the paired projector window, the live-vs-handout link, the data stamp the live
// bridge publishes to the venue screen, and Esc / U returning to the slide it left.
import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { presenterLiveSlideState } from '../src/preload/present-live-state.ts'

const slides = [
  { id: 'slide-a', title: 'First slide', blocks: [] },
  { id: 'slide-b', title: 'Second slide', blocks: [{ type: 'paragraph', text: 'No QR code here' }] },
  { id: 'slide-c', title: 'Third slide', blocks: [] },
]
const html = await buildDeckHtmlFromModel({ title: 'Talk QR test', slides, meta: { handout_url: 'https://handouts.fyi/k7m2' } })
assert.match(html, /<template id="twTalkQr" data-url="https:\/\/handouts\.fyi\/k7m2"><svg/)
const help = JSON.parse(html.match(/const SHORTCUTS_LIST = (\[.*\]);/)[1])
const qrKey = help.flatMap(([, rows]) => rows).find(row => row[3] === 'presenter.talk-qr')
assert.deepEqual(qrKey.slice(0, 2), ['U', "Show the talk's QR code"], 'the cheat sheet lists the command with its key')
assert.doesNotThrow(() => new Function([...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1] || ''))

function open(markup, role, bridge) {
  const errors = []
  const broadcasts = []
  const listeners = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(error.message))
  const dom = new JSDOM(markup, {
    url: `https://talk.example.test/?${role}=1&session=talk-qr-test#slide-a`,
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.BroadcastChannel = class {
        postMessage(message) { broadcasts.push(message) }
        addEventListener(type, callback) { if (type === 'message') listeners.push(callback) }
      }
      window.ResizeObserver = class { observe() {} disconnect() {} }
      if (bridge) window.twLivePollBridge = bridge
    },
  })
  return { dom, window: dom.window, document: dom.window.document, errors, broadcasts, listeners }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const key = (window, value, extra = {}) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, ...extra }))
const activeId = (document) => document.querySelector('.slide.active')?.dataset.id
const overlay = (document) => document.querySelector('.qr-fullscreen.talk-qr')

let onStatus = () => {}
let onJoin = () => {}
const presenter = open(html, 'presenter', {
  action: async () => ({ success: true, status: 'pending' }),
  onInstant() {}, onState() {}, onOperation() {},
  onStatus: (callback) => { onStatus = callback },
  onJoin: (callback) => { onJoin = callback },
})
const projector = open(html, 'audience', null)
await settle()
assert.deepEqual(presenter.errors, [])
assert.deepEqual(projector.errors, [])
const relay = () => {
  // What the presenter sends its peer is what the projector window applies.
  for (const message of presenter.broadcasts.splice(0)) for (const listener of projector.listeners) listener({ data: message })
}

// Move to a slide with no QR code on it, then show the talk's QR code with U.
key(presenter.window, 'ArrowRight')
relay()
assert.equal(activeId(presenter.document), 'slide-b')
assert.equal(activeId(projector.document), 'slide-b')
assert.equal(presenter.document.querySelector('.slide.active .slide-qr'), null, 'the slide itself has no QR code')
key(presenter.window, 'u')
relay()
for (const side of [presenter, projector]) {
  const shown = overlay(side.document)
  assert.ok(shown, 'the overlay is up')
  assert.equal(shown.querySelector('.qr-fs-url').textContent, 'handouts.fyi/k7m2', 'not live: the published handout link')
  assert.equal(shown.querySelector('.qr-fs-url strong').textContent, '/k7m2', 'the talk id is bold')
  assert.ok(shown.querySelector('.qr-fs-code svg'), 'the QR code is drawn')
}
assert.equal(presenter.document.documentElement.dataset.twLiveTalkQr, '1', 'the live bridge sees the overlay')
const published = presenterLiveSlideState(presenter.window.location.hash, presenter.document.querySelector('.slide.active'), presenter.document.documentElement.dataset)
assert.equal(published.slideId, 'slide-b')
assert.equal(published.talkQr, true, 'the venue screen is told to show it')

// Navigation is suspended while it is up; Esc returns to the same slide on both screens.
key(presenter.window, 'ArrowRight')
relay()
assert.equal(activeId(presenter.document), 'slide-b')
assert.ok(overlay(projector.document))
key(presenter.window, 'Escape')
relay()
for (const side of [presenter, projector]) {
  assert.equal(overlay(side.document), null, 'Esc closes the overlay')
  assert.equal(activeId(side.document), 'slide-b', 'Esc returns to the slide it left')
}
assert.equal(presenter.document.documentElement.dataset.twLiveTalkQr, '')
assert.equal(presenterLiveSlideState(presenter.window.location.hash, presenter.document.querySelector('.slide.active'), presenter.document.documentElement.dataset).talkQr, undefined)

// The command again (U) toggles it off too.
key(presenter.window, 'U', { shiftKey: false })
relay()
assert.ok(overlay(projector.document))
key(presenter.window, 'u')
relay()
assert.equal(overlay(presenter.document), null)
assert.equal(overlay(projector.document), null)
assert.equal(activeId(projector.document), 'slide-b')

// While live, the link is the live audience link.
onStatus('live')
onJoin({ shortUrl: 'https://handouts.fyi/live9', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" data-live="1"></svg>' })
key(presenter.window, 'u')
relay()
assert.equal(overlay(projector.document).querySelector('.qr-fs-url').textContent, 'handouts.fyi/live9', 'live: the audience link')
assert.ok(overlay(projector.document).querySelector('svg[data-live="1"]'))
key(presenter.window, 'Escape')
relay()
onStatus('ended')
key(presenter.window, 'u')
relay()
assert.equal(overlay(projector.document).querySelector('.qr-fs-url').textContent, 'handouts.fyi/k7m2', 'after End live it falls back to the handout')
key(presenter.window, 'u')
relay()

// Palette: the command is listed with its shortcut and runs.
key(presenter.window, 'P', { metaKey: true, shiftKey: true })
const palette = presenter.document.getElementById('presenterCommandPalette')
assert.equal(palette.hidden, false)
const entry = [...presenter.document.querySelectorAll('#presenterCommandResults button')].find((button) => button.querySelector('.tw-pal-name')?.textContent === 'Show talk QR code')
assert.ok(entry, 'the palette lists the command')
assert.equal(entry.querySelector('.tw-pal-keys').textContent, 'U', 'with its shortcut')
entry.click()
relay()
assert.ok(overlay(projector.document), 'the palette command shows the overlay')
assert.equal(activeId(projector.document), 'slide-b')
key(presenter.window, 'Escape')
relay()
assert.equal(overlay(projector.document), null)

// The cheat sheet shows it.
key(presenter.window, '?')
assert.match(presenter.document.getElementById('twShortcutsBody').textContent, /Show the talk's QR code/)
key(presenter.window, 'Escape')

// A slide change from elsewhere (overview jump, peer) drops the overlay rather than stranding it.
key(presenter.window, 'u')
relay()
presenter.window.location.hash = '#slide-c'
await settle()
relay()
assert.equal(activeId(presenter.document), 'slide-c')
assert.equal(overlay(presenter.document), null)
assert.equal(overlay(projector.document), null)
assert.deepEqual(presenter.errors, [])
assert.deepEqual(projector.errors, [])
presenter.window.close()
projector.window.close()
await settle()
assert.deepEqual(presenter.errors, [])
assert.deepEqual(projector.errors, [])

// A talk with no published handout and no live session: the command explains itself instead.
const unpublished = open(await buildDeckHtmlFromModel({ title: 'Unpublished', slides }), 'presenter', null)
await settle()
key(unpublished.window, 'u')
assert.equal(overlay(unpublished.document), null)
assert.match(unpublished.document.getElementById('modeBanner').textContent, /publish the handout or go live/)
assert.deepEqual(unpublished.errors, [])
unpublished.window.close()
await settle()
assert.deepEqual(unpublished.errors, [])

console.log('talk QR presenter DOM: U key, palette, cheat sheet, projector overlay, live vs handout link, Esc return passed')
