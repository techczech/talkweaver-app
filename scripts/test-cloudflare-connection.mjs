// The Cloudflare connection (src/main/cloudflare-connection.ts, src/shared/cloudflare-status.ts;
// spec "Cloudflare set-up in the app", D1, D4, D5, D6, D12 and the two state tables), with no
// network at all: the fake Cloudflare API's model behind a `fetch` of its own, the real secrets
// store over memory, made-up tokens.
// 1. every row of the "Cloudflare connection" table, in the spec's words;
// 2. every state of the "Publishing handouts" row, and what is known about going live;
// 3. the pure check: one account, several, none; a token of an account; each missing permission;
// 4. operations: save, check, choose account, create site, replace, disconnect, and the order they
//    keep when they overlap;
// 5. an existing install: the saved publishing token is the one token, with nothing to do;
// 6. no token and no text of a Cloudflare reply in any status, reply, error or line of output;
// 7. where requests may go, and that no other source of a Cloudflare token is left in the app.
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCOUNTS_CAP, ACCOUNTS_PER_PAGE, CHECK_FAILED_ERROR, DEPLOY_NOT_CHECKED_ERROR, DEPLOY_NOT_CONNECTED_ERROR, DEPLOY_SUPERSEDED_ERROR, LIVE_NOT_REFUSED_DETAIL,
  SETTINGS_CHANGED_ERROR, SETTINGS_NOT_SAVED_NOTICE, SITE_FOUND_DETAIL, TOO_MANY_ACCOUNTS_NOTICE,
  CLOUDFLARE_API_BASE, CREATE_FAILED_NOTICE, NOT_LISTED_ERROR, NOT_NOW_ERROR, OPEN_CHECK_INTERVAL_MS, SITE_NAME_NOTICE, SUPERSEDED_ERROR,
  TOKEN_SHAPE_ERROR, UNREADABLE_TOKEN_NOTICE, ask, cloudflareApiBase, connectionCheck, createCloudflareConnection, loopbackApiBase, resolveAccount,
  standInApiBase, validCloudflareToken, validProjectName, shareLinkRow, siteAddress, zoneOfHost,
} from '../src/main/cloudflare-connection.ts'
import {
  DEFAULT_PAGES_PROJECT, HOW_TO_MAKE_A_TOKEN, LIVE_NO_PERMISSION, PAGES_PERMISSION, STORAGE_UNAVAILABLE_READ, STORAGE_UNAVAILABLE_SAVE, TOKEN_PERMISSIONS,
  WORKERS_PERMISSION, ROUTES_PERMISSION, clockTime, connectionActions, connectionLabel, customDomainLabel, publishingLabel, shareLinkRowDetail, shareLinkRowEdge,
  publishingRowDetail, publishingRowLink, suggestedShareHost, unknownPublishing,
} from '../src/shared/cloudflare-status.ts'
import { secretsFailureMessage } from '../src/main/secrets-store.ts'
import { LIVE_SETUP_FAILED, deployLiveService } from '../src/main/live-service-deploy.ts'
import { INSTALLATION_INCOMPLETE } from '../src/main/live-service-upload.ts'
import { workerDistFiles } from './lib/worker-dist.mjs'
import { publishFailureToast } from '../src/renderer/src/lib/publish-failure-toast.ts'
import { REPLY_TEXT_MARK, WORKERS_SUBDOMAIN, createFakeCloudflare, fakeCloudflareFetch } from './lib/cloudflare-api-stub.mjs'
import { memorySecrets } from './lib/memory-secrets.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'cloudflare', name, '0123456789abcdef'].join('-')
const TOKEN = fake('one')
const OTHER = fake('two')
const PAGES_ONLY = fake('pagesonly')
const READ_ONLY = fake('readonly')
const NO_PAGES = fake('nopages')
const BOTH_ACCOUNTS = fake('both')
const EXPIRED = fake('expired')
const NO_ACCOUNT = fake('noaccount')
const UNKNOWN = fake('unknown')
const ALL_TOKENS = [TOKEN, OTHER, PAGES_ONLY, READ_ONLY, NO_PAGES, BOTH_ACCOUNTS, EXPIRED, NO_ACCOUNT, UNKNOWN]
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const GRACE = { id: 'acc-grace-0002', name: 'Grace Hopper' }
const NINE_FOURTEEN = () => '09:14'

/** Everything a window, a log or a caller could see: searched at the end for tokens and reply text. */
const observed = []
const printed = []
for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
  const real = console[method].bind(console)
  console[method] = (...args) => { printed.push(args.map(String).join(' ')); real(...args) }
}

function world(overrides = {}) {
  const secrets = memorySecrets()
  const api = createFakeCloudflare({
    sites: [],
    accounts: [ADA, GRACE],
    accountSites: { [ADA.id]: ['talks'] },
    tokens: {
      [TOKEN]: { accounts: [ADA.id] },
      [OTHER]: { accounts: [GRACE.id] },
      [PAGES_ONLY]: { accounts: [ADA.id], workers: false },
      [READ_ONLY]: { accounts: [ADA.id], pages: 'read' },
      [NO_PAGES]: { accounts: [ADA.id], pages: false },
      [BOTH_ACCOUNTS]: { accounts: [ADA.id, GRACE.id] },
      [EXPIRED]: { accounts: [ADA.id], status: 'expired' },
      [NO_ACCOUNT]: { accounts: [] },
    },
    ...overrides.api,
  })
  const config = { accountId: '', project: '', baseUrl: '', productionBranch: 'main', ...overrides.config }
  const writes = []
  const port = { failReads: false, failWrites: false }
  const emitted = []
  const clock = { now: new Date(2026, 9, 7, 9, 14, 0).getTime() }
  if (overrides.stored) secrets.store.write('cloudflare-token', overrides.stored)
  const slotWritesBefore = secrets.files.knobs.writes
  const connection = createCloudflareConnection({
    secrets: secrets.store,
    settings: {
      read: () => { if (port.failReads) throw new Error(`EIO ${TOKEN}`); return { ...config } },
      write: (patch) => { if (port.failWrites) throw new Error(`ENOSPC ${TOKEN}`); writes.push(patch); Object.assign(config, patch) },
    },
    fetch: fakeCloudflareFetch(api, { honourAbort: overrides.honourAbort }),
    apiBase: () => CLOUDFLARE_API_BASE,
    now: () => clock.now,
    timeoutMs: overrides.timeoutMs ?? 150,
    onChange: (status) => { emitted.push(status); observed.push(status) },
  })
  const tokensSent = () => [...new Set(api.requests.map((request) => request.authorization.replace(/^Bearer /, '')))]
  return { secrets, api, config, writes, port, emitted, clock, connection, tokensSent, slotWrites: () => secrets.files.knobs.writes - slotWritesBefore }
}
const see = (reply) => { observed.push(reply); return reply }
const gate = () => { let open; const wait = new Promise((resolve) => { open = resolve }); return { wait, open } }
const soon = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what, condition, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (condition()) return; await soon(2) }
  assert.fail(`timed out waiting for: ${what}`)
}
/** Fails rather than hangs when `promise` does not settle in `ms`. */
const within = (promise, ms, what) => Promise.race([promise, soon(ms).then(() => assert.fail(`${what} did not finish within ${ms} ms`))])
/** Save a token and wait for the check that follows it. */
async function connect(t, token) {
  const saved = see(await t.connection.saveToken(token))
  await t.connection.idle()
  return saved
}
const label = (t) => connectionLabel(t.connection.status().connection, NINE_FOURTEEN)

