// Plain view, ticket 07 (ninth review): the document's lines as the compiler reads them
// (shared/plain-view-outline-lines.ts), read once per document. Every scanner of this folder asks
// here; none tracks fences, comments, notes or front matter on its own. A CodeMirror document is
// immutable, so the answer is kept by the document's identity: the several scanners that run on
// one transaction (hidden text, icons, placeholders, the margin, the key guard) share one read.
import type { Text } from '@codemirror/state'
import { isOutlineLine, isStructureLine, outlineHeading, type OutlineLines } from '../../../../shared/plain-view-outline-lines'
import { emptyPlainViewFacts, plainViewFactsOf, type PlainViewFacts } from '../../../../shared/plain-view-icon-items'
import { hiddenLayout, type HiddenLayout } from '../../../../shared/plain-view-margin'
import type { HeadingLine } from '../../../../shared/plain-view-heading-line'

const cache = new WeakMap<Text, PlainViewFacts>()

/**
 * Every plain-view fact of the document (the outline lines, the compiler's own reading of each
 * slide's content, the icon items): one pass per document, kept by the document's identity.
 */
export function plainFactsOf(doc: Text): PlainViewFacts {
  let facts = cache.get(doc)
  if (!facts) {
    const text = doc.toString()
    // Fail open (issue 126): the compiler's reading can throw on a document (its lexer recurses on
    // list indentation: thousands of rows each indented one more space overflow the stack). The
    // editor goes on with facts that hide and protect nothing, so every decoration and protected
    // region of the document before it clears, and the text is edited as in Markdown.
    // By the text as well (shared/memo-by-text.ts): the margin's labels and the verbs read this computation, and a
    // verb's verified result is not read again when it becomes the document.
    try { facts = plainViewFactsOf(text) } catch (error) { facts = emptyPlainViewFacts(text); factsFailures.count += 1; factsFailures.last = String(error) }
    cache.set(doc, facts)
  }
  return facts
}

/** How many documents the facts pass threw on, and the last error (read by the tests). */
export const factsFailures = { count: 0, last: '' }

/** The hidden layout lines and runs of the document (shared/plain-view-margin.ts hiddenLayout). */
export function hiddenLayoutOf(doc: Text): HiddenLayout {
  return hiddenLayout(plainFactsOf(doc), (j) => doc.line(j + 1).text, doc.lines)
}

export function outlineLinesOf(doc: Text): OutlineLines {
  return plainFactsOf(doc).read
}

/** Line `n` (1-based) is one Plain may hide, protect or draw a picture on. */
export function structureLine(doc: Text, n: number): boolean {
  return isStructureLine(outlineLinesOf(doc), n - 1)
}

/** Line `n` (1-based) is one the compiler reads as outline. */
export function outlineLine(doc: Text, n: number): boolean {
  return isOutlineLine(outlineLinesOf(doc), n - 1)
}

/** The heading on line `n` (1-based), or null: not a heading, or not a line the compiler reads as outline. */
export function headingAt(doc: Text, n: number): HeadingLine | null {
  const read = outlineLinesOf(doc)
  if (read.kinds[n - 1] !== 'outline') return null
  return outlineHeading(read, n - 1, doc.line(n).text)
}
