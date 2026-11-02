import { isMap, parseDocument } from 'yaml'

/** Parse metadata without reconstructing the Markdown: the raw editor owns every byte. */
export function parseAbstractDocument(raw: string): {
  raw: string
  frontmatter: Record<string, unknown>
  body: string
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m)
  if (!match || match.index !== 0) return { raw, frontmatter: {}, body: raw }
  const document = parseDocument(match[1])
  if (document.errors.length) throw document.errors[0]
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error('Abstract frontmatter must be a YAML mapping.')
  }
  const frontmatter = document.toJS() ?? {}
  return { raw, frontmatter, body: raw.slice(match[0].length) }
}

/** Validate, then retain unknown keys, comments, ordering and body whitespace verbatim. */
export function serializeAbstractDocument(raw: string): string {
  parseAbstractDocument(raw)
  return raw.endsWith('\n') ? raw : `${raw}\n`
}
