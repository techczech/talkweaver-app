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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-preservation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'site'); mkdirSync(dir)
  let uploads = 0, records = 0
  const authorisation = { accountId: 'test-account', project: 'test-project', productionBranch: 'main', current: () => true,
    run: async (fn) => ({ superseded: false, result: await fn({}) }), clean: x => x, published() {}, refusedForPermission() {} }
  const ports = { siteDir: () => dir, authorise: async () => ({ ok: true, authorisation }), live: async () => ({ baseUrl: '' }),
    toolMissing: () => null, bundlingHazard: () => null,
    upload: async (args, credentials, started) => { await started?.(2147483647, true); uploads++; return options.uploadFn ? options.uploadFn(args) : options.upload ?? { ok: true, stdout: '', stderr: '' } },
    preservationRoot: join(root, 'coordination'),
    inventory: async () => ({ complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: options.paths ?? [] }) }
  const service = createHandoutPublishing(ports)
  const job = { entry: 'talk', revision: () => 'source-1', prepare: async ({ dir }) => { mkdirSync(join(dir, 'talk'), { recursive: true }); writeFileSync(join(dir, 'talk/index.html'), 'new'); return { ok: true, built: null } }, record() { records++ } }
  return { service, job, ports, dir, authorisation, uploads: () => uploads, records: () => records }
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
    ['candidate changed during final read', 'PUBLISH_CANDIDATE_CHANGED', f => { let n = 0; f.ports.inventory = async () => { if (++n === 2) writeFileSync(join(f.dir, 'talk/index.html'), 'raced'); return { complete: true, site: 'cf-pages:test-account:test-project', revision: 'dep-1', paths: [] } } }],
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
