// The one place that says which outline line each compiled slide sits on, and therefore which
// number the editor gutter shows beside a heading. Pure (no React/CodeMirror).
export type SlideLineRow = { source_line?: number | null; source_markdown?: string; role?: string }

// 1-based outline line for EACH compiled slide, aligned to the compiledSlides INDEX.
// The old version counted only `### ` lines, but compiledSlides also contains synthesized
// rows (cover, section-title dividers, closing) — so a content-slide count never matched the
// compiledSlides index and the editor↔strip sync highlighted the wrong card. Here we walk the
// compiled rows and the source headings together: a `### ` content row consumes the next
// level-3 heading, a section-title row consumes the next level-1/2 heading, synthesized rows
// (cover/closing) map to null. Returns lineForSlide[compiledIndex] = source line (or null).
export function computeSlideLines(rows: readonly SlideLineRow[] | null, content: string): (number | null)[] {
  const lines = content.split('\n')
  const headings: Array<{ line: number; level: number }> = []
  lines.forEach((t, i) => {
    const m = t.match(/^(#{1,6})\s/)
    if (m) headings.push({ line: i + 1, level: m[1].length })
  })
  // No compiler output yet → the fallback strip shows one card per `### ` heading in order.
  if (!rows) return headings.filter((h) => h.level === 3).map((h) => h.line)

  // PREFERRED: the engine stamps each slide's source line (ADR — no drift). Use it directly when
  // present; a synthesized cover/closing slide has null → the cover maps to the top of the file.
  if (rows.some((r) => typeof r.source_line === 'number')) {
    return rows.map((r, i) => (typeof r.source_line === 'number' ? r.source_line : i === 0 ? 1 : null))
  }

  // FALLBACK (older projections / non-markdown adapters): walk rows + headings together.
  let h = 0
  return rows.map((row, i) => {
    const isBlock = /^###\s/.test((row.source_markdown ?? '').trimStart())
    const isSection = row.role === 'section-title'
    if (isBlock) {
      // content slide ← next `### ` (level-3) heading
      while (h < headings.length && headings[h].level !== 3) h += 1
      const ln = h < headings.length ? headings[h].line : null
      if (h < headings.length) h += 1
      return ln
    }
    if (isSection) {
      // section divider ← next `## ` (level-2) heading (level-1 belongs to the title slide)
      while (h < headings.length && headings[h].level !== 2) h += 1
      const ln = h < headings.length ? headings[h].line : null
      if (h < headings.length) h += 1
      return ln
    }
    // The leading synthesized cover/title slide maps to the top of the file, so the cursor
    // in the frontmatter or on a `# ` (h1) heading jumps to the title slide.
    if (i === 0) return 1
    return null // closing / other synthesized rows have no source heading
  })
}

// Heading line (1-based) -> the slide's number as the strip prints it (compiled index + 1).
// Built from computeSlideLines, so it counts exactly what the strip counts: synthesized cover,
// section dividers and closing included, nothing that is not a compiled slide.
export function slideNumbersByLine(slideLines: ReadonlyArray<number | null>): Map<number, number> {
  const out = new Map<number, number>()
  slideLines.forEach((line, index) => {
    if (typeof line === 'number' && !out.has(line)) out.set(line, index + 1)
  })
  return out
}
