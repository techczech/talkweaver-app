// Release 0.44.5, Record one slide again: every editor and Studio command that takes or gives a position in
// time, run over one fixture family with new takes, and checked on the video clock. Each command is checked
// where the position is (a) before every take, (b) exactly where a take goes in, (c) inside a take, (d) after
// the takes, (e) where two takes go in at one point. The table this runs is in the 0.44.5 build record
// ("Commands and the two clocks"). Where a command is not available inside a take it must refuse plainly.
import assert from 'node:assert/strict'
import { applyEditOp, emptyEdits } from '../src/shared/recording-edits.ts'
import { captionCuesOf, changeVideoStart, cutWordsOp, editorWords, leaveOutOp, planDigest, resolveRecording, rowAtPlayback, rowVideoStart, tidyProposals, wordsRange } from '../src/shared/recording-editor.ts'
import { fromVideoClock, takeAt } from '../src/shared/recording-takes.ts'
import { chaptersFor, faceTrack, faceTrackOnClock, planEditedToRun, toSrt, toWebVtt } from '../src/shared/recording-video.ts'
import { edgeVolume, flagPlayback, joinPlayback, runStretchPlayback, takeEdges, trackPlayhead, trackSeek, trimAtPlayhead, TRIM_IN_TAKE, wordAtPlayback } from '../src/shared/recording-positions.ts'
import { dissolveWindows, splitAtEdges, voiceSplicePlan } from '../src/shared/recording-joins.ts'
import { layersOnVideoClock } from '../src/main/recording-video.ts'

let count = 0
const check = (name, fn) => { fn(); console.log(`PASS ${++count} ${name}`) }

// ---- The fixture family ---------------------------------------------------------------------------------
// A 10 s Run, slides a, b, c, c2, d, e. b, c and c2 are recorded again: b's take (1.5 s) goes in at 2000;
// c's and c2's (1 s each) both go in at 4400, where d starts and its first word "three" is said. c and c2
// have no length of their own (their starts were moved to d's). Clean pauses separate the slides.
//
//   video:  a 0–2000 | tb 2000–3500 | (b's own 2000–4400, cut) 3500–5900 | tc 5900–6900 | tc2 6900–7900 | d from 7900 | e from 10500 | end 13500
//
// F1 is the same with c2's take not chosen: one take (tc, 5900–6900) at 4400 and d from 6900.
const w = (text, start, end) => ({ text, start, end })
const D = 10_000
const marks = [['a', 0], ['b', 2000], ['c', 4000], ['c2', 4200], ['d', 4300], ['e', 7000]].map(([slideId, tMs]) => ({ event: 'enter', slideId, tMs }))
const transcript = {
  words: [w('one', 100, 900), w('more', 1000, 1700), w('two', 2300, 2900), w('again', 3000, 3700), w('three', 4400, 5500), w('so', 5600, 6700), w('four', 7300, 8400), w('end', 8500, 9700)],
  silence: [{ start: 0, end: 100 }, { start: 1700, end: 2300 }, { start: 3700, end: 4400 }, { start: 6700, end: 7300 }, { start: 9700, end: 10_000 }]
}
const ctx = editorWords(transcript, D)
const word = (text) => ctx.words.findIndex((x) => x.text === text)
const TAKES = { tb: { change: 2000, run: 'tb', durationMs: 1500, words: [w('bee', 100, 600)] }, tc: { change: 4000, run: 'tc', durationMs: 1000, words: [w('sea', 100, 600)] }, tc2: { change: 4200, run: 'tc2', durationMs: 1000, words: [w('see', 100, 600)] } }
const BASE = { ...emptyEdits(), boundaries: [{ change: 4000, at: 4400 }, { change: 4200, at: 4400 }, { change: 4300, at: 4400 }] }
const resolve = (edits = BASE, takes = ['tb', 'tc', 'tc2']) => resolveRecording({ durationMs: D, edits, marks, ctx, transcript, takes: takes.map((t) => TAKES[t]) })
const F2 = resolve(), F1 = resolve(BASE, ['tb', 'tc'])
const row = (r, slideId) => r.rows.find((x) => x.slideId === slideId)
const edited = (r, ops) => resolve(ops.reduce((e, op) => applyEditOp(e, op, D), BASE))
const kept = (r) => r.spans.map((s) => [s.startMs, s.endMs].map(Math.round))
const inTake = (r, v) => !!takeAt(r.clock, v)

