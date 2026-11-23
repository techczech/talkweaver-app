import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'

const directory = join(import.meta.dirname, 'fixtures/layout')
const path = join(directory, 'fixture-outline.md')
const stat = statSync(join(directory, 'sample-image.png'))
const frontmatter = ['---', 'title: Slide designs', 'auto_title_slide: false', 'auto_thanks_slide: false']

const placements = [
  ['sidebar', 'left', '35'], ['title=side', 'left', '35'], ['title=sidebar', 'left', '35'],
  ['titletop', 'top', null], ['title=top', 'top', null], ['split=40', 'left', '40']
]
const cases = placements.flatMap(([code, expected, split]) => [
  [`{${code}}{title=show}`, expected, split], [`{title=show}{${code}}`, expected, split]
])
cases.push(['{notitle}', 'hidden', null], ['{title=off}', 'hidden', null])

for (const inherited of ['top', 'left', 'side', 'sidebar']) {
  const text = [
    ...frontmatter, `defaults: { title: ${inherited} }`, '---', '## Fixtures',
    ...cases.flatMap(([codes], index) => [
      `### Explicit placement {id=case-${index}}`, `{list}${codes}`, '', '- One', '- Two', ''
    ])
  ].join('\n')
  const model = await prepareSource(path, text, 'Title precedence', stat)
  const dom = new JSDOM(model.fullHtml)
  try {
    for (const [index, [codes, expected, split]] of cases.entries()) {
      const slide = dom.window.document.querySelector(`.stage > section.slide[data-id="case-${index}"]`)
      const context = `defaults.title=${inherited} with ${codes}`
      assert.equal(slide?.getAttribute('data-title-layout'), expected, context)
      assert.equal(slide.getAttribute('data-split'), split, context)
    }
  } finally {
    dom.window.close()
  }
}
console.log(`Title precedence: ${cases.length * 4} cases passed.`)

const compile = async (table = '', picture = '') => {
  const text = [
    ...frontmatter, '---',
    '## Fixtures',
    '### Measurements {id=table}', table, '',
    '| Item | Count |', '| --- | --- |', '| Birch | 12 |', '| Oak | 18 |', '',
    '### Pictures and points {id=picture}', picture, '',
    '![Sample](sample-image.png)', '', '- Sun {icon=lucide:sun}', '- Water {icon=lucide:droplet}', '',
    '### Picture only {id=only}', picture, '', '![Sample](sample-image.png)'
  ].join('\n')
  const model = await prepareSource(path, text, 'Slide designs', stat)
  const dom = new JSDOM(model.fullHtml)
  const rows = buildPerSlideProjections(model, 'slide-designs')
  const sections = Object.fromEntries([...dom.window.document.querySelectorAll('.stage > section.slide')].map(slide => [slide.dataset.id, slide.outerHTML]))
  dom.window.close()
  return { model, rows, sections }
}

const legacy = await compile()
assert.doesNotMatch(legacy.model.fullHtml, /\.table-row-bands|data-slot-side="above"/)

const banded = await compile('{table-bands=on}')
assert.match(banded.sections.table, /<table class="slide-table table-row-bands"/)
assert.match(banded.sections.table, /<thead><tr><th>Item<\/th><th>Count<\/th>/)
assert.match(banded.sections.table, /<tbody><tr><td>Birch<\/td><td>12<\/td>/)
assert.equal(banded.sections.picture, legacy.sections.picture)

const above = await compile('', '{iconrow image=above sidebar}')
assert.match(above.sections.picture, /class="slot" data-slot-side="above"/)
assert.match(above.sections.picture, /class="icon-row count-2/)
assert.match(above.sections.picture, /data-title-layout="top"/)
assert.match(above.sections.picture, /class="slot-copy"[\s\S]*class="slot-media"/)
assert.deepEqual(above.rows.find(row => row.slide_id === 'picture').image_placements, [{ kind: 'above', index: 1, count: 1 }])
assert.doesNotMatch(above.sections.only, /data-slot-side="above"/)
assert.equal(above.sections.table, legacy.sections.table)
const beside = await compile('', '{iconrow image=right sidebar}')
assert.match(beside.sections.picture, /data-title-layout="left"/)
assert.deepEqual([...banded.model.warnings, ...above.model.warnings].filter(warning => warning.startsWith('unresolved-trigger:')), [])
console.log('Slide designs: Row bands preserves the header and cells. Picture Above retains reading order, renders a row of icons and projects Above text.')
