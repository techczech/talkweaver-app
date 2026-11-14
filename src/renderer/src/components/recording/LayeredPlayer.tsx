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
import { faceAt, JOIN_FADE_MS, placementRects, shownFrom, spanFor, toPercent, VIDEO_FRAME, withoutCamera, type FaceSegment, type KeptSpan } from '../../../../shared/recording-video'
import { JOIN_DISSOLVE_FRAMES } from '../../../../shared/recording-joins'
import { fromVideoClock, NO_TAKES, toVideoClock, type TakeClock } from '../../../../shared/recording-takes'

/** A picture file on the clock: media time `offsetMs` (default 0) at `startMs`; its first frame held from `shownFromMs` when given. */
export type PlayerClip = { url: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }
/** A voice file on the clock: media time `offsetMs` at `startMs`, played until `endMs`. */
export type VoicePiece = { url: string; startMs: number; endMs: number; offsetMs: number }
/**
 * `voice`: one voice file on the whole clock; `voices`, when given, replaces it with pieces (a Run with a new
 * take of a slide: its own voice around the take, the take's voice in it).
 */
export type PlayerSource = { voice: string | null; voices?: VoicePiece[]; slides: PlayerClip[]; camera: PlayerClip[] }
/**
 * `seekRun` / `runMs` speak Run time; `seekVideo` / `videoMs` the video clock (the same unless a slide plays
 * a new take: see recording-takes.ts). The spans, faces and source are on the video clock.
 */
export type LayeredPlayerHandle = { play: () => void; pause: () => void; toggle: () => void; seekRun: (ms: number) => void; runMs: () => number; seekVideo: (ms: number) => void; videoMs: () => number; playing: () => boolean }

const SEEK_DRIFT_MS = 250, NUDGE_DRIFT_MS = 25, SETTLE_MS = 600

