// Owner tokens in the secrets store (src/main/owner-tokens.ts; spec "Cloudflare set-up in the app",
// D3 and "Migration for existing installs"), with an in-memory store double:
// 1. the token store: kept only when a fresh read gives the token back; never written over when it
//    cannot be read;
// 2. migration, for each of the three registries: registry in → store + rewritten registry out;
//    twice is harmless;
// 3. interrupted migration: at every stopping point each token is still usable on the next start;
// 4. writes: a new token is never written in plain text; rows the store cannot give back are kept;
// 5. going back to an earlier version: what it sees, and the restore that puts the tokens back;
// 6. shares, run-results links and pre-work made before the change still work (the real modules);
// 7. the review of the first build: rows behind a locked store survive its unlocking; a token never
//    travels in an error; nothing is published before its token is kept; a registry that cannot be
//    parsed is never written over; an incomplete restore says so.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OWNER_TOKEN_REGISTRIES, OWNER_TOKEN_REGISTRY_NAMES, OwnerRegistryError, OwnerRequestError, createOwnerTokens, incompleteOwnerTokenRestores,
  migrateOwnerTokens, nodeRegistryFiles, openOwnerTokenRegistry, ownerFetch, ownerTokenKey, restorePlainOwnerTokens, validOwnerToken,
} from '../src/main/owner-tokens.ts'
import { SecretsError, secretsFailureMessage } from '../src/main/secrets-store.ts'
import { RESULTS_LINK_LOCKED, RESULTS_LINK_NOT_KEPT, RESULTS_LINK_NOT_KEPT_OPEN, RESULTS_LINK_NOT_REACHED, createRunResultsShares } from '../src/main/run-results-share.ts'
import { PREWORK_FORM_NOT_REACHED, PREWORK_LOCKED, PREWORK_NOT_KEPT, PREWORK_NOT_KEPT_OPEN, createRunPrework } from '../src/main/run-prework.ts'
import { SHARE_LOCKED, SHARE_NOT_KEPT, SHARE_NOT_KEPT_OPEN, createSharedTalks } from '../src/main/shared-talk.ts'
import { memoryOwnerTokens, memorySecrets } from './lib/memory-secrets.mjs'

const posix = process.platform !== 'win32'
const ORIGIN = 'https://live.example.test'
const REFUSAL = secretsFailureMessage('unavailable', 'owner-tokens')
const holds = (text, needle) => String(text).includes(needle)
const same = (actual, expected, what) => assert.ok(actual === expected, what)
const scratch = mkdtempSync(join(tmpdir(), 'tw-owner-tokens-'))
let folders = 0
const folder = () => {
  const dir = join(scratch, `user-data-${folders += 1}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
/** Every made-up token in this file starts with this, so "no token on disk" is one search. */
const MARK = 'test-token-owner-'

/** A registry as an EARLIER version wrote it: rows carrying `ownerToken`, the earlier layout. */
const LEGACY = {
  'shared-talk': (n = 2) => ({
    version: 2,
    shares: Object.fromEntries(Array.from({ length: n }, (_, i) => {
      const outlinePath = join(scratch, 'vault', `talk-${i}`, `talk-${i}-outline.md`)
      return [`id:${outlinePath}`, {
        key: `id:${outlinePath}`, slug: `talk-${i}`, workerSlug: `talk-${i}-0123456789`, outlinePath, realPath: outlinePath,
        shareId: `shtalk0${i}`, ownerToken: `${MARK}share-${i}-0123456789`, workerBaseUrl: ORIGIN, revision: 3, liveUpdates: true, proposals: true,
        createdAt: '2026-09-01T10:00:00.000Z', lastPushedAt: '2026-09-01T10:05:00.000Z', lastPushHash: 'abc', ended: null,
      }]
    })),
  }),
  'run-results': (n = 2) => ({
    version: 1,
    shares: Object.fromEntries(Array.from({ length: n }, (_, i) => [`talk-${i}/run-${i}`, {
      key: `talk-${i}/run-${i}`, shareId: `results${i}`, ownerToken: `${MARK}results-${i}-0123456789`, workerBaseUrl: ORIGIN,
      include: { board: true, polls: true, prework: false }, lifetime: 'forever', expiresAt: null, createdAt: 1, pushedAt: 2, title: `Talk ${i}`,
    }])),
  }),
  'run-prework': (n = 2) => ({
    version: 1,
    preworks: Object.fromEntries(Array.from({ length: n }, (_, i) => [`talk-${i}/run-${i}`, {
      key: `talk-${i}/run-${i}`, preworkId: `prework${i}`, ownerToken: `${MARK}prework-${i}-0123456789`, workerBaseUrl: ORIGIN,
      opensAt: 1000, closesAt: 9_000_000_000_000, cursor: 4, createdAt: 1,
    }])),
  }),
}
const rowsIn = (name, doc) => doc[OWNER_TOKEN_REGISTRIES[name].collection]
const keyFor = (name, row) => ownerTokenKey(OWNER_TOKEN_REGISTRIES[name].kind, row[OWNER_TOKEN_REGISTRIES[name].idField], row.workerBaseUrl)
/** How the earlier writers put a registry on disk (pretty JSON; two of the three ended with a newline). */
const writeLegacy = (path, doc) => writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
/** How an EARLIER version decided a row was usable: it needed the token in the row. */
const earlierVersionSees = (name, path) => Object.values(rowsIn(name, JSON.parse(readFileSync(path, 'utf8')))).filter((row) => typeof row.ownerToken === 'string' && row.ownerToken.length >= 16)
/** No made-up token anywhere in a folder's files (any name, any depth). */
function tokensOnDisk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...tokensOnDisk(path))
    else if (readFileSync(path).includes(Buffer.from(MARK))) found.push(entry.name)
  }
  return found
}
/** Registry files over the real ones, with a switch that makes the next write throw (a crash). */
function crashingFiles() {
  const knobs = { crashWrites: 0 }
  return {
    knobs,
    files: {
      ...nodeRegistryFiles,
      writeAtomic(path, text) {
        if (knobs.crashWrites > 0) { knobs.crashWrites -= 1; throw new Error('power cut') }
        nodeRegistryFiles.writeAtomic(path, text)
      },
    },
  }
}

// ── 1. The token store ──────────────────────────────────────────────────────────────────────────
{
  const secrets = memorySecrets()
  let time = 0
  const tokens = createOwnerTokens(secrets.store, { now: () => time })
  const A = ownerTokenKey('share', 'shtalk00', ORIGIN)
  const B = ownerTokenKey('results', 'results0', ORIGIN)
  assert.equal(A, `share:shtalk00@${ORIGIN}`)
  for (const [id, origin] of [['internal', ORIGIN], ['../../x', ORIGIN], ['', ORIGIN], [7, ORIGIN], ['shtalk00', ''], ['shtalk00', null]]) {
    assert.equal(ownerTokenKey('share', id, origin), null, 'a row without a real id and service address has no key')
  }
  assert.equal(validOwnerToken('short'), false)
  assert.equal(tokens.get(A), null)
  assert.equal(tokens.readable(), true, 'an empty store is readable')
  assert.deepEqual([...tokens.store({ [A]: `${MARK}a-0123456789`, [B]: `${MARK}b-0123456789` })].sort(), [B, A].sort())
  same(tokens.get(A), `${MARK}a-0123456789`, 'a stored token is read back')
  const blob = () => [...secrets.files.blobs.entries()]
  assert.deepEqual(blob().map(([path]) => path), [join(secrets.dir, 'owner-tokens.bin')], 'one encrypted file, the owner-tokens slot')
  assert.equal(blob()[0][1].includes(Buffer.from(MARK)), false, 'the slot file holds no readable token')
  // Another instance (the next start) reads the same tokens.
  same(createOwnerTokens(secrets.store).get(B), `${MARK}b-0123456789`, 'the next start reads them')
  // Storing what is already there writes nothing.
  const writes = secrets.files.knobs.writes
  assert.deepEqual([...tokens.store({ [A]: `${MARK}a-0123456789` })], [A])
  assert.equal(secrets.files.knobs.writes, writes, 'a token already kept is not written again')
  // Not kept: too short, a write that fails, a write that does not stick.
  assert.deepEqual([...tokens.store({ [ownerTokenKey('share', 'shtalk09', ORIGIN)]: 'short' })], [])
  secrets.files.knobs.failWrites = true
  const C = ownerTokenKey('prework', 'prework0', ORIGIN)
  assert.deepEqual([...tokens.store({ [C]: `${MARK}c-0123456789` })], [], 'a failed write keeps nothing new')
  assert.deepEqual([...tokens.store({ [A]: `${MARK}a-0123456789`, [C]: `${MARK}c-0123456789` })], [A], 'what a fresh read gives back still counts as kept')
  secrets.files.knobs.failWrites = false
  const real = secrets.files.writeAtomic
  secrets.files.writeAtomic = () => {} // says yes, keeps nothing
  assert.deepEqual([...tokens.store({ [C]: `${MARK}c-0123456789` })], [], 'kept means read back, not "the write returned"')
  assert.equal(tokens.get(C), null)
  secrets.files.writeAtomic = real
  // A store that cannot be read is never written over.
  const before = Buffer.from(blob()[0][1])
  secrets.cipher.state.locked = true
  assert.deepEqual([...tokens.store({ [C]: `${MARK}c-0123456789` })], [], 'nothing is kept while the store cannot be read')
  assert.equal(tokens.readable(), false)
  assert.equal(tokens.get(A), null)
  tokens.forget([A])
  assert.throws(() => tokens.assertCanStore(), (error) => error instanceof SecretsError && error.message === REFUSAL)
  assert.ok(blob()[0][1].equals(before), 'the unreadable store is left exactly as it was')
  // While it has just refused, a save does not ask it again (no Keychain prompt on every save).
  let asked = 0
  const realRead = secrets.files.read
  secrets.files.read = (path) => { asked += 1; return realRead(path) }
  assert.deepEqual([...tokens.store({ [C]: `${MARK}c-0123456789` })], [])
  tokens.forget([A])
  assert.equal(asked, 0, 'a store that has just refused is left alone for a while')
  secrets.files.read = realRead
  secrets.cipher.state.locked = false
  time = 60_000
  // Damaged or foreign contents: not ours to replace.
  for (const text of ['not json at all', JSON.stringify({ version: 2, tokens: {} }), JSON.stringify({ version: 1, tokens: [] }), JSON.stringify([1])]) {
    const odd = memorySecrets()
    odd.store.write('owner-tokens', text)
    const kept = Buffer.from([...odd.files.blobs.values()][0])
    const oddTokens = createOwnerTokens(odd.store, { now: () => 0 })
    assert.deepEqual([...oddTokens.store({ [A]: `${MARK}a-0123456789` })], [])
    assert.equal(oddTokens.readable(), false)
    assert.ok([...odd.files.blobs.values()][0].equals(kept), 'a store in another format is not written over')
  }
  // After a failed read the store is asked again only after a pause (a refused Keychain prompt).
  let clock = 0
  let reads = 0
  const counting = { ...secrets.store, read: (slot) => { reads += 1; return secrets.store.read(slot) } }
  const paced = createOwnerTokens(counting, { now: () => clock })
  secrets.cipher.state.locked = true
  assert.equal(paced.get(A), null)
  assert.equal(paced.get(A), null)
  assert.equal(reads, 1, 'an unreadable store is not asked on every call')
  secrets.cipher.state.locked = false
  clock = 60_000
  same(paced.get(A), `${MARK}a-0123456789`, 'and is asked again later')
  // Forgetting.
  tokens.forget([A])
  assert.equal(createOwnerTokens(secrets.store).get(A), null)
  same(createOwnerTokens(secrets.store).get(B), `${MARK}b-0123456789`, 'forgetting one token leaves the others')
  tokens.forget([B])
  assert.equal(secrets.files.blobs.size, 0, 'the last token gone, the slot is cleared')
  // Unavailable from the start.
  const off = memorySecrets()
  off.cipher.state.available = false
  const offTokens = createOwnerTokens(off.store)
  assert.deepEqual([...offTokens.store({ [A]: `${MARK}a-0123456789` })], [])
  assert.throws(() => offTokens.assertCanStore(), (error) => error instanceof SecretsError && error.message === REFUSAL)
  assert.equal(off.files.blobs.size, 0, 'nothing is written while encryption is unavailable')
  console.log('PASS 1: tokens are kept only when read back; an unreadable or foreign store is never written over')
}

// ── 2. Migration: registry in → store + rewritten registry out ──────────────────────────────────
for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
  const dir = folder()
  const path = join(dir, OWNER_TOKEN_REGISTRIES[name].file)
  const legacy = LEGACY[name](3)
  writeLegacy(path, legacy)
  const tokens = memoryOwnerTokens()
  const registry = openOwnerTokenRegistry(name, path, tokens)
  // Before migration the registry reads as it always did.
  assert.deepEqual(registry.read(), rowsIn(name, legacy), `${name}: an unmigrated registry reads with its tokens`)
  assert.deepEqual(registry.migrate(), { found: 3, moved: 3, kept: 0 })
  const after = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(tokensOnDisk(dir), [], `${name}: no token is left in any file of the user-data folder`)
  assert.equal(after.version, legacy.version, `${name}: the registry keeps its version`)
  for (const [fileKey, row] of Object.entries(rowsIn(name, legacy))) {
    const { ownerToken, ...rest } = row
    assert.deepEqual(rowsIn(name, after)[fileKey], rest, `${name}: the row keeps everything but the token`)
    same(tokens.get(keyFor(name, row)), ownerToken, `${name}: the token is in the store under the row's id`)
  }
  assert.deepEqual(registry.read(), rowsIn(name, legacy), `${name}: after migration the rows read with their tokens again`)
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o600, `${name}: the registry stays private`)
  assert.deepEqual(readdirSync(dir), [OWNER_TOKEN_REGISTRIES[name].file], `${name}: no temporary file is left`)
  // Twice is harmless: nothing found, nothing written.
  const bytes = readFileSync(path)
  const writes = tokens.secrets.files.knobs.writes
  assert.deepEqual(registry.migrate(), { found: 0, moved: 0, kept: 0 })
  assert.ok(readFileSync(path).equals(bytes), `${name}: a second run leaves the registry byte for byte`)
  assert.equal(tokens.secrets.files.knobs.writes, writes, `${name}: and writes nothing to the store`)
  // The next start (a new token store over the same secrets) sees the same rows.
  assert.deepEqual(openOwnerTokenRegistry(name, path, createOwnerTokens(tokens.secrets.store)).read(), rowsIn(name, legacy))
}
{
  // All three at once, the way the app does it at start; and nothing to do in an empty folder.
  const dir = folder()
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) writeLegacy(join(dir, OWNER_TOKEN_REGISTRIES[name].file), LEGACY[name](2))
  const tokens = memoryOwnerTokens()
  assert.deepEqual(migrateOwnerTokens(dir, tokens), {
    'shared-talk': { found: 2, moved: 2, kept: 0 }, 'run-results': { found: 2, moved: 2, kept: 0 }, 'run-prework': { found: 2, moved: 2, kept: 0 },
  })
  assert.deepEqual(tokensOnDisk(dir), [])
  // The summary the app logs holds counts only.
  assert.equal(holds(JSON.stringify(migrateOwnerTokens(dir, tokens)), MARK), false)
  const empty = folder()
  assert.deepEqual(migrateOwnerTokens(empty, memoryOwnerTokens()), {
    'shared-talk': { found: 0, moved: 0, kept: 0 }, 'run-results': { found: 0, moved: 0, kept: 0 }, 'run-prework': { found: 0, moved: 0, kept: 0 },
  })
  assert.deepEqual(readdirSync(empty), [], 'a fresh install gets no registry and no store file from migration')
  // The same id under two kinds, or on two services, is two tokens.
  assert.notEqual(ownerTokenKey('share', 'results0', ORIGIN), ownerTokenKey('results', 'results0', ORIGIN))
  assert.notEqual(ownerTokenKey('share', 'results0', ORIGIN), ownerTokenKey('share', 'results0', 'https://other.example.test'))
}
console.log('PASS 2: each registry migrates (token to the store, read back, registry rewritten without it); a second run changes nothing')

