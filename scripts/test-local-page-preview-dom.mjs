// Real compiler/runtime: only the active widget runs; leaving unloads it; its origin stays opaque.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'
const dir = mkdtempSync(join(tmpdir(), 'tw-local-preview-'))
let browser
try {
  writeFileSync(join(dir, 'widget.html'), `<!doctype html><h1 id="result">Waiting</h1><script>document.querySelector('h1').textContent='Widget ready';try{parent.document.body.dataset.compromised='yes'}catch{};document.body.dataset.bridge=typeof window.tw;document.body.dataset.node=typeof require;</script>`)
  const outline = `---\ntitle: Preview\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Widget {id=widget}\n\n[Embed: widget.html]\n\n### After {id=after}\n\n- Ordinary slide\n`
  const source = join(dir, 'outline.md'); writeFileSync(source, outline)
  const model = await prepareSource(source, outline, null, statSync(source))
  const html = markSlidePreviewHtml(model.fullHtml, { localPages: true })
  const file = join(dir, 'preview.html'); writeFileSync(file, html)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(pathToFileURL(file).href + '#widget')
  const widget = page.locator('.slide.active figure[data-embed="local"] iframe')
  await widget.waitFor()
  await page.waitForFunction(() => document.querySelector('.slide.active iframe')?.hasAttribute('srcdoc'))
  const child = await (await widget.elementHandle()).contentFrame()
  await child.locator('#result').waitFor()
  assert.equal(await child.locator('#result').textContent(), 'Widget ready')
  assert.equal(await child.locator('body').getAttribute('data-bridge'), 'undefined')
  assert.equal(await child.locator('body').getAttribute('data-node'), 'undefined')
  assert.equal(await page.locator('body').getAttribute('data-compromised'), null)
  assert.equal(await widget.getAttribute('sandbox'), 'allow-scripts allow-forms')
  await page.evaluate(() => { location.hash = '#after' })
  await page.waitForFunction(() => !document.querySelector('figure[data-embed="local"] iframe')?.hasAttribute('srcdoc'))
  assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'after')
  console.log('PASS: 7 live authoring preview and sandbox assertions')
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
