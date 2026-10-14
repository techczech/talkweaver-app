import { slideNumbersByLine } from '../../../shared/slide-lines.ts'

// The strip's slide numbers by heading line (compiled index + 1, from src/shared/slide-lines.ts), published
// by the workspace after each compile so the destination list of "Move slide to…" / "Move section to…" can
// number section headings too: a `##` heading compiles to its own title slide, which the Slide outline's
// leaf-only numbers skip. Empty until the first compile.
let numbers: ReadonlyMap<number, number> | null = null

const listeners = new Set<() => void>()

export function publishStripNumbers(next: ReadonlyMap<number, number> | null): void {
  numbers = next
  listeners.forEach((l) => l())
}

/** For useSyncExternalStore: the Slide outline repaints its numbers when a compile publishes new ones. */
export function subscribeStripNumbers(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getStripNumbers(): ReadonlyMap<number, number> | null {
  return numbers
}

/**
 * The number each Slide outline row (and Move to… row) shows, keyed by heading line: the one helper both use, so they cannot
 * disagree. `rows` are the outline's rows in document order (level 1 = the talk title, which stands for the cover).
 *
 * The published map is keyed by the line each slide had at the last compile, so for a moment after an edit that adds or
 * removes lines it is stale. Three cases:
 *  - fresh (every published line is a heading row now): the published numbers by line, exact. A row the compiler gave no
 *    slide has no number.
 *  - stale, same slide count (typing inside a slide): by position, the k-th row gets the k-th published number, so nothing moves.
 *  - stale, different count (a slide added or removed), or nothing published yet (talk just opened): ordinal, every row
 *    counts, title row 1, until the next publish. The compiler gives the cover, each section title and each slide one number
 *    each, which is one per outline row; the closing slide has no heading and so no row.
 * A talk with no `#` title has a synthesized cover, so its first row starts at 2 once the compiler has published.
 */
export function outlineNumbers(
  rows: ReadonlyArray<{ line: number; level: number }>,
  published: ReadonlyMap<number, number> | null = getStripNumbers()
): Map<number, number> {
  const out = new Map<number, number>()
  const hasTitle = rows.length > 0 && rows[0].level === 1
  const entries = published ? [...published].sort((a, b) => a[0] - b[0]) : []
  if (entries.length > 0) {
    const rowLines = new Set(rows.map((r) => r.line))
    if (entries.every(([line, no]) => rowLines.has(line) || no === 1)) {
      for (const r of rows) {
        const no = published!.get(r.line) ?? (hasTitle && r === rows[0] ? entries[0][1] : undefined)
        if (no != null) out.set(r.line, no)
      }
      return out
    }
    const paired = hasTitle ? entries : entries.slice(1)
    if (paired.length === rows.length) {
      rows.forEach((r, k) => out.set(r.line, paired[k][1]))
      return out
    }
  }
  const start = hasTitle || entries.length === 0 ? 1 : 2
  rows.forEach((r, k) => out.set(r.line, start + k))
  return out
}

/**
 * What the workspace publishes. Before the first compile of a talk `computeSlideLines` returns the fallback strip's lines
 * (one per `###` heading, no cover, no sections), which is not the compiled numbering: publishing it made the outline show leaf
 * numbers and blank sections until the compile landed. So nothing is published until there are compiled slides, and
 * `outlineNumbers` counts by ordinal meanwhile. `compiled` is null on talk load, while compiling, and when a compile fails.
 */
export function stripNumbersToPublish(
  compiled: readonly unknown[] | null,
  slideLines: ReadonlyArray<number | null>
): ReadonlyMap<number, number> | null {
  return compiled && compiled.length > 0 ? slideNumbersByLine(slideLines) : null
}
