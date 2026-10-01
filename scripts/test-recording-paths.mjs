// Recording handlers build paths from renderer-supplied talk slugs and session ids. These tests
// drive the path functions every recording handler uses (src/main/recording-paths.ts) with hostile
// and legitimate names, and prove that acting on their answers never touches anything outside a
// scratch vault / userData — the tree outside is listed before and after.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import {
  deleteTargets,
  localRecordingPath,
  saveTargets,
  sessionJsonPath,
  listSessionJsonFiles,
  talkSessionsFolder,
  transcriptPath,
  vaultSessionPath
} from '../src/main/recording-paths.ts'
import { createPlannedRun, deletePlannedRun, listRuns, normaliseRun, persistRun, readRun, updatePlannedRun } from '../src/main/runs.ts'
import { createPathwaySummaryReader, pathwayManifestPath, readPathwayManifest } from '../src/main/pathways.ts'

const scratch = mkdtempSync(join(tmpdir(), 'talkweaver-recording-paths-'))
const vault = join(scratch, 'vault')
const userData = join(scratch, 'userData')
const outside = join(scratch, 'outside')
mkdirSync(join(vault, '_PRESENTATIONS'), { recursive: true })
mkdirSync(join(userData, 'recordings'), { recursive: true })
mkdirSync(outside, { recursive: true })
// A talk folder that is a symlink to a folder outside the vault.
symlinkSync(outside, join(vault, '_PRESENTATIONS', 'linked-out'))
// A legitimate talk folder whose transcript file is a link to a file outside the vault.
writeFileSync(join(outside, 'secret.transcript.json'), '{"secret":true}')
mkdirSync(join(vault, '_PRESENTATIONS', 'linked-file-talk'))
// Listings: a session file linked to a Run outside the vault, and a talk folder linked outside.
const runJson = (id, talkSlug) => JSON.stringify({ id, talkSlug, talkTitle: 'T', kind: 'delivery', status: 'delivered', startedAt: '2026-09-30T10:00:00.000Z', audio: null, slideTimeIndex: [] })
writeFileSync(join(outside, 'victim.json'), runJson('victim', 'listing-talk'))
mkdirSync(join(outside, 'talkdir'))
writeFileSync(join(outside, 'talkdir', 'legit.json'), runJson('outside-legit', 'linked-talk'))
mkdirSync(join(vault, '_PRESENTATIONS', 'listing-talk'))
writeFileSync(join(vault, '_PRESENTATIONS', 'listing-talk', 'sess-a.json'), runJson('sess-a', 'listing-talk'))
symlinkSync(join(outside, 'victim.json'), join(vault, '_PRESENTATIONS', 'listing-talk', 'sess-x.json'))
symlinkSync(join(outside, 'talkdir'), join(vault, '_PRESENTATIONS', 'linked-talk'))
// A talk folder linked outside whose file links back into the vault: the folder itself is refused.
mkdirSync(join(outside, 'talkdir2'))
symlinkSync(join(vault, '_PRESENTATIONS', 'listing-talk', 'sess-a.json'), join(outside, 'talkdir2', 'inner.json'))
symlinkSync(join(outside, 'talkdir2'), join(vault, '_PRESENTATIONS', 'linked-talk2'))

// A real pathway manifest in a legitimate talk folder: no recording or Run call may touch it.
const MANIFEST_TEXT = '{"pathways":[{"id":"short","name":"Short","slideIds":[]}]}\n'
mkdirSync(join(vault, '_PRESENTATIONS', 'age-of-the-claw'), { recursive: true })
writeFileSync(join(vault, '_PRESENTATIONS', 'age-of-the-claw', 'manifest.json'), MANIFEST_TEXT)
symlinkSync(join(outside, 'secret.transcript.json'), join(vault, '_PRESENTATIONS', 'linked-file-talk', 'sess-20260930-101500-x.transcript.json'))

function tree(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      out.push(relative(scratch, p))
      if (lstatSync(p).isDirectory()) walk(p)
    }
  }
  walk(root)
  return out
}
const treeOutside = () => [...tree(outside), ...readdirSync(scratch).sort()]

// What a handler does with an answer: write only when ok.
function act(result) {
  if (!result.ok) return
  const paths = 'path' in result ? [result.path] : [result.sessionJson, result.audio].filter(Boolean)
  for (const p of paths) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '{}')
  }
}

const within = (parent, child) => {
  const rel = relative(parent, child)
  return !!rel && !rel.startsWith('..') && !rel.split(sep).includes('..')
}

