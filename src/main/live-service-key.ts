// This computer's admin keys for the live service (going live from several Macs, decision T1 and
// decisions R1 to R6 after the review of ticket 02).
//
// Each computer has its own key for each live service it uses. Cloudflare holds it as the Worker
// secret `ADMIN_SECRET_<computer id>`; this computer holds it in the secrets slot
// `live-worker-credentials`. No key travels between computers. The app never makes, sends, lists or
// stores a signing key (R1): the live service keeps its own.
//
// Three parts, each a seam the tests drive (scripts/test-live-service-keys.mjs):
//   1. The stored keys. The slot holds one ENTRY per live service (Cloudflare account id + Worker
//      name): `{ accountId, workerName, computerId, key, kind: 'own' | 'legacy' }` (R6). The computer's
//      id is made with its key and lives only here (R5): a new key always has a new id. What 0.38.2
//      wrote ({adminSecret, signingSecret}) is read as ONE `legacy` entry, for the account Settings
//      records at that time; its signing value is dropped the first time the slot is rewritten.
//      `createComputerKeyStore` is the only writer, and it only ever ADDS an entry: nothing here
//      removes or replaces one. A slot that cannot be read or decrypted, or holds something that is
//      not a key blob, is NOT "no key" (R4): every read then throws KeyStoreUnreadable, and nothing is
//      made, written or sent. A rewrite is one atomic write of the whole slot; one that fails leaves
//      the slot as it was. A key's binding (its account, or its address) is written ONCE and never
//      worked out again (R9): a blob in an earlier form is rewritten in this build's form on the first
//      read, bound to what Settings record at that moment, and until that rewrite has been taken and
//      read back, every read throws KeyStoreUnreadable: no key of an unbound blob is ever returned.
//   2. What the live service says about a key. `probeKey` asks an admin route (`GET /computers`):
//      200 accepted, 401 refused, anything else not ready, no answer unreachable. `waitForKey` polls
//      it with back-off for up to a minute. `acceptedKey` asks about each key held for one live
//      service, its own first: a computer's access is "removed" only when every one is refused. A key is shown only to the live service it was made for
//      (`keyIsFor`): the account and Worker name must be its entry's, and the address the one
//      resolved for that account by the caller.
//   3. The requests that change which keys the live service accepts, each ONE `PATCH …/secrets-bulk`
//      through the connection's authorisation: `addComputerKey` (this computer's secret and no other,
//      then wait until it is accepted) and `removeComputerKey` (one key set to null; nothing calls
//      it yet, ticket 04).
//   and one comparison, `uploadDecision` (R3): whether this app may put its code over what is deployed.
//
// A key is only ever in the slot, in an `Authorization` header to its own live service, and in the
// body of a secrets request for its own live service. Never in an address, a log, a result, Details
// or an error: every failure here is a value of a fixed kind, and what a reply said is not kept.
//
// No Electron import and erasable TypeScript only.
import { randomBytes } from 'node:crypto'
import type { Answer, OutgoingRequest } from './cloudflare-connection.ts'
import {
  LEGACY_ADMIN_SECRET_NAME, addKeyBody, addKeyRequest, computerSecretName, removeKeyBody, removeKeyRequest,
  validAccountSegment, validComputerId, type KeyToRemove, type PlannedRequest,
} from './live-service-upload.ts'

/** The id of the computer that holds `ADMIN_SECRET` (set up by 0.38.2 or earlier): worker/admin-keys.ts. */
export const LEGACY_COMPUTER_ID = 'legacy'
/**
 * One stored key: the live service it is for, the id it is registered under there, and the key.
 * `accountId: null` is only ever a `legacy` key from a 0.38.2 profile that recorded no account: it is
 * for the live service at `address` (the address Settings recorded with it) and no other. (An `own`
 * key with no account is one an unreleased build stored: kept, and for no live service.)
 */
export type StoredKey = {
  accountId: string | null
  workerName: string
  /** `legacy`, or the id made with this key. */
  computerId: string
  key: string
  kind: 'own' | 'legacy'
  address?: string
}
/** `none`: no key here for the live service. `legacy`: the 0.38.2 `ADMIN_SECRET`. `own`: `ADMIN_SECRET_<id>`. */
export type KeyKind = 'none' | 'legacy' | 'own'
export const keyKind = (key: StoredKey | null): KeyKind => (!key ? 'none' : key.kind)
/** The Worker secret a key is held under at Cloudflare. */
export const secretNameOf = (key: StoredKey): string => (key.kind === 'legacy' ? LEGACY_ADMIN_SECRET_NAME : computerSecretName(key.computerId))

