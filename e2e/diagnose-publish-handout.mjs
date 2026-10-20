// Publishing a handout in the real app (spec docs/plans/cloudflare-setup-in-app, D7, D8, D12 and the
// "not ready" table; ticket 04): a throwaway user-data folder and vault, made-up tokens and the fake
// Cloudflare API on this computer's loopback address (the app is pointed at it by the test-only
// override, which a packaged build ignores). The bundled publishing tool really runs `pages deploy`
// and the live service's `deploy` against that fake. Nothing here contacts Cloudflare, the
// installed app or its data, and nothing is opened outside the app (the calls that would open a
// browser or a folder are replaced and counted).
//
// The journey: not connected → the sheet → "Save as a file instead" → "Open Settings" → connect with
// a token that cannot run the live service → the handout and a Run's handout publish WITHOUT live
// features, saying so → the live service's set-up fails → still published → the live service ready
// → pages carry its address → a token that can read the site but not publish → the row turns to
// "The token cannot publish pages" and stays so through "Check again" until a publish goes up.
// After every publish, every file of the site folder is read for an address on this computer.
//
// (This file used to drive a stub publisher script through `handoutPublisherPath`, a setting the
// app no longer has; it had been failing since. It is rewritten for the publish path that exists.)
//
// TW_SHOTS_DIR=<dir> saves pictures of the sheet, the "published without live features" notice and
// the row after a refused publish.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { PRE_WORK, POST_WORK } from '../scripts/lib/work-page-fixture.mjs'
import { REPLY_TEXT_MARK, WORKERS_SUBDOMAIN, startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'
import { APP_CONFIG_MARK, appWrittenLoopback } from '../src/main/handout-publishing.ts'
import { PUBLISH_REFUSED } from '../src/main/publishing-logic.ts'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-publish-handout-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'publish-probe'
const talkDir = join(vault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
const site = join(userData, 'cloudflare-pages-site')
mkdirSync(userData, { recursive: true })
mkdirSync(talkDir, { recursive: true })
mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
// A diagram, so that the pages carry the handout's own bundled code (which holds the word "localhost").
// And a slide about a local server: the author's own words, link and code, which are the author's to publish.
const AUTHOR = ['http://localhost:3000', 'http://localhost:3000/admin', '127.0.0.1:8787']
const outline = ['---', 'title: Publish probe', 'outline_version: 2', '---', '', '### One', '{id=one}', '', '- Kestrelwing point', '- Open http://localhost:3000 or [the admin page](http://localhost:3000/admin); the API listens on 127.0.0.1:8787', '', '### Code', '{id=code}', '', '```js', 'const LIVE_CONFIG = {"workerBaseUrl":"http://localhost:8787"};', '```', '', '### Diagram', '{id=two}', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n')
writeFileSync(outlinePath, outline)
writeFileSync(join(vault, '_PRESENTATIONS', slug, 'run-probe.json'), JSON.stringify({
  id: 'run-probe', talkSlug: slug, talkTitle: 'Publish probe', kind: 'delivery', status: 'delivered', eventTitle: 'Probe event',
  slideSet: { kind: 'full' }, startedAt: '2026-10-01T09:00:00.000Z', endedAt: '2026-10-01T10:00:00.000Z',
}))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
// A second talk that names a pre-work and a post-work file (work-files ticket 23): its Publish says they go out with a Run.
const workSlug = 'work-probe'
mkdirSync(join(vault, workSlug), { recursive: true })
mkdirSync(join(vault, 'Work files'), { recursive: true })
writeFileSync(join(vault, 'Work files', 'research-teams-intake.md'), PRE_WORK)
writeFileSync(join(vault, 'Work files', 'after-the-session.md'), POST_WORK)
writeFileSync(join(vault, workSlug, `${workSlug}-outline.md`), ['---', 'title: Work probe', 'outline_version: 2', 'prework: research-teams-intake', 'postwork: after-the-session', '---', '', '### One', '{id=one}', '', '- Kestrelwing point', ''].join('\n'))
const shots = process.env.TW_SHOTS_DIR ? resolve(process.env.TW_SHOTS_DIR) : null
if (shots) mkdirSync(shots, { recursive: true })

// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'publish', 'handout', name, '0123456789abcdef'].join('-')
const TOKENS = { pagesOnly: fake('pagesonly'), full: fake('full'), readOnly: fake('readonly') }
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const SITE = 'talkweaver-handouts'
const LIVE = `https://talkweaver-live-sessions.${WORKERS_SUBDOMAIN}.workers.dev`
const D7 = 'Published. Going live is not set up: Settings → Cloudflare'

const CHECKS = [
  'the app started on the throwaway folder, pointed at the fake API, and nothing can be opened outside it',
  'not connected: Publish shows the sheet "Publishing needs a Cloudflare account" with Open Settings and "Save as a file instead"; nothing is built or sent',
  '"Save as a file instead" produces the handout on this computer, with no address on this computer in it',
  '"Open Settings" on the sheet opens Settings at the Cloudflare section',
  'the live service absent (the token cannot run it): the handout publishes, and the notice says "Published. Going live is not set up: Settings → Cloudflare" with the reason',
  'a Run handout publishes the same way: without live features, saying so',
  'the live service\'s set-up (Set up going live, in Settings) fails: the handout still publishes; the message is sorted and what the tool printed is only behind Details, without the token',
  'the live service ready (Try again, in Settings): the talk\'s and the Run\'s published pages carry its address, and there is no notice',
  'gate: after every publish, no file this app published holds an address on this computer in a position TalkWeaver writes',
  'a token that can read the site but not publish: the publish fails with its sorted sentence, Details holds the raw text and no token',
  'the Publishing handouts row turns to "The token cannot publish pages" with the permission named, and "Check again" does not turn it back to Ready',
  'once a publish goes up the row is Ready again',
  'not connected again: Publish Run handout and Unpublish answer with what is missing, and the Run keeps its link',
  'no token in the window, the app\'s output or any file',
  'a slide about a local server (its text, its link, its code with localhost and 127.0.0.1) publishes, and is in the published pages as written',
  'a page an earlier version left with the dead live address does not stop a publish and is not rewritten; the result says "1 earlier handout…" with its name behind Details',
  'every toast action button (Copy link, Open Settings, Details; success, warning, error) has a label that can be read: a name, and a colour that stands out from its fill and from the toast',
  'a talk that names a pre-work and a post-work file: Publish first says "Pre-work and post-work are not included…" with their titles and Plan a run; Cancel sends nothing; Publish carries on; Plan a run opens the plan sheet',
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

function filesBelow(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)]))
}
function findIn(dir, values) {
  const needles = values.flatMap((value) => [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le')])
  return filesBelow(dir).filter((path) => needles.some((needle) => readFileSync(path).includes(needle))).map((path) => relative(dir, path))
}
/**
 * The gate: EVERY file of the site folder, read for an address only this computer can open in a
 * position TalkWeaver writes. The one page planted as an earlier version's is the only one allowed.
 */
const EARLIER = 'old-talk/index.html'
const EARLIER_PAGE = '<!doctype html><title>Old talk</title><script>\n  const LIVE_CONFIG = {"workerBaseUrl":"http://127.0.0.1:8787","talkSlug":"old-talk"};\n</script>'
const gateRuns = []
function gate(label) {
  const files = filesBelow(site)
  const dirty = files.map((path) => relative(site, path).split('\\').join('/')).filter((file) => file !== EARLIER && appWrittenLoopback(file, readFileSync(join(site, file), 'latin1')) !== null)
  gateRuns.push({ label, files: files.length, dirty })
  return dirty
}
/** Every toast action button now on screen: its label, tone, and whether the label can be read. */
const toastButtons = (page) => page.evaluate(() => {
  const rgb = (text) => (text.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number)
  const light = ([r, g, b]) => { const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const contrast = (a, b) => { const [hi, lo] = [light(a), light(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  return [...document.querySelectorAll('[data-toast-action]')].map((button) => {
    const style = getComputedStyle(button)
    const toast = getComputedStyle(button.parentElement)
    const fill = rgb(style.backgroundColor)
    return {
      label: button.textContent.trim(), tone: button.getAttribute('data-toast-action'), colour: style.color, fill: style.backgroundColor,
      opaque: fill.length < 4 || fill[3] > 0.9, onFill: contrast(rgb(style.color), fill), onToast: contrast(fill, rgb(toast.backgroundColor)),
    }
  })
})
const readable = (button) => button.label.length > 0 && button.opaque && button.colour !== button.fill && button.onFill >= 4.5 && button.onToast >= 3
const seenButtons = []
const pageOf = (folder, file = 'index.html') => readFileSync(join(site, folder, file), 'utf8')
// The live address a page carries is on the one configuration line the compiler marks as its own.
const carriesLive = (html) => html.includes(`const LIVE_CONFIG = {"workerBaseUrl":"${LIVE}","talkSlug":`) && html.includes(`}; ${APP_CONFIG_MARK}`)
const carriesNoLive = (html) => html.includes(`const LIVE_CONFIG = null; ${APP_CONFIG_MARK}`) && !html.includes(LIVE)

let app
let api
let output = ''
let exitCode = 1
try {
  await ensureFreshBuild(root)
  api = await startCloudflareApiStub({
    sites: [], accounts: [ADA], accountSites: { [ADA.id]: [SITE] },
    tokens: {
      [TOKENS.pagesOnly]: { accounts: [ADA.id], workers: false },
      [TOKENS.full]: { accounts: [ADA.id] },
      [TOKENS.readOnly]: { accounts: [ADA.id], pages: 'read', workers: false },
    },
  })
  // Only what the app needs from this shell: no credential of the person running the test goes in.
  // No TW_LIVE_LOCAL: a live service on this computer is not allowed here, as in an installed app.
  const env = { TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env })
  app.process().stdout.on('data', (chunk) => { output += chunk })
  app.process().stderr.on('data', (chunk) => { output += chunk })
  // Nothing leaves the app: a published link is not opened in a browser, a saved file's folder is
  // not shown. The calls are counted instead. Done before anything is pressed.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = { external: [], folders: [] }
    shell.openExternal = async (url) => { globalThis.__opened.external.push(String(url)) }
    shell.showItemInFolder = (path) => { globalThis.__opened.folders.push(String(path)) }
    shell.openPath = async () => ''
  })
  const opened = () => app.evaluate(() => globalThis.__opened)
  const replaced = await app.evaluate(({ shell }) => shell.openExternal.toString().includes('__opened') && shell.showItemInFolder.toString().includes('__opened'))
  if (!replaced) throw new Error('the calls that open a browser or a folder could not be replaced: stopping before anything is pressed')
  // Out of the way of whoever is at this computer. TW_E2E_SHOW=1 leaves the window visible.
  if (process.env.TW_E2E_SHOW !== '1') {
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
      BrowserWindow.getAllWindows().forEach(hide)
      electronApp.on('browser-window-created', (_event, win) => hide(win))
    })
  }
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const where = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const onThrowaway = realpathSync(where) === realpathSync(userData)
  record(0, onThrowaway && replaced)
  if (!onThrowaway) throw new Error('not on the throwaway user-data folder: stopping before any token is saved')
  await openTalkByTitle(page, 'Publish probe')

  const SETTINGS = '[aria-label="Settings"]'
  const settings = page.locator(SETTINGS).first()
  const part = (name) => settings.locator(`[data-cloudflare="${name}"]`)
  const sheet = page.locator('[data-testid="publish-not-ready"]')
  const toasts = page.locator('[role="status"]')
  const settled = () => page.waitForFunction(() => document.querySelector('[data-cloudflare="connection"]')?.getAttribute('data-busy') === 'no', null, { timeout: 40_000 })
  const rowText = async () => (await part('publishing').innerText()).replace(/\s+/g, ' ').trim()
  const shot = async (name, target = page) => { if (shots) await target.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {}) }
  const closeSettings = async () => { await page.keyboard.press('Escape'); await page.locator(SETTINGS).waitFor({ state: 'detached' }) }
  const openSettings = async () => {
    if (await page.locator(SETTINGS).count() === 0) await page.keyboard.press('ControlOrMeta+,')
    await part('connection').waitFor({ state: 'visible' })
    await part('connection').scrollIntoViewIfNeeded()
  }
  /** Save (or replace) the token through Settings, as a person does, and wait for the check. */
  const useToken = async (token) => {
    await openSettings()
    const replace = settings.getByRole('button', { name: 'Replace token' })
    if (await replace.count()) await replace.click()
    await part('token').locator('input').fill(token)
    await part('token').getByRole('button', { name: 'Save token' }).click()
    await page.waitForFunction(() => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === 'Connected · Ada Lovelace', null, { timeout: 40_000 })
    await settled()
  }
  /** Publish as the toolbar, the menu and the palette do: the app's own command, handled by the window. */
  // (Sent to the editor window itself: the app also keeps hidden windows that draw slide pictures.)
  const pressPublish = async () => {
    const sent = await app.evaluate(({ BrowserWindow }, url) => {
      const editor = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL() === url)
      editor?.webContents.send('app:command', 'publish-handout')
      return Boolean(editor)
    }, page.url())
    if (!sent) throw new Error('the editor window was not found to send Publish to')
  }
  const publish = () => page.evaluate(({ path }) => window.tw.talk.publishHandout(path, ''), { path: outlinePath })
  const publishRun = () => page.evaluate(({ talk }) => window.tw.history.publishRunHandout(talk, 'run-probe'), { talk: slug })
  const unpublishRun = () => page.evaluate(({ talk }) => window.tw.history.unpublishRunHandout(talk, 'run-probe'), { talk: slug })
  const runRecord = () => JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', slug, 'run-probe.json'), 'utf8'))
  const deployments = () => api.reached().filter((line) => line === `POST /accounts/${ADA.id}/pages/projects/${SITE}/deployments`).length

  // 1. Not connected: the sheet.
  await pressPublish()
  await sheet.waitFor({ state: 'visible', timeout: 20_000 })
  const sheetText = (await sheet.innerText()).replace(/\s+/g, ' ').trim()
  const sheetButtons = (await sheet.locator('button').allInnerTexts()).map((text) => text.trim())
  await page.waitForTimeout(500) // the sheet fades in
  await shot('10-publish-not-connected-sheet')
  record(1, (await sheet.locator('h2').innerText()) === 'Publishing needs a Cloudflare account' && (await sheet.getAttribute('data-kind')) === 'not-connected'
    && JSON.stringify(sheetButtons) === JSON.stringify(['Save as a file instead', 'Cancel', 'Open Settings'])
    && api.requests.length === 0 && !existsSync(site) && !readFileSync(outlinePath, 'utf8').includes('handout_url'), sheetText)

  // 2. Save as a file instead.
  await sheet.getByRole('button', { name: 'Save as a file instead' }).click()
  const saved = join(talkDir, 'dist', `${slug}-handout.html`)
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes('Handout exported')), null, { timeout: 60_000 })
  const savedHtml = existsSync(saved) ? readFileSync(saved, 'utf8') : ''
  const shown = await opened()
  record(2, savedHtml.includes('Kestrelwing point') && appWrittenLoopback(`${slug}-handout.html`, savedHtml) === null && carriesNoLive(savedHtml) && await sheet.count() === 0
    && shown.folders.length === 1 && shown.external.length === 0 && api.requests.length === 0 && !existsSync(site),
    savedHtml ? `${savedHtml.length} characters saved; the folder would have been shown once` : 'no file was saved')

  // An earlier version published a talk with the dead live address: its page is still in the site folder.
  mkdirSync(join(site, 'old-talk'), { recursive: true })
  writeFileSync(join(site, EARLIER), EARLIER_PAGE)

  // 3. Open Settings from the sheet.
  await pressPublish()
  await sheet.waitFor({ state: 'visible', timeout: 20_000 })
  await sheet.getByRole('button', { name: 'Open Settings' }).click()
  await part('connection').waitFor({ state: 'visible', timeout: 20_000 })
  // The section is scrolled to the top once Settings has been laid out: waited for, not timed.
  const inView = await page.waitForFunction(() => {
    const section = document.querySelector('[data-cloudflare="section"]')
    const panel = section?.closest('[aria-label="Settings"]')
    if (!section || !panel) return false
    const head = section.getBoundingClientRect()
    const body = panel.getBoundingClientRect()
    return head.top >= body.top && head.bottom <= body.bottom
  }, null, { timeout: 10_000 }).then(() => true, () => false)
  record(3, inView && await sheet.count() === 0 && (await part('connection-label').innerText()) === 'Not connected')

  // 4. A token that can publish pages and cannot run the live service: published without live features.
  await useToken(TOKENS.pagesOnly)
  const readyRow = await rowText()
  await closeSettings()
  await pressPublish()
  // Either the notice, or a failure (which the check below then reports in the app's own words).
  await page.waitForFunction((sentence) => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes(sentence) || node.textContent.includes('Publish failed')), D7, { timeout: 240_000 })
  const notice = (await toasts.innerText()).replace(/\s+/g, ' ')
  seenButtons.push(...await toastButtons(page))
  await shot('11-published-without-live-features')
  const afterFirst = gate('talk, live service absent')
  const first = { home: pageOf(slug), handout: pageOf(slug, `${slug}.html`), download: pageOf(slug, `${slug}-download.html`), venue: pageOf(`${slug}/p`) }
  const link = `https://${SITE}.pages.dev/${slug}/`
  record(4, readyRow.endsWith('Ready') && notice.includes(`${D7}. The token cannot run the live service. Add the permission Account · Workers Scripts · Edit to the token in Settings → Cloudflare.`)
    && notice.includes(`Published: ${link}`) && deployments() === 1 && Object.values(first).every(carriesNoLive) && first.handout.includes('Kestrelwing point')
    && readFileSync(outlinePath, 'utf8').includes(`handout_url: ${link}`) && JSON.stringify((await opened()).external) === JSON.stringify([link])
    && !api.reached().some((line) => line.startsWith('PUT ') && line.includes('/workers/scripts/')), notice.slice(0, 300))

  // 14. The author's slide about a local server is in the published pages, as written.
  record(14, AUTHOR.every((text) => first.handout.includes(text) && first.download.includes(text)) && first.handout.includes('href="http://localhost:3000/admin"')
    && appWrittenLoopback(`${slug}/${slug}.html`, first.handout) === null && carriesNoLive(first.handout),
    `in the handout: ${AUTHOR.filter((text) => first.handout.includes(text)).join(' · ')}`)
  // 15. The earlier version's page: not a reason to stop, not rewritten, counted in the result.
  const earlierSentence = '1 earlier handout on this site still carries an address on this computer, so its live features cannot work. Publish it again.'
  const earlierToast = page.locator('[role="status"] > div', { hasText: earlierSentence })
  const earlierShown = await earlierToast.count() === 1
  if (earlierShown) await earlierToast.getByRole('button', { name: 'Details' }).click()
  await page.waitForTimeout(200)
  const earlierDetails = (await toasts.innerText()).replace(/\s+/g, ' ')
  record(15, earlierShown && /(^|\s)old-talk(\s|$)/.test(earlierDetails) && readFileSync(join(site, EARLIER), 'utf8') === EARLIER_PAGE && deployments() === 1, earlierShown ? `the notice was shown; Details: ${earlierDetails.match(/old-talk/)?.[0] ?? 'nothing'}; the old page is byte for byte as it was` : `not shown: ${notice.slice(0, 200)}`)

  // 5. A Run's handout, the same way.
  const runFirst = await publishRun()
  const runFolder = existsSync(site) ? readdirSync(site).find((name) => name !== slug && name !== 'old-talk' && existsSync(join(site, name, 'index.html'))) : undefined
  const afterRun = gate('Run, live service absent')
  record(5, runFirst?.success === true && runFirst.liveNotice?.startsWith(`${D7}. The token cannot run the live service.`) && runFolder && carriesNoLive(pageOf(runFolder)) && carriesNoLive(pageOf(`${runFolder}/p`))
    && runRecord().handoutUrl === runFirst.url && deployments() === 2 && runFirst.earlierNotice === earlierSentence && runFirst.earlierDetails === 'old-talk', runFirst?.success ? `${runFirst.url} · ${runFirst.liveNotice}` : `not published: ${String(runFirst?.error).slice(0, 200)}`)

  // 6. A token that may set the live service up, and a set-up (Set up going live, in Settings: a
  // publish sets nothing up, spec D9) that fails at Cloudflare; then a publish.
  await useToken(TOKENS.full)
  const failing = (request) => (request.method === 'PUT' && /\/workers\/scripts\/[^/]+$/.test(request.path)
    ? { status: 400, body: { success: false, errors: [{ code: 10021, message: `The Worker could not be validated (${REPLY_TEXT_MARK})` }], messages: [], result: null } } : undefined)
  api.model.answer = failing
  const liveIs = (state) => page.waitForFunction((wanted) => document.querySelector('[data-cloudflare="live-service"]')?.getAttribute('data-state') === wanted, state, { timeout: 120_000 })
  await liveIs('not-set-up')
  await part('live-service-label').click()
  await liveIs('failed')
  await closeSettings()
  api.model.answer = null
  const second = await publish()
  const afterFailed = gate('talk, live set-up failing')
  const tried = api.requests.some((request) => request.method === 'PUT' && /\/workers\/scripts\//.test(request.path) && request.authorization === `Bearer ${TOKENS.full}`)
  record(6, second?.success === true && second.liveNotice === `${D7}. The live service could not be set up.` && tried && deployments() === 3
    && typeof second.liveDetails === 'string' && second.liveDetails.length > 0 && !Object.values(TOKENS).some((token) => second.liveDetails.includes(token))
    && !second.liveNotice.includes(REPLY_TEXT_MARK) && carriesNoLive(pageOf(slug)) && carriesNoLive(pageOf(`${slug}/p`)),
    second?.success ? `${second.liveNotice} · Details: ${second.liveDetails?.length ?? 0} characters${second.liveDetails?.includes(REPLY_TEXT_MARK) ? ', Cloudflare\'s own text among them' : ''}` : `not published: ${String(second?.error).slice(0, 200)}`)

  // 7. The live service ready (Try again on the row): its address in the pages, as before.
  await openSettings()
  await part('live-service-retry').click()
  await liveIs('ready')
  await closeSettings()
  const third = await publish()
  const runSecond = await publishRun()
  const afterReady = gate('talk and Run, live service ready')
  const ready = { home: pageOf(slug), handout: pageOf(slug, `${slug}.html`), download: pageOf(slug, `${slug}-download.html`), venue: pageOf(`${slug}/p`), runHome: pageOf(runFolder), runVenue: pageOf(`${runFolder}/p`) }
  record(7, third?.success === true && third.liveNotice === undefined && runSecond?.success === true && runSecond.liveNotice === undefined && runSecond.url === runFirst.url
    && Object.values(ready).every(carriesLive) && JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).liveWorkerBaseUrl === LIVE && deployments() === 5
    // The account the live service was deployed for is kept with its address.
    && JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).liveWorkerAccountId === ADA.id,
    Object.entries(ready).map(([name, html]) => `${name}: ${carriesLive(html) ? 'live address' : 'NO live address'}`).join(' · '))

  // 9. A token that can read the site but not publish to it.
  await useToken(TOKENS.readOnly)
  const rowBefore = await rowText()
  await closeSettings()
  const refused = await publish()
  record(9, refused?.success === false && refused.error === PUBLISH_REFUSED && refused.notReady === undefined && typeof refused.details === 'string'
    && refused.details.includes('[code: 10000]') && !Object.values(TOKENS).some((token) => refused.details.includes(token)) && !refused.error.includes(REPLY_TEXT_MARK)
    && rowBefore.endsWith('Ready'), `${refused?.error} · Details: ${String(refused?.details).replace(/\s+/g, ' ').slice(0, 160)}`)

  // The same refusal through the window: the failure's "Details" button, in the error tone.
  await pressPublish()
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes('Publish failed')), null, { timeout: 240_000 })
  seenButtons.push(...await toastButtons(page))
  const failedToast = page.locator('[role="status"] > div', { hasText: 'Publish failed' })
  const failedText = (await failedToast.innerText()).replace(/\s+/g, ' ')
  await failedToast.getByRole('button', { name: 'Details' }).click()
  await page.waitForTimeout(200)
  const afterDetails = (await toasts.innerText()).replace(/\s+/g, ' ')
  // 16. Every action button seen: named, and readable against its fill and against its toast.
  const tones = [...new Set(seenButtons.map((button) => button.tone))].sort()
  const labels = [...new Set(seenButtons.map((button) => button.label))].sort()
  record(16, seenButtons.length >= 4 && seenButtons.every(readable) && JSON.stringify(tones) === JSON.stringify(['error', 'success', 'warning'])
    && ['Copy link', 'Details', 'Open Settings'].every((label) => labels.includes(label)) && failedText.includes(PUBLISH_REFUSED) && !failedText.includes('[code:')
    && afterDetails.length > failedText.length && !Object.values(TOKENS).some((token) => afterDetails.includes(token)),
    seenButtons.map((button) => `${button.tone} "${button.label}" ${button.colour} on ${button.fill} (${button.onFill.toFixed(1)}:1; fill on toast ${button.onToast.toFixed(1)}:1)`).join(' · '))

  // 10. The row after the refusal, and after "Check again".
  await openSettings()
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="publishing"]')?.getAttribute('data-state') === 'no-permission', null, { timeout: 20_000 })
  const rowRefused = await rowText()
  const requestsBefore = api.requests.length
  await settings.getByRole('button', { name: 'Check again' }).click()
  const siteRead = () => api.reached().slice(requestsBefore).includes(`GET /accounts/${ADA.id}/pages/projects/${SITE}`)
  for (const end = Date.now() + 20_000; Date.now() < end && !siteRead();) await page.waitForTimeout(50)
  await settled()
  await page.waitForTimeout(300)
  const checkedAgain = siteRead()
  const rowAfterCheck = await rowText()
  await shot('12-token-cannot-publish-pages', settings)
  record(10, rowRefused === 'Publishing handouts Missing permission: Account · Cloudflare Pages · Edit The token cannot publish pages' && checkedAgain && rowAfterCheck === rowRefused
    && (await part('connection-label').innerText()) === 'Connected · Ada Lovelace', `after the refusal: "${rowRefused}" · after Check again (the site was read: ${checkedAgain}): "${rowAfterCheck}"`)

  // 11. The permission is added at Cloudflare (the token is not replaced): the next publish goes up, and only then is the row Ready.
  api.model.tokens.get(TOKENS.readOnly).pages = true
  const fourth = await publish()
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="publishing"]')?.getAttribute('data-state') === 'ready', null, { timeout: 20_000 }).catch(() => {})
  const rowReady = await rowText()
  const afterAllowed = gate('talk, after the permission was added')
  record(11, fourth?.success === true && rowReady === `Publishing handouts Site ${SITE} · ${SITE}.pages.dev Ready`, `${fourth?.success ? 'published' : `not published: ${String(fourth?.error).slice(0, 160)}`} · "${rowReady}"`)

  // 12. Disconnected: the Run's publish and unpublish say what is missing, and change nothing.
  await settings.getByRole('button', { name: 'Disconnect' }).click()
  await page.waitForFunction(() => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === 'Not connected', null, { timeout: 20_000 })
  await settled()
  await closeSettings()
  const sentBefore = api.requests.length
  const runNotConnected = await publishRun()
  const unpublishNotConnected = await unpublishRun()
  record(12, runNotConnected?.success === false && runNotConnected.notReady?.kind === 'not-connected' && runNotConnected.notReady.title === 'Publishing needs a Cloudflare account'
    && unpublishNotConnected?.success === false && unpublishNotConnected.notReady?.kind === 'not-connected' && runRecord().handoutUrl === runFirst.url
    && existsSync(join(site, runFolder, 'index.html')) && api.requests.length === sentBefore, `${runNotConnected?.error} · the Run's pages and link are still there`)

  // 8. The gate, over every publish above.
  const dirty = [...afterFirst, ...afterRun, ...afterFailed, ...afterReady, ...afterAllowed, ...gate('at the end')]
  const bundledWord = filesBelow(site).some((path) => /localhost/.test(readFileSync(path, 'latin1')))
  record(8, dirty.length === 0 && gateRuns.every((run) => run.files >= 5) && bundledWord,
    dirty.length ? `found in: ${[...new Set(dirty)].join(', ')}` : `${gateRuns.map((run) => `${run.label}: ${run.files} files`).join(' · ')} (the pages do hold "localhost": in the handout's own code and in the author's slide)`)

  // 13. Nothing secret anywhere it could be read.
  const windowText = await page.evaluate(() => document.documentElement.outerHTML)
  await app.close()
  app = null
  const tokens = Object.values(TOKENS)
  const inWindow = tokens.filter((value) => windowText.includes(value)).length
  const inOutput = tokens.filter((value) => output.includes(value)).length
  const inFiles = [...findIn(userData, tokens).map((path) => `userData/${path}`), ...findIn(vault, tokens).map((path) => `vault/${path}`)]
  record(13, inWindow === 0 && inOutput === 0 && inFiles.length === 0 && tokens.every((token) => api.requests.some((request) => request.authorization === `Bearer ${token}`)),
    inFiles.length ? `found in: ${inFiles.join(', ')}` : `${windowText.length} characters of the window and ${output.length} of output searched; each token was really used`)

  // 17. A talk naming work files: Publish says they go out with a Run (ticket 23). The app is started again for it.
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env })
  app.process().stdout.on('data', (chunk) => { output += chunk })
  app.process().stderr.on('data', (chunk) => { output += chunk })
  await app.evaluate(({ shell, app: electronApp, BrowserWindow }) => {
    shell.openExternal = async () => {}
    shell.showItemInFolder = () => {}
    shell.openPath = async () => ''
    if (process.env.TW_E2E_SHOW !== '1') {
      const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
      BrowserWindow.getAllWindows().forEach(hide)
      electronApp.on('browser-window-created', (_event, win) => hide(win))
    }
  })
  const page2 = await app.firstWindow()
  await page2.waitForLoadState('domcontentloaded')
  await openTalkByTitle(page2, 'Work probe')
  const noticeSheet = page2.locator('[data-testid="publish-work-notice-sheet"]')
  const notReadySheet = page2.locator('[data-testid="publish-not-ready"]')
  const noticeText = () => noticeSheet.locator('[data-testid="publish-work-notice-text"]').innerText().then((text) => text.replace(/\s+/g, ' ').trim())
  const pressPublish2 = async () => {
    const sent = await app.evaluate(({ BrowserWindow }, url) => {
      const editor = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL() === url)
      editor?.webContents.send('app:command', 'publish-handout')
      return Boolean(editor)
    }, page2.url())
    if (!sent) throw new Error('the editor window was not found to send Publish to')
  }
  const beforeNotice = api.requests.length
  // The talk's text is still loading when the window first answers: press again until the notice is up.
  for (let attempt = 0; attempt < 6 && !(await noticeSheet.isVisible()); attempt++) {
    await pressPublish2()
    await noticeSheet.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
  }
  await noticeSheet.waitFor({ state: 'visible', timeout: 5000 })
  const sentence = await noticeText()
  await page2.waitForTimeout(500) // the sheet fades in
  if (shots) await page2.screenshot({ path: join(shots, '10-publish-work-notice.png') }).catch(() => {})
  await noticeSheet.getByRole('button', { name: 'Cancel' }).click()
  await noticeSheet.waitFor({ state: 'detached' })
  const cancelledSent = api.requests.length === beforeNotice && await notReadySheet.count() === 0
  await pressPublish2()
  await noticeSheet.waitFor({ state: 'visible', timeout: 20_000 })
  await noticeSheet.getByRole('button', { name: 'Publish' }).click()
  await notReadySheet.waitFor({ state: 'visible', timeout: 20_000 }) // not connected here: publishing carried on to its own sheet
  await page2.keyboard.press('Escape')
  await notReadySheet.waitFor({ state: 'detached' })
  await pressPublish2()
  await noticeSheet.waitFor({ state: 'visible', timeout: 20_000 })
  await noticeSheet.getByRole('button', { name: 'Plan a run' }).click()
  await page2.locator('[data-testid="plan-run-sheet"]').waitFor({ state: 'visible', timeout: 20_000 })
  record(17, sentence === 'Pre-work and post-work are not included. The talk’s pre-work file, Research teams intake, and post-work file, After the session, go out with a run.'
    && cancelledSent && await noticeSheet.count() === 0, sentence)
  await app.close()
  app = null

  exitCode = ledger.summary('PUBLISH HANDOUT').exitCode
} catch (error) {
  let text = String(error?.stack ?? error)
  for (const value of Object.values(TOKENS)) text = text.split(value).join('[made-up token]')
  // What the app itself printed, to say why (made-up tokens taken out).
  let said = output.slice(-1500)
  for (const value of Object.values(TOKENS)) said = said.split(value).join('[made-up token]')
  console.log(`FAIL  the journey could not run: ${text}\n      the app's last output: ${said.replace(/\s+/g, ' ')}\n      requests the fake API got: ${api?.reached().slice(-8).join(' | ')}`)
  try { ledger.summary('PUBLISH HANDOUT') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  const pid = app?.process().pid
  try { await app?.close() } catch { /* already closed */ }
  if (pid) { try { process.kill(pid) } catch { /* gone, as it should be */ } }
  await api?.close()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
