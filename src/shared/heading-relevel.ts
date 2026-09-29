// Uniform heading-level shift of a block of lines — the one re-levelling helper, shared by the
// outline editor's cross-container moves (renderer extensions/outliner.ts moveHeadingBlock) and the
// section insert (shared/insert-section.ts). Every heading line (`#`–`######` then whitespace) in
// `block` moves by `delta`; non-heading lines and lines flagged in `masked` (the mask slice aligned
// with `block`: for the outliner, fenced code, HTML comments and `:::notes`; for the section insert,
// every line the compiler does not read as a `##`–`######` heading) are returned untouched, byte for
// byte.
// Levels are clamped to 1–6; callers that must keep relative depth exactly check the range first
// (headingLevelRange) and refuse rather than clamp.

const HEADING_RE = /^(#{1,6})(\s.*)$/

/** The heading level of a line (`#` count), or 0 when the line is not a heading. */
export function headingLevelOf(line: string): number {
  const m = line.match(/^(#{1,6})\s/)
  return m ? m[1].length : 0
}

export function reLevelHeadingLines(block: readonly string[], delta: number, masked?: readonly boolean[]): string[] {
  if (delta === 0) return block.slice()
  return block.map((l, idx) => {
    if (masked && masked[idx]) return l
    const m = l.match(HEADING_RE)
    if (!m) return l
    const n = Math.max(1, Math.min(6, m[1].length + delta))
    return '#'.repeat(n) + m[2]
  })
}

/** The shallowest and deepest heading levels in `block` outside `masked`, or null with no heading. */
export function headingLevelRange(block: readonly string[], masked?: readonly boolean[]): { min: number; max: number } | null {
  let min = 7, max = 0
  block.forEach((l, idx) => {
    if (masked && masked[idx]) return
    const level = headingLevelOf(l)
    if (level === 0) return
    if (level < min) min = level
    if (level > max) max = level
  })
  return max === 0 ? null : { min, max }
}
