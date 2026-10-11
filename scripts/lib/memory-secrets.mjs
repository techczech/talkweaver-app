// Stand-ins for tests of the secrets module and what sits on it: files held in memory, a cipher that
// is reversible but never leaves its input readable, and the real store and owner-token logic over
// them (src/main/secrets-store.ts, src/main/owner-tokens.ts). No Electron, no disk, no real secret.
import { createSecretsStore } from '../../src/main/secrets-store.ts'
import { createOwnerTokens } from '../../src/main/owner-tokens.ts'

const missing = (path) => Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })

/** SecretsFiles over a Map. `knobs.failWrites` / `knobs.failReads` make the next calls throw. */
export function memoryFiles() {
  const blobs = new Map()
  const knobs = { failWrites: false, failReads: false, failRemoves: false, writes: 0 }
  return {
    blobs, knobs,
    exists: (path) => blobs.has(path),
    read(path) {
      if (knobs.failReads) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      if (!blobs.has(path)) throw missing(path)
      return Buffer.from(blobs.get(path))
    },
    writeAtomic(path, bytes) {
      if (knobs.failWrites) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      knobs.writes += 1
      blobs.set(path, Buffer.from(bytes))
    },
    remove(path) {
      if (knobs.failRemoves) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      blobs.delete(path)
    },
  }
}

/** A cipher in the shape of Electron's safeStorage. `state.available` and `state.locked` are knobs. */
export function testCipher() {
  const state = { available: true, locked: false }
  const MARK = Buffer.from('tst1')
  return {
    state,
    isEncryptionAvailable: () => state.available,
    encryptString(text) {
      if (!state.available) throw new Error('encryption is not available')
      return Buffer.concat([MARK, Buffer.from(text, 'utf8').map((byte) => byte ^ 0x5a)])
    },
    decryptString(bytes) {
      if (!state.available || state.locked) throw new Error('decryption failed')
      if (!Buffer.isBuffer(bytes) || bytes.subarray(0, MARK.length).compare(MARK) !== 0) throw new Error('not a ciphertext')
      return Buffer.from(bytes.subarray(MARK.length).map((byte) => byte ^ 0x5a)).toString('utf8')
    },
  }
}

/** The real store over memory. `dir` is only a name here. */
export function memorySecrets({ dir = 'user-data', platform = 'darwin', backend } = {}) {
  const files = memoryFiles()
  const cipher = testCipher()
  const store = createSecretsStore({ dir, cipher, platform, backend, files })
  return { store, files, cipher, dir }
}

/** Owner tokens over a fresh in-memory store: what the registry modules take as `ownerTokens`. */
export function memoryOwnerTokens(secrets = memorySecrets()) {
  return Object.assign(createOwnerTokens(secrets.store, { now: () => 0 }), { secrets })
}
