// The participant work page (work-files ticket 15; mockup section 13) in headless Chromium, served the way a
// host serves it (its Content-Security-Policy header and its own <meta>), against a stand-in for the
// Worker's routes. Seams: the page's DOM on a laptop (1280x800: rail with the handout link, step card, ask
// column) and a phone (390x844: top bar, handout link under it, step, bottom navigation), and the policy as
// the browser enforces it.
//   - a laptop and a phone each do the pre-work: a video that plays (a no-cookie player gets its src), a
//     quick check saved with no mark, a task marked done, an open answer, a question with a name;
//   - coming back: "N of 4 done" and every earlier answer;
//   - post-work is headed "After the session"; "Ask about this step" stays, `{noask}` turns it off;
//   - closed: the 0.37 closed banner, with the count; withdrawn: "This page is not available";
//   - every author and Run text written as text; an injected handler or inline script does not run (CSP);
//     Mermaid draws under the policy and its markup does not run.
// The real Worker is test-work-page-live.mjs.
// Usage: node scripts/work-page-dom.test.mjs   (SHOTS=<dir> saves a few states)
import { mkdir } from 'node:fs/promises'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { buildWorkPageFixture, COMPILER_DIR, PRE_WORK, TASK_PICTURE } from './lib/work-page-fixture.mjs'
import { fakePreworkWorker } from './lib/prework-fake-worker.mjs'
import { buildWorkPage } from '../compiler/scripts/lib/work-page.mjs'
import { compileWorkFile } from '../src/main/work-file-compile.ts'

const BASE = 'https://worker.example.test'
const SITE = 'https://handouts.example.test/dl/said-21-oct'
const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PLAYER = '<!doctype html><title>player</title><body style="margin:0;background:#141c27"></body>'
const LAPTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })
const failures = []
const check = (ok, label) => { if (!ok) { failures.push(label); console.log(`FAIL  ${label}`) } else console.log(`PASS  ${label}`) }
const browser = await chromium.launch()
const pages = new Map()
async function pageFor(phase, preworkId, options = {}) {
  const key = `${phase}:${preworkId}:${options.text ? 'custom' : ''}`
  if (!pages.has(key)) pages.set(key, options.built ?? await buildWorkPageFixture({ phase, preworkId, workerBaseUrl: BASE, handoutUrl: SITE, ...options }))
  return pages.get(key)
}

