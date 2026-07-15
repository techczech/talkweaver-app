// Presenter QoL harness (Task 2): the single top clock with explicit Start / Pause / Resume
// + a duration setter. Compiles a fixture deck via the VENDORED compiler (same entrypoint as
// scripts/smoke-compiler.mjs), writes the produced present HTML to a temp file, then opens it
// with ?presenter=1 in the Electron-bundled Chromium (the reliable browser in this repo — the
// other diagnose-*.mjs harnesses launch Electron too). Asserts the idle -> running -> paused
// transitions on #twClock / #twClockBtn and that the old #bigTimer is gone.
//
// Run: cd talk-weaver && node e2e/diagnose-presenter-qol.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const compilerDir = join(REPO, 'compiler', 'scripts')

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── Compile a fixture deck (with a frontmatter duration so Start actually runs the clock) ──
const { prepareSource } = await import(
  pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
)
const root = mkdtempSync(join(tmpdir(), 'tw-e2e-qol-'))
const ud = join(root, 'ud')
mkdirSync(ud, { recursive: true })
const outlinePath = join(root, 'qol-outline.md')
// The overview assertions need a query ("method") that matches a TITLE slide AND a body-only
// slide, so we can prove title-ranked ordering: "Method notes" (title) must outrank "Results"
// (which mentions "method" only in its body).
// Task 7 (shown/skipped) needs enough slides for a visited-run / jumped-gap / unseen-tail scene
// (see the compiled-index note further down, where the actual scene is driven).
const content = [
  '---',
  'title: QoL Fixture',
  'duration: 25min',
  '---',
  '',
  '### Opening slide',
  '',
  '- alpha',
  '- beta',
  '',
  '### Second slide',
  '',
  '- gamma',
  '',
  '### Method notes',
  '',
  '- how we ran the study',
  '',
  '### Results',
  '',
  '- the method produced a clear signal',
  '',
  '### Discussion',
  '',
  '- what it means',
  '',
  '### Wrap up',
  '',
  '- final thoughts',
].join('\n')
writeFileSync(outlinePath, content, 'utf8')
const model = await prepareSource(outlinePath, content, 'qol', statSync(outlinePath))
const presentPath = join(root, 'qol-present.html')
writeFileSync(presentPath, model.fullHtml, 'utf8')
const presentUrl = pathToFileURL(presentPath).href + '?presenter=1'
// The shared createOverview drawer (#overviewDrawer) is a STANDALONE/handout surface — it is
// CSS-hidden in presenter mode, where the presenter uses its own #presenterOutlineDrawer. So the
// overview assertions below open the SAME compiled file with no ?presenter=1 (standalone mode).
const standaloneUrl = pathToFileURL(presentPath).href
console.log('present file: ' + presentPath)

// ── Launch Electron and drive its window straight to the compiled present HTML ──
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
// Optional visual capture: set TW_E2E_SHOTS=<dir> to write screenshots at key moments.
const SHOTS = process.env.TW_E2E_SHOTS
const shot = async (name) => { if (SHOTS) { try { await page.screenshot({ path: join(SHOTS, name) }) } catch {} } }

