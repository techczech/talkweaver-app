// Real outline/recovery files, the guarded writer, and CodeMirror's own Undo.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { idsInVault } from '../compiler/scripts/lib/13-slide-ledger.mjs'
import { createOutlineDiskGuard } from '../src/main/outline-disk-guard.ts'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'
import { createOutlineSlideMerge } from '../src/main/outline-slide-merge.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { configureTalkWriter, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
import { applySlideMerge, planSlideMerge } from '../src/shared/outline-merge.ts'
import { summarizeSlideMerge, WHOLE_TALK_MERGE_KEY } from '../src/shared/outline-slide-merge.ts'
import { slideMergeHistory, slideMergeTransaction } from '../src/renderer/src/lib/slideMergeTransaction.ts'

const block = (id, text) => `## ${id.toUpperCase()} {id=${id}}\n\n${text}\n\n`
const base = block('a', 'base A') + block('b', 'base B')
const mine = block('a', 'window A') + block('b', 'window B')
const disk = block('a', 'disk A') + block('b', 'disk B')

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-slide-merge-')))
  const vault = join(root, 'vault')
  mkdirSync(vault)
  const path = join(vault, 'talk-outline.md')
  writeFileSync(path, options.base ?? base)
  const savedAt = statSync(path).mtimeMs
  let state = EditorState.create({ doc: options.mine ?? mine, extensions: [history(), slideMergeHistory] })
  const recovery = createOutlineRecovery(join(root, 'recovery'), options.now)
  const guard = createOutlineDiskGuard({
    canonical: canonicalOutlinePath,
    readText: async file => {
      try { return readFileSync(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    },
    mtime: async file => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null,
    withLock: (file, work) => withTalkFileLock(file, work),
    notify() {}, watch() {}, unwatch() {},
  })
  guard.track('win', path, options.base ?? base, savedAt)
  t.after(() => { guard.dispose(); rmSync(root, { recursive: true, force: true }) })
  writeFileSync(path, options.disk ?? disk)
  let writes = 0
  let review
  configureTalkWriter({
    diskGuard: guard, editorBufferFor: () => null,
    afterTruncate: async () => {
      writes++
      const archive = JSON.parse(readFileSync(review.recovery.path, 'utf8'))
      assert.equal(archive.base, options.base ?? base)
      assert.equal(archive.mine, options.mine ?? mine)
      assert.equal(archive.disk, options.disk ?? disk)
    },
  })
  const service = createOutlineSlideMerge({
    guard,
    recovery: options.recovery ?? recovery,
    vaultFor: () => vault,
    readWindow: async () => state.doc.toString(),
    reservedIds: async root => idsInVault(root),
    saveTimeoutMs: options.saveTimeoutMs,
    stageInWindow: options.stageInWindow ?? (async (owner, request) => {
      const before = state
      if (before.doc.toString() !== request.base) return { ok: false, error: 'Window changed.', moved: true }
      const transaction = slideMergeTransaction(before, request.next)
      state = transaction.state
      const staged = service.takeWrite(owner, path, request.generation, state.doc.toString())
      assert.ok(staged, 'main must authorize only the text staged in the editor')
      options.beforeWrite?.(path)
      const result = await writeTalkOutline(path, staged.text, 'editor', {
        observedDisk: staged.disk,
        authorize: () => { staged.authorize(); options.beforeTruncate?.(path) },
      })
      staged.finish(result)
      if (!result.ok) state = before
      if (options.dropReply) await new Promise(() => {})
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    }),
  })
  return {
    path, vault, guard, recovery, savedAt,
    buffer: () => state.doc.toString(), writes: () => writes,
    undo: () => undo({ state, dispatch: tr => { state = tr.state } }),
    plan: async () => { review = await service.plan('win', path); return review },
    apply: choices => service.apply('win', path, review.generation, choices),
    service,
  }
}

test('keeps three exact snapshots before writing once, reserves ledger IDs, and Undo restores the editor', async t => {
  const rawBase = '\uFEFF' + base.replaceAll('\n', '\r\n')
  const f = fixture(t, { base: rawBase })
  const available = applySlideMerge(planSlideMerge(rawBase, mine, disk), { 'id:a': 'both', 'id:b': 'mine' }).text
    .match(/\{id=([a-z0-9]{5})\}/)[1]
  mkdirSync(join(f.vault, '_SLIDE-VERSIONS', available), { recursive: true })
  const review = await f.plan()
  assert.equal(review.ok, true)
  assert.equal(review.fileName, 'talk-outline.md')
  assert.equal(review.lastSavedAt, f.savedAt)
  assert.equal(review.diskChangedAt, statSync(f.path).mtimeMs)
  assert.deepEqual(review.sources, { base: rawBase, mine, disk })
  assert.deepEqual(review.rows.map(row => [row.status, row.defaultChoice, row.mine.line, row.diskDiscardsWindowEdits]), [
    ['changed-in-both', undefined, 1, true], ['changed-in-both', undefined, 5, true],
  ])
  assert.equal(summarizeSlideMerge(review, {}).unresolved.length, 2)
  const choices = { 'id:a': 'both', 'id:b': 'mine' }
  const result = await f.apply(choices)
  assert.equal(result.ok, true)
  assert.deepEqual(result.summary, { mine: 1, disk: 0, both: 1, removed: 0, unchanged: 0, total: 3, unresolved: [] })
  assert.equal(f.writes(), 1)
  const merged = readFileSync(f.path, 'utf8')
  assert.equal(f.buffer(), merged)
  assert.ok(merged.includes('window A') && merged.includes('disk A'))
  assert.ok(!merged.includes(`{id=${available}}`), 'Keep both must bypass an otherwise available ledger ID')
  f.undo()
  assert.equal(f.buffer(), mine)
})

test('missing choices, a superseded plan, and a newer disk version make no write', async t => {
  const f = fixture(t)
  const first = await f.plan()
  const second = await f.plan()
  const choices = { 'id:a': 'mine', 'id:b': 'disk' }
  assert.equal((await f.service.apply('win', f.path, first.generation, choices)).reason, 'stale-plan')
  assert.equal((await f.service.apply('other-window', f.path, second.generation, choices)).reason, 'ownership')
  assert.equal((await f.apply({ [WHOLE_TALK_MERGE_KEY]: 'mine' })).reason, 'invalid-choice')
  assert.equal(f.service.pictureSource('other-window', f.path, second.generation, 'mine'), null)
  assert.equal(f.service.pictureSource('win', f.path, first.generation, 'mine'), null)
  assert.deepEqual(f.service.pictureSource('win', f.path, second.generation, 'mine'), { text: mine, lines: [1, 5] })
  assert.deepEqual(await f.apply({ 'id:a': 'mine' }), { ok: false, reason: 'unresolved', keys: ['id:b'] })
  assert.equal(readFileSync(f.path, 'utf8'), disk)
  // Even if the changed bytes now equal the proposed result, they were not the reviewed disk.
  const newer = block('a', 'window A') + block('b', 'disk B')
  writeFileSync(f.path, newer)
  assert.equal((await f.apply(choices)).reason, 'stale-disk')
  assert.equal(f.writes(), 0)
  assert.equal(readFileSync(f.path, 'utf8'), newer)
  assert.equal(f.buffer(), mine)
})

test('rechecks the disk between editor staging and the writer, even when the output equals disk', async t => {
  const newer = block('a', 'window A') + block('b', 'disk B')
  const f = fixture(t, { beforeWrite: file => writeFileSync(file, newer) })
  await f.plan()
  assert.equal((await f.apply({ 'id:a': 'mine', 'id:b': 'disk' })).reason, 'stale-disk')
  assert.equal(f.writes(), 0)
  assert.equal(readFileSync(f.path, 'utf8'), newer)
  assert.equal(f.buffer(), mine)
})

test('duplicate IDs and unsafe structure fail before any write', async t => {
  await t.test('duplicate IDs', async t => {
    const f = fixture(t, { disk: disk + block('a', 'duplicate') })
    assert.deepEqual((await f.plan()).duplicateIds, ['a'])
    assert.deepEqual(await f.apply({}), { ok: false, reason: 'duplicate-ids', ids: ['a'] })
    assert.equal(f.writes(), 0)
    assert.equal((await f.apply({ [WHOLE_TALK_MERGE_KEY]: 'mine' })).ok, true)
    assert.equal(readFileSync(f.path, 'utf8'), mine)
  })
  await t.test('unsafe mixed structure', async t => {
    const f = fixture(t, { base: block('a', 'original'), mine: block('a', '\x60\x60\x60md\nunfinished').trimEnd(), disk })
    await f.plan()
    assert.equal((await f.apply({ 'id:a': 'mine', 'id:b': 'disk' })).reason, 'unsafe-structure')
    assert.equal(f.writes(), 0)
    assert.equal((await f.apply({ [WHOLE_TALK_MERGE_KEY]: 'disk' })).ok, true)
    assert.equal(readFileSync(f.path, 'utf8'), disk)
  })
})

test('a failed recovery archive prevents the merge from becoming applicable', async t => {
  const f = fixture(t, { recovery: { preserveMerge: async () => { throw new Error('unwritable archive') } } })
  const reply = await f.plan()
  assert.equal(reply.reason, 'recovery-failed')
  assert.equal(f.writes(), 0)
  assert.equal(readFileSync(f.path, 'utf8'), disk)
})

test('a write by another process during staging is fenced at the final truncate boundary', async t => {
  const newer = block('a', 'later A') + block('b', 'later B')
  const f = fixture(t, { beforeTruncate: file => writeFileSync(file, newer) })
  await f.plan()
  assert.equal((await f.apply({ 'id:a': 'mine', 'id:b': 'disk' })).reason, 'stale-disk')
  assert.equal(f.writes(), 0)
  assert.equal(readFileSync(f.path, 'utf8'), newer)
  assert.equal(f.buffer(), mine)
})

test('a merge keeping the exact editor text has its own Undo stop', () => {
  let state = EditorState.create({ doc: base, extensions: [history(), slideMergeHistory] })
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: mine } }).state
  state = slideMergeTransaction(state, mine).state
  const undoOnce = () => undo({ state, dispatch: transaction => { state = transaction.state } })
  assert.equal(undoOnce(), true)
  assert.equal(state.doc.toString(), mine)
  assert.equal(undoOnce(), true)
  assert.equal(state.doc.toString(), base)
})

