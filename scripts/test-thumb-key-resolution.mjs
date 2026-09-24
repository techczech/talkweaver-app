#!/usr/bin/env node
/**
 * The Slide Browser addresses a thumbnail by its bare render_hash; the pre-render writes it under a
 * DOCUMENT-SCOPED filename `<documentId>-<render_hash>.png`. The twthumb handler must bridge that
 * gap, or every browser card renders blank against thumbnails that are physically present — which is
 * exactly what happened on 2026-07-19 (66k built PNGs, 0 reachable).
 *
 * This pins the filename<->key contract the handler's suffix resolver relies on:
 *   - documentId is exactly 16 hex chars (thumbnailDocumentId slices to 16),
 *   - render_hash is `sha256-<hex>` and itself contains a dash,
 *   - so the bare key is recovered by stripping ONLY the 16-hex prefix, never by last-dash split.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { thumbnailDocumentCacheKey } from '../src/shared/slide-preview.ts'

// The resolver logic, mirrored from src/main/index.ts resolveThumbBySuffix. Kept in sync by shape:
// a filename `<16hex>-<key>.png` maps to bare `<key>`; anything else maps as-is.
function buildBareIndex(dir) {
  const byKey = new Map()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.png')) continue
    const base = name.slice(0, -4)
    const m = /^[0-9a-f]{16}-(.+)$/.exec(base)
    const bare = m ? m[1] : base
    if (!byKey.has(bare)) byKey.set(bare, join(dir, name))
  }
  return byKey
}

const dir = mkdtempSync(join(tmpdir(), 'talkweaver-thumb-key-'))

// A realistic render_hash (contains a dash) and a 16-hex documentId, exactly as production writes.
const renderHash = 'sha256-' + createHash('sha256').update('slide-model').digest('hex')
const documentId = createHash('sha256').update('deck-html').digest('hex').slice(0, 16)
const cacheKey = thumbnailDocumentCacheKey(documentId, renderHash)

assert.equal(cacheKey, `${documentId}-${renderHash}`, 'cacheKey is documentId-prefixed render_hash')
assert.match(documentId, /^[0-9a-f]{16}$/, 'documentId is 16 hex chars')

writeFileSync(join(dir, cacheKey + '.png'), 'x')
// A second documentId for the SAME render_hash (a re-compile) — resolver must still find one.
const doc2 = createHash('sha256').update('deck-html-2').digest('hex').slice(0, 16)
writeFileSync(join(dir, thumbnailDocumentCacheKey(doc2, renderHash) + '.png'), 'x')
// A legacy bare file for a different slide.
const legacy = 'sha256-' + createHash('sha256').update('legacy').digest('hex')
writeFileSync(join(dir, legacy + '.png'), 'x')

const index = buildBareIndex(dir)

const resolved = index.get(renderHash)
assert.ok(resolved, `bare render_hash ${renderHash} must resolve to a document-scoped file`)
assert.ok(resolved.endsWith(`${renderHash}.png`), 'resolved file ends with the full render_hash')
assert.ok(/[0-9a-f]{16}-sha256-/.test(resolved), 'resolved file carries the documentId prefix')

assert.ok(index.get(legacy), 'a legacy un-prefixed file resolves as-is')

// The critical bug: a naive last-dash split would recover only the hex after "sha256-", not the
// full "sha256-<hex>" key — so assert the key we index by is the WHOLE render_hash.
assert.ok(index.has(renderHash), 'indexed by the full sha256-prefixed key, not the trailing hex')
assert.ok(!index.has(renderHash.split('-')[1]), 'not indexed by the trailing hex alone')

console.log('thumb key resolution: bare render_hash resolves to document-scoped filenames (legacy + prefixed)')
