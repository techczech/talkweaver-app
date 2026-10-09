// A page embedded in a slide does not reach this Mac's services or the local network
// (src/main/local-address-filter.ts, embed-sandbox design 3.1, matrix row 20). The address
// classification is a pure function driven by a table; the listener is driven with the request
// details Electron 42 was observed to pass (a throwaway run on 2026-10-07: for a frame's own document
// `details.frame` is the frame that loads; for everything else the frame that asks; a shared worker's
// and main's own requests carry no frame and no window; every hop of a redirect asks again).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FILTERED_URL_PATTERNS, OUTLINE_NAMED_LOCAL_EMBED, appLocalHostOf, classifyHost, decideLocalRequest, installLocalAddressFilter, isLocalAddress,
  localAddressRequestListener, requesterOf,
} from '../src/main/local-address-filter.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const hostOf = (url) => new URL(url).hostname
const classOfUrl = (url) => classifyHost(hostOf(url))

console.log('local address filter')

// url → class. Every row is a spelling a page can put in fetch(), <img>, <iframe> or new WebSocket().
const LOCAL = [
  // IPv4 loopback, the whole 127.0.0.0/8, and the unspecified address
  'http://127.0.0.1/', 'http://127.0.0.1:8787/live', 'https://127.0.0.1:443/', 'http://127.1.2.3/', 'http://127.255.255.254/',
  'http://0.0.0.0/', 'http://0.0.0.0:7860/', 'http://0.1.2.3/',
  // other spellings of IPv4, as the URL parser reads them
  'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.1/', 'http://0x7F.0.0.1/', 'http://0177.0.0.1/', 'http://017700000001/', 'http://127.1/', 'http://127.0.1/',
  'http://0/', 'http://0x0/', 'http://3232235777/' /* 192.168.1.1 */, 'http://0xa.0.0.1/', 'http://012.1.2.3/' /* 10.1.2.3 */, 'http://0xc0a80101/',
  'http://127.0.0.1./', 'http://127.0.0.1%2e/', 'http://１２７.０.０.１/',
  // RFC 1918
  'http://10.0.0.1/', 'http://10.255.255.255/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.0.1/', 'http://192.168.255.255:8080/x?y#z',
  // link-local, carrier-grade NAT, multicast, broadcast
  'http://169.254.169.254/latest/meta-data/', 'http://169.254.0.1/', 'http://100.64.0.1/', 'http://100.127.255.255/', 'http://224.0.0.251/', 'http://255.255.255.255/',
  // IPv6 loopback and unspecified
  'http://[::1]/', 'http://[::1]:3000/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[0000:0000:0000:0000:0000:0000:0000:0001]/', 'http://[::]/', 'http://[0:0:0:0:0:0:0:0]:80/',
  // unique-local fc00::/7, link-local fe80::/10, site-local, multicast
  'http://[fc00::1]/', 'http://[fd12:3456:789a::1]/', 'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/', 'http://[fe80::1]/', 'http://[fe80::abcd:1234]:8080/', 'http://[febf::1]/',
  'http://[fec0::1]/', 'http://[ff02::1]/', 'http://[FE80::1]/', 'http://[FD00::1]/',
  // IPv6 that carries an IPv4 address: mapped, compatible, NAT64, 6to4
  'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::FFFF:10.0.0.1]/', 'http://[::ffff:192.168.1.1]:8080/', 'http://[::ffff:169.254.169.254]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
  'http://[::127.0.0.1]/', 'http://[::7f00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::10.0.0.1]/', 'http://[64:ff9b:1::1]/', 'http://[2002:7f00:1::1]/', 'http://[2002:c0a8:101::]/',
  // names
  'http://localhost/', 'http://localhost:5173/', 'http://LOCALHOST/', 'http://LocalHost:8080/', 'http://localhost./', 'http://app.localhost/', 'http://a.b.localhost:3000/', 'http://APP.LOCALHOST./',
  'http://printer.local/', 'http://Macek.local:8080/', 'http://deep.name.LOCAL./', 'http://local/',
  // userinfo and ports do not hide the host
  'http://user:pass@127.0.0.1/', 'http://example.com@127.0.0.1/', 'http://example.com:80@localhost:8080/', 'http://public.example@[::1]/', 'http://a@192.168.1.1:65535/',
  // the same hosts on the other web schemes
  'https://localhost/', 'ws://127.0.0.1:8787/sessions/x/presenter', 'wss://[::1]/', 'ws://printer.local/', 'HTTP://LOCALHOST/', 'WS://127.0.0.1/',
]
const PUBLIC = [
  'http://1.1.1.1/', 'http://8.8.8.8/', 'https://93.184.216.34/', 'http://9.255.255.255/', 'http://11.0.0.1/', 'http://126.255.255.255/', 'http://128.0.0.1/',
  'http://172.15.255.255/', 'http://172.32.0.1/', 'http://192.167.255.255/', 'http://192.169.0.1/', 'http://169.253.0.1/', 'http://169.255.0.1/', 'http://100.63.255.255/', 'http://100.128.0.1/',
  'http://192.0.78.9/', 'http://198.18.0.1/', 'http://223.255.255.255/', 'http://134744072/' /* 8.8.8.8 */, 'http://0x08080808/', 'http://1.1.1.1./',
  'http://[2606:4700:4700::1111]/', 'http://[2001:4860:4860::8888]:443/', 'http://[::ffff:8.8.8.8]/', 'http://[::ffff:808:808]/', 'http://[64:ff9b::808:808]/', 'http://[2002:808:808::1]/',
  'http://[fbff::1]/', 'http://[fe00::1]/', 'http://[2001:db8::1]/', 'http://[1::]/', 'http://[::2:0:0:0:0:0:1]/',
]
const NAMES = [
  'https://example.org/', 'https://www.youtube-nocookie.com/embed/abc', 'http://localhost.example.com/', 'http://notlocalhost/', 'http://mylocal/', 'http://local.example/', 'http://x.locale/',
  'http://127.0.0.1.example.com/', 'http://printer/', 'http://router.lan/', 'http://intranet.corp:8080/', 'https://EXAMPLE.ORG./', 'http://xn--bcher-kva.example/', 'http://bücher.example/', 'http://1.2.3.4.example/',
]

