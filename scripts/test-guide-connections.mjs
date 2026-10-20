// test:guide-connections — onboarding 0.38.1 ticket 11, What it connects to, re-based on Settings → Cloudflare (0.38.2).
//   - the ten rows' names, icons, needs and "without it" lines are CONNECTS' in the drawing's text module, except the
//     share-address row (added) and the transcription need (ffmpeg now ships with the app);
//   - the Cloudflare, going-live, share-address, recording-storage and transcription rows FOLLOW the statuses Settings
//     shows: each row's state text is the text of the Settings row's own edge (publishingRowEdge, goingLiveRowEdge,
//     shareLinkRowEdge, recordingRowEdge, transcriptionRowEdge), one test per row, not set up and ready;
//   - every action on those rows opens Settings → Cloudflare; no Guide text sends a person to Bitwarden, wrangler or a
//     hand-installed ffmpeg;
//   - the other rows are pure functions over injected facts (no Mac is read);
//   - the probes (src/main/guide-connections.ts) run over an injected stat and injected statuses: a stat that never
//     answers is "not found" after the time bound; nothing is spawned and no network, secret or file content is
//     touched (the module imports none of it);
//   - the renderer names an action by id and main holds the link; main feeds the rows from the same status functions
//     Settings' IPC calls; the probe runs on ask, never at startup.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONNECTION_TEXT, NO_SOURCES, connectionRows } from '../src/shared/guide-connections.ts'
import { GUIDE_LINKS, bounded, findProgram, gatherConnectionSources, isGuideLinkId, probeConnections, searchDirs } from '../src/main/guide-connections.ts'
import { CONNECTS } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'
import { connectionLabel, publishingRowEdge, shareLinkRowEdge } from '../src/shared/cloudflare-status.ts'
import { goingLiveRowEdge, unknownGoingLive } from '../src/shared/live-service-status.ts'
import { recordingRowEdge, recordingStorageRow } from '../src/shared/recording-storage-status.ts'
import { transcriptionRowEdge } from '../src/shared/transcription-status.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const row = (rows, id) => rows.find((r) => r.id === id)
const src = (patch) => ({
  ...NO_SOURCES, ...patch,
  cloudflare: { ...NO_SOURCES.cloudflare, ...(patch.cloudflare ?? {}) },
  tools: { ...NO_SOURCES.tools, ...(patch.tools ?? {}) }, backup: { ...NO_SOURCES.backup, ...(patch.backup ?? {}) }
})
const CONNECTED = { state: 'connected', account: { id: 'acct', name: 'Test account' } }
const publishing = (state, extra = {}) => ({ state, project: 'talkweaver-handouts', permission: null, customDomain: 'none', stale: false, ...extra })
const shareLink = (state, extra = {}) => ({ state, host: 'talks.example.org', permission: null, stale: false, ...extra })
const goingLive = (state, extra = {}) => ({ ...unknownGoingLive('build-1'), state, ...extra })
const transcription = (state, extra = {}) => ({ state, pythonVersion: '3.11', ffmpeg: 'shipped', ffmpegConfigured: false, ...extra })
// The Settings row's own words for an edge, so a test never retypes them.
const edgeText = (edge) => (edge.kind === 'state' ? edge.text : null)

