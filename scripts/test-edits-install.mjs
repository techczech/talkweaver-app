// 0.45, second Mac: the edits file's install protocol (src/main/recording-edits-store.ts, top of file). Every
// byte sequence that was ever at the edits file is, at every instant, at that name or in a listed copy:
//   1. A file a sync tool puts at the edits file after the final check, and one that arrives between moving the
//      file aside and installing the new one, are captured and kept, byte for byte (the reviewer's regression).
//   2. A process killed at each step of the install leaves every version at the edits file or in a listed copy,
//      and the next open does what the store's kill table says (never "no edits"; never an unfinished save made
//      current). TW_MATRIX=1 prints the table.
//   3. Bytes, not decoded text: a file that is not valid UTF-8 is kept exactly; ff and fe hash apart.
//   4. Two Macs keeping a copy in the same millisecond, offline, then merged into one folder: no name taken twice.
//   5. Listing 500 copies reads only the newest whole (the rest when opened); every one is listed, wherever its
//      details sit; identical copies are one row.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRecordingEditsStore, editsDigest, serialiseEditsFile } from '../src/main/recording-edits-store.ts'
import { emptyEdits } from '../src/shared/recording-edits.ts'

const repo = resolve(import.meta.dirname, '..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-edits-install-')))
const D = 600_000, FP = 'talk/run-1@2026-11-10T09:00:00.000Z/600000'
let n = 0, c = 0
const pass = (name) => console.log(`PASS ${++n} ${name}`)
const cut = (at) => ({ kind: 'cut', ranges: [{ start: at, end: at + 500 }] })
const place = (name = `c${c++}`) => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); return { path: join(dir, 'run-1.edits.json'), runId: 'run-1', durationMs: D, fingerprint: FP, context: { runTrims: [] } } }
const dirOf = (loc) => join(loc.path, '..')
const seenOf = (loc) => join(dirOf(loc), '..', `${loc.path.split('/').at(-2)}-seen`)
const storeFor = (loc, extra = {}) => createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'This Mac', app: '0.45.0' }), seenDir: () => seenOf(loc), lockFolder: join(root, 'locks'), ...extra })
/** This Mac's previous save (R1a), from its record in `seen`. */
const previousIn = (seen, loc) => { try { const v = JSON.parse(readFileSync(join(seen, `${createHash('sha256').update(loc.path).digest('hex').slice(0, 32)}.json`), 'utf8')).previous; return typeof v === 'string' ? Buffer.from(v, 'base64') : null } catch { return null } }
/** Another Mac's whole edits file with cut `at` (valid for this recording). */
const othersFile = (at, mac = 'Other Mac') => Buffer.from(serialiseEditsFile({ ...emptyEdits(), revision: 9, recording: FP, cuts: [{ start: at, end: at + 700 }] }, { mac, app: '0.45.0', at: '2026-11-15T09:00:00.000Z' }, []))
/** What a sync tool does: the whole new file under a temporary name, then renamed over the edits file. */
const syncPuts = (path, bytes) => { const t = `${path}.sync-${Math.random().toString(36).slice(2)}`; writeFileSync(t, bytes); renameSync(t, path) }
/** Every listed row's exact bytes (Git sides too; this Mac's previous save from its record), and whether it opens. */
function listed(store, loc, seen = seenOf(loc)) {
  return store.listKept({}).map((k) => {
    let opens = false
    try { store.openKept({}, k.id); opens = true } catch { /* does not open */ }
    return { ...k, bytes: k.side ? null : k.local ? previousIn(seen, loc) : readFileSync(join(dirOf(loc), k.file)), opens }
  })
}
const presentAt = (store, loc, bytes, seen) => (existsSync(loc.path) && readFileSync(loc.path).equals(bytes)) || listed(store, loc, seen).some((k) => k.bytes?.equals(bytes))
/** Where a version is: at the edits file, in a vault copy, in this Mac's previous save. */
const whereIs = (loc, bytes, seen) => [existsSync(loc.path) && readFileSync(loc.path).equals(bytes) ? 'edits file' : null,
  readdirSync(dirOf(loc)).some((f) => f !== 'run-1.edits.json' && !f.startsWith('.') && readFileSync(join(dirOf(loc), f)).equals(bytes)) ? 'vault copy' : null,
  previousIn(seen, loc)?.equals(bytes) ? 'previous save' : null].filter(Boolean)

