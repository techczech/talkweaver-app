import assert from 'node:assert/strict'
import {
  buildTalkTextModel,
  exportText,
  formatTimecode,
  renderNotesMarkdown,
  renderScriptMarkdown
} from '../src/main/talkText.ts'

const meta = {
  talkSlug: 'weaving-talks',
  talkTitle: 'Weaving Talks',
  speaker: 'Dominik Lukeš',
  recordedMs: 16000
}

// Ancestry is the explicit headingPath (root-first). Depth is unbounded: s3 sits three headings deep,
// and nothing here relies on a prior row having introduced the intermediate levels.
const rows = [
  { slideId: 's1', title: 'Opening', headingPath: ['Part one'] },
  {
    slideId: 's2',
    title: 'The method',
    headingPath: ['Part one', 'Section A'],
    markdown: '### The method\n\n![diagram](img/method.png)',
    images: [{ src: 'img/method.png', alt: 'A method diagram', ocrText: 'Step 1 · Step 2 · Step 3' }]
  },
  { slideId: 's3', title: 'A deep point', headingPath: ['Part one', 'Section A', 'Topic i'] },
  { slideId: 's4', title: 'Root close' }
]
const slideTimeIndex = [
  { event: 'pause', tMs: 500 },
  { event: 'enter', slideId: 's1', tMs: 1000 },
  { event: 'enter', slideId: 's2', tMs: 5000 },
  { event: 'enter', slideId: 's3', tMs: 9000 },
  { event: 'enter', slideId: 's4', tMs: 12000 }
]
const segments = [
  { start: 1000, end: 1600, text: 'welcome to the talk.' },
  { start: 4999, end: 5200, text: 'this starts before the next slide.' },
  { start: 5000, end: 5600, text: 'here is the method.' },
  { start: 8800, end: 9200, text: 'this only partly overlaps the trim.' },
  { start: 9100, end: 9300, text: 'drop this.' },
  { start: 9500, end: 9800, text: 'deep detail! another thought?' }
]

const model = buildTalkTextModel({
  rows,
  slideTimeIndex,
  segments,
  trims: [{ start: 9000, end: 9500 }],
  meta
})

assert.deepEqual(model.slides.map(({ slideNumber, slideId, startMs, endMs }) => ({ slideNumber, slideId, startMs, endMs })), [
  { slideNumber: 1, slideId: 's1', startMs: 1000, endMs: 5000 },
  { slideNumber: 2, slideId: 's2', startMs: 5000, endMs: 9000 },
  { slideNumber: 3, slideId: 's3', startMs: 9000, endMs: 12000 },
  { slideNumber: 4, slideId: 's4', startMs: 12000, endMs: 16000 }
])
assert.deepEqual(model.slides.map((slide) => slide.segments.map((segment) => segment.text)), [
  ['welcome to the talk.', 'this starts before the next slide.'],
  ['here is the method.', 'this only partly overlaps the trim.'],
  ['deep detail! another thought?'],
  []
])
assert.deepEqual(model.slides.map((slide) => slide.sectionPath), [
  ['Part one'],
  ['Part one', 'Section A'],
  ['Part one', 'Section A', 'Topic i'],
  []
])
// Slide content given to the agent: authored Markdown (image refs + alt) plus the text extracted
// from each image for search. Slides without content carry '' / [] rather than undefined.
assert.equal(model.slides[1].markdown, '### The method\n\n![diagram](img/method.png)')
assert.deepEqual(model.slides[1].images, [{ src: 'img/method.png', alt: 'A method diagram', ocrText: 'Step 1 · Step 2 · Step 3' }])
assert.equal(model.slides[0].markdown, '')
assert.deepEqual(model.slides[0].images, [])
assert.deepEqual(model.outline, [
  {
    title: 'Part one',
    depth: 1,
    children: [
      { title: 'Opening', depth: 2, slideNumber: 1, children: [] },
      {
        title: 'Section A',
        depth: 2,
        children: [
          { title: 'The method', depth: 3, slideNumber: 2, children: [] },
          {
            title: 'Topic i',
            depth: 3,
            children: [
              { title: 'A deep point', depth: 4, slideNumber: 3, children: [] }
            ]
          }
        ]
      }
    ]
  },
  { title: 'Root close', depth: 1, slideNumber: 4, children: [] }
])

const repeated = buildTalkTextModel({
  rows: rows.slice(0, 2),
  slideTimeIndex: [
    { event: 'enter', slideId: 's1', tMs: 0 },
    { event: 'enter', slideId: 's2', tMs: 2000 },
    { event: 'enter', slideId: 's1', tMs: 4000 }
  ],
  segments: [{ start: 4500, end: 4700, text: 'back to the opening.' }],
  meta: { ...meta, recordedMs: 6000 }
})
assert.deepEqual(repeated.slides.map((slide) => [slide.slideId, slide.slideNumber, slide.startMs, slide.endMs]), [
  ['s1', 1, 0, 2000],
  ['s2', 2, 2000, 4000],
  ['s1', 1, 4000, 6000]
])
assert.deepEqual(repeated.slides.map((slide) => slide.segments.length), [0, 0, 1])

