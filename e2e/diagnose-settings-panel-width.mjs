// Settings window → Cloudflare page at the window's default size, in the states seen on 0.38.2-preview.1
// (a long account name, a custom domain, a share-link domain the token cannot attach, recording
// storage not set up). Two things are checked:
//   - WIDTH: nothing on the Cloudflare page is wider than the Settings window's page area, and no part
//     of it is scrolled sideways, whether Settings is opened with ⌘, (then the Cloudflare page picked)
//     or at the Cloudflare page (the publish sheet, the Guide's "Set up", a notice). A screenshot
//     showed the left edge of the section cut off.
//   - SET UP RECORDING STORAGE: the Recording storage row offers it; pressing it brings the storage
//     fields (endpoint, bucket) into view with the endpoint focused, after a search that had hidden
//     the page has been cleared. Since 0.42 the fields are the Recording page's rows (the access keys are in
//     Accounts and keys), so "into view" means that page, with the Storage endpoint row focused.
// A throwaway user-data folder and vault, a made-up token and the fake Cloudflare API on this
// computer's loopback address. Nothing here contacts Cloudflare.
// TW_SHOTS_DIR=<dir> saves pictures of the panel in each way it was opened.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { openSettingsWindow, openSettingsAtCloudflare, gotoSection, closeSettingsWindow, shutdownApp } from './lib/settings-window.mjs'
import { startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-settings-width-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
mkdirSync(join(vault, 'probe'), { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(vault, 'probe', 'probe-outline.md'), ['---', 'title: Probe', '---', '', '### One', '', '- point', ''].join('\n'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  vaultRoot: vault, publishBaseUrl: 'https://handouts.ada-lovelace.example', sharedTalkLinkBase: 'https://drafts.ada-lovelace.example', cfPagesProject: 'adas-handouts',
}))
const shots = process.env.TW_SHOTS_DIR ? resolve(process.env.TW_SHOTS_DIR) : null
if (shots) mkdirSync(shots, { recursive: true })

const TOKEN = ['test', 'token', 'settings', 'width', '0123456789abcdef'].join('-')
// An account name as Cloudflare makes one from an e-mail address: long, and with no space to break at.
const ACCOUNT = { id: 'acc-ada-0001', name: "Ada.Lovelace.long.address@example-university.invalid's Account" }
const SITE = 'adas-handouts'

const CHECKS = [
  'the app started on the throwaway folder at its default window size, pointed at the fake API; the Settings window opens at its default size',
  'opened with ⌘, and the Cloudflare page picked: nothing on the page is wider than the Settings window\'s page area and nothing is scrolled sideways',
  'opened at the Cloudflare page: nothing on the page is wider than the Settings window\'s page area and nothing is scrolled sideways',
  'the Recording storage row says "Not set up" and offers "Set up recording storage"; its words do not send the person "below"',
  '"Set up recording storage" brings the Recording page\'s Storage endpoint row into view, focused (after a search that took the Cloudflare page away has been cleared)',
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

let app
let api
let exitCode = 1
try {
  await ensureFreshBuild(root)
  api = await startCloudflareApiStub({
    sites: [], accounts: [ACCOUNT], accountSites: { [ACCOUNT.id]: [SITE] },
    zones: [{ id: 'zone-0001', name: 'ada-lovelace.example', account: ACCOUNT.id }],
    // The token cannot attach the share-link domain (no Workers Routes permission), as in his Settings.
    tokens: { [TOKEN]: { accounts: [ACCOUNT.id], routes: false } },
  })
  const env = { TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  app = await electron.launch({ args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`], cwd: root, env })
  if (process.env.TW_E2E_SHOW !== '1') {
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
      BrowserWindow.getAllWindows().forEach(hide)
      electronApp.on('browser-window-created', (_event, win) => hide(win))
    })
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.tw?.cloudflare?.status))
  const where = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const size = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')) ?? BrowserWindow.getAllWindows()[0]
    return win.getContentSize()
  })
  const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight])
  const record0 = realpathSync(where) === realpathSync(userData) && size[0] === 1400 && size[1] === 900
  const record0Detail = `window ${size.join(' × ')}; page ${viewport.join(' × ')}`

  const shot = async (sw, name) => { if (shots) await sw.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {}) }
  const pageSize = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'))
    return win ? win.getContentSize() : null
  })

  // Connect (the token is saved in the Settings window: the editor window is refused).
  let sw = await openSettingsWindow(app, page, 'cloudflare')
  const part = (name) => sw.locator(`[data-cloudflare="${name}"]`)
  await part('token').locator('input').fill(TOKEN)
  await part('token').getByRole('button', { name: 'Save token' }).click()
  await sw.waitForFunction((name) => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === `Connected · ${name}`, ACCOUNT.name, { timeout: 40_000 })
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="connection"]')?.getAttribute('data-busy') === 'no', null, { timeout: 40_000 })
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="share-link"]')?.getAttribute('data-state') === 'no-permission', null, { timeout: 20_000 }).catch(() => {})
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="recording-storage"]')?.getAttribute('data-state') === 'not-set-up')
  const settingsSize = await pageSize()
  record(0, record0 && settingsSize && settingsSize[0] === 1000 && settingsSize[1] === 690, `${record0Detail}; Settings window ${settingsSize?.join(' × ')}`)
  await closeSettingsWindow(app)

  /** Everything that could put part of the page out of sight sideways. The page area is the Settings window's scrolling pane around the Cloudflare page. */
  const measure = () => sw.evaluate(() => {
    const section = document.querySelector('[data-settings-page="cloudflare"]')
    const pane = section.parentElement
    const box = pane.getBoundingClientRect()
    const scrolledSideways = []
    for (let node = section; node; node = node.parentElement) {
      if (node.scrollLeft) scrolledSideways.push(`${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''} by ${node.scrollLeft}px`)
    }
    if (document.scrollingElement?.scrollLeft) scrolledSideways.push(`the page by ${document.scrollingElement.scrollLeft}px`)
    // Visible elements whose box goes past the page area's left or right edge.
    const outside = [...section.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5)
    }).slice(0, 6).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" (${Math.round(el.getBoundingClientRect().left)}…${Math.round(el.getBoundingClientRect().right)})`)
    const label = section.querySelector('[data-cloudflare="connection-label"]').getBoundingClientRect()
    return {
      panel: `${Math.round(box.left)}…${Math.round(box.right)} of ${window.innerWidth}`,
      modalWide: document.documentElement.scrollWidth - document.documentElement.clientWidth, bodyWide: pane.scrollWidth - pane.clientWidth,
      scrolledSideways, outside, labelLeft: Math.round(label.left - box.left),
    }
  })
  const fits = (m) => m.modalWide <= 0 && m.bodyWide <= 0 && m.scrolledSideways.length === 0 && m.outside.length === 0 && m.labelLeft >= 0
  const said = (m) => `page area ${m.panel}; window wider than itself by ${m.modalWide}px / page area by ${m.bodyWide}px; scrolled sideways: ${m.scrolledSideways.join(', ') || 'nothing'}; past its edges: ${m.outside.join(' · ') || 'nothing'}; "Connected" starts ${m.labelLeft}px inside the page area`

  // 1. ⌘, then the Cloudflare page.
  sw = await openSettingsWindow(app, page, 'cloudflare')
  await part('connection').waitFor({ state: 'visible' })
  await part('section').scrollIntoViewIfNeeded()
  await sw.waitForTimeout(300)
  const byKey = await measure()
  await shot(sw, 'settings-cloudflare-opened-with-cmd-comma')
  record(1, fits(byKey), said(byKey))

  // 2. At the Cloudflare page (as the publish sheet, the Guide and the notices open it).
  sw = await openSettingsAtCloudflare(app, page)
  await part('connection').waitFor({ state: 'visible' })
  await sw.waitForTimeout(800)
  const atSection = await measure()
  await shot(sw, 'settings-cloudflare-opened-at-the-section')
  record(2, fits(atSection) && await sw.locator('button.bsw-nav[data-section="cloudflare"]').count() === 1, said(atSection))

  // 3. The Recording storage row.
  const rowText = (await part('recording-storage').innerText()).replace(/\s+/g, ' ').trim()
  record(3, rowText === 'Recording storage Recordings stay on this computer until storage is set up Not set up Set up recording storage' && !/below/.test(rowText), rowText)

  // 4. Set up recording storage. A search turns the window into a list of matching rows, which has no Cloudflare page (so no button
  // to press under it): the search is typed, seen to hide the page and the Recording page's nav button, then cleared, and the button pressed.
  await sw.getByLabel('Search settings').fill('cloudflare')
  await sw.waitForTimeout(300)
  const hiddenFirst = await part('recording-storage-set-up').count() === 0
  await sw.getByLabel('Clear search').click()
  await part('recording-storage-set-up').waitFor({ state: 'visible' })
  await part('recording-storage-set-up').click()
  const reached = await sw.waitForFunction(() => {
    const field = document.querySelector('input[aria-label="Storage endpoint"]')
    if (!field || document.activeElement !== field) return false
    const pane = field.closest('.bsw-pscroll') ?? document.documentElement
    const body = pane.getBoundingClientRect()
    const f = field.getBoundingClientRect()
    return f.top >= body.top - 1 && f.bottom <= body.bottom + 1
  }, null, { timeout: 5000 }).then(() => true, () => false)
  const searchNow = await sw.getByLabel('Search settings').inputValue()
  await shot(sw, 'settings-recording-storage-set-up')
  record(4, hiddenFirst && reached && searchNow === '', `a search had taken the Cloudflare page away: ${hiddenFirst}; the Storage endpoint row in view and focused: ${reached}; the search now: "${searchNow}"`)

  exitCode = ledger.summary('SETTINGS PANEL WIDTH').exitCode
} catch (error) {
  console.log(`FAIL  the journey could not run: ${String(error?.stack ?? error).split(TOKEN).join('[made-up token]')}`)
  try { ledger.summary('SETTINGS PANEL WIDTH') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  await shutdownApp(app)
  await api?.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
