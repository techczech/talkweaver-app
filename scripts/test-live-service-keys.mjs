// A key per computer (going live from several Macs, decision T1, ticket 02, and the decisions R1 to
// R8 taken after its review). The seams:
//   1. computerState (live-service.ts) and uploadDecision (live-service-key.ts): the spec's states
//      S1 to S8 and THE build comparison, from explicit inputs, one row each;
//   2. the secrets requests (live-service-upload.ts): add one key, remove one key, and nothing else;
//   3. the stored keys (live-service-key.ts): one entry per live service, the 0.38.2 blob read as
//      `legacy`, a slot that cannot be read, the store's rules;
//   4. the set-up sequence and the survey (live-service-deploy.ts) and the share-address action
//      (live-service-share-domain.ts) against the fake Cloudflare API and a stand-in for the live
//      service whose accepted keys are the secrets the fake API was sent, and whose tokens are signed
//      with ITS signing key. No network.
// Invariants stated here and checked below:
//   R1 no request of any journey names a signing secret, in an address, a header or a body; a first
//      set-up's one secrets request names this computer's key and nothing else;
//   R2 a set-up or a code update sends no DELETE and touches no domain or route; the share-address
//      action attaches and removes exactly the one hostname it names, never with an override, and
//      removes only a hostname this computer's Settings record;
//   R3 code is uploaded only over a build that was read and is older; anything else stops;
//   R4 a slot that cannot be read stops set-up and survey: no key made, nothing written, nothing sent;
//   R5 a computer's id is made with its key and lives with it; a copied config.json names no secret;
//   R6 keys are kept per live service; none is shown to another service or removed by a refusal;
//   R8 the stand-in can see the damage: a re-keyed live service fails every earlier token;
//   - a key is stored before it is sent; a failed send keeps it and the retry sends the same key;
//   - waiting to be accepted backs off, stops within a minute, and tells "not yet accepted" from
//     "the live service does not answer"; its timers do not keep the process alive;
//   - no key in a result, Details, an address, a header other than Authorization to the live
//     service, Settings, or this test's output.
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computerState } from '../src/main/live-service.ts'
import {
  LIVE_APP_OLDER, LIVE_KEYS_FAILED, LIVE_KEY_NOT_ADDED, LIVE_KEY_NOT_STORED, LIVE_KEY_UNREADABLE, LIVE_NOT_ACCEPTED_YET, LIVE_OVERWRITTEN, LIVE_SETUP_FAILED, LIVE_UPDATE_PENDING, LIVE_UNREACHABLE,
  LIVE_VERSION_UNREADABLE, deployLiveService, surveyLiveService,
} from '../src/main/live-service-deploy.ts'
import * as keyModule from '../src/main/live-service-key.ts'
import * as uploadModule from '../src/main/live-service-upload.ts'
import {
  SHARE_DOMAIN_IN_USE, changeShareAddress, shareDomainEntries,
} from '../src/main/live-service-share-domain.ts'
import { TOKEN_REMOVED, send } from '../src/main/cloudflare-connection.ts'
import { validComputerId as workerValidComputerId } from '../worker/admin-keys.ts'
import { WORKERS_SUBDOMAIN, createFakeCloudflare, fakeCloudflareFetch, workerDomainId } from './lib/cloudflare-api-stub.mjs'
import { instantClock, keyProfile, liveWorkerDouble } from './lib/live-worker-double.mjs'
import { workerDistFiles } from './lib/worker-dist.mjs'
import { readSource } from './lib/read-source.mjs'

const {
  ACCEPT_WAIT_MS, KEY_BLOB_FORMAT, KEY_UNREADABLE, KeyStoreUnreadable, acceptedKey, buildNumber, computerNameOrNull, createComputerKeyStore, defaultComputerName, keyBlob, keyIsFor,
  keyToPresent, liveAddressOrNull, newComputerId, readKeyBlob, removeComputerKey, sendWithHeldKeys, unreferencedWait, uploadDecision, waitForKey,
} = keyModule
const { addKeyBody, addKeyRequest, computerSecretName, planLiveServiceUpload, removeKeyBody, removeKeyRequest, validComputerId, verifyShippedBundle, workersDevRequest } = uploadModule

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const started = Date.now()
const printed = []
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest) }

const TOKEN = ['made', 'up', 'keys', 'token', '0123456789abcdef'].join('-') // gitleaks:allow (made-up test value)
const LEGACY_KEY = ['made-up-legacy-admin', 'abcdef0123456789'].join('-') // gitleaks:allow (made-up test value)
const LEGACY_SIGNING = ['made-up-legacy-signing', 'abcdef0123456789'].join('-') // gitleaks:allow (made-up test value)
const OTHER_MAC = { computerId: 'eeee4444ffff5555', key: ['made-up-other-mac-admin', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
const ACCOUNT = 'acc0keys'
const ACCOUNT_B = 'acc0other'
const NAME = 'talkweaver-live-sessions'
const ADDRESS = `https://${NAME}.${WORKERS_SUBDOMAIN}.workers.dev`
const SUBDOMAIN_B = 'other-stand-in'
const ADDRESS_B = `https://${NAME}.${SUBDOMAIN_B}.workers.dev`
const BUILD = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(repo, 'worker', 'recovery-protocol.ts'), 'utf8'))[1]
const OLDER = '20-before-computer-keys'
const SIGNING_NAME = 'SESSION_SIGNING_SECRET'
const script = `/accounts/${ACCOUNT}/workers/scripts/${NAME}`
const observed = []
const see = (value) => { observed.push(value?.ok ? { ...value, adminSecret: '[handed to the caller]' } : value); return value }
/** Every profile a journey made: its slot (for the generated keys) and its config.json. */
const profiles = []
const profile = (options) => { const made = keyProfile(options); profiles.push(made); return made }
const legacyBlob = () => JSON.stringify({ adminSecret: LEGACY_KEY, signingSecret: LEGACY_SIGNING })
const legacyProfile = () => profile({ text: legacyBlob(), config: { liveWorkerAccountId: ACCOUNT, liveWorkerBaseUrl: ADDRESS, liveWorkerVersion: OLDER } })
const service = (accountId = ACCOUNT, baseUrl = ADDRESS) => ({ accountId, workerName: NAME, baseUrl })
const legacyEntry = { accountId: ACCOUNT, workerName: NAME, computerId: 'legacy', key: LEGACY_KEY, kind: 'legacy' }

