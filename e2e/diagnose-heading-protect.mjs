// Real-Electron harness for slide-title (heading-marker) protection (ADR-0032, Gate-4).
// A heading line must stay a heading after any user edit unless the whole slide is deleted:
//   • ⌘⌫ from the end of a title clears the TITLE TEXT but stops at `### ` (marker survives).
//   • Backspace / ⌘⌫ AT the marker refuses (warning toast), so the marker is never nibbled.
//   • Selecting the whole heading line and pressing Delete is blocked (warning) — it would orphan
//     the Trigger line below.
//   • ⌘⇧⌫ (Delete-slide) still removes the whole slide, heading + Trigger line included.
//   • Re-levelling (⌘⇧→) and ordinary title editing are unaffected.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-heading-protect.mjs
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

// Two full slides — each a heading + a Trigger line carrying an {id=…} + a body line. The Trigger
// line below the title is what a wiped title used to orphan, so protecting the title protects it.
const FIX = [
  '---',
  'title: HP Fixture',
  '---',
  '',
  '## Section',
  '',
  '### Slide One',
  '{statement}{id=aaa111}',
  '',
  'Body of slide one.',
  '',
  '### Slide Two',
  '{cards}{id=bbb222}',
  '',
  'Body of slide two.',
  '',
  '## More',
  '',
  'Adjacent prev line.',
  '### Adjacent Heading', // deliberately NO blank line above — a content line butts the heading
  '{plain}{id=ccc333}',
  '',
  'Adjacent body.',
  ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-hp-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const fxDir = join(tempVault, 'hp-fixture')
mkdirSync(fxDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const otherDir = join(tempVault, 'other-talk')
mkdirSync(otherDir, { recursive: true })
writeFileSync(join(otherDir, 'other-talk-outline.md'), '---\ntitle: Other\n---\n\n## X\n\n### Y\n{a}{id=zzz999}\n\nbody\n')
const fxPath = join(fxDir, 'hp-fixture-outline.md')
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
async function reset() {
  // Switch AWAY first so any pending edit on the fixture is flushed to disk by the talk-switch-boundary
  // flush (data-loss guard, 2026-07-05) BEFORE we overwrite the file — otherwise that flush would land
  // AFTER our writeFileSync and clobber the clean fixture. Then restore the file, then switch back to
  // load it fresh.
  await selectTalk('Other Talk')
  writeFileSync(fxPath, FIX)
  await selectTalk('Hp Fixture')
}
async function clickLine(text) {
  await page.locator('.cm-content .cm-line', { hasText: text }).first().click()
  await page.waitForTimeout(120)
}
// Dismiss any lingering toasts so a fresh warning is unambiguous. Done BEFORE placing the caret so
// clicking Dismiss (which pulls focus) can't disturb the selection we're about to act on.
async function clearToasts() {
  for (let i = 0; i < 6; i += 1) {
    const btn = page.locator('[role="status"] button[aria-label="Dismiss"]').first()
    if ((await btn.count().catch(() => 0)) === 0) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(60)
  }
}
async function toastText() {
  return page.locator('[role="status"]').innerText().catch(() => '')
}
function warned(t) {
  return /A slide title has to stay/.test(t)
}
function has(doc, needle) {
  return doc.includes(needle)
}

try {
  await selectTalk('Hp Fixture')

  // (a) ⌘⌫ from the END of a title clears the title TEXT but keeps the `### ` marker.
  await reset()
  await clearToasts()
  await clickLine('### Slide One')
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+Backspace')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const markerKept = doc.split('\n').some((l) => /^###\s*$/.test(l))
    record(
      '⌘⌫ clears the title text but keeps the ### marker (slide still compiles)',
      markerKept && !has(doc, 'Slide One') && has(doc, '{id=aaa111}'),
      `markerKept=${markerKept} titleGone=${!has(doc, 'Slide One')} idKept=${has(doc, '{id=aaa111}')}`
    )
  }

  // (b) Backspace AT the marker (caret just after `### `) refuses — no deletion + warning.
  await reset()
  await clearToasts()
  await clickLine('### Slide One')
  await page.keyboard.press('Home')
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight') // caret at markerEnd of `### `
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      'Backspace at the marker is refused (title intact, no ###Slide One) + warning',
      has(doc, '### Slide One') && !has(doc, '###Slide One') && warned(t),
      `intact=${has(doc, '### Slide One')} notEaten=${!has(doc, '###Slide One')} warned=${warned(t)}`
    )
  }

  // (b2) ⌘⌫ AT the marker (nothing before it but the marker) is refused too.
  await reset()
  await clearToasts()
  await clickLine('### Slide One')
  await page.keyboard.press('Home')
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Meta+Backspace')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      '⌘⌫ at the marker is refused (title intact) + warning',
      has(doc, '### Slide One') && warned(t),
      `intact=${has(doc, '### Slide One')} warned=${warned(t)}`
    )
  }

  // (c) Select the whole heading line + Delete → blocked (would orphan the Trigger line) + warning.
  await reset()
  await clearToasts()
  await clickLine('### Slide Two')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End') // select the heading line's text
  await page.keyboard.press('Delete')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      'Selecting the heading line + Delete is blocked + warning',
      has(doc, '### Slide Two') && has(doc, '{id=bbb222}') && warned(t),
      `headingKept=${has(doc, '### Slide Two')} idKept=${has(doc, '{id=bbb222}')} warned=${warned(t)}`
    )
  }

  // (d) ⌘⇧⌫ (Delete-slide) STILL removes the whole slide — heading + Trigger line + body.
  await reset()
  await clearToasts()
  await clickLine('### Slide Two')
  await page.keyboard.press('Meta+Shift+Backspace')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    record(
      '⌘⇧⌫ deletes the whole slide (heading + Trigger id gone), other slide intact',
      !has(doc, 'Slide Two') && !has(doc, '{id=bbb222}') && has(doc, '### Slide One'),
      `twoGone=${!has(doc, 'Slide Two')} idGone=${!has(doc, '{id=bbb222}')} oneKept=${has(doc, '### Slide One')}`
    )
  }

  // (e) Re-level (⌘⇧→) still demotes a heading marker — it stays a heading.
  await reset()
  await clearToasts()
  await clickLine('### Slide One')
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    record(
      '⌘⇧→ re-levels the heading (### → ####) — still a heading',
      has(doc, '#### Slide One'),
      `demoted=${has(doc, '#### Slide One')}`
    )
  }

  // (f) Ordinary title editing is unaffected — typing at the end of a title just appends.
  await reset()
  await clearToasts()
  await clickLine('### Slide One')
  await page.keyboard.press('End')
  await page.keyboard.type(' Edited')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      'Typing into a title is unaffected (no warning)',
      has(doc, '### Slide One Edited') && !warned(t),
      `edited=${has(doc, '### Slide One Edited')} noWarn=${!warned(t)}`
    )
  }

  // (g) ⌘⌫ on a NON-heading line keeps its default behaviour (delete to line start).
  await reset()
  await clearToasts()
  await clickLine('Body of slide one.')
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+Backspace')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      '⌘⌫ on a non-heading line still deletes to line start (default), no warning',
      !has(doc, 'Body of slide one.') && !warned(t),
      `cleared=${!has(doc, 'Body of slide one.')} noWarn=${!warned(t)}`
    )
  }

  // (h) forward-Delete at the END of a NON-EMPTY line directly above a heading would eat the joining
  // newline and MERGE the heading up ("Adjacent prev line.### Adjacent Heading") — the exact orphan
  // bug. Must be blocked + warned, with the heading, its marker and the Trigger id all left intact.
  await reset()
  await clearToasts()
  await clickLine('Adjacent prev line.')
  await page.keyboard.press('End')
  await page.keyboard.press('Delete') // forward-delete the newline before the heading
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      'forward-Delete merging a heading into the non-empty line above is blocked + warning',
      has(doc, '### Adjacent Heading') &&
        !has(doc, 'Adjacent prev line.### Adjacent Heading') &&
        has(doc, '{id=ccc333}') &&
        warned(t),
      `headingKept=${has(doc, '### Adjacent Heading')} notMerged=${!has(doc, 'Adjacent prev line.### Adjacent Heading')} idKept=${has(doc, '{id=ccc333}')} warned=${warned(t)}`
    )
  }

  // (i) A PURE INSERTION at column 0 of a heading (Enter above it) is allowed — it pushes the intact
  // heading down a line, so the heading survives. Proves the guard doesn't over-block insertions.
  await reset()
  await clearToasts()
  await clickLine('### Slide One')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  {
    const doc = await readDoc()
    const t = await toastText()
    record(
      'Enter at column 0 of a heading is allowed (heading survives, no warning)',
      has(doc, '### Slide One') && !warned(t),
      `headingKept=${has(doc, '### Slide One')} noWarn=${!warned(t)}`
    )
  }
} catch (e) {
  record('heading-protect harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== HEADING-PROTECT SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