await test('ten rows: the drawing’s names, icons, needs and "without it" lines, plus the share-address row; ffmpeg ships, so the transcription need says so', () => {
  const rows = connectionRows(NO_SOURCES)
  assert.equal(rows.length, 10)
  assert.deepEqual(rows.map((r) => r.id), ['pages', 'live', 'share', 'r2', 'transcription', 'office', 'agent', 'synced', 'backups', 'slidewell'])
  const drawn = rows.filter((r) => r.id !== 'share')
  CONNECTS.forEach((c, i) => {
    assert.equal(drawn[i].name, c.name)
    assert.equal(drawn[i].icon, c.icon, c.name)
    assert.equal(drawn[i].without, c.without, c.name)
    if (drawn[i].id !== 'transcription') assert.equal(drawn[i].need, c.need, c.name)
  })
  assert.match(row(rows, 'transcription').need, /ffmpeg ships with TalkWeaver/)
  assert.equal(row(rows, 'share').name, 'Share-link address')
  assert.equal(CONNECTION_TEXT.notSetUp, 'Not set up')
  assert.equal(CONNECTION_TEXT.found, 'Found on this Mac')
  assert.equal(CONNECTION_TEXT.setUpInSettings, CONNECTS[0].action)
  assert.equal(CONNECTION_TEXT.chooseFolder, CONNECTS[7].action)
  assert.equal(CONNECTION_TEXT.getSlideWell, CONNECTS[8].action)
  assert.equal(CONNECTS[4].state, CONNECTION_TEXT.found)
  assert.equal(CONNECTS[8].state, CONNECTION_TEXT.notFound)
})

await test('with nothing set up, the Cloudflare rows read Not set up and open Settings → Cloudflare; SlideWell Not found', () => {
  const rows = connectionRows(NO_SOURCES)
  for (const id of ['pages', 'live', 'share', 'r2']) {
    assert.equal(row(rows, id).stateText, 'Not set up', id)
    assert.equal(row(rows, id).state, 'off', id)
    assert.deepEqual(row(rows, id).action, { id: 'open-cloudflare', label: 'Set up in Settings', enabled: true }, id)
  }
  assert.equal(row(rows, 'transcription').stateText, 'Not set up — optional')
  assert.equal(row(rows, 'transcription').action.id, 'open-cloudflare')
  assert.equal(row(rows, 'agent').action.label, 'Set up in Settings')
  assert.equal(row(rows, 'backups').action.label, 'Choose a folder…')
  assert.equal(row(rows, 'slidewell').stateText, 'Not found on this Mac')
  assert.equal(row(rows, 'slidewell').action.id, 'get-slidewell')
  assert.equal(row(rows, 'office').action, null)
  assert.equal(row(rows, 'synced').action, null)
})

await test('Cloudflare Pages follows the connection and the Publishing handouts row: not set up, each connection state, no site, ready', () => {
  const notSetUp = row(connectionRows(src({})), 'pages')
  assert.deepEqual([notSetUp.state, notSetUp.stateText, notSetUp.action.id], ['off', 'Not set up', 'open-cloudflare'])
  for (const connection of [{ state: 'checking' }, { state: 'rejected' }, { state: 'unreachable', lastCheckedAt: null }, { state: 'choose-account', accounts: [] }, { state: 'storage-unavailable', doing: 'save' }]) {
    const r = row(connectionRows(src({ cloudflare: { connection } })), 'pages')
    assert.deepEqual([r.state, r.stateText, r.action.id], ['part', connectionLabel(connection), 'open-cloudflare'], connection.state)
  }
  const noSite = row(connectionRows(src({ cloudflare: { connection: CONNECTED, publishing: publishing('no-site') } })), 'pages')
  assert.deepEqual([noSite.state, noSite.stateText, noSite.action.id], ['part', 'No site yet', 'open-cloudflare'])
  const noPerm = row(connectionRows(src({ cloudflare: { connection: CONNECTED, publishing: publishing('no-permission', { permission: 'Account · Cloudflare Pages · Edit' }) } })), 'pages')
  assert.deepEqual([noPerm.state, noPerm.stateText], ['part', edgeText(publishingRowEdge(publishing('no-permission')))])
  const ready = row(connectionRows(src({ cloudflare: { connection: CONNECTED, publishing: publishing('ready') } })), 'pages')
  assert.deepEqual([ready.state, ready.stateText, ready.action], ['on', edgeText(publishingRowEdge(publishing('ready'))), null])
  assert.equal(ready.stateText, 'Ready')
})

