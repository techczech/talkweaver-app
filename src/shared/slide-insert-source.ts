// What inserting a slide from another talk puts into the open outline: the one place both insert
// routes ("Slides from other talks…", SearchPalette.tsx, and the Slide Browser, slide-browser/
// useInsert.ts) build their markdown.
//
// A row's stored source (`source_markdown`, the projection/index row) is the slide's own outline
// block, EXCEPT that a quick check's `{right}` markers are stripped by the compiler so the right
// answer never reaches participants or any output (08-source-adapters flushSlide, prework.mjs
// takeRightMarkers). Copying from that stored source dropped the answer. So a quick check's block
// is read from its talk's outline instead: the lines at the slide (found by its id, else its
// source line), accepted only when they ARE the stored source once the markers are taken out —
// i.e. the only thing the authoring insert adds back is the `{right}` the compiler took away.
// Anything else (an index older than the outline, an unreadable talk) inserts the stored source,
// as before. Every other slide kind inserts its stored source unchanged and reads nothing.
//
// Pure apart from the injected `readOutline` (window.tw.talk.readOutline in the renderer).
import { takeRightMarkers } from '../../compiler/scripts/lib/prework.mjs'
import { logicalTriggerBlockAfterHeading, parseTriggerGroups } from './trigger-line.ts'

export interface InsertSourceRow {
  slide_id?: string | null
  source_markdown?: string | null
  source_line?: number | null
  nav_title?: string | null
  title?: string | null
  talkSlug: string
  outlinePath: string
}

export interface InsertItem { markdown: string; fromSlug: string; sourceOutlinePath: string }

/** The row's stored source, or a bare heading when the row has none. */
export function rowMarkdown(row: Pick<InsertSourceRow, 'source_markdown' | 'nav_title' | 'title'>): string {
  return row.source_markdown && row.source_markdown.trim() !== ''
    ? row.source_markdown
    : `### ${row.nav_title || row.title || 'Untitled'}\n`
}

const HEADING_RE = /^#{1,6}\s/

/** A quick check (`{check}` on its heading or Trigger block): the only kind whose stored source is
 *  not its block. Read off the stored source, since projection rows do not carry the flag. */
export function isQuickCheckRow(row: Pick<InsertSourceRow, 'source_markdown'>): boolean {
  const lines = String(row.source_markdown ?? '').split('\n')
  if (!HEADING_RE.test(lines[0] ?? '')) return false
  const block = logicalTriggerBlockAfterHeading(lines, 0)
  const triggerLines = [lines[0], ...(block ? lines.slice(block.start, block.end) : [])]
  return triggerLines.some((line) => parseTriggerGroups(line.replace(/\r$/, ''))
    .some((t) => /^check(\s*=\s*(?!false\b)\S.*)?$/i.test(t.raw.trim())))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 0-based line indexes where the slide's block may start: the heading carrying (or just above the
 *  Trigger line carrying) `{id=<slideId>}`, then the row's 1-based source line. */
function candidateStarts(lines: string[], row: InsertSourceRow): number[] {
  const out: number[] = []
  if (row.slide_id) {
    const idRe = new RegExp(`\\{[^}\\n]*\\bid=${escapeRe(row.slide_id)}(?=[\\s}])`)
    for (let i = 0; i < lines.length; i++) {
      if (!idRe.test(lines[i])) continue
      let h = i
      while (h >= 0 && !HEADING_RE.test(lines[h])) h--
      if (h >= 0 && i - h <= 2) out.push(h)
    }
  }
  if (typeof row.source_line === 'number' && row.source_line >= 1) out.push(row.source_line - 1)
  return [...new Set(out)]
}

/** The slide's full outline block from its talk's text, or null when it cannot be matched to the
 *  stored source (then the stored source is what gets inserted). */
export function checkBlockFromOutline(outlineText: string, row: InsertSourceRow): string | null {
  const stored = String(row.source_markdown ?? '').trimEnd()
  if (!stored) return null
  const lines = String(outlineText).split('\n')
  const n = stored.split('\n').length
  for (const start of candidateStarts(lines, row)) {
    const block = lines.slice(start, start + n)
    if (block.length !== n) continue
    const stripped = takeRightMarkers(block, { throughHeadings: true }).lines.join('\n').trimEnd()
    if (stripped === stored) return block.join('\n').trimEnd()
  }
  return null
}

/** The markdown each row inserts, in row order. Reads each needed talk once. */
export async function insertItemsFor(
  rows: readonly InsertSourceRow[],
  readOutline: (outlinePath: string) => Promise<string | null | undefined>,
): Promise<InsertItem[]> {
  const texts = new Map<string, Promise<string | null>>()
  const textOf = (path: string): Promise<string | null> => {
    let p = texts.get(path)
    if (!p) {
      p = readOutline(path).then((t) => (typeof t === 'string' ? t : null), () => null)
      texts.set(path, p)
    }
    return p
  }
  return Promise.all(rows.map(async (r) => {
    let markdown = rowMarkdown(r)
    if (isQuickCheckRow(r) && r.outlinePath) {
      const text = await textOf(r.outlinePath)
      const block = text === null ? null : checkBlockFromOutline(text, r)
      if (block !== null) markdown = block
    }
    return { markdown, fromSlug: r.talkSlug, sourceOutlinePath: r.outlinePath }
  }))
}
