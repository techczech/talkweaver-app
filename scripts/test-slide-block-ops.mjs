// Cut, copy and paste of whole slides, and "Move … to…": table tests of the pure functions in
// src/renderer/src/extensions/slideBlockOps.ts (and relocateBlockAfter beside the other move
// functions). These edit the user's talk text, so beside the exact expected text every case asserts
// the property that matters:
//   - cut then paste elsewhere: the same multiset of lines, blank separator lines apart;
//   - copy then paste: the original lines plus the pasted block, whose id is fresh;
//   - a move: the same multiset of lines, nothing apart.
import { strict as assert } from 'node:assert'
import { mintId } from '../compiler/scripts/lib/13-slide-ledger.mjs'
import { duplicateSlideWithLineage, listSlideBlocks } from '../compiler/scripts/lib/12-outline-edit.mjs'
import {
  blockAt, caretPastePlace, isTalkTitleLine, startOfTalkPlace, copyBlock, cutBlock, describeClip, forgetSlideClip, headingLineAt, isOwnSlideClip, isSlideClip, isTitleClip, moveBlock, pasteSlides, reIdCollisions, rememberSlideClip, touchesTitleLine, widenToBlocks
} from '../src/renderer/src/extensions/slideBlockOps.ts'
import { relocateBlockAfter, slideRows } from '../src/renderer/src/extensions/slideOutline.ts'
import { headingLevels, headingLevelsOfText } from '../src/shared/heading-lines.ts'

let cases = 0
const J = (...lines) => lines.join('\n')
const lineOf = (text, heading) => {
  const i = text.split('\n').map((l) => l.replace(/\r$/, '')).indexOf(heading)
  assert(i >= 0, `fixture has the line ${JSON.stringify(heading)}`)
  return i + 1
}
const words = (t) => t.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '').sort()
const allLines = (t) => t.split('\n').sort()
// The duplicate verb's minter (compiler mintId) with a fixed sequence, so expected ids can be written down.
const minter = (...ids) => { const left = [...ids]; return (taken) => { const id = left.shift() ?? mintId(Math.random, taken); taken.add(id); return id } }

const RICH = ['### Rich {reveal}', '{columns}', '{id=s-rich}', '', '- point one', '- point two', '', 'Note: say this slowly.', '']
const A = ['### A', '{id=a1}', 'body A', '']
const B = ['### B', '{id=b1}', 'body B', '']
const C = ['### C', '{id=c1}', 'body C', '']
const TALK = J('# Talk', '', '## One', '', ...A, ...RICH, '## Two', '', ...B, '## Empty', '', '## Three', '', ...C)

// ── headingLineAt / blockAt ──
{
  const t = J(...RICH, ...B)
  assert.equal(headingLineAt(t, 1), 1, 'the heading line')
  assert.equal(headingLineAt(t, 2), 1, 'the layout line under it')
  assert.equal(headingLineAt(t, 3), 1, 'the id line under the layout line')
  assert.equal(headingLineAt(t, 4), null, 'a blank line is not the heading')
  assert.equal(headingLineAt(t, 5), null, 'body text is not the heading')
  assert.equal(headingLineAt(t, 8), null, 'a note is not the heading')
  assert.equal(headingLineAt(J('intro', '{id=x}', '### A'), 2), null, 'a `{…}` line with no heading directly above')
  assert.equal(headingLineAt(J('---', 'title: T', '# not a slide', '---', '### A'), 3), null, 'a `#` line inside the frontmatter')
  assert.deepEqual(blockAt(t, 1), { line: 1, endLine: 10, level: 3, title: 'Rich', section: false })
  assert.deepEqual(blockAt(TALK, lineOf(TALK, '## One')), { line: 3, endLine: lineOf(TALK, '## Two'), level: 2, title: 'One', section: true })
  assert.deepEqual(blockAt(TALK, lineOf(TALK, '## Empty')), { line: lineOf(TALK, '## Empty'), endLine: lineOf(TALK, '## Three'), level: 2, title: 'Empty', section: false }, 'an empty section is a block of its own')
  assert.equal(blockAt(t, 5), null, 'not a heading line')
  cases += 11
}

// ── cutBlock: exact text, clip, and whole lines only ──
function cut(name, input, heading, expectedText, expectedClip) {
  cases += 1
  const r = cutBlock(input, lineOf(input, heading))
  assert.ok(r, `${name}: cut`)
  assert.equal(r.text, expectedText, `${name}: text`)
  assert.equal(r.clip, expectedClip, `${name}: clip`)
  assert.equal(input.slice(0, r.from) + input.slice(r.to), r.text, `${name}: the offsets are the change`)
  // Whole lines: the removed span starts at a line start, and the lines it held are the clip's (blank lines apart).
  assert.ok(r.from === 0 || input[r.from - 1] === '\n', `${name}: starts at a line start`)
  assert.deepEqual(words(input.slice(r.from, r.to)), words(r.clip), `${name}: what was removed is what is on the clipboard`)
  assert.deepEqual([...words(r.text), ...words(r.clip)].sort(), words(input), `${name}: nothing lost, nothing duplicated`)
  return r
}
cut('first slide', J(...A, ...B, ...C), '### A', J(...B, ...C), J('### A', '{id=a1}', 'body A', ''))
cut('middle slide', J(...A, ...B, ...C), '### B', J(...A, ...C), J('### B', '{id=b1}', 'body B', ''))
cut('last slide, file ends with a newline: the file still ends with one, the separator goes',
  J(...A, ...B, ...C), '### C', J(...A, '### B', '{id=b1}', 'body B', ''), J('### C', '{id=c1}', 'body C', ''))
cut('last slide, NO final newline: the previous slide keeps its line end',
  J(...A, ...B, '### C', '{id=c1}', 'body C'), '### C', J(...A, '### B', '{id=b1}', 'body B', ''), J('### C', '{id=c1}', 'body C', ''))
