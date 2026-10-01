// The talk list handler behind vault:list-talks, per vault (several-vaults ticket 02). Two vaults:
// a 1200-talk vault that must answer warm in <50 ms, and a small one that shares a talk slug with it.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createVaultListHandler } from '../src/main/vault-list-handler.mjs'

const base = await mkdtemp(join(tmpdir(), 'tw-vault-handler-'))
const big = { id: 'vault-big', root: join(base, 'vault'), open: true }
const small = { id: 'vault-small', root: join(base, 'workshop'), open: true }
const closed = { id: 'vault-closed', root: join(base, 'closed'), open: false }
const dir = join(base, 'TalkWeaver', 'vault-index')

try {
  await Promise.all(Array.from({ length: 1200 }, async (_, index) => {
    const slug = `talk-${String(index).padStart(4, '0')}`
    const talkDir = join(big.root, `topic-${index % 20}`, slug)
    await mkdir(talkDir, { recursive: true })
    await writeFile(join(talkDir, `${slug}-outline.md`), `---\ntitle: Talk ${index}\n---\n\n### Slide\n`, 'utf8')
  }))
  for (const [root, title] of [[small.root, 'Workshop copy'], [closed.root, 'Closed talk']]) {
    await mkdir(join(root, 'talk-0000'), { recursive: true })
    await writeFile(join(root, 'talk-0000', 'talk-0000-outline.md'), `---\ntitle: ${title}\n---\n`, 'utf8')
  }

  const first = createVaultListHandler({ dir, log: () => {} })
  const batches = { [big.id]: 0, [small.id]: 0 }
  await first.handle(big, () => { batches[big.id]++ })
  await first.handle(small, () => { batches[small.id]++ })
  const [bigTalks, smallTalks] = await Promise.all([first.refreshDone(big.id), first.refreshDone(small.id)])
  assert.equal(bigTalks.length, 1200)
  assert.deepEqual(smallTalks.map((t) => t.title), ['Workshop copy'], 'each vault refreshes on its own')
  assert.ok(batches[big.id] > 0 && batches[small.id] > 0)

  const persistedBig = JSON.parse(await readFile(join(dir, `${big.id}.json`), 'utf8'))
  const persistedSmall = JSON.parse(await readFile(join(dir, `${small.id}.json`), 'utf8'))
  assert.equal(persistedBig.root, big.root)
  assert.equal(persistedBig.entries.length, 1200, 'cold handler call persisted the complete vault index')
  assert.equal(persistedSmall.entries.length, 1, 'the shared slug talk-0000 is persisted once per vault, in its own file')

  // A closed vault lists nothing, is not scanned and gets no snapshot.
  assert.deepEqual(await first.handle(closed, () => { throw new Error('closed vault emitted a batch') }), [])
  assert.deepEqual(await first.refreshDone(closed.id), [])
  assert.equal(existsSync(join(dir, `${closed.id}.json`)), false)

  // Invalidating the small vault leaves the big vault's cached list in memory.
  first.invalidate(small.id)
  await rm(join(dir, `${big.id}.json`))
  assert.equal((await first.cached(big)).length, 1200, 'the big vault still answers from memory')
  await first.handle(big, () => {})
  await first.refreshDone(big.id)

  const warm = createVaultListHandler({ dir, log: () => {} })
  const started = performance.now()
  const talks = await warm.handle(big, () => {})
  const elapsed = performance.now() - started
  await warm.refreshDone(big.id)
  if (talks.length !== 1200) throw new Error(`warm handler returned ${talks.length} talks, expected 1200`)
  if (elapsed >= 50) throw new Error(`warm handler took ${elapsed.toFixed(1)}ms, expected <50ms`)
  console.log(`PASS: warm vault IPC handler returned 1200 talks in ${elapsed.toFixed(1)}ms; two vaults sharing a slug index apart; a closed vault is not scanned`)
} finally {
  await rm(base, { recursive: true, force: true })
}
