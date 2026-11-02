// A publication reaches a presenter window that is already open (src/main/presenter-publication.ts,
// src/preload/present-live-state.ts): only a successful, current publication of the same Talk or Run,
// only the windows that are still open, and only the window's link: never its slide, timer, recording
// or live session, and never Go live. The same journey in the real app is
// e2e/diagnose-presenter-publication.mjs.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createPresenterPublications, liveLinkFolder, presenterLink } from '../src/main/presenter-publication.ts'
import { stampPublishedLink } from '../src/preload/present-live-state.ts'
import { functionBody, readSource } from './lib/read-source.mjs'
import { transformSync } from 'esbuild'
import { readHandoutUrl, stampHandoutUrl } from '../src/main/publishing-logic.ts'

let passed = 0
const test = async (name, work) => {
  try { await work(); passed += 1; console.log(`  ok  ${name}`) } catch (error) { console.error(`  FAIL ${name}`); throw error }
}
console.log('presenter publication')

const TALK = '/vault/alpha/alpha-outline.md'
const OTHER = '/vault/beta/beta-outline.md'
const URL_A = 'https://handouts.example.test/alpha'
const URL_RUN = 'https://handouts.example.test/alpha-event'

function harness(windows) {
  const contexts = new Map(windows.map((item) => [item.id, { talkSlug: 'alpha', vaultRoot: '/vault', shortUrl: null, ...item.context }]))
  const open = new Set(windows.map((item) => item.id))
  const announced = []
  const service = createPresenterPublications({
    windows: () => windows.map((item) => [item.id, { outlinePath: item.outlinePath ?? TALK, mode: item.mode ?? 'presenter', ...(item.runId ? { runId: item.runId } : {}) }]),
    contexts,
    isOpen: (id) => open.has(id),
    announce: (id, change) => { announced.push({ id, ...change }) },
  })
  return { contexts, open, announced, service }
}

await test('the link a presenter opens with: the Run\'s own, then the talk\'s, then the file on this computer', () => {
  const run = { handoutUrl: URL_RUN, handoutFolder: 'alpha-event' }
  assert.deepEqual(presenterLink({ run, outlineUrl: URL_A, localUrl: 'file:///x' }), { shortUrl: URL_RUN, runLink: { folder: 'alpha-event' } })
  assert.deepEqual(presenterLink({ run: { handoutUrl: URL_RUN }, outlineUrl: null, localUrl: null }), { shortUrl: URL_RUN, runLink: {} })
  assert.deepEqual(presenterLink({ run: { handoutUrl: URL_RUN, unpublishedAt: '2026-10-01T09:00:00Z' }, outlineUrl: URL_A, localUrl: null }), { shortUrl: URL_A }, 'an unpublished Run is not a link')
  assert.deepEqual(presenterLink({ run: null, outlineUrl: URL_A, localUrl: 'file:///x' }), { shortUrl: URL_A })
  assert.deepEqual(presenterLink({ run: null, outlineUrl: null, localUrl: 'file:///x' }), { shortUrl: 'file:///x' })
  assert.deepEqual(presenterLink({ run: null, outlineUrl: null, localUrl: null }), { shortUrl: null })
})

await test('the folder of the site a window\'s join link is kept in', () => {
  assert.equal(liveLinkFolder({ talkSlug: 'alpha', shortUrl: URL_A }), 'alpha')
  assert.equal(liveLinkFolder({ talkSlug: 'alpha', shortUrl: URL_RUN, runLink: { folder: 'alpha-event' } }), 'alpha-event', 'a Run\'s link leads to the Run\'s folder, never the talk\'s')
  assert.equal(liveLinkFolder({ talkSlug: 'alpha', shortUrl: URL_RUN, runLink: {} }), null, 'an older Run with no recorded folder: its link is used as it stands')
})

