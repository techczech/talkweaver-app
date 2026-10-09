/// <reference lib="dom" />
// Audio capture for the presenter's recorder: the microphone, MediaRecorder, and where the audio
// goes. present-recorder.ts owns the recording's states, clock and slide marks; this module owns
// the audio and answers three questions the 1 Oct incident raised (34 s of audio from a 2 h 57 min
// recording, no error):
//
//   1. Is audio still arriving?  The loss detector (recording-loss.ts) watches the track ending or
//      staying muted, recorder errors, a stall (no chunk for 5 s with 1 s chunks) and device
//      changes. A loss is reported at once (onStatus 'lost').
//   2. Can it carry on?  On a loss the current segment is closed and the default input is opened
//      again, once, automatically; if that fails, `reacquire()` (the notice's "Resume recording")
//      tries again. Each continuous stretch of audio is one segment; the time between two is a gap.
//   3. Is it safe on disk?  Each chunk is appended through main (recording:stream-*) to the
//      session's segment file as it arrives. If main cannot open a stream (an older main, a test
//      harness), audio is held in memory until Stop, as before. Chunks main fails to take — a
//      refused append, or every chunk of a segment whose file main could not open (after retries)
//      — are kept in order and handed over with the save (`tail`), and the presenter is told the
//      audio is not reaching the disk ('disk-failed'). None is dropped.
//
// Times for segments and gaps are on the recording clock the controller supplies (pause-aware ms,
// the clock of `recordingMs` and the slide-time index).

import {
  DEFAULT_LOSS_CONFIG,
  initialLossState,
  inputStillPresent,
  stepLoss,
  type Loss,
  type LossConfig,
  type LossEvent,
  type LossReason,
  type LossState
} from './recording-loss'
import type { RunAudioGap } from '../shared/run-audio.ts'

/** MediaRecorder timeslice: a chunk about every second. */
export const CHUNK_MS = 1000
/** Do not auto-retry again within this long of an automatic recovery (avoid a flapping loop). */
const AUTO_RETRY_COOLDOWN_MS = 10_000
const STREAM_TIMEOUT_MS = 8000
const RECORDER_STOP_TIMEOUT_MS = 1500
/** Attempts to open a segment file in main before holding that segment in memory. */
const SEGMENT_OPEN_ATTEMPTS = 3
const SEGMENT_OPEN_RETRY_MS = 250

export interface CaptureEnv {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>
  /** Opens the default input (or the test tone). */
  getStream: () => Promise<MediaStream>
  /** The pause-aware recording clock, ms. */
  clock: () => number
  /** Monotonic time, ms (performance.now). */
  now?: () => number
  lossConfig?: LossConfig
}

export interface CaptureMeta {
  talkSlug: string
  talkTitle: string
  startedAt: string
  timerTargetMin: number
  pathwayId: string | null
}

export interface RecordingOrigin {
  /** performance.now() when the first recorder started. */
  perf: number
  /** The same moment as wall-clock ISO time (the Run's startedAt). */
  iso: string
}

export interface CapturedSegment { index: number; startMs: number; endMs: number }

export interface CapturedAudio {
  /** 'stream': the audio is in files main wrote; 'memory': it is in `blobs` (one per segment). */
  mode: 'stream' | 'memory'
  sessionId: string | null
  mimeType: string
  blobs: Blob[]
  /** Stream chunks main did not take, in order, for the save to append. */
  tail: Array<{ index: number; bytes: ArrayBuffer }>
  segments: CapturedSegment[]
  gaps: RunAudioGap[]
  audioMs: number
}

export interface AudioStatus {
  lost: boolean
  recovering: boolean
  reason: LossReason | null
  /** Recording-clock time the audio stopped, while lost. */
  lostAtMs: number | null
  gaps: number
  /** Main refused a segment file or a chunk: audio is held in memory until Stop. */
  diskError: boolean
}

export type AudioEvent = 'lost' | 'recovering' | 'restored' | 'retry-failed' | 'disk-failed'

export interface AudioCapture {
  /** Throws Error('mic') when the input cannot be opened, Error('codec') when recording cannot start. */
  /**
   * Resolves with the moment the first segment's MediaRecorder started — the recording's origin.
   * The mic permission and opening the stream in main come before it and are not part of it.
   */
  start(meta: CaptureMeta): Promise<RecordingOrigin>
  pause(): void
  resume(): void
  stop(): Promise<CapturedAudio>
  /** Open the default input again after a loss. True when audio flows again. */
  reacquire(): Promise<boolean>
  status(): AudioStatus
  /** Refresh the on-disk marker with the latest slide marks (crash recovery). */
  checkpoint(rawMarks: unknown[]): void
  onStatus(cb: (status: AudioStatus, event: AudioEvent, detail?: { gapMs?: number }) => void): void
}