/** A person's browser on the page: `header` false serves the page with no policy header (its <meta> only). */
async function visit(viewport, { phase = 'pre', preworkId = phase === 'post' ? 'wppost0001' : 'wppre00001', state = 'open', people, seed = [], header = true, withdrawn = false, built, text, talkTitle, runLine } = {}) {
  const page0 = await pageFor(phase, preworkId, { built, text, talkTitle, runLine })
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'Europe/London' })
  await context.addInitScript(([key, id]) => { try { window.localStorage.setItem(key, id) } catch (_) {} }, [`tw-prework-device-${preworkId}`, DEVICE])
  const world = await fakePreworkWorker(context, { baseUrl: BASE, preworkId, state, people, phase, withdrawn })
  if (seed.length) world.seed(DEVICE, seed)
  const url = `${SITE}/${phase}-work`
  const headers = { 'content-type': 'text/html; charset=utf-8', ...(header ? page0.headers : {}) }
  await context.route(url, (route) => route.fulfill({ status: 200, headers, body: page0.html }))
  const framed = []
  await context.route('https://www.youtube-nocookie.com/**', (route) => { framed.push(route.request().url()); return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: PLAYER }) })
  await context.route('https://evil.example/**', (route) => { framed.push(route.request().url()); return route.fulfill({ status: 200, body: 'x' }) })
  const page = await context.newPage()
  const errors = []
  const violations = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('requestfailed', (request) => errors.push(`request failed: ${request.url().slice(0, 120)}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
    else errors.push(message.text())
  })
  await page.goto(url)
  return { context, page, world, errors, violations, framed, close: () => context.close() }
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
const text = (page, selector) => page.locator(selector).first().innerText()
const ready = (page) => page.waitForSelector('[data-wp-cta], .wp-thanks, .wp-message[data-wp-state]:not([data-wp-state=loading])')
const stepTo = async (page, n) => { await page.click(`.wp-row[data-step="${n}"]`); await page.waitForSelector('.wp-content') }
const saved = (page) => page.waitForFunction(() => { const note = document.querySelector('.wp-note'); return note && !note.hidden && note.innerText.includes('Sent to the speaker') })
const byRef = (world) => Object.fromEntries(world.all().filter((entry) => entry.kind !== 'question').map((entry) => [entry.ref, entry]))
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)

// ── A laptop does the pre-work ──────────────────────────────────────────────────────────────────
{
  const s = await visit(LAPTOP)
  const { page, world } = s
  await ready(page)
  check((await text(page, '.wp-rail .wp-talk-title')) === 'AI for research teams', 'laptop: the rail names the talk')
  check((await text(page, '.wp-rail .wp-runline')) === 'Saïd workshop · Wed 21 Oct, 14:00', 'laptop: and the Run')
  check(/^0 of 4 done · closes /.test(await text(page, '.wp-railcount')), 'laptop: "0 of 4 done · closes …"')
  check((await page.locator('.wp-rail .wp-row').count()) === 4, 'laptop: a rail of four steps')
  const handout = page.locator('.wp-rail a.wp-handout')
  check((await handout.getAttribute('href')) === SITE, 'laptop: the rail links back to the session handout')
  check((await handout.innerText()).includes('Session handout') && (await handout.innerText()).includes('handouts.example.test/dl/said-21-oct'), 'laptop: the link says what it is and where')
  check((await text(page, '.wp-title')) === 'Research teams intake', 'laptop: the overview names the work file')
  check((await text(page, '.wp-intro')).startsWith('Four short steps before we meet.'), 'laptop: the intro as written')
  check((await text(page, '[data-wp-cta]')) === 'Start with step 1', 'laptop: Start with step 1')
  await page.click('[data-wp-cta]')
  await page.waitForSelector('.wp-centerhead')
  check((await text(page, '.wp-centerhead .wp-stepno')) === 'Step 1 of 4', 'laptop: step 1 of 4')
  check((await text(page, '.wp-centerhead .wp-kind')) === 'Video', 'laptop: a video step')
  await page.waitForFunction(() => document.querySelector('.wp-media iframe[src]'))
  const src = await page.locator('.wp-media iframe').getAttribute('src')
  check(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/.test(src), 'laptop: the video plays in the page: the player\'s data-src became its src')
  await page.waitForTimeout(300)
  check(s.framed.length === 1 && s.framed[0].startsWith('https://www.youtube-nocookie.com/embed/'), 'laptop: the player is the only frame loaded')
  check((await text(page, '.wp-askcol .wp-ask-title')) === 'Ask about this step', 'laptop: the ask column')
  check((await page.locator('.wp-askcol .wp-small').first().innerText()).startsWith('Stuck, or not sure what is meant?'), 'laptop: it invites a question')
  check(!world.submits.some((body) => body.kind === 'read'), 'laptop: a step is not marked read while it is open (mockup: "To do")')
  await shot(page, 'laptop-step-1-video')
  // a question with a name, from the column
  await page.fill('.wp-asktext', 'Is the video also on the handout?')
  await page.fill('.wp-name', 'Alex')
  await page.click('.wp-askcol .wp-send')
  await page.waitForSelector('.wp-yourq')
  const question = world.all().find((entry) => entry.kind === 'question')
  check(question && question.stepId === 'watch' && question.text === 'Is the video also on the handout?' && question.name === 'Alex', 'laptop: a question reaches the Worker with its step and the name typed')
  // the quick check
  await page.click('.wp-next')
  await page.waitForSelector('.wp-q .pw-opt')
  check(byRef(world)['read:watch'] !== undefined, 'laptop: moving on marks the video read')
  check(/^1 of 4 done/.test(await text(page, '.wp-railcount')), 'laptop: "1 of 4 done"')
  await page.locator('.pw-opt').nth(1).click()
  await saved(page)
  check(/^Sent to the speaker at \d\d:\d\d\. You will see how everyone answered in the session\.$/.test(await text(page, '.wp-note')), 'laptop: the quick check is sent with no mark, and says when')
  check(!/correct|wrong|right answer|score/i.test(await page.locator('.wp-center').innerText()), 'laptop: no mark anywhere')
  const answer = byRef(world)['answer:quick-check']
  check(answer && answer.choice === 'poll-quick-check-option-2', 'laptop: the answer reached the Worker as an anonymous entry')
  // the task: a slide drawn in the card, Mark as done
  await page.keyboard.press('ArrowRight')
  await page.waitForSelector('.wp-canvas .slide')
  check((await text(page, '.wp-centerhead .wp-kind')) === 'Task · about 20 min', 'laptop: a task, drawn as its slide')
  check((await page.locator('.wp-canvas .slide img').count()) === 1 && (await page.locator('.wp-canvas .slide .fl-numbered li').count()) === 4, 'laptop: title + picture beside the numbered steps')
  await page.click('.wp-done')
  await page.waitForSelector('.wp-done.is-done')
  await page.waitForTimeout(200)
  check(byRef(world)['done:try-a-prompt'] && byRef(world)['done:try-a-prompt'].done === true, 'laptop: Mark as done is saved')
  // the open question
  await page.click('.wp-next')
  await page.fill('.pw-text', 'A way to check what it got wrong.')
  await saved(page)
  check(byRef(world)['answer:what-you-want'] && byRef(world)['answer:what-you-want'].text === 'A way to check what it got wrong.', 'laptop: the open answer is saved as the person types')
  await page.click('.wp-next')
  await page.waitForSelector('.wp-thanks')
  check((await text(page, '.wp-thanks-title')) === 'All done. Thank you.', 'laptop: Finish gives the thank-you')
  check(/^4 of 4 done/.test(await text(page, '.wp-railcount')), 'laptop: "4 of 4 done"')
  const dump = JSON.stringify(world.submits)
  check(!/"right"|correct/i.test(dump), 'laptop: nothing the page sent carries a right answer')
  check(!(await overflow(page)), 'laptop: no horizontal scroll')
  check(s.errors.length === 0 && s.violations.length === 0, `laptop: no page errors or policy reports (${[...s.errors, ...s.violations].join('; ')})`)
  // coming back
  const again = await s.context.newPage()
  await again.goto(`${SITE}/pre-work`)
  await again.waitForSelector('.wp-thanks')
  check(/^4 of 4 done/.test(await text(again, '.wp-railcount')), 'coming back: "4 of 4 done" from the Worker')
  check((await again.locator('.wp-rail .wp-state').allInnerTexts()).every((label) => label.trim() === 'Done'), 'coming back: every step Done')
  await stepTo(again, 2)
  await again.waitForSelector('.pw-opt.is-on')
  check((await again.locator('.pw-opt.is-on').innerText()).includes('The title'), 'coming back: the earlier answer is on the step')
  check((await again.locator('.wp-yourq').count()) === 0, 'coming back: a question about another step is not on this one')
  await stepTo(again, 1)
  check((await again.locator('.wp-yourq-text').innerText()) === 'Is the video also on the handout?', 'coming back: the earlier question is on its step')
  await s.close()
}

// ── A phone does the pre-work, and comes back part-way ───────────────────────────────────────────
{
  const s = await visit(PHONE)
  const { page, world } = s
  await ready(page)
  check((await page.locator('.wp-top').count()) === 1 && (await page.locator('.wp-rail').count()) === 0, 'phone: a top bar, no rail')
  check((await page.locator('.wp-ctx a.wp-ctx-link').getAttribute('href')) === SITE, 'phone: the handout link sits under the top bar')
  check((await text(page, '.wp-ctx-text')) === 'AI for research teams · Saïd workshop', 'phone: the context line')
  await page.click('[data-wp-cta]')
  await page.waitForSelector('.wp-nav')
  check((await text(page, '.wp-top .wp-stepno')) === 'Step 1 of 4', 'phone: Step 1 of 4 in the top bar')
  check((await page.locator('.wp-nav .wp-ask').count()) === 1, 'phone: Ask about this in the bottom bar')
  await page.waitForFunction(() => document.querySelector('.wp-media iframe[src]'))
  await page.click('.wp-next')
  await page.locator('.pw-opt').nth(0).click()
  await saved(page)
  await page.click('.wp-next')
  await page.waitForSelector('.wp-media img')
  check((await page.locator('.wp-slide-text ol li').count()) === 4, 'phone: the task\'s slide stacks: title, picture, then the numbered steps')
  const stacked = await page.evaluate(() => { const img = document.querySelector('.wp-media img').getBoundingClientRect(); const list = document.querySelector('.wp-slide-text').getBoundingClientRect(); return list.top >= img.bottom - 1 && img.width > 300 })
  check(stacked, 'phone: the picture is full width and the steps are under it')
  check(!(await overflow(page)), 'phone: no horizontal scroll')
  // ask from the sheet
  await page.click('.wp-nav .wp-ask')
  await page.fill('.wp-sheet textarea', 'Which paper is best?')
  await page.click('.wp-sheet .wp-send')
  await page.waitForSelector('.wp-sent')
  check(world.all().some((entry) => entry.kind === 'question' && entry.stepId === 'try-a-prompt' && !('name' in entry)), 'phone: a question with no name keeps no name')
  await page.click('.wp-sheet-actions .is-primary')
  await page.close()
  // back later: 2 of 4
  const again = await s.context.newPage()
  await again.goto(`${SITE}/pre-work`)
  await again.waitForSelector('[data-wp-cta]')
  check((await again.locator('.wp-welcome').innerText()).includes('Welcome back: 2 of 4 done'), 'phone, coming back: "2 of 4 done"')
  check((await text(again, '[data-wp-cta]')) === 'Carry on: step 3', 'phone, coming back: Carry on goes to the first step not done')
  await again.click('[data-wp-cta]')
  await again.click('.wp-prev')
  await again.waitForSelector('.pw-opt.is-on')
  check((await again.locator('.pw-opt.is-on').innerText()).includes('The caveats and limitations'), 'phone, coming back: the earlier answer shows')
  check(s.errors.length === 0 && s.violations.length === 0, `phone: no page errors or policy reports (${[...s.errors, ...s.violations].join('; ')})`)
  await s.close()
}

// ── Post-work: "After the session"; ask stays; {noask} ──────────────────────────────────────────
{
  const s = await visit(LAPTOP, { phase: 'post' })
  const { page, world } = s
  await ready(page)
  check((await text(page, '.wp-rail .wp-eyebrow')) === 'AFTER THE SESSION' || (await text(page, '.wp-rail .wp-eyebrow')) === 'After the session', 'post, laptop: headed After the session')
  check(/ · open until /.test(await text(page, '.wp-railcount')), 'post, laptop: "open until …"')
  check((await page.title()).startsWith('After the session'), 'post: the page title')
  await stepTo(page, 1)
  check((await text(page, '.wp-centerhead .wp-kind')) === 'Rating · 1 to 5', 'post: a 1 to 5 rating')
  check((await page.locator('.pw-answer.is-scale .pw-opt').allInnerTexts()).join(',') === '1,2,3,4,5', 'post: the scale shows its numbers')
  check((await page.locator('.wp-scale-ends').innerText()).replace(/\s+/g, ' ') === '1 · not useful 5 · very useful', 'post: and its ends in words')
  await page.locator('.pw-opt').nth(3).click()
  await saved(page)
  check(/^Sent to the speaker at \d\d:\d\d\. You can change it until post-work closes on .+, \d\d:\d\d\.$/.test(await text(page, '.wp-note')), 'post: sent, and can change until post-work closes')
  check(byRef(world)['answer:useful'] && JSON.stringify(byRef(world)['answer:useful'].choice) === '{"poll-useful-option-1":"poll-useful-label-4"}', 'post: the rating reached the Worker')
  check((await page.locator('.wp-askcol textarea').count()) === 1, 'post, laptop: Ask about this step stays')
  await page.fill('.wp-asktext', 'Will the slides be shared?')
  await page.click('.wp-askcol .wp-send')
  await page.waitForSelector('.wp-yourq')
  check(world.all().some((entry) => entry.kind === 'question' && entry.stepId === 'useful'), 'post: a question about a post-work step reaches the Worker')
  await stepTo(page, 3)
  check((await text(page, '.wp-askcol .wp-small')) === 'Questions are off for this step.' && (await page.locator('.wp-askcol textarea').count()) === 0, 'post, laptop: {noask} turns the column off')
  await shot(page, 'post-laptop')
  await s.close()
  const p = await visit(PHONE, { phase: 'post' })
  await ready(p.page)
  check((await text(p.page, '.wp-ctx-eyebrow')) === 'After the session', 'post, phone: "After the session" under the top bar')
  await stepTo(p.page, 1)
  check((await p.page.locator('.wp-nav .wp-ask').count()) === 1, 'post, phone: Ask about this stays')
  await p.page.click('.wp-next'); await p.page.click('.wp-next')
  check((await p.page.locator('.wp-nav .wp-ask').count()) === 0, 'post, phone: {noask} removes it')
  check(p.errors.length === 0 && p.violations.length === 0, `post: no page errors or policy reports (${[...p.errors, ...p.violations].join('; ')})`)
  await p.close()
}

// ── Closed, closing while someone answers, withdrawn ─────────────────────────────────────────────
{
  const s = await visit(PHONE, { state: 'closed', people: 12 })
  await s.page.waitForSelector('.pw-closed')
  const banner = await text(s.page, '.pw-closed')
  check(/Pre-work closed/.test(banner) && /12 people took part\./.test(banner), 'closed: the 0.37 banner, with how many took part')
  check((await s.page.locator('.wp-ctx-link').count()) >= 1, 'closed: the handout is a tap away')
  await s.close()
  const p = await visit(LAPTOP, { phase: 'post', state: 'closed', people: 1 })
  await p.page.waitForSelector('.pw-closed')
  check(/Post-work closed/.test(await text(p.page, '.pw-closed')) && /1 person took part\./.test(await text(p.page, '.pw-closed')), 'closed post-work: "Post-work closed"')
  await p.close()
  const c = await visit(LAPTOP)
  await ready(c.page)
  await stepTo(c.page, 2)
  c.world.state = 'closed'
  c.world.people = 3
  await c.page.locator('.pw-opt').nth(0).click()
  await c.page.waitForSelector('.pw-closed')
  check(/3 people took part/.test(await text(c.page, '.pw-closed')), 'closing while someone answers: the refused save gives way to the banner')
  await c.close()
  const w = await visit(PHONE, { withdrawn: true })
  await w.page.waitForSelector('.wp-message[data-wp-state=unavailable]')
  check((await text(w.page, '.wp-message .wp-title')) === 'This page is not available', 'withdrawn: "This page is not available"')
  await w.close()
}

// ── Untrusted text is text; the policy holds in the browser ───────────────────────────────────────
{
  const hostile = '<img src=x onerror="window.__pwned=1">'
  const text0 = PRE_WORK.replace('Four short steps before we meet.', `Intro ${hostile}`).replace('- The title', `- The title ${hostile}`).replace('### Quick check', `### Quick check ${hostile}`)
  const s = await visit(LAPTOP, { preworkId: 'wppre00099', text: text0, talkTitle: `Talk ${hostile}`, runLine: `Run ${hostile}` })
  const { page } = s
  await ready(page)
  check((await text(page, '.wp-rail .wp-talk-title')) === `Talk ${hostile}`, 'text: the talk title shows as written')
  check((await text(page, '.wp-rail .wp-runline')) === `Run ${hostile}`, 'text: the run line too')
  check((await text(page, '.wp-intro')).startsWith(`Intro ${hostile} About twenty minutes`), 'text: and the intro')
  await stepTo(page, 2)
  check((await text(page, '.wp-step-title')) === `Quick check ${hostile}`, 'text: a step title')
  check((await page.locator('.pw-opt').nth(1).innerText()) === `The title ${hostile}`, 'text: a poll label')
  check((await page.locator('.wp img').count()) === 0, 'text: none of it became an element')
  // The policy: an injected handler and an inline script do not run (as they would without it).
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<img src="data:," onerror="window.__pwned=2" onload="window.__pwned=2">')
    const script = document.createElement('script'); script.textContent = 'window.__pwned = 3'; document.body.appendChild(script)
    const frame = document.createElement('iframe'); frame.src = 'https://evil.example/frame'; document.body.appendChild(frame)
  })
  await page.waitForTimeout(400)
  check((await page.evaluate(() => window.__pwned)) === undefined, 'policy: no injected handler or inline script ran')
  check(s.violations.length >= 2, `policy: the browser reported the blocked script and frame (${s.violations.length})`)
  check(!s.framed.some((url) => url.startsWith('https://evil.example/')), 'policy: a frame from any other host is not loaded')
  await s.close()
  // the <meta> alone, with no header (a host that cannot send one)
  const m = await visit(LAPTOP, { header: false })
  await ready(m.page)
  await m.page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<img src="data:," onload="window.__pwned=4">'); const script = document.createElement('script'); script.textContent = 'window.__pwned = 5'; document.body.appendChild(script) })
  await m.page.waitForTimeout(300)
  check((await m.page.evaluate(() => window.__pwned)) === undefined && (await m.page.locator('[data-wp-cta]').count()) === 1, 'policy: the <meta> alone runs the page and blocks injected script')
  await m.close()
}

