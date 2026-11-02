// Update notices (ADR-0041): the release feed's validator, version order, links and the bare request
// (@app-patterns/updates, with TalkWeaver's identity in src/shared/update-identity.ts). Plain Node, no network.
//  1. the validator accepts the example and rejects each malformed case, whole;
//  2. version order: newer, equal, older, pre-release against its own release;
//  3. links: only https on talkweaver.app, in every spelling that could read differently;
//  4. the request carries no version, cookie, identifier or query string, and the fixed User-Agent.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { feedAddresses, feedProblems, whatsNewProblems } from './lib/update-release-checks.mjs'
import {
  MAX_FEED_BYTES, compareVersions, downloadLinkFor as downloadLink, isPreviewVersion, isReleaseNumber,
  isSiteLink as siteLink, parseVersion, validateFeed as validate, versionLabel,
} from '@app-patterns/updates'
import { FEED_URL, FEED_REQUEST } from '../src/shared/update-identity.ts'
const LINK_PREFIX = 'https://talkweaver.app/'
const DOWNLOAD_PAGE = 'https://talkweaver.app/download'
const validateFeed = (text) => validate(text, FEED_URL)

const isSiteLink = (link) => siteLink(link, FEED_URL)
const downloadLinkFor = (latest, platform) => downloadLink(latest, platform, FEED_URL)
let passed = 0
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

const example = () => ({
  schema: 1,
  latest: {
    version: '0.42.0', released: '2026-11-12',
    summary: ['Slides can be copied between vaults with their pictures.', 'The presenter view shows the next two slides.', 'Handouts print with page numbers.'],
    notes: 'https://talkweaver.app/whats-new#0.42.0',
    download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' },
  },
})
const answer = (value) => validateFeed(typeof value === 'string' ? value : JSON.stringify(value))
const mutate = (fn) => { const feed = example(); fn(feed); return answer(feed) }

test('the spec example is accepted, and read back as written', () => {
  const result = answer(example())
  assert.equal(result.ok, true)
  assert.deepEqual(result.latest, example().latest)
})

test('every malformed feed is rejected whole', () => {
  const bad = {
    'wrong schema': mutate((f) => { f.schema = 2 }),
    'no schema': mutate((f) => { delete f.schema }),
    'no latest': answer({ schema: 1 }),
    'latest is a list': answer({ schema: 1, latest: [] }),
    'pre-release version': mutate((f) => { f.latest.version = '0.42.0-preview.3' }),
    'not a version': mutate((f) => { f.latest.version = 'latest' }),
    'version is a number': mutate((f) => { f.latest.version = 42 }),
    'date not a date': mutate((f) => { f.latest.released = '12 November 2026' }),
    'impossible date': mutate((f) => { f.latest.released = '2026-02-31' }),
    'no summary': mutate((f) => { delete f.latest.summary }),
    'empty summary': mutate((f) => { f.latest.summary = [] }),
    'four summary lines': mutate((f) => { f.latest.summary = ['a', 'b', 'c', 'd'] }),
    'summary line too long': mutate((f) => { f.latest.summary = ['x'.repeat(121)] }),
    'summary line empty': mutate((f) => { f.latest.summary = ['  '] }),
    'html in the summary': mutate((f) => { f.latest.summary = ['<b>New</b> things'] }),
    'script in the summary': mutate((f) => { f.latest.summary = ['<script>alert(1)</script>'] }),
    'summary not text': mutate((f) => { f.latest.summary = [{ text: 'x' }] }),
    'control character in the summary': mutate((f) => { f.latest.summary = ['one\u0000two'] }),
    'notes link on another site': mutate((f) => { f.latest.notes = 'https://example.com/whats-new' }),
    'download link on another site': mutate((f) => { f.latest.download.mac = 'https://evil.example/TalkWeaver.dmg' }),
    'download link over http': mutate((f) => { f.latest.download.windows = 'http://talkweaver.app/download#windows' }),
    'a javascript link': mutate((f) => { f.latest.notes = 'javascript:alert(1)' }),
    'no windows link': mutate((f) => { delete f.latest.download.windows }),
    'download is a string': mutate((f) => { f.latest.download = 'https://talkweaver.app/download' }),
  }
  for (const [name, result] of Object.entries(bad)) assert.equal(result.ok, false, `${name} must be rejected`)
  assert.equal(bad['wrong schema'].reason, 'not-a-version-list')
})

