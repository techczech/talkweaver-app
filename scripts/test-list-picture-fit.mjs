import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

const points = ['Label the jars', 'Check the shelves', 'Share the spares']
const lead = 'We agreed on three jobs for Saturday.'
const picture = '![Workshop shelves](../demo-vault/layout-sampler/assets/sample-image.png)'
const cases = [
  { id: 'list', trigger: '{list}', lead: '', layout: 'list-visual' },
  { id: 'inferred-list', trigger: '', lead: '', layout: 'list-visual' },
  { id: 'copy', trigger: '{list}', lead, layout: 'copy-visual' },
  { id: 'inferred-copy', trigger: '', lead, layout: 'copy-visual' },
]
const body = (paragraph) => [paragraph, '', ...points.map((point) => `- ${point}`), '', picture, '']
const source = [
  '---', 'title: Workshop jobs', 'auto_title_slide: false', 'auto_thanks_slide: false', 'defaults:', '  title: top',
  'sections:', '  Arranged: { image: above }', '---', '',
  '## Pasted pictures', '',
  ...cases.flatMap((slide) => [`### Workshop jobs {id=${slide.id}}`, slide.trigger, '', ...body(slide.lead)]),
  '### Explicit placement {id=explicit}', '{list image=right}', '', ...body(''),
  '### Two pictures {id=two}', '{list}', '', ...body(''), picture, '',
  '### Points alone {id=points}', '{list}', '', ...points.map((point) => `- ${point}`), '',
  '## Arranged', '',
  '### Inherited placement {id=inherited}', '{list}', '', ...body(''),
].join('\n')
const here = fileURLToPath(import.meta.url)
const model = await prepareSource(here.replace(/\.mjs$/, '.md'), source, '', statSync(here), undefined, {
  allowedAssetRoots: [fileURLToPath(new URL('..', import.meta.url))],
})
for (const id of ['explicit', 'two', 'points', 'inherited']) {
  assert.equal(model.slides.find((slide) => slide.id === id)?.layout, 'list', id)
}

const html = markSlidePreviewHtml(model.fullHtml)
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, colorScheme: 'light' })
  await page.route('**/*', (route) => route.request().url().startsWith('http://tw-preview.test/')
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort())
  for (const slide of cases) {
    await page.goto('about:blank')
    await page.goto(`http://tw-preview.test/#${slide.id}`)
    const active = page.locator(`.stage > .slide.active[data-id="${slide.id}"]`)
    await active.waitFor()
    const drawn = await active.evaluate(async (section) => {
      await document.fonts.ready
      const image = section.querySelector('figure img')
      await image.decode()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const stage = section.closest('.stage').getBoundingClientRect()
      const bounds = (element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const rect = range.getBoundingClientRect()
        return {
          text: element.textContent.trim(),
          top: rect.top,
          bottom: rect.bottom,
          inside: rect.height > 0 && rect.width > 0 && rect.top >= stage.top - 1 && rect.bottom <= stage.bottom + 1
            && rect.left >= stage.left - 1 && rect.right <= stage.right + 1,
        }
      }
      return [...section.querySelectorAll('.slide-content li, .slide-content p')].map(bounds)
    })
    const expected = slide.lead ? [slide.lead, ...points] : points
    assert.deepEqual(drawn.map((item) => item.text), expected, slide.id)
    for (const item of drawn) assert.ok(item.inside, `${slide.id}: "${item.text}" is outside the stage (y ${item.top}–${item.bottom})`)
    assert.equal(await active.getAttribute('data-layout'), slide.layout, slide.id)
  }
} finally {
  await browser.close()
}
console.log('test:list-picture-fit — all points and lead paragraphs fit with and without {list}')
