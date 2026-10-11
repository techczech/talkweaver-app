// The Cloudflare connection against the fake Cloudflare API over real HTTP (spec
// "Cloudflare set-up in the app", test matrix: "Project creation: missing project → create →
// publish", integration). The real connection module with the platform's own `fetch`, the real
// secrets store over memory, the fake API on this computer's loopback address, and the bundled
// wrangler started through the app's launcher. No request leaves the machine.
// 1. paste a token → connected → the site is missing → create it → the row is Ready → `pages deploy`
//    publishes to the site that was just made;
// 2. several accounts, a token without the permission, a rejected token, over the wire;
// 3. no answer: the check gives up at its time limit, Disconnect does not wait for it, and a
//    redirect is not followed (the token is not carried to another address);
// 4. the live service: set up and updated with the app's own API requests from a freshly built
//    worker-dist (no wrangler: ticket 11), over real HTTP, with the token of the connection's leave;
// 5. the token went nowhere but the Authorization header of requests to the fake API.
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCloudflareConnection, loopbackApiBase } from '../src/main/cloudflare-connection.ts'
import { connectionLabel, publishingLabel, shareLinkRowDetail, shareLinkRowEdge } from '../src/shared/cloudflare-status.ts'
import { SITE_FOUND_DETAIL } from '../src/main/cloudflare-connection.ts'
import { PUBLISH_FAILED, PUBLISH_REFUSED, pagesDeployFailure } from '../src/main/publishing-logic.ts'
import { prepareWranglerRun } from '../src/main/wrangler-launcher.ts'
import { REPLY_TEXT_MARK, WORKERS_SUBDOMAIN, startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { memorySecrets } from './lib/memory-secrets.mjs'
import { createHash } from 'node:crypto'
import { LIVE_SETUP_REFUSED } from '../src/main/live-service-deploy.ts'
import { buildWorkerDist } from './lib/worker-dist.mjs'
import { setUpLiveService, uploadedOf } from './lib/live-service-setup.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'tw-cloudflare-api-'))
// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'cloudflare', 'api', name, '0123456789abcdef'].join('-')
const TOKEN = fake('one')
const BOTH = fake('both')
const READ_ONLY = fake('readonly')
const UNKNOWN = fake('unknown')
const NO_ROUTES = fake('noroutes')
const READS_ALL = fake('readsall')
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const GRACE = { id: 'acc-grace-0002', name: 'Grace Hopper' }
const observed = []
const soon = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const within = (promise, ms, what) => Promise.race([promise, soon(ms).then(() => assert.fail(`${what} did not finish within ${ms} ms`))])

const api = await startCloudflareApiStub({
  sites: [],
  accounts: [ADA, GRACE],
  zones: [{ id: 'zone-ada-0001', name: 'handouts.example', account: ADA.id }],
  workerDomains: { [ADA.id]: ['drafts.handouts.example'] },
  tokens: { [TOKEN]: { accounts: [ADA.id] }, [NO_ROUTES]: { accounts: [ADA.id], routes: false }, [BOTH]: { accounts: [ADA.id, GRACE.id] }, [READ_ONLY]: { accounts: [GRACE.id], pages: 'read', workers: false }, [READS_ALL]: { accounts: [ADA.id], pages: 'read', workers: 'read' } },
})
assert.equal(loopbackApiBase(api.baseUrl), api.baseUrl, 'the fake API is on this computer\'s loopback address')

function app(config = {}, timeoutMs = 5000) {
  const secrets = memorySecrets()
  const settings = { accountId: '', project: '', baseUrl: '', productionBranch: 'main', ...config }
  const connection = createCloudflareConnection({
    secrets: secrets.store,
    settings: { read: () => ({ ...settings }), write: (patch) => Object.assign(settings, patch) },
    fetch: (input, init) => fetch(input, init),
    apiBase: () => api.baseUrl,
    timeoutMs,
    onChange: (status) => observed.push(status),
  })
  const connect = async (token) => { const reply = await connection.saveToken(token); observed.push(reply); await connection.idle(); return connection.status() }
  return { secrets, settings, connection, connect }
}

/** One wrangler command through the app's launcher, as the main process runs it (`set` is explicit). */
function wrangler(install, args, set, input = '') {
  const prepared = prepareWranglerRun(install, args, { inherited: process.env, set })
  assert.equal(prepared.ok, true, prepared.ok ? '' : `${prepared.error}. ${prepared.details}`)
  const { command, args: argv, env, cwd } = prepared.launch
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let said = ''
    child.stdout.on('data', (chunk) => { said += String(chunk) })
    child.stderr.on('data', (chunk) => { said += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, said }) })
    child.stdin.end(input)
  })
}

