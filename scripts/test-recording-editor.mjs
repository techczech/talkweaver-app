// Slice 3 (recording editor): the pure functions behind the editor screen — rows by the Slide boundary
// rule, moved slide starts in the sidecar (version 4), clean and close cut edges, word and slide cuts,
// "Move to the nearest pause", and Tidy up's proposals — plus a timing check on a generated hour-long
// Run (about 9,000 words, 80 slides). Plain Node.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { applyEditOp, effectiveCuts, emptyEdits, fitEditsBudget, parseEdits, parseEditsText, RECORDING_EDITS_VERSION, serialiseEdits, EDITS_WRITE_BUDGET } from '../src/shared/recording-edits.ts'
import { captionCues, chaptersFor, frameOf, keptSpans, msOfFrame } from '../src/shared/recording-video.ts'
import { alignedCutEdge, CLEAN_CUT } from '../src/shared/transcript-contract.ts'
import { boundaryTargets, joinsAtSentence, TARGET_WORDS, planDigest, cutWordsOp, edgeQuality, EDITOR_THRESHOLDS, editorWords, isLeftOut, leaveOutOp, moveBoundaryOp, nearestCleanEdge, projectWordTimes, putBackOp, putBoundaryBackOp, resolveRecording, restoreOp, slideRows, slideVisits, tidyProposals, wordAt, wordsRange } from '../src/shared/recording-editor.ts'
import { createRecordingEditsStore } from '../src/main/recording-edits-store.ts'
import { registerRecordingVideoIpc } from '../src/main/recording-video-ipc.ts'
import { TAKE_STEP_OFF_ERROR, TAKES_OFF_ERROR } from '../src/shared/recording-takes.ts'
import { makeEditorFixture, ORIGINAL_LATE_MS, ORIGINAL_RUN_ON_MS } from './fixtures/recording-editor-fixture.mjs'

let count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const root = mkdtempSync(join(tmpdir(), 'tw-recording-editor-'))
const w = (text, start, end, extra = {}) => ({ text, start, end, ...extra })
const cutOp = (ctx, a, b) => { const r = cutWordsOp(ctx, a, b); assert.ok(r.op, r.error); return r.op }
const noEdits = { cuts: [], boundaries: [], leftOut: [], restoredTrims: [] }
const resolve = (ctx, edits, marks = [], extra = {}) => resolveRecording({ durationMs: ctx.durationMs, ctx, edits: { ...noEdits, ...edits }, marks, ...extra })
const cutWords = (r) => [...r.wordCut].flatMap((c, i) => (c ? [i] : []))

