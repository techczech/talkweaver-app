// Tests for the focus-scope range-guard predicate (src/renderer/src/extensions/focusScope.ts).
// Imports the REAL exported function — Node ≥23.6 strips erasable TypeScript natively — so this
// cannot drift from the shipped code. changesTouchOutside is a PURE function over plain {fromA,toA}
// spans + a {from,to} range: no DOM, no CodeMirror state needed to run it (the import resolves
// @codemirror/view headlessly, but the function itself touches none of it).
import { changesTouchOutside } from '../src/renderer/src/extensions/focusScope.ts'

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }

const R = { from: 100, to: 200 } // the focused block [100, 200)

// ── edits fully INSIDE the band pass (touchOutside === false) ────────────────
ck(changesTouchOutside([{ fromA: 150, toA: 150 }], R) === false, 'insertion inside passes')
ck(changesTouchOutside([{ fromA: 120, toA: 180 }], R) === false, 'deletion fully inside passes')
ck(changesTouchOutside([{ fromA: 150, toA: 160 }], R) === false, 'replacement fully inside passes')
ck(changesTouchOutside([{ fromA: 100, toA: 100 }], R) === false, 'insertion AT from passes')
ck(changesTouchOutside([{ fromA: 100, toA: 200 }], R) === false, 'deletion of the exact block passes')
ck(changesTouchOutside([{ fromA: 150, toA: 200 }], R) === false, 'deletion up to `to` passes')

// ── insert exactly at `to` grows the block and passes ────────────────────────
ck(changesTouchOutside([{ fromA: 200, toA: 200 }], R) === false, 'insert exactly at `to` passes (grows the range)')

// ── straddling / crossing a boundary rejects (touchOutside === true) ─────────
ck(changesTouchOutside([{ fromA: 95, toA: 110 }], R) === true, 'deletion straddling `from` rejects')
ck(changesTouchOutside([{ fromA: 190, toA: 210 }], R) === true, 'deletion straddling `to` rejects')
ck(changesTouchOutside([{ fromA: 98, toA: 103 }], R) === true, 'delete crossing `from` rejects')
ck(changesTouchOutside([{ fromA: 150, toA: 201 }], R) === true, 'deletion running one past `to` rejects')
ck(changesTouchOutside([{ fromA: 99, toA: 99 }], R) === true, 'insertion just before `from` rejects')
ck(changesTouchOutside([{ fromA: 201, toA: 201 }], R) === true, 'insertion just after `to` rejects')

// ── multiple spans: any one outside rejects; all inside passes ───────────────
ck(changesTouchOutside([{ fromA: 120, toA: 130 }, { fromA: 190, toA: 210 }], R) === true, 'multi-span with one outside rejects')
ck(changesTouchOutside([{ fromA: 110, toA: 110 }, { fromA: 150, toA: 160 }], R) === false, 'multi-span all inside passes')
ck(changesTouchOutside([], R) === false, 'no spans (no doc change) passes')

// ── empty-range edge: only an exact-point insertion at that offset passes ─────
const E = { from: 100, to: 100 }
ck(changesTouchOutside([{ fromA: 100, toA: 100 }], E) === false, 'empty range: insertion at the point passes')
ck(changesTouchOutside([{ fromA: 100, toA: 101 }], E) === true, 'empty range: any deletion rejects')
ck(changesTouchOutside([{ fromA: 99, toA: 99 }], E) === true, 'empty range: insertion before the point rejects')
ck(changesTouchOutside([{ fromA: 101, toA: 101 }], E) === true, 'empty range: insertion after the point rejects')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('test-focus-scope: all checks passed')
