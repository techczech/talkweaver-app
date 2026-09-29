// Ledger ⇄ Shelf switching in the built app (ticket 09; ADR-0008): the switch works with no
// talk open, with a talk open, and when Shelf is restored from the saved preference, with no
// renderer error, and keyboard focus and the search filter survive it both ways.
// Regression: with no talk open, the first Ledger → Shelf click looped the scroll-into-view
// layout effect until React gave up (#185, "maximum update depth exceeded").
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-talklist-view-switch-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
function talk(rel, slug, title) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}-outline.md`), `---\noutline_version: 2\ntitle: ${title}\n---\n\n### Opening\n\nWelcome\n`)
}
// Enough rows that Shelf's taller rows run past the viewport, so switching must scroll.
for (const folder of ['agents', 'education', 'research', 'workshops']) {
  for (let i = 1; i <= 6; i += 1) talk(folder, `${folder}-talk-${i}`, `${folder[0].toUpperCase()}${folder.slice(1)} talk ${i}`)
}
talk('', 'root-talk', 'Root talk')
// The file list starts with every folder closed (0.34.0-preview.2 check); these four were opened
// before, as a remembered choice, so the list is long enough to scroll.
const opened = Object.fromEntries(['agents', 'education', 'research', 'workshops'].map((f) => [f, true]))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, talkListFolders: { [vault]: opened } }))

const shots = process.env.TW_SHOTS
const executablePath = process.env.TW_TEST_APP_EXECUTABLE
if (!executablePath) await ensureFreshBuild(resolve('.'))
async function launch() {
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`],
    cwd: resolve('.'), env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`) })
  await page.setViewportSize({ width: 1512, height: 948 }).catch(() => {})
  await page.locator('.tl-tree [data-talk-slug]').first().waitFor()
  return { app, page, errors }
}

const tree = (page) => page.locator('aside.talk-list .tl-tree')
const focused = (page) => tree(page).locator('.tl-row--kfocus, .tl-shrow--kfocus, .tl-fhead--kfocus').first()
  .evaluate((el) => el.getAttribute('data-talk-slug') ?? el.getAttribute('data-folder-path'))
const mode = async (page) => (await page.getByRole('button', { name: 'Shelf view' }).getAttribute('aria-pressed')) === 'true' ? 'shelf' : 'ledger'
const filter = (page) => page.locator('aside.talk-list .tl-search input[aria-label="Filter talks"]').first()

// One switch: click the toolbar button, wait for the other row style, then prove the panel
// is still alive (no error boundary, no renderer error) and a frame later still settled.
async function switchTo(run, target) {
  const { page, errors } = run
  await page.getByRole('button', { name: target === 'shelf' ? 'Shelf view' : 'Ledger view' }).click()
  await tree(page).locator(target === 'shelf' ? '.tl-shrow' : '.tl-row').first().waitFor()
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  assert.equal(await mode(page), target, `the toolbar reads ${target}`)
  assert.equal(await page.locator('.tw-errbound').count(), 0, `no error boundary after switching to ${target}`)
  assert.deepEqual(errors, [], `no renderer error after switching to ${target}`)
}

let run
try {
  run = await launch()
  let { page } = run

  // 1 — no talk open, nothing touched: Ledger → Shelf → Ledger straight after launch.
  assert.equal(await mode(page), 'ledger', 'Ledger is the default')
  assert.equal(await tree(page).locator('[aria-selected="true"]').count(), 0, 'no talk is open')
  const startFocus = await focused(page)
  await switchTo(run, 'shelf')
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'V1-shelf-no-talk.png') })
  assert.equal(await focused(page), startFocus, 'focus survives Ledger → Shelf with no talk open')
  await switchTo(run, 'ledger')
  assert.equal(await focused(page), startFocus, 'focus survives Shelf → Ledger with no talk open')
  console.log(`PASS no talk open: Ledger → Shelf → Ledger, no error, focus kept (${startFocus})`)

  // 2 — no talk open, focus moved down the list by keyboard: the `v` key and the buttons.
  await tree(page).locator('[data-talk-slug="education-talk-3"]').click({ button: 'right' })
  await page.keyboard.press('Escape') // close the menu; the right-click moved focus without opening
  assert.equal(await tree(page).locator('[aria-selected="true"]').count(), 0, 'still no talk open')
  await page.locator('aside.talk-list').focus()
  await page.keyboard.press('ArrowDown')
  const movedFocus = await focused(page)
  assert.ok(movedFocus.startsWith('education-talk-') && movedFocus !== 'education-talk-3', `↓ moved focus (${movedFocus})`)
  await switchTo(run, 'shelf')
  assert.equal(await focused(page), movedFocus, 'focus survives the switch')
  await page.locator('aside.talk-list').focus()
  await page.keyboard.press('v')
  await tree(page).locator('.tl-row').first().waitFor()
  assert.equal(await mode(page), 'ledger', '`v` switches back')
  assert.equal(await focused(page), movedFocus)
  assert.deepEqual(run.errors, [])
  console.log('PASS no talk open, focus moved: buttons and `v`, focus kept')

  // 3 — a talk open and a filter set: the same both ways, focus and filter kept.
  await tree(page).locator('[data-talk-slug="research-talk-2"]').click()
  await tree(page).locator('[data-talk-slug="research-talk-2"][aria-selected="true"]').waitFor()
  await filter(page).fill('talk')
  await tree(page).locator('.tl-row[data-talk-slug]').first().waitFor()
  await page.locator('aside.talk-list').focus()
  await page.keyboard.press('ArrowDown')
  const searchFocus = await focused(page)
  const searchRows = await tree(page).locator('[data-talk-slug]').count()
  await switchTo(run, 'shelf')
  assert.equal(await filter(page).inputValue(), 'talk', 'the filter survives Ledger → Shelf')
  assert.equal(await focused(page), searchFocus, 'focus survives Ledger → Shelf with a talk open')
  await switchTo(run, 'ledger')
  assert.equal(await filter(page).inputValue(), 'talk', 'the filter survives Shelf → Ledger')
  assert.equal(await focused(page), searchFocus, 'focus survives Shelf → Ledger with a talk open')
  assert.equal(await tree(page).locator('[data-talk-slug]').count(), searchRows, 'the same rows are listed')
  await filter(page).fill('')
  console.log(`PASS a talk open: Ledger → Shelf → Ledger with the filter "talk", focus kept (${searchFocus})`)

  // 4 — Shelf restored from the saved preference, no talk open: Shelf → Ledger → Shelf.
  await switchTo(run, 'shelf')
  await run.app.close()
  run = null
  run = await launch()
  page = run.page
  await tree(page).locator('.tl-shrow').first().waitFor()
  assert.equal(await mode(page), 'shelf', 'Shelf is restored from the saved preference')
  const restoredFocus = await focused(page)
  await switchTo(run, 'ledger')
  assert.equal(await focused(page), restoredFocus)
  await switchTo(run, 'shelf')
  assert.equal(await focused(page), restoredFocus)
  console.log('PASS Shelf restored: Shelf → Ledger → Shelf, no error, focus kept')

  assert.deepEqual(run.errors, [])
  console.log('PASS talk list view switch e2e')
} catch (error) {
  if (run) {
    const page = await run.app.firstWindow()
    console.error('Renderer errors:', run.errors.slice(0, 5))
    console.error('Test window:', (await page.locator('body').innerText()).slice(0, 1500))
  }
  throw error
} finally {
  if (run) await run.app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
