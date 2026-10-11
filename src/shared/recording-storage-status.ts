// Recording storage, in words: the states of its row in Settings → Cloudflare, and what a person is
// told when an upload does not go through (spec docs/plans/cloudflare-setup-in-app, D10, the "Per
// feature" table and the "Upload recording" row). Pure, with no imports but a type, so the main
// process (which produces a row and sorts a failure), Settings, Studio and History use the same
// states and the same sentences.
//
// Nothing here holds or names an access key. A row carries the bucket's name and which of the three
// things Settings takes is missing; a failure is one of six fixed words, never the text of an error.
import type { RowEdge } from './cloudflare-status.ts'

export const RECORDING_ROW_NAME = 'Recording storage'

/** Shown once to an install whose recordings used to take their keys from Bitwarden (spec, "Migration"). */
export const RECORDING_KEYS_NOTICE = 'Recording storage: enter your access keys'

export type RecordingStorageMissing = 'endpoint' | 'bucket' | 'keys'

/**
 * What the last Check (or the last upload) found, for the endpoint and bucket now in Settings.
 * `ready`: a list of the bucket was answered (a read). That the keys may write to it is proven by
 * the first upload: a check never writes, uploads or deletes to find out.
 */
export type RecordingStorageFinding = 'ready' | 'bucket-not-found' | 'keys-rejected'

export type RecordingStorageRow = {
  state: 'not-set-up' | 'not-checked' | RecordingStorageFinding
  /** What Settings still needs, when `state` is `not-set-up`. */
  missing: RecordingStorageMissing[]
  /** The bucket named in Settings, or ''. */
  bucket: string
  /** A Check is under way. */
  checking: boolean
  /** A fixed sentence about a Check that got no usable answer, or null. */
  notice: string | null
}

export const CHECK_NO_ANSWER_NOTICE = 'Could not check (offline?)'
export const CHECK_FAILED_NOTICE = 'The check could not be completed.'
export const KEYS_UNREADABLE_NOTICE = 'The saved access keys could not be read on this computer. Enter them again.'

/**
 * The Recording storage row: the one place its state is decided. Endpoint, bucket and keys must all
 * be there before anything else is said; a finding counts only while they are.
 */
export function recordingStorageRow(input: {
  endpoint: string
  bucket: string
  hasKeys: boolean
  finding?: RecordingStorageFinding | null
  checking?: boolean
  notice?: string | null
}): RecordingStorageRow {
  const bucket = input.bucket.trim()
  const missing: RecordingStorageMissing[] = [
    ...(input.endpoint.trim() ? [] : ['endpoint' as const]),
    ...(bucket ? [] : ['bucket' as const]),
    ...(input.hasKeys ? [] : ['keys' as const]),
  ]
  const checking = input.checking === true
  if (missing.length) return { state: 'not-set-up', missing, bucket, checking: false, notice: null }
  return { state: input.finding ?? 'not-checked', missing, bucket, checking, notice: input.notice ?? null }
}

const MISSING_WORDS: Record<RecordingStorageMissing, string> = { endpoint: 'the endpoint', bucket: 'the bucket', keys: 'your access keys' }

