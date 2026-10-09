// What window.open / a target="_blank" link may open from an app window (src/main/present-window-open.ts).
// A child window that is allowed inherits its opener's preload, so only the deck's own pages and the
// board window open in-app; web and mail links go to the OS; everything else is refused.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HAND_OUT_MAX_LENGTH, contentHandOutRefusal, handOutLink } from '../src/main/hand-out.ts'
import { appWindowOpenHandler, decideAppWindowOpen, decidePresentWindowOpen, deckHandOutRefusal, externalLinkOf, isAppAudienceUrl, isSameDeckFile, presentWindowOpenHandler, guardDeckWindowTree } from '../src/main/present-window-open.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

// The compiled deck as Electron loads it (loadFile with a query and hash), and the URLs the runtime
// builds from location.href (presenter-popup-single-html.html openAudience / openPresenter).
const deckPath = '/Users/dl/Library/Application Support/TalkWeaver/present/My talk – ÄI/present.html'
const deck = pathToFileURL(deckPath).href
const presenterPage = `${deck}?presenter=1&_r=3#slide-intro`
const audience = (() => { const u = new URL(presenterPage); u.searchParams.set('audience', '1'); u.searchParams.delete('presenter'); u.searchParams.set('session', 'abc'); u.hash = 'b-2'; return u.toString() })()
const presenterPopup = (() => { const u = new URL(`${deck}?audience=1`); u.searchParams.set('presenter', '1'); u.searchParams.delete('audience'); return u.toString() })()

const decide = (url, frameName = '', deckUrl = presenterPage) => decidePresentWindowOpen({ url, frameName, deckUrl })

console.log('present window open')

await test('F5 / the Audience button: the same deck file with ?audience=1 opens in-app', () => {
  assert.equal(decide(audience, 'html-audience-abc'), 'allow-deck')
  assert.equal(decide(`${deck}?audience=1`, ''), 'allow-deck')
})

await test('the presentation window\'s Presenter button (?presenter=1) opens in-app', () => {
  assert.equal(decide(presenterPopup, 'html-presenter-x', `${deck}#s1`), 'allow-deck')
})

await test('the deck file matches whatever the percent-encoding (spaces, en dash, umlaut)', () => {
  const chromium = 'file:///Users/dl/Library/Application%20Support/TalkWeaver/present/My%20talk%20%E2%80%93%20%C3%84I/present.html?audience=1'
  assert.equal(decide(chromium, ''), 'allow-deck')
  assert.equal(decide(chromium.replace('%C3%84', '%c3%84'), ''), 'allow-deck')
})

await test('another file on disk is refused (not the deck, not sent to the OS)', () => {
  assert.equal(decide(pathToFileURL('/Users/dl/Library/Application Support/TalkWeaver/present/other/present.html').href, ''), 'deny')
  assert.equal(decide('file:///etc/passwd', ''), 'deny')
  assert.equal(decide('file:///Applications/Calculator.app', ''), 'deny')
  assert.equal(decide(`${deck}/../../secret.html`, ''), 'deny')
})

await test('the board window: about:blank under tw-board-window only', () => {
  assert.equal(decide('about:blank', 'tw-board-window'), 'allow-board')
  assert.equal(decide('https://example.com/', 'tw-board-window'), 'deny', 'never sent to the browser either')
  assert.equal(decide(audience, 'tw-board-window'), 'deny')
  assert.equal(decide('about:blank#x', 'tw-board-window'), 'deny')
})

await test('a blank page the deck writes itself opens in-app (My Notes Print, preflight pop-up test)', () => {
  assert.equal(decide('about:blank', ''), 'allow-blank')
  assert.equal(decide('about:blank', '_blank'), 'allow-blank')
  assert.equal(decide('about:blank', 'presentation-popup-test'), 'allow-blank')
  assert.equal(decide('about:blank#x', '_blank'), 'deny', 'only the plain blank page')
  assert.equal(decide('about:blank', '', 'about:blank'), 'deny', 'not from a board (about:blank) opener')
  assert.equal(decide('about:blank', '', 'https://example.com/'), 'deny', 'not from a non-deck opener')
})

