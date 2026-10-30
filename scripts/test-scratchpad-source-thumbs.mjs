// A picked slide's picture address on THIS machine (src/renderer/src/lib/scratchpadSourceThumbs.ts). The saved
// state travels with the talk folder, but a vault id is a per-machine registry id: a vault-qualified twthumb://
// URL reads that vault's cache folder only, so a stale id 404s for ever even after the talk was rendered. The
// address is re-derived from the source talk's current rows once the talk has been rendered.
import assert from 'node:assert/strict'
import { deriveSlidePicture, slidePictureFor, noteSourceThumbUnavailable, onThumbRegen, thumbRegenNonce, resetSourceThumbs } from '../src/renderer/src/lib/scratchpadSourceThumbs.ts'
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
console.log(`${checks} checks passed`)
