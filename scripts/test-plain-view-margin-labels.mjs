// test:plain-view-margin-labels — the Plain margin's labels (spec T7), from the real compiler's rows.
//   - the `#` line reads Talk; section dividers read Section; every other row reads Slide n with the
//     number the slide gutter shows (compiled index + 1);
//   - the layout name is the written layout's registry label ("Icon list"), or Auto when none is written;
//   - headings in fenced code and frontmatter are not labelled;
//   - nothing compiled (rows null or empty): depth decides, the layout name still comes from the text.
import { strict as assert } from 'node:assert'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { computeSlideLines, slideNumbersByLine } from '../src/shared/slide-lines.ts'
import { marginLabels } from '../src/shared/plain-view-margin.ts'

const outline = `---
title: Margin demo
---

# Margin demo

## Part one
{id=one}

### First slide
{id=first}

Body

### Second slide
{iconlist}
{id=second}

- One
- Two

\`\`\`bash
# not a heading
{statement}
\`\`\`

### Third slide {cards}

#### Folded child
Child body

## Part two

### Fourth slide
{image-grid}{id=fourth}
`

const model = await prepareSource('/tmp/margin-labels.md', outline, 'margin')
const rows = buildPerSlideProjections(model, 'margin')
const lines = outline.split('\n')
const lineOf = (text) => lines.findIndex((l) => l === text || l.startsWith(text)) + 1
const byLine = (labels) => new Map(labels.map((l) => [l.line, l]))

const labels = marginLabels(rows, outline)
const at = byLine(labels)
assert.equal(labels.length, 8, 'eight heading lines, none from the fence or frontmatter: ' + labels.map((l) => l.line))
assert.deepEqual(at.get(lineOf('# Margin demo')), { line: lineOf('# Margin demo'), kind: 'talk' })
assert.equal(at.get(lineOf('## Part one')).kind, 'section')
assert.equal(at.get(lineOf('## Part two')).kind, 'section')
assert.equal(at.get(lineOf('## Part one')).number, undefined, 'a section carries no number')

// The number is the one the gutter shows.
const numbers = slideNumbersByLine(computeSlideLines(rows, outline))
for (const l of labels.filter((x) => x.kind === 'slide')) assert.equal(l.number, numbers.get(l.line), `slide at line ${l.line} numbered as the gutter numbers it`)
const second = at.get(lineOf('### Second slide'))
assert.equal(second.kind, 'slide')
// The slide writes {iconlist} over a fenced code block and no list: the compiler draws it as Code,
// and the margin names the layout the slide is drawn in (it said Icon list before, which it is not).
assert.equal(model.slides.find((slide) => slide.sourceLine === lineOf('### Second slide')).layout, 'code', 'the real compiled layout')
assert.equal(second.layoutLabel, 'Code', 'a written {iconlist} over code and no list is named by the layout it is drawn in')
assert.equal(at.get(lineOf('### First slide')).layoutLabel, 'Auto', 'an {id=…} line alone is no layout: Auto')
// A ### with #### children compiles to a subsection divider: the compiler's role decides, not the depth.
assert.equal(at.get(lineOf('### Third slide')).kind, 'section', 'a slide that has child slides is a section divider (subsection-title)')
assert.equal(at.get(lineOf('#### Folded child')).kind, 'slide')
assert.equal(at.get(lineOf('#### Folded child')).layoutLabel, 'Auto')
assert.equal(at.get(lineOf('### Fourth slide')).layoutLabel, 'Image grid')

// Not compiled yet, or the compile failed: depth decides.
for (const none of [null, undefined, []]) {
  const l = byLine(marginLabels(none, outline))
  assert.equal(l.get(lineOf('# Margin demo')).kind, 'talk')
  assert.equal(l.get(lineOf('## Part two')).kind, 'section')
  assert.equal(l.get(lineOf('### First slide')).kind, 'slide')
  assert.equal(l.get(lineOf('### First slide')).layoutLabel, 'Auto')
  assert.equal(l.get(lineOf('### Second slide')).layoutLabel, 'Code', 'the same layout name without rows')
  assert.equal(l.get(lineOf('### First slide')).number, 1, 'number from the order of slide headings')
  assert.equal(l.get(lineOf('### Second slide')).number, 2)
}

// A heading with no row (typed since the last compile): by depth, no number.
// A layout written on the heading line itself counts, without rows or with them.
assert.equal(marginLabels(null, '## S\n\n### Card slide {cards}\n').find((l) => l.kind === 'slide').layoutLabel, 'Cards')

const withNew = marginLabels(rows, outline.replace('### Fourth slide', '### Fourth slide\n\n### Brand new'))
const brandNew = withNew.find((l) => lines.length && l.kind === 'slide' && l.number === undefined)
assert.ok(brandNew, 'a heading with no compiled row is a Slide without a number')
console.log('plain view margin labels: ok')
