// The recording editor's pure logic (slice 3, journeys.md journey 4): a layered Run's words laid out
// slide by slide, its cut edges judged clean or close, word and slide cuts expressed as operations on
// the one edit list (recording-edits.ts), and Tidy up's proposals. No DOM, no clock, no files: the
// editor screen, the tests and any later agent verb call these same functions.
//
// Everything here works on what earlier stages stored: the transcriber's words and sentences, the
// acoustic pass's measured silence, the aligner's word times and shared midpoints, and the Run's
// `enter`, `reveal` and `flag` events. Nothing guesses language: no keyword lists, no regular
// expressions over sentences, no fuzzy matching (judgement-vs-code).
//
// Times are milliseconds on the Run's recording clock (Run time), like the sidecar's cuts.
import { CLEAN_CUT, type AlignmentProvenance, type TranscriptWord } from './transcript-contract.ts'
import { ALIGNMENT_CONFIDENCE } from './word-alignment.ts'
import { effectiveCuts, normaliseRanges, trimEndAt, trimStartAt, type EditBoundary, type EditOp, type RecordingEdits, type TimeRange } from './recording-edits.ts'
import { captionCues, editedDurationMs, frameOf, keptSpans, msOfFrame, silentEndSuggestions, VIDEO_FRAME, type KeptSpan } from './recording-video.ts'

/**
 * Every threshold the editor uses, in one place. The clean-edge pair is slice 2's measured choice
 * (built/slice-2/acceptance.md: 500 ms of measured silence, 200 ms kept on the kept side; 0/37 English
 * and 0/30 Czech clean edges clipped more than 80 ms). An aligned shared midpoint between two confident
 * words is clean as well (slice 2b).
 */
export const EDITOR_THRESHOLDS = {
  clean: CLEAN_CUT,
  /** A slide change with no clean pause this close says "No clear pause within two seconds". */
  noClearPauseMs: 2000,
  /** Pauses at least this long show in the words (coordinator's decision: not every pause). */
  pauseMarkerMs: 1000,
  /** Tidy up proposes shortening pauses longer than this… */
  tidyPauseMs: 1500,
  /** …to this much silence, kept half on each side. */
  tidyPauseKeepMs: 500,
  /** A cut of more words than this folds into one "n words cut" chip; fewer are struck through. */
  foldWords: 8,
  /** "Move to the nearest pause" looks this far from the edge. */
  nearestPauseMs: 5000,
  /** Exact repeats: runs of this many words or more, up to the maximum. */
  repeatMinWords: 2,
  repeatMaxWords: 12,
  /** A marked mistake whose stretch between clean pauses is longer than this needs a listen. */
  markedStretchMaxMs: 45_000,
  /** A flag counts the words that ended up to this long after it was pressed as said before it. */
  flagGraceMs: 300,
  /**
   * A word precise word timing left unplaced keeps the transcriber's time only where that time overlaps
   * the gap between its placed neighbours by at least this much (a short word); otherwise it is untimed.
   */
  untimedGapMs: 80
} as const

export type Quality = 'clean' | 'close'

/** What the editor reads from the stored transcript (preload's Transcript satisfies it). */
export type EditorTranscript = {
  words?: TranscriptWord[]
  silence?: TimeRange[]
  alignment?: AlignmentProvenance
  segments?: TimeRange[]
}
/** A Run event (slideTimeIndex entry). */
export type RunMark = { event: string; slideId?: string; tMs: number; hidden?: number }

/**
 * The place between two words: gap i lies before word i (gap 0 before the first word, gap n after the
 * last). `point` is where a cut at this gap falls; `pause` is the measured silence there, if any.
 */
export type Gap = {
  index: number
  pause: TimeRange | null
  pauseMs: number
  point: number
  quality: Quality
  /** A measured pause long enough for a clean cut: the unit for slide boundaries ("breaks, not grammar"). */
  cleanPause: boolean
  /** The point is a confident aligned midpoint between the two words. */
  aligned: boolean
}
/** `timed: false`: precise word timing could not place the word and the gap gave it no credible time; it is shown, but cut only with a neighbour. */
export type EditorWord = { text: string; start: number; end: number; mid: number; token: string; timed: boolean }
export type EditorWords = {
  words: EditorWord[]
  gaps: Gap[]
  silence: TimeRange[]
  durationMs: number
  /** Precise word timing ran on these words. */
  aligned: boolean
  /** Confident aligned midpoints, sorted (for classifying any time). */
  midpoints: number[]
}

const middle = (r: TimeRange): number => (r.start + r.end) / 2

/** Sorted, merged, valid measured silence. */
function cleanSilence(silence: readonly TimeRange[] | undefined, durationMs: number): TimeRange[] {
  const valid = (silence ?? []).filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end))
  return normaliseRanges(valid as TimeRange[], valid.reduce((max, s) => Math.max(max, s.end), durationMs))
}

/**
 * The transcript's word token for exact-repeat matching: the aligner's stored normalisation when it ran,
 * else the word as written with its case folded and its punctuation marks dropped (Unicode classes, so
 * any language). Two tokens are equal only when these strings are equal; there is no fuzzy matching.
 */
function tokenOf(word: TranscriptWord): string {
  const stored = word.alignment?.normalised
  if (typeof stored === 'string' && stored) return stored
  return word.text.normalize('NFC').toLocaleLowerCase().replace(/[\p{P}\p{Z}]/gu, '')
}

