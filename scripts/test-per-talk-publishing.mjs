// Per-talk publishing: a deployment is the live manifest with one
// change merged in (src/main/handout-publishing.ts, src/main/pages-direct-upload.ts, src/main/site-record.ts). Everything runs
// against the stand-in API on this computer's loopback address (scripts/lib/cloudflare-api-stub.mjs) with a made-up token,
// through the REAL connection (its `authorisation.run`), the REAL production inventory reader and the REAL preservation guard.
// Nothing reaches Cloudflare and nothing is published.
//   0. the Pages hash is wrangler's: a vector the bundled wrangler 4.153 produced;
//   1. paths outside the talk's folder and the site-level files keep their exact live hash;
//   2. only the bytes check-missing named are uploaded, and the other talks' files on this computer are never read;
//   3. the production deployment is read again immediately before the deployment is created; on a change nothing is created;
//   4. the token is in no log line, error, Details text or address;
//   5. a computer with an empty site folder and the token alone publishes into a 600-file site;
//   and the site record: read and merged, made at bootstrap only by a computer whose registry covers the site.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCloudflareConnection } from '../src/main/cloudflare-connection.ts'
import { REGISTRY_ORIGIN_UNAVAILABLE, REGISTRY_ORIGIN_UNWRITABLE, SITE_BOOTSTRAP_CHANGED, SITE_BOOTSTRAP_REFUSED, createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { readRegistryStrict, registryOrigin, writeRegistry } from '../src/main/registry-origin.ts'
import { createHash } from 'node:crypto'
import { publicationBinding } from '../src/main/publication-preservation.ts'
import { RUN_FOLDER_UNPROVEN, legacyRunUnproven, runUnpublishJob } from '../src/main/run-unpublish.ts'
import { normaliseRun } from '../src/main/runs.ts'
import { PUBLISH_SUPERSEDED_ERROR } from '../src/main/cloudflare-connection.ts'
import { loadWranglerBlake3, loadWranglerMime, pagesAssetHash } from '../src/main/pages-direct-upload.ts'
import { readPublishingInventory } from '../src/main/publishing-inventory.ts'
import { buildRedirects, PUBLISH_REFUSED } from '../src/main/publishing-logic.ts'
import { SITE_RECORD_PATH, parseSiteRecord, serialiseSiteRecord } from '../src/main/site-record.ts'
import { preservationMessage } from '../src/main/publication-preservation.ts'
import { wranglerContentType, writePublicationRecord } from './lib/publishing-fakes.mjs'
import { startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { memorySecrets } from './lib/memory-secrets.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const blake3 = loadWranglerBlake3(repo)
const hashOf = (text, path) => pagesAssetHash(blake3, Buffer.from(text), path)
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const SITE = 'handouts'
// Made up, and built so that no source file holds the whole value.
const TOKEN = ['made', 'up', 'per', 'talk', 'token', ['0123', '4567', '89ab', 'cdef'].join('')].join('-')

// ── 0. The hash ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Produced on 5 Nov 2026 by the bundled wrangler 4.153.0 itself: `wrangler pages project upload <fixture>
// --output-manifest-path <file>` against the stand-in API (CF_PAGES_UPLOAD_JWT made up), over exactly these five files.
const WRANGLER_VECTOR = {
  '/empty.txt': 'f9bc91770fa5e997cbd47fba833629fc',
  '/noext': '00ec856cff94861465302992735300dc',
  '/talk-a/index.html': '9497a060b96c592d2b9111e0755a17ac',
  '/talk-a/assets/app.min.js': 'f9ad670347ab4f7d8c17966a6b9b5081',
  '/talk-a/assets/picture.png': 'e042f2561fed80f40edc2a5f259be402',
}
test('0. the Pages hash is the one the bundled wrangler gives', () => {
  const picture = Buffer.alloc(70000)
  for (let i = 0; i < picture.length; i++) picture[i] = (i * 31 + 7) & 255
  const fixture = {
    '/empty.txt': Buffer.from(''),
    '/noext': Buffer.from('plain bytes'),
    '/talk-a/index.html': Buffer.from('<!doctype html><title>Talk A</title><p>Hello, café ☕</p>\n'),
    '/talk-a/assets/app.min.js': Buffer.from('console.log(1)\n'),
    '/talk-a/assets/picture.png': picture,
  }
  for (const [path, bytes] of Object.entries(fixture)) assert.equal(pagesAssetHash(blake3, bytes, path), WRANGLER_VECTOR[path], path)
})

// ── Content types: wrangler's own (review round 1, finding 7) ──────────────────────────────────────────────────────────
test('7. content types are the ones the bundled wrangler gives', () => {
  for (const [path, type] of [['/a/b.html', 'text/html'], ['/a/sound.weba', 'audio/webm'], ['/a/anim.apng', 'image/apng'], ['/a/page.xhtml', 'application/xhtml+xml'],
    ['/a/b.png', 'image/png'], ['/a/b.mp4', 'video/mp4'], ['/a/b.woff2', 'font/woff2'], ['/a/b.unknownext', 'application/octet-stream'], ['/a/README', 'application/octet-stream']]) {
    assert.equal(wranglerContentType(path), type, path)
  }
  // And what is uploaded carries them.
  assert.equal(typeof loadWranglerMime(repo), 'function')
})

// ── The world: the stand-in API, the real connection, a publishing service ─────────────────────────────────────────────

/** A live site of `talks` (name → { file: text }), with a site record when `record` is given. */
function liveSite(talks, record) {
  const files = {}
  const assets = {}
  for (const [talk, contents] of Object.entries(talks)) {
    for (const [file, text] of Object.entries(contents)) {
      const path = `/${talk}/${file}`
      files[path] = hashOf(text, path)
      assets[files[path]] = Buffer.from(text)
    }
  }
  if (record) {
    const text = serialiseSiteRecord(record)
    files[SITE_RECORD_PATH] = hashOf(text, SITE_RECORD_PATH)
    assets[files[SITE_RECORD_PATH]] = Buffer.from(text)
  }
  return { files, assets }
}

async function world(t, { talks = {}, record, local = {}, stub = {}, commitMessage } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-per-talk-'))
  t.after(() => { try { chmodRecursive(root) } catch { /* gone */ } rmSync(root, { recursive: true, force: true }) })
  const seed = liveSite(talks, record)
  const api = await startCloudflareApiStub({
    accounts: [{ id: ACCOUNT, name: 'Ada' }], tokens: { [TOKEN]: { accounts: [ACCOUNT] } }, accountSites: { [ACCOUNT]: [SITE] },
    pagesDeployments: { [ACCOUNT]: { [SITE]: { files: seed.files, ...(commitMessage ? { commitMessage } : {}) } } }, pagesAssets: seed.assets, ...stub,
  })
  t.after(() => api.close())
  const secrets = memorySecrets()
  const config = { accountId: '', project: SITE, baseUrl: '', productionBranch: 'main' }
  const connection = createCloudflareConnection({
    secrets: secrets.store, settings: { read: () => ({ ...config }), write: (patch) => Object.assign(config, patch) },
    fetch: (input, init) => fetch(input, init), apiBase: () => api.baseUrl, timeoutMs: 5000, onChange: () => {},
  })
  await connection.saveToken(TOKEN)
  await connection.idle()
  const siteDir = join(root, 'site') // this computer's copy: empty unless a test fills it
  const state = { shortLinks: local.shortLinks ?? true, logs: [] }
  // This computer's registry on disk, read, written and recorded by the REAL functions of the app (registry-origin.ts).
  const registryFiles = { registry: join(root, 'handout-registry.json'), origin: join(local.originDir ?? root, 'handout-registry.origin.json') }
  if (local.registry !== null) writeRegistry(registryFiles.registry, { ...(local.registry ?? {}) })
  const ports = {
    siteDir: () => siteDir,
    preservationRoot: join(root, 'coordination'),
    stagingRoot: () => join(root, 'staging'),
    inventory: (authorisation) => readPublishingInventory(authorisation, api.baseUrl),
    authorise: () => connection.authorisePublish(),
    live: async () => ({ baseUrl: '' }),
    bundlingHazard: () => null,
    pages: () => ({ fetch: (input, init) => fetch(input, init), apiBase: api.baseUrl, allowLoopbackForTests: true, sleep: async () => {}, contentType: wranglerContentType }),
    blake3: () => blake3,
    registry: { read: () => readRegistryStrict(registryFiles.registry), write: (registry) => writeRegistry(registryFiles.registry, registry), origin: () => registryOrigin(registryFiles, local.originIo) },
    shortLinks: { read: () => state.shortLinks, write: (value) => { state.shortLinks = value } },
    computerName: () => 'Air',
    log: (line) => state.logs.push(line),
  }
  const service = createHandoutPublishing(ports)
  /** A talk publish as the handler makes it, in small: the short id against the registry, the folder, its pages, the 404 page. */
  const talkJob = (name, pages, extra = {}) => ({
    entry: 'talk',
    prepare: async ({ dir, link, redirects, makeFolder, writeSiteFile, claimFile }) => {
      link(`https://handouts.test/${name}/`)
      const registry = ports.registry.read()
      if (state.shortLinks && !registry[name]) registry[name] = `id${Object.keys(registry).length + 1}`
      const folders = [...new Set([...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'index.html'))).map((e) => e.name), name])]
      const text = state.shortLinks ? redirects(buildRedirects(registry, folders)) : null
      ports.registry.write(registry)
      const out = makeFolder(join(dir, name))
      for (const [file, content] of Object.entries(pages)) { mkdirSync(dirname(join(out, file)), { recursive: true }); writeFileSync(join(out, file), content) }
      claimFile(join(dir, '404.html'))
      writeFileSync(join(dir, '404.html'), 'Not here.')
      if (text !== null) writeSiteFile(join(dir, '_redirects'), text)
      await extra.during?.({ dir })
      return { ok: true, built: { name } }
    },
  })
  const production = () => api.production(ACCOUNT, SITE)
  const deploymentsPosted = () => api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deployments'))
  const journal = join(root, 'coordination', publicationBinding(`cf-pages:${ACCOUNT}:${SITE}`) + '.json')
  return { api, connection, ports, service, state, siteDir, root, talkJob, production, deploymentsPosted, registryFiles, journal }
}

