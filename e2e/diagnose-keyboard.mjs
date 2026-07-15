// Real-Electron harness for the outliner keyboard shortcuts (ADR-0019/0005).
// Isolated temp vault + userData; a fixture talk with headings, slides, lists, paragraphs.
// Each check sets the fixture fresh, places the caret on a line, presses the combo, and reads
// the live doc back from the editor.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-keyboard.mjs
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
  '---',
  'title: KB Fixture',
  '---',
  '',
  '## Section A',
  '',
  '### Slide A1',
  '',
  'Alpha one.',
  'Alpha two.',
  '',
  '### Slide A2',
  '',
  '- Item one',
  '  - Sub one a',
  '  - Sub one b',
  '- Item two',
  '- Item three',
  '',
  '## Section B',
  '',
  '### Slide B1',
  '',
  'Beta body.',
  ''
].join('\n')

// ── isolated temp vault ──
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-kb-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const fxDir = join(tempVault, 'kb-fixture')
mkdirSync(fxDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
// a second talk so we can toggle selection to force a fresh reload between checks
const otherDir = join(tempVault, 'other-talk')
mkdirSync(otherDir, { recursive: true })
writeFileSync(join(otherDir, 'other-talk-outline.md'), '---\ntitle: Other\n---\n\n## X\n\n### Y\n\nbody\n')
const fxPath = join(fxDir, 'kb-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function readDoc() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n')
  )
}
async function selectTalk(name) {
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(400)
}
// Reset the fixture to a clean state and load it fresh (write to disk, toggle selection so
// Editor's load-on-outlinePath-change fires). Switch AWAY first so any pending edit on the fixture is
// flushed to disk by the talk-switch-boundary flush (data-loss guard, 2026-07-05) BEFORE we overwrite
// the file — otherwise that flush would land AFTER our writeFileSync and clobber the clean fixture.
async function reset() {
  await selectTalk('Other Talk')
  writeFileSync(fxPath, FIX)
  await selectTalk('Kb Fixture')
}
async function clickLine(text) {
  await page.locator('.cm-content .cm-line', { hasText: text }).first().click()
  await page.waitForTimeout(120)
}
function idx(doc, needle) {
  return doc.split('\n').findIndex((l) => l.includes(needle))
}

try {
  await selectTalk('Kb Fixture')

  // 1. ⌘⇧↓ move heading SECTION down (Section A swaps below Section B)
  await reset()
  await clickLine('## Section A')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.waitForTimeout(200)
  let doc = await readDoc()
  record('⌘⇧↓ moves whole heading section', idx(doc, '## Section B') < idx(doc, '## Section A') && idx(doc, '## Section A') !== -1, `B@${idx(doc, '## Section B')} A@${idx(doc, '## Section A')}`)

  // 2. ⌘⇧↓ move a slide (###) down within its section (A1 swaps with A2)
  await reset()
  await clickLine('### Slide A1')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('⌘⇧↓ moves a slide within its section', idx(doc, '### Slide A2') < idx(doc, '### Slide A1'), `A2@${idx(doc, '### Slide A2')} A1@${idx(doc, '### Slide A1')}`)

  // 3. ⌘⇧↓ move a top-level list item WITH its sub-items
  await reset()
  await clickLine('- Item one')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.waitForTimeout(200)
  doc = await readDoc()
  {
    const two = idx(doc, '- Item two')
    const one = idx(doc, '- Item one')
    const subA = idx(doc, 'Sub one a')
    record('⌘⇧↓ moves list item + sub-items', two < one && subA === one + 1, `two@${two} one@${one} subA@${subA}`)
  }

  // 4. ⌘⇧↓ move a plain paragraph line
  await reset()
  await clickLine('Alpha one.')
  await page.keyboard.press('Meta+Shift+ArrowDown')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('⌘⇧↓ moves a paragraph line', idx(doc, 'Alpha two.') < idx(doc, 'Alpha one.'), `two@${idx(doc, 'Alpha two.')} one@${idx(doc, 'Alpha one.')}`)

  // 5. ⌘⇧→ demote ONLY the current heading line (### → ####), children unchanged
  await reset()
  await clickLine('### Slide A1')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('⌘⇧→ demotes only the current heading line', doc.includes('#### Slide A1') && doc.includes('### Slide A2'), `A1 demoted=${doc.includes('#### Slide A1')} A2 intact=${doc.includes('### Slide A2')}`)

  // 6. ⌘⇧← promote the current heading line (## → #)
  await reset()
  await clickLine('## Section A')
  await page.keyboard.press('Meta+Shift+ArrowLeft')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('⌘⇧← promotes the current heading line', doc.split('\n').some((l) => l === '# Section A'), `has "# Section A"=${doc.split('\n').some((l) => l === '# Section A')}`)

  // 7. ⌘⌥⇧→ demote heading + subtree (## Section A → ### and its ### slides → ####)
  await reset()
  await clickLine('## Section A')
  await page.keyboard.press('Meta+Alt+Shift+ArrowRight')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('⌘⌥⇧→ demotes heading + subtree', doc.includes('### Section A') && doc.includes('#### Slide A1') && doc.includes('#### Slide A2'), `secA=${doc.includes('### Section A')} A1=${doc.includes('#### Slide A1')} A2=${doc.includes('#### Slide A2')}`)

  // 8. ⌘⇧→ demote (indent) a list item by one level
  await reset()
  await clickLine('- Item two')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(200)
  doc = await readDoc()
  record('⌘⇧→ indents a list item one level', doc.split('\n').some((l) => l === '  - Item two'), `has "  - Item two"=${doc.split('\n').some((l) => l === '  - Item two')}`)
} catch (e) {
  record('keyboard harness completed without throwing', false, String(e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== KEYBOARD SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
