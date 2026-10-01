// Vault availability (several-vaults ticket 07). Seams in src/main/vault-availability.ts:
//   vaultUnavailability — is a vault's folder there, and if not, why (derived locally, asynchronously);
//   createVaultAvailability — the throttled, time-limited check with its per-vault service and
//     last-seen caches;
//   writableRoot / mkdirBelowRoot — a write never re-creates a vault folder or anything above it.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  vaultUnavailability, createVaultAvailability, nodeAvailabilityProbe, writableRoot, mkdirBelowRoot,
  VaultUnavailableError, withTimeout
} from '../src/main/vault-availability.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

const HOME = '/Users/ann'
const probe = ({ dirs = [], denied = [], files = [] } = {}) => ({
  home: HOME,
  state: async (p) => (dirs.includes(p) ? 'dir' : denied.includes(p) ? 'denied' : files.includes(p) ? 'not-dir' : 'missing'),
  exists: async (p) => dirs.includes(p) || files.includes(p) || denied.includes(p)
})
const OD = `${HOME}/Library/CloudStorage/OneDrive-Uni`

// ── vaultUnavailability ──
await test('a reachable folder is available', async () => {
  assert.equal(await vaultUnavailability(`${HOME}/talks`, 'Local', probe({ dirs: [`${HOME}/talks`] })), null)
})
await test('a cloud folder whose service mount is gone reads "not signed in", with Open <service> settings (frame 2C)', async () => {
  const u = await vaultUnavailability(`${OD}/Oxford AICC`, 'OneDrive', probe({ dirs: [`${HOME}/Library/CloudStorage`] }))
  assert.equal(u.reason, 'not-signed-in')
  assert.equal(u.action, 'open-service')
  assert.equal(u.actionLabel, 'Open OneDrive settings')
  assert.equal(u.message, 'OneDrive is not signed in. Sign in and it comes back on its own.')
})
await test('a missing folder in a mount that is there reads "folder moved", with Check again', async () => {
  const u = await vaultUnavailability(`${OD}/Oxford AICC`, 'OneDrive', probe({ dirs: [OD] }))
  assert.equal(u.reason, 'folder-moved')
  assert.equal(u.action, 'retry')
  assert.equal(u.actionLabel, 'Check again')
})
await test('a renamed local folder (parent still there) reads "folder moved"', async () => {
  assert.equal((await vaultUnavailability(`${HOME}/gitrepos/talks`, 'Git', probe({ dirs: [`${HOME}/gitrepos`] }))).reason, 'folder-moved')
})
await test('a folder on a drive that is not mounted reads "folder not found"', async () => {
  assert.equal((await vaultUnavailability('/Volumes/Stick/talks', 'Local', probe())).reason, 'folder-not-found')
})
await test('a folder the system refuses reads "no permission"', async () => {
  assert.equal((await vaultUnavailability(`${HOME}/locked`, 'Local', probe({ denied: [`${HOME}/locked`] }))).reason, 'no-permission')
})
await test('a path that is now a file reads "folder not found"', async () => {
  assert.equal((await vaultUnavailability(`${HOME}/talks`, 'Local', probe({ files: [`${HOME}/talks`], dirs: [HOME] }))).reason, 'folder-not-found')
})
await test('messages carry no folder path', async () => {
  for (const u of [
    await vaultUnavailability(`${OD}/Oxford AICC`, 'OneDrive', probe()),
    await vaultUnavailability(`${OD}/Oxford AICC`, 'OneDrive', probe({ dirs: [OD] })),
    await vaultUnavailability(`${HOME}/locked`, 'Local', probe({ denied: [`${HOME}/locked`] }))
  ]) assert.doesNotMatch(u.message, /\/Users|CloudStorage/)
})