// ── 1. The states S1 to S8, and THE build comparison ────────────────────────────────────────────
{
  const inputs = (over = {}) => ({ worker: 'present', recorded: 'this-account', key: 'own', answer: 'accepted', workerBuild: BUILD, appBuild: BUILD, ...over })
  const ROWS = [
    ['S1', 'no Worker in the account, no key', inputs({ worker: 'absent', recorded: 'none', key: 'none', answer: 'unknown', workerBuild: null })],
    ['S1', 'nothing known yet and nothing recorded', inputs({ worker: 'unknown', recorded: 'none', key: 'none', answer: 'unknown', workerBuild: null })],
    ['S2', 'the 0.38.2 key held and accepted', inputs({ key: 'legacy' })],
    ['S2', 'the 0.38.2 key held, the Worker still the older build (not asked yet)', inputs({ key: 'legacy', answer: 'unknown', workerBuild: OLDER })],
    ['S3', 'Worker present, no key here', inputs({ recorded: 'none', key: 'none', answer: 'unknown' })],
    ['S3', 'token valid, Worker present, the live service unreachable, no key', inputs({ recorded: 'none', key: 'none', answer: 'unknown', workerBuild: null })],
    ['S3', 'a key stored by a set-up that never finished (nothing recorded), refused', inputs({ recorded: 'none', answer: 'refused' })],
    ['S3', 'no key here, and a build that cannot be ordered against this app\'s: not "updates first"', inputs({ recorded: 'none', key: 'none', answer: 'unknown', workerBuild: `${buildNumber(BUILD)}-other-text` })],
    ['S4', 'own key held and accepted', inputs()],
    ['S4', 'own key held, token valid, the live service unreachable: not taken as removed', inputs({ answer: 'unknown', workerBuild: null })],
    ['S4', 'own key held, Cloudflare not asked yet', inputs({ worker: 'unknown', answer: 'unknown', workerBuild: null })],
    ['S5', 'own key held, the live service answers 401', inputs({ answer: 'refused' })],
    ['S5', 'the 0.38.2 key held, the live service answers 401 (the Worker was made again)', inputs({ key: 'legacy', answer: 'refused' })],
    ['S6', 'an older Worker that knows only ADMIN_SECRET, no key here', inputs({ recorded: 'none', key: 'none', answer: 'unknown', workerBuild: OLDER })],
    ['S7', 'the recorded Worker is in a different account, a key held', inputs({ recorded: 'other-account' })],
    ['S7', 'the same with no key', inputs({ recorded: 'other-account', key: 'none', answer: 'unknown' })],
    ['S8', 'an address recorded, Cloudflare has no Worker', inputs({ worker: 'absent', answer: 'unknown', workerBuild: null })],
  ]
  for (const [state, what, input] of ROWS) assert.equal(computerState(input), state, what)
  assert.deepEqual([...new Set(ROWS.map(([state]) => state))].sort(), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'])
  // Total: every combination of inputs is one of the eight, and only a 401 ever reads as S5.
  let combinations = 0
  for (const worker of ['present', 'absent', 'unknown']) for (const recorded of ['none', 'this-account', 'other-account']) for (const key of ['none', 'legacy', 'own']) {
    for (const answer of ['accepted', 'refused', 'unknown']) for (const workerBuild of [BUILD, OLDER, null, '99-newer', 'odd', `${buildNumber(BUILD)}-other-text`]) {
      const state = computerState({ worker, recorded, key, answer, workerBuild, appBuild: BUILD })
      assert.match(state, /^S[1-8]$/)
      if (state === 'S5') assert.ok(answer === 'refused' && key !== 'none' && recorded === 'this-account')
      if (state === 'S6') assert.equal(workerBuild, OLDER, 'only a build that was read and is older says "updates the code first"')
      combinations += 1
    }
  }

  // R3. uploadDecision is the one comparison: only `upload` ever uploads. (With no Worker at all there
  // is nothing to compare: that is the sequence's case, PASS 8 and 9.)
  const DECISIONS = [
    ['upload', 'the deployed build is lower', '20-before-computer-keys', '22-signing-key'],
    ['upload', 'lower, whatever the texts', '9', '10-x'],
    ['current', 'the same build', '22-signing-key', '22-signing-key'],
    ['current', 'the same build, a number alone', '22', '22'],
    ['unreadable', 'the same number with different text', '22-other', '22-signing-key'],
    ['unreadable', 'the same number, one with no text', '22', '22-signing-key'],
    ['app-older', 'the deployed build is higher', '99-newer', '22-signing-key'],
    ['app-older', 'higher by one', '23-next', '22-signing-key'],
    ['unreadable', 'the read failed (no build)', null, '22-signing-key'],
    ['unreadable', 'the deployed build has no number in front', 'signing-key', '22-signing-key'],
    ['unreadable', 'the deployed build is empty', '', '22-signing-key'],
    ['unreadable', 'a number that does not end at a hyphen', '22signing', '22-signing-key'],
    ['unreadable', 'a negative number', '-22-x', '22-signing-key'],
    ['unreadable', 'a number too long to be a build', '1234567-x', '22-signing-key'],
    ['unreadable', 'this app\'s build has no number in front', '20-before-computer-keys', 'signing-key'],
    ['unreadable', 'neither has', 'a', 'b'],
    ['unreadable', 'not text at all', 22, '22-signing-key'],
  ]
  for (const [decision, what, deployed, app] of DECISIONS) assert.equal(uploadDecision(deployed, app), decision, what)
  assert.deepEqual([...new Set(DECISIONS.map(([decision]) => decision))].sort(), ['app-older', 'current', 'unreadable', 'upload'])
  assert.deepEqual([buildNumber('22-signing-key'), buildNumber('22'), buildNumber('x22'), buildNumber(null), buildNumber('')], [22, 22, null, null, null])
  assert.ok(!('compareBuilds' in keyModule), 'there is no second comparison')
  console.log(`PASS 1: ${ROWS.length} rows give every state S1 to S8 from explicit inputs; all ${combinations} combinations are one of the eight, and only the live service's 401 is ever "access was removed"; ${DECISIONS.length} rows of the build comparison: only a build that was read and is lower is uploaded over`)
}

// ── 2. The secrets requests ─────────────────────────────────────────────────────────────────────
{
  const id = 'cccc2222dddd3333'
  const add = addKeyRequest(ACCOUNT, NAME, id)
  assert.deepEqual([add.method, add.path, [...add.body.names]], ['PATCH', `${script}/secrets-bulk`, [`ADMIN_SECRET_${id}`]])
  assert.deepEqual(JSON.parse(addKeyBody(id, 'k')), { secrets: { [`ADMIN_SECRET_${id}`]: { name: `ADMIN_SECRET_${id}`, text: 'k', type: 'secret_text' } } }, 'one entry, this computer\'s, as secret_text')
  assert.deepEqual(JSON.parse(removeKeyBody({ computerId: id })), { secrets: { [`ADMIN_SECRET_${id}`]: null } }, 'removal nulls exactly one name')
  assert.deepEqual([...removeKeyRequest(ACCOUNT, NAME, { computerId: id }).body.names], [`ADMIN_SECRET_${id}`])
  assert.deepEqual(JSON.parse(removeKeyBody({ legacy: true })), { secrets: { ADMIN_SECRET: null } }, 'ADMIN_SECRET only when asked for in those words')
  // R1: the module has no way to name, list or send a signing secret.
  for (const gone of ['firstSecretsRequest', 'firstSecretsBody', 'secretNamesRequest', 'pickSecretNames', 'SIGNING_SECRET_NAME']) assert.ok(!(gone in uploadModule), `${gone} is gone`)
  for (const file of ['live-service-upload.ts', 'live-service-deploy.ts', 'live-service-key.ts', 'live-service-share-domain.ts', 'live-service.ts', 'setup-operations.ts']) {
    let code = readSource(join(repo, 'src/main', file)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    // The one exception: reading what 0.38.2 stored, whose blob is known by its `signingSecret` field. The value is never kept.
    if (file === 'live-service-key.ts') code = code.replace(/export function readKeyBlob[\s\S]*?\nexport function keyBlob/, '')
    assert.ok(!/SIGNING|signingSecret/i.test(code), `${file} has no code that names a signing secret`)
  }
  // Nothing but a computer's own id makes a name: not the fixed names, not a way round them.
  const NOT_IDS = ['legacy', 'self', 'join', '', 'Mac', 'a_b', 'a-b', 'a b', 'x'.repeat(65), '../x', 'SECRET', SIGNING_NAME, 'ADMIN_SECRET', '__proto__', null, undefined, 7, {}]
  for (const odd of NOT_IDS) {
    assert.equal(validComputerId(odd), false, `not an id: ${String(odd).slice(0, 12)}`)
    for (const build of [() => computerSecretName(odd), () => addKeyBody(odd, 'k'), () => addKeyRequest(ACCOUNT, NAME, odd), () => removeKeyBody({ computerId: odd }), () => removeKeyRequest(ACCOUNT, NAME, { computerId: odd })]) assert.throws(build, TypeError)
  }
  for (const odd of [{ legacy: false }, { legacy: 'true' }, { legacy: true, computerId: id }, { name: SIGNING_NAME }]) assert.throws(() => removeKeyBody(odd), TypeError, 'no other way to name a secret for removal')
  for (const empty of ['', '   ', null, undefined, 7]) assert.throws(() => addKeyBody(id, empty), TypeError, 'a key needs a value')
  assert.throws(() => addKeyRequest('../x', NAME, id), TypeError)
  // The id rule is the Worker's own (worker/admin-keys.ts).
  for (const odd of [...NOT_IDS, id, 'a', '0', 'x'.repeat(64), 'legacy1']) assert.equal(validComputerId(odd), workerValidComputerId(odd), `the app and the Worker agree on ${String(odd).slice(0, 12)}`)
  // A code upload is two requests: the script and its workers.dev switch. No secret, no domain, no route (R2).
  const files = workerDistFiles({ repo, bundle: Buffer.from('export default {}\n') })
  const verified = verifyShippedBundle(files.manifestText, { bundle: files.bundle, config: files.configBytes })
  for (const deployedMigrationTag of [null, 'v4']) {
    // A caller that still passes a share address or a list of domains gets nothing for it.
    const plan = planLiveServiceUpload({ config: verified.config, manifest: verified.manifest, bundle: verified.bundle, accountId: ACCOUNT, deployedMigrationTag, shareHostname: 'share.example.org', attachedDomains: [{ id: workerDomainId('old.example.org'), hostname: 'old.example.org' }] })
    assert.deepEqual(plan.map((request) => [request.step, request.method, request.path]), [['upload', 'PUT', `${script}?excludeScript=true&bindings_inherit=strict`], ['workers-dev', 'POST', `${script}/subdomain`]], 'exactly the script and its workers.dev switch')
    assert.ok(plan.every((request) => request.body?.kind !== 'secrets' && !/secret|\/domains|route/i.test(`${request.step} ${request.path}`) && !/secret_text|example\.org/.test(JSON.stringify(request.body?.metadata ?? request.body?.json))))
    assert.deepEqual(plan[1], workersDevRequest(ACCOUNT, NAME), 'the switch sent alone is the plan\'s own')
  }
  assert.deepEqual(workersDevRequest(ACCOUNT, NAME).body, { kind: 'json', json: { enabled: true } })
  assert.throws(() => workersDevRequest('../x', NAME), TypeError)
  console.log('PASS 2: add-key names one secret, removal nulls one name and reaches ADMIN_SECRET only when asked in those words; nothing can name a signing secret; a code upload is the script and its workers.dev switch, with no secret, domain or route')
}

// ── 3. The stored keys ──────────────────────────────────────────────────────────────────────────
{
  const recorded = { accountId: ACCOUNT, baseUrl: ADDRESS, workerName: NAME }
  // What 0.38.2 wrote is the `legacy` key of the account Settings records; its signing value is not read.
  assert.deepEqual(readKeyBlob(legacyBlob(), recorded), { entries: [legacyEntry], old: true })
  assert.deepEqual(readKeyBlob(null, recorded), { entries: [], old: false }, 'nothing stored: no key')
  const own = { accountId: ACCOUNT, workerName: NAME, computerId: 'aaaa0000bbbb1111', key: 'k'.repeat(43), kind: 'own' }
  assert.deepEqual(readKeyBlob(keyBlob([legacyEntry, own]), recorded), { entries: [legacyEntry, own], old: false })
  assert.deepEqual(JSON.parse(keyBlob([legacyEntry])), { format: KEY_BLOB_FORMAT, entries: [legacyEntry] }, 'rewritten: format 3, no signing value')
  assert.equal(KEY_BLOB_FORMAT, 3)
  // A 0.38.2 profile that recorded no account: its key is for the address recorded with it, and no other.
  const byAddress = readKeyBlob(legacyBlob(), { accountId: null, baseUrl: `${ADDRESS}/`, workerName: NAME }).entries[0]
  assert.deepEqual(byAddress, { accountId: null, workerName: NAME, computerId: 'legacy', key: LEGACY_KEY, kind: 'legacy', address: ADDRESS })
  assert.deepEqual([keyIsFor(byAddress, service(ACCOUNT, ADDRESS)), keyIsFor(byAddress, service(ACCOUNT, ADDRESS_B)), keyIsFor(byAddress, service(null, null))], [true, false, false])
  assert.deepEqual([keyIsFor(own, service()), keyIsFor(own, service(ACCOUNT_B, ADDRESS)), keyIsFor(own, service(null, ADDRESS)), keyIsFor(own, { ...service(), workerName: 'another' })], [true, false, false, false], 'a key is for its account and Worker, whatever the address')
  // R4: text that is not a key blob is never "no key".
  const UNREADABLE = ['', 'not json', '[]', '7', 'null', '{}', JSON.stringify({ adminSecret: 'a' }), JSON.stringify({ adminSecret: '', signingSecret: 's' }), JSON.stringify({ format: 2, computerId: 'self', adminSecret: 'a' }),
    JSON.stringify({ format: 2, adminSecret: 'a' }), JSON.stringify({ format: 3, computerId: own.computerId, adminSecret: 'a' }), JSON.stringify({ format: 3, entries: 'none' }), JSON.stringify({ format: 4, entries: [] }),
    JSON.stringify({ format: 3, entries: [{ ...own, computerId: 'legacy' }] }), JSON.stringify({ format: 3, entries: [{ ...own, key: '' }] }), JSON.stringify({ format: 3, entries: [own, null] }),
    JSON.stringify({ format: 3, entries: [{ ...legacyEntry, computerId: own.computerId }] }), JSON.stringify({ format: 3, entries: [{ ...own, accountId: '../x' }] })]
  for (const odd of UNREADABLE) assert.throws(() => readKeyBlob(odd, recorded), (error) => error instanceof KeyStoreUnreadable && error.message === KEY_UNREADABLE && !error.message.includes(String(odd).slice(0, 12) || 'not-there'), `unreadable: ${odd.slice(0, 30)}`)
  assert.throws(() => keyBlob([{ ...own, computerId: 'self' }]), TypeError)

  // A new key is made with a new id and is in the slot before it is handed over; config.json gets nothing.
  const fresh = profile()
  const made = fresh.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })
  assert.deepEqual([fresh.entries(), fresh.config, made.kind, made.accountId], [[made], {}, 'own', ACCOUNT])
  assert.match(made.computerId, /^[0-9a-f]{16}$/)
  assert.match(newComputerId(), /^[0-9a-f]{16}$/)
  assert.ok(made.key.length >= 40)
  // One already stored for the live service is never replaced; another live service gets its own, beside it.
  assert.deepEqual([fresh.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME }), fresh.slot.writes.length], [made, 1])
  const forB = fresh.store.ownKeyFor({ accountId: ACCOUNT_B, workerName: NAME })
  assert.ok(forB.computerId !== made.computerId && forB.key !== made.key, 'a new key always has a new id')
  assert.deepEqual([fresh.entries(), fresh.store.keysFor(service()), fresh.store.keysFor(service(ACCOUNT_B, ADDRESS_B)), fresh.store.keysFor(service('acc0third', ADDRESS))], [[made, forB], [made], [forB], []], 'each live service sees its own key and no other')
  assert.throws(() => fresh.store.ownKeyFor({ accountId: '../x', workerName: NAME }), TypeError)

  // It cannot be stored: it throws, and the slot is as it was. R9: a blob that is not yet in this
  // build's form gives no key while its rewrite fails; R6: it is still there, exactly as it was.
  const sealed = legacyProfile()
  sealed.slot.failWrite = true
  for (const read of [() => sealed.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME }), () => sealed.store.keysFor(service()), () => sealed.store.check()]) assert.throws(read, KeyStoreUnreadable)
  sealed.store.migrate()
  assert.deepEqual([sealed.slot.text, sealed.slot.writes], [legacyBlob(), []], 'the 0.38.2 blob is still there, untouched')
  // A write that is "taken" and does not read back as written (a store that lies) is not a migration either.
  const lying = { text: legacyBlob() }
  const liar = createComputerKeyStore({ read: () => lying.text, write: () => {}, recorded: () => recorded })
  assert.throws(() => liar.keysFor(service()), KeyStoreUnreadable, 'the rewrite must read back before any entry exists')
  const truncating = { text: legacyBlob() }
  const cutter = createComputerKeyStore({ read: () => truncating.text, write: (text) => { truncating.text = text.slice(0, -1) }, recorded: () => recorded })
  assert.throws(() => cutter.keysFor(service()), KeyStoreUnreadable)
  // The signing value goes the first time the blob is rewritten, once.
  sealed.slot.failWrite = false
  sealed.store.migrate()
  sealed.store.migrate()
  assert.deepEqual([JSON.parse(sealed.slot.text), sealed.slot.text.includes(LEGACY_SIGNING), sealed.slot.writes.length], [{ format: 3, entries: [legacyEntry] }, false, 1])
  // Its own key is ADDED beside the 0.38.2 one: own first when asked, the 0.38.2 one never removed.
  const mine = sealed.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })
  assert.deepEqual([sealed.entries(), sealed.store.keysFor(service())], [[legacyEntry, mine], [mine, legacyEntry]])
  // Bound to the account recorded THEN: a later change of account in Settings does not move it.
  sealed.config.liveWorkerAccountId = ACCOUNT_B
  assert.deepEqual([sealed.store.keysFor(service(ACCOUNT_B, ADDRESS_B)), sealed.store.keysFor(service()).length], [[], 2])
  // Nothing in the store removes or replaces an entry.
  assert.deepEqual(Object.keys(sealed.store).sort(), ['check', 'keysFor', 'migrate', 'ownKeyFor'])

  // R4: a slot that cannot be read throws from every read, and nothing is written.
  const dark = profile({ text: keyBlob([own]) })
  dark.slot.failRead = true
  for (const read of [() => dark.store.check(), () => dark.store.keysFor(service()), () => dark.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })]) assert.throws(read, KeyStoreUnreadable)
  dark.store.migrate()
  assert.deepEqual([dark.slot.writes, dark.slot.text], [[], keyBlob([own])])
  const garbled = profile({ text: 'not a key blob' })
  assert.throws(() => garbled.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME }), KeyStoreUnreadable)
  garbled.store.migrate()
  assert.deepEqual([garbled.slot.writes, garbled.slot.text], [[], 'not a key blob'], 'text that is not a key blob is never written over')

  // R5: another computer's config.json (an unreleased build kept an id there) and no blob. The id is
  // not read: the new key gets a new one, and the other computer's secret is never named.
  const copiedConfig = { computerId: OTHER_MAC.computerId, computerName: 'Studio Mac', liveWorkerAccountId: ACCOUNT, liveWorkerBaseUrl: ADDRESS }
  const copied = profile({ config: copiedConfig })
  // Making the store takes the leftover id out of config.json and leaves every other field as it was.
  assert.deepEqual(copied.config, { computerName: 'Studio Mac', liveWorkerAccountId: ACCOUNT, liveWorkerBaseUrl: ADDRESS }, 'the leftover id is removed from config.json when the store is made')
  assert.equal(copied.config, copiedConfig, '(the same config the profile was given)')
  // Whatever the slot holds: also when it cannot be read; and a removal that fails stops nothing.
  for (const text of [null, legacyBlob(), 'not a key blob']) assert.ok(!('computerId' in profile({ text, config: { computerId: OTHER_MAC.computerId, liveWorkerAccountId: ACCOUNT } }).config))
  const removals = []
  const plainPorts = (settings) => ({ read: () => null, write: () => {}, recorded: () => ({ accountId: null, baseUrl: null, workerName: NAME }), ...(settings ? { settings } : {}) })
  createComputerKeyStore(plainPorts({ fields: () => ['computerName', 'liveWorkerAccountId'], remove: (field) => removals.push(field) }))
  createComputerKeyStore(plainPorts({ fields: () => ['computerId', 'computerName'], remove: (field) => removals.push(field) }))
  assert.deepEqual(removals, ['computerId'], 'only that field, and only when it is there')
  assert.deepEqual(createComputerKeyStore(plainPorts({ fields: () => { throw new Error('config.json could not be read') }, remove: () => {} })).keysFor(service()), [])
  assert.deepEqual(createComputerKeyStore(plainPorts({ fields: () => ['computerId'], remove: () => { throw new Error('config.json could not be written') } })).keysFor(service()), [])
  assert.deepEqual(createComputerKeyStore(plainPorts()).keysFor(service()), [])
  const theirs = copied.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })
  assert.ok(theirs.computerId !== OTHER_MAC.computerId && !copied.slot.text.includes(OTHER_MAC.computerId))
  // The store's ports can read no id from Settings: the settings port gives field NAMES and removes one.
  const portsSource = readSource(join(repo, 'src/main/live-service-key.ts')).split('export interface ComputerKeyStorePorts')[1].split('\n}\n')[0]
  assert.ok(!/\bcomputerId\b/.test(portsSource) && /settings\?: \{ fields\(\): string\[\]; remove\(field: string\): void \}/.test(portsSource), 'the store has no port that reads an id from Settings')
  // The main process hands the store that port over config.json, and names the field nowhere itself.
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.match(main, /settings: \{ fields: \(\) => Object\.keys\(readConfig\(\)\), remove: \(field\) => writeConfig\(\{ \[field\]: undefined \}/, 'the store is given config.json\'s field names and the removal of one')
  assert.equal(main.match(/computerId: [^,}\s]+/g), null, 'and the main process writes no id to config.json')

  // Names: the host name without .local, cut to what the live service takes (worker/computers.ts).
  assert.deepEqual([defaultComputerName('Studio-Mac.local'), defaultComputerName('  pc  '), defaultComputerName(''), [...defaultComputerName('x'.repeat(200))].length], ['Studio-Mac', 'pc', 'This computer', 64])
  assert.deepEqual([computerNameOrNull(' Studio Mac '), computerNameOrNull(''), computerNameOrNull('a\nb'), computerNameOrNull('a‮b'), computerNameOrNull('x'.repeat(65)), computerNameOrNull(7)], ['Studio Mac', null, null, null, null, null])
  const workerRule = readSource(join(repo, 'worker', 'computers.ts'))
  assert.ok(workerRule.includes('const NAME_FORBIDDEN = /[\\p{C}\\p{Zl}\\p{Zp}]/u') && workerRule.includes('export const COMPUTER_NAME_MAX = 64'), 'the same rule as the live service\'s')
  // A key is sent only to https, or to this computer.
  assert.deepEqual([liveAddressOrNull(ADDRESS), liveAddressOrNull('http://127.0.0.1:8787'), liveAddressOrNull('http://example.org'), liveAddressOrNull('https://u:p@example.org'), liveAddressOrNull('https://example.org/?k=1'), liveAddressOrNull('ftp://x')], [ADDRESS, 'http://127.0.0.1:8787', null, null, null, null])
  console.log(`PASS 3: a 0.38.2 blob is the legacy key of the account recorded with it; ${UNREADABLE.length} texts that are not a key blob throw and are never "no key"; a key is made with a new id, stored before it is handed over and never replaced or removed; a failed rewrite leaves the old blob as it was and gives no key; a copied config.json names no secret`)
}

