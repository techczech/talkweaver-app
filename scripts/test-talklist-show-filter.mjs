// Talks panel "Show" filter and unavailable sections (several-vaults ticket 07). Seams: the pure
// filter model (talklist/vaultFilter.ts), sectionRows / talksByVault (vaultSections.ts) and heightOf.
import assert from 'node:assert/strict'
import { buildTree } from '../src/renderer/src/components/talkTreeNav.ts'
import { effectiveShow, hiddenNote, showFilterVisible, showOptions, talksInShow, unavailableNote, unavailableSubline } from '../src/renderer/src/components/talklist/vaultFilter.ts'
import { emptyTalkSearchResult, mergeTalkSearchResults } from '../src/shared/talk-search.ts'
import { sectionRows, talksByVault } from '../src/renderer/src/components/talklist/vaultSections.ts'
import { heightOf, VAULT_COMPACT_PX, VAULT_UNAVAILABLE_PX, VAULT_EMPTY_PX } from '../src/renderer/src/components/talklist/window.ts'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`) }

const V = (id, o = {}) => ({ id, root: `/v/${id}`, open: true, order: 0, name: id.toUpperCase(), baseName: id.toUpperCase(), initial: id[0].toUpperCase(), color: '#111', service: 'Git', unavailable: null, ...o })
const A = V('a'); const B = V('b', { service: 'OneDrive' }); const C = V('c', { open: false })
const GONE = { reason: 'not-signed-in', message: 'm', action: 'open-service', actionLabel: 'Open OneDrive' }
const talk = (vaultId, slug) => ({ name: slug, slug, title: slug, vaultId, path: `/v/${vaultId}/${slug}`, outlinePath: `/v/${vaultId}/${slug}/${slug}-outline.md` })
const talks = [talk('a', 'a1'), talk('a', 'a2'), talk('b', 'b1')]
const trees = new Map([['a', buildTree(talks.filter((t) => t.vaultId === 'a'), [], '/v/a')], ['b', buildTree(talks.filter((t) => t.vaultId === 'b'), [], '/v/b')]])
const rows = (extra = {}, vaults = [A, B, C]) => sectionRows({ vaults, trees, collapsed: new Set(), sectionCollapsed: new Set(), ...extra })

test('the control shows with two open vaults and hides with one (or one open plus a closed one)', () => {
  assert.equal(showFilterVisible([A, B]), true)
  assert.equal(showFilterVisible([A]), false)
  assert.equal(showFilterVisible([A, C]), false)
})
test('the remembered vault applies only while it is open and there are two open vaults', () => {
  assert.equal(effectiveShow('b', [A, B, C]), 'b')
  assert.equal(effectiveShow('c', [A, B, C]), null, 'a closed vault scopes nothing')
  assert.equal(effectiveShow('gone', [A, B]), null, 'an unknown id scopes nothing')
  assert.equal(effectiveShow('a', [A, C]), null, 'one open vault: no filter')
  assert.equal(effectiveShow(null, [A, B]), null)
})
test('menu: All vaults, then every vault; closed and unavailable are listed but disabled', () => {
  const opts = showOptions([A, B, C, V('d', { unavailable: GONE })])
  assert.deepEqual(opts.map((o) => [o.id, o.disabled, o.hint]), [[null, null, ''], ['a', null, 'Git'], ['b', null, 'OneDrive'], ['c', 'closed', 'closed'], ['d', 'unavailable', 'unavailable']])
})
test('scoped to one vault: its section in full, every other vault one compact line with no rows under it', () => {
  const r = rows({ showVaultId: 'b' })
  assert.deepEqual(r.filter((x) => x.kind === 'vault').map((x) => [x.vaultId, !!x.compact]), [['a', true], ['b', false], ['c', true]])
  assert.equal(r.some((x) => x.kind === 'talk' && x.talk.vaultId === 'a'), false)
  assert.equal(r.some((x) => x.kind === 'talk' && x.talk.vaultId === 'b'), true)
})
test('no filter: every open vault in full (unchanged)', () => {
  const r = rows()
  assert.equal(r.filter((x) => x.kind === 'vault' && x.compact).length, 0)
  assert.equal(r.filter((x) => x.kind === 'talk').length, 3)
})
test('one-line notes: talks hidden, closed, unavailable', () => {
  assert.equal(hiddenNote(A, 2), '2 hidden')
  assert.equal(hiddenNote(C, 0), 'closed')
  assert.equal(hiddenNote(V('d', { unavailable: GONE }), 0), 'unavailable')
})
test('Recent narrows to the shown vault; an unstamped talk counts as the first open vault', () => {
  assert.deepEqual(talksInShow(talks, 'a', 'a').map((t) => t.slug), ['a1', 'a2'])
  assert.deepEqual(talksInShow([{ vaultId: undefined, slug: 'x' }], 'a', 'a').map((t) => t.slug), ['x'])
  assert.equal(talksInShow(talks, null, 'a').length, 3)
})
test('an unavailable vault: its header then the note, and no talks even if some are passed in', () => {
  const D = V('d', { unavailable: GONE, order: 3 })
  const r = rows({}, [A, D])
  const at = r.findIndex((x) => x.kind === 'vault' && x.vaultId === 'd')
  assert.deepEqual(r[at + 1], { kind: 'empty', key: 'e:d', vaultId: 'd', unavailable: true })
  assert.equal(talksByVault([talk('d', 'd1'), ...talks], [A, D]).has('d'), false)
})
test('an unavailable vault folded shows the header alone', () => {
  const D = V('d', { unavailable: GONE })
  const r = sectionRows({ vaults: [D], trees: new Map(), collapsed: new Set(), sectionCollapsed: new Set(['d']) })
  assert.equal(r.length, 1)
})
test('row heights: compact line and the taller unavailable note', () => {
  const h = { ledger: 26, shelf: 40, fhead: 26 }
  assert.equal(heightOf({ kind: 'vault', key: 'v:a', vaultId: 'a', compact: true }, 'ledger', h), VAULT_COMPACT_PX)
  assert.equal(heightOf({ kind: 'empty', key: 'e:a', vaultId: 'a', unavailable: true }, 'ledger', h), VAULT_UNAVAILABLE_PX)
  assert.equal(heightOf({ kind: 'empty', key: 'e:a', vaultId: 'a' }, 'ledger', h), VAULT_EMPTY_PX)
})
test('second line of an unavailable header names the reason', () => {
  assert.equal(unavailableSubline({ service: 'OneDrive', unavailable: GONE }), 'OneDrive · not signed in')
  assert.equal(unavailableSubline({ service: 'Local', unavailable: { ...GONE, reason: 'folder-not-found' } }), 'Local · folder not found')
})
test('S2: a shown vault that became unavailable scopes nothing (every vault back in view)', () => {
  const Bgone = { ...B, unavailable: GONE }
  assert.equal(effectiveShow('b', [A, B]), 'b')
  assert.equal(effectiveShow('b', [A, Bgone]), null)
})
test('S2: a search over no vaults is an empty, settled result for the query', () => {
  const r = emptyTalkSearchResult('rubric', '')
  assert.deepEqual(r, { query: 'rubric', terms: [], within: null, hits: [], everywhereCount: 0, slideText: { read: 0, total: 0 } })
  const merged = mergeTalkSearchResults([{ ...r, hits: [{ x: 1 }], everywhereCount: 1 }, { ...r, hits: [{ x: 2 }], everywhereCount: 1, slideText: { read: 1, total: 2 } }])
  assert.equal(merged.hits.length, 2)
  assert.equal(merged.everywhereCount, 2)
  assert.deepEqual(merged.slideText, { read: 1, total: 2 })
})
test('S5: the unavailable note (frame 2C): headline, why, and that copied slides still say where they came from', () => {
  const note = unavailableNote({ name: 'Oxford AICC', unavailable: { ...GONE, message: 'OneDrive is not signed in. Sign in and it comes back on its own.' } })
  assert.equal(note.headline, 'Oxford AICC is unavailable on this Mac.')
  assert.equal(note.body, 'OneDrive is not signed in. Sign in and it comes back on its own. Slides already copied from Oxford AICC still work, and still say \u201cFrom: Oxford AICC vault\u201d.')
})
test('a folder that does not answer reads "not responding"', () => {
  assert.equal(unavailableSubline({ service: 'OneDrive', unavailable: { ...GONE, reason: 'not-responding' } }), 'OneDrive · not responding')
})
console.log(`test-talklist-show-filter: ${passed} passed`)
