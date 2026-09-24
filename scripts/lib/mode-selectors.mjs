/**
 * Read the reveal/focus unit selectors out of the two runtimes that ship them.
 *
 * There are deliberately TWO sources here, not one: the presenter deck template and the audience
 * handout builder each embed their own copy, and keeping them honest is the whole point of
 * `test:mode-selector-parity` and `test:reveal-cross-runtime`. A test that reads one selector and
 * applies it to both runtimes proves nothing — it would agree with itself even while the shipped
 * outputs disagree. Always drive each runtime with its OWN selector.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const PRESENTER_PATH = join(root, 'compiler/assets/templates/presenter-popup-single-html.html')
export const AUDIENCE_PATH = join(root, 'compiler/scripts/lib/09-output-builders.mjs')

/** Split a selector list on top-level commas (commas inside (...) belong to :not()/:is()). */
export function splitSelectors(text) {
  const out = []
  let depth = 0
  let buf = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  out.push(buf)
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

/** Presenter form: `const NAME = [ "sel", // comment\n ... ].join(",")` */
export function fromArrayLiteral(src, name) {
  const start = src.indexOf(`const ${name} = [`)
  if (start < 0) throw new Error(`presenter: ${name} array literal not found`)
  const open = src.indexOf('[', start)
  const close = src.indexOf('].join(', open)
  if (close < 0) throw new Error(`presenter: ${name} closing "].join(" not found`)
  const entries = [...src.slice(open + 1, close).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
  if (!entries.length) throw new Error(`presenter: ${name} produced no entries`)
  return splitSelectors(entries.join(','))
}

/** Audience form: `const NAME = "sel,sel,sel";` */
export function fromStringLiteral(src, name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  if (!m) throw new Error(`audience: ${name} string literal not found`)
  return splitSelectors(m[1])
}

export function presenterSelectors(name = 'MODE_SELECTOR') {
  return fromArrayLiteral(readFileSync(PRESENTER_PATH, 'utf8'), name)
}

export function audienceSelectors(name = 'MODE_SELECTOR') {
  return fromStringLiteral(readFileSync(AUDIENCE_PATH, 'utf8'), name)
}