await test(`classification: ${LOCAL.length} local spellings`, () => {
  for (const url of LOCAL) assert.equal(classOfUrl(url), 'local', url)
})
await test(`classification: ${PUBLIC.length} public literal addresses`, () => {
  for (const url of PUBLIC) assert.equal(classOfUrl(url), 'public', url)
})
await test(`classification: ${NAMES.length} names that have to be resolved`, () => {
  for (const url of NAMES) assert.equal(classOfUrl(url), 'name', url)
})

await test('classification: a host given without a URL is read the same way; anything unreadable is local', () => {
  for (const host of ['2130706433', '0x7f.1', '0177.0.0.1', 'LOCALHOST', 'localhost.', '[::1]', '::1', '::ffff:127.0.0.1', 'FE80::1', 'Printer.LOCAL', ' 127.0.0.1 ']) assert.equal(classifyHost(host), 'local', host)
  for (const host of ['8.8.8.8', '2606:4700:4700::1111', '[2606:4700:4700::1111]']) assert.equal(classifyHost(host), 'public', host)
  assert.equal(classifyHost('example.org'), 'name')
  for (const host of ['', ' ', null, undefined, 42, {}, 'fe80::1%en0', '[::1', 'a b', '1::2::3', ':::', 'exa mple.org', 'http://x/']) assert.equal(classifyHost(host), 'local', String(host))
})

