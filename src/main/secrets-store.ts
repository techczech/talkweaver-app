// The one secrets module (spec docs/plans/cloudflare-setup-in-app, decision D3).
//
// Every secret the main process keeps sits in a named slot here: `has / read / write / clear`. A slot
// is one file in the app's user-data folder holding what the operating system's own encryption
// returned for the secret's text (Electron `safeStorage`: the login Keychain on macOS, DPAPI on
// Windows, libsecret or KWallet on Linux). Four slots are the files earlier versions already wrote,
// with the same names, places and bytes, so an older install is read with no migration and a
// rolled-back install still reads what this version wrote. The fifth, `owner-tokens`, is new
// (owner-tokens.ts moves the share, run-results and pre-work tokens into it).
//
// What this defends, and what it does not. A slot file is useless to anyone who has the file but not
// this person's login on this computer: a backup, a synced or copied user-data folder, another
// account on the same machine, a stolen disk image without the login password. It is NOT a defence
// against code running as this person while they are logged in. On Windows any such process can ask
// DPAPI to decrypt the file; on macOS the Keychain asks before handing the key to a different
// application, which is a prompt, not a wall; on Linux any process on the session bus can ask the
// keyring. Such a party, or one that can write inside the user-data folder, can also delete or
// replace a slot file (the secret is then lost or swapped, never revealed) and can read anything the
// running app holds in memory. "Encryption unavailable" means: on macOS and Windows, `safeStorage`
// says so (before the app is ready, or the Keychain or profile key cannot be reached); on Linux,
// that or a session with no real keyring, where `safeStorage` would fall back to a fixed password
// (`basic_text`) or cannot name its backend (`unknown`). In every such case a write is refused with
// a message and nothing is written anywhere, in any form; a slot written earlier under a weak Linux
// backend is still read, since reading it exposes nothing more. Out of scope: secrets while in use
// (process memory, the environment handed to the bundled publishing tool), what the live service or
// Cloudflare keep, and files outside the user-data folder.
//
// No secret ever travels in an error from this module: every failure is a SecretsError with a fixed
// sentence, and the underlying error (which could quote decrypted text) is dropped, never attached.
//
// Shape: the logic here takes its cipher, platform and files as arguments, so it runs under plain
// Node in tests. The one file that touches Electron's `safeStorage` is secrets-store-electron.ts.
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Slot → its file in the user-data folder and how a message names what it holds. */
export const SECRET_SLOTS = {
  'cloudflare-token': { file: 'cf-pages-token.bin', what: 'the token' },
  'live-worker-credentials': { file: 'live-worker-credentials.bin', what: 'the live service keys' },
  'recording-keys': { file: 'recording-r2-creds.bin', what: 'the recording keys' },
  'live-sessions': { file: 'live-sessions.enc', what: 'live session recovery' },
  'owner-tokens': { file: 'owner-tokens.bin', what: 'share links' },
} as const

export type SecretSlot = keyof typeof SECRET_SLOTS
export const SECRET_SLOT_NAMES = Object.keys(SECRET_SLOTS) as SecretSlot[]

/** The three calls of Electron's `safeStorage` this module needs. */
export interface SecretsCipher {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(bytes: Buffer): string
}

/** The files a slot lives in. `read` throws an error with code ENOENT when the file is not there. */
export interface SecretsFiles {
  exists(path: string): boolean
  read(path: string): Buffer
  /** All of `bytes` at `path`, or the file as it was: never a part of it. */
  writeAtomic(path: string, bytes: Buffer): void
  /** Gone afterwards; no error when it was not there. */
  remove(path: string): void
}

export interface SecretsStoreOptions {
  /** The app's user-data folder. */
  dir: string
  cipher: SecretsCipher
  /** `process.platform` of the running app. */
  platform: string
  /** Linux only: `safeStorage.getSelectedStorageBackend()`. */
  backend?: () => string
  files?: SecretsFiles
}

export type SecretsAvailability = { ok: true } | { ok: false; reason: 'no-encryption' | 'weak-backend' }

export type SecretsFailure = 'unavailable' | 'unreadable' | 'not-saved' | 'not-removed'

/** The Linux backends that keep the key in a real keyring. Anything else is refused for writing. */
export const STRONG_LINUX_BACKENDS: readonly string[] = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The sentence a person sees for a failure. Fixed text: never a secret, never another error's text. */
export function secretsFailureMessage(code: SecretsFailure, slot: SecretSlot, doing: 'save' | 'read' = 'save'): string {
  const what = SECRET_SLOTS[slot].what
  if (code === 'unavailable') return `This computer's secure storage is unavailable, so ${what} cannot be ${doing === 'read' ? 'read' : 'saved'}`
  if (code === 'unreadable') return `${capital(what)} could not be read from this computer's secure storage.`
  if (code === 'not-removed') return `${capital(what)} could not be removed.`
  return `${capital(what)} could not be saved.`
}

export class SecretsError extends Error {
  readonly code: SecretsFailure
  readonly slot: SecretSlot
  constructor(code: SecretsFailure, slot: SecretSlot, doing: 'save' | 'read' = 'save') {
    super(secretsFailureMessage(code, slot, doing))
    this.name = 'SecretsError'
    this.code = code
    this.slot = slot
  }
}

