import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-contrast-variants-'))
let probeNumber = 0

async function compile(label, trigger, pairCount = 4) {
  const pairs = Array.from({ length: pairCount }, (_, index) => `- Old ${index + 1} / New ${index + 1}`)
  const source = [
    '---',
    `title: ${label}`,
    'auto_title_slide: false',
    'auto_thanks_slide: false',
    '---',
    '',
    `### ${label} ${trigger}`,
    '',
    ...pairs,
  ].join('\n')
  const sourcePath = join(dir, `${++probeNumber}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`)
  writeFileSync(sourcePath, source, 'utf8')
  const model = await prepareSource(sourcePath, source, label, statSync(sourcePath))
  const html = await buildDeckHtmlFromModel(model)
  return { model, html }
}

function contrastGrid(html, className) {
  const start = html.indexOf(`<div class="contrast-grid ${className}">`)
  assert.notEqual(start, -1, `${className}: contrast grid is present`)
  const end = html.indexOf('</div></div>', start)
  assert.notEqual(end, -1, `${className}: contrast grid closes after its pair rows`)
  return html.slice(start, end + '</div></div>'.length)
}

for (const variant of ['ledger', 'rows', 'tint', 'flip']) {
  const { html } = await compile(`Contrast ${variant}`, `{contrast=${variant}}`)
  const grid = contrastGrid(html, `contrast-${variant}`)
  const rows = [...grid.matchAll(/<div class="contrast-pair">([\s\S]*?)<\/div>/g)]
  assert.equal(rows.length, 4, `${variant}: renders exactly four contrast-pair blocks`)
  rows.forEach((row, index) => {
    const spans = [...row[1].matchAll(/<span(?: class="[^"]+")?>([\s\S]*?)<\/span>/g)].map((match) => match[1])
    assert.equal(spans[0], `Old ${index + 1}`, `${variant}: left term is the first span`)
    assert.equal(spans.at(-1), `New ${index + 1}`, `${variant}: right term is the last span`)
  })
  if (variant === 'rows') assert.match(grid, /<span class="ct-arrow"[^>]*>→<\/span>/, 'rows: renders the arrow glyph in the middle column')
}

const explicitSix = await compile('Contrast ledger six', '{contrast=ledger}', 6)
assert.match(explicitSix.html, /contrast-grid contrast-ledger/, 'explicit six-pair variant keeps its variant grid')
assert.doesNotMatch(explicitSix.html, /class="contrast-panels"/, 'explicit six-pair variant does not auto-switch to panels')

const bareSix = await compile('Contrast bare six', '{contrast}', 6)
assert.match(bareSix.html, /class="contrast-panels"/, 'bare six-pair contrast still auto-switches to panels')

const unknown = await compile('Contrast unknown', '{contrast=zebra}')
assert(unknown.model.warnings.includes('contrast-variant-unknown:zebra'), 'unknown variant emits the contrast-variant warning')
assert.doesNotMatch(unknown.html, /contrast-zebra/, 'unknown variant does not render an invented variant class')
assert.match(unknown.html, /contrast-grid contrast-arrows/, 'unknown variant falls back to the default device')

const bareFew = await compile('Contrast bare few', '{contrast}', 2)
const expectedBareFew = '<div class="contrast-grid contrast-arrows"><div class="contrast-pair"><span class="ct-arrow ct-left">Old 1</span><span class="ct-arrow ct-right">New 1</span></div><div class="contrast-pair"><span class="ct-arrow ct-left">Old 2</span><span class="ct-arrow ct-right">New 2</span></div></div>'
assert.equal(contrastGrid(bareFew.html, 'contrast-arrows'), expectedBareFew, 'bare few-pair output remains byte-identical')

console.log('contrast variants: all checks passed')
