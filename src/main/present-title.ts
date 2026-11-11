import { plainTalkTitle } from '../shared/plain-title.ts'

/** The `title:` in the outline's frontmatter, read from the content being presented (it may be unsaved). */
export function frontmatterTitle(content: string | undefined): string {
  if (!content?.startsWith('---')) return ''
  const end = content.indexOf('\n---', 3)
  const block = end === -1 ? content.slice(3, 4096) : content.slice(3, end)
  const m = block.match(/^title:[ \t]*(.+)$/m)
  if (!m) return ''
  const value = m[1].trim()
  // Unquote only a matching enclosing pair: "The speakers'" and "'Twas the night" keep their quotes.
  const quoted = value.match(/^(["'])(.*)\1$/)
  return (quoted ? quoted[2] : value).trim()
}

/**
 * The talk's own title for the presenter and audience windows. The compiler is handed the file slug as
 * its fallback title, so a deck's `deck-title` meta (the presenter's title bar) carries the slug. The
 * authored title comes from the outline's frontmatter; the generated opening slide ('deck-title') is
 * only a fallback, because `auto_title_slide: false` or an explicit `{role=opening}` suppresses it.
 */
export function authoredTalkTitle(slides: ReadonlyArray<{ id?: unknown; title?: unknown }> | undefined, content?: string): string {
  const fromFrontmatter = frontmatterTitle(content)
  if (fromFrontmatter) return plainTalkTitle(fromFrontmatter)
  const opening = slides?.find((slide) => slide.id === 'deck-title')
  return typeof opening?.title === 'string' ? plainTalkTitle(opening.title) : ''
}

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Returns the compiled HTML with the title replaced, or the HTML untouched when the talk has no authored title. */
export function withTalkTitle(html: string, title: string): string {
  if (!title) return html
  const text = escapeAttr(title)
  let next = html.replace(/<meta\s+name=["']deck-title["'][^>]*>/i, () => `<meta name="deck-title" content="${text}">`)
  next = next.replace(/<title[^>]*>[\s\S]*?<\/title>/i, () => `<title>${text}</title>`)
  return next
}
