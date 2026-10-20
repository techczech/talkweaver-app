// A Run's pre-work and post-work, main-process side (ADR-0032 amendment points 2–4; feedback-boards
// ticket 09; ADR-0040 decisions 3 and 5, work-files ticket 13).
//
// One object on the live Worker per Run and phase (`pre`, `post`). The app keeps each in one registry
// file in app data with the window it was pushed with and how far the Run has been mirrored (`cursor`,
// the Worker's sequence number). A row's key names the vault, the talk, the Run and the phase
// (runPreworkKey: `<talk>/<run>@<vault>`, `#post` before the vault for post-work), so two open vaults
// holding the same talk and Run id never share an object (issue 256). A row written before keys named
// the vault (`<talk>/<run>`, a 0.37 one being phase `pre`) is still read, by the one vault it records,
// and moved under that vault's key by its next publish. Its owner token is kept in the secrets store
// (owner-tokens.ts), joined to the row when the registry is read, and never reaches a window or a log.
//   - publish: creates the phase's object on first use (admin secret, once) and pushes the public form
//     and the phase's window; the handout is then built with the object's id;
//   - pushWindow / syncWindows: a changed opening or closing time is pushed without the form; a later
//     closing time reopens a phase that has closed (ADR-0040 decision 3);
//   - pull: pages every entry after the cursor and merges them onto the Run's own section for the
//     phase (`prework` or `postwork`) through the atomic Run writer, by entry id; the cursor moves only
//     once the Run is written. On demand, and on a timer while any phase is open;
//   - close: "Close now" on the Worker with the object's own token, then one last pull;
//   - withdraw: the Run unpublished: participants see "not available"; the answers stay (ticket 17). The
//     request is noted on the row (`withdrawAskedAt`) BEFORE it is sent, so Publish again serves the phase
//     again even when the Worker applied it and its answer was lost. A failure is one of this module's
//     fixed sentences; what the Worker said is only `details`, without the owner token;
//   - phasesSent: the phases a Run has an object for, whatever it has attached now (Unpublish withdraws them);
//   - ownerRecord: whether this computer holds a usable key for a phase ('usable'), one it cannot read
//     just now ('locked'), or none ('none': no row, or a row whose key is not in secure storage). A
//     withdraw with no usable key is never reported as done (workKeyMissing).
//
// Invariants: the form pushed carries no right answer (publicPreworkForm, checked again by the Worker);
// a Run is read only from its talk's own folder and written back only there (readRunForTalk /
// persistRunForTalk); a push or pull only ever goes to the Worker origin the object was created on;
// answers the Worker says belong to the other phase are never mirrored.
// A new object's owner token is stored and read back before its form is pushed; when it cannot be
// stored the object is closed again with the token still in hand. Every request that carries an
// owner token goes through ownerFetch: a failure to send is a fixed sentence, never the transport's
// error. A row this module cannot use just now (secure storage locked) stays in the registry untouched,
// and every operation on it says so and changes nothing.
// Every operation on one Run and phase runs one at a time (a per-row queue): a second publish waits
// and reuses the first one's object. Apart from the queue, a new object replaces only the exact row
// this saw, a write after a request goes ahead only while the object's own row is still there, and
// an object made here whose row is not registered is closed again.
import { resolve as resolvePath } from 'node:path'
import { isShareId } from '../shared/share-id.ts'
import { createKeyedQueue, openOwnerTokenRegistry, ownerFetch, validOwnerToken, type OwnerTokens } from './owner-tokens.ts'
import { LIVE_ACCESS_REMOVED, sendAsAdmin, type AdminEndpoint } from './live-admin-request.ts'
import { applyPickChange, type PickChange } from '../shared/run-prework-results.ts'
import { RUN_PREWORK_MAX_SLIDE_ID, zonedLocalToMs } from '../shared/run-prework.ts'
import type { PreworkForm } from '../shared/run-prework.ts'
import { SESSION_END, workKeyMissing, type Phase, type RunWork } from '../shared/run-work.ts'
import { isNotYetOpenedWindow, notYetOpenedWindow } from '../shared/post-work-opening.ts'
import { applyRunWorkAnswers, isSafeRunId, isSafeTalkSlug, markRunPreworkQuestion, persistRunForTalk, readRunForTalk, setRunPreworkPick, setRunPreworkSeen, type RunRecord } from './runs.ts'
import type { SeenChange } from '../shared/run-answers.ts'

export type { Phase }

export interface RunPreworkRow {
  key: string
  preworkId: string
  ownerToken: string
  workerBaseUrl: string
  /** Post-work only; a row without it (every row 0.37 wrote) is pre-work. */
  phase?: 'post'
  opensAt: number
  closesAt: number
  /** The Worker's sequence number the Run has been mirrored up to. */
  cursor: number
  createdAt: number
  /** Closed early (from the app, or as the Worker last said). */
  closedAt?: number
  /** When the app found the object purged on the Worker (60 idle days): never asked again. */
  purgedAt?: number
  /** Withdrawn (the Run unpublished): participants are shown "not available". */
  withdrawnAt?: number
  /**
   * A withdraw was ASKED for (written before the request goes out) and its answer has not come back
   * saying so. Publish again serves the phase again whenever this is set, so a withdraw the Worker
   * applied but whose answer was lost is still undone (ticket 17 fix round).
   */
  withdrawAskedAt?: number
  /**
   * The vault whose Run this object was published from (ticket 19 review round 2): written when a publish
   * creates the object or sends it again. Post-work opens on its own only for the Run in this vault. A row
   * written before this was kept has none, and never opens on its own until it is published again. Read
   * leniently: anything but a non-empty string is no vault.
   */
  vaultRoot?: string
  /**
   * The id of that vault when it was published from (written beside `vaultRoot` when `vaultIdAt` is wired). A
   * timed pull goes ahead only while the vault at `vaultRoot` still has this id: a different vault opened at the
   * same folder is never written. A row with none (written before this was kept) is checked against the id the
   * vault at its root had when the pull started. Read leniently, as `vaultRoot`.
   */
  vaultId?: string
  /**
   * Responses (answers and questions) the Worker holds after `cursor`, as its last count said (2026-10-19
   * prework-responses, decision 13): counted on the timer, pulled only when the Run is opened. Cleared by a pull.
   */
  waiting?: number
  /** When the Run last pulled this phase's answers (ms): the Run page's "Pulled 09:12". */
  pulledAt?: number
}

/**
 * The vault a Run is read and written in, as a caller resolved it: its root, and a check asked again just before
 * each write (after the queue and the network waits) that it is still the same open, writable vault.
 */
export type RunVault = string | { root: string; stillWritable(): boolean }

/** Said when the Run's vault was closed, moved or replaced while answers were on their way: nothing was written. */
export const RUN_VAULT_GONE = 'That Run\'s vault is not open on this computer, so nothing was changed.'

/** Said when the answers belong to the same Run in another vault (a copied vault): nothing was read or written. */
export const RUN_VAULT_OTHER = 'These answers belong to the same Run in another vault, so nothing was changed here.'

export interface RunPreworkDeps {
  /** {userData}/run-prework-registry.json */
  registryPath: string
  /** Where the objects' owner tokens are kept (the secrets store). */
  ownerTokens: OwnerTokens
  /** The live Worker and its admin credential. Used to CREATE objects only. */
  endpoint(): Promise<AdminEndpoint>
  /** The current vault's root: where a Run is read and written when the caller names no vault. */
  vaultRoot(): string | null
  /**
   * A vault root a row records (the vault the Run was published from), as a root writes may go to now: the
   * root while that vault is open and its folder is there, else null. The timer's pulls use it, so a Run of
   * another open vault is pulled into that vault; without it every pull goes to `vaultRoot()`.
   */
  writableVault?(root: string): string | null
  /**
   * The id of the open, available vault whose root is exactly `root`, else null. Every pull records it with the
   * root when it starts and asks again just before it writes: the same id at the same root, or nothing is
   * written. Without it (older tests) only the root is checked.
   */
  vaultIdAt?(root: string): string | null
  fetch: typeof fetch
  now?(): number
}

/** What a window may see: never the owner token. */
export interface RunPreworkState {
  preworkId: string
  phase: Phase
  opensAt: number
  closesAt: number
  closedAt?: number
  /** Deleted on the service after 60 days without activity; History says so without asking it. */
  purgedAt?: number
  withdrawnAt?: number
  /** A withdraw was asked for and not answered as done: the phase may be withdrawn on the Worker. */
  withdrawAskedAt?: number
  /** The vault the object was last published from; absent when the row records none. */
  vaultRoot?: string
  /** Responses waiting on the service, not pulled yet (the timer's last count); absent when none were counted. */
  waiting?: number
  /** When the answers were last pulled onto the Run. */
  pulledAt?: number
}

/** What a push of a new window did: whether the phase now takes answers again. */
export type RunWorkWindowPush =
  | { ok: true; phase: Phase; opensAt: number; closesAt: number; closedAt?: number; unchanged?: true }
  | { ok: false; phase: Phase; error: string }

