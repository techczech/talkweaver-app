// A picked slide's picture address on THIS machine (src/renderer/src/lib/scratchpadSourceThumbs.ts). The saved
// state travels with the talk folder, but a vault id is a per-machine registry id: a vault-qualified twthumb://
// URL reads that vault's cache folder only, so a stale id 404s for ever even after the talk was rendered. The
// address is re-derived from the source talk's current rows once the talk has been rendered.
import assert from 'node:assert/strict'
import { deriveSlidePicture, slidePictureFor, noteSourceThumbUnavailable, onThumbRegen, thumbRegenNonce, resetSourceThumbs } from '../src/renderer/src/lib/scratchpadSourceThumbs.ts'
import { sourceThumbnailClient } from '../src/renderer/src/lib/slideThumbnails.ts'
import { thumbUrl } from '../src/renderer/src/lib/thumbUrl.ts'

let checks = 0
const test = async (name, fn) => { try { await fn(); checks++ } catch (e) { console.error(`FAIL ${name}`); throw e } }
const OUTLINE = '/fixture/vault/sample-talks/sample-talk/sample-talk-outline.md'
const saved = { talkPath: 'sample-talks/sample-talk/sample-talk-outline.md', talkTitle: 'Sample talk', slideId: 'jylt5', title: 'A sample slide.', markdown: '', thumbKey: 'sha256-OLD', talkSlug: 'sample-talk', vaultId: 'stale-vault' }
const vaults = [{ id: 'this-machine-vault', root: '/fixture/vault/' }]
const row = (over = {}) => ({ slide_id: 'jylt5', render_hash: 'sha256-NEW', content_hash: 'c', talkSlug: 'sample-talk', outlinePath: OUTLINE, ...over })

await test('derivation takes slug and key from the current row and the vault from the folder that holds the outline', () => {
  const pic = deriveSlidePicture(saved, OUTLINE, vaults, [row({ slide_id: 'other' }), row()])
  assert.deepEqual(pic, { talkSlug: 'sample-talk', thumbKey: 'sha256-NEW', vaultId: 'this-machine-vault' })
  assert.equal(thumbUrl(pic.talkSlug, pic.thumbKey, pic.vaultId), 'twthumb://thumb/sample-talk/sha256-NEW?vault=this-machine-vault')
})
await test('the row\'s own vault id wins; a missing render_hash falls back to content_hash then slide id; no row = null', () => {
  assert.equal(deriveSlidePicture(saved, OUTLINE, vaults, [row({ vaultId: 'row-vault' })]).vaultId, 'row-vault')
  assert.equal(deriveSlidePicture(saved, OUTLINE, vaults, [row({ render_hash: '' })]).thumbKey, 'c')
  assert.equal(deriveSlidePicture(saved, OUTLINE, vaults, [row({ render_hash: '', content_hash: '' })]).thumbKey, 'jylt5')
  assert.equal(deriveSlidePicture(saved, OUTLINE, vaults, []), null)
  assert.equal(deriveSlidePicture(saved, OUTLINE, vaults, [row({ outlinePath: '/elsewhere.md' })]), null)
})
await test('with no fix the saved address is used; after the talk is rendered the re-derived one replaces it and the card is told to reload', async () => {
  resetSourceThumbs()
  assert.equal(slidePictureFor(saved).vaultId, 'stale-vault')
  let searched = 0
  globalThis.window = { tw: {
    vault: { list: async () => vaults },
    talk: { readOutline: async (p) => (p === OUTLINE ? '## x' : null), thumbnails: async () => ({ a: 'x.png' }) },
    search: { allSlides: async (q) => { searched++; assert.equal(q.scope, 'title'); return [row()] } }
  } }
  const reloaded = new Promise((resolve) => onThumbRegen(resolve))
  noteSourceThumbUnavailable(saved)
  await reloaded
  assert.equal(searched, 1)
  assert.equal(thumbRegenNonce(saved.talkPath), 1)
  assert.deepEqual(slidePictureFor(saved), { talkSlug: 'sample-talk', thumbKey: 'sha256-NEW', vaultId: 'this-machine-vault' })
})
await test('portable fallback and Browser source paths stay separate even when the first vault read fails', async () => {
  resetSourceThumbs()
  const source = { ...saved, talkPath: 'topic/shared/shared-outline.md', vaultId: 'old-machine' }
  const a = '/vault-A/' + source.talkPath, b = '/vault-B/' + source.talkPath
  const calls = [], seen = []
  let readsA = 0
  window.tw = {
    vault: { list: async () => [{ id: 'a', root: '/vault-A' }, { id: 'b', root: '/vault-B' }] },
    talk: {
      readOutline: async path => path === a ? (++readsA === 1 ? null : 'A') : path === b ? 'B' : null,
      thumbnails: async path => { calls.push(path); return { h: path } }
    },
    search: { allSlides: async () => [] }
  }
  const browser = sourceThumbnailClient((key, map) => seen.push([key, map.h]))
  try {
    noteSourceThumbUnavailable(source)
    browser.note(a)
    for (let i = 0; i < 15 && (seen.length === 0 || thumbRegenNonce(source.talkPath) === 0); i++) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [b, a])
    assert.deepEqual(seen, [[a, a]])
    assert.equal(thumbRegenNonce(source.talkPath), 1)
  } finally { browser.dispose(); resetSourceThumbs() }
})
await test('a second missing slide in a rendered Scratchpad talk rederives and notifies once more within the two-attempt budget', async () => {
  resetSourceThumbs()
  let renders = 0, notifications = 0
  const second = { ...saved, slideId: 'second', title: 'A second slide' }
  window.tw = {
    vault: { list: async () => vaults },
    talk: { readOutline: async () => '## source', thumbnails: async () => { renders++; return { h: 'image' } } },
    search: { allSlides: async () => [row(), row({ slide_id: 'second', render_hash: 'second-NEW' })] }
  }
  const unsubscribe = onThumbRegen(() => { notifications++ })
  const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)) }
  try {
    noteSourceThumbUnavailable(saved); await flush()
    assert.equal(thumbRegenNonce(saved.talkPath), 1)
    noteSourceThumbUnavailable(second); noteSourceThumbUnavailable(second); await flush()
    assert.equal(thumbRegenNonce(saved.talkPath), 2, 'a later missing slide gets a fresh notification')
    assert.equal(slidePictureFor(second).thumbKey, 'second-NEW')
    assert.equal(notifications, 2)
    noteSourceThumbUnavailable(saved); await flush()
    assert.equal(renders, 2, 'the third note cannot exceed the per-talk budget')
    assert.equal(thumbRegenNonce(saved.talkPath), 2)
  } finally { unsubscribe(); resetSourceThumbs() }
})
console.log(`${checks} checks passed`)
