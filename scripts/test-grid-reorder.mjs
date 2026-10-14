// The grid's block reorder (src/shared/grid-reorder.ts, what the `outline:reorder` IPC runs), with
// the real listSlideBlocks from the compiler. Covers the direction rule the grid has always had and
// the `placement` argument its two new drop targets use: a section header (the slide becomes the
// last slide of that section) and the zone after the last cell (the slide goes to the end).
// Every case asserts the same multiset of lines: nothing lost, nothing duplicated.
import { strict as assert } from 'node:assert'
import { listSlideBlocks } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { reorderGridBlocks } from '../src/shared/grid-reorder.ts'

const J = (...lines) => lines.join('\n')
const sortedLines = (t) => t.split('\n').sort()
const slide = (name) => [`### ${name}`, `{id=${name.toLowerCase()}}`, '', `- ${name} point`, '', `Note: ${name} note`, '']
const TALK = J('# Talk', '', '## One', '', ...slide('A'), ...slide('B'), '## Two', '', ...slide('C'), '#### C step', 'step body', '', ...slide('D'), '## Three', '', ...slide('E'))
// Grid block indices: A 0, B 1, C 2 (with its #### subtree), D 3, E 4.
const order = (text) => text.split('\n').filter((l) => /^#{2,4} /.test(l)).map((l) => l.replace(/^#+ /, (m) => (m.length === 3 ? '§' : m.length === 5 ? '+' : ''))).join(' ')
assert.equal(order(TALK), '§One A B §Two C +C step D §Three E')

let cases = 0
function move(name, from, to, placement, expected) {
  cases += 1
  const out = reorderGridBlocks(TALK, listSlideBlocks(TALK), from, to, placement)
  assert.notEqual(out, null, `${name}: a possible move`)
  assert.deepEqual(sortedLines(out), sortedLines(TALK), `${name}: same multiset of lines`)
  assert.equal(order(out), expected, name)
  return out
}

// The direction rule, unchanged (no placement): down lands after the target, up lands before it.
move('drag down onto a cell: after it', 0, 1, undefined, '§One B A §Two C +C step D §Three E')
move('drag up onto a cell: before it', 3, 0, undefined, '§One D A B §Two C +C step §Three E')
move('a block travels with its #### subtree', 2, 4, undefined, '§One A B §Two D §Three E C +C step')

// Section header drop = after the section's last block, whatever the direction.
move('header of a later section: last slide of it', 0, 3, 'after', '§One B §Two C +C step D A §Three E')
move('header of an earlier section, dragging UP: still last slide of it', 4, 1, 'after', '§One A B E §Two C +C step D §Three')
move('header of the next-door earlier section', 2, 1, 'after', '§One A B C +C step §Two D §Three E')
move('header of its own section: becomes its last slide', 2, 3, 'after', '§One A B §Two D C +C step §Three E')
// End zone = after the last block of the talk.
const end = move('end zone: the first slide goes to the end', 0, 4, 'after', '§One B §Two C +C step D §Three E A')
assert(end.endsWith(J(...slide('A'))), 'the moved slide ends the file, whole (id line, body, note)')
move('"before" is honoured when dragging down', 0, 3, 'before', '§One B §Two C +C step A D §Three E')

// Not possible: null, and the caller leaves the text alone.
for (const [from, to] of [[0, 0], [4, 4], [-1, 2], [2, -1], [5, 0], [0, 5]]) {
  assert.equal(reorderGridBlocks(TALK, listSlideBlocks(TALK), from, to, 'after'), null, `${from}→${to} is not a move`)
  cases += 1
}

// A 100-slide talk: every slide to the end and onto every section header keeps every line.
{
  const parts = ['# Talk', '']
  for (let s = 0; s < 10; s += 1) {
    parts.push(`## Section ${s}`, '')
    for (let i = 0; i < 10; i += 1) parts.push(`### Slide ${s}.${i}`, `{id=s${s}-${i}}`, '', `- point ${s}.${i}`, '')
  }
  const text = parts.join('\n')
  const blocks = listSlideBlocks(text)
  for (let from = 0; from < 100; from += 1) {
    for (let s = 0; s < 10; s += 1) {
      const last = s * 10 + 9
      if (from === last) continue
      const out = reorderGridBlocks(text, blocks, from, last, 'after')
      assert.deepEqual(sortedLines(out), sortedLines(text), `100 slides: ${from} → section ${s}`)
      const o = out.split('\n')
      const sec = o.indexOf(`## Section ${s}`)
      let next = o.findIndex((l, i) => i > sec && l.startsWith('## '))
      if (next < 0) next = o.length
      const from10 = `### Slide ${Math.floor(from / 10)}.${from % 10}`
      assert.equal(o.slice(sec, next).filter((l) => l.startsWith('### ')).pop(), from10, `100 slides: ${from10} is last in section ${s}`)
      cases += 1
    }
  }
}
// Nothing goes before the talk's title. The grid shows no card for the title, so a legal file never
// asks for it; a file with a slide already above the title (0.38.3-preview.12 made one) must not
// take a second one up there: that is not a possible move.
{
  const BAD = J('---', 'title: "T"', '---', ...slide('Stray'), '# Talk', '', '## One', '', ...slide('A'), ...slide('B'))
  const blocks = listSlideBlocks(BAD)
  // Grid blocks: Stray 0, A 1, B 2.
  assert.equal(reorderGridBlocks(BAD, blocks, 2, 0, 'before'), null, 'before a slide that is above the title: refused')
  assert.equal(reorderGridBlocks(BAD, blocks, 2, 0, undefined), null, 'dragged up onto it: refused')
  assert.equal(reorderGridBlocks(BAD, blocks, 2, 0, 'after'), null, 'after it, still above the title: refused')
  const back = reorderGridBlocks(BAD, blocks, 0, 1, 'after')
  assert.deepEqual(sortedLines(back), sortedLines(BAD), 'the stray slide moved under the title: same multiset of lines')
  assert.equal(back.split('\n')[3], '# Talk', 'and the title is directly after the frontmatter again')
  const up = reorderGridBlocks(TALK, listSlideBlocks(TALK), 4, 0, 'before')
  assert.equal(up.split('\n')[0], '# Talk', 'a legal talk: the last slide moved before the first, the title is still the first line')
  cases += 6
}
// Code fences: the grid's blocks come from the compiler's listSlideBlocks, which reads a
// heading-shaped line in fenced code as code, and the title rule reads the same headings
// (src/shared/heading-lines.ts): a slide moves with its whole fence, and a fenced `# ` line above
// the real title is not the title.
{
  const FENCED = J('```sh', '# not the title', '```', '# Talk', '', '## One', '',
    '### A', '{id=a}', '```sh', '# install', '### not a slide', '```', 'after fence', '',
    '### B', '{id=b}', 'b body', '',
    '### C', '{id=c}', 'c body', '')
  const blocks = listSlideBlocks(FENCED)
  assert.deepEqual(blocks.map((b) => b.title), ['One', 'A', 'B', 'C'], 'the compiler lists the real slides only')
  const out = reorderGridBlocks(FENCED, blocks, 0, 2, 'after')
  assert.deepEqual(sortedLines(out), sortedLines(FENCED), 'same multiset of lines')
  assert.equal(out, J('```sh', '# not the title', '```', '# Talk', '', '## One', '',
    '### B', '{id=b}', 'b body', '',
    '### C', '{id=c}', 'c body', '',
    '### A', '{id=a}', '```sh', '# install', '### not a slide', '```', 'after fence', ''), 'A moves with its whole fence')
  assert.deepEqual(listSlideBlocks(out).map((b) => b.title), ['One', 'B', 'C', 'A'], 'and the talk still has the same slides')
  // Blocks as a caller might hand them with a place above the real title: refused by the real title,
  // not by the fenced line.
  assert.equal(reorderGridBlocks(FENCED, [{ heading: '### X', start: 1, end: 2 }, ...blocks.slice(1)], 1, 0, 'before'), null, 'a place above the real title is not a possible move')
  cases += 5
}
console.log(`grid-reorder: ${cases} cases passed`)
