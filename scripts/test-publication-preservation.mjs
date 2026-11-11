import { publicationOutcome } from '../src/main/publication-preservation.ts'
import { readPublishingInventory } from '../src/main/publishing-inventory.ts'
import ts from 'typescript'
import { LiveServiceError } from '../src/main/live-service-deploy.ts'
import policyPromises from 'node:fs/promises'
import policyFs, { symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { beginPublication, publicationBinding, publicationTree, preservationMessage } from '../src/main/publication-preservation.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync, chmodSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { createFakeCloudflare, fakeCloudflareFetch, pagesFileHash, startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { loadWranglerBlake3, pagesAssetHash } from '../src/main/pages-direct-upload.ts'
import { NO_PRODUCTION_REVISION } from '../src/main/publishing-inventory.ts'
import { wranglerContentType, writePublicationRecord } from './lib/publishing-fakes.mjs'

// Per-talk publishing: the service merges one change into the live
// manifest and sends it with Cloudflare's API. These fixtures give it the fake Cloudflare model in memory
// (scripts/lib/cloudflare-api-stub.mjs); nothing leaves this computer.
const blake3 = loadWranglerBlake3(join(import.meta.dirname, '..'))
const pagesHash = (text, path) => pagesAssetHash(blake3, Buffer.from(text), path)
/** A live site: path → text, as the files Cloudflare keeps and the bytes it holds for them. */
const liveOf = (pages) => ({ files: Object.fromEntries(Object.entries(pages).map(([path, text]) => [path, pagesHash(text, path)])), bytes: Object.fromEntries(Object.entries(pages).map(([path, text]) => [pagesHash(text, path), text])) })
const isDeployment = (request) => request.method === 'POST' && request.path.endsWith('/deployments')
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-preservation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site')
  const account = 'test-account', project = 'test-project'
  const api = createFakeCloudflare({ accountSites: { [account]: [project] }, pagesDeployments: { [account]: { [project]: options.live ? { files: options.live.files } : { neverDeployed: true } } }, pagesAssets: options.live?.bytes ?? {} })
  let records = 0
  const state = {} // `out`: the folder the job wrote the handout into
  const authorisation = { accountId: account, project, productionBranch: 'main', current: () => true,
    run: async (fn) => ({ superseded: false, result: await fn({ CLOUDFLARE_API_TOKEN: 'synthetic-token-not-real', CLOUDFLARE_ACCOUNT_ID: account }) }), clean: x => x, published() {}, refusedForPermission() {} }
  /** The production deployment as the inventory reader gives it (its candidate marker included). */
  const liveInventory = async () => {
    const production = api.production(account, project)
    const files = Object.entries(production?.files ?? {})
    const marker = /^tw-candidate:([0-9a-f]{64})$/u.exec(production?.deployment_trigger?.metadata?.commit_message ?? '')
    return { complete: true, site: `cf-pages:${account}:${project}`, revision: production?.id ?? NO_PRODUCTION_REVISION, ...(marker ? { candidateDigest: marker[1] } : {}), paths: files.map(([path]) => path), files }
  }
  const clock = { offset: 0 }
  const ports = { siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }), bundlingHazard: () => null,
    preservationRoot: join(root, 'coordination'), stagingRoot: () => join(root, 'staging'), inventory: liveInventory,
    pages: () => ({ fetch: fakeCloudflareFetch(api), apiBase: 'http://127.0.0.1:9/client/v4', allowLoopbackForTests: true, sleep: async () => {}, contentType: wranglerContentType }), blake3: () => blake3,
    registry: { read: () => ({}), write() {} } }
  // A seeded live site was published from this computer: its publication record says so (what lets it make the first site record).
  if (options.live) writePublicationRecord(join(root, 'coordination'), `cf-pages:${account}:${project}`, api.production(account, project).id)
  const service = createHandoutPublishing(ports)
  const job = { entry: 'talk', revision: () => 'source-1', prepare: async ({ dir, makeFolder }) => { const out = makeFolder(join(dir, 'talk')); state.out = out; writeFileSync(join(out, 'index.html'), 'new'); return { ok: true, built: null } }, record() { records++ } }
  const journal = join(root, 'coordination', publicationBinding(`cf-pages:${account}:${project}`) + '.json')
  return { root, service, job, ports, dir, state, authorisation, api, liveInventory, journal, clock, production: () => api.production(account, project),
    uploads: () => api.requests.filter(isDeployment).length, records: () => records }
}
for (const entry of ['talk', 'run']) test(`real authoring ${entry} publishes into a site whose other pages this computer does not have`, async t => {
  const f = fixture(t, { live: liveOf({ '/unrelated/index.html': 'kept' }) })
  const result = await f.service.publish({ ...f.job, entry })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(f.uploads(), 1)
  assert.equal(f.production().files['/unrelated/index.html'], pagesHash('kept', '/unrelated/index.html'), 'the page this computer never had keeps its live hash')
  assert.equal(f.production().files['/talk/index.html'], pagesHash('new', '/talk/index.html'))
  assert.equal(existsSync(join(f.dir, 'unrelated')), false, 'and it is not fetched to this computer')
})

for (const entry of ['talk', 'run']) {
  for (const [name, reason, options, setUp] of [
    ['unavailable inventory', 'PUBLISH_INVENTORY_UNAVAILABLE', {}, f => { f.ports.inventory = async () => null }],
    ['an inventory without its hashes', 'PUBLISH_INVENTORY_UNAVAILABLE', {}, f => { f.ports.inventory = async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: ['/a/index.html'] }) }],
    ['wrong site', 'PUBLISH_IDENTITY_CHANGED', {}, f => { f.ports.inventory = async () => ({ complete: true, site: 'other', revision: 'dep-1', paths: [] }) }],
    ['changed production', 'PUBLISH_REVISION_CHANGED', {}, f => { let n = 0; f.ports.inventory = async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: `dep-${++n}`, paths: [], files: [] }) }],
    ['source revision changed', 'PUBLISH_IDENTITY_CHANGED', {}, f => { let rev = 'one'; f.job.revision = () => rev; const prep = f.job.prepare; f.job.prepare = async b => { rev = 'two'; return prep(b) } }],
    ['unrelated removal', 'PUBLISH_UNRELATED_REMOVAL', { live: liveOf({ '/other/index.html': 'keep' }) }, f => { const prep = f.job.prepare; f.job.prepare = async b => { rmSync(join(b.dir, 'other'), { recursive: true }); return prep(b) } }],
    ['unrelated change', 'PUBLISH_UNRELATED_REMOVAL', { live: liveOf({ '/other/index.html': 'keep' }) }, f => { const prep = f.job.prepare; f.job.prepare = async b => { writeFileSync(join(b.dir, 'other', 'index.html'), 'changed'); return prep(b) } }],
  ]) test(`real authoring ${entry}: ${name}`, async t => {
    const f = fixture(t, options); setUp(f)
    const result = await f.service.publish({ ...f.job, entry })
    assert.equal(result.error, reason); assert.equal(f.uploads(), 0); assert.equal(f.records(), 0)
    assert.equal(f.api.model.uploads.length, 0, 'no bytes were uploaded either')
  })
}

