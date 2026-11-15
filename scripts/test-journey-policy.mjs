// The journey gate's pass policy (scripts/journeys/policy.mjs) on made-up ledgers: what passes, what fails,
// and that a subset or empty selection never prints a qualifying pass. Also the recording stages' stand-in
// transcript (scripts/journeys/stand-in.mjs) over many key-press timings.
import { strict as assert } from 'node:assert'
import { judgeStage, judgeRun, parseSelection } from './journeys/policy.mjs'
import { requiredIds, CHECKS } from './journeys/checks.mjs'
import { COULD_NOT_ALLOWED } from './journeys/could-not-allowed.mjs'
import { reapProcesses } from './journeys/reap.mjs'
import { parseSrt, parseVtt } from './journeys/video-checks.mjs'
import { standInTranscript, JOIN_SLIDE } from './journeys/stand-in.mjs'
const { slideRows, editorWords, slideVisits } = await import('../src/shared/recording-editor.ts')

const RUN = 'run-1'
const required = ['a.one', 'a.two', 'a.three']
const allow = { 'a.three': { reason: 'test', when: (d) => d?.measured === true } }
const row = (id, result, data = {}, run = RUN) => ({ id, result, data, run, detail: '' })
const judge = (rows, extra = {}) => judgeStage({ name: 'a', required, rows, exit: 0, runId: RUN, allow, ...extra })

// All pass.
let v = judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'PASS')])
assert.equal(v.ok, true, 'all pass: the stage passes')
assert.deepEqual(v.problems, [])

// One fail.
v = judge([row('a.one', 'PASS'), row('a.two', 'FAIL'), row('a.three', 'PASS')])
assert.equal(v.ok, false, 'one FAIL fails the stage')
assert.match(v.problems.join('\n'), /FAIL a\.two/)

// An allowed COULD-NOT, its condition met: passes; condition not met: fails.
v = judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'COULD-NOT', { measured: true })])
assert.equal(v.ok, true, 'an allow-listed COULD-NOT whose condition holds is accepted')
assert.equal(v.allowedCouldNot, 1)
v = judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'COULD-NOT', { measured: false })])
assert.equal(v.ok, false, 'an allow-listed COULD-NOT outside its condition fails')
assert.match(v.problems.join('\n'), /outside its allowed condition/)

// An unexpected COULD-NOT (not on the allow-list).
v = judge([row('a.one', 'PASS'), row('a.two', 'COULD-NOT'), row('a.three', 'PASS')])
assert.equal(v.ok, false, 'a COULD-NOT not on the allow-list fails')
assert.match(v.problems.join('\n'), /not on the allow-list/)

// A missing required id.
v = judge([row('a.one', 'PASS'), row('a.three', 'PASS')])
assert.equal(v.ok, false, 'a required id never reported fails')
assert.deepEqual(v.missing, ['a.two'])

// A duplicate id, an unknown id, a row from another run, a non-zero exit.
assert.equal(judge([row('a.one', 'PASS'), row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'PASS')]).ok, false, 'an id reported twice fails')
assert.equal(judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'PASS'), row('a.extra', 'PASS')]).ok, false, 'an unknown id fails')
assert.equal(judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'PASS', {}, 'old-run')]).ok, false, 'a stale row from an earlier run fails')
assert.equal(judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'PASS')], { exit: 1 }).ok, false, 'a non-zero exit fails')
assert.equal(judge([row('a.one', 'PASS'), row('a.two', 'PASS'), row('a.three', 'PASS'), row('a.harness', 'FAIL')]).ok, false, 'a harness FAIL fails')

// Only COULD-NOT rows, even allowed ones: no check passed.
v = judgeStage({ name: 'b', required: ['b.x'], rows: [row('b.x', 'COULD-NOT', { measured: true })], exit: 0, runId: RUN, allow: { 'b.x': { reason: 't', when: () => true } } })
assert.equal(v.ok, false, 'a stage of only COULD-NOT rows fails')
assert.match(v.problems.join('\n'), /no check passed/)

