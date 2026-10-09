// Recording — the main-process half of the Presentation Ledger (Phase 1). This file owns
// everything the recording bridge (src/preload/present-recorder.ts) hands back:
//   • mic permission for the present window          (Task 4, below)
//   • local-first save: audio → userData, session.json → the Vault  (Task 5)
//   • R2 upload with an offline-safe retry queue       (Task 6)
//
// Design lock: ADR-0035 + docs/superpowers/specs/2026-07-05-presentation-recording-design.md.
// Guarantees: nothing here can lose a saved recording — audio is written to local disk
// before any network call, and uploads queue and retry so a dropped connection never loses
// anything. None of this touches the data-loss backstops for outlines (unrelated paths).

import { BrowserWindow, ipcMain, shell } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs'
import { readFile as readFileAsync } from 'fs/promises'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  applyRunPollBuffer,
  attachDeliveryToPlanned,
  listRuns,
  normaliseRun,
  persistRunForTalk,
  plannedRunCandidates,
  readRun,
  readRunForTalk,
  runPathForTalk,
  talkRunFolderForTalk,
  writeRunFile,
  type RunPoll,
  type RunPollResponse,
  type RunRecord,
} from './runs'
import {
  deleteTargets,
  existingSegmentPaths,
  localRecordingPath,
  localSegmentPath,
  saveTargets,
  sessionJsonPath,
  listSessionJsonFiles,
  streamMarkerPath,
  vaultSessionPath,
} from './recording-paths'
import type { FinalisedStream, RecordingStreams, StreamTailChunk } from './recording-stream'
import { audioBlock, normaliseTimeline, registerRecordingStreamIpc, toBytes } from './recording-stream-ipc'
import type { RunAudioFields, RunAudioSegment } from '../shared/run-audio'
import { createRecordingPermissions } from './recording-permissions'
import { appWindowIds } from './window-kinds'
import { sessionForList } from './run-ink-readback'

export { recoverInterruptedRecordings } from './recording-stream-ipc'

// ── Task 4: permissions ───────────────────────────────────────────────────────
// One table for every window from app start (recording-permissions.ts): the microphone ONLY to the
// main frame of an open presenter window and ONLY audio, so the bridge's getUserMedia({audio})
// resolves; full screen to any frame; clipboard write to a window's own page; clipboard read to the editor,
// Tools and Pathways pages; nothing else to anyone. The handlers are the session's (the default
// session) and are shared by every window.
const recordingPermissions = createRecordingPermissions({ appWindowIds })

/** At app start: from then on every permission request and check is answered by the table. */
export function installRecordingPermissions(session: Parameters<typeof recordingPermissions.install>[0]): void {
  recordingPermissions.install(session)
}

export function setupRecordingPermissions(win: BrowserWindow): void {
  recordingPermissions.addPresenter(win as unknown as Parameters<typeof recordingPermissions.addPresenter>[0])
}

/**
 * An editor, Tools or Pathways window, entered in the app's one list of such windows
 * (window-kinds.ts): its own page may read the clipboard, and its own links are the owner's.
 */
export function registerAppWindowPermissions(win: BrowserWindow): void {
  recordingPermissions.addAppWindow(win as unknown as Parameters<typeof recordingPermissions.addAppWindow>[0])
}

// ── Task 5: per-window context + local-first save ────────────────────────────

// What the bridge needs to stamp a session — supplied per present window by talk:present.
export interface RecordingContext {
  talkSlug: string
  talkTitle: string
  timerTargetMin: number
  pathwayId: string | null
  preferredPlannedRunId: string | null
}

// R2 storage config (Settings → Recording storage). Non-secret; the access keys are resolved
// separately (safeStorage or bws). Empty endpoint/bucket = not configured → uploads queue.
export interface R2Config {
  endpoint: string
  bucket: string
  credsSource: 'bws' | 'settings'
  bwsSecretId: string
}

