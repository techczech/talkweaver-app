// Break slide: the end-of-break sound choice (none / chime / alarm), the talk's QR (and handout link) bottom-right, and the end-of-break chime on room screens only.
// Seams: createInstantSlideSurface / nextBreakEnd / createBreakChime (compiler/assets/runtime/instant-slide.js).
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createInstantSlideSurface, createBreakChime, nextBreakEnd, writtenInstantLink, instantEndSound } from '../compiler/assets/runtime/instant-slide.js'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const countdown = (startedAt, durationMs, extra = {}) => ({ kind: 'countdown', startedAt, durationMs, shownAt: startedAt, ...extra })

// --- the decision: fires once, when a running countdown reaches zero, on room surfaces only
{
  const slide = countdown(1000, 5000)
  let step = nextBreakEnd(null, slide, 3000, true)
  assert.equal(step.play, false, 'running: silent')
  step = nextBreakEnd(step.state, slide, 0, true)
  assert.equal(step.play, true, 'zero on a room screen: plays')
  step = nextBreakEnd(step.state, slide, 0, true)
  assert.equal(step.play, false, 'a re-render at zero does not play again')
  const phone = nextBreakEnd(nextBreakEnd(null, slide, 3000, false).state, slide, 0, false)
  assert.equal(phone.play, false, 'phone: never')
  const off = nextBreakEnd(nextBreakEnd(null, { ...slide, soundAtEnd: false }, 3000, true).state, { ...slide, soundAtEnd: false }, 0, true)
  assert.equal(off.play, false, 'toggle off: never')
  assert.equal(nextBreakEnd(nextBreakEnd(null, { ...slide, soundAtEnd: true }, 3000, true).state, { ...slide, soundAtEnd: true }, 0, true).play, true)
  assert.equal(nextBreakEnd(null, slide, 0, true).play, false, 'first seen already finished (late join): silent')
  // restarted to another value: a new countdown, armed afresh, plays once at its own zero
  const restarted = countdown(9000, 60000)
  let again = nextBreakEnd(step.state, restarted, 60000, true)
  assert.equal(again.play, false)
  again = nextBreakEnd(again.state, restarted, 0, true)
  assert.equal(again.play, true)
  assert.equal(nextBreakEnd(again.state, restarted, 0, true).play, false)
}

// --- endSound: none / chime / alarm, and the old boolean soundAtEnd
{
  const at = (slide, plays = true) => nextBreakEnd(nextBreakEnd(null, slide, 3000, plays).state, slide, 0, plays)
  const base = countdown(1000, 5000)
  const table = [
    [{ endSound: 'none' }, null], [{ endSound: 'chime' }, 'chime'], [{ endSound: 'alarm' }, 'alarm'],
    [{ soundAtEnd: true }, 'chime'], [{ soundAtEnd: false }, null], [{}, 'chime'],
    [{ endSound: 'alarm', soundAtEnd: false }, 'alarm'], [{ endSound: 'bogus', soundAtEnd: false }, null], [{ endSound: 'bogus' }, 'chime'],
  ]
  for (const [extra, sound] of table) {
    const step = at({ ...base, ...extra })
    assert.equal(step.sound, sound, JSON.stringify(extra) + ' plays ' + sound)
    assert.equal(step.play, sound !== null)
    assert.equal(at({ ...base, ...extra }, false).play, false, 'phone: never, whatever the choice')
  }
  assert.equal(instantEndSound(null), 'chime')
  assert.deepEqual(['none', 'chime', 'alarm', 'on', 'off'].map((stored) => instantEndSound({ endSound: stored, soundAtEnd: stored === 'off' ? false : undefined })), ['none', 'chime', 'alarm', 'chime', 'none'], 'older stored choices map across')
  // once only: an alarm at zero does not repeat on re-render, and a restarted countdown plays again
  const alarm = { ...base, endSound: 'alarm' }
  let step = nextBreakEnd(nextBreakEnd(null, alarm, 3000, true).state, alarm, 0, true)
  assert.equal(nextBreakEnd(step.state, alarm, 0, true).play, false)
  assert.equal(nextBreakEnd(null, alarm, 0, true).play, false, 'late join: silent, whatever the sound')
}