// ── 4. The sequence, against the fake API and the stand-in live service ─────────────────────────
const shipped = workerDistFiles({ repo, bundle: Buffer.from('// made-up bundle\nexport default { fetch() { return new Response("ok") } }\n') })
const accounts = []
/** Every request a computer sent to a live service: where, which route, and the bearer it showed. */
const wire = []
function account({ worker, domains } = {}) {
  const fake = createFakeCloudflare({ tokens: { [TOKEN]: { accounts: [ACCOUNT, ACCOUNT_B] } }, accounts: [{ id: ACCOUNT, name: 'Ada' }, { id: ACCOUNT_B, name: 'Other' }] })
  if (worker) fake.model.workers.set(ACCOUNT, new Map([[NAME, { uploads: 1, migrationTag: 'v4', module: null, metadata: null, workersDev: true, ...worker }]]))
  if (domains) fake.model.workerDomains.set(ACCOUNT, domains.map(({ hostname, service: owner = NAME }) => ({ id: workerDomainId(hostname), hostname, service: owner, environment: 'production' })))
  const live = liveWorkerDouble(fake, { account: ACCOUNT, name: NAME, address: ADDRESS, build: BUILD })
  const at = { fake, live, lives: new Map([[ADDRESS, { live, account: ACCOUNT }]]), worker: (id = ACCOUNT) => fake.model.workers.get(id)?.get(NAME), domains: () => structuredClone(fake.model.workerDomains.get(ACCOUNT) ?? []) }
  accounts.push(at)
  return at
}
/** A Worker as 0.38.2 left it: `ADMIN_SECRET` and the signing secret (and, unless said, this build's code). */
const legacyWorker = () => ({ secrets: ['ADMIN_SECRET', SIGNING_NAME], values: new Map([['ADMIN_SECRET', LEGACY_KEY], [SIGNING_NAME, LEGACY_SIGNING]]) })
function computer(at, { keys = profile(), name = 'Second Mac', accountId = ACCOUNT } = {}) {
  const pc = { profile: keys, saved: [], phases: [], ticking: instantClock(), current: true, accountId }
  const authorisation = {
    get accountId() { return pc.accountId }, current: () => pc.current,
    async run(launch) { if (!pc.current) return { superseded: true }; const result = await launch({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: pc.accountId }); return pc.current ? { superseded: false, result } : { superseded: true } },
    clean: (text) => String(text).split(TOKEN).join(TOKEN_REMOVED),
  }
  /** The live service at the address asked: reached only once its workers.dev address is switched on. */
  pc.liveFetch = async (input, init = {}) => {
    const url = new URL(String(input))
    wire.push({ origin: url.origin, route: url.pathname, bearer: /^Bearer (.+)$/.exec(new Headers(init.headers).get('authorization') ?? '')?.[1] ?? null })
    const there = at.lives.get(url.origin)
    if (!there || at.worker(there.account)?.workersDev === false) throw new TypeError('fetch failed')
    return there.live.fetch(input, init)
  }
  pc.ports = {
    shipped: () => ({ manifest: shipped.manifestText, bundle: shipped.bundle, config: shipped.configBytes }), expectedBuild: BUILD,
    authorise: async () => ({ ok: true, authorisation }),
    keys: keys.store, computerName: () => name,
    fetch: fakeCloudflareFetch(at.fake), liveFetch: pc.liveFetch, apiBase: () => 'http://127.0.0.1:9/client/v4',
    // As the main process: the address, build and account go to config.json, and nothing else does.
    save: (kept) => { pc.saved.push(see(kept)); Object.assign(keys.config, { liveWorkerBaseUrl: kept.baseUrl, liveWorkerVersion: BUILD, liveWorkerAccountId: kept.accountId }) },
    timeoutMs: { upload: 2000, request: 2000 }, live: pc.ticking.live, progress: (phase) => pc.phases.push(phase),
  }
  pc.setUp = async () => see(await deployLiveService(pc.ports))
  pc.survey = async () => see(await surveyLiveService(pc.ports))
  pc.authorisation = authorisation
  /** This computer's keys for the live service asked about, own first. */
  pc.keys = (id = ACCOUNT, address = ADDRESS) => keys.store.keysFor(service(id, address))
  return pc
}
const sentTo = (at, from = 0) => at.fake.requests.slice(from).map((request) => `${request.method} ${request.path}`)
const writesTo = (at, from = 0) => sentTo(at, from).filter((line) => !line.startsWith('GET '))
const patches = (at, from = 0) => at.fake.requests.slice(from).filter((request) => request.method === 'PATCH').map((request) => JSON.parse(request.body.toString()).secrets)
/** A live session made with this key, straight at the stand-in: its status and its presenter token. */
const session = async (at, key, address = ADDRESS) => {
  const response = await at.lives.get(address).live.fetch(`${address}/sessions`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
  return { status: response.status, token: response.status === 201 ? (await response.json()).presenterToken : null }
}
const tokenPasses = async (at, token, address = ADDRESS) => (await at.lives.get(address).live.fetch(`${address}/tokens/check`, { method: 'POST', body: JSON.stringify({ token }) })).status === 200
const ownSecret = (pc, id = ACCOUNT, address = ADDRESS) => `ADMIN_SECRET_${pc.keys(id, address).find((entry) => entry.kind === 'own').computerId}`

{
  // S6: an older Worker that knows only ADMIN_SECRET, and a computer with no key. The code first, with no secret; then the key.
  const at = account({ worker: legacyWorker() })
  at.live.state.build = (worker) => (worker.uploads > 1 ? BUILD : OLDER)
  const before = await session(at, LEGACY_KEY)
  const pc = computer(at)
  assert.deepEqual(await pc.survey(), { accountId: ACCOUNT, worker: 'present', build: OLDER, key: 'unknown', others: null })
  const result = await pc.setUp()
  const [mine] = pc.keys()
  assert.deepEqual([result.ok, result.others, result.created, pc.profile.slot.writes.length, mine.kind], [true, 0, false, 1, 'own'])
  assert.deepEqual(writesTo(at), [`PUT ${script}`, `POST ${script}/subdomain`, `PATCH ${script}/secrets-bulk`], 'the code update, then one secrets request')
  const upload = at.fake.requests.find((request) => request.method === 'PUT')
  for (const secret of [TOKEN, LEGACY_KEY, LEGACY_SIGNING, mine.key]) assert.ok(!upload.body.toString('latin1').includes(secret), 'the upload carries no secret')
  assert.ok(!/secret_text|"text"/.test(upload.parts.find((part) => part.name === 'metadata').bytes.toString('utf8')), 'and binds none')
  assert.deepEqual(patches(at).map((secrets) => Object.keys(secrets)), [[`ADMIN_SECRET_${mine.computerId}`]], 'the key alone: ADMIN_SECRET and the signing secret are not named')
  assert.deepEqual([...at.worker().values].sort(), [['ADMIN_SECRET', LEGACY_KEY], [`ADMIN_SECRET_${mine.computerId}`, mine.key], [SIGNING_NAME, LEGACY_SIGNING]], 'the first computer\'s key and the signing secret are exactly as they were')
  assert.deepEqual([(await session(at, LEGACY_KEY)).status, (await session(at, mine.key)).status, await tokenPasses(at, before.token)], [201, 201, true], 'both computers make a live session, and a token from before the update still passes')
  assert.deepEqual([pc.phases, pc.saved], [['upload', 'secrets'], [{ baseUrl: ADDRESS, accountId: ACCOUNT, recorded: true }]])
  assert.deepEqual(at.live.state.computers.map((line) => `${line.id}:${line.name}`), [`${mine.computerId}:Second Mac`])
  console.log('PASS 4: an older Worker and a computer with no key: the code is updated with no secret, then one request adds this computer\'s key; the first computer\'s key, the signing secret and a token made before are untouched')
}

{
  // A 0.38.2 profile opened in this build: updated, nothing re-sent, recorded as `legacy`, the blob rewritten without its signing value.
  const at = account({ worker: legacyWorker() })
  at.live.state.build = (worker) => (worker.uploads > 1 ? BUILD : OLDER)
  const first = computer(at, { keys: legacyProfile(), name: 'First Mac' })
  first.profile.store.migrate() // as the main process does when it first opens the store
  const result = await first.setUp()
  assert.deepEqual([result.ok, result.adminSecret === LEGACY_KEY, first.profile.entries(), first.profile.slot.text.includes(LEGACY_SIGNING)], [true, true, [legacyEntry], false])
  assert.deepEqual(writesTo(at), [`PUT ${script}`, `POST ${script}/subdomain`], 'a code update: no secrets request of any kind')
  assert.ok(!sentTo(at).some((line) => /\/secrets/.test(line)), 'not even the names are read')
  assert.deepEqual([first.phases, at.live.state.computers.map((line) => `${line.id}:${line.name}`)], [['upload', 'access'], ['legacy:First Mac']])
  // Its build already current and its key accepted: nothing is written at all.
  const before = at.fake.requests.length
  assert.equal((await first.setUp()).ok, true)
  assert.deepEqual(writesTo(at, before), [])
  // The survey: what the Going live row is decided from. Reads only.
  const surveyed = await surveyLiveService({ ...first.ports, record: { due: () => false, name: () => 'First Mac', done: () => {} } })
  assert.deepEqual(surveyed, { accountId: ACCOUNT, worker: 'present', build: BUILD, key: 'accepted', others: 0 })
  assert.deepEqual(await computer(at).survey(), { accountId: ACCOUNT, worker: 'present', build: BUILD, key: 'unknown', others: null }, 'a computer with no key: present, and nothing asked of the live service with a key')
  at.live.state.unreachable = true
  assert.deepEqual(await first.survey(), { accountId: ACCOUNT, worker: 'present', build: null, key: 'unknown', others: null }, 'token valid, live service unreachable: unknown, never refused')
  at.live.state.unreachable = false
  const stranger = computer(at)
  stranger.profile.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })
  const asked = at.live.requests.length
  assert.deepEqual([(await stranger.survey()).key, at.live.requests.slice(asked).filter((request) => request.route === '/computers').length, stranger.ticking.clock.pauses], ['refused', 2, [1500]], 'a key the live service does not have: 401, asked twice')
  assert.deepEqual(writesTo(at, before), [], 'a survey writes nothing at Cloudflare')
  console.log('PASS 5: a 0.38.2 computer is updated with nothing re-sent and appears as "legacy"; the survey tells accepted, refused and unreachable apart and writes nothing')
}

{
  // The send fails: the stored key is kept, and Try again sends the SAME key. Then it is accepted and nothing more is sent.
  const at = account({ worker: legacyWorker() })
  const pc = computer(at)
  at.fake.model.answer = (request) => (request.method === 'PATCH' ? { status: 500, body: { success: false, errors: [{ code: 10013, message: `no ${JSON.parse(request.body.toString()).secrets[Object.keys(JSON.parse(request.body.toString()).secrets)[0]].text}` }], messages: [], result: null } } : null)
  const failed = await pc.setUp()
  const [mine] = pc.keys()
  assert.deepEqual([failed.ok, failed.error, failed.details, pc.saved, pc.profile.config], [false, LIVE_KEY_NOT_ADDED, 'Adding this computer\'s key: Cloudflare answered 500 (error 10013).', [], {}])
  at.fake.model.answer = null
  const retried = await pc.setUp()
  assert.deepEqual([retried.ok, pc.profile.slot.writes.length, pc.keys()], [true, 1, [mine]], 'no second key was made')
  assert.deepEqual(patches(at).map((secrets) => Object.entries(secrets).map(([named, entry]) => [named, entry.text === mine.key])), [[[`ADMIN_SECRET_${mine.computerId}`, true]], [[`ADMIN_SECRET_${mine.computerId}`, true]]], 'the same key under the same name, both times')
  const before = at.fake.requests.length
  assert.equal((await pc.setUp()).ok, true)
  assert.deepEqual(writesTo(at, before), [], 'accepted: pressing again sends nothing')

  // The key cannot be stored: nothing is sent.
  const sealed = account({ worker: legacyWorker() })
  const noStore = computer(sealed)
  noStore.profile.slot.failWrite = true
  const unstored = await noStore.setUp()
  assert.deepEqual([unstored.ok, unstored.error, writesTo(sealed), sealed.live.requests.filter((request) => request.bearer).length, noStore.profile.slot.text], [false, LIVE_KEY_NOT_STORED, [], 0, null], 'no write at Cloudflare, and no key shown to the live service')
  const firstEver = account()
  const noStoreFirst = computer(firstEver)
  noStoreFirst.profile.slot.failWrite = true
  assert.deepEqual([(await noStoreFirst.setUp()).error, writesTo(firstEver)], [LIVE_KEY_NOT_STORED, []], 'a first set-up too: not even the upload')

  // R4. A slot that is there and cannot be read is not "no key": set-up and survey stop before
  // anything is asked. No key is made, nothing is written, and not one request is sent anywhere.
  for (const [what, worker, keys] of [
    ['a Worker and a key that cannot be decrypted', legacyWorker(), () => { const held = legacyProfile(); held.slot.failRead = true; return held }],
    ['no Worker yet', undefined, () => { const held = profile({ text: keyBlob([legacyEntry]) }); held.slot.failRead = true; return held }],
    ['text that is not a key blob', legacyWorker(), () => profile({ text: '{"format":3,"entries":"?"}' })],
  ]) {
    const dark = account({ worker })
    const blind = computer(dark, { keys: keys() })
    const text = blind.profile.slot.text
    const [live, sent] = [dark.live.requests.length, wire.length]
    const stopped = await blind.setUp()
    assert.deepEqual([stopped, await blind.survey()], [{ ok: false, error: LIVE_KEY_UNREADABLE }, null], what)
    assert.equal(stopped.error, 'TalkWeaver could not read this computer\'s key. Nothing was changed.')
    assert.deepEqual([dark.fake.requests.length, dark.live.requests.length - live, wire.length - sent, blind.profile.slot.writes, blind.profile.slot.text, blind.saved, blind.phases], [0, 0, 0, [], text, [], []], `${what}: nothing asked, sent, made or written`)
  }
  // It becomes unreadable between the first look and the key being needed: still nothing is written at Cloudflare.
  const later = account({ worker: legacyWorker() })
  const flickering = computer(later, { keys: legacyProfile() })
  later.fake.model.answer = (request) => { if (request.path.endsWith('/workers/subdomain')) flickering.profile.slot.failRead = true; return null }
  assert.deepEqual([await flickering.setUp(), writesTo(later), wire.filter((request) => request.bearer === LEGACY_KEY && request.origin === 'never').length], [{ ok: false, error: LIVE_KEY_UNREADABLE }, [], 0])
  console.log('PASS 6: a failed send keeps the stored key and the retry sends the same one; a key that cannot be stored means nothing is sent; a slot that cannot be read stops set-up and survey with nothing asked, made, written or sent')
}

{
  // Waiting to be accepted: back-off, a minute at most, then a plain retry message; "not yet" is not "unreachable".
  const at = account({ worker: legacyWorker() })
  const pc = computer(at)
  at.live.state.lag = 10_000 // the secret never arrives while this run waits
  const waited = await pc.setUp()
  assert.deepEqual([waited.ok, waited.error, waited.details], [false, LIVE_NOT_ACCEPTED_YET, 'Asking the live service whether it accepts this computer: not yet (401).'])
  const pauses = pc.ticking.clock.pauses
  assert.ok(pauses.length >= 8 && pauses.reduce((sum, ms) => sum + ms, 0) <= ACCEPT_WAIT_MS, `it asks for no longer than a minute (${pauses.length} pauses)`)
  assert.ok(pauses.every((ms, index) => index === 0 || ms >= pauses[index - 1]) && pauses[0] <= 1000 && pauses.at(-1) <= 5000, 'with a growing pause between asks')
  assert.deepEqual([pc.phases, patches(at).length, pc.saved], [['secrets'], 1, []])
  // Try again once it has arrived: accepted, and no second request.
  at.live.state.lag = 0
  const before = at.fake.requests.length
  assert.deepEqual([(await pc.setUp()).ok, writesTo(at, before), pc.profile.slot.writes.length], [true, [], 1])

  // It goes dark after the key was sent: unreachable, not "not accepted".
  const flaky = account({ worker: legacyWorker() })
  const sender = computer(flaky)
  flaky.fake.model.answer = (request) => { if (request.method === 'PATCH') flaky.live.state.unreachable = true; return null }
  const lost = await sender.setUp()
  assert.deepEqual([lost.error, patches(flaky).length, sender.keys().length], [LIVE_UNREACHABLE, 1, 1])
  // One 401 is not a verdict: a stored key is asked about until accepted, or refused twice.
  const slow = account({ worker: { secrets: [], values: new Map() } })
  const ticking = instantClock()
  const unknownKey = { accountId: ACCOUNT, workerName: NAME, computerId: 'cccc2222dddd3333', key: 'made-up-unregistered-key-0123456789', kind: 'own' }
  assert.equal((await waitForKey({ fetch: slow.live.fetch, ...ticking.live }, service(), unknownKey, 'verdict')).outcome, 'refused')
  assert.equal(slow.live.requests.length, 2)
  // A key is shown only to the live service it was made for: asked about another account's, nothing is sent.
  assert.deepEqual([await waitForKey({ fetch: slow.live.fetch, ...instantClock().live, waitMs: 0 }, service(ACCOUNT_B, ADDRESS), unknownKey, 'verdict'), slow.live.requests.length], [{ outcome: 'unreachable', others: null }, 2])
  console.log('PASS 7: waiting backs off and stops within a minute with a plain retry message; unreachable is told apart from not yet accepted; a key is never shown to another live service')
}

