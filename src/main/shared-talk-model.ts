// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts). The model:
// the share record and the module's interfaces, the fixed messages, the error kinds, and the
// revision files Compare reads. No state lives here.
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { isShareId } from '../shared/share-id.ts'
import { OwnerRequestError, validOwnerToken, type OwnerTokens } from './owner-tokens.ts'
import type {
  SharedTalkEnded, SharedTalkInspection, SharedTalkSlide, SharedTalkState, SharedTalkStopped, SharedTalkStopResult,
} from '../shared/shared-talk.ts'

export interface SharedTalkRecord {
  key: string
  slug: string
  /** The talkSlug the Worker registered this share under. */
  workerSlug: string
  outlinePath: string
  realPath: string
  shareId: string
  ownerToken: string
  workerBaseUrl: string
  revision: number
  liveUpdates: boolean
  proposals: boolean
  createdAt: string
  lastPushedAt: string | null
  lastPushHash: string | null
  /** The share ended on the Worker (stopped elsewhere, retired) or refuses this owner token
   *  (ticket 05's owner socket finds out). Nothing is pushed; Stop sharing clears the row. */
  ended?: SharedTalkEnded | null
  /** A Stop's close request went out and no answer came back (round 2, finding 6): the share may
   *  be closed. The next Share or inspect asks the service before it returns this link. */
  closeUncertain?: boolean
  /** Closed on the service, but the registry file could not be written to remove the row (round 2,
   *  finding 7). In memory only: its token is forgotten, so a restart finds a row it cannot use,
   *  never a live share; every later write tries the removal again. */
  closedRemotely?: boolean
}

export interface RegistryFile { version: 2; shares: Record<string, SharedTalkRecord> }

export interface OutlineIdentityLike { key: string; realPath: string }

export interface SharedTalkDeps {
  /** {userData}/shared-talk-registry.json */
  registryPath: string
  /** Where the shares' owner tokens are kept (the secrets store). */
  ownerTokens: OwnerTokens
  /** The live Worker and its admin credential (ensureLiveWorker). Used to CREATE shares only. */
  endpoint(): Promise<{ baseUrl: string; adminSecret: string }>
  /** Config `sharedTalkLinkBase` (ticket 07 sets it to the drafts host); empty = Worker origin. */
  linkBase(): string | null | undefined
  /** The outline writer's identity for a path (outline-identity.ts). */
  identityOf(outlinePath: string): OutlineIdentityLike
  slugOf(outlinePath: string): string
  /** The talk's current text: the open editor's buffer flushed to disk, then read. */
  readOutline(outlinePath: string): Promise<string>
  /** The outline file as it is on disk, without flushing anything (the sheet's pre-share check). */
  peekOutline(outlinePath: string): string
  /** Compile what one push sends. Throws when the talk cannot be built (the push is skipped). */
  build(input: { outlinePath: string; content: string; slug: string; proposals: boolean; signal?: AbortSignal }): Promise<{ title: string; html: string; slides: SharedTalkSlide[] }>
  /** Rewrite the outline through `decide` (the outline text as the writer has it → the text to write):
   *  the writer calls it when the write RUNS, so the decision about `share_url:` is taken against the
   *  share's state then, never when the write was asked for (ticket 12 design, section 4). */
  stampShareUrl(outlinePath: string, decide: (text: string) => string): Promise<void>
  qrSvg(url: string): Promise<string>
  fetch: typeof fetch
  /** A share changed. `previousKey`: the same share under its old identity key (the outline was
   *  replaced by a new file) — ONE event, so no window sees the share go and come back. */
  onChange?(key: string, state: SharedTalkState | null, previousKey?: string): void
  /** Quiet period after a save before the push starts (collapses bursts of autosaves). */
  saveDebounceMs?: number
  now?(): Date
  log?(message: string): void
}

/** A create an earlier run sent and never registered (design note [s]): reported, never closed here. */
export interface InterruptedCreate {
  outlinePath: string
  realPath: string
  title: string
  message: string
}

