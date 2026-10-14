// test:plain-view-margin-sections-numbers — the Plain margin's sections and numbers, from the real compiler's rows.
//   - a heading with slides under it is a Section at any depth (`##` over `###`, `###` over `####`),
//     by the compiler's own reading (plain-view-compiler-facts.ts keptChildren), numbered 1, 2, 2.1, 2.1.1;
//   - a section says its level (L1 = `##`) and the slides the compiler emits inside it, nested ones included;
//   - slide numbers are the strip's (compiled index + 1) on every slide of the talk;
//   - a heading that takes its children into one slide (a carousel) is a Section with its layout and its
//     items; each item is Slide n.k, n being the number of the one slide that holds them;
//   - nothing compiled, the opening divider the compiler drops, and a layout line not first all label without throwing.
import { strict as assert } from 'node:assert'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { computeSlideLines, slideNumbersByLine } from '../src/shared/slide-lines.ts'
import { marginDetail, marginLabels, marginWord } from '../src/shared/plain-view-margin.ts'

const compile = async (outline) => buildPerSlideProjections(await prepareSource('/tmp/margin-sections.md', outline, 'margin'), 'margin')
const lineOf = (outline, text) => outline.split('\n').findIndex((l) => l === text || l.startsWith(text)) + 1
const labelsOf = async (outline) => {
  const rows = await compile(outline)
  const labels = marginLabels(rows, outline)
  return { rows, labels, at: (text) => labels.find((l) => l.line === lineOf(outline, text)), words: (text) => marginWord(labels.find((l) => l.line === lineOf(outline, text))) }
}

// 1. Three sections, one with nested sections; slide numbers equal the compiler's row numbers.
const talk = `# Talk

## Alpha

### A1
Body

### A2
Body

## Beta

### B Group

#### B1
One

#### B2
Two

### B Group Two

#### B3
Three

### B Solo
Body

## Gamma

### G1
Body
`
{
  const { rows, labels, at, words } = await labelsOf(talk)
  assert.equal(words('## Alpha'), 'Section 1')
  assert.equal(words('## Beta'), 'Section 2')
  assert.equal(words('## Gamma'), 'Section 3')
  assert.equal(words('### B Group'), 'Section 2.1', 'a ### with #### under it is a nested section')
  assert.equal(words('### B Group Two'), 'Section 2.2')
  assert.equal(at('### B Group').level, 2)
  assert.equal(at('## Alpha').level, 1)
  assert.equal(marginDetail(at('## Alpha')), 'L1 · 2 slides')
  assert.equal(marginDetail(at('## Gamma')), 'L1 · 1 slide', 'singular')
  assert.equal(marginDetail(at('## Beta')), 'L1 · 4 slides', 'B1, B2, B3 and B Solo: nested sections count, their dividers do not')
  assert.equal(marginDetail(at('### B Group')), 'L2 · 2 slides')
  assert.equal(at('## Alpha').number, undefined, 'a section carries no slide number')
  // Every slide carries the number the strip prints for its row.
  const numbers = slideNumbersByLine(computeSlideLines(rows, talk))
  const slides = labels.filter((l) => l.kind === 'slide')
  assert.equal(slides.length, 7, 'A1 A2 B1 B2 B3 B Solo G1')
  for (const l of slides) {
    assert.ok(numbers.get(l.line) > 0, `row for line ${l.line}`)
    assert.equal(l.number, numbers.get(l.line), `slide at line ${l.line} has the compiler's row number`)
    assert.equal(l.item, undefined)
  }
  assert.equal(at('#### B1').layoutLabel, 'Auto')
  assert.equal(words('#### B1'), `Slide ${numbers.get(lineOf(talk, '#### B1'))}`)
  // Slide numbers rise through the talk.
  const sequence = slides.map((l) => l.number)
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b))
  assert.deepEqual(at('# Talk'), { line: 1, kind: 'talk' })
}