function chmodRecursive(path) {
  try { chmodSync(path, 0o755) } catch { return }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodRecursive(join(path, entry.name))
    else try { chmodSync(join(path, entry.name), 0o644) } catch { /* fine */ }
  }
}

/** How the preservation guard's receipt names a site-level file it sent. */
const controlOf = (name, text) => publicationBinding([[name, createHash('sha256').update(text).digest('hex')]])

const recordOf = (deployment, assets) => {
  const hash = deployment.files[SITE_RECORD_PATH]
  const parsed = parseSiteRecord(assets.get(hash).bytes)
  assert.ok(parsed.ok, 'the new deployment carries a site record that reads')
  return parsed.record
}

/** A 600-file site: 60 talks of ten files each, all with short links, and its record. */
function bigSite() {
  const talks = {}
  const registry = {}
  for (let i = 0; i < 60; i++) {
    const name = `talk-${String(i).padStart(2, '0')}`
    talks[name] = { 'index.html': `<!doctype html><title>${name}</title>` }
    for (let j = 1; j < 10; j++) talks[name][`assets/file-${j}.txt`] = `${name} asset ${j}`
    registry[name] = `s${i}`
  }
  return { talks, record: { registry, shortLinks: true, headers: '/*\n  X-Frame-Options: DENY\n', publishedBy: 'Pro' } }
}