try {
  // ---- Clean or close ---------------------------------------------------------------------------
  {
    assert.deepEqual(EDITOR_THRESHOLDS.clean, CLEAN_CUT, 'one named place: the editor uses slice 2\'s measured thresholds')
    // A 600 ms pause between "one" and "two", a 300 ms one between "two" and "three".
    const ctx = editorWords({ words: [w('one', 1000, 1400), w('two', 2000, 2400), w('three', 2700, 3100)], silence: [{ start: 1400, end: 2000 }, { start: 2400, end: 2700 }] }, 5000)
    assert.equal(ctx.gaps[1].quality, 'clean'); assert.equal(ctx.gaps[1].point, 1700); assert.equal(ctx.gaps[1].cleanPause, true)
    assert.equal(ctx.gaps[2].quality, 'close', 'a pause under 500 ms is not clean without alignment'); assert.equal(ctx.gaps[2].cleanPause, false)
    assert.equal(ctx.gaps[0].point, 0); assert.equal(ctx.gaps[3].point, 5000)
    assert.equal(edgeQuality(ctx, 1700, 'start'), 'clean')
    assert.equal(edgeQuality(ctx, 1600, 'start'), 'clean', '200 ms kept before a start edge is enough')
    assert.equal(edgeQuality(ctx, 1590, 'start'), 'close', '190 ms is not')
    assert.equal(edgeQuality(ctx, 1800, 'end'), 'clean'); assert.equal(edgeQuality(ctx, 1810, 'end'), 'close')
    assert.equal(edgeQuality(ctx, 2550, 'start'), 'close', 'inside a short pause')
    assert.equal(edgeQuality(ctx, 1200, 'start'), 'close', 'inside a word')
    assert.equal(edgeQuality(ctx, 0, 'start'), 'clean'); assert.equal(edgeQuality(ctx, 5000, 'end'), 'clean')
    pass('cut edges: clean inside 500 ms of measured silence with 200 ms kept, close otherwise; without alignment only pauses count')
  }
  {
    // Aligned: two confident words in one segment share a midpoint; it is clean, exactly as alignedCutEdge says.
    const a = (s, e, c = 0.9) => ({ status: 'aligned', confidence: c, normalised: 'x', unsupported: [], start: s, end: e })
    const words = [w('a', 0, 300, { alignment: a(0, 300) }), w('b', 340, 600, { alignment: a(340, 600) }), w('c', 640, 900, { alignment: a(640, 900, 0.2) }), w('d', 940, 1200, { alignment: a(940, 1200) })]
    const alignment = { version: 1, model: 'm', revision: 'r', sha256: 'x', alignedAt: 'now', normalisation: 'ctc-nfc-v1', midpoints: [320, 620, 920] }
    const segments = [{ start: 0, end: 1300 }]
    const ctx = editorWords({ words, alignment, segments }, 2000)
    assert.equal(ctx.gaps[1].quality, 'clean'); assert.equal(ctx.gaps[1].aligned, true); assert.equal(ctx.gaps[1].point, 320)
    assert.equal(ctx.gaps[2].quality, 'close', 'a low-confidence word makes its midpoints close')
    assert.equal(alignedCutEdge(320, 'start', [], words, alignment, { segments }).quality, 'clean')
    assert.equal(alignedCutEdge(620, 'start', [], words, alignment, { segments }).quality, 'tight', 'agrees with the transcript contract')
    assert.equal(edgeQuality(ctx, 320, 'start'), 'clean'); assert.equal(edgeQuality(ctx, 321, 'end'), 'clean', 'within a millisecond: the sidecar stores whole ms')
    assert.equal(edgeQuality(ctx, 620, 'end'), 'close')
    const split = editorWords({ words, alignment, segments: [{ start: 0, end: 320 }, { start: 320, end: 1300 }] }, 2000)
    assert.equal(split.gaps[1].quality, 'close', 'midpoints across transcript segments are unmeasured, so close')
    pass('aligned shared midpoints between confident words in one segment are clean; others are close')
  }

  // ---- Rows by the Slide boundary rule ---------------------------------------------------------
  {
    // Stretch A (0.5–2.0 s) | clean pause | stretch B (2.6–5.0 s) | clean pause | stretch C (5.6–6.4 s).
    const words = [w('a1', 500, 1000), w('a2', 1050, 2000), w('b1', 2600, 3000), w('b2', 3050, 4000), w('b3', 4050, 5000), w('c1', 5600, 6400)]
    const silence = [{ start: 0, end: 500 }, { start: 2000, end: 2600 }, { start: 5000, end: 5600 }, { start: 6400, end: 8000 }]
    const ctx = editorWords({ words, silence }, 8000)
    // The click to slide 2 falls inside B at 3.2 s: 0.6 s of B before it, 1.75 s after → B goes to slide 2.
    let rows = slideRows(ctx, [{ event: 'enter', slideId: 'one', tMs: 100 }, { event: 'enter', slideId: 'two', tMs: 3200 }])
    assert.equal(rows.length, 2)
    assert.deepEqual([rows[0].firstWord, rows[0].endWord, rows[1].firstWord, rows[1].endWord], [0, 2, 2, 6])
    assert.equal(rows[1].start, 2300, 'slide 2 starts at the clean pause before its first stretch'); assert.equal(rows[1].startQuality, 'clean')
    assert.equal(rows[1].click, 3, 'the picture changed before b2: a tick there'); assert.equal(rows[1].noClearPause, false)
    // The click at 4.4 s: 1.4 s of B before, 0.6 s after → B stays on slide 1.
    rows = slideRows(ctx, [{ event: 'enter', slideId: 'one', tMs: 100 }, { event: 'enter', slideId: 'two', tMs: 4400 }])
    assert.deepEqual([rows[0].endWord, rows[1].firstWord], [5, 5]); assert.equal(rows[1].start, 5300); assert.equal(rows[1].click, 4)
    // A tie goes to the earlier slide: B spoken 2.6–3.0 and 3.05–4.0 and 4.05–5.0 = 2.3 s; split at 3.825.
    rows = slideRows(ctx, [{ event: 'enter', slideId: 'one', tMs: 100 }, { event: 'enter', slideId: 'two', tMs: 3825 }])
    assert.equal(rows[1].firstWord, 5, 'a tie goes to the earlier slide')
    // Deterministic.
    assert.deepEqual(slideRows(ctx, [{ event: 'enter', slideId: 'one', tMs: 100 }, { event: 'enter', slideId: 'two', tMs: 3825 }]), rows)
    pass('a stretch between clean pauses goes whole to the slide holding more of its spoken time; a tie to the earlier slide; the click shows as a tick')
  }
  {
    // No clean pause within two seconds of the change: words run on with 40 ms gaps for 8 s.
    const words = Array.from({ length: 20 }, (_, i) => w(`w${i}`, 1000 + i * 400, 1360 + i * 400))
    const ctx = editorWords({ words, silence: [{ start: 0, end: 1000 }, { start: 9000, end: 12000 }] }, 12_000)
    const marks = [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'enter', slideId: 'two', tMs: 5000 }, { event: 'reveal', slideId: 'two', tMs: 7000, hidden: 1 }]
    const rows = slideRows(ctx, marks)
    assert.equal(rows[1].noClearPause, true, 'the editor says so on that slide')
    assert.equal(rows[1].firstWord, rows[1].endWord, 'all the words stay with slide 1 until the owner chooses')
    assert.deepEqual(rows[1].steps.map((s) => s.tMs), [7000])
    // The owner chooses a word (explicit): a close boundary, stored, and the notice goes.
    const targets = boundaryTargets(ctx, rows, 1, true)
    assert.ok(targets.length > 5 && targets.every((t) => t.quality === 'close'))
    assert.equal(boundaryTargets(ctx, rows, 1, false).length, 0, 'no clean pause to snap to')
    const op = moveBoundaryOp(ctx, rows[1], 10, true)
    assert.equal(op.kind, 'boundary'); assert.equal(op.any, true)
    const edits = applyEditOp(emptyEdits(), op, 12_000)
    const moved = slideRows(ctx, marks, edits.boundaries)
    assert.equal(moved[1].firstWord, 10); assert.equal(moved[1].noClearPause, false); assert.equal(moved[1].startQuality, 'close'); assert.ok(moved[1].moved)
    assert.equal(moved[0].endWord, 10, 'rows recompute')
    pass('a slide change with no clean pause within two seconds is flagged; choosing the word stores a close boundary and the rows recompute')
  }
  {
    const fx = makeEditorFixture({ slides: 8, wordsPerSlide: 40 })
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const rows = slideRows(ctx, fx.marks)
    assert.equal(rows.length, 8)
    assert.equal(rows[0].firstWord, 0); assert.equal(rows.at(-1).endWord, ctx.words.length)
    for (let i = 1; i < rows.length; i++) { assert.equal(rows[i].firstWord, rows[i - 1].endWord, 'every word in exactly one row'); assert.ok(rows[i].start >= rows[i - 1].start) }
    for (const r of rows.slice(1)) if (!r.noClearPause) assert.equal(r.startQuality, 'clean', `slide ${r.index + 1} starts at a clean pause`)
    assert.ok(rows.some((r) => r.steps.length), 'steps found')
    // Move slide 3's start to the clean pause before, then put it back: one undo step each.
    const t = boundaryTargets(ctx, rows, 2, false).find((x) => x.word < rows[2].firstWord)
    assert.ok(t, 'a clean pause in the previous slide')
    let e = applyEditOp(emptyEdits(), moveBoundaryOp(ctx, rows[2], t.word, false), fx.durationMs)
    let r2 = slideRows(ctx, fx.marks, e.boundaries)
    assert.equal(r2[2].firstWord, t.word); assert.equal(r2[2].startQuality, 'clean'); assert.equal(r2[1].endWord, t.word)
    assert.equal(e.undo.length, 1)
    e = applyEditOp(e, putBoundaryBackOp(r2[2]), fx.durationMs)
    assert.deepEqual(e.boundaries, []); assert.deepEqual(slideRows(ctx, fx.marks, e.boundaries), rows)
    e = applyEditOp(e, { kind: 'undo' }, fx.durationMs)
    assert.equal(slideRows(ctx, fx.marks, e.boundaries)[2].firstWord, t.word, 'undo brings the moved start back')
    assert.equal(moveBoundaryOp(ctx, rows[2], rows[2].firstWord, false).at, null, 'moving to where it was by default stores nothing')
    pass('a moved slide start snaps to clean pauses, is one undo step, and Put back returns the rows to the rule')
  }
  {
    // Repeated visits: the same slide entered twice in a row is one visit; a return later is a new row.
    const v = slideVisits([{ event: 'enter', slideId: 'a', tMs: 50 }, { event: 'enter', slideId: 'a', tMs: 900 }, { event: 'enter', slideId: 'b', tMs: 2000 }, { event: 'enter', slideId: 'a', tMs: 3000 }, { event: 'reveal', slideId: 'a', tMs: 3100 }])
    assert.deepEqual(v.map((x) => x.slideId), ['a', 'b', 'a']); assert.equal(v[0].change, 0)
    const none = slideRows(editorWords({ words: [w('x', 0, 100)] }, 1000), [])
    assert.equal(none.length, 1); assert.equal(none[0].endWord, 1)
    pass('slide visits merge repeated entries of one slide; a Run without slide changes is one row')
  }

  // ---- Cuts ------------------------------------------------------------------------------------
  {
    const fx = makeEditorFixture({ slides: 6, wordsPerSlide: 30, aligned: false })
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const D = fx.durationMs
    const rows = slideRows(ctx, fx.marks)
    let e = emptyEdits()
    // Cut three words in the middle of a phrase (no alignment): close edges.
    const mid = rows[1].firstWord + 2
    e = applyEditOp(e, cutOp(ctx, mid, mid + 2), D)
    assert.equal(e.undo.length, 1)
    let views = resolve(ctx, e).views
    assert.equal(views.length, 1); assert.deepEqual([views[0].firstWord, views[0].endWord], [mid, mid + 3])
    assert.equal(views[0].close, true, 'mid-phrase without alignment: a Close cut')
    // Move to the nearest pause outward: the cut grows to clean pauses; one step.
    const out = nearestCleanEdge(ctx, e.cuts[0], 'start', 'outward')
    assert.ok(out && out.at < e.cuts[0].start)
    e = applyEditOp(e, out.op, D)
    views = resolve(ctx, e).views
    assert.equal(views[0].startQuality, 'clean'); assert.equal(e.undo.length, 2)
    const endOut = nearestCleanEdge(ctx, e.cuts[0], 'end', 'outward')
    e = applyEditOp(e, endOut.op, D)
    assert.equal(resolve(ctx, e).views[0].close, false, 'both edges now at clean pauses')
    const inward = nearestCleanEdge(ctx, e.cuts[0], 'start', 'inward')
    if (inward) assert.ok(inward.at < e.cuts[0].end, 'inward never crosses the other edge')
    // Restore puts the words back.
    e = applyEditOp(e, restoreOp(resolve(ctx, e).views[0].restore), D)
    assert.deepEqual(e.cuts, []); assert.deepEqual(resolve(ctx, e).views, [])
    pass('a word cut is one step; a close cut moves to the nearest pause outward or inward; restore puts the words back')
  }
  {
    const fx = makeEditorFixture({ slides: 6, wordsPerSlide: 30, aligned: true })
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const rows = slideRows(ctx, fx.marks)
    const mid = rows[1].firstWord + 2
    const e = applyEditOp(emptyEdits(), cutOp(ctx, mid, mid + 2), fx.durationMs)
    assert.equal(resolve(ctx, e).views[0].close, false, 'with precise word timing a cut between words inside a phrase is clean')
    assert.deepEqual(cutWords(resolve(ctx, e)), [mid, mid + 1, mid + 2])
    pass('with alignment, word cuts land on shared midpoints (to the frame) and are clean')
  }

  // ---- Review round 1 (Sol on baa02742): one resolved edit state --------------------------------------
  {
    // Finding 1: the reviewer's words. Original ranges absorb the pauses; precise word timing placed them.
    const a = (s0, e0) => ({ status: 'aligned', confidence: 0.9, normalised: 'x', unsupported: [], start: s0, end: e0 })
    const words = [w('one', 0, 1100, { alignment: a(0, 300) }), w('two', 1100, 1400, { alignment: a(340, 600) }), w('three', 1400, 1800, { alignment: a(640, 900) })]
    const transcript = { words, segments: [{ start: 0, end: 1800, text: 'one two three' }], alignment: { version: 1, model: 'm', revision: 'r', sha256: 'x', alignedAt: 'now', normalisation: 'ctc-nfc-v1', midpoints: [320, 620] } }
    const ctx = editorWords(transcript, 3000)
    assert.deepEqual(ctx.words.map((x) => [x.start, x.end]), [[0, 300], [340, 600], [640, 900]], 'word times come from the aligned placement')
    const made = cutWordsOp(ctx, 1, 1)
    assert.ok(made.op); assert.ok(made.range.start >= 300 && made.range.start <= 340 && made.range.end >= 600 && made.range.end <= 640, `cut ${JSON.stringify(made.range)} sits in the gaps either side of "two"`)
    const r = resolve(ctx, { cuts: made.op.ranges })
    assert.deepEqual(cutWords(r), [1], 'the screen strikes "two", not "one"')
    const captions = captionCues(r.ctx.words, r.spans).cues.map((c) => c.text).join(' ')
    assert.equal(captions, 'one three', 'captions agree with the screen')
    pass('finding 1: word times come from precise word timing wherever it placed a word; the struck word is the cut word, as in captions')
  }
  {
    // Partial alignment: an unplaced word keeps the transcriber's times, kept between its placed neighbours.
    const a = (s0, e0) => ({ status: 'aligned', confidence: 0.9, normalised: 'x', unsupported: [], start: s0, end: e0 })
    const un = { status: 'unplaced', confidence: 0, normalised: '2020', unsupported: ['2', '0'], reason: 'alphabet' }
    const words = [w('in', 0, 400, { alignment: a(0, 150) }), w('2020', 300, 2000, { alignment: un }), w('we', 900, 1300, { alignment: a(700, 900) })]
    const t = projectWordTimes(words)
    assert.deepEqual(t, [{ start: 0, end: 150, timed: true }, { start: 300, end: 700, timed: true }, { start: 700, end: 900, timed: true }], 'the unplaced word keeps the transcriber\'s time inside the gap between its neighbours')
    const ctx = editorWords({ words }, 2000)
    for (let i = 1; i < ctx.words.length; i++) assert.ok(ctx.words[i].mid >= ctx.words[i - 1].mid, 'middles stay in order')
    assert.deepEqual(cutWords(resolve(ctx, { cuts: cutOp(ctx, 1, 1).ranges })), [1])
    pass('partial alignment: placed words use aligned times, unplaced ones the transcriber\'s, in order')
  }
  {
    // Finding 2: the reviewer's words a 0–8, b 10–12, c 14–40 in a 1 s recording. A cut [9,13] removes no frame.
    const ctx = editorWords({ words: [w('a', 0, 8), w('b', 10, 12), w('c', 14, 40)] }, 1000)
    const r = resolve(ctx, { cuts: [{ start: 9, end: 13 }] })
    assert.deepEqual(r.views, [], 'a saved cut that removes no frame shows nothing'); assert.deepEqual(cutWords(r), [])
    assert.equal(r.editedMs, msOfFrame(frameOf(1000)), 'and nothing is removed')
    const made = cutWordsOp(ctx, 1, 1)
    assert.ok(made.error && /shorter than a frame/.test(made.error), 'cutting "b" alone is refused with a plain reason')
    // A short word with room on either side widens to whole frames without swallowing a kept word.
    const ctx2 = editorWords({ words: [w('a', 0, 100), w('b', 120, 125), w('c', 130, 400)] }, 1000)
    const ok = cutWordsOp(ctx2, 1, 1)
    assert.ok(ok.op, ok.error)
    assert.deepEqual(cutWords(resolve(ctx2, { cuts: ok.op.ranges })), [1], 'exactly the selected word is removed')
    for (const edge of [ok.range.start, ok.range.end]) assert.equal(Math.abs(edge - msOfFrame(frameOf(edge))) < 0.5, true, 'cuts are saved on the frame grid')
    // Both edges, adjacent cuts, and cuts at the very start and end: the display is the plan.
    const fx = makeEditorFixture({ slides: 4, wordsPerSlide: 25, seed: 3 })
    const big = editorWords(fx.transcript, fx.durationMs)
    const D = fx.durationMs
    const cases = [
      [{ start: 0, end: 9 }], [{ start: 0, end: 50 }], [{ start: D - 9, end: D }], [{ start: D - 60, end: D }],
      [{ start: 5000, end: 5010 }, { start: 5011, end: 5020 }], [{ start: 7000, end: 7400 }, { start: 7410, end: 7800 }]
    ]
    for (let k = 0; k < 40; k++) { const s0 = 4100 + ((k * 7919) % (D - 6000)); cases.push([{ start: s0, end: s0 + 3 + ((k * 131) % 900) }]) }
    for (const c of cases) {
      const rr = resolve(big, { cuts: c })
      const inSpan = (m) => rr.spans.some((sp) => m >= sp.startMs && m < sp.endMs)
      big.words.forEach((x, i) => assert.equal(!!rr.wordCut[i], !inSpan(x.mid), `word ${i} shows as the plan plays it (${JSON.stringify(c)})`))
      const kept = captionCues(rr.ctx.words, rr.spans).cues.map((q) => q.text).join(' ').split(' ').filter(Boolean).length
      assert.equal(kept, big.words.length - cutWords(rr).length, 'captions keep exactly the words shown kept')
      for (const v of rr.views) assert.ok(v.end - v.start >= msOfFrame(1) - 0.01, 'every shown cut removes at least a frame')
    }
    assert.deepEqual(resolve(big, { cuts: [{ start: 5000, end: 5010 }, { start: 5011, end: 5020 }] }).views.length, 1, 'adjacent cuts that meet on the grid are one stretch')
    pass(`finding 2: what shows as cut is exactly what the 30 fps plan removes (${cases.length} cases incl. both edges, adjacent cuts, start and end); a cut that would remove no frame is refused`)
  }
  {
    // Finding 4: the reviewer's sequence on a slide [1000, 3000].
    const D = 6000
    const ctx = editorWords(null, D)
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 1000 }, { event: 'enter', slideId: 'C', tMs: 3000 }]
    const rows = slideRows(ctx, marks)
    assert.deepEqual([rows[1].start, rows[1].end], [1000, 3000])
    let e = applyEditOp(emptyEdits(), { kind: 'cut', ranges: [{ start: 2000, end: 2200 }] }, D)
    e = applyEditOp(e, leaveOutOp(rows[1]), D)
    assert.equal(isLeftOut(rows[1], e.leftOut), true)
    assert.deepEqual(e.cuts, [{ start: 2000, end: 2200 }], 'leaving a slide out is its own fact, not a merged cut')
    assert.deepEqual(resolve(ctx, e, marks).cuts, [{ start: 1000, end: 3000 }], 'the plan cuts the slide at its edit boundaries')
    e = applyEditOp(e, { kind: 'cut', ranges: [{ start: 2500, end: 4000 }] }, D)
    e = applyEditOp(e, putBackOp(rows[1]), D)
    assert.deepEqual(e.cuts, [{ start: 2000, end: 2200 }, { start: 2500, end: 4000 }], 'putting it back removes that fact and nothing else')
    assert.deepEqual(e.leftOut, []); assert.equal(e.undo.length, 4)
    // Pruned history no longer matters: the fact survives without it.
    const pruned = { ...applyEditOp(applyEditOp(emptyEdits(), { kind: 'cut', ranges: [{ start: 2000, end: 2200 }] }, D), leaveOutOp(rows[1]), D), undo: [] }
    assert.deepEqual(applyEditOp(pruned, putBackOp(rows[1]), D).cuts, [{ start: 2000, end: 2200 }])
    pass('finding 4: Leave this slide out is a fact in the sidecar; Put this slide back removes it and nothing else, whatever the history holds')
  }
  {
    // Finding 5: clicks at 0, 1800, 4200; slide starts moved to 1000 and 3000; the middle slide left out.
    const D = 6000
    const ctx = editorWords(null, D)
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 1800 }, { event: 'enter', slideId: 'C', tMs: 4200 }]
    const edits = { boundaries: [{ change: 1800, at: 1000 }, { change: 4200, at: 3000 }], leftOut: [1800] }
    const r = resolve(ctx, edits, marks)
    const slides = { A: { title: 'A' }, B: { title: 'B' }, C: { title: 'C' } }
    assert.deepEqual(chaptersFor(r.chapterMarks, slides, r.spans), [{ startMs: 0, endMs: 1000, title: 'A' }, { startMs: 1000, endMs: 4000, title: 'C' }])
    assert.deepEqual(chaptersFor(resolve(ctx, { boundaries: edits.boundaries }, marks).chapterMarks, slides, resolve(ctx, { boundaries: edits.boundaries }, marks).spans).map((c) => [c.startMs, c.title]), [[0, 'A'], [1000, 'B'], [3000, 'C']], 'a chapter starts at the slide\'s edit boundary')
    // First and last slide left out.
    const both = resolve(ctx, { boundaries: edits.boundaries, leftOut: [0, 4200] }, marks)
    assert.deepEqual(both.cuts, [{ start: 0, end: 1000 }, { start: 3000, end: 6000 }]); assert.equal(both.editedMs, 2000)
    assert.deepEqual(chaptersFor(both.chapterMarks, slides, both.spans), [{ startMs: 0, endMs: 2000, title: 'B' }])
    pass('finding 5: chapters come from the resolved state: none for a slide left out, each at its edit boundary; first and last slides can be left out')
  }
  {
    // A stretch straddling three slides (the middle one empty), and a slide visited twice.
    const words = [w('a', 1000, 1300), w('b', 1340, 1700), w('c', 1740, 2100), w('d', 2140, 2500), w('e', 3200, 3500)]
    const ctx = editorWords({ words, silence: [{ start: 0, end: 1000 }, { start: 2500, end: 3200 }, { start: 3500, end: 5000 }] }, 5000)
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 1500 }, { event: 'enter', slideId: 'C', tMs: 1650 }, { event: 'enter', slideId: 'A', tMs: 3000 }]
    const rows = slideRows(ctx, marks)
    assert.deepEqual(rows.map((r) => r.slideId), ['A', 'B', 'C', 'A'], 'a slide shown again is a row again')
    assert.deepEqual(rows.map((r) => r.endWord - r.firstWord), [0, 0, 4, 1], 'the stretch goes whole to the visit with most of its spoken time; the short visits hold none')
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].firstWord, rows[i - 1].endWord)
    const r = resolve(ctx, { leftOut: [1500] }, marks)
    assert.ok(r.editedMs > 0 && r.chapterMarks.length === 3, 'an empty visit left out takes its few milliseconds and its chapter with it')
    pass('a stretch over three slides goes whole to one; a slide visited twice is two rows; an empty visit can be left out')
  }
  {
    // Overlapping Tidy up proposals applied together are one step and the plan stays consistent.
    const fx = makeEditorFixture({ slides: 8, wordsPerSlide: 40 })
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const rows = slideRows(ctx, fx.marks)
    const props = tidyProposals(ctx, rows, fx.marks, []).proposals
    const extra = { ...props[0], range: { start: props[0].range.start - 200, end: props[0].range.end + 200 } }
    const e = applyEditOp(emptyEdits(), { kind: 'cut', ranges: [...props.map((p) => p.range), extra.range] }, fx.durationMs)
    assert.equal(e.undo.length, 1)
    const r = resolve(ctx, e, fx.marks)
    ctx.words.forEach((x, i) => assert.equal(!!r.wordCut[i], !r.spans.some((sp) => x.mid >= sp.startMs && x.mid < sp.endMs)))
    pass('overlapping Tidy up proposals applied together: one step, and the words shown cut are the plan\'s')
  }
  {
    // The fixture's transcriber times differ from its aligned times by a lot, as real ones do.
    const fx = makeEditorFixture({ slides: 6, wordsPerSlide: 30 })
    const shift = fx.transcript.words.map((x) => (x.start + x.end) / 2 - (x.alignment.start + x.alignment.end) / 2)
    assert.ok(shift.every((d) => d === (ORIGINAL_LATE_MS + ORIGINAL_RUN_ON_MS) / 2) && shift[0] >= 300, 'every word\'s original middle is 300 ms from where it is said')
    const ctx = editorWords(fx.transcript, fx.durationMs)
    assert.ok(ctx.words.every((x, i) => x.start === fx.transcript.words[i].alignment.start), 'the editor uses the aligned times')
    pass('the fixture\'s original word times differ substantially from its aligned times')
  }

  // ---- Tidy up ---------------------------------------------------------------------------------
  {
    const fx = makeEditorFixture({ slides: 8, wordsPerSlide: 40 })
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const rows = slideRows(ctx, fx.marks)
    const tidy = tidyProposals(ctx, rows, fx.marks, [])
    const by = (k) => tidy.proposals.filter((p) => p.kind === k)
    assert.ok(by('pauses').length > 0 && by('pauses').every((p) => p.pauseMs > EDITOR_THRESHOLDS.tidyPauseMs && p.quality === 'clean'))
    for (const p of by('pauses')) assert.equal(p.pauseMs - (p.range.end - p.range.start), EDITOR_THRESHOLDS.tidyPauseKeepMs, 'shortened to half a second')
    assert.deepEqual(by('ends').map((p) => p.range.start === 0 ? 'start' : 'end').sort(), ['end', 'start'])
    const rep = by('repeats')
    assert.equal(rep.length, 1); assert.equal(rep[0].text, 'we build a clear'); assert.equal(rep[0].quality, 'clean', 'aligned midpoints')
    const marked = by('marked')
    assert.equal(marked.length, 1); assert.equal(marked[0].quality, 'clean'); assert.ok(marked[0].endWord > marked[0].firstWord)
    assert.deepEqual(tidy.fillers.proposals, []); assert.match(tidy.fillers.reason, /does not mark um and er/)
    // Nothing is applied; applying the clean ones is one step; afterwards they are not proposed again.
    const clean = tidy.proposals.filter((p) => p.quality === 'clean')
    const e = applyEditOp(emptyEdits(), { kind: 'cut', ranges: clean.map((p) => p.range) }, fx.durationMs)
    assert.equal(e.undo.length, 1)
    assert.equal(tidyProposals(ctx, rows, fx.marks, e.cuts).proposals.filter((p) => p.quality === 'clean').length, 0)
    // Without alignment the repeat cut falls mid-phrase: close, so it goes under Needs a listen.
    const plain = editorWords(makeEditorFixture({ slides: 8, wordsPerSlide: 40, aligned: false }).transcript, fx.durationMs)
    assert.equal(tidyProposals(plain, slideRows(plain, fx.marks), fx.marks, []).proposals.find((p) => p.kind === 'repeats').quality, 'close')
    pass('Tidy up proposes long pauses, silent ends, exact repeats and marked stretches with their quality; um and er says why it is empty; nothing applies by itself')
  }
  {
    // Exact tokens only: case and punctuation are not words; different words are never "nearly" equal.
    const ws = ['So', 'the', 'plan,', 'so', 'the', 'plan.', 'The', 'plans', 'the', 'plan'].map((t, i) => w(t, i * 300, i * 300 + 250))
    const ctx = editorWords({ words: ws }, 4000)
    const rep = tidyProposals(ctx, slideRows(ctx, []), [], []).proposals.filter((p) => p.kind === 'repeats')
    assert.deepEqual(rep.map((p) => p.text), ['So the plan,'])
    pass('exact repeats compare the transcript\'s own tokens: no fuzzy matching')
  }

  {
    // Finding 3, main side: the window settled revision 1; a later cut is on disk (revision 2). Export must not proceed.
    const dir = join(root, 'ipc'), vault = join(dir, 'vault'), ud = join(dir, 'ud'), runs = join(vault, '_PRESENTATIONS', 'talk')
    mkdirSync(runs, { recursive: true }); mkdirSync(ud)
    writeFileSync(join(runs, 'run1.json'), JSON.stringify({ id: 'run1', talkSlug: 'talk', startedAt: '2026-11-11T10:00:00Z', recordingMs: 10000, audio: { segments: [] }, slideTimeIndex: [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 5000 }], capture: { layers: {} } }))
    const handlers = new Map(), wc = {}, win = { isDestroyed: () => false, webContents: wc }
    let dialogs = 0
    registerRecordingVideoIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, toolsWindow: () => win, userDataDir: () => ud, vaultFor: () => vault, tempRecordFile: () => join(ud, 'temps.json'),
      readiness: () => ({ ffmpeg: { found: false, path: null } }), readTranscript: async () => ({ state: 'none' }), showSaveDialog: async () => { dialogs++; return { canceled: true } }, reveal: () => {}, defaultFolder: () => dir })
    const ev = { sender: wc }, ref = { talkSlug: 'talk', runId: 'run1' }
    const first = await handlers.get('recording-video:edit')(ev, ref, { kind: 'cut', ranges: [{ start: 1000, end: 2000 }] }, 0)
    const second = await handlers.get('recording-video:edit')(ev, ref, { kind: 'cut', ranges: [{ start: 4000, end: 5000 }] }, first.edits.edits.revision)
    const stale = await handlers.get('recording-video:export')(ev, ref, { captions: false, chapterList: false, sound: false, revision: first.edits.edits.revision })
    assert.equal(stale.ok, false); assert.match(stale.error, /differs from what the editor shows/); assert.equal(stale.stale, true); assert.equal(dialogs, 0, 'no save panel for a state the window did not describe')
    const fresh = await handlers.get('recording-video:export')(ev, ref, { captions: false, chapterList: false, sound: false, revision: second.edits.edits.revision })
    assert.equal(fresh.cancelled, true); assert.equal(dialogs, 1, 'the settled revision goes on to the save panel')
    // Every slide left out: nothing to export, said before the save panel.
    const r1 = await handlers.get('recording-video:edit')(ev, ref, { kind: 'leave-out', change: 0, out: true }, second.edits.edits.revision)
    const r2 = await handlers.get('recording-video:edit')(ev, ref, { kind: 'leave-out', change: 5000, out: true }, r1.edits.edits.revision)
    const none = await handlers.get('recording-video:export')(ev, ref, { captions: false, chapterList: false, sound: false, revision: r2.edits.edits.revision })
    assert.match(none.error, /Nothing is left to export/); assert.equal(dialogs, 1)
    pass('finding 3 (main): an export for a revision other than the saved one is refused before the save panel; nothing left is said plainly')
  }

  // ---- Review round 2 (Sol on 7be85449) ---------------------------------------------------------------
  {
    // B2: an untouched Run keeps PR 347's chapters. Reviewer's case: 4 s, A at 0, B at 2000, words 100–1500 and 1800–2800.
    const D = 4000
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 2000 }]
    const transcript = { words: [w('one', 100, 1500), w('two', 1800, 2800)], segments: [{ start: 100, end: 2800, text: 'one two' }] }
    const r = resolve(editorWords(transcript, D), {}, marks)
    const slides = { A: { title: 'A' }, B: { title: 'B' } }
    assert.deepEqual(chaptersFor(r.chapterMarks, slides, r.spans).map((c) => [c.title, c.startMs, c.endMs]), [['A', 0, 2000], ['B', 2000, 4000]], 'a chapter starts at the real slide change')
    assert.equal(r.rows[1].start, 2800, '(the words still sit on rows by the boundary rule: both on A)')
    // Equivalence: untouched generated Runs give exactly PR 347's chapters and captions.
    let compared = 0
    for (let seed = 1; seed <= 120; seed++) {
      const fx = makeEditorFixture({ slides: 2 + (seed % 9), wordsPerSlide: 12 + (seed % 23), aligned: seed % 3 !== 0, seed })
      const marks2 = [...fx.marks]
      // Now and then a slide entered twice in a row, and a return to an earlier slide.
      if (seed % 4 === 1) { const e = marks2.find((m) => m.event === 'enter' && m.tMs > 0); if (e) marks2.push({ ...e, tMs: e.tMs + 300 }) }
      if (seed % 5 === 2 && fx.slideIds.length > 2) marks2.push({ event: 'enter', slideId: fx.slideIds[0], tMs: fx.durationMs - 1500 })
      marks2.sort((a, b) => a.tMs - b.tMs)
      const ctx = editorWords(fx.transcript, fx.durationMs)
      const rr = resolve(ctx, {}, marks2)
      const spans347 = keptSpans(effectiveCuts([], [], fx.durationMs), fx.durationMs)
      assert.deepEqual(rr.spans, spans347)
      const titles = Object.fromEntries(fx.slideIds.map((id) => [id, { title: id }]))
      assert.deepEqual(chaptersFor(rr.chapterMarks, titles, rr.spans), chaptersFor(marks2.filter((m) => m.event === 'enter'), titles, spans347), `chapters, seed ${seed}`)
      assert.deepEqual(captionCues(rr.captionWords, rr.spans, fx.transcript.segments), captionCues(fx.transcript.words, spans347, fx.transcript.segments), `captions, seed ${seed}`)
      compared++
    }
    pass(`B2: an untouched Run has PR 347's chapters (at the real slide changes) and captions: ${compared} generated Runs, aligned and not, with repeated and returning slides`)
  }
  {
    // S2: A aligned 0–300, B unplaced with transcriber time 1100–1400, C aligned 640–900.
    const a = (s0, e0) => ({ status: 'aligned', confidence: 0.9, normalised: 'x', unsupported: [], start: s0, end: e0 })
    const un = { status: 'unplaced', confidence: 0, normalised: 'b', unsupported: [], reason: 'confidence' }
    const transcript = { words: [w('A', 0, 300, { alignment: a(0, 300) }), w('B', 1100, 1400, { alignment: un }), w('C', 640, 900, { alignment: a(640, 900) })], segments: [{ start: 0, end: 1400, text: 'A B C' }] }
    const ctx = editorWords(transcript, 3000)
    assert.equal(ctx.words[1].timed, false, 'no time is invented for B: it is untimed, not squeezed to 640–640')
    assert.ok(ctx.words[1].start === ctx.words[1].end && ctx.words[1].start > 300 && ctx.words[1].start < 640, 'it sits in the gap between its timed neighbours')
    assert.match(cutWordsOp(ctx, 1, 1).error, /no time of its own/, 'it is not cut alone')
    const withA = resolve(ctx, { cuts: cutOp(ctx, 0, 1).ranges })
    assert.deepEqual(cutWords(withA), [0, 1], 'selected with a timed neighbour, it is cut with it')
    const onlyA = resolve(ctx, { cuts: cutOp(ctx, 0, 0).ranges })
    assert.deepEqual(cutWords(onlyA), [0], 'cutting the neighbour alone keeps it')
    const kept = resolve(ctx, {})
    assert.deepEqual(captionCues(kept.captionWords, kept.spans).cues.map((c) => c.text), ['A B C'], 'in captions it rides with its neighbour')
    assert.equal(wordAt(ctx, 500) >= 0 && ctx.words[wordAt(ctx, 500)].timed ? 'timed' : 'untimed', 'untimed', '(the highlight skips it in the editor)')
    // Where the transcriber's time overlaps a credible gap, it is kept there.
    const inGap = editorWords({ ...transcript, words: [transcript.words[0], w('B', 350, 600, { alignment: un }), transcript.words[2]] }, 3000)
    assert.deepEqual([inGap.words[1].start, inGap.words[1].end, inGap.words[1].timed], [350, 600, true])
    assert.equal(EDITOR_THRESHOLDS.untimedGapMs, 80)
    pass('S2: a word alignment left unplaced is untimed (no invented time), cut only with a neighbour, and rides with its neighbour in captions; one inside a credible gap keeps its time there')
  }
  {
    // B1 and S1, main side, through the export IPC with a stub host.
    const setup = (name, transcriptOf, dialog = async () => ({ canceled: true })) => {
      const dir = join(root, name), vault = join(dir, 'vault'), ud = join(dir, 'ud'), runs = join(vault, '_PRESENTATIONS', 'talk')
      mkdirSync(runs, { recursive: true }); mkdirSync(ud)
      writeFileSync(join(runs, 'run1.json'), JSON.stringify({ id: 'run1', talkSlug: 'talk', startedAt: '2026-11-11T10:00:00Z', recordingMs: 4000, audio: { segments: [] }, slideTimeIndex: [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 2000 }], capture: { layers: {} } }))
      const handlers = new Map(), wc = {}, win = { isDestroyed: () => false, webContents: wc }
      const out = { dialogs: 0, handlers, ev: { sender: wc }, ref: { talkSlug: 'talk', runId: 'run1' } }
      registerRecordingVideoIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, toolsWindow: () => win, userDataDir: () => ud, vaultFor: () => vault, tempRecordFile: () => join(ud, 'temps.json'),
        readiness: () => ({ ffmpeg: { found: false, path: null } }), readTranscript: async (...a) => { const t = await transcriptOf(out, ...a); return t && t.state ? t : t ? { state: 'ok', transcript: t } : { state: 'none' } }, showSaveDialog: async () => { out.dialogs++; return dialog(out) }, reveal: () => {}, defaultFolder: () => dir })
      return out
    }
    const words = { words: [w('one', 100, 1500), w('two', 1800, 2800)], segments: [{ start: 100, end: 2800, text: 'one two' }] }
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 2000 }]
    const digestFor = (edits, transcript) => planDigest(resolveRecording({ durationMs: 4000, edits, marks, transcript }), transcript?.segments)
    // B1: the window resolved slide B left out without words (2000–4000 cut); main has the words (2800–4000). Refused.
    const t1 = setup('b1', async () => words)
    const left = await t1.handlers.get('recording-video:edit')(t1.ev, t1.ref, { kind: 'leave-out', change: 2000, out: true }, 0)
    assert.deepEqual(resolveRecording({ durationMs: 4000, edits: left.edits.edits, marks, transcript: null }).cuts, [{ start: 2000, end: 4000 }])
    assert.deepEqual(resolveRecording({ durationMs: 4000, edits: left.edits.edits, marks, transcript: words }).cuts, [{ start: 2800, end: 4000 }])
    const opts = (plan) => ({ captions: false, chapterList: false, sound: false, revision: left.edits.edits.revision, plan })
    const stale = await t1.handlers.get('recording-video:export')(t1.ev, t1.ref, opts(digestFor(left.edits.edits, null)))
    assert.equal(stale.ok, false); assert.equal(stale.stale, true); assert.match(stale.error, /differs from what the editor shows/); assert.equal(t1.dialogs, 0, 'refused before the save panel')
    const same = await t1.handlers.get('recording-video:export')(t1.ev, t1.ref, opts(digestFor(left.edits.edits, words)))
    assert.equal(same.cancelled, true); assert.equal(t1.dialogs, 1, 'the same plan goes on to the save panel')
    // B1: main cannot read the words: refused, never resolved against "no words".
    const t2 = setup('b1-read', async () => { throw Error('disk') })
    const r2 = await t2.handlers.get('recording-video:export')(t2.ev, t2.ref, { captions: false, chapterList: false, sound: false, revision: 0, plan: digestFor(emptyEdits(), words) })
    assert.match(r2.error, /words for this recording could not be read/); assert.equal(t2.dialogs, 0)
    // S1: a save lands while main reads the words; the export is refused before the save panel.
    const t3 = setup('s1', async (o) => { await o.handlers.get('recording-video:edit')(o.ev, o.ref, { kind: 'cut', ranges: [{ start: 300, end: 600 }] }, 0); return words })
    const r3 = await t3.handlers.get('recording-video:export')(t3.ev, t3.ref, { captions: false, chapterList: false, sound: false, revision: 0, plan: digestFor(emptyEdits(), words) })
    assert.equal(r3.stale, true); assert.equal(t3.dialogs, 0)
    pass('B1 and S1 (main): an export is refused before the save panel when its plan differs from the window\'s (words that arrived later, a read that failed, a save during the read)')

    // ---- Review round 3 (Sol on d20726a3) ----
    // 1: slide B left out, the window resolved without words (cut 2000–4000); words arrive while the save panel is open (2800–4000).
    let late = null
    const t4 = setup('r3-1', async () => late, async () => { late = words; return { canceled: false, filePath: join(root, 'r3-1', 'out.mp4') } })
    const lo4 = await t4.handlers.get('recording-video:edit')(t4.ev, t4.ref, { kind: 'leave-out', change: 2000, out: true }, 0)
    const r4 = await t4.handlers.get('recording-video:export')(t4.ev, t4.ref, { captions: false, chapterList: false, sound: false, revision: lo4.edits.edits.revision, plan: digestFor(lo4.edits.edits, null) })
    assert.equal(t4.dialogs, 1); assert.equal(r4.ok, false); assert.equal(r4.stale, true, 'words that arrived during the save panel refuse the export; nothing is scheduled')
    assert.ok(!existsSync(join(root, 'r3-1', 'out.mp4')))
    // 5: the words exist but cannot be read: refused with the offer; "Export without captions" sends the word-less plan and goes on.
    const t5 = setup('r3-5', async () => ({ state: 'unreadable' }))
    const r5 = await t5.handlers.get('recording-video:export')(t5.ev, t5.ref, { captions: true, chapterList: false, sound: false, revision: 0, plan: digestFor(emptyEdits(), words) })
    assert.equal(r5.wordsUnreadable, true); assert.match(r5.error, /could not be read/); assert.equal(t5.dialogs, 0, 'never resolved against "no words" silently')
    const r5b = await t5.handlers.get('recording-video:export')(t5.ev, t5.ref, { captions: true, chapterList: false, sound: false, revision: 0, plan: digestFor(emptyEdits(), null), withoutWords: true })
    assert.equal(r5b.cancelled, true); assert.equal(t5.dialogs, 1, 'the plan without words, confirmed, goes on to the save panel')
    // Final check, B: the words become readable again before "Export without captions" is pressed: the
    // word-less plan is stale, so it is refused and no save panel opens (captions are never dropped silently).
    let readable = false
    const t6 = setup('r4-b', async () => (readable ? words : { state: 'unreadable' }))
    const r6 = await t6.handlers.get('recording-video:export')(t6.ev, t6.ref, { captions: true, chapterList: false, sound: false, revision: 0, plan: digestFor(emptyEdits(), words) })
    assert.equal(r6.wordsUnreadable, true)
    readable = true
    const r6b = await t6.handlers.get('recording-video:export')(t6.ev, t6.ref, { captions: true, chapterList: false, sound: false, revision: 0, plan: digestFor(emptyEdits(), null), withoutWords: true })
    assert.equal(r6b.ok, false); assert.equal(r6b.stale, true); assert.equal(t6.dialogs, 0, 'readable words refuse the word-less export before the save panel')
    pass('round 3, items 1 and 5 (main): words that arrive while the save panel is open refuse the export; unreadable words refuse with "Export without captions", which then goes on with the word-less plan')
  }
  {
    // Round 3, item 2: an untimed word keeps its transcript place in its neighbour's cue.
    const a = (s0, e0) => ({ status: 'aligned', confidence: 0.9, normalised: 'x', unsupported: [], start: s0, end: e0 })
    const un = { status: 'unplaced', confidence: 0, normalised: 'in', unsupported: [], reason: 'confidence' }
    const oxford = editorWords({ words: [w('in', 0, 10, { alignment: un }), w('Oxford', 0, 400, { alignment: a(0, 400) })], segments: [{ start: 0, end: 400, text: 'in Oxford' }] }, 2000)
    assert.equal(oxford.words[0].timed, false)
    const r1 = resolve(oxford, {})
    assert.deepEqual(captionCues(r1.captionWords, r1.spans).cues.map((c) => c.text), ['in Oxford'])
    const three = editorWords({ words: [w('in', 0, 10, { alignment: un }), w('the', 100, 300, { alignment: a(100, 300) }), w('Oxford', 600, 1000, { alignment: a(600, 1000) })], segments: [{ start: 0, end: 1000, text: 'in the Oxford' }] }, 2000)
    const r2 = resolve(three, { cuts: cutOp(three, 1, 1).ranges })
    assert.deepEqual(cutWords(r2), [1])
    assert.deepEqual(captionCues(r2.captionWords, r2.spans).cues.map((c) => c.text), ['in Oxford'], 'with the timed word before it cut, it rides with the next one, in order')
    // Final check, A: untimed words that ride with the word before them fall after a sentence break; the
    // earlier cue must keep its text ("Hello." was cut back to nothing by the next cue starting at 0).
    const hello = editorWords({ words: [w('Hello.', 0, 400, { alignment: a(0, 400) }), w('in', 410, 420, { alignment: un }), w('the', 430, 440, { alignment: un }), w('Oxford', 1000, 1400, { alignment: a(1000, 1400) })], segments: [{ start: 0, end: 1400, text: 'Hello. in the Oxford' }] }, 2000)
    const r3h = resolve(hello, {})
    const helloCues = captionCues(r3h.captionWords, r3h.spans).cues
    assert.equal(helloCues.map((c) => c.text).join(' '), 'Hello. in the Oxford', 'no caption text is lost at a sentence break')
    assert.ok(helloCues.every((c) => c.endMs > c.startMs) && helloCues.every((c, i) => i === 0 || c.startMs >= helloCues[i - 1].endMs), 'cues have length and do not overlap')
    // The same at the character limit: many attached words overflow one cue and none are dropped.
    const many = Array.from({ length: 30 }, (_, i) => w(`untimedword${i}`, 500 + i, 501 + i, { alignment: un }))
    const long = editorWords({ words: [w('Start', 0, 400, { alignment: a(0, 400) }), ...many, w('end', 3000, 3400, { alignment: a(3000, 3400) })], segments: [{ start: 0, end: 3400, text: 'x' }] }, 5000)
    const r3l = resolve(long, {})
    const longText = captionCues(r3l.captionWords, r3l.spans).cues.map((c) => c.text).join(' ')
    assert.equal(longText.split(' ').length, 32, 'every word survives a cue split at the length limit')
    pass('round 3, item 2: an untimed word rides in its neighbour\'s caption cue in transcript order ("in Oxford", not "Oxford in"); no cue loses its text')
  }
  {
    // Round 3, item 4: the fingerprint covers the caption cues that will be written, from segments too.
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }]
    const segA = { segments: [{ start: 0, end: 1500, text: 'Hello there' }] }, segB = { segments: [{ start: 0, end: 1500, text: 'Goodbye now' }] }
    const ra = resolveRecording({ durationMs: 3000, edits: noEdits, marks, transcript: segA }), rb = resolveRecording({ durationMs: 3000, edits: noEdits, marks, transcript: segB })
    assert.notEqual(planDigest(ra, segA.segments), planDigest(rb, segB.segments), 'two segment-only transcripts with different text differ')
    assert.equal(planDigest(ra, segA.segments), planDigest(resolveRecording({ durationMs: 3000, edits: noEdits, marks, transcript: segA }), segA.segments))
    pass('round 3, item 4: the plan fingerprint covers the caption cues actually written, from words or from segments')
  }

  // ---- Record one slide again is off in 0.44.5 (takesEnabled): main refuses take requests, finds no takes,
  // and a recording whose edits file already names a take (written by a development build) opens, plays and
  // exports exactly as one without takes, the choice kept in the file. ----
  {
    const dir = join(root, 'takes-off'), vault = join(dir, 'vault'), ud = join(dir, 'ud'), runs = join(vault, '_PRESENTATIONS', 'talk'), rec = join(ud, 'recordings')
    mkdirSync(runs, { recursive: true }); mkdirSync(join(rec, 'take1'), { recursive: true })
    const marks = [{ event: 'enter', slideId: 'A', tMs: 0 }, { event: 'enter', slideId: 'B', tMs: 2000 }]
    writeFileSync(join(runs, 'run1.json'), JSON.stringify({ id: 'run1', talkSlug: 'talk', startedAt: '2026-11-11T10:00:00Z', recordingMs: 4000, audio: { segments: [] }, slideTimeIndex: marks, capture: { layers: {} } }))
    writeFileSync(join(runs, 'take1.json'), JSON.stringify({ id: 'take1', talkSlug: 'talk', startedAt: '2026-11-11T11:00:00Z', recordingMs: 1500, takeOf: { runId: 'run1', change: 2000, slideId: 'B' }, audio: { segments: [{ file: 'take1.webm', startMs: 0, endMs: 1500 }] }, capture: { layers: { slides: { file: 'slides.webm', bytes: 4, startMs: 0 } } } }))
    writeFileSync(join(rec, 'take1.webm'), 'webm'); writeFileSync(join(rec, 'take1', 'slides.webm'), 'webm')
    let on = true, dialogs = 0
    const handlers = new Map(), wc = { isDestroyed: () => false, send: () => {} }, win = { isDestroyed: () => false, webContents: wc }
    registerRecordingVideoIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, toolsWindow: () => win, userDataDir: () => ud, vaultFor: () => vault, tempRecordFile: () => join(ud, 'temps.json'),
      readiness: () => ({ ffmpeg: { found: false, path: null } }), readTranscript: async () => ({ state: 'none' }), showSaveDialog: async () => { dialogs++; return { canceled: true } }, reveal: () => {}, defaultFolder: () => dir, takesEnabled: () => on })
    const ev = { sender: wc }, ref = { talkSlug: 'talk', runId: 'run1' }
    // A development build (override on) chose the take.
    const opened = await handlers.get('recording-video:open')(ev, ref)
    assert.equal(opened.recordAgain, true); assert.deepEqual(opened.takes.map((t) => t.run), ['take1'])
    const chosen = await handlers.get('recording-video:edit')(ev, ref, { kind: 'take', change: 2000, run: 'take1' }, 0)
    assert.equal(chosen.ok, true, JSON.stringify(chosen))
    // A release build (off).
    on = false
    const off = await handlers.get('recording-video:open')(ev, ref)
    assert.equal(off.ok, true); assert.equal(off.recordAgain, false, 'the editor is told it is off'); assert.deepEqual(off.takes, [], 'no take is found')
    assert.deepEqual(off.edits.edits.takes, [{ change: 2000, run: 'take1' }], 'the choice stays in the edits file')
    assert.deepEqual(await handlers.get('recording-video:takes')(ev, ref), { ok: false, error: TAKES_OFF_ERROR }, 'listing takes is refused')
    const choose = await handlers.get('recording-video:edit')(ev, ref, { kind: 'take', change: 2000, run: null }, off.edits.edits.revision)
    assert.equal(choose.ok, false); assert.equal(choose.error, TAKES_OFF_ERROR, 'choosing a take is refused')
    const cut = await handlers.get('recording-video:edit')(ev, ref, { kind: 'cut', ranges: [{ start: 500, end: 900 }] }, off.edits.edits.revision)
    assert.equal(cut.ok, true); assert.deepEqual(cut.edits.edits.takes, [{ change: 2000, run: 'take1' }], 'other edits keep the choice in the file')
    // The export resolves the plan without takes (not refused as a missing take) and goes on to the save panel.
    const plan = planDigest(resolveRecording({ durationMs: 4000, edits: { ...cut.edits.edits, takes: [] }, marks, transcript: null }))
    const exp = await handlers.get('recording-video:export')(ev, ref, { captions: false, chapterList: false, sound: false, revision: cut.edits.edits.revision, plan })
    assert.equal(exp.cancelled, true, JSON.stringify(exp)); assert.equal(dialogs, 1)
    assert.equal(planDigest(resolveRecording({ durationMs: 4000, edits: cut.edits.edits, marks, transcript: null, takes: [] })), plan, 'the same plan as a recording without takes')
    // Undo and Redo while off never change the hidden choice: the cut undoes; the step that chose the take is refused.
    const undoCut = await handlers.get('recording-video:edit')(ev, ref, { kind: 'undo' }, cut.edits.edits.revision)
    assert.equal(undoCut.ok, true, 'an ordinary undo works'); assert.deepEqual(undoCut.edits.edits.cuts, [])
    assert.deepEqual(undoCut.edits.edits.takes, [{ change: 2000, run: 'take1' }])
    const undoTake = await handlers.get('recording-video:edit')(ev, ref, { kind: 'undo' }, undoCut.edits.edits.revision)
    assert.equal(undoTake.ok, false, `the take-choosing step is refused: ${JSON.stringify(undoTake)}`); assert.equal(undoTake.error, TAKE_STEP_OFF_ERROR)
    const kept = await handlers.get('recording-video:open')(ev, ref)
    assert.deepEqual(kept.edits.edits.takes, [{ change: 2000, run: 'take1' }], 'the choice is unchanged in the file')
    const redoCut = await handlers.get('recording-video:edit')(ev, ref, { kind: 'redo' }, kept.edits.edits.revision)
    assert.equal(redoCut.ok, true, 'an ordinary redo works'); assert.deepEqual(redoCut.edits.edits.cuts, [{ start: 500, end: 900 }])
    // A redo whose step would change the choice is refused too (on: undo the choice; off: redo it).
    on = true
    const back = await handlers.get('recording-video:edit')(ev, ref, { kind: 'undo' }, redoCut.edits.edits.revision)
    const unchose = await handlers.get('recording-video:edit')(ev, ref, { kind: 'undo' }, back.edits.edits.revision)
    assert.deepEqual(unchose.edits.edits.takes, [], '(on: the choice undone)')
    on = false
    const redoTake = await handlers.get('recording-video:edit')(ev, ref, { kind: 'redo' }, unchose.edits.edits.revision)
    assert.equal(redoTake.ok, false); assert.equal(redoTake.error, TAKE_STEP_OFF_ERROR)
    pass('Record one slide again off: takes are not found, listing or choosing one is refused, and a recording whose edits name a take opens and exports as one without takes, the choice kept; Undo and Redo never change it')
  }

  // ---- Sidecar version 4 (written as version 5 since 0.44.5: the finishing choices join each step) ----
  {
    assert.equal(RECORDING_EDITS_VERSION, 5)
    const F = { camera: true, evenVolume: true, smoothJoins: true }, FACES = { all: { layout: 'corner', corner: 'bottom-right', size: 'medium' }, slides: [] }
    const D = 60_000
    const v3 = parseEdits({ version: 3, revision: 2, cuts: [{ start: 0, end: 1000 }], undo: [[], [{ start: 0, end: 500 }]], redo: [], finish: { camera: false } }, D)
    assert.equal(v3.ok, true); assert.equal(v3.from, 3)
    assert.deepEqual(v3.edits.boundaries, []); assert.deepEqual(v3.edits.leftOut, []); assert.deepEqual(v3.edits.undo, [{ cuts: [], boundaries: [], leftOut: [], finish: { ...F, camera: false }, faces: FACES, takes: [] }, { cuts: [{ start: 0, end: 500 }], boundaries: [], leftOut: [], finish: { ...F, camera: false }, faces: FACES, takes: [] }])
    assert.equal(applyEditOp(v3.edits, { kind: 'undo' }, D).cuts[0].end, 500, 'a 0.44 history still undoes')
    assert.equal(parseEdits({ version: 3, revision: 1, cuts: [], undo: [], redo: [], boundaries: [] }, D).problem.kind, 'corrupt', 'version 3 never had boundaries')
    assert.equal(parseEdits({ version: 3, revision: 1, cuts: [], undo: [], redo: [], leftOut: [] }, D).problem.kind, 'corrupt', 'nor slides left out')
    for (const bad of [{ boundaries: [{ change: 'x', at: 1 }] }, { boundaries: [{ change: 1, at: 2, any: 'yes' }] }, { boundaries: 'x' }, { undo: [[]] }, { leftOut: ['x'] }, { undo: [{ cuts: [], boundaries: [], leftOut: 'x' }] }])
      assert.equal(parseEdits({ version: 4, revision: 1, cuts: [], boundaries: [], leftOut: [], undo: [], redo: [], ...bad }, D).problem.kind, 'corrupt')
    assert.equal(parseEdits({ version: 6 }, D).problem.kind, 'newer')
    // The first build of version 4 wrote no leftOut, at the top or in its history: read as none.
    const first = parseEdits({ version: 4, revision: 3, cuts: [{ start: 0, end: 900 }], boundaries: [], undo: [{ cuts: [], boundaries: [] }], redo: [] }, D)
    assert.equal(first.ok, true); assert.deepEqual(first.edits.leftOut, []); assert.deepEqual(first.edits.undo, [{ cuts: [], boundaries: [], leftOut: [], finish: F, faces: FACES, takes: [] }])
    // The store writes the current version and reads it back with the history.
    const folder = join(root, 'v4'); mkdirSync(folder)
    const path = join(folder, 'run.edits.json')
    writeFileSync(path, JSON.stringify({ version: 3, revision: 1, recording: 'fp', cuts: [{ start: 0, end: 900 }], undo: [[]], redo: [] }))
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'run', durationMs: D, fingerprint: 'fp' }) })
    assert.equal(store.get({}).problem, null)
    const s = store.apply({}, { kind: 'boundary', change: 12_000, at: 11_500, any: true }, 1)
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(disk.version, 5); assert.deepEqual(disk.boundaries, [{ change: 12_000, at: 11_500, any: true }])
    assert.deepEqual(disk.undo, [{ cuts: [], boundaries: [], leftOut: [], finish: F, faces: FACES, takes: [] }, { cuts: [{ start: 0, end: 900 }], boundaries: [], leftOut: [], finish: F, faces: FACES, takes: [] }]); assert.deepEqual(disk.leftOut, [])
    assert.deepEqual(store.apply({}, { kind: 'undo' }, s.edits.revision).edits.boundaries, [])
    assert.throws(() => applyEditOp(emptyEdits(), { kind: 'boundary', change: NaN, at: 1 }, D), /Invalid/)
    assert.equal(applyEditOp(emptyEdits(), { kind: 'boundary', change: 5, at: null }, D).revision, 0, 'putting back what was never moved changes nothing')
    // At the byte budget with many boundaries and slides left out in every step: the oldest steps go, and what is written reopens.
    const many = Array.from({ length: 2000 }, (_, i) => ({ change: i * 10, at: i * 10 + 3, any: true }))
    const outs = Array.from({ length: 2000 }, (_, i) => i * 10)
    const huge = { ...emptyEdits(), revision: 1, boundaries: many, leftOut: outs, undo: Array.from({ length: 100 }, () => ({ cuts: [], boundaries: many, leftOut: outs, finish: F, faces: FACES, takes: [] })), redo: [] }
    const fitted = fitEditsBudget(huge)
    assert.ok(fitted && Buffer.byteLength(serialiseEdits(fitted)) <= EDITS_WRITE_BUDGET && fitted.undo.length < 100)
    assert.equal(parseEditsText(serialiseEdits(fitted), D).ok, true, 'what is written at the budget reopens')
    pass('sidecar version 4 stores moved slide starts and slides left out in the same history; version 3 files read with their history; malformed ones are refused; the byte budget holds')
  }

  // ---- Sentence starts (0.44.5): stored sentence boundaries as places a slide can start --------------
  // Twenty words run on with 40 ms gaps from 1.0 s to 9.0 s; a clean pause before and after. Word i is
  // said 1000+400i .. 1360+400i; the gap before word i is at 980+400i. The slide changes at 5.0 s.
  const runOn = Array.from({ length: 20 }, (_, i) => w(`w${i}`, 1000 + i * 400, 1360 + i * 400))
  const runOnSilence = [{ start: 0, end: 1000 }, { start: 9000, end: 12000 }]
  const sentencesEnding = (lasts, source = 'punctuation') => { let from = 0; return lasts.map((last) => { const s = { id: `sentence-${from}-${last}`, firstWord: from, lastWord: last, start: runOn[from].start, end: runOn[last].end, boundarySource: source }; from = last + 1; return s }) }
  const twoSlides = [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'enter', slideId: 'two', tMs: 5000 }]
  {
    // Ends after w5 and w11 (sentences start before w6 and w12), and the transcriber's last one.
    const ctx = editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 11, 19]) }, 12_000)
    assert.equal(ctx.sentences, true)
    assert.deepEqual(ctx.gaps.flatMap((g) => (g.sentence ? [g.index] : [])), [6, 12], 'a sentence starts after each stored end; none after the last word')
    assert.equal(ctx.gaps[12].quality, 'close', 'a sentence start in continuous speech keeps its gap\'s quality: close')
    assert.equal(ctx.gaps[12].point, editorWords({ words: runOn, silence: runOnSilence }, 12_000).gaps[12].point, 'sentence data never moves a cut point')
    // Only the transcriber's, the tokenizer's and the owner's ends count; a pause end is a pause, not a sentence.
    assert.equal(editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 19], 'acoustic-pause') }, 12_000).sentences, false)
    assert.equal(editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 19], 'transcriber') }, 12_000).gaps[6].sentence, true)
    assert.equal(editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 19], 'manual') }, 12_000).gaps[6].sentence, true)
    // Sentences that index other words (a word was dropped as invalid) are not used.
    assert.equal(editorWords({ words: [...runOn, { text: 'bad', start: NaN, end: 1 }], silence: runOnSilence, sentences: sentencesEnding([5, 11, 19]) }, 12_000).sentences, false)
    // No sentence data: nothing marked.
    const plain = editorWords({ words: runOn, silence: runOnSilence }, 12_000)
    assert.equal(plain.sentences, false); assert.ok(plain.gaps.every((g) => !g.sentence))
    pass('stored sentence ends mark the next word as a sentence start (transcriber, tokenizer and owner ends; not pause ends); the gap keeps its point and quality')
  }
  {
    // Aligned: a sentence start at a confident shared midpoint inside one segment is clean.
    const a = (s, e) => ({ status: 'aligned', confidence: 0.9, normalised: 'x', unsupported: [], start: s, end: e })
    const words = runOn.map((x) => ({ ...x, alignment: a(x.start, x.end) }))
    const alignment = { version: 1, model: 'm', revision: 'r', sha256: 'x', alignedAt: 'now', normalisation: 'ctc-nfc-v1', midpoints: words.slice(0, -1).map((x, i) => (x.end + words[i + 1].start) / 2) }
    const ctx = editorWords({ words, alignment, segments: [{ start: 1000, end: 9000 }], silence: runOnSilence, sentences: sentencesEnding([5, 11, 19]) }, 12_000)
    assert.equal(ctx.gaps[12].sentence, true); assert.equal(ctx.gaps[12].quality, 'clean'); assert.equal(ctx.gaps[12].aligned, true)
    const rows = slideRows(ctx, twoSlides)
    assert.equal(rows[1].firstWord, 12); assert.equal(rows[1].startsAt, 'sentence'); assert.equal(rows[1].startQuality, 'clean')
    const t = boundaryTargets(ctx, rows, 1, false)
    assert.deepEqual(t.map((x) => [x.word, x.kind, x.quality]), [[6, 'sentence', 'clean'], [12, 'sentence', 'clean']])
    pass('aligned transcript: a sentence start at a confident shared midpoint is a clean place for a slide to start')
  }
  {
    // Case 1: a clear pause separates the words around the change. Sentence data changes nothing there.
    const words = [w('a1', 500, 1000), w('a2', 1050, 2000), w('b1', 2600, 3000), w('b2', 3050, 4000), w('b3', 4050, 5000), w('c1', 5600, 6400)]
    const silence = [{ start: 0, end: 500 }, { start: 2000, end: 2600 }, { start: 5000, end: 5600 }, { start: 6400, end: 8000 }]
    const sentences = [{ id: 's0', firstWord: 0, lastWord: 1, start: 500, end: 2000, boundarySource: 'punctuation' }, { id: 's1', firstWord: 2, lastWord: 4, start: 2600, end: 5000, boundarySource: 'punctuation' }, { id: 's2', firstWord: 5, lastWord: 5, start: 5600, end: 6400, boundarySource: 'punctuation' }]
    const marks = [{ event: 'enter', slideId: 'one', tMs: 100 }, { event: 'enter', slideId: 'two', tMs: 3200 }]
    const ctx = editorWords({ words, silence, sentences }, 8000)
    const rows = slideRows(ctx, marks)
    const before = slideRows(editorWords({ words, silence }, 8000), marks)
    assert.deepEqual(rows.map((r) => [r.firstWord, r.endWord, r.start, r.startQuality, r.noClearPause]), before.map((r) => [r.firstWord, r.endWord, r.start, r.startQuality, r.noClearPause]))
    assert.equal(rows[1].startsAt, 'pause'); assert.equal(rows[1].sentenceNear, null)
    const t = boundaryTargets(ctx, rows, 1, false)
    assert.ok(t.every((x) => x.kind === 'pause'), 'a gap that is both a clear pause and a sentence start is named after the pause')
    assert.equal(TARGET_WORDS[t[0].kind], 'after a pause')
    // Leaving slide 2 out cuts it at the clean pause, as before.
    const r = resolve(ctx, applyEditOp(emptyEdits(), leaveOutOp(rows[1]), 8000), marks)
    assert.deepEqual(cutWords(r), [2, 3, 4, 5]); assert.equal(r.views.at(-1).startQuality, 'clean')
    // A clear pause within two seconds of the change, but the stretch after it is spoken across the change
    // and holds a sentence boundary: not divided (the clean pause stays the place, as in 0.44.0).
    const gapped = runOn.map((x, i) => (i >= 6 ? { ...x, start: x.start + 600, end: x.end + 600 } : x))
    const gappedSilence = [{ start: 0, end: 1000 }, { start: 3360, end: 4000 }, { start: 9600, end: 12000 }]
    const near = editorWords({ words: gapped, silence: gappedSilence, sentences: sentencesEnding([8, 19]) }, 12_000)
    const nearRows = slideRows(near, twoSlides)
    const nearPlain = slideRows(editorWords({ words: gapped, silence: gappedSilence }, 12_000), twoSlides)
    assert.equal(near.gaps[6].cleanPause, true); assert.equal(near.gaps[9].sentence, true); assert.equal(nearRows[1].noClearPause, false)
    assert.equal(nearPlain[1].firstWord, 6)
    assert.equal(nearRows[1].firstWord, 6, 'the clear pause 1.3 s before the change stays the place; the sentence start at w9 is not used to divide')
    assert.equal(nearRows[1].startsAt, 'pause'); assert.equal(nearRows[1].sentenceNear, null)
    assert.ok(boundaryTargets(near, nearRows, 1, false).some((t) => t.word === 9 && t.kind === 'sentence'), 'but it is still offered to the handle')
    pass('case 1, a clear pause between the slides: the words go with the slide holding more of their spoken time, as before; leaving the slide out cuts at the pause')
  }
  {
    // Case 2: no clear pause near the change, a sentence boundary in the stretch: divided at the sentence.
    // Sentences w0–w5 | w6–w11 | w12–w19. The middle one is said 3.4–5.76 s: 1.44 s before the change, 0.72 s after.
    const ctx = editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 11, 19]) }, 12_000)
    const rows = slideRows(ctx, twoSlides)
    assert.deepEqual([rows[0].endWord, rows[1].firstWord], [12, 12], 'slide 2 starts where the sentence straddling the change ends')
    assert.equal(rows[1].start, 5780); assert.equal(rows[1].startsAt, 'sentence'); assert.equal(rows[1].startQuality, 'close', 'continuous speech: needs a listen')
    assert.equal(rows[1].noClearPause, true, 'still no clear pause within two seconds')
    assert.equal(rows[1].sentenceNear, 12, 'the nearest sentence start within two seconds is where it starts')
    // Without sentence data the whole run-on stretch stays with slide 1 (the 0.44.0 rule).
    const old = slideRows(editorWords({ words: runOn, silence: runOnSilence }, 12_000), twoSlides)
    assert.equal(old[1].firstWord, 20); assert.equal(old[1].sentenceNear, null); assert.equal(old[1].startsAt, null)
    // The handle snaps to the sentence starts (and clear pauses); Option still gives any word.
    const snap = boundaryTargets(ctx, rows, 1, false)
    assert.deepEqual(snap.map((t) => [t.word, t.kind, t.quality, t.at]), [[6, 'sentence', 'close', 3380], [12, 'sentence', 'close', 5780]])
    assert.equal(TARGET_WORDS.sentence, 'at a sentence start')
    const any = boundaryTargets(ctx, rows, 1, true)
    assert.ok(any.length > 10 && any.find((t) => t.word === 9).kind === 'word')
    assert.equal(boundaryTargets(editorWords({ words: runOn, silence: runOnSilence }, 12_000), old, 1, false).length, 0, 'no sentence data: nothing to snap to, as before')
    // Snapping to a sentence start stores a move that is not "any word"; undo puts it back.
    const op = moveBoundaryOp(ctx, rows[1], 6, true)
    assert.equal(op.at, 3380); assert.equal(op.any, false, 'a sentence start is a place, not any word')
    let e = applyEditOp(emptyEdits(), op, 12_000)
    assert.deepEqual(e.boundaries, [{ change: 5000, at: 3380 }])
    const moved = slideRows(ctx, twoSlides, e.boundaries)
    assert.equal(moved[1].firstWord, 6); assert.equal(moved[1].startsAt, 'sentence'); assert.equal(moved[1].noClearPause, false); assert.equal(moved[1].sentenceNear, null)
    e = applyEditOp(e, { kind: 'undo' }, 12_000)
    assert.deepEqual(e.boundaries, []); assert.deepEqual(slideRows(ctx, twoSlides, e.boundaries), rows)
    // Moving to the default sentence start is putting it back.
    assert.deepEqual(moveBoundaryOp(ctx, rows[1], 12, false), { kind: 'boundary', change: 5000, at: null })
    // Leaving slide 2 out cuts from that sentence start; the cut's start is close (Listen to the join).
    const r = resolve(ctx, applyEditOp(emptyEdits(), leaveOutOp(rows[1]), 12_000), twoSlides)
    assert.deepEqual(cutWords(r), Array.from({ length: 8 }, (_, i) => 12 + i))
    assert.equal(r.views.length, 1); assert.equal(r.views[0].startQuality, 'close'); assert.equal(r.views[0].leftOut, true)
    // Leaving slide 1 out instead keeps the whole of the sentence that ends after the change on slide 1.
    const r1 = resolve(ctx, applyEditOp(emptyEdits(), leaveOutOp(rows[0]), 12_000), twoSlides)
    assert.deepEqual(cutWords(r1), Array.from({ length: 12 }, (_, i) => i))
    pass('case 2, only a sentence boundary near the change: divided at the sentence; it is offered, snapped to and marked close; leaving either slide out cuts there')
  }
  {
    // Case 3: neither. The only sentence boundary is far from the change (after w2, 2.8 s before it): it is
    // treated as absent, so the 0.44.0 rule holds and no sentence start is offered.
    const far = editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([2, 19]) }, 12_000)
    const farRows = slideRows(far, twoSlides)
    assert.equal(farRows[1].firstWord, 20, 'a sentence end 2.8 s from the change does not divide'); assert.equal(farRows[1].noClearPause, true); assert.equal(farRows[1].sentenceNear, null, 'none within two seconds')
    assert.deepEqual(farRows, slideRows(editorWords({ words: runOn, silence: runOnSilence }, 12_000), twoSlides).map((r) => ({ ...r })), 'exactly the 0.44.0 rows')
    // No sentence boundary at all in the stretch: the 0.44.0 rule, the whole stretch to one slide.
    const none = editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([19]) }, 12_000)
    const noneRows = slideRows(none, twoSlides)
    assert.equal(none.sentences, false, 'the end after the last word is no sentence start')
    assert.equal(noneRows[1].firstWord, 20); assert.equal(noneRows[1].noClearPause, true); assert.equal(noneRows[1].sentenceNear, null)
    const r = resolve(none, applyEditOp(emptyEdits(), leaveOutOp(noneRows[1]), 12_000), twoSlides)
    assert.deepEqual(cutWords(r), [], 'slide 2 has no words of its own to cut')
    const r0 = resolve(none, applyEditOp(emptyEdits(), leaveOutOp(noneRows[0]), 12_000), twoSlides)
    assert.equal(cutWords(r0).length, 20)
    // The review's case: 100 words of continuous speech from 1 to 41 s, a change at 22 s, one sentence end
    // after w9 (at 4.98 s). Before 0.44.5 slide 2 starts at 40.96 s and leaving it out cuts 3,040 ms; so it stays.
    const long = Array.from({ length: 100 }, (_, i) => w(`w${i}`, 1000 + i * 400, 1360 + i * 400))
    const longSilence = [{ start: 0, end: 1000 }, { start: 41_000, end: 45_000 }]
    const change22 = [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'enter', slideId: 'two', tMs: 22_000 }]
    const longS = editorWords({ words: long, silence: longSilence, sentences: [{ id: 'a', firstWord: 0, lastWord: 9, start: 1000, end: 4960, boundarySource: 'punctuation' }, { id: 'b', firstWord: 10, lastWord: 99, start: 5000, end: 40_960, boundarySource: 'transcriber' }] }, 45_000)
    const longPlain = editorWords({ words: long, silence: longSilence }, 45_000)
    const lr = slideRows(longS, change22), lp = slideRows(longPlain, change22)
    assert.equal(lp[1].start, 40_960); assert.equal(lr[1].start, lp[1].start, 'slide 2 starts where it did'); assert.equal(lr[1].startsAt, lp[1].startsAt)
    const leaveLong = (ctx, rows) => resolve(ctx, applyEditOp(emptyEdits(), leaveOutOp(rows[1]), 45_000), change22)
    assert.equal(leaveLong(longS, lr).views[0].end - leaveLong(longS, lr).views[0].start, leaveLong(longPlain, lp).views[0].end - leaveLong(longPlain, lp).views[0].start, 'leaving it out cuts the same')
    assert.equal(planDigest(leaveLong(longS, lr)), planDigest(leaveLong(longPlain, lp)))
    pass('case 3, neither a clear pause nor a sentence start within two seconds of the change: exactly the 0.44.0 rule, with "Choose the word"; a sentence end far away divides nothing (the review\'s 100-word case)')
  }
  {
    // One stretch spoken across two changes: the first (12 s) has no clear pause near it, the second (29 s)
    // has one 1.5 s after it. Sentences end near both. Only the first start moves (to its sentence); the
    // second stays on its pause.
    const blocks = [...Array.from({ length: 10 }, (_, i) => w(`a${i}`, 1000 + i * 400, 1360 + i * 400)), ...Array.from({ length: 60 }, (_, i) => w(`b${i}`, 6000 + i * 400, 6360 + i * 400)), ...Array.from({ length: 10 }, (_, i) => w(`c${i}`, 31_000 + i * 400, 31_360 + i * 400))]
    const silence = [{ start: 0, end: 1000 }, { start: 4960, end: 6000 }, { start: 29_960, end: 31_000 }, { start: 34_960, end: 40_000 }]
    // Word 10+j is b_j, said 6000+400j. Ends after words 34 (b24, 15.6–15.96 s), 38 (b28) and 66 (b56, 28.4–28.76 s).
    const ends = [9, 34, 38, 66, 69, 79]
    let from = 0
    const sentences = ends.map((last) => { const x = { id: `s${from}`, firstWord: from, lastWord: last, start: blocks[from].start, end: blocks[last].end, boundarySource: 'punctuation' }; from = last + 1; return x })
    const marks = [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'enter', slideId: 'two', tMs: 17_000 }, { event: 'enter', slideId: 'three', tMs: 29_000 }]
    const ctx = editorWords({ words: blocks, silence, sentences }, 40_000)
    const plain = slideRows(editorWords({ words: blocks, silence }, 40_000), marks)
    const rows = slideRows(ctx, marks)
    assert.equal(plain[1].noClearPause, true); assert.equal(plain[2].noClearPause, false)
    assert.equal(rows[2].start, plain[2].start, 'the change with a clear pause near it keeps its pause'); assert.equal(rows[2].startsAt, 'pause')
    // Sentence b29–b56 (word 39 to 66) is said 17.6–28.76 s: all after the 17 s change; b25–b28 (35–38) 16.0–17.36 s: mostly before.
    assert.equal(rows[1].firstWord, 39, 'slide 2 starts at the sentence start 0.58 s after its change'); assert.equal(rows[1].startsAt, 'sentence')
    assert.ok(Math.abs(rows[1].start - 17_000) <= 2000)
    assert.equal(rows[1].sentenceNear, 39)
    pass('one stretch across two changes: the change with no clear pause near it moves to its sentence start; the other keeps its clear pause')
  }
  {
    // A sentence boundary inside a cut: the cut is the same with or without sentence data, and the row's
    // division ignores what is cut (rows are about where slides start, not what is kept).
    const withS = editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 11, 19]) }, 12_000)
    const without = editorWords({ words: runOn, silence: runOnSilence }, 12_000)
    const a = cutWordsOp(withS, 10, 13), b = cutWordsOp(without, 10, 13)
    assert.deepEqual(a.range, b.range, 'a cut across a sentence start falls at the same frames')
    const e = applyEditOp(emptyEdits(), a.op, 12_000)
    const r = resolve(withS, e, twoSlides)
    assert.deepEqual(cutWords(r), [10, 11, 12, 13])
    assert.equal(r.rows[1].firstWord, 12, 'the slide still starts at the sentence start inside the cut')
    assert.equal(r.views[0].close, true)
    // Leaving slide 2 out with that cut in place: one stretch removed, from w10 to the end.
    const r2 = resolve(withS, applyEditOp(e, leaveOutOp(r.rows[1]), 12_000), twoSlides)
    assert.deepEqual(cutWords(r2), Array.from({ length: 10 }, (_, i) => 10 + i)); assert.equal(r2.views.length, 1)
    pass('a sentence boundary inside a cut: the cut falls where it would without sentences; the slide start and leaving it out are unchanged')
  }
  {
    // "To check": a slide left out, or played from a take, whose stretch starts or ends at a sentence start.
    const ctx = editorWords({ words: runOn, silence: runOnSilence, sentences: sentencesEnding([5, 11, 19]) }, 12_000)
    const rows = slideRows(ctx, twoSlides)
    assert.equal(rows[1].startsAt, 'sentence')
    assert.deepEqual(joinsAtSentence(rows, new Set([1]), new Map()), [1], 'slide 2 left out: its start is a sentence start')
    assert.deepEqual(joinsAtSentence(rows, new Set([0]), new Map()), [0], 'slide 1 left out: its end is slide 2\'s sentence start')
    assert.deepEqual(joinsAtSentence(rows, new Set(), new Map([[1, 'take']])), [1], 'a take on slide 2 goes in at a sentence start')
    assert.deepEqual(joinsAtSentence(rows, new Set(), new Map()), [])
    const fx = makeEditorFixture({ slides: 8, wordsPerSlide: 40, sentences: true })
    const fctx = editorWords(fx.transcript, fx.durationMs), frows = slideRows(fctx, fx.marks)
    const atPause = frows.filter((r) => r.index > 0 && r.startsAt === 'pause' && frows[r.index + 1]?.startsAt !== 'sentence').map((r) => r.index)
    assert.ok(atPause.length); assert.deepEqual(joinsAtSentence(frows, new Set(atPause), new Map()), [], 'slides left out at clear pauses are not listed')
    pass('To check lists a slide left out, or a take, whose start or end is a sentence start, and not one at clear pauses')
  }
  {
    // Edits made before this change resolve as before: every slide with a clear pause near its change has the
    // same start and the same leave-out cut, and an edit list touching only those (cuts, a moved start, slides
    // left out, a take) gives the same plan digest. A start the owner moved always wins.
    for (const aligned of [true, false]) {
      const fx = makeEditorFixture({ slides: 12, wordsPerSlide: 40, aligned, seed: 9, sentences: true })
      const ctx = editorWords(fx.transcript, fx.durationMs), old = editorWords({ ...fx.transcript, sentences: undefined }, fx.durationMs)
      const rows = slideRows(ctx, fx.marks), before = slideRows(old, fx.marks)
      const paused = before.filter((r) => r.index > 0 && !r.noClearPause && !before[r.index + 1]?.noClearPause).map((r) => r.index)
      assert.ok(paused.length >= 3)
      for (const r of before) if (r.index > 0 && !r.noClearPause) assert.equal(rows[r.index].start, r.start, `slide ${r.index + 1} starts where it did`)
      for (const i of paused) {
        const e = applyEditOp(emptyEdits(), leaveOutOp(before[i]), fx.durationMs)
        assert.deepEqual(resolve(ctx, e, fx.marks).cuts, resolve(old, e, fx.marks).cuts, `leaving slide ${i + 1} out cuts the same`)
      }
      let e = emptyEdits()
      e = applyEditOp(e, cutOp(old, 30, 33), fx.durationMs)
      e = applyEditOp(e, leaveOutOp(before[paused[0]]), fx.durationMs)
      const t = boundaryTargets(old, before, paused[1], false).find((x) => x.word < before[paused[1]].firstWord)
      if (t) e = applyEditOp(e, moveBoundaryOp(old, before[paused[1]], t.word, false), fx.durationMs)
      // A start moved by hand on a slide with no clear pause near it wins over the sentence rule.
      const flagged = before.find((r) => r.noClearPause)
      if (flagged) e = applyEditOp(e, moveBoundaryOp(old, flagged, flagged.firstWord - 2, true), fx.durationMs)
      const takes = [{ change: before[paused[2]].change, run: 'take-1', durationMs: 2500, words: null }]
      const a = resolve(ctx, e, fx.marks, { takes }), b = resolve(old, e, fx.marks, { takes })
      assert.equal(planDigest(a), planDigest(b), 'same plan digest'); assert.deepEqual(a.cuts, b.cuts); assert.deepEqual(a.chapterMarks, b.chapterMarks)
      if (flagged) assert.equal(a.rows[flagged.index].start, b.rows[flagged.index].start, 'a moved start wins')
    }
    pass('earlier edits resolve as before: slides with a clear pause near their change keep their starts, leave-out cuts and plan digest, aligned and not; a moved start wins')
  }
  {
    // The generated talk, aligned and not, with stored sentences: every word in one row; each row starts at
    // a clear pause, at a sentence start, or says it has no clear pause; leaving each slide out cuts its words.
    for (const aligned of [true, false]) {
      const fx = makeEditorFixture({ slides: 8, wordsPerSlide: 40, aligned, sentences: true })
      const ctx = editorWords(fx.transcript, fx.durationMs)
      assert.equal(ctx.sentences, true)
      const rows = slideRows(ctx, fx.marks)
      assert.equal(rows[0].firstWord, 0); assert.equal(rows.at(-1).endWord, ctx.words.length)
      for (let i = 1; i < rows.length; i++) assert.equal(rows[i].firstWord, rows[i - 1].endWord)
      for (const r of rows.slice(1)) {
        assert.ok(r.startsAt === 'pause' || r.startsAt === 'sentence', `slide ${r.index + 1} starts at a pause or a sentence start (${r.startsAt})`)
        if (r.startsAt === 'pause') assert.equal(r.startQuality, 'clean')
        else assert.equal(r.startQuality, ctx.gaps[r.firstWord].quality, 'a sentence start carries its gap\'s quality')
      }
      const plainRows = slideRows(editorWords({ ...fx.transcript, sentences: undefined }, fx.durationMs), fx.marks)
      assert.ok(rows.some((r) => r.startsAt === 'sentence' && plainRows[r.index].noClearPause), 'a slide change with no clear pause near it now starts at a sentence')
      for (const r of rows) if (!plainRows[r.index].noClearPause) assert.equal(r.firstWord, plainRows[r.index].firstWord, 'a slide with a clear pause near its change starts where it did')
      for (const row of rows.slice(1, 4)) {
        const res = resolve(ctx, applyEditOp(emptyEdits(), leaveOutOp(row), fx.durationMs), fx.marks)
        assert.deepEqual(cutWords(res), Array.from({ length: row.endWord - row.firstWord }, (_, i) => row.firstWord + i), `leaving slide ${row.index + 1} out cuts exactly its words`)
      }
    }
    // Takes keep their own words, shown as text; nothing is cut inside a take, so sentence data in a take changes nothing.
    pass('the generated talk with stored sentences, aligned and not: every word in one row, each slide starts at a pause or a sentence start, leaving a slide out cuts its words')
  }
  {
    // No sentence data: rows, targets and the plan are as they were (the old fixture, and only pause ends).
    const fx = makeEditorFixture({ slides: 8, wordsPerSlide: 40 })
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const pauseOnly = editorWords({ ...fx.transcript, sentences: [{ id: 'x', firstWord: 0, lastWord: 3, start: 0, end: 1, boundarySource: 'acoustic-pause' }] }, fx.durationMs)
    const a = resolve(ctx, emptyEdits(), fx.marks), b = resolve(pauseOnly, emptyEdits(), fx.marks)
    assert.deepEqual(b.rows, a.rows); assert.equal(planDigest(b), planDigest(a))
    for (let i = 1; i < a.rows.length; i++) assert.deepEqual(boundaryTargets(pauseOnly, b.rows, i, false), boundaryTargets(ctx, a.rows, i, false))
    assert.ok(a.rows.every((r) => r.sentenceNear === null))
    pass('no sentence data (older Runs, segments only, pause ends only): rows, snap targets and the export plan are unchanged')
  }

  // ---- Performance: an hour-long Run ------------------------------------------------------------
  {
    const fx = makeEditorFixture({ slides: 80, wordsPerSlide: 113, seed: 11 })
    assert.ok(fx.transcript.words.length >= 9000, `${fx.transcript.words.length} words`)
    const t0 = performance.now()
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const t1 = performance.now()
    const rows = resolve(ctx, emptyEdits(), fx.marks).rows
    const t2 = performance.now()
    const tidy = tidyProposals(ctx, rows, fx.marks, [])
    const t3 = performance.now()
    let e = emptyEdits()
    const tc = performance.now()
    e = applyEditOp(e, cutOp(ctx, 4500, 4510), fx.durationMs)
    resolve(ctx, e, fx.marks)
    const td = performance.now()
    const result = { words: ctx.words.length, slides: rows.length, minutes: +(fx.durationMs / 60000).toFixed(1), prepareMs: +(t1 - t0).toFixed(1), rowsMs: +(t2 - t1).toFixed(1), tidyMs: +(t3 - t2).toFixed(1), tidyProposals: tidy.proposals.length, cutMs: +(td - tc).toFixed(1) }
    console.log(`MEASURE ${JSON.stringify(result)}`)
    assert.ok(t2 - t0 < 1000, 'words and rows for an hour within a second'); assert.ok(td - tc < 100, 'a cut and its recompute within 100 ms')
    assert.equal(wordAt(ctx, ctx.words[100].start + 1), 100)
    assert.deepEqual(wordsRange(ctx, 100, 100), { start: Math.round(ctx.gaps[100].point), end: Math.round(ctx.gaps[101].point) })
    pass(`an hour-long Run (${result.words} words, ${result.slides} slides): prepare ${result.prepareMs} ms, rows ${result.rowsMs} ms, Tidy up ${result.tidyMs} ms, cut ${result.cutMs} ms`)
  }
  {
    const fx = makeEditorFixture({ slides: 80, wordsPerSlide: 113, seed: 11, sentences: true })
    const t0 = performance.now()
    const ctx = editorWords(fx.transcript, fx.durationMs)
    const rows = resolve(ctx, emptyEdits(), fx.marks).rows
    for (let i = 1; i < rows.length; i++) boundaryTargets(ctx, rows, i, false)
    const ms = performance.now() - t0
    assert.ok(ms < 1000, `words, rows and every slide's snap targets with sentences within a second (${ms.toFixed(0)} ms)`)
    pass(`an hour-long Run with stored sentences: words, rows and snap targets in ${ms.toFixed(0)} ms`)
  }
  console.log(`\n${count} passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
