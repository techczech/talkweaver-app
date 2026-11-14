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
import { CLEAN_CUT, type AlignmentProvenance, type TranscriptSentence, type TranscriptWord } from './transcript-contract.ts'
import { ALIGNMENT_CONFIDENCE } from './word-alignment.ts'
import { effectiveCuts, normaliseRanges, trimEndAt, trimStartAt, type EditBoundary, type EditOp, type RecordingEdits, type TimeRange } from './recording-edits.ts'
import { captionCues, editedDurationMs, frameOf, keptSpans, msOfFrame, silentEndSuggestions, VIDEO_FRAME, type KeptSpan } from './recording-video.ts'
import { NO_TAKES, rangesToVideoClock, takeClock, toVideoClock, videoClockMs, type TakeClock, type TakeInsert } from './recording-takes.ts'

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
  /** The sentences stored with the transcript (transcript-contract mapSentences); absent on older Runs. */
  sentences?: readonly TranscriptSentence[]
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
  /**
   * A sentence starts at the word after this gap, by the sentence boundaries stored with the transcript
   * (never guessed here). Its point and quality are the gap's own, so a sentence start in continuous
   * speech is close like any other word gap.
   */
  sentence: boolean
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
  /** The transcript stored sentence boundaries the editor uses (some gap has `sentence`). */
  sentences: boolean
}

/**
 * Which stored sentence boundaries count as places a slide can start: the transcriber's own result or
 * segment ends (`transcriber`), the sentence tokenizer's ends stored at transcription (`punctuation`:
 * Apple's NLTokenizer in the speech helper, never a rule here) and the owner's (`manual`). An
 * `acoustic-pause` end is a measured pause, not a sentence; pauses are targets in their own right.
 */
const SENTENCE_SOURCES: ReadonlySet<string> = new Set(['transcriber', 'punctuation', 'manual'])

/**
 * Gap i (before word i) is a sentence start when a stored sentence ends at word i-1. Only when the stored
 * sentences index these very words (none were dropped as invalid); otherwise there are none.
 */
function sentenceStarts(transcript: EditorTranscript | null | undefined, kept: number): Uint8Array | null {
  const list = transcript?.sentences
  if (!Array.isArray(list) || !list.length || (transcript?.words?.length ?? -1) !== kept) return null
  const out = new Uint8Array(kept + 1)
  let any = false
  for (const s of list) {
    if (!s || !SENTENCE_SOURCES.has(s.boundarySource) || !Number.isInteger(s.lastWord)) continue
    const g = s.lastWord + 1
    if (g > 0 && g < kept) { out[g] = 1; any = true }
  }
  return any ? out : null
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
  const starts = sentenceStarts(transcript, raw.length)
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
    gaps.push({ index: i, pause, pauseMs, point, quality, cleanPause: i > 0 && i < n && cleanPause, aligned: isAligned, sentence: !!starts?.[i] })
  }
  midpoints.sort((a, b) => a - b)
  return { words, gaps, silence, durationMs, aligned, midpoints, sentences: !!starts }
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
  /** What the row's start is at: a clear pause, a sentence start or another word (null: the first row, or a slide with no words of its own). */
  startsAt: TargetKind | null
  /**
   * When there is no clear pause near the slide change: the word the nearest stored sentence start within
   * the same two seconds falls before (it may be where the row starts already), else null.
   */
  sentenceNear: number | null
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
 * the earlier one); a slide's words start at the clean pause before its first stretch.
 *
 * Sentences (0.44.5) refine only a slide change with no clean pause within two seconds of it. The stored
 * sentence spoken across the change goes by the same spoken-time rule: the slide starts at that
 * sentence's start (more of it said after the change) or at its end (more said before), but only when
 * that place is itself within two seconds of the change and keeps the slides in order. Otherwise, for
 * every change with a clean pause near it, and without stored sentences, the start is the rule's above,
 * unchanged. So a default start moves only for a slide flagged "No clear pause", and only to a sentence
 * start within two seconds of its change. A boundary the owner moved (sidecar `boundaries`) replaces
 * that start; a word belongs to the row its middle falls in.
 */
