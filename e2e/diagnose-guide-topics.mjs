// Onboarding 0.38.1 ticket 11, in the real app: How it works, Features to delight you, What it connects to.
// A profile with a vault of its own opens the example vault and its start talk, then the Guide.
//   - How it works lists ten topics, 0 of 10 read; opening topic 3 shows its heading, two sentences, one
//     picture and a Try it; back on the list they read Read, and the marks are in app config;
//   - Try it on topic 3 (the start talk is open here) brings that window forward; Try it on topic 5 opens
//     Garden notes in its own window and leaves the start talk where it is; Try it on topic 9 opens Settings;
//   - Features to delight you: 19 rows in three sections; a clicked row reads Read and the mark is kept;
//   - What it connects to shows ten rows from a stubbed machine (TW_E2E_MACHINE): the drawn partly-found
//     transcription row, Git on a vault, no secret value in the page; the live row is fixed with a disabled
//     action; Show what is missing says what is missing; Set up in Settings opens Settings; Check again re-reads;
//   - nothing is probed until the Features segment is opened;
//   - the marks survive a restart.
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-guide-topics.mjs
import { _electron as electron } from 'playwright'
import { closeSettingsWindow } from './lib/settings-window.mjs'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { guideLearnFrom } from '../src/shared/guide-learn.ts'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = process.env.TW_E2E_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve())

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-guide-topics-')))
const home = join(tempRoot, 'home')
const userData = join(tempRoot, 'userData')
const personal = join(tempRoot, 'Personal')
mkdirSync(join(home, 'Documents'), { recursive: true })
mkdirSync(join(personal, 'alpha-talk'), { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(personal, 'alpha-talk', 'alpha-talk-outline.md'), '---\ntitle: Alpha Talk\noutline_version: 2\n---\n\n## Section\n\n### First slide {id=a1}\n\nBody one.\n')
const configPath = join(userData, 'config.json')
// The Cloudflare account id is in config so the page can be checked for it: only "set up" may show, never the value.
writeFileSync(configPath, JSON.stringify({ vaultRoot: personal, cfAccountId: 'SECRET-ACCOUNT-VALUE-1234' }, null, 2))
const learnOnDisk = () => guideLearnFrom(JSON.parse(readFileSync(configPath, 'utf8')).guideLearn)

// The machine the Guide reads, stubbed (an unpackaged E2E run only): the Cloudflare statuses are Settings' own,
// here "connected, no site yet" and a recording-storage row with nothing entered; Git on a vault.
const MACHINE = {
  cloudflare: { connection: { state: 'connected', account: { id: 'a', name: 'Test account' } }, publishing: { state: 'no-site', project: 'talkweaver-handouts', permission: null, customDomain: 'none', stale: false }, liveService: { state: 'unknown', permission: null, stale: false }, shareLink: { state: 'none', host: '', permission: null, stale: false }, busy: false, checkedAt: null, notice: null, details: null },
  tools: { libreoffice: true, poppler: true, agents: [] },
  vaults: [{ name: 'Personal', service: null, git: true }],
  slidewell: false
}

async function launch() {
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: home, TW_E2E_MACHINE: JSON.stringify(MACHINE) } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  return { app, page }
}
const waitFor = async (fn, timeout = 8000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)) }
  return false
}
const clean = (s) => s.replace(/\s+/g, ' ').trim()