await test('addresses a resolver returns', () => {
  for (const address of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.20', '169.254.10.10', '100.100.100.100', 'fe80::1c2d:3e4f:5a6b:7c8d', 'fd00::1234', '::ffff:10.0.0.5', '::ffff:a00:5', '0.0.0.0', '::']) {
    assert.equal(isLocalAddress(address), true, address)
  }
  for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34']) assert.equal(isLocalAddress(address), false, address)
  for (const unreadable of ['', 'not an address', null, undefined, 7, '999.1.1.1', '1.2.3', 'fe80::1%en0', '12345::1', '1:2:3:4:5:6:7:8:9']) assert.equal(isLocalAddress(unreadable), true, String(unreadable))
})

// ── Who is asking ────────────────────────────────────────────────────────────────────────────────
const mainFrame = { parent: null }
const embed = { parent: mainFrame } // the frame the deck made for an [Embed:] line
const nested = { parent: embed } // a frame an embedded page added
const wc = { id: 4, getURL: () => 'file:///present/talk.html?presenter=1' }
const from = (frame, resourceType, extra = {}) => ({ url: 'http://127.0.0.1:8787/x', frame, resourceType, webContents: wc, webContentsId: 4, ...extra })

await test('requester: main frame, the embed frame loading itself, inside an embed, the app', () => {
  for (const type of ['mainFrame', 'xhr', 'image', 'script', 'webSocket', 'subFrame', 'other']) assert.equal(requesterOf(from(mainFrame, type)), 'main-frame', type)
  assert.equal(requesterOf(from(embed, 'subFrame')), 'embed-frame-itself')
  for (const type of ['xhr', 'image', 'script', 'stylesheet', 'font', 'media', 'webSocket', 'ping', 'object', 'cspReport', 'other', 'mainFrame', undefined]) {
    assert.equal(requesterOf(from(embed, type)), 'inside-embed', String(type))
  }
  for (const type of ['subFrame', 'xhr', 'image', 'webSocket']) assert.equal(requesterOf(from(nested, type)), 'inside-embed', `nested ${type}`)
  assert.equal(requesterOf(from({ parent: nested }, 'subFrame')), 'inside-embed')
  // No frame and no window: main's own net requests, a shared or service worker.
  assert.equal(requesterOf({ url: 'http://127.0.0.1/', resourceType: 'other' }), 'app')
  assert.equal(requesterOf({ url: 'http://127.0.0.1/', resourceType: 'xhr', frame: null, webContents: undefined, webContentsId: undefined }), 'app')
  // A window's own page before its frame is known; a frame that has gone.
  assert.equal(requesterOf({ url: 'http://localhost:5173/', resourceType: 'mainFrame', frame: null, webContents: wc }), 'main-frame')
  assert.equal(requesterOf({ url: 'http://127.0.0.1/', resourceType: 'xhr', frame: null, webContents: wc }), 'inside-embed')
  assert.equal(requesterOf({ url: 'http://127.0.0.1/', resourceType: 'xhr', frame: undefined, webContentsId: 4 }), 'inside-embed')
  // A frame whose parent cannot be read is not given the benefit of the doubt.
  assert.equal(requesterOf(from({ get parent() { throw new Error('disposed') } }, 'xhr')), 'inside-embed')
  assert.equal(requesterOf(from({ parent: { get parent() { throw new Error('disposed') } } }, 'subFrame')), 'inside-embed')
  assert.equal(requesterOf({ url: 'x', get frame() { throw new Error('disposed') } }), 'inside-embed')
})

// ── The decision ─────────────────────────────────────────────────────────────────────────────────
const decide = (url, requester, extra = {}) => decideLocalRequest({ url, requester, ...extra })

await test('decision: a request from inside an embedded frame to any local spelling is refused', () => {
  for (const url of LOCAL) assert.equal(decide(url, 'inside-embed'), 'refuse', url)
})

await test('decision: the window\'s own page is never refused, whatever the address', () => {
  for (const url of [...LOCAL, ...PUBLIC, ...NAMES, 'not a url', '']) {
    assert.equal(decide(url, 'main-frame'), 'allow', url)
    assert.equal(decide(url, 'main-frame', { outlineNamedLocalEmbed: 'refuse' }), 'allow', url)
    assert.equal(decide(url, 'main-frame', { outlineNamedLocalEmbed: 'load' }), 'allow', url)
  }
})

