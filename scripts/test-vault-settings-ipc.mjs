// Add vault / Edit this vault IPC (several-vaults ticket 04, review round S3). Seam: the handlers
// registerVaultSettingsIpc installs (src/main/vault-settings-ipc.ts), driven with a fake ipcMain over
// a real registry, the real vault-file store and real temp folders. What is under test is what a
// failure part-way leaves behind: a logo copied in and then not used is taken back, a vault file is
// never written for personal-only changes, and every message says what is actually on disk.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultRegistry } from '../src/main/vault-registry.ts'
import { createVaultFileStore } from '../src/main/vault-file.ts'
import { viewVaults } from '../src/main/vault-view.ts'
import { registerVaultSettingsIpc } from '../src/main/vault-settings-ipc.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-vault-ipc-')))
const dir = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
const brand = dir('Brand')
writeFileSync(join(brand, 'crest.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
const vaultJson = (root) => join(root, '.talkweaver', 'vault.json')
const logos = (root) => (existsSync(join(root, '_assets', 'logos')) ? readdirSync(join(root, '_assets', 'logos')) : [])

console.error = () => {} // the handlers log the failures this file provokes on purpose
let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

/** A registry + handlers. `failConfig(patch)` → true makes that config write throw; `files` wraps the store. */
function harness({ failConfig = () => false, files = (real) => real } = {}) {
  let config = {}
  const real = createVaultFileStore()
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { if (failConfig(patch)) throw new Error('ENOSPC'); config = { ...config, ...structuredClone(patch) } },
    realpath: (p) => realpathSync(p),
    files: files(real)
  })
  const handlers = new Map()
  registerVaultSettingsIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    windowOf: () => null,
    registry,
    views: () => viewVaults(registry.list(), { home: '/nowhere', exists: () => false }, (v) => ({ file: real.read(v.root), personal: registry.personal(v.id) })),
    probe: { home: '/nowhere', exists: () => false },
    appAuthor: () => 'Settings Author',
    appDefaults: () => ({}),
    e2e: true
  })
  const call = (channel, ...args) => handlers.get(channel)({ sender: null }, ...args)
  return { registry, call, config: () => config }
}
const fields = (over = {}) => ({ name: 'V', shared: false, affiliation: '', style: '', logo: '', ...over })

console.log('vault settings IPC')

await test('create: a vault file that appears between choosing the folder and Create — refused, the copied logo taken back', async () => {
  const V = dir('race')
  const { call } = harness()
  const chosen = await call('vault:choose-folder', V)
  assert.equal(chosen.kind, 'new')
  const logo = await call('vault:choose-logo', { token: chosen.token }, join(brand, 'crest.svg'))
  assert.ok(logo.upload, 'an outside logo comes back as an upload token')
  mkdirSync(join(V, '.talkweaver'), { recursive: true })
  writeFileSync(vaultJson(V), JSON.stringify({ schema: 1, id: 'colleague', name: 'Theirs', shared: true }))
  const out = await call('vault:create', chosen.token, { ...fields(), logoUpload: logo.upload }, {})
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'has-vault-file')
  assert.deepEqual(logos(V), [], 'no logo left behind')
  assert.equal(JSON.parse(readFileSync(vaultJson(V), 'utf8')).id, 'colleague', 'their file untouched')
})

await test('create: config fails after the vault file is written — file and logo removed, message says so', async () => {
  const V = dir('config-fails')
  let armed = false
  const { call, config } = harness({ failConfig: (patch) => armed && 'vaults' in patch })
  const chosen = await call('vault:choose-folder', V)
  const logo = await call('vault:choose-logo', { token: chosen.token }, join(brand, 'crest.svg'))
  armed = true
  const out = await call('vault:create', chosen.token, { ...fields(), logoUpload: logo.upload }, {})
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'partial-write')
  assert.match(out.message, /removed again/)
  assert.doesNotMatch(out.message, /Nothing was/)
  assert.equal(existsSync(join(V, '.talkweaver')), false)
  assert.deepEqual(logos(V), [])
  assert.equal((config().vaults ?? []).length, 0)
})