{
  // R3. Code goes over a live service only when its build was READ and is older. Each row: what the
  // live service answers as, and what the press comes to. Nothing recorded on the computer stands in.
  const press = async (build, keys) => {
    const at = account({ worker: legacyWorker() })
    at.live.state.build = build
    const pc = computer(at, { keys })
    const result = await pc.setUp()
    return { at, pc, result, writes: writesTo(at) }
  }
  // An older app never uploads over a newer live service, and adds no key to it.
  const newer = await press(() => '99-newer')
  assert.deepEqual([newer.result.error, newer.writes, newer.pc.profile.slot.writes], [LIVE_APP_OLDER, [], []])
  assert.equal(newer.result.details, `The live service answers as build 99-newer; this TalkWeaver carries build ${BUILD}.`)
  // The same number with different text cannot be ordered: nothing is sent, although the 0.38.2 computer's Settings say an update is due.
  const sameNumber = await press(() => `${buildNumber(BUILD)}-other-text`, legacyProfile())
  assert.deepEqual([sameNumber.result.error, sameNumber.writes], [LIVE_VERSION_UNREADABLE, []])
  assert.match(sameNumber.result.details, /The two cannot be put in order\.$/)
  // A build with no number in front: the same.
  const odd = await press(() => 'unnumbered', legacyProfile())
  assert.deepEqual([odd.result.error, odd.writes], [LIVE_VERSION_UNREADABLE, []])
  // The same build: no upload; only this computer's key.
  const same = await press(() => BUILD)
  assert.deepEqual([same.result.ok, same.writes], [true, [`PATCH ${script}/secrets-bulk`]])

  // The journey: the read of the build fails. Nothing is uploaded. (The one request sent is the
  // workers.dev switch, which changes no code, secret or domain: PASS 9.) Then, and only then,
  // the same computer with the build readable and older: the update.
  const at = account({ worker: legacyWorker() })
  at.live.state.build = () => OLDER
  let capabilities = 'fail'
  const pc = computer(at, { keys: legacyProfile() })
  const reach = pc.ports.liveFetch
  pc.ports.liveFetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/capabilities' && capabilities === 'fail') throw new TypeError('fetch failed')
    if (new URL(String(input)).pathname === '/capabilities' && capabilities === '500') return new Response('upstream error', { status: 500 })
    return reach(input, init)
  }
  for (const how of ['fail', '500']) {
    capabilities = how
    const from = at.fake.requests.length
    const unread = await pc.setUp()
    assert.deepEqual([unread.ok, unread.error, unread.details], [false, LIVE_VERSION_UNREADABLE, 'Asking the live service which build it is: no usable answer.'], how)
    assert.deepEqual([writesTo(at, from).filter((line) => line !== `POST ${script}/subdomain`), at.worker().uploads, patches(at).length], [[], 1, 0], 'no code uploaded and no secret sent while the build is not read')
  }
  assert.deepEqual([pc.saved, pc.profile.config.liveWorkerVersion], [[], OLDER])
  capabilities = 'answer'
  at.live.state.build = (worker) => (worker.uploads > 1 ? BUILD : OLDER)
  const from = at.fake.requests.length
  assert.deepEqual([(await pc.setUp()).ok, writesTo(at, from), at.worker().uploads], [true, [`PUT ${script}`, `POST ${script}/subdomain`], 2])
  console.log('PASS 8: a newer live service, an equal number with different text, a build with no number and a failed read all stop with no code uploaded and no secret sent; an equal build uploads nothing; only a build that was read and is older is updated')
}

{
  // S-a. A first set-up that stopped between its two requests: the script is at Cloudflare, its
  // workers.dev address is not switched on, so nothing answers there. The next press sends the switch
  // ALONE, asks for the build again, and goes on as always. Code is never uploaded blind.
  const at = account()
  const pc = computer(at, { name: 'First Mac' })
  at.fake.model.answer = (request) => (request.method === 'POST' && request.path === `${script}/subdomain` ? { status: 500, body: { success: false, errors: [{ code: 10013, message: 'no' }], messages: [], result: null } } : null)
  const stopped = await pc.setUp()
  assert.deepEqual([stopped.ok, stopped.error, stopped.details, at.worker().uploads, at.worker().workersDev], [false, LIVE_SETUP_FAILED, 'Switching on its workers.dev address: Cloudflare answered 500 (error 10013).', 1, false])
  const [mine] = pc.keys()
  at.fake.model.answer = null
  let from = at.fake.requests.length
  const finished = await pc.setUp()
  assert.deepEqual([finished.ok, finished.created, writesTo(at, from), at.worker().uploads, pc.keys()], [true, false, [`POST ${script}/subdomain`, `PATCH ${script}/secrets-bulk`], 1, [mine]], 'the switch alone, then this computer\'s key: the code is not uploaded again, and the key is the one made the first time')
  const switched = at.fake.requests.slice(from).find((request) => request.method === 'POST')
  assert.deepEqual([JSON.parse(switched.body.toString()), switched.headers['cloudflare-workers-script-api-date']], [{ enabled: true }, uploadModule.SCRIPT_API_DATE])
  assert.deepEqual([(await session(at, mine.key)).status, pc.saved.length], [201, 1])

  // The other outcome: the switch is taken and still nothing answers. The fixed sentence, and nothing else is sent.
  const dark = account({ worker: legacyWorker() })
  dark.live.state.unreachable = true
  const blind = computer(dark, { keys: legacyProfile() })
  const offline = await blind.setUp()
  assert.deepEqual([offline.ok, offline.error, offline.details, writesTo(dark), dark.worker().uploads], [false, LIVE_VERSION_UNREADABLE, 'Asking the live service which build it is: no usable answer.', [`POST ${script}/subdomain`], 1])
  const pauses = blind.ticking.clock.pauses
  assert.ok(pauses.length >= 8 && pauses.reduce((sum, ms) => sum + ms, 0) <= ACCEPT_WAIT_MS && pauses[0] === 500, `asked again with the pauses a key is waited for with, for no longer than a minute (${pauses.length})`)
  assert.deepEqual([wire.filter((request) => request.bearer === LEGACY_KEY && request.route !== '/computers' && request.route !== '/computers/self').length, blind.profile.slot.writes, blind.saved], [0, [keyBlob([legacyEntry])], []], 'no key made or shown (the one write is the 0.38.2 blob rewritten in this build\'s form)')
  // The switch itself refused: the same sentence (or the permission one), and nothing after it.
  const refusing = account({ worker: legacyWorker() })
  refusing.live.state.unreachable = true
  refusing.fake.model.answer = (request) => (request.method === 'POST' ? { status: 503, body: 'unavailable' } : null)
  const refusedSwitch = await computer(refusing).setUp()
  assert.deepEqual([refusedSwitch.error, refusedSwitch.details, writesTo(refusing)], [LIVE_VERSION_UNREADABLE, 'Switching on its workers.dev address: Cloudflare answered 503.', [`POST ${script}/subdomain`]])
  console.log('PASS 9: a first set-up that stopped after the script is finished by the next press with the workers.dev switch alone and the same key; with still no answer the press stops at "could not read your live service\'s version" having sent nothing else')
}

{
  // R1 and R8. First set-up, a second computer, then one removed: each request names only its own
  // computer's secret, the app sends no signing secret, and the live service's own signing key is
  // the same through all of it (a token from the first minute passes at the end).
  const at = account({ domains: [{ hostname: 'share.first-mac.example.org' }, { hostname: 'other.example.org', service: 'another-worker' }] })
  const domains = at.domains()
  const first = computer(at, { name: 'First Mac' })
  const created = await first.setUp()
  const mineA = first.keys()[0]
  assert.deepEqual([created.ok, created.created, writesTo(at)], [true, true, [`PUT ${script}`, `POST ${script}/subdomain`, `PATCH ${script}/secrets-bulk`]])
  assert.deepEqual([Object.keys(patches(at)[0]), [...at.worker().values.keys()], at.worker().secrets], [[`ADMIN_SECRET_${mineA.computerId}`], [`ADMIN_SECRET_${mineA.computerId}`], [`ADMIN_SECRET_${mineA.computerId}`]], 'the one secrets request of a first set-up names this computer\'s key and nothing else: the live service keeps its own signing key')
  const early = await session(at, mineA.key)
  assert.deepEqual([early.status, await tokenPasses(at, early.token)], [201, true])
  const second = computer(at)
  const joined = await second.setUp()
  const mineB = second.keys()[0]
  assert.deepEqual([joined.ok, joined.others, joined.created, patches(at).slice(1).map((secrets) => Object.keys(secrets)), at.worker().uploads], [true, 1, false, [[`ADMIN_SECRET_${mineB.computerId}`]], 1])
  assert.ok(mineB.computerId !== mineA.computerId && mineB.key !== mineA.key)
  // A first set-up that stopped after the upload (no key yet) is finished by the next press, with the same key.
  const half = account()
  const starter = computer(half)
  half.fake.model.answer = (request) => (request.method === 'PATCH' ? { status: 502, body: 'Bad gateway' } : null)
  assert.deepEqual([(await starter.setUp()).error, starter.saved], [LIVE_KEYS_FAILED, []])
  half.fake.model.answer = null
  assert.deepEqual([(await starter.setUp()).ok, Object.keys(patches(half).at(-1)), starter.profile.slot.writes.length, half.worker().uploads], [true, [ownSecret(starter)], 1, 1])
  // Remove one computer's key: one request, one name, null; the other still works.
  const before = at.fake.requests.length
  const sendAs = (pc) => async (outgoing, pick, timeoutMs) => (await pc.authorisation.run((credentials) => send({ fetch: pc.ports.fetch, base: pc.ports.apiBase(), timeoutMs, cancelled: new AbortController().signal }, credentials.CLOUDFLARE_API_TOKEN, outgoing, pick))).result ?? null
  const target = { send: sendAs(first), accountId: ACCOUNT, scriptName: NAME, timeoutMs: 2000, current: () => true }
  assert.deepEqual(await removeComputerKey(target, { computerId: mineB.computerId }), { ok: true })
  assert.deepEqual([writesTo(at, before), patches(at, before)], [[`PATCH ${script}/secrets-bulk`], [{ [`ADMIN_SECRET_${mineB.computerId}`]: null }]])
  assert.deepEqual([(await session(at, mineA.key)).status, (await session(at, mineB.key)).status, await tokenPasses(at, early.token)], [201, 401, true], 'the removed computer is refused; the other, and every token, are as they were')
  assert.deepEqual([(await second.survey()).key, second.keys()], ['refused', [mineB]], 'the removed computer sees it (S5), and keeps its key')
  await assert.rejects(() => removeComputerKey(target, { computerId: 'legacy' }), TypeError)
  // S5 → the person's set-up press → the same key registered again.
  const back = await second.setUp()
  assert.deepEqual([back.ok, second.keys(), (await session(at, mineB.key)).status], [true, [mineB], 201])
  // R2: through all of that, with the first computer's custom domain on the Worker: untouched.
  assert.deepEqual([at.domains(), sentTo(at).filter((line) => /^DELETE |\/domains|\/routes|\/zones/.test(line))], [domains, []])

  // R8, the negative control: the stand-in WOULD show a re-keyed live service. Its signing key changed
  // by hand: the token from before fails its check, and a new one passes.
  assert.equal(await tokenPasses(at, early.token), true)
  const kept = at.worker().registryKey
  at.worker().registryKey = 'a-different-signing-key-made-by-hand'
  assert.deepEqual([await tokenPasses(at, early.token), await tokenPasses(at, (await session(at, mineA.key)).token)], [false, true], 'a changed signing key is seen: the old token fails')
  at.worker().registryKey = kept
  assert.equal(await tokenPasses(at, early.token), true)
  // The same for a service 0.38.2 set up: its signing secret set, replaced or removed would be seen.
  const old = account({ worker: legacyWorker() })
  const oldToken = (await session(old, LEGACY_KEY)).token
  for (const damage of [(values) => values.set(SIGNING_NAME, 'replaced-signing-secret'), (values) => values.delete(SIGNING_NAME)]) {
    damage(old.worker().values)
    assert.equal(await tokenPasses(old, oldToken), false)
    old.worker().values.set(SIGNING_NAME, LEGACY_SIGNING)
    assert.equal(await tokenPasses(old, oldToken), true)
  }
  console.log('PASS 10: a first set-up sends this computer\'s key and no signing secret; a second computer adds only its own; removing one nulls one name and the other keeps working; a token from the first minute passes throughout, and the stand-in shows that a changed signing key would fail it')
}

{
  // R8. Two computers whose set-ups interleave step by step. Both look first (no Worker, no key);
  // B's set-up then reads Cloudflare (still no Worker) and is held there; A sets up from start to
  // end; B goes on from what it read. A's session token, both keys and the domain must all survive.
  const at = account({ domains: [{ hostname: 'share.someone.example.org', service: 'another-worker' }] })
  const domains = at.domains()
  const a = computer(at, { name: 'Mac A' })
  const b = computer(at, { name: 'Mac B' })
  assert.deepEqual([await a.survey(), await b.survey()], Array(2).fill({ accountId: ACCOUNT, worker: 'absent', build: null, key: 'unknown', others: null }), 'both surveyed: S1 on each')
  let release
  const held = new Promise((resolve) => { release = resolve })
  let holding = true
  at.fake.model.delay = (request) => { if (holding && request.path.endsWith('/workers/subdomain')) { holding = false; return held } return null }
  const running = b.setUp() // B: the script lookup says "no Worker"; its next read is held
  while (holding) await new Promise((resolve) => setImmediate(resolve))
  const done = await a.setUp() // A writes: the script, the switch, its key
  const keyA = a.keys()[0]
  const made = await session(at, keyA.key)
  assert.deepEqual([done.ok, done.created, made.status, at.worker().uploads], [true, true, 201, 1])
  release()
  const raced = await running // B writes, believing there is no Worker
  // Cloudflare refuses B's upload (its migrations start from "no Worker"): B's press fails, and nothing of A's is touched.
  assert.deepEqual([raced.ok, raced.error, raced.details, at.worker().uploads], [false, LIVE_SETUP_FAILED, 'Uploading the live service: Cloudflare answered 400 (error 10079).', 1])
  assert.deepEqual([await tokenPasses(at, made.token), (await session(at, keyA.key)).status, [...at.worker().values.keys()]], [true, 201, [`ADMIN_SECRET_${keyA.computerId}`]], 'A\'s token and key are as they were')
  // B presses again: it joins, with the key it made the first time.
  const joined = await b.setUp()
  const keyB = b.keys()[0]
  assert.deepEqual([joined.ok, joined.created, joined.others, b.profile.slot.writes.length, at.worker().uploads], [true, false, 1, 1, 1])
  assert.deepEqual([await tokenPasses(at, made.token), (await session(at, keyA.key)).status, (await session(at, keyB.key)).status], [true, 201, 201], 'A\'s earlier session token still passes, and both keys are accepted')
  assert.deepEqual([(await a.survey()).key, (await a.survey()).others, (await b.survey()).key], ['accepted', 1, 'accepted'])
  assert.deepEqual([at.domains(), sentTo(at).filter((line) => /^DELETE |\/domains|\/routes|\/zones/.test(line)), at.fake.namingSigningSecret()], [domains, [], []], 'no domain changed, and no signing secret named')
  // The other order of the same race: both read "no Worker", and B's upload lands first.
  const other = account()
  const [c, d] = [computer(other, { name: 'Mac C' }), computer(other, { name: 'Mac D' })]
  const both = await Promise.all([c.setUp(), d.setUp()])
  const winner = both[0].ok ? c : d
  const token = (await session(other, winner.keys()[0].key)).token
  for (const pc of [c, d]) assert.equal((await pc.setUp()).ok, true)
  assert.deepEqual([await tokenPasses(other, token), (await session(other, c.keys()[0].key)).status, (await session(other, d.keys()[0].key)).status, other.worker().values.size], [true, 201, 201, 2])
  console.log('PASS 11: two set-ups interleaved step by step: the later upload is refused by Cloudflare and changes nothing, the second computer joins on its next press, the first computer\'s session token still passes, both keys are accepted and no domain changed')
}

