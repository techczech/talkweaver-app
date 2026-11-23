// The one atomic write for small data files (src/main/atomic-file.ts), on the real file system in a
// temporary folder: the file on disk is always the old complete version or the new complete one, and no
// temporary file is left behind on any failure.
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageTextAtomic, writeJsonAtomic, writeTextAtomic } from '../src/main/atomic-file.ts'
import { approveCleaned, emptyCleanedStore, moveCleanedDrafts, readCleanedStore, undoCleanedDraftMove, writeCleanedStore } from '../src/main/rewritePack.ts'

const root = mkdtempSync(join(tmpdir(), 'tw-atomic-file-'))
let passed = 0
function test(name, body) {
  const dir = mkdtempSync(join(root, 'case-'))
  body(dir)
  passed += 1
  console.log(`ok - ${name}`)
}
const temps = (dir) => readdirSync(dir).filter((name) => name.endsWith('.tmp'))
const failing = (message) => () => { throw Object.assign(new Error(message), { code: 'EIO' }) }

try {
  test('a normal write puts the new content in place and leaves no temporary file', (dir) => {
    const path = join(dir, 'record.json')
    writeJsonAtomic(path, { a: 1 })
    assert.equal(readFileSync(path, 'utf8'), '{\n  "a": 1\n}\n')
    assert.deepEqual(temps(dir), [])
  })

  test('the temporary file is in the same folder, under an unpredictable name', (dir) => {
    const path = join(dir, 'record.json')
    const seen = []
    for (let i = 0; i < 2; i += 1) {
      writeTextAtomic(path, `v${i}`, { ops: { rename: (from, to) => { seen.push(from); return renameSync(from, to) } } })
    }
    assert.equal(seen.length, 2)
    for (const temp of seen) assert.match(temp, new RegExp(`^${escape(dir)}/\\.tw-[0-9a-f]{16}\\.tmp$`))
    assert.notEqual(seen[0], seen[1])
  })

  test('a write that fails before the rename leaves the old bytes and no temporary file', (dir) => {
    const path = join(dir, 'record.json')
    writeFileSync(path, 'old bytes')
    // Fails after the temporary file was created and partly written.
    const partial = (temp, data) => { writeFileSync(temp, String(data).slice(0, 3), { flag: 'wx' }); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }
    assert.throws(() => writeTextAtomic(path, 'new bytes', { ops: { writeFile: partial } }), /disk full/)
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
    assert.deepEqual(temps(dir), [])
    assert.throws(() => writeTextAtomic(path, 'new bytes', { ops: { fsync: failing('flush failed') } }), /flush failed/)
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
    assert.deepEqual(temps(dir), [])
    assert.throws(() => writeTextAtomic(path, 'new bytes', { beforeCommit: failing('not now') }), /not now/)
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
    assert.deepEqual(temps(dir), [])
  })

  test('a rename that fails leaves the old bytes and no temporary file', (dir) => {
    const path = join(dir, 'record.json')
    writeFileSync(path, 'old bytes')
    assert.throws(() => writeTextAtomic(path, 'new bytes', { ops: { rename: failing('rename failed') } }), /rename failed/)
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
    assert.deepEqual(temps(dir), [])
  })

  test('an entry already under the temporary name is never written through or removed', (dir) => {
    const path = join(dir, 'record.json')
    writeFileSync(path, 'old bytes')
    const stray = join(dir, '.tw-fixed.tmp')
    writeFileSync(stray, 'not ours')
    assert.throws(() => writeTextAtomic(path, 'new bytes', { ops: { tempSuffix: () => 'fixed' } }), { code: 'EEXIST' })
    assert.equal(readFileSync(stray, 'utf8'), 'not ours')
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
  })

  test('a link at the destination is refused, before writing and just before the rename', (dir) => {
    const target = join(dir, 'elsewhere.txt')
    writeFileSync(target, 'target bytes')
    const link = join(dir, 'linked.json')
    symlinkSync(target, link)
    assert.throws(() => writeTextAtomic(link, 'new bytes'), /atomic-write-symlink-refused:/)
    assert.equal(readFileSync(target, 'utf8'), 'target bytes')
    assert.deepEqual(temps(dir), [])
    // A dangling link too.
    const dangling = join(dir, 'dangling.json')
    symlinkSync(join(dir, 'missing.txt'), dangling)
    assert.throws(() => writeTextAtomic(dangling, 'new bytes'), /atomic-write-symlink-refused:/)
    // A link that appears while the bytes are being written.
    const late = join(dir, 'late.json')
    writeFileSync(late, 'old bytes')
    assert.throws(() => writeTextAtomic(late, 'new bytes', { beforeCommit: () => { rmSync(late); symlinkSync(target, late) } }), /atomic-write-symlink-refused:/)
    assert.equal(readFileSync(target, 'utf8'), 'target bytes')
    assert.deepEqual(temps(dir), [])
  })

  test('mode is applied to the file', (dir) => {
    const path = join(dir, 'secret.json')
    writeTextAtomic(path, '{}', { mode: 0o600 })
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  test('createParent: false with a missing folder fails without making it; the default makes it', (dir) => {
    const missing = join(dir, 'gone', 'record.json')
    assert.throws(() => writeTextAtomic(missing, 'x', { createParent: false }), { code: 'ENOENT' })
    assert.equal(existsSync(join(dir, 'gone')), false)
    writeTextAtomic(missing, 'x')
    assert.equal(readFileSync(missing, 'utf8'), 'x')
  })

  test('sync flushes before the rename by default, and can be turned off', (dir) => {
    const path = join(dir, 'record.json')
    const order = []
    const ops = { fsync: () => order.push('fsync'), rename: (from, to) => { order.push('rename'); renameSync(from, to) } }
    writeTextAtomic(path, 'a', { ops })
    assert.deepEqual(order, ['fsync', 'rename'])
    order.length = 0
    writeTextAtomic(path, 'b', { ops, sync: false })
    assert.deepEqual(order, ['rename'])
  })

  test('a destination name at the file system limit still gets a temporary file', (dir) => {
    const path = join(dir, `${'r'.repeat(250)}.html`)
    writeTextAtomic(path, 'page')
    assert.equal(readFileSync(path, 'utf8'), 'page')
  })

  test('a staged write is flushed before commit, and discard leaves the destination as it was', (dir) => {
    const path = join(dir, 'record.json')
    writeFileSync(path, 'old bytes')
    const staged = stageTextAtomic(path, 'new bytes')
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
    assert.equal(temps(dir).length, 1)
    staged.discard()
    assert.equal(readFileSync(path, 'utf8'), 'old bytes')
    assert.deepEqual(temps(dir), [])
    const next = stageTextAtomic(path, 'new bytes')
    next.commit()
    next.discard()
    assert.equal(readFileSync(path, 'utf8'), 'new bytes')
    assert.deepEqual(temps(dir), [])
  })

  // A flush that starts failing at the n-th call and keeps failing (the review of round 1: a flush failing
  // after the first draft was renamed lost the destination's previous draft), or a rename that fails once
  // at the n-th call (one that never succeeds again leaves nothing that could restore anything).
  const failingFrom = (name, n) => {
    let calls = 0
    return { [name]: (...args) => {
      calls += 1
      if (name === 'fsync' ? calls > n : calls === n + 1) throw Object.assign(new Error(`${name} refused`), { code: 'EIO' })
      return name === 'fsync' ? undefined : renameSync(...args)
    } }
  }
  const moveSetup = (dir) => {
    const cleanedDir = join(dir, 'cleaned')
    const cleanStorePath = join(dir, 'clean.json')
    writeTextAtomic(join(cleanedDir, 'slide-1.md'), 'first draft\n')
    writeTextAtomic(join(cleanedDir, 'slide-2.md'), 'second draft\n')
    writeCleanedStore(cleanStorePath, approveCleaned(emptyCleanedStore(), { slideNumber: 2, markdown: 'second draft', approvedAt: '2026-11-21T00:00:00Z' }))
    const state = () => ({
      one: readFileSync(join(cleanedDir, 'slide-1.md'), 'utf8'),
      two: readFileSync(join(cleanedDir, 'slide-2.md'), 'utf8'),
      store: readCleanedStore(cleanStorePath),
    })
    const move = (ops) => moveCleanedDrafts({ cleanedDir, cleanStorePath, ops,
      source: { slideNumber: 1, markdown: 'second draft' }, destination: { slideNumber: 2, markdown: 'first draft' } })
    return { cleanedDir, cleanStorePath, state, move }
  }

  test('a cleaned-draft move on a failing disk is whole or not at all', (dir) => {
    for (const name of ['fsync', 'rename']) {
      for (let n = 0; n < 12; n += 1) {
        const caseDir = mkdtempSync(join(dir, `${name}-${n}-`))
        const { cleanedDir, state, move } = moveSetup(caseDir)
        const before = state()
        let moved = true
        try { move(failingFrom(name, n)) } catch { moved = false }
        const after = state()
        if (moved) {
          assert.equal(after.one, 'second draft\n')
          assert.equal(after.two, 'first draft\n')
        } else {
          assert.deepEqual(after, before, `${name} failing from call ${n + 1}`)
        }
        assert.deepEqual(temps(cleanedDir), [])
        assert.deepEqual(temps(caseDir), [])
      }
    }
  })

  test('undoing a cleaned-draft move on a failing disk is whole or not at all', (dir) => {
    for (const name of ['fsync', 'rename']) {
      for (let n = 0; n < 12; n += 1) {
        const caseDir = mkdtempSync(join(dir, `${name}-${n}-`))
        const { cleanedDir, cleanStorePath, state, move } = moveSetup(caseDir)
        const original = state()
        const snapshot = move()
        const moved = state()
        let undone = true
        try { undoCleanedDraftMove({ cleanedDir, cleanStorePath, snapshot, ops: failingFrom(name, n) }) } catch { undone = false }
        const after = state()
        if (undone) {
          assert.equal(after.one, original.one)
          assert.equal(after.two, original.two)
        } else {
          assert.deepEqual(after, moved, `${name} failing from call ${n + 1}`)
        }
        assert.deepEqual(temps(cleanedDir), [])
        assert.deepEqual(temps(caseDir), [])
      }
    }
  })

  test('two writes in a row end with the second content', (dir) => {
    const path = join(dir, 'record.txt')
    writeTextAtomic(path, 'first')
    writeTextAtomic(path, new TextEncoder().encode('second'))
    assert.equal(readFileSync(path, 'utf8'), 'second')
    assert.deepEqual(temps(dir), [])
  })

  console.log(`${passed} atomic-file tests passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
