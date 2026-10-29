// A page that refuses to be framed (X-Frame-Options, CSP frame-ancestors) stays refused in the REAL app,
// and the embeds that never needed a header rewrite still work. Review finding (2026-10-27): a session
// hook deleted both headers from every sub-frame response, for every site. Windows are hidden (TW_E2E).
//   1. own server, Electron's own enforcement: a page served here with DENY, SAMEORIGIN, frame-ancestors
//      'none' or another host is refused in a frame; the same page with no header loads. A fresh
//      in-memory session of the running app, because the app's own session never lets an embedded
//      frame reach a local address (local-address-filter.ts), by design.
//   2. the app's own session: the same headers, set per request on a public echo service
//      (httpbin.org/response-headers), are refused in a hidden window of the default session; the
//      control loads. Needs the network: a control that does not load is reported, never passed.
//   3. presenting (talk:present, presenter + audience): a local page shows its own text, a YouTube
//      address plays from the player's origin, a refusing page shows the refusal, and the audience
//      slide keeps its "Open <host> ↗" link to the address as written.
// Run: node e2e/check-remote-page-framing.mjs   (REFUSING_PAGE_URL=https://… for a real refusing site on the slide)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const ECHO = 'https://httpbin.org/response-headers'
const REFUSING = {
  deny: { 'X-Frame-Options': 'DENY' },
  sameorigin: { 'X-Frame-Options': 'SAMEORIGIN' },
  none: { 'Content-Security-Policy': "frame-ancestors 'none'" },
  otherhost: { 'Content-Security-Policy': 'frame-ancestors https://other.example' },
}
const echoUrl = (headers) => `${ECHO}?${new URLSearchParams({ ...headers, 'X-Tw-Check': 'framing' })}`
// REFUSING_PAGE_URL: present a real site that refuses framing instead (the slide part only).
const DENY_PAGE = process.env.REFUSING_PAGE_URL || echoUrl(REFUSING.deny)
const DENY_ORIGIN = new URL(DENY_PAGE).origin
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const LOCAL_MARKER = 'LOCAL-PAGE-MARKER-7f3a'

