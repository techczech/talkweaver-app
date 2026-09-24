// Freshness rule for a persisted search-index entry (search-index.json).
//
// The entry's rows carry `render_hash` — a hash of the COMPILED slide model — and the Slide
// Browser addresses thumbnails by that hash (twthumb://slug/<render_hash>). A compiler change
// (composition programme, T1–T23) changes the model, so the hash changes for most slides while
// the outline file — and its mtime — do not. An entry that was checked by mtime alone survived
// the upgrade with stale hashes: the browser asked for pictures that no build would ever write,
// and every card but the untouched title slide fell back to its schematic (2026-09-15).
//
// Freshness therefore needs BOTH: the outline mtime the rows were built from AND the compiler
// tag they were built with (the same hash of compiler lib files that names the thumb-cache
// namespace). Entries persisted before the tag existed carry none and are stale by definition.

export interface SearchIndexEntryLike {
  mtimeMs: number
  compilerTag?: string
  rows: Array<{ tags?: unknown }>
}

export function isSearchIndexEntryFresh(
  entry: SearchIndexEntryLike | undefined,
  outlineMtimeMs: number,
  compilerTag: string
): boolean {
  if (!entry) return false
  if (entry.mtimeMs !== outlineMtimeMs) return false
  if (entry.compilerTag !== compilerTag) return false
  // Entries built before the tags field existed (rows lack `tags`) are stale so one warm pass
  // upgrades the whole persisted index — tags:vocabulary reads it live.
  const rowsCarryTags = entry.rows.length === 0 || Array.isArray(entry.rows[0].tags)
  return rowsCarryTags
}
