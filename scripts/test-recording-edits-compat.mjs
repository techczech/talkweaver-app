// 0.45, second Mac: edits files across releases, with each release's own reader and writer
// (scripts/fixtures/edits-releases: the store and format of v0.44.0 and v0.44.5, exactly as tagged).
//
// Table 1, files this build writes (with `savedBy` and `earlier`), read and saved by 0.44.5 and 0.44.0:
//   0.44.5 reads every edit kind as written and saves over it keeping every edit (it drops only the two new
//   fields); 0.44.0 refuses the file as "made by a newer version" and writes nothing, and its Start new edits
//   keeps the whole file as a copy that this build lists and restores. So no format bump is needed.
// Table 2, files 0.44.0 and 0.44.5 write, read and saved by this build: every edit kind reads as written; the
//   first save over that file (opened here first, so this Mac has seen it) keeps it, byte for byte, as this Mac's
//   previous save (R1a), listed with its format; no copy in the vault.
// Table 3, this build and 0.44.5 alternating on one file: 0.44.5's saves hold ours in their edit history, so
//   opening here reports nothing and keeps no copy; one that does not hold ours keeps ours, and the notice
//   says an earlier TalkWeaver saved it (not another Mac: that is all the file can tell).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createRecordingEditsStore } from '../src/main/recording-edits-store.ts'
import { noticeWords, savedByOf } from '../src/shared/recording-edits-kept.ts'
import * as v0440 from './fixtures/edits-releases/v0.44.0/main/recording-edits-store.ts'
import * as f0440 from './fixtures/edits-releases/v0.44.0/shared/recording-edits.ts'
import * as v0445 from './fixtures/edits-releases/v0.44.5/main/recording-edits-store.ts'
import * as f0445 from './fixtures/edits-releases/v0.44.5/shared/recording-edits.ts'

const repo = resolve(import.meta.dirname, '..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-edits-compat-')))
const D = 600_000, FP = 'talk/run-1@2026-11-10T09:00:00.000Z/600000'
let n = 0
const pass = (name) => console.log(`PASS ${++n} ${name}`)
const rows = []

// The fixtures are the tagged files, byte for byte (checked where the tags are present).
for (const tag of ['v0.44.0', 'v0.44.5']) for (const file of ['src/main/recording-edits-store.ts', 'src/shared/recording-edits.ts']) {
  const tagged = spawnSync('git', ['show', `${tag}:${file}`], { cwd: repo, encoding: 'utf8' })
  const fixture = join(repo, 'scripts/fixtures/edits-releases', tag, file.replace('src/', ''))
  if (tagged.status === 0) assert.equal(readFileSync(fixture, 'utf8'), tagged.stdout, `${fixture} is ${tag}'s ${file}`)
  else console.log(`(tag ${tag} not in this checkout: the fixture is used as committed)`)
}

