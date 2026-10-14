// One computation per document text, shared by everything that reads the same text.
//
// The plain view's facts are asked for by several readers of one document version: the editor's
// extensions (by the CodeMirror document, extensions/plainView/outlineLines.ts), the margin's labels
// (WorkspaceLayout, from the text it holds), and the layout and icon verbs (the text before an
// edit, then the text after it, which is the editor's next document). Each of them holds its own
// string, so the answer is kept by the text's characters, for the last few texts.
//
// A computation that throws is not kept: it throws to its caller as it always did, and the next
// reader computes again (the compiler's lexer overflows the stack on thousands of nested list rows,
// and whether it does depends on how deep the caller already is). The readers fail open, each in
// its own way.

interface Kept<T> { text: string; value: T }

/** `compute` kept for the last `size` texts (most recently used first). */
export function memoByText<T>(compute: (text: string) => T, size = 4): (text: string) => T {
  const kept: Array<Kept<T>> = []
  return (text: string): T => {
    // Two strings of different length are told apart at once; equal ones are compared by their characters.
    const at = kept.findIndex((entry) => entry.text === text)
    if (at >= 0) {
      const entry = kept[at]
      if (at > 0) { kept.splice(at, 1); kept.unshift(entry) }
      return entry.value
    }
    const value = compute(text)
    kept.unshift({ text, value })
    if (kept.length > size) kept.length = size
    return value
  }
}