// ── the real probe (a temp folder) ──
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tw-avail-')))
await test('the node probe: a folder is a dir, a file is not-dir, a missing path is missing', async () => {
  const p = nodeAvailabilityProbe(tmp)
  mkdirSync(join(tmp, 'v'))
  writeFileSync(join(tmp, 'f'), 'x')
  assert.equal(await p.state(join(tmp, 'v')), 'dir')
  assert.equal(await p.state(join(tmp, 'f')), 'not-dir')
  assert.equal(await p.state(join(tmp, 'gone')), 'missing')
  assert.equal(await p.exists(join(tmp, 'v')), true)
  assert.equal(await p.exists(join(tmp, 'gone')), false)
})
await test('the node probe opens the folder but reads no entry', async () => {
  let reads = 0
  const fs = {
    access: async () => {},
    opendir: async () => ({ read: async () => { reads += 1; return null }, close: async () => {} })
  }
  assert.equal(await nodeAvailabilityProbe('/h', fs).state('/h/v'), 'dir')
  assert.equal(reads, 0)
})

// ── createVaultAvailability ──
const hang = () => new Promise(() => {})
const monitor = (over = {}) => {
  let t = 0
  const calls = { state: 0, serviceOf: 0, writes: [] }
  const answers = over.answers ?? {}
  const m = createVaultAvailability({
    probe: {
      home: HOME,
      state: (p) => { calls.state += 1; const a = answers[p] ?? 'dir'; return a === 'hang' ? hang() : Promise.resolve(a) },
      exists: async (p) => p === HOME || p.startsWith(`${HOME}/gitrepos`) && !p.endsWith('talks')
    },
    serviceOf: () => { calls.serviceOf += 1; return 'Git' },
    serviceFromPath: () => 'Local',
    timeoutMs: over.timeoutMs ?? 50,
    throttleMs: 10_000,
    now: () => t,
    readLastGood: () => over.lastGood,
    writeLastGood: (all) => calls.writes.push(all)
  })
  return { m, calls, answers, advance: (ms) => { t += ms } }
}
const A = { id: 'a', root: `${HOME}/gitrepos/talks`, open: true }
const B = { id: 'b', root: `${HOME}/b`, open: true }
const C = { id: 'c', root: `${HOME}/closed`, open: false }