await test('deck links (target="_blank") to web pages go to the browser', () => {
  assert.equal(decide('https://example.com/article?x=1#y', '_blank'), 'external')
  assert.equal(decide('http://localhost:8080/', ''), 'external')
  assert.equal(decide('HTTPS://EXAMPLE.COM', ''), 'external')
  assert.equal(decide('mailto:someone@example.com?subject=Hi', ''), 'external')
})

await test('anything else is refused', () => {
  for (const url of [
    '', 'not a url', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'blob:file:///abc', 'chrome://gpu', 'devtools://devtools',
    'twpresent://preview/abc', 'twfile:///Users/dl/x.html', 'twasset://x', 'file:///', 'ftp://example.com/', 'mailto:', 'https:',
    'smb://server/share', 'vscode://file/x', 'x-apple.systempreferences:', 'tel:+441234'
  ]) assert.equal(decide(url, ''), 'deny', url)
})

await test('a board opener (about:blank) opens no deck', () => {
  assert.equal(decide(audience, '', 'about:blank'), 'deny')
  assert.equal(decide('https://example.com', '', 'about:blank'), 'external')
})

await test('every window opened from a deck window gets the handler, at any depth (Codex review, PR #7)', () => {
  const made = []
  const fake = (url) => {
    const listeners = []
    const c = { url, handler: null, setWindowOpenHandler(h) { c.handler = h }, getURL() { return c.url }, on(_e, l) { listeners.push(l) },
      open(childUrl) { const child = fake(childUrl); for (const l of listeners) l({ webContents: child }); made.push(child); return child } }
    return c
  }
  const opts = { openExternal: () => {} }
  const presentation = fake(presenterPage)
  guardDeckWindowTree(presentation, opts)
  const presenter = presentation.open(presenterPage + '?presenter=1')
  const audience = presenter.open(presenterPage + '?audience=1')
  for (const c of [presentation, presenter, audience]) assert.ok(c.handler, 'handler installed')
  assert.deepEqual(audience.handler({ url: 'https://example.com/', frameName: '_blank' }), { action: 'deny' }, 'a grandchild sends web links out')
  assert.equal(audience.handler({ url: presenterPage + '?audience=1#3', frameName: '' }).action, 'allow', 'and still opens the deck itself')
})

await test('helpers', () => {
  assert.equal(externalLinkOf('https://example.com'), 'https://example.com/')
  assert.equal(externalLinkOf('javascript:alert(1)'), null)
  assert.equal(externalLinkOf(undefined), null)
  assert.equal(isSameDeckFile(deck, deck), true)
  assert.equal(isSameDeckFile('file:///', 'file:///'), false)
  assert.equal(isSameDeckFile('https://x/present.html', 'https://x/present.html'), false)
  assert.equal(isSameDeckFile('file://host/a.html', 'file:///a.html'), false)
  assert.equal(decideAppWindowOpen('https://example.com'), 'external')
  assert.equal(decideAppWindowOpen('twpresent://preview/1'), 'deny')
  assert.equal(decideAppWindowOpen('file:///Users/dl/index.html'), 'deny')
  assert.equal(decideAppWindowOpen('about:blank'), 'deny')
})

await test('chime unlock: only the app own audience deck page', () => {
  assert.equal(isAppAudienceUrl('file:///Users/dl/out/talk/index.html?audience=1'), true)
  assert.equal(isAppAudienceUrl('file:///Users/dl/out/talk/index.html?audience=1#slide-a'), true)
  assert.equal(isAppAudienceUrl('https://evil.example/?audience=1'), false)
  assert.equal(isAppAudienceUrl('http://localhost/?audience=1'), false)
  assert.equal(isAppAudienceUrl('twpresent://preview/1?audience=1'), false)
  assert.equal(isAppAudienceUrl('file:///Users/dl/out/talk/index.html'), false)
  assert.equal(isAppAudienceUrl('file:///Users/dl/out/talk/index.html?presenter=1'), false)
  assert.equal(isAppAudienceUrl('file:///Users/dl/out/talk/index.html?audience=0'), false)
  assert.equal(isAppAudienceUrl(undefined), false)
})