// ── 1. The "Cloudflare connection" table ────────────────────────────────────────────────────────
{
  // No token.
  const t = world()
  assert.equal(label(t), 'Not connected')
  assert.deepEqual(connectionActions(t.connection.status().connection), ['paste-token', 'how-to'])
  assert.equal((await t.connection.check()).status.connection.state, 'no-token', 'a check with no token asks nothing')
  assert.equal(t.api.requests.length, 0)

  // Token saved, not yet checked.
  const hold = gate()
  t.api.model.delay = () => hold.wait
  const saved = see(await t.connection.saveToken(`  ${TOKEN}\n`))
  assert.equal(saved.ok, true, 'saving answers as soon as the token is stored: it does not wait for Cloudflare')
  assert.equal(t.secrets.store.read('cloudflare-token'), TOKEN, 'the token is stored without the spaces around it')
  await until('the check to start', () => t.api.requests.length >= 2)
  assert.equal(label(t), 'Checking…')
  assert.equal(t.connection.status().busy, true)
  assert.deepEqual(connectionActions(t.connection.status().connection), [], 'nothing is offered while checking')

  // Connected, one account.
  hold.open()
  await t.connection.idle()
  assert.equal(label(t), 'Connected · Ada Lovelace')
  assert.equal(t.connection.status().busy, false)
  assert.deepEqual(connectionActions(t.connection.status().connection), ['check-again', 'replace-token', 'disconnect'])
  assert.deepEqual(t.writes, [{ accountId: ADA.id }], 'the account was found, not typed (D4)')
  console.log('PASS 1.1: Not connected → Checking… → Connected · <account name>')
}
{
  // Connected, several accounts.
  const t = world()
  await connect(t, BOTH_ACCOUNTS)
  const status = t.connection.status()
  assert.equal(label(t), 'Choose an account')
  assert.deepEqual(status.connection.accounts, [ADA, GRACE])
  assert.deepEqual(connectionActions(status.connection), ['choose-account'])
  assert.equal(publishingLabel(status.publishing), '—', 'no row state before an account is chosen')
  assert.deepEqual(t.writes, [], 'no account is written before one is chosen')
  assert.ok(!t.api.reached().some((line) => line.includes('/pages/')), 'and nothing is asked about a site')

  const wrong = see(await t.connection.chooseAccount('acc-someone-else'))
  assert.deepEqual([wrong.ok, wrong.error], [false, NOT_LISTED_ERROR], 'an account the token did not list is refused')
  assert.deepEqual(t.writes, [])
  const chosen = see(await t.connection.chooseAccount(GRACE.id))
  assert.equal(chosen.ok, true)
  assert.equal(connectionLabel(chosen.status.connection), 'Connected · Grace Hopper')
  assert.equal(t.config.accountId, GRACE.id)
  assert.equal(publishingLabel(chosen.status.publishing), 'No site yet — Create talkweaver-handouts', 'the row is about the chosen account')
  console.log('PASS 1.2: several accounts → Choose an account → the picker\'s choice')
}
{
  // Token rejected or expired.
  for (const [token, why] of [[UNKNOWN, 'a token Cloudflare does not know'], [EXPIRED, 'an expired token']]) {
    const t = world()
    await connect(t, token)
    assert.equal(label(t), 'Cloudflare did not accept this token', why)
    assert.deepEqual(connectionActions(t.connection.status().connection), ['replace-token'])
    assert.equal(publishingLabel(t.connection.status().publishing), '—')
    assert.deepEqual(t.writes, [])
  }
  // A saved token that could not travel in a header is never sent.
  const t = world({ stored: 'broken token\r\nx-injected: 1' })
  see(await t.connection.check())
  assert.equal(label(t), 'Cloudflare did not accept this token')
  assert.equal(t.api.requests.length, 0, 'nothing was sent')
  console.log('PASS 1.3: rejected, expired and unsendable tokens → Cloudflare did not accept this token')
}
{
  // Cannot reach Cloudflare: never checked, then with a last check and the last known states greyed.
  const t = world({ timeoutMs: 60, config: { project: 'talks' } })
  t.api.model.hang = () => true
  const started = Date.now()
  await within(connect(t, TOKEN), 1500, 'a check that never gets an answer')
  assert.ok(Date.now() - started < 1000, 'the check gives up at its time limit even though the request never settles and ignores being aborted')
  assert.equal(label(t), 'Could not check (offline?)')
  assert.deepEqual(connectionActions(t.connection.status().connection), ['check-again'])
  assert.equal(t.api.requests.length, 2, 'after two unanswered questions nothing more is asked')

  t.api.model.hang = null
  see(await t.connection.check())
  assert.equal(label(t), 'Connected · Ada Lovelace', 'Check again works after a check that never returned')
  assert.equal(t.connection.status().publishing.state, 'ready')
  const checkedAt = t.connection.status().checkedAt
  t.clock.now += 5 * 60_000
  t.api.model.hang = () => true
  const offline = see(await within(t.connection.check(), 1500, 'the second unanswered check'))
  assert.equal(label(t), 'Could not check (offline?) · last checked 09:14')
  assert.equal(offline.status.connection.lastCheckedAt, checkedAt)
  assert.deepEqual([offline.status.publishing.state, offline.status.publishing.stale], ['ready', true], 'the last known state is kept, greyed')
  assert.deepEqual([offline.status.liveService.state, offline.status.liveService.stale], ['not-refused', true])
  assert.equal(offline.status.checkedAt, checkedAt, '"last checked" is the last check that got an answer')
  assert.equal(clockTime(new Date(2026, 9, 7, 9, 4).getTime()), '09:04')

  // A server error, a reply that is not JSON and a failure to send are all "could not check".
  for (const answer of [() => ({ status: 503, body: 'upstream unavailable' }), () => ({ status: 200, body: '<html>captive portal</html>' }), () => ({ throws: new Error(`ECONNREFUSED Authorization: Bearer ${TOKEN}`) })]) {
    const down = world()
    down.api.model.answer = answer
    await connect(down, TOKEN)
    assert.equal(label(down), 'Could not check (offline?)')
  }
  console.log('PASS 1.4: no answer in time, a server error, no connection → Could not check (offline?) · last checked 09:14')
}
{
  // Secrets store unavailable.
  const t = world()
  t.secrets.cipher.state.available = false
  assert.equal(label(t), "This computer's secure storage is unavailable, so the token cannot be saved")
  assert.deepEqual(connectionActions(t.connection.status().connection), [])
  const refused = see(await t.connection.saveToken(TOKEN))
  assert.deepEqual([refused.ok, refused.error], [false, secretsFailureMessage('unavailable', 'cloudflare-token')])
  assert.equal(STORAGE_UNAVAILABLE_SAVE, secretsFailureMessage('unavailable', 'cloudflare-token'), 'the window and the secrets module say the same sentence')
  assert.equal(STORAGE_UNAVAILABLE_READ, secretsFailureMessage('unavailable', 'cloudflare-token', 'read'))
  assert.equal(t.secrets.files.blobs.size, 0, 'nothing was written')
  await t.connection.idle()
  assert.equal(t.api.requests.length, 0, 'and nothing sent')
  assert.equal(label(t), "This computer's secure storage is unavailable, so the token cannot be saved")

  // A saved token that cannot be read while storage is unavailable.
  const locked = world({ stored: TOKEN })
  locked.secrets.cipher.state.available = false
  see(await locked.connection.check())
  assert.equal(label(locked), "This computer's secure storage is unavailable, so the token cannot be read")
  // A slot that is there but was not written on this computer: as good as empty, and says so.
  const copied = world({ stored: TOKEN })
  copied.secrets.cipher.state.locked = true
  const unreadable = see(await copied.connection.check())
  assert.deepEqual([connectionLabel(unreadable.status.connection), unreadable.status.notice], ['Not connected', UNREADABLE_TOKEN_NOTICE])
  copied.secrets.cipher.state.locked = false
  await connect(copied, OTHER)
  assert.equal(label(copied), 'Connected · Grace Hopper', 'pasting a token replaces the unreadable one')
  console.log('PASS 1.5: secure storage unavailable → the spec\'s sentence, nothing written, nothing sent')
}

