// The Slides organizer's two drop targets that are not "before a row": the end of the talk and the
// inside of a section (as its last slide). Table tests of the real functions in
// src/renderer/src/extensions/slideOutline.ts. These moves edit the user's talk text, so every case
// also asserts the property that matters: the multiset of lines is unchanged — nothing lost,
// nothing duplicated, only block order differs.
import { strict as assert } from 'node:assert'
import { landsBeforeTitle, talkTitleIndex } from '../src/shared/talk-title.ts'
import { relocateBlock, relocateBlockAfter, relocateBlockInto, relocateBlockToEnd, slideRows, talkTitleLine } from '../src/renderer/src/extensions/slideOutline.ts'

const sortedLines = (t) => t.split('\n').sort()
const lineOf = (text, heading) => {
  const i = text.split('\n').indexOf(heading)
  assert(i >= 0, `fixture has the line ${JSON.stringify(heading)}`)
  return i + 1
}
let cases = 0
function check(name, input, output, expected) {
  cases += 1
  assert.deepEqual(sortedLines(output), sortedLines(input), `${name}: same multiset of lines`)
  assert.equal(output, expected, name)
}
const toEnd = (name, input, heading, expected) => check(`to end — ${name}`, input, relocateBlockToEnd(input, lineOf(input, heading)), expected)
const into = (name, input, heading, section, expected) =>
  check(`into — ${name}`, input, relocateBlockInto(input, lineOf(input, heading), lineOf(input, section)), expected)
const J = (...lines) => lines.join('\n')

// A realistic slide: layout line, {id=…} line, body, speaker notes, one blank line after.
const RICH = ['### Rich {reveal}', '{columns}', '{id=s-rich}', '', '- point one', '- point two', '', 'Note: say this slowly.', '']
const A = ['### A', 'body A', '']
const B = ['### B', 'body B', '']
const C = ['### C', 'body C', '']

// ── relocateBlockToEnd ──
toEnd('first slide, file ends with a newline',
  J(...A, ...B, ...C), '### A',
  J(...B, ...C, ...A))
toEnd('first slide, file has NO trailing newline: the separator stays between slides, the file still ends without one',
  J(...A, ...B, '### C', 'body C'), '### A',
  J(...B, '### C', 'body C', '', '### A', 'body A'))
toEnd('middle slide', J(...A, ...B, ...C), '### B', J(...A, ...C, ...B))
toEnd('last slide: already at the end', J(...A, ...B, ...C), '### C', J(...A, ...B, ...C))
toEnd('last slide, no trailing newline: no-op', J(...A, '### B', 'body B'), '### B', J(...A, '### B', 'body B'))
toEnd('slide with layout line, id line and notes travels whole',
  J('# Talk', '', '## One', '', ...RICH, ...B, '## Two', '', ...C), '### Rich {reveal}',
  J('# Talk', '', '## One', '', ...B, '## Two', '', ...C, ...RICH))
toEnd('out of its section and into the last one (the slide becomes the last slide of the last section)',
  J('## One', '', ...A, ...B, '## Two', '', ...C), '### A',
  J('## One', '', ...B, '## Two', '', ...C, ...A))
toEnd('a whole section with its slides',
  J('## One', '', ...A, '## Two', '', ...B, '## Three', '', ...C), '## One',
  J('## Two', '', ...B, '## Three', '', ...C, '## One', '', ...A))
toEnd('a deeper block with its subtree',
  J('### s', '#### a', '##### a1', '#### b', '### t'), '#### a',
  J('### s', '#### b', '### t', '#### a', '##### a1'))
toEnd('tight formatting (no blank lines anywhere)', J('### A', 'a', '### B', 'b'), '### A', J('### B', 'b', '### A', 'a'))
toEnd('several blank lines end the file: they stay at the end',
  J(...A, '### B', 'body B', '', '', ''), '### A',
  J('### B', 'body B', '', '### A', 'body A', '', '', ''))
