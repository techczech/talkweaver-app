// Plays a layered Run by its edit list (ADR-0043, slice 3a): the slides picture, the camera inset in
// the export's rectangle, and the voice, each a separate file placed on the Run clock. Cuts are skipped
// with a fade at each join; time is Run time inside, edited time to the person.
//
// Clock: the voice when there is one (it is what a listener notices), otherwise the system clock. A
// 4 ms timer watches the joins (volume and the jump to the next kept moment); each display frame puts
// the picture files where the clock says: small drift is corrected by nudging their rate, large drift
// by seeking. The measured drift is kept on the element (data-drift-*) for measurement.
//
// The export cuts and fades sample-exactly; this player fades by changing the element's volume in
// 4 ms steps, which is as close as an HTML media element allows without Web Audio (the app's page
// policy does not let Web Audio read the twrec: files).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { cameraRectPercent, JOIN_FADE_MS, shownFrom, spanFor, type KeptSpan } from '../../../../shared/recording-video'

export type PlayerClip = { url: string; startMs: number; endMs: number }
export type PlayerSource = { voice: string | null; slides: PlayerClip[]; camera: PlayerClip[] }
export type LayeredPlayerHandle = { play: () => void; pause: () => void; toggle: () => void; seekRun: (ms: number) => void; runMs: () => number; playing: () => boolean }

const SEEK_DRIFT_MS = 250, NUDGE_DRIFT_MS = 25, SETTLE_MS = 600

