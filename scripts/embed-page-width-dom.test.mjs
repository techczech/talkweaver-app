// Per-slide page width beside text (0.38 ticket 13): {page-60} / {page-80} select fixed column
// ratios, nothing stored or an unknown value is 70/30, and only the three fixed values are stamped.
// Headless only.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { embedSplitFor } from '../compiler/scripts/lib/slot-composition.mjs'

assert.equal(embedSplitFor('60'), '60')
assert.equal(embedSplitFor('80'), '80')
assert.equal(embedSplitFor(''), '70')
assert.equal(embedSplitFor(undefined), '70')
assert.equal(embedSplitFor('55'), '70', 'an unknown value is the default')
assert.equal(embedSplitFor('80" onload="x'), '70', 'raw text is never stamped')

const dir = await mkdtemp(join(tmpdir(), 'tw-embed-width-'))
const slide = (id, trigger) => `### ${id}\n{id=${id}${trigger}}\n\n- Words beside the page\n\n[Embed: page.html]\n\n`
const outline = `---\ntitle: Page width\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n${slide('plain', '')}${slide('wide', ',page-80')}${slide('narrow', ',page-60')}${slide('bad', ',page-55')}${slide('rightwide', ',page-80,image=right')}### End\n{id=end}\n\n- Done\n`
const path = join(dir, 'outline.md')
await writeFile(path, outline)
await writeFile(join(dir, 'page.html'), '<!doctype html><title>Page</title><p>hello</p>')
const prepared = await prepareSource(path, outline, null, await stat(path), {}, {})
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(prepared.fullHtml) })
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const columnsOf = async id => {
    await page.goto(`http://127.0.0.1:${server.address().port}/#${id}`)
    await page.waitForSelector('.slide.active .slot')
    return page.evaluate(() => {
      const s = document.querySelector('.slide.active .slot')
      const widthOf = el => el.getBoundingClientRect().width
      return { split: s.getAttribute('data-embed-split'), columns: getComputedStyle(s).gridTemplateColumns.split(' ').map(parseFloat), pageWidth: widthOf(s.querySelector('.slot-media')), copyWidth: widthOf(s.querySelector('.slot-copy')) }
    })
  }
  const ratio = ({ columns }) => Math.max(...columns) / Math.min(...columns)
  const check = (got, split, expected, label) => {
    assert.equal(got.split, split, `${label}: stamped ${got.split}`)
    assert.ok(Math.abs(ratio(got) - expected) < .03, `${label}: ratio ${ratio(got)} (${got.columns})`)
    // WHICH column is the page: the page column (.slot-media) is the wider one, at 60 as at 70 and 80.
    assert.ok(got.pageWidth > got.copyWidth, `${label}: the page column (${got.pageWidth}) is wider than the copy (${got.copyWidth})`)
  }
  check(await columnsOf('plain'), '70', 7 / 3, 'nothing stored is 70/30')
  check(await columnsOf('wide'), '80', 4, 'page-80 is 4:1')
  check(await columnsOf('narrow'), '60', 3 / 2, 'page-60 is 3:2')
  check(await columnsOf('bad'), '70', 7 / 3, 'page-55 falls back to 70/30')
  const right = await columnsOf('rightwide')
  check(right, '80', 4, 'page-80 with the page on the other side')
  assert.deepEqual(errors, [])
  console.log('PASS page width beside text: 70/30 default, page-80 4:1, page-60 3:2, unknown value 70/30')
} finally {
  await browser?.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
}
