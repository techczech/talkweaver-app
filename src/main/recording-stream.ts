// Recording chunk writer — audio reaches the disk as it is recorded, not at Stop.
//
// The presenter's recorder (src/preload/present-audio-capture.ts) delivers a MediaRecorder chunk
// about once a second; each one is appended here to the session's segment file under
// `<userData>/recordings/` (recording-paths.ts names them; nothing here takes a path from the
// renderer). Beside the audio, a small marker `<sessionId>.recording.json` says the recording is
// still in progress and carries what a Run needs if the app never reaches Stop: talk, start time,
// segment times, gaps, and the latest slide marks (refreshed by checkpoints).
//
// Guarantees:
//   • one writer: a session belongs to the webContents that opened it; another one is refused;
//   • append-only: bytes are written with O_APPEND and fsync'd at least every `fsyncEveryMs`, and
//     at every segment end, checkpoint and finalise — a crash keeps everything up to then;
//   • containment: files are named from a safe session id and a segment index only, inside the
//     recordings folder; a recordings folder that resolves elsewhere, or a link planted at a
//     segment path, is refused (O_NOFOLLOW) and nothing is written;
//   • nothing here deletes audio: `complete` and `discard` remove only the marker (the caller sends
//     discarded audio to the Trash);
//   • nothing is dropped at finalise: chunks the renderer still holds (`tail`) are appended to
//     their segment file — a segment main never managed to open gets its file then — and a
//     retried finalise resumes where the last one stopped, so no byte is written twice.
// No size cap: a chunk is whatever MediaRecorder delivered (~1 s of Opus, a few KB) and the tail
// is what one recording could not hand over. The stream channels are reached only from the
// recording preload of a present window TalkWeaver opened (one owner per session, checked here).

import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'fs'
import { join, resolve } from 'path'
import { isSafeRunId } from './runs.ts'
import { readbackSlideTimeIndex } from './run-ink-readback.ts'
import { localSegmentPath, streamMarkerPath } from './recording-paths.ts'
import type { RunAudioGap, RunAudioSegment } from '../shared/run-audio.ts'

export type StreamError =
  | 'unsafe-session-id'
  | 'unsafe-path'
  | 'already-open'
  | 'not-open'
  | 'not-owner'
  | 'bad-segment'
  | 'closed'
  | 'write-failed'

export type StreamResult<T = object> = ({ ok: true } & T) | { ok: false; error: StreamError; detail?: string }

export interface StreamManifest {
  version: 1
  sessionId: string
  talkSlug: string
  talkTitle: string
  startedAt: string
  mimeType: string
  timerTargetMin: number
  pathwayId: string | null
  /** Segment times on the recording clock; endMs is null while the segment is open. */
  segments: Array<{ index: number; startMs: number; endMs: number | null }>
  gaps: RunAudioGap[]
  /** The recorder's raw slide marks as of the last checkpoint. */
  rawMarks: unknown[]
  /** Pause-aware recording length as of the last checkpoint. */
  recordingMs: number
  updatedAt: string
}

export interface StreamOpenInput {
  sessionId: string
  talkSlug: string
  talkTitle?: string
  startedAt?: string
  mimeType?: string
  timerTargetMin?: number
  pathwayId?: string | null
}

export interface StreamCheckpoint {
  rawMarks?: unknown[]
  recordingMs?: number
  gaps?: RunAudioGap[]
}

/** A chunk the renderer could not hand over while recording; appended, in order, at finalise. */
export interface StreamTailChunk { index: number; bytes: Uint8Array }

/** What finalise is told: the checkpoint fields, plus the bridge's segment times. */
export interface StreamFinaliseData extends StreamCheckpoint {
  segments?: Array<{ index: number; startMs: number; endMs: number }>
}

export interface FinalisedStream {
  manifest: StreamManifest
  segments: RunAudioSegment[]
  bytes: number
}

export interface InterruptedStream extends FinalisedStream {
  markerPath: string
}

