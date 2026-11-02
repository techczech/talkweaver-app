// Large handout uploads (src/main/wrangler-launcher.ts). A 78 MiB site took 396 seconds to upload, and it
// needed two things the app's default did not give: a longer time limit for the process, and a longer
// wait in wrangler's own HTTP client, whose default gives up after 300 seconds without an answer.
// Checked with the REAL bundled wrangler in a REAL subprocess, against the stand-in API on loopback with a
// made-up token (nothing leaves this computer), under Node and under the real Electron executable:
//   1. the launch: `pages deploy` alone gets the allowance, as an inline `--import` the app owns;
//   2. every request of the real tool carries it, on the tool's own HTTP client;
//   3. that field is what its HTTP client really waits on: with the same module and a short value it
//      gives up, on the answer's start and half way through its body; with the real value it waits;
//   4. nothing inherited reaches it: NODE_OPTIONS is dropped and cannot be set, on every command;
//   5. the process's time limit is the longer one for `pages deploy` only, and the stop is the same stop.
// The same thing at the real length (over 300 seconds) is scripts/prove-pages-upload-transport.mjs.
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as launcher from '../src/main/wrangler-launcher.ts'
import { pagesDeployArgs, startPagesUploadStandIn, transportSeen } from './lib/pages-upload-stand-in.mjs'

const { TRACE_FILE_VARIABLE, WRANGLER_TIMED_OUT_MESSAGE, WRANGLER_TIME_LIMIT_MS, WRANGLER_KILL_GRACE_MS, prepareWranglerWorkDir, resolveWranglerLaunch, runWrangler, startWranglerProcess } = launcher
const HTTP_MS = 1_200_000
const SHORT_MS = 700
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = join(repo, 'scripts/lib/pages-transport-probe.cjs')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-pages-upload-')))
const OBSERVED_UPLOAD_MS = 396_340
let passed = 0
const failed = []
const test = async (name, work) => {
  try { await work(); passed += 1; console.log(`  ok  ${name}`) } catch (error) { failed.push(name); console.error(`  FAIL ${name}\n       ${String(error?.message ?? error).split('\n').slice(0, 4).join('\n       ')}`) }
}
console.log('pages upload: the allowance reaches the real tool')

const electronPath = (() => { try { return createRequire(import.meta.url)('electron') } catch { return null } })()
const runners = [['Node', process.execPath], ...(typeof electronPath === 'string' && existsSync(electronPath) ? [['Electron', electronPath]] : [])]
const installFor = (execPath, name) => ({ execPath, appRoot: repo, platform: process.platform, workDir: join(scratch, `runs-${name}`) })
const transportArgs = (args) => {
  const before = args.slice(0, args.findIndex((arg) => arg.endsWith('cli.js')))
  return before.filter((arg, index) => before[index - 1] === '--import' && arg.includes('diagnostics_channel'))
}

// A real run through `runWrangler`, with the probe beside it: `shorten` swaps the allowance in the launch for a short one.
async function realDeploy(execPath, { name, standIn, shorten, inherited = {}, timeoutMs }) {
  const install = installFor(execPath, name)
  const trace = join(scratch, `${name}.jsonl`)
  const started = Date.now()
  const run = await runWrangler(install, pagesDeployArgs(scratch), {
    inherited, set: standIn.credentials, ...(timeoutMs ? { timeoutMs } : {}),
    start: (launch) => {
      prepareWranglerWorkDir(install)
      const args = shorten ? launch.args.map((arg) => arg.replaceAll(String(HTTP_MS), String(SHORT_MS))) : launch.args
      return startWranglerProcess({ ...launch, args: [args[0], '--require', probe, ...args.slice(1)], env: { ...launch.env, [TRACE_FILE_VARIABLE]: trace } }, install.platform)
    },
  })
  return { run, seen: transportSeen(trace), ms: Date.now() - started }
}

