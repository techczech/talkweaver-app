// The site's own record, published as an ordinary asset at `/_talkweaver/site.json` (spec
// docs/plans/2026-11-05-per-talk-publishing/spec.md, "Site-level state travels with the site"). `_redirects` and `_headers`
// cannot be read back from a live site, so what they are made from travels with it: the short-link registry (folder → short
// id), the link style, and the `_headers` text. Every publish reads it from the live deployment, merges its own change, and
// sends the new record in the same deployment. This computer's registry and `publishing.shortLinks` are caches of it, and the
// defaults for a site that has none yet (bootstrap: handout-publishing.ts, only from the computer that published what is live).
//
// Pure: no file system, no network, no Electron.

export const SITE_RECORD_PATH = '/_talkweaver/site.json'
export const SITE_RECORD_FORMAT = 'talkweaver-site-record'
export const SITE_RECORD_VERSION = 1

export interface SiteRecord {
  /** Folder name → short id, for every short link of the site. */
  registry: Record<string, string>
  /** `<base>/<id>` links (true) or `<base>/<folder>/` links (false) for what is published from now on. */
  shortLinks: boolean
  /** The text of `_headers`, or '' for none. */
  headers: string
  /** The computer that made this record, by its name in Settings: said when a site cannot be taken over. */
  publishedBy?: string
}

const SHORT_ID = /^[A-Za-z0-9_-]{1,64}$/u
const FOLDER = /^[^/\\\x00-\x1f\x7f]{1,255}$/u
const HEADERS_CHARS = 64 * 1024

/** The record in a reply's bytes, or why not: `newer` when a later TalkWeaver wrote it (this one must not write over it). */
export function parseSiteRecord(bytes: Uint8Array | string): { ok: true; record: SiteRecord } | { ok: false; reason: 'unreadable' | 'newer' } {
  let value: unknown
  try { value = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return { ok: false, reason: 'unreadable' } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'unreadable' }
  const record = value as Record<string, unknown>
  if (record.format !== SITE_RECORD_FORMAT || typeof record.version !== 'number' || !Number.isInteger(record.version)) return { ok: false, reason: 'unreadable' }
  if (record.version > SITE_RECORD_VERSION) return { ok: false, reason: 'newer' }
  if (record.version < 1 || typeof record.shortLinks !== 'boolean' || typeof record.headers !== 'string' || record.headers.length > HEADERS_CHARS) return { ok: false, reason: 'unreadable' }
  const registry = record.registry
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return { ok: false, reason: 'unreadable' }
  const entries = Object.entries(registry as Record<string, unknown>)
  if (entries.length > 100_000 || entries.some(([folder, id]) => !FOLDER.test(folder) || typeof id !== 'string' || !SHORT_ID.test(id))) return { ok: false, reason: 'unreadable' }
  if (new Set(entries.map(([, id]) => id)).size !== entries.length) return { ok: false, reason: 'unreadable' }
  const publishedBy = typeof record.publishedBy === 'string' ? record.publishedBy.replace(/[\x00-\x1f\x7f]/gu, ' ').slice(0, 120) : undefined
  return { ok: true, record: { registry: Object.fromEntries(entries as Array<[string, string]>), shortLinks: record.shortLinks, headers: record.headers, ...(publishedBy ? { publishedBy } : {}) } }
}

/** The record's bytes: always the same text for the same record (sorted, fixed key order, one line per entry). */
export function serialiseSiteRecord(record: SiteRecord): string {
  const registry = Object.fromEntries(Object.entries(record.registry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return JSON.stringify({ format: SITE_RECORD_FORMAT, version: SITE_RECORD_VERSION, shortLinks: record.shortLinks, registry, headers: record.headers, ...(record.publishedBy ? { publishedBy: record.publishedBy } : {}) }, null, 2) + '\n'
}

/** Whether two records say the same about the site (who wrote them aside). */
export function sameSite(a: SiteRecord, b: SiteRecord): boolean {
  const { publishedBy: _a, ...left } = a
  const { publishedBy: _b, ...right } = b
  return serialiseSiteRecord(left) === serialiseSiteRecord(right)
}

/** The handouts of a manifest: its top-level folders with a home page (`/<name>/index.html`), sorted. */
export function manifestFolders(paths: Iterable<string>): string[] {
  const names = new Set<string>()
  for (const path of paths) {
    const match = /^\/([^/]+)\/index\.html$/u.exec(path)
    if (match && !match[1].startsWith('_')) names.add(match[1])
  }
  return [...names].sort()
}

/**
 * The registry this computer is to work with: the live record's, exactly. Every entry of this computer's own cache that differs
 * is reported (the live record wins), so the change can be logged.
 */
export function registryClashes(local: Record<string, string>, live: Record<string, string>): string[] {
  const clashes: string[] = []
  for (const [folder, id] of Object.entries(local)) {
    if (!Object.prototype.hasOwnProperty.call(live, folder)) clashes.push(`${folder}: ${id} is not in the site's record (dropped from this computer's copy)`)
    else if (live[folder] !== id) clashes.push(`${folder}: ${id} here, ${live[folder]} in the site's record (the site's kept)`)
  }
  return clashes
}
