// Insert section (talk search 07; ADR-0029 §5; frames K4, K6, K7). Seams: the headless operation
// (src/shared/insert-section.ts — extractSection, insertSection) over fixture outlines, and the
// picker's row model for the button (slideBrowserModel sectionInsertSource). Imports the real modules
// (Node strips their erasable TypeScript). Structure is checked against the real compiler: the
// headings the operation reads, and every inserted talk, are compiled (prepareSource) and the slide
// list asserted. The picker no longer calls the operation (Dominik, 0.34.0-preview.8 check, 28 Sep:
// the heading button selects the section instead, e2e/diagnose-select-section.mjs); it stays as the
// headless verb and the editor seam, tested here.
import { strict as assert } from 'node:assert'
import { extractSection, insertSection, readOutline, sectionLevelOf } from '../src/shared/insert-section.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { reLevelHeadingLines } from '../src/shared/heading-relevel.ts'
import { sectionInsertSource, sectionSelectionKeys, selectSectionLabel } from '../src/renderer/src/components/slideBrowserModel.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { insertSectionIntoOpenTalk } from '../src/renderer/src/lib/sectionInsert.ts'

let passed = 0
const ok = (name) => { passed += 1; console.log(`PASS ${name}`) }
// The compiled slide list of an outline: `level title` per authored slide (synthesized cover and
// closing slides have no source line), `#` lines never among them. A frontmatter block is prepended
// when the text has none, so the heading-slide (v2) adapter reads it, as it does every talk here.
const FILE = { isDirectory: () => false }
async function compiledSlides(text) {
  const src = text.startsWith('---') ? text : `---\ntitle: Probe\n---\n\n${text}`
  const model = await prepareSource('/tmp/insert-section-probe.md', src, null, FILE)
  assert.equal(model.adapter, 'markdown-outline-v2')
  return model.slides.filter((s) => typeof s.sourceLine === 'number').map((s) => `${s.nodeLevel} ${s.title}`)
}
// The compiler's heading lines (1-based) of a v2 outline, straight from the compiled slides.
async function compiledHeadingLines(text) {
  const model = await prepareSource('/tmp/insert-section-probe.md', text, null, FILE)
  return model.slides.filter((s) => typeof s.sourceLine === 'number').map((s) => s.sourceLine)
}
const readHeadingLines = (text) => readOutline(text).levels.flatMap((l, i) => (l >= 2 ? [i + 1] : []))
const lineOf = (text, heading) => text.split('\n').indexOf(heading) + 1
const extract = (text, heading) => extractSection(text, { line: lineOf(text, heading), heading })
// The result is the original with exactly one insertion: removing [at, at+len) gives the original back.
function onlyInserted(before, after) {
  let p = 0
  while (p < before.length && before[p] === after[p]) p += 1
  const len = after.length - before.length
  assert.ok(len > 0, 'something was inserted')
  assert.equal(after.slice(0, p) + after.slice(p + len), before, 'nothing but one insertion changed')
}

// ── source talk: "The current state of AI agents" (K6's source), every awkward shape ──
const source = [
  '---',
  'title: The current state of AI agents',
  '# not a heading, frontmatter',
  '---',
  '',
  '# The current state of AI agents',
  '',
  '## Intro',
  '{id=intro}',
  '',
  'Opening words.',
  '',
  '## More practical examples',
  '{id=mpe}{accent=blue}',
  '',
  '### What you can do with this',
  '{id=wyc}',
  '',
  '![Chart](assets/chart.png)',
  '',
  '```markdown',
  '## Fenced heading stays',
  '```',
  '',
  ':::notes',
  'Say this slowly.',
  ':::',
  '',
  '### Follow-up prompts',
  '',
  '~~~~',
  '# tilde fenced stays',
  '~~~',
  '## still fenced (close must be as long)',
  '~~~~',
  '',
  '#### York expenses: from email to completed forms',
  '{id=york}',
  '',
  '````md',
  '```',
  '## inside a 4-backtick wrapper',
  '```',
  '````',
  '',
  '<!-- ## commented heading stays -->',
  '',
  '## Headless',
  '{id=headless}',
  '',
  '## Last one',
  '',
  '### Final slide',
  'Bye.',
  '',
  '',
].join('\n')

