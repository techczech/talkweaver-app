// Real menu, deck close offer, editor merge review and restart-window ports. The test copy
// exposes the updater's existing ports at its adapter boundary; no test hook ships in the app.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import { cpSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { typeAtOutlineLineEnd } from './lib/outline-typing.mjs'
import { buildNativeQuitMenu } from './lib/native-quit-menu.mjs'

const repo = resolve(import.meta.dirname, '..'), evidence = join(repo, 'artefacts/quit-helpers')
mkdirSync(evidence, { recursive: true })
await using appScratch = createAppScratch()
const root = appScratch.root, copy = join(root, 'app')
const results = [], sockets = new Set()
let app, buildSha256
const pause = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, message, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await pause(30) }
  throw Error(message)
}
async function bounded(work, message, ms = 30000) {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms) })]) }
  finally { clearTimeout(timer) }
}
try {
  if (!process.env.TW_CANCEL_BUILD) await ensureFreshBuild(repo)
  const build = process.env.TW_CANCEL_BUILD ? resolve(repo, process.env.TW_CANCEL_BUILD) : join(repo, 'out')
  cpSync(join(build, 'main'), join(copy, 'out/main'), { recursive: true })
  const main = readFileSync(join(build, 'main/index.js'), 'utf8')
  buildSha256 = createHash('sha256').update(main).digest('hex')
  assert.ok(main.includes('function installUpdateNotices(ports) {'))
  writeFileSync(join(copy, 'out/main/index.js'), main.replace('function installUpdateNotices(ports) {', 'function installUpdateNotices(ports) { globalThis.quitTestPorts = ports; globalThis.quitTestAllowed = helperWindowsAllowed; globalThis.quitTestForeground = thumbnailForeground;'))
  cpSync(join(repo, 'package.json'), join(copy, 'package.json'))
  for (const name of ['node_modules', 'compiler', 'resources', 'native']) symlinkSync(join(repo, name), join(copy, name))
  for (const name of ['preload', 'renderer']) symlinkSync(join(build, name), join(copy, 'out', name))
  const addon = buildNativeQuitMenu(root)
  for (const scenario of (process.env.TW_CANCEL_SCENARIOS ?? 'presenting,stay,restart,recording').split(',')) {
    const record = { scenario, pass: false }; results.push(record)
    const stage = name => { record.stage = name; console.log('cancel ' + scenario + ': ' + name) }
    const fixture = join(root, scenario), userData = join(fixture, 'userData'), vault = join(fixture, 'vault')
    mkdirSync(userData, { recursive: true }); cpSync(join(repo, 'resources/example-vault'), vault, { recursive: true })
    const outline = join(vault, 'garden-notes/garden-notes-outline.md'), content = readFileSync(outline, 'utf8')
    writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, openInView: 'outline' }))
    let proc
    try {
      const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE
      app = (await launchApp({ scratch: appScratch, userData, env, args: [copy, '--use-mock-keychain', '--use-fake-device-for-media-stream'] })).app
      proc = app.process()
      proc.stdout?.on('data', bytes => { record.stdout = ((record.stdout ?? '') + bytes).slice(-16000) })
      proc.stderr?.on('data', bytes => { record.stderr = ((record.stderr ?? '') + bytes).slice(-16000) })
      try { sockets.add(dirname(readlinkSync(join(userData, 'SingletonSocket')))) } catch {}
      assert.equal(await app.evaluate(({ BrowserWindow, app }, ud) => app.getPath('userData') === ud && BrowserWindow.getAllWindows().every(w => !w.isVisible()), userData), true)
      await app.evaluate(({ app }) => { globalThis.quitEvents = 0; app.on('before-quit', () => { globalThis.quitEvents++ }) })
      let page = await app.firstWindow(); page.setDefaultTimeout(15000)
      await openTalkByTitle(page, 'Garden notes'); await page.locator('.cm-content').waitFor()
      const quit = async () => {
        const before = await app.evaluate(() => globalThis.quitEvents)
        await app.evaluate(({ Menu, app }, { addon, pid, userData }) => {
        if (app.getPath('userData') !== userData) throw Error('Wrong test profile')
        const item = Menu.getApplicationMenu().items.flatMap(i => i.submenu?.items ?? []).find(i => i.role === 'quit')
        if (addon) process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')(addon).clickQuit(pid, item.label)
        else setImmediate(() => item.click())
        }, { addon, pid: proc.pid, userData })
        await until(async () => {
          try { return await app.evaluate(() => globalThis.quitEvents) > before }
          catch (error) {
            if (/Execution context was destroyed/.test(error.message)) return false
            throw error
          }
        }, 'native Quit did not enter before-quit')
      }
      const picture = async () => {
        stage('draw fresh picture')
        // Unique content defeats the thumbnail cache: success requires a NEW draw after cancellation.
        const result = await bounded(page.evaluate(({ outline, content, marker }) => window.tw.talk.selectedThumbnail(outline, content.replace('Behind the station, through the green gate.', marker), 'g1'), { outline, content, marker: 'Draw after cancelled Quit ' + Date.now() }), 'fresh picture request did not settle')
        assert.ok(result?.url, 'a fresh slide picture must be drawn after cancellation')
        assert.equal(await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); return image.naturalWidth > 0 }, result.url), true)
      }
      const restoredEditor = async () => {
        await until(async () => { page = app.windows().find(p => !p.isClosed() && p.url().includes('/renderer/index.html')); return page }, 'new editor not opened')
        await openTalkByTitle(page, 'Garden notes')
      }
      if (scenario === 'restart') {
        stage('restart closes editors')
        // Electron confirms the native window close independently of Playwright's page-close event.
        await Promise.all([
          page.waitForEvent('close'),
          (async () => {
            const closed = await app.evaluate(() => globalThis.quitTestPorts.closeWindowsForRestart())
            assert.equal(closed, true, 'the updater adapter kept a window open before native install')
            if (!page.isClosed()) console.log('Restart closed the native window before Playwright received page close.')
          })(),
        ])
        // Stand in for a native installer that enters before-quit but leaves the process alive.
        await app.evaluate(({ app }) => { app.once('before-quit', event => event.preventDefault()) })
        stage('native Quit after restart closed editors')
        await quit()
        stage('abandon restart')
        await app.evaluate(() => globalThis.quitTestPorts.restartAbandoned())
        record.gateAfterAbandon = await app.evaluate(() => globalThis.quitTestAllowed())
        assert.equal(record.gateAfterAbandon, true, 'native Quit and restart share one released hold')
        await restoredEditor()
        await picture()
      } else if (scenario === 'stay') {
        // Independent edits merge during Quit. Change the same slide on both sides to exercise cancellation.
        const line = 'Behind the station, through the green gate.'
        const before = readFileSync(outline, 'utf8')
        await typeAtOutlineLineEnd(page, line, ' STAY_TYPED')
        const outside = before.replace(line, line + ' DISK_CONFLICT') + '\n### Outside {id=outside}\n\nOutside change.\n'
        assert.match(outside, /DISK_CONFLICT/, 'the outside write must overlap the typed slide')
        writeFileSync(outline, outside)
        const review = page.getByTestId('outline-merge-sheet')
        const decideLater = review.getByRole('button', { name: 'Decide later', exact: true })
        const conflict = review.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Where the plot is', exact: true }) })
        const keepSlide = conflict.getByRole('button', { name: "Keep this window's version", exact: true })
        const editorText = () => page.locator('.cm-content').evaluate(el => el.cmTile.root.view.state.doc.toString())
        await decideLater.click()
        await review.waitFor({ state: 'hidden' })
        stage('native Quit reopens merge review')
        await quit()
        await keepSlide.waitFor()
        const typedBeforeDismiss = await editorText()
        assert.match(typedBeforeDismiss, /STAY_TYPED/)
        assert.match((await conflict.locator('.merge-cards-diff pre del').allTextContents()).join(''), /STAY_TYPED/)
        assert.match((await conflict.locator('.merge-cards-diff pre ins').allTextContents()).join(''), /DISK_CONFLICT/)
        assert.equal(readFileSync(outline, 'utf8'), outside, 'Quit must leave the disk version intact while the choice is pending')
        await decideLater.click()
        await review.waitFor({ state: 'hidden' })
        await until(async () => await page.locator('[data-close-freeze]').count() === 0, 'editor did not unfreeze')
        assert.equal(await editorText(), typedBeforeDismiss, 'Decide later must keep the typed version in the editor')
        assert.equal(readFileSync(outline, 'utf8'), outside, 'Decide later must keep the outside version on disk')
        await picture()
        stage('save the typed slide and independent outside edit')
        await page.getByRole('button', { name: 'Review merge', exact: true }).click()
        await keepSlide.click()
        // The final disk slide needs confirmation because a write may have paused there.
        await review.getByRole('group', { name: 'Version for Outside', exact: true })
          .getByRole('button', { name: 'Take the new slide from disk', exact: true }).click()
        await review.getByRole('button', { name: 'Apply to the file', exact: true }).click()
        await review.waitFor({ state: 'hidden' })
        const saved = readFileSync(outline, 'utf8')
        assert.match(saved, /STAY_TYPED/, 'the text entered before Quit must reach disk')
        assert.match(saved, /Outside change\./, 'the independent outside edit must survive the merge')
        assert.doesNotMatch(saved, /DISK_CONFLICT/, 'the selected editor version must win the overlapping slide')
      } else {
        await page.evaluate(({ outline, content }) => window.tw.talk.present(outline, content, 'presenter'), { outline, content })
        let presenter
        await until(async () => { presenter = app.windows().find(p => p.url().includes('presenter=1')); return presenter }, 'presenter not opened')
        await presenter.locator('#twrec-primary').waitFor()
        if (scenario === 'recording') {
          await presenter.locator('#twrec-primary').click()
          await presenter.locator('[data-continue]').waitFor()
          await presenter.waitForFunction(() => !document.querySelector('[data-continue]').disabled)
          await presenter.locator('[data-continue]').click()
          await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording')
        } else {
          // Reaching the last slide arms the real run-save offer without a five-minute wait.
          await presenter.keyboard.press('End')
          await presenter.locator('.twrec-save-offer.show').waitFor({ state: 'visible' })
        }
        const sourceId = scenario === 'recording' ? await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.isOffscreen())?.id) : null
        stage('native Quit')
        await quit()
        await presenter.locator('.twrec-close-modal').waitFor()
        await presenter.locator('#twrec-close-cancel').click()
        if (scenario === 'recording') {
          await until(() => app.evaluate(({ BrowserWindow }, old) => BrowserWindow.getAllWindows().some(w => w.id !== old && w.webContents.isOffscreen()), sourceId), 'recording slides source was not restored')
          await until(() => app.evaluate(({ BrowserWindow }) => { const source = BrowserWindow.getAllWindows().find(w => w.webContents.isOffscreen()); return source && !source.webContents.isLoadingMainFrame() }), 'restored slides did not finish loading')
          // Observe actual changed frames following navigation, beyond source existence.
          await app.evaluate(({ BrowserWindow }) => {
            globalThis.frameHashes = new Set()
            const source = BrowserWindow.getAllWindows().find(w => w.webContents.isOffscreen())
            source.webContents.on('paint', (_e, _rect, frame) => globalThis.frameHashes.add(process.getBuiltinModule('crypto').createHash('sha256').update(frame.toBitmap()).digest('hex')))
            source.webContents.invalidate()
          })
          await until(() => app.evaluate(() => globalThis.frameHashes.size > 0), 'restored source sent no frame')
          await presenter.keyboard.press('End')
          const slide = await presenter.evaluate(() => location.hash)
          await until(() => app.evaluate(async ({ BrowserWindow }, hash) => { const source = BrowserWindow.getAllWindows().find(w => w.webContents.isOffscreen()); return source && await source.webContents.executeJavaScript('location.hash') === hash }, slide), 'restored slides did not follow presenter navigation')
          await until(() => app.evaluate(() => globalThis.frameHashes.size >= 2), 'recording slides did not update after cancelled Quit')
          stage('stop and keep recording')
          await presenter.locator('#twrec-stop').click()
          await presenter.waitForFunction(() => ['confirm', 'saved'].includes(document.querySelector('#twrec-module').dataset.rec))
          if (await presenter.locator('#twrec-module').getAttribute('data-rec') === 'confirm') await presenter.locator('#twrec-keep').click()
          await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
        } else {
          if (page.isClosed()) {
            await app.evaluate(({ ipcMain, BrowserWindow }) => {
              const sender = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('presenter=1')).webContents
              return ipcMain._invokeHandlers.get('window:new')({ sender, senderFrame: sender.mainFrame })
            })
            await restoredEditor()
          }
          await picture()
        }
      }
      record.pass = true; console.log('PASS cancelled Quit: ' + scenario)
    } catch (error) {
      record.error = error.stack
      if (app) record.state = await bounded(app.evaluate(({ BrowserWindow }) => ({ allowed: globalThis.quitTestAllowed(), foreground: globalThis.quitTestForeground(), windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, url: w.webContents.getURL(), loading: w.webContents.isLoadingMainFrame() })) })), 'diagnostics unavailable', 2000).catch(() => null)
      console.error('FAIL cancelled Quit: ' + scenario + ': ' + (error.stack ?? error.message))
    }
    finally {
      if (app) {
        // Own test process only; bypass the test's intentionally retained conflict/recording sheet.
        await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
        await Promise.race([appScratch.closeApp(app).catch(() => {}), pause(3000)])
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
        app = null
      }
    }
  }
} finally {
  if (app) await appScratch.closeApp(app).catch(() => {})
  await appScratch.close()
  for (const socket of sockets) if (/\/scoped_dir[^/]+$/.test(socket)) rmSync(socket, { recursive: true, force: true })
  writeFileSync(join(evidence, 'cancel' + (process.env.TW_CANCEL_LABEL ?? '') + '.json'), JSON.stringify({ buildSha256, baseline: process.env.TW_CANCEL_BUILD ?? null, results, scratchRemoved: true }, null, 2))
}
console.log(`Quit cancellation: ${results.filter(r => r.pass).length}/${results.length}`)
process.exitCode = results.every(r => r.pass) ? 0 : 1
