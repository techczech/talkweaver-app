// test:plain-view-outline-lines-parity — plain view ticket 07, ninth review.
//
// The Plain editor has one answer to "which lines does the compiler read as outline, and which lie
// in front matter, fenced code, a comment or notes" (src/shared/plain-view-outline-lines.ts). This
// file holds that answer to the compiler, line by line, on every document of
// scripts/fixtures/plain-view-outline-regions.json:
//
//   1. the kind of every line is the one written in the fixture (by hand);
//   2. content against skipped is what the compiler's outline tree says for that line
//      (scripts/lib/plain-view-compiler-lines.mjs: adaptMarkdownOutlineV2's preparation of the
//      text, parseOutlineTree, the fence functions), and the heading lines are the tree's nodes;
//   3. the compiled talk (adaptMarkdownOutlineV2) puts every marker word where its line's kind
//      says: a title or slide content for an outline line, a code block for fenced code, the
//      speaker notes for notes, nowhere for front matter and comments;
//   4. the margin's labels (src/shared/plain-view-margin.ts) are on outline lines only, one for
//      every heading the compiler reads.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { compilerLines } from './lib/plain-view-compiler-lines.mjs'
import { blankHtmlComments } from '../compiler/scripts/lib/html-comments.mjs'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { isHeadingTailLine, isStructureLine, outlineHeading, readOutlineLines } from '../src/shared/plain-view-outline-lines.ts'
import { compilerFacts } from '../src/shared/plain-view-compiler-facts.ts'
import { headingBraceGroups } from '../src/shared/plain-view-icon-tokens.ts'
import { marginLabels } from '../src/shared/plain-view-margin.ts'

const { documents } = JSON.parse(readFileSync(new URL('./fixtures/plain-view-outline-regions.json', import.meta.url), 'utf8'))
const LETTER = { outline: 'o', frontmatter: 'm', comment: 'c', fence: 'f', notes: 'n' }
// Where a marker word may turn up in the compiled talk, by the first letters of the word.
const PLACE = { QH: ['title'], QT: ['title'], QP: ['content'], QC: ['code'], QN: ['notes'], QX: ['nowhere'], QM: ['nowhere'] }
// The marker words a line of each kind may carry (a fence inside notes is compiled into the notes).
const WORDS_ON = { o: ['QH', 'QT', 'QP'], m: ['QM'], c: ['QX'], f: ['QC', 'QN'], n: ['QN'] }

function placeOf(word, compiled) {
  const slides = compiled.slides.filter((slide) => typeof slide.sourceLine === 'number')
  if (String(compiled.title).includes(word) || slides.some((slide) => String(slide.title).includes(word))) return 'title'
  if (slides.some((slide) => JSON.stringify(slide.notes ?? '').includes(word))) return 'notes'
  const blocks = slides.flatMap((slide) => slide.blocks || [])
  if (blocks.some((block) => block.type === 'code' && JSON.stringify(block).includes(word))) return 'code'
  if (blocks.some((block) => block.type !== 'code' && JSON.stringify(block).includes(word))) return 'content'
  return 'nowhere'
}