// ── 5. An empty site folder and the token alone, into a 600-file site ──────────────────────────────────────────────────
test('5. an empty site folder and the token alone publish one talk into a 600-file site', async (t) => {
  const { talks, record } = bigSite()
  const w = await world(t, { talks, record, local: { registry: {}, shortLinks: false } })
  const before = { ...w.production().files }
  assert.equal(Object.keys(before).length, 601, '600 files and the site record')
  assert.equal(existsSync(w.siteDir), false, 'nothing of the site on this computer')

  const result = await w.service.publish(w.talkJob('new-talk', { 'index.html': '<!doctype html><title>New</title>', 'assets/pic.png': 'png bytes' }))
  assert.equal(result.ok, true, JSON.stringify(result))
  const after = w.production()
  assert.notEqual(after.id, undefined)
  assert.equal(w.deploymentsPosted().length, 1)
  // 1. Every other path keeps its exact live hash.
  for (const [path, hash] of Object.entries(before)) if (path !== SITE_RECORD_PATH) assert.equal(after.files[path], hash, path)
  assert.equal(after.files['/new-talk/index.html'], hashOf('<!doctype html><title>New</title>', '/new-talk/index.html'))
  assert.equal(after.files['/404.html'], hashOf('Not here.', '/404.html'))
  assert.equal(Object.keys(after.files).length, 601 + 3)
  // The site record wins over this computer's: its link style (short links) and its registry, plus the new talk.
  const merged = recordOf(after, w.api.model.assets)
  assert.equal(merged.shortLinks, true, "the site's link style, not this computer's")
  assert.equal(w.state.shortLinks, true, "this computer's setting now caches the site's")
  assert.deepEqual(Object.keys(merged.registry).length, 61)
  assert.equal(merged.registry['talk-07'], 's7', 'existing short ids kept')
  assert.ok(merged.registry['new-talk'] && !Object.values(record.registry).includes(merged.registry['new-talk']), 'a new short id, allocated against the site record')
  assert.equal(merged.publishedBy, 'Air')
  // _redirects made from the record: every old short link and the new one; _headers is the record's.
  assert.equal(after.redirects, buildRedirects(merged.registry, [...Object.keys(talks), 'new-talk']))
  assert.match(after.redirects, /^\/s7  \/talk-07\/  302$/m)
  assert.equal(after.headers, record.headers)
  // The commit message carries the candidate digest, as before.
  assert.match(after.deployment_trigger.metadata.commit_message, /^tw-candidate:[0-9a-f]{64}$/)
  // Only the new files were uploaded (2. below checks the rule itself).
  const uploaded = w.api.model.uploads.flat()
  assert.equal(uploaded.length, 4, 'two pages, the 404 page and the record')
  // This computer's copy now holds what it published, and nothing else.
  assert.equal(readFileSync(join(w.siteDir, 'new-talk', 'index.html'), 'utf8'), '<!doctype html><title>New</title>')
  assert.deepEqual(readdirSync(w.siteDir).sort(), ['404.html', '_redirects', 'new-talk'])
  // Asked again with the same bytes: nothing changes, so nothing is deployed.
  const again = await w.service.publish(w.talkJob('new-talk', { 'index.html': '<!doctype html><title>New</title>', 'assets/pic.png': 'png bytes' }))
  assert.equal(again.ok, true)
  assert.equal(w.deploymentsPosted().length, 1, 'a republish of the same bytes sends no deployment')
})

// ── 1. Outside the talk, nothing changes ───────────────────────────────────────────────────────────────────────────────
test('1. a republish replaces only its own folder; a change outside it stops the publish before anything is sent', async (t) => {
  const record = { registry: { 'talk-a': 'aa', 'talk-b': 'bb' }, shortLinks: true, headers: '' }
  const w = await world(t, { talks: { 'talk-a': { 'index.html': 'A v1', 'old.css': 'old' }, 'talk-b': { 'index.html': 'B' } }, record })
  const before = { ...w.production().files }
  const result = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A v2' }))
  assert.equal(result.ok, true, JSON.stringify(result))
  const after = w.production().files
  assert.equal(after['/talk-b/index.html'], before['/talk-b/index.html'])
  assert.equal(after['/talk-a/index.html'], hashOf('A v2', '/talk-a/index.html'))
  assert.equal(after['/talk-a/old.css'], undefined, 'the talk\'s folder is replaced whole')

  // A job that writes into another talk's folder, or removes from it, is refused: nothing is uploaded or created.
  const posted = w.deploymentsPosted().length
  const uploads = w.api.model.uploads.length
  for (const during of [
    ({ dir }) => writeFileSync(join(dir, 'talk-b', 'index.html'), 'tampered'),
    ({ dir }) => rmSync(join(dir, 'talk-b'), { recursive: true }),
  ]) {
    const refused = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A v3' }, { during }))
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'PUBLISH_UNRELATED_REMOVAL')
    assert.match(refused.details, /\/talk-b\/index\.html/)
  }
  assert.equal(w.deploymentsPosted().length, posted, 'no deployment created')
  assert.equal(w.api.model.uploads.length, uploads, 'no bytes uploaded')

  // Unpublish: the same flow with nothing staged; the prefix goes, its short link line with it.
  const unpublished = await w.service.publish({
    entry: 'talk-unpublish', removalRoots: () => ['/talk-a'],
    prepare: async ({ dir }) => { rmSync(join(dir, 'talk-a'), { recursive: true }); return { ok: true, built: null } },
  })
  assert.equal(unpublished.ok, true, JSON.stringify(unpublished))
  const final = w.production()
  assert.deepEqual(Object.keys(final.files).filter((p) => p.startsWith('/talk-a/')), [])
  assert.equal(final.files['/talk-b/index.html'], before['/talk-b/index.html'])
  assert.doesNotMatch(final.redirects, /talk-a/)
  assert.match(final.redirects, /\/bb  \/talk-b\/  302/)
})

