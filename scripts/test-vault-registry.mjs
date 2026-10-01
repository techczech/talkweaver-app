// Vault registry (several-vaults ticket 01). Seams: the VaultRegistry public API and the config
// migration function (src/main/vault-registry.ts), over an in-memory config.json the way index.ts
// wires it (read the whole file, write a merged patch). Real temp folders stand in for vaults so the
// "nothing written inside a vault" check looks at a real directory.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultRegistry, migrateVaultConfig, VaultRefusal } from '../src/main/vault-registry.ts'
import { createVaultFileStore } from '../src/main/vault-file.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-vault-registry-')))
const dir = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
const A = dir('A')
const B = dir('B')
const C = dir('C')

function harness(initial = {}) {
  let config = structuredClone(initial)
  let writes = 0
  let n = 0
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { writes++; config = { ...config, ...structuredClone(patch) } },
    newId: () => `id-${++n}`
  })
  return { registry, config: () => config, writes: () => writes }
}

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

console.log('vault registry')

test('migration: a config with only vaultRoot becomes one open vault with a generated id', () => {
  const { slice, changed } = migrateVaultConfig({ vaultRoot: A, windowBounds: { width: 1 } }, () => 'gen-1')
  assert.equal(changed, true)
  assert.deepEqual(slice.vaults, [{ id: 'gen-1', root: A, open: true, order: 0 }])
  assert.equal(slice.vaultRoot, A, 'vaultRoot is kept for older builds')
  assert.equal(slice.vaultRootMirrored, A)
})

test('migration: idempotent — migrating its own output changes nothing and generates no id', () => {
  const first = migrateVaultConfig({ vaultRoot: A }, () => 'gen-1').slice
  const second = migrateVaultConfig(first, () => { throw new Error('no new id expected') })
  assert.equal(second.changed, false)
  assert.deepEqual(second.slice, first)
})

test('migration: empty config stays empty and unwritten (no vault, no vaultRoot invented)', () => {
  const { slice, changed } = migrateVaultConfig({}, () => 'x')
  assert.deepEqual(slice.vaults, [])
  assert.equal(slice.vaultRoot, undefined)
  assert.equal(changed, false, 'an empty (or unreadable) config is never rewritten by a read')
})

test('migration: vaultRoot changed by an older build is adopted as the first open vault', () => {
  const migrated = migrateVaultConfig({ vaultRoot: A }, () => 'a').slice
  const olderBuildWrote = { ...migrated, vaultRoot: B }
  const { slice } = migrateVaultConfig(olderBuildWrote, () => 'b')
  assert.deepEqual(slice.vaults, [
    { id: 'b', root: B, open: true, order: 0 },
    { id: 'a', root: A, open: false, order: 1 }
  ])
  assert.equal(slice.vaultRoot, B)
  // …and switching back reuses the existing vault and its id.
  const back = migrateVaultConfig({ ...slice, vaultRoot: A }, () => { throw new Error('must reuse id a') }).slice
  assert.deepEqual(back.vaults.map((v) => [v.id, v.open]), [['a', true], ['b', false]])
})

test('migration: a missing vaultRoot is re-mirrored from the first open vault', () => {
  const { slice } = migrateVaultConfig({ vaults: [{ id: 'a', root: A, open: true, order: 0 }] })
  assert.equal(slice.vaultRoot, A)
})

test('migration: malformed and duplicate-id entries are dropped; order renumbered', () => {
  const { slice } = migrateVaultConfig({
    vaults: [{ id: 'b', root: B, open: true, order: 7 }, null, { id: 'b', root: C }, { root: C }, { id: 'a', root: A, order: 2 }],
    vaultRoot: A, vaultRootMirrored: A
  })
  assert.deepEqual(slice.vaults, [{ id: 'a', root: A, open: true, order: 0 }, { id: 'b', root: B, open: true, order: 1 }])
  assert.equal(slice.vaultRoot, A)
})

test('migration: writes nothing inside the vault folder', () => {
  const vault = dir('untouched')
  mkdirSync(join(vault, 'talk-one'))
  const before = readdirSync(vault, { recursive: true }).sort()
  const h = harness({ vaultRoot: vault })
  h.registry.list(); h.registry.primary(); h.registry.resolve(join(vault, 'talk-one'))
  assert.deepEqual(readdirSync(vault, { recursive: true }).sort(), before)
})

