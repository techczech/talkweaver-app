import assert from 'node:assert/strict'
import {
  headingPathsBySlide,
  parseHeadings,
  slideImageRefs,
  slideImages,
  toTalkTextRows
} from '../src/main/talkTextAdapter.ts'

// Heading-slide outline: each heading line is a slide. A fenced code block hides a '#' that must NOT
// be read as a heading; one heading carries a Trigger token to strip; depth jumps 3→4 and back to 2.
const outline = [
  '# Weaving Talks',            // 1 depth1
  '',                           // 2
  '## Why a different tool',    // 3 depth2
  '',                           // 4
  '### The blank-canvas problem', // 5 depth3
  '',                           // 6
  '```',                        // 7 fence open
  '# not a heading',            // 8 (inside fence)
  '```',                        // 9 fence close
  '',                           // 10
  '#### Why slides fight you {layout=quote}', // 11 depth4 + trigger
  '',                           // 12
  '## From delivery'            // 13 depth2
].join('\n')

const headings = parseHeadings(outline)
assert.deepEqual(headings.map((h) => [h.line, h.depth, h.rawTitle]), [
  [1, 1, 'Weaving Talks'],
  [3, 2, 'Why a different tool'],
  [5, 3, 'The blank-canvas problem'],
  [11, 4, 'Why slides fight you'],
  [13, 2, 'From delivery']
])

const rows = [
  { slide_id: 's0', title: 'Weaving Talks', source_line: 1, source_markdown: '# Weaving Talks' },
  { slide_id: 's1', title: 'Why a different tool', source_line: 3, source_markdown: '## Why a different tool' },
  { slide_id: 's2', title: 'The blank-canvas problem', source_line: 5, source_markdown: '### The blank-canvas problem' },
  { slide_id: 's3', title: 'Why slides fight you', nav_title: 'Slides fight you', source_line: 11,
    source_markdown: '#### Why slides fight you\n\n![A cluttered editor](assets/img-abc123.png)\n\nAlso img-def456 here.',
    render_hash: 'render-s3', content_hash: 'content-s3' },
  { slide_id: 's4', title: 'From delivery', source_line: 13, source_markdown: '## From delivery',
    content_hash: 'content-s4' },
  { slide_id: 'sX', title: 'Synthesised closing', source_line: null, source_markdown: '' }
]

const paths = headingPathsBySlide(outline, rows)
assert.deepEqual(paths.get('s0'), [])
assert.deepEqual(paths.get('s1'), ['Weaving Talks'])
assert.deepEqual(paths.get('s2'), ['Weaving Talks', 'Why a different tool'])
// depth-4 slide: full three-level ancestry (uses nav_title of its own heading when pushed, not here).
assert.deepEqual(paths.get('s3'), ['Weaving Talks', 'Why a different tool', 'The blank-canvas problem'])
// back up to depth-2: only the H1 remains as ancestry.
assert.deepEqual(paths.get('s4'), ['Weaving Talks'])
// no source line (synthesised) → root.
assert.deepEqual(paths.get('sX'), [])

// Image refs: markdown image + bare token, de-duplicated, id = basename without extension.
assert.deepEqual(slideImageRefs(rows[3].source_markdown), [
  { id: 'img-abc123', alt: 'A cluttered editor' },
  { id: 'img-def456', alt: '' }
])

// Sidecar wins for alt; caption becomes the extracted search text (ocrText). No sidecar → src only.
const sidecars = new Map([['img-abc123', { alt: 'Editor chrome', caption: 'Insert · Layout · Design Ideas' }]])
assert.deepEqual(slideImages(rows[3].source_markdown, sidecars), [
  { src: 'img-abc123', alt: 'Editor chrome', ocrText: 'Insert · Layout · Design Ideas' },
  { src: 'img-def456' }
])

// End-to-end mapping.
const mapped = toTalkTextRows(outline, rows, sidecars)
const s3 = mapped.find((row) => row.slideId === 's3')
assert.equal(s3.navTitle, 'Slides fight you')
assert.equal(s3.thumbKey, 'render-s3')
assert.deepEqual(s3.headingPath, ['Weaving Talks', 'Why a different tool', 'The blank-canvas problem'])
assert.equal(s3.images.length, 2)
assert.equal(mapped.find((row) => row.slideId === 's4').thumbKey, 'content-s4')
assert.equal(mapped.find((row) => row.slideId === 's0').images.length, 0)
assert.equal(mapped.find((row) => row.slideId === 'sX').thumbKey, undefined)
assert.deepEqual(mapped.find((row) => row.slideId === 'sX').headingPath, [])

console.log('talktext-adapter: heading parse, fenced-code skip, deep + sparse ancestry, image refs and sidecar text passed')