const MPE = [
  '## More practical examples',
  '{id=mpe}{accent=blue}',
  '',
  '### What you can do with this',
  '{id=wyc}',
  '',
  '![Chart](assets/chart.png)',
  '',
  '```markdown',
  '## Fenced heading stays',
  '```',
  '',
  ':::notes',
  'Say this slowly.',
  ':::',
  '',
  '### Follow-up prompts',
  '',
  '~~~~',
  '# tilde fenced stays',
  '~~~',
  '## still fenced (close must be as long)',
  '~~~~',
  '',
  '#### York expenses: from email to completed forms',
  '{id=york}',
  '',
  '````md',
  '```',
  '## inside a 4-backtick wrapper',
  '```',
  '````',
  '',
  '<!-- ## commented heading stays -->',
].join('\n')

// ── extraction ──
{
  const r = extract(source, '## More practical examples')
  assert.equal(r.ok, true)
  assert.equal(r.markdown, MPE, 'fenced, tilde, 4-backtick and commented headings are not boundaries; Trigger lines, notes and blank lines travel with their slide')
  assert.equal(r.level, 2)
  assert.equal(r.slides, 4, 'the heading slide plus 3 slides under it (####  nested included)')
  ok('extract: a section with fences, notes, nested #### and an image, byte for byte')

  const headless = extract(source, '## Headless')
  assert.deepEqual(headless, { ok: true, markdown: '## Headless\n{id=headless}', level: 2, slides: 1, line: lineOf(source, '## Headless') })
  ok('extract: a section with no slides under its heading')

  const last = extract(source, '## Last one')
  assert.equal(last.markdown, '## Last one\n\n### Final slide\nBye.', 'the talk’s last section, trailing blank lines dropped')
  assert.equal(last.slides, 2)
  ok('extract: the last section of a talk')

  const sub = extract(source, '### What you can do with this')
  assert.ok(sub.markdown.startsWith('### What you can do with this') && sub.markdown.endsWith(':::'), 'a ### section ends at the next ### (Follow-up prompts)')
  assert.equal(sub.slides, 1)
  ok('extract: a nested section ends at its next sibling')

  // The talk was edited since it was indexed: the heading moved down two lines.
  const moved = '\n\n' + source
  const r2 = extractSection(moved, { line: lineOf(source, '## More practical examples'), heading: '## More practical examples' })
  assert.equal(r2.ok && r2.markdown, MPE, 'found again by its heading text')
  const gone = extractSection(source, { line: 13, heading: '## Not here' })
  assert.equal(gone.ok, false)
  assert.match(gone.error, /no longer in its talk.*Nothing was inserted/)
  const twice = extractSection(source + '\n## Intro\n', { line: 2, heading: '## Intro' })
  assert.equal(twice.ok, false)
  assert.match(twice.error, /more than one section headed “Intro”/)
  const fencedOnly = extractSection(source, { line: lineOf(source, '## Fenced heading stays'), heading: '## Fenced heading stays' })
  assert.equal(fencedOnly.ok, false, 'a heading-shaped line in a fence is never a section')
  ok('extract: a moved heading is found by its text; a missing, doubled or fenced one refuses with a message')
}

// ── the reading is the compiler's: heading lines agree with the compiled slides' source lines ──
{
  const shapes = [
    source,
    // `##` inside :::notes ends the notes and is a slide (the compiler's rule); an unclosed notes block too.
    '---\ntitle: N\n---\n\n## S\n\n:::notes\n## note heading\nsay it\n:::\n\n### sub\n\n:::notes\nopen\n## After open notes\n',
    // A multi-line HTML comment hides its heading; a comment inside a fence is still blanked first.
    '---\ntitle: C\n---\n\n## S\n\n<!--\n## hidden\n-->\n\n```\n<!-- x -->\n## fenced\n```\n\n## T\n',
    // An unterminated <!-- hides nothing; an unclosed fence swallows every heading after it.
    '---\ntitle: U\n---\n\n## S\n\n<!-- never closed\n\n## Seen\n\n~~~\n## swallowed\n\n## also swallowed\n',
    // # lines (title and closing) are never slides; CRLF line endings; a 7-hash line is no heading.
    '---\r\ntitle: R\r\n---\r\n\r\n# Talk\r\n\r\n## A\r\n\r\n####### seven\r\n\r\n### a1\r\n\r\n# Thanks\r\n',
  ]
  for (const text of shapes) {
    assert.deepEqual(readHeadingLines(text), await compiledHeadingLines(text), `heading lines agree with the compiler for ${JSON.stringify(text.slice(0, 40))}`)
  }
  const r = readOutline('---\na: 1\n---\n# T\n## A\n```\n## f\n```\n<!-- ## c -->\n:::notes\n## n\n:::\n')
  assert.deepEqual(r.levels, [0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 2, 0, 0])
  assert.equal(r.bodyStart, 3)
  assert.equal(readOutline('## S\n```\ncode').openFence, true)
  assert.equal(readOutline('## S\n<!-- open').openComment, true)
  assert.equal(readOutline('## S\n<!-- closed -->').openComment, false)
  ok('reading: heading lines are the compiled slides\' source lines (notes, comments, fences, # lines, CRLF)')
  assert.deepEqual(reLevelHeadingLines(['## a', '```', '## b', '```', '###### c'], -1, [false, true, true, true, false]),
    ['# a', '```', '## b', '```', '##### c'])
  ok('re-level: the shared helper leaves masked lines alone')
}

