// Overlapping wrangler runs share one run folder. The files the app keeps there for wrangler
// (wrangler.json, .wrangler/deploy/config.json, package.json, tsconfig.json, the empty env file) must never be
// missing or half-written while another wrangler reads them: the launcher writes each once and
// afterwards leaves it alone (src/main/wrangler-launcher.ts, `prepareWranglerWorkDir`).
//
// 20 rounds; in each, three commands are prepared and started while the others are still running:
// two `pages deploy` (which read all of the stand-ins) and one `secret bulk`, all against the local
// stand-in for the Cloudflare API (scripts/lib/cloudflare-api-stub.mjs; nothing leaves the machine).
// Every command must finish as it does alone. Whether a command happens to read a file in the very
// millisecond it is being replaced is luck, so a second process does nothing but read the five
// stand-ins over and over for the whole test and reports the first time one is missing or holds
// anything but the expected bytes: that is the assertion that does not depend on timing.
// Integration tier: run by name (about half a minute) and
// in the "Packaged builds" workflow on macOS and Windows; not part of `npm test`.
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveWorkerDeployConfig } from '../src/main/live-worker-deploy-config.ts'
import { prepareWranglerRun, wranglerRunFolder } from '../src/main/wrangler-launcher.ts'
import { startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'

const ROUNDS = 20
const started = Date.now()
const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-wrangler-overlap-')))
const userData = join(scratch, 'user-data')
const install = { execPath: process.execPath, appRoot: repo, platform: process.platform, workDir: join(userData, 'wrangler-runs') }
const siteDir = join(userData, 'site')
const config = join(install.workDir, 'live-worker-wrangler.generated.jsonc')

function run(args, set, input = '') {
  // Prepared here, at the moment of starting, so that it happens while earlier commands still run.
  const resolved = prepareWranglerRun(install, args, { inherited: process.env, set })
  assert.equal(resolved.ok, true)
  const { command, args: argv, env, cwd } = resolved.launch
  return new Promise((resolveRun) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let said = ''
    child.stdout.on('data', (chunk) => { said += String(chunk) })
    child.stderr.on('data', (chunk) => { said += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (status) => { clearTimeout(timer); resolveRun({ status, said }) })
    child.stdin.end(input)
  })
}
const soon = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

const stub = await startCloudflareApiStub()
try {
  mkdirSync(siteDir, { recursive: true })
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>Overlap</title>')
  mkdirSync(install.workDir, { recursive: true })
  writeFileSync(config, JSON.stringify(liveWorkerDeployConfig(readFileSync(join(repo, 'worker', 'wrangler.jsonc'), 'utf8'), join(repo, 'worker'), null)))
  const set = { CLOUDFLARE_API_TOKEN: 'overlap-test-token', CLOUDFLARE_ACCOUNT_ID: 'overlap0account', CLOUDFLARE_API_BASE_URL: stub.baseUrl }
  const pages = ['pages', 'deploy', siteDir, '--project-name', 'talks', '--branch', 'main', '--commit-dirty=true']
  const folder = wranglerRunFolder(install)
  const expected = { [folder.envFile]: '', [folder.pagesConfigStub]: '{}\n', [folder.pagesRedirect]: '{ "configPath": "../../wrangler.json" }\n', [folder.packageJson]: '{ "private": true }\n', [folder.tsconfig]: '{}\n' }

  // The reader: started once the files exist, stopped at the end; any line it prints is a failure.
  prepareWranglerRun(install, ['--version'])
  const reader = spawn(process.execPath, ['-e', `
    const fs = require('fs'); const expected = ${JSON.stringify(expected)}; let reads = 0
    const pause = new Int32Array(new SharedArrayBuffer(4))
    process.on('SIGTERM', () => { console.log('reads ' + reads); process.exit(0) })
    process.stdin.on('end', () => { console.log('reads ' + reads); process.exit(0) }).resume()
    const loop = () => {
      for (let i = 0; i < 200; i++) {
        for (const [path, bytes] of Object.entries(expected)) {
          let seen; try { seen = fs.readFileSync(path, 'utf8') } catch (error) { seen = 'MISSING ' + error.code }
          reads++
          if (seen !== bytes) { console.log('SAW ' + JSON.stringify({ path, seen })); process.exit(1) }
        }
        Atomics.wait(pause, 0, 0, 0.2)
      }
      setImmediate(loop)
    }
    loop()`], { stdio: ['pipe', 'pipe', 'inherit'] })
  let readerSaid = ''
  reader.stdout.on('data', (chunk) => { readerSaid += String(chunk) })
  const readerDone = new Promise((resolveReader) => reader.on('close', resolveReader))

  for (let round = 1; round <= ROUNDS; round++) {
    // Staggered by a little more each round, so the second and third preparation land at different
    // points of the first command's start-up (when it reads the stand-ins).
    const first = run(pages, set)
    await soon(5 + round * 12)
    const second = run(pages, set)
    await soon(5 + round * 5)
    const third = run(['secret', 'bulk', '--config', config], set, JSON.stringify({ ADMIN_SECRET: 'overlap-admin', SESSION_SIGNING_SECRET: 'overlap-signing' }))
    const results = await Promise.all([first, second, third])
    for (const [index, name] of ['pages deploy (first)', 'pages deploy (second)', 'secret bulk'].entries()) {
      const { status, said } = results[index]
      assert.equal(status, 0, `round ${round}: ${name} failed while another command was being prepared\n${said}`)
      assert.ok(!/Failed to parse|is not valid|does not exist|Unexpected end|ENOENT|EBUSY|EPERM/.test(said), `round ${round}: ${name} met a missing or partial file\n${said}`)
    }
    assert.match(results[0].said, /Deployment complete/)
    assert.match(results[1].said, /Deployment complete/)
    assert.match(results[2].said, /2 secrets successfully created/)
    for (const [path, bytes] of Object.entries(expected)) assert.equal(readFileSync(path, 'utf8'), bytes, `round ${round}: ${path} holds exactly what the app wrote`)
  }
  reader.stdin.end()
  await readerDone
  assert.ok(!readerSaid.includes('SAW'), `a reader saw a stand-in missing or with other bytes: ${readerSaid}`)
  const reads = Number(/reads (\d+)/.exec(readerSaid)?.[1] ?? 0)
  assert.ok(reads > 10_000, `the reader was reading throughout (${reads} reads)`)
  console.log(`wrangler overlap: ${ROUNDS} rounds of two pages deploys and a secret bulk prepared and run on top of each other, ${ROUNDS * 3} commands, all finished as they do alone; a constant reader (${reads} reads) never saw a stand-in missing or partial — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
} finally {
  await stub.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}