test('registry: reading migrates once and persists; vaultRoot stays in config', () => {
  const h = harness({ vaultRoot: A, archiveRoot: '/x' })
  assert.deepEqual(h.registry.list(), [{ id: 'id-1', root: A, open: true, order: 0 }])
  assert.equal(h.writes(), 1)
  h.registry.list(); h.registry.primary(); h.registry.get('id-1')
  assert.equal(h.writes(), 1, 'no further writes once migrated')
  assert.equal(h.config().vaultRoot, A)
  assert.equal(h.config().archiveRoot, '/x', 'other keys untouched')
  assert.equal(h.registry.primary().root, A)
  assert.equal(h.registry.get('nope'), null)
})

test('add: appends an open vault; primary and vaultRoot mirror stay on the first', () => {
  const h = harness({ vaultRoot: A })
  const b = h.registry.add(B)
  assert.deepEqual(b, { id: 'id-2', root: B, open: true, order: 1 })
  assert.deepEqual(h.registry.list().map((v) => v.root), [A, B])
  assert.equal(h.config().vaultRoot, A)
})

test('add: into an empty registry makes the first vault and mirrors vaultRoot', () => {
  const h = harness({})
  h.registry.add(A)
  assert.equal(h.config().vaultRoot, A)
  assert.equal(h.registry.primary().root, A)
})

test('add: refuses a duplicate, a root inside another vault, a root containing one, a relative path', () => {
  const h = harness({ vaultRoot: A })
  const refuse = (root, reason) => assert.throws(() => h.registry.add(root), (e) => e instanceof VaultRefusal && e.reason === reason)
  refuse(A, 'duplicate')
  refuse(A + '/', 'duplicate')
  refuse(join(A, 'sub'), 'inside-another')
  refuse(base, 'contains-another')
  refuse('relative/path', 'not-absolute')
  // A sibling whose name only shares a prefix is not nested.
  const sibling = dir('A-sibling')
  assert.equal(h.registry.add(sibling).root, sibling)
  assert.equal(h.registry.list().length, 2)
})

test('add: nesting is refused against closed vaults too', () => {
  const h = harness({ vaultRoot: A })
  const b = h.registry.add(B)
  h.registry.setOpen(b.id, false)
  assert.throws(() => h.registry.add(join(B, 'inner')), (e) => e.reason === 'inside-another')
})

test('resolve: paths inside, at the root of, and outside every vault', () => {
  const h = harness({ vaultRoot: A })
  h.registry.add(B)
  const inA = h.registry.resolve(join(A, 'Folder', 'talk', 'talk-outline.md'))
  assert.equal(inA.vault.root, A)
  assert.equal(inA.rel, 'Folder/talk/talk-outline.md')
  assert.equal(h.registry.resolve(join(B, 'x.md')).vault.root, B)
  assert.equal(h.registry.resolve(A).rel, '')
  assert.equal(h.registry.resolve(join(C, 'x.md')), null)
  assert.equal(h.registry.resolve(A + '-sibling/x.md'), null, 'prefix of the name is not inside')
  assert.equal(h.registry.resolve('relative/x.md'), null)
  assert.equal(h.registry.resolve(''), null)
})

test('setOpen: closing the first vault moves primary and the vaultRoot mirror; closing all keeps vaultRoot', () => {
  const h = harness({ vaultRoot: A })
  const b = h.registry.add(B)
  const a = h.registry.list()[0]
  assert.equal(h.registry.setOpen(a.id, false).open, false)
  assert.equal(h.registry.primary().id, b.id)
  assert.equal(h.config().vaultRoot, B)
  h.registry.setOpen(b.id, false)
  assert.equal(h.registry.primary(), null)
  assert.equal(h.config().vaultRoot, B, 'vaultRoot is never deleted')
  // Closing everything is not mistaken for an older build changing vaultRoot.
  assert.equal(h.registry.list().every((v) => !v.open), true)
  assert.throws(() => h.registry.setOpen('missing', true), (e) => e.reason === 'unknown-vault')
})

