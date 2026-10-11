// Recording storage: the access keys, the one check, the one upload call and the Settings row
// (spec docs/plans/cloudflare-setup-in-app, D10; states and sentences in
// src/shared/recording-storage-status.ts).
//
// The keys. They are typed into Settings and kept only in the secrets module's slot
// `recording-keys` (secrets-store.ts; its header is the boundary: what the slot defends and what it
// does not). This file is the only one that reads or writes that slot. The keys leave it in one
// direction only: into the S3 client made here, which signs requests to the endpoint in Settings
// (the access key id travels in the Authorization header; the secret access key signs and is never
// sent). They are never written to config.json, never logged, never returned to a caller and never
// part of an error: what was thrown is sorted to one fixed word and dropped. There is one source of
// keys: Settings. Nothing here, or anywhere in the app, asks Bitwarden, the Keychain command or the
// environment for them.
//
// Known limits, accepted.
// - "Check" is one read: a single list request for at most one object. It never writes, uploads or
//   deletes. "Ready" therefore means the list was answered; that the keys may write to the bucket is
//   proven by the first upload (as the Publishing handouts row says of its own check, spec D6).
// - What a check found is held in memory only: after a restart the row says "Keys saved, not
//   checked" until Check is pressed or an upload is answered.
// - An upload is one call made when a person asks for it. There is no queue and no retry in the
//   background: when it does not go through, the recording stays where it was, untouched.
// - The endpoint is whatever Settings holds. A person who types an address that is not their
//   storage sends it the access key id and signed requests, as any S3 tool would. No other host is
//   sent anything: a bucket name the S3 client would turn into a host of its own is refused first
//   (sendableBucket).
//
// Shape: no Electron here. The secrets store, the two settings and the old config keys come in as
// arguments, so the whole of it runs under plain Node in tests against an S3 stand-in on loopback.
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { SecretsError, type SecretsStore } from './secrets-store.ts'
import {
  CHECK_FAILED_NOTICE, CHECK_NO_ANSWER_NOTICE, KEYS_UNREADABLE_NOTICE, RECORDING_KEYS_NOTICE, recordingStorageRow, sortUploadFailure,
  type RecordingStorageFinding, type RecordingStorageRow, type UploadFailure,
} from '../shared/recording-storage-status.ts'

const SLOT = 'recording-keys'

export const CHECK_TIMEOUT_MS = 10_000
export const KEYS_SHAPE_ERROR = 'Both an access key id and a secret access key are needed, each one line with no spaces.'
export const KEYS_NOT_SAVED_ERROR = 'The recording keys could not be saved.'

type RecordingKeys = { accessKeyId: string; secretAccessKey: string }

/** One line of printable characters: what an access key id or a secret access key is. */
function keyText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 && text.length <= 512 && /^[\x21-\x7e]+$/.test(text) ? text : null
}

/** Whether saveKeys would accept these keys: the same test, run before anything is written (setup, ticket 07). */
export function recordingKeysAcceptable(keys: unknown): boolean {
  const typed = (keys ?? {}) as { accessKeyId?: unknown; secretAccessKey?: unknown }
  return keyText(typed.accessKeyId) !== null && keyText(typed.secretAccessKey) !== null
}

/**
 * The recording credential resolver. One source: what Settings saved in the secrets module. Null
 * when nothing is saved, or when what is saved cannot be read on this computer just now.
 */
function resolveRecordingKeys(secrets: Pick<SecretsStore, 'read'>): RecordingKeys | null {
  try {
    const stored = secrets.read(SLOT)
    if (stored === null) return null
    const parsed = JSON.parse(stored) as { accessKeyId?: unknown; secretAccessKey?: unknown }
    const accessKeyId = keyText(parsed?.accessKeyId)
    const secretAccessKey = keyText(parsed?.secretAccessKey)
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null
  } catch {
    return null
  }
}

/**
 * Whether a bucket name may be sent. Signed requests go only to the host typed as the endpoint, with
 * the bucket in the path. The S3 client does not keep to that for every name: asked for path-style
 * addressing it still moves an S3 Express name (`…--x-s3`, `…--xa-s3`) into the host, and reads an
 * ARN as an address of its own. So only an ordinary bucket name is sent: lowercase letters, digits,
 * dots and hyphens, 3 to 63 long, a letter or digit at each end, no two dots together, and none of
 * the reserved endings. Anything else is refused before a request is made.
 */
function sendableBucket(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    && !bucket.includes('..')
    && !/(?:--[a-z0-9]+-s3|-s3alias|\.mrap)$/.test(bucket)
}

// ── The two config keys of the source that is gone ──────────────────────────────────────────────