/**
 * What `openWhenEnded` did: a window push, or `declined` when the caller, asked inside the row's turn,
 * said the opening is no longer owed (nothing was sent).
 */
export type PostWorkOpenPush = RunWorkWindowPush | { ok: true; phase: 'post'; declined: true }

/** `error` is always one of this module's fixed sentences; what the service said is only `details`, cleaned. */
export type RunWorkWithdraw = { ok: true; withdrawn: boolean } | { ok: false; error: string; details?: string }

/** The end of a service's reply kept for "Details": no owner token, no control characters. */
const WITHDRAW_DETAILS_CHARS = 600
function withdrawDetails(text: string, ownerToken: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const cleaned = (ownerToken ? text.split(ownerToken).join('[owner key]') : text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return cleaned ? cleaned.slice(-WITHDRAW_DETAILS_CHARS) : undefined
}
async function replyText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown; code?: unknown } }
    return [body?.error?.code, body?.error?.message].filter((part) => typeof part === 'string' && part).join(': ')
  } catch { return '' }
}

export const PREWORK_LOCKED = 'This Run already has pre-work, but its key cannot be read from this computer\'s secure storage just now. Nothing was changed. Try again.'
export const PREWORK_NOT_KEPT = 'Pre-work could not be saved on this computer, so it was closed again and nothing was put on the handout.'
export const PREWORK_NOT_KEPT_OPEN = 'Pre-work could not be saved on this computer and could not be closed again. It has no form and cannot be reached from this app.'
export const PREWORK_FORM_NOT_REACHED = 'The pre-work service could not be reached, so the form was not sent. Try again.'
export const PREWORK_WITHDRAW_NOT_NOTED = 'Pre-work could not be withdrawn: this computer could not note the request first, so it was not sent. Nothing was changed. Try again.'
export const PREWORK_PURGED_MESSAGE = 'Pre-work was deleted after 60 days without activity; the answers already pulled stay on the Run.'

export type RunPreworkPull =
  | { ok: true; run: RunRecord; added: number; changed: boolean }
  | { ok: false; error: string; run?: RunRecord }

interface RegistryFile { version: 1; preworks: Record<string, RunPreworkRow> }

/** How often the timer pulls while pre-work is open, and how long after closing it still pulls. */
export const PREWORK_PULL_INTERVAL_MS = 5 * 60_000
export const PREWORK_PULL_GRACE_MS = 30 * 60_000
/** Pages a single pull may read (500 entries each). */
const MAX_PAGES = 200

/**
 * The registry key of a Run's phase in a vault: `<talk>/<run>@<vault>` for pre-work, `<talk>/<run>#post@<vault>` for
 * post-work, where `<vault>` is the vault's part (`vaultKeyPart`), URI-encoded so it holds no `/`, `#` or `@` (a run id
 * holds none of them either). Two open vaults holding the same talk and Run id (a copied vault) have two rows, two
 * objects and two forms (issue 256). Without a vault the key is `<talk>/<run>` (`#post`) as 0.37 to 0.41.0 wrote it:
 * such a row is still read, by the one vault that owns it, and a publish moves it under that vault's key.
 */
export function runPreworkKey(talkSlug: string, runId: string, phase: Phase = 'pre', vault?: string | null): string {
  const base = phase === 'post' ? `${talkSlug}/${runId}#post` : `${talkSlug}/${runId}`
  return vault ? `${base}@${encodeURIComponent(vault)}` : base
}

/** A vault's part of a registry key: its id (`id:<id>`) when vault ids are known, else its resolved root (`root:<root>`). */
export function vaultKeyPart(vault: { id: string } | { root: string }): string {
  return 'id' in vault ? `id:${vault.id}` : `root:${resolvePath(vault.root)}`
}

/** The vault a row records, or null: anything but a non-empty string (a row from before it was kept) is none. */
function rowVault(row: Pick<RunPreworkRow, 'vaultRoot'>): string | null {
  return typeof row.vaultRoot === 'string' && row.vaultRoot ? row.vaultRoot : null
}
function rowVaultId(row: Pick<RunPreworkRow, 'vaultId'>): string | null {
  return typeof row.vaultId === 'string' && row.vaultId ? row.vaultId : null
}

/**
 * The Run, phase and vault part (absent on a key from before keys named the vault) a registry key names, or null.
 * A talk slug holds no `/`; a run id holds no `#`, `/` or `@`.
 */
export function parseRunPreworkKey(key: string): { talkSlug: string; runId: string; phase: Phase; vault?: string } | null {
  const slash = key.indexOf('/')
  if (slash <= 0) return null
  let rest = key.slice(slash + 1)
  let vault: string | null = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    try { vault = decodeURIComponent(rest.slice(at + 1)) } catch { return null }
    if (!vault) return null
    rest = rest.slice(0, at)
  }
  const post = rest.endsWith('#post')
  const runId = post ? rest.slice(0, -'#post'.length) : rest
  if (!runId || runId.includes('#') || runId.includes('/')) return null
  return { talkSlug: key.slice(0, slash), runId, phase: post ? 'post' : 'pre', ...(vault ? { vault } : {}) }
}

/** The row's phase: pre-work unless it says post. */
export function rowPhase(row: Pick<RunPreworkRow, 'phase'>): Phase {
  return row.phase === 'post' ? 'post' : 'pre'
}

/** A message written for pre-work, said of the phase it is about. */
function said(phase: Phase, text: string): string {
  return phase === 'post' ? text.replace(/Pre-work/g, 'Post-work').replace(/pre-work/g, 'post-work') : text
}

/** The phase a window asked about: absent is pre-work (as 0.37 asked); anything but pre or post is null. */
export function phaseOf(value: unknown): Phase | null {
  return value === undefined || value === null || value === 'pre' ? 'pre' : value === 'post' ? 'post' : null
}

/**
 * A phase's window as the Worker takes it (ms), from the Run's attachment: wall-clock times in the
 * attachment's zone. Post-work that opens when the session ends keeps the opening it was pushed with
 * (`openedAt`); before then it has none. Null when it cannot be read or closes before it opens.
 */
export function workWindowMs(work: Pick<RunWork, 'opens' | 'closes' | 'timeZone'> & { problem?: string }, openedAt?: number): { opensAt: number; closesAt: number } | null {
  if (work.problem) return null
  const opensAt = work.opens === SESSION_END ? openedAt : zonedLocalToMs(work.opens, work.timeZone)
  const closesAt = zonedLocalToMs(work.closes, work.timeZone)
  return Number.isSafeInteger(opensAt) && Number.isSafeInteger(closesAt) && closesAt > Number(opensAt) ? { opensAt: Number(opensAt), closesAt } : null
}

// Post-work waiting for the session's end is sent `notYetOpenedWindow`; the session's end pushes the real
// opening (ticket 19, post-work-opening.ts). Kept importable from here, as ticket 16 used them.
export { isNotYetOpenedWindow, notYetOpenedWindow }

/**
 * The window to push for a phase: its own times; post-work that opens when the session ends keeps the
 * opening it was pushed with (`pushed`, the row's), and before it has one it gets `notYetOpenedWindow`.
 * Null when the times cannot be read or close before they open.
 */
export function workPushWindowMs(work: Pick<RunWork, 'opens' | 'closes' | 'timeZone'> & { problem?: string }, pushed?: { opensAt: number; closesAt: number } | null): { opensAt: number; closesAt: number } | null {
  if (work.problem) return null
  if (work.opens !== SESSION_END) return workWindowMs(work)
  if (pushed && !isNotYetOpenedWindow(pushed)) return workWindowMs(work, pushed.opensAt)
  const closesAt = zonedLocalToMs(work.closes, work.timeZone)
  return Number.isSafeInteger(closesAt) && closesAt > 1 ? notYetOpenedWindow(closesAt) : null
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch { return false }
}

/** A row's `waiting` or `pulledAt`, read leniently: a positive whole number, else none. */
const countField = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0

function validRow(value: unknown): value is RunPreworkRow {
  const row = value as RunPreworkRow
  if (!row || typeof row.key !== 'string' || (row.phase !== undefined && row.phase !== 'post')) return false
  // The key names the row's own phase: a post-work row is never read as a Run's pre-work, or the reverse.
  const named = parseRunPreworkKey(row.key)
  return Boolean(named) && named!.phase === rowPhase(row) && isShareId(row.preworkId) && validOwnerToken(row.ownerToken) && validOrigin(row.workerBaseUrl)
    && Number.isSafeInteger(row.opensAt) && Number.isSafeInteger(row.closesAt) && Number.isSafeInteger(row.cursor) && row.cursor >= 0
    && (row.closedAt === undefined || Number.isSafeInteger(row.closedAt))
    && (row.purgedAt === undefined || Number.isSafeInteger(row.purgedAt))
    && (row.withdrawnAt === undefined || Number.isSafeInteger(row.withdrawnAt))
    && (row.withdrawAskedAt === undefined || Number.isSafeInteger(row.withdrawAskedAt))
}