export function slideRows(ctx: EditorWords, marks: readonly RunMark[] | undefined, moved: readonly EditBoundary[] = []): EditorRow[] {
  const { words, gaps, durationMs } = ctx
  const n = words.length
  let visits = slideVisits(marks)
  if (!visits.length) visits = [{ slideId: '', enterMs: 0, change: 0 }]
  const V = visits.length
  const visitStart = (k: number): number => (k === 0 ? 0 : visits[k].enterMs)
  const visitEnd = (k: number): number => (k + 1 < V ? visits[k + 1].enterMs : durationMs)

  // Clean pauses near each change (the same two-second window as the "No clear pause" notice).
  const cleanPoints: number[] = []
  for (const g of gaps) if (g.cleanPause) cleanPoints.push(g.point)
  const pauseNear = (t: number): boolean => {
    const c = lowerBound(cleanPoints, t - EDITOR_THRESHOLDS.noClearPauseMs)
    return c < cleanPoints.length && cleanPoints[c] <= t + EDITOR_THRESHOLDS.noClearPauseMs
  }
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
  // Sentences refine a change with no clean pause near it (see above): the sentence spoken across it.
  if (ctx.sentences && n > 1) for (let v = 1; v < V; v++) {
    const t = visits[v].enterMs
    if (pauseNear(t)) continue
    const at = sentenceSplit(ctx, t)
    if (at === null) continue
    const p = gaps[at].point
    if (p <= defaults[v - 1] || (v + 1 < V && p >= defaults[v + 1])) continue
    defaults[v] = p; defaultQuality[v] = gaps[at].quality
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
  const reveals = (marks ?? []).filter((m) => m && m.event === 'reveal' && Number.isFinite(m.tMs)).map((m) => ({ tMs: m.tMs, slideId: m.slideId })).sort((a, b) => a.tMs - b.tMs)
  const rows: EditorRow[] = []
  let r = 0
  for (let v = 0; v < V; v++) {
    const start = starts[v], end = v + 1 < V ? starts[v + 1] : durationMs
    const firstWord = wordAtOrAfter(ctx, start)
    const endWord = v + 1 < V ? wordAtOrAfter(ctx, end) : n
    let noClearPause = false
    let click: number | null = null
    let sentenceNear: number | null = null
    let startsAt: TargetKind | null = null
    if (v > 0) {
      const t = visits[v].enterMs
      noClearPause = !pauseNear(t) && !applied[v]
      const w = wordAtOrAfter(ctx, t)
      if (w !== firstWord && w < n && w > 0) click = w
      const g = gaps[firstWord]
      if (firstWord > 0 && firstWord < n && Math.round(g.point) === Math.round(start)) startsAt = targetKind(g)
      // The nearest stored sentence start within the same window, inside where this slide's start can move.
      if (noClearPause && ctx.sentences) {
        const lo = Math.max(1, rows[v - 1].firstWord + 1), hi = Math.min(n - 1, Math.max(firstWord, endWord) - (v + 1 < V ? 1 : 0))
        for (let i = Math.max(lo, wordAtOrAfter(ctx, t - EDITOR_THRESHOLDS.noClearPauseMs) - 1); i <= hi; i++) {
          if (gaps[i].point > t + EDITOR_THRESHOLDS.noClearPauseMs) break
          if (!gaps[i].sentence || gaps[i].point < t - EDITOR_THRESHOLDS.noClearPauseMs) continue
          if (sentenceNear === null || Math.abs(gaps[i].point - t) < Math.abs(gaps[sentenceNear].point - t)) sentenceNear = i
        }
      }
    }
    const steps: Array<{ tMs: number; word: number }> = []
    const vs = visitStart(v), ve = visitEnd(v)
    while (r < reveals.length && reveals[r].tMs < vs) r++
    for (let q = r; q < reveals.length && reveals[q].tMs < ve; q++) {
      if (reveals[q].slideId && reveals[q].slideId !== visits[v].slideId) continue
      steps.push({ tMs: reveals[q].tMs, word: wordAtOrAfter(ctx, reveals[q].tMs) })
    }
    rows.push({ index: v, slideId: visits[v].slideId, change: visits[v].change, enterMs: visits[v].enterMs, start, end, firstWord, endWord: Math.max(firstWord, endWord), defaultStart: defaults[v], moved: applied[v], startQuality: quality[v], click, noClearPause, startsAt, sentenceNear, steps })
  }
  return rows
}

/**
 * Where the stored sentence spoken across time `t` divides, by spoken time: its start (gap index) when more
 * of it is said after `t`, its end when more is said before (a tie to the earlier slide). Null when that
 * place is not a sentence start within `noClearPauseMs` of `t`. The sentence is bounded by clean pauses too.
 */
function sentenceSplit(ctx: EditorWords, t: number): number | null {
  const { words, gaps } = ctx
  const n = words.length
  let w = Math.min(n - 1, wordAtOrAfter(ctx, t))
  // The word being said at t may be the one before the first whose middle is after it.
  if (w > 0 && words[w - 1].end > t) w--
  let a = w, b = w
  while (a > 0 && !gaps[a].sentence && !gaps[a].cleanPause) a--
  while (b + 1 < n && !gaps[b + 1].sentence && !gaps[b + 1].cleanPause) b++
  let before = 0, after = 0
  for (let i = a; i <= b; i++) {
    before += Math.max(0, Math.min(words[i].end, t) - words[i].start)
    after += Math.max(0, words[i].end - Math.max(words[i].start, t))
  }
  const at = after > before ? a : b + 1
  if (at <= 0 || at >= n || !gaps[at].sentence || gaps[at].cleanPause) return null
  return Math.abs(gaps[at].point - t) <= EDITOR_THRESHOLDS.noClearPauseMs ? at : null
}

/** What a place for a slide's start is: after a clear pause, at a stored sentence start, or on another word. */
export type TargetKind = 'pause' | 'sentence' | 'word'
/** How the editor names each kind of place (the drag label and the row). */
export const TARGET_WORDS: Record<TargetKind, string> = { pause: 'after a pause', sentence: 'at a sentence start', word: 'on a word' }
/** A clear pause wins over a sentence start at the same gap: it is the cleaner fact. */
export function targetKind(g: Gap): TargetKind {
  return g.cleanPause ? 'pause' : g.sentence ? 'sentence' : 'word'
}
export type BoundaryTarget = { word: number; at: number; quality: Quality; pauseMs: number; kind: TargetKind }

/**
 * Places a slide's start may be moved to: clear pauses and stored sentence starts (the handle snaps to
 * these) or, with `any`, every word. Each carries the gap's own quality: a sentence start in continuous
 * speech is close.
 */
export function boundaryTargets(ctx: EditorWords, rows: readonly EditorRow[], index: number, any: boolean): BoundaryTarget[] {
  if (index <= 0 || index >= rows.length) return []
  const lo = rows[index - 1].firstWord + 1, hi = rows[index].endWord - (index + 1 < rows.length ? 1 : 0)
  const out: BoundaryTarget[] = []
  for (let w = Math.max(1, lo); w <= Math.min(ctx.words.length - 1, hi); w++) {
    const g = ctx.gaps[w]
    if (any || g.cleanPause || g.sentence) out.push({ word: w, at: Math.round(g.point), quality: g.quality, pauseMs: g.pauseMs, kind: targetKind(g) })
  }
  return out
}

/**
 * Rows left out or played from a new take whose stretch starts or ends at a sentence start rather than a
 * clear pause: the join falls inside speech, so "To check" lists them to listen to.
 */
export function joinsAtSentence(rows: readonly EditorRow[], leftOut: ReadonlySet<number>, replaced: ReadonlyMap<number, unknown>): number[] {
  const out: number[] = []
  for (const r of rows) {
    if (!leftOut.has(r.index) && !replaced.has(r.index)) continue
    if (r.startsAt === 'sentence' || rows[r.index + 1]?.startsAt === 'sentence') out.push(r.index)
  }
  return out
}

/** Move the start of row `index` to the gap before word `word` (`any`: a word rather than a clear pause or sentence start). */
export function moveBoundaryOp(ctx: EditorWords, row: EditorRow, word: number, any: boolean): EditOp {
  const at = Math.round(ctx.gaps[Math.max(0, Math.min(ctx.words.length, word))].point)
  const g = ctx.gaps[word]
  return at === Math.round(row.defaultStart) ? { kind: 'boundary', change: row.change, at: null } : { kind: 'boundary', change: row.change, at, any: any && !g?.cleanPause && !g?.sentence }
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
  /**
   * The video clock (Record this slide again): the Run clock with each chosen take inserted where its slide
   * starts. `spans`, `editedMs`, `chapterMarks` and `captionWords` are on it; `cuts`, `rows` and `views` stay
   * in Run time. With no take chosen the two clocks are the same.
   */
  clock: TakeClock
  /**
   * Where the captions come from: `words` (the transcript has timed words; `captionWords`, possibly none
   * kept), `segments` (no word timing: `captionSegments`, the transcript's segments on the video clock,
   * none from a replaced stretch), `none`. Words never fall back to segments.
   */
  captionSource: 'words' | 'segments' | 'none'
  captionSegments: Array<{ start: number; end: number; text: string }>
  /** Chosen takes whose words are not written out yet: their stretch has no captions. */
  takesWithoutWords: number
  /** The video clock's length, and every cut on it (what the player and the export skip). */
  clockMs: number
  clockCuts: TimeRange[]
  /** Rows played from a new take instead (row index → the take's Run id). Their own stretch is cut. */
  replacedRows: Map<number, string>
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
  /**
   * Takes chosen in the edits that can be played, with their lengths (a missing take is left out) and
   * their own timed words on their own clock (null: not written out yet).
   */
  takes?: ReadonlyArray<{ change: number; run: string; durationMs: number; words?: ReadonlyArray<{ text: string; start: number; end: number }> | null }>
  /** The transcript's segments, when the caller passes `ctx` rather than the transcript. */
  segments?: ReadonlyArray<{ start: number; end: number; text: string }> | null
}): ResolvedRecording {
  const { durationMs, edits } = input
  const ctx = input.ctx ?? editorWords(input.transcript, durationMs)
  const rows = slideRows(ctx, input.marks, edits.boundaries ?? [])
  const leftOutRows = new Set<number>()
  const leftOutSpans: TimeRange[] = []
  for (const r of rows) if ((edits.leftOut ?? []).includes(r.change)) { leftOutRows.add(r.index); leftOutSpans.push({ start: Math.round(r.start), end: Math.round(r.end) }) }
  // A slide recorded again plays its chosen take where it starts; its own stretch is cut. Each slide
  // change has one row at most that a take replaces (the first visit), and never one left out.
  const replacedRows = new Map<number, string>()
  const inserts: TakeInsert[] = []
  // Where each take goes in, in whole milliseconds: the one value the cut, the clock and the chapter use.
  const insertAt = new Map<number, number>()
  for (const t of input.takes ?? []) {
    const r = rows.find((row) => row.change === Math.round(t.change) && !leftOutRows.has(row.index) && !replacedRows.has(row.index))
    if (!r || !(t.durationMs > 0)) continue
    const at = Math.round(r.start)
    replacedRows.set(r.index, t.run)
    insertAt.set(r.index, at)
    inserts.push({ at, length: Math.round(t.durationMs), run: t.run, change: r.change, end: Math.round(r.end) })
  }
  const replacedSpans = inserts.map((i) => ({ start: i.at, end: i.end }))
  const clock = inserts.length ? takeClock(inserts) : NO_TAKES
  const trims = effectiveCuts([], input.runTrims as TimeRange[] | undefined, durationMs, edits.restoredTrims ?? [])
  const cuts = normaliseRanges([...edits.cuts, ...trims, ...leftOutSpans, ...replacedSpans], durationMs)
  const runSpans = keptSpans(cuts, durationMs)
  const clockMs = videoClockMs(clock, durationMs)
  const clockCuts = inserts.length ? normaliseRanges(rangesToVideoClock(clock, cuts), clockMs) : cuts
  const spans = inserts.length ? keptSpans(clockCuts, clockMs) : runSpans
  const views = planViews(ctx, runSpans, durationMs, { sidecar: edits.cuts, leftOut: [...leftOutSpans, ...replacedSpans], trims })
  const wordCut = new Uint8Array(ctx.words.length)
  for (const v of views) for (let w = v.firstWord; w < v.endWord; w++) wordCut[w] = 1
  // A chapter starts at the slide's real change unless the owner moved that slide's start; the inferred
  // start of a slide's words is for showing them on rows, not for chapters (an untouched Run keeps PR 347's).
  const chapterMarks = rows.filter((r) => !leftOutRows.has(r.index) && r.slideId).map((r) => ({ tMs: toVideoClock(clock, r.index === 0 ? 0 : insertAt.get(r.index) ?? (r.moved ? r.start : r.enterMs)), slideId: r.slideId }))
  // A kept word that runs over the point where a take goes in is held to its side of it (by its middle),
  // so it never stays on screen across the take.
  const wordOnClock = (start: number, end: number): { start: number; end: number } => {
    if (!inserts.length) return { start, end }
    for (const ins of clock.inserts) if (start < ins.at && end > ins.at) { if ((start + end) / 2 < ins.at) end = ins.at; else start = ins.at }
    const endShift = clock.inserts.reduce((n, i) => n + (i.at < end && i.at > start ? 0 : i.at < end ? i.length : 0), 0)
    return { start: toVideoClock(clock, start), end: Math.max(toVideoClock(clock, start), end + endShift) }
  }
  const captionWords: Array<{ text: string; start: number; end: number; order: number }> = []
  const words = ctx.words
  for (let i = 0; i < words.length; i++) {
    if (wordCut[i]) continue
    if (words[i].timed) { captionWords.push({ text: words[i].text, ...wordOnClock(words[i].start, words[i].end), order: i }); continue }
    // An untimed word joins the cue of the kept timed word next to it: that word's times, its own place.
    let j = i - 1
    while (j >= 0 && (wordCut[j] || !words[j].timed)) j--
    if (j < 0) { j = i + 1; while (j < words.length && (wordCut[j] || !words[j].timed)) j++ }
    if (j < words.length) captionWords.push({ text: words[i].text, ...wordOnClock(words[j].start, words[j].end), order: i })
  }
  // A chosen take's own words, on the video clock where the take plays; never another take's.
  let takesWithoutWords = 0
  const takeWords: Array<{ text: string; start: number; end: number; order: number }> = []
  inserts.forEach((ins, k) => {
    const own = input.takes?.find((t) => t.run === ins.run && Math.round(t.change) === ins.change)?.words
    if (!own) { takesWithoutWords++; return }
    const at = toVideoClock(clock, ins.at)
    own.forEach((w, j) => {
      if (!w || typeof w.text !== 'string' || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start || (w.start + w.end) / 2 >= ins.length) return
      takeWords.push({ text: w.text, start: at + Math.max(0, w.start), end: at + Math.min(ins.length, w.end), order: words.length + (k + 1) * 1_000_000 + j })
    })
  })
  // Captions: words where the transcript has timed words (all of them cut is no captions, never segments);
  // otherwise the transcript's segments, none from a replaced stretch, on the video clock.
  const rawSegments = (input.segments ?? (input.transcript as { segments?: Array<{ start: number; end: number; text: string }> } | null | undefined)?.segments ?? [])
    .filter((g) => g && typeof g.text === 'string' && Number.isFinite(g.start) && Number.isFinite(g.end) && g.end >= g.start)
  const captionSource: ResolvedRecording['captionSource'] = words.length ? 'words' : rawSegments.length || takeWords.length ? 'segments' : 'none'
  let captionSegments: ResolvedRecording['captionSegments'] = []
  if (captionSource === 'segments') {
    captionSegments = rawSegments.filter((g) => !replacedSpans.some((r) => g.end > r.start && g.start < r.end)).map((g) => ({ text: g.text, start: toVideoClock(clock, g.start), end: toVideoClock(clock, g.end) }))
    captionSegments.push(...wordsAsSegments(takeWords))
    captionSegments.sort((a, b) => a.start - b.start)
  } else captionWords.push(...takeWords)
  captionWords.sort((a, b) => a.start - b.start || a.order - b.order)
  return { ctx, rows, leftOutRows, cuts, spans, editedMs: editedDurationMs(spans), views, chapterMarks, wordCut, captionWords, captionSource, captionSegments, takesWithoutWords, clock, clockMs, clockCuts, replacedRows }
}