await test('a talk\'s publication reaches its open presenters, and only theirs', () => {
  const { contexts, announced, service } = harness([
    { id: 1 }, { id: 2, context: { shortUrl: 'file:///local' } }, { id: 3, outlinePath: OTHER, context: { talkSlug: 'beta' } },
  ])
  const before3 = contexts.get(3)
  assert.deepEqual(service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A }), [1, 2])
  assert.deepEqual(contexts.get(1), { talkSlug: 'alpha', vaultRoot: '/vault', shortUrl: URL_A }, 'the talk and vault stay what they were')
  assert.equal(contexts.get(2).shortUrl, URL_A, 'the published link replaces a file on this computer')
  assert.equal(contexts.get(3), before3, 'another talk is not touched')
  assert.deepEqual(announced, [{ id: 1, url: URL_A, first: true }, { id: 2, url: URL_A, first: true }])
})

await test('a Run\'s presenter: the Run\'s publication sets it, the talk\'s fills in only where the Run has no link', () => {
  const { contexts, service } = harness([{ id: 1, runId: 'run-a' }, { id: 2, runId: 'run-b' }, { id: 3 }, { id: 4, runId: 'run-a', outlinePath: OTHER }])
  assert.deepEqual(service.published(service.ticket(), { kind: 'run', outlinePath: TALK, runId: 'run-a', url: URL_RUN, folder: 'alpha-event' }), [1], 'not another Run, the plain talk or the same Run id of another talk')
  assert.deepEqual(contexts.get(1).runLink, { folder: 'alpha-event' })
  assert.equal(contexts.get(1).shortUrl, URL_RUN)
  assert.equal(contexts.get(2).shortUrl, null)
  assert.equal(contexts.get(3).shortUrl, null)
  assert.equal(contexts.get(4).shortUrl, null)
  assert.deepEqual(service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A }), [2, 3], 'the Run with a link of its own keeps it')
  assert.equal(contexts.get(1).shortUrl, URL_RUN)
  assert.equal(contexts.get(2).shortUrl, URL_A)
})

await test('a window that closed, or is no presenter, takes nothing', () => {
  const { contexts, open, announced, service } = harness([{ id: 1 }, { id: 2 }])
  open.delete(2)
  contexts.set(3, { talkSlug: 'alpha', vaultRoot: '/vault', shortUrl: null })
  assert.deepEqual(service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A }), [1])
  assert.equal(contexts.get(2).shortUrl, null)
  assert.equal(announced.length, 1)
  const plain = harness([{ id: 5, mode: 'window' }, { id: 6, mode: 'audience' }])
  assert.deepEqual(plain.service.published(plain.service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A }), [])
})

await test('a window opened after the publication began is still reached: the window is read when the result arrives', () => {
  const windows = []
  const { service, contexts, open } = harness(windows)
  const ticket = service.ticket()
  windows.push({ id: 9 })
  contexts.set(9, { talkSlug: 'alpha', vaultRoot: '/vault', shortUrl: null })
  open.add(9)
  assert.deepEqual(service.published(ticket, { kind: 'talk', outlinePath: TALK, url: URL_A }), [9])
  assert.equal(contexts.get(9).shortUrl, URL_A)
})

await test('a late result of an earlier publication does not undo a newer one', () => {
  const { contexts, service } = harness([{ id: 1 }])
  const older = service.ticket()
  const newer = service.ticket()
  service.published(newer, { kind: 'talk', outlinePath: TALK, url: 'https://handouts.example.test/new' })
  assert.deepEqual(service.published(older, { kind: 'talk', outlinePath: TALK, url: 'https://handouts.example.test/old' }), [])
  assert.equal(contexts.get(1).shortUrl, 'https://handouts.example.test/new')
})

