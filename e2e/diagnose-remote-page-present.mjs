// A web page on a slide, presented in the REAL presenting path: TalkWeaver's own talk:present opens
// the presenter window from a scratch vault, the presenter's Audience button opens the audience
// window. The page is a real site (default: the Language Log post the owner asked for; another with
// REMOTE_PAGE_URL=…), so this needs the network: a page that does not load is reported as not
// loaded, never as a pass. Windows are hidden (TW_E2E: show:false, backgroundThrottling:false).
//   - the Current pane shows the page, in the remote sandbox, and the wheel does nothing before `e`;
//   - after `e` the wheel scrolls the pane, and the audience window's copy follows (main,
//     remote-page-follow.ts), to the same fraction of the page;
//   - Return to slides hands the keys back: the arrow key moves both windows on and back;
//   - in the audience window itself, `e` and the wheel scroll its copy (the projector side);
//   - nothing opens a window or moves a deck window off the deck.
// Run: node e2e/diagnose-remote-page-present.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const URL_UNDER_TEST = process.env.REMOTE_PAGE_URL || 'https://languagelog.ldc.upenn.edu/nll/?p=60956'
const ORIGIN = new URL(URL_UNDER_TEST).origin
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation'
const OUTLINE = `# Remote page\n\n## Before {id=before}\n\n- A slide before the page\n\n## The page {layout=media id=page}\n\n[Embed: ${URL_UNDER_TEST}]\n\n## After {id=after}\n\n- A slide after the page\n`

