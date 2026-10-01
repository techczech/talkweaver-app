#!/usr/bin/env node
/**
 * The audience page's deck keys must not steal keys that belong to the reader's browser or to
 * the control that has focus.
 *
 * Reported by Dominik: Enter on the focused Overview button advanced the slide (9 → 10) instead
 * of opening the overview and desynced follow; and with no modifier guard, Cmd+R toggled Reveal
 * and Cmd+F took Focus mode instead of the browser's own shortcuts.
 *
 * This pins three behaviours: (a) Enter on a focused button activates it and does not advance,
 * (b) a Meta chord never reaches the deck handler, (c) the deck keys still work with nothing
 * focused — so the guard is a guard, not a keyboard shutdown.
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
  outlinePath, readFileSync(outlinePath, 'utf8'), 'Audience page keys', statSync(outlinePath))
const deck = await buildDeckHtmlFromModel(model)
const handout = buildShareHtml({
  title: 'Audience page keys',
  slides: extractSlides(deck),
  styles: extractStyles(deck),
  includeNotes: false,
  slug: 'audience-page-keys',
  license: null,
})

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-audience-keys-'))
const file = join(scratch, 'handout.html')
await writeFile(file, handout)

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(pathToFileURL(file).href)
  await page.waitForTimeout(900)

  const slideCount = () => page.evaluate(() => document.getElementById('slideCount')?.textContent || '')
  const nothingFocused = () => page.evaluate(() => document.activeElement?.blur())

  // (a) Enter on the focused Overview button activates the button, never advances the deck.
  const before = await slideCount()
  await page.focus('#overviewBtn')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => document.getElementById('navPanel').classList.contains('open')), true,
    'Enter on the focused Overview button opens the overview')
  assert.equal(await slideCount(), before,
    `Enter on the focused Overview button moved the slide (${before} → ${await slideCount()})`)

  // (b) A modifier chord belongs to the reader's browser, not the deck: Meta+R must not toggle Reveal.
  await nothingFocused()
  await page.keyboard.press('Meta+r')
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => document.getElementById('revealBtn').getAttribute('aria-pressed')), 'false',
    'Meta+R toggled Reveal instead of leaving the chord to the browser')

  // (c) The guard is not a keyboard shutdown: with nothing focused, the deck keys still work.
  await nothingFocused()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  assert.notEqual(await slideCount(), before,
    'ArrowRight with nothing focused no longer advances the slide')

  assert.equal(errors.length, 0, `handout raised page errors: ${errors.join(' | ')}`)
  console.log('audience page keys: focused buttons keep Enter/Space, modifier chords stay with the browser, deck keys still work')
} finally {
  await browser.close()
}
