// Moving the preferences from userData/config.json into the settings store (0.40, shared settings).
//
// Rules (orchestrator, 2026-10-20, replacing "back up beside the old file"):
//   - The store writes a NEW file, userData/settings.json. config.json is never copied, deleted or
//     rewritten by the migration: it stays the old version's file, and so is the backup. (Main goes
//     on writing its non-preference keys there as before; its copies of the preferences are left as
//     they are and no longer read.)
//   - config.json is read for migration only, with no size cap, and only schema-known, non-secret
//     preferences are taken from it (settingsFromConfig); nothing else in it is copied anywhere.
//   - A migration leaves a stamp, userData/settings-migration.json: per preference, a hash of the
//     value config.json held (no values). When config.json's preferences differ from the stamp at a
//     later launch (the old version ran after a downgrade and saved), the preferences it changed are
//     migrated again, as "app update" entries, and the stamp is renewed.
//   - Runs to completion before anything reads a preference: the app and `TalkWeaver settings …`
//     call runMigration() and only then open the store they read from.
//
// No Electron import: scripts/test-shared-settings.mjs runs it in a temporary folder.
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { LEGACY_MARK, acceptedValue, legacyFileFor, schema, settingsFromConfig } from '../shared/settings-schema.ts'

type Bag = Record<string, unknown>
const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v)

export const SETTINGS_FILE = 'settings.json'
export const CONFIG_FILE = 'config.json'
export const STAMP_FILE = 'settings-migration.json'

type Result = { ok: true } | { ok: false; error: string }
/** The part of SettingsStore the migration uses (opened by the caller as who: app-update). */
export interface MigrationStore {
  ready: Promise<unknown>
  problem(): unknown
  view(): { settings: Readonly<Bag>; changes: ReadonlyArray<{ key?: string; at: number; who?: Who }> }
  set(key: string, value: unknown): Promise<Result>
  reset(key: string): Promise<Result>
  close(): Promise<void>
}

function readJson(fs: typeof nodeFs, path: string): unknown {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) } catch { return undefined }
}

/**
 * config.json for the migration (Sol review 1, #8): missing is "nothing to migrate"; a file that
 * cannot be read, does not parse, or is not an object is unreadable, and the migration stops there
 * (no hand-over, no store write, no stamp), so a damaged or locked old file never resets anything.
 */
type LegacyRead = { kind: 'missing' } | { kind: 'ok'; config: Bag } | { kind: 'unreadable' }
function readLegacyConfig(fs: typeof nodeFs, dir: string): LegacyRead {
  let text: string
  try { text = fs.readFileSync(join(dir, CONFIG_FILE), 'utf8') } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  try {
    const config = JSON.parse(text) as unknown
    return isBag(config) ? { kind: 'ok', config } : { kind: 'unreadable' }
  } catch { return { kind: 'unreadable' } }
}

/** A new file only: created exclusively (0600, no link followed), fsynced, then linked into place; never replaces a file. */
function writeNewFile(fs: typeof nodeFs, dir: string, name: string, value: unknown): boolean {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${name}.migrating-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const data = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
    let off = 0
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  let placed = true
  try { fs.linkSync(tmp, join(dir, name)) } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') { try { fs.unlinkSync(tmp) } catch { /* swept by name */ } throw error }
    placed = false
  }
  try { fs.unlinkSync(tmp) } catch { /* harmless */ }
  return placed
}