/** Read once, then dropped from config.json (spec, "Config keys … Removed"). */
export const RETIRED_RECORDING_CONFIG_KEYS: readonly string[] = ['recordingR2CredsSource', 'recordingR2BwsSecretId']

export interface RetiredRecordingConfig {
  read(): Record<string, unknown>
  /** Remove these keys from the stored config. */
  drop(keys: readonly string[]): void
}

/**
 * Read the two old keys and drop them. Answers with the one-time notice when they show a set-up
 * whose keys did not come from Settings (the only other source there ever was is Bitwarden), and
 * with null otherwise: a set-up that already used typed keys loses two unused config keys and
 * nothing else. Once they are dropped there is nothing left to read, so the notice cannot come twice;
 * when they could not be dropped this answers the same again, and the service's `takeNotice` is what
 * keeps it to once in a run of the app.
 */
export function retireRecordingConfig(config: RetiredRecordingConfig): string | null {
  let stored: Record<string, unknown>
  try { stored = config.read() ?? {} } catch { return null }
  if (!RETIRED_RECORDING_CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(stored, key))) return null
  const source = stored.recordingR2CredsSource
  const former = typeof source === 'string' && source !== 'settings'
  try { config.drop(RETIRED_RECORDING_CONFIG_KEYS) } catch { /* still there: read again at the next start */ }
  return former ? RECORDING_KEYS_NOTICE : null
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

export interface RecordingStorageOptions {
  secrets: Pick<SecretsStore, 'has' | 'read' | 'write' | 'clear'>
  /** Settings → Recording storage: the endpoint and the bucket (neither is a secret). */
  settings: () => { endpoint: string; bucket: string }
  retired?: RetiredRecordingConfig
  /** Told each row that follows a change. A row holds no key. */
  onChange?: (row: RecordingStorageRow) => void
  checkTimeoutMs?: number
}

export type UploadOutcome = { ok: true } | { ok: false; failure: UploadFailure }

export interface RecordingStorage {
  /** The row as it stands. Asks nothing of the network. */
  status(): RecordingStorageRow
  /** One list request for the bucket; the row that results. Never throws. */
  check(): Promise<RecordingStorageRow>
  /** Whether keys are saved. Decrypts nothing. */
  hasKeys(): boolean
  saveKeys(keys: unknown): { success: true } | { success: false; error: string }
  clearKeys(): { success: boolean }
  /** The endpoint or the bucket in Settings changed: what was found before no longer counts. */
  settingsChanged(): void
  /** Put one object. Reads `body` only; the caller's file is never touched here. Never throws. */
  upload(key: string, body: Uint8Array, contentType: string): Promise<UploadOutcome>
  /** "Recording storage: enter your access keys" for a former Bitwarden set-up, once; else null. */
  takeNotice(): string | null
}