// ── target talk: "The Age of the Claw" (K6/K7) ──
const target = [
  '---',
  'title: The Age of the Claw',
  '---',
  '',
  '# The Age of the Claw',
  '',
  '## A new section',
  '{id=ans}',
  '',
  '### What is actually Balakrishnan using?',
  '{id=bal}',
  '',
  '### Test slide',
  '{id=ts}',
  '',
  'Body of the test slide.',
  '',
  '### Test html',
  '{id=th}',
  '',
  '## About me',
  '{id=about}',
  '',
  '### AI Trends Tracking',
  '{id=trends}',
  '',
].join('\n')
const mpe = extract(source, '## More practical examples').markdown

// K6: caret at the end of "A new section" (end of the Test html Trigger line) → at the caret.
{
  const caret = target.indexOf('{id=th}') + '{id=th}'.length
  const r = insertSection({ text: target, caret, section: mpe })
  assert.equal(r.ok, true)
  const expected = target.slice(0, caret) + '\n\n' + mpe + target.slice(caret)
  assert.equal(r.text, expected, 'inserted at the caret with a blank line before; the existing blank line follows')
  onlyInserted(target, r.text)
  assert.equal(r.text.slice(r.from, r.to), mpe)
  assert.equal(r.level, 2)
  assert.equal(r.text.split('\n')[r.line - 1], '## More practical examples')
  ok('K6: caret at a section’s end — inserted at the caret, nothing else changed')

  // Caret on the blank line after the section's last content: still at the caret.
  const blank = target.indexOf('{id=th}\n') + '{id=th}\n'.length
  const r2 = insertSection({ text: target, caret: blank, section: mpe })
  assert.equal(r2.text, target.slice(0, blank) + '\n' + mpe + '\n' + target.slice(blank))
  onlyInserted(target, r2.text)
  ok('K6: caret on the blank line ending a section — inserted there')
}

// K7: caret after "Test slide" (mid-section) → after the end of "A new section".
{
  const caret = target.indexOf('### Test slide') + '### Test slide'.length
  const r = insertSection({ text: target, caret, section: mpe })
  const at = target.indexOf('## About me')
  assert.equal(r.text, target.slice(0, at) + mpe + '\n\n' + target.slice(at))
  onlyInserted(target, r.text)
  assert.ok(r.text.indexOf('### Test html') < r.text.indexOf('## More practical examples'), 'the caret’s section stays whole')
  ok('K7: caret mid-section — inserted after the end of that section')

  // Caret in the middle of the last line's words is not at the end either.
  const mid = target.indexOf('Body of the') + 4
  assert.equal(insertSection({ text: target, caret: mid, section: mpe }).text, r.text)
  ok('K7: caret inside a paragraph — after the end of the section')
}