// ── 3. Interrupted migration: every token usable on the next start ──────────────────────────────
for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
  const file = OWNER_TOKEN_REGISTRIES[name].file
  const legacy = LEGACY[name](2)
  const usable = (registry) => assert.deepEqual(registry.read(), rowsIn(name, legacy), `${name}: every row still has its token`)

  // (a) Stopped between the store write and the registry rewrite.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const original = readFileSync(path)
    const tokens = memoryOwnerTokens()
    const { files, knobs } = crashingFiles()
    knobs.crashWrites = 1
    assert.throws(() => openOwnerTokenRegistry(name, path, tokens, files).migrate(), /power cut/)
    assert.ok(readFileSync(path).equals(original), `${name}: the registry is untouched`)
    assert.equal(tokens.secrets.files.blobs.size, 1, `${name}: the store already holds the tokens`)
    // Next start, with a fresh view of everything.
    const next = openOwnerTokenRegistry(name, path, createOwnerTokens(tokens.secrets.store))
    usable(next)
    assert.deepEqual(next.migrate(), { found: 2, moved: 2, kept: 0 }, `${name}: the next start finishes the move`)
    usable(next)
    assert.deepEqual(tokensOnDisk(dir), [])
    // Through the app's own entry point the crash is contained and reported without text.
    const dir2 = folder()
    writeLegacy(join(dir2, file), legacy)
    const crashing = crashingFiles()
    crashing.knobs.crashWrites = 1
    assert.deepEqual(migrateOwnerTokens(dir2, memoryOwnerTokens(), crashing.files)[name], { failed: true })
  }

  // (b) The store unavailable, then failing to write, then locked: nothing leaves the registry.
  for (const [what, set, unset] of [
    ['encryption unavailable', (s) => { s.cipher.state.available = false }, (s) => { s.cipher.state.available = true }],
    ['the store cannot be written', (s) => { s.files.knobs.failWrites = true }, (s) => { s.files.knobs.failWrites = false }],
  ]) {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const original = readFileSync(path)
    const tokens = memoryOwnerTokens()
    set(tokens.secrets)
    const registry = openOwnerTokenRegistry(name, path, tokens)
    assert.deepEqual(registry.migrate(), { found: 2, moved: 0, kept: 2 }, `${name}: ${what} → nothing moves`)
    assert.ok(readFileSync(path).equals(original), `${name}: ${what} → the registry is byte for byte as it was`)
    assert.equal(tokens.secrets.files.blobs.size, 0)
    usable(registry)
    unset(tokens.secrets)
    assert.deepEqual(registry.migrate(), { found: 2, moved: 2, kept: 0 }, `${name}: once the store works, the move completes`)
    usable(registry)
  }
  {
    // An existing store that cannot be read (locked Keychain): tokens stay put and the store is not replaced.
    const dir = folder()
    const path = join(dir, file)
    const tokens = memoryOwnerTokens()
    tokens.store({ [ownerTokenKey('share', 'earlier0', ORIGIN)]: `${MARK}earlier-0123456789` })
    const stored = Buffer.from([...tokens.secrets.files.blobs.values()][0])
    writeLegacy(path, legacy)
    const original = readFileSync(path)
    tokens.secrets.cipher.state.locked = true
    const registry = openOwnerTokenRegistry(name, path, createOwnerTokens(tokens.secrets.store, { now: () => 0 }))
    assert.deepEqual(registry.migrate(), { found: 2, moved: 0, kept: 2 })
    assert.ok(readFileSync(path).equals(original))
    assert.ok([...tokens.secrets.files.blobs.values()][0].equals(stored), `${name}: a locked store is not written over`)
    usable(registry)
  }

  // (c) A write that says it worked but does not read back: the token does not leave the registry.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const original = readFileSync(path)
    const tokens = memoryOwnerTokens()
    tokens.secrets.files.writeAtomic = () => {}
    assert.deepEqual(openOwnerTokenRegistry(name, path, tokens).migrate(), { found: 2, moved: 0, kept: 2 })
    assert.ok(readFileSync(path).equals(original), `${name}: without a correct read-back nothing is removed`)
  }

  // (d) Temporary files a crashed write left behind (earlier versions' held plain tokens): swept
  //     once the registry is clean, and only those.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const half = JSON.stringify(legacy, null, 2).slice(0, 120)
    writeFileSync(join(dir, `${file}.4242.mfz1k2ab.tmp`), half) // the earlier writers' temporary name
    writeFileSync(join(dir, `.${file}.3b0e7a52-6f0c-4d7e-9a57-0d0c3f1f2a11.tmp`), half) // this version's
    writeFileSync(join(dir, 'handout-registry.json'), '{}')
    writeFileSync(join(dir, `${file}.bak`), 'not a temporary file')
    writeFileSync(join(dir, `other-${file}.4242.mfz1k2ab.tmp`), 'another file\'s temporary')
    const tokens = memoryOwnerTokens()
    const registry = openOwnerTokenRegistry(name, path, tokens)
    usable(registry) // a half-written temporary file changes nothing: the registry itself is whole
    assert.deepEqual(registry.migrate(), { found: 2, moved: 2, kept: 0 })
    assert.deepEqual(readdirSync(dir).sort(), ['handout-registry.json', file, `${file}.bak`, `other-${file}.4242.mfz1k2ab.tmp`].sort(), `${name}: only this registry's leftovers are removed`)
    assert.deepEqual(tokensOnDisk(dir), [])
    // While tokens are still in the registry the leftovers are left alone too.
    const dir2 = folder()
    writeLegacy(join(dir2, file), legacy)
    writeFileSync(join(dir2, `${file}.4242.mfz1k2ab.tmp`), half)
    const off = memoryOwnerTokens()
    off.secrets.cipher.state.available = false
    openOwnerTokenRegistry(name, join(dir2, file), off).migrate()
    assert.ok(existsSync(join(dir2, `${file}.4242.mfz1k2ab.tmp`)))
  }

  // (e) A registry that is not JSON (cut short): left exactly as it is, for a person to recover.
  {
    const dir = folder()
    const path = join(dir, file)
    const cut = JSON.stringify(legacy, null, 2).slice(0, 200)
    writeFileSync(path, cut)
    writeFileSync(join(dir, `${file}.4242.mfz1k2ab.tmp`), JSON.stringify(legacy))
    const tokens = memoryOwnerTokens()
    assert.deepEqual(openOwnerTokenRegistry(name, path, tokens).migrate(), { found: 0, moved: 0, kept: 0 })
    assert.equal(readFileSync(path, 'utf8'), cut, `${name}: an unreadable registry is not rewritten`)
    assert.ok(existsSync(join(dir, `${file}.4242.mfz1k2ab.tmp`)), `${name}: nor are the files beside it removed`)
    assert.equal(tokens.secrets.files.blobs.size, 0)
  }

  // (f) Rows the move cannot place stay as they are; the rest move.
  {
    const dir = folder()
    const path = join(dir, file)
    const mixed = LEGACY[name](2)
    const rows = rowsIn(name, mixed)
    const [first, second] = Object.keys(rows)
    rows[first][OWNER_TOKEN_REGISTRIES[name].idField] = 'not an id'
    rows.odd = 'not a row'
    writeLegacy(path, mixed)
    const tokens = memoryOwnerTokens()
    assert.deepEqual(openOwnerTokenRegistry(name, path, tokens).migrate(), { found: 2, moved: 1, kept: 1 })
    const after = rowsIn(name, JSON.parse(readFileSync(path, 'utf8')))
    assert.deepEqual(after[first], rows[first], `${name}: a row with no usable id is not touched`)
    assert.equal('ownerToken' in after[second], false)
    assert.equal(after.odd, 'not a row')
  }

  // (g) A store that kept some tokens and not others: only the rows whose token read back lose it.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const rows = rowsIn(name, legacy)
    const [first, second] = Object.keys(rows)
    const real = memoryOwnerTokens()
    const partial = { ...real, store: (entries) => new Set([...real.store(entries)].filter((key) => key === keyFor(name, rows[first]))) }
    assert.deepEqual(openOwnerTokenRegistry(name, path, partial).migrate(), { found: 2, moved: 1, kept: 1 })
    const after = rowsIn(name, JSON.parse(readFileSync(path, 'utf8')))
    assert.equal('ownerToken' in after[first], false, `${name}: the row whose token read back is rewritten without it`)
    same(after[second].ownerToken, rows[second].ownerToken, `${name}: the row whose token did not read back keeps it`)
  }
}
console.log('PASS 3: stopped after the store write, store unavailable, unwritable or locked, a write that does not read back, leftovers, a cut registry — every token still usable')

