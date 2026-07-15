// Real-Electron harness for the Slide Focus surface (PRD B1/B3/B4, ADR-0034, v0.8 Task 9): the
// "zoom in on one slide" view — scoped editing on the left (the reused editor, focus-scoped), a live
// rendered preview on the right (the stage), a where-used strip, prev/next, and detach.
//
// Checks:
//   (a) ⌘⇧F on a slide enters Focus; the crumb names that slide; only its block is visible (focus-scope).
//   (b) the stage iframe renders the slide and REFRESHES ~300ms after an in-band edit (debounced).
//   (c) where-used shows a row per talk carrying the id (a shared slide → two rows, one marked here).
//   (d) detach flushes + re-ids + toasts, and the strip collapses to the one remaining use.
//   (e) prev/next walks the compiled order; an unstamped slide reads "only here so far".
//   (f) Esc returns to the workspace (the toolbar is back, Focus is gone).
//   (g) ↵ on a Browser card enters Focus on that slide.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-slide-focus.mjs
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

// Focus Fixture: three content slides — a SHARED-id slide (also in Sister Talk), a local-only stamped
// slide, and a FRESH unstamped slide (B4). Sister Talk carries the same id with a different body so
// the where-used strip shows a second (diverged) row.
const FIX = [
  '---', 'title: Focus Fixture', '---', '',
  '## Overview', '',
  '### Shared idea slide', '{statement}{id=shared11}', '',
  'This slide is shared across two talks.', '',
  '- point one', '- point two', '',
  '### Local only slide', '{plain}{id=local22}', '',
  'Only this talk carries this id.', '',
  '### Fresh unstamped slide', '',
  'No id yet, so only here so far.', '',
  '- a bullet', ''
].join('\n')
const SISTER = [
  '---', 'title: Sister Talk', '---', '',
  '## Reuse', '',
  '### Shared idea slide', '{statement}{id=shared11}', '',
  'A slightly different wording of the shared idea.', '',
  '- point one', ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-focus-' + String(Date.now()) + '-'))
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const fxDir = join(tempVault, 'focus-fixture')
const sisDir = join(tempVault, 'sister-talk')
mkdirSync(fxDir, { recursive: true })
mkdirSync(sisDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
writeFileSync(join(fxDir, 'focus-fixture-outline.md'), FIX)
writeFileSync(join(sisDir, 'sister-talk-outline.md'), SISTER)
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const visibleLines = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent))
const has = (arr, needle) => arr.some((l) => (l || '').includes(needle))
const srcdoc = () => page.locator('.lt-stage-frame').getAttribute('srcdoc').catch(() => '')
const bodyText = () => page.evaluate(() => document.body.innerText)

async function selectTalk(name) {
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(1700) // let the debounced compile land so slideLines is aligned
}
async function clickLine(text) {
  await page.locator('.cm-content .cm-line', { hasText: text }).first().click()
  await page.waitForTimeout(150)
}

