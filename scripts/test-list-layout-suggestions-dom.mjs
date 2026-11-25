import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { measureLayoutPreview } from '../src/shared/layout-preview-measurement.ts'
import { previewListLayout } from '../src/shared/layout-verbs.ts'
import { classifyListLayout, listLayoutCandidates } from '../src/shared/list-layout-suggestions.ts'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

const outline = `---
title: Compiler layout suggestions fixture
auto_title_slide: false
auto_thanks_slide: false
---

## Two groups

### Oracle and tool user
{contrast}{id=example}

- Oracle
  - What is the answer?
  - Works from memory
  - Gives you text
- Tool user
  - Find out, and show me how
  - Works on your files and sources
  - Gives you data, code and a record
`

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' })
  await page.route('**/*', route => route.abort())
  const measure = async (candidate) => {
    const text = previewListLayout(outline, 'example', candidate)
    const model = await prepareSource('layout-suggestions-fixture.md', text, 'Layout suggestions')
    await page.setContent(markSlidePreviewHtml(model.fullHtml), { waitUntil: 'domcontentloaded' })
    const { words, ...check } = candidate.check
    const evidence = await page.evaluate(`(async () => {
      await document.fonts.ready;
      document.querySelectorAll('#stage .slide').forEach(slide => {
        slide.classList.toggle('active', slide.dataset.id === 'example');
      });
      window.__autofitForTest?.();
      return (${measureLayoutPreview.toString()})(${JSON.stringify(check)});
    })()`)
    return classifyListLayout(candidate, evidence, model.warnings.filter(warning => warning.split(':')[1] === 'example'))
  }

  const candidates = listLayoutCandidates(outline, 'example')
  const tint = candidates.find(candidate => candidate.label === 'Contrast, tinted')
  assert.deepEqual(await measure(tint), { kind: 'fits-as-is' })
  const grid = candidates.find(candidate => candidate.layout === 'grid')
  assert.match(classifyListLayout(grid).reason, /sub-points/)
  // Bypass the shape refusal in this probe so the real compiled drawing must catch the loss too.
  const result = await measure({ ...grid, reason: undefined })
  assert.equal(result.kind, 'not-offered')
  assert.match(result.reason, /leave out/)
  console.log('The compiled Contrast preview keeps every word. The compiled Grid preview drops nested points and is refused.')
} finally {
  await browser.close()
}
