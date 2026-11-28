// Real-Electron harness for the main-window sidebar upgrade (Plan C9-C10).
//
// Runs against a temp vault + userData fixture. The C10 slide counts come from a seeded
// userData/search-index.json so vault:talk-meta proves the cached-count path without compiling.
//
// Checks:
//   (a) Cmd+Shift+T focuses the Talks search.
//   (b) typing filters; ↓↓ + Enter opens the second match.
//   (c) Cmd+Shift+O switches to the Slide outline search; ↓ + Enter jumps the editor.
//   (d) Cmd+Shift+[ collapses and re-expands the sidebar with focus restored.
//   (e) the focused-talk preview shows cached slide count + last-delivered fixture date.
//   (f) sorting by Edited reorders talks by mtime descending.
//   (g) Talks opens Grid. Double-clicking the fifth card opens slide 5 with Slides previews.
//       Returning to Talks and selecting another talk returns to the top of Grid.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-sidebar.mjs
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import { activeTalkRow, talkRows as mountedTalkRows, openTalkByTitle, showTalkView, talkRowByTitle } from './lib/talklist.mjs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, writeFileSync, utimesSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`)
}

async function waitFor(pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await Promise.resolve(pred())) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

function isoDaysAgo(days, hour = 10, minute = 0) {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function outline(title) {
  return [
    '---',
    `title: ${title}`,
    'duration: 20min',
    'auto_title_slide: true',
    'auto_thanks_slide: true',
    '---',
    '',
    '## Talk',
    '',
    '### Opening',
    '{id=opening}',
    '',
    `Welcome to ${title}.`,
    '',
    '### Method',
    '{id=method}',
    '',
    'A concrete method slide.',
    '',
    '### Close',
    '{id=close}',
    '',
    'Thank you.',
    ...(title === 'C10 Gamma' ? Array.from({ length: 16 }, (_, i) => `\n### Further point ${i + 1}\n\nA point for this talk.\n`) : [])
  ].join('\n')
}

await using appScratch = createAppScratch()
const tempRoot = appScratch.root
const tempVault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const talks = [
  { slug: 'c10-alpha', title: 'C10 Alpha', daysOld: 5, slideCount: 4 },
  { slug: 'c10-beta', title: 'C10 Beta', daysOld: 3, slideCount: 6 },
  { slug: 'c10-gamma', title: 'C10 Gamma', daysOld: 1, slideCount: 2 }
]

mkdirSync(tempVault, { recursive: true })
mkdirSync(userDataDir, { recursive: true })

const searchIndex = {}
for (const talk of talks) {
  const dir = join(tempVault, talk.slug)
  const outlinePath = join(dir, `${talk.slug}-outline.md`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(outlinePath, outline(talk.title), 'utf8')
  const edited = new Date(isoDaysAgo(talk.daysOld, 12, 0))
  utimesSync(outlinePath, edited, edited)
  searchIndex[outlinePath] = {
    mtimeMs: edited.getTime(),
    rows: Array.from({ length: talk.slideCount }, (_, i) => ({ slide_id: `${talk.slug}-${i + 1}` })),
    talkTitle: talk.title,
    slug: talk.slug,
    meta: ''
  }
  talk.outlinePath = outlinePath
}

const session = {
  id: 'side-beta-run',
  talkSlug: 'c10-beta',
  talkTitle: 'C10 Beta',
  kind: 'delivery',
  startedAt: isoDaysAgo(2, 9, 30),
  endedAt: isoDaysAgo(2, 9, 50),
  recordingMs: 20 * 60_000,
  wallClockMs: 20 * 60_000,
  timerTargetMin: 20,
  context: 'Sidebar fixture run',
  pathwayId: null,
  audio: null,
  transcript: null,
  slideTimeIndex: [
    { event: 'enter', slideId: 'opening', tMs: 0 },
    { event: 'enter', slideId: 'close', tMs: 19 * 60_000 }
  ]
}
mkdirSync(join(tempVault, '_PRESENTATIONS', 'c10-beta'), { recursive: true })
writeFileSync(join(tempVault, '_PRESENTATIONS', 'c10-beta', `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8')
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault, openInView: 'outline', slidesPanelView: 'outline' }, null, 2), 'utf8')
writeFileSync(join(userDataDir, 'search-index.json'), JSON.stringify(searchIndex), 'utf8')

const { app, page } = await launchApp({
  scratch: appScratch,
  userData: userDataDir,
  env: { ...process.env, TW_REC_TEST: '1' },
})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const talkRows = () => mountedTalkRows(page)
const activeTalkSlug = async () => activeTalkRow(page).getAttribute('data-talk-slug').catch(() => null)
const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '')
const activeEditorText = () => page.locator('.cm-activeLine').first().textContent().catch(() => '')

try {
  // On the start screen the shortcut focuses its own search. Open a talk to test the sidebar path.
  await openTalkByTitle(page, 'C10 Alpha', { view: 'outline' })
  await page.locator('.cm-content').first().waitFor()
  await page.getByRole('tab', { name: 'Slides', exact: true }).click()

  await page.keyboard.press('Meta+Shift+T')
  const talksFocused = await waitFor(async () => (await focusedLabel()) === 'Filter talks', 4000)
  record('⌘⇧T from the editor opens and focuses the Talks search', talksFocused, `focus=${await focusedLabel()}`)

  await page.keyboard.type('C10')
  await page.locator('.tl-res-head').getByText('3 talks', { exact: true }).waitFor({ timeout: 5000 })
  const hits = await talkRows().evaluateAll(rows => rows.map(row => row.getAttribute('data-talk-slug')))
  record('typing filters the Talks list', hits.length === 3 && hits[1] === 'c10-beta', `results=${hits.join(', ')}`)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const openedSecond = await waitFor(async () => (await activeTalkSlug()) === 'c10-beta', 30000)
  record('↓↓ + Enter opens the second filtered talk', openedSecond, `active=${await activeTalkSlug()}`)

  await showTalkView(page, 'outline')
  await page.getByRole('button', { name: 'Show slides as an outline' }).click()
  await page.keyboard.press('Meta+Shift+O')
  const outlineFocused = await waitFor(async () => (await focusedLabel()) === 'Search the slide outline', 5000)
  record('⌘⇧O switches to the Slide outline search with focus', outlineFocused)

  const beforeLine = (await activeEditorText() || '').trim()
  await page.getByLabel('Search the slide outline').fill('Method')
  await page.locator('.so-slide:not(.so-row--dim)').filter({ hasText: 'Method' }).waitFor()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const jumped = await waitFor(async () => {
    const text = ((await activeEditorText()) || '').trim()
    return text !== beforeLine && text === '### Method'
  }, 5000)
  record('↓ + Enter in Slide outline jumps the editor cursor', jumped, `before=${beforeLine} after=${((await activeEditorText()) || '').trim()}`)

  await page.keyboard.press('Meta+Shift+[')
  const collapsed = await page.locator('[data-sidebar-expand]').waitFor({ timeout: 4000 }).then(() => true).catch(() => false)
  await page.keyboard.press('Meta+Shift+[')
  const expandedFocus = await waitFor(async () => (await focusedLabel()) === 'Search the slide outline', 5000)
  record('⌘⇧[ collapses and re-expands with active panel search focused', collapsed && expandedFocus, `collapsed=${collapsed} focus=${await focusedLabel()}`)

  await page.keyboard.press('Meta+Shift+T')
  // T29: the preview card appears on HOVER (after the intent pause) — a click opens the talk
  // and must never show, nor leave behind, a card.
  const betaRow = page.locator('[data-talk-slug="c10-beta"]')
  // The card may already be up for the keyboard-focused row (⌘⇧T focuses the panel's search),
  // so wait for C10 Beta's own card (its slug shows in the File row), not just any flyout.
  const betaCard = page.locator('[data-talklist-flyout]').filter({ hasText: 'c10-beta' })
  await betaRow.hover()
  await betaCard.waitFor({ timeout: 4000 })
  const metaText = await betaCard.locator('.tl-flyout-meta').innerText().catch(() => '')
  const metaOk = /Slides\s+6 slides/.test(metaText || '') && /Delivered\s+2d ago/.test(metaText || '')
  record('hover preview renders cached slide count and last-delivered fixture value', metaOk, `meta=${JSON.stringify(metaText)}`)

  await betaRow.click()
  const flyoutGone = await waitFor(async () => !(await page.locator('[data-talklist-flyout]').isVisible().catch(() => false)), 4000)
  const grid = page.locator('[data-view="grid"]')
  await grid.waitFor({ timeout: 30000 })
  record('click opens the talk in Grid and leaves no preview card behind', flyoutGone)

  await page.locator('[data-talklist-sort]').click()
  await page.locator('[data-sort-key="edited"]').click()
  const sortedEdited = await waitFor(async () => {
    const order = await talkRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-talk-slug')))
    return JSON.stringify(order) === JSON.stringify(['c10-gamma', 'c10-beta', 'c10-alpha'])
  }, 5000)
  const order = await talkRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-talk-slug')))
  record('sort by Edited reorders talks by edited date descending', sortedEdited, `order=${JSON.stringify(order)}`)

  const tab = name => page.getByRole('tab', { name, exact: true })
  await (await talkRowByTitle(page, 'C10 Gamma')).click()
  await page.getByTitle('Talk menu', { exact: true }).getByText('C10 Gamma', { exact: true }).waitFor()
  const fifth = grid.locator('.grid-cell[data-slide-index="4"]')
  await fifth.waitFor()
  await grid.locator('.grid-cell[data-slide-index="0"][data-active="true"]').waitFor()
  assert.equal(await grid.evaluate(element => element.scrollTop), 0)
  assert.equal(await tab('Talks').getAttribute('aria-selected'), 'true')

  await page.getByRole('button', { name: 'Clear filter', exact: true }).click()
  await grid.evaluate(element => { element.scrollTop = element.scrollHeight })
  assert.ok(await grid.evaluate(element => element.scrollTop > 0), 'the fixture grid can scroll')
  const recent = page.locator('.tl-recent-head')
  if (await recent.getAttribute('aria-expanded') === 'false') await recent.click()
  await page.locator('.tl-recent-row').filter({ hasText: 'C10 Gamma' }).click()
  await page.waitForFunction(() => document.querySelector('[data-view="grid"]')?.scrollTop === 0)
  await fifth.click()
  await fifth.and(page.locator('[data-active="true"]')).waitFor()
  await fifth.dblclick()
  const crumb = page.locator('[data-view="slide"] .workspace-slide-crumb strong')
  await crumb.filter({ hasText: /^Slide 5 of / }).waitFor()
  await page.locator('[data-sidebar][data-slides-mode="previews"] .tw-slide-card').first().waitFor()
  assert.equal(await tab('Slides').getAttribute('aria-selected'), 'true')

  await tab('Talks').click()
  assert.equal(await tab('Talks').getAttribute('aria-selected'), 'true')
  await crumb.filter({ hasText: /^Slide 5 of / }).waitFor()
  await (await talkRowByTitle(page, 'C10 Alpha')).click()
  await page.getByTitle('Talk menu', { exact: true }).getByText('C10 Alpha', { exact: true }).waitFor()
  await grid.locator('.grid-cell[data-slide-index="0"][data-active="true"]').waitFor()
  assert.equal(await grid.evaluate(element => element.scrollTop), 0)
  record('Talks → Grid → double-click slide 5 → Slide with previews → another talk in Grid', true)

} catch (e) {
  record('sidebar harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== SIDEBAR SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await appScratch.closeApp(app)
  process.exitCode = failed.length === 0 ? 0 : 1
}