check('the fixture: rows, takes and the video clock as drawn above', () => {
  assert.deepEqual(F2.rows.map((x) => [x.slideId, x.start, x.end]), [['a', 0, 2000], ['b', 2000, 4400], ['c', 4400, 4400], ['c2', 4400, 4400], ['d', 4400, 7000], ['e', 7000, 10_000]])
  assert.deepEqual(F2.clock.inserts.map((i) => [i.run, i.at, i.outAt]), [['tb', 2000, 2000], ['tc', 4400, 5900], ['tc2', 4400, 6900]])
  assert.deepEqual(kept(F2), [[0, 3500], [5900, 13_500]]); assert.equal(F2.clockMs, 13_500)
  assert.deepEqual(F1.clock.inserts.map((i) => [i.run, i.outAt]), [['tb', 2000], ['tc', 5900]]); assert.equal(F1.clockMs, 12_500)
})

// ---- Playing ----------------------------------------------------------------------------------------------
check('play from a row: (a) a at 0; (b) b at its take; (d) e after every take; (e) c, c2 and d one after the other', () => {
  assert.deepEqual(['a', 'b', 'c', 'c2', 'd', 'e'].map((s) => rowVideoStart(F2, row(F2, s))), [0, 2000, 5900, 6900, 7900, 10_500])
  assert.equal(rowVideoStart(F1, row(F1, 'd')), 6900, '(b) one take at d\'s start: d after it')
})
const playWord = (r, text) => { const x = ctx.words[word(text)]; return runStretchPlayback(r, { start: x.start, end: x.end }) }
const playSel = (r, a, b) => { const i = word(a), j = word(b); return runStretchPlayback(r, wordsRange(ctx, i, j), { firstStart: ctx.words[i].start, lastEnd: ctx.words[j].end }) }
check('play a word: (a) before the takes; (b) at an insertion point, after its take; (c) no word plays inside a take; (d) after; (e) after both takes', () => {
  assert.deepEqual(playWord(F2, 'one'), { from: 100, until: 900 })
  assert.deepEqual(playWord(F1, 'three'), { from: 6900, until: 8000 }, '(b) the word at the insertion point plays after the take, and stops at its own end')
  assert.deepEqual(playWord(F2, 'four'), { from: 10_800, until: 11_900 })
  assert.deepEqual(playWord(F2, 'three'), { from: 7900, until: 9000 }, '(e)')
  for (const r of [F1, F2]) for (const x of ctx.words) { const p = runStretchPlayback(r, x); if (p.until > p.from) assert.ok(!inTake(r, p.from), `(c) ${x.text} never starts inside a take`) }
})
check('play a selection: lead-in and tail pauses stay on their side of a take; takes between the words play', () => {
  const ab = playSel(F2, 'one', 'more'); assert.ok(ab.from <= 100 && ab.until >= 1700 && ab.until <= 2000, `(a) ${JSON.stringify(ab)}: stops before b's take`)
  assert.deepEqual(playSel(F1, 'three', 'so'), { from: 6900, until: 9500 }, '(b) starts after the take, not in it')
  assert.deepEqual(playSel(F2, 'three', 'so'), { from: 7900, until: 10_500 }, '(e) starts after both takes')
  const across = playSel(F2, 'more', 'three'); assert.ok(across.from < 2000 && across.until >= 9000, `takes between the words play: ${JSON.stringify(across)}`)
  const de = playSel(F2, 'four', 'end'); assert.ok(de.from >= 10_500 && de.until <= 13_500, '(d)')
})
check('listen to the join: a second either side as the video plays it, takes included', () => {
  assert.deepEqual(joinPlayback(F2, { start: 1000, end: 1700 }, [{ start: 1000, end: 1700 }]), { from: 0, until: 2700 }, '(a) the take after the join is heard')
  assert.deepEqual(joinPlayback(F1, { start: 4400, end: 5500 }, [{ start: 4400, end: 5500 }]), { from: 5900, until: 9000 }, '(b) the take on the left of a join at its insertion point')
  assert.deepEqual(joinPlayback(F2, { start: 4400, end: 5500 }, [{ start: 4400, end: 5500 }]), { from: 6900, until: 10_000 }, '(e) the second take on the left')
  assert.deepEqual(joinPlayback(F2, { start: 7300, end: 8400 }, [{ start: 7300, end: 8400 }]), { from: 9800, until: 12_900 }, '(d)')
})

