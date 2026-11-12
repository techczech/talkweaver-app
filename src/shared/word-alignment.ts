/** Known-text CTC alignment. Audio and times use the recording clock, in milliseconds. */
export type NormalisedWord = { original: string; normalised: string; tokens: number[]; unsupported: string[] }
export type Alphabet = { vocab: Record<string, number>; blank: number; delimiter: string; uppercase: boolean }
/** Digits are deliberately not guessed as spoken numbers. Unsupported words retain old timing. */
export function normaliseAlignmentWord(original: string, alphabet: Alphabet): NormalisedWord {
  const text = original.normalize('NFC').replaceAll('’', "'")
  const cased = alphabet.uppercase ? text.toUpperCase() : text.toLowerCase()
  let normalised = ''
  const tokens: number[] = [], unsupported: string[] = []
  for (const c of cased) {
    if (/\p{P}|\p{Z}/u.test(c) && c !== "'") continue
    normalised += c
    if (/\p{N}/u.test(c) || !Object.hasOwn(alphabet.vocab, c)) unsupported.push(c)
    else tokens.push(alphabet.vocab[c])
  }
  return { original, normalised, tokens, unsupported }
}
export type TokenSpan = { firstFrame: number; endFrame: number; confidence: number }
/** Blank-interleaved Viterbi, including repeated labels. Confidence = geometric mean posterior
 * over frames assigned to the label; not a calibrated probability of correct word placement.
 * One byte per frame/state plus two score rows; callers must bound chunks before inference. */
export function alignCtc(logits: Float32Array, frames: number, vocabulary: number, tokens: number[], blank: number): TokenSpan[] {
  if (!Number.isInteger(frames) || frames < 1 || !Number.isInteger(vocabulary) || vocabulary < 2 || logits.length !== frames * vocabulary ||
      !Number.isInteger(blank) || blank < 0 || blank >= vocabulary || tokens.some(t => !Number.isInteger(t) || t < 0 || t >= vocabulary || t === blank)) throw Error('Invalid CTC input')
  if (!tokens.length) return []
  const states = tokens.length * 2 + 1
  if (frames * states > 16_000_000) throw Error('CTC chunk exceeds memory bound')
  const labels = Array.from({ length: states }, (_, i) => i % 2 ? tokens[(i - 1) / 2] : blank)
  const back = new Uint8Array(frames * states)
  let previous = new Float64Array(states).fill(-Infinity), next = new Float64Array(states)
  const normalisers = new Float64Array(frames)
  for (let t = 0; t < frames; t++) {
    let max = -Infinity
    for (let v = 0; v < vocabulary; v++) { const x = logits[t * vocabulary + v]; if (!Number.isFinite(x)) throw Error('Non-finite CTC logits'); max = Math.max(max, x) }
    let sum = 0
    for (let v = 0; v < vocabulary; v++) sum += Math.exp(logits[t * vocabulary + v] - max)
    normalisers[t] = max + Math.log(sum)
    next.fill(-Infinity)
    for (let s = 0; s < states; s++) {
      let score = t ? previous[s] : s === 0 || s === 1 ? 0 : -Infinity, step = 0
      if (t && s && previous[s - 1] > score) { score = previous[s - 1]; step = 1 }
      if (t && s > 1 && labels[s] !== blank && labels[s] !== labels[s - 2] && previous[s - 2] > score) { score = previous[s - 2]; step = 2 }
      next[s] = score + logits[t * vocabulary + labels[s]] - normalisers[t]
      back[t * states + s] = step
    }
    ;[previous, next] = [next, previous]
  }
  let state = previous[states - 1] >= previous[states - 2] ? states - 1 : states - 2
  if (!Number.isFinite(previous[state])) throw Error('Transcript cannot be aligned')
  const spans = tokens.map(() => ({ firstFrame: frames, endFrame: 0, confidence: 0, count: 0 }))
  for (let t = frames - 1; t >= 0; t--) {
    if (state % 2) {
      const span = spans[(state - 1) / 2]
      span.firstFrame = t; span.endFrame = Math.max(span.endFrame, t + 1)
      span.confidence += logits[t * vocabulary + labels[state]] - normalisers[t]; span.count++
    }
    state -= back[t * states + state]
  }
  return spans.map(s => {
    if (!s.count) throw Error('Unvisited transcript token')
    return { firstFrame: s.firstFrame, endFrame: s.endFrame, confidence: Math.exp(s.confidence / s.count) }
  })
}
export const ALIGNMENT_CONFIDENCE = 0.5
export type WordPlacement = { start: number; end: number; confidence: number }
/** Shared midpoints exist only between confidently placed, consecutive words. */
export function sharedMidpoints(words: (WordPlacement | null)[]): (number | null)[] {
  return words.slice(0, -1).map((left, i) => {
    const right = words[i + 1]
    return left && right && left.confidence >= ALIGNMENT_CONFIDENCE && right.confidence >= ALIGNMENT_CONFIDENCE && left.end <= right.start
      ? (left.end + right.start) / 2 : null
  })
}
