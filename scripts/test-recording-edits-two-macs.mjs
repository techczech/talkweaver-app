// 0.45, second Mac: one edits file, two Macs. A table-driven matrix over the real store
// (src/main/recording-edits-store.ts), with two simulated Macs sharing one vault folder: each Mac has its own
// user-data folder (its record of the edits it last saved or opened), its own lock folder (two machines share
// no lock) and its own name and version in every save. Mac A (or a sync, or Git) changes the file; Mac B acts.
//
//   role      B acts after A, or the same with the two names swapped
//   state     what the file is when it reaches B (STATES)
//   action    open · edit and save · Start new edits · restore a kept copy
//   timing    before B opens · while B has it open and idle · while B has an unsaved change · during B's save
//             (before its final check) · at B's install (after the final check, before the file is moved aside)
//
// Every cell checks (1) what B is told and what B's action does, against the rules in `expected` below, and
// (2) that no version is lost, by content, never by a hash alone and never by "grown into": every version anyone
// saved or that arrived (the one both started from, B's own, A's, a copy kept before the cell, a Git conflict, a
// half-synced or invalid-UTF-8 file, a newer or older format) is, byte for byte, the current file or a listed
// kept copy (a Git conflict counts as both its versions; B's previous save, R1a, is listed too, from B's record),
// which opens when it is an edits file this Mac could read
// at the edits file; and (3) when B's edit or a restore is the result, every editable field of the file (cuts,
// slide starts, slides left out, restored trims, finishing, faces, takes) is exactly what B's editor holds with
// that edit, or what the restored copy holds. The version both start from sets every one of those fields. The
// older-format state is written by 0.44.0's own store (scripts/fixtures/edits-releases). TW_MATRIX=1 prints the
// A→B outcomes as a table.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRecordingEditsStore, editsDigest, serialiseEditsFile } from '../src/main/recording-edits-store.ts'
import { applyEditOp, emptyEdits, parseEditsText } from '../src/shared/recording-edits.ts'
import { earlierOf, gitConflictSides, noticeWords } from '../src/shared/recording-edits-kept.ts'
import { createRecordingEditsStore as store0440 } from './fixtures/edits-releases/v0.44.0/main/recording-edits-store.ts'

const D = 600_000
const FP = 'talk/run-1@2026-11-10T09:00:00.000Z/600000'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-two-macs-')))
const canChmod = !(typeof process.getuid === 'function' && process.getuid() === 0)

const STATES = ['unchanged', 'later-revision', 'same-revision', 'git-conflict', 'truncated', 'invalid-utf8', 'no-permission', 'newer-format', 'older-format', 'missing']
const ACTIONS = ['open', 'edit', 'start-new', 'restore']
const TIMINGS = ['before-open', 'open-idle', 'open-unsaved', 'during-save', 'at-install']
const ROLES = [['A', 'B'], ['B', 'A']]
const KEPT_BEFORE = 'run-1.edits.kept-2026-11-01T10-00-00-000Z.json'
const RUN_TRIMS = [{ start: 100_000, end: 110_000 }]
/** Every editable field, set: cuts, a moved slide start, a slide left out, a restored trim, finishing, faces, a take. */
const RICH = [{ kind: 'boundary', change: 12_000, at: 11_500, any: true }, { kind: 'leave-out', change: 30_000, out: true }, { kind: 'finish', finish: { camera: false, evenVolume: false } },
  { kind: 'face', changes: [12_000], face: { layout: 'side', corner: 'bottom-right', size: 'medium' } }, { kind: 'take', change: 12_000, run: 'take-1' }]
const rich = (cuts, extra = []) => [...RICH, ...extra].reduce((e, op) => applyEditOp(e, op, D), { ...emptyEdits(), cuts, restoredTrims: [{ start: 102_000, end: 104_000 }] })
const FIELDS = ['cuts', 'boundaries', 'leftOut', 'restoredTrims', 'finish', 'faces', 'takes']
const fieldsOf = (e) => Object.fromEntries(FIELDS.map((f) => [f, e?.[f]]))