// ── 2. Only missing bytes, and never another talk's file ───────────────────────────────────────────────────────────────
test('2. only what check-missing names is uploaded, and the other talks on this computer are never read', async (t) => {
  const record = { registry: {}, shortLinks: false, headers: '' }
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B', 'shared.png': 'same bytes' } }, record, local: { shortLinks: false } })
  // This computer's copy holds other talks, unreadable: any read of them would fail the publish.
  for (const other of ['talk-b', 'talk-c']) {
    mkdirSync(join(w.siteDir, other), { recursive: true })
    writeFileSync(join(w.siteDir, other, 'index.html'), 'secret')
    chmodSync(join(w.siteDir, other, 'index.html'), 0o000)
    chmodSync(join(w.siteDir, other), 0o000)
  }
  const result = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A', 'shared.png': 'same bytes', 'clip.weba': 'webm bytes' }))
  assert.equal(result.ok, true, JSON.stringify(result))
  // Uploaded with wrangler's own content types (review round 1, finding 7: a small table gave .weba octet-stream).
  assert.equal(w.api.model.assets.get(hashOf('webm bytes', '/talk-a/clip.weba')).contentType, 'audio/webm')
  assert.equal(w.api.model.assets.get(hashOf('A', '/talk-a/index.html')).contentType, 'text/html')
  const asked = w.api.requests.filter((r) => r.path === '/pages/assets/check-missing').flatMap((r) => JSON.parse(r.body.toString()).hashes)
  // The stand-in names as missing every hash it does not hold; it holds talk-b's picture, whose bytes (and so hash) are the same.
  const held = hashOf('same bytes', '/talk-b/shared.png')
  assert.ok(asked.includes(held), 'the shared picture was asked about')
  const uploaded = w.api.model.uploads.flat()
  assert.deepEqual(new Set(uploaded), new Set(asked.filter((hash) => hash !== held)), 'exactly the hashes check-missing named were uploaded')
  assert.ok(!uploaded.includes(held), 'bytes Cloudflare already holds are not sent again')
  assert.equal(new Set(asked).size, asked.length, 'each hash asked once')
  assert.ok(asked.length <= 5, 'only the change is asked about: its pages, the 404 page, the record')
  // Uploads carry the upload token, never the person's token.
  for (const request of w.api.requests.filter((r) => r.path.startsWith('/pages/assets/'))) assert.ok(!request.authorization.includes(TOKEN))
  chmodRecursive(w.siteDir)
})

// ── 3. The revision, read again immediately before the deployment is created ───────────────────────────────────────────
test('3. a production deployment made during the upload stops the publish, and nothing is created', async (t) => {
  const record = { registry: {}, shortLinks: false, headers: '' }
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record, local: { shortLinks: false } })
  // Another computer deploys while this one uploads.
  w.api.model.answer = (request) => {
    if (request.path === '/pages/assets/upsert-hashes') {
      w.api.model.answer = null
      const other = w.production()
      w.api.handle({ method: 'POST', path: `/accounts/${ACCOUNT}/pages/projects/${SITE}/deployments`, search: '', headers: {}, authorization: `Bearer ${TOKEN}`, contentType: 'multipart/form-data', body: Buffer.alloc(0),
        parts: [{ name: 'manifest', bytes: Buffer.from(JSON.stringify(other.files)) }, { name: 'branch', bytes: Buffer.from('main') }] })
    }
    return null
  }
  const before = w.production().id
  const posted = () => w.api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deployments') && !(r.parts ?? []).some((p) => p.name === 'commit_message'))
  const result = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'PUBLISH_REVISION_CHANGED')
  assert.match(preservationMessage(result.error), /publish again/)
  const ours = w.api.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deployments') && (r.parts ?? []).some((p) => p.name === 'commit_message'))
  assert.equal(ours.length, 0, 'this publish created no deployment')
  assert.equal(posted().length, 1, 'only the other computer\'s')
  assert.notEqual(w.production().id, before)

  // On success, the last request before the deployment is the read of the production deployment.
  const ok = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  assert.equal(ok.ok, true, JSON.stringify(ok))
  const reached = w.api.reached()
  const create = reached.lastIndexOf(`POST /accounts/${ACCOUNT}/pages/projects/${SITE}/deployments`)
  assert.equal(reached[create - 1], `GET /accounts/${ACCOUNT}/pages/projects/${SITE}`)
  assert.equal(reached[create - 2], 'POST /pages/assets/upsert-hashes')
})

// ── 4. No token anywhere ───────────────────────────────────────────────────────────────────────────────────────────────
test('4. the token is in no log, error, Details text or address', async (t) => {
  const record = { registry: { 'talk-b': 'bb' }, shortLinks: true, headers: '' }
  const seen = []
  const scenarios = [
    ['upload token refused', (request) => request.path.endsWith('/upload-token') ? { status: 403, body: { success: false, errors: [{ code: 10000, message: `Authentication error ${TOKEN}` }], result: null } } : null],
    ['token unknown at check-missing', (request) => request.path === '/pages/assets/check-missing' ? { status: 401, body: { success: false, errors: [{ code: 10001, message: `bad ${TOKEN}` }], result: null } } : null],
    ['deployment answered with garbage', (request) => request.method === 'POST' && request.path.endsWith('/deployments') ? { status: 500, body: `<html>${TOKEN}</html>` } : null],
    ['deployment refused', (request) => request.method === 'POST' && request.path.endsWith('/deployments') ? { status: 400, body: { success: false, errors: [{ code: 8000096, message: `no ${TOKEN}` }], result: null } } : null],
  ]
  for (const [name, answer] of scenarios) {
    const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record })
    w.api.model.answer = answer
    const result = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
    assert.equal(result.ok, false, name)
    seen.push(name, JSON.stringify(result), ...w.state.logs, ...w.api.requests.map((r) => `${r.path}${r.search ?? ''}`))
    // The site record is read with no credentials at all.
    for (const request of w.api.requests.filter((r) => r.path.startsWith('/__pages-assets/'))) assert.equal(request.authorization, '', name)
    if (name === 'upload token refused') assert.equal(result.error, PUBLISH_REFUSED, 'a refusal for permission is sorted, as before')
    if (name === 'deployment answered with garbage') assert.equal(result.error, 'PUBLISH_OUTCOME_UNKNOWN', 'a deployment that may exist is an unknown outcome')
    if (name === 'deployment refused') assert.match(result.details ?? '', /HTTP 400 \(codes 8000096\)/)
    // Staging folders are gone whatever happened.
    assert.deepEqual(existsSync(join(w.root, 'staging')) ? readdirSync(join(w.root, 'staging')) : [], [], name)
  }
  for (const text of seen) assert.ok(!String(text).includes(TOKEN), `no token in: ${String(text).slice(0, 120)}`)
})

