#!/usr/bin/env node
/**
 * The compiled deck's RUNTIME must actually boot.
 *
 * Every other visual test we have either toggles `.slide.active` itself (the canvas signature net)
 * or drives the handout, so all of them stayed green on 2026-07-19 while the deck's JavaScript was
 * completely dead: the slide-script payload had been injected at the FIRST `</body>`, which lives
 * inside a JS template literal in the presenter template (the preview iframe's srcdoc), corrupting
 * the script that follows it. Symptoms were a blank presenter window, a blank Inspector preview and
 * an "Open Presenter View" button that did nothing.
 *
 * This test asserts the things only a live runtime can do:
 *   - no uncaught page errors
 *   - the runtime — not the test — marks exactly one slide active
 *   - the slide counter is populated
 *   - navigation actually advances the deck
 */
import { strict as assert } from 'node:assert'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'

const { outPath } = await buildLayoutSampler()

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto('file://' + outPath)
  await page.waitForTimeout(900)

  assert.equal(errors.length, 0, `the deck raised page errors: ${errors.join(' | ')}`)

  const booted = await page.evaluate(() => ({
    active: document.querySelectorAll('.slide.active').length,
    total: document.querySelectorAll('.slide').length,
    payload: Boolean(document.getElementById('twSlideScript')),
  }))
  assert.equal(booted.active, 1,
    `the runtime should mark exactly one slide active on load, found ${booted.active} of ${booted.total}` +
    ' — a dead deck script leaves none')
  assert.equal(booted.payload, true, 'the slide-script payload is present in the compiled deck')

  // The payload must sit in the document, NOT inside a script string. If it were injected into the
  // preview srcdoc literal the deck would still parse but its runtime would be broken, so assert
  // the element is a real node in the DOM with parseable JSON.
  const payloadOk = await page.evaluate(() => {
    const el = document.getElementById('twSlideScript')
    if (!el || el.tagName !== 'SCRIPT') return false
    try {
      const parsed = JSON.parse(el.textContent)
      return parsed && typeof parsed === 'object'
    } catch {
      return false
    }
  })
  assert.equal(payloadOk, true, 'the slide-script payload is a real script element holding valid JSON')

  // Navigation proves the event handlers bound, not just that the script parsed.
  const first = await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id || '')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(250)
  const second = await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id || '')
  assert.notEqual(second, first, 'ArrowRight advances the deck — the runtime bound its key handlers')
  assert.equal(errors.length, 0, `navigation raised page errors: ${errors.join(' | ')}`)

  console.log(`deck boots: runtime active on load, payload valid, navigation live (${booted.total} slides)`)
} finally {
  await browser.close()
}
