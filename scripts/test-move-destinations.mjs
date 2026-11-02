// The destination list of "Move slide to…" and "Move section to…": the pure model in
// src/renderer/src/lib/moveDestinations.ts (outline rows + typed text → options), and each choice
// carried through to the move it makes (moveBlock, slideBlockOps.ts) on the talk's text.
import { strict as assert } from 'node:assert'
import { slideRows } from '../src/renderer/src/extensions/slideOutline.ts'
import { moveBlock } from '../src/renderer/src/extensions/slideBlockOps.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { computeSlideLines, slideNumbersByLine } from '../src/shared/slide-lines.ts'
import { outlineNumbers } from '../src/renderer/src/lib/stripNumbers.ts'
import { batchMoveOptions, moveMessage, moveSubject, placementOptions, sectionMoveOptions, slideMoveOptions } from '../src/renderer/src/lib/moveDestinations.ts'

let cases = 0
const check = (name, fn) => { fn(); cases += 1 }
const J = (...lines) => lines.join('\n')
const slide = (t) => [`### ${t}`, `{id=${t.toLowerCase().replace(/\W+/g, '-')}}`, `- ${t}`, '']
const TALK = J(
  '# Talk', '',
  '## Opening', '', ...slide('Welcome'), ...slide('Agenda'),
  '## Method', '', ...slide('Data'), '### Analysis', '', '#### Step one', 'x', '', '#### Step two', 'y', '',
  '## Empty', '',
  '## Closing', '', ...slide('Summary'), ...slide('Thanks')
)
const rows = slideRows(TALK)
const lineOf = (heading, text = TALK) => { const i = text.split('\n').indexOf(heading); assert(i >= 0, heading); return i + 1 }
const keys = (options) => options.map((o) => o.key)
const labels = (options) => options.map((o) => o.label)
const order = (text) => text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#+\s/, ''))

check('a slide: Start of talk, End of talk, then every section in outline order', () => {
  const options = slideMoveOptions(rows, lineOf('### Agenda'))
  assert.deepEqual(labels(options), ['Start of talk', 'End of talk', 'Opening', 'Method', 'Closing'])
  assert.deepEqual(options.map((o) => o.group), ['Talk', 'Talk', 'As the last slide of', 'As the last slide of', 'As the last slide of'])
  assert.deepEqual(options.map((o) => o.detail), ['', '', '2 slides', '3 slides', '2 slides'], 'each section with its slide count (Analysis is a section: its two steps and Data count)')
  assert.deepEqual(options.map((o) => o.current), [false, false, true, false, false], 'the section it is in is marked')
  assert.deepEqual(options.find((o) => o.label === 'Method').target, { kind: 'into', line: lineOf('## Method') })
})

check('a section holding no slide is not a section to move into; the deck title is never listed', () => {
  assert.ok(!labels(slideMoveOptions(rows, lineOf('### Agenda'))).includes('Empty'))
  assert.ok(!labels(slideMoveOptions(rows, lineOf('### Agenda'))).includes('Talk'))
})

check('a deeper slide is offered the sections above its level, indented by level', () => {
  const options = slideMoveOptions(rows, lineOf('#### Step one'))
  assert.deepEqual(labels(options), ['Start of talk', 'End of talk', 'Opening', 'Method', 'Analysis', 'Closing'])
  assert.deepEqual(options.map((o) => o.indent), [0, 0, 0, 0, 1, 0])
  assert.equal(options.find((o) => o.current).label, 'Analysis')
})

check('no-op places are left out: the first slide has no Start of talk, the last no End of talk', () => {
  assert.ok(!keys(slideMoveOptions(slideRows(J('### A', 'a', '### B', 'b')), 1)).includes('start'))
  assert.ok(!keys(slideMoveOptions(rows, lineOf('### Thanks'))).includes('end'))
})