cut('last slide right under an id line (tight): the id line above is not touched',
  J('### A', '{id=a1}', '### C', '{id=c1}', 'body C'), '### C', J('### A', '{id=a1}', ''), J('### C', '{id=c1}', 'body C', ''))
cut('several blank lines end the file: they stay',
  J(...A, '### C', 'body C', '', '', ''), '### C', J('### A', '{id=a1}', 'body A', '', '', ''), J('### C', 'body C', ''))
cut('slide with layout line, id line and notes goes whole',
  J('## One', '', ...A, ...RICH, ...B), '### Rich {reveal}', J('## One', '', ...A, ...B),
  J('### Rich {reveal}', '{columns}', '{id=s-rich}', '', '- point one', '- point two', '', 'Note: say this slowly.', ''))
cut('a section goes with its slides', TALK, '## One',
  J('# Talk', '', '## Two', '', ...B, '## Empty', '', '## Three', '', ...C),
  J('## One', '', ...A, ...RICH).replace(/\n$/, '') + '\n')
cut('an empty section', TALK, '## Empty',
  J('# Talk', '', '## One', '', ...A, ...RICH, '## Two', '', ...B, '## Three', '', ...C), J('## Empty', ''))
cut('a deeper block with its subtree', J('### s', '#### a', '##### a1', '#### b', '### t'), '#### a', J('### s', '#### b', '### t'), J('#### a', '##### a1', ''))
cut('the only slide', J('### A', 'body', ''), '### A', '', J('### A', 'body', ''))
cut('tight formatting', J('### A', 'a', '### B', 'b'), '### A', J('### B', 'b'), J('### A', 'a', ''))
{
  const crlf = ['### A', '{id=a1}', 'body A', '', '### B', 'body B', ''].join('\r\n')
  const r = cut('CRLF: the talk keeps its line endings, the clipboard is LF', crlf, '### A', ['### B', 'body B', ''].join('\r\n'), J('### A', '{id=a1}', 'body A', ''))
  assert.ok(!r.clip.includes('\r'))
}
{
  // A heading-shaped line inside a code fence is code (src/shared/heading-lines.ts): the cut takes
  // the whole slide, its fence closed, and nothing of it is left behind. (Before the heading map
  // the cut stopped at the fenced line and left an unclosed half of the fence.)
  const fenced = J('### A', '```md', '### not a slide', '```', '', '### B', 'b')
  const r = cutBlock(fenced, 1)
  assert.equal(r.text, J('### B', 'b'), 'a fenced `###` does not end the block')
  assert.equal(r.clip, J('### A', '```md', '### not a slide', '```', ''), 'the clip holds the whole fence')
  cases += 1
}
assert.equal(cutBlock(J(...A), 3), null, 'not a heading: nothing is cut')
assert.equal(copyBlock(J(...A, ...B), 1).clip, J('### A', '{id=a1}', 'body A', ''), 'copy is the same clip, the talk untouched')
cases += 2

// ── isSlideClip / describeClip ──
assert.equal(isSlideClip('### A\nbody\n'), true)
assert.equal(isSlideClip('\n\n### A\r\nbody\r\n'), true, 'leading blank lines and CRLF')
assert.equal(isSlideClip('body\n### A\n'), false, 'text that starts inside a slide')
assert.equal(isSlideClip('A title'), false, 'part of a heading')
assert.equal(isSlideClip('###no space'), false)
assert.equal(isSlideClip(''), false)
assert.deepEqual(describeClip(J(...A)), { count: 1, title: 'A', section: false })
assert.deepEqual(describeClip(J('## One', '', ...A, ...B)), { count: 1, title: 'One', section: true })
assert.deepEqual(describeClip(J(...A, ...B, ...C)), { count: 3, title: 'A', section: false })
assert.deepEqual(describeClip(J('### A', '#### a', '## S', '### x')), { count: 2, title: 'A', section: false })
cases += 10

// ── The talk's title is never cut: its block is the whole talk ──
{
  const talk = J('# Talk', '', '## One', '', ...A, ...B)
  assert.equal(blockAt(talk, 1).endLine, talk.split('\n').length + 1, 'the title\'s block is the whole talk')
  assert.equal(cutBlock(talk, 1), null, 'cutBlock refuses a level-1 heading')
  assert.equal(cutBlock(J('---', 'title: x', '---', '# Talk', '', ...A), 4), null, 'under frontmatter too')
  assert.ok(cutBlock(talk, 3), 'a section (level 2) is still cut')
  assert.equal(copyBlock(talk, 1).clip, talk, 'copying the title\'s block is as it was')
  const titleEnd = '# Talk'.length
  // A selection that touches the title line is never a whole-slide cut or copy (touchesTitleLine).
  assert.equal(touchesTitleLine(talk, 0, titleEnd), true, 'the whole title line')
  assert.equal(touchesTitleLine(talk, 2, 4), true, 'part of the title')
  assert.equal(touchesTitleLine(talk, titleEnd - 1, talk.indexOf('### A') + 5), true, 'from the title\'s last letter into a slide')
  assert.equal(touchesTitleLine(talk, titleEnd, talk.length), false, 'from the end of the title line on: no character of it')
  assert.equal(touchesTitleLine(talk, talk.indexOf('## One'), talk.length), false, 'slides and sections only')
  assert.equal(touchesTitleLine(talk, 3, 3), false, 'no selection')
  const fm = J('---', 'title: x', '# not a heading', '---', '# Talk', '', ...A)
  assert.equal(touchesTitleLine(fm, 0, fm.indexOf('# Talk')), false, 'a # line in the frontmatter is not the title')
  assert.equal(touchesTitleLine(fm, 0, fm.indexOf('# Talk') + 1), true)
  // The reviewer's case: from the title into the first slide's heading. Widened it starts at the title,
  // which is why the editor asks touchesTitleLine first.
  const rev = '# Talk\n\n### Slide A\n{id=a}\nbody a\n\n### Slide B\n{id=b}\nbody b\n'
  assert.equal(widenToBlocks(rev, 0, 27).from, 0, 'the widened range starts at the title')
  assert.equal(touchesTitleLine(rev, 0, 27), true)
  cases += 15
}

