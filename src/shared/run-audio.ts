// How much audio a recorded Run holds, against how long it was recorded — pure, shared by main
// (which writes it into the Run) and the renderer (History and Studio show it).
//
// A recording is written as one or more continuous audio segments. A new segment starts when the
// microphone input is lost and picked up again; the time between two segments is a gap. All
// times are on the Run's recording clock (pause-aware, the same clock as `recordingMs` and the
// slide-time index), in ms.

export interface RunAudioSegment {
  /** File name in the local recordings folder (`<runId>.webm`, `<runId>.seg-2.webm`, …). */
  file: string
  bytes: number
  startMs: number
  endMs: number
}

export interface RunAudioGap {
  startMs: number
  endMs: number
  /** Why the audio stopped (recording-loss.ts reasons), or 'interrupted' for a crash. */
  reason: string
}

/** The fields of a Run's `audio` this module reads; older Runs carry only the first three. */
export interface RunAudioFields {
  r2Key?: string
  bytes?: number
  uploaded?: boolean
  audioMs?: number
  segments?: RunAudioSegment[]
  gaps?: RunAudioGap[]
  /** The recording ended without Stop (crash, window lost); the files hold what was written. */
  partial?: boolean
}

export interface RunAudioSummary {
  /** Audio held, ms. Equals `recordingMs` for a Run without segment data. */
  audioMs: number
  recordingMs: number
  /** True when the audio is noticeably shorter than the recording (or the Run is partial). */
  differs: boolean
  gaps: number
  partial: boolean
  /** "Audio 34 s of 2 h 57 min · 1 gap", or null when there is nothing to say. */
  label: string | null
}

/** Shorter than the recording by more than this counts as different (chunks are ~1 s). */
export const AUDIO_DIFFERS_TOLERANCE_MS = 3000

const finite = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

/** Sum of the segments' lengths on the recording clock. */
export function audioMsFromSegments(segments: ReadonlyArray<Pick<RunAudioSegment, 'startMs' | 'endMs'>>): number {
  let total = 0
  for (const seg of segments) {
    const start = finite(seg.startMs)
    const end = finite(seg.endMs)
    if (end > start) total += end - start
  }
  return total
}

/** A length in words: "34 s", "12 min 5 s", "2 h 57 min". */
export function fmtAudioLength(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec} s`
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`
  return s > 0 ? `${m} min ${s} s` : `${m} min`
}

export function runAudioSummary(run: { recordingMs?: number; audio?: RunAudioFields | null }): RunAudioSummary {
  const recordingMs = finite(run.recordingMs)
  const audio = run.audio
  if (!audio) return { audioMs: 0, recordingMs, differs: false, gaps: 0, partial: false, label: null }
  const segments = Array.isArray(audio.segments) ? audio.segments : []
  const gaps = Array.isArray(audio.gaps) ? audio.gaps.length : 0
  const partial = audio.partial === true
  const known = audio.audioMs !== undefined || segments.length > 0
  const audioMs = !known
    ? recordingMs
    : audio.audioMs !== undefined ? finite(audio.audioMs) : audioMsFromSegments(segments)
  const differs = partial || (known && recordingMs - audioMs > AUDIO_DIFFERS_TOLERANCE_MS)
  if (!differs) return { audioMs, recordingMs, differs, gaps, partial, label: null }
  const parts = [recordingMs > 0 ? `Audio ${fmtAudioLength(audioMs)} of ${fmtAudioLength(recordingMs)}` : `Audio ${fmtAudioLength(audioMs)}`]
  if (gaps > 0) parts.push(`${gaps} ${gaps === 1 ? 'gap' : 'gaps'}`)
  if (partial) parts.push('recording interrupted')
  return { audioMs, recordingMs, differs, gaps, partial, label: parts.join(' · ') }
}
