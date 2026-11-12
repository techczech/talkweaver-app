import * as ort from 'onnxruntime-node'
import { alignCtc, normaliseAlignmentWord, ALIGNMENT_CONFIDENCE, type Alphabet } from '../shared/word-alignment.ts'
import type { WordAlignment } from '../shared/transcript-contract'
/** Loaded in an isolated utility process. PCM is mono 16 kHz, max 30 seconds, one chunk at a time. */
export async function inferAlignment(session: ort.InferenceSession, pcm: Float32Array, words: string[], alphabet: Alphabet): Promise<WordAlignment[]> {
  if (!pcm.length || pcm.length > 480_000 || words.length > 1000 || pcm.some(x => !Number.isFinite(x))) throw Error('Invalid bounded alignment input')
  let mean = 0; for (const x of pcm) mean += x; mean /= pcm.length
  let variance = 0; for (const x of pcm) variance += (x - mean) ** 2; variance /= pcm.length
  const audio = Float32Array.from(pcm, x => (x - mean) / Math.sqrt(variance + 1e-7))
  const mapped = words.map(w => normaliseAlignmentWord(w, alphabet))
  // Keep an unsupported word's place in the CTC target using the model's unknown label.
  // Its time is never accepted; confident neighbours can still be placed. No spoken digit
  // expansion is guessed. If there is no unknown label, conservatively retain the whole chunk.
  const unknown=alphabet.vocab['<unk>'] ?? alphabet.vocab['[UNK]']
  if (mapped.some(w=>w.unsupported.length || !w.tokens.length) && unknown===undefined) return mapped.map(w => ({ status:'unplaced', confidence:0, normalised:w.normalised, unsupported:w.unsupported, reason:'alphabet' }))
  const tokens: number[] = [], ranges: [number, number][] = []
  for (const w of mapped) {
    if (tokens.length) tokens.push(alphabet.vocab[alphabet.delimiter])
    const labels=w.unsupported.length || !w.tokens.length ? [unknown] : w.tokens
    ranges.push([tokens.length, tokens.length + labels.length]); tokens.push(...labels)
  }
  const feeds: Record<string, ort.Tensor> = { input_values: new ort.Tensor('float32', audio, [1, audio.length]) }
  if (session.inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', new BigInt64Array(audio.length).fill(1n), [1, audio.length])
  const output = await session.run(feeds)
  const logits = output.logits
  if (!logits || logits.type !== 'float32' || logits.dims.length !== 3 || logits.dims[0] !== 1) throw Error('Unexpected acoustic output')
  const spans = alignCtc(logits.data as Float32Array, logits.dims[1], logits.dims[2], tokens, alphabet.blank)
  // wav2vec2 has 320-sample stride (20 ms); ratio to input length introduces trailing padding drift.
  return mapped.map((w, i) => {
    if(w.unsupported.length || !w.tokens.length)return {status:'unplaced',confidence:0,normalised:w.normalised,unsupported:w.unsupported,reason:'alphabet'}
    const [a,b] = ranges[i], confidence = Math.min(...spans.slice(a,b).map(s => s.confidence))
    return confidence < ALIGNMENT_CONFIDENCE
      ? { status:'unplaced', confidence, normalised:w.normalised, unsupported:[], reason:'confidence' }
      : { status:'aligned', confidence, normalised:w.normalised, unsupported:[], start:spans[a].firstFrame*20, end:spans[b-1].endFrame*20 }
  })
}
