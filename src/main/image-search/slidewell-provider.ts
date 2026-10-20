// Provider 1: SlideWell's shared store, READ-ONLY (ticket 10, ADR-0026: SlideWell owns all writes
// and heavy work; TalkWeaver reads). One search over:
//   - screenshots     triage.db  triage_fts (file name, OCR, app, window title, date)
//   - added images    well.db    well_fts (source 'screenshot' etc.: copies SlideWell owns)
//   - talk images     well.db    well_fts (source 'talkweaver': vault _assets indexed in place)
//   - old-PowerPoint images      the archive provider's words search, as it is
// with "used in" from well.db talk_image_use, and picture matches from SlideWell's running process
// (slidewell-query.ts). Every database is opened -readonly with a mode=ro URI; no file SlideWell
// owns is ever written. Files are served only when a search here returned them (or the archive
// provider vouches for them), so a URL cannot name an arbitrary file on disk — and only while
// SlideWell still lists the item: serving and import re-read its state at request time.
//
// Staying out of SlideWell's way (fix round 1, S1). SlideWell keeps well.db and triage.db in the
// default rollback-journal mode (triage.ts ensureTriage: "NOT WAL") and its writers wait up to 4–5 s
// for a lock (sqlite.ts `.timeout 4000`, `PRAGMA busy_timeout=5000`). Each read here is one sqlite3
// process — one connection, closed when it exits — that waits at most READ_BUSY_MS for SlideWell's
// lock and is killed after READ_LIMIT_MS, which drops its shared lock at once. So a TalkWeaver read
// can delay a SlideWell commit by at most READ_LIMIT_MS, well inside SlideWell's own wait, and it
// never fails one. A read-only connection to a rollback-journal database creates no -journal, -wal
// or -shm file (it cannot write one; a hot journal makes the read fail rather than be rolled back).
//
// What SlideWell hides stays hidden here: an item emptied from the review's Bin is gone from every
// list, and a screenshot in the Bin (its 30-day throwaway clock ran out) is not findable — the same
// rule as SlideWell's review/piles.ts, evaluated in SQL.

import { existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join } from 'path'
import type { ImageSearchHit, ImageUse, MatchMode } from '../../shared/image-search.ts'
import type { ArchiveProvider } from './archive-provider.ts'
import { queryWords, wordsScore } from './archive-provider.ts'
import { extOf, IMAGE_EXTS } from './image-file.ts'
import type { ImageFile, ImageSearchProvider } from './provider.ts'
import { askPictureQuery, PICTURE_QUERY_SOCKET, slidewellUserDataDirs, type PictureAnswer } from './slidewell-query.ts'
import { READ_BUSY_MS, READ_LIMIT_MS, sqliteQuery } from './sqlite-read.ts'
import { isInsideRoot, pathFromThumbUrl, twarchiveUrl } from './thumb-url.ts'

export type SlideWellLocation = {
  /** SlideWell's well folder: well.db, triage.db and the images it owns. */
  wellRoot: string
  /** Where SlideWell's picture-query socket lives when it is running. */
  socketPath: string
}

/** Find SlideWell's store from its own config (wellRoot), else its default; null when absent. */
export function locateSlideWell(home = homedir()): SlideWellLocation | null {
  for (const dir of slidewellUserDataDirs(home)) {
    let wellRoot = join(home, 'SlideWell', 'well')
    let configured = false
    try {
      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { wellRoot?: unknown }
      configured = true
      if (typeof cfg.wellRoot === 'string' && isAbsolute(cfg.wellRoot)) wellRoot = cfg.wellRoot
    } catch {
      if (!existsSync(dir)) continue
    }
    if (existsSync(join(wellRoot, 'well.db')) || existsSync(join(wellRoot, 'triage.db'))) {
      return { wellRoot, socketPath: join(dir, PICTURE_QUERY_SOCKET) }
    }
    if (configured) return null
  }
  return null
}

