// One writer for talk files (spec 2026-09-27, D2; test 1). Seam: writeTalkOutline
// (src/main/talk-writer.ts) over a temp vault, with a fake editor-window registry wired through
// configureTalkWriter the way index.ts wires the real one (editorEntryForOutline → the window's buffer).
import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureTalkWriter, flushTalkForPublish, writeTalkFileInPlace, writeTalkOutline } from '../src/main/talk-writer.ts'
import { editorEntryForOutline, outlineIdentity } from '../src/main/outline-identity.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-talk-writer-')))
const OUTLINE = '---\ntitle: Writer Talk\n---\n\n## One {id=aa11}\n\n- x\n'
let seq = 0
const talk = (text = OUTLINE) => {
  const dir = join(root, `talk-${++seq}`)
  mkdirSync(dir)
  const path = join(dir, `talk-${seq}-outline.md`)
  writeFileSync(path, text)
  return path
}
const strays = (path) => readdirSync(join(path, '..')).filter((f) => f.endsWith('.tw-write'))

// Fake window registry: each "window" holds a buffer for one outline path.
const windows = []
const log = []
configureTalkWriter({
  editorBufferFor(outlinePath) {
    const entry = editorEntryForOutline(windows, outlinePath, (w) => !w.closed)
    if (!entry) return null
    const win = entry.win
    return {
      async read() { log.push(`read ${win.name}`); return win.buffer },
      async commit(base, next) {
        if (win.buffer !== base) return { ok: false, error: 'changed' }
        win.buffer = next
        log.push(`commit ${win.name}`)
        return { ok: true }
      },
    }
  },
})