// ── isOwnSlideClip: only the text this app last wrote with a whole-slide cut or copy is a slide paste ──
{
  forgetSlideClip()
  const own = copyBlock(J(...A, ...B), 1).clip
  assert.equal(isOwnSlideClip(own), false, 'nothing cut or copied yet: slide-shaped text is ordinary text')
  rememberSlideClip(own)
  assert.equal(isOwnSlideClip(own), true, 'the text this app wrote')
  assert.equal(isOwnSlideClip(own.replace(/\n/g, '\r\n')), true, 'line endings are not compared')
  assert.equal(isOwnSlideClip('# install\nnpm i foo'), false, 'other text whose first line starts with #')
  assert.equal(isOwnSlideClip(own + 'more'), false, 'the same slide with text added')
  assert.equal(isOwnSlideClip(own.trimEnd()), false, 'string equality, not a likeness')
  assert.equal(isOwnSlideClip(''), false)
  rememberSlideClip('body text')
  assert.equal(isOwnSlideClip('body text'), false, 'text that is not slide-shaped is never a slide paste')
  assert.equal(isOwnSlideClip(own), true, 'and does not replace the record')
  const next = cutBlock(J(...A, ...B), 5).clip
  rememberSlideClip(next)
  assert.equal(isOwnSlideClip(next), true, 'the last one written')
  assert.equal(isOwnSlideClip(own), false, 'not the one before it')
  // A clip that starts with the talk's title is never slides to paste, whoever wrote it.
  rememberSlideClip(own)
  const titled = J('# Talk', '', ...A)
  assert.equal(isTitleClip(titled), true)
  assert.equal(isTitleClip('\n# Talk\r\n'), true)
  assert.equal(isTitleClip(own), false)
  rememberSlideClip(titled)
  assert.equal(isOwnSlideClip(titled), false, 'it is not recorded')
  assert.equal(isOwnSlideClip(own), true, 'and the record before it stands')
  forgetSlideClip()
  cases += 16
}

// ── pasteSlides ──
function paste(name, input, clip, place, mint, expectedText, extra = {}) {
  cases += 1
  const r = pasteSlides(input, clip, place, mint)
  assert.ok(r, `${name}: pasted`)
  assert.equal(r.text, expectedText, `${name}: text`)
  assert.equal(input.slice(0, r.from) + r.insert + input.slice(r.from), r.text, `${name}: the offsets are the change`)
  assert.equal(r.text.split('\n')[r.line - 1].replace(/\r$/, ''), extra.heading ?? clip.split('\n')[0], `${name}: line ${r.line} is the pasted heading`)
  // Whole lines at a block boundary: never inside another slide's body.
  assert.ok(r.from === 0 || r.from === input.length || input[r.from - 1] === '\n' || input[r.from] === '\n' || input[r.from] === '\r', `${name}: inserted at a line boundary`)
  const ids = [...r.text.matchAll(/\{id=([^}]+)\}/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, `${name}: no id twice in the talk`)
  return r
}
const clipA = J('### A', '{id=a1}', 'body A', '')
{
  const cutA = cutBlock(J(...A, ...B, ...C), 1)
  const r = paste('a cut slide pasted after another keeps its id (a move)', cutA.text, cutA.clip, { after: lineOf(cutA.text, '### B') }, minter('NEW'),
    J(...B, ...A, ...C))
  assert.deepEqual(r.reIds, [])
  assert.deepEqual(r.anchor, { relation: 'after', title: 'B' })
  assert.deepEqual(words(r.text), words(J(...A, ...B, ...C)), 'cut + paste: the same lines')
  const again = paste('pasting the same clip a second time mints a fresh id', r.text, cutA.clip, { after: lineOf(r.text, '### C') }, minter('zz999'),
    J(...B, ...A, ...C, '### A', '{id=zz999}', 'body A', ''))
  assert.deepEqual(again.reIds, [{ from: 'a1', to: 'zz999' }])
}
paste('copy then paste after the last slide, file ends with a newline', J(...A, ...B), clipA, { after: 5 }, minter('n1'),
  J(...A, ...B, '### A', '{id=n1}', 'body A', ''))
paste('at the end of the talk, NO final newline: still none', J(...B, '### C', 'body C'), clipA, 'end', minter(),
  J(...B, '### C', 'body C', '', '### A', '{id=a1}', 'body A'))
paste('at the end of the talk, several blank lines end the file: they stay at the end', J('### B', 'body B', '', '', ''), clipA, 'end', minter(),
  J('### B', 'body B', '', '### A', '{id=a1}', 'body A', '', '', ''))
paste('after a section: after ALL its slides', TALK, J('### New', 'n', ''), { after: lineOf(TALK, '## One') }, minter(),
  J('# Talk', '', '## One', '', ...A, ...RICH, '### New', 'n', '', '## Two', '', ...B, '## Empty', '', '## Three', '', ...C))
paste('after an empty section', TALK, J('### New', 'n', ''), { after: lineOf(TALK, '## Empty') }, minter(),
  J('# Talk', '', '## One', '', ...A, ...RICH, '## Two', '', ...B, '## Empty', '', '### New', 'n', '', '## Three', '', ...C))
paste('before a heading (the caret between two slides)', J(...A, ...B), J('### New', 'n', ''), { before: 5 }, minter(),
  J(...A, '### New', 'n', '', ...B))
paste('tight formatting: a blank line goes each side of the pasted slide', J('### A', 'a', '### B', 'b'), J('### New', 'n', ''), { after: 1 }, minter(),
  J('### A', 'a', '', '### New', 'n', '', '### B', 'b'))