/** A confident aligned midpoint between words i and i+1, exactly as transcript-contract's alignedCutEdge accepts it. */
function alignedMidpoint(words: readonly TranscriptWord[], alignment: AlignmentProvenance | undefined, segOf: Int32Array, i: number): number | null {
  if (alignment?.version !== 1) return null
  const m = alignment.midpoints[i]
  if (typeof m !== 'number' || !Number.isFinite(m)) return null
  const left = words[i]?.alignment, right = words[i + 1]?.alignment
  if (!left || !right || left.status !== 'aligned' || right.status !== 'aligned') return null
  if (left.confidence < ALIGNMENT_CONFIDENCE || right.confidence < ALIGNMENT_CONFIDENCE) return null
  if (typeof left.end !== 'number' || typeof right.start !== 'number' || left.end > right.start || m !== (left.end + right.start) / 2) return null
  // Cross-segment midpoints are unmeasured (slice 2b): both words must sit in one transcript segment.
  if (segOf[i] < 0 || segOf[i] !== segOf[i + 1]) return null
  return m
}

/** Which transcript segment holds each word (half-open membership, as segmentWordEnds), or -1. */
function segmentOfWords(words: readonly TranscriptWord[], segments: readonly TimeRange[] | undefined): Int32Array {
  const out = new Int32Array(words.length).fill(-1)
  const segs = (segments ?? []).map((s, i) => ({ ...s, i })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((a, b) => a.start - b.start || a.end - b.end)
  let j = 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    while (j < segs.length && segs[j].end <= w.start) j++
    for (let k = j; k < segs.length && segs[k].start <= w.start; k++) {
      if (w.start >= segs[k].start && w.start < segs[k].end && w.end <= segs[k].end) { out[i] = segs[k].i; break }
    }
  }
  return out
}

/**
 * Each word's times as everything downstream uses them (rows, selection, the playing word, what a cut
 * removes, captions). A word precise word timing placed uses its aligned times. A word it left unplaced
 * keeps the transcriber's time only where that overlaps the gap between its placed neighbours by at
 * least `untimedGapMs`; otherwise no time is invented: it is untimed, sits at the middle of that gap
 * (zero length, so it is removed only by a cut over that gap, with a neighbour), and is left out of the
 * playing-word highlight. A transcript without alignment uses the transcriber's times as stored.
 */
export function projectWordTimes(raw: readonly TranscriptWord[]): Array<TimeRange & { timed: boolean }> {
  const n = raw.length
  const placed = raw.map((w) => {
    const a = w.alignment
    return a?.status === 'aligned' && typeof a.start === 'number' && typeof a.end === 'number' && Number.isFinite(a.start) && Number.isFinite(a.end) && a.end >= a.start ? { start: a.start, end: a.end } : null
  })
  const nextPlaced = new Array<number>(n)
  for (let i = n - 1, next = Infinity; i >= 0; i--) { nextPlaced[i] = next; if (placed[i]) next = (placed[i] as TimeRange).start }
  const out: Array<TimeRange & { timed: boolean }> = []
  let prevStart = -Infinity, prevEnd = 0
  for (let i = 0; i < n; i++) {
    const p = placed[i]
    let start: number, end: number, timed = true
    if (p) { start = Math.max(p.start, prevStart); end = Math.max(p.end, start) }
    else if (raw[i].alignment?.status !== 'unplaced') { start = Math.max(raw[i].start, prevStart); end = Math.max(raw[i].end, start) }
    else {
      const lo = prevEnd, hi = Math.max(lo, Number.isFinite(nextPlaced[i]) ? nextPlaced[i] : Math.max(lo, raw[i].end))
      start = Math.min(Math.max(raw[i].start, lo), hi)
      end = Math.min(Math.max(raw[i].end, start), hi)
      if (end - start < EDITOR_THRESHOLDS.untimedGapMs) { timed = false; start = end = (lo + hi) / 2 }
    }
    out.push({ start, end, timed }); prevStart = start
    if (timed) prevEnd = Math.max(prevEnd, end)
  }
  return out
}

/**
 * Prepare the words once per transcript: projected times, tokens, every gap's pause, cut point and
 * quality. Linear in the number of words and pauses.
 */
