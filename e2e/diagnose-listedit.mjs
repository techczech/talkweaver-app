// Real-Electron harness for editor list/outline editing + folding.
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

const FIX = [
  '---', 'title: List Fixture', 'author: Test', '---', '',
  '## Section', '', '### Slide', '',
  'Intro paragraph.', '',
  '- Item one', '- Item two', '',
  'Plain paragraph line.', '',
  '> A quote line', ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-le-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'list-fixture')
const other = join(vault, 'other')
mkdirSync(td, { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(other, 'other-outline.md'), '---\ntitle: Other\n---\n\n### Y\n\nz\n')
const fxPath = join(td, 'list-fixture-outline.md')
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
async function visibleLines() {
  return page.evaluate(() => document.querySelectorAll('.cm-content .cm-line').length)
}
async function selectTalk(name) {
  await page.locator('.sidebar-mode-btn', { hasText: 'Talks' }).click().catch(() => {})
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(350)
}
async function reset() {
  // Let any pending 1.5s autosave from the previous check flush BEFORE we overwrite the file,
  // otherwise it clobbers FIX mid-reset and the next clickLine can't find its target.
  await page.waitForTimeout(1700)
  await selectTalk('Other')
  writeFileSync(fxPath, FIX)
  await selectTalk('List Fixture')
}
async function clickLine(text) {
  await page.locator('.cm-content .cm-line', { hasText: text }).first().click()
  await page.waitForTimeout(120)
}
const has = (doc, line) => doc.split('\n').some((l) => l === line)

try {
  await selectTalk('List Fixture')

  // 1. Enter continues a list
  await reset()
  await clickLine('- Item two')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Item three')
  await page.waitForTimeout(150)
  let doc = await readDoc()
  record('Enter continues a list', has(doc, '- Item three'), `has "- Item three"=${has(doc, '- Item three')}`)

  // 2. Tab indents a list item
  await reset()
  await clickLine('- Item one')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(150)
  doc = await readDoc()
  record('Tab indents a list item', has(doc, '  - Item one'), `has "  - Item one"=${has(doc, '  - Item one')}`)

  // 3. Shift-Tab outdents
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(150)
  doc = await readDoc()
  record('Shift-Tab outdents a list item', has(doc, '- Item one'), `back to "- Item one"=${has(doc, '- Item one')}`)

  // 4. ⌘⇧→ indents a PLAIN paragraph line (universal promote/demote)
  await reset()
  await clickLine('Plain paragraph line.')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(150)
  doc = await readDoc()
  record('⌘⇧→ indents a plain line', has(doc, '  Plain paragraph line.'), `has indented plain=${has(doc, '  Plain paragraph line.')}`)

  // 5. ⌘⇧→ indents a > quote line
  await reset()
  await clickLine('> A quote line')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(150)
  doc = await readDoc()
  record('⌘⇧→ works on a > quote line', has(doc, '  > A quote line'), `has indented quote=${has(doc, '  > A quote line')}`)

  // 6. ⌘⌥↓ makes a line a sublevel heading; ⌘⌥↑ same level as previous heading (### Slide → l3).
  //    (Moved off Ctrl+Arrow — macOS reserves Ctrl+Arrow for Mission Control / Spaces.)
  await reset()
  await clickLine('Plain paragraph line.')
  await page.keyboard.press('Meta+Alt+ArrowDown')
  await page.waitForTimeout(150)
  doc = await readDoc()
  record('⌘⌥↓ makes line a sublevel heading (####)', has(doc, '#### Plain paragraph line.'), `has "#### Plain..."=${has(doc, '#### Plain paragraph line.')}`)
  await page.keyboard.press('Meta+Alt+ArrowUp')
  await page.waitForTimeout(150)
  doc = await readDoc()
  record('⌘⌥↑ makes line same level as previous heading (###)', has(doc, '### Plain paragraph line.'), `has "### Plain..."=${has(doc, '### Plain paragraph line.')}`)

  // 7. Folding: put the caret on "## Section" and fold via the command (Mac fold = ⌘⌥[).
  //    The section runs to EOF here, so folding hides several lines.
  await reset()
  const before = await visibleLines()
  const foldMarkers = await page.locator('.cm-foldGutter .cm-gutterElement').count()
  await clickLine('## Section')
  await page.keyboard.press('Meta+Alt+[')
  await page.waitForTimeout(300)
  const after = await visibleLines()
  record('folding a heading collapses its section', foldMarkers > 0 && before - after >= 3, `markers=${foldMarkers} lines ${before}->${after}`)
  // unfold restores
  await page.keyboard.press('Meta+Alt+]')
  await page.waitForTimeout(200)
  const restored = await visibleLines()
  record('unfold restores the section', restored === before, `${after}->${restored} (was ${before})`)

  // 8. BUG FIX: ⌘⇧↑ at the start of the first list item moves it up past the paragraph and
  //    does NOT select to document start.
  await reset()
  await clickLine('- Item one')
  await page.keyboard.press('Home')
  await page.keyboard.press('Meta+Shift+ArrowUp')
  await page.waitForTimeout(200)
  doc = await readDoc()
  const selEmpty = await page.evaluate(() => {
    const els = document.querySelectorAll('.cm-selectionBackground')
    return els.length === 0
  })
  const lines = doc.split('\n')
  const oneIdx = lines.indexOf('- Item one')
  const paraIdx = lines.indexOf('Intro paragraph.')
  record('⌘⇧↑ on first list item does NOT select', selEmpty, `selectionBg=${selEmpty ? 0 : 'present'}`)
  record('⌘⇧↑ moves first list item up past the paragraph', oneIdx >= 0 && paraIdx >= 0 && oneIdx < paraIdx, `itemOne@${oneIdx} para@${paraIdx}`)

  // 9. Frontmatter protected: in RAW mode, ⌘⇧↓ / ⌘⇧→ on a metadata line do nothing.
  //    (In table mode the frontmatter is an atomic widget the caret can't even enter.)
  await reset()
  await page.locator('.cm-fm-raw-btn').first().click() // flip to raw so the YAML is editable text
  await page.waitForTimeout(300)
  const fmBefore = await readDoc()
  await clickLine('title: List Fixture')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.waitForTimeout(150)
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(150)
  const fmAfter = await readDoc()
  record('frontmatter is protected from outliner shortcuts', fmBefore === fmAfter, `unchanged=${fmBefore === fmAfter}`)

  // 10. Jump by heading: ⌘⌥← jumps UP to "### Slide", again to "## Section"; ⌘⌥→ jumps back
  //     down. (Click a BODY line — the frontmatter is a table widget now.)
  await reset()
  const headingText = () =>
    page.evaluate(() => {
      const a = document.querySelector('.cm-activeLine')
      const t = a ? (a.textContent || '') : ''
      return /^#{1,6}\s/.test(t) ? t.trim() : null
    })
  await clickLine('Intro paragraph.') // below both headings
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.waitForTimeout(200)
  const h1 = await headingText()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.waitForTimeout(200)
  const h2 = await headingText()
  record('⌘⌥← jumps heading→heading upward', h1 === '### Slide' && h2 === '## Section', `first=${h1} second=${h2}`)
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await page.waitForTimeout(200)
  const h3 = await headingText()
  record('⌘⌥→ jumps back down a heading', h3 === '### Slide', `down=${h3}`)

  // 11. Fold all via the command palette.
  await reset()
  const linesBeforeFold = await visibleLines()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+Shift+p')
  await page.waitForTimeout(400)
  await page.locator('.command-menu-input').fill('fold all')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const linesAfterFold = await visibleLines()
  record('command palette "Fold all" collapses the outline', linesAfterFold < linesBeforeFold, `${linesBeforeFold}->${linesAfterFold}`)

  // 12. ⌘⌥↓ on an EMPTY line makes it a sub-level heading (#### under ### Slide); ⌘⌥↑ matches
  //     the previous heading's level (###). Same chords as check 6 — make-heading now works on
  //     any line (blank or text), so there's no blank-vs-text overloading to misfire.
  await reset()
  await clickLine('Intro paragraph.')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter') // a fresh empty line under the ### Slide section
  await page.waitForTimeout(120)
  const hasEmptyHeading = (doc, n) => doc.split('\n').some((l) => l.trim() === '#'.repeat(n))
  await page.keyboard.press('Meta+Alt+ArrowDown')
  await page.waitForTimeout(150)
  let hd = await readDoc()
  record('⌘⌥↓ on an empty line creates a sub-heading (####)', hasEmptyHeading(hd, 4), `hasEmpty####=${hasEmptyHeading(hd, 4)}`)
  // Fresh empty line for the ↑ case (the line above is now a heading, not blank).
  await reset()
  await clickLine('Intro paragraph.')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(120)
  await page.keyboard.press('Meta+Alt+ArrowUp')
  await page.waitForTimeout(150)
  hd = await readDoc()
  record('⌘⌥↑ on an empty line matches the previous heading level (###)', hasEmptyHeading(hd, 3) && !hasEmptyHeading(hd, 4), `### only=${hasEmptyHeading(hd, 3) && !hasEmptyHeading(hd, 4)}`)

  // 13. ⌘B wraps the selected text in **bold**.
  await reset()
  await clickLine('Plain paragraph line.')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(150)
  const bd = await readDoc()
  record('⌘B wraps the selection in **bold**', bd.split('\n').some((l) => l === '**Plain paragraph line.**'), `bolded=${bd.split('\n').some((l) => l === '**Plain paragraph line.**')}`)

  // 14. ⌘F opens the plain-text find panel.
  await reset()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+f')
  await page.waitForTimeout(250)
  const findPanel = await page.locator('.cm-search, .cm-panel').count()
  record('⌘F opens the find panel', findPanel > 0, `panels=${findPanel}`)

  // 15. ⌃/ opens the keyboard-shortcuts list — even with the editor focused (where "?" is a real
  //     character). Escape closes it. This is the discoverability fix for the whole keymap.
  await reset()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+/')
  await page.waitForTimeout(250)
  const helpOpen = await page.locator('[aria-label="Keyboard shortcuts"]').count()
  // The list is registry-driven, so it must show the real make-heading chord glyphs (⌘⌥ + ↑/↓).
  const helpText = helpOpen ? (await page.locator('[aria-label="Keyboard shortcuts"]').first().innerText()) : ''
  record('⌃/ opens the shortcuts list from inside the editor', helpOpen > 0, `dialog=${helpOpen}`)
  record('shortcuts list shows real chords (⌘ ⌥ ↑)', /⌘/.test(helpText) && /⌥/.test(helpText) && /↑/.test(helpText), `hasCmd=${/⌘/.test(helpText)} hasOpt=${/⌥/.test(helpText)} hasUp=${/↑/.test(helpText)}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const helpClosed = await page.locator('[aria-label="Keyboard shortcuts"]').count()
  record('Escape closes the shortcuts list', helpClosed === 0, `dialog=${helpClosed}`)
} catch (e) {
  record('listedit harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== LISTEDIT SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
