// 0.45, second Mac: a property test of the edits store (recording-edits-store.ts, rules R1 to R5). Each run, from a
// fixed seed: two Macs (own record, own lock) share one vault folder and open, save, restore and Start new edits
// in a random order; at random install boundaries (before the final check, after it, after the record, after the
// temporary file, after the move, after the link, after settling) another process renames a version over the edits
// file (or removes it), and the acting process is killed (an exception there: the store does no clean-up on a
// failure, so it leaves what a kill leaves); a killed Mac reopens with a fresh store on the same record. At the end
// both Macs reopen. Then every byte sequence that was ever at the edits file, reported saved, or held in a Mac's
// record is at the edits file, in a listed copy, or in a Mac's record (settled, pending or previous), or it was
// released under R1a; and no listed copy ever disappeared or changed.
//
// R1a, checked at the instant of every removal the store makes in the vault (fs.unlinkSync is watched): the file is
// one this install captured, its bytes are exactly the acting Mac's settled record from before the install, and that
// Mac's record already holds them durably as `previous` (with the new bytes settled, nothing pending). Only bytes
// removed that way may later be missing (released: a newer own save took the `previous` slot). After the runs, N
// ordinary saves on one Mac leave nothing in the vault and exactly one previous save.
//
// What a sync does to a version no TalkWeaver has seen is outside the guarantee (it is the sync's loss): the other
// process replaces the edits file only when its bytes are held (in a Mac's record or a copy beside it).
//
//   TW_PROPERTY_RUNS=<n> (default 3000) · TW_PROPERTY_SEED=<seed> runs one seed and prints its steps.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// Kills here are exceptions in this process, so flushing to disk proves nothing and only costs time: off for this
// test (the kill table in test-edits-install.mjs kills real processes with flushing on).
fs.fsyncSync = () => {}
// Every removal the store makes, seen at the instant before it happens (R1a's check).
const realUnlink = fs.unlinkSync
let onUnlink = null
fs.unlinkSync = (p) => { onUnlink?.(String(p)); return realUnlink(p) }
syncBuiltinESMExports()
const { createRecordingEditsStore, serialiseEditsFile } = await import(process.env.TW_EDITS_STORE ?? '../src/main/recording-edits-store.ts')
import { emptyEdits } from '../src/shared/recording-edits.ts'

const D = 600_000, FP = 'talk/run-1@2026-11-10T09:00:00.000Z/600000'
const RUNS = Number(process.env.TW_PROPERTY_RUNS ?? 3000)
const ONE = process.env.TW_PROPERTY_SEED ? Number(process.env.TW_PROPERTY_SEED) : null
const SEEDS = ONE !== null ? [ONE] : Array.from({ length: RUNS }, (_, i) => 1000 + i * 7919)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-edits-property-')))
const KILL = Object.freeze({ killed: true })
// 'before-check' and 'after-check' come from the store's beforeRename and beforeInstall; after the move from beforeLink (every round).
const STEPS = ['recorded', 'temp', 'linked', 'settled', 'released']

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const key = (b) => createHash('sha256').update(b).digest('hex')
const tempName = (f) => f.startsWith('.') && f.endsWith('.tmp')

