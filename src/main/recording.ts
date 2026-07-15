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
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs'
import { readFile as readFileAsync, readdir as readdirAsync, stat as statAsync } from 'fs/promises'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { attachDeliveryToPlanned, listRuns, normaliseRun, plannedRunCandidates, readRun } from './runs'

// ── Task 4: mic permission for the present window ────────────────────────────
// Grant ONLY the microphone, and ONLY to this present window's webContents, so the bridge's
// getUserMedia({audio}) resolves; deny everything else. The handler is installed on the
// window's session (the default session): the app requests no other permissions, so denying
// the rest changes nothing — and it stops any other window from grabbing the mic.
export function setupRecordingPermissions(win: BrowserWindow): void {
  const targetId = win.webContents.id
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && wc.id === targetId)
  })
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
  vaultRoot: () => string | null // getConfig('vaultRoot')
  discardThresholdMs: () => number // getConfig('recordingDiscardMs', 20000)
  r2Config: () => R2Config // Settings → Recording storage (endpoint/bucket/creds source)
  readSafeKeys: () => { accessKeyId: string; secretAccessKey: string } | null // safeStorage-decrypted keys
  testMode?: () => boolean // env flag for the e2e (synthetic audio + upload short-circuit)
}

// The slide-time index is data, so it round-trips as-is; the session shape is the spec's data model.
// reveal/highlight marks additionally carry hidden/marks so replay can reproduce in-slide state.
interface SlideTimeMark { event: string; slideId?: string; tMs: number; hidden?: number; marks?: number }
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
  audio: { r2Key: string; bytes: number; uploaded: boolean } | null
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
export function registerRecordingContext(webContentsId: number, ctx: RecordingContext): void {
  contexts.set(webContentsId, ctx)
}
export function unregisterRecordingContext(webContentsId: number): void {
  contexts.delete(webContentsId)
  runStates.delete(webContentsId)
}
export function shouldOfferRunSave(webContentsId: number): boolean {
  const s = runStates.get(webContentsId)
  return !!s && !s.saved && s.gatePassed && !s.audioArmed
}
export function sendRecordingCloseOffer(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.webContents.send('recording:show-close-offer')
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

function sessionJsonPath(deps: RecordingDeps, talkSlug: string, sessionId: string): string {
  const vault = deps.vaultRoot()
  const recDir = join(deps.userDataDir(), 'recordings')
  return vault
    ? join(vault, '_PRESENTATIONS', talkSlug, `${sessionId}.json`)
    : join(recDir, `${sessionId}.json`)
}

function withDefaultKind(session: unknown): unknown {
  if (session && typeof session === 'object' && !('kind' in session)) {
    return { ...(session as Record<string, unknown>), kind: 'delivery' }
  }
  return session
}

// Install the two IPC handlers the bridge calls: recording:context (on load) and
// recording:save (on stop). Registered once at startup; the deps are read lazily per call.
export function registerRecordingIpc(deps: RecordingDeps): void {
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

  ipcMain.handle('recording:save', async (_event, payload) => {
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
      const planned = requestedPlannedId && vault ? readRun(vault, talkSlug, requestedPlannedId) : null
      if (requestedPlannedId && (!planned || planned.status !== 'planned')) {
        return { ok: false, error: 'planned-run-not-found' }
      }
      const sessionId = planned?.id ?? L.newSessionId(Date.now(), Math.random)
      const audioBuf = mode === 'recording' ? Buffer.from(payload.audio as ArrayBuffer) : null

      // 1) LOCAL FIRST — audio to disk before any network call, so a dropped connection
      //    (or an unconfigured R2) can never lose the recording.
      const recDir = join(deps.userDataDir(), 'recordings')
      if (!existsSync(recDir)) mkdirSync(recDir, { recursive: true })
      if (audioBuf) {
        const audioPath = join(recDir, `${sessionId}.webm`)
        writeFileSync(audioPath, audioBuf)
      }

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
        audio: audioBuf ? { r2Key, bytes: audioBuf.byteLength, uploaded: false } : null,
        transcript: null,
        slideTimeIndex: L.buildSlideTimeIndex(rawMarks) as SlideTimeMark[]
      }
      const finalSession = planned
        ? attachDeliveryToPlanned(planned, normaliseRun(session))
        : normaliseRun(session)
      // Vault is the home; if none is configured, keep the session.json beside the audio so a
      // record still survives (it just isn't in the synced Ledger).
      const sessionDir = vault ? join(vault, '_PRESENTATIONS', talkSlug) : recDir
      if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true })
      const sessionJsonPath = join(sessionDir, `${sessionId}.json`)
      writeFileSync(sessionJsonPath, L.serialiseSession(finalSession), 'utf8')

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
      const dir = join(vault, '_PRESENTATIONS', String(talkSlug))
      const out: unknown[] = []
      for (const f of await readdirAsync(dir)) {
        if (!f.endsWith('.json') || f === 'manifest.json') continue
        try {
          out.push(withDefaultKind(JSON.parse(await readFileAsync(join(dir, f), 'utf8'))))
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
      const root = join(vault, '_PRESENTATIONS')
      const out: unknown[] = []
      let slugDirs: string[]
      try { slugDirs = await readdirAsync(root) } catch { return [] }
      for (const slugDir of slugDirs) {
        const dir = join(root, slugDir)
        try {
          if (!(await statAsync(dir)).isDirectory()) continue
        } catch {
          continue
        }
        for (const f of await readdirAsync(dir)) {
          if (!f.endsWith('.json') || f === 'manifest.json') continue
          try {
            out.push(withDefaultKind(JSON.parse(await readFileAsync(join(dir, f), 'utf8'))))
          } catch {
            /* skip an unreadable session file */
          }
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
      const sessionJsonPath = join(vault, '_PRESENTATIONS', String(talkSlug), `${sessionId}.json`)
      if (!existsSync(sessionJsonPath)) return { ok: false, error: 'session-not-found' }
      const session = JSON.parse(readFileSync(sessionJsonPath, 'utf8')) as {
        audio?: { uploaded?: boolean; r2Key?: string; bytes?: number } | null
      }
      if (!session?.audio) return { ok: false, error: 'not-recorded' }
      if (session?.audio?.uploaded) return { ok: true, uploaded: true }
      const audioPath = join(deps.userDataDir(), 'recordings', `${sessionId}.webm`)
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
      const p = join(vault, '_PRESENTATIONS', String(talkSlug), `${sessionId}.json`)
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
      const p = sessionJsonPath(deps, String(talkSlug), String(sessionId))
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
      const p = sessionJsonPath(deps, String(talkSlug), String(sessionId))
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
      const p = sessionJsonPath(deps, talkSlug, sessionId)
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
      writeFileSync(p, L.serialiseSession(s), 'utf8')
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

  ipcMain.handle('recording:close-window', (event) => {
    runStates.delete(event.sender.id)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.destroy()
    return { ok: true }
  })

  // Delete a session — session.json + local audio go to the OS Trash (recoverable).
  ipcMain.handle('recording:delete-session', async (_event, { talkSlug, sessionId }: { talkSlug: string; sessionId: string }) => {
    try {
      const vault = deps.vaultRoot()
      const p = vault ? join(vault, '_PRESENTATIONS', String(talkSlug), `${sessionId}.json`) : null
      const audioPath = join(deps.userDataDir(), 'recordings', `${sessionId}.webm`)
      if (p && existsSync(p)) await shell.trashItem(p)
      if (existsSync(audioPath)) await shell.trashItem(audioPath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
}

// The local audio file for a session — served to the renderer's <audio> via the twrec:// protocol.
export function recordingAudioPath(userDataDir: string, sessionId: string): string {
  return join(userDataDir, 'recordings', `${sessionId}.webm`)
}
