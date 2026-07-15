// Transcription — main-process bridge to a local speech-to-text engine (Parakeet via Python).
// The engine command + script are user-configured in Settings -> Transcription (unset by
// default; the feature stays dormant until configured). Runs one job at a time, stores small
// transcript JSON beside the Run, and keeps renderer errors human-readable rather than leaking
// Python/ffmpeg stack noise.

import { BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { readFile as readFileAsync } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { spawn, type ChildProcess } from 'child_process'

// Empty by default — the user sets these in Settings -> Transcription. Until then
// humanEngineError() surfaces a friendly "configure the engine" prompt instead of running.
export const DEFAULT_TRANSCRIPTION_PYTHON = ''
export const DEFAULT_TRANSCRIPTION_SCRIPT = ''

export type TranscriptSegment = { start: number; end: number; text: string }
export type TranscriptJson = {
  engine: 'parakeet'
  createdAt: string
  segments: TranscriptSegment[]
}

export interface TranscriptionConfig {
  python: string
  script: string
  ffmpeg?: string
}

export interface TranscriptionDeps {
  userDataDir: () => string // app.getPath('userData')
  vaultRoot: () => string | null // getConfig('vaultRoot')
  config: () => TranscriptionConfig // Settings -> Transcription, with defaults expanded
  testMode?: () => boolean // TW_REC_TEST=1: deterministic fixture, no Python
}

type ActiveJob = {
  sessionId: string
  child: ChildProcess | null
  cancelled: boolean
  tempPaths: string[]
}

let activeJob: ActiveJob | null = null

function transcriptPath(deps: TranscriptionDeps, talkSlug: string, sessionId: string): string {
  const vault = deps.vaultRoot()
  const recDir = join(deps.userDataDir(), 'recordings')
  return vault
    ? join(vault, '_PRESENTATIONS', talkSlug, `${sessionId}.transcript.json`)
    : join(recDir, `${sessionId}.transcript.json`)
}

function audioPath(deps: TranscriptionDeps, sessionId: string): string {
  return join(deps.userDataDir(), 'recordings', `${sessionId}.webm`)
}

function emitProgress(win: BrowserWindow | null, sessionId: string, note: string): void {
  const trimmed = note.trim()
  if (!trimmed || !win || win.isDestroyed()) return
  win.webContents.send('transcript:progress', { sessionId, note: trimmed })
}

function removeTemps(paths: string[]): void {
  for (const p of paths) {
    try {
      if (existsSync(p)) rmSync(p, { force: true })
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

function parseSrtTimestamp(ts: string): number {
  const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!m) return 0
  const [, hh, mm, ss, ms] = m
  return (
    Number(hh) * 60 * 60 * 1000 +
    Number(mm) * 60 * 1000 +
    Number(ss) * 1000 +
    Number(ms)
  )
}

export function parseSrt(text: string): TranscriptSegment[] {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const segments: TranscriptSegment[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) continue
    const [startRaw, endRaw] = lines[timingIndex].split('-->').map((p) => p.trim())
    const start = parseSrtTimestamp(startRaw)
    const end = parseSrtTimestamp(endRaw)
    const body = lines.slice(timingIndex + 1).join(' ').trim()
    if (body && end > start) segments.push({ start, end, text: body })
  }
  return segments
}

function fixtureTranscript(): TranscriptJson {
  return {
    engine: 'parakeet',
    createdAt: new Date().toISOString(),
    segments: [
      { start: 0, end: 8000, text: 'Fixture transcript opening segment.' },
      { start: 8000, end: 18000, text: 'Fixture transcript middle segment for trim tests.' },
      { start: 18000, end: 30000, text: 'Fixture transcript closing segment.' }
    ]
  }
}

function writeTranscript(deps: TranscriptionDeps, talkSlug: string, sessionId: string, transcript: TranscriptJson): void {
  const p = transcriptPath(deps, talkSlug, sessionId)
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(transcript, null, 2), 'utf8')
}

function spawnAndCollect(
  command: string,
  args: string[],
  win: BrowserWindow | null,
  sessionId: string,
  progressPrefix?: string,
  env?: NodeJS.ProcessEnv
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (e) {
      resolve({ ok: false, error: String(e), stderr: '' })
      return
    }

    const job = activeJob
    if (job) job.child = child
    let stdout = ''
    let stderr = ''
    const onChunk = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout += text
      else stderr += text
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) emitProgress(win, sessionId, progressPrefix ? `${progressPrefix}: ${line}` : line)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => onChunk(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => onChunk(chunk, 'stderr'))
    child.on('error', (e) => resolve({ ok: false, error: String(e), stderr }))
    child.on('close', (code, signal) => {
      if (job?.cancelled) {
        resolve({ ok: false, error: 'cancelled', stderr })
        return
      }
      if (code === 0) resolve({ ok: true, stdout, stderr })
      else resolve({ ok: false, error: signal ? `Stopped by ${signal}` : `Exited with code ${code}`, stderr })
    })
  })
}