test('authoring unknown outcome stays unknown across restart, rechecks read-only and never retries', async t => {
  const f = fixture(t)
  f.api.model.answer = r => isDeployment(r) ? { status: 502, body: '<html>bad gateway</html>' } : null
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(existsSync(f.journal), true, 'the recovery journal stays')
  let reads = 0
  f.ports.inventory = async () => { reads++; return { complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-2', paths: [], files: [] } }
  // Cloudflare cannot say what became of it (its deployments cannot be listed): it stays unknown, and nothing is sent.
  f.api.model.answer = r => (r.method === 'GET' && r.path.endsWith('/deployments') ? { status: 500, body: 'down' } : null)
  const again = await createHandoutPublishing(f.ports).publish(f.job)
  assert.equal(again.error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(reads, 1); assert.equal(f.uploads(), 1); assert.equal(f.records(), 0)
  assert.equal(existsSync(f.journal), true, 'the journal stays until Cloudflare can say')
  // Even once it can say, a request that was sent and is not in the list proves nothing: it stays unknown, however long.
  f.api.model.answer = null
  f.ports.inventory = f.liveInventory
  assert.equal((await createHandoutPublishing(f.ports).publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN', 'not in the list: not proof')
  // The manual recovery (spec: "Recovering a stuck publish") removes the journal; the next publish proceeds from the site as it is.
  rmSync(f.journal)
  assert.equal((await createHandoutPublishing(f.ports).publish(f.job)).ok, true)
  assert.equal(f.uploads(), 2)
})

test('an unknown outcome that did go up is recognised by the next publish from its candidate digest', async t => {
  const f = fixture(t)
  // Cloudflare makes the deployment, and its answer is lost.
  f.api.model.answer = r => { if (!isDeployment(r)) return null; f.api.model.answer = null; f.api.handle(r); return { status: 502, body: 'lost' } }
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(f.production().files['/talk/index.html'], pagesHash('new', '/talk/index.html'), 'it went up')
  const again = await createHandoutPublishing(f.ports).publish(f.job)
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(existsSync(f.journal), false, 'the journal is settled')
  assert.equal(f.api.requests.filter(isDeployment).length, 2, 'nothing new was deployed: the site already holds this change')
})

test('authoring local writer coordination refuses concurrent publish before prepare', async t => {
  const f = fixture(t)
  let release, entered
  const started = new Promise(r => { entered = r }), wait = new Promise(r => { release = r })
  f.api.model.delay = r => (isDeployment(r) ? (entered(), wait) : null)
  const running = f.service.publish(f.job)
  await started
  try {
    let prepared = false
    const second = await createHandoutPublishing(f.ports).publish({ ...f.job, prepare: async b => { prepared = true; return f.job.prepare(b) } })
    assert.equal(second.error, 'PUBLISH_BUSY'); assert.equal(prepared, false)
  } finally { release(); f.api.model.delay = null; await running }
})

test('a deployment request that fails to send remains unknown', async t => {
  const f = fixture(t)
  f.api.model.answer = r => (isDeployment(r) ? { throws: new TypeError('fetch failed') } : null)
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  // The next publish asks what became of it first; within the settlement window it cannot say, so nothing is sent again.
  assert.equal((await createHandoutPublishing(f.ports).publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(f.uploads(), 1); assert.equal(f.records(), 0)
})

for (const scenario of ['path set', 'initial binding', 'launch throws', 'single use', 'symlink', 'final digest', 'first digest', 'missing digest', 'abandoned lock', 'standing journal']) {
  test(`publication policy regression: ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'tw-policy-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'site'); mkdirSync(dir)
    writeFileSync(join(dir, 'index.html'), 'approved')
    const storageRoot = join(root, 'coordination')
    const site = 'cf-pages:policy-test'
    let reads = 0, launches = 0, bindings = 0
    const options = { site, storageRoot, candidateDigest: null,
      approvedBinding: 'approved', binding: () => { bindings++; return scenario === 'initial binding' && bindings === 1 ? 'changed' : 'approved' },
      inventory: async () => {
        reads++
        if (reads === 2 && scenario === 'final digest') writeFileSync(join(dir, 'index.html'), 'raced')
        // The first recheck must run before this await: otherwise a changed copy can be
        // restored here and hide the earlier substitution from the final recheck.
        if (reads === 2 && scenario === 'first digest') writeFileSync(join(dir, 'index.html'), 'approved')
        return { complete: true, site, revision: 'same', paths: reads === 2 && scenario === 'path set' ? ['/new.html'] : [] }
      } }
    if (scenario === 'missing digest') delete options.candidateDigest
    if (scenario === 'symlink') symlinkSync(join(dir, 'index.html'), join(dir, 'link.html'))
    if (scenario === 'abandoned lock' || scenario === 'standing journal') {
      mkdirSync(storageRoot)
      writeFileSync(join(storageRoot, publicationBinding(site) + '.json'), '{}')
      if (scenario === 'abandoned lock') mkdirSync(join(storageRoot, publicationBinding(site) + '.lock'))
      await assert.rejects(beginPublication(options), { reason: scenario === 'abandoned lock' ? 'PUBLISH_BUSY' : 'PUBLISH_OUTCOME_UNKNOWN' })
      return
    }
    if (scenario === 'initial binding') {
      await assert.rejects(beginPublication(options), { reason: 'PUBLISH_IDENTITY_CHANGED' }); return
    }
    const attempt = await beginPublication(options)
    try {
      if (scenario === 'first digest') {
        // Change during copy, before the first digest recheck, then restore at final read.
        const originalCopy = policyPromises.copyFile
        policyPromises.copyFile = (async (...args) => {
          await originalCopy(...args)
          if (String(args[0]) === join(dir, 'index.html')) writeFileSync(join(dir, 'index.html'), 'raced')
        })
        syncBuiltinESMExports()
        t.after(() => { policyPromises.copyFile = originalCopy; syncBuiltinESMExports() })
      }
      const launch = async () => { launches++; if (scenario === 'launch throws') throw new Error('lost transport'); return { outcome: 'accepted', value: 'ok' } }
      if (scenario === 'single use') {
        assert.equal(await attempt.upload(dir, [], [], launch), 'ok')
        await assert.rejects(attempt.upload(dir, [], [], launch), { reason: 'PUBLISH_OUTCOME_UNKNOWN' })
        assert.equal(launches, 1)
      } else {
        await assert.rejects(attempt.upload(dir, [], [], launch), { reason: scenario === 'path set' ? 'PUBLISH_REVISION_CHANGED' : scenario === 'launch throws' ? 'PUBLISH_OUTCOME_UNKNOWN' : 'PUBLISH_CANDIDATE_CHANGED' })
        assert.equal(launches, scenario === 'launch throws' ? 1 : 0)
        if (scenario === 'launch throws') {
          attempt.close()
          await assert.rejects(beginPublication(options), { reason: 'PUBLISH_OUTCOME_UNKNOWN' })
        }
      }
    } finally { attempt.close() }
  })
}

// Fix round 2: shared policy behaviours run in each writer's existing regression file.
for (const scenario of ['reclaim dead holder', 'keep live holder', 'unchanged baseline', 'matching candidate', 'different candidate', 'different path set', 'live child', 'dead child', 'pending launch', 'control missing', 'control changed', 'ignored bytes', 'NFD paths', 'encoded alias', 'unsupported path', 'async hashing']) {
  test(`publication recovery regression: ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'tw-recovery-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'site'), storageRoot = join(root, 'coordination')
    mkdirSync(dir); mkdirSync(storageRoot)
    const site = 'cf-pages:recovery-test', key = publicationBinding(site)
    const journal = join(storageRoot, key + '.json'), record = join(storageRoot, key + '.controls.json')
    writeFileSync(join(dir, 'index.html'), 'approved')
    const tree = await publicationTree(dir)
    const options = { site, storageRoot, candidateDigest: null, binding: () => 'approved', approvedBinding: 'approved',
      inventory: async () => ({ complete: true, site, revision: 'baseline', paths: ['/index.html'] }) }
    let launches = 0
    const upload = async (frozen, context) => { launches++; return { outcome: 'accepted', value: 'ok' } }
    if (scenario.includes('holder')) {
      const lock = join(storageRoot, key + '.lock'); mkdirSync(lock)
      // Obtain the actual start identity from a real policy lock without guessing a PID start.
      const another = await beginPublication({ ...options, site: 'cf-pages:identity', inventory: async () => ({ complete: true, site: 'cf-pages:identity', revision: 'baseline', paths: [] }) })
      const owner = JSON.parse(readFileSync(join(storageRoot, publicationBinding('cf-pages:identity') + '.lock/owner.json'), 'utf8'))
      another.close()
      writeFileSync(join(lock, 'owner.json'), JSON.stringify(scenario === 'keep live holder' ? owner : { pid: 2147483647, started: owner.started }))
      if (scenario === 'keep live holder') { await assert.rejects(beginPublication(options), { reason: 'PUBLISH_BUSY' }); return }
    }
    if (['unchanged baseline', 'matching candidate', 'different candidate', 'different path set', 'live child', 'dead child', 'pending launch'].includes(scenario)) {
      const entry = { version: 2, site, revision: 'baseline', candidateDigest: tree.digest, paths: ['/index.html'], controls: {}, outcome: 'unknown', launch: scenario === 'pending launch' ? 'pending' : 'settled' }
      if (!['pending launch', 'live child'].includes(scenario)) entry.child = { pid: 2147483647, started: 'exited fixture group', group: true }
      if (scenario === 'dead child') { entry.child = { pid: 2147483647, started: 'old child', group: true }; entry.launch = 'running' }
      if (scenario === 'live child') {
        const identity = await beginPublication({ ...options, site: 'cf-pages:identity', inventory: async () => ({ complete: true, site: 'cf-pages:identity', revision: 'baseline', paths: [] }) })
        entry.child = JSON.parse(readFileSync(join(storageRoot, publicationBinding('cf-pages:identity') + '.lock/owner.json'), 'utf8'))
        entry.launch = 'running'; identity.close()
      }
      writeFileSync(journal, JSON.stringify(entry))
      if (scenario === 'matching candidate' || scenario === 'different candidate' || scenario === 'different path set') options.inventory = async () => ({ complete: true, site, revision: 'new', paths: scenario === 'different path set' ? ['/other.html'] : ['/index.html'], candidateDigest: scenario === 'different candidate' ? '0'.repeat(64) : tree.digest })
      if (['different candidate', 'different path set', 'live child', 'pending launch'].includes(scenario)) {
        await assert.rejects(beginPublication(options), { reason: 'PUBLISH_OUTCOME_UNKNOWN' }); assert.equal(launches, 0); return
      }
      const attempt = await beginPublication(options)
      try {
        assert.equal(existsSync(journal), false)
        assert.equal(attempt.recovered, scenario === 'matching candidate')
        if (attempt.recovered) assert.equal(JSON.parse(readFileSync(record, 'utf8')).published, true)
        assert.equal(launches, 0, 'reconciliation itself never writes to hosting')
      } finally { attempt.close() }
      return
    }
    if (scenario === 'encoded alias' || scenario === 'unsupported path') {
      const path = scenario === 'encoded alias' ? '/%41.html' : '/bad#name.html'
      writeFileSync(join(dir, 'A.html'), 'different')
      options.inventory = async () => ({ complete: true, site, revision: 'baseline', paths: [path] })
      await assert.rejects(beginPublication(options), error => error.reason === 'PUBLISH_INVENTORY_UNAVAILABLE' && error.message.includes(path))
      assert.equal(launches, 0); return
    }
    if (scenario === 'NFD paths') {
      writeFileSync(join(dir, 'cafe\u0301.html'.replace('\\u0301', '\u0301')), 'accent')
      // Construct decomposition explicitly so editors cannot normalise the fixture away.
      const nfd = '/cafe' + String.fromCharCode(0x301) + '.html'
      options.inventory = async () => ({ complete: true, site, revision: 'baseline', paths: ['/index.html', nfd] })
    }
    if (scenario === 'ignored bytes') {
      writeFileSync(join(dir, '.DS_Store'), 'not reviewed')
      assert.equal((await publicationTree(dir)).digest, tree.digest)
    }
    if (scenario.startsWith('control')) {
      for (const name of ['_redirects', '_headers', '_routes.json', '_worker.js', 'functions/example.js']) {
        const path = join(dir, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'initial')
      }
      const good = await beginPublication(options)
      try { await good.upload(dir, [], [], upload) } finally { good.close() }
      assert.equal(Object.keys(JSON.parse(readFileSync(record, 'utf8')).controls).length, 5)
      if (scenario === 'control missing') {
        // Each control is independently protected even though absent from the remote file map.
        for (const name of ['_redirects', '_headers', '_routes.json', '_worker.js', 'functions/example.js']) {
          const path = join(dir, name); rmSync(path)
          const attempt = await beginPublication(options)
          try { await assert.rejects(attempt.upload(dir, [], [], upload), { reason: 'PUBLISH_COVERAGE_MISSING' }) } finally { attempt.close(); writeFileSync(path, 'initial') }
        }
        assert.equal(launches, 1); return
      }
      writeFileSync(join(dir, '_redirects'), '/short /new 302')
    }
    if (scenario === 'async hashing') {
      for (let i = 0; i < 12; i++) writeFileSync(join(dir, `${i}.bin`), Buffer.alloc(128 * 1024))
      let ticked = false
      const timer = setTimeout(() => { ticked = true }, 0)
      const originalOpen = policyPromises.open
      let active = 0, maximum = 0
      policyPromises.open = async (...args) => {
        const handle = await originalOpen(...args)
        maximum = Math.max(maximum, ++active)
        const close = handle.close.bind(handle)
        let closed = false
        handle.close = async () => {
          try { await close() } finally { if (!closed) { closed = true; active-- } }
        }
        return handle
      }
      syncBuiltinESMExports()
      try { await publicationTree(dir) } finally { policyPromises.open = originalOpen; syncBuiltinESMExports(); clearTimeout(timer) }
      assert.equal(ticked, true, 'site hashing yields the Electron event loop')
      assert.ok(maximum > 1 && maximum <= 4, `at most four readers: ${maximum}`)
    }
    const attempt = await beginPublication(options)
    try {
      assert.equal(await attempt.upload(dir, [], [], async (frozen, context) => {
        if (scenario === 'ignored bytes') assert.equal(existsSync(join(frozen, '.DS_Store')), false)
        assert.equal(context.candidateDigest, (await publicationTree(frozen)).digest)
        return upload(frozen, context)
      }), 'ok')
    } finally { attempt.close() }
  })
}


test('a deployment Cloudflare refuses is definite and clears the journal for retry', async t => {
  const f = fixture(t)
  f.api.model.answer = r => (isDeployment(r) ? { status: 400, body: { success: false, errors: [{ code: 8000096, message: 'refused' }], messages: [], result: null } } : null)
  const failed = await f.service.publish(f.job)
  assert.equal(failed.ok, false)
  assert.notEqual(failed.error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(existsSync(f.journal), false)
  f.api.model.answer = null
  assert.equal((await f.service.publish(f.job)).ok, true)
  assert.equal(f.uploads(), 2)
})


test('Go live displays the preservation sentence with its support code', async () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ensureLiveJoinUrl')
  assert.ok(declaration)
  const compiled = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  let refusal, writes = 0
  const deps = {
    URL, join, preservationMessage, LiveServiceError,
    liveLinkFolder: () => 'talk', getConfig: () => 'talks', resolveBase: () => 'https://talks.test',
    publishSiteDir: () => '/synthetic-site', siteFolder: () => '/synthetic-site/talk', existsSync: () => true,
    readHandoutRegistry: () => ({}), pickShortId: () => ({ id: 'abcd', registry: { talk: 'abcd' } }), recoverIdFromUrl: () => null,
    writeHandoutRegistry() {}, publishedFolders: () => ['talk'], buildRedirects: () => '/abcd /talk/ 302',
    readFileSync: () => '', publishUrl: () => 'https://talks.test/abcd', writeFileSync: () => { writes++ },
    handoutPublishing: () => ({ publish: async job => { assert.equal(job.entry, 'live-short-link'); return refusal } }),
  }
  const ensure = Function(...Object.keys(deps), compiled + '\nreturn ensureLiveJoinUrl')(...Object.values(deps))
  for (const reason of ['PUBLISH_BUSY', 'PUBLISH_OUTCOME_UNKNOWN', 'PUBLISH_INVENTORY_UNAVAILABLE', 'PUBLISH_CANDIDATE_CHANGED']) {
    refusal = { ok: false, error: reason, ...(reason === 'PUBLISH_INVENTORY_UNAVAILABLE' ? { details: preservationMessage(reason, '/bad#name.html') } : reason === 'PUBLISH_CANDIDATE_CHANGED' ? { details: 'Publishing stopped because the local file \"/a#b.html\" contains %, ? or #. Rename it before publishing. Nothing was uploaded. (PUBLISH_CANDIDATE_CHANGED)' } : {}) }
    await assert.rejects(ensure({ shortUrl: 'https://talks.test/talk/index.html' }), { message: refusal.details ?? preservationMessage(reason) })
  }
  assert.equal(writes, 0, 'a refused Go-live attempt never prepares redirects')
})


test('publishing inventory carries the candidate marker and named refusal through the credential port', async t => {
  const saved = globalThis.fetch
  t.after(() => { globalThis.fetch = saved })
  const digest = 'd'.repeat(64), created = new Date(Date.now() - 86400000).toISOString()
  const production = { id: 'aaaaaaaa-1111-4111-8111-111111111111', environment: 'production', created_on: created, latest_stage: { status: 'success' }, deployment_trigger: { metadata: { commit_message: 'tw-candidate:' + digest } } }
  let unsupported = false, credentials = 0
  globalThis.fetch = async url => new Response(JSON.stringify({ success: true, result: String(url).includes('/deployments/') ? { ...production, files: { [unsupported ? '/bad#path.html' : '/index.html']: 'e'.repeat(32) } } : { name: 'test-project', canonical_deployment: production } }), { headers: { 'content-type': 'application/json' } })
  const authorisation = { accountId: 'a'.repeat(32), project: 'test-project', run: async callback => { credentials++; return { superseded: false, result: await callback({ CLOUDFLARE_API_TOKEN: 'synthetic-token-not-real' }) } } }
  const read = await readPublishingInventory(authorisation)
  assert.equal(read?.candidateDigest, digest)
  assert.deepEqual(read?.paths, ['/index.html'])
  assert.equal(credentials, 1)
  unsupported = true
  await assert.rejects(readPublishingInventory(authorisation), error => error.reason === 'PUBLISH_INVENTORY_UNAVAILABLE' && error.message.includes('/bad#path.html'))
})


test('publishing inventory asks the stand-in API only when given its loopback address', async t => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef', SITE = 'talkweaver-handouts', TOKEN = 'synthetic-token-not-real'
  const api = await startCloudflareApiStub({ accounts: [{ id: ACCOUNT, name: 'Ada' }], pagesDeployments: { [ACCOUNT]: { [SITE]: { files: { '/earlier/index.html': pagesFileHash('earlier') } }, 'never-deployed': { neverDeployed: true } } } })
  const saved = globalThis.fetch
  t.after(async () => { globalThis.fetch = saved; await api.close() })
  const authorisation = site => ({ accountId: ACCOUNT, project: site, run: async callback => ({ superseded: false, result: await callback({ CLOUDFLARE_API_TOKEN: TOKEN }) }) })
  const read = await readPublishingInventory(authorisation(SITE), api.baseUrl)
  assert.deepEqual(read?.paths, ['/earlier/index.html'])
  assert.match(read?.revision ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  assert.ok(api.reached().includes(`GET /accounts/${ACCOUNT}/pages/projects/${SITE}`))
  // A site never deployed to: Cloudflare says so (`canonical_deployment: null`), so there is nothing to lose and the inventory is empty.
  const empty = await readPublishingInventory(authorisation('never-deployed'), api.baseUrl)
  assert.deepEqual(empty, { complete: true, site: `cf-pages:${ACCOUNT}:never-deployed`, revision: 'no-production-deployment', paths: [], files: [] })
  // A site that does not exist at all is not proven empty: the check cannot be made.
  assert.equal(await readPublishingInventory(authorisation('no-such-site'), api.baseUrl), null)
  // Without the stand-in address (a packaged build, any ordinary run) the check asks Cloudflare's own, never the loopback API.
  const asked = []
  globalThis.fetch = async url => { asked.push(String(url)); return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }) }
  const before = api.requests.length
  assert.equal(await readPublishingInventory(authorisation(SITE)), null)
  assert.ok(asked.length && asked.every(url => url.startsWith('https://api.cloudflare.com/client/v4/')), asked.join())
  // An address that is not exactly this computer's loopback API is refused before any request.
  asked.length = 0
  assert.equal(await readPublishingInventory(authorisation(SITE), 'http://example.test/client/v4'), null)
  assert.deepEqual(asked, [])
  assert.equal(api.requests.length, before)
})


const HEX_ACCOUNT = '0123456789abcdef0123456789abcdef'
const cloudflareAnswers = (answer) => async (url) => {
  const reply = answer(String(url))
  if (reply === 'unreachable') throw new TypeError('fetch failed')
  return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
}
const projectReply = (extra) => ({ body: { success: true, errors: [], messages: [], result: { name: 'new-site', ...extra } } })
const hexAuthorisation = (calls = []) => ({ accountId: HEX_ACCOUNT, project: 'new-site', productionBranch: 'main', current: () => true, clean: x => x, published() {}, refusedForPermission() {},
  run: async callback => ({ superseded: false, result: await callback({ CLOUDFLARE_API_TOKEN: 'synthetic-token-not-real' }) }) })

test('first publish to a site with no production deployment succeeds; only Cloudflare saying so counts', async t => {
  const saved = globalThis.fetch
  const api = await startCloudflareApiStub({ accounts: [{ id: HEX_ACCOUNT, name: 'Ada' }], pagesDeployments: { [HEX_ACCOUNT]: { 'new-site': { neverDeployed: true } } } })
  t.after(async () => { globalThis.fetch = saved; await api.close() })
  const root = mkdtempSync(join(tmpdir(), 'tw-first-publish-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site')
  const authorisation = hexAuthorisation()
  const service = createHandoutPublishing({ siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }), bundlingHazard: () => null,
    preservationRoot: join(root, 'coordination'), stagingRoot: () => join(root, 'staging'), inventory: a => readPublishingInventory(a, api.baseUrl),
    pages: () => ({ fetch: (url, init) => globalThis.fetch(url, init), apiBase: api.baseUrl, allowLoopbackForTests: true, sleep: async () => {}, contentType: wranglerContentType }), blake3: () => blake3 })
  const deployments = () => api.requests.filter(isDeployment).length
  // Cloudflare's answer for a site just made: the project, and `canonical_deployment: null`.
  const result = await service.publish({ entry: 'talk', revision: () => 'source-1', prepare: async ({ dir: site, makeFolder }) => { writeFileSync(join(makeFolder(join(site, 'talk')), 'index.html'), 'first'); return { ok: true, built: null } } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(deployments(), 1)
  assert.equal(api.production(HEX_ACCOUNT, 'new-site').files['/talk/index.html'], pagesHash('first', '/talk/index.html'))
  // Everything short of that explicit answer still refuses (nothing is built or uploaded for it).
  for (const [name, answer] of [
    ['Cloudflare unreachable', () => 'unreachable'],
    ['server error', () => ({ status: 500, body: { success: false, errors: [{ code: 1000 }], messages: [], result: null } })],
    ['rate limited', () => ({ status: 429, body: { success: false, errors: [], messages: [], result: null } })],
    ['token refused', () => ({ status: 403, body: { success: false, errors: [{ code: 10000 }], messages: [], result: null } })],
    ['site not found', () => ({ status: 404, body: { success: false, errors: [{ code: 8000007 }], messages: [], result: null } })],
    ['field absent, not null', () => projectReply({})],
    ['another site named', () => ({ body: { success: true, errors: [], messages: [], result: { name: 'other-site', canonical_deployment: null } } })],
    ['reply that does not read', () => ({ body: { success: true, result: 'nonsense' } })],
  ]) {
    globalThis.fetch = cloudflareAnswers(answer)
    assert.equal(await readPublishingInventory(hexAuthorisation()), null, name)
    const before = deployments()
    const refused = await service.publish({ entry: 'talk', revision: () => 'source-1', prepare: async () => assert.fail('nothing is built when the check cannot be made') })
    assert.equal(refused.ok, false, name); assert.equal(refused.error, 'PUBLISH_INVENTORY_UNAVAILABLE', name); assert.equal(deployments(), before, name)
  }
  // A deployment that appears between the two reads is a changed site, not an empty one.
  let reads = 0
  const deployment = { id: '11111111-2222-4333-8444-555555555555', environment: 'production', project_name: 'new-site', created_on: new Date(Date.now() - 60_000).toISOString(), latest_stage: { name: 'deploy', status: 'success' }, short_id: '11111111' }
  globalThis.fetch = cloudflareAnswers(url => {
    if (url.endsWith('/new-site')) return projectReply({ canonical_deployment: ++reads <= 1 ? null : deployment })
    return { body: { success: true, errors: [], messages: [], result: { ...deployment, files: {} } } }
  })
  const before = deployments()
  const raced = await service.publish({ entry: 'talk', revision: () => 'source-1', prepare: async ({ dir: site, makeFolder }) => { writeFileSync(join(makeFolder(join(site, 'talk')), 'index.html'), 'raced'); return { ok: true, built: null } } })
  assert.equal(raced.ok, false); assert.equal(raced.error, 'PUBLISH_REVISION_CHANGED'); assert.equal(deployments(), before)
})

test('a publish refused before anything is sent leaves this computer\'s copy as it was; the retry uses the same folder name', async t => {
  const f = fixture(t)
  mkdirSync(join(f.dir, 'kept'), { recursive: true }); writeFileSync(join(f.dir, 'kept/index.html'), 'kept') // this computer's own copy: never touched
  let n = 0
  f.ports.inventory = async () => { const read = await f.liveInventory(); return ++n === 2 ? { ...read, revision: 'moved' } : read }
  // The Run publisher's rule, in short: a folder name that is taken gets a -2.
  const job = { entry: 'run', revision: () => 'source-1', prepare: async ({ dir: site, makeFolder }) => {
    const name = existsSync(join(site, 'run-talk')) ? 'run-talk-2' : 'run-talk'
    writeFileSync(join(makeFolder(join(site, name)), 'index.html'), 'pages'); return { ok: true, built: name } } }
  const refused = await f.service.publish(job)
  assert.equal(refused.error, 'PUBLISH_REVISION_CHANGED')
  assert.deepEqual(readdirSync(f.dir).sort(), ['kept'], 'nothing of the refused publish is left here')
  f.ports.inventory = f.liveInventory
  const again = await f.service.publish(job)
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.built, 'run-talk')
  assert.deepEqual(readdirSync(f.dir).sort(), ['kept', 'run-talk'])
  assert.equal(readFileSync(join(f.dir, 'kept/index.html'), 'utf8'), 'kept')
  assert.deepEqual(Object.keys(f.production().files).filter((path) => !path.startsWith('/_talkweaver/')), ['/run-talk/index.html'], 'one copy goes up')
  assert.deepEqual(readdirSync(join(f.root, 'staging')), [], 'the attempt\'s private folders are gone')
})

test('a publish whose build fails, or whose outcome is unknown, leaves this computer\'s copy as it was', async t => {
  const f = fixture(t)
  const failing = await f.service.publish({ ...f.job, prepare: async ({ dir, makeFolder }) => { const out = makeFolder(join(dir, 'half')); writeFileSync(join(out, 'index.html'), 'part'); return { ok: false, error: 'the build said no' } } })
  assert.equal(failing.ok, false); assert.equal(existsSync(f.dir), false)
  await assert.rejects(f.service.publish({ ...f.job, prepare: async ({ dir, makeFolder }) => { makeFolder(join(dir, 'half')); throw new Error('compiler threw') } }), /compiler threw/)
  assert.equal(existsSync(f.dir), false)
  assert.deepEqual(readdirSync(join(f.root, 'staging')), [])
  // An unknown outcome: the recovery check reads the live site and the journal, never this computer's copy, so nothing is kept here.
  const unknown = fixture(t)
  unknown.api.model.answer = r => (isDeployment(r) ? { status: 504, body: 'timeout' } : null)
  assert.equal((await unknown.service.publish(unknown.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(existsSync(unknown.dir), false)
  assert.equal(f.uploads(), 0)
})

test('publication binding is checked after asynchronous staging finishes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tw-binding-order-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site'); mkdirSync(dir); writeFileSync(join(dir, 'index.html'), 'approved')
  let binding = 'approved', sourceReads = 0, launches = 0
  const originalOpen = policyPromises.open
  policyPromises.open = async (...args) => {
    if (String(args[0]) === join(dir, 'index.html') && ++sourceReads === 3) binding = 'changed'
    return originalOpen(...args)
  }
  syncBuiltinESMExports()
  t.after(() => { policyPromises.open = originalOpen; syncBuiltinESMExports() })
  const site = 'cf-pages:binding-order'
  const attempt = await beginPublication({ site, storageRoot: join(root, 'coordination'), candidateDigest: null,
    binding: () => binding, approvedBinding: 'approved', inventory: async () => ({ complete: true, site, revision: 'baseline', paths: [] }) })
  try {
    await assert.rejects(attempt.upload(dir, [], [], async () => { launches++; return { outcome: 'accepted', value: 'ok' } }), { reason: 'PUBLISH_IDENTITY_CHANGED' })
    assert.equal(launches, 0)
  } finally { attempt.close() }
})


// Fix round 3: no hosting calls; each fixture owns and removes its entire coordination root.
for (const scenario of ['returned live child', 'untracked return', 'dead wrapper without group', 'settled without group', 'ownerless fresh', 'ownerless stale race', 'corrupt control', 'invalid control', 'local percent', 'local query', 'local hash', 'NFD upload bytes', 'NFC replacement refused']) {
  test(`round 3 policy: ${scenario}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'tw-round3-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'site'), storageRoot = join(root, 'coordination')
    mkdirSync(dir); mkdirSync(storageRoot)
    const site = 'cf-pages:round3', key = publicationBinding(site)
    const journal = join(storageRoot, key + '.json'), lock = join(storageRoot, key + '.lock')
    writeFileSync(join(dir, 'index.html'), 'keep')
    const options = { site, storageRoot, candidateDigest: null, binding: () => 'same', approvedBinding: 'same',
      inventory: async () => ({ complete: true, site, revision: 'baseline', paths: ['/index.html'] }) }
    let launched = 0
    if (scenario.startsWith('ownerless')) {
      mkdirSync(lock)
      if (scenario === 'ownerless fresh') { await assert.rejects(beginPublication(options), { reason: 'PUBLISH_BUSY' }); return }
      const old = new Date(Date.now() - 60_000); policyFs.utimesSync(lock, old, old)
      const results = await Promise.allSettled([beginPublication(options), beginPublication(options)])
      try {
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'exactly one reclaimer owns the replacement')
        for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.reason, 'PUBLISH_BUSY')
      } finally { for (const result of results) if (result.status === 'fulfilled') result.value.close() }
      return
    }
    if (scenario === 'dead wrapper without group' || scenario === 'settled without group') {
      writeFileSync(journal, JSON.stringify({ version: 2, site, revision: 'baseline', candidateDigest: 'a'.repeat(64), paths: ['/index.html'], controls: {}, launch: scenario === 'settled without group' ? 'settled' : 'running', child: { pid: 2147483647, started: 'dead wrapper' } }))
      await assert.rejects(beginPublication(options), { reason: 'PUBLISH_OUTCOME_UNKNOWN' }); return
    }
    if (scenario.endsWith('control')) writeFileSync(join(storageRoot, key + '.controls.json'), scenario === 'corrupt control' ? '{bad' : 'null')
    if (scenario.startsWith('local')) writeFileSync(join(dir, { 'local percent': '50%.html', 'local query': 'q?x.html', 'local hash': 'a#b.html' }[scenario]), 'refuse')
    const nfd = '/cafe' + String.fromCharCode(0x301) + '.html'
    if (scenario === 'NFD upload bytes' || scenario === 'NFC replacement refused') {
      writeFileSync(join(dir, scenario === 'NFD upload bytes' ? nfd : nfd.normalize('NFC')), 'accent')
      options.inventory = async () => ({ complete: true, site, revision: 'baseline', paths: ['/index.html', scenario === 'NFD upload bytes' ? nfd : nfd.normalize('NFC')] })
      // Use the actual filesystem spelling (macOS may decompose a name on creation).
      const actual = '/' + policyFs.readdirSync(dir).find(name => name !== 'index.html')
      if (scenario === 'NFC replacement refused') options.inventory = async () => ({ complete: true, site, revision: 'baseline', paths: ['/index.html', actual === nfd ? nfd.normalize('NFC') : nfd] })
    }
    const attempt = await beginPublication(options)
    try {
      const upload = () => attempt.upload(dir, [], [], async (frozen, context) => {
        launched++
        if (scenario === 'returned live child') await context.started(process.pid, true)
        if (scenario === 'NFD upload bytes') {
          assert.deepEqual(policyFs.readdirSync(frozen).filter(name => name !== '.wrangler').sort(), policyFs.readdirSync(dir).sort(), 'frozen upload retains filesystem name bytes')
          assert.ok(policyFs.readdirSync(frozen).includes(nfd.slice(1)))
        }
        return { outcome: scenario === 'returned live child' || scenario === 'untracked return' ? 'unknown' : 'accepted', value: 'ok' }
      })
      if (scenario === 'returned live child' || scenario === 'untracked return') {
        await assert.rejects(upload(), { reason: 'PUBLISH_OUTCOME_UNKNOWN' })
        assert.notEqual(JSON.parse(readFileSync(journal, 'utf8')).launch, 'settled')
        attempt.close()
        await assert.rejects(beginPublication(options), { reason: 'PUBLISH_OUTCOME_UNKNOWN' })
      } else if (scenario.endsWith('control') || scenario.startsWith('local') || scenario === 'NFC replacement refused') {
        await assert.rejects(upload(), error => {
          assert.equal(error.reason, scenario.endsWith('control') ? 'PUBLISH_INVENTORY_UNAVAILABLE' : 'PUBLISH_CANDIDATE_CHANGED')
          if (scenario.startsWith('local')) { assert.match(error.message, /Rename it/); assert.match(error.message, /50%|q\?x|a#b/) }
          return true
        })
        assert.equal(launched, 0)
      } else assert.equal(await upload(), 'ok')
    } finally { attempt.close() }
  })
}

test('round 3 shared outcome decision keeps unproven failures unknown', () => {
  assert.equal(publicationOutcome({ accepted: true }), 'accepted')
  assert.equal(publicationOutcome({ accepted: true, interrupted: true }), 'unknown')
  assert.equal(publicationOutcome({ accepted: false, neverStarted: true }), 'failed')
  for (const output of ['401', '403', 'Project not found [code: 8000007]', 'Authentication error', 'Invalid _routes.json file', 'Uploaded 403 files\nMissing directory. Provide the path']) assert.equal(publicationOutcome({ accepted: false, output }), 'unknown', output)
  assert.equal(publicationOutcome({ accepted: false, output: 'Missing directory. Provide the path to your build output directory.' }), 'failed')
})

test('round 3 launcher kill deadline leaves journal unsettled until exit is proved', async t => {
  // The whole-folder path of the shared contract (the other writer's): a tool whose exit is not proved keeps the journal running.
  const { EventEmitter } = await import('node:events')
  const { runWrangler } = await import('../src/main/wrangler-launcher.ts')
  const root = mkdtempSync(join(tmpdir(), 'tw-kill-deadline-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site'); mkdirSync(join(dir, 'talk'), { recursive: true }); writeFileSync(join(dir, 'talk/index.html'), 'new')
  const site = 'cf-pages:kill-deadline', storageRoot = join(root, 'coordination')
  const options = { site, storageRoot, candidateDigest: null, binding: () => 'same', approvedBinding: 'same', inventory: async () => ({ complete: true, site, revision: 'baseline', paths: [] }) }
  const attempt = await beginPublication(options)
  try {
    await assert.rejects(attempt.upload(dir, [], [], async (_frozen, context) => {
      const run = await runWrangler({ execPath: process.execPath, appRoot: '/synthetic', platform: 'darwin', workDir: '/synthetic', exists: () => true }, ['pages', 'deploy'], {
        timeoutMs: 1, killGraceMs: 1, killDeadlineMs: 1, publicationStarted: context.started,
        start: () => {
          const child = new EventEmitter()
          child.pid = process.pid; child.group = false
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
          child.stdin = Object.assign(new EventEmitter(), { end() {} }); child.kill = () => true
          return child
        },
      })
      return { outcome: publicationOutcome({ accepted: run.ok && !run.timedOut, output: `${run.stdout}${run.stderr}` }), value: run }
    }), { reason: 'PUBLISH_OUTCOME_UNKNOWN' })
  } finally { attempt.close() }
  const journal = join(storageRoot, publicationBinding(site) + '.json')
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).launch, 'running')
  await assert.rejects(beginPublication(options), { reason: 'PUBLISH_OUTCOME_UNKNOWN' })
})

test('round 3 policy: atomic retirement preserves a racing replacement lock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tw-reclaim-race-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const storageRoot = join(root, 'coordination'); mkdirSync(storageRoot)
  const site = 'cf-pages:reclaim-race', lock = join(storageRoot, publicationBinding(site) + '.lock')
  mkdirSync(lock); const old = new Date(Date.now() - 60_000); policyFs.utimesSync(lock, old, old)
  const rename = policyFs.renameSync
  policyFs.renameSync = (from, to) => {
    rename(from, to)
    if (from === lock) { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'replacement', pid: process.pid, started: 'replacement' })) }
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(beginPublication({ site, storageRoot, candidateDigest: null, binding: () => 'same', approvedBinding: 'same', inventory: async () => ({ complete: true, site, revision: 'baseline', paths: [] }) }), { reason: 'PUBLISH_BUSY' })
    assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'replacement')
  } finally { policyFs.renameSync = rename; syncBuiltinESMExports() }
})

for (const mode of ['sync', 'no PID', 'has PID']) test(`round 3 launcher no-child evidence: ${mode}`, async () => {
  const { EventEmitter } = await import('node:events')
  const { runWrangler } = await import('../src/main/wrangler-launcher.ts')
  const result = await runWrangler({ execPath: process.execPath, appRoot: '/synthetic', platform: 'darwin', workDir: '/synthetic', exists: () => true }, ['pages', 'deploy'], { start: () => {
    if (mode === 'sync') throw new Error('spawn rejected')
    const child = new EventEmitter()
    if (mode === 'has PID') child.pid = 2147483647
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
    child.stdin = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => child.emit('error', new Error('spawn ENOENT'))) })
    return child
  } })
  assert.equal(result.neverStarted, mode === 'has PID' ? undefined : true)
})

test('round 3 policy: owner record exists before atomic lock installation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tw-owner-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const site = 'cf-pages:owner-install', storageRoot = join(root, 'coordination'), lock = join(storageRoot, publicationBinding(site) + '.lock')
  const rename = policyFs.renameSync
  let checkedOwner = false, attempt
  policyFs.renameSync = (from, to) => {
    if (to === lock) {
      const owner = JSON.parse(readFileSync(join(from, 'owner.json'), 'utf8'))
      assert.equal(owner.pid, process.pid); assert.ok(owner.started && owner.token)
      checkedOwner = true
    }
    rename(from, to)
  }
  syncBuiltinESMExports()
  try {
    attempt = await beginPublication({ site, storageRoot, candidateDigest: null, binding: () => 'same', approvedBinding: 'same', inventory: async () => ({ complete: true, site, revision: 'baseline', paths: [] }) })
    assert.equal(checkedOwner, true)
  } finally { policyFs.renameSync = rename; syncBuiltinESMExports(); attempt?.close() }
})

test('round 3 launcher records process group coverage', async () => {
  const { EventEmitter } = await import('node:events')
  const { runWrangler } = await import('../src/main/wrangler-launcher.ts')
  let identity
  const result = await runWrangler({ execPath: process.execPath, appRoot: '/synthetic', platform: 'darwin', workDir: '/synthetic', exists: () => true }, ['pages', 'deploy'], {
    publicationStarted: async (pid, group) => { identity = { pid, group } }, signalGroup: () => {},
    start: () => {
      const child = new EventEmitter(); child.pid = 2147483647; child.group = true
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
      child.stdin = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => child.emit('close', 0)) })
      return child
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(identity, { pid: 2147483647, group: true })
})

// ── This computer's copy of the site: kept up to date after a publish that went up, never written through a link ─────────────

test('this computer\'s copy is never written through a link, and the publish goes up all the same', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t)
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep')
  mkdirSync(f.dir, { recursive: true })
  symlinkSync(outside, join(f.dir, 'talk'))
  symlinkSync(join(outside, 'keep.txt'), join(f.dir, '404.html'))
  symlinkSync(join(outside, 'keep.txt'), join(f.dir, '_redirects'))
  const job = { ...f.job, prepare: async ({ dir, makeFolder, claimFile, writeSiteFile }) => {
    claimFile(join(dir, '404.html')); writeFileSync(join(dir, '404.html'), 'not found')
    writeFileSync(join(makeFolder(join(dir, 'talk')), 'index.html'), 'new')
    writeSiteFile(join(dir, '_redirects'), '/abcd  /talk/  302\n')
    return { ok: true, built: null } } }
  const result = await f.service.publish(job)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(f.production().files['/talk/index.html'], pagesHash('new', '/talk/index.html'))
  assert.deepEqual([readdirSync(outside), readFileSync(join(outside, 'keep.txt'), 'utf8')], [['keep.txt'], 'keep'], 'nothing outside the copy changed')
  for (const name of ['talk', '404.html', '_redirects']) assert.ok(lstatSync(join(f.dir, name)).isSymbolicLink(), `${name}: still the link it was`)
})

test('a folder that is not this attempt\'s in the staging area is never swept', async t => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'staging', 'tw-site-someone-else'), { recursive: true })
  writeFileSync(join(f.root, 'staging', 'tw-site-someone-else', 'keep'), 'keep')
  assert.equal((await f.service.publish(f.job)).ok, true)
  assert.deepEqual(readdirSync(join(f.root, 'staging')), ['tw-site-someone-else'])
})