await test('the Cloudflare account id, project and token in config no longer decide anything: the connection does', () => {
  const code = read('src/shared/guide-connections.ts') + read('src/main/guide-connections.ts')
  for (const gone of [/cfAccountId/, /cfPagesProject/, /cloudflare-token/, /pagesTokenHeld/, /r2KeysHeld/]) assert.ok(!gone.test(code), `${gone} is not read by the Guide`)
})

await test('no Guide text sends a person to Bitwarden, wrangler, brew or a hand-installed ffmpeg', () => {
  const files = ['src/shared/guide-connections.ts', 'src/shared/guide-topics.ts', 'src/shared/guide-chapters.ts', 'src/renderer/src/components/GuideFeatures.tsx', 'resources/example-vault/harvest-supper-draft/harvest-supper-draft-outline.md']
  for (const file of files) assert.ok(!/bitwarden|wrangler|\bbrew\b|homebrew|install ffmpeg|bws\b/i.test(read(file).replace(/^\s*\/\/.*$/gm, '')), `${file} names none of them`)
  assert.match(read('resources/example-vault/harvest-supper-draft/harvest-supper-draft-outline.md'), /opens Settings; Cloudflare is there\./)
})

await test('Cloudflare live service follows the Going live and sharing row: not set up, setting up, ready, no permission, failed', () => {
  const live = (state, extra) => row(connectionRows(src({ goingLive: goingLive(state, extra) })), 'live')
  const notSetUp = live('not-set-up')
  assert.deepEqual([notSetUp.state, notSetUp.stateText, notSetUp.action.id], ['off', 'Not set up', 'open-cloudflare'])
  assert.deepEqual([live('unknown').state, live('unknown').stateText], ['off', 'Not set up'])
  const ready = live('ready', { address: 'https://x.workers.dev', build: 'build-1' })
  assert.deepEqual([ready.state, ready.stateText, ready.action], ['on', edgeText(goingLiveRowEdge(goingLive('ready'))), null])
  assert.equal(ready.stateText, 'Ready')
  for (const [state, words] of [['set-up-elsewhere', 'Set up on another computer'], ['access-removed', 'This computer\'s access was removed']]) {
    const r = live(state)
    assert.deepEqual([r.stateText, r.state, r.action.id], [words, 'part', 'open-cloudflare'], state)
  }
  for (const state of ['setting-up', 'updating', 'no-permission', 'failed']) {
    const r = live(state)
    assert.equal(r.stateText, edgeText(goingLiveRowEdge(goingLive(state))), state)
    assert.equal(r.state, 'part', state)
    assert.equal(r.action.id, 'open-cloudflare', state)
  }
  assert.ok(!JSON.stringify(connectionRows(NO_SOURCES)).includes('0.39'), 'no "coming in 0.39" any more')
})

await test('the share address follows the Share-link domain row: not set up, none, attached, not on the account, ready', () => {
  const share = (state, extra) => row(connectionRows(src({ cloudflare: { connection: CONNECTED, shareLink: shareLink(state, extra) } })), 'share')
  assert.deepEqual([row(connectionRows(src({})), 'share').state, row(connectionRows(src({})), 'share').stateText], ['off', 'Not set up'])
  const none = share('none', { host: '' })
  assert.deepEqual([none.state, none.stateText, none.action.id], ['off', edgeText(shareLinkRowEdge(shareLink('none'))), 'open-cloudflare'])
  const attached = share('attached')
  assert.deepEqual([attached.state, attached.stateText, attached.action], ['on', 'Attached', null])
  for (const state of ['not-on-account', 'no-permission', 'not-attached']) {
    const r = share(state)
    assert.equal(r.stateText, edgeText(shareLinkRowEdge(shareLink(state))), state)
    assert.equal(r.action.id, 'open-cloudflare', state)
  }
  assert.equal(share('not-on-account').state, 'part')
})

