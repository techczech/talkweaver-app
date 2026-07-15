// TalkWeaver Studio — the recordings player (ADR-0035, Phase 1, built to
// docs/design/2026-07-05-recording/direction-1-studio-timeline.html). A full-window Light Table
// surface: a session rail, a slide-time-marker timeline over a real waveform, and the current
// slide (rendered by ledger id from the talk's CURRENT outline). Playback is a real <audio>
// element served the local file over twrec://. Upload to R2 is on request, per session.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, BarChart3, Check, FileText, HardDrive, Loader2, Pause, Play, Radio, RefreshCw,
  RotateCcw, Scissors, Search, Settings, SkipBack, SkipForward, Trash2, UploadCloud, X
} from 'lucide-react'
import type { RecordingSession, Transcript, TranscriptSegment, TrimRange } from '../../../preload/index'
import '../studio.css'

type Session = RecordingSession & { audio: NonNullable<RecordingSession['audio']> }
type SlideInfo = { title: string; section: string; thumbUrl: string | null; n: number; tag: string }
type SlideTimeMark = RecordingSession['slideTimeIndex'][number]
type ReplayState = { slideId: string; hiddenCount: number; highlights: Array<{ block: number; start: number; end: number }> }

const fmt = (sec: number): string => {
  sec = Math.max(0, Math.round(sec))
  const m = Math.floor(sec / 60)
  return String(m).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0')
}
const mins = (sec: number): number => Math.round(sec / 60)
function deltaOf(recSec: number, planMin: number): { cls: string; text: string } | null {
  if (!planMin) return null
  const d = recSec - planMin * 60
  const dm = Math.round(Math.abs(d) / 60)
  if (Math.abs(d) < 45) return { cls: 'onpar', text: 'on par' }
  return d > 0 ? { cls: 'over', text: `+${dm}m over` } : { cls: 'under', text: `−${dm}m under` }
}
function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const day = d.getDate()
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${day} ${mon} ${d.getFullYear()} · ${hh}:${mm}`
}

function trimMs(trims: TrimRange[] | undefined, totalMs: number): number {
  if (!trims?.length) return 0
  return trims.reduce((sum, trim) => {
    const start = Math.max(0, Math.min(totalMs, trim.start))
    const end = Math.max(0, Math.min(totalMs, trim.end))
    return end > start ? sum + end - start : sum
  }, 0)
}

function effectiveMsAt(rawMs: number, trims: TrimRange[] | undefined): number {
  if (!trims?.length) return Math.max(0, rawMs)
  let skipped = 0
  for (const trim of trims) {
    if (rawMs <= trim.start) break
    skipped += Math.max(0, Math.min(rawMs, trim.end) - trim.start)
  }
  return Math.max(0, rawMs - skipped)
}

function coveringTrim(seg: TranscriptSegment, trims: TrimRange[] | undefined): TrimRange | null {
  return trims?.find((trim) => trim.start <= seg.start + 1 && trim.end >= seg.end - 1) ?? null
}

function isTrimmed(seg: TranscriptSegment, trims: TrimRange[] | undefined): boolean {
  return !!trims?.some((trim) => trim.start < seg.end && trim.end > seg.start)
}

function withoutTrim(trims: TrimRange[] | undefined, target: TrimRange): TrimRange[] {
  return (trims ?? []).filter((trim) => trim.start !== target.start || trim.end !== target.end)
}

function segmentIndexAtMs(segments: TranscriptSegment[], tMs: number): number {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (tMs >= seg.start && tMs < seg.end) return i
  }
  return -1
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75]

function replayStateAt(session: Session | null, tMs: number): ReplayState | null {
  if (!session) return null
  let enter: SlideTimeMark | null = null
  for (const mark of session.slideTimeIndex) {
    if (mark.tMs > tMs + 1) continue
    if (mark.event === 'enter' && mark.slideId) enter = mark
  }
  if (!enter?.slideId) return null
  const since = enter.tMs ?? 0
  let hiddenCount = 0
  let highlights: ReplayState['highlights'] = []
  for (const mark of session.slideTimeIndex) {
    if (mark.tMs < since || mark.tMs > tMs + 1 || mark.slideId !== enter.slideId) continue
    if (mark.event === 'reveal') hiddenCount = Math.max(0, Number(mark.hidden) || 0)
    if (mark.event === 'highlight') highlights = Array.isArray(mark.ranges) ? mark.ranges : []
  }
  return { slideId: enter.slideId, hiddenCount, highlights }
}

export default function Studio({
  isOpen,
  onClose,
  initialSessionId,
  onShowHistory
}: {
  isOpen: boolean
  onClose: () => void
  initialSessionId?: string | null
  onShowHistory?: () => void
}): JSX.Element | null {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'length'>('newest')
  const [slideMap, setSlideMap] = useState<Record<string, SlideInfo>>({})
  const [wave, setWave] = useState<number[] | null>(null)
  const [waveLoading, setWaveLoading] = useState(false)
  const [progress, setProgress] = useState(0) // 0..1
  const [playing, setPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(0)
  const [sheet, setSheet] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [replayUrl, setReplayUrl] = useState<string | null>(null)
  const [replayReady, setReplayReady] = useState(false)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [transcriptBusy, setTranscriptBusy] = useState(false)
  const [transcriptNote, setTranscriptNote] = useState<string | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptHover, setTranscriptHover] = useState(false)
  const [rangeAnchorIdx, setRangeAnchorIdx] = useState<number | null>(null)
  const [activeSegmentIdx, setActiveSegmentIdx] = useState<number | null>(null)

  const audioRef = useRef<HTMLAudioElement>(null)
  const replayRef = useRef<HTMLIFrameElement>(null)
  const lastReplayKey = useRef('')
  const searchRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const transcriptBodyRef = useRef<HTMLDivElement>(null)
  const segmentRefs = useRef<Record<number, HTMLDivElement | null>>({})

  const flash = useCallback((msg: string): void => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  const reload = useCallback(async (): Promise<Session[]> => {
    const all = (await window.tw.recording.listAllSessions()).filter(
      // Studio plays & manages RECORDINGS, so it shows only sessions that actually have audio. Use a
      // loose null check: an audio-less Run (a delivery/rehearsal saved without a recording) stores
      // audio as null OR omits it entirely — `!== null` let `undefined` through and then `s.audio.uploaded`
      // threw, blanking the whole window. `!= null` excludes both. (Audio-less runs live in History.)
      // Also drop malformed/partial sessions (missing id/startedAt) — the rail keys + seeds avatars off
      // them, so one bad session.json would otherwise crash the window.
      (s): s is Session =>
        s != null && typeof s.id === 'string' && typeof s.startedAt === 'string' && s.audio != null
    )
    setSessions(all)
    return all
  }, [])

  // Load sessions whenever Studio opens.
  useEffect(() => {
    if (!isOpen) return
    void reload().then((all) => {
      setActiveId((cur) => {
        if (initialSessionId && all.some((s) => s.id === initialSessionId)) return initialSessionId
        return cur ?? all[0]?.id ?? null
      })
    })
  }, [isOpen, reload, initialSessionId])

  useEffect(() => {
    if (!isOpen || !initialSessionId) return
    setActiveId(initialSessionId)
  }, [isOpen, initialSessionId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = sessions
    if (q) {
      list = list.filter(
        (s) =>
          s.talkTitle.toLowerCase().includes(q) ||
          (s.context ?? '').toLowerCase().includes(q) ||
          fmtDate(s.startedAt).toLowerCase().includes(q)
      )
    }
    const arr = [...list]
    arr.sort((a, b) =>
      sort === 'length' ? b.recordingMs - a.recordingMs : b.startedAt.localeCompare(a.startedAt)
    )
    return arr
  }, [sessions, query, sort])

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId])
  const activeTrims = active?.trims ?? []
  const enters = useMemo(
    () => (active ? active.slideTimeIndex.filter((m) => m.event === 'enter') : []),
    [active]
  )
  const totalSec = active ? active.recordingMs / 1000 : 0
  const curTimeMs = progress * totalSec * 1000
  const trimmedMs = active ? trimMs(active.trims, active.recordingMs) : 0
  const effectiveTotalSec = active ? Math.max(0, active.recordingMs - trimmedMs) / 1000 : 0
  const effectiveCurSec = effectiveMsAt(curTimeMs, activeTrims) / 1000
  const hasTrims = activeTrims.length > 0
  const curEnterIdx = useMemo(() => {
    let idx = -1
    for (let i = 0; i < enters.length; i++) if (enters[i].tMs <= curTimeMs + 1) idx = i
    return idx
  }, [enters, curTimeMs])
  const curSlide: SlideInfo | null =
    curEnterIdx >= 0 && enters[curEnterIdx]?.slideId ? slideMap[enters[curEnterIdx].slideId as string] ?? null : null
  const talkSlideCount = useMemo(() => Object.keys(slideMap).length, [slideMap])
  const replayState = useMemo(() => replayStateAt(active, curTimeMs), [active, curTimeMs])
  const transcriptSegments = transcript?.segments ?? []
  const curSegmentIdx = useMemo(() => segmentIndexAtMs(transcriptSegments, curTimeMs), [transcriptSegments, curTimeMs])
  const keyboardSegmentIdx = activeSegmentIdx ?? curSegmentIdx

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // When the active session changes: point the <audio> at its local file, reset the playhead,
  // resolve the talk's slides (title + thumbnail by ledger id), and decode a real waveform.
  useEffect(() => {
    if (!active) {
      setReplayUrl(null)
      setReplayReady(false)
      setReplayError(null)
      lastReplayKey.current = ''
      return
    }
    setProgress(0)
    setPlaying(false)
    setRangeAnchorIdx(null)
    setActiveSegmentIdx(null)
    setConfirmDelete(false)
    setReplayUrl(null)
    setReplayReady(false)
    setReplayError(null)
    lastReplayKey.current = ''
    const a = audioRef.current
    if (a) {
      a.src = `twrec://${active.id}`
      a.playbackRate = SPEEDS[speedIdx]
      a.load()
    }
    let cancelled = false

    void (async () => {
      try {
        const res = await window.tw.replay.build(active.talkSlug)
        if (cancelled) return
        if (res.success && res.url) setReplayUrl(res.url)
        else setReplayError(res.error || 'Replay unavailable')
      } catch (e) {
        if (!cancelled) setReplayError(String(e))
      }
    })()

    // slides by ledger id, from the CURRENT outline
    void (async () => {
      setSlideMap({})
      try {
        const talks = await window.tw.vault.listTalks()
        const info = talks.find((t) => t.slug === active.talkSlug)
        if (!info) return
        const content = await window.tw.talk.readOutline(info.outlinePath)
        if (content == null) return
        const [rows, thumbs] = await Promise.all([
          window.tw.talk.compile(info.outlinePath, content),
          window.tw.talk.thumbnails(info.outlinePath, content)
        ])
        if (cancelled || !rows) return
        const map: Record<string, SlideInfo> = {}
        rows.forEach((r, i) => {
          const key = r.render_hash || r.content_hash || r.slide_id
          map[r.slide_id] = {
            title: r.nav_title || r.title || '(untitled)',
            section: r.section || '',
            thumbUrl: thumbs && key ? thumbs[key] ?? null : null,
            n: i + 1,
            tag: r.layout || ''
          }
        })
        if (!cancelled) setSlideMap(map)
      } catch {
        /* leave slideMap empty — markers show the id */
      }
    })()

    // real waveform (RMS per bucket), decoded off the local file
    void (async () => {
      setWave(null)
      setWaveLoading(true)
      try {
        const resp = await fetch(`twrec://${active.id}`)
        const buf = await resp.arrayBuffer()
        const Ctor: typeof AudioContext =
          (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
            .AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ac = new Ctor()
        const decoded = await ac.decodeAudioData(buf)
        void ac.close()
        if (cancelled) return
        const ch = decoded.getChannelData(0)
        const N = 190
        const block = Math.max(1, Math.floor(ch.length / N))
        const bars: number[] = []
        let max = 0.0001
        for (let i = 0; i < N; i++) {
          let sum = 0
          for (let j = 0; j < block; j++) {
            const v = ch[i * block + j] || 0
            sum += v * v
          }
          const rms = Math.sqrt(sum / block)
          bars.push(rms)
          if (rms > max) max = rms
        }
        if (!cancelled) setWave(bars.map((b) => Math.max(0.05, Math.min(1, b / max))))
      } catch {
        // decode failed (rare) — a flat baseline keeps the timeline usable
        if (!cancelled) setWave(new Array(190).fill(0.12))
      } finally {
        if (!cancelled) setWaveLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active, speedIdx])

  useEffect(() => {
    if (!isOpen || !active) {
      setTranscript(null)
      setTranscriptLoading(false)
      setTranscriptBusy(false)
      setTranscriptNote(null)
      setTranscriptError(null)
      return
    }
    let cancelled = false
    setTranscript(null)
    setTranscriptLoading(true)
    setTranscriptNote(null)
    setTranscriptError(null)
    segmentRefs.current = {}
    setActiveSegmentIdx(null)

    void (async () => {
      try {
        const existing = await window.tw.transcript.get(active.talkSlug, active.id)
        if (!cancelled) setTranscript(existing)
      } catch {
        if (!cancelled) setTranscriptError('Could not read the saved transcript. The recording is still safe.')
      } finally {
        if (!cancelled) setTranscriptLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isOpen, active])

  useEffect(() => {
    if (!isOpen) return
    return window.tw.transcript.onProgress((event) => {
      if (event.sessionId === activeIdRef.current) setTranscriptNote(event.note)
    })
  }, [isOpen])

  useEffect(() => {
    if (curSegmentIdx >= 0 && (playing || activeSegmentIdx === null)) setActiveSegmentIdx(curSegmentIdx)
  }, [curSegmentIdx, playing, activeSegmentIdx])

  useEffect(() => {
    if (activeSegmentIdx !== null && activeSegmentIdx >= transcriptSegments.length) setActiveSegmentIdx(null)
  }, [activeSegmentIdx, transcriptSegments.length])

  useEffect(() => {
    const scrollIdx = activeSegmentIdx ?? curSegmentIdx
    if (transcriptHover || scrollIdx < 0) return
    segmentRefs.current[scrollIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeSegmentIdx, curSegmentIdx, transcriptHover])

  useEffect(() => {
    if (!isOpen) return
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== replayRef.current?.contentWindow) return
      if (event.data?.type !== 'tw-replay-ready') return
      lastReplayKey.current = ''
      setReplayReady(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [isOpen])

  useEffect(() => {
    if (!replayReady || !replayState || !curSlide) return
    const target = replayRef.current?.contentWindow
    if (!target) return
    const payload = {
      type: 'tw-replay-state',
      slideId: replayState.slideId,
      hiddenCount: replayState.hiddenCount,
      highlights: replayState.highlights
    }
    const key = JSON.stringify(payload)
    if (key === lastReplayKey.current) return
    lastReplayKey.current = key
    target.postMessage(payload, '*')
  }, [replayReady, replayState, curSlide])

  // playback controls
  const seekToSec = useCallback(
    (sec: number): void => {
      const a = audioRef.current
      if (!a || !totalSec) return
      a.currentTime = Math.max(0, Math.min(totalSec, sec))
      setProgress(a.currentTime / totalSec)
    },
    [totalSec]
  )
  const togglePlay = useCallback((): void => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      if (progress >= 0.999) seekToSec(0)
      void a.play()
    } else a.pause()
  }, [progress, seekToSec])
  const stepSlide = useCallback(
    (dir: number): void => {
      if (!enters.length) return
      const next = Math.max(0, Math.min(enters.length - 1, (curEnterIdx < 0 ? 0 : curEnterIdx) + dir))
      seekToSec((enters[next].tMs || 0) / 1000)
    },
    [enters, curEnterIdx, seekToSec]
  )
  const seekToSegment = useCallback(
    (seg: TranscriptSegment): void => {
      seekToSec(seg.start / 1000)
    },
    [seekToSec]
  )
  const stepSegment = useCallback(
    (dir: number): void => {
      if (!transcriptSegments.length) return
      const now = progress * totalSec * 1000
      let target = curSegmentIdx
      if (target >= 0) {
        target += dir
      } else if (dir > 0) {
        target = transcriptSegments.findIndex((seg) => seg.start > now + 1)
        if (target < 0) target = transcriptSegments.length - 1
      } else {
        target = transcriptSegments.length - 1
        for (let i = transcriptSegments.length - 1; i >= 0; i--) {
          if (transcriptSegments[i].start < now - 1) {
            target = i
            break
          }
        }
      }
      target = Math.max(0, Math.min(transcriptSegments.length - 1, target))
      setActiveSegmentIdx(target)
      seekToSegment(transcriptSegments[target])
    },
    [transcriptSegments, progress, totalSec, curSegmentIdx, seekToSegment]
  )
  const cycleSpeed = useCallback((): void => {
    setSpeedIdx((i) => {
      const next = (i + 1) % SPEEDS.length
      if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next]
      return next
    })
  }, [])
  const cycleSession = useCallback(
    (dir: number): void => {
      if (!filtered.length) return
      const cur = filtered.findIndex((s) => s.id === activeId)
      const next = Math.max(0, Math.min(filtered.length - 1, (cur < 0 ? 0 : cur) + dir))
      setActiveId(filtered[next].id)
    },
    [filtered, activeId]
  )

  const doUpload = useCallback(async (): Promise<void> => {
    if (!active || uploadBusy) return
    setUploadBusy(true)
    try {
      const r = await window.tw.recording.upload(active.talkSlug, active.id)
      if (r.ok && r.uploaded) {
        flash('Uploaded to R2')
        await reload()
      } else if (r.error === 'r2-not-configured') {
        flash('Set up R2 first: Settings → Recording storage')
      } else if (r.error === 'r2-no-credentials') {
        flash('Add your R2 access keys in Settings → Recording storage')
      } else {
        flash('Upload failed — the recording is safe on this Mac. Try again.')
      }
    } finally {
      setUploadBusy(false)
    }
  }, [active, uploadBusy, flash, reload])

  const runTranscription = useCallback(async (): Promise<void> => {
    if (!active || transcriptBusy) return
    const sessionId = active.id
    setTranscriptBusy(true)
    setTranscriptError(null)
    setTranscriptNote('Starting transcription…')
    try {
      const res = await window.tw.transcript.run(active.talkSlug, sessionId)
      if (activeIdRef.current !== sessionId) return
      if (!res.ok) {
        const msg = res.error === 'busy'
          ? 'Another transcription is already running.'
          : res.error || 'Transcription failed. The recording is still safe.'
        setTranscriptError(msg)
        setTranscriptNote(null)
        return
      }
      const fresh = await window.tw.transcript.get(active.talkSlug, sessionId)
      if (activeIdRef.current !== sessionId) return
      const next = fresh ?? {
        engine: 'parakeet' as const,
        createdAt: new Date().toISOString(),
        segments: res.segments ?? []
      }
      setTranscript(next)
      setTranscriptNote(`Transcript ready: ${next.segments.length} segments.`)
      setTranscriptError(null)
    } catch {
      if (activeIdRef.current === sessionId) {
        setTranscriptError('Transcription failed. The recording is still safe; try again from this panel.')
        setTranscriptNote(null)
      }
    } finally {
      if (activeIdRef.current === sessionId) setTranscriptBusy(false)
    }
  }, [active, transcriptBusy])

  const saveTrims = useCallback(async (nextTrims: TrimRange[], msg?: string): Promise<void> => {
    if (!active) return
    const res = await window.tw.recording.setTrims(active.talkSlug, active.id, nextTrims)
    if (!res.ok) {
      flash('Trim could not be saved')
      return
    }
    const trims = res.trims ?? []
    setSessions((all) => all.map((s) => s.id === active.id ? { ...s, trims } : s))
    if (msg) flash(msg)
  }, [active, flash])

  const toggleTrimSegment = useCallback(async (seg: TranscriptSegment): Promise<void> => {
    const covered = coveringTrim(seg, activeTrims)
    if (covered) {
      await saveTrims(withoutTrim(activeTrims, covered), 'Segment restored')
      return
    }
    await saveTrims([...activeTrims, { start: seg.start, end: seg.end }], 'Segment trimmed')
  }, [activeTrims, saveTrims])

  const trimSegmentRange = useCallback(async (fromIdx: number, toIdx: number): Promise<void> => {
    if (!transcriptSegments.length) return
    const lo = Math.max(0, Math.min(fromIdx, toIdx))
    const hi = Math.min(transcriptSegments.length - 1, Math.max(fromIdx, toIdx))
    const first = transcriptSegments[lo]
    const last = transcriptSegments[hi]
    await saveTrims([...activeTrims, { start: first.start, end: last.end }], `${hi - lo + 1} segments trimmed`)
  }, [activeTrims, saveTrims, transcriptSegments])

  const handleSegmentClick = useCallback((event: { shiftKey: boolean }, seg: TranscriptSegment, idx: number): void => {
    setActiveSegmentIdx(idx)
    if (event.shiftKey && rangeAnchorIdx !== null) {
      void trimSegmentRange(rangeAnchorIdx, idx)
      return
    }
    setRangeAnchorIdx(idx)
    seekToSegment(seg)
  }, [rangeAnchorIdx, seekToSegment, trimSegmentRange])

  const saveContext = useCallback(
    async (text: string): Promise<void> => {
      if (!active) return
      await window.tw.recording.setContext(active.talkSlug, active.id, text)
      await reload()
    },
    [active, reload]
  )

  const doDelete = useCallback(async (): Promise<void> => {
    if (!active) return
    const wasId = active.id
    await window.tw.recording.deleteSession(active.talkSlug, active.id)
    const all = await reload()
    setActiveId(all.find((s) => s.id !== wasId)?.id ?? null)
    setConfirmDelete(false)
    flash('Recording moved to Trash')
  }, [active, reload, flash])

  const handleTimeUpdate = useCallback((audio: HTMLAudioElement): void => {
    if (!totalSec) return
    const rawMs = audio.currentTime * 1000
    const trim = activeTrims.find((range) => rawMs >= range.start && rawMs < range.end)
    if (trim) {
      audio.currentTime = Math.min(totalSec, trim.end / 1000)
    }
    const nextIdx = segmentIndexAtMs(transcriptSegments, audio.currentTime * 1000)
    if (!audio.paused && nextIdx >= 0) setActiveSegmentIdx(nextIdx)
    setProgress(Math.min(1, audio.currentTime / totalSec))
  }, [activeTrims, totalSec, transcriptSegments])

  // keyboard — full parity with the ? cheat-sheet
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = t && t.matches('input, textarea, [contenteditable="true"]')
      if (e.key === '?') { if (!typing) { e.preventDefault(); setSheet((s) => !s) } return }
      if (e.key === 'Escape') { e.preventDefault(); if (sheet) setSheet(false); else if (settingsOpen) setSettingsOpen(false); else onClose(); return }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') {
        e.preventDefault()
        if (onShowHistory) onShowHistory()
        else window.dispatchEvent(new Event('tw-open-history'))
        return
      }
      if (typing) return
      if (e.key === ' ') { e.preventDefault(); togglePlay() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepSlide(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepSlide(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cycleSession(-1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); cycleSession(1) }
      else if (e.key === ',') { e.preventDefault(); seekToSec(progress * totalSec - 5) }
      else if (e.key === '.') { e.preventDefault(); seekToSec(progress * totalSec + 5) }
      else if (e.key === '[') { e.preventDefault(); stepSegment(-1) }
      else if (e.key === ']') { e.preventDefault(); stepSegment(1) }
      else if (e.key.toLowerCase() === 't' && keyboardSegmentIdx >= 0) { e.preventDefault(); void toggleTrimSegment(transcriptSegments[keyboardSegmentIdx]) }
      else if (e.key === '0') { e.preventDefault(); seekToSec(0) }
      else if (e.key.toLowerCase() === 'u') { void doUpload() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, sheet, settingsOpen, onClose, togglePlay, stepSlide, cycleSession, seekToSec, progress, totalSec, stepSegment, keyboardSegmentIdx, toggleTrimSegment, transcriptSegments, doUpload, onShowHistory])

  if (!isOpen) return null

  const pct = (progress * 100).toFixed(3) + '%'
  const activeEffectiveSec = active ? effectiveTotalSec : 0
  const delta = active ? deltaOf(activeEffectiveSec, active.timerTargetMin) : null

  return (
    <div className="lt twstudio" role="dialog" aria-label="TalkWeaver Studio">
      {/* audio engine (hidden) */}
      <audio
        ref={audioRef}
        preload="auto"
        onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {/* top chrome */}
      <header className="tws-topbar">
        <div className="tws-brand">
          <span className="tws-wordmark">TalkWeaver</span>
          <span className="tws-room">Recording Studio</span>
        </div>
        <nav className="tws-viewtabs" aria-label="Tools mode">
          <button className="active" title="TalkWeaver Studio — review, trim and manage recordings">
            <Radio className="lt-icon" />
            Studio
          </button>
          <button
            title="TalkWeaver History — every talk you have delivered"
            onClick={() => {
              if (onShowHistory) onShowHistory()
              else window.dispatchEvent(new Event('tw-open-history'))
            }}
          >
            <BarChart3 className="lt-icon" />
            History
          </button>
        </nav>
        <div className="tws-top-spacer" />
        <div className="tws-tool tws-iconbtn" style={{ position: 'relative' }}>
          <button
            aria-label="Recording settings"
            title="Recording settings"
            onClick={() => setSettingsOpen((s) => !s)}
            style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
          >
            <Settings className="lt-icon" />
          </button>
          {settingsOpen && (
            <div className="tws-pop" onClick={(e) => e.stopPropagation()}>
              <div className="tws-pop-title">Recording storage</div>
              <div className="tws-pop-sub">Recordings save to this Mac first. Upload to R2 is on request, per recording.</div>
              <div className="tws-pop-foot">
                Endpoint, bucket, keys and the auto-discard threshold live in{' '}
                <span className="tws-link">Settings ⌘,</span> → Recording storage.
              </div>
            </div>
          )}
        </div>
        <button className="tws-tool tws-iconbtn tws-help" aria-label="Keyboard cheat-sheet" title="Keyboard cheat-sheet (?)" onClick={() => setSheet(true)}>?</button>
        <button className="tws-tool tws-iconbtn" aria-label="Close Studio" title="Close (Esc)" onClick={onClose}><X className="lt-icon" /></button>
      </header>

      {/* session rail */}
      <div className="tws-rail">
        <div className="tws-rail-head">
          <span className="tws-r-title">Sessions</span>
          <span className="tws-r-count">{sessions.length ? `${filtered.length} of ${sessions.length}` : 'none yet'}</span>
          <div className="tws-search">
            <Search className="lt-icon" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search recordings by talk, context or date…"
              aria-label="Search recordings"
            />
          </div>
          <div className="tws-seg" role="group" aria-label="Sort">
            <button className={sort === 'newest' ? 'on' : ''} onClick={() => setSort('newest')} title="Most recent first">Newest</button>
            <button className={sort === 'length' ? 'on' : ''} onClick={() => setSort('length')} title="Longest first">Length</button>
          </div>
          <span className="tws-reassure"><Check className="lt-icon" /> Local first — nothing is lost</span>
        </div>

        {sessions.length === 0 ? (
          <div className="tws-empty">
            <div className="tws-e-frame"><FileText className="lt-icon" /></div>
            <div>
              <h3>No recordings yet</h3>
              <p>Press <span className="tws-q">⇧R</span> in the presenter to capture a run. Sessions appear here the moment you stop — saved on this Mac; upload to R2 whenever you choose.</p>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="tws-empty">
            <div className="tws-e-frame"><Search className="lt-icon" /></div>
            <div>
              <h3>No recordings match</h3>
              <p>Nothing matches “{query}”. Clear the search to see all {sessions.length} recordings.</p>
            </div>
          </div>
        ) : (
          <div className="tws-sessions">
            {filtered.map((s) => {
              const rawSec = s.recordingMs / 1000
              const recSec = (s.recordingMs - trimMs(s.trims, s.recordingMs)) / 1000
              const d = deltaOf(recSec, s.timerTargetMin)
              return (
                <button key={s.id} data-sid={s.id} className={`tws-scard ${s.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(s.id)}>
                  <div className="tws-sc-top">
                    <span className="tws-sc-date">{fmtDate(s.startedAt)}</span>
                    <span className={`tws-sc-up ${s.audio.uploaded ? '' : 'local'}`}>
                      {s.audio.uploaded ? <><Check className="lt-icon" /> in R2</> : <><HardDrive className="lt-icon" /> on this Mac</>}
                    </span>
                  </div>
                  <div className="tws-sc-talk">{s.talkTitle}</div>
                  <div className="tws-sc-ctx">{s.context || '—'}</div>
                  <div className="tws-sc-len">
                    <span className="tws-sc-rec">{mins(recSec)}m</span>
                    {s.trims?.length ? <span className="tws-sc-plan">raw {mins(rawSec)}m</span> : null}
                    {s.timerTargetMin ? <span className="tws-sc-plan">planned {s.timerTargetMin}m</span> : null}
                    {d ? <span className={`tws-delta ${d.cls}`}>{d.text}</span> : null}
                  </div>
                  <span className="tws-sc-play"><Play className="lt-icon" /></span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* stage: monitor + transcript seam */}
      <div className="tws-stage">
        <div className="tws-monitor-col">
          <div className="tws-now-head">
            <div className="tws-nh-pos">
              <span>Now showing</span>
              <b>{curSlide ? curSlide.n : '—'}</b>
              <span>/</span>
              <span>{talkSlideCount || '—'}</span>
            </div>
            <span className="tws-nh-from">{curEnterIdx >= 0 ? 'from ' + fmt((enters[curEnterIdx].tMs || 0) / 1000) : ''}</span>
            <span className="tws-nh-sec">{curSlide?.section || ''}</span>
            {curSlide?.tag ? <span className="tws-nh-tag">{curSlide.tag}</span> : null}
          </div>
          <div className="tws-monitor-wrap">
            <div className="tws-monitor-frame">
              <div className="tws-monitor-slide">
                {replayUrl && curSlide && !replayError ? (
                  <iframe
                    ref={replayRef}
                    className={`tws-replay-frame ${replayReady ? 'ready' : ''}`}
                    src={replayUrl}
                    sandbox="allow-scripts"
                    title="Presentation replay"
                  />
                ) : null}
                {(!replayReady || !replayUrl || replayError || !curSlide) ? (
                  <div className="tws-monitor-fallback" title={replayError ?? undefined}>
                    {curSlide?.thumbUrl ? (
                      <img src={curSlide.thumbUrl} alt={curSlide.title} />
                    ) : (
                      <div className="tws-slide-missing">
                        <AlertTriangle className="lt-icon" />
                        <div>{curEnterIdx >= 0 ? 'This slide has changed since recording' : 'Play, or click a marker'}</div>
                        {curEnterIdx >= 0 && enters[curEnterIdx]?.slideId ? (
                          <div className="tws-sid">{enters[curEnterIdx].slideId}</div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <aside className="tws-transcript-seam">
          <div className="tws-ts-head">
            <span className="tws-p-title">Transcript</span>
            {transcript ? (
              <button
                className="tws-ts-retry"
                disabled={transcriptBusy}
                title="Re-transcribe this recording"
                onClick={() => { void runTranscription() }}
              >
                <RefreshCw className={`lt-icon ${transcriptBusy ? 'spin' : ''}`} />
                Re-transcribe
              </button>
            ) : (
              <span className={`tws-p-soon ${transcriptBusy ? 'busy' : ''}`}>
                {transcriptBusy ? 'Running' : transcriptLoading ? 'Checking' : 'Not yet'}
              </span>
            )}
          </div>
          <div
            className={`tws-ts-body ${transcript ? 'has-transcript' : ''}`}
            ref={transcriptBodyRef}
            onMouseEnter={() => setTranscriptHover(true)}
            onMouseLeave={() => setTranscriptHover(false)}
          >
            {transcript && transcriptSegments.length > 0 ? (
              <div className="tws-ts-list" role="list" aria-label="Transcript segments">
                {transcriptSegments.map((seg, i) => {
                  const covered = coveringTrim(seg, activeTrims)
                  const trimmed = isTrimmed(seg, activeTrims)
                  const activeSegment = i === activeSegmentIdx
                  return (
                    <div
                      key={`${seg.start}-${i}`}
                      ref={(node) => { segmentRefs.current[i] = node }}
                      className={`tws-ts-seg ${i === curSegmentIdx ? 'current' : ''} ${activeSegment ? 'active-segment' : ''} ${trimmed ? 'trimmed' : ''}`}
                      data-seg-index={i}
                      data-active={activeSegment ? 'true' : 'false'}
                      data-trimmed={trimmed ? 'true' : 'false'}
                      onClick={(e) => handleSegmentClick(e, seg, i)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleSegmentClick(e, seg, i)
                        }
                      }}
                      role="listitem"
                      tabIndex={0}
                      title={trimmed ? `Restore from ${fmt(seg.start / 1000)}` : `Jump to ${fmt(seg.start / 1000)}`}
                    >
                      <span className="tws-ts-time">{fmt(seg.start / 1000)}</span>
                      <span className="tws-ts-text">{seg.text}</span>
                      <button
                        className="tws-ts-trim"
                        aria-label={covered ? 'Restore transcript segment' : 'Trim transcript segment'}
                        title={covered ? 'Restore segment' : 'Trim segment (T)'}
                        onClick={(e) => { e.stopPropagation(); setActiveSegmentIdx(i); void toggleTrimSegment(seg) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            void toggleTrimSegment(seg)
                          }
                        }}
                      >
                        {covered ? <RotateCcw className="lt-icon" /> : <Scissors className="lt-icon" />}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : transcript ? (
              <div className="tws-ts-ph empty">
                <FileText className="lt-icon" />
                <h4>Transcript saved with no segments</h4>
                <p>The transcript file exists, but it has no readable segments. Re-transcribe this recording when you are ready.</p>
              </div>
            ) : (
              <>
                <div className="tws-ts-ph">
                  <FileText className="lt-icon" />
                  <h4>Words will thread along this timeline</h4>
                  <p>Transcribe this recording to pin each phrase to its moment. Click a segment to jump the audio, and the slide will follow.</p>
                  {active ? (
                    <div className="tws-ts-cta">
                      {transcriptBusy ? (
                        <div className="tws-ts-progress" aria-live="polite">
                          <Loader2 className="lt-icon spin" />
                          <span>{transcriptNote || 'Transcribing…'}</span>
                        </div>
                      ) : (
                        <button className="tws-btn primary" onClick={() => { void runTranscription() }} disabled={transcriptLoading}>
                          <FileText className="lt-icon" />
                          Transcribe
                        </button>
                      )}
                    </div>
                  ) : null}
                  {transcriptLoading ? <p className="tws-ts-note">Checking for an existing transcript…</p> : null}
                  {transcriptError ? <p className="tws-ts-error">{transcriptError}</p> : null}
                </div>
                <div className="tws-ts-ghost">
                  {[
                    [92, 74, 58],
                    [80, 66],
                    [88, 52, 70]
                  ].map((widths, i) => (
                    <div className="tws-ts-line" key={i}>
                      <span className="gt">{fmt(totalSec * (0.2 + i * 0.14))}</span>
                      <span className="gb">{widths.map((w, j) => <b key={j} style={{ width: w + '%' }} />)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="tws-ts-foot">
            {transcript
              ? 'Segment times follow the recording clock. Click a phrase or use [ and ] to move through the transcript; T trims or restores the current segment.'
              : 'The audio stays local. Transcription adds a small text file beside this run when you ask for it.'}
          </div>
        </aside>
      </div>

      {/* timeline console */}
      <div className="tws-console" style={active ? undefined : { opacity: 0.4, pointerEvents: 'none' }}>
        <div className="tws-console-top">
          <div className="tws-transport">
            <button className="tws-tp" title="Previous slide (←)" onClick={() => stepSlide(-1)}><SkipBack className="lt-icon" /></button>
            <button className="tws-tp tws-play" title="Play / pause (Space)" onClick={togglePlay}>
              {playing ? <Pause className="lt-icon" /> : <Play className="lt-icon" />}
            </button>
            <button className="tws-tp" title="Next slide (→)" onClick={() => stepSlide(1)}><SkipForward className="lt-icon" /></button>
            <div className="tws-clock">
              <span className="cur">{fmt(effectiveCurSec)}</span>
              <span className="sep">/</span>
              <span className="tot">{fmt(effectiveTotalSec)}</span>
              {hasTrims ? <span className="raw">raw {fmt(progress * totalSec)} / {fmt(totalSec)}</span> : null}
            </div>
          </div>
          <div className="tws-ct-meta">
            <span
              className={`tws-cm-label ${active?.context ? '' : 'placeholder'}`}
              contentEditable={!!active}
              suppressContentEditableWarning
              title="Click to edit the context label"
              onBlur={(e) => { const v = e.currentTarget.textContent ?? ''; if (v !== (active?.context ?? '')) void saveContext(v) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur() } }}
            >
              {active?.context || 'Add a context label…'}
            </span>
            <span className="tws-cm-plan">
              {active ? `${mins(activeEffectiveSec)}m recorded${hasTrims ? ` · raw ${mins(totalSec)}m` : ''}${active.timerTargetMin ? ` · planned ${active.timerTargetMin}m` : ''}` : ''}
            </span>
            {delta ? <span className={`tws-delta ${delta.cls}`}>{delta.text}</span> : null}
            <button className="tws-speed" title="Playback speed" onClick={cycleSpeed}>{SPEEDS[speedIdx].toString()}×</button>
            {active && (
              <button className="tws-upl" onClick={doUpload} disabled={active.audio.uploaded || uploadBusy} title={active.audio.uploaded ? 'Already in R2' : 'Upload this recording to R2 (U)'}>
                {active.audio.uploaded ? <><Check className="lt-icon" /> In R2</> : <><UploadCloud className="lt-icon" /> {uploadBusy ? 'Uploading…' : 'Upload to R2'}</>}
              </button>
            )}
            {active && !confirmDelete && (
              <button className="tws-tp" title="Delete this recording" onClick={() => setConfirmDelete(true)} style={{ width: 30, height: 30 }}><Trash2 className="lt-icon" /></button>
            )}
            {active && confirmDelete && (
              <>
                <button className="tws-btn danger" onClick={doDelete}>Delete</button>
                <button className="tws-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </>
            )}
          </div>
        </div>

        <div className="tws-timeline">
          <div className="tws-track">
            <div className="tws-ruler">
              {[0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => (
                <div className="tws-tick" key={f} style={{ left: (f * 100).toFixed(2) + '%' }}>
                  <span className="tl">{fmt(f * totalSec)}</span>
                  <span className="tm" />
                </div>
              ))}
            </div>
            <div className="tws-markers">
              {enters.map((m, i) => {
                const slide = m.slideId ? slideMap[m.slideId] : undefined
                const at = active && active.recordingMs ? (m.tMs / active.recordingMs) * 100 : 0
                return (
                  <div
                    className={`tws-marker ${i === curEnterIdx ? 'active' : ''}`}
                    key={i}
                    style={{ left: at.toFixed(2) + '%' }}
                    onClick={() => seekToSec((m.tMs || 0) / 1000)}
                    title={slide?.title || m.slideId || 'slide'}
                  >
                    <div className="m-print">
                      <div className="m-thumb">
                        {slide?.thumbUrl ? <img src={slide.thumbUrl} alt={slide.title} /> : <span className="m-miss">{slide ? '' : '—'}</span>}
                      </div>
                    </div>
                    <div className="m-time"><span className="n">{slide ? slide.n : '?'}</span> {fmt((m.tMs || 0) / 1000)}</div>
                    <div className="m-stem" />
                  </div>
                )
              })}
            </div>
            <div className="tws-wave" onMouseDown={(e) => {
              const el = e.currentTarget
              const seek = (clientX: number): void => {
                const r = el.getBoundingClientRect()
                seekToSec(((clientX - r.left) / r.width) * totalSec)
              }
              seek(e.clientX)
              const move = (ev: MouseEvent): void => seek(ev.clientX)
              const up = (): void => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
              document.addEventListener('mousemove', move)
              document.addEventListener('mouseup', up)
            }}>
              {waveLoading && <div className="tws-wave-loading">reading waveform…</div>}
              {wave && (
                <>
                  <div className="tws-wbars base">{wave.map((h, i) => <span className="wb" key={i} style={{ ['--h' as string]: (h * 100).toFixed(0) + '%' }} />)}</div>
                  <div className="tws-wbars fill" style={{ ['--p' as string]: pct }}>{wave.map((h, i) => <span className="wb" key={i} style={{ ['--h' as string]: (h * 100).toFixed(0) + '%' }} />)}</div>
                </>
              )}
              {activeTrims.length ? (
                <div className="tws-trim-overlays" aria-hidden="true">
                  {activeTrims.map((trim, i) => {
                    const left = active && active.recordingMs ? (trim.start / active.recordingMs) * 100 : 0
                    const width = active && active.recordingMs ? ((trim.end - trim.start) / active.recordingMs) * 100 : 0
                    return <span key={`${trim.start}-${i}`} style={{ left: left.toFixed(3) + '%', width: Math.max(0.35, width).toFixed(3) + '%' }} />
                  })}
                </div>
              ) : null}
            </div>
            <div className="tws-playhead" style={{ ['--p' as string]: pct }}>
              <div className="ph-time">{fmt(effectiveCurSec)}</div>
              <div className="ph-head" />
              <div className="ph-line" />
            </div>
            <div className="tws-tlane">
              {transcriptSegments.length ? (
                <>
                  <span className="tl-label">Transcript</span>
                  <span className="tl-segments" aria-hidden="true">
                    {activeTrims.map((trim, i) => {
                      const left = active && active.recordingMs ? (trim.start / active.recordingMs) * 100 : 0
                      const width = active && active.recordingMs ? ((trim.end - trim.start) / active.recordingMs) * 100 : 0
                      return <span key={`${trim.start}-${i}`} className="tl-trim" style={{ left: left.toFixed(3) + '%', width: Math.max(0.35, width).toFixed(3) + '%' }} />
                    })}
                    {transcriptSegments.map((seg, i) => {
                      const left = active && active.recordingMs ? (seg.start / active.recordingMs) * 100 : 0
                      const width = active && active.recordingMs ? ((seg.end - seg.start) / active.recordingMs) * 100 : 0
                      const trimmed = isTrimmed(seg, activeTrims)
                      const activeSegment = i === activeSegmentIdx
                      return (
                        <span
                          key={`${seg.start}-${i}`}
                          className={`tl-seg ${i === curSegmentIdx ? 'current' : ''} ${activeSegment ? 'active-segment' : ''} ${trimmed ? 'trimmed' : ''}`}
                          style={{ left: left.toFixed(3) + '%', width: Math.max(0.35, width).toFixed(3) + '%' }}
                        />
                      )
                    })}
                  </span>
                  <span className="tl-soon">{transcriptSegments.length} segments</span>
                </>
              ) : (
                <>
                  <span className="tl-label">Transcript lane</span>
                  <span className="tl-dots" />
                  <span className="tl-soon">Not yet</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* hint footer */}
      <div className="tws-hintbar">
        <span className="h"><b>Space</b> play / pause</span>
        <span className="h"><b>← →</b> slide to slide</span>
        <span className="h"><b>↑ ↓</b> recording</span>
        <span className="h"><b>, .</b> nudge 5s</span>
        <span className="h"><b>[ ]</b> transcript</span>
        <span className="h"><b>T</b> trim / restore</span>
        <span className="h"><b>U</b> upload</span>
        <span className="h push"><b>?</b> shortcuts</span>
      </div>

      {/* ? cheat-sheet */}
      {sheet && (
        <div className="tws-scrim" onClick={(e) => { if (e.target === e.currentTarget) setSheet(false) }}>
          <div className="tws-panel">
            <div className="tws-panel-head">
              <h2>Keyboard</h2>
              <span className="ph-sub">every control has a key</span>
              <button className="ph-close" onClick={() => setSheet(false)} aria-label="Close"><X className="lt-icon" /></button>
            </div>
            <div className="tws-cs-groups">
              <div className="tws-cs-group">
                <h3>Player</h3>
                <div className="tws-cs-row">Play / pause <span className="keys"><kbd>Space</kbd></span></div>
                <div className="tws-cs-row">Previous slide <span className="keys"><kbd>←</kbd></span></div>
                <div className="tws-cs-row">Next slide <span className="keys"><kbd>→</kbd></span></div>
                <div className="tws-cs-row">Nudge back 5s <span className="keys"><kbd>,</kbd></span></div>
                <div className="tws-cs-row">Nudge on 5s <span className="keys"><kbd>.</kbd></span></div>
                <div className="tws-cs-row">Previous transcript segment <span className="keys"><kbd>[</kbd></span></div>
                <div className="tws-cs-row">Next transcript segment <span className="keys"><kbd>]</kbd></span></div>
                <div className="tws-cs-row">Trim / restore current segment <span className="keys"><kbd>T</kbd></span></div>
                <div className="tws-cs-row">Jump to start <span className="keys"><kbd>0</kbd></span></div>
              </div>
              <div className="tws-cs-group">
                <h3>Session</h3>
                <div className="tws-cs-row">Previous / next recording <span className="keys"><kbd>↑</kbd><kbd>↓</kbd></span></div>
                <div className="tws-cs-row">Upload to R2 <span className="keys"><kbd>U</kbd></span></div>
                <div className="tws-cs-row">Search recordings <span className="keys"><kbd>⌘</kbd><kbd>F</kbd></span></div>
                <div className="tws-cs-row">Edit context <span className="keys">click the label</span></div>
              </div>
              <div className="tws-cs-group">
                <h3>Anywhere</h3>
                <div className="tws-cs-row">This cheat-sheet <span className="keys"><kbd>?</kbd></span></div>
                <div className="tws-cs-row">Close Studio <span className="keys"><kbd>Esc</kbd></span></div>
                <div className="tws-cs-row">Recording keys <span className="keys"><kbd>⇧R</kbd> <kbd>⇧P</kbd></span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="tws-toast show"><Check className="lt-icon" /><span>{toast}</span></div>}
    </div>
  )
}