export interface RecordingStreams {
  open(owner: number, input: StreamOpenInput): StreamResult<{ sessionId: string }>
  /** `startedAt` (segment 0 only): when the recorder really started — the marker's start time. */
  startSegment(owner: number, sessionId: unknown, index: unknown, startMs: unknown, startedAt?: unknown): StreamResult<{ path: string }>
  append(owner: number, sessionId: unknown, index: unknown, bytes: Uint8Array): StreamResult<{ bytes: number }>
  endSegment(owner: number, sessionId: unknown, index: unknown, endMs: unknown): StreamResult
  checkpoint(owner: number, sessionId: unknown, data: StreamCheckpoint): StreamResult
  /** Close the files and report the segments. Idempotent; the marker stays until `complete`. */
  finalise(owner: number, sessionId: unknown, data?: StreamFinaliseData, tail?: StreamTailChunk[]): StreamResult<FinalisedStream>
  /** The Run is written: drop the marker and forget the session. */
  complete(sessionId: unknown): void
  /** Close and forget; returns the audio files for the caller to move to the Trash. */
  discard(owner: number, sessionId: unknown): StreamResult<{ files: string[] }>
  /** The owner went away (window closed or crashed): close its files, leave them interrupted. */
  closeOwner(owner: number): string[]
  isOpen(sessionId: unknown): boolean
  /**
   * How much of the held tail a failed finalise already wrote: chunks fully written, and bytes of
   * the next one. Null unless `owner` holds the session. The export skips exactly that much.
   */
  tailProgress(owner: number, sessionId: unknown): { done: number; offset: number } | null
  /** Markers on disk with no open session — recordings that never reached Stop. */
  listInterrupted(): InterruptedStream[]
}

interface Entry {
  owner: number
  manifest: StreamManifest
  fd: number | null
  fdIndex: number
  lastSync: number
  finalised: boolean
  /** Tail progress across finalise retries: chunks fully written, bytes of the next one written. */
  tailDone: number
  tailOffset: number
}

const finite = (value: unknown, fallback = 0): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : fallback
}

function normaliseGaps(value: unknown): RunAudioGap[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((gap) => {
    const raw = gap as { startMs?: unknown; endMs?: unknown; reason?: unknown }
    const startMs = finite(raw?.startMs, NaN)
    const endMs = finite(raw?.endMs, NaN)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return []
    return [{ startMs: Math.round(startMs), endMs: Math.round(endMs), reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 40) : 'unknown' }]
  })
}

/** Segment files with their sizes and times; the open last segment ends at `recordingMs`. */
export function segmentsFromManifest(manifest: StreamManifest, sizeOf: (index: number) => number | null): RunAudioSegment[] {
  const out: RunAudioSegment[] = []
  for (const seg of [...manifest.segments].sort((a, b) => a.index - b.index)) {
    const bytes = sizeOf(seg.index)
    if (bytes === null) continue
    const file = seg.index === 0 ? `${manifest.sessionId}.webm` : `${manifest.sessionId}.seg-${seg.index + 1}.webm`
    const startMs = Math.round(finite(seg.startMs))
    const endMs = Math.round(Math.max(startMs, seg.endMs === null ? finite(manifest.recordingMs) : finite(seg.endMs)))
    out.push({ file, bytes, startMs, endMs })
  }
  return out
}

