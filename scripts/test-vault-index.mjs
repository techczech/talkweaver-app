// Vault index, per-vault contract (several-vaults ticket 02; src/main/vault-index.mjs header).
// Seam: createVaultIndex({ dir, legacyCachePath }) over real temp folders standing in for vaults.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createVaultIndex } from '../src/main/vault-index.mjs'

const base = await mkdtemp(join(tmpdir(), 'talkweaver-vault-index-'))
const dir = join(base, 'userData', 'vault-index')
const legacyCachePath = join(base, 'userData', 'vault-index.json')
const A = { id: 'vault-a', root: join(base, 'A'), open: true }
const B = { id: 'vault-b', root: join(base, 'B'), open: true }

async function makeTalk(root, folder, slug, title) {
  const folderPath = join(root, folder)
  await mkdir(folderPath, { recursive: true })
  const outlinePath = join(folderPath, `${slug}-outline.md`)
  await writeFile(outlinePath, `---\ntitle: ${title}\n---\n\n### First slide\n`, 'utf8')
  return outlinePath
}

let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

try {
  const alphaPath = await makeTalk(A.root, 'topic/alpha', 'alpha', 'Alpha: real title')
  await makeTalk(A.root, 'topic/beta', 'beta', 'Beta')
  // B shares the slug `alpha` with A (a different talk in a different vault).
  await makeTalk(B.root, 'alpha', 'alpha', 'Alpha in B')

  await test('a vault with no snapshot answers empty; refresh streams bounded batches', async () => {
    const index = createVaultIndex({ dir, batchSize: 1 })
    assert.deepEqual(await index.cached(A), [])
    assert.deepEqual(await index.cachedState(A), { hit: false, talks: [] })
    const batches = []
    const first = await index.refresh(A, (batch) => batches.push(batch))
    assert.equal(first.length, 2)
    assert.equal(batches.length, 2, 'scan results stream in bounded batches')
    assert.equal(first[0].title, 'Alpha: real title')
  })

  await test('each vault has its own snapshot file <dir>/<id>.json holding only its talks', async () => {
    const index = createVaultIndex({ dir })
    await index.refresh(B)
    assert.equal(index.snapshotPath(A.id), join(dir, 'vault-a.json'))
    const a = JSON.parse(readFileSync(join(dir, 'vault-a.json'), 'utf8'))
    const b = JSON.parse(readFileSync(join(dir, 'vault-b.json'), 'utf8'))
    assert.equal(a.id, A.id); assert.equal(a.root, A.root)
    assert.equal(b.id, B.id); assert.equal(b.root, B.root)
    assert.deepEqual(a.entries.map((t) => t.title).sort(), ['Alpha: real title', 'Beta'])
    assert.deepEqual(b.entries.map((t) => t.title), ['Alpha in B'])
    assert.ok(a.entries.every((t) => t.outlinePath.startsWith(A.root)), 'no talk of another vault in A')
  })

  await test('a relaunched index paints each vault from its own snapshot', async () => {
    const relaunched = createVaultIndex({ dir })
    const a = await relaunched.cached(A)
    const b = await relaunched.cached(B)
    assert.deepEqual(a.map((t) => t.slug).sort(), ['alpha', 'beta'])
    assert.deepEqual(b.map((t) => t.title), ['Alpha in B'])
    const metaA = await relaunched.metadata(A)
    const metaB = await relaunched.metadata(B)
    assert.equal(metaA.alpha.subtitle, null)
    assert.ok(metaB.alpha.editedMs > 0 && metaA.alpha.editedMs > 0, 'the shared slug has metadata in each vault')
  })

  await test('a snapshot answers only for its vault id and root', async () => {
    const index = createVaultIndex({ dir })
    assert.deepEqual(await index.cached({ id: A.id, root: B.root }), [], 'same id, other root: miss')
    assert.deepEqual(await index.cached({ id: 'vault-c', root: A.root }), [], 'other id, same root: miss')
    assert.ok(index.snapshotPath('../../evil').startsWith(dir + '/'), 'an unusual vault id never names a file outside dir')
  })

  await test('mtime invalidates cached frontmatter', async () => {
    const index = createVaultIndex({ dir })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await writeFile(alphaPath, '---\ntitle: Alpha changed\n---\n\n### First slide\n', 'utf8')
    const now = new Date()
    await utimes(alphaPath, now, now)
    const refreshed = await index.refresh(A)
    assert.equal(refreshed.find((talk) => talk.slug === 'alpha')?.title, 'Alpha changed')
  })

  await test('refreshing one vault leaves the other vault\'s snapshot file untouched', async () => {
    const index = createVaultIndex({ dir })
    const before = { text: readFileSync(join(dir, 'vault-b.json'), 'utf8'), mtimeMs: (await stat(join(dir, 'vault-b.json'))).mtimeMs }
    await new Promise((resolve) => setTimeout(resolve, 10))
    await makeTalk(A.root, 'gamma', 'gamma', 'Gamma')
    await index.refresh(A)
    assert.equal(readFileSync(join(dir, 'vault-b.json'), 'utf8'), before.text)
    assert.equal((await stat(join(dir, 'vault-b.json'))).mtimeMs, before.mtimeMs)
    assert.deepEqual((await index.cached(B)).map((t) => t.title), ['Alpha in B'])
  })

  await test('invalidating one vault leaves the other vault\'s index untouched', async () => {
    const index = createVaultIndex({ dir })
    await index.refresh(A)
    await index.refresh(B)
    // Remove both files: whatever still answers comes from the in-memory index.
    await rm(join(dir, 'vault-a.json')); await rm(join(dir, 'vault-b.json'))
    index.invalidate(A.id)
    assert.deepEqual(await index.cached(A), [], 'A was dropped and reloads from its (now missing) file')
    assert.deepEqual((await index.cached(B)).map((t) => t.title), ['Alpha in B'], 'B still answers from memory')
    index.invalidate()
    assert.deepEqual(await index.cached(B), [], 'invalidate() with no id drops every vault')
    await index.refresh(A); await index.refresh(B)
  })

  await test('closed vaults are not scanned or indexed', async () => {
    const C = { id: 'vault-c', root: join(base, 'C'), open: false }
    await makeTalk(C.root, 'delta', 'delta', 'Delta')
    const index = createVaultIndex({ dir })
    let batches = 0
    assert.deepEqual(await index.refresh(C, () => { batches++ }), [])
    assert.equal(batches, 0, 'no batch is emitted for a closed vault')
    assert.equal(existsSync(join(dir, 'vault-c.json')), false, 'no snapshot is written for a closed vault')
    // Once open it indexes; closing it again leaves its snapshot on disk but lists nothing.
    const opened = await index.refresh({ ...C, open: true })
    assert.deepEqual(opened.map((t) => t.slug), ['delta'])
    assert.ok(existsSync(join(dir, 'vault-c.json')))
    assert.deepEqual(await index.cached(C), [], 'a closed vault lists nothing')
    assert.deepEqual(await index.metadata(C), {})
    assert.deepEqual(await index.cachedState(C), { hit: false, talks: [] })
    assert.deepEqual((await index.cached({ ...C, open: true })).map((t) => t.slug), ['delta'], 'reopened, it paints from the kept snapshot')
  })

  await test('the single-vault snapshot of older builds seeds only the vault whose root it names', async () => {
    const legacyDir = join(base, 'userData-legacy', 'vault-index')
    const legacyPath = join(base, 'userData-legacy', 'vault-index.json')
    await mkdir(join(base, 'userData-legacy'), { recursive: true })
    const legacy = { root: A.root, entries: [{ name: 'old', path: join(A.root, 'old'), outlinePath: join(A.root, 'old', 'old-outline.md'), slug: 'old', title: 'Old', mtimeMs: 1, birthtimeMs: 1 }] }
    await writeFile(legacyPath, JSON.stringify(legacy), 'utf8')
    const index = createVaultIndex({ dir: legacyDir, legacyCachePath: legacyPath })
    assert.deepEqual((await index.cached(A)).map((t) => t.slug), ['old'], 'A paints from the legacy snapshot')
    assert.deepEqual(await index.cached(B), [], 'B does not')
    await index.refresh(A)
    assert.ok(existsSync(join(legacyDir, 'vault-a.json')), 'the first refresh writes A its own file')
    assert.equal(readFileSync(legacyPath, 'utf8'), JSON.stringify(legacy), 'the legacy file is never rewritten')
  })

  console.log(`vault index tests passed (${passed})`)
} finally {
  await rm(base, { recursive: true, force: true })
}
