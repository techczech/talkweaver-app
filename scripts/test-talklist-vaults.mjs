// Talks panel vault sections (several-vaults ticket 03). Seam: the pure row model in
// src/renderer/src/components/talklist/vaultSections.ts (with model.ts / window.ts): which rows the
// panel draws for several vaults, and that two vaults' identically named folders stay apart.
import assert from 'node:assert/strict'
import { buildTree } from '../src/renderer/src/components/talkTreeNav.ts'
import { collapseId, flattenTree } from '../src/renderer/src/components/talklist/model.ts'
import { buildLayout, partitionGroups } from '../src/renderer/src/components/talklist/window.ts'
import {
  decodeFocus, drilledRows, encodeFocus, rowVaultId, sectionRows, talksByVault, vaultIdOfTalk
} from '../src/renderer/src/components/talklist/vaultSections.ts'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`) }

const talk = (root, folder, slug, vaultId) => ({
  name: slug, slug, title: slug, vaultId,
  path: `${root}/${folder ? folder + '/' : ''}${slug}`,
  outlinePath: `${root}/${folder ? folder + '/' : ''}${slug}/${slug}-outline.md`
})
const A = { id: 'a', root: '/v/a', open: true, order: 0, name: 'a', initial: 'A', color: '#111', service: 'Local' }
const B = { id: 'b', root: '/v/b', open: true, order: 1, name: 'b', initial: 'B', color: '#222', service: 'Git' }
const C = { id: 'c', root: '/v/c', open: false, order: 2, name: 'c', initial: 'C', color: '#333', service: 'Local' }
const talks = [
  talk(A.root, 'Workshops', 'a-one', 'a'), talk(A.root, '', 'a-root', 'a'),
  talk(B.root, 'Workshops', 'b-one', 'b')
]
const trees = new Map([
  ['a', buildTree(talks.filter((t) => t.vaultId === 'a'), [], A.root)],
  ['b', buildTree(talks.filter((t) => t.vaultId === 'b'), [], B.root)]
])

test('talks are grouped by vault; closed vaults hold none', () => {
  const by = talksByVault(talks, [A, B, C])
  assert.deepEqual([...by.keys()], ['a', 'b'])
  assert.equal(by.get('a').length, 2)
  assert.equal(by.get('b').length, 1)
})
test('an unstamped talk belongs to the first open vault', () => {
  assert.equal(vaultIdOfTalk({ ...talks[0], vaultId: undefined }, [C, A, B]), 'a')
})
test('one header per vault, each open vault followed by its own rows, a closed vault by nothing', () => {
  const rows = sectionRows({ vaults: [A, B, C], trees, collapsed: new Set(), sectionCollapsed: new Set() })
  assert.deepEqual(rows.map((r) => r.kind), ['vault', 'folder', 'talk', 'talk', 'vault', 'folder', 'talk', 'vault'])
  assert.deepEqual(rows.filter((r) => r.kind === 'vault').map((r) => r.vaultId), ['a', 'b', 'c'])
})
test('the same folder name in two vaults gets two keys and two collapse ids', () => {
  const rows = sectionRows({ vaults: [A, B], trees, collapsed: new Set(), sectionCollapsed: new Set() })
  const folders = rows.filter((r) => r.kind === 'folder')
  assert.equal(folders.length, 2)
  assert.notEqual(folders[0].key, folders[1].key)
  assert.notEqual(collapseId(folders[0].vaultId, folders[0].path), collapseId(folders[1].vaultId, folders[1].path))
})
test('collapsing a folder in one vault leaves the other open', () => {
  const rows = sectionRows({ vaults: [A, B], trees, collapsed: new Set([collapseId('a', 'Workshops')]), sectionCollapsed: new Set() })
  assert.deepEqual(rows.map((r) => r.kind === 'talk' ? r.talk.slug : r.kind), ['vault', 'folder', 'a-root', 'vault', 'folder', 'b-one'])
})
test('a collapsed section shows its header only', () => {
  const rows = sectionRows({ vaults: [A, B], trees, collapsed: new Set(), sectionCollapsed: new Set(['a']) })
  assert.deepEqual(rows.map((r) => r.kind), ['vault', 'vault', 'folder', 'talk'])
})
test('an open vault with no talks gets the empty-state row', () => {
  const rows = sectionRows({ vaults: [A, B], trees: new Map([['a', trees.get('a')], ['b', buildTree([], [], B.root)]]), collapsed: new Set(), sectionCollapsed: new Set() })
  assert.equal(rows.at(-1).kind, 'empty')
  assert.equal(rows.at(-1).vaultId, 'b')
})
test('drilling into a folder shows that vault folder alone', () => {
  const rows = drilledRows({ focus: { vaultId: 'b', path: 'Workshops' }, trees, collapsed: new Set() })
  assert.deepEqual(rows.map((r) => r.talk?.slug), ['b-one'])
})
test('rows know their vault', () => {
  const rows = sectionRows({ vaults: [A, B], trees, collapsed: new Set(), sectionCollapsed: new Set() })
  assert.deepEqual(rows.map((r) => rowVaultId(r, [A, B])), ['a', 'a', 'a', 'a', 'b', 'b', 'b'])
})
test('focus survives encoding for the sidebar-tab round trip', () => {
  assert.deepEqual(decodeFocus(encodeFocus({ vaultId: 'v-1', path: 'x/y' })), { vaultId: 'v-1', path: 'x/y' })
  assert.equal(encodeFocus(null), '')
  assert.equal(decodeFocus(''), null)
  assert.equal(decodeFocus('x/y'), null)
})
test('flattenTree without a vault id keeps the picker keys (f:<path>)', () => {
  const rows = flattenTree(trees.get('a'), new Set())
  assert.equal(rows[0].key, 'f:Workshops')
  assert.equal(rows[0].vaultId, undefined)
})
test('layout: a vault header ends the previous vault group and starts a headerless one', () => {
  const rows = sectionRows({ vaults: [A, B], trees, collapsed: new Set(), sectionCollapsed: new Set() })
  const groups = partitionGroups(rows)
  const vaultGroups = groups.filter((g) => rows[g.start].kind === 'vault')
  assert.equal(vaultGroups.length, 2)
  assert.ok(vaultGroups.every((g) => g.headerIndex === null))
  const layout = buildLayout(rows, 'ledger', { ledger: 26, shelf: 55, fhead: 24 })
  assert.equal(layout.heights[0], 46)
})
console.log(`test-talklist-vaults: ${passed} passed`)
