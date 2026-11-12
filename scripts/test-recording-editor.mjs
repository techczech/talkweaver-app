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
import { boundaryTargets, planDigest, cutWordsOp, edgeQuality, EDITOR_THRESHOLDS, editorWords, isLeftOut, leaveOutOp, moveBoundaryOp, nearestCleanEdge, projectWordTimes, putBackOp, putBoundaryBackOp, resolveRecording, restoreOp, slideRows, slideVisits, tidyProposals, wordAt, wordsRange } from '../src/shared/recording-editor.ts'
import { createRecordingEditsStore } from '../src/main/recording-edits-store.ts'
import { registerRecordingVideoIpc } from '../src/main/recording-video-ipc.ts'
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

  // ---- Sidecar version 4 ------------------------------------------------------------------------
  {
    assert.equal(RECORDING_EDITS_VERSION, 4)
    const D = 60_000
    const v3 = parseEdits({ version: 3, revision: 2, cuts: [{ start: 0, end: 1000 }], undo: [[], [{ start: 0, end: 500 }]], redo: [], finish: { camera: false } }, D)
    assert.equal(v3.ok, true); assert.equal(v3.from, 3)
    assert.deepEqual(v3.edits.boundaries, []); assert.deepEqual(v3.edits.leftOut, []); assert.deepEqual(v3.edits.undo, [{ cuts: [], boundaries: [], leftOut: [] }, { cuts: [{ start: 0, end: 500 }], boundaries: [], leftOut: [] }])
    assert.equal(applyEditOp(v3.edits, { kind: 'undo' }, D).cuts[0].end, 500, 'a 0.44 history still undoes')
    assert.equal(parseEdits({ version: 3, revision: 1, cuts: [], undo: [], redo: [], boundaries: [] }, D).problem.kind, 'corrupt', 'version 3 never had boundaries')
    assert.equal(parseEdits({ version: 3, revision: 1, cuts: [], undo: [], redo: [], leftOut: [] }, D).problem.kind, 'corrupt', 'nor slides left out')
    for (const bad of [{ boundaries: [{ change: 'x', at: 1 }] }, { boundaries: [{ change: 1, at: 2, any: 'yes' }] }, { boundaries: 'x' }, { undo: [[]] }, { leftOut: ['x'] }, { undo: [{ cuts: [], boundaries: [], leftOut: 'x' }] }])
      assert.equal(parseEdits({ version: 4, revision: 1, cuts: [], boundaries: [], leftOut: [], undo: [], redo: [], ...bad }, D).problem.kind, 'corrupt')
    assert.equal(parseEdits({ version: 5 }, D).problem.kind, 'newer')
    // The first build of version 4 wrote no leftOut, at the top or in its history: read as none.
    const first = parseEdits({ version: 4, revision: 3, cuts: [{ start: 0, end: 900 }], boundaries: [], undo: [{ cuts: [], boundaries: [] }], redo: [] }, D)
    assert.equal(first.ok, true); assert.deepEqual(first.edits.leftOut, []); assert.deepEqual(first.edits.undo, [{ cuts: [], boundaries: [], leftOut: [] }])
    // The store writes version 4 and reads it back with the history.
    const folder = join(root, 'v4'); mkdirSync(folder)
    const path = join(folder, 'run.edits.json')
    writeFileSync(path, JSON.stringify({ version: 3, revision: 1, recording: 'fp', cuts: [{ start: 0, end: 900 }], undo: [[]], redo: [] }))
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'run', durationMs: D, fingerprint: 'fp' }) })
    assert.equal(store.get({}).problem, null)
    const s = store.apply({}, { kind: 'boundary', change: 12_000, at: 11_500, any: true }, 1)
    const disk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(disk.version, 4); assert.deepEqual(disk.boundaries, [{ change: 12_000, at: 11_500, any: true }])
    assert.deepEqual(disk.undo, [{ cuts: [], boundaries: [], leftOut: [] }, { cuts: [{ start: 0, end: 900 }], boundaries: [], leftOut: [] }]); assert.deepEqual(disk.leftOut, [])
    assert.deepEqual(store.apply({}, { kind: 'undo' }, s.edits.revision).edits.boundaries, [])
    assert.throws(() => applyEditOp(emptyEdits(), { kind: 'boundary', change: NaN, at: 1 }, D), /Invalid/)
    assert.equal(applyEditOp(emptyEdits(), { kind: 'boundary', change: 5, at: null }, D).revision, 0, 'putting back what was never moved changes nothing')
    // At the byte budget with many boundaries and slides left out in every step: the oldest steps go, and what is written reopens.
    const many = Array.from({ length: 2000 }, (_, i) => ({ change: i * 10, at: i * 10 + 3, any: true }))
    const outs = Array.from({ length: 2000 }, (_, i) => i * 10)
    const huge = { ...emptyEdits(), revision: 1, boundaries: many, leftOut: outs, undo: Array.from({ length: 100 }, () => ({ cuts: [], boundaries: many, leftOut: outs })), redo: [] }
    const fitted = fitEditsBudget(huge)
    assert.ok(fitted && Buffer.byteLength(serialiseEdits(fitted)) <= EDITS_WRITE_BUDGET && fitted.undo.length < 100)
    assert.equal(parseEditsText(serialiseEdits(fitted), D).ok, true, 'what is written at the budget reopens')
    pass('sidecar version 4 stores moved slide starts and slides left out in the same history; version 3 files read with their history; malformed ones are refused; the byte budget holds')
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
  console.log(`\n${count} passed`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
