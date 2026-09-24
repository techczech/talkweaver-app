#!/usr/bin/env node
/**
 * The phone detail view must never show one slide with another slide's text (ADR-0018).
 *
 * Reported by Dominik 2026-07-19: stepping Next inside full screen moved the slide while the
 * script companion below stayed on the previous slide. The cause was that stepping updated the
 * overlay directly instead of going through the one place the current slide changes. The footer's
 * Next/Previous had the same latent desync.
 *
 * This asserts the invariant — stage slide, bar title and script title agree — across EVERY
 * navigation path, so a future path that forgets to sync fails here.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outlinePath = join(root, 'docs/design/2026-07-19-phone-slides/sample-outline.md')

const model = await prepareSource(
  outlinePath, readFileSync(outlinePath, 'utf8'), 'Phone detail sync', statSync(outlinePath))
const deck = await buildDeckHtmlFromModel(model)
const handout = buildShareHtml({
  title: 'Phone detail sync',
  slides: extractSlides(deck),
  styles: extractStyles(deck),
  includeNotes: false,
  slug: 'phone-detail-sync',
  license: null,
})

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-phone-sync-'))
const file = join(scratch, 'handout.html')
await writeFile(file, handout)

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(pathToFileURL(file).href)
  await page.waitForTimeout(900)

  // NOTE: list rows hold slide CLONES that also carry .active — scope to #stage for the real one.
  const state = () => page.evaluate(() => ({
    stage: document.querySelector('#stage .slide.active')?.dataset.navTitle || '',
    bar: document.getElementById('phoneBarTitle')?.textContent || '',
    script: document.querySelector('.ps-title')?.textContent || '',
  }))
  const aligned = (s, where) => {
    assert.equal(s.bar, s.stage, `${where}: bar title shows "${s.bar}" while the slide is "${s.stage}"`)
    assert.equal(s.script, s.stage, `${where}: script shows "${s.script}" while the slide is "${s.stage}"`)
  }

  assert.equal(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), true,
    'a phone opens the handout on the slide list')

  await page.evaluate(() => document.querySelectorAll('.pslide-row')[2].click())
  await page.waitForTimeout(400)
  aligned(await state(), 'opening a slide from the list')

  // the reported bug: step inside full screen, then come back
  await page.evaluate(() => document.getElementById('phoneFull').click())
  await page.waitForTimeout(300)
  await page.evaluate(() => document.getElementById('fsNext').click())
  await page.waitForTimeout(300)
  const inFs = await page.evaluate(() => ({
    fs: document.querySelector('#fsInner .slide')?.dataset.navTitle || '',
    stage: document.querySelector('#stage .slide.active')?.dataset.navTitle || '',
  }))
  assert.equal(inFs.fs, inFs.stage, 'full screen renders the slide the deck is actually on')
  await page.evaluate(() => document.getElementById('fsClose').click())
  await page.waitForTimeout(300)
  aligned(await state(), 'after stepping in full screen')

  // the same latent desync via the footer
  await page.evaluate(() => document.getElementById('nextBtn').click())
  await page.waitForTimeout(300)
  aligned(await state(), 'after the footer Next button')
  await page.evaluate(() => document.getElementById('prevBtn').click())
  await page.waitForTimeout(300)
  aligned(await state(), 'after the footer Previous button')

  // back to the list and into a different slide
  await page.evaluate(() => document.getElementById('phoneBack').click())
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), true,
    'Back returns to the slide list')
  await page.evaluate(() => document.querySelectorAll('.pslide-row')[5].click())
  await page.waitForTimeout(400)
  aligned(await state(), 'opening a second slide from the list')

  assert.equal(errors.length, 0, `handout raised page errors: ${errors.join(' | ')}`)
  console.log('phone detail sync: slide, title and script agree across full screen, footer and list navigation')
} finally {
  await browser.close()
}