const before = treeOutside()
let checks = 0

const UNSAFE_SLUGS = ['../../escape', '..', '/abs', 'a/b', '', ' padded ', '.hidden', 'linked-out/../..']
// 'manifest' (any case) names the talk's pathway manifest, not a Run.
const UNSAFE_IDS = ['../x', 'x/y', '', '..', '.x', 'manifest', 'Manifest', 'MANIFEST']
const GOOD_SLUGS = [
  'age-of-the-claw',
  'Přednáška o agentech'.normalize('NFC'),
  'Přednáška o agentech'.normalize('NFD')
]
const GOOD_IDS = [
  'sess-20260930-101500-x',
  `run-${'3f2b8c1e-9d4a-4e7b-8a61-0c5d2e7f9b13'}`,
  `run-${Date.now().toString(36)}`
]

// ── Unsafe talk slugs are refused by every function, with or without a vault ──
for (const slug of UNSAFE_SLUGS) {
  for (const [name, result] of [
    ['vaultSessionPath', vaultSessionPath(vault, slug, GOOD_IDS[0])],
    ['sessionJsonPath(vault)', sessionJsonPath(vault, userData, slug, GOOD_IDS[0])],
    ['sessionJsonPath(no vault)', sessionJsonPath(null, userData, slug, GOOD_IDS[0])],
    ['talkSessionsFolder', talkSessionsFolder(vault, slug)],
    ['saveTargets', saveTargets(vault, userData, slug, GOOD_IDS[0], true)],
    ['saveTargets(no vault)', saveTargets(null, userData, slug, GOOD_IDS[0], true)],
    ['deleteTargets', deleteTargets(vault, userData, slug, GOOD_IDS[0])],
    ['deleteTargets(no vault)', deleteTargets(null, userData, slug, GOOD_IDS[0])]
  ]) {
    assert.deepEqual(result, { ok: false, error: 'unsafe-talk-slug' }, `${name} refuses slug ${JSON.stringify(slug)}`)
    act(result)
    checks++
  }
}

// ── Unsafe session ids are refused, including for the local userData files ──
for (const id of UNSAFE_IDS) {
  for (const [name, result] of [
    ['vaultSessionPath', vaultSessionPath(vault, GOOD_SLUGS[0], id)],
    ['sessionJsonPath(vault)', sessionJsonPath(vault, userData, GOOD_SLUGS[0], id)],
    ['sessionJsonPath(no vault)', sessionJsonPath(null, userData, GOOD_SLUGS[0], id)],
    ['localRecordingPath(webm)', localRecordingPath(userData, id, 'webm')],
    ['localRecordingPath(json)', localRecordingPath(userData, id, 'json')],
    ['saveTargets', saveTargets(vault, userData, GOOD_SLUGS[0], id, true)],
    ['saveTargets(run)', saveTargets(vault, userData, GOOD_SLUGS[0], id, false)],
    ['deleteTargets', deleteTargets(vault, userData, GOOD_SLUGS[0], id)],
    ['deleteTargets(no vault)', deleteTargets(null, userData, GOOD_SLUGS[0], id)]
  ]) {
    assert.deepEqual(result, { ok: false, error: 'unsafe-session-id' }, `${name} refuses id ${JSON.stringify(id)}`)
    act(result)
    checks++
  }
}
for (const id of [42, null, undefined, { toString: () => 'x' }]) {
  assert.equal(localRecordingPath(userData, id, 'webm').ok, false, `non-string id ${String(id)} refused`)
  checks++
}

// ── A talk folder symlinked outside the vault is refused (read, write, delete, list) ──
for (const [name, result] of [
  ['vaultSessionPath', vaultSessionPath(vault, 'linked-out', GOOD_IDS[0])],
  ['sessionJsonPath', sessionJsonPath(vault, userData, 'linked-out', GOOD_IDS[0])],
  ['talkSessionsFolder', talkSessionsFolder(vault, 'linked-out')],
  ['saveTargets', saveTargets(vault, userData, 'linked-out', GOOD_IDS[0], true)],
  ['deleteTargets', deleteTargets(vault, userData, 'linked-out', GOOD_IDS[0])]
]) {
  assert.deepEqual(result, { ok: false, error: 'unsafe-path' }, `${name} refuses a talk folder linked outside the vault`)
  act(result)
  checks++
}