await test('decision: a request with no frame (a worker, main itself) reaches a local address only at a host main registered', () => {
  // A service worker or shared worker of a remote site: no frame, no window.
  for (const url of LOCAL) assert.equal(decide(url, 'app'), 'refuse', url)
  for (const url of PUBLIC) assert.equal(decide(url, 'app'), 'allow', url)
  for (const url of NAMES) assert.equal(decide(url, 'app'), 'resolve', url)
  assert.equal(decide('https://rebind.example/', 'app', { resolved: ['127.0.0.1'] }), 'refuse')
  assert.equal(decide('https://example.org/', 'app', { resolved: ['93.184.216.34'] }), 'allow')
  assert.equal(decide('not a url', 'app'), 'refuse')
  assert.equal(decide('file:///x', 'app'), 'allow', 'main serves files through the session')
  // The dev server, registered by main.
  const dev = { appLocalHosts: ['localhost:5173'] }
  assert.equal(decide('http://localhost:5173/src/main.tsx.map', 'app', dev), 'allow')
  assert.equal(decide('ws://LOCALHOST:5173/', 'app', dev), 'allow')
  assert.equal(decide('http://localhost:5174/', 'app', dev), 'refuse', 'another port is another service')
  assert.equal(decide('http://127.0.0.1:5173/', 'app', dev), 'refuse', 'only the host as registered')
  assert.equal(decide('http://localhost/', 'app', dev), 'refuse')
  assert.equal(decide('http://localhost.evil.example:5173/', 'app', dev), 'resolve', 'a name that only starts like it')
  // The registration is for frameless requests only: it opens nothing to a frame.
  assert.equal(decide('http://localhost:5173/', 'inside-embed', dev), 'refuse')
  assert.equal(decide('http://localhost:5173/', 'embed-frame-itself', dev), 'refuse')
  assert.equal(appLocalHostOf('http://LocalHost:5173/x?y'), 'localhost:5173')
  for (const not of [undefined, '', 'not a url', 'file:///x', 'twpresent://preview/1']) assert.equal(appLocalHostOf(not), null, String(not))
})

await test('decision: public addresses are let through; a name is resolved first', () => {
  for (const url of PUBLIC) assert.equal(decide(url, 'inside-embed'), 'allow', url)
  for (const url of NAMES) assert.equal(decide(url, 'inside-embed'), 'resolve', url)
  assert.equal(decide('https://example.org/', 'inside-embed', { resolved: ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] }), 'allow')
  assert.equal(decide('https://rebind.example/', 'inside-embed', { resolved: ['127.0.0.1'] }), 'refuse')
  assert.equal(decide('https://rebind.example/', 'inside-embed', { resolved: ['93.184.216.34', '10.0.0.7'] }), 'refuse', 'any local address among them')
  assert.equal(decide('https://rebind.example/', 'inside-embed', { resolved: ['::ffff:192.168.1.1'] }), 'refuse')
  assert.equal(decide('https://odd.example/', 'inside-embed', { resolved: ['not an address'] }), 'refuse')
  assert.equal(decide('https://none.example/', 'inside-embed', { resolved: [] }), 'allow', 'no address: nothing to connect to')
  // A literal address is never "resolved" into something else.
  assert.equal(decide('http://127.0.0.1/', 'inside-embed', { resolved: ['93.184.216.34'] }), 'refuse')
})