// ── The site record: bootstrap ─────────────────────────────────────────────────────────────────────────────────────────
// A live site with no record gets its first one only from the computer that published what is live now: its own publication
// record (the preservation guard's `<binding>.controls.json`) is for the live production deployment. Whether every live folder
// has a short link does not matter (a talk can be live with none).
test('bootstrap: only the computer that published what is live makes the first record', async (t) => {
  const talks = { 'talk-a': { 'index.html': 'A' }, 'talk-b': { 'index.html': 'B' }, 'no-short-link': { 'index.html': 'live with no short link' } }
  const site = `cf-pages:${ACCOUNT}:${SITE}`
  const local = { registry: { 'talk-a': 'aa', 'talk-b': 'bb' }, shortLinks: true }
  const digest = 'd'.repeat(64)
  // What this computer's receipt says went live: the redirect file made from its registry (and no headers).
  const wentLive = { controls: { '/_redirects': controlOf('/_redirects', buildRedirects(local.registry, Object.keys(talks))) } }
  const other = { controls: { '/_redirects': controlOf('/_redirects', buildRedirects({ 'talk-a': 'zz' }, Object.keys(talks))) } }
  const receipt = (w, revision, extra = {}) => writePublicationRecord(join(w.root, 'coordination'), site, revision, { ...wentLive, ...extra })
  for (const [label, options, mark, allowed] of [
    ['no publication record on this computer', {}, () => {}, SITE_BOOTSTRAP_REFUSED],
    ['a record that was never published', {}, (w) => receipt(w, w.production().id, { published: false }), SITE_BOOTSTRAP_REFUSED],
    ['a record for another deployment', {}, (w) => receipt(w, '00000000-0000-4000-8000-000000000000'), SITE_BOOTSTRAP_REFUSED],
    ['a record for another site', {}, (w) => receipt(w, w.production().id, { site: 'cf-pages:other:site' }), SITE_BOOTSTRAP_REFUSED],
    // Review round 1, finding 2: the receipt must also name what this computer would send now.
    ['a receipt whose redirect file was made from another registry', {}, (w) => receipt(w, w.production().id, other), SITE_BOOTSTRAP_CHANGED],
    ['a receipt that went live with headers this computer no longer has', {}, (w) => receipt(w, w.production().id, { controls: { ...wentLive.controls, '/_headers': controlOf('/_headers', '/*\n  X-Frame-Options: DENY\n') } }), SITE_BOOTSTRAP_CHANGED],
    ['a registry that is missing here', { local: { ...local, registry: null } }, (w) => receipt(w, w.production().id), SITE_BOOTSTRAP_CHANGED],
    ['a record for the live deployment', {}, (w) => receipt(w, w.production().id), true],
    ['a record whose candidate the live deployment carries', { commitMessage: `tw-candidate:${digest}` }, (w) => receipt(w, 'the-deployment-before', { candidateDigest: digest }), true],
  ]) {
    const w = await world(t, { talks, local, ...options })
    mark(w)
    const result = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
    if (allowed !== true) {
      assert.deepEqual([result.ok, result.error, w.deploymentsPosted().length], [false, allowed, 0], `${label}: refused, nothing sent`)
      assert.match(SITE_BOOTSTRAP_REFUSED, /Publish once from the computer that published last/)
      continue
    }
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`)
    const made = recordOf(w.production(), w.api.model.assets)
    assert.deepEqual([made.registry['talk-a'], made.registry['talk-b'], Boolean(made.registry['talk-c']), made.registry['no-short-link']], ['aa', 'bb', true, undefined], `${label}: the first record is this computer's registry and the new talk`)
    assert.match(w.production().redirects, /\/aa  \/talk-a\/  302/)
    assert.equal(w.production().files['/no-short-link/index.html'], hashOf('live with no short link', '/no-short-link/index.html'), 'the talk with no short link is kept as it is')
  }
  // A site with nothing deployed yet has nothing to lose: any computer makes its first record.
  const empty = await world(t, { local })
  assert.equal((await empty.service.publish(empty.talkJob('talk-a', { 'index.html': 'A' }))).ok, true)

  // The next computer, with nothing of its own, follows the record.
  const record = { registry: { 'talk-a': 'aa', 'talk-b': 'bb', 'talk-c': 'cc' }, shortLinks: true, headers: '', publishedBy: 'Pro' }
  const blank = await world(t, { talks: { ...talks, 'talk-c': { 'index.html': 'C' } }, record, local: { registry: { 'talk-a': 'zz' }, shortLinks: false } })
  const next = await blank.service.publish(blank.talkJob('talk-d', { 'index.html': 'D' }))
  assert.equal(next.ok, true, JSON.stringify(next))
  const followed = recordOf(blank.production(), blank.api.model.assets)
  assert.equal(followed.registry['talk-a'], 'aa', 'the site record wins over this computer\'s registry')
  assert.ok(blank.state.logs.some((line) => line.includes('talk-a') && line.includes('zz')), 'the clash is logged')
})

// ── Review round 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────
const record0 = { registry: {}, shortLinks: false, headers: '' }
const isPost = (r) => r.method === 'POST' && /\/deployments$/.test(r.path)

