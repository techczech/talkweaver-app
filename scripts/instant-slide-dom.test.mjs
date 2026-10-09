import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { createInstantSlideSurface } from '../compiler/assets/runtime/instant-slide.js'
import { createAudienceFollowClient, parseServerMessage } from '../compiler/assets/runtime/live-follow.js'

const html = await buildDeckHtmlFromModel({ title: 'Instant slides test', slides: [{ id: 'slide-a', title: 'First slide', blocks: [] }] })
assert.match(html, /instant-slide-surface\{/)
const help = JSON.parse(html.match(/const SHORTCUTS_LIST = (\[.*\]);/)[1])
const instantKey = help.flatMap(([, rows]) => rows).find(row => row[3] === 'presenter.instant-compose')
assert.deepEqual(instantKey.slice(0, 2), ['⌥⌘I', 'Compose an instant slide'])
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
const surface = createInstantSlideSurface(surfaceDom.window.document.body, { now: () => now, showQr: true })
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
// Label presets in the composer (0.37): chips fill the label, the active one clears it, no label by default.
// (The live echo of the image slide just shown clears the composer's pending state, as it does in the app.)
onInstant(actions.at(-1).slide)
{
  document.getElementById('presenterInstantButton').click()
  document.querySelector('[data-instant-tab="clock"]').click()
  document.querySelector('[data-instant-clock="countdown"]').click()
  const chips = [...document.querySelectorAll('#instantLabelPresets [data-instant-label]')]
  assert.deepEqual(chips.map((c) => c.textContent), ['Break', 'Discussion', 'Group work'])
  chips[1].click(); assert.equal(document.getElementById('instantLabel').value, ''); assert.ok(!chips[1].classList.contains('on'), 'clicking the active preset clears it')
  document.getElementById('instantShow').click()
  assert.equal(actions.at(-1).slide.label, '')
  onInstant(actions.at(-1).slide)
  chips[2].click()
  assert.equal(document.getElementById('instantLabel').value, 'Group work')
  assert.ok(chips[2].classList.contains('on'))
  document.getElementById('instantShow').click()
  assert.equal(actions.at(-1).slide.label, 'Group work')
  chips[2].click()
  assert.equal(document.getElementById('instantLabel').value, '')
  assert.ok(!chips[2].classList.contains('on'))
}

// Text, link and QR together (0.37): separate Text and Link fields; the slide shows the text, a clickable link and the link's QR.
{
  const qrSvg = (url) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>${url}</title><path d="M0 0h1v1H0z"/></svg>`
  const qrAsked = []
  const sent = []
  const linkDom = new JSDOM(html, {
    url: 'https://talk.example.test/?presenter=1&session=link-test#slide-a', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.BroadcastChannel = class { postMessage() {} addEventListener() {} }
      win.ResizeObserver = class { observe() {} disconnect() {} }
      win.twLivePollBridge = { action: async (action) => { sent.push(action); return { success: true, status: 'pending' } },
        qrSvg: async (url) => { qrAsked.push(url); return { success: true, svg: qrSvg(url) } },
        onInstant() {}, onState() {}, onStatus() {}, onOperation() {}, onJoin() {} }
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const doc = linkDom.window.document
  const type = (id, value) => { const el = doc.getElementById(id); el.value = value; el.dispatchEvent(new linkDom.window.Event('input', { bubbles: true })) }
  const wait = () => new Promise((resolve) => setTimeout(resolve, 10))
  doc.getElementById('presenterInstantButton').click()
  assert.ok(doc.getElementById('instantLink'), 'the composer has a Link field beside Text')
  assert.equal(doc.getElementById('instantLinkField').hidden, false)
  type('instantText', 'Tell us what you think')
  type('instantLink', 'example.com/form')
  await wait()
  assert.deepEqual(qrAsked, ['https://example.com/form'], 'the QR is asked for the normalised address')
  const thumb = doc.getElementById('instantComposeThumb')
  assert.equal(thumb.querySelector('.instant-slide-text').textContent, 'Tell us what you think')
  assert.equal(thumb.querySelector('.instant-slide-link').textContent, 'example.com/form', 'link written without the scheme')
  assert.ok(thumb.querySelector('.instant-slide-qr img'), 'composer preview shows the link QR')
  doc.getElementById('instantShow').click()
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1).slide)), { kind: 'text', text: 'Tell us what you think', link: 'https://example.com/form', linkQrSvg: qrSvg('https://example.com/form'), shownAt: sent.at(-1).slide.shownAt })

  // a refused link: quiet note, nothing to show
  const refused = new JSDOM(html, { url: 'https://talk.example.test/?presenter=1&session=link-refuse#slide-a', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) { win.BroadcastChannel = class { postMessage() {} addEventListener() {} }; win.ResizeObserver = class { observe() {} disconnect() {} }
      win.twLivePollBridge = { action: async () => ({ success: true }), onInstant() {}, onState() {}, onStatus() {}, onOperation() {}, onJoin() {} } } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const rdoc = refused.window.document
  rdoc.getElementById('presenterInstantButton').click()
  for (const [id, value] of [['instantText', 'Hello'], ['instantLink', 'javascript:alert(1)']]) { const el = rdoc.getElementById(id); el.value = value; el.dispatchEvent(new refused.window.Event('input', { bubbles: true })) }
  assert.equal(rdoc.getElementById('instantLinkNote').hidden, false)
  assert.match(rdoc.getElementById('instantLinkNote').textContent, /http/)
  assert.equal(rdoc.getElementById('instantShow').disabled, true, 'a refused link cannot be shown')
  rdoc.getElementById('instantLink').value = ''
  rdoc.getElementById('instantLink').dispatchEvent(new refused.window.Event('input', { bubbles: true }))
  assert.equal(rdoc.getElementById('instantLinkNote').hidden, true)
  assert.equal(rdoc.getElementById('instantShow').disabled, false, 'clearing the link brings the text back')
  refused.window.close()

  // the shared surface: text + clickable link + QR on a following screen; a countdown's own link QR replaces the talk's
  const doc2 = new JSDOM('<body></body>').window.document
  const talk = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>talk</title></svg>', url: 'https://handouts.fyi/k7m2', link: true }
  const view = createInstantSlideSurface(doc2.body, { qr: () => talk, showQr: true })
  const own = qrSvg('https://example.com/form')
  view.show({ kind: 'text', text: 'Tell us what you think', link: 'https://example.com/form', linkQrSvg: own, shownAt: 1 })
  assert.equal(view.element.querySelector('.instant-slide-text').textContent, 'Tell us what you think')
  const anchor = view.element.querySelector('.instant-slide-link a')
  assert.equal(anchor.getAttribute('href'), 'https://example.com/form')
  assert.equal(anchor.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(anchor.textContent, 'example.com/form')
  assert.equal(decodeURIComponent(view.element.querySelector('.instant-slide-qr img').getAttribute('src').split(',')[1]), own)
  assert.equal(view.element.querySelector('.instant-slide-corner'), null, 'a text slide with its own link shows that QR, not the talk corner')
  view.show({ kind: 'text', text: 'Only text', shownAt: 2 })
  assert.equal(view.element.querySelector('.instant-slide-link'), null)
  assert.match(decodeURIComponent(view.element.querySelector('.instant-slide-corner-qr img').getAttribute('src')), /<title>talk<\/title>/, 'with no link, the talk QR is the slide QR')
  assert.equal(view.element.querySelector('.instant-slide-corner-link').textContent, 'handouts.fyi/k7m2')
  view.show({ kind: 'countdown', startedAt: Date.now(), durationMs: 60000, shownAt: 3, link: 'https://example.com/form', linkQrSvg: own })
  assert.equal(decodeURIComponent(view.element.querySelector('.instant-slide-corner-qr img').getAttribute('src').split(',')[1]), own, 'the link QR replaces the talk QR')
  assert.equal(view.element.querySelectorAll('.instant-slide-corner-qr').length, 1)
  assert.equal(view.element.querySelector('.instant-slide-corner-link a').getAttribute('href'), 'https://example.com/form')
  view.show({ kind: 'countdown', startedAt: Date.now(), durationMs: 60000, shownAt: 4 })
  assert.match(decodeURIComponent(view.element.querySelector('.instant-slide-corner-qr img').getAttribute('src')), /<title>talk<\/title>/, 'without a link the talk QR stays')
  const room = createInstantSlideSurface(doc2.body, { clickable: false, showQr: true })
  room.show({ kind: 'text', text: 'Projected', link: 'https://example.com/form', shownAt: 5 })
  assert.equal(room.element.querySelector('.instant-slide-link a'), null, 'the projector window shows the link as text, not an anchor')
  assert.equal(room.element.querySelector('.instant-slide-link').textContent, 'example.com/form')
  view.destroy(); room.destroy()
  // a phone accepts the new fields
  assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: { kind: 'text', text: 'T', link: 'https://example.com/form', linkQrSvg: own, shownAt: 1 } })).slide.link, 'https://example.com/form')
  assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: { kind: 'text', text: 'T', link: 'javascript:alert(1)', shownAt: 1 } })), null, 'a phone refuses a non-web link')
  assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: { kind: 'countdown', startedAt: 1, durationMs: 60000, endSound: 'alarm', shownAt: 1 } })).slide.endSound, 'alarm')
  assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: { kind: 'countdown', startedAt: 1, durationMs: 60000, endSound: 'siren', shownAt: 1 } })), null)
  assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: { kind: 'text', text: 'T', link: 'https://x.com/a>b', shownAt: 1 } })).slide.link, 'https://x.com/a%3Eb', 'a phone forwards the canonical href')
  assert.equal(parseServerMessage(JSON.stringify({ type: 'instant.state', slide: { kind: 'text', text: 'T', link: 'https://x.com/?q=`', shownAt: 1 } })), null)
  linkDom.window.close()
}
phone.end()
dom.window.close()
await Promise.resolve()
assert.deepEqual(errors, [], 'closing needs no unload dispatch')
console.log('instant-slide DOM: composer, paste preview, return, countdown and follow message passed')

