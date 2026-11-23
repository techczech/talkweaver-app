// Reading source files for assertions about their text.
//
// A Windows checkout has CRLF line endings (git's autocrlf). Any assertion that looks for a line
// break in source text must see the same text everywhere, so source is read through `readSource`,
// which gives LF endings on every platform. (The first version of `functionBody` searched for
// "\n}\n" in raw text, found nothing on Windows, and silently returned the rest of the file.)
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Text with LF line endings, whatever the file or string had. */
export const normaliseNewlines = (text) => String(text).replace(/\r\n?/g, '\n')

/** A source file's text, with LF line endings on every platform. */
export const readSource = (path) => normaliseNewlines(readFileSync(path, 'utf8'))

const repo = fileURLToPath(new URL('../../', import.meta.url))
let mainSource

function mainSourceSnapshot() {
  if (mainSource) return mainSource
  function filesUnder(folder) {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return filesUnder(path)
      return entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name) ? [path] : []
    })
  }

  let offset = 0
  const parts = filesUnder(join(repo, 'src/main')).sort().map((file) => {
    const text = readSource(file)
    const start = offset
    const end = start + text.length
    offset = end + 1
    return { path: relative(repo, file).split(sep).join('/'), text, start, end }
  })
  mainSource = { parts, text: parts.map(({ text }) => text).join('\n') }
  return mainSource
}

/** All main-process TypeScript and JavaScript as one LF-normalised source snapshot, in path order.
 *  A test may preprocess each file separately, for example to ignore comments. */
export function readMainSource(prepare) {
  const { parts, text } = mainSourceSnapshot()
  return prepare ? parts.map((part) => prepare(part.text, part.path)).join('\n') : text
}

/** The repository-relative file containing a match offset in readMainSource(). */
export function mainSourceFileAt(offset) {
  return mainSourceSnapshot().parts.find(({ start, end }) => offset >= start && offset < end)?.path
}

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
