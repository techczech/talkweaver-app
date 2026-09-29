import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { createInstantSlideSurface } from '../compiler/assets/runtime/instant-slide.js'
import { createAudienceFollowClient, parseServerMessage } from '../compiler/assets/runtime/live-follow.js'

const html = await buildDeckHtmlFromModel({ title: 'Instant slides test', slides: [{ id: 'slide-a', title: 'First slide', blocks: [] }] })
assert.match(html, /instant-slide-surface\{/)
assert.match(html, /\["⌥⌘I","Compose an instant slide"\]/)
assert.doesNotThrow(() => new Function([...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1] || ''))

const errors = []
const broadcasts = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', (error) => errors.push(error.message))
let onInstant = () => {}
const actions = []
const dom = new JSDOM(html, {
  url: 'https://talk.example.test/?presenter=1&session=instant-test#slide-a',
  runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
  beforeParse(window) {
    window.BroadcastChannel = class { postMessage(message) { broadcasts.push(message) } addEventListener() {} }
    window.ResizeObserver = class { observe() {} disconnect() {} }
    window.twLivePollBridge = {
      fitImage: async () => ({ success: true, dataUrl: 'data:image/webp;base64,UklGRg==', width: 960, height: 600 }),
      action: async (action) => { actions.push(action); return { success: true, status: 'pending' } },
      onInstant: (callback) => { onInstant = callback }, onState() {}, onStatus() {}, onOperation() {},
    }
  },
})
const { window } = dom
const { document } = window
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(errors, [])

document.getElementById('presenterInstantButton').click()
assert.equal(document.getElementById('presenterInstantCompose').hidden, false)
document.getElementById('instantText').value = 'A point for discussion'
document.getElementById('instantText').dispatchEvent(new window.Event('input', { bubbles: true }))
document.getElementById('instantShow').click()
assert.equal(actions.at(-1).type, 'instant.show')
assert.equal(actions.at(-1).slide.text, 'A point for discussion')
onInstant(actions.at(-1).slide)
assert.equal(document.getElementById('presenterInstantStrip').hidden, false)
assert.ok(broadcasts.some((message) => message.command === 'instant' && message.slide?.text === 'A point for discussion'))
assert.match(document.getElementById('presenterInstantBack').textContent, /Back to slide 1/)
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
assert.equal(actions.at(-1).type, 'instant.clear')
onInstant(null)
assert.equal(document.getElementById('presenterInstantStrip').hidden, true)

const paste = () => {
  const event = new window.Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'https://example.test/topic' } })
  window.dispatchEvent(event)
}
paste()
assert.equal(document.getElementById('presenterInstantPaste').hidden, false)
assert.match(document.getElementById('instantPasteKind').textContent, /Link from the clipboard/)
const imagePaste = new window.Event('paste', { bubbles: true, cancelable: true })
Object.defineProperty(imagePaste, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) }], getData: () => '' } })
window.dispatchEvent(imagePaste)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.match(document.getElementById('instantPasteKind').textContent, /Image from the clipboard/)
assert.ok(document.querySelector('#instantPasteThumb .instant-slide-image'))
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
assert.equal(actions.at(-1).slide.kind, 'image')
onInstant(actions.at(-1).slide)
const imageSurface = createInstantSlideSurface(document.body, { thumbnail: true })
imageSurface.show(actions.at(-1).slide)
assert.match(imageSurface.element.querySelector('img').src, /^data:image\/webp;base64,/)
assert.match(html, /object-fit:contain/)
imageSurface.destroy()
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
assert.equal(document.getElementById('presenterInstantPaste').hidden, true)
paste()
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
assert.equal(actions.at(-1).slide.kind, 'link')
onInstant({ ...actions.at(-1).slide, qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })
assert.ok(document.querySelector('#currentPreview .instant-slide-qr img'), 'the projector preview includes the link QR')

document.getElementById('presenterInstantButton').click()
document.querySelector('[data-instant-tab="clock"]').click()
document.querySelector('[data-instant-clock="countdown"]').click()
document.querySelector('[data-instant-minutes="5"]').click()
document.getElementById('instantLabel').value = 'Discussion'
document.getElementById('instantLabel').dispatchEvent(new window.Event('input', { bubbles: true }))
document.getElementById('instantShow').click()
assert.equal(actions.at(-1).slide.durationMs, 300000)
assert.equal(actions.at(-1).slide.label, 'Discussion')
onInstant(actions.at(-1).slide)
document.getElementById('presenterInstantButton').click()
document.querySelector('[data-instant-clock="time"]').click()
document.getElementById('instantShow').click()
assert.equal(actions.at(-1).slide.kind, 'time')
onInstant(actions.at(-1).slide)

