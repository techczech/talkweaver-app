// Gate: no secret leaves the secrets store (spec docs/plans/cloudflare-setup-in-app, D3; ticket 02).
// The real app, a throwaway user-data folder and vault, made-up secrets, a stand-in Cloudflare API
// and a stand-in live service, both on this computer's loopback address. It saves a token (which
// the app then checks with the stand-in API: the Settings → Cloudflare calls and pushes) and
// recording keys through Settings' own calls, publishes a handout (once to the end, once refused by
// the API), shares a talk for comments, stops the share, asks the live service to stop a results
// link and to close pre-work that an earlier version made, and quits. Then it searches for every
// made-up secret in:
//   - every file of the user-data folder and the vault (config.json, the settings changelog and the
//     registries among them), as UTF-8 and as UTF-16;
//   - everything the main process sent to a window (every reply to an invoke, every message pushed);
//   - everything the app wrote to standard output and standard error.
// So that the search is not passing on an app that did nothing, it also checks which secrets were
// really used in a request: the API got the Cloudflare token; the live service got the admin secret,
// the share's owner token, and the results link's and the pre-work's owner tokens (read back out of
// the secrets store after the move from the registries). What this gate does NOT show in use:
//   - the recording keys are saved and searched for, but no upload is made with them (the app's
//     test mode records an upload without signing it);
//   - the live service admin secret comes from the environment here, so the stored live service
//     keys (admin and signing secret) and the live-session recovery credentials are neither made
//     nor searched for: nothing in this gate goes live.
// The search itself is shown to find a planted value. No value is ever printed: a find is reported
// by where it was found. Nothing here contacts Cloudflare, the installed app or its data.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { openSettingsWindow, closeSettingsWindow, shutdownApp } from './lib/settings-window.mjs'
import { startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-secrets-gate-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'gate-probe'
const outlinePath = join(vault, slug, `${slug}-outline.md`)
mkdirSync(userData, { recursive: true })
mkdirSync(join(vault, slug), { recursive: true })
const outline = ['---', 'title: Gate probe', 'outline_version: 2', '---', '', '### One', '{id=one}', '', '- A point', ''].join('\n')
writeFileSync(outlinePath, outline)

// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', name, 'gate', '0123456789abcdef'].join('-')
const SECRETS = {
  'Cloudflare token': fake('cloudflare'),
  'recording key id': fake('keyid'),
  'recording key secret': fake('keysecret'),
  'live service admin secret': fake('admin'),
  'share owner token': fake('owner'),
  'results link owner token (from an earlier version\'s registry)': fake('legacy'),
  'pre-work owner token (from an earlier version\'s registry)': fake('prework'),
}
const USED = ['Cloudflare token', 'live service admin secret', 'share owner token', 'results link owner token (from an earlier version\'s registry)', 'pre-work owner token (from an earlier version\'s registry)']
const ONLY_SEARCHED = Object.keys(SECRETS).filter((name) => !USED.includes(name))

const CHECKS = [
  'the search finds a planted value (as UTF-8 and as UTF-16)',
  'the app started on the throwaway folder and its replies and pushes are captured',
  'the editor window is refused when it tries to save the token (Settings-only call) and nothing is stored; the token is then typed into the Settings window and saved there; the recording keys are refused from the editor window and saved through the Settings window\'s call',
  'a handout is published to the end with the saved token',
  'a publish the API refuses fails with a message',
  'a talk is shared for comments, updated and stopped',
  'the owner tokens in an earlier version\'s registries were moved out of them',
  'used in a real request: the Cloudflare token, the live service admin secret, and the share, results-link and pre-work owner tokens (the recording keys are only saved and searched for)',
  'no secret in config.json, the settings file (with its change log) or any registry',
  'no secret in any file of the user-data folder or the vault',
  'no secret in anything sent to a window',
  'no secret in standard output or standard error',
  'started with the restore switch, the app writes the tokens back into the registries and quits',
  'started with the restore switch on a damaged registry, the app quits with an error that names the registry',
]
const ledger = createCheckLedger(CHECKS)
const record = (name, ok, detail) => ledger.record(name, Boolean(ok), detail)

/** Where a value is readable under `dir`: relative paths only. */
function findIn(dir, values) {
  const hits = []
  const needles = values.flatMap((value) => [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le')])
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const bytes = readFileSync(path)
        if (needles.some((needle) => bytes.includes(needle))) hits.push(relative(dir, path))
      }
    }
  }
  walk(dir)
  return hits
}

