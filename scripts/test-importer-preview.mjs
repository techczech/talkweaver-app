import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selectedThumbnailSlide } from '../src/shared/slide-preview.ts'

const rows = [
  { slide_id: 'pptx-source-001', render_hash: 'render-1', content_hash: 'content-1', triggers: { layout: 'statement' } },
  { slide_id: 'pptx-source-002', render_hash: 'render-2', content_hash: 'content-2', triggers: { layout: 'list' } },
  { slide_id: 'pptx-source-003', render_hash: 'render-3', content_hash: 'content-3', triggers: { layout: 'media' } }
]

assert.deepEqual(selectedThumbnailSlide(rows, 'pptx-source-003', 'document'), {
  key: 'render-3',
  cacheKey: 'document-render-3',
  layout: 'media',
  index: 2
})
assert.equal(selectedThumbnailSlide(rows, 'missing', 'document'), null)

const thumbnails = readFileSync(new URL('../src/main/thumbnails.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
assert.match(thumbnails, /slide\.index \?\? arrayIndex/)
assert.match(main, /talk:selected-thumbnail/)
assert.match(main, /slides: \[selected\]/)

console.log('importer preview: stable slide id maps to one indexed thumbnail request')
