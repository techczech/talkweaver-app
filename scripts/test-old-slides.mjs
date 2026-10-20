// Reuse of an old slide (ticket 12): the one-slide conversion (old slide record -> TalkWeaver slide
// Markdown through the PowerPoint import's own rules), the insertion "after the current slide", and the
// drawer's choice state. Slides and names are invented.
import assert from 'node:assert/strict'
import { pollDirectivesFor } from '../compiler/scripts/lib/poll-authoring.mjs'
import { bodyLinesOf, canBuildEditable, insertedAsOneSlide, insertSlideAfterCaret, oldSlideMarkdown, OLD_SLIDE_REFUSED } from '../src/shared/old-slide.ts'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import {
  CHOICE_COPY, choiceFor, choiceKeyAction, DRAWER_COPY
} from '../src/renderer/src/components/imageDrawerModel.ts'

// --- conversion: a list slide with two pictures worth keeping and a picture-led slide
const listSlide = {
  title: 'Three layers of AI literacy',
  paragraphs: ['Three layers of AI literacy', 'Knowing what it is good at', 'Knowing when to check', 'Knowing whose work it is'],
  notes: 'Ask the room which layer they find hardest.',
  images: [],
  slideNumber: 7
}
const md1 = oldSlideMarkdown(listSlide, {})
assert.equal(md1, [
  '### Three layers of AI literacy',
  '{list}',
  '',
  '- Knowing what it is good at',
  '- Knowing when to check',
  '- Knowing whose work it is',
  '',
  ':::notes',
  'Ask the room which layer they find hardest.',
  ':::'
].join('\n'), 'title, bullets, notes; the title line is not repeated as a bullet')
assert.ok(!/\{id=/.test(md1), 'no id: the talk mints its own')
assert.ok(md1.startsWith('### Three layers of AI literacy\n'))
assert.ok(!md1.includes('- Three layers'))

const picSlide = {
  title: 'Survey results at a glance',
  paragraphs: ['Survey results at a glance', 'Most staff use it weekly'],
  images: [{ key: 'img-a', thumbUrl: 'twarchive://a', name: 'Chart of weekly use' }, { key: 'img-b', thumbUrl: 'twarchive://b', name: 'Quote card' }],
  slideNumber: 12
}
const md2 = oldSlideMarkdown(picSlide, { 'img-a': 'img-1111', 'img-b': 'img-2222' })
assert.ok(md2.startsWith('### Survey results at a glance\n'))
assert.ok(md2.includes('Most staff use it weekly'), 'text kept')
assert.ok(md2.includes('![Chart of weekly use](img-1111)') && md2.includes('![Quote card](img-2222)'), 'both images referenced by their imported ids')
assert.ok(!md2.includes('{id='))
const single = oldSlideMarkdown({ ...picSlide, images: [picSlide.images[0]] }, { 'img-a': 'img-1111' })
assert.ok(single.includes('![Chart of weekly use](img-1111)'))
assert.equal(oldSlideMarkdown(picSlide, { 'img-a': 'img-1111' }).includes('img-b'), false, 'an image that did not import is left out')
assert.equal(oldSlideMarkdown({ title: 'Thanks', paragraphs: ['Thanks'], images: [], slideNumber: 24 }, {}).split('\n')[0], '### Thanks')
assert.ok(oldSlideMarkdown({ title: 'A [draft] *title*', paragraphs: [], images: [], slideNumber: 1 }, {}).startsWith('### A [draft] \\*title\\*'), 'markdown characters are escaped like the importer does')

assert.deepEqual(bodyLinesOf({ title: 'T', paragraphs: ['t', '  ', 'x'] }), ['x'])
assert.equal(canBuildEditable({ title: 'T', paragraphs: ['T'], images: [], slideNumber: 1 }), false, 'title only: nothing to edit')
assert.equal(canBuildEditable({ title: 'T', paragraphs: [], images: [{ key: 'k', thumbUrl: 'u' }], slideNumber: 1 }), true)
assert.equal(canBuildEditable(listSlide), true)

// --- placement: after the current slide
const talk = [
  '---', 'title: "Staff briefing"', '---', '',
  '## Opening', '',
  '### Where we are now', '', '- one', '', ':::notes', 'say hello', ':::', '',
  '### Who this is for', '', '- two', '',
  '## Close', '',
  '### Thanks', '',
  '# Staff briefing', ''
].join('\n')
const NEW = '### Added slide\n\n- fresh'
const at = (marker) => talk.indexOf(marker) + 1
let r = insertSlideAfterCaret({ text: talk, caret: at('- one'), slide: NEW })
assert.ok(r.ok)
assert.ok(r.text.includes(':::\n\n### Added slide\n\n- fresh\n\n### Who this is for'), 'after the slide and its notes, before the next slide')
assert.equal(r.level, 3)
assert.equal(r.text.replace(NEW + '\n\n', '').replace(/\n\n\n/g, '\n\n'), talk.replace(/\n\n\n/g, '\n\n'), 'nothing else changed')
assert.equal(r.text.slice(r.from, r.to), NEW)
// caret on a heading line, and in the notes
assert.ok(insertSlideAfterCaret({ text: talk, caret: at('### Where'), slide: NEW }).text.indexOf('### Added slide') < talk.indexOf('### Who') + 20)
assert.equal(insertSlideAfterCaret({ text: talk, caret: at('say hello'), slide: NEW }).text.indexOf('### Added slide') > talk.indexOf('say hello'), true)
// the last slide before a # title line: stays before it
r = insertSlideAfterCaret({ text: talk, caret: at('### Thanks'), slide: NEW })
assert.ok(r.ok && r.text.indexOf('### Added slide') < r.text.indexOf('# Staff briefing\n') && r.text.indexOf('### Added slide') > r.text.indexOf('### Thanks'))
// after a section heading: first slide inside it, one level deeper
r = insertSlideAfterCaret({ text: talk, caret: at('## Opening'), slide: NEW })
assert.ok(r.ok && r.level === 3 && r.text.indexOf('### Added slide') < r.text.indexOf('### Where we are now'))
// a slide at ### level takes the heading level of the caret's slide
r = insertSlideAfterCaret({ text: talk, caret: at('- two'), slide: '## Wrong level\n\n- x' })
assert.ok(r.ok && /\n### Wrong level\n/.test(r.text))
// caret above the first slide: before the first slide
r = insertSlideAfterCaret({ text: talk, caret: 0, slide: NEW })
assert.ok(r.ok && r.text.indexOf('### Added slide') < r.text.indexOf('## Opening'.concat('\n')) + 12)
// a talk with no slides, and refusals
r = insertSlideAfterCaret({ text: '---\ntitle: "Empty"\n---\n', caret: 5, slide: NEW })
assert.ok(r.ok && r.text.endsWith('### Added slide\n\n- fresh\n'))
assert.equal(insertSlideAfterCaret({ text: talk, caret: 9999, slide: NEW }).ok, false)
assert.equal(insertSlideAfterCaret({ text: talk, caret: 3, slide: 'no heading' }).ok, false)
assert.equal(insertSlideAfterCaret({ text: '### A\n\n```\nopen fence\n', caret: 2, slide: NEW }).ok, false, 'an unclosed fence is refused')
// two real-shaped slides, end to end: converted slide placed after the current one
const placed = insertSlideAfterCaret({ text: talk, caret: at('- two'), slide: md1 })
assert.ok(placed.ok && placed.text.includes('### Three layers of AI literacy') && placed.text.indexOf('### Three layers') > placed.text.indexOf('- two') && placed.text.indexOf('### Three layers') < placed.text.indexOf('## Close'))

// --- the choice state in the drawer model
const oldHit = (over = {}) => ({
  key: 'old-slide:abc', source: 'old-slide', thumbUrl: 'twarchive://render', title: 'Three layers', detail: '', ocrText: '', match: 'words', score: 1, usedIn: [],
  oldSlide: listSlide, ...over
})
let c = choiceFor(oldHit())
assert.deepEqual(c, { key: 'old-slide:abc', editable: true, note: null }, 'a slide with text offers both')
assert.equal(choiceFor(oldHit({ source: 'screenshot' })), null, 'only old slides ask')
c = choiceFor(oldHit({ oldSlide: { title: 'Cover', paragraphs: ['Cover'], images: [], slideNumber: 1 } }))
assert.equal(c.editable, false)
assert.equal(c.note, CHOICE_COPY.pictureOnly, 'one plain sentence says why')
assert.ok(/no text or pictures|only/.test(CHOICE_COPY.pictureOnly) && !/deck/i.test(JSON.stringify(CHOICE_COPY)))
c = choiceFor(oldHit({ oldSlide: undefined }))
assert.equal(c.editable, false, 'no record from the provider: picture only')
const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
const both = choiceFor(oldHit())
assert.equal(choiceKeyAction(both, key('Enter')), 'editable')
assert.equal(choiceKeyAction(both, key('p')), 'picture')
assert.equal(choiceKeyAction(both, key('Escape')), 'cancel')
assert.equal(choiceKeyAction(both, key('x')), 'swallow', 'other letters do not reach the search box while the choice shows')
assert.equal(choiceKeyAction(both, key('v', { metaKey: true })), null, 'shortcuts with a modifier are left alone')
const pic = choiceFor(oldHit({ oldSlide: undefined }))
assert.equal(choiceKeyAction(pic, key('Enter')), 'swallow', 'Enter does nothing when only the picture is offered')
assert.equal(choiceKeyAction(pic, key('p')), 'picture')
assert.equal(choiceKeyAction(null, key('Enter')), null, 'Enter and P belong to the choice only')
assert.equal(choiceKeyAction(null, key('p')), null)
assert.equal(DRAWER_COPY.tabOldSlides, 'PowerPoint Imports')

// --- archive text cannot break out of the slide (fix round 1, defect 1)
// The compiler's own parser reads the talk before and after: the old slides are all still there, in
// order and unchanged, and exactly one slide was added, with no id.
const flat = (text) => {
  const tree = parseOutlineTree(text)
  const out = []
  const walk = (n) => { for (const c of n.children) { out.push({ level: c.level, title: c.title, id: c.id, attrs: JSON.stringify(c.attrs), content: c.contentLines.join('\n').trim(), notes: c.notesLines.join('\n').trim() }); walk(c) } }
  walk(tree.root)
  return { deckTitle: tree.meta.title, slides: out }
}
const before = flat(talk)
const hostileCheck = (record, label) => {
  const md = oldSlideMarkdown(record, Object.fromEntries(record.images.map((im, i) => [im.key, `img-${i}${i}${i}${i}`])))
  const first = insertSlideAfterCaret({ text: talk, caret: at('- one'), slide: md })
  assert.ok(first.ok, `${label}: goes in as an editable slide (${first.ok ? '' : first.error})`)
  const after = flat(first.text)
  assert.equal(after.deckTitle, before.deckTitle, `${label}: the talk's title is unchanged`)
  assert.equal(after.slides.length, before.slides.length + 1, `${label}: exactly one slide was added`)
  const added = after.slides[2] // after "Opening" and "Where we are now"
  assert.deepEqual([...after.slides.slice(0, 2), ...after.slides.slice(3)], before.slides, `${label}: every slide that was there is still there, in order, unchanged`)
  assert.equal(added.id, '', `${label}: the new slide has no id`)
  assert.ok(!/"id"/.test(added.attrs), `${label}: no id attribute was read from the archive text (${added.attrs})`)
  assert.equal(added.level, 3, `${label}: the new slide is a sibling of the current one`)
  // what the compiler makes of the new slide's text and notes: never a live web page
  const blocks = (text) => JSON.stringify(lexMarkdownBlocks(text.split('\n')))
  assert.ok(!/"type":"embed"/.test(blocks(added.content)), `${label}: nothing on the slide becomes an embedded web page (${added.content})`)
  assert.ok(!/"type":"embed"/.test(blocks(added.notes)), `${label}: nothing in the notes becomes an embedded web page (${added.notes})`)
  // the same slide a second time: two copies, still nothing else changed
  const second = insertSlideAfterCaret({ text: first.text, caret: first.text.indexOf('- one') + 1, slide: md })
  assert.ok(second.ok, `${label}: goes in a second time (${second.ok ? '' : second.error})`)
  const twice = flat(second.text)
  assert.equal(twice.slides.length, before.slides.length + 2, `${label}: twice makes two slides`)
  assert.deepEqual([...twice.slides.slice(0, 2), ...twice.slides.slice(4)], before.slides, `${label}: twice leaves the rest unchanged`)
  assert.deepEqual(twice.slides[2], twice.slides[3], `${label}: the two copies read the same`)
  return { md, added }
}
const rec = (over) => ({ title: 'Quarterly plan', paragraphs: [], images: [], slideNumber: 4, ...over })
const HOSTILE_TITLES = [
  'Plan {id=evil}', 'Plan {cards}', 'Plan {id=evil} {grid}', '{id=evil}', 'Plan {icon=zap}', 'Open <!-- never closed', 'Closes --> early',
  '~~~', '```js', '## Not a heading', 'First line\n### Second slide {id=evil}', 'First line ### Second slide', 'First line\r### Second slide',
  ':::notes', '---', '# Another talk title', 'Plan\\{id=evil}', 'Plan {id=evil}​ ', 'Tab\tand\vbreak {id=evil}'
]
for (const title of HOSTILE_TITLES) {
  const { md, added } = hostileCheck(rec({ title, paragraphs: ['One point', 'Two points'] }), `title ${JSON.stringify(title)}`)
  assert.equal(md.split('\n').filter((l) => /^#{1,6}\s/.test(l)).length, 1, `title ${JSON.stringify(title)}: one heading line`)
  assert.ok(added.content.includes('One point') && added.content.includes('Two points'), `title ${JSON.stringify(title)}: the text is on the new slide`)
  for (const word of title.split(/[^A-Za-z=]+/).filter((w) => w.length > 2)) assert.ok(md.split('\n')[0].includes(word), `title ${JSON.stringify(title)}: "${word}" is still in the heading`)
}
const HOSTILE_LINES = [
  '~~~', '~~~~~', '```', '````md', '### Injected slide', '## Injected section {id=evil}', '# Another talk title', ':::notes', ':::', ':::NOTES',
  '{id=evil}', '{cards} {id=evil}', '{id=evil', '---', '<!--', '-->', '<!-- hidden from here', 'ends with a group {icon=zap}', 'ends {id=evil}',
  '[Embed: https://example.invalid/page]', '[Video: https://example.invalid/clip.mp4]', '[QR: https://example.invalid]', '[Action: Go -> https://example.invalid]',
  'https://example.invalid/page', 'HTTP://example.invalid/a?b=1#c', '  https://example.invalid/padded  ', 'https://example.invalid/group{x}', 'inner\nhttps://example.invalid/own-line',
  '![shot](https://example.invalid/shot.png)', 'soft\vbreak\v### Injected slide', 'inner\n~~~', 'inner\r### Injected slide', 'inner {id=evil}', '**Timeline:**', '> quoted', '| a | b |'
]
for (const line of HOSTILE_LINES) {
  // alone (the importer leaves a single paragraph unprefixed), among bullets, beside a picture, and in the notes
  const shapes = [
    rec({ paragraphs: [line] }),
    rec({ paragraphs: ['A safe point', line, 'Another safe point'] }),
    rec({ paragraphs: [line], images: [{ key: 'k1', thumbUrl: 'twarchive://one' }] }),
    rec({ paragraphs: [line, 'After it'], images: [{ key: 'k1', thumbUrl: 'twarchive://one' }, { key: 'k2', thumbUrl: 'twarchive://two', name: line }] }),
    rec({ paragraphs: ['A safe point', 'Another safe point'], notes: `Say this first\n${line}\nThen this` })
  ]
  shapes.forEach((record, i) => {
    const { added } = hostileCheck(record, `line ${JSON.stringify(line)} shape ${i}`)
    assert.ok(!/<pre|"code"/.test(added.content), 'no code block')
    if (i === 4) {
      assert.ok(added.notes.includes('Say this first') && added.notes.includes('Then this'), `line ${JSON.stringify(line)}: the notes stay notes`)
      assert.ok(added.content.includes('Another safe point') && !added.content.includes('Then this'), `line ${JSON.stringify(line)}: the notes do not spill onto the slide`)
    }
    if (i === 3) assert.ok(added.content.includes('After it'), `line ${JSON.stringify(line)}: the text after it is still slide text`)
    // a web address still reads as text, where it was
    if (/^\s*https?:\/\/\S+\/(page|padded)\s*$/i.test(line)) assert.ok((i === 4 ? added.notes : added.content).includes(line.trim()), `line ${JSON.stringify(line)} shape ${i}: the address is still there as text`)
  })
}
// a poll directive in the archive text stays text: the new slide is not made an audience poll
for (const line of ['[scale: Never, Always]', '[Categories: Yes, No]', '[scale : 1-5]', '[scale:']) {
  // alone (written as a paragraph of its own, not a bullet) and beside a picture
  for (const record of [rec({ paragraphs: [line] }), rec({ paragraphs: [line], images: [{ key: 'k1', thumbUrl: 'twarchive://one' }] })]) {
    const md = oldSlideMarkdown(record, { k1: 'img-0000' })
    assert.equal(pollDirectivesFor(md.split('\n').slice(1)).directives.length, 0, `line ${JSON.stringify(line)}: no poll directive on the new slide`)
    assert.ok(md.includes(line.trim()), `line ${JSON.stringify(line)}: the text is still there`)
  }
}
// a picture's name from the archive cannot start a line of its own or open a comment
const named = hostileCheck(rec({ paragraphs: ['Point'], images: [{ key: 'k1', thumbUrl: 'twarchive://one', name: 'Chart]\n### Injected {id=evil}\n<!--' }] }), 'hostile picture name')
assert.ok(/^!\[[^\]\n]*\]\(img-0000\)$/m.test(named.md), 'the picture is still one picture line')

// the check itself: whatever text is handed in, an insert that would change the rest of the talk is refused
// with the one sentence that points at the picture
const REFUSED = [
  '### Plan {id=evil}\n\n- point', '### Plan\n{id=evil} {list}\n\n- point', '### Plan\n\n{id=evil}\n\n- point', '### Plan\n\n~~~\n- point', '### Plan\n\n```\n- point',
  '### Plan\n\n- point\n\n### Second slide\n\n- point', '### Plan\n\n- point\n\n## A section', '### Plan\n\n# Another talk title', '### Plan\n\n<!-- open',
  '### Plan\n\n:::notes\nsay\n:::\n\n### Second'
]
for (const slide of REFUSED) {
  const r2 = insertSlideAfterCaret({ text: talk, caret: at('- one'), slide })
  assert.equal(r2.ok, false, `refused: ${JSON.stringify(slide)}`)
  assert.equal(r2.error, OLD_SLIDE_REFUSED)
}
assert.ok(/picture/i.test(OLD_SLIDE_REFUSED) && OLD_SLIDE_REFUSED.split(/[.!?]\s/).length === 1, 'one plain sentence that offers the picture')
// a fence in the new slide that a later fence in the talk would close: the slides between would become code
const fenced = talk.replace('### Thanks', '### Code\n\n~~~\nx = 1\n~~~\n\n### Thanks')
assert.equal(insertSlideAfterCaret({ text: fenced, caret: fenced.indexOf('- one') + 1, slide: '### Plan\n\n~~~\n- point' }).ok, false)
assert.ok(insertSlideAfterCaret({ text: fenced, caret: fenced.indexOf('- one') + 1, slide: NEW }).ok, 'a talk with a closed fence still takes a slide')
// a comment the new slide would close early
const commented = talk.replace('### Thanks', '<!-- parked\n\n### Parked slide\n\n-->\n\n### Thanks')
assert.ok(insertSlideAfterCaret({ text: commented, caret: commented.indexOf('- one') + 1, slide: NEW }).ok)
// a closed fence inside the new slide is the slide's own business
assert.ok(insertSlideAfterCaret({ text: talk, caret: at('- one'), slide: '### Plan\n\n```\n### not a slide\n```' }).ok)

// --- an insert never moves a slide under another one (fix round 2, defect 3)
// Each slide's chain of parents, by title, as the compiler's parser reads the talk.
const chains = (text) => {
  const out = {}
  const walk = (n, chain) => { for (const c of n.children) { out[c.title] = chain.join(' > '); walk(c, [...chain, c.title]) } }
  walk(parseOutlineTree(text.startsWith('---') ? text.slice(text.indexOf('\n---', 3) + 4) : text).root, [])
  return out
}
const nested = ['## Section', '', '### Parent', '', '- parent body', '', '#### Child', '', '- child body', '', '### Next', '', '- next body', ''].join('\n')
const inNested = (marker) => nested.indexOf(marker) + 1
const withoutAdded = (text) => { const c = chains(text); delete c['Added slide']; return c }
// caret in a slide that has slides under it: the new slide follows all of them, as that slide's sibling
r = insertSlideAfterCaret({ text: nested, caret: inNested('- parent body'), slide: NEW })
assert.ok(r.ok, 'a slide with slides under it takes a new slide after it')
assert.equal(chains(r.text)['Child'], 'Section > Parent', 'the slide under the current one stays under it')
assert.equal(chains(r.text)['Added slide'], 'Section', 'the new slide is the current slide’s sibling')
assert.equal(r.level, 3)
assert.ok(r.text.includes('- child body\n\n### Added slide\n\n- fresh\n\n### Next'), 'after the current slide and everything under it, before the next slide at its level')
assert.deepEqual(withoutAdded(r.text), chains(nested))
// the same from the heading line of that slide
r = insertSlideAfterCaret({ text: nested, caret: inNested('### Parent'), slide: NEW })
assert.ok(r.ok && r.text.includes('- child body\n\n### Added slide'))
// caret in the child: the new slide follows the child, at the child's level, still under the parent
r = insertSlideAfterCaret({ text: nested, caret: inNested('- child body'), slide: NEW })
assert.ok(r.ok && r.level === 4)
assert.ok(r.text.includes('- child body\n\n#### Added slide\n\n- fresh\n\n### Next'))
assert.equal(chains(r.text)['Added slide'], 'Section > Parent')
assert.deepEqual(withoutAdded(r.text), chains(nested))
// caret on the section heading: still the section's first slide
r = insertSlideAfterCaret({ text: nested, caret: inNested('## Section'), slide: NEW })
assert.ok(r.ok && r.level === 3 && r.text.startsWith('## Section\n\n### Added slide\n\n- fresh\n\n### Parent'))
assert.deepEqual(withoutAdded(r.text), chains(nested))
// a section whose first slide skips a level: the new first slide takes that slide's level, so that slide
// stays the section's own
const skipping = ['## Section', '', 'section text', '', '#### Deep first', '', '- deep', '', '### Later', '', '- later', ''].join('\n')
r = insertSlideAfterCaret({ text: skipping, caret: 3, slide: NEW })
assert.ok(r.ok && r.level === 4, 'first slide of the section, at the level of the slide that was first')
assert.ok(r.text.startsWith('## Section\n\nsection text\n\n#### Added slide\n\n- fresh\n\n#### Deep first'))
assert.equal(chains(r.text)['Deep first'], 'Section')
assert.deepEqual(withoutAdded(r.text), chains(skipping))
// a talk whose slides are all at one level: the new slide goes between two of them, at that level
const level2 = ['## One', '', '- a', '', '## Two', '', '- b', ''].join('\n')
r = insertSlideAfterCaret({ text: level2, caret: 3, slide: NEW })
assert.ok(r.ok && r.level === 2 && r.text.startsWith('## One\n\n- a\n\n## Added slide\n\n- fresh\n\n## Two'))
// three levels down, and a slide whose last child has children of its own
const deep = ['## S', '', '### A', '', '#### A1', '', '##### A1a', '', '- x', '', '#### A2', '', '### B', '', '## T', '', '### C', ''].join('\n')
r = insertSlideAfterCaret({ text: deep, caret: deep.indexOf('#### A1') + 2, slide: NEW })
assert.ok(r.ok && r.level === 4 && r.text.includes('- x\n\n#### Added slide\n\n- fresh\n\n#### A2'))
r = insertSlideAfterCaret({ text: deep, caret: deep.indexOf('### A') + 2, slide: NEW })
assert.ok(r.ok && r.level === 3 && r.text.includes('#### A2\n\n### Added slide\n\n- fresh\n\n### B'))
r = insertSlideAfterCaret({ text: deep, caret: deep.indexOf('### B') + 2, slide: NEW })
assert.ok(r.ok && r.level === 3 && r.text.includes('### B\n\n### Added slide\n\n- fresh\n\n## T'), 'the last slide of a section: the new one stays in that section')
// wherever the caret is, in every one of these talks: the slide goes in and no slide changes parents
for (const [name, text] of Object.entries({ talk, nested, skipping, level2, deep, fenced: talk.replace('### Thanks', '### Code\n\n~~~\n## not a heading\n~~~\n\n#### Under code\n\n### Thanks') })) {
  const was = chains(text)
  for (let caret = 0; caret <= text.length; caret += 1) {
    const res = insertSlideAfterCaret({ text, caret, slide: NEW })
    assert.ok(res.ok, `${name} caret ${caret}: goes in (${res.ok ? '' : res.error})`)
    assert.deepEqual(withoutAdded(res.text), was, `${name} caret ${caret}: every slide keeps its parents`)
  }
}
// the check on its own: a result where a slide has changed parents is refused, whatever placed it
const wrong = nested.replace('#### Child', '### Added slide\n\n- fresh\n\n#### Child')
assert.equal(chains(wrong)['Child'], 'Section > Added slide', 'fixture: placed there, the new slide takes the child')
assert.equal(insertedAsOneSlide(nested, wrong, 6, 3, 3), false, 'a result in which a slide has a new parent is not accepted')
const right = nested.replace('### Next', '### Added slide\n\n- fresh\n\n### Next')
assert.equal(insertedAsOneSlide(nested, right, 10, 3, 3), true, 'the same slide after the child is accepted')
console.log('old slides: ok')