test('a BOM and CRLF in the loaded outline do not make a clean editor appear dirty', async t => {
  const f = fixture(t, { base: '\uFEFF' + base.replaceAll('\n', '\r\n'), mine: '\uFEFF' + base })
  assert.equal((await f.plan()).reason, 'no-conflict')
  assert.equal(f.writes(), 0)
})

test('a silent editor releases a claimed merge write and revokes its authority', async t => {
  let claimed
  const f = fixture(t, {
    saveTimeoutMs: 30,
    stageInWindow: (_owner, request) => {
      claimed = f.service.takeWrite('win', f.path, request.generation, request.next)
      return new Promise(() => {})
    },
  })
  const review = await f.plan()
  const result = await Promise.race([
    f.apply({ 'id:a': 'mine', 'id:b': 'disk' }),
    new Promise(resolve => { const timer = setTimeout(() => resolve(null), 250); t.after(() => clearTimeout(timer)) }),
  ])
  assert.equal(result?.reason, 'save-timeout')
  assert.ok(claimed)
  assert.throws(() => claimed.authorize(), /expired/)
  assert.equal(f.service.takeWrite('win', f.path, review.generation, mine), null)
  assert.equal(f.writes(), 0)
  assert.equal(readFileSync(f.path, 'utf8'), disk)
  assert.equal(f.buffer(), mine)
})

