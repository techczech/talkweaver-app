import type { TimeRange, TranscriptWord } from '../shared/transcript-contract.ts'
export type AlignmentChunk = TimeRange & { firstWord: number; lastWord: number }
/** Assign every word exactly once. Chunks never cross a Run segment gap. Prefer measured pause
 * midpoints. Without one, use a provisional join; the service overlaps and revalidates it. */
export function alignmentChunks(words: TranscriptWord[], silence: TimeRange[], segments: TimeRange[], maxMs = 30_000): AlignmentChunk[] {
  if (!Number.isFinite(maxMs) || maxMs < 1000) throw Error('Invalid chunk bound')
  const chunks: AlignmentChunk[] = []
  let first = 0
  for (const segment of segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || (chunks.length && segment.start < chunks[chunks.length - 1].end)) throw Error('Invalid audio segments')
    let start = segment.start
    while (first < words.length && words[first].start < segment.end) {
      start = Math.max(start, words[first].start - 1000)
      if (words[first].start < start || words[first].end > segment.end) throw Error('Word crosses an audio gap or chunk join')
      let last = first
      while (last + 1 < words.length && words[last + 1].end <= Math.min(segment.end, start + maxMs)) last++
      if (words[last].end > start + maxMs) throw Error('Word exceeds chunk bound')
      let end = Math.min(segment.end, start + maxMs)
      if (last + 1 < words.length && words[last + 1].start < segment.end) {
        let join = -1
        for (let i = first; i <= last; i++) {
          const next = words[i + 1]
          if (!next) break
          const pause = silence.find(s => s.end > s.start && s.start >= words[i].end && s.end <= next.start && (s.start + s.end) / 2 <= start + maxMs)
          if (pause) { join = i; end = (pause.start + pause.end) / 2 }
        }
        if (join < first) end = Math.min(start+maxMs, (words[last].end+words[last+1].start)/2)
        else last = join
      } else end = Math.min(segment.end, start + maxMs)
      chunks.push({ start, end, firstWord: first, lastWord: last })
      first = last + 1; start = end
    }
  }
  if (first !== words.length) throw Error('Words outside recorded segments')
  return chunks
}