// ---- Where the playhead is, and what is lit ----------------------------------------------------------------
check('Run-time tracks (timeline, overview, Studio): a click goes to its Run moment, a slide start to its first take; the playhead rests where a take goes in', () => {
  assert.deepEqual([500, 2000, 8000, 4400].map((t) => trackSeek(F2, t)), [500, 2000, 11_500, 5900])
  assert.deepEqual([500, 2000, 2700, 11_500, 6400, 7400].map((v) => trackPlayhead(F2, v)), [500, 2000, 2000, 8000, 4400, 4400])
})
check('the highlighted row (and auto-scroll, the slide label) and word follow the take playing', () => {
  const rowAt = (r, v) => r.rows[rowAtPlayback(r, fromVideoClock(r.clock, v), v)].slideId
  assert.deepEqual([500, 2000, 2700, 11_500, 6400, 7400, 8000].map((v) => rowAt(F2, v)), ['a', 'b', 'b', 'e', 'c', 'c2', 'd'])
  const wordAtV = (v) => { const i = wordAtPlayback(F2, ctx, fromVideoClock(F2.clock, v), v); return i < 0 ? null : ctx.words[i].text }
  assert.deepEqual([500, 2000, 2700, 11_000, 6400, 7400, 8000].map(wordAtV), ['one', null, null, 'four', null, null, 'three'])
})
check('To check: a flag\'s time and Go are on the video clock (three seconds of the video before it)', () => {
  assert.deepEqual(flagPlayback(F2, 800), { editedMs: 800, from: 0 }, '(a)')
  assert.deepEqual(flagPlayback(F1, 4400), { editedMs: 4500, from: 1500 }, '(b) a flag where a take goes in: after the take')
  assert.deepEqual(flagPlayback(F2, 4400), { editedMs: 5500, from: 2500 }, '(e)')
  assert.deepEqual(flagPlayback(F2, 8000), { editedMs: 9100, from: 8500 }, '(d)')
})
check('Studio\'s "Go to slide n" goes where that slide\'s chapter starts', () => {
  assert.deepEqual([0, 2000, 4000, 4200, 4300, 7000].map((t) => changeVideoStart(F2, t)), [0, 2000, 5900, 6900, 7900, 10_500])
})

