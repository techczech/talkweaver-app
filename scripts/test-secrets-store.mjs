// The secrets module (src/main/secrets-store.ts; spec "Cloudflare set-up in the app", D3), under
// plain Node with an injected cipher, so it runs on every platform:
// 1. each slot: has / read / write / clear, at the file earlier versions used, holding exactly what
//    the cipher returned;
// 2. what earlier versions wrote is read, and what this module writes is read by their code;
// 3. encryption unavailable: every write refused with the spec's sentence, nothing written;
// 4. the platform rule (Linux backends), from injected values;
// 5. no failure carries a secret or another error's text;
// 6. the real files: written whole or not at all, private, no temporary file left;
// 7. no other file in src/ touches safeStorage, or names a slot's file.
// The real safeStorage round trip is e2e/diagnose-secrets-store.mjs (Electron).
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  SECRET_SLOTS, SECRET_SLOT_NAMES, STRONG_LINUX_BACKENDS, SecretsError, createSecretsStore, nodeSecretsFiles, secretsFailureMessage, secretsSlot,
} from '../src/main/secrets-store.ts'
import { createLiveSessionStore } from '../src/main/live-session-store.ts'
import { memoryFiles, memorySecrets, testCipher } from './lib/memory-secrets.mjs'
import { readSource } from './lib/read-source.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const posix = process.platform !== 'win32'
// Made-up values. A failed assertion never prints one: comparisons below go through `same`.
const FAKE = {
  'cloudflare-token': 'test-token-cloudflare-0001',
  'live-worker-credentials': JSON.stringify({ adminSecret: 'test-token-admin-0002', signingSecret: 'test-token-signing-0003' }),
  'recording-keys': JSON.stringify({ accessKeyId: 'test-token-keyid-0004', secretAccessKey: 'test-token-keysecret-0005' }),
  'live-sessions': JSON.stringify({ version: 1, sessions: [] }),
  'owner-tokens': JSON.stringify({ version: 1, tokens: { 'share:abcd2345@https://live.example.test': 'test-token-owner-0006' } }),
}
const same = (actual, expected, what) => assert.ok(actual === expected, what)
const holds = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle))
/** Everything an error could show somewhere: message, stack, its own fields, its cause. */
const errorText = (error) => [String(error), error?.message, error?.stack, JSON.stringify(error), String(error?.cause ?? ''), JSON.stringify(Object.getOwnPropertyNames(error ?? {}).map((name) => String(error[name])))].join('\n')

