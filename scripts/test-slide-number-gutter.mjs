// The editor gutter numbers each slide heading with the strip's number (compiled index + 1) and
// numbers nothing else. Rows come from the real compiler, the way talk:compile builds them.
import { strict as assert } from 'node:assert'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { computeSlideLines, slideNumbersByLine } from '../src/shared/slide-lines.ts'

const outline = `---
title: Gutter demo
---

# Gutter demo

## Part one

### First slide
{statement}

Body

### Second slide

\`\`\`bash
# not a heading
### also not a heading
\`\`\`

Notes: spoken words only
Not a heading either

### Third slide
{carousel}

#### Folded child
Child body

## Part two

### Fourth slide
`

const model = await prepareSource('/tmp/slide-number-gutter.md', outline, 'gutter')
const rows = buildPerSlideProjections(model, 'gutter')
const lines = outline.split('\n')
const content = computeSlideLines(rows, outline)
const numbers = slideNumbersByLine(content)

// The strip prints String(index + 1): every compiled row keeps its own number.
rows.forEach((row, index) => {
  const line = content[index]
  if (typeof line === 'number') assert.equal(numbers.get(line), index + 1, `row ${index} (${row.nav_title}) numbered as the strip numbers it`)
})

const titleAt = (n) => lines[[...numbers].find(([, num]) => num === n)[0] - 1]
for (const [line, n] of numbers) {
  assert.match(lines[line - 1], /^#{1,6}\s|^---$/, `only heading lines are numbered (line ${line})`)
  assert.ok(n >= 1 && n <= rows.length, 'number is a strip number')
}
const heading = (text) => lines.findIndex((l) => l.startsWith(text)) + 1
const fence = lines.findIndex((l) => l === '# not a heading') + 1
assert.ok(!numbers.has(fence) && !numbers.has(fence + 1), 'headings inside a code fence are not numbered')
assert.ok(!numbers.has(heading('#### Folded child')), 'a folded child heading is not numbered')
assert.ok(!numbers.has(heading('Notes:')) && !numbers.has(heading('Body')), 'notes and body lines are not numbered')
assert.ok(numbers.has(heading('## Part one')) && numbers.has(heading('## Part two')), 'section dividers are numbered')
// Number gaps follow the strip: Fourth slide's number is its compiled position, not a heading count.
const fourth = numbers.get(heading('### Fourth slide'))
const third = numbers.get(heading('### Third slide'))
assert.ok(fourth > third + 1, 'the section divider between Third and Fourth takes a number')
assert.equal(titleAt(fourth), '### Fourth slide')

// A naive "number every heading" gutter would number the fence lines and the folded child.
const naive = lines.filter((l) => /^#{1,6}\s/.test(l)).length
assert.ok(numbers.size < naive, `naive heading count (${naive}) differs from the strip's numbering (${numbers.size})`)

// Before the first compile, the fallback strip is one card per ### heading, in order.
// (The strip's fallback parse is not fence-aware, so this check uses an outline without a fence.)
const plain = '## A\n\n### One\n\n### Two\n\n## B\n\n### Three\n'
assert.deepEqual([...slideNumbersByLine(computeSlideLines(null, plain)).values()], [1, 2, 3], 'fallback strip numbers ### headings 1..n')

console.log(`slide-number-gutter: ok (${numbers.size} numbered of ${naive} headings)`)