toEnd('the deck title owns the whole file: no-op', J('# Talk', '', ...A, ...B), '# Talk', J('# Talk', '', ...A, ...B))
toEnd('CRLF line endings are carried as they are',
  ['### A', 'body A', '', '### B', 'body B', ''].join('\r\n'), '### A\r',
  ['### B', 'body B', '', '### A', 'body A', ''].join('\r\n'))
{
  const t = J(...A, ...B)
  assert.equal(relocateBlockToEnd(t, 2), t, 'to end: a non-heading line is a no-op')
  assert.equal(relocateBlockToEnd(t, 0), t, 'to end: line 0 is a no-op')
  assert.equal(relocateBlockToEnd(t, 99), t, 'to end: out of range is a no-op')
  assert.equal(relocateBlockToEnd('', 1), '', 'to end: empty text')
  cases += 4
}

// ── relocateBlockInto ──
const TALK = J('# Talk', '', '## One', '', ...A, ...B, '## Two', '', ...C, '## Three', '', '### D', 'body D', '')
into('a later section, as its last slide',
  TALK, '### A', '## Two',
  J('# Talk', '', '## One', '', ...B, '## Two', '', ...C, ...A, '## Three', '', '### D', 'body D', ''))
into('an earlier section, as its last slide',
  TALK, '### D', '## One',
  J('# Talk', '', '## One', '', ...A, ...B, '### D', 'body D', '', '## Two', '', ...C, '## Three', ''))
into('the last section of the file',
  TALK, '### A', '## Three',
  J('# Talk', '', '## One', '', ...B, '## Two', '', ...C, '## Three', '', '### D', 'body D', '', ...A))
into('the last section, file with NO trailing newline',
  J('## One', '', ...A, '## Two', '', '### C', 'body C'), '### A', '## Two',
  J('## One', '', '## Two', '', '### C', 'body C', '', '### A', 'body A'))
into('the last slide of a file with NO trailing newline moves up: it takes a separator, the file still ends without a newline',
  J('## One', '', ...A, '## Two', '', ...B, '### C', 'body C'), '### C', '## One',
  J('## One', '', ...A, '### C', 'body C', '', '## Two', '', '### B', 'body B'))
into('the section it is already in: it becomes that section\'s last slide',
  TALK, '### A', '## One',
  J('# Talk', '', '## One', '', ...B, ...A, '## Two', '', ...C, '## Three', '', '### D', 'body D', ''))
into('the section it is already last in: no-op', TALK, '### B', '## One', TALK)
into('an empty section',
  J('## One', '', ...A, '## Empty', '', '## Two', '', ...B), '### A', '## Empty',
  J('## One', '', '## Empty', '', ...A, '## Two', '', ...B))
into('an empty section that ends the file, no trailing newline',
  J('## One', '', ...A, '## Empty'), '### A', '## Empty',
  J('## One', '', '## Empty', '', '### A', 'body A'))
into('slide with layout line, id line and notes travels whole',
  J('## One', '', ...RICH, ...B, '## Two', '', ...C), '### Rich {reveal}', '## Two',
  J('## One', '', ...B, '## Two', '', ...C, ...RICH))
into('across heading levels: a #### block (with its subtree) into a ## section lands at the section\'s end',
  J('## One', '### s', '#### a', '##### a1', '#### b', '## Two', '### t', '## Three'), '#### a', '## Two',
  J('## One', '### s', '#### b', '## Two', '### t', '#### a', '##### a1', '## Three'))
into('across heading levels: a ### slide into a # deck lands at the very end',
  J('# Talk', '', '## One', '', ...A, ...B), '### A', '# Talk',
  J('# Talk', '', '## One', '', ...B, ...A))
into('a subsection with its slides into another section',
  J('## One', '### sub', '#### x', '#### y', '### other', '## Two', '### t'), '### sub', '## Two',
  J('## One', '### other', '## Two', '### t', '### sub', '#### x', '#### y'))
into('a nested section: the slide lands after every nested subsection of the target',
  J('## One', '### a', '## Two', '### sub', '#### deep', '## Three'), '### a', '## Two',
  J('## One', '## Two', '### sub', '#### deep', '### a', '## Three'))
