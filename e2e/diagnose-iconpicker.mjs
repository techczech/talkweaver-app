// Real-Electron harness for the ICON PICKER (Feature #2, ADR-0021).
// Feature: ⌘⇧K (or the "Pick icon for current bullet…" command) opens a modal palette that
// searches the engine's icon vocabulary (Lucide names/tags + SVGL brands) via window.tw.icons,
// renders the matching glyphs in a grid, and on pick writes a trailing `{icon=KEY}` token onto
// the caret's CURRENT top-level list bullet through outline.setItemIcon (engine 12-outline-edit).
// This harness drives the BUILT app (out/) end to end and asserts:
//   1. ⌘⇧K opens the picker (its search input appears)
//   2. typing "python" returns results that include the svgl:python brand glyph
//   3. picking the active result writes {icon=...} onto the bullet the caret is on
//   4. the pinned token lands on the RIGHT bullet (Python), not a sibling
//   5. Escape closes the picker without changing the outline
//   6. the IPC layer (icons:search / icons:svg) returns matches and sanitized SVG markup
//   7. the chosen token persists to DISK (autosave) — read the file back
// Run after `npm run build`.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// One {iconlist} slide with three top-level bullets — the icon picker targets the caret's bullet.
const FIX = [
  '---', 'title: Icon Fixture', '---', '',
  '## Section', '',
  '### Languages', '{iconlist}', '',
  '- Python', '- JavaScript', '- Rust', ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-icon-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'icons')
const other = join(vault, 'other')
mkdirSync(td, { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(other, 'other-outline.md'), '---\ntitle: Other\n---\n\n### Y\n\nz\n')
const fxPath = join(td, 'icon-fixture-outline.md')
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
  await page.waitForTimeout(400)
}
async function reset() {
  await page.waitForTimeout(1700) // let any pending autosave flush before we overwrite
  await selectTalk('Other')
  writeFileSync(fxPath, FIX)
  await selectTalk('Icon Fixture')
}
// Place the caret on the line whose text matches `bulletText` (a top-level bullet).
async function caretOnBullet(bulletText) {
  await page.locator('.cm-content .cm-line', { hasText: bulletText }).first().click()
  await page.keyboard.press('End')
  await page.waitForTimeout(150)
}
async function openPicker() {
  await page.keyboard.press('Meta+Shift+K')
  await page.waitForTimeout(350)
}
const has = (doc, sub) => doc.includes(sub)

try {
  await selectTalk('Icon Fixture')

  // --- IPC layer: icons:search + icons:svg straight over the bridge ---
  const ipc = await page.evaluate(async () => {
    const hits = await window.tw.icons.search('python')
    const top = hits && hits[0] ? hits[0].key : null
    const svg = top ? await window.tw.icons.svg(top) : null
    return {
      count: Array.isArray(hits) ? hits.length : -1,
      hasPython: !!(hits || []).some((h) => /python/i.test(h.key)),
      top,
      svgLen: (svg || '').length,
      svgHasScript: /<script/i.test(svg || '')
    }
  })
  record('icons:search returns matches including a python glyph', ipc.hasPython && ipc.count > 0, JSON.stringify(ipc))
  record('icons:svg returns non-empty, script-free SVG markup', ipc.svgLen > 0 && !ipc.svgHasScript, `len=${ipc.svgLen} script=${ipc.svgHasScript}`)

  // 1. ⌘⇧K opens the picker
  await reset()
  await caretOnBullet('Python')
  await openPicker()
  const openInput = await page.locator('.icon-picker [data-icon-search]').count()
  record('⌘⇧K opens the icon picker', openInput > 0, `input=${openInput}`)

  // 2. typing "python" surfaces the python brand result
  await page.locator('.icon-picker [data-icon-search]').fill('python')
  await page.waitForTimeout(450)
  const pythonResult = await page.locator('.icon-picker [data-icon-key="svgl:python"]').count()
  const anyResult = await page.locator('.icon-picker [role="option"]').count()
  record('search "python" shows the svgl:python result', pythonResult > 0, `pythonResult=${pythonResult} totalResults=${anyResult}`)

  // 3 + 4. pick the active result → {icon=...} lands on the Python bullet (caret's bullet), not a sibling.
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  let doc = await readDoc()
  const pythonLine = doc.split('\n').find((l) => /^- Python\b/.test(l)) || ''
  const jsLine = doc.split('\n').find((l) => /^- JavaScript\b/.test(l)) || ''
  record(
    'picking writes {icon=...} onto the Python bullet',
    /\{icon=[^}]+\}/.test(pythonLine),
    `pythonLine="${pythonLine}"`
  )
  record(
    'sibling bullets are untouched (JavaScript has no icon token)',
    !/\{icon=/.test(jsLine),
    `jsLine="${jsLine}"`
  )

  // 5. Escape closes the picker without changing the outline.
  await reset()
  await caretOnBullet('Rust')
  await openPicker()
  await page.locator('.icon-picker [data-icon-search]').fill('rust')
  await page.waitForTimeout(450)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const closed = await page.locator('.icon-picker [data-icon-search]').count()
  doc = await readDoc()
  record('Escape closes the picker', closed === 0, `input=${closed}`)
  record('Escape leaves the outline unchanged (no icon token)', !/\{icon=/.test(doc), `hasToken=${/\{icon=/.test(doc)}`)

  // 7. The pinned token persists to disk via autosave.
  await reset()
  await caretOnBullet('Rust')
  await openPicker()
  await page.locator('.icon-picker [data-icon-search]').fill('rust')
  await page.waitForTimeout(450)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  doc = await readDoc()
  const rustLineInEditor = doc.split('\n').find((l) => /^- Rust\b/.test(l)) || ''
  record('picking on Rust writes an icon token in the editor', /\{icon=[^}]+\}/.test(rustLineInEditor), `rustLine="${rustLineInEditor}"`)
  await page.waitForTimeout(900) // allow disk write
  const onDisk = readFileSync(fxPath, 'utf8')
  const rustLineOnDisk = onDisk.split('\n').find((l) => /^- Rust\b/.test(l)) || ''
  record('the icon token persisted to disk', /\{icon=[^}]+\}/.test(rustLineOnDisk), `rustLineOnDisk="${rustLineOnDisk}"`)
} catch (e) {
  record('iconpicker harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== ICONPICKER SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
