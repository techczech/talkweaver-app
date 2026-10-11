// Owner tokens for shares, run-results links and pre-work, kept in the secrets store (spec
// docs/plans/cloudflare-setup-in-app, decision D3 and "Migration for existing installs").
//
// Before this module the three registries in the user-data folder (shared-talk-registry.json,
// run-results-share-registry.json, run-prework-registry.json) carried each row's owner token in
// plain JSON. Now a registry keeps what identifies and describes a row (ids, paths, titles, times)
// and the token lives in the `owner-tokens` slot of secrets-store.ts, under `<kind>:<id>@<origin>`.
// The three modules that own the registries read and write them through `openOwnerTokenRegistry`,
// which gives each row its token back on a read and takes it out again on a write.
//
// Rules, each with a test in scripts/test-owner-tokens.mjs:
//   - A token leaves a registry only after a fresh read of the store returned the same token.
//   - Moving is in two steps (store, then registry) and may stop after either: a registry row that
//     still carries its token is used as it is, and moved on the next start. Running it again when
//     everything has moved changes nothing.
//   - When the store cannot take a token, a token that is already in a registry stays there and
//     keeps working; a NEW token (a share being created) is refused with the secrets module's
//     message. Nothing new is ever written in plain text.
//   - When the store cannot be read (Keychain locked or refused, the file damaged), its rows are
//     not usable, but they are kept in the registry through every write and nothing is written
//     over the store: the links are back when the store is.
//   - A write adds or changes the rows it is given and nothing else. A row leaves a registry, and
//     its token leaves the store, only when the caller names that row for removal: never because a
//     write did not mention it (the caller may not have been able to see it).
//   - A registry that cannot be read, is not JSON, or does not hold its collection of rows is left
//     exactly as it is: every write and the restore refuse with a fixed sentence.
//   - A token is text that can travel in a request header (printable ASCII, no spaces): checked
//     where it comes in from the service, from a registry and from the store. A request that carries
//     one goes through `ownerFetch`, whose failure is a fixed sentence and never the transport's own
//     error (which can quote the header it refused).
//   - For run-results links and pre-work, everything that reads a row and later writes it (share,
//     the write after a publish, stop) runs one at a time per row key (`createKeyedQueue`), so a
//     second request waits and sees the first one's result. Shared talks do not use the queue: they
//     keep their own in-memory push chain (shared-talk.ts). Independently of that, a write can say which row it saw under a key (`expect`):
//     if the file holds another row there by then, or none, nothing is written.
//   - Nothing is made on the service unless a write to the store was just shown to work
//     (`assertCanStore` writes and reads back), and nothing is published to a new link until its
//     token has been stored and read back.
//
// Going back to a version from before this module. That version needs the token in the registry
// row: it ignores a row without one, so a talk shared earlier shows as not shared, and sharing it
// again from that version replaces the link (the service ends a talk's previous share when a new
// one is made). The tokens are not lost: they stay in the store, which the older version neither
// reads nor deletes, and coming forward again brings every share back as long as the older version
// was not used to make new shares (its next write of a registry drops the rows it ignored). To
// STAY on the older version with working shares, start this version once as
// `TalkWeaver --restore-plain-owner-tokens` before installing the older one: it writes each token
// back into its registry row and quits (`restorePlainOwnerTokens` below). The next ordinary start
// of this version moves them into the store again.
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isShareId } from '../shared/share-id.ts'
import { writeTextAtomic } from './importer/atomic.ts'
import { SecretsError, type SecretsStore } from './secrets-store.ts'

export type OwnerTokenKind = 'share' | 'results' | 'prework'

/** The three registries: file name in the user-data folder, and where a row keeps its id. */
export const OWNER_TOKEN_REGISTRIES = {
  'shared-talk': { file: 'shared-talk-registry.json', kind: 'share', collection: 'shares', idField: 'shareId', version: 2 },
  'run-results': { file: 'run-results-share-registry.json', kind: 'results', collection: 'shares', idField: 'shareId', version: 1 },
  'run-prework': { file: 'run-prework-registry.json', kind: 'prework', collection: 'preworks', idField: 'preworkId', version: 1 },
} as const

export type OwnerTokenRegistryName = keyof typeof OWNER_TOKEN_REGISTRIES
export const OWNER_TOKEN_REGISTRY_NAMES = Object.keys(OWNER_TOKEN_REGISTRIES) as OwnerTokenRegistryName[]