// 2. A carousel heading: a Section with its layout, its items Slide n.k.
const carousel = `# Talk

## Part

### Intro
Body

### Steps {carousel}

#### First
One

#### Second
Two

#### Third
Three

### After
Body
`
{
  const { rows, at, words } = await labelsOf(carousel)
  const numbers = slideNumbersByLine(computeSlideLines(rows, carousel))
  const n = numbers.get(lineOf(carousel, '### Steps'))
  assert.ok(n > 0, 'the compiler emits ONE slide for the carousel heading')
  assert.equal(rows.filter((r) => r.source_line === lineOf(carousel, '#### First')).length, 0, 'the items have no slide of their own')
  assert.equal(words('### Steps {carousel}'), 'Section 1.1', 'the carousel heading is a section in the section sequence')
  assert.equal(at('### Steps').layoutLabel, 'Carousel')
  assert.equal(marginDetail(at('### Steps')), 'L2 · 3 slides', 'k counts its items')
  assert.equal(words('#### First'), `Slide ${n}.1`)
  assert.equal(words('#### Second'), `Slide ${n}.2`)
  assert.equal(words('#### Third'), `Slide ${n}.3`)
  assert.equal(words('### After'), `Slide ${numbers.get(lineOf(carousel, '### After'))}`)
  assert.equal(at('## Part').slideCount, 2 + 1, 'Intro, the carousel slide, After')
}

// 3. An old-style slide: a layout line that is not first under the heading.
const oldStyle = `# Talk

## Part

### Old style
Some text

{iconlist}

- One
- Two
`
{
  const { rows, at, words } = await labelsOf(oldStyle)
  const index = rows.findIndex((r) => r.source_line === lineOf(oldStyle, '### Old style'))
  assert.ok(index >= 0)
  assert.equal(words('### Old style'), `Slide ${index + 1}`, 'the row number: cover, divider, then this slide')
  assert.equal(at('### Old style').layoutLabel, 'Icon list')
  assert.equal(words('## Part'), 'Section 1')
}

// 4. A talk with no sections: slides only, numbered, nothing claimed as a section.
const flat = `# Flat

### One
Body

### Two
Body
`
{
  const { labels } = await labelsOf(flat)
  assert.ok(labels.every((l) => l.kind !== 'section'))
  assert.equal(labels.filter((l) => l.kind === 'slide').length, 2)
}

// 5. The only slide of a section is the opening: the compiler drops that section's divider.
const opening = `# Talk

## Start

### Welcome {role=opening}

## Later

### Next
Body
`
{
  const { rows, labels, at } = await labelsOf(opening)
  assert.equal(rows.filter((r) => r.role === 'section-title' && r.source_line === lineOf(opening, '## Start')).length, 0, 'the compiler emits no divider for Start')
  assert.equal(at('## Start').kind, 'section')
  assert.equal(at('## Start').slideCount, 1, 'only the opening slide is counted, not the divider the compiler dropped')
  assert.equal(at('## Later').sectionNumber, '2')
  assert.equal(at('### Welcome').kind, 'slide')
  assert.equal(at('### Welcome').number, 1)
  assert.equal(labels.length, 5)
}

// 6. Nothing compiled: sections still numbered, slides carry the order, no count is invented, nothing throws.
{
  const labels = marginLabels(null, talk)
  const at = (text) => labels.find((l) => l.line === lineOf(talk, text))
  assert.equal(marginWord(at('## Beta')), 'Section 2')
  assert.equal(marginWord(at('### B Group')), 'Section 2.1')
  assert.equal(at('## Alpha').slideCount, 2)
  assert.equal(at('## Beta').slideCount, 4)
  assert.equal(marginWord(at('### A1')), 'Slide 1')
  assert.doesNotThrow(() => marginLabels([], ''))
  assert.doesNotThrow(() => marginLabels(null, '## only\n'))
}

// 7. A heading with a body and slides under it: the compiler draws it as a slide of its own, so the section keeps its layout line.
{
  const text = '# Talk\n\n## Part\n\n### Parent {statement}\nA body line.\n\n#### Child\nBody\n'
  const { at, words } = await labelsOf(text)
  assert.equal(words('### Parent'), 'Section 1.1', 'a heading with slides under it is a section')
  assert.equal(at('### Parent').layoutLabel, 'Statement')
  assert.equal(at('### Parent').slideCount, 2, 'its own slide and the child')
}

console.log('plain-view-margin-sections-numbers: ok')
