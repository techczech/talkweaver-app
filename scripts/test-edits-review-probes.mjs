// 0.45, second Mac: the four ways the review of 207ebaac lost or hid an edits version, as regression tests. Each
// fails on 207ebaac's store and passes on the simplified one (recording-edits-store.ts, rules R1 to R5).
//   1. After the link, a sync renames another version over the edits file: the save reported success, then the
//      store removed its temporary file and the version it replaced; with a kill before the record, the save
//      existed nowhere.
//   2. Two interrupted saves and no edits file: recovery took them in folder order and made an unfinished save
//      current; it must restore the most recently captured version, and list the unfinished ones.
//   3. A copy whose "version" is not its first field, beyond the newest 40: left out of the list; and a save then
//      removed the newly captured duplicate of it, leaving the unlisted file the only holder.
//   4. An older release's save without this Mac's restored trim was judged to hold this Mac's edits: no copy, no
//      notice, the restoration lost.
//   5. (R1a) A run of ordinary saves on one Mac: no copy in the vault, one "Previous save on this Mac" row, which
//      opens and restores (a restore keeps what it replaces as a vault copy).
//   7. (R1a) Two windows on one Mac (one record): a save made from other edits never removes the version it did not
//      grow from, even when that is exactly this Mac's settled record.
//   6. (R1a) At every point of an install, a divergent version arrives at the edits file: it survives at the edits
//      file or in a listed vault copy, and the only file the store ever removes is a capture byte-identical to what
//      this Mac last saved or saw there, removed only once the record holds it durably as `previous`.
// TW_EDITS_STORE names another store module (relative to this file) to run the probes against, e.g. 207ebaac's.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyEdits } from '../src/shared/recording-edits.ts'
// Every removal the store makes, seen at the instant before it happens (probe 6).
const realUnlink = fs.unlinkSync
let onUnlink = null
fs.unlinkSync = (p) => { onUnlink?.(String(p)); return realUnlink(p) }
syncBuiltinESMExports()

const { createRecordingEditsStore, serialiseEditsFile } = await import(process.env.TW_EDITS_STORE ?? '../src/main/recording-edits-store.ts')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-edits-probes-')))
const D = 600_000, FP = 'talk/run-1@2026-11-10T09:00:00.000Z/600000'
const KILL = Error('killed')
let c = 0, failed = 0
const place = (runTrims = []) => { const dir = join(root, `c${c++}`); mkdirSync(dir, { recursive: true }); return { path: join(dir, 'run-1.edits.json'), runId: 'run-1', durationMs: D, fingerprint: FP, context: { runTrims } } }
const dirOf = (loc) => join(loc.path, '..')
const seenOf = (loc, name) => join(dirOf(loc), '..', `${loc.path.split('/').at(-2)}-${name}-seen`)
const mac = (loc, name, extra = {}) => createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: name, app: '0.45.0' }), seenDir: () => seenOf(loc, name), lockFolder: join(root, `locks-${name}`), ...extra })
/** A Mac's record of the edits file (app data): settled, pending and previous, as exact bytes. */
const recordOf = (loc, name) => { try { const r = JSON.parse(readFileSync(join(seenOf(loc, name), `${createHash('sha256').update(loc.path).digest('hex').slice(0, 32)}.json`), 'utf8')); const b = (x) => (typeof x === 'string' ? Buffer.from(x, 'base64') : null); return { settled: b(r.settled), pending: b(r.pending), previous: b(r.previous) } } catch { return { settled: null, pending: null, previous: null } } }
/** Files beside the edits file other than it (copies and temporary files). */
const vaultCopies = (loc) => readdirSync(dirOf(loc)).filter((f) => f !== 'run-1.edits.json')
const cut = (at) => ({ kind: 'cut', ranges: [{ start: at, end: at + 500 }] })
const syncPuts = (path, bytes) => { const t = `${path}.sync-${Math.random().toString(36).slice(2)}`; writeFileSync(t, bytes); renameSync(t, path) }
const othersFile = (at) => Buffer.from(serialiseEditsFile({ ...emptyEdits(), revision: 9, recording: FP, cuts: [{ start: at, end: at + 700 }] }, { mac: 'Other Mac', app: '0.45.0', at: '2026-11-15T09:00:00.000Z' }, []))
/** Every listed row's bytes: each vault copy (a row, or a row's identical copies), and this Mac's previous save (from its record). */
const listedBytes = (store, loc, name = 'B') => store.listKept({}).flatMap((k) => (k.local ? [{ file: k.id, bytes: recordOf(loc, name).previous }] : [k.file, ...(k.same ?? [])].map((file) => ({ file, bytes: readFileSync(join(dirOf(loc), file)) })))).filter((x, i, all) => all.findIndex((y) => y.file === x.file) === i)
const heldBy = (store, loc, test) => (existsSync(loc.path) && test(readFileSync(loc.path))) || listedBytes(store, loc).some((k) => test(k.bytes))
const cutsOf = (bytes) => { try { return JSON.parse(bytes.toString('utf8')).cuts.map((x) => x.start) } catch { return null } }
const probe = (name, fn) => { try { fn(); console.log(`PASS ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`) } }

