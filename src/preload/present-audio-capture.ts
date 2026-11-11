/// <reference lib="dom" />
// Audio capture for the presenter's recorder: the microphone, MediaRecorder, and where the audio
// goes. present-recorder.ts owns the recording's states, clock and slide marks; this module owns
// the audio and answers three questions the 1 Oct incident raised (34 s of audio from a 2 h 57 min
// recording, no error):
//
//   1. Is audio still arriving?  The loss detector (recording-loss.ts) watches the track ending or
//      staying muted, recorder errors, a stall (no chunk for 5 s with 1 s chunks) and device
//      changes. A loss is reported at once (onStatus 'lost').
//   2. Can it carry on?  On a loss the current segment is closed and the chosen input is opened
//      again, once, automatically; if that fails, `reacquire()` (the notice's "Resume recording")
//      tries again, and so does the input coming back (`inputReturned`). The input is always the one
//      the presenter chose (the env's getStream opens exactly it; 9 Nov incident): never another.
//      Each continuous stretch of audio is one segment; the time between two is a gap. A segment
//      gets its file in main with its first chunk, so a reconnect that yields no audio leaves no
//      empty file behind (the incident's nine 0-byte segments). `switchInput()` moves to another
//      input the presenter picked: the new input's recorder starts BEFORE the old one stops, so the
//      two segments overlap by a moment rather than leave a gap (the timeline mixes the overlap).
//      Every acquisition of an input has its own number: only the latest is used, and a stream that
//      arrives late (after a timeout) or was overtaken is stopped at once, never recorded.
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
import { audioMsFromSegments, type RunAudioGap } from '../shared/run-audio.ts'

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
  /** Opens the chosen input, exactly (or the test tone); throws when it is not connected. */
  getStream: () => Promise<MediaStream>
  /** While audio is lost: whether this device list has the chosen input back (it is then reopened). */
  inputReturned?: (devices: MediaDeviceInfo[]) => boolean
  /** A stream getStream gave is now being recorded (the only point an input becomes the one in use). */
  accepted?: (stream: MediaStream) => void
  /** How long opening an input may take after a loss or a switch (default 8 s). */
  streamTimeoutMs?: number
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

export type AudioEvent = 'lost' | 'recovering' | 'restored' | 'retry-failed' | 'disk-failed' | 'switched'

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
  /** Open the chosen input again after a loss. True when audio flows again. */
  reacquire(): Promise<boolean>
  /**
   * Record from the input getStream now opens (the presenter picked another): the current segment
   * ends and the next begins on the new input. False, and recording carries on as it was, when the
   * new input cannot be opened.
   */
  switchInput(): Promise<boolean>
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

const stopTracks = (s: MediaStream | null | undefined): void => {
  try { s?.getTracks().forEach((t) => t.stop()) } catch { /* ignore */ }
}