// ── Legitimate names keep working and land exactly where they should ──
const presentations = join(vault, '_PRESENTATIONS')
const recordings = join(userData, 'recordings')
for (const slug of GOOD_SLUGS) {
  const folder = talkSessionsFolder(vault, slug)
  assert.deepEqual(folder, { ok: true, path: join(presentations, slug) }, `talk folder for ${slug}`)
  checks++
  for (const id of GOOD_IDS) {
    const save = saveTargets(vault, userData, slug, id, true)
    assert.deepEqual(save, { ok: true, sessionJson: join(presentations, slug, `${id}.json`), audio: join(recordings, `${id}.webm`) }, `save ${slug}/${id}`)
    act(save)
    const run = saveTargets(vault, userData, slug, id, false)
    assert.deepEqual(run, { ok: true, sessionJson: join(presentations, slug, `${id}.json`), audio: null }, `run save ${slug}/${id}`)
    const noVault = saveTargets(null, userData, slug, id, true)
    assert.deepEqual(noVault, { ok: true, sessionJson: join(recordings, `${id}.json`), audio: join(recordings, `${id}.webm`) }, `no-vault save ${slug}/${id}`)
    // Once written, the same names read back through the guarded path (folder now exists).
    assert.deepEqual(vaultSessionPath(vault, slug, id), { ok: true, path: join(presentations, slug, `${id}.json`) }, `read ${slug}/${id}`)
    assert.deepEqual(sessionJsonPath(vault, userData, slug, id), { ok: true, path: join(presentations, slug, `${id}.json`) }, `edit ${slug}/${id}`)
    assert.deepEqual(deleteTargets(vault, userData, slug, id), { ok: true, sessionJson: join(presentations, slug, `${id}.json`), audio: join(recordings, `${id}.webm`) }, `delete ${slug}/${id}`)
    assert.deepEqual(deleteTargets(null, userData, slug, id), { ok: true, sessionJson: null, audio: join(recordings, `${id}.webm`) }, `no-vault delete ${slug}/${id}`)
    assert.deepEqual(localRecordingPath(userData, id, 'webm'), { ok: true, path: join(recordings, `${id}.webm`) }, `audio ${id}`)
    checks += 8
  }
}

// ── Run files (runs.ts runPath callers: history, handouts, Talk Text, live history) ──
const runInput = (talkSlug) => ({
  talkSlug, talkTitle: 'T', plannedDate: '2026-10-01', eventTitle: 'Seminar', audience: '', slideSet: { kind: 'full' }
})
const throwsUnsafe = (fn, label) => {
  assert.throws(fn, /run-path-unsafe/, label)
  checks++
}
const fakeRun = (talkSlug, id) => normaliseRun({
  id, talkSlug, talkTitle: 'T', kind: 'delivery', status: 'delivered', startedAt: '2026-10-01T10:00:00.000Z',
  endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, audio: null, transcript: null, slideTimeIndex: []
})
for (const slug of [...UNSAFE_SLUGS, 'linked-out']) {
  const label = JSON.stringify(slug)
  throwsUnsafe(() => createPlannedRun(vault, runInput(slug)), `createPlannedRun refuses slug ${label}`)
  // The slug is checked before the id is made: a bad slug is never reported as an id problem.
  // (The up-front check is on the name; a symlinked folder is caught at the path, below.)
  if (slug !== 'linked-out') throwsUnsafe(() => createPlannedRun(vault, runInput(slug), () => ''), `createPlannedRun checks slug first ${label}`)
  throwsUnsafe(() => updatePlannedRun(vault, slug, GOOD_IDS[1], { eventTitle: 'x' }), `updatePlannedRun refuses slug ${label}`)
  throwsUnsafe(() => deletePlannedRun(vault, slug, GOOD_IDS[1]), `deletePlannedRun refuses slug ${label}`)
  // normaliseRun trims the Run's own talkSlug, so a padded one is written under the trimmed (safe) name.
  if (slug !== ' padded ') throwsUnsafe(() => persistRun(vault, fakeRun(slug, GOOD_IDS[0])), `persistRun refuses slug ${label}`)
  assert.equal(readRun(vault, slug, GOOD_IDS[0]), null, `readRun refuses slug ${label}`)
  checks++
}
for (const id of UNSAFE_IDS) {
  const label = JSON.stringify(id)
  // (An empty id keeps its existing refusal, run-id-collision; the id factory is main-side.)
  if (id) throwsUnsafe(() => createPlannedRun(vault, runInput(GOOD_SLUGS[0]), () => id), `createPlannedRun refuses id ${label}`)
  else assert.throws(() => createPlannedRun(vault, runInput(GOOD_SLUGS[0]), () => id), /run-id-collision/)
  throwsUnsafe(() => updatePlannedRun(vault, GOOD_SLUGS[0], id, { eventTitle: 'x' }), `updatePlannedRun refuses id ${label}`)
  throwsUnsafe(() => deletePlannedRun(vault, GOOD_SLUGS[0], id), `deletePlannedRun refuses id ${label}`)
  throwsUnsafe(() => persistRun(vault, fakeRun(GOOD_SLUGS[0], id)), `persistRun refuses id ${label}`)
  assert.equal(readRun(vault, GOOD_SLUGS[0], id), null, `readRun refuses id ${label}`)
  checks++
}
// history:list-runs → listRuns(vault, talkSlug): an unsafe or linked-out talk lists nothing.
// Put a Run where each escape would land, so a missing check shows up as a non-empty list.
writeFileSync(join(outside, `${GOOD_IDS[0]}.json`), JSON.stringify(fakeRun('linked-out', GOOD_IDS[0])))
writeFileSync(join(vault, `${GOOD_IDS[0]}.json`), JSON.stringify(fakeRun('..', GOOD_IDS[0])))
for (const slug of [...UNSAFE_SLUGS, 'linked-out']) {
  assert.deepEqual(listRuns(vault, slug), [], `listRuns refuses slug ${JSON.stringify(slug)}`)
  checks++
}
rmSync(join(outside, `${GOOD_IDS[0]}.json`))
rmSync(join(vault, `${GOOD_IDS[0]}.json`))

