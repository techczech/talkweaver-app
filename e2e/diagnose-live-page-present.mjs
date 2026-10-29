// A web page on a slide, presented LIVE in the real presenting path (src/main/live-page-host.ts):
// TalkWeaver's own talk:present opens the presenter window from a scratch vault, its Audience button
// opens the audience window, and each shows the slide's page as the top-level document of its own
// view. Hidden: TW_E2E (show:false, backgroundThrottling:false), scratch user data, no real browser.
//
// The pages come from a fixture server on 127.0.0.1, let through ONLY by the test-only allowance
// (TW_E2E_LIVE_PAGE_ALLOW, honoured when the app is not packaged and runs under TW_E2E):
//   - /refused: refuses framing (frame-ancestors 'none' + X-Frame-Options: DENY), long, with a link;
//   - /hostile: tries pop-ups, top navigation to file:, chrome:, twasset:, mailto:, local fetches,
//     a download, dialogs, beforeunload, and every permission;
//   - /redirect-local, /redirect-private: 302 to localhost and to 192.168.1.1.
// A second loopback server (not allowed) counts any request that reaches it: there must be none.
// With LIVE_PAGE_SITES=1 the reported real sites are also presented (network): Radio Times, Audio
// Archive, and the Language Log post as the framable control. A site that does not load is reported
// as not loaded, never as a pass.
// Run: node e2e/diagnose-live-page-present.mjs   (LIVE_PAGE_SITES=1 for the real sites)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const EVIDENCE = process.env.LIVE_PAGE_EVIDENCE || ''
const SITES = process.env.LIVE_PAGE_SITES === '1'
const REAL = [
  { id: 'rt', url: 'https://example.org' },
  { id: 'aa', url: 'https://audioarchive.semanticmachines.fyi' },
  { id: 'll', url: 'https://languagelog.ldc.upenn.edu/nll/?p=60956' }
]

// --- fixture servers ------------------------------------------------------------------------------
let strayHits = 0
const stray = createServer((req, res) => { strayHits++; res.end('stray') })
const sent = {}
const fixture = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/refused' || path === '/second') {
    const headers = { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }
    sent[path] = headers
    res.writeHead(200, headers)
    res.end(`<!doctype html><title>${path === '/refused' ? 'Fixture refused' : 'Fixture second'}</title><body style="margin:0;font:20px system-ui"><a id="next" href="/second" style="display:block;padding:40px">Second page</a><div style="height:6000px;background:linear-gradient(#fff,#36c)">LONG</div></body>`)
    return
  }
  if (path === '/hostile') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>Fixture hostile</title><body style="height:3000px">