function run(seed) {
  const rnd = mulberry32(seed), pick = (xs) => xs[Math.floor(rnd() * xs.length)], chance = (p) => rnd() < p
  const dir = join(root, `s${seed}`), vault = join(dir, 'vault')
  mkdirSync(vault, { recursive: true })
  const path = join(vault, 'run-1.edits.json')
  const loc = { path, runId: 'run-1', durationMs: D, fingerprint: FP, context: { runTrims: [] } }
  const log = []
  const V = new Map() // sha256 → { bytes, why }
  const note = (bytes, why) => { if (bytes && !V.has(key(bytes))) V.set(key(bytes), { bytes, why }) }
  const destBytes = () => (existsSync(path) ? readFileSync(path) : null)
  const recordsOf = () => macs.flatMap((m) => { try { return readdirSync(m.seen).flatMap((f) => { const r = JSON.parse(readFileSync(join(m.seen, f), 'utf8')); return [r.settled, r.pending, r.previous, r.bytes].filter((x) => typeof x === 'string').map((x) => Buffer.from(x, 'base64')) }) } catch { return [] } })
  /** One Mac's record, its three slots as exact bytes. */
  const recordOf = (m) => { try { const r = JSON.parse(readFileSync(join(m.seen, readdirSync(m.seen).find((f) => f.endsWith('.json'))), 'utf8')); const b = (x) => (typeof x === 'string' ? Buffer.from(x, 'base64') : null); return { settled: b(r.settled), pending: b(r.pending), previous: b(r.previous) } } catch { return { settled: null, pending: null, previous: null } } }
  // R1a: the acting Mac, its settled record before the current install, and every byte sequence released.
  let acting = null
  const priorSettled = new Map()
  const released = new Map()
  const violations = []
  const before_ = (m) => { acting = m; priorSettled.set(m.name, recordOf(m).settled) }
  onUnlink = (p) => {
    const f = p.split('/').at(-1)
    if (!p.startsWith(vault + '/') || f.startsWith('.') || f === 'run-1.edits.json') return
    // Recorded, not thrown: the store treats a failed removal as "leave it listed", so a throw here would hide the fault.
    const bytes = readFileSync(p), rec = recordOf(acting)
    if (!/^run-1\.edits\.(before|kept)-/.test(f)) violations.push(`the store removed ${f}, which is not a capture`)
    else if (!priorSettled.get(acting.name)?.equals(bytes)) violations.push(`${acting.name} removed ${f}, which is not its settled record from before the install`)
    else if (!(rec.previous?.equals(bytes) && rec.pending === null)) violations.push(`${f} removed before ${acting.name}'s record held it durably as previous`)
    released.set(key(bytes), bytes)
    log.push(`  ${acting.name} releases its own superseded save ${f.slice(12, 40)}`)
  }
  const observe = (why) => { note(destBytes(), `at the edits file (${why})`); for (const b of recordsOf()) note(b, `in a record (${why})`) }
  let n = 0
  /** Another process replaces the edits file (a sync), only when what is there is held elsewhere. */
  const sync = (where) => {
    const now = destBytes()
    if (now) {
      const held = recordsOf().some((b) => b.equals(now)) || readdirSync(vault).some((f) => f !== 'run-1.edits.json' && !tempName(f) && (() => { try { return readFileSync(join(vault, f)).equals(now) } catch { return false } })())
      if (!held) return
    }
    const kind = pick(['foreign', 'foreign', 'older', 'garbage', 'remove'])
    if (kind === 'remove') { if (now) { unlinkSync(path); log.push(`  sync removes the edits file (${where})`) } return }
    const bytes = kind === 'garbage' ? Buffer.from(`{"version":5,"cuts":[{"start":${n++}`)
      : Buffer.from(serialiseEditsFile({ ...emptyEdits(), revision: 50 + n, recording: FP, cuts: [{ start: 400_000 + 1000 * n++, end: 400_000 + 1000 * n + 500 }] }, kind === 'older' ? null : { mac: 'Third Mac', app: '0.45.0', at: '2026-11-15T09:00:00.000Z' }, []))
    const t = `${path}.sync-${n}`; writeFileSync(t, bytes); renameSync(t, path)
    note(bytes, `put there by a sync (${where})`)
    log.push(`  sync puts ${kind} (${where})`)
  }
  let killArmed = false
  /** At an install boundary: observe, maybe a sync, maybe a kill. */
  const boundary = (step) => {
    observe(step)
    if (chance(0.12)) sync(step)
    if (killArmed && chance(0.08)) { log.push(`  killed at ${step}`); throw KILL }
  }
  const macs = ['A', 'B'].map((name) => ({ name, seen: join(dir, `seen-${name}`), locks: join(dir, `locks-${name}`), store: null, snap: null }))
  const fresh = (m) => {
    m.store = createRecordingEditsStore({
      locate: () => loc, saver: () => ({ mac: `${m.name}’s Mac`, app: '0.45.0' }), seenDir: () => m.seen, lockFolder: m.locks,
      now: () => new Date(Date.UTC(2026, 10, 15, 9) + n++ * 1000),
      beforeRename: () => { before_(m); boundary('before-check') }, beforeInstall: () => boundary('after-check'),
      io: { flushFolder: () => {}, at: (s) => { if (STEPS.includes(s)) boundary(s) }, beforeLink: () => boundary('moved') }
    })
  }
  const open = (m) => {
    for (let i = 0; ; i++) {
      killArmed = i < 2
      before_(m)
      try { m.snap = m.store.get({}); return } catch (e) { if (e !== KILL) throw e; fresh(m) }
    }
  }
  for (const m of macs) fresh(m)
  for (const m of macs) open(m)
  const listedFiles = () => { const s = macs[0].store; return s.listKept({}).filter((k) => !k.local).flatMap((k) => [k.file, ...(k.same ?? [])]) }
  let before = new Map()
  const snapshotCopies = () => new Map(listedFiles().filter((f) => !tempName(f)).map((f) => [f, readFileSync(join(vault, f))]))
  before = snapshotCopies()
  const steps = 8 + Math.floor(rnd() * 10)
  for (let i = 0; i < steps; i++) {
    const m = pick(macs)
    const action = m.snap?.problem ? pick(['open', 'start-new', 'restore']) : pick(['save', 'save', 'save', 'open', 'restore'])
    log.push(`${m.name} ${action}`)
    observe('before a step')
    if (chance(0.15)) sync('between steps')
    killArmed = true
    before_(m)
    try {
      if (action === 'save') {
        const s = m.snap
        const r = m.store.apply({}, { kind: 'cut', ranges: [{ start: 1000 * (n++ % 500), end: 1000 * (n % 500) + 400 }] }, s.edits.revision, s.digest)
        m.snap = r
      } else if (action === 'open') m.snap = m.store.get({})
      else if (action === 'start-new') m.snap = m.store.startFresh({})
      else {
        const ok = m.store.listKept({}).filter((k) => k.state === 'ok' || k.state === 'unknown')
        if (ok.length) m.snap = m.store.restoreKept({}, pick(ok).id)
      }
      if (action === 'save' || action === 'restore') { note(destBytes(), 'reported saved (at the edits file on return)'); for (const b of recordsOf()) note(b, 'in a record after a save') }
    } catch (e) {
      if (e === KILL) fresh(m)
      else log.push(`  refused: ${String(e.message).slice(0, 80)}`)
      open(m)
    }
    observe('after a step')
    assert.deepEqual(violations, [], `seed ${seed}: R1a (rerun with TW_PROPERTY_SEED=${seed})\n${log.join('\n')}`)
    // No listed copy disappears or changes (R1).
    const after = snapshotCopies()
    for (const [f, b] of before) assert.ok(after.has(f) && after.get(f).equals(b), `seed ${seed}: the listed copy ${f} disappeared or changed\n${log.join('\n')}`)
    before = after
  }
  // Both Macs reopen.
  killArmed = false
  for (const m of macs) { fresh(m); open(m) }
  assert.deepEqual(violations, [], `seed ${seed}: R1a (rerun with TW_PROPERTY_SEED=${seed})\n${log.join('\n')}`)
  const holders = [destBytes(), ...listedFiles().map((f) => readFileSync(join(vault, f))), ...recordsOf()].filter(Boolean)
  const lost = [...V.values()].filter((v) => !holders.some((h) => h.equals(v.bytes)) && !released.has(key(v.bytes)))
  assert.deepEqual(lost.map((v) => v.why), [], `seed ${seed}: a version is not at the edits file, in a listed copy or in a Mac's record, and was not released as its own superseded save (rerun with TW_PROPERTY_SEED=${seed})\n${log.join('\n')}`)
  assert.ok(readdirSync(vault).every((f) => !f.endsWith('.tmp') || !f.startsWith('.run-1.edits.')), `seed ${seed}: a temporary file left after both Macs reopened`)
  if (ONE !== null) console.log(log.join('\n'))
  rmSync(dir, { recursive: true, force: true })
  return { versions: V.size, steps, kills: log.filter((l) => l.includes('killed at')).length, syncs: log.filter((l) => l.includes('  sync ')).length, released: released.size }
}