// ── 2. The "Publishing handouts" row ────────────────────────────────────────────────────────────
{
  // Ready, and what is known about going live.
  const t = world({ config: { project: 'talks' } })
  await connect(t, TOKEN)
  let status = t.connection.status()
  assert.equal(publishingLabel(status.publishing), 'Ready')
  assert.equal(customDomainLabel(status.publishing.customDomain), 'Custom domain: none')
  assert.equal(status.liveService.state, 'not-refused', 'a read of the account\'s Workers was not refused: no more is claimed')
  assert.equal(status.details, `${SITE_FOUND_DETAIL} · ${LIVE_NOT_REFUSED_DETAIL}`, 'Details says what Ready does and does not mean')
  assert.equal(SITE_FOUND_DETAIL, 'Site: found. The permission to publish is proven by the first publish.')
  // A token that can only read is in the same state: the check does not write to find out more.
  const reader = world({ config: { project: 'talks' } })
  await connect(reader, READ_ONLY)
  assert.deepEqual([publishingLabel(reader.connection.status().publishing), reader.connection.status().details], ['Ready', `${SITE_FOUND_DETAIL} · ${LIVE_NOT_REFUSED_DETAIL}`])
  assert.ok(reader.api.requests.every((request) => request.method === 'GET'), 'a check only reads')

  // The token cannot publish pages: the missing permission is named.
  const none = world({ config: { project: 'talks' } })
  await connect(none, NO_PAGES)
  status = none.connection.status()
  assert.equal(connectionLabel(status.connection), 'Connected · Ada Lovelace')
  assert.equal(publishingLabel(status.publishing), 'The token cannot publish pages')
  assert.equal(status.publishing.permission, 'Account · Cloudflare Pages · Edit')
  assert.equal(status.details, `Site: HTTP 403 (Cloudflare error 10000) · ${LIVE_NOT_REFUSED_DETAIL}`, 'Details: the request, the status and Cloudflare\'s error number')

  // The token cannot run the live service: publishing is still Ready.
  const pages = world({ config: { project: 'talks' } })
  await connect(pages, PAGES_ONLY)
  status = pages.connection.status()
  assert.equal(publishingLabel(status.publishing), 'Ready', 'a token without the live-service permission still publishes handouts')
  assert.deepEqual([status.liveService.state, status.liveService.permission], ['no-permission', 'Account · Workers Scripts · Edit'])
  assert.deepEqual(await pages.connection.authoriseLiveDeploy(), { ok: false, error: `${LIVE_NO_PERMISSION}. Add the permission ${WORKERS_PERMISSION} to the token in Settings → Cloudflare.` })
  assert.equal((await t.connection.authoriseLiveDeploy()).ok, true)

  // A valid token that reaches no account at all.
  const nowhere = world()
  await connect(nowhere, NO_ACCOUNT)
  status = nowhere.connection.status()
  assert.deepEqual([connectionLabel(status.connection), publishingLabel(status.publishing), status.publishing.permission], ['Connected', 'The token cannot publish pages', PAGES_PERMISSION])
  console.log('PASS 2.1: Ready · The token cannot publish pages (permission named) · going live needs its own permission')
}
{
  // No site yet → Creating… → Ready.
  const t = world()
  await connect(t, TOKEN)
  assert.equal(publishingLabel(t.connection.status().publishing), `No site yet — Create ${DEFAULT_PAGES_PROJECT}`)
  assert.equal(DEFAULT_PAGES_PROJECT, 'talkweaver-handouts')
  assert.equal(t.config.project, '', 'no site name is written before the site exists')
  const hold = gate()
  t.api.model.delay = (request) => (request.method === 'POST' ? hold.wait : undefined)
  const creating = t.connection.createSite()
  await until('the create request', () => t.api.reached().includes(`POST /accounts/${ADA.id}/pages/projects`))
  assert.equal(publishingLabel(t.connection.status().publishing), 'Creating…')
  const again = t.connection.createSite()
  hold.open()
  const [first, second] = [see(await creating), see(await again)]
  assert.equal(first.ok, true)
  assert.equal(publishingLabel(first.status.publishing), 'Ready', 'the row turns Ready')
  assert.equal(t.config.project, 'talkweaver-handouts', 'and publishing now has a site to publish to')
  assert.equal(t.api.reached().filter((line) => line.startsWith('POST ')).length, 1, 'asked twice, the site is made once')
  assert.deepEqual([second.ok, second.status.publishing.state], [true, 'ready'])
  const sent = JSON.parse(t.api.requests.find((request) => request.method === 'POST').body.toString())
  assert.deepEqual(sent, { name: 'talkweaver-handouts', production_branch: 'main' })
  const nothing = see(await t.connection.createSite())
  assert.equal(nothing.ok, true)
  assert.equal(t.api.reached().filter((line) => line.startsWith('POST ')).length, 1, 'and never again once it is there')
  console.log('PASS 2.2: No site yet — Create talkweaver-handouts → Creating… → Ready; asked twice, made once')
}
{
  // Create site when it cannot be done.
  const t = world()
  const early = see(await t.connection.createSite())
  assert.deepEqual([early.ok, early.error], [false, NOT_NOW_ERROR], 'refused with no token')
  await connect(t, READ_ONLY)
  assert.equal(t.connection.status().publishing.state, 'no-site', 'a token that can only read sees there is no site')
  const denied = see(await t.connection.createSite())
  assert.deepEqual([publishingLabel(denied.status.publishing), denied.status.publishing.permission], ['The token cannot publish pages', PAGES_PERMISSION], 'making the site shows the token cannot edit')
  assert.match(denied.status.details, /^Create site: HTTP 403 \(Cloudflare error 10000\)$/)
  assert.equal(t.config.project, '')

  // Cloudflare refuses the name; the server fails.
  const odd = world({ config: { project: 'My_Site' } })
  await connect(odd, TOKEN)
  const refused = see(await odd.connection.createSite())
  assert.deepEqual([refused.ok, refused.error, refused.status.notice, refused.status.publishing.state], [false, CREATE_FAILED_NOTICE, CREATE_FAILED_NOTICE, 'no-site'])
  assert.match(refused.status.details, /^Create site: HTTP 400 \(Cloudflare error 8000015\)$/)
  const bad = world({ config: { project: '../zones' } })
  await connect(bad, TOKEN)
  assert.deepEqual([bad.connection.status().publishing.state, bad.connection.status().notice], ['unknown', SITE_NAME_NOTICE], 'a name that is not one path segment is never put in an address')
  assert.ok(!bad.api.reached().some((line) => line.includes('zones') || line.includes('/pages/')))
  assert.equal(validProjectName('talkweaver-handouts'), true)
  for (const name of ['', '..', 'a/b', 'a b', '-a', 'a?x', 'a#b', 'a%2f', 'a'.repeat(64)]) assert.equal(validProjectName(name), false, name)
  console.log('PASS 2.3: a site that cannot be made: the permission is named, or a fixed sentence with numbers in Details')
}
{
  // Custom domain: none / set / not reachable.
  const withDomain = (domains, baseUrl) => {
    const t = world({ config: { project: 'talks', baseUrl } })
    t.api.model.sites.get(ADA.id).get('talks').domains = domains
    return t
  }
  const set = withDomain([{ name: 'handouts.example.test', status: 'active' }], 'https://handouts.example.test/')
  await connect(set, TOKEN)
  assert.equal(customDomainLabel(set.connection.status().publishing.customDomain), 'Custom domain: set')
  assert.ok(set.api.reached().includes(`GET /accounts/${ADA.id}/pages/projects/talks/domains`))
  for (const [domains, why] of [[[], 'not attached to the site'], [[{ name: 'handouts.example.test', status: 'pending' }], 'attached but not active'], [[{ name: 'other.example.test', status: 'active' }], 'another domain']]) {
    const t = withDomain(domains, 'handouts.example.test')
    await connect(t, TOKEN)
    assert.equal(customDomainLabel(t.connection.status().publishing.customDomain), 'Custom domain: not reachable', why)
    assert.equal(t.connection.status().publishing.state, 'ready', 'the site itself is still ready')
  }
  const own = withDomain([], 'https://talks.pages.dev')
  await connect(own, TOKEN)
  assert.equal(own.connection.status().publishing.customDomain, 'set', 'the site\'s own pages.dev address needs no attaching')
  assert.equal(own.connection.status().publishing.address, 'talks.pages.dev')
  assert.ok(own.api.reached().includes(`GET /accounts/${ADA.id}/pages/projects/talks/domains`), 'the site\'s domains are always asked: the row shows the handout address')
  console.log('PASS 2.4: Custom domain: none / set / not reachable')
}
{
  // The handout web address on the row ("Site my-handouts · handouts.example", a link).
  const withDomain = (domains, baseUrl = '') => {
    const t = world({ config: { project: 'talks', baseUrl } })
    t.api.model.sites.get(ADA.id).get('talks').domains = domains
    return t
  }
  const detailOf = (t) => publishingRowDetail(t.connection.status().publishing)
  // A custom domain active on the site, none in Settings: it is the address.
  const custom = withDomain([{ name: 'handouts.example.test', status: 'active' }])
  await connect(custom, TOKEN)
  assert.equal(detailOf(custom), 'Site talks · handouts.example.test')
  assert.deepEqual(publishingRowLink(custom.connection.status().publishing), { label: 'handouts.example.test', href: 'https://handouts.example.test/' }, 'a link that opens it')
  assert.equal(custom.connection.status().publishing.customDomain, 'set')
  // Several: the one in Settings when it is active, else the first active one Cloudflare lists.
  const several = [{ name: 'old.example.test', status: 'pending' }, { name: 'first.example.test', status: 'active' }, { name: 'second.example.test', status: 'active' }]
  const first = withDomain(several)
  await connect(first, TOKEN)
  assert.equal(detailOf(first), 'Site talks · first.example.test', 'the first active one; a pending one is skipped')
  const chosen = withDomain(several, 'https://second.example.test')
  await connect(chosen, TOKEN)
  assert.equal(detailOf(chosen), 'Site talks · second.example.test', 'the one in Settings, when it is active')
  // None active: the site's own pages.dev address.
  const none = withDomain([{ name: 'old.example.test', status: 'pending' }])
  await connect(none, TOKEN)
  assert.equal(detailOf(none), 'Site talks · talks.pages.dev')
  assert.deepEqual(publishingRowLink(none.connection.status().publishing), { label: 'talks.pages.dev', href: 'https://talks.pages.dev/' })
  // The custom domain in Settings is not active on the site: the spec's words, not an address.
  const unreachable = withDomain([{ name: 'first.example.test', status: 'active' }], 'handouts.example.test')
  await connect(unreachable, TOKEN)
  assert.equal(detailOf(unreachable), 'Site talks · Custom domain: not reachable')
  assert.equal(publishingRowLink(unreachable.connection.status().publishing), null)
  // The pure choice, and an answer that did not come.
  const okDomains = (list) => ({ kind: 'ok', http: 200, codes: [], result: list })
  const found = { kind: 'ok', http: 200, codes: [], result: { found: true, subdomain: 'talks.pages.dev' } }
  assert.equal(siteAddress(okDomains([{ name: 'a.test', active: true }]), found, ''), 'a.test')
  assert.equal(siteAddress(okDomains([{ name: 'talks.pages.dev', active: true }]), found, ''), 'talks.pages.dev', 'a pages.dev entry is not a custom domain')
  assert.equal(siteAddress({ kind: 'unreachable', http: null, codes: [], result: null }, found, ''), null, 'domains not answered: not guessed')
  assert.equal(publishingRowLink(unknownPublishing('talks')), null)
  console.log('PASS 2.5: the row shows the handout address: the active custom domain (Settings\' first), else pages.dev, as a link')
}
{
  // The Share-link domain row with no address set: a suggestion from the handout address, text only (Dominik, 10 Oct).
  assert.deepEqual(suggestedShareHost('handouts.fyi'), { host: 'share.handouts.fyi', zone: 'handouts.fyi' })
  assert.deepEqual(suggestedShareHost('talks.example.test'), { host: 'share.talks.example.test', zone: 'talks.example.test' })
  for (const address of [null, '', 'talks.pages.dev', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}`]) assert.equal(suggestedShareHost(address), null, String(address))
  const t = world({ config: { project: 'talks' } })
  t.api.model.sites.get(ADA.id).get('talks').domains = [{ name: 'handouts.example.test', status: 'active' }]
  await connect(t, TOKEN)
  let row = t.connection.status().shareLink
  assert.deepEqual([row.state, row.suggested], ['none', { host: 'share.handouts.example.test', zone: 'handouts.example.test' }])
  assert.equal(shareLinkRowDetail(row), `Share for comments links can use share.handouts.example.test, on your handout domain handouts.example.test. The token needs the permission ${ROUTES_PERMISSION}`)
  assert.deepEqual(shareLinkRowEdge(row), { kind: 'action', label: 'Use share.handouts.example.test' }, 'the row offers its one button')
  // Cloudflare does not answer: the suggestion stays, greyed, and is not offered as a button.
  t.api.model.hang = () => true
  await t.connection.check()
  t.api.model.hang = null
  row = t.connection.status().shareLink
  assert.deepEqual([row.state, row.stale, row.suggested?.host], ['none', true, 'share.handouts.example.test'])
  assert.deepEqual(shareLinkRowEdge(row), { kind: 'state', text: 'None', tone: 'quiet' })
  assert.ok(t.api.requests.every((request) => request.method === 'GET' && !request.path.startsWith('/zones') && !request.path.endsWith('/workers/domains')), 'nothing is read or attached for a suggestion')
  assert.equal(t.config.shareDomain, undefined, 'and nothing is written to Settings')
  // The pages.dev address only: no suggestion, the words as before.
  const plain = world({ config: { project: 'talks' } })
  await connect(plain, TOKEN)
  row = plain.connection.status().shareLink
  assert.deepEqual([row.state, row.suggested, shareLinkRowDetail(row), shareLinkRowEdge(row).kind], ['none', null, 'No address set in Settings', 'state'])
  // An address typed in Settings: no suggestion.
  const typed = world({ config: { project: 'talks', shareDomain: 'drafts.handouts.example.test' } })
  typed.api.model.sites.get(ADA.id).get('talks').domains = [{ name: 'handouts.example.test', status: 'active' }]
  await connect(typed, TOKEN)
  assert.equal(typed.connection.status().shareLink.suggested, null)
  console.log('PASS 2.6: no share-link address set: share.<handout custom domain> suggested with "Use …" and the permission; nothing read, set or attached before the press; greyed offline')
}

// ── 3. The pure check ───────────────────────────────────────────────────────────────────────────
{
  const answer = (kind, result = null, http = kind === 'ok' ? 200 : kind === 'denied' ? 403 : kind === 'missing' ? 404 : null, codes = []) => ({ kind, http, codes, result })
  const active = answer('ok', { status: 'active' })
  const one = answer('ok', [ADA])
  const settings = { accountId: '', project: '', baseUrl: '' }
  const check = (answers, more = {}) => connectionCheck({ answers, settings, previous: null, now: 1000, ...more })

  // Which account (D4).
  assert.deepEqual(resolveAccount(one, ''), { kind: 'one', account: ADA })
  assert.deepEqual(resolveAccount(answer('ok', [ADA, GRACE]), ''), { kind: 'several', accounts: [ADA, GRACE] })
  assert.deepEqual(resolveAccount(answer('ok', [ADA, GRACE]), GRACE.id), { kind: 'one', account: GRACE }, 'the one Settings already names')
  assert.deepEqual(resolveAccount(one, 'acc-from-an-earlier-token'), { kind: 'one', account: ADA }, 'an id the token does not list is not used')
  assert.deepEqual(resolveAccount(answer('ok', []), 'typed-by-hand'), { kind: 'one', account: { id: 'typed-by-hand', name: 'typed-by-hand' } }, 'the advanced override: an id typed when the token lists none')
  assert.deepEqual(resolveAccount(answer('ok', []), ''), { kind: 'none' })
  assert.deepEqual(resolveAccount(answer('ok', []), '../../zones'), { kind: 'none' }, 'a typed id that is not an id is not used')

  // Every combination of the two first answers that decides the connection.
  const rows = [
    [active, one, 'connected'],
    [answer('ok', { status: 'expired' }), one, 'rejected'],
    [answer('ok', { status: 'disabled' }), one, 'rejected'],
    [answer('denied'), answer('denied'), 'rejected'],
    [answer('refused', null, 400, [6003]), answer('refused', null, 400, [6003]), 'rejected'],
    [answer('denied', null, 401, [1000]), one, 'connected'], // a token that belongs to an account
    [answer('denied', null, 401, [1000]), answer('ok', []), 'rejected'],
    [answer('unreachable'), one, 'connected'],
    [answer('unreachable'), answer('denied'), 'rejected'],
    [answer('unreachable'), answer('unreachable'), 'unreachable'],
    [answer('denied'), answer('unreachable'), 'unreachable'], // not enough to call it rejected
    [active, answer('unreachable'), 'unreachable'], // valid, but no account to use
    [active, answer('ok', [ADA, GRACE]), 'choose-account'],
    [active, answer('ok', []), 'connected'],
  ]
  for (const [verify, accounts, expected] of rows) {
    assert.equal(check({ verify, accounts }).connection.state, expected, `${verify.kind}/${verify.result?.status ?? verify.http} + ${accounts.kind}/${accounts.result?.length ?? accounts.http} → ${expected}`)
  }
  const typed = connectionCheck({ answers: { verify: active, accounts: answer('unreachable'), project: answer('ok', { found: true }) }, settings: { ...settings, accountId: ADA.id }, previous: null, now: 1 })
  assert.deepEqual(typed.connection, { state: 'connected', account: { id: ADA.id, name: ADA.id } }, 'with the id in Settings the check does not need the list')

  // Each answer about the site and about the live service.
  const site = (project, workers) => check({ verify: active, accounts: one, project, workers })
  assert.deepEqual([site(answer('ok', { found: true })).publishing.state, site(answer('missing')).publishing.state, site(answer('denied')).publishing.state, site(answer('unreachable')).publishing.state], ['ready', 'no-site', 'no-permission', 'unknown'])
  assert.deepEqual([site(undefined, answer('ok', true)).liveService.state, site(undefined, answer('denied')).liveService.state, site(undefined, answer('unreachable')).liveService.state], ['not-refused', 'no-permission', 'unknown'])
  assert.equal(site(answer('denied', null, 403, [10000]), answer('denied', null, 403, [10000])).details, 'Site: HTTP 403 (Cloudflare error 10000) · Live service permission: HTTP 403 (Cloudflare error 10000)')
  const ready = site(answer('ok', { found: true }), answer('ok', true))
  assert.deepEqual([ready.checkedAt, ready.busy, ready.notice, ready.details], [1000, false, null, `${SITE_FOUND_DETAIL} · ${LIVE_NOT_REFUSED_DETAIL}`])
  // One question unanswered while the rest answered: that row keeps its last known state, greyed.
  const partial = connectionCheck({ answers: { verify: active, accounts: one, project: answer('unreachable'), workers: answer('ok', true) }, settings, previous: ready, now: 2000 })
  assert.deepEqual([partial.connection.state, partial.publishing.state, partial.publishing.stale, partial.liveService.stale], ['connected', 'ready', true, false])
  console.log(`PASS 3: the pure check — the account rule and ${rows.length} combinations of answers, each site and permission answer`)
}

// ── 4. Operations and their order ───────────────────────────────────────────────────────────────
{
  // A token is checked where it comes in.
  const t = world({ stored: TOKEN, config: { accountId: ADA.id, project: 'talks' } })
  await t.connection.check()
  for (const bad of ['', '   ', 'short', `${TOKEN} with spaces`, `${TOKEN}\r\nx-injected: 1`, `${TOKEN}é`, 'x'.repeat(513), null, undefined, 42, { toString: () => TOKEN }]) {
    const refused = see(await t.connection.saveToken(bad))
    assert.deepEqual([refused.ok, refused.error], [false, TOKEN_SHAPE_ERROR], `refused: ${JSON.stringify(bad)?.slice(0, 30)}`)
  }
  assert.equal(t.slotWrites(), 0, 'a refused token replaces nothing')
  assert.equal(t.secrets.store.read('cloudflare-token'), TOKEN)
  assert.equal(label(t), 'Connected · Ada Lovelace', 'and the connection is as it was')
  assert.equal(validCloudflareToken(TOKEN), true)
  console.log('PASS 4.1: a token that could not travel in a header is refused where it comes in; the saved one stays')
}
{
  // Two "Check again": one set of questions.
  const t = world({ stored: TOKEN, config: { project: 'talks' } })
  const first = t.connection.check()
  const second = t.connection.check()
  assert.equal(first, second, 'a check asked for while one is under way joins it')
  await first
  assert.deepEqual(t.api.reached().sort(), ['GET /accounts', `GET /accounts/${ADA.id}/pages/projects/talks`, `GET /accounts/${ADA.id}/pages/projects/talks/domains`, `GET /accounts/${ADA.id}/workers/scripts`, 'GET /user/tokens/verify'], 'each question once')
  assert.ok(t.api.requests.every((request) => request.redirect === 'error'), 'a redirect is never followed')
  await t.connection.check()
  assert.equal(t.api.requests.length, 10, 'a check asked for afterwards is a new one')

  // Opening Settings → Cloudflare: at most once a minute (D6).
  const opened = world({ stored: TOKEN, config: { project: 'talks' } })
  await opened.connection.check('opened')
  assert.equal(opened.api.requests.length, 5, 'the first opening checks')
  opened.clock.now += OPEN_CHECK_INTERVAL_MS - 1
  const skipped = see(await opened.connection.check('opened'))
  assert.equal(opened.api.requests.length, 5, 'opening again within the minute asks nothing')
  assert.equal(connectionLabel(skipped.status.connection), 'Connected · Ada Lovelace', 'and shows what is known')
  opened.clock.now += 1
  await opened.connection.check('opened')
  assert.equal(opened.api.requests.length, 10, 'after a minute it checks again')
  await opened.connection.check()
  assert.equal(opened.api.requests.length, 15, '"Check again" always checks')
  assert.equal(OPEN_CHECK_INTERVAL_MS, 60_000)
  console.log('PASS 4.2: two Check again are one check; opening Settings checks at most once a minute')
}
{
  // A check in flight, then Disconnect.
  const t = world({ stored: TOKEN, timeoutMs: 60_000 })
  t.api.model.hang = () => true
  const checking = t.connection.check()
  await until('the check to be under way', () => t.api.requests.length === 2)
  const from = t.emitted.length
  const late = see(await within(Promise.all([checking, t.connection.disconnect()]), 1500, 'Disconnect during a check that never returns'))
  assert.deepEqual([late[0].ok, late[0].error], [false, SUPERSEDED_ERROR], 'the check is told it was replaced')
  assert.equal(late[1].ok, true)
  assert.equal(label(t), 'Not connected')
  assert.equal(t.secrets.store.has('cloudflare-token'), false, 'the token is gone')
  assert.deepEqual(t.writes, [], 'nothing of the old check was kept in Settings')
  assert.deepEqual([...new Set(t.emitted.slice(from).map((status) => status.connection.state))].sort(), ['checking', 'no-token'], 'no window is ever told what the cancelled check would have said')
  assert.equal(t.api.requests.length, 2, 'and no further question is asked with the removed token')
  assert.equal((await t.connection.disconnect()).ok, true, 'Disconnect with no token is nothing to do')

  // The same when the check's answers do arrive, after Disconnect was asked for.
  const answered = world({ stored: TOKEN, honourAbort: true })
  const hold = gate()
  answered.api.model.delay = () => hold.wait
  const underWay = answered.connection.check()
  await until('the check to be under way', () => answered.api.requests.length === 2)
  const mark = answered.emitted.length
  const gone = answered.connection.disconnect()
  hold.open()
  await Promise.all([underWay, gone])
  await answered.connection.idle()
  assert.equal(label(answered), 'Not connected')
  assert.deepEqual(answered.writes, [])
  assert.ok(answered.emitted.slice(mark).every((status) => status.connection.state === 'checking' || status.connection.state === 'no-token'))
  console.log('PASS 4.3: Disconnect during a check: at once, and the check\'s answer changes nothing')
}
{
  // A check in flight, then Replace token.
  const t = world({ stored: TOKEN, timeoutMs: 60_000, config: { project: 'talks' } })
  const hold = gate()
  t.api.model.delay = (request) => (request.authorization.endsWith(TOKEN) ? hold.wait : undefined)
  const checking = t.connection.check()
  await until('the first token\'s check to be under way', () => t.api.requests.length === 2)
  const from = t.emitted.length
  const replaced = see(await within(t.connection.saveToken(OTHER), 1500, 'Replace token during a check'))
  assert.equal(replaced.ok, true)
  hold.open() // the first token's answers arrive now, after it was replaced
  const late = see(await checking)
  assert.deepEqual([late.ok, late.error], [false, SUPERSEDED_ERROR])
  await t.connection.idle()
  assert.equal(label(t), 'Connected · Grace Hopper', 'the state is the new token\'s')
  assert.equal(t.secrets.store.read('cloudflare-token'), OTHER)
  assert.deepEqual(t.writes, [{ accountId: GRACE.id }], 'only the new token\'s account is ever written to Settings')
  assert.ok(t.emitted.slice(from).every((status) => status.connection.state !== 'connected' || status.connection.account.id === GRACE.id), 'no window is told the old token\'s account after the replacement')
  const after = t.api.requests.slice(2).map((request) => request.authorization)
  assert.ok(after.length >= 4 && after.every((authorization) => authorization === `Bearer ${OTHER}`), 'every question after the replacement carries the new token')

  // Two replacements in a row: the last one asked for is the one kept.
  const twice = world({ stored: TOKEN })
  const [a, b] = [twice.connection.saveToken(PAGES_ONLY), twice.connection.saveToken(OTHER)]
  see(await a)
  see(await b)
  await twice.connection.idle()
  assert.equal(twice.secrets.store.read('cloudflare-token'), OTHER)
  assert.equal(label(twice), 'Connected · Grace Hopper')
  // Save, then Disconnect before it has run: nothing is left.
  const undone = world()
  const [saving, leaving] = [undone.connection.saveToken(TOKEN), undone.connection.disconnect()]
  see(await saving)
  see(await leaving)
  await undone.connection.idle()
  assert.deepEqual([label(undone), undone.secrets.store.has('cloudflare-token'), undone.api.requests.length], ['Not connected', false, 0])
  console.log('PASS 4.4: Replace token during a check: the old token\'s answer changes nothing; the last request wins')
}
{
  // A save that cannot be written keeps the earlier token, says why, and checks the earlier one.
  const t = world({ stored: TOKEN, config: { project: 'talks' } })
  t.secrets.files.knobs.failWrites = true
  const failed = see(await t.connection.saveToken(OTHER))
  assert.deepEqual([failed.ok, failed.error], [false, secretsFailureMessage('not-saved', 'cloudflare-token')])
  t.secrets.files.knobs.failWrites = false
  await t.connection.idle()
  assert.equal(t.secrets.store.read('cloudflare-token'), TOKEN)
  assert.equal(label(t), 'Connected · Ada Lovelace')
  // A token that cannot be removed.
  t.secrets.files.knobs.failRemoves = true
  const stuck = see(await t.connection.disconnect())
  assert.deepEqual([stuck.ok, stuck.error], [false, secretsFailureMessage('not-removed', 'cloudflare-token')])
  t.secrets.files.knobs.failRemoves = false
  // The slot emptied from outside (another program of a later ticket): the status does not keep claiming a connection.
  await t.connection.check()
  assert.equal(label(t), 'Connected · Ada Lovelace')
  t.secrets.store.clear('cloudflare-token')
  assert.equal(label(t), 'Not connected')
  console.log('PASS 4.5: a token that cannot be saved or removed: the secrets module\'s sentence, and the earlier token keeps working')
}

// ── 4b. Fix round 1: what a change under way must not leave behind ──────────────────────────────
{
  // A live deploy is authorised with the token, the account and a completed check of one generation.
  const calls = []
  const launch = (name) => async (credentials) => { calls.push({ name, ...credentials }); return name }
  const t = world({ stored: TOKEN, config: { project: 'talks' } })
  const granted = see(await t.connection.authoriseLiveDeploy())
  assert.equal(granted.ok, true, 'with nothing known yet, the authorisation runs the check itself and waits for it')
  assert.ok(t.api.reached().includes('GET /user/tokens/verify'))
  assert.deepEqual(Object.keys(granted.authorisation).sort(), ['accountId', 'clean', 'current', 'run'], 'the token is not a field of the authorisation')
  assert.ok(!Object.values(granted.authorisation).some((value) => typeof value === 'string' && value.includes(TOKEN)), 'nor is it in any field')
  assert.equal(granted.authorisation.clean(`Bearer ${TOKEN} and ${TOKEN}`), 'Bearer [token removed] and [token removed]', 'the authorisation takes the token out of what the tool printed')
  assert.deepEqual(await granted.authorisation.run(launch('deploy')), { superseded: false, result: 'deploy' })
  assert.deepEqual(calls, [{ name: 'deploy', CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ADA.id }])
  // Replace token between the deploy and its secrets: the second launch does not start.
  see(await t.connection.saveToken(OTHER))
  assert.equal(granted.authorisation.current(), false)
  assert.deepEqual(await granted.authorisation.run(launch('secret bulk')), { superseded: true })
  assert.equal(calls.length, 1, 'nothing is launched with the replaced token')
  await t.connection.idle()
  // The same for Disconnect, and for a change of the account in Settings.
  for (const change of [(w) => w.connection.disconnect(), (w) => { w.config.accountId = GRACE.id; return w.connection.settingsChanged() }]) {
    const w = world({ stored: BOTH_ACCOUNTS, config: { accountId: ADA.id, project: 'talks' } })
    const leave = await w.connection.authoriseLiveDeploy()
    assert.equal(leave.ok, true)
    const changed = change(w)
    assert.deepEqual(await leave.authorisation.run(launch('late')), { superseded: true }, 'refused from the moment the change is asked for, before it has run')
    see(await changed)
  }
  assert.equal(calls.length, 1)

  // The finding itself: the deploy waits on the check; Replace token arrives; the new, unchecked state is not leave.
  const racing = world({ stored: PAGES_ONLY, config: { accountId: ADA.id, project: 'talks' }, honourAbort: true })
  const hold = gate()
  racing.api.model.delay = (request) => (request.authorization.endsWith(PAGES_ONLY) ? hold.wait : undefined)
  const pending = racing.connection.authoriseLiveDeploy()
  await until('the authorisation\'s check to be under way', () => racing.api.requests.length >= 2)
  see(await racing.connection.saveToken(TOKEN))
  hold.open()
  assert.deepEqual(await pending, { ok: false, error: DEPLOY_SUPERSEDED_ERROR }, 'a deploy that began with the replaced token is refused')
  await racing.connection.idle()

  // Never on "nothing known": no answer from Cloudflare, no token, a rejected token, an account not chosen.
  const offline = world({ stored: TOKEN, timeoutMs: 40 })
  offline.api.model.hang = () => true
  assert.deepEqual(await offline.connection.authoriseLiveDeploy(), { ok: false, error: DEPLOY_NOT_CHECKED_ERROR })
  assert.deepEqual(await world().connection.authoriseLiveDeploy(), { ok: false, error: DEPLOY_NOT_CONNECTED_ERROR }, 'with no token there is no authorisation')
  assert.deepEqual(await world({ stored: UNKNOWN }).connection.authoriseLiveDeploy(), { ok: false, error: DEPLOY_NOT_CONNECTED_ERROR })
  assert.deepEqual(await world({ stored: BOTH_ACCOUNTS }).connection.authoriseLiveDeploy(), { ok: false, error: DEPLOY_NOT_CONNECTED_ERROR })

  // The main process is a thin caller of the deploy sequence tested below: it reads neither the token nor the account.
  const main = readFileSync(join(repo, 'src/main/index.ts'), 'utf8')
  const body = main.slice(main.indexOf('function deployLiveWorker('), main.indexOf('async function startLocalLiveWorker('))
  assert.ok(body.includes('return deployLiveService({') && !/readToken\(|getConfig\('cfAccountId'|await /.test(body), 'deployLiveWorker only hands ports to deployLiveService')
  console.log('PASS 4.6: a live deploy is authorised per generation; Replace, Disconnect or a change of account stops the next launch')
}
{
  // The account is changed in Settings while a check for the earlier account is under way.
  const t = world({ stored: BOTH_ACCOUNTS, config: { accountId: ADA.id, project: 'new-site' }, honourAbort: true })
  const hold = gate()
  let held = true
  t.api.model.delay = () => (held ? hold.wait : undefined)
  const old = t.connection.check()
  await until('the first check to be under way', () => t.api.requests.length >= 2)
  const from = t.emitted.length
  t.config.accountId = GRACE.id // what Settings writes, then tells the connection
  const fresh = t.connection.settingsChanged()
  assert.notEqual(fresh, old, 'the change starts a check of its own: it does not join the one for the earlier account')
  held = false
  hold.open()
  assert.deepEqual([(await old).ok, (await old).error], [false, SUPERSEDED_ERROR])
  const after = see(await fresh)
  assert.equal(connectionLabel(after.status.connection), 'Connected · Grace Hopper')
  assert.ok(t.emitted.slice(from).every((status) => status.connection.state !== 'connected' || status.connection.account.id === GRACE.id), 'no window is told the earlier account\'s state after the change')
  see(await t.connection.createSite())
  assert.ok(t.api.model.sites.get(GRACE.id)?.has('new-site') && !t.api.model.sites.get(ADA.id).has('new-site'), 'the site is made in the account Settings names')

  // Settings changed with no word to the connection (another program): Create site sees it in its own turn.
  const quiet = world({ stored: BOTH_ACCOUNTS, config: { accountId: ADA.id, project: 'quiet-site' } })
  await quiet.connection.check()
  assert.equal(quiet.connection.status().publishing.state, 'no-site')
  quiet.config.accountId = GRACE.id
  const refusedCreate = see(await quiet.connection.createSite())
  assert.deepEqual([refusedCreate.ok, refusedCreate.error], [false, SETTINGS_CHANGED_ERROR])
  assert.equal(quiet.api.reached().filter((line) => line.startsWith('POST ')).length, 0, 'nothing is created')
  assert.equal(connectionLabel(refusedCreate.status.connection), 'Connected · Grace Hopper', 'and the row is asked for again, for the account Settings names now')
  quiet.config.project = 'renamed-site'
  const renamed = see(await quiet.connection.createSite())
  assert.deepEqual([renamed.error, quiet.api.reached().filter((line) => line.startsWith('POST ')).length], [SETTINGS_CHANGED_ERROR, 0], 'the same for the site name')
  // And a check whose Settings moved under it asks again instead of publishing the earlier account's answer.
  const moving = world({ stored: BOTH_ACCOUNTS, config: { accountId: ADA.id, project: 'talks' } })
  let moved = false
  moving.api.model.delay = (request) => { if (!moved && request.path.includes('/pages/')) { moved = true; moving.config.accountId = GRACE.id } return undefined }
  const settledOn = see(await moving.connection.check())
  assert.equal(connectionLabel(settledOn.status.connection), 'Connected · Grace Hopper')
  assert.equal(settledOn.status.publishing.state, 'no-site', 'the row is the new account\'s, not Ready from the earlier one')
  console.log('PASS 4.7: a change of account or site starts a new generation; Create site never posts to an account Settings no longer names')
}
{
  // What the app found cannot be saved in Settings (a full disk).
  const t = world({ stored: TOKEN, config: { project: '' }, api: { accountSites: { [ADA.id]: ['talkweaver-handouts'] } } })
  t.port.failWrites = true
  const failed = see(await t.connection.check())
  assert.deepEqual([failed.ok, failed.error, failed.status.notice], [false, SETTINGS_NOT_SAVED_NOTICE, SETTINGS_NOT_SAVED_NOTICE])
  assert.deepEqual([failed.status.publishing.state, publishingLabel(failed.status.publishing)], ['unknown', '—'], 'publishing is not Ready while Settings holds no account')
  assert.deepEqual([t.config.accountId, t.config.project], ['', ''])
  t.port.failWrites = false
  const saved = see(await t.connection.check())
  assert.deepEqual([saved.ok, publishingLabel(saved.status.publishing), t.config.accountId, t.config.project], [true, 'Ready', ADA.id, 'talkweaver-handouts'])
  // The picker's choice that cannot be saved.
  const picker = world({ stored: BOTH_ACCOUNTS })
  await picker.connection.check()
  picker.port.failWrites = true
  const unsaved = see(await picker.connection.chooseAccount(GRACE.id))
  assert.deepEqual([unsaved.ok, unsaved.error, unsaved.status.connection.state], [false, SETTINGS_NOT_SAVED_NOTICE, 'choose-account'])

  // Settings cannot be read during a check: "could not check", never left at "Checking…".
  const unread = world({ stored: TOKEN })
  unread.port.failReads = true
  const thrown = see(await unread.connection.check())
  assert.deepEqual([thrown.ok, thrown.error], [false, CHECK_FAILED_ERROR])
  unread.port.failReads = false
  assert.deepEqual([connectionLabel(unread.connection.status().connection), unread.connection.status().busy], ['Could not check (offline?)', false])
  assert.deepEqual(connectionActions(unread.connection.status().connection), ['check-again'])
  see(await unread.connection.check())
  assert.equal(connectionLabel(unread.connection.status().connection), 'Connected · Ada Lovelace', 'and Check again works afterwards')
  console.log('PASS 4.8: a failed save in Settings is said and publishing is not Ready; a port that throws ends in "Could not check"')
}
{
  // More accounts than one page.
  const many = Array.from({ length: 120 }, (_, index) => ({ id: `acc-many-${String(index).padStart(4, '0')}`, name: `Account ${index}` }))
  const WIDE = fake('wide')
  ALL_TOKENS.push(WIDE)
  const wide = (config) => world({ stored: WIDE, config, api: { accounts: many, tokens: { [WIDE]: { accounts: many.map((account) => account.id) } }, accountSites: { [many[100].id]: ['talks'] } } })
  const named = wide({ accountId: many[100].id, project: 'talks' })
  const found = see(await named.connection.check())
  assert.equal(connectionLabel(found.status.connection), 'Connected · Account 100', 'an account on the third page is found by the id Settings names')
  assert.equal(found.status.publishing.state, 'ready')
  assert.deepEqual(named.api.requests.filter((request) => request.path === '/accounts').map((request) => request.search), ['?page=1&per_page=50', '?page=2&per_page=50', '?page=3&per_page=50'])
  const picker = wide({})
  const offered = see(await picker.connection.check())
  assert.deepEqual([offered.status.connection.state, offered.status.connection.accounts.length], ['choose-account', 120], 'the picker offers every account, not the first fifty')
  assert.equal((await picker.connection.chooseAccount(many[119].id)).ok, true)
  // A page that does not answer: the list is not used in part.
  const broken = wide({})
  broken.api.model.answer = (request) => (request.path === '/accounts' && request.search.includes('page=2') ? { status: 503, body: 'unavailable' } : undefined)
  assert.equal(connectionLabel((await broken.connection.check()).status.connection), 'Could not check (offline?)')

  // More than the cap: a fixed outcome, and the typed id is used as it is.
  const endless = (config) => {
    const t = world({ stored: TOKEN, config })
    t.api.model.answer = (request) => {
      if (request.path !== '/accounts') return undefined
      const page = Number(new URLSearchParams(request.search).get('page'))
      return { status: 200, body: { success: true, errors: [], result: Array.from({ length: 50 }, (_, index) => ({ id: `acc-p${page}-${index}`, name: `P${page} ${index}` })) } }
    }
    return t
  }
  const tooMany = endless({})
  const capped = see(await tooMany.connection.check())
  assert.deepEqual([capped.status.connection.state, capped.status.connection.accounts.length, capped.status.notice], ['choose-account', 0, TOO_MANY_ACCOUNTS_NOTICE])
  assert.equal(tooMany.api.requests.filter((request) => request.path === '/accounts').length, ACCOUNTS_CAP / ACCOUNTS_PER_PAGE, 'it stops asking at the cap')
  assert.deepEqual([ACCOUNTS_CAP, ACCOUNTS_PER_PAGE], [1000, 50])
  const typed = endless({ accountId: ADA.id, project: 'talks' })
  const used = see(await typed.connection.check())
  assert.deepEqual([used.status.connection.state, used.status.connection.account.id, used.status.publishing.state], ['connected', ADA.id, 'ready'], 'with too many to list, the id typed in Settings is used')
  console.log('PASS 4.9: the account list is read page by page; beyond 1000 the outcome is fixed and the typed id is used')
}

// ── 4c. Fix round 2: the invariant. Every change of token, account or site name is a new generation ──
{
  const WORKER = `https://talkweaver-live-sessions.${WORKERS_SUBDOMAIN}.workers.dev`
  // The shipped bundle: made-up bytes with a manifest for them (scripts/test-live-service-upload.mjs tests the real thing).
  const SHIPPED = (() => { const files = workerDistFiles({ repo, bundle: Buffer.from('export default {}\n') }); return { manifest: files.manifestText, bundle: files.bundle, config: files.configBytes } })()
  const BUILD = JSON.parse(SHIPPED.manifest).build
  /** A connected connection with a deploy authorisation in hand, for an event to act on. */
  async function authorised(overrides = {}) {
    const t = world({ stored: BOTH_ACCOUNTS, config: { accountId: ADA.id, project: 'talks' }, ...overrides })
    const leave = await t.connection.authoriseLiveDeploy()
    assert.equal(leave.ok, true, 'an authorisation can be taken before the event')
    return { t, authorisation: leave.authorisation }
  }
  /** What a request of the set-up is, for the record: its reads, the upload (`deploy`), workers.dev, the keys (`secret`). */
  const stepOf = (method, path) => (method === 'GET' ? 'look-up' : method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(path) ? 'deploy' : method === 'PATCH' ? 'secret' : method === 'POST' ? 'workers-dev' : 'domain')
  const writesOf = (launched) => launched.map((launched) => launched.step).filter((step) => step !== 'look-up')
  /** The set-up sequence over ports that record every request sent and what was written. */
  function deployOver(t, hooks = {}) {
    const did = { launched: [], keys: 0, saved: [] }
    const api = t?.api ?? createFakeCloudflare({ accounts: [ADA], tokens: { [TOKEN]: { accounts: [ADA.id] } } })
    const inner = fakeCloudflareFetch(api)
    const result = deployLiveService({
      shipped: () => SHIPPED,
      expectedBuild: BUILD,
      authorise: hooks.authorise ?? (() => t.connection.authoriseLiveDeploy()),
      storedKeys: () => { did.keys += 1; hooks.atKeys?.(); return null },
      makeKeys: () => ({ adminSecret: 'made-up-admin', signingSecret: 'made-up-signing' }),
      shareHostname: () => null,
      shareDomainAttachedBefore: () => false,
      recordShareDomain: () => {},
      fetch: async (address, init = {}) => {
        const url = new URL(address)
        const path = url.pathname.replace(/^\/client\/v4/, '')
        const step = stepOf(init.method ?? 'GET', path)
        did.launched.push({ step, token: new Headers(init.headers).get('authorization').replace(/^Bearer /, ''), account: /^\/accounts\/([^/]+)/.exec(path)?.[1] })
        await hooks.during?.(step)
        return inner(address, init)
      },
      apiBase: () => CLOUDFLARE_API_BASE,
      save: (kept) => { did.saved.push(kept) },
      timeoutMs: { upload: 2000, request: 2000 },
    })
    return { did, result }
  }

  // Every event of the table at the top of the module. `apply` does it and waits for it to finish.
  // (The first save of a token is `replace token` with nothing to replace: with no token no
  // authorisation can exist, which the end of this section shows.)
  const EVENTS = [
    ['replace token', {}, (t) => t.connection.saveToken(OTHER)],
    ['disconnect', {}, (t) => t.connection.disconnect()],
    ['choose account', {}, (t) => t.connection.chooseAccount(GRACE.id)],
    ['settingsChanged: account', {}, (t) => { t.config.accountId = GRACE.id; return t.connection.settingsChanged() }],
    ['settingsChanged: site name', {}, (t) => { t.config.project = 'another-site'; return t.connection.settingsChanged() }],
    ['a check that finds another account and saves it', {}, (t) => { t.api.model.tokens.get(BOTH_ACCOUNTS).accounts = [GRACE.id]; return t.connection.check() }],
    ['a check that finds the site and saves its name', { config: { accountId: ADA.id, project: '' } }, (t) => { t.api.model.sites.get(ADA.id).set('talkweaver-handouts', { domains: [] }); return t.connection.check() }],
    // The site is named in Settings already, so the check after the creation saves nothing: the creation itself is the event.
    ['create site', { config: { accountId: ADA.id, project: 'fresh-site' } }, (t) => t.connection.createSite()],
  ]
  for (const [name, overrides, apply] of EVENTS) {
    // Refused at launch.
    const before = await authorised(overrides)
    see(await apply(before.t))
    await before.t.connection.idle()
    let started = 0
    assert.equal(before.authorisation.current(), false, `${name}: the authorisation taken before it is no longer current`)
    assert.deepEqual(await before.authorisation.run(async () => { started += 1 }), { superseded: true }, `${name}: refused at launch`)
    assert.equal(started, 0, `${name}: the launch does not start`)

    // Refused after a launch that was under way completes.
    const flying = await authorised(overrides)
    const hold = gate()
    const launch = flying.authorisation.run(async (credentials) => { await hold.wait; return credentials.CLOUDFLARE_ACCOUNT_ID })
    see(await apply(flying.t))
    await flying.t.connection.idle()
    hold.open()
    assert.deepEqual(await launch, { superseded: true }, `${name}: what a launch under way brings back is not handed on`)

    // Writes nothing: the event arrives during the deploy's LAST launch.
    const whole = world({ stored: BOTH_ACCOUNTS, config: { accountId: ADA.id, project: 'talks' }, ...overrides })
    await whole.connection.check()
    const { did, result } = deployOver(whole, { during: async (step) => { if (step === 'secret') { see(await apply(whole)); await whole.connection.idle() } } })
    assert.deepEqual(await result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR }, `${name}: a deploy superseded in its last launch answers the fixed sentence`)
    assert.deepEqual(did.saved, [], `${name}: and writes nothing: no Worker address or version is saved`)
    assert.deepEqual(writesOf(did.launched), ['deploy', 'workers-dev', 'secret'])
  }
  // The same events, when they change nothing, are not a new generation: a deploy is not stopped for no reason.
  const calm = await authorised()
  see(await calm.t.connection.check())
  see(await calm.t.connection.check('opened'))
  see(await calm.t.connection.chooseAccount('acc-not-listed'))
  see(await calm.t.connection.saveToken('not a token'))
  assert.equal(calm.authorisation.current(), true, 'a check that changes nothing, and refused requests, leave the authorisation valid')

  // Before the first check has saved an account there is no authorisation to invalidate: asking for
  // one runs that check (which saves the account, a new generation) and grants for the generation after it.
  const first = world({ stored: TOKEN, config: { project: 'talks' } })
  const granted = await first.connection.authoriseLiveDeploy()
  assert.deepEqual([granted.ok, granted.authorisation?.accountId, granted.authorisation?.current(), first.config.accountId], [true, ADA.id, true, ADA.id])
  const unpicked = world({ stored: BOTH_ACCOUNTS })
  assert.deepEqual(await unpicked.connection.authoriseLiveDeploy(), { ok: false, error: DEPLOY_NOT_CONNECTED_ERROR }, 'with no account chosen none is granted')
  console.log(`PASS 4.10: ${EVENTS.length} events × (refused at launch · refused after a launch under way · nothing written)`)

  // The deploy sequence itself (src/main/live-service-deploy.ts), at each point a change can arrive.
  const steady = () => world({ stored: TOKEN, config: { accountId: ADA.id, project: 'talks' } })
  // Nothing changes: every request with the saved token and account, then the one write.
  {
    const t = steady()
    const { did, result } = deployOver(t)
    assert.deepEqual(await result, { ok: true, baseUrl: WORKER, adminSecret: 'made-up-admin' })
    assert.deepEqual(did.launched.map((launched) => launched.step), ['look-up', 'look-up', 'deploy', 'workers-dev', 'secret'])
    assert.ok(did.launched.every((launched) => launched.token === TOKEN && launched.account === ADA.id), 'each with the saved token, in the saved account')
    // The address is kept with the account it was deployed for (ticket 04 fix round: a publish by another account does not publish it).
    assert.deepEqual([did.saved, did.keys], [[{ baseUrl: WORKER, accountId: ADA.id }], 1])
  }
  // Before the first write (the change arrives as the keys are read).
  {
    const t = steady()
    const { did, result } = deployOver(t, { atKeys: () => { void t.connection.saveToken(OTHER) } })
    assert.deepEqual(await result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR })
    assert.deepEqual([writesOf(did.launched), did.saved], [[], []], 'before the first write: nothing is uploaded')
    await t.connection.idle()
  }
  // Between the writes (the change arrives during the upload: nothing after it starts).
  {
    const t = steady()
    const { did, result } = deployOver(t, { during: async (step) => { if (step === 'deploy') await t.connection.disconnect() } })
    assert.deepEqual(await result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR })
    assert.deepEqual([writesOf(did.launched), did.saved], [['deploy'], []], 'between writes: the next does not start')
  }
  // During the last write: covered for every event above. Before the result write, by the sequence's
  // own check: an authorisation whose requests never report it, but which is no longer current.
  {
    let current = true
    const quiet = { accountId: ADA.id, current: () => current, clean: (text) => text, run: async (launch) => ({ superseded: false, result: await launch({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ADA.id }) }) }
    const { did, result } = deployOver(null, { authorise: async () => ({ ok: true, authorisation: quiet }), during: async (step) => { if (step === 'secret') current = false } })
    assert.deepEqual(await result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR })
    assert.deepEqual(did.saved, [], 'before the result write: the sequence checks for itself and writes nothing')
    // After the upload: the next request does not start even if the authorisation's own `run` would let it.
    let live = true
    const loose = { ...quiet, current: () => live }
    const early = deployOver(null, { authorise: async () => ({ ok: true, authorisation: loose }), during: async (step) => { if (step === 'deploy') live = false } })
    assert.deepEqual(await early.result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR })
    assert.deepEqual([writesOf(early.did.launched), early.did.saved], [['deploy'], []])
    // And before anything is sent or the keys may be made: an authorisation already superseded when it arrives.
    const stale = deployOver(null, { authorise: async () => ({ ok: true, authorisation: { ...quiet, current: () => false } }) })
    assert.deepEqual(await stale.result, { ok: false, error: DEPLOY_SUPERSEDED_ERROR })
    assert.deepEqual([stale.did.keys, stale.did.launched, stale.did.saved], [0, [], []])
  }
  // A refused authorisation passes through with nothing sent or written.
  {
    const t = world({ stored: PAGES_ONLY, config: { accountId: ADA.id, project: 'talks' } })
    const { did, result } = deployOver(t)
    assert.equal((await result).error, `${LIVE_NO_PERMISSION}. Add the permission ${WORKERS_PERMISSION} to the token in Settings → Cloudflare.`)
    assert.deepEqual([did.keys, did.launched, did.saved], [0, [], []])
  }
  // An upload Cloudflare fails is sorted (D12): the sentence, and Details in numbers only; nothing is written.
  {
    const t = steady()
    t.api.model.answer = (request) => (request.method === 'PUT' ? { status: 400, body: { success: false, errors: [{ code: 10021, message: `raw ${REPLY_TEXT_MARK}` }], messages: [], result: null } } : null)
    const { did, result } = deployOver(t)
    assert.deepEqual(await result, { ok: false, error: LIVE_SETUP_FAILED, details: 'Uploading the live service: Cloudflare answered 400 (error 10021).' })
    assert.deepEqual([writesOf(did.launched), did.saved], [['deploy'], []], 'the keys are not set and nothing is saved')
    // A shipped bundle that does not match its manifest: no leave is asked for, nothing is sent.
    const missing = await deployLiveService({ shipped: () => ({ ...SHIPPED, bundle: Buffer.from('export default { other: 1 }\n') }), expectedBuild: BUILD, authorise: () => assert.fail('not asked') })
    assert.deepEqual([missing.ok, missing.error], [false, INSTALLATION_INCOMPLETE], 'with the bundle not matching its manifest no authorisation is asked for')
  }
  console.log('PASS 4.11: the set-up sequence stops before anything is sent, before the first write, between writes, in the last write and before its own write')

  // A failed Run handout publish in History (D12): the sentence; the tool's output only behind Details.
  const shown = []
  const toast = publishFailureToast('Could not publish Run handout', { error: 'Publishing to Cloudflare did not finish.', details: `raw ${REPLY_TEXT_MARK}` }, 'run-handout-publish-failed', (...args) => shown.push(args))
  assert.deepEqual([toast.message, toast.level, toast.key, toast.action.label], ['Could not publish Run handout: Publishing to Cloudflare did not finish.', 'error', 'run-handout-publish-failed', 'Details'])
  assert.ok(!toast.message.includes(REPLY_TEXT_MARK) && shown.length === 0, 'the tool\'s output is not in the message, and is not shown until asked for')
  toast.action.onAction()
  assert.deepEqual(shown, [[`raw ${REPLY_TEXT_MARK}`, 'info', 'run-handout-publish-failed-details']])
  assert.equal(publishFailureToast('Could not publish Run handout', {}, 'k', () => {}).action, undefined, 'no Details button with nothing behind it')
  const history = readFileSync(join(repo, 'src/renderer/src/components/History.tsx'), 'utf8')
  assert.ok(!/Details: \$\{result\.details\}/.test(history) && (history.match(/showPublishFailure\('Could not (?:un)?publish Run handout', result,/g) ?? []).length === 2, 'History shows both Run handout failures this way')
  console.log('PASS 4.12: a failed Run handout publish shows its sentence, with the tool\'s output behind Details')
}

