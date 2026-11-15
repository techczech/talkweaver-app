// Journey stage `updates` (ADR-0044): the one click that updates TalkWeaver in place, as a person meets it, on
// the checkout's own build. A stand-in feed and update file on this computer's loopback address (the test-only
// TW_E2E_UPDATES_FEED, honoured only on a harness profile); deterministic: the file's second half is held until the
// stage releases it, so the download always ends while the presenter window is open. A run from source downloads
// and checks the file, then logs the restart instead of installing (the real replacement is
// scripts/prove-in-place-update.mjs).
//   node scripts/journeys/updates.mjs   (evidence: artefacts/journey/updates/)
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, closeApp, runFolders, ledger, shooter, size, pause, hardLimit, tempDir, REPO } from './lib.mjs'
import { makeVault, TITLE } from './talk.mjs'
import { openTalkByTitle } from '../../e2e/lib/talklist.mjs'
import { testProfileEnv } from '../../e2e/lib/test-profile.mjs'
import { makeUpdateZip } from '../lib/update-test-zip.mjs'

hardLimit(Number(process.env.TW_LIMIT_MS || 300000), 'updates')
const { out, state } = runFolders('updates')
const { record, harness } = ledger(out, 'updates')
const shot = shooter(out)
const { vault } = makeVault(state)
// The profile lies in this stage's own temporary folder: the test-network guard honours the feed only there.
const userData = join(tempDir('tw-journey-updates-'), 'userData')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, theme: 'light' }))

const running = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version
const [major, minor] = running.split('.').map(Number)
const NEXT = `${major}.${minor + 1}.0`
// Shaped as the release makes it: the app inside names the version offered (the updater checks that before restarting).
const BODY = makeUpdateZip({ version: NEXT, padBytes: 4 * 1024 * 1024 })
const SHA512 = createHash('sha512').update(BODY).digest('base64')
const ASSET = 'TalkWeaver-mac-arm64.zip'
const fileRequests = []
let release = () => {}
let hold = new Promise((r) => { release = r })
let base = ''
const server = createServer(async (req, res) => {
  if (req.url === '/updates.json') {
    const entry = {
      version: NEXT, released: '2026-11-20', summary: ['Updates now install with one click.'], notes: `https://talkweaver.app/whats-new#${NEXT}`,
      download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' },
    }
    const releaseEntry = { ...entry, update: { mac: { url: `${base}/releases/download/v${NEXT}/${ASSET}`, sha512: SHA512, size: BODY.length } } }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ schema: 1, latest: entry, channels: { release: releaseEntry } }))
    return
  }
  if (req.url === `/releases/download/v${NEXT}/${ASSET}`) {
    fileRequests.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': BODY.length })
    res.write(BODY.subarray(0, BODY.length >> 1))
    await hold
    res.end(BODY.subarray(BODY.length >> 1))
    return
  }
  res.statusCode = 404; res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
base = `http://127.0.0.1:${server.address().port}`

