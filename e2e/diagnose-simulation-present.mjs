// The AI chat and terminal slides in the REAL presenting path (owner check of the installed
// 0.38.1-preview.2): TalkWeaver's own talk:present opens the presenter window from a scratch vault
// holding a copy of the demo talk, and the presenter's Audience button opens the audience window,
// exactly as F5 does. Checks what failed for the owner and what was added after it:
//   - a click on a row / "Show results" / the shortened result in the presenter's Current pane
//     opens it there and in the audience window, a second click closes it, the slide stays;
//   - a click in the audience window does the same;
//   - a long conversation keeps its text size, overflows, and scrolls by the wheel, from the
//     Current pane and in the audience window, each following the other;
//   - a terminal step types its text (and the Current pane never shows an empty frame while it is
//     redrawn); Next while typing finishes it, the next Next steps;
//   - a chat with stream=on streams its answer;
//   - all of it with Reduce motion emulated in both windows (the owner's Mac has it on): typing is
//     content, not decoration, and ignores prefers-reduced-motion (spec decision 10).
//
// Run: node e2e/diagnose-simulation-present.mjs   (scratch user data and vault under the OS temp dir)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { createCheckLedger } from './lib/check-ledger.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const DEMO = join(REPO, 'docs/design/2026-10-08-ai-chat-and-terminal-simulation-designs/ai-chat-and-terminal-slides-demo-talk.md')

