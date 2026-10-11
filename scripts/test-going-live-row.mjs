// The Going live and sharing row, and keeping the live service current (spec
// "Cloudflare set-up in the app", D9, the "Per feature" table and the "What each user action
// does" table; ticket 05). The seams:
//   1. ensureLiveService (pure): (connection, stored keys, what is deployed, app build) → the action
//      and the row. Every state of the spec's row is produced here;
//   2. createLiveService, the service, over the real set-up sequence (live-service-deploy.ts) and the
//      fake Cloudflare API's model (scripts/lib/cloudflare-api-stub.mjs), with a stand-in for the
//      deployed Worker that answers Go live's two requests. No network at all;
//   3. the presenter's prompt (present-live-setup.ts) on the compiled presenter page in jsdom, and the
//      share sheet's view of the same prompt.
// Invariants stated here and checked below:
//   - every state of the row comes from the pure function, word for word as the spec has it;
//   - first set-up from Settings ends Ready, and Go live works afterwards with the keys it set;
//   - nothing is set up on a use (D9: on purpose): a use with nothing deployed sends no write;
//   - a newer app build triggers exactly ONE update before the next use, with the stored keys; the
//     person is told "Updating the live service…";
//   - lost keys with a deployed service: the stop state, what resetting breaks, and nothing sent to
//     Cloudflare; only an explicit reset (the Worker deleted, then Check again) leads to new keys;
//   - Go live and Share for comments with nothing set up offer the spec's prompt, and the presenter
//     keeps presenting while it shows and while it sets up;
//   - a token lacking the live-service permission shows the row naming the permission;
//   - a recorded address is looked up at Cloudflare, for the account it was recorded for, before it
//     is handed out; a Worker deleted in the dashboard reads Not set up and is never handed out;
//   - no secret value in a row, a reply, an error, a notice, or this test's output.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { LOOK_INTERVAL_MS, askedFromTopFrame, createLiveService, ensureLiveService, outcomeOf, setUpAllowedFrom } from '../src/main/live-service.ts'
import { LIVE_KEYS_LOST, LIVE_NOT_SET_UP, LIVE_SETUP_FAILED, LIVE_SETUP_REFUSED, LiveServiceError, deployLiveService, lookUpLiveService } from '../src/main/live-service-deploy.ts'
import { DEPLOY_NOT_CONNECTED_ERROR, DEPLOY_SUPERSEDED_ERROR, TOKEN_REMOVED } from '../src/main/cloudflare-connection.ts'
import {
  GOING_LIVE_IDLE_DETAIL, GOING_LIVE_NOT_FOUND_DETAIL, GOING_LIVE_OTHER_ACCOUNT_DETAIL, LIVE_KEYS_LOST_EXPLAINED, LIVE_KEYS_LOST_STATE, LIVE_SETTING_UP_NOTICE,
  LIVE_UPDATING_NOTICE, LIVE_WORKER_NAME, GOING_LIVE_READY_DETAIL, goingLiveRowDetail, goingLiveRowEdge, goingLiveRowRetries, liveSetupPromptCopy,
} from '../src/shared/live-service-status.ts'
import { initialShareSheet, shareSheetReducer, shareSheetView } from '../src/shared/shared-talk.ts'
import { showLiveSetupPrompt, LIVE_SETUP_PROMPT_ID } from '../src/preload/present-live-setup.ts'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { WORKERS_SUBDOMAIN, createFakeCloudflare, fakeCloudflareFetch } from './lib/cloudflare-api-stub.mjs'
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