await test('decision: only web requests are judged; the app schemes, files and DevTools are not this rule\'s business', () => {
  for (const url of ['file:///Users/x/present/talk.html', 'twpresent://preview/12', 'twasset://img-abc1234', 'twfile://f/abc', 'twthumb://thumb/a/b', 'twrec://sess-1', 'twarchive://abc',
    'data:text/html,x', 'blob:null/3f1c2b9e-0000-4000-8000-000000000000', 'about:blank', 'about:srcdoc', 'devtools://devtools/bundled/devtools_app.html', 'chrome-extension://abc/x.js']) {
    assert.equal(decide(url, 'inside-embed'), 'allow', url)
    assert.equal(decide(url, 'inside-embed', { outlineNamedLocalEmbed: 'refuse' }), 'allow', url)
  }
  for (const url of ['not a url', '', 'http://', 'http://[::1/', 'http://a1.2.3.4/', 'http://1.2.3.4.5/', 'http://256.1.1.1/']) assert.equal(decide(url, 'inside-embed'), 'refuse', `unreadable: ${url}`)
})

await test('the open owner question (design 12.4): no frame in a slide loads its document from a local address', () => {
  assert.equal(OUTLINE_NAMED_LOCAL_EMBED, 'refuse', 'the value in force; the owner\'s question stays open')
  // 'embed-frame-itself' is every document load of a frame directly inside the deck's page; main cannot tell them apart.
  for (const url of LOCAL) assert.equal(decide(url, 'embed-frame-itself'), 'refuse', url)
  assert.equal(decide('http://localhost:7860/', 'embed-frame-itself'), 'refuse', 'an [Embed:] line that names this Mac')
  assert.equal(decide('https://example.org/', 'embed-frame-itself'), 'resolve')
  assert.equal(decide('https://example.org/', 'embed-frame-itself', { resolved: ['93.184.216.34'] }), 'allow', 'a remote site still loads')
  assert.equal(decide('https://example.org/', 'embed-frame-itself', { resolved: ['127.0.0.1'] }), 'refuse')
  assert.equal(decide('https://1.1.1.1/', 'embed-frame-itself'), 'allow')
  // The other value is kept for the record of what it lets through; requests from inside are refused either way.
  assert.equal(decide('http://localhost:7860/', 'embed-frame-itself', { outlineNamedLocalEmbed: 'load' }), 'allow')
  assert.equal(decide('http://localhost:7860/api', 'inside-embed', { outlineNamedLocalEmbed: 'load' }), 'refuse')
})

// ── The listener ─────────────────────────────────────────────────────────────────────────────────
function harness(overrides = {}) {
  const logs = []
  const lookups = []
  let t = 0
  const names = { 'example.org': ['93.184.216.34'], 'rebind.example': ['127.0.0.1'], 'mixed.example': ['93.184.216.34', '192.168.1.9'], ...(overrides.names ?? {}) }
  const listener = localAddressRequestListener({
    resolveHost: async (host) => { lookups.push(host); if (!(host in names)) throw new Error('net::ERR_NAME_NOT_RESOLVED'); return names[host] },
    log: (m) => logs.push(m), now: () => t, appLocalHosts: ['localhost:5173'], ...(overrides.opts ?? {}),
  })
  const ask = (details) => new Promise((resolve, reject) => {
    let answers = 0
    listener(details, (response) => { if (++answers > 1) reject(new Error('answered twice')); else resolve(response) })
  })
  return { ask, logs, lookups, tick: (ms) => { t += ms } }
}
const req = (url, frame, resourceType, extra = {}) => ({ id: 1, url, frame, resourceType, webContents: wc, webContentsId: 4, ...extra })
const cancelled = { cancel: true }

await test('listener: an embedded page\'s fetch, image, frame and WebSocket to this Mac are cancelled and logged without the path', async () => {
  const { ask, logs } = harness()
  assert.deepEqual(await ask(req('http://127.0.0.1:8787/admin?token=SECRET', embed, 'xhr')), cancelled)
  assert.deepEqual(await ask(req('http://localhost:7860/x.png', embed, 'image')), cancelled)
  assert.deepEqual(await ask(req('http://[::1]:3000/inner.html', nested, 'subFrame')), cancelled, 'a frame the embedded page adds')
  assert.deepEqual(await ask(req('ws://192.168.1.1/ws', embed, 'webSocket')), cancelled)
  assert.deepEqual(await ask(req('http://2130706433/', embed, 'xhr')), cancelled)
  assert.equal(logs.length, 5)
  assert.equal(logs[0], '[local-address] refused xhr request to http://127.0.0.1:8787 from an embedded frame in window 4 (file:///present/talk.html?presenter=1)')
  assert.ok(logs.every((line) => !line.includes('SECRET') && !line.includes('/admin')), 'no path or query in the log')
})