export interface SharedTalks {
  /** The sheet's first look: this Mac's share, or another Mac's share_url in the outline; `stopped`
   *  when the share it found was closed before the answer; `interruptedShare` when a create from
   *  before was never registered (a share may still be open; the next Share replaces it). */
  inspect(outlinePath: string): Promise<SharedTalkInspection>
  /** The talk's share, or `{ stopped: true, shareId }` when a Stop overtook this Share (ticket 12):
   *  never a closed link. */
  share(outlinePath: string, title?: string): Promise<SharedTalkState | SharedTalkStopped>
  status(outlinePath: string): Promise<SharedTalkState | null>
  list(): SharedTalkState[]
  /** The changed share, or stopped when a Stop closed it while the change ran (never a closed link). */
  setOptions(outlinePath: string, options: { liveUpdates?: boolean; proposals?: boolean }): Promise<SharedTalkState | SharedTalkStopped>
  /** Explicit "Update shared copy": push the current text whatever switch 1 says. Stopped as setOptions. */
  update(outlinePath: string): Promise<SharedTalkState | SharedTalkStopped>
  /** The save hook: called after every successful editor save. Never throws, never waits. */
  noteSaved(outlinePath: string, content: string): void
  stop(outlinePath: string): Promise<SharedTalkStopResult>
  /** Settles once no push is queued or running (tests, app quit). */
  idle(): Promise<void>
  /** A create step is under way (app quit waits for it: its token must be kept). */
  createsPending(): boolean
  /** Settles when every create step under way has finished, or after `ms`, whichever is first. */
  drainCreates(ms: number): Promise<void>
  /** At start: every create noted down by an earlier run and never registered (the app quit while
   *  its reply was awaited). Reported only — nothing is sent; the note stays until the talk is
   *  shared again, which replaces that share on the service. */
  interruptedCreates(): InterruptedCreate[]
  /** MAIN-ONLY (the feedback service's owner sockets): every share with its owner token. Never
   *  sent to a window. */
  owners(): SharedTalkOwner[]
  /** The owner socket found the share ended: record it (no more pushes) and tell windows. */
  markEnded(shareId: string, reason: SharedTalkEnded): void
}

export interface SharedTalkOwner {
  key: string
  outlinePath: string
  shareId: string
  ownerToken: string
  workerBaseUrl: string
  url: string
  ended: SharedTalkEnded | null
}

export interface RevisionSnapshot {
  shareId: string
  revision: number
  pushedAt: string
  slides: SharedTalkSlide[]
  /** The outline text this revision was built from (a proposals change with switch 1 off rebuilds
   *  their page from it, so they keep the talk as they have it). */
  source: string
}

export type Shared = SharedTalkState | SharedTalkStopped

export interface Attempt { revision: number; slides: SharedTalkSlide[]; source: string; hash: string }

export type PushMode = { kind: 'save' } | { kind: 'current' } | { kind: 'confirmed' }

/** A create the app sent and has not registered yet (round 2, finding 8), kept in a file beside the
 *  registry from before the POST until the reply is registered or known to have made nothing. */
export interface PendingCreate { workerSlug: string; workerBaseUrl: string; realPath: string; outlinePath: string; sentAt: string; title?: string }

// ── revision files (ticket 06 reads them for Compare) ─────────────────────────────────────────────

export function feedbackDirFor(outlinePath: string): string {
  return join(dirname(outlinePath), 'feedback')
}

/** Where a confirmed revision's slide text is kept (ticket 06 reads it for Compare). */
export function revisionSnapshotPath(outlinePath: string, shareId: string, revision: number): string {
  if (!isShareId(shareId)) throw new Error(`Not a share id: ${JSON.stringify(shareId)}`)
  if (!Number.isInteger(revision) || revision < 1) throw new Error(`Not a revision: ${revision}`)
  return join(feedbackDirFor(outlinePath), `${shareId}-revisions`, `${revision}.json`)
}

export function writeFileAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
  writeFileSync(temp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  renameSync(temp, path)
}

/** A confirmed revision as kept on disk: null when it was never kept; THROWS when the file is there
 *  but unreadable or not a revision file (a corrupt file is an error, never "missing"). */
