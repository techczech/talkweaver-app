// Runs INSIDE Electron (started by e2e/diagnose-secrets-store.mjs): the secrets module against the
// real `safeStorage` of this operating system, in a throwaway user-data folder. No window is opened.
// This folder's package.json carries the development app's name, so the operating system's key is
// the one every other end-to-end run of the development build already uses.
//
// It proves, with made-up values only (never printed):
//   - each slot round-trips through the real encryption;
//   - a file written the way earlier versions wrote it is read by the module, and a file the module
//     writes is read by the earlier code (the on-disk compatibility claim, both directions);
//   - live-session recovery in the earlier format loads through today's store;
//   - owner tokens move from plain registries into the store, read back, and can be restored;
//   - no made-up value is readable in any file of the folder afterwards.
import { app, safeStorage } from 'electron'
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const load = (path) => import(pathToFileURL(join(repo, path)).href)
const lines = []
const pass = (line) => { lines.push(`PASS ${line}`); console.log(`PASS ${line}`) }
function check(condition, what) {
  if (!condition) throw new Error(`FAILED: ${what}`) // `what` is a fixed description, never a value
}

async function main() {
  await app.whenReady()
  app.dock?.hide()
  const dir = app.getPath('userData')
  const { SECRET_SLOTS, SECRET_SLOT_NAMES, secretsSlot } = await load('src/main/secrets-store.ts')
  const { openSecretsStore } = await load('src/main/secrets-store-electron.ts')
  const { createLiveSessionStore } = await load('src/main/live-session-store.ts')
  const owner = await load('src/main/owner-tokens.ts')

  // Never anywhere but the folder the driver made for this run, and only while it holds no secrets
  // file and no registry. (Compared as real paths: the system's temporary folder is reached through
  // a link on macOS.) Nothing has been read or written before this line.
  const expected = process.env.TW_SECRETS_HOST_DIR
  const ours = [...Object.values(SECRET_SLOTS), ...Object.values(owner.OWNER_TOKEN_REGISTRIES)].map((entry) => entry.file)
  check(Boolean(expected) && existsSync(dir) && existsSync(expected) && realpathSync(dir) === realpathSync(expected)
    && ours.every((file) => !existsSync(join(dir, file))), 'the user-data folder is the throwaway one, with no secrets in it yet')

  const FAKE = {
    'cloudflare-token': 'test-token-cloudflare-e2e-0001',
    'live-worker-credentials': JSON.stringify({ adminSecret: 'test-token-admin-e2e-0002', signingSecret: 'test-token-signing-e2e-0003' }),
    'recording-keys': JSON.stringify({ accessKeyId: 'test-token-keyid-e2e-0004', secretAccessKey: 'test-token-keysecret-e2e-0005' }),
    'live-sessions': JSON.stringify({ version: 1, sessions: [] }),
    'owner-tokens': JSON.stringify({ version: 1, tokens: { 'share:abcd2345@https://live.example.test': 'test-token-owner-e2e-0006' } }),
  }
  const fileOf = (slot) => join(dir, SECRET_SLOTS[slot].file)
  /** The earlier code's read: safeStorage.decryptString(readFileSync(path)). Null when it cannot. */
  const earlierRead = (path) => { try { return safeStorage.decryptString(readFileSync(path)) } catch { return null } }

  check(safeStorage.isEncryptionAvailable() === true, 'the operating system\'s encryption is available')
  const store = openSecretsStore(dir)
  check(store.availability().ok === true, 'the store accepts writes')
  if (process.platform === 'linux') check(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend()), 'a real keyring backend')

  // 1. Each slot through the real encryption, and read back by the earlier code.
  for (const slot of SECRET_SLOT_NAMES) {
    check(store.has(slot) === false && store.read(slot) === null, `${slot}: empty at first`)
    store.write(slot, FAKE[slot])
    check(store.has(slot) === true && store.read(slot) === FAKE[slot], `${slot}: round trip through the module`)
    const bytes = readFileSync(fileOf(slot))
    check(!bytes.includes(Buffer.from(FAKE[slot])) && !bytes.includes(Buffer.from('test-token-')), `${slot}: the file is not readable text`)
    check(earlierRead(fileOf(slot)) === FAKE[slot], `${slot}: what the module wrote, the earlier code reads`)
    store.clear(slot)
    check(!existsSync(fileOf(slot)) && store.has(slot) === false, `${slot}: cleared`)
  }
  pass(`each of the ${SECRET_SLOT_NAMES.length} slots round-trips through the real safeStorage (${process.platform}); files written by the module are read by the earlier code`)

  // 2. Files written the way earlier versions wrote them, read by the module with no migration.
  //    (index.ts before this module: writeFileSync(path, safeStorage.encryptString(text));
  //    live-session-store.ts: path + '.tmp', mode 0600, renamed.)
  for (const slot of ['cloudflare-token', 'live-worker-credentials', 'recording-keys']) {
    writeFileSync(fileOf(slot), safeStorage.encryptString(FAKE[slot]))
    check(store.has(slot) && store.read(slot) === FAKE[slot], `${slot}: an earlier version's file is read by the module`)
  }
  const record = {
    sessionId: 's1', baseUrl: 'https://live.example.test', presenterToken: 'test-token-presenter-e2e-0007', shortId: 'ab', shortUrl: 'https://x.test/ab', qrSvg: '',
    talkSlug: 'talk', vaultRoot: null, expiresAt: Date.now() + 60_000, startedAtMs: Date.now(), status: 'live', endRequested: false,
    pending: [], polls: [], voteRecords: [], cursor: 0, latest: null,
  }
  const temporary = fileOf('live-sessions') + '.tmp'
  writeFileSync(temporary, safeStorage.encryptString(JSON.stringify({ version: 1, sessions: [record] })), { mode: 0o600 })
  renameSync(temporary, fileOf('live-sessions'))
  const recovery = createLiveSessionStore(secretsSlot(store, 'live-sessions'))
  check(recovery.load().length === 1 && recovery.load()[0].presenterToken === record.presenterToken, 'live-session recovery written by an earlier version loads')
  recovery.save([{ ...record, cursor: 9 }])
  const savedRecovery = JSON.parse(earlierRead(fileOf('live-sessions')) ?? '{}')
  check(savedRecovery.version === 1 && savedRecovery.sessions?.[0]?.cursor === 9, 'recovery saved by the module is the earlier format')
  pass('files written the earlier way (token, live service keys, recording keys, live-session recovery) are read by the module, and the reverse')

  // 3. Owner tokens: plain registries → the store (real encryption) → read back; then the restore.
  const legacy = {
    'shared-talk': { version: 2, shares: { 'id:a': { key: 'id:a', slug: 'a', workerSlug: 'a-1', outlinePath: join(dir, 'a-outline.md'), realPath: join(dir, 'a-outline.md'), shareId: 'shtalk00', ownerToken: 'test-token-owner-e2e-share-0008', workerBaseUrl: 'https://live.example.test', revision: 1, liveUpdates: true, proposals: true } } },
    'run-results': { version: 1, shares: { 'a/r': { key: 'a/r', shareId: 'results0', ownerToken: 'test-token-owner-e2e-results-0009', workerBaseUrl: 'https://live.example.test', include: { board: true, polls: true }, lifetime: 'forever', expiresAt: null, createdAt: 1, pushedAt: 1 } } },
    'run-prework': { version: 1, preworks: { 'a/r': { key: 'a/r', preworkId: 'prework0', ownerToken: 'test-token-owner-e2e-prework-0010', workerBaseUrl: 'https://live.example.test', opensAt: 1, closesAt: 2, cursor: 0, createdAt: 1 } } },
  }
  for (const name of owner.OWNER_TOKEN_REGISTRY_NAMES) writeFileSync(join(dir, owner.OWNER_TOKEN_REGISTRIES[name].file), `${JSON.stringify(legacy[name], null, 2)}\n`, { mode: 0o600 })
  const tokens = owner.createOwnerTokens(store)
  const moved = owner.migrateOwnerTokens(dir, tokens)
  check(owner.OWNER_TOKEN_REGISTRY_NAMES.every((name) => moved[name].found === 1 && moved[name].moved === 1 && moved[name].kept === 0), 'each registry\'s token moved into the store')
  const again = owner.createOwnerTokens(openSecretsStore(dir)) // as at the next start
  for (const name of owner.OWNER_TOKEN_REGISTRY_NAMES) {
    const spec = owner.OWNER_TOKEN_REGISTRIES[name]
    const before = Object.values(legacy[name][spec.collection])[0]
    const row = Object.values(owner.openOwnerTokenRegistry(name, join(dir, spec.file), again).read())[0]
    check(row.ownerToken === before.ownerToken, `${name}: the token reads back from the store`)
    check(!readFileSync(join(dir, spec.file), 'utf8').includes('ownerToken'), `${name}: the registry carries no token`)
  }
  const repeat = owner.migrateOwnerTokens(dir, again)
  check(owner.OWNER_TOKEN_REGISTRY_NAMES.every((name) => repeat[name].found === 0), 'a second run finds nothing to move')
  pass('owner tokens move from the three plain registries into the store and read back at the next start')

  // 4. Nothing made up is readable in any file of the folder (Electron's own files included).
  const readable = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const bytes = readFileSync(path)
        if (bytes.includes(Buffer.from('test-token-')) || bytes.includes(Buffer.from('test-token-', 'utf16le'))) readable.push(entry.name)
      }
    }
  }
  walk(dir)
  check(readable.length === 0, 'no made-up secret is readable in any file of the user-data folder')
  pass('no secret value is readable in any file of the user-data folder')

  // 5. The restore for an earlier version puts the tokens back, readable by it.
  const restored = owner.restorePlainOwnerTokens(dir, again)
  check(owner.OWNER_TOKEN_REGISTRY_NAMES.every((name) => restored[name].restored === 1 && restored[name].missing === 0), 'each registry got its token back')
  for (const name of owner.OWNER_TOKEN_REGISTRY_NAMES) {
    const spec = owner.OWNER_TOKEN_REGISTRIES[name]
    const row = Object.values(JSON.parse(readFileSync(join(dir, spec.file), 'utf8'))[spec.collection])[0]
    check(row.ownerToken === Object.values(legacy[name][spec.collection])[0].ownerToken, `${name}: restored as the earlier version wrote it`)
  }
  pass('the restore writes the tokens back into the registries for an earlier version')
}

main().then(() => {
  console.log(`SECRETS-HOST OK ${lines.length}`)
  app.exit(0)
}, (error) => {
  // Fixed descriptions only; an unexpected error is reported by its type, never its text.
  const text = error instanceof Error && error.message.startsWith('FAILED: ') ? error.message : `FAILED: unexpected ${error?.name ?? 'error'}`
  console.log(text)
  app.exit(1)
})