// ── 5. An existing install ──────────────────────────────────────────────────────────────────────
{
  // What an install from before this ticket has: the token in the slot, the account id and the site
  // in Settings. Opening Settings → Cloudflare is all that happens.
  const t = world({ stored: PAGES_ONLY, config: { accountId: ADA.id, project: 'talks', baseUrl: '' } })
  assert.equal(label(t), 'Checking…', 'a saved token shows as not yet checked')
  see(await t.connection.check('opened'))
  const status = t.connection.status()
  assert.equal(connectionLabel(status.connection), 'Connected · Ada Lovelace')
  assert.equal(publishingLabel(status.publishing), 'Ready')
  assert.equal(t.slotWrites(), 0, 'the saved token is used as it is: the slot is not written')
  assert.deepEqual(t.writes, [], 'and Settings is not changed')
  assert.deepEqual(t.tokensSent(), [PAGES_ONLY])
  assert.equal(status.liveService.state, 'no-permission', 'it lacks the live-service permission: said, and publishing is not affected')
  // Disconnect leaves Settings and Cloudflare alone.
  const before = t.api.requests.length
  see(await t.connection.disconnect())
  assert.deepEqual([t.writes.length, t.api.requests.length, t.config.accountId, t.config.project], [0, before, ADA.id, 'talks'])
  console.log('PASS 5: an existing install\'s publishing token is the one token, with nothing to do')
}

