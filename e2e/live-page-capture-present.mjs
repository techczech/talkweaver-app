// The capture gallery in the real presenting path, hidden: TalkWeaver's own talk:present opens the
// presenter (and its Audience window) from a scratch vault; the slide's page (a loopback fixture that
// refuses framing, let through only by the test-only allowance) shows live; the presenter's Capture
// button saves the audience copy's visible view with the talk (assets/live-page-*.jpg + the record);
// Saved views hides both live views and shows the picture; the deck closed and presented again
// carries the saved view from disk; with the site gone, the presenter falls back to it by itself.
// Hidden: TW_E2E (show:false, backgroundThrottling:false), scratch user data, no real browser.
// Run: node e2e/live-page-capture-present.mjs   (LIVE_PAGE_EVIDENCE=<dir> copies the saved picture there)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const EVIDENCE = process.env.LIVE_PAGE_EVIDENCE || ''

const fixture = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/refused') { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' })
  res.end('<!doctype html><title>Fixture refused</title><body style="margin:0;font:40px system-ui"><div style="height:400px;background:#c33;color:#fff;padding:40px">TOP OF THE PAGE</div><div style="height:6000px;background:linear-gradient(#fff,#36c)">LONG</div></body>')
})
await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${fixture.address().port}`
const PAGE = `${ORIGIN}/refused`
const OUTLINE = `# Capture\n\n## Before {id=before}\n\n- A slide before the page\n\n## Refuses framing {layout=media id=page}\n\n[Embed: ${PAGE}]\n\n## After {id=after}\n\n- A slide after\n`

const CHECKS = [
  'the page shows live in the presenter and audience views',
  'Capture saves one picture and the record in the talk\'s assets folder, from the audience copy',
  'the record keeps the page address, capture time, viewport and scroll; the outline is unchanged',
  'Saved views: both live views hidden, the picture shown in both windows',
  'closed and presented again: the saved view comes from disk',
  'the site gone: the presenter falls back to the saved view by itself',
  'closing the deck windows closes every live view'
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-live-page-capture-'))
const vault = join(root, 'vault'), userData = join(root, 'userData'), talkDir = join(vault, 'capture')
const outlinePath = join(talkDir, 'capture-outline.md')
mkdirSync(talkDir, { recursive: true }); mkdirSync(userData, { recursive: true })
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

await ensureFreshBuild(REPO)
const env = { ...process.env, TW_E2E: '1', TW_E2E_LIVE_PAGE_ALLOW: `127.0.0.1:${fixture.address().port}` }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env })
const output = []
app.process().stdout?.on('data', (d) => output.push(String(d)))
app.process().stderr?.on('data', (d) => output.push(String(d)))
process.on('uncaughtException', (e) => { if (/No dialog is showing/.test(String(e?.message))) return; throw e })
let exitCode = 1
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 15000, step = 250) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await wait(step) } return v }
const views = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => (w.contentView.children || [])
  .filter((v) => v.webContents && !v.webContents.isDestroyed())
  .map((v) => ({ win: w.getTitle(), id: v.webContents.id, url: v.webContents.getURL(), bounds: v.getBounds(), visible: v.getVisible() }))))
const assets = () => (existsSync(join(talkDir, 'assets/live-page-captures')) ? readdirSync(join(talkDir, 'assets/live-page-captures')) : [])

const present = async (main) => {
  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: outlinePath, c: OUTLINE })
  if (!result?.success) throw new Error(`present failed: ${JSON.stringify(result)}`)
  const presenter = await opened
  await presenter.waitForLoadState('domcontentloaded')
  const audienceOpened = app.waitForEvent('window')
  await presenter.evaluate(() => document.getElementById('presenterAudienceApp')?.click())
  const audience = await audienceOpened
  await audience.waitForLoadState('domcontentloaded')
  await presenter.waitForTimeout(800)
  // Presented before: the deck offers to resume where it was; Resume (a person's click).
  if (await presenter.locator('#twResume:not([hidden])').count()) await presenter.locator('#twResumeYes').click()
  await presenter.evaluate(() => { location.hash = 'page' })
  return { presenter, audience }
}