// Main provides these so recording.ts stays decoupled from index.ts's config/path helpers.
export interface RecordingDeps {
  compilerDir: () => string | null // where lib/16-presentation-ledger.mjs lives (dev or packaged)
  userDataDir: () => string // app.getPath('userData')
  vaultRoot: () => string | null // the current vault's root (vault registry)
  discardThresholdMs: () => number // getConfig('recordingDiscardMs', 20000)
  r2Config: () => R2Config // Settings → Recording storage (endpoint/bucket/creds source)
  readSafeKeys: () => { accessKeyId: string; secretAccessKey: string } | null // safeStorage-decrypted keys
  testMode?: () => boolean // env flag for the e2e (synthetic audio + upload short-circuit)
  beforeCloseWindow?: (webContentsId: number, liveAction?: 'end' | 'keep') => Promise<{ ok: boolean; error?: string }>
  /** Called after a session is persisted (any kind) — the main window refreshes its talk facts
   *  (last-delivered dates in the panel/status bar) without a reload (T29). */
  /** After a Run is saved; `runId` lets a live session bound to it flush its history at once. */
  onSessionSaved?: (saved: { talkSlug: string; kind: RunKind; runId: string }) => void
}

// The slide-time index is data, so it round-trips as-is; the session shape is the spec's data model.
// reveal/highlight marks additionally carry hidden/marks so replay can reproduce in-slide state.
interface SlideTimeMark { event: string; slideId?: string; tMs: number; hidden?: number; marks?: number; space?: 'image'; image?: number; ink?: unknown }
type RunKind = 'delivery' | 'rehearsal' | 'recording'
type TrimRange = { start: number; end: number }
interface SessionJson {
  id: string
  talkSlug: string
  talkTitle: string
  kind: RunKind
  status?: 'planned' | 'delivered'
  plannedDate?: string
  eventTitle?: string
  audience?: string
  slideSet?: { kind: 'full' } | { kind: 'pathway'; pathwayId: string }
  handoutUrl?: string
  startedAt: string
  endedAt: string
  recordingMs: number
  wallClockMs: number
  timerTargetMin: number
  context: string | null
  pathwayId: string | null
  audio: ({ r2Key: string; bytes: number; uploaded: boolean } & RunAudioFields) | null
  transcript: null
  trims?: TrimRange[]
  slideTimeIndex: SlideTimeMark[]
}

// The pure ledger module (compiler/scripts/lib/16-presentation-ledger.mjs) — the same math the
// node tests pin. Loaded from the compiler dir (dev repo or packaged resources), memoised.
interface LedgerModule {
  newSessionId: (now: number, rand: () => number) => string
  recordingMsFromMarks: (marks: SlideTimeMark[]) => number
  buildSlideTimeIndex: (rawMarks: SlideTimeMark[]) => SlideTimeMark[]
  isDiscardable: (recordingMs: number, thresholdMs: number) => boolean
  serialiseSession: (session: unknown) => string
  parseSession: (text: string) => unknown
}
let ledgerMod: LedgerModule | null = null
async function loadLedger(compilerDir: string): Promise<LedgerModule> {
  if (!ledgerMod) {
    ledgerMod = (await import(
      pathToFileURL(join(compilerDir, 'lib/16-presentation-ledger.mjs')).href
    )) as unknown as LedgerModule
  }
  return ledgerMod
}

// Per-present-window context, keyed by webContents id (several presents can be open).
const contexts = new Map<number, RecordingContext>()
const runStates = new Map<number, {
  talkSlug: string
  sessionId?: string
  saved: boolean
  gatePassed: boolean
  audioArmed: boolean
  lastSlideReached: boolean
  wallMs: number
  forwardAdvances: number
}>()
const livePollBuffers = new Map<number, { polls: RunPoll[]; responses: RunPollResponse[] }>()

function pollBuffer(webContentsId: number): { polls: RunPoll[]; responses: RunPollResponse[] } {
  const existing = livePollBuffers.get(webContentsId)
  if (existing) return existing
  const created = { polls: [], responses: [] }
  livePollBuffers.set(webContentsId, created)
  return created
}

function persistLivePollBuffer(webContentsId: number, vaultRoot: string | null): boolean {
  const state = runStates.get(webContentsId)
  const buffer = livePollBuffers.get(webContentsId)
  if (!vaultRoot || !state?.sessionId || !buffer || (!buffer.polls.length && !buffer.responses.length)) return false
  // talkSlug/sessionId come from the renderer (recording:run-state): read and write only the
  // guarded Run path for that talk.
  const run = readRunForTalk(vaultRoot, state.talkSlug, state.sessionId)
  if (!run) return false
  persistRunForTalk(vaultRoot, state.talkSlug, state.sessionId, applyRunPollBuffer(run, buffer))
  livePollBuffers.delete(webContentsId)
  return true
}

