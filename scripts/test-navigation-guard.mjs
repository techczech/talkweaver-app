// No window navigates away from its own page (src/main/navigation-guard.ts): a main-frame navigation
// stays within the page's own file / origin / app-scheme host; web and mail links go to the OS;
// everything else is refused. Driven with the URLs the app really loads.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { APP_SCHEMES, decideFrameNavigation, decideNavigation, decideStartedNavigation, externalLinkOf, guardWebContents, installNavigationGuard, navigationStarter } from '../src/main/navigation-guard.ts'
import { contentHandOutRefusal } from '../src/main/hand-out.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const nav = (from, to, initial = false) => decideNavigation({ from, to, initial })

const renderer = pathToFileURL('/Applications/TalkWeaver.app/Contents/Resources/app.asar/out/renderer/index.html').href
const dev = 'http://localhost:5173/'
const deck = pathToFileURL('/Users/dl/Library/Application Support/TalkWeaver/present/Talk – Ä/talk-present.html').href
const preview = 'twpresent://preview/42'
const replay = 'twpresent://my-talk/my-talk-present.html'

console.log('navigation guard')

await test('the renderer index: its own file with another view / hash', () => {
  assert.equal(nav(renderer, `${renderer}?view=history`), 'allow')
  assert.equal(nav(`${renderer}?view=tools`, `${renderer}#/x`), 'allow')
  assert.equal(nav(renderer, renderer.replace('TalkWeaver.app', 'TalkWeaver%2Eapp')), 'allow', 'percent-encoding is not a different file')
})

await test('dev: the dev server origin, from a page on it', () => {
  assert.equal(nav(dev, 'http://localhost:5173/?view=pathways'), 'allow')
  assert.equal(nav(`${dev}?view=tools`, 'http://localhost:5173/src/x.html#a'), 'allow')
  assert.equal(nav(dev, 'http://localhost:5174/'), 'external', 'another port is another site')
  assert.equal(nav(dev, 'https://localhost:5173/'), 'external')
})

await test('deck windows: the same deck file with ?presenter / ?audience / a slide hash', () => {
  assert.equal(nav(`${deck}?presenter=1`, `${deck}?presenter=1&_r=2#intro`), 'allow')
  assert.equal(nav(`${deck}?presenter=1`, `${deck}?audience=1&session=s1`), 'allow')
  assert.equal(nav(deck, 'file:///Users/dl/Library/Application%20Support/TalkWeaver/present/Talk%20%E2%80%93%20%C3%84/talk-present.html#s3'), 'allow')
})

await test('another local file is refused, from any page', () => {
  assert.equal(nav(deck, pathToFileURL('/Users/dl/Library/Application Support/TalkWeaver/present/Other/other-present.html').href), 'deny')
  assert.equal(nav(renderer, 'file:///etc/passwd'), 'deny')
  assert.equal(nav(deck, renderer), 'deny', 'a deck never becomes the editor page (or the reverse)')
  assert.equal(nav(renderer, deck), 'deny')
  assert.equal(nav(dev, renderer), 'deny')
  assert.equal(nav('file:///', 'file:///'), 'deny')
})

await test('web and mail links go to the OS', () => {
  for (const from of [renderer, dev, deck, preview, 'about:blank', '']) {
    assert.equal(nav(from, 'https://example.com/article#x'), 'external', from)
    assert.equal(nav(from, 'mailto:me@example.com'), 'external', from)
  }
  assert.equal(nav(deck, 'http://127.0.0.1:8787/live'), 'external')
})

await test('app schemes: only within the page\'s own scheme and host', () => {
  assert.equal(nav(preview, 'twpresent://preview/42#slide-3'), 'allow')
  assert.equal(nav(replay, 'twpresent://my-talk/my-talk-present.html?audience=1'), 'allow')
  assert.equal(nav(replay, 'twpresent://other-talk/other-present.html'), 'deny')
  assert.equal(nav(preview, replay), 'deny')
  assert.equal(nav(renderer, preview), 'deny', 'the editor never becomes a deck page with the window.tw bridge')
  assert.equal(nav(dev, 'twfile://f/L1VzZXJzL2RsL3gueGh0bWw'), 'deny')
  assert.equal(nav(deck, 'twasset://my-talk/a.png'), 'deny')
  assert.equal(nav('twthumb://x/1.png', 'twthumb://y/1.png'), 'deny')
})

await test('script, data and odd schemes are refused', () => {
  for (const to of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'blob:file:///x', 'about:blank', 'about:srcdoc',
    'chrome://settings', 'devtools://devtools/x', 'view-source:https://example.com', 'smb://server/share', 'vscode://file/x', 'ftp://example.com/', 'tel:+44', 'not a url', '']) {
    assert.equal(nav(deck, to), 'deny', to)
    assert.equal(nav(renderer, to), 'deny', to)
  }
})