// ---- Trims ------------------------------------------------------------------------------------------------
const trim = (r, kind, v) => trimAtPlayhead(r, kind, v)
const trimmed = (kind, v) => { const t = trim(F2, kind, v); assert.ok(t.ok, `${kind} at ${v}: ${t.error}`); return kept(edited(F2, [t.op])) }
check('trim end here: every take after the end goes; (c) and between takes refused', () => {
  assert.deepEqual(trimmed('trim-end', 1000), [[0, 1000]], '(a) the four… every later take goes too')
  assert.deepEqual(trimmed('trim-end', 2000), [[0, 2000]], '(b) at the start of a take: the take goes')
  assert.deepEqual(trimmed('trim-end', 5900), [[0, 3500]], '(e) at the first of two takes: both go')
  assert.deepEqual(trimmed('trim-end', 11_500), [[0, 3500], [5900, 11_500]], '(d)')
  for (const v of [2700, 6400, 6900, 7400, 7900, 3500]) assert.deepEqual(trim(F2, 'trim-end', v), { ok: false, error: TRIM_IN_TAKE }, `refused at ${v}`)
})
check('trim start here: every take before the start goes; (c) and between takes refused', () => {
  assert.deepEqual(trimmed('trim-start', 1000), [[1000, 3500], [5900, 13_500]], '(a)')
  assert.deepEqual(trimmed('trim-start', 2000), [[2000, 3500], [5900, 13_500]], '(b) at the start of a take: the take stays')
  assert.deepEqual(trimmed('trim-start', 5900), [[5900, 13_500]], '(e) at the first of two takes: both stay')
  assert.deepEqual(trimmed('trim-start', 11_500), [[11_500, 13_500]], '(d) every take before goes')
  for (const v of [2700, 6400, 6900, 7900]) assert.equal(trim(F2, 'trim-start', v).ok, false, `refused at ${v}`)
})
check('a trim keeps the take choices, so Undo brings the takes back', () => {
  const e = applyEditOp(BASE, trim(F2, 'trim-end', 1000).op, D)
  assert.deepEqual(e.takes, BASE.takes)
  const back = applyEditOp(e, { kind: 'undo' }, D)
  assert.deepEqual(kept(resolve(back)), kept(F2)); assert.deepEqual(kept(edited(F2, [{ kind: 'trim-end', at: 1000 }, { kind: 'undo' }, { kind: 'redo' }])), [[0, 1000]])
})