export function bufferLiveRunPoll(webContentsId: number, poll: RunPoll, vaultRoot: string | null): void {
  try {
    const buffer = pollBuffer(webContentsId)
    buffer.polls = [...buffer.polls.filter((item) => item.id !== poll.id), poll]
    livePollBuffers.set(webContentsId, buffer)
    persistLivePollBuffer(webContentsId, vaultRoot)
  } catch { /* live interaction must never interrupt presenting */ }
}

export function bufferLiveRunPollResponse(webContentsId: number, response: RunPollResponse, vaultRoot: string | null): void {
  try {
    pollBuffer(webContentsId).responses.push(response)
    persistLivePollBuffer(webContentsId, vaultRoot)
  } catch { /* live interaction must never interrupt presenting */ }
}
export function registerRecordingContext(webContentsId: number, ctx: RecordingContext): void {
  contexts.set(webContentsId, ctx)
}
export function unregisterRecordingContext(webContentsId: number): void {
  contexts.delete(webContentsId)
  runStates.delete(webContentsId)
  livePollBuffers.delete(webContentsId)
}
export function shouldOfferRunSave(webContentsId: number): boolean {
  const s = runStates.get(webContentsId)
  return !!s && !s.saved && s.gatePassed && !s.audioArmed
}
export function recordingAudioArmed(webContentsId: number): boolean {
  return !!runStates.get(webContentsId)?.audioArmed
}
export function recordingRunReference(webContentsId: number): { talkSlug: string; runId: string } | null {
  const state = runStates.get(webContentsId)
  return state?.sessionId ? { talkSlug: state.talkSlug, runId: state.sessionId } : null
}
export function sendRecordingCloseOffer(win: BrowserWindow, offer?: { live: boolean; offerRunSave: boolean; audioArmed?: boolean }): void {
  if (!win.isDestroyed()) win.webContents.send('recording:show-close-offer', offer ?? {
    live: false,
    offerRunSave: shouldOfferRunSave(win.webContents.id),
    audioArmed: recordingAudioArmed(win.webContents.id)
  })
}

// ── R2 upload — direct, on request only (never automatic) ────────────────────