let app
const logs = []
const markText = async (page) => (await page.locator('[data-update-mark]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
const waitFor = async (fn, ms = 20000) => { const until = Date.now() + ms; while (Date.now() < until) { const v = await fn(); if (v) return v; await pause(150) } return null }
try {
  ;({ app } = await launch(userData, { extraEnv: { TW_E2E_UPDATES_SOURCE: 'website', TW_E2E_UPDATES_FEED: `${base}/updates.json`, ...testProfileEnv(userData) } }))
  app.process().stdout?.on('data', (c) => logs.push(String(c)))
  const main = await app.firstWindow()
  await openTalkByTitle(main, TITLE)
  await main.waitForSelector('.cm-content', { timeout: 30000 })
  await size(main, 1000, 760)
  const snap = () => main.evaluate(() => window.tw.updates.get())

  // The check (as Check for Updates… does), then the mark and its popover.
  await main.evaluate(() => window.tw.updates.check())
  const shown = await waitFor(async () => (await markText(main)).includes(`${NEXT} is available`))
  await main.locator('[data-update-mark]').click().catch(() => {})
  const pop = await main.waitForSelector('[data-update-popover]', { timeout: 8000 }).then(() => true, () => false)
  const hasUpdate = (await main.locator('[data-update-popover] [data-update-update]').count()) === 1
  record('updates.mark', !!shown && pop && hasUpdate, `mark "${await markText(main)}"; popover ${pop}; Update offered ${hasUpdate}`, await shot(main, 'offer'))
  await pause(1000)
  record('updates.click-only', fileRequests.length === 0, `requests for the update file before the click: ${fileRequests.length}`, '', { fileRequests: fileRequests.length })

  const geometry = await main.evaluate(() => {
    const p = document.querySelector('[data-update-popover]')?.getBoundingClientRect()
    const bar = document.querySelector('[data-update-mark]')?.closest('footer, .status-bar, [class*="status"]')?.getBoundingClientRect()
    return { width: innerWidth, pop: p && { left: p.left, right: p.right, top: p.top, bottom: p.bottom }, barHeight: bar?.height ?? null }
  })
  const fits = geometry.pop && geometry.pop.left >= 0 && geometry.pop.right <= geometry.width && geometry.pop.top >= 0 && (geometry.barHeight === null || geometry.barHeight <= 40)
  record('updates.fits-1000', !!fits && geometry.width === 1000, JSON.stringify(geometry), await shot(main, 'popover-1000'), geometry)

  // Update: the download starts and stops half-way (held); a presenter window opens; then the rest arrives.
  await main.locator('[data-update-popover] [data-update-update]').click()
  const progress = await waitFor(async () => /^Downloading .* · \d+%$/.test(await markText(main)) && await markText(main))
  const known = new Set(app.windows())
  await main.keyboard.press('Escape')
  await main.locator('[data-command="present-presenter"]').first().click()
  const presenter = await waitFor(async () => app.windows().find((w) => !known.has(w) && !w.isClosed()) ?? null, 40000)
  await pause(1500)
  release()
  const waiting = await waitFor(async () => { const s = await snap(); return s.install.phase === 'waiting' ? s : null }, 30000)
  record('updates.downloads-on-click', !!progress && fileRequests.length === 1 && !!waiting, `mark while downloading "${progress}"; file requests ${fileRequests.length}; finished and checked: ${waiting ? 'yes' : 'no'}`, '', { fileRequests: fileRequests.length })
  const refused = await main.evaluate(() => window.tw.updates.restart())
  await pause(1000)
  const restarted = logs.join('').includes('restart into')
  record('updates.restart-waits', !!presenter && !!waiting && waiting.blockers.includes('presenting') && refused.install.phase === 'waiting' && !restarted,
    `presenter ${!!presenter}; blockers ${JSON.stringify(waiting?.blockers)}; after pressing Restart: ${refused.install.phase}; restarted ${restarted}`, '', { blockers: waiting?.blockers ?? null })

  for (const w of app.windows().filter((x) => !known.has(x) && !x.isClosed())) await w.close().catch(() => {})
  await main.bringToFront()
  const ready = await waitFor(async () => (await markText(main)) === 'Restart to finish updating', 20000)
  await main.locator('[data-update-mark]').click().catch(() => {})
  await main.waitForSelector('[data-update-popover] [data-update-restart]:not([disabled])', { timeout: 8000 }).catch(() => {})
  const readyShot = await shot(main, 'restart-ready')
  await main.locator('[data-update-popover] [data-update-restart]').click().catch(() => {})
  const logged = await waitFor(async () => logs.join('').includes(`restart into ${NEXT} (test run from source): not installed`), 10000)
  record('updates.restart-after', !!ready && !!logged, `mark "${ready ? 'Restart to finish updating' : await markText(main)}"; restart ${logged ? 'requested' : 'not requested'}`, readyShot)
} catch (e) {
  harness(String(e?.stack || e).slice(0, 900))
} finally {
  release()
  await closeApp(app)
  server.close()
}