check('typing filters sections and offers slides by title', () => {
  const options = slideMoveOptions(rows, lineOf('### Agenda'), 'clo')
  assert.deepEqual(labels(options), ['Closing'])
  const typed = slideMoveOptions(rows, lineOf('### Agenda'), ' S ')
  assert.deepEqual(typed.map((o) => [o.group, o.label]), [
    ['Talk', 'Start of talk'], ['As the last slide of', 'Closing'],
    ['Next to a slide', 'Step one'], ['Next to a slide', 'Step two'], ['Next to a slide', 'Summary'], ['Next to a slide', 'Thanks']
  ], 'case-insensitive; Analysis is a section, so it is not offered as a slide; the slide itself is never offered')
  const slideOption = typed.find((o) => o.label === 'Summary')
  assert.equal(slideOption.target, null)
  assert.equal(slideOption.slideLine, lineOf('### Summary'))
  assert.equal(slideOption.no, '07', 'a slide shows its number, the one the outline shows (the empty section before it is a numbered slide too)')
  assert.equal(slideOption.detail, '', 'the number is at the left now, not in the detail')
  assert.equal(rows.find((r) => r.line === slideOption.slideLine).slideNo, 7, 'it is the outline row\'s own slideNo')
  assert.deepEqual(typed.filter((o) => o.group !== 'Next to a slide').map((o) => o.no), ['', ''], 'sections and the talk ends carry no number where the outline shows none')
  assert.deepEqual(slideMoveOptions(rows, lineOf('### Agenda'), '07').map((o) => o.label), ['Summary'], 'typing the number as digits finds the slide')
  assert.deepEqual(slideMoveOptions(rows, lineOf('### Agenda'), '7').map((o) => o.label), ['Summary'], 'without the leading zero too')
  assert.deepEqual(slideMoveOptions(rows, lineOf('### Agenda'), 'zzz'), [])
  assert.ok(!labels(slideMoveOptions(rows, lineOf('### Agenda'), 'agenda')).includes('Agenda'))
})

check('choosing a slide offers Before “Title” and After “Title”', () => {
  const options = placementOptions(rows, lineOf('### Agenda'), lineOf('### Summary'))
  assert.deepEqual(labels(options), ['Before “Summary”', 'After “Summary”'])
  assert.deepEqual(options.map((o) => o.target), [{ kind: 'before', line: lineOf('### Summary') }, { kind: 'after', line: lineOf('### Summary') }])
  assert.deepEqual(labels(placementOptions(rows, lineOf('### Agenda'), lineOf('### Welcome'))), ['Before “Welcome”'], 'it is already after Welcome')
  assert.deepEqual(labels(placementOptions(rows, lineOf('### Welcome'), lineOf('### Agenda'))), ['After “Agenda”'], 'it is already before Agenda')
})

check('a section: Start, End, then before and after each other section of its level, never inside itself', () => {
  const options = sectionMoveOptions(rows, lineOf('## Method'))
  assert.deepEqual(labels(options), ['Start of talk', 'End of talk', 'Before “Opening”', 'After “Empty”', 'Before “Closing”', 'After “Closing”'],
    'After “Opening” and Before “Empty” are where it is now')
  for (const o of options) if (o.target.kind === 'before' || o.target.kind === 'after') assert.equal(rows.find((r) => r.line === o.target.line).level, 2)
  assert.deepEqual(labels(sectionMoveOptions(rows, lineOf('## Opening'))), ['End of talk', 'After “Method”', 'Before “Empty”', 'After “Empty”', 'Before “Closing”', 'After “Closing”'])
  assert.deepEqual(labels(sectionMoveOptions(rows, lineOf('## Method'), 'clos')), ['Before “Closing”', 'After “Closing”'])
  assert.deepEqual(labels(sectionMoveOptions(rows, lineOf('### Analysis'))), ['Start of talk', 'End of talk', 'Before “Welcome”', 'After “Welcome”', 'Before “Agenda”', 'After “Agenda”', 'Before “Data”', 'Before “Summary”', 'After “Summary”', 'Before “Thanks”', 'After “Thanks”'],
    'a deeper section moves among headings of its own level')
})