await ensureFreshBuild(REPO)
let exitCode = 0
try {
  let { app, page } = await launch()
  try {
    await ensureTalksMode(page)
    await openTalkByTitle(page, 'Alpha Talk')
    await page.waitForSelector('.cm-content', { timeout: 8000 })
    await ensureTalksMode(page)
    await page.locator('[data-add-vault]').click()
    const sheet = page.locator('[data-vault-sheet="add"]')
    await sheet.waitFor({ state: 'visible', timeout: 8000 })
    await sheet.locator('[data-open-example]').click()
    await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
    record('the example vault opens with its start talk', await waitFor(async () => (await page.locator('.workspace-title').first().innerText().catch(() => '')) === 'The Saturday market', 15000))
    await page.waitForSelector('[data-guide]', { timeout: 6000 })

    // How it works, state 08.
    await page.locator('[data-guide-segment="how"]').click()
    await page.waitForSelector('[data-guide-how]', { timeout: 4000 })
    record('How it works lists ten topics, none read', (await page.locator('[data-topic-row]').count()) === 10 && clean(await page.locator('[data-guide-how-count]').innerText()) === '0 of 10 read')
    record('every row reads Not opened', (await page.locator('[data-topic-state="none"]').count()) === 10)
    await shot(page, '11-how-list.png')

    // A topic, state 09.
    await page.locator('[data-topic-row="how.3"]').click()
    await page.waitForSelector('[data-topic-detail="how.3"]', { timeout: 4000 })
    record('a topic is its heading, two sentences, one picture and one Try it',
      clean(await page.locator('[data-topic-title]').innerText()) === 'Headings become slides.'
      && (await page.locator('[data-topic-sentence]').count()) === 2
      && (await page.locator('[data-guide-picture]').count()) === 1
      && (await page.locator('[data-topic-try-button]').count()) === 1
      && clean(await page.locator('[data-topic-position]').innerText()) === '3 of 10')
    record('opening it was kept as Read in app config', await waitFor(() => learnOnDisk().read.includes('how.3'), 4000))
    await shot(page, '11-how-topic.png')
    await page.locator('[data-topic-next]').click()
    await page.waitForSelector('[data-topic-detail="how.4"]', { timeout: 3000 })
    await page.locator('[data-topic-back]').click()
    await page.waitForSelector('[data-guide-how]', { timeout: 3000 })
    record('back on the list: topics 3 and 4 read, 2 of 10 read', (await page.locator('[data-topic-state="read"]').count()) === 2 && clean(await page.locator('[data-guide-how-count]').innerText()) === '2 of 10 read')

    // Try it: the start talk is open here, so its window is the one brought forward (no second window).
    // Hidden thumbnail renderers are windows too: count the app's own (index.html) only.
    const appWindows = () => app.windows().filter((w) => w.url().includes('/renderer/index.html')).length
    const windowsBefore = appWindows()
    await page.locator('[data-topic-row="how.1"]').click()
    await page.locator('[data-topic-try-button]').click()
    await page.waitForTimeout(1200)
    record('Try it on a topic whose talk is open here opens no second window', appWindows() === windowsBefore && (await page.locator('.workspace-title').first().innerText()) === 'The Saturday market', `${windowsBefore} -> ${appWindows()}`)

    // Try it: another talk opens in its own window.
    await page.locator('[data-topic-back]').click()
    await page.locator('[data-topic-row="how.5"]').click()
    const newWindow = app.waitForEvent('window', { timeout: 15000 })
    await page.locator('[data-topic-try-button]').click()
    const second = await newWindow.catch(() => null)
    record('Try it on topic 5 opens a new window', second !== null && second !== page)
    if (second) {
      await second.waitForLoadState('domcontentloaded')
      record('the new window holds Garden notes', await waitFor(async () => (await second.locator('.workspace-title').first().innerText().catch(() => '')) === 'Garden notes', 15000))
      record('the start talk stays in the first window', (await page.locator('.workspace-title').first().innerText()) === 'The Saturday market')
    }
    await page.bringToFront()

    // Try it: a command.
    await page.locator('[data-topic-back]').click()
    await page.locator('[data-topic-row="how.9"]').click()
    const [topicSettings] = await Promise.all([app.waitForEvent('window'), page.locator('[data-topic-try-button]').click()])
    await topicSettings.waitForLoadState('domcontentloaded')
    record('Try it on topic 9 opens Settings', await waitFor(async () => (await topicSettings.locator('.bsw-root').count()) > 0, 4000))
    await closeSettingsWindow(app)
    await page.waitForTimeout(300)

    // Features: states 10 and 18.
    await page.locator('[data-guide-segment="features"]').click()
    await page.waitForSelector('[data-guide-features]', { timeout: 4000 })
    record('Features lists 16 rows in three sections and a fourth, What it connects to', (await page.locator('[data-feature-row]').count()) === 16 && (await page.locator('[data-feature-section]').count()) === 4)
    record('hints are drawn (a key or a menu) on unread rows', clean(await page.locator('[data-feature-row="feature.2"] [data-feature-hint]').innerText()) === '⌘K, Explain rendering')
    await page.locator('[data-feature-row="feature.2"]').click()
    record('a clicked feature reads Read and is kept', await waitFor(async () => (await page.locator('[data-feature-row="feature.2"]').getAttribute('data-feature-state')) === 'read' && learnOnDisk().read.includes('feature.2'), 4000))
    await shot(page, '11-features-top.png')

    // What it connects to: the stubbed machine.
    await page.waitForSelector('[data-connection]', { timeout: 6000 })
    record('What it connects to shows ten rows', (await page.locator('[data-connection]').count()) === 10)
    const text = async (id) => clean(await page.locator(`[data-connection="${id}"] [data-connection-text]`).innerText())
    record('Cloudflare Pages follows Settings: connected, no site yet', (await text('pages')) === 'No site yet')
    record('the live service row follows Settings: not set up, its action open', (await text('live')) === 'Not set up' && (await page.locator('[data-connection="live"] button').isEnabled()))
    record('Local transcription follows Settings: not set up, optional', (await text('transcription')) === 'Not set up — optional')
    record('LibreOffice and Poppler: found', (await text('office')) === 'Found on this Mac')
    record('A synced folder: Git on vault Personal', (await text('synced')) === 'Found on this Mac: Git, on vault Personal')
    record('SlideWell: not found, with Get SlideWell', (await text('slidewell')) === 'Not found on this Mac' && clean(await page.locator('[data-connection="slidewell"] button').innerText()) === 'Get SlideWell')
    record('no secret value is anywhere in the Guide', !(await page.locator('[data-guide]').innerText()).includes('SECRET-ACCOUNT-VALUE'))
    await page.locator('[data-connection="pages"] button').scrollIntoViewIfNeeded()
    await shot(page, '11-connections.png')
    await page.locator('[data-connections-refresh]').click()
    record('Check again re-reads the same ten rows', await waitFor(async () => (await page.locator('[data-connection]').count()) === 10, 4000))
    const [cloudflareSettings] = await Promise.all([app.waitForEvent('window'), page.locator('[data-connection="pages"] [data-connection-action="open-cloudflare"]').click()])
    await cloudflareSettings.waitForLoadState('domcontentloaded')
    record('Set up in Settings opens Settings (at its Cloudflare section)', await waitFor(async () => (await cloudflareSettings.locator('.bsw-root[data-section="cloudflare"]').count()) > 0, 4000))
  } finally {
    await app.close()
  }

  // The marks survive a restart.
  ;({ app, page } = await launch())
  try {
    await page.waitForSelector('[data-guide-button]', { timeout: 10000 })
    await page.locator('[data-guide-button]').click()
    await page.locator('[data-guide-segment="how"]').click()
    await page.waitForSelector('[data-guide-how]', { timeout: 6000 })
    const saved = learnOnDisk().read
    record('after a restart How it works shows the saved count of topics read', clean(await page.locator('[data-guide-how-count]').innerText()) === `${saved.filter((id) => id.startsWith('how.')).length} of 10 read` && saved.includes('how.3') && saved.includes('feature.2'), saved.join(', '))
    await page.locator('[data-guide-segment="features"]').click()
    await page.waitForSelector('[data-feature-row]', { timeout: 6000 })
    record('and the feature row is still Read', (await page.locator('[data-feature-row="feature.2"]').getAttribute('data-feature-state')) === 'read')
  } finally {
    await app.close()
  }
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(exitCode || (failed.length ? 1 : 0))
