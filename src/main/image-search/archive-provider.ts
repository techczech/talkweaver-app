// Provider 2 (the fallback): today's old-PowerPoint archive image search, unchanged (moved out of
// index.ts, ticket 10). The archive is a content-addressed store of images extracted from old
// presentations, with SQLite registries at {archiveRoot}/registry/{slides,media,images}.db. Read
// through the system sqlite3 binary, READ-ONLY, with the query and path resolution ported from
// raycast-slide-search. Thumbnails are twarchive:// URLs. A file is served or imported only when it
// is inside the archive root, is an image (extension and first bytes), and is either one this
// session's searches returned or one the registry lists (fix round 1, T1): a database, a
// package.json or any other file under the root is refused whatever URL names it.

import { constants, existsSync, lstatSync, realpathSync } from 'fs'
import { open } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import type { ImageSearchHit } from '../../shared/image-search.ts'
import type { OldSlideImage } from '../../shared/old-slide.ts'
import { isImageFile } from './image-file.ts'
import type { ImageFile, ImageSearchProvider } from './provider.ts'
import { pathStaysInside } from '../path-containment.ts'
import { READ_BUSY_MS, READ_LIMIT_MS, SqliteTimeoutError, sqliteQuery } from './sqlite-read.ts'
import { isInsideRoot, pathFromThumbUrl, twarchiveUrl } from './thumb-url.ts'

/** Limits on the old-slide reads. The archive belongs to another app whose writer waits 5 s for a lock:
 *  each read waits `busyMs` for that lock and is killed at `limitMs` (the SlideWell read limits), a
 *  render manifest is read within `manifestMs`, and the whole old-slide search stops at `searchMs`. */
export type ArchiveReadLimits = { busyMs: number; limitMs: number; searchMs: number; manifestMs: number }
export const ARCHIVE_READ_LIMITS: ArchiveReadLimits = { busyMs: READ_BUSY_MS, limitMs: READ_LIMIT_MS, searchMs: 1500, manifestMs: 250 }

export type ArchiveProviderDeps = {
  /** The configured archive root when its registry/media.db exists, else null. */
  archiveRoot: () => string | null
  sqlite3: () => string | null
  /** Tests on a loaded machine only; the app always uses ARCHIVE_READ_LIMITS. */
  readLimits?: ArchiveReadLimits
}

/** The archive part of a search, kept apart so the SlideWell provider can reuse it as-is. */
export interface ArchiveProvider extends ImageSearchProvider {
  /** Today's words search: hits in today's order, or null when the archive cannot be searched. */
  wordHits(query: string): Promise<ImageSearchHit[] | null>
  /** Whole old slides whose text matches (the Old slides tab), each with the record an editable slide is
   *  built from. [] when the registry has no slide index or nothing matches; never throws. */
  slideHits?(query: string): Promise<ImageSearchHit[]>
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

interface SlideRow {
  content_hash: string
  title: string | null
  text_content: string | null
  presentation_id: string | null
  slide_order: number | null
}

const RENDER_EXTS = ['webp', 'png', 'jpg', 'jpeg']
/** A render manifest lists one short line per slide; one this big is not a manifest. */
const MANIFEST_MAX_BYTES = 1024 * 1024

/** `candidate` as a regular file inside the archive, by the app's one containment check (path-containment:
 *  lexically inside and still inside once every link is resolved): its real path, else null. A folder, a
 *  FIFO, a device, a dangling link and anything that resolves outside the archive are all null. */
function archiveFile(archiveRoot: string, candidate: string): string | null {
  const real = pathStaysInside(archiveRoot, candidate)
  if (!real) return null
  try { return lstatSync(real).isFile() ? real : null } catch { return null }
}

/** The manifest that was opened is not the file that was checked: something on its path was swapped
 *  between the check and the open. Nothing is read from it and the slide is not offered. */
const MANIFEST_SWAPPED = Symbol('manifest swapped')

/** The manifest's text, or null when it should not or could not be read. The path is resolved and kept
 *  inside the archive BEFORE anything is opened, and the checked file's identity (device and inode) is
 *  kept; it is opened without following a link and without blocking (a FIFO swapped in after the check
 *  opens at once and is then refused by what it is); the OPEN file must be that same file before any
 *  byte is read (O_NOFOLLOW covers the last part of the path only: a folder above it replaced by a link
 *  out of the archive would otherwise be followed), else MANIFEST_SWAPPED; the size is checked on the
 *  open file; and the read is asynchronous and given up after `limitMs`. */
async function readManifest(archiveRoot: string, path: string, limitMs: number): Promise<string | null | typeof MANIFEST_SWAPPED> {
  const real = archiveFile(archiveRoot, path)
  if (!real) return null
  let checked: { dev: bigint; ino: bigint }
  try {
    const stat = lstatSync(real, { bigint: true })
    if (!stat.isFile()) return null
    checked = { dev: stat.dev, ino: stat.ino }
  } catch { return null }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abandoned = false
  const read = (async (): Promise<string | null | typeof MANIFEST_SWAPPED> => {
    const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) return MANIFEST_SWAPPED
      const size = Number(opened.size)
      if (abandoned || !opened.isFile() || size > MANIFEST_MAX_BYTES) return null
      const buffer = Buffer.alloc(size + 1)
      let length = 0
      while (length < buffer.length && !abandoned) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      // Longer than it said it was: it is being written; not offered this time.
      return abandoned || length > size ? null : buffer.toString('utf8', 0, length)
    } finally {
      await handle.close().catch(() => undefined)
    }
  })().catch(() => null)
  const limit = new Promise<null>((resolve) => { timer = setTimeout(() => { abandoned = true; resolve(null) }, Math.max(1, limitMs)) })
  try { return await Promise.race([read, limit]) } finally { clearTimeout(timer) }
}