test('adoptRoot (vault:set-root shim): new root becomes the first open vault, previous closes; reuse keeps the id', () => {
  const h = harness({ vaultRoot: A })
  const aId = h.registry.primary().id
  const b = h.registry.adoptRoot(B)
  assert.equal(h.registry.primary().id, b.id)
  assert.equal(h.config().vaultRoot, B)
  assert.equal(h.registry.get(aId).open, false)
  const again = h.registry.adoptRoot(A)
  assert.equal(again.id, aId)
  assert.deepEqual(h.registry.list().map((v) => [v.root, v.open]), [[A, true], [B, false]])
  const writes = h.writes()
  h.registry.adoptRoot(A)
  assert.equal(h.writes(), writes, 'adopting the current root writes nothing')
})

test('adoptRoot: a root nesting with an open vault closes that vault instead of refusing', () => {
  const h = harness({ vaultRoot: A })
  const c = h.registry.add(C)
  const inner = dir('C', 'inner')
  h.registry.adoptRoot(inner)
  assert.equal(h.registry.primary().root, inner)
  assert.equal(h.registry.get(c.id).open, false)
  assert.throws(() => h.registry.setOpen(c.id, true), (e) => e.reason === 'contains-another')
})

test('onChange: fires on add, setOpen, adopt and migration; unsubscribe stops it', () => {
  const h = harness({ vaultRoot: A })
  const seen = []
  const off = h.registry.onChange((vaults) => seen.push(vaults.map((v) => v.root)))
  h.registry.list() // migration write
  const b = h.registry.add(B)
  h.registry.setOpen(b.id, false)
  h.registry.adoptRoot(C)
  assert.equal(seen.length, 4)
  assert.deepEqual(seen[1], [A, B])
  off()
  h.registry.add(dir('D'))
  assert.equal(seen.length, 4)
})

for (const bad of [null, '', '  ', 42]) {
  test(`reads never rewrite config when vaultRoot is ${JSON.stringify(bad)} (no vaults)`, () => {
    const h = harness({ vaultRoot: bad, archiveRoot: '/x' })
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(h.registry.list(), [])
      assert.equal(h.registry.primary(), null)
    }
    assert.equal(h.writes(), 0, 'no write at all: nothing changed')
    assert.deepEqual(h.config(), { vaultRoot: bad, archiveRoot: '/x' }, 'stored values carried through untouched')
  })
  test(`vaultRoot ${JSON.stringify(bad)} beside an open vault is mirrored once, then reads are quiet`, () => {
    const h = harness({ vaultRoot: bad, vaults: [{ id: 'a', root: A, open: true, order: 0 }] })
    h.registry.list(); h.registry.list(); h.registry.list()
    assert.equal(h.writes(), 1, 'one write for the mirror, none after')
    assert.equal(h.config().vaultRoot, A)
  })
  test(`vaultRoot ${JSON.stringify(bad)} with every vault closed: zero writes over three reads`, () => {
    const h = harness({ vaultRoot: bad, vaults: [{ id: 'a', root: A, open: false, order: 0 }] })
    h.registry.list(); h.registry.primary(); h.registry.get('a')
    assert.equal(h.writes(), 0)
  })
}

test('a failing write never breaks reads: the migrated list is served from memory, ids stable, logged once', () => {
  let config = { vaultRoot: A }
  let failing = true
  let attempts = 0
  let n = 0
  const errors = []
  const origError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const registry = createVaultRegistry({
      read: () => structuredClone(config),
      write: (patch) => {
        attempts++
        if (failing) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
        config = { ...config, ...structuredClone(patch) }
      },
      newId: () => `id-${++n}`
    })
    const first = registry.list()
    assert.deepEqual(first, [{ id: 'id-1', root: A, open: true, order: 0 }])
    assert.deepEqual(registry.list(), first, 'same id on the next read')
    assert.equal(registry.primary().root, A)
    assert.equal(registry.resolve(join(A, 'talk', 'x.md')).vault.id, 'id-1')
    assert.equal(attempts, 1, 'reads do not keep retrying the write')
    assert.equal(errors.length, 1, 'logged once')
    assert.deepEqual(config, { vaultRoot: A }, 'config.json untouched')
    // A mutation while the disk still fails reports the failure to its caller.
    assert.throws(() => registry.add(B), /EROFS/)
    // Once the disk accepts writes, the next mutation writes the whole migrated list.
    failing = false
    registry.add(B)
    assert.deepEqual(config.vaults.map((v) => [v.id, v.root]), [['id-1', A], [config.vaults[1].id, B]])
    assert.equal(config.vaultRoot, A)
    assert.equal(config.vaultRootMirrored, A)
  } finally {
    console.error = origError
  }
})

