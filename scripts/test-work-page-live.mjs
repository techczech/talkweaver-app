// Work-files ticket 15 against a real live Worker (`wrangler dev`: local, throwaway secrets and state,
// nothing deployed): the participant work pages, served by a local web server with their policy header,
// completed by a phone and a laptop.
//   - a phone does the pre-work fixture (a video, a quick check, a task marked done, an open answer); the
//     owner then reads exactly those entries: one per step, anonymous (no device id), no right answer;
//   - the same phone coming back (a reload) sees "4 of 4 done" and its earlier answer;
//   - a laptop does the post-work fixture on its own object (phase post): a 1-to-5 rating, two open answers,
//     a question about a step; the Worker keeps them under post-work, and a reload shows "3 of 3 done";
//   - the owner closes pre-work: a fresh load shows the closed banner with the count.
// Usage: node scripts/test-work-page-live.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { buildWorkPageFixture } from './lib/work-page-fixture.mjs'

const worker = await startLiveWorker()
const { baseUrl, adminSecret } = worker
const json = { 'content-type': 'application/json' }
const pass = (name) => console.log(`PASS  ${name}`)
const PLAYER = '<!doctype html><title>player</title><body style="margin:0;background:#141c27"></body>'
const served = new Map()
const site = createServer((request, response) => {
  const page = served.get(request.url)
  if (!page) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...page.headers })
  response.end(page.html)
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const SITE = `http://127.0.0.1:${site.address().port}/dl/said-21-oct`
const browser = await chromium.launch()