await test('successful Run removal clears its own marker, uses the current talk link, and ignores other identities', () => {
  const { contexts, open, announced, service } = harness([
    { id: 1, runId: 'run-a', context: { shortUrl: URL_RUN, runLink: { folder: 'alpha-event' } } },
    { id: 2, runId: 'run-b', context: { shortUrl: URL_RUN, runLink: {} } },
    { id: 3, runId: 'run-a', outlinePath: OTHER, context: { shortUrl: URL_RUN, runLink: {} } },
    { id: 4, runId: 'run-a', context: { shortUrl: URL_RUN, runLink: {} } },
    { id: 5, runId: 'run-a', context: { shortUrl: URL_A } },
  ])
  open.delete(4)
  const untouched = [2, 3, 4, 5].map((id) => contexts.get(id))
  assert.deepEqual(service.unpublishedRun(service.ticket(), { outlinePath: TALK, runId: 'run-a' }, URL_A), [1])
  assert.deepEqual(contexts.get(1), { talkSlug: 'alpha', vaultRoot: '/vault', shortUrl: URL_A })
  assert.deepEqual([2, 3, 4, 5].map((id) => contexts.get(id)), untouched)
  assert.deepEqual(announced, [{ id: 1, url: URL_A, first: false }])
  assert.deepEqual(service.unpublishedRun(service.ticket(), { outlinePath: TALK, runId: 'run-a' }, URL_A), [], 'duplicate removal announces nothing')
})

await test('Run removal with a non-web talk fallback clears the removed QR', () => {
  for (const fallback of ['file:///old-handout.html', 'unavailable', '']) {
    const { contexts, announced, service } = harness([{ id: 1, runId: 'run-a', context: { shortUrl: URL_RUN, runLink: {} } }])
    assert.deepEqual(service.unpublishedRun(service.ticket(), { outlinePath: TALK, runId: 'run-a' }, fallback), [1])
    assert.equal(contexts.get(1).shortUrl, null)
    assert.deepEqual(announced, [{ id: 1, url: null, first: false }])
  }
})

await test('Run removal with no talk link clears readiness and rejects late publication or removal results', () => {
  const { contexts, announced, service } = harness([{ id: 1, runId: 'run-a' }])
  const old = service.ticket()
  service.published(old, { kind: 'run', outlinePath: TALK, runId: 'run-a', url: URL_RUN })
  const removed = service.ticket()
  assert.deepEqual(service.unpublishedRun(removed, { outlinePath: TALK, runId: 'run-a' }, null), [1])
  assert.deepEqual(contexts.get(1), { talkSlug: 'alpha', vaultRoot: '/vault', shortUrl: null })
  assert.deepEqual(announced.at(-1), { id: 1, url: null, first: false })
  assert.deepEqual(service.published(old, { kind: 'run', outlinePath: TALK, runId: 'run-a', url: URL_RUN }), [])
  const newer = service.ticket()
  service.published(newer, { kind: 'run', outlinePath: TALK, runId: 'run-a', url: `${URL_RUN}-new` })
  assert.deepEqual(service.unpublishedRun(removed, { outlinePath: TALK, runId: 'run-a' }, null), [])
  assert.equal(contexts.get(1).shortUrl, `${URL_RUN}-new`)
})

await test('talk removal clears ordinary and Run-fallback presenters but leaves own Run links and other windows alone', () => {
  const { contexts, announced, open, service } = harness([
    { id: 1, context: { shortUrl: URL_A } },
    { id: 2, runId: 'run-a', context: { shortUrl: URL_A } },
    { id: 3, runId: 'run-b', context: { shortUrl: URL_RUN, runLink: {} } },
    { id: 4, outlinePath: OTHER, context: { shortUrl: URL_A } },
    { id: 5, context: { shortUrl: URL_A } },
  ])
  open.delete(5)
  const untouched = [3, 4, 5].map((id) => contexts.get(id))
  const removal = service.ticket()
  service.forgetTalk(removal, TALK)
  assert.equal(contexts.get(1).shortUrl, null)
  assert.equal(contexts.get(2).shortUrl, null)
  assert.deepEqual([3, 4, 5].map((id) => contexts.get(id)), untouched)
  assert.deepEqual(announced, [{ id: 1, url: null, first: false }, { id: 2, url: null, first: false }])
  service.forgetTalk(removal, TALK)
  assert.equal(announced.length, 2, 'duplicate removal announces nothing')
  const newerUrl = `${URL_A}-new`
  service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: newerUrl })
  service.forgetTalk(removal, TALK)
  assert.equal(contexts.get(1).shortUrl, newerUrl, 'a delayed removal cannot clear a newer publication')
  assert.equal(contexts.get(2).shortUrl, newerUrl)
})

