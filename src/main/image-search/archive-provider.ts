// Provider 2 (the fallback): today's old-PowerPoint archive image search, unchanged (moved out of
// index.ts, ticket 10). The archive is a content-addressed store of images extracted from old
// presentations, with SQLite registries at {archiveRoot}/registry/{slides,media,images}.db. Read
// through the system sqlite3 binary, READ-ONLY, with the query and path resolution ported from
// raycast-slide-search. Thumbnails are twarchive:// URLs. A file is served or imported only when it
// is inside the archive root, is an image (extension and first bytes), and is either one this
// session's searches returned or one the registry lists (fix round 1, T1): a database, a
// package.json or any other file under the root is refused whatever URL names it.

import { existsSync, realpathSync } from 'fs'
import { join, relative, sep } from 'path'
import type { ImageSearchHit } from '../../shared/image-search.ts'
import { isImageFile } from './image-file.ts'
import type { ImageFile, ImageSearchProvider } from './provider.ts'
import { sqliteQuery } from './sqlite-read.ts'
import { isInsideRoot, pathFromThumbUrl, twarchiveUrl } from './thumb-url.ts'

export type ArchiveProviderDeps = {
  /** The configured archive root when its registry/media.db exists, else null. */
  archiveRoot: () => string | null
  sqlite3: () => string | null
}

/** The archive part of a search, kept apart so the SlideWell provider can reuse it as-is. */
export interface ArchiveProvider extends ImageSearchProvider {
  /** Today's words search: hits in today's order, or null when the archive cannot be searched. */
  wordHits(query: string): Promise<ImageSearchHit[] | null>
}