await test('save: the vault file write fails after the logo is copied — logo taken back, file unchanged', async () => {
  const V = dir('save-fails')
  let failWrite = false
  const { call, registry } = harness({ files: (real) => ({ ...real, read: real.read, removeIfUnchanged: real.removeIfUnchanged, write: (r, f) => { if (failWrite) throw new Error('EIO'); real.write(r, f) } }) })
  const chosen = await call('vault:choose-folder', V)
  const created = await call('vault:create', chosen.token, fields({ affiliation: 'Oxford' }), {})
  assert.equal(created.ok, true)
  const before = readFileSync(vaultJson(V), 'utf8')
  const logo = await call('vault:choose-logo', { vaultId: created.vault.id }, join(brand, 'crest.svg'))
  failWrite = true
  const out = await call('vault:save-settings', created.vault.id, { ...fields({ affiliation: 'Oxford' }), logoUpload: logo.upload }, {})
  assert.equal(out.ok, false)
  assert.deepEqual(logos(V), [], 'copied logo removed')
  assert.equal(readFileSync(vaultJson(V), 'utf8'), before)
  assert.equal(registry.readFile(created.vault.id).file.logo, undefined)
})

await test('save: when the copied logo cannot be taken back, the message says it is still there', async () => {
  const V = dir('cannot-undo')
  let failWrite = false
  const { call } = harness({ files: (real) => ({ ...real, read: real.read, removeIfUnchanged: real.removeIfUnchanged, write: (r, f) => {
    if (failWrite) { chmodSync(join(r, '_assets', 'logos'), 0o555); throw new Error('EIO') }
    real.write(r, f)
  } }) })
  const chosen = await call('vault:choose-folder', V)
  const created = await call('vault:create', chosen.token, fields(), {})
  const logo = await call('vault:choose-logo', { vaultId: created.vault.id }, join(brand, 'crest.svg'))
  failWrite = true
  const out = await call('vault:save-settings', created.vault.id, { ...fields(), logoUpload: logo.upload }, {})
  chmodSync(join(V, '_assets', 'logos'), 0o755)
  assert.equal(out.ok, false)
  assert.match(out.message, /copy of the logo was left/)
  assert.doesNotMatch(out.message, /Nothing was/)
  assert.deepEqual(logos(V), ['crest.svg'])
})

await test('save: personal-only on a plain folder writes no vault file; a shared change does', async () => {
  const V = dir('Plain')
  const { call, registry, config } = harness()
  const added = registry.add(V)
  const out = await call('vault:save-settings', added.id, fields({ name: 'Plain' }), { author: 'Me', badgeColour: '#be185d' })
  assert.equal(out.ok, true)
  assert.equal(existsSync(join(V, '.talkweaver')), false)
  assert.equal(config().vaultPersonal[added.id].author, 'Me')
  const shared = await call('vault:save-settings', added.id, fields({ name: 'Plain', affiliation: 'Oxford' }), { author: 'Me' })
  assert.equal(shared.ok, true)
  assert.equal(JSON.parse(readFileSync(vaultJson(V), 'utf8')).affiliation, 'Oxford')
})

await test('save: the vault file saved but personal settings not — reported as a partial write', async () => {
  const V = dir('personal-fails')
  const { call, registry } = harness({ failConfig: (patch) => 'vaultPersonal' in patch })
  const added = registry.add(V)
  const out = await call('vault:save-settings', added.id, fields({ affiliation: 'Oxford' }), { author: 'Me' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'partial-write')
  assert.match(out.message, /shared settings were saved/)
  assert.equal(JSON.parse(readFileSync(vaultJson(V), 'utf8')).affiliation, 'Oxford')
})

await test('choose-folder: a folder whose vault file cannot be read is refused', async () => {
  const V = dir('placeholder')
  mkdirSync(join(V, '.talkweaver'), { recursive: true })
  writeFileSync(vaultJson(V), '')
  const { call } = harness()
  const out = await call('vault:choose-folder', V)
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'unreadable-file')
})

rmSync(base, { recursive: true, force: true })
console.log(`vault settings IPC: ${passed} passed`)
