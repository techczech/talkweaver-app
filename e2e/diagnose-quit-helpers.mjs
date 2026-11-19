// A real editor action queues thumbnail work; native Quit must save it, destroy every helper,
// and reach Electron's terminal quit event. TW_QUIT_REPEATS=10 TW_QUIT_MATRIX=1 runs the release matrix.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openTalkByTitle } from './lib/talklist.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { buildNativeQuitMenu } from './lib/native-quit-menu.mjs'

const repo = resolve(import.meta.dirname, '..')
const evidence = join(repo, 'artefacts/quit-helpers')
mkdirSync(evidence, { recursive: true })
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
    writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'plain' }))
    const disk = () => readFileSync(outline, 'utf8')
    const original = disk(), marker = ` QUIT_HELPERS_${scenario}_${route}_${repeat}`
    const record = { scenario, route, repeat, pass: false }
    report.cases.push(record)
    let held, saveBegan = null
    try {
      app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], cwd: repo,
        env: { ...env, TW_UPDATE_TEST_SAVE_DELAY_FILE: delay } })
      proc = app.process(); record.pid = proc.pid
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
        await page.locator('.pane-btn[title="Grid"]').click()
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
        await page.locator('.pane-btn[title="Slides"]').click()
      } else if (scenario === 'browser') {
        await (await app.browserWindow(page)).evaluate(w => w.webContents.send('app:run-command', 'search'))
        await page.locator('.lt').waitFor()
      } else {
        if (scenario === 'autosave') writeFileSync(delay, '1500')
        await page.locator('.cm-content .cm-line', { hasText: 'Behind the station, through the green gate.' }).first().click()
        await page.keyboard.press('End'); await page.keyboard.type(marker)
        if (scenario === 'autosave') {
          await waitFor(() => saveBegan !== null, 'No autosave began')
          assert.ok(Date.now() - saveBegan < 1400); assert.equal(disk().includes(marker), false)
        }
        // Exercise the edit's queued picture render as well as the ordinary typing/close save.
        if (scenario === 'edit') await waitFor(() => disk().includes(marker), 'Edit did not persist')
      }
      held = await text()
      let closed = false
      page.once('close', () => { closed = true })
      const start = Date.now()
      record.routeStarted = start
      if (route === 'quit') {
        record.menuLabel = await app.evaluate(({ Menu, app }, { repo, userData, addon, pid }) => {
          if (app.getAppPath() !== repo || app.getPath('userData') !== userData) throw Error('Wrong test app/profile')
          const group = Menu.getApplicationMenu().items.find(i => i.submenu?.items.some(j => j.role === 'quit'))
          const item = group?.submenu.items.find(i => i.role === 'quit')
          if (!item?.enabled) throw Error('Application Quit item missing or disabled')
          const { appendFileSync } = process.getBuiltinModule('fs')
          appendFileSync(userData + '/quit-lifecycle.jsonl', JSON.stringify({ type: 'menu:quit', at: Date.now(), label: item.label }) + '\n')
          if (addon) return process.getBuiltinModule('module').createRequire(repo + '/package.json')(addon).clickQuit(pid, item.label)
          setImmediate(() => item.click()); return item.label
        }, { repo, userData, addon, pid: proc.pid })
      } else await (await app.browserWindow(page)).evaluate(w => w.close())
      await waitFor(() => route === 'close' ? closed : lifecycle(userData).some(event => event.type === 'quit'), 'No terminal quit within five seconds', 5000)
      record.lifecycle = lifecycle(userData)
      if (route === 'quit') {
        const terminal = record.lifecycle.find(event => event.type === 'quit')
        assert.equal(terminal.exitCode, 0); assert.equal(terminal.windows, 0)
        const beginning = record.lifecycle.findIndex(event => event.type === 'before-quit')
        assert.ok(beginning >= 0, 'Native Quit entered before-quit')
        assert.equal(record.lifecycle.slice(beginning + 1).filter(event => event.type === 'window:created').length, 0,
          'No helper may be created after Quit begins')
        record.milliseconds = terminal.at - start
        assert.ok(record.milliseconds < 5000)
        // Assert persistence before releasing the debugger transport.
        assert.equal(authored(disk()), authored(held))
        detachAfterTerminalQuit(app, proc)
        void app.close().catch(() => {})
        await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 'Debugger did not detach after terminal quit', 5000)
        assert.equal(proc.exitCode, 0); assert.equal(proc.signalCode, null)
      } else record.milliseconds = Date.now() - start
      assert.equal(crashed, false)
      assert.equal(authored(disk()), authored(held), 'Whole authored buffer must be saved')
      if (scenario === 'move-undo') assert.equal(authored(disk()), authored(original))
      record.savedOnDisk = true; record.pass = true
      console.log(`PASS ${scenario} ${route} ${repeat}/${repeats}: ${record.milliseconds} ms`)
    } catch (error) {
      record.error = error.stack
      record.lifecycle = lifecycle(userData)
      if (held !== undefined) record.savedOnDisk = authored(disk()) === authored(held)
      if (app) {
        record.windows = await Promise.race([app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ id: w.id, visible: w.isVisible(), url: w.webContents.getURL() }))).catch(() => null), sleep(1000).then(() => null)])
      }
      console.error(`FAIL ${scenario} ${route} ${repeat}/${repeats}: ${error.message}`)
    } finally { await cleanup(); save() }
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