/** The command-line switch that writes the tokens back into the registries and quits. */
export const RESTORE_PLAIN_OWNER_TOKENS_SWITCH = 'restore-plain-owner-tokens'

/** 16 to 4096 printable ASCII characters with no space: safe to send as `Bearer <token>`. */
export function validOwnerToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value)
}

export type OwnerRequestFailure = 'bad-token' | 'timeout' | 'cancelled' | 'unreachable'

const OWNER_REQUEST_MESSAGES: Record<OwnerRequestFailure, string> = {
  'bad-token': 'The key for this link is not usable.',
  timeout: 'The service did not answer in time.',
  cancelled: 'The request was cancelled.',
  unreachable: 'The service could not be reached.',
}

/** Why a request carrying an owner token did not get an answer. Fixed text; the cause is dropped. */
export class OwnerRequestError extends Error {
  readonly reason: OwnerRequestFailure
  constructor(reason: OwnerRequestFailure) {
    super(OWNER_REQUEST_MESSAGES[reason])
    this.name = 'OwnerRequestError'
    this.reason = reason
  }
}

/**
 * Send a request authorised with an owner token. Every request that carries one goes through here:
 * a failure to send (which the HTTP layer may describe by quoting the header) becomes an
 * OwnerRequestError with a fixed sentence, so the token cannot reach a window, a log or the console
 * inside an error. An HTTP answer of any status is returned as it is.
 */