export function readRevisionSnapshot(outlinePath: string, shareId: string, revision: number): RevisionSnapshot | null {
  const path = revisionSnapshotPath(outlinePath, shareId, revision)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Revision ${revision} of this share could not be read: ${(error as Error).message}`)
  }
  let parsed: Partial<RevisionSnapshot>
  try { parsed = JSON.parse(raw) } catch { throw new Error(`Revision ${revision} of this share is corrupt (${path}).`) }
  const slidesOk = Array.isArray(parsed.slides) && parsed.slides.every((slide) =>
    slide && typeof slide.slideId === 'string' && typeof slide.title === 'string' && typeof slide.text === 'string')
  if (!parsed || parsed.shareId !== shareId || parsed.revision !== revision || !slidesOk) {
    throw new Error(`Revision ${revision} of this share is corrupt (${path}).`)
  }
  return {
    shareId, revision, pushedAt: String(parsed.pushedAt ?? ''), slides: parsed.slides as SharedTalkSlide[],
    source: typeof parsed.source === 'string' ? parsed.source : '',
  }
}

/** The slide text at a revision (Compare's base): null when never kept; throws when corrupt. */
export function readRevisionSlides(outlinePath: string, shareId: string, revision: number): SharedTalkSlide[] | null {
  return readRevisionSnapshot(outlinePath, shareId, revision)?.slides ?? null
}

/** The talkSlug the Worker registers a share under: the file-name slug made Worker-safe, plus a
 *  hash of the outline's real path, so same-named talks never replace each other's share. */
export function workerTalkSlug(slug: string, realPath: string): string {
  const base = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'talk'
  return `${base}-${createHash('sha256').update(realPath).digest('hex').slice(0, 10)}`
}

// ── error kinds ─────────────────────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class Cancelled extends Error {
  constructor() { super('cancelled: sharing stopped') }
}

/** The create could not be kept and the share was closed again (SHARE_NOT_KEPT): which share it was. */
export class NotKept extends Error {
  readonly shareId: string
  constructor(message: string, shareId: string) {
    super(message)
    this.shareId = shareId
  }
}

/** The share is closed on the service but its row could not be removed (round 2, finding 7). */
export class RecordNotRemoved extends Error {}

/** `work`, or Cancelled as soon as `signal` aborts (k3: Stop settles a push chain at once, even when
 *  the outline flush or the build never finishes). */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

export async function readJson(response: Response): Promise<unknown> {
  try { return await response.json() } catch { return null }
}

export function errorMessage(body: unknown, fallback: string): string {
  const error = (body as { error?: { message?: string; code?: string } } | null)?.error
  return error?.message || error?.code || fallback
}

// ── fixed messages ──────────────────────────────────────────────────────────────────────────────

export const SHARE_LOCKED = 'This talk already has a share, but its key cannot be read from this computer\'s secure storage just now. Nothing was changed. Try again.'
export const SHARE_NOT_KEPT = 'Could not create the share: it could not be saved on this computer, so it was closed again and nothing was shared.'
export const SHARE_NOT_KEPT_OPEN = 'Could not create the share: it could not be saved on this computer and could not be closed again. It shows nothing and cannot be reached from this app.'
export const SHARE_RACED = 'This talk was shared from elsewhere on this computer just now. Nothing was created here; close the sheet and open it again.'
export const SHARE_NOT_NOTED = 'Could not create the share: this computer could not note it down first, so nothing was created.'
export const SHARE_UNVERIFIED = 'Could not check whether this talk’s last Stop sharing went through: the sharing service could not be reached. Try again.'
export function recordNotRemovedMessage(reason: string): string {
  return `Sharing has stopped: the share is closed on the sharing service and the link no longer opens, but this computer could not remove its record of the share (${reason}). Try Stop sharing again.`
}
/** A create note left from before (design note [s]): what the sheet and the start-up log say. */
export function interruptedShareMessage(title: string): string {
  return `A share for “${title}” may still be open on the sharing service; it will be replaced the next time you share this talk.`
}
/** Stop with no row and such a note (design note [e]): never "stopped" while a share may stand. */
export function stopInterruptedMessage(title: string): string {
  return `Could not stop sharing: a share for “${title}” may still be open on the sharing service from before the app last quit; it will be replaced the next time you share this talk.`
}

export function describe(error: unknown): string {
  if (error instanceof HttpError) return error.message
  // A request that carried the owner token and was never answered: fixed words (owner-tokens.ts).
  if (error instanceof OwnerRequestError) {
    if (error.reason === 'timeout') return 'the sharing service did not answer in time.'
    if (error.reason === 'cancelled') return 'the request to the sharing service was cancelled.'
    return error.reason === 'bad-token' ? 'this talk’s owner credential is not usable.' : 'the sharing service could not be reached.'
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'the sharing service did not answer in time.'
    return error.message
  }
  return String(error)
}

export function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch { return false }
}

export function validRecord(value: unknown): value is SharedTalkRecord {
  const r = value as SharedTalkRecord
  return Boolean(r) && typeof r.key === 'string' && !!r.key && typeof r.outlinePath === 'string' && typeof r.realPath === 'string'
    && isShareId(r.shareId) && validOwnerToken(r.ownerToken) && validOrigin(r.workerBaseUrl)
    && Number.isInteger(r.revision) && r.revision >= 0 && typeof r.liveUpdates === 'boolean' && typeof r.proposals === 'boolean'
}
