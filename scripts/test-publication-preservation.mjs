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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { pagesFileHash, startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-preservation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site'); mkdirSync(dir)
  let uploads = 0, records = 0
  const state = {} // `out`: the folder the job wrote the handout into (a private one, for a new handout)
  const authorisation = { accountId: 'test-account', project: 'test-project', productionBranch: 'main', current: () => true,
    run: async (fn) => ({ superseded: false, result: await fn({}) }), clean: x => x, published() {}, refusedForPermission() {} }
  const ports = { siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }),
    toolMissing: () => null, bundlingHazard: () => null,
    upload: async (args, credentials, started) => { await started?.(2147483647, true); uploads++; return options.uploadFn ? options.uploadFn(args) : options.upload ?? { ok: true, stdout: '', stderr: '' } },
    preservationRoot: join(root, 'coordination'),
    inventory: async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: options.paths ?? [] }) }
  const service = createHandoutPublishing(ports)
  const job = { entry: 'talk', revision: () => 'source-1', prepare: async ({ dir, makeFolder }) => { const out = makeFolder(join(dir, 'talk')); state.out = out; writeFileSync(join(out, 'index.html'), 'new'); return { ok: true, built: null } }, record() { records++ } }
  return { service, job, ports, dir, state, authorisation, uploads: () => uploads, records: () => records }
}
for (const entry of ['talk', 'run']) test(`real authoring ${entry} refuses missing coverage before upload`, async t => {
  const f = fixture(t, { paths: ['/unrelated/index.html'] })
  const result = await f.service.publish({ ...f.job, entry })
  assert.equal(f.uploads(), 0)
  assert.match(result.error, /PUBLISH_COVERAGE_MISSING/)
})

for (const entry of ['talk', 'run']) {
  for (const [name, reason, setUp] of [
    ['unavailable inventory', 'PUBLISH_INVENTORY_UNAVAILABLE', f => { f.ports.inventory = async () => null }],
    ['wrong site', 'PUBLISH_IDENTITY_CHANGED', f => { f.ports.inventory = async () => ({ complete: true, site: 'other', revision: 'dep-1', paths: [] }) }],
    ['changed production', 'PUBLISH_REVISION_CHANGED', f => { let n = 0; f.ports.inventory = async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: `dep-${++n}`, paths: [] }) }],
    ['source revision changed', 'PUBLISH_IDENTITY_CHANGED', f => { let rev = 'one'; f.job.revision = () => rev; const prep = f.job.prepare; f.job.prepare = async b => { rev = 'two'; return prep(b) } }],
    ['candidate changed during final read', 'PUBLISH_CANDIDATE_CHANGED', f => { let n = 0; f.ports.inventory = async () => { if (++n === 2) writeFileSync(join(f.state.out, 'index.html'), 'raced'); return { complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: [] } } }],
    ['unrelated removal', 'PUBLISH_UNRELATED_REMOVAL', f => { mkdirSync(join(f.dir, 'other')); writeFileSync(join(f.dir, 'other/index.html'), 'keep'); f.ports.inventory = async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: ['/other/index.html'] }); const prep = f.job.prepare; f.job.prepare = async b => { rmSync(join(f.dir, 'other'), { recursive: true }); return prep(b) } }],
  ]) test(`real authoring ${entry}: ${name}`, async t => {
    const f = fixture(t); setUp(f)
    const result = await f.service.publish({ ...f.job, entry })
    assert.equal(result.error, reason); assert.equal(f.uploads(), 0); assert.equal(f.records(), 0)
  })
}

test('authoring normal publish uploads frozen bytes and preserves unrelated pages', async t => {
  let frozen
  const f = fixture(t, { paths: ['/other/index.html'], uploadFn: async args => {
    frozen = args[2]; assert.notEqual(frozen, f.dir)
    writeFileSync(join(f.dir, 'talk/index.html'), 'later edit')
    assert.equal(readFileSync(join(frozen, 'talk/index.html'), 'utf8'), 'new')
    assert.equal(readFileSync(join(frozen, 'other/index.html'), 'utf8'), 'keep')
    return { ok: true, stdout: '', stderr: '' }
  } })
  mkdirSync(join(f.dir, 'other')); writeFileSync(join(f.dir, 'other/index.html'), 'keep')
  assert.equal((await f.service.publish(f.job)).ok, true)
  assert.equal(f.records(), 1); assert.equal(existsSync(frozen), false)
})