export function editorWords(transcript: EditorTranscript | null | undefined, durationMs: number): EditorWords {
  const raw = (transcript?.words ?? []).filter((w) => w && typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
  const silence = cleanSilence(transcript?.silence, durationMs)
  const times = projectWordTimes(raw)
  const words: EditorWord[] = raw.map((w, i) => ({ text: w.text, start: times[i].start, end: times[i].end, mid: (times[i].start + times[i].end) / 2, token: tokenOf(w), timed: times[i].timed }))
  // Pauses are measured between timed words: an untimed word does not split the pause it sits in.
  const prevTimedMid = new Array<number>(words.length + 1), nextTimedMid = new Array<number>(words.length + 1)
  for (let i = 0, m = 0; i <= words.length; i++) { prevTimedMid[i] = m; if (i < words.length && words[i].timed) m = words[i].mid }
  for (let i = words.length, m = durationMs; i >= 0; i--) { nextTimedMid[i] = m; if (i > 0 && words[i - 1].timed) m = words[i - 1].mid }
  const n = words.length
  const segOf = segmentOfWords(raw, transcript?.segments)
  const aligned = transcript?.alignment?.version === 1
  const gaps: Gap[] = []
  const midpoints: number[] = []
  let s = 0
  for (let i = 0; i <= n; i++) {
    // Between the nearest timed words on either side (an untimed word does not split a pause).
    const from = i === 0 ? 0 : words[i - 1].timed ? words[i - 1].mid : prevTimedMid[i - 1]
    const to = i === n ? durationMs : words[i].timed ? words[i].mid : nextTimedMid[i + 1]
    // The measured silence between the two words' middles: the longest piece of it.
    while (s < silence.length && silence[s].end <= from) s++
    let pause: TimeRange | null = null
    for (let k = s; k < silence.length && silence[k].start < to; k++) {
      const piece = { start: Math.max(from, silence[k].start), end: Math.min(to, silence[k].end) }
      if (piece.end > piece.start && (!pause || piece.end - piece.start > pause.end - pause.start)) pause = piece
    }
    const pauseMs = pause ? pause.end - pause.start : 0
    const cleanPause = !!pause && pauseMs >= EDITOR_THRESHOLDS.clean.silenceMs && pauseMs / 2 >= EDITOR_THRESHOLDS.clean.keptMs
    const mid = i > 0 && i < n ? alignedMidpoint(raw, transcript?.alignment, segOf, i - 1) : null
    if (mid !== null) midpoints.push(mid)
    let point: number, quality: Quality, isAligned = false
    if (i === 0) { point = 0; quality = 'clean' }
    else if (i === n) { point = durationMs; quality = 'clean' }
    else if (cleanPause) { point = middle(pause as TimeRange); quality = 'clean' }
    else if (mid !== null) { point = mid; quality = 'clean'; isAligned = true }
    else { point = pause ? middle(pause) : (words[i - 1].end <= words[i].start ? (words[i - 1].end + words[i].start) / 2 : (from + to) / 2); quality = 'close' }
    // A gap point never leaves the space between the two words' middles.
    if (i > 0 && i < n) point = Math.min(Math.max(point, from), to)
    gaps.push({ index: i, pause, pauseMs, point, quality, cleanPause: i > 0 && i < n && cleanPause, aligned: isAligned })
  }
  midpoints.sort((a, b) => a - b)
  return { words, gaps, silence, durationMs, aligned, midpoints }
}

const FRAME_MS = msOfFrame(1)
const HALF_FRAME_MS = FRAME_MS / 2 + 0.5
/** A frame boundary as the sidecar stores it (whole ms); frameOf() of it gives the frame back. */
const frameMs = (f: number): number => Math.round(msOfFrame(f))

function lowerBound(sorted: readonly number[], t: number): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < t) lo = m + 1; else hi = m }
  return lo
}

/**
 * Is a cut edge at `t` clean or close? A start edge keeps the sound before it, an end edge the sound
 * after it. Clean: the recording's own start or end; a confident aligned midpoint (within half a frame:
 * every cut is played and exported on the 30 fps grid, and the join fade covers that much); or inside a measured silence of at least 500 ms with at least
 * 200 ms of it kept on the kept side. Everything else is close. Without alignment only pauses count.
 */
export function edgeQuality(ctx: EditorWords, t: number, side: 'start' | 'end'): Quality {
  if (t <= 0 || t >= ctx.durationMs) return 'clean'
  const tol = HALF_FRAME_MS
  const m = lowerBound(ctx.midpoints, t - tol)
  if (m < ctx.midpoints.length && Math.abs(ctx.midpoints[m] - t) <= tol) return 'clean'
  const starts = ctx.silence
  let lo = 0, hi = starts.length
  while (lo < hi) { const k = (lo + hi) >> 1; if (starts[k].end < t) lo = k + 1; else hi = k }
  const s = starts[lo]
  if (!s || s.start > t) return 'close'
  const kept = side === 'start' ? t - s.start : s.end - t
  return s.end - s.start >= EDITOR_THRESHOLDS.clean.silenceMs && kept >= EDITOR_THRESHOLDS.clean.keptMs ? 'clean' : 'close'
}

/** The Run time range covering words a..b (inclusive): from the gap before a to the gap after b. */
export function wordsRange(ctx: EditorWords, a: number, b: number): TimeRange {
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(ctx.words.length - 1, Math.max(a, b))
  return { start: Math.round(ctx.gaps[lo].point), end: Math.round(ctx.gaps[hi + 1].point) }
}

/** The first word whose middle is at or after `t` (n when none). */
export function wordAtOrAfter(ctx: EditorWords, t: number): number {
  let lo = 0, hi = ctx.words.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (ctx.words[m].mid < t) lo = m + 1; else hi = m }
  return lo
}
/** The word being said at `t` (the last word starting at or before it), or -1 before the first. */
export function wordAt(ctx: EditorWords, t: number): number {
  let lo = 0, hi = ctx.words.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (ctx.words[m].start <= t) lo = m + 1; else hi = m }
  return lo - 1
}

// ---- Rows: the talk slide by slide -------------------------------------------------------------------

export type EditorRow = {
  /** Position in recording order (a slide shown twice has two rows). */
  index: number
  slideId: string
  /** The slide change this row starts at: its `enter` time in whole milliseconds (0 for the first row). */
  change: number
  /** Where the picture really changed. */
  enterMs: number
  /** The row's stretch of the Run at its edit boundaries: [start, end). */
  start: number
  end: number
  /** Its words: [firstWord, endWord). */
  firstWord: number
  endWord: number
  /** Where the slide's words start by the rule, before any move. */
  defaultStart: number
  /** The owner's move, if any. */
  moved: EditBoundary | null
  /** Is the start (the "slide starts here" marker) a clean place to cut? */
  startQuality: Quality
  /** The word before which the picture really changed, when that is not where the marker is. */
  click: number | null
  /** No clean pause within two seconds of the slide change, and the owner has not chosen the word. */
  noClearPause: boolean
  /** Steps (reveals) shown on this slide: Run time and the word before which each happened. */
  steps: Array<{ tMs: number; word: number }>
}

type Visit = { slideId: string; enterMs: number; change: number }

