#!/usr/bin/env node
// Captures the handout home page's layouts (locked design 2026-10-07, "Handout 4b") from the local handout
// preview: starts it on a free port, drives a phone (390 wide) and a laptop (1440 wide) page through
// before the talk -> live -> poll open -> session ended -> a second session in which the person bookmarks
// a slide and writes a note and a board opens -> ended again, and writes a full-page PNG of each.
// Headless Playwright chromium only.
// The port is fixed (4319 unless --port says otherwise) because the page prints its own address beside the
// QR code: a free port picked at random would make every capture differ.
//   node scripts/local-handout-preview-screenshots.mjs [--talk <outline.md>] [--out <dir>] [--port <n>]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { findLayoutShowcase, startLocalHandoutPreview } from './local-handout-preview.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const outDir = resolve(opt('--out') ?? join(REPO, 'docs/design/2026-10-07-handout-page-claude-design/built-screenshots'))
mkdirSync(outDir, { recursive: true })

const preview = await startLocalHandoutPreview({ talk: opt('--talk') ?? findLayoutShowcase(), port: Number(opt('--port') ?? 4319), out: join(REPO, '.local-handout-preview') })
const browser = await chromium.launch({ headless: true })
try {
  for (const [name, viewport] of [['phone-390', { width: 390, height: 844 }], ['laptop-1440', { width: 1440, height: 900 }]]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const control = (action) => page.request.post(`${preview.baseUrl}/control/api/${action}`, { data: {} })
    const layout = (want) => page.waitForFunction((w) => document.getElementById('handoutHome')?.dataset.layout === w, want, { timeout: 15000 })
    // Slide media arrive lazily and the slide is fitted two frames after it shows: a capture is written
    // only once two taken in a row are the same picture.
    const shot = async (state) => {
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(600)
      let last = await page.screenshot({ fullPage: true })
      for (let tries = 0; tries < 12; tries++) {
        await page.waitForTimeout(300)
        const next = await page.screenshot({ fullPage: true })
        const same = next.equals(last)
        last = next
        if (same) { writeFileSync(join(outDir, `${state}-${name}.png`), last); return }
      }
      throw new Error(`The ${state} capture at ${name} never settled`)
    }
    const goLive = async (slide) => {
      await control('start')
      await layout('live')
      for (let at = 1; at < slide; at++) await control('next')
      await page.locator('#hhLive .slide.active').waitFor()
      await page.locator('#hhLive #rxDock').waitFor({ state: 'visible' })
    }
    await control('end')
    await page.goto(`${preview.baseUrl}/${preview.slug}/`)
    await layout('before')
    await shot('1-before-the-talk-with-pre-work')

    await goLive(3)
    await shot('2-live-nothing-to-answer')

    await control('poll-open')
    await page.locator('#hhLive #audiencePollSurface .poll-card').waitFor({ state: 'visible', timeout: 10000 })
    await shot('3-live-poll-open')

    await control('end')
    await layout('handout')
    await shot('5-handout-after-the-session-ends')

    // A second session: the person bookmarks the slide and writes a note, then the speaker opens a board.
    // It is on another slide than the poll's: the stub gives every session the same id, so the page would
    // show the first session's poll again on that slide (a real live service issues a new id per session).
    await goLive(4)
    await page.locator('#hhLive .rx[data-rx="bookmark"]').click()
    await page.locator('#hhLive .rx-notebtn').click()
    await page.locator('.ask-panel .ask-text').fill('Try the timeline layout for the project plan.')
    await page.locator('.ask-panel .ask-send').click()
    await page.locator('.ask-panel').waitFor({ state: 'detached' })
    await control('board-open')
    await page.locator('#hhLive #bdPanel').waitFor({ state: 'visible', timeout: 10000 })
    await shot('4-live-board-open')

    // The session ends: the note and the bookmark show on the handout.
    await control('end')
    await layout('handout')
    await page.locator('#hhSession').waitFor({ state: 'visible' })
    await shot('6-handout-with-a-note-and-a-bookmark')
    await context.close()
  }
  console.log(`Screenshots written to ${outDir}`)
} finally {
  await browser.close()
  await preview.close()
}
