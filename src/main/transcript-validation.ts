import { ALIGNMENT_CONFIDENCE } from '../shared/word-alignment.ts'
/** Alignment may refine, but not relocate, a returned word by more than three seconds. */
export const ALIGNMENT_MAX_DRIFT_MS = 3000
import type { TranscriptJson } from './transcription.ts'
export const validRange = (r: any): boolean => !!r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.start >= 0 && r.end >= r.start
export const validSilence = (v: any): boolean => Array.isArray(v) && v.every((r, i) => validRange(r) && (!i || r.start >= v[i-1].end))
export const validEnds = (v: any, count: number): boolean => Array.isArray(v) && v.every((n, i) => Number.isInteger(n) && n >= 0 && n < count && (!i || n > v[i-1]))
export const validLocale = (v: any): boolean => { try { return typeof v === 'string' && Intl.getCanonicalLocales(v.replaceAll('_','-')).length === 1 } catch { return false } }
/** Never publish content that the disk reader would hide. Retry changed timings before refusing. */
export function transcriptForPublish(transcript: TranscriptJson): TranscriptJson | null {
  const check = (candidate: TranscriptJson) => {
    const read = normaliseTranscript(candidate)
    return read && (read.words?.length ?? 0) === (transcript.words?.length ?? 0) &&
      (read.sentences?.length ?? 0) === (transcript.sentences?.length ?? 0) ? read : null
  }
  const checked = check(transcript)
  if (checked) return checked
  const words = transcript.words?.map(w => {
    const start = w.returnedStart, end = w.returnedEnd
    return typeof start === 'number' && typeof end === 'number' && validRange({start,end}) && (start !== w.start || end !== w.end)
      ? {...w,start,end,timing:'untrimmed' as const} : w
  })
  const sentences = transcript.sentences?.map(s => {
    const first = words?.[s.firstWord], last = words?.[s.lastWord]
    return first && last ? {...s,start:first.start,end:last.end} : s
  })
  return check({...transcript,words,sentences})
}
/** Normalise untrusted disk metadata without touching its source file. */
export function normaliseTranscript(raw: any): TranscriptJson | null {
  if (!raw || !Array.isArray(raw.segments) || !raw.segments.every((s: any) => validRange(s) && typeof s.text === 'string')) return null
  const t = {...raw}
  if (!['parakeet','apple-speech-transcriber','apple-dictation'].includes(t.engine)) delete t.engine
  if (!Array.isArray(t.words) || !t.words.every((w: any, i: number) => validRange(w) && typeof w.text === 'string' && (!i || w.start >= t.words[i-1].start))) delete t.words
  if (t.words) t.words = t.words.map((w: any) => {
    const word={...w}
    for (const [start,end] of [['returnedStart','returnedEnd'],['trimmedStart','trimmedEnd']]) {
      if (!validRange({start:word[start],end:word[end]})) { delete word[start]; delete word[end] }
    }
    if (!['trimmed','untrimmed'].includes(word.timing)) delete word.timing
    return word
  })
  if (!validSilence(t.silence)) delete t.silence
  if (!Array.isArray(t.sentences) || !t.sentences.every((s: any, i: number) => validRange(s) && typeof s.id === 'string' && ['transcriber','punctuation','acoustic-pause','manual'].includes(s.boundarySource) && Number.isInteger(s.firstWord) && Number.isInteger(s.lastWord) && s.firstWord >= 0 && s.lastWord >= s.firstWord && s.lastWord < (t.words?.length ?? 0) && (!i || (s.firstWord > t.sentences[i-1].lastWord && s.start >= t.sentences[i-1].start)))) delete t.sentences
  if (t.sentences) t.sentences = t.sentences.map((s: any) => { const sentence={...s}; if (typeof sentence.cleanPause !== 'boolean') delete sentence.cleanPause; return sentence })
  for (const key of ['captionCorrections','unmatchedCorrections']) if (!Array.isArray(t[key]) || !t[key].every((c: any) => validRange(c) && typeof c.text === 'string' && typeof c.original === 'string')) delete t[key]
  for (const key of ['engineVersion','configVersion','sourceFingerprint','acousticMeasurement']) if (typeof t[key] !== 'string') delete t[key]
  if (!validLocale(t.locale)) delete t.locale
  if (t.schemaVersion !== 2) delete t.schemaVersion
  validateAlignment(t)
  return t as TranscriptJson
}

/** An invalid optional alignment never hides a legacy transcript or changes the file. */
function validateAlignment(t: any): void {
  const a = t.alignment
  let lastAlignedEnd = 0
  const valid = a && a.version === 1 && typeof a.model === 'string' && a.model.length > 0 && /^[a-f0-9]{40}$/.test(a.revision) &&
    /^[a-f0-9]{64}$/.test(a.sha256) && typeof a.alignedAt === 'string' && Number.isFinite(Date.parse(a.alignedAt)) && a.normalisation === 'ctc-nfc-v1' &&
    Array.isArray(t.words) && Array.isArray(a.midpoints) && a.midpoints.length === Math.max(0, t.words.length - 1) &&
    t.words.every((w: any, i: number) => {
      const p = w.alignment
      if (!p || !['aligned','unplaced'].includes(p.status) || !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1 ||
          typeof p.normalised !== 'string' || !Array.isArray(p.unsupported) || !p.unsupported.every((s: any) => typeof s === 'string')) return false
      if (p.status === 'unplaced') return ['alphabet','confidence','path'].includes(p.reason) && p.start === undefined && p.end === undefined
      if (p.confidence < ALIGNMENT_CONFIDENCE || !validRange(p) || p.end <= p.start || p.unsupported.length || p.end > (t.segments.at(-1)?.end ?? 0) ||
          Math.abs(p.start - (w.returnedStart ?? w.start)) > ALIGNMENT_MAX_DRIFT_MS || Math.abs(p.end - (w.returnedEnd ?? w.end)) > ALIGNMENT_MAX_DRIFT_MS) return false
      // Non-overlap also across an unplaced word: the order must never invert.
      if (p.start < lastAlignedEnd) return false
      lastAlignedEnd = p.end
      return true
    }) && a.midpoints.every((m: any, i: number) => {
      const l = t.words[i].alignment, r = t.words[i + 1].alignment
      const expected = l.status === 'aligned' && r.status === 'aligned' ? (l.end + r.start) / 2 : null
      return m === expected
    })
  if (!valid) {
    delete t.alignment
    if (t.words) t.words = t.words.map((w: any) => { const copy = {...w}; delete copy.alignment; return copy })
  }
}