{
  // R6. Keys are kept per live service. One computer: account A, then B (where it is refused), then A again.
  const at = account()
  at.fake.model.workers.set(ACCOUNT_B, new Map([[NAME, { uploads: 1, migrationTag: 'v4', module: null, metadata: null, workersDev: true, secrets: [`ADMIN_SECRET_${OTHER_MAC.computerId}`], values: new Map([[`ADMIN_SECRET_${OTHER_MAC.computerId}`, OTHER_MAC.key]]) }]]))
  const liveB = liveWorkerDouble(at.fake, { account: ACCOUNT_B, name: NAME, address: ADDRESS_B, build: BUILD })
  at.lives.set(ADDRESS_B, { live: liveB, account: ACCOUNT_B })
  const subdomainOfB = (request) => (request.path === `/accounts/${ACCOUNT_B}/workers/subdomain` ? { status: 200, body: { success: true, errors: [], messages: [], result: { subdomain: SUBDOMAIN_B } } } : null)
  at.fake.model.answer = subdomainOfB
  const from = wire.length
  const pc = computer(at, { name: 'Travelling Mac' })
  assert.equal((await pc.setUp()).ok, true)
  const keyA = pc.keys()[0]
  const tokenA = (await session(at, keyA.key)).token
  // To account B. Nothing of A's is shown there: with no key for B, B is "set up on another computer".
  pc.accountId = ACCOUNT_B
  assert.deepEqual(await pc.survey(), { accountId: ACCOUNT_B, worker: 'present', build: BUILD, key: 'unknown', others: null })
  assert.deepEqual([liveB.requests.filter((request) => request.bearer).length, pc.keys(ACCOUNT_B, ADDRESS_B)], [0, []])
  // Set up on B, and B refuses: Cloudflare takes the secret, the live service never accepts it.
  liveB.state.lag = 10_000
  const refusedOnB = await pc.setUp()
  const keyB = pc.keys(ACCOUNT_B, ADDRESS_B)[0]
  assert.deepEqual([refusedOnB.error, pc.profile.entries(), (await pc.survey()).key], [LIVE_NOT_ACCEPTED_YET, [keyA, keyB], 'refused'], 'refused on B: a key for B was added beside A\'s, and A\'s is as it was')
  assert.deepEqual([pc.saved.length, pc.profile.config.liveWorkerAccountId], [1, ACCOUNT], 'B was never recorded as set up')
  // And refused by Cloudflare itself on B (a token that may not edit Workers there).
  at.fake.model.answer = (request) => subdomainOfB(request) ?? (request.method === 'PATCH' && request.path.startsWith(`/accounts/${ACCOUNT_B}/`) ? { status: 403, body: { success: false, errors: [{ code: 10000, message: 'no' }], messages: [], result: null } } : null)
  assert.equal((await pc.setUp()).ok, false)
  assert.deepEqual(pc.profile.entries(), [keyA, keyB], 'no entry removed or replaced by a refusal')
  at.fake.model.answer = subdomainOfB
  // Back to A: its entry is intact and accepted, and nothing is sent.
  pc.accountId = ACCOUNT
  const before = at.fake.requests.length
  assert.deepEqual([(await pc.survey()).key, (await pc.setUp()).ok, writesTo(at, before), pc.keys(), (await session(at, keyA.key)).status, await tokenPasses(at, tokenA)], ['accepted', true, [], [keyA], 201, true])
  // The request log: A's key only ever to A's address, B's only ever to B's; each registered only on its own account.
  const sent = wire.slice(from)
  assert.ok(sent.filter((request) => request.bearer === keyA.key).length >= 3 && sent.filter((request) => request.bearer === keyB.key).length >= 8)
  assert.deepEqual([[...new Set(sent.filter((request) => request.bearer === keyA.key).map((request) => request.origin))], [...new Set(sent.filter((request) => request.bearer === keyB.key).map((request) => request.origin))]], [[ADDRESS], [ADDRESS_B]], 'no bearer for A\'s key is ever sent to B\'s address, nor B\'s to A\'s')
  for (const request of at.fake.requests.filter((entry) => entry.method === 'PATCH')) {
    const body = request.body.toString()
    assert.equal(body.includes(keyA.key), request.path.startsWith(`/accounts/${ACCOUNT}/`))
    assert.equal(body.includes(keyB.key), request.path.startsWith(`/accounts/${ACCOUNT_B}/`))
  }
  assert.deepEqual([[...at.worker(ACCOUNT_B).values.keys()].sort(), at.worker(ACCOUNT_B).values.get(`ADMIN_SECRET_${OTHER_MAC.computerId}`)], [[`ADMIN_SECRET_${keyB.computerId}`, `ADMIN_SECRET_${OTHER_MAC.computerId}`].sort(), OTHER_MAC.key], 'the computer that set B up keeps its key')

  // The 0.38.2 key refused (the Worker was made again): S5, then the person's set-up press gives this
  // computer its own key, accepted, and the 0.38.2 entry is still in the blob.
  const remade = account({ worker: { secrets: [], values: new Map() } })
  const veteran = computer(remade, { keys: legacyProfile(), name: 'First Mac' })
  veteran.profile.config.liveWorkerVersion = BUILD
  veteran.profile.store.migrate()
  const seen = await veteran.survey()
  assert.deepEqual([seen.key, computerState({ worker: seen.worker, recorded: 'this-account', key: 'legacy', answer: seen.key, workerBuild: seen.build, appBuild: BUILD })], ['refused', 'S5'])
  assert.deepEqual([veteran.profile.entries(), writesTo(remade)], [[legacyEntry], []], 'a refusal alone changes nothing: no key made, nothing sent')
  // The rewrite of the blob fails: nothing is sent, and the old blob is as it was and still read.
  veteran.profile.slot.failWrite = true
  const text = veteran.profile.slot.text
  assert.deepEqual([(await veteran.setUp()).error, veteran.profile.slot.text, veteran.keys(), writesTo(remade)], [LIVE_KEY_NOT_STORED, text, [legacyEntry], []])
  veteran.profile.slot.failWrite = false
  const again = await veteran.setUp()
  const [own, kept] = veteran.keys()
  assert.deepEqual([again.ok, own.kind, kept, veteran.profile.entries(), Object.keys(patches(remade)[0]), patches(remade).length], [true, 'own', legacyEntry, [legacyEntry, own], [`ADMIN_SECRET_${own.computerId}`], 1], 'its own key, stored beside the 0.38.2 one')
  assert.deepEqual([again.adminSecret === own.key, (await session(remade, own.key)).status, (await veteran.survey()).key, remade.worker().values.has('ADMIN_SECRET')], [true, 201, 'accepted', false], 'accepted; ADMIN_SECRET was never sent')
  assert.ok(!wire.some((request) => request.bearer === LEGACY_KEY && request.origin !== ADDRESS))
  console.log('PASS 12: account A, then B with refusals, then A: each key is shown to and registered on its own live service only, and no entry is removed; a refused 0.38.2 key is S5, and set-up stores this computer\'s own beside it; a failed rewrite leaves the old blob readable')
}