export const LayeredPlayer = forwardRef<LayeredPlayerHandle, {
  source: PlayerSource
  spans: KeptSpan[]
  durationMs: number
  camera: boolean
  /** Smooth joins: the picture fades through from the last frame before each join, as the export dissolves. */
  dissolve?: boolean
  /** Where the face appears over the Run (faceTrack); absent: 0.44's corner throughout. */
  faces?: FaceSegment[]
  notice?: string | null
  /** Takes on the video clock (Record this slide again); absent: none. */
  clock?: TakeClock
  /** Run time, and the video clock's time. */
  onTime: (runMs: number, videoMs: number) => void
  onPlaying: (playing: boolean) => void
}>(function LayeredPlayer({ source, spans, durationMs, camera, dissolve = false, faces, clock = NO_TAKES, notice, onTime, onPlaying }, ref) {
  const clockRef = useRef(clock); clockRef.current = clock
  const rootRef = useRef<HTMLDivElement>(null)
  // The voice: one element per piece; the active one is the piece the clock is in.
  const audioEls = useRef<Array<HTMLAudioElement | null>>([])
  const activeVoice = useRef(0)
  const audioRef = useMemo(() => ({ get current(): HTMLAudioElement | null { return audioEls.current[activeVoice.current] ?? null } }), [])
  const pieces = useMemo<VoicePiece[]>(() => source.voices ?? (source.voice ? [{ url: source.voice, startMs: 0, endMs: Infinity, offsetMs: 0 }] : []), [source.voices, source.voice])
  const piecesRef = useRef(pieces); piecesRef.current = pieces
  const pieceAt = (t: number): number => { const list = piecesRef.current; const i = list.findIndex((p) => t >= p.startMs && t < p.endMs); return i >= 0 ? i : list.findIndex((p) => t < p.startMs) }
  /** Make the piece at `t` the active voice, at the right moment of its file; the others pause. */
  const selectVoice = (t: number): HTMLAudioElement | null => {
    const i = pieceAt(t)
    audioEls.current.forEach((el, k) => { if (el && k !== i && !el.paused) el.pause() })
    activeVoice.current = Math.max(0, i)
    const p = piecesRef.current[i], el = audioEls.current[i]
    if (!p || !el) return null
    el.currentTime = Math.max(0, t - p.startMs + p.offsetMs) / 1000
    return el
  }
  const voiceKey = pieces.map((p) => `${p.url}@${p.startMs}`).join('|')
  const slideRefs = useRef<Array<HTMLVideoElement | null>>([])
  const cameraRefs = useRef<Array<HTMLVideoElement | null>>([])
  const fadeRef = useRef<HTMLCanvasElement>(null)
  const dissolveRef = useRef(dissolve); dissolveRef.current = dissolve
  /**
   * A still of the picture as it is now, laid over the frame and faded out over the dissolve's length, so
   * the next kept moment comes in through it. The export averages the last frames; to the eye the same.
   */
  const fadeFromHere = useCallback((): void => {
    const c = fadeRef.current, frame = c?.parentElement
    if (!c || !frame) return
    const box = frame.getBoundingClientRect(), scale = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.round(box.width * scale)); c.height = Math.max(1, Math.round(box.height * scale))
    const g = c.getContext('2d')
    if (!g) return
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height)
    for (const v of [...slideRefs.current, ...cameraRefs.current]) {
      if (!v || v.style.visibility === 'hidden' || v.style.display === 'none' || v.readyState < 2 || !v.videoWidth) continue
      const r = v.getBoundingClientRect()
      const x = (r.left - box.left) * scale, y = (r.top - box.top) * scale, w = r.width * scale, h = r.height * scale
      const cover = getComputedStyle(v).objectFit === 'cover'
      const k = cover ? Math.max(w / v.videoWidth, h / v.videoHeight) : Math.min(w / v.videoWidth, h / v.videoHeight)
      const dw = v.videoWidth * k, dh = v.videoHeight * k
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip()
      try { g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh) } catch { /* a frame not ready: black */ }
      g.restore()
    }
    c.style.transition = 'none'; c.style.opacity = '1'
    void c.offsetWidth
    c.style.transition = `opacity ${Math.round(((JOIN_DISSOLVE_FRAMES - 1) * 1000) / VIDEO_FRAME.fps)}ms linear`
    c.style.opacity = '0'
  }, [])
  const [voiceFailed, setVoiceFailed] = useState(false)
  const state = useRef({ playing: false, runMs: spans[0]?.startMs ?? 0, wallStart: 0, wallRun: 0, raf: 0, timer: 0 as ReturnType<typeof setInterval> | 0, jumping: false, settleUntil: 0, driftMax: 0, driftSum: 0, driftN: 0 })
  const [shownMs, setShownMs] = useState(state.current.runMs)
  const spansRef = useRef(spans); spansRef.current = spans
  const hasVoice = pieces.length > 0 && !voiceFailed
  useEffect(() => setVoiceFailed(false), [voiceKey])
  // The voice file changed (the evened voice became ready, or Even out the volume was turned off): carry on
  // from the same moment, playing if it was playing.
  const voiceRef = useRef(voiceKey)
  useEffect(() => {
    if (voiceRef.current === voiceKey) return
    voiceRef.current = voiceKey
    const s = state.current
    const t = s.playing ? s.wallRun + (performance.now() - s.wallStart) : s.runMs
    const audio = selectVoice(t)
    if (!audio) return
    if (s.playing) {
      s.wallRun = t; s.wallStart = performance.now()
      void audio.play().catch(() => setVoiceFailed(true))
    }
    // selectVoice reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceKey])

  const now = useCallback((): number => {
    const s = state.current, audio = audioRef.current
    if (!s.playing) return s.runMs
    const piece = piecesRef.current[activeVoice.current]
    if (hasVoice && audio && piece && !s.jumping && !audio.paused) return piece.startMs + audio.currentTime * 1000 - piece.offsetMs
    return s.wallRun + (performance.now() - s.wallStart)
  }, [hasVoice])

  // Where each layer sits at a moment: the face placement of the slide being shown (the export's rectangles).
  const facesRef = useRef(faces); facesRef.current = faces
  const placedKey = useRef('')
  const layoutAt = useCallback((t: number): { slides: boolean; camera: boolean } => {
    const track = facesRef.current
    const face0 = track?.length ? faceAt(track, t) : { layout: 'corner', corner: 'bottom-right', size: 'medium' } as const
    const face = camera && source.camera.length ? face0 : withoutCamera(face0)
    const rects = placementRects(face)
    const key = JSON.stringify(rects)
    if (key !== placedKey.current) {
      placedKey.current = key
      const put = (v: HTMLVideoElement | null, r: typeof rects.slides): void => {
        if (!v || !r) return
        const p = toPercent(r)
        Object.assign(v.style, { left: `${p.left}%`, top: `${p.top}%`, width: `${p.width}%`, height: `${p.height}%` })
      }
      for (const v of slideRefs.current) put(v, rects.slides)
      for (const v of cameraRefs.current) put(v, rects.camera)
      const root = rootRef.current
      if (root) root.dataset.face = `${face.layout}${face.layout === 'corner' ? `:${face.corner}:${face.size}` : ''}`
    }
    return { slides: !!rects.slides, camera: !!rects.camera }
  }, [camera, source.camera.length])

  /** Put every picture file where Run time `t` says, and hide the ones not recording at `t`. */
  const placePictures = useCallback((t: number, playing: boolean, force: boolean): void => {
    const s = state.current
    const shown = layoutAt(t)
    const measure = playing && !force && performance.now() > s.settleUntil
    const follow = (layer: 'slides' | 'camera', videos: Array<HTMLVideoElement | null>, clips: PlayerClip[], visible: boolean): void => {
      clips.forEach((clip, i) => {
        const v = videos[i]
        if (!v) return
        const active = visible && t >= (clip.shownFromMs ?? shownFrom({ layer, startMs: clip.startMs }, i === 0)) && t < clip.endMs
        v.style.visibility = active ? 'visible' : 'hidden'
        if (!active) { if (!v.paused) v.pause(); return }
        // Before the file starts (a held first frame) the wanted time is negative: hold at 0.
        const off = (clip.offsetMs ?? 0) / 1000
        const want = Math.max(off, off + (t - clip.startMs) / 1000)
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
    follow('slides', slideRefs.current, source.slides, shown.slides)
    follow('camera', cameraRefs.current, source.camera, camera && shown.camera)
  }, [source.slides, source.camera, camera, layoutAt])

  const report = useCallback((t: number): void => {
    setShownMs(t)
    onTime(fromVideoClock(clockRef.current, t), t)
    const root = rootRef.current, s = state.current
    if (root) {
      root.dataset.runMs = String(Math.round(t))
      if (s.driftN) { root.dataset.driftMaxMs = s.driftMax.toFixed(1); root.dataset.driftMeanMs = (s.driftSum / s.driftN).toFixed(1); root.dataset.driftSamples = String(s.driftN) }
    }
  }, [onTime])

  const seekAll = useCallback((t: number): void => {
    const s = state.current
    s.runMs = t; s.wallRun = t; s.wallStart = performance.now(); s.settleUntil = performance.now() + SETTLE_MS
    if (hasVoice) selectVoice(t)
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
    // Into the next voice piece (a new take starts or ends inside the kept time): that file from its moment.
    const want = hasVoice ? pieceAt(t) : -1
    if (want >= 0 && want !== activeVoice.current && t < span.endMs - 2) {
      s.jumping = true
      const next = selectVoice(t)
      if (next) { next.volume = volumeAt(span, t); void next.play().catch(() => setVoiceFailed(true)) }
      const at = t
      const resume = (): void => { s.jumping = false; s.wallRun = at; s.wallStart = performance.now() }
      if (next && next.seeking) next.addEventListener('seeked', resume, { once: true }); else resume()
      return
    }
    if (t >= span.endMs - 2) {
      const next = spansRef.current[spansRef.current.indexOf(span) + 1]
      if (audio) audio.volume = 0
      if (!next) { halt(); s.runMs = span.endMs; seekAll(span.endMs); onPlaying(false); return }
      // The join: silent, every layer to the next kept moment, sound back once the voice is there.
      if (dissolveRef.current) fadeFromHere()
      s.jumping = true
      seekAll(next.startMs)
      // The next kept moment may be in another voice piece: that one plays now.
      const voice = audioRef.current
      if (voice && hasVoice && voice.paused) { voice.volume = 0; void voice.play().catch(() => setVoiceFailed(true)) }
      const resume = (): void => { s.jumping = false; s.wallRun = next.startMs; s.wallStart = performance.now() }
      if (voice && hasVoice && voice.seeking) voice.addEventListener('seeked', resume, { once: true }); else resume()
      return
    }
    if (audio) audio.volume = volumeAt(span, t)
  }, [now, halt, seekAll, onPlaying, hasVoice, durationMs, fadeFromHere])

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

  const seekVideoMs = useCallback((ms: number): void => {
    // A moment inside a cut shows what the export shows there: the next kept moment.
    const span = spanFor(spansRef.current, ms)
    seekAll(Math.max(0, Math.min(durationMs, span && ms < span.startMs ? span.startMs : ms)))
  }, [seekAll, durationMs])
  useImperativeHandle(ref, () => ({
    play, pause: stop,
    toggle: () => (state.current.playing ? stop() : play()),
    seekRun: (ms: number) => seekVideoMs(toVideoClock(clockRef.current, ms)),
    runMs: () => fromVideoClock(clockRef.current, now()),
    seekVideo: seekVideoMs,
    videoMs: () => now(),
    playing: () => state.current.playing
  }), [play, stop, seekVideoMs, now])

  // New cuts while paused: stay on a kept moment.
  useEffect(() => {
    const s = state.current
    if (s.playing) return
    const span = spanFor(spans, s.runMs)
    if (span && s.runMs < span.startMs) seekAll(span.startMs)
  }, [spans, seekAll])
  useEffect(() => { placedKey.current = ''; placePictures(state.current.runMs, state.current.playing, true) }, [camera, faces, placePictures])
  useEffect(() => () => halt(), [halt])

  const placed = (): void => placePictures(state.current.runMs, state.current.playing, true)
  return (
    <div className="twrp-player" ref={rootRef} data-run-ms={Math.round(shownMs)} data-camera={camera && source.camera.length ? 'on' : 'off'}>
      <div className="twrp-frame">
        {source.slides.map((clip, i) => (
          <video key={`${clip.url}#${i}`} ref={(el) => { slideRefs.current[i] = el }} className="twrp-slides" src={clip.url} muted playsInline preload="auto" onLoadedMetadata={() => { placedKey.current = ''; placed() }} />
        ))}
        {source.camera.map((clip, i) => (
          <video key={`${clip.url}#${i}`} ref={(el) => { cameraRefs.current[i] = el }} className="twrp-camera" src={clip.url} muted playsInline preload="auto"
            style={{ display: camera ? undefined : 'none' }} onLoadedMetadata={() => { placedKey.current = ''; placed() }} />
        ))}
        <canvas ref={fadeRef} className="twrp-dissolve" aria-hidden="true" />
        {notice || voiceFailed ? <div className="twrp-notice" role="status">{voiceFailed ? 'The voice could not be played. Playing the picture only.' : notice}</div> : null}
      </div>
      {pieces.map((p, i) => <audio key={`${p.url}#${i}`} ref={(el) => { audioEls.current[i] = el }} src={p.url} preload="auto" onError={() => setVoiceFailed(true)} />)}
    </div>
  )
})
