// A real editor action queues thumbnail work; native Quit must save it, destroy every helper,
// and reach normal process exit after one request. TW_QUIT_REPEATS=10 TW_QUIT_MATRIX=1 runs the release matrix.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openTalkByTitle } from './lib/talklist.mjs'
import { typeAtOutlineLineEnd } from './lib/outline-typing.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { buildNativeQuitMenu } from './lib/native-quit-menu.mjs'
import { quitProcessTree, readQuitProcesses, sampleQuitProcesses } from '../scripts/lib/quit-process-samples.mjs'

const repo = resolve(import.meta.dirname, '..')
const evidence = join(repo, 'artefacts/quit-helpers')
mkdirSync(evidence, { recursive: true })
const interactiveQuitLimitMs = 2000
const repeats = Number(process.env.TW_QUIT_REPEATS ?? 1)
assert.ok(Number.isInteger(repeats) && repeats > 0)
const scenarios = (process.env.TW_QUIT_SCENARIOS ?? (process.env.TW_QUIT_MATRIX === '1' ? 'typing,move,move-undo,autosave,browser' : 'move,edit,browser')).split(',')
const routes = (process.env.TW_QUIT_ROUTES ?? (process.env.TW_QUIT_MATRIX === '1' ? 'quit,close' : 'quit')).split(',')
const scratch = mkdtempSync(join(evidence, 'runtime-'))
const report = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), cases: [], cleanup: [] }
const reportPath = join(evidence, `shutdown${process.env.TW_QUIT_LABEL ?? ''}.json`)
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const authored = text => text.split('\n').filter(line => !/^\s*\{id=[^}]+\}\s*$/.test(line)).join('\n')
const lifecycle = userData => {
  try { return readFileSync(join(userData, 'quit-lifecycle.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) } catch { return [] }
}
async function waitFor(predicate, message, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await predicate()) return; await sleep(25) }
  throw Error(message)
}
const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
const sockets = new Set()
let app, proc, userData
function detachAfterTerminalQuit(handle, owned) {
  if (owned.exitCode !== null || owned.signalCode !== null) return
  assert.ok(lifecycle(userData).some(event => event.type === 'quit' && event.exitCode === 0 && event.windows === 0))
  // Playwright 1.60's close() first awaits another app.quit() RPC. Electron has already quit,
  // so that RPC can wait on the debugger it would close afterwards. Release this test app's
  // Node transport directly, only AFTER terminal quit; no quit request, exit or signal is added.
  const implementation = handle._connection.toImpl(handle)
  assert.equal(implementation.process(), owned, 'detach only the process this test launched')
  implementation._nodeConnection.close()
}
async function cleanup() {
  if (!proc) return
  const owned = proc, handle = app
  let forced = false, detached = false
  if (owned.exitCode === null && owned.signalCode === null) {
    void handle.evaluate(({ app }) => app.quit()).catch(() => {})
    try {
      await waitFor(() => {
        if (owned.exitCode !== null || owned.signalCode !== null) return true
        // Electron can emit quit then wait for the Playwright debugger. Detach only after
        // that terminal event, so debugger teardown cannot conceal a product hang.
        if (!detached && lifecycle(userData).some(event => event.type === 'quit' && event.exitCode === 0 && event.windows === 0)) {
          detached = true
          detachAfterTerminalQuit(handle, owned)
          void handle.close().catch(() => {})
        }
        return false
      }, 'Owned test process did not stop during cleanup', 5000)
    } catch {
      forced = true
      owned.kill('SIGKILL')
      await waitFor(() => owned.exitCode !== null || owned.signalCode !== null, 'Owned test process survived SIGKILL', 5000)
    }
  }
  report.cleanup.push({ pid: owned.pid, forced, exitCode: owned.exitCode, signal: owned.signalCode })
  await Promise.race([handle.close().catch(() => {}), sleep(2000)])
  proc = null; app = null
}

try {
  await ensureFreshBuild(repo)
  const addon = buildNativeQuitMenu(scratch)
  for (const scenario of scenarios) for (const route of routes) for (let repeat = 1; repeat <= repeats; repeat++) {
    const root = join(scratch, String(report.cases.length))
    const vault = join(root, 'vault'), delay = join(root, 'save-delay')
    userData = join(root, 'userData')
    mkdirSync(userData, { recursive: true })
    cpSync(join(repo, 'resources/example-vault'), vault, { recursive: true })
    const outline = join(vault, 'garden-notes/garden-notes-outline.md')
    if (scenario === 'move-undo') writeFileSync(outline, readFileSync(outline, 'utf8').replace('{id=g1}\n', ''))
    writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, openInView: 'outline' }))
    const disk = () => readFileSync(outline, 'utf8')
    const original = disk(), marker = ` QUIT_HELPERS_${scenario}_${route}_${repeat}`
    const record = { scenario, route, repeat, pass: false }
    report.cases.push(record)
    let expectedOutline, samplingTimer, samples, saveBegan = null
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], cwd: repo,
        env: { ...env, TW_UPDATE_TEST_SAVE_DELAY_FILE: delay } })
      proc = app.process(); record.pid = proc.pid
      let exitedAt = null
      proc.once('exit', () => { exitedAt = Date.now() })
      proc.stdout?.on('data', bytes => { if (bytes.toString().includes('[update-test] this save waits 1500 ms')) saveBegan = Date.now() })
      try { const socket = readlinkSync(join(userData, 'SingletonSocket')); if (/\/scoped_dir[^/]+\/SingletonSocket$/.test(socket)) sockets.add(dirname(socket)) } catch {}
      const runtime = await app.evaluate(({ app, BrowserWindow }) => ({ version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), hidden: BrowserWindow.getAllWindows().every(w => !w.isVisible()) }))
      record.runtime = runtime
      assert.equal(runtime.version, JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version)
      assert.equal(runtime.appPath, repo); assert.equal(runtime.userData, userData); assert.equal(runtime.hidden, true)
      const page = await app.firstWindow(); page.setDefaultTimeout(12000)
      let crashed = false
      page.once('crash', () => { crashed = true })
      await app.evaluate((_, repo) => process.getBuiltinModule('module').createRequire(repo + '/package.json')(repo + '/e2e/lib/quit-lifecycle.cjs'), repo)
      await openTalkByTitle(page, 'Garden notes'); await page.locator('.cm-content').waitFor()
      const text = () => page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())
      if (scenario === 'move' || scenario === 'move-undo') {
        await page.getByTestId('grid-toggle').click()
        const cards = page.locator('.grid-view .grid-cell[draggable="true"]')
        const from = cards.filter({ hasText: 'Where the plot is' }).first(), to = cards.filter({ hasText: 'What we grow' }).first()
        await from.waitFor(); await from.scrollIntoViewIfNeeded()
        await page.evaluate(([from, to]) => {
          const dataTransfer = new DataTransfer()
          for (const [element, type] of [[from, 'dragstart'], [to, 'dragenter'], [to, 'dragover'], [to, 'drop'], [from, 'dragend']]) {
            element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }))
          }
        }, [await from.elementHandle(), await to.elementHandle()])
        await waitFor(() => disk().indexOf('### Where the plot is') > disk().indexOf('### What we grow'), 'Move did not persist')
        if (scenario === 'move-undo') {
          await page.locator('.grid-view').focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
          await waitFor(() => disk().indexOf('### Where the plot is') < disk().indexOf('### What we grow'), 'Undo did not persist')
        }
        await page.getByTestId('outline-toggle').click()
      } else if (scenario === 'browser') {
        await (await app.browserWindow(page)).evaluate(w => w.webContents.send('app:run-command', 'search'))
        await page.locator('.lt').waitFor()
      } else {
        if (scenario === 'autosave') writeFileSync(delay, '1500')
        await typeAtOutlineLineEnd(page, 'Behind the station, through the green gate.', marker)
        if (scenario === 'autosave') {
          await waitFor(() => saveBegan !== null, 'No autosave began')
          assert.ok(Date.now() - saveBegan < 1400); assert.equal(disk().includes(marker), false)
        }
        // Exercise the edit's queued picture render as well as the ordinary typing/close save.
        if (scenario === 'edit') await waitFor(() => disk().includes(marker), 'Edit did not persist')
      }
      const held = await text()
      expectedOutline = Buffer.from(held, 'utf8')
      if (scenario === 'move-undo') {
        // Undo restores the unstamped editor text. Its save keeps the slide ID on disk,
        // and the editor does not adopt that save while redo is available.
        assert.equal(authored(held), authored(original), 'Undo must restore the authored buffer')
        expectedOutline = readFileSync(outline)
        assert.equal(authored(expectedOutline.toString('utf8')), authored(original), 'Undo must be persisted before shutdown')
      }
      let closed = false
      page.once('close', () => { closed = true })
      const sampleOnMac = route === 'quit' && process.platform === 'darwin'
      // Keep the original tree so helpers that get reparented during Quit are still identified.
      const beforeQuit = sampleOnMac ? await readQuitProcesses()
        .then(listing => quitProcessTree(listing, proc.pid, userData))
        .catch(error => { record.processSnapshotError = error.message; return [] }) : []
      const start = Date.now()
      record.routeStarted = start
      if (sampleOnMac) {
        samplingTimer = setTimeout(() => {
          if (proc.exitCode !== null || proc.signalCode !== null) return
          const pid = proc.pid
          const profile = userData
          const prefix = `${basename(scratch)}-${scenario}-${route}-${repeat}`
          samples = readQuitProcesses()
            .then(listing => sampleQuitProcesses(quitProcessTree(listing, pid, profile, beforeQuit), evidence, prefix))
            .then(results => {
              record.samples = results
              for (const { pid, file, error } of results) {
                console.error(`Quit missed ${interactiveQuitLimitMs} ms: PID ${pid} — ${file ?? error}`)
              }
            })
            .catch(error => {
              record.sampleError = error.message
              console.error(`Quit process samples unavailable: ${error.message}`)
            })
        }, interactiveQuitLimitMs)
      }
      let quitRequestError
      if (route === 'quit') {
        // The native action can close Playwright before the trigger RPC replies. The owned
        // process and its lifecycle trace are the completion signal.
        void app.evaluate(({ Menu, app }, { repo, userData, addon, pid }) => {
          if (app.getAppPath() !== repo || app.getPath('userData') !== userData) throw Error('Wrong test app/profile')
          const group = Menu.getApplicationMenu().items.find(i => i.submenu?.items.some(j => j.role === 'quit'))
          const item = group?.submenu.items.find(i => i.role === 'quit')
          if (!item?.enabled) throw Error('Application Quit item missing or disabled')
          const { appendFileSync } = process.getBuiltinModule('fs')
          if (addon) process.getBuiltinModule('module').createRequire(repo + '/package.json')(addon).clickQuit(pid, item.label)
          else setImmediate(() => item.click())
          appendFileSync(userData + '/quit-lifecycle.jsonl', JSON.stringify({ type: 'menu:quit', at: Date.now(), label: item.label }) + '\n')
        }, { repo, userData, addon, pid: proc.pid }).catch(error => {
          quitRequestError = error
          record.quitRequestError = error.message
        })
      } else await (await app.browserWindow(page)).evaluate(w => w.close())
      await waitFor(() => {
        if (route === 'close') return closed
        const events = lifecycle(userData)
        if (quitRequestError && !events.some(event => event.type === 'menu:quit')) throw quitRequestError
        if (events.some(event => event.type === 'quit')) return true
        if (exitedAt !== null) throw Error(`Process exited without terminal Quit (code ${proc.exitCode}, signal ${proc.signalCode})`)
        return false
      }, 'No terminal quit within five seconds', 5000)
      record.lifecycle = lifecycle(userData)
      if (route === 'quit') {
        const requests = record.lifecycle.filter(event => event.type === 'menu:quit')
        assert.equal(requests.length, 1, 'Exactly one native Quit was scheduled')
        record.menuLabel = requests[0].label
        const terminal = record.lifecycle.find(event => event.type === 'quit')
        assert.equal(terminal.exitCode, 0); assert.equal(terminal.windows, 0)
        const beginning = record.lifecycle.findIndex(event => event.type === 'before-quit')
        assert.ok(beginning >= 0, 'Native Quit entered before-quit')
        assert.equal(record.lifecycle.slice(beginning + 1).filter(event => event.type === 'window:created').length, 0,
          'No helper may be created after Quit begins')
        record.terminalMilliseconds = terminal.at - start
        assert.ok(record.terminalMilliseconds < 5000)
        detachAfterTerminalQuit(app, proc)
        await waitFor(() => exitedAt !== null, 'No process exit after the first Quit request', 5000)
        record.exitCode = proc.exitCode
        record.signal = proc.signalCode
        assert.equal(record.exitCode, 0); assert.equal(record.signal, null)
        record.milliseconds = exitedAt - start
        if (['move', 'edit', 'browser'].includes(scenario)) {
          assert.ok(record.milliseconds < interactiveQuitLimitMs,
            `First Quit after ${scenario} must reach OS exit within ${interactiveQuitLimitMs} ms, took ${record.milliseconds} ms`)
        }
      } else record.milliseconds = Date.now() - start
      assert.equal(crashed, false)
      assert.ok(readFileSync(outline).equals(expectedOutline), 'The saved outline must match the expected bytes')
      record.savedOnDisk = true; record.pass = true
      console.log(`PASS ${scenario} ${route} ${repeat}/${repeats}: ${record.milliseconds} ms`)
    } catch (error) {
      record.error = error.stack
      record.lifecycle = lifecycle(userData)
      if (expectedOutline !== undefined) record.savedOnDisk = readFileSync(outline).equals(expectedOutline)
      if (app && proc?.exitCode === null && proc.signalCode === null) {
        record.windows = await Promise.race([app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ id: w.id, visible: w.isVisible(), url: w.webContents.getURL() }))).catch(() => null), sleep(1000).then(() => null)])
      }
      console.error(`FAIL ${scenario} ${route} ${repeat}/${repeats}: ${error.message}`)
    } finally {
      clearTimeout(samplingTimer)
      await samples
      await cleanup()
      save()
    }
  }
} finally {
  await cleanup()
  rmSync(scratch, { recursive: true, force: true })
  for (const socket of sockets) rmSync(socket, { recursive: true, force: true })
  report.scratchRemoved = true
  save()
}
const passed = report.cases.filter(record => record.pass).length
console.log(`Shutdown: ${passed}/${report.cases.length}; forced cleanup: ${report.cleanup.filter(c => c.forced).length}`)
process.exitCode = passed === repeats * scenarios.length * routes.length && report.cleanup.every(c => !c.forced && c.exitCode === 0 && c.signal === null) ? 0 : 1