try {
  // ---- 1. Arrivals at the true boundary -----------------------------------------------------------------
  for (const action of ['apply', 'restore']) {
    // The reviewer's regression: a valid edits file put there by a sync immediately before the move and install.
    const loc = place()
    let inject = null
    const store = storeFor(loc, { beforeInstall: () => { const f = inject; inject = null; f?.() } })
    let s = store.get({})
    s = store.apply({}, cut(1000), s.edits.revision, s.digest)
    const kept = action === 'restore' ? (() => { const k = othersFile(90_000, 'Old Mac'); writeFileSync(join(dirOf(loc), 'run-1.edits.kept-2026-11-01T10-00-00-000Z.json'), k); return 'run-1.edits.kept-2026-11-01T10-00-00-000Z.json' })() : null
    const arrival = othersFile(50_000)
    inject = () => syncPuts(loc.path, arrival)
    const done = action === 'apply' ? store.apply({}, cut(2000), s.edits.revision, s.digest) : store.restoreKept({}, kept)
    assert.equal(done.notice.kind, action === 'apply' ? 'changed' : 'restored', `${action}: the owner is told`)
    assert.ok(readFileSync(join(dirOf(loc), done.notice.copy)).equals(arrival), `${action}: the arrival is kept byte for byte, under the name the notice gives`)
    assert.ok(listed(store, loc).some((k) => k.file === done.notice.copy && k.opens), `${action}: and is listed, and opens`)
    if (action === 'apply') assert.ok(JSON.parse(readFileSync(loc.path, 'utf8')).cuts.some((x) => x.start === 2000), 'the save itself went through')
    assert.ok(readdirSync(dirOf(loc)).every((f) => !f.endsWith('.tmp')), `${action}: no temporary file left`)
  }
  {
    // Between moving the file aside and installing: the arrival takes the name, the link fails, the arrival is captured too.
    const loc = place()
    let inject = null
    const store = storeFor(loc, { io: { beforeLink: () => { const f = inject; inject = null; f?.() } } })
    let s = store.get({})
    s = store.apply({}, cut(1000), s.edits.revision, s.digest)
    const own = readFileSync(loc.path)
    const arrival = othersFile(60_000)
    inject = () => writeFileSync(loc.path, arrival)
    const done = store.apply({}, cut(2000), s.edits.revision, s.digest)
    assert.equal(done.notice?.kind, 'changed')
    assert.ok(readFileSync(join(dirOf(loc), done.notice.copy)).equals(arrival), 'the arrival between the move and the install is kept byte for byte')
    assert.deepEqual(readdirSync(dirOf(loc)).filter((f) => f.startsWith('run-1.edits.') && f !== 'run-1.edits.json'), [done.notice.copy], 'the arrival is the one copy in the vault')
    assert.ok(previousIn(seenOf(loc), loc)?.equals(own), 'the version the save grew from (this Mac\'s own) is its previous save (R1a)')
    // Something that keeps arriving: the save gives up, and every arrival is at the edits file or listed.
    const arrivals = []
    let i = 0
    const busy = storeFor(loc, { io: { beforeLink: () => { const b = othersFile(100_000 + 1000 * i++); arrivals.push(b); writeFileSync(loc.path, b) } } })
    const now = busy.get({})
    assert.throws(() => busy.apply({}, cut(3000), now.edits.revision, now.digest), /kept being replaced/)
    for (const b of arrivals) assert.ok(presentAt(busy, loc, b), 'every arrival is at the edits file or a listed copy')
    assert.ok(presentAt(busy, loc, readFileSync(loc.path)))
    // The save that gave up left its temporary file (nothing is removed on a failure); the next open lists it and says so.
    const next = storeFor(loc).get({})
    assert.equal(next.notice?.kind, 'interrupted')
    assert.ok(readdirSync(dirOf(loc)).every((f) => !f.endsWith('.tmp')), 'and no temporary file is left after it')
    for (const b of arrivals) assert.ok(presentAt(busy, loc, b), 'every arrival is still at the edits file or a listed copy')
  }
  pass('a file a sync puts at the edits file after the final check, or between the move and the install, is kept byte for byte, listed, and the owner told (save and restore)')

  // ---- 2. A process killed at each step of the install (the kill table at the top of the store) -------------
  // Each: a real process saves one more cut (2000) over a file holding cut 1000 and is killed (SIGKILL) at the step.
  // after-settle: the record holds the new bytes settled and the replaced save (this Mac's own) as previous, durably;
  // the capture is still in the vault. after-release: the capture is removed (R1a), its bytes only in previous.
  const STEPS = ['before-check', 'after-check', 'after-record', 'after-temp', 'after-move', 'link-cut-short', 'after-link', 'after-settle', 'after-release']
  const table = []
  for (const step of STEPS) {
    const loc = place(`crash-${step}`)
    const seen = join(root, `crash-${step}-seen`)
    const store = storeFor(loc, { seenDir: () => seen })
    let s = store.get({})
    s = store.apply({}, cut(1000), s.edits.revision, s.digest)
    const old = readFileSync(loc.path)
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', `
      import { writeSync } from 'node:fs'
      import { createRecordingEditsStore } from './src/main/recording-edits-store.ts'
      const [path, step, locks, seen] = process.argv.slice(1)
      const die = () => process.kill(process.pid, 'SIGKILL')
      let writes = 0
      const at = { 'after-record': 'recorded', 'after-temp': 'temp', 'after-move': 'moved', 'after-link': 'linked', 'after-settle': 'settled', 'after-release': 'released' }[step]
      const io = {
        at: (s) => { if (s === at) die() },
        ...(step === 'link-cut-short' ? { link: () => { throw Object.assign(Error('ENOTSUP'), { code: 'ENOTSUP' }) }, write: (fd, b, off) => { if (++writes === 2) { writeSync(fd, b, off, Math.floor((b.length - off) / 2)); die() } return writeSync(fd, b, off, b.length - off) } } : {})
      }
      const loc = { path, runId: 'run-1', durationMs: ${D}, fingerprint: '${FP}', context: { runTrims: [] } }
      const store = createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'This Mac', app: '0.45.0' }), lockFolder: locks, seenDir: () => seen, io,
        beforeRename: () => { if (step === 'before-check') die() }, beforeInstall: () => { if (step === 'after-check') die() } })
      const s = store.get({})
      store.apply({}, { kind: 'cut', ranges: [{ start: 2000, end: 2500 }] }, s.edits.revision, s.digest)
    `, loc.path, step, join(root, 'locks'), seen], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    const exit = await new Promise((r) => { let err = ''; child.stderr.on('data', (d) => (err += d)); child.on('exit', (code, signal) => r({ code, signal, err })) })
    assert.equal(exit.signal, 'SIGKILL', `${step}: the process was killed at the step (${exit.err})`)
    const reader = storeFor(loc, { seenDir: () => seen })
    // At the instant of the crash: the version that was there is at the edits file or in a listed copy (by bytes).
    assert.ok(presentAt(reader, loc, old, seen), `${step}: the earlier version is at the edits file or in a listed copy`)
    // A plain read (export) never says "no edits" for a save that did not finish.
    let plain = null, plainError = null
    try { plain = reader.read({}) } catch (e) { plainError = String(e.message) }
    if (!existsSync(loc.path)) assert.match(plainError ?? '', /did not finish/, `${step}: no edits file beside an unfinished save: a plain read refuses, clearly`)
    // The next open.
    const after = reader.get({})
    const cuts = after.edits.cuts.map((x) => x.start)
    const saved = (b) => JSON.parse(b.toString()).cuts?.some((x) => x.start === 2000) && JSON.parse(b.toString()).cuts?.some((x) => x.start === 1000)
    const atKill = whereIs(loc, old, seen)
    const copies = listed(reader, loc, seen)
    const newInCopy = copies.find((k) => k.bytes && (() => { try { return saved(k.bytes) } catch { return false } })())
    const notices = [after.notice, after.also, ...(after.more ?? [])].filter(Boolean)
    const outcome = after.problem ? `problem: ${after.problem.kind}` : `cuts ${cuts.join(', ')}`
    table.push(`| ${step} | ${atKill.join(' + ')} | ${whereIs(loc, old, seen).join(' + ')} | ${outcome} | ${notices.map((n) => n.kind + (n.restored ? ' (restored)' : '')).join(', ') || 'none'} | ${newInCopy ? 'yes' : '—'} |`)
    assert.ok(atKill.length > 0, `${step}: at the kill, cut 1000 is somewhere (${atKill})`)
    if (plain && !plain.problem) assert.deepEqual(plain.edits.cuts, JSON.parse(readFileSync(loc.path, 'utf8')).cuts, `${step}: a plain read reads the file in place`)
    assert.ok(presentAt(reader, loc, old, seen), `${step}: and after the next open`)
    if (step === 'before-check' || step === 'after-check') {
      assert.deepEqual(cuts, [1000], `${step}: untouched`); assert.equal(notices.length, 0, `${step}: nothing to tell`)
    } else if (step === 'after-record' || step === 'after-temp') {
      assert.deepEqual(cuts, [1000], `${step}: the file was never moved, so it stays`)
      assert.equal(after.notice?.kind, 'interrupted', `${step}: the owner is told a save did not finish`)
      assert.ok(newInCopy?.opens, `${step}: what it was saving is a listed copy that opens`)
      assert.ok(copies.some((k) => k.file === after.notice.copy), `${step}: the notice names a listed copy`)
    } else if (step === 'after-move') {
      assert.deepEqual(cuts, [1000], `${step}: the version the save moved aside is back (never the unfinished save)`)
      assert.equal(after.notice?.kind, 'interrupted'); assert.equal(after.notice.restored, true)
      assert.ok(newInCopy?.opens, `${step}: the unfinished save is a listed copy that opens`)
    } else if (step === 'link-cut-short') {
      assert.equal(after.problem?.kind, 'corrupt', `${step}: the file cut short is not guessed at: it stays, a stated problem`)
      assert.equal(after.notice?.kind, 'interrupted')
      assert.ok(newInCopy?.opens, `${step}: the whole save is a listed copy that opens`)
      const back = reader.restoreKept({}, newInCopy.id)
      assert.deepEqual(back.edits.cuts.map((x) => x.start), [1000, 2000], `${step}: restoring it brings the save back`)
      assert.ok(listed(reader, loc).some((k) => k.bytes && k.bytes.length < old.length + 200 && k.state === 'unreadable'), `${step}: the file cut short is kept as a listed copy too`)
    } else {
      assert.deepEqual(cuts, [1000, 2000], `${step}: the save is in place`)
      assert.equal(notices.length, 0, `${step}: nothing to tell (the leftover temporary file holds what is in place)`)
      if (step === 'after-settle') assert.deepEqual(atKill, ['vault copy', 'previous save'], `${step}: the replaced save is in both the vault copy and previous (the removal had not happened)`)
      if (step === 'after-release') assert.deepEqual(atKill, ['previous save'], `${step}: the replaced save is in previous only, and listed as the previous save`)
      if (step === 'after-release') assert.ok(copies.some((k) => k.local && k.bytes?.equals(old) && k.opens), `${step}: listed as "Previous save on this Mac", and opens`)
    }
    assert.ok(readdirSync(dirOf(loc)).every((f) => !f.endsWith('.tmp')), `${step}: every leftover temporary file is a listed copy now`)
  }
  {
    // No edits file, two rounds captured by one install and its temporary file not whole (a damaged disk): the most
    // recently captured version (the higher round) goes back; the other capture and the temporary file are listed.
    const loc = place('crash-no-whole-temp')
    const id = '0d911d21-e1e9-4d8f-a0d2-a42968e78a7f'
    const first = othersFile(1000), second = othersFile(2000)
    writeFileSync(join(dirOf(loc), `run-1.edits.before-2026-11-15T09-00-00-000Z-${id}.json`), first)
    writeFileSync(join(dirOf(loc), `run-1.edits.before-2026-11-15T09-00-00-000Z-${id}-2.json`), second)
    writeFileSync(join(dirOf(loc), `.run-1.edits.${id}.tmp`), second.subarray(0, 30))
    const got = storeFor(loc).get({})
    assert.deepEqual(got.edits.cuts.map((x) => x.start), [2000], 'the newest capture is back as the edits')
    assert.ok(readFileSync(join(dirOf(loc), `run-1.edits.before-2026-11-15T09-00-00-000Z-${id}.json`)).equals(first), 'the older capture stays listed')
    assert.ok(!existsSync(join(dirOf(loc), `.run-1.edits.${id}.tmp`)) && listed(storeFor(loc), loc).some((k) => k.bytes?.equals(second.subarray(0, 30))), 'the temporary file is a listed copy')
  }
  if (process.env.TW_MATRIX) console.log(`| killed at | cut 1000 at the kill | cut 1000 after the next open | next open shows | owner told | unfinished save in a listed copy |\n|---|---|---|---|---|---|\n${table.join('\n')}`)
  pass(`a process killed at each step (${STEPS.join(', ')}): every version at the edits file or a listed copy, and the next open does what the kill table says`)

  // ---- 3. Bytes, not text --------------------------------------------------------------------------------
  {
    const loc = place()
    const store = storeFor(loc)
    let s = store.get({})
    s = store.apply({}, cut(1000), s.edits.revision, s.digest)
    const good = readFileSync(loc.path)
    const at = good.indexOf('This Mac') + 1 // inside a string: still JSON-shaped, not UTF-8
    const ff = Buffer.from(good); ff[at] = 0xff
    const fe = Buffer.from(good); fe[at] = 0xfe
    assert.notEqual(editsDigest(ff), editsDigest(fe), 'ff and fe hash apart')
    syncPuts(loc.path, ff)
    const opened = storeFor(loc).get({})
    assert.equal(opened.problem?.kind, 'corrupt', 'a file that is not valid UTF-8 is not read as edits')
    // The editor saves from what it read before: the damaged file is kept exactly, ff and all.
    const saved = store.apply({}, cut(2000), s.edits.revision, s.digest)
    assert.ok(readFileSync(join(dirOf(loc), saved.notice.copy)).equals(ff), 'the copy is the exact bytes (ff, not efbfbd)')
    // fe arrives next: it is a different version, kept on its own.
    syncPuts(loc.path, fe)
    const again = store.apply({}, cut(3000), saved.edits.revision, saved.digest)
    assert.notEqual(again.notice.copy, saved.notice.copy)
    assert.ok(readFileSync(join(dirOf(loc), again.notice.copy)).equals(fe), 'fe is kept too, not taken for ff')
    // Start new edits keeps it exactly as well.
    syncPuts(loc.path, ff)
    const fresh = storeFor(loc).startFresh({})
    assert.ok(readFileSync(fresh.keptAs).equals(ff))
    pass('bytes, not text: a file with invalid UTF-8 is a stated problem and is kept exactly (save and Start new edits); ff and fe are two versions')
  }

  // ---- 4. Two Macs, the same millisecond, offline; then one folder ---------------------------------------
  {
    const at = new Date('2026-11-15T09:00:00.000Z')
    const macs = ['A', 'B'].map((name) => {
      const loc = place(`same-ms-${name}`)
      return { name, loc, store: storeFor(loc, { now: () => at, saver: () => ({ mac: `${name}’s Mac`, app: '0.45.0' }) }) }
    })
    const theirs = []
    for (const m of macs) {
      const { loc, store } = m
      // Changed under the editor (a capture), a restore (a capture), Start new edits, a replaced version on open, an older format.
      let s = store.get({}); s = store.apply({}, cut(1000), s.edits.revision, s.digest)
      syncPuts(loc.path, othersFile(m.name === 'A' ? 10_000 : 20_000, `${m.name} sync`))
      s = store.apply({}, cut(2000), s.edits.revision, s.digest)
      writeFileSync(join(dirOf(loc), 'run-1.edits.kept-2026-11-01T10-00-00-000Z.json'), othersFile(90_000, 'Old Mac'))
      store.restoreKept({}, 'run-1.edits.kept-2026-11-01T10-00-00-000Z.json')
      syncPuts(loc.path, Buffer.from(`{ not json ${m.name}`))
      store.startFresh({})
      s = store.get({}); s = store.apply({}, cut(3000), s.edits.revision, s.digest)
      syncPuts(loc.path, othersFile(m.name === 'A' ? 30_000 : 40_000, `${m.name} other`))
      store.get({})
      const v4 = Buffer.from(JSON.stringify({ version: 4, revision: 2, recording: FP, cuts: [{ start: m.name === 'A' ? 500 : 600, end: 900 }], boundaries: [], leftOut: [], undo: [], redo: [], finish: { camera: true } }))
      syncPuts(loc.path, v4)
      s = store.get({}); store.apply({}, cut(4000), s.edits.revision, s.digest)
      theirs.push(readdirSync(dirOf(loc)).filter((f) => f !== 'run-1.edits.json' && f !== 'run-1.edits.kept-2026-11-01T10-00-00-000Z.json' && !f.startsWith('.')).map((f) => ({ f, bytes: readFileSync(join(dirOf(loc), f)) })))
    }
    assert.ok(theirs[0].length >= 5 && theirs[1].length >= 5, `each Mac kept its copies (${theirs[0].length}, ${theirs[1].length})`)
    const clash = theirs[0].map((x) => x.f).filter((f) => theirs[1].some((y) => y.f === f))
    assert.deepEqual(clash, [], 'no copy name made on both Macs in the same millisecond')
    // The sync merges B's folder into A's, a later file replacing one of the same name.
    cpSync(dirOf(macs[1].loc), dirOf(macs[0].loc), { recursive: true, force: true })
    for (const x of [...theirs[0], ...theirs[1]]) assert.ok(readFileSync(join(dirOf(macs[0].loc), x.f)).equals(x.bytes), `${x.f} survives the merge`)
    assert.ok(macs[0].store.listKept({}).length >= theirs[0].length + theirs[1].length, 'and every one is listed')
    pass(`two Macs keeping copies in the same millisecond, offline (${theirs[0].length + theirs[1].length} copies: captures, a restore, Start new edits, replaced on open, an older format), then merged into one folder: every copy survives`)
  }

  // ---- 5. Listing 500 copies ------------------------------------------------------------------------------
  {
    const loc = place('many')
    const COPIES = 500, SAME = 30
    const undo = Array.from({ length: 20 }, (_, i) => ({ cuts: Array.from({ length: 150 }, (_, j) => ({ start: j * 1000 + i, end: j * 1000 + i + 200 })), boundaries: [], leftOut: [] }))
    let total = 0
    const fileOf = (i) => `run-1.edits.before-2026-10-01T00-00-00-000Z-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.json`
    for (let i = 0; i < COPIES; i++) {
      // The last SAME copies are one version kept SAME times (identical bytes).
      const r = i >= COPIES - SAME ? COPIES - SAME : i
      const text = serialiseEditsFile({ ...emptyEdits(), revision: r, recording: FP, cuts: [{ start: r * 10, end: r * 10 + 5 }], undo: undo.map((u) => ({ ...u, finish: { camera: true, evenVolume: true, smoothJoins: true }, faces: { all: { layout: 'corner', corner: 'bottom-right', size: 'medium' }, slides: [] }, takes: [] })) }, { mac: 'Old Mac', app: '0.45.0', at: new Date(Date.UTC(2026, 9, 1) + r * 60_000).toISOString() }, [])
      writeFileSync(join(dirOf(loc), fileOf(i)), text)
      total += Buffer.byteLength(text)
    }
    // Copies whose details are not where an older listing looked: a sync copy with "version" after a long field, one
    // with no details in its first bytes at all, one not JSON, and one far larger than an edits file may be.
    const late = JSON.stringify({ padding: 'x'.repeat(5000), ...JSON.parse(serialiseEditsFile({ ...emptyEdits(), revision: 1, recording: FP, cuts: [{ start: 7000, end: 9000 }] }, null, [])) })
    const odd = { 'run-1.edits (Old Mac’s conflicted copy 2026-10-01).json': late, 'run-1.edits.changed-2026-09-01T00-00-00-000Z-aaaaaaaa-0000-4000-8000-000000000000.json': late.replace('"revision":1', '"revision":2'), 'run-1.edits 2.json': 'not json at all', 'run-1.edits.kept-2026-09-02T00-00-00-000Z-bbbbbbbb-0000-4000-8000-000000000000.json': 'y'.repeat(9 * 1024 * 1024) }
    for (const [f, t] of Object.entries(odd)) { writeFileSync(join(dirOf(loc), f), t); utimesSync(join(dirOf(loc), f), new Date('2026-09-01'), new Date('2026-09-01')) }
    let read = 0
    const store = storeFor(loc, { io: { onListRead: (bytes) => { read += bytes } } })
    const t0 = performance.now()
    const list = store.listKept({})
    const ms = performance.now() - t0
    const rows = list.length, files = list.reduce((n, k) => n + 1 + (k.same?.length ?? 0), 0)
    assert.equal(files, COPIES + Object.keys(odd).length, 'every copy is listed (as a row, or named by the row of an identical one)')
    assert.equal(rows, COPIES - SAME + 1 + Object.keys(odd).length, `the ${SAME} identical copies are one row`)
    const grouped = list.find((k) => k.same?.length)
    assert.equal(grouped.same.length, SAME - 1)
    for (const id of [grouped.id, ...grouped.same]) assert.ok(readFileSync(join(dirOf(loc), id)).equals(readFileSync(join(dirOf(loc), grouped.id))), 'grouped copies hold identical bytes (and every file is still there)')
    assert.ok(read < (total + 9 * 1024 * 1024) / 4, `a listing reads a fraction of the bytes (${Math.round(read / 1024)} KB of ${Math.round(total / 1024)} KB)`)
    assert.ok(list.filter((k) => k.summary).length <= 40, 'the newest are read whole, with their summary')
    assert.ok(list[0].at >= list.at(-1).at, 'newest first')
    for (const f of Object.keys(odd)) assert.ok(list.some((k) => k.file === f), `${f} is listed`)
    assert.equal(list.find((k) => k.file === 'run-1.edits.changed-2026-09-01T00-00-00-000Z-aaaaaaaa-0000-4000-8000-000000000000.json').state, 'unknown', 'details beyond the first bytes: listed, details read when opened')
    assert.equal(store.openKept({}, 'run-1.edits (Old Mac’s conflicted copy 2026-10-01).json').edits.cuts[0].start, 7000, 'and it opens whole')
    const oldest = list.find((k) => k.file === fileOf(0))
    assert.equal(oldest.by?.mac, 'Old Mac', 'an older copy still says who saved it (from its first bytes)')
    assert.equal(oldest.summary, null)
    assert.equal(store.openKept({}, oldest.id).edits.cuts.length, 1, 'and opens whole when asked')
    assert.ok(ms < 5000, `listed in ${Math.round(ms)} ms`)
    console.log(`  ${files} copies (${Math.round(total / 1024 / 1024)} MB) listed as ${rows} rows in ${Math.round(ms)} ms, reading ${Math.round(read / 1024)} KB`)
    pass(`listing ${files} kept copies: every one listed, newest first, identical ones as one row, details wherever they sit or "read when opened"; the newest read whole, the rest from their first bytes`)
  }
} finally {
  try { for (const f of readdirSync(root, { recursive: true })) try { chmodSync(join(root, f), 0o700) } catch { /* gone */ } } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true })
}