await test('listener: the app\'s own requests go through untouched', async () => {
  const { ask, logs, lookups } = harness()
  // The deck's main frame: the dev server, the live-session worker on this Mac, a picture the talk names.
  for (const [url, type] of [['http://localhost:5173/', 'mainFrame'], ['http://localhost:5173/src/main.tsx', 'script'], ['ws://127.0.0.1:8787/sessions/s/presenter', 'webSocket'],
    ['http://127.0.0.1:8787/sessions', 'xhr'], ['http://192.168.1.20/picture.png', 'image']]) {
    assert.deepEqual(await ask(req(url, mainFrame, type)), {}, url)
  }
  // Main's own requests: no frame, no window; a public address, and the dev server it registered.
  assert.deepEqual(await ask({ id: 2, url: 'https://1.1.1.1/update', resourceType: 'other' }), {})
  assert.deepEqual(await ask({ id: 3, url: 'http://localhost:5173/src/main.tsx.map', resourceType: 'other' }), {})
  // A remote site in a slide, and public addresses from inside it.
  assert.deepEqual(await ask(req('https://1.1.1.1/', embed, 'subFrame')), {})
  assert.deepEqual(await ask(req('https://1.1.1.1/x', embed, 'xhr')), {})
  assert.equal(logs.length, 0)
  assert.equal(lookups.length, 0, 'nothing was resolved for any of these')
})

await test('listener: a name is resolved once, cached for thirty seconds, and refused when any address is local', async () => {
  const { ask, logs, lookups, tick } = harness()
  assert.deepEqual(await ask(req('https://example.org/a.js', embed, 'script')), {})
  assert.deepEqual(await ask(req('https://EXAMPLE.org./b.js', embed, 'script')), {})
  assert.deepEqual(lookups, ['example.org'], 'one lookup for the same name in any spelling')
  assert.deepEqual(await ask(req('https://rebind.example/x', embed, 'xhr')), cancelled)
  assert.deepEqual(await ask(req('https://mixed.example/x', nested, 'image')), cancelled)
  assert.equal(logs.length, 2)
  // Two requests at once share one lookup.
  const [a, b] = await Promise.all([ask(req('https://rebind.example/1', embed, 'xhr')), ask(req('https://rebind.example/2', embed, 'xhr'))])
  assert.deepEqual([a, b], [cancelled, cancelled])
  assert.equal(lookups.filter((h) => h === 'rebind.example').length, 1)
  tick(30_001)
  await ask(req('https://example.org/c.js', embed, 'script'))
  assert.equal(lookups.filter((h) => h === 'example.org').length, 2, 'looked up again after thirty seconds')
})

await test('listener: a name that does not resolve is let through and not cached; the main frame never causes a lookup', async () => {
  const { ask, lookups } = harness()
  assert.deepEqual(await ask(req('https://no-such-name.invalid/x', embed, 'xhr')), {})
  assert.deepEqual(await ask(req('https://no-such-name.invalid/y', embed, 'xhr')), {})
  assert.equal(lookups.length, 2)
  assert.deepEqual(await ask(req('https://rebind.example/x', mainFrame, 'xhr')), {})
  assert.equal(lookups.length, 2)
})

await test('listener: every hop of a redirect is judged — a public address that redirects to this Mac is refused at that hop', async () => {
  const { ask, logs } = harness()
  // Electron asks again with the same request id and the same frame for each hop.
  assert.deepEqual(await ask(req('https://example.org/go', embed, 'xhr', { id: 77 })), {})
  assert.deepEqual(await ask(req('http://127.0.0.1:8787/secret', embed, 'xhr', { id: 77 })), cancelled)
  assert.deepEqual(await ask(req('https://example.org/frame', nested, 'subFrame', { id: 78 })), {})
  assert.deepEqual(await ask(req('http://[::1]:8787/target', nested, 'subFrame', { id: 78 })), cancelled)
  assert.equal(logs.length, 2)
})

