import { ALIGNMENT_CONFIDENCE } from './word-alignment.ts'
/** Additive recording-clock contract. Legacy transcripts remain readable without rewriting. */
export type TranscriptEngine = 'apple-speech-transcriber' | 'apple-dictation' | 'parakeet'
export type TimeRange = { start: number; end: number }
export type WordAlignment = { status: 'aligned' | 'unplaced'; confidence: number; normalised: string; unsupported: string[]; start?: number; end?: number; reason?: 'alphabet' | 'confidence' | 'path' }
export type AlignmentProvenance = { version: 1; model: string; revision: string; sha256: string; alignedAt: string; normalisation: 'ctc-nfc-v1'; midpoints: (number | null)[] }
export type TranscriptWord = TimeRange & { text: string; returnedStart?: number; returnedEnd?: number; trimmedStart?: number; trimmedEnd?: number; timing?: 'trimmed' | 'untrimmed'; alignment?: WordAlignment }
export type TranscriptSentence = TimeRange & {
  id: string; firstWord: number; lastWord: number
  cleanPause?: boolean
  boundarySource: 'transcriber' | 'punctuation' | 'acoustic-pause' | 'manual'
}
export type CaptionCorrection = { text: string; original: string; start: number; end: number }
export type TranscriptMetadata = {
  alignment?: AlignmentProvenance; schemaVersion?: 2; locale?: string; engineVersion?: string; configVersion?: string
  acousticMeasurement?: string; sourceFingerprint?: string; silence?: TimeRange[]; sentences?: TranscriptSentence[]
  captionCorrections?: CaptionCorrection[]; unmatchedCorrections?: CaptionCorrection[]
}
export function trimWords(words: TranscriptWord[], silence: TimeRange[]): TranscriptWord[] {
  let silenceIndex = 0
  return words.map((w, index) => {
    while (silenceIndex < silence.length && silence[silenceIndex].end <= w.start) silenceIndex++
    const limit = Math.min(w.end, words[index+1]?.start ?? w.end)
    let start = w.start, end = limit
    for (let i = silenceIndex; i < silence.length && silence[i].start < limit; i++) {
      const s = silence[i]
      if (s.start <= start && start < s.end) start = Math.min(end, s.end)
      if (s.start < end && end <= s.end) end = Math.max(start, s.start)
    }
    const untrimmed = end - start < 40
    return { ...w, returnedStart: w.start, returnedEnd: w.end, start: untrimmed ? w.start : start, end: untrimmed ? limit : end, timing: untrimmed ? 'untrimmed' as const : 'trimmed' as const }
  })
}
/** Bounds are the kept neighbouring word edges; previousCut preserves cut order. */
export type CutBounds = { lower?: number; upper?: number; previousCut?: number; words?: TranscriptWord[]; alignment?: AlignmentProvenance; segments?: TimeRange[] }
function checkCutBounds(boundary: number, bounds: CutBounds): void {
  if (!Number.isFinite(boundary) ||
      (bounds.lower !== undefined && !Number.isFinite(bounds.lower)) ||
      (bounds.previousCut !== undefined && !Number.isFinite(bounds.previousCut)) ||
      (bounds.upper !== undefined && bounds.upper !== Infinity && !Number.isFinite(bounds.upper))) throw new RangeError('Cut times must be finite')
}
export function snapToSilence(boundary: number, silence: TimeRange[], wordBoundary = boundary, radiusMs = 0, bounds: CutBounds = {}): number {
  checkCutBounds(boundary, bounds)
  if (!Number.isFinite(wordBoundary)) throw new RangeError('Word boundary must be finite')
  const lower = Math.max(0, bounds.lower ?? 0, bounds.previousCut ?? 0)
  const upper = bounds.upper ?? Infinity
  if (upper < lower) throw new RangeError('Cut bounds cross the previous cut')
  let best: TimeRange | undefined, distance = Infinity, midpointDistance = Infinity
  for (const s of silence) {
    if (s.end <= s.start) continue
    const d = Math.max(s.start-boundary,boundary-s.end,0), m = Math.abs((s.start+s.end)/2-boundary)
    if (d <= radiusMs && (d < distance || d === distance && m < midpointDistance)) { best=s; distance=d; midpointDistance=m }
  }
  return Math.min(upper, Math.max(lower, best ? (best.start+best.end)/2 : wordBoundary))
}
export const CLEAN_CUT = { silenceMs: 500, keptMs: 200 } as const
export type CutQuality = { time: number; quality: 'clean' | 'tight'; silenceMs: number }
/** A start keeps audio to its left; an end keeps audio to its right. Times are milliseconds.
 * Callers supplying alignment must pass the VALIDATED transcript words, alignment and segments. */
