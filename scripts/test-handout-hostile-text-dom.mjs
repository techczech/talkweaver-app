#!/usr/bin/env node
// Upkeep ticket 11: an author's text can never become markup on a handout. A talk whose title and
// slide text carry <script>"'& is compiled through the real path (prepareSource → deck → handout share
// page, and the handout's viewer page), each page is opened in Playwright's bundled Chromium, and the
// characters must show as text: no injected script runs, no injected element exists, and the visible
// text holds the payload verbatim.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { viewerPageHtml } from '../src/main/handout-viewer-page.ts'

const PAYLOAD = `<script>window.__tw_pwned=1</script>"it's" & <img src=x onerror="window.__tw_pwned=2">`
const TITLE = `Hostile ${PAYLOAD}`
const outline = [
  `# ${TITLE}`, '', '## Section', '',
  `### Slide ${PAYLOAD}`, '{statement}', '', `Body ${PAYLOAD}`, '',
  '### A list', '', `- Item ${PAYLOAD}`, '- Plain', ''
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'tw-handout-hostile-'))
let browser
try {
  const path = join(dir, 'hostile-outline.md')
  writeFileSync(path, outline)
  const model = await prepareSource(path, outline, null, statSync(path), undefined, { allowedAssetRoots: [dir] })
  const deck = await buildDeckHtmlFromModel(model)
  const share = buildShareHtml({ title: model.title, slug: 't', includeNotes: true, license: null, slides: extractSlides(deck), styles: extractStyles(deck) })
  const viewer = await viewerPageHtml({ title: model.title, handoutFile: 'handout.html', url: 'https://x.test/t', qr: '' }, resolve(import.meta.dirname, '../compiler/scripts'))
  writeFileSync(join(dir, 'handout.html'), share)
  writeFileSync(join(dir, 'index.html'), viewer)

  browser = await chromium.launch({ headless: true })
  for (const [name, file] of [['handout', 'handout.html'], ['viewer page', 'index.html']]) {
    const page = await browser.newPage()
    try {
      await page.goto(pathToFileURL(join(dir, file)).href, { waitUntil: 'load' })
      await page.waitForTimeout(300)
      const seen = await page.evaluate(() => ({
        pwned: window.__tw_pwned,
        title: document.title,
        text: document.body.innerText,
        injectedImg: document.querySelectorAll('img[src="x"]').length,
        // A <script> made from the text would be an element whose whole body is the payload's code. The
        // deck's own scripts carry the outline text as data (SLIDE_SCRIPT, JSON blocks) and do not count.
        injectedScript: [...document.scripts].some((s) => s.textContent.trim() === 'window.__tw_pwned=1'),
      }))
      assert.equal(seen.pwned, undefined, `${name}: injected script ran`)
      assert.equal(seen.injectedImg, 0, `${name}: an <img> from the text became an element`)
      assert.equal(seen.injectedScript, false, `${name}: a <script> from the text became an element`)
      assert.ok(seen.title.includes(PAYLOAD), `${name}: <title> shows the title as text: ${JSON.stringify(seen.title)}`)
      assert.ok(seen.text.includes(PAYLOAD), `${name}: the page shows the payload as text`)
      console.log(`ok ${name}: title and text show <script>"'& as text; nothing injected`)
    } finally {
      await page.close()
    }
  }
  console.log('PASS handout hostile text')
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
