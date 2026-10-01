// Caches keyed per vault (several-vaults ticket 02): thumbnail folders and the prerender ledger for
// two vaults that share a talk slug, the twthumb:// lookup, the one-time move of an older build's
// per-slug folders, the cache sweep seeing activity under @vaults, and the slide-search vault filter.
// Seams: thumb-cache-dirs.ts, prerender-ledger.ts, thumbnail-cache-gc.ts, vault-scope.ts, over a
// real VaultRegistry (vault-registry.ts) with an in-memory config.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultRegistry } from '../src/main/vault-registry.ts'
import { VAULTS_DIR, adoptLegacyThumbDirs, isPlainSegment, parseThumbUrl, talkThumbDir, thumbLookupDirs, thumbUrl, touchNamespace } from '../src/main/thumb-cache-dirs.ts'
import { resolveThumbFile } from '../src/main/thumb-key-resolution.ts'
import { contentHashForPrerender, recordSuccessfulPrerender, shouldPrerenderTalk } from '../src/main/prerender-ledger.ts'
import { sweepOrphanedThumbCaches } from '../src/main/thumbnail-cache-gc.ts'
import { pathsInVault, pathsOutsideOpenVaults, searchVaults } from '../src/main/vault-scope.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-vault-caches-')))
const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
const rootA = mk('A')
const rootB = mk('B')
const rootC = mk('C')
const userData = mk('userData')
const ns = join(userData, 'thumb-cache-v9-test')

let config = {}
let n = 0
const registry = createVaultRegistry({
  read: () => structuredClone(config),
  write: (patch) => { config = { ...config, ...structuredClone(patch) } },
  newId: () => `vault-${++n}`
})
const A = registry.add(rootA)
const B = registry.add(rootB)
const C = registry.add(rootC)
registry.setOpen(C.id, false)
const vaultIdOf = (p) => registry.resolve(p)?.vault.id ?? null

// The same slug, `alpha`, in both vaults.
const outlineA = join(mk('A', 'talks', 'alpha'), 'alpha-outline.md')
const outlineB = join(mk('B', 'alpha'), 'alpha-outline.md')
writeFileSync(outlineA, '# A\n'); writeFileSync(outlineB, '# B\n')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')

