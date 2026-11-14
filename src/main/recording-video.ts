// Play back and export a layered Run (ADR-0043, slice 3a). Three jobs, all read-only on the recording:
//  1. resolve the Run's layer files (slides picture, camera, voice) on the Run's clock and say which
//     named file is missing;
//  2. prepare playback copies the player can seek in, in this Mac's app data (never beside the
//     recording): each picture file re-wrapped as it is (no re-encoding), and the voice laid on the
//     whole Run clock by the same timeline the export uses;
//  3. export one MP4 (or, for a Run without picture, one M4A) by the plan in shared/recording-video.ts,
//     through the app's ffmpeg, to a temporary name beside the chosen file, renamed only after it is
//     checked. No Electron import here: recording-video-ipc.ts binds it to the app.
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import { recordingAudioTimeline } from './recording-audio-timeline.ts'
import { isSafeRunId } from './runs.ts'
import { shownFrom, chapterListText, chaptersFor, captionCues, editedDurationMs, ffmetadata, frameOf, keptSpans, layerClips, placementRects, toSrt, toWebVtt, VIDEO_FRAME, withoutCamera, type FaceSegment, type Rect, type CaptionWord, type CaptureLike, type ChapterSlide, type KeptSpan, type LayerClip, type LayerName } from '../shared/recording-video.ts'
import type { TimeRange } from '../shared/recording-edits.ts'
import { createVoiceSplicer, dissolveWindows, JOIN_DISSOLVE_FRAMES, splicedLength, voiceSplicePlan } from '../shared/recording-joins.ts'
import { clipsOnVideoClock, toVideoClock, type TakeClock } from '../shared/recording-takes.ts'

/** `offsetMs`: where in its file the segment starts (0 when absent). */
export type VoiceSegment = { path: string; startMs: number; endMs: number; offsetMs?: number }
/** A picture file on the clock. `offsetMs`: its media time at `startMs` (0 when absent); `shownFromMs`: its first frame is held from here. */
export type PlacedClip = LayerClip & { path: string; offsetMs?: number; shownFromMs?: number }
export type MissingLayer = { layer: 'slides' | 'camera' | 'voice'; file: string }
export type ResolvedLayers = {
  runId: string
  durationMs: number
  slides: PlacedClip[]
  camera: PlacedClip[]
  voice: VoiceSegment[]
  missing: MissingLayer[]
}

/**
 * A folder inside `base`, every level a plain folder: not a link or junction, and resolving to exactly
 * the expected place under `base`'s real path. With `create`, missing levels are made one at a time and
 * checked as they are made. Returns null when a level is missing (and not created) or unsafe.
 */
export function plainFolder(base: string, parts: readonly string[], create: boolean): string | null {
  try {
    const root = realpathSync(base)
    let path = base
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.' || parts[i] === '..' || /[\/\\\0]/.test(parts[i])) return null
      path = join(path, parts[i])
      let st
      try { st = lstatSync(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) return null
        try { mkdirSync(path) } catch (made) { if ((made as NodeJS.ErrnoException).code !== 'EEXIST') throw made }
        st = lstatSync(path)
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return null
      if (realpathSync(path) !== join(root, ...parts.slice(0, i + 1))) return null
    }
    return path
  } catch { return null }
}

/** The picture layers of a Run, with their files in `<userData>/recordings/<runId>/`. Missing files are listed, not thrown. */
export function resolvePictureLayers(userDataDir: string, runId: string, capture: CaptureLike | null | undefined, durationMs: number): Pick<ResolvedLayers, 'slides' | 'camera' | 'missing'> {
  if (!isSafeRunId(runId)) throw Error('Unknown Run')
  // The recordings folder and the Run's folder must both be plain folders where they should be.
  const folder = plainFolder(userDataDir, ['recordings', runId], false) ?? join(userDataDir, 'recordings', runId, '\0unsafe')
  const clips = layerClips(capture, durationMs)
  const missing: MissingLayer[] = []
  const out = { slides: [] as ResolvedLayers['slides'], camera: [] as ResolvedLayers['camera'] }
  for (const layer of ['slides', 'camera'] as LayerName[]) {
    for (const clip of clips[layer]) {
      // Only the layer store's own names; anything else is not this Run's file.
      if (!new RegExp(`^${layer}(\\.seg-\\d{1,3})?\\.webm$`).test(clip.file)) { missing.push({ layer, file: clip.file }); continue }
      const path = join(folder, clip.file)
      try {
        const st = lstatSync(path)
        if (!st.isFile() || st.isSymbolicLink() || st.size === 0) throw Error('not a file')
        out[layer].push({ ...clip, path })
      } catch { missing.push({ layer, file: clip.file }) }
    }
  }
  return { ...out, missing }
}

// ---- ffmpeg process ---------------------------------------------------------------------------------

export type FfmpegRun = { stderr: string; outMs: number }
/**
 * One ffmpeg process: arguments as an array (never a shell), progress from -progress, cancelled by the
 * signal. `stdin`, when given, is piped to the process (the export's edited voice).
 */
export function runFfmpeg(ffmpeg: string, args: string[], signal: AbortSignal | null, progress?: (outMs: number) => void, stdin?: Readable): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(Error('cancelled'), { cancelled: true })); return }
    const child = spawn(ffmpeg, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (stdin && child.stdin) {
      // ffmpeg may close its input early (a failure, or cancelling): that is reported by its exit, not here.
      child.stdin.on('error', () => {})
      stdin.on('error', () => child.kill('SIGTERM'))
      stdin.pipe(child.stdin)
    }
    let stderr = '', buffer = '', outMs = 0, killTimer: ReturnType<typeof setTimeout> | undefined
    const abort = (): void => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1500) }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout!.on('data', (chunk) => {
      buffer += String(chunk)
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
          const v = Number(line.split('=')[1]) / 1000
          if (Number.isFinite(v) && v > outMs) { outMs = v; progress?.(outMs) }
        }
      }
      if (buffer.length > 8192) buffer = buffer.slice(-8192)
    })
    child.stderr!.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-32768) })
    child.once('error', (error) => { signal?.removeEventListener('abort', abort); reject(error) })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (killTimer) clearTimeout(killTimer)
      if (signal?.aborted) reject(Object.assign(Error('cancelled'), { cancelled: true }))
      else if (code !== 0) reject(Object.assign(Error(stderr.trim().split('\n').slice(-3).join(' ').slice(0, 800) || `ffmpeg exited ${code}`), { ffmpegLog: stderr }))
      else resolve({ stderr, outMs })
    })
  })
}

const sec = (ms: number): string => (ms / 1000).toFixed(6).replace(/\.?0+$/, '') || '0'

// ---- Even volume ----------------------------------------------------------------------------------

