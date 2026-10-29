// Settings window → Cloudflare page in the real app (spec docs/plans/cloudflare-setup-in-app, ticket 03): the
// connection header and the Publishing handouts row, in the spec's words, through the window a
// person uses. A throwaway user-data folder and vault, made-up tokens and the fake Cloudflare API on
// this computer's loopback address (the app is pointed at it by the test-only override, which a
// packaged build ignores). Nothing here contacts Cloudflare, the installed app or its data.
//
// The journey: not connected → paste a token (the check runs while the editor is typed in) →
// connected → create the site → Ready → a handout published before going live is set up goes up
// without live features (D9: the live service is set up on purpose) → Set up going live (Setting
// up…, then Ready, its build in Details) → publish with the live address → a token without the
// live-service permission still publishes and redeploys nothing → rejected → could not check → a
// changed share-link address uploads no code before the next publish → the keys lost: the stop
// → the Worker deleted in the dashboard: Not set up, then set up again → several accounts → disconnect.
//
// The Recording storage row (ticket 06) rides the same journey: an install that took its recording
// keys from Bitwarden is told once to type them in and loses the two old config keys; then Not set
// up → keys typed → Keys saved, not checked → Check → Ready → Bucket not found → Keys rejected,
// against an S3 stand-in on loopback with made-up keys.
//
// NOT RUN since the several-Macs change (ticket 02 and its fix rounds). Set-up now asks the live
// service itself which build it is and whether it accepts this computer's key, at the workers.dev
// address the fake API reports. This script gives the app no stand-in for that address, so from step
// 5 on the app would send those requests to a real hostname on the internet and set-up would not
// finish. Do not run it until the app can be pointed at a live-service stand-in. The expectations of
// `keysGiven()` and steps 18 to 20 are written to the new model (one secrets request per set-up,
// naming this computer's own key; none on an update; no signing secret) but have not been run. Steps
// 7 and 18 are written to the current model too (a changed share-link address marks nothing out of
// date: it sends only its own lookup, attach and removal requests, and no script upload; decisions
// R2, R3 and R11), and have not been run either.
//
// Since 0.42 Settings is its own window (⌘, from the editor window; a page of it is picked with its nav button). The token,
// the account, Disconnect, the share-link address and the Cloudflare fields can be changed only from that window: the editor
// window is refused (check 23). The recording keys are typed in Accounts and keys as id:secret, and the endpoint and
// bucket are the Recording page's rows (set here through the editor's call, which main still answers).
//
// TW_SHOTS_DIR=<dir> saves a picture of the Cloudflare screen in each state.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { findSettingsWindow, openSettingsWindow, closeSettingsWindow, gotoSection, shutdownApp } from './lib/settings-window.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { REPLY_TEXT_MARK, WORKERS_SUBDOMAIN, startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'
import { S3_REPLY_TEXT_MARK, startS3Stub } from '../scripts/lib/s3-stub.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-cloudflare-settings-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'cloudflare-probe'
const outlinePath = join(vault, slug, `${slug}-outline.md`)
mkdirSync(userData, { recursive: true })
mkdirSync(join(vault, slug), { recursive: true })
const outline = ['---', 'title: Cloudflare probe', 'outline_version: 2', '---', '', '### One', '{id=one}', '', '- A point', ''].join('\n')
writeFileSync(outlinePath, outline)
// The two recording keys of an earlier version, as an install that took its keys from Bitwarden has them.
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingR2CredsSource: 'bws', recordingR2BwsSecretId: 'made-up-secret-id' }))
const shots = process.env.TW_SHOTS_DIR ? resolve(process.env.TW_SHOTS_DIR) : null
if (shots) mkdirSync(shots, { recursive: true })

// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'cloudflare', 'settings', name, '0123456789abcdef'].join('-')
const TOKENS = { full: fake('full'), pagesOnly: fake('pagesonly'), both: fake('both'), unknown: fake('unknown') }
const S3_KEYS = { good: { id: fake('recording-goodid'), secret: fake('recording-goodsecret') }, unknown: { id: fake('recording-unknownid'), secret: fake('recording-unknownsecret') } }
const SECRET_VALUES = [...Object.values(TOKENS), ...Object.values(S3_KEYS).flatMap((keys) => [keys.id, keys.secret])]
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const GRACE = { id: 'acc-grace-0002', name: 'Grace Hopper' }

// The Publishing handouts row with nothing to report: its name and its one line of detail, and no dash (ticket 04).
const NOTHING_TO_REPORT = 'Publishing handouts Handouts are published to your own Cloudflare Pages site'