await test('Cloudflare R2 follows the Recording storage row: not set up, keys saved, ready, bucket not found, keys rejected', () => {
  const rec = (input) => row(connectionRows(src({ recording: recordingStorageRow({ endpoint: 'https://x.r2.example', bucket: 'recs', hasKeys: true, ...input }) })), 'r2')
  const none = row(connectionRows(NO_SOURCES), 'r2')
  assert.deepEqual([none.state, none.stateText], ['off', 'Not set up'])
  const part = row(connectionRows(src({ recording: recordingStorageRow({ endpoint: 'https://x.r2.example', bucket: '', hasKeys: false }) })), 'r2')
  assert.deepEqual([part.state, part.stateText, part.action.id], ['off', 'Not set up', 'open-cloudflare'])
  const saved = rec({})
  assert.deepEqual([saved.state, saved.stateText, saved.action.id], ['part', edgeText(recordingRowEdge(recordingStorageRow({ endpoint: 'e', bucket: 'b', hasKeys: true }))), 'open-cloudflare'])
  const ready = rec({ finding: 'ready' })
  assert.deepEqual([ready.state, ready.stateText, ready.action], ['on', 'Ready', null])
  assert.equal(rec({ finding: 'bucket-not-found' }).stateText, 'Bucket not found')
  assert.deepEqual([rec({ finding: 'keys-rejected' }).state, rec({ finding: 'keys-rejected' }).stateText], ['part', 'Keys rejected'])
  assert.equal(rec({ finding: 'ready', checking: true }).stateText, 'Checking…')
})

await test('Local transcription follows the Transcription row (ffmpeg ships with the app): not set up, each missing piece, ready', () => {
  const tr = (state, extra) => row(connectionRows(src({ transcription: transcription(state, extra) })), 'transcription')
  const none = tr('not-set-up')
  assert.deepEqual([none.state, none.stateText, none.action.id], ['off', 'Not set up — optional', 'open-cloudflare'])
  for (const state of ['python-not-set', 'python-not-found', 'script-not-set', 'script-not-found', 'ffmpeg-not-found']) {
    const r = tr(state)
    assert.equal(r.stateText, edgeText(transcriptionRowEdge(transcription(state))), state)
    assert.deepEqual([r.state, r.action.id], ['part', 'open-cloudflare'], state)
  }
  const ready = tr('ready')
  assert.deepEqual([ready.state, ready.stateText, ready.action], ['on', 'Ready', null])
  // The shipped ffmpeg is enough: a Mac with no ffmpeg of its own and everything else set reads Ready.
  assert.equal(tr('ready', { ffmpeg: 'shipped' }).state, 'on')
})

await test('LibreOffice and Poppler: both, one, neither', () => {
  assert.equal(row(connectionRows(src({ tools: { libreoffice: true, poppler: true } })), 'office').stateText, 'Found on this Mac')
  const one = row(connectionRows(src({ tools: { libreoffice: true } })), 'office')
  assert.deepEqual([one.state, one.stateText], ['part', 'Partly found: LibreOffice. No Poppler'])
  assert.equal(row(connectionRows(NO_SOURCES), 'office').stateText, 'Not found on this Mac')
})

await test('Your own agent: a known agent program found, or not set up', () => {
  const found = row(connectionRows(src({ tools: { agents: ['claude', 'codex'] } })), 'agent')
  assert.deepEqual([found.state, found.stateText, found.action], ['on', 'Found on this Mac: Claude Code, Codex', null])
  assert.equal(row(connectionRows(NO_SOURCES), 'agent').stateText, 'Not set up')
})

await test('A synced folder: the drawn Git case, a cloud folder, several vaults, none', () => {
  const git = row(connectionRows(src({ vaults: [{ name: 'Personal', service: null, git: true }] })), 'synced')
  assert.deepEqual([git.state, git.stateText, git.action], ['on', 'Found on this Mac: Git, on vault Personal', null])
  assert.equal(git.stateText, CONNECTS[6].state, 'the drawing’s own words')
  const both = row(connectionRows(src({ vaults: [{ name: 'Teaching', service: 'OneDrive', git: false }, { name: 'Talks', service: null, git: true }] })), 'synced')
  assert.equal(both.stateText, 'Found on this Mac: OneDrive, on vault Teaching; Git, on vault Talks')
  assert.equal(row(connectionRows(src({ vaults: [] })), 'synced').state, 'off')
})

