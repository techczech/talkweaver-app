// The set-up folder engine (0.45, two Macs). The format, the allow-list, the merge rule and the words
// are src/shared/setup-folder.ts (rules F1–F6 there); this file reads the folder, applies the merge to
// this Mac's settings and writes this Mac's own file.
//
// One cycle (`cycle`), on start, when the folder changes, when a setting changes here, and on demand:
//   1. One read (`readSnapshot`): every file in the set-up folder, within a time and file-count budget,
//      read-only opens. Each file and entry is judged before it can enter the snapshot (parseMacFile:
//      the allow-list's rules, change times inside the window); what is refused is counted and named.
//      The snapshot is frozen: nothing later reads the folder again for this cycle.
//   2. This Mac's own record (app data, `setup-folder-state.json`): every travelling value this Mac holds,
//      in its canonical form (the allow-list's rule), with its change time. A value that differs from the
//      record was changed here since the last cycle and is stamped (F4). A value its rule refuses stays
//      on this Mac: it is neither written nor replaced, and the page says so.
//   3. One plan (`makePlan`) from that snapshot: newest wins per target (F3). On first join the plan is the
//      preview, and Apply applies that same plan object. Joined, the plan's changes are applied by
//      `applyPlan`, the only function that changes this Mac's settings with values from another Mac;
//      where publishing goes (ASK_FIRST) is offered instead (Use on this Mac).
//   4. Kill-safe: before anything changes, the batch (each target's previous and new value) is saved in
//      this Mac's record; it is completed after. A batch found on start is finished when every change in
//      it landed, else what landed is put back (and the next read applies it again); the page says which.
//   5. Only then is this Mac's own file written: a fresh temporary file beside it (exclusive create,
//      flushed), the destination checked again to be this Mac's own, renamed over it, the folder flushed.
// The folder chosen has a generation; a cycle checks it after every await (AWAIT_POINTS) and so before
// every change and every write, so a cycle still running when the folder is cleared or changed changes
// nothing more (`folderChanged` waits for it).
//
// This Mac's identity is bound to the computer: the record keeps a fingerprint (a hash of the hardware id;
// the hardware id itself is never written anywhere), and this Mac's file carries a mark derived from it and
// the Mac id. Only that mark proves a file is this Mac's. App data copied to another Mac (Migration
// Assistant, a restored backup) is found on start: the copy takes a new id and a file of its own, leaves the
// original's file untouched and says so once. A Mac whose fingerprint cannot be read writes nothing to the
// folder: it reads and applies through the same plan, and says why it keeps no file there.
//
// A batch is marked undone, and a batch left by a stop part-way cleared, only when every value in it has
// been put back and read back; otherwise it stays (listed, Undo tries again) and the page names what was not.
//
// No Electron import; erasable TypeScript only (scripts/test-setup-folder.mjs drives it with real
// settings stores, one user-data folder per simulated Mac, and a recording file system).
import { randomUUID, createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { constants as FS, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { EXPORT_FORMAT, EXPORT_VERSION, chordOf, valueOf, type CommandsAdapter, type ImportPreview, type Schema, type SettingValue, type SettingsState } from '@app-patterns/settings'
import {
  EARLIEST_AT, HEARTBEAT_MS, OFFER_KINDS, SETUP_FILE_FORMAT, SETUP_FILE_MAX_BYTES, SETUP_FILE_VERSION, SKIP_WORDS, SUGGESTIONS, SUGGESTION_LABEL, VAULT_FIELDS, VAULT_FIELD_LABEL,
  aboutDuration, batchFileLabel, classifyName, cleanMacName, entryJudge, isAskFirst, isChangeTime, isMacId, localStamp, macFileName, newestWins, ownTempPrefix, ownershipOf,
  parseMacFile, rejectedWords, resolveSetupFolder, serialiseChord, serialiseMacFile, serialiseSetting, serialiseSuggestion, serialiseVaultField, settingTarget, shortcutTarget, targetsOf,
  travellingSettingKeys, vaultTarget,
  type MacFile, type OfferKind, type SetupFolderBatch, type SetupFolderChangeRow, type SetupFolderMac, type SetupFolderNotice, type SetupFolderSkip, type SetupFolderStatus,
  type SetupFolderSuggestion, type SkipReason, type Stamped, type SuggestionKind, type VaultField, type Verdict, type Winner
} from '../shared/setup-folder.ts'
import { trackWrite } from './write-queues.ts'

export const STATE_FILE = 'setup-folder-state.json'
const STATE_FORMAT = 'talkweaver-setup-folder-state'
const RECENT_WRITES = 50
const HISTORY_KEPT = 20
/** One read of the folder takes at most this long, in all (a stalled sync service does not hold later requests). */
export const READ_BUDGET_MS = 15_000
/** One read looks at no more files carrying a Mac id than this. */
export const READ_MAX_FILES = 64

/**
 * Every await of a cycle between its read of the folder and its last write there. After each, the cycle checks
 * the folder's generation before it changes or writes anything more (a test is told as each returns: `awaited`).
 */
export const AWAIT_POINTS = ['read', 'temp-read', 'temp-removed', 'batch-saved', 'imported', 'batch-finished', 'write-id-saved', 'temp-written', 'destination-read', 'renamed'] as const
export type AwaitPoint = (typeof AWAIT_POINTS)[number]

// ── The file system, narrowed to what the engine does (a test records every call) ───────────────

export type SetupStat = { isFile: boolean; isDirectory: boolean; size: number; blocks: number }
export interface SetupFs {
  readdir(dir: string): Promise<string[]>
  lstat(path: string): Promise<SetupStat>
  /** Opens read-only and reads at most `max` + 1 bytes. */
  readText(path: string, max: number): Promise<string | { tooLarge: true }>
  mkdir(path: string): Promise<void>
  /** Exclusive create (never follows or replaces), write, flush, close. */
  writeNew(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  /** Flushes a folder after a rename. Best effort. */
  syncDir(dir: string): Promise<void>
}

export const nodeSetupFs: SetupFs = {
  async readdir(dir) { return fsp.readdir(dir) },
  async lstat(path) {
    const s = await fsp.lstat(path)
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, blocks: s.blocks }
  },
  async readText(path, max) {
    const fh = await fsp.open(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0))
    try {
      const buf = Buffer.alloc(max + 1)
      let off = 0
      while (off < buf.length) {
        const { bytesRead } = await fh.read(buf, off, buf.length - off, off)
        if (bytesRead === 0) break
        off += bytesRead
      }
      return off > max ? { tooLarge: true } : buf.subarray(0, off).toString('utf8')
    } finally { await fh.close() }
  },
  async mkdir(path) { await fsp.mkdir(path, { recursive: true }) },
  async writeNew(path, text) {
    const fh = await fsp.open(path, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW ?? 0), 0o600)
    try {
      await fh.writeFile(text, 'utf8')
      await fh.sync()
    } finally { await fh.close() }
  },
  async rename(from, to) { await fsp.rename(from, to) },
  async unlink(path) { await fsp.unlink(path) },
  async syncDir(dir) {
    try { const fh = await fsp.open(dir, FS.O_RDONLY); try { await fh.sync() } finally { await fh.close() } } catch { /* not every file system flushes a folder */ }
  }
}

/**
 * This computer's fingerprint: a hash of its hardware id (the platform UUID on a Mac, machine-id on Linux,
 * MachineGuid on Windows). The hardware id itself is never kept or written. null when it cannot be told.
 */
export function machineFingerprint(): string | null {
  let id = ''
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? ''
    } else if (process.platform === 'linux') {
      id = readFileSync('/etc/machine-id', 'utf8').trim()
    } else if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      id = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? ''
    }
  } catch { id = '' }
  return id ? createHash('sha256').update(`talkweaver-machine:${id}`).digest('hex').slice(0, 32) : null
}

// ── The ports ───────────────────────────────────────────────────────────────────────────────────

/** The part of the settings store the engine uses (the app's own store; a test's real one). */
export interface SetupStorePort {
  view(): SettingsState
  problem(): { error: string } | undefined
  previewImport(file: unknown): ImportPreview
  applyImport(preview: ImportPreview, opts: { file: string }): Promise<{ ok: true; batch?: string } | { ok: false; error: string }>
  undoBatch(batchId: string): Promise<{ ok: true } | { ok: false; error: string }>
}

export type SetupVault = { id: string; name: string; /** Its id is in its own vault file, so it is the same on every Mac. */ travels: boolean }
export interface SetupVaultPort {
  list(): SetupVault[]
  personal(id: string): Partial<Record<VaultField, string>>
  setPersonal(id: string, patch: Partial<Record<VaultField, string | undefined>>): void
}

export interface SetupSuggestionPort {
  /** This Mac's values now ('' = none): the handout address, the share-link address in use. */
  current(): Record<SuggestionKind, string>
  /** Whether a suggestion can be used now, and why not. */
  canUse(kind: SuggestionKind): { ok: true } | { ok: false; why: string }
  /** Use a value through the same path as Settings' own Save (the share-link address: the attach that Save runs). */
  use(kind: SuggestionKind, value: string): Promise<{ ok: true } | { ok: false; error: string }>
}