// Prefer a content-addressed media-store entry (survives source pruning); fall back to the
// per-presentation extracted copy. Returns an absolute path or null when nothing is on disk.
const MEDIA_STORE_DIRS = ['media-store', 'media_store']
function archiveImagePath(archiveRoot: string, presentationId: string, relPath: string, sha256: string): string | null {
  const ext = (relPath.split('.').pop() || '').toLowerCase()
  for (const storeName of MEDIA_STORE_DIRS) {
    if (!ext) break
    const flat = join(archiveRoot, storeName, sha256 + '.' + ext)
    if (existsSync(flat)) return flat
    const sharded = join(archiveRoot, storeName, sha256.slice(0, 2), sha256 + '.' + ext)
    if (existsSync(sharded)) return sharded
  }
  const extracted = join(archiveRoot, 'extracted', presentationId, relPath)
  if (existsSync(extracted)) return extracted
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The registry has no separate title column; presentation_id IS the presentation's name for
// readable ones ("01 MondAI Roundup - 11 Nov 24") and a UUID for the rest. Surface the readable
// ones as the title; leave UUID-only presentations without one.
export function presentationTitleFor(presentationId: string): string | undefined {
  if (!presentationId || UUID_RE.test(presentationId)) return undefined
  return presentationId
}

/** Query words as the archive search splits them (whitespace, empty parts dropped). */
export function queryWords(query: string): string[] {
  return (query || '').trim().split(/\s+/).filter(Boolean)
}

/** Words score: 0.5 for a text match, plus up to 0.5 for the share of query words in the title fields. */
export function wordsScore(words: string[], titleFields: Array<string | undefined>): number {
  if (words.length === 0) return 0.5
  const hay = titleFields.filter(Boolean).join(' ').toLowerCase()
  const found = words.filter((w) => hay.includes(w.toLowerCase())).length
  return Math.round((0.5 + (0.5 * found) / words.length) * 100) / 100
}

interface OcrAssetRow {
  asset_key: string
  presentation_id: string | null
  rel_path: string | null
  text: string | null
}

const ISSUED_MAX = 20000
const SHA_RE = /^[0-9a-f]{16,128}$/i
const realOr = (p: string): string => {
  try { return realpathSync(p) } catch { return p }
}

export function createArchiveProvider(deps: ArchiveProviderDeps): ArchiveProvider {
  // Real paths this session's searches returned: served without another registry query.
  const issued = new Set<string>()
  const issue = (absPath: string): void => {
    const real = realOr(absPath)
    issued.delete(real)
    issued.add(real)
    if (issued.size > ISSUED_MAX) issued.delete(issued.values().next().value as string)
  }

  /** Does the registry list this file as an image? Only the two shapes archiveImagePath builds:
   *  media-store/<sha>.<ext> (flat or sharded) and extracted/<presentation>/<rel path>. */
  async function inRegistry(archiveRoot: string, sqlite3Path: string, absPath: string): Promise<boolean> {
    const rel = relative(realOr(archiveRoot), realOr(absPath)).split(sep)
    if (!rel.length || rel[0] === '..') return false
    let where: string
    let params: string[]
    if (MEDIA_STORE_DIRS.includes(rel[0]) && (rel.length === 2 || (rel.length === 3 && rel[1].length === 2))) {
      const name = rel[rel.length - 1]
      const sha = name.slice(0, name.lastIndexOf('.'))
      if (!SHA_RE.test(sha) || (rel.length === 3 && !sha.toLowerCase().startsWith(rel[1].toLowerCase()))) return false
      where = 'o.asset_key = ?'
      params = [sha]
    } else if (rel[0] === 'extracted' && rel.length >= 4) {
      where = 'o.presentation_id = ? AND o.rel_path = ?'
      params = [rel[1], rel.slice(2).join('/')]
    } else {
      return false
    }
    try {
      const rows = await sqliteQuery<{ hit: number }>({
        binary: sqlite3Path,
        dbPath: join(archiveRoot, 'registry', 'media.db'),
        sql: `SELECT 1 AS hit FROM ocr_assets o WHERE o.kind = 'image' AND ${where} LIMIT 1`,
        params
      })
      return rows.length > 0
    } catch (e) {
      console.error('[image-search:archive] registry check', e)
      return false
    }
  }

  const wordHits = async (query: string): Promise<ImageSearchHit[] | null> => {
    const archiveRoot = deps.archiveRoot()
    const sqlite3Path = deps.sqlite3()
    if (!archiveRoot || !sqlite3Path) return null
    try {
      // media.db has no FTS; ocr_assets.text holds the OCR. LIKE on each bare token (escaped to a
      // literal), AND across tokens — mirrors raycast searchImages.
      const words = queryWords(query)
      const tokens = words.map((t) => t.replace(/[%_]/g, (m) => '\\' + m)).filter(Boolean)
      if (tokens.length === 0) return []

      const whereLikes = tokens.map(() => `o.text LIKE ? ESCAPE '\\'`).join(' AND ')
      const params: Array<string | number> = tokens.map((t) => '%' + t + '%')
      params.push(60)

      const rows = await sqliteQuery<OcrAssetRow>({
        binary: sqlite3Path,
        dbPath: join(archiveRoot, 'registry', 'media.db'),
        sql: `SELECT o.asset_key, o.presentation_id, o.rel_path, o.text
              FROM ocr_assets o
              WHERE o.kind = 'image'
                AND o.text IS NOT NULL
                AND ${whereLikes}
              ORDER BY length(o.text) DESC
              LIMIT ?`,
        params
      })

      const hits: ImageSearchHit[] = []
      for (const r of rows) {
        const sha = r.asset_key
        const pid = r.presentation_id || ''
        const relPath = r.rel_path || ''
        const filePath = archiveImagePath(archiveRoot, pid, relPath, sha)
        if (!filePath) continue // skip hits with no file on disk
        issue(filePath)
        const presentationTitle = presentationTitleFor(pid)
        hits.push({
          key: 'archive:' + sha,
          source: 'archive-image',
          thumbUrl: twarchiveUrl(filePath),
          title: presentationTitle ?? '',
          detail: '',
          ocrText: r.text || '',
          match: 'words',
          score: wordsScore(words, [presentationTitle]),
          usedIn: [],
          ...(presentationTitle ? { presentationTitle } : {}),
          archive: { presentationId: pid, relPath, sha256: sha }
        })
      }
      return hits
    } catch (e) {
      console.error('[image-search:archive]', e)
      return null
    }
  }

  return {
    name: 'archive',
    wordHits,
    async available() {
      return deps.archiveRoot() !== null && deps.sqlite3() !== null
    },
    async search(query) {
      const hits = await wordHits(query)
      return hits === null ? null : { provider: 'archive', hits, meaning: 'off' }
    },
    async fileFor(thumbUrl): Promise<ImageFile | null> {
      const archiveRoot = deps.archiveRoot()
      if (!archiveRoot) return null
      const absPath = pathFromThumbUrl(thumbUrl)
      if (!absPath || !isInsideRoot(absPath, archiveRoot)) return null
      if (!isImageFile(absPath)) return null
      if (!issued.has(realOr(absPath))) {
        const sqlite3Path = deps.sqlite3()
        if (!sqlite3Path || !(await inRegistry(archiveRoot, sqlite3Path, absPath))) return null
      }
      return { absPath, provenance: { source: 'ppt-archive', note: 'imported from ppt-archive: ' + absPath } }
    }
  }
}