/**
 * Even out the volume (Look and sound › Sound). Two steps on the voice on the Run clock, before any cut:
 *  1. dynamic normalisation (ffmpeg `dynaudnorm`): gain follows the speech over 250 ms frames smoothed by
 *     a 15-frame Gaussian window (about 3.75 s), at most +26 dB, and anything quieter than −46 dBFS (room
 *     noise in a pause) is never raised. This evens out a quiet stretch against a loud one;
 *  2. two-pass EBU R128 loudness normalisation (`loudnorm`): the first pass measures the evened voice, the
 *     second applies one linear gain to reach −16 LUFS integrated with true peaks at most −1.5 dBTP.
 * The player's evened voice and the export use the same measurement, so they sound the same. Changing
 * these numbers changes what an evened voice is: bump PLAYBACK_COPY_VERSION so old copies are remade.
 */
export const EVEN_VOLUME = { dynamic: 'dynaudnorm=f=250:g=15:p=0.9:m=20:t=0.005', targetLufs: -16, truePeakDb: -1.5, loudnessRange: 11 } as const
/** The first pass's measurement (loudnorm's own figures), or null when the voice is silent. */
export type EvenMeasure = { i: number; lra: number; tp: number; thresh: number; offset: number }
const loudnorm = `loudnorm=I=${EVEN_VOLUME.targetLufs}:TP=${EVEN_VOLUME.truePeakDb}:LRA=${EVEN_VOLUME.loudnessRange}`
/** The filters that even a voice, ending in 48 kHz mono 16-bit. Without a measurement (silence) only the dynamic step runs. */
export function evenVolumeChain(measure: EvenMeasure | null): string {
  const out = 'aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono'
  if (!measure) return `${EVEN_VOLUME.dynamic},${out}`
  const f = (n: number): string => String(Math.round(n * 100) / 100)
  return `${EVEN_VOLUME.dynamic},${loudnorm}:measured_I=${f(measure.i)}:measured_LRA=${f(measure.lra)}:measured_TP=${f(measure.tp)}:measured_thresh=${f(measure.thresh)}:offset=${f(measure.offset)}:linear=true,${out}`
}
/** loudnorm's JSON report (the last {…} block of its log), or null when it measured silence or printed nothing usable. */
export function parseEvenMeasure(log: string): EvenMeasure | null {
  const start = log.lastIndexOf('{'), end = log.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const v = JSON.parse(log.slice(start, end + 1)) as Record<string, string>
    const m = { i: Number(v.input_i), lra: Number(v.input_lra), tp: Number(v.input_tp), thresh: Number(v.input_thresh), offset: Number(v.target_offset) }
    return Object.values(m).every(Number.isFinite) ? m : null
  } catch { return null }
}
/** The voice on the whole Run clock as filters ending in `label` (for measuring, playback copies and export). */
function voiceOnRunClock(voice: readonly VoiceSegment[], durationMs: number, label: string, chain: string | null): { inputs: string[]; filters: string[] } {
  const timeline = recordingAudioTimeline(voice, durationMs)
  return { inputs: timeline.inputs, filters: [...timeline.filters, `${timeline.label}${chain ? chain + ',' : ''}apad,atrim=duration=${sec(durationMs)}${label}`] }
}
/** First pass of even volume: measure the dynamically evened voice. */
export async function measureEvenVolume(ffmpeg: string, voice: readonly VoiceSegment[], durationMs: number, signal: AbortSignal | null = null): Promise<EvenMeasure | null> {
  const run = voiceOnRunClock(voice, durationMs, '[out]', `${EVEN_VOLUME.dynamic},${loudnorm}:print_format=json`)
  const { stderr } = await runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', ...run.inputs, '-filter_complex', run.filters.join(';'), '-map', '[out]', '-f', 'null', '-'], signal)
  return parseEvenMeasure(stderr)
}
/** One measurement per voice (its files, sizes and times): the player's copy and every export share it. */
export function createEvenVolume(deps: { ffmpeg: () => string | null }) {
  const cache = new Map<string, Promise<EvenMeasure | null>>()
  const keyOf = (voice: readonly VoiceSegment[], durationMs: number): string => JSON.stringify([durationMs, voice.map((v) => { const st = statSync(v.path); return [v.path, st.size, st.mtimeMs, v.startMs, v.endMs] })])
  return {
    measure(voice: readonly VoiceSegment[], durationMs: number, signal: AbortSignal | null = null): Promise<EvenMeasure | null> {
      const ffmpeg = deps.ffmpeg()
      if (!ffmpeg) return Promise.reject(Error('ffmpeg could not be found'))
      const key = keyOf(voice, durationMs)
      const known = cache.get(key)
      if (known) return known
      // A cancelled export's measurement is not kept: the next one measures again.
      const job = measureEvenVolume(ffmpeg, voice, durationMs, signal).catch((error) => { cache.delete(key); throw error })
      if (cache.size > 32) cache.delete(cache.keys().next().value as string)
      cache.set(key, job)
      return job
    }
  }
}
export type EvenVolume = ReturnType<typeof createEvenVolume>
const fsec = (frame: number): string => sec((frame * 1000) / VIDEO_FRAME.fps)

/** Keep a frame whose start time lies in a kept span; half-frame margins keep float rounding out. */
function keepExpression(spans: readonly KeptSpan[]): string {
  return balancedSum(spans.map((s) => `gte(t,${fsec(s.startFrame - 0.5)})*lt(t,${fsec(s.endFrame - 0.5)})`))
}

export type ExportPlanInput = {
  durationMs: number
  cuts: TimeRange[]
  /** Smooth joins: the sound crossfades and the picture dissolves at every join an edit made. */
  smooth?: boolean
  /** Where the face appears over the Run (faceTrack); absent: 0.44's corner throughout. */
  faces?: FaceSegment[]
  slides: Array<{ path: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }>
  camera: Array<{ path: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }>
  voice: VoiceSegment[]
  metadataFile?: string | null
  /** No picture: a sound file only. */
  audioOnly: boolean
  /** Even out the volume with this measurement (null: silent voice, dynamic step only); absent or false: as recorded. */
  even?: EvenMeasure | null | false
}

/** Balanced sums keep FFmpeg's expression parser shallow with many terms. */
function balancedSum(terms: string[]): string {
  return terms.length === 1 ? terms[0] : `(${balancedSum(terms.slice(0, terms.length >> 1))}+${balancedSum(terms.slice(terms.length >> 1))})`
}

/**
 * The ffmpeg arguments for the edited recording, before the output options. Picture: black 1920×1080 at
 * 30 fps on the Run clock; each slides file over it at its Run time; each camera file in the camera
 * rectangle while it ran; the spans' frames kept; with smooth joins the first frames after each join
 * dissolve from those before it (a JOIN_DISSOLVE_FRAMES-frame average shown only in dissolveWindows).
 * Sound: already edited, 16-bit mono 48 kHz on standard input (editedVoice: the voice on the Run clock,
 * evened if chosen, spliced at exactly the picture's frames with a crossfade or fades at each join).
 */
