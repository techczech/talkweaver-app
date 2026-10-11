// The live service is uploaded without wrangler (ticket 11; spec "Cloudflare set-up in the app",
// D2, D9, D12). The seams:
//   1. verifyShippedBundle (pure): the shipped files against their manifest;
//   2. migrationsToApply and planLiveServiceUpload (pure): the requests and their bodies, with no network;
//   3. deployLiveService, the request sequence, against the fake Cloudflare API's model
//      (scripts/lib/cloudflare-api-stub.mjs, no network at all).
// Invariants stated here and checked below:
//   - no program is started for a set-up or an update: the sequence's modules import no process or
//     launcher module, and the main process's set-up hands it no launcher (the ambient-access trace,
//     scripts/test-wrangler-ambient-trace.mjs, proves the same of a real run);
//   - the bytes uploaded are the shipped bundle, checked against the manifest's SHA-256 BEFORE any
//     request; a mismatch is "This TalkWeaver installation is incomplete" with Details, nothing sent;
//   - first set-up applies every migration; an update only those after the deployed tag; an update
//     with nothing new sends none;
//   - the stored admin and signing secrets are reused on every update, and no secret value is in a
//     request address, any header but the token's own, a result, Details, or this test's output;
//   - the workers.dev address is read from the API's answer; the share-link domain is attached when
//     set and removed when cleared.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INSTALLATION_INCOMPLETE, UnknownMigrationTagError, migrationsToApply, planLiveServiceUpload, readShippedFiles, secretsBody, validDomainId, verifyShippedBundle, workersDevAddress,
} from '../src/main/live-service-upload.ts'
import {
  LIVE_KEYS_FAILED, LIVE_KEYS_LOST, LIVE_NEWER_SERVICE, LIVE_NO_ADDRESS, LIVE_SETUP_FAILED, LIVE_SETUP_REFUSED, deployLiveService,
} from '../src/main/live-service-deploy.ts'
import { CLOUDFLARE_API_BASE, DEPLOY_SUPERSEDED_ERROR, TOKEN_REMOVED, send } from '../src/main/cloudflare-connection.ts'
import { REPLY_TEXT_MARK, WORKERS_SUBDOMAIN, createFakeCloudflare, fakeCloudflareFetch, workerDomainId } from './lib/cloudflare-api-stub.mjs'
import { workerDistFiles } from './lib/worker-dist.mjs'
import { readSource } from './lib/read-source.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const started = Date.now()

// Everything this test prints is kept, to show at the end that no secret was ever printed.
const printed = []
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest) }
const writeErr = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => { printed.push(String(chunk)); return writeErr(chunk, ...rest) }

