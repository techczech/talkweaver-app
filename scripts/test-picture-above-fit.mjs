import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'tw-picture-above-fit-'))
const assets = join(import.meta.dirname, 'fixtures/layout')
const image = join(assets, 'sample-image.png')
const points = [
  'Put the labelled trays on the top shelf',
  'Leave the spare gloves by the door',
  'Sort the garden tools before lunch',
  'Find a dry place for the bags of seed',
  'Bring the empty pots back from the shed',
  'Check the tap beside the greenhouse',
  'Write the new dates on the rota',
  'Return the keys to the shared cupboard'
]
const styles = [
  ['plain', '{list}', false],
  ['icons', '{list}{iconlist}{iconlist=list}', true],
  ['automatic-icons', '{list}{iconlist}', true]
]
const cases = styles.flatMap(([kind, codes, marked]) => points.map((_point, index) => ({
  id: `${kind}-${index + 1}`,
  count: index + 1,
  codes,
  marked,
  vertical: kind !== 'automatic-icons'
})))
cases.push({ id: 'side-caption', count: 8, codes: '{list}{sidebar}', marked: false, caption: true, vertical: true })

let browser
try {
  copyFileSync(image, join(scratch, 'picture.png'))
  const text = [
    '---', 'title: Picture fit', 'auto_title_slide: false', 'auto_thanks_slide: false',
    'defaults: { title: sidebar }', '---', '', '## Fixtures', '',
    ...cases.flatMap(({ id, count, codes, marked, caption }) => [
      `### Garden jobs {id=${id}}`, `${codes}{image=above}`, '',
      `![Planting beds](picture.png${caption ? ' "Planting beds after watering"' : ''})`, '',
      ...points.slice(0, count).map(point => `- ${point}${marked ? ' {icon=lucide:sprout}' : ''}`), ''
    ])
  ].join('\n')
  const path = join(scratch, 'fit.html')
  const model = await prepareSource(join(scratch, 'fit-outline.md'), text, 'Picture fit', statSync(image))
  writeFileSync(path, model.fullHtml)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.route(/^https?:/, route => route.abort())
  await page.goto(pathToFileURL(path).href)
  await page.evaluate(() => document.fonts.ready)
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    for (const { id, count, marked, caption, vertical } of cases) {
      await page.evaluate(slideId => { window.location.hash = slideId }, id)
      const slide = page.locator(`section.slide.active[data-id="${id}"]`)
      const dimensions = await slide.evaluate(async element => {
        const image = element.querySelector('.slot-media img')
        await image.decode()
        await new Promise(requestAnimationFrame)
        const picture = image.getBoundingClientRect()
        const stage = element.getBoundingClientRect()
        const items = [...element.querySelectorAll('.slot-copy .feature-list > li')]
        const rects = items.map(item => item.getBoundingClientRect())
        const caption = element.querySelector('figcaption')
        return {
          placement: element.dataset.titleLayout,
          pictureWidth: picture.width, pictureHeight: picture.height, stageWidth: stage.width,
          correctOrder: rects.every((rect, index) => index === 0 || rects[index - 1].bottom <= rect.top + 1),
          gap: Math.min(...rects.map(rect => rect.top)) - picture.bottom,
          bottomRoom: stage.bottom - Math.max(...rects.map(rect => rect.bottom)),
          visible: rects.every(rect => rect.width > 0 && rect.height > 0 && rect.left >= stage.left && rect.right <= stage.right),
          count: items.length, icons: items.filter(item => item.querySelector('.fl-icon svg')).length,
          hasCaption: Boolean(caption), radius: getComputedStyle(image).borderBottomLeftRadius
        }
      })
      const detail = `${theme} ${id}: ${JSON.stringify(dimensions)}`
      assert.equal(dimensions.placement, 'top', detail)
      assert.equal(dimensions.count, count, detail)
      assert.equal(dimensions.icons, marked ? count : 0, detail)
      assert.ok(dimensions.visible && (!vertical || dimensions.correctOrder) && dimensions.gap > 0 && dimensions.bottomRoom >= 12, detail)
      assert.ok(dimensions.pictureWidth > dimensions.stageWidth * .75 && dimensions.pictureHeight >= 56, detail)
      if (caption) assert.ok(dimensions.hasCaption && parseFloat(dimensions.radius) > 0, detail)
      if (process.env.TW_SLIDE_DESIGN_CAPTURE === '1' && (caption || count === 8)) {
        const capture = await slide.screenshot({ type: 'jpeg', quality: 75 })
        console.log(`SLIDE_DESIGN_CAPTURE ${id} ${theme} ${capture.toString('base64')}`)
      }
      if (caption || count === 1 || count === 8) console.log(detail)
    }
  }
  console.log(`Picture Above fits all ${cases.length * 2} slide and theme combinations.`)
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}