await test('a stampable publication is not retained as a fallback after canonical metadata removal', () => {
  const { service } = harness([])
  service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A })
  assert.equal(service.talkUrl(TALK), null)
})

await test('canonical frontmatter without a link overrides retained success, including after frontmatter is added', () => {
  const source = transformSync(functionBody(readSource('src/main/index.ts'), 'outlineUrlOnDisk'), { loader: 'ts' }).code
  const select = new Function('readFileSync', 'readHandoutUrl', 'stampHandoutUrl', 'presenterPublications', 'outlinePath', `${source}\nreturn outlineUrlOnDisk(outlinePath)`)
  const resolve = (text) => select(() => text, readHandoutUrl, stampHandoutUrl, { talkUrl: () => URL_A }, TALK)
  assert.equal(resolve('---\ntitle: Test\n---\n\n## Slide'), null)
  assert.equal(resolve('## Slide without frontmatter'), URL_A)
  assert.equal(resolve(`---\nhandout_url: ${URL_RUN}\n---\n`), URL_RUN)
})

await test('a successful talk link survives a publication with no presenter or stampable frontmatter', () => {
  const { service } = harness([])
  const older = service.ticket()
  const newer = service.ticket()
  assert.equal(service.talkUrl(TALK), null)
  service.published(newer, { kind: 'talk', outlinePath: TALK, url: URL_A, retainUrl: true })
  service.published(older, { kind: 'talk', outlinePath: TALK, url: `${URL_A}-old`, retainUrl: true })
  service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: 'file:///local' })
  service.published(service.ticket(), { kind: 'run', outlinePath: TALK, runId: 'run-a', url: URL_RUN })
  assert.equal(service.talkUrl(TALK), URL_A, 'only a current successful talk publication is retained')
  assert.equal(service.talkUrl(OTHER), null, 'another talk has no retained link')
  assert.deepEqual(presenterLink({ run: { handoutUrl: URL_RUN }, outlineUrl: service.talkUrl(TALK), localUrl: null }), { shortUrl: URL_RUN, runLink: {} }, 'the Run keeps its own publication')
  const removal = service.ticket()
  service.forgetTalk(removal, TALK)
  assert.equal(service.talkUrl(TALK), null, 'a successful unpublish invalidates the retained address')
  service.published(newer, { kind: 'talk', outlinePath: TALK, url: URL_A })
  assert.equal(service.talkUrl(TALK), null, 'a delayed result from before removal cannot restore it')
  const afterRemoval = service.ticket()
  service.published(afterRemoval, { kind: 'talk', outlinePath: TALK, url: `${URL_A}-new`, retainUrl: true })
  service.forgetTalk(removal, TALK)
  assert.equal(service.talkUrl(TALK), `${URL_A}-new`, 'a late removal result cannot clear a newer publication')
})

await test('the same link again changes nothing and says nothing; a new link is said, not as a first', () => {
  const { announced, service } = harness([{ id: 1 }])
  service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A })
  assert.deepEqual(service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: URL_A }), [], 'no second listener call')
  service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url: `${URL_A}-2` })
  assert.deepEqual(announced, [{ id: 1, url: URL_A, first: true }, { id: 1, url: `${URL_A}-2`, first: false }])
})

await test('only a web address is a publication', () => {
  const { contexts, service } = harness([{ id: 1 }])
  for (const url of ['', 'file:///x', 'javascript:alert(1)', 'not a link', null]) {
    assert.deepEqual(service.published(service.ticket(), { kind: 'talk', outlinePath: TALK, url }), [])
  }
  assert.equal(contexts.get(1).shortUrl, null)
})

