// Record one slide again (docs/design/2026-11-10-record-and-edit-video, contract "retake"). The new take
// is recorded in a presenter view of its own (main opens it at the slide, with a banner) and saved as a Run
// that names this one; here the takes of a slide are listed and one is chosen. The chosen take plays where
// the slide starts, in the player and the export; the first take is kept and can be chosen again.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Circle, Pause, Play } from 'lucide-react'
import type { TakeInfo } from '../../../../main/recording-video-ipc'
import type { ChosenTake } from '../../../../shared/recording-edits'
import { shownFrom } from '../../../../shared/recording-video'
import { clipsOnVideoClock, toVideoClock, type TakeClock } from '../../../../shared/recording-takes'
import type { PlayerSource, VoicePiece } from './LayeredPlayer'

type Ref = { talkSlug: string; runId: string; home: string | null | undefined }

// As the editor shows lengths (whole seconds, rounded down).
const clock = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** The takes chosen in the edits that exist, with their lengths, as the plan takes them. */
export function chosenTakes(chosen: readonly ChosenTake[], takes: readonly TakeInfo[]): Array<{ change: number; run: string; durationMs: number; words: TakeInfo['words'] }> {
  return chosen.flatMap((t) => { const found = takes.find((x) => x.run === t.run && x.change === t.change); return found && found.media === 'ok' ? [{ change: t.change, run: t.run, durationMs: found.durationMs, words: found.words }] : [] })
}

/** Chosen takes that cannot be played (as main decides before an export): the take's Run is gone, or some of its files are. */
export function unavailableTakes(chosen: readonly ChosenTake[], takes: readonly TakeInfo[]): Array<{ change: number; run: string; reason: 'gone' | 'media' }> {
  return chosen.flatMap<{ change: number; run: string; reason: 'gone' | 'media' }>((t) => { const found = takes.find((x) => x.run === t.run && x.change === t.change); return !found ? [{ ...t, reason: 'gone' as const }] : found.media !== 'ok' ? [{ ...t, reason: 'media' as const }] : [] })
}

/** What the player says while a chosen take cannot be played: it is playing the first take there. */
export function missingTakeNotice(missing: ReadonlyArray<{ reason: 'gone' | 'media' }>): string | null {
  if (!missing.length) return null
  return missing.length === 1
    ? 'A new take chosen for a slide is missing, so the player plays the first take there. The video cannot be exported until you choose the first take or put the take back.'
    : `${missing.length} new takes chosen for slides are missing, so the player plays the first takes there. The video cannot be exported until you choose the first takes or put the takes back.`
}

/** The words for a slide whose chosen take cannot be played. */
export function missingTakeText(reason: 'gone' | 'media'): string {
  return reason === 'gone'
    ? 'The new take chosen for this slide cannot be found: its recording was removed. The video cannot be exported until you choose the first take or put the take back.'
    : 'Some files of the new take chosen for this slide are missing. The video cannot be exported until you choose the first take or put the files back.'
}

/** The takes of a Run, read when it opens and again whenever the window comes back to the front (after recording one). */
export function useTakes(ref: Ref, initial: readonly TakeInfo[] | undefined, enabled = true): TakeInfo[] {
  const [takes, setTakes] = useState<TakeInfo[]>(() => [...(initial ?? [])])
  useEffect(() => { setTakes([...(initial ?? [])]) }, [initial])
  useEffect(() => {
    // Record one slide again off (takesEnabled): nothing to read again.
    if (!enabled) return
    const read = (): void => { void window.tw.recordingVideo?.takes?.(ref).then((r) => { if (r.ok) setTakes((cur) => (JSON.stringify(cur) === JSON.stringify(r.takes) ? cur : r.takes)) }).catch(() => {}) }
    window.addEventListener('focus', read)
    // A take's words are written out after it is saved: read the takes again when any transcription reports.
    const off = window.tw.transcript?.onProgress?.(() => read())
    return () => { window.removeEventListener('focus', read); off?.() }
  }, [ref, enabled])
  return takes
}

/**
 * The player's source on the video clock: the Run's files split where each chosen take goes in, the take's
 * files there, and the voice in pieces. Each take's playback copies (and its evened voice, when on) are
 * made by main like the Run's own. Until they are ready, `pending` is true and the Run's source is returned.
 */