// ── Mermaid under the policy ──────────────────────────────────────────────────────────────────────
{
  const text0 = PRE_WORK.replace('### What do you most want from the session?', '### A diagram\n{id=diagram}\n\n```mermaid\ngraph TD; A["<img src=x onerror=window.__pwned=9>"]-->B[Done]\n```\n\n### What do you most want from the session?')
  const dir = mkdtempSync(join(tmpdir(), 'tw-work-page-mmd-'))
  writeFileSync(join(dir, 'paper-and-chat.svg'), TASK_PICTURE)
  const compiled = await compileWorkFile({ compilerDir: COMPILER_DIR, path: join(dir, 'work.md'), text: text0 })
  rmSync(dir, { recursive: true, force: true })
  const built = buildWorkPage({ phase: 'pre', preworkId: 'wppre00777', workerBaseUrl: BASE, form: compiled.form, steps: compiled.steps, styles: compiled.styles, talkTitle: 'T', handoutUrl: SITE })
  const s = await visit(LAPTOP, { preworkId: 'wppre00777', built })
  await ready(s.page)
  await stepTo(s.page, 4)
  await s.page.waitForSelector('.mermaid-mm svg', { timeout: 15_000 })
  check((await s.page.locator('.mermaid-mm svg').count()) === 1, 'mermaid: a diagram draws under the page\'s policy')
  await s.page.waitForTimeout(300)
  check((await s.page.evaluate(() => window.__pwned)) === undefined && (await s.page.locator('.mermaid-mm img, .mermaid-mm foreignObject, .mermaid-mm script').count()) === 0, 'mermaid: markup in a label does not run or become an element')
  check(s.errors.length === 0, `mermaid: no page errors (${s.errors.join('; ')})`)
  await s.close()
}