// ---- Edits of the recording's own words and slides ---------------------------------------------------------
const cutOf = (a, b) => { const op = cutWordsOp(ctx, word(a), word(b)); assert.ok(!('error' in op), op.error); return op.op }
check('cut a selection: only the recording\'s own words go; takes stay whole; (c) a take\'s words are not words of the editor', () => {
  assert.ok(!edited(F2, [cutOf('one', 'one')]).spans.some((s) => s.startMs <= 500 && s.endMs > 500), '(a) the word goes')
  const e = edited(F2, [cutOf('three', 'three')])
  assert.deepEqual(e.clock.inserts.map((i) => [i.run, i.outAt, i.length]), F2.clock.inserts.map((i) => [i.run, i.outAt, i.length]), '(e) both takes stay')
  assert.ok(e.spans.some((s) => s.startMs <= 5900 && s.endMs >= 7900), '(e) the takes play whole')
  assert.ok(!e.spans.some((s) => s.startMs < 8600 && s.endMs > 8400), '(e) "three" (video 7900–9000) is cut')
  assert.ok(ctx.words.every((x) => !['bee', 'sea', 'see'].includes(x.text)), '(c)')
})
check('leave out a slide: its own stretch and its take go; neighbouring takes stay', () => {
  const b = edited(F2, [leaveOutOp(row(F2, 'b'))]); assert.deepEqual(b.clock.inserts.map((i) => i.run), ['tc', 'tc2'], '(b) b\'s take goes with it')
  const c = edited(F2, [leaveOutOp(row(F2, 'c'))]); assert.deepEqual(c.clock.inserts.map((i) => [i.run, i.outAt]), [['tb', 2000], ['tc2', 5900]], '(e) one of two takes at a point')
  const d = edited(F2, [leaveOutOp(row(F2, 'd'))]); assert.deepEqual(d.clock.inserts.map((i) => i.outAt), [2000, 5900, 6900], '(e) d\'s own words go; the takes before it stay')
  assert.ok(!d.spans.some((s) => s.startMs < 10_500 && s.endMs > 7900), 'd (7900–10500) is cut')
})
check('move a slide\'s start, put it back: its take goes in at the new start; chapters, rows and takes agree', () => {
  for (const r of [F2, edited(F2, [{ kind: 'boundary', change: 2000, at: 2300 }]), edited(F2, [{ kind: 'boundary', change: 4300, at: null }]), edited(F2, [{ kind: 'boundary', change: 4200, at: null }])]) {
    for (const x of r.rows) if (r.replacedRows.has(x.index)) {
      const i = r.clock.inserts.find((k) => k.change === x.change)
      assert.equal(i.at, Math.round(x.start)); assert.equal(rowVideoStart(r, x), i.outAt)
      assert.equal(r.chapterMarks.find((c) => c.slideId === x.slideId).tMs, i.outAt)
    }
  }
  assert.equal(edited(F2, [{ kind: 'boundary', change: 2000, at: 2300 }]).clock.inserts[0].at, 2300, '(b) b\'s take moves with b\'s start')
})
check('Tidy up proposes nothing inside a stretch a take replaces; applying its proposals keeps every take whole', () => {
  const t = tidyProposals(ctx, F2.rows, marks, F2.cuts)
  for (const p of t.proposals) assert.ok(!(p.range.start < 4400 && p.range.end > 2000) || p.savesMs === 0, `no proposal inside b's replaced stretch: ${JSON.stringify(p.range)}`)
  const all = edited(F2, t.proposals.map((p) => ({ kind: 'cut', ranges: [p.range] })))
  assert.deepEqual(all.clock.inserts.map((i) => i.length), [1500, 1000, 1000])
  for (const i of all.clock.inserts) assert.ok(all.spans.some((s) => s.startMs <= i.outAt && s.endMs >= i.outAt + i.length), `${i.run} plays whole`)
})
check('choose a take, use the first take, Undo and Redo: the clock follows, and comes back exactly', () => {
  const first = applyEditOp(applyEditOp(BASE, { kind: 'take', change: 2000, run: 'tb' }, D), { kind: 'take', change: 2000, run: null }, D)
  const r = resolve(first, ['tc', 'tc2'])
  assert.deepEqual(r.clock.inserts.map((i) => [i.run, i.outAt]), [['tc', 4400], ['tc2', 5400]], 'the first take of b: b\'s own stretch plays')
  const undone = applyEditOp(first, { kind: 'undo' }, D)
  assert.deepEqual(undone.takes, [{ change: 2000, run: 'tb' }])
})