// An empty ledger.
assert.equal(judge([]).ok, false, 'an empty ledger fails')

// Selection: none, empty, unknown, subset, full.
const ALL = ['s1', 's2', 's3']
assert.deepEqual(parseSelection([], ALL), { mode: 'full', names: ALL })
assert.ok(parseSelection(['--only', ','], ALL).error, '--only , is an error, not an empty pass')
assert.ok(parseSelection(['--only', ''], ALL).error, '--only "" is an error')
assert.ok(parseSelection(['--only'], ALL).error, '--only with no list is an error')
assert.ok(parseSelection(['--only', 's9'], ALL).error, 'an unknown stage is an error')
assert.deepEqual(parseSelection(['--only', 's3,s1'], ALL), { mode: 'subset', names: ['s1', 's3'] })

const ok = (name) => ({ name, ok: true })
let r = judgeRun({ mode: 'full', selected: ALL, allNames: ALL, stages: ALL.map(ok) })
assert.equal(r.verdict, 'PASSED'); assert.equal(r.qualifies, true); assert.equal(r.exitCode, 0)
r = judgeRun({ mode: 'full', selected: ALL, allNames: ALL, stages: [ok('s1'), ok('s2'), { name: 's3', ok: false }] })
assert.equal(r.verdict, 'FAILED'); assert.equal(r.exitCode, 1)
r = judgeRun({ mode: 'full', selected: ALL, allNames: ALL, stages: ALL.map(ok), extraFailures: ['temp: left behind x'] })
assert.equal(r.verdict, 'FAILED', 'a run-level failure (temp, clean-up) fails a full run')
r = judgeRun({ mode: 'full', selected: ALL, allNames: ALL, stages: [ok('s1'), ok('s2')] })
assert.equal(r.verdict, 'FAILED', 'a stage without a verdict fails the run')
r = judgeRun({ mode: 'subset', selected: ['s1'], allNames: ALL, stages: [ok('s1')] })
assert.equal(r.verdict, 'SUBSET OK'); assert.equal(r.qualifies, false, 'a subset run never qualifies')
assert.doesNotMatch(r.line, /PASSED/, 'a subset run never prints PASSED')
r = judgeRun({ mode: 'subset', selected: ALL, allNames: ALL, stages: ALL.map(ok) })
assert.equal(r.qualifies, false, 'a subset naming every stage is still a subset')
r = judgeRun({ mode: 'full', selected: [], allNames: ALL, stages: [] })
assert.equal(r.verdict, 'NO STAGES'); assert.notEqual(r.exitCode, 0, 'an empty selection is never a pass')

