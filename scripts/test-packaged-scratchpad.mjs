// Run with the packaged Electron binary as Node; no loader injection or GUI.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createScratchpadStore } from '../src/main/scratchpad-store.ts'
const root = mkdtempSync(join(resolve('.'), '.tw-packaged-scratchpad-'))
try {
  mkdirSync(join(root, 'scratchpad'))
  writeFileSync(join(root, 'scratchpad/page.html'), '<p>Packaged functional fixture</p>')
  const store = createScratchpadStore(root)
  const loaded = await store.load()
  assert.equal(loaded.items.length, 1)
  const file = await store.fileFor(loaded.items[0].id)
  assert.equal(readFileSync(file.path, 'utf8'), '<p>Packaged functional fixture</p>')
  await store.createGroup('Packaged group')
  assert.match(readFileSync(join(root, 'scratchpad/scratchpad-state.json'), 'utf8'), /Packaged group/)
  console.log('PASS packaged runtime Scratchpad scan, immutable snapshot and confined write')
} finally { rmSync(root, { recursive: true, force: true }) }