export interface SetupFolderPorts {
  /** App data: where this Mac's record is kept. */
  dir: string
  store: SetupStorePort
  schema: Schema
  commands: CommandsAdapter
  commandLabel?(commandId: string): string
  /** The setting `setup.folder` as stored ('' = off). */
  chosen(): string
  macName(): string
  appVersion: string
  vaults?: SetupVaultPort
  suggestions?: SetupSuggestionPort
  fs?: SetupFs
  home?: string
  now?(): number
  newId?(): string
  log?(line: string): void
  /** This computer's fingerprint (machineFingerprint); null = cannot be told. */
  fingerprint?(): string | null
  /** One read's budget: time in ms, and files carrying a Mac id. */
  readBudgetMs?: number
  readMaxFiles?: number
  /** Told as each await of a cycle returns, before the cycle's check (a test stops the folder there). */
  awaited?(point: AwaitPoint): void
}

// ── This Mac's record ───────────────────────────────────────────────────────────────────────────

type HistoryItem = { target: string; label: string; from: SettingValue; to: SettingValue }
type HistoryEntry = { id: string; macId: string; macName: string; at: number; storeBatch: string | null; items: HistoryItem[]; undone: boolean; /** The store's batch was undone (an Undo that failed part-way does not undo it twice). */ storeUndone?: boolean }
/** A batch being applied: saved before anything changes, completed after (step 4). `stuck`: stopped part-way and not all put back yet. */
type PendingBatch = { id: string; macId: string; macName: string; at: number; label: string; storeBatch: string | null; items: Array<HistoryItem & { toAt: number }>; storeUndone?: boolean; stuck?: boolean }

type MacRecord = {
  format: typeof STATE_FORMAT
  version: 1
  macId: string
  /** The computer this record was made on (machineFingerprint); null = not known. */
  fingerprint: string | null
  /** This Mac's name when its file was last written (named when a copy of this record is found on another Mac). */
  lastMacName: string | null
  recentWrites: string[]
  /** The set-up folder this Mac joined (applied the preview of, or found empty). */
  joinedFolder: string | null
  /** The folder this Mac's file was last written to. */
  ownFolder: string | null
  own: Record<string, Stamped>
  ownSuggestions: Partial<Record<SuggestionKind, Stamped<string>>>
  history: HistoryEntry[]
  pending: PendingBatch | null
  lastRead: number | null
  lastWrittenAt: number | null
  /** Hash of what was last written, without its time and write id. */
  lastWrittenHash: string | null
  /** This Mac's record has been brought up to date at least once: a value new since then was set since then. */
  initialised: boolean
}

const isBag = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => Object.is(a, b)
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of value instanceof Map ? value.values() : Object.values(value as object)) deepFreeze(v)
  }
  return value
}

export type SyncReason = 'start' | 'chosen' | 'folder' | 'local' | 'demand'

type OwnOnDisk = { kind: 'none' } | { kind: 'ok'; owner: { macId: string; writeId: string; mark: string } } | { kind: 'problem'; reason: SkipReason }
/** One read of the folder, judged and frozen (step 1). Nothing outside it is ever applied. */
type Snapshot = Readonly<{
  folder: string
  names: readonly string[]
  /** Other Macs' files, every entry judged. */
  files: ReadonlyMap<string, MacFile>
  skipped: readonly SetupFolderSkip[]
  /** Files read with entries left out: by file name, in words. */
  rejected: ReadonlyArray<{ file: string; words: string }>
  /** By Mac id: how far the newest time in its file is ahead of this Mac's clock, beyond the margin (else absent). */
  ahead: ReadonlyMap<string, number>
  ownOnDisk: OwnOnDisk
}>
type Change = Readonly<{ target: string; from: SettingValue; winner: Winner }>
/** What one snapshot means for this Mac (step 3). Apply applies exactly this. */
type Plan = Readonly<{
  snapshot: Snapshot
  joining: boolean
  changes: readonly Change[]
  adopt: ReadonlyArray<{ target: string; winner: Winner }>
  offers: readonly Change[]
  ties: ReadonlyArray<{ target: string; macId: string }>
  token: string
}>

export interface SetupFolderEngine {
  sync(reason: SyncReason): Promise<SetupFolderStatus>
  status(): SetupFolderStatus
  /** First join: apply the plan the preview showed. Refused (with the new preview) when the folder changed since. */
  applyJoin(token: string): Promise<{ ok: true; status: SetupFolderStatus } | { ok: false; error: string; status: SetupFolderStatus }>
  notNow(): SetupFolderStatus
  undo(historyId: string): Promise<{ ok: true; status: SetupFolderStatus } | { ok: false; error: string; status: SetupFolderStatus }>
  /** Use on this Mac: an address, or where publishing goes, set on another Mac. */
  useSuggestion(kind: OfferKind): Promise<{ ok: true; status: SetupFolderStatus } | { ok: false; error: string; status: SetupFolderStatus }>
  removeOwnFile(): Promise<{ ok: true; status: SetupFolderStatus } | { ok: false; error: string; status: SetupFolderStatus }>
  /** After another computer was found writing under this Mac's id: this Mac starts a file of its own. */
  newFileForThisMac(): Promise<SetupFolderStatus>
  /** The folder chosen changed (or was cleared): a cycle still running changes nothing more. Resolves once it has stopped. */
  folderChanged(): Promise<void>
  macId(): string
}

export const SETUP_WORDS = {
  foreign: 'This Mac’s file in the set-up folder was written by another computer using the same identity (TalkWeaver’s app data copied from this Mac?). Nothing is written to it. Choose Start a new file for this Mac.',
  ownUnreadable: 'This Mac’s own file in the set-up folder could not be read, so it is left as it is and this Mac’s changes are not written there. Show it in Finder to look.',
  folderMissing: 'The folder cannot be found. Is the drive or the sync service available? It is tried again when it is back.',
  folderUnreadable: 'The set-up folder could not be read. It is tried again shortly.',
  folderSlow: 'The set-up folder did not answer in time (a sync service busy, or a drive asleep). It is tried again shortly.',
  storeProblem: 'The settings file could not be used, so the set-up folder is not read.',
  changedSincePreview: 'The other Mac’s set-up changed since you looked. Here is what applying changes now.',
  removeInUse: 'Stop using the folder first; this Mac writes its file again while it uses it.',
  removeNotOurs: 'The file there was not written by this Mac, so it is left as it is.',
  removeNothing: 'There is no file of this Mac’s to remove.',
  noSuggestion: 'There is nothing to use just now.',
  undoNotFound: 'That change is no longer listed.',
  readOnly: 'This Mac cannot keep its own file in the set-up folder (it could not identify itself); it still takes changes from your other Macs.',
  notPutBack: (labels: string[]): string => `${listWords(labels)} could not be put back. The change stays listed; Undo tries again.`,
  stuck: (name: string, labels: string[]): string => `Changes from ${name} were being applied when TalkWeaver stopped part-way, and ${listWords(labels)} could not be put back. Nothing more is taken from the folder until they are; Undo tries again.`,
  copied: (name: string): string => `This Mac’s set-up was copied from ${name}; it now keeps its own file.`,
  copiedAway: 'Another computer writes under this Mac’s identity (TalkWeaver’s app data copied between Macs); this Mac now keeps its own file, and the other file is left as it is.',
  finished: (name: string): string => `Changes from ${name} were being applied when TalkWeaver stopped. Every one had been made, so they are kept and listed with Undo.`,
  rolledBack: (name: string): string => `Changes from ${name} were being applied when TalkWeaver stopped part-way. What had changed was put back; they are read again from the folder.`
} as const

class OutOfTime extends Error {}
/** "A", "A and B", "A, B and C". */
const listWords = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