const CHECKS = [
  'the app started on the throwaway folder, pointed at the fake API',
  'Settings shows "Not connected", a token field and "How to make a token" with the permissions of all four features',
  'pasting a token shows "Checking…", and the editor takes typing while the check waits for Cloudflare',
  'the check ends "Connected · <account name>" with Check again, Replace token and Disconnect; the account was found, not typed',
  'the row says "No site yet" with the one action "Create talkweaver-handouts" at its right-hand edge and no dash; pressing it makes the site and the row turns Ready',
  'Set up going live: the row goes Setting up… then Ready ("Live sessions run on your Cloudflare account"; its build and address in Details), the live service deployed with the token from Settings; a handout then publishes with its address',
  'Replace token with one that lacks the live-service permission: publishing stays Ready and the row names the permission',
  'with that token a handout still publishes, and the live service is not redeployed',
  'a token Cloudflare does not know: "Cloudflare did not accept this token", with Replace token only',
  'Check again with no answer from Cloudflare: "Could not check (offline?) · last checked …" and the last known row greyed',
  'a token that sees two accounts: "Choose an account", and the picker\'s choice connects',
  'Disconnect: "Not connected", and the token is gone from the user-data folder',
  'no token and no text of a Cloudflare reply in the window, the app\'s output or any file',
  'the feature rows (Publishing handouts, Going live and sharing, Share-link domain, Recording storage) are one bordered list: name and one line of detail at the left, the state or the one action at the right-hand edge; the connection header keeps its buttons at the right',
  'no dash stands in for a row with nothing to report, and the hint under Live Worker URL is gone',
  'a former Bitwarden recording set-up is told "Recording storage: enter your access keys" once, and its two config keys are dropped',
  'the Recording storage row: Not set up (with "Set up recording storage") → keys typed → "Keys saved, not checked" → Check → Ready → "Bucket not found" → "Keys rejected"; each check is one list request',
  'before Set up going live the row offers "Set up going live", and a handout publishes without live features ("Published. Going live is not set up: Settings → Cloudflare"); the publish sets nothing up',
  'a changed share-link address marks nothing out of date: the next publish uploads no code, sends no secret and says nothing about an update; the only writes about the Worker are the share-address action\'s own',
  'the keys gone from this computer with the service deployed: the row says "The live service exists but this computer has lost its keys" with what resetting breaks; a publish goes up without live features and nothing is redeployed',
  'the Worker deleted in Cloudflare\'s dashboard: Check again finds it gone and the row reads Not set up; Set up going live then makes new keys and ends Ready',
  'a custom domain on the site: the Publishing handouts row shows it ("Site talkweaver-handouts · handouts.example", a link); the Share-link domain row suggests share.handouts.example (also in the empty field) with "Use share.handouts.example"; nothing is attached before the press; pressing it saves it and attaches it to the live service now (Attached); the live address stays the Worker\'s own',
  'with a token that may not touch the zone\'s Workers routes, pressing "Use share.handouts.example" saves it, attaches nothing, and the row says "Add the permission Zone · Workers Routes · Edit to your Cloudflare token, then press Check again"',
  'the Settings window\'s own calls are refused from the editor window and allowed from the Settings window: saving a token, choosing an account, Disconnect, the share-link address and the Cloudflare fields change nothing when the editor window asks (the Settings-only message), and work from the Settings window',
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

function findIn(dir, values) {
  const hits = []
  const needles = values.flatMap((value) => [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le')])
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && needles.some((needle) => readFileSync(path).includes(needle))) hits.push(relative(dir, path))
    }
  }
  walk(dir)
  return hits
}