assert.ok(documents.length >= 30, `${documents.length} documents`)
let checks = 0
const seen = new Set()
for (const { name, lines, kinds } of documents) {
  const text = lines.join('\n')
  const read = readOutlineLines(text)
  const where = (i) => `${name}: line ${i + 1} ${JSON.stringify(lines[i])}`

  // 1. The kinds written by hand.
  // (`u` in a fixture: a line the lexer and the tree read differently; the helper gives the tree's kind, whichever it is.)
  assert.equal(read.kinds.map((kind, i) => (kinds[i] === 'u' ? 'u' : LETTER[kind])).join(''), kinds, `kinds: ${name}`)
  for (const letter of kinds) seen.add(letter)

  // 2. The compiler's outline tree.
  const compiler = compilerLines(text)
  lines.forEach((line, i) => {
    assert.equal(read.kinds[i] !== 'outline', compiler.skipped[i], `content against skipped: ${where(i)}`)
    checks += 1
  })
  assert.deepEqual(
    lines.map((line, i) => i).filter((i) => read.compilerHeading[i] && /^##/.test(lines[i]) && read.kinds[i] === 'outline'),
    compiler.headings, `heading lines: ${name}`)
  // The plain view's heading on a line read whole is a heading of the compiler, but for marks
  // with nothing after them (`## `: a title being typed, shared/plain-view-heading-line.ts).
  lines.forEach((line, i) => {
    const heading = outlineHeading(read, i, line)
    if (heading && !heading.empty) assert.ok(read.compilerHeading[i], `a heading for Plain is one for the compiler: ${where(i)}`)
    if (read.compilerHeading[i] && read.kinds[i] === 'outline') assert.ok(heading, `a heading for the compiler is one for Plain: ${where(i)}`)
  })

  // 3. The compiled talk.
  const compiled = adaptMarkdownOutlineV2(text, 'Fallback', {})
  for (const slide of compiled.slides) {
    if (typeof slide.sourceLine !== 'number') continue
    assert.ok(read.kinds[slide.sourceLine - 1] === 'outline' && read.compilerHeading[slide.sourceLine - 1], `a compiled slide starts on a heading line: ${where(slide.sourceLine - 1)}`)
  }
  lines.forEach((line, i) => {
    for (const word of line.match(/\bQ[A-Z]{2}\b/g) || []) {
      const prefix = word.slice(0, 2)
      assert.ok(PLACE[prefix], `${word} is a marker word`)
      assert.ok(PLACE[prefix].includes(placeOf(word, compiled)), `the compiler puts ${word} in ${PLACE[prefix]} (found: ${placeOf(word, compiled)}): ${where(i)}`)
      if (!read.partial[i] && kinds[i] !== 'u') assert.ok(WORDS_ON[kinds[i]].includes(prefix), `${word} is on a line of kind ${kinds[i]}: ${where(i)}`)
      checks += 1
    }
  })

  // 4. The margin's own line scan.
  const labelled = marginLabels(null, text).map((label) => label.line - 1)
  for (const i of labelled) assert.equal(read.kinds[i], 'outline', `a margin label is on an outline line: ${where(i)}`)
  for (const i of compiler.headings) assert.ok(labelled.includes(i), `the compiler's heading has a margin label: ${where(i)}`)
  checks += labelled.length

  // A line with a comment on part of it is never one Plain hides or protects text on, but for a
  // title whose trailing groups the compiler reads as written (section 6).
  lines.forEach((line, i) => { if (read.partial[i]) assert.equal(isStructureLine(read, i), false, where(i)) })
}
assert.deepEqual([...seen].sort(), ['c', 'f', 'm', 'n', 'o', 'u'], 'every kind of line is in the fixture')

// 5. A fence written straight under another line: the compiled talk has the code block, and the
// text after it as text, exactly when the helper calls the fence settled. (The lexer takes a
// fence mark under a paragraph line as paragraph text; the outline tree reads a fence.)
const ABOVE = [
  'Para text', '**Bold claim**', 'https://example.org', ':::', '---', '    indented', '$$', '<div>', '+ plus item', 'Term:', 'Text {braces}',
  '- item', '1. item', '2) item', '* star item', '  - nested', '> quote', '| a | b |', '![alt](x.png)', '{reveal}', '{reveal} {cards}',
  '[Embed: https://example.org]', '<!-- c -->', '#hashtag', '####### seven', '# Title', '## ', '## Heading', ''
]
let apart = 0
for (const indent of ['', '  ']) {
  for (const above of ABOVE) {
    const lines = ['## S', '', above, `${indent}\`\`\``, 'CODEWORD', `${indent}\`\`\``, '', 'After AFTERWORD']
    const blocks = adaptMarkdownOutlineV2(lines.join('\n'), 'Fallback', {}).slides.filter((slide) => typeof slide.sourceLine === 'number').flatMap((slide) => slide.blocks || [])
    const asWritten = blocks.some((block) => block.type === 'code' && block.text === 'CODEWORD')
      && blocks.some((block) => block.type !== 'code' && JSON.stringify(block).includes('AFTERWORD'))
    const read = readOutlineLines(lines.join('\n'))
    // What Plain draws on a slide's content is the lexer's own answer (plain-view-compiler-facts.ts): code exactly when the slide has the code block.
    assert.equal(compilerFacts(lines.join('\n')).codeLines.has(4), blocks.some((block) => block.type === 'code' && block.text === 'CODEWORD'), `a fence straight under ${JSON.stringify(above)} is code for the lexer`)
    assert.deepEqual(read.kinds.slice(3, 6), ['fence', 'fence', 'fence'], `the tree's reading stays a fence under ${JSON.stringify(above)}`)
    if (!asWritten) apart += 1
    checks += 1
  }
}
assert.ok(apart >= 10, `${apart} of the lines above take the fence into a paragraph`)

// CRLF text reads as LF text does (the compiler splits on \r?\n).
for (const { name, lines } of documents) {
  assert.deepEqual(readOutlineLines(lines.join('\r\n')).kinds, readOutlineLines(lines.join('\n')).kinds, `CRLF: ${name}`)
}

// 6. A title with a comment in it: its trailing groups are Plain's to hide exactly when the
// compiler takes the same groups off the same title (parseHeadingAttrs on the line it reads).
const COMMENTED_TITLES = [
  ['### Alpha b<!--  -->eta {reveal}', true], ['### Alpha <!-- note --> {reveal} {icon=lucide:star}', true], ['# Talk <!-- n --> {icon=lucide:star}', true],
  ['### <!-- a -->Alpha {reveal}', true], ['### Alpha {reveal} <!-- note -->', false], ['### Alpha {reveal<!-- x -->}', false],
  ['### Alpha <!-- { --> x {reveal}', false], ['### Alpha {x <!-- } --> {reveal}', false], ['### Alpha {reveal} <!-- a --> {cards}', false],
  ['### Alpha <!-- note -->', false], ['<!-- a -->### Alpha {reveal}', false]
]
for (const [line, want] of COMMENTED_TITLES) {
  const read = readOutlineLines(`${line}\nBody`)
  assert.equal(read.partial[0], true, `${JSON.stringify(line)} has a comment in it`)
  assert.equal(read.tailAsWritten[0], want, `the tail is read as written: ${JSON.stringify(line)}`)
  assert.equal(isHeadingTailLine(read, 0), want, `Plain may hide the tail: ${JSON.stringify(line)}`)
  if (want) {
    const marks = line.match(/^#{1,6}\s+/)[0].length
    const written = headingBraceGroups(line).filter((g) => g.start >= marks)
    let rest = line
    for (const g of [...written].reverse()) rest = rest.slice(0, g.start) + rest.slice(g.end)
    assert.equal(blankHtmlComments(rest).slice(marks).trim(), parseHeadingAttrs(blankHtmlComments(line).slice(marks)).title, `the groups are what the compiler takes off the title: ${JSON.stringify(line)}`)
  }
  checks += 1
}

console.log(`test:plain-view-outline-lines-parity — ${checks} checks over ${documents.length} documents`)
