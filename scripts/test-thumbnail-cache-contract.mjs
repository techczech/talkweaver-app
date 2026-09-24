import assert from 'node:assert/strict'
import * as preview from '../src/shared/slide-preview.ts'
assert.equal(typeof preview.thumbnailSlides,'function','all thumbnail callers share the same cache-key policy')
const rows=[{slide_id:'empty'}, {slide_id:'one',render_hash:'one-render',thumbnail_hash:'a'.repeat(64)}, {slide_id:'two',render_hash:'two-render',thumbnail_hash:'b'.repeat(64)}]
const old=preview.thumbnailSlides(rows,'old-doc')
const next=preview.thumbnailSlides(rows,'edited-doc')
assert.equal(old[1].cacheKey,next[1].cacheKey,'unaffected compiled slide survives unrelated document change')
assert.notEqual(old[0].cacheKey,next[0].cacheKey,'legacy rows still invalidate conservatively')
assert.deepEqual(preview.selectedThumbnailSlide(rows,'two','edited-doc'),next[2],'selected and full-strip previews share picture identity and absolute index')
const withGap=preview.thumbnailSlides([{},rows[1]],'doc')
assert.equal(withGap[0].index,1,'filtering an unaddressable row never shifts capture to the wrong slide')
const changed=preview.thumbnailSlides([rows[0],{...rows[1],thumbnail_hash:'c'.repeat(64)},rows[2]],'edited-doc')
assert.notEqual(changed[1].cacheKey,old[1].cacheKey,'affected picture invalidates even when logical render key is unchanged')
console.log('PASS thumbnail cache contract: reuse, shared callers, legacy safety, indexed capture')