try {
  probe('1. a sync renames another version over the edits file just after the link: the save and the version it replaced are kept (with and without a kill before the record settles)', () => {
    for (const kill of [false, true]) {
      const loc = place()
      const B = mac(loc, 'B')
      let s = B.get({})
      s = B.apply({}, cut(1000), s.edits.revision, s.digest)
      const A = readFileSync(loc.path)
      const C = othersFile(50_000)
      let armed = false
      const dying = mac(loc, 'B', { io: { beforeLink: () => { armed = true }, flushFolder: () => { if (!armed) return; armed = false; syncPuts(loc.path, C); if (kill) throw KILL } } })
      const t = dying.get({})
      try { dying.apply({}, cut(2000), t.edits.revision, t.digest) } catch (e) { if (e !== KILL) throw e }
      // The next open on the same Mac.
      const next = mac(loc, 'B')
      const opened = next.get({})
      assert.ok(heldBy(next, loc, (b) => { const k = cutsOf(b); return !!k && k.includes(1000) && k.includes(2000) }), `kill ${kill}: the save (cuts 1000 and 2000) is at the edits file or a listed copy`)
      assert.ok(heldBy(next, loc, (b) => b.equals(A)), `kill ${kill}: the version it replaced is at the edits file or a listed copy`)
      assert.ok(heldBy(next, loc, (b) => b.equals(C)), `kill ${kill}: and the sync's version`)
      assert.ok(opened.notice, `kill ${kill}: the owner is told`)
    }
  })

  probe('2. no edits file and two interrupted saves: the most recently captured version goes back; the unfinished saves are listed, never made current', () => {
    const loc = place()
    const X1 = othersFile(1000), X2 = othersFile(2000), T1 = othersFile(3000), T2 = othersFile(4000)
    const id1 = '00000000-0000-4000-8000-000000000001', id2 = 'ffffffff-0000-4000-8000-000000000002'
    writeFileSync(join(dirOf(loc), `run-1.edits.changed-2026-11-15T09-00-00-000Z-${id1}.json`), X1)
    writeFileSync(join(dirOf(loc), `.run-1.edits.${id1}.tmp`), T1)
    writeFileSync(join(dirOf(loc), `run-1.edits.changed-2026-11-15T10-00-00-000Z-${id2}.json`), X2)
    writeFileSync(join(dirOf(loc), `.run-1.edits.${id2}.tmp`), T2)
    const B = mac(loc, 'B')
    const opened = B.get({})
    assert.ok(readFileSync(loc.path).equals(X2), `the most recently captured version is the edits (got cuts ${cutsOf(readFileSync(loc.path))})`)
    for (const [b, why] of [[X1, 'the older capture'], [T1, 'the older unfinished save'], [T2, 'the newer unfinished save']]) assert.ok(listedBytes(B, loc).some((k) => k.bytes.equals(b)), `${why} is a listed copy`)
    assert.ok([opened.notice, opened.also, ...(opened.more ?? [])].some((n) => n?.kind === 'interrupted'), 'the owner is told a save did not finish')
  })

  probe('3. a copy whose details are not at its start, beyond the newest 40, is listed; a save never removes the copy it captured in favour of an unlisted one', () => {
    const loc = place()
    for (let i = 0; i < 41; i++) {
      const name = `run-1.edits.changed-2026-11-14T00-00-00-000Z-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.json`
      writeFileSync(join(dirOf(loc), name), othersFile(10_000 + i * 1000))
    }
    const V = Buffer.from(JSON.stringify({ note: 'n'.repeat(3000), ...JSON.parse(serialiseEditsFile({ ...emptyEdits(), revision: 3, recording: FP, cuts: [{ start: 7000, end: 9000 }] }, null, [])) }))
    const sync = join(dirOf(loc), 'run-1.edits (Old Mac’s conflicted copy).json')
    writeFileSync(sync, V); utimesSync(sync, new Date('2026-10-01'), new Date('2026-10-01'))
    const B = mac(loc, 'B')
    assert.ok(B.listKept({}).some((k) => k.file === 'run-1.edits (Old Mac’s conflicted copy).json'), 'the sync copy is listed')
    // The same bytes at the edits file; a save captures them.
    writeFileSync(loc.path, V)
    const s = B.get({})
    B.apply({}, cut(20_000), s.edits.revision, s.digest)
    const holders = listedBytes(B, loc).filter((k) => k.bytes.equals(V)).map((k) => k.file)
    assert.ok(holders.length >= 1 && holders.some((f) => f !== 'run-1.edits (Old Mac’s conflicted copy).json'), `the captured version is a listed copy of its own (listed holders: ${holders.join(', ') || 'none'})`)
  })

  probe('4. an older release saves over this Mac’s edits without its restored trim: this Mac’s version is kept, and the owner told', () => {
    const loc = place([{ start: 100_000, end: 110_000 }])
    writeFileSync(loc.path, serialiseEditsFile({ ...emptyEdits(), revision: 1, recording: FP, restoredTrims: [{ start: 102_000, end: 104_000 }] }, null, []))
    const B = mac(loc, 'B')
    let s = B.get({})
    s = B.apply({}, cut(1000), s.edits.revision, s.digest)
    const mine = readFileSync(loc.path)
    // What 0.44.5 writes when it drops the restoration: no savedBy or earlier, our state one more undo step, one more cut.
    const raw = JSON.parse(mine.toString('utf8'))
    const { savedBy: _s, earlier: _e, ...rest } = raw
    const theirs = { ...rest, revision: raw.revision + 1, restoredTrims: [], cuts: [...raw.cuts, { start: 300_000, end: 300_500 }], undo: [...raw.undo, { cuts: raw.cuts, boundaries: raw.boundaries, leftOut: raw.leftOut, finish: raw.finish, faces: raw.faces, takes: raw.takes }], redo: [] }
    syncPuts(loc.path, Buffer.from(JSON.stringify(theirs)))
    const back = B.get({})
    assert.ok(listedBytes(B, loc).some((k) => k.bytes.equals(mine)), 'this Mac’s version, with its restored trim, is a listed copy, byte for byte')
    assert.equal(back.notice?.kind, 'replaced', 'and the owner is told')
  })

  probe('5. (R1a) 100 ordinary saves on one Mac leave no copy in the vault and one "Previous save on this Mac", which opens and restores', () => {
    const loc = place()
    const B = mac(loc, 'B')
    let s = B.get({})
    const saves = []
    for (let i = 0; i < 100; i++) { s = B.apply({}, cut(1000 + i * 1000), s.edits.revision, s.digest); saves.push(readFileSync(loc.path)) }
    assert.deepEqual(vaultCopies(loc), [], '100 ordinary saves: nothing beside the edits file')
    const list = B.listKept({})
    assert.deepEqual(list.map((k) => k.reason), ['previous-save'], 'Kept edits lists one row: the previous save on this Mac')
    assert.ok(recordOf(loc, 'B').previous.equals(saves[98]), 'and it is the save before the current one, byte for byte')
    assert.equal(s.keptCount, 1, 'the editor is told there is one row to show')
    assert.equal(B.openKept({}, list[0].id).edits.cuts.length, 99, 'it opens')
    // Reopened (a fresh store on the same record): nothing to tell, the row still there.
    const again = mac(loc, 'B').get({})
    assert.equal(again.notice, undefined); assert.equal(again.keptCount, 1)
    // A restore is not an ordinary save: the edits it replaces are kept as a vault copy, as for any restore.
    const back = B.restoreKept({}, list[0].id)
    assert.equal(back.edits.cuts.length, 99, 'it restores')
    assert.equal(back.notice?.kind, 'restored')
    assert.ok(readFileSync(join(dirOf(loc), back.notice.copy)).equals(saves[99]), 'and the save it replaced is a listed vault copy')
    assert.ok(recordOf(loc, 'B').previous.equals(saves[98]), 'the previous save is unchanged')
  })

  probe('6. (R1a) a divergent version arriving at any point of an install survives at the edits file or in a listed vault copy; only own-identical captures are removed, after the record holds them', () => {
    const POINTS = ['before-check', 'after-check', 'recorded', 'temp', 'moved', 'linked', 'settled', 'released']
    for (const point of POINTS) for (const how of ['rename', 'write']) {
      const loc = place()
      const B = mac(loc, 'B')
      let s = B.get({})
      s = B.apply({}, cut(1000), s.edits.revision, s.digest)
      const mine = recordOf(loc, 'B').settled
      const X = othersFile(70_000)
      let armed = true
      const fire = (at) => { if (!armed || at !== point) return; armed = false; if (how === 'rename') syncPuts(loc.path, X); else writeFileSync(loc.path, X) }
      const removed = [], bad = []
      onUnlink = (p) => {
        const f = p.split('/').at(-1)
        if (!p.startsWith(dirOf(loc)) || f.startsWith('.') || f === 'run-1.edits.json') return
        // Recorded, not thrown: the store treats a failed removal as "leave it listed", so a throw would hide the fault.
        const bytes = readFileSync(p), rec = recordOf(loc, 'B')
        removed.push(f)
        if (!bytes.equals(mine)) bad.push(`${point}/${how}: the store removed ${f}, which is not this Mac's own last save`)
        if (!(rec.previous?.equals(bytes) && rec.pending === null)) bad.push(`${point}/${how}: ${f} removed before the record held it as previous`)
      }
      const S = mac(loc, 'B', { beforeRename: () => fire('before-check'), beforeInstall: () => fire('after-check'), io: { at: fire, beforeLink: () => fire('moved') } })
      const t = S.get({})
      try { S.apply({}, cut(2000), t.edits.revision, t.digest) } finally { onUnlink = null }
      assert.deepEqual(bad, [])
      const inVault = (b) => (existsSync(loc.path) && readFileSync(loc.path).equals(b)) || vaultCopies(loc).some((f) => !f.startsWith('.') && readFileSync(join(dirOf(loc), f)).equals(b))
      assert.ok(inVault(X), `${point}/${how}: the arrival is at the edits file or a vault copy`)
      assert.ok(B.listKept({}).some((k) => !k.local && readFileSync(join(dirOf(loc), k.file)).equals(X)) || readFileSync(loc.path).equals(X), `${point}/${how}: and listed when it is a copy`)
      const after = mac(loc, 'B').get({})
      assert.ok(inVault(X), `${point}/${how}: and after the next open`)
      assert.ok(heldBy(B, loc, (b) => b.equals(mine)), `${point}/${how}: this Mac's own last save is at the edits file, a vault copy, or its previous save`)
      assert.ok(heldBy(B, loc, (b) => { const k = cutsOf(b); return !!k && k.includes(1000) && k.includes(2000) }), `${point}/${how}: the save itself is held`)
      assert.ok(removed.length <= 1, `${point}/${how}: at most the one own capture removed (${removed.join(', ')})`)
      if (point === 'released') assert.equal(removed.length, 1, 'an arrival after the removal cannot stop the own capture going')
      void after
    }
  })

  probe('7. (R1a) two windows on one Mac: a save from the other window\'s edits keeps the version it did not grow from as a listed copy, and says so', () => {
    const loc = place()
    const W1 = mac(loc, 'B'), W2 = mac(loc, 'B')
    let a = W1.get({}), b = W2.get({})
    a = W1.apply({}, cut(1000), a.edits.revision, a.digest)
    const w1save = readFileSync(loc.path)
    // W2 still shows the edits from before W1's save; W1's save is now this Mac's settled record.
    b = W2.apply({}, cut(5000), b.edits.revision, b.digest)
    assert.equal(b.notice?.kind, 'changed', 'the owner is told')
    assert.ok(readFileSync(join(dirOf(loc), b.notice.copy)).equals(w1save), 'W1\'s save is a listed vault copy, byte for byte')
    assert.ok(listedBytes(W2, loc).some((k) => k.bytes.equals(w1save)))
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
if (failed) { console.log(`${failed} of 7 probes failed`); process.exitCode = 1 } else console.log('7 of 7 probes pass')