// ── Mark as done: at the top of the step, and from the end page ──────────────────────────────────
for (const [name, viewport] of [['laptop', LAPTOP], ['phone', PHONE]]) {
  const s = await visit(viewport)
  const { page, world } = s
  await ready(page)
  await page.click('[data-wp-cta]')
  await page.waitForSelector('.wp-content')
  const isPhone = name === 'phone'
  const next = async () => { await page.click('.wp-next'); await page.waitForTimeout(150) }
  await next(); await next()
  await page.waitForSelector('.wp-donetop .wp-done')
  const control = await page.locator('.wp-donetop .wp-done').boundingBox()
  const content = await page.locator(isPhone ? '.wp-body' : '.wp-cardbox').boundingBox()
  check(control.y < content.y && control.y < 140, `${name}: Mark as done sits at the top of the step, above its content`)
  check((await page.locator('.wp-done').count()) === 1, `${name}: one Mark as done on the step, not a second at the bottom`)
  check(control.height >= 44, `${name}: the control is a full-size target`)
  // leave the task unmarked and finish: the end page says what is left
  await next()
  await page.click('.wp-next')
  await page.waitForSelector('[data-wp-todo]')
  const left = await page.locator('[data-wp-todo-step]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-wp-todo-step')))
  check(left.includes('try-a-prompt') && !left.includes('watch'), `${name}: the end page lists what still needs doing, not what is done (${left.join(', ')})`)
  check((await page.locator('[data-wp-todo-mark="try-a-prompt"]').count()) === 1 && (await page.locator('[data-wp-todo-mark]').count()) === 1, `${name}: only the step that needs "mark as done" gets the button`)
  await page.click('[data-wp-todo-mark="try-a-prompt"]')
  await page.waitForFunction(() => !document.querySelector('[data-wp-todo-step="try-a-prompt"]'))
  await page.waitForTimeout(250)
  const saved0 = byRef(world)['done:try-a-prompt']
  check(saved0 && saved0.done === true && saved0.kind === 'done' && saved0.stepId === 'try-a-prompt', `${name}: marking from the end page saves the same done entry as the step`)
  check(/2 of 4 done/.test(await page.locator('body').innerText()), `${name}: the count moves to 2 of 4`)
  await s.close()
}