/**
 * Where a push left the window: the Worker's status after the push says when it closes now. Earlier
 * than the closing time pushed means it is still closed early (an admin's close, or the owner's with
 * no later closing time); otherwise no early close is left. A Worker that does not say keeps what the
 * row knew (`known`).
 */
async function closedAfterPush(response: Response, closesAt: number, known: number | undefined): Promise<number | undefined> {
  try {
    const body = await response.json() as { status?: { closesAt?: unknown } }
    const effective = body?.status?.closesAt
    if (!Number.isSafeInteger(effective)) return known
    return Number(effective) < closesAt ? Number(effective) : undefined
  } catch { return known }
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } }
    return body?.error?.message || fallback
  } catch { return fallback }
}

export function createRunPrework(deps: RunPreworkDeps) {
  const now = deps.now ?? Date.now
  // The registry file holds no owner token: each row gets its token from the secrets store here.
  const registryFile = openOwnerTokenRegistry('run-prework', deps.registryPath, deps.ownerTokens)

  function read(): RegistryFile {
    const registry: RegistryFile = { version: 1, preworks: {} }
    for (const [key, row] of Object.entries(registryFile.read())) if (validRow(row) && row.key === key) registry.preworks[key] = row
    return registry
  }

  /** The file holds a row under this key that cannot be used because secure storage cannot be read just now. */
  function lockedAt(key: string | null): boolean {
    return key !== null && registryFile.idAt(key) !== null && !deps.ownerTokens.readable()
  }

  /** One operation at a time per Run and phase: publish, push, pull, close and withdraw never interleave. */
  const queue = createKeyedQueue()

  /**
   * Add or change this one row; every other row in the file stays as it is. `seen` is the id of the
   * row this operation saw under the key (null: none): the write happens only if that is still what
   * the file holds. `seenAt`: where that row is when it is not under the row's own key (a row from
   * before keys named the vault): it must still be there, and it is replaced.
   */
  function save(row: RunPreworkRow, seen: string | null, seenAt: string = row.key): void {
    if (seenAt !== row.key) {
      registryFile.write({ [row.key]: row }, { expect: { [row.key]: null, [seenAt]: seen }, ...(seen !== null ? { remove: [seenAt] } : {}) })
      return
    }
    registryFile.write({ [row.key]: row }, { expect: { [row.key]: seen }, ...(seen !== null && seen !== row.preworkId ? { remove: [row.key] } : {}) })
  }

  /**
   * Change the object's own row as it is now (a field patched to undefined is dropped). False, and
   * nothing written, when that row is no longer there. `moveTo`: the key the row belongs under now (its
   * vault's): a row still under a key from before keys named the vault is moved there, or, if the move
   * cannot be written, changed where it is.
   */
  function update(row: RunPreworkRow, patch: Partial<RunPreworkRow>, moveTo?: string): boolean {
    const current = read().preworks[row.key]
    if (!current || current.preworkId !== row.preworkId) return false
    const next = { ...current, ...patch }
    for (const field of Object.keys(next) as Array<keyof RunPreworkRow>) if (next[field] === undefined) delete next[field]
    if (moveTo && moveTo !== row.key) {
      try {
        save({ ...next, key: moveTo }, row.preworkId, row.key)
        return true
      } catch { /* left where it is: still read there, by its own vault */ }
    }
    save(next, row.preworkId)
    return true
  }

  /**
   * The vault part of the registry key for a vault root: its id when vault ids are known (null when no open vault
   * has that root), else the resolved root.
   */
  const keyPartOf = (root: string): string | null => {
    if (!deps.vaultIdAt) return vaultKeyPart({ root })
    const id = deps.vaultIdAt(root)
    return id ? vaultKeyPart({ id }) : null
  }

  /**
   * Where a Run's phase is kept for a vault: `key`, the vault's own key (operations on it queue under it), and
   * `legacy`, the key a row from before keys named the vault would be under. With no vault at all (nothing named
   * and no current vault) the key is the one with no vault. Null when the root is no open vault's.
   */
  type Slot = { key: string; legacy: string | null; root: string | null; id: string | null }
  const slotIn = (talkSlug: string, runId: string, phase: Phase, root: string | null): Slot | null => {
    const bare = runPreworkKey(talkSlug, runId, phase)
    if (!root) return { key: bare, legacy: null, root: null, id: null }
    const part = keyPartOf(root)
    if (part === null) return null
    return { key: runPreworkKey(talkSlug, runId, phase, part), legacy: bare, root, id: deps.vaultIdAt ? deps.vaultIdAt(root) : null }
  }
  /** The slot of a Run in the vault a caller names (`RunVault`, a root) or, naming none, the current vault. */
  const slotFor = (talkSlug: string, runId: string, phase: Phase, given?: RunVault | null): Slot | null =>
    slotIn(talkSlug, runId, phase, runVault(given)?.root ?? null)

  /**
   * Whether a row from before keys named the vault (under `<talk>/<run>`) belongs to the slot's vault: the vault id
   * it records, else the root it records. One vault at most owns it, so a copied vault never reads or replaces
   * another vault's object through it. A row that records neither (published before rows kept their vault) has NO
   * owner: which vault is current says nothing about which vault published it (the first vault changes when one is
   * closed), and nothing in a vault names the object (a copied vault holds the same Run). It is never withdrawn,
   * reused, pushed to or pulled by any vault; publishing makes the vault an object of its own, and the old row is
   * left as it is (`ownerUnknown`: the Run page and Unpublish say so).
   */
  const ownsLegacy = (value: unknown, slot: Slot): boolean => {
    if (!slot.root || !value || typeof value !== 'object') return false
    const row = value as Partial<RunPreworkRow>
    const id = rowVaultId(row)
    if (id !== null && deps.vaultIdAt) return id === slot.id
    const owner = rowVault(row)
    return owner !== null && resolvePath(owner) === resolvePath(slot.root)
  }
  /** A row from before keys named the vault that records no vault at all (see ownsLegacy: no vault owns it). */
  const unownedLegacy = (value: unknown): boolean => !!value && typeof value === 'object'
    && rowVaultId(value as Partial<RunPreworkRow>) === null && rowVault(value as Partial<RunPreworkRow>) === null

  /** The slot's usable row: under its own key, else a row from before keys named the vault that this vault owns. */
  const rowAt = (slot: Slot): RunPreworkRow | null => {
    const rows = read().preworks
    if (rows[slot.key]) return rows[slot.key]
    if (slot.legacy && rows[slot.legacy] && ownsLegacy(rows[slot.legacy], slot)) return rows[slot.legacy]
    return null
  }
  /** The key the file holds the slot's row under, usable or not (secure storage locked, the token gone), or null. */
  const fileKeyAt = (slot: Slot): string | null => {
    if (registryFile.idAt(slot.key) !== null) return slot.key
    if (slot.legacy && registryFile.idAt(slot.legacy) !== null && ownsLegacy(registryFile.read()[slot.legacy], slot)) return slot.legacy
    return null
  }

  function state(row: RunPreworkRow): RunPreworkState {
    return { preworkId: row.preworkId, phase: rowPhase(row), opensAt: row.opensAt, closesAt: row.closesAt, ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}),
      ...(row.purgedAt !== undefined ? { purgedAt: row.purgedAt } : {}), ...(row.withdrawnAt !== undefined ? { withdrawnAt: row.withdrawnAt } : {}),
      ...(row.withdrawAskedAt !== undefined ? { withdrawAskedAt: row.withdrawAskedAt } : {}), ...(rowVault(row) ? { vaultRoot: rowVault(row)! } : {}),
      ...(countField(row.waiting) ? { waiting: row.waiting! } : {}), ...(countField(row.pulledAt) ? { pulledAt: row.pulledAt! } : {}) }
  }

  /** Every request that carries the object's owner token: a failure to send is a fixed sentence (ownerFetch). */
  const asOwner = (row: RunPreworkRow, path: string, init: RequestInit) => ownerFetch(deps.fetch, `${row.workerBaseUrl}/prework/${row.preworkId}/${path}`, row.ownerToken, init)

  /** What to say when the Run has no usable row for the phase. */
  const noRow = (slot: Slot, phase: Phase, missing: string) => said(phase, lockedAt(fileKeyAt(slot)) ? PREWORK_LOCKED : missing)

  /** A Run reference that cannot name a Run: refused before any registry row is read, so nothing is touched. */
  const BAD_REF = 'That is not a Run of this vault.'
  const badRef = (talkSlug: string, runId: string): boolean => !isSafeTalkSlug(talkSlug) || !isSafeRunId(runId)

  /**
   * The vault a Run is read and written in, and how to ask again, just before a write, whether it still may be
   * written: the one the caller named (a `RunVault` carries its own check: the same vault id at the same root,
   * open and there), a bare root (checked through `writableVault`), else the current vault (checked to be still
   * the current one).
   */
  /** The id of the vault at root now, and whether it is still that one: same id (never none) at the same root. */
  const idAt = (root: string): string | null => (deps.vaultIdAt ? deps.vaultIdAt(root) : null)
  const sameId = (root: string, id: string | null): boolean => !deps.vaultIdAt || (id !== null && deps.vaultIdAt(root) === id)
  /** A bare root, its vault's id fixed now (or the one a row expects), checked through writableVault before a write. */
  const rootVault = (root: string, id: string | null = idAt(root)): { root: string; stillWritable(): boolean } => ({
    root, stillWritable: () => (deps.writableVault ? deps.writableVault(root) === root : true) && sameId(root, id),
  })
  const runVault = (given?: RunVault | null): { root: string; stillWritable(): boolean } | null => {
    if (given && typeof given === 'object') return given.root ? given : null
    if (typeof given === 'string' && given) return rootVault(given)
    const root = deps.vaultRoot()
    if (!root) return null
    const id = idAt(root)
    return { root, stillWritable: () => deps.vaultRoot() === root && sameId(root, id) }
  }

  /**
   * Whether a row's object may be pulled into `root`: the same root and, when recorded, the same vault id there now.
   * A row with no recorded root (written by a preview before 15 October 2026) is refused; the Run is published again to record its vault.
   */
  const rowBelongsTo = (row: RunPreworkRow, root: string): boolean => {
    const owner = rowVault(row)
    if (owner === null) return false
    if (resolvePath(owner) !== resolvePath(root)) return false
    const recorded = rowVaultId(row)
    return recorded === null || !deps.vaultIdAt || deps.vaultIdAt(root) === recorded
  }

  async function pullNow(talkSlug: string, runId: string, phase: Phase, given?: RunVault | null): Promise<RunPreworkPull> {
    if (badRef(talkSlug, runId)) return { ok: false, error: BAD_REF }
    const field = phase === 'post' ? 'postwork' : 'prework'
    const vault = runVault(given)
    const vaultRoot = vault?.root ?? null
    const before = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
    if (!vaultRoot || !before) return { ok: false, error: 'This Run is no longer in the vault.' }
    // This vault's own row (issue 256): the same talk and Run id in another vault is another row.
    const slot = slotIn(talkSlug, runId, phase, vaultRoot)
    if (!slot) return { ok: false, error: RUN_VAULT_GONE, run: before }
    const row = rowAt(slot)
    if (!row) return { ok: false, error: noRow(slot, phase, 'This Run has no pre-work on the handout yet.'), run: before }
    if (row.purgedAt !== undefined) return { ok: false, error: said(phase, PREWORK_PURGED_MESSAGE), run: before }
    // The row's object belongs to the vault it was published from. A copied vault can hold the same talk and Run
    // id: its pull must never read that object and write its answers here. Checked before any request, for every
    // caller (the timer, the Run page, the board seed): the recorded root must be this one and, when a vault id
    // was recorded, the vault at this root must have it. Refused, the reply is the same shape as an offline pull
    // (the board seed reads the Run from disk). A row recorded before vaults were kept (no root) is refused: nothing
    // records which vault it came from. Publishing the Run again records it.
    if (!rowBelongsTo(row, vaultRoot)) return { ok: false, error: RUN_VAULT_OTHER, run: before }
    // A Run that lost its copy (edited by hand) is mirrored again from the start.
    let after = before[field] ? row.cursor : 0
    const entries: unknown[] = []
    let meta: { people?: number; lastActivityAt?: number; seq?: number; closedAt?: number | null } = {}
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let response: Response
      try {
        response = await asOwner(row, `results?after=${after}`, { signal: AbortSignal.timeout(15_000) })
      } catch {
        return { ok: false, error: said(phase, 'The pre-work service could not be reached. Try again.'), run: before }
      }
      if (response.status === 410) {
        update(row, { purgedAt: now() })
        return { ok: false, error: said(phase, PREWORK_PURGED_MESSAGE), run: before }
      }
      if (!response.ok) return { ok: false, error: await errorText(response, `The answers could not be read (HTTP ${response.status}).`), run: before }
      type PullBody = { entries?: unknown; more?: unknown; seq?: unknown; people?: unknown; lastActivityAt?: unknown; phase?: unknown; closedAt?: unknown }
      let body: PullBody
      // A 2xx whose body is not JSON (a proxy's page, a cut-off reply) is an unreadable answer, not a throw.
      try { body = await response.json() as PullBody } catch { return { ok: false, error: said(phase, 'The pre-work service answered with something unreadable.'), run: before } }
      if (!body || typeof body !== 'object') return { ok: false, error: said(phase, 'The pre-work service answered with something unreadable.'), run: before }
      if (!Array.isArray(body.entries)) return { ok: false, error: said(phase, 'The pre-work service answered with something unreadable.'), run: before }
      // The object holds the other phase's work: none of it lands in this phase's section.
      if ((body.phase === 'pre' || body.phase === 'post') && body.phase !== phase) {
        return { ok: false, error: said(phase, 'The pre-work service holds other work under this Run\'s pre-work. Nothing was copied to the Run.'), run: before }
      }
      let last = after
      for (const entry of body.entries) {
        const seq = (entry as { seq?: unknown } | null)?.seq
        if (Number.isSafeInteger(seq) && Number(seq) > last) last = Number(seq)
        entries.push(entry)
      }
      meta = {
        ...(Number.isSafeInteger(body.people) ? { people: Number(body.people) } : {}),
        ...(Number.isSafeInteger(body.lastActivityAt) ? { lastActivityAt: Number(body.lastActivityAt) } : {}),
        ...(Number.isSafeInteger(body.seq) ? { seq: Number(body.seq) } : {}),
        // Whether it is closed early, as the Worker says: null once a later closing time reopened it.
        ...(Number.isSafeInteger(body.closedAt) ? { closedAt: Number(body.closedAt) } : body.closedAt === null ? { closedAt: null } : {}),
      }
      if (body.more !== true || last === after) { after = last; break }
      after = last
    }
    const closedAt = meta.closedAt !== undefined ? meta.closedAt : row.closedAt ?? null
    // The vault was found before the queue and the network waits: it may have been closed, moved or replaced
    // since. Asked again here, with nothing awaited between this and the write; if it is not the same open,
    // writable vault, nothing is written and the cursor stays (the answers are read again next time).
    if (!vault || !vault.stillWritable()) return { ok: false, error: RUN_VAULT_GONE, run: before }
    // Read, merge and write with nothing awaited in between: the atomic Run writer, from a fresh read.
    const current = readRunForTalk(vaultRoot, talkSlug, runId)
    if (!current) return { ok: false, error: 'This Run is no longer in the vault.' }
    const merged = applyRunWorkAnswers(current, phase, entries, { people: meta.people, lastActivityAt: meta.lastActivityAt, closedAt })
    let saved: RunRecord
    try {
      saved = merged === current ? current : persistRunForTalk(vaultRoot, talkSlug, runId, merged)
    } catch {
      // Not written: the cursor stays where it was, so the same answers are read again next time.
      return { ok: false, error: 'The answers could not be saved to the Run. They will be read again next time.', run: current }
    }
    // Only now that the Run is written does the cursor move (and the close the Worker reported).
    // Pulled now: the count of what is waiting starts again from the new cursor.
    const patch: Partial<RunPreworkRow> = { pulledAt: now(), waiting: undefined }
    if (after !== row.cursor) patch.cursor = after
    if ((closedAt ?? undefined) !== row.closedAt) patch.closedAt = closedAt ?? undefined
    // A registry that cannot be written leaves the cursor behind: the next pull merges the same entries by id.
    try { update(row, patch) } catch { /* read again next time */ }
    const count = (run: RunRecord) => run[field]?.entries.length ?? 0
    return { ok: true, run: saved, added: Math.max(0, count(saved) - count(before)), changed: merged !== current }
  }

  /** `vaultRoot`: the Run's own vault (the caller resolved it from the Run's reference); none: the current vault. */
  const pull = (talkSlug: string, runId: string, phase: Phase = 'pre', vaultRoot?: RunVault | null): Promise<RunPreworkPull> => {
    const slot = slotFor(talkSlug, runId, phase, vaultRoot)
    return queue.run(slot?.key ?? runPreworkKey(talkSlug, runId, phase), () => pullNow(talkSlug, runId, phase, vaultRoot))
  }

  /** Close an object on the service with its own token. True when the service confirms it is closed or gone. */
  async function closeRemote(row: RunPreworkRow): Promise<boolean> {
    try {
      const response = await asOwner(row, 'close', { method: 'POST', signal: AbortSignal.timeout(10_000) })
      return response.ok || response.status === 410 || response.status === 404
    } catch { return false }
  }

  /** Push a new window (no form) for the phase. Inside the row's turn. */
  async function pushWindowNow(talkSlug: string, runId: string, phase: Phase, window: { opensAt: number; closesAt: number }, slot: Slot | null): Promise<RunWorkWindowPush> {
    if (badRef(talkSlug, runId)) return { ok: false, phase, error: BAD_REF }
    if (!slot) return { ok: false, phase, error: RUN_VAULT_GONE }
    const row = rowAt(slot)
    if (!row) return { ok: false, phase, error: noRow(slot, phase, 'This Run has no pre-work on the handout.') }
    if (row.purgedAt !== undefined) return { ok: false, phase, error: said(phase, PREWORK_PURGED_MESSAGE) }
    if (!Number.isSafeInteger(window.opensAt) || !Number.isSafeInteger(window.closesAt) || window.closesAt <= window.opensAt) {
      return { ok: false, phase, error: said(phase, 'Pre-work closes before it opens; fix the dates in the plan.') }
    }
    if (row.opensAt === window.opensAt && row.closesAt === window.closesAt) {
      return { ok: true, phase, opensAt: row.opensAt, closesAt: row.closesAt, ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}), unchanged: true }
    }
    let response: Response
    try {
      response = await asOwner(row, 'form', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase, opensAt: window.opensAt, closesAt: window.closesAt }), signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return { ok: false, phase, error: said(phase, 'The pre-work service could not be reached, so the new times were not sent. Try again.') }
    }
    if (response.status === 404 || response.status === 410) {
      update(row, { purgedAt: row.purgedAt ?? now() })
      return { ok: false, phase, error: said(phase, PREWORK_PURGED_MESSAGE) }
    }
    if (!response.ok) return { ok: false, phase, error: await errorText(response, `The new times could not be sent (HTTP ${response.status}).`) }
    const closedAt = await closedAfterPush(response, window.closesAt, row.closedAt)
    update(row, { opensAt: window.opensAt, closesAt: window.closesAt, closedAt })
    return { ok: true, phase, opensAt: window.opensAt, closesAt: window.closesAt, ...(closedAt !== undefined ? { closedAt } : {}) }
  }

  /**
   * Every row open now (or closed within the grace period), with the key it is under and the key its operations queue
   * under (its vault's: for a row from before keys named the vault, the vault it records, else the current vault).
   * A row from before keys named the vault that records no vault at all is no vault's (ownsLegacy): the timer
   * neither asks the service about it nor writes it.
   */
  const dueRows = (): Array<{ talkSlug: string; runId: string; phase: Phase; fileKey: string; queueKey: string }> => {
    const at = now()
    return Object.entries(read().preworks).flatMap(([fileKey, row]) => {
      const closes = row.closedAt !== undefined ? Math.min(row.closedAt, row.closesAt) : row.closesAt
      if (row.purgedAt !== undefined || at < row.opensAt || at > closes + PREWORK_PULL_GRACE_MS) return []
      const named = parseRunPreworkKey(fileKey)
      if (!named) return []
      if (!named.vault && unownedLegacy(row)) return []
      const queueKey = named.vault ? fileKey : slotIn(named.talkSlug, named.runId, named.phase, rowVault(row) ?? deps.vaultRoot())?.key ?? fileKey
      return [{ talkSlug: named.talkSlug, runId: named.runId, phase: named.phase, fileKey, queueKey }]
    })
  }

  /** `vault`: the Run's own vault (none: the current vault). */
  const pushWindow = (talkSlug: string, runId: string, phase: Phase, window: { opensAt: number; closesAt: number }, vault?: RunVault | null): Promise<RunWorkWindowPush> => {
    const slot = slotFor(talkSlug, runId, phase, vault)
    return queue.run(slot?.key ?? runPreworkKey(talkSlug, runId, phase), () => pushWindowNow(talkSlug, runId, phase, window, slot))
  }

  return {
    /** The Run's object for the phase in its vault (`vault`; none: the current vault), or null when it has none. */
    status(talkSlug: string, runId: string, phase: Phase = 'pre', vault?: RunVault | null): RunPreworkState | null {
      if (badRef(talkSlug, runId)) return null
      const slot = slotFor(talkSlug, runId, phase, vault)
      const row = slot ? rowAt(slot) : null
      return row ? state(row) : null
    },

    /**
     * Push the form and window for the Run's phase, creating its object on first use. Returns what the
     * handout needs to ask about it (`open: false` when the object is gone: the handout carries no
     * form) and a warning when it stays closed. The phase's existing object is always reused: a
     * republish never starts a new one. Throws with a readable message on failure (publishing stops).
     * `vaultRoot`: the vault the Run is published from, recorded on the row with the push (ticket 19
     * review round 2); left out, the row keeps the vault it records.
     */
    publish(talkSlug: string, runId: string, form: PreworkForm, window: { opensAt: number; closesAt: number }, phase: Phase = 'pre', vaultRoot?: string):
      Promise<{ preworkId: string; workerBaseUrl: string; open: boolean; warning?: string }> {
      // The id goes with the root (or is cleared, never left from an earlier vault): see RunPreworkRow.vaultId.
      const owner = typeof vaultRoot === 'string' && vaultRoot ? { vaultRoot, vaultId: idAt(vaultRoot) ?? undefined } : {}
      if (badRef(talkSlug, runId)) return Promise.reject(new Error(BAD_REF))
      // The vault's own row (issue 256): a copied vault with the same talk and Run id never reuses, replaces or
      // pushes a form to this vault's object, nor this one to its.
      const slot = slotFor(talkSlug, runId, phase, vaultRoot)
      if (!slot) return Promise.reject(new Error(RUN_VAULT_GONE))
      const key = slot.key
      return queue.run(key, async () => {
      // Asked before the rows are read, so a row read without its token is known to be for good.
      const storeReadable = deps.ownerTokens.readable()
      const create = async (): Promise<RunPreworkRow> => {
        // The Run has a row this cannot use. While secure storage cannot be read that row is a
        // working object whose token is out of reach: it is left alone and no second one is made.
        const seenAt = fileKeyAt(slot) ?? key
        const seen = registryFile.idAt(seenAt)
        if (seen !== null && !storeReadable) throw new Error(said(phase, PREWORK_LOCKED))
        // An object whose owner token could not be kept is never made: its answers could not be read.
        registryFile.assertCanStore()
        const endpoint = await deps.endpoint()
        const origin = new URL(endpoint.baseUrl).origin
        // Each key held for the live service is tried, as Go live does (live-admin-request.ts).
        const { response, refused } = await sendAsAdmin(deps.fetch, endpoint, `${origin}/prework`, () => ({
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(15_000),
        }))
        if (refused) throw new Error(LIVE_ACCESS_REMOVED)
        if (!response.ok) throw new Error(await errorText(response, said(phase, `Pre-work could not be set up (HTTP ${response.status}).`)))
        const created = await response.json() as { preworkId?: unknown; ownerToken?: unknown }
        const candidate = { key, preworkId: created.preworkId, ownerToken: created.ownerToken, workerBaseUrl: origin, ...(phase === 'post' ? { phase } : {}),
          opensAt: window.opensAt, closesAt: window.closesAt, cursor: 0, createdAt: now(), ...owner }
        if (!validRow(candidate)) throw new Error(said(phase, 'The pre-work service returned an incomplete answer.'))
        // Stored (and read back) before the form is pushed. If that fails the object is closed while
        // its token is still here: nothing is left on the service that this app cannot reach.
        try {
          save(candidate, seen, seenAt) // the dead row this saw is replaced; any other row is not
        } catch {
          throw new Error(said(phase, await closeRemote(candidate) ? PREWORK_NOT_KEPT : PREWORK_NOT_KEPT_OPEN))
        }
        return candidate
      }
      const push = async (row: RunPreworkRow): Promise<Response> => {
        try {
          return await asOwner(row, 'form', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phase, opensAt: window.opensAt, closesAt: window.closesAt, form }), signal: AbortSignal.timeout(15_000),
          })
        } catch {
          throw new Error(said(phase, PREWORK_FORM_NOT_REACHED))
        }
      }
      const existing = rowAt(slot)
      // Known to be purged: say so without asking the Worker again.
      if (existing?.purgedAt !== undefined) return { preworkId: existing.preworkId, workerBaseUrl: existing.workerBaseUrl, open: false, warning: said(phase, PREWORK_PURGED_MESSAGE) }
      const row = existing ?? await create()
      // An object made here whose row is no longer registered could never be read or closed: close it now.
      const unregistered = async (): Promise<Error | null> => (existing || registryFile.idAt(key) === row.preworkId ? null
        : new Error(said(phase, await closeRemote(row) ? PREWORK_NOT_KEPT : PREWORK_NOT_KEPT_OPEN)))
      let response: Response
      try {
        response = await push(row)
      } catch (cause) {
        throw await unregistered() ?? cause
      }
      // Purged on the Worker (60 idle days after it closed) or gone from it: nothing is reopened
      // unasked. The handout goes out without the form; what the Run holds stays on the Run.
      if (existing && (response.status === 404 || response.status === 410)) {
        update(row, { purgedAt: row.purgedAt ?? now() })
        return { preworkId: row.preworkId, workerBaseUrl: row.workerBaseUrl, open: false, warning: said(phase, PREWORK_PURGED_MESSAGE) }
      }
      if (!response.ok) throw new Error(await errorText(response, said(phase, `The pre-work form could not be sent (HTTP ${response.status}).`)))
      // Still closed early after this push (an admin's close, or the owner's with no later closing
      // time), as the Worker says: kept on the row; otherwise no early close is left.
      const closedAt = await closedAfterPush(response, window.closesAt, row.closedAt)
      // A row from before keys named the vault moves under this vault's key with the push.
      if (!update(row, { opensAt: window.opensAt, closesAt: window.closesAt, closedAt, ...owner }, key)) {
        const gone = await unregistered()
        if (gone) throw gone
      }
      if (closedAt !== undefined) {
        return { preworkId: row.preworkId, workerBaseUrl: row.workerBaseUrl, open: true, warning: said(phase, 'Pre-work was closed; it stays closed.') }
      }
      return { preworkId: row.preworkId, workerBaseUrl: row.workerBaseUrl, open: true }
      })
    },

    /**
     * A new opening or closing time for a phase already sent, pushed without the form. A later closing
     * time reopens a phase that has closed, by its date or by the owner's early close (ADR-0040
     * decision 3); an admin's close stays. The row changes only once the Worker took the new window.
     */
    pushWindow,

    /**
     * Post-work that opens when the session ends (ticket 19): push its opening, but only while the
     * object still has the window that never opens, and only with the window `decide` gives. `decide` is
     * called INSIDE the row's turn, with the row as it is then: the caller reads its Run again there and
     * says whether the opening is still owed (null: not, and nothing is sent). So a pull holding the turn
     * while the post-work is removed or replaced, or the Run unpublished, never lets an older decision
     * through, and two callers (the session's end and the timer, say) never push two openings: the
     * second is told it is `unchanged`, with the opening already there. A pre-work row is refused.
     * An object holding an opening still to come (a set time changed to when the session ends, ticket 19
     * review round 2) is asked about too: `decide` may open it now.
     */
    openWhenEnded(talkSlug: string, runId: string, decide: (sent: RunPreworkState) => { opensAt: number; closesAt: number } | null, vault?: RunVault | null): Promise<PostWorkOpenPush> {
      const slot = slotFor(talkSlug, runId, 'post', vault)
      return queue.run(slot?.key ?? runPreworkKey(talkSlug, runId, 'post'), async (): Promise<PostWorkOpenPush> => {
        if (badRef(talkSlug, runId)) return { ok: false, phase: 'post', error: BAD_REF }
        if (!slot) return { ok: false, phase: 'post', error: RUN_VAULT_GONE }
        const row = rowAt(slot)
        if (!row || rowPhase(row) !== 'post') return { ok: false, phase: 'post', error: noRow(slot, 'post', 'This Run has no post-work on the handout.') }
        if (!isNotYetOpenedWindow(row) && row.opensAt <= now()) {
          return { ok: true, phase: 'post', opensAt: row.opensAt, closesAt: row.closesAt, ...(row.closedAt !== undefined ? { closedAt: row.closedAt } : {}), unchanged: true }
        }
        if (row.withdrawnAt !== undefined || row.withdrawAskedAt !== undefined) {
          return { ok: false, phase: 'post', error: 'Post-work was withdrawn when this Run was unpublished, so it was not opened.' }
        }
        let window: { opensAt: number; closesAt: number } | null = null
        try { window = decide(state(row)) } catch { window = null }
        if (!window) return { ok: true, phase: 'post', declined: true }
        return pushWindowNow(talkSlug, runId, 'post', window, slot)
      })
    },

    /**
     * Every Run with an object for the phase that is not gone from the service: the Runs post-work may open
     * for, each with the vault its row records (null: none).
     */
    sentRuns(phase: Phase): Array<{ talkSlug: string; runId: string; vaultRoot: string | null }> {
      return Object.values(read().preworks).flatMap((row) => {
        if (rowPhase(row) !== phase || row.purgedAt !== undefined) return []
        const named = parseRunPreworkKey(row.key)
        return named ? [{ talkSlug: named.talkSlug, runId: named.runId, vaultRoot: rowVault(row) }] : []
      })
    },

    /**
     * After the Run's plan changed: every phase this Run has sent whose window on the Run is not the
     * one last pushed gets the new one. Never throws; one result per phase pushed (or that could not
     * be read just now). Post-work that opens when the session ends keeps the opening it was sent with.
     */
    async syncWindows(talkSlug: string, runId: string, given?: RunVault | null): Promise<RunWorkWindowPush[]> {
      if (badRef(talkSlug, runId)) return []
      const results: RunWorkWindowPush[] = []
      for (const phase of ['pre', 'post'] as const) {
        try {
          // The Run's own vault's row (issue 256): never the same talk and Run id in another vault.
          const slot = slotFor(talkSlug, runId, phase, given)
          if (!slot) continue
          // The window is worked out inside the row's turn, from the row and the Run as they are then: an
          // opening pushed meanwhile (ticket 19) is kept, never pushed back to the window that never opens.
          const result = await queue.run(slot.key, async (): Promise<RunWorkWindowPush | null> => {
            const vaultRoot = runVault(given)?.root
            const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
            if (!run) return null
            const row = rowAt(slot)
            if (!row) return lockedAt(fileKeyAt(slot)) ? { ok: false, phase, error: said(phase, PREWORK_LOCKED) } : null
            const work = run.work?.[phase]
            const window = row.purgedAt === undefined && work ? workPushWindowMs(work, row) : null
            if (!window || (window.opensAt === row.opensAt && window.closesAt === row.closesAt)) return null
            return pushWindowNow(talkSlug, runId, phase, window, slot)
          })
          if (result) results.push(result)
        } catch (error) {
          results.push({ ok: false, phase, error: error instanceof Error ? error.message : said(phase, 'The new times could not be sent.') })
        }
      }
      return results
    },

    pull,

    /** "Close now": the Worker stops taking answers; then the last answers are pulled. */
    close(talkSlug: string, runId: string, phase: Phase = 'pre', vaultRoot?: RunVault | null): Promise<RunPreworkPull> {
      if (badRef(talkSlug, runId)) return Promise.resolve({ ok: false, error: BAD_REF })
      const slot = slotFor(talkSlug, runId, phase, vaultRoot)
      if (!slot) return Promise.resolve({ ok: false, error: RUN_VAULT_GONE })
      return queue.run(slot.key, async () => {
      const row = rowAt(slot)
      if (!row) return { ok: false, error: noRow(slot, phase, 'This Run has no pre-work on the handout.') }
      let response: Response
      try {
        response = await asOwner(row, 'close', { method: 'POST', signal: AbortSignal.timeout(10_000) })
      } catch {
        return { ok: false, error: said(phase, 'The pre-work service could not be reached, so pre-work is still open. Try again.') }
      }
      if (!response.ok && response.status !== 410) return { ok: false, error: await errorText(response, said(phase, 'The pre-work service did not close pre-work. Try again.')) }
      const body = await response.json().catch(() => ({})) as { closedAt?: unknown }
      const closedAt = Number.isSafeInteger(body.closedAt) ? Number(body.closedAt) : now()
      update(row, { closedAt })
      return pullNow(talkSlug, runId, phase, vaultRoot) // already inside this row's turn
      })
    },

    /**
     * Withdraw the phase (the Run unpublished: participants see "This page is not available"; the
     * answers stay and can still be pulled) or, with `withdrawn: false`, serve it again. Work that was
     * never sent, or is gone from the service, is already not available.
     */
    withdraw(talkSlug: string, runId: string, phase: Phase, withdrawn = true, vault?: RunVault | null): Promise<RunWorkWithdraw> {
      if (badRef(talkSlug, runId)) return Promise.resolve({ ok: false, error: BAD_REF })
      // The Run's own vault's object (issue 256): never the same talk and Run id in another vault.
      const slot = slotFor(talkSlug, runId, phase, vault)
      if (!slot) return Promise.resolve({ ok: false, error: RUN_VAULT_GONE })
      return queue.run(slot.key, async (): Promise<RunWorkWithdraw> => {
      const row = rowAt(slot)
      if (!row) {
        const held = fileKeyAt(slot)
        if (lockedAt(held)) return { ok: false, error: said(phase, PREWORK_LOCKED) }
        // A row is there but its key is not (secure storage readable, the key gone): the object may still be
        // serving, and nothing can reach it from here. Never "withdrawn".
        if (withdrawn && held !== null) return { ok: false, error: workKeyMissing(phase) }
        return withdrawn ? { ok: true, withdrawn: true } : { ok: false, error: said(phase, 'This Run has no pre-work on the handout.') }
      }
      if (row.purgedAt !== undefined) return withdrawn ? { ok: true, withdrawn: true } : { ok: false, error: said(phase, PREWORK_PURGED_MESSAGE) }
      // WRITTEN BEFORE IT IS ASKED: once the request has gone out the Worker may apply it even when its
      // answer never comes back, and Publish again must then still serve the phase again.
      if (withdrawn) {
        let noted = false
        try { noted = update(row, { withdrawAskedAt: now() }) } catch { noted = false }
        if (!noted) return { ok: false, error: said(phase, PREWORK_WITHDRAW_NOT_NOTED) }
      }
      let response: Response
      try {
        response = await asOwner(row, 'withdraw', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ withdrawn }), signal: AbortSignal.timeout(10_000),
        })
      } catch {
        return { ok: false, error: said(phase, 'The pre-work service could not be reached, so nothing was changed. Try again.') }
      }
      if (response.status === 404 || response.status === 410) {
        update(row, { purgedAt: now() })
        return withdrawn ? { ok: true, withdrawn: true } : { ok: false, error: said(phase, PREWORK_PURGED_MESSAGE) }
      }
      // NO RAW TEXT: the sentence is this module's; what the service said is Details only.
      if (!response.ok) {
        const details = withdrawDetails(await replyText(response), row.ownerToken)
        return { ok: false, error: said(phase, `Pre-work could not be changed (HTTP ${response.status}). Try again.`), ...(details ? { details } : {}) }
      }
      const body = await response.json().catch(() => ({})) as { withdrawnAt?: unknown }
      update(row, withdrawn
        ? { withdrawnAt: Number.isSafeInteger(body.withdrawnAt) ? Number(body.withdrawnAt) : now(), withdrawAskedAt: undefined }
        : { withdrawnAt: undefined, withdrawAskedAt: undefined })
      return { ok: true, withdrawn }
      })
    },

    /**
     * The phases this Run has an object for in the registry (sent at some time, whatever the Run's
     * attachments say now), including one whose key cannot be read just now. Unpublish withdraws these.
     */
    phasesSent(talkSlug: string, runId: string, vault?: RunVault | null): Phase[] {
      if (badRef(talkSlug, runId)) return []
      return (['pre', 'post'] as const).filter((phase) => {
        const slot = slotFor(talkSlug, runId, phase, vault)
        return slot !== null && fileKeyAt(slot) !== null
      })
    },

    /**
     * Whether the Run's phase in this vault has no object of its own while a row from before 0.41 that records no
     * vault is kept under its talk and Run id: published before rows kept their vault, by a vault this computer
     * cannot name. That object is never withdrawn, reused or pulled from here (ownsLegacy); the Run page and
     * Unpublish say so. False once the vault has an object of its own (publishing again makes one).
     */
    ownerUnknown(talkSlug: string, runId: string, phase: Phase, vault?: RunVault | null): boolean {
      if (badRef(talkSlug, runId)) return false
      const slot = slotFor(talkSlug, runId, phase, vault)
      if (!slot?.root || !slot.legacy || registryFile.idAt(slot.key) !== null || registryFile.idAt(slot.legacy) === null) return false
      return unownedLegacy(registryFile.read()[slot.legacy])
    },

    /**
     * Whether this computer can act as the owner of the phase's object: 'usable' (a row with its key),
     * 'locked' (a row whose key cannot be read just now) or 'none' (no row, or a row whose key is not in
     * secure storage). Unpublish asks this for every sent phase before it withdraws any.
     */
    ownerRecord(talkSlug: string, runId: string, phase: Phase, vault?: RunVault | null): 'usable' | 'locked' | 'none' {
      if (badRef(talkSlug, runId)) return 'none'
      const slot = slotFor(talkSlug, runId, phase, vault)
      if (!slot) return 'none'
      if (rowAt(slot)) return 'usable'
      return lockedAt(fileKeyAt(slot)) ? 'locked' : 'none'
    },

    /**
     * The Run page's own marks, written through the atomic Run writer from a fresh read (nothing
     * awaited between): which answers a step's board opens with, and History's marks on a question.
     * Returns the Run as written, or an error in words.
     */
    changePick(talkSlug: string, runId: string, stepId: string, change: unknown, phase: Phase = 'pre', given?: RunVault | null): { ok: true; run: RunRecord } | { ok: false; error: string } {
      if (badRef(talkSlug, runId)) return { ok: false, error: BAD_REF }
      const vault = runVault(given)
      if (vault && !vault.stillWritable()) return { ok: false, error: RUN_VAULT_GONE }
      const vaultRoot = vault?.root ?? null
      const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
      if (!vaultRoot || !run) return { ok: false, error: 'This Run is no longer in the vault.' }
      if (!stepId || stepId.length > 200) return { ok: false, error: 'That step is not on this Run.' }
      const value = (change ?? {}) as { type?: unknown; id?: unknown; by?: unknown; mode?: unknown }
      const parsed: PickChange | null = value.type === 'toggle' && typeof value.id === 'string' && value.id ? { type: 'toggle', id: value.id }
        : value.type === 'move' && typeof value.id === 'string' && (value.by === -1 || value.by === 1) ? { type: 'move', id: value.id, by: value.by }
        : value.type === 'mode' && (value.mode === 'picked' || value.mode === 'all') ? { type: 'mode', mode: value.mode }
        : null
      if (!parsed) return { ok: false, error: 'That choice could not be read.' }
      try {
        // One change, applied to the Run as it is now: two quick clicks are two changes and neither is lost.
        const next = setRunPreworkPick(run, stepId, applyPickChange(phase === 'post' ? run.postwork : run.prework, stepId, parsed), phase)
        return { ok: true, run: persistRunForTalk(vaultRoot, talkSlug, runId, next) }
      } catch (error) { return { ok: false, error: error instanceof Error && error.message === 'prework-not-found' ? said(phase, 'This Run has no pre-work answers yet.') : 'The Run could not be saved.' } }
    },

    markQuestion(talkSlug: string, runId: string, entryId: string, patch: unknown, phase: Phase = 'pre', given?: RunVault | null): { ok: true; run: RunRecord } | { ok: false; error: string } {
      if (badRef(talkSlug, runId)) return { ok: false, error: BAD_REF }
      const vault = runVault(given)
      if (vault && !vault.stillWritable()) return { ok: false, error: RUN_VAULT_GONE }
      const vaultRoot = vault?.root ?? null
      const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
      if (!vaultRoot || !run) return { ok: false, error: 'This Run is no longer in the vault.' }
      const value = (patch ?? {}) as { answered?: unknown; inTalk?: unknown }
      const inTalk = value.inTalk === null ? null
        : value.inTalk && typeof value.inTalk === 'object' && (typeof (value.inTalk as { slideId?: unknown }).slideId === 'string' || (value.inTalk as { slideId?: unknown }).slideId === null)
          ? { slideId: (value.inTalk as { slideId: string | null }).slideId } : undefined
      if ((value.answered !== undefined && typeof value.answered !== 'boolean') || (value.inTalk !== undefined && inTalk === undefined)) return { ok: false, error: 'That mark could not be read.' }
      if (inTalk && inTalk.slideId !== null && (!inTalk.slideId || inTalk.slideId.length > RUN_PREWORK_MAX_SLIDE_ID)) return { ok: false, error: 'That slide id is too long.' }
      try {
        return { ok: true, run: persistRunForTalk(vaultRoot, talkSlug, runId, markRunPreworkQuestion(run, entryId, {
          ...(value.answered !== undefined ? { answered: value.answered as boolean } : {}), ...(inTalk !== undefined ? { inTalk } : {}) }, phase)) }
      } catch { return { ok: false, error: 'That question is not on this Run.' } }
    },

    /**
     * The Run page's read state: leaving the Run (`leave`), Mark all read (`all`), or one response kept
     * unread by its dot (`keep`). Written through the atomic Run writer from a fresh read. A Run with no
     * answers for the phase is left as it is.
     */
    markSeen(talkSlug: string, runId: string, change: unknown, phase: Phase = 'pre', given?: RunVault | null): { ok: true; run: RunRecord } | { ok: false; error: string } {
      if (badRef(talkSlug, runId)) return { ok: false, error: BAD_REF }
      const vault = runVault(given)
      if (vault && !vault.stillWritable()) return { ok: false, error: RUN_VAULT_GONE }
      const vaultRoot = vault?.root ?? null
      const run = vaultRoot ? readRunForTalk(vaultRoot, talkSlug, runId) : null
      if (!vaultRoot || !run) return { ok: false, error: 'This Run is no longer in the vault.' }
      const value = (change ?? {}) as { type?: unknown; id?: unknown; unread?: unknown }
      const parsed: SeenChange | null = value.type === 'leave' || value.type === 'all' ? { type: value.type }
        : value.type === 'keep' && typeof value.id === 'string' && value.id && value.id.length <= 400 && typeof value.unread === 'boolean' ? { type: 'keep', id: value.id, unread: value.unread }
          : null
      if (!parsed) return { ok: false, error: 'That could not be read.' }
      try {
        const next = setRunPreworkSeen(run, parsed, now(), phase)
        return { ok: true, run: next === run ? run : persistRunForTalk(vaultRoot, talkSlug, runId, next) }
      } catch { return { ok: false, error: 'The Run could not be saved.' } }
    },

    /** Runs and phases open now (or closed within the grace period): what the timer pulls. */
    due(): Array<{ talkSlug: string; runId: string; phase: Phase }> {
      return dueRows().map(({ talkSlug, runId, phase }) => ({ talkSlug, runId, phase }))
    },

    /**
     * Ask the service how many responses wait after each open phase's cursor (decision 13: counted on the
     * timer, pulled only when the Run is opened). Nothing is downloaded and no Run is written; the count is
     * kept on the registry row. Never throws; returns how many rows changed their count.
     */
    async countDue(): Promise<number> {
      let changed = 0
      for (const ref of dueRows()) {
        try {
          // Each row by the key it is under, in the turn of its own vault's key.
          await queue.run(ref.queueKey, async () => {
            const row = read().preworks[ref.fileKey]
            if (!row || row.purgedAt !== undefined) return
            const response = await asOwner(row, `waiting?after=${row.cursor}`, { signal: AbortSignal.timeout(10_000) })
            // A service from before the count (404), or one that cannot answer now: the row keeps what it had.
            if (!response.ok) return
            const body = await response.json().catch(() => null) as { waiting?: unknown } | null
            const waiting = Number.isSafeInteger(body?.waiting) && Number(body!.waiting) >= 0 ? Number(body!.waiting) : null
            if (waiting === null) return
            const known = countField(row.waiting) ? row.waiting! : 0
            if (waiting === known) return
            if (update(row, { waiting: waiting > 0 ? waiting : undefined })) changed += 1
          })
        } catch { console.warn('[prework] count failed') } // a fixed sentence, never a request
      }
      return changed
    },

    /** Pull every Run and phase that is open. Never throws; returns the Runs that changed. */
    async pullDue(): Promise<RunRecord[]> {
      const changed: RunRecord[] = []
      for (const ref of dueRows()) {
        try {
          // The Run's own vault, as its last publish recorded it, while that vault can be written; a row from a
          // vault that is closed or not there now is not pulled (never into another vault). A row with no vault
          // (written before rows recorded one) is refused by pullNow until the Run is published again.
          const row: Partial<RunPreworkRow> = read().preworks[ref.fileKey] ?? {}
          const owner = rowVault(row)
          const vaultRoot = owner && deps.writableVault ? deps.writableVault(owner) : null
          if (owner && deps.writableVault && !vaultRoot) continue
          // The vault at that root now, fixed before the queue and the network waits: it must be the one the Run
          // was published from (the row's id), or, for a row that records none, stay the one found here.
          const id = vaultRoot ? idAt(vaultRoot) : null
          const recorded = rowVaultId(row)
          if (vaultRoot && deps.vaultIdAt && (id === null || (recorded !== null && recorded !== id))) continue
          // Same id at the same root, open and writable, asked again just before the write (pullNow).
          const result = await pull(ref.talkSlug, ref.runId, ref.phase, vaultRoot ? rootVault(vaultRoot, id) : null)
          if (result.ok && result.changed) changed.push(result.run)
        } catch (error) { console.warn('[prework] pull failed:', error instanceof Error ? error.message : 'unknown') } // a fixed sentence, never a request
      }
      return changed
    },
  }
}