export function createSetupFolderEngine(ports: SetupFolderPorts): SetupFolderEngine {
  const fs = ports.fs ?? nodeSetupFs
  const home = ports.home ?? homedir()
  const now = ports.now ?? (() => Date.now())
  const newId = ports.newId ?? (() => randomUUID())
  const log = ports.log ?? (() => {})
  const budgetMs = ports.readBudgetMs ?? READ_BUDGET_MS
  const maxFiles = ports.readMaxFiles ?? READ_MAX_FILES
  const statePath = join(ports.dir, STATE_FILE)
  const travelling = new Set(travellingSettingKeys(ports.schema))
  let fingerprint: string | null = null
  try { fingerprint = (ports.fingerprint ?? machineFingerprint)() } catch { fingerprint = null }
  /** Without its fingerprint this Mac cannot prove a file is its own: it writes nothing to the folder. */
  const readOnly = (): boolean => fingerprint === null
  const passed = (point: AwaitPoint): void => { try { ports.awaited?.(point) } catch { /* a test's hook */ } }

  /** Session notices: said once (a copied profile found on start). */
  const sessionNotices: SetupFolderNotice[] = []
  let record: MacRecord = loadRecord()
  let last: { snapshot: Snapshot | null; folder: string; problem: string | null; plan: Plan | null; notices: SetupFolderNotice[]; held: SetupFolderNotice[] } = { snapshot: null, folder: '', problem: null, plan: null, notices: [], held: [] }
  /** First join: the plan the preview shows; Apply applies this object. */
  let pendingJoin: Plan | null = null
  let dismissed: string | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let generation = 0

  function freshRecord(): MacRecord {
    return { format: STATE_FORMAT, version: 1, macId: newId(), fingerprint, lastMacName: null, recentWrites: [], joinedFolder: null, ownFolder: null, own: {}, ownSuggestions: {}, history: [], pending: null, lastRead: null, lastWrittenAt: null, lastWrittenHash: null, initialised: false }
  }
  function loadRecord(): MacRecord {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(statePath, 'utf8')) } catch { raw = null }
    const fresh = freshRecord()
    if (!isBag(raw) || raw['format'] !== STATE_FORMAT || !isMacId(raw['macId'])) return fresh
    const r = raw as Partial<MacRecord>
    // Own change times inside the window; an older stamp of unknown age is the oldest valid one.
    const own: Record<string, Stamped> = {}
    if (isBag(r.own)) for (const [t, e] of Object.entries(r.own)) {
      if (!isBag(e) || !['string', 'number', 'boolean'].includes(typeof e['value']) || typeof e['at'] !== 'number' || !Number.isSafeInteger(e['at'])) continue
      const at = Math.max(EARLIEST_AT, e['at'] as number)
      if (isChangeTime(at, now())) own[t] = { value: e['value'] as SettingValue, at }
    }
    const rec: MacRecord = {
      ...fresh,
      macId: r.macId as string,
      fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint : null,
      lastMacName: typeof r.lastMacName === 'string' ? r.lastMacName : null,
      recentWrites: Array.isArray(r.recentWrites) ? r.recentWrites.filter((w): w is string => typeof w === 'string').slice(-RECENT_WRITES) : [],
      joinedFolder: typeof r.joinedFolder === 'string' ? r.joinedFolder : null,
      ownFolder: typeof r.ownFolder === 'string' ? r.ownFolder : null,
      own,
      ownSuggestions: isBag(r.ownSuggestions) ? r.ownSuggestions as MacRecord['ownSuggestions'] : {},
      history: Array.isArray(r.history) ? r.history.slice(0, HISTORY_KEPT) : [],
      pending: isBag(r.pending) && Array.isArray((r.pending as PendingBatch).items) ? r.pending as PendingBatch : null,
      lastRead: typeof r.lastRead === 'number' ? r.lastRead : null,
      lastWrittenAt: typeof r.lastWrittenAt === 'number' ? r.lastWrittenAt : null,
      lastWrittenHash: typeof r.lastWrittenHash === 'string' ? r.lastWrittenHash : null,
      initialised: r.initialised === true
    }
    // Made on another computer: this is a copy (Migration Assistant, a restored backup). A new identity, a file of its own.
    if (rec.fingerprint && fingerprint && rec.fingerprint !== fingerprint) newIdentity(rec, rec.lastMacName ?? 'another Mac')
    rec.fingerprint = fingerprint ?? rec.fingerprint
    return rec
  }
  /** A new Mac id for this computer: the original's file is never touched; this Mac writes its own. */
  function newIdentity(rec: MacRecord, copiedFrom: string | null): void {
    rec.macId = newId()
    rec.recentWrites = []
    rec.ownFolder = null
    rec.lastWrittenAt = null
    rec.lastWrittenHash = null
    if (copiedFrom) {
      sessionNotices.push({ kind: 'copied', text: SETUP_WORDS.copied(copiedFrom) })
      log(`[setup-folder] this Mac's record was copied from ${copiedFrom}; a new identity`)
    }
  }

  /** This Mac's record: written in app data by temporary file and rename (the default file system, never the set-up folder's). */
  async function saveRecord(): Promise<void> {
    await fsp.mkdir(ports.dir, { recursive: true })
    const tmp = join(ports.dir, `.${STATE_FILE}.${process.pid}-${newId()}.tmp`)
    await nodeSetupFs.writeNew(tmp, JSON.stringify(record, null, 2))
    await fsp.rename(tmp, statePath)
    await nodeSetupFs.syncDir(ports.dir)
  }
  // Written once at creation so the id (and a new one for a copy) is stable from the first launch.
  void (async () => { try { await saveRecord() } catch { /* tried again on the next cycle */ } })()

  const folderNow = (): string => resolveSetupFolder(ports.chosen(), home)
  /** The mark this Mac writes in its file: from the fingerprint and the Mac id; '' when the fingerprint is not known. */
  const myMark = (): string => (fingerprint ? hashOf(`${fingerprint}:${record.macId}`) : '')
  /** Whose a file under this Mac's id is: this Mac's, another computer's (a copy of this Mac's app data), or not known. */
  function ownerOf(owner: { macId: string; writeId: string; mark: string }): 'mine' | 'other-computer' | 'unknown' {
    if (owner.macId !== record.macId) return 'unknown'
    const mine = myMark()
    // Only the mark proves it: a copied record carries the same id and the same recent write ids.
    if (!mine || !owner.mark) return 'unknown'
    return owner.mark === mine ? 'mine' : 'other-computer'
  }

  // ── What this Mac holds now, in canonical form ────────────────────────────────────────────────

  function travellingVaults(): SetupVault[] {
    try { return (ports.vaults?.list() ?? []).filter((v) => v.travels) } catch { return [] }
  }
  function personalOf(id: string): Partial<Record<VaultField, string>> {
    try { return ports.vaults?.personal(id) ?? {} } catch { return {} }
  }
  /** Each travelling target's value as it travels; a value its rule refuses is `held` (stays on this Mac, neither written nor replaced). */
  function localNow(state: SettingsState): { values: Map<string, SettingValue>; held: Map<string, string> } {
    const values = new Map<string, SettingValue>()
    const held = new Map<string, string>()
    const put = (t: string, v: Verdict): void => { if (v.ok) values.set(t, v.value); else held.set(t, v.why) }
    for (const key of travelling) { const v = valueOf(state, ports.schema, key); if (v !== null) put(settingTarget(key), serialiseSetting(ports.schema, key, v)) }
    for (const cmd of Object.keys(ports.commands.resolve({}).bindings)) put(shortcutTarget(cmd), serialiseChord(ports.commands, cmd, chordOf(state, cmd, ports.commands)))
    for (const v of travellingVaults()) {
      const p = personalOf(v.id)
      for (const f of VAULT_FIELDS) put(vaultTarget(v.id, f), serialiseVaultField(f, p[f] ?? ''))
    }
    return { values, held }
  }
  function defaultsOf(): Map<string, SettingValue> {
    const out = new Map<string, SettingValue>()
    for (const key of travelling) {
      const d = ports.schema.def(key)?.default
      if (d === undefined || d === null) continue
      const v = serialiseSetting(ports.schema, key, d)
      if (v.ok) out.set(settingTarget(key), v.value)
    }
    for (const [cmd, chord] of Object.entries(ports.commands.resolve({}).bindings)) out.set(shortcutTarget(cmd), chord)
    for (const v of travellingVaults()) for (const f of VAULT_FIELDS) out.set(vaultTarget(v.id, f), '')
    return out
  }
  /** One target's canonical value now (undefined: held, or not this Mac's). */
  function currentOf(target: string): SettingValue | undefined {
    return localNow(ports.store.view()).values.get(target)
  }
  /** When the value now held was set here: the newest change-log entry that set it, if the log still has one. */
  function loggedAt(state: SettingsState, target: string, value: SettingValue): number | null {
    const isSetting = target.startsWith('s:')
    const id = target.slice(2)
    if (!isSetting && !target.startsWith('k:')) return null
    const entry = state.changes.find((change) => (isSetting ? change.key === id : change.commandId === id))
    if (!entry) return null
    const to = isSetting && entry.to !== null ? serialiseSetting(ports.schema, id, entry.to) : { ok: true as const, value: entry.to }
    return to.ok && same(to.value, value) ? entry.at : null
  }
  /** Step 2: this Mac's record brought up to what it holds (F4). Pure on its inputs. */
  function stamped(state: SettingsState, local: ReturnType<typeof localNow>, own: Record<string, Stamped>, initialised = record.initialised): Record<string, Stamped> {
    const defaults = defaultsOf()
    const next: Record<string, Stamped> = {}
    for (const [t, cur] of local.values) {
      const rec = own[t]
      if (!rec) {
        if (same(cur, defaults.get(t))) continue // never changed here: nothing to say about it
        // Before the first cycle a value of unknown age is the oldest there is; after it, a value with no record was set since.
        next[t] = { value: cur, at: localStamp(loggedAt(state, t, cur) ?? (initialised ? now() : EARLIEST_AT), undefined) }
      } else if (!same(rec.value, cur)) {
        next[t] = { value: cur, at: localStamp(loggedAt(state, t, cur) ?? now(), rec) }
      } else next[t] = rec
    }
    // A vault not listed just now (its folder unavailable, say) keeps its record as it was, so it is not
    // taken for a new value when it comes back. A held value, or a setting this version no longer has, is not carried.
    for (const [t, rec] of Object.entries(own)) if (t.startsWith('v:') && !local.values.has(t) && !local.held.has(t)) next[t] = rec
    return next
  }

  // ── Step 1: one read, judged and frozen ──────────────────────────────────────────────────────

  async function readSnapshot(folder: string): Promise<Snapshot> {
    const deadline = Date.now() + budgetMs
    const within = <T>(p: Promise<T>): Promise<T> => {
      const left = deadline - Date.now()
      if (left <= 0) { p.catch(() => {}); return Promise.reject(new OutOfTime()) }
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OutOfTime()), left) })
      p.catch(() => {})
      return Promise.race([p, late]).finally(() => clearTimeout(timer))
    }
    const names = [...await within(fs.readdir(folder))].sort()
    const judge = entryJudge(ports.schema, ports.commands, now())
    const files = new Map<string, MacFile>()
    const skipped: SetupFolderSkip[] = []
    const rejected: Array<{ file: string; words: string }> = []
    const ahead = new Map<string, number>()
    let ownOnDisk: OwnOnDisk = { kind: 'none' }
    let looked = 0
    const skip = (name: string, reason: SkipReason): void => { skipped.push({ file: name, path: join(folder, name), reason, words: SKIP_WORDS[reason] }) }
    for (const name of names) {
      const kind = classifyName(name)
      if (kind.kind === 'ignore' || kind.kind === 'temp') continue
      if (kind.kind === 'copy') { skip(name, 'copy'); continue }
      if (kind.kind === 'placeholder') { skip(name, 'placeholder'); continue }
      const path = join(folder, name)
      // A Mac that writes nothing has no file of its own: one under its id is read like any other Mac's.
      const own = kind.macId === record.macId && !readOnly()
      let reason: SkipReason | null = null
      let text: string | null = null
      if (++looked > maxFiles) reason = 'not-read'
      else {
        try {
          const st = await within(fs.lstat(path))
          if (!st.isFile) reason = 'unreadable'
          else if (st.size > SETUP_FILE_MAX_BYTES) reason = 'too-large'
          else if (st.size > 0 && st.blocks === 0) reason = 'not-downloaded' // a dataless file (iCloud, Dropbox online-only): not opened, so nothing asks for a download
          else {
            const got = await within(fs.readText(path, SETUP_FILE_MAX_BYTES))
            if (typeof got !== 'string') reason = 'too-large'
            else text = got
          }
        } catch (error) { reason = error instanceof OutOfTime ? 'not-read' : 'unreadable' }
      }
      if (own) {
        // This Mac's own file: never applied, so only who wrote it matters.
        const owner = text === null ? null : ownershipOf(text)
        ownOnDisk = owner ? { kind: 'ok', owner } : { kind: 'problem', reason: reason ?? 'unreadable' }
        if (!owner) skip(name, reason ?? 'unreadable')
        continue
      }
      if (text === null) { skip(name, reason ?? 'unreadable'); continue }
      const parsed = parseMacFile(text, kind.macId, judge)
      if (!parsed.ok) { skip(name, parsed.reason); continue }
      files.set(kind.macId, parsed.file)
      if (parsed.ahead) ahead.set(kind.macId, parsed.ahead)
      const words = rejectedWords(parsed.rejected)
      if (words) rejected.push({ file: name, words })
    }
    return deepFreeze({ folder, names, files, skipped, rejected, ahead, ownOnDisk })
  }

  // ── Step 3: one plan from that snapshot ──────────────────────────────────────────────────────

  function makePlan(snapshot: Snapshot, local: ReturnType<typeof localNow>, own: Record<string, Stamped>, joining: boolean): Plan {
    const remotes = [...snapshot.files.values()].map((f) => ({ macId: f.macId, entries: targetsOf(f) }))
    const { winners, ties } = newestWins(new Map(Object.entries(own)), remotes)
    // Only what this Mac holds and lets travel: a held value is neither written nor replaced.
    const known = (t: string): boolean => local.values.has(t) && (!t.startsWith('s:') || travelling.has(t.slice(2)))
    const changes: Change[] = []
    const adopt: Array<{ target: string; winner: Winner }> = []
    const offers: Change[] = []
    for (const [t, w] of winners) {
      if (w.from === null || !known(t)) continue
      const cur = local.values.get(t) as SettingValue
      if (same(cur, w.value)) adopt.push({ target: t, winner: w })
      else if (!joining && t.startsWith('s:') && isAskFirst(t.slice(2))) offers.push({ target: t, from: cur, winner: w })
      else changes.push({ target: t, from: cur, winner: w })
    }
    changes.sort((a, b) => (a.target < b.target ? -1 : 1))
    const shape = (c: Change): unknown[] => [c.target, c.from, c.winner.from, c.winner.value, c.winner.at]
    const token = hashOf(JSON.stringify({ changes: changes.map(shape), offers: offers.map(shape), adopt: adopt.map((a) => [a.target, a.winner.from, a.winner.value, a.winner.at]) }))
    return deepFreeze({ snapshot, joining, changes, adopt, offers, ties: ties.filter((t) => known(t.target)), token })
  }

  // ── Words for rows ───────────────────────────────────────────────────────────────────────────

  function labelOf(target: string): string {
    if (target.startsWith('s:')) return ports.schema.def(target.slice(2))?.label ?? target.slice(2)
    if (target.startsWith('k:')) return `Shortcut: ${ports.commandLabel?.(target.slice(2)) ?? target.slice(2)}`
    const [, id, field] = target.split(':')
    const vault = travellingVaults().find((v) => v.id === id)
    return `${vault?.name ?? 'A vault'}: ${VAULT_FIELD_LABEL[field as VaultField] ?? field}`
  }
  function shown(target: string, value: SettingValue): string {
    if (target.startsWith('s:')) {
      const def = ports.schema.def(target.slice(2))
      if (typeof value === 'boolean') return value ? 'On' : 'Off'
      const option = def?.options?.find((o) => o.value === value)
      if (option) return option.label
      if (value === '') return 'Empty'
      return `${String(value)}${def?.unit ? ` ${def.unit}` : ''}`
    }
    if (target.startsWith('k:')) return value === '' ? 'No shortcut' : String(value)
    return value === '' ? 'Empty' : String(value)
  }
  const rowOf = (target: string, from: SettingValue, to: SettingValue): SetupFolderChangeRow => ({ label: labelOf(target), from: shown(target, from), to: shown(target, to) })

  // ── Step 3 applied, kill-safe (step 4) ───────────────────────────────────────────────────────

  /** Puts one vault field to `value` ('' = none). */
  function setVaultField(target: string, value: SettingValue): void {
    const [, id, field] = target.split(':')
    ports.vaults?.setPersonal(id, { [field]: value === '' ? undefined : String(value) })
  }
  /** The import batch a pending batch wrote, from the store's change log (when it landed but its id was not saved). */
  function storeBatchOf(p: PendingBatch): string | null {
    if (p.storeBatch) return p.storeBatch
    const settingItems = p.items.filter((i) => !i.target.startsWith('v:'))
    if (!settingItems.length) return null
    for (const e of ports.store.view().changes) {
      if (e.at < p.at - 1000) break
      if (e.who.kind !== 'import' || e.who.file !== p.label || !e.batch) continue
      const t = e.key !== undefined ? settingTarget(e.key) : shortcutTarget(e.commandId ?? '')
      if (settingItems.some((i) => i.target === t)) return e.batch
    }
    return null
  }
  /** Completes a batch: what landed is recorded with its change time and listed with Undo. */
  async function finish(p: PendingBatch): Promise<number> {
    const landed = p.items.filter((i) => same(currentOf(i.target), i.to))
    for (const i of landed) record.own[i.target] = { value: i.to, at: i.toAt }
    if (landed.length) {
      record.history.unshift({ id: p.id, macId: p.macId, macName: p.macName, at: p.at, storeBatch: storeBatchOf(p), items: landed.map(({ toAt: _toAt, ...item }) => item), undone: false })
      record.history = record.history.slice(0, HISTORY_KEPT)
      log(`[setup-folder] ${landed.length} change(s) from ${p.macName} applied`)
    }
    record.pending = null
    try { await saveRecord() } catch (error) { log(`[setup-folder] this Mac's record was not saved: ${String(error)}`) }
    return landed.length
  }
  /**
   * Puts back what a batch changed and is still as the batch left it: the store's batch undone (once), each vault
   * field set back. Then every one is read back; `failed` names those not back at their earlier value.
   */
  async function putBack(items: readonly HistoryItem[], storeBatch: string | null, storeUndone: boolean): Promise<{ failed: string[]; storeUndone: boolean }> {
    const landed = items.filter((i) => same(currentOf(i.target), i.to))
    let undone = storeUndone
    if (!undone && storeBatch && landed.some((i) => !i.target.startsWith('v:'))) {
      const r = await ports.store.undoBatch(storeBatch)
      if (r.ok) undone = true
      else log(`[setup-folder] undoing the settings of a batch: ${r.error}`)
    }
    for (const i of landed.filter((x) => x.target.startsWith('v:'))) {
      try { setVaultField(i.target, i.from) } catch (error) { log(`[setup-folder] putting back ${i.target}: ${String(error)}`) }
    }
    return { failed: landed.filter((i) => !same(currentOf(i.target), i.from)).map((i) => i.label), storeUndone: undone }
  }
  /**
   * On start (and before every cycle): a batch left by a stop part-way is finished, or what landed is put back.
   * When something could not be put back the batch stays pending (`stuck`) and the cycle takes nothing more.
   */
  async function reconcile(): Promise<{ notice: SetupFolderNotice | null; blocked: boolean }> {
    const p = record.pending
    if (!p) return { notice: null, blocked: false }
    const missing = p.items.filter((i) => !same(currentOf(i.target), i.to))
    if (!missing.length) {
      await finish(p)
      log(`[setup-folder] a batch from ${p.macName} stopped part-way was complete: kept`)
      return { notice: { kind: 'interrupted', text: SETUP_WORDS.finished(p.macName) }, blocked: false }
    }
    const r = await putBack(p.items, p.storeUndone ? null : storeBatchOf(p), p.storeUndone === true)
    if (r.failed.length) {
      record.pending = { ...p, storeUndone: r.storeUndone, stuck: true }
      try { await saveRecord() } catch (error) { log(`[setup-folder] this Mac's record was not saved: ${String(error)}`) }
      log(`[setup-folder] a batch from ${p.macName} stopped part-way: ${r.failed.length} not put back`)
      return { notice: { kind: 'not-restored', text: SETUP_WORDS.stuck(p.macName, r.failed) }, blocked: true }
    }
    record.pending = null
    await saveRecord()
    log(`[setup-folder] a batch from ${p.macName} stopped part-way: put back`)
    return { notice: { kind: 'interrupted', text: SETUP_WORDS.rolledBack(p.macName) }, blocked: false }
  }

  /**
   * The only place values from another Mac change this Mac's settings: every value comes from `plan`, which
   * comes from one judged snapshot. Per Mac, one batch: saved as pending before anything changes, completed
   * after. `alive` is checked before every change: a cycle whose folder was cleared or changed stops.
   */
  async function applyPlan(plan: Plan, alive: () => boolean): Promise<{ notices: SetupFolderNotice[]; stopped: boolean }> {
    const notices: SetupFolderNotice[] = []
    if (!alive()) return { notices, stopped: true }
    for (const a of plan.adopt) record.own[a.target] = { value: a.winner.value, at: a.winner.at }
    const byMac = new Map<string, Change[]>()
    for (const c of plan.changes) byMac.set(c.winner.from as string, [...(byMac.get(c.winner.from as string) ?? []), c])
    for (const [macId, changes] of [...byMac].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const file = plan.snapshot.files.get(macId)
      if (!file) continue
      const settings: Record<string, SettingValue> = {}
      const keys: Record<string, string> = {}
      for (const c of changes) {
        if (c.target.startsWith('s:')) settings[c.target.slice(2)] = c.winner.value
        else if (c.target.startsWith('k:')) keys[c.target.slice(2)] = String(c.winner.value)
      }
      const items: PendingBatch['items'] = []
      let preview: ImportPreview | null = null
      if (Object.keys(settings).length || Object.keys(keys).length) {
        const view = ports.store.view()
        preview = ports.store.previewImport({
          format: EXPORT_FORMAT, version: EXPORT_VERSION, app: view.app, appVersion: file.appVersion, exportedFrom: file.macName,
          exportedAt: new Date(file.writtenAt).toISOString(), settings, keys
        })
        if (preview.refused) {
          notices.push({ kind: 'not-applied', text: `Settings from ${file.macName} were not applied: ${preview.refused.message}.` })
          preview = null
        } else {
          for (const s of preview.skipped) {
            const t = s.key !== undefined ? settingTarget(s.key) : shortcutTarget(s.commandId ?? '')
            notices.push({ kind: 'not-applied', text: `${labelOf(t)} from ${file.macName} was not applied: ${s.reason}.` })
          }
          for (const pc of preview.changes) {
            const t = pc.key !== undefined ? settingTarget(pc.key) : shortcutTarget(pc.commandId ?? '')
            const c = changes.find((x) => x.target === t)
            if (c) items.push({ target: t, label: labelOf(t), from: c.from, to: c.winner.value, toAt: c.winner.at })
          }
          if (!preview.changes.length) preview = null
        }
      }
      const vaultChanges = changes.filter((x) => x.target.startsWith('v:'))
      for (const c of vaultChanges) items.push({ target: c.target, label: labelOf(c.target), from: c.from, to: c.winner.value, toAt: c.winner.at })
      if (!items.length) continue
      // Step 4: the batch, with every previous value, is saved before anything changes.
      record.pending = { id: newId(), macId, macName: file.macName, at: now(), label: batchFileLabel(file.macName), storeBatch: null, items }
      await saveRecord()
      passed('batch-saved')
      if (!alive()) { record.pending = null; await saveRecord(); return { notices, stopped: true } }
      if (preview) {
        const r = await ports.store.applyImport(preview, { file: batchFileLabel(file.macName) })
        passed('imported')
        if (!r.ok) notices.push({ kind: 'not-applied', text: `Settings from ${file.macName} were not applied: ${r.error}` })
        else record.pending.storeBatch = r.batch ?? null
      }
      for (const c of vaultChanges) {
        if (!alive()) break
        try { setVaultField(c.target, c.winner.value) } catch (error) {
          notices.push({ kind: 'not-applied', text: `${labelOf(c.target)} from ${file.macName} was not applied: ${String((error as Error)?.message ?? error)}` })
        }
      }
      await finish(record.pending)
      passed('batch-finished')
      if (!alive()) return { notices, stopped: true }
    }
    return { notices, stopped: false }
  }

  // ── Step 5: this Mac's file ──────────────────────────────────────────────────────────────────

  function ownFileOf(own: Record<string, Stamped>): Omit<MacFile, 'writtenAt' | 'writeId'> {
    const settings: MacFile['settings'] = {}
    const shortcuts: MacFile['shortcuts'] = {}
    const vaults: MacFile['vaults'] = {}
    // Written only through the allow-list's rules, whatever the record holds.
    for (const [t, e] of Object.entries(own)) {
      if (t.startsWith('s:')) { const v = serialiseSetting(ports.schema, t.slice(2), e.value); if (v.ok && same(v.value, e.value)) settings[t.slice(2)] = e }
      else if (t.startsWith('k:')) { const v = serialiseChord(ports.commands, t.slice(2), e.value); if (v.ok && same(v.value, e.value)) shortcuts[t.slice(2)] = { value: String(e.value), at: e.at } }
      else if (t.startsWith('v:')) {
        const [, id, field] = t.split(':')
        const v = serialiseVaultField(field as VaultField, e.value)
        if (v.ok && same(v.value, e.value)) vaults[id] = { ...(vaults[id] ?? {}), [field]: { value: String(e.value), at: e.at } }
      }
    }
    const suggestions: MacFile['suggestions'] = {}
    for (const s of SUGGESTIONS) {
      const e = record.ownSuggestions[s]
      const v = e ? serialiseSuggestion(s, e.value) : null
      if (e && v?.ok && same(v.value, e.value)) suggestions[s] = e
    }
    return { format: SETUP_FILE_FORMAT, version: SETUP_FILE_VERSION, macId: record.macId, macName: cleanMacName(ports.macName()), appVersion: /^[0-9A-Za-z.+-]{1,40}$/.test(ports.appVersion) ? ports.appVersion : '', mark: myMark(), settings, shortcuts, vaults, suggestions }
  }

  /** Who the file at `path` (under this Mac's id) is now: read again right before a replace or a removal. */
  async function destinationNow(path: string): Promise<'absent' | 'mine' | 'other-computer' | 'unknown'> {
    let text: string | { tooLarge: true }
    try { text = await fs.readText(path, SETUP_FILE_MAX_BYTES) } catch (error) { return (error as { code?: string })?.code === 'ENOENT' ? 'absent' : 'unknown' }
    const owner = typeof text === 'string' ? ownershipOf(text) : null
    return owner ? ownerOf(owner) : 'unknown'
  }

  /** Removes only this Mac's own leftover temporary files (a write stopped part-way), each read and checked first. */
  async function sweepOwnTemps(folder: string, names: readonly string[], alive: () => boolean): Promise<void> {
    const prefix = ownTempPrefix(record.macId)
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      if (!record.recentWrites.includes(name.slice(prefix.length, -'.tmp'.length))) continue
      const path = join(folder, name)
      try {
        const text = await fs.readText(path, SETUP_FILE_MAX_BYTES)
        passed('temp-read')
        if (!alive()) return
        // Only a whole file this computer marked: a part-written one proves nothing and is left as it is.
        const owner = typeof text === 'string' ? ownershipOf(text) : null
        if (!owner || ownerOf(owner) !== 'mine') continue
        await fs.unlink(path)
        passed('temp-removed')
      } catch { /* tried again next time */ }
    }
  }

  async function writeOwn(folder: string, own: Record<string, Stamped>, onDisk: OwnOnDisk, alive: () => boolean): Promise<SetupFolderNotice | null> {
    if (onDisk.kind === 'problem') return { kind: 'foreign', text: SETUP_WORDS.ownUnreadable }
    if (onDisk.kind === 'ok') {
      const who = ownerOf(onDisk.owner)
      if (who === 'other-computer') {
        // Another computer writes under this id with its own mark (app data copied between Macs before either kept a
        // fingerprint): this Mac takes a new identity and a file of its own; the other file is left as it is.
        newIdentity(record, null)
        sessionNotices.push({ kind: 'copied', text: SETUP_WORDS.copiedAway })
        log('[setup-folder] another computer writes under this Mac\'s id; a new identity')
        return writeOwn(folder, own, { kind: 'none' }, alive)
      }
      if (who !== 'mine') return { kind: 'foreign', text: SETUP_WORDS.foreign }
    }
    const body = ownFileOf(own)
    const hash = hashOf(serialiseMacFile({ ...body, writtenAt: 0, writeId: '' }))
    const due = onDisk.kind === 'none' || record.ownFolder !== folder || hash !== record.lastWrittenHash || record.lastWrittenAt === null || now() - record.lastWrittenAt > HEARTBEAT_MS
    if (!due || !alive()) return null
    const writeId = newId()
    const writtenAt = now()
    // The write id goes into this Mac's record first: a file that lands is always known as this Mac's own.
    record.recentWrites = [...record.recentWrites, writeId].slice(-RECENT_WRITES)
    record.lastMacName = body.macName
    await saveRecord()
    passed('write-id-saved')
    const target = join(folder, macFileName(record.macId))
    const tmp = join(folder, `${ownTempPrefix(record.macId)}${writeId}.tmp`)
    if (!alive()) return null
    await fs.writeNew(tmp, serialiseMacFile({ ...body, writtenAt, writeId }))
    passed('temp-written')
    const dropTemp = async (): Promise<void> => { try { await fs.unlink(tmp) } catch { /* swept next time */ } }
    // A stopped cycle removes nothing either: its temporary file (a dot file) is swept by this Mac's next cycle there.
    if (!alive()) return null
    const there = await destinationNow(target)
    passed('destination-read')
    // Checked again right before the replace: still this Mac's folder, and the file there still this computer's.
    if (!alive()) return null
    if (there !== 'absent' && there !== 'mine') { await dropTemp(); return { kind: 'foreign', text: SETUP_WORDS.foreign } }
    try { await fs.rename(tmp, target) } catch (error) { if (alive()) await dropTemp(); throw error }
    passed('renamed')
    await fs.syncDir(folder)
    record.ownFolder = folder
    record.lastWrittenAt = writtenAt
    record.lastWrittenHash = hash
    return null
  }

  // ── Suggestions and offers ───────────────────────────────────────────────────────────────────

  function stampSuggestions(): void {
    if (!ports.suggestions) return
    let current: Record<SuggestionKind, string>
    try { current = ports.suggestions.current() } catch { return }
    for (const s of SUGGESTIONS) {
      const v = serialiseSuggestion(s, current[s] ?? '')
      const cur = v.ok ? String(v.value) : '' // an address that does not travel is not offered
      const rec = record.ownSuggestions[s]
      if (!rec) { if (cur) record.ownSuggestions[s] = { value: cur, at: localStamp(now(), undefined) } }
      else if (rec.value !== cur) record.ownSuggestions[s] = { value: cur, at: localStamp(now(), rec) }
    }
  }
  function suggestionsFrom(snapshot: Snapshot): Array<{ kind: SuggestionKind; value: string; macName: string; at: number }> {
    if (!ports.suggestions) return []
    let current: Record<SuggestionKind, string>
    try { current = ports.suggestions.current() } catch { return [] }
    const out: Array<{ kind: SuggestionKind; value: string; macName: string; at: number }> = []
    for (const s of SUGGESTIONS) {
      let best: { value: string; macName: string; at: number } | null = null
      for (const f of snapshot.files.values()) {
        const e = f.suggestions[s]
        if (!e || !e.value) continue
        if (!best || e.at > best.at) best = { value: e.value, macName: f.macName, at: e.at }
      }
      const mine = record.ownSuggestions[s]
      if (best && best.value !== (current[s] ?? '') && (!mine || best.at > mine.at)) out.push({ kind: s, ...best })
    }
    return out
  }

  // ── Notices ──────────────────────────────────────────────────────────────────────────────────

  const clockReported = new Set<string>()
  /**
   * Changes timed more than five minutes after this Mac's clock were left out of the merge. Which clock looks
   * wrong is said when it can be told: every other Mac's file ahead (this Mac's clock is behind), or one file
   * ahead while the others are not (that Mac's clock is ahead). With one other Mac it cannot be told.
   */
  function clockNotices(snapshot: Snapshot): SetupFolderNotice[] {
    const files = [...snapshot.files.values()]
    const ahead = files.filter((f) => snapshot.ahead.has(f.macId))
    if (!ahead.length) return []
    const by = (f: MacFile): string => aboutDuration(snapshot.ahead.get(f.macId) ?? 0)
    for (const f of ahead) if (!clockReported.has(f.macId)) { clockReported.add(f.macId); log(`[setup-folder] ${f.macName}'s file has times ${by(f)} ahead of this Mac's clock`) }
    const tail = 'Changes with those times are not taken until the clocks agree (System Settings › General › Date & Time › Set time and date automatically, on each Mac).'
    if (files.length >= 2 && ahead.length === files.length) {
      const most = Math.max(...ahead.map((f) => snapshot.ahead.get(f.macId) ?? 0))
      return [{ kind: 'clock', text: `This Mac’s clock looks behind: every other Mac’s file has times ahead of it, by up to ${aboutDuration(most)}. ${tail}` }]
    }
    if (files.length >= 2 && ahead.length === 1) return [{ kind: 'clock', text: `${ahead[0].macName}’s clock looks ahead: its file has times ${by(ahead[0])} ahead of this Mac’s clock, and your other Macs’ files do not. ${tail}` }]
    return ahead.map((f) => ({ kind: 'clock' as const, text: `${f.macName}’s clock and this Mac’s do not agree: its file has times ${by(f)} ahead of this Mac’s clock. One of the two clocks is wrong. ${tail}` }))
  }
  function vaultNotices(): SetupFolderNotice[] {
    let all: SetupVault[] = []
    try { all = ports.vaults?.list() ?? [] } catch { all = [] }
    return all.filter((v) => !v.travels).map((v) => ({ kind: 'vault-unmatched' as const, text: `${v.name} has no vault file, so its personal settings (author, badge) stay on this Mac. Edit this vault › Save writes one.` }))
  }
  const heldNotices = (held: Map<string, string>): SetupFolderNotice[] =>
    [...held].map(([t, why]) => ({ kind: 'held' as const, text: `${labelOf(t)} stays on this Mac and is not changed from the folder: it ${why}.` }))
  const rejectedNotices = (snapshot: Snapshot): SetupFolderNotice[] =>
    snapshot.rejected.map((r) => ({ kind: 'rejected' as const, text: `${r.file}: ${r.words}` }))

  // ── The cycle ────────────────────────────────────────────────────────────────────────────────

  async function cycle(reason: SyncReason): Promise<SetupFolderStatus> {
    void reason
    const gen = generation
    const folder = folderNow()
    const alive = (): boolean => gen === generation && folderNow() === folder
    const interrupted = await reconcile()
    last = { ...last, folder, problem: null, notices: interrupted.notice ? [interrupted.notice] : [] }
    const stopped = (): SetupFolderStatus => { last = { snapshot: null, folder: folderNow(), problem: null, plan: null, notices: [], held: [] }; pendingJoin = null; return status() }
    if (!folder) { last.snapshot = null; last.plan = null; pendingJoin = null; return status() }
    // A batch stopped part-way that could not all be put back: nothing more is taken until it is (Undo tries again).
    if (interrupted.blocked) return status()
    if (ports.store.problem()) { last.problem = SETUP_WORDS.storeProblem; return status() }
    // The TalkWeaver set-up folder is made inside the folder chosen when it is missing; the folder chosen must be there.
    try {
      const st = await fs.lstat(folder).catch(() => null)
      if (!st) {
        const parent = await fs.lstat(dirname(folder)).catch(() => null)
        if (!parent?.isDirectory) { last.problem = SETUP_WORDS.folderMissing; return status() }
        if (!alive()) return stopped()
        // A Mac that writes nothing makes nothing either: there is nothing to read until another Mac has written.
        if (readOnly()) { last.snapshot = null; last.plan = null; pendingJoin = null; return status() }
        await fs.mkdir(folder)
      } else if (!st.isDirectory) { last.problem = SETUP_WORDS.folderMissing; return status() }
    } catch { last.problem = SETUP_WORDS.folderMissing; return status() }

    let snapshot: Snapshot
    try { snapshot = await readSnapshot(folder) } catch (error) {
      if (!alive()) return stopped()
      last.problem = error instanceof OutOfTime ? SETUP_WORDS.folderSlow : SETUP_WORDS.folderUnreadable
      return status()
    }
    passed('read')
    if (!alive()) return stopped()
    last.snapshot = snapshot
    record.lastRead = now()
    if (!readOnly()) await sweepOwnTemps(folder, snapshot.names, alive)
    if (!alive()) return stopped()

    const state = ports.store.view()
    const local = localNow(state)
    last.held = heldNotices(local.held)
    const notices: SetupFolderNotice[] = [...last.notices, ...clockNotices(snapshot), ...vaultNotices(), ...rejectedNotices(snapshot)]
    if (record.joinedFolder !== folder) {
      const plan = makePlan(snapshot, local, stamped(state, local, record.own), true)
      if (snapshot.files.size > 0 && plan.changes.length > 0) {
        // First join: the plan is the preview. Nothing is read into this Mac or written to the folder until Apply.
        pendingJoin = plan
        last.plan = plan
        last.notices = notices
        try { await saveRecord() } catch { /* the id is written on the next cycle */ }
        return status()
      }
      // Nothing here would change (the folder is empty, or holds the same set-up): joined at once.
      record.joinedFolder = folder
    }
    pendingJoin = null
    record.own = stamped(state, local, record.own)
    const plan = makePlan(snapshot, local, record.own, false)
    last.plan = plan
    return complete(plan, notices, alive, stopped)
  }

  /** Applies a plan, then writes this Mac's file: the end of a joined cycle, and of Apply. */
  async function complete(plan: Plan, notices: SetupFolderNotice[], alive: () => boolean, stopped: () => SetupFolderStatus): Promise<SetupFolderStatus> {
    const folder = plan.snapshot.folder
    const applied = await applyPlan(plan, alive)
    notices.push(...applied.notices)
    if (applied.stopped || !alive()) { try { await saveRecord() } catch { /* next cycle */ } return stopped() }
    for (const t of plan.ties) notices.push({ kind: 'tie', text: `${labelOf(t.target)} was changed on ${plan.snapshot.files.get(t.macId)?.macName ?? 'another Mac'} at the same moment as here; this Mac’s value is kept.` })
    // What was applied is now what this Mac holds: its record follows (stamps of applied values are the winners').
    const after = localNow(ports.store.view())
    record.own = stamped(ports.store.view(), after, record.own)
    last.held = heldNotices(after.held)
    record.initialised = true
    stampSuggestions()
    // Without its fingerprint this Mac writes no file (status() says so); it has read and applied all the same.
    if (!readOnly()) {
      try {
        const problem = await writeOwn(folder, record.own, plan.snapshot.ownOnDisk, alive)
        if (problem) notices.push(problem)
      } catch (error) {
        notices.push({ kind: 'not-applied', text: `This Mac’s file could not be written: ${String((error as Error)?.message ?? error)}` })
      }
    }
    last.notices = notices
    try { await saveRecord() } catch (error) { log(`[setup-folder] this Mac's record was not saved: ${String(error)}`) }
    if (!alive()) return stopped()
    return status()
  }

  function offersOf(plan: Plan | null): SetupFolderSuggestion[] {
    if (!plan || plan.joining) return []
    return plan.offers.map((o) => {
      const key = o.target.slice(2) as OfferKind
      return { kind: key, label: labelOf(o.target), value: shown(o.target, o.winner.value), macName: plan.snapshot.files.get(o.winner.from as string)?.macName ?? 'another Mac', canUse: true, why: null }
    })
  }

  function status(): SetupFolderStatus {
    const folder = folderNow()
    const chosen = ports.chosen()
    const snapshot = last.snapshot && last.snapshot.folder === folder ? last.snapshot : null
    const macs: SetupFolderMac[] = []
    if (folder && snapshot) {
      macs.push({ macId: record.macId, name: cleanMacName(ports.macName()), appVersion: ports.appVersion, lastActive: record.ownFolder === folder ? record.lastWrittenAt ?? 0 : 0, thisMac: true })
      for (const f of [...snapshot.files.values()].sort((a, b) => b.writtenAt - a.writtenAt)) macs.push({ macId: f.macId, name: f.macName, appVersion: f.appVersion, lastActive: f.writtenAt, thisMac: false })
    }
    let suggestions: SetupFolderSuggestion[] = []
    if (snapshot && record.joinedFolder === folder) {
      suggestions = suggestionsFrom(snapshot).map((s) => {
        let can: { ok: true } | { ok: false; why: string } = { ok: false, why: 'Not available.' }
        try { can = ports.suggestions?.canUse(s.kind) ?? can } catch { /* not available */ }
        return { kind: s.kind, label: SUGGESTION_LABEL[s.kind], value: s.value, macName: s.macName, canUse: can.ok, why: can.ok ? null : can.why }
      })
      suggestions.push(...offersOf(last.plan && last.plan.snapshot === snapshot ? last.plan : null))
    }
    const history: SetupFolderBatch[] = record.history.map((h) => ({ id: h.id, macName: h.macName, at: h.at, rows: h.items.map((i) => rowOf(i.target, i.from, i.to)), undone: h.undone, undoable: !h.undone }))
    // A batch stopped part-way that could not all be put back: listed first, and Undo tries again.
    const p = record.pending
    if (p?.stuck) history.unshift({ id: p.id, macName: p.macName, at: p.at, rows: p.items.map((i) => rowOf(i.target, i.from, i.to)), undone: false, undoable: true, unfinished: true })
    const problem = last.folder === folder ? last.problem : null
    const state: SetupFolderStatus['state'] = !folder ? 'off' : problem ? 'unavailable' : record.joinedFolder === folder ? 'joined' : 'joining'
    const leftFile = record.ownFolder && record.ownFolder !== folder ? { folder: record.ownFolder, file: macFileName(record.macId) } : null
    const notices = [...sessionNotices, ...(folder && readOnly() ? [{ kind: 'read-only' as const, text: SETUP_WORDS.readOnly }] : []), ...(last.folder === folder ? [...last.notices, ...last.held] : [])]
    if (state === 'joining' && dismissed === folder) notices.push({ kind: 'not-applied', text: 'Not applied yet: nothing is read into this Mac or written to the folder until you apply.' })
    const preview = state === 'joining' && pendingJoin && pendingJoin.snapshot === snapshot
      ? { token: pendingJoin.token, rows: pendingJoin.changes.map((c) => rowOf(c.target, c.from, c.winner.value)), fromMacs: [...new Set(pendingJoin.changes.map((c) => snapshot?.files.get(c.winner.from as string)?.macName ?? 'Another Mac'))] }
      : null
    return {
      chosen: typeof chosen === 'string' ? chosen : '', folder, state, problem,
      thisMac: { name: cleanMacName(ports.macName()), file: macFileName(record.macId) },
      macs, lastRead: record.lastRead, skipped: snapshot ? [...snapshot.skipped] : [],
      preview, history, suggestions, notices, leftFile
    }
  }

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = trackWrite('setup-folder', queue.then(run, run))
    queue = next.catch(() => {})
    return next
  }

  /** The cycle's liveness for an action outside a cycle (Undo, Use on this Mac): the folder as it is now. */
  const aliveNow = (): (() => boolean) => { const gen = generation; const folder = folderNow(); return () => gen === generation && folderNow() === folder }
  const stoppedNow = (): SetupFolderStatus => { last = { snapshot: null, folder: folderNow(), problem: null, plan: null, notices: [], held: [] }; pendingJoin = null; return status() }

  return {
    macId: () => record.macId,
    sync: (reason) => serial(() => cycle(reason)),
    status,
    folderChanged: () => { generation += 1; return queue.then(() => undefined) },
    applyJoin: (token) => serial(async () => {
      const shown = pendingJoin
      if (!shown || shown.token !== token) {
        const fresh = await cycle('demand')
        return fresh.state === 'joining' ? { ok: false as const, error: SETUP_WORDS.changedSincePreview, status: fresh } : { ok: true as const, status: fresh }
      }
      // One read: still the plan that was shown? Then exactly that plan is applied; otherwise a fresh preview.
      const alive = aliveNow()
      const folder = shown.snapshot.folder
      if (folderNow() !== folder) return { ok: false as const, error: SETUP_WORDS.changedSincePreview, status: await cycle('demand') }
      let snapshot: Snapshot
      try { snapshot = await readSnapshot(folder) } catch { return { ok: false as const, error: SETUP_WORDS.folderUnreadable, status: status() } }
      passed('read')
      if (!alive()) return { ok: false as const, error: SETUP_WORDS.changedSincePreview, status: stoppedNow() }
      const state = ports.store.view()
      const local = localNow(state)
      const fresh = makePlan(snapshot, local, stamped(state, local, record.own), true)
      last.snapshot = snapshot
      if (fresh.token !== shown.token) {
        pendingJoin = fresh
        last.plan = fresh
        return { ok: false as const, error: SETUP_WORDS.changedSincePreview, status: status() }
      }
      record.joinedFolder = folder
      dismissed = null
      pendingJoin = null
      // The record is brought up to this Mac's values as the shown plan saw them, then the shown plan is applied.
      record.own = stamped(state, local, record.own)
      const applying: Plan = deepFreeze({ ...shown, snapshot })
      last.plan = applying
      const notices: SetupFolderNotice[] = [...clockNotices(snapshot), ...vaultNotices(), ...rejectedNotices(snapshot)]
      return { ok: true as const, status: await complete(applying, notices, alive, stoppedNow) }
    }),
    notNow: () => { dismissed = folderNow(); return status() },
    undo: (historyId) => serial(async () => {
      const failedWith = async (labels: string[]): Promise<{ ok: false; error: string; status: SetupFolderStatus }> => {
        const error = SETUP_WORDS.notPutBack(labels)
        // What was put back is this Mac's newest change, and travels; the page says what was not.
        await cycle('local')
        last.notices = [...last.notices, { kind: 'not-restored', text: error }]
        return { ok: false as const, error, status: status() }
      }
      // A batch stopped part-way that could not all be put back: Undo tries again, then the folder is read again.
      const p = record.pending
      if (p?.stuck && p.id === historyId) {
        const r = await putBack(p.items, p.storeUndone ? null : storeBatchOf(p), p.storeUndone === true)
        if (r.failed.length) { record.pending = { ...p, storeUndone: r.storeUndone }; try { await saveRecord() } catch { /* the next cycle */ } return failedWith(r.failed) }
        record.pending = null
        await saveRecord()
        return { ok: true as const, status: await cycle('local') }
      }
      const entry = record.history.find((h) => h.id === historyId)
      if (!entry || entry.undone) return { ok: false as const, error: SETUP_WORDS.undoNotFound, status: status() }
      // Each value is canonical (as recorded when it was applied): what is there now is compared with exactly what was put.
      const r = await putBack(entry.items, entry.storeBatch, entry.storeUndone === true)
      entry.storeUndone = r.storeUndone
      // Marked undone only when every value is back and read back; otherwise listed still, and Undo tries again.
      if (r.failed.length) { try { await saveRecord() } catch { /* the next cycle */ } return failedWith(r.failed) }
      entry.undone = true
      // The earlier values are now this Mac's newest changes: the cycle stamps them and they travel.
      return { ok: true as const, status: await cycle('local') }
    }),
    useSuggestion: (kind) => serial(async () => {
      if (!(OFFER_KINDS as readonly string[]).includes(kind)) return { ok: false as const, error: SETUP_WORDS.noSuggestion, status: status() }
      if (isAskFirst(kind)) {
        // Where publishing goes, from the last judged snapshot's plan, through applyPlan like every other value.
        const plan = last.plan
        const offer = plan && !plan.joining ? plan.offers.find((o) => o.target === settingTarget(kind)) : undefined
        if (!plan || !offer) return { ok: false as const, error: SETUP_WORDS.noSuggestion, status: status() }
        const alive = aliveNow()
        if (plan.snapshot.folder !== folderNow()) return { ok: false as const, error: SETUP_WORDS.noSuggestion, status: status() }
        const one: Plan = deepFreeze({ ...plan, changes: [offer], adopt: [], offers: [], ties: [] })
        const r = await applyPlan(one, alive)
        if (r.stopped) return { ok: false as const, error: SETUP_WORDS.noSuggestion, status: stoppedNow() }
        if (r.notices.length) return { ok: false as const, error: r.notices.map((n) => n.text).join(' '), status: await cycle('local') }
        return { ok: true as const, status: await cycle('local') }
      }
      const snapshot = last.snapshot
      const offer = snapshot && snapshot.folder === folderNow() ? suggestionsFrom(snapshot).find((s) => s.kind === kind) : undefined
      if (!offer || !ports.suggestions) return { ok: false as const, error: SETUP_WORDS.noSuggestion, status: status() }
      const can = ports.suggestions.canUse(offer.kind)
      if (!can.ok) return { ok: false as const, error: can.why, status: status() }
      const r = await ports.suggestions.use(offer.kind, offer.value)
      if (!r.ok) return { ok: false as const, error: r.error, status: status() }
      return { ok: true as const, status: await cycle('local') }
    }),
    removeOwnFile: () => serial(async () => {
      const folder = folderNow()
      const target = record.ownFolder
      if (!target) return { ok: false as const, error: SETUP_WORDS.removeNothing, status: status() }
      if (folder === target) return { ok: false as const, error: SETUP_WORDS.removeInUse, status: status() }
      const path = join(target, macFileName(record.macId))
      const alive = aliveNow()
      // Checked right before the removal: the file there now is this computer's own, and that folder still not in use.
      const there = await destinationNow(path)
      if (!alive() || folderNow() === target) return { ok: false as const, error: SETUP_WORDS.removeInUse, status: status() }
      if (there === 'absent') { record.ownFolder = null; await saveRecord(); return { ok: true as const, status: status() } }
      if (there !== 'mine') return { ok: false as const, error: SETUP_WORDS.removeNotOurs, status: status() }
      await fs.unlink(path)
      record.ownFolder = null
      record.lastWrittenHash = null
      await saveRecord()
      return { ok: true as const, status: status() }
    }),
    newFileForThisMac: () => serial(async () => {
      newIdentity(record, null)
      await saveRecord()
      return cycle('demand')
    })
  }
}