/** Replaces our own stamp file (temp + rename; the stamp is the migration's own file, never config.json). */
function writeStamp(fs: typeof nodeFs, dir: string, hashes: Record<string, string>): void {
  const tmp = join(dir, `.${STAMP_FILE}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    fs.writeSync(fd, JSON.stringify({ format: 'talkweaver-settings-migration', version: 1, at: Date.now(), hashes }, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, join(dir, STAMP_FILE))
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (isBag(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))
const hashOf = (v: unknown): string => createHash('sha256').update(canon(v)).digest('hex').slice(0, 32)

/** config.json's preferences now, as schema key → hash of the value; every schema preference listed ('' when config.json has none). */
function preferenceHashes(prefs: Bag): Record<string, string> {
  const out: Record<string, string> = {}
  for (const def of schema.settings) {
    if (def.type === 'secret') continue
    out[def.key] = Object.hasOwn(prefs, def.key) ? hashOf(prefs[def.key]) : ''
  }
  return out
}

export type MigrationOutcome =
  | { kind: 'none' }
  | { kind: 'first'; preferences: number; notSaved?: string[] }
  | { kind: 'again'; keys: string[]; kept?: string[]; notSaved?: string[] }
  | { kind: 'not-saved' }
  | { kind: 'refused' }
  /** config.json is there but could not be read or parsed: nothing was done; tried again next time. */
  | { kind: 'unreadable' }

/** Who made a change, as the Changes filters count it: a reset counts as whoever reset it. */
type Who = { kind: string; by?: { kind: string } }
const actorOf = (who: Who | undefined): string => (who?.kind === 'reset' ? who.by?.kind ?? 'you' : who?.kind ?? 'you')

/** Stamped for a preference whose write did not land and that the stamp did not hold before: never a hash, so it is tried again. */
const NOT_SAVED = 'not-saved'

/** Still the legacy file we wrote (the store has not written it back as its own yet). */
function isLegacyOnDisk(fs: typeof nodeFs, dir: string): boolean {
  const raw = readJson(fs, join(dir, SETTINGS_FILE))
  return isBag(raw) && raw['format'] === LEGACY_MARK
}

/** Replaces our own legacy hand-over file (never a store file): temp + rename. */
function replaceLegacyFile(fs: typeof nodeFs, dir: string, value: unknown): void {
  const tmp = join(dir, `.${SETTINGS_FILE}.migrating-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, join(dir, SETTINGS_FILE))
}

/** A preference value the schema refuses: never handed over or set, so there is nothing to retry. */
function refusedBySchema(key: string, value: unknown): boolean {
  return !acceptedValue(key, value)
}

/** What the opened store holds for `key` (its default when it stores none). */
function storedValue(store: MigrationStore, key: string): unknown {
  const settings = store.view().settings
  return Object.hasOwn(settings, key) ? settings[key] : schema.def(key)?.default
}

/**
 * Before the store the app reads from is opened. `open()` opens a store on `dir` logging as
 * who: app-update (the caller's SettingsStore with migrate: migrateLegacy); it is closed here.
 *
 * Only writes that landed are stamped (orchestrator rule, 2026-10-20): a preference whose write
 * failed (the settings file locked by another process, say) keeps its old stamp, so the next launch,
 * or the next `talkweaver settings` command, tries it again. A first migration whose file the store
 * could not write back stays our legacy file and writes no stamp.
 *
 * Re-migration conflict rule (orchestrator decision, 2026-10-20, corrected the same day): a preference
 * the old version changed after the stamp is applied only when the new store's changelog has no
 * change to it at or after the stamp's time; otherwise the new value is kept (and stamped, so it is
 * not asked again). Entries logged as "app update" (the migrations themselves) do not count.
 * (config.json's modification time is not used: the old version's save comes after the new
 * version's change, so it would always win.)
 */
