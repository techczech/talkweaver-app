// Update notices (ADR-0041) in the real app: the status-bar marks, the popover, Check for Updates…
// from the palette, Settings › About and updates, and the Store copy. A throwaway user-data folder and
// vault; the feed is a stand-in on this computer's loopback address (the test-only TW_E2E_UPDATES_FEED,
// which a packaged build ignores); the links in its feed are on talkweaver.app and are never fetched
// (E2E logs the address main would open). Nothing here contacts talkweaver.app.
//
// The journey: What's new mark after an update (nothing opens by itself; a click opens the tab and the
// mark goes) → no request at launch → Check for Updates… answers "a newer TalkWeaver version is available" and the
// status bar shows the mark → the popover's Download opens the link for this computer, Not now hides the
// mark, Skip this version hides it for good → Settings shows "You skipped the newer version" and Stop skipping brings
// the mark back → the stand-in goes away: "Could not reach talkweaver.app" → a Store copy: no mark, no
// New versions card, and the command answers "Updates come from the Microsoft Store" with no request.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openSettingsWindow, closeSettingsWindow } from './lib/settings-window.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CURRENT_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const [major, minor] = CURRENT_VERSION.split('.').map(Number)
const NEXT_VERSION = `${major}.${minor + 1}.0`
const CURRENT_PATTERN = CURRENT_VERSION.replaceAll('.', '\\.')
const NEXT_PATTERN = NEXT_VERSION.replace(/\./g, '\\.')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FEED = JSON.stringify({
  schema: 1,
  latest: {
    version: NEXT_VERSION, released: '2026-11-12', summary: ['Slides can be copied between vaults with their pictures.', 'The presenter view shows the next two slides.'],
    notes: `https://talkweaver.app/whats-new#${NEXT_VERSION}`,
    download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' },
  },
})
const requests = []
let serving = true
const server = createServer((req, res) => {
  requests.push({ url: req.url, headers: req.headers })
  if (!serving) { req.socket.destroy(); return }
  res.setHeader('Content-Type', 'application/json')
  res.end(FEED)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const feedUrl = `http://127.0.0.1:${server.address().port}/updates.json`

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-updates-'))
const vault = join(tempRoot, 'vault')
const td = join(vault, 'update-fixture')
mkdirSync(td, { recursive: true })
writeFileSync(join(td, 'update-fixture-outline.md'), ['---', 'title: Update Fixture', '---', '', '## Opening', '', '### One', '', '- A point', ''].join('\n'))

async function launch(source, state) {
  const ud = mkdtempSync(join(tempRoot, 'ud-'))
  writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, ...(state ? { updateNotices: state } : {}) }, null, 2))
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_UPDATES_SOURCE: source, TW_E2E_UPDATES_FEED: feedUrl } })
  const out = []
  app.process().stdout?.on('data', (chunk) => out.push(String(chunk)))
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openTalkByTitle(page, 'Update Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  return { app, page, out }
}
const visible = (page, selector, timeout = 4000) => page.waitForSelector(selector, { state: 'visible', timeout }).then(() => true, () => false)
const gone = (page, selector, timeout = 4000) => page.waitForSelector(selector, { state: 'detached', timeout }).then(() => true, () => false)
async function checkFromPalette(page) {
  await page.keyboard.press(`${MOD}+Shift+P`)
  await page.waitForSelector('[data-command-menu] input', { timeout: 4000 })
  await page.waitForTimeout(250) // the palette settles (and drops stray keys) before it is typed into
  await page.keyboard.press(`${MOD}+A`)
  await page.keyboard.type('Check for Updates')
  await page.waitForSelector('[data-command="check-for-updates"]', { timeout: 4000 })
  await page.keyboard.press('Enter')
}

