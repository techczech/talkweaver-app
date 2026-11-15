// 0.45, second Mac, item 4: one writer at a time for an edits file on one Mac (src/main/edits-lock.ts), with
// real processes. A lock left by a process that has gone, or by a pid now used by another process, never
// blocks; a live holder is waited for, then refused in words; and two processes saving the same edits file at
// once through the real store end with every save either in the file or kept as a copy with a notice.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { lockPathFor, processStarted, withEditsLock } from '../src/main/edits-lock.ts'
import { createRecordingEditsStore, editsDigest } from '../src/main/recording-edits-store.ts'
import { earlierOf } from '../src/shared/recording-edits-kept.ts'

const repo = resolve(import.meta.dirname, '..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-edits-lock-')))
const locks = join(root, 'locks'); mkdirSync(locks)
let n = 0
const pass = (name) => console.log(`PASS ${++n} ${name}`)
const node = (code, args = []) => spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', code, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
const done = (child) => new Promise((r) => { let out = '', err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d)); child.on('exit', (code) => r({ code, out, err })) })

try {
  // ---- 1. A lock whose process has gone does not block -------------------------------------------------
  {
    const file = join(root, 'a.json')
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    const pid = Number(gone.stdout.trim())
    writeFileSync(lockPathFor(file, locks), JSON.stringify({ pid, started: 'Mon Nov  3 09:00:00 2026' }))
    const t0 = Date.now()
    assert.equal(withEditsLock(file, () => 'ran', { folder: locks, waitMs: 2000 }), 'ran')
    assert.ok(Date.now() - t0 < 1000, 'taken over at once')
    assert.equal(existsSync(lockPathFor(file, locks)), false, 'released afterwards')
    pass('a lock left by a process that has gone is taken over at once, and released after')
  }
  // ---- 2. A pid now used by another process (start time differs) does not block -------------------------
  {
    const file = join(root, 'b.json')
    writeFileSync(lockPathFor(file, locks), JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }))
    assert.equal(withEditsLock(file, () => 'ran', { folder: locks, waitMs: 2000 }), 'ran')
    pass('a lock naming a live pid with another start time (the pid was reused) is taken over')
  }
  // ---- 3. A live holder is waited for; past the wait, a refusal in words --------------------------------
  {
    const file = join(root, 'c.json')
    const holder = node(`
      import { withEditsLock } from './src/main/edits-lock.ts'
      withEditsLock(process.argv[1], () => { console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500) }, { folder: process.argv[2] })
    `, [file, locks])
    await new Promise((r) => holder.stdout.once('data', r))
    assert.ok(existsSync(lockPathFor(file, locks)))
    const held = JSON.parse(readFileSync(lockPathFor(file, locks), 'utf8'))
    assert.equal(held.pid, holder.pid); assert.equal(held.started, processStarted(holder.pid), 'the holder is named by pid and start time')
    assert.throws(() => withEditsLock(file, () => 'ran', { folder: locks, waitMs: 300 }), /Another TalkWeaver window is saving these edits/)
    const t0 = Date.now()
    assert.equal(withEditsLock(file, () => 'ran', { folder: locks, waitMs: 5000 }), 'ran')
    assert.ok(Date.now() - t0 > 300, 'waited for the holder')
    await done(holder)
    pass('a live holder is waited for; past the wait the refusal says another window is saving')
  }
  // ---- 4. Two processes, one edits file, saving at once through the real store ---------------------------
  {
    const folder = join(root, 'vault'); mkdirSync(folder)
    const path = join(folder, 'run-1.edits.json')
    const seen = join(root, 'seen')
    const worker = (k) => node(`
      import { createRecordingEditsStore } from './src/main/recording-edits-store.ts'
      const [path, locks, seen, k, start] = process.argv.slice(1)
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      while (Date.now() < Number(start)) sleep(2)
      const loc = { path, runId: 'run-1', durationMs: 600000, fingerprint: 'fp' }
      const store = createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'This Mac', app: '0.45.0' }), seenDir: () => seen, lockFolder: locks })
      let s = store.get({})
      const out = []
      for (let i = 0; i < 25; i++) {
        const at = (Number(k) * 100 + i) * 1000
        try { s = store.apply({}, { kind: 'cut', ranges: [{ start: at, end: at + 100 }] }, s.edits.revision, s.digest); out.push({ at, notice: s.notice?.kind ?? null, digest: s.digest }) }
        catch (e) { out.push({ at, error: String(e.message) }) }
        sleep(3 + Number(k))
      }
      console.log(JSON.stringify(out))
    `, [path, locks, seen, String(k), String(start)])
    // Both start their saves at the same moment, well after both have loaded.
    const start = Date.now() + 1500
    const [a, b] = await Promise.all([done(worker(1)), done(worker(2))])
    assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err)
    const runs = [JSON.parse(a.out), JSON.parse(b.out)]
    const errors = runs.flat().filter((r) => r.error)
    assert.deepEqual(errors, [], 'no save failed')
    // Every save survives by content: each process applies every cut on its own last save, so its last save holds
    // all of its cuts. That save is the edits file, or a listed copy that opens (the other process saved over it,
    // and it was captured), or grown into by one: named in `earlier` by a file that holds every one of those cuts.
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'run-1', durationMs: 600000, fingerprint: 'fp' }), lockFolder: locks })
    const now = readFileSync(path, 'utf8')
    const listed = store.listKept({})
    const kept = listed.map((k) => ({ file: k.file, edits: store.openKept({}, k.id).edits, text: readFileSync(join(folder, k.file), 'utf8') }))
    assert.equal(kept.length, readdirSync(folder).filter((f) => f !== 'run-1.edits.json' && !f.startsWith('.')).length, 'every copy beside the file is listed, and opens')
    const versions = [{ text: now, edits: JSON.parse(now) }, ...kept]
    for (const [k, run] of runs.entries()) {
      const mine = run.map((r) => r.at)
      const holds = (e) => mine.every((at) => e.cuts.some((x) => x.start === at))
      const last = run.at(-1).digest
      const found = versions.find((v) => (editsDigest(v.text) === last || earlierOf(JSON.parse(v.text)).includes(last)) && holds(v.edits))
      assert.ok(found, `process ${k + 1}'s ${mine.length} cuts are all in the edits file or in one listed copy that opens`)
    }
    // No save is unaccounted for: each one's exact bytes are the edits file, a listed copy or this Mac's previous save,
    // or (R1a) a later ordinary save was made from it and superseded it: a version still present names it as one it
    // grew from (`earlier`; test bookkeeping only, the store itself compares bytes).
    const present = new Set(versions.map((v) => editsDigest(v.text)))
    const record = JSON.parse(readFileSync(join(seen, readdirSync(seen).find((f) => f.endsWith('.json'))), 'utf8'))
    const prevText = record.previous ? Buffer.from(record.previous, 'base64').toString('utf8') : null
    if (prevText) present.add(editsDigest(prevText))
    const grownFrom = new Set([...versions.map((v) => v.text), ...(prevText ? [prevText] : [])].flatMap((t) => earlierOf(JSON.parse(t))))
    const unaccounted = runs.flat().filter((r) => !present.has(r.digest) && !grownFrom.has(r.digest))
    assert.deepEqual(unaccounted, [], 'every save is present byte for byte, or a later save was made from it')
    const notices = runs.flat().filter((r) => r.notice === 'changed').length
    assert.equal(kept.length, notices, 'a copy is kept exactly when a save was made over the other process\'s version (and the owner told); ordinary saves keep none')
    assert.ok(notices > 0, `the two processes did interleave, and each was told when it saved over the other's version (${notices} notices)`)
    pass(`two processes, 25 saves each at once: none failed, none lost; ${kept.length} versions kept as copies, each with a notice; ${runs.flat().length - notices} ordinary saves kept none`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