// ── 1. Slots ────────────────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(SECRET_SLOT_NAMES, ['cloudflare-token', 'live-worker-credentials', 'recording-keys', 'live-sessions', 'owner-tokens'])
  // The four files earlier versions wrote keep their names.
  assert.equal(SECRET_SLOTS['cloudflare-token'].file, 'cf-pages-token.bin')
  assert.equal(SECRET_SLOTS['live-worker-credentials'].file, 'live-worker-credentials.bin')
  assert.equal(SECRET_SLOTS['recording-keys'].file, 'recording-r2-creds.bin')
  assert.equal(SECRET_SLOTS['live-sessions'].file, 'live-sessions.enc')
  for (const slot of SECRET_SLOT_NAMES) {
    const { store, files, cipher, dir } = memorySecrets()
    const path = join(dir, SECRET_SLOTS[slot].file)
    assert.equal(store.has(slot), false, `${slot}: empty at first`)
    assert.equal(store.read(slot), null, `${slot}: reads null when empty`)
    store.write(slot, FAKE[slot])
    assert.equal(store.has(slot), true, `${slot}: has after a write`)
    same(store.read(slot), FAKE[slot], `${slot}: reads back what was written`)
    assert.deepEqual([...files.blobs.keys()], [path], `${slot}: one file, at its own name in the user-data folder`)
    assert.ok(files.blobs.get(path).equals(cipher.encryptString(FAKE[slot])), `${slot}: the file is exactly what the cipher returned`)
    assert.equal(holds(files.blobs.get(path), FAKE[slot]), false, `${slot}: the file does not hold the text`)
    store.write(slot, `${FAKE[slot]} `)
    same(store.read(slot), `${FAKE[slot]} `, `${slot}: a write replaces`)
    store.clear(slot)
    assert.equal(store.has(slot), false, `${slot}: gone after clear`)
    assert.equal(store.read(slot), null)
    assert.doesNotThrow(() => store.clear(slot), `${slot}: clearing an empty slot is not an error`)
    // Slots do not see each other.
    store.write(slot, FAKE[slot])
    for (const other of SECRET_SLOT_NAMES) if (other !== slot) assert.equal(store.has(other), false)
  }
  const { store, files } = memorySecrets()
  for (const bad of ['constructor', '__proto__', 'toString', '../cf-pages-token.bin', 'cf-pages-token.bin', '', undefined]) {
    assert.throws(() => store.read(bad), TypeError, 'an unknown slot names no file')
    assert.throws(() => store.write(bad, 'test-token-unknown-slot'), TypeError)
    assert.throws(() => store.has(bad), TypeError)
    assert.throws(() => store.clear(bad), TypeError)
  }
  for (const empty of ['', null, undefined, 7, Buffer.from('x')]) assert.throws(() => store.write('cloudflare-token', empty), TypeError, 'only non-empty text is stored')
  assert.equal(files.blobs.size, 0)
  // One slot of a store.
  const slot = secretsSlot(store, 'live-sessions')
  slot.write(FAKE['live-sessions'])
  assert.equal(slot.has(), true)
  same(slot.read(), FAKE['live-sessions'], 'a slot handle reads its slot')
  assert.doesNotThrow(() => slot.check())
  slot.clear()
  assert.equal(store.has('live-sessions'), false)
  console.log('PASS 1: five slots, each at its own file; has / read / write / clear; unknown slots and empty text refused')
}