/**
 * The rules (recording-edits-store.ts, R3 and R4). `told`: what B is told, as a sorted set (problem:<kind>,
 * replaced, changed, refused, set-aside, restored). `result`: what the file holds afterwards (b-edit: B's edit with
 * all of B's edits; kept: the restored copy; none: no file; as-is: what the cell left there).
 *   B's record is the exact bytes B last saw or saved. Every step B takes (open, save, Start new edits, restore)
 *   first compares it with the file: anything not byte-identical (any arrival, a deletion, a file B cannot read) is
 *   "replaced": B's version is kept and B is told. No ancestry: A's later revision, a Git conflict holding B's
 *   version and an older release's save are all "replaced". A step that is refused tells only the refusal (the next
 *   open tells again).
 *   A save installs B's edits and moves whatever is at the file aside; when that is not the version B's edits came
 *   from (an arrival), B is told "changed". A file that is gone needs no copy; one B cannot read refuses the save
 *   before the install, and is moved aside (and B told) when it arrives after the final check.
 */
function expected(state, action, timing) {
  const told = new Set()
  const problem = { 'git-conflict': 'git-conflict', truncated: 'corrupt', 'invalid-utf8': 'corrupt', 'no-permission': 'corrupt', 'newer-format': 'newer' }[state]
  const diff = state !== 'unchanged' // the bytes at the file are no longer B's record
  const present = diff && state !== 'missing' && state !== 'no-permission' // and they can be read
  const done = (result) => ({ told: [...told].sort(), result })
  const refused = () => ({ told: ['refused'], result: 'as-is' })
  // A save with what B read earlier, after the arrival (open-idle, open-unsaved).
  const staleSave = () => { if (state === 'no-permission') return false; if (diff) told.add('replaced'); if (present) told.add('changed'); return true }
  // Then a step on B's own save: nothing differs any more.
  const onOwn = () => {
    switch (action) {
      case 'open': case 'start-new': return done('as-is')
      case 'restore': told.add('restored'); return done('kept')
    }
  }
  if (timing === 'before-open') {
    if (diff) told.add('replaced') // the open
    switch (action) {
      case 'open': if (problem) told.add(`problem:${problem}`); return done('as-is')
      case 'edit': if (problem) { told.add('refused'); return done('as-is') } return done('b-edit')
      case 'start-new': if (problem) { told.add('set-aside'); return done('none') } return done('as-is')
      case 'restore': if (state === 'no-permission') { told.add('refused'); return done('as-is') } told.add('restored'); return done('kept')
    }
  }
  if (timing === 'open-idle') {
    switch (action) {
      case 'open': if (diff) told.add('replaced'); if (problem) told.add(`problem:${problem}`); return done('as-is')
      case 'edit': return staleSave() ? done('b-edit') : refused()
      case 'start-new': if (diff) told.add('replaced'); if (problem) { told.add('set-aside'); return done('none') } return done('as-is')
      case 'restore': if (state === 'no-permission') return refused(); if (diff) told.add('replaced'); told.add('restored'); return done('kept')
    }
  }
  if (timing === 'open-unsaved') {
    if (!staleSave()) return refused()
    return action === 'edit' ? done('b-edit') : onOwn()
  }
  // during-save: the arrival comes just before B's final check: the save reads again and installs over it.
  // at-install: just after it: the install moves it aside whatever it is.
  if (timing === 'during-save') { if (state === 'no-permission') return refused(); if (present) told.add('changed') }
  else if (diff && state !== 'missing') told.add('changed')
  return action === 'edit' ? done('b-edit') : onOwn()
}

let cell = 0
let clock = Date.parse('2026-11-15T09:00:00.000Z')
const tick = () => new Date((clock += 1000))
const read = (p) => { try { chmodSync(p, 0o600) } catch {} ; return existsSync(p) ? readFileSync(p) : null }
const parse = (t) => { try { return JSON.parse(t.toString('utf8')) } catch { return null } }
const op = (at) => ({ kind: 'cut', ranges: [{ start: at, end: at + 500 }] })
const hasCut = (text, at) => !!parse(text)?.cuts?.some((x) => x.start === at)

