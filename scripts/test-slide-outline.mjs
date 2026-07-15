// Verifies the pure slide-outline logic. The functions below MUST match
// src/renderer/src/extensions/slideOutline.ts exactly (same algorithm) — this is a logic guard, since
// the renderer has no TS test runner. (Same convention as scripts/test-selector-logic.mjs.)

function slideRows(content) {
  const raw = []
  content.split('\n').forEach((t, i) => {
    const m = t.match(/^(#{1,6})\s+(.*)$/)
    if (!m) return
    const text = m[2].replace(/\{[^}]*\}/g, '').trim() || '(untitled)'
    raw.push({ line: i + 1, level: m[1].length, text })
  })
  let slideNo = 0
  return raw.map((r, idx) => {
    const isSection = idx + 1 < raw.length && raw[idx + 1].level > r.level
    if (isSection || r.level === 1) return { ...r, slideNo: null }
    slideNo += 1
    return { ...r, slideNo }
  })
}

function relocateBlock(text, fromLine, toLine) {
  const lines = text.split('\n')
  const levelAt = (idx) => { const m = lines[idx] != null ? lines[idx].match(/^(#{1,6})\s/) : null; return m ? m[1].length : 0 }
  const from0 = fromLine - 1, to0 = toLine - 1
  if (from0 < 0 || from0 >= lines.length || to0 < 0 || to0 >= lines.length) return text
  if (levelAt(from0) === 0 || levelAt(to0) === 0) return text
  const lvl = levelAt(from0)
  let fEnd = from0 + 1
  while (fEnd < lines.length) { const l = levelAt(fEnd); if (l > 0 && l <= lvl) break; fEnd += 1 }
  if (to0 >= from0 && to0 < fEnd) return text // dropping into self
  const block = lines.slice(from0, fEnd)
  const without = [...lines.slice(0, from0), ...lines.slice(fEnd)]
  const insertAt = to0 < from0 ? to0 : to0 - (fEnd - from0)
  return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)].join('\n')
}

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }

// slideRows
const doc = '## Intro\n\n### Welcome {reveal}\n\nbody\n\n### Who\n\n## Body\n\n### Demo'
const rows = slideRows(doc)
ck(rows.length === 5, 'rows count')
ck(rows[0].level === 2 && rows[0].text === 'Intro' && rows[0].slideNo === null, 'section Intro')
ck(rows[1].level === 3 && rows[1].text === 'Welcome' && rows[1].slideNo === 1, 'slide 1 Welcome, triggers stripped')
ck(rows[2].text === 'Who' && rows[2].slideNo === 2, 'slide 2 Who')
ck(rows[3].text === 'Body' && rows[3].slideNo === null, 'section Body')
ck(rows[4].text === 'Demo' && rows[4].slideNo === 3, 'slide 3 Demo')

// slideRows — any-depth tree (heading-is-slide): ####/##### rows appear with depth; only LEAVES
// are numbered; the deck title (#) is never numbered even as a leaf-shaped last row.
{
  const deep = '# Deck\n## S\n### sub\n#### a\n##### a1\n#### b\n### leaf3\n## leaf2'
  const r = slideRows(deep)
  ck(r.length === 8, 'any-depth rows count')
  ck(r[0].level === 1 && r[0].slideNo === null, 'deck title # unnumbered')
  ck(r[1].level === 2 && r[1].slideNo === null, '## with children = section')
  ck(r[2].level === 3 && r[2].slideNo === null, '### with #### children = section (unnumbered)')
  ck(r[3].level === 4 && r[3].slideNo === null && r[3].text === 'a', '#### with ##### child = section')
  ck(r[4].level === 5 && r[4].slideNo === 1 && r[4].text === 'a1', '##### leaf numbered 1')
  ck(r[5].level === 4 && r[5].slideNo === 2, '#### leaf numbered 2')
  ck(r[6].level === 3 && r[6].slideNo === 3, '### leaf numbered 3')
  ck(r[7].level === 2 && r[7].slideNo === 4, '## leaf numbered 4 (a childless ## is a slide)')
}

// relocateBlock — move slide '### B' (line 2) before '### A' (line 1) within a section
{
  const t = '### A\nbody A\n### B\nbody B'
  // A at line1 (block lines1-2), B at line3 (block lines3-4). Move B before A → B,A.
  const r = relocateBlock(t, 3, 1)
  ck(r === '### B\nbody B\n### A\nbody A', 'move slide up within section')
}
// relocateBlock — move a SECTION (with its slides) before another section
{
  const t = '## S1\n### a\n## S2\n### b\n### c'
  // S2 at line3 (block lines3-5), move before S1 (line1) → S2 block then S1 block.
  const r = relocateBlock(t, 3, 1)
  ck(r === '## S2\n### b\n### c\n## S1\n### a', 'move whole section up')
}
// relocateBlock — cross-section: move '### c' (line5) before '### a' (line2)
{
  const t = '## S1\n### a\n## S2\n### c'
  const r = relocateBlock(t, 4, 2)
  ck(r === '## S1\n### c\n### a\n## S2', 'cross-section slide move')
}
// relocateBlock — drop into self is a no-op
{
  const t = '## S1\n### a\nbody'
  ck(relocateBlock(t, 1, 2) === t, 'drop into own subtree → no-op')
}
// relocateBlock — non-heading target → no-op
{
  const t = '### a\nbody\n### b'
  ck(relocateBlock(t, 3, 2) === t, 'non-heading target → no-op')
}
// relocateBlock — any-depth blocks: a #### block (with its ##### subtree) moves as a unit
{
  const t = '### s\n#### a\n##### a1\n#### b'
  // block '#### a' = lines2-3 (##### a1 travels), move before EOF target '#### b' stays; instead
  // move '#### b' (line4) before '#### a' (line2) → b, a(+a1).
  const r = relocateBlock(t, 4, 2)
  ck(r === '### s\n#### b\n#### a\n##### a1', 'any-depth: #### block with ##### subtree stays intact')
}
// relocateBlock — deep block dropped into its own subtree is still a no-op
{
  const t = '#### a\n##### a1\nbody'
  ck(relocateBlock(t, 1, 2) === t, 'any-depth: drop into own subtree → no-op')
}

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('slide-outline: all checks passed')