export async function ownerFetch(fetchImpl: typeof fetch, url: string, ownerToken: string, init: RequestInit = {}): Promise<Response> {
  if (!validOwnerToken(ownerToken)) throw new OwnerRequestError('bad-token')
  let failure: OwnerRequestFailure
  try {
    return await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${ownerToken}` } })
  } catch (error) {
    // Only the error's kind is read; its message and cause are never kept.
    const kind = (error as { name?: unknown } | null)?.name
    failure = kind === 'TimeoutError' ? 'timeout' : kind === 'AbortError' ? 'cancelled' : 'unreachable'
  }
  throw new OwnerRequestError(failure)
}

/** The store's name for a token: null when the row has no usable id or service address. */
export function ownerTokenKey(kind: OwnerTokenKind, id: unknown, origin: unknown): string | null {
  if (!isShareId(id) || typeof origin !== 'string' || !origin || origin.length > 2048) return null
  return `${kind}:${id}@${origin}`
}

export interface OwnerTokens {
  /** The token, or null when there is none or the store cannot be read just now. */
  get(key: string): string | null
  /** False when the store is there but cannot be read: a missing token then means "not known". */
  readable(): boolean
  /**
   * Keep these tokens. Returns the keys whose token a fresh read of the store gave back unchanged;
   * a key not returned was not kept. Never throws.
   */
  store(entries: Record<string, string>): Set<string>
  /** Drop these tokens. Best effort; never throws. */
  forget(keys: string[]): void
  /**
   * Throws the secrets module's refusal unless a write to the store works right now: what the store
   * holds is written back and read again. A store that can be read but not written does not pass.
   */
  assertCanStore(): void
}

const STORE_VERSION = 1
/** After a failed read, how long before the store is asked again (a refused Keychain prompt). */
const RETRY_UNREADABLE_MS = 10_000

export function createOwnerTokens(secrets: SecretsStore, options: { now?: () => number } = {}): OwnerTokens {
  const now = options.now ?? Date.now
  let cached: Map<string, string> | null = null
  let unreadableUntil = 0

  /** A fresh read of the slot: null when it cannot be read or is not this module's format. */
  function load(): Map<string, string> | null {
    let text: string | null
    try { text = secrets.read('owner-tokens') } catch { return null }
    if (text === null) return new Map()
    try {
      const parsed = JSON.parse(text) as { version?: unknown; tokens?: unknown }
      if (parsed?.version !== STORE_VERSION || !parsed.tokens || typeof parsed.tokens !== 'object' || Array.isArray(parsed.tokens)) return null
      const tokens = new Map<string, string>()
      for (const [key, value] of Object.entries(parsed.tokens as Record<string, unknown>)) if (validOwnerToken(value)) tokens.set(key, value)
      return tokens
    } catch {
      return null // never the parser's message: it can quote the text it failed on
    }
  }

  function remember(tokens: Map<string, string> | null): Map<string, string> | null {
    cached = tokens
    unreadableUntil = tokens ? 0 : now() + RETRY_UNREADABLE_MS
    return tokens
  }

  function known(): Map<string, string> | null {
    if (cached) return cached
    if (now() < unreadableUntil) return null
    return remember(load())
  }

  /** A fresh read for a write, unless the store has just refused one (no prompt on every save). */
  function fresh(): Map<string, string> | null {
    if (now() < unreadableUntil) return null
    return remember(load())
  }

  function serialise(tokens: Map<string, string>): string {
    const sorted: Record<string, string> = {}
    for (const key of [...tokens.keys()].sort()) sorted[key] = tokens.get(key) as string
    return JSON.stringify({ version: STORE_VERSION, tokens: sorted })
  }

  return {
    get: (key) => known()?.get(key) ?? null,

    readable: () => known() !== null,

    store(entries) {
      const kept = new Set<string>()
      const wanted = Object.entries(entries).filter(([, token]) => validOwnerToken(token))
      if (wanted.length === 0) return kept
      const current = fresh()
      // A store that is there but cannot be read is never written over: it may hold other tokens.
      if (!current) return kept
      if (wanted.some(([key, token]) => current.get(key) !== token)) {
        const next = new Map(current)
        for (const [key, token] of wanted) next.set(key, token)
        try { secrets.write('owner-tokens', serialise(next)) } catch { /* what a fresh read returns decides */ }
      }
      const readBack = remember(load())
      if (!readBack) return kept
      for (const [key, token] of wanted) if (readBack.get(key) === token) kept.add(key)
      return kept
    },

    forget(keys) {
      if (keys.length === 0) return
      const current = fresh()
      if (!current || !keys.some((key) => current.has(key))) return
      const next = new Map(current)
      for (const key of keys) next.delete(key)
      try {
        if (next.size === 0) secrets.clear('owner-tokens')
        else secrets.write('owner-tokens', serialise(next))
      } catch { /* the token stays in the store; its row is gone, so nothing uses it */ }
      remember(load())
    },

    assertCanStore() {
      const current = secrets.availability().ok ? remember(load()) : null
      if (current === null) throw new SecretsError('unavailable', 'owner-tokens')
      // Readable is not writable (a full disk, a folder that no longer takes writes): prove a write.
      const text = serialise(current)
      try { secrets.write('owner-tokens', text) } catch (error) { throw new SecretsError(error instanceof SecretsError ? error.code : 'not-saved', 'owner-tokens') }
      const back = load()
      if (back === null || serialise(back) !== text) {
        remember(back)
        throw new SecretsError('not-saved', 'owner-tokens')
      }
      // No tokens, no slot file: the same state `forget` leaves.
      if (current.size === 0) { try { secrets.clear('owner-tokens') } catch { /* an empty slot is harmless */ } }
      remember(back)
    },
  }
}

// ── The registries ──────────────────────────────────────────────────────────────────────────────

/** The registry files. `readText` gives null when the file is not there. */
export interface RegistryFiles {
  readText(path: string): string | null
  /** All of `text` at `path` (private to this account), or the file as it was. */
  writeAtomic(path: string, text: string): void
  list(dir: string): string[]
  remove(path: string): void
}

export const nodeRegistryFiles: RegistryFiles = {
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  writeAtomic: (path, text) => writeTextAtomic(path, text, { mode: 0o600, sync: true }),
  list(dir) {
    try { return readdirSync(dir) } catch { return [] }
  },
  remove: (path) => rmSync(path, { force: true }),
}

type RawRow = Record<string, unknown>
type Rows = Record<string, unknown>

export interface OwnerTokenMigration {
  /** Rows that carried their token in the registry when the step began. */
  found: number
  /** Of those, rows whose token now lives in the store only. */
  moved: number
  /** Of those, rows that still carry their token (the store could not take it; they keep working). */
  kept: number
}

export interface OwnerTokenRestore {
  /** Rows given their token back in the registry. */
  restored: number
  /** Rows the store holds no token for. */
  missing: number
}

/** One operation at a time for each key; operations on different keys do not wait for each other. */
export interface KeyedQueue {
  /** Run `operation` once everything queued earlier for `key` has settled. Its failure is its own: the next one still runs. */
  run<Result>(key: string, operation: () => Promise<Result> | Result): Promise<Result>
}

/**
 * The per-key serial queue run-results-share.ts and run-prework.ts put their read-then-write operations
 * through. Nothing is held between operations: a key with nothing queued costs nothing, and only a
 * running operation (a request with a timeout, never a socket or a timer) keeps the next one waiting.
 */
export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    run(key, operation) {
      const result = (tails.get(key) ?? Promise.resolve()).then(operation)
      const tail = result.then(() => {}, () => {})
      tails.set(key, tail)
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
      return result
    },
  }
}

export type OwnerRegistryFailure = 'unreadable' | 'row-in-the-way' | 'changed'

/** A registry write (or restore) that was refused. Fixed text naming the file; never a row or a token. */
export class OwnerRegistryError extends Error {
  readonly code: OwnerRegistryFailure
  readonly registry: OwnerTokenRegistryName
  constructor(code: OwnerRegistryFailure, registry: OwnerTokenRegistryName) {
    const file = OWNER_TOKEN_REGISTRIES[registry].file
    super(code === 'unreadable'
      ? `The file ${file} in TalkWeaver's data folder could not be read, so nothing in it was changed.`
      : code === 'changed' ? `The file ${file} in TalkWeaver's data folder changed while this was under way, so nothing in it was changed.`
      : `The file ${file} in TalkWeaver's data folder already holds a different entry here, so nothing in it was changed.`)
    this.name = 'OwnerRegistryError'
    this.code = code
    this.registry = registry
  }
}