/** Timed words as caption lines (a take's words where the Run has segments only): broken at a pause or at the cue length. */
function wordsAsSegments(list: ReadonlyArray<{ text: string; start: number; end: number }>): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = []
  for (const w of list) {
    const cur = out.at(-1)
    if (cur && w.start - cur.end <= 600 && w.end - cur.start <= 6000 && cur.text.length + 1 + w.text.length <= 84) { cur.text += ' ' + w.text; cur.end = Math.max(cur.end, w.end) }
    else out.push({ start: w.start, end: w.end, text: w.text })
  }
  return out
}

/** The caption cues an export of this state writes (words, or segments where there is no word timing). */
export function captionCuesOf(r: Pick<ResolvedRecording, 'captionWords' | 'captionSegments' | 'captionSource' | 'spans'>): ReturnType<typeof captionCues> {
  return r.captionSource === 'none' ? { cues: [], leftOut: 0 } : captionCues(r.captionSource === 'words' ? r.captionWords : [], r.spans, r.captionSource === 'segments' ? r.captionSegments : [])
}

/**
 * A short fingerprint of what an export of this state would write: the kept frames, the chapter marks, and
 * the caption cues themselves (from the words, or from the transcript's segments when there are no word
 * timings). The window sends it with Export; main works out the same from the saved files and refuses when
 * they differ, so the file is what the screen showed or nothing.
 */
export function planDigest(r: Pick<ResolvedRecording, 'spans' | 'chapterMarks' | 'captionWords' | 'captionSegments' | 'captionSource'>, _segments?: unknown): string {
  let h = 0x811c9dc5
  const add = (text: string): void => { for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } }
  for (const s of r.spans) add(`s${s.startFrame}-${s.endFrame};`)
  for (const c of r.chapterMarks) add(`c${Math.round(c.tMs)}:${c.slideId};`)
  // The cues that will be written, from the same resolved state (the segments argument is kept for old callers).
  const cues = captionCuesOf(r).cues
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
