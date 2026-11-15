// The test-only network overrides on the real app (src/main/test-network-guard.ts, test-network-startup.ts).
//   1. Refused: an unpackaged app started with TW_E2E=1 and every network override pointed at a listener
//      on loopback, on a profile that holds a credential store (fixture files) and no run marker, exits
//      with code 1 and says why, before it takes the instance lock or writes to the profile, and no
//      request reaches the listener.
//   2. Granted: the same app on a profile the harness made for this run (e2e/lib/test-profile.mjs) starts,
//      and a main-process request to a workers.dev address reaches the listener (the stand-in works).
// Fixture values only; the owner's profile is never touched (every --user-data-dir is a fresh temp folder).
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { testProfileEnv } from './lib/test-profile.mjs'

const root = process.cwd()
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const scratch = mkdtempSync(join(tmpdir(), 'tw-network-guard-e2e-'))
const requests = []
const listener = createServer((req, res) => { requests.push({ url: req.url, host: req.headers['x-tw-e2e-live-host'] ?? null }); res.end('{}') })
let app = null

function runToExit(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (b) => { output += b })
    child.stderr.on('data', (b) => { output += b })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'still running', output }) }, timeoutMs)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}

try {
  await ensureFreshBuild(root)
  await new Promise((done) => listener.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${listener.address().port}`
  const overrides = {
    TW_E2E_LIVE_SERVICE_URL: base,
    TW_E2E_CLOUDFLARE_API_BASE_URL: `${base}/client/v4`,
    TW_E2E_RECORDING_ENDPOINT: base,
    TW_E2E_UPDATES_FEED: `${base}/feed.json`,
    TW_E2E_LIVE_PAGE_ALLOW: `127.0.0.1:${listener.address().port}`,
  }
  const baseEnv = { ...process.env, TW_E2E: '1', ...overrides }
  delete baseEnv.ELECTRON_RUN_AS_NODE
  delete baseEnv.TW_E2E_PROFILE_MARKER

  // 1. A profile holding a credential store and no run marker: refused before anything happens.
  const held = join(scratch, 'profile-with-credentials')
  mkdirSync(held, { recursive: true })
  for (const file of ['cf-pages-token.bin', 'live-worker-credentials.bin', 'recording-r2-creds.bin']) writeFileSync(join(held, file), 'fixture, not a secret')
  writeFileSync(join(held, 'config.json'), JSON.stringify({ liveWorkerBaseUrl: 'https://talkweaver-live-sessions.fixture.workers.dev' }))
  const before = readdirSync(held).sort()
  const refused = await runToExit(['.', `--user-data-dir=${held}`, '--use-mock-keychain'], baseEnv, 45_000)
  assert.equal(refused.code, 1, `the app exits with code 1 (got ${refused.code}); output: ${refused.output.slice(-800)}`)
  assert.match(refused.output, /will not start with TW_E2E_LIVE_SERVICE_URL, TW_E2E_CLOUDFLARE_API_BASE_URL, TW_E2E_RECORDING_ENDPOINT, TW_E2E_UPDATES_FEED, TW_E2E_LIVE_PAGE_ALLOW: no run marker was given/, 'it names the overrides and the reason')
  assert.deepEqual(readdirSync(held).sort(), before, 'nothing was written to the profile: no instance lock, no log, no settings')
  assert.deepEqual(requests, [], 'no request reached the listener')
  console.log('PASS refused: a profile holding a credential store and no run marker exits 1, names the reason, writes nothing, sends nothing')

  // The same with the marker variable given but the profile not marked (a stale or copied variable).
  const unmarked = await runToExit(['.', `--user-data-dir=${held}`, '--use-mock-keychain'], { ...baseEnv, TW_E2E_PROFILE_MARKER: 'a-marker-from-another-run-0123' }, 45_000)
  assert.equal(unmarked.code, 1, `the app exits with code 1 (got ${unmarked.code})`)
  assert.match(unmarked.output, /the profile carries no run marker/)
  assert.deepEqual(readdirSync(held).sort(), before)
  assert.deepEqual(requests, [])
  console.log('PASS refused: a marker variable without the profile\'s marker file exits 1 the same way')

  // 2. The harness's own profile: the app starts and the live-service stand-in receives the request.
  const harnessProfile = join(scratch, 'harness-profile')
  const env = { ...baseEnv, ...testProfileEnv(harnessProfile) }
  app = await electron.launch({ args: ['.', '--use-mock-keychain', `--user-data-dir=${harnessProfile}`], cwd: root, env, timeout: 60_000 })
  const status = await app.evaluate(async () => (await fetch('https://talkweaver-live-sessions.fixture.workers.dev/computers')).status)
  assert.equal(status, 200)
  assert.deepEqual(requests.filter((r) => r.url === '/computers'), [{ url: '/computers', host: 'talkweaver-live-sessions.fixture.workers.dev' }], 'the stand-in got the request, with the address it meant')
  assert.ok(readFileSync(join(harnessProfile, 'tw-e2e-profile-marker'), 'utf8').length > 0)
  console.log('PASS granted: on the harness profile the app starts and a workers.dev request reaches the stand-in')
} finally {
  if (app) await app.close().catch(() => {})
  listener.close()
  rmSync(scratch, { recursive: true, force: true })
}