export interface OwnerTokenRegistry {
  /** The registry's rows by their key in the file, each carrying its `ownerToken` when one is known. */
  read(): Rows
  /** The file holds a row under this key, usable or not. */
  has(fileKey: string): boolean
  /** The id of the row the file holds under this key ('' when the row has none), or null when there is no row. */
  idAt(fileKey: string): string | null
  /**
   * Add or change the rows given; every other row in the file stays exactly as it is, whether or
   * not the caller could see it. Every row given must carry its id, service address and
   * `ownerToken`. Tokens go to the store first; the file is written without them. A row leaves the
   * file, and its token the store, only when its key is in `remove`. A row given under a key where
   * the file holds a different row (another id) must name that key in `remove` as well.
   *
   * `expect` says which row the caller saw under a key (its id, or null for none): when the file
   * holds something else there by now, nothing is written. A replacement names the row it replaces
   * this way, and a write that follows a request names its own row, so neither can undo what
   * another operation did meanwhile.
   *
   * Throws before anything is written: SecretsError when a row that is new to the registry cannot
   * have its token kept; OwnerRegistryError when the file cannot be read or parsed (it is left as it
   * is), when a row is in the way, or when `expect` no longer holds.
   */
  write(rows: Record<string, object>, options?: { remove?: readonly string[]; expect?: Record<string, string | null> }): void
  /**
   * Throws unless a new row could be kept now: the file can be read and a write to the store was
   * just shown to work. Call before creating anything on the service.
   */
  assertCanStore(): void
  /** Move every token still in the file into the store. Safe to run at every start. */
  migrate(): OwnerTokenMigration
  /**
   * Write every token back into the file (for going back to an older version). The store is left as
   * it is. Throws when the store cannot be read just now, and when the file cannot be read or parsed.
   */
  restorePlain(): OwnerTokenRestore
}