// ── The task slide scales with its frame; the rail badge stays off the title row ────────────────
{
  for (const width of [1024, 1280, 1300, 1440, 1920, 390]) {
    const phone = width === 390
    const s = await visit({ width, height: phone ? 844 : 900 })
    const { page } = s
    await ready(page)
    await page.locator('.wp-row[data-step="3"]').first().click()
    await page.waitForSelector(phone ? '.wp-slide-text ol li' : '.wp-canvas .slide .fl-numbered li')
    await page.waitForTimeout(300)
    const fit = await page.evaluate((isPhone) => {
      // laptop: the slide's own frame; phone: the slide is stacked text, so its block is the frame
      const frame = document.querySelector(isPhone ? '.wp-slide-text' : '.wp-canvas').getBoundingClientRect()
      const items = document.querySelectorAll(isPhone ? '.wp-slide-text ol li' : '.wp-canvas .slide .fl-numbered li')
      const last = items[items.length - 1].getBoundingClientRect()
      return { frameBottom: frame.bottom, lastBottom: last.bottom, frameRight: frame.right, lastRight: last.right, frameW: frame.width }
    }, phone)
    check(fit.lastBottom <= fit.frameBottom + 0.5, `fit ${width}: the 4th list item ends inside the slide frame (${fit.lastBottom.toFixed(1)} <= ${fit.frameBottom.toFixed(1)})`)
    check(fit.lastRight <= fit.frameRight + 0.5, `fit ${width}: the 4th list item stays inside the frame's right edge`)
    if (!phone) {
      const rail = await page.evaluate(() => {
        const row = document.querySelector('.wp-row[data-step="2"]')
        const title = row.querySelector('.wp-row-title'), kind = row.querySelector('.wp-kind'), lab = row.querySelector('.wp-lab')
        const t = title.getBoundingClientRect(), k = kind.getBoundingClientRect(), l = lab.getBoundingClientRect()
        return { badgeInKind: kind.contains(lab), badgeAboveTitle: l.bottom <= t.top + 0.5, titleW: t.width, bodyW: row.querySelector('.wp-row-body').getBoundingClientRect().width, clipped: title.scrollWidth > title.clientWidth, labW: l.width, kindH: k.height }
      })
      check(rail.badgeInKind && rail.badgeAboveTitle, `rail ${width}: the Sent badge sits on the type line, above the title`)
      check(rail.titleW >= rail.bodyW - 1, `rail ${width}: the title gets the body's full width (${rail.titleW} of ${rail.bodyW})`)
      check(!rail.clipped, `rail ${width}: "Quick check" is not ellipsised`)
    }
    await s.close()
  }
  const local = PRE_WORK.replace('{id=try-a-prompt}{task}{minutes=20}', '{id=try-a-prompt}{task}{minutes=20}{local}')
    .replace('{id=what-you-want}{poll=open}', '{id=what-you-want}{poll=open}{local}')
  const s = await visit(LAPTOP, { preworkId: 'wppre00888', text: local })
  await ready(s.page)
  const rows = await s.page.evaluate(() => Array.from(document.querySelectorAll('.wp-rail .wp-lab[data-wp-route]')).map((lab) => {
    const row = lab.closest('.wp-row'), title = row.querySelector('.wp-row-title').getBoundingClientRect(), box = lab.getBoundingClientRect()
    return { route: lab.dataset.wpRoute, inKind: !!lab.closest('.wp-kind'), above: box.bottom <= title.top + 0.5, text: lab.innerText, label: lab.getAttribute('aria-label'), titleW: title.width, bodyW: row.querySelector('.wp-row-body').getBoundingClientRect().width }
  }))
  check(rows.length === 3 && rows.every((r) => r.inKind && r.above && r.titleW >= r.bodyW - 1), 'local rail: Sent and On this phone badges sit on the type line, titles keep full width')
  check(rows.some((r) => r.route === 'local' && /On this phone/.test(r.text)) && rows.some((r) => r.route === 'sent' && /Sent/.test(r.text)), 'local rail: the badges keep their words')
  await s.close()
}

