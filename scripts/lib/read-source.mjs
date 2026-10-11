// Reading source files for assertions about their text.
//
// A Windows checkout has CRLF line endings (git's autocrlf). Any assertion that looks for a line
// break in source text must see the same text everywhere, so source is read through `readSource`,
// which gives LF endings on every platform. (The first version of `functionBody` searched for
// "\n}\n" in raw text, found nothing on Windows, and silently returned the rest of the file.)
import { readFileSync } from 'node:fs'

/** Text with LF line endings, whatever the file or string had. */
export const normaliseNewlines = (text) => String(text).replace(/\r\n?/g, '\n')

/** A source file's text, with LF line endings on every platform. */
export const readSource = (path) => normaliseNewlines(readFileSync(path, 'utf8'))

/**
 * The text of a top-level `function name(` or `async function name(` declaration, from its first
 * line to the closing brace in column one. Throws when the function or its end is not found: a
 * scan that cannot find its bounds must fail, never widen.
 */
export function functionBody(source, name) {
  const text = normaliseNewlines(source)
  const start = new RegExp(`^(?:export )?(?:async )?function ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(`, 'm').exec(text)
  if (!start) throw new Error(`functionBody: no top-level function "${name}"`)
  const end = text.indexOf('\n}\n', start.index)
  if (end < 0) throw new Error(`functionBody: "${name}" has no closing brace in column one`)
  return text.slice(start.index, end + 2)
}