test('add with realpath: stores the resolved folder and refuses a symlink to, into or over an existing vault', () => {
  let config = {}
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { config = { ...config, ...structuredClone(patch) } },
    realpath: (p) => realpathSync(p)
  })
  registry.add(A)
  const linkToA = join(base, 'link-to-a')
  symlinkSync(A, linkToA)
  assert.throws(() => registry.add(linkToA), (e) => e instanceof VaultRefusal && e.reason === 'duplicate')
  const sub = dir('A', 'sub')
  const linkToSub = join(base, 'link-to-sub')
  symlinkSync(sub, linkToSub)
  assert.throws(() => registry.add(linkToSub), (e) => e instanceof VaultRefusal && e.reason === 'inside-another')
  const outer = dir('outer')
  const inner = dir('outer', 'inner')
  const linkToInner = join(base, 'link-to-inner')
  symlinkSync(inner, linkToInner)
  registry.add(linkToInner)
  assert.equal(registry.list().at(-1).root, inner, 'the resolved path is what is stored')
  const linkToOuter = join(base, 'link-to-outer')
  symlinkSync(outer, linkToOuter)
  assert.throws(() => registry.add(linkToOuter), (e) => e instanceof VaultRefusal && e.reason === 'contains-another')
})

// ── Ticket 04: the vault file, joining, duplicate ids and personal settings ──────────────────

/** A registry with the real vault-file store, over an in-memory config; counts file writes. */
function fileHarness(initial = {}) {
  let config = structuredClone(initial)
  let n = 0
  const real = createVaultFileStore()
  const fileWrites = []
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { config = { ...config, ...structuredClone(patch) } },
    newId: () => `fid-${++n}`,
    realpath: (p) => realpathSync(p),
    files: { read: (root) => real.read(root), write: (root, file) => { fileWrites.push(root); real.write(root, file) }, removeIfUnchanged: (root, file) => real.removeIfUnchanged(root, file) },
    now: () => new Date('2026-09-30T10:00:00.000Z')
  })
  return { registry, config: () => config, fileWrites }
}
const vaultJson = (root) => join(root, '.talkweaver', 'vault.json')
const snapshot = (root) => existsSync(vaultJson(root)) ? { bytes: readFileSync(vaultJson(root), 'utf8'), mtime: statSync(vaultJson(root)).mtimeMs } : null

test('create: the vault file is written once, before config, with the new id; list/get/open/readFile write nothing', () => {
  const N = dir('create-new')
  const { registry, config, fileWrites } = fileHarness()
  const v = registry.add(N, { create: { fields: { name: 'Workshops', shared: false, affiliation: 'Oxford' }, createdBy: 'Dominik' } })
  assert.equal(fileWrites.length, 1)
  const stored = JSON.parse(readFileSync(vaultJson(N), 'utf8'))
  assert.equal(stored.id, v.id)
  assert.equal(stored.name, 'Workshops')
  assert.equal(stored.created_by, 'Dominik')
  assert.equal(config().vaults.at(-1).id, v.id)
  const before = snapshot(N)
  registry.list(); registry.get(v.id); registry.readFile(v.id); registry.personal(v.id)
  registry.setOpen(v.id, false); registry.setOpen(v.id, true)
  assert.equal(fileWrites.length, 1, 'no further writes')
  assert.deepEqual(snapshot(N), before, 'bytes and mtime unchanged')
})

test('create refuses a folder that already has a vault file, and writes nothing when refused for nesting', () => {
  const J = dir('create-has-file')
  writeFileSync(join(dir('create-has-file', '.talkweaver'), 'vault.json'), JSON.stringify({ schema: 1, id: 'theirs', name: 'Theirs', shared: true }))
  const { registry, fileWrites } = fileHarness()
  assert.throws(() => registry.add(J, { create: { fields: { name: 'Mine' } } }), (e) => e instanceof VaultRefusal && e.reason === 'has-vault-file')
  const outer = dir('create-outer')
  registry.add(outer)
  const inner = dir('create-outer', 'inner')
  assert.throws(() => registry.add(inner, { create: { fields: { name: 'In' } } }), (e) => e instanceof VaultRefusal && e.reason === 'inside-another')
  assert.equal(existsSync(vaultJson(inner)), false)
  assert.equal(fileWrites.length, 0)
})

