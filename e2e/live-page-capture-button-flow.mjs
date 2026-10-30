// The Capture button in the real presenter, hidden, the way a talk is usually written: the slide's
// page address is a bare site address (`[Embed: https://site]`, no path, no trailing slash, as the
// Radio Times slide), the presenter alone (no Audience window), the page scrolled, Interact on, then
// the presenter's own Capture button. Owner bug 2026-10-27 (alpha.14): every press answered "The slide
// or page changed while capturing". Also checks that a real reload during the capture still drops it.
// Hidden: TW_E2E (show:false, backgroundThrottling:false), scratch vault and user data, loopback
// fixture let through only by the test-only allowance; no real browser, no real talk.
// Run: node e2e/live-page-capture-button-flow.mjs   (LIVE_PAGE_TRACE=1 prints main's capture log lines)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
let slow = 0
const fixture = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path !== '/') { res.writeHead(404); res.end(); return }
  const send = () => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' })
    res.end('<!doctype html><title>Fixture site</title><body style="margin:0;font:40px system-ui"><div style="height:400px;background:#c33;color:#fff;padding:40px">TOP</div><button id="b">Play</button><div style="height:6000px;background:linear-gradient(#fff,#36c)">LONG</div></body>')
  }
  if (slow) setTimeout(send, slow); else send()
})
await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
const SITE = `http://127.0.0.1:${fixture.address().port}` // written as on the Radio Times slide: no slash
const OUTLINE = `# Capture\n\n## Before {id=before}\n\n- A slide before the page\n\n## Created from 340 hours of audio files {layout=media id=page}\n\n[Embed: ${SITE}]\n`

const CHECKS = [
  'the bare-address page shows live in the presenter',
  'scrolled, Interact on, Capture button: the view is saved (picture + record) and the presenter says so',
  'a reload of the page during the capture still drops it'
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-live-page-button-'))
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
let exitCode = 1
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 15000, step = 250) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await wait(step) } return v }
const views = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => (w.contentView.children || [])
  .filter((v) => v.webContents && !v.webContents.isDestroyed())
  .map((v) => ({ win: w.getTitle(), id: v.webContents.id, url: v.webContents.getURL(), visible: v.getVisible() }))))
const folder = join(talkDir, 'assets/live-page-captures')
const records = () => (existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith('.json')) : [])
const note = (p) => p.evaluate(() => document.querySelector('#currentPreview .live-page-capture-note')?.textContent || '')

try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)
  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: outlinePath, c: OUTLINE })
  if (!result?.success) throw new Error(`present failed: ${JSON.stringify(result)}`)
  const presenter = await opened
  await presenter.waitForLoadState('domcontentloaded')
  await presenter.waitForTimeout(800)
  if (await presenter.locator('#twResume:not([hidden])').count()) await presenter.locator('#twResumeYes').click()
  await presenter.evaluate(() => { location.hash = 'page' })
  const live = await waitFor(async () => { const vs = (await views()).filter((v) => v.url.startsWith(SITE)); return vs.length === 1 && vs[0].visible ? vs : null }, 30000, 500)
  record(CHECKS[0], live, JSON.stringify(live || await views()))
  if (!live) throw new Error('the live page did not show')
  const id = live[0].id
  // Scroll the page as a person would, then Interact on (the presenter's own button).
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.scrollTo(0, 1500)'), id)
  await wait(600)
  await presenter.locator('#currentPreview .live-page-interact').click()
  await wait(400)
  await presenter.locator('#currentPreview .live-page-capture').click()
  const saved = await waitFor(async () => records().length === 1 && /Saved this view/.test(await note(presenter)), 10000, 250)
  const said = await note(presenter)
  record(CHECKS[1], saved, `records ${JSON.stringify(records())}; presenter note "${said}"${saved ? `; ${readFileSync(join(folder, records()[0]), 'utf8').trim().slice(0, 240)}` : ''}`)
  // Stale protection kept: the page reloads (same address) while the picture is being taken.
  slow = 1500
  await presenter.locator('#currentPreview .live-page-capture').click()
  await app.evaluate(({ webContents }, id) => { webContents.fromId(id).reload() }, id)
  await waitFor(async () => /changed while capturing|Saved this view/.test(await note(presenter)) && !/Capturing/.test(await note(presenter)), 10000, 100)
  await wait(500)
  const after = await note(presenter)
  record(CHECKS[2], records().length === 1 && /changed while capturing/.test(after), `records ${records().length}; presenter note "${after}"`)
  slow = 0
} catch (error) {
  console.error(error)
} finally {
  exitCode = ledger.summary('live page capture button flow').exitCode
  if (process.env.LIVE_PAGE_TRACE) console.log(output.join('').split('\n').filter((l) => /live-page/.test(l)).join('\n'))
  await app.close().catch(() => {})
  await new Promise((r) => { fixture.closeAllConnections?.(); fixture.close(() => r()) })
  rmSync(root, { recursive: true, force: true })
  process.exit(exitCode)
}