export function createRecordingStorage(options: RecordingStorageOptions): RecordingStorage {
  const { secrets } = options
  const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS
  // What was found, and for which endpoint and bucket. `epoch` moves on whenever the keys or those
  // settings change, so an answer to a question asked before the change is dropped.
  let found: { endpoint: string; bucket: string; finding: RecordingStorageFinding } | null = null
  let notice: string | null = null
  // The Bitwarden notice has been given in this run of the app. Held in memory only: when the two
  // config keys could not be dropped they are read again at every call, and the notice must still
  // come once. It may show again at the next start if the config still could not be written; accepted.
  let setupNoticeGiven = false
  let epoch = 0
  let inFlight: { epoch: number; done: Promise<RecordingStorageRow> } | null = null

  function settings(): { endpoint: string; bucket: string } {
    let read: { endpoint?: unknown; bucket?: unknown } = {}
    try { read = options.settings() ?? {} } catch { /* nothing readable: not set up */ }
    return { endpoint: typeof read.endpoint === 'string' ? read.endpoint.trim() : '', bucket: typeof read.bucket === 'string' ? read.bucket.trim() : '' }
  }
  function hasKeys(): boolean {
    try { return secrets.has(SLOT) === true } catch { return false }
  }
  function status(): RecordingStorageRow {
    const { endpoint, bucket } = settings()
    const finding = found && found.endpoint === endpoint && found.bucket === bucket ? found.finding : null
    return recordingStorageRow({ endpoint, bucket, hasKeys: hasKeys(), finding, checking: inFlight?.epoch === epoch, notice })
  }
  function changed(): RecordingStorageRow {
    const row = status()
    try { options.onChange?.(row) } catch { /* a listener's trouble is not the storage's */ }
    return row
  }
  function forget(): void {
    epoch += 1
    found = null
    notice = null
  }
  /** The client for one call. The keys go here and nowhere else. */
  function client(endpoint: string, keys: RecordingKeys, attempts?: number): S3Client {
    return new S3Client({
      region: 'auto', endpoint, forcePathStyle: true,
      credentials: { accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey },
      ...(attempts ? { maxAttempts: attempts } : {}),
    })
  }
  function learn(asked: number, endpoint: string, bucket: string, outcome: 'ready' | UploadFailure, fromCheck: boolean): void {
    if (asked !== epoch) return
    if (outcome === 'ready' || outcome === 'bucket-not-found' || outcome === 'keys-rejected') {
      found = { endpoint, bucket, finding: outcome }
      notice = null
    } else if (fromCheck) {
      notice = outcome === 'offline' ? CHECK_NO_ANSWER_NOTICE : CHECK_FAILED_NOTICE
    }
  }

  async function runCheck(asked: number): Promise<RecordingStorageRow> {
    const { endpoint, bucket } = settings()
    const keys = resolveRecordingKeys(secrets)
    if (!keys) {
      if (asked === epoch) { found = null; notice = KEYS_UNREADABLE_NOTICE }
      return status()
    }
    // A name that could not be sent to this endpoint is not a bucket at this endpoint: nothing is asked.
    if (!sendableBucket(bucket)) {
      learn(asked, endpoint, bucket, 'bucket-not-found', true)
      return status()
    }
    let outcome: 'ready' | UploadFailure
    let s3: S3Client | null = null
    try {
      // One attempt, one request, at most one object named in the answer. A read: nothing is written.
      s3 = client(endpoint, keys, 1)
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }), { abortSignal: AbortSignal.timeout(timeoutMs) })
      // An address that answers 200 with something that is not a bucket listing is not a bucket.
      outcome = typeof listed?.Name === 'string' && listed.Name.length > 0 ? 'ready' : 'failed'
    } catch (error) {
      outcome = sortUploadFailure(error) // the error itself goes no further
    } finally {
      try { s3?.destroy() } catch { /* nothing to close */ }
    }
    learn(asked, endpoint, bucket, outcome, true)
    return status()
  }

  return {
    status,
    hasKeys,

    check() {
      if (status().state === 'not-set-up') return Promise.resolve(status())
      if (inFlight && inFlight.epoch === epoch) return inFlight.done
      const asked = epoch
      notice = null
      const done = runCheck(asked).catch(() => status()).then(() => {
        if (inFlight?.done === done) inFlight = null
        return changed()
      })
      inFlight = { epoch: asked, done }
      changed()
      return done
    },

    saveKeys(keys) {
      const typed = (keys ?? {}) as { accessKeyId?: unknown; secretAccessKey?: unknown }
      const accessKeyId = keyText(typed.accessKeyId)
      const secretAccessKey = keyText(typed.secretAccessKey)
      if (!accessKeyId || !secretAccessKey) return { success: false, error: KEYS_SHAPE_ERROR }
      try {
        secrets.write(SLOT, JSON.stringify({ accessKeyId, secretAccessKey }))
      } catch (error) {
        // The secrets module's own fixed sentence, or ours: never another error's text.
        return { success: false, error: error instanceof SecretsError ? error.message : KEYS_NOT_SAVED_ERROR }
      }
      forget()
      changed()
      return { success: true }
    },

    clearKeys() {
      try { secrets.clear(SLOT) } catch { return { success: false } }
      forget()
      changed()
      return { success: true }
    },

    settingsChanged() {
      forget()
      changed()
    },

    async upload(key, body, contentType) {
      const asked = epoch
      const { endpoint, bucket } = settings()
      if (!endpoint || !bucket) return { ok: false, failure: 'not-set-up' }
      const keys = resolveRecordingKeys(secrets)
      if (!keys) return { ok: false, failure: 'not-set-up' }
      let outcome: 'ready' | UploadFailure
      let s3: S3Client | null = null
      // As in a check: a name that could not be sent to this endpoint is refused, and nothing is sent.
      if (!sendableBucket(bucket)) outcome = 'bucket-not-found'
      else try {
        s3 = client(endpoint, keys)
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
        outcome = 'ready'
      } catch (error) {
        outcome = sortUploadFailure(error) // sorted to one word; the error is dropped, never logged
      } finally {
        try { s3?.destroy() } catch { /* nothing to close */ }
      }
      // An upload that was answered says as much about the row as a check does, and more.
      learn(asked, endpoint, bucket, outcome, false)
      changed()
      return outcome === 'ready' ? { ok: true } : { ok: false, failure: outcome }
    },

    takeNotice() {
      const said = options.retired ? retireRecordingConfig(options.retired) : null
      if (!said || setupNoticeGiven) return null
      setupNoticeGiven = true
      return said
    },
  }
}
