import assert from 'node:assert/strict'
import { completeBlankSlide, isEmptyAuthoringSlide, newTalkSource, placeBlankSlide, placePictures, splitPictureRow } from '../src/shared/redesign-window-source.ts'
import { normalizePositions } from '../src/shared/outline-normalize.ts'
import { parseFrontmatterPairs } from '../src/shared/frontmatter-editor.ts'
import { carouselPaneSibling, createSection, groupSection, nodeAtSourceLine, reorderStructure, structureOf } from '../src/shared/talk-structure.ts'
import { readSlides } from '../src/shared/insert-section.ts'
import { previewLayout } from '../src/shared/layout-verbs.ts'

const fresh = newTalkSource('Rota: #3', 'test123')
assert.equal(parseFrontmatterPairs(fresh).find(pair => pair.key === 'title').value, 'Rota: #3')
assert.match(fresh, /defaults:\n  title: top\n/)
assert.match(fresh, /\n### \{id=test123\}\n\{list\}\n/)
assert.equal(isEmptyAuthoringSlide('### {id=test123}\n{list}\n'), true)
assert.equal(isEmptyAuthoringSlide('### {id=test123}\n{list}\n- Visible'), false)
assert.equal(normalizePositions(fresh), fresh, 'saving an untitled slide keeps its heading')

const talk = '# Title\n\n## Section\n\n### First {id=aa}\n\n- A\n\n:::notes\nprivate\n:::\n\n### Second {id=bb}\n'
const pictures = ['assets/img-a.webp', 'assets/img-b.webp']
const placed = placePictures(talk, 5, false, pictures, 'test123')
assert.equal(placed, talk.replace('- A\n\n', '- A\n\n![](assets/img-a.webp)\n![](assets/img-b.webp)\n\n'))
assert.equal(placePictures(talk, 3, true, pictures, 'test123'), talk.replace('### First', '### Picture {id=test123}\n\n![](assets/img-a.webp)\n![](assets/img-b.webp)\n\n### First'))
assert.equal(placePictures(talk, null, true, pictures, 'test123'), talk.replace('## Section', '### Picture {id=test123}\n\n![](assets/img-a.webp)\n![](assets/img-b.webp)\n\n## Section'))
assert.equal(placePictures('### First\n\n```js\nopen\n', 1, false, pictures, 'test123'), null)
const panes = '### Parent {id=parent}\n\n#### Child {id=child}\n\n- Kept\n\n### Next\n'
assert.equal(placeBlankSlide(panes, 1, false, 'blank'), panes.replace('### Next', '### {id=blank}\n{list}\n\n### Next'))
assert.match(placeBlankSlide('## At level two\n', 1, false, 'blank'), /\n## \{id=blank\}/)
for (const eol of ['\n', '\r\n']) {
  const before = ['### First {id=first}', '- Kept on First', ''].join(eol)
  const after = ['', '- Now on the new slide', '', '### Next {id=next}', ''].join(eol)
  const typing = before + '### ' + after
  const completed = completeBlankSlide(typing, before.length, 'blank')
  assert.equal(completed, before + '###  {id=blank}' + eol + '{list}' + after)
  assert.deepEqual(readSlides(completed).slides.map(slide => slide.id), ['first', 'blank', 'next'])
}
assert.equal(completeBlankSlide('### ', 0, 'blank'), '###  {id=blank}\n{list}\n')
assert.equal(completeBlankSlide('### Existing title', 0, 'blank'), null)
assert.equal(completeBlankSlide('- ### ', 2, 'blank'), null)
let id = 0
const separate = splitPictureRow(placed, pictures, false, () => 'test' + ++id)
assert.match(separate, /:::notes\nprivate\n:::\n\n### Picture \{id=test1\}\n\n!\[\]\(assets\/img-a\.webp\)/)
assert.match(separate, /### Picture \{id=test2\}\n\n!\[\]\(assets\/img-b\.webp\)\n\n### Second/)
assert.equal(splitPictureRow(placed.replace('![](assets/img-b.webp)', 'Removed'), pictures, false, () => 'test'), null)
console.log('New-talk template and picture placement passed.')

const structure = [
  '---', 'title: Garden', '---', '', '## This year {id=year}', '', '### Watering {id=water}',
  '', '~~~md', '#### Quoted heading', '~~~', '<!--', '## Commented heading', '-->',
  ':::notes', 'Private notes', ':::', '', '### Dates {id=dates}', '{carousel}', '',
  '#### Saturday {id=sat}', '- Morning', '', '#### Sunday {id=sun}', '- Afternoon', '',
  '### Repair {id=repair}', '- Fence', '', '### Plant {id=plant}', '- Seeds', '',
  '### Share {id=share}', '- Tools', '', '## Next season {id=next}', '', '### Harvest {id=harvest}', ''
].join('\r\n')
const tree = structureOf(structure)
assert.equal(nodeAtSourceLine(tree, 2), undefined, 'frontmatter has no authored slide')
assert.equal(nodeAtSourceLine(tree, 11)?.id, 'water', 'a fenced heading does not become the caret slide')
assert.equal(nodeAtSourceLine(tree, 15)?.id, 'water', 'a note stays in its authored slide')
assert.equal(nodeAtSourceLine(tree, 23)?.id, 'sat', 'a carousel pane owns its raw source lines')
const position = id => readSlides(structure).slides.find(slide => slide.id === id).line + 1
const originalSlides = readSlides(structure).slides
const added = createSection(structure, { kind: 'section', after: position('sat'), id: 'summer' })
assert.equal(added.ok, true)
assert.equal(added.count, 3)
assert.match(added.text, /#### Sunday \{id=sun\}\r\n- Afternoon\r\n\r\n##  \{id=summer\}/)
assert.deepEqual(readSlides(added.text).slides.filter(slide => slide.id !== 'summer').map(slide => slide.id), originalSlides.map(slide => slide.id))
const afterWhole = createSection(structure, { kind: 'section', after: position('year'), id: 'empty' })
assert.equal(afterWhole.ok, true)
assert.equal(afterWhole.count, 0)
assert.match(afterWhole.text, /### Share \{id=share\}\r\n- Tools\r\n\r\n##  \{id=empty\}\r\n\{role=section-title\}\r\n\r\n## Next season/)
const subsection = createSection(structure, { kind: 'subsection', after: position('water'), id: 'plans' })
assert.equal(subsection.ok, true)
assert.match(subsection.text, /###  \{id=plans\}.*\r\n.*\r\n\r\n#### Dates \{id=dates\}\r\n\{carousel\}\r\n\r\n##### Saturday \{id=sat\}/)
assert.ok(subsection.text.includes('~~~md\r\n#### Quoted heading\r\n~~~\r\n<!--\r\n## Commented heading\r\n-->'))
const grouped = groupSection(structure, [position('repair'), position('plant')], 'spring')
assert.equal(grouped.ok, true)
assert.deepEqual(readSlides(grouped.text).slides.filter(slide => slide.ancestors.some(i => readSlides(grouped.text).slides[i].id === 'spring')).map(slide => slide.id), ['repair', 'plant'])
assert.equal(groupSection(structure, [position('repair'), position('share')], 'spring').ok, false)
assert.equal(groupSection(structure, [position('sat'), position('sun')], 'spring').ok, false)
assert.equal(groupSection(structure, [position('year')], 'spring').error, 'Sections can’t go inside a new section.')
assert.equal(createSection('### No section\n', { kind: 'subsection', after: 1, id: 'sub' }).ok, false)
const moved = reorderStructure(structure, [position('repair'), position('plant')], position('harvest'), 'after')
assert.ok(moved.text, moved.error)
assert.deepEqual(readSlides(moved.text).slides.map(slide => slide.id),
  ['year', 'water', 'dates', 'sat', 'sun', 'share', 'next', 'harvest', 'repair', 'plant'])
assert.deepEqual(moved.text.split('\n').slice().sort(), structure.split('\n').slice().sort(), 'a same-depth move preserves the exact line multiset')
assert.ok(reorderStructure(structure, [position('year')], position('harvest'), 'after').error, 'a place cannot change an unrelated slide’s parent')
const subLine = readSlides(subsection.text).slides.find(slide => slide.id === 'plans').line + 1
const pictureAfterSubsection = placePictures(subsection.text, subLine, true, pictures, 'picture')
assert.ok(pictureAfterSubsection, 'a subsection gets a separate child picture slide')
assert.deepEqual(readSlides(pictureAfterSubsection).slides.filter(slide => slide.id !== 'picture').map(slide => slide.id), readSlides(subsection.text).slides.map(slide => slide.id))
const unsectioned = '### First {id=first}\n- A\n\n### Second {id=second}\n- B\n\n### Third {id=third}\n- C\n'
const beforeSection = unsectioned + '\n## Later {id=later}\n\n### More {id=more}\n- D\n'
for (const source of [unsectioned, beforeSection]) {
  const before = readSlides(source).slides
  const lines = before.slice(1, 3).map(slide => slide.line + 1)
  const edit = groupSection(source, lines, 'group')
  assert.equal(edit.ok, true)
  const slides = readSlides(edit.text).slides
  const owner = slides.findIndex(slide => slide.id === 'group')
  assert.equal(slides[owner].level, 2)
  assert.deepEqual(slides.filter(slide => slide.ancestors.includes(owner)).map(slide => slide.id), ['second', 'third'])
  assert.match(groupSection(source, before.slice(0, 2).map(slide => slide.line + 1), 'group').error, /Select through to the end/)
}
const carousels = [
  '### First carousel {id=first}', '{carousel}', '', '#### One {id=one}', '- A', '',
  '#### Two {id=two}', '- B', '', '### Second carousel {id=second}', '{carousel}', '',
  '#### Three {id=three}', '- C', ''
].join('\n')
const carouselTree = structureOf(carousels)
const paneAt = id => carouselTree.nodes.find(node => node.id === id)
const paneLine = id => paneAt(id).line + 1
assert.equal(carouselPaneSibling(carouselTree, paneAt('one'), 'up'), undefined)
assert.equal(carouselPaneSibling(carouselTree, paneAt('two'), 'down'), undefined, 'last pane stays in its carousel')
assert.equal(carouselPaneSibling(carouselTree, paneAt('three'), 'up'), undefined, 'first pane stays in its carousel')
assert.equal(carouselPaneSibling(carouselTree, paneAt('one'), 'down')?.id, 'two')
assert.equal(carouselPaneSibling(carouselTree, paneAt('two'), 'up')?.id, 'one')
const swappedPanes = reorderStructure(carousels, [paneLine('one')], paneLine('two'), 'after')
assert.ok(swappedPanes.text, swappedPanes.error)
assert.deepEqual(readSlides(swappedPanes.text).slides.map(slide => slide.id), ['first', 'two', 'one', 'second', 'three'])
assert.ok(reorderStructure(carousels, [paneLine('two')], paneLine('three'), 'after').error)
console.log('Structure source edits preserved IDs, notes, comments, code and CRLF.')

const sectionPicture = previewLayout(added.text, 'summer', 'section', [{ group: 'container-mode', token: 'contents' }])
assert.match(sectionPicture, /##  \{id=summer\}\r\n[^\n]*\{contents\}/)
const subsectionPicture = previewLayout(subsection.text, 'plans', 'subsection', [{ group: 'container-mode', token: 'grid-zoom' }])
assert.match(subsectionPicture, /###  \{id=plans\}\r\n[^\n]*\{grid-zoom\}/)