// The real registry: unique ids per stage, stage-prefixed, every allow-listed id exists with a reason and a condition.
for (const stage of Object.keys(CHECKS)) {
  for (const ctx of [{ recordAgain: false }, { recordAgain: true }]) {
    const ids = requiredIds(stage, ctx)
    assert.equal(new Set(ids).size, ids.length, `${stage}: ids are unique`)
    assert.ok(ids.length > 0, `${stage}: has checks`)
  }
}
// The updates stage (ADR-0044): its six stable ids.
assert.deepEqual(requiredIds('updates'), ['updates.mark', 'updates.click-only', 'updates.downloads-on-click', 'updates.fits-1000', 'updates.restart-waits', 'updates.restart-after'])
const allIds = Object.keys(CHECKS).flatMap((s) => [...requiredIds(s, { recordAgain: false }), ...requiredIds(s, { recordAgain: true })])
for (const [id, entry] of Object.entries(COULD_NOT_ALLOWED)) {
  assert.ok(allIds.includes(id), `allow-listed ${id} is a real check`)
  assert.ok(entry.reason?.length > 20, `${id} has a reason`)
  assert.equal(typeof entry.when, 'function', `${id} has a condition`)
  assert.equal(entry.when(undefined), false, `${id}: no evidence does not satisfy its condition`)
  assert.equal(entry.when({}), false, `${id}: empty evidence does not satisfy its condition`)
}
// Allow-list conditions bounded to the measured fault: the reviewer's probes do not qualify; measured ones do.
const allowed = (id, d) => COULD_NOT_ALLOWED[id].when(d) === true
assert.equal(allowed('present.status-bar-1280', { items: [{ t: '', w: 0 }] }), false, 'status bar: one empty zero-width item is not the known collapse')
const bar = { items: [{ t: 'Not recording\n ', w: 350 }, { t: 'Not liveNot liveEnd ', w: 96 }, { t: '', w: 0 }, { t: 'Spotlight', w: 0 }, { t: 'Pointer on', w: 0 }, { t: 'Pen on', w: 0 }, { t: 'Clear drawing', w: 0 }, { t: 'Highlight onClear', w: 0 }, { t: 'Section 03:46', w: 0 }, { t: '000', w: 0 }] }
assert.equal(allowed('present.status-bar-1280', bar), true, 'status bar: the measured collapse (recording and live shown, tools present at zero width) qualifies')
assert.equal(allowed('present.status-bar-1280', { items: bar.items.map((i, k) => (k === 0 ? { ...i, w: 0 } : i)) }), false, 'status bar: the recording item collapsed is not the known fault')
assert.equal(allowed('present.status-bar-1280', { items: bar.items.filter((i) => !/^Pen/.test(i.t)) }), false, 'status bar: a tool missing from the bar is not the known fault')
assert.equal(allowed('present.status-bar-1280', { items: bar.items.map((i) => ({ ...i, w: 10 })) }), false, 'status bar: nothing collapsed is a pass, not a COULD-NOT')
assert.equal(allowed('record.saved-note', { savedNote: { text: 'Error', lines: 99 } }), false, 'saved note: wrong words on 99 lines does not qualify')
const note = { savedNote: { text: 'Saved to History as Delivery · 00:55 · Voice saved · slides: complete · camera: complete', lines: 2 }, startAgain: { tag: 'BUTTON', text: 'Start again', visible: true, w: 90, h: 28, buttonLike: true } }
assert.equal(allowed('record.saved-note', note), true, 'saved note: the expected note wrapped to two lines qualifies')
assert.equal(allowed('record.saved-note', { ...note, savedNote: { ...note.savedNote, lines: 1 }, startAgain: { ...note.startAgain, buttonLike: false } }), true, 'saved note: "Start again" drawn as text qualifies')
assert.equal(allowed('record.saved-note', { ...note, savedNote: { ...note.savedNote, lines: 1 } }), false, 'saved note: no fault measured is a pass, not a COULD-NOT')
assert.equal(allowed('record.saved-note', { ...note, startAgain: { ...note.startAgain, visible: false } }), false, 'saved note: a hidden "Start again" does not qualify')
assert.equal(allowed('edit.start-at-sentence', { buttons: 0, notes: 0, sentenceElsewhere: 0 }), false, 'sentence: no button and no note, without the evaluation, does not qualify')
const srows = [{ index: 0, slideId: 'deck-title', change: 0, noClearPause: false, sentenceNear: null, firstWord: 0 }, { index: 1, slideId: 'steps', change: 14378, noClearPause: true, sentenceNear: 24, firstWord: 24 }]
const sdata = { buttons: 0, rows: srows, uiRows: 2, uiSlides: ['deck-title', 'steps'], eligible: [], uiSentenceElsewhere: 0, sentences: 17 }
assert.equal(allowed('edit.start-at-sentence', sdata), true, 'sentence: evaluated over every row, none eligible, the screen agreeing, qualifies')
assert.equal(allowed('edit.start-at-sentence', { ...sdata, rows: [srows[0], { ...srows[1], sentenceNear: 20 }] }), false, 'sentence: a row the rule makes eligible does not qualify')
assert.equal(allowed('edit.start-at-sentence', { ...sdata, uiRows: 3 }), false, 'sentence: rows on screen the evaluation did not cover do not qualify')
assert.equal(allowed('edit.start-at-sentence', { ...sdata, uiSentenceElsewhere: 1 }), false, 'sentence: a "sentence starts at" note on screen does not qualify')

