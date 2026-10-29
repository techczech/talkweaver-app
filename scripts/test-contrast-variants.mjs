import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { mapBlocksToLayout, renderBlock } from '../compiler/scripts/lib/06-block-renderers.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { contrastModel, headIconKey, contrastRowDrawsIcon } from '../compiler/scripts/lib/vs-panels.mjs'
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const dir = mkdtempSync(join(import.meta.dirname, '../research/.tmp-contrast-variants-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
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

// ADR-0039 / 0.41 ticket 08: a bare {contrast} is the two-panel "vs" drawing at every pair count; the
// first pair names the panels from four pairs up. It no longer draws the old opposing arrows or panels.
const bareSix = await compile('Contrast bare six', '{contrast}', 6)
assert.match(bareSix.html, /class="contrast-grid contrast-vs vs-grid vs-long vs-headed"/, 'bare six-pair contrast draws the vs panels (long: five body rows)')
assert.doesNotMatch(bareSix.html, /class="contrast-panels"/, 'bare six-pair contrast no longer draws the old panel device')
const bareSixBody = bareSix.html.slice(bareSix.html.indexOf('class="contrast-grid contrast-vs'))
assert.equal([...bareSixBody.slice(0, bareSixBody.indexOf('<script')).matchAll(/class="contrast-pair vs-pair"/g)].length >= 5, true, 'five body pairs follow the head pair')
assert.match(bareSix.html, /<div class="vs-head L">[\s\S]*?Old 1<\/div><\/div><div class="vs-head R">[\s\S]*?New 1<\/div>/, 'the first pair names the panels')

const bareTwo = await compile('Contrast bare two', '{contrast}', 2)
assert.match(bareTwo.html, /class="contrast-grid contrast-vs vs-grid"/, 'a bare two-pair contrast draws the vs panels without heads')
assert.doesNotMatch(bareTwo.html, /class="vs-head /, 'two pairs: no head row (the first pair is a row)')
assert.doesNotMatch(bareTwo.html, /class="contrast-grid contrast-arrows/, 'bare contrast no longer draws opposing arrows')

const unknown = await compile('Contrast unknown', '{contrast=zebra}')
assert(unknown.model.warnings.includes('contrast-variant-unknown:zebra'), 'unknown variant emits the contrast-variant warning')
assert.doesNotMatch(unknown.html, /contrast-zebra/, 'unknown variant does not render an invented variant class')
assert.match(unknown.html, /contrast-grid contrast-vs vs-grid/, 'unknown variant falls back to the default device (the vs panels)')

// The default device draws each pair as one row across the panels and keeps the pair a direct child of the
// grid, which is what presenter stepping reads (`.contrast-grid > .contrast-pair`): both sides arrive together.
const bareFew = await compile('Contrast bare few', '{contrast}', 2)
const fewStart = bareFew.html.indexOf('<div class="contrast-grid contrast-vs')
assert.notEqual(fewStart, -1, 'the vs grid is present')
const fewGrid = bareFew.html.slice(fewStart, bareFew.html.indexOf('</section>', fewStart))
assert.equal([...fewGrid.matchAll(/<div class="contrast-pair vs-pair" style="grid-row:\d+">/g)].length, 2, 'two pairs are two direct contrast-pair rows')
assert.match(fewGrid, /<div class="vs-row L[^"]*">(?:<div class="vs-ico">[\s\S]*?<\/div>)?<div class="vs-text">Old 1<\/div><\/div><div class="vs-row R[^"]*">(?:<div class="vs-ico">[\s\S]*?<\/div>)?<div class="vs-text">New 1<\/div><\/div>/, 'a pair holds its left and right cell')

console.log('contrast variants: all checks passed')

// Two top-level items are sides; descendants belong to their own side.
function authoredContrast(body) {
  const blocks = mapBlocksToLayout('contrast', lexMarkdownBlocks(body.split('\n')))
  return { block: blocks.find((b) => b.type === 'contrast'), html: blocks.map((b) => renderBlock(b, {})).join('') }
}
const simpleSides = authoredContrast('- Manual\n- Automated')
assert.deepEqual(simpleSides.block.pairs, [['Manual', 'Automated']], 'two bullets define a single pair of sides')
const nestedSides = authoredContrast('- Before\n  - Manual work\n    - Review by hand\n  - Separate tools\n- After\n  - Automated work\n  - One workspace')
const nestedModel = contrastModel(nestedSides.block)
assert.deepEqual(nestedModel.panels.map((p) => p.head), ['Before', 'After'], 'parents name the two columns')
assert.deepEqual(nestedModel.panels.map((p) => p.rows.map((r) => r.text)), [['Manual work', 'Separate tools'], ['Automated work', 'One workspace']], 'each column keeps its own child rows')
assert.match(nestedSides.html, /Review by hand/, 'deeper descendants are not discarded')
const unequal = authoredContrast('- Before\n  - One\n  - Two\n- After\n  - Three')
assert.match(unequal.html, /Two/, 'unequal column lengths retain the last child')
const legacy = authoredContrast('- Manual / Automated\n- Slow / Fast')
assert.deepEqual(legacy.block.pairs, [['Manual', 'Automated'], ['Slow', 'Fast']], 'existing slash rows retain their interpretation')

assert.match(buildPerSlideProjections({ slides: [{title: 'Nested', blocks: [nestedSides.block]}] }, 'nested')[0].text_excerpt, /Review by hand/, 'search and export projections preserve deeper descendants')

assert.equal(headIconKey('After'), null, 'the generic side label After does not mean Adobe After Effects')
assert.equal(headIconKey('After Effects'), 'svgl:after-effects', 'the actual product name still receives its logo')
assert.equal(contrastRowDrawsIcon(nestedSides.block, 0), false, 'an explicit side head is not a body icon row')
assert.equal(contrastRowDrawsIcon(nestedSides.block, 2), true, 'the last headed body row has the right icon offset')

// The source adapter retires contrast=cards before rendering: authored legacy content
// uses the default panels and must retain descendants at every row count.
const legacyCardsSource = '### Legacy cards\n{contrast=cards}\n\n- Before\n  - One\n    - Deep detail\n  - Two\n  - Three\n  - Four\n- After\n  - Automated\n'
const legacyCardsPath = join(dir, 'legacy-cards.md')
writeFileSync(legacyCardsPath, legacyCardsSource)
const legacyCardsModel = await prepareSource(legacyCardsPath, legacyCardsSource, 'legacy-cards', statSync(legacyCardsPath))
assert.match(legacyCardsModel.fullHtml, /contrast-vs/)
assert.match(legacyCardsModel.fullHtml, /Deep detail/)
assert.doesNotMatch(legacyCardsModel.fullHtml, /class="contrast-panels"/)