await test('listener: a frame directly inside the deck never loads its document from this Mac, whoever sent it there', async () => {
  const { ask, logs } = harness()
  // Electron passes the same details for all of these: resourceType subFrame, the frame that loads.
  const cases = [
    ['an [Embed:] line that names this Mac', req('http://localhost:7860/', embed, 'subFrame', { method: 'GET' })],
    ['the embedded page navigating its own frame', req('http://127.0.0.1:8787/self-navigation', embed, 'subFrame', { method: 'GET', referrer: 'https://embedded.example/' })],
    ['a form in it submitted with GET', req('http://127.0.0.1:8787/form?cmd=shutdown', embed, 'subFrame', { method: 'GET' })],
    ['a form in it submitted with POST', req('http://127.0.0.1:8787/form', embed, 'subFrame', { method: 'POST', uploadData: [{ bytes: Buffer.from('cmd=shutdown') }] })],
    ['a frame an embedded page added to the deck\'s own document', req('http://192.168.1.1/admin', { parent: mainFrame }, 'subFrame', { method: 'GET' })],
    ['the same to a name that resolves to this Mac', req('https://rebind.example/', embed, 'subFrame', { method: 'GET' })],
  ]
  for (const [what, details] of cases) assert.deepEqual(await ask(details), cancelled, what)
  assert.equal(logs.length, cases.length)
  // The frame's own document redirected from a public address to a local one: refused at that hop.
  assert.deepEqual(await ask(req('https://example.org/go', embed, 'subFrame', { id: 91 })), {}, 'the public hop loads')
  assert.deepEqual(await ask(req('http://127.0.0.1:8787/redirect-target', embed, 'subFrame', { id: 91 })), cancelled, 'the local hop does not')
  assert.deepEqual(await ask(req('http://localhost:5173/', mainFrame, 'mainFrame')), {}, 'never the window\'s own page')
})

await test('listener: a worker\'s request with no frame does not reach this Mac; only the host main registered does', async () => {
  const { ask, logs } = harness()
  const frameless = (url, resourceType = 'xhr') => ({ id: 5, url, resourceType, referrer: 'https://remote.example/sw.js' })
  assert.deepEqual(await ask(frameless('http://127.0.0.1:8787/sessions')), cancelled)
  assert.deepEqual(await ask(frameless('http://localhost:9000/x', 'other')), cancelled)
  assert.deepEqual(await ask(frameless('ws://[::1]:9000/', 'webSocket')), cancelled)
  assert.deepEqual(await ask(frameless('https://rebind.example/x')), cancelled)
  assert.equal(logs.length, 4)
  assert.match(logs[0], /^\[local-address\] refused xhr request to http:\/\/127\.0\.0\.1:8787 from a worker or a request with no frame/)
  assert.deepEqual(await ask(frameless('https://example.org/x')), {})
  assert.deepEqual(await ask(frameless('http://localhost:5173/@vite/client', 'other')), {})
  const none = harness({ opts: { appLocalHosts: undefined } })
  assert.deepEqual(await none.ask(frameless('http://localhost:5173/@vite/client', 'other')), cancelled, 'nothing registered: nothing local')
})

await test('listener: the other answer to the owner\'s question lets the frame itself load, and only that', async () => {
  const { ask } = harness({ opts: { outlineNamedLocalEmbed: 'load' } })
  assert.deepEqual(await ask(req('http://localhost:7860/', embed, 'subFrame')), {})
  assert.deepEqual(await ask(req('http://localhost:7860/api', embed, 'xhr')), cancelled)
  assert.deepEqual(await ask(req('http://localhost:7860/inner', nested, 'subFrame')), cancelled)
})