try {
  await selectTalk('Focus Fixture')

  // ── (a) enter Focus via ⌘⇧F on the Shared idea slide ──────────────────────
  await clickLine('### Shared idea slide')
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForSelector('.lt-focus', { timeout: 6000 })
  await page.waitForTimeout(400)
  {
    const inFocus = (await page.locator('.lt-focus').count()) === 1
    const crumb = (await page.locator('.lt-c-slide').textContent().catch(() => '')) || ''
    record('⌘⇧F enters Focus and the crumb names the focused slide',
      inFocus && crumb.trim() === 'Shared idea slide', `crumb=${JSON.stringify(crumb)}`)
  }

  // ── (a2) focus-scope: only the focused slide's block is visible ────────────
  {
    const vis = await visibleLines()
    const ok = has(vis, '### Shared idea slide') && has(vis, 'This slide is shared across two talks.') &&
      !has(vis, '### Local only slide') && !has(vis, '### Fresh unstamped slide') && !has(vis, '## Overview')
    record('Focus scopes the editor to only this slide (others hidden)', ok, `visible=${JSON.stringify(vis)}`)
  }

  // ── (c) where-used strip: two talks carry the id, current marked "here" ────
  await page.waitForTimeout(400)
  {
    const rows = await page.locator('.lt-wu-row').count()
    const here = await page.locator('.lt-wu-row .lt-ws', { hasText: 'here' }).count()
    const badges = await page.locator('.lt-wu-row .lt-badge').count()
    record('where-used shows a row per talk (shared slide → 2), current marked "here"',
      rows === 2 && here === 1 && badges === 2, `rows=${rows} here=${here} badges=${badges}`)
  }

  // ── (b) the stage renders the slide, and refreshes after an in-band edit ───
  {
    const first = (await srcdoc()) || ''
    const rendered = first.includes('Shared idea slide')
    await clickLine('This slide is shared across two talks.')
    await page.keyboard.press('End')
    await page.keyboard.type(' EDITEDXYZ')
    await page.waitForTimeout(900) // > 300ms preview debounce
    const after = (await srcdoc()) || ''
    record('stage renders the slide and refreshes (debounced) after an in-band edit',
      rendered && after.includes('EDITEDXYZ'), `rendered=${rendered} updated=${after.includes('EDITEDXYZ')}`)
  }

  // ── (d) detach: flush + re-id + toast, strip collapses to the one use ──────
  await page.locator('.lt-wu-detach').click()
  await page.waitForSelector('.lt-focus-confirm', { timeout: 4000 })
  await page.locator('.lt-focus-confirm .cf-btn.danger').click()
  await page.waitForTimeout(1400)
  {
    const toasted = /Detached — new id/.test(await bodyText())
    const rows = await page.locator('.lt-wu-row').count()
    record('detach re-ids the slide (toast) and the strip drops to the one remaining use',
      toasted && rows === 1, `toast=${toasted} rows=${rows}`)
  }

  // ── (e) prev/next walks the order; unstamped slide reads "only here" ───────
  await page.locator('.lt-stage-arrow.next').click()
  await page.waitForTimeout(400)
  {
    const crumb = (await page.locator('.lt-c-slide').textContent().catch(() => '')) || ''
    record('next walks to the following slide', crumb.trim() === 'Local only slide', `crumb=${JSON.stringify(crumb)}`)
  }
  await page.locator('.lt-stage-arrow.next').click()
  await page.waitForTimeout(500)
  {
    const crumb = (await page.locator('.lt-c-slide').textContent().catch(() => '')) || ''
    const none = await page.locator('.lt-wu-none').count()
    const noDetach = await page.locator('.lt-wu-detach').count()
    record('unstamped slide is honest: "only here so far", no detach',
      crumb.trim() === 'Fresh unstamped slide' && none === 1 && noDetach === 0,
      `crumb=${JSON.stringify(crumb)} none=${none} detach=${noDetach}`)
  }

  // ── (f) Esc returns to the workspace ──────────────────────────────────────
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  record('Esc returns to the workspace (toolbar back, Focus gone)',
    (await page.locator('.lt-focus').count()) === 0 && (await page.locator('.workspace-toolbar').count()) === 1)

  // ── (g) ↵ on a Browser card enters Focus ──────────────────────────────────
  await page.keyboard.press('Meta+k')
  await page.waitForSelector('.lt-browser-root', { timeout: 4000 })
  await page.locator('.lt-searchfield input').fill('Local only')
  await page.waitForTimeout(700)
  await page.keyboard.press('ArrowDown') // move focus into the grid (blurs the search field)
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  record('↵ on a Browser card enters Focus on that slide',
    (await page.locator('.lt-focus').count()) === 1, `crumb=${JSON.stringify((await page.locator('.lt-c-slide').textContent().catch(() => '')) || '')}`)

  // ── (h) editing shifts later slides' lines; paging must NOT un-scope (finding 1) ────────────
  // slideLines' heading lines come from the stale compiledSlides.source_line for up to the ~900ms
  // compile debounce. If we grow THIS slide's block and page before the compile lands, the target
  // slide's stale line points inside the grown block (a non-heading) → focusStep must stay put rather
  // than hand the editor a null range that un-scopes it to the whole outline.
  await page.keyboard.press('Escape'); await page.waitForTimeout(250) // leave case (g)'s Browser-origin Focus
  await page.keyboard.press('Escape'); await page.waitForTimeout(300) // …then close the reopened Browser
  await clickLine('### Shared idea slide')
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForSelector('.lt-focus', { timeout: 6000 })
  await page.waitForTimeout(1700) // start from a compile-aligned band
  await clickLine('This slide is shared across two talks.')
  await page.keyboard.press('End')
  await page.keyboard.type('\nSHIFTA\nSHIFTB\nSHIFTC\nSHIFTD') // grow the block → later lines go stale
  // page immediately (well within the 900ms compile debounce) via the stage arrow — reachable even
  // with the caret in the editor, and it drives focusStep directly.
  await page.locator('.lt-stage-arrow.next').click()
  await page.waitForTimeout(200)
  {
    const vis = await visibleLines()
    const headings = vis.filter((l) => /^###\s/.test((l || '').trim())).length
    const overview = has(vis, '## Overview')
    record('editing then paging keeps the editor scoped (never un-scopes to the whole outline)',
      headings <= 1 && !overview, `headings=${headings} overview=${overview}`)
  }
  // once the compile re-aligns slideLines, paging works normally to the next slide
  await page.waitForTimeout(1700)
  await page.locator('.lt-stage-arrow.next').click()
  await page.waitForTimeout(500)
  {
    const vis = await visibleLines()
    const headings = vis.filter((l) => /^###\s/.test((l || '').trim())).length
    const crumb = ((await page.locator('.lt-c-slide').textContent().catch(() => '')) || '').trim()
    record('after the compile re-aligns, paging advances to the next single scoped slide',
      headings === 1 && crumb === 'Local only slide', `headings=${headings} crumb=${JSON.stringify(crumb)}`)
  }

  // ── (i) deleting the focused slide (⌘⇧P → "Delete current slide") exits Focus (finding 2) ────
  await page.keyboard.press('Escape'); await page.waitForTimeout(300) // back to the workspace
  await clickLine('### Local only slide')
  await page.keyboard.press('Meta+Shift+f')
  await page.waitForSelector('.lt-focus', { timeout: 6000 })
  await page.waitForTimeout(500)
  const beforeDelete = (await page.locator('.lt-focus').count()) === 1
  await page.keyboard.press('Meta+Shift+p')
  await page.waitForSelector('.command-menu', { timeout: 4000 })
  await page.locator('.command-menu-input').fill('Delete current slide')
  await page.waitForTimeout(200)
  await page.locator('.command-menu-item', { hasText: 'Delete current slide' }).first().click()
  await page.waitForTimeout(700)
  {
    const exited = (await page.locator('.lt-focus').count()) === 0
    const toolbar = (await page.locator('.workspace-toolbar').count()) === 1
    const gone = !has(await visibleLines(), '### Local only slide')
    record('delete-slide while in Focus exits Focus (back to the workspace)',
      beforeDelete && exited && toolbar, `before=${beforeDelete} exited=${exited} toolbar=${toolbar} slideRemoved=${gone}`)
  }
} catch (e) {
  record('slide-focus harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== SLIDE-FOCUS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
