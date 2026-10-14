// The live service is uploaded without wrangler (ticket 11; spec "Cloudflare set-up in the app",
// D2, D9, D12). The seams:
//   1. verifyShippedBundle (pure): the shipped files against their manifest;
//   2. migrationsToApply and planLiveServiceUpload (pure): the requests and their bodies, with no network;
//   3. deployLiveService, the request sequence, against the fake Cloudflare API's model
//      (scripts/lib/cloudflare-api-stub.mjs, no network at all) and a stand-in for the live service
//      (scripts/lib/live-worker-double.mjs);
//   4. changeShareAddress (live-service-share-domain.ts), the one action that attaches or removes a
//      custom domain, against the same model.
// The model is the one decided after the review of ticket 02 (spec, R1 to R8); the keys themselves
// are tested in scripts/test-live-service-keys.mjs.
// Invariants stated here and checked below:
//   - no program is started for a set-up or an update: the sequence's modules import no process or
//     launcher module, and the main process's set-up hands it no launcher (the ambient-access trace,
//     scripts/test-wrangler-ambient-trace.mjs, proves the same of a real run);
//   - the bytes uploaded are the shipped bundle, checked against the manifest's SHA-256 BEFORE any
//     request; a mismatch is "This TalkWeaver installation is incomplete" with Details, nothing sent;
//   - first set-up applies every migration; an update only those after the deployed tag; an update
//     with nothing new sends none;
//   - a code upload is exactly two requests, the script and its workers.dev switch, and inherits the
//     bindings Cloudflare holds; set-up's only secrets request names this computer's key; no request
//     names a signing secret or lists the Worker's secrets (R1);
//   - the stored key is reused on every update, and no secret value is in a request address, any
//     header but the token's own, a result, Details, or this test's output;
//   - nothing is bound as plain text under an admin key's name (`ADMIN_SECRET`, `ADMIN_SECRET_<id>`):
//     the Worker trusts any string under those names (worker/admin-keys.ts), so the shipped settings
//     declare no `vars`, the upload binds Durable Object namespaces only, and keys go as `secret_text`;
//   - the workers.dev address is read from the API's answer;
//   - set-up and a code update touch no custom domain (R2). The share-address action attaches ONE
//     hostname with no override set, so one attached elsewhere is refused and nothing is displaced;
//     clearing detaches only the hostname this computer's config records; a lookup or removal that
//     failed leaves that record as it was.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as uploadModule from '../src/main/live-service-upload.ts'
import {
  INSTALLATION_INCOMPLETE, UnknownMigrationTagError, migrationsToApply, planLiveServiceUpload, readShippedFiles, addKeyBody, addKeyRequest, validDomainId, verifyShippedBundle, workersDevAddress,
} from '../src/main/live-service-upload.ts'
import {
  LIVE_KEYS_FAILED, LIVE_KEY_NOT_ADDED, LIVE_NEWER_SERVICE, LIVE_NO_ADDRESS, LIVE_OVERWRITTEN, LIVE_SETUP_FAILED, LIVE_SETUP_REFUSED, LIVE_UPDATE_PENDING, deployLiveService,
} from '../src/main/live-service-deploy.ts'
import { SHARE_DOMAIN_ATTACHED_NOT_SAVED, SHARE_DOMAIN_IN_USE, SHARE_DOMAIN_LOOKUP_INCOMPLETE as LOOKUP_INCOMPLETE, SHARE_DOMAIN_NOT_ATTACHED, SHARE_DOMAIN_NOT_REMOVED, SHARE_DOMAIN_OLD_NOT_REMOVED, SHARE_DOMAIN_REMOVED_NOT_SAVED, changeShareAddress, shareDomainEntries, shareLinkBase } from '../src/main/live-service-share-domain.ts'
import { stripJsonComments } from '../src/main/live-worker-deploy-config.ts'
import { computerIdForSecretName } from '../worker/admin-keys.ts'
import { CLOUDFLARE_API_BASE, DEPLOY_SUPERSEDED_ERROR, TOKEN_REMOVED, send } from '../src/main/cloudflare-connection.ts'
import { instantClock, keyProfile, liveWorkerDouble } from './lib/live-worker-double.mjs'
import { REPLY_TEXT_MARK, WORKERS_SUBDOMAIN, createFakeCloudflare, fakeCloudflareFetch, workerDomainId } from './lib/cloudflare-api-stub.mjs'
import { workerDistFiles } from './lib/worker-dist.mjs'
import { readSource } from './lib/read-source.mjs'
import { sharedTalkLink } from '../src/shared/shared-talk.ts'
import { runResultsLink } from '../src/shared/run-results-share.ts'

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
// What 0.38.2 stored on its computer and set at Cloudflare: `ADMIN_SECRET` and a signing secret.
const LEGACY = { adminSecret: ['made-up-admin', 'secret', 'abcdef0123456789'].join('-'), signingSecret: ['made-up-signing', 'secret', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
/** The token, the 0.38.2 values and (added at the end) every key a computer of this test made. */
const SECRETS = [TOKEN, READER, LEGACY.adminSecret, LEGACY.signingSecret]
const OLDER = '20-before-computer-keys'
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

// What may be bound to the Worker (worker/admin-keys.ts, "Whose word this is"). The name check is the
// Worker's own (`computerIdForSecretName`), not a copy of its pattern.
/** Every place a settings object declares `vars`, at any depth (so also under an `env` section). */
function varsDeclared(value, at = '') {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([name, inner]) => (name === 'vars' ? [`${at}${name}`] : varsDeclared(inner, `${at}${name}.`)))
}
/** What is wrong with an upload's metadata: a binding that is not a Durable Object namespace, or one of any type under an admin key's name. */
function bindingProblems(metadata) {
  const problems = []
  if (!Array.isArray(metadata?.bindings) || metadata.bindings.length === 0) problems.push('no bindings list')
  for (const binding of metadata?.bindings ?? []) {
    if (binding.type !== 'durable_object_namespace') problems.push(`${binding.name} is bound as ${binding.type}`)
    if (computerIdForSecretName(String(binding.name)) !== null) problems.push(`a binding has an admin key's name (${binding.type})`)
  }
  if (varsDeclared(metadata).length > 0) problems.push('the metadata declares vars')
  return problems
}
/** What is wrong with a secrets body: an entry that is not `secret_text`, or filed under another name than its own. */
function secretsProblems(body) {
  const entries = Object.entries(body?.secrets ?? {})
  const problems = entries.length === 0 ? ['no secrets'] : []
  for (const [name, entry] of entries) {
    if (entry?.type !== 'secret_text') problems.push(`${name} is sent as ${entry?.type}`)
    if (entry?.name !== name) problems.push(`${name} is filed under another name`)
  }
  return problems
}

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
  const plan = (over = {}) => planLiveServiceUpload({ config, manifest, bundle, accountId: ACCOUNT, deployedMigrationTag: null, ...over })
  const script = `/accounts/${ACCOUNT}/workers/scripts/${NAME}`

  // First set-up: the metadata wrangler 4.144 sends for this Worker (captured from its `deploy` against the fake API).
  const first = plan()
  assert.deepEqual(first.map((request) => `${request.step} ${request.method} ${request.path}`), [
    `upload PUT ${script}?excludeScript=true&bindings_inherit=strict`,
    `workers-dev POST ${script}/subdomain`,
  ], 'the code upload is two requests: no secrets step (the secrets at Cloudflare are inherited as they are), no domain, no route')
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
  const add = addKeyRequest(ACCOUNT, NAME, 'macb')
  assert.deepEqual([add.step, add.method, add.path, add.body.kind, [...add.body.names], add.body.contentType], ['add-key', 'PATCH', `${script}/secrets-bulk`, 'secrets', ['ADMIN_SECRET_macb'], 'application/merge-patch+json'], 'adding a key is its own request, naming one secret; it holds no value')
  assert.ok(!JSON.stringify(first, (key, value) => (value instanceof Uint8Array ? `<${value.length} bytes>` : value)).includes('"text"'))

  // Nothing is bound as plain text, least of all under an admin key's name.
  {
    // The checks can fail: the Worker's own name check knows an admin key's name, and each kind of fault is named.
    assert.deepEqual([computerIdForSecretName('ADMIN_SECRET'), computerIdForSecretName('ADMIN_SECRET_macb'), computerIdForSecretName('LIVE_SESSIONS'), computerIdForSecretName('SESSION_SIGNING_SECRET')], ['legacy', 'macb', null, null])
    assert.deepEqual(bindingProblems({ bindings: [{ name: 'ADMIN_SECRET_macb', type: 'plain_text', text: 'x' }] }), ['ADMIN_SECRET_macb is bound as plain_text', 'a binding has an admin key\'s name (plain_text)'])
    assert.deepEqual(bindingProblems({ bindings: [{ name: 'ADMIN_SECRET', type: 'durable_object_namespace', class_name: 'X' }] }), ['a binding has an admin key\'s name (durable_object_namespace)'])
    assert.deepEqual(bindingProblems({ bindings: [{ name: 'OTHER', type: 'json', json: 1 }], vars: {} }), ['OTHER is bound as json', 'the metadata declares vars'])
    assert.deepEqual(varsDeclared({ env: { staging: { vars: { ADMIN_SECRET: 'x' } } } }), ['env.staging.vars'])
    assert.deepEqual(secretsProblems({ secrets: { ADMIN_SECRET: { name: 'ADMIN_SECRET', text: 'a', type: 'plain_text' } } }), ['ADMIN_SECRET is sent as plain_text'])

    // The shipped settings, source and built: no `vars` anywhere, and no binding under an admin key's name.
    const source = JSON.parse(stripJsonComments(readFileSync(join(repo, 'worker', 'wrangler.jsonc'), 'utf8')))
    const settings = [['worker/wrangler.jsonc', source], ['upload-config.json as built from it', JSON.parse(shipped.configBytes.toString('utf8'))]]
    const builtPath = join(repo, 'worker-dist', 'upload-config.json')
    if (existsSync(builtPath)) settings.push(['worker-dist/upload-config.json', JSON.parse(readFileSync(builtPath, 'utf8'))])
    for (const [what, value] of settings) {
      assert.deepEqual(varsDeclared(value), [], `${what} declares no vars`)
      assert.ok(value.durable_objects.bindings.length > 0, `${what} names its Durable Objects`)
      for (const binding of value.durable_objects.bindings) assert.equal(computerIdForSecretName(binding.name), null, `${what}: no Durable Object is bound under an admin key's name`)
    }
    assert.deepEqual(Object.keys(config).filter((name) => /var|secret|binding|kv|r2|d1|queue|service/i.test(name)), [], 'the settings the plan reads hold nothing else that could be bound')

    // Every upload the plan can make: first set-up and updates. A share address handed to it changes
    // nothing: the plan has no domain step to give (R2).
    const plans = [first, plan({ deployedMigrationTag: 'v4' }), plan({ deployedMigrationTag: 'v2' }), plan({ shareHostname: 'talks.example.org' }),
      plan({ shareHostname: 'new.example.org', attachedDomains: [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org' }] }),
      plan({ attachedDomains: [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org' }] })]
    for (const requests of plans) {
      assert.deepEqual(requests.map((request) => `${request.step} ${request.method} ${request.path}`), first.map((request) => `${request.step} ${request.method} ${request.path}`), 'exactly the script and its workers.dev switch')
      assert.ok(!/\/domains|\/routes|\/zones|override|example\.org/.test(JSON.stringify(requests, (key, value) => (value instanceof Uint8Array ? null : value))), 'no domain or route is named')
      const uploads = requests.filter((request) => request.step === 'upload')
      assert.equal(uploads.length, 1)
      assert.deepEqual(bindingProblems(uploads[0].body.metadata), [], 'the upload binds Durable Object namespaces only, none under an admin key\'s name')
      assert.deepEqual(uploads[0].body.metadata.bindings.map((binding) => binding.type), Array(5).fill('durable_object_namespace'))
      // Admin keys travel in the secrets step and nowhere else in the plan.
      const naming = requests.filter((request) => JSON.stringify(request, (key, value) => (value instanceof Uint8Array ? null : value)).includes('ADMIN_SECRET'))
      assert.deepEqual(naming.map((request) => request.step), [], 'no request of an upload names an admin key')
    }
    // The one secrets request of a set-up sends its one name as `secret_text` only.
    const sent = JSON.parse(addKeyBody('macb', 'a'))
    assert.deepEqual(secretsProblems(sent), [])
    assert.deepEqual(Object.keys(sent.secrets), [...addKeyRequest(ACCOUNT, NAME, 'macb').body.names], 'exactly the name the request lists')
    assert.ok(!('firstSecretsBody' in uploadModule) && !('firstSecretsRequest' in uploadModule) && !Object.keys(uploadModule).some((name) => /signing/i.test(name)), 'nothing in the module can make a request naming a signing secret')
    assert.deepEqual([...new Set(Object.values(sent.secrets).map((entry) => entry.type))], ['secret_text'])
    assert.ok(Object.keys(sent.secrets).some((name) => computerIdForSecretName(name) !== null), 'an admin key is among them (the check above has something to look at)')
  }

  // Updates.
  assert.ok(!('migrations' in plan({ deployedMigrationTag: 'v4' })[0].body.metadata), 'an update with nothing new sends no migrations')
  assert.deepEqual(plan({ deployedMigrationTag: 'v3' })[0].body.metadata.migrations, { old_tag: 'v3', new_tag: 'v4', steps: [{ new_sqlite_classes: ['RunPrework'] }] }, 'an update sends only those after the deployed tag')

  // The secrets body, as wrangler's putBulkSecrets sends it (made only when the request is sent).
  assert.deepEqual(JSON.parse(addKeyBody('macb', 'a')), { secrets: { ADMIN_SECRET_macb: { name: 'ADMIN_SECRET_macb', text: 'a', type: 'secret_text' } } })
  // The address, only from a plain subdomain.
  assert.equal(workersDevAddress(NAME, 'stand-in'), ADDRESS)
  for (const odd of ['', 'a.b', 'evil.example/x', 'UPPER', '-x', null, 7, 'x'.repeat(64)]) assert.equal(workersDevAddress(NAME, odd), null, `no address from ${JSON.stringify(odd)}`)
  console.log('PASS 2: the plan: wrangler 4.144\'s metadata; all migrations first, only the newer ones on update, none when nothing is new; workers.dev on; two requests whatever is asked, with no domain or route; one secret by name only; no vars in the shipped settings, Durable Object bindings only, none under an admin key\'s name, keys as secret_text')
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
/** One computer and one Cloudflare account. `legacy`: a 0.38.2 computer, whose stored blob holds `ADMIN_SECRET` (and a signing value this build drops). */
function world(options = {}) {
  const fake = createFakeCloudflare({ tokens: { [TOKEN]: { accounts: [ACCOUNT] }, [READER]: { accounts: [ACCOUNT], workers: 'read' } }, accounts: [{ id: ACCOUNT, name: 'Ada' }], ...options.fake })
  const profile = options.legacy
    ? keyProfile({ text: JSON.stringify(LEGACY), config: { liveWorkerAccountId: ACCOUNT, liveWorkerBaseUrl: ADDRESS } })
    : keyProfile()
  // As the main process does when it makes the store: a 0.38.2 blob is rewritten in this build's form.
  profile.store.migrate()
  const w = { fake, fetch: fakeCloudflareFetch(fake), live: liveWorkerDouble(fake, { account: ACCOUNT, name: NAME, address: null, build: BUILD }), profile, saved: [], authorised: 0, setUps: [] }
  worlds.push(w)
  return w
}
/** The Worker as 0.38.2 left it at Cloudflare, answering as this build unless said. */
const deployed = (w, tag = 'v4') => w.fake.model.workers.set(ACCOUNT, new Map([[NAME, { uploads: 1, secrets: ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET'], values: new Map([['ADMIN_SECRET', LEGACY.adminSecret], ['SESSION_SIGNING_SECRET', LEGACY.signingSecret]]), migrationTag: tag, module: null, metadata: null, workersDev: true }]]))
/** The deployed code answers as an older build until one more upload has been taken. */
const older = (w) => { const now = workerOf(w).uploads; w.live.state.build = (worker) => (worker.uploads > now ? BUILD : OLDER) }
async function setUp(w, over = {}) {
  const granted = over.leave ?? leave(over.token)
  const from = w.fake.requests.length
  const result = await deployLiveService({
    shipped: () => over.shipped ?? { manifest: shipped.manifestText, bundle: shipped.bundle, config: shipped.configBytes },
    expectedBuild: BUILD,
    authorise: async () => { w.authorised += 1; return { ok: true, authorisation: granted.authorisation } },
    keys: w.profile.store,
    computerName: () => 'Test computer',
    liveFetch: w.live.fetch,
    live: instantClock().live,
    fetch: over.fetch ?? w.fetch,
    apiBase: () => 'http://127.0.0.1:9/client/v4',
    // As the main process: the address and account go to config.json.
    save: ({ baseUrl, accountId }) => { w.saved.push({ baseUrl, accountId }); Object.assign(w.profile.config, { liveWorkerBaseUrl: baseUrl, liveWorkerAccountId: accountId }) },
    timeoutMs: { upload: 2000, request: 2000 },
  })
  // What this set-up sent, kept apart from what a share-address action sends in the same world.
  w.setUps.push(...w.fake.requests.slice(from))
  return see(result)
}
const lines = (w, from = 0) => w.fake.requests.slice(from).map((request) => `${request.method} ${request.path}${request.search ?? ''}`)
const writes = (w, from = 0) => lines(w, from).filter((line) => !line.startsWith('GET '))
const workerOf = (w) => w.fake.model.workers.get(ACCOUNT)?.get(NAME)
const uploadOf = (w, from = 0) => w.fake.requests.slice(from).find((request) => request.method === 'PUT' && request.path === `/accounts/${ACCOUNT}/workers/scripts/${NAME}`)
const ownKey = (w) => w.profile.entries().find((entry) => entry.kind === 'own')
const script = `/accounts/${ACCOUNT}/workers/scripts/${NAME}`
const PUT_SCRIPT = `PUT ${script}?excludeScript=true&bindings_inherit=strict`
const reply = (status, code) => ({ status, body: { success: false, errors: [{ code, message: `refused (${REPLY_TEXT_MARK})` }], messages: [], result: null } })

{
  // First set-up: all migrations, this computer's key, the address from the API's answer.
  const w = world()
  const first = await setUp(w)
  const mine = ownKey(w)
  assert.deepEqual(first, { ok: true, baseUrl: ADDRESS, adminSecret: mine.key, others: 0, created: true })
  assert.deepEqual(lines(w), [
    `GET /accounts/${ACCOUNT}/workers/services/${NAME}`,
    `GET /accounts/${ACCOUNT}/workers/subdomain`,
    PUT_SCRIPT,
    `POST ${script}/subdomain`,
    `PATCH ${script}/secrets-bulk`,
  ], 'first set-up: look up, read the address, upload, workers.dev on, this computer\'s key; the Worker\'s secrets are never listed')
  assert.deepEqual([w.profile.entries().length, w.profile.slot.writes.length, w.saved], [1, 1, [{ baseUrl: ADDRESS, accountId: ACCOUNT }]], 'one key made and stored once; the address kept with its account')
  const upload = uploadOf(w)
  const module = upload.parts.find((part) => part.name === 'index.js')
  assert.deepEqual([module.filename, module.type, hex(module.bytes)], ['index.js', 'application/javascript+module', shipped.manifest.files['index.js'].sha256], 'the uploaded bytes are the shipped bundle, by the manifest\'s hash')
  assert.ok(module.bytes.equals(BUNDLE))
  assert.equal(upload.parts.find((part) => part.name === 'metadata').filename, null, 'the metadata is a plain field, as wrangler sends it')
  assert.deepEqual(upload.parts.map((part) => part.name).sort(), ['index.js', 'metadata'], 'two parts: the metadata and the module')
  assert.deepEqual(workerOf(w).metadata.migrations, { new_tag: 'v4', steps: MIGRATIONS.map(({ tag: _tag, ...rest }) => rest) }, 'every Durable Object migration')
  assert.deepEqual([workerOf(w).migrationTag, workerOf(w).workersDev, workerOf(w).secrets], ['v4', true, [`ADMIN_SECRET_${mine.computerId}`]], 'the one secret at Cloudflare is this computer\'s key: no ADMIN_SECRET, no signing secret')
  const patch = w.fake.requests.find((request) => request.method === 'PATCH')
  assert.equal(patch.contentType, 'application/merge-patch+json')
  assert.deepEqual(JSON.parse(patch.body.toString()), { secrets: { [`ADMIN_SECRET_${mine.computerId}`]: { name: `ADMIN_SECRET_${mine.computerId}`, text: mine.key, type: 'secret_text' } } }, 'first set-up\'s one secrets request: this computer\'s key and nothing else')
  assert.equal(w.fake.requests.find((request) => request.method === 'POST').headers['cloudflare-workers-script-api-date'], '2025-08-01')

  // A press with the same build deployed: the two reads, and nothing written.
  let before = w.fake.requests.length
  const again = await setUp(w)
  assert.deepEqual([again.ok, again.adminSecret === mine.key, again.created, w.profile.slot.writes.length], [true, true, false, 1], 'the stored key is used; none is made')
  assert.deepEqual(lines(w, before), [`GET /accounts/${ACCOUNT}/workers/services/${NAME}`, `GET /accounts/${ACCOUNT}/workers/subdomain`], 'the same build: nothing is uploaded and nothing re-sent')

  // A code update (the deployed code answers as an older build): the script and its workers.dev switch, and nothing else.
  older(w)
  before = w.fake.requests.length
  const updated = await setUp(w)
  assert.deepEqual([updated.ok, updated.adminSecret === mine.key, w.profile.slot.writes.length], [true, true, 1], 'an update reuses the stored key and makes none')
  assert.deepEqual(lines(w, before), [
    `GET /accounts/${ACCOUNT}/workers/services/${NAME}`,
    `GET /accounts/${ACCOUNT}/workers/subdomain`,
    PUT_SCRIPT,
    `POST ${script}/subdomain`,
  ], 'a code update is exactly two writes: no secrets step, no domain looked at')
  assert.ok(!('migrations' in workerOf(w).metadata), 'an update with nothing new sends no migration')
  assert.deepEqual(workerOf(w).secrets, [`ADMIN_SECRET_${mine.computerId}`], 'bindings_inherit: the secret at Cloudflare is as it was')

  // An update from a Worker deployed at v2: only v3 and v4.
  workerOf(w).migrationTag = 'v2'
  older(w)
  const fromV2 = await setUp(w)
  assert.equal(fromV2.ok, true)
  assert.deepEqual(workerOf(w).metadata.migrations, { old_tag: 'v2', new_tag: 'v4', steps: [{ new_sqlite_classes: ['RunShare'] }, { new_sqlite_classes: ['RunPrework'] }] }, 'only those after the deployed tag')
  assert.equal(workerOf(w).migrationTag, 'v4')
  console.log('PASS 3: first set-up applies every migration and sends one secret, this computer\'s key; the same build sends nothing; an update is the script and its workers.dev switch, with only the newer migrations, or none; the uploaded bytes are the shipped bundle')
}

{
  // A 0.38.2 computer and the Worker it deployed: its key is used as it is, never replaced or re-sent.
  const w = world({ legacy: true })
  deployed(w)
  const result = await setUp(w)
  assert.deepEqual([result.ok, result.adminSecret === LEGACY.adminSecret, w.profile.entries().map((entry) => entry.kind)], [true, true, ['legacy']])
  assert.deepEqual(writes(w), [], 'the 0.38.2 key is accepted as it is: nothing is sent, changed or re-sent')
  // The same computer, a code update: two writes, and the secrets at Cloudflare exactly as 0.38.2 left them.
  older(w)
  const updated = await setUp(w)
  assert.deepEqual([updated.ok, updated.adminSecret === LEGACY.adminSecret, writes(w), workerOf(w).secrets.sort(), workerOf(w).values.get('SESSION_SIGNING_SECRET') === LEGACY.signingSecret], [true, true, [PUT_SCRIPT, `POST ${script}/subdomain`], ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET'], true])

  // A Worker is deployed and this computer has no key: it adds its own, and names no other secret.
  const second = world()
  deployed(second)
  const joined = await setUp(second)
  const mine = ownKey(second)
  assert.deepEqual([joined.ok, joined.adminSecret === mine.key, joined.created, second.profile.entries().length], [true, true, false, 1])
  const sentBySecond = second.fake.requests.filter((request) => request.method !== 'GET')
  assert.deepEqual(sentBySecond.map((request) => `${request.method} ${request.path}`), [`PATCH ${script}/secrets-bulk`], 'one write: no upload, no domain change')
  assert.deepEqual(Object.keys(JSON.parse(sentBySecond[0].body.toString()).secrets), [`ADMIN_SECRET_${mine.computerId}`], 'naming this computer\'s secret and no other')
  assert.deepEqual(workerOf(second).secrets.sort(), ['ADMIN_SECRET', `ADMIN_SECRET_${mine.computerId}`, 'SESSION_SIGNING_SECRET'], 'the first computer\'s key and the signing secret are still there')
  console.log('PASS 4: a 0.38.2 key is used as it is and nothing is re-sent, also across a code update; a second computer adds its own key in one request naming one secret')
}

{
  // R10. After its upload the sequence reads the build back; there is no second upload, whatever answers.
  // `after`: what the live service answers as once this computer's key was accepted (the read-back comes after that).
  const BETWEEN = '21-another-computers-older-app'
  assert.ok(Number.parseInt(OLDER, 10) < Number.parseInt(BETWEEN, 10) && Number.parseInt(BETWEEN, 10) < Number.parseInt(BUILD, 10))
  const updated = async (after) => {
    const w = world({ legacy: true })
    deployed(w)
    const before = workerOf(w).uploads
    let accepted = false
    let readsBack = 0
    w.live.state.build = (worker) => (worker.uploads === before ? OLDER : accepted ? after : BUILD)
    const reach = w.live.fetch
    w.live.fetch = async (input, init) => {
      const route = new URL(String(input)).pathname
      if (route === '/capabilities' && accepted) readsBack += 1
      const answer = await reach(input, init)
      if (route === '/computers' && answer.status === 200) accepted = true
      return answer
    }
    const result = await setUp(w)
    return { w, result, readsBack, uploads: writes(w).filter((line) => line === PUT_SCRIPT).length }
  }
  const fine = await updated(BUILD)
  assert.deepEqual([fine.result.ok, fine.result.pending, fine.uploads, fine.readsBack, fine.w.saved.length], [true, undefined, 1, 1, 1], 'this app\'s build answers: the build IS read back after the upload, once')
  // Another lower build than the one uploaded over: another computer's older TalkWeaver landed over this upload.
  const over = await updated(BETWEEN)
  assert.deepEqual([over.result.ok, over.result.error, over.result.details, over.uploads, over.w.saved], [false, LIVE_OVERWRITTEN, `This TalkWeaver uploaded build ${BUILD}; the live service now answers as build ${BETWEEN}.`, 1, []], 'a different lower build at the deadline: overwritten, one upload, nothing saved')
  // The build from before the upload still answers: not switched to yet. Success, said, one upload.
  const waiting = await updated(OLDER)
  assert.deepEqual([waiting.result.ok, waiting.result.pending, waiting.uploads, waiting.w.saved.length], [true, { notice: LIVE_UPDATE_PENDING, build: OLDER }, 1, 1], 'the pre-upload build at the deadline: uploaded and not switched to yet, one upload')
  assert.ok(over.readsBack > 1 && waiting.readsBack > 1, 'a lower build is asked about again, up to the deadline')
  console.log('PASS 4b (R10): after an upload the build is read back: this app\'s build is success; a different lower build is "another computer updated … with an older TalkWeaver"; the pre-upload build is "uploaded, not switched to yet"; one upload in each')
}

// ── The share-link address: only through the share-address action (R2) ──────────────────────────
/**
 * The action's ports over a world, with the config.json fields the main process keeps the list in
 * (`liveWorkerShareDomains`; a config given the two earlier fields is read as they were, and they go
 * with the first write). `wanted()`: the hostname in use ('' for none). `pending()`: the others
 * listed, joined. `records`: each change of the hostname in use, in order (null: none any more).
 * `reply`: set to `(method, path) => 'lost' | status | null` to lose or replace Cloudflare's answer
 * AFTER the stub has done what was asked. `failWrite`: config.json cannot be written (true), or
 * `(list) => boolean` for the writes of the list that fail. `links()`: a share link and a Run results
 * link as the app builds them now (`shareLinkBase` of this config, as the main process's one link-base
 * function does).
 *
 * THE TRUTH, as Cloudflare last showed it to this computer (`shown`: hostname → attached to this
 * Worker's production environment, or not): kept from every answer the action was actually given (a
 * lookup read in full, an attach that was taken, a removal that was taken or answered "not found"; a
 * lost, failed or unreadable answer shows nothing). Before every request, at every write of the list
 * and after every change, the link base must not be a hostname last shown NOT attached here:
 * `violations` holds every moment it was, and `change` fails on any.
 */
const shareWorlds = []
function shownBy(result, hostname) {
  if (!Array.isArray(result) || result.length > 1000) return null
  let here = false
  let unknown = false
  for (const record of result) {
    if (typeof record?.hostname !== 'string') { unknown = true; continue }
    if (record.hostname.toLowerCase() !== hostname) continue
    if (typeof record.service !== 'string') unknown = true
    else if (record.service !== NAME) continue
    else if (typeof record.environment !== 'string') unknown = true
    else if (record.environment !== 'production') continue
    else if (!validDomainId(record.id)) unknown = true
    else here = true
  }
  return here ? true : unknown ? null : false
}
function shareAddress(w, config = {}) {
  const granted = leave()
  const records = []
  const entries = () => shareDomainEntries(config).entries
  const wanted = () => entries().find((entry) => entry.wanted)?.hostname ?? ''
  const pending = () => entries().filter((entry) => !entry.wanted).map((entry) => entry.hostname).join(',')
  const links = () => [sharedTalkLink(ADDRESS, 'abc', shareLinkBase(structuredClone(config))), runResultsLink(ADDRESS, 'abc', shareLinkBase(structuredClone(config)))]
  const share = { config, records, granted, entries, wanted, pending, links, reply: null, failWrite: false, writes: 0, shown: new Map(), violations: [], checks: 0, hidden: 0 }
  shareWorlds.push(share)
  const check = (when) => {
    share.checks += 1
    const base = shareLinkBase(structuredClone(config))
    const host = base ? new URL(base).hostname : null
    if (host && share.shown.get(host) === false) share.violations.push(`${when}: links use ${host}, last shown not attached to this Worker`)
    // The list still says `wanted`, and no link uses it: the in-memory mark at work.
    if (!host && wanted()) share.hidden += 1
    assert.deepEqual(links(), host ? [`https://${host}/abc`, `https://${host}/results/abc`] : [`${ADDRESS}/shares/abc`, `${ADDRESS}/results/abc`], 'both link builders are on the one link base')
  }
  const learn = async (method, url, sentBody, answer) => {
    let body = null
    try { body = await answer.clone().json() } catch { return }
    const path = url.pathname.replace(/^\/client\/v4/, '')
    if (method === 'GET' && path.endsWith('/workers/domains')) {
      const hostname = url.searchParams.get('hostname')
      const verdict = answer.status === 200 && body?.success === true ? shownBy(body.result, hostname) : null
      if (hostname && verdict !== null) share.shown.set(hostname, verdict)
    } else if (method === 'PUT' && path.endsWith('/domains/records')) {
      if (answer.status === 200 && body?.success === true) for (const origin of JSON.parse(String(sentBody)).origins) share.shown.set(origin.hostname, true)
    } else if (method === 'DELETE' && /\/workers\/domains\/[^/]+$/.test(path)) {
      const id = path.split('/').at(-1)
      const hostname = [...share.shown.keys(), ...entries().map((entry) => entry.hostname)].find((known) => workerDomainId(known) === id)
      if (hostname && ((answer.status === 200 && body?.success === true) || answer.status === 404)) share.shown.set(hostname, false)
    }
  }
  const ports = {
    authorise: async () => ({ ok: true, authorisation: granted.authorisation }), apiBase: () => 'http://127.0.0.1:9/client/v4', workerName: NAME, timeoutMs: 2000,
    fetch: async (address, init = {}) => {
      check(`before ${init.method ?? 'GET'} ${new URL(String(address)).pathname}`)
      const answer = await w.fetch(address, init)
      const instead = share.reply?.(init.method ?? 'GET', new URL(String(address)).pathname.replace(/^\/client\/v4/, '')) ?? null
      if (instead === 'lost') throw new TypeError('the answer never arrived')
      const given = instead === null ? answer : new Response(JSON.stringify({ success: false, errors: [{ code: 10013, message: 'made-up failure' }], messages: [], result: null }), { status: instead })
      await learn(init.method ?? 'GET', new URL(String(address)), init.body, given)
      return given
    },
    records: {
      read: () => structuredClone(config),
      write: (list) => {
        check('at a write of the list')
        if (typeof share.failWrite === 'function' ? share.failWrite(list) : share.failWrite) throw new Error('config.json could not be written')
        const before = wanted()
        share.writes += 1
        config.liveWorkerShareDomains = structuredClone(list)
        delete config.liveWorkerShareDomain
        delete config.liveWorkerShareDomainPrevious
        if (wanted() !== before) records.push(wanted() || null)
      },
    },
  }
  /** Set the address to `wanted` (null: cleared), as `applyShareAddress` does. */
  share.change = async (address) => {
    const from = w.fake.requests.length
    const result = see(await changeShareAddress(ports, { wanted: address }))
    check(`after the address was ${address ? `set to ${address}` : 'cleared'}`)
    assert.deepEqual(share.violations, [], 'no link uses an address last shown not attached to this Worker')
    return { result, sent: lines(w, from), bodies: w.fake.requests.slice(from).filter((request) => request.method === 'PUT').map((request) => JSON.parse(request.body.toString())) }
  }
  return share
}
const lookup = (hostname, mine = false) => `GET /accounts/${ACCOUNT}/workers/domains?hostname=${encodeURIComponent(hostname)}${mine ? `&service=${NAME}&environment=production` : ''}`
const removal = (id) => `DELETE /accounts/${ACCOUNT}/workers/domains/${id}`
const domainsOf = (w) => (w.fake.model.workerDomains.get(ACCOUNT) ?? []).map((domain) => `${domain.hostname}→${domain.service}`).sort()
const NO_OVERRIDE = { override_scope: false, override_existing_origin: false, override_existing_dns_record: false }
{
  // Another Worker holds one hostname; this Worker has one attached from another computer.
  const w = world({ legacy: true, fake: { workerDomains: { [ACCOUNT]: ['other.example.org'] } } })
  deployed(w)
  w.fake.model.workerDomains.get(ACCOUNT).push({ id: workerDomainId('first-mac.example.org'), hostname: 'first-mac.example.org', service: NAME, environment: 'production' })
  const start = domainsOf(w)
  // Set-up, and a code update: no domain is looked at, attached or removed.
  assert.equal((await setUp(w)).ok, true)
  older(w)
  assert.equal((await setUp(w)).ok, true)
  assert.deepEqual([domainsOf(w), lines(w).filter((line) => /domains|routes|^DELETE /.test(line))], [start, []], 'set-up and a code update leave every custom domain as it was and ask about none')

  // Attach: one lookup of that hostname, one attach of it alone, every override off.
  const share = shareAddress(w)
  const attached = await share.change('talks.example.org')
  assert.deepEqual([attached.result, attached.sent, share.records, share.wanted()], [{ ok: true, changed: true }, [lookup('talks.example.org'), `PUT ${script}/domains/records`], ['talks.example.org'], 'talks.example.org'])
  assert.deepEqual(attached.bodies, [{ ...NO_OVERRIDE, origins: [{ hostname: 'talks.example.org' }] }], 'one hostname, and no override flag true')
  assert.deepEqual(domainsOf(w), [...start, `talks.example.org→${NAME}`].sort(), 'attached; nothing else moved')
  // Still set: the lookup, and nothing sent.
  const kept = await share.change('talks.example.org')
  assert.deepEqual([kept.result, kept.sent], [{ ok: true, changed: false }, [lookup('talks.example.org')]], 'kept while still set')

  // A hostname attached elsewhere is refused, and nothing is displaced: by the lookup …
  const elsewhere = shareAddress(w)
  const taken = await elsewhere.change('other.example.org')
  assert.deepEqual([taken.result, taken.sent, elsewhere.records, domainsOf(w).includes('other.example.org→talkweaver-live')], [{ ok: false, error: SHARE_DOMAIN_IN_USE }, [lookup('other.example.org')], [], true])
  // … and, when the lookup does not show it, by Cloudflare itself, because no override is sent.
  w.fake.model.answer = (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: [] } } : null)
  const raced = await shareAddress(w).change('other.example.org')
  w.fake.model.answer = null
  assert.deepEqual([raced.result, raced.bodies, domainsOf(w).includes('other.example.org→talkweaver-live')], [{ ok: false, error: SHARE_DOMAIN_IN_USE, details: 'Attaching the share-link address: Cloudflare answered 409 (error 100117).' }, [{ ...NO_OVERRIDE, origins: [{ hostname: 'other.example.org' }] }], true], 'Cloudflare refuses; the other Worker keeps its hostname')

  // A change of address: the new one is attached, then the recorded hostname removed. No other is touched.
  const moved = await share.change('new.example.org')
  assert.deepEqual([moved.result, moved.sent, share.wanted()], [{ ok: true, changed: true }, [lookup('new.example.org'), `PUT ${script}/domains/records`, lookup('talks.example.org', true), removal(workerDomainId('talks.example.org'))], 'new.example.org'])
  assert.deepEqual(domainsOf(w), [...start, `new.example.org→${NAME}`].sort(), 'moved')
  // Cleared: only the hostname this computer's config records is detached; the first computer's stays.
  const cleared = await share.change(null)
  assert.deepEqual([cleared.result.changed, cleared.result.ok, cleared.sent, share.wanted(), domainsOf(w)], [true, true, [lookup('new.example.org', true), removal(workerDomainId('new.example.org'))], '', start], 'looked up by its hostname, then deleted by id; a removal that was taken is `changed`')
  // With nothing recorded, clearing asks nothing and removes nothing, whatever this Worker has attached.
  const nothing = await share.change(null)
  assert.deepEqual([nothing.result, nothing.sent, domainsOf(w)], [{ ok: true, changed: false }, [], start])

  // The address is the one the API reports, whatever the account's subdomain is.
  const ada = world()
  ada.fake.model.answer = (request) => (request.path === `/accounts/${ACCOUNT}/workers/subdomain` ? { status: 200, body: { success: true, errors: [], messages: [], result: { subdomain: 'ada-lovelace' } } } : null)
  assert.equal((await setUp(ada)).baseUrl, `https://${NAME}.ada-lovelace.workers.dev`, 'the workers.dev address is read from the API\'s answer')
  console.log('PASS 5: set-up and a code update touch no custom domain; the share-address action attaches one hostname with no override, refuses one attached elsewhere and displaces nothing, and clearing detaches only the hostname this computer\'s config records; the workers.dev address comes from the API')
}

{
  // A bundle that does not match its manifest is never uploaded: nothing at all is sent.
  const w = world()
  const flipped = Buffer.from(BUNDLE)
  flipped[10] ^= 1
  const result = await setUp(w, { shipped: { manifest: shipped.manifestText, bundle: flipped, config: shipped.configBytes } })
  assert.deepEqual([result.ok, result.error], [false, INSTALLATION_INCOMPLETE])
  assert.match(result.details, /index\.js does not match its manifest/)
  assert.deepEqual([w.fake.requests.length, w.live.requests.length, w.authorised, w.profile.slot.writes.length, w.saved.length], [0, 0, 0, 0, 0], 'no request to Cloudflare or the live service, no leave asked for (it could run a check), no key made, nothing saved')
  const none = world()
  assert.equal((await setUp(none, { shipped: { manifest: null, bundle: null, config: null } })).error, INSTALLATION_INCOMPLETE)
  assert.equal(none.fake.requests.length, 0)
  console.log('PASS 6: a bundle that does not match its manifest is "This TalkWeaver installation is incomplete" with Details, and nothing is sent')
}

{
  // Failures, sorted (D12): a sentence, and Details in numbers only.
  const failing = async (answer, over = {}) => {
    const w = world({ legacy: over.legacy })
    if (over.deployed) deployed(w)
    if (over.older) older(w)
    w.fake.model.answer = answer
    return { w, result: await setUp(w, over) }
  }
  const at = (method, tail, answer) => (request) => (request.method === method && request.path === `${script}${tail}` ? answer : null)
  const subdomainRead = (request) => request.path.endsWith('/workers/subdomain') && !request.path.includes('/scripts/')

  const reader = world()
  const refused = await setUp(reader, { token: READER })
  assert.deepEqual([refused.ok, refused.error, refused.details], [false, LIVE_SETUP_REFUSED, 'Uploading the live service: Cloudflare answered 403 (error 10000).'], 'a token that may only read Workers is refused at the upload')
  const CASES = [
    ['the upload fails', at('PUT', '', reply(400, 10021)), LIVE_SETUP_FAILED, 'Uploading the live service: Cloudflare answered 400 (error 10021).'],
    ['the upload is not answered usably', at('PUT', '', { status: 502, body: 'Bad gateway' }), LIVE_SETUP_FAILED, 'Uploading the live service: Cloudflare answered 502.'],
    ['a code update fails', at('PUT', '', reply(400, 10021)), LIVE_SETUP_FAILED, 'Uploading the live service: Cloudflare answered 400 (error 10021).', { legacy: true, deployed: true, older: true }],
    ['workers.dev cannot be switched on', at('POST', '/subdomain', reply(500, 10013)), LIVE_SETUP_FAILED, 'Switching on its workers.dev address: Cloudflare answered 500 (error 10013).'],
    ['a first set-up\'s key cannot be set', at('PATCH', '/secrets-bulk', reply(500, 10013)), LIVE_KEYS_FAILED, 'Adding this computer\'s key: Cloudflare answered 500 (error 10013).'],
    ['a second computer\'s key cannot be added', at('PATCH', '/secrets-bulk', reply(500, 10013)), LIVE_KEY_NOT_ADDED, 'Adding this computer\'s key: Cloudflare answered 500 (error 10013).', { deployed: true }],
    ['the key is refused', at('PATCH', '/secrets-bulk', reply(403, 10000)), LIVE_SETUP_REFUSED, 'Adding this computer\'s key: Cloudflare answered 403 (error 10000).'],
    ['the account has no workers.dev subdomain', (request) => (subdomainRead(request) ? reply(404, 10007) : null), LIVE_NO_ADDRESS, 'Looking up the account\'s workers.dev address: Cloudflare answered 404 (error 10007).'],
    ['the subdomain reported is not a plain name', (request) => (subdomainRead(request) ? { status: 200, body: { success: true, errors: [], messages: [], result: { subdomain: 'evil.example/x' } } } : null), LIVE_NO_ADDRESS, 'Looking up the account\'s workers.dev address: the subdomain Cloudflare reported is not a plain name.'],
    ['the look-up is refused', (request) => (request.path.includes('/workers/services/') ? reply(403, 10000) : null), LIVE_SETUP_REFUSED, 'Looking up the live service: Cloudflare answered 403 (error 10000).'],
    ['Cloudflare cannot be reached', (request) => (request.path.includes('/workers/services/') ? { throws: new TypeError(`connect failed ${TOKEN} ${REPLY_TEXT_MARK}`) } : null), LIVE_SETUP_FAILED, 'Looking up the live service: Cloudflare could not be reached or did not answer in time.'],
  ]
  for (const [what, answer, sentence, details, over] of CASES) {
    const { w, result } = await failing(answer, over)
    assert.deepEqual([result.ok, result.error, result.details], [false, sentence, details], what)
    assert.deepEqual(w.saved, [], `${what}: no address saved`)
  }
  // Nothing is uploaded before the address is known: the reads come first.
  const { w: noAddress } = await failing(CASES.find(([what]) => what === 'the account has no workers.dev subdomain')[1])
  assert.deepEqual(writes(noAddress), [], 'with no address nothing was written at Cloudflare')
  // A key that could not be sent is kept, and the next press sends the same one.
  const { w: retried } = await failing(at('PATCH', '/secrets-bulk', reply(500, 10013)))
  const keptKey = ownKey(retried).key
  retried.fake.model.answer = null
  const second = await setUp(retried)
  assert.deepEqual([second.ok, second.adminSecret === keptKey, retried.profile.slot.writes.length], [true, true, 1], 'the key stored before the failed send is the one sent again')

  // The share-address action's failures: a fixed sentence, Details in numbers, and config.json's record
  // unchanged by a lookup or a removal that failed.
  const domainsRead = (request) => request.method === 'GET' && request.path.endsWith('/workers/domains')
  let attachSeen = false
  const SHARE_CASES = [
    ['attaching: the lookup is refused', '', 'talks.example.org', (request) => (domainsRead(request) ? reply(403, 10000) : null), SHARE_DOMAIN_NOT_ATTACHED, 'Looking up the share-link address: Cloudflare answered 403 (error 10000).', '', []],
    ['attaching: the lookup is not answered', '', 'talks.example.org', (request) => (domainsRead(request) ? { throws: new TypeError(`connect failed ${TOKEN}`) } : null), SHARE_DOMAIN_NOT_ATTACHED, 'Looking up the share-link address: Cloudflare could not be reached or did not answer in time.', '', []],
    ['clearing: the lookup is refused', 'old.example.org', null, (request) => (domainsRead(request) ? reply(403, 10000) : null), SHARE_DOMAIN_NOT_REMOVED, 'Looking up the share-link address: Cloudflare answered 403 (error 10000).', 'old.example.org', []],
    ['clearing: the removal fails', 'old.example.org', null, (request) => (request.method === 'DELETE' ? reply(500, 10013) : null), SHARE_DOMAIN_NOT_REMOVED, 'Removing the share-link address: Cloudflare answered 500 (error 10013).', '', [null], 'old.example.org'],
    ['changing: the attach of the new one fails, so the old one is not removed and stays recorded', 'old.example.org', 'new.example.org', at('PUT', '/domains/records', reply(500, 10013)), SHARE_DOMAIN_NOT_ATTACHED, 'Attaching the share-link address: Cloudflare answered 500 (error 10013).', 'old.example.org', []],
    // R11: the hostname is listed BEFORE the attach is sent, and (R13) never as the one in use: nothing has shown it attached. The attach fails; the lookup after it shows the hostname is not attached, so it leaves the list again.
    ['attaching: the attach itself fails', '', 'talks.example.org', at('PUT', '/domains/records', reply(500, 10013)), SHARE_DOMAIN_NOT_ATTACHED, 'Attaching the share-link address: Cloudflare answered 500 (error 10013).', '', [], ''],
    // … and when that lookup fails too, nothing is known: it stays listed (the domain may be attached).
    ['attaching: the attach itself fails, and so does the lookup after it', '', 'talks.example.org', (request) => (request.method === 'PUT' && request.path.endsWith('/domains/records') ? (attachSeen = true, reply(500, 10013)) : domainsRead(request) && attachSeen ? reply(403, 10000) : null), SHARE_DOMAIN_NOT_ATTACHED, 'Attaching the share-link address: Cloudflare answered 500 (error 10013).', '', [], 'talks.example.org'],
  ]
  // `after`: the address in use afterwards (what links are built on). `listed`: the others still on the list, when the case says.
  for (const [what, recorded, wanted, answer, sentence, details, after, records, listed] of SHARE_CASES) {
    attachSeen = false
    const w = world({ legacy: true })
    deployed(w)
    w.fake.model.workerDomains.set(ACCOUNT, [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org', service: NAME, environment: 'production' }])
    w.fake.model.answer = answer
    const share = shareAddress(w, recorded ? { liveWorkerShareDomain: recorded } : {})
    const { result, sent } = await share.change(wanted)
    assert.deepEqual([result, share.wanted(), share.records], [{ ok: false, error: sentence, details }, after, records], what)
    if (listed !== undefined) assert.equal(share.pending(), listed, `${what}: still on the list, and not the address in use`)
    assert.deepEqual([domainsOf(w), sent.filter((line) => line.startsWith('PUT '))], [[`old.example.org→${NAME}`], /the attach .*fails/.test(what) ? [`PUT ${script}/domains/records`] : []], `${what}: nothing was changed at Cloudflare`)
    assert.deepEqual(sent.filter((line) => line.startsWith('DELETE ')).length, what.startsWith('clearing: the removal') ? 1 : 0, `${what}: no removal but the one asked for`)
  }
  // A recorded hostname that is already gone at Cloudflare is what was wanted: by the lookup, or by the removal's 404.
  for (const answer of [null, (request) => (request.method === 'DELETE' ? reply(404, 100117) : null)]) {
    const w = world({ legacy: true })
    deployed(w)
    if (answer) w.fake.model.workerDomains.set(ACCOUNT, [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org', service: NAME, environment: 'production' }])
    w.fake.model.answer = answer
    const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
    assert.deepEqual([(await share.change(null)).result.ok, share.wanted()], [true, ''], 'shown not attached: the record is cleared')
  }
  // The token or account changed under the action: nothing more is sent and the record is as it was.
  {
    const w = world({ legacy: true })
    deployed(w)
    w.fake.model.workerDomains.set(ACCOUNT, [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org', service: NAME, environment: 'production' }])
    const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
    w.fake.model.answer = (request) => { if (domainsRead(request)) share.granted.state.current = false; return null }
    const { result, sent } = await share.change('new.example.org')
    assert.deepEqual([result, sent, share.wanted(), domainsOf(w)], [{ ok: false, error: DEPLOY_SUPERSEDED_ERROR }, [lookup('new.example.org')], 'old.example.org', [`old.example.org→${NAME}`]])
  }
  console.log(`PASS 7: ${CASES.length + 1} set-up failures and ${SHARE_CASES.length} share-address failures sorted into fixed sentences, with Details in numbers only; nothing written before the address is known; a lookup or removal that failed leaves the recorded address as it was`)
}

{
  // The generation changes under a set-up: nothing more is sent, nothing is saved.
  for (const [what, method, tail] of [['during the look-up', 'GET', null], ['during the upload', 'PUT', ''], ['during the key', 'PATCH', '/secrets-bulk']]) {
    const w = world()
    const granted = leave()
    const inner = w.fetch
    const fetch = async (address, init = {}) => {
      const answer = await inner(address, init)
      const path = new URL(address).pathname.replace(/^\/client\/v4/, '')
      if ((init.method ?? 'GET') === method && (tail === null || path === `${script}${tail}`)) granted.state.current = false
      return answer
    }
    const result = await setUp(w, { leave: granted, fetch })
    assert.deepEqual(result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR }, what)
    assert.deepEqual(w.saved, [], `${what}: nothing saved`)
    const after = w.fake.requests.findIndex((request) => request.method === method && (tail === null || request.path === `${script}${tail}`))
    assert.equal(w.fake.requests.length, after + 1, `${what}: no request after it`)
  }
  console.log('PASS 8: a change of token or account during the look-up, the upload or the key stops the set-up there; nothing is saved')
}

{
  // No program: the sequence's modules start none and take no launcher; the main process gives none.
  // (In the keys module `.exec(` is a regular expression's method, so there only a bare call counts.)
  for (const file of ['src/main/live-service-deploy.ts', 'src/main/live-service-upload.ts', 'src/main/live-service-key.ts', 'src/main/live-service-share-domain.ts', 'src/main/cloudflare-connection.ts']) {
    const code = readSource(join(repo, file)).replace(/^\s*\/\/[^\n]*$/gm, '')
    const starts = file.endsWith('live-service-key.ts') ? /(?<!\.)\bexec(?:File)?(?:Sync)?\(/ : /\bexec(?:File)?(?:Sync)?\(/
    assert.ok(!/from ['"](?:node:)?child_process['"]|wrangler-launcher|runBundledWrangler|\bspawn(?:Sync)?\(/.test(code) && !starts.test(code), `${file} imports no process or launcher module and starts nothing`)
  }
  const main = readSource(join(repo, 'src/main/index.ts'))
  const body = main.slice(main.indexOf('function deployLiveWorker('), main.indexOf('async function startLocalLiveWorker('))
  assert.ok(body.includes('return deployLiveService({') && !/wrangler|spawn|launch/i.test(body.replace(/\/\/[^\n]*/g, '')), 'the main process\'s set-up hands the sequence no launcher')
  assert.ok(/shipped: \(\) => shippedLiveWorker\(\)/.test(body) && /expectedBuild: LIVE_WORKER_VERSION/.test(body))
  // And no share address: set-up is handed nothing that names a custom domain.
  assert.ok(!/share|domain/i.test(body.replace(/\/\/[^\n]*/g, '')), 'the main process\'s set-up is handed no share address')
  console.log('PASS 9: no program is started for a set-up or an update: no launcher reaches the sequence')
}

// ── Fix round 1 (review of ticket 11) ───────────────────────────────────────────────────────────
{
  const mine = (hostname, more = {}) => ({ id: workerDomainId(hostname), hostname, service: NAME, environment: 'production', ...more })
  const everyDomainRead = (list) => (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: list } } : null)

  // 1a. A domain id is Cloudflare's shape (32 lowercase hex) or it is not used.
  assert.equal(validDomainId(workerDomainId('talks.example.org')), true)
  for (const odd of [TOKEN, LEGACY.adminSecret, 'domain-talks.example.org', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}/`, '', null]) assert.equal(validDomainId(odd), false, `not a domain id: ${String(odd).slice(0, 12)}`)
  // 1b. A lookup that echoes the token (or a key) as an id: nothing with it is sent, in any address.
  for (const echoed of [TOKEN, LEGACY.adminSecret, 'a'.repeat(32).replace(/^a{4}/, '../x')]) {
    const w = world({ legacy: true })
    deployed(w)
    w.fake.model.workerDomains.set(ACCOUNT, [mine('echo.example.org', { id: echoed })])
    const share = shareAddress(w, { liveWorkerShareDomain: 'echo.example.org' })
    const { result, sent } = await share.change(null)
    // R14: the right hostname, this Worker, production, and an id that is not one. That is not proof that it is gone: it stays listed, still the address in use, and the lookup is reported as incomplete.
    assert.deepEqual([result, sent, share.wanted(), share.writes, domainsOf(w)], [{ ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: LOOKUP_INCOMPLETE }, [lookup('echo.example.org', true)], 'echo.example.org', 1, [`echo.example.org→${NAME}`]], 'no DELETE for an id that is not one, and nothing forgotten')
    for (const request of w.fake.requests) for (const secret of SECRETS) assert.ok(!`${request.path}${request.search ?? ''}`.includes(secret))
  }
  // 1b (R14). A record for the hostname that cannot be read in full is "unknown", never "absent": in a removal's lookup, in the lookup before an attach, and in the lookup after an attach that was not clearly taken.
  {
    const HOST = 'echo.example.org'
    const UNREADABLE = [
      ['an id that is not one', { id: 'not-an-id' }],
      ['no id', { id: undefined }],
      ['no service', { service: undefined }],
      ['a service that is not text', { service: 7 }],
      ['this Worker and no environment', { environment: undefined }],
      ['this Worker and an environment that is not text', { environment: null }],
      ['no hostname', { hostname: undefined }],
      ['a hostname that is not text', { hostname: { name: HOST } }],
    ]
    const answering = (w, records) => (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: records(w) } } : null)
    for (const [what, odd] of UNREADABLE) {
      // Clearing, and a change to another address: the entry stays, nothing is removed.
      for (const address of [null, 'next.example.org']) {
        const w = world({ legacy: true })
        deployed(w)
        w.fake.model.workerDomains.set(ACCOUNT, [mine(HOST)])
        // The lookup of HOST answers with the unreadable record; any other lookup is answered as it is.
        w.fake.model.answer = (request) => ((request.search ?? '').includes(`hostname=${HOST}`) ? answering(w, () => [mine(HOST, odd)])(request) : null)
        const share = shareAddress(w, { liveWorkerShareDomains: [{ hostname: HOST, wanted: !address }, ...(address ? [{ hostname: address, wanted: false }] : [])] })
        if (address) w.fake.model.workerDomains.get(ACCOUNT).push(mine(address))
        const { result, sent } = await share.change(address)
        assert.deepEqual([result.ok, result.error, result.details, sent.filter((line) => !line.startsWith('GET ')), share.entries().some((entry) => entry.hostname === HOST), domainsOf(w).includes(`${HOST}→${NAME}`)],
          [false, address ? SHARE_DOMAIN_OLD_NOT_REMOVED : SHARE_DOMAIN_NOT_REMOVED, LOOKUP_INCOMPLETE, [], true, true], `a removal's lookup with ${what}: kept, nothing sent, reported`)
        if (!address) assert.equal(share.wanted(), HOST, `${what}: still the address in use`)
      }
      // Before an attach: nothing is sent, nothing listed, nothing in use.
      {
        const w = world({ legacy: true })
        deployed(w)
        w.fake.model.answer = answering(w, () => [mine(HOST, odd)])
        const share = shareAddress(w)
        const { result, sent } = await share.change(HOST)
        assert.deepEqual([result, sent, share.entries()], [{ ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: LOOKUP_INCOMPLETE }, [lookup(HOST)], []], `the lookup before an attach with ${what}: no attach sent`)
      }
      // After an attach whose answer was lost: unknown, so it stays listed (it may be attached) and is not the address in use.
      {
        const w = world({ legacy: true })
        deployed(w)
        let attachSent = false
        w.fake.model.answer = (request) => (attachSent ? answering(w, () => [mine(HOST, odd)])(request) : null)
        const share = shareAddress(w)
        share.reply = (method) => { if (method === 'PUT') { attachSent = true; return 500 } return null }
        const { result } = await share.change(HOST)
        assert.deepEqual([result, share.entries()], [{ ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: LOOKUP_INCOMPLETE }, [{ hostname: HOST, wanted: false }]], `the lookup after an attach with ${what}: unknown, so kept on the list and not in use, and the Details say the lookup could not be read`)
      }
    }
    // Readable records that are NOT this Worker's production environment are proof: held elsewhere, so not this computer's to remember.
    for (const [what, other] of [['another Worker', { service: 'another-worker' }], ['another Worker with no environment', { service: 'another-worker', environment: undefined }], ['another environment of this Worker', { environment: 'staging' }]]) {
      const w = world({ legacy: true })
      deployed(w)
      w.fake.model.answer = answering(w, () => [mine(HOST, other)])
      const share = shareAddress(w, { liveWorkerShareDomains: [{ hostname: HOST, wanted: true }] })
      const { result, sent } = await share.change(null)
      assert.deepEqual([result, sent, share.entries()], [{ ok: true, changed: false }, [lookup(HOST, true)], []], `${what}: shown not attached to this Worker, so off the list with nothing removed`)
    }
  }
  // 1c. The one request function refuses an address that holds the token or a key, before anything is sent.
  {
    const sent = []
    const port = { fetch: async (...args) => { sent.push(args); return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: {} })) }, base: CLOUDFLARE_API_BASE, timeoutMs: 1000, cancelled: new AbortController().signal }
    const cases = [
      ['the token in the path', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/domains/${TOKEN}` }],
      ['the token, encoded, in the query', { method: 'GET', path: `/accounts/${ACCOUNT}/workers/domains?service=${encodeURIComponent(`x ${TOKEN}`)}` }],
      ['a key named as forbidden', { method: 'DELETE', path: `/accounts/${ACCOUNT}/workers/domains/${LEGACY.signingSecret}`, forbidden: [LEGACY.adminSecret, LEGACY.signingSecret] }],
    ]
    for (const [what, outgoing] of cases) {
      const answer = await send(port, TOKEN, outgoing, () => true)
      assert.deepEqual([answer.kind, answer.http], ['refused', null], `${what}: refused`)
    }
    assert.equal(sent.length, 0, 'and nothing was sent')
    assert.equal((await send(port, TOKEN, { method: 'GET', path: `/accounts/${ACCOUNT}/workers/subdomain`, forbidden: [LEGACY.adminSecret] }, () => true)).kind, 'ok', 'an ordinary address is sent')
    assert.equal(sent.length, 1)
  }
  console.log('PASS 11 (fix 1): a domain id is 32 lowercase hex or unused; no request whose address holds the token or a key is sent')

  // 2. Only this Worker's production entry for exactly the recorded hostname is removed, whatever the
  // lookup's reply lists: a staging entry, one whose environment is not said, another hostname of this
  // Worker and another Worker's all survive.
  for (const unsaid of [false, true]) {
    const w = world({ legacy: true })
    deployed(w)
    const everything = [
      mine('old.example.org'),
      mine('old.example.org', { id: 'b'.repeat(32), environment: 'staging' }),
      ...(unsaid ? [{ id: 'c'.repeat(32), hostname: 'old.example.org', service: NAME }] : []),
      mine('first-mac.example.org'),
      mine('old.example.org', { id: 'd'.repeat(32), service: 'another-worker' }),
    ]
    w.fake.model.workerDomains.set(ACCOUNT, everything.map((domain) => ({ ...domain })))
    // An answer that ignores the filters and lists every entry.
    w.fake.model.answer = everyDomainRead(everything)
    const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
    const { result, sent } = await share.change(null)
    assert.deepEqual(sent, [lookup('old.example.org', true), removal(workerDomainId('old.example.org'))], 'the lookup asks for this Worker\'s production entry of that hostname; one removal')
    assert.deepEqual(w.fake.model.workerDomains.get(ACCOUNT).map((domain) => domain.id).sort(), ['b'.repeat(32), ...(unsaid ? ['c'.repeat(32)] : []), 'd'.repeat(32), workerDomainId('first-mac.example.org')].sort(), 'the staging entry, the one whose environment is not said, the other hostname and the other Worker\'s survive')
    // R14. With every record read in full, the hostname is shown gone and leaves the list. A record of this Worker for it whose
    // environment is not said may be the one in production: it is not removed, and it is not proof either, so the hostname stays listed.
    assert.deepEqual([result, share.wanted(), share.pending()], unsaid
      ? [{ ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: LOOKUP_INCOMPLETE, changed: true }, '', 'old.example.org']
      : [{ ok: true, changed: true }, '', ''])
  }
  console.log('PASS 12 (fix 2): clearing the share-link address removes this Worker\'s production entry for the recorded hostname only')

  // 3. The record: written before the attach is sent, kept through a failure, cleared only once the
  // hostname is shown not to be attached.
  {
    const w = world({ legacy: true })
    deployed(w)
    const share = shareAddress(w)
    let recordedWhenSent = null
    w.fake.model.answer = (request) => { if (request.method === 'PUT' && request.path.endsWith('/domains/records')) recordedWhenSent = share.entries(); return null }
    assert.equal((await share.change('talks.example.org')).result.ok, true)
    assert.deepEqual([recordedWhenSent, share.entries()], [[{ hostname: 'talks.example.org', wanted: false }], [{ hostname: 'talks.example.org', wanted: true }]], 'the hostname was already on the list when the attach was sent, and (R13) became the address in use only once the attach was taken')
    // Cleared in Settings while the lookup is refused: the record is kept, so the next press still knows what to remove.
    w.fake.model.answer = (request) => (request.path.endsWith('/workers/domains') ? reply(403, 10000) : null)
    const stopped = await share.change(null)
    assert.deepEqual([stopped.result, share.wanted(), writes(w).filter((line) => line.startsWith('DELETE '))], [{ ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: 'Looking up the share-link address: Cloudflare answered 403 (error 10000).' }, 'talks.example.org', []])
    // Cloudflare answers again: the domain is removed, and only then is the record cleared.
    w.fake.model.answer = null
    assert.equal((await share.change(null)).result.ok, true)
    assert.deepEqual([domainsOf(w), share.wanted()], [[], ''], 'a verified removal clears the record')
  }
  console.log('PASS 13 (fix 3): the recorded share-link address is written before the attach and cleared only after a lookup or removal has shown it is not attached')

  // 3b. A change of address never loses the old one: the new one is attached first.
  {
    const before = (extra = []) => { const w = world({ legacy: true }); deployed(w); w.fake.model.workerDomains.set(ACCOUNT, [mine('old.example.org'), ...extra]); return w }
    const deletes = (sent) => sent.filter((line) => line.startsWith('DELETE '))
    // The new address is in use (another Worker has it): nothing is removed, the record still says the
    // old one, and "Nothing was changed" is true. Shown by the lookup …
    {
      const w = before([mine('taken.example.org', { id: 'e'.repeat(32), service: 'another-worker' })])
      const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
      const { result, sent } = await share.change('taken.example.org')
      assert.deepEqual([result, sent, share.records, share.wanted(), share.pending(), domainsOf(w)],
        [{ ok: false, error: SHARE_DOMAIN_IN_USE }, [lookup('taken.example.org')], [], 'old.example.org', '', ['old.example.org→' + NAME, 'taken.example.org→another-worker']], 'in use by the lookup: no DELETE, the old address attached and recorded')
      // … or only by Cloudflare's refusal of the attach, which carries no override.
      w.fake.model.answer = (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: [] } } : null)
      const raced = await share.change('taken.example.org')
      w.fake.model.answer = null
      assert.deepEqual([raced.result.error, raced.result.changed, deletes(raced.sent), raced.sent.filter((line) => line.startsWith('PUT ')).length, share.records, share.wanted(), domainsOf(w)],
        [SHARE_DOMAIN_IN_USE, undefined, [], 1, [], 'old.example.org', ['old.example.org→' + NAME, 'taken.example.org→another-worker']], 'refused by Cloudflare: no DELETE, the old address attached and recorded')
      assert.ok(/Nothing was changed\.$/.test(SHARE_DOMAIN_IN_USE))
    }
    // It works: the attach of the new one, and only then the removal of the old one; the record is
    // the new one from the moment it is attached, not before.
    {
      const w = before()
      const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
      let recordedWhenAttachSent = null
      let recordedWhenRemovalSent = null
      w.fake.model.answer = (request) => {
        if (request.method === 'PUT' && request.path.endsWith('/domains/records')) recordedWhenAttachSent = share.wanted()
        if (request.method === 'DELETE') recordedWhenRemovalSent = share.wanted()
        return null
      }
      const { result, sent } = await share.change('new.example.org')
      assert.deepEqual([result, sent, share.records, share.pending(), domainsOf(w), recordedWhenAttachSent, recordedWhenRemovalSent],
        [{ ok: true, changed: true }, [lookup('new.example.org'), `PUT ${script}/domains/records`, lookup('old.example.org', true), removal(workerDomainId('old.example.org'))], ['new.example.org'], '', ['new.example.org→' + NAME], 'old.example.org', 'new.example.org'], 'attach the new one, then remove the old one')
    }
    // The new one attached, the removal of the old one fails: the new one is recorded, the old one
    // stays attached and noted, and the sentence says so. The next run removes it.
    for (const mode of ['the removal fails', 'the lookup before the removal is refused']) {
      const w = before()
      const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
      w.fake.model.answer = mode === 'the removal fails'
        ? (request) => (request.method === 'DELETE' ? reply(500, 10013) : null)
        : (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') && lines(w).some((line) => line.startsWith('PUT ') && line.endsWith('/domains/records')) ? reply(403, 10000) : null)
      const { result, sent } = await share.change('new.example.org')
      assert.deepEqual([result, share.wanted(), share.pending(), domainsOf(w), sent.slice(0, 2)],
        [{ ok: false, error: SHARE_DOMAIN_OLD_NOT_REMOVED, details: mode === 'the removal fails' ? 'Removing the share-link address: Cloudflare answered 500 (error 10013).' : 'Looking up the share-link address: Cloudflare answered 403 (error 10000).', changed: true },
          'new.example.org', 'old.example.org', ['new.example.org→' + NAME, 'old.example.org→' + NAME], [lookup('new.example.org'), `PUT ${script}/domains/records`]], mode)
      w.fake.model.answer = null
      const again = await share.change('new.example.org')
      assert.deepEqual([again.result, again.sent, share.wanted(), share.pending(), domainsOf(w)],
        [{ ok: true, changed: true }, [lookup('new.example.org'), lookup('old.example.org', true), removal(workerDomainId('old.example.org'))], 'new.example.org', '', ['new.example.org→' + NAME]], `${mode}: the next run removes the old address, and only it`)
    }
    // Set back to the old address while it is still noted: it is the address again, and is not removed.
    {
      const w = before()
      const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
      w.fake.model.answer = (request) => (request.method === 'DELETE' ? reply(500, 10013) : null)
      await share.change('new.example.org')
      w.fake.model.answer = null
      const back = await share.change('old.example.org')
      assert.deepEqual([back.result, share.wanted(), share.pending(), domainsOf(w)], [{ ok: true, changed: true }, 'old.example.org', '', ['old.example.org→' + NAME]])
    }
    // Clearing: a removal that was taken is `changed: true`.
    {
      const w = before()
      const share = shareAddress(w, { liveWorkerShareDomain: 'old.example.org' })
      assert.deepEqual([(await share.change(null)).result, share.wanted(), domainsOf(w)], [{ ok: true, changed: true }, '', []])
    }
  }
  console.log('PASS 13b: a change of share-link address attaches the new one first; a new one that is in use removes nothing and the record still says the old one; a failed removal of the old one records the new one, says so, and is tried again by the next run; clearing answers changed')

  // 3c (R11). This computer keeps a LIST of every hostname it asked Cloudflare to attach, and an entry
  // leaves it only on proof. A, B, C are this computer's; `first-mac` was attached to this Worker by
  // another computer and `taken` belongs to another Worker: neither is ever on the list.
  {
    const [A, B, C] = ['a.example.org', 'b.example.org', 'c.example.org']
    const FOREIGN = [mine('first-mac.example.org'), mine('taken.example.org', { id: 'e'.repeat(32), service: 'another-worker' })]
    const foreign = ['first-mac.example.org→' + NAME, 'taken.example.org→another-worker']
    const on = (...hostnames) => [...hostnames.map((hostname) => `${hostname}→${NAME}`), ...foreign].sort()
    const worlds = []
    /** A is attached and is this computer's address in use. */
    const withA = (config = { liveWorkerShareDomains: [{ hostname: A, wanted: true }] }) => {
      const w = world({ legacy: true })
      deployed(w)
      w.fake.model.workerDomains.set(ACCOUNT, [mine(A), ...FOREIGN.map((domain) => ({ ...domain }))])
      const share = shareAddress(w, config)
      worlds.push({ w, share, listed: new Set(share.entries().map((entry) => entry.hostname)) })
      return { w, share }
    }
    const deletes = (sent) => sent.filter((line) => line.startsWith('DELETE '))
    const attachPath = `${script}/domains/records`
    const isAttach = (method, path) => method === 'PUT' && path === attachPath
    const isLookup = (method, path) => method === 'GET' && path.endsWith('/workers/domains')
    const list = (share) => share.entries().map((entry) => `${entry.hostname}${entry.wanted ? '*' : ''}`).sort()

    // (a) A→B: Cloudflare attaches B and the answer is lost (no reply, or a 500), and so is the lookup after it.
    for (const lost of ['lost', 500]) {
      const { w, share } = withA()
      let attachSent = false
      let listedWhenAttachSent = null
      share.reply = (method, path) => {
        if (isAttach(method, path)) { attachSent = true; listedWhenAttachSent = list(share); return lost }
        return isLookup(method, path) && attachSent ? 'lost' : null
      }
      const first = await share.change(B)
      assert.deepEqual([first.result.ok, first.result.error, first.sent, listedWhenAttachSent, list(share), domainsOf(w)],
        [false, SHARE_DOMAIN_NOT_ATTACHED, [lookup(B), `PUT ${attachPath}`, lookup(B)], [`${A}*`, B], [`${A}*`, B], on(A, B)], `the answer ${lost}: B was listed before the attach was sent, and is still listed; A is still the one in use; nothing was removed`)
      // The next Save finds B attached, makes it the one in use, and detaches A.
      share.reply = null
      const next = await share.change(B)
      assert.deepEqual([next.result, next.sent, list(share), domainsOf(w)], [{ ok: true, changed: true }, [lookup(B), lookup(A, true), removal(workerDomainId(A))], [`${B}*`], on(B)], 'the next Save: B is found attached and is the one in use; A is removed')
    }
    // … with the lookup after it answered, the lost answer costs nothing: B is attached, so that is success, and A goes in the same run.
    {
      const { w, share } = withA()
      share.reply = (method, path) => (isAttach(method, path) ? 'lost' : null)
      const { result, sent } = await share.change(B)
      assert.deepEqual([result, sent, list(share), domainsOf(w)], [{ ok: true, changed: true }, [lookup(B), `PUT ${attachPath}`, lookup(B), lookup(A, true), removal(workerDomainId(A))], [`${B}*`], on(B)], 'attached with the answer lost: the lookup says so')
    }
    // (a') … and a CLEAR in between detaches both A and B, and leaves nothing of this computer's attached.
    {
      const { w, share } = withA()
      let attachSent = false
      share.reply = (method, path) => (isAttach(method, path) ? (attachSent = true, 'lost') : isLookup(method, path) && attachSent ? 'lost' : null)
      assert.equal((await share.change(B)).result.ok, false)
      share.reply = null
      const cleared = await share.change(null)
      assert.deepEqual([cleared.result, deletes(cleared.sent).sort(), list(share), domainsOf(w)], [{ ok: true, changed: true }, [removal(workerDomainId(A)), removal(workerDomainId(B))].sort(), [], foreign], 'cleared: both A and the B whose answer was lost are removed; the list is empty')
      assert.deepEqual((await share.change(null)).sent, [], 'and with nothing listed, clearing asks nothing')
    }
    // (b) A→B with the removal of A failing, then B→C with the removal of B failing: the list holds A, B and C (in use). The next Save removes A and B.
    {
      const { w, share } = withA()
      w.fake.model.answer = (request) => (request.method === 'DELETE' ? reply(500, 10013) : null)
      const toB = await share.change(B)
      assert.deepEqual([toB.result.error, toB.result.changed, list(share), domainsOf(w)], [SHARE_DOMAIN_OLD_NOT_REMOVED, true, [A, `${B}*`], on(A, B)])
      const toC = await share.change(C)
      assert.deepEqual([toC.result.error, toC.result.changed, toC.result.details, list(share), domainsOf(w)], [SHARE_DOMAIN_OLD_NOT_REMOVED, true, 'Removing the share-link address: Cloudflare answered 500 (error 10013).', [A, B, `${C}*`], on(A, B, C)], 'three hostnames: none is forgotten')
      assert.deepEqual(deletes(toC.sent).sort(), [removal(workerDomainId(A)), removal(workerDomainId(B))].sort(), 'both older ones were tried, though the first failed')
      w.fake.model.answer = null
      const again = await share.change(C)
      assert.deepEqual([again.result, again.sent[0], deletes(again.sent).sort(), list(share), domainsOf(w)], [{ ok: true, changed: true }, lookup(C), [removal(workerDomainId(A)), removal(workerDomainId(B))].sort(), [`${C}*`], on(C)], 'the next Save removes A and B, and only them')
    }
    // Three in a row with nothing failing: only the last stays listed and attached.
    {
      const { w, share } = withA()
      for (const hostname of [B, C]) assert.deepEqual((await share.change(hostname)).result, { ok: true, changed: true })
      assert.deepEqual([list(share), domainsOf(w), share.records], [[`${C}*`], on(C), [B, C]])
    }
    // A lost answer on the REMOVAL: Cloudflare removed A, the reply never came. No proof, so A stays listed; the next run's lookup shows it gone, and then it leaves, with no second removal.
    for (const address of [B, null]) {
      const { w, share } = withA()
      share.reply = (method) => (method === 'DELETE' ? 'lost' : null)
      const first = await share.change(address)
      assert.deepEqual([first.result.ok, first.result.error, list(share), domainsOf(w)], [false, address ? SHARE_DOMAIN_OLD_NOT_REMOVED : SHARE_DOMAIN_NOT_REMOVED, address ? [A, `${B}*`] : [A], address ? on(B) : foreign], 'the removal\'s answer was lost: A stays listed (and, its removal having been sent, is no longer the address in use)')
      share.reply = null
      const next = await share.change(address)
      assert.deepEqual([next.result.ok, deletes(next.sent), list(share)], [true, [], address ? [`${B}*`] : []], 'shown gone by the next lookup: off the list, and nothing removed twice')
    }
    // A lost answer on the LOOKUP before a removal: nothing is known, so nothing is removed and nothing leaves the list.
    {
      const { w, share } = withA({ liveWorkerShareDomains: [{ hostname: B, wanted: true }, { hostname: A, wanted: false }] })
      w.fake.model.workerDomains.get(ACCOUNT).push(mine(B))
      share.reply = (method, path) => (isLookup(method, path) ? 'lost' : null)
      for (const address of [B, null]) {
        const { result, sent } = await share.change(address)
        assert.deepEqual([result.ok, sent.filter((line) => !line.startsWith('GET ')), list(share), domainsOf(w)], [false, [], [A, `${B}*`], on(A, B)], 'no lookup answered: nothing sent but lookups, nothing forgotten')
      }
    }
    // An attach that failed, with the lookup after it failing too: the hostname stays listed although it is NOT attached. The next clear looks it up, sees that, and drops it without removing anything.
    {
      const { w, share } = withA()
      let attachSent = false
      w.fake.model.answer = (request) => (request.method === 'PUT' && request.path === attachPath ? (attachSent = true, reply(500, 10013)) : attachSent && request.method === 'GET' && request.path.endsWith('/workers/domains') ? reply(403, 10000) : null)
      assert.deepEqual([(await share.change(B)).result.error, list(share), domainsOf(w)], [SHARE_DOMAIN_NOT_ATTACHED, [`${A}*`, B], on(A)])
      w.fake.model.answer = null
      const cleared = await share.change(null)
      assert.deepEqual([cleared.result, deletes(cleared.sent), list(share), domainsOf(w)], [{ ok: true, changed: true }, [removal(workerDomainId(A))], [], foreign])
    }
    // The list cannot be written: no attach is sent (a hostname that is not listed is never asked for).
    {
      const { w, share } = withA()
      share.failWrite = true
      const { result, sent } = await share.change(B)
      assert.deepEqual([result, sent, domainsOf(w)], [{ ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: 'Recording the share-link address: Settings could not be saved.' }, [lookup(B)], on(A)])
    }
    // A lookup's reply that names hostnames this computer never listed (it ignores the filters): none of them is removed.
    {
      const { w, share } = withA()
      w.fake.model.answer = (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: w.fake.model.workerDomains.get(ACCOUNT) } } : null)
      const cleared = await share.change(null)
      assert.deepEqual([deletes(cleared.sent), domainsOf(w)], [[removal(workerDomainId(A))], foreign])
    }
    // Migration: the two earlier fields become the list (the recorded one in use, the earlier one not), and both fields go with the first write.
    {
      assert.deepEqual(shareDomainEntries({ liveWorkerShareDomain: B, liveWorkerShareDomainPrevious: A }), { entries: [{ hostname: B, wanted: true }, { hostname: A, wanted: false }], old: true })
      assert.deepEqual(shareDomainEntries({ liveWorkerShareDomain: '', liveWorkerShareDomainPrevious: '' }), { entries: [], old: true }, 'cleared earlier fields are no entries')
      assert.deepEqual(shareDomainEntries({}), { entries: [], old: false })
      // A list AND an earlier field (an older TalkWeaver ran in between): every hostname is kept, once, with one in use.
      assert.deepEqual(shareDomainEntries({ liveWorkerShareDomains: [{ hostname: C, wanted: true }, { hostname: A, wanted: true }, { hostname: C, wanted: false }], liveWorkerShareDomain: B, liveWorkerShareDomainPrevious: A }).entries, [{ hostname: C, wanted: true }, { hostname: A, wanted: false }, { hostname: B, wanted: false }])
      // What is not a hostname could never be sent, and is no entry.
      assert.deepEqual(shareDomainEntries({ liveWorkerShareDomains: [null, 7, { hostname: 'Not A Host', wanted: true }, { hostname: '../x' }, { hostname: `${A}/x` }, { hostname: A, wanted: 'yes' }], liveWorkerShareDomain: 7, liveWorkerShareDomainPrevious: { hostname: B } }).entries, [{ hostname: A, wanted: false }])
      assert.deepEqual(shareDomainEntries({ liveWorkerShareDomains: 'none' }).entries, [])
      const { w, share } = withA({ liveWorkerShareDomain: B, liveWorkerShareDomainPrevious: A, shareDomain: B })
      w.fake.model.workerDomains.get(ACCOUNT).push(mine(B))
      // Even a run that gets no answer writes the list first: the earlier fields are gone, and nothing is forgotten.
      share.reply = (method, path) => (isLookup(method, path) ? 'lost' : null)
      assert.equal((await share.change(B)).result.ok, false)
      assert.deepEqual(share.config, { liveWorkerShareDomains: [{ hostname: B, wanted: true }, { hostname: A, wanted: false }], shareDomain: B }, 'the list is in config.json; both earlier fields are removed; no other field is touched')
      share.reply = null
      const saved = await share.change(B)
      assert.deepEqual([saved.result, saved.sent, list(share), domainsOf(w), share.records], [{ ok: true, changed: true }, [lookup(B), lookup(A, true), removal(workerDomainId(A))], [`${B}*`], on(B), []], 'the earlier "previous" address is removed by the next Save')
    }
    // ── R13: links are built only from an address that is attached ──
    {
      const NOT_SAVED = 'Recording the share-link address: Settings could not be saved.'
      const linksOn = (host) => (host ? [`https://${host}/abc`, `https://${host}/results/abc`] : [`${ADDRESS}/shares/abc`, `${ADDRESS}/results/abc`])
      const TAKEN = 'taken.example.org'
      // A is attached. The person types an address Cloudflare refuses: by the lookup, by Cloudflare's own 409, by a failed attach
      // (shown not attached afterwards), and by a failed attach whose lookup is lost too. Settings holds what was typed
      // (`sharedTalkLinkBase`); new links are still on A, and the result says the new address was not attached.
      const REFUSALS = [
        ['another Worker holds it', TAKEN, () => null, SHARE_DOMAIN_IN_USE, [`${A}*`]],
        ['Cloudflare refuses the attach (409)', TAKEN, () => (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') && request.search.includes(TAKEN) ? { status: 200, body: { success: true, errors: [], messages: [], result: [] } } : null), SHARE_DOMAIN_IN_USE, [`${A}*`]],
        ['the attach fails', B, () => (request) => (request.method === 'PUT' && request.path === attachPath ? reply(500, 10013) : null), SHARE_DOMAIN_NOT_ATTACHED, [`${A}*`]],
        ['the attach fails and the lookup after it is lost', B, () => { let sent = false; return (request) => (request.method === 'PUT' && request.path === attachPath ? (sent = true, reply(500, 10013)) : sent && request.method === 'GET' ? reply(403, 10000) : null) }, SHARE_DOMAIN_NOT_ATTACHED, [`${A}*`, B]],
      ]
      for (const [what, typed, answer, sentence, listed] of REFUSALS) {
        const { w, share } = withA()
        share.config.sharedTalkLinkBase = `https://${typed}`
        w.fake.model.answer = answer()
        const { result } = await share.change(typed)
        assert.deepEqual([result.ok, result.error, list(share), share.links(), domainsOf(w)], [false, sentence, listed, linksOn(A), on(A)], `${what}: the address typed is not attached, and new links stay on the attached one`)
        // Cleared afterwards: A is removed, and links use the live service's own address.
        w.fake.model.answer = null
        share.config.sharedTalkLinkBase = undefined
        const cleared = await share.change(null)
        assert.deepEqual([cleared.result.ok, list(share), share.links(), domainsOf(w)], [true, [], linksOn(null), foreign], `${what}, then cleared: links on workers.dev`)
      }
      // A first address: links are on workers.dev until Cloudflare has taken the attach, and on the address from then on.
      {
        const w = world({ legacy: true })
        deployed(w)
        w.fake.model.workerDomains.set(ACCOUNT, FOREIGN.map((domain) => ({ ...domain })))
        const share = shareAddress(w, { sharedTalkLinkBase: `https://${A}` })
        worlds.push({ w, share, listed: new Set() })
        let linksWhenSent = null
        w.fake.model.answer = (request) => { if (request.method === 'PUT' && request.path === attachPath) linksWhenSent = share.links(); return null }
        assert.deepEqual(share.links(), linksOn(null), 'typed, nothing attached: workers.dev')
        const first = await share.change(A)
        assert.deepEqual([first.result, linksWhenSent, share.links()], [{ ok: true, changed: true }, linksOn(null), linksOn(A)], 'the first attach is taken: links on it, and not before')
        // A first address that is refused: links stay on workers.dev although Settings holds the address.
        const other = shareAddress(w, { sharedTalkLinkBase: `https://${TAKEN}` })
        w.fake.model.answer = null
        assert.deepEqual([(await other.change(TAKEN)).result, other.links(), other.entries()], [{ ok: false, error: SHARE_DOMAIN_IN_USE }, linksOn(null), []])
      }
      // The link base is the list's entry in use and nothing else: never the earlier fields' "previous" one, a listed one not in use, or a value that is no hostname.
      assert.deepEqual([shareLinkBase({}), shareLinkBase({ sharedTalkLinkBase: `https://${B}` }), shareLinkBase({ liveWorkerShareDomains: [{ hostname: A, wanted: false }], liveWorkerShareDomainPrevious: B }), shareLinkBase({ liveWorkerShareDomains: [{ hostname: 'localhost', wanted: true }, { hostname: `${A}:8443`, wanted: true }] }), shareLinkBase({ liveWorkerShareDomains: [{ hostname: A, wanted: false }, { hostname: B, wanted: true }] }), shareLinkBase({ liveWorkerShareDomain: A })],
        [undefined, undefined, undefined, undefined, `https://${B}`, `https://${A}`])
      // Source: ONE function decides the link base in the main process, both link builders are handed it, and what was typed in
      // Settings is read only where the field is shown, saved and handed to the share-address action as the address asked for.
      {
        const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
        const main = strip(readSource(join(repo, 'src/main/index.ts')))
        assert.deepEqual(main.match(/linkBase:[^\n]*/g), ['linkBase: () => attachedShareLinkBase(),', 'linkBase: () => attachedShareLinkBase(),'], 'shares and Run results links: the one function')
        assert.match(main, /function attachedShareLinkBase\(\): string \| undefined \{\n  return shareLinkBase\(shareDomainRecords\(\)\)\n\}/)
        // Every function of the main process that names the typed value, by the function it is in.
        const readers = new Set()
        let inside = null
        for (const line of main.split('\n')) {
          const opened = /^(?:async )?function (\w+)\(/.exec(line) ?? /^(?:const|let) (\w+) = /.exec(line) ?? /^(ipcMain)\./.exec(line) ?? /^(?:type|interface) (\w+)/.exec(line)
          if (opened) inside = opened[1]
          if (line.includes('sharedTalkLinkBase')) readers.add(inside)
        }
        assert.deepEqual([...readers].sort(), ['Config', 'applyPublishSettings', 'liveShareHostname', 'shareDomainFromLinkBase', 'useSuggestedShareDomain'].sort(), 'the typed address: its config field, the Settings field (read and saved), the suggestion button, and the address asked for')
        // The address asked for goes to the share-address action and to "is there anything to do", never to a link.
        const asked = main.match(/[^\n]*liveShareHostname\(\)[^\n]*/g).map((line) => line.trim())
        const ASKED = [/^function liveShareHostname\(\): string \| null \{$/, /^const shareAddressDue = \(\): boolean => liveShareHostname\(\) !== null \|\| listedShareDomains\(\)\.length > 0$/, /^const wanted = liveShareHostname\(\)$/, /^if \(result\.ok && result\.created && liveShareHostname\(\)\) \{ try \{ await applyShareAddress\(\) \}/]
        assert.ok(asked.length === ASKED.length && asked.every((line, index) => ASKED[index].test(line)), `the address asked for is used here only:\n${asked.join('\n')}`)
        assert.ok(!/shareDomainFromLinkBase\(\)[^\n]*(?:Link|linkBase)/.test(main))
        // No other file of the app reads the typed value at all, and the two link builders are called only with a `linkBase()` handed in.
        const files = readdirSync(join(repo, 'src'), { recursive: true }).map(String).filter((file) => /\.(?:ts|tsx)$/.test(file))
        assert.ok(files.length > 100)
        const naming = files.filter((file) => strip(readSource(join(repo, 'src', file))).includes('sharedTalkLinkBase'))
        assert.deepEqual(naming, [join('main', 'index.ts')], 'the typed address is named in code by the main process only')
        const calls = files.flatMap((file) => [...strip(readSource(join(repo, 'src', file))).matchAll(/(?<!function )\b(?:sharedTalkLink|runResultsLink)\(([^\n]*)/g)].map((match) => `${file}: ${/^[^()]*, deps\.linkBase\(\)\)/.test(match[1]) ? 'deps.linkBase()' : match[1]}`))
        assert.deepEqual(calls.sort(), [`${join('main', 'run-results-share.ts')}: deps.linkBase()`, `${join('main', 'shared-talk-state.ts')}: deps.linkBase()`].sort(), 'every link on the share-link address is built with the link base handed in')
      }

      // ── R15: a change Cloudflare took that the list could not then record ──
      const inUse = (hostname) => (list) => list.some((entry) => entry.hostname === hostname && entry.wanted)
      const without = (hostname) => (list) => !list.some((entry) => entry.hostname === hostname)
      const puts = (sent) => sent.filter((line) => line.startsWith('PUT '))
      // A→B, and only the write that makes B the address in use fails (the write that lists B is taken).
      for (const lost of [null, 'lost']) {
        const { w, share } = withA()
        share.failWrite = inUse(B)
        if (lost) share.reply = (method, path) => (isAttach(method, path) ? lost : null)
        const first = await share.change(B)
        assert.deepEqual([first.result, puts(first.sent).length, deletes(first.sent), list(share), domainsOf(w), share.links()],
          [{ ok: false, error: SHARE_DOMAIN_ATTACHED_NOT_SAVED, details: NOT_SAVED, changed: true }, 1, [], [`${A}*`, B], on(A, B), linksOn(A)], 'B is attached and could not be saved as the one in use: said so, A is NOT removed and is still what links are built on')
        // Saved again while the write still fails: said again, and nothing is sent but the lookup.
        share.reply = null
        const still = await share.change(B)
        assert.deepEqual([still.result, still.sent, list(share), share.links()], [{ ok: false, error: SHARE_DOMAIN_ATTACHED_NOT_SAVED, details: NOT_SAVED }, [lookup(B)], [`${A}*`, B], linksOn(A)])
        // The next Save finishes it: B in use, A removed. No second attach.
        share.failWrite = false
        const next = await share.change(B)
        assert.deepEqual([next.result, next.sent, list(share), domainsOf(w), share.links()], [{ ok: true, changed: true }, [lookup(B), lookup(A, true), removal(workerDomainId(A))], [`${B}*`], on(B), linksOn(B)], 'the next Save finishes: one lookup of B, then A removed')
        assert.deepEqual([puts(lines(w)).filter((line) => line.endsWith('/domains/records')).length, deletes(lines(w)).length], [1, 1], 'one attach and one removal in all')
      }
      // A→B, and only the write that takes A off the list fails.
      {
        const { w, share } = withA()
        share.failWrite = without(A)
        const first = await share.change(B)
        assert.deepEqual([first.result, first.sent, list(share), domainsOf(w), share.links()],
          [{ ok: false, error: SHARE_DOMAIN_REMOVED_NOT_SAVED, details: NOT_SAVED, changed: true }, [lookup(B), `PUT ${attachPath}`, lookup(A, true), removal(workerDomainId(A))], [A, `${B}*`], on(B), linksOn(B)], 'A was removed and could not be taken off the list: said so; A stays listed, and links are on B')
        share.failWrite = false
        const next = await share.change(B)
        assert.deepEqual([next.result, next.sent, list(share), domainsOf(w)], [{ ok: true, changed: false }, [lookup(B), lookup(A, true)], [`${B}*`], on(B)], 'the next Save drops it after one lookup: no DELETE')
      }
      // Cleared, and the write that takes A off the list fails: A is no longer in use (that write came before the removal), so no link is on it.
      {
        const { w, share } = withA()
        share.failWrite = without(A)
        const first = await share.change(null)
        assert.deepEqual([first.result, first.sent, list(share), domainsOf(w), share.links()],
          [{ ok: false, error: SHARE_DOMAIN_REMOVED_NOT_SAVED, details: NOT_SAVED, changed: true }, [lookup(A, true), removal(workerDomainId(A))], [A], foreign, linksOn(null)])
        share.failWrite = false
        const next = await share.change(null)
        assert.deepEqual([next.result, next.sent, list(share)], [{ ok: true, changed: false }, [lookup(A, true)], []])
      }
      // Cleared, and nothing can be written: the removal is NOT sent (A would be removed and still be what links are built on).
      {
        const { w, share } = withA()
        share.failWrite = true
        const { result, sent } = await share.change(null)
        assert.deepEqual([result, sent, list(share), domainsOf(w), share.links()], [{ ok: false, error: SHARE_DOMAIN_NOT_REMOVED, details: NOT_SAVED }, [lookup(A, true)], [`${A}*`], on(A), linksOn(A)])
      }
      // Both in turn: the in-use write fails, then the drop write fails, then a Save that can write. One attach and one removal in all.
      {
        const { w, share } = withA()
        share.failWrite = inUse(B)
        assert.equal((await share.change(B)).result.error, SHARE_DOMAIN_ATTACHED_NOT_SAVED)
        share.failWrite = without(A)
        const second = await share.change(B)
        assert.deepEqual([second.result, second.sent, list(share), domainsOf(w), share.links()], [{ ok: false, error: SHARE_DOMAIN_REMOVED_NOT_SAVED, details: NOT_SAVED, changed: true }, [lookup(B), lookup(A, true), removal(workerDomainId(A))], [A, `${B}*`], on(B), linksOn(B)])
        share.failWrite = false
        const third = await share.change(B)
        assert.deepEqual([third.result, third.sent, list(share), domainsOf(w)], [{ ok: true, changed: false }, [lookup(B), lookup(A, true)], [`${B}*`], on(B)])
        assert.deepEqual([puts(lines(w)).filter((line) => line.endsWith('/domains/records')).length, deletes(lines(w)).length], [1, 1])
      }
      // Two old addresses, the drop of the first fails and the removal of the second fails: the removal's failure is the one reported, with `changed`.
      {
        const { w, share } = withA({ liveWorkerShareDomains: [{ hostname: A, wanted: true }, { hostname: C, wanted: false }] })
        w.fake.model.workerDomains.get(ACCOUNT).push(mine(C))
        share.failWrite = without(A)
        w.fake.model.answer = (request) => (request.method === 'DELETE' && request.path.endsWith(workerDomainId(C)) ? reply(500, 10013) : null)
        const { result } = await share.change(B)
        assert.deepEqual([result, list(share), domainsOf(w)], [{ ok: false, error: SHARE_DOMAIN_OLD_NOT_REMOVED, details: 'Removing the share-link address: Cloudflare answered 500 (error 10013).', changed: true }, [A, `${B}*`, C], on(B, C)])
        share.failWrite = false
        w.fake.model.answer = null
        assert.deepEqual([(await share.change(B)).result.ok, list(share), domainsOf(w)], [true, [`${B}*`], on(B)])
      }
    }
    // (j) THE RULE of `wanted`: it is set only on proof that the hostname is attached here, and a lookup read in full that shows a
    // listed hostname NOT attached here ends it before anything else is sent, in memory at once when the list cannot be written.
    {
      const linksOn = (host) => (host ? [`https://${host}/abc`, `https://${host}/results/abc`] : [`${ADDRESS}/shares/abc`, `${ADDRESS}/results/abc`])
      const refused = { status: 500, body: { success: false, errors: [{ code: 10013, message: 'made-up failure' }], messages: [], result: null } }
      const isPut = (request) => request.method === 'PUT' && request.path.endsWith('/domains/records')
      const isGet = (request) => request.method === 'GET' && request.path.endsWith('/workers/domains')
      const read = (records) => ({ status: 200, body: { success: true, errors: [], messages: [], result: records } })
      /** A is this computer's address in use, and is no longer attached at Cloudflare. */
      const withAGone = () => {
        const made = withA()
        made.w.fake.model.workerDomains.set(ACCOUNT, FOREIGN.map((domain) => ({ ...domain })))
        return made
      }
      // The reviewer's case. A is wanted; its lookup is empty; the re-attach fails; the lookup after it cannot be read (or is lost, or fails).
      const ATTACH_500 = 'Attaching the share-link address: Cloudflare answered 500 (error 10013).'
      for (const [what, after, details] of [['cannot be read in full', () => read([mine(A, { id: 'not-an-id' })]), LOOKUP_INCOMPLETE], ['has a record with no hostname', () => read([{ id: 'f'.repeat(32), service: NAME, environment: 'production' }]), LOOKUP_INCOMPLETE], ['is lost', 'lost', ATTACH_500], ['fails', refused, ATTACH_500]]) {
        const { w, share } = withAGone()
        let attachSent = false
        let listedAtAttach = null
        let linksAtAttach = null
        w.fake.model.answer = (request) => {
          if (isPut(request)) { attachSent = true; listedAtAttach = list(share); linksAtAttach = share.links(); return refused }
          return isGet(request) && attachSent && after !== 'lost' ? (typeof after === 'function' ? after() : after) : null
        }
        share.reply = (method, path) => (after === 'lost' && attachSent && isLookup(method, path) ? 'lost' : null)
        const again = await share.change(A)
        assert.deepEqual([again.result, again.sent, listedAtAttach, linksAtAttach, list(share), share.links(), domainsOf(w)],
          [{ ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details }, [lookup(A), `PUT ${attachPath}`, lookup(A)], [A], linksOn(null), [A], linksOn(null), on()],
          `A wanted, shown absent, re-attach failed, and the lookup after it ${what}: A is not the one in use (already when the attach was sent), and both links are on workers.dev`)
        // The next Save, with Cloudflare answering: attached, and only now the one in use again.
        w.fake.model.answer = null
        share.reply = null
        assert.deepEqual([(await share.change(A)).result, list(share), share.links()], [{ ok: true, changed: true }, [`${A}*`], linksOn(A)])
      }
      // The same hostname saved again while nothing can be learned: nothing is changed, nothing is sent, and it is still the link base.
      for (const [what, arrange, details] of [
        ['offline', (w, share) => { share.reply = () => 'lost' }, 'Looking up the share-link address: Cloudflare could not be reached or did not answer in time.'],
        ['Cloudflare failing', (w, share) => { share.reply = () => 500 }, 'Looking up the share-link address: Cloudflare answered 500 (error 10013).'],
        ['a lookup that cannot be read in full', (w) => { w.fake.model.answer = (request) => (isGet(request) ? read([mine(A, { environment: undefined })]) : null) }, LOOKUP_INCOMPLETE],
        ['a lookup of more than 1,000 records', (w) => { w.fake.model.answer = (request) => (isGet(request) ? read(Array.from({ length: 1001 }, () => mine('z.example.org'))) : null) }, null],
      ]) {
        // Shown absent or not at Cloudflare in truth: what could not be read is no evidence either way.
        for (const make of [withA, withAGone]) {
          const { w, share } = make()
          arrange(w, share)
          const writes = share.writes
          const saved = await share.change(A)
          assert.deepEqual([saved.result.ok, saved.result.error, saved.sent, list(share), share.links(), share.writes - writes], [false, SHARE_DOMAIN_NOT_ATTACHED, [lookup(A)], [`${A}*`], linksOn(A), 0], `the same address saved with ${what}: unchanged, nothing sent, still the link base`)
          if (details) assert.equal(saved.result.details, details)
          w.fake.model.answer = null
        }
      }
      // … and when the lookup shows it attached here: nothing to do.
      {
        const { share } = withA()
        const writes = share.writes
        assert.deepEqual([(await share.change(A)).result, list(share), share.links(), share.writes - writes <= 1], [{ ok: true, changed: false }, [`${A}*`], linksOn(A), true])
      }
      // Shown absent, and the list cannot be written: nothing further is sent, it is said, and no link uses A in this process although the file still says so.
      for (const next of [A, B, null]) {
        const { w, share } = withAGone()
        share.failWrite = true
        const stuck = await share.change(A)
        assert.deepEqual([stuck.result, stuck.sent, share.wanted(), share.links()], [{ ok: false, error: SHARE_DOMAIN_NOT_ATTACHED, details: 'Recording the share-link address: Settings could not be saved.' }, [lookup(A)], A, linksOn(null)], 'shown absent with the list unwritable: no attach is sent, the file still says A, and no link uses it')
        // Still unwritable, and now nothing can be learned either: the mark stands (an unanswered lookup is not evidence FOR it).
        share.reply = () => 'lost'
        assert.deepEqual([(await share.change(A)).result.ok, share.wanted(), share.links()], [false, A, linksOn(null)])
        share.reply = null
        share.failWrite = false
        const then = await share.change(next)
        assert.deepEqual([then.result.ok, list(share), share.links(), domainsOf(w)], [true, next ? [`${next}*`] : [], linksOn(next), next ? on(next) : on()], `the next save (${next ?? 'cleared'}) finishes it`)
      }
      // Shown held elsewhere while it was the wanted one, and the drop cannot be written: said, and not a link base.
      {
        const { w, share } = withAGone()
        w.fake.model.workerDomains.get(ACCOUNT).push(mine(A, { id: 'd'.repeat(32), service: 'another-worker' }))
        share.failWrite = true
        const held = await share.change(A)
        assert.deepEqual([held.result, held.sent, share.wanted(), share.links()], [{ ok: false, error: SHARE_DOMAIN_IN_USE, details: 'Recording the share-link address: Settings could not be saved.' }, [lookup(A)], A, linksOn(null)])
        share.failWrite = false
        const dropped = await share.change(A)
        assert.deepEqual([dropped.result, dropped.sent, list(share), share.links()], [{ ok: false, error: SHARE_DOMAIN_IN_USE }, [lookup(A)], [], linksOn(null)], 'held elsewhere: dropped by the next save, and nothing was sent for it')
      }
      // Clearing an address that is already absent needs no id: un-wanted and dropped. With the drop unwritable it is no link base in
      // this process, and the next save (or clear) drops it.
      for (const next of [null, B]) {
        const { w, share } = withAGone()
        share.failWrite = true
        const cleared = await share.change(null)
        assert.deepEqual([cleared.result, cleared.sent, share.wanted(), share.links()], [{ ok: false, error: SHARE_DOMAIN_REMOVED_NOT_SAVED, details: 'Recording the share-link address: Settings could not be saved.' }, [lookup(A, true)], A, linksOn(null)], 'cleared, already absent, the drop not written: the file still says A, and no link uses it')
        share.failWrite = false
        const then = await share.change(next)
        assert.deepEqual([then.result.ok, list(share), share.links(), deletes(then.sent), domainsOf(w)], [true, next ? [`${next}*`] : [], linksOn(next), [], next ? on(next) : on()], 'dropped by the next save, with no removal sent')
      }
      // Cleared and written: absent needs one lookup and no removal.
      {
        const { share } = withAGone()
        const cleared = await share.change(null)
        assert.deepEqual([cleared.result, cleared.sent, list(share), share.links()], [{ ok: true, changed: false }, [lookup(A, true)], [], linksOn(null)])
      }

      // THE SWEEP. Every sequence of two steps, and a spread of longer ones, around an entry that starts as the wanted one: each step
      // is a save of the same address, of another, or a clear; with every lookup answering as attached here, absent, held elsewhere,
      // unreadable or not at all; the attach taken, refused, or taken with its answer lost; and the list writable or not. The stub's
      // record of what Cloudflare last showed is checked before every request, at every write and after every step (`shareAddress`).
      const VIEWS = ['truth', 'attached', 'absent', 'elsewhere', 'unreadable', 'lost']
      const PUTS = ['taken', 'refused', 'answer lost']
      const steps = []
      for (const action of ['same', 'other', 'clear']) for (const view of VIEWS) for (const put of action === 'clear' ? ['taken'] : PUTS) for (const writable of [true, false, 'first only']) steps.push({ action, view, put, writable })
      let serial = 0
      let outcomes = 0
      const sweepWorld = world({ legacy: true })
      deployed(sweepWorld)
      const sweep = async (sequence) => {
        serial += 1
        const [P, Q] = [`p${serial}.example.org`, `q${serial}.example.org`]
        const w = sweepWorld
        w.fake.model.workerDomains.set(ACCOUNT, [mine(P)])
        const share = shareAddress(w, { liveWorkerShareDomains: [{ hostname: P, wanted: true }] })
        for (const step of sequence) {
          const hostnameOf = (request) => new URLSearchParams(request.search ?? '').get('hostname') ?? new URL(`http://x${request.path}${request.search ?? ''}`).searchParams.get('hostname')
          w.fake.model.answer = (request) => {
            if (isPut(request) && step.put === 'refused') return refused
            if (!isGet(request) || step.view === 'truth' || step.view === 'lost') return null
            const hostname = hostnameOf(request) ?? P
            return read(step.view === 'attached' ? [mine(hostname)] : step.view === 'absent' ? [] : step.view === 'elsewhere' ? [mine(hostname, { id: 'c'.repeat(32), service: 'another-worker' })] : [mine(hostname, { id: 'unreadable' })])
          }
          share.reply = (method, path) => ((step.view === 'lost' && isLookup(method, path)) || (step.put === 'answer lost' && isAttach(method, path)) ? 'lost' : null)
          let written = 0
          share.failWrite = step.writable === true ? false : step.writable === false ? true : () => (written += 1) > 1
          await share.change(step.action === 'same' ? P : step.action === 'other' ? Q : null)
          outcomes += 1
          // `wanted` in the file only where the hostname was last shown attached here, or nothing has been shown against it and it was so from the start.
          const inUse = share.wanted()
          if (inUse && share.links()[0].startsWith(`https://${inUse}`)) assert.notEqual(share.shown.get(inUse), false)
          if (share.links()[0].startsWith(`https://${Q}`)) assert.equal(share.shown.get(Q), true, 'a hostname becomes the link base only on proof that it is attached here')
        }
        w.fake.model.answer = null
        share.reply = null
        share.failWrite = false
        return share
      }
      for (const first of steps) for (const second of steps) await sweep([first, second])
      // Longer ones, picked by a fixed sequence of numbers (the same every run).
      let seed = 20261012
      const pick = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return steps[seed % steps.length] }
      for (let run = 0; run < 1500; run += 1) await sweep([pick(), pick(), pick(), pick(), pick()])
      const swept = shareWorlds.slice(-serial)
      assert.deepEqual(swept.flatMap((share) => share.violations), [])
      assert.ok(swept.some((share) => share.hidden > 0) && swept.reduce((sum, share) => sum + share.checks, 0) > 50_000 && outcomes > 30_000, 'the sweep met the in-memory mark, and looked often')
    }
    // Across every one of these: no DELETE of a hostname this computer never listed, no override sent true, and the other computers' domains exactly as they were.
    let removals = 0
    for (const { w, share, listed } of worlds) {
      for (const hostname of [A, B, C]) if (w.fake.requests.some((request) => request.method === 'PUT' && request.path === attachPath && JSON.parse(request.body.toString()).origins.some((origin) => origin.hostname === hostname))) listed.add(hostname)
      const mayRemove = new Set([...listed].map((hostname) => removal(workerDomainId(hostname))))
      for (const line of lines(w)) {
        if (!line.startsWith('DELETE ')) continue
        removals += 1
        assert.ok(mayRemove.has(line), 'a removal names only a hostname of this computer\'s list')
        assert.ok(line !== removal(workerDomainId('first-mac.example.org')) && line !== removal('e'.repeat(32)))
      }
      for (const request of w.fake.requests.filter((sent) => sent.method === 'PUT' && sent.path === attachPath)) assert.deepEqual(Object.entries(JSON.parse(request.body.toString())).filter(([field]) => field.startsWith('override')), [['override_scope', false], ['override_existing_origin', false], ['override_existing_dns_record', false]])
      assert.deepEqual(domainsOf(w).filter((line) => foreign.includes(line)), foreign, 'the first computer\'s domain and the other Worker\'s are still attached')
      assert.ok(!('liveWorkerShareDomain' in share.config) && !('liveWorkerShareDomainPrevious' in share.config))
    }
    assert.ok(removals >= 14 && worlds.length >= 12, `removals were looked at (${removals} in ${worlds.length} worlds)`)
    // The module exports one thing that sends: the action. Nothing outside it can attach or detach a hostname.
    const exported = [...readSource(join(repo, 'src/main/live-service-share-domain.ts')).matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1])
    // (`shareDomainEntries` and `shareLinkBase` read config.json's list and send nothing.)
    assert.deepEqual(exported.sort(), ['changeShareAddress', 'shareDomainEntries', 'shareLinkBase'])
  }
  // Every share-address scenario of this suite: at no step was the link base a hostname last shown not attached to this Worker.
  assert.deepEqual(shareWorlds.flatMap((share) => share.violations), [])
  assert.ok(shareWorlds.length > 60 && shareWorlds.reduce((sum, share) => sum + share.checks, 0) > 500)
  console.log('PASS 13d (R13, the rule of `wanted`): a hostname is the link base only while nothing has shown it not attached: shown absent it stops being the one in use before its re-attach is sent, in memory at once when the list cannot be written; the same address saved while nothing can be learned is unchanged; an absent address is cleared without an id; and in every sequence swept, no link used an address last shown not attached here')
  console.log('PASS 13c (R11): this computer lists every hostname before it asks Cloudflare to attach it, and an entry leaves the list only on proof: an attach whose answer was lost is found by the next Save or removed by a clear; three hostnames in a row with failing removals are all kept and all removed later; a lost answer on a removal or a lookup forgets nothing; no hostname that was never listed is removed; the two earlier fields become the list')

  // 4. A Worker at a migration tag this build does not know (set up by a newer TalkWeaver): stop, send nothing.
  {
    const w = world({ legacy: true })
    deployed(w, 'v5')
    const result = await setUp(w)
    assert.deepEqual([result.ok, result.error], [false, LIVE_NEWER_SERVICE])
    assert.match(result.details, /migration tag v5/, 'Details name the tag')
    assert.deepEqual([writes(w), w.saved, workerOf(w).migrationTag], [[], [], 'v5'], 'nothing sent, nothing saved')
    const odd = world({ legacy: true })
    deployed(odd, 'v5\u001b[31m<script>')
    const shown = await setUp(odd)
    assert.equal(shown.error, LIVE_NEWER_SERVICE)
    assert.ok(!/[\u0000-\u001f<]/.test(shown.details), 'a tag that is not plain is not repeated as it came')
    assert.throws(() => planLiveServiceUpload({ ...verifyShippedBundle(shipped.manifestText, { bundle: shipped.bundle, config: shipped.configBytes }, BUILD), accountId: ACCOUNT, deployedMigrationTag: 'v5' }), UnknownMigrationTagError)
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

// ── Nothing secret anywhere, and the new model across every world ───────────────────────────────
{
  // The keys the worlds' computers made are secrets too.
  const made = worlds.flatMap((w) => w.profile.entries().filter((entry) => entry.kind === 'own').map((entry) => entry.key))
  assert.ok(made.length > 10 && new Set(made).size === made.length, `each computer made its own key (${made.length})`)
  SECRETS.push(...made)
  const seen = JSON.stringify(observed)
  for (const secret of SECRETS) assert.ok(!seen.includes(secret), 'no token or key in any result or Details')
  assert.ok(!seen.includes(REPLY_TEXT_MARK), 'and no text of a Cloudflare reply')
  for (const w of worlds) assert.ok(!SECRETS.some((secret) => JSON.stringify(w.profile.config).includes(secret) || JSON.stringify(w.saved).includes(secret)), 'no key in what goes to config.json')
  // R1: no request of any world names a signing secret; R2: no set-up or code update sends a DELETE or
  // names a domain or a route; and no request lists the Worker's secrets.
  for (const w of worlds) {
    assert.deepEqual(w.fake.namingSigningSecret(), [], 'no request names the signing secret')
    assert.deepEqual(w.setUps.filter((request) => request.method === 'DELETE' || /\/domains|\/routes|\/zones/.test(request.path)).map((request) => `${request.method} ${request.path}`), [], 'a set-up touches no domain or route')
    assert.deepEqual(w.fake.requests.filter((request) => request.method === 'GET' && /\/secrets(?:$|\?)/.test(request.path)).length, 0, 'the Worker\'s secrets are never listed')
  }
  // Every request of every world above: the token only in its header, the keys only in the keys' body.
  const requests = worlds.flatMap((w) => w.fake.requests)
  assert.ok(requests.length > 100, `plenty of requests looked at (${requests.length})`)
  const keys = SECRETS.filter((secret) => secret !== TOKEN && secret !== READER)
  let sentUploads = 0
  let sentSecrets = 0
  let sentAttaches = 0
  for (const request of requests) {
    const address = `${request.path}${request.search ?? ''}`
    for (const secret of SECRETS) assert.ok(!address.includes(secret), 'no secret in a request address')
    const { authorization, ...others } = request.headers ?? {}
    assert.ok(authorization === `Bearer ${TOKEN}` || authorization === `Bearer ${READER}`, 'every request carries the token in its header')
    for (const secret of SECRETS) assert.ok(!JSON.stringify(others).includes(secret), 'and no secret in any other header')
    const body = request.body.toString('latin1')
    for (const token of [TOKEN, READER]) assert.ok(!body.includes(token), 'the token is in no body')
    // What was really sent, in every world: uploads bind Durable Object namespaces only; keys go as secret_text.
    if (request.method === 'PUT' && request.path === `/accounts/${ACCOUNT}/workers/scripts/${NAME}`) {
      const metadata = request.parts?.find((part) => part.name === 'metadata')
      assert.ok(metadata, 'an upload carries its metadata')
      assert.deepEqual(bindingProblems(JSON.parse(metadata.bytes.toString('utf8'))), [], 'a sent upload binds Durable Object namespaces only')
      assert.equal(request.search, '?excludeScript=true&bindings_inherit=strict', 'and inherits the bindings (the secrets) Cloudflare already holds')
      sentUploads += 1
    }
    if (request.method === 'PATCH' && request.path.endsWith('/secrets-bulk')) {
      const sent = JSON.parse(request.body.toString('utf8'))
      assert.deepEqual(secretsProblems(sent), [], 'sent secrets are secret_text')
      const names = Object.keys(sent.secrets)
      assert.ok(names.length === 1 && names[0] !== 'ADMIN_SECRET' && computerIdForSecretName(names[0]) !== null, 'a secrets request names exactly one computer\'s key')
      sentSecrets += 1
    }
    if (request.method === 'PUT' && request.path.endsWith('/domains/records')) {
      const sent = JSON.parse(request.body.toString('utf8'))
      assert.ok(sent.origins.length === 1 && Object.entries(sent).every(([field, value]) => !field.startsWith('override') || value === false), 'an attach names one hostname and sets no override')
      sentAttaches += 1
    }
    if (!(request.method === 'PATCH' && request.path.endsWith('/secrets-bulk'))) for (const key of keys) assert.ok(!body.includes(key), `a key is only ever in the keys' body (${request.method} ${request.path})`)
  }
  assert.ok(sentUploads > 5 && sentSecrets > 5 && sentAttaches > 3, `uploads, secrets requests and attaches were looked at (${sentUploads}, ${sentSecrets}, ${sentAttaches})`)
  console.log(`PASS 10: no token, key or reply text in any result or Details; across ${requests.length} requests the token is only in its header and each key only in its own secrets request; none names a signing secret, none lists secrets, no set-up touches a domain`)
}
process.stdout.write = write
process.stderr.write = writeErr
const output = printed.join('')
for (const secret of SECRETS) assert.ok(!output.includes(secret), 'no secret value in this test\'s output')
console.log(`live service upload: the shipped bundle checked, the plan, the sequence and the share-address action against the fake API, no program started, no secret printed — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
