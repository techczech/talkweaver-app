import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const { renderInline } = await import(new URL('../compiler/scripts/lib/02-triggers-layout.mjs', import.meta.url))
const inlineMark = await import(new URL('../src/renderer/src/extensions/inlineMark.ts', import.meta.url))
const inlineProtection = await import(new URL('../compiler/scripts/lib/00-inline-protection.mjs', import.meta.url))
const { prepareSource } = await import(new URL('../compiler/scripts/lib/08-source-adapters.mjs', import.meta.url))
const { extractSlides, extractStyles } = await import(new URL('../compiler/scripts/lib/04-html-extraction.mjs', import.meta.url))
const { buildShareHtml } = await import(new URL('../compiler/scripts/lib/09-output-builders.mjs', import.meta.url))

assert.equal(
  renderInline('the ==feedback is the lesson== here'),
  'the <mark class="ink-marker">feedback is the lesson</mark> here'
)
assert.equal(
  renderInline('==**bold inside**=='),
  '<mark class="ink-marker"><strong>bold inside</strong></mark>',
  'marker composes with other inline passes'
)
assert.equal(
  renderInline('**Read `src/data/presentation.json`** from…'),
  '<strong>Read <code>src/data/presentation.json</code></strong> from…',
  'emphasis spans protected code exactly as it did before mark support'
)
assert.equal(
  renderInline('**`markdown`** (its text…), and **`images`**'),
  '<strong><code>markdown</code></strong> (its text…), and <strong><code>images</code></strong>',
  'two bold-wrapped code spans cannot re-pair their orphaned markers across prose'
)
assert.equal(
  renderInline('`[slide N](/slides/N)`'),
  '<code><a href="/slides/N" target="_blank" rel="noopener">slide N</a></code>',
  'the historical links-inside-code oddity remains byte-identical for ==-free input'
)
assert.ok(!renderInline('a == b == c').includes('<mark'), 'spaced == comparison text never marks')
assert.ok(!renderInline('====').includes('<mark'), 'empty marker never fires')
assert.ok(renderInline('==x <script>==').includes('&lt;script&gt;'), 'escapeHtml ran first — marker cannot smuggle HTML')
assert.equal(
  renderInline('`x==y` coerces but `x===y`'),
  '<code>x==y</code> coerces but <code>x===y</code>',
  'comparison operators inside two code spans stay intact and never open a marker across them'
)
for (const comparison of [
  '2==2 and 3==3',
  'let a==b, c==d;',
  'a==b==c',
  '===x==='
]) {
  assert.equal(renderInline(comparison), comparison, `${comparison} stays literal comparison prose`)
}
assert.equal(renderInline('`==x==`'), '<code>==x==</code>', 'marker syntax inside inline code stays literal')
assert.equal(
  renderInline('==a== and ==b=='),
  '<mark class="ink-marker">a</mark> and <mark class="ink-marker">b</mark>',
  'two intentional markers on one line render independently without bleeding'
)
assert.equal(renderInline('==a=b=='), '==a=b==', 'an equals character inside a marker is outside the grammar')
assert.equal(renderInline('==a\nb=='), '==a\nb==', 'a marker cannot span a line break')

assert.equal(
  renderInline('prose ==real mark== then `**opt** /==eq==/` end'),
  'prose <mark class="ink-marker">real mark</mark> then <code><strong>opt</strong> /==eq==/</code> end',
  'a mark before code fires while marker syntax stays literal and legacy emphasis still renders inside code'
)
assert.equal(
  renderInline('`**flag**` and ==this matters=='),
  '<code><strong>flag</strong></code> and <mark class="ink-marker">this matters</mark>',
  'a code span at offset zero keeps legacy emphasis and cannot suppress a later mark'
)
for (const [source, expected] of [
  ['`**start**` then ==mark==', '<code><strong>start</strong></code> then <mark class="ink-marker">mark</mark>'],
  ['before `**middle**` then ==mark==', 'before <code><strong>middle</strong></code> then <mark class="ink-marker">mark</mark>'],
  ['==mark== then `**end**`', '<mark class="ink-marker">mark</mark> then <code><strong>end</strong></code>']
]) {
  assert.equal(renderInline(source), expected, 'legacy strong rendering inside code remains stable at every line position')
}
assert.equal(
  renderInline('see `==a== *b*` here'),
  'see <code>==a== <em>b</em></code> here',
  'the independent tester reproduction protects marker syntax while preserving legacy emphasis in code'
)
assert.equal(
  renderInline('==one== `**a** ==x==` ==two== ``*b* ==y==`` ==three=='),
  '<mark class="ink-marker">one</mark> <code><strong>a</strong> ==x==</code> <mark class="ink-marker">two</mark> <code><em>b</em> ==y==</code> <mark class="ink-marker">three</mark>',
  'multiple code runs and marks remain isolated when interleaved'
)

