import { openSettingsWindow, closeSettingsWindow } from './lib/settings-window.mjs'
// Work-files-and-sessions ticket 31: the core pre-work journey, end to end in the real app
// (journeys.md § Locked, journey 1 "Right when"). Hidden-window Electron on a throwaway
// vault and user-data folder, the fake Cloudflare API on this computer's loopback address (the app is
// pointed at it by the test-only override), the live Worker under local `wrangler dev`, and Playwright's
// bundled Chromium as the participant. Nothing leaves loopback.
//
// The wiring that stands in for the internet, and why:
//   - Pages: the bundled publishing tool really runs `pages deploy` against the fake API and writes the
//     site into <userData>/cloudflare-pages-site. The participant's browser is given those very files
//     for https://talkweaver-handouts.pages.dev (a Playwright route), so it reads what the app wrote.
//   - The live service: Settings → "Set up going live" runs against the fake API and records the address
//     https://talkweaver-live-sessions.stand-in.workers.dev. The app refuses to write an address on this
//     computer into a page (and to push to one), so that made-up address is kept, and the two things that
//     could not resolve it are pointed at `wrangler dev`: the app's main-process fetch (e2e/lib/
//     local-live-address-shim.cjs, loaded into the test's Electron main with -r before the app starts) and
//     the participant's browser (a Playwright route). The shim also swaps the app's own key for the local
//     Worker's admin secret on admin requests.
//
// The journey (ticket 31): attach a work file in metadata → plan a run with pre-work → Save opens the Run
// page → Publish for this run → the participant opens /pre-work from the written site and answers two
// steps → the Run page shows 1/N and the answers, the status bar chip shows the count → Unpublish and
// confirm → the participant reloads and sees "This page is not available"; the answers stay on the Run.
// The four "Right when" lines are checks 1, 3, 4/5 and 9 below; the last check scans every file the
// publish wrote for an address on this computer.
//
// TW_SHOTS_DIR=<dir> saves pictures of each stage.
// Run: npm run test:core-journey:e2e
import { _electron as electron, chromium } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { PRE_WORK, TASK_PICTURE } from '../scripts/lib/work-page-fixture.mjs'
import { WORKERS_SUBDOMAIN, startCloudflareApiStub } from '../scripts/lib/cloudflare-api-stub.mjs'
import { startLiveWorker } from '../scripts/lib/live-worker-harness.mjs'
import { appWrittenLoopback } from '../src/main/handout-publishing.ts'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-core-journey-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const site = join(userData, 'cloudflare-pages-site')
const slug = 'core-journey'
const talkDir = join(vault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
const shots = process.env.TW_SHOTS_DIR ? resolve(process.env.TW_SHOTS_DIR) : null
if (shots) mkdirSync(shots, { recursive: true })

// Made up, and built so that no source file holds a whole value.
const TOKEN = ['test', 'token', 'core', 'journey', 'full', '0123456789abcdef'].join('-')
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const SITE = 'talkweaver-handouts'
const PAGES = `https://${SITE}.pages.dev`
const LIVE_HOST = `talkweaver-live-sessions.${WORKERS_SUBDOMAIN}.workers.dev`
const EVENT = 'Core journey workshop'
const EXPECTED = 12
const NOT_AVAILABLE = 'This page is not available'

const pad = (n) => String(n).padStart(2, '0')
const dayOf = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

mkdirSync(userData, { recursive: true })
mkdirSync(talkDir, { recursive: true })
mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
mkdirSync(join(vault, 'Work files'), { recursive: true })
writeFileSync(join(vault, 'Work files', 'research-teams-intake.md'), PRE_WORK)
writeFileSync(join(vault, 'Work files', 'paper-and-chat.svg'), TASK_PICTURE)
// The strips sit under the Metadata table, which is the Markdown view (the Plain view has its own Talk details panel).
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }))
const OUTLINE = ['---', 'title: Core journey', 'outline_version: 2', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### Opening', '{id=opening}', '', '- Kestrelwing opening point', '', '### Close', '{id=close}', '', '- Kestrelwing closing point', ''].join('\n')
writeFileSync(outlinePath, OUTLINE)

const CHECKS = [
  'the app started on the throwaway folder, pointed at the fake API; the live Worker is local',
  'attach a work file in metadata; before any publish the strip says "not sent to anyone"',
  'Plan a run with pre-work: one Save writes the planned Run with its file and window, and opens its Run page',
  'the Run page is not published: Publish is on its Published step; the live service is set up through Settings first',
  'Publish for this run: one link for that Run only (the handout and its pre-work page under one folder; the talk itself is not published)',
  'the participant opens /pre-work from the written site and answers two steps; no page error, no right answer in the page',
  'the Run page shows 1 of the expected people and the answers (the open answer as text, the quick check\'s spread)',
  'the status bar chip shows the count: "pre-work 1/N"',
  'Unpublish sits where Publish was and asks first: the handout and the pre-work page will show "This page is not available"; the answers are kept',
  'after confirming, the Published step reads Unpublished with Publish again in the same place; the participant\'s reload shows "This page is not available"; the answers stay on the Run',
  'no address on this computer in any file the publish wrote (loopback host and port, the temporary folders, the home folder)',
  'no token in the window, the app\'s output or any file',
]
const ledger = createCheckLedger(CHECKS)
const record = (index, ok, detail) => ledger.record(CHECKS[index], Boolean(ok), detail)

function filesBelow(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)]))
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' }
/** What the participant's browser is given for an address on the made-up Pages host: the file the app wrote for it. */
function siteFileFor(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '')
  if (clean.split('/').includes('..')) return null
  for (const candidate of [clean, join(clean, 'index.html'), `${clean}.html`]) {
    const path = join(site, candidate)
    if (existsSync(path) && !readdirSyncSafe(path)) return path
  }
  return null
}
function readdirSyncSafe(path) { try { readdirSync(path); return true } catch { return false } }
const until = async (read, predicate, timeoutMs, label) => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}; last: ${JSON.stringify(value)?.slice(0, 300)}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
}
const runFile = () => { const dir = join(vault, '_PRESENTATIONS', slug); const name = readdirSync(dir).find((n) => n.endsWith('.json') && n !== 'manifest.json'); return name ? join(dir, name) : null }
const runRecord = () => { const path = runFile(); return path ? JSON.parse(readFileSync(path, 'utf8')) : null }