export async function runMigration(dir: string, open: () => MigrationStore, fs: typeof nodeFs = nodeFs): Promise<MigrationOutcome> {
  const legacy = readLegacyConfig(fs, dir)
  if (legacy.kind === 'unreadable') return { kind: 'unreadable' } // nothing written, the stamp as it was
  // No config.json beside a settings file of the store's own: nothing to migrate, and nothing reset
  // (a removed old file is not the old version putting every preference back to its default).
  if (legacy.kind === 'missing' && fs.existsSync(join(dir, SETTINGS_FILE)) && !isLegacyOnDisk(fs, dir)) return { kind: 'none' }
  const config: Bag = legacy.kind === 'ok' ? legacy.config : {}
  const prefs = settingsFromConfig(config)
  const hashes = preferenceHashes(prefs)
  const stamp = readJson(fs, join(dir, STAMP_FILE))
  const stamped = isBag(stamp) && isBag(stamp['hashes'])
  const before = stamped ? (stamp['hashes'] as Record<string, unknown>) : null
  let first = false
  if (!fs.existsSync(join(dir, SETTINGS_FILE))) first = writeNewFile(fs, dir, SETTINGS_FILE, legacyFileFor(config))
  else if (!before && isLegacyOnDisk(fs, dir)) {
    // An earlier first migration whose write did not land: hand over config.json as it is now.
    replaceLegacyFile(fs, dir, legacyFileFor(config))
    first = true
  }
  const store = open()
  try {
    await store.ready
    if (store.problem() !== undefined) return { kind: 'refused' }
    if (first) {
      if (isLegacyOnDisk(fs, dir)) return { kind: 'not-saved' } // nothing landed: no stamp, tried again next time
      // Only what reads back from the opened store is stamped (Sol review 1, #1): a value the store
      // did not keep (the hand-over set aside as damaged, say) is stamped not-saved and set again at
      // the next launch, as a re-migration. A value the schema refuses was never handed over.
      const next: Record<string, string> = {}
      const notSaved: string[] = []
      for (const key of Object.keys(hashes)) {
        if (!Object.hasOwn(prefs, key) || refusedBySchema(key, prefs[key]) || canon(storedValue(store, key)) === canon(prefs[key])) next[key] = hashes[key]
        else { next[key] = NOT_SAVED; notSaved.push(key) }
      }
      writeStamp(fs, dir, next)
      const landed = Object.keys(prefs).filter((k) => !notSaved.includes(k) && !refusedBySchema(k, prefs[k])).length
      return { kind: 'first', preferences: landed, ...(notSaved.length ? { notSaved } : {}) }
    }
    // No stamp but a store file of its own (an earlier migration that stopped before its stamp, or a
    // store opened while config.json could not be read): every preference config.json holds is
    // treated as changed since time 0, under the conflict rule below, so a change made in this
    // version is kept and the rest is moved in.
    const base: Record<string, unknown> = before ?? {}
    const changed = Object.keys(hashes).filter((k) => (base[k] ?? '') !== hashes[k])
    if (changed.length === 0) {
      if (!stamped) writeStamp(fs, dir, hashes)
      return { kind: 'none' }
    }
    let stampAt = stamped && typeof (stamp as Bag)['at'] === 'number' ? (stamp as Bag)['at'] as number : stamped ? NaN : 0
    if (!Number.isFinite(stampAt)) { try { stampAt = fs.statSync(join(dir, STAMP_FILE)).mtimeMs } catch { stampAt = 0 } } // a stamp written before it carried its time
    const changes = store.view().changes
    const changedHereSince = (key: string): boolean => changes.some((c) => c.key === key && c.at >= stampAt && actorOf(c.who) !== 'app-update')
    const next: Record<string, string> = {}
    for (const [k, h] of Object.entries(base)) if (typeof h === 'string') next[k] = h
    const applied: string[] = []
    const kept: string[] = []
    const notSaved: string[] = []
    for (const key of changed) {
      if (changedHereSince(key)) { kept.push(key); next[key] = hashes[key]; continue }
      if (Object.hasOwn(prefs, key) && refusedBySchema(key, prefs[key])) { next[key] = hashes[key]; continue }
      let landed = false
      try {
        const r = Object.hasOwn(prefs, key) ? await store.set(key, prefs[key]) : await store.reset(key)
        landed = r.ok
      } catch { landed = false }
      if (landed) { applied.push(key); next[key] = hashes[key] } else { notSaved.push(key); next[key] = typeof base[key] === 'string' ? (base[key] as string) : NOT_SAVED }
    }
    for (const k of Object.keys(hashes)) if (!Object.hasOwn(next, k)) next[k] = hashes[k]
    writeStamp(fs, dir, next)
    return { kind: 'again', keys: applied, ...(kept.length ? { kept } : {}), ...(notSaved.length ? { notSaved } : {}) }
  } finally {
    await store.close()
  }
}
