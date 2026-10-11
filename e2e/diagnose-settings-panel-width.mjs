// Settings → Cloudflare at the window's default size, in the states seen on 0.38.2-preview.1
// (a long account name, a custom domain, a share-link domain the token cannot attach, recording
// storage not set up). Two things are checked:
//   - WIDTH: nothing in the Settings panel is wider than the panel, and no part of it is scrolled
//     sideways, whether Settings is opened with ⌘, or at the Cloudflare section (the publish sheet,
//     the Guide's "Set up", a notice). A screenshot showed the left edge of the section cut off.
//   - SET UP RECORDING STORAGE: the Recording storage row offers it; pressing it brings the fields
//     (endpoint, bucket, access keys) into view with the endpoint focused, even under a search that
//     had hidden them.
// A throwaway user-data folder and vault, a made-up token and the fake Cloudflare API on this
// computer's loopback address. Nothing here contacts Cloudflare.
// TW_SHOTS_DIR=<dir> saves pictures of the panel in each way it was opened.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
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
  'the app started on the throwaway folder at its default window size, pointed at the fake API',
  'opened with ⌘, : nothing in the Settings panel is wider than the panel and nothing is scrolled sideways',
  'opened at the Cloudflare section: nothing in the Settings panel is wider than the panel and nothing is scrolled sideways',
  'the Recording storage row says "Not set up" and offers "Set up recording storage"; its words do not send the person "below"',
  '"Set up recording storage" brings Recording storage into view with the endpoint field focused, even under a search that hid it',
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
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env })
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
  record(0, realpathSync(where) === realpathSync(userData) && size[0] === 1400 && size[1] === 900, `window ${size.join(' × ')}; page ${viewport.join(' × ')}`)

  const settings = page.locator('[aria-label="Settings"]').first()
  const part = (name) => settings.locator(`[data-cloudflare="${name}"]`)
  const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {}) }
  const closeSettings = async () => { await page.keyboard.press('Escape'); await page.locator('[aria-label="Settings"]').waitFor({ state: 'detached' }) }

  // Connect.
  await page.keyboard.press('ControlOrMeta+,')
  await part('token').locator('input').fill(TOKEN)
  await part('token').getByRole('button', { name: 'Save token' }).click()
  await page.waitForFunction((name) => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === `Connected · ${name}`, ACCOUNT.name, { timeout: 40_000 })
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="connection"]')?.getAttribute('data-busy') === 'no', null, { timeout: 40_000 })
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="share-link"]')?.getAttribute('data-state') === 'no-permission', null, { timeout: 20_000 }).catch(() => {})
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="recording-storage"]')?.getAttribute('data-state') === 'not-set-up')
  await closeSettings()

  /** Everything that could put part of the panel out of sight sideways. */
  const measure = () => page.evaluate(() => {
    const modal = document.querySelector('[aria-label="Settings"]')
    const body = modal.querySelector('[data-cloudflare="section"]').parentElement
    const box = modal.getBoundingClientRect()
    const scrolledSideways = []
    for (let node = modal.querySelector('[data-cloudflare="section"]'); node; node = node.parentElement) {
      if (node.scrollLeft) scrolledSideways.push(`${node.tagName.toLowerCase()}${node.getAttribute('aria-label') ? `[${node.getAttribute('aria-label')}]` : ''} by ${node.scrollLeft}px`)
    }
    if (document.scrollingElement?.scrollLeft) scrolledSideways.push(`the page by ${document.scrollingElement.scrollLeft}px`)
    // Visible elements whose box goes past the panel's left or right edge.
    const outside = [...modal.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5)
    }).slice(0, 6).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}" (${Math.round(el.getBoundingClientRect().left)}…${Math.round(el.getBoundingClientRect().right)})`)
    const label = modal.querySelector('[data-cloudflare="connection-label"]').getBoundingClientRect()
    return {
      panel: `${Math.round(box.left)}…${Math.round(box.right)} of ${window.innerWidth}`,
      modalWide: modal.scrollWidth - modal.clientWidth, bodyWide: body.scrollWidth - body.clientWidth,
      scrolledSideways, outside, labelLeft: Math.round(label.left - box.left),
    }
  })
  const fits = (m) => m.modalWide <= 0 && m.bodyWide <= 0 && m.scrolledSideways.length === 0 && m.outside.length === 0
  const said = (m) => `panel ${m.panel}; wider than the panel by ${m.modalWide}px (panel) / ${m.bodyWide}px (its body); scrolled sideways: ${m.scrolledSideways.join(', ') || 'nothing'}; past its edges: ${m.outside.join(' · ') || 'nothing'}; "Connected" starts ${m.labelLeft}px inside the panel`

  // 1. ⌘,
  await page.keyboard.press('ControlOrMeta+,')
  await part('connection').waitFor({ state: 'visible' })
  await part('section').scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const byKey = await measure()
  await shot('settings-cloudflare-opened-with-cmd-comma')
  record(1, fits(byKey), said(byKey))
  await closeSettings()

  // 2. At the Cloudflare section (as the publish sheet, the Guide and the notices open it).
  await page.evaluate(() => window.tw.cloudflare.openSettings())
  await part('connection').waitFor({ state: 'visible' })
  await page.waitForTimeout(800) // the section is looked for every 50 ms until it is drawn, then scrolled to
  const atSection = await measure()
  await shot('settings-cloudflare-opened-at-the-section')
  record(2, fits(atSection), said(atSection))

  // 3. The Recording storage row.
  const rowText = (await part('recording-storage').innerText()).replace(/\s+/g, ' ').trim()
  record(3, rowText === 'Recording storage Recordings stay on this computer until storage is set up Not set up Set up recording storage' && !/below/.test(rowText), rowText)

  // 4. Set up recording storage, under a search that shows only the Cloudflare section.
  await settings.getByLabel('Search settings').fill('cloudflare')
  const hiddenFirst = await settings.locator('[data-settings-section="recording"]').count() === 0
  await part('recording-storage-set-up').click()
  const reached = await page.waitForFunction(() => {
    const modal = document.querySelector('[aria-label="Settings"]')
    const head = modal?.querySelector('[data-settings-section="recording"]')
    const field = modal?.querySelector('input[aria-label="Recording storage endpoint"]')
    if (!head || !field || document.activeElement !== field) return false
    const body = head.parentElement.getBoundingClientRect()
    const r = head.getBoundingClientRect()
    const f = field.getBoundingClientRect()
    return r.top >= body.top - 1 && f.bottom <= body.bottom + 1
  }, null, { timeout: 5000 }).then(() => true, () => false)
  const searchNow = await settings.getByLabel('Search settings').inputValue()
  await shot('settings-recording-storage-set-up')
  record(4, hiddenFirst && reached && searchNow === '', `the search had hidden the section: ${hiddenFirst}; the section at the top with the endpoint focused: ${reached}; the search now: "${searchNow}"`)

  exitCode = ledger.summary('SETTINGS PANEL WIDTH').exitCode
} catch (error) {
  console.log(`FAIL  the journey could not run: ${String(error?.stack ?? error).split(TOKEN).join('[made-up token]')}`)
  try { ledger.summary('SETTINGS PANEL WIDTH') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  const pid = app?.process().pid
  try { await app?.close() } catch { /* already closed */ }
  if (pid) { try { process.kill(pid) } catch { /* gone */ } }
  await api?.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