await test('before a window has shown a page: its first local load is allowed, a web page still goes to the OS', () => {
  assert.equal(nav('', `${deck}?audience=1`, true), 'allow', 'the F5 audience window')
  assert.equal(nav('about:blank', 'about:blank', true), 'allow', 'the board window')
  assert.equal(nav('', preview, true), 'allow')
  assert.equal(nav('', 'https://example.com', true), 'external')
  assert.equal(nav('', 'javascript:alert(1)', true), 'deny')
  assert.equal(nav('about:blank', `${deck}?audience=1`), 'deny', 'once shown, about:blank is a page like any other')
})

await test('helpers', () => {
  assert.equal(externalLinkOf('https://x.y/z'), 'https://x.y/z')
  assert.equal(externalLinkOf('mailto:'), null)
  assert.equal(externalLinkOf(null), null)
})

await test('index.ts registers exactly the app schemes this guard knows', () => {
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('protocol.registerSchemesAsPrivileged(['), src.indexOf('])', src.indexOf('protocol.registerSchemesAsPrivileged([')))
  const registered = [...block.matchAll(/scheme: '([a-z]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(registered, [...APP_SCHEMES].sort())
  assert.match(src, /installNavigationGuard\(app,/)
})

/** A fake webContents: records listeners, current URL settable. */
function fakeContents(url) {
  const listeners = new Map()
  return {
    url,
    on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this },
    getURL() { return this.url },
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) }
  }
}
const navEvent = (url, extra = {}) => { const e = { url, prevented: false, preventDefault() { this.prevented = true }, ...extra }; return e }

await test('guard: prevents, sends web links out (not redirects), leaves frames and allowed pages alone', () => {
  const opened = []
  const logs = []
  const wc = fakeContents(`${deck}?presenter=1`)
  guardWebContents(wc, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) })
  wc.emit('did-navigate')

  let e = navEvent(`${deck}?presenter=1#s2`); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  e = navEvent('https://example.com/a'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  assert.deepEqual(opened, ['https://example.com/a'])
  e = navEvent('file:///etc/passwd'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  assert.equal(logs.length, 1)
  e = navEvent('https://evil.example/'); wc.emit('will-redirect', e, e.url); assert.equal(e.prevented, true)
  assert.deepEqual(opened, ['https://example.com/a'], 'a redirect is never handed to the OS')
  e = navEvent('https://embed.example/', { isMainFrame: false }); wc.emit('will-redirect', e, e.url); assert.equal(e.prevented, false, 'frames are not judged')
  e = { prevented: false, preventDefault() { this.prevented = true } }; wc.emit('will-navigate', e, 'javascript:1', false, false); assert.equal(e.prevented, false, 'positional isMainFrame=false')
  e = { prevented: false, preventDefault() { this.prevented = true } }; wc.emit('will-navigate', e, 'javascript:1', false, true); assert.equal(e.prevented, true, 'positional url used when event.url is missing')
})

await test('guard: the first load of a new window (audience, board) and its redirects go through', () => {
  const opened = []
  const wc = fakeContents('')
  guardWebContents(wc, { openExternal: (u) => { opened.push(u) }, log: () => {} })
  let e = navEvent(`${deck}?audience=1`); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  wc.url = `${deck}?audience=1`; wc.emit('did-navigate')
  e = navEvent(renderer); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
})

await test('a deck\'s sibling page (action button) opens in the default app, not in the window (Codex review, PR #8)', () => {
  const sibling = deck.replace(/talk-present\.html$/, 'further-reading.html')
  assert.equal(nav(deck, sibling), 'open-local')
  assert.equal(nav(deck, deck.replace(/talk-present\.html$/, 'notes.htm')), 'open-local')
  assert.equal(nav(deck, deck.replace(/talk-present\.html$/, 'script.command')), 'deny', 'only HTML pages')
  assert.equal(nav(deck, pathToFileURL('/Users/dl/elsewhere/page.html').href), 'deny', 'only beside the deck')
  assert.equal(nav(deck, deck.replace(/talk-present\.html$/, 'sub/page.html')), 'deny', 'not in a subfolder')
  const opened = []
  const wc = fakeContents(deck)
  guardWebContents(wc, { openExternal: () => {}, openPath: (p) => { opened.push(p) }, log: () => {} })
  wc.emit('did-navigate')
  let e = navEvent(sibling); wc.emit('will-navigate', e, e.url)
  assert.equal(e.prevented, true, 'the window stays on the deck')
  assert.deepEqual(opened, ['/Users/dl/Library/Application Support/TalkWeaver/present/Talk – Ä/further-reading.html'])
  e = navEvent(sibling); wc.emit('will-redirect', e, e.url)
  assert.equal(e.prevented, true); assert.equal(opened.length, 1, 'a redirect never opens anything')
})