// ── Local only steps: labelled, kept on the phone, nothing sent, not even the tick ───────────────
{
  const local = PRE_WORK.replace('{id=try-a-prompt}{task}{minutes=20}', '{id=try-a-prompt}{task}{minutes=20}{local}')
    .replace('{id=what-you-want}{poll=open}', '{id=what-you-want}{poll=open}{local}')
  const s = await visit(LAPTOP, { preworkId: 'wppre00888', text: local })
  const { page, world } = s
  await ready(page)
  check((await page.locator('.wp-rail .wp-lab[data-wp-route="local"]').count()) === 2, 'local: two steps labelled On this phone in the rail')
  check((await page.locator('.wp-rail .wp-lab[data-wp-route="sent"]').count()) === 1, 'local: the quick check labelled Sent (the video has no label)')
  await stepTo(page, 3)
  check((await page.locator('[data-wp-route-panel="local"]').innerText()).includes('Only on this phone'), 'local: the task says it stays on this phone')
  await page.click('.wp-done')
  await page.waitForSelector('.wp-done.is-done')
  await page.waitForTimeout(300)
  check(!world.submits.some((body) => body.stepId === 'try-a-prompt'), 'local: the done tick is not sent, and neither is a read mark')
  check((await text(page, '.wp-note')).includes('Clearing this browser'), 'local: the step says where the tick is kept')
  await stepTo(page, 4)
  await page.fill('.pw-text', 'Only for me.')
  await page.waitForFunction(() => { const note = document.querySelector('.wp-note'); return note && !note.hidden && note.innerText.includes('Saved on this phone') })
  await page.waitForTimeout(300)
  check(!world.submits.some((body) => body.stepId === 'what-you-want'), 'local: the open answer is not sent')
  const kept = await page.evaluate(() => JSON.parse(window.localStorage.getItem('tw-prework-local-wppre00888') || '[]'))
  check(kept.some((entry) => entry.ref === 'done:try-a-prompt') && kept.some((entry) => entry.ref === 'answer:what-you-want' && entry.text === 'Only for me.'), 'local: both kept in the browser')
  await page.close()
  const again = await s.context.newPage()
  await again.goto(`${SITE}/pre-work`)
  await again.waitForSelector('[data-wp-cta]')
  const welcome = await again.locator('.wp-welcome').innerText()
  check(/Welcome back: \d of 4 done/.test(welcome) && welcome.includes('Steps marked Sent have gone to the speaker without your name. Steps marked On this phone stay here.'), `local, coming back: the welcome says where each answer went (${welcome})`)
  await stepTo(again, 3)
  check((await again.locator('.wp-done.is-done').count()) === 1, 'local, coming back: the tick is still there')
  await stepTo(again, 4)
  check((await again.locator('.pw-text').inputValue()) === 'Only for me.', 'local, coming back: the answer is still there')
  check(!world.submits.some((body) => body.stepId === 'try-a-prompt' || body.stepId === 'what-you-want'), 'local: still nothing sent for either step')
  await s.close()
}

