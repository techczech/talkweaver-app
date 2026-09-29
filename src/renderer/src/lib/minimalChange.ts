// The smallest single replacement that turns one text into another: the common prefix and suffix
// are kept and only the span between them is replaced. Dispatching this, rather than replacing the
// whole document, is what lets CodeMirror keep the caret, the scroll anchor and the undo history
// through a programmatic rewrite (one-writer spec D1): a caret outside the changed span stays on
// the same text, and the rewrite is one ordinary, undoable editor change.
export interface MinimalChange {
  /** Start of the replaced span in the OLD text. */
  from: number
  /** End of the replaced span in the OLD text. */
  to: number
  /** What replaces it. */
  insert: string
}

/** The minimal change from `oldText` to `newText` (an empty change at the end when they are equal). */
export function minimalChange(oldText: string, newText: string): MinimalChange {
  let start = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1
  let oldEnd = oldText.length
  let newEnd = newText.length
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd -= 1
    newEnd -= 1
  }
  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) }
}

/** The change that applies `next` onto `doc`, or null when there is nothing to change. Replacing
 *  `doc.slice(change.from, change.to)` with `change.insert` gives exactly `next`. */
export function applyMinimalChange(doc: string, next: string): MinimalChange | null {
  return doc === next ? null : minimalChange(doc, next)
}
