import assert from 'node:assert/strict'
import { breakdownChoices, planSketch } from '../src/shared/sketch-breakdown.ts'
import { SAMPLE_SKETCH } from '../src/shared/sketch-sample.ts'

assert.deepEqual(breakdownChoices(SAMPLE_SKETCH), ['main', 'section', 'idea'])
for (const [kind, count] of [['main', 5], ['section', 3], ['idea', 8]]) {
  const plan = planSketch(SAMPLE_SKETCH, kind)
  assert.equal(plan.slides.length, count, kind)
  assert.equal(plan.lines.length, 21)
  assert.deepEqual(plan.sections.map(section => section.text), ['This year', 'Next season', 'Money'])
  assert.deepEqual(plan.undecided.map(part => part.line), [9])
  const lines = [
    ...plan.sections.map(part => part.line),
    ...plan.slides.flatMap(slide => [
      ...slide.titleLines, ...slide.pictures.map(part => part.line),
      ...slide.points.flatMap(point => [point.line, ...point.details.map(detail => detail.line)]),
    ]),
    ...plan.undecided.map(part => part.line),
  ].sort((a, b) => a - b)
  assert.deepEqual(lines, Array.from({ length: 21 }, (_, i) => i + 1), kind)
}

const prose = 'This is a paragraph. It wraps\nonto two lines.\n\nThe next paragraph.'
assert.deepEqual(breakdownChoices(prose), ['paragraph', 'sentence', 'one'])
assert.equal(planSketch(prose, 'paragraph').slides.length, 2)
assert.deepEqual(planSketch(prose, 'sentence').slides.map(slide => [slide.title, slide.titleLines]), [
  ['This is a paragraph.', [1]], ['It wraps onto two lines.', [1, 2]], ['The next paragraph.', [4]],
])
assert.equal(planSketch(prose, 'one').slides[0].points.length, 2)
assert.deepEqual(planSketch('## Part\r\n### Slide\r\n- Point\r\n  1. detail', 'marked').slides[0].points,
  [{ line: 3, text: 'Point', details: [{ line: 4, text: 'detail' }] }])
assert.deepEqual(planSketch('Untitled introduction\n## Part\nUnplaced\n### Slide', 'marked').undecided.map(x => x.line), [1, 3])
assert.equal(planSketch('', 'main').slides.length, 0)
assert.deepEqual(breakdownChoices('## Part\n### Slide\n- Point'), ['main', 'section', 'idea', 'marked'])
const pictureText = '## Part\n### Slide\n- Point\n[picture: garden-beds.jpg]'
const missing = planSketch(pictureText, 'marked', new Map())
assert.deepEqual(missing.undecided.map(line => [line.line, line.reason]), [[4, 'missing-picture']])
assert.equal(missing.slides[0].pictures.length, 0)
const present = planSketch(pictureText, 'marked', new Map([['[picture: garden-beds.jpg]', 'assets/garden-beds.jpg']]))
assert.equal(present.undecided.length, 0)
assert.equal(present.slides[0].pictures[0].ref, 'assets/garden-beds.jpg')
console.log('Sketch breakdowns account for the locked sample, marked headings and prose.')

const { planSketchApply } = await import('../src/shared/sketch-apply.ts')
const { readSlides } = await import('../src/shared/insert-section.ts')
const start = '---\noutline_version: 2\ntitle: A talk\n---\n\n## Existing section {id=used1}\n\n### Keep me {id=used2}\n\n- Old point\n\n### Keep me too {id=used3}\n\n- Old point too\n\n## Last section {id=used4}\n\n### Closing {id=used5}\n'
for (const [kind, count] of [['main', 5], ['section', 3], ['idea', 8]]) {
  const review = { ...planSketch(SAMPLE_SKETCH, kind), fates: { 9: 'notes' } }
  assert.equal(planSketchApply(start, { kind: 'after', line: 8, title: 'Keep me' }, { ...review, fates: {} }).ok, false)
  const result = planSketchApply(start, { kind: 'after', line: 8, title: 'Keep me' }, review)
  assert.ok(result.ok, result.error)
  assert.equal(result.count, count)
  assert.equal(result.ids.length, count + 3)
  const headings = readSlides(result.text).slides
  const ids = headings.map(slide => slide.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(headings[3].title, 'This year')
  assert.ok(headings.some(slide => slide.notes.includes('Thanks to everyone')))
}
const newTalk = '---\noutline_version: 2\ntitle: New talk\n---\n'
const initial = planSketchApply(newTalk, { kind: 'start' }, { ...planSketch(SAMPLE_SKETCH, 'main'), fates: { 9: 'sketch' } })
assert.ok(initial.ok, initial.error)
assert.equal(initial.count, 5)
const marked = planSketchApply(newTalk, { kind: 'start' }, { ...planSketch('## Topic\n### Title\n- Point {id=used1}\n  - Detail', 'marked'), fates: {} })
assert.ok(marked.ok, marked.error)
assert.equal(marked.count, 1)
assert.match(marked.text, /Point &#123;id=used1\}/)
assert.ok(marked.ids.every(id => id !== 'used1'))

const automatic = planSketch('## Empty\n### A proposal\n- Make a plan\n## Also empty', 'main')
assert.deepEqual(automatic.sections.map(section => section.text), ['Empty', 'A proposal', 'Also empty'])
const automaticApply = planSketchApply(newTalk, { kind: 'start' }, { ...automatic, fates: {} })
assert.ok(automaticApply.ok, automaticApply.error)
assert.equal(automaticApply.count, 1)
assert.deepEqual(readSlides(automaticApply.text).slides.map(slide => slide.title), ['A proposal', 'A proposal'])

const twoSections = planSketch('## Money\n### Subscriptions\n- Keep the current rate\n## Garden\n### Seed swap\n- Bring spare seeds', 'marked')
const withProposal = planSketchApply(start, { kind: 'after', line: 8, title: 'Keep me' }, {
  ...twoSections,
  slides: twoSections.slides.map(slide => ({ ...slide, aside: slide.title === 'Subscriptions' })),
  fates: {},
})
assert.ok(withProposal.ok, withProposal.error)
assert.equal(withProposal.count, 1)
assert.equal(withProposal.ids.length, 2, 'one section and one slide get new IDs')
assert.doesNotMatch(withProposal.text, /Money|Subscriptions/)
const reviewedSlides = readSlides(withProposal.text).slides
const added = reviewedSlides.filter(slide => withProposal.ids.includes(slide.id))
assert.deepEqual(added.map(slide => [slide.level, slide.title]), [[2, 'Garden'], [3, 'Seed swap']])
assert.equal(reviewedSlides[added[1].ancestors.at(-1)].id, added[0].id)
assert.deepEqual(withProposal.proposals.map(proposal => proposal.title), ['Subscriptions'])

const onlyProposals = planSketchApply(start, { kind: 'start' }, {
  ...twoSections, slides: twoSections.slides.map(slide => ({ ...slide, aside: true })), fates: {},
})
assert.ok(onlyProposals.ok, onlyProposals.error)
assert.equal(onlyProposals.text, start, 'keeping every slide aside leaves the outline byte-for-byte intact')
assert.equal(onlyProposals.count, 0)
assert.deepEqual(onlyProposals.ids, [])
assert.equal(onlyProposals.firstSlide, null)
assert.deepEqual(onlyProposals.proposals.map(proposal => proposal.title), ['Subscriptions', 'Seed swap'])
console.log('Sketch apply uses one placement plan, keeps existing section membership and stamps fresh identifiers.')