// --- the surface: room vs phone, toggle, re-show, restart
const { window } = new JSDOM('<body></body>')
const { document } = window
let clock = 10_000
const chimes = []
const room = createInstantSlideSurface(document.body, { now: () => clock, chime: { play: () => chimes.push(clock) } })
const phone = createInstantSlideSurface(document.body, { now: () => clock })
room.show(countdown(10_000, 2000))
phone.show(countdown(10_000, 2000))
await wait(150)
assert.equal(chimes.length, 0)
clock = 12_100
await wait(250)
assert.equal(chimes.length, 1, 'room screen chimes at zero')
room.show(countdown(10_000, 2000))
await wait(250)
assert.equal(chimes.length, 1, 're-rendering the same finished countdown does not chime again')
room.show(countdown(12_100, 1000, { endSound: 'none' }))
await wait(150)
clock = 13_200
await wait(250)
assert.equal(chimes.length, 1, 'toggle off: no chime')
room.show(countdown(13_200, 3000))
await wait(150)
room.show(countdown(13_300, 1000))
await wait(150)
clock = 14_400
await wait(250)
assert.equal(chimes.length, 2, 'restarted to another value: chimes once at its own zero')
room.destroy(); phone.destroy()
{
  const kinds = []
  const alarmRoom = createInstantSlideSurface(document.body, { now: () => clock, chime: { play: (kind) => kinds.push(kind) } })
  alarmRoom.show(countdown(14_400, 1000, { endSound: 'alarm' }))
  await wait(150)
  clock = 15_500
  await wait(250)
  assert.deepEqual(kinds, ['alarm'], 'the surface asks the player for the chosen sound')
  alarmRoom.destroy()
}