// ── 4. Writes ───────────────────────────────────────────────────────────────────────────────────
for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
  const file = OWNER_TOKEN_REGISTRIES[name].file
  const legacy = LEGACY[name](3)
  const rows = rowsIn(name, legacy)
  const [k0, k1, k2] = Object.keys(rows)
  // A new row: token to the store, row to the file without it.
  {
    const dir = folder()
    const path = join(dir, file)
    const tokens = memoryOwnerTokens()
    const registry = openOwnerTokenRegistry(name, path, tokens)
    assert.doesNotThrow(() => registry.assertCanStore())
    registry.write({ [k0]: rows[k0] })
    assert.deepEqual(tokensOnDisk(dir), [], `${name}: a new row's token never reaches the file`)
    assert.deepEqual(registry.read(), { [k0]: rows[k0] })
    registry.write({ [k0]: rows[k0], [k1]: rows[k1] })
    // A write that does not mention a row leaves the row and its token where they are.
    registry.write({ [k1]: { ...rows[k1] } })
    assert.deepEqual(registry.read(), { [k0]: rows[k0], [k1]: rows[k1] }, `${name}: a row a write does not mention stays`)
    same(tokens.get(keyFor(name, rows[k0])), rows[k0].ownerToken, `${name}: and so does its token`)
    assert.equal(registry.has(k0), true)
    // Removing a row by name removes its token from the store; the others stay.
    registry.write({}, { remove: [k0] })
    assert.equal(registry.has(k0), false)
    assert.equal(tokens.get(keyFor(name, rows[k0])), null, `${name}: a removed row's token is forgotten`)
    same(tokens.get(keyFor(name, rows[k1])), rows[k1].ownerToken, `${name}: the others stay`)
    // A row needs all of id, address and token.
    for (const bad of [{ ...rows[k2], ownerToken: undefined }, { ...rows[k2], ownerToken: 'short' }, { ...rows[k2], workerBaseUrl: '' }, 'row']) {
      assert.throws(() => registry.write({ [k2]: bad }), TypeError)
    }
    assert.deepEqual(registry.read(), { [k1]: rows[k1] }, `${name}: a refused write changes nothing`)
  }
  // Encryption unavailable: a new row is refused before anything is written; rows already in the
  // registry in plain text keep working and stay as they were.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, { ...legacy, [OWNER_TOKEN_REGISTRIES[name].collection]: { [k0]: rows[k0] } })
    const tokens = memoryOwnerTokens()
    tokens.secrets.cipher.state.available = false
    const registry = openOwnerTokenRegistry(name, path, tokens)
    const original = readFileSync(path)
    assert.throws(() => registry.assertCanStore(), (error) => error instanceof SecretsError && error.message === REFUSAL)
    let thrown
    try { registry.write({ [k0]: rows[k0], [k1]: rows[k1] }) } catch (error) { thrown = error }
    assert.ok(thrown instanceof SecretsError && thrown.message === REFUSAL, `${name}: a new token with no secure storage is refused with the sentence`)
    assert.equal(holds([thrown.message, thrown.stack, JSON.stringify(thrown)].join('\n'), MARK), false, `${name}: the refusal carries no token`)
    assert.ok(readFileSync(path).equals(original), `${name}: and nothing is written`)
    // A change to the row that is already there (a new cursor, a new revision) still saves.
    registry.write({ [k0]: { ...rows[k0], createdAt: 77 } })
    const after = rowsIn(name, JSON.parse(readFileSync(path, 'utf8')))
    same(after[k0].ownerToken, rows[k0].ownerToken, `${name}: a row not yet moved keeps its token where it was`)
    assert.equal(after[k0].createdAt, 77)
    assert.equal(tokens.secrets.files.blobs.size, 0)
  }
  // The store cannot be read (locked): moved rows are invisible, kept through writes, and back afterwards.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const tokens = memoryOwnerTokens()
    openOwnerTokenRegistry(name, path, tokens).migrate()
    tokens.secrets.cipher.state.locked = true
    const lockedTokens = createOwnerTokens(tokens.secrets.store, { now: () => 0 })
    const registry = openOwnerTokenRegistry(name, path, lockedTokens)
    for (const row of Object.values(registry.read())) assert.equal('ownerToken' in row, false, `${name}: with the store locked a row has no token`)
    const original = readFileSync(path, 'utf8')
    registry.write({}) // what a module writes when it can see no valid row
    assert.equal(readFileSync(path, 'utf8'), original, `${name}: rows the store could not give back are kept through a write`)
    const newRow = { ...rows[k0], ownerToken: `${MARK}new-0123456789`, [OWNER_TOKEN_REGISTRIES[name].idField]: 'newrow00' }
    assert.throws(() => registry.write({ 'new-key': newRow }), SecretsError, `${name}: a new row is refused while the store is locked`)
    assert.throws(() => registry.write({ [k0]: newRow }), OwnerRegistryError, `${name}: and never written over a row that is there`)
    assert.equal(readFileSync(path, 'utf8'), original)
    tokens.secrets.cipher.state.locked = false
    assert.deepEqual(openOwnerTokenRegistry(name, path, createOwnerTokens(tokens.secrets.store)).read(), rows, `${name}: unlocked, every row is back with its token`)
  }
  // Moved rows keep saving when the store later stops taking writes (a full disk): no throw, no plain text.
  {
    const dir = folder()
    const path = join(dir, file)
    writeLegacy(path, legacy)
    const tokens = memoryOwnerTokens()
    const registry = openOwnerTokenRegistry(name, path, tokens)
    registry.migrate()
    tokens.secrets.files.knobs.failWrites = true
    assert.doesNotThrow(() => registry.write({ ...rows, [k0]: { ...rows[k0], createdAt: 99 } }))
    assert.deepEqual(tokensOnDisk(dir), [])
    assert.equal(registry.read()[k0].createdAt, 99)
    same(registry.read()[k0].ownerToken, rows[k0].ownerToken, 'still with its token')
  }
}
console.log('PASS 4: a new token is stored or refused, never written plain; unmoved rows keep working; rows behind a locked store survive writes')