let app
let api
let worker
let browser
let output = ''
let exitCode = 1
try {
  await ensureFreshBuild(root)
  api = await startCloudflareApiStub({
    sites: [], accounts: [ADA], accountSites: { [ADA.id]: [SITE] },
    tokens: { [TOKEN]: { accounts: [ADA.id] } },
  })
  worker = await startLiveWorker()
  const workerPort = new URL(worker.baseUrl).port

  // Only what the app needs from this shell: no credential of the person running the test goes in.
  // No TW_LIVE_LOCAL and no TW_REC_TEST: the publish is the real one, as in an installed app.
  const env = { TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl, TW_SHIM_HOST: LIVE_HOST, TW_SHIM_BASE: worker.baseUrl, TW_SHIM_ADMIN: worker.adminSecret }
  for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'PATHEXT', 'ComSpec']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
    try { app = await electron.launch({ args: ['-r', join(root, 'e2e/lib/local-live-address-shim.cjs'), '.', `--user-data-dir=${userData}`], cwd: root, env, timeout: 60_000 }) }
    catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
  }
  app.process().stdout.on('data', (chunk) => { output += chunk })
  app.process().stderr.on('data', (chunk) => { output += chunk })
  // Nothing leaves the app: calls that would open a browser or a folder are replaced.
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
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  page.on('pageerror', (error) => console.log('PAGEERROR (editor):', error.message.slice(0, 200)))
  const where = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  const onThrowaway = realpathSync(where) === realpathSync(userData)
  record(0, onThrowaway && new URL(api.baseUrl).hostname === '127.0.0.1' && new URL(worker.baseUrl).hostname === '127.0.0.1')
  if (!onThrowaway) throw new Error('not on the throwaway user-data folder: stopping before any token is saved')
  const shot = async (name, target = page) => { if (shots) await target.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {}) }

  // ---- Connect Cloudflare and set up going live through Settings, as a person does.
  const settingsPage = await openSettingsWindow(app, page, 'cloudflare')
  const settings = settingsPage.locator('.bsw-root')
  const part = (name) => settings.locator(`[data-cloudflare="${name}"]`)
  const settled = () => settingsPage.waitForFunction(() => document.querySelector('[data-cloudflare="connection"]')?.getAttribute('data-busy') === 'no', null, { timeout: 40_000 })
  await page.waitForTimeout(1500)
  await part('connection').waitFor({ state: 'visible' })
  await part('connection').scrollIntoViewIfNeeded()
  await part('token').locator('input').fill(TOKEN)
  await part('token').getByRole('button', { name: 'Save token' }).click()
  await settingsPage.waitForFunction(() => document.querySelector('[data-cloudflare="connection-label"]')?.textContent === 'Connected · Ada Lovelace', null, { timeout: 40_000 })
  await settled()
  const liveIs = (state, timeout = 90_000) => settingsPage.waitForFunction((wanted) => document.querySelector('[data-cloudflare="live-service"]')?.getAttribute('data-state') === wanted, state, { timeout })
  await liveIs('not-set-up', 120_000)
  await part('live-service-label').click()
  await liveIs('ready')
  await shot('0-live-service-ready', settings)
  const liveReady = readFileSync(join(userData, 'config.json'), 'utf8').includes(LIVE_HOST)
  await closeSettingsWindow(app)

  // ---- 1. Attach a work file in metadata.
  await openTalkByTitle(page, 'Core journey')
  const strip = page.locator('[data-work-strip="pre"]')
  await strip.waitFor({ timeout: 10_000 })
  await strip.locator('[data-strip-action="attach"]').click()
  await page.waitForSelector('[data-strip-menu="attach-pre"]', { timeout: 5000 })
  await page.locator('[data-strip-menu="attach-pre"] button', { hasText: 'Research teams intake' }).click()
  await page.waitForFunction(() => document.querySelector('[data-work-strip="pre"]')?.textContent?.includes('not sent to anyone'), null, { timeout: 8000 }).catch(() => {})
  const notSent = (await strip.innerText()).replace(/\s+/g, ' ').trim()
  await shot('1-not-sent')
  record(1, notSent.startsWith('Pre-work · Research teams intake · 4 steps · not sent to anyone') && notSent.includes('Plan a run'), notSent)

  // ---- 2. Plan a run with pre-work; 3. Save opens the Run page.
  await page.waitForTimeout(3500) // the attachment is written before the sheet reads the talk's metadata
  await strip.locator('[data-strip-action="plan-run"]').click()
  const sheet = page.locator('[data-testid="plan-run-sheet"]')
  await sheet.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-field="pre-file"]')?.value === 'research-teams-intake', null, { timeout: 10_000 })
  const date = dayOf(3)
  await sheet.locator('[data-field="event"]').fill(EVENT)
  await sheet.locator('[data-field="date"]').fill(date)
  await sheet.locator('[data-field="start"]').fill('14:00')
  await sheet.locator('[data-field="expected"]').fill(String(EXPECTED))
  await sheet.locator('[data-field="pre-opens"]').fill(`${dayOf(-1)}T09:00`)
  await sheet.locator('[data-field="pre-closes"]').fill(`${date}T13:00`)
  await shot('2-plan-sheet')
  const toolsOpened = app.waitForEvent('window')
  await sheet.locator('[data-testid="plan-run-save"]').click()
  await sheet.waitFor({ state: 'detached' })
  let tools = await toolsOpened
  tools.on('pageerror', (error) => console.log('PAGEERROR (tools):', error.message.slice(0, 200)))
  await tools.waitForLoadState('domcontentloaded')
  await tools.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await tools.waitForSelector('[data-run-checklist]', { timeout: 20_000 })
  const planned = runRecord()
  const runId = planned?.id
  record(2, planned?.status === 'planned' && planned.eventTitle === EVENT && planned.expectedPeople === EXPECTED && planned.work?.pre?.fileId === 'research-teams-intake'
    && !planned.work?.post && await tools.locator(`[data-sessions-detail="${slug}/${runId}"]`).count() === 1,
    JSON.stringify({ status: planned?.status, work: planned?.work }))
  await shot('3-run-page-not-published', tools)

  // ---- 4. Publish for this run.
  let publishStep = tools.locator('[data-run-step="published"]')
  const publishButton = publishStep.locator('[data-run-action="publish"]')
  const beforePublish = {
    pill: (await tools.locator('[data-run-pill]').innerText()).trim(),
    publishHere: await publishButton.count() === 1,
    unpublishHere: await publishStep.locator('[data-run-action="unpublish"]').count(),
  }
  record(3, liveReady && beforePublish.pill === 'Not published' && beforePublish.publishHere && beforePublish.unpublishHere === 0, JSON.stringify(beforePublish))
  await publishButton.click()
  await until(async () => (await tools.locator('[data-run-published-block]').count()) > 0 ? 'published' : (await tools.locator('[data-run-notice]').innerText().catch(() => '')).trim(),
    (state) => state === 'published' || state !== '', 300_000, 'the Published block or a notice')
    .then((state) => { if (state !== 'published') throw new Error(`Publish for this run said: ${state}`) })
  await shot('4-run-page-published', tools)
  const published = runRecord()
  const handoutUrl = published.handoutUrl
  const linkRows = await tools.locator('[data-run-link]').evaluateAll((rows) => rows.map((row) => ({ kind: row.getAttribute('data-run-link'), text: row.querySelector('.url')?.textContent ?? '' })))
  const preLink = linkRows.find((row) => row.kind === 'pre-work')
  const runFolder = published.handoutFolder
  const topLevel = existsSync(site) ? readdirSync(site, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []
  const pagesOfRun = ['index.html', 'pre-work/index.html'].map((file) => existsSync(join(site, runFolder ?? '-', file)))
  const talkOutline = readFileSync(outlinePath, 'utf8')
  record(4, typeof handoutUrl === 'string' && handoutUrl.startsWith(`${PAGES}/${runFolder}/`) && !!preLink && preLink.text.replace(/\s+/g, '').includes(`${runFolder}/pre-work`)
    && pagesOfRun.every(Boolean)
    && JSON.stringify(topLevel) === JSON.stringify([runFolder]) && !talkOutline.includes('handout_url') && published.work?.pre?.publishedAt,
    JSON.stringify({ handoutUrl, links: linkRows, topLevel, pagesOfRun }))
  const preUrl = `${handoutUrl.replace(/\/+$/, '')}/pre-work/`

  // ---- 5. The participant.
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const participantErrors = []
  const outside = []
  // Anything that is neither the written site, the local Worker nor the video player is refused, and counted.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return route.continue()
    outside.push(url.href)
    return route.abort()
  })
  await context.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><title>player</title><body></body>' }))
  await context.route(`https://${LIVE_HOST}/**`, async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${worker.baseUrl}${url.pathname}${url.search}` })
    await route.fulfill({ response })
  })
  await context.route(`${PAGES}/**`, (route) => {
    const file = siteFileFor(new URL(route.request().url()).pathname)
    if (!file) return route.fulfill({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' })
    return route.fulfill({ status: 200, headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }, body: readFileSync(file) })
  })
  const phone = await context.newPage()
  phone.on('pageerror', (error) => participantErrors.push(String(error)))
  phone.on('console', (message) => { if (message.type() === 'error') participantErrors.push(message.text()) })
  await phone.goto(preUrl)
  await phone.waitForSelector('[data-wp-cta]', { timeout: 20_000 })
  const saved = () => phone.waitForFunction(() => { const note = document.querySelector('.wp-note'); return note && !note.hidden && note.dataset.tone === 'ok' && note.innerText.includes('Sent to the speaker') }, null, { timeout: 15_000 })
  await shot('5-participant-start', phone)
  await phone.click('[data-wp-cta]')
  await phone.waitForSelector('.wp-media iframe[src^="https://www.youtube-nocookie.com/embed/"]')
  await phone.click('.wp-next')
  await phone.locator('.pw-opt').nth(2).click(); await saved() // the quick check
  await phone.click('.wp-next')
  await phone.click('.wp-next') // the task is read, not marked done
  const ANSWER = 'How to check what it gets wrong.'
  await phone.fill('.pw-text', ANSWER) // the open question
  await saved()
  await shot('5-participant-answered', phone)
  const pageHtml = await phone.content()
  const writtenPre = readFileSync(join(site, runFolder, 'pre-work', 'index.html'), 'utf8')
  const rightPattern = /\{right\}|data-right|"right"\s*:|"isRight"|"correct"\s*:/g
  const rightAt = [writtenPre, pageHtml].flatMap((text) => [...text.matchAll(rightPattern)].map((hit) => text.slice(Math.max(0, hit.index - 60), hit.index + 40).replace(/\s+/g, ' ')))
  const rightShown = rightAt.length > 0
  record(5, participantErrors.length === 0 && outside.length === 0 && !rightShown,
    participantErrors.length ? participantErrors.join(' | ').slice(0, 300) : `requests outside the site and the Worker: ${outside.length}${outside.length ? ` (${outside[0]})` : ''}; right answer in the page: ${rightShown}${rightShown ? ` (${rightAt[0]})` : ''}`)

  // ---- 6. The Run page and the chip.
  // The Run page reads the Run's answers from the live service when it is opened: the person comes back to it
  // by the status bar chip, which opens Sessions on the Run (a Tools window already showing it keeps what it read).
  const chip = page.locator('[data-testid="status-run"]')
  const chipBefore = (await chip.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  await tools.close()
  const reopened = app.waitForEvent('window')
  await chip.click()
  tools = await reopened
  tools.on('pageerror', (error) => console.log('PAGEERROR (tools):', error.message.slice(0, 200)))
  await tools.waitForLoadState('domcontentloaded')
  await tools.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await tools.waitForSelector(`[data-sessions-detail="${slug}/${runId}"]`, { timeout: 20_000 })
  publishStep = tools.locator('[data-run-step="published"]')
  const answeredNow = () => tools.locator('[data-run-section="pre-answers"] [data-run-answered]').innerText().then((t) => t.trim(), () => '')
  await until(answeredNow, (text) => text === `1/${EXPECTED} answered`, 60_000, 'the Run page to count the participant')
  const pre = tools.locator('[data-run-section="pre-answers"]')
  const openRows = await pre.locator('[data-run-answer-step="what-you-want"] [data-run-answer] .tx').allInnerTexts().catch(() => [])
  const spread = await pre.locator('[data-run-answer-step="quick-check"] [data-run-spread]').count().catch(() => 0)
  await shot('6-run-page-answers', tools)
  record(6, (await answeredNow()) === `1/${EXPECTED} answered` && openRows.includes(ANSWER) && spread >= 1,
    JSON.stringify({ header: await answeredNow(), openRows, spread }))
  const chipText = await until(async () => {
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('tw-runs-changed')) })
    return (await chip.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  }, (text) => text.includes(`pre-work 1/${EXPECTED}`), 60_000, 'the status bar chip to show the count')
  await shot('7-chip')
  record(7, chipText.startsWith(EVENT) && chipText.endsWith(`pre-work 1/${EXPECTED}`), `${chipBefore} → ${chipText}`)

  // ---- 7. Unpublish where Publish was, and confirm.
  const unpublishButton = publishStep.locator('[data-run-published-block] [data-run-action="unpublish"]')
  const sameStep = await unpublishButton.count() === 1 && await publishStep.locator('[data-run-action="publish"]').count() === 0
  const confirm = tools.locator('[data-unpublish-confirm]')
  const askToUnpublish = async () => {
    await unpublishButton.click()
    await confirm.waitFor({ timeout: 10_000 })
    return (await confirm.innerText()).replace(/\s+/g, ' ').trim()
  }
  // The sentence is made from the Sessions list, which is read again once the Run page has pulled the answers: one ask, as it stands.
  const confirmText = await askToUnpublish()
  await shot('8-unpublish-confirm', tools)
  record(8, sameStep && confirmText.includes(`Unpublish ${EVENT}?`) && confirmText.includes('The handout and the pre-work page will show “This page is not available”. The 1 answer is kept.') && !confirmText.includes('post-work'),
    confirmText)
  await confirm.locator('[data-unpublish-action="confirm"]').click()
  await confirm.waitFor({ state: 'detached', timeout: 240_000 })
  await tools.waitForSelector('[data-run-pill]:text("Unpublished")', { timeout: 60_000 })
  await shot('9-run-page-unpublished', tools)
  const afterStep = tools.locator('[data-run-step="published"]')
  const again = await afterStep.locator('[data-run-action="publish-again"]').count()
  const stamped = runRecord()

  // ---- 8. The participant reloads.
  await phone.reload()
  await phone.waitForFunction((text) => document.body.innerText.includes(text), NOT_AVAILABLE, { timeout: 20_000 }).catch(() => {})
  const gone = (await phone.locator('body').innerText()).replace(/\s+/g, ' ')
  const handoutPage = await context.newPage()
  await handoutPage.goto(handoutUrl)
  const handoutGone = (await handoutPage.locator('body').innerText()).replace(/\s+/g, ' ')
  await shot('10-participant-not-available', phone)
  const keptAfter = runRecord()?.prework
  const answersStay = (keptAfter?.entries ?? []).some((entry) => entry.kind === 'answer' && entry.text === ANSWER)
  record(9, again === 1 && gone.includes(NOT_AVAILABLE) && handoutGone.includes(NOT_AVAILABLE) && !!stamped.work?.pre?.unpublishedAt && answersStay
    && (await tools.locator('[data-run-section="pre-answers"] [data-run-answered]').innerText()).trim() === `1/${EXPECTED} answered`,
    JSON.stringify({ publishAgain: again, participant: gone.slice(0, 80), handout: handoutGone.slice(0, 80), kept: keptAfter?.entries?.length }))

  // ---- 9. No address on this computer in anything the publish wrote.
  const files = filesBelow(site)
  const needles = [`127.0.0.1:${api.port}`, `127.0.0.1:${workerPort}`, `localhost:${api.port}`, `localhost:${workerPort}`, scratch, vault, userData, homedir(), tmpdir(), 'file://']
    .flatMap((value) => [Buffer.from(value, 'utf8'), Buffer.from(value, 'utf16le')])
  const leaking = files.filter((path) => needles.some((needle) => readFileSync(path).includes(needle))).map((path) => relative(site, path))
  const positional = files.map((path) => relative(site, path).split('\\').join('/')).filter((file) => appWrittenLoopback(file, readFileSync(join(site, file), 'latin1')) !== null)
  const pageFiles = files.filter((path) => path.endsWith('.html')).length
  record(10, leaking.length === 0 && positional.length === 0 && pageFiles >= 4,
    leaking.length || positional.length ? `found in: ${[...new Set([...leaking, ...positional])].join(', ')}` : `${files.length} files scanned (${pageFiles} pages): none holds the fake API's or the Worker's address, a temporary folder or the home folder`)

  // ---- 10. Nothing secret anywhere it could be read.
  const windowText = await page.evaluate(() => document.documentElement.outerHTML)
  const toolsText = await tools.evaluate(() => document.documentElement.outerHTML)
  const inFiles = [...filesBelow(userData), ...filesBelow(vault)].filter((path) => { try { return readFileSync(path).includes(Buffer.from(TOKEN)) } catch { return false } })
  record(11, !windowText.includes(TOKEN) && !toolsText.includes(TOKEN) && !output.includes(TOKEN) && inFiles.length === 0 && api.requests.some((request) => request.authorization === `Bearer ${TOKEN}`),
    inFiles.length ? `found in: ${inFiles.join(', ')}` : `${windowText.length + toolsText.length} characters of windows and ${output.length} of output searched`)

  exitCode = ledger.summary('CORE JOURNEY').exitCode
} catch (error) {
  let text = String(error?.stack ?? error).split(TOKEN).join('[made-up token]')
  const said = output.slice(-1500).split(TOKEN).join('[made-up token]')
  console.log(`FAIL  the journey could not run: ${text}\n      the app's last output: ${said.replace(/\s+/g, ' ')}\n      requests the fake API got: ${api?.reached().slice(-8).join(' | ')}`)
  const shimmed = await app?.evaluate(() => globalThis.__liveShim).catch(() => null)
  if (shimmed) console.log(`      requests the live Worker got through the shim: ${shimmed.slice(-12).join(' | ')}`)
  try { ledger.summary('CORE JOURNEY') } catch { /* summary already printed */ }
  exitCode = 1
} finally {
  const pid = app?.process().pid
  await browser?.close().catch(() => {})
  try { await app?.close() } catch { /* already closed */ }
  if (pid) { try { process.kill(pid) } catch { /* gone, as it should be */ } }
  await worker?.stop().catch(() => {})
  await api?.close().catch(() => {})
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}
process.exit(exitCode)