<a id="mail" href="mailto:a@example.com">mail</a><a id="asset" href="twasset://img-1/x.png">asset</a><a id="dl" href="/download" download>dl</a>
<script>
window.__attack = async (strayPort) => {
  const out = {};
  const settle = async (name, fn) => { try { out[name] = String(await fn()) } catch (e) { out[name] = 'refused: ' + (e && e.name || e) } };
  out.typeofRequire = typeof require; out.typeofProcess = typeof process; out.typeofTw = typeof window.tw; out.typeofElectron = typeof window.electron;
  out.popup = String(window.open('https://example.com/', '_blank'));
  await settle('notification', () => Notification.requestPermission());
  await settle('geolocation', () => new Promise((ok, no) => navigator.geolocation.getCurrentPosition(() => ok('granted'), (e) => no(new Error('denied ' + e.code)), { timeout: 3000 })));
  await settle('getUserMedia', () => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted'));
  await settle('displayMedia', () => navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'granted'));
  await settle('clipboard', () => navigator.clipboard.readText().then(() => 'granted'));
  await settle('fullscreen', () => document.documentElement.requestFullscreen().then(() => 'granted'));
  await settle('fetchLoopback', () => fetch('http://127.0.0.1:' + strayPort + '/x').then((r) => 'reached ' + r.status));
  await settle('fetchLocalhost', () => fetch('http://localhost:' + strayPort + '/x').then((r) => 'reached ' + r.status));
  await settle('fetchNameToLoopback', () => fetch('http://localtest.me:' + strayPort + '/x').then((r) => 'reached ' + r.status));
  await settle('fetchPrivate', () => fetch('http://192.168.1.1/', { signal: AbortSignal.timeout(4000) }).then((r) => 'reached ' + r.status));
  await settle('imgLoopback', () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok('loaded'); i.onerror = () => no(new Error('error')); i.src = 'http://127.0.0.1:' + strayPort + '/p.png' }));
  await settle('websocketLoopback', () => new Promise((ok, no) => { const w = new WebSocket('ws://127.0.0.1:' + strayPort + '/'); w.onopen = () => ok('open'); w.onerror = () => no(new Error('error')) }));
  return out;
};
</script></body>`)
    return
  }
  if (path === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }); res.end('x'); return }
  if (path === '/redirect-local') { res.writeHead(302, { location: `http://localhost:${stray.address().port}/` }); res.end(); return }
  if (path === '/redirect-private') { res.writeHead(302, { location: 'http://192.168.1.1/' }); res.end(); return }
  res.writeHead(404); res.end()
})
await new Promise((r) => stray.listen(0, '127.0.0.1', r))
await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${fixture.address().port}`
const STRAY = stray.address().port

const slide = (id, title, url) => `## ${title} {layout=media id=${id}}\n\n[Embed: ${url}]\n\n`
const OUTLINE = `# Live page\n\n## Before {id=before}\n\n- A slide before the page\n\n${slide('page', 'Refuses framing', `${ORIGIN}/refused`)}## After {id=after}\n\n- A slide after the page\n\n${slide('hostile', 'Hostile', `${ORIGIN}/hostile`)}${slide('redir1', 'Redirect local', `${ORIGIN}/redirect-local`)}${slide('redir2', 'Redirect private', `${ORIGIN}/redirect-private`)}${SITES ? REAL.map((s) => slide(s.id, s.id, s.url)).join('') : ''}## End {id=end}\n\n- The end\n`

const CHECKS = [
  'presenter: the refused-framing page shows live in its own view',
  'audience: its own view shows the same page',
  'the page keeps its framing refusal (headers as sent) and has no app bridge',
  'the views are isolated: separate sessions, not the app\'s',
  'view bounds equal the slot (× deck zoom) within 1 px',
  'presenter view laid out at the audience width (zoom) and muted; audience not muted',
  'presenter scroll → audience scroll within 0.02',
  'a link followed in the presenter view is followed by the audience view',
  'without Interact, keys sent to the view never reach the page; ArrowRight on the deck advances',
  'e: keys reach the page; Esc in the view ends Interact and keys stop reaching the page',
  'the audience view never keeps keyboard focus',
  'leaving the slide closes both views',
  'hostile page: no pop-up, dialogs disabled, every permission refused',
  'hostile page: no request reached a local address',
  'hostile page: file:, chrome:, twasset:, mailto: navigations refused; nothing handed to the OS',
  'hostile page: download refused',
  'hostile page: beforeunload does not hold the slide',
  'redirects to localhost and 192.168.1.1 are refused and shown as blocked',
  'covered by the command palette, the view hides; uncovered, it shows',
  'closing the deck windows closes every live view',
  ...(SITES ? REAL.flatMap((s) => [`${s.url}: shows live in presenter and audience`, `${s.url}: audience follows presenter scroll`]) : [])
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-live-page-'))
const vault = join(root, 'vault'), userData = join(root, 'userData'), talkDir = join(vault, 'live-page')
const outlinePath = join(talkDir, 'live-page-outline.md')
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
// Playwright attaches to every webContents, the live views included, and tries to dismiss a dialog
// the view never shows (dialogs are disabled there): that one harness error is logged, not fatal.
process.on('uncaughtException', (e) => { if (/No dialog is showing/.test(String(e?.message))) { output.push('[harness] ' + e.message + '\n'); return } throw e })

// Main-process views: every WebContentsView child of every window.
const views = (prefix = '') => app.evaluate(({ BrowserWindow, session }, prefix) => BrowserWindow.getAllWindows().flatMap((w) => (w.contentView.children || [])
  .filter((v) => v.webContents && !v.webContents.isDestroyed() && v.webContents.getURL().startsWith(prefix))
  .map((v) => ({ win: w.getTitle(), winId: w.webContents.id, id: v.webContents.id, url: v.webContents.getURL(), bounds: v.getBounds(), visible: v.getVisible(), zoom: v.webContents.getZoomFactor(), focused: v.webContents.isFocused(), muted: v.webContents.isAudioMuted(), defaultSession: v.webContents.session === session.defaultSession, ua: v.webContents.getUserAgent() }))), prefix)
const inView = (id, code, gesture = false) => app.evaluate(({ webContents }, { id, code, gesture }) => webContents.fromId(id).executeJavaScript(code, gesture), { id, code, gesture })
const waitFor = async (fn, ms = 15000, step = 250) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await wait(step) } return v }
const roleOf = (v) => (/Presenter/.test(v.win) ? 'presenter' : /Audience/.test(v.win) ? 'audience' : 'other')
const pair = async (prefix) => { const vs = await views(prefix); return { p: vs.find((v) => roleOf(v) === 'presenter'), a: vs.find((v) => roleOf(v) === 'audience') } }
const loadedPair = (prefix) => waitFor(async () => {
  const { p, a } = await pair(prefix)
  if (!p || !a || !p.visible || !a.visible) return null
  const ok = async (v) => inView(v.id, '({ t: document.title, ready: document.readyState, max: (document.scrollingElement || document.documentElement).scrollHeight - innerHeight })').catch(() => null)
  const [ps, as] = [await ok(p), await ok(a)]
  return ps?.ready === 'complete' && as?.ready === 'complete' ? { p, a, ps, as } : null
}, 30000, 500)
const scrollOf = (id) => inView(id, '(() => { const s = document.scrollingElement || document.documentElement; return { y: scrollY, max: s.scrollHeight - innerHeight } })()')