/** N ordinary saves on one Mac: nothing left in the vault, exactly one previous save (R1a). */
function ordinary(N) {
  const dir = join(root, `ordinary-${N}`), vault = join(dir, 'vault'), seen = join(dir, 'seen')
  mkdirSync(vault, { recursive: true })
  const loc = { path: join(vault, 'run-1.edits.json'), runId: 'run-1', durationMs: D, fingerprint: FP, context: { runTrims: [] } }
  const store = createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'One Mac', app: '0.45.0' }), seenDir: () => seen, lockFolder: join(dir, 'locks'), io: { flushFolder: () => {} } })
  let s = store.get({})
  const saves = []
  for (let i = 0; i < N; i++) { s = store.apply({}, { kind: 'cut', ranges: [{ start: 1000 * i, end: 1000 * i + 400 }] }, s.edits.revision, s.digest); saves.push(readFileSync(loc.path)) }
  assert.deepEqual(readdirSync(vault), ['run-1.edits.json'], `${N} ordinary saves: no copy and no temporary file in the vault`)
  const list = store.listKept({})
  assert.deepEqual(list.map((k) => k.reason), N > 1 ? ['previous-save'] : [], `${N} ordinary saves: exactly one previous save listed`)
  const rec = JSON.parse(readFileSync(join(seen, readdirSync(seen)[0]), 'utf8'))
  if (N > 1) assert.ok(Buffer.from(rec.previous, 'base64').equals(saves.at(-2)), 'the previous save is the save before the current one')
  rmSync(dir, { recursive: true, force: true })
}

let versions = 0, total = 0, kills = 0, syncs = 0, rel = 0
const t0 = Date.now()
try {
  for (const seed of SEEDS) {
    try { const r = run(seed); versions += r.versions; total += r.steps; kills += r.kills; syncs += r.syncs; rel += r.released } catch (e) { console.log(`FAIL seed ${seed}`); throw e }
  }
  console.log(`PASS ${SEEDS.length} runs (${total} steps, ${kills} kills, ${syncs} sync replacements, ${versions} versions tracked, ${rel} own superseded saves released under R1a, seeds ${SEEDS[0]}…${SEEDS.at(-1)}): every version at the edits file, in a listed copy or in a Mac's record, or released under R1a's checked condition; no listed copy ever disappeared or changed (${Math.round((Date.now() - t0) / 1000)} s)`)
  for (const N of [1, 2, 25, 100]) ordinary(N)
  console.log('PASS N ordinary saves on one Mac (N = 1, 2, 25, 100): nothing in the vault, exactly one previous save')
} finally {
  rmSync(root, { recursive: true, force: true })
}
