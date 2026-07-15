// Verifies the pure selection/grouping logic used by SearchPalette. The functions below MUST match
// src/renderer/src/components/searchPaletteSelection.ts exactly (same algorithm) — this is a logic
// guard, since the renderer has no TS test runner.
const selRowKey = (rows, idx) => `${rows[idx].talkSlug}:${rows[idx].slide_id ?? idx}`
function rangeKeys(rows, anchor, active) {
  const lo = Math.max(0, Math.min(anchor, active))
  const hi = Math.min(rows.length - 1, Math.max(anchor, active))
  const out = []
  for (let i = lo; i <= hi; i++) out.push(selRowKey(rows, i))
  return out
}
function sectionKeysAt(rows, idx) {
  const r = rows[idx]; if (!r) return []
  const sec = r.section ?? ''
  const out = []
  for (let i = 0; i < rows.length; i++) if (rows[i].talkSlug === r.talkSlug && (rows[i].section ?? '') === sec) out.push(selRowKey(rows, i))
  return out
}
const isSingleTalk = (rows) => rows.length > 0 && rows.every((r) => r.talkSlug === rows[0].talkSlug)
function groupBySection(rows) {
  const order = [], map = new Map()
  rows.forEach((r, i) => { const s = r.section ?? ''; if (!map.has(s)) { map.set(s, []); order.push(s) } map.get(s).push(i) })
  return order.map((section) => ({ section, indices: map.get(section) }))
}

let fail = 0; const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }
const rows = [
  { talkSlug: 'a', slide_id: 's0', section: 'Intro' },
  { talkSlug: 'a', slide_id: 's1', section: 'Intro' },
  { talkSlug: 'a', slide_id: 's2', section: 'Body' },
  { talkSlug: 'a', slide_id: 's3', section: 'Body' },
]
ck(JSON.stringify(rangeKeys(rows, 1, 3)) === JSON.stringify(['a:s1','a:s2','a:s3']), 'rangeKeys 1..3')
ck(JSON.stringify(rangeKeys(rows, 3, 1)) === JSON.stringify(['a:s1','a:s2','a:s3']), 'rangeKeys reversed = same')
ck(JSON.stringify(sectionKeysAt(rows, 2)) === JSON.stringify(['a:s2','a:s3']), 'sectionKeysAt Body')
ck(isSingleTalk(rows) === true, 'isSingleTalk true')
ck(isSingleTalk([...rows, { talkSlug: 'b' }]) === false, 'isSingleTalk false across talks')
const g = groupBySection(rows)
ck(g.length === 2 && g[0].section === 'Intro' && JSON.stringify(g[0].indices) === JSON.stringify([0,1]) && JSON.stringify(g[1].indices) === JSON.stringify([2,3]), 'groupBySection order + indices')
if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('PASS: selector selection/grouping logic')
