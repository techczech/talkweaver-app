// Outline external-change guard, renderer side (shared-talk ticket 01). Seam: the renderer's
// outline-changed-on-disk state, its answers and the leave guard (src/renderer/src/lib/outlineDiskChange.ts),
// wired to the REAL main-process guard, writer and recovery copies (outline-disk-guard.ts, talk-writer.ts,
// outline-recovery.ts) and the real save queue (lib/saveQueue.ts) the way useOutlineDiskChange and
// index.ts wire window.tw, over a temp vault. The editor is a fake buffer with an undo stack (Reload
// and Restore must each be one undo step).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configureTalkWriter, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { createOutlineDiskGuard, hashOutlineText } from '../src/main/outline-disk-guard.ts'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'
import { outlineWritesSettled, queueOutlineWrite, setOutlinePathResolver } from '../src/renderer/src/lib/saveQueue.ts'
import {
  changedAtLabel, createOutlineDiskChangeStore, describeDiskChange, guardLeave, keepMine, lookForRecovery,
  noteOutlineSaveReply, reloadFromDisk, resolveChoice, saveAfterDiskCleared,
} from '../src/renderer/src/lib/outlineDiskChange.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-disk-change-')))
const OUTLINE = '---\ntitle: Bar Talk\n---\n\n## One {id=aa11}\n\n- x\n'
let seq = 0
const talk = (text = OUTLINE) => {
  const dir = join(root, `talk-${++seq}`)
  mkdirSync(dir)
  const path = join(dir, `talk-${seq}-outline.md`)
  writeFileSync(path, text)
  return path
}
setOutlinePathResolver(async (p) => p)

