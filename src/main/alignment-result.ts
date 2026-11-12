import { normaliseTranscript } from './transcript-validation.ts'
import type { TranscriptJson } from './transcription'
import type { AlignmentProvenance, WordAlignment } from '../shared/transcript-contract.ts'
/** Validate the complete optional result before any write. Text, order, count and all original
 * times are retained. The publishing service must recheck source/transcript identity at rename. */
export function withAlignment(original: TranscriptJson, provenance: AlignmentProvenance, placements: WordAlignment[]): TranscriptJson {
  if (!original.words?.length || placements.length !== original.words.length) throw Error('Alignment word count changed')
  const candidate = { ...original, alignment: provenance, words: original.words.map((w, i) => ({ ...w, alignment: placements[i] })) }
  const checked = normaliseTranscript(candidate)
  if (!checked?.alignment) throw Error('Invalid alignment result; transcript kept')
  // Validate through the read projection, but publish the additive candidate. The reader may
  // ignore malformed older optional metadata; alignment must never silently delete that data.
  return candidate
}
/** Explicitly discard optional alignment when words are transcribed again. */
export function withoutAlignment(transcript: TranscriptJson): TranscriptJson {
  const { alignment: _, ...rest } = transcript
  return { ...rest, ...(rest.words ? { words: rest.words.map(({ alignment: _, ...w }) => w) } : {}) }
}