// Clean-up (reap.mjs) on a mocked machine: a group is signalled only under its recorded leader; a reused id or
// a leaderless group is never signalled as a group; leaderless members only when their start time matches.
const machine = (procs, { stubborn = [] } = {}) => {
  const table = new Map(Object.entries(procs).map(([pid, p]) => [Number(pid), p]))
  const kills = []
  const io = {
    procInfo: (pid) => (table.has(pid) ? { pid, ...table.get(pid) } : null),
    groupMembers: (g) => [...table].filter(([, p]) => p.pgid === g).map(([pid]) => pid),
    kill: (t, sig) => {
      kills.push([t, sig])
      const hit = t < 0 ? [...table].filter(([, p]) => p.pgid === -t).map(([pid]) => pid) : [t]
      for (const pid of hit) if (!(stubborn.includes(pid) && sig === 'SIGTERM')) table.delete(pid)
    },
  }
  return { io, kills, table }
}
const noWait = async () => {}
{
  // The recorded app has gone and its group id now belongs to another program: nothing is signalled.
  const m = machine({ 100: { pgid: 100, started: 'Tue 2' }, 101: { pgid: 100, started: 'Tue 2' } })
  const r = await reapProcesses({ entries: [{ kind: 'electron', pid: 100, pgid: 100, started: 'Mon 1' }], myGroup: 1, io: m.io, wait: noWait })
  assert.deepEqual(m.kills, [], 'a reused group id with a different start time is not signalled')
  assert.equal(m.table.size, 2); assert.deepEqual(r.left, [])
}
{
  // The recorded leader is still the same process: its group is signalled, helpers with it.
  const m = machine({ 100: { pgid: 100, started: 'Mon 1' }, 101: { pgid: 100, started: 'Mon 1' }, 300: { pgid: 300, started: 'Mon 1' } })
  const r = await reapProcesses({ entries: [{ kind: 'electron', pid: 100, pgid: 100, started: 'Mon 1' }], myGroup: 1, io: m.io, wait: noWait })
  assert.ok(m.kills.some(([t, sig]) => t === -100 && sig === 'SIGTERM'), 'a matching leader has its group signalled')
  assert.ok(!m.kills.some(([t]) => t === 300 || t === -300), 'another group is never touched')
  assert.deepEqual(r.left, []); assert.equal(m.table.has(300), true)
}
{
  // The leader has gone; its recorded helper still matches; another recorded helper's pid was reused; an
  // unrecorded member is in the group: only the matching recorded helper is signalled, never the group.
  const m = machine({ 101: { pgid: 100, started: 'Mon 1b' }, 102: { pgid: 100, started: 'Wed 9' }, 103: { pgid: 100, started: 'Wed 9' } })
  const entries = [{ kind: 'electron', pid: 100, pgid: 100, started: 'Mon 1' }, { kind: 'electron helper', pid: 101, pgid: 100, started: 'Mon 1b' }, { kind: 'electron helper', pid: 102, pgid: 100, started: 'Mon 1c' }]
  await reapProcesses({ entries, myGroup: 1, io: m.io, wait: noWait })
  assert.deepEqual(m.kills, [[101, 'SIGTERM']], 'a leaderless group: only the recorded member whose start time matches is signalled')
  assert.equal(m.table.has(102) && m.table.has(103), true)
}
{
  // A member that ignores SIGTERM gets SIGKILL, re-checked first; one that never exits is reported.
  const m = machine({ 100: { pgid: 100, started: 'Mon 1' }, 101: { pgid: 100, started: 'Mon 1' } }, { stubborn: [101] })
  const r = await reapProcesses({ entries: [{ kind: 'electron', pid: 100, pgid: 100, started: 'Mon 1' }], myGroup: 1, io: m.io, wait: noWait })
  assert.ok(m.kills.some(([t, sig]) => t === 101 && sig === 'SIGKILL'), 'a helper seen under the live leader is killed after SIGTERM fails')
  assert.ok(!m.kills.some(([t, sig]) => t === -100 && sig === 'SIGKILL'), 'once the leader has gone its group is not signalled again')
  assert.deepEqual(r.left, [])
}
{
  // Caption timestamps are read in each format's own syntax, on both ends of the cue.
  const vtt = (a, b) => parseVtt(`WEBVTT\n\n${a} --> ${b}\nwords`)
  const srt = (a, b) => parseSrt(`1\n${a} --> ${b}\nwords`)
  assert.deepEqual(vtt('00:00:01.000', '00:00:02.500').problems, [])
  assert.equal(vtt('00:00:01.000', '00:00:02.500').cues[0].end, 2500)
  assert.equal(vtt('00:00:01.000', '00:00:02,500').problems.length, 1, 'a comma in a WebVTT end time is invalid')
  assert.equal(vtt('00:00:01,000', '00:00:02.500').problems.length, 1, 'a comma in a WebVTT start time is invalid')
  assert.equal(vtt('00:00:01.000', '00:61:02.500').problems.length, 1, 'minutes above 59 are invalid')
  assert.deepEqual(srt('00:00:01,000', '00:00:02,500').problems, [])
  assert.equal(srt('00:00:01,000', '00:00:02.500').problems.length, 1, 'a full stop in a SubRip end time is invalid')
  assert.equal(srt('00:00:01,000', '00:00:75,500').problems.length, 1, 'seconds above 59 are invalid')
}
{
  // The stand-in speaks across the change into JOIN_SLIDE whatever the key presses' timing: by the editor's own
  // row rule that slide has no clear pause near its change and starts at the sentence spoken across it, with and
  // without precise word timing (the sentence stage's check). Marks as a journey Run saved them, then jittered.
  const MARKS = [[0, 'deck-title'], [710, 'before-the-walk'], [2239, 'why'], [3723, 'loop'], [14364, 'steps'], [21142, 'row3'], [27348, 'iconlist'], [40992, 'along-the-river'], [42504, 'the-old-mill'], [43999, 'what-to-say-at-the-mill'], [45440, 'video'], [50013, 'after-the-walk']]
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const placed = (D, marks, aligned) => {
    const tr = standInTranscript(D, marks)
    if (!aligned) { tr.words = tr.words.map(({ alignment, ...w }) => w); delete tr.alignment }
    const k = slideVisits(marks).findIndex((v) => v.slideId === JOIN_SLIDE)
    const r = slideRows(editorWords(tr, D), marks, [])[k]
    return { ok: !!r && r.noClearPause && r.sentenceNear !== null && r.sentenceNear === r.firstWord, row: r && { index: r.index, noClearPause: r.noClearPause, sentenceNear: r.sentenceNear, firstWord: r.firstWord } }
  }
  for (let n = 0; n < 400; n++) {
    let drift = 0
    const marks = MARKS.map(([t, slideId], i) => { if (i > 0) drift += (rnd() - 0.5) * 900; return { event: 'enter', slideId, tMs: Math.max(1, t + drift) } })
    const D = 51574 + drift
    for (const aligned of [true, false]) { const p = placed(D, marks, aligned); assert.ok(p.ok, `timing ${n} (${aligned ? 'aligned' : 'plain'}): ${JOIN_SLIDE} ${JSON.stringify(p.row)}`) }
  }
  // A Run without room around that slide, or without it, is refused by name, never joined elsewhere.
  const tight = MARKS.map(([t, slideId]) => ({ event: 'enter', slideId, tMs: slideId === 'iconlist' ? 24000 : t }))
  assert.throws(() => standInTranscript(51574, tight), /row3.*more than 4000 ms/)
  assert.throws(() => standInTranscript(51574, MARKS.filter(([, id]) => id !== 'row3').map(([t, slideId]) => ({ event: 'enter', slideId, tMs: t }))), /row3 0 times/)
}
console.log('journey policy: all assertions passed')