try {
  await page.goto(presentUrl)
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)

  // Sanity: the compiled deck injected the pure timer core (no leftover placeholder).
  const injected = await page.evaluate(() => document.documentElement.innerHTML.includes('function bigTimerState'))
  record('present HTML injected the pure timer core (bigTimerState present)', injected)

  // (a) On load: idle + "Start".
  const status0 = await page.locator('#twClock').getAttribute('data-status')
  const btn0 = (await page.locator('#twClockBtn').innerText()).trim()
  record('on load #twClock data-status="idle"', status0 === 'idle', `status=${status0}`)
  record('on load button reads "▶ Start"', btn0 === '▶ Start', `btn=${JSON.stringify(btn0)}`)

  // (v0.7.5) P starts the timer (was hijacked by the mode step-alias) + Reset returns to idle.
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur())
  await page.keyboard.press('p')
  await page.waitForTimeout(150)
  const pStatus = await page.locator('#twClock').getAttribute('data-status')
  record('P key starts the timer', pStatus === 'running', `status=${pStatus}`)
  await page.locator('#twResetBtn').click()
  await page.waitForTimeout(150)
  const resetStatus = await page.locator('#twClock').getAttribute('data-status')
  record('Reset button returns the timer to idle (zero)', resetStatus === 'idle', `status=${resetStatus}`)

  // (b) Click Start -> running + "Pause".
  await page.locator('#twClockBtn').click()
  await page.waitForTimeout(150)
  const status1 = await page.locator('#twClock').getAttribute('data-status')
  const btn1 = (await page.locator('#twClockBtn').innerText()).trim()
  record('after click #twClock data-status="running"', status1 === 'running', `status=${status1}`)
  record('after click button reads "⏸ Pause"', btn1 === '⏸ Pause', `btn=${JSON.stringify(btn1)}`)
  await shot('06-timer-running.png')

  // (c) Click again -> paused + "Resume".
  await page.locator('#twClockBtn').click()
  await page.waitForTimeout(150)
  const status2 = await page.locator('#twClock').getAttribute('data-status')
  const btn2 = (await page.locator('#twClockBtn').innerText()).trim()
  record('after 2nd click #twClock data-status="paused"', status2 === 'paused', `status=${status2}`)
  record('after 2nd click button reads "▶ Resume"', btn2 === '▶ Resume', `btn=${JSON.stringify(btn2)}`)

  // (d) The old dual clock is gone.
  const bigTimerCount = await page.locator('#bigTimer').count()
  record('old #bigTimer no longer exists', bigTimerCount === 0, `count=${bigTimerCount}`)

  // (v0.7.1 fix 3) Layout: the clock bar lives in the header row and must NOT overlap the title.
  const layout = await page.evaluate(() => {
    const t = document.getElementById('presenterTitle').getBoundingClientRect()
    const c = document.querySelector('.tw-clock-bar').getBoundingClientRect()
    const overlap = !(t.right <= c.left || c.right <= t.left)
    return { overlap, titleRight: Math.round(t.right), clockLeft: Math.round(c.left) }
  })
  record('layout: clock bar does not overlap the title', !layout.overlap, JSON.stringify(layout))

  // (v0.7.1 fix 4) Duration setter: preset pills + reminder toggles that persist.
  await page.locator('#twDurationBtn').click()
  await page.waitForTimeout(150)
  const presetCount = await page.locator('#twDurationSetter .tw-duration-presets button').count()
  record('duration setter shows the preset pills (10..90)', presetCount === 9, `count=${presetCount}`)
  await shot('01-timer-setter.png')
  const rem5Default = await page.locator('#twDurationSetter .tw-reminder[data-remind="5"]').evaluate((el) => el.classList.contains('on'))
  const rem1Default = await page.locator('#twDurationSetter .tw-reminder[data-remind="1"]').evaluate((el) => el.classList.contains('on'))
  record('reminders -5 and -1 are preset ON by default', rem5Default && rem1Default, `-5=${rem5Default} -1=${rem1Default}`)
  await page.locator('#twDurationSetter .tw-reminder[data-remind="10"]').click()
  await page.waitForTimeout(100)
  const rem10On = await page.locator('#twDurationSetter .tw-reminder[data-remind="10"]').evaluate((el) => el.classList.contains('on'))
  const remPersisted = await page.evaluate(() => {
    try {
      const k = Object.keys(sessionStorage).find((x) => x.endsWith(':timer'))
      return (JSON.parse(sessionStorage.getItem(k) || '{}').reminders || []).includes(10)
    } catch { return false }
  })
  record('toggling reminder -10 turns it on', rem10On, `on=${rem10On}`)
  record('reminder -10 persists to sessionStorage', remPersisted, `persisted=${remPersisted}`)
  await page.locator('#twDurationBtn').click() // close the setter so it doesn't cover later assertions
  await page.waitForTimeout(100)

  // (v0.7.3) Outline button opens the overview; key tooltips are present.
  await page.locator('#outlineBtn').click()
  await page.waitForTimeout(150)
  const outlineOpened = await page.locator('#presenterOutlineDrawer.open').count()
  record('Outline button opens the overview drawer', outlineOpened === 1, `open=${outlineOpened}`)
  await page.keyboard.press('Escape') // the open drawer covers the button; close via Esc (search has focus)
  await page.waitForTimeout(150)
  const nextKey = await page.locator('#presenterNext').getAttribute('data-key')
  const nextTitle = await page.locator('#presenterNext').getAttribute('title')
  const audKey = await page.locator('#presenterAudienceApp').getAttribute('data-key')
  record('Next button shows just its key (data-key="→", verbose title removed)', nextKey === '→' && !nextTitle, `key=${nextKey} title=${nextTitle}`)
  record('Audience button data-key is F5', audKey === 'F5', `key=${audKey}`)
  const nextHasIcon = await page.locator('#presenterNext .tw-btn-ico').count()
  const revealHasIcon = await page.locator('#presenterReveal .tw-btn-ico').count()
  record('control buttons carry icons (Next, Reveal)', nextHasIcon === 1 && revealHasIcon === 1, `next=${nextHasIcon} reveal=${revealHasIcon}`)
  // ? opens the shortcut cheat sheet; Esc closes it.
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur())
  await page.keyboard.press('?')
  await page.waitForTimeout(150)
  const cheatShown = await page.locator('#twShortcuts').evaluate((el) => !el.hidden)
  const cheatRows = await page.locator('#twShortcutsBody .tw-shortcuts-row').count()
  record('? opens the shortcuts cheat sheet with rows', cheatShown && cheatRows > 5, `shown=${cheatShown} rows=${cheatRows}`)
  await shot('07-shortcuts.png')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const cheatClosed = await page.locator('#twShortcuts').evaluate((el) => el.hidden)
  record('Esc closes the shortcuts cheat sheet', cheatClosed === true, `hidden=${cheatClosed}`)

  // ── Task 5: the single createOverview drawer (search+rank, Enter-jumps-closes, expand) ──
  // The old separate presenter grid overlay is folded in — it must be gone.
  const gridOverlayCount = await page.locator('#presenterGridOverlay').count()
  record('old #presenterGridOverlay no longer exists', gridOverlayCount === 0, `count=${gridOverlayCount}`)

  // ── Task 5b: the PRESENTER overview is now the same shared createOverview factory, mounted on
  // #presenterOutlineDrawer / #presenterOutline / #presenterSearch (bespoke renderer retired). We
  // are still on ?presenter=1 here. Same behaviours as standalone: O opens, title-rank first,
  // Enter jump-and-close, expand → thumbnail grid.
  const pressOPresenter = async () => {
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); document.body.focus?.() })
    await page.keyboard.press('o')
  }

  // (p1) Press O to open the presenter overview drawer (.open).
  await pressOPresenter()
  await page.waitForTimeout(150)
  const presenterOverviewOpen = await page.locator('#presenterOutlineDrawer.open').count()
  record('presenter: O opens #presenterOutlineDrawer (.open)', presenterOverviewOpen === 1, `openCount=${presenterOverviewOpen}`)

  // (p2) Type a query matching a TITLE slide and a body-only slide; the title slide ranks first.
  await page.locator('#presenterSearch').fill('method')
  await page.waitForTimeout(150)
  const presenterFirstRow = (await page.locator('#presenterOutline .slide-link').first().innerText()).trim()
  record('presenter: title match ranks first in #presenterOutline ("Method notes" before body-only "Results")',
    /method notes/i.test(presenterFirstRow), `firstRow=${JSON.stringify(presenterFirstRow)}`)

  // (p3) Enter jumps to the top result and closes the drawer (current slide changes).
  const presenterIndexBefore = await page.evaluate(() => {
    const on = document.querySelector('.slide.active')
    return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
  })
  await page.locator('#presenterSearch').press('Enter')
  await page.waitForTimeout(200)
  const presenterClosedAfterEnter = await page.locator('#presenterOutlineDrawer.open').count()
  const presenterIndexAfter = await page.evaluate(() => {
    const on = document.querySelector('.slide.active')
    return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
  })
  record('presenter: Enter closes #presenterOutlineDrawer (.open removed)', presenterClosedAfterEnter === 0, `openCount=${presenterClosedAfterEnter}`)
  record('presenter: Enter jumps — current slide changed', presenterIndexAfter !== presenterIndexBefore && presenterIndexAfter >= 0, `before=${presenterIndexBefore} after=${presenterIndexAfter}`)

  // (p4) Re-open and click #presenterOutlineExpand → the thumbnail grid appears with .tw-thumb.
  await pressOPresenter()
  await page.waitForTimeout(150)
  await page.locator('#presenterOutlineExpand').click()
  await page.waitForTimeout(150)
  const presenterGridPresent = await page.locator('#presenterOutline.tw-overview-grid').count()
  const presenterThumbCount = await page.locator('#presenterOutline .tw-thumb').count()
  record('presenter: #presenterOutlineExpand shows the thumbnail grid (.tw-overview-grid)', presenterGridPresent === 1, `gridCount=${presenterGridPresent}`)
  record('presenter: expanded grid holds .tw-thumb children', presenterThumbCount > 0, `thumbs=${presenterThumbCount}`)

  // (v0.7.1 fix 2) The cloned slide inside a thumbnail must actually RENDER — not display:none
  // (black box). Check computed display + a non-zero rendered box on a real thumbnail's slide.
  const presenterThumbViz = await page.evaluate(() => {
    const slide = document.querySelector('#presenterOutline .tw-thumb .slide')
    if (!slide) return { found: false }
    const cs = getComputedStyle(slide)
    const r = slide.getBoundingClientRect()
    return { found: true, display: cs.display, w: Math.round(r.width), h: Math.round(r.height) }
  })
  record('presenter: thumbnail slide renders (display != none, non-zero box)',
    presenterThumbViz.found && presenterThumbViz.display !== 'none' && presenterThumbViz.w > 1 && presenterThumbViz.h > 1,
    JSON.stringify(presenterThumbViz))
  await shot('02-presenter-overview-expanded.png')

  // ── Task 7: shown/skipped tracking + overview markers (presenter-only) ──
  // Reload fresh so earlier overview jumps (p1-p4 above) don't pollute the shown/skipped scene,
  // then clear the persisted progress explicitly (sessionStorage survives a same-path reload).
  await page.goto(presentUrl)
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)

  const activeSlideIndex = () => page.evaluate(() => {
    const on = document.querySelector('.slide.active')
    return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
  })

  // On arrival (index 0) is recorded shown immediately — confirmed via the overview below.
  record('progress scene starts on slide 0', (await activeSlideIndex()) === 0, `index=${await activeSlideIndex()}`)

  // Step Next twice: 0 (title) -> 1 ("Opening slide") -> 2 ("Second slide").
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(100)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(100)
  const afterSteps = await activeSlideIndex()
  record('after two Next presses, on slide index 2', afterSteps === 2, `index=${afterSteps}`)

  // Jump straight to "Discussion" (index 5 — the compiled deck prepends an auto title slide at
  // index 0, so "Opening slide"/"Second slide" sit at 1/2) via the overview search. This leaves
  // indices 3,4 ("Method notes", "Results") as a jumped-over gap; index 6 ("Wrap up") is unseen.
  await pressOPresenter()
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').fill('discussion')
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').press('Enter')
  await page.waitForTimeout(200)
  const afterJump = await activeSlideIndex()
  record('jump via overview search lands on "Discussion" (index 5)', afterJump === 5, `index=${afterJump}`)

  // Open the overview and inspect each slide-link's status class. Rows render in original
  // (unfiltered) order when the search field is empty, so pos === slide index here — clear the
  // leftover "discussion" query from the jump above so all slides are visible.
  await pressOPresenter()
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').fill('')
  await page.waitForTimeout(150)
  const rowClasses = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#presenterOutline .slide-link')).map((el) => el.className)
  )
  const hasClass = (i, cls) => (rowClasses[i] || '').split(/\s+/).includes(cls)

  record('slide 0 (title, visited) carries .tw-shown', hasClass(0, 'tw-shown'), `classes=${rowClasses[0]}`)
  record('slide 1 (Opening, visited) carries .tw-shown', hasClass(1, 'tw-shown'), `classes=${rowClasses[1]}`)
  record('slide 2 (Second, visited) carries .tw-shown', hasClass(2, 'tw-shown'), `classes=${rowClasses[2]}`)
  record('slide 3 (Method notes, jumped-over gap) carries .tw-skipped', hasClass(3, 'tw-skipped'), `classes=${rowClasses[3]}`)
  record('slide 4 (Results, jumped-over gap) carries .tw-skipped', hasClass(4, 'tw-skipped'), `classes=${rowClasses[4]}`)
  record('slide 5 (Discussion, jump target, visited) carries .tw-shown', hasClass(5, 'tw-shown'), `classes=${rowClasses[5]}`)
  record('slide 6 (Wrap up, not yet reached) carries .tw-unseen', hasClass(6, 'tw-unseen'), `classes=${rowClasses[6]}`)

  await pressOPresenter() // close again so it doesn't interfere with anything after this block

  // ── Task 8: skip-next ("S") — jump past the next slide, marking it explicitly skipped ──
  // Reload fresh so the Task 7 progress scene's jumps don't pollute this one.
  await page.goto(presentUrl)
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)

  // Start on an early slide (index 1, "Opening slide") via Next, then capture the index.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(100)
  const skipStartIndex = await activeSlideIndex()
  record('skip-next scene starts on slide index 1 ("Opening slide")', skipStartIndex === 1, `index=${skipStartIndex}`)

  // Press S: should advance by exactly TWO (skipping index 2, landing on index 3).
  await page.keyboard.press('s')
  await page.waitForTimeout(150)
  const skipEndIndex = await activeSlideIndex()
  record('S advances current slide by exactly two (skip-next)', skipEndIndex === skipStartIndex + 2, `before=${skipStartIndex} after=${skipEndIndex}`)

  // Open the presenter overview and inspect the skipped-over row (index 2, "Second slide").
  await pressOPresenter()
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').fill('')
  await page.waitForTimeout(150)
  const skipRowInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#presenterOutline .slide-link'))
    const el = rows[2]
    return el ? { className: el.className, title: el.title } : null
  })
  record('skipped-over slide (index 2) carries .tw-skipped',
    !!skipRowInfo && skipRowInfo.className.split(/\s+/).includes('tw-skipped'), `row=${JSON.stringify(skipRowInfo)}`)
  record('skipped-over slide (index 2) title reads "skipped (explicit)"',
    !!skipRowInfo && skipRowInfo.title === 'skipped (explicit)', `title=${JSON.stringify(skipRowInfo && skipRowInfo.title)}`)

  await pressOPresenter() // close again so it doesn't interfere with anything after this block

  // ── v0.7.1 CRITICAL regression: after an Enter-jump the deck must be NAVIGABLE. The shipped bug:
  // close() left focus on the (transform-hidden) search input, so handleKey's input-guard swallowed
  // every nav key. This scene deliberately does NOT manually blur before ArrowRight — that manual
  // blur (in pressOPresenter/pressO) is exactly what masked the bug in the earlier tests.
  await page.goto(presentUrl)
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)
  await pressOPresenter()
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').fill('discussion')
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').press('Enter')
  await page.waitForTimeout(200)
  const focusReleased = await page.evaluate(() => {
    const d = document.getElementById('presenterOutlineDrawer')
    return !(d && document.activeElement && d.contains(document.activeElement))
  })
  record('regression: after Enter-jump, focus is released from the drawer', focusReleased, `released=${focusReleased}`)
  const navBefore = await activeSlideIndex()
  await page.keyboard.press('ArrowRight') // NO manual blur — the real user flow that was broken
  await page.waitForTimeout(150)
  const navAfter = await activeSlideIndex()
  record('regression: ArrowRight AFTER Enter-jump advances the slide (nav keys alive)',
    navAfter === navBefore + 1, `before=${navBefore} after=${navAfter}`)

  // ── v0.7.2: Return button (B) + resume-on-reopen ──
  // Fresh state: clear sessionStorage AND any persisted resume/session keys, then reload.
  await page.goto(presentUrl)
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.evaluate(() => {
    sessionStorage.clear()
    Object.keys(localStorage).filter((k) => k.includes(':resume') || k.includes(':session')).forEach((k) => localStorage.removeItem(k))
  })
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)

  // Return: only overview jumps > 1 slide arm it.
  const returnHidden0 = await page.locator('#returnBtn').evaluate((el) => el.hidden)
  record('Return button hidden before any jump', returnHidden0 === true, `hidden=${returnHidden0}`)
  await page.keyboard.press('ArrowRight') // to slide 1 (a normal step must NOT arm Return)
  await page.waitForTimeout(100)
  const returnHiddenAfterStep = await page.locator('#returnBtn').evaluate((el) => el.hidden)
  record('Return button stays hidden after a normal ArrowRight step', returnHiddenAfterStep === true, `hidden=${returnHiddenAfterStep}`)
  const returnOrigin = await activeSlideIndex()
  await pressOPresenter()
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').fill('discussion')
  await page.waitForTimeout(150)
  await page.locator('#presenterSearch').press('Enter')
  await page.waitForTimeout(200)
  const returnJumped = await activeSlideIndex()
  const returnShown = await page.locator('#returnBtn').evaluate((el) => !el.hidden)
  record('Return button appears after an overview jump > 1 slide', returnShown && Math.abs(returnJumped - returnOrigin) > 1, `origin=${returnOrigin} jumped=${returnJumped} shown=${returnShown}`)
  await shot('04-return-button.png')
  await page.keyboard.press('b') // NO manual blur — relies on the focus-release fix + the B binding
  await page.waitForTimeout(150)
  const afterReturn = await activeSlideIndex()
  const returnHiddenAfterUse = await page.locator('#returnBtn').evaluate((el) => el.hidden)
  record('B returns to the pre-jump slide', afterReturn === returnOrigin, `origin=${returnOrigin} after=${afterReturn}`)
  record('Return button hides after returning', returnHiddenAfterUse === true, `hidden=${returnHiddenAfterUse}`)

  // Resume-on-reopen: move to a slide, then simulate a window CLOSE+REOPEN (drop sessionStorage but
  // keep localStorage), which must offer to resume.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(100)
  const beforeClose = await activeSlideIndex()
  await page.evaluate(() => sessionStorage.clear()) // window close loses sessionStorage; localStorage persists
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(300)
  const resumeShown = await page.locator('#twResume').evaluate((el) => !el.hidden)
  const resumeSlideText = await page.locator('#twResumeSlide').innerText().catch(() => '')
  record('resume prompt appears on reopen (fresh window + recent state)', resumeShown, `shown=${resumeShown} slideLabel=${resumeSlideText}`)
  await shot('05-resume-prompt.png')
  await page.locator('#twResumeYes').click()
  await page.waitForTimeout(200)
  const afterResume = await activeSlideIndex()
  record('Resume jumps to the saved slide', afterResume === beforeClose, `saved=${beforeClose} after=${afterResume}`)

  // A same-window RELOAD (sessionStorage intact) must NOT prompt.
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)
  const promptOnReload = await page.locator('#twResume').evaluate((el) => !el.hidden)
  record('no resume prompt on a same-window reload', promptOnReload === false, `shown=${promptOnReload}`)

  // Stale saved state (older than the window) must NOT prompt — it is a different run.
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.endsWith(':resume'))
    if (k) { const v = JSON.parse(localStorage.getItem(k)); v.updatedAt = Date.now() - 6 * 60 * 60 * 1000; localStorage.setItem(k, JSON.stringify(v)) }
    sessionStorage.clear()
  })
  await page.reload()
  await page.waitForSelector('#twClock', { timeout: 8000 })
  await page.waitForTimeout(200)
  const promptWhenStale = await page.locator('#twResume').evaluate((el) => !el.hidden)
  record('no resume prompt when the saved state is stale (> window)', promptWhenStale === false, `shown=${promptWhenStale}`)

  // Switch to STANDALONE mode (no ?presenter=1): #overviewDrawer is CSS-hidden in presenter mode,
  // where the presenter uses its own #presenterOutlineDrawer instead (see task-5-report escalation).
  await page.goto(standaloneUrl)
  await page.waitForSelector('#overviewDrawer', { timeout: 8000 })
  await page.waitForTimeout(200)

  // The global key handler ignores events whose target is an input/textarea/select, so before each
  // "O" we blur any focused field by pressing the key on document.body via the keyboard.
  const pressO = async () => {
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); document.body.focus?.(); })
    await page.keyboard.press('o')
  }

  // (e) Press O to open the overview drawer.
  await pressO()
  await page.waitForTimeout(150)
  const overviewOpen = await page.locator('#overviewDrawer.open').count()
  record('O opens the overview drawer (.open)', overviewOpen === 1, `openCount=${overviewOpen}`)

  // (f) Type a query matching a TITLE slide and a body-only slide; the title slide ranks first.
  await page.locator('#overviewSearch').fill('method')
  await page.waitForTimeout(150)
  const firstRowText = (await page.locator('#overviewList .slide-link').first().innerText()).trim()
  record('title match ranks first in #overviewList ("Method notes" before body-only "Results")',
    /method notes/i.test(firstRowText), `firstRow=${JSON.stringify(firstRowText)}`)

  // (g) Enter jumps to the top result and closes the drawer (slide changes).
  const indexBefore = await page.evaluate(() => {
    const on = document.querySelector('.slide.active')
    return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
  })
  await page.locator('#overviewSearch').press('Enter')
  await page.waitForTimeout(200)
  const overviewClosedAfterEnter = await page.locator('#overviewDrawer.open').count()
  const indexAfter = await page.evaluate(() => {
    const on = document.querySelector('.slide.active')
    return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
  })
  record('Enter closes the overview drawer (.open removed)', overviewClosedAfterEnter === 0, `openCount=${overviewClosedAfterEnter}`)
  record('Enter jumps: current slide changed', indexAfter !== indexBefore && indexAfter >= 0, `before=${indexBefore} after=${indexAfter}`)

  // (h) Re-open and click #overviewExpand → the thumbnail grid appears with .tw-thumb children.
  await pressO()
  await page.waitForTimeout(150)
  await page.locator('#overviewExpand').click()
  await page.waitForTimeout(150)
  const gridPresent = await page.locator('#overviewList.tw-overview-grid').count()
  const thumbCount = await page.locator('#overviewList .tw-thumb').count()
  record('#overviewExpand shows the thumbnail grid (.tw-overview-grid)', gridPresent === 1, `gridCount=${gridPresent}`)
  record('expanded grid holds .tw-thumb children', thumbCount > 0, `thumbs=${thumbCount}`)
  const standaloneThumbViz = await page.evaluate(() => {
    const slide = document.querySelector('#overviewList .tw-thumb .slide')
    if (!slide) return { found: false }
    const cs = getComputedStyle(slide)
    const r = slide.getBoundingClientRect()
    return { found: true, display: cs.display, w: Math.round(r.width), h: Math.round(r.height) }
  })
  record('standalone: thumbnail slide renders (display != none, non-zero box)',
    standaloneThumbViz.found && standaloneThumbViz.display !== 'none' && standaloneThumbViz.w > 1 && standaloneThumbViz.h > 1,
    JSON.stringify(standaloneThumbViz))
  await shot('03-standalone-overview-expanded.png')
} catch (e) {
  record('presenter-qol harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  if (consoleErrors.length) {
    console.log('\n=== RENDERER CONSOLE ERRORS ===')
    consoleErrors.slice(-20).forEach((e) => console.log('  ' + e))
  }
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== PRESENTER QoL SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