// Fresh ids: the session block above already wrote files under GOOD_IDS.
const PLAN_IDS = [`run-${randomUUID()}`, `run-${(Date.now() + 1).toString(36)}`]
for (const slug of GOOD_SLUGS) {
  for (const id of PLAN_IDS) {
    const run = createPlannedRun(vault, runInput(slug), () => id)
    assert.equal(run.id, id)
    assert.equal(readRun(vault, slug, id)?.eventTitle, 'Seminar', `planned run readable ${slug}/${id}`)
    assert.equal(updatePlannedRun(vault, slug, id, { eventTitle: 'Renamed' })?.eventTitle, 'Renamed', `planned run updatable ${slug}/${id}`)
    assert.equal(deletePlannedRun(vault, slug, id), true, `planned run deletable ${slug}/${id}`)
    // A missing (but safe) Run still reads as "not found", not as unsafe.
    assert.equal(updatePlannedRun(vault, slug, id, { eventTitle: 'x' }), null, `missing run is not-found ${slug}/${id}`)
    assert.equal(deletePlannedRun(vault, slug, id), false, `missing run delete is not-found ${slug}/${id}`)
    checks += 6
  }
  const delivered = persistRun(vault, fakeRun(slug, GOOD_IDS[0]))
  assert.equal(readRun(vault, slug, GOOD_IDS[0])?.id, delivered.id, `delivered run persists ${slug}`)
  assert.ok(listRuns(vault, slug).some((run) => run.id === GOOD_IDS[0]), `listRuns lists ${slug}`)
  checks += 2
}

// ── Transcripts (transcript:get / transcript:run) ──
for (const slug of UNSAFE_SLUGS) {
  for (const v of [vault, null]) {
    const result = transcriptPath(v, userData, slug, GOOD_IDS[0])
    assert.deepEqual(result, { ok: false, error: 'unsafe-talk-slug' }, `transcriptPath(${v ? 'vault' : 'no vault'}) refuses slug ${JSON.stringify(slug)}`)
    act(result)
    checks++
  }
}
for (const id of UNSAFE_IDS) {
  for (const v of [vault, null]) {
    const result = transcriptPath(v, userData, GOOD_SLUGS[0], id)
    assert.deepEqual(result, { ok: false, error: 'unsafe-session-id' }, `transcriptPath(${v ? 'vault' : 'no vault'}) refuses id ${JSON.stringify(id)}`)
    act(result)
    checks++
  }
}
for (const [label, result] of [
  ['talk folder linked outside', transcriptPath(vault, userData, 'linked-out', GOOD_IDS[0])],
  ['transcript file linked outside', transcriptPath(vault, userData, 'linked-file-talk', GOOD_IDS[0])]
]) {
  assert.deepEqual(result, { ok: false, error: 'unsafe-path' }, `transcriptPath refuses a ${label}`)
  act(result)
  checks++
}
for (const slug of GOOD_SLUGS) {
  for (const id of GOOD_IDS) {
    const t = transcriptPath(vault, userData, slug, id)
    assert.deepEqual(t, { ok: true, path: join(presentations, slug, `${id}.transcript.json`) }, `transcript ${slug}/${id}`)
    act(t)
    assert.deepEqual(transcriptPath(vault, userData, slug, id), t, `existing transcript still readable ${slug}/${id}`)
    const local = transcriptPath(null, userData, slug, id)
    assert.deepEqual(local, { ok: true, path: join(recordings, `${id}.transcript.json`) }, `no-vault transcript ${slug}/${id}`)
    act(local)
    checks += 3
  }
}