export type RunPreworkService = ReturnType<typeof createRunPrework>

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void
}

function runRef(payload: unknown): { talkSlug: string; runId: string; phase: Phase | null; vaultId: unknown } {
  const value = (payload ?? {}) as Record<string, unknown>
  return { talkSlug: String(value.talkSlug ?? ''), runId: String(value.runId ?? ''), phase: phaseOf(value.phase), vaultId: value.vaultId }
}

/** The vault a request names, as `RunPreworkIpcHooks.vaultFor` resolves it. */
type VaultPick = { root: string | undefined } | { error: string }

const NOT_A_PHASE = 'That is neither pre-work nor post-work.'

/**
 * History's pre-work and post-work actions: pull now, close now, and whether the Run has the phase on
 * its handout (`phase` in the payload; none is pre-work). Every handler names a Run by talk slug and
 * run id; the service reads and writes it only in that talk's own folder.
 */
export interface RunPreworkIpcHooks {
  onQuestionMarked?(talkSlug: string, runId: string): void
  /**
   * The vault a request names by `vaultId` (the Run page sends the Run's own): that open vault's root while it
   * can be written, or the refusal. Not called for a request with no `vaultId` (History, older callers): those
   * act in the current vault. Without this hook a request that names a vault is refused.
   */
  vaultFor?(vaultId: unknown): VaultPick
}