const surfaceDom = new JSDOM('<body></body>')
let now = 10_000
const surface = createInstantSlideSurface(surfaceDom.window.document.body, { now: () => now })
surface.show({ kind: 'countdown', shownAt: now, startedAt: now, durationMs: 300000, label: 'Discussion' })
assert.equal(surface.element.querySelector('.instant-slide-digits').textContent, '05:00')
now += 300000
await new Promise((resolve) => setTimeout(resolve, 120))
assert.equal(surface.element.querySelector('.instant-slide-digits').textContent, '00:00')
assert.equal(surface.element.querySelector('.instant-slide-timeup').hidden, false)
assert.equal(surface.element.querySelector('.instant-slide-bar i').style.width, '0%')
assert.match(html, /color:var\(--accent,#0a7a5c\)/)
surface.destroy()
surfaceDom.window.close()
assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: actions.at(-1).slide })).type, 'instant.state')
const received = []
let socket
const storage = { getItem() { return null }, setItem() {}, removeItem() {}, get length() { return 0 }, key() { return null } }
const phone = createAudienceFollowClient({ baseUrl: 'https://live.example.test', sessionId: 'session-a', storage,
  createSocket: () => { socket = { readyState: 1, sent: [], onopen: null, onclose: null, onerror: null, onmessage: null,
    send(value) { this.sent.push(JSON.parse(value)) }, close() {} }; return socket },
  onInstantSlide: (slide) => received.push(slide),
})
socket.onmessage({ data: JSON.stringify({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 60000 }) })
const syncId = socket.sent.at(-1).syncId
const current = { kind: 'link', url: 'https://example.test/topic', qrSvg: '<svg viewBox="0 0 1 1"></svg>', shownAt: 1000 }
socket.onmessage({ data: JSON.stringify({ type: 'session.snapshot', protocol: 2, sessionId: 'session-a', syncId,
  expiresAt: Date.now() + 60000, slideState: null, instantSlide: current, polls: [], receipts: [] }) })
assert.deepEqual(received, [current], 'a newly connected phone receives the current instant slide')
surface.show(current)
assert.ok(surface.element.querySelector('.instant-slide-qr img'), 'the same runtime renders the QR for a following screen')
const image = { kind: 'image', dataUrl: 'data:image/webp;base64,UklGRg==', width: 960, height: 600, shownAt: 2000 }
socket.onmessage({ data: JSON.stringify({ type: 'instant.state', slide: image }) })
assert.deepEqual(received.at(-1), image, 'a following phone accepts the image event')
surface.show(received.at(-1))
assert.equal(surface.element.querySelector('.instant-slide-image').getAttribute('src'), image.dataUrl)
window.twLivePollBridge.fitImage = async () => ({ success: false, error: 'This image is too detailed to show live. Try a smaller screenshot or crop it first.' })
const refusedPaste = new window.Event('paste', { bubbles: true, cancelable: true })
Object.defineProperty(refusedPaste, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) }], getData: () => '' } })
window.dispatchEvent(refusedPaste)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.match(document.getElementById('instantPasteValue').textContent, /too detailed to show live/)
assert.equal(document.getElementById('instantPasteShow').disabled, true)
const sentBeforeRefusal = actions.length
document.getElementById('instantPasteShow').click()
assert.equal(actions.length, sentBeforeRefusal, 'an image that cannot fit is never sent')
paste()
assert.equal(document.getElementById('instantPasteShow').disabled, false, 'a later text paste is showable')
window.twLivePollBridge.fitImage = async () => ({ success: true, dataUrl: image.dataUrl, width: 960, height: 600 })
document.getElementById('presenterInstantButton').click()
document.querySelector('[data-instant-tab="image"]').click()
const drop = new window.Event('drop', { bubbles: true, cancelable: true })
Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ type: 'image/png', arrayBuffer: async () => new ArrayBuffer(8) }] } })
document.getElementById('instantImageDrop').dispatchEvent(drop)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(document.getElementById('instantShow').disabled, false)
assert.ok(document.querySelector('#instantComposeThumb .instant-slide-image'))
document.getElementById('instantShow').click()
assert.equal(actions.at(-1).slide.kind, 'image', 'the Image tab accepts a dropped image')
phone.end()
dom.window.close()
console.log('instant-slide DOM: composer, paste preview, return, countdown and follow message passed')