// ── Pathway manifests (slug = basename of a renderer-supplied outline path) ──
const summaries = createPathwaySummaryReader()
for (const slug of [...UNSAFE_SLUGS, 'linked-out']) {
  throwsUnsafe(() => pathwayManifestPath(vault, slug), `pathwayManifestPath refuses slug ${JSON.stringify(slug)}`)
  throwsUnsafe(() => readPathwayManifest(vault, slug), `readPathwayManifest refuses slug ${JSON.stringify(slug)}`)
  assert.deepEqual(summaries.read(vault, slug), { count: 0, names: [] }, `talk list tolerates unsafe slug ${JSON.stringify(slug)}`)
  summaries.invalidate(vault, slug)
  checks++
}
for (const slug of GOOD_SLUGS) {
  assert.equal(pathwayManifestPath(vault, slug), join(presentations, slug, 'manifest.json'), `manifest path ${slug}`)
  assert.equal(readPathwayManifest(vault, slug).pathways.length, slug === 'age-of-the-claw' ? 1 : 0, `manifest readable ${slug}`)
  checks += 2
}

// ── Listings skip anything whose real path is outside the vault ──
{
  const OUTSIDE_IDS = new Set(['victim', 'outside-legit'])
  const allRuns = listRuns(vault)
  assert.ok(allRuns.some((run) => run.id === 'sess-a'), 'listRuns lists the real session')
  assert.deepEqual(allRuns.filter((run) => OUTSIDE_IDS.has(run.id)).map((run) => run.id), [], 'listRuns skips linked-out files and folders')
  const talkRuns = listRuns(vault, 'listing-talk').map((run) => run.id)
  assert.deepEqual(talkRuns, ['sess-a'], 'listRuns(talk) skips a session file linked outside')
  assert.deepEqual(listRuns(vault, 'linked-talk'), [], 'listRuns(talk) refuses a talk folder linked outside')
  const realVault = realpathSync(vault)
  const allFiles = await listSessionJsonFiles(vault)
  assert.ok(allFiles.includes(join(presentations, 'listing-talk', 'sess-a.json')), 'list-all-sessions lists the real session')
  for (const file of allFiles) {
    assert.ok(realpathSync(file).startsWith(realVault + sep), `list-all-sessions reads only inside the vault: ${relative(scratch, file)}`)
  }
  assert.deepEqual(await listSessionJsonFiles(vault, 'listing-talk'), [join(presentations, 'listing-talk', 'sess-a.json')], 'list-sessions skips a session file linked outside')
  assert.deepEqual(await listSessionJsonFiles(vault, 'linked-talk'), [], 'list-sessions refuses a talk folder linked outside')
  assert.deepEqual(allFiles.filter((file) => file.includes('linked-talk')), [], 'list-all-sessions never enters a talk folder linked outside')
  checks += 9
}

// ── The pathway manifest survived every refused call unchanged ──
assert.equal(readFileSync(join(presentations, 'age-of-the-claw', 'manifest.json'), 'utf8'), MANIFEST_TEXT, 'manifest.json untouched')
checks++

// ── Nothing was created outside the scratch vault / userData ──
const after = treeOutside()
assert.deepEqual(after, before, 'tree outside the vault and userData is unchanged')
checks++
for (const p of tree(vault)) {
  assert.ok(within(presentations, join(scratch, p)) || join(scratch, p) === presentations, `vault write stayed under _PRESENTATIONS: ${p}`)
}
for (const p of tree(userData)) {
  assert.ok(within(userData, join(scratch, p)), `userData write stayed inside userData: ${p}`)
}
checks++

rmSync(scratch, { recursive: true, force: true })
console.log(`recording paths: ${checks} checks passed`)