// --- QR and link placement
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>'
const corner = (options, slide = countdown(1000, 60000)) => {
  const surface = createInstantSlideSurface(document.body, { now: () => 1000, showQr: true, ...options })
  surface.show(slide)
  const el = surface.element
  const found = { box: el.querySelector('.instant-slide-corner'), img: el.querySelector('.instant-slide-corner-qr img'), link: el.querySelector('.instant-slide-corner-link'), inContent: el.querySelector('.instant-slide-content .instant-slide-corner') }
  surface.destroy()
  return found
}
let c = corner({ qr: () => ({ svg, url: 'https://handouts.fyi/k7m2', link: true }) })
assert.ok(c.box && c.img, 'QR present')
assert.match(c.img.getAttribute('src'), /^data:image\/svg\+xml/)
assert.equal(c.link.textContent, 'handouts.fyi/k7m2', 'handout link written beside the QR')
assert.equal(c.link.querySelector('strong').textContent, '/k7m2')
assert.equal(c.inContent, null, 'corner sits outside the centred content, so it never pushes the countdown')
c = corner({ qr: () => ({ svg, url: 'https://live.example/abc', link: false }) })
assert.ok(c.img, 'QR without a handout')
assert.equal(c.link, null, 'no link text when the talk has no published handout')
c = corner({ qr: () => null })
assert.equal(c.box, null, 'no QR available: nothing drawn')
c = corner({})
assert.equal(c.box, null, 'phones pass no QR provider: nothing drawn')
c = corner({ qr: () => ({ svg, url: 'https://handouts.fyi/k7m2', link: true }) }, { kind: 'time', shownAt: 1000 })
assert.ok(c.img, 'the clock slide carries it too')
// With no link of its own, an instant slide shows the talk's QR and handout link; with one, that link's QR.
const talkQr = { qr: () => ({ svg, url: 'https://handouts.fyi/k7m2', link: true }) }
c = corner(talkQr, { kind: 'text', text: 'Hello', shownAt: 1000 })
assert.ok(c.img, 'a text slide without a link shows the talk QR')
assert.equal(c.link.textContent, 'handouts.fyi/k7m2', 'and the handout link as text')
c = corner({ qr: () => ({ svg, url: 'https://live.example/abc', link: false }) }, { kind: 'text', text: 'Hello', shownAt: 1000 })
assert.ok(c.img && c.link === null, 'no published handout: the QR alone, no link text')
c = corner(talkQr, { kind: 'text', text: 'Hello', link: 'https://example.com/form', linkQrSvg: svg, shownAt: 1000 })
assert.equal(c.box, null, 'a text slide with its own link shows that link and QR, not the talk corner')
c = corner(talkQr, { kind: 'countdown', startedAt: 1000, durationMs: 60000, shownAt: 1000, link: 'https://example.com/form', linkQrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><title>own</title></svg>' })
assert.match(decodeURIComponent(c.img.getAttribute('src')), /<title>own<\/title>/, 'a countdown with a link: that link\'s QR in the corner')
assert.equal(c.link.textContent, 'example.com/form', 'and that link written, not the handout')
c = corner(talkQr, { kind: 'countdown', startedAt: 1000, durationMs: 60000, shownAt: 1000 })
assert.equal(c.link.textContent, 'handouts.fyi/k7m2', 'a countdown with no link: the talk')
// Phones opt in to no QR at all: not the talk's, not a link's; the clickable link and the text remain.
const phoneOpts = { showQr: false }
const ownSvg = '<svg xmlns="http://www.w3.org/2000/svg"><title>own</title></svg>'
for (const slide of [
  { kind: 'text', text: 'Hi', link: 'https://example.com/form', linkQrSvg: ownSvg, shownAt: 1 },
  { kind: 'countdown', startedAt: 1000, durationMs: 60000, shownAt: 1, link: 'https://example.com/form', linkQrSvg: ownSvg },
  { kind: 'link', url: 'https://example.com/form', qrSvg: ownSvg, shownAt: 1 },
  { kind: 'text', text: 'Hi', shownAt: 1 }, { kind: 'time', shownAt: 1 },
]) {
  const p = createInstantSlideSurface(document.body, { now: () => 1000, qr: () => ({ svg, url: 'https://handouts.fyi/k7m2', link: true }), ...phoneOpts })
  p.show(slide)
  assert.equal(p.element.querySelector('img'), null, slide.kind + ' on a phone: no QR of any kind')
  assert.equal(p.element.querySelector('.instant-slide-qr, .instant-slide-corner-qr'), null, 'not even an empty QR box')
  if (slide.link || slide.url) assert.equal(p.element.querySelector('a').getAttribute('href'), 'https://example.com/form', 'the link stays clickable')
  p.destroy()
}
c = corner({}, { kind: 'text', text: 'Hello', shownAt: 1000 })
assert.equal(c.box, null, 'phones: no talk QR on a text slide')
c = corner(talkQr, { kind: 'image', dataUrl: 'data:image/webp;base64,UklGRg==', width: 10, height: 10, shownAt: 1000 })
assert.equal(c.box, null, 'an image fills the screen: no corner')
assert.deepEqual(writtenInstantLink('https://www.handouts.fyi/k7m2/'), { host: 'handouts.fyi', path: '/k7m2' })

// --- the chime player: blocked audio fails silently; the first gesture unlocks it
{
  const notes = []
  class Ctx {
    state = 'suspended'; currentTime = 0; destination = {}
    resume() { return new Promise((resolve) => { this.pending = () => { this.state = 'running'; resolve() } }) }
    createOscillator() { notes.push(1); return { frequency: {}, connect() {}, start() {}, stop() {} } }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  }
  const fake = new JSDOM('<body></body>').window
  fake.AudioContext = Ctx
  const chime = createBreakChime(fake)
  assert.equal(chime.play(), false, 'blocked: returns false, throws nothing')
  assert.equal(notes.length, 0)
  fake.document.dispatchEvent(new fake.Event('keydown', { bubbles: true }))
  const ctx = chime.unlock()
  ctx.pending()
  await wait(0)
  assert.equal(chime.play(), true)
  assert.equal(notes.length, 2, 'two soft notes')
  notes.length = 0
  assert.equal(chime.play('alarm'), true)
  assert.equal(notes.length, 6, 'alarm: three rising beeps, twice')
  notes.length = 0
  assert.equal(chime.play('chime'), true)
  assert.equal(notes.length, 2)
  assert.equal(createBreakChime({}).play(), false, 'no WebAudio at all: silent')
  const throwing = new JSDOM('<body></body>').window
  throwing.AudioContext = class { constructor() { throw new Error('blocked') } }
  assert.equal(createBreakChime(throwing).play(), false)
}

// --- the page wiring: composer toggle on by default, room-only chime, no chime or QR for phones
const html = await buildDeckHtmlFromModel({ title: 'Break test', slides: [{ id: 'a', title: 'A', blocks: [] }], meta: { handout_url: 'https://handouts.fyi/k7m2' } })
assert.match(html, /data-instant-sound="chime" aria-pressed="true"/, 'Sound at end defaults to the chime')
assert.match(html, /data-instant-sound="none"[^>]*>None<[\s\S]*data-instant-sound="alarm"[^>]*>Alarm</, 'None / Chime / Alarm')
assert.match(html, /isAudience \? createBreakChime\(window\) : null/, 'only the audience window chimes, not every non-presenter window')
assert.match(html, /window\.__twUnlockChime/, 'main can unlock the chime from a user-gesture script')
assert.match(html, /endSound: instantSound/)

// --- the presenter composer: "Sound at end" defaults on, rides the slide, and is remembered
async function composer(stored) {
  const actions = []
  const dom = new JSDOM(html, {
    url: 'https://talk.example.test/?presenter=1&session=sound-test#a', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.BroadcastChannel = class { postMessage() {} addEventListener() {} }
      win.ResizeObserver = class { observe() {} disconnect() {} }
      if (stored) win.localStorage.setItem('html-presentations:instant-sound', stored)
      win.twLivePollBridge = { action: async (action) => { actions.push(action); return { success: true, status: 'pending' } },
        onInstant() {}, onState() {}, onStatus() {}, onOperation() {}, onJoin() {} }
    },
  })
  await wait(30)
  const doc = dom.window.document
  doc.getElementById('presenterInstantButton').click()
  doc.querySelector('[data-instant-tab="clock"]').click()
  doc.querySelector('[data-instant-clock="countdown"]').click()
  return { dom, doc, actions }
}
{
  const fresh = await composer()
  const pressed = (doc, value) => doc.querySelector(`[data-instant-sound="${value}"]`).getAttribute('aria-pressed')
  assert.equal(pressed(fresh.doc, 'chime'), 'true', 'default: chime')
  fresh.doc.getElementById('instantShow').click()
  assert.equal(fresh.actions.at(-1).slide.endSound, 'chime')
  assert.equal(fresh.actions.at(-1).slide.soundAtEnd, true, 'the boolean rides along for older screens')
  fresh.doc.querySelector('[data-instant-sound="alarm"]').click()
  assert.equal(pressed(fresh.doc, 'alarm'), 'true')
  assert.equal(pressed(fresh.doc, 'chime'), 'false')
  assert.equal(fresh.dom.window.localStorage.getItem('html-presentations:instant-sound'), 'alarm', 'the choice is stored')
  // (a shown slide stays pending until the live echo, so the next show comes from a new session)
  const next = await composer('alarm')
  assert.equal(pressed(next.doc, 'alarm'), 'true', 'remembered on the next session')
  next.doc.getElementById('instantShow').click()
  assert.equal(next.actions.at(-1).slide.endSound, 'alarm', 'alarm rides the slide to the room screens')
  const none = await composer('none')
  none.doc.getElementById('instantShow').click()
  assert.equal(none.actions.at(-1).slide.endSound, 'none')
  assert.equal(none.actions.at(-1).slide.soundAtEnd, false)
  const legacy = await composer('off')
  assert.equal(pressed(legacy.doc, 'none'), 'true', 'a stored "off" from the on/off toggle reads as none')
  const legacyOn = await composer('on')
  assert.equal(pressed(legacyOn.doc, 'chime'), 'true', 'a stored "on" reads as chime')
  // a link on the countdown rides the slide, normalised, and its QR replaces the talk's in the preview
  const linked = await composer('alarm')
  const linkInput = linked.doc.getElementById('instantLink')
  assert.equal(linked.doc.getElementById('instantLinkField').hidden, false, 'the countdown has the Link field too')
  linkInput.value = 'example.com/form'
  linkInput.dispatchEvent(new linked.dom.window.Event('input', { bubbles: true }))
  assert.match(linked.doc.querySelector('#instantComposeThumb .instant-slide-corner-link').textContent, /^example\.com\/form$/, 'preview names the link, not the handout')
  linked.doc.getElementById('instantShow').click()
  assert.equal(linked.actions.at(-1).slide.link, 'https://example.com/form')
  assert.equal(linked.actions.at(-1).slide.endSound, 'alarm')
  linked.dom.window.close()
  // the compiled deck's compose thumbnail carries the QR and handout link
  assert.ok(fresh.doc.querySelector('#instantComposeThumb .instant-slide-corner-qr img'), 'composer preview shows the corner QR')
  assert.equal(fresh.doc.querySelector('#instantComposeThumb .instant-slide-corner-link').textContent, 'handouts.fyi/k7m2')
  fresh.dom.window.close(); next.dom.window.close(); none.dom.window.close(); legacy.dom.window.close(); legacyOn.dom.window.close()
}

// --- live session + published handout: QR = the live join link, written link = the handout
{
  let join = () => {}; let status = () => {}
  const dom = new JSDOM(html, {
    url: 'https://talk.example.test/?presenter=1&session=join-test#a', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.BroadcastChannel = class { postMessage() {} addEventListener() {} }
      win.ResizeObserver = class { observe() {} disconnect() {} }
      win.twLivePollBridge = { action: async () => ({ success: true }), onInstant() {}, onState() {}, onStatus: (cb) => { status = cb },
        onOperation() {}, onJoin: (cb) => { join = cb } }
    },
  })
  await wait(30)
  const doc = dom.window.document
  const open = () => {
    doc.getElementById('presenterInstantButton').click()
    doc.querySelector('[data-instant-tab="clock"]').click()
    doc.querySelector('[data-instant-clock="countdown"]').click()
  }
  const thumb = () => ({ src: doc.querySelector('#instantComposeThumb .instant-slide-corner-qr img').getAttribute('src'),
    text: doc.querySelector('#instantComposeThumb .instant-slide-corner-link').textContent })
  open()
  const handoutQr = thumb()
  assert.equal(handoutQr.text, 'handouts.fyi/k7m2', 'not live: QR and text are both the handout')
  const joinSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z" fill="#123456"/></svg>'
  join({ shortUrl: 'https://handouts.fyi/live-abc', qrSvg: joinSvg })
  status('live')
  doc.querySelector('[data-instant-label]').click()
  const live = thumb()
  assert.equal(decodeURIComponent(live.src.split(',')[1]), joinSvg, 'live: the QR is the join link')
  assert.equal(live.text, 'handouts.fyi/k7m2', 'live: the written link is still the published handout')
  // (left open: the deck's own timers throw if the window is closed under them; the script exits below)
}
console.log('instant-slide QR and sound tests passed')
process.exit(0)
