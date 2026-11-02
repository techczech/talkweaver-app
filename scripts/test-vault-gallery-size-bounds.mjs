// Lower bound for an incomplete measurement: a floor from known allocations, never an invented total.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
const src = resolve(import.meta.dirname, '..', process.env.VG_SRC ?? 'src')
const { inventoryTalkSize, scanSize } = await import(src + '/shared/vault-gallery-storage.ts')
const base = { vaultId: 'v', generation: 1, recursive: true, rootIdentity: 'x', checkedAt: 'x', counted: 0, unreadable: 0, excluded: 0, truncated: false, logicalBytes: null, allocatedBytes: null, allocationUnknown: 0 }
const file = (relativePath, logical, allocated) => ({ relativePath, kind: 'file', logical, allocated })
const partial = { ...base, relativePath: 'Work', state: 'partial', entries: [file('Work/a.png', 200e6, 210e6), file('Work/b.png', 100e6, 110e6), { relativePath: 'Work/locked', kind: 'other', logical: null, allocated: null }] }
const s = inventoryTalkSize(partial, 'Work')
assert.equal(s.allocated, null, 'no exact total from a partial scan'); assert.equal(s.allocatedAtLeast, 320e6); assert.equal(s.partial, true)
const none = inventoryTalkSize({ ...partial, entries: [{ relativePath: 'Work/locked', kind: 'other', logical: null, allocated: null }] }, 'Work')
assert.equal(none.allocatedAtLeast, null, 'nothing known: Unknown, not a zero floor')
const complete = { ...base, relativePath: '', state: 'complete', logicalBytes: 4e9, allocatedBytes: 4.2e9, entries: [{ relativePath: 'Work', kind: 'folder', logical: null, allocated: null }, file('Work/a.png', 4e9, 4.2e9)] }
const root = inventoryTalkSize(complete, '')
assert.equal(root.allocated, 4.2e9, 'completed whole-vault scan reports its own total at the root'); assert.equal(root.logical, 4e9)
assert.equal(inventoryTalkSize(complete, 'Work').allocated, 4.2e9)
const rootPartial = inventoryTalkSize({ ...complete, state: 'partial', allocatedBytes: null, entries: [...complete.entries, { relativePath: 'alias', kind: 'alias', logical: null, allocated: null }] }, '')
assert.equal(rootPartial.allocated, null); assert.equal(rootPartial.allocatedAtLeast, 4.2e9)
assert.equal(scanSize([null, partial, complete], 'Work').allocated, 4.2e9, 'an exact scan wins over a floor'); assert.equal(scanSize([null, partial], 'Work').allocatedAtLeast, 320e6)
console.log('PASS partial sizes keep a floor, complete root total, no invented totals')
