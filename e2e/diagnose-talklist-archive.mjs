// File list tidy (ticket 03; ADR-0029 §3; frames L1, L2), end to end in the built app: the
// Archive last, dimmed and collapsed; opening it shows its four folders with counts; a second
// line on every Ledger row (the two "Vibecoding As Pedagogy" rows differ); keyboard over
// two-line rows; folder open/closed state surviving a quit and relaunch; Shelf rows unchanged.
// 0.34.0-preview.2 check (26 Sep): every folder starts closed and a remembered choice wins; / from
// outside the list (focus not in the talk editor or a field) puts the caret in the search box.
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-talklist-archive-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
function talk(rel, slug, fm) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}-outline.md`), `---\noutline_version: 2\n${fm}\n---\n\n### Opening\n\nWelcome\n`)
}
const ARCHIVE = 'z-old-powerpoint-imports'
talk('ai-in-education', 'vibecoding-as-pedagogy-neurology-workshop', 'title: Vibecoding As Pedagogy\nevent: Clinical Neuroscience')
talk('ai-in-education/jersey-2026', 'vibecoding-as-pedagogy', 'title: Vibecoding As Pedagogy\nevent: Jersey College for Girls AI in Education conference')
talk('agents-2026', 'the-age-of-the-claw', 'title: The Age of the Claw')
talk('agents-2026', 'year-of-agents', 'title: AI 2026 - Year of Agents and Claws')
talk('zebra', 'stripes', 'title: Stripes')
talk(`${ARCHIVE}/ai-mapping-the-landscape`, 'alternatives-to-chatgpt', 'title: Alternatives to ChatGPT')
talk(`${ARCHIVE}/ai-mapping-the-landscape`, 'custom-bots', 'title: "Custom Bots: From GPTs to AI apps"')
talk(`${ARCHIVE}/ai-for-research`, 'research-one', 'title: Research One')
talk(`${ARCHIVE}/ai-for-students`, 'students-one', 'title: Students One')
talk(`${ARCHIVE}/ai-overviews-webinars`, 'webinar-one', 'title: Webinar One')
mkdirSync(join(vault, '_PRESENTATIONS', 'vibecoding-as-pedagogy-neurology-workshop'), { recursive: true })
writeFileSync(join(vault, '_PRESENTATIONS', 'vibecoding-as-pedagogy-neurology-workshop', 'run-1.json'), JSON.stringify({
  id: 'run-1', talkSlug: 'vibecoding-as-pedagogy-neurology-workshop', kind: 'delivery', status: 'delivered', startedAt: '2026-07-10T09:30:00'
}))
const configFile = join(userData, 'config.json')
writeFileSync(configFile, JSON.stringify({ vaultRoot: vault }))
const given = new Date().getFullYear() === 2026 ? 'given 10 Jul' : 'given 10 Jul 2026'

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
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1512, height: 948 }).catch(() => {})
  await page.locator('.tl-tree [data-folder-path]').first().waitFor()
  return { app, page, errors }
}
const header = (page, path) => page.locator(`.tl-tree [data-folder-path="${path}"]`)
const expanded = async (page, path) => (await header(page, path).getAttribute('aria-expanded')) === 'true'
const storedState = () => {
  try { return JSON.parse(readFileSync(configFile, 'utf8')).talkListFolders?.[vault] ?? {} } catch { return {} }
}
async function waitStored(predicate, label) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate(storedState())) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`stored folder state never reached: ${label} — ${JSON.stringify(storedState())}`)
}

