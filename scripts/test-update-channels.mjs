// Updates in place (ADR-0044): the feed with channels (src/shared/update-channels.ts) and the checker reading
// it (src/shared/update-checker.ts). Plain Node, no network, no Electron.
//  1. version order: alpha.2 < alpha.10 < the release; the table the channel rules depend on;
//  2. channel rules: a release user never gets an alpha; an alpha user gets the newer of the two; never a downgrade;
//  3. the feed: the old shape still reads; channels.release must equal latest; hostile input refused whole;
//  4. update files: only the public repository's release assets at the entry's own tag, with hash and size;
//  5. the checker: the alpha switch re-reads the last answer without a request; switching off never downgrades;
//  6. the release check: a version published without notarisation must say so in its notes and its feed summary.
import assert from 'node:assert/strict'
import { compareVersions } from '@app-patterns/updates'
import {
  MAX_UPDATE_FILE_BYTES, RELEASE_ASSET_PREFIX, channelOffer, isAlphaVersion, newerOffer, parseChannelFeed, updateFileFor, validateUpdateFile,
} from '../src/shared/update-channels.ts'
import { createChannelChecker, readChannelState } from '../src/shared/update-checker.ts'
import { UPDATE_IDENTITY, FEED_URL } from '../src/shared/update-identity.ts'
import { NOT_NOTARISED_ASSET, channelFeedProblems, notNotarisedLine } from './lib/update-release-checks.mjs'

let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

const SHA = 'q'.repeat(86) + '=='
const entry = (version, extra = {}) => ({
  version, released: '2026-11-20', summary: ['One plain line.'], notes: `https://talkweaver.app/whats-new#${version}`,
  download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' }, ...extra,
})
const files = (version) => ({
  mac: { url: `${RELEASE_ASSET_PREFIX}v${version}/TalkWeaver-mac-arm64.zip`, sha512: SHA, size: 288_703_536, bundleId: 'com.techczech.talkweaver' },
  windows: { url: `${RELEASE_ASSET_PREFIX}v${version}/TalkWeaver-windows-x64-setup.exe`, sha512: SHA, size: 260_535_713 },
})
const feed = ({ release = '0.45.0', alpha = '0.46.0-alpha.1', withFiles = true } = {}) => {
  const rel = entry(release, withFiles ? { update: files(release) } : {})
  const { update: _u, ...latest } = structuredClone(rel)
  return { schema: 1, latest, channels: { release: rel, ...(alpha ? { alpha: entry(alpha, withFiles ? { update: files(alpha) } : {}) } : {}) } }
}
const parse = (value) => parseChannelFeed(typeof value === 'string' ? value : JSON.stringify(value), FEED_URL)

