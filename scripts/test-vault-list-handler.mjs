import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createVaultListHandler } from '../src/main/vault-list-handler.mjs'

const base = await mkdtemp(join(tmpdir(), 'tw-vault-handler-'))
const vault = join(base, 'vault')
const userData = join(base, 'TalkWeaver')
const cachePath = join(userData, 'vault-index.json')

try {
  await Promise.all(Array.from({ length: 1200 }, async (_, index) => {
    const slug = `talk-${String(index).padStart(4, '0')}`
    const dir = join(vault, `topic-${index % 20}`, slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${slug}-outline.md`), `---\ntitle: Talk ${index}\n---\n\n### Slide\n`, 'utf8')
  }))

  const first = createVaultListHandler({ cachePath, log: () => {} })
  await first.handle(vault, () => {})
  await first.refreshDone()
  const persisted = JSON.parse(await readFile(cachePath, 'utf8'))
  if (persisted.root !== vault || persisted.entries.length !== 1200) {
    throw new Error('cold handler call did not persist the complete vault index')
  }

  const warm = createVaultListHandler({ cachePath, log: () => {} })
  const started = performance.now()
  const talks = await warm.handle(vault, () => {})
  const elapsed = performance.now() - started
  if (talks.length !== 1200) throw new Error(`warm handler returned ${talks.length} talks, expected 1200`)
  if (elapsed >= 50) throw new Error(`warm handler took ${elapsed.toFixed(1)}ms, expected <50ms`)
  console.log(`PASS: warm vault IPC handler returned 1200 talks in ${elapsed.toFixed(1)}ms`)
} finally {
  await rm(base, { recursive: true, force: true })
}