const CHECKS = [
  'presenter pane: a click on "Thought for 4 s" opens the row in the pane',
  'presenter pane: the audience window shows the row open',
  'presenter pane: a second click closes it in both windows',
  'presenter pane: the clicks leave both windows on the slide',
  'presenter pane: "Show results" opens on chat plus behind the scenes',
  'presenter pane: the shortened result expands on agent in a terminal',
  'audience window: a click on a row opens it and the slide stays',
  'long chat: the text keeps its size and the conversation overflows',
  'long chat: the wheel over the Current pane scrolls it, and the audience window follows',
  'long chat: the wheel in the audience window scrolls it, and the Current pane follows',
  'terminal step: the audience window types the revealed part',
  'terminal step: the Current pane always shows a loaded picture while it is redrawn',
  'terminal step: Next while typing finishes it without stepping',
  'terminal step: the next Next steps',
  'streaming chat: arriving shows it complete; a step streams the reasoning, then the answer',
  'reduced motion: both windows run with Reduce motion on',
  'reduced motion: a terminal part types, characters appearing over time',
]
const ledger = createCheckLedger(CHECKS)
const record = (name, pass, detail) => ledger.record(name, Boolean(pass), detail)

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-sim-'))
const vault = join(root, 'vault')
const userData = join(root, 'userData')
const talkDir = join(vault, 'ai-chat-and-terminal-slides')
const outlinePath = join(talkDir, 'ai-chat-and-terminal-slides-outline.md')
mkdirSync(talkDir, { recursive: true })
mkdirSync(userData, { recursive: true })
const content = readFileSync(DEMO, 'utf8')
writeFileSync(outlinePath, content, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const errors = []
let exitCode = 1
try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)

  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: outlinePath, c: content })
  if (!result?.success) throw new Error(`present failed: ${JSON.stringify(result)}`)
  const presenter = await opened
  presenter.on('pageerror', (e) => errors.push(`presenter: ${e.message}`))
  await presenter.waitForLoadState('domcontentloaded')
  await presenter.waitForSelector('#currentPreview iframe', { timeout: 15000 })
  const audienceOpened = app.waitForEvent('window')
  await presenter.evaluate(() => document.getElementById('presenterAudienceApp')?.click())
  const audience = await audienceOpened
  audience.on('pageerror', (e) => errors.push(`audience: ${e.message}`))
  await audience.waitForLoadState('domcontentloaded')
  await presenter.waitForTimeout(1200)
  await presenter.emulateMedia({ reducedMotion: 'reduce' })
  await audience.emulateMedia({ reducedMotion: 'reduce' })
  const reducedOn = async () => (await presenter.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)) && (await audience.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches))
  record(CHECKS[15], await reducedOn(), 'matchMedia reduce in presenter and audience')

  const settle = (ms = 600) => presenter.waitForTimeout(ms)
  const goTo = async (title) => {
    const id = await presenter.evaluate((title) => [...document.querySelectorAll('.deck .slide')].find((s) => s.querySelector('h1')?.textContent.trim() === title)?.dataset.id, title)
    if (!id) throw new Error(`no slide titled ${title}`)
    await presenter.evaluate((id) => { location.hash = id }, id)
    await settle(900)
    return id
  }
  const paneDoc = () => 'document.querySelector("#currentPreview > iframe:not(.preview-incoming)")?.contentDocument'
  const paneExpanded = () => presenter.evaluate(`[...${paneDoc()}.querySelectorAll('.sim-toggle')].map((b) => b.getAttribute('aria-expanded')).join(',')`)
  const audienceExpanded = () => audience.evaluate(() => [...document.querySelectorAll('.slide.active .sim-toggle')].map((b) => b.getAttribute('aria-expanded')).join(','))
  const audienceSlide = () => audience.evaluate(() => document.querySelector('.slide.active')?.dataset.id)
  const paneSlide = () => presenter.evaluate(`${paneDoc()}.querySelector('.slide')?.dataset.id`)
  const panePoint = (selector) => presenter.evaluate(`(() => {
    const frame = document.querySelector("#currentPreview > iframe:not(.preview-incoming)")
    const el = frame.contentDocument.querySelector(${JSON.stringify(selector)})
    const f = frame.getBoundingClientRect(), r = el.getBoundingClientRect(), s = f.width / 1280
    return { x: f.left + (r.left + r.width / 2) * s, y: f.top + (r.top + r.height / 2) * s }
  })()`)
  const clickPane = async (selector) => { const at = await panePoint(selector); await presenter.mouse.click(at.x, at.y); await settle() }

  // ---- Disclosures in the Current pane ----
  const rows = await goTo('Chat with rows to click open')
  await clickPane('.sim-reasoning .sim-toggle')
  record(CHECKS[0], (await paneExpanded()) === 'true,false,false', `pane ${await paneExpanded()}`)
  record(CHECKS[1], (await audienceExpanded()) === 'true,false,false', `audience ${await audienceExpanded()}`)
  await clickPane('.sim-reasoning .sim-toggle')
  record(CHECKS[2], (await paneExpanded()) === 'false,false,false' && (await audienceExpanded()) === 'false,false,false', `pane ${await paneExpanded()} audience ${await audienceExpanded()}`)
  record(CHECKS[3], (await paneSlide()) === rows && (await audienceSlide()) === rows, `pane ${await paneSlide()} audience ${await audienceSlide()}`)
  await goTo('Chat plus behind the scenes')
  await clickPane('.sim-toggle-results')
  record(CHECKS[4], (await paneExpanded()) === 'true' && (await audienceExpanded()) === 'true', `pane ${await paneExpanded()} audience ${await audienceExpanded()}`)
  await goTo('Agent in a terminal')
  await clickPane('.sim-more')
  record(CHECKS[5], (await paneExpanded()) === 'true' && (await audienceExpanded()) === 'true', `pane ${await paneExpanded()} audience ${await audienceExpanded()}`)

  // ---- A click in the audience window ----
  const rows2 = await goTo('Chat with rows to click open')
  const at = await audience.evaluate(() => { const r = document.querySelector('.slide.active .sim-tool .sim-toggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await audience.mouse.click(at.x, at.y); await settle()
  record(CHECKS[6], (await audienceExpanded()) === 'false,false,true' && (await audienceSlide()) === rows2 && (await paneExpanded()) === 'false,false,true', `audience ${await audienceExpanded()} pane ${await paneExpanded()}`)

  // ---- A long conversation ----
  await goTo('A long conversation (scroll it)')
  const firstInView = (page, inPane) => page.evaluate(`(() => {
    const doc = ${inPane ? paneDoc() : 'document'}
    const scroller = (doc.querySelector('.slide.active') || doc.querySelector('.slide')).querySelector('.sim-scroll')
    const first = scroller.querySelector('.sim-bubble').getBoundingClientRect(), box = scroller.getBoundingClientRect()
    return { inView: first.top >= box.top - 1, overflow: scroller.scrollHeight - scroller.clientHeight, font: getComputedStyle(scroller.querySelector('.sim-bubble')).fontSize, width: doc.documentElement.clientWidth }
  })()`)
  const arrival = await firstInView(audience, false)
  // 28 on the 1920 canvas: the bubble is 28/1920 of the stage width.
  const stageWidth = await audience.evaluate(() => document.querySelector('.stage')?.getBoundingClientRect().width || 0)
  const paneFont = (await firstInView(presenter, true)).font
  record(CHECKS[7], arrival.overflow > 50 && !arrival.inView && paneFont === '18.6667px', `overflow ${arrival.overflow}, pane font ${paneFont}, audience font ${arrival.font} on a ${Math.round(stageWidth)} stage`)
  // From the arrival (latest turn in view): the wheel in the audience window scrolls back to the
  // first question and the Current pane follows; then the wheel over the Current pane scrolls down
  // again and the audience window follows. Each starts from the state the one before must reach.
  const box = await audience.evaluate(() => { const r = document.querySelector('.slide.active .sim-scroll').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await audience.mouse.move(box.x, box.y)
  for (let i = 0; i < 14; i++) await audience.mouse.wheel(0, -400)
  await settle(800)
  const upAudience = await firstInView(audience, false), upPane = await firstInView(presenter, true)
  record(CHECKS[9], upAudience.inView && upPane.inView, `audience ${upAudience.inView} pane ${upPane.inView}`)
  const pane = await presenter.evaluate(() => { const r = document.querySelector('#currentPreview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  await presenter.mouse.move(pane.x, pane.y)
  for (let i = 0; i < 14; i++) await presenter.mouse.wheel(0, 400)
  await settle(800)
  const downPane = await firstInView(presenter, true), downAudience = await firstInView(audience, false)
  record(CHECKS[8], !downPane.inView && !downAudience.inView && upPane.inView, `pane ${downPane.inView} audience ${downAudience.inView}`)

  // ---- Typing on a terminal step ----
  await goTo('Agent, step by step (press next)')
  // Watch the Current pane for a frame with no loaded picture while it is redrawn for the step.
  await presenter.evaluate(() => {
    window.__paneGaps = 0
    const end = performance.now() + 1500
    const tick = () => {
      const frame = document.querySelector('#currentPreview > iframe:not(.preview-incoming)')
      if (!frame || !frame.contentDocument?.querySelector('.slide')) window.__paneGaps += 1
      if (performance.now() < end) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const typedNow = () => audience.evaluate(() => {
    const el = document.querySelector('.slide.active .sim-reasoning')
    const rest = [...el.querySelectorAll('.sim-typing-rest')].reduce((n, span) => n + span.textContent.length, 0)
    return { rest, total: el.textContent.length }
  })
  const hidden = () => audience.evaluate(() => document.querySelectorAll('.slide.active .sim-step[data-mode-state="hidden"]').length)
  const hiddenBefore = await hidden()
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(60)
  const mid = await typedNow()
  record(CHECKS[10], mid.rest > 0 && mid.rest < mid.total, `untyped ${mid.rest} of ${mid.total} at about 60 ms`)
  await presenter.waitForTimeout(70)
  const mid2 = await typedNow()
  record(CHECKS[16], (await reducedOn()) && mid.rest > 0 && mid2.rest < mid.rest, `untyped ${mid.rest} then ${mid2.rest} of ${mid.total} with Reduce motion on`)
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(300)
  const after = await typedNow()
  record(CHECKS[12], after.rest === 0 && (await hidden()) === hiddenBefore - 1, `untyped ${after.rest}, hidden ${await hidden()} (was ${hiddenBefore - 1} after the first press)`)
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(400)
  record(CHECKS[13], (await hidden()) === hiddenBefore - 2, `hidden ${await hidden()}`)
  await presenter.waitForTimeout(1200)
  const gaps = await presenter.evaluate(() => window.__paneGaps)
  record(CHECKS[11], gaps === 0, `${gaps} frames without a loaded picture`)

  // ---- Streaming chat ----
  // Arriving (here by Next from the slide before) shows the conversation complete; a step streams the part it reveals.
  await goTo('Two questions on one slide')
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(120)
  const slideState = () => audience.evaluate(() => {
    const slide = document.querySelector('.slide.active')
    return {
      title: slide.querySelector('h1')?.textContent.trim(),
      typing: slide.querySelectorAll('.sim-typing, .sim-typing-wait, .sim-typing-rest').length,
      answerTyping: slide.querySelector('.sim-answer')?.classList.contains('sim-typing') || false,
      reasoningTyping: slide.querySelector('.sim-reasoning')?.classList.contains('sim-typing') || false
    }
  })
  const arrived = await slideState()
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(120)
  const firstStep = await slideState()
  await presenter.waitForTimeout(3000)
  for (let i = 0; i < 2; i++) { await presenter.keyboard.press('ArrowRight'); await presenter.waitForTimeout(500) }
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForTimeout(120)
  const answerStep = await slideState()
  await presenter.waitForTimeout(3000)
  const done = await audience.evaluate(() => document.querySelectorAll('.slide.active .sim-typing-rest, .slide.active .sim-typing-wait').length)
  record(CHECKS[14], arrived.title === 'Behind the scenes, streaming (press next)' && arrived.typing === 0 && firstStep.reasoningTyping && answerStep.answerTyping && done === 0, JSON.stringify({ arrived, firstStep, answerStep, leftAfter3s: done }))

  const summary = ledger.summary('SIMULATION PRESENT E2E')
  if (errors.length) console.log('page errors:\n' + errors.join('\n'))
  exitCode = errors.length ? 1 : summary.exitCode
} catch (error) {
  console.error(error)
  ledger.summary('SIMULATION PRESENT E2E')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
process.exit(exitCode)
