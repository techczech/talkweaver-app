import assert from 'node:assert/strict'
import { parseNotesMarkdown } from '../src/renderer/src/notesMarkdown.ts'
import { renderNotesMarkdown } from '../src/main/talkText.ts'

const blocks = parseNotesMarkdown(`**Key points:**

- A **grounded term** matters
- Follow the evidence on [slide 3](/slides/3)

### A useful subsection

Dominik connected **structure** to [slide 4](/slides/4). <!-- added -->This bridge was added for readability.<!-- /added -->

#### Slide 4 — A deeper point

The explanation continues.`)

assert.equal(blocks[0].kind, 'key-points', 'the labelled bullet group becomes a key-points block')
assert.equal(blocks[0].className, 'narr')
assert.equal(blocks[0].items.length, 2)
assert.deepEqual(blocks[0].items[0], [
  { kind: 'text', text: 'A ' },
  { kind: 'strong', children: [{ kind: 'text', text: 'grounded term' }] },
  { kind: 'text', text: ' matters' }
])

assert.deepEqual(blocks[1], {
  kind: 'heading',
  level: 3,
  className: 'mid-head',
  text: 'A useful subsection'
})

assert.equal(blocks[2].kind, 'paragraph')
assert.equal(blocks[2].className, 'narr')
assert.deepEqual(blocks[2].children, [
  { kind: 'text', text: 'Dominik connected ' },
  { kind: 'strong', children: [{ kind: 'text', text: 'structure' }] },
  { kind: 'text', text: ' to ' },
  { kind: 'slide-ref', className: 'sref', slideNumber: 4, label: 'Slide 4' },
  { kind: 'text', text: '. ' },
  {
    kind: 'added',
    className: 'added',
    title: 'Added in Notes — not said aloud.',
    children: [{ kind: 'text', text: 'This bridge was added for readability.' }]
  }
])

assert.deepEqual(blocks[3], {
  kind: 'heading',
  level: 4,
  className: 'leaf-head',
  slideNumber: 4,
  text: 'A deeper point'
})

const loneMarker = parseNotesMarkdown('A grounded sentence. <!-- added -->A short bridge.')
assert.equal(loneMarker[0].kind, 'paragraph')
assert.equal(loneMarker[0].children.at(-1).kind, 'added', 'a lone added marker extends to the paragraph end')

const range = parseNotesMarkdown('Compare [slides 8-10](/slides/8).')
assert.deepEqual(range[0].children[1], { kind: 'slide-ref', className: 'sref', slideNumber: 8, label: 'Slides 8–10' })

const hostile = parseNotesMarkdown('<img src=x onerror="alert(1)"> stays text.')
assert.deepEqual(hostile[0].children, [{ kind: 'text', text: '<img src=x onerror="alert(1)"> stays text.' }])

const model = { meta: {}, outline: [], slides: [] }
const parts = [{ slug: 'part', order: 1, markdown: 'See [slide 7](/slides/7) and [slides 8-10](/slides/8).' }]
assert.equal(
  renderNotesMarkdown(model, parts, { references: false }),
  'See slide 7 and slides 8-10.',
  'Notes export removes slide links but keeps readable reference text'
)
assert.equal(
  renderNotesMarkdown(model, parts, { references: true }),
  parts[0].markdown,
  'Notes export preserves slide links when requested'
)

console.log('notes markdown: key points, headings, bold, slide refs, added markers and export stripping passed')