const TOKEN = ['made', 'up', 'golive', 'token', '0123456789abcdef'].join('-') // gitleaks:allow (made-up test value)
const READER = ['made', 'up', 'golive', 'reader', '0123456789abcdef'].join('-') // gitleaks:allow (made-up test value)
const NEW_KEYS = { adminSecret: ['made-up-golive-admin', 'secret', 'abcdef0123456789'].join('-'), signingSecret: ['made-up-golive-signing', 'secret', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
const SECOND_KEYS = { adminSecret: ['made-up-golive-admin2', 'secret', 'abcdef0123456789'].join('-'), signingSecret: ['made-up-golive-signing2', 'secret', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
const SECRETS = [TOKEN, READER, NEW_KEYS.adminSecret, NEW_KEYS.signingSecret, SECOND_KEYS.adminSecret, SECOND_KEYS.signingSecret]
const ACCOUNT = 'acc0golive'
const OTHER = 'acc0other'
const BUILD = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(repo, 'worker', 'recovery-protocol.ts'), 'utf8'))[1]
const ADDRESS = `https://${LIVE_WORKER_NAME}.${WORKERS_SUBDOMAIN}.workers.dev`
const observed = []
const see = (value) => { observed.push(value); return value }

// ── 1. The pure decision: every state of the row ────────────────────────────────────────────────
const facts = (over = {}) => ({
  connection: 'connected', permission: 'not-refused', accountId: ACCOUNT, keysStored: true,
  deployed: { baseUrl: null, version: null, accountId: null }, appBuild: BUILD, underway: null, last: null, ...over,
})
const deployedHere = (over = {}) => ({ baseUrl: ADDRESS, version: BUILD, accountId: ACCOUNT, ...over })
const edgeText = (row) => { const edge = goingLiveRowEdge(row); return edge.kind === 'state' ? edge.text : edge.kind === 'action' ? `[${edge.label}]` : '' }
{
  // [what, facts, row state, edge, detail (or a pattern), action for a use, action for "Set up going live"]
  const CASES = [
    ['not connected, nothing deployed', facts({ connection: 'not-connected', accountId: null }), 'unknown', '', GOING_LIVE_IDLE_DETAIL,
      { kind: 'not-set-up', message: LIVE_NOT_SET_UP, prompt: 'open-settings', reason: 'not-set-up' }, { kind: 'stop', message: DEPLOY_NOT_CONNECTED_ERROR }],
    ['connected, nothing deployed', facts(), 'not-set-up', '[Set up going live]', GOING_LIVE_IDLE_DETAIL,
      { kind: 'not-set-up', message: LIVE_NOT_SET_UP, prompt: 'open-settings', reason: 'not-set-up' }, { kind: 'set-up' }],
    ['connected, not checked yet, nothing deployed', facts({ connection: 'not-checked', accountId: null }), 'not-set-up', '[Set up going live]', GOING_LIVE_IDLE_DETAIL,
      { kind: 'not-set-up', message: LIVE_NOT_SET_UP, prompt: 'open-settings', reason: 'not-set-up' }, { kind: 'set-up' }],
    ['deployed for another account', facts({ deployed: deployedHere({ accountId: OTHER }) }), 'not-set-up', '[Set up going live]', GOING_LIVE_OTHER_ACCOUNT_DETAIL, { kind: 'use' }, { kind: 'set-up' }],
    ['a lookup found it deleted', facts({ last: { outcome: 'not-found' } }), 'not-set-up', '[Set up going live]', GOING_LIVE_NOT_FOUND_DETAIL,
      { kind: 'not-set-up', message: LIVE_NOT_SET_UP, prompt: 'open-settings', reason: 'not-set-up' }, { kind: 'set-up' }],
    ['setting up: the deploy', facts({ underway: { kind: 'set-up', phase: 'upload' } }), 'setting-up', 'Setting up…', 'Uploading the live service', { kind: 'wait' }, { kind: 'wait' }],
    ['setting up: then the secrets', facts({ underway: { kind: 'set-up', phase: 'secrets' } }), 'setting-up', 'Setting up…', 'Setting its keys', { kind: 'wait' }, { kind: 'wait' }],
    ['ready, this build, recorded for this account', facts({ deployed: deployedHere() }), 'ready', 'Ready', GOING_LIVE_READY_DETAIL, { kind: 'look-up' }, { kind: 'look-up' }],
    ['ready, recorded before accounts were recorded', facts({ deployed: deployedHere({ accountId: null }) }), 'ready', 'Ready', GOING_LIVE_READY_DETAIL, { kind: 'use' }, { kind: 'use' }],
    ['ready, not checked yet', facts({ connection: 'not-checked', accountId: null, deployed: deployedHere() }), 'ready', 'Ready', GOING_LIVE_READY_DETAIL, { kind: 'look-up' }, { kind: 'look-up' }],
    ['ready, no connection (it keeps working with its keys)', facts({ connection: 'not-connected', accountId: null, deployed: deployedHere() }), 'unknown', '', GOING_LIVE_IDLE_DETAIL, { kind: 'use' }, { kind: 'stop', message: DEPLOY_NOT_CONNECTED_ERROR }],
    ['an older build deployed: updated before the next use', facts({ deployed: deployedHere({ version: '18-older' }) }), 'ready', 'Ready', /updated before the next use$/, { kind: 'update' }, { kind: 'update' }],
    ['no build recorded: updated before the next use', facts({ deployed: deployedHere({ version: null }) }), 'ready', 'Ready', /updated before the next use$/, { kind: 'update' }, { kind: 'update' }],
    ['updating', facts({ deployed: deployedHere({ version: '18-older' }), underway: { kind: 'update', phase: 'upload' } }), 'updating', 'Updating…', 'Uploading the live service', { kind: 'wait' }, { kind: 'wait' }],
    ['the token cannot run the live service, nothing deployed', facts({ permission: 'no-permission' }), 'no-permission', 'The token cannot run the live service', 'Missing permission: Account · Workers Scripts · Edit',
      { kind: 'stop', message: LIVE_SETUP_REFUSED }, { kind: 'stop', message: LIVE_SETUP_REFUSED }],
    ['the token cannot run it, a service deployed (it keeps working; nothing redeployed)', facts({ permission: 'no-permission', deployed: deployedHere({ version: '18-older' }) }), 'no-permission', 'The token cannot run the live service', 'Missing permission: Account · Workers Scripts · Edit',
      { kind: 'use' }, { kind: 'stop', message: LIVE_SETUP_REFUSED }],
    ['a set-up Cloudflare refused for permission', facts({ last: { outcome: 'refused', details: 'Uploading the live service: Cloudflare answered 403 (error 10000).' } }), 'no-permission', 'The token cannot run the live service', 'Missing permission: Account · Workers Scripts · Edit',
      { kind: 'stop', message: LIVE_SETUP_REFUSED }, { kind: 'stop', message: LIVE_SETUP_REFUSED }],
    ['set-up failed', facts({ last: { outcome: 'failed', reason: LIVE_SETUP_FAILED, details: 'Uploading the live service: Cloudflare answered 400 (error 10021).' } }), 'failed', 'Set-up failed', LIVE_SETUP_FAILED,
      { kind: 'not-set-up', message: LIVE_SETUP_FAILED, prompt: 'open-settings', reason: 'failed' }, { kind: 'set-up' }],
    ['an update failed: looked up (and must be found) before each use, until Try again', facts({ deployed: deployedHere({ version: '18-older' }), last: { outcome: 'failed', reason: LIVE_SETUP_FAILED, details: null } }), 'failed', 'Set-up failed', LIVE_SETUP_FAILED, { kind: 'look-up', strict: true }, { kind: 'update' }],
    ['an update failed and there is no account to look it up for: no address', facts({ deployed: deployedHere({ version: '18-older', accountId: null }), last: { outcome: 'failed', reason: LIVE_SETUP_FAILED, details: null } }), 'failed', 'Set-up failed', LIVE_SETUP_FAILED,
      { kind: 'not-set-up', message: LIVE_SETUP_FAILED, prompt: 'open-settings', reason: 'failed' }, { kind: 'update' }],
    ['lost keys, a service recorded', facts({ keysStored: false, deployed: deployedHere() }), 'keys-lost', LIVE_KEYS_LOST_STATE, LIVE_KEYS_LOST_EXPLAINED, { kind: 'stop', message: LIVE_KEYS_LOST }, { kind: 'stop', message: LIVE_KEYS_LOST }],
    ['lost keys, even with no connection', facts({ connection: 'not-connected', accountId: null, keysStored: false, deployed: deployedHere() }), 'keys-lost', LIVE_KEYS_LOST_STATE, LIVE_KEYS_LOST_EXPLAINED, { kind: 'stop', message: LIVE_KEYS_LOST }, { kind: 'stop', message: LIVE_KEYS_LOST }],
    ['lost keys, found by a set-up (Cloudflare has the Worker)', facts({ keysStored: false, last: { outcome: 'keys-lost' } }), 'keys-lost', LIVE_KEYS_LOST_STATE, LIVE_KEYS_LOST_EXPLAINED, { kind: 'stop', message: LIVE_KEYS_LOST }, { kind: 'stop', message: LIVE_KEYS_LOST }],
  ]
  const seenStates = new Set()
  for (const [what, input, state, edge, detail, use, setUp] of CASES) {
    const forUse = ensureLiveService(input, 'use')
    const forSetUp = ensureLiveService(input, 'set-up')
    assert.equal(forUse.row.state, state, `${what}: the row`)
    assert.deepEqual(forSetUp.row, forUse.row, `${what}: the row does not depend on what was asked`)
    assert.equal(edgeText(forUse.row), edge, `${what}: its right-hand edge`)
    if (detail instanceof RegExp) assert.match(goingLiveRowDetail(forUse.row), detail, `${what}: its detail`)
    else assert.equal(goingLiveRowDetail(forUse.row), detail, `${what}: its detail`)
    assert.deepEqual(forUse.action, use, `${what}: a use`)
    assert.deepEqual(forSetUp.action, setUp, `${what}: Set up going live`)
    seenStates.add(state)
  }
  // Every state the spec's cell lists, and only those (plus "nothing to say yet").
  assert.deepEqual([...seenStates].sort(), ['failed', 'keys-lost', 'no-permission', 'not-set-up', 'ready', 'setting-up', 'unknown', 'updating'])
  // Nothing is ever set up on a use (D9): no input answers a use with a set-up.
  for (const [what, input] of CASES) assert.notEqual(ensureLiveService(input, 'use').action.kind, 'set-up', `${what}: never set up on a use`)
  // The build is in Details; Try again only beside "Set-up failed".
  assert.equal(ensureLiveService(facts({ deployed: deployedHere() }), 'use').row.details, `Live service build ${BUILD} at ${ADDRESS}`)
  assert.match(ensureLiveService(facts({ deployed: deployedHere({ version: '18-older' }) }), 'use').row.details, new RegExp(`build 18-older .* this TalkWeaver carries build ${BUILD}`))
  for (const [what, input, state] of CASES) assert.equal(goingLiveRowRetries(ensureLiveService(input, 'use').row), state === 'failed', `${what}: Try again only for a failed set-up`)
  // The keys-lost words: what resetting breaks, and how (there is no reset button).
  assert.match(LIVE_KEYS_LOST_EXPLAINED, /every live session, shared talk and Run link made with the old ones stops working/)
  assert.ok(LIVE_KEYS_LOST_EXPLAINED.includes(LIVE_WORKER_NAME) && LIVE_KEYS_LOST.startsWith(LIVE_KEYS_LOST_STATE))
  // The Worker named in those words is the one that is deployed.
  assert.equal(JSON.parse(readFileSync(join(repo, 'worker', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')).name, LIVE_WORKER_NAME)
  // What a finished set-up leaves.
  assert.equal(outcomeOf({ ok: true, baseUrl: ADDRESS, adminSecret: 'x' }), null)
  assert.equal(outcomeOf({ ok: false, error: DEPLOY_SUPERSEDED_ERROR }), null, 'a superseded set-up leaves nothing')
  assert.deepEqual(outcomeOf({ ok: false, error: LIVE_KEYS_LOST }), { outcome: 'keys-lost' })
  assert.deepEqual(outcomeOf({ ok: false, error: LIVE_SETUP_REFUSED, details: 'd' }), { outcome: 'refused', details: 'd' })
  assert.deepEqual(outcomeOf({ ok: false, error: LIVE_SETUP_FAILED, details: 'd' }), { outcome: 'failed', reason: LIVE_SETUP_FAILED, details: 'd' })
  console.log(`PASS 1: ${CASES.length} inputs to ensureLiveService produce every state of the Going live row, in the spec's words, with the action for a use and for "Set up going live"; nothing is set up on a use`)
}

// ── 2. The service, over the real set-up sequence and the fake API ──────────────────────────────
const BUNDLE = Buffer.from('// made-up bundle\nexport default { fetch() { return new Response("ok") } }\nexport class LiveSession {}\n')
// The wrangler version the app declares (the manifest records it; nothing here runs wrangler).
const shipped = workerDistFiles({ repo, bundle: BUNDLE, wrangler: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).dependencies?.wrangler ?? JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).devDependencies.wrangler })
const worlds = []

/**
 * One computer: Settings (config), the keys slot, the connection's status, and the fake API. The
 * connection hands out leave as cloudflare-connection.ts does (refused when it says the token cannot
 * run the live service).
 */
function computer(options = {}) {
  const fake = createFakeCloudflare({ tokens: { [TOKEN]: { accounts: [ACCOUNT, OTHER] }, [READER]: { accounts: [ACCOUNT], workers: 'read' } }, accounts: [{ id: ACCOUNT, name: 'Ada' }] })
  worlds.push(fake)
  const pc = {
    fake, config: {}, keys: options.keys ?? null, made: 0, deploys: 0, lookUps: 0, rows: [], told: [],
    connection: { connection: 'connected', permission: 'not-refused', accountId: ACCOUNT, token: TOKEN },
  }
  const fetch = fakeCloudflareFetch(fake)
  const authorise = async () => {
    const at = pc.connection
    if (at.connection !== 'connected') return { ok: false, error: DEPLOY_NOT_CONNECTED_ERROR }
    if (at.permission === 'no-permission') return { ok: false, error: LIVE_SETUP_REFUSED }
    const token = at.token
    return {
      ok: true,
      authorisation: {
        accountId: at.accountId,
        current: () => true,
        async run(launch) { return { superseded: false, result: await launch({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: at.accountId }) } },
        clean: (text) => String(text).split(token).join(TOKEN_REMOVED),
      },
    }
  }
  const files = () => ({ manifest: shipped.manifestText, bundle: shipped.bundle, config: shipped.configBytes })
  pc.service = createLiveService({
    facts: () => ({
      connection: pc.connection.connection, permission: pc.connection.permission, accountId: pc.connection.connection === 'connected' ? pc.connection.accountId : null,
      keysStored: pc.keys !== null,
      deployed: { baseUrl: pc.config.liveWorkerBaseUrl ?? null, version: pc.config.liveWorkerVersion ?? null, accountId: pc.config.liveWorkerAccountId ?? null },
      appBuild: BUILD,
    }),
    adminSecret: () => pc.keys?.adminSecret ?? null,
    deploy: (progress) => {
      pc.deploys += 1
      return deployLiveService({
        shipped: files, expectedBuild: BUILD, authorise,
        storedKeys: () => pc.keys,
        makeKeys: () => { pc.made += 1; pc.keys = pc.made === 1 ? NEW_KEYS : SECOND_KEYS; return pc.keys },
        shareHostname: () => null, shareDomainAttachedBefore: () => false, recordShareDomain: () => {},
        fetch, apiBase: () => 'http://127.0.0.1:9/client/v4',
        save: ({ baseUrl, accountId }) => Object.assign(pc.config, { liveWorkerBaseUrl: baseUrl, liveWorkerVersion: BUILD, liveWorkerAccountId: accountId }),
        timeoutMs: { upload: 2000, request: 2000 }, progress,
      })
    },
    lookUp: async (accountId) => {
      pc.lookUps += 1
      const answer = await lookUpLiveService({ shipped: files, expectedBuild: BUILD, authorise, fetch, apiBase: () => 'http://127.0.0.1:9/client/v4', accountId, timeoutMs: { upload: 2000, request: 2000 } })
      // A test may hold the answer back (a slow reply), to let something else happen first.
      const held = pc.hold
      if (held) { pc.hold = null; held.asked(); await held.released }
      return answer
    },
    forget: () => { delete pc.config.liveWorkerBaseUrl; delete pc.config.liveWorkerVersion; delete pc.config.liveWorkerAccountId },
    onChange: (row) => pc.rows.push(see(row)),
    tell: (message) => pc.told.push(see(message)),
    now: () => pc.clock ?? 0,
  })
  return pc
}
const writes = (pc, from = 0) => pc.fake.requests.slice(from).filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path}`)
const uploads = (pc) => pc.fake.requests.filter((request) => request.method === 'PUT' && request.path === `/accounts/${ACCOUNT}/workers/scripts/${LIVE_WORKER_NAME}`).length
const secretsSet = (pc) => pc.fake.requests.filter((request) => request.method === 'PATCH').map((request) => JSON.parse(request.body.toString()).secrets.ADMIN_SECRET.text)
async function thrown(promise) {
  try { await promise } catch (error) { observed.push({ message: error.message, details: error.details, prompt: error.prompt }); return error }
  assert.fail('expected a throw')
}

/**
 * The deployed Worker, as Go live meets it: GET /capabilities, and POST /sessions with the admin
 * secret it was given (the value the fake API received in secrets-bulk).
 */
function deployedWorker(pc) {
  return async (address, init = {}) => {
    const url = new URL(address)
    const worker = pc.fake.model.workers.get(ACCOUNT)?.get(LIVE_WORKER_NAME)
    if (url.origin !== ADDRESS || !worker) return new Response('no such Worker', { status: 404 })
    if (url.pathname === '/capabilities') return Response.json({ protocol: 2, build: BUILD })
    const given = secretsSet(pc).at(-1)
    if (url.pathname === '/sessions' && init.method === 'POST') {
      if (new Headers(init.headers).get('authorization') !== `Bearer ${given}`) return Response.json({ error: { message: 'unauthorised' } }, { status: 401 })
      return Response.json({ sessionId: 's1', presenterToken: 'p1', shortId: 'k1', expiresAt: Date.now() + 60_000 }, { status: 201 })
    }
    return new Response('not found', { status: 404 })
  }
}
/** live:go's own steps once it has an endpoint (src/main/index.ts): the capabilities, then a session. */
async function goLive(pc) {
  const endpoint = await pc.service.endpoint()
  const fetchWorker = deployedWorker(pc)
  const capabilities = await (await fetchWorker(`${endpoint.baseUrl}/capabilities`)).json()
  assert.deepEqual(capabilities, { protocol: 2, build: BUILD }, 'the live service answers as this build')
  const session = await fetchWorker(`${endpoint.baseUrl}/sessions`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.adminSecret}`, 'content-type': 'application/json' }, body: '{}' })
  return { endpoint: { ...endpoint, adminSecret: '[handed to Go live]' }, status: session.status }
}

