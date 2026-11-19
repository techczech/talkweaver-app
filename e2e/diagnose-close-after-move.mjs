// Built Electron, hidden, with a private copy of the shipped example vault. Exercises the ordinary
// BrowserWindow.close/app.quit routes; never the installed app, a real vault, or Playwright teardown as the verdict.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const repo = resolve('.')
const scratch = mkdtempSync(join(tmpdir(), 'tw-close-after-move-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
let checks = 0
async function cleanup() {
  if (!app) return
  const proc = app.process()
  let timer
  try { await Promise.race([app.close().catch(() => {}), new Promise(r => { timer = setTimeout(r, 2000) })]) }
  finally {
    clearTimeout(timer)
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise(r => proc.once('exit', r))
      proc.kill('SIGKILL')
      await exited
    }
    app = null
  }
}
async function waitFor(fn, label, ms = 8000) {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await fn()) return; await sleep(50) }
  throw new Error(label)
}
try {
  await ensureFreshBuild(repo)
  const undoCases = [{ move: 'command', quit: true, undo: true }, { move: 'drag', quit: false, undo: true }]
  const stallCase = { move: 'command', quit: false, stall: true }
  const cases = process.env.TW_CLOSE_CASE === 'undo' ? undoCases
    : process.env.TW_CLOSE_CASE === 'stall' ? [stallCase]
    : [...Array.from({ length: 20 }, (_, i) => ({ move: i % 2 ? 'command' : 'drag', quit: i % 4 < 2, slow: i >= 16 })), ...undoCases, stallCase]
  for (const [i, scenario] of cases.entries()) {
    const root = join(scratch, String(i)), vault = join(root, 'vault'), ud = join(root, 'userData')
    mkdirSync(ud, { recursive: true })
    cpSync(join(repo, 'resources/example-vault'), vault, { recursive: true })
    const outline = join(vault, 'garden-notes/garden-notes-outline.md')
    if (scenario.undo) writeFileSync(outline, readFileSync(outline, 'utf8').replace('{id=g1}\n', ''))
    const original = readFileSync(outline, 'utf8')
    writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'plain' }))
    const delay = join(root, 'save-delay')
    app = await electron.launch({ args: ['.', `--user-data-dir=${ud}`, '--use-mock-keychain'], cwd: repo,
      env: { ...env, TW_UPDATE_TEST_SAVE_DELAY_FILE: delay } })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())), true)
    await openTalkByTitle(page, 'Garden notes')
    await page.locator('.cm-content').waitFor()
    await page.locator('.pane-btn[title="Grid"]').click()
    const cards = page.locator('.grid-view .grid-cell[draggable="true"]')
    const first = cards.filter({ hasText: 'Where the plot is' }).first()
    const next = cards.filter({ hasText: 'What we grow' }).first()
    await first.waitFor()
    if (scenario.move === 'drag') {
      await first.scrollIntoViewIfNeeded()
      await page.evaluate(([s, d]) => {
        const dt = new DataTransfer()
        for (const [el, type] of [[s, 'dragstart'], [d, 'dragenter'], [d, 'dragover'], [d, 'drop'], [s, 'dragend']])
          el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      }, [await first.elementHandle(), await next.elementHandle()])
    } else {
      await first.click()
      await page.keyboard.press('Meta+ArrowDown')
    }
    const disk = () => readFileSync(outline, 'utf8')
    await waitFor(() => disk().indexOf('### Where the plot is') > disk().indexOf('### What we grow'), 'the move was saved')
    if (scenario.undo) {
      await page.locator('.grid-view').focus()
      await page.keyboard.press('Meta+z')
      await waitFor(() => disk().indexOf('### Where the plot is') < disk().indexOf('### What we grow'), 'the undo was saved')
    } else {
      await page.locator('.pane-btn[title="Slides"]').click()
      if (scenario.slow) writeFileSync(delay, '1500')
      await page.locator('.cm-content').click()
      await page.keyboard.press('Meta+ArrowDown')
      await page.keyboard.press('End')
      await page.keyboard.type(` CLOSE_EDIT_${i}`)
      if (scenario.slow) await sleep(1000) // the 900ms autosave has started and is waiting in main
    }
    await page.locator('.pane-btn[title="Slides"]').click()
    await page.locator('.cm-content').waitFor()
    const held = await page.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString())
    if (scenario.stall) {
      // First confirmation asks for a revision write; that write is held beyond the save-phase ceiling.
      await app.evaluate(({ ipcMain }) => {
        const handlers = ipcMain._invokeHandlers
        const confirm = handlers.get('window:confirm-close'), write = handlers.get('talk:write-outline')
        let resave = true, held = false
        handlers.set('window:confirm-close', (event, ...args) => {
          if (resave) { resave = false; held = true; return 'resave' }
          return confirm(event, ...args)
        })
        handlers.set('talk:write-outline', async (event, ...args) => {
          if (held) { held = false; await new Promise(resolve => { globalThis.__releaseCloseSave = resolve }) }
          return write(event, ...args)
        })
      })
    }
    const proc = app.process()
    const exited = new Promise(r => proc.once('exit', () => r(true)))
    let closed = false
    page.once('close', () => { closed = true })
    const started = Date.now()
    if (scenario.quit) await app.evaluate(({ app: a }) => { a.quit() })
    else await (await app.browserWindow(page)).evaluate(w => w.close())
    if (scenario.stall) {
      await page.getByText('The talk could not finish saving, so this window stayed open.', { exact: false }).waitFor({ timeout: 12000 })
      assert.equal(closed, false, 'a timed-out save keeps the work open')
      assert.equal(await page.locator('[data-close-freeze]').count(), 0, 'the editor is usable again')
      await page.locator('.cm-content').click()
      await page.keyboard.press('Meta+ArrowDown')
      await page.keyboard.press('End')
      await page.keyboard.type(' AFTER_TIMEOUT')
      await app.evaluate(() => globalThis.__releaseCloseSave())
      await waitFor(() => disk().includes('AFTER_TIMEOUT'), 'typing after the ceiling is saved')
      assert.equal(closed, false, 'a late save cannot close the unfrozen editor')
      await (await app.browserWindow(page)).evaluate(w => w.close())
    }
    if (scenario.quit) {
      let timer
      try { assert.equal(await Promise.race([exited, new Promise(r => { timer = setTimeout(() => r(false), 8000) })]), true, 'ordinary quit finishes') }
      finally { clearTimeout(timer) }
    } else await waitFor(() => closed, 'ordinary window close finishes')
    const after = disk()
    // Main may stamp the id undo intentionally left out; every authored line still has to be on disk.
    const authored = t => t.split('\n').filter(l => !/^\s*\{id=[^}]+\}\s*$/.test(l)).join('\n')
    if (scenario.stall) assert.ok(after.includes('AFTER_TIMEOUT'), 'typing after timeout survives the next close')
    else assert.equal(authored(after), authored(held), 'the whole authored buffer is saved')
    assert.equal(after.includes(`CLOSE_EDIT_${i}`), !scenario.undo)
    if (scenario.undo) assert.equal(authored(after), authored(original), 'undo restores the original authored text')
    console.log(`PASS ${++checks}: ${JSON.stringify(scenario)} closed in ${Date.now() - started}ms, all authored text saved`)
    await cleanup()
  }
} finally {
  await cleanup()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`close after move: ${checks} checks passed`)