test('1. a deployment request that fails is never repeated: another computer\'s deployment made meanwhile survives', async (t) => {
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  let otherId = null
  // Cloudflare answers the request with its "unknown error"; meanwhile another computer deploys.
  w.api.model.answer = (request) => {
    if (!isPost(request)) return null
    w.api.model.answer = null
    otherId = w.api.seed(ACCOUNT, SITE, { files: { ...w.production().files, '/other/index.html': hashOf('other', '/other/index.html') } }).id
    return { status: 400, body: { success: false, errors: [{ code: 8000000, message: 'unknown' }], messages: [], result: null } }
  }
  const result = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'PUBLISH_OUTCOME_UNKNOWN', 'it may have made a deployment: unknown, never repeated')
  assert.equal(w.api.requests.filter(isPost).length, 1, 'one deployment request')
  assert.equal(w.production().id, otherId, 'the other computer\'s deployment is still production')
  // Straight away, an unanswered request is not proof of anything: the next publish is refused before it sends anything.
  const early = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  assert.deepEqual([early.error, w.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', 1])
  // However long it waits, nothing proves the request made nothing: the manual recovery clears the journal, and the next publish
  // sends against the site as it now is.
  rmSync(w.journal)
  const again = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.ok(w.production().files['/other/index.html'], 'and keeps the other computer\'s page')
})

test('2. bootstrap refuses when this computer\'s registry is missing, even with a matching receipt', async (t) => {
  const site = `cf-pages:${ACCOUNT}:${SITE}`
  const w = await world(t, { talks: { 'talk-a': { 'index.html': 'A' } }, local: { registry: null, shortLinks: true } })
  writePublicationRecord(join(w.root, 'coordination'), site, w.production().id)
  const result = await w.service.publish(w.talkJob('talk-b', { 'index.html': 'B' }))
  assert.deepEqual([result.ok, result.error, w.deploymentsPosted().length], [false, SITE_BOOTSTRAP_CHANGED, 0])
})

test('3. a Run from before folders were recorded is never bound by the site\'s record alone', async (t) => {
  // The site's record says /abcd is unrelated-talk's; the Run's link is /abcd and it recorded no folder.
  const record = { registry: { 'unrelated-talk': 'abcd' }, shortLinks: true, headers: '' }
  const run = normaliseRun({ id: 'run-l', talkSlug: 'talk', talkTitle: 'Talk', kind: 'delivery', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00',
    slideSet: { kind: 'full' }, startedAt: '2026-10-01T00:00:00.000Z', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null,
    audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], handoutUrl: 'https://handouts.test/abcd' })
  assert.equal(legacyRunUnproven(run, record.registry, null), true)
  assert.equal(legacyRunUnproven(run, record.registry, { 'unrelated-talk': 'zzzz' }), true)
  assert.equal(legacyRunUnproven(run, record.registry, { 'unrelated-talk': 'abcd' }), false, 'this computer gave that folder that id itself')
  assert.equal(legacyRunUnproven({ ...run, handoutFolder: 'run-folder' }, record.registry, null), false, 'a recorded folder is the Run\'s own fact')
  // Through the REAL origin record (registry-origin.ts), across two attempts with the site's record synced in between.
  for (const [label, own, expected] of [['no registry of its own', null, RUN_FOLDER_UNPROVEN], ['its own registry gives the folder another id', { 'unrelated-talk': 'zzzz' }, RUN_FOLDER_UNPROVEN], ['its own registry agrees', { 'unrelated-talk': 'abcd' }, true]]) {
    const w = await world(t, { talks: { 'unrelated-talk': { 'index.html': 'not this Run\'s' } }, record, local: { registry: own } })
    const before = w.production().files['/unrelated-talk/index.html']
    let current = run
    const unpublish = () => w.service.publish({ entry: 'run-unpublish', ...runUnpublishJob({
      run: () => current, siteExists: () => true, readRegistry: () => w.ports.registry.read() ?? {}, writeRegistry: (next) => w.ports.registry.write(next),
      notAvailablePage: async () => 'n/a', service: { withdraw: async () => ({ ok: true, withdrawn: true }), phasesSent: () => [], ownerRecord: () => 'usable' }, persist: (next) => { current = next },
    }) })
    const first = await unpublish()
    if (expected === true) { assert.equal(first.ok, true, `${label}: ${JSON.stringify(first)}`); continue }
    assert.deepEqual([first.ok, first.error, w.deploymentsPosted().length, w.production().files['/unrelated-talk/index.html']], [false, expected, 0, before], `${label}: refused, nothing removed or sent`)
    // The first attempt made this computer's registry the site's (it now maps unrelated-talk to abcd): that downloaded copy
    // never becomes this computer's own. The second attempt is refused the same way (review round 2, finding A).
    assert.deepEqual(readRegistryStrict(w.registryFiles.registry), record.registry, 'the site\'s record was followed')
    const second = await unpublish()
    assert.deepEqual([second.ok, second.error, w.deploymentsPosted().length, w.production().files['/unrelated-talk/index.html']], [false, expected, 0, before], `${label}: refused again after the sync`)
    assert.deepEqual(JSON.parse(readFileSync(w.registryFiles.origin, 'utf8')), own === null ? { version: 1, state: 'none' } : { version: 1, state: 'registry', registry: own }, `${label}: the record of its own short links is unchanged`)
  }
})

test('A. the record of this computer\'s own short links is kept once, before the first sync, and never from downloaded data', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tw-origin-'))
  t.after(() => { try { chmodSync(root, 0o755) } catch { /* gone */ } rmSync(root, { recursive: true, force: true }) })
  const files = { registry: join(root, 'handout-registry.json'), origin: join(root, 'handout-registry.origin.json') }
  // No registry here: an explicit "none", recorded at once.
  assert.deepEqual(registryOrigin(files), { state: 'none' })
  assert.deepEqual(JSON.parse(readFileSync(files.origin, 'utf8')), { version: 1, state: 'none' })
  // A sync writes the site's registry here; the next attempt still reads "none".
  writeRegistry(files.registry, { 'unrelated-talk': 'abcd' })
  assert.deepEqual(registryOrigin(files), { state: 'none' }, 'the downloaded registry is never recorded as this computer\'s own')
  // A record that does not read is not trusted, and not replaced.
  writeFileSync(files.origin, 'not json')
  assert.throws(() => registryOrigin(files), { name: 'Error' })
  assert.equal(readFileSync(files.origin, 'utf8'), 'not json')
  // A record that cannot be written: nothing is trusted, and the publish stops before following the site's record.
  const locked = mkdtempSync(join(tmpdir(), 'tw-origin-locked-'))
  t.after(() => { chmodSync(locked, 0o755); rmSync(locked, { recursive: true, force: true }) })
  writeRegistry(join(locked, 'handout-registry.json'), { 'talk-a': 'aa' })
  chmodSync(locked, 0o555)
  assert.throws(() => registryOrigin({ registry: join(locked, 'handout-registry.json'), origin: join(locked, 'handout-registry.origin.json') }))
  chmodSync(locked, 0o755)
  // A damaged record: an ordinary publish goes on and follows the site's record; nothing is recorded; only the old-style Run is refused.
  const damaged = await world(t, { talks: { 'talk-b': { 'index.html': 'B' }, 'unrelated-talk': { 'index.html': 'not this Run\'s' } }, record: { registry: { 'talk-b': 'bb', 'unrelated-talk': 'abcd' }, shortLinks: true, headers: '' }, local: { registry: { 'talk-a': 'aa' } } })
  writeFileSync(damaged.registryFiles.origin, '{"version":1,"state":"regis') // cut short
  const ordinary = await damaged.service.publish(damaged.talkJob('talk-c', { 'index.html': 'C' }))
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary))
  assert.equal(readRegistryStrict(damaged.registryFiles.registry)['talk-b'], 'bb', 'the site\'s record was followed')
  assert.equal(readFileSync(damaged.registryFiles.origin, 'utf8'), '{"version":1,"state":"regis', 'and the damaged record is left as it is: none is made after the sync')
  let current = normaliseRun({ id: 'run-l', talkSlug: 'talk', talkTitle: 'Talk', kind: 'delivery', status: 'planned', plannedDate: '2026-10-21', startTime: '14:00',
    slideSet: { kind: 'full' }, startedAt: '2026-10-01T00:00:00.000Z', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null,
    audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], handoutUrl: 'https://handouts.test/abcd' })
  const legacyRun = await damaged.service.publish({ entry: 'run-unpublish', ...runUnpublishJob({
    run: () => current, siteExists: () => true, readRegistry: () => damaged.ports.registry.read() ?? {}, writeRegistry: (next) => damaged.ports.registry.write(next),
    notAvailablePage: async () => 'n/a', service: { withdraw: async () => ({ ok: true, withdrawn: true }), phasesSent: () => [], ownerRecord: () => 'usable' }, persist: (next) => { current = next },
  }) })
  assert.deepEqual([legacyRun.ok, legacyRun.error], [false, REGISTRY_ORIGIN_UNAVAILABLE], 'the one old-style Run cannot be changed from this Mac')
  assert.match(REGISTRY_ORIGIN_UNAVAILABLE, /from the Mac that originally published it/)
  // No record, and none can be made: the site's record is not followed (a later write would record the downloaded copy).
  const lockedDir = mkdtempSync(join(tmpdir(), 'tw-origin-dir-'))
  t.after(() => { chmodSync(lockedDir, 0o755); rmSync(lockedDir, { recursive: true, force: true }) })
  chmodSync(lockedDir, 0o555)
  const unwritable = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: { registry: { 'talk-b': 'bb' }, shortLinks: true, headers: '' }, local: { registry: { 'talk-a': 'aa' }, originDir: lockedDir } })
  const refused = await unwritable.service.publish(unwritable.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([refused.ok, refused.error, unwritable.deploymentsPosted().length], [false, REGISTRY_ORIGIN_UNWRITABLE, 0])
  assert.deepEqual(readRegistryStrict(unwritable.registryFiles.registry), { 'talk-a': 'aa' }, 'the site\'s record was not followed')
})