await test('first-load redirects are judged against where the load was going (Codex review, PR #8)', () => {
  const wc = fakeContents('')
  guardWebContents(wc, { openExternal: () => { throw new Error('never') }, log: () => {} })
  wc.emit('did-start-navigation', { url: dev, isMainFrame: true })
  let e = navEvent(`${dev}index.html`); wc.emit('will-redirect', e, e.url); assert.equal(e.prevented, false, 'same dev-server origin')
  e = navEvent('https://evil.example/'); wc.emit('will-redirect', e, e.url); assert.equal(e.prevented, true, 'another site is refused, not opened')
  const wc2 = fakeContents('')
  guardWebContents(wc2, { openExternal: () => { throw new Error('never') }, log: () => {} })
  e = navEvent('https://evil.example/'); wc2.emit('will-redirect', e, e.url); assert.equal(e.prevented, true, 'unknown first load: no web redirect')
})

await test('guard: openExternal throwing or rejecting is contained', async () => {
  const logs = []
  for (const openExternal of [() => { throw new Error('x') }, () => Promise.reject(new Error('y'))]) {
    const wc = fakeContents(renderer)
    guardWebContents(wc, { openExternal, log: (m) => logs.push(m) })
    wc.emit('did-navigate')
    const e = navEvent('https://example.com'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  }
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(logs.length, 2)
})

await test('installNavigationGuard hooks web-contents-created', () => {
  let hook
  installNavigationGuard({ on: (event, fn) => { assert.equal(event, 'web-contents-created'); hook = fn } }, { openExternal: () => {} })
  const wc = fakeContents(renderer)
  hook({}, wc)
  wc.emit('did-navigate')
  const e = navEvent('data:text/html,x'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
})

// ── Who starts a navigation of the window (security reviews of ticket 11.3) ──────────────────────
// Electron 42 names the starter on will-navigate / will-redirect: `initiator`, a WebFrameMain.
// Observed (hidden-window run, 2026-10-07): the page's own link, form, location = …, location.reload()
// and history.back() → the window's main frame; window.open(<url>, <name>) from the presenter → in
// the NEW window, the opener's main frame (also when the named window is reused); top.location /
// parent.location from an embedded frame → that frame; a pop-up setting opener.location → the
// pop-up's main frame. loadFile, webContents.reload(), goBack() and a hash change raise no event.
const pageFrame = { parent: null, url: `${deck}?presenter=1` } // this window's own page
const embeddedFrame = { parent: pageFrame }
const nestedFrame = { parent: embeddedFrame }
const otherWindowPage = { parent: null, url: 'about:blank' } // another window's page: a pop-up
const openerPage = { parent: null, url: `${deck}?presenter=1&_r=3#s4` } // the presenter that opened this audience window
const starterOf = (initiator, extra = {}) => navigationStarter({ initiator, mainFrame: pageFrame, openerFrames: [], ...extra })

await test('starter: nobody or this window\'s own page; the opener\'s page is named apart; everyone else is "other"', () => {
  assert.equal(starterOf(null), 'page')
  assert.equal(starterOf(undefined), 'page')
  assert.equal(starterOf(pageFrame), 'page')
  assert.equal(starterOf(embeddedFrame), 'other', 'a frame inside the page')
  assert.equal(starterOf(nestedFrame), 'other')
  assert.equal(starterOf(otherWindowPage), 'other', 'another window\'s page is not this window\'s page')
  assert.equal(starterOf({ parent: null }), 'other', 'looking like a main frame is not being THE main frame')
  assert.equal(starterOf({}), 'other')
  for (const odd of ['unreadable', 7, true]) assert.equal(starterOf(odd), 'other', String(odd))
  // No main frame to compare with: nothing but "nobody" is the page.
  assert.equal(navigationStarter({ initiator: pageFrame }), 'other')
  assert.equal(navigationStarter({ initiator: pageFrame, mainFrame: null }), 'other')
  assert.equal(navigationStarter({ initiator: null, mainFrame: undefined }), 'page')
  // The opener: exactly the frame that opened this window, and only when it is a window's own page.
  assert.equal(starterOf(openerPage, { openerFrames: [openerPage] }), 'opener-page')
  assert.equal(starterOf(openerPage, { openerFrames: [null, undefined, openerPage] }), 'opener-page')
  assert.equal(starterOf(otherWindowPage, { openerFrames: [openerPage] }), 'other')
  assert.equal(starterOf(embeddedFrame, { openerFrames: [embeddedFrame] }), 'other', 'opened by an embedded frame: that frame is no page')
  assert.equal(starterOf(openerPage, { openerFrames: [] }), 'other')
  const gone = { get parent() { throw new Error('frame is gone') } }
  assert.equal(starterOf(gone, { openerFrames: [gone] }), 'other')
})

await test('decision: "other" never moves the window; the opener moves it to its own deck only; the page as before', () => {
  const from = `${deck}?presenter=1`
  const TARGETS = ['https://attacker.example/?secret=1', 'mailto:me@example.com', 'file:///etc/passwd', `${deck}?presenter=1#s2`, `${deck}?audience=1`,
    deck.replace(/talk-present\.html$/, 'further-reading.html'), 'twpresent://preview/1', 'about:blank', 'javascript:alert(1)']
  for (const to of TARGETS) {
    assert.equal(decideStartedNavigation({ from, to, starter: 'other' }), 'deny', to)
    assert.equal(decideStartedNavigation({ from: '', to, initial: true, starter: 'other' }), 'deny', `${to} (before the first page)`)
    assert.equal(decideStartedNavigation({ from, to, starter: 'page' }), nav(from, to), to)
    assert.equal(decideStartedNavigation({ from, to, starter: 'something else' }), 'deny', to)
  }
  // The audience window: opened by the presenter with the deck's own file.
  const opened = (to, openerUrl, fromUrl = '', initial = true) => decideStartedNavigation({ from: fromUrl, to, initial, starter: 'opener-page', openerUrl })
  assert.equal(opened(`${deck}?audience=1&session=s1`, `${deck}?presenter=1&_r=3#s4`), 'allow', 'first load of the new window')
  assert.equal(opened(`${deck}?audience=1&session=s1#b`, `${deck}?presenter=1`, `${deck}?audience=1&session=s1`, false), 'allow', 'the named window reused')
  assert.equal(opened(`${deck}?presenter=1`, deck), 'allow', 'the plain deck\'s Presenter button')
  for (const to of TARGETS.filter((t) => !t.startsWith(deck) || t.includes('further-reading'))) {
    assert.equal(opened(to, `${deck}?presenter=1`), 'deny', `the opener may not send its child to ${to}`)
  }
  assert.equal(opened(`${deck}?audience=1`, 'about:blank'), 'deny', 'a blank opener has no deck')
  assert.equal(opened(`${deck}?audience=1`, ''), 'deny')
  assert.equal(opened(`${deck}?audience=1`, undefined), 'deny')
  assert.equal(opened(pathToFileURL('/Users/dl/elsewhere/other-present.html').href, `${deck}?presenter=1`), 'deny', 'another deck')
})

/** A window with a main frame; `opener` as Electron records it. */
function fakeWindowContents(url, extra = {}) {
  const wc = fakeContents(url)
  wc.mainFrame = { parent: null, url }
  return Object.assign(wc, extra)
}
const mainEvent = (initiator, url) => navEvent(url, { isMainFrame: true, initiator })

await test('guard: top.location / parent.location from an embedded frame is refused and nothing is handed to the OS', () => {
  const opened = []
  const logs = []
  const wc = fakeWindowContents(`${deck}?presenter=1`)
  const inside = { parent: wc.mainFrame }
  guardWebContents(wc, { openExternal: (u) => { opened.push(u) }, openPath: (p) => { opened.push(p) }, log: (m) => logs.push(m) })
  wc.emit('did-navigate')
  let e = mainEvent(inside, 'https://attacker.example/?secret=1'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent({ parent: inside }, 'mailto:me@example.com'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent(inside, deck.replace(/talk-present\.html$/, 'further-reading.html')); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, 'a sibling page is not opened either')
  e = mainEvent(inside, `${deck}?presenter=1#s2`); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, 'not even the deck\'s own page')
  e = mainEvent(inside, 'https://attacker.example/hop'); wc.emit('will-redirect', e, e.url); assert.equal(e.prevented, true, 'a redirect of such a navigation')
  e = Object.defineProperty(navEvent('https://attacker.example/', { isMainFrame: true }), 'initiator', { get() { throw new Error('gone') } }); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, 'a starter that cannot be read')
  assert.deepEqual(opened, [], 'nothing reached the browser or the Finder')
  assert.equal(logs.length, 6)
  assert.match(logs[0], /^\[navigation\] refused navigate of the window to https:\/\/attacker\.example\/\?secret=1 started by a frame inside the page or another window \(the window shows file:/)
  // The page's own link and a navigation with no starter: as before.
  e = mainEvent(wc.mainFrame, 'https://example.com/own-link'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent(null, 'https://example.com/no-starter'); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  assert.deepEqual(opened, ['https://example.com/own-link', 'https://example.com/no-starter'])
  e = mainEvent(wc.mainFrame, `${deck}?presenter=1#s3`); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  // A frame navigating ITSELF is another rule (the frame rule below): its starter is not judged here.
  e = navEvent('https://embed.example/next', { isMainFrame: false, initiator: inside }); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  assert.equal(logs.length, 6)
})

await test('guard: another window\'s page never moves this window — a pop-up setting opener.location is refused', () => {
  const opened = []
  const logs = []
  const presenter = fakeWindowContents(`${deck}?presenter=1`)
  guardWebContents(presenter, { openExternal: (u) => { opened.push(u) }, openPath: (p) => { opened.push(p) }, log: (m) => logs.push(m) })
  presenter.emit('did-navigate')
  const popup = { parent: null, url: 'about:blank' } // a blank child an embedded page opened: its main frame
  for (const to of ['https://attacker.example/?from=popup', 'mailto:x@example.com', `${deck}?presenter=1#s9`, deck.replace(/talk-present\.html$/, 'further-reading.html'), 'file:///etc/passwd']) {
    const e = mainEvent(popup, to); presenter.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, to)
  }
  assert.deepEqual(opened, [])
  assert.equal(logs.length, 5)
  // Even the window that opened the presenter (a plain deck) may only send it to its own deck.
  const plainDeck = { parent: null, url: `${deck}#s1` }
  const child = fakeWindowContents('', { opener: plainDeck })
  guardWebContents(child, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) })
  let e = mainEvent(plainDeck, 'https://attacker.example/'); child.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent(plainDeck, 'about:blank'); child.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent(plainDeck, `${deck}?presenter=1`); child.emit('will-navigate', e, e.url); assert.equal(e.prevented, false, 'the Presenter button')
  assert.deepEqual(opened, [])
  assert.match(logs[5], /started by the window that opened it, to a page that is not its own deck \(the window shows no page yet\)/)
})