/** A live service: the account and Worker it is, and the address resolved for it (null when none is known). */
export type LiveServiceAt = { accountId: string | null; workerName: string; baseUrl: string | null }

// ── 1. The stored keys ──────────────────────────────────────────────────────────────────────────

export const KEY_BLOB_FORMAT = 3
/** The sentence for a slot that cannot be read (R4). */
export const KEY_UNREADABLE = 'TalkWeaver could not read this computer\'s key. Nothing was changed.'
/** The slot is there and cannot be read, decrypted or understood. Carries nothing of what was read. */
export class KeyStoreUnreadable extends Error {
  constructor() {
    super(KEY_UNREADABLE)
    this.name = 'KeyStoreUnreadable'
  }
}

const usable = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const workerNameOk = (value: unknown): value is string => typeof value === 'string' && WORKER_NAME.test(value)

function entryOrNull(value: unknown): StoredKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { accountId, workerName, computerId, key, kind, address } = value as Record<string, unknown>
  if (!usable(key) || !workerNameOk(workerName)) return null
  if (kind === 'own') {
    // `accountId: null`: a key an earlier build of this branch stored with no account recorded. Kept, and it matches no live service.
    return validComputerId(computerId) && (accountId === null || validAccountSegment(accountId)) ? { accountId, workerName, computerId, key, kind } : null
  }
  if (kind !== 'legacy' || computerId !== LEGACY_COMPUTER_ID) return null
  if (validAccountSegment(accountId)) return { accountId, workerName, computerId, key, kind }
  if (accountId !== null) return null
  const at = address === undefined ? null : liveAddressOrNull(address)
  if (address !== undefined && at === null) return null
  return { accountId: null, workerName, computerId, key, kind, ...(at ? { address: at } : {}) }
}

/** Whether an entry is the key for this live service: the same account and Worker (or, with no account kept, the same address). */
export function keyIsFor(entry: StoredKey, at: LiveServiceAt): boolean {
  if (entry.workerName !== at.workerName) return false
  if (entry.accountId !== null) return at.accountId !== null && entry.accountId === at.accountId
  const address = liveAddressOrNull(at.baseUrl)
  return entry.kind === 'legacy' && typeof entry.address === 'string' && address !== null && entry.address === address
}

/** What Settings (`config.json`) records now of the live service this computer set up. Not secret. */
export type RecordedService = { accountId: string | null; baseUrl: string | null; workerName: string }

/**
 * The slot's text as entries. Null text (nothing stored): none. `old`: it is in an earlier form (the
 * 0.38.2 blob, which still holds a signing value this build has no use for) and is to be rewritten.
 * An earlier form has no account in it, so its one key is bound to what Settings records now: the
 * store uses such entries only to write them (R9), never to present or register a key.
 * Throws KeyStoreUnreadable for text that is not a key blob: that is never taken as "no key".
 */
export function readKeyBlob(text: string | null, recorded: RecordedService): { entries: StoredKey[]; old: boolean } {
  if (text === null) return { entries: [], old: false }
  if (typeof text !== 'string' || text.length === 0) throw new KeyStoreUnreadable()
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new KeyStoreUnreadable() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KeyStoreUnreadable()
  const blob = value as { format?: unknown; entries?: unknown; computerId?: unknown; adminSecret?: unknown; signingSecret?: unknown }
  if (blob.format === KEY_BLOB_FORMAT) {
    if (!Array.isArray(blob.entries)) throw new KeyStoreUnreadable()
    const entries = blob.entries.map(entryOrNull)
    if (entries.some((entry) => entry === null)) throw new KeyStoreUnreadable()
    return { entries: entries as StoredKey[], old: false }
  }
  if (!usable(blob.adminSecret) || !workerNameOk(recorded.workerName)) throw new KeyStoreUnreadable()
  const account = validAccountSegment(recorded.accountId) ? recorded.accountId : null
  const address = account === null ? liveAddressOrNull(recorded.baseUrl) : null
  const service = { accountId: account, workerName: recorded.workerName, ...(address ? { address } : {}) }
  // 0.38.2: exactly the two values, no format. The first computer's `ADMIN_SECRET`.
  if (blob.format === undefined && blob.computerId === undefined && usable(blob.signingSecret)) {
    return { entries: [{ ...service, computerId: LEGACY_COMPUTER_ID, key: blob.adminSecret, kind: 'legacy' }], old: true }
  }
  // An earlier build of this branch (never released): one key, its id beside it.
  if (blob.format === 2 && blob.signingSecret === undefined) {
    if (blob.computerId === LEGACY_COMPUTER_ID) return { entries: [{ ...service, computerId: LEGACY_COMPUTER_ID, key: blob.adminSecret, kind: 'legacy' }], old: true }
    if (validComputerId(blob.computerId)) return { entries: [{ accountId: account, workerName: recorded.workerName, computerId: blob.computerId, key: blob.adminSecret, kind: 'own' }], old: true }
  }
  throw new KeyStoreUnreadable()
}