try {
  const install = { execPath: process.execPath, appRoot: repo, platform: process.platform, workDir: join(scratch, 'wrangler-runs') }
  mkdirSync(install.workDir, { recursive: true })

  // ── 1. Paste a token → create the site → publish to it ───────────────────────────────────────
  {
    const t = app()
    let status = await t.connect(TOKEN)
    assert.equal(connectionLabel(status.connection), 'Connected · Ada Lovelace')
    assert.equal(publishingLabel(status.publishing), 'No site yet — Create talkweaver-handouts')
    assert.equal(t.settings.accountId, ADA.id, 'the account is found from the token')
    assert.ok(api.reached().includes(`GET /accounts/${ADA.id}/pages/projects/talkweaver-handouts`))

    const created = await t.connection.createSite()
    observed.push(created)
    assert.equal(created.ok, true)
    status = t.connection.status()
    assert.equal(publishingLabel(status.publishing), 'Ready', 'creating the site turns the row Ready')
    assert.equal(t.settings.project, 'talkweaver-handouts')
    assert.ok(api.model.sites.get(ADA.id).has('talkweaver-handouts'), 'the fake API holds the new site')
    assert.equal(api.reached().filter((line) => line === `POST /accounts/${ADA.id}/pages/projects`).length, 1)

    // Publish to it, as the app does: the account and the site the connection wrote to Settings,
    // the token and the fake API's address on the launcher's explicit side.
    const siteDir = join(scratch, 'site')
    mkdirSync(siteDir, { recursive: true })
    writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>Made by the connection test</title>')
    const before = api.requests.length
    const deploy = await wrangler(install, ['pages', 'deploy', siteDir, '--project-name', t.settings.project, '--branch', 'main', '--commit-dirty=true'],
      { CLOUDFLARE_API_TOKEN: t.secrets.store.read('cloudflare-token'), CLOUDFLARE_ACCOUNT_ID: t.settings.accountId, CLOUDFLARE_API_BASE_URL: api.baseUrl })
    assert.equal(deploy.status, 0, `pages deploy to the site just made\n${deploy.said.split(TOKEN).join('[token]')}`)
    const reached = api.reached().slice(before)
    assert.ok(reached.includes(`GET /accounts/${ADA.id}/pages/projects/talkweaver-handouts`), 'wrangler found the site the app made')
    assert.ok(reached.includes('POST /pages/assets/upload'), 'uploaded the page')
    assert.ok(reached.includes(`POST /accounts/${ADA.id}/pages/projects/talkweaver-handouts/deployments`), 'and made the deployment')
    assert.ok(!deploy.said.includes(TOKEN), 'wrangler does not print the token')
    console.log('PASS 1: token → Connected → No site yet → Create → Ready → pages deploy publishes to the new site')
  }

  const edgeOf = (status) => { const shown = shareLinkRowEdge(status.shareLink); return shown.kind === 'state' ? shown.text : null }
  // ── 1b. The share-link address row, over the wire ────────────────────────────────────────────
  {
    const before = api.requests.length
    const none = app({ shareDomain: '' })
    assert.equal(edgeOf(await none.connect(TOKEN)), 'None')
    assert.ok(!api.requests.slice(before).some((request) => request.path.startsWith('/zones') || request.path.endsWith('/workers/domains')), 'with no address nothing about zones is asked')

    const attached = app({ shareDomain: 'drafts.handouts.example' })
    assert.equal(edgeOf(await attached.connect(TOKEN)), 'Attached')

    const foreign = app({ shareDomain: 'drafts.elsewhere.example' })
    assert.equal(edgeOf(await foreign.connect(TOKEN)), 'This domain is not on this Cloudflare account')

    const notYet = app({ shareDomain: 'new.handouts.example' })
    assert.equal(edgeOf(await notYet.connect(TOKEN)), 'Not attached yet')

    const cannot = app({ shareDomain: 'new.handouts.example' })
    assert.equal(edgeOf(await cannot.connect(NO_ROUTES)), 'The token cannot attach a domain')

    // A changed address is asked for again through settingsChanged, and nothing was written at Cloudflare.
    foreign.settings.shareDomain = 'drafts.handouts.example'
    observed.push(await foreign.connection.settingsChanged())
    await foreign.connection.idle()
    assert.equal(edgeOf(foreign.connection.status()), 'Attached')
    assert.ok(api.requests.every((request) => request.method === 'GET' || !request.path.startsWith('/zones')), 'zones are only read')
    console.log('PASS 1b: share-link address over the wire — None, Attached, not on this account, the token cannot attach a domain, Not attached yet')
  }

  // ── 1c. The handout web address over the wire, and the share-link suggestion from it ───────
  {
    // The site made in 1 gets custom domains at Cloudflare.
    const site = api.model.sites.get(ADA.id).get('talkweaver-handouts')
    site.domains = [{ id: 'domain-pending', name: 'pending.handouts.example', status: 'pending' }, { id: 'domain-one', name: 'handouts.example', status: 'active' }]
    const before = api.requests.length
    const t = app({ project: 'talkweaver-handouts', shareDomain: '' })
    let status = await t.connect(TOKEN)
    assert.deepEqual([status.publishing.state, status.publishing.address, status.publishing.customDomain], ['ready', 'handouts.example', 'set'], 'the first active custom domain is the handout address')
    assert.ok(api.reached().slice(before).includes(`GET /accounts/${ADA.id}/pages/projects/talkweaver-handouts/domains`))
    assert.deepEqual([status.shareLink.state, status.shareLink.suggested], ['none', { host: 'share.handouts.example', zone: 'handouts.example' }])
    assert.ok(api.requests.slice(before).every((request) => request.method === 'GET' && !request.path.startsWith('/zones')), 'a suggestion reads nothing about zones and writes nothing')
    // No custom domain active: the pages.dev address, and nothing suggested.
    site.domains = [{ id: 'domain-pending', name: 'pending.handouts.example', status: 'pending' }]
    const plain = app({ project: 'talkweaver-handouts', shareDomain: '' })
    status = await plain.connect(TOKEN)
    assert.deepEqual([status.publishing.address, status.publishing.customDomain, status.shareLink.suggested], ['talkweaver-handouts.pages.dev', 'none', null])
    site.domains = []
    console.log('PASS 1c: the handout address is the site\'s active custom domain (else pages.dev); share.<it> suggested, nothing read or written for it')
  }

  // ── 2. Several accounts; a token without the permission; a rejected token ────────────────────
  {
    const t = app()
    let status = await t.connect(BOTH)
    assert.equal(connectionLabel(status.connection), 'Choose an account')
    assert.deepEqual(status.connection.accounts, [ADA, GRACE])
    const chosen = await t.connection.chooseAccount(GRACE.id)
    observed.push(chosen)
    assert.equal(connectionLabel(chosen.status.connection), 'Connected · Grace Hopper')
    assert.equal(publishingLabel(chosen.status.publishing), 'No site yet — Create talkweaver-handouts', 'the site made in the other account is not this account\'s')

    const reader = app()
    status = await reader.connect(READ_ONLY)
    assert.equal(status.liveService.state, 'no-permission')
    const denied = await reader.connection.createSite()
    observed.push(denied)
    assert.deepEqual([publishingLabel(denied.status.publishing), denied.status.publishing.permission], ['The token cannot publish pages', 'Account · Cloudflare Pages · Edit'])
    assert.ok(!api.model.sites.get(GRACE.id)?.has('talkweaver-handouts'), 'nothing was made')

    const stranger = app()
    status = await stranger.connect(UNKNOWN)
    assert.equal(connectionLabel(status.connection), 'Cloudflare did not accept this token')
    // A token that can read everything and edit nothing, where the site exists. The check only
    // reads, so it shows Ready (and says in Details what that means); the first publish proves it
    // cannot, and fails with a fixed sentence: nothing Cloudflare or the tool wrote is the message.
    const looker = app()
    status = await looker.connect(READS_ALL)
    assert.deepEqual([connectionLabel(status.connection), publishingLabel(status.publishing), status.liveService.state], ['Connected · Ada Lovelace', 'Ready', 'not-refused'])
    assert.ok(status.details.includes(SITE_FOUND_DETAIL), 'Details says Ready means found, and that publishing proves the permission')
    const lookerSite = join(scratch, 'looker-site')
    mkdirSync(lookerSite, { recursive: true })
    writeFileSync(join(lookerSite, 'index.html'), '<!doctype html><title>Never published</title>')
    const before = api.requests.length
    const attempt = await wrangler(install, ['pages', 'deploy', lookerSite, '--project-name', looker.settings.project, '--branch', 'main', '--commit-dirty=true'],
      { CLOUDFLARE_API_TOKEN: READS_ALL, CLOUDFLARE_ACCOUNT_ID: looker.settings.accountId, CLOUDFLARE_API_BASE_URL: api.baseUrl })
    assert.notEqual(attempt.status, 0, 'a token that can only read cannot publish')
    assert.ok(attempt.said.includes(REPLY_TEXT_MARK), 'the tool\'s own output does quote Cloudflare (so the next line is a real test)')
    const shown = pagesDeployFailure(attempt.said)
    assert.equal(shown.error, PUBLISH_REFUSED, 'what the person is told is the fixed sentence')
    assert.ok(!shown.error.includes(REPLY_TEXT_MARK) && !`${shown.error}${shown.details}`.includes(READS_ALL))
    assert.ok(!api.reached().slice(before).some((line) => line.includes('/pages/assets/upload') || line.endsWith('/deployments')), 'nothing was uploaded or deployed')
    assert.equal(pagesDeployFailure('ENOSPC: no space left on device').error, PUBLISH_FAILED, 'any other failure has its own fixed sentence')
    observed.push(shown.error)

    console.log('PASS 2: several accounts → the picker; a token that cannot edit → the permission named; an unknown token → rejected')
  }

  // ── 3. No answer, and a redirect ─────────────────────────────────────────────────────────────
  {
    const t = app({ accountId: ADA.id, project: 'talkweaver-handouts' }, 300)
    api.model.hang = () => true
    const started = Date.now()
    const status = await within(t.connect(TOKEN), 5000, 'a check the API never answers')
    assert.equal(connectionLabel(status.connection), 'Could not check (offline?)')
    assert.ok(Date.now() - started < 3000, 'it gives up at its time limit')

    // Disconnect while a check hangs: at once.
    const slow = app({ accountId: ADA.id, project: 'talkweaver-handouts' }, 60_000)
    slow.secrets.store.write('cloudflare-token', TOKEN)
    const checking = slow.connection.check()
    await soon(100)
    const gone = await within(slow.connection.disconnect(), 3000, 'Disconnect during a check that hangs')
    observed.push(gone, await checking)
    assert.equal(connectionLabel(gone.status.connection), 'Not connected')
    api.model.hang = null

    // A redirect to another address is not followed: the token is never carried there.
    const elsewhere = []
    const other = createServer((request, response) => { elsewhere.push(request.headers.authorization ?? '(no header)'); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"success":true,"result":[]}') })
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
    try {
      api.model.answer = () => ({ status: 302, body: '', headers: { location: `http://127.0.0.1:${other.address().port}/client/v4/accounts` } })
      const redirected = await app({}, 2000).connect(TOKEN)
      assert.equal(connectionLabel(redirected.connection), 'Could not check (offline?)')
      assert.deepEqual(elsewhere, [], 'no request, and so no token, reached the address it was redirected to')
    } finally {
      api.model.answer = null
      other.closeAllConnections?.()
      await new Promise((resolve) => other.close(resolve))
    }
    console.log('PASS 3: a check with no answer ends at its time limit; Disconnect does not wait; a redirect is not followed')
  }

  // ── 4. The live service: set up and updated with the API, from the shipped bundle ────────────
  {
    const distDir = join(scratch, 'worker-dist')
    const manifest = buildWorkerDist({ repo, outDir: distDir })
    const t = app()
    await t.connect(TOKEN)
    const NAME = 'talkweaver-live-sessions'
    const ADDRESS = `https://${NAME}.${WORKERS_SUBDOMAIN}.workers.dev`
    const keys = { stored: null }
    const run = (over = {}) => setUpLiveService({ distDir, expectedBuild: manifest.build, authorise: () => (over.connection ?? t.connection).authoriseLiveDeploy(), apiBase: api.baseUrl, keys: over.keys ?? keys, shareHostname: over.shareHostname ?? null })
    const worker = () => api.model.workers.get(ADA.id).get(NAME)
    const uploads = (from) => api.requests.slice(from).filter((request) => request.method === 'PUT' && request.path === `/accounts/${ADA.id}/workers/scripts/${NAME}`)

    const before = api.requests.length
    const first = await run()
    assert.deepEqual([first.result.ok, first.result.baseUrl, first.saved], [true, ADDRESS, [{ baseUrl: ADDRESS, accountId: ADA.id }]], `first set-up\n${JSON.stringify(first.result)}`)
    const [upload] = uploads(before)
    assert.equal(upload.authorization, `Bearer ${TOKEN}`, 'with the connection\'s token')
    const { metadata, module } = uploadedOf(upload)
    assert.equal(createHash('sha256').update(module.bytes).digest('hex'), manifest.files['index.js'].sha256, 'over the wire, the uploaded bytes are the shipped bundle by its manifest hash')
    assert.ok(module.bytes.equals(readFileSync(join(distDir, 'index.js'))))
    assert.deepEqual([metadata.migrations.new_tag, metadata.migrations.steps.length, 'old_tag' in metadata.migrations], ['v4', 4, false], 'every migration')
    assert.deepEqual([worker().migrationTag, worker().workersDev, worker().secrets.sort()], ['v4', true, ['ADMIN_SECRET', 'SESSION_SIGNING_SECRET']])
    const firstKeys = keys.stored

    // An update, with the share-link domain set, then cleared.
    const update = api.requests.length
    const second = await run({ shareHostname: 'talks.handouts.example' })
    assert.equal(second.result.ok, true)
    assert.equal(keys.stored, firstKeys, 'the stored keys are reused')
    assert.ok(!('migrations' in uploadedOf(uploads(update)[0]).metadata), 'nothing new: no migration sent')
    const patch = api.requests.slice(update).find((request) => request.method === 'PATCH')
    assert.equal(JSON.parse(patch.body.toString()).secrets.ADMIN_SECRET.text, firstKeys.adminSecret, 'the same admin secret is set again')
    const ours = () => api.model.workerDomains.get(ADA.id).filter((domain) => domain.service === NAME).map((domain) => domain.hostname)
    assert.deepEqual(ours(), ['talks.handouts.example'], 'the share-link domain is attached')
    assert.equal((await run()).result.ok, true)
    assert.deepEqual(ours(), [], 'and removed when it is cleared')
    assert.ok(api.model.workerDomains.get(ADA.id).some((domain) => domain.hostname === 'drafts.handouts.example'), 'another Worker\'s domain is left alone')

    // A token that can read Workers but not deploy them: refused at the upload, which changes nothing.
    const reader = app()
    await reader.connect(READS_ALL)
    const uploadsBefore = worker().uploads
    const refused = await run({ connection: reader.connection, keys })
    assert.deepEqual([refused.result.ok, refused.result.error, refused.result.details], [false, LIVE_SETUP_REFUSED, 'Uploading the live service: Cloudflare answered 403 (error 10000).'])
    assert.equal(worker().uploads, uploadsBefore)
    // A token without the Workers permission is not given leave at all.
    const none = app()
    await none.connect(READ_ONLY)
    const notLet = await run({ connection: none.connection, keys: { stored: null } })
    assert.equal(notLet.result.ok, false)
    assert.equal(api.model.workers.get(GRACE.id)?.size ?? 0, 0, 'nothing reached its account')
    for (const result of [first, second, refused, notLet].map((done) => done.result)) observed.push(result.ok ? { ...result, adminSecret: '[handed to the caller]' } : result)
    // 4b. The suggested share-link address, as the row's "Use …" button does it (index.ts
    // useSuggestedShareDomain): saved, checked again, then attached by updating the live service.
    {
      const site = api.model.sites.get(ADA.id).get('talkweaver-handouts')
      site.domains = [{ id: 'domain-one', name: 'handouts.example', status: 'active' }]
      const u = app({ project: 'talkweaver-handouts', shareDomain: '' })
      let status = await u.connect(TOKEN)
      assert.deepEqual([status.shareLink.state, status.shareLink.suggested?.host, shareLinkRowEdge(status.shareLink)], ['none', 'share.handouts.example', { kind: 'action', label: 'Use share.handouts.example' }], 'proposed')
      assert.ok(!ours().includes('share.handouts.example'), 'nothing attached before the press')
      // The press: saved, then checked again.
      u.settings.shareDomain = status.shareLink.suggested.host
      status = (await u.connection.settingsChanged()).status
      assert.equal(status.shareLink.state, 'not-attached')
      const attachedNow = await run({ connection: u.connection, shareHostname: 'share.handouts.example' })
      assert.equal(attachedNow.result.ok, true)
      assert.ok(ours().includes('share.handouts.example'), 'attached by the update')
      status = (await u.connection.check()).status
      assert.deepEqual([status.shareLink.state, status.shareLink.host], ['attached', 'share.handouts.example'])
      // A token that may not touch the zone's Workers routes: the row says what to add; nothing is attached.
      const n = app({ project: 'talkweaver-handouts', shareDomain: '' })
      status = await n.connect(NO_ROUTES)
      assert.equal(status.shareLink.suggested?.host, 'share.handouts.example')
      n.settings.shareDomain = 'share.other.handouts.example'
      status = (await n.connection.settingsChanged()).status
      assert.equal(status.shareLink.state, 'no-permission')
      assert.equal(shareLinkRowDetail(status.shareLink), 'Add the permission Zone · Workers Routes · Edit to your Cloudflare token, then press Check again')
      assert.ok(!api.requests.some((request) => request.authorization === `Bearer ${NO_ROUTES}` && request.method !== 'GET'), 'that token wrote nothing')
      site.domains = []
      // Leave the account as section 4 found it for what follows.
      assert.equal((await run()).result.ok, true)
    }
    console.log('PASS 4: the live service is set up and updated over HTTP from the shipped bundle, by its manifest hash; migrations, keys, workers.dev and the share-link domain as planned; a reading token is refused')
  }

  // ── 5. Where the token went ──────────────────────────────────────────────────────────────────
  {
    const tokens = [TOKEN, BOTH, READ_ONLY, UNKNOWN, READS_ALL, NO_ROUTES]
    const everything = JSON.stringify(observed)
    for (const token of tokens) assert.ok(!everything.includes(token), 'no token in any status or reply')
    assert.ok(!everything.includes(REPLY_TEXT_MARK), 'and no text of a reply from the API')
    assert.ok(observed.length > 30)
    for (const request of api.requests) {
      assert.ok(!tokens.some((token) => `${request.path}${request.search}`.includes(token)), 'a token is never part of an address')
    }
    assert.ok(api.requests.filter((request) => request.authorization === `Bearer ${TOKEN}`).length > 10, 'the token travelled in the Authorization header')
    assert.deepEqual(api.unknown, [], 'and nothing was asked that the fake API does not model')
    // The fake is strict: a route it does not model is "no such route", never a quiet success.
    const stray = await fetch(`${api.baseUrl}/accounts/${ADA.id}/not-modelled`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(stray.status, 404)
    assert.deepEqual(api.unknown, [`GET /accounts/${ADA.id}/not-modelled`])
    console.log(`PASS 5: ${observed.length} statuses and replies hold no token; ${api.requests.length} requests carried it only in the header`)
  }
} finally {
  await api.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
console.log('cloudflare connection against the fake API: connect, create the site, publish to it, the live service deploy — passed')