const TOKEN = ['made', 'up', 'upload', 'token', '0123456789abcdef'].join('-') // gitleaks:allow (made-up test value)
const READER = ['made', 'up', 'reader', 'token', '0123456789abcdef'].join('-') // gitleaks:allow (made-up test value)
const ACCOUNT = 'acc0upload'
const KEYS = { adminSecret: ['made-up-admin', 'secret', 'abcdef0123456789'].join('-'), signingSecret: ['made-up-signing', 'secret', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
const NEW_KEYS = { adminSecret: ['made-up-new-admin', 'secret', 'abcdef0123456789'].join('-'), signingSecret: ['made-up-new-signing', 'secret', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
const SECRETS = [TOKEN, READER, KEYS.adminSecret, KEYS.signingSecret, NEW_KEYS.adminSecret, NEW_KEYS.signingSecret]
const NAME = 'talkweaver-live-sessions'
const ADDRESS = `https://${NAME}.${WORKERS_SUBDOMAIN}.workers.dev`
const BUILD = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(repo, 'worker', 'recovery-protocol.ts'), 'utf8'))[1]
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const observed = []
// A set-up that succeeds hands the admin secret back to its caller (the share and pre-work calls
// need it); that one field is the contract, not something shown, so it is left out of the search.
const see = (value) => { observed.push(value?.ok ? { ...value, adminSecret: '[handed to the caller]' } : value); return value }

// A shipped folder made from made-up bundle bytes and the real upload settings (worker/wrangler.jsonc).
const BUNDLE = Buffer.from('// made-up bundle\nexport default { fetch() { return new Response("ok") } }\nexport class LiveSession {}\n')
const shipped = workerDistFiles({ repo, bundle: BUNDLE })

// ── 1. verifyShippedBundle ──────────────────────────────────────────────────────────────────────
{
  const files = { bundle: shipped.bundle, config: shipped.configBytes }
  const good = verifyShippedBundle(shipped.manifestText, files, BUILD)
  assert.equal(good.ok, true)
  assert.deepEqual([good.config.name, good.manifest.build, hex(good.bundle)], [NAME, BUILD, shipped.manifest.files['index.js'].sha256])

  const flipped = Buffer.from(BUNDLE)
  flipped[3] ^= 1
  const bad = (manifestText, changed, expectedBuild = BUILD) => verifyShippedBundle(manifestText, { ...files, ...changed }, expectedBuild)
  const CASES = [
    ['no manifest', bad(null, {}), /manifest\.json is missing/],
    ['a manifest that is not JSON', bad('{ not json', {}), /manifest\.json is not readable/],
    ['a manifest of another format', bad(JSON.stringify({ ...shipped.manifest, format: 2 }), {}), /not one this version/],
    ['a manifest without the bundle\'s hash', bad(JSON.stringify({ ...shipped.manifest, files: { 'upload-config.json': shipped.manifest.files['upload-config.json'] } }), {}), /does not describe index\.js/],
    ['no bundle', bad(shipped.manifestText, { bundle: null }), /index\.js is missing/],
    ['an empty bundle', bad(shipped.manifestText, { bundle: Buffer.alloc(0) }), /index\.js is empty/],
    ['a bundle one bit off', bad(shipped.manifestText, { bundle: flipped }), new RegExp(`index\\.js does not match its manifest \\(SHA-256 ${hex(flipped)}`)],
    ['a bundle with a byte more', bad(shipped.manifestText, { bundle: Buffer.concat([BUNDLE, Buffer.from(' ')]) }), /index\.js does not match its manifest/],
    ['changed upload settings', bad(shipped.manifestText, { config: Buffer.from(shipped.configBytes.toString().replace('2026', '2025')) }), /upload-config\.json does not match its manifest/],
    ['a bundle of another build', bad(shipped.manifestText, {}, 'another-build'), /build 19|holds live service build/],
  ]
  for (const [what, result, details] of CASES) {
    assert.deepEqual([result.ok, result.error], [false, INSTALLATION_INCOMPLETE], `${what}: the installation is incomplete`)
    assert.match(result.details, details, `${what}: Details say what is wrong`)
  }
  // Upload settings that match their hash but not their shape (made with a manifest for them).
  const odd = Buffer.from(JSON.stringify({ name: 'Not A Worker!' }))
  const oddManifest = JSON.stringify({ ...shipped.manifest, files: { ...shipped.manifest.files, 'upload-config.json': { sha256: hex(odd), bytes: odd.length } } })
  assert.match(verifyShippedBundle(oddManifest, { ...files, config: odd }, BUILD).details, /upload-config\.json: .*name no valid Worker/)
  assert.equal(INSTALLATION_INCOMPLETE, 'This TalkWeaver installation is incomplete.')
  console.log(`PASS 1: the shipped bundle is checked against its manifest; ${CASES.length + 1} kinds of mismatch are "This TalkWeaver installation is incomplete" with Details`)
}

// ── 2. The plan ─────────────────────────────────────────────────────────────────────────────────
const MIGRATIONS = [
  { tag: 'v1', new_sqlite_classes: ['LiveSession', 'SessionRegistry'] },
  { tag: 'v2', new_sqlite_classes: ['SharedTalk'] },
  { tag: 'v3', new_sqlite_classes: ['RunShare'] },
  { tag: 'v4', new_sqlite_classes: ['RunPrework'] },
]
{
  const steps = (list) => list.map(({ tag: _tag, ...rest }) => rest)
  assert.deepEqual(migrationsToApply(MIGRATIONS, null), { new_tag: 'v4', steps: steps(MIGRATIONS) }, 'none deployed: all of them')
  assert.deepEqual(migrationsToApply(MIGRATIONS, 'v2'), { old_tag: 'v2', new_tag: 'v4', steps: steps(MIGRATIONS.slice(2)) }, 'deployed at v2: v3 and v4, from v2')
  assert.equal(migrationsToApply(MIGRATIONS, 'v4'), null, 'deployed at the last: none')
  assert.throws(() => migrationsToApply(MIGRATIONS, 'v5'), UnknownMigrationTagError, 'a tag this build does not know (a newer TalkWeaver\'s): no migration is replayed')
  assert.equal(migrationsToApply([], null), null)

  const { config, manifest, bundle } = verifyShippedBundle(shipped.manifestText, { bundle: shipped.bundle, config: shipped.configBytes }, BUILD)
  assert.deepEqual(config.migrations, MIGRATIONS, 'the shipped settings carry the Worker\'s four migrations')
  const plan = (over = {}) => planLiveServiceUpload({ config, manifest, bundle, accountId: ACCOUNT, deployedMigrationTag: null, shareHostname: null, attachedDomains: [], ...over })
  const script = `/accounts/${ACCOUNT}/workers/scripts/${NAME}`

  // First set-up: the metadata wrangler 4.144 sends for this Worker (captured from its `deploy` against the fake API).
  const first = plan()
  assert.deepEqual(first.map((request) => `${request.step} ${request.method} ${request.path}`), [
    `upload PUT ${script}?excludeScript=true&bindings_inherit=strict`,
    `workers-dev POST ${script}/subdomain`,
    `secrets PATCH ${script}/secrets-bulk`,
  ])
  assert.equal(JSON.stringify(first[0].body.metadata), JSON.stringify({
    main_module: 'index.js',
    bindings: [
      { name: 'LIVE_SESSIONS', type: 'durable_object_namespace', class_name: 'LiveSession' },
      { name: 'SESSION_REGISTRY', type: 'durable_object_namespace', class_name: 'SessionRegistry' },
      { name: 'SHARED_TALKS', type: 'durable_object_namespace', class_name: 'SharedTalk' },
      { name: 'RUN_SHARES', type: 'durable_object_namespace', class_name: 'RunShare' },
      { name: 'RUN_PREWORK', type: 'durable_object_namespace', class_name: 'RunPrework' },
    ],
    compatibility_date: '2026-05-14',
    compatibility_flags: ['global_fetch_strictly_public'],
    migrations: { new_tag: 'v4', steps: steps(MIGRATIONS) },
    code_update_strategy: { mode: 'deferred', max_delay: 300 },
    observability: { enabled: true },
  }), 'the metadata is byte for byte what wrangler 4.144 sends')
  assert.deepEqual([first[0].body.module.name, first[0].body.module.type, first[0].body.module.bytes === bundle], ['index.js', 'application/javascript+module', true], 'the module is the shipped bundle itself')
  assert.deepEqual([first[1].headers, first[1].body.json], [{ 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' }, { enabled: true }])
  assert.deepEqual([first[2].body.kind, [...first[2].body.names], first[2].body.contentType], ['secrets', ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET'], 'application/merge-patch+json'], 'the secrets request names them; the plan holds no value')
  assert.ok(!JSON.stringify(first, (key, value) => (value instanceof Uint8Array ? `<${value.length} bytes>` : value)).includes('"text"'))

  // Updates.
  assert.ok(!('migrations' in plan({ deployedMigrationTag: 'v4' })[0].body.metadata), 'an update with nothing new sends no migrations')
  assert.deepEqual(plan({ deployedMigrationTag: 'v3' })[0].body.metadata.migrations, { old_tag: 'v3', new_tag: 'v4', steps: [{ new_sqlite_classes: ['RunPrework'] }] }, 'an update sends only those after the deployed tag')

  // The share-link domain.
  const attach = plan({ shareHostname: 'talks.example.org' })
  assert.deepEqual(attach.map((request) => request.step), ['upload', 'workers-dev', 'attach-domain', 'secrets'])
  assert.deepEqual([attach[2].method, attach[2].path, attach[2].body.json], ['PUT', `${script}/domains/records`, { override_scope: true, override_existing_origin: true, override_existing_dns_record: true, origins: [{ hostname: 'talks.example.org' }] }])
  const kept = plan({ shareHostname: 'talks.example.org', attachedDomains: [{ id: workerDomainId('talks.example.org'), hostname: 'talks.example.org' }] })
  assert.ok(!kept.some((request) => request.step === 'remove-domain'), 'the domain still set is not removed')
  const moved = plan({ shareHostname: 'new.example.org', attachedDomains: [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org' }] })
  assert.deepEqual(moved.filter((request) => /domain/.test(request.step)).map((request) => `${request.step} ${request.method} ${request.path}`), [`attach-domain PUT ${script}/domains/records`, `remove-domain DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId('old.example.org')}`])
  const cleared = plan({ attachedDomains: [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org' }] })
  assert.deepEqual(cleared.map((request) => request.step), ['upload', 'workers-dev', 'remove-domain', 'secrets'], 'cleared: removed, nothing attached')

  // The secrets body, as wrangler's putBulkSecrets sends it (made only when the request is sent).
  assert.deepEqual(JSON.parse(secretsBody({ ADMIN_SECRET: 'a', SESSION_SIGNING_SECRET: 'b' })), { secrets: { ADMIN_SECRET: { name: 'ADMIN_SECRET', text: 'a', type: 'secret_text' }, SESSION_SIGNING_SECRET: { name: 'SESSION_SIGNING_SECRET', text: 'b', type: 'secret_text' } } })
  // The address, only from a plain subdomain.
  assert.equal(workersDevAddress(NAME, 'stand-in'), ADDRESS)
  for (const odd of ['', 'a.b', 'evil.example/x', 'UPPER', '-x', null, 7, 'x'.repeat(64)]) assert.equal(workersDevAddress(NAME, odd), null, `no address from ${JSON.stringify(odd)}`)
  console.log('PASS 2: the plan: wrangler 4.144\'s metadata; all migrations first, only the newer ones on update, none when nothing is new; workers.dev on; the domain attached, moved, or removed; secrets by name only')
}

// ── 3. The sequence against the fake API ────────────────────────────────────────────────────────
/** A connection's leave, as cloudflare-connection.ts gives it (the generation can be ended by a test). */
function leave(token = TOKEN, accountId = ACCOUNT) {
  const state = { current: true, asked: 0 }
  const authorisation = {
    accountId,
    current: () => state.current,
    async run(launch) {
      if (!state.current) return { superseded: true }
      const result = await launch({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId })
      return state.current ? { superseded: false, result } : { superseded: true }
    },
    clean: (text) => String(text).split(token).join(TOKEN_REMOVED),
  }
  return { state, authorisation }
}
const worlds = []
function world(options = {}) {
  const fake = createFakeCloudflare({ tokens: { [TOKEN]: { accounts: [ACCOUNT] }, [READER]: { accounts: [ACCOUNT], workers: 'read' } }, accounts: [{ id: ACCOUNT, name: 'Ada' }], ...options.fake })
  worlds.push(fake)
  return { fake, fetch: fakeCloudflareFetch(fake), stored: options.stored === undefined ? null : options.stored, saved: [], made: 0, authorised: 0, record: options.record ?? '', recorded: [] }
}
async function setUp(w, over = {}) {
  const granted = over.leave ?? leave(over.token)
  const result = await deployLiveService({
    shipped: () => over.shipped ?? { manifest: shipped.manifestText, bundle: shipped.bundle, config: shipped.configBytes },
    expectedBuild: BUILD,
    authorise: async () => { w.authorised += 1; return { ok: true, authorisation: granted.authorisation } },
    storedKeys: () => w.stored,
    makeKeys: () => { w.made += 1; w.stored = NEW_KEYS; return NEW_KEYS },
    shareHostname: () => over.shareHostname ?? null,
    // The record of a share-link domain this app may have attached, as the main process keeps it in config.
    shareDomainAttachedBefore: () => Boolean(w.record),
    recordShareDomain: (hostname) => { w.record = hostname ?? ''; w.recorded.push(hostname) },
    fetch: over.fetch ?? w.fetch,
    apiBase: () => 'http://127.0.0.1:9/client/v4',
    save: (kept) => { w.saved.push(kept) },
    timeoutMs: { upload: 2000, request: 2000 },
  })
  return see(result)
}
const lines = (w, from = 0) => w.fake.requests.slice(from).map((request) => `${request.method} ${request.path}${request.search ?? ''}`)
const workerOf = (w) => w.fake.model.workers.get(ACCOUNT)?.get(NAME)
const uploadOf = (w, from = 0) => w.fake.requests.slice(from).find((request) => request.method === 'PUT' && request.path === `/accounts/${ACCOUNT}/workers/scripts/${NAME}`)
const script = `/accounts/${ACCOUNT}/workers/scripts/${NAME}`

{
  // First set-up: all migrations, new keys, the address from the API's answer.
  const w = world()
  const first = await setUp(w)
  assert.deepEqual(first, { ok: true, baseUrl: ADDRESS, adminSecret: NEW_KEYS.adminSecret })
  assert.deepEqual(lines(w), [
    `GET /accounts/${ACCOUNT}/workers/services/${NAME}`,
    `GET /accounts/${ACCOUNT}/workers/subdomain`,
    `PUT ${script}?excludeScript=true&bindings_inherit=strict`,
    `POST ${script}/subdomain`,
    `PATCH ${script}/secrets-bulk`,
  ], 'first set-up: look up, read the address, upload, workers.dev on, the keys')
  assert.deepEqual([w.made, w.saved], [1, [{ baseUrl: ADDRESS, accountId: ACCOUNT }]], 'keys made once (none stored, none deployed); the address kept with its account')
  const upload = uploadOf(w)
  const module = upload.parts.find((part) => part.name === 'index.js')
  assert.deepEqual([module.filename, module.type, hex(module.bytes)], ['index.js', 'application/javascript+module', shipped.manifest.files['index.js'].sha256], 'the uploaded bytes are the shipped bundle, by the manifest\'s hash')
  assert.ok(module.bytes.equals(BUNDLE))
  assert.equal(upload.parts.find((part) => part.name === 'metadata').filename, null, 'the metadata is a plain field, as wrangler sends it')
  assert.deepEqual(workerOf(w).metadata.migrations, { new_tag: 'v4', steps: MIGRATIONS.map(({ tag: _tag, ...rest }) => rest) }, 'every Durable Object migration')
  assert.deepEqual([workerOf(w).migrationTag, workerOf(w).workersDev, workerOf(w).secrets.sort()], ['v4', true, ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET']])
  const patch = w.fake.requests.find((request) => request.method === 'PATCH')
  assert.equal(patch.contentType, 'application/merge-patch+json')
  assert.deepEqual(JSON.parse(patch.body.toString()), JSON.parse(secretsBody({ ADMIN_SECRET: NEW_KEYS.adminSecret, SESSION_SIGNING_SECRET: NEW_KEYS.signingSecret })))
  assert.equal(w.fake.requests.find((request) => request.method === 'POST').headers['cloudflare-workers-script-api-date'], '2025-08-01')

  // An update of the same build: the stored keys, no migrations, and the domains looked at.
  const before = w.fake.requests.length
  const again = await setUp(w)
  assert.deepEqual([again.ok, again.adminSecret, w.made], [true, NEW_KEYS.adminSecret, 1], 'an update reuses the stored keys and makes none')
  assert.deepEqual(lines(w, before), [
    `GET /accounts/${ACCOUNT}/workers/services/${NAME}`,
    `GET /accounts/${ACCOUNT}/workers/subdomain`,
    `GET /accounts/${ACCOUNT}/workers/domains?service=${NAME}&environment=production`,
    `PUT ${script}?excludeScript=true&bindings_inherit=strict`,
    `POST ${script}/subdomain`,
    `PATCH ${script}/secrets-bulk`,
  ])
  assert.ok(!('migrations' in workerOf(w).metadata), 'an update with nothing new sends no migration')
  assert.equal(JSON.parse(w.fake.requests.at(-1).body.toString()).secrets.ADMIN_SECRET.text, NEW_KEYS.adminSecret, 'and sets the same keys again')

  // An update from a Worker deployed at v2: only v3 and v4.
  workerOf(w).migrationTag = 'v2'
  const fromV2 = await setUp(w)
  assert.equal(fromV2.ok, true)
  assert.deepEqual(workerOf(w).metadata.migrations, { old_tag: 'v2', new_tag: 'v4', steps: [{ new_sqlite_classes: ['RunShare'] }, { new_sqlite_classes: ['RunPrework'] }] }, 'only those after the deployed tag')
  assert.equal(workerOf(w).migrationTag, 'v4')
  console.log('PASS 3: first set-up applies every migration and makes the keys; an update reuses them and sends only the newer migrations, or none; the uploaded bytes are the shipped bundle')
}

{
  // Stored keys from an earlier version of the app, and a Worker it deployed: reused, never replaced.
  const w = world({ stored: KEYS })
  w.fake.model.workers.set(ACCOUNT, new Map([[NAME, { uploads: 1, secrets: ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET'], migrationTag: 'v4', module: null, metadata: null, workersDev: true }]]))
  const result = await setUp(w)
  assert.deepEqual([result.ok, result.adminSecret, w.made], [true, KEYS.adminSecret, 0])
  assert.deepEqual(JSON.parse(w.fake.requests.at(-1).body.toString()), JSON.parse(secretsBody({ ADMIN_SECRET: KEYS.adminSecret, SESSION_SIGNING_SECRET: KEYS.signingSecret })), 'the stored admin and signing secrets are the ones set')

  // D9: a Worker is deployed and this computer has no keys: stop, write nothing, make none.
  const lost = world()
  lost.fake.model.workers.set(ACCOUNT, new Map([[NAME, { uploads: 1, secrets: ['ADMIN_SECRET'], migrationTag: 'v4', module: null, metadata: null, workersDev: true }]]))
  const stopped = await setUp(lost)
  assert.deepEqual(stopped, { ok: false, error: LIVE_KEYS_LOST })
  assert.deepEqual([lost.made, lost.saved, lines(lost).filter((line) => !line.startsWith('GET '))], [0, [], []], 'no keys made, nothing written here or at Cloudflare')
  console.log('PASS 4: stored keys are reused on every update; a deployed Worker with no keys on this computer stops the set-up (D9)')
}

{
  // The share-link domain: attached when set, moved, removed when cleared. Another Worker's domain is left alone.
  const w = world({ stored: KEYS, fake: { workerDomains: { [ACCOUNT]: ['other.example.org'] } } })
  const domains = () => (w.fake.model.workerDomains.get(ACCOUNT) ?? []).map((domain) => `${domain.hostname}→${domain.service}`).sort()
  assert.equal((await setUp(w, { shareHostname: 'talks.example.org' })).ok, true)
  assert.deepEqual(domains(), ['other.example.org→talkweaver-live', `talks.example.org→${NAME}`], 'attached when set')
  const put = w.fake.requests.find((request) => request.path === `${script}/domains/records`)
  assert.deepEqual(JSON.parse(put.body.toString()).origins, [{ hostname: 'talks.example.org' }])
  assert.equal((await setUp(w, { shareHostname: 'talks.example.org' })).ok, true)
  assert.ok(!lines(w).some((line) => line.startsWith('DELETE ')), 'kept while still set')
  assert.equal((await setUp(w, { shareHostname: 'new.example.org' })).ok, true)
  assert.deepEqual(domains(), [`new.example.org→${NAME}`, 'other.example.org→talkweaver-live'], 'moved')
  const before = w.fake.requests.length
  const cleared = await setUp(w)
  assert.equal(cleared.ok, true)
  assert.deepEqual(domains(), ['other.example.org→talkweaver-live'], 'removed when cleared; another Worker\'s domain untouched')
  assert.deepEqual(lines(w, before).filter((line) => /domains/.test(line)), [`GET /accounts/${ACCOUNT}/workers/domains?service=${NAME}&environment=production`, `DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId('new.example.org')}`], 'listed, then deleted by id')
  // (The move replaced the old one in the PUT itself; one left over from elsewhere is deleted by id too.)
  w.fake.model.workerDomains.get(ACCOUNT).push({ id: workerDomainId('left.example.org'), hostname: 'left.example.org', service: NAME, environment: 'production' })
  const tidy = w.fake.requests.length
  assert.equal((await setUp(w)).ok, true)
  assert.ok(lines(w, tidy).includes(`DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId('left.example.org')}`))
  assert.deepEqual(domains(), ['other.example.org→talkweaver-live'])
  // The address is the one the API reports, whatever the account's subdomain is.
  const elsewhere = world()
  elsewhere.fake.model.answer = (request) => (request.path === `/accounts/${ACCOUNT}/workers/subdomain` ? { status: 200, body: { success: true, errors: [], messages: [], result: { subdomain: 'ada-lovelace' } } } : null)
  assert.equal((await setUp(elsewhere)).baseUrl, `https://${NAME}.ada-lovelace.workers.dev`, 'the workers.dev address is read from the API\'s answer')
  console.log('PASS 5: the share-link domain is attached when set, moved, and removed when cleared; the workers.dev address comes from the API')
}

{
  // A bundle that does not match its manifest is never uploaded: nothing at all is sent.
  const w = world()
  const flipped = Buffer.from(BUNDLE)
  flipped[10] ^= 1
  const result = await setUp(w, { shipped: { manifest: shipped.manifestText, bundle: flipped, config: shipped.configBytes } })
  assert.deepEqual([result.ok, result.error], [false, INSTALLATION_INCOMPLETE])
  assert.match(result.details, /index\.js does not match its manifest/)
  assert.deepEqual([w.fake.requests.length, w.authorised, w.made, w.saved.length], [0, 0, 0, 0], 'no request, no leave asked for (it could run a check), no keys, nothing saved')
  const none = world()
  assert.equal((await setUp(none, { shipped: { manifest: null, bundle: null, config: null } })).error, INSTALLATION_INCOMPLETE)
  assert.equal(none.fake.requests.length, 0)
  console.log('PASS 6: a bundle that does not match its manifest is "This TalkWeaver installation is incomplete" with Details, and nothing is sent')
}

{
  // Failures, sorted (D12): a sentence, and Details in numbers only.
  const failing = async (answer, over = {}) => {
    const w = world({ stored: over.stored })
    if (over.deployed) w.fake.model.workers.set(ACCOUNT, new Map([[NAME, { uploads: 1, secrets: [], migrationTag: 'v4', module: null, metadata: null, workersDev: true }]]))
    w.fake.model.answer = answer
    return { w, result: await setUp(w, over) }
  }
  const reply = (status, code) => ({ status, body: { success: false, errors: [{ code, message: `refused (${REPLY_TEXT_MARK})` }], messages: [], result: null } })
  const at = (method, tail, answer) => (request) => (request.method === method && request.path === `${script}${tail}` ? answer : null)

  const reader = world()
  const refused = await setUp(reader, { token: READER })
  assert.deepEqual([refused.ok, refused.error, refused.details], [false, LIVE_SETUP_REFUSED, 'Uploading the live service: Cloudflare answered 403 (error 10000).'], 'a token that may only read Workers is refused at the upload')
  const CASES = [
    ['the upload fails', at('PUT', '', reply(400, 10021)), LIVE_SETUP_FAILED, 'Uploading the live service: Cloudflare answered 400 (error 10021).'],
    ['the upload is not answered usably', at('PUT', '', { status: 502, body: 'Bad gateway' }), LIVE_SETUP_FAILED, 'Uploading the live service: Cloudflare answered 502.'],
    ['workers.dev cannot be switched on', at('POST', '/subdomain', reply(500, 10013)), LIVE_SETUP_FAILED, 'Switching on its workers.dev address: Cloudflare answered 500 (error 10013).'],
    ['the keys cannot be set', at('PATCH', '/secrets-bulk', reply(500, 10013)), LIVE_KEYS_FAILED, 'Setting its keys: Cloudflare answered 500 (error 10013).'],
    ['the keys are refused', at('PATCH', '/secrets-bulk', reply(403, 10000)), LIVE_SETUP_REFUSED, 'Setting its keys: Cloudflare answered 403 (error 10000).'],
    ['the account has no workers.dev subdomain', (request) => (request.path.endsWith('/workers/subdomain') && !request.path.includes('/scripts/') ? reply(404, 10007) : null), LIVE_NO_ADDRESS, 'Looking up the account\'s workers.dev address: Cloudflare answered 404 (error 10007).'],
    ['the subdomain reported is not a plain name', (request) => (request.path.endsWith('/workers/subdomain') && !request.path.includes('/scripts/') ? { status: 200, body: { success: true, errors: [], messages: [], result: { subdomain: 'evil.example/x' } } } : null), LIVE_NO_ADDRESS, 'Looking up the account\'s workers.dev address: the subdomain Cloudflare reported is not a plain name.'],
    ['the look-up is refused', (request) => (request.path.includes('/workers/services/') ? reply(403, 10000) : null), LIVE_SETUP_REFUSED, 'Looking up the live service: Cloudflare answered 403 (error 10000).'],
    ['Cloudflare cannot be reached', (request) => (request.path.includes('/workers/services/') ? { throws: new TypeError(`connect failed ${TOKEN} ${REPLY_TEXT_MARK}`) } : null), LIVE_SETUP_FAILED, 'Looking up the live service: Cloudflare could not be reached or did not answer in time.'],
    ['the domain cannot be attached', at('PUT', '/domains/records', reply(409, 100117)), LIVE_SETUP_FAILED, 'Attaching the share-link domain: Cloudflare answered 409 (error 100117).', { shareHostname: 'talks.example.org' }],
  ]
  for (const [what, answer, sentence, details, over] of CASES) {
    const { w, result } = await failing(answer, over)
    assert.deepEqual([result.ok, result.error, result.details], [false, sentence, details], what)
    assert.deepEqual(w.saved, [], `${what}: no address saved`)
  }
  // Nothing is uploaded before the address is known: the reads come first.
  const { w: noAddress } = await failing(CASES[5][1])
  assert.ok(!lines(noAddress).some((line) => !line.startsWith('GET ')), 'with no address nothing was written at Cloudflare')
  // A domain that is already gone is what was wanted.
  const { result: gone } = await failing((request) => (request.method === 'DELETE' ? reply(404, 100117) : null), { stored: KEYS, deployed: true })
  assert.equal(gone.ok, true)
  // A token that may not read domains, with none to attach: nothing of ours it could remove; the set-up goes on.
  const { result: blind } = await failing((request) => (request.path.endsWith('/workers/domains') ? reply(403, 10000) : null), { stored: KEYS, deployed: true })
  assert.equal(blind.ok, true)
  const { result: blindWithDomain } = await failing((request) => (request.path.endsWith('/workers/domains') ? reply(403, 10000) : null), { stored: KEYS, deployed: true, shareHostname: 'talks.example.org' })
  assert.deepEqual([blindWithDomain.error, blindWithDomain.details], [LIVE_SETUP_REFUSED, 'Looking up the live service\'s custom domains: Cloudflare answered 403 (error 10000).'])
  console.log(`PASS 7: ${CASES.length + 1} failures sorted into fixed sentences, with Details in numbers only; nothing written before the address is known`)
}

{
  // The generation changes under a set-up: nothing more is sent, nothing is saved.
  for (const [what, method, tail] of [['during the look-up', 'GET', null], ['during the upload', 'PUT', ''], ['during the keys', 'PATCH', '/secrets-bulk']]) {
    const w = world()
    const granted = leave()
    const inner = w.fetch
    const fetch = async (address, init = {}) => {
      const reply = await inner(address, init)
      const path = new URL(address).pathname.replace(/^\/client\/v4/, '')
      if ((init.method ?? 'GET') === method && (tail === null || path === `${script}${tail}`)) granted.state.current = false
      return reply
    }
    const result = await setUp(w, { leave: granted, fetch })
    assert.deepEqual(result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR }, what)
    assert.deepEqual(w.saved, [], `${what}: nothing saved`)
    const after = w.fake.requests.findIndex((request) => request.method === method && (tail === null || request.path === `${script}${tail}`))
    assert.equal(w.fake.requests.length, after + 1, `${what}: no request after it`)
  }
  console.log('PASS 8: a change of token or account during the look-up, the upload or the keys stops the set-up there; nothing is saved')
}

{
  // No program: the sequence's modules start none and take no launcher; the main process gives none.
  for (const file of ['src/main/live-service-deploy.ts', 'src/main/live-service-upload.ts', 'src/main/cloudflare-connection.ts']) {
    const code = readSource(join(repo, file)).replace(/^\s*\/\/[^\n]*$/gm, '')
    assert.ok(!/from ['"](?:node:)?child_process['"]|wrangler-launcher|runBundledWrangler|\bspawn(?:Sync)?\(|\bexec(?:File)?(?:Sync)?\(/.test(code), `${file} imports no process or launcher module and starts nothing`)
  }
  const main = readSource(join(repo, 'src/main/index.ts'))
  const body = main.slice(main.indexOf('function deployLiveWorker('), main.indexOf('async function startLocalLiveWorker('))
  assert.ok(body.includes('return deployLiveService({') && !/wrangler|spawn|launch/i.test(body.replace(/\/\/[^\n]*/g, '')), 'the main process\'s set-up hands the sequence no launcher')
  assert.ok(/shipped: \(\) => shippedLiveWorker\(\)/.test(body) && /expectedBuild: LIVE_WORKER_VERSION/.test(body))
  console.log('PASS 9: no program is started for a set-up or an update: no launcher reaches the sequence')
}

// ── Fix round 1 (review of ticket 11) ───────────────────────────────────────────────────────────
{
  const workerOf2 = (w) => w.fake.model.workers.get(ACCOUNT)?.get(NAME)
  const deployed = (w, tag = 'v4') => w.fake.model.workers.set(ACCOUNT, new Map([[NAME, { uploads: 1, secrets: ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET'], migrationTag: tag, module: null, metadata: null, workersDev: true }]]))
  const writes = (w, from = 0) => lines(w, from).filter((line) => !line.startsWith('GET '))

  // 1a. A domain id is Cloudflare's shape (32 lowercase hex) or it is not used.
  assert.equal(validDomainId(workerDomainId('talks.example.org')), true)
  for (const odd of [TOKEN, KEYS.adminSecret, 'domain-talks.example.org', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}/`, '', null]) assert.equal(validDomainId(odd), false, `not a domain id: ${String(odd).slice(0, 12)}`)
  // 1b. A list that echoes the token (or a key) as an id: nothing with it is sent, in any address.
  for (const echoed of [TOKEN, KEYS.adminSecret, 'a'.repeat(32).replace(/^a{4}/, '../x')]) {
    const w = world({ stored: KEYS })
    deployed(w)
    w.fake.model.workerDomains.set(ACCOUNT, [{ id: echoed, hostname: 'echo.example.org', service: NAME, environment: 'production' }])
    const result = await setUp(w)
    assert.equal(result.ok, true)
    assert.ok(!lines(w).some((line) => line.startsWith('DELETE ')), 'no DELETE for an id that is not one')
    for (const request of w.fake.requests) for (const secret of SECRETS) assert.ok(!`${request.path}${request.search ?? ''}`.includes(secret))
  }
  // 1c. The one request function refuses an address that holds the token or a key, before anything is sent.
  {
    const sent = []
    const port = { fetch: async (...args) => { sent.push(args); return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} })) }, base: CLOUDFLARE_API_BASE, timeoutMs: 1000, cancelled: new AbortController().signal }
    const cases = [
      ['the token in the path', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/domains/${TOKEN}` }],
      ['the token, encoded, in the query', { method: 'GET', path: `/accounts/${ACCOUNT}/workers/domains?service=${encodeURIComponent(`x ${TOKEN}`)}` }],
      ['a key named as forbidden', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/domains/${KEYS.signingSecret}`, forbidden: [KEYS.adminSecret, KEYS.signingSecret] }],
    ]
    for (const [what, outgoing] of cases) {
      const answer = await send(port, TOKEN, outgoing, () => true)
      assert.deepEqual([answer.kind, answer.http], ['refused', null], `${what}: refused`)
    }
    assert.equal(sent.length, 0, 'and nothing was sent')
    assert.equal((await send(port, TOKEN, { method: 'GET', path: `/accounts/${ACCOUNT}/workers/subdomain`, forbidden: [KEYS.adminSecret] }, () => true)).kind, 'ok', 'an ordinary address is sent')
    assert.equal(sent.length, 1)
  }
  console.log('PASS 11 (fix 1): a domain id is 32 lowercase hex or unused; no request whose address holds the token or a key is sent')

  // 2. Only the production environment's domains are ours to remove: a staging domain of the same Worker survives.
  {
    const w = world({ stored: KEYS })
    deployed(w)
    w.fake.model.workerDomains.set(ACCOUNT, [
      { id: workerDomainId('old.example.org'), hostname: 'old.example.org', service: NAME, environment: 'production' },
      { id: workerDomainId('staging.example.org'), hostname: 'staging.example.org', service: NAME, environment: 'staging' },
      { id: workerDomainId('unsaid.example.org'), hostname: 'unsaid.example.org', service: NAME },
    ])
    assert.equal((await setUp(w)).ok, true)
    assert.ok(lines(w).includes(`GET /accounts/${ACCOUNT}/workers/domains?service=${NAME}&environment=production`), 'the lookup asks for production')
    assert.deepEqual(writes(w).filter((line) => line.startsWith('DELETE ')), [`DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId('old.example.org')}`], 'only the production domain is removed')
    assert.deepEqual(w.fake.model.workerDomains.get(ACCOUNT).map((domain) => domain.hostname).sort(), ['staging.example.org', 'unsaid.example.org'], 'the staging domain (and one whose environment is not said) survive')
  }
  {
    // An answer that ignores the filter (lists every environment): the app's own selection keeps staging.
    const w = world({ stored: KEYS })
    deployed(w)
    const everything = [
      { id: workerDomainId('old.example.org'), hostname: 'old.example.org', service: NAME, environment: 'production' },
      { id: workerDomainId('staging.example.org'), hostname: 'staging.example.org', service: NAME, environment: 'staging' },
      { id: workerDomainId('unsaid.example.org'), hostname: 'unsaid.example.org', service: NAME },
    ]
    w.fake.model.workerDomains.set(ACCOUNT, everything.map((domain) => ({ ...domain })))
    w.fake.model.answer = (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: everything } } : null)
    assert.equal((await setUp(w)).ok, true)
    assert.deepEqual(writes(w).filter((line) => line.startsWith('DELETE ')), [`DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId('old.example.org')}`], 'unfiltered list: still only production is removed')
  }
  console.log('PASS 12 (fix 2): clearing the share-link domain removes production\'s only; a staging domain survives')

  // 3. A refused domain lookup with no domain set: allowed only when no share-link domain was ever attached from here.
  {
    const deniedList = (request) => (request.path.endsWith('/workers/domains') ? { status: 403, body: { success: false, errors: [{ code: 10000, message: REPLY_TEXT_MARK }], messages: [], result: null } } : null)
    const before = world({ stored: KEYS })
    deployed(before)
    before.fake.model.answer = deniedList
    before.record = 'old.example.org'
    const stopped = await setUp(before)
    assert.deepEqual([stopped.ok, stopped.error, stopped.details], [false, LIVE_SETUP_REFUSED, 'Looking up the live service\'s custom domains: Cloudflare answered 403 (error 10000).'], 'one was attached before: it may still be there, so the set-up stops')
    assert.deepEqual([writes(before), before.saved], [[], []])
    const never = world({ stored: KEYS })
    deployed(never)
    never.fake.model.answer = deniedList
    assert.equal((await setUp(never)).ok, true, 'none ever attached: nothing of ours to remove')
  }
  // Round 2: the record is written BEFORE the attach is sent and kept through a failure after it.
  {
    const w = world({ stored: KEYS })
    deployed(w)
    w.fake.model.answer = (request) => (request.method === 'PATCH' ? { status: 500, body: { success: false, errors: [{ code: 10013, message: REPLY_TEXT_MARK }], messages: [], result: null } } : null)
    const broken = await setUp(w, { shareHostname: 'talks.example.org' })
    assert.deepEqual([broken.ok, broken.error], [false, LIVE_KEYS_FAILED], 'attached, then the keys fail')
    assert.ok(w.fake.model.workerDomains.get(ACCOUNT).some((domain) => domain.hostname === 'talks.example.org'), 'the domain is attached at Cloudflare')
    assert.equal(w.record, 'talks.example.org', 'and the record says so, although the set-up failed')
    // The domain is cleared in Settings; the retry's domain lookup is refused.
    w.fake.model.answer = (request) => (request.path.endsWith('/workers/domains') ? { status: 403, body: { success: false, errors: [{ code: 10000, message: REPLY_TEXT_MARK }], messages: [], result: null } } : null)
    const retry = await setUp(w)
    assert.deepEqual([retry.ok, retry.error, retry.details], [false, LIVE_SETUP_REFUSED, 'Looking up the live service\'s custom domains: Cloudflare answered 403 (error 10000).'], 'the retry stops with the sorted refusal')
    assert.deepEqual([w.saved, w.record], [[], 'talks.example.org'], 'no success, and the record is kept')
    // Cloudflare answers again: the domain is removed, and only then is the record cleared.
    w.fake.model.answer = null
    const cleared = await setUp(w)
    assert.equal(cleared.ok, true)
    assert.ok(!w.fake.model.workerDomains.get(ACCOUNT).some((domain) => domain.service === NAME), 'removed at Cloudflare')
    assert.equal(w.record, '', 'a verified removal clears the record')
    // A lookup that shows none of ours also clears it; a failed removal keeps it.
    const none = world({ stored: KEYS, record: 'gone.example.org' })
    deployed(none)
    assert.equal((await setUp(none)).ok, true)
    assert.equal(none.record, '', 'a lookup showing none of ours clears it')
    const stuck = world({ stored: KEYS })
    deployed(stuck)
    stuck.fake.model.workerDomains.set(ACCOUNT, [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org', service: NAME, environment: 'production' }])
    stuck.record = 'old.example.org'
    stuck.fake.model.answer = (request) => (request.method === 'DELETE' ? { status: 500, body: { success: false, errors: [{ code: 10013, message: REPLY_TEXT_MARK }], messages: [], result: null } } : null)
    assert.equal((await setUp(stuck)).ok, false)
    assert.equal(stuck.record, 'old.example.org', 'a removal that failed keeps the record')
  }
  console.log('PASS 13 (fix 3): a refused domain lookup stops the set-up while the record says a share-link domain may be attached; the record is written before the attach and cleared only after a verified removal')

  // 4. A Worker at a migration tag this build does not know (set up by a newer TalkWeaver): stop, send nothing.
  {
    const w = world({ stored: KEYS })
    deployed(w, 'v5')
    const result = await setUp(w)
    assert.deepEqual([result.ok, result.error], [false, LIVE_NEWER_SERVICE])
    assert.match(result.details, /migration tag v5/, 'Details name the tag')
    assert.deepEqual([writes(w), w.saved, workerOf2(w).migrationTag], [[], [], 'v5'], 'nothing sent, nothing saved')
    const odd = world({ stored: KEYS })
    deployed(odd, 'v5\u001b[31m<script>')
    const shown = await setUp(odd)
    assert.equal(shown.error, LIVE_NEWER_SERVICE)
    assert.ok(!/[\u0000-\u001f<]/.test(shown.details), 'a tag that is not plain is not repeated as it came')
    assert.throws(() => planLiveServiceUpload({ ...verifyShippedBundle(shipped.manifestText, { bundle: shipped.bundle, config: shipped.configBytes }, BUILD), accountId: ACCOUNT, deployedMigrationTag: 'v5', shareHostname: null, attachedDomains: [] }), UnknownMigrationTagError)
  }
  console.log('PASS 14 (fix 4): a Worker set up by a newer TalkWeaver stops the set-up with Details naming the tag; nothing is sent')

  // 5. A manifest that is JSON but not an object: the installation is incomplete, nothing throws.
  for (const text of ['null', '[]', '7', '"text"', 'true']) {
    const files = { 'manifest.json': Buffer.from(text), 'index.js': BUNDLE, 'upload-config.json': shipped.configBytes }
    const read = readShippedFiles((name) => files[name] ?? null)
    const result = verifyShippedBundle(read.manifest, { bundle: read.bundle, config: read.config }, BUILD)
    assert.deepEqual([result.ok, result.error], [false, INSTALLATION_INCOMPLETE], `manifest ${text}`)
    const w = world()
    const set = await setUp(w, { shipped: read })
    assert.deepEqual([set.ok, set.error, w.fake.requests.length], [false, INSTALLATION_INCOMPLETE, 0])
  }
  const mainSource = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(/function shippedLiveWorker\(\)[\s\S]{0,400}readShippedFiles\(/.test(mainSource), 'the main process reads the shipped files through readShippedFiles')
  console.log('PASS 15 (fix 5): a manifest of null, an array, a number, a string or true is an incomplete installation, not a crash')
}

// ── Nothing secret anywhere ─────────────────────────────────────────────────────────────────────
{
  const seen = JSON.stringify(observed)
  for (const secret of SECRETS) assert.ok(!seen.includes(secret), 'no token or key in any result or Details')
  assert.ok(!seen.includes(REPLY_TEXT_MARK), 'and no text of a Cloudflare reply')
  // Every request of every world above: the token only in its header, the keys only in the keys' body.
  const requests = worlds.flatMap((fake) => fake.requests)
  assert.ok(requests.length > 100, `plenty of requests looked at (${requests.length})`)
  const keys = SECRETS.filter((secret) => secret !== TOKEN && secret !== READER)
  for (const request of requests) {
    const address = `${request.path}${request.search ?? ''}`
    for (const secret of SECRETS) assert.ok(!address.includes(secret), 'no secret in a request address')
    const { authorization, ...others } = request.headers ?? {}
    assert.ok(authorization === `Bearer ${TOKEN}` || authorization === `Bearer ${READER}`, 'every request carries the token in its header')
    for (const secret of SECRETS) assert.ok(!JSON.stringify(others).includes(secret), 'and no secret in any other header')
    const body = request.body.toString('latin1')
    for (const token of [TOKEN, READER]) assert.ok(!body.includes(token), 'the token is in no body')
    if (!(request.method === 'PATCH' && request.path.endsWith('/secrets-bulk'))) for (const key of keys) assert.ok(!body.includes(key), `a key is only ever in the keys' body (${request.method} ${request.path})`)
  }
  console.log(`PASS 10: no token, key or reply text in any result or Details; across ${requests.length} requests the token is only in its header and the keys only in the keys' body`)
}
process.stdout.write = write
process.stderr.write = writeErr
const output = printed.join('')
for (const secret of SECRETS) assert.ok(!output.includes(secret), 'no secret value in this test\'s output')
console.log(`live service upload: the shipped bundle checked, the plan, the sequence against the fake API, no program started, no secret printed — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
