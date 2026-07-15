// Slide tags — shared helpers (ADR-0037). Storage is the outline (a `tags=a,b` token on the
// slide's Trigger line); the ENGINE op (compiler/scripts/lib/12-outline-edit.mjs applySlideTags)
// owns the write. These helpers exist so the renderer (picker create-row hint, chip rendering)
// and the main process (vocabulary aggregation over searchCache rows) agree on the canonical
// tag form WITHOUT importing the compiler bundle. scripts/test-tags.mjs asserts parity between
// normalizeTag here and the engine's — change both together.
//
// IMPORTANT: keep this file plain, erasable-syntax TypeScript (it is imported by main, the
// renderer, AND the node test under native type stripping — same rule as metadata-registry.ts).

/** Canonical lowercase-kebab tag form: lowercase, whitespace → '-', anything outside
 *  [a-z0-9-] dropped, dash runs collapsed, edge dashes trimmed. '' = not a valid tag. */
export function normalizeTag(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** A `tags=` token VALUE ("Intro, Team") → normalised, deduped list (order preserved). */
export function parseTagsValue(value: string): string[] {
  const out: string[] = []
  for (const part of String(value ?? '').replace(/^"|"$/g, '').split(',')) {
    const tag = normalizeTag(part)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** The `tags=` token of a slide block's heading or Trigger line (the first two token-bearing
 *  lines — same positions the stamped-id reader trusts), parsed to the normalised list.
 *  Deeper `tags=` mentions are body prose, never metadata. */
export function tagsOfBlock(sourceMarkdown?: string): string[] {
  if (!sourceMarkdown) return []
  const lines = sourceMarkdown.split('\n')
  // heading + its (possibly blank-separated) Trigger line — the tolerant read rule.
  const candidates: string[] = [lines[0] ?? '']
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue
    if (/^\s*(\{[^}]*\}\s*)+$/.test(lines[i])) candidates.push(lines[i])
    break
  }
  for (const line of candidates) {
    // The token value runs to the group's end or the next whitespace-separated token;
    // commas are part of the value (LIST_VALUE_KEYS tokenisation), quotes optional.
    const m = line.match(/(?:^|[{\s])tags=("[^"}]*"|[^\s}]*)/)
    if (m) return parseTagsValue(m[1])
  }
  return []
}

export interface TagCount {
  name: string
  count: number
}

/** Vault-wide tag vocabulary from per-slide tag lists: each occurrence counts once; sorted by
 *  count desc, then name. Rows without tags contribute nothing. */
export function vocabularyFromTagLists(tagLists: Iterable<string[] | undefined>): TagCount[] {
  const counts = new Map<string, number>()
  for (const tags of tagLists) {
    if (!Array.isArray(tags)) continue
    for (const raw of tags) {
      const tag = normalizeTag(raw)
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
