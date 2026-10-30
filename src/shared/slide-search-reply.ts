// The Slide Browser's compact `search:all-slides` reply (slide-browser drawing ticket, step 3).
//
// The full reply repeats six per-talk fields on every row (outlinePath and talkMeta alone were
// 3.6 M of a 16.9 M-character reply for 8,653 rows) and carries projection fields the Browser
// never reads (elements, derived_id_basis, text_excerpt, …). The compact reply sends each talk
// once and rows that point at it by index, without the unread fields. `expandSlideSearchReply` is
// the one renderer adapter: it gives every row its talk fields back, so the rest of the renderer
// keeps its row type. Pure and dependency-free: main, the renderer and node tests import it.

/** Projection fields no reader of the Browser's rows uses (checked field by field, every reader in
 *  SlideBrowser.tsx, slide-browser/, browser-rail/, slideBrowserModel, talkBesideModel, InsertViewer,
 *  TalkBeside, TagPicker). Dropped from the compact reply only; the full reply is unchanged. */
export const BROWSER_UNREAD_ROW_FIELDS = [
  'elements',
  'derived_id_basis',
  'id_source',
  'deck_slug',
  'text_excerpt',
  'image_placements',
  'warnings',
  'thumbnail_hash',
  'title_layout',
  'has_quote',
  'has_table'
] as const

/** The per-talk fields every row of that talk carries in the full reply. */
export interface SlideSearchTalk {
  talkSlug: string
  talkTitle: string
  outlinePath: string
  vaultId?: string
  talkMtimeMs: number
  talkMeta: string
}

export interface CompactSlideSearchReply {
  compact: 1
  /** Main's freshness stamp, taken before the scan read anything (main/search-index-stamp.ts): the
   *  held rows are reused only while main's stamp is still this. null = main did not stamp it. */
  stamp: string | null
  talks: SlideSearchTalk[]
  /** Rows without their talk fields; `t` is the index of the row's talk in `talks`. */
  rows: Array<Record<string, unknown> & { t: number }>
}

export function isCompactSlideSearchReply(value: unknown): value is CompactSlideSearchReply {
  return Boolean(value) && typeof value === 'object' && (value as { compact?: unknown }).compact === 1 &&
    Array.isArray((value as { talks?: unknown }).talks) && Array.isArray((value as { rows?: unknown }).rows)
}

const UNREAD = new Set<string>(BROWSER_UNREAD_ROW_FIELDS)

/**
 * Build the compact reply from the scan's hits, in hit order. `talkOf` gives a hit's talk fields;
 * hits of one talk must return equal fields (they share one table entry, keyed by outline path).
 */
export function compactSlideSearchReply<H>(
  hits: readonly H[],
  parts: (hit: H) => { row: Record<string, unknown>; talk: SlideSearchTalk; titleHit: boolean },
  stamp: string | null
): CompactSlideSearchReply {
  const talks: SlideSearchTalk[] = []
  const indexByOutline = new Map<string, number>()
  const rows: CompactSlideSearchReply['rows'] = []
  for (const hit of hits) {
    const { row, talk, titleHit } = parts(hit)
    let t = indexByOutline.get(talk.outlinePath)
    if (t === undefined) {
      t = talks.length
      indexByOutline.set(talk.outlinePath, t)
      talks.push(talk)
    }
    const out: Record<string, unknown> & { t: number } = { t }
    for (const key in row) {
      if (!UNREAD.has(key)) out[key] = row[key]
    }
    out.titleHit = titleHit
    rows.push(out)
  }
  return { compact: 1, stamp, talks, rows }
}

/**
 * The renderer adapter: rows with their talk fields restored, in reply order. Mutates the reply's
 * own row objects (they are fresh copies from IPC) instead of copying 8,000 objects again.
 */
export function expandSlideSearchReply<R>(reply: CompactSlideSearchReply): R[] {
  const out = new Array<R>(reply.rows.length)
  for (let i = 0; i < reply.rows.length; i++) {
    const row = reply.rows[i] as Record<string, unknown> & { t?: number }
    const talk = reply.talks[row.t as number]
    delete row.t
    if (talk) {
      row.talkSlug = talk.talkSlug
      row.talkTitle = talk.talkTitle
      row.outlinePath = talk.outlinePath
      if (talk.vaultId !== undefined) row.vaultId = talk.vaultId
      row.talkMtimeMs = talk.talkMtimeMs
      row.talkMeta = talk.talkMeta
    }
    out[i] = row as R
  }
  return out
}
