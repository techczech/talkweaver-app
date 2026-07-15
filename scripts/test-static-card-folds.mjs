import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

let failures = 0

function assert(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`)
    failures++
  }
}

function count(text, pattern) {
  return (String(text).match(pattern) || []).length
}

const dir = mkdtempSync(join(tmpdir(), 'tw-static-folds-'))
let probeNumber = 0

async function compile(label, body) {
  const source = [
    '---',
    `title: ${label}`,
    'auto_title_slide: false',
    'auto_thanks_slide: false',
    '---',
    '',
    body,
  ].join('\n')
  const sourcePath = join(dir, `${++probeNumber}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`)
  writeFileSync(sourcePath, source, 'utf8')
  const model = await prepareSource(sourcePath, source, label, statSync(sourcePath))
  const html = await buildDeckHtmlFromModel(model)
  return { model, html }
}

const cardChildren = [
  '#### AI as Oracle',
  '',
  '- Capabilities: answer questions, summarise, translate',
  '- Chatbots: ChatGPT, Gemini, Claude',
  '- Specialist apps: NotebookLM, Elicit, Consensus',
  '',
  '#### AI as Tool Maker',
  '',
  '- Capabilities: write code, manage a code base',
  '- Outcomes: scripts, dashboards, simulations, workflows',
  '- Tools: Cursor, Lovable, Google AI Studio',
  '',
  '#### AI as Tool User',
  '',
  '- Capabilities: plan, work with files, run utilities',
  '- Outcomes: ambitious projects, manage data, replicate analyses',
  '- Desktop agents: Codex, Claude Code, Antigravity',
].join('\n')

const rows = await compile('Rows', [
  '### Three roles of AI {id=rows-parent}',
  '{cards=rows}',
  '',
  cardChildren,
].join('\n'))
const rowsSlide = rows.model.slides.find((slide) => slide.id === 'rows-parent')
const rowsBlock = rowsSlide?.blocks?.find((block) => block.type === 'cards')
assert(rows.model.slides.length === 1, 'cards=rows folds the parent and three children to one content slide')
assert(rowsSlide?.layout === 'cards', 'cards=rows resolves to the cards layout')
assert(rowsSlide?.blocks?.length === 1 && rowsBlock, 'cards=rows produces one cards block')
assert(rowsBlock?.rows === true, 'cards=rows marks the cards block as rows')
assert(rowsBlock?.cards?.length === 3, 'cards=rows produces three cards')
assert(rows.html.includes('card-gallery card-grid cards-rows'), 'cards=rows HTML includes the rows class')
assert(count(rows.html, /class="lblgrp"/g) === 9, 'cards=rows HTML contains nine label groups')
assert(count(rows.html, /<h4(?:\s|>)/g) === 3, 'cards=rows HTML contains three card h4 titles')

const grid = await compile('Grid', [
  '### Three roles of AI {id=grid-parent}',
  '{cards=grid}',
  '',
  cardChildren,
].join('\n'))
const gridSlide = grid.model.slides.find((slide) => slide.id === 'grid-parent')
const gridBlock = gridSlide?.blocks?.find((block) => block.type === 'cards')
assert(grid.model.slides.length === 1, 'cards=grid folds the parent and three children to one content slide')
assert(gridBlock?.rows !== true, 'cards=grid does not mark the cards block as rows')
assert(grid.html.includes('card-gallery card-grid'), 'cards=grid HTML includes the static grid classes')
assert(!grid.html.includes('card-gallery card-grid cards-rows'), 'cards=grid HTML omits the rows class')
assert(count(grid.html, /class="lblgrp"/g) === 9, 'cards=grid HTML contains nine label groups')

const contrastTwo = await compile('Contrast two', [
  '### Two approaches {id=contrast-two}',
  '{contrast}',
  '',
  '#### First approach',
  '',
  'First explanation.',
  '',
  '#### Second approach',
  '',
  'Second explanation.',
].join('\n'))
const contrastSlide = contrastTwo.model.slides.find((slide) => slide.id === 'contrast-two')
const contrastBlock = contrastSlide?.blocks?.find((block) => block.type === 'cards')
assert(contrastTwo.model.slides.length === 1, 'contrast with two children folds to one slide')
assert(contrastSlide?.layout === 'contrast', 'contrast with two children keeps the contrast layout')
assert(contrastSlide?.blocks?.length === 1 && contrastBlock, 'contrast with two children produces one cards block')
assert(contrastBlock?.staticCompare === true, 'contrast cards block is marked staticCompare')
assert(contrastBlock?.cards?.length === 2, 'contrast cards block contains two cards')

const contrastFour = await compile('Contrast four', [
  '### Four approaches {id=contrast-four}',
  '{contrast}',
  '',
  ...Array.from({ length: 4 }, (_, index) => `#### Approach ${index + 1}\n\nExplanation ${index + 1}.`),
].join('\n\n'))
const contrastFourParent = contrastFour.model.slides.find((slide) => slide.id === 'contrast-four')
assert(contrastFour.model.slides.length === 5, 'contrast with four children leaves the parent and four child slides')
assert(contrastFourParent?.layout === 'section-title', 'unfolded contrast parent remains a section-title slide')
assert(contrastFour.model.warnings.some((warning) => warning.startsWith('contrast-groups-count:contrast-four')), 'contrast with four children emits the count warning')