/** Slide visits from the Run's `enter` events: in time order, repeated entries of one slide merged. */
export function slideVisits(marks: readonly RunMark[] | undefined): Visit[] {
  const enters = (marks ?? []).filter((m) => m && m.event === 'enter' && typeof m.slideId === 'string' && m.slideId && Number.isFinite(m.tMs))
    .map((m, order) => ({ m, order })).sort((a, b) => a.m.tMs - b.m.tMs || a.order - b.order).map(({ m }) => m)
  const visits: Visit[] = []
  for (const e of enters) {
    const change = Math.max(0, Math.round(e.tMs))
    const last = visits.at(-1)
    if (last && last.slideId === e.slideId) continue
    // Two changes at the same instant: the later one is what was shown.
    if (last && last.change === change) { visits[visits.length - 1] = { slideId: e.slideId as string, enterMs: e.tMs, change }; continue }
    visits.push({ slideId: e.slideId as string, enterMs: e.tMs, change })
  }
  if (visits.length) { visits[0].change = 0 }
  return visits
}

/**
 * The Slide boundary rule as narrowed by "Clean and tight cuts" item 4. Words split into stretches at
 * clean pauses; each stretch goes to the slide visit on which more of its spoken time falls (a tie to
 * the earlier one); a slide's words start at the clean pause before its first stretch. A boundary the
 * owner moved (sidecar `boundaries`) replaces that start; a word belongs to the row its middle falls in.
 */
export function slideRows(ctx: EditorWords, marks: readonly RunMark[] | undefined, moved: readonly EditBoundary[] = []): EditorRow[] {
  const { words, gaps, durationMs } = ctx
  const n = words.length
  let visits = slideVisits(marks)
  if (!visits.length) visits = [{ slideId: '', enterMs: 0, change: 0 }]
  const V = visits.length
  const visitStart = (k: number): number => (k === 0 ? 0 : visits[k].enterMs)
  const visitEnd = (k: number): number => (k + 1 < V ? visits[k + 1].enterMs : durationMs)

  // Stretches between clean pauses, each given to one visit (non-decreasing in time).
  const firstOf = new Int32Array(V).fill(-1)
  let k = 0, prevVisit = 0
  for (let a = 0; a < n;) {
    let b = a
    while (b + 1 < n && !gaps[b + 1].cleanPause) b++
    // Spoken time of words a..b on each visit they touch.
    while (k + 1 < V && visitEnd(k) <= words[a].start) k++
    let best = -1, bestMs = -1
    for (let v = k; v < V && visitStart(v) < Math.max(words[b].end, words[a].start + 1); v++) {
      let ms = 0
      for (let i = a; i <= b; i++) ms += Math.max(0, Math.min(words[i].end, visitEnd(v)) - Math.max(words[i].start, visitStart(v)))
      if (ms > bestMs) { bestMs = ms; best = v }
    }
    if (best < 0 || bestMs <= 0) {
      // Words with no length: the visit holding the stretch's middle.
      const t = (words[a].start + words[b].end) / 2
      best = 0
      for (let v = 0; v < V; v++) if (visitStart(v) <= t) best = v
    }
    best = Math.max(best, prevVisit)
    prevVisit = best
    if (firstOf[best] < 0) firstOf[best] = a
    a = b + 1
  }

  // Default starts: the gap before the visit's first word; a visit without words sits at its click,
  // inside the gap between the words around it.
  const defaults = new Array<number>(V).fill(0)
  const firstWordOf = new Int32Array(V)
  let next = n
  for (let v = V - 1; v >= 0; v--) {
    if (firstOf[v] >= 0) next = firstOf[v]
    firstWordOf[v] = firstOf[v] >= 0 ? firstOf[v] : next
  }
  const defaultQuality: Quality[] = new Array(V).fill('clean')
  for (let v = 1; v < V; v++) {
    const w = firstWordOf[v]
    if (firstOf[v] >= 0) { defaults[v] = gaps[w].point; defaultQuality[v] = gaps[w].quality }
    else {
      const lo = w > 0 ? words[w - 1].end : 0, hi = w < n ? words[w].start : durationMs
      defaults[v] = Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), visits[v].enterMs))
      defaultQuality[v] = edgeQuality(ctx, defaults[v], 'start')
    }
  }

  const movedBy = new Map(moved.map((b) => [b.change, b]))
  const starts = new Array<number>(V).fill(0)
  const quality: Quality[] = new Array(V).fill('clean')
  const applied: Array<EditBoundary | null> = new Array(V).fill(null)
  for (let v = 1; v < V; v++) {
    const m = movedBy.get(visits[v].change)
    if (m) { starts[v] = m.at; applied[v] = m; quality[v] = edgeQuality(ctx, m.at, 'start') }
    else { starts[v] = defaults[v]; quality[v] = defaultQuality[v] }
    starts[v] = Math.max(starts[v], starts[v - 1])
  }

  // Words by their middles; clean pauses near each change; steps and clicks.
  const cleanPoints: number[] = []
  for (const g of gaps) if (g.cleanPause) cleanPoints.push(g.point)
  const reveals = (marks ?? []).filter((m) => m && m.event === 'reveal' && Number.isFinite(m.tMs)).map((m) => ({ tMs: m.tMs, slideId: m.slideId })).sort((a, b) => a.tMs - b.tMs)
  const rows: EditorRow[] = []
  let r = 0
  for (let v = 0; v < V; v++) {
    const start = starts[v], end = v + 1 < V ? starts[v + 1] : durationMs
    const firstWord = wordAtOrAfter(ctx, start)
    const endWord = v + 1 < V ? wordAtOrAfter(ctx, end) : n
    let noClearPause = false
    let click: number | null = null
    if (v > 0) {
      const t = visits[v].enterMs
      const c = lowerBound(cleanPoints, t - EDITOR_THRESHOLDS.noClearPauseMs)
      noClearPause = !(c < cleanPoints.length && cleanPoints[c] <= t + EDITOR_THRESHOLDS.noClearPauseMs) && !applied[v]
      const w = wordAtOrAfter(ctx, t)
      if (w !== firstWord && w < n && w > 0) click = w
    }
    const steps: Array<{ tMs: number; word: number }> = []
    const vs = visitStart(v), ve = visitEnd(v)
    while (r < reveals.length && reveals[r].tMs < vs) r++
    for (let q = r; q < reveals.length && reveals[q].tMs < ve; q++) {
      if (reveals[q].slideId && reveals[q].slideId !== visits[v].slideId) continue
      steps.push({ tMs: reveals[q].tMs, word: wordAtOrAfter(ctx, reveals[q].tMs) })
    }
    rows.push({ index: v, slideId: visits[v].slideId, change: visits[v].change, enterMs: visits[v].enterMs, start, end, firstWord, endWord: Math.max(firstWord, endWord), defaultStart: defaults[v], moved: applied[v], startQuality: quality[v], click, noClearPause, steps })
  }
  return rows
}