// ── 2. On-disk compatibility with what earlier versions wrote (the same cipher on both sides) ────
// The earlier code, reproduced from src/main/index.ts and src/main/live-session-store.ts as they
// were before this module: three slots were `writeFileSync(path, safeStorage.encryptString(text))`,
// read with `safeStorage.decryptString(readFileSync(path))`; live-session recovery was written to
// `path + '.tmp'` with mode 0600 and renamed.
{
  const dir = mkdtempSync(join(tmpdir(), 'tw-secrets-compat-'))
  try {
    const cipher = testCipher()
    const store = createSecretsStore({ dir, cipher, platform: process.platform === 'linux' ? 'darwin' : process.platform })
    const earlier = {
      write(slot, text) {
        const path = join(dir, SECRET_SLOTS[slot].file)
        if (slot === 'live-sessions') {
          const temporary = path + '.tmp'
          writeFileSync(temporary, cipher.encryptString(text), { mode: 0o600 })
          renameSync(temporary, path)
        } else writeFileSync(path, cipher.encryptString(text))
      },
      read: (slot) => cipher.decryptString(readFileSync(join(dir, SECRET_SLOTS[slot].file))),
      exists: (slot) => existsSync(join(dir, SECRET_SLOTS[slot].file)),
    }
    const old = ['cloudflare-token', 'live-worker-credentials', 'recording-keys', 'live-sessions']
    for (const slot of old) {
      earlier.write(slot, FAKE[slot])
      assert.equal(store.has(slot), true, `${slot}: an earlier version's file is seen`)
      same(store.read(slot), FAKE[slot], `${slot}: an earlier version's file is read with no migration`)
      const before = readFileSync(join(dir, SECRET_SLOTS[slot].file))
      store.write(slot, FAKE[slot])
      assert.ok(readFileSync(join(dir, SECRET_SLOTS[slot].file)).equals(before), `${slot}: this module writes the same bytes the earlier code did`)
      store.clear(slot)
      assert.equal(earlier.exists(slot), false, `${slot}: cleared here is gone for the earlier code`)
      store.write(slot, FAKE[slot])
      same(earlier.read(slot), FAKE[slot], `${slot}: what this module writes, the earlier code reads (a rolled-back install)`)
    }
    // Live-session recovery end to end: earlier record on disk → today's store, and back.
    const record = {
      sessionId: 's1', baseUrl: 'https://live.example.test', presenterToken: 'test-token-presenter-0007', shortId: 'ab', shortUrl: 'https://x.test/ab', qrSvg: '',
      talkSlug: 'talk', vaultRoot: null, expiresAt: Date.now() + 60_000, startedAtMs: Date.now(), status: 'live', endRequested: false,
      pending: [], polls: [], voteRecords: [], cursor: 0, latest: null,
    }
    earlier.write('live-sessions', JSON.stringify({ version: 1, sessions: [record] }))
    const recovery = createLiveSessionStore(secretsSlot(store, 'live-sessions'))
    same(recovery.load()[0].presenterToken, record.presenterToken, 'recovery written by an earlier version loads')
    recovery.save([{ ...record, cursor: 4 }])
    assert.equal(JSON.parse(earlier.read('live-sessions')).sessions[0].cursor, 4, 'recovery saved here is the earlier format: {version: 1, sessions}')
    assert.equal(JSON.parse(earlier.read('live-sessions')).version, 1)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  console.log('PASS 2: files written the earlier way are read; files written here are read the earlier way; same bytes')
}

// ── 3. Encryption unavailable: refused, and nothing written ─────────────────────────────────────
{
  const SPEC = "This computer's secure storage is unavailable, so the token cannot be saved"
  assert.equal(secretsFailureMessage('unavailable', 'cloudflare-token'), SPEC, "the spec's sentence (state table: Secrets store unavailable)")
  for (const slot of SECRET_SLOT_NAMES) {
    const { store, files, cipher } = memorySecrets()
    cipher.state.available = false
    assert.deepEqual(store.availability(), { ok: false, reason: 'no-encryption' })
    let thrown
    try { store.write(slot, FAKE[slot]) } catch (error) { thrown = error }
    assert.ok(thrown instanceof SecretsError, `${slot}: a write is refused`)
    assert.equal(thrown.code, 'unavailable')
    assert.equal(thrown.message, `This computer's secure storage is unavailable, so ${SECRET_SLOTS[slot].what} cannot be saved`)
    assert.equal(files.blobs.size, 0, `${slot}: nothing is written, in any form`)
    assert.equal(files.knobs.writes, 0)
    assert.throws(() => secretsSlot(store, slot).check(), SecretsError)
    // Something stored earlier is not readable now, and says so (never null, which would mean "nothing stored").
    cipher.state.available = true
    store.write(slot, FAKE[slot])
    cipher.state.available = false
    assert.equal(store.has(slot), true)
    assert.throws(() => store.read(slot), (error) => error instanceof SecretsError && error.code === 'unavailable' && /cannot be read$/.test(error.message))
    const kept = Buffer.from([...files.blobs.values()][0])
    assert.throws(() => store.write(slot, 'test-token-replacement-0008'), SecretsError)
    assert.ok([...files.blobs.values()][0].equals(kept), `${slot}: a refused write leaves what was stored`)
  }
  // A cipher that says it is available but is not one: refused too.
  for (const broken of [
    { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text, 'utf8'), decryptString: (bytes) => bytes.toString('utf8') },
    { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.concat([Buffer.from('v10'), Buffer.from(text, 'utf8')]), decryptString: (bytes) => bytes.subarray(3).toString('utf8') },
    { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('zzzz'), decryptString: () => 'something else' },
    { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('no key') }, decryptString: () => '' },
    { isEncryptionAvailable: () => { throw new Error('not ready') }, encryptString: (text) => Buffer.from(text), decryptString: (bytes) => String(bytes) },
    { isEncryptionAvailable: () => 'yes', encryptString: (text) => Buffer.from(text).reverse(), decryptString: (bytes) => Buffer.from(bytes).reverse().toString() },
  ]) {
    const files = memoryFiles()
    const store = createSecretsStore({ dir: 'user-data', cipher: broken, platform: 'win32', files })
    assert.throws(() => store.write('cloudflare-token', FAKE['cloudflare-token']), (error) => error instanceof SecretsError && error.code === 'unavailable')
    assert.equal(files.blobs.size, 0, 'a cipher that does not encrypt writes nothing')
  }
  console.log('PASS 3: encryption unavailable → every slot refuses with the sentence, nothing is written, nothing falls back to plain text')
}