// The stamp the deck itself reads when "Show talk QR code" is pressed (the presenter template's talkQrLink).
function fakeDocument() {
  const nodes = new Map()
  const attributes = (id) => ({
    id, innerHTML: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = String(value) }, getAttribute(name) { return this.attrs[name] ?? null },
  })
  return {
    nodes, body: { append: (node) => nodes.set(node.id, node) },
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => attributes(''),
  }
}
await test('the share link in the deck: stamped once, replaced, and left alone without a picture or a web address', () => {
  const document = fakeDocument()
  assert.equal(stampPublishedLink(document, { url: 'file:///x', qrSvg: '<svg/>' }), false)
  assert.equal(stampPublishedLink(document, { url: URL_A, qrSvg: '' }), false)
  assert.equal(stampPublishedLink(document, null), false)
  assert.equal(document.nodes.size, 0)
  assert.equal(stampPublishedLink(document, { url: URL_A, qrSvg: '<svg>a</svg>' }), true)
  const stamp = document.getElementById('twTalkQr')
  assert.deepEqual([stamp.attrs['data-url'], stamp.innerHTML], [URL_A, '<svg>a</svg>'])
  assert.equal(stampPublishedLink(document, { url: URL_RUN, qrSvg: '<svg>b</svg>' }), true)
  assert.equal(document.nodes.size, 1, 'one stamp, replaced')
  assert.deepEqual([document.getElementById('twTalkQr').attrs['data-url'], document.getElementById('twTalkQr').innerHTML], [URL_RUN, '<svg>b</svg>'])
  assert.equal(stampPublishedLink(document, null), true, 'an authoritative missing link clears the old stamp')
  assert.deepEqual([stamp.attrs['data-url'], stamp.innerHTML], ['', ''])
})

await test('a delayed initial share-link reply cannot undo a newer publication push', async () => {
  const bridge = readSource('src/preload/present-live-bridge.ts')
  const start = bridge.indexOf('  let publishedLinkRevision = 0')
  const end = bridge.indexOf('  const requestedStatusRevision', start)
  assert.ok(start >= 0 && end > start, 'the actual mount subscription and initial request are tested together')
  const code = transformSync(bridge.slice(start, end), { loader: 'ts', format: 'cjs' }).code
  const document = fakeDocument()
  let push
  let reply
  const ipcRenderer = { on: (_name, listener) => { push = listener }, invoke: () => new Promise((resolve) => { reply = resolve }) }
  new Function('ipcRenderer', 'document', 'stampPublishedLink', code)(ipcRenderer, document, stampPublishedLink)
  push({}, { url: URL_RUN, qrSvg: '<svg>new</svg>' })
  reply({ url: URL_A, qrSvg: '<svg>old</svg>' })
  await Promise.resolve()
  assert.equal(document.getElementById('twTalkQr').attrs['data-url'], URL_RUN)
})

await test('a delayed initial link cannot restore a Run link after an unpublish clear', async () => {
  const bridge = readSource('src/preload/present-live-bridge.ts')
  const start = bridge.indexOf('  let publishedLinkRevision = 0')
  const code = transformSync(bridge.slice(start, bridge.indexOf('  const requestedStatusRevision', start)), { loader: 'ts', format: 'cjs' }).code
  const document = fakeDocument()
  stampPublishedLink(document, { url: URL_RUN, qrSvg: '<svg/>' })
  let push, reply
  new Function('ipcRenderer', 'document', 'stampPublishedLink', code)({ on: (_name, listener) => { push = listener }, invoke: () => new Promise((resolve) => { reply = resolve }) }, document, stampPublishedLink)
  push({}, null)
  reply({ url: URL_RUN, qrSvg: '<svg>old</svg>' })
  await Promise.resolve()
  assert.equal(document.getElementById('twTalkQr').attrs['data-url'], '')
})