export function cutEdge(boundary: number, side: 'start' | 'end', silence: TimeRange[], bounds: CutBounds = {}, thresholds: {silenceMs:number; keptMs:number} = CLEAN_CUT): CutQuality {
  if (bounds.words && bounds.alignment) return alignedCutEdge(boundary,side,silence,bounds.words,bounds.alignment,{lower:bounds.lower,upper:bounds.upper,previousCut:bounds.previousCut,segments:bounds.segments},thresholds)
  const time = snapToSilence(boundary, silence, boundary, 0, bounds)
  const pause = silence.find(s => s.start <= time && time <= s.end && s.end > s.start)
  const length = pause ? pause.end-pause.start : 0
  const kept = pause ? side === 'start' ? time-pause.start : pause.end-time : 0
  return { time, quality: length >= thresholds.silenceMs && kept >= thresholds.keptMs ? 'clean' : 'tight', silenceMs:length }
}
export function cutRangeQuality(range: TimeRange, silence: TimeRange[], bounds: {start?:CutBounds; end?:CutBounds} = {}) {
  checkCutBounds(range.start, bounds.start ?? {})
  checkCutBounds(range.end, bounds.end ?? {})
  const start = cutEdge(range.start,'start',silence,{...bounds.start,upper:Math.min(range.end,bounds.start?.upper ?? Infinity)})
  return {start,end:cutEdge(range.end,'end',silence,{...bounds.end,previousCut:Math.max(start.time,bounds.end?.previousCut ?? 0)})}
}
/** Nearest clean point in each direction, including the current edge if already clean. */
export function proposeCleanEdges(boundary: number, side: 'start' | 'end', silence: TimeRange[], windowMs: number, bounds: CutBounds = {}, thresholds: {silenceMs:number; keptMs:number} = CLEAN_CUT): {outward: number|null; inward: number|null} {
  checkCutBounds(boundary, bounds)
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new RangeError('Invalid clean-edge window')
  let before: number|null=null, after: number|null=null
  for (const s of silence) {
    if (s.end-s.start < thresholds.silenceMs) continue
    const lo=Math.max(s.start+(side==='start'?thresholds.keptMs:0),bounds.lower ?? 0,bounds.previousCut ?? 0,boundary-windowMs)
    const hi=Math.min(s.end-(side==='end'?thresholds.keptMs:0),bounds.upper ?? Infinity,boundary+windowMs)
    if (lo>hi) continue
    if (lo<=boundary) {const t=Math.min(boundary,hi);if(before===null||t>before)before=t}
    if (hi>=boundary) {const t=Math.max(boundary,lo);if(after===null||t<after)after=t}
  }
  return side==='start'?{outward:before,inward:after}:{outward:after,inward:before}
}
export function mapSentences(words: TranscriptWord[], ends: number[], silence: TimeRange[], transcriberEnds: number[] = []): TranscriptSentence[] {
  const punctuation = new Set(ends)
  const ranges = new Set(transcriberEnds)
  const sentencePauses = silence.filter(s=>s.end-s.start >= 600)
  const result: TranscriptSentence[] = []; let first = 0, pauseIndex = 0, cleanIndex = 0
  words.forEach((w,i) => {
    while (pauseIndex < sentencePauses.length && sentencePauses[pauseIndex].start < w.end) pauseIndex++
    const pause = i < words.length-1 && pauseIndex < sentencePauses.length && sentencePauses[pauseIndex].end <= words[i+1].start
    while (cleanIndex < silence.length && silence[cleanIndex].end < w.end) cleanIndex++
    if (ranges.has(i) || punctuation.has(i) || pause || i === words.length-1) {
      result.push({ id: `sentence-${first}-${i}`, firstWord: first, lastWord: i, start: words[first].start, end: w.end,
        cleanPause: cutEdge(w.end, 'end', silence[cleanIndex] ? [silence[cleanIndex]] : [], {lower:w.end,upper:Math.max(w.end,words[i+1]?.start ?? Infinity)}).quality === 'clean',
        boundarySource: ranges.has(i) ? 'transcriber' : punctuation.has(i) ? 'punctuation' : pause ? 'acoustic-pause' : 'transcriber' })
      first = i+1
    }
  })
  return result
}
/** Spoken overlap, excluding measured silence. Equal overlap goes to the earlier slide. */
export function sentenceSlide(sentence: TranscriptSentence, slides: TimeRange[], silence: TimeRange[] = []): number {
  let best = -1, overlap = -1
  slides.forEach((slide,i) => {
    const start = Math.max(sentence.start,slide.start), end = Math.min(sentence.end,slide.end)
    let duration = Math.max(0,end-start)
    for (const s of silence) duration -= Math.max(0,Math.min(end,s.end)-Math.max(start,s.start))
    if (duration > overlap) { overlap = duration; best = i }
  })
  return best
}
/** Exact text plus time overlap; ambiguous matches are left for the owner. */
export function rematchCorrections(corrections: CaptionCorrection[], words: TranscriptWord[]) {
  const matched: CaptionCorrection[] = [], unmatched: CaptionCorrection[] = []
  for (const correction of corrections) {
    const candidates = words.filter(w => w.text === correction.original && w.start < correction.end && w.end > correction.start)
    if (candidates.length === 1) matched.push({...correction,start:candidates[0].start,end:candidates[0].end})
    else unmatched.push(correction)
  }
  return { matched, unmatched }
}
export function defaultWordsEngine(nativeAvailable: boolean, parakeetReady: boolean, choice?: 'native'|'parakeet') {
  if (choice) return choice
  return nativeAvailable ? 'native' : parakeetReady ? 'parakeet' : null
}