/** Read-only look at a set-up folder for `setup status` (another process): Macs seen and files skipped, nothing written or applied. */
export async function lookAtSetupFolder(opts: { dir: string; chosen: string; home?: string; fs?: SetupFs; now?: number }): Promise<{ folder: string; macs: Array<{ name: string; lastActive: number }>; skipped: SetupFolderSkip[]; lastRead: number | null; joined: boolean; problem: string | null }> {
  const fs = opts.fs ?? nodeSetupFs
  const folder = resolveSetupFolder(opts.chosen, opts.home ?? homedir())
  let rec: Partial<MacRecord> = {}
  try { const raw = JSON.parse(readFileSync(join(opts.dir, STATE_FILE), 'utf8')) as unknown; if (isBag(raw)) rec = raw as Partial<MacRecord> } catch { rec = {} }
  const base = { folder, macs: [] as Array<{ name: string; lastActive: number }>, skipped: [] as SetupFolderSkip[], lastRead: typeof rec.lastRead === 'number' ? rec.lastRead : null, joined: !!folder && rec.joinedFolder === folder, problem: null as string | null }
  if (!folder) return base
  let names: string[]
  try { names = await fs.readdir(folder) } catch { return { ...base, problem: SETUP_WORDS.folderMissing } }
  // Only names and times are shown here; entries are not looked at, so the judge lets them all through.
  const judge = { now: opts.now ?? Date.now(), setting: () => true, shortcut: () => true }
  for (const name of names.sort().slice(0, READ_MAX_FILES * 2)) {
    const kind = classifyName(name)
    if (kind.kind === 'ignore' || kind.kind === 'temp') continue
    const path = join(folder, name)
    if (kind.kind === 'copy' || kind.kind === 'placeholder') { base.skipped.push({ file: name, path, reason: kind.kind, words: SKIP_WORDS[kind.kind] }); continue }
    try {
      const st = await fs.lstat(path)
      if (st.size > SETUP_FILE_MAX_BYTES) { base.skipped.push({ file: name, path, reason: 'too-large', words: SKIP_WORDS['too-large'] }); continue }
      if (st.size > 0 && st.blocks === 0) { base.skipped.push({ file: name, path, reason: 'not-downloaded', words: SKIP_WORDS['not-downloaded'] }); continue }
      const text = await fs.readText(path, SETUP_FILE_MAX_BYTES)
      const parsed = typeof text === 'string' ? parseMacFile(text, kind.macId, judge) : { ok: false as const, reason: 'too-large' as const }
      if (parsed.ok) base.macs.push({ name: kind.macId === rec.macId ? `${parsed.file.macName} (this Mac)` : parsed.file.macName, lastActive: parsed.file.writtenAt })
      else base.skipped.push({ file: name, path, reason: parsed.reason, words: SKIP_WORDS[parsed.reason] })
    } catch { base.skipped.push({ file: name, path, reason: 'unreadable', words: SKIP_WORDS.unreadable }) }
  }
  return base
}
