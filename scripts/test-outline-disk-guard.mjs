// Outline external-change guard (shared-talk ticket 01). Seam: the main-process talk-file read/write
// path — writeTalkOutline / writeTalkFileInPlace (src/main/talk-writer.ts) with the guard
// (src/main/outline-disk-guard.ts) wired through configureTalkWriter the way index.ts wires it, over a
// temp vault, plus the recovery copies (src/main/outline-recovery.ts). The directory watcher is the real
// registry (talkTextWatchers.ts) over a fake watcher whose events and errors the test fires by hand;
// every other dependency is the real one (files, the file lock).
import assert from 'node:assert/strict'
import { chmodSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configureTalkWriter, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { createOutlineDiskGuard, hashOutlineText } from '../src/main/outline-disk-guard.ts'
import { createOutlineRecovery, recoveryPathHash } from '../src/main/outline-recovery.ts'
import { createDirectoryWatcherRegistry } from '../src/main/talkTextWatchers.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-disk-guard-')))
const OUTLINE = '---\ntitle: Guard Talk\n---\n\n## One {id=aa11}\n\n- x\n'
let seq = 0
const talk = (text = OUTLINE) => {
  const dir = join(root, `talk-${++seq}`)
  mkdirSync(dir)
  const path = join(dir, `talk-${seq}-outline.md`)
  writeFileSync(path, text)
  return path
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

// Fake fs.watch behind the REAL registry: one fake per folder; the test fires `change` or `error`.
const fakes = new Map()
const registry = createDirectoryWatcherRegistry((directory, onChange) => {
  const handlers = { error: [] }
  const fake = { onChange, closed: false, close() { this.closed = true; fakes.delete(directory) }, on(event, fn) { handlers[event]?.push(fn) }, fail() { for (const fn of handlers.error) fn() } }
  fakes.set(directory, fake)
  return fake
})
const notices = []
const guard = createOutlineDiskGuard({
  canonical: canonicalOutlinePath,
  async readText(realPath) {
    try { return await readFile(realPath, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
  },
  async mtime(realPath) { try { return statSync(realPath).mtimeMs } catch { return null } },
  withLock: (outlinePath, work) => withTalkFileLock(outlinePath, () => work()),
  watch: (realPath, onChange, onError) => registry.acquire(dirname(realPath), realPath, onChange, onError),
  unwatch: (realPath) => registry.releaseOwner(realPath),
  notify: (owner, outlinePath, change) => notices.push({ owner, outlinePath, change }),
})
let afterTruncate = null
configureTalkWriter({ editorBufferFor: () => null, diskGuard: guard, afterTruncate: (p) => afterTruncate ? afterTruncate(p) : Promise.resolve() })
async function fire(path) {
  const fake = fakes.get(dirname(canonicalOutlinePath(path)))
  assert.ok(fake, `watching ${path}`)
  fake.onChange()
  await tick(220) // the registry's 150 ms debounce, then the check under the file lock
}
// An outside program writing the file (another TalkWeaver, a sync client): not through the app's writer.
const outside = (path, text) => writeFileSync(path, text)
const real = (path) => canonicalOutlinePath(path)

try {
  // 1. External change, then the editor's save: refused with the change; the newer file is untouched.
  //    A whole text from another writer is refused too; a transformation (tags from the talk list) is
  //    worked out from the fresh file and lands on top of the outside change.
  {
    const path = talk()
    guard.track('w1', path, OUTLINE)
    assert.ok(guard.tracks(real(path)), 'the loaded talk is guarded')
    const theirs = OUTLINE + '\n## Theirs\n'
    outside(path, theirs)
    const refused = await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')
    assert.equal(refused.ok, false, 'a save over a file that changed on disk is refused')
    assert.deepEqual([refused.changedOnDisk?.kind, refused.changedOnDisk?.hash], ['changed', hashOutlineText(theirs)], 'the refusal names the version on disk')
    assert.equal(readFileSync(path, 'utf8'), theirs, 'the newer file is never overwritten')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Whole\n', 'frontmatter')).ok, false, 'another writer’s whole text is refused too')
    assert.equal(readFileSync(path, 'utf8'), theirs, 'still untouched')
    const tagged = await writeTalkOutline(path, (t) => t + '## Tag\n', 'tags')
    assert.equal(tagged.ok, true, `a transformation of the fresh file is never refused: ${tagged.error ?? ''}`)
    assert.equal(readFileSync(path, 'utf8'), theirs + '## Tag\n', 'and keeps the outside change')
    assert.equal(notices.filter((n) => n.owner === 'w1' && n.change).length, 1, 'the window is told once, not once per refused save')
    assert.equal(guard.pendingFor('w1')?.kind, 'changed', 'the close check sees the unresolved difference')
    const again = await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')
    assert.equal(again.ok, false, 'a tag write never moves the editor’s baseline: the editor still has to choose')
    guard.release('w1')
    assert.equal(guard.pendingFor('w1'), null)
  }

  // 2. Self-writes never trigger the guard: the app's own saves (and the watcher event each causes) are
  //    the new baseline.
  {
    notices.length = 0
    const path = talk()
    guard.track('w2', path, OUTLINE)
    for (let i = 0; i < 4; i += 1) {
      const res = await writeTalkOutline(path, `${OUTLINE}\n## Save ${i}\n`, 'editor')
      assert.equal(res.ok, true, `own save ${i} lands: ${res.error ?? ''}`)
      await fire(path)
    }
    assert.deepEqual(notices, [], 'no own save is ever reported as a change on disk')
    assert.equal(await guard.check(path), null, 'a direct check agrees')
    guard.release('w2')
  }

  // 3. The watcher reports an outside change once, a newer one again, and a return to the baseline
  //    clears it. The rename-replace pattern (write a temp file, rename it over) is seen the same way.
  {
    notices.length = 0
    const path = talk()
    guard.track('w3', path, OUTLINE)
    outside(path, OUTLINE + '\n## Outside\n')
    await fire(path)
    await fire(path)
    assert.equal(notices.length, 1, 'reported once')
    assert.deepEqual([notices[0].owner, notices[0].outlinePath, notices[0].change?.hash], ['w3', path, hashOutlineText(OUTLINE + '\n## Outside\n')])
    const temp = join(dirname(path), '.sync-tmp')
    writeFileSync(temp, OUTLINE + '\n## Renamed over\n')
    renameSync(temp, path)
    await fire(path)
    assert.equal(notices.at(-1)?.change?.hash, hashOutlineText(OUTLINE + '\n## Renamed over\n'), 'a rename-replace is a change')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).ok, false, 'and refuses the save')
    outside(path, OUTLINE)
    await fire(path)
    assert.equal(notices.at(-1)?.change, null, 'back to what the editor has: cleared')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Fine\n', 'editor')).ok, true, 'and saving works again')
    guard.release('w3')
  }

  // 4. A save whose text is exactly what is on disk is accepted silently (no refusal, no notice) and is
  //    the new baseline.
  {
    notices.length = 0
    const path = talk()
    guard.track('w4', path, OUTLINE)
    const same = OUTLINE + '\n## Same edit on both sides\n'
    outside(path, same)
    const res = await writeTalkOutline(path, same, 'editor')
    assert.equal(res.ok, true, 'accepted')
    assert.deepEqual(notices, [], 'no bar')
    assert.equal((await writeTalkOutline(path, same + '## More\n', 'editor')).ok, true, 'the disk text is the new baseline')
    guard.release('w4')
  }

  // 5. Keep mine: accept the version seen, then the save lands. A file changed AGAIN after the bar
  //    appeared refuses the accept with the newer version.
  {
    const path = talk()
    guard.track('w5', path, OUTLINE)
    outside(path, OUTLINE + '\n## V1\n')
    const seen = (await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).changedOnDisk
    outside(path, OUTLINE + '\n## V2\n')
    const stale = await guard.accept(path, seen.hash)
    assert.equal(stale.ok, false, 'Keep mine over a version the person has not seen is refused')
    assert.equal(stale.change?.hash, hashOutlineText(OUTLINE + '\n## V2\n'), 'with the newer change')
    assert.equal((await guard.accept(path, stale.change.hash)).ok, true, 'accepting the version seen')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).ok, true, 'then the editor’s text saves over it')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Mine\n')
    guard.release('w5')
  }

  // 6. Reload: the disk version (text + hash) is accepted, and the editor's next save lands.
  {
    const path = talk()
    guard.track('w6', path, OUTLINE)
    const theirs = OUTLINE + '\n## Theirs\n'
    outside(path, theirs)
    const version = await guard.diskVersion(path)
    assert.deepEqual(version, { text: theirs, hash: hashOutlineText(theirs) })
    assert.equal((await guard.accept(path, version.hash)).ok, true)
    assert.equal((await writeTalkOutline(path, theirs + '## Typed after reload\n', 'editor')).ok, true, 'the next save lands')
    guard.release('w6')
  }

  // 7. Release (talk switch, close) drops the entry at once; the talk then writes as a closed talk.
  //    A talk-list tag write on a talk no editor holds is never refused by an old baseline.
  {
    const path = talk()
    guard.track('w7', path, OUTLINE)
    const other = talk()
    guard.track('w7', other, OUTLINE) // the window switched talks: the first is released
    assert.equal(guard.tracks(real(path)), false, 'the released talk is no longer guarded')
    assert.equal(fakes.has(dirname(real(path))), false, 'nor watched')
    assert.equal(guard.owns('w7', other) && !guard.owns('w7', path) && !guard.owns('w8', other), true, 'ownership follows the window')
    outside(path, OUTLINE + '\n## Outside\n')
    assert.equal((await writeTalkOutline(path, (t) => t + '## Tag\n', 'tags')).ok, true, 'a closed talk transforms the file as it stands')
    guard.release('w7')
  }

  // 8. Removed on disk: the watcher reports it and every save is refused (never silently recreated)
  //    until Save it again (accept the removal); the app's own move/delete (`forget`) is never reported.
  {
    notices.length = 0
    const path = talk()
    guard.track('w8', path, OUTLINE)
    unlinkSync(path)
    await fire(path)
    assert.deepEqual([notices.at(-1)?.change?.kind, notices.at(-1)?.change?.hash], ['removed', 'removed'], 'reported as removed')
    const refused = await writeTalkOutline(path, OUTLINE + '\n## Autosave\n', 'editor')
    assert.equal(refused.changedOnDisk?.kind, 'removed', 'an autosave never recreates it')
    assert.equal(existsSync(path), false)
    assert.equal((await guard.accept(path, 'removed')).ok, true, 'Save it again accepts the removal')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Again\n', 'editor')).ok, true, 'then the save recreates it')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Again\n')
    notices.length = 0
    guard.forget(dirname(path)) // the app's own delete of the talk folder
    rmSync(dirname(path), { recursive: true, force: true })
    assert.equal(guard.tracks(real(path)), false, 'forgotten')
    assert.ok(notices.every((n) => n.change === null), 'the owner is told there is nothing to choose, never "removed"')
  }

  // 9. Only a missing file counts as missing: any other read failure refuses the save, naming the error,
  //    and writes nothing.
  if (process.getuid?.() !== 0) {
    const path = talk()
    guard.track('w9', path, OUTLINE)
    chmodSync(path, 0o200) // write-only: reading fails with EACCES
    const refused = await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')
    chmodSync(path, 0o644)
    assert.equal(refused.ok, false, 'refused')
    assert.match(refused.error, /EACCES/, `the error is named: ${refused.error}`)
    assert.equal(readFileSync(path, 'utf8'), OUTLINE, 'nothing written')
    guard.release('w9')
  }

  // 10. A save that fails halfway (after truncation) marks the talk: the bar names the temp copy, every
  //     save is refused (the partial text is never offered for Reload or silently accepted) until Save
  //     again, which then writes the editor's text.
  {
    notices.length = 0
    const path = talk()
    guard.track('w10', path, OUTLINE)
    afterTruncate = async () => { afterTruncate = null; throw new Error('disk full (simulated)') }
    const failed = await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')
    assert.equal(failed.ok, false)
    assert.equal(failed.changedOnDisk?.kind, 'partial', 'the failure is a partial write')
    const temp = failed.changedOnDisk.tempPath
    assert.ok(temp && existsSync(temp) && readFileSync(temp, 'utf8') === OUTLINE + '\n## Mine\n', 'the temp copy with the full text is named')
    assert.equal(notices.at(-1)?.change?.kind, 'partial', 'the window is told')
    await fire(path)
    assert.equal(notices.at(-1)?.change?.kind, 'partial', 'a watcher event never turns it into an offer to reload the partial text')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).changedOnDisk?.kind, 'partial', 'saves wait for Save again')
    assert.equal((await guard.accept(path, hashOutlineText(''))).ok, false, 'accepting anything but the partial version is refused')
    assert.equal((await guard.accept(path, failed.changedOnDisk.hash)).ok, true, 'Save again')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).ok, true)
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Mine\n', 'the editor’s text is on disk')
    unlinkSync(temp)
    guard.release('w10')
  }

  // 11. A watcher that errors stops: the guard says it is not watching, and the check every save makes
  //     still refuses a save over an outside change.
  {
    const path = talk()
    guard.track('w11', path, OUTLINE)
    assert.equal(guard.watching(real(path)), true, 'watching')
    fakes.get(dirname(real(path))).fail()
    assert.equal(guard.watching(real(path)), false, 'no longer watching after the error')
    outside(path, OUTLINE + '\n## Outside\n')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).changedOnDisk?.kind, 'changed', 'the save-time check still refuses')
    assert.equal((await guard.check(path))?.kind, 'changed', 'and the focus check still sees it')
    guard.release('w11')
  }

  // 12. The open-time migration is exempt (it re-reads the fresh bytes itself), and an untracked talk is
  //     not guarded at all.
  {
    const path = talk()
    guard.track('w12', path, OUTLINE)
    outside(path, OUTLINE + '\n## Outside\n')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Migrated\n', 'migration')).ok, true, 'the migration writes')
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Migrated\n## Typed\n', 'editor')).ok, true, 'and its text is the baseline')
    guard.release('w12')
    const loose = talk()
    outside(loose, OUTLINE + '\n## Outside\n')
    assert.equal((await writeTalkOutline(loose, OUTLINE + '\n## Whole\n', 'create-talk')).ok, true, 'untracked: unguarded')
  }

  // 13. Keep mine / Save it again keeps the difference reported until the save lands: a save that fails
  //     (the other side renamed the talk's folder away) leaves it pending, and the next landing save
  //     clears it.
  {
    notices.length = 0
    const path = talk()
    guard.track('w13', path, OUTLINE)
    const folder = dirname(path)
    renameSync(folder, folder + '-renamed-elsewhere')
    await fire(path).catch(() => undefined)
    assert.equal(guard.pending(path)?.kind, 'removed', 'removed')
    assert.equal((await guard.accept(path, 'removed', { keepPending: true })).ok, true, 'Save it again')
    assert.equal(guard.pending(path)?.kind, 'removed', 'still pending until the save lands')
    const failed = await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')
    assert.equal(failed.ok, false, 'the save fails: the folder is gone')
    assert.match(failed.error, /ENOENT/, failed.error)
    assert.equal(guard.pending(path)?.kind, 'removed', 'and the difference stays (the bar stays)')
    assert.equal(guard.pendingFor('w13')?.kind, 'removed', 'a close still holds for it')
    mkdirSync(folder)
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Mine\n', 'editor')).ok, true, 'once the folder is back, the save lands')
    assert.equal(guard.pending(path), null, 'and only then is the difference cleared')
    assert.equal(notices.at(-1)?.change, null, 'the window is told')
    guard.release('w13')
  }

  // 14. Recovery copies: one per talk, named <slug>-<path hash>-<timestamp>-outline.md, kept up to date,
  //     read back, deleted on clear; two talks with one slug never share a copy; a corrupt index.json is
  //     rebuilt from the copies present; the app's own rename or move of a talk moves its copy.
  {
    const dir = join(root, 'recovery')
    let clock = Date.UTC(2026, 8, 28, 9, 12, 0)
    const recovery = createOutlineRecovery(dir, () => clock)
    const path = join(root, 'talk-x', 'guard-talk-outline.md')
    const twin = join(root, 'elsewhere', 'guard-talk-outline.md') // the same slug, another talk
    await recovery.save(path, 'first unsaved text')
    clock += 60_000
    await recovery.save(path, 'second unsaved text')
    await recovery.save(twin, 'the twin’s text')
    const copies = () => readdirSync(dir).filter((f) => f.endsWith('-outline.md')).sort()
    assert.deepEqual(copies(), [
      `guard-talk-${recoveryPathHash(path)}-2026-09-28T09-13-00-000Z-outline.md`,
      `guard-talk-${recoveryPathHash(twin)}-2026-09-28T09-13-00-000Z-outline.md`,
    ].sort(), 'one copy per talk, the newest, named by slug, path hash and time')
    assert.deepEqual(await recovery.read(path), { text: 'second unsaved text', savedAt: clock })
    assert.equal((await recovery.read(twin))?.text, 'the twin’s text', 'the same slug in another folder is its own copy')

    writeFileSync(join(dir, 'index.json'), '{ this is not json')
    const rebuilt = createOutlineRecovery(dir)
    assert.equal((await rebuilt.read(path))?.text, 'second unsaved text', 'a corrupt index is rebuilt from the copies present')
    assert.equal((await rebuilt.read(twin))?.text, 'the twin’s text')
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')), 'and written back')

    const renamed = join(root, 'talk-renamed', 'renamed-talk-outline.md')
    await rebuilt.rekey(path, renamed)
    assert.equal(await rebuilt.read(path), null, 'the old path has no copy')
    assert.equal((await rebuilt.read(renamed))?.text, 'second unsaved text', 'a renamed talk keeps its copy')
    const movedDir = join(root, 'topic-b', 'talk-renamed')
    await rebuilt.rekey(join(root, 'talk-renamed'), movedDir, { under: true })
    assert.equal((await rebuilt.read(join(movedDir, 'renamed-talk-outline.md')))?.text, 'second unsaved text', 'a moved folder moves the copies of the talks inside it')
    const restarted = createOutlineRecovery(dir)
    assert.equal((await restarted.read(join(movedDir, 'renamed-talk-outline.md')))?.text, 'second unsaved text', 'found again after a restart')
    await restarted.clear(join(movedDir, 'renamed-talk-outline.md'))
    await restarted.clear(twin)
    assert.deepEqual(copies(), [], 'cleared copies are deleted')
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.path')), [], 'and their path notes with them')

    // Ticket 08: a copy whose index entry was rebuilt from the files still moves with a later rename
    // of the folder holding its talk (its outline path is read back from the copy's `.path` note).
    const inFolder = join(root, 'topic-c', 'talk-y', 'talk-y-outline.md')
    await restarted.save(inFolder, 'typed in a folder')
    writeFileSync(join(dir, 'index.json'), '{ corrupt')
    const again = createOutlineRecovery(dir)
    await again.rekey(join(root, 'topic-c'), join(root, 'topic-d'), { under: true })
    const inRenamed = join(root, 'topic-d', 'talk-y', 'talk-y-outline.md')
    assert.equal((await again.read(inRenamed))?.text, 'typed in a folder', 'a rebuilt entry moves with its folder')
    assert.equal(await again.read(inFolder), null, 'and is gone from the old path')
    const paths = readdirSync(dir).filter((f) => f.endsWith('.path'))
    assert.equal(paths.length, 1, 'one note, beside the moved copy')
    assert.equal(readFileSync(join(dir, paths[0]), 'utf8'), inRenamed, 'naming the new path')
    await again.clear(inRenamed)
  }

  // 15. Ticket 08: the app deletes a FOLDER holding an open talk. The talk is not forgotten: `openUnder`
  //     names it before the delete, the check after it reports the removal to its window, every save is
  //     refused (nothing is recreated) — also when the vault is reached through a symlink, where a
  //     deleted folder can no longer be resolved.
  {
    notices.length = 0
    const vaultReal = join(root, 'vault-real')
    mkdirSync(join(vaultReal, 'topic', 'held'), { recursive: true })
    const link = join(root, 'vault-link')
    symlinkSync(vaultReal, link)
    const path = join(link, 'topic', 'held', 'held-outline.md')
    writeFileSync(path, OUTLINE)
    guard.track('w15', path, OUTLINE)
    const other = talk()
    guard.track('w15b', other, OUTLINE)
    const open = guard.openUnder(join(link, 'topic'))
    assert.deepEqual(open, [real(path)], 'the open talk inside the folder, by its real path; the talk elsewhere is not named')
    rmSync(join(vaultReal, 'topic'), { recursive: true, force: true })
    assert.equal(real(path), open[0], 'a deleted folder still resolves to the key the talk had while open')
    for (const p of open) await guard.check(p)
    assert.equal(notices.at(-1)?.owner, 'w15')
    assert.equal(notices.at(-1)?.change?.kind, 'removed', 'its window is told the file was removed (the bar)')
    assert.equal(notices.at(-1)?.outlinePath, path, 'in the path that window uses')
    const refused = await writeTalkOutline(path, OUTLINE + '\n## Typed after\n', 'editor')
    assert.equal(refused.changedOnDisk?.kind, 'removed', 'an autosave is refused, so the caller keeps a recovery copy')
    assert.equal(existsSync(join(vaultReal, 'topic')), false, 'nothing recreated')
    assert.equal(guard.pending(other), null, 'the talk outside the folder is untouched')
    guard.release('w15')
    guard.release('w15b')
  }
} finally {
  guard.dispose()
  registry.releaseAll()
  configureTalkWriter({ editorBufferFor: () => null })
  rmSync(root, { recursive: true, force: true })
}

console.log('outline disk guard: external change refuses whole-text saves (reported once) while fresh-file transformations land, self-writes never reported, watcher once/newer/cleared incl. rename-replace, equal text accepted silently, Keep mine accepts the version seen, Reload, release drops at once and ownership follows the window, removed refuses until Save it again and app moves are forgotten, non-ENOENT read errors refuse, partial write marked until Save again, watcher error falls back to save and focus checks, migration exempt, keep-pending until the save lands (a failed save keeps the bar), recovery copies per path hash with rebuild and rekey (rebuilt entries move with their folder), folder delete reports the open talk removed passed')
