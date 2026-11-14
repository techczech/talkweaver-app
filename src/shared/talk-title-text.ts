// A talk's title as plain text, for every place it is shown as text (the Talks list, the window title,
// a work file's Used-by list). A title may carry inline Markdown (`**Bold** start`); the compiler's
// plainInlineText is the one function that drops it, so nothing here re-derives the rules.
import { plainInlineText } from '../../compiler/scripts/lib/00-inline-render.mjs'

export function talkTitleText(title: string): string {
  return plainInlineText(title)
}

/** The Edit window's title: "TalkWeaver Edit — Title", or "TalkWeaver" when no talk is open. */
export function editWindowTitle(title: string | null | undefined): string {
  return title ? `TalkWeaver Edit — ${talkTitleText(title)}` : 'TalkWeaver'
}

/** A slide of the talk's projection, as the compiler gives it (only what titles need). */
type TitleRow = { slide_id: string; section?: string; role?: string; nav_title?: string; title?: string }

/**
 * Each slide's title and its section's title as the presenter sees them in the outline, inline markup removed
 * (chapters, Studio's slide labels). A section with its own section-title slide is titled by that slide; a
 * section without one is named by its heading text; its id is used only when it has no title at all. Rows are
 * read in order, so two sections that share an id are each titled by their own section-title slide.
 */
export function slideTitlesFromRows(rows: readonly TitleRow[]): Record<string, { title: string; section: string }> {
  const sectionTitle = new Map<string, string>()
  const out: Record<string, { title: string; section: string }> = {}
  for (const r of rows) {
    const section = r.section ?? ''
    const own = plainInlineText(r.nav_title || r.title || '')
    if (r.role === 'section-title' && section) sectionTitle.set(section, own || section)
    out[r.slide_id] = { title: own, section: section ? sectionTitle.get(section) ?? (plainInlineText(section) || section) : '' }
  }
  return out
}