try {
  // 1. Closed talk, two concurrent transformations: the second applies to the first's result, in call
  //    order; the final bytes are the second's. (Without the per-file lock both read the same base.)
  {
    const path = talk()
    const first = writeTalkOutline(path, (t) => t + '\n## First\n', 'tags')
    const second = writeTalkOutline(path, (t) => t + '\n## Second\n', 'frontmatter')
    const [r1, r2] = await Promise.all([first, second])
    assert.equal(r1.ok && r1.via, 'disk', 'first written to disk')
    assert.equal(r2.ok && r2.via, 'disk', 'second written to disk')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## First\n' + '\n## Second\n', 'both changes land, second last')
    assert.equal(r2.text, readFileSync(path, 'utf8'), 'result.text is the text written')

    // Two concurrent whole-text writes land in call order; the final bytes are the second's.
    const many = []
    for (let i = 0; i < 8; i += 1) many.push(writeTalkOutline(path, `${OUTLINE}\n## Save ${i}\n`, 'editor'))
    await Promise.all(many)
    assert.equal(readFileSync(path, 'utf8'), `${OUTLINE}\n## Save 7\n`, 'the last queued save is on disk')
    assert.deepEqual(strays(path), [], 'no temp file left beside the talk')
  }

  // 2. The write goes into the EXISTING file (same inode; staged through a temp file beside it that is
  //    then removed): mode bits are kept, a hard-linked twin sees the new text, a symlinked outline
  //    writes its target and stays a link.
  {
    const path = talk()
    chmodSync(path, 0o640)
    const ino = statSync(path).ino
    const res = await writeTalkOutline(path, OUTLINE + '\n## More\n', 'editor')
    assert.equal(res.ok, true)
    assert.equal(statSync(path).ino, ino, 'written in place: the inode never changes')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## More\n', 'with exactly the new bytes')
    assert.equal(statSync(path).mode & 0o777, 0o640, 'mode bits preserved')
    assert.deepEqual(strays(path), [], 'the staging temp file is removed')
    const twin = join(root, `twin-${seq}-outline.md`)
    linkSync(path, twin)
    assert.equal((await writeTalkOutline(path, OUTLINE + '\n## Shorter\n', 'editor')).ok, true)
    assert.equal(readFileSync(twin, 'utf8'), OUTLINE + '\n## Shorter\n', 'a hard link stays one file: the twin sees the write (truncated to the new length)')
    assert.equal(statSync(path).nlink, 2, 'both links remain')
    const link = join(root, `link-${seq}-outline.md`)
    symlinkSync(path, link)
    assert.equal((await writeTalkOutline(link, OUTLINE + '\n## Via link\n', 'editor')).ok, true)
    assert.ok(statSync(link).isFile() && readFileSync(path, 'utf8').endsWith('## Via link\n'), 'the link\'s target was written')
    assert.equal(realpathSync(link), path, 'the link is still a link to the same target')
  }

  // 3. Failure leaves the target untouched and no temp file: a target that cannot be opened for
  //    writing (a folder), and a read-only target (refused before anything is staged).
  {
    const dir = join(root, 'blocked')
    mkdirSync(dir)
    const blocked = join(dir, 'blocked-outline.md')
    mkdirSync(blocked)
    writeFileSync(join(blocked, 'keep.txt'), 'x')
    const res = await writeTalkOutline(blocked, OUTLINE, 'editor')
    assert.equal(res.ok, false, 'a target that cannot be written is a refusal')
    assert.deepEqual(readdirSync(dir).filter((f) => f !== 'blocked-outline.md'), [], 'no temp file left on failure')
    assert.ok(statSync(blocked).isDirectory(), 'target untouched')

    const readOnly = talk()
    chmodSync(readOnly, 0o444)
    const ro = await writeTalkOutline(readOnly, OUTLINE + '\n## No\n', 'editor')
    assert.equal(ro.ok, false, 'a read-only talk is refused')
    assert.equal(readFileSync(readOnly, 'utf8'), OUTLINE, 'and left untouched')
    assert.deepEqual(strays(readOnly), [], 'with no temp file')
    chmodSync(readOnly, 0o644)
  }

  // 4. A transformation that returns its input writes nothing; one that throws is a refusal.
  {
    const path = talk()
    const ino = statSync(path).ino
    const same = await writeTalkOutline(path, (t) => t, 'strip-published')
    assert.deepEqual([same.ok, same.changed], [true, false], 'unchanged')
    assert.equal(statSync(path).ino, ino, 'nothing written')
    const thrown = await writeTalkOutline(path, () => { throw new Error('slide not found') }, 'tags')
    assert.deepEqual(thrown, { ok: false, error: 'slide not found' }, 'a thrown transformation is a refusal with its message')
  }

  // 5. Open talk: the write goes to the window that has the file (any alias) and never touches disk.
  {
    const path = talk()
    const link = join(root, `alias-${seq}-outline.md`)
    symlinkSync(path, link)
    const win = { name: 'editor', buffer: OUTLINE + '\n## Unsaved buffer edit\n', closed: false }
    windows.push({ win, outlinePath: link })
    log.length = 0
    const mtime = statSync(path).mtimeMs
    const res = await writeTalkOutline(path, (t) => t.replace('Writer Talk', 'Retitled'), 'retitle')
    assert.equal(res.ok && res.via, 'editor', 'routed to the editor window')
    assert.deepEqual(log, ['read editor', 'commit editor'], 'read the buffer, then applied to it')
    assert.equal(win.buffer, OUTLINE.replace('Writer Talk', 'Retitled') + '\n## Unsaved buffer edit\n', 'the change is applied to the BUFFER, keeping its unsaved edit')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE, 'disk untouched by main')
    assert.equal(statSync(path).mtimeMs, mtime, 'not even rewritten')

    // The editor refusing (buffer moved on) is a refusal; nothing is written anywhere.
    configureTalkWriter({
      editorBufferFor: () => ({ async read() { return win.buffer }, async commit() { return { ok: false, error: 'The talk was edited meanwhile.' } } }),
    })
    const refused = await writeTalkOutline(path, (t) => t + 'y', 'tags')
    assert.deepEqual(refused, { ok: false, error: 'The talk was edited meanwhile.' }, 'the window\'s refusal is returned')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE, 'disk untouched')

    // The editor's own save and the open-time migration never route: they are the buffer's writes.
    let asked = 0
    configureTalkWriter({ editorBufferFor: () => { asked += 1; return { async read() { throw new Error('must not read') }, async commit() { throw new Error('must not commit') } } } })
    const own = await writeTalkOutline(path, OUTLINE + '\n## Saved by the editor\n', 'editor')
    const mig = await writeTalkOutline(path, OUTLINE + '\n## Migrated\n', 'migration')
    assert.equal(own.ok && own.via, 'disk')
    assert.equal(mig.ok && mig.via, 'disk')
    assert.equal(asked, 0, 'no window lookup for the buffer\'s own writes')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Migrated\n')

    // A window that opens the talk while a closed-talk write waits for the lock takes that write.
    let holder = null
    configureTalkWriter({
      editorBufferFor: () => holder && {
        async read() { return holder.buffer },
        async commit(base, next) { if (holder.buffer !== base) return { ok: false, error: 'changed' }; holder.buffer = next; return { ok: true } },
      },
    })
    // `late` finds no window when called, so it queues for the lock behind `blocker`; the talk opens
    // before its turn comes.
    const blocker = writeTalkOutline(path, OUTLINE + '\n## Blocker\n', 'editor')
    const late = writeTalkOutline(path, (t) => t + '\n## Late\n', 'tags')
    holder = { buffer: 'buffer text\n' }
    await blocker
    const lateRes = await late
    assert.equal(lateRes.ok && lateRes.via, 'editor', 'a write that waited while the talk opened goes to the window')
    assert.equal(holder.buffer, 'buffer text\n\n## Late\n', 'and is applied to the buffer')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE + '\n## Blocker\n', 'not to disk')
  }

  // 6. Publish-handout's flush (index.ts talk:publish-handout → flushTalkForPublish): for an open talk
  //    whose buffer has an edit NEWER than the text the renderer sent with the request, the flush is a
  //    forced save of the buffer as it stands — the newer edit is kept, in the buffer and on disk.
  {
    const path = talk()
    const sentByRenderer = OUTLINE // what the renderer sent when Publish was pressed
    const buffer = { text: sentByRenderer + '\n## Typed after pressing Publish\n' }
    const commits = []
    configureTalkWriter({
      editorBufferFor: () => ({
        async read() { return buffer.text },
        // The editor applies `next`, then saves its whole buffer to disk (lib/outlineMutation.ts applyFromMain).
        async commit(base, next) {
          if (buffer.text !== base) return { ok: false, error: 'changed' }
          commits.push(next)
          buffer.text = next
          writeFileSync(path, buffer.text)
          return { ok: true }
        },
      }),
    })
    const res = await flushTalkForPublish(path)
    assert.equal(res.ok && res.via, 'editor', 'the flush goes through the open editor')
    assert.equal(commits.length, 1, 'it is a real (forced) save even though the text is unchanged')
    assert.ok(buffer.text.includes('## Typed after pressing Publish'), 'the buffer keeps the edit made after the renderer sent its text')
    assert.equal(readFileSync(path, 'utf8'), buffer.text, 'and the buffer as it stands is what reached disk')

    // A closed talk: the flush leaves the file's own text as it is.
    configureTalkWriter({ editorBufferFor: () => null })
    const closed = talk(OUTLINE + '\n## On disk\n')
    const flushed = await flushTalkForPublish(closed)
    assert.equal(flushed.ok && flushed.via, 'disk')
    assert.equal(readFileSync(closed, 'utf8'), OUTLINE + '\n## On disk\n', 'closed talk: its own text, unchanged')
  }

  // 7. The lock follows the FILE, not a key taken once (round 3): writes that span the file's
  //    creation, and writes that span an outside tool replacing it by rename, queue on one chain.
  configureTalkWriter({ editorBufferFor: () => null })
  const appended = (text) => text.trim().split('\n').slice(1)
  {
    // 20 writes queued while the file does not exist yet, behind the write that creates it, and 20
    // more once it exists: every one lands, in call order.
    const dir = join(root, 'creation')
    mkdirSync(dir)
    const path = join(dir, 'creation-outline.md')
    const all = [writeTalkOutline(path, '# Created\n', 'create-talk')]
    for (let i = 0; i < 20; i += 1) all.push(writeTalkOutline(path, (t) => t + `before-${i}\n`, 'tags'))
    await new Promise((resolve) => { const t = setInterval(() => { if (existsSync(path)) { clearInterval(t); resolve() } }, 0) })
    for (let i = 0; i < 20; i += 1) all.push(writeTalkOutline(path, (t) => t + `after-${i}\n`, 'tags'))
    const results = await Promise.all(all)
    assert.ok(results.every((r) => r.ok), 'every write spanning creation reports ok')
    const expected = [...Array.from({ length: 20 }, (_, i) => `before-${i}`), ...Array.from({ length: 20 }, (_, i) => `after-${i}`)]
    assert.deepEqual(appended(readFileSync(path, 'utf8')), expected, 'all 40 land, in call order')
  }
  {
    // An outside tool replaces the file by rename (a new inode) while writes are queued: each write
    // either lands or reports ok:false — none is reported done and then missing.
    const path = talk('# Replaced\n')
    const early = []
    for (let i = 0; i < 20; i += 1) early.push(writeTalkOutline(path, (t) => t + `early-${i}\n`, 'tags'))
    await new Promise((resolve) => setImmediate(resolve))
    const keyBefore = outlineIdentity(path).key
    const outside = join(path, '..', '.outside-tool.tmp')
    writeFileSync(outside, readFileSync(path))
    renameSync(outside, path)
    assert.notEqual(outlineIdentity(path).key, keyBefore, 'fixture: the replace is a new inode')
    const later = []
    for (let i = 0; i < 20; i += 1) later.push(writeTalkOutline(path, (t) => t + `later-${i}\n`, 'tags'))
    const results = await Promise.all([...early, ...later])
    const labels = [...Array.from({ length: 20 }, (_, i) => `early-${i}`), ...Array.from({ length: 20 }, (_, i) => `later-${i}`)]
    const onDisk = new Set(appended(readFileSync(path, 'utf8')))
    const silentlyLost = labels.filter((label, i) => results[i].ok && !onDisk.has(label))
    assert.deepEqual(silentlyLost, [], 'no write reports ok and is missing')
    for (let i = 0; i < 40; i += 1) {
      if (!results[i].ok) assert.match(results[i].error, /replaced while writing/, `a write that did not land says why (${labels[i]})`)
    }
    assert.ok(labels.slice(20).every((label) => onDisk.has(label)), 'every write queued after the replace lands')
  }
  {
    // Two hard-link aliases written concurrently serialise on the inode lock: no lost update.
    const path = talk('# Linked\n')
    const alias = join(root, `alias-lock-${seq}-outline.md`)
    linkSync(path, alias)
    const all = []
    for (let i = 0; i < 20; i += 1) all.push(writeTalkOutline(i % 2 ? alias : path, (t) => t + `w-${i}\n`, 'tags'))
    const results = await Promise.all(all)
    assert.ok(results.every((r) => r.ok), 'every aliased write reports ok')
    assert.deepEqual(appended(readFileSync(path, 'utf8')), Array.from({ length: 20 }, (_, i) => `w-${i}`), 'all 20 land in call order through either link')
  }
  {
    // The in-place write refuses a target replaced under it, both before its bytes go in (the opened
    // inode is not the one the lock holds) and after (the path no longer names the inode written).
    const path = talk('# Swap\n')
    const key = outlineIdentity(path).key
    const swap = () => { const tmp = join(path, '..', '.swap.tmp'); writeFileSync(tmp, '# Outside\n'); renameSync(tmp, path) }
    await assert.rejects(writeTalkFileInPlace(path, '# Ours\n', { expectKey: key, beforeCopy: async () => { swap(); return true } }), /replaced while writing/, 'replaced before the copy: refused')
    assert.equal(readFileSync(path, 'utf8'), '# Outside\n', 'the outside version is untouched')
    const key2 = outlineIdentity(path).key
    await assert.rejects(writeTalkFileInPlace(path, '# Ours\n', { expectKey: key2, afterCopy: async () => swap() }), /replaced while writing/, 'replaced during the copy: never reported written')
    assert.deepEqual(strays(path), [], 'no temp file left')
  }

  // 8. The structurally-empty backstop applies to every non-editor origin: an empty result over a
  //    non-empty talk is refused with the talk:write-outline message, and the file is left as it is.
  {
    const path = talk()
    const warn = console.warn
    const warnings = []
    console.warn = (line) => warnings.push(line)
    try {
      const emptied = await writeTalkOutline(path, () => '', 'tags')
      assert.equal(emptied.ok, false, 'an emptying transformation is refused')
      assert.match(emptied.error, /REFUSED empty-over-nonempty write to .* \(data-loss backstop\)/, 'with the backstop message')
      const whole = await writeTalkOutline(path, 'just prose, no heading\n', 'create-talk')
      assert.equal(whole.ok, false, 'a structurally-empty whole text is refused too')
      assert.equal(readFileSync(path, 'utf8'), OUTLINE, 'the talk is untouched')
      assert.equal(warnings.length, 2, 'each refusal is logged')
      const fresh = join(root, 'empty-new-outline.md')
      assert.equal((await writeTalkOutline(fresh, '', 'create-talk')).ok, true, 'an empty write over nothing is not blocked')
    } finally {
      console.warn = warn
    }
  }
  // 8. Routed writes to an OPEN talk (whole-branch verification): each routed write reads the buffer,
  //    works out its text and asks the window to apply it only while the buffer is still that read.
  //    (a) 30 concurrent function writes, over a window with an async IPC hop each way, all land, in
  //        call order (the route queue: without it they all read one base and all but one refuse);
  //    (b) a buffer that moves between a write's read and its apply (the person typed) makes a
  //        function write work its text out again against a fresh read — and the typing is kept;
  //    (c) a buffer that keeps moving refuses after the bounded retries, applying nothing;
  //    (d) whole-text writes are never re-applied over a moved buffer: 5 of them all refuse, once each.
  {
    const path = talk()
    const hop = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)))
    const win = { buffer: OUTLINE, typeBeforeCommit: 0, commits: 0, origins: new Set() }
    configureTalkWriter({
      editorBufferFor: (p) => p === path ? {
        async read() { await hop(); const text = win.buffer; await hop(); return text },
        async commit(base, next, origin) {
          await hop()
          win.commits += 1
          win.origins.add(origin)
          if (win.typeBeforeCommit > 0) { win.typeBeforeCommit -= 1; win.buffer += `typed ${win.commits}\n` }
          if (win.buffer !== base) return { ok: false, error: 'moved', moved: true }
          win.buffer = next
          await hop()
          return { ok: true }
        },
      } : null,
    })
    const many = []
    for (let i = 0; i < 30; i += 1) many.push(writeTalkOutline(path, (t) => t + `R${i}\n`, 'tags'))
    const results = await Promise.all(many)
    assert.equal(results.filter((r) => r.ok && r.via === 'editor').length, 30, `all 30 land: ${JSON.stringify(results.filter((r) => !r.ok))}`)
    assert.equal(win.buffer, OUTLINE + Array.from({ length: 30 }, (_, i) => `R${i}\n`).join(''), 'in call order, each once')
    assert.equal(win.commits, 30, 'one apply each: no write ever read a stale base')
    assert.deepEqual([...win.origins], ['tags'], 'the window is told which writer it is')

    win.commits = 0
    win.typeBeforeCommit = 2 // the person types before each of the first two applies
    const retried = await writeTalkOutline(path, (t) => t + 'AFTER-TYPING\n', 'tags')
    assert.equal(retried.ok, true, retried.error)
    assert.equal(win.commits, 3, 'two refusals, then worked out again against the buffer as it stood')
    assert.ok(win.buffer.endsWith('typed 1\ntyped 2\nAFTER-TYPING\n'), 'the typing is kept and the change goes on top of it')

    win.commits = 0
    win.typeBeforeCommit = 99
    const before = win.buffer
    const exhausted = await writeTalkOutline(path, (t) => t + 'NEVER\n', 'tags')
    assert.deepEqual([exhausted.ok, win.commits], [false, 4], 'refused after the first try and 3 retries')
    assert.ok(!win.buffer.includes('NEVER') && win.buffer.startsWith(before), 'nothing applied; the typing kept')

    win.commits = 0
    win.typeBeforeCommit = 99
    const whole = []
    for (let i = 0; i < 5; i += 1) whole.push(writeTalkOutline(path, `${OUTLINE}\n## Whole ${i}\n`, 'frontmatter'))
    const wholeResults = await Promise.all(whole)
    assert.ok(wholeResults.every((r) => r.ok === false), 'every whole-text write over a moved buffer refuses')
    assert.equal(win.commits, 5, 'each tried once: a whole text is never re-applied over newer typing')
    assert.ok(!win.buffer.includes('## Whole'), 'none applied')
    assert.equal(readFileSync(path, 'utf8'), OUTLINE, 'disk untouched throughout (the window is the writer)')
    configureTalkWriter({ editorBufferFor: () => null })
  }
} finally {
  configureTalkWriter({ editorBufferFor: () => null })
  rmSync(root, { recursive: true, force: true })
}

console.log('talk writer: closed-talk writes in call order under one lock, in-place write (same inode, mode, hard and soft links, no temp on failure, read-only refused), unchanged/thrown transformations, open talk routed to its window and never to disk, buffer-owned writes never routed, publish flush keeps a newer buffer edit, lock follows the file across creation and outside replace, hard-link aliases serialise, replaced-while-writing refused, empty backstop on every origin, open-talk routed writes queued in order with bounded retry of function writes (whole texts refuse) passed')
