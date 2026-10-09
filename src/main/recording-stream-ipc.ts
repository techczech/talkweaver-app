// Streaming a recording to disk while it records — the main-process IPC for the presenter's audio
// capture (src/preload/present-audio-capture.ts). The bridge appends each MediaRecorder chunk as it
// arrives (recording:stream-*), every call scoped to the window that opened the stream; the
// writer is recording-stream.ts. recording:save (recording.ts) then names the files already
// written. A recording that never reaches Stop becomes a Run marked partial: at once when its
// window goes, else on the next launch (recoverInterruptedRecordings).

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { normaliseRun, writeRunFile, type RunMark, type RunRecord } from './runs'
import { existingSegmentPaths, saveTargets, segmentIndexOfFile, vaultSessionPath } from './recording-paths'
import { isSafeTalkSlug } from './runs'
import { createRecordingStreams, type RecordingStreams } from './recording-stream'
import { audioMsFromSegments, type RunAudioGap, type RunAudioSegment } from '../shared/run-audio'

/** The ledger functions streaming needs (compiler lib/16-presentation-ledger.mjs). */
export interface StreamLedger {
  newSessionId: (now: number, rand: () => number) => string
  buildSlideTimeIndex: (rawMarks: RunMark[]) => RunMark[]
}

export interface StreamIpcDeps {
  userDataDir: () => string
  vaultRoot: () => string | null
  ledger: () => Promise<StreamLedger | null>
  onSessionSaved?: (saved: { talkSlug: string; kind: 'delivery' | 'rehearsal' | 'recording'; runId: string }) => void
}

let streams: RecordingStreams | null = null
let streamDeps: StreamIpcDeps | null = null
const watchedSenders = new Set<number>()

export function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

export function normaliseTimeline(value: unknown): { segments: Array<{ index: number; startMs: number; endMs: number }>; gaps: RunAudioGap[] } {
  const raw = (value && typeof value === 'object' ? value : {}) as { segments?: unknown; gaps?: unknown }
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0)
  const segments = Array.isArray(raw.segments)
    ? raw.segments.flatMap((seg) => {
      const s = seg as { index?: unknown; startMs?: unknown; endMs?: unknown }
      return Number.isInteger(s?.index) && Number(s.index) >= 0 ? [{ index: Number(s.index), startMs: num(s.startMs), endMs: Math.max(num(s.startMs), num(s.endMs)) }] : []
    })
    : []
  const gaps = Array.isArray(raw.gaps)
    ? raw.gaps.flatMap((gap) => {
      const g = gap as { startMs?: unknown; endMs?: unknown; reason?: unknown }
      const startMs = num(g?.startMs)
      return [{ startMs, endMs: Math.max(startMs, num(g?.endMs)), reason: typeof g?.reason === 'string' ? g.reason.slice(0, 40) : 'unknown' }]
    })
    : []
  return { segments, gaps }
}

/**
 * The Run's `audio` block from the files on disk and the bridge's timeline. Segment times the
 * bridge sent win over the in-progress marker's; the audio length never exceeds the recording.
 */
export function audioBlock(
  r2Key: string,
  files: RunAudioSegment[],
  timeline: { segments: Array<{ index: number; startMs: number; endMs: number }>; gaps: RunAudioGap[] } | null,
  recordingMs: number,
  partial: boolean
): NonNullable<RunRecord['audio']> {
  // Paired by segment index (from the file name), never by position: a segment with no file on
  // disk must not shift the times of the ones after it.
  const segments = files.map((file) => {
    const index = segmentIndexOfFile(file.file)
    const t = index === null ? undefined : timeline?.segments.find((seg) => seg.index === index)
    return t ? { ...file, startMs: t.startMs, endMs: t.endMs } : file
  })
  const bytes = segments.reduce((sum, seg) => sum + seg.bytes, 0)
  const audioMs = Math.min(audioMsFromSegments(segments), recordingMs > 0 ? recordingMs : Number.POSITIVE_INFINITY)
  return {
    r2Key,
    bytes,
    uploaded: false,
    audioMs: Math.round(audioMs),
    segments,
    gaps: timeline?.gaps ?? [],
    ...(partial ? { partial: true } : {})
  }
}

/**
 * Recordings that never reached Stop become Runs marked partial, referencing the audio already on
 * disk. The audio files are never deleted; only the in-progress marker goes once the Run exists.
 * Returns how many Runs were written.
 */
