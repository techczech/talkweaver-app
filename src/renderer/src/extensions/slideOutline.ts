// Pure slide-outline logic (no React/CodeMirror). The replica in scripts/test-slide-outline.mjs MUST
// match these algorithms (the renderer has no TS test runner — same convention as test-selector-logic.mjs).

export type SlideRow = { line: number; level: number; text: string; slideNo: number | null }

// Every heading #–###### in document order (heading-is-slide model: hierarchy = heading depth);
// {triggers} stripped. LEAVES are the numbered slides: a heading whose next heading is deeper is a
// section (slideNo null), and the deck title (#) is never numbered. `level` carries the depth the
// organizer indents/collapses on.
export function slideRows(content: string): SlideRow[] {
  const raw: Array<{ line: number; level: number; text: string }> = []
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

// Move the heading-block at `fromLine` (heading + lines until the next heading whose level ≤ this
// heading's level, EOF otherwise) to just before the heading-block at `toLine`. 1-based lines.
// No-op when either line is not a heading, when dropping into the from-block, or out of range.
export function relocateBlock(text: string, fromLine: number, toLine: number): string {
  const lines = text.split('\n')
  const levelAt = (idx: number): number => {
    const m = lines[idx] != null ? lines[idx].match(/^(#{1,6})\s/) : null
    return m ? m[1].length : 0
  }
  const from0 = fromLine - 1
  const to0 = toLine - 1
  if (from0 < 0 || from0 >= lines.length || to0 < 0 || to0 >= lines.length) return text
  if (levelAt(from0) === 0 || levelAt(to0) === 0) return text
  const lvl = levelAt(from0)
  let fEnd = from0 + 1
  while (fEnd < lines.length) {
    const l = levelAt(fEnd)
    if (l > 0 && l <= lvl) break
    fEnd += 1
  }
  if (to0 >= from0 && to0 < fEnd) return text
  const block = lines.slice(from0, fEnd)
  const without = [...lines.slice(0, from0), ...lines.slice(fEnd)]
  const insertAt = to0 < from0 ? to0 : to0 - (fEnd - from0)
  return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)].join('\n')
}