// Caret in the talk's first and last sections.
{
  const inAbout = target.indexOf('### AI Trends') + 3
  const r = insertSection({ text: target, caret: inAbout, section: mpe })
  assert.equal(r.text, target + '\n' + mpe + '\n', 'the last section: appended after it, a blank line before and the file’s final newline still final')
  onlyInserted(target, r.text)
  ok('caret in the talk’s last section (mid-section) — appended at the end, final newline kept')

  const atEnd = insertSection({ text: target, caret: target.length, section: mpe })
  assert.equal(atEnd.text, target + '\n' + mpe + '\n')
  const noFinal = target.replace(/\n$/, '')
  assert.equal(insertSection({ text: noFinal, caret: noFinal.length, section: mpe }).text, noFinal + '\n\n' + mpe, 'a file without a final newline does not gain one')
  ok('caret at the very end of the talk')

  const inFirst = insertSection({ text: target, caret: target.indexOf('{id=ans}'), section: mpe })
  const at = target.indexOf('## About me')
  assert.equal(inFirst.text, target.slice(0, at) + mpe + '\n\n' + target.slice(at))
  ok('caret in the talk’s first section — after its end')

  const inTitle = insertSection({ text: target, caret: target.indexOf('# The Age') + 2, section: mpe })
  const first = target.indexOf('## A new section')
  assert.equal(inTitle.text, target.slice(0, first) + mpe + '\n\n' + target.slice(first), 'above the first section: before it')
  const inFm = insertSection({ text: target, caret: 5, section: mpe })
  assert.equal(inFm.text, inTitle.text, 'the caret in the frontmatter never inserts into it')
  ok('caret above the first section (deck title, frontmatter) — before the first section')
}