// ── 5b. The "Share-link domain" row ─────────────────────────────────────────────────────────────
{
  const answer = (kind, result = null) => ({ kind, http: kind === 'ok' ? 200 : kind === 'denied' ? 403 : null, codes: [], result })
  const HOST = 'drafts.handouts.example'
  const ZONE = { id: 'zone-0001', name: 'handouts.example' }
  const edge = (row) => { const shown = shareLinkRowEdge(row); return shown.kind === 'state' ? shown.text : null }

  // The pure row-state function: one test per state, in the spec's words.
  const none = shareLinkRow('', {}, null)
  assert.equal(none.state, 'none')
  assert.equal(edge(none), 'None')
  const attached = shareLinkRow(HOST, { shareDomains: answer('ok', [{ hostname: HOST }]), shareZones: answer('ok', [ZONE]), shareRoutes: answer('ok', true) }, null)
  assert.equal(attached.state, 'attached')
  assert.equal(edge(attached), 'Attached')
  const elsewhere = shareLinkRow(HOST, { shareZones: answer('ok', []), shareDomains: answer('ok', []) }, null)
  assert.equal(elsewhere.state, 'not-on-account')
  assert.equal(edge(elsewhere), 'This domain is not on this Cloudflare account')
  const cannot = shareLinkRow(HOST, { shareZones: answer('ok', [ZONE]), shareRoutes: answer('denied'), shareDomains: answer('ok', []) }, null)
  assert.equal(cannot.state, 'no-permission')
  assert.equal(edge(cannot), 'The token cannot attach a domain')
  assert.equal(cannot.permission, ROUTES_PERMISSION)
  assert.equal(shareLinkRowDetail(cannot), `Add the permission ${ROUTES_PERMISSION} to your Cloudflare token, then press Check again`, 'it says what to do, with the permission as the app names it')
  assert.equal(ROUTES_PERMISSION, 'Zone · Workers Routes · Edit')
  assert.equal(shareLinkRow(HOST, { shareZones: answer('denied') }, null).state, 'no-permission', 'a zone the token may not read cannot be attached to either')

  // Not decisive: the last known state is kept greyed, an unanswered first look says nothing, and a
  // zone the token can reach that is not attached yet has no state of the four.
  const stale = shareLinkRow(HOST, { shareZones: answer('unreachable'), shareDomains: answer('unreachable') }, attached)
  assert.deepEqual([stale.state, stale.stale], ['attached', true])
  assert.equal(shareLinkRow(HOST, { shareZones: answer('unreachable') }, null).state, 'unknown')
  assert.equal(shareLinkRow(HOST, { shareZones: answer('unreachable') }, { ...attached, host: 'other.example' }).state, 'unknown', 'a state known for another address is not carried over')
  // Its zone is on the account, routes were not refused, and the address is not yet a Workers custom domain.
  const notYet = shareLinkRow(HOST, { shareZones: answer('ok', [ZONE]), shareRoutes: answer('ok', true), shareDomains: answer('ok', []) }, null)
  assert.equal(notYet.state, 'not-attached')
  assert.equal(edge(notYet), 'Not attached yet')
  assert.equal(shareLinkRowDetail(notYet), HOST, 'the detail line shows the host, as the other set states do')
  assert.equal(shareLinkRow(HOST, { shareZones: answer('ok', [ZONE]), shareRoutes: answer('ok', true), shareDomains: answer('unreachable') }, null).state, 'not-attached', 'an unanswered domain list does not hide the zone answer')
  assert.equal(shareLinkRow(HOST, { shareZones: answer('ok', [ZONE]), shareRoutes: answer('ok', true), shareDomains: answer('ok', []) }, attached).state, 'not-attached', 'a fresh answer wins over a known attached state')
  const kept = shareLinkRow(HOST, { shareZones: answer('unreachable') }, notYet)
  assert.deepEqual([kept.state, kept.stale], ['not-attached', true], 'a not-attached state is kept greyed when nothing decisive was answered')
  assert.equal(edge(shareLinkRow(HOST, {}, null)), null, 'a row with nothing to report shows no state')
  assert.deepEqual(zoneOfHost('a.b.example.com', [{ id: '1', name: 'example.com' }, { id: '2', name: 'b.example.com' }, { id: '3', name: 'xample.com' }]), { id: '2', name: 'b.example.com' }, 'the longest zone that contains the host')

  // Through the connection: asked only when an address is set; a status carries the row.
  const withShare = (api, shareDomain) => world({ api: { zones: [{ ...ZONE, account: ADA.id }], ...api }, config: { shareDomain } })
  const noAddress = withShare({}, '')
  await connect(noAddress, TOKEN)
  assert.equal(noAddress.connection.status().shareLink.state, 'none')
  assert.ok(!noAddress.api.requests.some((request) => request.path.startsWith('/zones') || request.path.endsWith('/workers/domains')), 'nothing about zones or domains is asked with no address set')

  const onAccount = withShare({ workerDomains: { [ADA.id]: [HOST] } }, HOST)
  await connect(onAccount, TOKEN)
  assert.equal(onAccount.connection.status().shareLink.state, 'attached')

  const foreign = withShare({}, 'drafts.other.example')
  await connect(foreign, TOKEN)
  assert.equal(foreign.connection.status().shareLink.state, 'not-on-account')

  const noRoutes = withShare({ tokens: { [TOKEN]: { accounts: [ADA.id], routes: false } } }, HOST)
  await connect(noRoutes, TOKEN)
  assert.equal(noRoutes.connection.status().shareLink.state, 'no-permission')

  // Read-only: only GET requests, and none of the share-link reads changed anything.
  for (const t of [onAccount, foreign, noRoutes]) assert.ok(t.api.requests.every((request) => request.method === 'GET'), 'the share-link reads write nothing')

  // The address changed in Settings: settingsChanged asks again.
  onAccount.config.shareDomain = 'drafts.other.example'
  const again = see(await onAccount.connection.settingsChanged())
  await onAccount.connection.idle()
  assert.equal(again.ok, true)
  assert.equal(onAccount.connection.status().shareLink.state, 'not-on-account', 'a changed address is asked for again')
  assert.equal(onAccount.connection.status().shareLink.host, 'drafts.other.example')

  // A refused or unreachable account leaves the row where it was.
  const offline = withShare({ workerDomains: { [ADA.id]: [HOST] } }, HOST)
  await connect(offline, TOKEN)
  offline.api.model.answer = () => ({ status: 500, body: 'down' })
  see(await offline.connection.check())
  await offline.connection.idle()
  assert.deepEqual([offline.connection.status().connection.state, offline.connection.status().shareLink.state, offline.connection.status().shareLink.stale], ['unreachable', 'attached', true])
  console.log('PASS 5b: Share-link domain — None · Attached · not on this account · the token cannot attach a domain · Not attached yet; asked only with an address set, read-only, asked again when it changes')
}