await test('Single-HTML backups: a folder chosen and on, chosen but off, chosen but gone, nothing chosen', () => {
  const on = row(connectionRows(src({ backup: { enabled: true, folderName: 'Backups', folderExists: true } })), 'backups')
  assert.deepEqual([on.state, on.stateText, on.action], ['on', 'Set up: Backups', null])
  const off = row(connectionRows(src({ backup: { enabled: false, folderName: 'Backups', folderExists: true } })), 'backups')
  assert.deepEqual([off.state, off.stateText], ['part', 'Partly set up: a folder is chosen; backups are off'])
  const gone = row(connectionRows(src({ backup: { enabled: true, folderName: 'Backups', folderExists: false } })), 'backups')
  assert.equal(gone.stateText, 'Partly set up: the folder Backups is not there')
  assert.equal(row(connectionRows(NO_SOURCES), 'backups').state, 'off')
})

await test('SlideWell: found, or not found with Get SlideWell', () => {
  const found = row(connectionRows(src({ slidewell: true })), 'slidewell')
  assert.deepEqual([found.state, found.stateText, found.action], ['on', 'Found on this Mac', null])
})

// ── the probes, over an injected stat ──
const FILES = new Set()
const FOLDERS = new Set()
const deps = (over = {}) => ({
  platform: 'darwin', home: '/Users/test', pathEnv: '/usr/bin:/custom/bin', timeoutMs: 40,
  stat: async (path) => FILES.has(path) ? { isFile: true, isDirectory: false, executable: true } : FOLDERS.has(path) ? { isFile: false, isDirectory: true, executable: true } : null,
  config: {}, cloudflare: () => NO_SOURCES.cloudflare, goingLive: () => NO_SOURCES.goingLive, recording: () => NO_SOURCES.recording, transcription: async () => NO_SOURCES.transcription, vaults: () => [],
  ...over
})
const reset = () => { FILES.clear(); FOLDERS.clear() }

await test('probes: a program is found on PATH, in the places the Importer looks, and a file that is not runnable is not a program', async () => {
  reset()
  FILES.add('/custom/bin/ffmpeg')
  FILES.add('/opt/homebrew/bin/soffice')
  FILES.add('/Applications/LibreOffice.app/Contents/MacOS/soffice')
  assert.equal(await findProgram(['ffmpeg'], deps()), true)
  assert.equal(await findProgram(['soffice'], deps()), true)
  assert.equal(await findProgram(['pdftoppm'], deps()), false)
  FILES.add('/usr/bin/pdftoppm')
  assert.equal(await findProgram(['pdftoppm'], deps()), true)
  const notRunnable = deps({ stat: async () => ({ isFile: true, isDirectory: false, executable: false }) })
  assert.equal(await findProgram(['ffmpeg'], notRunnable), false)
  assert.ok(searchDirs(deps()).includes('/opt/homebrew/bin') && searchDirs(deps()).includes('/custom/bin'))
  assert.equal(await findProgram(['ffmpeg'], deps({ platform: 'win32', pathEnv: 'C:\\tools', stat: async (p) => p === 'C:\\tools/ffmpeg.exe' || p.endsWith('ffmpeg.exe') ? { isFile: true, isDirectory: false, executable: false } : null })), true, 'Windows needs no execute bit')
})