const CHECKS = [
  'presenter: the Current pane loads the page',
  'presenter: the pane frame runs in the remote sandbox',
  'presenter: before e, the wheel does not scroll the page',
  'presenter: after e, the wheel scrolls the page',
  'audience: its copy follows the pane to the same part of the page',
  'presenter: Return to slides hands the keys back',
  'presenter: the arrow key then moves both windows on, and back',
  'audience: e and the wheel scroll its own copy',
  'no window opened and no deck window moved off the deck',
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-remote-page-'))
const vault = join(root, 'vault'), userData = join(root, 'userData'), talkDir = join(vault, 'remote-page')
const outlinePath = join(talkDir, 'remote-page-outline.md')
mkdirSync(talkDir, { recursive: true }); mkdirSync(userData, { recursive: true })
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

await ensureFreshBuild(REPO)
// An agent shell may carry ELECTRON_RUN_AS_NODE; Electron must not inherit it, or it starts as Node.
const env = { ...process.env, TW_E2E: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env })
let exitCode = 1
try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)
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
  const windowsBefore = app.windows().length
  const deckUrls = async () => [await presenter.evaluate(() => location.pathname), await audience.evaluate(() => location.pathname)]
  const pathsBefore = await deckUrls()

  const PANE = '#currentPreview iframe.live-sim-frame'
  const SLIDE_FRAME = '.slide.active figure.slide-embed iframe'
  const pageFrame = async (page, sel) => (await (await page.$(sel))?.contentFrame()) || null
  const pageState = async (page, sel) => {
    const frame = await pageFrame(page, sel)
    if (!frame || !frame.url().startsWith(ORIGIN)) return null
    return frame.evaluate(() => ({ title: document.title, y: scrollY, max: document.scrollingElement.scrollHeight - innerHeight })).catch(() => null)
  }
  const waitLoaded = async (page, sel) => {
    for (let i = 0; i < 40; i++) { const s = await pageState(page, sel); if (s?.title && s.max > 0) return s; await page.waitForTimeout(500) }
    return null
  }
  const wheel = async (page, sel, dy, times = 5) => {
    const r = await page.$eval(sel, (f) => { const b = f.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })
    await page.mouse.move(r.x, r.y)
    for (let i = 0; i < times; i++) await page.mouse.wheel(0, dy)
    await page.waitForTimeout(800)
  }
  const activeIds = async () => [await presenter.evaluate(() => location.hash), await audience.evaluate(() => document.querySelector('.slide.active')?.dataset.id)]

  await presenter.evaluate(() => { location.hash = 'page' })
  const loaded = await waitLoaded(presenter, PANE)
  record(CHECKS[0], loaded, loaded ? `${loaded.title} (${loaded.max}px to scroll)` : `not loaded from ${URL_UNDER_TEST}: no network, or the site refused`)
  if (!loaded) throw new Error('the page did not load; nothing further can be checked')
  const audienceLoaded = await waitLoaded(audience, SLIDE_FRAME)
  record(CHECKS[1], (await presenter.$eval(PANE, (f) => f.getAttribute('sandbox'))) === SANDBOX && (await audience.$eval(SLIDE_FRAME, (f) => f.getAttribute('sandbox'))) === SANDBOX, 'pane and audience frames')
  await wheel(presenter, PANE, 400)
  const before = await pageState(presenter, PANE)
  record(CHECKS[2], before?.y === 0, `pane at ${before?.y}`)
  await presenter.keyboard.press('e')
  await presenter.waitForTimeout(400)
  await wheel(presenter, PANE, 400)
  const after = await pageState(presenter, PANE)
  record(CHECKS[3], after?.y > 0, `pane at ${after?.y} of ${after?.max}`)
  await presenter.waitForTimeout(1000)
  const followed = await pageState(audience, SLIDE_FRAME)
  const paneFraction = after.y / after.max, audienceFraction = followed ? followed.y / followed.max : -1
  record(CHECKS[4], audienceLoaded && followed?.y > 0 && Math.abs(paneFraction - audienceFraction) < 0.03, `pane ${(paneFraction * 100).toFixed(1)}%, audience ${(audienceFraction * 100).toFixed(1)}% (${followed?.y}px of ${followed?.max})`)
  const returnBtn = await presenter.$('.embed-return-btn')
  const returnVisible = returnBtn ? await returnBtn.isVisible() : false
  if (returnVisible) await returnBtn.click()
  await presenter.waitForTimeout(400)
  const gated = await presenter.$eval(PANE, (f) => getComputedStyle(f).pointerEvents)
  record(CHECKS[5], returnVisible && gated === 'none' && !(await presenter.evaluate(() => document.body.classList.contains('embed-interacting'))), `return visible ${returnVisible}, pane pointer-events ${gated}`)
  await presenter.keyboard.press('ArrowRight'); await presenter.waitForTimeout(900)
  const on = await activeIds()
  await presenter.keyboard.press('ArrowLeft'); await presenter.waitForTimeout(900)
  const back = await activeIds()
  record(CHECKS[6], on[0] === '#after' && on[1] === 'after' && back[0] === '#page' && back[1] === 'page', `on ${on.join(' ')}, back ${back.join(' ')}`)
  // The projector side: someone at the audience window scrolls its copy directly.
  await waitLoaded(audience, SLIDE_FRAME)
  const startAudience = (await pageState(audience, SLIDE_FRAME))?.y ?? 0
  await audience.keyboard.press('e'); await audience.waitForTimeout(400)
  await wheel(audience, SLIDE_FRAME, startAudience > 0 ? -300 : 300, 3)
  const moved = (await pageState(audience, SLIDE_FRAME))?.y
  record(CHECKS[7], typeof moved === 'number' && moved !== startAudience, `audience ${startAudience} → ${moved}`)
  await audience.click('.embed-return-btn').catch(() => {})
  const pathsAfter = await deckUrls()
  record(CHECKS[8], app.windows().length === windowsBefore && pathsAfter.join() === pathsBefore.join(), `${app.windows().length} windows (was ${windowsBefore}); ${pathsAfter.join(' ')}`)
  await presenter.screenshot({ path: join(root, 'presenter.png') }).catch(() => {})
  exitCode = ledger.summary('REMOTE PAGE PRESENT E2E').exitCode
} catch (error) {
  console.error(error.message)
  ledger.summary('REMOTE PAGE PRESENT E2E')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
process.exit(exitCode)