/** The slot's text for these entries, as this build writes it: no signing value, and no entry that is not a key. */
export function keyBlob(entries: readonly StoredKey[]): string {
  const checked = entries.map(entryOrNull)
  if (checked.some((entry) => entry === null)) throw new TypeError('Not a key.')
  return JSON.stringify({ format: KEY_BLOB_FORMAT, entries: checked })
}

/** A new computer id: 16 lower-case hex characters. */
export function newComputerId(random: (bytes: number) => Buffer = randomBytes): string {
  return random(8).toString('hex')
}

export const COMPUTER_NAME_MAX = 64
// As worker/computers.ts `parseComputerName`: no control, format, private-use or unassigned
// characters, no line or paragraph separators (the test holds the two rules together).
const NAME_FORBIDDEN = /[\p{C}\p{Zl}\p{Zp}]/gu
/** A computer's name as the live service stores one (trimmed, 1 to 64 characters, one line), or null. */
export function computerNameOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > COMPUTER_NAME_MAX * 8) return null
  const name = value.trim()
  NAME_FORBIDDEN.lastIndex = 0
  if (NAME_FORBIDDEN.test(name)) return null
  const length = [...name].length
  return length >= 1 && length <= COMPUTER_NAME_MAX ? name : null
}
/** The name a computer starts with: its host name without `.local`, cut to what a name may be. */
export function defaultComputerName(hostName: string): string {
  const plain = String(hostName ?? '').replace(NAME_FORBIDDEN, '').trim().replace(/\.local$/i, '').trim()
  return computerNameOrNull([...plain].slice(0, COMPUTER_NAME_MAX).join('')) ?? 'This computer'
}

export interface ComputerKeyStorePorts {
  /** The slot's text, or null ONLY when nothing is stored. Throws when it cannot be read or decrypted. */
  read(): string | null
  /** Replace the slot's text, atomically. Throws, and leaves the slot as it was, when it cannot be kept safely. */
  write(text: string): void
  /** What Settings records now: the account and address an earlier-form blob's key is bound to. */
  recorded(): RecordedService
  /**
   * The names of the fields `config.json` holds now, and the removal of one. Used for one thing: a
   * field an unreleased build left there is taken out when the store is made (R5). No value is read.
   */
  settings?: { fields(): string[]; remove(field: string): void }
  random?: (bytes: number) => Buffer
}
/** An unreleased build kept the computer's id in config.json under this name. Nothing reads it; it is taken out. */
const LEFTOVER_SETTINGS_FIELD = 'computerId'

export interface ComputerKeyStore {
  /**
   * Throws KeyStoreUnreadable when the slot cannot be read. Writes one thing only: a blob in an
   * earlier form is rewritten in this build's form (R9), and that failing is "cannot be read" too.
   */
  check(): void
  /**
   * The keys held for this live service: its own first, then the 0.38.2 one. Never a key of another
   * account, Worker or address, and never a key from a blob that is not yet in this build's form
   * (R9: such a blob is rewritten first, or this throws). Throws KeyStoreUnreadable.
   */
  keysFor(at: LiveServiceAt): StoredKey[]
  /**
   * This computer's OWN key for this live service, stored before it is returned. One already stored
   * for it is returned as it is, never replaced. Otherwise a new id and key are made together and
   * ADDED beside every entry already there. Throws (and the slot is as it was) when the slot cannot
   * be read (KeyStoreUnreadable) or written: the caller then sends nothing.
   */
  ownKeyFor(at: { accountId: string; workerName: string }): StoredKey
  /** Rewrite an earlier-form blob in this build's form now (its signing value goes). Failure leaves it as it was, and unread. Never throws. */
  migrate(): void
}