{
  // R10. Two computers that update inside the propagation window are last-write-wins: there is no
  // conditional upload. So after its upload this app reads the build once more. Each row: what the
  // live service answers as once this computer's key was accepted (the read-back comes after that).
  const number = buildNumber(BUILD)
  const DECIDED = `${number - 2}-read-before-the-upload`
  const LOWER = `${number - 1}-another-computers-older-app`
  const HIGHER = `${number + 1}-another-computers-newer-app`
  const readBack = async (after, { settlesAfter = Infinity, waitMs } = {}) => {
    const at = account({ worker: legacyWorker() })
    const pc = computer(at, { keys: legacyProfile(), name: 'First Mac' })
    let accepted = false
    let readsBack = 0
    // When each read-back was made, in ms from the first one (the clock moves only by the pauses asked for).
    const readAt = []
    let from = null
    // The decision read answers the older build; the upload makes it this app's; `after` is what answers once the key was
    // accepted: a build, or `(ms) => build` for what answers that long after the first read-back.
    const answers = () => (typeof after === 'function' ? after(readAt.at(-1) ?? 0) : after)
    at.live.state.build = (worker) => (worker.uploads === 1 ? DECIDED : !accepted || answers() === BUILD || readsBack > settlesAfter ? BUILD : answers())
    const reach = pc.ports.liveFetch
    pc.ports.liveFetch = async (input, init) => {
      const route = new URL(String(input)).pathname
      if (route === '/capabilities' && accepted) { readsBack += 1; from ??= pc.ticking.clock.at; readAt.push(pc.ticking.clock.at - from); if (after === null) throw new TypeError('fetch failed') }
      const answer = await reach(input, init)
      if (route === '/computers' && answer.status === 200) accepted = true
      return answer
    }
    if (waitMs !== undefined) pc.ports.live = { ...pc.ports.live, waitMs }
    const result = await pc.setUp()
    return { at, pc, result, uploads: writesTo(at).filter((line) => line === `PUT ${script}`).length, readsBack: () => readsBack, readAt }
  }
  // Lower: another computer's older TalkWeaver landed over this upload. Said so; ONE upload, no second one.
  const lower = await readBack(LOWER)
  assert.deepEqual([lower.result.ok, lower.result.error, lower.uploads, lower.at.worker().uploads, writesTo(lower.at), lower.pc.saved], [false, LIVE_OVERWRITTEN, 1, 2, [`PUT ${script}`, `POST ${script}/subdomain`], []], 'a lower build at read-back: the fixed sentence, exactly one upload, nothing saved')
  assert.equal(lower.result.error, 'Another computer updated your live service at the same moment, with an older TalkWeaver. Press Update again on this computer.')
  assert.equal(lower.result.details, `This TalkWeaver uploaded build ${BUILD}; the live service now answers as build ${LOWER}.`, 'Details name both builds')
  assert.ok(lower.readsBack() > 1, 'a lower build is asked about again before it is believed (the code from before an upload may answer for a few seconds)')
  // With no time to wait, one read decides: still one upload.
  const once = await readBack(LOWER, { waitMs: 0 })
  assert.deepEqual([once.result.error, once.uploads, once.readsBack()], [LIVE_OVERWRITTEN, 1, 1])
  // The person presses Update again: THAT press reads the lower build and uploads over it. Never the app by itself.
  const pressedFrom = lower.at.fake.requests.length
  lower.at.live.state.build = (worker) => (worker.uploads === 2 ? LOWER : BUILD)
  const pressed = await lower.pc.setUp()
  assert.deepEqual([pressed.ok, writesTo(lower.at, pressedFrom), lower.at.worker().uploads], [true, [`PUT ${script}`, `POST ${script}/subdomain`], 3], 'the second upload is the second press')
  // Control: this app's own build answers. And a higher one (a newer TalkWeaver elsewhere) is fine too.
  for (const [what, after] of [['its own build', BUILD], ['a higher build', HIGHER]]) {
    const fine = await readBack(after)
    assert.deepEqual([fine.result.ok, fine.uploads, fine.pc.saved.length, fine.readsBack()], [true, 1, 1, 1], `${what} at read-back: success as before, one upload, one read`)
  }
  // No readable answer at read-back: asked again up to the deadline, and no new failure (as before this read existed).
  const silent = await readBack(null)
  assert.deepEqual([silent.result.ok, silent.result.pending, silent.uploads, silent.readsBack(), silent.pc.saved.length], [true, undefined, 1, 11, 1], 'unreadable at read-back, the read at the deadline too: success as before')
  // The code from before the upload still answers for two reads, then this app's: not taken as another computer's.
  const settling = await readBack(DECIDED, { settlesAfter: 2 })
  assert.deepEqual([settling.result.ok, settling.uploads, settling.readsBack()], [true, 1, 3], 'a build that settles inside the window is not an overwrite')
  // ── The deadline, and a delayed activation told from an overwrite (R10 as amended) ──
  // The reads are made at these moments, the last one AT the deadline (the pause before it is cut to end there), and none after it.
  const READS = [0, 500, 1500, 3000, 5000, 8000, 13_000, 18_000, 23_000, 28_000, 30_000]
  assert.equal(keyModule.READ_BACK_WAIT_MS, 30_000)
  // This app's build becomes visible at 29 s: the read at 30 s sees it. Success, one upload, saved, nothing to say.
  const late = await readBack((ms) => (ms >= 29_000 ? BUILD : DECIDED))
  assert.deepEqual([late.result.ok, late.result.pending, late.uploads, late.pc.saved.length, late.readAt], [true, undefined, 1, 1, READS], 'visible at 29 s: the read at the deadline sees it')
  // The build from BEFORE this upload still answers at the deadline: Cloudflare has not switched to the upload yet. Not an overwrite:
  // success with the fixed sentence beside it, saved as a finished update, ONE upload.
  for (const [what, after] of [['for the whole window', DECIDED], ['until 31 s (no read is made after the deadline)', (ms) => (ms >= 31_000 ? BUILD : DECIDED)], ['at the deadline, after another lower build answered for a while', (ms) => (ms >= 30_000 ? DECIDED : LOWER)]]) {
    const waiting = await readBack(after)
    assert.deepEqual([waiting.result.ok, waiting.result.error, waiting.result.pending, waiting.uploads, waiting.at.worker().uploads, waiting.pc.saved.length, waiting.readAt],
      [true, undefined, { notice: LIVE_UPDATE_PENDING, build: DECIDED }, 1, 2, 1, READS], `the pre-upload build ${what}: pending, not overwritten, one upload`)
  }
  assert.equal(LIVE_UPDATE_PENDING, 'TalkWeaver uploaded the update. Cloudflare has not switched to it yet. Check again in a few minutes.')
  // A lower build that is NOT the one from before the upload, at the deadline: a proved overwrite. One upload, nothing saved.
  for (const [what, after] of [['for the whole window', LOWER], ['from 29 s, after the pre-upload build', (ms) => (ms >= 29_000 ? LOWER : DECIDED)]]) {
    const over = await readBack(after)
    assert.deepEqual([over.result.ok, over.result.error, over.result.details, over.uploads, over.at.worker().uploads, over.pc.saved, over.readAt],
      [false, LIVE_OVERWRITTEN, `This TalkWeaver uploaded build ${BUILD}; the live service now answers as build ${LOWER}.`, 1, 2, [], READS], `a different lower build ${what}: overwritten, one upload`)
  }
  // With no time to wait the one read is the deadline's: the pre-upload build is pending there too.
  const atOnce = await readBack(DECIDED, { waitMs: 0 })
  assert.deepEqual([atOnce.result.ok, atOnce.result.pending?.build, atOnce.uploads, atOnce.readAt], [true, DECIDED, 1, [0]])
  // The same number with other text is not lower: success at the first read.
  const twin = await readBack(`${number}-same-number-other-text`)
  assert.deepEqual([twin.result.ok, twin.result.pending, twin.uploads, twin.readAt], [true, undefined, 1, [0]])
  // The read-back itself, by the moment the answer changes: `before` is the build the upload went over (null: there was no live service).
  {
    const ask = async (before, buildAt, { waitMs, stopAt = Infinity } = {}) => {
      const ticking = instantClock()
      const readAt = []
      const io = { ...ticking.live, ...(waitMs === undefined ? {} : { waitMs }), fetch: async () => { readAt.push(ticking.clock.at); const build = buildAt(ticking.clock.at); if (build === null) throw new TypeError('fetch failed'); return Response.json({ build }) } }
      return { read: await keyModule.readBackAfterUpload(io, ADDRESS, BUILD, before, () => ticking.clock.at >= stopAt), readAt, pauses: ticking.clock.pauses }
    }
    const HIGHER_BUILD = HIGHER
    const until = (ms, then, first) => (at) => (at >= ms ? then : first)
    for (const [ms, sees] of [[0, [0]], [28_000, READS.slice(0, 10)], [29_000, READS], [30_000, READS]]) {
      for (const then of [BUILD, HIGHER_BUILD, `${number}-same-number-other-text`]) {
        const seen = await ask(DECIDED, until(ms, then, DECIDED))
        assert.deepEqual([seen.read, seen.readAt], [{ outcome: 'active' }, sees], `${then} from ${ms} ms: active, read at ${sees.at(-1)} ms last`)
      }
      // No readable answer from that moment: asking goes on to the deadline, and the read there, unreadable, is no failure.
      for (const then of [null, 'not a build']) {
        const seen = await ask(DECIDED, until(ms, then, DECIDED))
        assert.deepEqual([seen.read, seen.readAt], [{ outcome: 'active' }, READS], `${then} from ${ms} ms: asked to the deadline, active`)
      }
      // Unreadable for a while, then a lower build at the deadline: the unreadable reads decided nothing.
      assert.deepEqual((await ask(DECIDED, (at) => (at >= 30_000 ? LOWER : at >= ms ? null : DECIDED))).read, { outcome: 'overwritten', build: LOWER })
      // A different lower build from that moment: overwritten, and only the read at the deadline says so.
      assert.deepEqual([(await ask(DECIDED, until(ms, LOWER, DECIDED))).read, (await ask(DECIDED, until(ms, LOWER, DECIDED))).readAt], [{ outcome: 'overwritten', build: LOWER }, READS])
      // … and the pre-upload build from that moment, after another lower one: pending.
      assert.deepEqual((await ask(DECIDED, until(ms, DECIDED, LOWER))).read, { outcome: 'pending', build: DECIDED })
    }
    // From 31 s: never seen, because nothing is read after the deadline.
    for (const then of [BUILD, HIGHER_BUILD, LOWER]) {
      const never = await ask(DECIDED, until(31_000, then, DECIDED))
      assert.deepEqual([never.read, never.readAt, never.pauses.reduce((sum, ms) => sum + ms, 0)], [{ outcome: 'pending', build: DECIDED }, READS, 30_000], 'no read and no pause after the deadline')
    }
    // A first set-up went over nothing: any lower build there is another computer's.
    assert.deepEqual((await ask(null, () => DECIDED)).read, { outcome: 'overwritten', build: DECIDED })
    // A longer wait asked for is cut to the 30 seconds; a shorter one ends with a read at its own deadline.
    assert.deepEqual([(await ask(DECIDED, () => DECIDED, { waitMs: 600_000 })).readAt, (await ask(DECIDED, () => DECIDED, { waitMs: 700 })).readAt, (await ask(DECIDED, () => DECIDED, { waitMs: -5 })).readAt], [READS, [0, 500, 700], [0]])
    // The run is no longer the one in charge: it stops asking (the caller answers "superseded", whatever was read).
    const stopped = await ask(DECIDED, () => LOWER, { stopAt: 1500 })
    assert.deepEqual([stopped.readAt, stopped.read], [[0, 500, 1500], { outcome: 'active' }], 'stopped: nothing more is read, and a lower build read before the deadline concludes nothing')
    // ── Answers that take time (a clock on which requests, pauses and time limits all run) ──
    {
      const LIMIT = keyModule.LIVE_REQUEST_MS
      assert.equal(LIMIT, 10_000)
      /** `answer(startedAt)`: `{ after, build }` (the answer comes `after` ms later; `build: null` is an answer that cannot be read), or null (no answer ever). */
      const slow = async (before, answer) => {
        let at = 0
        const timers = []
        const after = (ms) => new Promise((resolve) => { timers.push({ due: at + ms, resolve }) })
        const readAt = []
        const io = {
          now: () => at, wait: after, timer: after,
          fetch: async () => {
            readAt.push(at)
            const reply = answer(at)
            if (!reply) return new Promise(() => {})
            await after(reply.after)
            return { ok: reply.build !== null, status: reply.build === null ? 500 : 200, body: null, json: async () => ({ build: reply.build }) }
          },
        }
        let read
        const asked = keyModule.readBackAfterUpload(io, ADDRESS, BUILD, before).then((found) => { read = found })
        // The clock moves to the next thing due only when nothing more can happen at this moment.
        while (read === undefined) {
          await new Promise((resolve) => setImmediate(resolve))
          if (read !== undefined) break
          timers.sort((a, b) => a.due - b.due)
          const next = timers.shift()
          assert.ok(next, 'something is always due while the read-back runs')
          at = Math.max(at, next.due)
          next.resolve()
        }
        await asked
        // Whatever the answers did: no read starts after the deadline, and exactly one starts AT it (unless an earlier one ended it).
        assert.ok(readAt.every((ms) => ms <= 30_000), `no read starts after the deadline (${readAt})`)
        assert.ok(readAt.filter((ms) => ms === 30_000).length <= 1, 'one final read')
        if (read.outcome !== 'active') assert.equal(readAt.at(-1), 30_000, 'only the read at the deadline says pending or overwritten')
        return { read, readAt, at }
      }
      const quick = (build) => ({ after: 50, build })
      // This app's build at 0 s: active after one read.
      assert.deepEqual(await slow(DECIDED, () => quick(BUILD)), { read: { outcome: 'active' }, readAt: [0], at: 50 })
      // … also when that first answer takes two seconds.
      assert.deepEqual(await slow(DECIDED, () => ({ after: 2000, build: BUILD })), { read: { outcome: 'active' }, readAt: [0], at: 2000 })
      // Lower until 29 s, this app's at the final read: active. (Each read's 50 ms moves the next one; the final one is still at the deadline.)
      const settled = await slow(DECIDED, (ms) => quick(ms >= 29_000 ? BUILD : LOWER))
      assert.deepEqual([settled.read, settled.readAt.at(-1), settled.readAt.length], [{ outcome: 'active' }, 30_000, 11])
      // The reviewer's case: a read started before the deadline answers LOWER at 31.1 s. It decides nothing: the final read, started at 30 s, does.
      const lateLower = (final) => (ms) => (ms >= 30_000 ? final : ms >= 27_000 ? { after: 31_100 - ms, build: LOWER } : quick(DECIDED))
      const overtaken = await slow(DECIDED, lateLower({ after: 2000, build: BUILD }))
      assert.deepEqual([overtaken.read, overtaken.readAt.at(-1), overtaken.readAt.filter((ms) => ms >= 27_000).length, overtaken.at], [{ outcome: 'active' }, 30_000, 2, 32_000], 'a lower answer at 31.1 s from a read started before the deadline is not an overwrite')
      // … nor does it turn "not switched to yet" into an overwrite, when it arrives before the final read's own answer.
      assert.deepEqual((await slow(DECIDED, lateLower({ after: 2000, build: DECIDED }))).read, { outcome: 'pending', build: DECIDED })
      // The final read answers as the pre-upload build: pending. As a different lower build: overwritten. Slowly, too.
      assert.deepEqual((await slow(DECIDED, () => quick(DECIDED))).read, { outcome: 'pending', build: DECIDED })
      assert.deepEqual((await slow(DECIDED, (ms) => (ms >= 30_000 ? { after: 9000, build: LOWER } : quick(DECIDED)))).read, { outcome: 'overwritten', build: LOWER })
      assert.deepEqual((await slow(null, () => quick(DECIDED))).read, { outcome: 'overwritten', build: DECIDED }, 'a first set-up went over nothing')
      // The final read gets no answer inside its own time limit: active (no new failure), and the wait ends there.
      for (const final of [null, { after: LIMIT + 1, build: LOWER }, { after: 100, build: null }]) {
        const silentEnd = await slow(DECIDED, (ms) => (ms >= 30_000 ? final : quick(LOWER)))
        assert.deepEqual([silentEnd.read, silentEnd.readAt.at(-1), silentEnd.at <= 30_000 + LIMIT], [{ outcome: 'active' }, 30_000, true], 'no answer, a late one or an unreadable one at the deadline: active')
      }
      // A read mid-way that never answers is given up after its own limit, and asking goes on: the final read still decides.
      const stuck = await slow(DECIDED, (ms) => (ms > 4000 && ms < 6000 ? null : quick(ms >= 30_000 ? LOWER : DECIDED)))
      assert.deepEqual([stuck.read, stuck.readAt.at(-1), stuck.readAt.some((ms) => ms > 6000 && ms < 30_000)], [{ outcome: 'overwritten', build: LOWER }, 30_000, true])
      // No answer at all, ever: every read is given up, the last at its limit after the deadline. Active.
      const dead = await slow(DECIDED, () => null)
      assert.deepEqual([dead.read, dead.readAt.at(-1), dead.at], [{ outcome: 'active' }, 30_000, 30_000 + LIMIT])
      // This app's build answering a read that was started before the deadline and given up at it is not needed: the final read sees it.
      assert.deepEqual((await slow(DECIDED, (ms) => (ms >= 27_000 ? { after: 4000, build: BUILD } : quick(DECIDED)))).read, { outcome: 'active' })
    }
    // An app build with no number decides nothing, and reads nothing.
    const none = instantClock()
    assert.deepEqual(await keyModule.readBackAfterUpload({ ...none.live, fetch: async () => { throw new Error('not asked') } }, ADDRESS, 'no-number', DECIDED), { outcome: 'active' })
    // Reads only: the function is handed nothing it could upload with, and the sequence calls it once, after the key, before the save.
    const deploySource = readSource(join(repo, 'src/main/live-service-deploy.ts'))
    assert.deepEqual([[...deploySource.matchAll(/readBackAfterUpload\(/g)].length, [...deploySource.matchAll(/planLiveServiceUpload\(/g)].length], [1, 1], 'one read-back and one upload plan in the sequence: nothing uploads twice')
    assert.ok(deploySource.indexOf('planLiveServiceUpload(') < deploySource.indexOf('readBackAfterUpload(') && deploySource.indexOf('readBackAfterUpload(') < deploySource.indexOf('ports.save('))
  }
  console.log('PASS 12a-2 (R10, amended): the first read showing this app\'s build ends the read-back; a lower, unreadable, slow or unanswered read before the deadline decides nothing; the one final read is started at the 30-second deadline and alone decides; this app\'s build visible at 29 s is success; the pre-upload build still answering then is "uploaded, not switched to yet" (success, saved, one upload); a different lower build is an overwrite; nothing is read after the deadline and nothing is uploaded twice')
  // No upload in this run (the same build was read): no read-back at all.
  const same = account({ worker: legacyWorker() })
  const still = computer(same, { keys: legacyProfile() })
  const capabilitiesBefore = same.live.requests.filter((request) => request.route === '/capabilities').length
  assert.deepEqual([(await still.setUp()).ok, same.live.requests.filter((request) => request.route === '/capabilities').length - capabilitiesBefore, writesTo(same)], [true, 1, []], 'with nothing uploaded, the build is read once, for the decision')
  // What the migration tag does NOT do: an upload that carries no `migrations` block is taken over a
  // deployed tag, whichever build it carries. Cloudflare's tag precondition gives no protection here.
  const tagged = account({ worker: legacyWorker() })
  const files = workerDistFiles({ repo, bundle: Buffer.from('export default {}\n') })
  const verified = verifyShippedBundle(files.manifestText, { bundle: files.bundle, config: files.configBytes })
  const [upload] = planLiveServiceUpload({ config: verified.config, manifest: verified.manifest, bundle: verified.bundle, accountId: ACCOUNT, deployedMigrationTag: 'v4' })
  assert.ok(!('migrations' in upload.body.metadata), '(an update with nothing new carries no migrations block)')
  const taken = []
  for (let turn = 0; turn < 2; turn += 1) {
    const form = new FormData()
    form.set('metadata', JSON.stringify(upload.body.metadata))
    form.set(upload.body.module.name, new File([new Uint8Array(upload.body.module.bytes)], upload.body.module.name, { type: upload.body.module.type }))
    taken.push((await fakeCloudflareFetch(tagged.fake)(`http://127.0.0.1:9/client/v4${upload.path}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}` }, body: form })).status)
  }
  assert.deepEqual([taken, tagged.worker().uploads, tagged.worker().migrationTag], [[200, 200], 3, 'v4'], 'two uploads with no migrations block, one after the other, are both accepted at tag v4')
  console.log('PASS 12a (R10): after its upload the app reads the build again: a lower build is "another computer updated … with an older TalkWeaver", with both builds in Details, exactly one upload and none without a press; its own build, a higher one, an unreadable one and one that settles inside the window are success; an upload with no migrations block is accepted over a deployed tag')
}

{
  // R9. A key's binding is written once and never worked out again. A blob that is not yet in this
  // build's form (0.38.2's, or the format-2 blob of this branch's first build) gives NO key while its
  // rewrite fails: nothing is presented, made or sent. Settings change meanwhile; the rewrite that is
  // finally taken binds the key to what Settings say THEN, and to nothing else, before or after.
  const FORMAT2_OWN = { computerId: 'abab1212cdcd3434', key: ['made-up-format-two-admin', 'abcdef0123456789'].join('-') } // gitleaks:allow (made-up test value)
  const FORMS = [
    ['the 0.38.2 blob', legacyBlob(), LEGACY_KEY, 'legacy', 'legacy'],
    ['a format-2 blob holding the 0.38.2 key', JSON.stringify({ format: 2, computerId: 'legacy', adminSecret: LEGACY_KEY }), LEGACY_KEY, 'legacy', 'legacy'],
    ['a format-2 blob holding this computer\'s own key', JSON.stringify({ format: 2, computerId: FORMAT2_OWN.computerId, adminSecret: FORMAT2_OWN.key }), FORMAT2_OWN.key, 'own', FORMAT2_OWN.computerId],
  ]
  for (const [what, blob, secret, kind, id] of FORMS) {
    // Both live services would accept the key: only the binding keeps it from the wrong one.
    const holding = () => { const worker = legacyWorker(); worker.secrets.push(`ADMIN_SECRET_${FORMAT2_OWN.computerId}`); worker.values.set(`ADMIN_SECRET_${FORMAT2_OWN.computerId}`, FORMAT2_OWN.key); return worker }
    const at = account({ worker: holding() })
    at.fake.model.workers.set(ACCOUNT_B, new Map([[NAME, { uploads: 1, migrationTag: 'v4', module: null, metadata: null, workersDev: true, ...holding() }]]))
    const liveB = liveWorkerDouble(at.fake, { account: ACCOUNT_B, name: NAME, address: ADDRESS_B, build: BUILD })
    at.lives.set(ADDRESS_B, { live: liveB, account: ACCOUNT_B })
    at.fake.model.answer = (request) => (request.path === `/accounts/${ACCOUNT_B}/workers/subdomain` ? { status: 200, body: { success: true, errors: [], messages: [], result: { subdomain: SUBDOMAIN_B } } } : null)
    const held = profile({ text: blob, config: { liveWorkerAccountId: ACCOUNT, liveWorkerBaseUrl: ADDRESS, liveWorkerVersion: BUILD } })
    const pc = computer(at, { keys: held, name: 'First Mac' })
    const from = wire.length
    const shown = () => wire.slice(from).filter((request) => request.bearer !== null)
    const nothingYet = (when) => {
      assert.deepEqual([held.slot.text, held.slot.writes, wire.length - from, at.fake.requests.length, at.live.requests.length, liveB.requests.length, pc.saved], [blob, [], 0, 0, 0, 0, []], `${what}, ${when}: the blob as it was, and not one request to Cloudflare or to any live service`)
    }
    // The rewrite fails (as the main process tries it when it opens the store, and on every read after).
    held.slot.failWrite = true
    held.store.migrate()
    for (const read of [() => held.store.check(), () => held.store.keysFor(service()), () => held.store.keysFor(service(ACCOUNT_B, ADDRESS_B)), () => held.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })]) assert.throws(read, KeyStoreUnreadable, `${what}: unreadable while it is not bound`)
    assert.deepEqual([await pc.setUp(), await pc.survey()], [{ ok: false, error: LIVE_KEY_UNREADABLE }, null], what)
    assert.throws(() => pc.keys(), KeyStoreUnreadable, `${what}: a use has no key to present`)
    nothingYet('recorded for account A')
    // Settings change under the unbound blob: another account, another address. Still nothing.
    Object.assign(held.config, { liveWorkerAccountId: ACCOUNT_B, liveWorkerBaseUrl: ADDRESS_B })
    pc.accountId = ACCOUNT_B
    assert.deepEqual([await pc.setUp(), await pc.survey()], [{ ok: false, error: LIVE_KEY_UNREADABLE }, null], what)
    assert.throws(() => held.store.keysFor(service(ACCOUNT_B, ADDRESS_B)), KeyStoreUnreadable)
    nothingYet('after Settings changed to account B')
    // The write is allowed: bound to what Settings say at THIS moment (B), in one write, read back.
    held.slot.failWrite = false
    const bound = { accountId: ACCOUNT_B, workerName: NAME, computerId: id, key: secret, kind }
    assert.deepEqual([held.store.keysFor(service(ACCOUNT_B, ADDRESS_B)), held.store.keysFor(service()), held.entries(), held.slot.writes.length, shown()], [[bound], [], [bound], 1, []], `${what}: bound to account B by the migration that succeeded; no bearer was sent before it`)
    // Settings change back to A: the binding does not follow. A's live service is never shown the key.
    Object.assign(held.config, { liveWorkerAccountId: ACCOUNT, liveWorkerBaseUrl: ADDRESS })
    held.store.migrate()
    pc.accountId = ACCOUNT
    assert.deepEqual([held.store.keysFor(service()), held.entries(), held.slot.writes.length, (await pc.survey()).key, shown()], [[], [bound], 1, 'unknown', []], `${what}: not rebound when Settings change again`)
    pc.accountId = ACCOUNT_B
    assert.equal((await pc.survey()).key, 'accepted', `${what}: used on the live service it was bound to`)
    assert.ok(shown().length > 0 && shown().every((request) => request.bearer === secret && request.origin === ADDRESS_B), `${what}: the key was shown to account B's live service only`)
    assert.equal(at.live.requests.filter((request) => request.bearer).length, 0, `${what}: account A's live service never saw a bearer`)
  }
  // The same for a 0.38.2 profile that recorded an address and no account: bound to the address of the successful rewrite.
  const byAddressConfig = { liveWorkerBaseUrl: ADDRESS }
  const unbound = profile({ text: legacyBlob(), config: byAddressConfig })
  unbound.slot.failWrite = true
  unbound.store.migrate()
  assert.throws(() => unbound.store.keysFor(service(null, ADDRESS)), KeyStoreUnreadable)
  byAddressConfig.liveWorkerBaseUrl = ADDRESS_B
  unbound.slot.failWrite = false
  assert.deepEqual([unbound.store.keysFor(service(null, ADDRESS)), unbound.store.keysFor(service(ACCOUNT, ADDRESS_B)).map((entry) => entry.address)], [[], [ADDRESS_B]])
  byAddressConfig.liveWorkerBaseUrl = ADDRESS
  assert.deepEqual([unbound.store.keysFor(service(null, ADDRESS)), unbound.slot.writes.length], [[], 1])
  // The store has no way to hand over an entry that was not read from a bound slot.
  const storeSource = readSource(join(repo, 'src/main/live-service-key.ts')).split('export function createComputerKeyStore')[1].split('\n// ── 2.')[0]
  assert.ok(/if \(!now\.old\) return now\.entries/.test(storeSource) && /if \(back !== bound\) throw new KeyStoreUnreadable\(\)/.test(storeSource) && !/let |cache|memo/.test(storeSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/let text/g, '')), 'no binding is kept in memory')
  console.log(`PASS 12b (R9): ${FORMS.length} forms of a blob that is not yet bound give no key while the rewrite fails: set-up, survey and a use stop with nothing sent; after Settings changed, the rewrite that is taken binds the key to what Settings say then, and it is never rebound`)
}