await test('guard: the presenter opens its audience window, reuses it, and still reaches it after a refresh', () => {
  const logs = []
  let hook = null
  installNavigationGuard({ on: (_event, fn) => { hook = fn } }, { openExternal: () => { throw new Error('never') }, log: (m) => logs.push(m) })
  // fakeContents keeps one listener per event; the install adds did-create-window, which the guard itself does not use.
  const presenter = fakeWindowContents(`${deck}?presenter=1`)
  hook({}, presenter)
  presenter.emit('did-navigate')
  // window.open(<deck>?audience=1, 'html-audience-s1'): Electron records the opener frame on the child…
  const audienceWindow = fakeWindowContents('', { opener: presenter.mainFrame })
  hook({}, audienceWindow)
  presenter.emit('did-create-window', { webContents: audienceWindow })
  let e = mainEvent(presenter.mainFrame, `${deck}?audience=1&session=s1`); audienceWindow.emit('will-navigate', e, e.url); assert.equal(e.prevented, false, 'first load')
  audienceWindow.url = `${deck}?audience=1&session=s1`; audienceWindow.emit('did-navigate')
  e = mainEvent(presenter.mainFrame, `${deck}?audience=1&session=s1#b-2`); audienceWindow.emit('will-navigate', e, e.url); assert.equal(e.prevented, false, 'the Audience button again')
  // …and after ⌘R the presenter's page is a new frame: the guard compares with the opener window's main frame NOW.
  presenter.mainFrame = { parent: null, url: `${deck}?presenter=1&_r=2` }; presenter.url = `${deck}?presenter=1&_r=2`
  e = mainEvent(presenter.mainFrame, `${deck}?audience=1&session=s1&_r=2`); audienceWindow.emit('will-navigate', e, e.url); assert.equal(e.prevented, false, 'after a refresh of the presenter')
  // The opener still cannot send it anywhere else, and a third window cannot move it at all.
  e = mainEvent(presenter.mainFrame, 'https://attacker.example/'); audienceWindow.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent({ parent: null, url: `${deck}?presenter=1` }, `${deck}?audience=1`); audienceWindow.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, 'a look-alike page that is not the opener')
  // The audience window's own navigation of itself is its own page's.
  e = mainEvent(audienceWindow.mainFrame, `${deck}?audience=1&session=s1#c`); audienceWindow.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  assert.equal(logs.length, 2)
})

