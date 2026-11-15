// Updating in place (ADR-0044) in the real app, run from source: the one click. A throwaway user-data folder and
// vault; the feed AND the update file are a stand-in on this computer's loopback address (the test-only
// TW_E2E_UPDATES_FEED; a packaged build ignores it). Run from source, the app downloads and checks the file
// exactly as a packaged one does, then stops before handing it to Squirrel.Mac / the installer and logs the
// restart instead (update-installer.ts `install: false`). The real replacement is proved separately with two
// locally signed builds (docs/RELEASING.md, "Proving an in-place update on this Mac").
//
// The journey: the feed offers a newer version → the mark appears and NOTHING is downloaded (zero requests for the
// file) → the popover offers Update → Update starts the download → Cancel stops it and leaves no partial file →
// a corrupted file is refused ("did not match") and the app is unchanged, with Try again and the download page →
// a genuine file of another version under the offered name is refused ("not the version offered") → the network
// dropping mid-download is reported as such → Update while a presenter window opens: the download
// finishes, the restart waits ("Restart to finish updating", Restart disabled while presenting) → presenting ends:
// Restart restarts (logged) → the alpha switch offers the alpha and switching it off never offers a downgrade.
// On Windows there is no in-place update in this release: the popover says so and offers the download page.
import { _electron as electron } from 'playwright'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openSettingsWindow, closeSettingsWindow } from './lib/settings-window.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { testProfileEnv } from './lib/test-profile.mjs'
import { makeUpdateZip, sizeLabel } from '../scripts/lib/update-test-zip.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CURRENT_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
// How the app writes the running version in a sentence ("0.45.0, alpha 1" for an alpha).
const CURRENT_LABEL = CURRENT_VERSION.replace(/^(\d+\.\d+\.\d+)-([a-z]+)\.(\d+)$/, '$1, $2 $3')
const [major, minor] = CURRENT_VERSION.split('.').map(Number)
const NEXT = `${major}.${minor + 1}.0`
const ALPHA = `${major}.${minor + 2}.0-alpha.3`
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// ── The stand-in: feed and update files ───────────────────────────────────────────────────────────
const WINDOWS = process.platform === 'win32'
// A Mac update file shaped as the release makes it, its Info.plist naming the version offered; and a genuine file of
// the running version (an older build) to put under the newer name.
const BODY = WINDOWS ? randomBytes(6 * 1024 * 1024) : makeUpdateZip({ version: NEXT, padBytes: 6 * 1024 * 1024 })
const OLD_BODY = WINDOWS ? BODY : makeUpdateZip({ version: CURRENT_VERSION, padBytes: 1024 })
const hashOf = (b) => createHash('sha512').update(b).digest('base64')
const ASSET = process.platform === 'win32' ? 'TalkWeaver-windows-x64-setup.exe' : 'TalkWeaver-mac-arm64.zip'
const platformKey = process.platform === 'win32' ? 'windows' : 'mac'
const assetRequests = []
const feedRequests = []
let mode = 'good' // good | corrupt | drop | old
let hold = null // a promise the second half of the file waits for
let releaseHold = () => {}
const holdNext = () => { hold = new Promise((r) => { releaseHold = () => { hold = null; r() } }) }
let base = ''
const entry = (version) => ({
  version, released: '2026-11-20', summary: ['One plain line about this version.'], notes: `https://talkweaver.app/whats-new#${version}`,
  download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' },
  update: { [platformKey]: { url: `${base}/releases/download/v${version}/${ASSET}`, sha512: hashOf(mode === 'old' ? OLD_BODY : BODY), size: (mode === 'old' ? OLD_BODY : BODY).length } },
})
const feedText = () => {
  const release = entry(NEXT)
  const { update: _u, ...latest } = release
  return JSON.stringify({ schema: 1, latest, channels: { release, alpha: entry(ALPHA) } })
}
const server = createServer(async (req, res) => {
  if (req.url === '/updates.json') {
    feedRequests.push({ url: req.url, headers: req.headers })
    res.setHeader('Content-Type', 'application/json')
    res.end(feedText())
    return
  }
  if (req.url?.startsWith('/releases/download/')) {
    assetRequests.push({ url: req.url, headers: req.headers })
    const body = mode === 'corrupt' ? Buffer.from(BODY) : mode === 'old' ? OLD_BODY : BODY
    if (mode === 'corrupt') body[body.length >> 1] ^= 0xff
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
    const half = body.length >> 1
    res.write(body.subarray(0, half))
    if (hold) await hold
    if (mode === 'drop') { req.socket.destroy(); return }
    res.end(body.subarray(half))
    return
  }
  res.statusCode = 404
  res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${server.address().port}`
const feedUrl = `${base}/updates.json`

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-in-place-'))
const vault = join(tempRoot, 'vault')
const td = join(vault, 'update-fixture')
mkdirSync(td, { recursive: true })
writeFileSync(join(td, 'update-fixture-outline.md'), ['---', 'title: Update Fixture', '---', '', '## Opening', '', '### One', '', '- A point', ''].join('\n'))
const ud = mkdtempSync(join(tempRoot, 'ud-'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const visible = (page, selector, timeout = 6000) => page.waitForSelector(selector, { state: 'visible', timeout }).then(() => true, () => false)
const markText = async (page) => (await page.locator('[data-update-mark]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const waitMark = async (page, re, timeout = 15000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (re.test(await markText(page))) return true; await pause(150) }
  return false
}
const popText = async (page) => (await page.locator('[data-update-popover]').innerText().catch(() => '')).replace(/\s+/g, ' ')
async function openPopover(page) {
  if (await page.locator('[data-update-popover]').count()) return
  await page.locator('[data-update-mark]').click()
  await visible(page, '[data-update-popover]')
}
async function checkFromPalette(page) {
  await page.keyboard.press(`${MOD}+Shift+P`)
  await page.waitForSelector('[data-command-menu] input', { timeout: 4000 })
  await page.waitForTimeout(250)
  await page.keyboard.press(`${MOD}+A`)
  await page.keyboard.type('Check for Updates')
  await page.waitForSelector('[data-command="check-for-updates"]', { timeout: 4000 })
  await page.keyboard.press('Enter')
}
const cacheLeftovers = () => {
  const dir = join(ud, 'updater-cache')
  if (!existsSync(dir)) return []
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
  return walk(dir)
}
const partials = () => cacheLeftovers().filter((f) => /temp-/.test(f))

let app
try {
  await ensureFreshBuild(REPO)
  app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1', ...testProfileEnv(ud), TW_E2E_UPDATES_SOURCE: 'website', TW_E2E_UPDATES_FEED: feedUrl } })
  const out = []
  app.process().stdout?.on('data', (chunk) => out.push(String(chunk)))
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openTalkByTitle(page, 'Update Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })

  // ── 1. Found, nothing downloaded ─────────────────────────────────────────────────────────────────
  await checkFromPalette(page)
  const note = await visible(page, '[data-update-note][data-update-note-tone="new"]')
  const noteText = note ? (await page.locator('[data-update-note]').innerText()).replace(/\s+/g, ' ') : ''
  record('Check for Updates… answers that the newer version is available, with Update', note && noteText.includes(`TalkWeaver ${NEXT} is available.`) && /Update/.test(noteText) && !/Download from talkweaver\.app/.test(noteText), noteText)
  await page.locator('[data-update-note] button[aria-label="Dismiss"]').click()
  record('the status-bar mark appears', await waitMark(page, new RegExp(`${NEXT.replace(/\./g, '\\.')} is available`)), await markText(page))
  await openPopover(page)
  const offer = await popText(page)
  if (WINDOWS) {
    // No in-place update on Windows in this release (ADR-0044 §5): the reason and the download page, never Update.
    record('Windows: the popover says in-place updates are not available yet and offers the download page, not Update',
      offer.includes('In-place updates are not available on Windows yet.') && /Download from talkweaver\.app/.test(offer) && await page.locator('[data-update-popover] [data-update-update]').count() === 0, offer.slice(0, 260))
    const pressed = await page.evaluate(() => window.tw.updates.update())
    await pause(800)
    record('Windows: asking the main process to update anyway downloads nothing', pressed.install.phase === 'idle' && assetRequests.length === 0, `phase ${pressed.install.phase}; file requests ${assetRequests.length}`)
    throw Object.assign(new Error('windows-done'), { done: true })
  }
  record('the popover offers Update, Not now and Skip this version, and says what Update does', /Update/.test(offer) && /Not now/.test(offer) && /Skip this version/.test(offer) && offer.includes(`Update downloads ${NEXT} (${sizeLabel(BODY.length)}), replaces this copy and restarts TalkWeaver`), offer.slice(0, 220))
  await pause(800)
  record('nothing is downloaded before the click: zero requests for the file', assetRequests.length === 0, `file requests=${assetRequests.length}, feed requests=${feedRequests.length}`)

  // ── 2. Update, then Cancel ────────────────────────────────────────────────────────────────────────
  holdNext()
  await page.locator('[data-update-popover] [data-update-update]').click()
  record('Update starts the download (the mark shows its progress)', await waitMark(page, /^Downloading .* · \d+%$/), await markText(page))
  for (let i = 0; i < 100 && assetRequests.length === 0; i++) await pause(100) // the mark shows 0% before the request lands
  const req = assetRequests[0]
  record('the download is one GET of the file with the fixed User-Agent, no query, cookie, identifier or version', assetRequests.length === 1 && !req.url.includes('?') && req.headers['user-agent'] === 'TalkWeaver' && !req.headers.cookie && !Object.keys(req.headers).some((h) => /staging|x-user/i.test(h)) && !JSON.stringify(req.headers).includes(CURRENT_VERSION), `requests=${assetRequests.length} ${JSON.stringify(req?.headers)}`)
  await openPopover(page)
  record('the popover shows a progress bar and Cancel', await page.locator('[data-update-progress]').count() === 1 && await page.locator('[data-update-cancel]').count() === 1, await popText(page))
  let partial = []
  for (let i = 0; i < 50 && partial.length === 0; i++) { partial = partials(); if (!partial.length) await pause(100) }
  record('half-way, the partial download is on disk (so the next check means something)', partial.length > 0, partial.join(', '))
  await page.locator('[data-update-popover] [data-update-cancel]').click()
  const afterCancel = await page.evaluate(() => window.tw.updates.get())
  record('Cancel changes the state at once', afterCancel.install.phase === 'idle', afterCancel.install.phase)
  releaseHold()
  record('Cancel returns to the offer', await waitMark(page, /is available$/), await markText(page))
  await pause(800)
  record('Cancel leaves nothing in the updater\'s cache', cacheLeftovers().length === 0, cacheLeftovers().join(', '))

  // ── 3. A corrupted file ──────────────────────────────────────────────────────────────────────────
  mode = 'corrupt'
  await openPopover(page)
  await page.locator('[data-update-popover] [data-update-update]').click()
  record('a corrupted file is refused: "Update to … failed"', await waitMark(page, /failed$/), await markText(page))
  await openPopover(page)
  const failed = await popText(page)
  record('it says the file did not match, that this version is unchanged, and offers Try again and the download page', /did not match the published one, so it was not used/.test(failed) && failed.includes(`TalkWeaver ${CURRENT_LABEL} is unchanged`) && /Try again/.test(failed) && /Download from talkweaver\.app/.test(failed), failed)
  record('the app is still the same version and still running', (await app.evaluate(({ app: a }) => a.getVersion())) === CURRENT_VERSION && !page.isClosed())
  record('the refused file is not kept', cacheLeftovers().length === 0 && !out.join('').includes('restart into'), cacheLeftovers().join(', '))

  // ── 3b. A genuine file of another version under the offered name ──────────────────────────────────
  mode = 'old'
  await page.evaluate(() => window.tw.updates.check())
  await openPopover(page)
  await page.locator('[data-update-popover] [data-update-retry]').click()
  record('a file of another version under the offered name is refused: "Update to … failed"', await waitMark(page, /failed$/, 20000), await markText(page))
  await openPopover(page)
  const wrong = await popText(page)
  record('it says the download was not the version offered; nothing restarts and nothing is kept', /The download was not the version offered, so it was not installed\./.test(wrong) && !out.join('').includes('restart into') && cacheLeftovers().length === 0, wrong.slice(0, 200))
  mode = 'good'
  await page.evaluate(() => window.tw.updates.check())
  await openPopover(page)

  // ── 4. The network drops mid-download ─────────────────────────────────────────────────────────────
  mode = 'drop'
  holdNext()
  await openPopover(page)
  await page.locator('[data-update-popover] [data-update-retry]').click()
  await waitMark(page, /^Downloading/)
  releaseHold()
  const dropped = await waitMark(page, /failed$/, 30000)
  await openPopover(page)
  const droppedText = await popText(page)
  record('the network dropping mid-download is reported in plain words and changes nothing', dropped && /The download stopped/.test(droppedText), droppedText.slice(0, 200))

  // ── 5. The restart waits while presenting ──────────────────────────────────────────────────────────
  mode = 'good'
  holdNext()
  await page.locator('[data-update-popover] [data-update-retry]').click()
  await waitMark(page, /^Downloading/)
  const known = new Set(app.windows())
  await page.keyboard.press('Escape')
  await page.locator('[data-command="present-presenter"]').first().click()
  let presenter = null
  for (let i = 0; i < 120 && !presenter; i++) { presenter = app.windows().find((w) => !known.has(w) && !w.isClosed()) ?? null; if (!presenter) await pause(250) }
  record('a presenter window opens during the download', !!presenter)
  await pause(1500)
  record('while presenting there is no mark in the editor window', (await page.locator('[data-update-mark]').count()) === 0)
  releaseHold()
  await pause(2500)
  record('the download finishes while presenting and nothing restarts', !out.join('').includes('restart into') && !page.isClosed(), out.join('').split('\n').filter((l) => l.includes('[updates]')).slice(-3).join(' | '))
  const snapWhilePresenting = await page.evaluate(() => window.tw.updates.get())
  record('the update waits: state "waiting", held back by the presenter window', snapWhilePresenting.install.phase === 'waiting' && snapWhilePresenting.blockers.includes('presenting'), JSON.stringify({ install: snapWhilePresenting.install, blockers: snapWhilePresenting.blockers }))
  const pressed = await page.evaluate(() => window.tw.updates.restart())
  record('pressing Restart while presenting does nothing', pressed.install.phase === 'waiting' && !out.join('').includes('restart into'))
  record('while it waits nothing has been handed to Squirrel.Mac (the hand-over happens only at restart time)', !/handing \S+ to Squirrel\.Mac|preparing \S+ \(Squirrel\.Mac/.test(out.join('')))
  for (const w of app.windows().filter((x) => !known.has(x) && !x.isClosed())) await w.close().catch(() => {})
  await page.bringToFront()
  record('presenting over: the mark reads "Restart to finish updating"', await waitMark(page, /^Restart to finish updating$/, 20000), await markText(page))
  await openPopover(page)
  const ready = await popText(page)
  record('the popover says it is ready and Restart can be pressed', new RegExp(`TalkWeaver ${NEXT.replace(/\./g, '\\.')} is ready`).test(ready) && await page.locator('[data-update-restart]').isEnabled(), ready)
  await page.locator('[data-update-popover] [data-update-restart]').click()
  record('Restart restarts into the new version (a run from source logs it instead of installing)', await waitMark(page, /^Restarting into/) && (await page.locator('[data-update-popover] [data-update-cancel]').count()) === 0 && await (async () => { for (let i = 0; i < 40; i++) { if (out.join('').includes(`restart into ${NEXT} (test run from source): not installed`)) return true; await pause(100) } return false })(), out.join('').split('\n').filter((l) => l.includes('[updates]')).slice(-2).join(' | '))
  record('the file was downloaded only on clicks (five starts: cancelled, corrupt, another version, dropped, good)', assetRequests.length === 5, `file requests=${assetRequests.length}`)

  // ── 6. The alpha switch ───────────────────────────────────────────────────────────────────────────
  const settings = await openSettingsWindow(app, page, 'updates')
  await settings.waitForSelector('[data-updates-card]', { timeout: 6000 })
  const alphaRow = await settings.locator('[data-setting="alpha-versions"]').innerText()
  record('Settings has "Get early versions (alpha)", off, with how to go back', /Get early versions \(alpha\)/.test(alphaRow) && /To go back, switch this off/.test(alphaRow) && (await settings.locator('[data-update-alpha]').getAttribute('aria-checked')) === 'false', alphaRow.replace(/\s+/g, ' '))
  const before = feedRequests.length
  await settings.locator('[data-update-alpha]').click()
  const on = await page.evaluate(() => window.tw.updates.get())
  record('switching it on offers the alpha at once, with no new request', on.alpha === true && on.state.channels.alpha.version === ALPHA && feedRequests.length === before, JSON.stringify({ alpha: on.alpha, latest: on.state.latest?.version }))
  // Preferences live in this Mac's settings store (userData/settings.json, mapped from config.json's key).
  const stored = await (async () => { for (let i = 0; i < 40; i++) { const t = existsSync(join(ud, 'settings.json')) ? readFileSync(join(ud, 'settings.json'), 'utf8') : ''; if (/"updates\.alphaVersions":\s*true/.test(t)) return true; await pause(100) } return false })()
  record('the switch is stored for this Mac (its settings store in the user-data folder)', stored)
  await settings.locator('[data-update-alpha]').click()
  await closeSettingsWindow(app)
  const off = await page.evaluate(() => window.tw.updates.get())
  record('switching it off offers the release again', off.alpha === false && off.state.latest?.version === NEXT)
} catch (error) {
  if (!error?.done) record('the run finished', false, String(error?.stack ?? error))
} finally {
  try { await app?.close() } catch { /* already closed */ }
  server.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.pass)
console.log(`\nin-place update: ${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