// `#` lines (decided 2026-09-28): the compiler reads every `#` line as the deck title, so `#` is never a
// section level. A talk with `# Part` lines and `##` sections takes the section as `##`; the # lines stay.
{
  const t1 = '# My talk\n\n## A\n\na1\n\na2 here\n\n## B\n\nb\n\n# Thanks\n'
  assert.equal(sectionLevelOf(t1), 2, 'two # lines do not make # the section level')
  const section = '## Moved\n\nbody\n\n### Child\n\nchild body'
  const r = insertSection({ text: t1, caret: t1.indexOf('here'), section })
  assert.equal(r.ok, true)
  assert.equal(r.level, 2)
  assert.equal(r.text, t1.replace('## B', section + '\n\n## B'), 'after the end of § A, at ##, nothing re-levelled')
  assert.deepEqual(await compiledSlides(r.text), ['2 A', '2 Moved', '3 Child', '2 B'], 'compiled: the section and its child are slides, no # line is')
  // Caret at the end of the last section, which a "# Thanks" line closes: at the caret, # Thanks stays last.
  const r2 = insertSection({ text: t1, caret: t1.indexOf('\nb\n') + 2, section })
  assert.equal(r2.text, t1.replace('# Thanks', section + '\n\n# Thanks'))
  assert.deepEqual(await compiledSlides(r2.text), ['2 A', '2 B', '2 Moved', '3 Child'])
  ok('# lines: two # lines and ## sections — the section arrives as ##; # Thanks stays after it (compiled)')

  // probe 3's shape: # Part one / ## p1a / ## p1b / # Part two / ## p2a, caret mid p1a.
  const parts = '# Part one\n\n## p1a\n\nx here\n\n## p1b\n\ny\n\n# Part two\n\n## p2a\n\nz\n'
  const moved = '## Moved\n{id=mpe01}{accent=blue}\n\nWhy these matter.\n\n### Child\n{id=c1}\n\nchild'
  const r3 = insertSection({ text: parts, caret: parts.indexOf('here'), section: moved })
  assert.equal(r3.level, 2)
  assert.equal(r3.text, parts.replace('## p1b', moved + '\n\n## p1b'), 'the Trigger lines stay under their headings')
  const compiled3 = await compiledSlides(r3.text)
  assert.deepEqual(compiled3, ['2 p1a', '2 Moved', '3 Child', '2 p1b', '2 p2a'], 'compiled: Moved is a ## slide with its child; no # line became a slide')
  const model3 = await prepareSource('/tmp/p3.md', '---\ntitle: P\n---\n\n' + r3.text, null, FILE)
  const movedSlide = model3.slides.find((sl) => sl.title === 'Moved')
  assert.equal(movedSlide.id, 'mpe01', 'the Trigger line is still read as Moved’s')
  assert.equal(movedSlide.section, 'mpe01', 'Moved is a section of its own')
  assert.equal(model3.slides.find((sl) => sl.title === 'Child').section, 'mpe01', 'and Child is in it')
  ok('# lines: probe 3 — # Part one / # Part two talk takes the section as ## (compiled)')

  // A ## section into a talk whose sections are ### under # parts: +1, depth inside kept, # untouched.
  const deepParts = '# Part one\n\n### One a\n\nFirst.\n\n### One b\n\n# Part two\n\n### Two a\n'
  const r4 = insertSection({ text: deepParts, caret: deepParts.indexOf('First.') + 3, section: mpe })
  assert.equal(r4.level, 3)
  const inserted = r4.text.slice(r4.from, r4.to).split('\n')
  const expected = mpe.split('\n').map((l) => ({
    '## More practical examples': '### More practical examples',
    '### What you can do with this': '#### What you can do with this',
    '### Follow-up prompts': '#### Follow-up prompts',
    '#### York expenses: from email to completed forms': '##### York expenses: from email to completed forms',
  }[l] ?? l))
  assert.deepEqual(inserted, expected, '## → ###, ### → ####, #### → #####; fenced and commented headings untouched')
  assert.equal(r4.text, deepParts.replace('### One b', expected.join('\n') + '\n\n### One b'))
  assert.deepEqual(await compiledSlides(r4.text), [
    '3 One a', '3 More practical examples', '4 What you can do with this', '4 Follow-up prompts',
    '5 York expenses: from email to completed forms', '3 One b', '3 Two a',
  ])
  ok('re-level: a ## section into ### sections under # parts arrives as ###, depth kept (compiled)')

  // A `#` line is never a section and never travels in one.
  const titled = '# Deck\n\n## A\n\na\n'
  const asTitle = extractSection(titled, { line: 1, heading: '# Deck' })
  assert.equal(asTitle.ok, false)
  assert.match(asTitle.error, /title line.*not a section/)
  assert.match(insertSection({ text: titled, caret: 0, section: '# Deck\n\n## A' }).error, /title line.*not a section/)
  const carries = insertSection({ text: titled, caret: titled.length, section: '## S\n\n# Other title\n\ntext' })
  assert.equal(carries.ok, false)
  assert.match(carries.error, /talk title line in it.*“# Other title”.*Nothing was inserted/)
  assert.equal(extract('## Last\n\nbye\n\n# Thanks\n', '## Last').markdown, '## Last\n\nbye', 'a closing # line is left behind')
  ok('# lines: never a section, never carried into another talk')
}

// Re-levelling depth and the section level.
{
  // Deeper: a ## section into a talk whose sections are ### → +1, and #### becomes #####.
  const deep = '### S1\n\ntext\n\n### S2\n'
  const r2 = insertSection({ text: deep, caret: deep.indexOf('text') + 4, section: mpe })
  assert.equal(r2.level, 3)
  assert.match(r2.text, /^### More practical examples$/m)
  assert.match(r2.text, /^##### York expenses/m)
  assert.match(r2.text, /^## Fenced heading stays$/m)
  ok('re-level: deeper by one, fenced headings untouched')

  // Too deep: the #### would need ####### — refused, never clamped.
  const tooDeep = '##### S1\n\ntext\n\n##### S2\n'
  const r3 = insertSection({ text: tooDeep, caret: 3, section: mpe })
  assert.equal(r3.ok, false)
  assert.match(r3.error, /would need #######.*Nothing was inserted/)
  ok('re-level: a section that cannot keep its depth is refused with a message')

  assert.equal(sectionLevelOf(target), 2)
  const noSections = 'Just some notes.\n'
  const r4 = insertSection({ text: noSections, caret: 3, section: mpe })
  assert.equal(r4.text, noSections + '\n' + mpe + '\n')
  assert.equal(r4.level, 2)
  ok('section level: a lone # is the deck title; a talk with no headings takes ## at its end')

  // A CRLF source: its headings are re-levelled too (line endings as the editor holds them, \n).
  const r5 = insertSection({ text: deep, caret: deep.indexOf('text') + 4, section: '## C\r\n\r\nc\r\n\r\n### D\r\n' })
  assert.equal(r5.text.slice(r5.from, r5.to), '### C\n\nc\n\n#### D')
  ok('re-level: a CRLF section is re-levelled like any other')
}

// The compiler's headings in the TARGET: fenced ones are not boundaries; a ## inside :::notes is one.
{
  const t = '## Real\n\n```\n## fake\n```\n\nreal body\n'
  const r = insertSection({ text: t, caret: t.indexOf('fake'), section: '## New\n\n### Child' })
  assert.equal(r.text, t + '\n## New\n\n### Child\n', 'the caret inside the fence is inside “Real”; the fenced heading does not end it')
  const n = '## Real\n\n:::notes\n## Notes heading\nsaid\n:::\n\n## Next\n'
  const rn = insertSection({ text: n, caret: n.indexOf('said'), section: '## New' })
  assert.equal(rn.text, n.replace('## Next', '## New\n\n## Next'), 'the notes heading is a section of its own (the compiler ends the notes there)')
  assert.deepEqual(await compiledSlides(rn.text), ['2 Real', '2 Notes heading', '2 New', '2 Next'])
  // Extracting: a ## inside the section's notes ends it, as the compiled slides do.
  const src2 = '## S\n\ns body\n\n:::notes\n## note heading\nsay it\n:::\n\n### sub\n\nx\n\n## Next\n'
  const e2 = extractSection(src2, { line: 1, heading: '## S' })
  assert.equal(e2.markdown, '## S\n\ns body\n\n:::notes')
  assert.equal(e2.slides, 1)
  // Moving levels never touches a heading the compiler does not read (in a fence or a closed comment).
  const src3 = '## S\n\n<!--\n## hidden\n-->\n\n```\n## code\n```\n\n### sub\n'
  const e3 = extractSection(src3, { line: 1, heading: '## S' })
  assert.equal(e3.slides, 2)
  const r3 = insertSection({ text: '### A\n\na\n', caret: 9, section: e3.markdown })
  assert.equal(r3.text.slice(r3.from, r3.to), '### S\n\n<!--\n## hidden\n-->\n\n```\n## code\n```\n\n#### sub')
  assert.deepEqual(await compiledSlides(r3.text), ['3 A', '3 S', '4 sub'])
  ok('target and source: headings are the compiler’s — fenced and commented ones are not, notes ones are (compiled)')
}

// A section still open at its end would swallow the talk after it: refused, nothing written.
{
  const talk = '# T\n\n## A\n\na\n\n## B\n\nb <!-- note -->\n'
  const fence = extractSection('## Code\n\n```js\nconst a = 1\n\n## Next\n\nmore\n', { line: 1, heading: '## Code' })
  assert.equal(fence.ok && fence.slides, 1, 'the compiler reads the unclosed fence to the end: one slide')
  const rf = insertSection({ text: talk, caret: talk.indexOf('a\n'), section: fence.markdown })
  assert.equal(rf.ok, false)
  assert.match(rf.error, /“Code” ends inside a code fence that is never closed.*Nothing was inserted/)
  const rc = insertSection({ text: talk, caret: talk.indexOf('a\n'), section: '## Comment\n\n<!-- never closed\n\nmore' })
  assert.equal(rc.ok, false)
  assert.match(rc.error, /HTML comment \(<!--\) that is never closed.*Nothing was inserted/)
  // The talk itself open where the section would go: the result would not read as it should.
  const open = '## A\n\n```\ncode\n\n## B\n'
  const ro = insertSection({ text: open, caret: 5, section: '## S\n\nbody' })
  assert.equal(ro.ok, false)
  assert.match(ro.error, /would change how the rest of this talk reads.*Nothing was inserted/)
  ok('refusals: a section with an open fence or comment, or a talk open where it would go')
}

// Bad input refuses.
{
  assert.equal(insertSection({ text: target, caret: -1, section: mpe }).ok, false)
  assert.equal(insertSection({ text: target, caret: target.length + 1, section: mpe }).ok, false)
  assert.equal(insertSection({ text: target, caret: 0, section: 'no heading here' }).ok, false)
  ok('refusals: a caret outside the talk, a section without a heading')
}

// ── the picker's button: N and the heading from the whole talk's rows ──
{
  const row = (order, section, source_line, md, extra = {}) => ({
    talkSlug: 'cs', outlinePath: '/v/cs/cs-outline.md', order, section, source_line, source_markdown: md, ...extra,
  })
  const rows = [
    row(0, '', null, ''), // synthesized title slide
    row(1, 'intro', 8, '## Intro\n{id=intro}'),
    row(3, 'mpe', 16, '### What you can do with this'),
    row(2, 'mpe', 13, '## More practical examples\n{id=mpe}'),
    row(4, 'mpe', 30, '### Follow-up prompts'),
    row(5, 'mpe', 38, '#### York expenses'),
    row(6, 'mpe', 30, '### Follow-up prompts', { role: 'grid-return' }), // a container's return slide
    row(7, 'headless', 49, '## Headless'),
    { ...row(8, 'mpe', 13, '## Other talk'), talkSlug: 'other' },
  ]
  assert.deepEqual(sectionInsertSource(rows, 'cs', 'mpe'), {
    talkSlug: 'cs', outlinePath: '/v/cs/cs-outline.md', line: 13, heading: '## More practical examples', slides: 4,
  })
  assert.equal(sectionInsertSource(rows, 'cs', 'headless').slides, 1)
  assert.equal(sectionInsertSource(rows, 'cs', ''), null, 'the unsectioned chunk has no button')
  assert.equal(sectionInsertSource(rows, 'cs', 'nope'), null)
  // Dominik, 0.34.0-preview.8 check (28 Sep): the heading button selects the section, it does not insert it.
  assert.equal(selectSectionLabel(4), 'Select section · 4 slides')
  assert.equal(selectSectionLabel(1), 'Select section · 1 slide')
  ok('picker: N counts the heading slide and every slide under it, once each')

  // Select section: the N slides the button names, as selection keys (talkSlug:slide_id), heading
  // slide first and then in source order, one key per slide (the return slide shares its line).
  const withIds = rows.map((r, i) => ({ ...r, slide_id: `s${i}` }))
  assert.deepEqual(sectionSelectionKeys(withIds, 'cs', 'mpe'), ['cs:s3', 'cs:s2', 'cs:s4', 'cs:s5'],
    'the heading slide and every slide under it, in source order, once each')
  assert.equal(sectionSelectionKeys(withIds, 'cs', 'mpe').length, sectionInsertSource(withIds, 'cs', 'mpe').slides,
    'the selection is exactly the N slides the button names')
  assert.deepEqual(sectionSelectionKeys(withIds, 'cs', 'headless'), ['cs:s7'])
  assert.deepEqual(sectionSelectionKeys(withIds, 'cs', ''), [], 'the unsectioned chunk selects nothing')
  assert.deepEqual(sectionSelectionKeys(withIds, 'cs', 'nope'), [])
  assert.deepEqual(sectionSelectionKeys(withIds, 'other', 'mpe'), ['other:s8'], 'a same-named section in another talk is its own; neither joins the other')
  ok('picker: Select section takes the whole section’s slides, heading slide first, in source order')

  // Review probe 2: rows a search left (only a slide under the heading) are not the section. The
  // lowest row is "### Child two", not the section's own ## heading slide, so there is no button —
  // it would have inserted one sub-slide while claiming the section.
  const filtered = [{ talkSlug: 't', section: 'sec', source_line: 11, source_markdown: '### Child two {id=c2}\n\nbar query', outlinePath: '/x' }]
  assert.equal(sectionInsertSource(filtered, 't', 'sec'), null, 'no heading slide in the rows: no button')
  const deckTitleOnly = [{ talkSlug: 't', section: 'sec', source_line: 1, source_markdown: '# Title', outlinePath: '/x' }]
  assert.equal(sectionInsertSource(deckTitleOnly, 't', 'sec'), null, 'a # line is never a section heading')
  ok('picker: no button unless the rows hold the section’s own ## heading slide (review probe 2)')
}

// ── the open-talk flow: one-writer seam, no partial write ──
{
  const PATH = '/v/claw/claw-outline.md'
  const SRC = '/v/cs/cs-outline.md'
  function harness({ saveOk = true, materialize, extract, open = true } = {}) {
    const state = { buffer: target, caret: target.indexOf('{id=th}') + '{id=th}'.length, writes: [], applies: 0 }
    const mutator = createOutlineMutator({
      bufferFor: (p) => (open && p === PATH ? {
        read: () => state.buffer,
        apply: (_p, next) => { state.applies += 1; state.buffer = next; return next },
        adopt: () => {},
      } : null),
      settled: async () => {},
      write: async (_p, text) => { state.writes.push(text); return saveOk ? { ok: true } : false },
    })
    const deps = {
      targetPath: () => PATH,
      extract: extract ?? (async (src, at) => (src === SRC ? extractSection(source, at) : { ok: false, error: 'wrong talk' })),
      materialize: materialize ?? (async (_src, md) => ({ success: true, markdown: md.replace('assets/chart.png', 'img-abc1234') })),
      readEditor: (p) => (p === PATH ? { text: state.buffer, caret: state.caret } : null),
      apply: (p, mutate) => mutator.apply(p, mutate),
    }
    return { state, deps }
  }
  const req = { sourceOutlinePath: SRC, line: lineOf(source, '## More practical examples'), heading: '## More practical examples', label: 'More practical examples' }

  const h = harness()
  const r = await insertSectionIntoOpenTalk(req, h.deps)
  const withPool = mpe.replace('assets/chart.png', 'img-abc1234')
  const expected = target.slice(0, h.state.caret) + '\n\n' + withPool + target.slice(h.state.caret)
  assert.equal(r.ok, true)
  assert.equal(r.slides, 4)
  assert.equal(h.state.applies, 1, 'one change into the buffer')
  assert.deepEqual(h.state.writes, [expected], 'saved once, from the buffer, with the pooled image ref')
  ok('flow: extract → pool the images → one buffer change → one save')

  for (const [name, opts, pattern] of [
    ['the section is gone from its talk', { extract: async () => ({ ok: false, error: 'The section “X” is no longer in its talk as the picker saw it. Nothing was inserted; reopen the picker and try again.' }) }, /no longer in its talk/],
    ['reading the source throws', { extract: async () => { throw new Error('EACCES') } }, /could not be read from its talk \(EACCES\)/],
    ['the images cannot be copied', { materialize: async (_s, md) => ({ success: false, markdown: md, error: 'No vault root' }) }, /images in “More practical examples” could not be copied.*No vault root.*Nothing was inserted/],
    ['no talk is open in the editor', { open: false }, /No talk is open/],
  ]) {
    const x = harness(opts)
    const out = await insertSectionIntoOpenTalk(req, x.deps)
    assert.equal(out.ok, false, name)
    assert.equal(out.applied, false, name)
    assert.match(out.error, pattern, name)
    assert.equal(x.state.buffer, target, `${name}: the buffer is unchanged`)
    assert.deepEqual(x.state.writes, [], `${name}: nothing written`)
  }
  // A re-level that cannot keep depth refuses inside the mutation: nothing applied, nothing written.
  const deepTalk = harness()
  deepTalk.state.buffer = '##### S1\n\ntext\n\n##### S2\n'
  deepTalk.state.caret = 3
  const deepOut = await insertSectionIntoOpenTalk(req, deepTalk.deps)
  assert.equal(deepOut.ok, false)
  assert.match(deepOut.error, /would need #######/)
  assert.equal(deepTalk.state.applies, 0)
  assert.deepEqual(deepTalk.state.writes, [])
  ok('flow: every refusal leaves the buffer and the file untouched, with a readable message')

  // The person switches talks while the section is being read: refused as a switch, nothing written.
  for (const when of ['extract', 'apply']) {
    const sw = harness()
    let open = PATH
    sw.deps.targetPath = () => open
    if (when === 'extract') {
      sw.deps.extract = async (_src, at) => { open = '/v/other/other-outline.md'; return extractSection(source, at) }
    } else {
      // The seam finds the target gone (the switch landed after the check, during its settle).
      sw.deps.apply = async () => {
        open = '/v/other/other-outline.md'
        return { ok: false, reason: 'not-open', error: 'not open', applied: false }
      }
    }
    const out = await insertSectionIntoOpenTalk(req, sw.deps)
    assert.equal(out.ok, false, when)
    assert.match(out.error, /open talk changed while the section was being read.*Nothing was inserted/, `${when}: says the target talk changed`)
    assert.doesNotMatch(out.error, /No talk is open/, when)
    assert.equal(sw.state.buffer, target)
    assert.deepEqual(sw.state.writes, [])
  }
  ok('flow: a talk switch during the insert says the talk changed, and writes nothing')

  const failing = harness({ saveOk: false })
  const saveOut = await insertSectionIntoOpenTalk(req, failing.deps)
  assert.equal(saveOut.ok, false)
  assert.equal(saveOut.applied, true, 'the section is in the editor, undoable')
  assert.match(saveOut.error, /could not be saved to disk/)
  ok('flow: a failed save says so, and the change stays undoable in the editor')
}

console.log(`PASS insert section (${passed} checks)`)