await test('probes: the Cloudflare, going-live, recording and transcription rows are the very statuses main hands over (Settings’ own)', async () => {
  reset()
  FILES.add('/opt/homebrew/bin/pdftoppm'); FILES.add('/usr/local/bin/claude')
  FOLDERS.add('/Users/test/Backups'); FOLDERS.add('/Applications/SlideWell.app')
  const cloudflare = { ...NO_SOURCES.cloudflare, connection: CONNECTED, publishing: publishing('ready'), shareLink: shareLink('attached') }
  const recording = recordingStorageRow({ endpoint: 'https://x.r2.example', bucket: 'recs', hasKeys: true, finding: 'ready' })
  const d = deps({
    config: { backupEnabled: true, backupFolder: '~/Backups' },
    cloudflare: () => cloudflare, goingLive: () => goingLive('ready', { build: 'build-1' }), recording: () => recording, transcription: async () => transcription('ready'),
    vaults: () => [{ name: 'Personal', service: 'Git' }, { name: 'Teaching', service: 'OneDrive' }, { name: 'Local one', service: 'Local' }]
  })
  const sources = await gatherConnectionSources(d)
  assert.equal(sources.cloudflare, cloudflare)
  assert.equal(sources.recording, recording)
  assert.deepEqual(sources.transcription, transcription('ready'))
  assert.deepEqual(sources.tools, { libreoffice: false, poppler: true, agents: ['claude'] })
  assert.deepEqual(sources.vaults, [{ name: 'Personal', service: null, git: true }, { name: 'Teaching', service: 'OneDrive', git: false }])
  assert.deepEqual(sources.backup, { enabled: true, folderName: 'Backups', folderExists: true })
  assert.equal(sources.slidewell, true)
  const rows = await probeConnections(d)
  assert.equal(rows.length, 10)
  for (const id of ['pages', 'live', 'share', 'r2', 'transcription']) assert.equal(row(rows, id).state, 'on', id)
  assert.equal(row(rows, 'synced').stateText, 'Found on this Mac: Git, on vault Personal; OneDrive, on vault Teaching')
  assert.equal(row(rows, 'office').stateText, 'Partly found: Poppler. No LibreOffice')
  // The same rows, computed from the statuses alone, are what the Guide shows.
  assert.deepEqual(rows, connectionRows(sources))
})

await test('probes: a failing status or source is "not set up" or "not found", never an error', async () => {
  reset()
  const broken = await gatherConnectionSources(deps({
    cloudflare: () => { throw new Error('store') }, goingLive: () => { throw new Error('store') }, recording: () => { throw new Error('keychain') },
    transcription: async () => { throw new Error('python') }, vaults: () => { throw new Error('registry') }, stat: async () => { throw new Error('EIO') }
  }))
  assert.deepEqual(broken.cloudflare, NO_SOURCES.cloudflare)
  assert.deepEqual(broken.recording, NO_SOURCES.recording)
  assert.deepEqual(broken.transcription, NO_SOURCES.transcription)
  assert.deepEqual(broken.vaults, [])
  assert.equal(broken.tools.libreoffice, false)
  const json = JSON.stringify(await gatherConnectionSources(deps({ config: { backupFolder: '/x' } })))
  for (const value of ['token', 'secret', 'password']) assert.ok(!json.toLowerCase().includes(`"${value}"`), `${value} is not a field`)
})

await test('probes: a stat that never answers is bounded: not found after the time bound, not a hang', async () => {
  const started = Date.now()
  const hung = deps({ timeoutMs: 60, stat: () => new Promise(() => {}), config: { backupFolder: '/Volumes/Hung/Backups' } })
  const sources = await gatherConnectionSources(hung)
  assert.equal(sources.tools.libreoffice, false)
  assert.equal(sources.backup.folderExists, false)
  assert.equal(sources.slidewell, false)
  assert.ok(Date.now() - started < 1500, 'all probes ran together inside the bound')
  assert.equal(await bounded(new Promise(() => {}), 20, 'late'), 'late')
  assert.equal(await bounded(Promise.resolve('on time'), 20, 'late'), 'on time')
  assert.equal(await bounded(Promise.reject(new Error('x')), 20, 'failed'), 'failed')
})

