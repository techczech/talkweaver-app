// Slide Browser vault filter and the Inspector's "Where it came from" lines (several-vaults ticket 06;
// LOCKED-add-slide). Seams: src/renderer/src/components/slide-browser/vaultChipsModel.ts and
// src/renderer/src/components/slideProvenanceModel.ts (pure).
import assert from 'node:assert/strict'
import {
  chipVaults, countByVault, currentVaultFirst, currentVaultIdFor, offVaultMatches, orList, rowsInVaults, toggleVault
} from '../src/renderer/src/components/slide-browser/vaultChipsModel.ts'
import { insertedLabel, slideProvenanceView } from '../src/renderer/src/components/slideProvenanceModel.ts'

let passed = 0
const test = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`) }

const V = (id, order, open = true, root = `/v/${id}`) => ({ id, name: id.toUpperCase(), initial: id[0].toUpperCase(), color: '#000', open, order, root })
const vaults = [V('personal', 0), V('oxford', 1), V('workshop', 2), V('old', 3, false)]

test('chips: open vaults only, the current talk’s vault first, the rest in sidebar order', () => {
  assert.deepEqual(chipVaults(vaults, 'workshop').map((c) => c.id), ['workshop', 'personal', 'oxford'])
  assert.deepEqual(chipVaults(vaults, null).map((c) => c.id), ['personal', 'oxford', 'workshop'])
})

test('current vault: the talk’s stamped vault id, else the deepest open root holding its outline', () => {
  assert.equal(currentVaultIdFor(vaults, '/v/oxford/a/a-outline.md'), 'oxford')
  assert.equal(currentVaultIdFor(vaults, '/v/oxford/a/a-outline.md', 'workshop'), 'workshop')
  assert.equal(currentVaultIdFor(vaults, '/v/old/a-outline.md'), null, 'a closed vault is never current')
  assert.equal(currentVaultIdFor(vaults, '/v/oxfordshire/a-outline.md'), null, 'a root prefix is not a folder match')
})

const rows = [
  { id: 1, vaultId: 'personal' }, { id: 2, vaultId: 'workshop' }, { id: 3, vaultId: 'oxford' },
  { id: 4, vaultId: 'workshop' }, { id: 5, vaultId: 'personal' }
]

test('counts per vault', () => {
  assert.deepEqual([...countByVault(rows)], [['personal', 2], ['workshop', 2], ['oxford', 1]])
})

test('a chip switched off leaves its vault’s results out; switching it on brings them back', () => {
  let off = toggleVault(new Set(), 'oxford')
  assert.deepEqual(rowsInVaults(rows, off).map((r) => r.id), [1, 2, 4, 5])
  off = toggleVault(off, 'oxford')
  assert.equal(off.size, 0)
  assert.equal(rowsInVaults(rows, off), rows)
  assert.deepEqual(rowsInVaults([{ id: 9 }], new Set(['oxford'])).map((r) => r.id), [9], 'a row without a vault stays')
})

test('ranking: the current vault’s results first, each group keeps the search order', () => {
  assert.deepEqual(currentVaultFirst(rows, 'workshop').map((r) => r.id), [2, 4, 1, 3, 5])
  assert.equal(currentVaultFirst(rows, null), rows)
})

test('empty result: switched-off vaults with matches are named, in chip order', () => {
  const chips = chipVaults(vaults, 'workshop')
  const counts = new Map([['oxford', 2], ['personal', 0]])
  const hidden = offVaultMatches(chips, counts, new Set(['oxford', 'personal']))
  assert.deepEqual(hidden.map((h) => [h.vault.id, h.count]), [['oxford', 2]])
  assert.equal(orList(['AI workshop', 'Personal']), 'AI workshop or Personal')
  assert.equal(orList(['A', 'B', 'C']), 'A, B or C')
})

const now = new Date(2026, 8, 30, 12, 0)
const base = { vaultId: 'p', vaultName: 'Personal', sourceSlideId: 'abc12', insertedAt: new Date(2026, 8, 30, 9, 31).toISOString(), badge: { initial: 'P', color: '#c2410c' } }

test('Inspector, owner’s Mac: From: Personal vault · Talk: Metaphor talk 2026', () => {
  const v = slideProvenanceView({ ...base, talkTitle: 'Metaphor talk 2026', insertedBy: 'Dominik Lukeš' }, now)
  assert.equal(v.mine, true)
  assert.equal(v.summary, 'From: Personal vault · Talk: Metaphor talk 2026')
  assert.deepEqual(v.rows, [{ label: 'Talk', value: 'Metaphor talk 2026' }, { label: 'Inserted', value: 'Today, 09:31' }])
  assert.equal(v.historyNote, null)
})

test('Inspector, a colleague’s Mac (names who inserted it): From Dominik Lukeš · Personal vault · History not available here', () => {
  const v = slideProvenanceView({ ...base, badge: null, talkTitle: null, insertedBy: 'Dominik Lukeš' }, now)
  assert.equal(v.mine, false)
  assert.equal(v.summary, 'From Dominik Lukeš · Personal vault · History not available here')
  assert.equal(v.fromLine, 'From Dominik Lukeš')
  assert.equal(v.rows.length, 0, 'no talk, no time: nothing about the source vault beyond its name')
  assert.match(v.help, /Only Dominik has its earlier versions/)
  const anon = slideProvenanceView({ ...base, talkTitle: null, insertedBy: null }, now)
  assert.equal(anon.summary, 'From Personal vault · History not available here')
})

test('inserted time labels', () => {
  assert.equal(insertedLabel(new Date(2026, 8, 29, 17, 2).toISOString(), now), 'Yesterday, 17:02')
  assert.equal(insertedLabel(new Date(2026, 8, 3, 9, 5).toISOString(), now), '3 Sept 2026, 09:05')
  assert.equal(insertedLabel(null, now), null)
})

test('ticket 07: an unavailable open vault keeps its chip, flagged; it is never a searchable chip', () => {
  const list = [V('personal', 0), { ...V('oxford', 1), unavailable: { reason: 'not-signed-in' } }]
  const chips = chipVaults(list, 'personal')
  assert.deepEqual(chips.map((c) => [c.id, !!c.unavailable]), [['personal', false], ['oxford', true]])
})

console.log(`${passed} passed`)