test('authoring timeout remains unknown across restart, rechecks read-only and never retries', async t => {
  const f = fixture(t, { upload: { ok: false, timedOut: true, stdout: '', stderr: '' } })
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  let reads = 0
  f.ports.inventory = async () => { reads++; return { complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-2', paths: [] } }
  const again = await createHandoutPublishing(f.ports).publish(f.job)
  assert.equal(again.error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(reads, 1); assert.equal(f.uploads(), 1); assert.equal(f.records(), 0)
})

test('authoring local writer coordination refuses concurrent upload before prepare', async t => {
  let release, entered
  const started = new Promise(r => { entered = r }), wait = new Promise(r => { release = r })
  let launches = 0
  const f = fixture(t, { uploadFn: async () => { if (++launches === 1) { entered(); await wait }; return { ok: true, stdout: '', stderr: '' } } })
  const running = f.service.publish(f.job)
  await started
  try {
    let prepared = false
    const second = await createHandoutPublishing(f.ports).publish({ ...f.job, prepare: async b => { prepared = true; return f.job.prepare(b) } })
    assert.equal(second.error, 'PUBLISH_BUSY'); assert.equal(prepared, false)
  } finally { release(); await running }
})


test('authoring tool transport failure without a timeout flag remains unknown', async t => {
  const f = fixture(t, { upload: { ok: false, stdout: '', stderr: 'fetch failed ETIMEDOUT' } })
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal((await createHandoutPublishing(f.ports).publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(f.uploads(), 2); assert.equal(f.records(), 0)
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


test('authoring validation refusal is definite and clears the journal for retry', async t => {
  const f = fixture(t, { upload: { ok: false, stdout: '', stderr: 'Missing directory. Provide the path to your build output directory.' } })
  const failed = await f.service.publish(f.job)
  assert.equal(failed.ok, false)
  assert.notEqual(failed.error, 'PUBLISH_OUTCOME_UNKNOWN')
  let retried = 0
  f.ports.upload = async () => { retried++; return { ok: true, stdout: '', stderr: '' } }
  assert.equal((await f.service.publish(f.job)).ok, true)
  assert.equal(retried, 1)
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
  assert.deepEqual(empty, { complete: true, site: `cf-pages:${ACCOUNT}:never-deployed`, revision: 'no-production-deployment', paths: [] })
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
  t.after(() => { globalThis.fetch = saved })
  // Cloudflare's answer for a site just made: the project, and `canonical_deployment: null`.
  globalThis.fetch = cloudflareAnswers(() => projectReply({ canonical_deployment: null }))
  const root = mkdtempSync(join(tmpdir(), 'tw-first-publish-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site'); mkdirSync(dir)
  let uploads = 0, frozenFiles
  const authorisation = hexAuthorisation()
  const service = createHandoutPublishing({ siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }), toolMissing: () => null, bundlingHazard: () => null,
    preservationRoot: join(root, 'coordination'), inventory: a => readPublishingInventory(a),
    upload: async (args, credentials, started) => { await started?.(2147483647, true); uploads++; frozenFiles = readFileSync(join(args[2], 'talk/index.html'), 'utf8'); return { ok: true, stdout: '', stderr: '' } } })
  const result = await service.publish({ entry: 'talk', revision: () => 'source-1', prepare: async ({ dir: site }) => { mkdirSync(join(site, 'talk'), { recursive: true }); writeFileSync(join(site, 'talk/index.html'), 'first'); return { ok: true, built: null } } })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(uploads, 1); assert.equal(frozenFiles, 'first')
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
    uploads = 0
    const refused = await service.publish({ entry: 'talk', revision: () => 'source-1', prepare: async () => assert.fail('nothing is built when the check cannot be made') })
    assert.equal(refused.ok, false, name); assert.equal(refused.error, 'PUBLISH_INVENTORY_UNAVAILABLE', name); assert.equal(uploads, 0, name)
  }
  // A deployment that appears between the two reads is a changed site, not an empty one.
  let reads = 0
  const deployment = { id: '11111111-2222-4333-8444-555555555555', environment: 'production', project_name: 'new-site', created_on: new Date(Date.now() - 60_000).toISOString(), latest_stage: { name: 'deploy', status: 'success' }, short_id: '11111111' }
  globalThis.fetch = cloudflareAnswers(url => {
    if (url.endsWith('/new-site')) return projectReply({ canonical_deployment: ++reads <= 1 ? null : deployment })
    return { body: { success: true, errors: [], messages: [], result: { ...deployment, files: {} } } }
  })
  uploads = 0
  const raced = await service.publish({ entry: 'talk', revision: () => 'source-1', prepare: async ({ dir: site }) => { mkdirSync(join(site, 'talk'), { recursive: true }); writeFileSync(join(site, 'talk/index.html'), 'raced'); return { ok: true, built: null } } })
  assert.equal(raced.ok, false); assert.equal(raced.error, 'PUBLISH_REVISION_CHANGED'); assert.equal(uploads, 0)
})

test('a refused publish leaves nothing new in the site folder: the retry reuses the same folder and uploads one copy', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tw-refuse-retry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site'); mkdirSync(dir)
  mkdirSync(join(dir, 'kept')); writeFileSync(join(dir, 'kept/index.html'), 'kept') // already there before: never touched
  let paths = ['/kept/index.html', '/earlier/index.html'], frozen
  const uploaded = []
  const authorisation = { accountId: 'test-account', project: 'test-project', productionBranch: 'main', current: () => true, run: async fn => ({ superseded: false, result: await fn({}) }), clean: x => x, published() {}, refusedForPermission() {} }
  const service = createHandoutPublishing({ siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }), toolMissing: () => null, bundlingHazard: () => null,
    preservationRoot: join(root, 'coordination'), inventory: async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths }),
    upload: async (args, credentials, started) => { await started?.(2147483647, true); frozen = args[2]; uploaded.push(...readdirSync(frozen).filter(name => name !== '.wrangler').sort()); return { ok: true, stdout: '', stderr: '' } } })
  // The Run publisher's rule, in short: a folder name that is taken gets a -2.
  const job = { entry: 'run', revision: () => 'source-1', prepare: async ({ dir: site, makeFolder }) => {
    const name = existsSync(join(site, 'run-talk')) ? 'run-talk-2' : 'run-talk'
    const out = makeFolder(join(site, name)); writeFileSync(join(out, 'index.html'), 'pages'); return { ok: true, built: name } } }
  const refused = await service.publish(job)
  assert.equal(refused.ok, false); assert.match(refused.error, /PUBLISH_COVERAGE_MISSING/)
  assert.deepEqual(readdirSync(dir).sort(), ['kept'], 'the refused publish left its built folder behind')
  assert.equal(readFileSync(join(dir, 'kept/index.html'), 'utf8'), 'kept')
  // The message's own advice: restore the earlier page, publish again.
  mkdirSync(join(dir, 'earlier')); writeFileSync(join(dir, 'earlier/index.html'), 'earlier')
  const again = await service.publish(job)
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.built, 'run-talk')
  assert.deepEqual(readdirSync(dir).sort(), ['earlier', 'kept', 'run-talk'])
  assert.deepEqual(uploaded, ['earlier', 'kept', 'run-talk'], 'one copy goes up')
})