// ── 4. The platform rule, from injected values ──────────────────────────────────────────────────
{
  const on = (platform, backend) => {
    const files = memoryFiles()
    const cipher = testCipher()
    return { files, cipher, store: createSecretsStore({ dir: 'user-data', cipher, platform, backend, files }) }
  }
  for (const backend of STRONG_LINUX_BACKENDS) {
    const { store } = on('linux', () => backend)
    assert.deepEqual(store.availability(), { ok: true }, `linux ${backend}: a real keyring`)
    store.write('cloudflare-token', FAKE['cloudflare-token'])
    same(store.read('cloudflare-token'), FAKE['cloudflare-token'], 'and it round-trips')
  }
  for (const backend of [() => 'basic_text', () => 'unknown', () => '', () => 'BASIC_TEXT', () => undefined, () => { throw new Error('no backend') }, undefined]) {
    const { store, files, cipher } = on('linux', backend)
    assert.deepEqual(store.availability(), { ok: false, reason: 'weak-backend' }, 'linux without a real keyring is refused')
    assert.throws(() => store.write('cloudflare-token', FAKE['cloudflare-token']), (error) => error instanceof SecretsError && error.message === secretsFailureMessage('unavailable', 'cloudflare-token'))
    assert.equal(files.blobs.size, 0, 'nothing is written under a weak backend')
    // A slot written earlier under it is still read: reading exposes nothing more.
    files.blobs.set(join('user-data', 'cf-pages-token.bin'), cipher.encryptString(FAKE['cloudflare-token']))
    same(store.read('cloudflare-token'), FAKE['cloudflare-token'], 'an earlier file is still read')
  }
  // macOS and Windows have one backend each; a backend value there is not consulted.
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(on(platform, () => 'basic_text').store.availability(), { ok: true }, `${platform}: availability is safeStorage's own answer`)
    const { store, cipher } = on(platform)
    cipher.state.available = false
    assert.deepEqual(store.availability(), { ok: false, reason: 'no-encryption' })
  }
  console.log('PASS 4: Linux writes only with a real keyring backend; macOS and Windows follow isEncryptionAvailable')
}

// ── 5. No failure carries a secret, or another error's text ─────────────────────────────────────
{
  const SECRET = 'test-token-leak-probe-0009'
  const quoting = (inner) => new Error(`failed near "${SECRET}" (${inner})`)
  const cases = []
  const run = (label, act) => {
    let thrown = null
    try { act() } catch (error) { thrown = error }
    assert.ok(thrown instanceof SecretsError, `${label}: fails with a SecretsError`)
    assert.equal(holds(errorText(thrown), SECRET), false, `${label}: the failure does not carry the secret`)
    assert.equal(holds(errorText(thrown), 'failed near'), false, `${label}: nor the underlying error's text`)
    assert.equal(thrown.cause, undefined, `${label}: no cause is attached`)
    assert.equal(thrown.message, secretsFailureMessage(thrown.code, thrown.slot, /cannot be read$/.test(thrown.message) ? 'read' : 'save'), `${label}: the message is the fixed sentence`)
    cases.push(thrown.code)
  }
  const base = testCipher()
  {
    const files = memoryFiles()
    const store = createSecretsStore({ dir: 'd', platform: 'darwin', files, cipher: { ...base, encryptString: () => { throw quoting('encrypt') } } })
    run('encrypt throws', () => store.write('cloudflare-token', SECRET))
  }
  {
    const files = memoryFiles()
    const store = createSecretsStore({ dir: 'd', platform: 'darwin', files, cipher: base })
    store.write('cloudflare-token', SECRET)
    const failing = createSecretsStore({ dir: 'd', platform: 'darwin', files, cipher: { ...base, decryptString: () => { throw quoting('decrypt') } } })
    run('decrypt throws', () => failing.read('cloudflare-token'))
    files.writeAtomic = () => { throw quoting('disk') }
    run('the write fails', () => store.write('cloudflare-token', `${SECRET}-next`))
    same(store.read('cloudflare-token'), SECRET, 'a failed write leaves the slot as it was')
    files.read = () => { throw quoting('read') }
    run('the file cannot be read', () => store.read('cloudflare-token'))
    files.remove = () => { throw quoting('remove') }
    run('the file cannot be removed', () => store.clear('cloudflare-token'))
    files.exists = () => { throw quoting('exists') }
    assert.equal(store.has('cloudflare-token'), false, 'has never throws')
  }
  {
    const files = memoryFiles()
    createSecretsStore({ dir: 'd', platform: 'darwin', files, cipher: base }).write('cloudflare-token', SECRET)
    const store = createSecretsStore({ dir: 'd', platform: 'darwin', files, cipher: { ...base, decryptString: () => 42 } })
    run('decrypt returns no text', () => store.read('cloudflare-token'))
  }
  assert.deepEqual([...new Set(cases)].sort(), ['not-removed', 'not-saved', 'unavailable', 'unreadable'])
  // Live-session recovery: text that is not JSON is reported in fixed words, never quoted.
  const { store } = memorySecrets()
  store.write('live-sessions', `{"sessions": ${SECRET}`)
  let message = ''
  try { createLiveSessionStore(secretsSlot(store, 'live-sessions')).load() } catch (error) { message = errorText(error) }
  assert.ok(message.includes('Live session recovery data could not be read.'))
  assert.equal(holds(message, SECRET), false, 'the JSON parser\'s quote of the text never leaves the store')
  console.log('PASS 5: every failure is a fixed sentence; no secret, cause or underlying text travels in it')
}