test('4. a connection that changes while the bytes go up makes no deployment', async (t) => {
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  w.api.model.delay = (request) => (request.path === '/pages/assets/upsert-hashes' ? w.connection.disconnect().then(() => {}) : null)
  const result = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  w.api.model.delay = null
  assert.deepEqual([result.ok, result.error, result.superseded], [false, PUBLISH_SUPERSEDED_ERROR, true])
  assert.equal(w.api.requests.filter(isPost).length, 0, 'no deployment request')
})

test('5. a deployment still in progress is reconciled before anything else is sent', async (t) => {
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  w.api.model.pendingDeployments = true
  const first = await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))
  assert.equal(first.error, 'PUBLISH_OUTCOME_UNKNOWN', 'not confirmed while Cloudflare is still deploying it')
  const pendingId = [...w.api.model.sites.get(ACCOUNT).get(SITE).deployments.values()].at(-1).id
  assert.notEqual(w.production().id, pendingId, 'Cloudflare is still deploying it')
  // Still in progress: the next publish is refused before it sends anything, though production has not moved.
  const blocked = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([blocked.error, w.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', 1])
  // It finishes: the next publish recognises it and goes on from the site as it now is.
  w.api.model.pendingDeployments = false
  w.api.settle(ACCOUNT, SITE, pendingId)
  const next = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
  assert.equal(next.ok, true, JSON.stringify(next))
  assert.ok(w.production().files['/talk-a/index.html'] && w.production().files['/talk-c/index.html'], 'both changes are live')
})

test('5b. a deployment whose answer was lost is found by its candidate digest', async (t) => {
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  w.api.model.pendingDeployments = true
  // Cloudflare makes the deployment (still in progress) and its answer never arrives.
  w.api.model.answer = (request) => { if (!isPost(request)) return null; w.api.model.answer = null; w.api.handle(request); return { status: 502, body: '<html>bad gateway</html>' } }
  assert.equal((await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))).error, 'PUBLISH_OUTCOME_UNKNOWN')
  const posted = w.api.requests.filter(isPost).length
  const blocked = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([blocked.error, w.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', posted], 'found by its digest, still in progress: refused')
  const made = [...w.api.model.sites.get(ACCOUNT).get(SITE).deployments.values()].at(-1)
  w.api.model.pendingDeployments = false
  w.api.settle(ACCOUNT, SITE, made.id)
  assert.equal((await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))).ok, true)
})

test('6. upload tokens that are refused again and again end the publish', async (t) => {
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  w.api.model.answer = (request) => (request.path === '/pages/assets/upload' ? { status: 401, body: { success: false, errors: [{ code: 8000013, message: 'expired' }], messages: [], result: null } } : null)
  const result = await within(w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' })), 10_000)
  assert.equal(result.ok, false)
  assert.equal(w.api.requests.filter(isPost).length, 0)
  const tokens = w.api.requests.filter((r) => r.path.endsWith('/upload-token')).length
  assert.ok(tokens <= 4, `at most three new upload tokens after the first (${tokens})`)
})
const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`not finished within ${ms} ms`)), ms))])

test('B1. a lost answer\'s deployment on the second page of the list is found, and blocks the next publish', async (t) => {
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  w.api.model.pendingDeployments = true
  w.api.model.deploymentsPerPage = 2
  w.api.model.answer = (request) => { if (!isPost(request)) return null; w.api.model.answer = null; w.api.handle(request); return { status: 502, body: 'lost' } }
  assert.equal((await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))).error, 'PUBLISH_OUTCOME_UNKNOWN')
  w.api.model.pendingDeployments = false
  // Three newer preview deployments push it onto the second page.
  for (let i = 0; i < 3; i++) w.api.seed(ACCOUNT, SITE, { files: {}, branch: `preview-${i}` })
  const posted = w.api.requests.filter(isPost).length
  const blocked = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([blocked.error, w.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', posted], 'found on page 2, still in progress: refused')
  assert.ok(w.api.requests.some((r) => r.path.endsWith('/deployments') && /page=2/.test(r.search ?? '')), 'the second page was read')
})