// ── 5. Going back to an earlier version ─────────────────────────────────────────────────────────
for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
  const dir = folder()
  const file = OWNER_TOKEN_REGISTRIES[name].file
  const path = join(dir, file)
  const legacy = LEGACY[name](2)
  const rows = rowsIn(name, legacy)
  writeLegacy(path, legacy)
  assert.equal(earlierVersionSees(name, path).length, 2)
  const tokens = memoryOwnerTokens()
  const registry = openOwnerTokenRegistry(name, path, tokens)
  registry.migrate()
  // What a rolled-back install sees without the restore: rows it treats as absent.
  assert.equal(earlierVersionSees(name, path).length, 0, `${name}: after migration an earlier version sees no usable row`)
  // …and coming forward again (the earlier version wrote nothing) everything is as it was.
  assert.deepEqual(openOwnerTokenRegistry(name, path, createOwnerTokens(tokens.secrets.store)).read(), rows, `${name}: back on this version every row has its token`)
  // The restore: tokens written back, so the earlier version works; the store is left alone.
  const stored = Buffer.from([...tokens.secrets.files.blobs.values()][0])
  assert.deepEqual(registry.restorePlain(), { restored: 2, missing: 0 })
  assert.deepEqual(rowsIn(name, JSON.parse(readFileSync(path, 'utf8'))), rows, `${name}: the restored registry is what the earlier version wrote`)
  assert.equal(earlierVersionSees(name, path).length, 2, `${name}: the earlier version sees its rows again`)
  if (posix) assert.equal(statSync(path).mode & 0o777, 0o600, `${name}: the restored registry is private, as the earlier one was`)
  assert.ok([...tokens.secrets.files.blobs.values()][0].equals(stored), `${name}: the store keeps its copy`)
  assert.deepEqual(registry.restorePlain(), { restored: 0, missing: 0 }, `${name}: restoring twice is harmless`)
  // A share made by the earlier version while rolled back is picked up on the way forward.
  const withNew = JSON.parse(readFileSync(path, 'utf8'))
  const newRow = Object.values(rowsIn(name, LEGACY[name](3)))[2]
  rowsIn(name, withNew)[newRow.key] = newRow
  writeLegacy(path, withNew)
  assert.deepEqual(registry.migrate(), { found: 3, moved: 3, kept: 0 }, `${name}: the next ordinary start moves them all again`)
  assert.deepEqual(tokensOnDisk(dir), [])
  same(tokens.get(keyFor(name, newRow)), newRow.ownerToken, `${name}: including the one the earlier version made`)
  // A store that cannot be read is a failure, never "no token".
  tokens.secrets.cipher.state.locked = true
  const locked = createOwnerTokens(tokens.secrets.store, { now: () => 0 })
  registry.migrate()
  assert.throws(() => openOwnerTokenRegistry(name, path, locked).restorePlain(), SecretsError, `${name}: a locked store fails the restore`)
  assert.deepEqual(restorePlainOwnerTokens(dir, locked)[name], { failed: true })
  assert.equal(earlierVersionSees(name, path).length, 0, `${name}: and writes nothing`)
  tokens.secrets.cipher.state.locked = false
  // A row whose token the store does not hold is counted, not invented.
  tokens.forget([keyFor(name, newRow)])
  assert.deepEqual(registry.restorePlain(), { restored: 2, missing: 1 })
  // The earlier version dropping a row it ignored does not make this version forget that row's token.
  registry.migrate()
  const dropped = JSON.parse(readFileSync(path, 'utf8'))
  const [keepKey, dropKey] = Object.keys(rowsIn(name, legacy))
  delete rowsIn(name, dropped)[dropKey]
  delete rowsIn(name, dropped)[newRow.key]
  writeLegacy(path, dropped)
  registry.write({ [keepKey]: registry.read()[keepKey] })
  same(tokens.get(keyFor(name, rows[dropKey])), rows[dropKey].ownerToken, `${name}: a token is forgotten only when this version removes its row`)
}
{
  const dir = folder()
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) writeLegacy(join(dir, OWNER_TOKEN_REGISTRIES[name].file), LEGACY[name](1))
  const tokens = memoryOwnerTokens()
  migrateOwnerTokens(dir, tokens)
  const summary = restorePlainOwnerTokens(dir, tokens)
  assert.deepEqual(summary, { 'shared-talk': { restored: 1, missing: 0 }, 'run-results': { restored: 1, missing: 0 }, 'run-prework': { restored: 1, missing: 0 } })
  assert.equal(holds(JSON.stringify(summary), MARK), false, 'the summary the app logs holds counts only')
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) assert.equal(earlierVersionSees(name, join(dir, OWNER_TOKEN_REGISTRIES[name].file)).length, 1)
}
console.log('PASS 5: an earlier version sees no rows after migration; the restore gives them back; forward again moves them, new ones included')

// ── 6. Made before the change, still working after it (the real modules) ────────────────────────
{
  const dir = folder()
  const tokens = memoryOwnerTokens()
  const calls = []
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchStub = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.authorization ?? '' })
    if (String(url).endsWith('/results?after=4') || /\/results\?after=/.test(String(url))) return reply({ entries: [], more: false, seq: 4 })
    return reply({ closed: true, closedAt: 5 })
  }
  const sentWith = (pattern) => calls.filter((call) => pattern.test(call.url)).map((call) => call.auth)

  // A Run's results link.
  const resultsPath = join(dir, OWNER_TOKEN_REGISTRIES['run-results'].file)
  writeLegacy(resultsPath, LEGACY['run-results'](1))
  // Pre-work.
  const preworkPath = join(dir, OWNER_TOKEN_REGISTRIES['run-prework'].file)
  writeLegacy(preworkPath, LEGACY['run-prework'](1))
  // A shared talk.
  const sharedPath = join(dir, OWNER_TOKEN_REGISTRIES['shared-talk'].file)
  const sharedLegacy = LEGACY['shared-talk'](1)
  const sharedRow = Object.values(sharedLegacy.shares)[0]
  mkdirSync(join(scratch, 'vault', 'talk-0'), { recursive: true })
  writeFileSync(sharedRow.outlinePath, '---\ntitle: T\n---\n\n### One\n- a\n')
  writeLegacy(sharedPath, sharedLegacy)

  assert.deepEqual(Object.values(migrateOwnerTokens(dir, tokens)).map((step) => step.moved), [1, 1, 1])
  assert.deepEqual(tokensOnDisk(dir), [], 'after the first run no token is in any file of the user-data folder')

  const results = createRunResultsShares({ registryPath: resultsPath, ownerTokens: tokens, endpoint: async () => { throw new Error('no link is created here') }, linkBase: () => null, fetch: fetchStub })
  assert.ok(results.status('talk-0', 'run-0')?.url.includes('results0'), 'the results link made before the change is still the Run\'s link')
  assert.equal(JSON.stringify(results.status('talk-0', 'run-0')).includes(MARK), false, 'and a window still never sees its token')
  assert.deepEqual(await results.stop('talk-0', 'run-0'), { ok: true })
  assert.deepEqual(sentWith(/\/results\/results0\/close$/), [`Bearer ${MARK}results-0-0123456789`], 'it is stopped with the token it was made with')
  assert.equal(results.status('talk-0', 'run-0'), null)

  const prework = createRunPrework({ registryPath: preworkPath, ownerTokens: tokens, endpoint: async () => { throw new Error('no object is created here') }, vaultRoot: () => null, fetch: fetchStub })
  assert.equal(prework.status('talk-0', 'run-0')?.preworkId, 'prework0', 'pre-work made before the change is still the Run\'s pre-work')
  await prework.close('talk-0', 'run-0')
  assert.deepEqual(sentWith(/\/prework\/prework0\/close$/), [`Bearer ${MARK}prework-0-0123456789`], 'and is closed with its own token')
  assert.equal(prework.status('talk-0', 'run-0').closedAt, 5, 'the registry row is updated')

  const shared = createSharedTalks({
    registryPath: sharedPath, ownerTokens: tokens, endpoint: async () => { throw new Error('no share is created here') }, linkBase: () => '',
    identityOf: (path) => ({ key: `id:${path}`, realPath: path }), slugOf: () => 'talk-0', readOutline: async () => '', peekOutline: () => '',
    build: async () => ({ title: '', html: '', slides: [] }), stampShareUrl: async () => {}, qrSvg: async () => '', fetch: fetchStub,
  })
  assert.equal((await shared.status(sharedRow.outlinePath))?.shareId, 'shtalk00', 'the share made before the change is still this talk\'s share')
  same(shared.owners()[0].ownerToken, sharedRow.ownerToken, 'its owner socket gets the token it was made with')
  assert.equal(JSON.stringify(shared.list()).includes(MARK), false, 'no state sent to a window carries it')
  await shared.setOptions(sharedRow.outlinePath, { liveUpdates: false })
  assert.deepEqual(tokensOnDisk(dir), [], 'saving a change to a migrated share writes no token')
  await shared.stop(sharedRow.outlinePath)
  assert.deepEqual(sentWith(/\/shares\/shtalk00\/close$/), [`Bearer ${sharedRow.ownerToken}`], 'and it is stopped with that token')
  assert.equal(tokens.get(keyFor('shared-talk', sharedRow)), null, 'a stopped share\'s token is forgotten')
  assert.deepEqual(tokensOnDisk(dir), [])

  // New ones made now: the token goes to the store; with no secure storage they are refused before
  // the service is asked for anything.
  const made = []
  const makingFetch = async (url, init = {}) => {
    made.push(String(url))
    if (/\/results$/.test(String(url))) return reply({ shareId: 'newres00', ownerToken: `${MARK}new-results-0123456789` }, 201)
    if (/\/prework$/.test(String(url))) return reply({ preworkId: 'newpre00', ownerToken: `${MARK}new-prework-0123456789` }, 201)
    if (/\/shares$/.test(String(url))) return reply({ shareId: 'newshr00', ownerToken: `${MARK}new-share-0123456789` }, 201)
    return reply({ revision: 1, seq: 1 })
  }
  const endpoint = async () => ({ baseUrl: ORIGIN, adminSecret: 'test-token-admin-0123456789' })
  const run = { id: 'run-9', talkSlug: 'talk-9', startedAt: '2026-10-01T10:00:00.000Z', polls: [], boards: [] }
  const makers = (ownerTokens, at) => ({
    results: createRunResultsShares({ registryPath: join(at, OWNER_TOKEN_REGISTRIES['run-results'].file), ownerTokens, endpoint, linkBase: () => null, fetch: makingFetch }),
    prework: createRunPrework({ registryPath: join(at, OWNER_TOKEN_REGISTRIES['run-prework'].file), ownerTokens, endpoint, vaultRoot: () => null, fetch: makingFetch }),
    shared: createSharedTalks({
      registryPath: join(at, OWNER_TOKEN_REGISTRIES['shared-talk'].file), ownerTokens, endpoint, linkBase: () => '',
      identityOf: (path) => ({ key: `id:${path}`, realPath: path }), slugOf: () => 'talk-0', readOutline: async () => '### One\n- a\n', peekOutline: () => '### One\n- a\n',
      build: async () => ({ title: 'T', html: '<html></html>', slides: [{ slideId: 'one', title: 'One', text: 'a' }] }), stampShareUrl: async () => {}, qrSvg: async () => '', fetch: makingFetch,
    }),
  })
  const fresh = folder()
  const working = makers(tokens, fresh)
  await working.results.share('talk-9', 'run-9', run, { lifetime: '7', include: { board: true, polls: true } })
  await working.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 })
  await working.shared.share(sharedRow.outlinePath, 'T')
  await working.shared.idle()
  assert.deepEqual(tokensOnDisk(fresh), [], 'a link, a pre-work object and a share made now leave no token in any file')
  assert.deepEqual(readdirSync(fresh).sort(), Object.values(OWNER_TOKEN_REGISTRIES).map((spec) => spec.file).sort())
  same(tokens.get(ownerTokenKey('results', 'newres00', ORIGIN)), `${MARK}new-results-0123456789`, 'the new tokens are in the store')
  same(tokens.get(ownerTokenKey('prework', 'newpre00', ORIGIN)), `${MARK}new-prework-0123456789`, 'the new tokens are in the store')
  same(tokens.get(ownerTokenKey('share', 'newshr00', ORIGIN)), `${MARK}new-share-0123456789`, 'the new tokens are in the store')

  const off = memoryOwnerTokens()
  off.secrets.cipher.state.available = false
  const refusedAt = folder()
  const refusing = makers(off, refusedAt)
  made.length = 0
  await assert.rejects(refusing.results.share('talk-9', 'run-9', run, { lifetime: '7', include: { board: true, polls: true } }), (error) => error.message === REFUSAL)
  await assert.rejects(refusing.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 }), (error) => error.message === REFUSAL)
  await assert.rejects(refusing.shared.share(sharedRow.outlinePath, 'T'), (error) => holds(error.message, REFUSAL))
  assert.deepEqual(made, [], 'with no secure storage nothing is created on the service')
  assert.deepEqual(readdirSync(refusedAt), [], 'and nothing is written: no registry, no store file, no plain text')
}
console.log('PASS 6: shares, results links and pre-work made before the change still work; new ones never write a token to a file; none are made without secure storage')