const everyWindowRule = (_contents, link, from) => contentHandOutRefusal({ url: link, from }) // as index.ts wires it

await test('guard: no window hands the OS a local address or anything from a blank page; web and mail links as before', () => {
  const opened = []
  const logs = []
  const asked = []
  // Every kind of window that has a page of its own: a deck, the editor, the dev editor, a thumbnail-like deck.
  for (const page of [`${deck}?presenter=1`, `${deck}?audience=1`, renderer, deck]) {
    const wc = fakeWindowContents(page)
    guardWebContents(wc, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m), refuseHandOut: (contents, link, from) => { asked.push([contents === wc, link, from]); return everyWindowRule(contents, link, from) } })
    wc.emit('did-navigate')
    const go = (to) => { const e = mainEvent(wc.mainFrame, to); wc.emit('will-navigate', e, e.url); return e.prevented }
    opened.length = 0; logs.length = 0
    for (const to of ['http://127.0.0.1:8787/admin', 'http://localhost:7860/', 'https://LOCALHOST/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]:3000/', 'http://192.168.1.1/', 'http://printer.local/x', 'http://[::ffff:10.0.0.1]/']) {
      assert.equal(go(to), true, `${to} from ${page}`)
    }
    assert.deepEqual(opened, [], `no local address reached the browser from ${page}`)
    assert.equal(logs.length, 9)
    assert.match(logs[0], /^\[navigation\] refused to hand http:\/\/127\.0\.0\.1:8787\/admin to the OS from file:.*: a local address$/)
    assert.equal(go('https://example.com/article'), true)
    assert.equal(go('mailto:someone@example.com'), true)
    assert.deepEqual(opened, ['https://example.com/article', 'mailto:someone@example.com'])
  }
  assert.deepEqual(asked[0], [true, 'http://127.0.0.1:8787/admin', `${deck}?presenter=1`], 'the rule is asked with the window, the normalised link and the page shown')
  // A blank child navigating itself hands nothing out.
  const blank = fakeWindowContents('about:blank')
  guardWebContents(blank, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m), refuseHandOut: everyWindowRule })
  blank.emit('did-navigate')
  opened.length = 0
  let e = mainEvent(blank.mainFrame, 'https://attacker.example/?from=blank'); blank.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  e = mainEvent(blank.mainFrame, 'mailto:x@example.com'); blank.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  assert.deepEqual(opened, [])
  assert.match(logs.at(-1), /a blank page hands nothing out$/)
  // A rule that throws refuses.
  const broken = fakeWindowContents(deck)
  guardWebContents(broken, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m), refuseHandOut: () => { throw new Error('x') } })
  broken.emit('did-navigate')
  e = mainEvent(broken.mainFrame, 'https://example.com/'); broken.emit('will-navigate', e, e.url)
  assert.deepEqual(opened, [])
})