const isObject = (value: unknown): value is RawRow => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const plainToken = (row: RawRow): string | null => (typeof row.ownerToken === 'string' && row.ownerToken.length > 0 ? row.ownerToken : null)
function withoutToken(row: RawRow): RawRow {
  const { ownerToken: _taken, ...rest } = row
  return rest
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function openOwnerTokenRegistry(
  name: OwnerTokenRegistryName, path: string, tokens: OwnerTokens, files: RegistryFiles = nodeRegistryFiles,
): OwnerTokenRegistry {
  const spec = OWNER_TOKEN_REGISTRIES[name]
  const keyOf = (row: RawRow) => ownerTokenKey(spec.kind, row[spec.idField], row.workerBaseUrl)

  type Current = { state: 'missing' | 'corrupt'; rows: Rows } | { state: 'ok'; rows: Rows }
  function current(): Current {
    let text: string | null
    try { text = files.readText(path) } catch { return { state: 'corrupt', rows: {} } }
    if (text === null) return { state: 'missing', rows: {} }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (!isObject(parsed)) return { state: 'corrupt', rows: {} }
      // A file without its collection of rows is not an empty registry: writing over it would lose
      // whatever it does hold.
      const rows = parsed[spec.collection]
      return isObject(rows) ? { state: 'ok', rows } : { state: 'corrupt', rows: {} }
    } catch {
      return { state: 'corrupt', rows: {} }
    }
  }

  function idIn(rows: Rows, fileKey: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(rows, fileKey)) return null
    const id = (rows[fileKey] as RawRow | null)?.[spec.idField]
    return typeof id === 'string' ? id : ''
  }

  function persist(rows: Rows): void {
    files.writeAtomic(path, `${JSON.stringify({ version: spec.version, [spec.collection]: rows }, null, 2)}\n`)
  }

  /** Temporary files a crashed write left beside the registry (earlier versions' held plain tokens). */
  function sweepTemporaryFiles(): void {
    const base = escapeRegExp(basename(path))
    const left = [new RegExp(`^${base}\\.\\d+\\.[0-9a-z]+\\.tmp$`), new RegExp(`^\\.${base}\\.[0-9a-f-]{36}\\.tmp$`)]
    for (const file of files.list(dirname(path))) {
      if (left.some((pattern) => pattern.test(file))) {
        try { files.remove(join(dirname(path), file)) } catch { /* swept at the next start */ }
      }
    }
  }

  return {
    read() {
      const rows: Rows = {}
      for (const [fileKey, value] of Object.entries(current().rows)) {
        if (!isObject(value)) { rows[fileKey] = value; continue }
        const row = { ...value }
        if (plainToken(row) === null) {
          const key = keyOf(row)
          const token = key ? tokens.get(key) : null
          if (token) row.ownerToken = token
        }
        rows[fileKey] = row
      }
      return rows
    },

    has: (fileKey) => Object.prototype.hasOwnProperty.call(current().rows, fileKey),

    idAt: (fileKey) => idIn(current().rows, fileKey),

    write(rows, options = {}) {
      const file = current()
      if (file.state === 'corrupt') throw new OwnerRegistryError('unreadable', name)
      const before = file.rows
      for (const [fileKey, id] of Object.entries(options.expect ?? {})) {
        if (idIn(before, fileKey) !== id) throw new OwnerRegistryError('changed', name)
      }
      const remove = new Set(options.remove ?? [])
      const inFile = (fileKey: string) => Object.prototype.hasOwnProperty.call(before, fileKey)
      /** What the file holds now, by store key: the row's plain token, or null when it has none. */
      const onDisk = new Map<string, string | null>()
      for (const raw of Object.values(before)) {
        const key = isObject(raw) ? keyOf(raw) : null
        if (key) onDisk.set(key, plainToken(raw as RawRow))
      }
      const planned = new Map<string, { row: RawRow; key: string; token: string }>()
      const wanted: Record<string, string> = {}
      for (const [fileKey, value] of Object.entries(rows)) {
        const row = value as RawRow
        const key = isObject(row) ? keyOf(row) : null
        const token = isObject(row) ? row.ownerToken : null
        if (!key || !validOwnerToken(token)) throw new TypeError('A registry row needs its id, its service address and its owner token.')
        // Another row already under this key (one the caller could not see, perhaps) is never
        // written over unless the caller removes it by name.
        if (inFile(fileKey) && !remove.has(fileKey)) {
          const held = before[fileKey]
          if (!isObject(held) || keyOf(held) !== key) throw new OwnerRegistryError('row-in-the-way', name)
        }
        planned.set(fileKey, { row, key, token })
        wanted[key] = token
      }
      const kept = tokens.store(wanted)
      const placed = new Map<string, RawRow>()
      for (const [fileKey, { row, key, token }] of planned) {
        if (kept.has(key)) placed.set(fileKey, withoutToken(row))
        else if (onDisk.get(key) === token) placed.set(fileKey, row) // not moved yet: it stays as it was
        else if (onDisk.get(key) === null) placed.set(fileKey, withoutToken(row)) // moved at an earlier write
        else throw new SecretsError('unavailable', 'owner-tokens') // a new token is never written in plain text
      }
      const out: Rows = {}
      const removed: unknown[] = []
      for (const [fileKey, raw] of Object.entries(before)) {
        if (remove.has(fileKey)) removed.push(raw)
        if (placed.has(fileKey)) { out[fileKey] = placed.get(fileKey); continue }
        if (remove.has(fileKey)) continue
        // The same row given under a new key (a talk whose file was replaced) is one row, not two.
        const key = isObject(raw) ? keyOf(raw) : null
        if (key && key in wanted) continue
        out[fileKey] = raw // not mentioned: exactly as it was
      }
      for (const [fileKey, row] of placed) if (!Object.prototype.hasOwnProperty.call(out, fileKey)) out[fileKey] = row
      persist(out)
      // Only a row the caller removed by name gives up its token, and only when no row left uses it.
      const inUse = new Set(Object.values(out).map((raw) => (isObject(raw) ? keyOf(raw) : null)))
      tokens.forget(removed.flatMap((raw) => {
        const key = isObject(raw) ? keyOf(raw) : null
        return key && !inUse.has(key) ? [key] : []
      }))
    },

    assertCanStore() {
      if (current().state === 'corrupt') throw new OwnerRegistryError('unreadable', name)
      tokens.assertCanStore()
    },

    migrate() {
      const file = current()
      // Unreadable, not JSON, or without its rows: left exactly as it is, temporary files included.
      if (file.state === 'corrupt') return { found: 0, moved: 0, kept: 0 }
      const wanted: Record<string, string> = {}
      let found = 0
      for (const raw of Object.values(file.rows)) {
        const token = isObject(raw) ? plainToken(raw) : null
        if (token === null) continue
        found += 1
        const key = keyOf(raw as RawRow)
        if (key && validOwnerToken(token)) wanted[key] = token
      }
      let moved = 0
      if (found > 0) {
        const kept = tokens.store(wanted)
        if (kept.size > 0) {
          const out: Rows = {}
          for (const [fileKey, raw] of Object.entries(file.rows)) {
            const key = isObject(raw) ? keyOf(raw) : null
            if (isObject(raw) && key && kept.has(key) && wanted[key] === plainToken(raw)) {
              out[fileKey] = withoutToken(raw)
              moved += 1
            } else out[fileKey] = raw
          }
          persist(out)
        }
      }
      if (moved === found) sweepTemporaryFiles()
      return { found, moved, kept: found - moved }
    },

    restorePlain() {
      // A store that cannot be read is not "no token": say it failed rather than report rows as missing.
      if (!tokens.readable()) throw new SecretsError('unavailable', 'owner-tokens', 'read')
      const file = current()
      // A registry that cannot be parsed has rows this cannot see: a failure, never "nothing to restore".
      if (file.state === 'corrupt') throw new OwnerRegistryError('unreadable', name)
      const out: Rows = {}
      const given = new Map<string, string>()
      let missing = 0
      for (const [fileKey, raw] of Object.entries(file.rows)) {
        out[fileKey] = raw
        if (!isObject(raw) || plainToken(raw) !== null) continue
        const key = keyOf(raw)
        const token = key ? tokens.get(key) : null
        if (token) {
          out[fileKey] = { ...raw, ownerToken: token }
          given.set(fileKey, token)
        } else missing += 1
      }
      if (given.size > 0) {
        persist(out)
        const written = current().rows
        for (const [fileKey, token] of given) {
          const row = written[fileKey]
          if (!isObject(row) || plainToken(row) !== token) throw new Error('The registry could not be rewritten.')
        }
      }
      return { restored: given.size, missing }
    },
  }
}