{
  // S-b. Which key is presented. A 0.38.2 key that still works and this computer's own, not registered
  // (a set-up that stored it and stopped): the live service is asked about its own first, then the
  // 0.38.2 one. That computer can go live, and is not "access was removed".
  const at = account({ worker: legacyWorker() })
  const pc = computer(at, { keys: legacyProfile(), name: 'First Mac' })
  pc.profile.config.liveWorkerVersion = BUILD
  pc.profile.store.migrate()
  const own = pc.profile.store.ownKeyFor({ accountId: ACCOUNT, workerName: NAME })
  assert.deepEqual(pc.keys(), [own, legacyEntry])
  const io = () => ({ fetch: pc.liveFetch, ...instantClock().live })
  let from = wire.length
  assert.deepEqual([await pc.survey(), wire.slice(from).filter((request) => request.route === '/computers').map((request) => request.bearer === own.key)], [{ accountId: ACCOUNT, worker: 'present', build: BUILD, key: 'accepted', others: 0 }, [true, true, false]], 'its own key asked about twice, then the 0.38.2 one: accepted, not S5')
  from = wire.length
  const presented = await keyToPresent(io(), service(), pc.keys())
  assert.deepEqual([presented, (await session(at, presented.key)).status, wire.slice(from).map((request) => request.bearer === own.key)], [legacyEntry, 201, [true, false]], 'a use presents the key the live service accepts')
  // A press of set-up from there: accepted with the 0.38.2 key, nothing sent, nothing made.
  const before = at.fake.requests.length
  const pressed = await pc.setUp()
  assert.deepEqual([pressed.ok, pressed.adminSecret === LEGACY_KEY, writesTo(at, before), pc.profile.entries()], [true, true, [], [legacyEntry, own]])
  // "Access was removed" only when EVERY key held is refused by a 401.
  at.worker().values.delete('ADMIN_SECRET')
  assert.deepEqual([(await pc.survey()).key, await acceptedKey(io(), service(), pc.keys()), (await keyToPresent(io(), service(), pc.keys())).kind], ['refused', { answer: 'refused', key: null, others: null }, 'own'])
  // Never on a network error, or another status, about any of them.
  at.worker().values.set('ADMIN_SECRET', LEGACY_KEY)
  const failing = (fails) => ({ ...io(), fetch: async (input, init = {}) => {
    const bearer = new Headers(init.headers).get('authorization')
    if (fails.own && bearer === `Bearer ${own.key}`) return fails.own()
    if (fails.legacy && bearer === `Bearer ${LEGACY_KEY}`) return fails.legacy()
    return pc.liveFetch(input, init)
  } })
  const down = () => { throw new TypeError('fetch failed') }
  const broken = () => new Response('upstream error', { status: 502 })
  at.worker().values.delete('ADMIN_SECRET')
  for (const [what, fails] of [['no answer about the 0.38.2 key', { legacy: down }], ['a 502 about the 0.38.2 key', { legacy: broken }], ['no answer about its own', { own: down }], ['a 403 about its own', { own: () => new Response('forbidden', { status: 403 }) }]]) {
    assert.deepEqual(await acceptedKey(failing(fails), service(), pc.keys(), 1500), { answer: 'unknown', key: null, others: null }, `${what}: not "removed"`)
  }
  at.live.state.unreachable = true
  assert.deepEqual([(await pc.survey()).key, (await acceptedKey(io(), service(), pc.keys())).answer], ['unknown', 'unknown'])
  at.live.state.unreachable = false
  at.worker().values.set('ADMIN_SECRET', LEGACY_KEY)
  // Its own answers nothing and the 0.38.2 one is accepted: usable.
  assert.deepEqual((await acceptedKey(failing({ own: down }), service(), pc.keys())).key, legacyEntry)
  // Go live when NEITHER probe is answered: its own key is the one chosen, the live service's 401 for it
  // is followed by one more POST with the 0.38.2 key, and that is a session, not "access was removed".
  const post = (key) => pc.liveFetch(`${ADDRESS}/sessions`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
  const posts = (since) => wire.slice(since).filter((request) => request.route === '/sessions').map((request) => (request.bearer === own.key ? 'own' : request.bearer === LEGACY_KEY ? '0.38.2' : 'other'))
  const unanswered = { ...io(), fetch: async (input, init) => (new URL(String(input)).pathname === '/computers' ? down() : pc.liveFetch(input, init)) }
  const chosen = await keyToPresent(unanswered, service(), pc.keys())
  from = wire.length
  const went = await sendWithHeldKeys(service(), pc.keys(), chosen.key, post)
  assert.deepEqual([chosen, went.response.status, went.refused, posts(from)], [own, 201, false, ['own', '0.38.2']], 'the other key held is tried once before anything is said')
  // The other way round (the 0.38.2 key chosen and refused, its own registered): its own is tried.
  at.worker().values.delete('ADMIN_SECRET')
  at.worker().values.set(`ADMIN_SECRET_${own.computerId}`, own.key)
  from = wire.length
  assert.deepEqual([(await sendWithHeldKeys(service(), pc.keys(), LEGACY_KEY, post)).refused, posts(from)], [false, ['0.38.2', 'own']])
  // "Access was removed" only when EVERY key held got the 401; each was sent once.
  at.worker().values.delete(`ADMIN_SECRET_${own.computerId}`)
  from = wire.length
  const none = await sendWithHeldKeys(service(), pc.keys(), own.key, post)
  assert.deepEqual([none.refused, none.response.status, await keyModule.isAdminRefusal(none.response), posts(from)], [true, 401, true, ['own', '0.38.2']])
  // No answer to the second try is thrown on, and another status is handed back: neither is "removed".
  await assert.rejects(sendWithHeldKeys(service(), pc.keys(), own.key, (key) => (key === LEGACY_KEY ? down() : post(key))), /fetch failed/)
  await assert.rejects(sendWithHeldKeys(service(), pc.keys(), own.key, down), /fetch failed/)
  assert.deepEqual(await Promise.all([broken, () => new Response('{"error":{"code":"other"}}', { status: 401 })].map(async (other) => {
    const said = await sendWithHeldKeys(service(), pc.keys(), own.key, (key) => (key === LEGACY_KEY ? other() : post(key)))
    return [said.refused, said.response.status]
  })), [[false, 502], [false, 401]])
  // A key goes only to the live service its entry is for: one held for another account is never sent,
  // and a secret that is not one of the keys held for this service is sent alone.
  const elsewhere = { accountId: ACCOUNT_B, workerName: NAME, computerId: newComputerId(), key: 'k'.repeat(43), kind: 'own' }
  from = wire.length
  assert.deepEqual([(await sendWithHeldKeys(service(), [...pc.keys(), elsewhere], own.key, post)).refused, posts(from)], [true, ['own', '0.38.2']])
  from = wire.length
  assert.deepEqual([(await sendWithHeldKeys(service(), pc.keys(), 'handed-over', post)).refused, (await sendWithHeldKeys(service(ACCOUNT_B, ADDRESS), pc.keys(), own.key, post)).refused, posts(from)], [true, true, ['other', 'own']])
  // A 401 that is not the live service's refusal of an admin key concludes nothing about a key.
  assert.deepEqual(await acceptedKey({ ...io(), fetch: async () => new Response('Unauthorized', { status: 401 }) }, service(), pc.keys()), { answer: 'unknown', key: null, others: null })
  at.worker().values.set('ADMIN_SECRET', LEGACY_KEY)
  // Go live in the main process sends its request through that function, with the keys held for the recorded live service only.
  const goLive = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(/await sendWithHeldKeys\(recordedLiveService\(\), liveKeysHeldFor\(endpoint\.baseUrl\), endpoint\.adminSecret, \(secret\) => fetch\(`\$\{endpoint\.baseUrl\}\/sessions`/.test(goLive) && /if \(refused\) throw new LiveServiceError\('failed', LIVE_ACCESS_REMOVED/.test(goLive) && !goLive.includes('isAdminRefusal'))
  // Every other request that carries this computer's key (a share, a Run's results link, pre-work) goes
  // through one helper with the same rules (live-admin-request.ts). State here: the 0.38.2 key works,
  // this computer's own is not registered.
  {
    const { sendAsAdmin, LIVE_ACCESS_REMOVED: removedSentence } = await import('../src/main/live-admin-request.ts')
    assert.equal(removedSentence, (await import('../src/main/live-service-deploy.ts')).LIVE_ACCESS_REMOVED)
    const endpoint = { baseUrl: ADDRESS, adminSecret: own.key, held: { at: service(), keys: pc.keys() } }
    const inits = []
    const init = () => { inits.push(1); return { method: 'POST', headers: { 'content-type': 'application/json' } } }
    from = wire.length
    const sent = await sendAsAdmin(pc.liveFetch, endpoint, `${ADDRESS}/sessions`, init)
    assert.deepEqual([sent.response.status, sent.refused, posts(from), inits.length], [201, false, ['own', '0.38.2'], 2], 'sent once per key, each try with its own request')
    // To any other address the one key given is sent alone, whatever is held: here, a 401 for it is final.
    const carried = []
    const elsewhereFetch = async (input, made) => { carried.push([new URL(String(input)).origin, new Headers(made.headers).get('authorization') === `Bearer ${own.key}`, new Headers(made.headers).get('content-type')]); return new Response('{"error":{"code":"admin_auth_required"}}', { status: 401 }) }
    assert.equal((await sendAsAdmin(elsewhereFetch, endpoint, 'https://elsewhere.example/sessions', init)).refused, true)
    assert.equal((await sendAsAdmin(elsewhereFetch, { ...endpoint, baseUrl: 'http://127.0.0.1:8787', held: { at: service(ACCOUNT, null), keys: pc.keys() } }, 'http://127.0.0.1:8787/shares', init)).refused, true)
    assert.equal((await sendAsAdmin(elsewhereFetch, { baseUrl: ADDRESS, adminSecret: own.key }, `${ADDRESS}/shares`, init)).refused, true)
    assert.deepEqual(carried, [['https://elsewhere.example', true, 'application/json'], ['http://127.0.0.1:8787', true, 'application/json'], [ADDRESS, true, 'application/json']], 'no other key leaves for an address that is not the recorded live service\'s')
    // No answer is thrown on, never turned into a refusal.
    await assert.rejects(sendAsAdmin(async () => { throw new TypeError('fetch failed') }, endpoint, `${ADDRESS}/shares`, init), /fetch failed/)
  }
  // No request in the main process carries a key of this computer past those two functions. Every
  // `Bearer` header written in src/main, by file: an owner's or a presenter's token, the Cloudflare
  // token, the two probes of ONE named key (live-service-key.ts), and the two senders.
  {
    const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []))
    const mainDir = join(repo, 'src/main')
    const bearers = {}
    const naming = []
    for (const file of files(mainDir)) {
      const code = readSource(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
      const name = file.slice(mainDir.length + 1)
      const found = [...code.matchAll(/Bearer \$\{([^}]*)\}/g)].map((match) => match[1])
      if (found.length) bearers[name] = found
      assert.ok(!/Bearer(?! \$\{)/.test(code), `${name}: a Bearer header written some other way than \`Bearer \${…}\``)
      if (/adminSecret/.test(code)) naming.push(name)
    }
    assert.deepEqual(bearers, {
      'cloudflare-connection.ts': ['token'],
      'index.ts': ['secret', 'record.presenterToken', 'record.presenterToken'],
      'live-admin-request.ts': ['key'],
      'live-service-key.ts': ['key.key', 'key.key'],
      'live-session-history.ts': ['record.presenterToken', 'record.presenterToken'],
      'owner-tokens.ts': ['ownerToken'],
      'shared-talk-owner-socket.ts': ['options.ownerToken'],
    }, 'a new Bearer header in src/main: if it carries this computer\'s key it goes through sendAsAdmin (live-admin-request.ts)')
    // The key an endpoint carries is named only where endpoints are made and in the helper: no module that uses one reads it.
    assert.deepEqual(naming.sort(), ['index.ts', 'live-admin-request.ts', 'live-service-deploy.ts', 'live-service-key.ts', 'live-service.ts'])
    // In index.ts it is read twice: by Go live's request, and to hand the helper its endpoint; and the three services get that endpoint.
    assert.deepEqual([(goLive.match(/endpoint\.adminSecret/g) ?? []).length, (goLive.match(/endpoint: \(\) => liveAdminEndpoint\(\),/g) ?? []).length, /endpoint: \(\) => ensureLiveWorker\(\)/.test(goLive)], [2, 3, false])
    assert.ok(/return \{ baseUrl: endpoint\.baseUrl, adminSecret: endpoint\.adminSecret, held: \{ at: recordedLiveService\(\), keys: liveKeysHeldFor\(endpoint\.baseUrl\) \} \}/.test(goLive))
    for (const [file, route] of [['shared-talk-steps.ts', '`${base}/shares`'], ['run-results-share.ts', '`${endpoint.baseUrl}/results`'], ['run-prework.ts', '`${origin}/prework`']]) {
      const code = readSource(join(mainDir, file))
      assert.ok(code.includes(`await sendAsAdmin(deps.fetch, endpoint, ${route}, () => ({`) && /if \(refused\) /.test(code), `${file} sends its keyed request through sendAsAdmin`)
    }
  }
  // One key held: that one, and nothing is asked. None: none.
  const asked = wire.length
  assert.deepEqual([await keyToPresent(io(), service(), [own]), await keyToPresent(io(), service(), []), await acceptedKey(io(), service(), []), wire.length - asked], [own, null, { answer: 'unknown', key: null, others: null }, 0])
  // Its own registered as well: its own is the one used.
  at.worker().values.set(`ADMIN_SECRET_${own.computerId}`, own.key)
  assert.deepEqual([await keyToPresent(io(), service(), pc.keys()), (await pc.setUp()).adminSecret === own.key], [own, true])
  console.log('PASS 13: with a 0.38.2 key that works and an own key that is not registered, the survey says accepted and a use presents the 0.38.2 key; "access was removed" only when every key held is refused by a 401, never on a missing answer or another status; Go live\'s request is sent once more with the other key held before that is said, and to no other live service; shares, results links and pre-work send theirs by the same rules, and no request in src/main carries a key past them')
}

{
  // R2. The share-address action is the only thing that attaches or removes a custom domain, and only
  // the one hostname it names. The account holds the first computer's domain on this Worker, and
  // another Worker's domain.
  const FIRST = 'share.first-mac.example.org'
  const MINE = 'share.second-mac.example.org'
  const TAKEN = 'taken.example.org'
  const at = account({ worker: legacyWorker(), domains: [{ hostname: FIRST }, { hostname: TAKEN, service: 'another-worker' }] })
  at.live.state.build = (worker) => (worker.uploads > 1 ? BUILD : OLDER)
  const start = at.domains()
  // A second computer with no share address: set-up, and a code update. Zero DELETEs, zero domain or route requests of any kind.
  const pc = computer(at)
  assert.equal((await pc.setUp()).ok, true)
  assert.equal(at.worker().uploads, 2, 'the code was updated')
  at.live.state.build = (worker) => (worker.uploads > 2 ? BUILD : OLDER)
  assert.deepEqual([(await pc.setUp()).ok, at.worker().uploads], [true, 3], 'and updated again')
  assert.deepEqual([at.domains(), sentTo(at).filter((line) => /^DELETE |\/domains|\/routes|\/zones/.test(line)), writesTo(at).filter((line) => !/^(PUT \S+\/scripts\/[a-z-]+|POST \S+\/subdomain|PATCH \S+\/secrets-bulk)$/.test(line))], [start, [], []], 'the first computer\'s domain is exactly as it was')

  // config.json's list of the hostnames this computer asked Cloudflare to attach (`liveWorkerShareDomains`).
  const config = {}
  const inUse = () => shareDomainEntries(config).entries.find((entry) => entry.wanted)?.hostname ?? ''
  const listed = () => shareDomainEntries(config).entries.map((entry) => entry.hostname).sort()
  const ports = { authorise: pc.ports.authorise, fetch: pc.ports.fetch, apiBase: pc.ports.apiBase, workerName: NAME, records: { read: () => structuredClone(config), write: (entries) => { config.liveWorkerShareDomains = structuredClone(entries) } }, timeoutMs: 2000 }
  const act = async (run) => { const from = at.fake.requests.length; const result = see(await run()); return { result, sent: at.fake.requests.slice(from).map((request) => `${request.method} ${request.path}${request.search ?? ''}`), bodies: at.fake.requests.slice(from).filter((request) => request.method === 'PUT').map((request) => JSON.parse(request.body.toString())) } }
  const setTo = (wanted) => act(() => changeShareAddress(ports, { wanted }))
  const lookup = (hostname, mine = false) => `GET /accounts/${ACCOUNT}/workers/domains?hostname=${encodeURIComponent(hostname)}${mine ? `&service=${NAME}&environment=production` : ''}`
  const hostnames = () => at.domains().map((domain) => `${domain.hostname}@${domain.service}`).sort()

  // Attach: one lookup of that hostname, one attach of it, every override off. The others stay.
  const attached = await setTo(MINE)
  assert.deepEqual([attached.result, attached.sent, listed(), inUse()], [{ ok: true, changed: true }, [lookup(MINE), `PUT ${script}/domains/records`], [MINE], MINE])
  assert.deepEqual(attached.bodies, [{ override_scope: false, override_existing_origin: false, override_existing_dns_record: false, origins: [{ hostname: MINE }] }], 'no override is ever sent as true')
  assert.deepEqual(hostnames(), [`${FIRST}@${NAME}`, `${MINE}@${NAME}`, `${TAKEN}@another-worker`].sort())
  // Already attached: nothing but the lookup.
  assert.deepEqual([(await setTo(MINE)).sent, (await setTo(MINE)).result], [[lookup(MINE)], { ok: true, changed: false }])
  // Held by another Worker: refused here, nothing sent, nothing listed; and if Cloudflare is asked anyway it refuses, because no override is set.
  const taken = await setTo(TAKEN)
  assert.deepEqual([taken.result, taken.sent, listed(), inUse()], [{ ok: false, error: SHARE_DOMAIN_IN_USE }, [lookup(TAKEN)], [MINE], MINE])
  let lookups = 0
  at.fake.model.answer = (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') && (lookups += 1) === 1 ? { status: 200, body: { success: true, errors: [], messages: [], result: [] } } : null) // the first lookup misses it; the one after the refused attach sees it
  const raced = await setTo(TAKEN)
  at.fake.model.answer = null
  assert.deepEqual([raced.result.error, raced.result.details, raced.bodies.every((body) => !body.override_scope && !body.override_existing_origin && !body.override_existing_dns_record), hostnames().includes(`${TAKEN}@another-worker`)], [SHARE_DOMAIN_IN_USE, 'Attaching the share-link address: Cloudflare answered 409 (error 100117).', true, true], 'Cloudflare refuses instead of taking it from the other Worker')
  // R11: the refused hostname was looked up after the attach, is shown not to be this Worker's, and is not kept on the list.
  assert.deepEqual([raced.sent, listed(), inUse()], [[lookup(TAKEN), `PUT ${script}/domains/records`, lookup(TAKEN)], [MINE], MINE])

  // Clearing the address: only the hostnames on this computer's list are removed.
  const cleared = await setTo(null)
  assert.deepEqual([cleared.result, cleared.sent, listed(), hostnames()], [{ ok: true, changed: true }, [lookup(MINE, true), `DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId(MINE)}`], [], [`${FIRST}@${NAME}`, `${TAKEN}@another-worker`].sort()], 'exactly its one hostname; the first computer\'s stays')
  // With nothing listed, clearing removes nothing and asks nothing, whatever the Worker has attached.
  const nothing = await setTo(null)
  assert.deepEqual([nothing.result, nothing.sent, hostnames().length], [{ ok: true, changed: false }, [], 2])
  // A change of address: the new one attached first, then the listed one removed; never the first computer's.
  await setTo(MINE)
  const moved = await setTo('share.new.example.org')
  assert.deepEqual([moved.result.ok, moved.sent, hostnames()], [true, [lookup('share.new.example.org'), `PUT ${script}/domains/records`, lookup(MINE, true), `DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId(MINE)}`], [`${FIRST}@${NAME}`, 'share.new.example.org@talkweaver-live-sessions', `${TAKEN}@another-worker`].sort()])
  // A listed hostname that another Worker holds now is not this Worker's to remove: nothing is deleted, and it leaves the list.
  config.liveWorkerShareDomains.push({ hostname: TAKEN, wanted: false })
  const foreign = await setTo('share.new.example.org')
  assert.deepEqual([foreign.result, foreign.sent, listed()], [{ ok: true, changed: false }, [lookup('share.new.example.org'), lookup(TAKEN, true)], ['share.new.example.org']])
  // The first computer's hostname is on this Worker and was never listed here: no Save and no clear of this computer asks about it or removes it.
  // Whatever the lookup's reply lists, only an entry with exactly the listed hostname on this Worker is ever removed.
  at.fake.model.answer = (request) => (request.method === 'GET' && request.path.endsWith('/workers/domains') ? { status: 200, body: { success: true, errors: [], messages: [], result: at.domains() } } : null)
  const wide = await setTo(null)
  at.fake.model.answer = null
  assert.deepEqual([wide.sent.filter((line) => line.startsWith('DELETE ')), hostnames(), listed()], [[`DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId('share.new.example.org')}`], [`${FIRST}@${NAME}`, `${TAKEN}@another-worker`].sort(), []])
  assert.ok(!sentTo(at).some((line) => line === `DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId(FIRST)}` || line === `DELETE /accounts/${ACCOUNT}/workers/domains/${workerDomainId(TAKEN)}`), 'no hostname this computer never attached was removed')
  for (const odd of ['Share.Example.org', 'not a host', '../x', 'a.example.org/x']) {
    const refused = await setTo(odd)
    assert.deepEqual([refused.result.ok, refused.sent, listed()], [false, [], []], `not a hostname: ${odd}`)
  }
  // Every attach of this suite: no override flag true.
  const attaches = accounts.flatMap(({ fake }) => fake.requests.filter((request) => request.path.endsWith('/domains/records')).map((request) => JSON.parse(request.body.toString())))
  assert.ok(attaches.length >= 4 && attaches.every((body) => Object.entries(body).every(([field, value]) => !field.startsWith('override') || value === false) && body.origins.length === 1))
  // The main process attaches and removes only through this action, which keeps this computer's list in config.json.
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(!/attachShareDomain|detachShareDomain|domains\/records|workers\/domains\//.test(main) && /changeShareAddress\(shareDomainPorts\(\), \{ wanted \}\)/.test(main) && /read: \(\) => shareDomainRecords\(\)/.test(main) && /write: \(entries\) => writeConfig\(\{ liveWorkerShareDomains: entries, liveWorkerShareDomain: undefined, liveWorkerShareDomainPrevious: undefined \}\)/.test(main), 'the main process hands the action the wanted address and config.json\'s list, and nothing else')
  console.log('PASS 14: a second computer\'s set-up and two code updates send no DELETE and touch no domain or route; the share-address action attaches exactly its one hostname, never with an override, and removes only hostnames on this computer\'s own list')
}

// ── Across every journey ────────────────────────────────────────────────────────────────────────
{
  // R1: no request of any journey names a signing secret; every secrets request names one computer's key and nothing else.
  let secretsRequests = 0
  let requests = 0
  for (const { fake, lives } of accounts) {
    assert.deepEqual(fake.namingSigningSecret(), [], 'no request names SESSION_SIGNING_SECRET, in an address, a header or a body')
    for (const request of fake.requests) {
      requests += 1
      assert.ok(!/\/secrets(?!-bulk$)/.test(request.path) || request.method === 'PATCH', 'the Worker\'s secrets are never listed')
      if (request.method !== 'PATCH') continue
      secretsRequests += 1
      assert.match(request.path, /\/workers\/scripts\/talkweaver-live-sessions\/secrets-bulk$/)
      const names = Object.keys(JSON.parse(request.body.toString()).secrets)
      assert.ok(names.length === 1 && /^ADMIN_SECRET_[0-9a-f]{16}$/.test(names[0]), 'one computer\'s key per request: never ADMIN_SECRET, never a signing secret')
    }
    for (const { live } of lives.values()) for (const request of live.requests) assert.ok(!`${request.route}${request.search}`.includes(SIGNING_NAME))
  }
  assert.ok(secretsRequests >= 18 && requests > 150, `secrets requests were looked at (${secretsRequests} of ${requests})`)
  // The recorder would catch one: a request that names it, in each place.
  const probe = createFakeCloudflare()
  const reach = fakeCloudflareFetch(probe)
  await reach(`http://127.0.0.1:9/client/v4${script}/secrets-bulk`, { method: 'PATCH', body: JSON.stringify({ secrets: { [SIGNING_NAME]: { name: SIGNING_NAME, text: 'x', type: 'secret_text' } } }) })
  await reach(`http://127.0.0.1:9/client/v4${script}/secrets?name=${SIGNING_NAME}`)
  const form = new FormData()
  form.set('metadata', JSON.stringify({ main_module: 'index.js', bindings: [{ name: SIGNING_NAME, type: 'secret_text', text: 'x' }] }))
  form.set('index.js', new File([`env.${SIGNING_NAME}`], 'index.js'))
  await reach(`http://127.0.0.1:9/client/v4${script}`, { method: 'PUT', body: form })
  const clean = new FormData()
  clean.set('metadata', JSON.stringify({ main_module: 'index.js', bindings: [] }))
  clean.set('index.js', new File([`env.${SIGNING_NAME}`], 'index.js'))
  await reach(`http://127.0.0.1:9/client/v4${script}`, { method: 'PUT', body: clean })
  assert.deepEqual(probe.namingSigningSecret(), [`PATCH ${script}/secrets-bulk`, `GET ${script}/secrets`, `PUT ${script}`], 'the recorder sees the name in a body, an address and an upload\'s metadata (the Worker\'s own code is not counted)')
  console.log(`PASS 15: across ${accounts.length} accounts and ${requests} requests, none names a signing secret, none lists the Worker's secrets, and each of the ${secretsRequests} secrets requests names exactly one computer's key`)
}

// ── Nothing secret anywhere, and no timer that holds the app open ───────────────────────────────
{
  // Every key any journey generated, with the made-up ones.
  const generated = [...new Set(profiles.flatMap((held) => [held.slot.text, ...held.slot.writes]).filter((text) => typeof text === 'string' && text.startsWith('{"format":3')).flatMap((text) => [JSON.parse(text).entries].flat().map((entry) => entry?.key).filter((key) => typeof key === 'string')))]
  assert.ok(generated.length >= 20, `generated keys were collected (${generated.length})`)
  const KEYS = [...new Set([...generated, LEGACY_KEY, LEGACY_SIGNING, OTHER_MAC.key])]
  const SECRETS = [TOKEN, ...KEYS]
  const seen = JSON.stringify(observed)
  assert.ok(observed.length > 60, `plenty looked at (${observed.length})`)
  for (const secret of SECRETS) assert.ok(!seen.includes(secret), 'no token or key in any result, error, Details or saved record')
  // config.json of every profile: the address, build and account, and never a key or an id made with one.
  const configs = JSON.stringify(profiles.map((held) => held.config))
  for (const secret of SECRETS) assert.ok(!configs.includes(secret), 'no key in config.json')
  for (const held of profiles) assert.ok(Object.keys(held.config).every((field) => ['liveWorkerBaseUrl', 'liveWorkerVersion', 'liveWorkerAccountId', 'computerId', 'computerName'].includes(field)))
  let liveRequests = 0
  for (const { fake, lives } of accounts) {
    for (const request of fake.requests) {
      for (const secret of SECRETS) assert.ok(!`${request.path}${request.search ?? ''}`.includes(secret), 'no secret in a Cloudflare address')
      const { authorization, ...others } = request.headers ?? {}
      assert.equal(authorization, `Bearer ${TOKEN}`)
      for (const secret of SECRETS) assert.ok(!JSON.stringify(others).includes(secret))
      if (request.method !== 'PATCH') for (const key of KEYS) assert.ok(!request.body.toString('latin1').includes(key), 'a key is only ever in a secrets request\'s body')
    }
    for (const { live } of lives.values()) for (const request of live.requests) {
      liveRequests += 1
      for (const secret of SECRETS) assert.ok(!`${request.route}${request.search}`.includes(secret), 'no secret in a live-service address')
    }
  }
  assert.ok(liveRequests > 150)
  // The 0.38.2 signing value is never sent anywhere, and the 0.38.2 key only ever as a bearer to its own live service.
  for (const request of wire) assert.ok(request.bearer !== LEGACY_SIGNING && request.bearer !== TOKEN)
  // The sources: the key is never written to Settings, logged, or put in an IPC payload.
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(!/writeConfig\(\{[^}]*(adminSecret|signingSecret|\bkey:)/.test(main), 'config.json never holds a key')
  assert.ok(!/signingSecret|SIGNING/.test(main.slice(0, main.indexOf('async function startLocalLiveWorker('))), 'the main process keeps no signing secret')
  for (const file of ['live-service-key.ts', 'live-service-deploy.ts', 'live-service-upload.ts', 'live-service.ts', 'live-service-share-domain.ts']) {
    const source = readSource(join(repo, 'src/main', file))
    assert.ok(!/console\.|appendFile|writeFileSync/.test(source), `${file} logs and writes nothing`)
  }
  const shared = readSource(join(repo, 'src/shared/live-service-status.ts'))
  assert.ok(!/adminSecret|signingSecret|bearer/i.test(shared), 'a row has no field for a key')
  assert.ok(!/delete the (worker|live service)|reset/i.test(shared.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no reset wording in the row\'s words')
  // A pause does not keep the process alive: this one would, for ten minutes, if it were referenced.
  void unreferencedWait(600_000)
  process.stdout.write = write
  const output = printed.join('')
  for (const secret of SECRETS) assert.ok(!output.includes(secret), 'no secret value in this test\'s output')
  console.log(`PASS 16: no token and none of ${KEYS.length} keys in ${observed.length} results, errors and records, in any config.json, nor in any address; the key is in no log, no Settings write and no row; a pending wait does not hold the process open`)
}
console.log(`live service keys: the states S1 to S8, the build comparison, the secrets requests, the stored keys, the sequence and the share-address action against the fake API — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