test('join: a folder with a vault file is added with the file’s id and the file is not touched', () => {
  const J = dir('join-anna')
  writeFileSync(join(dir('join-anna', '.talkweaver'), 'vault.json'), JSON.stringify({ schema: 1, id: 'anna-vault-id', name: 'AI and assessment workshop', shared: true, created_by: 'Anna Novak' }))
  const before = snapshot(J)
  const { registry, fileWrites } = fileHarness()
  const probe = registry.probe(J)
  assert.equal(probe.file.state, 'ok')
  assert.equal(probe.file.file.created_by, 'Anna Novak')
  const v = registry.add(J)
  assert.equal(v.id, 'anna-vault-id')
  assert.equal(fileWrites.length, 0)
  assert.deepEqual(snapshot(J), before)
})

test('duplicate id: a second root carrying the same vault id is refused, naming the first', () => {
  const first = dir('dup-first')
  const copy = dir('dup-copy')
  const body = JSON.stringify({ schema: 1, id: 'same-id', name: 'Oxford AICC', shared: true })
  writeFileSync(join(dir('dup-first', '.talkweaver'), 'vault.json'), body)
  writeFileSync(join(dir('dup-copy', '.talkweaver'), 'vault.json'), body)
  const { registry } = fileHarness()
  const a = registry.add(first)
  for (const call of [() => registry.probe(copy), () => registry.add(copy)]) {
    assert.throws(call, (e) => e instanceof VaultRefusal && e.reason === 'duplicate-id' && e.other?.id === a.id && e.other?.root === first)
  }
  assert.equal(registry.list().filter((v) => v.id === 'same-id').length, 1)
})

test('duplicate id: a vault whose folder later carries another vault’s id is not reopened', () => {
  const one = dir('dup2-one')
  const two = dir('dup2-two')
  const { registry } = fileHarness()
  const a = registry.add(one, { create: { fields: { name: 'One' } } })
  const b = registry.add(two)
  registry.setOpen(b.id, false)
  mkdirSync(join(two, '.talkweaver'), { recursive: true })
  writeFileSync(vaultJson(two), readFileSync(vaultJson(one), 'utf8'))
  assert.throws(() => registry.setOpen(b.id, true), (e) => e instanceof VaultRefusal && e.reason === 'duplicate-id' && e.other?.id === a.id)
})

test('saveFile: plain folder gets its file on first save with the config id; unknown keys kept; no-op save writes nothing', () => {
  const P = dir('save-plain')
  const { registry, fileWrites } = fileHarness()
  const v = registry.add(P)
  assert.deepEqual(registry.readFile(v.id), { state: 'none' }, 'adding a plain folder writes no file')
  registry.saveFile(v.id, { name: 'Personal', shared: false, affiliation: 'Oxford' }, { createdBy: 'Dominik' })
  const first = JSON.parse(readFileSync(vaultJson(P), 'utf8'))
  assert.equal(first.id, v.id)
  writeFileSync(vaultJson(P), JSON.stringify({ ...first, colleagueKey: 'keep me' }))
  registry.saveFile(v.id, { affiliation: 'University of Oxford' })
  const second = JSON.parse(readFileSync(vaultJson(P), 'utf8'))
  assert.equal(second.colleagueKey, 'keep me')
  assert.equal(second.affiliation, 'University of Oxford')
  const count = fileWrites.length
  const before = snapshot(P)
  registry.saveFile(v.id, { affiliation: 'University of Oxford' })
  assert.equal(fileWrites.length, count, 'unchanged content is not rewritten')
  assert.deepEqual(snapshot(P), before)
})