export type OwnerTokenStep<Result> = Result | { failed: true }

function eachRegistry<Result>(
  userDataDir: string, tokens: OwnerTokens, files: RegistryFiles, step: (registry: OwnerTokenRegistry) => Result,
): Record<OwnerTokenRegistryName, OwnerTokenStep<Result>> {
  const results = {} as Record<OwnerTokenRegistryName, OwnerTokenStep<Result>>
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
    try {
      results[name] = step(openOwnerTokenRegistry(name, join(userDataDir, OWNER_TOKEN_REGISTRIES[name].file), tokens, files))
    } catch {
      results[name] = { failed: true } // one registry's trouble never stops the others; no error text is kept
    }
  }
  return results
}

/** First run and every run after: move the tokens still in the three registries into the store. Never throws. */
export function migrateOwnerTokens(userDataDir: string, tokens: OwnerTokens, files: RegistryFiles = nodeRegistryFiles) {
  return eachRegistry(userDataDir, tokens, files, (registry) => registry.migrate())
}

/** `--restore-plain-owner-tokens`: write the tokens back into the three registries. Never throws. */
export function restorePlainOwnerTokens(userDataDir: string, tokens: OwnerTokens, files: RegistryFiles = nodeRegistryFiles) {
  return eachRegistry(userDataDir, tokens, files, (registry) => registry.restorePlain())
}

/**
 * The registries a restore did not fully bring back: one that failed (the store or the file could
 * not be read) or that has a row whose token the store does not hold. Empty means every row of
 * every registry has its token again. Names only.
 */
export function incompleteOwnerTokenRestores(results: Record<OwnerTokenRegistryName, OwnerTokenStep<OwnerTokenRestore>>): OwnerTokenRegistryName[] {
  return OWNER_TOKEN_REGISTRY_NAMES.filter((name) => {
    const step = results[name]
    return !step || 'failed' in step || step.missing > 0
  })
}