assert.equal(
  renderInline('[EEF report](https://eef.example "The ==key== finding")'),
  '<a href="https://eef.example" title="The ==key== finding" target="_blank" rel="noopener">EEF report</a>',
  'marker source in a link title stays literal and cannot corrupt anchor attributes'
)
assert.equal(
  renderInline('[l](https://ex.com/wiki/==Topic==)'),
  '<a href="https://ex.com/wiki/==Topic==" target="_blank" rel="noopener">l</a>',
  'marker source in a link URL stays literal and the link still forms'
)
assert.equal(
  renderInline('[read ==x== now](https://ex.com/report)'),
  '<a href="https://ex.com/report" target="_blank" rel="noopener">read ==x== now</a>',
  'visible link text is protected this wave, so marker delimiters render literally'
)

for (let length = 4; length <= 8; length += 1) {
  const equals = '='.repeat(length)
  assert.equal(renderInline(equals), equals, `${length} consecutive equals stay literal`)
}

assert.equal(
  typeof inlineMark.inlineMarkRanges,
  'function',
  'the editor decorator exposes its protected-range matcher for behavioural parity tests'
)
const decoratedSource = '==shown== `==hidden== *code*` [==link==](https://ex.com/==Topic== "==title==") ==after=='
assert.deepEqual(
  inlineMark.inlineMarkRanges(decoratedSource).map(({ from, to }) => decoratedSource.slice(from, to)),
  ['shown', 'after'],
  'the editor decorates only marker interiors outside code and every part of a link'
)
assert.deepEqual(
  inlineMark.inlineMarkRanges('``==code==`` and ==inner text=='),
  [{ from: 19, to: 29 }],
  'backtick runs are protected and the decoration covers inner text rather than == delimiters'
)
const separatedBackticks = [
  '`orphan opener',
  '==line two remains visible==',
  '==line three remains visible==',
  'orphan closer`'
].join('\n')
assert.deepEqual(
  inlineMark.inlineMarkRanges(separatedBackticks)
    .map(({ from, to }) => separatedBackticks.slice(from, to)),
  ['line two remains visible', 'line three remains visible'],
  'unmatched backticks in different blocks do not suppress decorations on intervening lines'
)
assert.match(
  readFileSync(new URL('../src/renderer/src/extensions/inlineMark.ts', import.meta.url), 'utf8'),
  /view\.visibleRanges/,
  'the editor decoration pass is bounded to CodeMirror visible ranges'
)

let pathological = ''
for (let runLength = 1; pathological.length + runLength + 1 <= 16_000; runLength += 1) {
  pathological += '`'.repeat(runLength) + 'a'
}
inlineProtection.segmentInlineSource(pathological)
const scanStarted = performance.now()
inlineProtection.segmentInlineSource(pathological)
const scanElapsedMs = performance.now() - scanStarted
assert(
  scanElapsedMs < 10,
  `a ${pathological.length}-character unmatched-backtick line scans in under 10ms (actual ${scanElapsedMs.toFixed(2)}ms)`
)

const repo = resolve(new URL('..', import.meta.url).pathname)
console.log(`inline marker pins: protected code/link ranges; comparisons and equals runs literal; ${scanElapsedMs.toFixed(2)}ms pathological scan`)

const scratch = mkdtempSync(join(repo, '.tw-inline-mark-fixture-'))
try {
  const outlinePath = join(scratch, 'inline-mark-outline.md')
  const source = [
    '---',
    'title: Inline marker fixture',
    'auto_title_slide: false',
    'auto_thanks_slide: false',
    '---',
    '',
    '### Marker',
    '',
    'The ==feedback is the lesson==.'
  ].join('\n')
  writeFileSync(outlinePath, source)
  const model = await prepareSource(outlinePath, source, 'inline-marker', statSync(outlinePath))
  const handout = buildShareHtml({
    title: model.title,
    slides: extractSlides(model.fullHtml),
    styles: extractStyles(model.fullHtml),
    includeNotes: false,
    slug: 'inline-marker',
    license: null
  })
  const markerHtml = '<mark class="ink-marker">feedback is the lesson</mark>'
  assert.ok(model.fullHtml.includes(markerHtml), 'compiled deck output contains ink-marker markup')
  assert.ok(handout.includes(markerHtml), 'compiled handout output contains ink-marker markup')
  console.log('fixture: deck ink-marker=present; handout ink-marker=present')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('test:render-inline-mark OK')