export type SlideWellProviderDeps = {
  location: () => SlideWellLocation | null
  archive: ArchiveProvider
  sqlite3: () => string | null
  /** TalkWeaver's open vault roots, current first (talk images and "used in" belong to it). */
  vaultRoots: () => string[]
  askPictures?: (socketPath: string, text: string, limit: number) => Promise<PictureAnswer>
  now?: () => number
  /** Tests on a loaded machine only; the app always uses READ_BUSY_MS / READ_LIMIT_MS. */
  readLimits?: { busyMs: number; limitMs: number; schemaTtlMs?: number }
}

const LIMIT = 60
type AliasedHit = ImageSearchHit & { aliases: string[] }
const strip = ({ aliases: _aliases, ...hit }: AliasedHit): ImageSearchHit => hit
/** Per read: the most we wait for SlideWell's lock, and the hard limit after which sqlite3 is killed
 *  (defined beside the reader, where the archive's old-slide reads take the same limits). */
export { READ_BUSY_MS, READ_LIMIT_MS }
const CTX_TTL_MS = 5000 // which tables exist: re-read at most this often (item state is read every time); a failed read is never kept
const RECHECK_BATCH_MS = 5 // thumbnails arriving together are re-checked in one query
const ISSUED_MAX = 20000
const BIN_AFTER_DAYS = 30 // SlideWell review/piles.ts BIN_AFTER_DAYS

type TriageRow = {
  hash: string
  rel_path: string
  filename: string | null
  ext: string | null
  ocr_text: string | null
  source: string | null
  taken_at: string | null
  app: string | null
  window_title: string | null
  mtime: string | null
  well_id: string | null
}
type WellRow = {
  id: string
  slug: string | null
  ext: string | null
  rel_path: string
  root: string | null
  source: string | null
  tags: string | null
  notes: string | null
  ocr_text: string | null
  added_at: string | null
  source_hash: string | null
}

/** FTS5 query: each word quoted (so it is never syntax) and prefix-matched (search as you type).
 *  '' when nothing is left once quotes are stripped: then no FTS query is made at all. */
