// Real TalkWeaver, hidden windows and a synthetic vault. No OS keyboard or menu tracking claim.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { openSettingsWindow, closeSettingsWindow } from './lib/settings-window.mjs'
import { TASK_GROUPS } from '../src/shared/task-groups.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tw-command-groups-e2e-'))
const vault = join(scratch, 'vault'), ud = join(scratch, 'userData')
mkdirSync(join(vault, 'fixture'), { recursive: true }); mkdirSync(ud)
writeFileSync(join(vault, 'fixture', 'fixture-outline.md'), '---\ntitle: Command discovery\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Opening\n{id=opening}\n\nOriginal words.\n')
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
let app, passed = 0
const shots = process.env.TW_COMMAND_GROUP_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
try {
  await ensureFreshBuild(process.cwd())
  app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800))
  await openTalkByTitle(page, 'Command discovery')
  const editor = page.locator('[data-view="slide"] .cm-content')
  await editor.waitFor(); await editor.focus()
  async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`) }
  await check('every Electron window stays hidden', async () => {
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible())), false)
  })
  await check('palette shortcut opens eleven icon-led task rows in the built app', async () => {
    await page.keyboard.press('Meta+Shift+p')
    await page.locator('[data-task-group]').first().waitFor()
    assert.deepEqual(await page.locator('[data-task-group]').evaluateAll(rows => rows.map(r => r.dataset.taskGroup)), TASK_GROUPS)
    assert.equal(await page.locator('[data-group-icon]').count(), TASK_GROUPS.length)
    assert.equal(await page.locator('[data-command-menu]').evaluate(el => Math.round(el.getBoundingClientRect().width)), 560, 'category layout survives the app stylesheet order')
    assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1280, 800])
    if (shots) await page.screenshot({ path: join(shots, 'palette-task-groups.png'), scale: 'css' })
  })
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.locator('.command-menu-input')
  await check('Outlining and Formatting open with their own commands', async () => {
    await page.locator('[data-task-group="Outlining"]').click()
    assert.equal(await palette.locator('[data-command="new-slide"]').count(), 1)
    assert.equal(await palette.locator('[data-command="format-bold"]').count(), 0)
    await input.press('Escape')
    await page.locator('[data-task-group="Formatting"]').click()
    assert.equal(await palette.locator('[data-command="format-bold"]').count(), 1)
    assert.equal(await palette.locator('[data-command="new-slide"]').count(), 0)
    if (shots) await page.screenshot({ path: join(shots, 'palette-formatting-open.png'), scale: 'css' })
    await input.press('Escape')
  })
  await check('Build a slide opens registry subgroups; Escape restores its category', async () => {
    await page.locator('[data-task-group="Build a slide"]').click()
    assert.ok(await page.locator('.command-menu-subgroup').count() > 0)
    await input.press('Escape')
    assert.equal(await page.locator('[data-active=true]').getAttribute('data-task-group'), 'Build a slide')
  })
  await check('composition Enter leaves the real palette and document untouched', async () => {
    await input.fill('Insert table')
    const before = await editor.innerText()
    await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    assert.equal(await page.locator('[data-command-menu]').count(), 1)
    assert.equal(await editor.innerText(), before)
  })
  await check('plain-field select-all stays in the query; Escape restores CodeMirror focus', async () => {
    await input.fill('words'); await input.press('Meta+a')
    assert.equal(await input.evaluate(el => el.selectionEnd - el.selectionStart), 5)
    await input.press('Escape')
    assert.equal(await editor.evaluate(el => el.contains(document.activeElement)), true)
  })
  await check('actual native menu has eleven tasks and direct native Edit roles', async () => {
    const tree = await app.evaluate(({ Menu }) => {
      const walk = items => items.map(item => ({ label: item.label, role: item.role, id: item.id, accelerator: item.accelerator, children: item.submenu ? walk(item.submenu.items) : [] }))
      return walk(Menu.getApplicationMenu().items)
    })
    const walk = items => items.flatMap(item => [item, ...walk(item.children)])
    const all = walk(tree)
    for (const group of TASK_GROUPS) assert.equal(all.filter(item => item.label === group).length, 1, group)
    assert.deepEqual(tree.find(m => m.label === 'Edit').children.filter(item => item.role).map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall'])
    const edit = tree.find(menu => menu.label === 'Edit')
    const outlining = edit.children.find(item => item.label === 'Outlining')
    const formatting = edit.children.find(item => item.label === 'Formatting')
    assert.ok(walk(outlining.children).some(item => item.id === 'new-slide' && item.accelerator))
    assert.ok(walk(formatting.children).some(item => item.id === 'format-bold' && item.accelerator))
  })
  await check('browsing See the talk runs View: Grid', async () => {
    await page.keyboard.press('Meta+Shift+p')
    await page.locator('[data-task-group="See the talk"]').click()
    const command = palette.locator('[data-command="view-grid"]')
    await command.waitFor()
    await command.hover()
    await input.press('Enter')
    await page.locator('[data-command-menu]').waitFor({ state: 'hidden' })
    await page.locator('[data-view="grid"]').waitFor()
  })
  await check('the native menu leaf runs the same View: Grid command', async () => {
    await page.getByTestId('slides-toggle').click()
    await editor.waitFor()
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(win => !win.isDestroyed())
      const item = Menu.getApplicationMenu()?.getMenuItemById('view-grid')
      if (!item?.enabled || !window) throw new Error('View: Grid is missing or disabled in the native menu')
      // Invoke the built Electron menu item handler without opening the macOS menu bar.
      item.click(undefined, window, window.webContents)
    })
    await page.locator('[data-view="grid"]').waitFor()
  })
  await check('Settings opened by its native shortcut also stays hidden in test mode', async () => {
    await openSettingsWindow(app, page)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible())), false)
    await closeSettingsWindow(app)
  })
  console.log(`${passed} built-app command-group checks passed`)
} finally {
  try { await app?.close() } finally { rmSync(scratch, { recursive: true, force: true }) }
}