/** Places a slide's start may be moved to: clean pauses (snap) or, with `any`, every word. */
export function boundaryTargets(ctx: EditorWords, rows: readonly EditorRow[], index: number, any: boolean): Array<{ word: number; at: number; quality: Quality; pauseMs: number }> {
  if (index <= 0 || index >= rows.length) return []
  const lo = rows[index - 1].firstWord + 1, hi = rows[index].endWord - (index + 1 < rows.length ? 1 : 0)
  const out: Array<{ word: number; at: number; quality: Quality; pauseMs: number }> = []
  for (let w = Math.max(1, lo); w <= Math.min(ctx.words.length - 1, hi); w++) {
    const g = ctx.gaps[w]
    if (any || g.cleanPause) out.push({ word: w, at: Math.round(g.point), quality: g.quality, pauseMs: g.pauseMs })
  }
  return out
}

/** Move the start of row `index` to the gap before word `word` (`any`: a word rather than a clear pause). */
export function moveBoundaryOp(ctx: EditorWords, row: EditorRow, word: number, any: boolean): EditOp {
  const at = Math.round(ctx.gaps[Math.max(0, Math.min(ctx.words.length, word))].point)
  return at === Math.round(row.defaultStart) ? { kind: 'boundary', change: row.change, at: null } : { kind: 'boundary', change: row.change, at, any: any && !ctx.gaps[word]?.cleanPause }
}
export function putBoundaryBackOp(row: EditorRow): EditOp {
  return { kind: 'boundary', change: row.change, at: null }
}

// ---- Cuts on the edit list ------------------------------------------------------------------------------

/** Is this slide left out (the sidecar's fact, not a coincidence of cuts)? */
export function isLeftOut(row: EditorRow, leftOut: readonly number[]): boolean {
  return leftOut.includes(row.change)
}
/** Leave this slide out: recorded as its own fact; the plan cuts the slide at its edit boundaries. */
export function leaveOutOp(row: EditorRow): EditOp {
  return { kind: 'leave-out', change: row.change, out: true }
}
/** Put this slide back: removes that fact and nothing else (cuts made inside the slide stay). */
export function putBackOp(row: EditorRow): EditOp {
  return { kind: 'leave-out', change: row.change, out: false }
}

/**
 * Cut words a..b on the 30 fps frame grid the player and the export use. A word is removed when its
 * middle falls in a removed frame, so the cut must start at a frame boundary after the middle of the
 * word before, at or before the middle of the first selected word, and end after the middle of the last
 * selected word, at or before the middle of the word after. Within those limits the boundary nearest the
 * pause (or midpoint) between the words is used. When no frame boundary fits (the words are shorter than
 * a frame), the cut is refused rather than saved as a cut that removes nothing or swallows a kept word.
 */
export function cutWordsOp(ctx: EditorWords, a: number, b: number): { op: EditOp; range: TimeRange } | { error: string } {
  const n = ctx.words.length
  const first = Math.max(0, Math.min(a, b)), last = Math.min(n - 1, Math.max(a, b))
  if (!n || first > last) return { error: 'Select some words first.' }
  if (!ctx.words.slice(first, last + 1).some((x) => x.timed)) return { error: 'This word has no time of its own in the recording. Select it together with the word before or after it.' }
  const total = frameOf(ctx.durationMs)
  const lo = first > 0 ? ctx.words[first - 1].mid : -Infinity
  const hi = last < n - 1 ? ctx.words[last + 1].mid : Infinity
  // Smallest frame f with msOfFrame(f) > x, and the largest with msOfFrame(f) <= x.
  const after = (x: number): number => (x === -Infinity ? 0 : Math.floor((x * VIDEO_FRAME.fps) / 1000) + 1)
  const atOrBefore = (x: number): number => (x === Infinity ? total : Math.floor((x * VIDEO_FRAME.fps) / 1000))
  const fsMin = Math.max(0, after(lo)), fsMax = Math.min(total, atOrBefore(ctx.words[first].mid))
  const feMin = Math.max(0, after(ctx.words[last].mid)), feMax = Math.min(total, atOrBefore(hi))
  if (fsMin > fsMax || feMin > feMax) return { error: 'These words are shorter than a frame of video, so they cannot be cut on their own. Select a word more on either side.' }
  const clamp = (f: number, min: number, max: number): number => Math.min(max, Math.max(min, f))
  const fs = first === 0 ? fsMin : clamp(frameOf(ctx.gaps[first].point), fsMin, fsMax)
  const fe = last === n - 1 ? feMax : clamp(frameOf(ctx.gaps[last + 1].point), feMin, feMax)
  if (fe <= fs) return { error: 'These words are shorter than a frame of video, so they cannot be cut on their own. Select a word more on either side.' }
  const range = { start: frameMs(fs), end: frameMs(fe) }
  return { op: { kind: 'cut', ranges: [range] }, range }
}
export function restoreOp(range: TimeRange): EditOp {
  return { kind: 'restore', ranges: [{ start: Math.floor(range.start), end: Math.ceil(range.end) }] }
}
/** How much of [start, end) the cuts cover. */
export function coveredMs(cuts: readonly TimeRange[], range: TimeRange): number {
  let ms = 0
  for (const c of cuts) ms += Math.max(0, Math.min(c.end, range.end) - Math.max(c.start, range.start))
  return ms
}