// ── 6. Nothing secret, and nothing Cloudflare wrote, in anything that leaves the module ─────────
{
  // Replies that quote the token back, and a transport error that quotes the header.
  const t = world({ stored: TOKEN })
  t.api.model.answer = (request) => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: `${REPLY_TEXT_MARK}: bad ${request.authorization}` }], result: { echoed: request.authorization } } })
  see(await t.connection.check())
  t.api.model.answer = (request) => ({ throws: Object.assign(new Error(`${REPLY_TEXT_MARK} invalid header ${request.authorization}`), { cause: new Error(request.authorization) }) })
  see(await t.connection.check())
  t.api.model.answer = (request) => (request.path === '/accounts'
    ? { status: 200, body: { success: true, errors: [], result: [{ id: ADA.id, name: `Ada${String.fromCharCode(0x202e, 7)} ${'x'.repeat(200)}` }, { id: '../../user', name: 'not an id' }] } }
    : undefined)
  const named = see(await t.connection.check())
  assert.equal(named.status.connection.state, 'connected', 'an entry whose id is not an id is not an account')
  assert.match(named.status.connection.account.name, /^Ada x+$/, 'an account name is cut to plain printable text')
  assert.equal(named.status.connection.account.name.length, 80)

  // `ask` itself: what it returns for a reply full of text.
  const port = { fetch: fakeCloudflareFetch(t.api), base: CLOUDFLARE_API_BASE, timeoutMs: 100, cancelled: new AbortController().signal }
  t.api.model.answer = () => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: REPLY_TEXT_MARK }, { code: 'x' }], result: { echoed: REPLY_TEXT_MARK } } })
  assert.deepEqual(await ask(port, TOKEN, 'GET', '/accounts', () => true), { kind: 'denied', http: 403, codes: [10000], result: null })

  const everything = JSON.stringify(observed) + printed.join('\n')
  for (const token of ALL_TOKENS) assert.ok(!everything.includes(token), 'no token in any status, reply, error or printed line')
  assert.ok(!everything.includes(REPLY_TEXT_MARK), 'no text of a Cloudflare reply either')
  assert.ok(observed.length > 150, `${observed.length} statuses and replies searched`)
  assert.ok(JSON.stringify(observed).includes('Cloudflare error 10000'), 'the search is of real content: Details hold the error numbers')
  console.log(`PASS 6: ${observed.length} statuses and replies and ${printed.length} printed lines hold no token and no reply text`)
}