// ── 7. The review of the first build ────────────────────────────────────────────────────────────
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ADMIN = 'test-token-admin-0123456789'
const RUN = { id: 'run-9', talkSlug: 'talk-9', startedAt: '2026-10-01T10:00:00.000Z', polls: [], boards: [] }
const SHARE_OPTIONS = { lifetime: '7', include: { board: true, polls: true } }
const NEW = { results: `${MARK}new-results-0123456789`, prework: `${MARK}new-prework-0123456789`, share: `${MARK}new-share-0123456789` }
const outlineOf = (i) => join(scratch, 'vault', `talk-${i}`, `talk-${i}-outline.md`)
const collectionOf = (name, path) => rowsIn(name, JSON.parse(readFileSync(path, 'utf8')))
/**
 * A stand-in for the live service. `service.created` are the tokens it hands out (changeable);
 * `service.onCreate` runs when it makes something; `service.fail(call)` may throw for a call.
 */
function standIn() {
  const service = { calls: [], created: { ...NEW }, onCreate: null, onOwnerCall: null, fail: null, closeStatus: 200 }
  service.fetch = async (url, init = {}) => {
    const call = { url: String(url), route: new URL(String(url)).pathname, method: init.method ?? 'GET', auth: init.headers?.authorization ?? '' }
    service.calls.push(call)
    if (service.fail) service.fail(call)
    if (call.method === 'POST' && /^\/(results|prework|shares)$/.test(call.route)) {
      service.onCreate?.(call)
      if (call.route === '/results') return reply({ shareId: 'newres00', ownerToken: service.created.results }, 201)
      if (call.route === '/prework') return reply({ preworkId: 'newpre00', ownerToken: service.created.prework }, 201)
      return reply({ shareId: 'newshr00', ownerToken: service.created.share }, 201)
    }
    service.onOwnerCall?.(call)
    if (call.route.endsWith('/close')) return reply({ closed: true, closedAt: 5 }, service.closeStatus)
    if (/\/results$/.test(call.route) && call.method === 'GET') return reply({ entries: [], more: false, seq: 4 })
    return reply({ revision: 1, seq: 1 })
  }
  service.made = () => service.calls.filter((call) => call.method === 'POST' && /^\/(results|prework|shares)$/.test(call.route)).map((call) => call.route)
  service.ownerCalls = () => service.calls.filter((call) => holds(call.auth, MARK))
  return service
}
/** The three real modules over one user-data folder, one token store and one stand-in service. */
function modules(dir, ownerTokens, service, logs = []) {
  const endpoint = async () => ({ baseUrl: ORIGIN, adminSecret: ADMIN })
  return {
    results: createRunResultsShares({ registryPath: join(dir, OWNER_TOKEN_REGISTRIES['run-results'].file), ownerTokens, endpoint, linkBase: () => null, fetch: service.fetch }),
    prework: createRunPrework({ registryPath: join(dir, OWNER_TOKEN_REGISTRIES['run-prework'].file), ownerTokens, endpoint, vaultRoot: () => null, fetch: service.fetch }),
    shared: createSharedTalks({
      registryPath: join(dir, OWNER_TOKEN_REGISTRIES['shared-talk'].file), ownerTokens, endpoint, linkBase: () => '', saveDebounceMs: 1,
      identityOf: (path) => ({ key: `id:${path}`, realPath: path }), slugOf: (path) => path.split(/[\\/]/).at(-2), readOutline: async () => '### One\n- a\n', peekOutline: () => '### One\n- a\n',
      build: async () => ({ title: 'T', html: '<html></html>', slides: [{ slideId: 'one', title: 'One', text: 'a' }] }), stampShareUrl: async () => {}, qrSvg: async () => '',
      fetch: service.fetch, log: (line) => logs.push(line),
    }),
  }
}
const legacyFolder = (count = 2) => {
  const dir = folder()
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) writeLegacy(join(dir, OWNER_TOKEN_REGISTRIES[name].file), LEGACY[name](count))
  return dir
}
const registryBytes = (dir) => OWNER_TOKEN_REGISTRY_NAMES.map((name) => readFileSync(join(dir, OWNER_TOKEN_REGISTRIES[name].file), 'utf8'))

// 7.1 Secure storage locked at start, readable later: no row and no token is lost by the next write.
for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
  const dir = folder()
  const path = join(dir, OWNER_TOKEN_REGISTRIES[name].file)
  const rows = rowsIn(name, LEGACY[name](3))
  const [k0, k1, k2] = Object.keys(rows)
  writeLegacy(path, LEGACY[name](3))
  const secrets = memorySecrets()
  openOwnerTokenRegistry(name, path, createOwnerTokens(secrets.store)).migrate()
  secrets.cipher.state.locked = true
  let time = 0
  const tokens = createOwnerTokens(secrets.store, { now: () => time })
  const registry = openOwnerTokenRegistry(name, path, tokens)
  // What a module holds after reading with the store locked: only the rows it could use (none), or
  // an incomplete set it read earlier.
  assert.equal(Object.values(registry.read()).filter((row) => 'ownerToken' in row).length, 0)
  const original = readFileSync(path, 'utf8')
  secrets.cipher.state.locked = false
  time += 60_000
  registry.write({ [k0]: { ...rows[k0], createdAt: 5 } }) // the caller's incomplete picture, written once the store answers again
  assert.deepEqual(Object.keys(collectionOf(name, path)), [k0, k1, k2], `${name}: rows the caller could not see are still in the file`)
  assert.deepEqual(collectionOf(name, path)[k1], JSON.parse(original)[OWNER_TOKEN_REGISTRIES[name].collection][k1], `${name}: untouched`)
  for (const key of [k1, k2]) same(tokens.get(keyFor(name, rows[key])), rows[key].ownerToken, `${name}: and their tokens are still in the store`)
  assert.deepEqual(registry.read(), { ...rows, [k0]: { ...rows[k0], createdAt: 5 } }, `${name}: with the store back every row is usable again`)
  // A different row under a key the file already uses is never written over unless that key is named.
  const other = { ...rows[k1], [OWNER_TOKEN_REGISTRIES[name].idField]: 'another0', ownerToken: `${MARK}another-0123456789` }
  const beforeRefusal = readFileSync(path, 'utf8')
  assert.throws(() => registry.write({ [k1]: other }), (error) => error instanceof OwnerRegistryError && error.code === 'row-in-the-way' && !holds(error.message, MARK))
  assert.equal(readFileSync(path, 'utf8'), beforeRefusal)
  same(tokens.get(keyFor(name, rows[k1])), rows[k1].ownerToken)
  registry.write({ [k1]: other }, { remove: [k1] })
  assert.equal(tokens.get(keyFor(name, rows[k1])), null, `${name}: replaced by name, the earlier row's token goes`)
  same(tokens.get(keyFor(name, other)), other.ownerToken)
  // The same row under a new key (a talk whose file was replaced) is one row and keeps its token.
  registry.write({ 'moved-key': rows[k2] })
  assert.deepEqual(Object.keys(collectionOf(name, path)), [k0, k1, 'moved-key'])
  same(tokens.get(keyFor(name, rows[k2])), rows[k2].ownerToken)
}
{
  // The real modules: started with the store locked, they see no share; unlocked, a new share is
  // made for another talk. The earlier shares are all still there, and usable.
  const dir = legacyFolder(2)
  const secrets = memorySecrets()
  migrateOwnerTokens(dir, createOwnerTokens(secrets.store))
  assert.deepEqual(tokensOnDisk(dir), [])
  secrets.cipher.state.locked = true
  let time = 0
  const tokens = createOwnerTokens(secrets.store, { now: () => time })
  const service = standIn()
  const app = modules(dir, tokens, service)
  const original = registryBytes(dir)
  assert.deepEqual(app.shared.list(), [], 'locked: no share is usable')
  assert.equal(app.results.status('talk-0', 'run-0'), null)
  assert.equal(app.prework.status('talk-0', 'run-0'), null)
  // Locked: nothing is made in place of a row that cannot be read, and nothing is dropped.
  await assert.rejects(app.shared.share(outlineOf(0), 'T'), (error) => error.message === SHARE_LOCKED)
  await assert.rejects(app.results.share('talk-0', 'run-0', RUN, SHARE_OPTIONS), (error) => error.message === RESULTS_LINK_LOCKED)
  await assert.rejects(app.prework.publish('talk-0', 'run-0', { steps: [] }, { opensAt: 1, closesAt: 2 }), (error) => error.message === PREWORK_LOCKED)
  assert.deepEqual(await app.results.stop('talk-0', 'run-0'), { ok: false, error: RESULTS_LINK_LOCKED }, 'a link that cannot be read is not dropped by Stop sharing')
  assert.deepEqual(service.calls, [], 'locked: the service is asked for nothing')
  assert.deepEqual(registryBytes(dir), original, 'locked: the registries are as they were')
  // Unlocked. One new thing of each kind, for another talk and Run.
  secrets.cipher.state.locked = false
  time += 60_000
  await app.shared.share(outlineOf(7), 'T')
  await app.shared.idle()
  await app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)
  await app.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 })
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
    const rows = rowsIn(name, LEGACY[name](2))
    const after = collectionOf(name, join(dir, OWNER_TOKEN_REGISTRIES[name].file))
    assert.equal(Object.keys(after).length, 3, `${name}: the two earlier rows and the new one`)
    for (const [fileKey, row] of Object.entries(rows)) {
      assert.ok(after[fileKey], `${name}: an earlier row is still in the file after the store was unlocked and a new one was made`)
      same(tokens.get(keyFor(name, row)), row.ownerToken, `${name}: and its token is still in the store`)
    }
  }
  assert.deepEqual(tokensOnDisk(dir), [])
  assert.deepEqual(app.shared.list().map((state) => state.shareId).sort(), ['newshr00', 'shtalk00', 'shtalk01'], 'the earlier shares are taken up again')
  assert.equal(app.shared.owners().length, 3)
  assert.ok(app.results.status('talk-1', 'run-1')?.url.includes('results1'))
  assert.equal(app.prework.status('talk-1', 'run-1')?.preworkId, 'prework1')
  service.calls.length = 0
  await app.shared.stop(outlineOf(0))
  assert.deepEqual(service.calls.map((call) => [call.route, call.auth]), [['/shares/shtalk00/close', `Bearer ${MARK}share-0-0123456789`]], 'a recovered share is stopped with its own token')
  assert.deepEqual(Object.keys(collectionOf('shared-talk', join(dir, OWNER_TOKEN_REGISTRIES['shared-talk'].file))).length, 2, 'and only that row leaves the file')
  assert.equal(tokens.get(ownerTokenKey('share', 'shtalk00', ORIGIN)), null)
  same(tokens.get(ownerTokenKey('share', 'shtalk01', ORIGIN)), `${MARK}share-1-0123456789`)
}
console.log('PASS 7.1: rows behind a locked store stay in the file through every write, keep their tokens, and are usable again once it is unlocked')

