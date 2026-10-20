// The participant work page's drawn frames (locked mockup section 13), in headless Chromium against a
// stand-in Worker, saved under the design's own names for comparison with
// docs/design/2026-10-14-prework-journeys/hifi/shots/13-*.png.
// Usage: node scripts/work-page-shots.mjs <out dir>
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { buildWorkPageFixture } from './lib/work-page-fixture.mjs'
import { fakePreworkWorker } from './lib/prework-fake-worker.mjs'

const out = process.argv[2]
if (!out) throw new Error('Usage: node scripts/work-page-shots.mjs <out dir>')
await mkdir(out, { recursive: true })
const BASE = 'https://worker.example.test'
const SITE = 'https://handouts.fyi/dl/said-21-oct'
const DEVICE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PLAYER = '<!doctype html><body style="margin:0;height:100vh;background:linear-gradient(135deg,#2f3e52,#141c27);color:#fff;font:600 18px Georgia,serif"><div style="position:absolute;left:18px;top:14px">What the tools can do</div><div style="position:absolute;left:50%;top:50%;width:68px;height:68px;margin:-34px;border-radius:50%;background:rgba(255,255,255,.18)"></div></body>'
const browser = await chromium.launch()
const LAPTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
// 21 Oct 2026 13:00 London and 4 Nov 2026 17:00 London
const PRE_CLOSES = Date.UTC(2026, 9, 21, 12, 0)
const POST_CLOSES = Date.UTC(2026, 10, 4, 17, 0)

async function frame(name, { phase, viewport, step, seed = [], act }) {
  const preworkId = phase === 'post' ? 'shotpost0001' : 'shotpre00001'
  const { html, headers } = await buildWorkPageFixture({ phase, preworkId, workerBaseUrl: BASE, handoutUrl: SITE })
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'Europe/London' })
  await context.addInitScript(([key, id]) => { try { window.localStorage.setItem(key, id) } catch (_) {} }, [`tw-prework-device-${preworkId}`, DEVICE])
  const world = await fakePreworkWorker(context, { baseUrl: BASE, preworkId, phase, closesAt: phase === 'post' ? POST_CLOSES : PRE_CLOSES })
  if (seed.length) world.seed(DEVICE, seed)
  await context.route(`${SITE}/${phase === 'post' ? 'post' : 'pre'}-work`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: html }))
  await context.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: PLAYER }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`${SITE}/${phase === 'post' ? 'post' : 'pre'}-work`)
  await page.waitForSelector('[data-wp-cta], .wp-row')
  await page.evaluate(() => document.fonts.ready)
  await page.locator(`.wp-row[data-step="${step}"]`).first().click()
  await page.waitForSelector('.wp-centerhead, .wp-top .wp-back')
  if (act) await act(page)
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `${name}.png`) })
  if (errors.length) console.log(name, 'errors:', errors)
  await context.close()
}

const at = Date.now() - 3_600_000
const read = (stepId) => ({ ref: `read:${stepId}`, stepId, kind: 'read', at })
const pick = async (page, n) => { await page.locator('.pw-opt').nth(n).click(); await page.waitForSelector('.wp-note:not([hidden])'); await page.waitForFunction(() => document.querySelector('.wp-note').innerText.includes('Saved')) }
await frame('13-step-1-video-laptop-1280x800', { phase: 'pre', viewport: LAPTOP, step: 1 })
await frame('13-step-2-laptop-1280x800', { phase: 'pre', viewport: LAPTOP, step: 2, seed: [read('watch')], act: (page) => pick(page, 0) })
await frame('13-step-2-phone-390x844', { phase: 'pre', viewport: PHONE, step: 2, seed: [read('watch')], act: (page) => pick(page, 0) })
const answered = { ref: 'answer:quick-check', stepId: 'quick-check', kind: 'answer', choice: 'poll-quick-check-option-1', at }
await frame('13-step-3-slide-laptop-1280x800', { phase: 'pre', viewport: LAPTOP, step: 3, seed: [read('watch'), answered] })
await frame('13-step-3-slide-phone-390x844', { phase: 'pre', viewport: PHONE, step: 3, seed: [read('watch'), answered] })
await frame('13-post-step-1-laptop-1280x800', { phase: 'post', viewport: LAPTOP, step: 1, act: (page) => pick(page, 3) })
await frame('13-post-step-1-phone-390x844', { phase: 'post', viewport: PHONE, step: 1, act: (page) => pick(page, 3) })
await browser.close()
console.log(`work-page shots: ${out}`)
