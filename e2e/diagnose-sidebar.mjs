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
//   (e) metadata toggle shows cached slide count + last-presented fixture date.
//   (f) sorting by Edited reorders talks by mtime descending.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-sidebar.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'

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
    'Thank you.'
  ].join('\n')
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-sidebar-' + String(Date.now()) + '-'))
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
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: tempVault }, null, 2), 'utf8')
writeFileSync(join(userDataDir, 'search-index.json'), JSON.stringify(searchIndex), 'utf8')

const app = await electron.launch({
  args: ['.', '--user-data-dir=' + userDataDir],
  cwd: REPO,
  env: { ...process.env, TW_REC_TEST: '1' }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const talkRows = () => page.locator('[data-talk-slug]')
const activeTalkSlug = async () => page.locator('.talk-item--active').getAttribute('data-talk-slug').catch(() => null)
const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '')
const activeEditorText = () => page.locator('.cm-activeLine').first().textContent().catch(() => '')

try {
  await page.waitForSelector('[data-talk-slug="c10-alpha"]', { timeout: 8000 })

  await page.keyboard.press('Meta+Shift+T')
  const talksFocused = await waitFor(async () => (await focusedLabel()) === 'Search talks', 4000)
  record('⌘⇧T focuses the Talks search', talksFocused)

  await page.keyboard.type('C10')
  await page.waitForTimeout(250)
  const filtered = await talkRows().count()
  record('typing filters the Talks list', filtered === 3, `rows=${filtered}`)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const openedSecond = await waitFor(async () => (await activeTalkSlug()) === 'c10-beta', 5000)
  record('↓↓ + Enter opens the second filtered talk', openedSecond, `active=${await activeTalkSlug()}`)

  await page.keyboard.press('Meta+Shift+O')
  const outlineFocused = await waitFor(async () => (await focusedLabel()) === 'Search the slide outline', 5000)
  record('⌘⇧O switches to the Slide outline search with focus', outlineFocused)

  const beforeLine = (await activeEditorText() || '').trim()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const jumped = await waitFor(async () => {
    const text = ((await activeEditorText()) || '').trim()
    return text !== beforeLine && /## Talk|### Opening/.test(text)
  }, 5000)
  record('↓ + Enter in Slide outline jumps the editor cursor', jumped, `before=${beforeLine} after=${((await activeEditorText()) || '').trim()}`)

  await page.keyboard.press('Meta+Shift+[')
  const collapsed = await page.locator('[data-sidebar-expand]').waitFor({ timeout: 4000 }).then(() => true).catch(() => false)
  await page.keyboard.press('Meta+Shift+[')
  const expandedFocus = await waitFor(async () => (await focusedLabel()) === 'Search the slide outline', 5000)
  record('⌘⇧[ collapses and re-expands with active panel search focused', collapsed && expandedFocus, `collapsed=${collapsed} focus=${await focusedLabel()}`)

  await page.keyboard.press('Meta+Shift+T')
  await page.locator('[data-talklist-meta-toggle]').click()
  const betaMeta = page.locator('[data-talk-slug="c10-beta"] [data-talk-meta]')
  const metaText = await betaMeta.textContent().catch(() => '')
  const metaOk = /6 slides/.test(metaText || '') && /presented/.test(metaText || '') && !/presented\s+—/.test(metaText || '')
  record('meta toggle renders cached slide count and last-presented fixture value', metaOk, `meta=${metaText}`)

  await page.locator('[data-talklist-sort]').click()
  await page.locator('[data-sort-key="edited"]').click()
  const sortedEdited = await waitFor(async () => {
    const order = await talkRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-talk-slug')))
    return JSON.stringify(order) === JSON.stringify(['c10-gamma', 'c10-beta', 'c10-alpha'])
  }, 5000)
  const order = await talkRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-talk-slug')))
  record('sort by Edited reorders talks by edited date descending', sortedEdited, `order=${JSON.stringify(order)}`)
} catch (e) {
  record('sidebar harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== SIDEBAR SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
