// Vault view (several-vaults ticket 03). Seam: viewVaults / serviceFor in src/main/vault-view.ts,
// the locally derived name, badge and service label the Talks panel shows for each vault.
import assert from 'node:assert/strict'
import { serviceFor, viewVaults, vaultInitial, refusalMessage, VAULT_PALETTE } from '../src/main/vault-view.ts'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`) }

const HOME = '/Users/ann'
const probe = (gits = [], real = {}) => ({
  home: HOME,
  exists: (p) => gits.includes(p),
  realpath: (p) => real[p] ?? p
})

test('OneDrive under ~/Library/CloudStorage/OneDrive-*', () => {
  assert.equal(serviceFor(`${HOME}/Library/CloudStorage/OneDrive-University/Talks`, probe()), 'OneDrive')
})
test('a link that resolves into OneDrive reads as OneDrive', () => {
  const p = probe([], { [`${HOME}/talks-link`]: `${HOME}/Library/CloudStorage/OneDrive-Uni` })
  assert.equal(serviceFor(`${HOME}/talks-link`, p), 'OneDrive')
})
test('Dropbox and Google Drive', () => {
  assert.equal(serviceFor(`${HOME}/Library/CloudStorage/Dropbox/talks`, probe()), 'Dropbox')
  assert.equal(serviceFor(`${HOME}/Dropbox/talks`, probe()), 'Dropbox')
  assert.equal(serviceFor(`${HOME}/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/t`, probe()), 'Google Drive')
})
test('Git when .git is at the root or in a folder above it', () => {
  assert.equal(serviceFor(`${HOME}/gitrepos/talks`, probe([`${HOME}/gitrepos/talks/.git`])), 'Git')
  assert.equal(serviceFor(`${HOME}/gitrepos/talks/decks`, probe([`${HOME}/gitrepos/talks/.git`])), 'Git')
})
test('a cloud folder wins over a .git inside it', () => {
  const root = `${HOME}/Library/CloudStorage/OneDrive-Uni/T`
  assert.equal(serviceFor(root, probe([`${root}/.git`])), 'OneDrive')
})
test('anything else is Local', () => {
  assert.equal(serviceFor(`${HOME}/Documents/talks`, probe()), 'Local')
  assert.equal(serviceFor('/Volumes/Stick/talks', probe()), 'Local')
})
test('a .git above the home folder does not count', () => {
  assert.equal(serviceFor(`${HOME}/Documents/talks`, probe(['/Users/.git'])), 'Local')
})
test('name is the folder name, initial its first letter, colour by order from the palette', () => {
  const views = viewVaults([
    { id: 'b', root: '/x/oxford aicc/', open: true, order: 1 },
    { id: 'a', root: '/y/personal', open: false, order: 0 }
  ], probe())
  assert.deepEqual(views.map((v) => [v.id, v.name, v.initial, v.color, v.open]), [
    ['a', 'personal', 'P', VAULT_PALETTE[0], false],
    ['b', 'oxford aicc', 'O', VAULT_PALETTE[1], true]
  ])
})
test('the palette wraps after its last colour', () => {
  const vaults = Array.from({ length: VAULT_PALETTE.length + 1 }, (_, i) => ({ id: `v${i}`, root: `/r/${i}`, open: true, order: i }))
  assert.equal(viewVaults(vaults, probe()).at(-1).color, VAULT_PALETTE[0])
})
test('initial of an empty or accented name', () => {
  assert.equal(vaultInitial('élan'), 'É')
  assert.equal(vaultInitial(''), '?')
})
test('refusal messages name the other vault and never a path', () => {
  for (const reason of ['duplicate', 'inside-another', 'contains-another']) {
    const m = refusalMessage(reason, 'Oxford')
    assert.match(m, /Oxford/)
    assert.doesNotMatch(m, /\//)
  }
})
test('ticket 04: the name and shared mark come from the vault file; badge colour and initial from personal settings', () => {
  const file = { state: 'ok', file: { schema: 1, id: 'a', name: 'Oxford AICC', shared: true, created_by: 'Anna Novak' } }
  const [withFile, plain] = viewVaults([
    { id: 'a', root: '/x/aicc-folder', open: true, order: 0 },
    { id: 'b', root: '/x/personal', open: true, order: 1 }
  ], probe(), (v) => v.id === 'a' ? { file, personal: { badgeColour: '#be185d', badgeInitial: 'X' } } : { file: { state: 'none' } })
  assert.deepEqual([withFile.name, withFile.shared, withFile.hasFile, withFile.createdBy, withFile.color, withFile.initial], ['Oxford AICC', true, true, 'Anna Novak', '#be185d', 'X'])
  assert.deepEqual([plain.name, plain.shared, plain.hasFile, plain.createdBy, plain.color, plain.initial], ['personal', false, false, null, VAULT_PALETTE[1], 'P'])
})
test('ticket 04: an unreadable vault file or a blank name falls back to the folder name', () => {
  const [a, b] = viewVaults([
    { id: 'a', root: '/x/one', open: true, order: 0 },
    { id: 'b', root: '/x/two', open: true, order: 1 }
  ], probe(), (v) => v.id === 'a' ? { file: { state: 'invalid', reason: 'not-json' } } : { file: { state: 'ok', file: { schema: 1, id: 'b', name: '  ', shared: false } } })
  assert.equal(a.name, 'one')
  assert.equal(b.name, 'two')
})
test('ticket 04: duplicate-id refusal names the first vault, never a path', () => {
  const m = refusalMessage('duplicate-id', 'Oxford AICC')
  assert.match(m, /Oxford AICC/)
  assert.doesNotMatch(m, /\//)
})
test('ticket 07: two vaults with one name read Name · Service; a unique name stays plain', () => {
  const views = viewVaults([
    { id: 'a', root: `${HOME}/Library/CloudStorage/OneDrive-Uni/Workshops`, open: true, order: 0 },
    { id: 'b', root: `${HOME}/gitrepos/workshops`, open: true, order: 1 },
    { id: 'c', root: `${HOME}/Documents/Personal`, open: true, order: 2 }
  ], probe([`${HOME}/gitrepos/workshops/.git`]))
  assert.deepEqual(views.map((v) => v.name), ['Workshops · OneDrive', 'workshops · Git', 'Personal'])
  assert.deepEqual(views.map((v) => v.baseName), ['Workshops', 'workshops', 'Personal'])
  assert.equal(views[0].initial, 'W', 'the badge keeps the plain name’s initial')
})
test('ticket 07: renaming one of two same-named vaults (its vault file) removes the suffix', () => {
  const renamed = { state: 'ok', file: { schema: 1, id: 'a', name: 'Workshops OneDrive', shared: false } }
  const views = viewVaults([
    { id: 'a', root: '/x/one', open: true, order: 0 },
    { id: 'b', root: '/y/Workshops', open: true, order: 1 }
  ], probe(), (v) => (v.id === 'a' ? { file: { state: 'ok', file: { schema: 1, id: 'a', name: 'Workshops', shared: false } } } : {}))
  assert.equal(views[0].name.startsWith('Workshops · '), true)
  const after = viewVaults([
    { id: 'a', root: '/x/one', open: true, order: 0 },
    { id: 'b', root: '/y/Workshops', open: true, order: 1 }
  ], probe(), (v) => (v.id === 'a' ? { file: renamed } : {}))
  assert.deepEqual(after.map((v) => v.name), ['Workshops OneDrive', 'Workshops'])
})
test('ticket 07: an unavailable vault keeps its place, and its kept service label', () => {
  const [v] = viewVaults([{ id: 'a', root: '/gone', open: true, order: 0 }], probe(), () => ({
    unavailable: { reason: 'folder-moved', message: 'm', action: 'retry', actionLabel: 'Check again' }, service: 'Git'
  }))
  assert.equal(v.unavailable.reason, 'folder-moved')
  assert.equal(v.service, 'Git')
})
test('S5: same name AND same service add the folder name that tells them apart', () => {
  const views = viewVaults([
    { id: 'a', root: `${HOME}/Library/CloudStorage/OneDrive-Uni/Teaching/Workshops`, open: true, order: 0 },
    { id: 'b', root: `${HOME}/Library/CloudStorage/OneDrive-Uni/Research/Workshops`, open: true, order: 1 },
    { id: 'c', root: `${HOME}/gitrepos/Workshops`, open: true, order: 2 }
  ], probe([`${HOME}/gitrepos/Workshops/.git`]))
  assert.deepEqual(views.map((v) => v.name), ['Workshops · OneDrive · Teaching', 'Workshops · OneDrive · Research', 'Workshops · Git'])
  for (const v of views) assert.doesNotMatch(v.name, /\//, 'never a path')
})
test('S5: a duplicate-vault note names the first vault by its display label', () => {
  const views = viewVaults([
    { id: 'a', root: '/x/Workshops', open: true, order: 0 },
    { id: 'b', root: '/y/Workshops', open: false, order: 1 }
  ], probe(), (v) => (v.id === 'b' ? { duplicateOf: { id: 'a', name: 'Workshops' }, service: 'Git' } : { service: 'Local' }))
  assert.equal(views[0].name, 'Workshops · Local')
  assert.equal(views[1].duplicateOf.name, 'Workshops · Local')
})
test('S5: an unavailable vault with no vault file to read keeps its last-seen name', () => {
  const [v] = viewVaults([{ id: 'a', root: '/gone/folder-name', open: true, order: 0 }], probe(), () => ({
    name: 'Oxford AICC', service: 'OneDrive', unavailable: { reason: 'not-signed-in', message: 'm', action: 'open-service', actionLabel: 'Open OneDrive settings' }
  }))
  assert.equal(v.name, 'Oxford AICC')
  assert.equal(v.initial, 'O')
})
console.log(`test-vault-view: ${passed} passed`)