test('a publish whose build fails, or whose output is refused after the build, leaves no new folder either', async t => {
  const f = fixture(t)
  const failing = await f.service.publish({ ...f.job, prepare: async ({ dir, makeFolder }) => { const out = makeFolder(join(dir, 'half')); writeFileSync(join(out, 'index.html'), 'part'); return { ok: false, error: 'the build said no' } } })
  assert.equal(failing.ok, false); assert.deepEqual(readdirSync(f.dir), [])
  await assert.rejects(f.service.publish({ ...f.job, prepare: async ({ dir, makeFolder }) => { makeFolder(join(dir, 'half')); throw new Error('compiler threw') } }), /compiler threw/)
  assert.deepEqual(readdirSync(f.dir), [])
  // An upload whose outcome is unknown keeps its pages: it may have gone up.
  const unknown = fixture(t, { upload: { ok: false, timedOut: true, stdout: '', stderr: '' } })
  assert.equal((await unknown.service.publish(unknown.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.deepEqual(readdirSync(unknown.dir), ['talk'])
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

for (const stderr of ['Uploaded 403 files\nDeployment error: fetch failed', 'Uploaded 401 files\nDeployment error: fetch failed', 'Authentication error [code: 10000]', 'Invalid _routes.json file', 'Uploaded 403 files\nMissing directory. Provide the path to your build output directory.']) {
  test(`round 3 authoring outcome: ${stderr}`, async t => {
    const f = fixture(t, { upload: { ok: false, stdout: '', stderr } })
    let permission = 0; f.authorisation.refusedForPermission = () => { permission++ }
    assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
    assert.equal(existsSync(join(f.ports.preservationRoot, publicationBinding('cf-pages:test-account:test-project') + '.json')), true)
    if (stderr.startsWith('Uploaded')) assert.equal(permission, 0, 'an uploaded-file count is not a permission refusal')
  })
}
for (const missing of [false, true]) test(`round 3 authoring no-child failure clears journal: missing=${missing}`, async t => {
  const f = fixture(t, { upload: { ok: false, stdout: '', stderr: 'spawn ENOENT', ...(missing ? { missing: { error: 'tool missing', details: 'not installed' } } : { neverStarted: true }) } })
  assert.equal((await f.service.publish(f.job)).ok, false)
  assert.equal(existsSync(join(f.ports.preservationRoot, publicationBinding('cf-pages:test-account:test-project') + '.json')), false)
  f.ports.upload = async () => ({ ok: true, stdout: '', stderr: '' })
  assert.equal((await f.service.publish(f.job)).ok, true)
})

test('round 3 shared outcome decision keeps unproven failures unknown', () => {
  assert.equal(publicationOutcome({ accepted: true }), 'accepted')
  assert.equal(publicationOutcome({ accepted: true, interrupted: true }), 'unknown')
  assert.equal(publicationOutcome({ accepted: false, neverStarted: true }), 'failed')
  for (const output of ['401', '403', 'Project not found [code: 8000007]', 'Authentication error', 'Invalid _routes.json file', 'Uploaded 403 files\nMissing directory. Provide the path']) assert.equal(publicationOutcome({ accepted: false, output }), 'unknown', output)
  assert.equal(publicationOutcome({ accepted: false, output: 'Missing directory. Provide the path to your build output directory.' }), 'failed')
})

test('round 3 launcher kill deadline leaves journal unsettled until exit is proved', async t => {
  const { EventEmitter } = await import('node:events')
  const { runWrangler } = await import('../src/main/wrangler-launcher.ts')
  const f = fixture(t)
  f.ports.upload = async (_args, _credentials, started) => runWrangler({ execPath: process.execPath, appRoot: '/synthetic', platform: 'darwin', workDir: '/synthetic', exists: () => true }, ['pages', 'deploy'], {
    timeoutMs: 1, killGraceMs: 1, killDeadlineMs: 1, publicationStarted: started,
    start: () => {
      const child = new EventEmitter()
      child.pid = process.pid; child.group = false
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.stdin = Object.assign(new EventEmitter(), { end() {} }); child.kill = () => true
      return child
    },
  })
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  const journal = join(f.ports.preservationRoot, publicationBinding('cf-pages:test-account:test-project') + '.json')
  assert.equal(JSON.parse(readFileSync(journal, 'utf8')).launch, 'running')
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
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

test('round 3 authoring retains a real permission refusal beside an upload count', async t => {
  const f = fixture(t, { upload: { ok: false, stdout: '', stderr: 'Uploaded 403 files Authentication error [code: 10000]' } })
  let permission = 0; f.authorisation.refusedForPermission = () => { permission++ }
  assert.equal((await f.service.publish(f.job)).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(permission, 1)
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

// ── Ownership: a publish that stops before anything is sent takes away only what it created itself ─────────────────────

/**
 * A publisher whose every moving part a test can set: the inventory (what Cloudflare holds), the connection (current or not, and
 * what its launch does), the bundling check and the tool. The job is the Run publisher's rule in short: a folder name that is
 * taken gets a -2; it creates the folder through `makeFolder`, so it is the folder this attempt owns.
 */
function ownership(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-ownership-'))
  t.after(() => { try { chmodSync(join(root, 'site'), 0o755) } catch {} rmSync(root, { recursive: true, force: true }) })
  const dir = join(root, 'site'); mkdirSync(dir)
  const state = { current: true, paths: options.paths ?? [], hazard: null, launch: null, tool: { ok: true, stdout: '', stderr: '' }, uploaded: [], launches: 0 }
  const authorisation = { accountId: 'test-account', project: 'test-project', productionBranch: 'main', current: () => state.current, clean: x => x, published() {}, refusedForPermission() {},
    run: async fn => state.launch ? state.launch(fn) : ({ superseded: false, result: await fn({}) }) }
  const staging = join(root, 'staging'); mkdirSync(staging)
  const service = createHandoutPublishing({ siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }), toolMissing: () => null, bundlingHazard: () => state.hazard,
    preservationRoot: join(root, 'coordination'), stagingRoot: () => staging, inventory: async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: state.paths }),
    upload: async (args, credentials, started) => {
      state.launches++
      await started?.(2147483647, true)
      if (typeof state.tool === 'function') return state.tool()
      state.uploaded.push(readdirSync(args[2]).filter(name => name !== '.wrangler').sort())
      return state.tool
    } })
  const job = (extra = {}) => ({ entry: 'run', revision: () => { extra.onRevision?.(); return 'source-1' }, prepare: async ({ dir: site, makeFolder, writeSiteFile, claimFile }) => {
    claimFile(join(site, '404.html')) // as the page builder's shared 404 page: owned when new, left when already there
    const name = extra.fixedName ?? (existsSync(join(site, 'run-talk')) ? 'run-talk-2' : 'run-talk')
    // The folder the job writes into is whatever makeFolder gives back (a private one for a new folder); older code gave a flag.
    const made = makeFolder(join(site, name)); const out = typeof made === 'string' ? made : join(site, name)
    writeFileSync(join(out, 'index.html'), 'pages')
    writeSiteFile(join(site, '_redirects'), '/abcd  /run-talk/  302\n')
    writeFileSync(join(site, '404.html'), 'unavailable')
    await extra.afterBuild?.({ site, name, out })
    return { ok: true, built: name } }, record() {} })
  return { dir, state, service, job, staging }
}

test('a refused publish does not remove what another writer added to the shared site folder meanwhile', async t => {
  const o = ownership(t, { paths: ['/earlier/index.html'] }) // the publish will be refused: the earlier page is not in the candidate
  mkdirSync(join(o.dir, 'before')); writeFileSync(join(o.dir, 'before/index.html'), 'was there')
  const refused = await o.service.publish(o.job({ afterBuild: ({ site }) => {
    // Another app, or another TalkWeaver, writes to the same folder while this attempt is building (a folder and a file).
    mkdirSync(join(site, 'other-app')); writeFileSync(join(site, 'other-app/index.html'), 'theirs'); writeFileSync(join(site, 'other.txt'), 'theirs')
  } }))
  assert.equal(refused.ok, false); assert.match(refused.error, /PUBLISH_COVERAGE_MISSING/)
  assert.deepEqual(readdirSync(o.dir).sort(), ['before', 'other-app', 'other.txt'], 'this attempt\'s folder, redirect file and 404 page went; nobody else\'s did')
  assert.equal(readFileSync(join(o.dir, 'other-app/index.html'), 'utf8'), 'theirs')
  assert.equal(readFileSync(join(o.dir, 'before/index.html'), 'utf8'), 'was there')
})

test('a folder that was already there is never this attempt\'s: a republish keeps it, an entry swapped for another is not removed', async t => {
  const o = ownership(t, { paths: ['/earlier/index.html'] })
  mkdirSync(join(o.dir, 'run-talk')); writeFileSync(join(o.dir, 'run-talk/index.html'), 'published earlier'); writeFileSync(join(o.dir, '404.html'), 'the site\'s own')
  // The job is handed the name of a folder that exists: makeFolder says it did not create it.
  let made
  const keep = o.job({ fixedName: 'run-talk' }); const prepare = keep.prepare
  keep.prepare = async (build) => { const real = build.makeFolder; return prepare({ ...build, makeFolder: (path) => { made = real(path); return made } }) }
  assert.equal((await o.service.publish({ ...keep })).ok, false)
  assert.equal(made, join(o.dir, 'run-talk'), 'a folder that was there is written in place, never staged or owned')
  assert.equal(readFileSync(join(o.dir, 'run-talk/index.html'), 'utf8'), 'pages', 'a republished folder stays, with what the attempt wrote into it (the next attempt overwrites it)')
  assert.deepEqual(readdirSync(o.dir).sort(), ['404.html', 'run-talk'], 'only the redirect file, which this attempt created, went; a 404 page that was there stays')
  // A folder of that name another writer made while this attempt was building is theirs, not this attempt's.
  const o2 = ownership(t, { paths: ['/earlier/index.html'] })
  const refused = await o2.service.publish(o2.job({ afterBuild: ({ site, name }) => {
    mkdirSync(join(site, name), { recursive: true }); writeFileSync(join(site, name, 'index.html'), 'someone else\'s')
  } }))
  assert.equal(refused.ok, false)
  assert.equal(readFileSync(join(o2.dir, 'run-talk/index.html'), 'utf8'), 'someone else\'s', 'a folder another writer made is not this attempt\'s')
})

test('an entry that cannot be taken away is named in the failure, not hidden', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const o = ownership(t)
  // The folder went into the site when the tool was asked to start; the tool then refused in a way that is definite, and the site
  // folder may no longer be changed, so what went in cannot be taken away again.
  o.state.tool = () => { chmodSync(o.dir, 0o555); return { ok: false, stdout: '', stderr: 'Error: Must specify a directory of assets to deploy' } }
  const refused = await o.service.publish(o.job())
  chmodSync(o.dir, 0o755)
  assert.equal(refused.ok, false)
  assert.match(refused.details, /could not be removed from the site folder/)
  assert.match(refused.details, /run-talk/, 'the folder that is still there is named')
  assert.ok(existsSync(join(o.dir, 'run-talk')))
})

// Every outcome proven to precede deployment takes the attempt's pages away, and the retry then reuses the original folder name
// and uploads one copy. (A launch the tool made is different: its outcome is unknown and its pages stay.)
const PRE_UPLOAD = [
  ['the connection changed after the pages were built and before the upload began', (o, hooks) => { hooks.afterBuild = () => { o.state.current = false } }, (o) => { o.state.current = true }, { superseded: true, launches: 0 }],
  ['the connection changed between the preservation check and the tool being asked to start', (o) => { o.state.launch = async () => ({ superseded: true }) }, (o) => { o.state.launch = null }, { superseded: true, launches: 0 }],
  ['the upload tool never started', (o) => { o.state.tool = { ok: false, neverStarted: true, stdout: '', stderr: 'could not start' } }, (o) => { o.state.tool = { ok: true, stdout: '', stderr: '' } }, { launches: 1 }],
  ['the upload tool is missing', (o) => { o.state.tool = { ok: false, missing: { error: 'The publishing tool is not installed.', details: 'wrangler' }, stdout: '', stderr: '' } }, (o) => { o.state.tool = { ok: true, stdout: '', stderr: '' } }, { launches: 1 }],
  ['the bundling check refused the folder', (o) => { o.state.hazard = 'This folder would make Cloudflare compile code.' }, (o) => { o.state.hazard = null }, { launches: 0 }],
  ['the tool refused the folder in a way that is definite', (o) => { o.state.tool = { ok: false, stdout: '', stderr: 'Error: Must specify a directory of assets to deploy' } }, (o) => { o.state.tool = { ok: true, stdout: '', stderr: '' } }, { launches: 1 }],
]
for (const [what, breakIt, mend, expected] of PRE_UPLOAD) {
  test(`${what}: the pages it built go again and the retry reuses the folder name`, async t => {
    const o = ownership(t)
    mkdirSync(join(o.dir, 'kept')); writeFileSync(join(o.dir, 'kept/index.html'), 'kept')
    const hooks = {}
    breakIt(o, hooks)
    const failed = await o.service.publish(o.job({ afterBuild: hooks.afterBuild }))
    assert.equal(failed.ok, false, JSON.stringify(failed))
    if (expected.superseded) assert.equal(failed.superseded, true)
    assert.equal(o.state.launches, expected.launches)
    assert.deepEqual(readdirSync(o.dir).sort(), ['kept'], 'nothing this attempt built is left to be uploaded with the next publish')
    mend({ state: o.state })
    const again = await o.service.publish(o.job())
    assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.built, 'run-talk', 'the original folder name, not -2')
    assert.deepEqual(readdirSync(o.dir).sort(), ['404.html', '_redirects', 'kept', 'run-talk'])
    assert.deepEqual(o.state.uploaded.at(-1), ['404.html', '_redirects', 'kept', 'run-talk'], 'one copy goes up')
  })
}

test('an upload that may have gone up keeps its pages: a tool that timed out, or a connection that changed while it ran', async t => {
  const timed = ownership(t)
  timed.state.tool = { ok: false, timedOut: true, stdout: '', stderr: '' }
  assert.equal((await timed.service.publish(timed.job())).error, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.deepEqual(readdirSync(timed.dir).sort(), ['404.html', '_redirects', 'run-talk'])
  const changed = ownership(t)
  changed.state.launch = async (fn) => { await fn({}); changed.state.current = false; return { superseded: true } } // the tool ran, and then the connection changed
  const result = await changed.service.publish(changed.job())
  assert.equal(result.ok, false); assert.equal(result.superseded, true)
  assert.equal(changed.state.launches, 1)
  assert.deepEqual(readdirSync(changed.dir).sort(), ['404.html', '_redirects', 'run-talk'], 'the pages stay for the recovery check')
})

// ── Nothing another writer put inside a folder this attempt made is removed, and nothing before the launch can orphan a folder ──

const noStaging = (o) => assert.deepEqual(readdirSync(o.staging), [], 'the attempt\'s private build folder is gone')
const unreadable = { skip: process.platform === 'win32' || process.getuid?.() === 0 }

test('a file another writer puts INSIDE the folder while it is being built survives a refusal before the upload', async t => {
  const o = ownership(t, { paths: ['/earlier/index.html'] }) // refused: the earlier page is not in the candidate
  const refused = await o.service.publish(o.job({ afterBuild: ({ site, name }) => {
    mkdirSync(join(site, name), { recursive: true }); writeFileSync(join(site, name, 'foreign.txt'), 'theirs')
  } }))
  assert.equal(refused.ok, false); assert.match(refused.error, /PUBLISH_COVERAGE_MISSING/)
  assert.equal(readFileSync(join(o.dir, 'run-talk/foreign.txt'), 'utf8'), 'theirs', 'foreign content inside the folder is never deleted')
  assert.equal(existsSync(join(o.dir, 'run-talk/index.html')), false)
  assert.equal(o.state.launches, 0); noStaging(o)
  assert.deepEqual(readdirSync(o.dir).sort(), ['run-talk'], 'the redirect file and 404 page this attempt created went')
})

test('a file another writer puts inside the folder while the tool runs survives a definite refusal by the tool', async t => {
  const o = ownership(t)
  o.state.tool = () => { writeFileSync(join(o.dir, 'run-talk/foreign.txt'), 'theirs'); return { ok: false, stdout: '', stderr: 'Error: Must specify a directory of assets to deploy' } }
  const refused = await o.service.publish(o.job())
  assert.equal(refused.ok, false)
  assert.equal(readFileSync(join(o.dir, 'run-talk/foreign.txt'), 'utf8'), 'theirs')
  assert.equal(existsSync(join(o.dir, 'run-talk/index.html')), false, 'what this attempt wrote went')
  assert.match(refused.details, /run-talk/, 'the folder that could not be removed is named'); noStaging(o)
})

test('a redirect file, 404 page or republished folder that is a link is refused, never written through; nothing is uploaded', async t => {
  for (const name of ['_redirects', '404.html']) {
    const o = ownership(t)
    const outside = join(o.dir, '..', `outside-${name}`); writeFileSync(outside, 'not ours')
    symlinkSync(outside, join(o.dir, name))
    const refused = await o.service.publish(o.job())
    assert.equal(refused.ok, false, name); assert.equal(refused.error, 'PUBLISH_CANDIDATE_CHANGED', name)
    assert.equal(readFileSync(outside, 'utf8'), 'not ours', `${name}: the file the link points at is unchanged`)
    assert.equal(o.state.launches, 0, `${name}: nothing was uploaded`); assert.deepEqual(o.state.uploaded, [])
  }
  const o = ownership(t); const outside = join(o.dir, '..', 'outside-folder'); mkdirSync(outside)
  symlinkSync(outside, join(o.dir, 'run-talk'))
  const refused = await o.service.publish(o.job({ fixedName: 'run-talk' }))
  assert.equal(refused.ok, false); assert.deepEqual(readdirSync(outside), [], 'nothing was written into the folder the link points at'); assert.equal(o.state.launches, 0)
})

test('a folder that is not this app\'s in the staging area is never swept', async t => {
  const o = ownership(t)
  mkdirSync(join(o.staging, 'tw-publish-foreign')); writeFileSync(join(o.staging, 'tw-publish-foreign/foreign.txt'), 'theirs')
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); policyFs.utimesSync(join(o.staging, 'tw-publish-foreign'), old, old)
  assert.equal((await o.service.publish(o.job())).ok, true)
  assert.equal(readFileSync(join(o.staging, 'tw-publish-foreign/foreign.txt'), 'utf8'), 'theirs')
})

test('an unreadable page found while checking the build leaves no orphan, and the retry reuses the folder name', unreadable, async t => {
  const o = ownership(t)
  await assert.rejects(o.service.publish(o.job({ afterBuild: ({ out }) => { writeFileSync(join(out, 'secret.html'), 'x'); chmodSync(join(out, 'secret.html'), 0) } })), /EACCES/)
  assert.equal(o.state.launches, 0)
  assert.deepEqual(readdirSync(o.dir), [], 'no folder, redirect file or 404 page is left behind'); noStaging(o)
  const again = await o.service.publish(o.job())
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.built, 'run-talk')
})

test('an unreadable earlier page found while listing earlier handouts leaves no orphan, and the retry reuses the folder name', unreadable, async t => {
  const o = ownership(t)
  mkdirSync(join(o.dir, 'before')); writeFileSync(join(o.dir, 'before/index.html'), 'was there')
  t.after(() => { try { chmodSync(join(o.dir, 'before/index.html'), 0o644) } catch {} })
  await assert.rejects(o.service.publish(o.job({ afterBuild: () => chmodSync(join(o.dir, 'before/index.html'), 0) })), /EACCES/)
  assert.deepEqual(readdirSync(o.dir), ['before']); noStaging(o)
  chmodSync(join(o.dir, 'before/index.html'), 0o644)
  const again = await o.service.publish(o.job())
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.built, 'run-talk')
})

test('an ordinary read or copy error before the tool is asked to start withdraws the pages', unreadable, async t => {
  const o = ownership(t)
  t.after(() => { try { chmodSync(join(o.dir, 'run-talk/data.bin'), 0o644) } catch {} })
  const failed = await o.service.publish(o.job({ afterBuild: ({ out }) => { writeFileSync(join(out, 'data.bin'), 'x'); chmodSync(join(out, 'data.bin'), 0) } }))
  assert.equal(failed.ok, false); assert.equal(o.state.launches, 0)
  assert.deepEqual(readdirSync(o.dir), [], 'nothing of this attempt is left to be uploaded with the next publish'); noStaging(o)
  const again = await o.service.publish(o.job())
  assert.equal(again.ok, true, JSON.stringify(again)); assert.equal(again.built, 'run-talk')
})

test('a folder that appears under the same name just before the launch is not merged into: nothing is sent', async t => {
  const o = ownership(t)
  let calls = 0
  const failed = await o.service.publish(o.job({ onRevision: () => {
    // The fourth reading of the source is the last binding check before the journal is written and the folder enters the site.
    if (++calls === 4) { mkdirSync(join(o.dir, 'run-talk')); writeFileSync(join(o.dir, 'run-talk/foreign.txt'), 'theirs') }
  } }))
  assert.equal(calls >= 4, true)
  assert.equal(failed.ok, false); assert.equal(o.state.launches, 0)
  assert.equal(readFileSync(join(o.dir, 'run-talk/foreign.txt'), 'utf8'), 'theirs'); assert.equal(existsSync(join(o.dir, 'run-talk/index.html')), false)
  noStaging(o)
})
