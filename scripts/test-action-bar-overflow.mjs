// A prefix measurement for every button, including the separator before section two.
import { strict as assert } from 'node:assert'
import { planButtonOverflow, widthNeeded } from '../src/renderer/src/components/actionBar/overflow.ts'

const input = (available, prefixWidths, overflowChunk = 34, tailChunk = 0) => ({ available, prefixWidths, overflowChunk, tailChunk })
// Three discovery buttons (28, 58, 88), then a separator and two editing buttons (138, 168).
const widths = [28, 58, 88, 138, 168]
assert.deepEqual(planButtonOverflow(input(200, widths)), { visible: 5, overflowing: 0 }, 'everything fits')
assert.deepEqual(planButtonOverflow(input(160, widths, 20)), { visible: 4, overflowing: 1 }, 'one editing button overflows from the right')
assert.deepEqual(planButtonOverflow(input(125, widths)), { visible: 3, overflowing: 2 }, 'section two entirely hidden, so its separator is hidden too')
assert.deepEqual(planButtonOverflow(input(80, widths)), { visible: 1, overflowing: 4 }, 'section one partly hidden')
assert.deepEqual(planButtonOverflow(input(30, widths)), { visible: 0, overflowing: 5 }, 'only the overflow trigger can remain')
assert.deepEqual(planButtonOverflow(input(0, widths)), { visible: 5, overflowing: 0 }, 'zero measured width shows everything on first paint')
assert.equal(widthNeeded(input(200, widths), 5), 168, 'no trigger reserved when all fit')
assert.equal(widthNeeded(input(160, widths, 20), 4), 158, 'trigger reserved when an item overflows')
assert.deepEqual(planButtonOverflow(input(100, [])), { visible: 0, overflowing: 0 }, 'empty list')
const ids = ['a', 'b', 'c', 'd', 'e']
assert.deepEqual(ids.slice(planButtonOverflow(input(125, widths)).visible), ['d', 'e'], 'the menu preserves source order')
console.log('action bar overflow arithmetic: all assertions passed')
