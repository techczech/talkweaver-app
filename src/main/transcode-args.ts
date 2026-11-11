import { recordingAudioTimeline } from './recording-audio-timeline.ts'
// ffmpeg arguments for transcription's WebM → WAV step — pure, no Electron.
//
// A Run whose microphone was lost and picked up again has several audio segments (one WebM file
// each; recording-paths.ts names them). Transcription makes ONE WAV of the whole Run: the segments
// in order, with silence the length of each gap between them, so the transcript's timestamps stay
// on the recording clock and line up with the slide-time index. A measured leading gap is included too. Legacy 0–0 placeholders carry no measured coverage.

import { recordingClock } from '../shared/recording-clock.ts'
export { recordingClock } from '../shared/recording-clock.ts'

export function silencesBetween(segments: ReadonlyArray<{ startMs: number; endMs: number }>): number[] {
  return recordingClock(segments).silencesMs
}

export function transcodeArgs(sources: readonly string[], silencesMs: readonly number[], out: string): string[] {
  if (sources.length <= 1 && !silencesMs[0]) return ['-y', '-i', sources[0] ?? '', out]
  const inputs: string[] = []
  const labels: string[] = []
  let n = 0
  sources.forEach((src, i) => {
    const silence = Math.max(0, Number(silencesMs[i]) || 0)
    if (silence > 0) {
      inputs.push('-f', 'lavfi', '-t', (silence / 1000).toFixed(3), '-i', 'anullsrc=r=48000:cl=mono')
      labels.push(`[${n}:a]`)
      n += 1
    }
    inputs.push('-i', src)
    labels.push(`[${n}:a]`)
    n += 1
  })
  // concat needs every input in one format: segments may differ (a stereo headset after a mono
  // laptop mic), and the silence is mono. Each input is resampled to 48 kHz mono s16 first.
  const normalised = labels.map((label, i) => `${label}aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[n${i}]`)
  const joined = `${labels.map((_, i) => `[n${i}]`).join('')}concat=n=${n}:v=0:a=1[a]`
  return ['-y', ...inputs, '-filter_complex', [...normalised, joined].join(';'), '-map', '[a]', out]
}

/** Production transcription uses the same measured trim/pad timeline as video export. */
export function recordingTranscodeArgs(segments:ReadonlyArray<{path:string;startMs:number;endMs:number}>,recordingMs:number,out:string):string[]{
  const timeline=recordingAudioTimeline(segments,recordingMs)
  return ['-nostdin','-y',...timeline.inputs,'-filter_complex',timeline.filters.join(';'),'-map',timeline.label,out]
}