await test('a check marks a missing folder unavailable and leaves the others (and closed vaults are not looked at)', async () => {
  const { m, calls, answers } = monitor()
  answers[A.root] = 'missing'
  assert.equal(await m.check([A, B, C]), true)
  assert.equal(m.isUnavailable('a'), true)
  assert.equal(m.status('a').reason, 'folder-moved')
  assert.equal(m.isUnavailable('b'), false)
  assert.equal(m.isUnavailable('c'), false)
  assert.equal(calls.state, 2)
})
await test('a folder that does not answer within the timeout is unavailable ("not responding"), and the check still ends', async () => {
  const { m, answers } = monitor({ timeoutMs: 30 })
  answers[B.root] = 'hang'
  const started = Date.now()
  await m.check([A, B])
  assert.ok(Date.now() - started < 1000)
  assert.equal(m.status('b').reason, 'not-responding')
  assert.equal(m.status('b').action, 'retry')
  assert.equal(m.isUnavailable('a'), false)
})
await test('checks are throttled (10 s) unless forced; a changed vault list checks at once', async () => {
  const { m, calls, advance } = monitor()
  await m.check([A, B])
  await m.check([A, B])
  assert.equal(calls.state, 2, 'the second check within the throttle looks at nothing')
  advance(9_000)
  await m.check([A, B])
  assert.equal(calls.state, 2)
  await m.check([A, B], { force: true })
  assert.equal(calls.state, 4, 'Check again looks now')
  await m.check([A])
  assert.equal(calls.state, 5, 'a different vault list is checked at once')
  advance(10_001)
  await m.check([A])
  assert.equal(calls.state, 6)
})
await test('concurrent checks share one look at each folder', async () => {
  const { m, calls } = monitor()
  await Promise.all([m.check([A, B], { force: true }), m.check([A, B], { force: true })])
  assert.equal(calls.state, 2)
})
await test('a folder coming back is reported as a change, and is available again', async () => {
  const { m, answers } = monitor()
  answers[A.root] = 'missing'
  await m.check([A])
  delete answers[A.root]
  assert.equal(await m.check([A], { force: true }), true)
  assert.equal(m.isUnavailable('a'), false)
  assert.equal(await m.check([A], { force: true }), false, 'no change, no report')
})
await test('the service label is worked out once per vault and folder, and never for an unavailable one', async () => {
  const { m, calls, answers } = monitor()
  answers[A.root] = 'missing'
  await m.check([A, B])
  assert.equal(m.service(B), 'Git')
  assert.equal(m.service(B), 'Git')
  assert.equal(calls.serviceOf, 1)
  assert.equal(m.service(A), 'Local', 'from the path alone')
  assert.equal(calls.serviceOf, 1)
  assert.equal(m.service({ id: 'b', root: `${HOME}/b2` }), 'Git')
  assert.equal(calls.serviceOf, 2, 'a moved folder is classified again')
})
await test('an unavailable vault keeps its last-seen name and service, persisted and read back at launch', async () => {
  const first = monitor()
  first.m.remember('a', { name: 'Oxford AICC', service: 'OneDrive' })
  first.m.remember('a', { name: 'Oxford AICC', service: 'OneDrive' })
  assert.equal(first.calls.writes.length, 1, 'written only when it changes')
  const second = monitor({ lastGood: first.calls.writes[0] })
  second.answers[A.root] = 'missing'
  await second.m.check([A])
  assert.deepEqual(second.m.lastGood('a'), { name: 'Oxford AICC', service: 'OneDrive' })
  assert.equal(second.m.service(A), 'OneDrive')
  second.m.forget('a')
  assert.equal(second.m.lastGood('a'), null)
})
await test('withTimeout settles with the fallback when the promise hangs', async () => {
  assert.equal(await withTimeout(hang(), 10, () => 'late'), 'late')
  assert.equal(await withTimeout(Promise.resolve('now'), 1000, () => 'late'), 'now')
})

// ── writes ──
const realFs = { isDirectory: (p) => { try { return statSync(p).isDirectory() } catch { return false } }, mkdir: (p) => mkdirSync(p, { recursive: true }) }
await test('writableRoot: a folder that is there is writable; a moved one is not', async () => {
  const root = join(tmp, 'vault')
  mkdirSync(root)
  assert.equal(writableRoot(root, realFs), root)
  assert.equal(writableRoot(join(tmp, 'moved-away'), realFs), null)
  assert.equal(writableRoot(undefined, realFs), null)
})
await test('mkdirBelowRoot creates a talk folder below an existing vault folder', async () => {
  const root = join(tmp, 'vault')
  mkdirBelowRoot(root, join(root, 'Workshops', 'new-talk'), realFs)
  assert.equal(existsSync(join(root, 'Workshops', 'new-talk')), true)
})
await test('mkdirBelowRoot never re-creates a vault folder that has gone', async () => {
  const root = join(tmp, 'gone-vault')
  assert.throws(() => mkdirBelowRoot(root, join(root, 'new-talk'), realFs), (e) => e instanceof VaultUnavailableError && e.reason === 'vault-unavailable')
  assert.equal(existsSync(root), false)
})
await test('mkdirBelowRoot refuses the vault folder itself and anything outside it', async () => {
  const root = join(tmp, 'vault')
  assert.throws(() => mkdirBelowRoot(root, root, realFs), (e) => e.reason === 'outside-vault')
  assert.throws(() => mkdirBelowRoot(root, join(tmp, 'elsewhere'), realFs), (e) => e.reason === 'outside-vault')
  assert.throws(() => mkdirBelowRoot(root, join(root, '..', 'up'), realFs), (e) => e.reason === 'outside-vault')
  assert.equal(existsSync(join(tmp, 'elsewhere')), false)
})
rmSync(tmp, { recursive: true, force: true })
console.log(`test-vault-availability: ${passed} passed`)