await test('an old asynchronous QR result cannot reach a replaced context, even with the same URL', async () => {
  const source = readSource('src/main/index.ts')
  const start = source.indexOf('async function announcePresenterLink(')
  const code = transformSync(source.slice(start, source.indexOf('let liveSessions:', start)), { loader: 'ts', format: 'cjs' }).code
  const contexts = new Map([[1, { shortUrl: URL_RUN }]])
  const sent = []
  let resolveQr
  const announce = (wcId, change, ...deps) => new Function('livePresenterContexts', 'presenterShareLink', 'presenterWindow', 'liveSessions', 'isTerminalLiveStatus', `${code}; return announcePresenterLink`)(...deps)(wcId, change)
  const pending = announce(1, { url: URL_RUN, first: true }, contexts, () => new Promise((resolve) => { resolveQr = resolve }), () => ({ webContents: { send: (...args) => sent.push(args) } }), null, () => true)
  contexts.set(1, { shortUrl: URL_RUN })
  resolveQr({ url: URL_RUN, qrSvg: '<svg/>' })
  await pending
  assert.deepEqual(sent, [], 'the same address does not make the replacement the old context')
  contexts.set(1, { shortUrl: null })
  await announce(1, { url: null, first: false }, contexts, async () => null, () => ({ webContents: { send: (...args) => sent.push(args) } }), null, () => true)
  assert.deepEqual(sent, [['present:share-link', null]], 'an authoritative clear is sent even though there is no QR')
})

await test('the wiring: results reach the service only after success, once, and Go live is not started from them', () => {
  const index = readSource('src/main/index.ts')
  const talk = index.slice(index.indexOf("ipcMain.handle('talk:publish-handout'"), index.indexOf('let localLiveWorker:'))
  assert.ok(talk.indexOf('presenterPublications.ticket()') < talk.indexOf('handoutPublishing().publish('), 'the ticket is taken when the publish is asked for')
  assert.ok(talk.indexOf('if (!outcome.ok)') < talk.indexOf('presenterPublications.published('), 'a failed or superseded publish returns before the service is told')
  assert.equal(talk.split('presenterPublications.published(').length, 2)
  const run = index.slice(index.indexOf("ipcMain.handle('run:publish-handout'"), index.indexOf("ipcMain.handle('run:unpublish-handout'"))
  assert.ok(run.lastIndexOf('if (!outcome.ok)') < run.indexOf('presenterPublications.published('))
  assert.equal(run.split('presenterPublications.published(').length, 2)
  const present = index.slice(index.indexOf("ipcMain.handle('talk:present'"), index.indexOf('// Recording lives in the presenter view only'))
  const accepted = present.indexOf('existing.loadFile(presentPath, reuseOpts)')
  assert.ok(present.indexOf('if (recordingArmed) {') < present.indexOf('livePresenterContexts.set(wcId, presenterContext())') && present.indexOf('presentWindows.set(wcId,') < accepted, 'a window is given another Run only when its page is really replaced')
  assert.ok(present.indexOf('outlineUrl: outlineUrlOnDisk(outlinePath),') > 0, 'publication identity uses the canonical reader that restricts no-frontmatter retention')
  assert.doesNotMatch(present, /readHandoutUrl\(content\)/, 'stale renderer text cannot restore a withdrawn publication')
  const unpublish = index.slice(index.indexOf("ipcMain.handle('run:unpublish-handout'"), index.indexOf('// Published pages ('))
  assert.ok(unpublish.indexOf('presenterPublications.ticket()') < unpublish.indexOf('handoutPublishing().publish('))
  assert.ok(unpublish.indexOf('if (!outcome.ok)') < unpublish.indexOf('presenterPublications.unpublishedRun('), 'only successful removals refresh the matching presenter')
  const service = readFileSync('src/main/presenter-publication.ts', 'utf8')
  assert.doesNotMatch(service, /live:go|ensureLiveJoinUrl|liveSessions|loadFile|reload/, 'it changes a link, nothing about the window or its session')
  const bridge = readFileSync('src/preload/present-live-bridge.ts', 'utf8')
  assert.equal(bridge.split("ipcRenderer.on('present:share-link'").length, 2, 'one listener')
  assert.ok(functionBody(bridge, 'mountLiveBridge').includes("ipcRenderer.on('present:share-link'"), 'registered where the deck has mounted, once per page')
  assert.doesNotMatch(functionBody(index, 'announcePresenterLink'), /live:go|executeJavaScript|loadFile/)
})

console.log(`presenter publication: ${passed} checks passed`)