try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)
  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: outlinePath, c: OUTLINE })
  if (!result?.success) throw new Error(`present failed: ${JSON.stringify(result)}`)
  const presenter = await opened
  await presenter.waitForLoadState('domcontentloaded')
  if (!(await presenter.evaluate(() => location.search.includes('livepage=1')))) console.log('note: the presenter was not opened with livepage=1 (a build without the live page)')
  const audienceOpened = app.waitForEvent('window')
  await presenter.evaluate(() => document.getElementById('presenterAudienceApp')?.click())
  const audience = await audienceOpened
  await audience.waitForLoadState('domcontentloaded')
  await presenter.waitForTimeout(1000)
  const windowsBefore = (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))

  // 1–4: the refused-framing page, live in both windows.
  await presenter.evaluate(() => { location.hash = 'page' })
  const live = await loadedPair(`${ORIGIN}/refused`)
  record(CHECKS[0], live?.ps?.t === 'Fixture refused', live ? `presenter view "${live.ps.t}", ${live.ps.max}px to scroll` : JSON.stringify(await views()))
  record(CHECKS[1], live?.as?.t === 'Fixture refused', live ? `audience view "${live.as.t}"` : 'no audience view')
  if (!live) throw new Error('the live page did not show; nothing further can be checked')
  const { p, a } = live
  const headers = await inView(p.id, `fetch(location.href).then((r) => ({ csp: r.headers.get('content-security-policy'), xfo: r.headers.get('x-frame-options') }))`)
  const bridge = await inView(p.id, '({ r: typeof require, p: typeof process, tw: typeof window.tw, e: typeof window.electron })')
  record(CHECKS[2], headers.csp === "frame-ancestors 'none'" && headers.xfo === 'DENY' && Object.values(bridge).every((t) => t === 'undefined'), `${JSON.stringify(headers)} ${JSON.stringify(bridge)}`)
  record(CHECKS[3], !p.defaultSession && !a.defaultSession && !/Electron\//.test(p.ua) && (await app.evaluate(({ webContents }, ids) => webContents.fromId(ids[0]).session !== webContents.fromId(ids[1]).session, [p.id, a.id])), `default session: ${p.defaultSession}/${a.defaultSession}; UA ${p.ua.slice(0, 60)}…`)
  const pSlot = await presenter.evaluate(() => window.__twLivePageSlot())
  const aSlot = await audience.evaluate(() => window.__twLivePageSlot())
  const pz = await presenter.evaluate(() => 1) // deck zoom factor: main uses webContents zoom, 1 here
  const close = (b, r) => Math.abs(b.x - r.x * pz) <= 1 && Math.abs(b.y - r.y * pz) <= 1 && Math.abs(b.width - r.w * pz) <= 1 && Math.abs(b.height - r.h * pz) <= 1
  record(CHECKS[4], close(p.bounds, pSlot.rect) && close(a.bounds, aSlot.rect), `presenter ${JSON.stringify(p.bounds)} vs ${JSON.stringify(pSlot.rect)}; audience ${JSON.stringify(a.bounds)} vs ${JSON.stringify(aSlot.rect)}`)
  const expectZoom = Math.min(1, Math.max(0.25, p.bounds.width / a.bounds.width))
  record(CHECKS[5], Math.abs(p.zoom - expectZoom) < 0.01 && p.muted && !a.muted, `presenter zoom ${p.zoom.toFixed(3)} (expected ${expectZoom.toFixed(3)}), muted ${p.muted}; audience zoom ${a.zoom}, muted ${a.muted}`)

  // 7: scroll following, with a real wheel on the presenter view (no Interact needed for the wheel).
  await app.evaluate(({ webContents }, { id, x, y }) => { const wc = webContents.fromId(id); for (let i = 0; i < 6; i++) wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -400 }) }, { id: p.id, x: Math.round(p.bounds.width / 2), y: Math.round(p.bounds.height / 2) })
  await wait(400)
  let ps = await scrollOf(p.id)
  if (!(ps.y > 0)) { await inView(p.id, 'scrollTo(0, 0.4 * (document.scrollingElement.scrollHeight - innerHeight))'); ps = await scrollOf(p.id) }
  const followed = await waitFor(async () => { const as = await scrollOf(a.id); return as.y > 0 && Math.abs(as.y / as.max - ps.y / ps.max) < 0.02 ? as : null }, 4000)
  record(CHECKS[6], followed, `presenter ${ps.y}/${ps.max} (${(ps.y / ps.max * 100).toFixed(1)}%), audience ${followed ? `${followed.y}/${followed.max}` : 'did not follow'}`)

  // 9/10: keys. A hidden window never takes the OS focus, so focus itself cannot be observed here
  // (webContents.isFocused() is false for every hidden window); what is checked is where keys go.
  const press = (id, code) => app.evaluate(({ webContents }, { id, code }) => { const wc = webContents.fromId(id); wc.sendInputEvent({ type: 'keyDown', keyCode: code }); wc.sendInputEvent({ type: 'keyUp', keyCode: code }) }, { id, code })
  await inView(p.id, 'scrollTo(0, 0)')
  for (let i = 0; i < 5; i++) await press(p.id, 'Down')
  await wait(400)
  const notInteracting = await scrollOf(p.id)
  await presenter.keyboard.press('e')
  const interactOn = await waitFor(async () => (await presenter.evaluate(() => window.__twLivePageSlot()?.interact)) === true, 2000, 100)
  await wait(300)
  for (let i = 0; i < 5; i++) await press(p.id, 'Down')
  await wait(500)
  const interacting = await scrollOf(p.id)
  await press(p.id, 'Escape')
  await wait(400)
  const interactAfter = await presenter.evaluate(() => window.__twLivePageSlot()?.interact)
  const yBefore = (await scrollOf(p.id)).y
  for (let i = 0; i < 5; i++) await press(p.id, 'Down')
  await wait(400)
  const afterEsc = await scrollOf(p.id)
  record(CHECKS[9], interactOn && interacting.y > 0 && interactAfter === false && afterEsc.y === yBefore, `Interact on ${interactOn}: Down moved the page to ${interacting.y}; after Esc interact ${interactAfter}, Down left it at ${afterEsc.y} (was ${yBefore}). Focus itself is not observable in hidden windows.`)

  // 11: the audience view never takes keys (a stray key on the projector does not move its page).
  const aBefore = await scrollOf(a.id)
  for (let i = 0; i < 5; i++) await press(a.id, 'PageDown')
  await wait(400)
  const aAfterKeys = await scrollOf(a.id)
  record(CHECKS[10], aAfterKeys.y === aBefore.y, `audience PageDown x5: ${aBefore.y} -> ${aAfterKeys.y}`)

  // 8: a link followed in the presenter view (Interact then click) is followed by the audience.
  await inView(p.id, 'document.getElementById("next").click()', true)
  const navFollowed = await waitFor(async () => { const { p: p2, a: a2 } = await pair(`${ORIGIN}/second`); return p2 && a2 ? [p2, a2] : null }, 8000)
  const stillOwnView = (await views(ORIGIN)).length >= 2
  record(CHECKS[7], navFollowed && stillOwnView, navFollowed ? `both on ${navFollowed[0].url}` : JSON.stringify(await views(ORIGIN)))

  // 9 (cont.): ArrowRight from the deck after the click moves on; both views close (12).
  await presenter.keyboard.press('ArrowRight')
  const gone = await waitFor(async () => (await views(ORIGIN)).length === 0, 3000, 100)
  const onAfter = [await presenter.evaluate(() => location.hash), await audience.evaluate(() => document.querySelector('.slide.active')?.dataset.id)]
  record(CHECKS[8], notInteracting.y === 0 && onAfter[0] === '#after' && onAfter[1] === 'after', `without Interact Down x5 sent to the view left it at ${notInteracting.y}; deck ArrowRight -> ${onAfter.join(' ')}`)
  const liveCount = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => /^http:\/\/127\.0\.0\.1/.test(w.getURL())).length)
  record(CHECKS[11], gone && liveCount === 0, `views left: ${(await views(ORIGIN)).length}; web contents on the fixture: ${liveCount}`)

  // 13–17: the hostile page.
  await app.evaluate(({ BrowserWindow }) => { globalThis.__twDownloads = []; })
  await presenter.evaluate(() => { location.hash = 'hostile' })
  const hostile = await waitFor(async () => { const { p: hp, a: ha } = await pair(`${ORIGIN}/hostile`); if (!hp || !ha) return null; const ready = await inView(hp.id, 'document.readyState').catch(() => ''); return ready === 'complete' ? { hp, ha } : null }, 15000)
  if (!hostile) throw new Error('the hostile page did not show')
  await app.evaluate(({ webContents }, id) => { webContents.fromId(id).session.on('will-download', (e) => globalThis.__twDownloads.push(e.defaultPrevented)) }, hostile.hp.id)
  const out = await inView(hostile.hp.id, `window.__attack(${STRAY})`, true)
  const windowsNow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const refusedAll = ['notification', 'geolocation', 'getUserMedia', 'displayMedia', 'clipboard', 'fullscreen'].every((k) => out[k] === 'denied' || /^refused/.test(out[k]))
  out.prefs = await app.evaluate(({ webContents }, id) => { const p = webContents.fromId(id).getLastWebPreferences(); return { disableDialogs: p.disableDialogs, sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, preload: p.preload || null } }, hostile.hp.id)
  record(CHECKS[12], out.popup === 'null' && windowsNow === windowsBefore && out.prefs.disableDialogs === true && out.prefs.sandbox === true && out.prefs.preload === null && refusedAll && ['typeofRequire', 'typeofProcess', 'typeofTw', 'typeofElectron'].every((k) => out[k] === 'undefined'), JSON.stringify(out))
  const localResults = ['fetchLoopback', 'fetchLocalhost', 'fetchNameToLoopback', 'fetchPrivate', 'imgLoopback', 'websocketLoopback'].map((k) => `${k}=${out[k]}`)
  record(CHECKS[13], strayHits === 0 && ['fetchLoopback', 'fetchLocalhost', 'fetchNameToLoopback', 'fetchPrivate', 'imgLoopback', 'websocketLoopback'].every((k) => /^refused/.test(out[k])), `stray server hits ${strayHits}; ${localResults.join(', ')}`)
  for (const target of ['file:///etc/hosts', 'chrome://settings', `twasset://img-1/x.png`]) {
    await inView(hostile.hp.id, `try { top.location.href = ${JSON.stringify(target)} } catch (e) {}`, true).catch(() => {})
    await wait(300)
  }
  await inView(hostile.hp.id, 'document.getElementById("mail").click(); document.getElementById("asset").click()', true).catch(() => {})
  await wait(500)
  const stillHostile = (await views(`${ORIGIN}/hostile`)).find((v) => roleOf(v) === 'presenter')
  const handedOut = output.join('').split('\n').filter((l) => /\[navigation\] (external|local page) \(E2E\)/.test(l))
  record(CHECKS[14], !!stillHostile && handedOut.length === 0, `presenter view still on ${stillHostile?.url}; hand-outs logged: ${handedOut.length ? handedOut.join(' | ') : 'none'}`)
  await inView(hostile.hp.id, 'document.getElementById("dl").click()', true).catch(() => {})
  await wait(1200)
  const downloads = await app.evaluate(() => globalThis.__twDownloads)
  const savedFiles = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('x.bin'))
  record(CHECKS[15], downloads.every((prevented) => prevented === true) && savedFiles.length === 0, `will-download events (prevented?): ${JSON.stringify(downloads)}; saved files: ${savedFiles.length}`)
  // Set only now: Playwright's own dialog handler reacts to a beforeunload prompt event even though the view ignores it.
  await inView(hostile.hp.id, "window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = 'stay'; return 'stay' }; document.body.click()", true).catch(() => {})
  await presenter.keyboard.press('ArrowRight')
  const hostileGone = await waitFor(async () => (await views(`${ORIGIN}/hostile`)).length === 0, 3000, 100)
  const onRedir = await presenter.evaluate(() => location.hash)
  record(CHECKS[16], hostileGone && onRedir === '#redir1', `hostile views left: ${(await views(`${ORIGIN}/hostile`)).length}; presenter on ${onRedir}`)

  // 18: redirects to local addresses.
  const statusOf = () => presenter.evaluate(() => document.querySelector('#currentPreview .live-page-status')?.textContent || '')
  const blocked1 = await waitFor(async () => /Blocked/.test(await statusOf()) ? await statusOf() : null, 8000)
  const v1 = (await views()).filter((v) => roleOf(v) === 'presenter')
  await presenter.keyboard.press('ArrowRight')
  const blocked2 = await waitFor(async () => { const s = await statusOf(); return /redir2/.test(await presenter.evaluate(() => location.hash)) && /Blocked|Couldn't load/.test(s) ? s : null }, 8000)
  const v2 = (await views()).filter((v) => roleOf(v) === 'presenter' && v.visible)
  record(CHECKS[17], !!blocked1 && !!blocked2 && strayHits === 0 && v1.every((v) => !v.visible) && v2.length === 0, `localhost: "${blocked1}"; 192.168.1.1: "${blocked2}"; visible views ${v2.length}; stray hits ${strayHits}`)

  // 19: occlusion by the command palette.
  await presenter.evaluate(() => { location.hash = 'page' })
  await loadedPair(`${ORIGIN}/refused`)
  await presenter.keyboard.press('Meta+Shift+KeyP')
  const hidden = await waitFor(async () => (await views(`${ORIGIN}/refused`)).find((v) => roleOf(v) === 'presenter' && !v.visible), 2000, 100)
  await presenter.keyboard.press('Escape')
  const shownAgain = await waitFor(async () => (await views(`${ORIGIN}/refused`)).find((v) => roleOf(v) === 'presenter' && v.visible), 2000, 100)
  record(CHECKS[18], !!hidden && !!shownAgain, `hidden under palette: ${!!hidden}; shown after: ${!!shownAgain}`)

  // Real sites (network).
  if (SITES) {
    for (const site of REAL) {
      await presenter.evaluate((id) => { location.hash = id }, site.id)
      const host = new URL(site.url).host
      const got = await waitFor(async () => {
        const vs = (await views()).filter((v) => new URL(v.url || 'about:blank').host === host || v.url.includes(host))
        const sp = vs.find((v) => roleOf(v) === 'presenter'); const sa = vs.find((v) => roleOf(v) === 'audience')
        if (!sp || !sa || !sp.visible || !sa.visible) return null
        const s1 = await inView(sp.id, '({ t: document.title, ready: document.readyState, max: document.scrollingElement.scrollHeight - innerHeight })').catch(() => null)
        const s2 = await inView(sa.id, '({ t: document.title, ready: document.readyState, max: document.scrollingElement.scrollHeight - innerHeight })').catch(() => null)
        return s1?.ready === 'complete' && s2?.ready === 'complete' ? { sp, sa, s1, s2 } : null
      }, 45000, 1000)
      const status = await statusOf()
      record(`${site.url}: shows live in presenter and audience`, got, got ? `"${got.s1.t}" / "${got.s2.t}", ${got.s1.max}px to scroll; status "${status}"` : `not loaded (no network, or the site refused); status "${status}"`)
      if (EVIDENCE && got) {
        for (const [role, v] of [['presenter', got.sp], ['audience', got.sa]]) {
          const png = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), v.id).catch(() => '')
          if (png) writeFileSync(join(EVIDENCE, `live-page-${site.id}-${role}.png`), Buffer.from(png, 'base64'))
        }
      }
      if (!got || got.s1.max <= 0) { record(`${site.url}: audience follows presenter scroll`, false, got ? 'the page does not scroll' : 'not loaded'); continue }
      // A real wheel on the presenter view; some sites scroll smoothly, so wait for the page to settle.
      await app.evaluate(({ webContents }, { id, x, y }) => { const wc = webContents.fromId(id); for (let i = 0; i < 6; i++) wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -300 }) }, { id: got.sp.id, x: Math.round(got.sp.bounds.width / 2), y: Math.round(got.sp.bounds.height / 2) })
      await wait(1500)
      const s = await scrollOf(got.sp.id)
      if (!(s.y > 0)) { record(`${site.url}: audience follows presenter scroll`, false, `the wheel did not move the presenter view (${s.y}/${s.max})`); continue }
      const fa = await waitFor(async () => { const x = await scrollOf(got.sa.id); return x.max > 0 && x.y > 0 && Math.abs(x.y / x.max - s.y / s.max) < 0.02 ? x : null }, 5000)
      record(`${site.url}: audience follows presenter scroll`, fa, `presenter ${(s.y / s.max * 100).toFixed(1)}%, audience ${fa ? (fa.y / fa.max * 100).toFixed(1) + '%' : 'did not follow'}`)
    }
  }

  // 20: closing a deck window closes its view and clears it (the audience window keeps its own until it closes).
  const liveContents = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /^https?:\/\/(127\.0\.0\.1|radiotimesof|audioarchive|languagelog)/.test(w.getURL())).map((w) => w.getURL()))
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/Presenter/.test(w.getTitle())) w.destroy() })
  await wait(800)
  const presenterLeft = (await views()).filter((v) => roleOf(v) === 'presenter').length
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/Audience/.test(w.getTitle())) w.destroy() })
  await wait(800)
  const left = await liveContents()
  record(CHECKS[19], presenterLeft === 0 && left.length === 0, `presenter views after its window closed: ${presenterLeft}; live web contents after both closed: ${left.length ? left.join(' ') : 'none'}`)
  if (EVIDENCE) writeFileSync(join(EVIDENCE, 'live-page-e2e-app-output.log'), output.join('').split('\n').filter((l) => /live-page|navigation|local-address/.test(l)).join('\n'))
  exitCode = ledger.summary('LIVE PAGE PRESENT E2E').exitCode
} catch (error) {
  console.error(error.stack || error.message)
  ledger.summary('LIVE PAGE PRESENT E2E')
} finally {
  await app.close().catch(() => {})
  await new Promise((r) => fixture.close(r)); await new Promise((r) => stray.close(r))
  rmSync(root, { recursive: true, force: true })
}
process.exit(exitCode)