/** The live service, stood in for: shares only, and it records what each call was authorised with. */
function startLiveStandIn() {
  const calls = []
  let revision = 0
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const path = new URL(request.url, 'http://stand-in').pathname
      const auth = request.headers.authorization ?? ''
      calls.push({ method: request.method, path, auth })
      const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
      if (request.method === 'POST' && path === '/shares') {
        if (auth !== `Bearer ${SECRETS['live service admin secret']}`) return reply(401, { error: { code: 'unauthorised' } })
        return reply(201, { shareId: 'gateshr1', ownerToken: SECRETS['share owner token'] })
      }
      const owner = auth === `Bearer ${SECRETS['share owner token']}`
      if (request.method === 'PUT' && path === '/shares/gateshr1/talk') {
        if (!owner) return reply(401, { error: { code: 'unauthorised' } })
        revision += 1
        return reply(200, { revision, seq: revision })
      }
      if (request.method === 'POST' && path === '/shares/gateshr1/close') return owner ? reply(200, { closed: true }) : reply(401, { error: { code: 'unauthorised' } })
      // The results link and the pre-work an earlier version made: the request is recorded and
      // refused, so their rows stay for the restore at the end.
      if (request.method === 'POST' && (path === '/results/gateres1/close' || path === '/prework/gatepre1/close')) return reply(503, { error: { code: 'busy', message: 'The stand-in does not close this.' } })
      return reply(404, { error: { code: 'route_not_found', message: 'not in this stand-in' } })
    })
  })
  server.on('upgrade', (request, socket) => {
    calls.push({ method: 'UPGRADE', path: new URL(request.url, 'http://stand-in').pathname, auth: request.headers.authorization ?? '', query: new URL(request.url, 'http://stand-in').search })
    socket.destroy()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    calls, baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }),
  })))
}

/** In front of the stand-in API: passes everything through until told to refuse. */
function startApiGate(upstream) {
  const state = { refuse: false, refused: 0 }
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      if (state.refuse) {
        state.refused += 1
        response.writeHead(403, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }], messages: [], result: null }))
      }
      const headers = { ...request.headers }
      delete headers.host
      delete headers['content-length']
      const body = Buffer.concat(chunks)
      const forwarded = await fetch(`http://127.0.0.1:${upstream.port}${request.url}`, { method: request.method, headers, body: body.length ? body : undefined })
      response.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/json' })
      response.end(Buffer.from(await forwarded.arrayBuffer()))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state, baseUrl: `http://127.0.0.1:${server.address().port}/client/v4`,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done) }),
  })))
}