/** A stretch the plan removes, as the editor shows it. */
export type CutView = TimeRange & {
  startQuality: Quality
  endQuality: Quality
  /** Close at either edge: shown as a Close cut. */
  close: boolean
  /** Words removed (their middles fall inside): [firstWord, endWord). */
  firstWord: number
  endWord: number
  /** What "Put the words back" restores: the saved cuts that make this stretch; null when none (a slide left out, or trimmed in the transcript). */
  restore: TimeRange | null
  /** Part of it comes from a slide left out. */
  leftOut: boolean
  /** Part of it comes from Trims saved on the Run in Studio's transcript. */
  fromTrims: boolean
}

/**
 * What the plan removes, stretch by stretch: the gaps between the kept spans on the frame grid, exactly as
 * the player skips them and the export cuts them. A saved cut too short to remove a frame shows nothing.
 */
export function planViews(ctx: EditorWords, spans: readonly KeptSpan[], durationMs: number, sources: { sidecar: readonly TimeRange[]; leftOut: readonly TimeRange[]; trims: readonly TimeRange[] }): CutView[] {
  const removed: TimeRange[] = []
  let cursor = 0
  const end = msOfFrame(frameOf(durationMs))
  for (const s of spans) { if (s.startMs > cursor) removed.push({ start: cursor, end: s.startMs }); cursor = s.endMs }
  if (end > cursor) removed.push({ start: cursor, end })
  const touching = (list: readonly TimeRange[], r: TimeRange): TimeRange[] => list.filter((c) => c.end > r.start - HALF_FRAME_MS && c.start < r.end + HALF_FRAME_MS)
  return removed.map((r) => {
    const startQuality = edgeQuality(ctx, r.start, 'start'), endQuality = edgeQuality(ctx, r.end, 'end')
    const firstWord = wordAtOrAfter(ctx, r.start)
    const endWord = Math.max(firstWord, wordAtOrAfter(ctx, r.end))
    const own = touching(sources.sidecar, r)
    return {
      ...r, startQuality, endQuality, close: startQuality === 'close' || endQuality === 'close', firstWord, endWord,
      restore: own.length ? { start: Math.min(...own.map((c) => c.start)), end: Math.max(...own.map((c) => c.end)) } : null,
      leftOut: touching(sources.leftOut, r).length > 0, fromTrims: touching(sources.trims, r).length > 0
    }
  })
}

/**
 * The nearest clean place for a cut edge, outward (making the cut longer) or inward (shorter), and the
 * one operation that moves it there. Clean places are gap points judged clean (a measured pause of at
 * least 500 ms, or a confident aligned midpoint), on the frame grid. Null when none lies within reach.
 */
export function nearestCleanEdge(ctx: EditorWords, cut: TimeRange, side: 'start' | 'end', direction: 'outward' | 'inward'): { at: number; op: EditOp } | null {
  const t = side === 'start' ? cut.start : cut.end
  const earlier = (side === 'start') === (direction === 'outward')
  const reach = EDITOR_THRESHOLDS.nearestPauseMs
  let best: number | null = null
  for (const g of ctx.gaps) {
    if (g.quality !== 'clean' || g.index === 0 || g.index === ctx.words.length) continue
    const p = frameMs(frameOf(g.point))
    if (earlier ? !(p < t - 1 && p >= t - reach) : !(p > t + 1 && p <= t + reach)) continue
    // Inward never crosses the cut's other edge.
    if (direction === 'inward' && (side === 'start' ? p >= cut.end - 1 : p <= cut.start + 1)) continue
    if (best === null || Math.abs(p - t) < Math.abs(best - t)) best = p
  }
  if (best === null) return null
  const a = Math.round(t)
  const op: EditOp = direction === 'outward'
    ? { kind: 'cut', ranges: [side === 'start' ? { start: best, end: a } : { start: a, end: best }] }
    : { kind: 'restore', ranges: [side === 'start' ? { start: Math.floor(t), end: best } : { start: best, end: Math.ceil(t) }] }
  return { at: best, op }
}

// ---- The resolved edit state -------------------------------------------------------------------------

export type ResolvedRecording = {
  ctx: EditorWords
  rows: EditorRow[]
  /** Rows left out (indexes into rows). */
  leftOutRows: Set<number>
  /** Every cut the plan applies, in Run time: saved cuts, the Run's own Trims less restored parts, slides left out. */
  cuts: TimeRange[]
  /** The kept spans on the 30 fps grid: what the player plays and the export keeps. */
  spans: KeptSpan[]
  editedMs: number
  /** What the plan removes, stretch by stretch, with the words in each. */
  views: CutView[]
  /** For chapters: where each slide kept in the video starts — its real slide change, or the start the owner moved it to — in Run time. */
  chapterMarks: Array<{ tMs: number; slideId: string }>
  /**
   * For captions: the words the plan keeps, with their times and their place in the transcript. An untimed
   * word takes the times of the kept timed word before it (or after it) and keeps its own place, so it rides
   * in that word's cue in transcript order.
   */
  captionWords: Array<{ text: string; start: number; end: number; order: number }>
  /** Whether a word's middle is removed by the plan. */
  wordCut: Uint8Array
}