test('saveFile refuses an unreadable file, a newer schema and another vault’s file, leaving each as it is', () => {
  const U = dir('save-refuse')
  const { registry } = fileHarness()
  const v = registry.add(U)
  mkdirSync(join(U, '.talkweaver'), { recursive: true })
  for (const [text, reason] of [
    ['{broken', 'unreadable-file'],
    [JSON.stringify({ schema: 2, id: v.id, name: 'x', shared: false }), 'newer-schema'],
    [JSON.stringify({ schema: 1, id: 'someone-else', name: 'x', shared: false }), 'id-mismatch']
  ]) {
    writeFileSync(vaultJson(U), text)
    assert.throws(() => registry.saveFile(v.id, { name: 'y' }), (e) => e instanceof VaultRefusal && e.reason === reason, reason)
    assert.equal(readFileSync(vaultJson(U), 'utf8'), text)
  }
})

test('personal settings: stored in config by id, cleaned, blank removes; never inside the vault', () => {
  const Q = dir('personal')
  const { registry, config } = fileHarness()
  const v = registry.add(Q)
  assert.deepEqual(registry.personal(v.id), {})
  registry.setPersonal(v.id, { author: '  Anna Novak ', badgeColour: '#BE185D', badgeInitial: 'anna' })
  assert.deepEqual(registry.personal(v.id), { author: 'Anna Novak', badgeColour: '#be185d', badgeInitial: 'A' })
  assert.deepEqual(config().vaultPersonal[v.id], { author: 'Anna Novak', badgeColour: '#be185d', badgeInitial: 'A' })
  registry.setPersonal(v.id, { badgeColour: 'red', author: '' })
  assert.deepEqual(registry.personal(v.id), { badgeInitial: 'A' }, 'an invalid colour and a blank author are dropped')
  assert.equal(existsSync(join(Q, '.talkweaver')), false)
  assert.throws(() => registry.setPersonal('nope', { author: 'x' }), (e) => e instanceof VaultRefusal && e.reason === 'unknown-vault')
})

test('an id from an unwritten migration is never used for a vault file or personal settings', () => {
  const R = dir('unwritten')
  let config = { vaultRoot: R }
  let failing = true
  const real = createVaultFileStore()
  const origError = console.error
  console.error = () => {}
  try {
    const registry = createVaultRegistry({
      read: () => structuredClone(config),
      write: (patch) => { if (failing) throw new Error('EROFS'); config = { ...config, ...structuredClone(patch) } },
      newId: () => 'unstable-id',
      files: real
    })
    const [v] = registry.list()
    assert.throws(() => registry.saveFile(v.id, { name: 'X' }), (e) => e instanceof VaultRefusal && e.reason === 'config-unwritable')
    assert.throws(() => registry.setPersonal(v.id, { author: 'X' }), (e) => e instanceof VaultRefusal && e.reason === 'config-unwritable')
    assert.equal(existsSync(join(R, '.talkweaver')), false)
    failing = false
    registry.saveFile(v.id, { name: 'X' })
    assert.equal(config.vaults[0].id, 'unstable-id', 'the migration was written first')
    assert.equal(JSON.parse(readFileSync(vaultJson(R), 'utf8')).id, 'unstable-id')
  } finally {
    console.error = origError
  }
})

test('S2: adding a folder whose vault file cannot be read is refused, and no id is minted', () => {
  const X = dir('s2-invalid')
  mkdirSync(join(X, '.talkweaver'), { recursive: true })
  writeFileSync(vaultJson(X), '{ half a placeholder')
  const { registry, config } = fileHarness()
  const before = registry.list().length
  assert.throws(() => registry.add(X), (e) => e instanceof VaultRefusal && e.reason === 'unreadable-file')
  assert.equal(registry.probe(X).file.state, 'invalid')
  assert.equal((config().vaults ?? []).length, before)
  writeFileSync(vaultJson(X), JSON.stringify({ id: 'has spaces', name: 'x' }))
  assert.throws(() => registry.add(X), (e) => e instanceof VaultRefusal && e.reason === 'unreadable-file', 'an id outside the pattern is refused (H3)')
})

test('S3: create refuses while an unwritten migration holds the ids, before any vault file is written', () => {
  const R = dir('s3-migration')
  const N = dir('s3-new')
  let config = { vaultRoot: R }
  const origError = console.error
  console.error = () => {}
  try {
    const registry = createVaultRegistry({
      read: () => structuredClone(config),
      write: () => { throw new Error('EROFS') },
      files: createVaultFileStore()
    })
    registry.list()
    assert.throws(() => registry.add(N, { create: { fields: { name: 'N' } } }), (e) => e instanceof VaultRefusal && e.reason === 'config-unwritable')
    assert.equal(existsSync(join(N, '.talkweaver')), false)
  } finally {
    console.error = origError
  }
})