await test('read-only by construction: the probe module spawns nothing, uses no network, reads no file content, names no secret store', () => {
  const code = read('src/main/guide-connections.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/'https:[^']*'/g, "''") // the one link main holds is data, not a request
  for (const banned of [/child_process/, /\bspawn/, /\bexec(Sync|File)?\(/, /\bfetch\(/, /\bhttps?\b/, /\bnet\b/, /readFile/, /readdir/, /createReadStream/, /writeFile/, /safeStorage/, /decrypt/]) {
    assert.ok(!banned.test(code), `no ${banned}`)
  }
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(imports.sort(), [
    '../shared/cloudflare-status.ts', '../shared/guide-connections.ts', '../shared/live-service-status.ts',
    '../shared/recording-storage-status.ts', '../shared/transcription-status.ts', 'node:path'
  ])
})

await test('the action names a link and main holds the URL; the probe runs on ask, never at startup', () => {
  assert.deepEqual(Object.keys(GUIDE_LINKS), ['online-content-report', 'slidewell-download'])
  assert.equal(isGuideLinkId('slidewell-download'), true)
  for (const bad of ['https://example.com', 'zotero-download', '', null, undefined, 3, { id: 'slidewell-download' }]) assert.equal(isGuideLinkId(bad), false)
  const main = read('src/main/index.ts')
  assert.ok(main.includes("ipcMain.handle('guide:connections'") && main.includes("ipcMain.handle('guide:open-link'"))
  const handler = main.slice(main.indexOf("ipcMain.handle('guide:open-link'"), main.indexOf("ipcMain.handle('guide:open-link'") + 500)
  assert.ok(handler.includes('isAppWindow') && handler.includes('isGuideLinkId(id)') && handler.includes('GUIDE_LINKS[id]'), 'checked in main; the renderer sends an id only')
  // The rows read the same status functions Settings' IPC calls.
  for (const [call, ipc] of [['cloudflareConnection().status()', "ipcMain.handle('cloudflare:status'"], ['recordingStorage().status()', "ipcMain.handle('recording:storage-status'"], ['transcriptionSetup().status()', "ipcMain.handle('transcription:status'"], ['liveService().row()', "ipcMain.handle('live-service:status'"]]) {
    assert.ok(main.includes(ipc) && main.slice(main.indexOf(ipc), main.indexOf(ipc) + 120).includes(call), `Settings reads ${call}`)
    const probe = main.slice(main.indexOf('probeConnections({'), main.indexOf("ipcMain.handle('guide:connections'"))
    assert.ok(probe.includes(call), `the Guide reads ${call} too`)
  }
  assert.equal((main.match(/probeConnections\(/g) ?? []).length, 1, 'one probe call, inside readConnections')
  assert.equal((main.match(/readConnections\(\)/g) ?? []).length, 2, 'readConnections is declared once and called by the ask handler only')
  const preload = read('src/preload/index.ts')
  assert.ok(preload.includes("connections: (): Promise<ConnectionRow[]> => ipcRenderer.invoke('guide:connections')"))
  assert.ok(preload.includes("openLink: (id: 'slidewell-download' | 'online-content-report')"))
  // The renderer asks when the Features segment mounts (its connections section), and on the refresh button.
  const app = read('src/renderer/src/App.tsx')
  assert.equal((app.match(/guide\.connections\(\)/g) ?? []).length, 1)
  const features = read('src/renderer/src/components/GuideFeatures.tsx')
  assert.ok(features.includes('useEffect(() => { check() }, [check])') && features.includes('data-connections-refresh'))
  // Cloudflare-backed rows open Settings → Cloudflare, by the same route as a publish sheet's Open Settings.
  assert.match(app, /action === 'open-cloudflare'\) \{ setSettingsCloudflare\(\(asked\) => asked \+ 1\); setSettingsOpen\(true\) \}/)
  assert.ok(!app.slice(0, app.indexOf('const readConnections')).includes('guide.connections'), 'App itself never asks at startup')
})

console.log(`\n${passed} passed`)