export function createComputerKeyStore(ports: ComputerKeyStorePorts): ComputerKeyStore {
  const slot = (): string | null => {
    try { return ports.read() } catch { throw new KeyStoreUnreadable() }
  }
  /**
   * The entries of the slot, every one of them BOUND (this build's form: its account or address is
   * written in the slot beside its key). R9: a blob in an earlier form has no binding in it, and is
   * never used as it is. It is bound once, to what Settings record at this moment, by rewriting the
   * slot; only when that write was taken and the slot reads back as what was written do its entries
   * exist. A write that fails, or a slot that does not read back so, throws KeyStoreUnreadable: the
   * blob is as it was, nothing of it is returned or kept in memory, and the next read tries again with
   * what Settings record then.
   */
  const stored = (): StoredKey[] => {
    const now = readKeyBlob(slot(), ports.recorded())
    if (!now.old) return now.entries
    const bound = keyBlob(now.entries)
    try { ports.write(bound) } catch { throw new KeyStoreUnreadable() }
    const back = slot()
    if (back !== bound) throw new KeyStoreUnreadable()
    const kept = readKeyBlob(back, ports.recorded())
    if (kept.old) throw new KeyStoreUnreadable()
    return kept.entries
  }
  const order = (entry: StoredKey): number => (entry.kind === 'own' ? 0 : 1)
  // R5: a computer's id lives with its key. One left in config.json is removed, whatever the slot holds.
  try { if (ports.settings?.fields().includes(LEFTOVER_SETTINGS_FIELD)) ports.settings.remove(LEFTOVER_SETTINGS_FIELD) } catch { /* left; nothing reads it */ }
  return {
    check() { stored() },
    keysFor: (at) => stored().filter((entry) => keyIsFor(entry, at)).sort((a, b) => order(a) - order(b)),
    ownKeyFor(at) {
      if (!validAccountSegment(at.accountId) || !workerNameOk(at.workerName)) throw new TypeError('Not a live service.')
      const entries = stored()
      const existing = entries.find((entry) => entry.kind === 'own' && entry.accountId === at.accountId && entry.workerName === at.workerName)
      if (existing) return existing
      const random = ports.random ?? randomBytes
      const made: StoredKey = { accountId: at.accountId, workerName: at.workerName, computerId: newComputerId(random), key: random(32).toString('base64url'), kind: 'own' }
      ports.write(keyBlob([...entries, made])) // throws: nothing was made, nothing is sent
      return made
    },
    migrate() {
      try { stored() } catch { /* the slot stays as it was; every read tries again, and throws until the rewrite is taken */ }
    },
  }
}

// ── 2. What the live service says about a key ───────────────────────────────────────────────────

export interface LiveIo {
  /** Requests to the live service itself (its workers.dev address), not to Cloudflare's API. */
  fetch: typeof fetch
  /** Tests: a clock and a pause that do not really wait. */
  wait?(ms: number): Promise<void>
  now?(): number
  /** One request's time limit. */
  requestMs?: number
  /** Tests: the time limit that runs beside a read-back's request, on the test's clock (otherwise a real timer). */
  timer?(ms: number): Promise<void>
  /** How long to go on asking: ACCEPT_WAIT_MS. */
  waitMs?: number
}

export const ACCEPT_WAIT_MS = 60_000
export const LIVE_REQUEST_MS = 10_000
/** The pauses between polls: short at first (a secret arrives in 3 to 4 s), then every 5 s. */
export const POLL_PAUSES_MS: readonly number[] = [500, 1000, 1500, 2000, 3000, 5000]

/** A pause that does not keep the app from quitting. */
export function unreferencedWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  })
}

/** Only an https address, or http on this computer (tests), is ever sent a key. */
export function liveAddressOrNull(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') return null
  try {
    const url = new URL(baseUrl)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
    return url.origin
  } catch { return null }
}

async function ask(io: LiveIo, address: string, init: RequestInit): Promise<Response | null> {
  try {
    // AbortSignal.timeout's timer is not referenced: it does not keep the app from quitting.
    return await io.fetch(address, { ...init, redirect: 'error', signal: AbortSignal.timeout(io.requestMs ?? LIVE_REQUEST_MS) })
  } catch { return null }
}

/** `accepted`: 200 from an admin route. `refused`: 401 `admin_auth_required`. `not-ready`: any other answer (older code, an error). `unreachable`: no answer. */
export type KeyProbe = 'accepted' | 'refused' | 'not-ready' | 'unreachable'
export type KeyProbed = { probe: KeyProbe; /** How many other computers are on the list, when accepted. */ others: number | null }