{
  // First set-up from Settings ends Ready; Go live works afterwards.
  const pc = computer()
  assert.equal(pc.service.row().state, 'not-set-up')
  // Go live before it is set up: the prompt, and nothing sent to Cloudflare at all.
  const before = await thrown(pc.service.endpoint())
  assert.ok(before instanceof LiveServiceError)
  assert.deepEqual([before.kind, before.message, before.prompt], ['not-set-up', LIVE_NOT_SET_UP, 'open-settings'])
  assert.equal(pc.fake.requests.length, 0, 'nothing is set up on a use')
  const reply = see(await pc.service.setUp())
  assert.deepEqual([reply.ok, reply.row.state, reply.row.address, reply.row.build], [true, 'ready', ADDRESS, BUILD])
  assert.deepEqual(pc.rows.map((row) => `${row.state}${row.phase ? `/${row.phase}` : ''}`), ['setting-up/upload', 'setting-up/secrets', 'ready'], 'Setting up… (deploy, then secrets), then Ready')
  assert.deepEqual(pc.told, [LIVE_SETTING_UP_NOTICE])
  assert.deepEqual([pc.config.liveWorkerBaseUrl, pc.config.liveWorkerVersion, pc.config.liveWorkerAccountId, pc.made], [ADDRESS, BUILD, ACCOUNT, 1], 'the address kept with this build and its account; keys made once')
  const went = await goLive(pc)
  assert.equal(went.status, 201, 'Go live makes a session with the keys the set-up gave the Worker')
  assert.equal(pc.lookUps, 1, 'and the address was looked up at Cloudflare first')
  assert.equal(uploads(pc), 1)
  console.log('PASS 2: first set-up from Settings goes Setting up… (deploy, then secrets) → Ready; Go live then makes a session with the keys it set; nothing was set up by the use before it')
}

