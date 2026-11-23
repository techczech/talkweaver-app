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
const done = (child) => new Promise((r) => { let out = '', err = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d)); child.on('close', (code) => r({ code, out, err })) })

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
    const finished = done(holder)
    await new Promise((r) => holder.stdout.once('data', r))
    assert.ok(existsSync(lockPathFor(file, locks)))
    const held = JSON.parse(readFileSync(lockPathFor(file, locks), 'utf8'))
    assert.equal(held.pid, holder.pid); assert.equal(held.started, processStarted(holder.pid), 'the holder is named by pid and start time')
    assert.throws(() => withEditsLock(file, () => 'ran', { folder: locks, waitMs: 300 }), /Another TalkWeaver window is saving these edits/)
    const t0 = Date.now()
    assert.equal(withEditsLock(file, () => 'ran', { folder: locks, waitMs: 5000 }), 'ran')
    assert.ok(Date.now() - t0 > 300, 'waited for the holder')
    await finished
    pass('a live holder is waited for; past the wait the refusal says another window is saving')
  }
  // One real writer holds the lock past the second writer's first deadline.
  {
    const folder = join(root, 'retry'); mkdirSync(folder)
    const path = join(folder, 'run-1.edits.json'), release = join(root, 'release')
    const seen = join(folder, 'seen')
    const loc = { path, runId: 'run-1', durationMs: 6000, fingerprint: 'fp' }
    const store = createRecordingEditsStore({ locate: () => loc, lockFolder: locks, seenDir: () => seen })
    const base = store.get({})
    const first = node(`
      import { existsSync } from 'node:fs'
      import { createRecordingEditsStore } from './src/main/recording-edits-store.ts'
      const [raw, locks, seen, release] = process.argv.slice(1)
      const loc = JSON.parse(raw)
      const store = createRecordingEditsStore({
        locate: () => loc, lockFolder: locks, seenDir: () => seen,
        io: { at(step) {
          if (step !== 'recorded') return
          console.log('held')
          const until = Date.now() + 30_000
          while (!existsSync(release)) {
            if (Date.now() > until) throw Error('No release from competing editor')
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
          }
        } },
      })
      const snapshot = store.apply({}, { kind:'cut', ranges:[{ start:1000, end:1100 }] }, 0, null)
      console.log(snapshot.edits.revision)
    `, [JSON.stringify(loc), locks, seen, release])
    const finished = done(first)
    await Promise.race([
      new Promise(resolve => first.stdout.once('data', resolve)),
      finished.then(result => { throw Error(`First writer never acquired the lock: ${result.err}`) }),
    ])
    const saveSecond = () => store.apply({}, { kind: 'cut', ranges: [{ start: 2000, end: 2100 }] }, base.edits.revision, base.digest)
    assert.throws(saveSecond, /Another TalkWeaver window is saving these edits/)
    assert.equal(existsSync(path), false, 'the refused save writes nothing while the first writer is staged')
    writeFileSync(release, 'release')
    const firstResult = await finished
    assert.equal(firstResult.code, 0, firstResult.err)
    assert.match(firstResult.out, /^held\s+1\s*$/)
    const second = saveSecond()
    assert.equal(second.edits.revision, 2, 'the explicit retry lands after the first save')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).cuts, [{ start: 2000, end: 2100 }])
    assert.equal(second.notice?.kind, 'changed')
    const copies = store.listKept({}).map(k => store.openKept({}, k.id).edits.cuts)
    assert.ok(copies.some(cuts => cuts.some(c => c.start === 1000 && c.end === 1100)), 'the first save is kept and opens')
    pass('two writers: the retry follows the first durable save and both edits survive')
  }
  // ---- Two processes, one edits file, saving at once through the real store ---------------------------
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
        const op = { kind: 'cut', ranges: [{ start: at, end: at + 100 }] }
        const deadline = Date.now() + 12_000
        for (;;) {
          try {
            s = store.apply({}, op, s.edits.revision, s.digest)
            out.push({ at, notice: s.notice?.kind ?? null, digest: s.digest, revision: s.edits.revision })
            break
          } catch (error) {
            // A busy machine may require the person to choose Retry. Keep this test's operation and
            // base until it lands, and fail if it cannot land within the bounded retry window.
            if (/Another TalkWeaver window is saving these edits/.test(error.message) && Date.now() < deadline) continue
            out.push({ at, error: String(error.message) })
            break
          }
        }
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
    for (const run of runs) {
      assert.equal(run.length, 25)
      assert.ok(run.every((save, i) => i === 0 || save.revision > run[i - 1].revision), 'each writer’s cuts land in its requested order')
    }
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
