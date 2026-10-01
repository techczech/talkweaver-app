// Feedback-boards ticket 10 against a real live Worker (`wrangler dev`: local, throwaway secrets and
// state, nothing deployed): a person does the pre-work on the real published handout, on a phone and on a
// laptop, and the Worker holds what they did.
//   - a phone runs the seven steps of the drawing: reads, a quick check (no mark), a multiple choice, two
//     pre-tasks (Mark as done, then untick and mark again), an open answer, a question about a step, and
//     Finish; the owner then reads exactly those entries (one per step for reads, answers and done marks,
//     one per question), with no device id and no right answer anywhere;
//   - the same device coming back later (a reload) sees "7 of 7 done" and every earlier answer;
//   - a second device on a laptop answers, asks a question from the column, and is counted as a second person;
//   - the owner closes pre-work while a third person is on a step: their next answer is refused, the form
//     gives way to the closed banner with the count of people, and a fresh load shows the same banner.
// Usage: node scripts/test-prework-form-live.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { buildPreworkHandout } from './lib/prework-page-fixture.mjs'

const worker = await startLiveWorker()
const { baseUrl, adminSecret } = worker
const scratch = await mkdtemp(join(tmpdir(), 'tw-prework-live-'))
const browser = await chromium.launch()
const json = { 'content-type': 'application/json' }
const pass = (name) => console.log(`PASS  ${name}`)
const shots = process.env.SHOTS