export function exportGraph(input: ExportPlanInput): { inputs: string[]; graph: string; spans: KeptSpan[]; editedMs: number; metadataIndex: number | null } {
  const spans = keptSpans(input.cuts, input.durationMs)
  if (!spans.length) throw Error('Nothing is left to export. Use the whole recording, then try again.')
  const editedMs = editedDurationMs(spans)
  const inputs: string[] = [], filters: string[] = []
  let index = 0
  inputs.push('-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0')
  filters.push(`[${index++}:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono,asetpts=N/SR/TB[aout]`)
  const keep = keepExpression(spans)
  if (!input.audioOnly) {
    const { width: W, height: H, fps } = VIDEO_FRAME
    filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${sec(input.durationMs)},format=yuv420p[base0]`)
    let base = 'base0', n = 0
    // Each layer file is shown in one rectangle per face placement it meets, each only over its stretches.
    type Place = { rect: Rect; when: TimeRange[] }
    const place = (clip: { path: string; startMs: number; endMs: number; offsetMs?: number }, from: number, places: Place[], picture: (r: Rect) => string): void => {
      const shown = places.filter((p) => p.when.some((w) => w.end > from && w.start < clip.endMs))
      if (!shown.length) return
      inputs.push('-i', clip.path)
      const span = sec(clip.endMs - from)
      const label = `layer${n}`
      // Held first frame from `from` to the file's start (shownFrom in the shared plan), last frame to its end.
      const lead = clip.startMs > from ? `tpad=start_mode=clone:start_duration=${sec(clip.startMs - from)},` : ''
      // A piece of a file (Record this slide again) starts `offsetMs` into it.
      const skip = clip.offsetMs && clip.offsetMs > 0 ? `trim=start=${sec(clip.offsetMs)},setpts=PTS-STARTPTS,` : ''
      filters.push(`[${index++}:v]setpts=PTS-STARTPTS,fps=${fps},${skip}setsar=1,format=yuv420p,${lead}tpad=stop_mode=clone:stop_duration=${span},trim=duration=${span},setpts=PTS+${sec(from)}/TB${shown.length > 1 ? `,split=${shown.length}` : ''}${shown.map((_, i) => `[${label}s${i}]`).join('')}`)
      shown.forEach((p, i) => {
        const sized = `${label}p${i}`
        filters.push(`[${label}s${i}]${picture(p.rect)},setsar=1,format=yuv420p[${sized}]`)
        const next = `base${++n}`
        const whole = places.length === 1 && p.when.length === 1 && p.when[0].start <= from && p.when[0].end >= clip.endMs
        const when = whole ? `gte(t,${sec(from)})*lt(t,${sec(clip.endMs)})`
          : `gte(t,${sec(from)})*lt(t,${sec(clip.endMs)})*${balancedSum(p.when.map((w) => `gte(t,${sec(w.start)})*lt(t,${sec(w.end)})`))}`
        filters.push(`[${base}][${sized}]overlay=x=${p.rect.x}:y=${p.rect.y}:eof_action=pass:enable='${when}'[${next}]`)
        base = next
      })
    }
    // The placements over the Run, grouped by the rectangle each layer takes. Without a camera to show,
    // every placement is the slides alone.
    const track = (input.faces?.length ? input.faces : [{ start: 0, end: input.durationMs, face: { layout: 'corner', corner: 'bottom-right', size: 'medium' } as const }])
      .map((seg) => ({ ...seg, face: input.camera.length ? seg.face : withoutCamera(seg.face) }))
    const group = (layer: 'slides' | 'camera'): Place[] => {
      const by = new Map<string, Place>()
      for (const seg of track) {
        const rect = placementRects(seg.face)[layer]
        if (!rect) continue
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
        const known = by.get(key)
        if (known) known.when.push({ start: seg.start, end: seg.end }); else by.set(key, { rect, when: [{ start: seg.start, end: seg.end }] })
      }
      return [...by.values()]
    }
    const slidePlaces = group('slides'), cameraPlaces = group('camera')
    input.slides.forEach((clip, i) => place(clip, clip.shownFromMs ?? shownFrom({ layer: 'slides', startMs: clip.startMs }, i === 0), slidePlaces, (r) => `scale=${r.width}:${r.height}:force_original_aspect_ratio=decrease,pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2`))
    for (const clip of input.camera) place(clip, clip.shownFromMs ?? clip.startMs, cameraPlaces, (r) => `scale=${r.width}:${r.height}:force_original_aspect_ratio=increase,crop=${r.width}:${r.height}`)
    const windows = input.smooth ? dissolveWindows(spans) : []
    if (!windows.length) filters.push(`[${base}]select='${keep}',setpts=N/${fps}/TB,format=yuv420p[vout]`)
    else {
      // The dissolve: a running average of the last frames, shown only just after each join.
      const show = balancedSum(windows.map((w) => `gte(t,${fsec(w.first - 0.5)})*lt(t,${fsec(w.last + 0.5)})`))
      filters.push(`[${base}]select='${keep}',setpts=N/${fps}/TB,format=yuv420p,split=2[cut0][cut1]`)
      filters.push(`[cut1]tmix=frames=${JOIN_DISSOLVE_FRAMES}:weights='${Array(JOIN_DISSOLVE_FRAMES).fill(1).join(' ')}'[mixed]`)
      filters.push(`[cut0][mixed]overlay=x=0:y=0:eof_action=pass:enable='${show}',format=yuv420p[vout]`)
    }
  }
  let metadataIndex: number | null = null
  if (input.metadataFile) { inputs.push('-f', 'ffmetadata', '-i', input.metadataFile); metadataIndex = index++ }
  return { inputs, graph: filters.join(';'), spans, editedMs, metadataIndex }
}

/**
 * The edited voice for the export, as 16-bit mono 48 kHz samples: the voice decoded on the Run clock
 * (evened if chosen) by one ffmpeg, spliced in this process by the plan (recording-joins.ts). Without a
 * voice, silence of the edited length. `done` settles when the decoder has finished (rejects if it failed).
 */
export function editedVoice(ffmpeg: string, input: ExportPlanInput, signal: AbortSignal | null): { stream: Readable; done: Promise<void> } {
  const spans = keptSpans(input.cuts, input.durationMs)
  const plan = voiceSplicePlan(spans, frameOf(input.durationMs), !!input.smooth)
  if (!input.voice.length) {
    let left = splicedLength(spans) * 2
    const stream = new Readable({ read() { const n = Math.min(left, 1 << 16); left -= n; this.push(n ? Buffer.alloc(n) : null) } })
    return { stream, done: Promise.resolve() }
  }
  const run = voiceOnRunClock(input.voice, input.durationMs, '[out]', input.even === undefined || input.even === false ? 'aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono' : evenVolumeChain(input.even))
  const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', ...run.inputs, '-filter_complex', run.filters.join(';'), '-map', '[out]', '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const splicer = createVoiceSplicer(plan)
  let carry: Buffer | null = null
  const toBuffers = (parts: Int16Array[], push: (b: Buffer) => void): void => { for (const p of parts) if (p.length) push(Buffer.from(p.buffer, p.byteOffset, p.byteLength)) }
  const stream = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      let bytes = carry ? Buffer.concat([carry, chunk]) : chunk
      carry = bytes.length % 2 ? bytes.subarray(bytes.length - 1) : null
      if (carry) bytes = bytes.subarray(0, bytes.length - 1)
      // A copy aligned for Int16Array (a Buffer slice may start at an odd offset).
      const samples = new Int16Array(bytes.length / 2)
      Buffer.from(samples.buffer).set(bytes)
      toBuffers(splicer.push(samples), (b) => this.push(b))
      callback()
    },
    flush(callback) { toBuffers(splicer.end(), (b) => this.push(b)); callback() }
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-8192) })
  // Stopped (the export was cancelled or the encoder ended first): close the pipe it may be blocked on,
  // ask it to stop, and make sure it does.
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const abort = (): void => { child.stdout?.destroy(); child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1500) }
  signal?.addEventListener('abort', abort, { once: true })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => { stream.destroy(error); reject(error) })
    child.once('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      if (code === 0 || signal?.aborted) { resolve(); return }
      const error = Object.assign(Error(stderr.trim().split('\n').slice(-3).join(' ').slice(0, 800) || `ffmpeg exited ${code}`), { ffmpegLog: stderr })
      stream.destroy(error)
      reject(error)
    })
  })
  done.catch(() => {})
  child.stdout.pipe(stream)
  return { stream, done }
}

/** The full encoding command for a temporary output file (its sound comes from editedVoice on standard input). */
export function exportArgs(input: ExportPlanInput, output: string): { args: string[]; editedMs: number } {
  const plan = exportGraph(input)
  const meta = plan.metadataIndex === null ? [] : ['-map_metadata', String(plan.metadataIndex), '-map_chapters', String(plan.metadataIndex)]
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '1']
  const args = [
    // -y: the output is the temporary file the exporter has just created (exclusively) for it.
    '-nostdin', '-hide_banner', '-v', 'error', '-nostats', '-y',
    ...plan.inputs,
    '-filter_complex', plan.graph,
    ...(input.audioOnly ? ['-map', '[aout]'] : ['-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FRAME.fps), '-fps_mode', 'cfr']),
    ...audio, ...meta,
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-f', input.audioOnly ? 'ipod' : 'mp4', output
  ]
  return { args, editedMs: plan.editedMs }
}

/** Read what an encoded file holds, from ffmpeg's own report (no ffprobe ships with the app). */
export async function inspectMedia(ffmpeg: string, path: string, signal: AbortSignal | null = null): Promise<{ durationMs: number; video: string | null; audio: string | null; chapters: number }> {
  let report = ''
  try { report = (await runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-i', path, '-map', '0', '-c', 'copy', '-f', 'null', '-'], signal)).stderr } catch (error) {
    if ((error as { cancelled?: boolean }).cancelled) throw error
    report = String((error as { ffmpegLog?: string }).ffmpegLog ?? error)
  }
  const head = report.split('Stream mapping:')[0]
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(head)
  return {
    durationMs: d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : NaN,
    video: /Stream #0:\d+[^\n]*Video: ([^\n]+)/.exec(head)?.[1] ?? null,
    audio: /Stream #0:\d+[^\n]*Audio: ([^\n]+)/.exec(head)?.[1] ?? null,
    chapters: (head.match(/^\s+Chapter #/gm) ?? []).length
  }
}

/**
 * A Run's layers on the video clock (Record this slide again): its own files split where takes go in,
 * later parts moved by the takes before them, each chosen take's files placed where its take starts, and
 * the voice the same way. Pure: the export and the tests use it.
 */
export function layersOnVideoClock(layers: Pick<ResolvedLayers, 'slides' | 'camera' | 'voice' | 'missing'>, takeLayers: ReadonlyMap<string, Pick<ResolvedLayers, 'slides' | 'camera' | 'voice' | 'missing'>>, clock: TakeClock, clockMs: number): Pick<ResolvedLayers, 'durationMs' | 'slides' | 'camera' | 'voice' | 'missing'> {
  const movedAt = (a: number): number => clock.inserts.reduce((n, x) => n + (x.at <= a ? x.length : 0), 0)
  const hold = (layer: 'slides' | 'camera') => (clip: { startMs: number }, first: boolean): number => shownFrom({ layer, startMs: clip.startMs }, first)
  const slides = clipsOnVideoClock(clock, layers.slides, (run) => takeLayers.get(run)?.slides ?? [], hold('slides'))
  const camera = clipsOnVideoClock(clock, layers.camera, (run) => takeLayers.get(run)?.camera ?? [], hold('camera'))
  const voice = [
    ...layers.voice.flatMap((v) => {
      // Each part of a voice file between insertion points, later parts moved by the takes before them.
      const points = [v.startMs, ...clock.inserts.map((x) => x.at).filter((at) => at > v.startMs && at < v.endMs), v.endMs]
      return points.slice(0, -1).map((a, k) => { const m = movedAt(a); return { path: v.path, startMs: a + m, endMs: points[k + 1] + m, offsetMs: (v.offsetMs ?? 0) + a - v.startMs } })
    }),
    ...clock.inserts.flatMap((i) => (takeLayers.get(i.run)?.voice ?? []).flatMap((v) => { const at = toVideoClock(clock, i.at), end = Math.min(v.endMs, i.length); return end > v.startMs ? [{ path: v.path, startMs: at + v.startMs, endMs: at + end, offsetMs: v.offsetMs ?? 0 }] : [] }))
  ]
  return { durationMs: clockMs, slides, camera, voice, missing: [...layers.missing, ...[...takeLayers.values()].flatMap((t) => t.missing)] }
}

// ---- Playback copies ------------------------------------------------------------------------------

export type PlaybackSet = {
  identity: string
  voice: string | null
  /** Each piece of a picture file on the clock, by its copy's name (pieces of one file share a copy). */
  slides: Array<{ name: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }>
  camera: Array<{ name: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }>
  /** Layer files that could not be prepared this time (retried on the next open). */
  unreadable: MissingLayer[]
}
const PLAY_NAME = /^(voice|voice-even|slides-\d{1,3}|camera-\d{1,3})\.webm$/
const IDENTITY = /^[a-f0-9]{24}$/
const PLAYBACK_ROOT = 'recording-playback'

/** The playback folder for a Run: `<userData>/recording-playback/<runId>/<identity>/`, checked level by level; null if unsafe or missing. */
export function playbackFolder(userDataDir: string, runId: string, identity: string, create = false): string | null {
  if (!isSafeRunId(runId) || !IDENTITY.test(identity)) return null
  return plainFolder(userDataDir, [PLAYBACK_ROOT, runId, identity], create)
}

/** A prepared playback file, or null. Served to the player only through this check. */
export function playbackFile(userDataDir: string, runId: string, identity: string, name: string): string | null {
  try {
    if (!PLAY_NAME.test(name)) return null
    const folder = playbackFolder(userDataDir, runId, identity)
    if (!folder) return null
    const path = join(folder, name)
    const st = lstatSync(path)
    return st.isFile() && !st.isSymbolicLink() && st.size > 0 ? path : null
  } catch { return null }
}

/** The only files this app writes in a playback-copy folder. Nothing else there is ever removed. */
const COPY_FILE = /^((voice|voice-even|slides-\d{1,3}|camera-\d{1,3})\.webm|ready\.json|\.(voice|voice-even|slides-\d{1,3}|camera-\d{1,3})\.webm\.[0-9a-f-]{36}\.part)$/

/** Names in a folder, or none if it cannot be listed. */
function namesIn(folder: string): string[] {
  try { return readdirSync(folder) } catch { return [] }
}

/**
 * Remove one playback-copy folder without ever removing a tree: only files with the names this app
 * writes, each only if it is a regular file (not followed), then the folder itself with rmdir, which
 * leaves it in place if anything else is in it. If the folder has been swapped for a link meanwhile,
 * the worst that can happen is that files of exactly these names are removed; no folder is.
 */
function removeCopyFolder(folder: string): void {
  for (const name of namesIn(folder)) {
    if (!COPY_FILE.test(name)) continue
    const path = join(folder, name)
    try { const st = lstatSync(path); if (st.isFile() && !st.isSymbolicLink()) unlinkSync(path) } catch { /* gone or not ours */ }
  }
  try { rmdirSync(folder) } catch { /* not empty, not a folder, or gone: left as it is */ }
}

/** Remove a Run's copy folders (each by removeCopyFolder) except `keep`; without `keep`, then the Run's folder if it is then empty. */
function removeRunCopies(runFolder: string, keep?: string): void {
  for (const name of namesIn(runFolder)) {
    if (name === keep || !IDENTITY.test(name)) continue
    const path = join(runFolder, name)
    try { const st = lstatSync(path); if (st.isDirectory() && !st.isSymbolicLink()) removeCopyFolder(path) } catch { /* gone */ }
  }
  if (keep === undefined) try { rmdirSync(runFolder) } catch { /* not empty or gone */ }
}

/**
 * Remove a Run's playback copies (when the Run is deleted). Only inside a plain
 * `<userData>/recording-playback/`; nothing but this app's own copy files is removed.
 */
export function removePlaybackCopies(userDataDir: string, runId: string): void {
  if (!isSafeRunId(runId)) return
  const folder = plainFolder(userDataDir, [PLAYBACK_ROOT, runId], false)
  if (folder) removeRunCopies(folder)
}

/** Part of every copy folder's identity: a new value makes every copy again (2: release 0.44). */
const PLAYBACK_COPY_VERSION = 2
function identityOf(layers: ResolvedLayers): string {
  const files = [...layers.slides, ...layers.camera, ...layers.voice].map((f) => {
    const st = statSync(f.path)
    return [f.path, st.size, st.mtimeMs, f.startMs, f.endMs, f.offsetMs ?? 0]
  })
  return createHash('sha256').update(JSON.stringify([PLAYBACK_COPY_VERSION, layers.durationMs, files])).digest('hex').slice(0, 24)
}

export function createPlaybackPreparer(deps: { userDataDir: () => string; ffmpeg: () => string | null; even?: EvenVolume }) {
  const even = deps.even ?? createEvenVolume({ ffmpeg: deps.ffmpeg })
  const running = new Map<string, Promise<PlaybackSet>>()
  /** Copies of Runs whose recording folder is gone (the Run was deleted) are removed; the cache stays bounded by the recordings. */
  function sweepGoneRuns(root: string, keep: string): void {
    for (const name of readdirSync(root)) {
      if (name === keep) continue
      if (!isSafeRunId(name)) continue
      try { lstatSync(join(deps.userDataDir(), 'recordings', name)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
        const folder = plainFolder(deps.userDataDir(), [PLAYBACK_ROOT, name], false)
        if (folder) removeRunCopies(folder)
      }
    }
  }
  async function build(layers: ResolvedLayers): Promise<PlaybackSet> {
    const ffmpeg = deps.ffmpeg()
    if (!ffmpeg) throw Error('The app’s ffmpeg could not be found, so the recording cannot be prepared for playback.')
    const identity = identityOf(layers)
    // Every level is checked before anything is listed, removed or written (no following links).
    const root = plainFolder(deps.userDataDir(), [PLAYBACK_ROOT], true)
    const runFolder = root && plainFolder(deps.userDataDir(), [PLAYBACK_ROOT, layers.runId], true)
    if (!root || !runFolder) throw Error('The playback folder in this Mac’s app data is not a plain folder, so playback copies were not made.')
    sweepGoneRuns(root, layers.runId)
    // Older copies of this Run (made before its files changed) are removed.
    removeRunCopies(runFolder, identity)
    const folder = playbackFolder(deps.userDataDir(), layers.runId, identity, true)
    if (!folder) throw Error('The playback folder in this Mac’s app data is not a plain folder, so playback copies were not made.')
    const manifest = join(folder, 'ready.json')
    const usable = (name: string): boolean => playbackFile(deps.userDataDir(), layers.runId, identity, name) !== null
    try {
      const set = JSON.parse(readFileSync(manifest, 'utf8')) as PlaybackSet
      // Reused only when complete and every listed copy is still there.
      if (set.identity === identity && !set.unreadable?.length && [set.voice, ...set.slides.map((c) => c.name), ...set.camera.map((c) => c.name)].every((n) => n === null || usable(n))) return set
    } catch { /* made below */ }
    try { unlinkSync(manifest) } catch { /* none */ }
    const set: PlaybackSet = { identity, voice: null, slides: [], camera: [], unreadable: [] }
    // A copy appears under its name only when complete, so one already there is reused and a failed one is retried next time.
    const make = async (name: string, args: string[]): Promise<boolean> => {
      if (usable(name)) return true
      const temp = join(folder, `.${name}.${randomUUID()}.part`)
      try { await runFfmpeg(ffmpeg, [...args, '-f', 'webm', temp], null); renameSync(temp, join(folder, name)); return true } catch { try { unlinkSync(temp) } catch { /* none */ } return false }
    }
    if (layers.voice.length) {
      const timeline = recordingAudioTimeline(layers.voice, layers.durationMs)
      const ok = await make('voice.webm', ['-nostdin', '-hide_banner', '-v', 'error', ...timeline.inputs, '-filter_complex', `${timeline.filters.join(';')};${timeline.label}apad,atrim=duration=${sec(layers.durationMs)}[out]`, '-map', '[out]', '-c:a', 'libopus', '-b:a', '64k'])
      if (ok) set.voice = 'voice.webm'; else set.unreadable.push({ layer: 'voice', file: basename(layers.voice[0].path) })
    }
    for (const layer of ['slides', 'camera'] as const) {
      // One copy per file, named by its place among this layer's files; every piece of it plays from that copy.
      const files = [...new Set(layers[layer].map((c) => c.path))]
      const made = new Map<string, string | null>()
      for (const clip of layers[layer]) {
        if (!made.has(clip.path)) {
          const name = `${layer}-${files.indexOf(clip.path)}.webm`
          // Re-wrapped, not re-encoded: the same frames, with the index a player needs to seek.
          made.set(clip.path, await make(name, ['-nostdin', '-hide_banner', '-v', 'error', '-i', clip.path, '-map', '0:v:0', '-c', 'copy', '-avoid_negative_ts', 'make_zero']) ? name : null)
          if (!made.get(clip.path)) set.unreadable.push({ layer, file: clip.file })
        }
        const name = made.get(clip.path)
        if (name) set[layer].push({ name, startMs: clip.startMs, endMs: clip.endMs, ...(clip.offsetMs ? { offsetMs: clip.offsetMs } : {}), ...(clip.shownFromMs !== undefined ? { shownFromMs: clip.shownFromMs } : {}) })
      }
    }
    // Only a complete set is recorded as reusable.
    if (!set.unreadable.length) writeFileSync(manifest, JSON.stringify(set))
    return set
  }
  /** The evened voice beside the other copies (made on first use; the copies must exist first). */
  async function buildEven(layers: ResolvedLayers): Promise<{ identity: string; name: string } | null> {
    const ffmpeg = deps.ffmpeg()
    if (!ffmpeg) throw Error('The app’s ffmpeg could not be found, so the recording cannot be prepared for playback.')
    if (!layers.voice.length) return null
    const identity = identityOf(layers)
    const folder = playbackFolder(deps.userDataDir(), layers.runId, identity)
    if (!folder) throw Error('Open the recording again; its playback copies are not ready.')
    const name = 'voice-even.webm'
    if (playbackFile(deps.userDataDir(), layers.runId, identity, name)) return { identity, name }
    const measure = await even.measure(layers.voice, layers.durationMs)
    const run = voiceOnRunClock(layers.voice, layers.durationMs, '[out]', evenVolumeChain(measure))
    const temp = join(folder, `.${name}.${randomUUID()}.part`)
    try {
      await runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', ...run.inputs, '-filter_complex', run.filters.join(';'), '-map', '[out]', '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', temp], null)
      renameSync(temp, join(folder, name))
    } catch (error) { try { unlinkSync(temp) } catch { /* none */ } throw error }
    return { identity, name }
  }
  const evenRunning = new Map<string, Promise<{ identity: string; name: string } | null>>()
  return {
    prepare(layers: ResolvedLayers): Promise<PlaybackSet> {
      const key = layers.runId
      const existing = running.get(key)
      if (existing) return existing
      const job = build(layers).finally(() => running.delete(key))
      running.set(key, job)
      return job
    },
    /** The evened voice for the player (Look and sound › Even out the volume), or null for a Run without a voice. */
    prepareEven(layers: ResolvedLayers): Promise<{ identity: string; name: string } | null> {
      const key = layers.runId
      const existing = evenRunning.get(key)
      if (existing) return existing
      const job = buildEven(layers).finally(() => evenRunning.delete(key))
      evenRunning.set(key, job)
      return job
    }
  }
}

// ---- Export ---------------------------------------------------------------------------------------

export type ExportExtras = { captions: boolean; chapterList: boolean; sound: boolean }
export type ExportRequest = {
  layers: ResolvedLayers
  cuts: TimeRange[]
  camera: boolean
  /** Even out the volume (measured once per voice, as for the player's evened copy). */
  evenVolume?: boolean
  /** Smooth joins: crossfade the sound and dissolve the picture at every join an edit made. */
  smoothJoins?: boolean
  /** Where the face appears over the Run (faceTrack of the resolved rows); absent: 0.44's corner. */
  faces?: FaceSegment[]
  extras: ExportExtras
  /** Where the video goes. */
  destination: string
  /**
   * True only when `destination` is exactly the file the owner approved in the save panel (which asked
   * before replacing it). Otherwise an existing file is never replaced: a free name beside it is used.
   */
  replace: boolean
  title: string
  enters: Array<{ tMs: number; slideId?: string }>
  slides: Record<string, ChapterSlide>
  words: CaptionWord[]
  segments: CaptionWord[]
}
export type ExportState =
  | { state: 'working'; fraction: number }
  | { state: 'done'; file: string; name: string; bytes: number; durationMs: number; extras: string[]; chapters: number; captions: number; captionsLeftOut: number; elapsedMs: number }
  | { state: 'failed'; message: string; detail?: string; written?: string[] }
  | { state: 'cancelled' }

/** A numbered sibling: "name.srt", "name (2).srt", … */
export function numberedName(wanted: string, n: number): string {
  if (n <= 1) return wanted
  const ext = extname(wanted), stem = wanted.slice(0, wanted.length - ext.length)
  return `${stem} (${n})${ext}`
}

/** The first free numbered name beside `wanted` (a check only; publishing is exclusive anyway). */
export function freeName(wanted: string, taken: (path: string) => boolean = existsSync): string {
  for (let n = 1; n < 1000; n++) { const candidate = numberedName(wanted, n); if (!taken(candidate)) return candidate }
  throw Error('No free file name')
}

/**
 * What makes a file this app created recognisable later: device and inode (the file index on Windows
 * NTFS), and the creation time as a second marker where inodes are reused or unreliable (FAT and some
 * network disks report 0). Read with bigint stats so nothing is rounded. A path whose object differs in
 * any of these is not ours, whatever its name.
 */
export type FileIdentity = { dev: string; ino: string; birth: string }
export function identityOfStats(st: { dev: bigint; ino: bigint; birthtimeNs: bigint }): FileIdentity {
  return { dev: String(st.dev), ino: String(st.ino), birth: String(st.birthtimeNs) }
}
/** Whether `path` is still the regular file with this identity (the path itself, not followed). */
/** A value a disk really reported: FAT and some network disks give 0 (or nothing) for the inode or the creation time. */
const reported = (value: string): boolean => value !== '' && value !== '0' && value !== 'undefined' && value !== 'null'
/**
 * Whether this identity can tell one file from another at all. Without an inode it cannot, and then
 * nothing is ever removed on its strength (clean-up fails closed and leaves the file).
 */
export function identifies(id: FileIdentity | undefined): id is FileIdentity {
  return !!id && reported(id.dev) && reported(id.ino)
}
export function isSameFile(path: string, id: FileIdentity | undefined): boolean {
  if (!identifies(id)) return false
  try {
    const st = lstatSync(path, { bigint: true })
    const now = identityOfStats(st)
    if (!st.isFile() || st.isSymbolicLink() || !identifies(now)) return false
    if (now.dev !== id.dev || now.ino !== id.ino) return false
    // The creation time is the second marker where the disk reports one; where it reports none on
    // both sides, device and inode decide.
    return reported(id.birth) || reported(now.birth) ? now.birth === id.birth : true
  } catch { return false }
}
/** Remove `path` only if it is still the file with this identity. Returns true when it is gone (removed now or already missing). */
export function removeIfSame(path: string, id: FileIdentity | undefined): boolean {
  if (isSameFile(path, id)) { try { unlinkSync(path); return true } catch { return false } }
  try { lstatSync(path); return false } catch { return true }
}
/** Create `path` exclusively (never an existing file or a link) and return its identity. */
export function createOwnedFile(path: string, text?: string): FileIdentity {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    if (text !== undefined) writeFileSync(fd, text)
    return identityOfStats(fstatSync(fd, { bigint: true }))
  } finally { closeSync(fd) }
}
/** An exclusive copy for disks without hard links: the new file is created by us, so its identity is exact. */
export function exclusiveCopy(from: string, to: string, hooks: { afterChunk?: () => void } = {}): FileIdentity {
  const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  // Ours from this moment: the identity is read from the open file, before anything is copied, so a
  // failed copy removes this file and never whatever another program has since put under the name.
  let id: FileIdentity | undefined
  try {
    id = identityOfStats(fstatSync(out, { bigint: true }))
    const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.alloc(4 * 1024 * 1024)
      for (let read; (read = readSync(input, buffer, 0, buffer.length, null)) > 0;) {
        for (let off = 0; off < read;) off += writeSync(out, buffer, off, read - off)
        hooks.afterChunk?.()
      }
    } finally { closeSync(input) }
    closeSync(out)
    return id
  } catch (error) {
    try { closeSync(out) } catch { /* already closed */ }
    // Still our partial file but it could not be removed: say so, so the failure can name it.
    if (!removeIfSame(to, id) && isSameFile(to, id)) Object.assign(error as Error, { partial: to })
    throw error
  }
}

/**
 * Publish a finished temporary file under `wanted`, or under the first free numbered name beside it,
 * without ever replacing an existing file: a hard link (exclusive by nature) where the disk allows it,
 * else an exclusive copy. A collision, however late, moves on to the next name. Returns the name used
 * and the identity of the published object, so a rollback removes that object and nothing else.
 */
export function publishExclusive(temp: string, wanted: string, io: { link?: typeof linkSync; copy?: (from: string, to: string) => FileIdentity | void } = {}): { path: string; identity: FileIdentity } {
  const link = io.link ?? linkSync, copy = io.copy ?? exclusiveCopy
  const tempId = identityOfStats(lstatSync(temp, { bigint: true }))
  for (let n = 1; n < 1000; n++) {
    const candidate = numberedName(wanted, n)
    let identity: FileIdentity = tempId
    try { link(temp, candidate) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      try { identity = copy(temp, candidate) ?? identityOfStats(lstatSync(candidate, { bigint: true })) } catch (copied) {
        if ((copied as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw copied
      }
    }
    removeIfSame(temp, tempId)
    return { path: candidate, identity }
  }
  throw Error('No free file name')
}

/** Plain words for a failure; the recording and the edits are never touched by an export. */
export function exportFailureMessage(error: unknown): string {
  const text = String((error as { ffmpegLog?: string })?.ffmpegLog ?? (error as Error)?.message ?? error)
  if (/No space left on device|ENOSPC/i.test(text)) return 'Could not finish: the disk is full. Your recording and your edits are safe.'
  if (/EACCES|EPERM|Permission denied|read-only/i.test(text)) return 'Could not finish: that folder cannot be written to. Your recording and your edits are safe.'
  if (/ffmpeg could not be found|ENOENT.*ffmpeg/i.test(text)) return 'Could not finish: the app’s video tool is missing. Your recording and your edits are safe.'
  if (/Nothing is left/.test(text)) return 'Nothing is left to export. Use the whole recording, then try again.'
  return 'Could not finish the video. Your recording and your edits are safe.'
}

/** Temporary export files are named `.tw-export-<uuid><suffix>` beside the destination: short, and recognisably this app's. */
export const EXPORT_TEMP_NAME = /^\.tw-export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{2,6}){1,2}$/

/**
 * A small record in app data of the temporary files an export has created and not yet removed, so a
 * crash or forced quit leaves nothing behind for long. Each entry is recorded after the file was
 * created exclusively, with its identity (FileIdentity). The next start removes a recorded path only if
 * the object there is still that same regular file with this app's temporary-file name; anything else
 * at that path is left alone and the entry dropped. Entries of the earlier format (a path alone) are
 * dropped without removing anything.
 */
export type TempEntry = { path: string; identity: FileIdentity }
export function createTempRecord(file: string) {
  const valid = (e: unknown): e is TempEntry => !!e && typeof e === 'object' && typeof (e as TempEntry).path === 'string' && !!(e as TempEntry).identity && ['dev', 'ino', 'birth'].every((k) => typeof (e as TempEntry).identity[k as keyof FileIdentity] === 'string')
  const read = (): TempEntry[] => { try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter(valid) : [] } catch { return [] } }
  const write = (list: TempEntry[]): void => {
    try {
      if (!list.length) { try { unlinkSync(file) } catch { /* none */ } return }
      const temp = `${file}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(list), { flag: 'wx', mode: 0o600 })
      renameSync(temp, file)
    } catch { /* the record is a safety net; the export itself still cleans up */ }
  }
  return {
    add(entry: TempEntry): void { write([...read().filter((e) => e.path !== entry.path), entry]) },
    remove(paths: readonly string[]): void { write(read().filter((e) => !paths.includes(e.path))) },
    /** Remove what an earlier session left. Returns the files removed. */
    sweep(): string[] {
      const removed: string[] = []
      // An entry is kept only while its own file is still there and could not be removed (a lock, a
      // permission, a disk not mounted yet would look missing and is dropped): the next start tries again.
      const kept: TempEntry[] = []
      for (const entry of read()) {
        if (!EXPORT_TEMP_NAME.test(basename(entry.path))) continue
        if (!isSameFile(entry.path, entry.identity)) continue
        if (removeIfSame(entry.path, entry.identity)) removed.push(entry.path)
        else kept.push(entry)
      }
      write(kept)
      return removed
    }
  }
}
export type TempRecord = ReturnType<typeof createTempRecord>