function listed(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** The row's one line of detail. */
export function recordingRowDetail(row: RecordingStorageRow): string {
  if (row.notice) return row.notice
  switch (row.state) {
    case 'not-set-up':
      // The row's own button ("Set up recording storage") opens the fields: the words point at it, not "below".
      return row.missing.length === 3
        ? 'Recordings stay on this computer until storage is set up'
        : `Enter ${listed(row.missing.map((what) => MISSING_WORDS[what]))} to finish setting up`
    case 'not-checked': return `Bucket ${row.bucket}`
    // The limit of a check that only reads, said where a person meets it.
    case 'ready': return `Bucket ${row.bucket} · found. That the keys may upload is proven by the first upload.`
    case 'bucket-not-found': return `No bucket named ${row.bucket} at this endpoint`
    case 'keys-rejected': return 'The storage did not accept these access keys'
  }
}

/** The row's right-hand edge, word for word as in the spec's table. */
export function recordingRowEdge(row: RecordingStorageRow): RowEdge {
  if (row.checking) return { kind: 'state', text: 'Checking…', tone: 'quiet' }
  switch (row.state) {
    case 'not-set-up': return { kind: 'state', text: 'Not set up', tone: 'quiet' }
    case 'not-checked': return { kind: 'state', text: 'Keys saved, not checked', tone: 'quiet' }
    case 'ready': return { kind: 'state', text: 'Ready', tone: 'good' }
    case 'bucket-not-found': return { kind: 'state', text: 'Bucket not found', tone: 'warn' }
    case 'keys-rejected': return { kind: 'state', text: 'Keys rejected', tone: 'warn' }
  }
}

/** Check is offered once there is something to check. */
export function recordingRowCanCheck(row: RecordingStorageRow): boolean {
  return row.state !== 'not-set-up' && !row.checking
}

// ── An upload that did not go through ───────────────────────────────────────────────────────────

export type UploadFailure = 'not-set-up' | 'keys-rejected' | 'bucket-not-found' | 'offline' | 'failed' | 'audio-missing'

export const UPLOAD_FAILURES: readonly UploadFailure[] = ['not-set-up', 'keys-rejected', 'bucket-not-found', 'offline', 'failed', 'audio-missing']

// "Keys rejected" is said only when new keys could fix it.
const REJECTED_NAMES = new Set([
  'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'Unauthorized', 'Forbidden', 'InvalidToken', 'ExpiredToken', 'TokenRefreshRequired',
  'InvalidSecurity', 'CredentialsProviderError',
])
// A store's answer to valid keys signed for another region (the client signs for "auto"). New keys
// would not fix it, so it names no cause, whatever HTTP status comes with it.
const NOT_THE_KEYS_NAMES = new Set(['AuthorizationHeaderMalformed'])
const OFFLINE_NAMES = new Set(['TimeoutError', 'RequestTimeout', 'NetworkingError', 'AbortError'])
const OFFLINE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_NETWORK',
])

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Sort why an upload (or a check) did not go through. Takes what was thrown, or one of the words
 * above; reads only an error's name, code and HTTP status, never its message, and answers with one
 * of six words. So nothing an S3 service or the network library put into an error (a request id,
 * an address, a key id) can travel on from here. The word 'audio-missing' is the local reason the
 * main process gives when the recording's audio file is not on disk; no thrown error sorts to it.
 */
export function sortUploadFailure(reason: unknown): UploadFailure {
  if (typeof reason === 'string') return (UPLOAD_FAILURES as readonly string[]).includes(reason) ? (reason as UploadFailure) : 'failed'
  type Link = { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown }; cause?: unknown }
  // An error, then what caused it (the network library wraps the socket's own error).
  const chain: Link[] = []
  for (let seen: unknown = reason; chain.length < 4 && seen && typeof seen === 'object'; seen = (seen as Link).cause) chain.push(seen as Link)
  // Not the keys anywhere in the chain: no cause is named, whatever the other links carry.
  if (chain.some((error) => [error.name, error.Code, error.code].some((name) => NOT_THE_KEYS_NAMES.has(text(name))))) return 'failed'
  for (const error of chain) {
    const names = [text(error.name), text(error.Code), text(error.code)]
    const http = typeof error.$metadata?.httpStatusCode === 'number' ? error.$metadata.httpStatusCode : null
    if (names.includes('NoSuchBucket')) return 'bucket-not-found'
    if (names.some((name) => REJECTED_NAMES.has(name))) return 'keys-rejected'
    if (names.some((name) => OFFLINE_NAMES.has(name) || OFFLINE_CODES.has(name))) return 'offline'
    if (http === 404) return 'bucket-not-found'
    if (http === 401 || http === 403) return 'keys-rejected'
  }
  return 'failed'
}

/**
 * Said with every upload that did not go through, except audio-missing (there is no audio to be
 * safe): it never deletes, moves or changes the recording.
 */
export const RECORDING_IS_SAFE = 'The recording is safe on this computer.'
export const SET_UP_RECORDING_STORAGE = 'Set up recording storage'

/** The sentence for a failed upload, the same in Studio and in History. */
export function uploadFailureMessage(reason: unknown): string {
  switch (sortUploadFailure(reason)) {
    case 'not-set-up': return `Recording storage is not set up. ${RECORDING_IS_SAFE}`
    case 'keys-rejected': return `Not uploaded: the storage rejected the access keys. ${RECORDING_IS_SAFE}`
    case 'bucket-not-found': return `Not uploaded: the bucket was not found. ${RECORDING_IS_SAFE}`
    case 'offline': return `Not uploaded: the storage could not be reached (offline?). ${RECORDING_IS_SAFE}`
    case 'failed': return `Not uploaded. ${RECORDING_IS_SAFE}`
    case 'audio-missing': return "This recording's audio file is missing from this computer, so there is nothing to upload."
  }
}

/** The one action a failed upload offers, or null: with storage not set up, the way to Settings. */
export function uploadFailureAction(reason: unknown): string | null {
  return sortUploadFailure(reason) === 'not-set-up' ? SET_UP_RECORDING_STORAGE : null
}