export async function recoverInterruptedRecordings(): Promise<number> {
  const deps = streamDeps
  if (!deps || !streams) return 0
  let written = 0
  let L: StreamLedger | null = null
  try {
    L = await deps.ledger()
  } catch { /* slide timings are a bonus; the audio is what is kept */ }
  for (const found of streams.listInterrupted()) {
    try {
      const { manifest } = found
      const sessionId = manifest.sessionId
      if (found.bytes === 0) { streams.complete(sessionId); continue }
      const vault = deps.vaultRoot()
      const targets = saveTargets(vault, deps.userDataDir(), manifest.talkSlug, sessionId, false)
      if (!targets.ok) continue
      if (existsSync(targets.sessionJson)) { streams.complete(sessionId); continue }
      const lastEnd = found.segments.reduce((max, seg) => Math.max(max, seg.endMs), 0)
      const recordingMs = Math.max(manifest.recordingMs, lastEnd)
      const rawMarks = Array.isArray(manifest.rawMarks) ? manifest.rawMarks as RunMark[] : []
      const session = {
        id: sessionId,
        talkSlug: manifest.talkSlug,
        talkTitle: manifest.talkTitle,
        kind: 'delivery' as const,
        status: 'delivered' as const,
        startedAt: manifest.startedAt || new Date().toISOString(),
        endedAt: manifest.updatedAt || new Date().toISOString(),
        recordingMs,
        wallClockMs: recordingMs,
        timerTargetMin: manifest.timerTargetMin,
        context: null,
        pathwayId: manifest.pathwayId,
        audio: audioBlock(`presentations/${manifest.talkSlug}/${sessionId}/audio.webm`, found.segments, { segments: [], gaps: manifest.gaps }, recordingMs, true),
        transcript: null,
        slideTimeIndex: L && rawMarks.length ? L.buildSlideTimeIndex(rawMarks) : []
      }
      mkdirSync(dirname(targets.sessionJson), { recursive: true })
      if (vault && !vaultSessionPath(vault, manifest.talkSlug, sessionId).ok) continue
      writeRunFile(targets.sessionJson, normaliseRun(session))
      streams.complete(sessionId)
      written += 1
      deps.onSessionSaved?.({ talkSlug: manifest.talkSlug, kind: 'delivery', runId: sessionId })
    } catch (e) {
      console.warn('[recording] could not recover an interrupted recording:', e)
    }
  }
  return written
}

// When a present window goes (closed, crashed) mid-recording, its files are closed and the
// recording is recovered as a partial Run straight away.
function watchSender(sender: unknown): void {
  const wc = sender as { id: number; once?: (event: string, fn: () => void) => void; on?: (event: string, fn: () => void) => void }
  if (!wc || typeof wc.id !== 'number' || watchedSenders.has(wc.id)) return
  watchedSenders.add(wc.id)
  const id = wc.id
  const release = (): void => {
    if (!streams) return
    if (streams.closeOwner(id).length) void recoverInterruptedRecordings()
  }
  try {
    wc.once?.('destroyed', () => { watchedSenders.delete(id); release() })
    wc.on?.('render-process-gone', release)
  } catch { /* a test sender without events */ }
}

