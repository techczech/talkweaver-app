// Regression test for the main-process crash on drag→move→rescan of a large imported deck.
// Root cause: the best-effort cache write at the end of vault-index.refresh() could reject
// (EMFILE under FD pressure), and that rejection lost its handler to an overlapping-scan race
// in vault-list-handler, becoming an unhandled rejection — which Node aborts on (SIGTRAP).
// This proves: (1) a failing cache write no longer rejects refresh, and (2) even overlapping
// handle() calls never leave a refresh promise's rejection unhandled.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultListHandler } from '../src/main/vault-list-handler.mjs'

let unhandled = null
process.on('unhandledRejection', (reason) => { unhandled = reason })

const root = await mkdtemp(join(tmpdir(), 'tw-vault-resilience-'))
try {
  // A minimal talk so the scan has something to enumerate.
  await mkdir(join(root, 'sample-talk'), { recursive: true })
  await writeFile(join(root, 'sample-talk', 'sample-talk-outline.md'), '---\ntitle: Sample\noutline_version: 2\n---\n', 'utf8')

  // Force the cache write to fail: put cachePath UNDER a regular file, so mkdir(dirname) throws
  // ENOTDIR — standing in for the EMFILE/EIO a real FD-exhausted write would hit.
  const blocker = join(root, 'blocker')
  await writeFile(blocker, 'not a directory', 'utf8')
  const cachePath = join(blocker, 'nested', 'cache.json')

  const handler = createVaultListHandler({ cachePath, log: () => {} })

  // Two overlapping handle() calls (the race that stripped the rejection's handler).
  const cachedA = await handler.handle(root, () => {})
  const cachedB = await handler.handle(root, () => {})
  assert.ok(Array.isArray(cachedA) && Array.isArray(cachedB), 'handle returns the cached talk list synchronously')

  // refreshDone must RESOLVE (to the talk list) despite the cache write failing — never reject.
  const talks = await handler.refreshDone()
  assert.ok(Array.isArray(talks), 'refreshDone resolves to a talk array even when the cache write fails')
  assert.equal(talks.length, 1, 'the sample talk is still discovered when the cache write fails')

  // Let any stray rejection microtask flush, then assert none escaped unhandled.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(unhandled, null, `a failed cache write must not produce an unhandled rejection (got: ${unhandled})`)

  console.log('vault-index resilience: failed cache write is swallowed; overlapping refreshes never reject or go unhandled')
} finally {
  await rm(root, { recursive: true, force: true })
}