const VAULT_NOT_OPEN = RUN_VAULT_GONE

export function registerRunPreworkIpc(ipcMain: IpcMainLike, service: RunPreworkService, hooks: RunPreworkIpcHooks = {}): void {
  /** The Run's vault for this request: undefined (none named: the current vault), a root, or the refusal. */
  // Only a request with no `vaultId` key (undefined) means the current vault; null, '' or anything not text is
  // refused, as runVaultRoot refuses it. The root comes with a check the service asks just before it writes:
  // the same vault id still resolves to the same root, open and writable.
  const vaultOf = (ref: { vaultId: unknown }): { root?: RunVault } | { error: string } => {
    if (ref.vaultId === undefined) return {}
    if (typeof ref.vaultId !== 'string' || !ref.vaultId || !hooks.vaultFor) return { error: VAULT_NOT_OPEN }
    const vaultFor = hooks.vaultFor
    const vaultId = ref.vaultId
    const picked = vaultFor(vaultId)
    if ('error' in picked) return picked
    const root = picked.root
    if (!root) return { error: VAULT_NOT_OPEN }
    return { root: { root, stillWritable: () => { const again = vaultFor(vaultId); return !('error' in again) && again.root === root } } }
  }
  ipcMain.handle('history:prework-status', (_event, payload) => {
    const ref = runRef(payload)
    // The registry is this computer's, not a vault's; a named vault is still checked, so a Run of a vault
    // that is not open shows no phase.
    const vault = vaultOf(ref)
    if ('error' in vault) return null
    // That vault's own row (issue 256): never the same talk and Run id in another vault.
    return ref.phase ? service.status(ref.talkSlug, ref.runId, ref.phase, vault.root) : null
  })
  ipcMain.handle('history:prework-refresh', (_event, payload) => {
    const ref = runRef(payload)
    if (!ref.phase) return { ok: false, error: NOT_A_PHASE }
    const vault = vaultOf(ref)
    if ('error' in vault) return { ok: false, error: vault.error }
    return service.pull(ref.talkSlug, ref.runId, ref.phase, vault.root)
  })
  ipcMain.handle('history:prework-pick', (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    const phase = ref.phase
    if (!phase) return { ok: false, error: NOT_A_PHASE }
    const vault = vaultOf(ref)
    if ('error' in vault) return { ok: false, error: vault.error }
    return service.changePick(ref.talkSlug, ref.runId, String(value.stepId ?? ''), value.change, phase, vault.root)
  })
  ipcMain.handle('history:prework-question', (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    const phase = ref.phase
    if (!phase) return { ok: false, error: NOT_A_PHASE }
    const vault = vaultOf(ref)
    if ('error' in vault) return { ok: false, error: vault.error }
    const result = service.markQuestion(ref.talkSlug, ref.runId, String(value.entryId ?? ''), value.patch, phase, vault.root)
    // A presenter window on this Run is told, so a question just put in the talk's questions is in its tray.
    if (result.ok) { try { hooks.onQuestionMarked?.(ref.talkSlug, ref.runId) } catch { /* best effort */ } }
    return result
  })
  ipcMain.handle('history:prework-seen', (_event, payload) => {
    const ref = runRef(payload)
    const value = (payload ?? {}) as Record<string, unknown>
    if (!ref.phase) return { ok: false, error: NOT_A_PHASE }
    const vault = vaultOf(ref)
    if ('error' in vault) return { ok: false, error: vault.error }
    return service.markSeen(ref.talkSlug, ref.runId, value.change, ref.phase, vault.root)
  })
  ipcMain.handle('history:prework-close', (_event, payload) => {
    const ref = runRef(payload)
    if (!ref.phase) return { ok: false, error: NOT_A_PHASE }
    const vault = vaultOf(ref)
    if ('error' in vault) return { ok: false, error: vault.error }
    return service.close(ref.talkSlug, ref.runId, ref.phase, vault.root)
  })
}

/**
 * Count what waits for open pre-work and post-work every few minutes (and once now); returns a stop
 * function. The answers themselves are pulled when the Run is opened (2026-10-19 prework-responses,
 * decision 13: "batched until I open the view"). `onChanged` hears when a count changed.
 */
export function startRunPreworkTimer(service: Pick<RunPreworkService, 'countDue'>, onChanged: () => void, intervalMs = PREWORK_PULL_INTERVAL_MS): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      if (await service.countDue() > 0) onChanged()
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}