await test('guard: what reaches openExternal is the normalised href of the link that was judged, never the page\'s string', () => {
  const opened = []
  const judged = []
  const wc = fakeWindowContents(`${deck}?presenter=1`)
  guardWebContents(wc, { openExternal: (u) => { opened.push(u) }, log: () => {}, refuseHandOut: (_c, link, from) => { judged.push(link); return everyWindowRule(_c, link, from) } })
  wc.emit('did-navigate')
  for (const raw of ['HTTPS://EXAMPLE.COM/a b', '  https://example.com/x  ', 'https:\\\\example.com\\y', 'https://user:pw@example.com/z', 'http://example.com@127.0.0.1/', 'http:127.0.0.1', 'http:/127.0.0.1', 'http://127.0.0.1%2e/', 'http://１２７.０.０.１/', 'http://[::1]/']) {
    const e = mainEvent(wc.mainFrame, raw); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, raw)
  }
  assert.deepEqual(opened, ['https://example.com/a%20b', 'https://example.com/x', 'https://example.com/y', 'https://example.com/z'])
  assert.deepEqual(judged.slice(0, 4), opened, 'the string judged is the string handed out')
  for (const link of judged) assert.equal(new URL(link).href, link, 'always a normalised href')
})

// ── A hidden renderer (the thumbnail capture window) ─────────────────────────────────────────────
await test('guard: a hidden renderer hands nothing to the OS and navigates nowhere but the file loaded into it', () => {
  const opened = []
  const logs = []
  const thumb = pathToFileURL('/private/var/folders/xx/T/talk-weaver-thumb-0123456789abcdef.html').href
  const wc = fakeWindowContents(thumb)
  guardWebContents(wc, { openExternal: (u) => { opened.push(u) }, openPath: (p) => { opened.push(p) }, log: (m) => logs.push(m), refuseHandOut: everyWindowRule, isHiddenRenderer: (contents) => contents === wc })
  wc.emit('did-navigate')
  // The deck's own document navigating itself (a script an embedded page added to it, a meta refresh): no starter rule catches this.
  for (const to of ['https://attacker.example/?talk-opened=1', 'http://127.0.0.1:8787/', 'mailto:x@example.com', thumb.replace(/talk-weaver-thumb-\w+\.html$/, 'sibling.html'), 'file:///etc/passwd', 'twpresent://preview/1', 'about:blank', 'data:text/html,x']) {
    for (const event of ['will-navigate', 'will-redirect']) {
      const e = mainEvent(wc.mainFrame, to); wc.emit(event, e, e.url); assert.equal(e.prevented, true, `${event} ${to}`)
    }
    const e = mainEvent(null, to); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, true, `${to} with no starter`)
  }
  assert.deepEqual(opened, [], 'nothing reached the browser, the mail program or the Finder')
  assert.equal(logs.length, 24)
  assert.match(logs[0], /^\[navigation\] refused navigate of a hidden renderer to https:\/\/attacker\.example\/\?talk-opened=1 from file:/)
  // Its own file with another hash or query is left alone (the deck runtime's own moves).
  let e = mainEvent(wc.mainFrame, `${thumb}#slide-3`); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  e = mainEvent(wc.mainFrame, `${thumb}?x=1`); wc.emit('will-navigate', e, e.url); assert.equal(e.prevented, false)
  // Before it has shown a page there is no "first load may go to a local page" for it: main loads it with loadFile.
  const fresh = fakeWindowContents('')
  guardWebContents(fresh, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m), isHiddenRenderer: () => true })
  e = mainEvent(null, 'file:///etc/passwd'); fresh.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  // A check that throws counts as hidden: nothing is handed out.
  const unsure = fakeWindowContents(deck)
  guardWebContents(unsure, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m), isHiddenRenderer: () => { throw new Error('x') } })
  unsure.emit('did-navigate')
  e = mainEvent(unsure.mainFrame, 'https://example.com/'); unsure.emit('will-navigate', e, e.url); assert.equal(e.prevented, true)
  assert.deepEqual(opened, [])
  // Frames inside it stay under the frame rule.
  e = navEvent('file:///etc/passwd', { isMainFrame: false }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, true)
})

