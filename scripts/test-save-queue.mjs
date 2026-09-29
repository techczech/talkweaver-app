// One writer for talk files (spec 2026-09-27, D3; test 4): the renderer's per-file save queue
// (src/renderer/src/lib/saveQueue.ts) keyed by the main process's identity key, resolved on EVERY
// write. The resolver is the real outlineIdentity (src/main/outline-identity.ts) over a temp folder,
// standing in for the talk:outline-identity IPC.
import assert from 'node:assert/strict'
import { linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outlineQueueKey, outlineSaveQueue, outlineWritesSettled, queueOutlineWrite, setOutlinePathResolver } from '../src/renderer/src/lib/saveQueue.ts'
import { outlineIdentity } from '../src/main/outline-identity.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-save-queue-')))
const OUTLINE = '---\ntitle: Queue Talk\n---\n\n## One\n'
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
let resolves = 0
setOutlinePathResolver(async (p) => { resolves += 1; return outlineIdentity(p).key })

try {
  // 1. Two hard links to one file share ONE queue: a save through one waits for a save in flight
  //    through the other, and lands after it.
  {
    const a = join(root, 'a-outline.md')
    writeFileSync(a, OUTLINE)
    const b = join(root, 'b-outline.md')
    linkSync(a, b)
    assert.equal(await outlineQueueKey(a), await outlineQueueKey(b), 'hard links → one key')
    assert.equal(outlineSaveQueue(await outlineQueueKey(a)), outlineSaveQueue(await outlineQueueKey(b)), 'hard links → one queue')
    const disk = []
    let release
    const older = queueOutlineWrite(a, () => new Promise((resolve) => { release = () => { disk.push('older via a'); resolve() } }))
    const newer = (async () => {
      await outlineWritesSettled(b)
      return queueOutlineWrite(b, async () => { disk.push('newer via b') })
    })()
    await tick()
    assert.deepEqual(disk, [], 'the save through the other link waits for the one in flight')
    release()
    await Promise.all([older, newer])
    assert.deepEqual(disk, ['older via a', 'newer via b'], 'saves land in order across hard-linked aliases')
  }

  // 2. No renderer-lifetime cache: every write resolves the key again, so a symlink retargeted while
  //    the talk is open lands in its NEW target's queue on its next write.
  {
    const first = join(root, 'first-outline.md')
    const second = join(root, 'second-outline.md')
    writeFileSync(first, OUTLINE)
    writeFileSync(second, OUTLINE)
    const link = join(root, 'open-outline.md')
    symlinkSync(first, link)
    const counted = resolves
    await queueOutlineWrite(link, async () => {})
    await queueOutlineWrite(link, async () => {})
    assert.equal(resolves - counted, 2, 'the key is resolved on every queueOutlineWrite')
    assert.equal(await outlineQueueKey(link), outlineIdentity(first).key, 'before: the first target\'s key')

    // A write held in flight on the first target's queue must not hold up the retargeted link.
    let releaseFirst
    const onFirst = queueOutlineWrite(first, () => new Promise((resolve) => { releaseFirst = resolve }))
    await tick()
    unlinkSync(link)
    symlinkSync(second, link)
    const order = []
    const afterRetarget = queueOutlineWrite(link, async () => { order.push('link write after retarget') })
    await afterRetarget
    assert.deepEqual(order, ['link write after retarget'], 'the retargeted link\'s write runs in the new target\'s queue')
    assert.equal(await outlineQueueKey(link), outlineIdentity(second).key, 'after: the new target\'s key')
    releaseFirst()
    await onFirst
  }

  // 3. keyInOrder unchanged: a slow resolution for an earlier write never lets a later write through
  //    another alias overtake it.
  {
    const real = join(root, 'order-outline.md')
    writeFileSync(real, OUTLINE)
    const alias = join(root, 'order-link-outline.md')
    symlinkSync(real, alias)
    setOutlinePathResolver(async (p) => {
      if (p === alias) await tick(40)
      return outlineIdentity(p).key
    })
    const order = []
    const w1 = queueOutlineWrite(alias, async () => { order.push('first (slow alias)') })
    const w2 = queueOutlineWrite(real, async () => { order.push('second') })
    await Promise.all([w1, w2])
    assert.deepEqual(order, ['first (slow alias)', 'second'], 'writes reach the file queue in call order')
  }

  // 4. A failing or empty resolution falls back to the path string itself.
  {
    setOutlinePathResolver(async () => { throw new Error('no bridge') })
    assert.equal(await outlineQueueKey('/vault/x-outline.md'), '/vault/x-outline.md', 'failing resolver → path key')
    setOutlinePathResolver(async () => null)
    assert.equal(await outlineQueueKey('/vault/y-outline.md'), '/vault/y-outline.md', 'empty resolver → path key')
  }
} finally {
  setOutlinePathResolver(null)
  rmSync(root, { recursive: true, force: true })
}

console.log('save queue: hard-linked aliases share one queue, key resolved on every write (retargeted link moves queue), call order under slow resolution, path fallback passed')