function humanEngineError(cfg: TranscriptionConfig): string | null {
  if (!cfg.python || !existsSync(cfg.python)) return 'Set the transcription engine in Settings -> Transcription.'
  if (!cfg.script || !existsSync(cfg.script)) return 'Set the transcription engine in Settings -> Transcription.'
  return null
}

function resolveFfmpegPath(cfg: TranscriptionConfig): string {
  const candidates = [
    cfg.ffmpeg ?? '',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ].map((p) => p.trim()).filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'ffmpeg'
}

function childEnvWithFfmpegPath(ffmpegPath: string): NodeJS.ProcessEnv | undefined {
  if (ffmpegPath === 'ffmpeg') return undefined
  return { ...process.env, PATH: `${dirname(ffmpegPath)}:${process.env.PATH ?? ''}` }
}

function humanProcessError(prefix: string, result: { error: string; stderr: string }): string {
  const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || result.error
  return `${prefix}: ${detail}`
}

function humanFfmpegError(result: { error: string; stderr: string }): string {
  if (/ENOENT|spawn ffmpeg/i.test(result.error)) {
    return 'Set the ffmpeg path in Settings -> Transcription.'
  }
  return humanProcessError('ffmpeg audio conversion failed', result)
}

export function registerTranscriptionIpc(deps: TranscriptionDeps): void {
  ipcMain.handle('transcript:get', async (_event, talkSlug: string, sessionId: string) => {
    try {
      const p = transcriptPath(deps, String(talkSlug), String(sessionId))
      return JSON.parse(await readFileAsync(p, 'utf8')) as TranscriptJson
    } catch {
      return null
    }
  })

  ipcMain.handle('transcript:cancel', () => {
    if (!activeJob) return { ok: true }
    activeJob.cancelled = true
    try {
      activeJob.child?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    removeTemps(activeJob.tempPaths)
    return { ok: true }
  })

  ipcMain.handle('transcript:run', async (event, talkSlug: string, sessionId: string) => {
    if (activeJob) return { ok: false, error: 'busy' }

    const slug = String(talkSlug || '').trim()
    const sid = String(sessionId || '').trim()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!slug || !sid) return { ok: false, error: 'Missing Talk or Run id.' }

    activeJob = { sessionId: sid, child: null, cancelled: false, tempPaths: [] }
    try {
      if (deps.testMode ? deps.testMode() : process.env.TW_REC_TEST === '1') {
        const transcript = fixtureTranscript()
        writeTranscript(deps, slug, sid, transcript)
        emitProgress(win, sid, 'Fixture transcript written.')
        return { ok: true, segments: transcript.segments }
      }

      const cfg = deps.config()
      const engineError = humanEngineError(cfg)
      if (engineError) return { ok: false, error: engineError }

      const sourceAudio = audioPath(deps, sid)
      if (!existsSync(sourceAudio)) return { ok: false, error: 'The local audio file for this Run is missing.' }

      const base = `${basename(sid)}-${Date.now()}`
      const wavPath = join(tmpdir(), `talkweaver-${base}.wav`)
      const srtPath = join(tmpdir(), `talkweaver-${base}.srt`)
      activeJob.tempPaths.push(wavPath, srtPath)

      emitProgress(win, sid, 'Converting WebM audio to WAV for Parakeet.')
      const ffmpegPath = resolveFfmpegPath(cfg)
      const childEnv = childEnvWithFfmpegPath(ffmpegPath)
      const ffmpeg = await spawnAndCollect(ffmpegPath, ['-y', '-i', sourceAudio, wavPath], win, sid, 'ffmpeg', childEnv)
      if (!ffmpeg.ok) {
        if (ffmpeg.error === 'cancelled') return { ok: false, error: 'cancelled' }
        return { ok: false, error: humanFfmpegError(ffmpeg) }
      }
      if (activeJob?.cancelled) return { ok: false, error: 'cancelled' }

      emitProgress(win, sid, 'Running Parakeet transcription.')
      const parakeet = await spawnAndCollect(cfg.python, [cfg.script, wavPath, '-o', srtPath], win, sid, undefined, childEnv)
      if (!parakeet.ok) {
        if (parakeet.error === 'cancelled') return { ok: false, error: 'cancelled' }
        return { ok: false, error: humanProcessError('Parakeet transcription failed', parakeet) }
      }

      if (!existsSync(srtPath)) return { ok: false, error: 'Parakeet finished but did not write an SRT file.' }
      const segments = parseSrt(readFileSync(srtPath, 'utf8'))
      const transcript: TranscriptJson = { engine: 'parakeet', createdAt: new Date().toISOString(), segments }
      writeTranscript(deps, slug, sid, transcript)
      emitProgress(win, sid, `Transcript written with ${segments.length} segments.`)
      return { ok: true, segments }
    } catch (e) {
      return { ok: false, error: String(e) }
    } finally {
      if (activeJob?.sessionId === sid) {
        removeTemps(activeJob.tempPaths)
        activeJob = null
      }
    }
  })
}
