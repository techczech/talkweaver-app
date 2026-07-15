// Real-Electron harness for the Settings panel (⌘,): folders + live shortcut customisation.
import { _electron as electron } from 'playwright'
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

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
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
  await page.locator('.talk-item', { hasText: 'Settings Fixture' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(300)

  // 1. ⌘, opens Settings — even from inside the editor.
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+,')
  await page.waitForTimeout(250)
  const open = await page.locator(SETTINGS).count()
  record('⌘, opens the Settings panel', open > 0, `dialog=${open}`)

  // 2. It shows the vault folder + the shortcut list.
  const txt = open ? await page.locator(SETTINGS).first().innerText() : ''
  record('Settings shows the vault root folder', txt.includes('Vault root') && txt.includes(vault), `hasLabel=${txt.includes('Vault root')} hasPath=${txt.includes(vault)}`)
  record('Settings lists editor shortcuts', txt.includes('Bold selection') && txt.includes('Make a heading — one level deeper'), `bold=${txt.includes('Bold selection')}`)

  // 3. Customise the Bold chord: click its button, then press ⌘U. The override must persist.
  await page.locator('[data-shortcut-id="bold"] button[aria-label^="Change shortcut"]').click()
  await page.waitForTimeout(120)
  await page.keyboard.press('Meta+u')
  await page.waitForTimeout(200)
  const overrides = await page.evaluate(() => {
    try { return JSON.parse(window.localStorage.getItem('tw-keymap-overrides') || '{}') } catch { return {} }
  })
  record('customising Bold persists an override (⌘U)', overrides.bold === 'Mod-u', `override=${JSON.stringify(overrides)}`)

  // 4. Close Settings, then the editor must HONOUR the new chord live (no reload).
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const closed = await page.locator(SETTINGS).count()
  record('Escape closes Settings', closed === 0, `dialog=${closed}`)

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
  console.log(`\n=== SETTINGS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