const pagesArgs = ['pages', 'deploy', '/site', '--project-name', 'talks', '--branch', 'main', '--commit-dirty=true']
const packaged = {
  mac: { execPath: '/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver', appRoot: '/Applications/TalkWeaver.app/Contents/Resources/app', platform: 'darwin', workDir: '/Users/ada/Library/Application Support/TalkWeaver/wrangler-runs', exists: () => true },
  windows: { execPath: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\TalkWeaver\\TalkWeaver.exe', appRoot: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\TalkWeaver\\resources\\app', platform: 'win32', workDir: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\TalkWeaver\\wrangler-runs', exists: () => true },
}

try {
  await test('the policy: finite, and longer than the upload that was seen', () => {
    assert.equal(launcher.PAGES_UPLOAD_HTTP_TIMEOUT_MS, HTTP_MS)
    const limit = launcher.PAGES_UPLOAD_TIME_LIMIT_MS
    assert.ok(Number.isFinite(limit) && limit > OBSERVED_UPLOAD_MS, 'over the 396.34 seconds a 78 MiB site took')
    assert.ok(limit > HTTP_MS, 'over one HTTP wait, so a stalled request ends as an error of the tool, which retries it, and not as a kill')
    assert.equal(launcher.wranglerTimeLimitMs(pagesArgs), limit)
    assert.equal(WRANGLER_TIME_LIMIT_MS, 180_000, 'every other command keeps its limit')
  })

  await test('the launch: pages deploy alone, as an inline module the app owns, on macOS and Windows', () => {
    for (const [name, install] of Object.entries(packaged)) {
      const { launch } = resolveWranglerLaunch(install, pagesArgs, { inherited: {}, set: {} })
      const modules = transportArgs(launch.args)
      assert.equal(modules.length, 1, `${name}: one module`)
      const [module] = modules
      assert.match(module, /^data:text\/javascript,/, `${name}: inline, so there is no file to find, swap or carry out of the asar`)
      assert.ok(decodeURIComponent(module).includes(`${HTTP_MS}`), `${name}: it carries the allowance`)
      assert.doesNotMatch(module, /["'\s\\]/, `${name}: nothing Windows quoting could change`)
      const entry = launch.args.findIndex((arg) => arg.endsWith('cli.js'))
      assert.ok(launch.args.indexOf(module) < entry, `${name}: before wrangler loads`)
      assert.ok(launch.args.includes('data:text/javascript,process.defaultApp=true'), `${name}: the argv correction stays`)
      assert.deepEqual(Object.keys(launch.env).filter((key) => /^NODE_/i.test(key)), [], `${name}: nothing goes by NODE_OPTIONS or any NODE_ variable`)
    }
    const others = [['--version'], ['deploy', '/x'], ['dev'], ['pages', 'project', 'list'], ['pages', 'deployment', 'list'], ['pages'], ['r2', 'pages', 'deploy']]
    for (const args of others) {
      for (const install of Object.values(packaged)) {
        const { launch } = resolveWranglerLaunch(install, args, { inherited: {}, set: {} })
        assert.deepEqual(transportArgs(launch.args), [], `${args.join(' ')}: no allowance`)
        assert.equal(launcher.wranglerTimeLimitMs(args), WRANGLER_TIME_LIMIT_MS, `${args.join(' ')}: the ordinary limit`)
      }
    }
  })

  for (const [name, execPath] of runners) {
    await test(`${name}: every request of a real deploy carries the allowance on the tool's own HTTP client`, async () => {
      const standIn = await startPagesUploadStandIn()
      try {
        const { run, seen } = await realDeploy(execPath, { name: `carry-${name}`, standIn })
        assert.equal(run.ok, true, `${run.stdout}\n${run.stderr}`)
        assert.ok(seen.some((request) => request.path.endsWith('/pages/assets/upload')), `the upload is among them: ${JSON.stringify(seen)}`)
        for (const request of seen) assert.deepEqual([request.path, request.headersTimeout, request.bodyTimeout], [request.path, HTTP_MS, HTTP_MS])
      } finally { await standIn.stop() }
    })
  }

  await test('the field is what the tool waits on: the same module with a short value gives up on an answer that has not begun', async () => {
    const standIn = await startPagesUploadStandIn({ mode: 'headers', hold: 1, holdMs: 2_500 })
    try {
      const { run } = await realDeploy(process.execPath, { name: 'short-headers', standIn, shorten: true })
      assert.equal(run.ok, true, `its own retry finishes the upload\n${run.stdout}\n${run.stderr}`)
      assert.equal(standIn.uploads.length, 2, 'it gave up and sent the upload again')
      const gaveUp = standIn.uploads[0].gaveUpAfterMs
      assert.ok(gaveUp !== null && gaveUp >= SHORT_MS - 200 && gaveUp < 2_400, `gave up after ${gaveUp} ms`)
    } finally { await standIn.stop() }
  })

  await test('and on an answer that stops half way', async () => {
    const standIn = await startPagesUploadStandIn({ mode: 'body', hold: 1, holdMs: 2_500 })
    try {
      const { run } = await realDeploy(process.execPath, { name: 'short-body', standIn, shorten: true })
      assert.equal(run.ok, true, `its own retry finishes the upload\n${run.stdout}\n${run.stderr}`)
      assert.equal(standIn.uploads.length, 2)
      assert.ok(standIn.uploads[0].gaveUpAfterMs !== null && standIn.uploads[0].gaveUpAfterMs < 2_400, `gave up after ${standIn.uploads[0].gaveUpAfterMs} ms`)
    } finally { await standIn.stop() }
  })

  await test('with the real value it waits for the same late answers', async () => {
    for (const mode of ['headers', 'body']) {
      const standIn = await startPagesUploadStandIn({ mode, hold: 1, holdMs: 2_500 })
      try {
        const { run } = await realDeploy(process.execPath, { name: `real-${mode}`, standIn })
        assert.equal(run.ok, true, `${run.stdout}\n${run.stderr}`)
        assert.equal(standIn.uploads.length, 1, `${mode}: one upload, nothing resent`)
        assert.equal(standIn.uploads[0].gaveUpAfterMs, null, `${mode}: never given up on`)
      } finally { await standIn.stop() }
    }
  })

  await test('an inherited NODE_OPTIONS reaches no run, and a call cannot set one', async () => {
    const planted = join(scratch, 'planted-marker')
    const plant = join(scratch, 'planted.cjs')
    writeFileSync(plant, `require('node:fs').writeFileSync(${JSON.stringify(planted)}, 'ran')\n`)
    const standIn = await startPagesUploadStandIn()
    try {
      for (const [name, execPath] of runners) {
        const { run, seen } = await realDeploy(execPath, { name: `planted-${name}`, standIn, inherited: { NODE_OPTIONS: `--require ${plant}`, NODE_PATH: scratch, HTTP_TIMEOUT: '1' } })
        assert.equal(run.ok, true, `${run.stdout}\n${run.stderr}`)
        assert.equal(existsSync(planted), false, `${name}: the planted module did not run`)
        assert.ok(seen.length && seen.every((request) => request.headersTimeout === HTTP_MS), `${name}: and the allowance is the app's`)
      }
    } finally { await standIn.stop() }
    assert.throws(() => resolveWranglerLaunch(packaged.mac, pagesArgs, { inherited: {}, set: { NODE_OPTIONS: '--require /x' } }), /cannot be set/)
  })

  await test('the process limit: pages deploy runs past three minutes, then stops the same way; another command does not', async () => {
    class FakeChild extends EventEmitter {
      stdout = new EventEmitter(); stderr = new EventEmitter(); stdin = Object.assign(new EventEmitter(), { end() {} }); signals = []
      kill(signal) { this.signals.push(signal); return true }
    }
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const child = new FakeChild()
      const install = { ...packaged.mac, exists: () => true }
      let answer = null
      void runWrangler(install, pagesArgs, { inherited: {}, start: () => child }).then((run) => { answer = run })
      mock.timers.tick(OBSERVED_UPLOAD_MS)
      await Promise.resolve()
      assert.deepEqual(child.signals, [], 'still running at 396.34 seconds')
      assert.equal(answer, null)
      mock.timers.tick(launcher.PAGES_UPLOAD_TIME_LIMIT_MS - OBSERVED_UPLOAD_MS)
      assert.deepEqual(child.signals, ['SIGTERM'], 'at the limit it is asked to stop')
      mock.timers.tick(WRANGLER_KILL_GRACE_MS)
      assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'], 'then killed')
      child.emit('exit', null)
      child.emit('close', null)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(answer.timedOut, true)
      assert.ok(answer.stderr.endsWith(WRANGLER_TIMED_OUT_MESSAGE))

      const other = new FakeChild()
      void runWrangler(install, ['--version'], { inherited: {}, start: () => other })
      mock.timers.tick(WRANGLER_TIME_LIMIT_MS)
      assert.deepEqual(other.signals, ['SIGTERM'], 'any other command stops at three minutes')
      mock.timers.tick(WRANGLER_KILL_GRACE_MS)
      other.emit('exit', null)
      other.emit('close', null)
    } finally { mock.timers.reset() }
  })

  await test('a real pages deploy still ends at a limit: the group is stopped and the run answered', async () => {
    const standIn = await startPagesUploadStandIn({ mode: 'headers', hold: 5, holdMs: 30_000 })
    try {
      const { run, ms } = await realDeploy(process.execPath, { name: 'stopped', standIn, timeoutMs: 6_000 })
      assert.equal(run.ok, false)
      assert.equal(run.timedOut, true, `${run.stdout}\n${run.stderr}`)
      assert.ok(ms < 20_000, `answered after ${ms} ms`)
    } finally { await standIn.stop() }
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`pages upload: ${passed} checks passed, ${failed.length} failed (${runners.map(([name]) => name).join(', ')})`)
if (failed.length) process.exit(1)