const CHECKS = [
  'own server: each refusing header is refused in a frame (Electron enforces it)',
  'own server: the same page with no header loads in a frame',
  "app session: each refusing header is refused in a frame (nothing rewrites it)",
  'app session: the control page with no header loads in a frame',
  'present: a local page on a slide shows its own text',
  'present: a YouTube address plays from the player origin',
  'present: a refusing page shows the refusal in the pane and on the audience slide',
  'present: the audience slide keeps the Open link to the address as written',
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

// Own server: the outer page on one port, the framed pages on another (a different origin).
const framed = createServer((req, res) => {
  const which = new URL(req.url, 'http://x').pathname.slice(1)
  for (const [name, value] of Object.entries(REFUSING[which] ?? {})) res.setHeader(name, value)
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><title>${which}</title><body>FRAMED-${which}</body>`)
})
await new Promise((done) => framed.listen(0, '127.0.0.1', done))
const FRAMED = `http://127.0.0.1:${framed.address().port}`
const outerHtml = (frames) => `<!doctype html><title>outer</title>${frames.map(([name, src]) => `<iframe name="${name}" src="${src}"></iframe>`).join('')}`
const outer = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(outerHtml([...Object.keys(REFUSING), 'control'].map((name) => [name, `${FRAMED}/${name}`])))
})
await new Promise((done) => outer.listen(0, '127.0.0.1', done))
const OUTER = `http://127.0.0.1:${outer.address().port}/outer`

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-framing-'))
const vault = join(root, 'vault'), userData = join(root, 'userData'), talkDir = join(vault, 'framing')
const outlinePath = join(talkDir, 'framing-outline.md')
const OUTLINE = `# Framing\n\n## Local {layout=media id=local}\n\n[Embed: page.html]\n\n## Video {layout=media id=video}\n\n[Embed: ${VIDEO}]\n\n## Refusing {layout=media id=refusing}\n\n[Embed: ${DENY_PAGE}]\n\n## After {id=after}\n\n- After\n`
mkdirSync(talkDir, { recursive: true }); mkdirSync(userData, { recursive: true })
writeFileSync(join(talkDir, 'page.html'), `<!doctype html><title>Local</title><body><p>${LOCAL_MARKER}</p></body>`, 'utf8')
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

await ensureFreshBuild(REPO)
// An agent shell may carry ELECTRON_RUN_AS_NODE; Electron must not inherit it, or it starts as Node.
const env = { ...process.env, TW_E2E: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env })
let exitCode = 1
// What each named frame of a hidden window holds after it settles: its URL and the start of its text.
const framesOf = (url, partition) => app.evaluate(async ({ BrowserWindow, session }, { url, partition }) => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, ...(partition ? { session: session.fromPartition(partition) } : {}) } })
  try {
    await win.loadURL(url).catch(() => {})
    await new Promise((done) => setTimeout(done, 6000))
    const out = {}
    for (const frame of win.webContents.mainFrame.frames) {
      let text = null
      try { text = await frame.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : ""') } catch { /* an error page may refuse */ }
      out[frame.name] = { url: frame.url, text }
    }
    return out
  } finally { win.destroy() }
}, { url, partition })
const refused = (f) => !f || f.url.startsWith('chrome-error:') || !f.text || !/FRAMED-|X-Tw-Check/.test(f.text)
const loadedFrame = (f, marker) => !!f && !f.url.startsWith('chrome-error:') && typeof f.text === 'string' && f.text.includes(marker)
try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)

  const own = await framesOf(OUTER, `tw-framing-check-${process.pid}`)
  const ownRefused = Object.keys(REFUSING).filter((name) => refused(own[name]))
  record(CHECKS[0], ownRefused.length === Object.keys(REFUSING).length, `refused: ${ownRefused.join(', ') || 'none'}; ${JSON.stringify(own)}`)
  record(CHECKS[1], loadedFrame(own.control, 'FRAMED-control'), JSON.stringify(own.control))

  const echoFrames = [...Object.entries(REFUSING).map(([name, headers]) => [name, echoUrl(headers)]), ['control', echoUrl({ 'X-Tw-Control': '1' })]]
  const app1 = await framesOf(`data:text/html;charset=utf-8,${encodeURIComponent(outerHtml(echoFrames))}`)
  const controlLoaded = loadedFrame(app1.control, 'X-Tw-Check')
  const appRefused = Object.keys(REFUSING).filter((name) => refused(app1[name]))
  record(CHECKS[3], controlLoaded, controlLoaded ? 'the echo service answered in a frame' : `not checked: the echo service did not load (${JSON.stringify(app1.control)})`)
  record(CHECKS[2], controlLoaded && appRefused.length === Object.keys(REFUSING).length, controlLoaded ? `refused: ${appRefused.join(', ') || 'none'}; loaded: ${Object.keys(REFUSING).filter((n) => !refused(app1[n])).join(', ') || 'none'}` : 'not checked: no network')

  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: outlinePath, c: OUTLINE })
  if (!result?.success) throw new Error(`present failed: ${JSON.stringify(result)}`)
  const presenter = await opened
  await presenter.waitForLoadState('domcontentloaded')
  const audienceOpened = app.waitForEvent('window')
  await presenter.evaluate(() => document.getElementById('presenterAudienceApp')?.click())
  const audience = await audienceOpened
  await audience.waitForLoadState('domcontentloaded')
  await presenter.waitForTimeout(1200)
  const PANE = '#currentPreview iframe.live-sim-frame'
  const SLIDE_FRAME = '.slide.active figure.slide-embed iframe'
  // Every frame of a window: its address and the start of its text (null when it will not answer).
  const allFrames = async (page) => Promise.all(page.frames().slice(1).map(async (f) => ({ url: f.url(), text: await f.evaluate(() => document.body?.innerText.slice(0, 300) ?? '').catch(() => null) })))
  const until = async (page, ok, tries = 30) => {
    let frames = []
    for (let i = 0; i < tries; i++) { frames = await allFrames(page); if (ok(frames)) return { ok: true, frames }; await page.waitForTimeout(500) }
    return { ok: false, frames }
  }
  const show = async (id) => { await presenter.evaluate((id) => { location.hash = id }, id); await presenter.waitForTimeout(2500) }
  const hasText = (marker) => (frames) => frames.some((f) => (f.text ?? '').includes(marker))

  await show('local')
  const local = await until(presenter, hasText(LOCAL_MARKER))
  const localAudience = await until(audience, hasText(LOCAL_MARKER))
  record(CHECKS[4], local.ok && localAudience.ok, local.ok && localAudience.ok ? 'the page text is in a frame of the presenter and of the audience window' : `presenter ${JSON.stringify(local.frames)}; audience ${JSON.stringify(localAudience.frames)}`)

  await show('video')
  const video = await until(audience, (frames) => frames.some((f) => f.url.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ') && (f.text ?? '').length > 0))
  record(CHECKS[5], video.ok, JSON.stringify(video.frames.filter((f) => f.url.includes('youtube'))))

  await show('refusing')
  // The frame is on the slide at the page's address, and after 8 s neither window holds the page's
  // text (with the old header rewrite both did, at this point: the red run in the evidence).
  const placed = async (page, sel) => page.$$eval(sel, (all, url) => all.some((f) => (f.getAttribute('src') ?? f.getAttribute('data-src')) === url), DENY_PAGE).catch(() => false)
  await presenter.waitForTimeout(8000)
  const paneFrames = await allFrames(presenter), slideFrames = await allFrames(audience)
  const shown = (frames) => frames.some((f) => f.url.startsWith(DENY_ORIGIN) && (f.text ?? '').trim().length > 0)
  const panePlaced = await placed(presenter, '#currentPreview iframe.live-sim-frame'), slidePlaced = await placed(audience, '.slide.active figure.slide-embed iframe')
  record(CHECKS[6], controlLoaded && panePlaced && slidePlaced && !shown(paneFrames) && !shown(slideFrames), controlLoaded ? `frame placed: pane ${panePlaced}, audience ${slidePlaced}; page text shown: pane ${shown(paneFrames)}, audience ${shown(slideFrames)}; frames at the page: ${JSON.stringify([...paneFrames, ...slideFrames].filter((f) => f.url.startsWith(DENY_ORIGIN) || f.url.startsWith('chrome-error') || f.url === '' ))}` : 'not checked: no network')
  const link = await audience.$eval('.slide.active .embed-open-link', (a) => ({ href: a.getAttribute('href'), text: a.textContent, target: a.target, visible: a.getBoundingClientRect().width > 0 && getComputedStyle(a).visibility !== 'hidden' })).catch(() => null)
  record(CHECKS[7], link?.href === DENY_PAGE && link.target === '_blank' && link.visible && link.text === `Open ${new URL(DENY_PAGE).hostname.replace(/^www\./, '')} ↗`, JSON.stringify(link))
  await audience.screenshot({ path: join(root, 'audience-refusing.png') }).catch(() => {})
  exitCode = ledger.summary('REMOTE PAGE FRAMING E2E').exitCode
} catch (error) {
  console.error(error.message)
  ledger.summary('REMOTE PAGE FRAMING E2E')
} finally {
  await app.close().catch(() => {})
  framed.close(); outer.close()
  rmSync(root, { recursive: true, force: true })
}
process.exit(exitCode)