const store = createOutlineDiskChangeStore()
const recovery = createOutlineRecovery(join(root, 'userData-recovery'))
const guard = createOutlineDiskGuard({
  canonical: canonicalOutlinePath,
  async readText(realPath) { try { return await readFile(realPath, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return null; throw e } },
  async mtime(realPath) { try { return statSync(realPath).mtimeMs } catch { return null } },
  withLock: (outlinePath, work) => withTalkFileLock(outlinePath, () => work()),
  watch() {}, unwatch() {},
  // The push (outline:changed-on-disk) as useOutlineDiskChange handles it.
  notify: (_owner, outlinePath, change) => { if (change) store.report(change); else if (store.get(outlinePath)?.kind !== 'recovery') store.clear(outlinePath) },
})
let afterTruncate = null
configureTalkWriter({ editorBufferFor: () => null, diskGuard: guard, afterTruncate: () => afterTruncate ? afterTruncate() : Promise.resolve() })

// talk:write-outline as index.ts answers the editor's save: a refusal, or any failure of a guarded talk,
// keeps the text in the recovery copy; a failure while a choice is pending comes back as that pending
// difference with the failure (the bar says why); success drops the copy.
async function ipcWrite(outlinePath, text) {
  const written = await writeTalkOutline(outlinePath, text, 'editor')
  if (!written.ok && written.changedOnDisk) {
    await recovery.save(canonicalOutlinePath(outlinePath), text)
    return { ok: false, refused: 'changed-on-disk', change: { ...written.changedOnDisk, outlinePath } }
  }
  if (!written.ok) {
    if (guard.tracks(canonicalOutlinePath(outlinePath))) {
      await recovery.save(canonicalOutlinePath(outlinePath), text)
      const pending = guard.pending(outlinePath)
      if (pending) return { ok: false, refused: 'changed-on-disk', change: { ...pending, outlinePath, saveError: written.error } }
    }
    return false
  }
  await recovery.clear(canonicalOutlinePath(outlinePath))
  return { ok: true, collisions: [] }
}

// A fake editor holding one talk: its buffer, an undo stack, the editor's save path (which, like
// Editor.writeQueued, never saves a discarded talk) and the resolver deps useOutlineDiskChange builds.
function editorFor(outlinePath, text, owner = 'win') {
  guard.track(owner, outlinePath, text) // talk:read-outline with forEditor
  store.loaded(outlinePath)
  const ed = { text, undo: [], asked: [], answers: [] }
  ed.save = async () => {
    if (store.isDiscarded(outlinePath)) return false
    const reply = await queueOutlineWrite(outlinePath, () => ipcWrite(outlinePath, ed.text))
    noteOutlineSaveReply(reply, store)
    return !!reply && reply.ok === true
  }
  ed.deps = {
    store,
    settled: (p) => outlineWritesSettled(p),
    queue: (p, work) => queueOutlineWrite(p, work),
    diskVersion: (p) => guard.diskVersion(p),
    accept: (p, hash, opts) => guard.owns(owner, p) ? guard.accept(p, hash, opts) : Promise.resolve({ ok: false, change: null, error: 'not yours' }),
    readBuffer: (p) => p === outlinePath ? ed.text : null,
    replaceBuffer: (p, next) => { if (p !== outlinePath) return false; ed.undo.push(ed.text); ed.text = next; return true },
    saveBuffer: () => ed.save(),
    recovery: (p) => recovery.read(canonicalOutlinePath(p)),
    discardRecovery: async (p) => { await recovery.clear(canonicalOutlinePath(p)); return true },
    discardRemoved: async (p) => { await recovery.clear(canonicalOutlinePath(p)); return true },
    // The leave guard's extra deps: the flush saves pending typing; the sheet answers from a script.
    flush: () => ed.save().then(() => undefined),
    ask: async (change) => { ed.asked.push(change.kind); return ed.answers.shift() ?? 'stay' },
  }
  return ed
}

try {
  // 1. The store and the words: one difference per path, a newer version replaces it, a recovery offer
  //    never hides a disk difference; the bar's clock time; the text and choices per kind.
  {
    const s = createOutlineDiskChangeStore()
    let calls = 0
    s.subscribe(() => { calls += 1 })
    s.report({ outlinePath: '/a', kind: 'changed', hash: 'h1', changedAt: 1 })
    s.report({ outlinePath: '/a', kind: 'changed', hash: 'h1', changedAt: 1 })
    assert.equal(calls, 1, 'the same change twice is one update')
    s.report({ outlinePath: '/a', kind: 'recovery', hash: 'recovery', changedAt: 2 })
    assert.equal(s.get('/a')?.hash, 'h1', 'a recovery offer never hides a disk difference')
    s.clear('/a', 'h0')
    assert.equal(s.get('/a')?.hash, 'h1', 'clearing another version leaves it')
    s.discard('/a')
    assert.deepEqual([s.get('/a'), s.isDiscarded('/a')], [null, true])
    s.loaded('/a')
    assert.equal(s.isDiscarded('/a'), false, 'a fresh load forgets the discard')
    assert.equal(noteOutlineSaveReply({ ok: false, refused: 'empty-over-nonempty' }, s), false, 'other refusals are not this')
    assert.equal(noteOutlineSaveReply({ ok: false, refused: 'changed-on-disk', change: { outlinePath: '/b', kind: 'changed', hash: 'x', changedAt: 3 } }, s), true)
    const at = new Date(2026, 8, 28, 9, 12).getTime()
    assert.equal(changedAtLabel(at, at + 60_000), '09:12')
    assert.match(changedAtLabel(at, at + 3 * 86_400_000), /^09:12 on 28 Sept?$/)
    const words = (kind, extra = {}) => describeDiskChange({ outlinePath: '/c', kind, hash: 'x', changedAt: at, ...extra })
    assert.equal(words('changed').text, `This talk changed on disk at ${changedAtLabel(at)}`)
    assert.deepEqual(words('changed').actions.map((a) => a.label), ['Reload', 'Keep mine'])
    assert.equal(words('changed').sheetTitle, 'This talk changed on disk while you were typing')
    assert.deepEqual([words('removed').text, ...words('removed').actions.map((a) => a.label)], ['This talk was removed on disk', 'Save it again', 'Discard'])
    const partial = words('partial', { tempPath: '/c/.t.tw-write' })
    assert.ok(partial.text.startsWith('A save failed halfway; the file on disk may be incomplete') && partial.text.includes('/c/.t.tw-write'), 'names the temp copy')
    assert.deepEqual(partial.actions.map((a) => a.label), ['Save again'], 'never Reload of the partial text')
    assert.deepEqual(words('recovery').actions.map((a) => a.label), ['Restore my unsaved text', 'Discard'])
  }

  // 2. External change, then the editor saves: refused, the bar is set, the typing stays, a recovery copy
  //    holds it. Keep mine writes the editor's text; the bar and the copy go.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    const theirs = OUTLINE + '\n## Theirs\n'
    writeFileSync(path, theirs)
    ed.text = OUTLINE + '\n## Mine\n'
    assert.equal(await ed.save(), false, 'the save is refused')
    assert.equal(store.get(path)?.hash, hashOutlineText(theirs), 'the bar shows the change')
    assert.equal((await recovery.read(canonicalOutlinePath(path)))?.text, OUTLINE + '\n## Mine\n', 'the refused text is in the recovery copy')
    assert.equal(readFileSync(path, 'utf8'), theirs, 'never silently overwritten')
    assert.deepEqual(await keepMine(path, store.get(path), ed.deps), { ok: true })
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Mine\n', 'Keep mine writes the editor’s text')
    assert.equal(store.get(path), null, 'the bar is gone')
    assert.equal(await recovery.read(canonicalOutlinePath(path)), null, 'the copy is deleted after the successful save')
    guard.release('win')
  }

  // 3. Reload: one undo step holds the typing; the bar clears; the next save lands.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    ed.text = OUTLINE + '\n## Unsaved typing\n'
    const theirs = OUTLINE + '\n## Theirs\n'
    writeFileSync(path, theirs)
    assert.equal(await ed.save(), false)
    assert.deepEqual(await reloadFromDisk(path, ed.deps), { ok: true, replacedEdits: true })
    assert.equal(ed.text, theirs, 'the editor shows the version on disk')
    assert.deepEqual(ed.undo, [OUTLINE + '\n## Unsaved typing\n'], 'one undo step holds the pre-reload text')
    assert.equal(store.get(path), null)
    ed.text = theirs + '\n## Next\n'
    assert.equal(await ed.save(), true, 'the next save lands')
    guard.release('win')
  }

  // 4. A save queued before Reload's accept can never land after it.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    const theirs = OUTLINE + '\n## Theirs\n'
    writeFileSync(path, theirs)
    ed.deps = { ...ed.deps, diskVersion: async (p) => {
      void queueOutlineWrite(path, () => ipcWrite(path, OUTLINE + '\n## Stale autosave\n')).then((reply) => noteOutlineSaveReply(reply, store))
      return guard.diskVersion(p)
    } }
    assert.equal((await reloadFromDisk(path, ed.deps)).ok, true)
    await outlineWritesSettled(path)
    assert.equal(readFileSync(path, 'utf8'), theirs, 'the stale save was refused, the reloaded version kept')
    guard.release('win')
  }

  // 5. The leave guard (talk switch, close): pending typing is flushed; with no difference the leave
  //    goes ahead without asking. With one, Stay here holds it; Reload or Keep mine lets it go only
  //    once completed; a choice that fails (the file changed again) asks again.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    ed.text = OUTLINE + '\n## Typed just before switching\n'
    assert.equal(await guardLeave(path, ed.deps), true, 'no difference: leave')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Typed just before switching\n', 'the flush saved the typing first')
    assert.deepEqual(ed.asked, [], 'nobody was asked')

    writeFileSync(path, OUTLINE + '\n## Theirs\n')
    ed.text = OUTLINE + '\n## More typing\n'
    ed.answers = ['stay']
    assert.equal(await guardLeave(path, ed.deps), false, 'Stay here holds the switch')
    assert.deepEqual(ed.asked, ['changed'], 'the flush was refused and the sheet asked')
    assert.equal(ed.text, OUTLINE + '\n## More typing\n', 'the typing is still in the editor')

    ed.asked = []
    ed.answers = ['keep']
    let gotChange = null
    const origKeep = ed.deps.accept
    ed.deps.accept = async (p, hash) => { if (!gotChange) { gotChange = hash; writeFileSync(path, OUTLINE + '\n## Theirs again\n') } return origKeep(p, hash) }
    ed.answers = ['keep', 'keep']
    const reported = []
    ed.deps.report = (error) => reported.push(error)
    assert.equal(await guardLeave(path, ed.deps), true, 'after the second Keep mine the switch goes ahead')
    assert.deepEqual(ed.asked, ['changed', 'changed'], 'the file changed between the sheet and the click: asked again')
    assert.equal(reported.length, 1, 'and told why')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## More typing\n', 'Keep mine then wrote the typing')
    guard.release('win')
  }

  // 6. The leave guard with Reload: the switch goes ahead once the disk text is in the editor; nothing
  //    of the person's reaches the file, and it stays one undo away (and in the recovery copy).
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    const theirs = OUTLINE + '\n## Theirs\n'
    writeFileSync(path, theirs)
    ed.text = OUTLINE + '\n## Mine\n'
    ed.answers = ['reload']
    assert.equal(await guardLeave(path, ed.deps), true)
    assert.equal(readFileSync(path, 'utf8'), theirs)
    assert.deepEqual(ed.undo, [OUTLINE + '\n## Mine\n'])
    guard.release('win')
  }

  // 7. Removed on disk: the bar's Save it again recreates the file with the editor's text; Discard lets
  //    the talk go and the editor never saves it again (no file is recreated).
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    unlinkSync(path)
    ed.text = OUTLINE + '\n## Mine\n'
    assert.equal(await ed.save(), false, 'an autosave does not recreate it')
    assert.equal(existsSync(path), false)
    assert.equal(store.get(path)?.kind, 'removed')
    assert.deepEqual(await resolveChoice(path, store.get(path), 'keep', ed.deps), { ok: true }, 'Save it again')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Mine\n', 'recreated with the editor’s text')

    unlinkSync(path)
    assert.equal(await ed.save(), false)
    ed.answers = ['discard']
    assert.equal(await guardLeave(path, ed.deps), true, 'Discard lets the switch go ahead')
    assert.equal(await ed.save(), false, 'a discarded talk is never saved again')
    assert.equal(existsSync(path), false, 'and never recreated')
    assert.equal(await recovery.read(canonicalOutlinePath(path)), null, 'its recovery copy is dropped')
    guard.release('win')
  }

  // 8. Partial write: Save again writes the editor's text; the choice is keep-only.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    ed.text = OUTLINE + '\n## Mine\n'
    afterTruncate = async () => { afterTruncate = null; throw new Error('disk full (simulated)') }
    assert.equal(await ed.save(), false)
    const change = store.get(path)
    assert.equal(change?.kind, 'partial')
    assert.deepEqual(await resolveChoice(path, change, 'reload', ed.deps), { ok: true }, 'even a stray reload answer saves the editor text (never the partial text)')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Mine\n')
    assert.deepEqual(ed.undo, [], 'the editor was not touched')
    unlinkSync(change.tempPath)
    guard.release('win')
  }

  // 9. Recovery: a forced quit after a refused save leaves the copy; the next open offers it (a copy
  //    equal to the file is dropped silently); Restore puts it in as one undo step and saves it, which
  //    deletes the copy; Discard drops it. A recovery offer never blocks a leave.
  {
    const path = talk()
    const first = editorFor(path, OUTLINE)
    writeFileSync(path, OUTLINE + '\n## Theirs\n')
    first.text = OUTLINE + '\n## Typed before the crash\n'
    assert.equal(await first.save(), false, 'refused; then the app is killed')
    guard.release('win')
    store.loaded(path)

    const reopened = editorFor(path, OUTLINE + '\n## Theirs\n')
    await lookForRecovery(path, reopened.text, reopened.deps)
    assert.equal(store.get(path)?.kind, 'recovery', 'the bar offers the kept text')
    assert.equal(await guardLeave(path, { ...reopened.deps, flush: async () => {} }), true, 'the offer never blocks a switch')
    assert.deepEqual(await resolveChoice(path, store.get(path), 'restore', reopened.deps), { ok: true, replacedEdits: true })
    assert.equal(reopened.text, OUTLINE + '\n## Typed before the crash\n', 'restored into the editor')
    assert.deepEqual(reopened.undo, [OUTLINE + '\n## Theirs\n'], 'one undo step brings the file’s version back')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Typed before the crash\n', 'and saved')
    assert.equal(await recovery.read(canonicalOutlinePath(path)), null, 'the copy is deleted after that save')
    assert.equal(store.get(path), null)

    await recovery.save(canonicalOutlinePath(path), readFileSync(path, 'utf8'))
    await lookForRecovery(path, readFileSync(path, 'utf8'), reopened.deps)
    assert.equal(store.get(path), null, 'a copy equal to the file is not offered')
    assert.equal(await recovery.read(canonicalOutlinePath(path)), null, 'and is dropped')

    await recovery.save(canonicalOutlinePath(path), 'other text')
    await lookForRecovery(path, readFileSync(path, 'utf8'), reopened.deps)
    assert.deepEqual(await resolveChoice(path, store.get(path), 'discard', reopened.deps), { ok: true })
    assert.deepEqual([store.get(path), await recovery.read(canonicalOutlinePath(path))], [null, null], 'Discard drops the offer and the copy')
    guard.release('win')
  }

  // 10. Only the window that has the talk open can accept for it.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE, 'win-a')
    writeFileSync(path, OUTLINE + '\n## Theirs\n')
    await ed.save()
    assert.equal(guard.owns('win-b', path), false)
    const intruder = { ...ed.deps, accept: (p, hash) => guard.owns('win-b', p) ? guard.accept(p, hash) : Promise.resolve({ ok: false, change: null, error: 'This window does not have that talk open, so nothing was accepted.' }) }
    const result = await keepMine(path, store.get(path), intruder)
    assert.equal(result.ok, false, 'refused')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Theirs\n', 'nothing written')
    guard.release('win-a')
  }
  // 11. Save it again on a talk whose folder the other side renamed away: the save fails, and the bar
  //     stays (with the failure), the difference stays pending in main (a close still holds), and the
  //     text is in the recovery copy. When the folder is back, Save it again lands and clears it all.
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    const folder = dirname(path)
    renameSync(folder, folder + '-renamed-by-the-other-side')
    ed.text = OUTLINE + '\n## Mine\n'
    assert.equal(await ed.save(), false)
    assert.equal(store.get(path)?.kind, 'removed')
    const result = await resolveChoice(path, store.get(path), 'keep', ed.deps)
    assert.equal(result.ok, false, 'Save it again fails')
    assert.match(result.error, /ENOENT/, `and says why: ${result.error}`)
    assert.equal(store.get(path)?.kind, 'removed', 'the bar stays')
    assert.match(describeDiskChange(store.get(path)).text, /^This talk was removed on disk — saving your text failed \(ENOENT/, 'showing the failure')
    assert.equal(guard.pendingFor('win')?.kind, 'removed', 'main still holds a close for it')
    assert.equal((await recovery.read(canonicalOutlinePath(path)))?.text, OUTLINE + '\n## Mine\n', 'the text is in the recovery copy')
    mkdirSync(folder)
    assert.deepEqual(await resolveChoice(path, store.get(path), 'keep', ed.deps), { ok: true }, 'Save it again, the folder back')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Mine\n')
    assert.deepEqual([store.get(path), guard.pendingFor('win'), await recovery.read(canonicalOutlinePath(path))], [null, null, null], 'bar, pending and copy all cleared')
    guard.release('win')
  }

  // 12. Reload drops the talk's recovery copy (the person chose the disk's version over that text).
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    writeFileSync(path, OUTLINE + '\n## Theirs\n')
    ed.text = OUTLINE + '\n## Mine\n'
    assert.equal(await ed.save(), false)
    assert.ok(await recovery.read(canonicalOutlinePath(path)), 'a copy was kept')
    assert.equal((await reloadFromDisk(path, ed.deps)).ok, true)
    assert.equal(await recovery.read(canonicalOutlinePath(path)), null, 'Reload dropped it')
    guard.release('win')
  }

  // 13. The other side reverts the file while the bar is up: the difference clears, and the typing made
  //     meanwhile is saved (it would otherwise sit unsaved with no bar to prompt it). Not while a choice
  //     is under way (its own save is what cleared it).
  {
    const path = talk()
    const ed = editorFor(path, OUTLINE)
    writeFileSync(path, OUTLINE + '\n## Theirs\n')
    ed.text = OUTLINE + '\n## Typed while the bar was up\n'
    assert.equal(await ed.save(), false)
    writeFileSync(path, OUTLINE) // reverted
    assert.equal(await guard.check(path), null, 'main sees it cleared')
    assert.equal(store.get(path), null, 'the bar is gone')
    assert.equal(await saveAfterDiskCleared(path, { ...ed.deps, busy: true }), false, 'nothing while a choice is under way')
    assert.equal(await saveAfterDiskCleared(path, { ...ed.deps, busy: false }), true, 'otherwise the buffer is saved')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Typed while the bar was up\n', 'the typing landed')
    guard.release('win')
  }
} finally {
  guard.dispose()
  configureTalkWriter({ editorBufferFor: () => null })
  setOutlinePathResolver(null)
  rmSync(root, { recursive: true, force: true })
}

console.log('outline disk change (renderer): store and words per kind, refused save keeps the typing in the editor and a recovery copy, Keep mine and Reload (one undo step), stale queued save never lands after Reload, leave guard flushes then holds the switch until Reload/Keep mine completes (Stay here holds, changed-again asks again), removed Save it again / Discard (never recreated), partial Save again only, recovery offered/restored/discarded and never blocks a leave, accept only by the owning window, Save it again on a vanished folder keeps the bar with the failure until it lands, Reload drops the copy, a revert saves the pending typing passed')