// A single deep slide with no sibling rows must still nest fully — ancestry is self-contained,
// never reconstructed from neighbouring rows (the failure mode the old carry-forward risked).
const lone = buildTalkTextModel({
  rows: [{ slideId: 'd', title: 'Lone leaf', headingPath: ['Alpha', 'Beta', 'Gamma'] }],
  slideTimeIndex: [{ event: 'enter', slideId: 'd', tMs: 0 }],
  segments: [],
  meta: { ...meta, recordedMs: 1000 }
})
assert.deepEqual(lone.slides[0].sectionPath, ['Alpha', 'Beta', 'Gamma'])
assert.deepEqual(lone.outline, [
  { title: 'Alpha', depth: 1, children: [
    { title: 'Beta', depth: 2, children: [
      { title: 'Gamma', depth: 3, children: [
        { title: 'Lone leaf', depth: 4, slideNumber: 1, children: [] }
      ] }
    ] }
  ] }
])

const raw = renderScriptMarkdown(model, { timecodes: true })
assert.match(raw, /^# Part one$/m)
assert.match(raw, /^#### Slide 3 — A deep point$/m)
assert.match(raw, /00:09–00:12/)
assert.match(raw, /deep detail! another thought\?/)

const agentCleaned = renderScriptMarkdown(model, {
  cleanedBySlide: new Map([
    [1, 'Welcome to the talk.\n\nThis starts before the next slide.'],
    [3, 'Deep detail! Another thought?']
  ])
})
assert.match(agentCleaned, /Welcome to the talk\.\n\nThis starts before the next slide\./)
assert.match(agentCleaned, /Deep detail! Another thought\?/)
assert.match(agentCleaned, /here is the method\./, 'slides without an approved clean fall back to raw')
assert.doesNotMatch(agentCleaned, /drop this/i)
assert.doesNotMatch(agentCleaned, /^\d{2}:\d{2}–\d{2}:\d{2}$/m, 'timecodes are omitted when the Include toggle is off')

assert.equal(renderNotesMarkdown(model, [
  { slug: 'later', order: 20, markdown: 'Later <!-- added -->context<!-- /added -->' },
  { slug: 'first', order: 10, markdown: 'First part' }
]), 'First part\n\nLater <!-- added -->context<!-- /added -->')

const markdown = '# Heading\n\nA **bold** [link](https://example.com).\n\n- First\n- Second'
assert.equal(exportText(markdown, 'markdown'), markdown)
const plain = exportText(markdown, 'plain')
assert.equal(plain, 'Heading\n\nA bold link.\n\n- First\n- Second')
const rich = exportText(markdown, 'rich')
assert.match(rich, /<h1>Heading<\/h1>/)
assert.match(rich, /<p>A <strong>bold<\/strong> <a href="https:\/\/example\.com">link<\/a>\.<\/p>/)
assert.match(rich, /<ul><li>First<\/li><li>Second<\/li><\/ul>/)
assert.equal(
  exportText('A ==useful point==.', 'plain'),
  'A useful point.',
  'plain Talk Text export strips marker delimiters instead of exposing == source'
)
assert.equal(
  exportText('A `==literal marker==` in code.', 'plain'),
  'A ==literal marker== in code.',
  'plain Talk Text strips code delimiters after protecting marker syntax inside code'
)
assert.match(
  exportText('A ==useful point==.', 'rich'),
  /<p>A <mark class="ink-marker">useful point<\/mark>\.<\/p>/,
  'rich Talk Text export renders the shared warm marker instead of exposing == source'
)

assert.equal(formatTimecode(65000), '01:05')
assert.equal(formatTimecode(3661000), '1:01:01')

const empty = buildTalkTextModel({
  rows: [{ slideId: 'only', title: 'Silent slide' }],
  slideTimeIndex: [{ event: 'enter', slideId: 'only', tMs: 0 }],
  segments: [],
  meta: { ...meta, recordedMs: 1000 }
})
assert.equal(empty.slides.length, 1)
assert.deepEqual(empty.slides[0].segments, [])
assert.doesNotThrow(() => renderScriptMarkdown(empty))

assert.equal(buildTalkTextModel({
  rows: [],
  slideTimeIndex: [{ event: 'enter', slideId: 'only', tMs: 0 }],
  segments: [],
  meta: { ...meta, recordedMs: 1000 }
}), null, 'a Run with no compiled slide rows has no usable text model')
assert.equal(buildTalkTextModel({
  rows: [{ slideId: 'only', title: 'Silent slide' }],
  slideTimeIndex: [],
  segments: [],
  meta: { ...meta, recordedMs: 1000 }
}), null, 'a Run with no enter marks has no usable text model')
assert.equal(buildTalkTextModel({
  rows: [{ slideId: 'compiled', title: 'Compiled slide' }],
  slideTimeIndex: [{ event: 'enter', slideId: 'recorded-elsewhere', tMs: 0 }],
  segments: [],
  meta: { ...meta, recordedMs: 1000 }
}), null, 'enter marks that match no compiled slide rows have no usable text model')

console.log('talktext: windows, transcript join, trims, recursive outline, renders and exports passed')