let run
try {
  run = await launch()
  let { page } = run

  // L1 — the Archive is last, labelled, dimmed and collapsed on first launch.
  const heads = page.locator('.tl-tree .tl-fhead')
  const last = heads.last()
  assert.equal(await last.getAttribute('data-folder-path'), ARCHIVE)
  assert.equal(await last.locator('.tl-fname').innerText(), 'Archive · old PowerPoint imports')
  assert.equal(await last.locator('.tl-fcount').innerText(), '5', 'the Archive counts its subfolders')
  assert.match(await last.getAttribute('class'), /is-archive/)
  assert.equal(await expanded(page, ARCHIVE), false, 'collapsed on first launch')
  const [nameColor, normalColor] = await Promise.all([
    last.locator('.tl-fname').evaluate((el) => getComputedStyle(el).color),
    heads.first().locator('.tl-fname').evaluate((el) => getComputedStyle(el).color)
  ])
  assert.notEqual(nameColor, normalColor, 'the Archive label is dimmed')
  assert.equal(await page.locator(`[data-folder-path^="${ARCHIVE}/"]`).count(), 0, 'nothing inside shows until opened')
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L1-at-rest.png') })
  console.log('PASS L1: Archive last, "Archive · old PowerPoint imports", count 5, dimmed, collapsed')

  // Folders start collapsed (0.34.0-preview.2 check): on first launch every folder is closed and no
  // talk inside one shows.
  const topHeads = await page.locator('.tl-tree .tl-fhead').evaluateAll((els) => els.map((el) => [el.getAttribute('data-folder-path'), el.getAttribute('aria-expanded')]))
  assert.deepEqual(topHeads.map(([p]) => p).sort(), ['agents-2026', 'ai-in-education', 'zebra', ARCHIVE].sort(), 'only the top-level folders show')
  assert.deepEqual(topHeads.filter(([, e]) => e !== 'false'), [], `every folder is closed on first launch (${JSON.stringify(topHeads)})`)
  assert.equal(await page.locator('.tl-tree [data-talk-slug]').count(), 0, 'no talk inside a folder shows until its folder is opened')
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'folders-start-collapsed.png') })
  console.log('PASS folders start collapsed: every folder closed on first launch')
  for (const path of ['ai-in-education', 'ai-in-education/jersey-2026', 'agents-2026']) {
    await header(page, path).click()
    assert.equal(await expanded(page, path), true, `${path} opens on a click`)
  }

  // Every talk row at rest has a second line; the Vibecoding pair differ.
  const talkRows = page.locator('.tl-tree [data-talk-slug]')
  const n = await talkRows.count()
  assert.equal(await page.locator('.tl-tree .tl-row--two[data-talk-slug]').count(), n, 'every visible talk row has two lines')
  assert.equal(await talkRows.first().evaluate((el) => el.getBoundingClientRect().height), 36, 'rows are 36 px')
  const sub = (slug) => page.locator(`[data-talk-slug="${slug}"] .tl-row-sub`).innerText()
  const clinical = await sub('vibecoding-as-pedagogy-neurology-workshop')
  const jersey = await sub('vibecoding-as-pedagogy')
  assert.equal(clinical, `ai-in-education · Clinical Neuroscience · ${given}`)
  assert.equal(jersey, 'jersey-2026 · Jersey College for Girls AI in Education conference · no delivery recorded')
  assert.equal(await sub('the-age-of-the-claw'), 'agents-2026 · no delivery recorded')
  const subSize = await page.locator('[data-talk-slug="the-age-of-the-claw"] .tl-row-sub').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const nameSize = await page.locator('[data-talk-slug="the-age-of-the-claw"] .tl-row-name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  assert.ok(subSize < nameSize, `line two is smaller (${subSize} < ${nameSize})`)
  console.log(`PASS second line: "${clinical}" vs "${jersey}"; 36 px rows; smaller type`)

  // L2 — open the Archive: four folders with their counts, each closed.
  await header(page, ARCHIVE).click()
  await header(page, `${ARCHIVE}/ai-for-research`).waitFor()
  const inside = await page.locator(`.tl-tree [data-folder-path^="${ARCHIVE}/"]`).evaluateAll((els) =>
    els.map((el) => `${el.getAttribute('data-folder-path').split('/').pop()} ${el.querySelector('.tl-fcount').textContent}`))
  assert.deepEqual(inside, ['ai-for-research 1', 'ai-for-students 1', 'ai-mapping-the-landscape 2', 'ai-overviews-webinars 1'])
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L2-archive-open.png') })
  console.log('PASS L2: the Archive opens to its four folders with counts')

  // Keyboard over two-line rows: ↑↓ move, ← folds, → unfolds, ↵ opens a talk.
  const focused = () => page.locator('.tl-tree .tl-row--kfocus, .tl-tree .tl-fhead--kfocus').first().evaluate((el) => el.getAttribute('data-folder-path') ?? el.getAttribute('data-talk-slug'))
  assert.equal(await focused(), ARCHIVE, 'a header click focuses it')
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(), `${ARCHIVE}/ai-for-research`)
  await page.keyboard.press('ArrowRight')
  await page.locator('[data-talk-slug="research-one"]').waitFor()
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(), 'research-one', '↓ onto a two-line row')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await focused(), `${ARCHIVE}/ai-for-research`, '← from a talk folds its folder')
  assert.equal(await page.locator('[data-talk-slug="research-one"]').count(), 0)
  await page.keyboard.press('ArrowUp')
  assert.equal(await focused(), ARCHIVE)
  await header(page, 'agents-2026').click() // focus + collapse agents-2026
  assert.equal(await expanded(page, 'agents-2026'), false)
  await page.keyboard.press('ArrowRight')
  assert.equal(await expanded(page, 'agents-2026'), true, '→ unfolds')
  await page.keyboard.press('ArrowDown')
  const slug = await focused()
  assert.ok(['the-age-of-the-claw', 'year-of-agents'].includes(slug), `↓ lands on a talk (${slug})`)
  await page.keyboard.press('Enter')
  await page.locator(`[data-talk-slug="${slug}"][aria-selected="true"]`).waitFor()
  console.log('PASS keyboard: ↑↓ over two-line rows, ←/→ fold, ↵ opens')

  // / from outside the list (0.34.0-preview.2 check). In the talk editor / is text; with focus
  // outside the editor and any field (nothing focused, or a plain button), / puts the caret in the
  // file list's search box.
  // The first engagement with a just-opened talk's editor turns the sidebar to the slide outline;
  // / is the file list's only while the list is open, so engage once and come back to Talks.
  await page.locator('.cm-content').first().click()
  await page.waitForTimeout(300)
  if (!await page.locator('aside.talk-list.tl-panel').isVisible().catch(() => false)) {
    await page.locator('.sidebar-mode-btn').filter({ hasText: /^Talks$/ }).first().click()
    await page.locator('aside.talk-list.tl-panel').waitFor()
  }
  const search = page.locator('.tl-search input[aria-label="Filter talks"]').first()
  const searchFocused = () => search.evaluate((el) => document.activeElement === el)
  await page.locator('.cm-content').first().click()
  await page.waitForTimeout(300)
  assert.equal(await page.locator('aside.talk-list.tl-panel').isVisible(), true, 'the file list is still open')
  const before = await page.evaluate(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.length ?? -1)
  await page.keyboard.press('/')
  assert.equal(await searchFocused(), false, '/ in the talk editor never moves to the search box')
  assert.equal(await page.evaluate(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.length ?? -1), before + 1, 'it types a / there')
  await page.keyboard.press('Backspace')
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur())
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'nothing is focused')
  await page.keyboard.press('/')
  assert.equal(await searchFocused(), true, '/ with nothing focused puts the caret in the search box')
  assert.equal(await search.inputValue(), '', 'and types nothing into it')
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur())
  await page.getByRole('button', { name: 'Shelf view' }).focus()
  await page.keyboard.press('/')
  assert.equal(await searchFocused(), true, '/ from a focused button outside the list does the same')
  await page.keyboard.press('Escape')
  console.log('PASS /: from outside the list (nothing focused, a button) the caret goes to the search box; in the editor / is text')

  // Leave: Archive open, agents-2026 closed, zebra opened. Wait for the store, quit, relaunch.
  await header(page, 'agents-2026').click()
  await header(page, 'zebra').click()
  await waitStored((s) => s[ARCHIVE] === true && s['agents-2026'] === false && s.zebra === true, 'archive + zebra open, agents-2026 closed')
  await run.app.close()
  run = null
  run = await launch()
  page = run.page
  await header(page, ARCHIVE).waitFor()
  assert.equal(await expanded(page, ARCHIVE), true, 'the Archive is still open after relaunch')
  assert.equal(await expanded(page, 'agents-2026'), false, 'agents-2026 is still closed after relaunch')
  assert.equal(await expanded(page, 'zebra'), true, 'zebra, opened before quitting, is still open')
  assert.equal(await expanded(page, 'ai-in-education'), true, 'a folder opened in the first session stays open (the remembered choice wins)')
  assert.equal(await expanded(page, `${ARCHIVE}/ai-for-research`), false, 'the folded Archive folder stays folded')
  assert.equal(await expanded(page, `${ARCHIVE}/ai-mapping-the-landscape`), false, 'an untouched folder keeps its default: closed')
  console.log('PASS relaunch: open and closed folders as left')

  // Collapsing likewise: close the Archive, relaunch, still closed.
  await header(page, ARCHIVE).click()
  await waitStored((s) => s[ARCHIVE] === false, 'archive closed')
  await run.app.close()
  run = null
  run = await launch()
  page = run.page
  await header(page, ARCHIVE).waitFor()
  assert.equal(await expanded(page, ARCHIVE), false, 'the Archive is closed again after relaunch')
  console.log('PASS relaunch: a folder closed before quitting is closed after')

  // Shelf keeps its rows (event and recency; no Ledger second line). No talk is open here:
  // the switch itself is covered by diagnose-talklist-view-switch.mjs (ticket 09).
  assert.equal(await page.locator('.tl-tree [aria-selected="true"]').count(), 0, 'no talk open before switching')
  await page.getByRole('button', { name: 'Shelf view' }).click()
  await page.locator('.tl-shrow').first().waitFor()
  assert.equal(await page.locator('.tl-tree .tl-row-rest').count(), 0)
  assert.equal(await page.locator('.tl-tree .tl-shrow--two').count(), 0)
  assert.match(await page.locator('[data-talk-slug="vibecoding-as-pedagogy-neurology-workshop"]').innerText(), /Clinical Neuroscience/)
  await page.getByRole('button', { name: 'Ledger view' }).click()
  console.log('PASS Shelf: rows unchanged')

  assert.ok(existsSync(configFile))
  assert.equal(await page.locator('.tw-errbound').count(), 0)
  assert.deepEqual(run.errors, [])
  console.log('PASS talk list archive e2e')
} catch (error) {
  if (run) {
    const page = await run.app.firstWindow()
    console.error('Test window:', (await page.locator('body').innerText()).slice(0, 3000))
  }
  throw error
} finally {
  if (run) await run.app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