// No-ops.
{
  const noop = (name, heading, section) => into(`${name}: no-op`, TALK, heading, section, TALK)
  noop('a section onto itself', '## One', '## One')
  noop('a section into a slide of its own subtree', '## One', '### A')
  noop('a section into a same-level section (it could not be a child)', '## One', '## Two')
  noop('a slide into a same-level slide', '### A', '### C')
  noop('a section into a deeper heading elsewhere', '## One', '### C')
  assert.equal(relocateBlockInto(TALK, 2, lineOf(TALK, '## Two')), TALK, 'into: a non-heading source is a no-op')
  assert.equal(relocateBlockInto(TALK, lineOf(TALK, '### A'), 2), TALK, 'into: a non-heading target is a no-op')
  assert.equal(relocateBlockInto(TALK, 0, 3), TALK, 'into: line 0 is a no-op')
  assert.equal(relocateBlockInto(TALK, 5, 999), TALK, 'into: out of range is a no-op')
  cases += 4
}
into('CRLF line endings are carried as they are',
  ['## One', '### A', 'a', '## Two', '### B', 'b', ''].join('\r\n'), '### A\r', '## Two\r',
  ['## One', '## Two', '### B', 'b', '### A', 'a', ''].join('\r\n'))

// ── Round trips and a sweep: every slide of a generated talk, every target ──
// 100 slides in 10 sections, with and without a trailing newline. For every (slide, target) pair
// the line multiset holds, each heading still appears exactly once, and the moved block is where
// it was sent.
for (const trailing of ['\n', '']) {
  const parts = ['# Talk', '']
  for (let s = 0; s < 10; s += 1) {
    parts.push(`## Section ${s}`, '')
    for (let i = 0; i < 10; i += 1) parts.push(`### Slide ${s}.${i}`, `{id=s${s}-${i}}`, '', `- point ${s}.${i}`, '', `Note: note ${s}.${i}`, '')
  }
  const text = parts.join('\n').replace(/\n$/, '') + trailing
  const lines = text.split('\n')
  const slides = lines.map((l, i) => (l.startsWith('### ') ? i + 1 : 0)).filter(Boolean)
  const sections = lines.map((l, i) => (l.startsWith('## ') ? i + 1 : 0)).filter(Boolean)
  const body = (t) => t.split('\n').filter((l) => l.trim() !== '')
  for (const from of slides) {
    const heading = lines[from - 1]
    const id = lines[from]
    const end = relocateBlockToEnd(text, from)
    assert.deepEqual(sortedLines(end), sortedLines(text), `sweep: to end from line ${from}`)
    assert.equal(end.endsWith('\n'), text.endsWith('\n'), 'sweep: the file ending is kept')
    assert.deepEqual(body(end).slice(-4), [heading, id, body(text)[body(text).indexOf(id) + 1], body(text)[body(text).indexOf(id) + 2]], 'sweep: the moved slide is last, whole')
    assert(!/[^\n]\n#/.test(end.replace(/^# Talk/, '')), 'sweep: every heading still has a blank line before it')
    for (const section of sections) {
      const out = relocateBlockInto(text, from, section)
      assert.deepEqual(sortedLines(out), sortedLines(text), `sweep: into ${section} from ${from}`)
      assert.equal(out.endsWith('\n'), text.endsWith('\n'), 'sweep: the file ending is kept')
      assert(!/[^\n]\n#/.test(out.replace(/^# Talk/, '')), 'sweep: every heading still has a blank line before it')
      const o = out.split('\n')
      const at = o.indexOf(heading)
      assert.equal(o[at + 1], id, 'sweep: the id line is still under its heading')
      // The moved slide is the last ### of the target section.
      const sec = o.indexOf(lines[section - 1])
      let next = o.findIndex((l, i) => i > sec && l.startsWith('## '))
      if (next < 0) next = o.length
      const last = o.slice(sec, next).filter((l) => l.startsWith('### ')).pop()
      assert.equal(last, heading, `sweep: ${heading} is the last slide of ${lines[section - 1]}`)
      cases += 1
    }
    cases += 1
  }
}

// ── Nothing goes before the talk's title (0.38.3-preview.12: a slide dropped on the line before the
// title row left `---`, `### Slide`, `# Title`). Every relocate function refuses such a place. ──
{
  const FM = ['---', 'title: "Moving slides check"', '# a comment in the frontmatter', '---', '']
  const TITLE = ['# Moving slides check', '{id=deck}', 'The title\'s own text.', '']
  const T = J(...FM, ...TITLE, '## One', '', ...A, ...B, '## Two', '', ...C)
  const title = lineOf(T, '# Moving slides check')
  const refused = (name, out) => { cases += 1; assert.equal(out, T, `${name}: refused, the text is unchanged`) }
  assert.equal(talkTitleLine(T), title, 'the title is the first # heading after the frontmatter, not the # comment in it')
  assert.equal(talkTitleLine(J(...A, ...B)), null, 'a talk with no # heading has no title')
  assert.equal(talkTitleLine(J(...A, '```sh', '# install', 'npm i foo', '```', '', ...B)), null, 'a # line inside a code fence is not the title')
  assert.equal(talkTitleIndex(J('~~~', '# x', '~~~', '# Real').split('\n')), 3, 'the title after a closed fence')
  cases += 4
  // The reported drop: a slide (and a section) before the title row.
  refused('a slide before the title row', relocateBlock(T, lineOf(T, '### B'), title))
  refused('a section before the title row', relocateBlock(T, lineOf(T, '## Two'), title))
  refused('the first section before the title row', relocateBlock(T, lineOf(T, '## One'), title))
  // The legal neighbour: before the first row under the title. The title's own lines stay on top.
  const first = relocateBlock(T, lineOf(T, '### C'), lineOf(T, '## One'))
  check('a slide before the first row under the title', T, first, J(...FM, ...TITLE, ...C.slice(0, 2), '', '## One', '', ...A, ...B, '## Two', ''))
  assert.deepEqual(first.split('\n').slice(0, FM.length + TITLE.length), [...FM, ...TITLE], 'the frontmatter and the title\'s own lines are still the top of the file')
  // A file an earlier build damaged: a slide already above the title. Nothing more goes up there,
  // by any of the four functions, and the stranded slide can still be moved back under the title.
  const BAD = J(...FM, '### Stray', '{id=stray}', 'stray body', '', ...TITLE, '## One', '', ...A, ...B)
  const stay = (name, out) => { cases += 1; assert.equal(out, BAD, `${name}: refused`) }
  stay('before a slide that is above the title', relocateBlock(BAD, lineOf(BAD, '### B'), lineOf(BAD, '### Stray')))
  stay('after a slide that is above the title', relocateBlockAfter(BAD, lineOf(BAD, '### B'), lineOf(BAD, '### Stray')))
  assert.equal(landsBeforeTitle(BAD.split('\n'), 20, 23, 5), true, 'a place above the title')
  assert.equal(landsBeforeTitle(BAD.split('\n'), 20, 23, lineOf(BAD, '## One') - 1), false, 'the first row under the title is a legal place')
  cases += 2
  const back = relocateBlock(BAD, lineOf(BAD, '### Stray'), lineOf(BAD, '## One'))
  check('the stray slide moved back under the title', BAD, back, J(...FM, ...TITLE, '### Stray', '{id=stray}', 'stray body', '', '## One', '', ...A, ...B))
  check('the stray slide to the end', BAD, relocateBlockToEnd(BAD, lineOf(BAD, '### Stray')), J(...FM, ...TITLE, '## One', '', ...A, ...B, '### Stray', '{id=stray}', 'stray body', ''))
  // Without a title every move is as it was: a block can go before the first heading of the file.
  check('no title: before the first heading, as before', J(...A, ...B, ...C), relocateBlock(J(...A, ...B, ...C), 7, 1), J(...C, ...A, ...B))
  // Sweep: every heading of T moved before / after / into every other heading and to the end: the
  // title's own lines never move, and the lines are the same multiset.
  const heads = T.split('\n').map((l, i) => (/^#{1,6}\s/.test(l) ? i + 1 : 0)).filter((n) => n > FM.length && n !== title)
  for (const from of heads) {
    for (const out of [relocateBlockToEnd(T, from), ...[title, ...heads].flatMap((to) => [relocateBlock(T, from, to), relocateBlockAfter(T, from, to), relocateBlockInto(T, from, to)])]) {
      assert.deepEqual(out.split('\n').slice(0, FM.length + TITLE.length), [...FM, ...TITLE], `sweep: from line ${from}, the title is still on top`)
      assert.deepEqual(sortedLines(out), sortedLines(T), 'sweep: same multiset of lines')
      cases += 1
    }
  }
}

// ── Code fences: a heading-shaped line in fenced code is not a row and ends no block ──
// (src/shared/heading-lines.ts). `PLAIN` is the same talk with those lines written as body text of
// the same length: every move of the fenced talk is the plain talk's move, the lines written back.
{
  const CODE = { '# install': 'x install', '## not a section': 'xx not a section', '### inner': 'xxx inner', '### hidden': 'xxx hidden', '# tail': 'x tail' }
  const plainOf = (t) => t.split('\n').map((l) => CODE[l] ?? l).join('\n')
  const FENCED = J('---', 'title: "T"', '# a YAML comment', '---', '# Talk', '{id=deck}', 'title text', '',
    '## One', '{id=one}', '',
    '### A', '{id=a}', '```sh', '# install', 'npm i', '## not a section', '```', 'after fence', '',
    '### B', '{id=b}', '~~~~md', '### inner', '~~~', 'still code', '~~~~', '',
    '## Two', '{id=two}', '',
    '### C', '{id=c}', '<!--', '### hidden', '-->', 'c body', '',
    '#### C step', 'step', '',
    '### D', '{id=d}', '````', '# tail', '````', '')
  const PLAIN = plainOf(FENCED)
  const rows = slideRows(FENCED)
  assert.deepEqual(rows.map((r) => `${r.level} ${r.text} ${r.slideNo ?? '-'} ${r.id}`),
    ['1 Talk - deck', '2 One - one', '3 A 1 a', '3 B 2 b', '2 Two - two', '3 C - c', '4 C step 3 null', '3 D 4 d'],
    'the Slide outline: the real headings only, numbered as slides; no row for a line in a fence, a comment or the frontmatter')
  assert.deepEqual(rows, slideRows(PLAIN), 'the same rows as the talk whose fenced lines are body text')
  assert.equal(talkTitleLine(FENCED), 5, 'the title is the first real level-1 heading')
  cases += 3
  const n = FENCED.split('\n').length
  const real = new Set(rows.map((r) => r.line))
  let moved = 0
  for (let from = 1; from <= n; from += 1) {
    for (let to = 1; to <= n; to += 1) {
      for (const [name, fn] of [['relocateBlock', relocateBlock], ['relocateBlockInto', relocateBlockInto], ['relocateBlockAfter', relocateBlockAfter]]) {
        const out = fn(FENCED, from, to)
        cases += 1
        assert.equal(plainOf(out), fn(PLAIN, from, to), `${name} ${from} → ${to}: as with body text`)
        if (out === FENCED) continue
        moved += 1
        assert.ok(real.has(from) && real.has(to), `${name} ${from} → ${to}: only real headings move or are targets`)
        assert.deepEqual(sortedLines(out), sortedLines(FENCED), `${name} ${from} → ${to}: same multiset of lines`)
        assert.deepEqual(slideRows(out).map((r) => r.text).sort(), rows.map((r) => r.text).sort(), `${name} ${from} → ${to}: the same slides (no fence was split)`)
        assert.equal(talkTitleLine(out), 5, `${name} ${from} → ${to}: the title stays where it is`)
      }
    }
    const end = relocateBlockToEnd(FENCED, from)
    cases += 1
    assert.equal(plainOf(end), relocateBlockToEnd(PLAIN, from), `relocateBlockToEnd ${from}: as with body text`)
    assert.deepEqual(sortedLines(end), sortedLines(FENCED))
  }
  assert.ok(moved > 50, `the sweep made real moves (${moved})`)
  // The reported shape, spelled out: A goes after B whole, its fence closed.
  const REPRO = J('### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', '', '### B', 'b body', '')
  assert.equal(relocateBlockAfter(REPRO, 1, 9), J('### B', 'b body', '', '### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', ''))
  assert.equal(relocateBlock(REPRO, 9, 4), REPRO, 'a fenced line is not a row to drop before')
  assert.equal(relocateBlockToEnd(REPRO, 4), REPRO, 'nor a block to move')
  cases += 3
}

// relocateBlock (insert before a row) is unchanged by this work: one spot check that the new
// functions did not replace it.
assert.equal(relocateBlock(J('### A', 'a', '### B', 'b'), 3, 1), J('### B', 'b', '### A', 'a'))

console.log(`slide-outline-moves: ${cases} cases passed`)