test('B2. a request that was sent is never taken as having made nothing, however long ago; only a never-sent one settles', async (t) => {
  const dayAgo = (w) => { const kept = JSON.parse(readFileSync(w.journal, 'utf8')); writeFileSync(w.journal, JSON.stringify({ ...kept, postedAt: Date.now() - 86_400_000 })) }
  // It exists, still in progress, and the list does not show it yet.
  const w = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  w.api.model.pendingDeployments = true
  w.api.model.answer = (request) => { if (!isPost(request)) return null; w.api.model.answer = null; const reply = w.api.handle(request); w.api.model.hiddenFromList.add(reply.body.result.id); return { status: 502, body: 'lost' } }
  assert.equal((await w.service.publish(w.talkJob('talk-a', { 'index.html': 'A' }))).error, 'PUBLISH_OUTCOME_UNKNOWN')
  const posted = w.api.requests.filter(isPost).length
  assert.equal(typeof JSON.parse(readFileSync(w.journal, 'utf8')).postedAt, 'number', 'the send was journalled')
  const blocked = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([blocked.error, w.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', posted], 'not in the list yet: refused, nothing sent')
  dayAgo(w)
  const later = await w.service.publish(w.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([later.error, w.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', posted], 'sent a day ago and still not seen: still refused')
  assert.match(preservationMessage('PUBLISH_OUTCOME_UNKNOWN'), /still unknown[\s\S]*take a while[\s\S]*Try again later[\s\S]*Recovering a stuck publish/)

  // A journal from before sends were recorded (no postedAt, no sendsRecorded): counted as sent, refused.
  const v = await world(t, { talks: { 'talk-b': { 'index.html': 'B' } }, record: record0, local: { shortLinks: false } })
  v.api.model.answer = (request) => (isPost(request) ? { status: 502, body: 'lost' } : null)
  assert.equal((await v.service.publish(v.talkJob('talk-a', { 'index.html': 'A' }))).error, 'PUBLISH_OUTCOME_UNKNOWN')
  v.api.model.answer = null
  const { postedAt: _p, sendsRecorded: _s, ...legacy } = JSON.parse(readFileSync(v.journal, 'utf8'))
  writeFileSync(v.journal, JSON.stringify(legacy))
  const sentBefore = v.api.requests.filter(isPost).length
  assert.deepEqual([(await v.service.publish(v.talkJob('talk-a', { 'index.html': 'A' }))).error, v.api.requests.filter(isPost).length], ['PUBLISH_OUTCOME_UNKNOWN', sentBefore], 'a legacy journal is refused')
  // A journal that records sends and records none (its attempt stopped before the request): nothing was made, it settles.
  writeFileSync(v.journal, JSON.stringify({ ...legacy, sendsRecorded: true }))
  const settled = await v.service.publish(v.talkJob('talk-a', { 'index.html': 'A' }))
  assert.equal(settled.ok, true, JSON.stringify(settled))
  assert.equal(v.api.requests.filter(isPost).length, sentBefore + 1)
})

test('A2. the record is flushed: a real failure while making it stops the publish before the sync; an unsupported folder flush does not', async (t) => {
  const failing = (what, code) => ({ fsync: (fd, kind) => { if (kind === what) throw Object.assign(new Error(`${code} on ${kind}`), { code }); fsyncSync(fd) } })
  const site = { talks: { 'talk-b': { 'index.html': 'B' } }, record: { registry: { 'talk-b': 'bb' }, shortLinks: true, headers: '' } }
  // A real failure flushing the folder: stopped before the site's record is followed.
  const eio = await world(t, { ...site, local: { registry: { 'talk-a': 'aa' }, originIo: failing('folder', 'EIO') } })
  const stopped = await eio.service.publish(eio.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([stopped.ok, stopped.error, eio.deploymentsPosted().length], [false, REGISTRY_ORIGIN_UNWRITABLE, 0])
  assert.deepEqual(readRegistryStrict(eio.registryFiles.registry), { 'talk-a': 'aa' }, 'not synced')
  // A retry: the record is there now, and is flushed again before any sync. While the folder flush keeps failing, it stops;
  // once the flush works, it goes on.
  const again = await eio.service.publish(eio.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([again.ok, again.error, eio.deploymentsPosted().length], [false, REGISTRY_ORIGIN_UNWRITABLE, 0], 'retry: still stopped')
  assert.deepEqual(readRegistryStrict(eio.registryFiles.registry), { 'talk-a': 'aa' }, 'retry: not synced')
  eio.ports.registry.origin = () => registryOrigin(eio.registryFiles)
  const healed = await eio.service.publish(eio.talkJob('talk-c', { 'index.html': 'C' }))
  assert.equal(healed.ok, true, JSON.stringify(healed))
  assert.deepEqual(JSON.parse(readFileSync(eio.registryFiles.origin, 'utf8')), { version: 1, state: 'registry', registry: { 'talk-a': 'aa' } }, 'the record made before any sync stands')
  // A platform that cannot flush a folder at all: not a failure.
  const unsupported = await world(t, { ...site, local: { registry: { 'talk-a': 'aa' }, originIo: failing('folder', 'EINVAL') } })
  const went = await unsupported.service.publish(unsupported.talkJob('talk-c', { 'index.html': 'C' }))
  assert.equal(went.ok, true, JSON.stringify(went))
  assert.deepEqual(JSON.parse(readFileSync(unsupported.registryFiles.origin, 'utf8')), { version: 1, state: 'registry', registry: { 'talk-a': 'aa' } })
  // The file's own flush fails while it is made: stopped before the sync; the file stays, and a later read finds it damaged.
  const fileFails = await world(t, { ...site, local: { registry: { 'talk-a': 'aa' }, originIo: failing('file', 'EIO') } })
  const halted = await fileFails.service.publish(fileFails.talkJob('talk-c', { 'index.html': 'C' }))
  assert.deepEqual([halted.ok, halted.error, fileFails.deploymentsPosted().length], [false, REGISTRY_ORIGIN_UNWRITABLE, 0])
  assert.deepEqual(readRegistryStrict(fileFails.registryFiles.registry), { 'talk-a': 'aa' }, 'not synced')
  assert.ok(existsSync(fileFails.registryFiles.origin), 'the file stays')
  assert.throws(() => registryOrigin(fileFails.registryFiles), (error) => error.kind === 'unreadable', 'a later read finds it damaged')
})
