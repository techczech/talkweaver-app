// Capture embed… in the real built app, hidden: the inspector shows a slide's web page with "No saved
// views", its button opens the capture window (an app page, no preload) with the page live in it,
// Entire page + Capture saves the whole page and its {capture} line lands under the slide's embed in
// the open editor (typing not yet saved kept), and the inspector and the window then count it.
// The slide has no {id=…} of its own (the compiler derives its id from the heading).
// Hidden: TW_E2E (show:false, backgroundThrottling:false), scratch vault and user data, a loopback
// fixture let through only by the test-only allowance; no real browser, no real talk.
// Run: node e2e/live-page-capture-embed-window.mjs   (LIVE_PAGE_TRACE=1 prints main's capture log lines)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const fixture = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/') { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' })
  res.end('<!doctype html><title>Fixture site</title><body style="margin:0;font:40px system-ui"><div style="height:400px;background:#c33;color:#fff;padding:40px">TOP</div><div style="height:3000px;background:linear-gradient(#fff,#36c)">LONG</div></body>')
})
await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
const SITE = `http://127.0.0.1:${fixture.address().port}`
const OUTLINE = `---\noutline_version: 2\ntitle: Capture embed\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Before\n\nBefore body.\n\n### Radio page {layout=media}\n\n[Embed: ${SITE}]\n\n### After\n\nAfter body.\n`

const CHECKS = [
  'the inspector shows the slide\'s web page with an explicit "No saved views"',
  'Capture embed… opens the capture window with the page live in it',
  'Entire page + Capture: the whole page saved and the window says it was added to the slide',
  'the {capture} line is under the embed in the open editor, unsaved typing kept, and the inspector and the window count 1'
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-capture-embed-')))
const vault = join(root, 'vault'), userData = join(root, 'userData'), talkDir = join(vault, 'capture')
const outlinePath = join(talkDir, 'capture-outline.md')
mkdirSync(talkDir, { recursive: true }); mkdirSync(userData, { recursive: true })
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }, null, 2), 'utf8')

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

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.locator('.tl-row').first().dblclick()
  await page.locator('.cm-content').waitFor()
  await page.waitForTimeout(2500)
  await page.keyboard.press('Meta+p') // Inspector
  await page.waitForTimeout(1200)
  // Typing not yet saved, on another slide: it must survive the capture's edit.
  await page.locator('.cm-line', { hasText: 'Before body.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' TYPED-NOT-SAVED')
  await page.locator('.cm-line', { hasText: SITE }).click()
  const count = () => page.locator('.tw-inspector-web-page-count').first().textContent().catch(() => '')
  const empty = await waitFor(async () => (await count()) === 'No saved views', 15000)
  record(CHECKS[0], empty, `count "${await count()}"; host "${await page.locator('.tw-inspector-web-page-host').first().textContent().catch(() => '')}"`)

  const opened = app.waitForEvent('window')
  await page.locator('[data-capture-embed]').first().click()
  const win = await opened
  await win.waitForLoadState('domcontentloaded')
  const live = await waitFor(async () => { const vs = (await views()).filter((v) => v.url.startsWith(SITE) && /Capture embed/.test(v.win)); return vs.length === 1 && vs[0].visible ? vs : null }, 30000, 500)
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()))
  record(CHECKS[1], live && hidden && /capture-embed\.html/.test(win.url()), `${JSON.stringify(live || await views())}; hidden ${hidden}; ${win.url().replace(REPO, '')}`)
  if (!live) throw new Error('the live page did not show in the capture window')
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.scrollTo(0, 900)'), live[0].id)
  await wait(500)
  await win.getByRole('radio', { name: 'Entire page' }).click()
  await waitFor(async () => !(await win.locator('.ce-capture').isDisabled()), 10000)
  await win.locator('.ce-capture').click()
  const status = () => win.locator('.ce-status').textContent().catch(() => '')
  const saved = await waitFor(async () => records().length === 1 && /Saved the entire page/.test(await status()), 20000)
  const entry = records().length ? JSON.parse(readFileSync(join(folder, records()[0]), 'utf8')) : null
  record(CHECKS[2], saved && /added it to the slide/.test(await status()) && JSON.stringify(entry).includes('"mode":"page"'), `status "${await status()}"; record ${JSON.stringify(entry)?.slice(0, 300)}`)

  const editorText = () => page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'))
  // The editor draws the image line as its words (markdown view); the saved file has the markup.
  const placedLine = new RegExp(`\\[Embed: ${SITE.replace(/[.]/g, '\\.')}\\]\\n!\\[Entire page, [^\\]]+\\]\\(assets/live-page-captures/[0-9a-f]{16}\\.jpg\\)\\{capture\\}\\n`)
  const placed = await waitFor(async () => placedLine.test(await editorText().then(() => readFileSync(outlinePath, 'utf8'))) && /\[Embed: [^\]]+\]\nEntire page, /.test(await editorText()), 15000)
  const text = await editorText()
  const disk = readFileSync(outlinePath, 'utf8')
  const one = await waitFor(async () => (await count()) === '1 saved view', 10000)
  const listed = await win.locator('.ce-item').count()
  record(CHECKS[3], placed && text.includes('Before body. TYPED-NOT-SAVED') && disk.includes('Before body. TYPED-NOT-SAVED') && (disk.match(/\{capture\}/g) ?? []).length === 1 && one && listed === 1,
    `saved ${JSON.stringify(disk.slice(disk.indexOf('### Radio'), disk.indexOf('### After')))}; typing kept ${text.includes('TYPED-NOT-SAVED')}/${disk.includes('TYPED-NOT-SAVED')}; inspector "${await count()}"; window list ${listed}`)
  await win.locator('.ce-quiet', { hasText: 'Close' }).click()
} catch (error) {
  console.error(error)
} finally {
  exitCode = ledger.summary('live page capture embed window').exitCode
  if (process.env.LIVE_PAGE_TRACE) console.log(output.join('').split('\n').filter((l) => /live-page|capture/i.test(l)).join('\n'))
  await app.close().catch(() => {})
  await new Promise((r) => { fixture.closeAllConnections?.(); fixture.close(() => r()) })
  rmSync(root, { recursive: true, force: true })
  process.exit(exitCode)
}