export function createRecordingStreams(opts: { userDataDir: () => string; now?: () => number; fsyncEveryMs?: number }): RecordingStreams {
  const entries = new Map<string, Entry>()
  const now = opts.now ?? (() => Date.now())
  const fsyncEveryMs = opts.fsyncEveryMs ?? 2000

  // The recordings folder must be a real folder inside userData, not a link to somewhere else.
  function recordingsDirOk(): boolean {
    try {
      const userData = opts.userDataDir()
      const dir = resolve(userData, 'recordings')
      mkdirSync(dir, { recursive: true })
      if (lstatSync(dir).isSymbolicLink()) return false
      return realpathSync(dir) === join(realpathSync(userData), 'recordings')
    } catch {
      return false
    }
  }

  function writeMarker(manifest: StreamManifest): void {
    const target = streamMarkerPath(opts.userDataDir(), manifest.sessionId)
    if (!target.ok) throw new Error(target.error)
    manifest.updatedAt = new Date(now()).toISOString()
    const temp = `${target.path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(temp, target.path)
  }

  function syncAndClose(entry: Entry): void {
    if (entry.fd === null) return
    try { fsyncSync(entry.fd) } catch { /* best effort; close still flushes to the OS */ }
    try { closeSync(entry.fd) } catch { /* already closed */ }
    entry.fd = null
  }

  function owned(owner: number, sessionId: unknown): StreamResult<{ entry: Entry }> {
    if (!isSafeRunId(sessionId)) return { ok: false, error: 'unsafe-session-id' }
    const entry = entries.get(sessionId)
    if (!entry) return { ok: false, error: 'not-open' }
    if (entry.owner !== owner) return { ok: false, error: 'not-owner' }
    return { ok: true, entry }
  }

  function applyCheckpoint(manifest: StreamManifest, data: StreamCheckpoint | undefined): void {
    if (!data) return
    // The Pen's ink in the marks is checked (structure, caps, bytes) and rebuilt before the marker
    // is written; a bad ink mark is dropped, the other marks kept.
    if (Array.isArray(data.rawMarks)) manifest.rawMarks = readbackSlideTimeIndex(data.rawMarks.slice(0, 100_000))
    if (data.recordingMs !== undefined) manifest.recordingMs = Math.round(finite(data.recordingMs, manifest.recordingMs))
    if (data.gaps !== undefined) manifest.gaps = normaliseGaps(data.gaps)
  }

  function sizeOf(sessionId: string, index: number): number | null {
    const target = localSegmentPath(opts.userDataDir(), sessionId, index)
    if (!target.ok) return null
    try {
      const st = lstatSync(target.path)
      return st.isFile() ? st.size : null
    } catch {
      return null
    }
  }

  function finalised(manifest: StreamManifest): FinalisedStream {
    const segments = segmentsFromManifest(manifest, (index) => sizeOf(manifest.sessionId, index))
    return { manifest, segments, bytes: segments.reduce((sum, seg) => sum + seg.bytes, 0) }
  }

  const api: RecordingStreams = {
    open(owner, input) {
      const sessionId = input?.sessionId
      if (!isSafeRunId(sessionId)) return { ok: false, error: 'unsafe-session-id' }
      if (entries.has(sessionId)) return { ok: false, error: 'already-open' }
      const marker = streamMarkerPath(opts.userDataDir(), sessionId)
      if (!marker.ok) return { ok: false, error: marker.error === 'unsafe-session-id' ? 'unsafe-session-id' : 'unsafe-path' }
      if (!recordingsDirOk()) return { ok: false, error: 'unsafe-path' }
      const manifest: StreamManifest = {
        version: 1,
        sessionId,
        talkSlug: String(input.talkSlug ?? 'talk'),
        talkTitle: String(input.talkTitle ?? input.talkSlug ?? 'talk'),
        startedAt: String(input.startedAt ?? new Date(now()).toISOString()),
        mimeType: String(input.mimeType ?? 'audio/webm'),
        timerTargetMin: finite(input.timerTargetMin),
        pathwayId: typeof input.pathwayId === 'string' ? input.pathwayId : null,
        segments: [],
        gaps: [],
        rawMarks: [],
        recordingMs: 0,
        updatedAt: ''
      }
      try {
        writeMarker(manifest)
      } catch (e) {
        return { ok: false, error: 'write-failed', detail: String(e) }
      }
      entries.set(sessionId, { owner, manifest, fd: null, fdIndex: -1, lastSync: now(), finalised: false, tailDone: 0, tailOffset: 0 })
      return { ok: true, sessionId }
    },

    startSegment(owner, sessionId, index, startMs, startedAt) {
      const got = owned(owner, sessionId)
      if (!got.ok) return got
      const entry = got.entry
      if (entry.finalised) return { ok: false, error: 'closed' }
      // Segments are append-only: a higher index than any recorded, or the one already open (a
      // repeated call). An index may be skipped — a segment whose open was refused gets its file
      // at finalise, from the chunks the renderer kept.
      if (index === entry.fdIndex && entry.fd !== null) {
        const p = localSegmentPath(opts.userDataDir(), entry.manifest.sessionId, index)
        return p.ok ? { ok: true, path: p.path } : { ok: false, error: 'unsafe-path' }
      }
      const lastIndex = entry.manifest.segments.length ? entry.manifest.segments[entry.manifest.segments.length - 1].index : -1
      if (typeof index !== 'number' || !Number.isInteger(index) || index <= lastIndex) return { ok: false, error: 'bad-segment' }
      const target = localSegmentPath(opts.userDataDir(), entry.manifest.sessionId, index)
      if (!target.ok) return { ok: false, error: target.error === 'unsafe-session-id' ? 'unsafe-session-id' : 'unsafe-path' }
      if (!recordingsDirOk()) return { ok: false, error: 'unsafe-path' }
      syncAndClose(entry)
      const prev = entry.manifest.segments[entry.manifest.segments.length - 1]
      const start = Math.round(finite(startMs))
      if (prev && prev.endMs === null) prev.endMs = start
      let fd: number
      try {
        // O_NOFOLLOW: a link planted at the segment path is refused rather than followed.
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
        fd = openSync(target.path, flags, 0o644)
        if (!statSync(target.path).isFile()) { closeSync(fd); return { ok: false, error: 'unsafe-path' } }
      } catch (e) {
        return { ok: false, error: 'unsafe-path', detail: String(e) }
      }
      entry.fd = fd
      entry.fdIndex = index
      entry.lastSync = now()
      entry.manifest.segments.push({ index, startMs: start, endMs: null })
      if (index === 0 && typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt))) entry.manifest.startedAt = new Date(Date.parse(startedAt)).toISOString()
      try { writeMarker(entry.manifest) } catch { /* the audio file is what matters; the next checkpoint retries */ }
      return { ok: true, path: target.path }
    },

    append(owner, sessionId, index, bytes) {
      const got = owned(owner, sessionId)
      if (!got.ok) return got
      const entry = got.entry
      if (entry.finalised) return { ok: false, error: 'closed' }
      if (entry.fd === null || index !== entry.fdIndex) return { ok: false, error: 'bad-segment' }
      if (!(bytes instanceof Uint8Array)) return { ok: false, error: 'write-failed', detail: 'not bytes' }
      try {
        let offset = 0
        while (offset < bytes.byteLength) offset += writeSync(entry.fd, bytes, offset, bytes.byteLength - offset)
        if (now() - entry.lastSync >= fsyncEveryMs) {
          fsyncSync(entry.fd)
          entry.lastSync = now()
        }
      } catch (e) {
        return { ok: false, error: 'write-failed', detail: String(e) }
      }
      return { ok: true, bytes: bytes.byteLength }
    },

    endSegment(owner, sessionId, index, endMs) {
      const got = owned(owner, sessionId)
      if (!got.ok) return got
      const entry = got.entry
      const seg = entry.manifest.segments.find((s) => s.index === index)
      if (!seg) return { ok: false, error: 'bad-segment' }
      seg.endMs = Math.max(seg.startMs, Math.round(finite(endMs, seg.startMs)))
      if (entry.fdIndex === index) syncAndClose(entry)
      try { writeMarker(entry.manifest) } catch (e) { return { ok: false, error: 'write-failed', detail: String(e) } }
      return { ok: true }
    },

    checkpoint(owner, sessionId, data) {
      const got = owned(owner, sessionId)
      if (!got.ok) return got
      const entry = got.entry
      applyCheckpoint(entry.manifest, data)
      if (entry.fd !== null) {
        try { fsyncSync(entry.fd); entry.lastSync = now() } catch { /* next append retries */ }
      }
      try { writeMarker(entry.manifest) } catch (e) { return { ok: false, error: 'write-failed', detail: String(e) } }
      return { ok: true }
    },

    finalise(owner, sessionId, data, tail) {
      const got = owned(owner, sessionId)
      if (!got.ok) return got
      const entry = got.entry
      applyCheckpoint(entry.manifest, data)
      syncAndClose(entry)
      // Chunks the renderer still holds go to the end of their segment file, in the order given.
      // A segment main never opened is added now (its file created, its times from the bridge).
      // Progress is kept per chunk and per byte, so a retry after a failure resumes: never a
      // duplicate, never a gap. Any failure is an error — the save must not report success.
      const chunks = tail ?? []
      for (let k = entry.tailDone; k < chunks.length; k++) {
        const chunk = chunks[k]
        if (!chunk || typeof chunk.index !== 'number' || !Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index > 999 || !(chunk.bytes instanceof Uint8Array)) {
          return { ok: false, error: 'bad-segment', detail: `tail chunk ${k}` }
        }
        const target = localSegmentPath(opts.userDataDir(), entry.manifest.sessionId, chunk.index)
        if (!target.ok || !recordingsDirOk()) return { ok: false, error: 'unsafe-path' }
        if (!entry.manifest.segments.some((s) => s.index === chunk.index)) {
          const times = data?.segments?.find((s) => s.index === chunk.index)
          const startMs = Math.round(finite(times?.startMs))
          entry.manifest.segments.push({ index: chunk.index, startMs, endMs: times ? Math.max(startMs, Math.round(finite(times.endMs))) : null })
          entry.manifest.segments.sort((a, b) => a.index - b.index)
        }
        let fd: number | null = null
        try {
          fd = openSync(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o644)
          if (!statSync(target.path).isFile()) return { ok: false, error: 'unsafe-path' }
          while (entry.tailOffset < chunk.bytes.byteLength) {
            entry.tailOffset += writeSync(fd, chunk.bytes, entry.tailOffset, chunk.bytes.byteLength - entry.tailOffset)
          }
          fsyncSync(fd)
          entry.tailDone = k + 1
          entry.tailOffset = 0
        } catch (e) {
          return { ok: false, error: 'write-failed', detail: String(e) }
        } finally {
          if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
        }
      }
      // Segments still open end where the next one starts, the last at the recording's end.
      entry.manifest.segments.forEach((seg, i) => {
        if (seg.endMs !== null) return
        const next = entry.manifest.segments[i + 1]
        seg.endMs = Math.max(seg.startMs, next ? next.startMs : entry.manifest.recordingMs)
      })
      entry.finalised = true
      try { writeMarker(entry.manifest) } catch { /* the Run write that follows is what counts */ }
      return { ok: true, ...finalised(entry.manifest) }
    },

    complete(sessionId) {
      if (!isSafeRunId(sessionId)) return
      const entry = entries.get(sessionId)
      if (entry) syncAndClose(entry)
      entries.delete(sessionId)
      const marker = streamMarkerPath(opts.userDataDir(), sessionId)
      if (marker.ok) {
        try { rmSync(marker.path, { force: true }) } catch { /* a stale marker is recovered harmlessly */ }
      }
    },

    discard(owner, sessionId) {
      const got = owned(owner, sessionId)
      if (!got.ok) return got
      const entry = got.entry
      syncAndClose(entry)
      const files: string[] = []
      for (const seg of entry.manifest.segments) {
        const target = localSegmentPath(opts.userDataDir(), entry.manifest.sessionId, seg.index)
        if (target.ok && sizeOf(entry.manifest.sessionId, seg.index) !== null) files.push(target.path)
      }
      api.complete(entry.manifest.sessionId)
      return { ok: true, files }
    },

    closeOwner(owner) {
      const left: string[] = []
      for (const [sessionId, entry] of entries) {
        if (entry.owner !== owner) continue
        syncAndClose(entry)
        entries.delete(sessionId)
        left.push(sessionId)
      }
      return left
    },

    tailProgress(owner, sessionId) {
      const got = owned(owner, sessionId)
      return got.ok ? { done: got.entry.tailDone, offset: got.entry.tailOffset } : null
    },

    isOpen(sessionId) {
      return typeof sessionId === 'string' && entries.has(sessionId)
    },

    listInterrupted() {
      const out: InterruptedStream[] = []
      if (!recordingsDirOk()) return out
      const dir = resolve(opts.userDataDir(), 'recordings')
      let names: string[]
      try { names = readdirSync(dir) } catch { return out }
      for (const name of names) {
        if (!name.endsWith('.recording.json')) continue
        const sessionId = name.slice(0, -'.recording.json'.length)
        if (!isSafeRunId(sessionId) || entries.has(sessionId)) continue
        const marker = streamMarkerPath(opts.userDataDir(), sessionId)
        if (!marker.ok) continue
        try {
          if (!lstatSync(marker.path).isFile()) continue
          const raw = JSON.parse(readFileSync(marker.path, 'utf8')) as Partial<StreamManifest>
          if (raw?.sessionId !== sessionId) continue
          const manifest: StreamManifest = {
            version: 1,
            sessionId,
            talkSlug: String(raw.talkSlug ?? 'talk'),
            talkTitle: String(raw.talkTitle ?? raw.talkSlug ?? 'talk'),
            startedAt: String(raw.startedAt ?? ''),
            mimeType: String(raw.mimeType ?? 'audio/webm'),
            timerTargetMin: finite(raw.timerTargetMin),
            pathwayId: typeof raw.pathwayId === 'string' ? raw.pathwayId : null,
            segments: Array.isArray(raw.segments)
              ? raw.segments.flatMap((s) => Number.isInteger(s?.index) && s.index >= 0
                ? [{ index: s.index, startMs: finite(s.startMs), endMs: s.endMs === null || s.endMs === undefined ? null : finite(s.endMs) }]
                : [])
              : [],
            gaps: normaliseGaps(raw.gaps),
            rawMarks: Array.isArray(raw.rawMarks) ? raw.rawMarks : [],
            recordingMs: finite(raw.recordingMs),
            updatedAt: String(raw.updatedAt ?? '')
          }
          // A crash before the first segment was recorded in the marker: the first file may exist.
          if (!manifest.segments.length && sizeOf(sessionId, 0) !== null) manifest.segments.push({ index: 0, startMs: 0, endMs: null })
          out.push({ ...finalised(manifest), markerPath: marker.path })
        } catch {
          continue
        }
      }
      return out
    }
  }
  return api
}