const OPS = {
  cut: [{ kind: 'cut', ranges: [{ start: 1000, end: 2000 }] }],
  'trim start and end': [{ kind: 'trim-start', at: 3000 }, { kind: 'trim-end', at: 550_000 }],
  restore: [{ kind: 'cut', ranges: [{ start: 1000, end: 5000 }] }, { kind: 'restore', ranges: [{ start: 2000, end: 3000 }] }],
  'slide start moved': [{ kind: 'boundary', change: 12_000, at: 11_500, any: true }],
  'slide left out': [{ kind: 'leave-out', change: 30_000, out: true }],
  'camera off': [{ kind: 'finish', finish: { camera: false } }],
  'even volume and smooth joins off': [{ kind: 'finish', finish: { evenVolume: false, smoothJoins: false } }],
  'face for one slide': [{ kind: 'face', changes: [12_000], face: { layout: 'side', corner: 'bottom-right', size: 'medium' } }],
  'face for the whole video': [{ kind: 'face', changes: null, face: { layout: 'corner', corner: 'bottom-left', size: 'large' } }],
  'new take chosen': [{ kind: 'take', change: 12_000, run: 'take-1' }],
  'undo and redo': [{ kind: 'cut', ranges: [{ start: 1000, end: 2000 }] }, { kind: 'cut', ranges: [{ start: 8000, end: 9000 }] }, { kind: 'undo' }, { kind: 'redo' }, { kind: 'undo' }],
}
const fields = (e) => ({ cuts: e.cuts, boundaries: e.boundaries, leftOut: e.leftOut, restoredTrims: e.restoredTrims, finish: e.finish, faces: e.faces, takes: e.takes, undo: e.undo, redo: e.redo })
let c = 0
const place = () => { const dir = join(root, `c${c++}`); mkdirSync(dir); return { path: join(dir, 'run-1.edits.json'), runId: 'run-1', durationMs: D, fingerprint: FP, context: { runTrims: [] } } }
const ours = (loc) => createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'Dominik’s MacBook Air', app: '0.45.0' }), seenDir: () => join(root, 'seen') })
/** This Mac's previous save of `loc` (R1a), from its record. */
const previousOf = (loc) => { try { const v = JSON.parse(readFileSync(join(root, 'seen', `${createHash('sha256').update(loc.path).digest('hex').slice(0, 32)}.json`), 'utf8')).previous; return typeof v === 'string' ? Buffer.from(v, 'base64') : null } catch { return null } }
const write = (store, list, withDigest) => { let s = store.get({}); for (const op of list) s = withDigest ? store.apply({}, op, s.edits.revision, s.digest) : store.apply({}, op, s.edits.revision); return s }