// ── Offline: the answer waits in the outbox, survives the tab closing, and goes on the next visit ──
{
  const s = await visit(LAPTOP)
  const { page, world } = s
  await ready(page)
  await stepTo(page, 4)
  world.failNext.push('abort')
  await page.fill('.pw-text', 'Typed on the train.')
  await page.waitForFunction(() => { const note = document.querySelector('.wp-note'); return note && !note.hidden && note.innerText.includes('Not sent yet.') })
  check((await text(page, '.wp-note')) === 'Not sent yet. It is saved on this phone and will go when you are back online.', 'offline: the step says it has not been sent and will go')
  check(await page.locator('.wp-warn').isVisible(), 'offline: and warns not to clear the browser')
  const box = await page.evaluate(() => JSON.parse(window.localStorage.getItem('tw-prework-outbox-wppre00001') || '{}'))
  check(box['answer:what-you-want'] && box['answer:what-you-want'].text === 'Typed on the train.', 'offline: the answer is in the outbox')
  check(!byRef(world)['answer:what-you-want'], 'offline: the Worker does not have it yet')
  await page.close()
  const again = await s.context.newPage()
  await again.goto(`${SITE}/pre-work`)
  await again.waitForSelector('[data-wp-cta]')
  await again.waitForFunction(() => { const raw = window.localStorage.getItem('tw-prework-outbox-wppre00001'); return !raw || !JSON.parse(raw)['answer:what-you-want'] }, null, { timeout: 5000 })
  check(byRef(world)['answer:what-you-want'] && byRef(world)['answer:what-you-want'].text === 'Typed on the train.', 'offline, the next visit: the answer reaches the Worker')
  check(world.submits.filter((body) => body.stepId === 'what-you-want' && body.kind === 'answer').length === 2, 'offline: sent once more, not again and again')
  await s.close()
}