{
  // A newer app build: exactly one update before the next use, with the stored keys; the person is told.
  const pc = computer()
  await pc.service.setUp()
  pc.config.liveWorkerVersion = '18-older' // as an install of the previous version left it
  pc.rows.length = 0
  pc.told.length = 0
  assert.match(goingLiveRowDetail(pc.service.row()), /updated before the next use$/)
  const [a, b] = await Promise.all([goLive(pc), pc.service.endpoint().then(() => 'second use')])
  const c = await goLive(pc)
  assert.deepEqual([a.status, b, c.status], [201, 'second use', 201])
  assert.equal(uploads(pc), 2, 'one update (the first upload was the set-up)')
  assert.equal(pc.deploys, 2)
  assert.deepEqual(pc.told, [LIVE_UPDATING_NOTICE], 'the person is told once: "Updating the live service…"')
  assert.ok(pc.rows.some((row) => row.state === 'updating'), 'the row read Updating… while it ran')
  assert.deepEqual([pc.made, secretsSet(pc)], [1, [NEW_KEYS.adminSecret, NEW_KEYS.adminSecret]], 'no new keys: the stored ones were set again')
  assert.equal(pc.config.liveWorkerVersion, BUILD)
  console.log('PASS 3: a newer app build updates the live service once before the next use (two uses at once share it), with the stored keys, saying "Updating the live service…"')
}