try {
  async function phase(name, form0) {
    const created = await (await fetch(`${baseUrl}/prework`, { method: 'POST', headers: { authorization: `Bearer ${adminSecret}`, ...json }, body: '{}' })).json()
    const page = await buildWorkPageFixture({ phase: name, preworkId: created.preworkId, workerBaseUrl: baseUrl, handoutUrl: SITE })
    const owner = { authorization: `Bearer ${created.ownerToken}` }
    const now = Date.now()
    const push = await fetch(`${baseUrl}/prework/${created.preworkId}/form`, { method: 'PUT', headers: { ...owner, ...json }, body: JSON.stringify({ phase: name, opensAt: now - 60_000, closesAt: now + 3_600_000, form: page.form }) })
    assert.equal(push.status, 200, `the ${name}-work form is pushed`)
    served.set(`/dl/said-21-oct/${name}-work`, page)
    const results = async () => (await fetch(`${baseUrl}/prework/${created.preworkId}/results?after=0`, { headers: owner })).json()
    return { ...created, owner, page, results }
  }
  const pre = await phase('pre')
  const post = await phase('post')
  assert.match(pre.page.headers['Content-Security-Policy'], new RegExp(`connect-src ${baseUrl.replace(/[.]/g, '\\.')};`))

  async function person(viewport, name) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
    await context.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: PLAYER }))
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`${SITE}/${name}-work`)
    await page.waitForSelector('[data-wp-cta], .wp-thanks, .pw-closed', { timeout: 15_000 })
    return { context, page, errors }
  }
  const saved = (page) => page.waitForFunction(() => { const note = document.querySelector('.wp-note'); return note && !note.hidden && note.innerText.includes('Sent to the speaker') }, null, { timeout: 15_000 })
  const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))
  const byRef = (entries) => Object.fromEntries(entries.filter((e) => e.kind !== 'question').map((e) => [`${e.kind}:${e.stepId}`, e]))

  // ── A phone does the pre-work ───────────────────────────────────────────────────────────────
  const a = await person({ width: 390, height: 844 }, 'pre')
  const device = await a.page.evaluate((id) => localStorage.getItem(`tw-prework-device-${id}`), pre.preworkId)
  assert.match(device, /^[0-9a-f]{32}$/, 'the device keeps a random id in its own browser')
  await a.page.click('[data-wp-cta]')
  await a.page.waitForSelector('.wp-media iframe[src^="https://www.youtube-nocookie.com/embed/"]')
  await a.page.click('.wp-next')
  await a.page.locator('.pw-opt').nth(2).click(); await saved(a.page)
  await a.page.click('.wp-next')
  await a.page.click('.wp-done'); await a.page.waitForSelector('.wp-done.is-done')
  await a.page.click('.wp-next')
  await a.page.fill('.pw-text', 'How to check what it gets wrong.')
  await saved(a.page)
  await a.page.click('.wp-next')
  await a.page.waitForSelector('.wp-thanks')
  await settle()
  let held = await pre.results()
  const refs = byRef(held.entries)
  assert.deepEqual(Object.keys(refs).sort(), ['answer:quick-check', 'answer:what-you-want', 'done:try-a-prompt', 'read:try-a-prompt', 'read:watch'])
  assert.equal(refs['answer:quick-check'].choice, pre.page.form.steps[1].poll.options[2].optionId)
  assert.equal(refs['answer:what-you-want'].text, 'How to check what it gets wrong.')
  assert.equal(refs['done:try-a-prompt'].done, true)
  assert.equal(held.people, 1)
  assert.equal(held.phase, 'pre')
  const dump = JSON.stringify(held)
  assert.equal(dump.includes(device), false, 'the device id is on no entry the owner reads')
  assert.equal(/"right"/.test(dump), false, 'no right answer in what the Worker holds')
  assert.deepEqual(a.errors, [], 'no page errors on the phone')
  pass('a phone completes the pre-work: one anonymous entry per step on the Worker, no right answer')

  await a.page.reload()
  await a.page.waitForSelector('.wp-thanks', { timeout: 15_000 })
  assert.match(await a.page.locator('.wp-count').innerText(), /^4 of 4 done/)
  await a.page.click('.wp-row[data-step="2"]')
  await a.page.waitForSelector('.pw-opt.is-on')
  assert.match(await a.page.locator('.pw-opt.is-on').innerText(), /The authors/)
  pass('a reload shows 4 of 4 done and the earlier answer')
  await a.context.close()

  // ── A laptop does the post-work ─────────────────────────────────────────────────────────────
  const b = await person({ width: 1280, height: 800 }, 'post')
  assert.match(await b.page.locator('.wp-rail .wp-eyebrow').innerText(), /after the session/i)
  await b.page.click('[data-wp-cta]')
  await b.page.locator('.pw-opt').nth(4).click(); await saved(b.page)
  await b.page.fill('.wp-asktext', 'Can we have the prompts?')
  await b.page.click('.wp-askcol .wp-send')
  await b.page.waitForSelector('.wp-yourq', { timeout: 15_000 })
  await b.page.click('.wp-next')
  await b.page.fill('.pw-text', 'Ask a reviewer question of my methods section.'); await saved(b.page)
  await b.page.click('.wp-next')
  assert.equal(await b.page.locator('.wp-askcol textarea').count(), 0, '{noask}: no question box on the last step')
  await b.page.fill('.pw-text', 'Nothing.'); await saved(b.page)
  await b.page.click('.wp-next')
  await b.page.waitForSelector('.wp-thanks')
  await settle()
  held = await post.results()
  assert.equal(held.phase, 'post')
  const postRefs = byRef(held.entries)
  assert.deepEqual(Object.keys(postRefs).sort(), ['answer:one-thing', 'answer:unclear', 'answer:useful'])
  assert.deepEqual(postRefs['answer:useful'].choice, { [post.page.form.steps[0].poll.options[0].optionId]: post.page.form.steps[0].poll.labels[4].optionId })
  const asked = held.entries.filter((e) => e.kind === 'question')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].stepId, 'useful')
  assert.equal((await pre.results()).entries.some((e) => e.stepId === 'useful'), false, 'post-work answers stay on the post-work object')
  await b.page.reload()
  await b.page.waitForSelector('.wp-thanks', { timeout: 15_000 })
  assert.match(await b.page.locator('.wp-railcount').innerText(), /^3 of 3 done · open until /)
  assert.deepEqual(b.errors, [], 'no page errors on the laptop')
  pass('a laptop completes the post-work on its own object; a question about a step; a reload shows 3 of 3 done')
  await b.context.close()

  // ── Closed ──────────────────────────────────────────────────────────────────────────────────
  const close = await fetch(`${baseUrl}/prework/${pre.preworkId}/close`, { method: 'POST', headers: pre.owner })
  assert.equal(close.status, 200)
  const c = await person({ width: 390, height: 844 }, 'pre')
  await c.page.waitForSelector('.pw-closed')
  const banner = await c.page.locator('.pw-closed').innerText()
  assert.match(banner, /Pre-work closed/)
  assert.match(banner, /1 person took part\./)
  pass('closed: a fresh load shows the closed banner with the count')
  await c.context.close()
  console.log('\nwork-page-live: ok')
} finally {
  await browser.close()
  await new Promise((resolve) => site.close(resolve))
  await worker.stop()
}