let passed = 0
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`) }

try {
  await test('two vaults sharing a talk slug get separate thumbnail folders', () => {
    const dirA = talkThumbDir(ns, vaultIdOf(outlineA), 'alpha')
    const dirB = talkThumbDir(ns, vaultIdOf(outlineB), 'alpha')
    assert.equal(dirA, join(ns, VAULTS_DIR, A.id, 'alpha'))
    assert.equal(dirB, join(ns, VAULTS_DIR, B.id, 'alpha'))
    assert.notEqual(dirA, dirB)
    assert.equal(talkThumbDir(ns, null, 'alpha'), join(ns, 'alpha'), 'a talk in no vault stays at the namespace level')
    const odd = talkThumbDir(ns, '../../evil', 'alpha')
    assert.ok(odd.startsWith(join(ns, VAULTS_DIR) + '/') && !odd.includes('evil'), 'an unusual vault id is hashed, never a path')
    assert.equal(parseThumbUrl(thumbUrl('alpha', 'k', '../../evil')).vaultId, odd.split('/').at(-2), 'its URL names the same folder')
  })

  await test('no thumbnail collision: a vault-qualified URL never reads the other vault\'s picture', () => {
    // Vault A rendered its alpha deck; the same picture key has not been rendered for vault B.
    const dirA = talkThumbDir(ns, A.id, 'alpha')
    mkdirSync(dirA, { recursive: true })
    writeFileSync(join(dirA, '0123456789abcdef-key1.png'), png)
    const urlA = thumbUrl('alpha', 'key1', A.id)
    const urlB = thumbUrl('alpha', 'key1', B.id)
    assert.equal(urlA, `twthumb://alpha/key1?vault=${A.id}`)
    const find = (url) => {
      const req = parseThumbUrl(url)
      for (const d of thumbLookupDirs(ns, req, [A.id, B.id])) { const hit = resolveThumbFile(d, req.key); if (hit) return hit }
      return null
    }
    assert.equal(find(urlA), join(dirA, '0123456789abcdef-key1.png'))
    assert.equal(find(urlB), null, 'B\'s alpha does not show A\'s picture')
    // Once B renders its own, each URL gets its own vault's file.
    const dirB = talkThumbDir(ns, B.id, 'alpha')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, 'fedcba9876543210-key1.png'), png)
    assert.equal(find(urlB), join(dirB, 'fedcba9876543210-key1.png'))
    assert.equal(find(urlA), join(dirA, '0123456789abcdef-key1.png'))
    // A bare URL (what the renderer builds today) looks in the open vaults in order, then the namespace.
    assert.deepEqual(thumbLookupDirs(ns, parseThumbUrl('twthumb://alpha/key1'), [A.id, B.id]),
      [join(ns, VAULTS_DIR, A.id, 'alpha'), join(ns, VAULTS_DIR, B.id, 'alpha'), join(ns, 'alpha')])
    assert.equal(thumbUrl('alpha', 'key1', null), 'twthumb://alpha/key1', 'a talk in no vault keeps the bare URL')
    assert.equal(parseThumbUrl('twthumb://alpha/key1?vault=../x').vaultId, null, 'an unusable vault id is ignored')
  })

  await test('no prerender collision: recording vault A\'s alpha does not skip vault B\'s alpha', () => {
    const ledger = {}
    const hash = contentHashForPrerender('# same text in both\n')
    const dirA = talkThumbDir(ns, vaultIdOf(outlineA), 'alpha')
    const dirB = talkThumbDir(ns, vaultIdOf(outlineB), 'alpha')
    recordSuccessfulPrerender(ledger, outlineA, hash, 'doc-a')
    assert.equal(shouldPrerenderTalk(ledger, outlineA, hash, dirA), false, 'A is done')
    assert.equal(shouldPrerenderTalk(ledger, outlineB, hash, dirB), true, 'B still renders: its own ledger entry')
    rmSync(dirB, { recursive: true, force: true })
    recordSuccessfulPrerender(ledger, outlineB, hash, 'doc-b')
    assert.equal(shouldPrerenderTalk(ledger, outlineB, hash, dirB), true, 'B re-renders when ITS folder is missing, whatever A has')
    assert.deepEqual(Object.keys(ledger).sort(), [outlineA, outlineB].sort())
  })

  await test('an older build\'s per-slug folders move under the first open vault once, app caches stay', () => {
    const legacyNs = join(userData, 'thumb-cache-v9-legacy')
    for (const name of ['beta', 'gamma', '__ledger__', '__layout-preview__-abc']) {
      mkdirSync(join(legacyNs, name), { recursive: true })
      writeFileSync(join(legacyNs, name, 'k.png'), png)
    }
    mkdirSync(join(legacyNs, VAULTS_DIR, A.id, 'gamma'), { recursive: true }) // A already has its own gamma
    assert.equal(adoptLegacyThumbDirs(legacyNs, A.id), 1)
    assert.ok(existsSync(join(legacyNs, VAULTS_DIR, A.id, 'beta', 'k.png')), 'beta moved, files intact')
    assert.ok(!existsSync(join(legacyNs, 'beta')))
    assert.ok(existsSync(join(legacyNs, 'gamma', 'k.png')), 'a folder the vault already has is left in place')
    assert.ok(existsSync(join(legacyNs, '__ledger__')) && existsSync(join(legacyNs, '__layout-preview__-abc')), 'app-level caches stay')
    assert.equal(adoptLegacyThumbDirs(legacyNs, A.id), 0, 'running it again moves nothing')
    assert.equal(adoptLegacyThumbDirs(join(userData, 'missing'), A.id), 0)
  })

  await test('a twthumb URL whose slug or key would leave the cache folder is refused', () => {
    for (const bad of ['twthumb://alpha/..%2F..%2Fx', 'twthumb://alpha/..', 'twthumb://alpha/.', 'twthumb://alpha/a%5Cb',
      'twthumb://alpha/a/b', 'twthumb://alpha/', 'twthumb://alpha/%E0%A4%A']) {
      assert.equal(parseThumbUrl(bad), null, bad)
    }
    assert.deepEqual(parseThumbUrl('twthumb://alpha/0123abcd'), { slug: 'alpha', key: '0123abcd', vaultId: null })
    for (const s of ['', '.', '..', 'a/b', 'a\\b']) assert.equal(isPlainSegment(s), false, JSON.stringify(s))
    assert.equal(isPlainSegment('talk-0001'), true)
  })

  await test('touching the namespace moves its mtime, so an older build\'s sweep sees activity', async () => {
    const ud = mk('touch')
    const live = join(ud, 'thumb-cache-v9-live')
    mkdirSync(join(live, VAULTS_DIR, 'vault-x', 'alpha'), { recursive: true })
    const old = Date.now() / 1000 - 30 * 24 * 3600
    for (const p of [live, join(live, VAULTS_DIR), join(live, VAULTS_DIR, 'vault-x'), join(live, VAULTS_DIR, 'vault-x', 'alpha')]) utimesSync(p, old, old)
    const before = statSync(live).mtimeMs
    touchNamespace(live)
    const after = statSync(live).mtimeMs
    assert.ok(after > before + 29 * 24 * 3600 * 1000, `mtime moved (${before} → ${after})`)
    // What a 0.35 sweep looks at — the folder and its immediate children — is now recent.
    const shallowNewest = Math.max(statSync(live).mtimeMs, ...readdirSync(live).map((n) => statSync(join(live, n)).mtimeMs))
    assert.ok(Date.now() - shallowNewest < 60_000)
    touchNamespace(join(ud, 'created-by-touch'))
    assert.ok(existsSync(join(ud, 'created-by-touch')), 'a missing namespace folder is created')
  })

  await test('the cache sweep counts activity inside @vaults as recent', async () => {
    const ud = mk('sweep')
    const old = Date.now() / 1000 - 30 * 24 * 3600
    const make = (name, deep) => {
      const talk = join(ud, name, VAULTS_DIR, 'vault-x', 'alpha')
      mkdirSync(talk, { recursive: true })
      writeFileSync(join(talk, 'k.png'), png)
      for (const p of [join(ud, name), join(ud, name, VAULTS_DIR), join(ud, name, VAULTS_DIR, 'vault-x'), talk]) utimesSync(p, old, old)
      if (deep) { const now = Date.now() / 1000; utimesSync(talk, now, now) }
    }
    make('thumb-cache-v9-busy', true)
    make('thumb-cache-v9-stale', false)
    const report = await sweepOrphanedThumbCaches(ud, 'thumb-cache-v9-live')
    assert.deepEqual(report.kept.map((k) => k.name), ['thumb-cache-v9-busy'])
    assert.deepEqual(report.removed.map((r) => r.name), ['thumb-cache-v9-stale'])
    assert.deepEqual(readdirSync(ud), ['thumb-cache-v9-busy'])
  })

  await test('slide search: filter by vault id, default is the first open vault', () => {
    const vaults = registry.list()
    assert.deepEqual(searchVaults(vaults, undefined).map((v) => v.id), [A.id], 'no options: first open vault, as today')
    assert.deepEqual(searchVaults(vaults, { vaultIds: [B.id] }).map((v) => v.id), [B.id])
    assert.deepEqual(searchVaults(vaults, { vaultIds: [B.id, A.id] }).map((v) => v.id), [A.id, B.id], 'vault order, not request order')
    assert.deepEqual(searchVaults(vaults, { vaultIds: [C.id, 'nope'] }), [], 'closed and unknown vaults are never searched')
    registry.setOpen(A.id, false)
    assert.deepEqual(searchVaults(registry.list(), undefined).map((v) => v.id), [B.id])
    registry.setOpen(A.id, true)
  })

  await test('slide-text keys stay absolute paths; the vault of each comes from resolve()', () => {
    const keyC = join(rootC, 'delta', 'delta-outline.md')
    const keys = [outlineA, outlineB, keyC, join(base, 'elsewhere', 'x-outline.md')]
    const vaults = registry.list()
    assert.deepEqual(pathsInVault(keys, vaults, A.id), [outlineA])
    assert.deepEqual(pathsInVault(keys, vaults, B.id), [outlineB])
    assert.deepEqual(pathsOutsideOpenVaults(keys, vaults), [keyC, keys[3]], 'a closed vault\'s talks and stray paths')
    // A root stored with a trailing slash resolves the same (the ticket 01 review's vaultRel case).
    const slashed = vaults.map((v) => (v.id === A.id ? { ...v, root: v.root + '/' } : v))
    assert.deepEqual(pathsInVault(keys, slashed, A.id), [outlineA])
    assert.equal(registry.resolve(join(rootA, 'talks', 'alpha')).rel, 'talks/alpha')
  })

  console.log(`vault caches tests passed (${passed})`)
} finally {
  rmSync(base, { recursive: true, force: true })
}