paste('into an empty talk', '', clipA, 'end', minter(), J('### A', '{id=a1}', 'body A'))
paste('a clip from another app: CRLF, blank lines around it', J(...B), '\r\n### New\r\nn\r\n\r\n', 'end', minter(),
  J('### B', '{id=b1}', 'body B', '', '### New', 'n', ''), { heading: '### New' })
paste('a section with its slides, every colliding id fresh, in order', J('## One', '', ...A, ...B), J('## One', '', ...A, ...B), 'end', minter('x1', 'x2'),
  J('## One', '', ...A, ...B.slice(0, 3), '', '## One', '', '### A', '{id=x1}', 'body A', '', '### B', '{id=x2}', 'body B', ''))
paste('an id on the heading line itself', J('### A {id=h1}', 'a', ''), J('### A {id=h1}', 'a', ''), 'end', minter('h2'),
  J('### A {id=h1}', 'a', '', '### A {id=h2}', 'a', ''), { heading: '### A {id=h2}' })
{
  const crlf = ['### A', '{id=a1}', 'body A', '', '### B', 'body B', ''].join('\r\n')
  const r = paste('CRLF talk: the pasted lines get its line endings', crlf, J('### New', 'n', ''), { after: 1 }, minter(),
    ['### A', '{id=a1}', 'body A', '', '### New', 'n', '', '### B', 'body B', ''].join('\r\n'))
  assert.ok(!/[^\r]\n/.test(r.text), 'no bare LF')
}
{
  // The fresh id is the duplicate verb's: same minter, same result as duplicateSlideWithLineage.
  const src = J(...A, ...B)
  const rng = () => 0.123456789
  const viaVerb = duplicateSlideWithLineage(src, { heading: '### A', occurrence: 1 }, rng)
  const viaPaste = pasteSlides(src, copyBlock(src, 1).clip, { after: 1 }, (taken) => mintId(rng, taken))
  assert.deepEqual(viaPaste.reIds, [{ from: 'a1', to: viaVerb.minted.newId }], 'the id a copy-paste mints is the one Duplicate would')
  assert.deepEqual(words(viaPaste.text), words(viaVerb.text), 'and the talk holds the same lines as after Duplicate')
  assert.equal(listSlideBlocks(viaPaste.text).length, 3)
  cases += 1
}
assert.equal(pasteSlides(J(...A), 'just some text', 'end', minter()), null, 'text that is not slides is not pasted as slides')
assert.equal(pasteSlides(J(...A), clipA, { after: 3 }, minter()), null, 'a place that is not a heading')
cases += 2
{
  // Body ids and prose braces are not slide ids: only the heading's own prelude is re-id'd.
  const r = reIdCollisions(['### A', '{id=a1}', 'see {id=a1} in the text', '{id=a1}'], new Set(['a1']), minter('f1'))
  assert.deepEqual(r.lines, ['### A', '{id=f1}', 'see {id=a1} in the text', '{id=a1}'])
  const two = reIdCollisions(['### A', '{id=k}', '### B', '{id=k}'], new Set(), minter('k2'))
  assert.deepEqual(two.lines, ['### A', '{id=k}', '### B', '{id=k2}'], 'the same id twice inside one clip: the second slide gets a fresh one')
  cases += 2
}