/**
 * The one resolved edit state of a layered Run. The editor's words, the length in the bar, the player,
 * the recording panel, captions, chapters and the export all read this, so they cannot disagree about
 * what is cut. Pure and deterministic; main computes it from the same files when it exports.
 */
export function resolveRecording(input: {
  durationMs: number
  edits: Pick<RecordingEdits, 'cuts' | 'boundaries' | 'leftOut' | 'restoredTrims'>
  runTrims?: readonly TimeRange[]
  marks?: readonly RunMark[]
  transcript?: EditorTranscript | null
  /** The prepared words for this transcript, when the caller already has them. */
  ctx?: EditorWords
}): ResolvedRecording {
  const { durationMs, edits } = input
  const ctx = input.ctx ?? editorWords(input.transcript, durationMs)
  const rows = slideRows(ctx, input.marks, edits.boundaries ?? [])
  const leftOutRows = new Set<number>()
  const leftOutSpans: TimeRange[] = []
  for (const r of rows) if ((edits.leftOut ?? []).includes(r.change)) { leftOutRows.add(r.index); leftOutSpans.push({ start: Math.round(r.start), end: Math.round(r.end) }) }
  const trims = effectiveCuts([], input.runTrims as TimeRange[] | undefined, durationMs, edits.restoredTrims ?? [])
  const cuts = normaliseRanges([...edits.cuts, ...trims, ...leftOutSpans], durationMs)
  const spans = keptSpans(cuts, durationMs)
  const views = planViews(ctx, spans, durationMs, { sidecar: edits.cuts, leftOut: leftOutSpans, trims })
  const wordCut = new Uint8Array(ctx.words.length)
  for (const v of views) for (let w = v.firstWord; w < v.endWord; w++) wordCut[w] = 1
  // A chapter starts at the slide's real change unless the owner moved that slide's start; the inferred
  // start of a slide's words is for showing them on rows, not for chapters (an untouched Run keeps PR 347's).
  const chapterMarks = rows.filter((r) => !leftOutRows.has(r.index) && r.slideId).map((r) => ({ tMs: r.index === 0 ? 0 : r.moved ? r.start : r.enterMs, slideId: r.slideId }))
  const captionWords: Array<{ text: string; start: number; end: number; order: number }> = []
  const words = ctx.words
  for (let i = 0; i < words.length; i++) {
    if (wordCut[i]) continue
    if (words[i].timed) { captionWords.push({ text: words[i].text, start: words[i].start, end: words[i].end, order: i }); continue }
    // An untimed word joins the cue of the kept timed word next to it: that word's times, its own place.
    let j = i - 1
    while (j >= 0 && (wordCut[j] || !words[j].timed)) j--
    if (j < 0) { j = i + 1; while (j < words.length && (wordCut[j] || !words[j].timed)) j++ }
    if (j < words.length) captionWords.push({ text: words[i].text, start: words[j].start, end: words[j].end, order: i })
  }
  return { ctx, rows, leftOutRows, cuts, spans, editedMs: editedDurationMs(spans), views, chapterMarks, wordCut, captionWords }
}

/**
 * A short fingerprint of what an export of this state would write: the kept frames, the chapter marks, and
 * the caption cues themselves (from the words, or from the transcript's segments when there are no word
 * timings). The window sends it with Export; main works out the same from the saved files and refuses when
 * they differ, so the file is what the screen showed or nothing.
 */
export function planDigest(r: Pick<ResolvedRecording, 'spans' | 'chapterMarks' | 'captionWords'>, segments: ReadonlyArray<{ start: number; end: number; text: string }> | null | undefined): string {
  let h = 0x811c9dc5
  const add = (text: string): void => { for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } }
  for (const s of r.spans) add(`s${s.startFrame}-${s.endFrame};`)
  for (const c of r.chapterMarks) add(`c${Math.round(c.tMs)}:${c.slideId};`)
  const cues = captionCues(r.captionWords, r.spans, (segments ?? []).filter((g) => g && typeof g.text === 'string')).cues
  for (const c of cues) add(`q${c.startMs}-${c.endMs}:${c.text};`)
  return `${r.spans.length}.${r.chapterMarks.length}.${cues.length}.${h.toString(16)}`
}

// ---- Tidy up ----------------------------------------------------------------------------------------

export type TidyKind = 'marked' | 'pauses' | 'repeats' | 'ends' | 'fillers'
export type TidyProposal = {
  id: string
  kind: TidyKind
  range: TimeRange
  /** The words it removes ([firstWord, endWord)); equal for a pause. */
  firstWord: number
  endWord: number
  /** What it removes, quoted for the owner (the words, or the pause's length). */
  text: string
  quality: Quality
  /** Time it removes that is not cut already. */
  savesMs: number
  /** The row it falls in. */
  row: number
  /** For a pause: its length before. */
  pauseMs?: number
}
export type TidyResult = {
  proposals: TidyProposal[]
  /** Um and er: listed only where the transcriber itself marked fillers; this transcript does not. */
  fillers: { proposals: TidyProposal[]; reason: string | null }
}

function rowOf(rows: readonly EditorRow[], t: number): number {
  let r = 0
  for (let i = 0; i < rows.length; i++) if (rows[i].start <= t) r = i
  return r
}

/** A short quotation of words a..b-1. */
export function quoteWords(ctx: EditorWords, a: number, b: number, max = 8): string {
  if (b <= a) return ''
  const w = ctx.words.slice(a, b).map((x) => x.text)
  return w.length <= max ? w.join(' ') : `${w.slice(0, max).join(' ')}…`
}