function setup(n, [other, actor]) {
  const vault = join(root, `c${n}`, 'vault', '_PRESENTATIONS', 'talk')
  mkdirSync(vault, { recursive: true })
  const path = join(vault, 'run-1.edits.json')
  const loc = { path, runId: 'run-1', durationMs: D, fingerprint: FP, context: { runTrims: RUN_TRIMS } }
  const mac = (name) => {
    const userData = join(root, `c${n}`, `userData-${name}`)
    let during = null, installing = null
    const store = createRecordingEditsStore({
      locate: () => loc, now: tick, saver: () => ({ mac: `${name}’s Mac`, app: '0.45.0' }),
      seenDir: () => join(userData, 'recording-edits-seen'), lockFolder: join(userData, 'locks'),
      beforeRename: () => { const f = during; during = null; f?.() },
      beforeInstall: () => { const f = installing; installing = null; f?.() }
    })
    /** This Mac's previous save (R1a), from its record: a listed row, not a file in the vault. */
    const previous = () => { try { const dir = join(userData, 'recording-edits-seen'); const v = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8')).previous; return typeof v === 'string' ? Buffer.from(v, 'base64') : null } catch { return null } }
    return { name, store, previous, duringNextSave: (f) => { during = f }, atNextInstall: (f) => { installing = f } }
  }
  return { vault, path, loc, A: mac(other), B: mac(actor) }
}

const strict = (bytes) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null } }
/** The versions a file holds: itself, or a Git conflict file's two versions too. */
const versionsOf = (bytes) => { const sides = bytes && gitConflictSides(bytes.toString('utf8')); return bytes ? [bytes, ...(sides ? sides.map((x) => Buffer.from(x)) : [])] : [] }

