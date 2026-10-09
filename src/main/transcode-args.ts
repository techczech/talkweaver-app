// ffmpeg arguments for transcription's WebM → WAV step — pure, no Electron.
//
// A Run whose microphone was lost and picked up again has several audio segments (one WebM file
// each; recording-paths.ts names them). Transcription makes ONE WAV of the whole Run: the segments
// in order, with silence the length of each gap between them, so the transcript's timestamps stay
// on the recording clock and line up with the slide-time index. One file → the plain conversion.

/** Silence to put before each segment: 0 for the first, then the gap since the previous one. */
export function silencesBetween(segments: ReadonlyArray<{ startMs: number; endMs: number }>): number[] {
  return segments.map((seg, i) => {
    if (i === 0) return 0
    const prevEnd = Number(segments[i - 1].endMs)
    const start = Number(seg.startMs)
    return Number.isFinite(prevEnd) && Number.isFinite(start) ? Math.max(0, Math.round(start - prevEnd)) : 0
  })
}

export function transcodeArgs(sources: readonly string[], silencesMs: readonly number[], out: string): string[] {
  if (sources.length <= 1) return ['-y', '-i', sources[0] ?? '', out]
  const inputs: string[] = []
  const labels: string[] = []
  let n = 0
  sources.forEach((src, i) => {
    const silence = i > 0 ? Math.max(0, Number(silencesMs[i]) || 0) : 0
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