/** Ask the live service whether it accepts this key: `GET /computers`, the key in the header only. `at.baseUrl`: the address resolved for that account by the caller. */
export async function probeKey(io: LiveIo, at: LiveServiceAt, key: StoredKey): Promise<KeyProbed> {
  const base = liveAddressOrNull(at.baseUrl)
  // A key is shown only to the live service it was made for.
  if (!base || !keyIsFor(key, at)) return { probe: 'unreachable', others: null }
  const response = await ask(io, `${base}/computers`, { method: 'GET', headers: { authorization: `Bearer ${key.key}`, accept: 'application/json' } })
  if (!response) return { probe: 'unreachable', others: null }
  // Only the live service's own refusal of an admin key (401 `admin_auth_required`, which is what every
  // admin route of the Worker answers a key it does not hold) is a refusal; another 401 concludes nothing.
  if (await isAdminRefusal(response)) { await response.body?.cancel().catch(() => {}); return { probe: 'refused', others: null } }
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return { probe: 'not-ready', others: null } }
  let body: unknown
  try { body = await response.json() } catch { return { probe: 'not-ready', others: null } }
  const { computers, self } = (body ?? {}) as { computers?: unknown; self?: unknown }
  // The live service says whose key it took this for: it must be this computer's.
  if (!Array.isArray(computers) || self !== key.computerId) return { probe: 'not-ready', others: null }
  return { probe: 'accepted', others: computers.filter((line) => (line as { id?: unknown } | null)?.id !== self).length }
}

/**
 * Whether a reply of the live service is its refusal of an admin key: 401 with the code
 * `admin_auth_required` (worker/http.ts). The reply is read from a copy; nothing of its text is kept.
 */
export async function isAdminRefusal(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  try {
    const body = await response.clone().json() as { error?: { code?: unknown } } | null
    return body?.error?.code === 'admin_auth_required'
  } catch { return false }
}

/** The build the live service answers as (`GET /capabilities`, no key), or null; `reached`: it answered at all. */
export async function readLiveBuild(io: LiveIo, baseUrl: string): Promise<{ build: string | null; reached: boolean }> {
  const base = liveAddressOrNull(baseUrl)
  if (!base) return { build: null, reached: false }
  const response = await ask(io, `${base}/capabilities`, { method: 'GET', headers: { accept: 'application/json' } })
  if (!response) return { build: null, reached: false }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return { build: null, reached: true } }
  try {
    const build = ((await response.json()) as { build?: unknown } | null)?.build
    return { build: typeof build === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(build) ? build : null, reached: true }
  } catch { return { build: null, reached: true } }
}

/**
 * Ask the live service which build it is until it says, for up to a minute, with the pauses a key is
 * waited for with (an address just switched on takes a few seconds to answer). Null: it never said.
 */
export async function waitForBuild(io: LiveIo, baseUrl: string, stop: () => boolean = () => false): Promise<string | null> {
  const now = io.now ?? Date.now
  const wait = io.wait ?? unreferencedWait
  const limit = io.waitMs ?? ACCEPT_WAIT_MS
  const started = now()
  for (let poll = 0; ; poll += 1) {
    const { build } = await readLiveBuild(io, baseUrl)
    if (build !== null) return build
    const pause = POLL_PAUSES_MS[Math.min(poll, POLL_PAUSES_MS.length - 1)]
    if (stop() || now() - started + pause > limit) return null
    await wait(pause)
  }
}

/** The number a build starts with ("22-signing-key" → 22), or null. A higher number is a newer live service. */
export function buildNumber(build: string | null): number | null {
  const match = typeof build === 'string' ? /^(\d{1,6})(?:-|$)/.exec(build) : null
  return match ? Number(match[1]) : null
}

/** How long an upload is given to be what every request sees, before a lower build still answering is taken as another computer's. */
export const READ_BACK_WAIT_MS = 30_000
/**
 * What the read-back after an upload found (R10).
 *   `active`       this app's build answered, or a higher one (a newer build elsewhere is fine), or
 *                  the read at the deadline had no readable answer (which is not a new failure);
 *   `pending`      the read at the deadline answered as the SAME build that was deployed before this
 *                  upload: Cloudflare has not switched to the upload yet (an upload may be activated
 *                  late). Nobody uploaded over it;
 *   `overwritten`  the read at the deadline answered as a LOWER build that is NOT the one deployed
 *                  before this upload: an older TalkWeaver's upload landed over this one.
 */