// Resolve the R2 access keys. 'settings' = the safeStorage-decrypted keys entered in Settings;
// 'bws' = shell out to the Bitwarden Secrets CLI for a secret whose value is JSON
// {accessKeyId, secretAccessKey} (the machine convention). null when unconfigured/unavailable.
async function readR2Creds(deps: RecordingDeps): Promise<{ accessKeyId: string; secretAccessKey: string } | null> {
  const cfg = deps.r2Config()
  if (cfg.credsSource === 'bws') {
    if (!cfg.bwsSecretId) return null
    try {
      const out = execFileSync('bws', ['secret', 'get', cfg.bwsSecretId, '--output', 'json'], { encoding: 'utf8' })
      const parsed = JSON.parse(out) as { value?: string }
      const creds = JSON.parse(typeof parsed.value === 'string' ? parsed.value : '') as {
        accessKeyId?: string
        secretAccessKey?: string
      }
      if (creds.accessKeyId && creds.secretAccessKey) {
        return { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
      }
      return null
    } catch (e) {
      // bws missing from PATH (packaged app), not logged in, or the secret is shaped differently.
      console.warn('[recording] bws R2 creds unavailable:', e)
      return null
    }
  }
  return deps.readSafeKeys()
}

// Flip a session.json's audio.uploaded to true once its audio is safely in R2, so History/Studio
// stop showing "upload pending". Plain JSON so it never depends on the compiler being present.
function patchSessionUploaded(sessionJsonPath: string): void {
  try {
    if (!existsSync(sessionJsonPath)) return
    const s = JSON.parse(readFileSync(sessionJsonPath, 'utf8')) as { audio?: { uploaded?: boolean } }
    if (s?.audio) {
      s.audio.uploaded = true
      writeFileSync(sessionJsonPath, JSON.stringify(s, null, 2), 'utf8')
    }
  } catch (e) {
    console.warn('[recording] could not patch session.json uploaded flag:', e)
  }
}

// e2e only: record the Key an upload WOULD have used, so the harness can assert the upload path
// ran with the right key — without a network or real R2.
function appendUploadMock(deps: RecordingDeps, r2Key: string, bytes: number): void {
  try {
    const p = join(deps.userDataDir(), 'recording-r2-mock.jsonl')
    appendFileSync(p, JSON.stringify({ r2Key, bytes }) + '\n')
  } catch {
    /* mock is best-effort */
  }
}

function normaliseKind(value: unknown): RunKind {
  return value === 'rehearsal' || value === 'recording' ? value : 'delivery'
}

function normaliseTrims(value: unknown): TrimRange[] {
  if (!Array.isArray(value)) return []
  const ranges = value
    .map((trim) => {
      const raw = trim as { start?: unknown; end?: unknown }
      const start = Number(raw?.start)
      const end = Number(raw?.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      const a = Math.max(0, Math.round(start))
      const b = Math.max(0, Math.round(end))
      return b > a ? { start: a, end: b } : null
    })
    .filter((trim): trim is TrimRange => trim !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const merged: TrimRange[] = []
  for (const trim of ranges) {
    const prev = merged[merged.length - 1]
    if (prev && trim.start <= prev.end) {
      prev.end = Math.max(prev.end, trim.end)
    } else {
      merged.push({ ...trim })
    }
  }
  return merged
}

// Every renderer-supplied talk slug / session id reaches the disk through recording-paths.ts,
// which refuses unsafe names (the handler then returns that error and touches nothing).
function sessionPath(deps: RecordingDeps, talkSlug: unknown, sessionId: unknown) {
  return sessionJsonPath(deps.vaultRoot(), deps.userDataDir(), talkSlug, sessionId)
}

// Install the two IPC handlers the bridge calls: recording:context (on load) and
// recording:save (on stop). Registered once at startup; the deps are read lazily per call.
export function registerRecordingIpc(deps: RecordingDeps): void {
  // Audio streams to disk while recording (recording:stream-*; recording-stream-ipc.ts).
  const streamStore: RecordingStreams = registerRecordingStreamIpc({
    userDataDir: () => deps.userDataDir(),
    vaultRoot: () => deps.vaultRoot(),
    ledger: async () => {
      const compilerDir = deps.compilerDir()
      return compilerDir ? await loadLedger(compilerDir) : null
    },
    onSessionSaved: deps.onSessionSaved
  })

  ipcMain.handle('recording:context', (event) => {
    const ctx = contexts.get(event.sender.id)
    return {
      talkSlug: ctx?.talkSlug ?? 'talk',
      talkTitle: ctx?.talkTitle ?? ctx?.talkSlug ?? 'talk',
      timerTargetMin: ctx?.timerTargetMin ?? 0,
      pathwayId: ctx?.pathwayId ?? null,
      preferredPlannedRunId: ctx?.preferredPlannedRunId ?? null,
      discardThresholdMs: deps.discardThresholdMs(),
      testMode: deps.testMode ? deps.testMode() : process.env.TW_REC_TEST === '1'
    }
  })

  ipcMain.handle('recording:save', async (event, payload) => {
    try {
      const compilerDir = deps.compilerDir()
      if (!compilerDir) return { ok: false, error: 'compiler-not-found' }
      const L = await loadLedger(compilerDir)

      const rawMarks: SlideTimeMark[] = Array.isArray(payload?.rawMarks) ? payload.rawMarks : []
      const mode: 'recording' | 'run' = payload?.mode === 'run' ? 'run' : 'recording'
      const kind = normaliseKind(payload?.kind)
      const rawElapsedMs = rawMarks.reduce((max, mark) => Math.max(max, Number(mark?.tMs) || 0), 0)
      const payloadWallClockMs = Number(payload?.wallClockMs)
      const runWallClockMs = Number.isFinite(payloadWallClockMs) ? Math.max(0, payloadWallClockMs) : rawElapsedMs
      const recordingMs = mode === 'run' ? 0 : L.recordingMsFromMarks(rawMarks)
      const discardMs = mode === 'run' ? runWallClockMs : recordingMs
      // A short run normally prompts Keep/Discard in the bridge, which sends force=true on Keep.
      // This is the backstop: discard a short unforced save (e.g. a stale caller), never a kept one.
      if (!payload?.force && L.isDiscardable(discardMs, deps.discardThresholdMs())) {
        return { ok: true, discarded: true }
      }

      const talkSlug = String(payload?.talkSlug ?? 'talk')
      const requestedPlannedId = typeof payload?.plannedRunId === 'string' ? payload.plannedRunId : ''
      const vault = deps.vaultRoot()
      const plannedPath = requestedPlannedId && vault ? runPathForTalk(vault, talkSlug, requestedPlannedId) : null
      const planned = plannedPath && vault ? readRun(vault, talkSlug, requestedPlannedId) : null
      if (requestedPlannedId && (!planned || planned.status !== 'planned')) {
        return { ok: false, error: 'planned-run-not-found' }
      }
      // Audio already streamed to disk while recording: the session id is the stream's, and the
      // files are the ones main wrote (plus any chunks the bridge could not hand over in time).
      const streamId = mode === 'recording' && typeof payload?.stream?.sessionId === 'string' ? payload.stream.sessionId as string : null
      if (streamId && requestedPlannedId) return { ok: false, error: 'planned-run-not-allowed' }
      let streamed: FinalisedStream | null = null
      if (streamId) {
        const tail: StreamTailChunk[] = Array.isArray(payload?.stream?.tail)
          ? (payload.stream.tail as Array<{ index?: unknown; bytes?: unknown }>).flatMap((chunk) => {
            const bytes = toBytes(chunk?.bytes)
            return bytes && Number.isInteger(chunk?.index) ? [{ index: Number(chunk.index), bytes }] : []
          })
          : []
        const segmentTimes = payload?.audioTimeline ? normaliseTimeline(payload.audioTimeline).segments : undefined
        const fin = streamStore.finalise(event.sender.id, streamId, { recordingMs, segments: segmentTimes }, tail)
        if (!fin.ok) return { ok: false, error: `stream-${fin.error}` }
        streamed = fin
      }
      const sessionId = streamId ?? planned?.id ?? L.newSessionId(Date.now(), Math.random)
      const audioBuf = mode === 'recording' && !streamed ? Buffer.from(payload.audio as ArrayBuffer) : null
      const extraBufs = audioBuf && Array.isArray(payload?.extraAudio)
        ? (payload.extraAudio as unknown[]).flatMap((b) => { const bytes = toBytes(b); return bytes ? [Buffer.from(bytes)] : [] })
        : []
      // Both paths are settled (and refused if unsafe) before anything is written.
      const targets = saveTargets(vault, deps.userDataDir(), talkSlug, sessionId, !!audioBuf)
      if (!targets.ok) return { ok: false, error: targets.error }
      const extraTargets = extraBufs.map((_, i) => localSegmentPath(deps.userDataDir(), sessionId, i + 1))
      if (extraTargets.some((t) => !t.ok)) return { ok: false, error: 'unsafe-path' }

      // 1) LOCAL FIRST — audio to disk before any network call, so a dropped connection
      //    (or an unconfigured R2) can never lose the recording.
      const recDir = join(deps.userDataDir(), 'recordings')
      if (!existsSync(recDir)) mkdirSync(recDir, { recursive: true })
      const memoryFiles: RunAudioSegment[] = []
      if (audioBuf && targets.audio) {
        writeFileSync(targets.audio, audioBuf)
        memoryFiles.push({ file: `${sessionId}.webm`, bytes: audioBuf.byteLength, startMs: 0, endMs: recordingMs })
        extraBufs.forEach((buf, i) => {
          const t = extraTargets[i]
          if (!t.ok) return
          writeFileSync(t.path, buf)
          memoryFiles.push({ file: `${sessionId}.seg-${i + 2}.webm`, bytes: buf.byteLength, startMs: 0, endMs: recordingMs })
        })
      }
      const timeline = payload?.audioTimeline ? normaliseTimeline(payload.audioTimeline) : null

      // 2) session.json (metadata + slide-time index) → the Vault Presentation Ledger.
      const startedAt = String(payload?.startedAt ?? new Date().toISOString())
      const endedAt = new Date().toISOString()
      const started = Date.parse(startedAt)
      const wallClockMs = mode === 'run'
        ? runWallClockMs
        : Number.isFinite(started) ? Math.max(0, Date.parse(endedAt) - started) : 0
      const r2Key = `presentations/${talkSlug}/${sessionId}/audio.webm`
      const session: SessionJson = {
        id: sessionId,
        talkSlug,
        talkTitle: String(payload?.talkTitle ?? talkSlug),
        kind,
        status: 'delivered',
        startedAt,
        endedAt,
        recordingMs,
        wallClockMs,
        timerTargetMin: Number(payload?.timerTargetMin ?? 0),
        context: null,
        pathwayId: typeof payload?.pathwayId === 'string' ? payload.pathwayId : null,
        audio: streamed
          ? audioBlock(r2Key, streamed.segments, timeline, recordingMs, false)
          : audioBuf
            ? timeline ? audioBlock(r2Key, memoryFiles, timeline, recordingMs, false) : { r2Key, bytes: audioBuf.byteLength, uploaded: false }
            : null,
        transcript: null,
        slideTimeIndex: L.buildSlideTimeIndex(rawMarks) as SlideTimeMark[]
      }
      const baseSession = planned
        ? attachDeliveryToPlanned(planned, normaliseRun(session))
        : normaliseRun(session)
      const pendingPolls = livePollBuffers.get(event.sender.id)
      const finalSession: RunRecord = pendingPolls
        ? applyRunPollBuffer(baseSession, pendingPolls)
        : baseSession
      // Vault is the home; if none is configured, keep the session.json beside the audio so a
      // record still survives (it just isn't in the synced Ledger).
      const sessionDir = dirname(targets.sessionJson)
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })
      // Re-check once the folder exists: it must still resolve inside the vault.
      if (vault && !vaultSessionPath(vault, talkSlug, sessionId).ok) return { ok: false, error: 'unsafe-path' }
      // The same atomic writer as every other Run write (temporary file, then rename): a live
      // session's history flush may write this Run too, and a reader never sees half a file.
      writeRunFile(targets.sessionJson, finalSession)
      // The Run names the audio now: the in-progress marker can go (the audio stays).
      if (streamId) streamStore.complete(streamId)
      if (pendingPolls) livePollBuffers.delete(event.sender.id)
      deps.onSessionSaved?.({ talkSlug, kind, runId: sessionId })

      // 3) Local-first is the whole story on save (Dominik's call): the recording lives on this
      //    machine, uploaded:false. R2 upload is ON REQUEST — the Studio "Upload to R2" action
      //    calls recording:upload, which enqueues + drains (and retries if offline). Nothing goes
      //    to the network automatically.

      return { ok: true, sessionId, discarded: false, kind }
    } catch (e) {
      console.error('[recording:save]', e)
      return { ok: false, error: String(e) }
    }
  })

  // The minimum Studio/History (Plans 2–3) need now: the Sessions recorded for a talk, read
  // straight from the Vault Presentation Ledger, newest first. [] when no vault / no recordings.
  ipcMain.handle('recording:list-sessions', async (_event, talkSlug: string) => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return []
      const out: unknown[] = []
      for (const file of await listSessionJsonFiles(vault, talkSlug)) {
        try {
          // A file whose root is not a session (null, an array, a number) is skipped: it would
          // break the sort below and blank the whole list.
          const session = sessionForList(JSON.parse(await readFileAsync(file, 'utf8')))
          if (session) out.push(session)
        } catch {
          /* skip an unreadable session file rather than failing the whole list */
        }
      }
      out.sort((a, b) =>
        String((b as { startedAt?: string }).startedAt ?? '').localeCompare(
          String((a as { startedAt?: string }).startedAt ?? '')
        )
      )
      return out
    } catch {
      return []
    }
  })

  // Every recorded Session across all talks (Studio's rail), newest first. [] with no vault.
  ipcMain.handle('recording:list-all-sessions', async () => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return []
      const out: unknown[] = []
      // Every talk folder and session file is checked to resolve inside the vault first.
      for (const file of await listSessionJsonFiles(vault)) {
        try {
          // A file whose root is not a session (null, an array, a number) is skipped: it would
          // break the sort below and blank the whole list.
          const session = sessionForList(JSON.parse(await readFileAsync(file, 'utf8')))
          if (session) out.push(session)
        } catch {
          /* skip an unreadable session file */
        }
      }
      out.sort((a, b) =>
        String((b as { startedAt?: string }).startedAt ?? '').localeCompare(
          String((a as { startedAt?: string }).startedAt ?? '')
        )
      )
      return out
    } catch {
      return []
    }
  })

  ipcMain.handle('recording:planned-runs', (event, talkSlug: string, pathwayId: string | null) => {
    const vault = deps.vaultRoot()
    if (!vault) return []
    if (!talkRunFolderForTalk(vault, talkSlug)) return []
    const preferredId = contexts.get(event.sender.id)?.preferredPlannedRunId
    return plannedRunCandidates(listRuns(vault, String(talkSlug)), pathwayId ? String(pathwayId) : null).map((run) => ({
      ...run,
      preferred: preferredId ? run.id === preferredId : !!pathwayId && run.slideSet.kind === 'pathway' && run.slideSet.pathwayId === pathwayId
    }))
  })

  // Upload ONE session to R2 — a direct, one-shot action that runs ONLY on the user's click
  // (Dominik's call: never automatic). No queue, no background retry: on failure the recording
  // stays local and Studio offers a manual retry. Local is always the safe default.
  ipcMain.handle('recording:upload', async (_event, { talkSlug, sessionId }: { talkSlug: string; sessionId: string }) => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const cfg = deps.r2Config()
      if (!cfg.endpoint || !cfg.bucket) return { ok: false, error: 'r2-not-configured' }
      const target = vaultSessionPath(vault, talkSlug, sessionId)
      if (!target.ok) return { ok: false, error: target.error }
      const audioTarget = localRecordingPath(deps.userDataDir(), sessionId, 'webm')
      if (!audioTarget.ok) return { ok: false, error: audioTarget.error }
      const sessionJsonPath = target.path
      if (!existsSync(sessionJsonPath)) return { ok: false, error: 'session-not-found' }
      const session = JSON.parse(readFileSync(sessionJsonPath, 'utf8')) as {
        audio?: { uploaded?: boolean; r2Key?: string; bytes?: number } | null
      }
      if (!session?.audio) return { ok: false, error: 'not-recorded' }
      if (session?.audio?.uploaded) return { ok: true, uploaded: true }
      const audioPath = audioTarget.path
      if (!existsSync(audioPath)) return { ok: false, error: 'audio-missing' }
      const r2Key = session.audio?.r2Key ?? `presentations/${talkSlug}/${sessionId}/audio.webm`

      if (deps.testMode && deps.testMode()) {
        // e2e: record the intended Key without a network, then flip uploaded.
        appendUploadMock(deps, r2Key, session.audio?.bytes ?? 0)
        patchSessionUploaded(sessionJsonPath)
        return { ok: true, uploaded: true }
      }

      const creds = await readR2Creds(deps)
      if (!creds) return { ok: false, error: 'r2-no-credentials' }
      const s3 = new S3Client({ region: 'auto', endpoint: cfg.endpoint, credentials: creds, forcePathStyle: true })
      await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: r2Key, Body: readFileSync(audioPath), ContentType: 'audio/webm' }))
      patchSessionUploaded(sessionJsonPath)
      return { ok: true, uploaded: true }
    } catch (e) {
      // Offline / R2 error — nothing is lost, the recording is still on this Mac.
      return { ok: false, error: String(e) }
    }
  })

  // Edit a session's context label ("Oxford AICC · lunch"), or clear it (null).
  ipcMain.handle('recording:set-context', (_event, { talkSlug, sessionId, context }: { talkSlug: string; sessionId: string; context: string }) => {
    try {
      const vault = deps.vaultRoot()
      if (!vault) return { ok: false, error: 'no-vault' }
      const target = vaultSessionPath(vault, talkSlug, sessionId)
      if (!target.ok) return { ok: false, error: target.error }
      const p = target.path
      if (!existsSync(p)) return { ok: false, error: 'session-not-found' }
      const s = JSON.parse(readFileSync(p, 'utf8')) as { context?: string | null }
      s.context = context && String(context).trim() ? String(context).trim() : null
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('recording:set-kind', (_event, { talkSlug, sessionId, kind }: { talkSlug: string; sessionId: string; kind: RunKind }) => {
    try {
      const target = sessionPath(deps, talkSlug, sessionId)
      if (!target.ok) return { ok: false, error: target.error }
      const p = target.path
      if (!existsSync(p)) return { ok: false, error: 'session-not-found' }
      const s = JSON.parse(readFileSync(p, 'utf8')) as { kind?: RunKind }
      s.kind = normaliseKind(kind)
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
      return { ok: true, kind: s.kind }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('recording:set-trims', (_event, { talkSlug, sessionId, trims }: { talkSlug: string; sessionId: string; trims: TrimRange[] }) => {
    try {
      const target = sessionPath(deps, talkSlug, sessionId)
      if (!target.ok) return { ok: false, error: target.error }
      const p = target.path
      if (!existsSync(p)) return { ok: false, error: 'session-not-found' }
      const s = JSON.parse(readFileSync(p, 'utf8')) as { trims?: TrimRange[] }
      const next = normaliseTrims(trims)
      if (next.length) s.trims = next
      else delete s.trims
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
      return { ok: true, trims: next }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('recording:finalise-run', async (_event, payload) => {
    try {
      const compilerDir = deps.compilerDir()
      if (!compilerDir) return { ok: false, error: 'compiler-not-found' }
      const L = await loadLedger(compilerDir)
      const talkSlug = String(payload?.talkSlug ?? 'talk')
      const sessionId = String(payload?.sessionId ?? '')
      if (!sessionId) return { ok: false, error: 'session-id-required' }
      const target = sessionPath(deps, talkSlug, sessionId)
      if (!target.ok) return { ok: false, error: target.error }
      const p = target.path
      if (!existsSync(p)) return { ok: false, error: 'session-not-found' }
      const s = JSON.parse(readFileSync(p, 'utf8')) as SessionJson
      if (s.audio !== null) return { ok: false, error: 'audio-run' }
      const rawMarks: SlideTimeMark[] = Array.isArray(payload?.rawMarks) ? payload.rawMarks : []
      const endedAt = String(payload?.endedAt ?? new Date().toISOString())
      const explicitWallMs = Number(payload?.wallClockMs)
      const started = Date.parse(s.startedAt)
      s.kind = normaliseKind(s.kind)
      s.endedAt = endedAt
      s.wallClockMs = Number.isFinite(explicitWallMs)
        ? Math.max(0, explicitWallMs)
        : Number.isFinite(started) ? Math.max(0, Date.parse(endedAt) - started) : s.wallClockMs
      s.slideTimeIndex = L.buildSlideTimeIndex(rawMarks) as SlideTimeMark[]
      // Atomic, like every other Run write: a crash mid-write never truncates the Run.
      writeRunFile(p, s as unknown as RunRecord)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('recording:run-state', (event, state) => {
    const current = contexts.get(event.sender.id)
    const next = {
      talkSlug: String(state?.talkSlug ?? current?.talkSlug ?? 'talk'),
      sessionId: state?.sessionId ? String(state.sessionId) : undefined,
      saved: !!state?.saved,
      gatePassed: !!state?.gatePassed,
      audioArmed: !!state?.audioArmed,
      lastSlideReached: !!state?.lastSlideReached,
      wallMs: Number.isFinite(Number(state?.wallMs)) ? Math.max(0, Number(state.wallMs)) : 0,
      forwardAdvances: Number.isFinite(Number(state?.forwardAdvances)) ? Math.max(0, Number(state.forwardAdvances)) : 0
    }
    runStates.set(event.sender.id, next)
    return { ok: true }
  })

  ipcMain.handle('recording:close-window', async (event, liveAction?: unknown) => {
    if (liveAction !== undefined && liveAction !== 'end' && liveAction !== 'keep') {
      return { ok: false, error: 'Invalid live session close choice.' }
    }
    if (recordingAudioArmed(event.sender.id)) {
      return { ok: false, error: 'Save the recording before closing the presentation.' }
    }
    try {
      const result = await deps.beforeCloseWindow?.(event.sender.id, liveAction)
      if (result && !result.ok) return result
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) win.destroy()
      runStates.delete(event.sender.id)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  // Delete a session — session.json + local audio go to the OS Trash (recoverable).
  ipcMain.handle('recording:delete-session', async (_event, { talkSlug, sessionId }: { talkSlug: string; sessionId: string }) => {
    try {
      const targets = deleteTargets(deps.vaultRoot(), deps.userDataDir(), talkSlug, sessionId)
      if (!targets.ok) return { ok: false, error: targets.error }
      const p = targets.sessionJson
      const audioPath = targets.audio
      // Later segments of a recording that lost and regained its input (listed before the first goes).
      const extraSegments = existingSegmentPaths(deps.userDataDir(), sessionId).slice(1)
      if (p && existsSync(p)) await shell.trashItem(p)
      if (existsSync(audioPath)) await shell.trashItem(audioPath)
      for (const extra of extraSegments) await shell.trashItem(extra)
      const marker = streamMarkerPath(deps.userDataDir(), sessionId)
      if (marker.ok && existsSync(marker.path) && !streamStore.isOpen(sessionId)) await shell.trashItem(marker.path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}

// The local audio file for a session — served to the renderer's <audio> via the twrec:// protocol.
// null when the session id is not a safe single name.
export function recordingAudioPath(userDataDir: string, sessionId: string): string | null {
  const target = localRecordingPath(userDataDir, sessionId, 'webm')
  return target.ok ? target.path : null
}
