// The pre-work form on the real published handout (buildShareHtml with a planned Run's pre-work), in
// headless Chromium at 360x740 (a phone: one step per screen) and 1440x900 (a laptop: steps, the step and
// "Ask about this" in three columns), against a stand-in for the Worker's pre-work routes. Seams: the page
// DOM at both sizes: the overview ("Start with step 1", the seven steps, "Carry on" and "5 of 7" when they
// come back, the thank-you), one step per screen with its answer saved as they go (a read on opening, a
// quick check with no mark, a multiple choice, an open answer, Mark as done and Tap to untick), "Ask about
// this" (the phone's sheet, the laptop's column), the closed page (the slide list with a banner), a save the
// Worker refuses for now (kept, sent again), and every participant text as text. The Worker itself is
// test-prework-form-live.mjs.
// Usage: node scripts/prework-form-dom.test.mjs
//   SHOTS=<dir> saves the drawn states, named for the drawings (W1..W12, L3..L5).
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { buildPreworkHandout } from './lib/prework-page-fixture.mjs'
import { fakePreworkWorker } from './lib/prework-fake-worker.mjs'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://worker.example.test'
const PW = 'pwform0001'
const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const { html, form } = await buildPreworkHandout({ workerBaseUrl: BASE, preworkId: PW })
const scratch = await mkdtemp(join(tmpdir(), 'tw-prework-dom-'))
const file = join(scratch, 'handout.html')
await writeFile(file, html)
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })

const failures = []
const check = (ok, label) => { if (!ok) { failures.push(label); console.log(`FAIL  ${label}`) } else console.log(`PASS  ${label}`) }
const browser = await chromium.launch()
const PHONE = { width: 360, height: 740 }
const LAPTOP = { width: 1440, height: 900 }