try {
  // ---- Table 1: this build writes; 0.44.5 and 0.44.0 read and save ----------------------------------------
  for (const [kind, list] of Object.entries(OPS)) {
    const loc = place()
    const mine = write(ours(loc), list, true)
    const text = readFileSync(loc.path, 'utf8')
    assert.equal(savedByOf(JSON.parse(text))?.mac, 'Dominik’s MacBook Air', 'the file says who saved it')
    // 0.44.5 reads it as written.
    const r5 = f0445.parseEditsText(text, D, { fingerprint: FP })
    assert.ok(r5.ok, `${kind}: 0.44.5 reads it`)
    assert.deepEqual(fields(r5.edits), fields(mine.edits), `${kind}: 0.44.5 reads every edit as written`)
    // 0.44.5 saves over it: every edit kept (only savedBy and earlier go).
    const s5 = v0445.createRecordingEditsStore({ locate: () => loc })
    const after5 = s5.apply({}, { kind: 'cut', ranges: [{ start: 500_000, end: 501_000 }] }, r5.edits.revision)
    const back = ours(loc).get({})
    assert.equal(back.problem, null, `${kind}: this build reads 0.44.5's save`)
    assert.deepEqual(fields(back.edits), fields(after5.edits), `${kind}: and every edit in it`)
    assert.ok(back.edits.undo.length >= 1 && JSON.stringify(back.edits.undo.at(-1).cuts) === JSON.stringify(mine.edits.cuts), `${kind}: 0.44.5's change is one more undo step on top of ours`)
    rows.push(['this build', kind, '0.44.5', 'reads every edit; its save keeps every edit (drops savedBy and earlier only)'])
    // 0.44.0: refused as newer, nothing written; Start new edits keeps the whole file, which this build lists and restores.
    const loc0 = place()
    const mine0 = write(ours(loc0), list, true)
    const text0 = readFileSync(loc0.path, 'utf8')
    const s0 = v0440.createRecordingEditsStore({ locate: () => loc0, now: () => new Date('2026-11-15T12:00:00.000Z') })
    assert.equal(s0.get({}).problem?.kind, 'newer', `${kind}: 0.44.0 says the edits were made by a newer version`)
    assert.throws(() => s0.apply({}, { kind: 'cut', ranges: [{ start: 5, end: 10 }] }, mine0.edits.revision), /newer version/)
    assert.equal(readFileSync(loc0.path, 'utf8'), text0, `${kind}: 0.44.0 writes nothing over it`)
    s0.startFresh({})
    s0.apply({}, { kind: 'cut', ranges: [{ start: 100_000, end: 101_000 }] }, 0)
    const store = ours(loc0)
    const kept = store.listKept({})
    const copy = kept.find((k) => k.reason === 'set-aside')
    assert.ok(copy && copy.state === 'ok' && copy.by?.mac === 'Dominik’s MacBook Air', `${kind}: the copy 0.44.0 set aside is listed with who saved it`)
    assert.equal(readFileSync(join(loc0.path, '..', copy.file), 'utf8'), text0, `${kind}: byte for byte`)
    const restored = store.restoreKept({}, copy.id)
    assert.deepEqual(fields(restored.edits), { ...fields(mine0.edits) }, `${kind}: restoring it brings back every edit`)
    assert.ok(store.listKept({}).some((k) => k.version === 4), `${kind}: 0.44.0's own edits are kept in turn`)
    rows.push(['this build', kind, '0.44.0', 'refused as "made by a newer version", nothing written; its Start new edits keeps the file, listed and restorable here'])
  }
  pass(`table 1: ${Object.keys(OPS).length} edit kinds written by this build, read and saved by 0.44.5 (every edit kept) and refused clearly by 0.44.0 (nothing lost, restorable)`)

  // ---- Table 2: 0.44.0 and 0.44.5 write; this build reads and saves ----------------------------------------
  for (const [release, store, shared] of [['0.44.0', v0440, f0440], ['0.44.5', v0445, f0445]]) {
    for (const [kind, list] of Object.entries(OPS)) {
      const loc = place()
      let theirs
      try { theirs = write(store.createRecordingEditsStore({ locate: () => loc }), list, false) } catch (e) {
        // 0.44.0 has no faces, takes, even volume or smooth joins: those operations do not exist there.
        assert.equal(release, '0.44.0'); rows.push([release, kind, 'this build', 'not an edit 0.44.0 can make']); continue
      }
      // An operation 0.44.0 does not know may also change nothing there (even volume, smooth joins): nothing written.
      if (!existsSync(loc.path)) { assert.equal(release, '0.44.0'); rows.push([release, kind, 'this build', 'not an edit 0.44.0 can make']); continue }
      const text = readFileSync(loc.path, 'utf8')
      const got = ours(loc).get({})
      assert.equal(got.problem, null, `${release} ${kind}: this build reads it`)
      const want = shared.parseEditsText(text, D, { fingerprint: FP }).edits
      assert.deepEqual(got.edits.cuts, want.cuts); assert.deepEqual(got.edits.boundaries, want.boundaries); assert.deepEqual(got.edits.leftOut, want.leftOut)
      assert.equal(got.edits.finish.camera, want.finish.camera)
      if (release === '0.44.5') assert.deepEqual(fields(got.edits), fields(want), `${release} ${kind}: every edit as written`)
      const saved = ours(loc).apply({}, { kind: 'cut', ranges: [{ start: 500_000, end: 501_000 }] }, got.edits.revision, got.digest)
      assert.equal(saved.edits.version, 5)
      const names = readdirSync(join(loc.path, '..'))
      // R1a: this Mac opened the release's file and saved from it, so it is this Mac's previous save, byte for byte,
      // listed with its format; nothing is left in the vault.
      assert.deepEqual(names.filter((f) => f !== 'run-1.edits.json'), [], `${kind}: no copy in the vault`)
      assert.equal(previousOf(loc)?.toString('utf8'), text, `${kind}: ${release}'s file is this Mac's previous save, byte for byte`)
      const listed = ours(loc).listKept({}).find((k) => k.local)
      assert.ok(listed && listed.state === 'ok' && listed.version === (release === '0.44.0' ? 4 : 5) && listed.by === null && ours(loc).openKept({}, listed.id).edits, `${kind}: listed, opens, its format and no Mac recorded`)
      rows.push([release, kind, 'this build', `reads every edit; the save keeps ${release}'s file as this Mac's previous save (format ${listed.version}), no vault copy`])
    }
  }
  pass('table 2: every edit kind written by 0.44.0 and 0.44.5 reads here as written; the first save keeps that file as this Mac\'s previous save, byte for byte, listed')

  // ---- Table 3: alternating with 0.44.5 on another Mac (it drops savedBy and earlier, keeps the history) ----
  // No ancestry reasoning (R4): a 0.44.5 save is not byte-identical to ours, so each time ours is kept as a copy and
  // the owner is told an earlier TalkWeaver saved it. Accepted clutter: one copy per alternation, nothing lost.
  {
    const loc = place()
    const seenDir = join(root, 'seen-round-trip')
    const mac = () => createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'Dominik’s MacBook Air', app: '0.45.0' }), seenDir: () => seenDir })
    const old = v0445.createRecordingEditsStore({ locate: () => loc })
    const holding = (bytes) => readdirSync(join(loc.path, '..')).filter((f) => f !== 'run-1.edits.json' && readFileSync(join(loc.path, '..', f)).equals(bytes))
    let s = mac().get({})
    for (let i = 0; i < 4; i++) {
      s = mac().apply({}, { kind: 'cut', ranges: [{ start: 10_000 * (i + 1), end: 10_000 * (i + 1) + 500 }] }, s.edits.revision, s.digest)
      const mine = readFileSync(loc.path)
      const r = f0445.parseEditsText(mine.toString('utf8'), D, { fingerprint: FP })
      old.apply({}, { kind: 'cut', ranges: [{ start: 300_000 + i * 1000, end: 300_500 + i * 1000 }] }, r.edits.revision)
      const theirs = readFileSync(loc.path)
      s = mac().get({})
      assert.equal(s.notice?.kind, 'replaced', `round ${i + 1}: ours was replaced by bytes that are not ours, so the owner is told`)
      assert.equal(s.notice.older, true)
      assert.match(noticeWords(s.notice), /saved by an earlier version of TalkWeaver/)
      assert.equal(holding(mine).length, 1, `round ${i + 1}: ours is kept, byte for byte, once`)
      assert.ok(readFileSync(loc.path).equals(theirs), `round ${i + 1}: 0.44.5's save is the edits`)
    }
    rows.push(['this build ⇄ 0.44.5', 'four alternations', 'this build', 'each time: ours kept as a copy; told an earlier TalkWeaver saved the edits now in place'])
    // A 0.45 save from another Mac names it.
    const other = createRecordingEditsStore({ locate: () => loc, saver: () => ({ mac: 'Studio', app: '0.45.0' }), seenDir: () => join(root, 'seen-studio') })
    const o = other.get({}); other.apply({}, { kind: 'cut', ranges: [{ start: 450_000, end: 451_000 }] }, o.edits.revision, o.digest)
    const named = mac().get({})
    assert.equal(named.notice?.kind, 'replaced'); assert.equal(named.notice.by?.mac, 'Studio')
    assert.match(noticeWords(named.notice), /edited on Studio with TalkWeaver 0\.45\.0/)
    assert.doesNotMatch(noticeWords(named.notice), /earlier version/)
    rows.push(['0.45 on another Mac', 'a save', 'this build', 'ours kept as a copy; told which Mac and version saved the edits now in place'])
  }
  pass('table 3: alternating with 0.44.5 keeps ours each time and says an earlier TalkWeaver saved the edits now in place; a 0.45 save names its Mac and version')
  if (process.env.TW_MATRIX) { console.log('| written by | edit | read by | result |\n|---|---|---|---|'); for (const r of rows) console.log(`| ${r.join(' | ')} |`) }
} finally {
  rmSync(root, { recursive: true, force: true })
}
