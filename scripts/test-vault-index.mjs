import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createVaultIndex } from '../src/main/vault-index.mjs'

const root = await mkdtemp(join(tmpdir(), 'talkweaver-vault-index-'))
const cachePath = join(root, '.cache', 'talk-index.json')

async function makeTalk(folder, slug, title) {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  const outlinePath = join(dir, `${slug}-outline.md`)
  await writeFile(outlinePath, `---\ntitle: ${title}\n---\n\n### First slide\n`, 'utf8')
  return outlinePath
}

const alphaPath = await makeTalk('topic/alpha', 'alpha', 'Alpha: real title')
await makeTalk('topic/beta', 'beta', 'Beta')

const firstBatches = []
const index = createVaultIndex({ cachePath, batchSize: 1 })
assert.deepEqual(await index.cached(root), [], 'a new vault has no persisted snapshot')
const first = await index.refresh(root, (batch) => firstBatches.push(batch))
assert.equal(first.length, 2)
assert.equal(firstBatches.length, 2, 'scan results stream in bounded batches')
assert.equal(first[0].title, 'Alpha: real title')

const relaunched = createVaultIndex({ cachePath, batchSize: 1 })
assert.deepEqual(await relaunched.cached(root), first, 'the sidebar can paint from the persisted snapshot')

await new Promise((resolve) => setTimeout(resolve, 10))
await writeFile(alphaPath, '---\ntitle: Alpha changed\n---\n\n### First slide\n', 'utf8')
const now = new Date()
await utimes(alphaPath, now, now)
const refreshed = await relaunched.refresh(root, () => {})
assert.equal(refreshed.find((talk) => talk.slug === 'alpha')?.title, 'Alpha changed', 'mtime invalidates cached frontmatter')

console.log('vault index tests passed')