/** One export at a time. Writes only temporary files beside the destination until the checked, all-or-nothing commit. */
export function createVideoExporter(deps: { ffmpeg: () => string | null; now?: () => number; temps?: TempRecord; even?: EvenVolume; io?: { link?: typeof linkSync; copy?: (from: string, to: string) => FileIdentity | void; rename?: typeof renameSync } }) {
  const even = deps.even ?? createEvenVolume({ ffmpeg: deps.ffmpeg })
  let active: { id: string; controller: AbortController; done: Promise<ExportState> } | null = null
  const now = deps.now ?? Date.now
  const rename = deps.io?.rename ?? renameSync
  return {
    busy: () => active !== null,
    cancel(id?: string): boolean {
      if (!active || (id && active.id !== id)) return false
      active.controller.abort()
      return true
    },
    /** Stop a running export and wait (at most `ms`) for ffmpeg to end and the temporary files to go. */
    async shutdown(ms: number): Promise<void> {
      const running = active
      if (!running) return
      running.controller.abort()
      await Promise.race([running.done.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, ms))])
    },
    run(request: ExportRequest, report: (state: ExportState) => void, id: string = randomUUID()): Promise<ExportState> {
      if (active) { const s: ExportState = { state: 'failed', message: 'Another video is being exported. Wait for it to finish.' }; report(s); return Promise.resolve(s) }
      const controller = new AbortController()
      const holder = { id, controller, done: Promise.resolve<ExportState>({ state: 'cancelled' }) }
      active = holder
      holder.done = execute(request, report, controller).finally(() => { if (active === holder) active = null })
      return holder.done
    }
  }

  async function execute(request: ExportRequest, report: (state: ExportState) => void, controller: AbortController): Promise<ExportState> {
    const started = now()
    const folder = dirname(request.destination)
    // Every temporary file is created here, exclusively, before anything writes to it; its identity is
    // kept so that clean-up (now or at the next start) removes that file and nothing that replaced it.
    const temps: TempEntry[] = []
    const temp = (suffix: string, text?: string): string => {
      const path = join(folder, `.tw-export-${randomUUID()}${suffix}`)
      const entry = { path, identity: createOwnedFile(path, text) }
      temps.push(entry); deps.temps?.add(entry)
      return path
    }
    const signal = controller.signal
    const cancelled = (): never => { throw Object.assign(Error('cancelled'), { cancelled: true }) }
    try {
      const ffmpeg = deps.ffmpeg()
      if (!ffmpeg) throw Error('ffmpeg could not be found')
      const audioOnly = request.layers.slides.length === 0
      const spans = keptSpans(request.cuts, request.layers.durationMs)
      const chapters = audioOnly ? [] : chaptersFor(request.enters, request.slides, spans)
      let metadataFile: string | null = null
      if (chapters.length) metadataFile = temp('.ffmeta', ffmetadata(chapters, request.title))
      const output = temp(audioOnly ? '.m4a.part' : '.mp4.part')
      report({ state: 'working', fraction: 0 })
      const measure = request.evenVolume && request.layers.voice.length ? await even.measure(request.layers.voice, request.layers.durationMs, signal) : false
      if (signal.aborted) cancelled()
      const plan: ExportPlanInput = {
        durationMs: request.layers.durationMs, cuts: request.cuts, audioOnly, metadataFile, even: measure, smooth: !!request.smoothJoins, faces: request.faces,
        slides: request.layers.slides, camera: request.camera ? request.layers.camera : [], voice: request.layers.voice
      }
      const { args, editedMs } = exportArgs(plan, output)
      // The decoder of the voice stops with the encoder, whichever ends first.
      const decoding = new AbortController()
      const stopDecoding = (): void => decoding.abort()
      signal.addEventListener('abort', stopDecoding, { once: true })
      const voice = editedVoice(ffmpeg, plan, decoding.signal)
      try { await Promise.all([runFfmpeg(ffmpeg, args, signal, (outMs) => report({ state: 'working', fraction: Math.min(0.99, outMs / Math.max(1, editedMs)) }), voice.stream), voice.done]) }
      finally { signal.removeEventListener('abort', stopDecoding); decoding.abort(); voice.stream.destroy() }
      const checked = await inspectMedia(ffmpeg, output, signal)
      // One frame of the picture, plus the AAC encoder's priming, is the allowed difference.
      if (!Number.isFinite(checked.durationMs) || Math.abs(checked.durationMs - editedMs) > 1000 / VIDEO_FRAME.fps + 50 || !checked.audio || (!audioOnly && !/h264/.test(checked.video ?? ''))) throw Error(`The exported file did not check out (${checked.durationMs} ms against ${Math.round(editedMs)} ms).`)
      // Extras are made under temporary names too, so nothing has a final name before the commit.
      const extras: Array<{ temp: string; final: string }> = []
      const captions = request.extras.captions ? captionCues(request.words, spans, request.segments) : { cues: [], leftOut: 0 }
      const stem = request.destination.slice(0, request.destination.length - extname(request.destination).length)
      if (request.extras.captions) {
        for (const [ext, text] of [['.srt', toSrt(captions.cues)], ['.vtt', toWebVtt(captions.cues)]] as const) { const t = temp(ext + '.part', text); extras.push({ temp: t, final: `${stem}${ext}` }) }
      }
      if (request.extras.chapterList && chapters.length) { const t = temp('.txt.part', chapterListText(chapters)); extras.push({ temp: t, final: `${stem} chapters.txt` }) }
      if (request.extras.sound && !audioOnly) {
        const t = temp('.m4a.part')
        await runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', output, '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'ipod', t], signal)
        extras.push({ temp: t, final: `${stem}.m4a` })
      }
      if (signal.aborted) cancelled()
      // Commit. Extras first, each published under a name nobody holds (never replacing a file); then the
      // video last. If anything fails, the extras published so far are removed again, so a failed export
      // leaves no new file and the chosen file untouched. The report names any file that could not be removed.
      const published: Array<{ path: string; identity: FileIdentity }> = []
      let file: string
      try {
        for (const extra of extras) published.push(publishExclusive(extra.temp, extra.final, deps.io))
        if (request.replace) { rename(output, request.destination); file = request.destination }
        else file = publishExclusive(output, request.destination, deps.io).path
      } catch (error) {
        // Only the objects published here are removed; a file another program put under one of those
        // names since is left alone and named in the message.
        const left = published.filter((p) => !removeIfSame(p.path, p.identity)).map((p) => p.path)
        const partial = (error as { partial?: string }).partial
        if (partial) left.push(partial)
        throw Object.assign(error as Error, { written: left })
      }
      let bytes = 0
      try { bytes = statSync(file).size } catch { /* reported as 0 */ }
      const done: ExportState = { state: 'done', file, name: basename(file), bytes, durationMs: Math.round(editedMs), extras: published.map((p) => p.path), chapters: chapters.length, captions: captions.cues.length, captionsLeftOut: captions.leftOut, elapsedMs: now() - started }
      report(done)
      return done
    } catch (error) {
      const written = (error as { written?: string[] }).written
      const s: ExportState = (error as { cancelled?: boolean })?.cancelled ? { state: 'cancelled' } : { state: 'failed', message: written?.length ? `${exportFailureMessage(error)} These files remain because they could not be removed or were replaced by another program: ${written.map((p) => basename(p)).join(', ')}.` : exportFailureMessage(error), detail: String((error as Error)?.message ?? error).slice(0, 600), ...(written?.length ? { written } : {}) }
      report(s)
      return s
    } finally {
      const gone: string[] = []
      // Each temporary file only if it is still the one created here; whatever else is there stays.
      // The record of a file that is still ours and could not be removed stays, so the next start retries.
      for (const t of temps) if (removeIfSame(t.path, t.identity) || !isSameFile(t.path, t.identity)) gone.push(t.path)
      deps.temps?.remove(gone)
    }
  }
}