test('text that is not JSON, and an answer that is too large', () => {
  assert.deepEqual(answer('<html><body>Log in to the hotel wifi</body></html>'), { ok: false, reason: 'not-json' })
  assert.deepEqual(answer(''), { ok: false, reason: 'not-json' })
  assert.deepEqual(answer('null'), { ok: false, reason: 'not-a-version-list' })
  assert.deepEqual(answer('[]'), { ok: false, reason: 'not-a-version-list' })
  assert.deepEqual(validateFeed(undefined), { ok: false, reason: 'not-json' })
  const padded = JSON.stringify({ ...example(), pad: 'x'.repeat(MAX_FEED_BYTES) })
  assert.deepEqual(answer(padded), { ok: false, reason: 'too-large' })
  const multibyte = 'é'.repeat(MAX_FEED_BYTES / 2 + 1)
  assert.deepEqual(answer(multibyte), { ok: false, reason: 'too-large' }, 'size is counted in bytes, not characters')
})

test('extra fields in the feed are dropped, not carried', () => {
  const feed = example()
  feed.latest.evil = 'x'
  feed.extra = { a: 1 }
  const result = answer(feed)
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.latest).sort(), ['download', 'notes', 'released', 'summary', 'version'])
})

test('version order', () => {
  assert.equal(compareVersions('0.42.0', '0.41.0'), 1)
  assert.equal(compareVersions('0.41.0', '0.42.0'), -1)
  assert.equal(compareVersions('0.41.0', '0.41.0'), 0)
  assert.equal(compareVersions('0.41.10', '0.41.9'), 1, 'numbers, not text')
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.equal(compareVersions('0.42.0-preview.3', '0.42.0'), -1, 'a preview is older than its own release')
  assert.equal(compareVersions('0.42.0', '0.42.0-preview.3'), 1)
  assert.equal(compareVersions('0.42.0-preview.3', '0.42.0-preview.4'), -1)
  assert.equal(compareVersions('0.42.0-preview.10', '0.42.0-preview.9'), 1)
  assert.equal(compareVersions('0.42.0-preview.3', '0.41.0'), 1, 'a preview of the next version is newer than the last release')
  assert.equal(compareVersions('0.42.0-preview', '0.42.0-preview.1'), -1)
  assert.equal(compareVersions('garbage', '0.41.0'), 0, 'unreadable versions never order')
})

test('version parsing and wording', () => {
  assert.deepEqual(parseVersion('0.42.0-preview.3'), { major: 0, minor: 42, patch: 0, pre: ['preview', 3] })
  for (const bad of ['', '1', '1.2', 'v1.2.3', '1.2.3.4', '1.2.3-', '1.2.3 ', ' 1.2.3', '1.2.-3', 7, null]) assert.equal(parseVersion(bad), null, String(bad))
  assert.equal(isReleaseNumber('0.42.0'), true)
  assert.equal(isReleaseNumber('0.42.0-preview.3'), false)
  assert.equal(isPreviewVersion('0.42.0-preview.3'), true)
  assert.equal(isPreviewVersion('0.42.0'), false)
  assert.equal(versionLabel('0.42.0-preview.3'), '0.42.0, preview 3')
  assert.equal(versionLabel('0.41.0'), '0.41.0')
})

test('links: https on talkweaver.app only, in every spelling', () => {
  for (const ok of ['https://talkweaver.app/', 'https://talkweaver.app/download#mac', 'https://talkweaver.app/whats-new#0.42.0']) assert.equal(isSiteLink(ok), true, ok)
  for (const bad of [
    'http://talkweaver.app/download', 'https://talkweaver.app', 'https://talkweaver.app.evil.example/x', 'https://talkweaver.app@evil.example/x',
    'https://talkweaver.app:8443/x', 'https://user:pw@talkweaver.app/x', 'https://talkweaver.app\\@evil.example/', 'https://talkweaver.app/ x',
    'https://talkweaver.app/\nx', 'https://TALKWEAVER.app/x', 'HTTPS://talkweaver.app/x', 'ftp://talkweaver.app/x', 'https://www.talkweaver.app/x', 'https://talkweaver.app/' + 'a'.repeat(400),
    42, null, undefined, {},
  ]) assert.equal(isSiteLink(bad), false, String(bad))
  assert.equal(LINK_PREFIX, 'https://talkweaver.app/')
})

test('the download link is the one for this computer', () => {
  const { latest } = answer(example())
  assert.equal(downloadLinkFor(latest, 'darwin'), 'https://talkweaver.app/download#mac')
  assert.equal(downloadLinkFor(latest, 'win32'), 'https://talkweaver.app/download#windows')
  assert.equal(downloadLinkFor(latest, 'linux'), DOWNLOAD_PAGE)
})