/** Install the recording:stream-* handlers; returns the writer recording:save finalises. */
export function registerRecordingStreamIpc(deps: StreamIpcDeps): RecordingStreams {
  streamDeps = deps
  streams = createRecordingStreams({ userDataDir: () => deps.userDataDir() })
  const store = streams
  ipcMain.handle('recording:stream-open', async (event, payload) => {
    try {
      // Refused here, not at recovery: a marker with a slug no Run path accepts would never become
      // a Run. The bridge then holds the audio in memory and saves it at Stop as before.
      if (!isSafeTalkSlug(payload?.talkSlug)) return { ok: false, error: 'unsafe-talk-slug' }
      const L = await deps.ledger()
      if (!L) return { ok: false, error: 'compiler-not-found' }
      const sessionId = L.newSessionId(Date.now(), Math.random)
      const res = store.open(event.sender.id, {
        sessionId,
        talkSlug: payload.talkSlug as string,
        talkTitle: String(payload?.talkTitle ?? payload.talkSlug),
        startedAt: typeof payload?.startedAt === 'string' ? payload.startedAt : undefined,
        mimeType: typeof payload?.mimeType === 'string' ? payload.mimeType : undefined,
        timerTargetMin: Number(payload?.timerTargetMin ?? 0),
        pathwayId: typeof payload?.pathwayId === 'string' ? payload.pathwayId : null
      })
      if (res.ok) watchSender(event.sender)
      return res.ok ? { ok: true, sessionId: res.sessionId } : { ok: false, error: res.error }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle('recording:stream-segment', (event, payload) => {
    const res = store.startSegment(event.sender.id, payload?.sessionId, payload?.index, payload?.startMs, payload?.startedAt)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  ipcMain.handle('recording:stream-append', (event, payload) => {
    const bytes = toBytes(payload?.bytes)
    if (!bytes) return { ok: false, error: 'no-bytes' }
    const res = store.append(event.sender.id, payload?.sessionId, payload?.index, bytes)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  ipcMain.handle('recording:stream-segment-end', (event, payload) => {
    const res = store.endSegment(event.sender.id, payload?.sessionId, payload?.index, payload?.endMs)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  ipcMain.handle('recording:stream-checkpoint', (event, payload) => {
    const res = store.checkpoint(event.sender.id, payload?.sessionId, {
      rawMarks: Array.isArray(payload?.rawMarks) ? payload.rawMarks : undefined,
      recordingMs: payload?.recordingMs,
      gaps: normaliseTimeline({ gaps: payload?.gaps }).gaps
    })
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })
  // Discard (a short recording the presenter chose not to keep): the files go to the Trash.
  ipcMain.handle('recording:stream-discard', async (event, payload) => {
    const res = store.discard(event.sender.id, payload?.sessionId)
    if (!res.ok) return { ok: false, error: res.error }
    for (const file of res.files) {
      try { await shell.trashItem(file) } catch (e) { console.warn('[recording] could not move discarded audio to the Trash:', e) }
    }
    return { ok: true }
  })
  // A save that failed (disk full, folder refused): write the audio the bridge still holds — after
  // whatever of each segment is already on disk — to a folder the presenter picks. One file per
  // segment, named from the talk; nothing is overwritten (a taken name gets a number).
  ipcMain.handle('recording:export-held-audio', async (event, payload) => {
    try {
      const parts = Array.isArray(payload?.parts)
        ? (payload.parts as Array<{ index?: unknown; bytes?: unknown }>).flatMap((p, k) => {
          const bytes = toBytes(p?.bytes)
          // `k` is the chunk's place in the held tail, the same order the save's finalise used.
          return bytes && Number.isInteger(p?.index) && Number(p.index) >= 0 && Number(p.index) < 1000 ? [{ k, index: Number(p.index), bytes }] : []
        })
        : []
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null
      // Only the window that owns the stream may export it; its files on disk already hold the
      // tail chunks a failed finalise wrote (all of the first `done`, `offset` bytes of the next),
      // so those are skipped — every chunk appears exactly once.
      const progress = sessionId ? store.tailProgress(event.sender.id, sessionId) : null
      if (sessionId && !progress) return { ok: false, error: 'not-owner' }
      const onDisk = sessionId ? existingSegmentPaths(deps.userDataDir(), sessionId) : []
      const held = parts.flatMap((p) => {
        if (!progress || p.k > progress.done) return [p]
        if (p.k < progress.done) return []
        return progress.offset < p.bytes.byteLength ? [{ ...p, bytes: p.bytes.subarray(progress.offset) }] : []
      })
      const indexes = new Set<number>(held.map((p) => p.index))
      for (const file of onDisk) {
        const index = segmentIndexOfFile(file.split(/[\\/]/).pop() ?? '')
        if (index !== null) indexes.add(index)
      }
      if (!indexes.size) return { ok: false, error: 'nothing-held' }
      const win = BrowserWindow.fromWebContents(event.sender)
      const picked = win
        ? await dialog.showOpenDialog(win, { title: 'Save the recording\'s audio to a folder', properties: ['openDirectory', 'createDirectory'] })
        : await dialog.showOpenDialog({ title: 'Save the recording\'s audio to a folder', properties: ['openDirectory', 'createDirectory'] })
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' }
      const folder = picked.filePaths[0]
      const base = (isSafeTalkSlug(payload?.talkSlug) ? payload.talkSlug as string : 'recording').replace(/[^\p{L}\p{N}_ -]+/gu, '-').slice(0, 80) || 'recording'
      const written: string[] = []
      for (const index of [...indexes].sort((a, b) => a - b)) {
        const diskFile = onDisk.find((f) => segmentIndexOfFile(f.split(/[\\/]/).pop() ?? '') === index)
        const chunks = [
          ...(diskFile ? [readFileSync(diskFile)] : []),
          ...held.filter((p) => p.index === index).map((p) => Buffer.from(p.bytes))
        ]
        let name = `${base} audio part ${index + 1}.webm`
        for (let n = 2; existsSync(join(folder, name)); n++) name = `${base} audio part ${index + 1} (${n}).webm`
        writeFileSync(join(folder, name), Buffer.concat(chunks), { flag: 'wx' })
        written.push(name)
      }
      return { ok: true, files: written }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  return store
}