await test('version order: numeric parts compared as numbers; an alpha is older than its release', () => {
  const ordered = ['0.44.5', '0.45.0-alpha.1', '0.45.0-alpha.2', '0.45.0-alpha.9', '0.45.0-alpha.10', '0.45.0-alpha.90', '0.45.0-alpha.91', '0.45.0', '0.45.1-alpha.1', '0.45.1', '0.46.0-alpha.1', '0.46.0', '1.0.0']
  for (let i = 0; i < ordered.length; i += 1) for (let j = 0; j < ordered.length; j += 1) {
    assert.equal(Math.sign(compareVersions(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`)
  }
  assert.ok(isAlphaVersion('0.45.0-alpha.2') && isAlphaVersion('0.45.0-alpha.10'))
  for (const not of ['0.45.0', '0.45.0-beta.1', '0.45.0-alpha', '0.45.0-alpha.x', '0.45.0-alpha.1.2', 'v0.45.0-alpha.1', 45]) assert.equal(isAlphaVersion(not), false, String(not))
})

await test('channel rules: release users never get an alpha; alpha users get the newer of the two; never a downgrade', () => {
  const f = parse(feed()).feed
  // [running, alpha on, expected offer or null]
  const table = [
    ['0.44.5', false, '0.45.0'],
    ['0.44.5', true, '0.46.0-alpha.1'],
    ['0.45.0', false, null],
    ['0.45.0', true, '0.46.0-alpha.1'],
    ['0.46.0-alpha.1', true, null],
    ['0.46.0-alpha.1', false, null], // switched off on an alpha: no downgrade to 0.45.0
    ['0.45.0-alpha.3', false, '0.45.0'], // the release passes the alpha
    ['0.45.0-alpha.3', true, '0.46.0-alpha.1'],
  ]
  for (const [running, alpha, want] of table) assert.equal(newerOffer(f, alpha, running)?.version ?? null, want, `${running}, alpha ${alpha}`)
  // An alpha behind the release (left over): an alpha user gets the release.
  const stale = parse(feed({ release: '0.46.0', alpha: '0.46.0-alpha.4' })).feed
  assert.equal(channelOffer(stale, true).version, '0.46.0')
  assert.equal(newerOffer(stale, true, '0.46.0-alpha.4').version, '0.46.0')
  // No alpha published.
  const none = parse(feed({ alpha: null })).feed
  assert.equal(none.alpha, null)
  assert.equal(newerOffer(none, true, '0.44.5').version, '0.45.0')
  assert.equal(newerOffer(undefined, true, '0.44.5'), null)
})

await test('the feed: the old shape (no channels) still reads, as a release with no update file', () => {
  const { channels: _c, ...old } = feed()
  const r = parse(old)
  assert.ok(r.ok)
  assert.equal(r.feed.release.version, '0.45.0')
  assert.equal(r.feed.release.update, undefined)
  assert.equal(r.feed.alpha, null)
  assert.equal(updateFileFor(r.feed.release, 'darwin', 'arm64'), null, 'tell and link, as before')
})

await test('the feed: channels.release must say what latest says, field for field', () => {
  for (const [what, change] of [
    ['version', (f) => { f.channels.release.version = '0.45.1' }],
    ['date', (f) => { f.channels.release.released = '2026-11-21' }],
    ['summary', (f) => { f.channels.release.summary = ['Another line.'] }],
    ['summary length', (f) => { f.channels.release.summary.push('Two.') }],
    ['notes', (f) => { f.channels.release.notes = 'https://talkweaver.app/whats-new#other' }],
    ['download', (f) => { f.channels.release.download.mac = 'https://talkweaver.app/download#other' }],
  ]) {
    const f = feed()
    change(f)
    assert.deepEqual(parse(f), { ok: false, reason: 'not-a-version-list' }, what)
  }
})

await test('hostile feeds are refused whole', () => {
  const cases = {
    'alpha that is a release': (f) => { f.channels.alpha.version = '0.46.0' },
    'alpha that is a beta': (f) => { f.channels.alpha.version = '0.46.0-beta.1' },
    'release that is an alpha': (f) => { f.channels.release.version = '0.45.0-alpha.3'; f.latest.version = '0.45.0-alpha.3' },
    'unknown channel': (f) => { f.channels.beta = f.channels.alpha },
    'channels not an object': (f) => { f.channels = [] },
    'channels without release': (f) => { delete f.channels.release },
    'alpha off-site notes': (f) => { f.channels.alpha.notes = 'https://evil.example/notes' },
    'alpha HTML in summary': (f) => { f.channels.alpha.summary = ['<img src=x onerror=alert(1)>'] },
    'unknown update platform': (f) => { f.channels.release.update.linux = f.channels.release.update.mac },
    'update not an object': (f) => { f.channels.release.update = 'yes' },
    'file on another host': (f) => { f.channels.release.update.mac.url = 'https://evil.example/releases/download/v0.45.0/TalkWeaver-mac-arm64.zip' },
    'file in another repository': (f) => { f.channels.release.update.mac.url = 'https://github.com/evil/talkweaver-app/releases/download/v0.45.0/TalkWeaver-mac-arm64.zip' },
    'file at another tag': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.44.0/TalkWeaver-mac-arm64.zip` },
    'file at an alpha tag for the release': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.46.0-alpha.1/TalkWeaver-mac-arm64.zip` },
    'path climbing out': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/../v0.44.0/TalkWeaver-mac-arm64.zip` },
    'encoded path': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/%2e%2e/x.zip` },
    'query string': (f) => { f.channels.release.update.mac.url += '?x=1' },
    'fragment': (f) => { f.channels.release.update.mac.url += '#x' },
    'credentials': (f) => { f.channels.release.update.mac.url = f.channels.release.update.mac.url.replace('https://', 'https://user:pw@') },
    'http': (f) => { f.channels.release.update.mac.url = f.channels.release.update.mac.url.replace('https://', 'http://') },
    'port': (f) => { f.channels.release.update.mac.url = f.channels.release.update.mac.url.replace('github.com', 'github.com:8443') },
    'a sub-folder': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/sub/TalkWeaver-mac-arm64.zip` },
    'exe for the Mac': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/TalkWeaver.exe` },
    'zip for Windows': (f) => { f.channels.release.update.windows.url = `${RELEASE_ASSET_PREFIX}v0.45.0/TalkWeaver.zip` },
    'dmg for the Mac': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/TalkWeaver-mac-arm64.dmg` },
    'hex hash': (f) => { f.channels.release.update.mac.sha512 = 'ab'.repeat(64) },
    'short hash': (f) => { f.channels.release.update.mac.sha512 = 'q'.repeat(40) + '==' },
    'no hash': (f) => { delete f.channels.release.update.mac.sha512 },
    'size zero': (f) => { f.channels.release.update.mac.size = 0 },
    'size negative': (f) => { f.channels.release.update.mac.size = -1 },
    'size fractional': (f) => { f.channels.release.update.mac.size = 1.5 },
    'size as text': (f) => { f.channels.release.update.mac.size = '288703536' },
    'size over 4 GiB': (f) => { f.channels.release.update.mac.size = MAX_UPDATE_FILE_BYTES + 1 },
    'bundle id on Windows': (f) => { f.channels.release.update.windows.bundleId = 'com.techczech.talkweaver' },
    'bundle id with a space': (f) => { f.channels.release.update.mac.bundleId = 'com techczech' },
    'very long address': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/${'a'.repeat(400)}.zip` },
    'control character': (f) => { f.channels.release.update.mac.url = `${RELEASE_ASSET_PREFIX}v0.45.0/Talk\u0000Weaver.zip` },
  }
  for (const [name, change] of Object.entries(cases)) {
    const f = feed()
    change(f)
    assert.deepEqual(parse(f), { ok: false, reason: 'not-a-version-list' }, name)
  }
  assert.deepEqual(parse('<html>login</html>'), { ok: false, reason: 'not-json' })
  assert.deepEqual(parse(JSON.stringify(feed()) + ' '.repeat(70_000)), { ok: false, reason: 'too-large' })
  assert.deepEqual(parseChannelFeed(null, FEED_URL), { ok: false, reason: 'not-json' })
  assert.ok(parse(feed()).ok, 'the example itself is accepted')
})

await test('update files: the right one for this computer; Intel Macs and other systems get none', () => {
  const f = parse(feed()).feed
  assert.equal(updateFileFor(f.release, 'darwin', 'arm64').url, `${RELEASE_ASSET_PREFIX}v0.45.0/TalkWeaver-mac-arm64.zip`)
  assert.equal(updateFileFor(f.release, 'darwin', 'arm64').bundleId, 'com.techczech.talkweaver')
  assert.equal(updateFileFor(f.release, 'win32', 'x64').url, `${RELEASE_ASSET_PREFIX}v0.45.0/TalkWeaver-windows-x64-setup.exe`)
  assert.equal(updateFileFor(f.release, 'darwin', 'x64'), null)
  assert.equal(updateFileFor(f.release, 'win32', 'arm64'), null)
  assert.equal(updateFileFor(f.release, 'linux', 'x64'), null)
  assert.equal(updateFileFor(null, 'darwin', 'arm64'), null)
  // A loopback stand-in's prefix (tests) is accepted only when the checker is given it.
  const local = 'http://127.0.0.1:4567/releases/download/'
  const file = { url: `${local}v0.45.0/TalkWeaver-mac-arm64.zip`, sha512: SHA, size: 10 }
  assert.ok(validateUpdateFile(file, 'mac', '0.45.0', local))
  assert.equal(validateUpdateFile(file, 'mac', '0.45.0'), null, 'the production prefix refuses it')
})

// ── The checker with channels ────────────────────────────────────────────────────────────────────
function harness({ running = '0.45.0', alpha = false } = {}) {
  const h = { now: Date.UTC(2026, 10, 20, 9), state: {}, alpha, requests: 0, told: [], answer: { ok: true, text: JSON.stringify(feed()) } }
  h.checker = createChannelChecker({
    identity: UPDATE_IDENTITY, running, platform: 'darwin', arch: 'arm64', source: 'website',
    fetchFeed: async () => { h.requests += 1; return h.answer },
    readState: () => readChannelState(JSON.parse(JSON.stringify(h.state)), FEED_URL),
    writeState: (s) => { h.state = JSON.parse(JSON.stringify(s)) },
    enabled: () => true, alpha: () => h.alpha, isBusy: () => false, hasNotes: () => false, hadConfiguration: () => true,
    now: () => h.now, changed: (s) => h.told.push(s), schedule: () => ({}), cancel: () => {},
  })
  return h
}

await test('the checker: the alpha switch re-reads the last answer at once, with no request', async () => {
  const h = harness()
  const first = await h.checker.checkNow()
  assert.equal(first.mark, null, 'a release user on the release: nothing')
  assert.equal(first.state.lastResult, 'current')
  h.alpha = true
  const on = h.checker.settingChanged()
  assert.equal(h.requests, 1, 'no second request')
  assert.equal(on.alpha, true)
  assert.equal(on.mark.version, '0.46.0-alpha.1')
  assert.equal(on.mark.update.mac.bundleId, 'com.techczech.talkweaver', 'the mark carries the update file')
  h.alpha = false
  assert.equal(h.checker.settingChanged().mark, null)
})

await test('the checker: an alpha user who switches alpha off keeps the alpha until the release passes it', async () => {
  const h = harness({ running: '0.46.0-alpha.1', alpha: false })
  assert.equal((await h.checker.checkNow()).mark, null, 'no downgrade to 0.45.0')
  h.answer = { ok: true, text: JSON.stringify(feed({ release: '0.46.0', alpha: null })) }
  assert.equal((await h.checker.checkNow()).mark.version, '0.46.0', 'the release passes the alpha')
})

await test('the checker: the stored channels are validated again when read back', () => {
  const good = JSON.parse(JSON.stringify(feed()))
  const state = readChannelState({ channels: good.channels, latest: good.channels.alpha }, FEED_URL)
  assert.equal(state.channels.alpha.version, '0.46.0-alpha.1')
  assert.equal(state.latest.version, '0.46.0-alpha.1', 'an alpha offer is kept')
  good.channels.release.update.mac.url = 'https://evil.example/x.zip'
  const tampered = readChannelState({ channels: good.channels }, FEED_URL)
  assert.equal(tampered.channels, undefined, 'a tampered file address in the config file is dropped')
  assert.deepEqual(readChannelState('nonsense', FEED_URL), {})
})

await test('the release check: a version published without notarisation says so in its release notes and its feed summary, or the check fails', () => {
  const alphaLine = notNotarisedLine('0.46.0-alpha.1')
  assert.equal(alphaLine, 'This alpha is not notarised: after downloading it from the website, macOS asks you to allow it in System Settings.')
  assert.equal(notNotarisedLine('0.45.0'), 'This version is not notarised: after downloading it from the website, macOS asks you to allow it in System Settings.')
  assert.ok(alphaLine.length <= 120 && notNotarisedLine('0.45.0').length <= 120, 'fits a feed summary line')
  const ok = { tag: 'v0.46.0-alpha.1', draft: false, prerelease: true, assets: ['TalkWeaver-mac-arm64.zip'], body: 'Notes.' }
  const text = (f) => JSON.stringify(f)
  assert.deepEqual(channelFeedProblems({ feedText: text(feed()), releaseTag: 'v0.45.0', alphaRelease: ok }), [], 'notarised: nothing to say')
  const skipped = { ...ok, assets: [...ok.assets, NOT_NOTARISED_ASSET] }
  const unlabelled = channelFeedProblems({ feedText: text(feed()), releaseTag: 'v0.45.0', alphaRelease: skipped })
  assert.equal(unlabelled.length, 2, 'both the summary and the release notes are missing the line')
  assert.match(unlabelled.join(' '), /without notarisation/)
  const labelled = feed()
  labelled.channels.alpha.summary = [alphaLine, 'One plain line.']
  assert.deepEqual(channelFeedProblems({ feedText: text(labelled), releaseTag: 'v0.45.0', alphaRelease: { ...skipped, body: `${alphaLine}\n\nNotes.` } }), [])
  assert.equal(channelFeedProblems({ feedText: text(labelled), releaseTag: 'v0.45.0', alphaRelease: skipped }).length, 1, 'the release notes alone missing it still fails')
  // A release published the same way.
  const relProblems = channelFeedProblems({ feedText: text(feed({ alpha: null })), releaseTag: 'v0.45.0', alphaRelease: null, releaseGitHub: { assets: [NOT_NOTARISED_ASSET], body: '' } })
  assert.equal(relProblems.length, 2)
})

console.log(`update channels: ${passed} checks passed`)
