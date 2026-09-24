import assert from 'node:assert/strict'
import {
  appendImportSources,
  effectiveImportDestination,
  importRequestsForBatch,
  resetImportDestination,
  setImportDestination
} from '../src/shared/importer-batch.ts'

const source = (path, fileName) => ({
  path,
  fileName,
  hash: fileName,
  bytes: 10,
  slideCount: 2,
  width: 100,
  height: 50
})

const a = source('/decks/a.pptx', 'a.pptx')
const b = source('/decks/b.pptx', 'b.pptx')
const c = source('/decks/c.pptx', 'c.pptx')

assert.deepEqual(
  appendImportSources([a, b], [b, c]).map((item) => item.path),
  [a.path, b.path, c.path],
  'append preserves existing order and ignores duplicate resolved paths'
)

let overrides = setImportDestination({}, b.path, 'Research/B')
assert.equal(effectiveImportDestination(a.path, 'York', overrides), 'York')
assert.equal(effectiveImportDestination(b.path, 'York', overrides), 'Research/B')
assert.equal(effectiveImportDestination(a.path, 'Oxford', overrides), 'Oxford')
assert.equal(effectiveImportDestination(b.path, 'Oxford', overrides), 'Research/B')

overrides = resetImportDestination(overrides, b.path)
assert.equal(effectiveImportDestination(b.path, 'Oxford', overrides), 'Oxford')

const settings = {
  includeHidden: true,
  preserveNotes: true,
  extractMedia: true,
  fallbackPolicy: 'uncertain',
  renderer: 'automatic',
  cleanupPasses: []
}

const requests = importRequestsForBatch({
  sources: [a, b],
  singleTitle: 'Unused for a batch',
  singleSlug: 'unused-for-a-batch',
  defaultDestination: 'York',
  destinationOverrides: { [b.path]: 'Research/B' },
  slideRange: '',
  settings
})

assert.deepEqual(requests.map((request) => request.options.topicFolder), ['York', 'Research/B'])
assert.deepEqual(requests.map((request) => request.options.title), ['a', 'b'])
assert.deepEqual(requests.map((request) => request.options.slug), ['a', 'b'])

const singleRequest = importRequestsForBatch({
  sources: [a],
  singleTitle: 'Custom title',
  singleSlug: 'custom-title',
  defaultDestination: '',
  destinationOverrides: {},
  slideRange: '1-2',
  settings
})[0]

assert.equal(singleRequest.options.title, 'Custom title')
assert.equal(singleRequest.options.slug, 'custom-title')
assert.equal(singleRequest.options.topicFolder, '')
assert.equal(singleRequest.options.slideRange, '1-2')

console.log('importer batch: append, destinations and requests passed')