export const LayeredPlayer = forwardRef<LayeredPlayerHandle, {
  source: PlayerSource
  spans: KeptSpan[]
  durationMs: number
  camera: boolean
  notice?: string | null
  onTime: (runMs: number) => void
  onPlaying: (playing: boolean) => void
}>(function LayeredPlayer({ source, spans, durationMs, camera, notice, onTime, onPlaying }, ref) {
  const rootRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const slideRefs = useRef<Array<HTMLVideoElement | null>>([])
  const cameraRefs = useRef<Array<HTMLVideoElement | null>>([])
  const [voiceFailed, setVoiceFailed] = useState(false)
  const state = useRef({ playing: false, runMs: spans[0]?.startMs ?? 0, wallStart: 0, wallRun: 0, raf: 0, timer: 0 as ReturnType<typeof setInterval> | 0, jumping: false, settleUntil: 0, driftMax: 0, driftSum: 0, driftN: 0 })
  const [shownMs, setShownMs] = useState(state.current.runMs)
  const spansRef = useRef(spans); spansRef.current = spans
  const hasVoice = !!source.voice && !voiceFailed
  useEffect(() => setVoiceFailed(false), [source.voice])

  const now = useCallback((): number => {
    const s = state.current, audio = audioRef.current
    if (!s.playing) return s.runMs
    if (hasVoice && audio && !s.jumping && !audio.paused) return audio.currentTime * 1000
    return s.wallRun + (performance.now() - s.wallStart)
  }, [hasVoice])

  /** Put every picture file where Run time `t` says, and hide the ones not recording at `t`. */
  const placePictures = useCallback((t: number, playing: boolean, force: boolean): void => {
    const s = state.current
    const measure = playing && !force && performance.now() > s.settleUntil
    const follow = (layer: 'slides' | 'camera', videos: Array<HTMLVideoElement | null>, clips: PlayerClip[], visible: boolean): void => {
      clips.forEach((clip, i) => {
        const v = videos[i]
        if (!v) return
        const active = visible && t >= shownFrom({ layer, startMs: clip.startMs }, i === 0) && t < clip.endMs
        v.style.visibility = active ? 'visible' : 'hidden'
        if (!active) { if (!v.paused) v.pause(); return }
        // Before the file starts (a held first frame) the wanted time is negative: hold at 0.
        const want = Math.max(0, (t - clip.startMs) / 1000)
        const end = Number.isFinite(v.duration) ? v.duration : Infinity
        // A file shorter than its span (a crash cut it short) holds its last frame, as the export does.
        const target = Math.min(want, Math.max(0, end - 0.04))
        const drift = (v.currentTime - target) * 1000
        if (playing && want < end && t >= clip.startMs) {
          if (Math.abs(drift) > SEEK_DRIFT_MS || (force && Math.abs(drift) > 1)) { v.currentTime = target; v.playbackRate = 1 }
          else v.playbackRate = Math.abs(drift) > NUDGE_DRIFT_MS ? Math.max(0.9, Math.min(1.1, 1 - drift / 1000)) : 1
          if (v.paused) void v.play().catch(() => {})
          if (measure && !v.seeking && !v.paused) { s.driftMax = Math.max(s.driftMax, Math.abs(drift)); s.driftSum += Math.abs(drift); s.driftN++ }
        } else {
          if (!v.paused) v.pause()
          if (Math.abs(drift) > 1) v.currentTime = target
        }
      })
    }
    follow('slides', slideRefs.current, source.slides, true)
    follow('camera', cameraRefs.current, source.camera, camera)
  }, [source.slides, source.camera, camera])

  const report = useCallback((t: number): void => {
    setShownMs(t)
    onTime(t)
    const root = rootRef.current, s = state.current
    if (root) {
      root.dataset.runMs = String(Math.round(t))
      if (s.driftN) { root.dataset.driftMaxMs = s.driftMax.toFixed(1); root.dataset.driftMeanMs = (s.driftSum / s.driftN).toFixed(1); root.dataset.driftSamples = String(s.driftN) }
    }
  }, [onTime])

  const seekAll = useCallback((t: number): void => {
    const s = state.current
    s.runMs = t; s.wallRun = t; s.wallStart = performance.now(); s.settleUntil = performance.now() + SETTLE_MS
    const audio = audioRef.current
    if (audio && hasVoice) audio.currentTime = t / 1000
    placePictures(t, s.playing, true)
    report(t)
  }, [hasVoice, placePictures, report])

  const halt = useCallback((): void => {
    const s = state.current
    s.playing = false
    cancelAnimationFrame(s.raf)
    if (s.timer) clearInterval(s.timer)
    s.timer = 0
    audioRef.current?.pause()
  }, [])

  const stop = useCallback((): void => {
    const s = state.current
    const t = now()
    halt()
    s.runMs = t
    placePictures(t, false, false)
    onPlaying(false)
    report(t)
  }, [now, halt, placePictures, onPlaying, report])

  /** Sound at Run time `t`: full inside a span, ramped over JOIN_FADE_MS at the joins an edit made. */
  const volumeAt = (span: KeptSpan, t: number): number => Math.max(0, Math.min(1, span.fadeIn ? (t - span.startMs) / JOIN_FADE_MS : 1, span.fadeOut ? (span.endMs - t) / JOIN_FADE_MS : 1))

  // The fine clock: volume and joins, every 4 ms while playing.
  const watchJoins = useCallback((): void => {
    const s = state.current
    if (!s.playing || s.jumping) return
    const t = now()
    const span = spanFor(spansRef.current, t)
    const audio = audioRef.current
    if (!span) { const end = spansRef.current.at(-1)?.endMs ?? durationMs; halt(); s.runMs = end; seekAll(end); onPlaying(false); return }
    if (t < span.startMs - 40) { seekAll(span.startMs); return }
    if (t >= span.endMs - 2) {
      const next = spansRef.current[spansRef.current.indexOf(span) + 1]
      if (audio) audio.volume = 0
      if (!next) { halt(); s.runMs = span.endMs; seekAll(span.endMs); onPlaying(false); return }
      // The join: silent, every layer to the next kept moment, sound back once the voice is there.
      s.jumping = true
      seekAll(next.startMs)
      const resume = (): void => { s.jumping = false; s.wallRun = next.startMs; s.wallStart = performance.now() }
      if (audio && hasVoice && audio.seeking) audio.addEventListener('seeked', resume, { once: true }); else resume()
      return
    }
    if (audio) audio.volume = volumeAt(span, t)
  }, [now, halt, seekAll, onPlaying, hasVoice, durationMs])

  const frame = useCallback((): void => {
    const s = state.current
    if (!s.playing) return
    if (!s.jumping) {
      const t = now()
      s.runMs = t
      placePictures(t, true, false)
      report(t)
    }
    s.raf = requestAnimationFrame(frame)
  }, [now, placePictures, report])

  const play = useCallback((): void => {
    const s = state.current
    if (s.playing) return
    let t = s.runMs
    const span = spanFor(spansRef.current, t)
    if (!span) t = spansRef.current[0]?.startMs ?? 0
    else if (t < span.startMs) t = span.startMs
    s.playing = true; s.jumping = false
    seekAll(t)
    const audio = audioRef.current
    if (audio && hasVoice) { const first = spanFor(spansRef.current, t); audio.volume = first ? volumeAt(first, t) : 1; void audio.play().catch(() => setVoiceFailed(true)) }
    s.wallStart = performance.now(); s.wallRun = t
    onPlaying(true)
    s.timer = setInterval(watchJoins, 4)
    s.raf = requestAnimationFrame(frame)
  }, [seekAll, hasVoice, onPlaying, watchJoins, frame])

  useImperativeHandle(ref, () => ({
    play, pause: stop,
    toggle: () => (state.current.playing ? stop() : play()),
    seekRun: (ms: number) => {
      // A moment inside a cut shows what the export shows there: the next kept moment.
      const span = spanFor(spansRef.current, ms)
      seekAll(Math.max(0, Math.min(durationMs, span && ms < span.startMs ? span.startMs : ms)))
    },
    runMs: () => now(),
    playing: () => state.current.playing
  }), [play, stop, seekAll, now, durationMs])

  // New cuts while paused: stay on a kept moment.
  useEffect(() => {
    const s = state.current
    if (s.playing) return
    const span = spanFor(spans, s.runMs)
    if (span && s.runMs < span.startMs) seekAll(span.startMs)
  }, [spans, seekAll])
  useEffect(() => { placePictures(state.current.runMs, state.current.playing, true) }, [camera, placePictures])
  useEffect(() => () => halt(), [halt])

  const cam = useMemo(() => cameraRectPercent(), [])
  const placed = (): void => placePictures(state.current.runMs, state.current.playing, true)
  return (
    <div className="twrp-player" ref={rootRef} data-run-ms={Math.round(shownMs)} data-camera={camera && source.camera.length ? 'on' : 'off'}>
      <div className="twrp-frame">
        {source.slides.map((clip, i) => (
          <video key={clip.url} ref={(el) => { slideRefs.current[i] = el }} className="twrp-slides" src={clip.url} muted playsInline preload="auto" onLoadedMetadata={placed} />
        ))}
        {source.camera.map((clip, i) => (
          <video key={clip.url} ref={(el) => { cameraRefs.current[i] = el }} className="twrp-camera" src={clip.url} muted playsInline preload="auto"
            style={{ left: `${cam.left}%`, top: `${cam.top}%`, width: `${cam.width}%`, height: `${cam.height}%`, display: camera ? undefined : 'none' }} onLoadedMetadata={placed} />
        ))}
        {notice || voiceFailed ? <div className="twrp-notice" role="status">{voiceFailed ? 'The voice could not be played. Playing the picture only.' : notice}</div> : null}
      </div>
      {source.voice ? <audio ref={audioRef} src={source.voice} preload="auto" onError={() => setVoiceFailed(true)} /> : null}
    </div>
  )
})