await test('listener: unreadable details are refused for a frame, a flood is logged twenty times then once more', async () => {
  const { ask, logs, tick } = harness()
  assert.deepEqual(await ask(req('http://[::1/', embed, 'xhr')), cancelled)
  assert.deepEqual(await ask({ id: 9, url: 'http://127.0.0.1/', resourceType: 'xhr', webContents: wc, get frame() { throw new Error('disposed') } }), cancelled)
  logs.length = 0
  tick(10_000)
  for (let i = 0; i < 500; i++) await ask(req(`http://127.0.0.1:${1000 + i}/`, embed, 'xhr'))
  assert.equal(logs.length, 21)
  assert.match(logs[20], /further refusals in window 4 are not logged/)
  tick(10_000)
  await ask(req('http://127.0.0.1/', embed, 'xhr'))
  assert.equal(logs.length, 22, 'logged again in the next ten seconds')
  // A resolver that throws synchronously does not leave the request hanging.
  const broken = localAddressRequestListener({ resolveHost: () => { throw new Error('boom') }, log: () => {} })
  assert.deepEqual(await new Promise((resolve) => broken(req('https://example.org/', embed, 'xhr'), resolve)), {})
})

await test('install: one onBeforeRequest listener, for web requests only, resolving through the session', async () => {
  const calls = []
  const session = {
    webRequest: { onBeforeRequest: (filter, listener) => calls.push({ filter, listener }) },
    resolveHost: async (host) => ({ endpoints: host === 'rebind.example' ? [{ address: '::1', family: 'ipv6' }, { address: '127.0.0.1', family: 'ipv4' }] : [{ address: '93.184.216.34', family: 'ipv4' }] }),
  }
  installLocalAddressFilter(session, { log: () => {} })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].filter, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] })
  assert.deepEqual([...FILTERED_URL_PATTERNS], calls[0].filter.urls)
  const ask = (details) => new Promise((resolve) => calls[0].listener(details, resolve))
  assert.deepEqual(await ask(req('https://rebind.example/', embed, 'xhr')), cancelled)
  assert.deepEqual(await ask(req('https://example.org/', embed, 'xhr')), {})
})

// ── The app's own wiring ─────────────────────────────────────────────────────────────────────────
const mainDir = fileURLToPath(new URL('../src/main/', import.meta.url))
const sources = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? sources(path) : /\.(ts|mts|mjs|js)$/.test(name) ? [path] : []
})

await test('wiring: the filter is the session\'s only onBeforeRequest listener, and every window uses the default session', () => {
  const index = readFileSync(join(mainDir, 'index.ts'), 'utf8')
  assert.match(index, /installLocalAddressFilter\(session\.defaultSession, \{ appLocalHosts: \[appLocalHostOf\(process\.env\['ELECTRON_RENDERER_URL'\]\)\]/)
  // Main asks for no web address through the session itself: its one net.fetch serves a file.
  for (const m of index.matchAll(/\b(?:net\.fetch|net\.request|session\.fetch|defaultSession\.fetch)\(([^)]*)/g)) assert.match(m[1], /pathToFileURL/, `main asks the session for ${m[1]}: register its host if it is local`)
  // Electron keeps one listener per webRequest event per session: a second registration would replace this one.
  const registrations = []
  for (const path of sources(mainDir)) {
    const text = readFileSync(path, 'utf8')
    for (const m of text.matchAll(/webRequest\s*\.\s*(on[A-Za-z]+)\(/g)) registrations.push(`${path.slice(mainDir.length)}:${m[1]}`)
    if (!path.endsWith('local-address-filter.ts')) assert.ok(!/\bfromPartition\(|\bpartition\s*:/.test(text), `${path} gives a window another session, which this filter does not cover`)
  }
  assert.deepEqual(registrations.sort(), ['index.ts:onBeforeSendHeaders', 'index.ts:onHeadersReceived', 'local-address-filter.ts:onBeforeRequest'])
})

console.log(`local address filter: ${passed} passed`)