// ── the invariants, over every pair of slides in a realistic talk ──
{
  const headings = TALK.split('\n').filter((l) => /^#{2,6}\s/.test(l))
  for (const from of headings) {
    const c = cutBlock(TALK, lineOf(TALK, from))
    const left = c.text.split('\n').filter((l) => /^#{1,6}\s/.test(l))
    for (const after of [...left.slice(1), null]) {
      const p = pasteSlides(c.text, c.clip, after ? { after: lineOf(c.text, after) } : 'end', minter('NEVER'))
      assert.deepEqual(words(p.text), words(TALK), `cut ${from}, paste after ${after ?? 'the end'}: the same lines`)
      assert.deepEqual(p.reIds, [], 'a move keeps every id')
      cases += 1
    }
    for (const after of headings) {
      const copy = copyBlock(TALK, lineOf(TALK, from))
      const p = pasteSlides(TALK, copy.clip, { after: lineOf(TALK, after) }, (taken) => { const id = `fresh${taken.size}`; taken.add(id); return id })
      const pastedWords = words(p.insert)
      assert.deepEqual(words(p.text), [...words(TALK), ...pastedWords].sort(), `copy ${from}, paste after ${after}: the talk plus the pasted block`)
      const map = new Map(p.reIds.map((r) => [r.to, r.from]))
      assert.deepEqual(pastedWords.map((l) => l.replace(/\{id=(fresh\d+)\}/, (_, id) => `{id=${map.get(id)}}`)).sort(), words(copy.clip), 'the pasted block differs from the copy only by its ids')
      assert.equal(p.reIds.length, (copy.clip.match(/\{id=/g) ?? []).length, 'every slide id in the copy is fresh')
      cases += 1
    }
  }
}

// ── caretPastePlace ──
{
  const t = J('---', 'title: T', '---', '', ...A, '', ...RICH)
  const at = (heading) => lineOf(t, heading)
  assert.deepEqual(caretPastePlace(t, at('### A')), { after: at('### A') }, 'on a heading line: after that slide')
  assert.deepEqual(caretPastePlace(t, at('{id=s-rich}')), { after: at('### Rich {reveal}') }, 'on its id line: after that slide')
  assert.equal(caretPastePlace(t, at('body A')), null, 'in body text: ordinary text')
  assert.equal(caretPastePlace(t, at('- point one')), null)
  assert.equal(caretPastePlace(t, at('Note: say this slowly.')), null, 'in notes: ordinary text')
  assert.deepEqual(caretPastePlace(t, at('body A') + 1), { before: at('### Rich {reveal}') }, 'on the blank line between two slides: between them')
  assert.deepEqual(caretPastePlace(t, at('body A') + 2), { before: at('### Rich {reveal}') })
  assert.equal(caretPastePlace(t, at('{id=s-rich}') + 1), null, 'a blank line inside a slide (body below it)')
  assert.equal(caretPastePlace(t, t.split('\n').length), 'end', 'the blank line that ends the talk')
  assert.deepEqual(caretPastePlace(t, 4), { before: at('### A') }, 'the blank line before the first slide')
  assert.equal(caretPastePlace(t, 2), null, 'in the frontmatter')
  cases += 11
}

// ── widenToBlocks ──
{
  const t = J(...A, ...RICH, ...B)
  const off = (heading, col = 0) => t.split('\n').slice(0, lineOf(t, heading) - 1).reduce((n, l) => n + l.length + 1, 0) + col
  const endOf = (heading) => off(heading) + heading.length
  assert.deepEqual(widenToBlocks(t, off('### Rich {reveal}'), endOf('### Rich {reveal}')), { from: off('### Rich {reveal}'), to: off('### B'), titles: ['Rich'] }, 'a selection of the whole title line: the whole slide')
  assert.deepEqual(widenToBlocks(t, off('body A', 2), endOf('{columns}')), { from: off('body A', 2), to: off('### B') - 1, titles: ['Rich'] }, 'from the middle of the slide before: its start stays, the slide whose title is inside goes whole, and the line end before the next title stays')
  assert.equal(widenToBlocks(t, off('### Rich {reveal}', 4), endOf('### Rich {reveal}')), null, 'only the title text (the marker is outside): ordinary text')
  assert.equal(widenToBlocks(t, off('### Rich {reveal}'), off('### Rich {reveal}', 6)), null, 'the start of a title: ordinary text')
  assert.equal(widenToBlocks(t, off('body A'), endOf('body A')), null, 'body text only')
  assert.deepEqual(widenToBlocks(t, off('### A'), endOf('### B')), { from: 0, to: t.length, titles: ['A', 'Rich', 'B'] }, 'several titles: all their slides')
  assert.deepEqual(widenToBlocks(t, off('### Rich {reveal}'), off('### B')), { from: off('### Rich {reveal}'), to: off('### B'), titles: ['Rich'] }, 'already the whole block: unchanged')
  const sec = J('## S', '', ...A, ...B, '## T')
  assert.equal(widenToBlocks(sec, 0, 4).to, sec.indexOf('## T'), 'a section title: the whole section')
  cases += 8
}

// ── moveBlock / relocateBlockAfter ──
function move(name, input, heading, target, expected) {
  cases += 1
  const r = moveBlock(input, lineOf(input, heading), target)
  if (expected === null) { assert.equal(r, null, `${name}: nothing moves`); return }
  assert.ok(r, `${name}: moved`)
  assert.deepEqual(allLines(r.text), allLines(input), `${name}: same multiset of lines`)
  assert.equal(r.text, expected, name)
  assert.equal(r.text.split('\n')[r.line - 1], heading, `${name}: line ${r.line} is the moved heading`)
}
const T3 = J('# Talk', '', '## One', '', ...A, ...B, '## Two', '', ...C)
move('to the start of the talk: before the first section, under the deck title', T3, '### C', { kind: 'start' }, J('# Talk', '', ...C, '## One', '', ...A, ...B, '## Two', ''))
move('the first section to the start: already there', T3, '## One', { kind: 'start' }, null)
move('to the end of the talk', T3, '### A', { kind: 'end' }, J('# Talk', '', '## One', '', ...B, '## Two', '', ...C, ...A))
move('the last slide to the end: already there', T3, '### C', { kind: 'end' }, null)
move('into a section, as its last slide', T3, '### A', { kind: 'into', line: lineOf(T3, '## Two') }, J('# Talk', '', '## One', '', ...B, '## Two', '', ...C, ...A))
move('into its own section when it is already last', T3, '### B', { kind: 'into', line: lineOf(T3, '## One') }, null)
move('before another slide', T3, '### C', { kind: 'before', line: lineOf(T3, '### A') }, J('# Talk', '', '## One', '', ...C, ...A, ...B, '## Two', ''))
move('after another slide', T3, '### A', { kind: 'after', line: lineOf(T3, '### C') }, J('# Talk', '', '## One', '', ...B, '## Two', '', ...C, ...A))
move('after the slide it already follows', T3, '### B', { kind: 'after', line: lineOf(T3, '### A') }, null)
move('a section after another section', T3, '## One', { kind: 'after', line: lineOf(T3, '## Two') }, J('# Talk', '', '## Two', '', ...C, '## One', '', ...A, ...B))
move('a section before another section', T3, '## Two', { kind: 'before', line: lineOf(T3, '## One') }, J('# Talk', '', '## Two', '', ...C, '## One', '', ...A, ...B))
move('a section never goes inside itself', T3, '## One', { kind: 'after', line: lineOf(T3, '### A') }, null)
move('a slide to after its own section: out of it', T3, '### A', { kind: 'after', line: lineOf(T3, '## One') }, J('# Talk', '', '## One', '', ...B, ...A, '## Two', '', ...C))
move('two slides with the same text: the moved one is followed, not its twin',
  J('### X', 'one', '', '### X', 'two', '', '### Y', 'y', ''), '### Y', { kind: 'start' }, J('### Y', 'y', '', '### X', 'one', '', '### X', 'two', ''))
{
  const twins = J('### X', 'one', '', '### Y', 'y', '', '### X', 'two', '')
  const r = moveBlock(twins, 7, { kind: 'start' })
  assert.equal(r.line, 1, 'the second of two identical headings is found at its new line')
  assert.equal(r.text, J('### X', 'two', '', '### X', 'one', '', '### Y', 'y', ''))
  assert.equal(moveBlock(twins, 2, { kind: 'end' }), null, 'not a heading')
  cases += 3
}
assert.equal(relocateBlockAfter(J(...A, ...B, '### C', 'body C'), 1, 9), J(...B, '### C', 'body C', '', '### A', '{id=a1}', 'body A'), 'after the last slide, no final newline: the separator stays between slides')
assert.equal(relocateBlockAfter(J(...A, ...B), 1, 3), J(...A, ...B), 'a target that is not a heading')
cases += 2

// ── Nothing goes before the talk's title: Move … to… "Start of talk" and a whole-slide paste ──
{
  const FM = ['---', 'title: "T"', '---', '']
  const TITLE = ['# Talk', '{id=deck}', 'The title\'s own text.', '']
  const T = J(...FM, ...TITLE, '## One', '', ...A, '## Two', '', ...B)
  const top = FM.length + TITLE.length
  const onTop = (name, text) => { cases += 1; assert.deepEqual(text.split('\n').slice(0, top), [...FM, ...TITLE], `${name}: the frontmatter and the title's own lines are still the top of the file`) }
  // Start of talk: directly after the title's own lines (its # line, its id line, its own text).
  const start = moveBlock(T, lineOf(T, '### B'), { kind: 'start' })
  assert.equal(start.text, J(...FM, ...TITLE, ...B, '## One', '', ...A, '## Two', ''), 'Start of talk: after the title\'s own lines, before the first section')
  assert.deepEqual(allLines(start.text), allLines(T), 'the same multiset of lines')
  assert.equal(start.line, top + 1, 'the moved heading is the first line under the title')
  onTop('Start of talk', start.text)
  cases += 3
  // before / after / into the title line, from every heading: never above it.
  for (const from of ['## One', '### A', '## Two', '### B']) {
    assert.equal(moveBlock(T, lineOf(T, from), { kind: 'before', line: lineOf(T, '# Talk') }), null, `${from} before the title: refused`)
    for (const kind of ['after', 'into']) {
      const r = moveBlock(T, lineOf(T, from), { kind, line: lineOf(T, '# Talk') })
      if (r) onTop(`${from} ${kind} the title`, r.text)
    }
    cases += 1
  }
  // A slide already above the title (a file 0.38.3-preview.12 damaged): Start of talk does not join
  // it up there, and it can itself be sent to the start, which is under the title.
  const BAD = J(...FM, '### Stray', '{id=stray}', 'stray body', '', ...TITLE, '## One', '', ...A, ...B)
  const joined = moveBlock(BAD, lineOf(BAD, '### B'), { kind: 'start' })
  assert.equal(joined.text, J(...FM, '### Stray', '{id=stray}', 'stray body', '', ...TITLE, ...B, '## One', '', ...A), 'Start of talk beside a stray slide: under the title, not above it')
  assert.equal(moveBlock(BAD, lineOf(BAD, '### B'), { kind: 'before', line: lineOf(BAD, '### Stray') }), null, 'before the stray slide: refused')
  const back = moveBlock(BAD, lineOf(BAD, '### Stray'), { kind: 'start' })
  assert.equal(back.text, J(...FM, ...TITLE, '### Stray', '{id=stray}', 'stray body', '', '## One', '', ...A, ...B), 'the stray slide sent to the start goes under the title')
  const lone = J('### Stray', 'stray body', '', '# Talk', 'title text', '')
  assert.equal(moveBlock(lone, 1, { kind: 'start' }).text, J('# Talk', 'title text', '', '### Stray', 'stray body', ''), 'a stray slide and nothing under the title: it goes to the end of the title\'s block')
  cases += 4

  // Whole-slide paste: a place at or above the title becomes the first place after it.
  const clip = J('### New', '{id=new1}', 'new body', '')
  const blankAboveTitle = J('---', 'title: "T"', '---', '', '# Talk', '{id=deck}', '', '## One', '', ...A)
  assert.deepEqual(caretPastePlace(blankAboveTitle, 4), { before: 5 }, 'the caret on the blank line above the title asks for "before the title"')
  const p = pasteSlides(blankAboveTitle, clip, { before: 5 }, minter())
  assert.equal(p.text, J('---', 'title: "T"', '---', '', '# Talk', '{id=deck}', '', '### New', '{id=new1}', 'new body', '', '## One', '', ...A), 'pasted before the title: it lands under the title, before the first section')
  assert.deepEqual(p.anchor, { relation: 'before', title: 'One' }, 'and the status line names the section it went before')
  assert.equal(p.line, 8, 'the pasted heading\'s line')
  assert.equal(p.text, blankAboveTitle.slice(0, p.from) + p.insert + blankAboveTitle.slice(p.from), 'text = before + insert + after')
  const onlyTitle = J('', '# Talk', 'title text', '')
  const q = pasteSlides(onlyTitle, clip, { before: 2 }, minter())
  assert.equal(q.text, J('', '# Talk', 'title text', '', '### New', '{id=new1}', 'new body', ''), 'a talk with only its title: the paste goes to the end')
  assert.equal(q.anchor, null, 'named as the end of the talk')
  const strayPaste = pasteSlides(BAD, clip, { after: lineOf(BAD, '### Stray') }, minter())
  assert.ok(strayPaste.text.indexOf('### New') > strayPaste.text.indexOf('# Talk'), 'after a slide that is above the title: under the title')
  const none = J(...A, ...B)
  assert.equal(pasteSlides(none, clip, { before: 1 }, minter()).text, J('### New', '{id=new1}', 'new body', '', ...A, ...B), 'no title: before the first slide, as before')
  cases += 9
}

// ── Code fences: a heading-shaped line in fenced code is not a heading (src/shared/heading-lines.ts) ──
{
  // The one answer, as a table. Each row: the lines, then the level of each (0 = not a heading).
  for (const [name, lines, expected] of [
    ['no fences: every marked line', ['# T', 'x', '## S', '###### deep', '####### seven', '#none', '### '], [1, 0, 2, 6, 0, 0, 3]],
    ['a backtick fence', ['### A', '```sh', '# install', '```', '### B'], [3, 0, 0, 0, 3]],
    ['a tilde fence', ['### A', '~~~', '## x', '~~~', '### B'], [3, 0, 0, 0, 3]],
    ['a longer opener is not closed by a shorter marker', ['````md', '```', '### in', '````', '### out'], [0, 0, 0, 0, 3]],
    ['a closing marker may be longer than the opener', ['```', '# in', '`````', '# out'], [0, 0, 0, 1]],
    ['a marker with text after it does not close', ['```', '# in', '```sh', '# still in', '```', '# out'], [0, 0, 0, 0, 0, 1]],
    ['tildes do not close backticks', ['```', '~~~', '# in', '```', '# out'], [0, 0, 0, 0, 1]],
    ['an unclosed fence runs to the end of the text', ['### A', '```', '# x', '### B', ''], [3, 0, 0, 0, 0]],
    ['the frontmatter holds no heading', ['---', '# not: a title', 'x: 1', '---', '# Talk', '## S'], [0, 0, 0, 0, 1, 2]],
    ['a fence marker in the frontmatter opens nothing', ['---', 'x: |', '  ```', '---', '# Talk'], [0, 0, 0, 0, 1]],
    ['an unclosed frontmatter is not frontmatter', ['---', '# Talk'], [0, 1]],
    ['an HTML comment hides the lines that start inside it', ['### A', '<!--', '### hidden', '-->', '### B'], [3, 0, 0, 0, 3]],
    ['CRLF lines', ['### A\r', '```\r', '# x\r', '```\r', '## B\r'], [3, 0, 0, 0, 2]],
  ]) {
    assert.deepEqual(headingLevels(lines), expected, `headingLevels: ${name}`)
    assert.deepEqual([...headingLevelsOfText(lines.join('\n'))], expected, `headingLevelsOfText: ${name}`)
    cases += 1
  }

  // The reported talk. A's block is all of A: its fenced `# install` is code.
  const REPRO = J('### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', '### B')
  assert.deepEqual(blockAt(REPRO, 1), { line: 1, endLine: 8, level: 3, title: 'A', section: false }, 'the block of A ends at ### B, and it is a slide, not a section')
  assert.equal(blockAt(REPRO, 4), null, 'the fenced line heads no block')
  assert.equal(headingLineAt(REPRO, 4), null, 'the caret on the fenced line is in the slide\'s text')
  assert.equal(caretPastePlace(REPRO, 4), null, 'so a paste there is ordinary text')
  const cutA = cutBlock(REPRO, 1)
  assert.equal(cutA.text, '### B', 'the cut takes the whole slide')
  assert.equal(cutA.clip, J('### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', ''), 'the clip holds the fence, closed')
  assert.equal(copyBlock(REPRO, 1).clip, cutA.clip, 'the copy is the same text')
  assert.equal(cutBlock(REPRO, 4), null, 'nothing is cut from the fenced line')
  assert.deepEqual(describeClip(cutA.clip), { count: 1, title: 'A', section: false }, 'the clip is one slide')
  const NEWCLIP = J('### New', '{id=new1}', 'new body', '')
  const afterA = pasteSlides(REPRO, NEWCLIP, { after: 1 }, minter())
  assert.equal(afterA.text, J('### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence', '', '### New', '{id=new1}', 'new body', '', '### B'), 'a paste after A lands after its fence and its last line')
  assert.equal(pasteSlides(REPRO, NEWCLIP, { after: 4 }, minter()), null, 'the fenced line is not a place to paste after')
  assert.equal(pasteSlides(REPRO, NEWCLIP, { before: 4 }, minter()), null, 'nor before')
  assert.deepEqual(widenToBlocks(REPRO, 0, '### A'.length), { from: 0, to: REPRO.indexOf('### B'), titles: ['A'] }, 'a selection of A\'s title widens to all of A')
  const inFence = REPRO.indexOf('# install')
  assert.equal(widenToBlocks(REPRO, inFence, inFence + '# install'.length), null, 'a selection of the fenced line is ordinary text')
  assert.equal(touchesTitleLine(REPRO, inFence, inFence + 3), false, 'the fenced `# ` line is not the talk\'s title')
  assert.equal(moveBlock(REPRO, 4, { kind: 'end' }), null, 'the fenced line is not a block to move')
  assert.equal(moveBlock(REPRO, 1, { kind: 'end' }).text, J('### B', '### A', '{id=a}', '```sh', '# install', 'npm i', '```', 'after fence'), 'A moves whole (a tight talk has no blank line to carry)')
  assert.deepEqual(slideRows(REPRO).map((r) => r.text), ['A', 'B'], 'the Slide outline lists A and B, not the fenced line')
  // The outline matches the compiler: listSlideBlocks reads the same two slides.
  assert.deepEqual(listSlideBlocks(REPRO).map((b) => b.start + 1), slideRows(REPRO).map((r) => r.line), 'the compiler\'s slide blocks start on the outline\'s rows')
  // A clip is a text of its own: a fenced id in it is not a slide's id and is left alone.
  const fencedId = reIdCollisions(['### X', '{id=a}', '```', '### Y {id=a}', '```'], new Set(['a']), minter('fresh1'))
  assert.deepEqual(fencedId.lines, ['### X', '{id=fresh1}', '```', '### Y {id=a}', '```'], 'only the slide\'s own id is replaced')
  // An unclosed fence runs to the end of the text: everything after it is A's.
  const open = J('### A', '```', '# x', '### B', 'b')
  assert.equal(blockAt(open, 1).endLine, 6)
  assert.equal(blockAt(open, 4), null)
  assert.deepEqual(startOfTalkPlace(J('# Talk', '```', '## code', '```', 'text', '## One')), { before: 6 }, 'the start of the talk is before the first real section')
  assert.equal(isTalkTitleLine(J('```', '# code', '```', '# Talk'), 2), false)
  assert.equal(isTalkTitleLine(J('```', '# code', '```', '# Talk'), 4), true)
  cases += 24

  // THE PROPERTY: a heading-shaped line in fenced code (or in a comment) behaves exactly as a line
  // of body text does. `plain` is the same talk with those lines written as body text; every
  // operation on the fenced talk gives the plain talk's result, the lines written back.
  // The stand-in lines are as long as the lines they stand for, so offsets are the same in both.
  const CODE = { '# install': 'x install', '## not a section': 'xx not a section', '### inner': 'xxx inner', '### hidden': 'xxx hidden', '# tail': 'x tail' }
  const plainOf = (t) => t.split('\n').map((l) => CODE[l] ?? l).join('\n')
  const FENCED = J('# Talk', '{id=deck}', 'title text', '',
    '## One', '{id=one}', '',
    '### A', '{id=a}', '```sh', '# install', 'npm i', '## not a section', '```', 'after fence', '',
    '### B', '{id=b}', '~~~~md', '### inner', '~~~', 'still code', '~~~~', '',
    '## Two', '{id=two}', '',
    '### C', '{id=c}', '<!--', '### hidden', '-->', 'c body', '',
    '#### C step', 'step', '',
    '### D', '{id=d}', '````', '# tail', '````', '')
  const PLAIN = plainOf(FENCED)
  const deepPlain = (v) => typeof v === 'string' ? plainOf(v) : Array.isArray(v) ? v.map(deepPlain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepPlain(x)])) : v
  assert.notEqual(PLAIN, FENCED)
  const same = (name, f, p) => {
    cases += 1
    assert.deepEqual(deepPlain(f), p, name)
  }
  const n = FENCED.split('\n').length
  const headings = slideRows(FENCED).map((r) => r.line)
  assert.deepEqual(headings, slideRows(PLAIN).map((r) => r.line), 'the same rows in both')
  assert.equal(headings.length, 8)
  for (let line = 1; line <= n; line += 1) {
    same(`blockAt ${line}`, blockAt(FENCED, line), blockAt(PLAIN, line))
    same(`headingLineAt ${line}`, headingLineAt(FENCED, line), headingLineAt(PLAIN, line))
    same(`caretPastePlace ${line}`, caretPastePlace(FENCED, line), caretPastePlace(PLAIN, line))
    same(`cutBlock ${line}`, cutBlock(FENCED, line), cutBlock(PLAIN, line))
    same(`copyBlock ${line}`, copyBlock(FENCED, line), copyBlock(PLAIN, line))
    const cut = cutBlock(FENCED, line)
    if (cut) {
      assert.deepEqual(words(cut.text).concat(words(cut.clip)).sort(), words(FENCED), `cutBlock ${line}: every line is in the talk or the clip`)
      assert.equal(headingLevels(cut.text.split('\n')).filter((l) => l > 0).length + headingLevels(cut.clip.split('\n')).filter((l) => l > 0).length, headings.length, `cutBlock ${line}: no fence is left open (every heading is still a heading)`)
    }
    for (const place of [{ after: line }, { before: line }]) {
      const f = pasteSlides(FENCED, NEWCLIP, place, minter())
      same(`pasteSlides ${JSON.stringify(place)}`, f, pasteSlides(PLAIN, NEWCLIP, place, minter()))
      if (f) assert.deepEqual(words(f.text), words(FENCED + '\n' + NEWCLIP), `pasteSlides ${JSON.stringify(place)}: the talk's lines plus the pasted ones`)
    }
    for (const target of [{ kind: 'start' }, { kind: 'end' }, ...Array.from({ length: n }, (_, k) => [{ kind: 'into', line: k + 1 }, { kind: 'before', line: k + 1 }, { kind: 'after', line: k + 1 }]).flat()]) {
      const f = moveBlock(FENCED, line, target)
      same(`moveBlock ${line} ${JSON.stringify(target)}`, f, moveBlock(PLAIN, line, target))
      if (f) {
        assert.deepEqual(allLines(f.text), allLines(FENCED), `moveBlock ${line} ${JSON.stringify(target)}: the same multiset of lines`)
        assert.equal(f.text.split('\n').findIndex((l) => l === '# Talk'), 0, 'the title is still the first line')
        assert.deepEqual(slideRows(f.text).map((r) => r.text).sort(), slideRows(FENCED).map((r) => r.text).sort(), 'the same slides after the move: no fence was split')
      }
    }
  }
  same('pasteSlides at the end', pasteSlides(FENCED, NEWCLIP, 'end', minter()), pasteSlides(PLAIN, NEWCLIP, 'end', minter()))
  for (let from = 0; from < FENCED.length; from += 7) {
    for (const len of [1, 12, 40, 200]) same(`widenToBlocks ${from}+${len}`, widenToBlocks(FENCED, from, from + len), widenToBlocks(PLAIN, from, from + len))
    same(`touchesTitleLine ${from}`, touchesTitleLine(FENCED, from, from + 12), touchesTitleLine(PLAIN, from, from + 12))
  }

  // Cost: each function reads the heading map once for its text. A talk of 3,000 slides, each with
  // a fenced snippet (24,000 lines), through the functions that walk every line.
  const BIG = Array.from({ length: 3000 }, (_, k) => J(`### Slide ${k}`, `{id=s${k}}`, '```sh', '# install', `npm i pkg-${k}`, '```', 'text', '')).join('\n')
  const t0 = performance.now()
  assert.equal(slideRows(BIG).length, 3000)
  assert.equal(widenToBlocks(BIG, 0, BIG.length).titles.length, 3000)
  assert.equal(describeClip(BIG).count, 3000)
  assert.equal(reIdCollisions(BIG.split('\n'), new Set(), minter()).reIds.length, 0)
  assert.ok(moveBlock(BIG, 1, { kind: 'end' }))
  assert.ok(pasteSlides(BIG, NEWCLIP, { after: 1 }, minter()))
  assert.ok(cutBlock(BIG, 1))
  const took = performance.now() - t0
  assert.ok(took < 3000, `24,000 lines through seven whole-talk functions took ${Math.round(took)} ms (each is a single pass)`)
  cases += 1
}


console.log(`slide block ops: ${cases} cases passed`)
