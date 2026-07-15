// Real-Electron harness for the focus-scope extension (ADR-0032, Task 8): a scoped VIEW onto the
// SAME outline document that shows/edits ONLY one slide's line range while everything else is hidden
// and edit-guarded. Focus is driven through the `tw-focus-scope` window event (the e2e seam that
// mirrors KEYMAP_CHANGED_EVENT) until Task 9 builds the Slide Focus surface.
//
// Checks, with focus set on the "Slide Two" block (doc lines 12-15):
//   (a) lines OUTSIDE the range are not rendered/editable (Slide One, Slide Three, ## Section gone).
//   (b) the gutter shows the TRUE outline line numbers of the visible band (12,13,14,15) — not 1-4.
//   (c) typing INSIDE the band works and autosaves to the SAME on-disk file (proves shared doc).
//   (d) an edit that would TOUCH OUTSIDE the band is blocked (forward-Delete at the band end that
//       would merge the hidden line above Slide Three — file's blank line survives = guard held).
//   (e) with the range cleared (null) the editor is unchanged — every slide visible again.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-focus-scope.mjs
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

// Three slides, each heading + Trigger line ({id=…}) + blank + body. The blank line between Slide
// Two's body and Slide Three's heading is the boundary the guard must protect (check d).
const LINES = [
  '---',                        // 1
  'title: FS Fixture',          // 2
  '---',                        // 3
  '',                           // 4
  '## Section',                 // 5
  '',                           // 6
  '### Slide One',              // 7
  '{statement}{id=aaa111}',     // 8
  '',                           // 9
  'Body of slide one alpha.',   // 10
  '',                           // 11
  '### Slide Two',              // 12
  '{cards}{id=bbb222}',         // 13
  '',                           // 14
  'Body of slide two beta.',    // 15
  '',                           // 16
  '### Slide Three',            // 17
  '{plain}{id=ccc333}',         // 18
  '',                           // 19
  'Body of slide three gamma.', // 20
  ''                            // 21
]
const FIX = LINES.join('\n')

// Slide Two's block: from the start of its heading line to the end of its body line's content.
const RANGE_FROM = FIX.indexOf('### Slide Two')
const RANGE_TO = FIX.indexOf('Body of slide two beta.') + 'Body of slide two beta.'.length
const START_LINE = FIX.slice(0, RANGE_FROM).split('\n').length // 12
const END_LINE = FIX.slice(0, RANGE_TO).split('\n').length // 15
const EXPECTED_GUTTER = []
for (let n = START_LINE; n <= END_LINE; n += 1) EXPECTED_GUTTER.push(n)

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-fs-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const fxDir = join(tempVault, 'fs-fixture')
mkdirSync(fxDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const otherDir = join(tempVault, 'other-talk')
mkdirSync(otherDir, { recursive: true })
writeFileSync(join(otherDir, 'other-talk-outline.md'), '---\ntitle: Other\n---\n\n## X\n\n### Y\n{a}{id=zzz999}\n\nbody\n')
const fxPath = join(fxDir, 'fs-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function visibleLines() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent)
  )
}
async function gutterNumbers() {
  // CM's line-number gutter appends a hidden width-measurement spacer (an all-9s sample, e.g. "99")
  // with inline `visibility: hidden` — exclude it so we read only the REAL, rendered line numbers.
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-lineNumbers .cm-gutterElement'))
      .filter((e) => window.getComputedStyle(e).visibility !== 'hidden')
      .map((e) => (e.textContent || '').trim())
      .filter((t) => /^\d+$/.test(t))
      .map(Number)
  )
}
async function setFocus(from, to) {
  await page.evaluate(
    ([f, t]) => window.dispatchEvent(new CustomEvent('tw-focus-scope', { detail: { from: f, to: t } })),
    [from, to]
  )
  await page.waitForTimeout(250)
}
async function clearFocus() {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-focus-scope', { detail: null })))
  await page.waitForTimeout(200)
}
async function selectTalk(name) {
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(400)
}
async function reset() {
  writeFileSync(fxPath, FIX)
  await selectTalk('Other Talk')
  await selectTalk('Fs Fixture')
  await clearFocus()
}
async function clickLine(text) {
  await page.locator('.cm-content .cm-line', { hasText: text }).first().click()
  await page.waitForTimeout(120)
}
function has(arr, needle) {
  return arr.some((l) => (l || '').includes(needle))
}
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