const imageGrid = await compile('Image grid', [
  '### Two images {id=image-grid-parent}',
  '{image-grid}',
  '',
  '#### First image',
  '',
  '![](https://example.com/first.png)',
  '',
  'First caption.',
  '',
  '#### Second image',
  '',
  '![](https://example.com/second.png)',
  '',
  'Second caption.',
].join('\n'))
const imageGridSlide = imageGrid.model.slides.find((slide) => slide.id === 'image-grid-parent')
const imageGridBlock = imageGridSlide?.blocks?.find((block) => block.type === 'image-grid')
assert(imageGrid.model.slides.length === 1, 'image-grid folds two children to one slide')
assert(imageGridBlock?.cells?.length === 2, 'image-grid block contains two cells')

const parentBeats = rows.model.beats.filter((beat) => beat.slideId === 'rows-parent')
assert(rows.model.beats.length === 1 && parentBeats.length === 1 && parentBeats[0].kind === 'slide', 'folded rows tree emits exactly one slide beat for the parent')

const bare = await compile('Bare children', [
  '### Bare parent {id=bare-parent}',
  '',
  '#### Bare child one {id=bare-one}',
  '',
  'First child.',
  '',
  '#### Bare child two {id=bare-two}',
  '',
  'Second child.',
].join('\n'))
assert(bare.model.slides.some((slide) => slide.id === 'bare-one') && bare.model.slides.some((slide) => slide.id === 'bare-two'), 'bare parent still emits its child slides')

const carousel = await compile('Carousel', [
  '### Carousel parent {id=carousel-parent}',
  '{carousel}',
  '',
  '#### Carousel child one',
  '',
  'First child.',
  '',
  '#### Carousel child two',
  '',
  'Second child.',
].join('\n'))
const carouselSlide = carousel.model.slides.find((slide) => slide.id === 'carousel-parent')
assert(carousel.model.slides.length === 1 && carouselSlide?.layout === 'carousel', 'carousel still folds to one carousel slide')
assert(carouselSlide?.carousel?.length === 2, 'carousel slide still contains two sub-slides')

const compare = await compile('Compare', [
  '### Compare parent {id=compare-parent}',
  '{compare}',
  '',
  '#### Compare half one',
  '',
  'First half.',
  '',
  '#### Compare half two',
  '',
  'Second half.',
].join('\n'))
const compareSlide = compare.model.slides.find((slide) => slide.id === 'compare-parent')
assert(compare.model.slides.length === 1, 'compare still folds to one slide')
assert(compareSlide?.blocks?.length === 1 && compareSlide.blocks[0]?.type === 'compare', 'compare still produces the compare block')

if (failures) {
  console.error(`\n${failures} static card fold check(s) failed`)
  process.exit(1)
}

console.log('static card folds: all checks passed')