export function useTakeSource(ref: Ref, base: PlayerSource | null, takeClock: TakeClock, durationMs: number, even: boolean): { source: PlayerSource | null; pending: boolean; problem: string | null } {
  const [ready, setReady] = useState<Record<string, PlayerSource>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const runs = takeClock.inserts.map((i) => i.run)
  const key = `${runs.join(',')}|${even}`
  useEffect(() => {
    let alive = true
    for (const run of runs) {
      const k = `${run}|${even}`
      if (ready[k]) continue
      const takeRef = { talkSlug: ref.talkSlug, runId: run, home: ref.home }
      void window.tw.recordingVideo.prepare(takeRef).then(async (p) => {
        if (!alive) return
        // A take whose files cannot be prepared is said, never played as silence or a black picture.
        if (!p.ok) { setProblem(`The new take could not be prepared for playback: ${p.error}`); return }
        if (p.unreadable.length) { setProblem(`Some files of the new take could not be read (${p.unreadable.map((u) => u.file).join(', ')}).`); return }
        let voice = p.voice
        if (even && voice && window.tw.recordingVideo.prepareEven) { const e = await window.tw.recordingVideo.prepareEven(takeRef).catch(() => null); if (e && e.ok && e.voice) voice = e.voice }
        if (alive) setReady((cur) => ({ ...cur, [k]: { voice, slides: p.slides, camera: p.camera } }))
      }).catch(() => {})
    }
    return () => { alive = false }
    // `ready` is read to skip what is made; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ref])
  return useMemo(() => {
    if (!base || !takeClock.inserts.length) return { source: base, pending: false, problem: null }
    const takes = new Map(runs.map((run) => [run, ready[`${run}|${even}`]]))
    if ([...takes.values()].some((t) => !t)) return { source: base, pending: !problem, problem }
    const hold = (layer: 'slides' | 'camera') => (c: { startMs: number }, first: boolean): number => shownFrom({ layer, startMs: c.startMs }, first)
    const slides = clipsOnVideoClock(takeClock, base.slides, (run) => takes.get(run)?.slides ?? [], hold('slides'))
    const camera = clipsOnVideoClock(takeClock, base.camera, (run) => takes.get(run)?.camera ?? [], hold('camera'))
    const voices: VoicePiece[] = []
    if (base.voice) {
      const moved = (a: number): number => takeClock.inserts.reduce((n, i) => n + (i.at <= a ? i.length : 0), 0)
      const points = [0, ...takeClock.inserts.map((i) => i.at), durationMs]
      for (let k = 0; k + 1 < points.length; k++) if (points[k + 1] > points[k]) voices.push({ url: base.voice, startMs: points[k] + moved(points[k]), endMs: points[k + 1] + moved(points[k]), offsetMs: points[k] })
    }
    for (const i of takeClock.inserts) { const v = takes.get(i.run)?.voice; const at = toVideoClock(takeClock, i.at); if (v) voices.push({ url: v, startMs: at, endMs: at + i.length, offsetMs: 0 }) }
    voices.sort((a, b) => a.startMs - b.startMs)
    return { source: { voice: base.voice, voices, slides, camera }, pending: false, problem: null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, takeClock, ready, durationMs, even, problem])
}

/** Sound only, for a take that is not in the video: its voice (a new take's own copy, or the slide's stretch of the Run's). */
function useTakeListen(ref: Ref, first: { url: string; from: number; to: number } | null): { playing: string | null; toggle: (run: string | null) => void } {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => () => { audio.current?.pause() }, [])
  const toggle = (run: string | null): void => {
    const key = run ?? 'first'
    if (playing === key) { audio.current?.pause(); setPlaying(null); return }
    audio.current?.pause()
    setPlaying(key)
    const source = run ? window.tw.recordingVideo.prepare({ talkSlug: ref.talkSlug, runId: run, home: ref.home }).then((p) => (p.ok && p.voice ? { url: p.voice, from: 0, to: Infinity } : null)) : Promise.resolve(first)
    void source.then((v) => {
      if (!v) { setPlaying(null); return }
      const a = new Audio(v.url)
      audio.current = a
      a.currentTime = v.from / 1000
      a.ontimeupdate = () => { if (a.currentTime * 1000 >= v.to) { a.pause(); setPlaying(null) } }
      a.onended = () => setPlaying(null)
      void a.play().catch(() => setPlaying(null))
    }).catch(() => setPlaying(null))
  }
  return { playing, toggle }
}

/**
 * The takes of one slide, under its words: "Which take of slide 3?" with Play for each, the one in the
 * video marked, and Use for the others. `firstMs`: the slide's own length in the recording.
 */
export function TakesPanel({ runRef, slideN, firstMs, firstVoice, takes, chosen, disabled, onPlayInVideo, onChoose }: {
  runRef: Ref
  slideN: number
  firstMs: number
  /** The slide's stretch of the Run's voice, to hear the first take when it is not in the video. */
  firstVoice: { url: string; from: number; to: number } | null
  takes: TakeInfo[]
  chosen: string | null
  disabled: boolean
  /** Play the slide as it is in the video now. */
  onPlayInVideo: () => void
  onChoose: (run: string | null) => void
}): ReactNode {
  const listen = useTakeListen(runRef, firstVoice)
  const rows: Array<{ run: string | null; name: string; ms: number }> = [
    ...takes.map((t, i) => ({ run: t.run, name: takes.length === 1 ? 'New take' : `New take ${i + 1}`, ms: t.durationMs })).reverse(),
    { run: null, name: 'First take', ms: firstMs }
  ]
  return (
    <div className="tre-takes" role="group" aria-label={`Takes of slide ${slideN}`}>
      <div className="tre-takes-h">Which take of slide {slideN}?</div>
      {rows.map((r) => {
        const inVideo = (r.run ?? null) === chosen
        return (
          <div key={r.run ?? 'first'} className={`tre-take${inVideo ? ' on' : ''}`} data-take={r.run ?? 'first'}>
            {inVideo ? <Circle className="lt-icon tre-take-dot" aria-hidden="true" /> : <span className="tre-take-dot" />}
            <span className="tre-take-name">{r.name} · {clock(r.ms)}</span>
            {inVideo ? <span className="tre-take-in">In the video</span> : null}
            <span className="tre-sp" />
            <button className="tw-btn tw-btn--sm" onClick={() => (inVideo ? onPlayInVideo() : listen.toggle(r.run))} aria-label={`Play ${r.name.toLowerCase()} of slide ${slideN}`}>
              {!inVideo && listen.playing === (r.run ?? 'first') ? <><Pause className="lt-icon" /> Stop</> : <><Play className="lt-icon" /> Play</>}
            </button>
            {!inVideo ? <button className="tw-btn tw-btn--sm" disabled={disabled} onClick={() => onChoose(r.run)}>{r.run ? 'Use this take' : 'Use the first take'}</button> : null}
          </div>
        )
      })}
      <div className="tre-takes-note">Every take is kept. You can switch back at any time.</div>
    </div>
  )
}