// ── 7. Where requests go; no other source of a token ────────────────────────────────────────────
{
  const dev = { packaged: false, e2e: true }
  assert.equal(standInApiBase({ ...dev, override: 'http://127.0.0.1:8123/client/v4' }), 'http://127.0.0.1:8123/client/v4')
  assert.equal(cloudflareApiBase({ ...dev, override: 'http://127.0.0.1:8123/client/v4' }), 'http://127.0.0.1:8123/client/v4')
  assert.equal(standInApiBase({ packaged: true, e2e: true, override: 'http://127.0.0.1:8123/client/v4' }), null, 'a packaged build ignores it')
  assert.equal(standInApiBase({ packaged: false, e2e: false, override: 'http://127.0.0.1:8123/client/v4' }), null, 'so does an app not started as a test harness')
  assert.equal(cloudflareApiBase({ packaged: true, e2e: true, override: 'http://127.0.0.1:8123/client/v4' }), 'https://api.cloudflare.com/client/v4')
  for (const elsewhere of ['https://127.0.0.1:8123/client/v4', 'http://localhost:8123/client/v4', 'http://127.0.0.1/client/v4', 'http://127.0.0.1:8123/', 'http://127.0.0.1:8123/client/v4/x',
    'http://127.0.0.1:8123/client/v4?x=1', 'http://127.0.0.1:8123/client/v4#x', 'http://user:pass@127.0.0.1:8123/client/v4', 'http://127.0.0.1.example.com:8123/client/v4',
    'http://10.0.0.5:8123/client/v4', 'https://api.example.com/client/v4', '', undefined, null, 7]) {
    assert.equal(loopbackApiBase(elsewhere), null, `not a loopback stand-in: ${elsewhere}`)
    assert.equal(cloudflareApiBase({ ...dev, override: elsewhere }), CLOUDFLARE_API_BASE)
  }
  // `ask` sends nowhere else, whatever it is handed.
  const api = createFakeCloudflare()
  const send = (base, path = '/accounts', token = TOKEN) => ask({ fetch: fakeCloudflareFetch(api), base, timeoutMs: 100, cancelled: new AbortController().signal }, token, 'GET', path, () => true)
  for (const base of ['https://api.example.com/client/v4', 'http://10.0.0.5:1/client/v4', 'https://api.cloudflare.com.example.com/client/v4', 'http://localhost:1/client/v4']) {
    assert.equal((await send(base)).kind, 'unreachable')
  }
  assert.equal((await send(CLOUDFLARE_API_BASE, '/accounts/../../user')).kind, 'unreachable', 'an address that climbs out of its place is not sent')
  assert.equal((await send(CLOUDFLARE_API_BASE, '/accounts', 'not a token\r\n')).kind, 'refused', 'nor a token that is not one')
  assert.equal(api.requests.length, 0, 'none of these left the module')
  assert.equal((await send('http://127.0.0.1:8123/client/v4')).kind, 'ok')
  assert.equal(api.requests[0].origin, 'http://127.0.0.1:8123')

  // "How to make a token" names the permissions of all four features.
  assert.deepEqual(TOKEN_PERMISSIONS.map((entry) => entry.feature), ['Publishing handouts', 'Going live and sharing', 'Share-link domain', 'Recording storage'])
  assert.deepEqual(TOKEN_PERMISSIONS.flatMap((entry) => entry.permissions), ['Account · Cloudflare Pages · Edit', 'Account · Workers Scripts · Edit', 'Zone · Workers Routes · Edit'])
  assert.ok(HOW_TO_MAKE_A_TOKEN.length >= 3)

  // No code path reads a Cloudflare token from Bitwarden, the Keychain command or the environment.
  assert.equal(existsSync(join(repo, 'src/main/live-worker-cloudflare-token.ts')), false, 'the Bitwarden and Keychain-command token module is deleted')
  const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.(?:mjs|js|ts|tsx)$/.test(entry.name) ? [path] : []
  })
  const tokenSources = (name, text) => [
    [/find-generic-password/, 'the Keychain command'],
    [/['"`](?:\/usr\/bin\/)?security['"`]/, 'the Keychain command'],
    [/BWS_ACCESS_TOKEN|CLOUDFLARE-WORKER-/, 'Bitwarden'],
    [/['"`]bws['"`]\s*,\s*\[/, 'Bitwarden'],
    [/process\.env(?:\.|\[['"`])(?:CLOUDFLARE|CF)_(?:API_)?(?:TOKEN|KEY)/, 'the environment'],
    [/process\.env(?:\.|\[['"`])(?:CLOUDFLARE|CF)_ACCOUNT_ID/, 'the environment'],
  ].filter(([pattern]) => pattern.test(text)).map(([, what]) => `${name}: ${what}`)
  for (const [sample, what] of [
    ["execFile('security', ['find-generic-password', '-w'])", 'the Keychain command'], ["await run('bws', ['secret', 'list'])", 'Bitwarden'],
    ['const token = process.env.CLOUDFLARE_API_TOKEN', 'the environment'], ["process.env['CF_API_TOKEN']", 'the environment'], ['env.BWS_ACCESS_TOKEN', 'Bitwarden'],
  ]) assert.ok(tokenSources('sample.ts', sample).includes(`sample.ts: ${what}`), `caught: ${sample}`)
  assert.deepEqual(tokenSources('sample.ts', "set: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }"), [], 'handing the token to the bundled tool is not reading it')
  const found = sources(join(repo, 'src')).flatMap((file) => tokenSources(relative(repo, file).split('\\').join('/'), readFileSync(file, 'utf8')))
  assert.deepEqual(found, [], 'under src nothing reads a Cloudflare token from Bitwarden, the Keychain command or an environment variable')
  // The slot is read in two places only: this module, and the main process handing it to the bundled tool.
  const readers = sources(join(repo, 'src')).filter((file) => /['"`]cloudflare-token['"`]/.test(readFileSync(file, 'utf8'))).map((file) => relative(repo, file).split('\\').join('/')).sort()
  assert.deepEqual(readers, ['src/main/cloudflare-connection.ts', 'src/main/index.ts', 'src/main/secrets-store.ts'])
  console.log('PASS 7: requests go to Cloudflare or, in an unpackaged test harness only, to loopback; the token has one source')
}

console.log('cloudflare connection: the two state tables, the pure check, operations and their order, an existing install, nothing secret shown — passed')