export interface SecretsStore {
  /** Something is stored in the slot (its file is there). Decrypts nothing. */
  has(slot: SecretSlot): boolean
  /** The slot's text, or null when nothing is stored. Throws SecretsError when it cannot be read. */
  read(slot: SecretSlot): string | null
  /** Replace the slot's text. Throws SecretsError (and writes nothing) when it cannot be kept safely. */
  write(slot: SecretSlot, text: string): void
  /** Empty the slot. Throws SecretsError when the file could not be removed. */
  clear(slot: SecretSlot): void
  /** Whether a write would be accepted now. */
  availability(): SecretsAvailability
}

function isMissing(error: unknown): boolean {
  return Boolean(error) && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function pause(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* no pause available: retry at once */ }
}

/** The real files. A write is a private temporary file beside the target, flushed, then renamed over it. */
export const nodeSecretsFiles: SecretsFiles = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path),
  writeAtomic(path, bytes) {
    mkdirSync(dirname(path), { recursive: true })
    const refuseLink = () => {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('secrets-file-is-a-link')
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    refuseLink()
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      const handle = openSync(temporary, 'wx', 0o600)
      try {
        // One call may take only part of the bytes (a full disk, a network folder): every byte is
        // written, and the file's length is checked, before the rename may replace a good slot.
        for (let written = 0; written < bytes.length;) {
          const count = writeSync(handle, bytes, written, bytes.length - written)
          if (!Number.isInteger(count) || count <= 0) throw new Error('secrets-file-short-write')
          written += count
        }
        fsyncSync(handle)
        if (fstatSync(handle).size !== bytes.length) throw new Error('secrets-file-short-write')
      } finally {
        closeSync(handle)
      }
      refuseLink()
      // Windows refuses a rename while another program (a virus scanner, a backup) has the target
      // open; that passes within moments.
      for (let attempt = 0; ; attempt += 1) {
        try {
          renameSync(temporary, path)
          break
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
          pause(40 * (attempt + 1))
        }
      }
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* never made, or already renamed */ }
      throw error
    }
  },
  remove: (path) => rmSync(path, { force: true }),
}

export function createSecretsStore(options: SecretsStoreOptions): SecretsStore {
  const { cipher } = options
  const files = options.files ?? nodeSecretsFiles

  function pathOf(slot: SecretSlot): string {
    // Own-property lookup: a slot name from anywhere else ("constructor", "../x") names no file.
    if (!Object.prototype.hasOwnProperty.call(SECRET_SLOTS, slot)) throw new TypeError('Unknown secrets slot.')
    return join(options.dir, SECRET_SLOTS[slot].file)
  }

  function canDecrypt(): boolean {
    try { return cipher.isEncryptionAvailable() === true } catch { return false }
  }

  function availability(): SecretsAvailability {
    if (!canDecrypt()) return { ok: false, reason: 'no-encryption' }
    if (options.platform === 'linux') {
      let backend = 'unknown'
      try { backend = String(options.backend?.() ?? 'unknown') } catch { /* unknown */ }
      if (!STRONG_LINUX_BACKENDS.includes(backend)) return { ok: false, reason: 'weak-backend' }
    }
    return { ok: true }
  }

  return {
    has(slot) {
      const path = pathOf(slot)
      try { return files.exists(path) } catch { return false }
    },

    read(slot) {
      const path = pathOf(slot)
      let bytes: Buffer
      try {
        bytes = files.read(path)
      } catch (error) {
        if (isMissing(error)) return null
        throw new SecretsError('unreadable', slot)
      }
      if (!canDecrypt()) throw new SecretsError('unavailable', slot, 'read')
      let text: unknown
      try { text = cipher.decryptString(bytes) } catch { throw new SecretsError('unreadable', slot) }
      if (typeof text !== 'string') throw new SecretsError('unreadable', slot)
      return text
    },

    write(slot, text) {
      const path = pathOf(slot)
      if (typeof text !== 'string' || text.length === 0) throw new TypeError('A secrets slot takes non-empty text.')
      if (!availability().ok) throw new SecretsError('unavailable', slot)
      let bytes: Buffer
      try { bytes = cipher.encryptString(text) } catch { throw new SecretsError('unavailable', slot) }
      // What is about to be written must decrypt to what was given; plain text is never written.
      let back: unknown
      try { back = cipher.decryptString(bytes) } catch { back = undefined }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || back !== text) throw new SecretsError('unavailable', slot)
      // A cipher that hands the text back unchanged is not encryption (too short a text could match by chance).
      if (text.length >= 8 && bytes.includes(Buffer.from(text, 'utf8'))) throw new SecretsError('unavailable', slot)
      try { files.writeAtomic(path, bytes) } catch { throw new SecretsError('not-saved', slot) }
    },

    clear(slot) {
      const path = pathOf(slot)
      try { files.remove(path) } catch { throw new SecretsError('not-removed', slot) }
    },

    availability,
  }
}

/** One slot of a store, for a module that keeps a single secret (live-session-store.ts). */
export interface SecretsSlot {
  has(): boolean
  read(): string | null
  write(text: string): void
  clear(): void
  /** Throws the refusal when a write would not be accepted now. */
  check(): void
}

export function secretsSlot(store: SecretsStore, slot: SecretSlot): SecretsSlot {
  return {
    has: () => store.has(slot),
    read: () => store.read(slot),
    write: (text) => store.write(slot, text),
    clear: () => store.clear(slot),
    check() {
      if (!store.availability().ok) throw new SecretsError('unavailable', slot)
    },
  }
}