check('a choice is a move: every option of every slide and section moves the text where its label says', () => {
  for (const from of rows.filter((r) => r.level > 1)) {
    const section = rows[rows.indexOf(from) + 1]?.level > from.level
    const options = section ? sectionMoveOptions(rows, from.line) : [...slideMoveOptions(rows, from.line), ...rows.filter((r) => r.slideNo != null && r.line !== from.line).flatMap((r) => placementOptions(rows, from.line, r.line))]
    for (const option of options) {
      const moved = moveBlock(TALK, from.line, option.target)
      // The one listed option that may not move anything: the slide's own section when it is already last in it.
      if (option.current && !moved) continue
      assert.ok(moved, `${from.text} → ${option.label}: the option is never a no-op`)
      assert.deepEqual(moved.text.split('\n').sort(), TALK.split('\n').sort(), `${from.text} → ${option.label}: same lines`)
      const after = order(moved.text)
      const at = after.indexOf(from.text)
      assert.equal(moved.text.split('\n')[moved.line - 1].replace(/^#+\s/, ''), from.text)
      const other = 'line' in option.target ? rows.find((r) => r.line === option.target.line).text : null
      if (option.target.kind === 'start') assert.equal(at, 1, `${from.text} → start: first under the deck title`)
      if (option.target.kind === 'before') assert.ok(after.indexOf(other) > at, `${from.text} is before ${other}`)
      if (option.target.kind === 'after') assert.ok(after.indexOf(other) < at, `${from.text} is after ${other}`)
      if (option.target.kind === 'into') {
        const movedRows = slideRows(moved.text)
        const i = movedRows.findIndex((r) => r.line === moved.line)
        let parent = i - 1
        while (parent >= 0 && movedRows[parent].level >= movedRows[i].level) parent -= 1
        // The nearest shallower heading above is the chosen section, or a section inside it that it now ends.
        const chain = []
        for (let k = parent; k >= 0; k -= 1) if (chain.length === 0 || movedRows[k].level < chain[chain.length - 1].level) chain.push(movedRows[k])
        assert.ok(chain.some((r) => r.text === other), `${from.text} is inside ${other}`)
      }
    }
  }
})

check('the status line', () => {
  const from = lineOf('### Agenda')
  assert.equal(moveMessage(rows, from, { kind: 'into', line: lineOf('## Closing') }), 'Moved “Agenda” to the end of “Closing”.')
  assert.equal(moveMessage(rows, from, { kind: 'start' }), 'Moved “Agenda” to the start of the talk.')
  assert.equal(moveMessage(rows, from, { kind: 'end' }), 'Moved “Agenda” to the end of the talk.')
  assert.equal(moveMessage(rows, from, { kind: 'before', line: lineOf('### Summary') }), 'Moved “Agenda” before “Summary”.')
  assert.equal(moveMessage(rows, from, { kind: 'after', line: lineOf('### Summary') }), 'Moved “Agenda” after “Summary”.')
})

check('what a command acts on, from the caret line', () => {
  assert.deepEqual(moveSubject(rows, lineOf('### Agenda') + 2, 'slide'), { line: lineOf('### Agenda'), kind: 'slide', title: 'Agenda' }, 'anywhere in the slide')
  assert.deepEqual(moveSubject(rows, lineOf('## Method'), 'slide'), { line: lineOf('## Method'), kind: 'section', title: 'Method' }, 'Move slide to… on a section heading moves the section')
  assert.deepEqual(moveSubject(rows, lineOf('### Agenda') + 2, 'section'), { line: lineOf('## Opening'), kind: 'section', title: 'Opening' }, 'Move section to… inside a slide: its section')
  assert.deepEqual(moveSubject(rows, lineOf('#### Step two'), 'section'), { line: lineOf('### Analysis'), kind: 'section', title: 'Analysis' })
  assert.equal(moveSubject(rows, 1, 'slide'), null, 'the deck title')
  assert.equal(moveSubject(slideRows(J('intro', '### A')), 1, 'slide'), null, 'above the first heading')
  assert.equal(moveSubject(slideRows(J('### A', 'a', '### B')), 2, 'section'), null, 'a slide in no section')
  assert.deepEqual(moveSubject(rows, lineOf('## Empty'), 'section'), null, 'a section with no slides is a slide row; it has no section above it')
})


// Section rows carry the number of the section's own title slide: the strip's number (compiled index + 1),
// the same derivation as the editor gutter (slideNumbersByLine). Rows come from the real compiler.
{
  const stripText = TALK.replace('# Talk', '---\ntitle: Talk\n---\n\n# Talk')
  const model = await prepareSource('/tmp/move-destinations.md', stripText, 'move-destinations')
  const compiledRows = buildPerSlideProjections(model, 'move-destinations')
  const numbers = slideNumbersByLine(computeSlideLines(compiledRows, stripText))
  const srows = slideRows(stripText)
  const at = (h) => stripText.split('\n').indexOf(h) + 1
  const two = (n) => String(n).padStart(2, '0')
  check('section rows show the number of the section\'s own title slide, in the strip\'s sequence', () => {
    const options = slideMoveOptions(srows, at('### Agenda'), '', numbers)
    const method = options.find((o) => o.label === 'Method')
    assert.equal(method.no, two(numbers.get(at('## Method'))), 'the section\'s own slide number')
    assert.ok(numbers.get(at('## Method')) > numbers.get(at('### Agenda')), 'it comes after the slides of the section before it')
    assert.equal(numbers.get(at('### Data')), numbers.get(at('## Method')) + 1, 'and the section\'s first slide follows it')
    assert.equal(options.find((o) => o.label === 'Start of talk').no, '', 'Start of talk carries none')
    assert.equal(method.detail, '3 slides', 'the count stays')
  })
  check('typing the number finds the section and the slide', () => {
    const m = numbers.get(at('## Method'))
    assert.ok(slideMoveOptions(srows, at('### Agenda'), String(m), numbers).some((o) => o.label === 'Method'), 'section found by its number')
    const d = numbers.get(at('### Data'))
    assert.ok(slideMoveOptions(srows, at('### Agenda'), String(d), numbers).some((o) => o.label === 'Data'), 'slide found by its strip number')
    assert.ok(sectionMoveOptions(srows, at('## Closing'), String(m), numbers).every((o) => o.group === 'Talk' || o.label.includes('Method')), 'Move section: the list narrows to the section')
    assert.ok(sectionMoveOptions(srows, at('## Closing'), String(m), numbers).some((o) => o.label.includes('Method')))
  })
  check('without compiled numbers a section has no number (nothing is invented)', () => {
    assert.equal(slideMoveOptions(srows, at('### Agenda')).find((o) => o.label === 'Method').no, '')
  })
}

// outlineNumbers: the one numbering helper the outline rows and the Move list share.
{
  const text = J('---', 'title: Talk', '---', '', '# Talk', '', '## Sec A', '', ...slide('One'), '## Sec B', '', ...slide('Two'), ...slide('Three'))
  const model = await prepareSource('/tmp/outline-numbers.md', text, 'outline-numbers')
  const compiled = buildPerSlideProjections(model, 'outline-numbers')
  const published = slideNumbersByLine(computeSlideLines(compiled, text))
  const orows = slideRows(text)
  const obj = (map) => Object.fromEntries([...map])
  check('fresh: the compiler\'s numbers by line; the title row has the cover\'s; cover, sections and slides all count', () => {
    const n = outlineNumbers(orows, published)
    assert.deepEqual(orows.map((r) => n.get(r.line)), [1, 2, 3, 4, 5, 6], 'cover 1, Sec A 2, One 3, Sec B 4, Two 5, Three 6')
    for (const r of orows.slice(1)) assert.equal(n.get(r.line), published.get(r.line), `${r.text}: the compiler's own number`)
    const gridNumbers = compiled.map((_, i) => i + 1)
    assert.deepEqual(orows.map((r) => n.get(r.line)), gridNumbers.slice(0, orows.length), 'equal to the grid\'s for every slide')
  })
  check('stale, same count (lines added inside a slide): by position, nothing moves', () => {
    const edited = text.replace('- One', '- One\nextra one\nextra two')
    const erows = slideRows(edited)
    const n = outlineNumbers(erows, published)
    assert.deepEqual(erows.map((r) => n.get(r.line)), [1, 2, 3, 4, 5, 6])
    assert.notDeepEqual(erows.map((r) => r.line), orows.map((r) => r.line), 'the lines really did shift')
  })
  check('stale, a slide added or removed: ordinal from the title row, every row numbered', () => {
    const grown = slideRows(text.replace('## Sec B', '### New\n\n## Sec B'))
    assert.deepEqual(grown.map((r) => outlineNumbers(grown, published).get(r.line)), [1, 2, 3, 4, 5, 6, 7])
    const shrunk = slideRows(text.replace(/### Three\n\{id=three\}\n- Three\n/, ''))
    assert.deepEqual(shrunk.map((r) => outlineNumbers(shrunk, published).get(r.line)), [1, 2, 3, 4, 5])
  })
  check('nothing published yet: ordinal, title row 01; a talk with no # title starts at 1 until published', () => {
    assert.deepEqual(orows.map((r) => outlineNumbers(orows, null).get(r.line)), [1, 2, 3, 4, 5, 6])
    assert.deepEqual(orows.map((r) => outlineNumbers(orows, new Map()).get(r.line)), [1, 2, 3, 4, 5, 6])
    const noTitle = slideRows(J('## S', '', ...slide('A')))
    assert.deepEqual(noTitle.map((r) => outlineNumbers(noTitle, null).get(r.line)), [1, 2])
  })
  {
    const noCoverText = J('---', 'title: No cover', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
      '### Opening', '{id=open1}', '', 'Opening body.', '', '### Middle', '{id=mid01}', '', 'Middle body.', '', '### Closing', '{id=close}', '', 'Closing body.')
    const model = await prepareSource('/tmp/no-cover-numbers.md', noCoverText, 'no-cover-numbers')
    const compiled = buildPerSlideProjections(model, 'no-cover-numbers')
    const published = slideNumbersByLine(computeSlideLines(compiled, noCoverText))
    check('no automatic cover: stale numbers keep the first slide at 1 after an insert or body edit', () => {
      const grown = slideRows(noCoverText.replace('### Middle', '### Chart\n{id=chart}\n\n![](assets/chart.svg)\n\n\n### Middle'))
      assert.deepEqual(grown.map((r) => outlineNumbers(grown, published).get(r.line)), [1, 2, 3, 4])
      const edited = slideRows(noCoverText.replace('Opening body.', 'Opening body.\nMore body.\nMore again.'))
      assert.deepEqual(edited.map((r) => outlineNumbers(edited, published).get(r.line)), [1, 2, 3])
    })
    const withCoverText = noCoverText.replace('auto_title_slide: false', 'auto_title_slide: true')
    const withCoverModel = await prepareSource('/tmp/with-cover-numbers.md', withCoverText, 'with-cover-numbers')
    const withCoverSlides = buildPerSlideProjections(withCoverModel, 'with-cover-numbers')
    const withCoverPublished = slideNumbersByLine(computeSlideLines(withCoverSlides, withCoverText))
    check('a real synthetic cover still offsets stale heading numbers by one', () => {
      const grown = slideRows(withCoverText.replace('### Middle', '### Chart\n{id=chart}\n\n![](assets/chart.svg)\n\n\n### Middle'))
      assert.deepEqual(grown.map((r) => outlineNumbers(grown, withCoverPublished).get(r.line)), [2, 3, 4, 5])
    })
  }
  check('fresh with a row the compiler gave no slide: that row has no number, the others keep theirs', () => {
    const partial = new Map(published); partial.delete(orows[3].line)
    const n = outlineNumbers(orows, partial)
    assert.equal(n.get(orows[3].line), undefined)
    assert.equal(n.get(orows[4].line), published.get(orows[4].line))
  })
  assert.ok(obj(outlineNumbers([], null)) && outlineNumbers([], published).size === 0)
}

// Batch destinations (ticket 1b): Move N slides to… — Start/End of talk, section ends, slides to go after; each a SlidePlace.
{
  const T = ['# T', '', '## One', '', '### A', '', '### B', '', '## Two', '', '### C', '', '### D', ''].join('\n')
  const rows = slideRows(T)
  const lineOf = (h) => T.split('\n').indexOf(h) + 1
  const picked = [lineOf('### A'), lineOf('### C')]
  const all = batchMoveOptions(rows, picked)
  assert.deepEqual(all.map((o) => o.key.split(':')[0]), ['start', 'end', 'into', 'into', 'after', 'after', 'after', 'after'].slice(0, all.length))
  const into = all.filter((o) => o.group === 'End of section')
  assert.deepEqual(into.map((o) => o.label), ['One', 'Two'])
  assert.deepEqual(into[0].place, { kind: 'endOfSection', line: lineOf('## One'), title: 'One' })
  assert.deepEqual(all.find((o) => o.key === 'end').place, { kind: 'after', line: lineOf('## Two'), title: 'Two' })
  assert.deepEqual(all.find((o) => o.key === 'start').place, { kind: 'start' })
  // the selection itself is never offered as a place
  assert.equal(all.some((o) => o.key === `after:${lineOf('### A')}` || o.key === `after:${lineOf('### C')}`), false)
  // a selected section hides itself and what is inside it; typed text filters
  const sec = batchMoveOptions(rows, [lineOf('## One'), lineOf('### C')])
  assert.equal(sec.some((o) => o.label === 'One' || o.label === 'A' || o.label === 'B'), false)
  assert.deepEqual(batchMoveOptions(rows, picked, 'D').filter((o) => o.group === 'After slide').map((o) => o.key), [`after:${lineOf('### D')}`])
  assert.deepEqual(batchMoveOptions(rows, []), [])
  cases += 1
}

console.log(`move destinations: ${cases} cases passed`)
