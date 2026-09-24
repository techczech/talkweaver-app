import { strict as assert } from 'node:assert'
import { isSearchIndexEntryFresh } from '../src/main/search-index-freshness.ts'

// Regression 2026-09-15: search-index.json entries checked by outline mtime alone survived a
// compiler upgrade with stale render_hash rows, so the Slide Browser asked for thumbnails no
// build would ever write. Freshness needs mtime AND compiler tag AND tag-carrying rows.

const rows = [{ tags: [] }, { tags: ['x'] }]
const fresh = { mtimeMs: 1000, compilerTag: 'thumb-cache-v9-aaaa', rows }

assert.equal(isSearchIndexEntryFresh(fresh, 1000, 'thumb-cache-v9-aaaa'), true, 'same mtime + same compiler + tagged rows is fresh')
assert.equal(isSearchIndexEntryFresh(undefined, 1000, 'thumb-cache-v9-aaaa'), false, 'no entry is stale')
assert.equal(isSearchIndexEntryFresh(fresh, 1001, 'thumb-cache-v9-aaaa'), false, 'outline edited → stale')
assert.equal(isSearchIndexEntryFresh(fresh, 1000, 'thumb-cache-v9-bbbb'), false, 'compiler changed → stale (render_hash keys moved)')
assert.equal(isSearchIndexEntryFresh({ ...fresh, compilerTag: 'thumb-cache-v8-aaaa' }, 1000, 'thumb-cache-v9-aaaa'), false, 'old picture-key namespace is stale')
assert.equal(isSearchIndexEntryFresh({ mtimeMs: 1000, rows }, 1000, 'thumb-cache-v9-aaaa'), false, 'entry persisted before the tag existed → stale')
assert.equal(isSearchIndexEntryFresh({ mtimeMs: 1000, compilerTag: 'thumb-cache-v9-aaaa', rows: [{}] }, 1000, 'thumb-cache-v9-aaaa'), false, 'rows without tags → stale')
assert.equal(isSearchIndexEntryFresh({ mtimeMs: 1000, compilerTag: 'thumb-cache-v9-aaaa', rows: [] }, 1000, 'thumb-cache-v9-aaaa'), true, 'an empty talk with the right mtime and compiler is fresh')

console.log('PASS search-index freshness: mtime, compiler tag and tagged rows all required')