async function session(viewport, { state = 'open', seed = [], people } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  await context.addInitScript(([key, id]) => { try { window.localStorage.setItem(key, id) } catch (_) {} }, [`tw-prework-device-${PW}`, DEVICE])
  const world = await fakePreworkWorker(context, { baseUrl: BASE, preworkId: PW, state, people })
  if (seed.length) world.seed(DEVICE, seed)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  // The page also tries the live socket on the same fake host; that failing is not what is tested here.
  page.on('console', (message) => { if (message.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|WebSocket/.test(message.text())) errors.push(message.text()) })
  await page.goto(`file://${file}`)
  return { context, page, world, errors, close: () => context.close() }
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
const text = (page, selector) => page.locator(selector).first().innerText()
const overflow = (page) => page.evaluate(() => {
  const app = document.querySelector('.pw-app')
  const scroller = document.querySelector('.pw-scroll')
  return { page: document.documentElement.scrollWidth > window.innerWidth, app: app ? app.scrollWidth > app.clientWidth : false, scroller: scroller ? scroller.scrollWidth > scroller.clientWidth : false }
})
const small = (page, min) => page.evaluate((limit) => Array.from(document.querySelectorAll('.pw-app button, .pw-app input, .pw-app textarea'))
  .filter((node) => node.offsetParent !== null)
  .map((node) => ({ label: (node.innerText || node.placeholder || node.className || '').slice(0, 40), h: node.getBoundingClientRect().height }))
  .filter((item) => item.h < limit), min)
const openOverview = async (page) => page.waitForSelector('.pw-app:not([hidden]) .pw-title')
const step = async (page, n) => { await page.click(`.pw-row[data-step="${n}"]`); await page.waitForSelector('.pw-stepview') }
const settle = (page) => page.waitForTimeout(250)

// ── A step that carries a diagram gets the diagram vendor (the known gap from the handout build) ──
{
  const { buildShareHtml } = await import('../compiler/scripts/lib/09-output-builders.mjs')
  const slide = (id, inner) => ({ id, html: `<section class="slide" data-id="${id}"><div class="slide-content">${inner}</div></section>`, notes: '' })
  const base = { title: 'T', styles: '', includeNotes: false, slug: 't', license: null, workerBaseUrl: BASE, slides: [slide('a', '<p>Talk</p>')] }
  const prework = (inner) => ({ preworkId: PW, workerBaseUrl: BASE, form, steps: [{ id: 'pwagent', html: slide('pwagent', inner).html }] })
  const plain = buildShareHtml({ ...base, prework: prework('<p>No diagram</p>') })
  const diagram = buildShareHtml({ ...base, prework: prework('<div class="mermaid-mm">graph TD; A-->B</div>') })
  check(diagram.includes('BEGIN VENDOR mermaid'), 'a pre-work step with a diagram brings the diagram vendor into the handout')
  check(!plain.includes('BEGIN VENDOR mermaid'), 'and a handout with no diagram anywhere does not carry the vendor')
}

// ── The right answer is never on the page ────────────────────────────────────────────────────
check(!/"right"\s*:/.test(html) && !html.includes('{right}'), 'the handout carries no right answer (no "right" key, no {right} marker)')
check(form.steps.length === 7 && form.steps[2].kind === 'check' && form.steps[2].poll.type === 'single', 'the fixture form has the seven drawn steps, the third a quick check')

// ═══ Phone, 360x740 ══════════════════════════════════════════════════════════════════════════
{
  const s = await session(PHONE)
  const { page, world } = s
  await openOverview(page)
  await settle(page)
  check((await text(page, '.pw-title')) === 'Before the session', 'W1: the overview names the section')
  check((await text(page, '.pw-intro')).startsWith('Seven short steps'), 'W1: the introduction is the section paragraph')
  check((await page.locator('.pw-row').count()) === 7, 'W1: seven steps are listed')
  check((await text(page, '.pw-cta')) === 'Start with step 1', 'W1: first open says "Start with step 1"')
  check((await text(page, '.pw-meter')).includes('0 of 7 done') && (await text(page, '.pw-meter')).includes('Closes'), 'W1: "0 of 7 done" and when it closes')
  check((await page.locator('.pw-chips').innerText()).includes('About 20 minutes'), 'W1: the time it takes (10 + 5 + one minute for each of five other steps)')
  const kinds = await page.locator('.pw-row .pw-kind').allInnerTexts()
  check(kinds.join('|') === 'Slide|Slide|Quick check|Question|Pre-task \u00b7 about 10 min|Pre-task \u00b7 about 5 min|Question', 'W1: each row names its kind (the tasks say how long)')
  check(!(await page.locator('.pw-row').first().innerText()).includes('Read'), 'W1: nothing is marked before anything is done')
  check(Object.values(await overflow(page)).every((v) => !v), 'W1: no horizontal scroll at 360')
  check((await small(page, 44)).length === 0, 'W1: every button is at least 44px tall')
  check((await page.evaluate(() => document.body.dataset.prework)) === 'open', 'the page is marked body[data-prework=open]')
  await shot(page, 'W1-prework-overview-first-open-360x740')

  // Step 1: a slide
  await page.click('[data-pw-cta]')
  await page.waitForSelector('.pw-stepview')
  await settle(page)
  check((await text(page, '.pw-stepno')) === 'Step 1 of 7', 'W2: the header says Step 1 of 7')
  check((await page.locator('.pw-canvas .slide').count()) === 1, 'W2: the step is the real slide on its canvas')
  check((await page.locator('.pw-lines li').allInnerTexts()).join('|') === 'Read two short slides|Answer two quick questions|Try two small tasks and mark them done', 'W2: the slide\'s text is read under it')
  check((await text(page, '.pw-ask')) === 'Ask about this' && (await text(page, '.pw-next')) === 'Next', 'W2: Ask about this and Next sit at the foot')
  check(await page.locator('.pw-full').count() === 1, 'W2: a slide can go full screen')
  await page.waitForFunction(() => window.__x === undefined) // (yield)
  check(world.submits.some((b) => b.kind === 'read' && b.stepId === 'pwwelcome' && b.participantId === DEVICE), 'W2: opening a slide sends one read for it')
  check(world.submits.filter((b) => b.kind === 'read').length === 1, 'W2: one read, no more')
  check(Object.values(await overflow(page)).every((v) => !v), 'W2: no horizontal scroll')
  check((await small(page, 44)).length === 0, 'W2: every button is at least 44px tall')
  await shot(page, 'W2-prework-step-slide-360x740')

  // Full screen
  await page.click('.pw-full')
  check(await page.locator('.pw-fsview .slide').count() === 1, 'W2: Full screen shows the slide alone')
  await page.click('.pw-fsclose')
  check(await page.locator('.pw-fsview').count() === 0, 'W2: full screen closes')

  // Step 2, Ask about this (W3-W5), with a question that is HTML to prove it is text
  await page.click('.pw-next')
  await settle(page)
  check((await text(page, '.pw-stepno')) === 'Step 2 of 7', 'W3: Next goes to step 2')
  await shot(page, 'W3-prework-step-slide-ask-360x740')
  await page.click('.pw-ask')
  await page.waitForSelector('.pw-sheet')
  check((await text(page, '.pw-sheet-title')) === 'Ask about this step', 'W4: the sheet is titled Ask about this step')
  check((await text(page, '.pw-about')).startsWith('Step 2'), 'W4: it says which step it is about')
  check((await page.locator('.pw-privacy').innerText()).includes('Only the speaker sees this'), 'W4: it says only the speaker sees it')
  check(await page.locator('.pw-sheet .pw-primary').isDisabled(), 'W4: Send waits for a question')
  check((await small(page, 44)).length === 0, 'W4: every control in the sheet is at least 44px tall')
  const question = 'Is <img src=x onerror="window.__pwx=1"> Copilot Chat an agent? <b>bold</b>'
  await page.fill('.pw-sheet textarea', question)
  await shot(page, 'W4-prework-ask-about-slide-360x740')
  await page.dblclick('.pw-sheet .pw-primary')
  await page.waitForSelector('.pw-sent')
  check(world.submits.filter((b) => b.kind === 'question').length === 1, 'W5: pressing Send twice sends one question')
  const sent = world.submits.find((b) => b.kind === 'question')
  check(sent && sent.stepId === 'pwagent' && sent.text === question && !('name' in sent), 'W5: the question is sent as typed, about step 2, with no name')
  check((await text(page, '.pw-quote')) === question, 'W5: it is shown back as text')
  check((await page.locator('.pw-sheet img, .pw-sheet b').count()) === 0 && (await page.evaluate(() => window.__pwx)) === undefined, 'W5: the question\'s markup is text, never HTML (no element, no script ran)')
  check((await page.locator('.pw-sheet').innerText()).includes('Only the speaker sees it'), 'W5: "Only the speaker sees it"')
  await shot(page, 'W5-prework-ask-sent-360x740')
  await page.click('.pw-sheet-actions .pw-secondary')
  await page.waitForSelector('.pw-sheet textarea')
  await page.fill('.pw-sheet textarea', 'A second question')
  await page.fill('.pw-sheet .pw-name', 'Sam')
  await page.click('.pw-sheet .pw-primary')
  await page.waitForSelector('.pw-sent')
  check(world.submits.filter((b) => b.kind === 'question').at(-1).name === 'Sam', 'W5: a name is sent only when one is typed')
  await page.click('.pw-sheet-actions .pw-primary')
  check((await page.locator('.pw-sheet').count()) === 0, 'W5: Done closes the sheet')
  check((await page.locator('.pw-yourq').count()) === 2 && (await page.locator('.pw-yourq').first().innerText()).includes('With the speaker'), 'W8: the questions asked show under the step, "With the speaker"')

  // Step 3: the quick check
  await page.click('.pw-next')
  await settle(page)
  check((await text(page, '.pw-stepno')) === 'Step 3 of 7', 'W6: step 3')
  check((await text(page, '.pw-kind')) === 'Quick check', 'W6: it is a Quick check')
  check((await text(page, '.pw-hint')).includes('There is no mark'), 'W6: it says there is no mark')
  check((await page.locator('.pw-opt').count()) === 4, 'W6: four options')
  await page.click('.pw-opt >> nth=1')
  await page.waitForSelector('.pw-note:not([hidden])')
  await page.waitForFunction(() => document.querySelector('.pw-note').innerText.includes('Saved'))
  const answer = world.submits.find((b) => b.kind === 'answer' && b.stepId === 'pwquiz')
  check(answer && answer.choice === form.steps[2].poll.options[1].optionId, 'W6: choosing an option saves it at once')
  check((await text(page, '.pw-note')) === 'Saved. You will see how everyone answered in the session.', 'W6: "Saved. You will see how everyone answered in the session."')
  check(!/correct|wrong|right answer|score|marked/i.test(await page.locator('.pw-stepview').innerText()), 'W6: no mark, no right or wrong anywhere on the step')
  check((await page.locator('.pw-opt.is-on').count()) === 1 && (await page.locator('.pw-opt.is-on').innerText()).includes('uses tools'), 'W6: the chosen option is selected')
  check(!('right' in answer), 'W6: nothing about a right answer is sent')
  await page.click('.pw-opt >> nth=0')
  await page.waitForFunction((n) => document.querySelectorAll('.pw-opt.is-on').length === 1 && document.querySelector('.pw-opt.is-on').innerText.includes('full sentences'), null)
  await page.waitForFunction(() => document.querySelector('.pw-note').innerText.includes('Saved'))
  check(world.all().find((e) => e.ref === 'answer:pwquiz').choice === form.steps[2].poll.options[0].optionId, 'W6: changing the answer replaces it (one answer per step)')
  await page.click('.pw-opt >> nth=1')
  await page.waitForFunction(() => document.querySelector('.pw-note').innerText.includes('Saved'))
  await shot(page, 'W6-prework-quick-check-360x740')

  // Step 4: a multiple choice
  await page.click('.pw-next')
  await settle(page)
  await page.click('.pw-opt >> nth=0')
  await page.click('.pw-opt >> nth=2')
  await page.waitForFunction(() => document.querySelector('.pw-note') && document.querySelector('.pw-note').innerText.includes('Saved'))
  const multi = world.all().find((e) => e.ref === 'answer:pwtools')
  check(Array.isArray(multi.choice) && multi.choice.length === 2, 'a multiple choice saves the options ticked')

  // Step 5: a pre-task with Mark as done
  await page.click('.pw-next')
  await settle(page)
  check((await text(page, '.pw-kind')) === 'Pre-task \u00b7 about 10 minutes', 'W7: a pre-task says how long it takes')
  check((await text(page, '.pw-done')) === 'Mark as done', 'W7: it offers Mark as done')
  check((await text(page, '.pw-hint')).includes('When you have done it, mark it done'), 'W7: it says what to do')
  await shot(page, 'W7-prework-task-todo-360x740')
  await page.click('.pw-done')
  await page.waitForSelector('.pw-done.is-done')
  check((await text(page, '.pw-done')).includes('Tap to untick'), 'W8: done says "Tap to untick"')
  check((await text(page, '.pw-donenote')).includes('The speaker sees how many people have done each task, not who.'), 'W8: it says the speaker sees counts, not who')
  await page.waitForFunction(() => true)
  await page.waitForTimeout(150)
  check(world.all().find((e) => e.ref === 'done:pwtask1')?.done === true, 'W8: the done mark is saved')
  await shot(page, 'W8-prework-task-done-360x740')
  await page.click('.pw-done')
  await page.waitForSelector('.pw-done.pw-done-todo')
  await page.waitForTimeout(150)
  check(world.all().find((e) => e.ref === 'done:pwtask1')?.done === false, 'W8: tapping again unticks it (saved as not done)')
  await page.click('.pw-done')
  await page.waitForSelector('.pw-done.is-done')

  // Step 6: task 2, left not done; step 7: the last question
  await page.click('.pw-next')
  await settle(page)
  check((await text(page, '.pw-kind')) === 'Pre-task \u00b7 about 5 minutes', 'W7: the second task takes five minutes')
  await page.click('.pw-next')
  await settle(page)
  check((await text(page, '.pw-next')) === 'Finish', 'W9: the last step says Finish')
  check((await text(page, '.pw-hint')) === 'A sentence is plenty.', 'W9: an open question says a sentence is plenty')
  await page.fill('.pw-text', 'Try one thing I can use on Monday <script>window.__pwx=2</script>')
  await shot(page, 'W9-prework-last-question-360x740')
  await page.click('.pw-next')
  await page.waitForSelector('.pw-overview')
  await page.waitForFunction(() => document.querySelector('.pw-meter').innerText.includes('6 of 7 done'))
  check(world.all().find((e) => e.ref === 'answer:pwhope')?.text === 'Try one thing I can use on Monday <script>window.__pwx=2</script>', 'W9: Finish saves the typed answer first')
  check((await page.evaluate(() => window.__pwx)) === undefined, 'W9: the answer is never run as a script')
  const rows = await page.locator('.pw-row .pw-state').allInnerTexts()
  check(rows.join('|') === 'Read|Read|Answered|Answered|Done|Not done yet|Answered', 'W10/W11: each row says where it stands (task 2 was opened, not done)')
  check((await text(page, '.pw-meter')).includes('6 of 7 done'), 'W11: "6 of 7 done"')
  check((await text(page, '.pw-cta')) === 'Carry on: step 6', 'W11: "Carry on: step 6"')
  check((await text(page, '.pw-banner')).includes('Welcome back'), 'W11: the welcome back note')
  check((await text(page, '.pw-row[data-step="2"] .pw-row-q')).includes('Your 2 questions are with the speaker'), 'W11: a step with questions says they are with the speaker')
  await shot(page, 'W11-prework-back-later-360x740')
  await page.click('.pw-row[data-step="6"]')
  await page.click('.pw-done')
  await page.waitForSelector('.pw-done.is-done')
  await page.click('.pw-back')
  await page.waitForSelector('.pw-thanks')
  check((await text(page, '.pw-thanks-title')) === 'All done. Thank you.', 'W10: with every step done it says "All done. Thank you."')
  check((await text(page, '.pw-thanks')).includes('You can change an answer or untick a task until'), 'W10: it says how long an answer can be changed')
  check((await page.locator('.pw-cta').count()) === 0, 'W10: no Start or Carry on once everything is done')
  check((await text(page, '.pw-meter')).includes('7 of 7 done'), 'W10: "7 of 7 done"')
  await shot(page, 'W10-prework-all-done-360x740')
  check(s.errors.length === 0, `the phone run raised no page errors (${s.errors.join('; ')})`)
  await s.close()
}

// ── Coming back later (W11): what the Worker holds for this device is what the page shows ───────
{
  const seed = [
    { ref: 'read:pwwelcome', stepId: 'pwwelcome', kind: 'read' }, { ref: 'read:pwagent', stepId: 'pwagent', kind: 'read' },
    { ref: 'q:earlier1', stepId: 'pwagent', kind: 'question', text: 'Is Copilot Chat an agent?' },
    { ref: 'answer:pwquiz', stepId: 'pwquiz', kind: 'answer', choice: form.steps[2].poll.options[1].optionId },
    { ref: 'answer:pwtools', stepId: 'pwtools', kind: 'answer', choice: [form.steps[3].poll.options[0].optionId] },
    { ref: 'read:pwtask1', stepId: 'pwtask1', kind: 'read' }, { ref: 'done:pwtask1', stepId: 'pwtask1', kind: 'done', done: true },
  ]
  const s = await session(PHONE, { seed })
  const { page, world } = s
  await openOverview(page)
  check((await text(page, '.pw-meter')).includes('5 of 7 done'), 'W11: back later, "5 of 7 done"')
  check((await text(page, '.pw-cta')) === 'Carry on: step 6', 'W11: "Carry on: step 6"')
  check((await text(page, '.pw-banner')).includes('Welcome back. Your answers are kept on this phone\u2019s browser, not under your name.'), 'W11: the welcome back note says where the answers are kept')
  check((await page.locator('.pw-row .pw-state').allInnerTexts()).join('|') === 'Read|Read|Answered|Answered|Done|Not started|Not started', 'W11: the earlier answers are shown on their rows')
  check((await text(page, '.pw-row[data-step="2"] .pw-row-q')) === 'Your question is with the speaker', 'W11: "Your question is with the speaker" on step 2')
  await page.click('.pw-cta')
  await page.waitForSelector('.pw-stepview')
  check((await text(page, '.pw-stepno')) === 'Step 6 of 7', 'W11: Carry on opens the first step not done')
  await page.click('.pw-back')
  await page.click('.pw-row[data-step="3"]')
  await page.waitForSelector('.pw-opt.is-on')
  check((await page.locator('.pw-opt.is-on').innerText()).includes('uses tools'), 'W11: an answered step shows the earlier answer')
  check(!world.submits.some((b) => b.kind === 'answer'), 'W11: opening an answered step sends nothing new')
  await s.close()
}

// ── Saves the Worker refuses for now are kept and sent again ─────────────────────────────────────
{
  const s = await session(PHONE)
  const { page, world } = s
  await openOverview(page)
  await page.click('.pw-cta')
  await page.waitForSelector('.pw-stepview')
  await page.click('.pw-next'); await settle(page)
  await page.click('.pw-next'); await settle(page)
  world.failNext.push({ status: 429, code: 'rate_limited', retryAfterMs: 200 })
  await page.click('.pw-opt >> nth=2')
  await page.waitForFunction(() => document.querySelector('.pw-note') && document.querySelector('.pw-note').dataset.tone === 'error')
  check((await text(page, '.pw-note')).includes('Too many answers at once'), 'a refused save says why')
  await page.waitForFunction(() => document.querySelector('.pw-note').innerText.includes('Saved'))
  const tries = world.submits.filter((b) => b.kind === 'answer' && b.stepId === 'pwquiz')
  check(tries.length === 2 && tries[0].submissionId === tries[1].submissionId, 'the same submission is sent again (same id), not a new one')
  check(world.all().filter((e) => e.ref === 'answer:pwquiz').length === 1, 'and it is stored once')
  world.failNext.push('abort')
  await page.click('.pw-opt >> nth=3')
  await page.waitForFunction(() => document.querySelector('.pw-note') && document.querySelector('.pw-note').dataset.tone === 'error')
  check((await text(page, '.pw-note')).includes('Not saved yet'), 'no connection says it is not saved yet')
  await page.waitForFunction(() => document.querySelector('.pw-note').innerText.includes('Saved'), null, { timeout: 15000 })
  check(world.all().find((e) => e.ref === 'answer:pwquiz').choice === form.steps[2].poll.options[3].optionId, 'it is saved once the connection is back (the latest choice)')
  // Pre-work closes while a person is answering: the page stops the form and says so
  world.state = 'closed'; world.people = 31
  await page.click('.pw-opt >> nth=0')
  await page.waitForSelector('.pw-app[hidden]', { state: 'attached' })
  await page.waitForSelector('.pw-closed:visible')
  check((await page.locator('.pw-app').isHidden()), 'a refusal because pre-work closed ends the form')
  check((await page.locator('.pw-closed:visible').first().innerText()).includes('Pre-work closed'), 'and shows the closed banner')
  await s.close()
}

// ── Closed: the handout link's own slide list, with a banner (W12) ───────────────────────────────
{
  const s = await session(PHONE, { state: 'closed', people: 31 })
  const { page } = s
  await page.waitForSelector('.pw-closed:visible')
  const banner = await page.locator('.pw-closed:visible').first().innerText()
  check(/Pre-work closed/.test(banner) && /It closed on \w{3} \d+ \w{3} at \d\d:\d\d\./.test(banner) && banner.includes('31 people took part.') && banner.includes('The session\u2019s slides are below.'), 'W12: the banner says when it closed, how many took part and that the slides are below')
  check(await page.locator('.pw-app').isHidden(), 'W12: no form once it has closed')
  check((await page.locator('.pslide-row').count()) === 4, 'W12: the slide list is the talk\'s own (the pre-work steps are not in it)')
  check(Object.values(await overflow(page)).every((v) => !v), 'W12: no horizontal scroll')
  await shot(page, 'W12-prework-closed-360x740')
  check(s.errors.length === 0, `the closed page raised no page errors (${s.errors.join('; ')})`)
  await s.close()
}
{
  const s = await session(PHONE, { state: 'not_yet' })
  await s.page.waitForFunction(() => document.body.dataset.prework === 'not_yet')
  check(await s.page.locator('.pw-app').isHidden() && (await s.page.locator('.pw-closed:visible').count()) === 0, 'before it opens: no form and no banner, the slide list stands')
  await s.close()
}

// ═══ Laptop, 1440x900 ═══════════════════════════════════════════════════════════════════════
{
  const seed = [
    { ref: 'read:pwwelcome', stepId: 'pwwelcome', kind: 'read' }, { ref: 'read:pwagent', stepId: 'pwagent', kind: 'read' },
    { ref: 'answer:pwquiz', stepId: 'pwquiz', kind: 'answer', choice: form.steps[2].poll.options[1].optionId },
    { ref: 'answer:pwtools', stepId: 'pwtools', kind: 'answer', choice: [form.steps[3].poll.options[0].optionId] },
    { ref: 'read:pwtask1', stepId: 'pwtask1', kind: 'read' }, { ref: 'done:pwtask1', stepId: 'pwtask1', kind: 'done', done: true },
  ]
  const s = await session(LAPTOP, { seed })
  const { page, world } = s
  await openOverview(page)
  await settle(page)
  check((await text(page, '.pw-banner')).includes('Welcome back. Your answers are kept in this browser, not under your name.'), 'L3: welcome back, on a laptop it says this browser')
  check((await page.locator('.pw-side .pw-count').innerText()) === '5 of 7 done', 'L3: "5 of 7 done" beside the steps')
  check((await text(page, '.pw-side .pw-cta')) === 'Carry on: step 6', 'L3: "Carry on: step 6"')
  check((await page.locator('.pw-chips').innerText()).includes('Open until'), 'L3: it says when it is open until')
  const main = await page.locator('.pw-main').boundingBox()
  const side = await page.locator('.pw-side').boundingBox()
  check(side.x > main.x + main.width && main.width > 500, 'L3: two columns: the steps and, to their right, the progress card')
  check(Object.values(await overflow(page)).every((v) => !v), 'L3: no horizontal scroll at 1440')
  await shot(page, 'L3-prework-overview-back-later-1440x900')

  await page.click('.pw-row[data-step="5"]')
  await page.waitForSelector('.pw-stepview.is-wide')
  await settle(page)
  const rail = await page.locator('.pw-rail').boundingBox()
  const center = await page.locator('.pw-center').boundingBox()
  const ask = await page.locator('.pw-askcol').boundingBox()
  check(rail.x < center.x && center.x + center.width <= ask.x + 1 && rail.width >= 280 && ask.width >= 280, 'L4: three columns: the steps, the step, ask about this')
  check((await page.locator('.pw-rail .pw-row.is-current').getAttribute('data-step')) === '5', 'L4: the current step is marked in the list')
  check((await page.locator('.pw-rail .pw-row .pw-state').allInnerTexts()).slice(0, 5).join('|').startsWith('Read|Read|Answered|Answered|Done'), 'L4: the list carries each step\'s state')
  check((await text(page, '.pw-centerhead')).includes('Step 5 of 7') && (await text(page, '.pw-centerhead')).includes('Pre-task'), 'L4: the step\'s header')
  check((await text(page, '.pw-done')).includes('Done') && (await text(page, '.pw-done')).includes('Click to untick'), 'L4: a laptop says "Click to untick"')
  check((await text(page, '.pw-donenote')).includes('Done \u00b7 marked'), 'L4: the done note sits in the ask column')
  check((await page.locator('.pw-canvas').boundingBox()).width > 600, 'L4: the slide is large')
  await page.fill('.pw-asktext', 'Copilot will not open my Outlook drafts. Is that a licence thing?')
  await page.click('.pw-send')
  await page.waitForSelector('.pw-yourq')
  check(world.submits.some((b) => b.kind === 'question' && b.stepId === 'pwtask1' && b.text.startsWith('Copilot will not open') && !('name' in b)), 'L4: a question is sent from the column, about the step')
  check((await text(page, '.pw-yourq')).includes('With the speaker'), 'L4: it appears in the column, "With the speaker"')
  await shot(page, 'L4-prework-task-done-1440x900')
  // keys (the arrows do nothing while the person is typing in a box)
  await page.keyboard.press('ArrowLeft')
  check((await text(page, '.pw-centerhead')).includes('Step 5 of 7'), 'L5: the arrows leave a box alone while typing')
  await page.locator('.pw-centerhead').click()
  await page.keyboard.press('?')
  check((await page.locator('.help-overlay.open').count()) === 0, 'L5: the handout\'s own shortcuts (?) stay quiet while the form is up')
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.pw-centerhead .pw-stepno').innerText === 'Step 4 of 7')
  check(true, 'L5: the left arrow moves to the previous step')
  await page.click('.pw-row[data-step="3"]')
  await page.waitForSelector('.pw-opt.is-on')
  check((await text(page, '.pw-note')) === '' || (await page.locator('.pw-note').isHidden()), 'L5: an answer saved earlier is shown with no fresh note')
  await page.click('.pw-opt >> nth=1')
  await page.waitForFunction(() => document.querySelector('.pw-note') && document.querySelector('.pw-note').innerText.includes('Saved'))
  check((await text(page, '.pw-note')) === 'Saved. You will see how everyone answered in the session.', 'L5: the quick check: saved, no mark')
  check(!/correct|wrong|right answer|score/i.test(await page.locator('.pw-center').innerText()), 'L5: no mark on a laptop either')
  check((await page.locator('.pw-askcol .pw-small').first().innerText()).includes('Stuck, or not sure what is meant?'), 'L5: the column invites a question')
  check(await page.locator('.pw-send').isDisabled(), 'L5: Send waits for a question')
  check(Object.values(await overflow(page)).every((v) => !v), 'L5: no horizontal scroll')
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('.pw-app button')).filter((n) => n.offsetParent !== null).map((n) => n.getBoundingClientRect().height).filter((h) => h < 36))
  check(buttons.length === 0, 'L5: every button is at least 36px tall')
  await shot(page, 'L5-prework-quick-check-1440x900')
  check(s.errors.length === 0, `the laptop run raised no page errors (${s.errors.join('; ')})`)
  await s.close()
}

await browser.close()
await rm(scratch, { recursive: true, force: true })
if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(1) }
console.log('\nprework-form-dom: ok')