try {
  await selectTalk('Fs Fixture')

  // (a) lines outside the focused range are hidden; only the band's lines render.
  await reset()
  await setFocus(RANGE_FROM, RANGE_TO)
  {
    const vis = await visibleLines()
    const ok =
      has(vis, '### Slide Two') &&
      has(vis, 'Body of slide two beta.') &&
      !has(vis, '### Slide One') &&
      !has(vis, '### Slide Three') &&
      !has(vis, '## Section')
    record(
      'focused: only Slide Two block is visible (Slide One/Three + Section hidden)',
      ok,
      `visibleLines=${JSON.stringify(vis)}`
    )
  }

  // (b) the gutter shows the TRUE line numbers of the visible band (12-15), not renumbered 1-4.
  {
    const nums = await gutterNumbers()
    record(
      'focused: gutter shows the real outline line numbers of the band',
      sameArr(nums, EXPECTED_GUTTER),
      `got=${JSON.stringify(nums)} expected=${JSON.stringify(EXPECTED_GUTTER)}`
    )
  }

  // (c) typing inside the band works and autosaves to the SAME file (shared doc, not a copy).
  await reset()
  await setFocus(RANGE_FROM, RANGE_TO)
  await clickLine('Body of slide two beta.')
  await page.keyboard.press('End')
  await page.keyboard.type(' EDITED')
  await page.waitForTimeout(200)
  {
    const vis = await visibleLines()
    const shownEdited = has(vis, 'Body of slide two beta. EDITED')
    await page.waitForTimeout(1800) // autosave debounce is 1500ms
    const onDisk = readFileSync(fxPath, 'utf8')
    const savedEdited = onDisk.includes('Body of slide two beta. EDITED')
    // The rest of the outline (a hidden slide) is untouched on disk — proves same-doc editing.
    const othersIntact = onDisk.includes('Body of slide one alpha.') && onDisk.includes('Body of slide three gamma.')
    record(
      'focused: typing inside the band edits + autosaves the shared outline file',
      shownEdited && savedEdited && othersIntact,
      `shown=${shownEdited} saved=${savedEdited} othersIntact=${othersIntact}`
    )
  }

  // (d) an edit that touches OUTSIDE the band is blocked: forward-Delete at the band end would merge
  // the hidden blank line (16) into the body — the guard rejects it, so the file's blank line before
  // "### Slide Three" survives (double newline intact) and nothing autosaves.
  await reset()
  await setFocus(RANGE_FROM, RANGE_TO)
  await clickLine('Body of slide two beta.')
  await page.keyboard.press('End')
  await page.keyboard.press('Delete') // forward-delete the newline at the band's upper edge
  await page.waitForTimeout(1800)
  {
    const vis = await visibleLines()
    const bandIntact = has(vis, 'Body of slide two beta.') && !has(vis, 'Body of slide two beta.### Slide Three')
    const onDisk = readFileSync(fxPath, 'utf8')
    const blankSurvived = onDisk.includes('Body of slide two beta.\n\n### Slide Three')
    record(
      'focused: an edit touching outside the band is blocked (boundary newline survives)',
      bandIntact && blankSurvived,
      `bandIntact=${bandIntact} blankSurvived=${blankSurvived}`
    )
  }

  // (d2) caret containment: arrowing past the band end can't escape it — a following keystroke lands
  // INSIDE the band (appended to the last visible line), never on the hidden Slide Three.
  await reset()
  await setFocus(RANGE_FROM, RANGE_TO)
  await clickLine('Body of slide two beta.')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('Z')
  await page.waitForTimeout(200)
  {
    const vis = await visibleLines()
    const containedInBand = has(vis, 'Body of slide two beta.Z')
    const notOnHidden = !has(vis, '### Slide Three') && !has(vis, 'Body of slide three gamma.Z')
    record(
      'focused: caret is contained — arrow-past-the-end then typing stays inside the band',
      containedInBand && notOnHidden,
      `containedInBand=${containedInBand} notOnHidden=${notOnHidden} visible=${JSON.stringify(vis)}`
    )
  }

  // (e) clearing the range (null) restores the full outline — every slide visible again.
  await reset()
  await setFocus(RANGE_FROM, RANGE_TO)
  await clearFocus()
  {
    const vis = await visibleLines()
    const allBack = has(vis, '### Slide One') && has(vis, '### Slide Two') && has(vis, '### Slide Three')
    record(
      'range cleared: the full outline is shown again (extension inert)',
      allBack,
      `visibleHeadings=${JSON.stringify(vis.filter((l) => (l || '').includes('###')))}`
    )
  }
} catch (e) {
  record('focus-scope harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== FOCUS-SCOPE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
