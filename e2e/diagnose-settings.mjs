// Real-Electron harness for the Settings window (⌘,): the Shortcuts page + live shortcut customisation in the editor.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { openSettingsWindow, closeSettingsWindow, findSettingsWindow } from './lib/settings-window.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Settings Fixture', '---', '', '### Slide', '', 'Bold me line', ''].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-set-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'settings-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'settings-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--use-mock-keychain', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const SETTINGS = '[aria-label="Settings"]'
async function readDoc() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n')
  )
}
const has = (doc, line) => doc.split('\n').some((l) => l === line)

try {
  await openTalkByTitle(page, 'Settings Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(300)

  // 1. ⌘, opens the Settings window — even from inside the editor.
  await page.locator('.cm-content').click()
  const sw = await openSettingsWindow(app, page)
  record('⌘, opens the Settings window', Boolean(sw) && sw.url().includes('settings.html') && sw !== page, `url=${sw.url().split('/').pop()}`)

  // 2. It lists the editor shortcuts (Shortcuts page). The vault root folder is no longer a row of Settings: vaults are
  // added from Get started and listed in the Talks panel, so the page that holds them is checked instead.
  await openSettingsWindow(app, page, 'shortcuts')
  await sw.locator('[data-command="format-bold"]').waitFor({ state: 'visible' })
  const txt = await sw.locator('body').innerText()
  record('Settings lists editor shortcuts', await sw.locator('[data-command="format-bold"]').count() === 1 && await sw.locator('[data-command="editor.heading-sub"]').count() === 1 && txt.includes('Make subheading'), `bold=${await sw.locator('[data-command="format-bold"]').count()}`)
  await openSettingsWindow(app, page, 'get-started')
  await sw.locator('[data-add-vault]').waitFor({ state: 'visible' })
  record('Settings offers the vault folder step (Add vault…) on Get started', await sw.locator('[data-add-vault]').count() === 1, `addVault=${await sw.locator('[data-add-vault]').count()}`)
  await openSettingsWindow(app, page, 'shortcuts')

  // 3. Customise the Bold chord: click its button, then press ⌘U. The override must persist.
  await sw.locator('[data-command="format-bold"] button.bsw-kbd').click()
  await sw.locator('button[aria-label^="New shortcut for"]').waitFor({ state: 'visible' })
  await sw.keyboard.press('Meta+u')
  await sw.waitForFunction(() => !document.querySelector('button[aria-label^="New shortcut for"]'))
  for (let i = 0; i < 100; i++) {
    if ((await page.evaluate(() => window.tw.keymap.get())).bold === 'Mod-u') break
    await page.waitForTimeout(100)
  }
  const overrides = await page.evaluate(() => window.tw.keymap.get())
  const stored = await sw.evaluate(async () => (await window.bridleSettings.view()).state.keys)
  record('customising Bold persists an override (⌘U)', overrides.bold === 'Mod-u' && stored['format-bold'] === '⌘U', `override=${JSON.stringify(overrides)} stored=${JSON.stringify(stored)}`)

  // 4. Close Settings, then the editor must HONOUR the new chord live (no reload).
  await closeSettingsWindow(app)
  record('closing the Settings window closes it', findSettingsWindow(app) === null, `settings window open=${findSettingsWindow(app) !== null}`)
  await page.bringToFront()

  await page.locator('.cm-content .cm-line', { hasText: 'Bold me line' }).first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Meta+u')
  await page.waitForTimeout(200)
  let doc = await readDoc()
  record('editor re-binds Bold to ⌘U live', has(doc, '**Bold me line**'), `bolded=${has(doc, '**Bold me line**')}`)

  // 5. The old default (⌘B) no longer bolds (it was the overridden command's only chord).
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('old ⌘B no longer triggers Bold after remap', !has(doc, '****Bold me line****'), `doc has the line once bolded=${has(doc, '**Bold me line**')}`)
} catch (e) {
  record('settings harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  const pid = app.process().pid
  console.log(`\n=== SETTINGS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
  try { process.kill(pid) } catch { /* gone */ }
  process.exit(failed.length === 0 ? 0 : 1)
}