/** One folder name and nothing else: no separator of either kind, no `.` or `..`, no NUL. */
const isPresentationFolderName = (id: string): boolean =>
  typeof id === 'string' && id !== '' && id !== '.' && !id.includes('..') && !/[/\\\0]/.test(id) && !isAbsolute(id)

/** The slide's render image: renders.json maps slide_order to a file (page numbers are not always order + 1);
 *  without it, renders/slide_<order+1>. Null when no render is on disk. Ported from raycast-slide-search.
 *  Everything it reads or returns is a regular file inside the archive (archiveFile): a presentation
 *  folder, manifest or render that is a link out of the archive, a FIFO or the wrong kind of thing means
 *  the slide is not offered, never an error and never a wait; so does a manifest that, once open, is
 *  not the file that was checked. The path returned is the real path: this function opens only the
 *  manifest, and a render it names is read later, by whoever asks fileFor for it. */
export async function archiveRenderPath(
  archiveRoot: string, presentationId: string, slideOrder: number | null, limits: Pick<ArchiveReadLimits, 'manifestMs'> = ARCHIVE_READ_LIMITS
): Promise<string | null> {
  if (slideOrder === null || !Number.isInteger(slideOrder) || slideOrder < 0 || !isPresentationFolderName(presentationId)) return null
  const dir = join(archiveRoot, 'extracted', presentationId)
  const existing = (rel: string): string | null => {
    if (!rel || rel.includes('\0') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[/\\]/).includes('..')) return null
    const direct = archiveFile(archiveRoot, join(dir, rel))
    if (direct) return direct
    const base = rel.replace(/\.[^./\\]+$/, '')
    for (const ext of RENDER_EXTS) {
      const candidate = archiveFile(archiveRoot, join(dir, `${base}.${ext}`))
      if (candidate) return candidate
    }
    return null
  }
  try {
    const text = await readManifest(archiveRoot, join(dir, 'renders.json'), limits.manifestMs)
    if (text === MANIFEST_SWAPPED) return null
    const data: unknown = text === null ? null : JSON.parse(text)
    const renders: unknown = data && typeof data === 'object' ? (data as { renders?: unknown }).renders : null
    if (Array.isArray(renders)) {
      const entry = renders.find((r): r is { slide_order: number; render: unknown } =>
        Boolean(r) && typeof r === 'object' && (r as { slide_order?: unknown }).slide_order === slideOrder)
      const found = entry && typeof entry.render === 'string' ? existing(entry.render) : null
      if (found) return found
    }
  } catch { /* not JSON: the numbered name below */ }
  return existing(`renders/slide_${String(slideOrder + 1).padStart(4, '0')}.png`)
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

  // Old slides. The archive is another app's store, read while that app may be writing it, so the whole
  // search is bounded: two reads however many slides match (the slide index, then the pictures of every
  // matching slide at once), each waiting `busyMs` for the owner's lock and killed at `limitMs`, and the
  // search as a whole given up at `searchMs`. A read that runs out of time means NO old slides this time
  // (never half an answer); a missing picture index only means slides built from their text alone.
  const slideHits = async (query: string): Promise<ImageSearchHit[]> => {
    const archiveRoot = deps.archiveRoot()
    const sqlite3Path = deps.sqlite3()
    if (!archiveRoot || !sqlite3Path || !existsSync(join(archiveRoot, 'registry', 'slides.db'))) return []
    const words = queryWords(query)
    const fts = words.map((w) => w.replace(/"/g, '').trim()).filter(Boolean).map((w) => `"${w}"*`).join(' ')
    if (!fts) return []
    const limits = deps.readLimits ?? ARCHIVE_READ_LIMITS
    const deadline = Date.now() + limits.searchMs
    const left = (): number => deadline - Date.now()
    /** One read inside both limits; throws SqliteTimeoutError when the search has no time left. */
    const read = <T>(db: string, sql: string, params: Array<string | number>, attach?: Record<string, string>): Promise<T[]> => {
      const remaining = left()
      if (remaining <= 0) throw new SqliteTimeoutError('the old-slide search ran out of time')
      return sqliteQuery<T>({
        binary: sqlite3Path, dbPath: join(archiveRoot, 'registry', db), sql, params, attach,
        busyTimeoutMs: Math.min(limits.busyMs, remaining), timeoutMs: Math.min(limits.limitMs, remaining)
      })
    }
    const work = async (): Promise<ImageSearchHit[]> => {
      // One row per slide: the first place it appears. slides_fts holds the title and text.
      const rows = await read<SlideRow>('slides.db',
        `SELECT s.content_hash, s.title, s.text_content,
                (SELECT presentation_id FROM slide_locations l WHERE l.content_hash = s.content_hash ORDER BY l.slide_order LIMIT 1) AS presentation_id,
                (SELECT slide_order FROM slide_locations l WHERE l.content_hash = s.content_hash ORDER BY l.slide_order LIMIT 1) AS slide_order
         FROM slides s JOIN slides_fts f ON s.rowid = f.rowid
         WHERE slides_fts MATCH ?
         ORDER BY f.rank
         LIMIT ?`, [fts, 30])
      // Which of them have a render on disk (the picture option needs it).
      const offered: Array<{ row: SlideRow; pid: string; render: string }> = []
      for (const row of rows) {
        if (left() <= 0) throw new SqliteTimeoutError('the old-slide search ran out of time')
        const pid = row.presentation_id || ''
        if (!row.content_hash) continue
        const render = await archiveRenderPath(archiveRoot, pid, row.slide_order, { manifestMs: Math.min(limits.manifestMs, Math.max(1, left())) })
        if (render) offered.push({ row, pid, render })
      }
      if (offered.length === 0) return []
      // The pictures on those slides, all in one read: images.db says which, media.db where the file is.
      const pictures = new Map<string, Array<{ sha256: string; rel_path: string }>>()
      const slideKey = (pid: string, order: number | null): string => `${order ?? 0}\u0000${pid}`
      if (existsSync(join(archiveRoot, 'registry', 'images.db')) && existsSync(join(archiveRoot, 'registry', 'media.db'))) {
        try {
          const found = await read<{ pid: string; ord: number; sha256: string; rel_path: string | null }>('images.db',
            `SELECT il.presentation_id AS pid, il.slide_order AS ord, il.sha256 AS sha256,
                    (SELECT o.rel_path FROM media.ocr_assets o WHERE o.kind = 'image' AND o.asset_key = il.sha256 AND o.presentation_id = il.presentation_id LIMIT 1) AS rel_path
             FROM image_locations il
             WHERE ${offered.map(() => '(il.presentation_id = ? AND il.slide_order = ?)').join(' OR ')}
             GROUP BY il.presentation_id, il.slide_order, il.sha256`,
            offered.flatMap(({ row, pid }) => [pid, row.slide_order ?? 0]),
            { media: join(archiveRoot, 'registry', 'media.db') })
          for (const f of found) {
            if (!f.rel_path || !SHA_RE.test(f.sha256)) continue
            const key = slideKey(f.pid, f.ord)
            const list = pictures.get(key) ?? []
            if (list.length < 12) list.push({ sha256: f.sha256, rel_path: f.rel_path })
            pictures.set(key, list)
          }
        } catch (e) {
          if (e instanceof SqliteTimeoutError) throw e
          /* no usable picture index: editable slides from the text alone */
        }
      }
      const hits: ImageSearchHit[] = []
      for (const { row: r, pid, render } of offered) {
        const title = (r.title || '').trim()
        const images: OldSlideImage[] = []
        for (const { sha256, rel_path } of pictures.get(slideKey(pid, r.slide_order)) ?? []) {
          const path = archiveImagePath(archiveRoot, pid, rel_path, sha256)
          if (!path) continue
          images.push({ key: sha256, thumbUrl: twarchiveUrl(path) })
        }
        const presentationTitle = presentationTitleFor(pid)
        hits.push({
          key: 'old-slide:' + r.content_hash,
          source: 'old-slide',
          thumbUrl: twarchiveUrl(render),
          title,
          detail: '',
          ocrText: r.text_content || '',
          match: 'words',
          score: wordsScore(words, [title, presentationTitle]),
          usedIn: [],
          ...(presentationTitle ? { presentationTitle } : {}),
          oldSlide: {
            title,
            paragraphs: (r.text_content || '').split(/\r?\n/),
            images,
            slideNumber: r.slide_order === null ? 0 : r.slide_order + 1,
            ...(presentationTitle ? { presentationTitle } : {})
          }
        })
      }
      if (left() <= 0) throw new SqliteTimeoutError('the old-slide search ran out of time')
      // Only an answer that is given is importable: the files are issued once the search is inside its time.
      for (const hit of hits) {
        issue(pathFromThumbUrl(hit.thumbUrl))
        for (const image of hit.oldSlide?.images ?? []) issue(pathFromThumbUrl(image.thumbUrl))
      }
      return hits
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<ImageSearchHit[]>((resolve) => { timer = setTimeout(() => resolve([]), Math.max(1, limits.searchMs)) })
    try {
      return await Promise.race([
        work().catch((e) => {
          if (!(e instanceof SqliteTimeoutError)) console.error('[image-search:archive] slides', e)
          return [] as ImageSearchHit[]
        }),
        gaveUp
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    name: 'archive',
    wordHits,
    slideHits,
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
