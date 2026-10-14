// Which outline row the editor's caret is in, as told to the Slide outline (its "you are here"
// marker). The workspace knows the heading line of every slide (`slideLines`, by slide index) and the
// caret's line; the outline is told the heading line of the slide holding the caret.
//
// The rule that matters is WHEN it is told. Until 0.38.3-preview.10 it was told only when the slide
// INDEX under the caret changed. A move changes which slide sits at an index, and where every slide's
// heading line is, without changing the index: after "Move slide to the end of Section 8" the marker
// stayed on a line number from before the move, which by then lay inside the slide above the moved
// one, so two rows looked selected. So the outline is told whenever the LINE to show differs from the
// one it was last told, and the line is worked out again whenever the text or the slides change.
//
// No imports: scripts/test-active-outline-line.mjs loads this file directly.

/** Index of the slide whose heading line is the greatest one at or before `line`; -1 when the line
 *  is above every slide. Slides with no known line are skipped. */
export function slideIndexAtLine(slideLines: ReadonlyArray<number | null | undefined>, line: number): number {
  let idx = -1
  let best = -1
  for (let i = 0; i < slideLines.length; i += 1) {
    const ln = slideLines[i]
    if (ln != null && ln <= line && ln > best) { best = ln; idx = i }
  }
  return idx
}

/** The heading line of the slide holding `line`, or null above the first slide. */
export function activeHeadingLine(slideLines: ReadonlyArray<number | null | undefined>, line: number | null): number | null {
  if (line == null) return null
  const idx = slideIndexAtLine(slideLines, line)
  return idx < 0 ? null : slideLines[idx] ?? null
}

/** 1-based line number of the character offset `offset` in `text`. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, text.length)
  for (let i = text.indexOf('\n'); i >= 0 && i < end; i = text.indexOf('\n', i + 1)) line += 1
  return line
}

export interface ActiveLineReporter {
  /** Tell the listener `line`, unless that is what it was last told. */
  report(line: number | null): void
  /** The listener is new, or was told something by another route: the next report goes through. */
  forget(): void
}

/** `send` is read at each report, so it may change between renders. */
export function createActiveLineReporter(send: () => ((line: number | null) => void) | undefined): ActiveLineReporter {
  let told: number | null | undefined
  return {
    report(line) {
      const fn = send()
      if (!fn || told === line) return
      told = line
      fn(line)
    },
    forget() { told = undefined }
  }
}

/**
 * Where a row the Slide outline marks (its selection, its keyboard highlight) is after the text
 * changed. A mark is a line number; `text` is the title of the row it was on.
 * - Still on that row: unchanged.
 * - The row is on another line (a slide moved, lines were typed above it): its new line.
 * - No row has that title any more: when the number of rows is unchanged the row was retitled where
 *   it stands, so the mark stays; otherwise the row is gone (cut, deleted) and so is the mark.
 */
export function rowAfterEdit(rows: ReadonlyArray<{ line: number; text: string }>, line: number | null, text: string | null, sameCount: boolean): number | null {
  if (line == null) return null
  const here = rows.some((row) => row.line === line)
  if (text == null) return here ? line : null
  if (rows.some((row) => row.line === line && row.text === text)) return line
  const moved = rows.find((row) => row.text === text)
  if (moved) return moved.line
  return sameCount && here ? line : null
}