{
  // Lost keys with a deployed service: the stop, and nothing at all sent; only an explicit reset makes new keys.
  const pc = computer()
  await pc.service.setUp()
  pc.keys = null // the slot is gone (a new computer with the old settings)
  pc.service.refresh()
  const sent = pc.fake.requests.length
  assert.equal(pc.service.row().state, 'keys-lost')
  assert.equal(goingLiveRowDetail(pc.service.row()), LIVE_KEYS_LOST_EXPLAINED)
  const used = await thrown(pc.service.endpoint())
  assert.deepEqual([used.message, used.prompt], [LIVE_KEYS_LOST, null])
  pc.config.liveWorkerVersion = '18-older' // not even a newer build redeploys
  const asked = see(await pc.service.setUp())
  assert.deepEqual([asked.ok, asked.error, asked.row.state], [false, LIVE_KEYS_LOST, 'keys-lost'])
  assert.deepEqual([pc.fake.requests.length - sent, pc.made, pc.deploys], [0, 1, 1], 'nothing sent to Cloudflare, no keys made, nothing redeployed')
  // Check again while the Worker is still there: still the stop (a lookup is a read).
  await pc.service.look('asked')
  assert.deepEqual([pc.service.row().state, writes(pc, sent)], ['keys-lost', []])
  // The reset, done on purpose: the Worker deleted in the dashboard, then Check again.
  pc.fake.model.workers.get(ACCOUNT).delete(LIVE_WORKER_NAME)
  await pc.service.look('asked')
  assert.deepEqual([pc.service.row().state, pc.service.row().note, pc.config.liveWorkerBaseUrl], ['not-set-up', 'not-found', undefined])
  const again = await pc.service.setUp()
  assert.deepEqual([again.ok, again.row.state, pc.made, secretsSet(pc).at(-1)], [true, 'ready', 2, SECOND_KEYS.adminSecret], 'only then are new keys made')
  // The sequence's own stop: no address in Settings, the Worker at Cloudflare, no keys here.
  const fresh = computer()
  fresh.fake.model.workers.set(ACCOUNT, new Map([[LIVE_WORKER_NAME, { uploads: 1, secrets: ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET'], migrationTag: 'v4', module: null, metadata: null, workersDev: true }]]))
  const stopped = await fresh.service.setUp()
  assert.deepEqual([stopped.ok, stopped.error, stopped.row.state, fresh.made, writes(fresh)], [false, LIVE_KEYS_LOST, 'keys-lost', 0, []])
  const stillStopped = await fresh.service.setUp()
  assert.deepEqual([stillStopped.error, fresh.deploys], [LIVE_KEYS_LOST, 1], 'asked again: the stop, without asking Cloudflare again')
  console.log('PASS 4: lost keys with a deployed service stop with what resetting breaks; nothing is sent or redeployed; only the Worker deleted, then Check again, leads to new keys')
}

{
  // A Worker deleted in the dashboard is found before its address is handed out, and reads Not set up.
  const pc = computer()
  await pc.service.setUp()
  pc.fake.model.workers.get(ACCOUNT).delete(LIVE_WORKER_NAME)
  const sent = pc.fake.requests.length
  const gone = await thrown(pc.service.endpoint())
  assert.deepEqual([gone.kind, gone.message, gone.prompt], ['not-set-up', LIVE_NOT_SET_UP, 'open-settings'], 'no address is handed out (a publish then goes up without live features)')
  assert.deepEqual(pc.fake.requests.slice(sent).map((request) => `${request.method} ${request.path}`), [`GET /accounts/${ACCOUNT}/workers/services/${LIVE_WORKER_NAME}`], 'one lookup, for the recorded account; nothing written')
  assert.deepEqual([pc.service.row().state, goingLiveRowDetail(pc.service.row()), pc.config.liveWorkerBaseUrl], ['not-set-up', GOING_LIVE_NOT_FOUND_DETAIL, undefined])
  // Settings opened: looked up at most once a minute.
  const ok = computer()
  await ok.service.setUp()
  ok.clock = 1000
  await ok.service.look('opened')
  await ok.service.look('opened')
  ok.clock = 1000 + LOOK_INTERVAL_MS
  await ok.service.look('opened')
  assert.equal(ok.lookUps, 2, 'opening Settings looks it up at most once a minute')
  assert.equal(ok.service.row().state, 'ready')
  // The lookup is made for the account recorded with the address, never another: the connection on another account uses it as it is (publishing refuses it by its account).
  ok.connection.accountId = OTHER
  ok.service.refresh()
  const elsewhere = await ok.service.endpoint()
  assert.deepEqual([elsewhere.accountId, ok.lookUps, ok.service.row().note], [ACCOUNT, 2, 'other-account'])
  console.log('PASS 5: a recorded address is looked up for its account before it is handed out; a Worker deleted in the dashboard reads Not set up and its address is not used')
}

{
  // A token lacking the live-service permission.
  const pc = computer()
  pc.connection.permission = 'no-permission'
  const row = pc.service.row()
  assert.deepEqual([row.state, goingLiveRowDetail(row), edgeText(row)], ['no-permission', 'Missing permission: Account · Workers Scripts · Edit', 'The token cannot run the live service'])
  const refused = await pc.service.setUp()
  assert.deepEqual([refused.ok, refused.error, pc.fake.requests.length], [false, LIVE_SETUP_REFUSED, 0], 'refused before anything is sent')
  // A token the check could not tell (it may read Workers, not edit them): Cloudflare refuses the upload, and the row says so.
  const reader = computer()
  reader.connection.token = READER
  const tried = await reader.service.setUp()
  assert.deepEqual([tried.ok, tried.error, tried.row.state, tried.row.permission], [false, LIVE_SETUP_REFUSED, 'no-permission', 'Account · Workers Scripts · Edit'])
  assert.equal(tried.details, 'Uploading the live service: Cloudflare answered 403 (error 10000).')
  // The permission added: a new token is a new connection, and the refusal no longer describes it.
  reader.connection.token = TOKEN
  reader.connection.permission = 'unknown'
  reader.service.refresh()
  assert.equal(reader.service.row().state, 'not-set-up')
  console.log('PASS 6: a token lacking the live-service permission shows "The token cannot run the live service" naming Account · Workers Scripts · Edit, from the check or from Cloudflare\'s refusal')
}

{
  // Set-up failed, with the reason and Try again; and no connection at all.
  const pc = computer()
  pc.fake.model.answer = (request) => (request.method === 'PUT' && request.path.endsWith(`/scripts/${LIVE_WORKER_NAME}`) ? { status: 400, body: { success: false, errors: [{ code: 10021, message: 'no' }], messages: [], result: null } } : null)
  const failed = await pc.service.setUp()
  assert.deepEqual([failed.ok, failed.row.state, goingLiveRowDetail(failed.row), edgeText(failed.row), failed.row.details], [false, 'failed', LIVE_SETUP_FAILED, 'Set-up failed', 'Uploading the live service: Cloudflare answered 400 (error 10021).'])
  // A use after it: the reason, the prompt, and Details (a publish shows "…not set up: Settings → Cloudflare. The live service could not be set up.").
  const use = await thrown(pc.service.endpoint())
  assert.deepEqual([use.kind, use.message, use.prompt, use.details], ['failed', LIVE_SETUP_FAILED, 'open-settings', 'Uploading the live service: Cloudflare answered 400 (error 10021).'])
  pc.fake.model.answer = null
  const retried = await pc.service.setUp()
  assert.deepEqual([retried.ok, retried.row.state], [true, 'ready'], 'Try again')
  const none = computer()
  none.connection.connection = 'not-connected'
  const notConnected = await thrown(none.service.endpoint())
  assert.deepEqual([notConnected.message, notConnected.prompt, none.service.row().state], [LIVE_NOT_SET_UP, 'open-settings', 'unknown'], 'not connected: "Going live is not set up" with Open Settings')
  console.log('PASS 7: a failed set-up reads "Set-up failed" with its reason, Details in numbers and Try again; not connected, Go live is told to open Settings')
}

// ── 3. The prompt where Go live and Share for comments are pressed ─────────────────────────────
{
  assert.deepEqual(liveSetupPromptCopy('open-settings'), { title: 'Going live is not set up', action: 'Open Settings' })

  const slides = [{ id: 'slide-a', title: 'First slide', blocks: [] }, { id: 'slide-b', title: 'Second slide', blocks: [] }, { id: 'slide-c', title: 'Third slide', blocks: [] }]
  const html = await buildDeckHtmlFromModel({ title: 'Go live prompt test', slides, meta: {} })
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(error.message))
  const dom = new JSDOM(html, {
    url: 'https://talk.example.test/?presenter=1&session=go-live-prompt#slide-a', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.BroadcastChannel = class { postMessage() {} addEventListener() {} }
      window.ResizeObserver = class { observe() {} disconnect() {} }
    },
  })
  const { window } = dom
  const { document } = window
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const key = (value) => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }))
  const activeId = () => document.querySelector('.slide.active')?.dataset.id
  await settle()
  assert.equal(activeId(), 'slide-a')

  // jsdom makes no trusted events: the prompt is told to take these as a person's (the default is tested below).
  const asPerson = { trusted: () => true }
  const press = (button) => {
    button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 }))
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }))
  }
  const calls = { openSettings: 0 }
  const handlers = { openSettings: async () => { calls.openSettings += 1 } }
  // The prompt: "Going live is not set up" with Open Settings and Not now, and nothing that sets anything up (fix round 2).
  const prompt = showLiveSetupPrompt(document, 'open-settings', LIVE_NOT_SET_UP, handlers, asPerson)
  const part = (name) => prompt.querySelector(`[data-part="${name}"]`)
  assert.deepEqual([prompt.id, prompt.getAttribute('role'), prompt.querySelector('div').textContent, part('action').textContent, part('close').textContent, part('message').hidden],
    [LIVE_SETUP_PROMPT_ID, 'status', 'Going live is not set up', 'Open Settings', 'Not now', true], 'the prompt in the spec\'s words; not a dialog')
  assert.deepEqual([...prompt.querySelectorAll('button')].map((button) => button.textContent), ['Open Settings', 'Not now'], 'its only buttons: no set-up from the presenter')
  assert.ok(!/set up going live now/i.test(prompt.textContent))
  assert.notEqual(document.activeElement, part('action'), 'it takes no focus')
  key('ArrowRight')
  await settle()
  assert.equal(activeId(), 'slide-b', 'the presenter keeps presenting while it shows')
  press(part('action'))
  assert.deepEqual([calls.openSettings, document.getElementById(LIVE_SETUP_PROMPT_ID)], [1, null], 'Open Settings takes the person to the Settings row, and the prompt goes')
  const later = showLiveSetupPrompt(document, 'open-settings', LIVE_NOT_SET_UP, handlers, asPerson)
  assert.equal(document.querySelectorAll(`#${LIVE_SETUP_PROMPT_ID}`).length, 1, 'one prompt at a time')
  press(later.querySelector('[data-part="close"]'))
  assert.deepEqual([calls.openSettings, document.getElementById(LIVE_SETUP_PROMPT_ID)], [1, null], 'Not now closes it')

  // Only a person's pointer press acts; the keyboard stays with the slides (fix round 1, kept).
  {
    // A synthetic click — a page script's, or an embed's — does nothing.
    const untrusted = showLiveSetupPrompt(document, 'open-settings', LIVE_NOT_SET_UP, handlers)
    for (const name of ['action', 'close']) {
      const button = untrusted.querySelector(`[data-part="${name}"]`)
      button.click()
      press(button)
    }
    assert.deepEqual([calls.openSettings, Boolean(document.getElementById(LIVE_SETUP_PROMPT_ID))], [1, true], 'an untrusted click neither opens Settings nor closes the prompt')
    // A pointer press never leaves a button focused: mousedown is refused focus.
    const focusing = showLiveSetupPrompt(document, 'open-settings', LIVE_NOT_SET_UP, handlers, asPerson)
    for (const name of ['action', 'close']) {
      const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 })
      focusing.querySelector(`[data-part="${name}"]`).dispatchEvent(down)
      assert.equal(down.defaultPrevented, true, `${name}: a press takes no focus`)
    }
    // Focused all the same (a press dragged off it, say): Space and Enter go to the slides, and the
    // click a browser makes from a key (detail 0) does nothing.
    const before = activeId()
    for (const name of ['action', 'close']) {
      const button = focusing.querySelector(`[data-part="${name}"]`)
      for (const keyName of [' ', 'Enter']) {
        button.focus()
        assert.equal(document.activeElement, button)
        button.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }))
        assert.notEqual(document.activeElement, button, `${name}, ${JSON.stringify(keyName)}: the button lets go of the focus at the key`)
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
      }
    }
    await settle()
    assert.deepEqual([calls.openSettings, Boolean(document.getElementById(LIVE_SETUP_PROMPT_ID))], [1, true], 'a key on a focused button does nothing')
    assert.notEqual(activeId(), before, 'Space still advances the slides')
    document.getElementById(LIVE_SETUP_PROMPT_ID)?.remove()
  }
  assert.deepEqual(errors, [])
  window.close()

  // The share sheet: the same prompt, Open Settings only.
  let sheet = shareSheetReducer(initialShareSheet(), { type: 'inspected', share: null, foreignShareUrl: null })
  sheet = shareSheetReducer(sheet, { type: 'failed', error: LIVE_NOT_SET_UP, setup: 'open-settings' })
  assert.deepEqual(shareSheetView(sheet).setupPrompt, { prompt: 'open-settings', title: 'Going live is not set up', action: 'Open Settings' })
  sheet = shareSheetReducer(shareSheetReducer(sheet, { type: 'creating' }), { type: 'created', share: { key: 'k', url: 'https://x.example/s/1', liveUpdates: true, proposals: true, revision: 1 } })
  assert.equal(shareSheetView(sheet).setupPrompt, null, 'shared: the prompt is gone')
  const plain = shareSheetReducer(shareSheetReducer(initialShareSheet(), { type: 'inspected', share: null, foreignShareUrl: null }), { type: 'failed', error: 'Could not share this talk.' })
  assert.equal(shareSheetView(plain).setupPrompt, null, 'another failure offers nothing')
  const sheetSource = readSource(join(repo, 'src/renderer/src/components/ShareSheet.tsx'))
  assert.ok(!/liveService\.setUp/.test(sheetSource), 'the share sheet sets nothing up')
  const bridgeSource = readSource(join(repo, 'src/preload/present-live-bridge.ts')).replace(/\/\/[^\n]*/g, '')
  assert.ok(!/live-service:set-up/.test(bridgeSource), 'the presenter window never asks for a set-up')
  console.log('PASS 8: Go live and Share for comments with nothing set up say "Going live is not set up" and offer only Open Settings (and Not now); only a person\'s press acts; the presenter keeps presenting throughout')
}