/**
 * The words a Mark a mistake points at: the stretch between clean pauses that ends with the last word
 * said before the mark was pressed. Null before the first word.
 */
export function markedStretch(ctx: EditorWords, flagMs: number): { firstWord: number; lastWord: number; range: TimeRange; quality: Quality } | null {
  const { words, gaps } = ctx
  let last = -1
  for (let lo = 0, hi = words.length; lo < hi;) { const m = (lo + hi) >> 1; if (words[m].end <= flagMs + EDITOR_THRESHOLDS.flagGraceMs) { last = m; lo = m + 1 } else hi = m }
  if (last < 0) return null
  let first = last
  while (first > 0 && !gaps[first].cleanPause) first--
  const range = wordsRange(ctx, first, last)
  const long = words[last].end - words[first].start > EDITOR_THRESHOLDS.markedStretchMaxMs
  const quality: Quality = long || edgeQuality(ctx, range.start, 'start') === 'close' || edgeQuality(ctx, range.end, 'end') === 'close' ? 'close' : 'clean'
  return { firstWord: first, lastWord: last, range, quality }
}

/**
 * Tidy up's proposals. Never applies anything: the sheet ticks the clean ones and lists the close ones
 * under "Needs a listen". Leaves out what is already cut (half or more of it).
 */
export function tidyProposals(ctx: EditorWords, rows: readonly EditorRow[], marks: readonly RunMark[] | undefined, cuts: readonly TimeRange[]): TidyResult {
  const out: TidyProposal[] = []
  const { words, gaps } = ctx
  const n = words.length
  const add = (kind: TidyKind, range: TimeRange, firstWord: number, endWord: number, text: string, quality: Quality, extra: Partial<TidyProposal> = {}): void => {
    const r = { start: Math.round(range.start), end: Math.round(range.end) }
    // A proposal the frame grid would not remove a single frame of is not offered.
    if (frameOf(r.end) <= frameOf(r.start)) return
    const already = coveredMs(cuts, r)
    if (already * 2 >= r.end - r.start) return
    out.push({ id: `${kind}:${r.start}-${r.end}`, kind, range: r, firstWord, endWord, text, quality, savesMs: r.end - r.start - already, row: rowOf(rows, r.start), ...extra })
  }
  const rangeQuality = (r: TimeRange): Quality => (edgeQuality(ctx, r.start, 'start') === 'clean' && edgeQuality(ctx, r.end, 'end') === 'clean' ? 'clean' : 'close')

  // Marked while recording: the stretch between clean pauses that ends with the last word before the flag.
  const flags = (marks ?? []).filter((m) => m && m.event === 'flag' && Number.isFinite(m.tMs)).sort((a, b) => a.tMs - b.tMs)
  for (const f of flags) {
    const m = markedStretch(ctx, f.tMs)
    if (m) add('marked', m.range, m.firstWord, m.lastWord + 1, quoteWords(ctx, m.firstWord, m.lastWord + 1), m.quality)
  }

  // Long pauses, shortened to half a second (a quarter of a second kept on each side).
  for (let i = 1; i < n; i++) {
    const g = gaps[i]
    if (!g.pause || g.pauseMs <= EDITOR_THRESHOLDS.tidyPauseMs) continue
    const keep = EDITOR_THRESHOLDS.tidyPauseKeepMs / 2
    const range = { start: g.pause.start + keep, end: g.pause.end - keep }
    add('pauses', range, i, i, `${(g.pauseMs / 1000).toFixed(1)} s`, rangeQuality(range), { pauseMs: g.pauseMs })
  }

  // Exact repeats: the same run of the transcript's tokens said twice in a row; the first saying is cut.
  const cutWord = new Uint8Array(n)
  for (const c of cuts) for (let i = wordAtOrAfter(ctx, c.start); i < n && words[i].mid < c.end; i++) cutWord[i] = 1
  for (let i = 0; i < n;) {
    let found = 0
    for (let len = Math.min(EDITOR_THRESHOLDS.repeatMaxWords, Math.floor((n - i) / 2)); len >= EDITOR_THRESHOLDS.repeatMinWords; len--) {
      let same = true
      for (let j = 0; j < len && same; j++) {
        const a = words[i + j], b = words[i + len + j]
        if (!a.token || a.token !== b.token || cutWord[i + j] || cutWord[i + len + j]) same = false
      }
      if (same) { found = len; break }
    }
    if (!found) { i++; continue }
    const range = wordsRange(ctx, i, i + found - 1)
    add('repeats', range, i, i + found, quoteWords(ctx, i, i + found), rangeQuality(range))
    i += found * 2
  }

  // Silence at the start and end.
  for (const s of silentEndSuggestions(ctx.silence, ctx.durationMs, trimStartAt(cuts as TimeRange[]), trimEndAt(cuts as TimeRange[], ctx.durationMs))) {
    const range = s.side === 'start' ? { start: 0, end: s.at } : { start: s.at, end: ctx.durationMs }
    add('ends', range, s.side === 'start' ? 0 : n, s.side === 'start' ? 0 : n, s.side === 'start' ? `${(s.silentMs / 1000).toFixed(1)} s before your first word` : `${(s.silentMs / 1000).toFixed(1)} s after your last word`, rangeQuality(range))
  }

  return {
    proposals: out,
    // No engine TalkWeaver uses marks fillers in the stored words (journeys.md, transcription spike
    // decision 5), so nothing is listed rather than guessed from a word list.
    fillers: { proposals: [], reason: 'The transcript does not mark um and er, so TalkWeaver cannot list them.' }
  }
}