try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)
  let { presenter, audience } = await present(main)
  const live = await waitFor(async () => { const vs = (await views()).filter((v) => v.url.startsWith(PAGE)); return vs.length === 2 && vs.every((v) => v.visible) ? vs : null }, 30000, 500)
  record(CHECKS[0], live, live ? live.map((v) => `${v.win.split(' —')[0]} ${v.bounds.width}×${v.bounds.height}`).join('; ') : JSON.stringify(await views()))
  if (!live) throw new Error('the live page did not show; nothing further can be checked')
  const audienceView = live.find((v) => /Audience/.test(v.win))
  await wait(600)

  // Capture: the presenter's own button, in its deck (c and g stay the Guide and Go live).
  await presenter.locator('#currentPreview .live-page-capture').click()
  // Each saved view is its own record beside its picture (assets/live-page-captures/).
  const records = () => assets().filter((n) => /^\d{8}T\d{9}Z-cap-[0-9a-f]{12}\.json$/.test(n))
  const saved = await waitFor(() => assets().some((n) => /^[0-9a-f]{16}\.jpg$/.test(n)) && records().length > 0, 15000, 250)
  const note = await presenter.evaluate(() => document.querySelector('#currentPreview .live-page-capture-note')?.textContent || '')
  const recs = saved ? records().map((n) => JSON.parse(readFileSync(join(talkDir, 'assets/live-page-captures', n), 'utf8'))) : []
  const rec = { pages: { [PAGE]: { captures: recs.filter((r) => r.pageUrl === PAGE).map((r) => r.capture) } } }
  const entry = rec.pages[PAGE].captures[0]
  const jpg = entry ? readFileSync(join(talkDir, entry.image)) : null
  record(CHECKS[1], saved && entry?.source === 'audience' && jpg?.[0] === 0xff && jpg?.[1] === 0xd8 && /Saved this view/.test(note) && rec.pages[PAGE].captures.length === 1,
    `files ${JSON.stringify(assets())}; source ${entry?.source}; ${entry?.width}×${entry?.height}px, ${jpg?.length} bytes; presenter note "${note}"`)
  record(CHECKS[2], entry && entry.capturedAt && entry.viewport?.w === audienceView.bounds.width && entry.viewport?.h === audienceView.bounds.height && typeof entry.scroll?.fy === 'number' && readFileSync(outlinePath, 'utf8') === OUTLINE,
    entry ? JSON.stringify({ capturedAt: entry.capturedAt, currentUrl: entry.currentUrl, viewport: entry.viewport, scroll: entry.scroll, slideId: entry.slideId }) : 'no entry')
  if (EVIDENCE && entry) { mkdirSync(EVIDENCE, { recursive: true }); copyFileSync(join(talkDir, entry.image), join(EVIDENCE, 'captured-view.jpg')); writeFileSync(join(EVIDENCE, 'captured-record.json'), JSON.stringify(rec, null, 2)) }

  // Saved views: the presenter's button; both views hidden; the picture in both slots.
  await presenter.locator('#currentPreview .live-page-gallery').click()
  const galleryOn = await waitFor(async () => {
    const vs = (await views()).filter((v) => v.url.startsWith(PAGE))
    const pImg = await presenter.evaluate(() => !!document.querySelector('#currentPreview .live-page-slot.live-page-gallery-on .live-page-saved img[src^="data:image/jpeg"]'))
    const aImg = await audience.evaluate(() => !!document.querySelector('.slide.active .live-page-slot.live-page-gallery-on .live-page-saved img[src^="data:image/jpeg"]'))
    return vs.length && vs.every((v) => !v.visible) && pImg && aImg ? { vs, pImg, aImg } : null
  }, 5000, 200)
  record(CHECKS[3], galleryOn, galleryOn ? `views visible: ${galleryOn.vs.map((v) => v.visible).join(',')}; presenter picture ${galleryOn.pImg}; audience picture ${galleryOn.aImg}` : JSON.stringify(await views()))
  await presenter.locator('#currentPreview .live-page-gallery').click()

  // Close the decks, present again: the compile carries the saved view from disk.
  await presenter.close(); await wait(800)
  ;({ presenter, audience } = await present(main))
  const reopened = await waitFor(async () => presenter.evaluate(() => {
    const btn = document.querySelector('#currentPreview .live-page-gallery')
    const fig = document.querySelector('figure.slide-embed.has-saved-views img[src^="data:image/jpeg"]')
    return btn && /Saved views \(1\)/.test(btn.textContent) && fig ? btn.textContent : null
  }), 15000, 300)
  record(CHECKS[4], reopened, reopened ? `presenter strip: "${reopened}"` : 'no saved view after reopening')

  // The site goes away: Reload → the page fails → the latest saved view is shown by itself.
  await new Promise((r) => { fixture.closeAllConnections?.(); fixture.close(() => r()) })
  await presenter.locator('#currentPreview .live-page-reload').click()
  const fallback = await waitFor(async () => presenter.evaluate(() => {
    const r = window.__twLivePageSlot()
    const img = document.querySelector('#currentPreview .live-page-slot.live-page-gallery-on .live-page-saved img')
    return r && r.gallery.on && !r.visible && img ? document.querySelector('#currentPreview .live-page-saved-caption')?.textContent : null
  }), 20000, 300)
  record(CHECKS[5], fallback, fallback ? `"${fallback}"` : `slot ${JSON.stringify(await presenter.evaluate(() => window.__twLivePageSlot()))}`)

  await presenter.close(); await wait(1000)
  const left = await views()
  record(CHECKS[6], left.length === 0, `${left.length} views left`)
  exitCode = ledger.summary('LIVE PAGE CAPTURE E2E').exitCode
} catch (e) {
  console.error('[e2e] live page capture:', e)
  ledger.summary('LIVE PAGE CAPTURE E2E')
} finally {
  if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); writeFileSync(join(EVIDENCE, 'live-page-capture-app-output.log'), output.join('').split('\n').filter((l) => /live-page|capture/i.test(l)).join('\n') + '\n') }
  await app.close().catch(() => {})
  try { fixture.close() } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true })
  process.exit(exitCode)
}