test('S3: the vault file is written but config then fails: the file is removed again and the message says so', () => {
  const N = dir('s3-config-fails')
  let config = {}
  let failNext = false
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { if (failNext) throw new Error('ENOSPC'); config = { ...config, ...structuredClone(patch) } },
    files: createVaultFileStore()
  })
  failNext = true
  assert.throws(() => registry.add(N, { create: { fields: { name: 'N' } } }),
    (e) => e instanceof VaultRefusal && e.reason === 'partial-write' && /removed again/.test(e.message) && !/Nothing was/.test(e.message))
  assert.equal(existsSync(join(N, '.talkweaver')), false, 'no vault file, no .talkweaver folder')
  assert.equal((config.vaults ?? []).length, 0)
})

test('S3: …and when the file changed in between (a sync landed), it is left and the message says it is there', () => {
  const N = dir('s3-changed')
  let config = {}
  const real = createVaultFileStore()
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: () => { throw new Error('ENOSPC') },
    files: {
      read: (root) => real.read(root),
      write: (root, file) => { real.write(root, file); writeFileSync(vaultJson(root), JSON.stringify({ ...file, name: 'synced in' })) },
      removeIfUnchanged: (root, file) => real.removeIfUnchanged(root, file)
    }
  })
  assert.throws(() => registry.add(N, { create: { fields: { name: 'N' } } }),
    (e) => e instanceof VaultRefusal && e.reason === 'partial-write' && /left in place/.test(e.message))
  assert.equal(JSON.parse(readFileSync(vaultJson(N), 'utf8')).name, 'synced in')
})

test('S5: two open vaults carrying one vault id: load closes the later one as a duplicate, writing no vault file', () => {
  const one = dir('s5-one')
  const two = dir('s5-two')
  const body = JSON.stringify({ schema: 1, id: 'shared-id', name: 'Shared', shared: true })
  for (const r of [one, two]) { mkdirSync(join(r, '.talkweaver'), { recursive: true }); writeFileSync(vaultJson(r), body) }
  const before = [snapshot(one), snapshot(two)]
  let config = { vaults: [{ id: 'shared-id', root: one, open: true, order: 0 }, { id: 'other-id', root: two, open: true, order: 1 }] }
  const fileWrites = []
  const real = createVaultFileStore()
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { config = { ...config, ...structuredClone(patch) } },
    files: { read: (r) => real.read(r), write: (r, f) => { fileWrites.push(r); real.write(r, f) }, removeIfUnchanged: (r, f) => real.removeIfUnchanged(r, f) }
  })
  const list = registry.list()
  assert.deepEqual(list.map((v) => [v.id, v.open]), [['shared-id', true], ['other-id', false]])
  assert.equal(config.vaults[1].open, false, 'closed in config')
  assert.equal(registry.duplicateOf('other-id')?.id, 'shared-id')
  assert.equal(registry.duplicateOf('shared-id'), null)
  assert.throws(() => registry.setOpen('other-id', true), (e) => e instanceof VaultRefusal && e.reason === 'duplicate-id', 'not auto-opened, and refused when asked')
  assert.equal(fileWrites.length, 0)
  assert.deepEqual([snapshot(one), snapshot(two)], before)
})

test('H3: personal settings keyed "__proto__" stay data, never a prototype', () => {
  const { registry, config } = fileHarness({ vaultPersonal: JSON.parse('{"__proto__":{"author":"x"}}') })
  const P = dir('h3-proto')
  const v = registry.add(P)
  registry.setPersonal(v.id, { author: 'Me' })
  assert.equal(({}).author, undefined)
  assert.deepEqual(registry.personal(v.id), { author: 'Me' })
  assert.deepEqual(registry.personal('__proto__'), { author: 'x' })
  assert.equal(JSON.parse(JSON.stringify(config().vaultPersonal))[v.id].author, 'Me')
})

rmSync(base, { recursive: true, force: true })
console.log(`vault registry: ${passed} passed`)