await test('handlers: allow carries the E2E options; external is handed to the OS and denied in-app', () => {
  const opened = []
  const logs = []
  const allowOptions = { overrideBrowserWindowOptions: { show: false } }
  const handler = presentWindowOpenHandler(() => presenterPage, { openExternal: (u) => { opened.push(u) }, allowOptions, log: (m) => logs.push(m) }, () => true)
  assert.deepEqual(handler({ url: audience, frameName: 'html-audience-abc' }), { action: 'allow', ...allowOptions })
  assert.deepEqual(handler({ url: 'about:blank', frameName: 'tw-board-window' }), { action: 'allow', ...allowOptions })
  assert.deepEqual(handler({ url: 'https://example.com/a', frameName: '_blank' }), { action: 'deny' })
  assert.deepEqual(handler({ url: 'javascript:alert(1)', frameName: '' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://example.com/a'])
  assert.equal(logs.length, 1)

  const app = appWindowOpenHandler({ openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) }, () => true)
  assert.deepEqual(app({ url: 'mailto:a@b.c', frameName: '' }), { action: 'deny' })
  assert.deepEqual(app({ url: pathToFileURL('/x/renderer/index.html').href, frameName: '' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://example.com/a', 'mailto:a@b.c'])
})

await test('a throwing or rejecting openExternal never escapes the handler', async () => {
  const logs = []
  const h1 = appWindowOpenHandler({ openExternal: () => { throw new Error('boom') }, log: (m) => logs.push(m) }, () => true)
  assert.deepEqual(h1({ url: 'https://example.com', frameName: '' }), { action: 'deny' })
  const h2 = appWindowOpenHandler({ openExternal: () => Promise.reject(new Error('nope')), log: (m) => logs.push(m) }, () => true)
  assert.deepEqual(h2({ url: 'https://example.com', frameName: '' }), { action: 'deny' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(logs.length, 2)
})

// ── Web links need a press (embed-sandbox design 2.4, matrix row 21) ─────────────────────────────
await test('a deck window hands a web or mail link to the OS only after a recent press in that window', () => {
  const opened = []
  const logs = []
  let pressed = false
  const handler = presentWindowOpenHandler(() => presenterPage, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) }, () => pressed)
  // An embedded page calls window.open with nobody at the keyboard.
  assert.deepEqual(handler({ url: 'https://evil.example/collect?d=1', frameName: '' }), { action: 'deny' })
  assert.deepEqual(handler({ url: 'mailto:someone@example.com', frameName: '_blank' }), { action: 'deny' })
  assert.deepEqual(opened, [], 'nothing reached the default browser')
  assert.equal(logs.length, 2)
  assert.match(logs[0], /^\[window-open\] refused https:\/\/evil\.example\/collect\?d=1: no key or mouse press in this window in the last five seconds$/)
  // The presenter clicks a link.
  pressed = true
  assert.deepEqual(handler({ url: 'https://example.com/article', frameName: '_blank' }), { action: 'deny' }, 'still never opened in-app')
  assert.deepEqual(handler({ url: 'mailto:someone@example.com', frameName: '_blank' }), { action: 'deny' })
  assert.deepEqual(opened, ['https://example.com/article', 'mailto:someone@example.com'])
  assert.equal(logs.length, 2)
  // Five seconds later the press no longer counts.
  pressed = false
  handler({ url: 'https://example.com/again', frameName: '' })
  assert.equal(opened.length, 2)
})

await test('the press rule fails closed: no press source, a throwing one, or anything but true hands nothing out', () => {
  const opened = []
  const opts = { openExternal: (u) => { opened.push(u) }, log: () => {} }
  for (const handler of [
    presentWindowOpenHandler(() => presenterPage, opts),
    presentWindowOpenHandler(() => presenterPage, opts, () => { throw new Error('ledger gone') }),
    presentWindowOpenHandler(() => presenterPage, opts, () => 1),
    presentWindowOpenHandler(() => presenterPage, opts, () => undefined),
  ]) assert.deepEqual(handler({ url: 'https://example.com/', frameName: '' }), { action: 'deny' })
  assert.deepEqual(opened, [])
})

await test('the deck\'s own pages need no press; a blank window (the board, a blank page) does', () => {
  const logs = []
  let pressed = false
  const handler = presentWindowOpenHandler(() => presenterPage, { openExternal: () => { throw new Error('never') }, log: (m) => logs.push(m) }, () => pressed)
  assert.equal(handler({ url: audience, frameName: 'html-audience-abc' }).action, 'allow', 'F5 through main runs the Audience button')
  assert.equal(handler({ url: presenterPopup, frameName: 'html-presenter-x' }).action, 'allow')
  // An embedded page asking for a blank child (it would inherit the presenter's preload) with nobody at the keyboard.
  assert.deepEqual(handler({ url: 'about:blank', frameName: 'tw-board-window' }), { action: 'deny' })
  assert.deepEqual(handler({ url: 'about:blank', frameName: '_blank' }), { action: 'deny' })
  assert.deepEqual(handler({ url: 'about:blank', frameName: '' }), { action: 'deny' })
  assert.equal(logs.length, 3)
  assert.match(logs[0], /^\[window-open\] refused a blank window \(tw-board-window\): no key or mouse press in this window in the last five seconds$/)
  // The presenter presses the board's pop-out button.
  pressed = true
  assert.equal(handler({ url: 'about:blank', frameName: 'tw-board-window' }).action, 'allow')
  assert.equal(handler({ url: 'about:blank', frameName: '_blank' }).action, 'allow')
  assert.equal(logs.length, 3)
  // Fails closed without a press source.
  const bare = presentWindowOpenHandler(() => presenterPage, { openExternal: () => {}, log: () => {} })
  assert.deepEqual(bare({ url: 'about:blank', frameName: 'tw-board-window' }), { action: 'deny' })
  assert.equal(bare({ url: audience, frameName: '' }).action, 'allow')
})

// ── A deck window never hands the OS a local address (security re-review of ticket 11.3) ─────────
const LOCAL_LINKS = ['http://127.0.0.1:8787/admin?do=shutdown', 'http://localhost:7860/', 'https://LOCALHOST/', 'http://app.localhost:3000/', 'http://printer.local/', 'http://Macek.LOCAL./x',
  'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0.0.0.0:8000/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/',
  'http://100.64.0.1/', 'http://[::1]:3000/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://user:pw@127.0.0.1/', 'http://example.com@localhost:8080/']

await test('hand-out rule: a link whose host is local as written is refused in every spelling; web names and mail are not', () => {
  for (const url of LOCAL_LINKS) assert.equal(deckHandOutRefusal({ url }), 'a local address', url)
  for (const url of ['https://example.com/article', 'http://1.1.1.1/', 'https://[2606:4700:4700::1111]/', 'http://localhost.example.com/', 'http://router.lan/', 'https://rebind.example/']) {
    assert.equal(deckHandOutRefusal({ url }), null, `${url}: a name is not resolved here`)
  }
  for (const url of ['mailto:someone@example.com', 'mailto:root@localhost', 'mailto:me@127.0.0.1']) assert.equal(deckHandOutRefusal({ url }), null, `${url}: mail is not a web request`)
  // A window navigating itself: nothing leaves a blank page; a deck page's links do.
  assert.equal(deckHandOutRefusal({ url: 'https://example.com/', from: 'about:blank' }), 'a blank page hands nothing out')
  assert.equal(deckHandOutRefusal({ url: 'mailto:a@b.c', from: 'about:blank' }), 'a blank page hands nothing out')
  assert.equal(deckHandOutRefusal({ url: 'https://example.com/', from: presenterPage }), null)
  assert.equal(deckHandOutRefusal({ url: 'http://127.0.0.1/', from: presenterPage }), 'a local address')
  assert.equal(deckHandOutRefusal({ url: 'https://example.com/', from: '' }), null)
})

await test('window.open / target="_blank" from a deck window: a local address is not handed to the OS even after a press', () => {
  const opened = []
  const logs = []
  const handler = presentWindowOpenHandler(() => presenterPage, { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) }, () => true)
  for (const url of LOCAL_LINKS) assert.deepEqual(handler({ url, frameName: '_blank' }), { action: 'deny' }, url)
  assert.deepEqual(opened, [], 'the owner\'s browser was sent to no local service')
  assert.equal(logs.length, LOCAL_LINKS.length)
  assert.equal(logs[0], '[window-open] refused to hand http://127.0.0.1:8787/admin?do=shutdown to the OS: a local address')
  handler({ url: 'https://example.com/article', frameName: '_blank' })
  handler({ url: 'mailto:someone@example.com', frameName: '' })
  handler({ url: 'mailto:root@localhost', frameName: '' })
  assert.deepEqual(opened, ['https://example.com/article', 'mailto:someone@example.com', 'mailto:root@localhost'], 'web and mail links as before')
  // From a board window (about:blank opener) too.
  const board = presentWindowOpenHandler(() => 'about:blank', { openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) }, () => true)
  board({ url: 'http://localhost:9000/', frameName: '' })
  assert.equal(opened.length, 3)
})

// The spellings whose text and parse differ. What reaches openExternal must be the normalised href of the
// link that was classified, and its host must be the host that was classified.
const RAW_SPELLINGS = [
  // [what a page supplies, what is handed out (null: refused)]
  ['HTTPS://EXAMPLE.COM/Path', 'https://example.com/Path'],
  ['hTtP://Example.Com', 'http://example.com/'],
  ['  https://example.com/lead-and-trail  ', 'https://example.com/lead-and-trail'],
  ['\u0001\u001fhttps://example.com/control', 'https://example.com/control'],
  ['https://exa\tmple.com/ta\nb', 'https://example.com/tab'],
  ['https:\\\\example.com\\back\\slash', 'https://example.com/back/slash'],
  ['https:example.com', 'https://example.com/'],
  ['https:/example.com', 'https://example.com/'],
  ['https://example.com./trailing-dot', 'https://example.com./trailing-dot'],
  ['https://ex%61mple.com/escaped-host', 'https://example.com/escaped-host'],
  ['https://user:secret@example.com/creds', 'https://example.com/creds'],
  ['http://[2606:4700:4700::1111]/', 'http://[2606:4700:4700::1111]/'],
  // …and the same tricks pointed at this Mac: refused, because the host that is classified is the parsed one.
  ['http:127.0.0.1', null], ['http:/127.0.0.1', null], ['http:\\\\127.0.0.1\\x', null], ['HTTP://LOCALHOST', null], ['  http://localhost/  ', null],
  ['http://127.0.0.1%2e/', null], ['http://%31%32%37.0.0.1/', null], ['http://１２７.０.０.１/', null], ['http://127.0.0.1./', null], ['http://localhost./', null],
  ['http://example.com@127.0.0.1/', null], ['http://example.com:80@localhost:8080/', null], ['http://[::1]/', null], ['http://[0:0:0:0:0:0:0:1]:3000/', null], ['http://2130706433/', null], ['http://0x7f.1/', null],
  // not a link at all
  ['javascript:alert(1)', null], ['file:///etc/passwd', null], ['ftp://example.com/', null], ['https://', null], ['not a url', null], ['', null], ['//example.com/x', null], ['data:text/html,x', null],
  // too long
  [`https://example.com/${'a'.repeat(1_990)}`, null],
  [`https://example.com/${'a'.repeat(1_970)}`, `https://example.com/${'a'.repeat(1_970)}`],
]

await test('what is handed out is the normalised href of the link that was judged — window.open from a deck and from the editor', () => {
  for (const make of [(opts) => presentWindowOpenHandler(() => presenterPage, opts, () => true), (opts) => appWindowOpenHandler(opts, () => true)]) {
    for (const [raw, expected] of RAW_SPELLINGS) {
      const opened = []
      const handler = make({ openExternal: (u) => { opened.push(u) }, log: () => {} })
      assert.deepEqual(handler({ url: raw, frameName: '' }), { action: 'deny' }, JSON.stringify(raw))
      assert.deepEqual(opened, expected === null ? [] : [expected], JSON.stringify(raw))
      if (expected !== null) {
        const link = handOutLink(raw)
        assert.equal(link.href, opened[0], 'the same parsed object is judged and handed out')
        assert.equal(new URL(opened[0]).hostname, link.hostname)
        assert.equal(new URL(opened[0]).href, opened[0], 'already normalised: parsing it again changes nothing')
      }
    }
  }
})

await test('a mail link keeps its address, subject, body, cc and bcc; attach and every other parameter are dropped', () => {
  const sent = (raw) => { const opened = []; presentWindowOpenHandler(() => presenterPage, { openExternal: (u) => { opened.push(u) }, log: () => {} }, () => true)({ url: raw, frameName: '' }); return opened }
  assert.deepEqual(sent('mailto:someone@example.com'), ['mailto:someone@example.com'])
  assert.deepEqual(sent('MAILTO:someone@example.com?subject=Hello there'), ['mailto:someone@example.com?subject=Hello%20there'])
  // A slide's "email me your feedback" link.
  assert.deepEqual(sent('mailto:me@example.com?subject=Feedback on the talk&body=What worked:%0A%0AWhat did not:'), ['mailto:me@example.com?subject=Feedback%20on%20the%20talk&body=What%20worked%3A%0A%0AWhat%20did%20not%3A'])
  assert.deepEqual(sent('mailto:me@example.com?cc=a@example.com&bcc=b@example.com&subject=S&body=B'), ['mailto:me@example.com?cc=a%40example.com&bcc=b%40example.com&subject=S&body=B'], 'kept, in the order given')
  // What is dropped: attach in either spelling and any case, to, and anything unknown.
  assert.deepEqual(sent('mailto:someone@example.com?body=Please%20wire&attach=/Users/dl/.ssh/id_rsa&attachment=%2Fetc%2Fpasswd&to=other@example.com&x-header=1&in-reply-to=y'), ['mailto:someone@example.com?body=Please%20wire'])
  assert.deepEqual(sent('mailto:a@example.com?Subject=Q&ATTACH=%2Fetc%2Fpasswd&AttachMent=x&subject=second&BODY=b'), ['mailto:a@example.com?subject=Q&body=b'], 'names in any case; the first of each')
  assert.deepEqual(sent('mailto:a@example.com?subject=&body='), ['mailto:a@example.com'], 'empty parameters are left out')
  assert.deepEqual(sent('mailto:a@example.com,b@example.com?subject=a%26attach%3D%2Fetc%2Fpasswd'), ['mailto:a@example.com,b@example.com?subject=a%26attach%3D%2Fetc%2Fpasswd'], 'an escaped & stays inside the subject: it does not become a parameter')
  assert.deepEqual(sent('mailto:a@example.com?body=x%26attach=y'), ['mailto:a@example.com?body=x%26attach%3Dy'])
  // The same 2,000-character limit, on the normalised link.
  assert.equal(sent(`mailto:a@example.com?body=${'x'.repeat(1_974)}`)[0].length, 2_000)
  assert.deepEqual(sent(`mailto:a@example.com?body=${'x'.repeat(1_975)}`), [], 'over the limit: refused')
  assert.deepEqual(sent(`mailto:a@example.com?body=a${' '.repeat(700)}b`), [], 'a body that grows past the limit when encoded')
  assert.deepEqual(sent('mailto:'), [])
  assert.deepEqual(sent('mailto:?body=x'), [])
})

await test('the hand-out rule itself: length, scheme, the blank page, and nothing unparseable', () => {
  assert.equal(HAND_OUT_MAX_LENGTH, 2_000)
  assert.equal(handOutLink(`https://example.com/${'a'.repeat(1_980)}`).href.length, 2_000)
  assert.equal(handOutLink(`https://example.com/${'a'.repeat(1_981)}`), null)
  assert.equal(handOutLink(`https://example.com/a${' '.repeat(700)}b`), null, 'normalising may not grow a link past the limit')
  assert.equal(handOutLink(`${' '.repeat(3_000)}https://example.com/`), null, 'the string as given is measured too, before any trimming')
  for (const not of [undefined, null, 42, {}, ['https://example.com/'], 'tel:+44', 'sms:1', 'smb://server/share', 'vscode://file/x', 'x-apple.systempreferences:']) assert.equal(handOutLink(not), null, String(not))
  assert.equal(contentHandOutRefusal({ url: 'javascript:alert(1)' }), 'not a link that can be handed out')
  assert.equal(contentHandOutRefusal({ url: 'https://example.com/', from: 'about:blank' }), 'a blank page hands nothing out')
  assert.equal(contentHandOutRefusal({ url: 'https://example.com/', from: 'about:srcdoc' }), 'a blank page hands nothing out')
  assert.equal(contentHandOutRefusal({ url: 'https://example.com/', from: 'not a url' }), null)
})

// ── The editor's windows (security re-review, round 2) ───────────────────────────────────────────
// The editor's own page never calls window.open and has no target="_blank" anchor: whatever reaches its handler
// comes from a talk's content in the slide preview or Studio's replay. It is under the deck rule.
await test('editor, Tools and Pathways windows: a link from preview content needs a press in that window and is never a local address', () => {
  const opened = []
  const logs = []
  let pressed = false
  const editor = appWindowOpenHandler({ openExternal: (u) => { opened.push(u) }, log: (m) => logs.push(m) }, () => pressed)
  // A page embedded in the previewed deck calls window.open on a timer.
  assert.deepEqual(editor({ url: 'https://attacker.example/?talk=opened', frameName: '' }), { action: 'deny' })
  assert.deepEqual(editor({ url: 'mailto:x@example.com', frameName: '_blank' }), { action: 'deny' })
  assert.deepEqual(opened, [])
  assert.match(logs[0], /^\[window-open\] refused https:\/\/attacker\.example\/\?talk=opened: no key or mouse press in this window in the last five seconds$/)
  // The owner clicks a link on a slide in the preview.
  pressed = true
  editor({ url: 'https://example.com/reference', frameName: '_blank' })
  editor({ url: 'mailto:author@example.com?subject=Hi&body=x&attach=/etc/passwd', frameName: '_blank' })
  assert.deepEqual(opened, ['https://example.com/reference', 'mailto:author@example.com?subject=Hi&body=x'])
  for (const url of LOCAL_LINKS) assert.deepEqual(editor({ url, frameName: '_blank' }), { action: 'deny' }, url)
  assert.equal(opened.length, 2, 'no local address, press or not')
  // Nothing opens in-app from an app window, ever.
  for (const url of ['about:blank', 'twpresent://preview/1', presenterPage, 'file:///Users/dl/x.html', 'javascript:alert(1)']) assert.deepEqual(editor({ url, frameName: '' }), { action: 'deny' }, url)
  assert.equal(opened.length, 2)
  // Fails closed without a press source, or with one that throws.
  appWindowOpenHandler({ openExternal: (u) => { opened.push(u) }, log: () => {} })({ url: 'https://example.com/', frameName: '' })
  appWindowOpenHandler({ openExternal: (u) => { opened.push(u) }, log: () => {} }, () => { throw new Error('x') })({ url: 'https://example.com/', frameName: '' })
  assert.equal(opened.length, 2)
})

await test('the editor\'s own page opens no window: its links go through main (shell:open-external), which hands out a normalised web link only', () => {
  const rendererDir = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) ? [join(dir, e.name)] : [])
  for (const path of files(rendererDir)) {
    const text = readFileSync(path, 'utf8')
    assert.ok(!/\bwindow\.open\(/.test(text), `${path} calls window.open: it would now need a press and could not open a local address`)
    assert.ok(!/_blank/.test(text), `${path} has a target="_blank" link: the same`)
  }
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const handler = index.slice(index.indexOf("ipcMain.handle('shell:open-external'"), index.indexOf("ipcMain.handle('shell:open-external'") + 900)
  assert.match(handler, /const link = handOutLink\(url\)/)
  assert.match(handler, /if \(!link \|\| link\.kind !== 'web'\)/)
  assert.match(handler, /await shell\.openExternal\(link\.href\)/)
  assert.ok(!/openExternal\(url\)/.test(handler), 'never the string the renderer sent')
  // Every openExternal in main is one of: the two stubs handed to the guard and the handlers, and this IPC handler.
  const mainDir = fileURLToPath(new URL('../src/main/', import.meta.url))
  const sites = []
  for (const name of readdirSync(mainDir)) if (/\.ts$/.test(name)) for (const m of readFileSync(join(mainDir, name), 'utf8').matchAll(/shell\.openExternal\(([^)]*)\)/g)) sites.push(`${name}: ${m[1]}`)
  assert.deepEqual(sites.sort(), ['index.ts: link.href', 'index.ts: url', 'index.ts: url'], 'a new openExternal site: hand out a handOutLink href')
  assert.equal(index.match(/appWindowOpenHandler\(appWindowOpenOpts, \(\) => pressLedger\.pressedRecently\(win\.webContents\.id\)\)/g).length, 3, 'editor, Tools and Pathways each ask their own window\'s presses')
})

await test('every deck window in the tree is asked about ITS OWN presses', () => {
  const opened = []
  const asked = []
  const fake = (id, url) => {
    const listeners = []
    const c = { id, url, handler: null, setWindowOpenHandler(h) { c.handler = h }, getURL() { return c.url }, on(_e, l) { listeners.push(l) },
      open(childId, childUrl) { const child = fake(childId, childUrl); for (const l of listeners) l({ webContents: child }); return child } }
    return c
  }
  const pressedIn = new Set([2])
  const opts = { openExternal: (u) => { opened.push(u) }, log: () => {}, pressedRecently: (contents) => { asked.push(contents.id); return pressedIn.has(contents.id) } }
  const presenter = fake(1, presenterPage)
  guardDeckWindowTree(presenter, opts)
  const audienceWindow = presenter.open(2, audience)
  presenter.handler({ url: 'https://example.com/from-presenter', frameName: '' })
  audienceWindow.handler({ url: 'https://example.com/from-audience', frameName: '' })
  assert.deepEqual(asked, [1, 2])
  assert.deepEqual(opened, ['https://example.com/from-audience'], 'a press in the audience window says nothing about the presenter window')
  // Without the option nothing is handed out (the earlier tree test relies on the same).
  const bare = fake(3, presenterPage)
  guardDeckWindowTree(bare, { openExternal: (u) => { opened.push(u) }, log: () => {} })
  bare.handler({ url: 'https://example.com/bare', frameName: '' })
  assert.equal(opened.length, 1)
})

await test('wiring: index.ts gives the deck windows the press ledger', () => {
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(index, /const deckWindowOpenOpts = \{ \.\.\.appWindowOpenOpts, pressedRecently: \(contents: \{ id: number \}\) => pressLedger\.pressedRecently\(contents\.id\)/)
  assert.match(index, /guardDeckWindowTree\(win\.webContents, deckWindowOpenOpts\)/)
})

console.log(`present window open: ${passed} passed`)