test('a completed write stays a successful merge when the editor never replies', async t => {
  const f = fixture(t, { saveTimeoutMs: 500, dropReply: true })
  await f.plan()
  const result = await f.apply({ 'id:a': 'mine', 'id:b': 'disk' })
  assert.equal(result.ok, true)
  assert.equal(f.writes(), 1)
  assert.equal(readFileSync(f.path, 'utf8'), block('a', 'window A') + block('b', 'disk B'))
  f.undo()
  assert.equal(f.buffer(), mine)
})

test('refresh reuses exact snapshots and preserves the archives for Apply and Undo', async t => {
  let clock = Date.now()
  const f = fixture(t, { now: () => clock })
  const first = await f.plan()
  clock++
  const refreshed = await f.plan()
  assert.equal(refreshed.recovery.path, first.recovery.path)
  assert.notEqual(refreshed.generation, first.generation)
  assert.equal((await f.apply({ 'id:a': 'mine', 'id:b': 'disk' })).ok, true)
  f.undo()
  assert.equal(f.buffer(), mine)
  writeFileSync(f.path, disk + 'External addition\n')
  clock++
  const current = await f.plan()
  assert.equal(current.ok, true)
  assert.notEqual(current.recovery.path, first.recovery.path)
  clock += 15 * 86400000
  for (let i = 0; i < 22; i++) {
    clock++
    await f.recovery.preserveMerge(f.path, { base, mine, disk: `different ${i}` })
  }
  await f.recovery.read(f.path)
  assert.equal(existsSync(first.recovery.path), true, 'Undo keeps its original disk archive available')
  assert.equal(existsSync(current.recovery.path), true, 'the current review keeps its archive even while other copies are written')
})
