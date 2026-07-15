// Pure model for Slide Focus (ADR-0032/ADR-0034, v0.8 Task 9). No React, no CodeMirror, no DOM —
// so every function here is directly node-testable (scripts/test-slide-focus.mjs imports the real
// module). WorkspaceLayout + SlideFocus.tsx wrap these; the decisions live here so they cannot
// drift from the tests.
//
// Everything is derived from two inputs the workspace already holds: the live outline `content` and
// `slideLines` (computeSlideLines output — the 1-based source heading line for EACH compiled slide,
// or null for a synthesized cover/section/closing row). A focused slide is a compiled INDEX into
// that array; its editable block runs from its heading line to the next structural heading (any
// level) or EOF, with trailing blank lines trimmed so the band sits flush — matching the focus-scope
// extension's range semantics (from inclusive, to the block's upper edge; an insert AT `to` grows it).

const HEADING_RE = /^#{1,6}\s/
// `{id=…}` slide-identity token, as stamped on a slide's heading or its Trigger line.
const ID_RE = /\{id=([A-Za-z0-9_-]+)\}/

/** Absolute-offset span of a slide's editable block in `content`, plus the line facts used to build
 *  it. `from` is the start of the heading line; `to` is the end of the block's last NON-BLANK line
 *  (trailing blanks before the next heading are excluded). null when `headingLine` is out of range
 *  or is not a structural heading (a synthesized cover/closing row has no block). */
export function slideBlockBounds(
  content: string,
  headingLine: number | null
): { from: number; to: number; startLine: number; endLine: number } | null {
  if (headingLine == null || !Number.isFinite(headingLine)) return null
  const lines = content.split('\n')
  const startIdx = headingLine - 1 // 0-based
  if (startIdx < 0 || startIdx >= lines.length) return null
  if (!HEADING_RE.test(lines[startIdx])) return null

  // First structural heading AFTER the start line bounds the block (exclusive); else EOF.
  let endExclusive = lines.length
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (HEADING_RE.test(lines[i])) { endExclusive = i; break }
  }
  // Trim trailing blank lines so the band ends on real content (never on the boundary blank line).
  let last = endExclusive - 1
  while (last > startIdx && lines[last].trim() === '') last -= 1

  // Prefix offsets: start of line k = Σ (len(line j) + 1) for j < k (the +1 is the '\n').
  let from = 0
  for (let j = 0; j < startIdx; j += 1) from += lines[j].length + 1
  let to = from
  for (let j = startIdx; j < last; j += 1) to += lines[j].length + 1
  to += lines[last].length

  return { from, to, startLine: startIdx + 1, endLine: last + 1 }
}

/** The focus-scope range {from,to} for a slide's heading line, or null for a non-block row. This is
 *  exactly the pair Editor.tsx's `focusRange` prop wants. */
export function focusRangeForSlideLine(content: string, headingLine: number | null): { from: number; to: number } | null {
  const b = slideBlockBounds(content, headingLine)
  return b ? { from: b.from, to: b.to } : null
}

/** The focused slide's block markdown (heading through its last non-blank line). '' when there is no
 *  block — callers treat empty as "nothing to preview / no id". */
export function extractSlideBlock(content: string, headingLine: number | null): string {
  const b = slideBlockBounds(content, headingLine)
  return b ? content.slice(b.from, b.to) : ''
}

/** The detach/reorder ref for a slide addressed by its 1-based heading line: the VERBATIM `###`
 *  heading line and its 1-based occurrence among identical heading lines — the exact shape
 *  listSlideBlocks/detachSlideId expect (compiler/scripts/lib/12-outline-edit.mjs). null for a
 *  non-heading line. */
export function slideRefForLine(content: string, headingLine: number | null): { heading: string; occurrence: number } | null {
  if (headingLine == null) return null
  const lines = content.split('\n')
  const idx = headingLine - 1
  if (idx < 0 || idx >= lines.length) return null
  const heading = lines[idx]
  if (!HEADING_RE.test(heading)) return null
  let occurrence = 0
  for (let i = 0; i <= idx; i += 1) if (lines[i] === heading) occurrence += 1
  return { heading, occurrence }
}

/** A slide's `{id=…}` from its block markdown (scans the heading + Trigger lines — the first three
 *  lines — where an id is ever stamped). null = unstamped (B4: "only here so far"). */
export function slideIdOf(block: string | null | undefined): string | null {
  if (!block) return null
  const head = block.split('\n', 3)
  for (const line of head) {
    const m = line.match(ID_RE)
    if (m) return m[1]
  }
  return null
}

/** Is this compiled index a focusable slide — i.e. does it map to a real editable block? Synthesized
 *  cover/section-title/closing rows (slideLines[i] == null) are not. */
export function isFocusable(slideLines: readonly (number | null)[], index: number): boolean {
  return index >= 0 && index < slideLines.length && slideLines[index] != null
}

/** The next focusable slide index in `dir` (±1), skipping synthesized rows and wrapping around the
 *  compiled order. Returns the current index unchanged when NO other focusable slide exists (a
 *  one-slide talk stays put). Prev/next in the Focus surface calls this. */
export function nextFocusableSlide(slideLines: readonly (number | null)[], index: number, dir: 1 | -1): number {
  const n = slideLines.length
  if (n === 0) return index
  for (let step = 1; step <= n; step += 1) {
    const cand = ((index + dir * step) % n + n) % n
    if (slideLines[cand] != null) return cand
  }
  return index
}

/** The FIRST focusable slide at/after `index` (used when an entry point lands on a synthesized row —
 *  e.g. ⌘⇧F with the caret on a section divider). null when the talk has no focusable slide at all. */
export function firstFocusableFrom(slideLines: readonly (number | null)[], index: number): number | null {
  const n = slideLines.length
  for (let i = Math.max(0, index); i < n; i += 1) if (slideLines[i] != null) return i
  for (let i = 0; i < Math.min(index, n); i += 1) if (slideLines[i] != null) return i
  return null
}

/** A readable section label for the focused slide's crumb. The compiled row's `section` is a SLUG
 *  (section.id) for markdown outlines, so we prefer the nearest preceding `section-title` row's
 *  readable heading (nav_title/title) — exactly how the slide strip titles its section runs — and
 *  fall back to de-slugifying (hyphens → spaces) when there is no section-title row. Rows is the
 *  compiled projection; index the focused slide. Kept pure/testable (rows are plain objects). */
export function readableSectionLabel(
  rows: ReadonlyArray<{ role?: string; nav_title?: string; title?: string; section?: string }> | null | undefined,
  index: number
): string {
  if (rows && index >= 0 && index < rows.length) {
    for (let i = index; i >= 0; i -= 1) {
      if (rows[i]?.role === 'section-title') {
        const t = rows[i].nav_title || rows[i].title || ''
        if (t) return t
      }
    }
  }
  const raw = (rows && rows[index]?.section) || ''
  // A slug has no spaces; a real title keeps its hyphens (e.g. "Pre-training the model").
  return raw.includes(' ') ? raw : raw.replace(/[-_]+/g, ' ').trim()
}

/** Pane-foot state line copy (mockup 1603-1605, 2248-2250). A stamped slide reads green "Compiled";
 *  an unstamped one reads amber "Unsaved — saving stamps an id…". */
export function paneFootState(isStamped: boolean): { tone: 'ok' | 'dirty'; text: string } {
  return isStamped
    ? { tone: 'ok', text: 'Compiled — preview refreshes ~300 ms after you stop typing' }
    : { tone: 'dirty', text: 'Unsaved — saving stamps an id and starts this slide’s history' }
}