/** Words visited once; unordered SRT segments are sorted for grouping only. */
export function segmentWordEnds(words: TranscriptWord[], segments: TimeRange[]): number[] {
  const ends: number[] = []; let index = 0
  const ordered = segments.some((s,i)=>i > 0 && s.start < segments[i-1].start) ? [...segments].sort((a,b)=>a.start-b.start || a.end-b.end) : segments
  for (const segment of ordered) {
    let last = -1
    while (index < words.length && words[index].start < segment.end) {
      if (words[index].start >= segment.start && words[index].end <= segment.end) last = index
      index++
    }
    if (last >= 0) ends.push(last)
  }
  return ends
}

/** Callers must pass the VALIDATED transcript, including its segments in bounds.
 * Alignment is additive; cross-segment midpoints are unmeasured and use the silence rule.
 * Word starts use the same half-open segment membership as segmentWordEnds, even for zero-duration words. */
export function alignedCutEdge(boundary: number, side: 'start' | 'end', silence: TimeRange[], words: TranscriptWord[], alignment: AlignmentProvenance | undefined, bounds: CutBounds = {}, thresholds: {silenceMs:number;keptMs:number} = CLEAN_CUT): CutQuality {
  checkCutBounds(boundary, bounds)
  if (alignment?.version === 1) {
    const i = alignment.midpoints.findIndex(t => t === boundary)
    const left = words[i]?.alignment, right = words[i + 1]?.alignment
    if (i >= 0 && bounds.segments?.some(s => words[i].start >= s.start && words[i].start < s.end && words[i].end <= s.end && words[i+1].start >= s.start && words[i+1].start < s.end && words[i+1].end <= s.end) && left?.status === 'aligned' && right?.status === 'aligned' && left.confidence >= ALIGNMENT_CONFIDENCE && right.confidence >= ALIGNMENT_CONFIDENCE &&
        typeof left.end === 'number' && typeof right.start === 'number' && left.end <= right.start && boundary === (left.end + right.start) / 2 &&
        boundary >= Math.max(0, bounds.lower ?? 0, bounds.previousCut ?? 0) && boundary <= (bounds.upper ?? Infinity)) return { time: boundary, quality: 'clean', silenceMs: 0 }
  }
  return cutEdge(boundary, side, silence, bounds, thresholds)
}
