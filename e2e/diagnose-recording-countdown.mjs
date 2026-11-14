// The recording countdown over a white and a blue slide (docs-found fixes, 0.44): an owned Electron
// profile, a neutral two-slide fixture, fake media devices and the real presenter countdown. One app
// launch per colour; the recording that follows the countdown is never stopped or saved, the app is
// closed instead. Hard limit: 120 seconds overall, every wait has its own timeout.
// Usage: npm run build, then node e2e/diagnose-recording-countdown.mjs (SHOTS=<dir> for the pictures).
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : join(repo, 'evidence/docs-found-fixes')
mkdirSync(shots, { recursive: true })
const WAIT = { timeout: 15000 }
const log = (line) => console.log(`[countdown ${new Date().toISOString().slice(11, 19)}] ${line}`)
let app = null
let root = null
const cleanup = async () => {
  const closing = app; app = null
  if (closing) {
    const proc = closing.process()
    await Promise.race([closing.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
    try { proc?.kill('SIGKILL') } catch {}
  }
  if (root) { rmSync(root, { recursive: true, force: true }); root = null }
}
const hardStop = setTimeout(async () => { log('FAIL: 120-second limit reached'); await cleanup(); process.exit(2) }, 120000)

async function one(name, colour) {
  root = mkdtempSync(join(repo, '.tw-countdown-e2e-')) // .tw-* is ignored by Git
  const vault = join(root, 'vault'), talk = join(vault, 'fixture'), userData = join(root, 'userData')
  mkdirSync(talk, { recursive: true }); mkdirSync(userData, { recursive: true })
  const outline = join(talk, 'fixture-outline.md')
  const content = '---\ntitle: Countdown check\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Fixture slide {id=fixture}\n\nCountdown visibility.\n'
  writeFileSync(outline, content)
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }))
  log(`${name}: launching`)
  app = await electron.launch({ cwd: repo, timeout: 30000, args: ['.', '--user-data-dir=' + userData, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' } })
  const main = await app.firstWindow(WAIT)
  await main.waitForLoadState('domcontentloaded', WAIT)
  log(`${name}: opening the presenter`)
  const opened = app.waitForEvent('window', WAIT)
  await main.evaluate(({ outline, content }) => window.tw.talk.present(outline, content, 'presenter'), { outline, content })
  const presenter = await opened
  await presenter.waitForSelector('#twrec-primary', WAIT)
  await presenter.emulateMedia({ reducedMotion: 'reduce' })
  await presenter.locator('#currentPreview iframe').waitFor(WAIT)
  const frame = await (await presenter.locator('#currentPreview iframe').elementHandle(WAIT)).contentFrame()
  assert.ok(frame, 'current slide frame')
  // Neutral fixture: a plain panel of the test colour over the whole current-slide frame.
  await frame.evaluate((colour) => {
    const panel = document.createElement('div')
    panel.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${colour}`
    document.documentElement.appendChild(panel)
  }, colour)
  log(`${name}: pressing Record`)
  await presenter.locator('#twrec-primary').click(WAIT)
  await presenter.waitForSelector('#twrec-countdown, [data-continue]', WAIT)
  const go = presenter.locator('[data-continue]')
  if (await go.isVisible().catch(() => false)) {
    log(`${name}: device check, continuing`)
    await presenter.waitForFunction(() => !document.querySelector('[data-continue]')?.disabled, null, WAIT)
    await go.click(WAIT)
  }
  await presenter.waitForSelector('#twrec-countdown', WAIT)
  const start = Date.now()
  const view = await presenter.locator('#twrec-countdown').evaluate((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect()
    return { text: el.textContent, bg: s.backgroundColor, colour: s.color, width: r.width, height: r.height, animation: s.animationName, transition: s.transitionDuration, pointer: s.pointerEvents }
  })
  log(`${name}: countdown ${JSON.stringify(view)}`)
  assert.equal(view.text, '3')
  assert.match(view.bg, /^rgba\(15, 23, 32, 0\.9\d*\)$/, 'a dark, nearly opaque disc behind the digit')
  assert.equal(view.colour, 'rgb(247, 243, 234)')
  assert.equal(view.width, 128); assert.equal(view.height, 128)
  assert.equal(view.animation, 'none'); assert.equal(view.transition, '0s'); assert.equal(view.pointer, 'none')
  await presenter.screenshot({ path: join(shots, `countdown-${name}.png`), timeout: 10000 })
  log(`${name}: picture saved`)
  await presenter.waitForFunction(() => document.querySelector('#twrec-countdown')?.textContent === '2', null, WAIT)
  await presenter.waitForFunction(() => document.querySelector('#twrec-countdown')?.textContent === '1', null, WAIT)
  await presenter.waitForFunction(() => !document.querySelector('#twrec-countdown'), null, WAIT)
  assert.ok(Date.now() - start >= 1900, 'one second per digit')
  const sources = app.windows().filter((w) => w.url().includes('audience=1'))
  for (const source of sources) assert.equal(await source.locator('#twrec-countdown').count(), 0, 'the audience window (the slides layer) has no countdown')
  log(`PASS ${name}: contrasting backing, reduced motion, 3-2-1 timing, ${sources.length} audience window(s) without countdown`)
  await cleanup()
}

let code = 0
try {
  await one('white', '#ffffff')
  await one('blue', '#164e8c')
} catch (error) {
  log(`FAIL: ${error?.message ?? error}`)
  code = 1
} finally {
  await cleanup()
  clearTimeout(hardStop)
}
process.exit(code)