try {
  const created = await (await fetch(`${baseUrl}/prework`, { method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, ...json }, body: '{}' })).json()
  const { preworkId, ownerToken } = created
  const { html, form } = await buildPreworkHandout({ workerBaseUrl: baseUrl, preworkId })
  const file = join(scratch, 'handout.html')
  await writeFile(file, html)
  const owner = { authorization: `Bearer ${ownerToken}` }
  const now = Date.now()
  const push = await fetch(`${baseUrl}/prework/${preworkId}/form`, { method: 'PUT', headers: { ...owner, ...json }, body: JSON.stringify({ opensAt: now - 60_000, closesAt: now + 3_600_000, form }) })
  assert.equal(push.status, 200, 'the form is pushed')
  const results = async () => (await fetch(`${baseUrl}/prework/${preworkId}/results?after=0`, { headers: owner })).json()
  const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))
  const quiz = form.steps[2].poll.options, tools = form.steps[3].poll.options

  async function person(viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(`file://${file}`)
    await page.waitForSelector('.pw-app:not([hidden]) .pw-title', { timeout: 15_000 })
    return { context, page, errors }
  }
  const saved = (page) => page.waitForFunction(() => document.querySelector('.pw-note') && document.querySelector('.pw-note').innerText.includes('Saved'), null, { timeout: 15_000 })

  // ── A phone does the whole pre-work ─────────────────────────────────────────────────────────
  const a = await person({ width: 360, height: 740 })
  const { page } = a
  assert.equal(await page.evaluate(() => document.body.dataset.prework), 'open', 'the Worker says it is open, so the page shows the form')
  const device = await page.evaluate((id) => localStorage.getItem(`tw-prework-device-${id}`), preworkId)
  assert.match(device, /^[0-9a-f]{32}$/, 'the device keeps a random id in its own browser')
  await page.click('[data-pw-cta]')
  await page.waitForSelector('.pw-stepview')
  await page.click('.pw-next')                                   // step 2
  await page.click('.pw-ask')
  await page.fill('.pw-sheet textarea', 'Is Copilot Chat an agent, or only the new Copilot agents?')
  await page.click('.pw-sheet .pw-primary')
  await page.waitForSelector('.pw-sent', { timeout: 15_000 })
  await page.click('.pw-sheet-actions .pw-primary')
  await page.click('.pw-next')                                   // step 3, the quick check
  await page.click('.pw-opt >> nth=1'); await saved(page)
  assert.equal(await page.locator('.pw-note').innerText(), 'Saved. You will see how everyone answered in the session.')
  await page.click('.pw-next')                                   // step 4, a multiple choice
  await page.click('.pw-opt >> nth=0'); await page.click('.pw-opt >> nth=2'); await saved(page)
  await page.click('.pw-next')                                   // step 5, a pre-task
  await page.click('.pw-done'); await page.waitForSelector('.pw-done.is-done')
  await page.click('.pw-done'); await page.waitForSelector('.pw-done.pw-done-todo')   // untick
  await page.click('.pw-done'); await page.waitForSelector('.pw-done.is-done')       // and again
  await page.click('.pw-next')                                   // step 6, a pre-task
  await page.click('.pw-done'); await page.waitForSelector('.pw-done.is-done')
  await page.click('.pw-next')                                   // step 7, the open question
  await page.fill('.pw-text', 'Try one thing I can use on Monday with my own email.')
  await page.click('.pw-next')                                   // Finish
  await page.waitForSelector('.pw-thanks', { timeout: 15_000 })
  assert.equal(await page.locator('.pw-thanks-title').innerText(), 'All done. Thank you.')
  await settle()
  if (shots) await page.screenshot({ path: join(shots, 'live-phone-all-done.png') })
  pass('a phone does the seven steps and gets the thank-you')

  let held = await results()
  const byRef = (entries) => Object.fromEntries(entries.filter((e) => e.kind !== 'question').map((e) => [`${e.kind}:${e.stepId}`, e]))
  const refs = byRef(held.entries)
  assert.deepEqual(Object.keys(refs).sort(), [
    'answer:pwhope', 'answer:pwquiz', 'answer:pwtools', 'done:pwtask1', 'done:pwtask2',
    'read:pwagent', 'read:pwtask1', 'read:pwtask2', 'read:pwwelcome',
  ], 'one entry per step for each read, answer and done mark')
  assert.equal(refs['answer:pwquiz'].choice, quiz[1].optionId)
  assert.deepEqual([...refs['answer:pwtools'].choice].sort(), [tools[0].optionId, tools[2].optionId].sort())
  assert.equal(refs['answer:pwhope'].text, 'Try one thing I can use on Monday with my own email.')
  assert.equal(refs['done:pwtask1'].done, true, 'task 1 was ticked, unticked and ticked: it is done (the latest wins)')
  assert.equal(refs['done:pwtask2'].done, true)
  const questions = held.entries.filter((e) => e.kind === 'question')
  assert.equal(questions.length, 1)
  assert.equal(questions[0].stepId, 'pwagent')
  assert.equal(questions[0].text, 'Is Copilot Chat an agent, or only the new Copilot agents?')
  assert.equal('name' in questions[0], false, 'no name was typed, so none is kept')
  assert.equal(held.people, 1)
  const dump = JSON.stringify(held)
  assert.equal(dump.includes(device), false, 'the device id is on no entry the owner reads')
  assert.equal(/"right"/.test(dump), false, 'no right answer anywhere in what the Worker holds')
  pass('the Worker holds exactly what the person did: one entry per step, latest wins, one question, no device id, no right answer')

  // ── Coming back later ───────────────────────────────────────────────────────────────────────
  const again = await a.context.newPage()
  await again.goto(`file://${file}`)
  await again.waitForSelector('.pw-app:not([hidden]) .pw-title', { timeout: 15_000 })
  await again.waitForSelector('.pw-thanks')
  assert.ok((await again.locator('.pw-meter').innerText()).includes('7 of 7 done'), 'coming back, the page shows 7 of 7 done from the Worker')
  assert.deepEqual(await again.locator('.pw-row .pw-state').allInnerTexts(), ['Read', 'Read', 'Answered', 'Answered', 'Done', 'Done', 'Answered'])
  assert.equal(await again.locator('.pw-row[data-step="2"] .pw-row-q').innerText(), 'Your question is with the speaker')
  await again.click('.pw-row[data-step="3"]')
  await again.waitForSelector('.pw-opt.is-on')
  assert.ok((await again.locator('.pw-opt.is-on').innerText()).includes('uses tools'), 'the earlier answer is on the step')
  pass('coming back later: the same device sees every earlier answer, 7 of 7 done')
  // A step untouched on purpose: untick a task and the count follows
  await again.click('.pw-back')
  await again.click('.pw-row[data-step="6"]')
  await again.click('.pw-done')
  await again.waitForSelector('.pw-done.pw-done-todo')
  await settle()
  held = await results()
  assert.equal(byRef(held.entries)['done:pwtask2'].done, false, 'unticking is kept on the Worker')
  await again.click('.pw-back')
  await again.waitForFunction(() => document.querySelector('.pw-meter').innerText.includes('6 of 7 done'))
  assert.equal(await again.locator('.pw-cta').innerText(), 'Carry on: step 6')
  pass('unticking a task is saved and "Carry on" goes back to it')
  await a.context.close()
  assert.deepEqual(a.errors, [], 'no page errors on the phone')

  // ── A second person, on a laptop ────────────────────────────────────────────────────────────
  const b = await person({ width: 1440, height: 900 })
  await b.page.click('.pw-side .pw-cta')
  await b.page.waitForSelector('.pw-stepview.is-wide')
  await b.page.fill('.pw-asktext', 'Will this be recorded?')
  await b.page.fill('.pw-name', 'Alex')
  await b.page.click('.pw-send')
  await b.page.waitForSelector('.pw-yourq', { timeout: 15_000 })
  await b.page.locator('.pw-centerhead').click()
  await b.page.keyboard.press('ArrowRight'); await b.page.keyboard.press('ArrowRight')
  await b.page.waitForSelector('.pw-opt')
  await b.page.click('.pw-opt >> nth=0'); await saved(b.page)
  if (shots) await b.page.screenshot({ path: join(shots, 'live-laptop-quick-check.png') })
  await settle()
  held = await results()
  assert.equal(held.people, 2, 'a second device is a second person')
  const asked = held.entries.filter((e) => e.kind === 'question' && e.name === 'Alex')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].stepId, 'pwwelcome')
  assert.equal(held.entries.filter((e) => e.kind === 'answer' && e.stepId === 'pwquiz').length, 2, 'one answer per person and step')
  pass('a laptop: the steps, the step and Ask about this in three columns; a question with a name; a second person is counted')

  // ── The owner closes it while a third person is on a step ───────────────────────────────────
  const c = await person({ width: 360, height: 740 })
  await c.page.click('[data-pw-cta]'); await c.page.waitForSelector('.pw-stepview')
  await c.page.click('.pw-next'); await c.page.click('.pw-next')
  await c.page.waitForSelector('.pw-opt')
  const close = await fetch(`${baseUrl}/prework/${preworkId}/close`, { method: 'POST', headers: owner })
  assert.equal(close.status, 200, 'the owner closes pre-work now')
  await c.page.click('.pw-opt >> nth=2')
  await c.page.waitForSelector('.pw-closed:visible', { timeout: 15_000 })
  assert.equal(await c.page.locator('.pw-app').isHidden(), true, 'a refused save because it closed ends the form')
  const banner = await c.page.locator('.pw-closed:visible').first().innerText()
  assert.match(banner, /Pre-work closed/)
  assert.match(banner, /3 people took part\./, 'the banner says how many took part (the third person only read a step, and counts)')
  assert.match(banner, /The session’s slides are below\./)
  await settle()
  held = await results()
  assert.equal(held.entries.filter((e) => e.kind === 'answer' && e.stepId === 'pwquiz').length, 2, 'the refused answer was not stored')
  pass('closed while someone answers: the save is refused, the form gives way to the banner with the count')
  const fresh = await browser.newPage({ viewport: { width: 360, height: 740 } })
  await fresh.goto(`file://${file}`)
  await fresh.waitForSelector('.pw-closed:visible', { timeout: 15_000 })
  assert.equal(await fresh.locator('.pw-app').isHidden(), true)
  assert.ok((await fresh.locator('.pslide-row').count()) >= 3, 'the slide list stands, with the talk\'s own slides')
  if (shots) await fresh.screenshot({ path: join(shots, 'live-phone-closed.png') })
  pass('a fresh load after it closed: the slide list with a banner')
  await c.context.close()
  await fresh.close()
  console.log('\nprework-form-live: ok')
} finally {
  await browser.close()
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
