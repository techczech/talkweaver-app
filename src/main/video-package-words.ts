import type { VideoPackRequest, WordTimings } from '../preload/index.ts'
import type { Transcription } from './transcription.ts'

/** Read the canonical inline pair through the transcription service, never a legacy sidecar. */
export async function videoPackageWords(tx: Transcription, input: VideoPackRequest, signal: AbortSignal): Promise<WordTimings> {
  if (signal.aborted) throw new Error('Package cancelled.')
  let current = await tx.get(input.talkSlug,input.sessionId)
  if (!current?.hasWords) {
    const made = await tx.run(input.talkSlug,input.sessionId,null,signal)
    if (!made.ok) throw new Error(made.error === 'busy' ? 'Another Run is being transcribed. Try again when it finishes.' : made.error === 'cancelled' ? 'Package cancelled.' : made.error)
    if (!made.hasWords) throw new Error('The transcription script did not make word timings. Check Settings → Transcription.')
    current = await tx.get(input.talkSlug,input.sessionId)
  }
  if (!current?.hasWords || !Array.isArray(current.words) || !current.words.length) throw new Error('Word timings could not be read from this transcript.')
  return {engine:current.engine,createdAt:current.createdAt,words:current.words}
}