let app
let env
let api
let apiGate
let live
let output = ''
let exitCode = 1
try {
  // The search can fail: a planted value is found, in both encodings.
  const planted = join(scratch, 'planted')
  mkdirSync(planted)
  writeFileSync(join(planted, 'utf8.txt'), `x${SECRETS['Cloudflare token']}y`)
  writeFileSync(join(planted, 'utf16.bin'), Buffer.from(`x${SECRETS['share owner token']}y`, 'utf16le'))
  record(CHECKS[0], findIn(planted, [SECRETS['Cloudflare token']]).join() === 'utf8.txt' && findIn(planted, [SECRETS['share owner token']]).join() === 'utf16.bin'
    && findIn(planted, [SECRETS['recording key id']]).length === 0)
  rmSync(planted, { recursive: true, force: true })

  await ensureFreshBuild(root)
  api = await startCloudflareApiStub()
  apiGate = await startApiGate(api)
  live = await startLiveStandIn()
  writeFileSync(join(userData, 'config.json'), JSON.stringify({
    vaultRoot: vault, liveWorkerBaseUrl: live.baseUrl, cfAccountId: 'test-account-0000', cfPagesProject: 'talks',
  }))
  // A results link an earlier version made: its owner token is in the registry, in plain JSON.
  const legacyRegistry = join(userData, 'run-results-share-registry.json')
  writeFileSync(legacyRegistry, `${JSON.stringify({ version: 1, shares: { 'gate-probe/run-1': {
    key: 'gate-probe/run-1', shareId: 'gateres1', ownerToken: SECRETS['results link owner token (from an earlier version\'s registry)'], workerBaseUrl: live.baseUrl,
    include: { board: true, polls: true, prework: false }, lifetime: 'forever', expiresAt: null, createdAt: 1, pushedAt: 1,
  } } }, null, 2)}\n`, { mode: 0o600 })
  // Pre-work an earlier version made, the same way.
  const legacyPrework = join(userData, 'run-prework-registry.json')
  writeFileSync(legacyPrework, `${JSON.stringify({ version: 1, preworks: { 'gate-probe/run-1': {
    key: 'gate-probe/run-1', preworkId: 'gatepre1', ownerToken: SECRETS['pre-work owner token (from an earlier version\'s registry)'], workerBaseUrl: live.baseUrl,
    opensAt: 1000, closesAt: 9_000_000_000_000, cursor: 0, createdAt: 1,
  } } }, null, 2)}\n`, { mode: 0o600 })

  // Only what the app needs from this shell: no credential of the person running the test goes in.
  // TW_LIVE_LOCAL=1: the stand-in live service is on this computer's own address, which the app uses only when asked to (spec D8).
  env = { TW_E2E: '1', TW_LIVE_LOCAL: '1', TALKWEAVER_LIVE_ADMIN_SECRET: SECRETS['live service admin secret'], TW_E2E_CLOUDFLARE_API_BASE_URL: apiGate.baseUrl }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  app = await electron.launch({ args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`], cwd: root, env })
  app.process().stdout.on('data', (chunk) => { output += chunk })
  app.process().stderr.on('data', (chunk) => { output += chunk })
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    electronApp.on('browser-window-created', (_event, win) => hide(win))
  })
  // Capture what the main process sends to any window. The values to look for go in with it, so
  // payloads (thumbnails, compiled talks) are searched where they are and never copied out.
  const capturing = await app.evaluate(({ app: electronApp, ipcMain, webContents }, values) => {
    const gate = { replies: 0, sends: 0, hits: [], configReply: false, cloudflareReply: false, cloudflarePush: false }
    globalThis.__secretsGate = gate
    const look = (channel, payload) => {
      let text = ''
      try { text = JSON.stringify(payload, (_key, value) => (value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value)) ?? '' } catch { text = String(payload) }
      if (values.some((value) => text.includes(value))) gate.hits.push(channel)
      return text
    }
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || handlers.size < 50) return { ok: false, why: 'the invoke handlers could not be reached' }
    for (const [channel, handler] of [...handlers]) {
      handlers.set(channel, async (...args) => {
        try {
          const result = await handler(...args)
          gate.replies += 1
          const text = look(channel, result)
          if (channel === 'publish:get-config' && text.includes('"hasToken":true')) gate.configReply = true
          if (channel === 'cloudflare:save-token' && text.includes('"ok":true')) gate.cloudflareReply = true
          return result
        } catch (error) {
          gate.replies += 1
          look(channel, [String(error), error?.message, error?.stack])
          throw error
        }
      })
    }
    const wrap = (contents) => {
      const send = contents.send.bind(contents)
      contents.send = (channel, ...args) => {
        gate.sends += 1
        const text = look(`push ${channel}`, args)
        if (channel === 'cloudflare:status' && text.includes('"state":"connected"')) gate.cloudflarePush = true
        return send(channel, ...args)
      }
    }
    webContents.getAllWebContents().forEach(wrap)
    electronApp.on('web-contents-created', (_event, contents) => wrap(contents))
    return { ok: true, handlers: handlers.size, userData: electronApp.getPath('userData') }
  }, Object.values(SECRETS))
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.tw?.publish?.getConfig))
  const onThrowaway = capturing.ok && realpathSync(capturing.userData) === realpathSync(userData)
  record(CHECKS[1], onThrowaway, capturing.ok ? `${capturing.handlers} invoke channels wrapped` : capturing.why)
  if (!onThrowaway) throw new Error('not on the throwaway user-data folder, or nothing captured: stopping before any secret is saved')

  // The token goes in the way a person does it: typed into Settings and saved there (which also
  // writes the settings changelog). The recording keys go through the call Settings makes.
  // The editor window is refused: the same call, from the editor, stores nothing (the Settings window's rule).
  const refusedInEditor = await page.evaluate((token) => window.tw.cloudflare.saveToken(token), SECRETS['Cloudflare token'])
  const editorLeftNothing = refusedInEditor?.ok === false && refusedInEditor.error === 'This can be changed only in the Settings window.'
    && !existsSync(join(userData, 'cf-pages-token.bin')) && (await page.evaluate(async () => (await window.tw.publish.getConfig()).hasToken)) === false
  const sw = await openSettingsWindow(app, page, 'cloudflare')
  await sw.locator('input[placeholder="Cloudflare API token"]').fill(SECRETS['Cloudflare token'])
  await sw.getByRole('button', { name: 'Save token' }).click()
  await page.waitForFunction(async () => (await window.tw.publish.getConfig()).hasToken === true)
  // The change log (in the settings file) holds the presence of the key, never the key.
  for (let i = 0; i < 100 && !(await sw.evaluate(async () => (await window.bridleSettings.view()).state.changes.some((entry) => entry.key === 'accounts.cloudflare'))); i++) await sw.waitForTimeout(100)
  // The check that follows the save: the app asks the stand-in API with the token and tells the window.
  await page.waitForFunction(async () => { const status = await window.tw.cloudflare.status(); return status.connection.state === 'connected' && !status.busy })
  // The recording keys are a Settings-window-only change: the editor window is refused and stores nothing.
  const recordingKeys = { accessKeyId: SECRETS['recording key id'], secretAccessKey: SECRETS['recording key secret'] }
  const keysRefusedInEditor = await page.evaluate((keys) => (window.tw.recording.setKeys ? window.tw.recording.setKeys(keys) : { success: false, error: 'not in the editor preload' }), recordingKeys)
  const editorLeftNoKeys = keysRefusedInEditor?.success === false && !existsSync(join(userData, 'recording-r2-creds.bin'))
  const savedKeys = await sw.evaluate((keys) => window.tw.recording.setKeys(keys), recordingKeys)
  const saved = await page.evaluate(async () => ({
    config: await window.tw.publish.getConfig(),
    storage: await window.tw.recording.getStorage(),
  }))
  saved.keys = savedKeys
  await closeSettingsWindow(app)
  record(CHECKS[2], editorLeftNothing && editorLeftNoKeys && saved.keys.success && saved.config.hasToken === true && saved.storage.hasKeys === true
    && existsSync(join(userData, 'cf-pages-token.bin')) && existsSync(join(userData, 'recording-r2-creds.bin')) && existsSync(join(userData, 'settings.json')), editorLeftNothing ? '' : `editor reply: ${refusedInEditor?.error}`)

  // Publish, to the end.
  const published = await page.evaluate(({ path, content }) => window.tw.talk.publishHandout(path, content), { path: outlinePath, content: outline })
  record(CHECKS[3], published?.success === true && typeof published.url === 'string', published?.success ? 'published' : 'the publish did not succeed')

  // Publish again with the API refusing: the failure is a message (searched like every other reply).
  apiGate.state.refuse = true
  const refused = await page.evaluate(({ path, content }) => window.tw.talk.publishHandout(path, content), { path: outlinePath, content: readFileSync(outlinePath, 'utf8') })
  apiGate.state.refuse = false
  record(CHECKS[4], refused?.success === false && typeof refused.error === 'string' && refused.error.length > 0 && apiGate.state.refused > 0)

  // Share for comments, push an update, stop.
  const shared = await page.evaluate((path) => window.tw.sharedTalk.share(path, 'Gate probe'), outlinePath)
  const updated = await page.evaluate((path) => window.tw.sharedTalk.update(path), outlinePath)
  const listed = await page.evaluate(async (path) => ({ status: await window.tw.sharedTalk.status(path), list: await window.tw.sharedTalk.list() }), outlinePath)
  const storeFileWhileShared = existsSync(join(userData, 'owner-tokens.bin'))
  const registryWhileShared = readFileSync(join(userData, 'shared-talk-registry.json'), 'utf8')
  const stopped = await page.evaluate((path) => window.tw.sharedTalk.stop(path), outlinePath)
  record(CHECKS[5], shared?.success === true && shared.share?.shareId === 'gateshr1' && updated?.success === true && updated.share?.revision >= 2
    && listed.status?.shareId === 'gateshr1' && listed.list.length === 1
    && storeFileWhileShared && registryWhileShared.includes('gateshr1') && !registryWhileShared.includes('ownerToken')
    && stopped?.success === true && stopped.serverClosed === true)

  // The results link and the pre-work from the earlier version: each is asked of the live service
  // with its own token, now read from the secrets store. The stand-in refuses, so the rows stay.
  const earlier = await page.evaluate(async () => ({
    stop: await window.tw.history.resultsShareStop('gate-probe', 'run-1'),
    close: await window.tw.history.preworkClose('gate-probe', 'run-1'),
  }))

  const captured = await app.evaluate(() => globalThis.__secretsGate)
  await app.close()
  app = null

  // The earlier version's registries: each row is kept, its token is not in it.
  const legacyAfter = JSON.parse(readFileSync(legacyRegistry, 'utf8')).shares['gate-probe/run-1']
  const preworkAfter = JSON.parse(readFileSync(legacyPrework, 'utf8')).preworks['gate-probe/run-1']
  record(CHECKS[6], legacyAfter?.shareId === 'gateres1' && !('ownerToken' in legacyAfter) && preworkAfter?.preworkId === 'gatepre1' && !('ownerToken' in preworkAfter))

  // Each secret went where it belongs (so the searches below are of an app that used them).
  // Both by the app's own check (the token's own question) and by the bundled publishing tool (an upload).
  const withToken = api.requests.filter((request) => request.authorization === `Bearer ${SECRETS['Cloudflare token']}`).map((request) => request.path)
  const sawToken = withToken.includes('/user/tokens/verify') && withToken.some((path) => path.endsWith('/upload-token'))
  const sawAdmin = live.calls.some((call) => call.path === '/shares' && call.auth === `Bearer ${SECRETS['live service admin secret']}`)
  const ownerCalls = live.calls.filter((call) => call.auth === `Bearer ${SECRETS['share owner token']}`)
  const ownerInQuery = live.calls.some((call) => (call.query ?? '').includes(SECRETS['share owner token']))
  const sawResults = live.calls.some((call) => call.path === '/results/gateres1/close' && call.auth === `Bearer ${SECRETS['results link owner token (from an earlier version\'s registry)']}`)
  const sawPrework = live.calls.some((call) => call.path === '/prework/gatepre1/close' && call.auth === `Bearer ${SECRETS['pre-work owner token (from an earlier version\'s registry)']}`)
  const usedFacts = {
    'Cloudflare token': sawToken,
    'live service admin secret': sawAdmin,
    'share owner token': ownerCalls.some((call) => call.path.endsWith('/talk')) && ownerCalls.some((call) => call.path.endsWith('/close')) && !ownerInQuery,
    'results link owner token (from an earlier version\'s registry)': sawResults && earlier.stop?.ok === false,
    'pre-work owner token (from an earlier version\'s registry)': sawPrework && earlier.close?.ok === false,
  }
  const notUsed = USED.filter((name) => !usedFacts[name])
  record(CHECKS[7], notUsed.length === 0 && Object.keys(usedFacts).length === USED.length,
    `${notUsed.length ? `NOT used: ${notUsed.join('; ')}. ` : ''}used: ${USED.filter((name) => usedFacts[name]).join('; ')}. Saved and searched for only, never used: ${ONLY_SEARCHED.join('; ')}. Not in this gate at all: the stored live service keys (admin and signing secret), live-session recovery credentials`)

  const values = Object.values(SECRETS)
  const named = ['config.json', 'settings.json', 'settings-changelog.json', 'shared-talk-registry.json', 'run-results-share-registry.json', 'run-prework-registry.json', 'handout-registry.json']
  const namedHits = named.filter((file) => existsSync(join(userData, file)) && values.some((value) => readFileSync(join(userData, file)).includes(Buffer.from(value))))
  record(CHECKS[8], existsSync(join(userData, 'config.json')) && existsSync(join(userData, 'settings.json')) && namedHits.length === 0, namedHits.length ? `found in: ${namedHits.join(', ')}` : '')
  const fileHits = [...findIn(userData, values).map((path) => `userData/${path}`), ...findIn(vault, values).map((path) => `vault/${path}`)]
  record(CHECKS[9], fileHits.length === 0, fileHits.length ? `found in: ${fileHits.join(', ')}` : `${countFiles(userData) + countFiles(vault)} files searched`)
  record(CHECKS[10], captured.replies > 10 && captured.sends > 0 && captured.configReply === true && captured.cloudflareReply === true && captured.cloudflarePush === true && captured.hits.length === 0,
    captured.hits.length ? `found in: ${[...new Set(captured.hits)].join(', ')}` : `${captured.replies} replies and ${captured.sends} pushes searched, the Cloudflare screen's among them`)
  const inOutput = values.some((value) => output.includes(value))
  record(CHECKS[11], !inOutput, inOutput ? 'found in the app\'s output' : `${output.length} characters searched`)

  // Going back to an earlier version: the documented switch (owner-tokens.ts), in the real app.
  // Run last, after the searches: it puts the token back into the registry on purpose.
  // Playwright starts Electron with a mock keychain (so this gate never touches the real one); the
  // restore run is started directly and is given the same switch, so it can read what that app wrote.
  const restore = await runToExit(['.', `--user-data-dir=${userData}`, '--use-mock-keychain', '--restore-plain-owner-tokens'], env, 60_000)
  const restoredRow = JSON.parse(readFileSync(legacyRegistry, 'utf8')).shares['gate-probe/run-1']
  const restoredPrework = JSON.parse(readFileSync(legacyPrework, 'utf8')).preworks['gate-probe/run-1']
  const restoreFacts = {
    'quit by itself': restore.code === 0,
    'the registry row has its token again': restoredRow?.ownerToken === SECRETS['results link owner token (from an earlier version\'s registry)'],
    'the pre-work row has its token again': restoredPrework?.ownerToken === SECRETS['pre-work owner token (from an earlier version\'s registry)'],
    'it said what it did': /\[owner-tokens\] restored to the registries/.test(restore.output),
    'its output holds no secret': !values.some((value) => restore.output.includes(value)),
  }
  const restoreMissing = Object.entries(restoreFacts).filter(([, ok]) => !ok).map(([what]) => what)
  const restoreSaid = (restore.output.match(/\[owner-tokens\] restored to the registries (\{.*\})/) ?? [])[1] ?? ''
  record(CHECKS[12], restoreMissing.length === 0, restoreMissing.length ? `not true: ${restoreMissing.join('; ')} (it reported ${restoreSaid})` : 'quit by itself; its output holds counts only')

  // The same switch when a registry cannot be read: an error, and the registry's name (nothing else).
  const damaged = '{"version": 1, "preworks": ['
  writeFileSync(legacyPrework, damaged)
  const failedRestore = await runToExit(['.', `--user-data-dir=${userData}`, '--use-mock-keychain', '--restore-plain-owner-tokens'], env, 60_000)
  const failedFacts = {
    'quit with an error': failedRestore.code === 1,
    'named the damaged registry': /\[owner-tokens\] NOT fully restored: run-prework\s/.test(`${failedRestore.output}\n`),
    'left the damaged registry as it was': readFileSync(legacyPrework, 'utf8') === damaged,
    'its output holds no secret': !values.some((value) => failedRestore.output.includes(value)),
  }
  const failedMissing = Object.entries(failedFacts).filter(([, ok]) => !ok).map(([what]) => what)
  record(CHECKS[13], failedMissing.length === 0, failedMissing.length ? `not true: ${failedMissing.join('; ')} (exit ${failedRestore.code})` : 'exit 1; run-prework named')

  exitCode = ledger.summary('SECRETS GATE').exitCode
} catch (error) {
  // A harness failure. Its text could quote a payload, so made-up values are struck out before printing.
  let text = String(error?.stack ?? error)
  for (const value of Object.values(SECRETS)) text = text.split(value).join('[made-up secret]')
  console.log(`FAIL  the gate could not run: ${text}`)
  try { ledger.summary('SECRETS GATE') } catch { /* summary already printed or not reachable */ }
  exitCode = 1
} finally {
  await shutdownApp(app)
  await apiGate?.close()
  await api?.close()
  await live?.close()
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(exitCode)

/** Start the development app and wait for it to quit by itself. Killed (by its pid) if it does not. */
function runToExit(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(createRequire(import.meta.url)('electron'), args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    child.stderr.on('data', (chunk) => { text += chunk })
    const timer = setTimeout(() => { try { process.kill(child.pid) } catch { /* gone */ } }, timeoutMs)
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code: signal ? `signal ${signal}` : code, output: text }) })
  })
}
function countFiles(dir) {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1
  return count
}