// ── Local only step, offline: a queued "Ask about this" question still goes to the speaker; a queued done mark does not ──
{
  const local = PRE_WORK.replace('{id=try-a-prompt}{task}{minutes=20}', '{id=try-a-prompt}{task}{minutes=20}{local}')
  const s = await visit(LAPTOP, { preworkId: 'wppre00889', text: local })
  const { page, world } = s
  await ready(page)
  await stepTo(page, 3)
  world.failNext.push('abort')
  await page.fill('.wp-asktext', 'Which model should I try?')
  await page.click('.wp-askcol .wp-send')
  await page.waitForFunction(() => Object.keys(JSON.parse(window.localStorage.getItem('tw-prework-outbox-wppre00889') || '{}')).some((key) => key.startsWith('q:')))
  check(!world.all().some((entry) => entry.kind === 'question'), 'local, offline: the question has not reached the Worker yet')
  // A done mark for the Local only step in the outbox (an older page, or a step made Local only since): never sent.
  await page.evaluate((device) => {
    const key = 'tw-prework-outbox-wppre00889'
    const box = JSON.parse(window.localStorage.getItem(key) || '{}')
    box['done:try-a-prompt'] = { participantId: device, submissionId: 'stale-done-1', stepId: 'try-a-prompt', kind: 'done', done: true }
    window.localStorage.setItem(key, JSON.stringify(box))
  }, `device-${DEVICE}`)
  await page.close()
  const again = await s.context.newPage()
  await again.goto(`${SITE}/pre-work`)
  await again.waitForSelector('[data-wp-cta]')
  await again.waitForFunction(() => { const raw = window.localStorage.getItem('tw-prework-outbox-wppre00889'); return !raw || Object.keys(JSON.parse(raw)).length === 0 }, null, { timeout: 5000 })
  const asked = world.all().find((entry) => entry.kind === 'question')
  check(Boolean(asked) && asked.stepId === 'try-a-prompt' && asked.text === 'Which model should I try?', 'local, the next visit: the queued question reaches the Worker')
  check(!world.submits.some((body) => body.stepId === 'try-a-prompt' && body.kind !== 'question'), 'local, the next visit: the queued done mark is dropped, never sent')
  await s.close()
}

await browser.close()
if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(1) }
console.log('\nwork-page-dom: ok')