let app
let api
let s3
let output = ''
let exitCode = 1
try {
  await ensureFreshBuild(root)
  api = await startCloudflareApiStub({
    sites: [],
    accounts: [ADA, GRACE],
    zones: [{ id: 'zone-ada-0001', name: 'handouts.example', account: ADA.id }],
    workerDomains: { [ADA.id]: ['drafts.handouts.example'] },
    tokens: { [TOKENS.full]: { accounts: [ADA.id] }, [TOKENS.pagesOnly]: { accounts: [ADA.id], workers: false }, [TOKENS.both]: { accounts: [ADA.id, GRACE.id] } },
  })
  s3 = await startS3Stub({ buckets: ['talks'], keys: [S3_KEYS.good.id] })
  // Only what the app needs from this shell: no credential of the person running the test goes in.
  const env = { TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  app = await electron.launch({ args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`], cwd: root, env })
  app.process().stdout.on('data', (chunk) => { output += chunk })
  app.process().stderr.on('data', (chunk) => { output += chunk })
  // Out of the way of whoever is at this computer (as the secrets gate does). TW_E2E_SHOW=1 leaves the window visible.
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
  const onThrowaway = realpathSync(where) === realpathSync(userData)
  record(0, onThrowaway)
  if (!onThrowaway) throw new Error('not on the throwaway user-data folder: stopping before any token is saved')

  // The one-time notice for the former Bitwarden recording set-up, and the two config keys gone.
  const NOTICE = 'Recording storage: enter your access keys'
  const notice = page.locator('[role="status"]').filter({ hasText: NOTICE })
  const noticeShown = await notice.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
  if (shots && noticeShown) await page.screenshot({ path: join(shots, '14-recording-storage-enter-your-access-keys-notice.png') }).catch(() => {})
  const afterNotice = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  const askedAgain = await page.evaluate(() => window.tw.recording.takeSetupNotice())
  record(15, noticeShown && !('recordingR2CredsSource' in afterNotice) && !('recordingR2BwsSecretId' in afterNotice) && afterNotice.vaultRoot === vault && askedAgain === null,
    `config keys now: ${Object.keys(afterNotice).join(', ')}`)
  if (noticeShown) await notice.getByRole('button', { name: 'Dismiss' }).click()

  // The Settings window (its own Page, replaced each time it is opened). `settings` is whatever window is open now.
  let sw = null
  const settings = new Proxy({}, { get: (_target, name) => { const value = sw[name]; return typeof value === 'function' ? value.bind(sw) : value } })
  const part = (name) => sw.locator(`[data-cloudflare="${name}"]`)
  const openSettings = async () => {
    sw = findSettingsWindow(app) ? await openSettingsWindow(app, page, 'cloudflare') : await openSettingsWindow(app, page, 'cloudflare')
    await part('connection').waitFor({ state: 'visible' })
    await part('connection').scrollIntoViewIfNeeded()
  }
  const closeSettings = async () => {
    await closeSettingsWindow(app)
    sw = null
  }
  /** Run something in the Settings window (its preload has the calls only it may make), opening it if it is closed. */
  const inSettings = async (fn, arg) => { if (!findSettingsWindow(app)) await openSettings(); sw = findSettingsWindow(app); return sw.evaluate(fn, arg) }
  const headerIs = (text) => sw.waitForFunction((wanted) => {
    const label = document.querySelector('[data-cloudflare="connection-label"]')?.textContent ?? ''
    return typeof wanted === 'string' ? label === wanted : new RegExp(wanted.pattern).test(label)
  }, text, { timeout: 40_000 })
  const settled = () => sw.waitForFunction(() => document.querySelector('[data-cloudflare="connection"]')?.getAttribute('data-busy') === 'no', null, { timeout: 40_000 })
  const buttons = async () => (await part('connection').locator('button').allInnerTexts()).map((text) => text.trim())
  const rowText = async () => (await part('publishing').innerText()).replace(/\s+/g, ' ').trim()
  const shot = async (name) => {
    if (!shots) return
    await part('connection').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {})
  }
  const config = () => JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  const pasteToken = async (token) => {
    await part('token').locator('input').fill(token)
    await part('token').getByRole('button', { name: 'Save token' }).click()
  }
  const publish = () => page.evaluate(({ path }) => window.tw.talk.publishHandout(path, ''), { path: outlinePath })

  // 1. Not connected.
  await openSettings()
  await headerIs('Not connected')
  await settings.getByRole('button', { name: 'How to make a token' }).click()
  const howTo = (await part('how-to').innerText()).replace(/\s+/g, ' ')
  const named = ['Publishing handouts: Account · Cloudflare Pages · Edit', 'Going live and sharing: Account · Workers Scripts · Edit', 'Share-link domain: Zone · Workers Routes · Edit', 'Recording storage:']
  record(1, await part('token').locator('input[type="password"]').count() === 1 && named.every((line) => howTo.includes(line))
    && (await rowText()) === NOTHING_TO_REPORT, named.filter((line) => !howTo.includes(line)).join('; '))
  await shot('1-not-connected-how-to-make-a-token')
  // 23. The new rule: these calls are the Settings window's own. The editor window is refused and nothing changes.
  const SETTINGS_ONLY = 'This can be changed only in the Settings window.'
  const fromEditor = await page.evaluate(async (token) => ({
    save: await window.tw.cloudflare.saveToken(token),
    choose: await window.tw.cloudflare.chooseAccount('acc-ada-0001'),
    disconnect: await window.tw.cloudflare.disconnect(),
    share: await window.tw.cloudflare.useShareDomain(),
    config: await window.tw.publish.setConfig({ accountId: 'acc-from-editor', project: 'from-editor', baseUrl: '', workerBaseUrl: '', useShortIds: false, shareDomain: '' }),
    saved: await window.tw.publish.getConfig(),
  }), TOKENS.full)
  const refusedFromEditor = fromEditor.save.ok === false && fromEditor.save.error === SETTINGS_ONLY && fromEditor.choose.ok === false && fromEditor.choose.error === SETTINGS_ONLY
    && fromEditor.disconnect.ok === false && fromEditor.disconnect.error === SETTINGS_ONLY && fromEditor.share.ok === false
    && fromEditor.config.success === false && fromEditor.config.error === SETTINGS_ONLY
    && fromEditor.saved.hasToken === false && fromEditor.saved.accountId === '' && fromEditor.saved.project === ''
    && !existsSync(join(userData, 'cf-pages-token.bin')) && !('cfAccountId' in config())
  // ...and the Settings window is allowed: the Cloudflare field is saved from there, then put back.
  const fromSettings = await inSettings(async () => {
    const before = await window.tw.publish.getConfig()
    const saved = await window.tw.publish.setConfig({ accountId: before.accountId, project: 'from-settings', baseUrl: before.baseUrl, workerBaseUrl: before.workerBaseUrl, useShortIds: before.useShortIds, shareDomain: '' })
    const after = await window.tw.publish.getConfig()
    await window.tw.publish.setConfig({ accountId: before.accountId, project: before.project, baseUrl: before.baseUrl, workerBaseUrl: before.workerBaseUrl, useShortIds: before.useShortIds, shareDomain: '' })
    return { saved, project: after.project }
  })
  record(23, refusedFromEditor && fromSettings.saved.success === true && fromSettings.project === 'from-settings',
    refusedFromEditor ? `editor window refused every call; Settings window saved ${fromSettings.project}` : `editor replies: ${JSON.stringify({ save: fromEditor.save.error, choose: fromEditor.choose.error, disconnect: fromEditor.disconnect.error, share: fromEditor.share.error, config: fromEditor.config })}`)
  await settings.getByRole('button', { name: 'How to make a token' }).click()

  // 2. Paste a token; Cloudflare is slow to answer; the editor is used meanwhile.
  let release
  api.model.delay = () => new Promise((open) => { release = open })
  await pasteToken(TOKENS.full)
  await headerIs('Checking…')
  await shot('2-checking')
  const whileChecking = { offered: await buttons(), fieldEmptied: await part('token').locator('input').count() === 0 || await part('token').locator('input').inputValue() === '' }
  await closeSettings()
  await openTalkByTitle(page, 'Cloudflare probe')
  await page.waitForSelector('.cm-content')
  await page.locator('.cm-content .cm-line', { hasText: 'A point' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' typed while checking')
  const typed = await page.evaluate(() => Array.from(document.querySelectorAll('.cm-content .cm-line')).map((line) => line.textContent).join('\n'))
  const started = Date.now()
  const during = await page.evaluate(async () => ({ status: await window.tw.cloudflare.status(), paths: Boolean(await window.tw.settings.getPaths()) }))
  record(2, typed.includes('A point typed while checking') && during.status.busy === true && during.status.connection.state === 'checking' && during.paths
    && Date.now() - started < 3000 && whileChecking.offered.length === 0 && whileChecking.fieldEmptied,
  `other calls answered in ${Date.now() - started} ms while the check waited`)

  // 3. Cloudflare answers.
  await openSettings()
  api.model.delay = null
  release()
  await headerIs('Connected · Ada Lovelace')
  await settled()
  record(3, JSON.stringify(await buttons()) === JSON.stringify(['Check again', 'Replace token', 'Disconnect']) && config().cfAccountId === ADA.id
    && await settings.locator('input[placeholder="Cloudflare account id"]').inputValue() === ADA.id, (await buttons()).join(' · '))

  // The rows as laid out: where the list, a row's name and a row's right-hand edge are.
  const layout = () => sw.evaluate(() => {
    const box = (element) => { const r = element.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } }
    const list = document.querySelector('[data-cloudflare="features"]')
    const style = getComputedStyle(list)
    const header = document.querySelector('[data-cloudflare="connection"]')
    const headerButtons = [...header.querySelectorAll('button')].map(box)
    return {
      list: box(list), border: `${style.borderTopWidth} ${style.borderTopStyle}`, radius: style.borderTopLeftRadius,
      rows: [...list.querySelectorAll('[role="listitem"]')].map((row) => {
        const name = row.firstElementChild.firstElementChild
        const edge = row.children.length > 1 ? row.lastElementChild : null
        return { row: box(row), name: box(name), nameText: name.textContent, details: row.firstElementChild.children.length - 1, edge: edge ? box(edge) : null, edgeText: edge ? edge.textContent : '', rule: getComputedStyle(row).borderTopWidth }
      }),
      header: box(header), headerButtonsRight: headerButtons.length ? Math.max(...headerButtons.map((button) => button.right)) : null,
      outside: [...document.querySelectorAll('[data-cloudflare="publishing"], [data-cloudflare="live-service"]')].filter((row) => !list.contains(row)).length,
    }
  })
  const laidOut = (seen, rows) => seen.border === '1px solid' && parseFloat(seen.radius) >= 4 && seen.outside === 0 && seen.rows.length === rows
    && seen.rows.every((row) => row.details === 1 && row.rule === '1px' && row.row.left >= seen.list.left && row.row.right <= seen.list.right
      && row.name.left - seen.list.left <= 16 && (row.edge === null || (seen.list.right - row.edge.right <= 16 && row.edge.left > row.name.left + 100)))
    && seen.headerButtonsRight !== null && seen.header.right - seen.headerButtonsRight <= 2

  // 4. No site yet → Create → Ready.
  const before = await rowText()
  const layoutNoSite = await layout()
  const create = part('publishing').getByRole('button', { name: 'Create talkweaver-handouts' })
  const offered = await create.count() === 1
  await shot('3-connected-no-site-yet')
  await create.click()
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="publishing"]')?.getAttribute('data-state') === 'ready')
  await settled()
  const layoutReady = await layout()
  record(4, before === 'Publishing handouts No site yet Create talkweaver-handouts' && layoutNoSite.rows[0].edgeText === 'Create talkweaver-handouts' && offered
    && (await rowText()) === 'Publishing handouts Site talkweaver-handouts · talkweaver-handouts.pages.dev Ready' && layoutReady.rows[0].edgeText === 'Ready'
    && config().cfPagesProject === 'talkweaver-handouts' && api.model.sites.get(ADA.id).has('talkweaver-handouts')
    && api.reached().filter((line) => line === `POST /accounts/${ADA.id}/pages/projects`).length === 1, `before: ${before} · after: ${await rowText()}`)
  await shot('4-connected-ready')
  // The Share-link domain row (ticket 06): "None" with no address; typing one in Settings asks again and the row turns Attached; cleared again for what follows.
  const withShareDomain = (shareDomain) => inSettings(async (domain) => {
    const saved = await window.tw.publish.getConfig()
    return window.tw.publish.setConfig({ ...saved, shareDomain: domain })
  }, shareDomain)
  await withShareDomain('drafts.handouts.example')
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="share-link"]')?.getAttribute('data-state') === 'attached')
  const attachedText = (await part('share-link').innerText()).replace(/\s+/g, ' ').trim()
  await shot('4b-share-link-attached')
  await withShareDomain('')
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="share-link"]')?.getAttribute('data-state') === 'none')
  // The Recording storage row (ticket 06), in the same list. Its keys are typed where a person types them.
  const recordingText = async () => (await part('recording-storage').innerText()).replace(/\s+/g, ' ').trim()
  const recordingIs = (state) => sw.waitForFunction((wanted) => {
    const row = document.querySelector('[data-cloudflare="recording-storage"]')
    return row?.getAttribute('data-state') === wanted && row.getAttribute('data-checking') === 'no'
  }, state)
  // The endpoint and bucket are a Settings-window-only change (main refuses the editor window).
  const withStorage = (endpoint, bucket) => inSettings(({ endpoint: at, bucket: named }) => window.tw.recording.setStorage({ endpoint: at, bucket: named, discardSeconds: 20 }), { endpoint, bucket })
  // The recording keys are typed where a person types them since 0.42: Accounts and keys, as id:secret (Add key… or Replace key…).
  const typeKeys = async (keys) => {
    await gotoSection(sw, 'accounts')
    const slot = sw.locator('[data-slot="accounts.recording"]')
    const open = slot.getByRole('button', { name: /^(Add key…|Replace key…)$/ })
    await open.click()
    await slot.locator('input[aria-label="Key for Recording storage keys"]').fill(`${keys.id}:${keys.secret}`)
    await slot.getByRole('button', { name: 'Add key' }).click()
    await slot.locator('input[type="password"]').waitFor({ state: 'detached' })
    await gotoSection(sw, 'cloudflare')
    await part('connection').waitFor({ state: 'visible' })
  }
  const pressCheck = () => part('recording-storage-check').click()
  const recordingSeen = []
  await recordingIs('not-set-up')
  recordingSeen.push(await recordingText())
  const noCheckYet = await part('recording-storage-check').count() === 0
  await shot('15-recording-storage-not-set-up')
  await withStorage(s3.endpoint, 'talks')
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="recording-storage-detail"]')?.textContent?.includes('your access keys'))
  recordingSeen.push(await recordingText())
  await typeKeys(S3_KEYS.good)
  await recordingIs('not-checked')
  const askedBeforeCheck = s3.requests.length
  recordingSeen.push(await recordingText())
  await shot('16-recording-storage-keys-saved-not-checked')
  await pressCheck()
  await recordingIs('ready')
  recordingSeen.push(await recordingText())
  await shot('17-recording-storage-ready')
  await withStorage(s3.endpoint, 'no-such-bucket')
  await recordingIs('not-checked')
  await pressCheck()
  await recordingIs('bucket-not-found')
  recordingSeen.push(await recordingText())
  await shot('18-recording-storage-bucket-not-found')
  await withStorage(s3.endpoint, 'talks')
  await typeKeys(S3_KEYS.unknown)
  await recordingIs('not-checked')
  await pressCheck()
  await recordingIs('keys-rejected')
  recordingSeen.push(await recordingText())
  await shot('19-recording-storage-keys-rejected')
  // The key form clears itself and closes on Save: no field of the window still holds a key.
  const keyFields = (await sw.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value).join(''))).includes('test-token') ? 'a key is still in a field' : ''
  const recordingWanted = [
    'Recording storage Recordings stay on this computer until storage is set up Not set up Set up recording storage',
    'Recording storage Enter your access keys to finish setting up Not set up Set up recording storage',
    'Recording storage Bucket talks Keys saved, not checked Check',
    'Recording storage Bucket talks · found. That the keys may upload is proven by the first upload. Ready Check',
    'Recording storage No bucket named no-such-bucket at this endpoint Bucket not found Check',
    'Recording storage The storage did not accept these access keys Keys rejected Check',
  ]
  const recordingConfig = config()
  record(16, JSON.stringify(recordingSeen) === JSON.stringify(recordingWanted) && noCheckYet && askedBeforeCheck === 0 && s3.requests.length === 3
    && s3.requests.every((request) => request.method === 'GET') && s3.unknown.length === 0 && keyFields === ''
    && existsSync(join(userData, 'recording-r2-creds.bin')) && !('recordingR2CredsSource' in recordingConfig) && !('recordingR2BwsSecretId' in recordingConfig),
    recordingSeen.filter((text, index) => text !== recordingWanted[index]).join(' | ') || `${s3.requests.length} requests to the stand-in, all lists`)
  const shareAttached = attachedText === 'Share-link domain drafts.handouts.example Attached' && !api.requests.some((request) => request.method !== 'GET' && request.path.startsWith('/zones'))
  await closeSettings()

  // 17. Before going live is set up: the row offers it, and a publish goes up without live features (D9: set up on purpose).
  const liveText = async () => (await part('live-service').innerText()).replace(/\s+/g, ' ').trim()
  const liveIs = (state) => sw.waitForFunction((wanted) => document.querySelector('[data-cloudflare="live-service"]')?.getAttribute('data-state') === wanted, state, { timeout: 60_000 })
  const workersWrites = () => api.requests.filter((request) => request.method !== 'GET' && request.path.includes('/workers/')).length
  const LIVE_UPLOAD = `PUT /accounts/${ADA.id}/workers/scripts/talkweaver-live-sessions`
  const liveUploads = () => api.reached().filter((line) => line === LIVE_UPLOAD).length
  // Each secrets request the app sent, as the fake API received it: the names it carries and the first
  // one's value (compared here, never printed). In the model decided after the review of several-Macs
  // ticket 02 (spec R1, R5, R6) a set-up sends ONE such request, naming this computer's own key
  // `ADMIN_SECRET_<id>` and nothing else; a code update sends none; no request names a signing secret.
  const keysGiven = () => api.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/secrets-bulk')).map((request) => {
    const secrets = JSON.parse(request.body.toString()).secrets
    const names = Object.keys(secrets)
    return { names, text: secrets[names[0]]?.text }
  })
  const oneOwnKeyEach = (given) => given.every(({ names, text }) => names.length === 1 && /^ADMIN_SECRET_[a-z0-9]{1,64}$/.test(names[0]) && typeof text === 'string' && text.length >= 40)
  const D7 = 'Published. Going live is not set up: Settings → Cloudflare'
  await openSettings()
  await liveIs('not-set-up')
  const offeredLive = await liveText()
  await shot('20-going-live-not-set-up')
  await closeSettings()
  const writesBefore = workersWrites()
  const early = await publish()
  record(17, offeredLive === 'Going live and sharing Polls, questions, reactions, the venue screen, Share for comments Set up going live' && early?.success === true
    && early.liveNotice === D7 && workersWrites() === writesBefore && !config().liveWorkerBaseUrl,
  `row: ${offeredLive} · ${early?.success ? `published; notice: ${early.liveNotice}` : `not published: ${String(early?.error).slice(0, 200)}`}`)

  // 5. Set up going live from Settings: Setting up… (the upload held a moment, to be seen), then Ready; then publish.
  await openSettings()
  let releaseUpload
  api.model.delay = (request) => (`${request.method} ${request.path}` === LIVE_UPLOAD ? new Promise((open) => { releaseUpload = open }) : null)
  await part('live-service-label').click()
  await liveIs('setting-up')
  const settingUp = await liveText()
  await shot('21-going-live-setting-up')
  api.model.delay = null
  releaseUpload()
  await liveIs('ready')
  const readyLive = await liveText()
  await settings.getByRole('button', { name: 'Details' }).click()
  const liveDetails = (await part('live-service-details').innerText()).trim()
  await shot('22-going-live-ready-details')
  await settings.getByRole('button', { name: 'Details' }).click()
  await closeSettings()
  const first = await publish()
  const upload = api.requests.find((request) => `${request.method} ${request.path}` === LIVE_UPLOAD)
  const liveAddress = `https://talkweaver-live-sessions.${WORKERS_SUBDOMAIN}.workers.dev`
  const BUILD = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(root, 'worker', 'recovery-protocol.ts'), 'utf8'))[1]
  record(5, settingUp === 'Going live and sharing Uploading the live service Setting up…' && readyLive === 'Going live and sharing Live sessions run on your Cloudflare account Ready'
    && liveDetails === `Going live: Live service build ${BUILD} at ${liveAddress}`
    && first?.success === true && first.liveNotice === undefined && upload?.authorization === `Bearer ${TOKENS.full}` && config().liveWorkerBaseUrl === liveAddress
    && config().liveWorkerVersion === BUILD && liveUploads() === 1 && api.reached().includes(`POST /accounts/${ADA.id}/pages/projects/talkweaver-handouts/deployments`),
  `${settingUp} → ${readyLive} · ${liveDetails} · ${first?.success ? 'published' : `not published: ${String(first?.error).slice(0, 200)}`}`)

  // 6. A token that can publish pages but not run the live service (what an install from before this screen has).
  await openSettings()
  await settings.getByRole('button', { name: 'Replace token' }).click()
  await pasteToken(TOKENS.pagesOnly)
  await liveIs('no-permission')
  await settled()
  const liveRow = (await part('live-service').innerText()).replace(/\s+/g, ' ').trim()
  const layoutTwoRows = await layout()
  record(6, (await part('connection-label').innerText()) === 'Connected · Ada Lovelace' && (await rowText()) === 'Publishing handouts Site talkweaver-handouts · talkweaver-handouts.pages.dev Ready'
    && liveRow === 'Going live and sharing Missing permission: Account · Workers Scripts · Edit The token cannot run the live service', liveRow)
  // 13. Bordered rows in one bounded list, in each of the three states seen so far (one row with an action, one with a state, the
  // going-live row added). The Recording storage row is one of them, in the same form: its state, then its Check, at the right-hand edge.
  record(13, laidOut(layoutNoSite, 4) && laidOut(layoutReady, 4) && laidOut(layoutTwoRows, 4)
    && layoutTwoRows.rows.map((row) => row.nameText).join(' | ') === 'Publishing handouts | Going live and sharing | Share-link domain | Recording storage'
    && layoutTwoRows.rows.map((row) => row.edgeText).join(' | ') === 'Ready | The token cannot run the live service | None | Keys rejectedCheck'
    && layoutNoSite.rows[1].edgeText === 'Set up going live' && shareAttached,
    JSON.stringify({ border: layoutTwoRows.border, radius: layoutTwoRows.radius, list: layoutTwoRows.list, rows: layoutTwoRows.rows.map((row) => ({ name: row.name.left, edge: row.edge?.right })), header: layoutTwoRows.header.right, buttons: layoutTwoRows.headerButtonsRight }))
  await shot('5-token-cannot-run-the-live-service')

  // 7. A share-link domain is set. That changes nothing about the deployed code: the recorded build
  // stays as it was (decision R3: an update depends on the build the live service answers as, not on
  // anything recorded here), no script is uploaded, and publishing goes on. The share-address action
  // sends only its own lookup, attach and removal requests (decisions R2 and R11).
  const isScriptUpload = (line) => /^PUT \S+\/workers\/scripts\/[a-z0-9_-]+$/.test(line)
  const uploadsBefore = api.reached().filter(isScriptUpload).length
  const shareChangedAt = api.requests.length
  const marked = await inSettings(async () => {
    const current = await window.tw.publish.getConfig()
    return window.tw.publish.setConfig({ accountId: current.accountId, project: current.project, baseUrl: current.baseUrl, workerBaseUrl: current.workerBaseUrl, useShortIds: current.useShortIds, shareDomain: 'drafts.example.test' })
  })
  await closeSettings()
  const versionKept = config().liveWorkerVersion === BUILD
  const requestsBefore = api.requests.length
  const second = await publish()
  const uploadsAfter = api.reached().filter(isScriptUpload).length
  // Not even tried: the publishing tool asks nothing about the live service (its first question is the service's own address).
  // (The share-address action's own requests, which may still be on their way, are not the publishing tool's.)
  const askedOfLive = api.reached().slice(requestsBefore).filter((line) => line.includes('/workers/') && !line.includes('/domains'))
  const pagesAgain = api.reached().slice(requestsBefore).includes(`POST /accounts/${ADA.id}/pages/projects/talkweaver-handouts/deployments`)
  record(7, marked.success && versionKept && second?.success === true && pagesAgain && uploadsAfter === uploadsBefore && askedOfLive.length === 0 && config().liveWorkerBaseUrl === liveAddress,
    second?.success ? `published; live service uploads ${uploadsBefore} → ${uploadsAfter}; asked about the live service: ${askedOfLive.length}` : `not published: ${String(second?.error).slice(0, 200)}`)

  // 8. Rejected.
  await openSettings()
  await settings.getByRole('button', { name: 'Replace token' }).click()
  await pasteToken(TOKENS.unknown)
  await headerIs('Cloudflare did not accept this token')
  await settled()
  record(8, JSON.stringify(await buttons()) === JSON.stringify(['Replace token']) && (await rowText()) === NOTHING_TO_REPORT, (await buttons()).join(' · '))
  await shot('6-token-rejected')

  // 9. Could not check: connected first, then Cloudflare stops answering.
  await settings.getByRole('button', { name: 'Replace token' }).click()
  await pasteToken(TOKENS.full)
  await headerIs('Connected · Ada Lovelace')
  await settled()
  api.model.hang = () => true
  await settings.getByRole('button', { name: 'Check again' }).click()
  await headerIs({ pattern: '^Could not check \\(offline\\?\\) · last checked \\d\\d:\\d\\d$' })
  await settled()
  api.model.hang = null
  const greyed = await part('publishing').evaluate((row) => ({ stale: row.getAttribute('data-stale'), state: row.getAttribute('data-state'), opacity: getComputedStyle(row).opacity }))
  record(9, JSON.stringify(await buttons()) === JSON.stringify(['Check again']) && greyed.stale === 'yes' && greyed.state === 'ready' && Number(greyed.opacity) < 1, JSON.stringify(greyed))
  await shot('7-could-not-check')

  // Connected with the full token again.
  await settings.getByRole('button', { name: 'Check again' }).click()
  await headerIs('Connected · Ada Lovelace')
  await settled()

  // 18. Step 7 changed the share-link address. That marks nothing out of date: the recorded build is
  // still there, the next publish uploads no code, sends no secret and says nothing about an update;
  // and since step 7 the only writes about the Worker are the share-address action's own (the attach
  // of that one hostname, and removals of hostnames this computer listed). No script upload.
  const versionStillRecorded = config().liveWorkerVersion === BUILD
  await closeSettings()
  await page.evaluate(() => { window.__liveNotices = []; window.tw.liveService.onNotice((message) => window.__liveNotices.push(message)) })
  const uploadsBefore18 = liveUploads()
  const keysBefore18 = keysGiven().length
  const updated = await publish()
  const afterUpdate = liveUploads()
  const again18 = await publish()
  const notices = await page.evaluate(() => window.__liveNotices)
  const keys18 = keysGiven()
  const workerWritesSinceShareChange = api.reached().slice(shareChangedAt).filter((line) => !line.startsWith('GET ') && line.includes('/workers/'))
  const onlyShareAddressWrites = workerWritesSinceShareChange.every((line) => /^PUT \S+\/workers\/scripts\/[a-z0-9_-]+\/domains\/records$/.test(line) || /^DELETE \S+\/workers\/domains\/[0-9a-f]{32}$/.test(line))
  record(18, versionStillRecorded && updated?.success === true && updated.liveNotice === undefined && afterUpdate === uploadsBefore18 && again18?.success === true && liveUploads() === uploadsBefore18
    && keys18.length === keysBefore18 && oneOwnKeyEach(keys18) && notices.length === 0 && onlyShareAddressWrites && !workerWritesSinceShareChange.some(isScriptUpload) && config().liveWorkerVersion === BUILD,
  `uploads ${uploadsBefore18} → ${afterUpdate} → ${liveUploads()} (none expected); secrets requests ${keysBefore18} → ${keys18.length}; told: ${JSON.stringify(notices)}; writes about the Worker since the share address changed: ${JSON.stringify(workerWritesSinceShareChange)}; ${updated?.success ? 'published' : String(updated?.error).slice(0, 160)}`)

  // 19. The keys gone from this computer (the slot removed) with the service deployed: the stop.
  rmSync(join(userData, 'live-worker-credentials.bin'))
  await openSettings()
  await settings.getByRole('button', { name: 'Check again' }).click()
  await settled()
  await liveIs('set-up-elsewhere') // no key here and a service recorded: "Set up on another computer", with its button; nothing is offered to reset
  const lostText = await liveText()
  await shot('23-going-live-set-up-elsewhere')
  await closeSettings()
  const writesBefore19 = workersWrites()
  const withoutKeys = await publish()
  // Nothing was sent for it: the one secrets request is still the first set-up's.
  record(19, lostText.includes('Set up on another computer') && lostText.includes('Set up going live on this computer') && !/reset|delete/i.test(lostText) && withoutKeys?.success === true
    && withoutKeys.liveNotice === D7 && workersWrites() === writesBefore19 && keysGiven().length === 1,
  `${lostText} · ${withoutKeys?.liveNotice ?? withoutKeys?.error}`)

  // 20. The reset, done on purpose: the Worker deleted in Cloudflare's dashboard, then Check again; then set up again.
  api.model.workers.get(ADA.id).delete('talkweaver-live-sessions')
  await openSettings()
  await settings.getByRole('button', { name: 'Check again' }).click()
  await settled()
  await liveIs('not-set-up')
  const goneText = await liveText()
  const forgotten = config().liveWorkerBaseUrl === undefined
  await shot('24-going-live-not-found')
  await part('live-service-label').click()
  await liveIs('ready')
  // The slot was removed in step 19, so this set-up makes a new key under a new id (R5) and sends it in
  // one request of its own: two secrets requests in the whole journey, each naming one own key, the
  // two differing in id and in value; and no request of the journey names a signing secret (R1).
  const keys20 = keysGiven()
  record(20, goneText === 'Going live and sharing The live service was not found at Cloudflare: it may have been deleted there Set up going live' && forgotten
    && keys20.length === 2 && oneOwnKeyEach(keys20) && keys20[1].names[0] !== keys20[0].names[0] && keys20[1].text !== keys20[0].text && api.namingSigningSecret().length === 0
    && existsSync(join(userData, 'live-worker-credentials.bin')) && config().liveWorkerBaseUrl === liveAddress,
  `${goneText} · secrets requests ${keys20.length}, each naming one own key: ${oneOwnKeyEach(keys20)}; requests naming a signing secret: ${api.namingSigningSecret().length}`)

  // 21. A custom domain on the site (a site with its own web address): the handout address on the row, and share.<it> suggested.
  const shareText = async () => (await part('share-link').innerText()).replace(/\s+/g, ' ').trim()
  const shareIs = (state) => sw.waitForFunction((wanted) => document.querySelector('[data-cloudflare="share-link"]')?.getAttribute('data-state') === wanted, state, { timeout: 30_000 })
    .catch(async (error) => { throw new Error(`share-link row not ${state}: it is ${await part('share-link').getAttribute('data-state').catch(() => 'gone')} (${await shareText().catch(() => '')}); header ${await part('connection-label').innerText().catch(() => '')}; ${error.message}`) })
  const SHARE = 'share.handouts.example'
  const attachesOf = () => api.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/domains/records') && String(request.body ?? '').includes(SHARE)).length
  await withShareDomain('')
  api.model.sites.get(ADA.id).get('talkweaver-handouts').domains = [{ id: 'domain-one', name: 'handouts.example', status: 'active' }]
  await settings.getByRole('button', { name: 'Check again' }).click()
  await settled()
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="share-link-label"]')?.tagName === 'BUTTON')
  const addressRow = await rowText()
  const addressLink = await part('publishing-address').getAttribute('href')
  const suggestedRow = await shareText()
  const placeholder = await settings.locator('[data-cloudflare="share-domain-field"]').getAttribute('placeholder')
  const attachesBefore = attachesOf()
  await shot('25-share-link-suggested')
  await settings.locator('[data-cloudflare="share-link-label"]').click()
  await shareIs('attached')
  await settled()
  const usedRow = await shareText()
  await shot('26-share-link-used-attached')
  record(21, addressRow === 'Publishing handouts Site talkweaver-handouts · handouts.example Ready' && addressLink === 'https://handouts.example/'
    && suggestedRow === `Share-link domain Share for comments links can use ${SHARE}, on your handout domain handouts.example. The token needs the permission Zone · Workers Routes · Edit Use ${SHARE}`
    && placeholder === SHARE && attachesBefore === 0 && attachesOf() === 1 && usedRow === `Share-link domain ${SHARE} Attached`
    && config().sharedTalkLinkBase === `https://${SHARE}` && config().liveWorkerBaseUrl === liveAddress && config().liveWorkerVersion === BUILD,
  `${addressRow} · ${suggestedRow} · placeholder ${placeholder} · attaches ${attachesBefore} → ${attachesOf()} · ${usedRow}`)

  // 22. The same press with a token that may not touch the zone's Workers routes.
  await withShareDomain('')
  await shareIs('none')
  api.model.tokens.get(TOKENS.full).routes = false
  // As on an account where it was never attached (step 21 left it attached at the fake Cloudflare).
  api.model.workerDomains.set(ADA.id, (api.model.workerDomains.get(ADA.id) ?? []).filter((domain) => domain.hostname !== SHARE))
  await settings.getByRole('button', { name: 'Check again' }).click()
  await settled()
  await sw.waitForFunction(() => document.querySelector('[data-cloudflare="share-link-label"]')?.tagName === 'BUTTON')
  const attachesBefore22 = attachesOf()
  await settings.locator('[data-cloudflare="share-link-label"]').click()
  await shareIs('no-permission')
  await settled()
  const refusedRow = await shareText()
  await shot('27-share-link-token-cannot-attach')
  record(22, refusedRow === 'Share-link domain Add the permission Zone · Workers Routes · Edit to your Cloudflare token, then press Check again The token cannot attach a domain'
    && attachesOf() === attachesBefore22 && config().sharedTalkLinkBase === `https://${SHARE}`, `${refusedRow} · attaches ${attachesBefore22} → ${attachesOf()}`)
  api.model.tokens.get(TOKENS.full).routes = true
  api.model.sites.get(ADA.id).get('talkweaver-handouts').domains = []

  // 10. Several accounts.
  await settings.getByRole('button', { name: 'Replace token' }).click()
  await pasteToken(TOKENS.both)
  // Settings already names Ada's account, which this token lists: it is used without asking again.
  await headerIs('Connected · Ada Lovelace')
  await settled()
  // With no account named, the same token asks.
  await inSettings(async () => {
    const current = await window.tw.publish.getConfig()
    await window.tw.publish.setConfig({ accountId: '', project: current.project, baseUrl: current.baseUrl, workerBaseUrl: current.workerBaseUrl, useShortIds: current.useShortIds, shareDomain: '' })
  })
  await headerIs('Choose an account')
  await settled()
  const options = await part('account-picker').locator('option').allInnerTexts()
  await shot('8-choose-an-account')
  await part('account-picker').locator('select').selectOption(GRACE.id)
  await part('account-picker').getByRole('button', { name: 'Use this account' }).click()
  await headerIs('Connected · Grace Hopper')
  await settled()
  record(10, JSON.stringify(options) === JSON.stringify(['Ada Lovelace', 'Grace Hopper']) && config().cfAccountId === GRACE.id, options.join(' · '))

  // 11. Disconnect.
  await settings.getByRole('button', { name: 'Disconnect' }).click()
  await headerIs('Not connected')
  await settled()
  const rawChanges = await inSettings(async () => (await window.bridleSettings.view()).state.changes)
  // The change log keeps the token's presence only: accounts.cloudflare missing→connected, connected→missing.
  const changes = rawChanges.filter((entry) => entry.key === 'accounts.cloudflare').map((entry) => `${entry.from}→${entry.to}`)
  // 14. A row with nothing to report shows no dash (the row is unknown again once disconnected), and no dash followed "No site yet".
  const emptyRow = await rowText()
  const emptyLayout = await layout()
  const settingsText = (await settings.innerText()).replace(/\s+/g, ' ')
  record(14, emptyRow === NOTHING_TO_REPORT && emptyLayout.rows[0].edge === null && !/[—–]/.test(emptyRow) && !/[—–]/.test(before)
    && !settingsText.includes('Leave empty to deploy with your token') && !settingsText.includes('local Wrangler') && settingsText.includes('Live Worker URL'), `the row with nothing to report: "${emptyRow}"`)
  record(11, !existsSync(join(userData, 'cf-pages-token.bin')) && await part('token').locator('input').count() === 1 && changes.includes('connected→missing') && changes.includes('missing→connected')
    && config().cfAccountId === GRACE.id, `changelog (presence only): ${changes.join(', ')}`)
  await shot('9-disconnected')

  // 12. Nothing secret anywhere it could be read.
  const windowText = `${await page.evaluate(() => document.documentElement.outerHTML)}\n${await inSettings(() => document.documentElement.outerHTML)}`
  await app.close()
  app = null
  // The recording keys are searched for with the tokens: typed into Settings, kept only encrypted.
  // The live service's keys, as the fake API received them: in no window, output or plain file either.
  const tokens = [...SECRET_VALUES, ...api.requests.filter((request) => request.method === 'PATCH' && request.path.endsWith('/secrets-bulk'))
    .flatMap((request) => Object.values(JSON.parse(request.body.toString()).secrets).map((secret) => secret.text))]
  const inWindow = [...tokens, REPLY_TEXT_MARK, S3_REPLY_TEXT_MARK].filter((value) => windowText.includes(value)).length
  const inOutput = [...tokens, REPLY_TEXT_MARK, S3_REPLY_TEXT_MARK].filter((value) => output.includes(value)).length
  const inFiles = [...findIn(userData, tokens).map((path) => `userData/${path}`), ...findIn(vault, tokens).map((path) => `vault/${path}`)]
  record(12, inWindow === 0 && inOutput === 0 && inFiles.length === 0 && api.requests.some((request) => request.authorization === `Bearer ${TOKENS.full}`),
    inFiles.length ? `found in: ${inFiles.join(', ')}` : `${windowText.length} characters of the window and ${output.length} of output searched`)

  exitCode = ledger.summary('CLOUDFLARE SETTINGS').exitCode
} catch (error) {
  let text = String(error?.stack ?? error)
  for (const value of SECRET_VALUES) text = text.split(value).join('[made-up token]')
  console.log(`FAIL  the journey could not run: ${text}`)
  try { ledger.summary('CLOUDFLARE SETTINGS') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  await shutdownApp(app)
  await api?.close()
  await s3?.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