try {
  await ensureFreshBuild(REPO)
  // ── A website copy that has just been updated from 0.40.0 ─────────────────────────────────────
  let { app, page, out } = await launch('website', { lastVersionRun: '0.40.0' })
  const updated = await visible(page, '[data-whats-new-mark]')
  const text = updated ? (await page.locator('[data-whats-new-mark]').innerText()).replace(/\s+/g, ' ').trim() : ''
  record('after an update the status bar reads "Updated to <version> · What\'s new"', updated && new RegExp("^Updated to " + CURRENT_PATTERN + " \u00b7 What.s new$").test(text), `text=${JSON.stringify(text)}`)
  record('nothing opened by itself: no What\'s new tab, no note, no popover', (await page.locator('[data-whats-new-pane], [data-update-note], [data-update-popover]').count()) === 0)
  record('no request was made at launch', requests.length === 0, `requests=${requests.length}`)
  await page.locator('[data-whats-new-mark]').click()
  record('clicking the mark opens the What\'s new tab in the right-hand column with the shipped notes', await visible(page, '[data-whats-new-pane]') && new RegExp("What.s new in " + CURRENT_PATTERN).test(await page.locator('[data-whats-new-pane]').innerText()))
  record('the Updated mark goes when clicked', await gone(page, '[data-whats-new-mark]'))

  await checkFromPalette(page)
  const note = await visible(page, '[data-update-note][data-update-note-tone="new"]')
  const noteText = note ? (await page.locator('[data-update-note]').innerText()).replace(/\s+/g, ' ') : ''
  record('Check for Updates… from the palette answers "a newer TalkWeaver version is available." with Download and What\'s new', note && new RegExp("TalkWeaver " + NEXT_PATTERN + " is available\\.").test(noteText) && new RegExp("You have " + CURRENT_PATTERN + "\\.").test(noteText) && /Download from talkweaver\.app/.test(noteText) && new RegExp("What.s new in " + NEXT_PATTERN).test(noteText), noteText)
  record('the request was one GET with the fixed User-Agent, no query string, no cookie, no version', requests.length === 1 && requests[0].url === '/updates.json' && requests[0].headers['user-agent'] === 'TalkWeaver' && !requests[0].headers.cookie && !/0\.4\d/.test(JSON.stringify(requests[0].headers)), JSON.stringify(requests[0]?.headers))
  const mark = await visible(page, '[data-update-mark]')
  record('a new version found this way also shows the status-bar mark', mark && (await page.locator('[data-update-mark]').innerText()).includes(`${NEXT_VERSION} is available`))
  await page.locator('[data-update-note] button[aria-label="Dismiss"]').click()

  await page.locator('[data-update-mark]').click()
  const pop = await visible(page, '[data-update-popover]')
  const popText = pop ? (await page.locator('[data-update-popover]').innerText()).replace(/\s+/g, ' ') : ''
  record('the popover shows the version, the date, the summary and three choices', pop && new RegExp("TalkWeaver " + NEXT_PATTERN + " is available").test(popText) && /12 November 2026/.test(popText) && /Slides can be copied/.test(popText) && /Download from talkweaver\.app/.test(popText) && /Not now/.test(popText) && /Skip this version/.test(popText), popText.slice(0, 160))
  await page.locator('[data-update-download]').click()
  await page.waitForTimeout(400)
  record('Download opens the link for this computer in the browser (and nothing is downloaded by the app)', out.join('').includes(`[update-notices] external (E2E): https://talkweaver.app/download#${process.platform === 'win32' ? 'windows' : 'mac'}`), out.join('').split('\n').filter((l) => l.includes('update-notices')).join(' | '))
  await page.locator('[data-update-mark]').click()
  await page.locator('[data-update-not-now]').click()
  record('Not now hides the mark', await gone(page, '[data-update-mark]'))
  await checkFromPalette(page) // a fresh answer ends Not now
  await page.locator('[data-update-note] button[aria-label="Dismiss"]').click()
  await page.locator('[data-update-mark]').click()
  await page.locator('[data-update-skip]').click()
  record('Skip this version hides the mark for good', await gone(page, '[data-update-mark]'))

  let settings = await openSettingsWindow(app, page, 'updates')
  await settings.waitForSelector('.bsw-root[data-section="updates"]', { timeout: 6000 })
  record('Settings has one visible About and updates navigation entry', await settings.locator('button.bsw-nav[data-section="updates"]:visible').count() === 1)
  const card = await settings.locator('[data-updates-card]').innerText()
  record('Settings › About and updates shows the version, the switch, "You skipped the newer version." and what the check sends', new RegExp("Version " + CURRENT_PATTERN).test(await settings.locator('[data-about-card]').innerText()) && /Check for new versions/.test(card) && new RegExp("You skipped " + NEXT_PATTERN + "\\.").test(card) && /sees this computer.s internet address/.test(card), card.replace(/\s+/g, ' ').slice(0, 200))
  await settings.locator('[data-update-stop-skipping]').click()
  await closeSettingsWindow(app)
  record('Stop skipping brings the mark back at once', await visible(page, '[data-update-mark]'))

  settings = await openSettingsWindow(app, page, 'updates')
  await settings.waitForSelector('[data-updates-card]', { timeout: 6000 })
  await settings.locator('[data-setting="check-for-new-versions"] [role="switch"]').click()
  // Each window renders the pushed snapshot independently. The editor mark disappearing does
  // not mean the separate Settings renderer has committed the same snapshot yet.
  const disabledCard = await settings.waitForFunction(() =>
    document.querySelector('[data-setting="check-for-new-versions"] [role="switch"]')?.getAttribute('aria-checked') === 'false'
      && /does not check for new versions/.test(document.querySelector('[data-updates-card]')?.innerText ?? ''),
  null, { timeout: 4000 }).then(() => true, () => false)
  record('turning the switch off hides the mark and says so in the card', disabledCard && await gone(page, '[data-update-mark]'), await settings.locator('[data-updates-card]').innerText())
  await settings.locator('[data-setting="check-for-new-versions"] [role="switch"]').click()
  await closeSettingsWindow(app)
  serving = false
  await checkFromPalette(page)
  const failedNote = await visible(page, '[data-update-note][data-update-note-tone="warn"]', 15000)
  const failedText = failedNote ? (await page.locator('[data-update-note]').innerText()).replace(/\s+/g, ' ') : ''
  record('with the site unreachable Check for Updates… says "Could not check for updates." with the reason and Try again', failedNote && /Could not check for updates\./.test(failedText) && /could not be reached/.test(failedText) && /Last successful check/.test(failedText) && (await page.locator('[data-update-note] [data-update-try-again]').count()) === 1, failedText)
  await page.locator('[data-update-note] button[aria-label="Dismiss"]').click()
  record('a failed check takes nothing away: the mark stays', await visible(page, '[data-update-mark]'))
  settings = await openSettingsWindow(app, page, 'updates')
  await settings.waitForSelector('[data-updates-card]', { timeout: 6000 })
  const offline = await settings.waitForFunction(() => /Could not reach talkweaver\.app\./.test(document.querySelector('[data-updates-card]')?.innerText ?? ''), null, { timeout: 8000 }).then(() => true, () => false)
  record('Settings says "Could not reach talkweaver.app." with Try again', offline && (await settings.locator('[data-updates-card] [data-update-try-again]').count()) === 1)
  serving = true
  await settings.locator('[data-updates-card] [data-update-try-again]').click()
  const back = await settings.waitForFunction((version) => (document.querySelector('[data-updates-card]')?.innerText ?? '').includes(`${version} is available`), NEXT_VERSION, { timeout: 8000 }).then(() => true, () => false)
  record('Try again reads the feed and the card says "a newer TalkWeaver version is available." with Download…', back)
  record('Settings keeps a Check for updates button after an answer', (await settings.locator('[data-updates-card] [data-update-check]').count()) === 1)
  await app.close()

  // ── A Microsoft Store copy ─────────────────────────────────────────────────────────────────────
  serving = true
  const before = requests.length
  ;({ app, page, out } = await launch('store', { lastVersionRun: CURRENT_VERSION, latest: JSON.parse(FEED).latest }))
  record('a Store copy shows no mark, even for a version it once heard of', (await page.locator('[data-update-mark]').count()) === 0)
  await checkFromPalette(page)
  const store = await visible(page, '[data-update-note][data-update-note-tone="store"]')
  record('Check for Updates… in a Store copy answers "Updates come from the Microsoft Store." with Open in Microsoft Store', store && /Updates come from the Microsoft Store\./.test(await page.locator('[data-update-note]').innerText()) && (await page.locator('[data-update-open-store]').count()) === 1)
  const storeSettings = await openSettingsWindow(app, page, 'updates')
  await storeSettings.waitForSelector('.bsw-root[data-section="updates"]', { timeout: 6000 })
  record('a Store copy\'s About says the Store installs new versions and has no New versions card', /Microsoft Store/.test(await storeSettings.locator('[data-about-card]').innerText()) && (await storeSettings.locator('[data-updates-card]').count()) === 0)
  record('a Store copy made no request to the feed', requests.length === before, `requests=${requests.length - before}`)
  await app.close()
} catch (e) {
  record('update notices harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== UPDATE NOTICES SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  server.close()
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