export type ReadBack = { outcome: 'active' } | { outcome: 'pending' | 'overwritten'; build: string }
/** `work`, or null once `ms` have passed without it (on `io.timer` when a test supplies one; the timer of the real one is cleared and never keeps the app open). */
function within<Result>(io: LiveIo, ms: number, work: Promise<Result>): Promise<Result | null> {
  if (io.timer) return Promise.race([work, io.timer(ms).then(() => null)])
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    void work.then((result) => { clearTimeout(timer); resolve(result) }, () => { clearTimeout(timer); resolve(null) })
  })
}
/**
 * The read-back after this app uploaded its code (R10). There is no conditional upload: two computers
 * that update inside the propagation window are last-write-wins. So the build is read again.
 * `before`: the build read for the upload decision, the one this upload went over (null: there was no
 * live service). The rule:
 *   - the build is asked for with the usual pauses, and the FIRST read that shows this app's build
 *     or a higher one is `active`: nothing more is read (an overwrite after that is the accepted
 *     last-write-wins case);
 *   - a read before the deadline that is lower, unreadable or unanswered decides nothing, however
 *     late its answer comes: asking goes on, and a read still unanswered at the deadline is left;
 *   - ONE final read is started at the deadline (READ_BACK_WAIT_MS; the pause before it is cut to
 *     end there) and no other read is started then or later. It alone decides: this app's build or
 *     higher is `active`, the build from before the upload `pending`, another lower build
 *     `overwritten`, no readable answer `active`.
 * Every read has its own time limit (the request's), after which it counts as unreadable. Reads
 * only: nothing is uploaded from here, whatever is read. `stop`: the run is no longer the one in
 * charge; nothing more is read and nothing is concluded (the caller answers "superseded").
 */
export async function readBackAfterUpload(io: LiveIo, baseUrl: string, app: string, before: string | null, stop: () => boolean = () => false): Promise<ReadBack> {
  const ours = buildNumber(app)
  if (ours === null) return { outcome: 'active' }
  const now = io.now ?? Date.now
  const wait = io.wait ?? unreferencedWait
  const limit = Math.max(0, Math.min(io.waitMs ?? READ_BACK_WAIT_MS, READ_BACK_WAIT_MS))
  const requestMs = io.requestMs ?? LIVE_REQUEST_MS
  const started = now()
  const left = (): number => limit - (now() - started)
  /** One read, given `ms` to answer: the build, or null (unreadable, or no answer in time). */
  const read = async (ms: number): Promise<string | null> => (await within(io, ms, readLiveBuild(io, baseUrl)))?.build ?? null
  const reached = (build: string | null): boolean => { const theirs = buildNumber(build); return theirs !== null && theirs >= ours }
  for (let poll = 0; left() > 0; poll += 1) {
    // Given no longer than until the deadline: the final read is started there, answered or not.
    if (reached(await read(Math.min(requestMs, left())))) return { outcome: 'active' }
    if (stop()) return { outcome: 'active' }
    const pause = Math.min(POLL_PAUSES_MS[Math.min(poll, POLL_PAUSES_MS.length - 1)], left())
    if (pause > 0) await wait(pause)
  }
  if (stop()) return { outcome: 'active' }
  // The final read, at the deadline: the only one whose lower answer is believed.
  const build = await read(requestMs)
  if (build === null || buildNumber(build) === null || reached(build)) return { outcome: 'active' }
  return { outcome: build === before ? 'pending' : 'overwritten', build }
}
/**
 * THE comparison (R3): may this app put its code over the live service that answers as `deployed`?
 *   `upload`      both builds start with a number and this app's is strictly greater;
 *   `current`     the two are the same text: nothing to upload;
 *   `app-older`   the deployed number is greater: an older app never uploads over a newer service;
 *   `unreadable`  no build was read, either has no leading number, or the numbers are equal and the
 *                 text differs: nothing is known, so nothing is sent.
 * Only `upload` ever uploads. (No Worker at all is the caller's case: there is nothing to compare.)
 */
export type UploadDecision = 'upload' | 'current' | 'app-older' | 'unreadable'
export function uploadDecision(deployed: string | null, app: string): UploadDecision {
  const theirs = buildNumber(deployed)
  const ours = buildNumber(app)
  if (theirs === null || ours === null) return 'unreadable'
  if (deployed === app) return 'current'
  if (theirs === ours) return 'unreadable'
  return theirs < ours ? 'upload' : 'app-older'
}

/**
 * Poll the live service about a key, for up to a minute.
 *   `accepted`  wait until it is accepted. A 401 meanwhile means "not yet" (a secret takes a few
 *               seconds to arrive); after the limit the answer is `not-accepted`.
 *   `verdict`   wait until it is accepted, or refused TWICE in a row (one 401 is not taken as final).
 * Otherwise the last thing seen when the limit passed: `not-ready` (it answers, but not this build's
 * admin route yet) or `unreachable` (no answer at all).
 */
