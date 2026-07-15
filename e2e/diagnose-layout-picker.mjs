// Real-Electron harness for the layout picker's template actions (ADR-0021):
//   Enter      → insert the bare trigger
//   ⌘-Enter    → insert the blank Markdown template (scaffold)
//   Space       → reveal the template preview for the active layout
// Runs against the BUILT app (out/) — run after `npm run build`.
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

const FIX = ['---', 'title: Picker Fixture', 'author: T', '---', '', '## Section', '', '### A slide', '', 'Intro.', ''].join('\n')
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-lp-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'picker')
const other = join(vault, 'other')
mkdirSync(td, { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(other, 'other-outline.md'), '---\ntitle: Other\n---\n\n### Y\n\nz\n')
const fxPath = join(td, 'picker-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function readDoc() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n')
  )
}
async function selectTalk(name) {
  await page.locator('.sidebar-mode-btn', { hasText: 'Talks' }).click().catch(() => {})
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(350)
}
async function reset() {
  await page.waitForTimeout(1700) // let any pending autosave flush before we overwrite
  await selectTalk('Other')
  writeFileSync(fxPath, FIX)
  await selectTalk('Picker Fixture')
}
async function openPalette() {
  // ⌘L opens the layout picker (replaced the "/" auto-popup). Put the caret on a slide body line
  // first so the chosen trigger lands on that slide's Trigger line.
  await page.locator('.cm-content .cm-line', { hasText: 'Intro.' }).first().click().catch(async () => {
    await page.locator('.cm-content').click()
  })
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(700) // open + async template fetch
}
const has = (doc, sub) => doc.includes(sub)

try {
  await selectTalk('Picker Fixture')

  // 1. ⌘L opens the layout palette
  await reset()
  await openPalette()
  const open = await page.locator('[role="listbox"]').count()
  record('⌘L opens the layout palette', open > 0, `listbox=${open}`)

  // 2. Space (empty search) reveals a template preview for the active layout
  await page.keyboard.press(' ')
  await page.waitForTimeout(300)
  const preview = await page.locator('[data-template-preview]').first()
  const previewText = (await preview.count()) ? (await preview.textContent()) : ''
  record('Space reveals a template preview', /\{[a-z-]+\}/.test(previewText || ''), `preview="${(previewText || '').slice(0, 24).replace(/\n/g, '⏎')}"`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // 3. ⌘-Enter inserts the blank TEMPLATE (cards is now a flat-list grid scaffold, not ####).
  await reset()
  await openPalette()
  await page.keyboard.type('equal-weight')
  await page.waitForTimeout(300)
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(300)
  let doc = await readDoc()
  record('⌘-Enter inserts the cards template (grid scaffold)', has(doc, '{cards}') && has(doc, '- First card'), `hasTrigger=${has(doc, '{cards}')} hasBody=${has(doc, '- First card')}`)

  // 4. Plain Enter inserts only the bare trigger (no scaffold)
  await reset()
  await openPalette()
  await page.keyboard.type('equal-weight')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  doc = await readDoc()
  record('Enter inserts the bare {cards} trigger (no scaffold)', has(doc, '{cards}') && !has(doc, '#### '), `hasTrigger=${has(doc, '{cards}')} noScaffold=${!has(doc, '#### ')}`)

  // 5. Picking a SECOND layout replaces the Trigger line — it does not stack a literal {...} line.
  await reset()
  await openPalette()
  await page.keyboard.type('equal-weight')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter') // {cards} on the trigger line
  await page.waitForTimeout(350)
  await openPalette()
  await page.keyboard.type('statement')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter') // should REPLACE {cards} with {statement}
  await page.waitForTimeout(350)
  doc = await readDoc()
  const triggerLines = doc.split('\n').filter((l) => /^\s*\{[^}]*\}\s*$/.test(l)).length
  record(
    'second layout pick replaces the trigger (no stacked {...})',
    has(doc, '{statement}') && !has(doc, '{cards}') && triggerLines === 1,
    `statement=${has(doc, '{statement}')} noCards=${!has(doc, '{cards}')} triggerLines=${triggerLines}`
  )

  // 6. ⌘L on a slide that ALREADY has a trigger reopens the picker and changes it in place.
  await reset()
  await openPalette()
  await page.keyboard.type('equal-weight')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter') // {cards} on the trigger line
  await page.waitForTimeout(350)
  await page.locator('.cm-content .cm-line', { hasText: '{cards}' }).first().click()
  await page.keyboard.press('Meta+l') // reopen the picker for this slide
  await page.waitForTimeout(600)
  const reopened = await page.locator('[role="listbox"]').count()
  await page.keyboard.type('statement')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
  doc = await readDoc()
  const tl2 = doc.split('\n').filter((l) => /^\s*\{[^}]*\}\s*$/.test(l)).length
  record(
    '⌘L on a slide with an existing trigger reopens picker + changes it in place',
    reopened > 0 && has(doc, '{statement}') && !has(doc, '{cards}') && tl2 === 1,
    `reopened=${reopened} statement=${has(doc, '{statement}')} noCards=${!has(doc, '{cards}')} triggerLines=${tl2}`
  )
} catch (e) {
  record('layout-picker harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== LAYOUT-PICKER SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