function pickMimeType(): string | undefined {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm']
  for (const m of prefs) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

const on = (target: unknown, type: string, fn: () => void): void => {
  const t = target as { addEventListener?: (type: string, fn: () => void) => void } | null
  if (t && typeof t.addEventListener === 'function') t.addEventListener(type, fn)
}
const off = (target: unknown, type: string, fn: () => void): void => {
  const t = target as { removeEventListener?: (type: string, fn: () => void) => void } | null
  if (t && typeof t.removeEventListener === 'function') t.removeEventListener(type, fn)
}

export function createAudioCapture(env: CaptureEnv): AudioCapture {
  const now = env.now ?? (() => performance.now())
  const lossConfig = env.lossConfig ?? DEFAULT_LOSS_CONFIG

  let mode: 'stream' | 'memory' = 'memory'
  let sessionId: string | null = null
  let mime: string | undefined
  let stream: MediaStream | null = null
  let track: MediaStreamTrack | null = null
  let recorder: MediaRecorder | null = null
  let paused = false
  let stopped = true
  let segments: Array<{ index: number; startMs: number; endMs: number | null }> = []
  let memChunks: Blob[][] = []
  let gaps: RunAudioGap[] = []
  let backlog: Array<{ index: number; bytes: ArrayBuffer }> = []
  let chain: Promise<void> = Promise.resolve()
  let loss: LossState = initialLossState()
  let lost = false
  let recovering = false
  let reason: LossReason | null = null
  let lostAtMs: number | null = null
  let lastAutoRecoverAt = Number.NEGATIVE_INFINITY
  let tickId: ReturnType<typeof setInterval> | null = null
  // Segments whose file main opened; chunks of any other segment stay in `backlog` until Stop.
  let onDisk = new Set<number>()
  // When the first segment's recorder started: the origin of the recording clock.
  let origin: RecordingOrigin | null = null
  let diskError = false
  // The segment close in flight (a loss, or Stop): Stop waits for it, final chunk included.
  let ending: Promise<void> = Promise.resolve()
  const statusCbs: Array<(s: AudioStatus, e: AudioEvent, d?: { gapMs?: number }) => void> = []

  const status = (): AudioStatus => ({ lost, recovering, reason, lostAtMs, gaps: gaps.length, diskError })
  const emit = (event: AudioEvent, detail?: { gapMs?: number }): void => {
    const s = status()
    for (const cb of statusCbs) {
      try { cb(s, event, detail) } catch { /* a UI failure never stops capture */ }
    }
  }

  // ── Disk: every call to main goes through one ordered chain ─────────────────
  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job).catch(() => { /* each job handles its own failure */ })
  }
  async function invokeOk(channel: string, payload: unknown): Promise<boolean> {
    try {
      const res = (await env.invoke(channel, payload)) as { ok?: boolean } | undefined
      return !!res?.ok
    } catch {
      return false
    }
  }
  function noteDiskFailure(): void {
    if (diskError) return
    diskError = true
    emit('disk-failed')
  }
  // Send held chunks of one segment, oldest first; stop at the first refusal so its file never
  // receives a later chunk before an earlier one. Chunks of other segments keep their place.
  async function flush(index: number): Promise<void> {
    if (!onDisk.has(index)) return
    for (let i = 0; i < backlog.length;) {
      const next = backlog[i]
      if (next.index !== index) { i++; continue }
      if (!(await invokeOk('recording:stream-append', { sessionId, index, bytes: next.bytes }))) { noteDiskFailure(); return }
      backlog.splice(i, 1)
    }
  }
  // Open a segment's file in main, retrying a refusal; if it stays refused the segment is held.
  async function openSegmentOnDisk(index: number, startMs: number): Promise<void> {
    for (let attempt = 0; attempt < SEGMENT_OPEN_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, SEGMENT_OPEN_RETRY_MS))
      // Segment 0 tells main when the recording really started (the marker's startedAt, for recovery).
      const startedAt = index === 0 ? origin?.iso : undefined
      if (await invokeOk('recording:stream-segment', { sessionId, index, startMs, startedAt })) { onDisk.add(index); return }
    }
    noteDiskFailure()
  }

  function feed(event: LossEvent): void {
    const step = stepLoss(loss, event, lossConfig)
    loss = step.state
    if (step.lost) void handleLoss(step.lost)
  }

  // ── Segments ─────────────────────────────────────────────────────────────────
  const onTrackEnded = (): void => feed({ type: 'track-ended', at: now() })
  const onTrackMute = (): void => feed({ type: 'track-mute', at: now() })
  const onTrackUnmute = (): void => feed({ type: 'track-unmute', at: now() })

  function releaseStream(): void {
    if (track) {
      off(track, 'ended', onTrackEnded)
      off(track, 'mute', onTrackMute)
      off(track, 'unmute', onTrackUnmute)
    }
    try { stream?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
    stream = null
    track = null
  }

  function beginSegment(next: MediaStream): void {
    const index = segments.length
    const rec = new MediaRecorder(next, mime ? { mimeType: mime } : undefined)
    stream = next
    track = (typeof next.getAudioTracks === 'function' ? next.getAudioTracks()[0] : null) ?? null
    on(track, 'ended', onTrackEnded)
    on(track, 'mute', onTrackMute)
    on(track, 'unmute', onTrackUnmute)
    if (index === 0) memChunks = []
    memChunks[index] = []
    rec.ondataavailable = (ev: BlobEvent): void => {
      if (!ev.data || ev.data.size === 0) return
      if (recorder === rec) feed({ type: 'chunk', at: now() })
      if (mode === 'memory') { memChunks[index].push(ev.data); return }
      const data = ev.data
      enqueue(async () => {
        backlog.push({ index, bytes: await data.arrayBuffer() })
        await flush(index)
      })
    }
    rec.onerror = (): void => { if (recorder === rec) feed({ type: 'recorder-error', at: now() }) }
    // MediaRecorder stops by itself when its tracks end; a stop nobody asked for is a loss.
    rec.onstop = (): void => { if (recorder === rec) feed({ type: track?.readyState === 'ended' ? 'track-ended' : 'recorder-error', at: now() }) }
    const startMs = Math.round(env.clock())
    segments.push({ index, startMs, endMs: null })
    if (mode === 'stream') enqueue(() => openSegmentOnDisk(index, startMs))
    recorder = rec
    rec.start(CHUNK_MS)
    if (index === 0) origin = { perf: now(), iso: new Date().toISOString() }
    feed({ type: 'start', at: now() })
    if (paused) {
      try { rec.pause() } catch { /* ignore */ }
      feed({ type: 'pause', at: now() })
    }
  }

  // Stop the current recorder (its last chunk still lands in this segment) and close the segment.
  // Registered in `ending`, so Stop can wait for a close a loss already started.
  function endSegment(endMs: number): Promise<void> {
    const job = closeSegment(endMs)
    ending = ending.then(() => job)
    return job
  }
  async function closeSegment(endMs: number): Promise<void> {
    const rec = recorder
    recorder = null
    const seg = segments[segments.length - 1]
    if (rec) {
      await new Promise<void>((resolve) => {
        const done = (): void => resolve()
        const prevStop = rec.onstop
        rec.onstop = (ev: Event): void => { try { prevStop?.call(rec, ev) } finally { done() } }
        try {
          if (rec.state === undefined || rec.state !== 'inactive') rec.stop()
          else done()
        } catch { done() }
        setTimeout(done, RECORDER_STOP_TIMEOUT_MS)
      })
    }
    releaseStream()
    if (seg && seg.endMs === null) {
      seg.endMs = Math.max(seg.startMs, Math.round(endMs))
      if (mode === 'stream') {
        const index = seg.index
        const end = seg.endMs
        enqueue(async () => {
          await flush(index)
          if (onDisk.has(index)) await invokeOk('recording:stream-segment-end', { sessionId, index, endMs: end })
        })
      }
    }
  }

  async function handleLoss(found: Loss): Promise<void> {
    if (lost || recovering || stopped) return
    const seg = segments[segments.length - 1]
    // Back-date the gap to when the audio stopped (the last chunk, or when a mute began).
    const gapStart = Math.max(seg ? seg.startMs : 0, Math.round(env.clock() - Math.max(0, now() - found.at)))
    lost = true
    reason = found.reason
    lostAtMs = gapStart
    emit('lost')
    await endSegment(gapStart)
    if (now() - lastAutoRecoverAt > AUTO_RETRY_COOLDOWN_MS) {
      const ok = await reacquire()
      if (ok) lastAutoRecoverAt = now()
    }
  }

  async function reacquire(): Promise<boolean> {
    if (stopped) return false
    if (!lost) return true
    if (recovering) return false
    recovering = true
    emit('recovering')
    try {
      const next = await withTimeout(env.getStream(), STREAM_TIMEOUT_MS)
      const nextTrack = typeof next.getAudioTracks === 'function' ? next.getAudioTracks()[0] : null
      if (nextTrack && nextTrack.readyState === 'ended') throw new Error('ended')
      if (stopped) { try { next.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ } return false }
      const endMs = Math.round(env.clock())
      gaps.push({ startMs: lostAtMs ?? endMs, endMs: Math.max(lostAtMs ?? endMs, endMs), reason: reason ?? 'unknown' })
      const gapMs = Math.max(0, endMs - (lostAtMs ?? endMs))
      lost = false
      recovering = false
      reason = null
      lostAtMs = null
      beginSegment(next)
      emit('restored', { gapMs })
      return true
    } catch {
      recovering = false
      releaseStream()
      emit('retry-failed')
      return false
    }
  }

  const onDeviceChange = (): void => {
    const devices = navigator.mediaDevices
    if (!track || !devices || typeof devices.enumerateDevices !== 'function') return
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : null
    void devices.enumerateDevices().then((list) => {
      feed({ type: 'device-change', at: now(), inputPresent: inputStillPresent(settings, list) })
    }).catch(() => { /* the stall watchdog still runs */ })
  }

  return {
    async start(meta) {
      if (!stopped) return origin ?? { perf: now(), iso: new Date().toISOString() }
      let first: MediaStream
      try {
        first = await env.getStream()
      } catch {
        throw new Error('mic')
      }
      mime = pickMimeType()
      segments = []
      gaps = []
      backlog = []
      memChunks = []
      onDisk = new Set()
      origin = null
      diskError = false
      ending = Promise.resolve()
      chain = Promise.resolve()
      loss = initialLossState()
      lost = false
      recovering = false
      reason = null
      lostAtMs = null
      paused = false
      lastAutoRecoverAt = Number.NEGATIVE_INFINITY
      mode = 'memory'
      sessionId = null
      try {
        const res = (await env.invoke('recording:stream-open', { ...meta, mimeType: mime ?? 'audio/webm' })) as { ok?: boolean; sessionId?: unknown } | undefined
        if (res?.ok && typeof res.sessionId === 'string' && res.sessionId) {
          mode = 'stream'
          sessionId = res.sessionId
        }
      } catch { /* memory mode */ }
      stopped = false
      try {
        beginSegment(first)
      } catch {
        stopped = true
        try { first.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
        if (mode === 'stream') void invokeOk('recording:stream-discard', { sessionId })
        throw new Error('codec')
      }
      tickId = setInterval(() => feed({ type: 'tick', at: now() }), 1000)
      on(navigator.mediaDevices, 'devicechange', onDeviceChange)
      return origin ?? { perf: now(), iso: new Date().toISOString() }
    },

    pause() {
      paused = true
      try { recorder?.pause() } catch { /* ignore */ }
      feed({ type: 'pause', at: now() })
    },

    resume() {
      paused = false
      try { recorder?.resume() } catch { /* ignore */ }
      feed({ type: 'resume', at: now() })
    },

    async stop() {
      const endMs = Math.round(env.clock())
      if (tickId !== null) { clearInterval(tickId); tickId = null }
      off(navigator.mediaDevices, 'devicechange', onDeviceChange)
      feed({ type: 'stop', at: now() })
      if (lost && lostAtMs !== null) gaps.push({ startMs: lostAtMs, endMs: Math.max(lostAtMs, endMs), reason: reason ?? 'unknown' })
      // Mark stopped before closing the recorder, so its own stop is not read as a loss.
      stopped = true
      lost = false
      recovering = false
      reason = null
      lostAtMs = null
      // A loss may already be closing the segment: wait for that (its final chunk included), then
      // close whatever is still open, then for every call to main to finish, before the tail is taken.
      await ending
      await endSegment(endMs)
      await ending
      await chain
      const done: CapturedSegment[] = segments.map((s) => ({ index: s.index, startMs: s.startMs, endMs: s.endMs ?? endMs }))
      const type = mime ?? 'audio/webm'
      return {
        mode,
        sessionId,
        mimeType: type,
        blobs: mode === 'memory' ? done.map((s) => new Blob(memChunks[s.index] ?? [], { type })) : [],
        tail: backlog.slice(),
        segments: done,
        gaps: gaps.slice(),
        audioMs: done.reduce((sum, s) => sum + Math.max(0, s.endMs - s.startMs), 0)
      }
    },

    reacquire,
    status,

    checkpoint(rawMarks) {
      if (mode !== 'stream' || stopped) return
      const at = Math.round(env.clock())
      const open = lost && lostAtMs !== null ? [{ startMs: lostAtMs, endMs: at, reason: reason ?? 'unknown' }] : []
      const payload = { sessionId, rawMarks, recordingMs: at, gaps: [...gaps, ...open] }
      enqueue(async () => { await invokeOk('recording:stream-checkpoint', payload) })
    },

    onStatus(cb) { statusCbs.push(cb) }
  }
}