// ---- What is written --------------------------------------------------------------------------------------
check('chapters: each slide where it plays; (e) c, c2 and d one after the other', () => {
  const titles = Object.fromEntries(['a', 'b', 'c', 'c2', 'd', 'e'].map((s) => [s, { title: s }]))
  assert.deepEqual(F2.chapterMarks.map((c) => [c.slideId, c.tMs]), [['a', 0], ['b', 2000], ['c', 5900], ['c2', 6900], ['d', 7900], ['e', 10_500]])
  assert.deepEqual(chaptersFor(F2.chapterMarks, titles, F2.spans).map((c) => [c.title, c.startMs]), [['a', 0], ['b', 2000], ['c', 3500], ['c2', 4500], ['d', 5500], ['e', 8100]])
})
check('captions (SRT and WebVTT): every word where it plays, the takes\' words in their takes', () => {
  assert.deepEqual(F2.captionWords.map((x) => [x.text, x.start]), [['one', 100], ['more', 1000], ['bee', 2100], ['sea', 6000], ['see', 7000], ['three', 7900], ['so', 9100], ['four', 10_800], ['end', 12_000]])
  const cues = captionCuesOf(F2).cues
  for (const text of [toSrt(cues), toWebVtt(cues)]) assert.equal(text.match(/[a-z]+/g).filter((x) => ['one', 'more', 'bee', 'sea', 'see', 'three', 'so', 'four', 'end'].includes(x)).join(' '), 'one more bee sea see three so four end')
})
check('face: each take with its own slide\'s choice; the recording\'s stretches with theirs', () => {
  const corner = { layout: 'corner', corner: 'bottom-right', size: 'medium' }
  const faces = { all: corner, slides: [{ change: 2000, face: { ...corner, layout: 'side' } }, { change: 4000, face: { ...corner, layout: 'face' } }, { change: 4200, face: { ...corner, layout: 'slide' } }] }
  const track = faceTrackOnClock(faceTrack(F2.rows, faces, D), F2.clock, faces)
  const at = (v) => track.find((s) => v >= s.start && v < s.end)?.face.layout
  assert.deepEqual([500, 2700, 6400, 7400, 8000, 11_000].map(at), ['corner', 'side', 'face', 'slide', 'corner', 'corner'])
})
check('even volume measures the voice as composed: the pieces cover the video clock once, in order', () => {
  const layer = (run, ms) => ({ slides: [], camera: [], voice: [{ path: `${run}.webm`, startMs: 0, endMs: ms }], missing: [] })
  const v = layersOnVideoClock(layer('run', D), new Map(Object.values(TAKES).map((t) => [t.run, layer(t.run, t.durationMs)])), F2.clock, F2.clockMs).voice.sort((a, b) => a.startMs - b.startMs)
  assert.equal(v[0].startMs, 0); assert.equal(v.at(-1).endMs, F2.clockMs)
  v.forEach((p, k) => k && assert.equal(p.startMs, v[k - 1].endMs, `piece ${k} follows the one before it`))
})
check('smooth joins at a take\'s edges: the export treats each edge as a join (the picture dissolves, the sound fades out and in)', () => {
  assert.deepEqual(takeEdges(F2.clock), [2000, 3500, 5900, 6900, 7900])
  const split = splitAtEdges(F2.spans, takeEdges(F2.clock))
  assert.deepEqual(split.map((s) => [Math.round(s.startMs), Math.round(s.endMs)]), [[0, 2000], [2000, 3500], [5900, 6900], [6900, 7900], [7900, 13_500]])
  assert.equal(split.reduce((n, s) => n + s.endFrame - s.startFrame, 0), F2.spans.reduce((n, s) => n + s.endFrame - s.startFrame, 0), 'no frame added or lost')
  assert.equal(dissolveWindows(split).length, 4, 'a dissolve after every edge and the cut')
  const plan = voiceSplicePlan(split, Math.round(F2.clockMs * 30 / 1000), true)
  for (let k = 1; k < plan.length; k++) assert.ok(plan[k].from >= plan[k - 1].to || plan[k].op === 'mix-b', `the splice reads its input once, in order (${k})`)
  const at = (ms) => ms * 48
  assert.ok(plan.some((p) => p.op === 'fade-out' && p.to === at(2000)) && plan.some((p) => p.op === 'fade-in' && p.from === at(2000)), 'the sound fades out and in at a take\'s start')
  assert.equal(edgeVolume(takeEdges(F2.clock), 2000), 0); assert.equal(edgeVolume(takeEdges(F2.clock), 2100), 1, 'the player fades at the same edges')
})
check('the export plan and its digest follow the video clock: the takes, their order and trims change it', () => {
  const digests = new Set([F2, F1, edited(F2, [{ kind: 'trim-end', at: 1000 }]), edited(F2, [leaveOutOp(row(F2, 'c'))])].map((r) => planDigest(r)))
  assert.equal(digests.size, 4)
  assert.equal(planDigest(resolve()), planDigest(F2), 'main resolves the same plan from the same files')
  assert.ok(Math.abs(planEditedToRun(F2.spans, F2.editedMs) - F2.clockMs) <= 34)
})
console.log(`\n${count} passed`)