export type KeyWait = { outcome: 'accepted'; others: number | null } | { outcome: 'refused' | 'not-accepted' | 'not-ready' | 'unreachable'; others: null }
export async function waitForKey(io: LiveIo, at: LiveServiceAt, key: StoredKey, until: 'accepted' | 'verdict', stop: () => boolean = () => false): Promise<KeyWait> {
  const now = io.now ?? Date.now
  const wait = io.wait ?? unreferencedWait
  const limit = io.waitMs ?? ACCEPT_WAIT_MS
  const started = now()
  let refusals = 0
  let last: KeyProbe = 'unreachable'
  for (let poll = 0; ; poll += 1) {
    const { probe, others } = await probeKey(io, at, key)
    last = probe
    if (probe === 'accepted') return { outcome: 'accepted', others }
    refusals = probe === 'refused' ? refusals + 1 : 0
    if (until === 'verdict' && refusals >= 2) return { outcome: 'refused', others: null }
    const pause = POLL_PAUSES_MS[Math.min(poll, POLL_PAUSES_MS.length - 1)]
    if (stop() || now() - started + pause > limit) break
    await wait(pause)
  }
  // One 401 at the limit is not a verdict: it is "not accepted yet".
  return { outcome: last === 'refused' ? 'not-accepted' : last === 'unreachable' ? 'unreachable' : 'not-ready', others: null }
}

/**
 * Which of the keys held for ONE live service it accepts (`keys`: `ComputerKeyStore.keysFor`, this
 * computer's own first, then the 0.38.2 one). Each is asked about in turn, and the first accepted is
 * the answer: a 0.38.2 key that still works is used while this computer's own is not registered.
 *   `accepted`  with the key it accepted;
 *   `refused`   EVERY key held was refused by the live service's own 401: only this reads "access was
 *               removed". With `again`, one 401 is not taken as final (a key just added takes a few
 *               seconds to arrive): that key is asked about once more after `again` ms;
 *   `unknown`   no key held, or any key met no answer or another status: nothing is concluded.
 */
export type KeysAnswer = { answer: 'accepted'; key: StoredKey; others: number | null } | { answer: 'refused' | 'unknown'; key: null; others: null }
export async function acceptedKey(io: LiveIo, at: LiveServiceAt, keys: readonly StoredKey[], again: number | null = null, stop: () => boolean = () => false): Promise<KeysAnswer> {
  const wait = io.wait ?? unreferencedWait
  let refused = 0
  for (const key of keys) {
    if (stop()) break
    let probed = await probeKey(io, at, key)
    if (probed.probe === 'refused' && again !== null) {
      await wait(again)
      probed = await probeKey(io, at, key)
    }
    if (probed.probe === 'accepted') return { answer: 'accepted', key, others: probed.others }
    if (probed.probe === 'refused') refused += 1
  }
  return { answer: keys.length > 0 && refused === keys.length ? 'refused' : 'unknown', key: null, others: null }
}

/**
 * The key to present on a use (Go live, a share): with one key held for the live service, that one,
 * and nothing is asked. With two (this computer's own and the 0.38.2 one), the one the live service
 * accepts; when it accepts neither, or does not answer, this computer's own.
 */
export async function keyToPresent(io: LiveIo, at: LiveServiceAt, keys: readonly StoredKey[]): Promise<StoredKey | null> {
  if (keys.length <= 1) return keys[0] ?? null
  return (await acceptedKey(io, at, keys)).key ?? keys[0]
}

/**
 * One request of a use (Go live's `POST /sessions`), sent with the key chosen for it (`first`) and,
 * only when the live service's own 401 refuses that one, once more with the other key held for the
 * same live service: probes that met no answer leave this computer's own key chosen while the 0.38.2
 * one is the one that works. `held`: every key that might be tried; only those stored for `at` are,
 * and only when `first` is itself one of them (a secret from anywhere else is sent alone).
 *   `refused`  EVERY key tried got the live service's 401: only this reads "access was removed".
 * `send` throwing (no answer) is thrown on: that is never "access was removed".
 */
export async function sendWithHeldKeys(at: LiveServiceAt, held: readonly StoredKey[], first: string, send: (key: string) => Promise<Response>): Promise<{ response: Response; refused: boolean }> {
  const stored = held.filter((entry) => keyIsFor(entry, at)).map((entry) => entry.key)
  const turn = stored.includes(first) ? [first, ...stored.filter((key) => key !== first)] : [first]
  for (let index = 0; ; index += 1) {
    const response = await send(turn[index])
    if (!await isAdminRefusal(response)) return { response, refused: false }
    if (index === turn.length - 1) return { response, refused: true }
    await response.body?.cancel().catch(() => {})
  }
}

/** Record this computer on the live service's list, under the id its key belongs to (`POST /computers/self`). */
export async function recordComputer(io: LiveIo, at: LiveServiceAt, key: StoredKey, name: string): Promise<boolean> {
  const base = liveAddressOrNull(at.baseUrl)
  const shown = computerNameOrNull(name)
  if (!base || !shown || !keyIsFor(key, at)) return false
  const response = await ask(io, `${base}/computers/self`, {
    method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ name: shown }),
  })
  await response?.body?.cancel().catch(() => {})
  return response?.ok === true
}