{
  // The main process: nothing set up on a use; the prompt reaches Go live and the share sheet; the row has its IPC.
  const main = readSource(join(repo, 'src/main/index.ts'))
  const ensure = main.slice(main.indexOf('async function ensureLiveWorker('), main.indexOf('// ── Pre-work for a planned Run'))
  assert.ok(!/deployLiveWorker\(/.test(ensure.replace(/\/\/[^\n]*/g, '')), 'ensureLiveWorker sets nothing up itself')
  assert.ok(/return liveService\(\)\.endpoint\(\)/.test(ensure))
  assert.ok(/setup: cause\.prompt/.test(main) && /function sharedTalkError[\s\S]{0,400}error\.prompt/.test(main), 'Go live and Share for comments carry the prompt')
  assert.ok(/ipcMain\.handle\('live-service:set-up'/.test(main) && /ipcMain\.handle\('live-service:status'/.test(main))
  assert.ok(/deploy: \(progress\) => deployLiveWorker\(progress\)/.test(main) && /lookUp: \(accountId\) => lookUpLiveService\(/.test(main))
  const settingsRow = readSource(join(repo, 'src/renderer/src/components/CloudflareSettings.tsx'))
  assert.ok(/data-cloudflare="live-service"/.test(settingsRow) && /goingLiveRowEdge\(live\)/.test(settingsRow) && /window\.tw\.liveService\.setUp\(\)/.test(settingsRow))
  console.log('PASS 9: the app uses the service: ensureLiveWorker sets nothing up, Go live and Share for comments carry the prompt, the row has its own IPC')
}

// ── Fix round 1 ─────────────────────────────────────────────────────────────────────────────────
{
  // 1. A slow lookup that answers "missing" after a deployment recreated the Worker never erases it.
  const pc = computer()
  await pc.service.setUp()
  pc.fake.model.workers.get(ACCOUNT).delete(LIVE_WORKER_NAME) // gone at Cloudflare: the lookup will say so…
  let asked
  let release
  pc.hold = { asked: () => asked(), released: new Promise((resolve) => { release = resolve }) }
  const lookAsked = new Promise((resolve) => { asked = resolve })
  const looking = pc.service.look('asked')
  await lookAsked // …and its answer is held
  pc.config.liveWorkerVersion = '18-older' // a newer app build: the next use updates, recreating the Worker
  const used = await pc.service.endpoint()
  assert.equal(used.baseUrl, ADDRESS)
  assert.ok(pc.fake.model.workers.get(ACCOUNT).has(LIVE_WORKER_NAME), 'the update recreated the Worker')
  release()
  await looking
  assert.deepEqual([pc.config.liveWorkerBaseUrl, pc.config.liveWorkerVersion, pc.service.row().state], [ADDRESS, BUILD, 'ready'], 'the stale "missing" did not clear the fresh deployment')
  // And while a deployment is under way when the answer comes: also not cleared.
  const during = computer()
  await during.service.setUp()
  during.fake.model.workers.get(ACCOUNT).delete(LIVE_WORKER_NAME)
  let askedDuring
  let releaseDuring
  during.hold = { asked: () => askedDuring(), released: new Promise((resolve) => { releaseDuring = resolve }) }
  const duringAsked = new Promise((resolve) => { askedDuring = resolve })
  const lookingDuring = during.service.look('asked')
  await duringAsked
  let releaseUpload
  during.fake.model.delay = (request) => (request.method === 'PUT' && request.path.endsWith(`/scripts/${LIVE_WORKER_NAME}`) ? new Promise((resolve) => { releaseUpload = resolve }) : null)
  const settingUp = during.service.setUp()
  await new Promise((resolve) => setTimeout(resolve, 20))
  releaseDuring()
  await lookingDuring
  during.fake.model.delay = null
  releaseUpload()
  await settingUp
  assert.deepEqual([during.config.liveWorkerBaseUrl, during.service.row().state], [ADDRESS, 'ready'], 'an answer that arrives while a set-up runs clears nothing')
  console.log('PASS 11 (fix 1): a lookup\'s "missing" clears the record only if no deployment ran or finished since it was asked')
}

{
  // 2. After a failed update, an address is handed out only once a lookup has found the Worker.
  const failUpload = (pc) => { pc.fake.model.answer = (request) => (request.method === 'PUT' && request.path.endsWith(`/scripts/${LIVE_WORKER_NAME}`) ? { status: 400, body: { success: false, errors: [{ code: 10021, message: 'no' }], messages: [], result: null } } : null) }
  // a. The Worker deleted in the dashboard, the update fails: no address.
  const gone = computer()
  await gone.service.setUp()
  gone.fake.model.workers.get(ACCOUNT).delete(LIVE_WORKER_NAME)
  gone.config.liveWorkerVersion = '18-older'
  failUpload(gone)
  const refusedAddress = await thrown(gone.service.endpoint())
  assert.deepEqual([refusedAddress.kind, refusedAddress.prompt], ['not-set-up', 'open-settings'], 'the dead address is not handed out (a publish goes up without it)')
  assert.equal(gone.config.liveWorkerBaseUrl, undefined, 'and its record is dropped')
  // b. The Worker still there, the update fails: looked up, found, used; and looked up again on the next use.
  const kept = computer()
  await kept.service.setUp()
  kept.config.liveWorkerVersion = '18-older'
  failUpload(kept)
  const lookUpsBefore = kept.lookUps
  const after = await kept.service.endpoint()
  assert.deepEqual([after.baseUrl, kept.lookUps - lookUpsBefore, kept.service.row().state], [ADDRESS, 1, 'failed'], 'found: the service as it is is used, the row says the update failed')
  kept.fake.model.workers.get(ACCOUNT).delete(LIVE_WORKER_NAME) // deleted after that
  const later = await thrown(kept.service.endpoint())
  assert.deepEqual([later.kind, kept.config.liveWorkerBaseUrl], ['not-set-up', undefined], 'the next use looks again, finds it gone and hands out no address')
  assert.equal(kept.lookUps - lookUpsBefore, 2)
  // c. The update fails and the lookup gets no answer: no address either.
  const silent = computer()
  await silent.service.setUp()
  silent.config.liveWorkerVersion = '18-older'
  silent.fake.model.answer = (request) => (request.method === 'PUT' && request.path.endsWith(`/scripts/${LIVE_WORKER_NAME}`) ? { status: 400, body: { success: false, errors: [{ code: 10021, message: 'no' }], messages: [], result: null } } : null)
  let failedOnce = false
  const inner = silent.fake.model.answer
  silent.fake.model.answer = (request) => {
    const answer = inner(request)
    if (answer) { failedOnce = true; return answer }
    // Once the upload has failed, Cloudflare stops answering the lookup.
    return failedOnce && request.method === 'GET' && request.path.includes('/workers/services/') ? { status: 503, body: 'unavailable' } : null
  }
  const noAnswer = await thrown(silent.service.endpoint())
  assert.equal(noAnswer.message, LIVE_SETUP_FAILED, 'no answer to the lookup: no address, with the update\'s reason')
  assert.equal(silent.config.liveWorkerBaseUrl, ADDRESS, 'an unanswered lookup drops nothing')
  const stillSilent = await thrown(silent.service.endpoint())
  assert.deepEqual([stillSilent.message, silent.service.row().state], [LIVE_SETUP_FAILED, 'failed'], 'the next use: still no answer, still no address')
  // d. The accepted case stays: a token that cannot read Workers keeps using the deployed service (spec, "Migration").
  silent.fake.model.answer = null
  silent.connection.permission = 'no-permission'
  silent.service.refresh()
  assert.equal((await silent.service.endpoint()).baseUrl, ADDRESS)
  console.log('PASS 12 (fix 2): after a failed update the address is handed out only once a lookup finds the Worker, on every use; absent or unanswered: no address')
}

{
  // 3. In the main process, a set-up is accepted only from a window's own top frame.
  const topFrame = {}
  const childFrame = {}
  assert.equal(askedFromTopFrame({ sender: { mainFrame: topFrame }, senderFrame: topFrame }), true)
  assert.equal(askedFromTopFrame({ sender: { mainFrame: topFrame }, senderFrame: childFrame }), false, 'an embedded frame cannot set the live service up')
  assert.equal(askedFromTopFrame({ sender: { mainFrame: topFrame }, senderFrame: null }), false, 'a frame that has gone cannot either')
  assert.equal(askedFromTopFrame({}), false)
  const main = readSource(join(repo, 'src/main/index.ts'))
  // Fix round 2: and only from an editor window (where the Settings row is). A presenter window is refused.
  const editors = new Set([7])
  const isEditor = (id) => editors.has(id)
  assert.equal(setUpAllowedFrom({ sender: { id: 7, mainFrame: topFrame }, senderFrame: topFrame }, isEditor), true, 'Settings, in an editor window: allowed')
  assert.equal(setUpAllowedFrom({ sender: { id: 9, mainFrame: topFrame }, senderFrame: topFrame }, isEditor), false, 'a presenter window\'s top frame: refused')
  assert.equal(setUpAllowedFrom({ sender: { id: 7, mainFrame: topFrame }, senderFrame: childFrame }, isEditor), false, 'a frame embedded in an editor window: refused')
  assert.equal(setUpAllowedFrom({ sender: { mainFrame: topFrame }, senderFrame: topFrame }, isEditor), false)
  assert.match(main, /ipcMain\.handle\('live-service:set-up', \(event\) => \{(?:\s*\/\/[^\n]*)*\s*if \(!setUpAllowedFrom\(event, \(id\) => editorWindows\.has\(id\)\)\) return \{ ok: false/, 'the handler refuses any window but an editor window, and any frame but its top one')
  console.log('PASS 13 (fix 3, round 2): a set-up is accepted only from an editor window\'s top frame, never a presenter window; the presenter prompt cannot set anything up (PASS 8)')
}

// ── Nothing secret anywhere ─────────────────────────────────────────────────────────────────────
{
  const seen = JSON.stringify(observed)
  assert.ok(observed.length > 20, `plenty looked at (${observed.length})`)
  for (const secret of SECRETS) assert.ok(!seen.includes(secret), 'no token or key in any row, reply, error or notice')
  const requests = worlds.flatMap((fake) => fake.requests)
  for (const request of requests) for (const secret of SECRETS) assert.ok(!`${request.path}${request.search ?? ''}`.includes(secret), 'no secret in a request address')
  console.log(`PASS 10: no token or key in ${observed.length} rows, replies, errors and notices, nor in any of ${requests.length} request addresses`)
}
process.stdout.write = write
process.stderr.write = writeErr
const output = printed.join('')
for (const secret of SECRETS) assert.ok(!output.includes(secret), 'no secret value in this test\'s output')
console.log(`going live row: every state from the pure function, set-up and update against the fake API, the prompt, no secret printed — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