await test('wiring: the hand-out rule is for every window; the thumbnail window is a hidden renderer', () => {
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(src, /refuseHandOut: \(_contents, link, from\) => contentHandOutRefusal\(\{ url: link, from \}\),/)
  assert.match(src, /isHiddenRenderer: \(contents\) => isHiddenRenderer\(/)
  const thumbnails = readFileSync(new URL('../src/main/thumbnails.ts', import.meta.url), 'utf8')
  assert.match(thumbnails, /markHiddenRenderer\(win\)/)
  assert.match(thumbnails, /disableDialogs: true/)
  assert.match(thumbnails, /'will-prevent-unload', \(event\) => event\.preventDefault\(\)/)
  assert.match(thumbnails, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
  // Every window main creates is an app window (registered on creation), a deck window, or this hidden renderer.
  const mainDir = fileURLToPath(new URL('../src/main/', import.meta.url))
  const made = []
  for (const name of readdirSync(mainDir)) if (/\.ts$/.test(name)) for (const _ of readFileSync(join(mainDir, name), 'utf8').matchAll(/new BrowserWindow\(/g)) made.push(name)
  assert.deepEqual(made.sort(), ['index.ts', 'index.ts', 'index.ts', 'index.ts', 'thumbnails.ts'], 'a new window: decide whether it is an app window, a deck window or a hidden renderer')
  assert.match(src, /show: false/) // E2E only; a window created hidden for another reason must be marked
})

// ── Frames (ADR-0036): a frame in any window never goes to a file ─────────────────────────────
await test('frame decision: a frame may show its own content, the web and app schemes; never a file', () => {
  const top = `${deck}?presenter=1`
  const frame = (to) => decideFrameNavigation({ to, isMainFrame: false, top })
  // What the app itself puts in frames.
  for (const to of [
    'about:srcdoc', 'about:blank', // an inlined local simulation, an empty frame
    'blob:null/3f1c2b9e-0000-4000-8000-000000000000', 'blob:file:///3f1c2b9e-0000-4000-8000-000000000000', // the simulation after the deck swaps it into a blob: frame
    'data:text/html,<p>x</p>',
    'https://www.youtube-nocookie.com/embed/abc', 'https://player.vimeo.com/video/1', 'https://example.org/page', 'http://localhost:5173/x',
    'twpresent://preview/12', 'twpresent://my-talk/my-talk-present.html', 'twasset://img-abc1234', 'twthumb://thumb/a/b', 'twrec://sess-1',
  ]) assert.equal(frame(to), 'allow', to)
  // A file, in every spelling a browser accepts, and everything not on the list.
  for (const to of [
    'file:///Users/someone/Documents/secret.pdf', 'file:///etc/passwd', 'FILE:///etc/passwd', 'file://localhost/etc/passwd', 'file:/etc/passwd',
    top, deck, `${deck}#slide`, // not even the deck's own file
    'javascript:alert(1)', 'filesystem:file:///temporary/x', 'chrome://settings', 'view-source:file:///etc/passwd', 'ftp://example.org/x',
    'about:config', 'about:', 'https://', 'http:', '', 'not a url', null, undefined, 42,
  ]) assert.equal(frame(to), 'deny', String(to))
  // The window's own page is not this rule's business (decideNavigation judges it).
  assert.equal(decideFrameNavigation({ to: 'file:///etc/passwd', isMainFrame: true, top }), 'allow')
})

await test('frame guard: a frame navigation to a file is prevented and logged; allowed frames and the main frame are left alone', () => {
  const logs = []
  const wc = fakeContents(`${deck}?presenter=1`)
  guardWebContents(wc, { openExternal: () => { throw new Error('a frame never opens the browser') }, log: (m) => logs.push(m) })
  wc.emit('did-navigate')
  // An embedded page sends its own frame to a file.
  let e = navEvent('file:///Users/someone/Documents/secret.pdf', { isMainFrame: false }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, true)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /refused frame navigation to file:\/\/\/Users\/someone\/Documents\/secret\.pdf/)
  // No isMainFrame on the event: told apart by the frame having a parent.
  e = navEvent('file:///etc/passwd', { frame: { parent: {} } }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, true)
  e = navEvent('javascript:alert(1)', { isMainFrame: false }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, true)
  // What the deck does itself.
  for (const to of ['about:srcdoc', 'blob:null/3f1c2b9e-0000-4000-8000-000000000000', 'https://www.youtube-nocookie.com/embed/abc', 'twpresent://preview/3']) {
    e = navEvent(to, { isMainFrame: false }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, false, to)
  }
  // The main frame's own navigations come through this event too: left to will-navigate.
  e = navEvent(`${deck}?presenter=1#s2`, { isMainFrame: true }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, false)
  e = navEvent('file:///etc/passwd', { isMainFrame: true }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, false, 'judged (and refused) by will-navigate, not here')
  e = navEvent('file:///etc/passwd', { frame: { parent: null } }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, false)
  assert.equal(logs.length, 3)
})

await test('frames of a DevTools window may go to devtools: pages; no app window\'s frames may', () => {
  const devtools = 'devtools://devtools/bundled/devtools_app.html?remoteBase=x'
  const panel = 'devtools://devtools/bundled/panels/some/panel.html'
  assert.equal(decideFrameNavigation({ to: panel, isMainFrame: false, top: devtools }), 'allow')
  for (const top of [`${deck}?presenter=1`, `${deck}?audience=1`, deck, renderer, dev, preview, replay, 'about:blank', '', undefined, 'not a url', 'https://devtools/', 'file:///devtools:/x']) {
    assert.equal(decideFrameNavigation({ to: panel, isMainFrame: false, top }), 'deny', String(top))
  }
  // Being a DevTools window widens nothing else: still no file, no script URL.
  for (const to of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'filesystem:file:///temporary/x']) {
    assert.equal(decideFrameNavigation({ to, isMainFrame: false, top: devtools }), 'deny', to)
  }
  // And no app page can become a DevTools page to use it.
  for (const from of [deck, renderer, dev, preview]) assert.equal(nav(from, devtools), 'deny', from)
  const logs = []
  const tools = fakeContents(devtools)
  guardWebContents(tools, { openExternal: () => { throw new Error('never') }, log: (m) => logs.push(m) })
  tools.emit('did-navigate')
  let e = navEvent(panel, { isMainFrame: false }); tools.emit('will-frame-navigate', e); assert.equal(e.prevented, false)
  e = navEvent('file:///etc/passwd', { isMainFrame: false }); tools.emit('will-frame-navigate', e); assert.equal(e.prevented, true)
  const presenter = fakeContents(`${deck}?presenter=1`)
  guardWebContents(presenter, { openExternal: () => { throw new Error('never') }, log: (m) => logs.push(m) })
  presenter.emit('did-navigate')
  e = navEvent(panel, { isMainFrame: false }); presenter.emit('will-frame-navigate', e); assert.equal(e.prevented, true, 'a frame in a deck window never goes to devtools:')
  assert.equal(logs.length, 2)
})

await test('frame guard: installed for every webContents the app creates', () => {
  let hook = null
  installNavigationGuard({ on: (_event, fn) => { hook = fn } }, { openExternal: () => {}, log: () => {} })
  for (const url of [renderer, `${deck}?audience=1`, 'about:blank']) {
    const wc = fakeContents(url)
    hook({}, wc)
    const e = navEvent('file:///etc/passwd', { isMainFrame: false }); wc.emit('will-frame-navigate', e); assert.equal(e.prevented, true, url)
  }
})

console.log(`navigation guard: ${passed} passed`)