// ── 3. The requests that change which keys the live service accepts ─────────────────────────────

/** One request to Cloudflare's API through the connection's authorisation. Null: the token or account changed (superseded). */
export type CloudflareSend = <Result>(outgoing: OutgoingRequest, pick: (result: unknown) => Result | null, timeoutMs: number) => Promise<Answer<Result> | null>

export type KeyChange =
  | { ok: true; others: number | null }
  | { ok: false; why: 'superseded' }
  /** Cloudflare did not take the request: its answer, in numbers. */
  | { ok: false; why: 'cloudflare'; answer: Answer<unknown> }
  /** The request went through, and the live service does not accept the key yet, or does not answer. */
  | { ok: false; why: 'not-accepted' | 'not-ready' | 'unreachable' }

export type KeyTarget = {
  send: CloudflareSend
  io: LiveIo
  accountId: string
  /** The Worker's name. */
  scriptName: string
  /** The live service's address, as Cloudflare reports it for this account in this run. */
  baseUrl: string
  timeoutMs: number
  /** Still the connection it was started for. */
  current(): boolean
}

const outgoing = (planned: PlannedRequest<string>, body: string): OutgoingRequest => {
  if (planned.body?.kind !== 'secrets') throw new TypeError('Not a secrets request.')
  return { method: planned.method, path: planned.path, body, contentType: planned.body.contentType }
}
const taken = (): true => true

const serviceOf = (target: KeyTarget): LiveServiceAt => ({ accountId: target.accountId, workerName: target.scriptName, baseUrl: target.baseUrl })

/**
 * Add this computer's key to the live service and wait until the live service accepts it.
 * Exactly ONE write: `PATCH …/secrets-bulk` whose body names `ADMIN_SECRET_<this computer's id>` and
 * nothing else, so `ADMIN_SECRET`, the live service's signing key and every other computer's key stay
 * as they are. The key must already be stored on this computer (`ComputerKeyStore.ownKeyFor`): sending
 * the same key again is harmless, which is what makes Try again safe. Throws, and sends nothing, for
 * a `legacy` key (never sent) and for a key made for another account or Worker (R6).
 *
 * Whatever must come before a computer may join (the joining code) is the caller's, before this call.
 */
export async function addComputerKey(target: KeyTarget, key: StoredKey): Promise<KeyChange> {
  if (key.kind !== 'own' || key.accountId !== target.accountId || key.workerName !== target.scriptName) throw new TypeError('Not this live service\'s key.')
  const planned = addKeyRequest(target.accountId, target.scriptName, key.computerId) // throws for any id that is not a computer's
  const request = outgoing(planned, addKeyBody(key.computerId, key.key))
  if (!target.current()) return { ok: false, why: 'superseded' }
  const answer = await target.send({ ...request, forbidden: [key.key] }, taken, target.timeoutMs)
  if (!answer) return { ok: false, why: 'superseded' }
  if (answer.kind !== 'ok') return { ok: false, why: 'cloudflare', answer }
  const waited = await waitForKey(target.io, serviceOf(target), key, 'accepted', () => !target.current())
  if (!target.current()) return { ok: false, why: 'superseded' }
  if (waited.outcome === 'accepted') return { ok: true, others: waited.others }
  return { ok: false, why: waited.outcome === 'unreachable' ? 'unreachable' : waited.outcome === 'not-ready' ? 'not-ready' : 'not-accepted' }
}

/**
 * Remove one computer's key from the live service: ONE `PATCH …/secrets-bulk` naming that one secret
 * with null. `{ legacy: true }` removes the first computer's `ADMIN_SECRET` and must be asked for in
 * those words; no other secret can be named. The computer's line on the list is the caller's to
 * remove (`DELETE /computers/<id>`). Nothing calls this yet (ticket 04).
 */
export async function removeComputerKey(target: Pick<KeyTarget, 'send' | 'accountId' | 'scriptName' | 'timeoutMs' | 'current'>, which: KeyToRemove): Promise<{ ok: true } | { ok: false; why: 'superseded' } | { ok: false; why: 'cloudflare'; answer: Answer<unknown> }> {
  const planned = removeKeyRequest(target.accountId, target.scriptName, which)
  if (!target.current()) return { ok: false, why: 'superseded' }
  const answer = await target.send(outgoing(planned, removeKeyBody(which)), taken, target.timeoutMs)
  if (!answer) return { ok: false, why: 'superseded' }
  return answer.kind === 'ok' ? { ok: true } : { ok: false, why: 'cloudflare', answer }
}