export function createAudioCapture(env: CaptureEnv): AudioCapture {
  const now = env.now ?? (() => performance.now())
  const lossConfig = env.lossConfig ?? DEFAULT_LOSS_CONFIG
  const streamTimeoutMs = env.streamTimeoutMs ?? STREAM_TIMEOUT_MS

  let mode: 'stream' | 'memory' = 'memory'
  let sessionId: string | null = null
  let mime: string | undefined
  let stream: MediaStream | null = null
  let track: MediaStreamTrack | null = null
  let recorder: MediaRecorder | null = null
  let paused = false
  let stopped = true
  let segments: Array<{ index: number; startMs: number; endMs: number | null }> = []
  // Chunks each segment produced: a later segment with none holds no audio and is left out.
  let chunkCounts: number[] = []
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
  // A segment's chunks reach the disk chain only once the segment before it is closed (its file
  // ended in main): Stop waits for chunks still held back.
  let staged: Promise<void> = Promise.resolve()
  // The number of the latest acquisition of an input; an older one is never used.
  let acquireOp = 0
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

  /**
   * Open an input through env.getStream, as acquisition number `op`. A stream that comes after the
   * timeout, or after a newer acquisition began, is stopped and never recorded.
   */
  async function acquire(): Promise<MediaStream> {
    const op = ++acquireOp
    const pending = env.getStream()
    try {
      const next = await withTimeout(pending, streamTimeoutMs)
      if (op !== acquireOp) throw new Error('superseded')
      return next
    } catch (e) {
      void pending.then(stopTracks, () => { /* nothing was opened */ })
      throw e
    }
  }

  // Take the current recorder, stream and segment out of service (the recorder keeps recording until
  // closeSegment stops it); its events no longer count as a loss.
  type Live = { rec: MediaRecorder | null; stream: MediaStream | null; track: MediaStreamTrack | null; seg: { index: number; startMs: number; endMs: number | null } | undefined }
  function detachCurrent(): Live {
    const live: Live = { rec: recorder, stream, track, seg: segments[segments.length - 1] }
    recorder = null
    if (track) {
      off(track, 'ended', onTrackEnded)
      off(track, 'mute', onTrackMute)
      off(track, 'unmute', onTrackUnmute)
    }
    stream = null
    track = null
    return live
  }

  // `gate`: the segment before this one is closed; until then its chunks wait (main writes one
  // segment file at a time, in order). `handover` runs once the new recorder has started, before it
  // takes over (a switch detaches the old one there).
  //
  // Exception-safe: the MediaRecorder is made and started before anything changes. If either throws,
  // the error goes to the caller with no segment added, the current recorder, stream and listeners
  // untouched, and the new stream not accepted (the caller stops it).
  function beginSegment(next: MediaStream, gate: Promise<unknown> = ending, handover?: () => void): void {
    const index = segments.length
    const nextTrack = (typeof next.getAudioTracks === 'function' ? next.getAudioTracks()[0] : null) ?? null
    const rec = new MediaRecorder(next, mime ? { mimeType: mime } : undefined)
    // Segment 0 opens its file at once (main learns when the recording started); a later segment
    // with its first chunk, so a reconnect that produced no audio leaves no empty file.
    let fileAsked = false
    let startMs = 0
    const askFile = (): void => {
      if (fileAsked || mode !== 'stream') return
      fileAsked = true
      enqueue(() => openSegmentOnDisk(index, startMs))
    }
    rec.ondataavailable = (ev: BlobEvent): void => {
      if (!ev.data || ev.data.size === 0) return
      chunkCounts[index] = (chunkCounts[index] ?? 0) + 1
      if (recorder === rec) feed({ type: 'chunk', at: now() })
      if (mode === 'memory') { (memChunks[index] ??= []).push(ev.data); return }
      const data = ev.data
      const held = gate.then(() => {
        askFile()
        enqueue(async () => {
          backlog.push({ index, bytes: await data.arrayBuffer() })
          await flush(index)
        })
      }, () => {})
      staged = staged.then(() => held)
    }
    rec.onerror = (): void => { if (recorder === rec) feed({ type: 'recorder-error', at: now() }) }
    // MediaRecorder stops by itself when its tracks end; a stop nobody asked for is a loss.
    rec.onstop = (): void => { if (recorder === rec) feed({ type: nextTrack?.readyState === 'ended' ? 'track-ended' : 'recorder-error', at: now() }) }
    startMs = Math.round(env.clock())
    rec.start(CHUNK_MS)
    // Started: from here nothing throws, and the new recorder takes over.
    handover?.()
    env.accepted?.(next)
    stream = next
    track = nextTrack
    on(track, 'ended', onTrackEnded)
    on(track, 'mute', onTrackMute)
    on(track, 'unmute', onTrackUnmute)
    if (index === 0) memChunks = []
    memChunks[index] ??= []
    chunkCounts[index] ??= 0
    segments.push({ index, startMs, endMs: null })
    if (index === 0) staged = staged.then(() => gate.then(askFile, () => {}))
    recorder = rec
    if (index === 0) origin = { perf: now(), iso: new Date().toISOString() }
    feed({ type: 'start', at: now() })
    if (paused) {
      try { rec.pause() } catch { /* ignore */ }
      feed({ type: 'pause', at: now() })
    }
  }

  // Stop the current recorder (its last chunk still lands in this segment) and close the segment.
  // Registered in `ending`, so Stop can wait for a close a loss already started.
  function endSegment(endMs: number, live: Live = detachCurrent()): Promise<void> {
    const job = closeSegment(live, endMs)
    ending = ending.then(() => job)
    return job
  }
  async function closeSegment(live: Live, endMs: number): Promise<void> {
    const { rec, seg } = live
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
    stopTracks(live.stream)
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

  let reacquiring: Promise<boolean> | null = null
  function reacquire(): Promise<boolean> {
    if (reacquiring) return reacquiring
    reacquiring = doReacquire().finally(() => { reacquiring = null })
    return reacquiring
  }

  async function doReacquire(): Promise<boolean> {
    if (stopped) return false
    if (!lost) return true
    if (recovering) return false
    recovering = true
    emit('recovering')
    try {
      const next = await acquire()
      const nextTrack = typeof next.getAudioTracks === 'function' ? next.getAudioTracks()[0] : null
      if (nextTrack && nextTrack.readyState === 'ended') { stopTracks(next); throw new Error('ended') }
      if (stopped) { stopTracks(next); recovering = false; return false }
      const endMs = Math.round(env.clock())
      const gapMs = Math.max(0, endMs - (lostAtMs ?? endMs))
      // The audio is back once the new recorder has started; one that cannot be made or started
      // leaves it lost (and its stream stopped).
      try {
        beginSegment(next, ending, () => {
          gaps.push({ startMs: lostAtMs ?? endMs, endMs: Math.max(lostAtMs ?? endMs, endMs), reason: reason ?? 'unknown' })
          lost = false
          recovering = false
          reason = null
          lostAtMs = null
        })
      } catch (e) {
        stopTracks(next)
        throw e
      }
      emit('restored', { gapMs })
      return true
    } catch {
      recovering = false
      releaseStream()
      emit('retry-failed')
      return false
    }
  }

  // A device came or went. While recording: is the input still there (a loss if not)? While the
  // audio is lost: is the chosen input back (reopen it)? Any other input is never used by itself.
  const onDeviceChange = (): void => {
    const devices = navigator.mediaDevices
    if (stopped || !devices || typeof devices.enumerateDevices !== 'function') return
    const listening = track
    const settings = listening && typeof listening.getSettings === 'function' ? listening.getSettings() : null
    void devices.enumerateDevices().then((list) => {
      if (stopped) return
      if (listening && track === listening) feed({ type: 'device-change', at: now(), inputPresent: inputStillPresent(settings, list) })
      else if (!listening && lost && !recovering && env.inputReturned?.(list)) void reacquire()
    }).catch(() => { /* the stall watchdog still runs */ })
  }

  async function switchInput(): Promise<boolean> {
    if (recovering) await reacquire()
    if (stopped) return false
    if (lost) return reacquire()
    let next: MediaStream
    try {
      next = await acquire()
    } catch {
      return false
    }
    const nextTrack = typeof next.getAudioTracks === 'function' ? next.getAudioTracks()[0] : null
    if ((nextTrack && nextTrack.readyState === 'ended') || stopped || lost || recovering) { stopTracks(next); return lost && !stopped ? reacquire() : false }
    // The new input's recorder starts first, then the old one is stopped: the two overlap by the
    // moment the old one takes to stop, and no audio is lost. Its chunks wait until the old segment
    // is closed on disk. A switch is not a gap.
    // The old recorder stays in service (its listeners too) until the new one has started; if the
    // new one cannot be made or started, recording carries on with the old one as if nothing happened.
    let old: Live | null = null
    let opened = (): void => {}
    const oldClosed = new Promise<void>((resolve) => { opened = resolve })
    try {
      beginSegment(next, Promise.all([ending, oldClosed]), () => { old = detachCurrent() })
    } catch {
      stopTracks(next)
      opened()
      return false
    }
    const handed = old as Live | null
    if (handed) void endSegment(Math.round(env.clock()), handed).then(opened, opened)
    else opened()
    emit('switched')
    return true
  }

  return {
    async start(meta) {
      if (!stopped) return origin ?? { perf: now(), iso: new Date().toISOString() }
      let first: MediaStream
      acquireOp++
      try {
        first = await env.getStream()
      } catch (error) {
        if (error instanceof Error && ['input-gone', 'input-mismatch'].includes(error.message)) throw error
        throw new Error('mic')
      }
      mime = pickMimeType()
      segments = []
      chunkCounts = []
      gaps = []
      backlog = []
      memChunks = []
      onDisk = new Set()
      origin = null
      diskError = false
      ending = Promise.resolve()
      staged = Promise.resolve()
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
      await staged
      await chain
      // A later segment that produced no chunk holds no audio and has no file: it is left out. (In
      // memory mode every segment stays: its blob's place is its index.)
      const done: CapturedSegment[] = segments
        .filter((s) => mode === 'memory' || s.index === 0 || (chunkCounts[s.index] ?? 0) > 0)
        .map((s) => ({ index: s.index, startMs: s.startMs, endMs: s.endMs ?? endMs }))
      const type = mime ?? 'audio/webm'
      return {
        mode,
        sessionId,
        mimeType: type,
        blobs: mode === 'memory' ? done.map((s) => new Blob(memChunks[s.index] ?? [], { type })) : [],
        tail: backlog.slice(),
        segments: done,
        gaps: gaps.slice(),
        audioMs: audioMsFromSegments(done)
      }
    },

    reacquire,
    switchInput,
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