const results = []
try {
  for (const role of ROLES) for (const state of STATES) for (const action of ACTIONS) for (const timing of TIMINGS) {
    const n = cell++
    const label = `${role[1]} after ${role[0]}: ${state} · ${action} · ${timing}`
    const c = setup(n, role)
    const { A, B, path, vault } = c
    const heads = new Map() // bytes (base64) → { bytes, why }
    const keep = (bytes, why) => heads.set(bytes.toString('base64'), { bytes, why })
    const head = (why) => { const t = read(path); if (t !== null) keep(t, why) }
    // The version both Macs start from: every editable field set (a restored trim comes from an earlier release's
    // file, so it is written as one), then A saved it, B opened it.
    writeFileSync(path, serialiseEditsFile({ ...rich([]), recording: FP }, null, []))
    { const s = A.store.get({}); A.store.apply({}, op(1000), s.edits.revision, s.digest) }
    head('the version both started from')
    let seenB = B.store.get({})
    // Same revision and Git conflict: B saved its own next revision before A's arrived.
    if (state === 'same-revision' || state === 'git-conflict') { seenB = B.store.apply({}, op(2000), seenB.edits.revision, seenB.digest); head('B’s own revision') }
    const bText = read(path)
    // A kept copy, as an earlier Start new edits left it (for restore).
    const keptEdits = { ...rich([{ start: 90_000, end: 91_000 }], [{ kind: 'leave-out', change: 45_000, out: true }]), revision: 7, recording: FP }
    const keptBefore = serialiseEditsFile(keptEdits, { mac: 'Old Mac', app: '0.45.0', at: '2026-11-01T10:00:00.000Z' }, [])
    writeFileSync(join(vault, KEPT_BEFORE), keptBefore); keep(Buffer.from(keptBefore), 'a copy kept before')

    /** A's version of the next revision, saved on A's own disk from the version both started from. */
    const aNext = () => {
      const aDisk = path + '.a-disk'
      const started = [...heads.values()].find((h) => h.why === 'the version both started from').bytes
      writeFileSync(aDisk, started)
      createRecordingEditsStore({ locate: () => ({ ...c.loc, path: aDisk }), now: tick, saver: () => ({ mac: `${A.name}’s Mac`, app: '0.45.0' }), lockFolder: join(root, `c${n}`, 'a-disk-locks') })
        .apply({}, op(7000), parse(started).revision, editsDigest(started))
      const t = read(aDisk); rmSync(aDisk); return t
    }
    // What arrives (from A, a sync or Git), as a function, so a timing can choose when.
    const arrive = () => {
      switch (state) {
        case 'unchanged': return
        case 'later-revision': { const s = A.store.get({}); A.store.apply({}, op(5000), s.edits.revision, s.digest); head('A’s later revision'); return }
        case 'same-revision': { const t = aNext(); writeFileSync(path, t); head('A’s version of the same revision'); return }
        case 'git-conflict': { const t = aNext(); keep(t, 'A’s side of the conflict'); writeFileSync(path, `<<<<<<< HEAD\n${bText}=======\n${t}>>>>>>> other-mac\n`); head('the conflicted file'); return }
        case 'truncated': writeFileSync(path, read(path).subarray(0, 40)); head('the half-synced file'); return
        case 'invalid-utf8': {
          // Damaged in transit: still JSON-shaped, but a byte inside a string is not UTF-8.
          const t = Buffer.from(read(path)); t[t.indexOf('Mac') + 1] = 0xff
          writeFileSync(path, t); head('the invalid UTF-8 file'); return
        }
        case 'no-permission': head('the file that cannot be read'); if (canChmod) chmodSync(path, 0o000); return
        case 'newer-format': {
          // A newer TalkWeaver's file: a later format, its saver named, and (the contract) the versions it grew from,
          // with their edits as steps of its history.
          const t = read(path), was = parse(t)
          writeFileSync(path, JSON.stringify({ version: 6, revision: (was?.revision ?? 0) + 1, recording: FP, cuts: [{ start: 12_000, end: 13_000 }], boundaries: [], leftOut: [], undo: [...(was?.undo ?? []), { cuts: was?.cuts ?? [], boundaries: was?.boundaries ?? [], leftOut: was?.leftOut ?? [] }], redo: [], savedBy: { mac: `${A.name}’s Mac`, app: '0.46.0', at: tick().toISOString() }, earlier: [editsDigest(t), ...earlierOf(was)] }) + '\n')
          head('the newer-format file'); return
        }
        case 'older-format': {
          // A Mac on 0.44.0 saw "newer", chose Start new edits there, then edited: its own store, as released.
          const old = store0440({ locate: () => c.loc, now: tick })
          old.startFresh({}); old.apply({}, op(15_000), 0)
          head('what 0.44.0 saved'); return
        }
        case 'missing': rmSync(path); return
      }
    }

    const told = new Set()
    let error = null, snapshot = null, expectB = null
    const note = (s) => { for (const n of [s?.notice, s?.also, ...(s?.more ?? [])]) if (n) told.add(n.kind); return s }
    const attempt = (f) => { try { return f() } catch (e) { error = String(e.message ?? e); told.add('refused'); return null } }
    const act = (digest) => attempt(() => {
      switch (action) {
        case 'open': return (snapshot = note(B.store.get({})))
        case 'edit': expectB = applyEditOp(seenB.edits, op(30_000), D); return (snapshot = note(B.store.apply({}, op(30_000), seenB.edits.revision, digest)))
        case 'start-new': return (snapshot = note(B.store.startFresh({})))
        case 'restore': return (snapshot = note(B.store.restoreKept({}, KEPT_BEFORE)))
      }
    })
    if (timing === 'before-open') {
      arrive()
      seenB = note(B.store.get({}))
      if (action === 'open') snapshot = seenB
      else act(seenB.digest)
    } else if (timing === 'open-idle') {
      arrive(); act(seenB.digest)
    } else if (timing === 'open-unsaved') {
      // B has one more change on screen, not yet sent; A's arrives; then B's change is sent with what B read, then B acts.
      arrive()
      if (action === 'edit') act(seenB.digest)
      else { const r = attempt(() => note(B.store.apply({}, op(40_000), seenB.edits.revision, seenB.digest))); if (r) { seenB = r; head('B’s change that was on screen'); act(seenB.digest) } }
    } else {
      // During B's save: B saves a change; A's arrives just before B's final check (during-save), or after it,
      // just before B's file is moved aside and the new one installed (at-install). Then B acts.
      if (timing === 'during-save') B.duringNextSave(() => arrive()); else B.atNextInstall(() => arrive())
      if (action === 'edit') act(seenB.digest)
      else { const r = attempt(() => note(B.store.apply({}, op(40_000), seenB.edits.revision, seenB.digest))); if (r) { seenB = r; head('B’s save that was under way'); act(seenB.digest) } }
    }
    if (snapshot?.problem && !error) told.add(`problem:${snapshot.problem.kind}`)

    // ---- what happened, against the rules ---------------------------------------------------------------
    const now = read(path)
    const want = expected(state, action, timing)
    const got = [...told].sort()
    // ---- no version lost, by content ----------------------------------------------------------------------
    const listedCopies = B.store.listKept({}).map((k) => {
      let opens = false
      try { B.store.openKept({}, k.id); opens = true } catch { /* does not open */ }
      return { ...k, opens }
    })
    const copies = [...new Set(listedCopies.filter((k) => !k.local).map((k) => k.file))].map((file) => ({ file, bytes: read(join(vault, file)), opens: listedCopies.filter((k) => k.file === file).some((k) => k.opens) }))
    const prevRow = listedCopies.find((k) => k.local)
    if (prevRow) copies.push({ file: prevRow.id, bytes: B.previous(), opens: prevRow.opens })
    const atFile = versionsOf(now)
    const lost = [...heads.values()].filter((h) => {
      if (atFile.some((b) => b.equals(h.bytes))) return false
      // Its bytes, in a listed copy that opens when they are an edits file for this recording (a file that had no
      // read permission at the edits file keeps it in the copy: its bytes are what is checked).
      const holder = copies.find((k) => versionsOf(k.bytes).some((b) => b.equals(h.bytes)))
      const text = strict(h.bytes)
      const opensHere = text !== null && parseEditsText(text, D, { fingerprint: FP, runTrims: RUN_TRIMS }).ok && h.why !== 'the file that cannot be read'
      return !(holder && (!opensHere || holder.opens))
    }).map((h) => h.why)
    const nowEdits = now && strict(now) !== null ? parseEditsText(strict(now), D, { fingerprint: FP, runTrims: RUN_TRIMS }) : null
    const outcome = `${got.join('+') || 'nothing to tell'} → ${want.result === 'b-edit' && hasCut(now, 30_000) ? 'B’s edit saved' : want.result === 'kept' && hasCut(now, 90_000) ? 'copy restored' : now === null ? 'no file' : 'nothing else written'}`
    try {
      assert.deepEqual(lost, [], 'every version is the current file or a listed copy (that opens), byte for byte')
      assert.deepEqual(got, want.told, 'what B is told')
      if (want.result === 'b-edit') {
        assert.ok(hasCut(now, 30_000), 'B’s edit is in the file')
        if (expectB) assert.deepEqual(fieldsOf(nowEdits?.edits), fieldsOf(expectB), 'every editable field is B’s, with the edit')
      }
      if (want.result === 'kept') {
        assert.ok(hasCut(now, 90_000), 'the kept copy is now the edits')
        assert.deepEqual(fieldsOf(nowEdits?.edits), fieldsOf(keptEdits), 'every editable field is the kept copy’s')
      }
      if (want.result === 'none') assert.equal(now, null, 'Start new edits leaves no file until the first edit')
      if (error) assert.match(error, /kept|could not|changed|Try again|Git conflict|newer|read/, 'a refusal says why')
      if (snapshot?.problem?.kind === 'newer') assert.match(snapshot.problem.message, new RegExp(`Edited on ${A.name}’s Mac with TalkWeaver 0\\.46\\.0`), 'a newer file names its Mac and version')
      if (snapshot?.notice) assert.ok(noticeWords(snapshot.notice).length > 40, 'a notice has words')
      results.push({ role: role.join('→'), state, action, timing, outcome, ok: true })
    } catch (e) {
      results.push({ role: role.join('→'), state, action, timing, outcome, ok: false })
      console.log(`FAIL ${label}: ${e.message.split('\n')[0]}\n  told ${got.join(', ') || 'nothing'} (expected ${want.told.join(', ') || 'nothing'})${error ? `; error: ${error}` : ''}\n  lost: ${lost.join(', ') || 'nothing'}`)
      process.exitCode = 1
    }
  }
  if (process.env.TW_MATRIX) {
    console.log(`| state | action | ${TIMINGS.join(' | ')} |\n|---|---|${TIMINGS.map(() => '---').join('|')}|`)
    for (const state of STATES) for (const action of ACTIONS) console.log(`| ${state} | ${action} | ${TIMINGS.map((t) => results.find((r) => r.role === 'A→B' && r.state === state && r.action === action && r.timing === t).outcome).join(' | ')} |`)
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`${passed} of ${results.length} cells pass (${ROLES.length} roles × ${STATES.length} states × ${ACTIONS.length} actions × ${TIMINGS.length} timings), no version lost in any (checked by content)`)
  if (passed !== results.length) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