export function ftsQuery(words: string[]): string {
  return words
    .map((w) => w.replace(/"/g, '').trim())
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(' ')
}

// File-name words: slug and rel_path are UNINDEXED in well_fts, so they are matched with LIKE. Both
// sides are split at the same separators — one list, used for the query words and the SQL
// normaliser alike — so each query word must start a word of the name.
const NAME_SEPARATOR_CHARS = [' ', '\t', '\n', '\r', '\f', '\v', '-', '_', '.', '/', '\\', '"']
const NAME_SEPARATORS = new RegExp('[' + NAME_SEPARATOR_CHARS.map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('') + ']+')
const likeLiteral = (w: string): string => w.replace(/[\\%_]/g, (m) => '\\' + m)
const nameHay = (col: string): string =>
  `(' ' || lower(${NAME_SEPARATOR_CHARS.filter((c) => c !== ' ').reduce((expr, c) => `replace(${expr}, char(${c.charCodeAt(0)}), ' ')`, `COALESCE(${col}, '')`)}))`

/** WHERE clause matching every query word as a word prefix in a well item's slug or file path. */
export function fileNameWhere(words: string[]): { where: string; params: string[] } | null {
  const parts = words.flatMap((w) => w.toLowerCase().split(NAME_SEPARATORS)).filter(Boolean)
  if (!parts.length) return null
  const clause = `(${nameHay('well_fts.slug')} LIKE ? ESCAPE '\\' OR ${nameHay('well_fts.rel_path')} LIKE ? ESCAPE '\\')`
  return {
    where: parts.map(() => clause).join(' AND '),
    params: parts.flatMap((p) => ['% ' + likeLiteral(p) + '%', '% ' + likeLiteral(p) + '%'])
  }
}

const isoDay = (s: string | null | undefined): string | undefined => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined)
const realOr = (p: string): string => {
  try { return realpathSync(p) } catch { return p }
}

export function createSlideWellProvider(deps: SlideWellProviderDeps): ImageSearchProvider {
  const ask = deps.askPictures ?? ((socket, text, limit) => askPictureQuery(socket, text, limit))
  const now = deps.now ?? Date.now
  const limits = deps.readLimits ?? { busyMs: READ_BUSY_MS, limitMs: READ_LIMIT_MS }
  // Files this provider returned, by real path → provenance and the SlideWell item behind it. The
  // only non-archive files served, and only while that item is still listed (fileFor re-checks).
  type ItemRef = { kind: 'triage'; hash: string } | { kind: 'well'; id: string }
  const issued = new Map<string, { provenance: ImageFile['provenance']; item: ItemRef }>()
  const issue = (absPath: string, provenance: ImageFile['provenance'], item: ItemRef): string => {
    const real = realOr(absPath)
    issued.delete(real)
    issued.set(real, { provenance, item })
    if (issued.size > ISSUED_MAX) issued.delete(issued.keys().next().value as string)
    return twarchiveUrl(absPath)
  }

  // triageDb: screenshots can be searched. decisionsDb: where emptied markers live (triage_decisions).
  // triageState 'unknown': triage.db is there but its tables could not be read this time (a lock,
  // a killed read) — what is emptied is then unknown, so nothing that could be emptied is listed.
  type Ctx = {
    sqlite3: string; wellDb: string | null; triageDb: string | null; decisionsDb: string | null; wellRoot: string
    triageState: 'ok' | 'absent' | 'unknown'; hasProposals: boolean; hasSince: boolean; hasWellSources: boolean; hasUsage: boolean
    complete: boolean
  }

  const q = <T>(ctx: Ctx, dbPath: string, sql: string, params: Array<string | number> = [], attach?: Record<string, string>): Promise<T[]> =>
    sqliteQuery<T>({ binary: ctx.sqlite3, dbPath, sql, params, attach, busyTimeoutMs: limits.busyMs, timeoutMs: limits.limitMs, escapePaths: true })

  // Which tables the store has, kept for CTX_TTL_MS so a page of thumbnails does not re-read the
  // schema for each one. Only a context that found a store is kept.
  let ctxCache: { key: string; at: number; ctx: Ctx } | null = null
  async function context(): Promise<Ctx | null> {
    const loc = deps.location()
    const sqlite3 = deps.sqlite3()
    if (!loc || !sqlite3) return null
    const key = loc.wellRoot + '\0' + sqlite3
    if (ctxCache && ctxCache.key === key && Date.now() - ctxCache.at < (limits.schemaTtlMs ?? CTX_TTL_MS) && (!ctxCache.ctx.wellDb || existsSync(ctxCache.ctx.wellDb)) && (!ctxCache.ctx.triageDb || existsSync(ctxCache.ctx.triageDb))) {
      return ctxCache.ctx
    }
    const fresh = await readContext(loc, sqlite3)
    // only a context read without errors is kept; after a failed read the next call reads again
    ctxCache = fresh && fresh.complete ? { key, at: Date.now(), ctx: fresh } : null
    return fresh
  }

  async function readContext(loc: SlideWellLocation, sqlite3: string): Promise<Ctx | null> {
    const wellDb = existsSync(join(loc.wellRoot, 'well.db')) ? join(loc.wellRoot, 'well.db') : null
    const triageDb = existsSync(join(loc.wellRoot, 'triage.db')) ? join(loc.wellRoot, 'triage.db') : null
    if (!wellDb && !triageDb) return null
    const ctx: Ctx = {
      sqlite3, wellDb, triageDb, decisionsDb: null, wellRoot: loc.wellRoot,
      triageState: triageDb ? 'ok' : 'absent', hasProposals: false, hasSince: false, hasWellSources: false, hasUsage: false, complete: true
    }
    // the table list, or null when it could not be read (never mistaken for "no tables")
    const names = async (db: string | null): Promise<Set<string> | null> => {
      if (!db) return new Set()
      try {
        const rows = await q<{ name: string }>(ctx, db, "SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        return new Set(rows.map((r) => r.name))
      } catch {
        ctx.complete = false
        return null
      }
    }
    const [wellNames, triageNames] = await Promise.all([names(wellDb), names(triageDb)])
    // well.db unreadable: no well hits this time (its emptied links cannot be checked either)
    if (!wellNames || !wellNames.has('well_fts')) ctx.wellDb = null
    ctx.hasWellSources = !!wellNames?.has('well_sources')
    ctx.hasUsage = !!wellNames?.has('talk_image_use') && !!wellNames?.has('talk_usage_meta')
    if (triageDb && !triageNames) {
      ctx.triageState = 'unknown'
      ctx.triageDb = null
    } else if (triageDb && triageNames) {
      if (triageNames.has('triage_decisions')) ctx.decisionsDb = triageDb
      else ctx.triageState = 'absent' // no decisions table: nothing has been emptied
      if (!triageNames.has('triage_fts') || !triageNames.has('triage_decisions')) ctx.triageDb = null
      if (ctx.triageDb && triageNames.has('sorter_proposals')) {
        ctx.hasProposals = true
        try {
          const cols = await q<{ name: string }>(ctx, ctx.triageDb, "SELECT name FROM pragma_table_info('sorter_proposals')")
          ctx.hasSince = cols.some((c) => c.name === 'throwaway_since')
        } catch {
          // the Bin clock's columns are unknown: screenshots are not listed this time
          ctx.complete = false
          ctx.triageDb = null
        }
      }
    }
    return ctx.wellDb || ctx.triageDb ? ctx : null
  }

  // A screenshot SlideWell no longer lists: emptied, or in the Bin (30 days in Throwaway).
  // Mirrors piles.ts pileOf: his decision first, else the sorter's throwaway clock; an unreadable
  // date keeps the item listed (julianday() is NULL, the comparison is not true).
  function hiddenTriageSql(ctx: Ctx, nowIso: string): { sql: string; params: string[] } {
    const clock = `julianday(?) - ${BIN_AFTER_DAYS}`
    let sql = `COALESCE(d.state, 'undecided') = 'emptied' OR (d.state = 'excluded' AND julianday(d.decided_at) <= ${clock})`
    const params = [nowIso]
    if (ctx.hasProposals) {
      const since = ctx.hasSince ? 'COALESCE(p.throwaway_since, p.proposed_at)' : 'p.proposed_at'
      sql += ` OR (COALESCE(d.state, 'undecided') NOT IN ('selected', 'included', 'excluded', 'emptied') AND p.proposal = 'throwaway' AND julianday(${since}) <= ${clock})`
      params.push(nowIso)
    }
    // NULLs (no decision, no proposal, an unreadable date) must read as 'not hidden', never unknown
    return { sql: `COALESCE((${sql}), 0)`, params }
  }

  const TRIAGE_COLS = 'triage_fts.hash, triage_fts.rel_path, triage_fts.filename, triage_fts.ext, triage_fts.ocr_text, triage_fts.source, triage_fts.taken_at, triage_fts.app, triage_fts.window_title, triage_fts.mtime, d.well_id'

  async function triageRows(ctx: Ctx, where: string, params: Array<string | number>, order: string, limit = LIMIT): Promise<TriageRow[]> {
    if (!ctx.triageDb) return []
    const hidden = hiddenTriageSql(ctx, new Date(now()).toISOString())
    const join = `triage_fts LEFT JOIN triage_decisions d ON d.hash = triage_fts.hash${ctx.hasProposals ? ' LEFT JOIN sorter_proposals p ON p.hash = triage_fts.hash' : ''}`
    try {
      return await q<TriageRow>(
        ctx,
        ctx.triageDb,
        `SELECT ${TRIAGE_COLS} FROM ${join}
         WHERE ${where} AND triage_fts.kind = 'image' AND triage_fts.offline != '1' AND NOT ${hidden.sql}
         ${order} LIMIT ?`,
        [...params, ...hidden.params, limit]
      )
    } catch (e) {
      console.error('[image-search:slidewell] screenshots', e)
      return []
    }
  }

  async function wellRows(ctx: Ctx, where: string, params: Array<string | number>, order: string, limit = LIMIT): Promise<WellRow[]> {
    if (!ctx.wellDb) return []
    const sourceHash = ctx.hasWellSources ? '(SELECT ws.source_hash FROM well_sources ws WHERE ws.well_id = well_fts.id LIMIT 1)' : 'NULL'
    // Emptied from the Bin: hidden by content identity (well_sources), as SlideWell's well.ts does.
    // When the decisions could not be read, every item linked to a screenshot might be emptied: none
    // is listed (fail closed); items with no screenshot behind them cannot be emptied and stay.
    const emptied = !ctx.hasWellSources
      ? ''
      : ctx.triageState === 'unknown'
        ? ` AND well_fts.id NOT IN (SELECT ws.well_id FROM well_sources ws)`
        : ctx.decisionsDb
          ? ` AND well_fts.id NOT IN (SELECT ws.well_id FROM well_sources ws JOIN t.triage_decisions td ON td.hash = ws.source_hash WHERE td.state = 'emptied')`
          : ''
    try {
      return await q<WellRow>(
        ctx,
        ctx.wellDb,
        `SELECT well_fts.id, well_fts.slug, well_fts.ext, well_fts.rel_path, well_fts.root, well_fts.source, well_fts.tags, well_fts.notes, well_fts.ocr_text, well_fts.added_at, ${sourceHash} AS source_hash
         FROM well_fts WHERE ${where}${emptied} ${order} LIMIT ?`,
        [...params, limit],
        emptied.includes('t.triage_decisions') ? { t: ctx.decisionsDb! } : undefined
      )
    } catch (e) {
      console.error('[image-search:slidewell] well', e)
      return []
    }
  }

  /** "Used in" by pool id, only when SlideWell's snapshot describes TalkWeaver's current vault. */
  async function usage(ctx: Ctx, ids: string[]): Promise<{ uses: Map<string, ImageUse[]>; vaultRoot: string | null }> {
    const uses = new Map<string, ImageUse[]>()
    const current = deps.vaultRoots()[0]
    if (!ctx.wellDb || !ctx.hasUsage || !current) return { uses, vaultRoot: null }
    try {
      const meta = await q<{ value: string }>(ctx, ctx.wellDb, "SELECT value FROM talk_usage_meta WHERE key = 'vault_root'")
      const scanned = meta[0]?.value
      if (!scanned || realOr(scanned) !== realOr(current)) return { uses, vaultRoot: null }
      const want = [...new Set(ids.filter((id) => /^[0-9a-f]{7}$/i.test(id)))]
      for (let i = 0; i < want.length; i += 400) {
        const chunk = want.slice(i, i + 400)
        const rows = await q<{ image_id: string; talk_rel_path: string; talk_title: string; slide: number }>(
          ctx,
          ctx.wellDb,
          `SELECT image_id, talk_rel_path, talk_title, slide FROM talk_image_use WHERE image_id IN (${chunk.map(() => '?').join(',')}) ORDER BY talk_title, slide`,
          chunk
        )
        for (const r of rows) {
          const list = uses.get(r.image_id) ?? []
          if (!list.some((u) => u.talkPath === r.talk_rel_path && u.slide === Number(r.slide))) {
            list.push({ talkTitle: r.talk_title, talkPath: r.talk_rel_path, slide: Number(r.slide) || 0 })
          }
          uses.set(r.image_id, list)
        }
      }
      return { uses, vaultRoot: scanned }
    } catch (e) {
      console.error('[image-search:slidewell] used in', e)
      return { uses, vaultRoot: null }
    }
  }

  /** Where a well row's file is: SlideWell's own copy, or a talk image in a TalkWeaver vault. */
  function wellFile(ctx: Ctx, r: WellRow, scannedVault: string | null): string | null {
    if (!r.rel_path || !IMAGE_EXTS.has(extOf(r.rel_path))) return null
    if (r.root === 'vault') {
      const vaults = [...(scannedVault ? [scannedVault] : []), ...deps.vaultRoots()]
      for (const v of vaults) {
        const abs = join(v, r.rel_path)
        if (isInsideRoot(abs, v) && existsSync(abs)) return abs
      }
      return null
    }
    const abs = join(ctx.wellRoot, r.rel_path)
    return isInsideRoot(abs, ctx.wellRoot) && existsSync(abs) ? abs : null
  }

  function triageFile(r: TriageRow): string | null {
    if (!r.source || !isAbsolute(r.source) || !r.rel_path) return null
    const abs = join(r.source, r.rel_path)
    if (!IMAGE_EXTS.has(extOf(abs)) || !isInsideRoot(abs, r.source) || !existsSync(abs)) return null
    return abs
  }

  /** Rows → hits. A screenshot already in the well is one hit (keyed by its well id), with the
   *  screenshot's app / window / date and the well's copy of the file when it has one. Each hit
   *  carries every id it is known by (aliases), so a picture match never repeats a words hit. */
  async function toHits(ctx: Ctx, tRows: TriageRow[], wRows: WellRow[], words: string[], match: 'words' | 'meaning', scoreOf: (aliases: string[]) => number): Promise<AliasedHit[]> {
    const wellIds = [...wRows.map((r) => r.id), ...tRows.map((r) => r.well_id || '')].filter(Boolean)
    const { uses, vaultRoot } = await usage(ctx, wellIds)
    const wellById = new Map(wRows.map((r) => [r.id, r]))
    // the well's copies of screenshots whose well row the search itself did not return
    const missing = [...new Set(tRows.map((r) => r.well_id || '').filter((id) => id && !wellById.has(id)))]
    if (missing.length) {
      for (const r of await wellRows(ctx, `well_fts.id IN (${missing.map(() => '?').join(',')})`, missing, '')) wellById.set(r.id, r)
    }
    const out: AliasedHit[] = []
    const taken = new Set<string>()

    for (const r of tRows) {
      const wellRow = r.well_id ? wellById.get(r.well_id) : undefined
      const aliases = [`triage:${r.hash}`, ...(r.well_id ? [`well:${r.well_id}`] : [])]
      if (aliases.some((a) => taken.has(a))) continue
      const abs = (wellRow ? wellFile(ctx, wellRow, vaultRoot) : null) ?? triageFile(r)
      if (!abs) continue
      aliases.forEach((a) => taken.add(a))
      const date = isoDay(r.taken_at) ?? (Number(r.mtime) ? new Date(Number(r.mtime)).toISOString().slice(0, 10) : undefined)
      const windowTitle = r.window_title || undefined
      const app = r.app || undefined
      const title = windowTitle || r.filename || basename(r.rel_path)
      out.push({
        aliases,
        key: aliases[aliases.length - 1],
        source: 'screenshot',
        thumbUrl: issue(abs, { source: 'screenshot', note: 'imported from SlideWell (screenshot): ' + abs }, { kind: 'triage', hash: r.hash }),
        title,
        detail: [app, date].filter(Boolean).join(' · '),
        ocrText: r.ocr_text || '',
        match,
        score: match === 'words' ? wordsScore(words, [windowTitle, app, r.filename || undefined]) : scoreOf(aliases),
        usedIn: (r.well_id && uses.get(r.well_id)) || [],
        ...(app ? { app } : {}),
        ...(windowTitle ? { windowTitle } : {}),
        ...(date ? { date } : {})
      })
    }
    for (const r of wRows) {
      const aliases = [`well:${r.id}`, ...(r.source_hash ? [`triage:${r.source_hash}`] : [])]
      if (aliases.some((a) => taken.has(a))) continue
      const abs = wellFile(ctx, r, vaultRoot)
      if (!abs) continue
      aliases.forEach((a) => taken.add(a))
      const talk = r.root === 'vault' || r.source === 'talkweaver'
      const usedIn = uses.get(r.id) ?? []
      const date = isoDay(r.added_at)
      const slugTitle = (r.slug || '').replace(/-/g, ' ').trim()
      const title = talk ? usedIn[0]?.talkTitle || slugTitle || basename(r.rel_path) : slugTitle || basename(r.rel_path)
      out.push({
        aliases,
        key: aliases[0],
        source: talk ? 'talk-image' : 'added-image',
        thumbUrl: issue(abs, talk
          ? { source: 'talkweaver', note: 'imported from a talk image: ' + abs }
          : { source: 'slidewell', note: 'imported from SlideWell: ' + abs }, { kind: 'well', id: r.id }),
        title,
        detail: talk ? (date ? date.slice(0, 4) : '') : date ?? '',
        ocrText: r.ocr_text || '',
        match,
        score: match === 'words' ? wordsScore(words, [title, r.tags || undefined, r.notes || undefined]) : scoreOf(aliases),
        usedIn,
        ...(date ? { date } : {})
      })
    }
    return out
  }

  /** Words band: screenshots, well and talk images, archive images; by score, then by each list's rank in turn. */
  async function wordsBand(ctx: Ctx, query: string, words: string[]): Promise<{ hits: ImageSearchHit[]; aliases: Set<string> }> {
    const fts = ftsQuery(words)
    const byName = fileNameWhere(words)
    const [tRows, wFts, wByName, archiveHits] = await Promise.all([
      triageRows(ctx, 'triage_fts MATCH ?', [fts], 'ORDER BY rank'),
      wellRows(ctx, 'well_fts MATCH ?', [fts], 'ORDER BY rank'),
      byName ? wellRows(ctx, byName.where, byName.params, 'ORDER BY well_fts.added_at DESC') : Promise.resolve([] as WellRow[]),
      deps.archive.wordHits(query).then((h) => h ?? [])
    ])
    // text matches first, then items found only by their file name; each item once
    const ftsIds = new Set(wFts.map((r) => r.id))
    const wRows = [...wFts, ...wByName.filter((r) => !ftsIds.has(r.id))]
    const own = await toHits(ctx, tRows, wRows, words, 'words', () => 0)
    const aliases = new Set(own.flatMap((h) => h.aliases))
    // Usage of archive images by pool id: an imported archive image is named by its bytes' sha256.
    if (archiveHits.length) {
      const { uses } = await usage(ctx, archiveHits.map((h) => (h.archive?.sha256 ?? '').slice(0, 7)))
      for (const h of archiveHits) h.usedIn = uses.get((h.archive?.sha256 ?? '').slice(0, 7)) ?? []
    }
    const lists: ImageSearchHit[][] = [own.filter((h) => h.source === 'screenshot').map(strip), own.filter((h) => h.source !== 'screenshot').map(strip), archiveHits]
    const ranked = lists.flatMap((list, li) => list.map((hit, i) => ({ hit, order: i * lists.length + li })))
    ranked.sort((a, b) => b.hit.score - a.hit.score || a.order - b.order)
    return { hits: ranked.map((r) => r.hit), aliases }
  }

  /** Picture matches → hits, in SlideWell's order, skipping anything the words band already has. */
  async function meaningBand(ctx: Ctx, answer: PictureAnswer & { ok: true }, seen: Set<string>): Promise<ImageSearchHit[]> {
    const scores = new Map<string, number>()
    const wellIds: string[] = []
    const hashes: string[] = []
    for (const h of answer.hits) {
      if (seen.has(h.id) || scores.has(h.id)) continue
      // picture-search ids are '<kind>:<id>'; old slides belong to the Old slides tab (ticket 12)
      const colon = h.id.indexOf(':')
      const kind = h.id.slice(0, colon)
      const id = h.id.slice(colon + 1)
      if (kind === 'well' && /^[0-9a-f]{7,64}$/i.test(id)) wellIds.push(id)
      else if (kind === 'triage' && /^[0-9a-f]{6,64}$/i.test(id)) hashes.push(id)
      else continue
      scores.set(h.id, h.score)
    }
    if (!scores.size) return []
    const inList = (n: number): string => Array.from({ length: n }, () => '?').join(',')
    const wRows = wellIds.length ? await wellRows(ctx, `well_fts.id IN (${inList(wellIds.length)})`, wellIds, '') : []
    // a kept screenshot matched by its well id still shows its app, window and date
    for (const r of wRows) if (r.source_hash && !hashes.includes(r.source_hash)) hashes.push(r.source_hash)
    const tRows = hashes.length ? await triageRows(ctx, `triage_fts.hash IN (${inList(hashes.length)})`, hashes, '') : []
    const scoreOf = (aliases: string[]): number => Math.max(...aliases.map((a) => scores.get(a) ?? 0))
    const rankOf = new Map([...scores.keys()].map((id, i) => [id, i]))
    const rank = (h: AliasedHit): number => Math.min(...h.aliases.map((a) => rankOf.get(a) ?? Infinity))
    return (await toHits(ctx, tRows, wRows, [], 'meaning', scoreOf))
      .filter((h) => !h.aliases.some((a) => seen.has(a)))
      .sort((a, b) => rank(a) - rank(b))
      .map(strip)
  }

  // Is an issued item still one SlideWell lists? Asked per thumbnail request and per import, so
  // requests arriving together share one query per database (a results page is ~60 thumbnails).
  // Any failure — store gone, lock held past READ_BUSY_MS, read past READ_LIMIT_MS — refuses.
  type Pending = { item: ItemRef; resolve: (ok: boolean) => void }
  let pending: Pending[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  function stillListed(item: ItemRef): Promise<boolean> {
    return new Promise((resolve) => {
      pending.push({ item, resolve })
      if (!flushTimer) flushTimer = setTimeout(() => void flush(), RECHECK_BATCH_MS)
    })
  }
  async function flush(): Promise<void> {
    const batch = pending
    pending = []
    flushTimer = null
    const listed = new Set<string>()
    try {
      const ctx = await context()
      if (ctx) {
        const hashes = [...new Set(batch.flatMap((p) => (p.item.kind === 'triage' ? [p.item.hash] : [])))]
        const ids = [...new Set(batch.flatMap((p) => (p.item.kind === 'well' ? [p.item.id] : [])))]
        const inList = (n: number): string => Array.from({ length: n }, () => '?').join(',')
        const reads: Array<Promise<void>> = []
        for (let i = 0; i < hashes.length; i += 400) {
          const chunk = hashes.slice(i, i + 400)
          reads.push(triageRows(ctx, `triage_fts.hash IN (${inList(chunk.length)})`, chunk, '', chunk.length * 4)
            .then((rows) => rows.forEach((r) => listed.add('triage:' + r.hash))))
        }
        for (let i = 0; i < ids.length; i += 400) {
          const chunk = ids.slice(i, i + 400)
          reads.push(wellRows(ctx, `well_fts.id IN (${inList(chunk.length)})`, chunk, '', chunk.length * 4)
            .then((rows) => rows.forEach((r) => listed.add('well:' + r.id))))
        }
        await Promise.all(reads)
      }
    } catch (e) {
      console.error('[image-search:slidewell] re-check', e)
    }
    for (const p of batch) p.resolve(listed.has(p.item.kind === 'triage' ? 'triage:' + p.item.hash : 'well:' + p.item.id))
  }

  return {
    name: 'slidewell',
    async available() {
      return (await context()) !== null
    },
    async search(query, opts) {
      const ctx = await context()
      if (!ctx) return null
      const match: MatchMode = opts?.match ?? 'both'
      const words = queryWords(query)
      // empty, or nothing but quotes: no FTS query (it would be MATCH ''), no picture query
      if (ftsQuery(words) === '') return { provider: 'slidewell', hits: [], meaning: 'off' }
      const loc = deps.location()
      const asking: Promise<PictureAnswer | null> = match === 'words' || !loc ? Promise.resolve(null) : ask(loc.socketPath, words.join(' '), LIMIT).catch(() => ({ ok: false, reason: 'not-running' }) as PictureAnswer)
      const band = match === 'meaning' ? { hits: [] as ImageSearchHit[], aliases: new Set<string>() } : await wordsBand(ctx, query, words)
      const answer = await asking
      if (match === 'words') return { provider: 'slidewell', hits: band.hits, meaning: 'off' }
      if (!answer || !answer.ok) return { provider: 'slidewell', hits: band.hits, meaning: 'unavailable' }
      const related = await meaningBand(ctx, answer, band.aliases)
      return { provider: 'slidewell', hits: [...band.hits, ...related], meaning: 'used' }
    },
    async fileFor(thumbUrl) {
      const fromArchive = await deps.archive.fileFor(thumbUrl)
      if (fromArchive) return fromArchive
      const absPath = pathFromThumbUrl(thumbUrl)
      if (!absPath) return null
      const entry = issued.get(realOr(absPath))
      if (!entry || !existsSync(absPath)) return null
      // Revocation: SlideWell's state now, not when the search ran (emptied, in the Bin, online-only).
      if (!(await stillListed(entry.item))) return null
      return { absPath, provenance: entry.provenance }
    }
  }
}
