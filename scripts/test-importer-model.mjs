import assert from 'node:assert/strict'
import { mapThumbnailsBySlideId, moveSelection, visibleSlides } from '../src/renderer/src/components/importerModel.ts'

const slides = [
  { slideNumber: 1, title: 'Opening', status: 'converted', warnings: [] },
  { slideNumber: 2, title: 'Research process', status: 'review', warnings: ['grouping-ambiguous'] },
  { slideNumber: 3, title: 'Chart', status: 'fallback', warnings: ['chart-unsupported'] },
  { slideNumber: 4, title: 'Broken', status: 'failed', warnings: ['slide-xml-invalid'] }
]

assert.deepEqual(visibleSlides(slides, '', 'all').map((slide) => slide.slideNumber), [1, 2, 3, 4])
assert.deepEqual(visibleSlides(slides, '', 'flagged').map((slide) => slide.slideNumber), [2, 3, 4])
assert.deepEqual(visibleSlides(slides, '', 'fallback').map((slide) => slide.slideNumber), [3])
assert.deepEqual(visibleSlides(slides, '', 'failed').map((slide) => slide.slideNumber), [4])
assert.deepEqual(visibleSlides(slides, 'chart', 'all').map((slide) => slide.slideNumber), [3])
assert.deepEqual(visibleSlides(slides, 'grouping-ambiguous', 'all').map((slide) => slide.slideNumber), [2])
assert.equal(moveSelection(slides, 1, -1), 1)
assert.equal(moveSelection(slides, 2, 1), 3)
assert.equal(moveSelection(slides, 4, 1), 4)
assert.equal(moveSelection([], null, 1), null)

assert.deepEqual(mapThumbnailsBySlideId([
  { slide_id: 'pptx-source-001', render_hash: 'render-a', content_hash: 'content-a' },
  { slide_id: 'pptx-source-002', render_hash: '', content_hash: 'content-b' }
], {
  'render-a': 'twthumb://talk/render-a',
  'content-b': 'twthumb://talk/content-b'
}), {
  'pptx-source-001': 'twthumb://talk/render-a',
  'pptx-source-002': 'twthumb://talk/content-b'
})

console.log('importer model: filters, keyboard movement and compiled-preview key mapping passed')