// 7.2 An owner token never travels in an error.
{
  assert.equal(validOwnerToken(`${MARK}line\nbreak-0123456789`), false, 'a token with a line break is not a token')
  for (const bad of [`${MARK}with space-0123456789`, `${MARK}tab\t-0123456789`, `${MARK}é-0123456789`, `${MARK}\r\nx-injected: 1`, `${MARK}nul\0-0123456789`]) assert.equal(validOwnerToken(bad), false)
  assert.equal(validOwnerToken(`${MARK}plain.base64url_-~0123456789`), true)
  // The real HTTP layer quotes a header it refuses. That is the leak this closes.
  const unsafe = `${MARK}line\nbreak-0123456789`
  let transportSays = ''
  try { await fetch('http://127.0.0.1:9/never', { headers: { authorization: `Bearer ${unsafe}` } }) } catch (error) { transportSays = `${error.message} ${error.cause?.message ?? ''}` }
  assert.ok(transportSays.length > 0, 'the real fetch refuses such a header')
  const carries = (error) => holds([error?.message, error?.stack, JSON.stringify(error), String(error?.cause ?? '')].join('\n'), MARK)
  // ownerFetch: refused before it is sent; and any failure to send is a fixed sentence.
  let sent = 0
  await assert.rejects(ownerFetch(async () => { sent += 1; return reply({}) }, `${ORIGIN}/x`, unsafe), (error) => error instanceof OwnerRequestError && error.reason === 'bad-token' && !carries(error))
  assert.equal(sent, 0)
  const good = `${MARK}good-0123456789`
  const quoting = async (_url, init) => { throw new TypeError(`Headers.append: "${init.headers.authorization}" is an invalid header value.`, { cause: new Error(init.headers.authorization) }) }
  await assert.rejects(ownerFetch(quoting, `${ORIGIN}/x`, good), (error) => error instanceof OwnerRequestError && error.reason === 'unreachable' && error.message === 'The service could not be reached.' && !carries(error))
  await assert.rejects(ownerFetch(async () => { throw Object.assign(new Error(good), { name: 'TimeoutError' }) }, `${ORIGIN}/x`, good), (error) => error.reason === 'timeout' && !carries(error))
  let seen
  await ownerFetch(async (_url, init) => { seen = init; return reply({}) }, `${ORIGIN}/x`, good, { method: 'PUT', headers: { 'content-type': 'application/json' } })
  assert.deepEqual(seen, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${good}` } })

  // The service hands out a token that is not header-safe: refused where it comes in, never used, never kept.
  for (const kind of ['results', 'prework', 'share']) {
    const dir = folder()
    const tokens = memoryOwnerTokens()
    const service = standIn()
    service.created[kind] = unsafe
    // Past the stand-in, the real fetch: what it would say about the header is what a window would get.
    const standInFetch = service.fetch
    service.fetch = async (url, init) => (/^\/(results|prework|shares)$/.test(new URL(String(url)).pathname) ? standInFetch(url, init) : (service.calls.push({ real: true }), fetch('http://127.0.0.1:9/never', init)))
    const app = modules(dir, tokens, service)
    const attempt = kind === 'results' ? app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)
      : kind === 'prework' ? app.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 })
        : app.shared.share(outlineOf(7), 'T')
    await assert.rejects(attempt, (error) => !carries(error) && /incomplete|unusable/.test(error.message), `${kind}: a token that is not header-safe is refused, in words that do not hold it`)
    assert.equal(service.calls.filter((call) => call.real).length, 0, `${kind}: and no request is made with it`)
    assert.equal(tokens.secrets.files.blobs.size, 0, `${kind}: and it is not stored`)
    assert.deepEqual(tokensOnDisk(dir), [])
  }
  // A token in a registry or in the store that is not header-safe: the row is not used.
  {
    const dir = folder()
    const doc = LEGACY['run-results'](1)
    doc.shares['talk-0/run-0'].ownerToken = unsafe
    writeLegacy(join(dir, OWNER_TOKEN_REGISTRIES['run-results'].file), doc)
    const tokens = memoryOwnerTokens()
    const service = standIn()
    const app = modules(dir, tokens, service)
    assert.equal(app.results.status('talk-0', 'run-0'), null, 'a row whose token is not header-safe is not a link')
    assert.deepEqual(await app.results.refresh('talk-0', 'run-0', RUN), { ok: true, share: null })
    assert.deepEqual(service.calls, [])
    tokens.secrets.store.write('owner-tokens', JSON.stringify({ version: 1, tokens: { [ownerTokenKey('results', 'results0', ORIGIN)]: unsafe } }))
    assert.equal(createOwnerTokens(tokens.secrets.store).get(ownerTokenKey('results', 'results0', ORIGIN)), null, 'nor is one read from the store')
  }
  // A request with a good token that cannot be sent: fixed words in what a window, a log or the console gets.
  {
    const dir = legacyFolder(1)
    const tokens = memoryOwnerTokens()
    migrateOwnerTokens(dir, tokens)
    const service = standIn()
    service.fail = (call) => { if (holds(call.auth, MARK)) throw new TypeError(`fetch failed: ${call.auth}`, { cause: new Error(call.auth) }) }
    const logs = []
    const app = modules(dir, tokens, service, logs)
    const warned = []
    const realWarn = console.warn
    console.warn = (...args) => warned.push(args.map(String).join(' '))
    try {
      await assert.rejects(app.results.share('talk-0', 'run-0', RUN, SHARE_OPTIONS), (error) => error.message === RESULTS_LINK_NOT_REACHED && !carries(error))
      assert.deepEqual(await app.results.refresh('talk-0', 'run-0', RUN), { ok: false, error: RESULTS_LINK_NOT_REACHED })
      assert.equal((await app.results.stop('talk-0', 'run-0')).ok, false)
      await assert.rejects(app.prework.publish('talk-0', 'run-0', { steps: [] }, { opensAt: 1, closesAt: 2 }), (error) => error.message === PREWORK_FORM_NOT_REACHED && !carries(error))
      assert.equal(holds(JSON.stringify(await app.prework.close('talk-0', 'run-0')), MARK), false)
      const updated = await app.shared.update(outlineOf(0))
      assert.equal(updated.lastError, 'the sharing service could not be reached.', 'the sheet shows fixed words')
      await assert.rejects(app.shared.stop(outlineOf(0)), (error) => error.message === 'Could not stop sharing: the sharing service could not be reached.' && !carries(error))
      assert.equal(holds(JSON.stringify(app.shared.list()), MARK), false)
    } finally { console.warn = realWarn }
    assert.ok(service.ownerCalls().length >= 6, 'each of those requests really carried its token')
    assert.ok(logs.length > 0, 'the push failure was logged')
    assert.equal(holds([...logs, ...warned].join('\n'), MARK), false, 'and no log line holds a token')
  }
}
console.log('PASS 7.2: a token must be header-safe wherever it comes in; a request that carries one fails in fixed words only')

// 7.3 Nothing is published before its token is kept.
{
  // Readable is not writable: with a store that reads but does not take a write, nothing is made.
  const stuck = memorySecrets()
  const stuckTokens = createOwnerTokens(stuck.store, { now: () => 0 })
  stuckTokens.store({ [ownerTokenKey('share', 'shtalk00', ORIGIN)]: `${MARK}share-0-0123456789` })
  const slotBefore = Buffer.from([...stuck.files.blobs.values()][0])
  assert.doesNotThrow(() => stuckTokens.assertCanStore())
  assert.ok([...stuck.files.blobs.values()][0].equals(slotBefore), 'the proof writes back exactly what was there')
  stuck.files.knobs.failWrites = true
  assert.equal(stuckTokens.readable(), true, 'the store can still be read')
  assert.throws(() => stuckTokens.assertCanStore(), (error) => error instanceof SecretsError && error.code === 'not-saved', 'but a store that takes no write does not pass')
  const empty = memorySecrets()
  const emptyTokens = createOwnerTokens(empty.store)
  assert.doesNotThrow(() => emptyTokens.assertCanStore())
  assert.equal(empty.files.blobs.size, 0, 'the proof leaves no file behind when there are no tokens')
  assert.ok(empty.files.knobs.writes > 0, 'though it really wrote')
  empty.files.knobs.failWrites = true
  assert.throws(() => emptyTokens.assertCanStore(), SecretsError)
  for (const tokens of [Object.assign(stuckTokens, { secrets: stuck }), Object.assign(emptyTokens, { secrets: empty })]) {
    const dir = folder()
    const service = standIn()
    const app = modules(dir, tokens, service)
    const refusal = secretsFailureMessage('not-saved', 'owner-tokens')
    await assert.rejects(app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS), (error) => error.message === refusal)
    await assert.rejects(app.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 }), (error) => error.message === refusal)
    await assert.rejects(app.shared.share(outlineOf(7), 'T'), (error) => error.message === refusal)
    assert.deepEqual(service.calls, [], 'a store that cannot take a write: nothing is made on the service, nothing is published')
    assert.deepEqual(readdirSync(dir), [])
  }
  // The store stops taking writes between the proof and the save (the object now exists): it is
  // closed with its own token, nothing is published to it, and the words are fixed.
  for (const [closeStatus, said] of [[200, { results: RESULTS_LINK_NOT_KEPT, prework: PREWORK_NOT_KEPT, share: SHARE_NOT_KEPT }], [500, { results: RESULTS_LINK_NOT_KEPT_OPEN, prework: PREWORK_NOT_KEPT_OPEN, share: SHARE_NOT_KEPT_OPEN }]]) {
    for (const kind of ['results', 'prework', 'share']) {
      const dir = folder()
      const tokens = memoryOwnerTokens()
      const service = standIn()
      service.closeStatus = closeStatus
      service.onCreate = () => { tokens.secrets.files.knobs.failWrites = true }
      const app = modules(dir, tokens, service)
      const attempt = kind === 'results' ? app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)
        : kind === 'prework' ? app.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 })
          : app.shared.share(outlineOf(7), 'T')
      await assert.rejects(attempt, (error) => error.message === said[kind] && !holds(error.message + error.stack, MARK), `${kind}: fixed words when the token cannot be kept`)
      const withToken = service.ownerCalls()
      assert.deepEqual(withToken.map((call) => [call.method, call.route.split('/').at(-1), call.auth]), [['POST', 'close', `Bearer ${NEW[kind]}`]],
        `${kind}: the one request with the new token closes it; nothing is published`)
      assert.deepEqual(tokensOnDisk(dir), [], `${kind}: no token in a file`)
      assert.equal(tokens.secrets.files.blobs.size, 0, `${kind}: none in the store`)
      for (const file of readdirSync(dir)) assert.equal(holds(readFileSync(join(dir, file), 'utf8'), 'new'), false, `${kind}: and no row for it`)
      if (kind === 'share') assert.deepEqual(app.shared.list(), [], 'the share is not held in memory either')
    }
  }
  // Made and kept: every request with the new token comes after the token is in the store.
  for (const kind of ['results', 'prework', 'share']) {
    const dir = folder()
    const tokens = memoryOwnerTokens()
    const service = standIn()
    const keptWhenUsed = []
    const storeKey = { results: ownerTokenKey('results', 'newres00', ORIGIN), prework: ownerTokenKey('prework', 'newpre00', ORIGIN), share: ownerTokenKey('share', 'newshr00', ORIGIN) }[kind]
    service.onOwnerCall = () => keptWhenUsed.push(createOwnerTokens(tokens.secrets.store).get(storeKey) === NEW[kind] && readdirSync(dir).some((file) => holds(readFileSync(join(dir, file), 'utf8'), 'new')))
    const app = modules(dir, tokens, service)
    if (kind === 'results') await app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)
    else if (kind === 'prework') await app.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 })
    else { await app.shared.share(outlineOf(7), 'T'); await app.shared.idle() }
    assert.ok(keptWhenUsed.length > 0 && keptWhenUsed.every(Boolean), `${kind}: content is published only once the token is in the store and the row in the registry`)
  }
}
console.log('PASS 7.3: a store that cannot take a write makes nothing; a token that cannot be kept closes what was made; nothing is published before the token is kept')

// 7.5 A registry that cannot be parsed is never written over.
for (const name of OWNER_TOKEN_REGISTRY_NAMES) {
  const spec = OWNER_TOKEN_REGISTRIES[name]
  const rows = rowsIn(name, LEGACY[name](1))
  const [k0] = Object.keys(rows)
  const damaged = ['{"version": 1, "sha', '', 'null', '[]', '"text"', '{}', `{"version":${spec.version}}`,
    JSON.stringify({ version: spec.version, [spec.collection]: [] }), JSON.stringify({ version: spec.version, [spec.collection]: 'rows' }),
    JSON.stringify({ version: spec.version, [spec.collection]: null }), `{"version":${spec.version},"${spec.collection}":{"k":{"${spec.idField}":"kept0000","workerBaseUrl":"${ORIGIN}"}}} trailing`]
  for (const text of damaged) {
    const dir = folder()
    const path = join(dir, spec.file)
    writeFileSync(path, text)
    const tokens = memoryOwnerTokens()
    const registry = openOwnerTokenRegistry(name, path, tokens)
    const refused = (error) => error instanceof OwnerRegistryError && error.code === 'unreadable' && error.registry === name && holds(error.message, spec.file) && !holds(error.message + error.stack, MARK)
    assert.throws(() => registry.write({ [k0]: rows[k0] }), refused, `${name}: a write to a registry that cannot be parsed is refused (${JSON.stringify(text.slice(0, 24))})`)
    assert.throws(() => registry.write({}), refused)
    assert.throws(() => registry.write({}, { remove: [k0] }), refused)
    assert.throws(() => registry.assertCanStore(), refused, `${name}: and nothing new may be made for it`)
    assert.throws(() => registry.restorePlain(), refused)
    assert.deepEqual(registry.migrate(), { found: 0, moved: 0, kept: 0 })
    assert.deepEqual(registry.read(), {})
    assert.equal(readFileSync(path, 'utf8'), text, `${name}: its bytes are as they were`)
    assert.deepEqual(readdirSync(dir), [spec.file], `${name}: nothing else is written`)
    assert.equal(tokens.secrets.files.blobs.size, 0, `${name}: and no token is put in the store for a row that was not written`)
  }
  // An empty registry is not a damaged one.
  const dir = folder()
  const path = join(dir, spec.file)
  writeFileSync(path, JSON.stringify({ version: spec.version, [spec.collection]: {} }))
  const registry = openOwnerTokenRegistry(name, path, memoryOwnerTokens())
  assert.doesNotThrow(() => registry.assertCanStore())
  registry.write({ [k0]: rows[k0] })
  assert.deepEqual(registry.read(), { [k0]: rows[k0] })
}
{
  // The real modules over damaged registries: nothing is made on the service, the files stay.
  const dir = folder()
  for (const name of OWNER_TOKEN_REGISTRY_NAMES) writeFileSync(join(dir, OWNER_TOKEN_REGISTRIES[name].file), '{"damaged": ')
  const service = standIn()
  const app = modules(dir, memoryOwnerTokens(), service)
  const named = (name) => (error) => holds(error.message, OWNER_TOKEN_REGISTRIES[name].file)
  await assert.rejects(app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS), named('run-results'))
  await assert.rejects(app.prework.publish('talk-9', 'run-9', { steps: [] }, { opensAt: 1, closesAt: 2 }), named('run-prework'))
  await assert.rejects(app.shared.share(outlineOf(7), 'T'), named('shared-talk'))
  assert.deepEqual(service.calls, [])
  assert.deepEqual(registryBytes(dir), ['{"damaged": ', '{"damaged": ', '{"damaged": '])
}
console.log('PASS 7.5: a registry that is not JSON, or does not hold its rows, refuses every write in fixed words and keeps its bytes')

// 7.6 A restore that did not bring everything back says so, by registry name.
{
  const dir = legacyFolder(2)
  const tokens = memoryOwnerTokens()
  migrateOwnerTokens(dir, tokens)
  const whole = restorePlainOwnerTokens(dir, tokens)
  assert.deepEqual(incompleteOwnerTokenRestores(whole), [], 'everything restored: nothing to report')
  migrateOwnerTokens(dir, tokens)
  // One registry damaged, one with a row whose token the store does not hold.
  const damagedPath = join(dir, OWNER_TOKEN_REGISTRIES['run-prework'].file)
  writeFileSync(damagedPath, '{"version": 1, "preworks": [')
  tokens.forget([ownerTokenKey('results', 'results1', ORIGIN)])
  const partial = restorePlainOwnerTokens(dir, tokens)
  assert.deepEqual(partial, { 'shared-talk': { restored: 2, missing: 0 }, 'run-results': { restored: 1, missing: 1 }, 'run-prework': { failed: true } })
  assert.deepEqual(incompleteOwnerTokenRestores(partial), ['run-results', 'run-prework'], 'a missing token and a damaged registry are both named')
  assert.equal(readFileSync(damagedPath, 'utf8'), '{"version": 1, "preworks": [', 'the damaged registry is as it was')
  assert.equal(holds(JSON.stringify(partial) + incompleteOwnerTokenRestores(partial).join(), MARK), false)
  const locked = memoryOwnerTokens()
  locked.secrets.store.write('owner-tokens', '{"version":1,"tokens":{}}')
  locked.secrets.cipher.state.locked = true
  assert.deepEqual(incompleteOwnerTokenRestores(restorePlainOwnerTokens(legacyFolder(1), locked)), OWNER_TOKEN_REGISTRY_NAMES, 'a store that cannot be read fails every registry')
}
console.log('PASS 7.6: a restore with a missing token or a damaged registry is reported as incomplete, naming the registry only')

// ── 8. Two operations on one Run's results link or pre-work at the same time ────────────────────
/**
 * A stand-in service that remembers what it made: each link has its own id and token, can be
 * published to and closed. `links.hold`, when set, delays the REPLY to a publish (the publish has
 * landed). An open link whose token the app no longer holds could never be stopped.
 */
function linkService() {
  const links = { made: new Map(), calls: [], hold: null }
  links.fetch = async (url, init = {}) => {
    const route = new URL(String(url)).pathname
    const method = init.method ?? 'GET'
    const auth = init.headers?.authorization ?? ''
    links.calls.push({ route, method })
    const making = method === 'POST' ? /^\/(results|prework|shares)$/.exec(route) : null
    if (making) {
      await new Promise((resolve) => setImmediate(resolve)) // the service takes a moment, as a real one does
      const id = `made000${links.made.size + 1}`
      const token = `${MARK}made-${links.made.size + 1}-0123456789`
      links.made.set(id, { token, closed: false, published: 0 })
      return reply(making[1] === 'prework' ? { preworkId: id, ownerToken: token } : { shareId: id, ownerToken: token }, 201)
    }
    const [, , id, action] = route.split('/')
    const link = links.made.get(id)
    if (!link || auth !== `Bearer ${link.token}`) return reply({ error: { message: 'not yours' } }, 401)
    if (action === 'close') { link.closed = true; return reply({ closed: true, closedAt: 5 }) }
    if (link.closed) return reply({ error: { message: 'closed' } }, 410)
    if (method === 'PUT') {
      link.published += 1
      if (links.hold) await links.hold
      return reply({ revision: link.published, seq: 1 })
    }
    return reply({ entries: [], more: false, seq: 0 })
  }
  links.open = () => [...links.made].filter(([, link]) => !link.closed).map(([id]) => id)
  return links
}
/** Open links on the service that this computer could not stop: no row for them, or no token. */
function orphans(links, tokens, dir) {
  const files = readdirSync(dir).filter((file) => file.endsWith('-registry.json')).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n')
  const kept = new Set()
  for (const kind of ['share', 'results', 'prework']) for (const id of links.made.keys()) if (createOwnerTokens(tokens.secrets.store).get(ownerTokenKey(kind, id, ORIGIN)) === links.made.get(id).token) kept.add(id)
  return links.open().filter((id) => !kept.has(id) || !holds(files, `"${id}"`))
}
const moments = async (count = 30) => { for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
const until = async (ready) => { for (let i = 0; i < 500 && !ready(); i += 1) await new Promise((resolve) => setImmediate(resolve)); assert.ok(ready(), 'the awaited moment came') }
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve }); return { promise, open } }
const RUN0 = { ...RUN, id: 'run-0', talkSlug: 'talk-0' }
const FORM = [{ steps: [] }, { opensAt: 1, closesAt: 2 }]
const settled = (results) => results.map((result) => result.status)
const quiet = (results) => results.every((result) => result.status === 'fulfilled' || !holds(`${result.reason?.message}${result.reason?.stack}`, MARK))

// 8.1 Two share requests for a Run whose link has expired: one link, and it can be stopped.
for (const instances of ['one', 'two']) {
  const dir = folder()
  const tokens = memoryOwnerTokens()
  const doc = LEGACY['run-results'](1)
  Object.assign(doc.shares['talk-0/run-0'], { lifetime: '7', expiresAt: 1000 })
  writeLegacy(join(dir, OWNER_TOKEN_REGISTRIES['run-results'].file), doc)
  migrateOwnerTokens(dir, tokens)
  const links = linkService()
  const first = modules(dir, tokens, links)
  // Two windows are one module; 'two' stands for anything the queue does not cover (the backstop).
  const second = instances === 'one' ? first : modules(dir, tokens, links)
  assert.equal(first.results.status('talk-0', 'run-0'), null, 'the earlier link has expired')
  const results = await Promise.allSettled([first.results.share('talk-0', 'run-0', RUN0, SHARE_OPTIONS), second.results.share('talk-0', 'run-0', RUN0, SHARE_OPTIONS)])
  assert.deepEqual(orphans(links, tokens, dir), [], `results (${instances}): no link is left open on the service without its token and its row`)
  assert.equal(links.open().length, 1, `results (${instances}): exactly one link is open`)
  assert.ok(first.results.status('talk-0', 'run-0')?.url.includes(links.open()[0]), `results (${instances}): and it is the Run's link`)
  assert.ok(quiet(results))
  if (instances === 'one') {
    assert.deepEqual(settled(results), ['fulfilled', 'fulfilled'], 'the second request waits for the first')
    assert.equal(results[0].value.url, results[1].value.url, 'and gets the same link')
    assert.equal(links.made.size, 1, 'only one link was ever made')
  } else {
    assert.deepEqual(settled(results).sort(), ['fulfilled', 'rejected'], 'outside the queue the loser is refused')
    assert.equal(results.find((result) => result.status === 'rejected').reason.message, RESULTS_LINK_NOT_KEPT, 'in fixed words, its link closed again')
    assert.equal([...links.made.values()].filter((link) => link.closed && link.published === 0).length, 1, 'the closed link was never published to')
  }
  assert.deepEqual(await first.results.stop('talk-0', 'run-0'), { ok: true })
  assert.deepEqual(links.open(), [], `results (${instances}): Stop sharing closes it`)
}
// The same for pre-work whose earlier row is dead (its token is gone from a readable store).
for (const instances of ['one', 'two']) {
  const dir = folder()
  const tokens = memoryOwnerTokens()
  writeLegacy(join(dir, OWNER_TOKEN_REGISTRIES['run-prework'].file), LEGACY['run-prework'](1))
  migrateOwnerTokens(dir, tokens)
  tokens.forget([ownerTokenKey('prework', 'prework0', ORIGIN)])
  const links = linkService()
  const first = modules(dir, tokens, links)
  const second = instances === 'one' ? first : modules(dir, tokens, links)
  const results = await Promise.allSettled([first.prework.publish('talk-0', 'run-0', ...FORM), second.prework.publish('talk-0', 'run-0', ...FORM)])
  assert.deepEqual(orphans(links, tokens, dir), [], `pre-work (${instances}): nothing is left open without its token and its row`)
  assert.equal(links.open().length, 1)
  assert.equal(first.prework.status('talk-0', 'run-0')?.preworkId, links.open()[0])
  assert.ok(quiet(results))
  if (instances === 'one') {
    assert.deepEqual(settled(results), ['fulfilled', 'fulfilled'])
    assert.equal(links.made.size, 1, 'pre-work: only one object was ever made')
  } else assert.equal(results.find((result) => result.status === 'rejected')?.reason.message, PREWORK_NOT_KEPT)
}
console.log('PASS 8.1: two requests at once for one Run\'s results link or pre-work leave one, registered and stoppable; a loser outside the queue is closed again')

// 8.2 Stop sharing while the first publish has landed but its reply has not come: stopped stays stopped.
for (const instances of ['one', 'two']) {
  const dir = folder()
  const tokens = memoryOwnerTokens()
  const links = linkService()
  const first = modules(dir, tokens, links)
  const second = instances === 'one' ? first : modules(dir, tokens, links)
  const reply1 = gate()
  links.hold = reply1.promise
  const sharing = first.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)
  await until(() => links.calls.some((call) => call.method === 'PUT'))
  const stopping = second.results.stop('talk-9', 'run-9')
  await moments() // a Stop that does not wait for the share runs to its end here
  reply1.open()
  const results = await Promise.allSettled([sharing, stopping])
  assert.ok(quiet(results))
  assert.deepEqual(results[1].value, { ok: true }, `results (${instances}): Stop sharing succeeds`)
  assert.deepEqual(links.open(), [], `results (${instances}): the link is closed on the service`)
  assert.equal(first.results.status('talk-9', 'run-9'), null, `results (${instances}): a late reply to the first publish does not bring the stopped link back`)
  assert.deepEqual(collectionOf('run-results', join(dir, OWNER_TOKEN_REGISTRIES['run-results'].file)), {}, `results (${instances}): no row`)
  assert.equal(tokens.secrets.files.blobs.size, 0, `results (${instances}): and no token`)
  if (instances === 'one') assert.equal(results[0].status, 'fulfilled', 'the share finished first; the Stop came after it')
}
{
  // A refresh whose reply is late, and a Stop meanwhile.
  const dir = folder()
  const tokens = memoryOwnerTokens()
  const links = linkService()
  const app = modules(dir, tokens, links)
  await app.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)
  const late = gate()
  links.hold = late.promise
  const refreshing = app.results.refresh('talk-9', 'run-9', RUN)
  await until(() => links.calls.filter((call) => call.method === 'PUT').length === 2)
  const stopping = app.results.stop('talk-9', 'run-9')
  await moments()
  late.open()
  await Promise.allSettled([refreshing, stopping])
  assert.equal(app.results.status('talk-9', 'run-9'), null, 'a late reply to a refresh does not bring a stopped link back')
  assert.equal(tokens.secrets.files.blobs.size, 0)
  assert.deepEqual(links.open(), [])
}
{
  // One that fails does not hold up the next for the same Run.
  const dir = folder()
  const tokens = memoryOwnerTokens()
  const links = linkService()
  const app = modules(dir, tokens, links)
  const realFetch = links.fetch
  let failing = true
  links.fetch = async (url, init) => { if (failing) { failing = false; throw new Error('down') } return realFetch(url, init) }
  const again = modules(dir, tokens, links)
  const results = await Promise.allSettled([again.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS), again.results.share('talk-9', 'run-9', RUN, SHARE_OPTIONS)])
  assert.deepEqual(settled(results), ['rejected', 'fulfilled'], 'a request that fails does not block the one waiting behind it')
  assert.ok(app.results.status('talk-9', 'run-9'))
}
console.log('PASS 8.2: a results link stopped while a publish or a refresh is unanswered stays stopped; a failed operation does not block the next')

rmSync(scratch, { recursive: true, force: true })
console.log('owner tokens: store, migration, interruptions, writes, going back, the real modules — passed')