test('the request is bare: a GET with a fixed User-Agent, nothing that identifies the app or the person', () => {
  assert.equal(FEED_URL, 'https://talkweaver.app/updates.json')
  assert.equal(FEED_REQUEST.url, FEED_URL)
  assert.equal(FEED_REQUEST.method, 'GET')
  assert.equal(new URL(FEED_REQUEST.url).search, '', 'no query string')
  assert.equal(new URL(FEED_REQUEST.url).hash, '')
  assert.deepEqual(Object.keys(FEED_REQUEST.headers).sort(), ['Accept', 'User-Agent'])
  assert.equal(FEED_REQUEST.headers['User-Agent'], 'TalkWeaver', 'Electron’s default would carry the version')
  for (const [name, value] of Object.entries(FEED_REQUEST.headers)) {
    assert.ok(!/cookie|authorization|x-/i.test(name), name)
    assert.ok(!/\d+\.\d+\.\d+/.test(value), `no version in ${name}`)
  }
  assert.equal(FEED_REQUEST.timeoutMs, 10_000)
  assert.equal(FEED_REQUEST.maxBytes, 64 * 1024)
})

test('release checks: notes for a release, and the live feed against the latest published release', () => {
  const notes = '- **A.** One sentence here.\n- **B.** Another one.\n- Third item.\n'
  assert.deepEqual(whatsNewProblems('0.42.0', notes), [])
  assert.equal(whatsNewProblems('0.42.0', null).length, 1, 'a release without notes is refused')
  assert.equal(whatsNewProblems('0.42.0', '- only one\n').length, 1)
  assert.equal(whatsNewProblems('0.42.0', Array.from({ length: 9 }, (_, i) => `- item ${i}`).join('\n')).length, 1)
  assert.deepEqual(whatsNewProblems('0.42.0-preview.3', null), [], 'a preview needs none')
  const feedText = JSON.stringify(example())
  assert.deepEqual(feedProblems({ feedText, releaseTag: 'v0.42.0' }), [])
  assert.match(feedProblems({ feedText, releaseTag: 'v0.41.0' })[0], /updates\.json says 0\.42\.0 but the latest published release is 0\.41\.0/)
  assert.match(feedProblems({ feedText: feedText.replace('talkweaver.app/download#mac', 'evil.example/x'), releaseTag: 'v0.42.0' })[0], /not a valid version list/)
  assert.match(feedProblems({ feedText: 'nope', releaseTag: 'v0.42.0' })[0], /not-json/)
  assert.deepEqual(feedAddresses(example().latest), ['https://talkweaver.app/whats-new', 'https://talkweaver.app/download'])
  const shipped = readFileSync(new URL('../resources/whats-new/0.41.0.md', import.meta.url), 'utf8')
  assert.deepEqual(whatsNewProblems('0.41.0', shipped), [], 'the notes shipped for 0.41.0 pass their own check')
})

console.log(`update feed: ${passed} checks passed`)

// Exercise the installed Electron adapter through injected ports, without Electron or a request.
const { createElectronFeedFetcher } = await import('@app-patterns/updates/electron')
const { UPDATE_IDENTITY } = await import('../src/shared/update-identity.ts')
const { EventEmitter } = await import('node:events')
for (const oversized of [false, true]) {
  const calls = [], partition = {}, response = new EventEmitter()
  response.statusCode = 200
  const request = new EventEmitter()
  request.setHeader = (name, value) => calls.push(['header', name, value])
  request.abort = () => calls.push(['abort'])
  request.end = () => queueMicrotask(() => {
    request.emit('response', response)
    response.emit('data', Buffer.from(oversized ? 'x'.repeat(MAX_FEED_BYTES + 1) : JSON.stringify(example())))
    response.emit('end')
  })
  const fetch = createElectronFeedFetcher(UPDATE_IDENTITY, {
    net: { request: (options) => { calls.push(['request', options]); return request } },
    session: { fromPartition: (name, options) => { calls.push(['partition', name, options]); return partition } },
  })
  const result = await fetch()
  assert.deepEqual(calls[0], ['partition', 'app-patterns-updates', { cache: false }])
  assert.deepEqual(calls[1], ['request', { url: FEED_URL, method: 'GET', credentials: 'omit', redirect: 'error', session: partition }])
  assert.deepEqual(calls.filter(([kind]) => kind === 'header'), [['header', 'User-Agent', 'TalkWeaver'], ['header', 'Accept', 'application/json']])
  assert.deepEqual(result, oversized ? { ok: false, reason: 'too-large' } : { ok: true, text: JSON.stringify(example()) })
  assert.equal(calls.filter(([kind]) => kind === 'abort').length, 1)
}
console.log('update Electron adapter: 2 checks passed (bare request and response cap)')