// ── 6. The real files ───────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'tw-secrets-files-'))
  try {
    const cipher = testCipher()
    const nested = join(dir, 'not', 'made', 'yet')
    const store = createSecretsStore({ dir: nested, cipher, platform: 'darwin' })
    store.write('cloudflare-token', FAKE['cloudflare-token'])
    const path = join(nested, 'cf-pages-token.bin')
    assert.ok(readFileSync(path).equals(cipher.encryptString(FAKE['cloudflare-token'])), 'the folder is made and the file is the cipher\'s bytes')
    assert.deepEqual(readdirSync(nested), ['cf-pages-token.bin'], 'no temporary file is left')
    if (posix) assert.equal(statSync(path).mode & 0o777, 0o600, 'the file is private to this account')
    assert.equal(holds(readFileSync(path), FAKE['cloudflare-token']), false)
    // A write that cannot finish leaves the earlier contents whole.
    const before = readFileSync(path)
    const blocked = createSecretsStore({
      dir: nested, cipher, platform: 'darwin',
      files: { ...nodeSecretsFiles, writeAtomic: (target, bytes) => nodeSecretsFiles.writeAtomic(join(target, 'cannot-be-a-folder'), bytes) },
    })
    assert.throws(() => blocked.write('cloudflare-token', 'test-token-never-lands-0010'), (error) => error instanceof SecretsError && error.code === 'not-saved')
    assert.ok(readFileSync(path).equals(before), 'the slot is as it was')
    assert.deepEqual(readdirSync(nested), ['cf-pages-token.bin'])
    assert.equal(store.read('recording-keys'), null, 'a missing file is "nothing stored"')
    store.clear('cloudflare-token')
    assert.deepEqual(readdirSync(nested), [])
    // A write call that takes only part of the bytes (a full disk, a network folder): the slot ends
    // up whole, never cut short.
    const realWrite = fs.writeSync
    const during = (stand, run) => {
      fs.writeSync = stand
      syncBuiltinESMExports()
      try { return run() } finally { fs.writeSync = realWrite; syncBuiltinESMExports() }
    }
    let calls = 0
    during((handle, bytes, offset = 0, length = bytes.length - offset) => { calls += 1; return realWrite(handle, bytes, offset, Math.min(length, 5)) },
      () => store.write('cloudflare-token', FAKE['cloudflare-token']))
    assert.ok(readFileSync(path).equals(cipher.encryptString(FAKE['cloudflare-token'])), 'a write taken a few bytes at a time still lands whole')
    assert.ok(calls > 1, 'the stand-in really took the bytes a few at a time')
    assert.equal(store.read('cloudflare-token'), FAKE['cloudflare-token'])
    // A write that reports more than it put on the disk, and one that takes nothing: refused, the slot as it was.
    const whole = readFileSync(path)
    for (const stand of [
      (handle, bytes, offset = 0, length = bytes.length - offset) => { realWrite(handle, bytes, offset, Math.min(length, 5)); return length },
      () => 0,
    ]) {
      assert.throws(() => during(stand, () => store.write('cloudflare-token', 'test-token-cut-short-0011')), (error) => error instanceof SecretsError && error.code === 'not-saved')
      assert.ok(readFileSync(path).equals(whole), 'a short write never replaces a good slot')
      assert.deepEqual(readdirSync(nested), ['cf-pages-token.bin'], 'and leaves no temporary file')
    }
    store.clear('cloudflare-token')
    if (posix) {
      // A link where the slot's file should be is refused, not followed.
      const elsewhere = join(dir, 'elsewhere.bin')
      writeFileSync(elsewhere, 'untouched')
      mkdirSync(nested, { recursive: true })
      symlinkSync(elsewhere, path)
      assert.throws(() => store.write('cloudflare-token', FAKE['cloudflare-token']), (error) => error instanceof SecretsError && error.code === 'not-saved')
      assert.equal(readFileSync(elsewhere, 'utf8'), 'untouched', 'a link at the slot\'s path is never written through')
      assert.deepEqual(readdirSync(nested), ['cf-pages-token.bin'], 'and the refused write leaves no temporary file')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
  console.log('PASS 6: real files are written whole or not at all, private, with no temporary file left')
}

// ── 7. One door: no other file touches safeStorage or names a slot's file ───────────────────────
{
  const sources = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) sources.push(path)
    }
  }
  walk(join(repo, 'src'))
  assert.ok(sources.length > 100, 'the scan saw the source tree')
  const name = (path) => relative(repo, path).split(sep).join('/')
  /** Identifiers and string literals in a file's code (comments are not code). */
  const tokensOf = (path) => {
    const identifiers = new Set()
    const strings = []
    const file = ts.createSourceFile(path, readSource(path), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node) => {
      if (ts.isIdentifier(node)) identifiers.add(node.text)
      else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) strings.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(file)
    return { identifiers, strings }
  }
  const touching = []
  const naming = []
  const slotFiles = Object.values(SECRET_SLOTS).map((slot) => slot.file)
  for (const path of sources) {
    const { identifiers, strings } = tokensOf(path)
    if (identifiers.has('safeStorage') || strings.some((text) => text.includes('safeStorage'))) touching.push(name(path))
    if (strings.some((text) => slotFiles.some((file) => text.includes(file)))) naming.push(name(path))
  }
  assert.deepEqual(touching, ['src/main/secrets-store-electron.ts'], 'only the secrets module\'s Electron side touches safeStorage')
  assert.deepEqual(naming, ['src/main/secrets-store.ts'], 'only the secrets module names a slot\'s file')
  // And that one file gets it from Electron and hands it to nothing but the store.
  const electronSide = readSource(join(repo, 'src/main/secrets-store-electron.ts'))
  assert.match(electronSide, /import \{ safeStorage \} from 'electron'/)
  assert.match(electronSide, /getSelectedStorageBackend/, 'the Linux backend is asked for')
  // The main process opens the store once and builds nothing of its own beside it.
  const main = tokensOf(join(repo, 'src/main/index.ts'))
  assert.ok(main.identifiers.has('openSecretsStore'))
  for (const gone of ['tokenBlobPath', 'r2CredsBlobPath', 'liveCredentialsBlobPath']) assert.equal(main.identifiers.has(gone), false, `${gone} is gone from the main process`)
  console.log('PASS 7: safeStorage is touched by one file; slot files are named by one file')
}

console.log('secrets store: slots, earlier-version files, refusal, platform rule, silent failures, real files, one door — passed')
