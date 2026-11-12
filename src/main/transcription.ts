// Transcription — main-process bridge to a local speech-to-text engine (Parakeet via Python).
// The engine command + script are set in Settings -> Transcription (unset by default; the feature
// is optional and stays dormant until set up, spec docs/plans/cloudflare-setup-in-app D16). Whether
// it can run, and which ffmpeg it uses, is decided once in transcription-setup.ts (ffmpeg: the one
// set in Settings, else the one that ships with the app). Runs one job at a time, stores small
// transcript JSON beside the Run, and keeps renderer errors human-readable rather than leaking
// Python/ffmpeg stack noise.
//
// Word timings (video ticket 01): a script that advertises `--words <file.json>` in its --help
// output (asked once per configured script, the answer remembered) is also asked for the words of
// each sentence; they are stored inside `<sessionId>.transcript.json`, in milliseconds
// on the same recording clock as the segments. An older script without the option transcribes as
// before and yields no words. One rename publishes segments and words together; extra sidecar
// files never change a stored transcript. No Electron import here: index.ts hands in ipcMain, and the tests
// drive createTranscription directly.

import { withoutAlignment } from './alignment-result.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { validRange, validSilence, validEnds, validLocale, normaliseTranscript, transcriptForPublish } from './transcript-validation.ts'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { randomBytes, createHash } from 'crypto'
import { trimWords, mapSentences, segmentWordEnds, rematchCorrections, type TranscriptMetadata, type TranscriptEngine } from '../shared/transcript-contract.ts'
import {
  audibleSegmentPaths, recordedSegmentPaths, readRecordingSource, transcriptPath as transcriptPathFor,
  type RecordingPath
} from './recording-paths.ts'
import { recordingClock, recordingTranscodeArgs } from './transcode-args.ts'
import { childEnvWithFfmpegDir, type FfmpegResolution } from './ffmpeg-path.ts'
import { transcriptionActionMessage, type TranscriptionRow } from '../shared/transcription-status.ts'

// Empty by default — the person (or their agent, resources/agent-setup/transcription) sets these in
// Settings -> Transcription. Until then a transcription action says where to set it up instead of running.
export const DEFAULT_TRANSCRIPTION_PYTHON = ''
export const DEFAULT_TRANSCRIPTION_SCRIPT = ''

export type TranscriptSegment = { start: number; end: number; text: string }
export type TranscriptJson = TranscriptMetadata & {
  engine: TranscriptEngine
  createdAt: string
  /** Present when a measured leading delay was included by the transcriber. */
  timingClock?: 'recording' | 'recording-v2'
  /** Older measured multi-segment concatenation clocks cannot safely drive animation. */
  needsTranscription?: boolean
  segments: TranscriptSegment[]
  /** Optional on older Runs; stored with the segments so one rename publishes the complete pair. */
  words?: WordTiming[]
}

/** One word, in milliseconds on the recording clock (the segments' unit and clock). */
export type WordTiming = import('../shared/transcript-contract.ts').TranscriptWord
export type WordsJson = {
  engine: 'parakeet'
  createdAt: string
  words: WordTiming[]
}

/** transcript:get — the stored transcript, and whether word timings exist for the Run. */
export type TranscriptRead = TranscriptJson & { hasWords: boolean }
export type TranscriptRunResult =
  | { ok: true; segments: TranscriptSegment[]; hasWords: boolean }
  | { ok: false; error: string }

export interface TranscriptionConfig {
  python: string
  script: string
  ffmpeg?: string
  engine?: 'native' | 'parakeet' | null
  locale?: string
}

export interface TranscriptionDeps {
  userDataDir: () => string // app.getPath('userData')
  vaultForHome?: (home:unknown)=>string|null|undefined
  vaultRoot: () => string | null // the current vault's root (vault registry)
  config: () => TranscriptionConfig // Settings -> Transcription, with defaults expanded
  // The Transcription row and the ffmpeg to use, for these settings (transcription-setup.ts).
  readiness: () => { row: TranscriptionRow; ffmpeg: FfmpegResolution }
  selection?: () => Pick<TranscriptionConfig, 'engine' | 'locale'>
  alignAfterTranscription?: (slug:string,sid:string,root?:string|null)=>Promise<void>
  jobOwner?: symbol
  nativeHelper?: () => string | null
  testMode?: () => boolean // TW_REC_TEST=1: deterministic fixture, no Python
  /** The file operations the stored transcript and words go through (default: node:fs); tests inject failures. */
  files?: TranscriptionFiles
  /** How long the script's --help may take before it is stopped (default 30 s). */
  annotationTimeoutMs?: number
  nativeAvailable?: (locale: string) => Promise<boolean>
  savedRunDeps?: (senderId: number, sessionId: string) => TranscriptionDeps | null
  probeTimeoutMs?: number
}

/** Writes and removals of the stored files. Each throws on failure. */
export interface TranscriptionFiles {
  writeFile(path: string, text: string): void
  rename(from: string, to: string): void
  remove(path: string): void
}

const nodeFiles: TranscriptionFiles = {
  writeFile: (path, text) => writeFileSync(path, text, { encoding: 'utf8', flush: true }),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true })
}

const PROBE_TIMEOUT_MS = 30_000
/** After SIGTERM, how long a child gets before SIGKILL (and before the job stops waiting for it). */
const KILL_GRACE_MS = 2_000

type ActiveJob = {
  owner: symbol
  sessionId: string
  child: ChildProcess | null
  cancelled: boolean
  tempPaths: string[]
  /** Stop waiting for the current child (cancel: after the kill grace, a child that ignored SIGTERM). */
  abandon?: () => void
}

/** Where progress notes go: the asking window's webContents in the app, a recorder in tests. */
export type ProgressSink = (note: string) => void

// talkSlug / sessionId come from the renderer: the canonical path goes through recording-paths.ts, which
// refuses unsafe names (the handler then reads or writes nothing).
function transcriptPath(deps: TranscriptionDeps, talkSlug: string, sessionId: string): RecordingPath {
  return transcriptPathFor(deps.vaultRoot(), deps.userDataDir(), talkSlug, sessionId)
}

function emitProgress(sink: ProgressSink | null, note: string): void {
  const trimmed = note.trim()
  if (trimmed && sink) sink(trimmed)
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

/**
 * The script's words file (`{"words":[{text,start,end}]}`, seconds; a bare array is accepted too)
 * → words in whole milliseconds, ordered by start. A word without text, or with a time that is not
 * a finite number, is dropped; an end before its start is raised to the start. Not JSON, or no
 * words list: none.
 */
export function parseWordsJson(text: string): WordTiming[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { words?: unknown } | null)?.words
  if (!Array.isArray(list)) return []
  const words: WordTiming[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { text: raw, start, end } = item as { text?: unknown; start?: unknown; end?: unknown }
    const word = typeof raw === 'string' ? raw.trim() : ''
    if (!word || typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) continue
    const startMs = Math.max(0, Math.round(start * 1000))
    words.push({ text: word, start: startMs, end: Math.max(startMs, Math.round(end * 1000)) })
  }
  return words.map((w, i) => ({ w, i })).sort((a, b) => a.w.start - b.w.start || a.i - b.i).map(({ w }) => w)
}

/** Whether a script's --help output offers the words option (`--words <file.json>`). */
export function scriptOffersWords(helpText: string): boolean {
  return /(^|[\s[,])--words(?=[\s=\]]|$)/m.test(helpText)
}

/** Fixture words for the fixture transcript: each segment's words spread evenly across it. */
function fixtureWords(segments: TranscriptSegment[]): WordTiming[] {
  const words: WordTiming[] = []
  for (const seg of segments) {
    const parts = seg.text.split(/\s+/).filter(Boolean)
    const step = Math.floor((seg.end - seg.start) / parts.length)
    parts.forEach((text, i) => words.push({ text, start: seg.start + i * step, end: seg.start + (i + 1) * step - 40 }))
  }
  return words
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

/**
 * A crash between write and rename leaves `<sessionId>.transcript.json.<pid>.<time>.tmp` (or the
 * words one) in the folder. Only this session's own leftovers, by that exact pattern, are removed.
 */
function removeStaleTemps(folder: string, sessionId: string): void {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}\\.(transcript|words)\\.json\\.\\d+\\.[0-9a-z]+\\.tmp$`)
  let names: string[]
  try { names = readdirSync(folder) } catch { return }
  for (const name of names) {
    if (!pattern.test(name)) continue
    const path = join(folder, name)
    if (dirname(path) !== folder) continue
    try { rmSync(path, { force: true }) } catch { /* best-effort; tried again next run */ }
  }
}

/** The script's identity for the --help answer: an edited (or replaced) script is asked again. */
function scriptStamp(script: string): string {
  try {
    const st = statSync(script)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'unreadable'
  }
}

function spawnAndCollect(
  job: ActiveJob,
  command: string,
  args: string[],
  sink: ProgressSink | null,
  progressPrefix?: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
  stdoutProgress = true
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string; stderr: string }> {
  return new Promise((resolve) => {
    if (job.cancelled) { resolve({ok:false,error:'cancelled',stderr:''}); return }
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: process.platform !== 'win32' })
    } catch (e) {
      resolve({ ok: false, error: String(e), stderr: '' })
      return
    }

    job.child = child
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: { ok: true; stdout: string; stderr: string } | { ok: false; error: string; stderr: string }): void => {
      if (settled) return
      settled = true
      // Only a live child still owns this process-group identity.
      killChildTree(child, 'SIGKILL')
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      job.child = null
      resolve(result)
    }
    // Past its time: SIGTERM, then SIGKILL after a grace, and the job stops waiting either way.
    timer = timeoutMs ? setTimeout(() => {
      try { killChildTree(child, 'SIGTERM') } catch { /* gone */ }
      killTimer = setTimeout(() => {
        try { killChildTree(child, 'SIGKILL') } catch { /* gone */ }
        finish({ ok: false, error: 'timeout', stderr })
      }, KILL_GRACE_MS)
    }, timeoutMs) : null
    let stdout = ''
    let stderr = ''
    const onChunk = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (stdout.length + stderr.length > 64 * 1024 * 1024) {
        try { killChildTree(child, 'SIGKILL') } catch { /* gone */ }
        finish({ok:false,error:'Transcription output exceeded the safety limit.',stderr:''}); return
      }
      if (!sink || (stream === 'stdout' && !stdoutProgress)) return
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) emitProgress(sink, progressPrefix ? `${progressPrefix}: ${line}` : line)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => onChunk(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => onChunk(chunk, 'stderr'))
    child.on('error', (e) => finish({ ok: false, error: String(e), stderr }))
    child.on('close', (code, signal) => {
      if (job.cancelled) {
        finish({ ok: false, error: 'cancelled', stderr })
        return
      }
      if (killTimer) finish({ ok: false, error: 'timeout', stderr })
      else if (code === 0) finish({ ok: true, stdout, stderr })
      else finish({ ok: false, error: signal ? `Stopped by ${signal}` : `Exited with code ${code}`, stderr })
    })
    job.abandon = () => finish({ ok: false, error: 'cancelled', stderr })
  })
}

function humanProcessError(prefix: string, result: { error: string; stderr: string }): string {
  const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || result.error
  return `${prefix}: ${detail}`
}

function humanFfmpegError(result: { error: string; stderr: string }): string {
  if (/ENOENT|EACCES|spawn/i.test(result.error)) {
    return 'ffmpeg could not be started. Check it in Settings → Transcription.'
  }
  return humanProcessError('ffmpeg audio conversion failed', result)
}

export interface Transcription {
  /** The stored transcript and whether words exist for the Run; null when there is none or a name is unsafe. */
  get(talkSlug: unknown, sessionId: unknown): Promise<TranscriptRead | null>
  /** Transcribe one Run (one job at a time); progress notes go to `sink`. */
  run(talkSlug: unknown, sessionId: unknown, sink: ProgressSink | null, signal?: AbortSignal, choice?: 'native' | 'parakeet'): Promise<TranscriptRunResult>
  /** Stop the running job; its files on disk stay as they were before it started. */
  cancel(): { ok: true }
}

function killChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* gone */ }
}
function stopTranscriptionJob(job: ActiveJob): void {
  job.cancelled = true
  if (job.child) killChildTree(job.child, 'SIGKILL')
  job.abandon?.()
  removeTemps(job.tempPaths)
}
/** Synchronous quit barrier: do not wait for Electron's event loop or child close. */
const routeJobs = new Set<ActiveJob>()
export function stopActiveTranscription(): void { if (activeJob) stopTranscriptionJob(activeJob); for (const job of routeJobs) stopTranscriptionJob(job) }
/** Only our exact temp pattern, and only dead owners; other app instances stay untouched. */
export function sweepTranscriptionTemps(folder?: string): void {
  try {
    folder ??= tmpdir()
    for (const name of readdirSync(folder)) {
      const match = /^talkweaver-.+-(\d+)-\d+-[0-9a-f]{8}\.(wav|srt|words\.json)$/.exec(name)
      if (!match) continue
      try { process.kill(Number(match[1]), 0); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue }
      removeTemps([join(folder, name)])
    }
  } catch { /* Optional cleanup must never prevent startup. */ }
}

// Transcription has one writer across the normal IPC and captured-vault package operations.
let activeJob: ActiveJob | null = null

/** The transcription service: one job at a time, the words-option answer remembered per script. */
export function createTranscription(deps: TranscriptionDeps): Transcription {
  const owner=deps.jobOwner ?? Symbol('transcription-service')
  const files = deps.files ?? nodeFiles
  // `<python>\0<script>\0<mtime:size>` → whether that script's --help offers `--words`.
  const offersWords = new Map<string, boolean>()

  async function scriptHasWordsOption(job: ActiveJob, cfg: TranscriptionConfig, env: NodeJS.ProcessEnv): Promise<boolean | 'cancelled'> {
    const key = `${cfg.python}\0${cfg.script}\0${scriptStamp(cfg.script)}`
    const known = offersWords.get(key)
    if (known !== undefined) return known
    const help = await spawnAndCollect(job, cfg.python, [cfg.script, '--help'], null, undefined, env, deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS)
    if (!help.ok && help.error === 'cancelled') return 'cancelled'
    // A probe that ran out of time says nothing about the script: no words this run, asked again next.
    if (!help.ok && help.error === 'timeout') return false
    // A script whose --help fails is asked for no words (it may still transcribe); remembered too.
    const answer = help.ok && scriptOffersWords(help.stdout)
    offersWords.set(key, answer)
    return answer
  }

  /** Transcript and timings share one canonical file and one atomic commit point. */
  function store(slug: string, sid: string, transcript: TranscriptJson, words: WordTiming[], _sink: ProgressSink | null, beforePublish?: () => void): TranscriptRunResult {
    const storedRoot=deps.vaultRoot()
    const target = transcriptPath(deps, slug, sid)
    if (!target.ok) return {ok:false,error:target.error}
    mkdirSync(dirname(target.path),{recursive:true})
    const temp = `${target.path}.${process.pid}.${Date.now().toString(36)}${randomBytes(4).toString('hex')}.tmp`
    try {
      files.writeFile(temp,JSON.stringify({...transcript,words} satisfies TranscriptJson,null,2))
      beforePublish?.()
      files.rename(temp,target.path)
      queueMicrotask(()=>{void deps.alignAfterTranscription?.(slug,sid,storedRoot).catch(()=>{})})
      try { rmSync(`${target.path}.attempt.json`,{force:true}) } catch { /* optional status */ }
    } catch (error) {
      throw new Error(`The transcript and word timings could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try { if (existsSync(temp)) files.remove(temp) } catch { /* the next transcription sweeps this exact temp name */ }
    }
    return {ok:true,segments:transcript.segments,hasWords:words.length>0}
  }

  return {
    async get(talkSlug, sessionId) {
      try {
        const target = transcriptPath(deps, String(talkSlug), String(sessionId))
        if (!target.ok) return null
        let transcript = normaliseTranscript(JSON.parse(readFileSync(target.path, 'utf8')))
        if (!transcript) return null
        try {
          // Older multi-segment transcoders concatenated actual media durations. Their offsets
          // cannot be repaired from metadata alone; flag them without changing the saved pair.
          if(transcript.timingClock!=='recording-v2'){
            const source=readRecordingSource(deps.vaultRoot(),deps.userDataDir(),String(talkSlug),String(sessionId))
            const audio=await audibleSegmentPaths(deps.userDataDir(),String(sessionId),source)
            const {leadingMs,legacy}=recordingClock(audio)
            if(!legacy&&audio.length>1)return{...transcript,words:[],hasWords:false,needsTranscription:true}
            if(transcript.timingClock!=='recording'&&leadingMs)transcript={...transcript,timingClock:'recording',segments:transcript.segments.map(s=>({...s,start:s.start+leadingMs,end:s.end+leadingMs})),...(Array.isArray(transcript.words)?{words:transcript.words.map(w=>({...w,start:w.start+leadingMs,end:w.end+leadingMs}))}:{})}
            if (!recordingClock(audio).legacy && transcript.words?.some(w => !audio.some(a => w.start >= a.startMs && w.end <= a.endMs))) {
              return { ...transcript, words: [], hasWords: false, needsTranscription: true }
            }
          }
        } catch { /* Alignment is optional; the saved transcript remains readable. */ }
        return { ...transcript, hasWords: Array.isArray(transcript.words) && transcript.words.length > 0 }
      } catch {
        return null
      }
    },

    cancel() {
      const job = activeJob
      if (!job || job.owner!==owner) return { ok: true }
      stopTranscriptionJob(job)
      return { ok: true }
    },

    async run(talkSlug, sessionId, sink, signal, choice) {
      if (signal?.aborted) return { ok: false, error: 'cancelled' }
      if (activeJob) return { ok: false, error: 'busy' }

      const slug = String(talkSlug || '').trim()
      const sid = String(sessionId || '').trim()
      if (!slug || !sid) return { ok: false, error: 'Missing Talk or Run id.' }
      // Refuse unsafe names before any work (the raw values: a padded name is refused, not trimmed).
      const target = transcriptPath(deps, String(talkSlug), String(sessionId))
      if (!target.ok) return { ok: false, error: target.error }

      const capturedRoot = deps.vaultRoot()
      const capturedUserData = deps.userDataDir()
      const sourceStamp = () => {
        const source = readRecordingSource(capturedRoot, capturedUserData, slug, sid)
        const audio = recordedSegmentPaths(capturedUserData, sid, source)
        const hash = createHash('sha256').update(JSON.stringify({kind:source?.kind,id:source?.record.id ?? source?.record.sessionId,recordingMs:Number(source?.record.recordingMs)}))
        for (const segment of audio) {
          const st = statSync(segment.path)
          hash.update(JSON.stringify([segment, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]))
        }
        return hash.digest('hex')
      }
      let initialStamp: string
      try { initialStamp = sourceStamp() } catch { return {ok:false,error:'The recording source could not be read.'} }
      const guardPublish = () => {
        if (job.cancelled || signal?.aborted) throw Error('cancelled')
        if (deps.vaultRoot() !== capturedRoot || deps.userDataDir() !== capturedUserData || sourceStamp() !== initialStamp) throw Error('The recording changed. Retry with the current source.')
      }
      const publish = (transcript: TranscriptJson, words: WordTiming[]) => {
        guardPublish()
        let previous: TranscriptJson | null = null
        try { previous = normaliseTranscript(JSON.parse(readFileSync(target.path,'utf8'))) } catch { /* first transcript */ }
        if (!words.length && !transcript.segments.length && previous?.words?.length) return {ok:false as const,error:'No words were found; the earlier transcript was kept. Retry with another language.'}
        const checked = transcriptForPublish(withoutAlignment({...transcript,words}))
        if (!checked) return {ok:false as const,error:'The new timings could hide transcript content; the earlier transcript was kept. Retry with another language.'}
        return store(slug,sid,checked,checked.words ?? [],sink,guardPublish)
      }
      const job: ActiveJob = { owner, sessionId: sid, child: null, cancelled: false, tempPaths: [] }
      activeJob = job
      const abort = () => stopTranscriptionJob(job)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        removeStaleTemps(dirname(target.path), sid)

        if (deps.testMode ? deps.testMode() : process.env.TW_REC_TEST === '1') {
          const transcript = fixtureTranscript()
          const stored = store(slug, sid, transcript, fixtureWords(transcript.segments), sink)
          if (stored.ok) emitProgress(sink, 'Fixture transcript written.')
          return stored
        }

        const configured = deps.config()
        const selected = deps.selection?.()
        const cfg = {...configured,engine:choice ?? selected?.engine ?? configured.engine,locale:selected?.locale ?? configured.locale}
        const ready = deps.readiness()
        const native = cfg.engine === 'native'
        const nativeHelper = native ? deps.nativeHelper?.() : null
        if (native && (!nativeHelper || (deps.nativeAvailable && !await deps.nativeAvailable(cfg.locale || 'en-US')))) return {ok:false,error:'Built-in words are unavailable for this language on this Mac.'}
        const refusal = native ? null : transcriptionActionMessage(ready.row)
        if (refusal || !ready.ffmpeg.found) return { ok: false, error: refusal ?? transcriptionActionMessage({ ...ready.row, state: 'ffmpeg-not-found' }) ?? 'ffmpeg could not be found. Check it in Settings → Transcription.' }
        const ffmpegPath = ready.ffmpeg.path

        const source = readRecordingSource(deps.vaultRoot(), deps.userDataDir(), slug, sid)
        // Empty segments (a 0-byte file, no recorded span) hold no audio and are left out.
        const audioSegments = await audibleSegmentPaths(deps.userDataDir(), sid, source, ffmpegPath)
        if (!audioSegments.length) {
          const listed = recordedSegmentPaths(deps.userDataDir(), sid, source).length > 0
          return { ok: false, error: listed ? 'The local recording has no audio segments.' : 'The local audio file for this Run is missing.' }
        }
        const sources = audioSegments.map((segment) => segment.path)
        const recordingMs=Math.max(Number(source?.record.recordingMs)||0,...audioSegments.map(s=>s.endMs))
        const childEnv = childEnvWithFfmpegDir(ffmpegPath)

        // The cheap step first: whether the script offers word timings (asked once per script version).
        emitProgress(sink, native ? 'Writing out words on this Mac.' : 'Checking the transcription script.')
        const askWords = native ? false : await scriptHasWordsOption(job, cfg, childEnv)
        if (askWords === 'cancelled' || job.cancelled) return { ok: false, error: 'cancelled' }

        // pid + random as well as the time: two processes (or test runs) never share a temp name.
        const base = `${basename(sid)}-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
        const wavPath = join(tmpdir(), `talkweaver-${base}.wav`)
        const srtPath = join(tmpdir(), `talkweaver-${base}.srt`)
        const wordsTemp = join(tmpdir(), `talkweaver-${base}.words.json`)
        job.tempPaths.push(wavPath, srtPath, wordsTemp)

        emitProgress(sink, native ? 'Preparing the saved voice for built-in words.' : sources.length > 1 ? `Joining ${sources.length} audio segments into one WAV for Parakeet.` : 'Converting WebM audio to WAV for Parakeet.')
        const ffmpeg = await spawnAndCollect(job, ffmpegPath, recordingTranscodeArgs(audioSegments,recordingMs,wavPath), sink, 'ffmpeg', childEnv)
        if (!ffmpeg.ok) {
          if (ffmpeg.error === 'cancelled') return { ok: false, error: 'cancelled' }
          return { ok: false, error: humanFfmpegError(ffmpeg) }
        }
        if (job.cancelled) return { ok: false, error: 'cancelled' }

        if (native) {
          const helper = deps.nativeHelper?.()
          if (!helper) return {ok:false,error:'Built-in words need macOS 26 and the speech helper. Choose an installed better model in Settings → Recording.'}
          const result = await spawnAndCollect(job, helper, [wavPath, cfg.locale || 'en-US'], sink, undefined, undefined, 30 * 60_000, false)
          if (!result.ok) return {ok:false,error:result.error === 'cancelled' ? 'cancelled' : humanProcessError('Words could not be written out. Retry',result)}
          const raw = JSON.parse(result.stdout)
          if (!['apple-speech-transcriber','apple-dictation'].includes(raw.engine) || !Array.isArray(raw.words) || !Array.isArray(raw.segments)) throw Error('Invalid native transcript')
          if (!validLocale(raw.locale)) throw Error('Invalid native locale')
          const returned = raw.words.map((w: any) => ({text:w?.text,start:w?.startMs,end:w?.endMs})) as WordTiming[]
          const segments = raw.segments.map((r: any) => ({text:r?.text,start:r?.startMs,end:r?.endMs})) as TranscriptSegment[]
          if (returned.some(w=>!validRange(w)||typeof w.text!=='string') || segments.some(r=>!validRange(r)||typeof r.text!=='string')) throw Error('Invalid native word ranges')
          if (returned.some((w,i)=>i > 0 && w.start < returned[i-1].end) || segments.some((s,i)=>i > 0 && s.start < segments[i-1].start)) throw Error('Native ranges overlap or are out of order')
          if (!validSilence(raw.silence)) raw.silence = []
          if (!validEnds(raw.sentenceEnds, returned.length)) raw.sentenceEnds = []
          // Token indices refer to the helper's list: remap after dropping empty tokens.
          const nativeEnds = new Set<number>(raw.sentenceEnds)
          const keptEnds: number[] = []; const cleaned: WordTiming[] = []
          returned.forEach((w,i)=>{const text=w.text.trim();if(text)cleaned.push({...w,text});if(nativeEnds.has(i) && cleaned.length)keptEnds.push(cleaned.length-1)})
          const coverage = Number.isFinite(recordingMs) ? recordingMs : Math.max(...audioSegments.map(a=>a.endMs))
          if (Number.isFinite(coverage) && returned.some(w=>w.end > coverage + 100)) throw Error('Native words extend beyond the recording')
          const words = trimWords(cleaned,raw.silence)
          let old: TranscriptJson | null = null
          try { old = normaliseTranscript(JSON.parse(readFileSync(target.path,'utf8'))) } catch { /* first transcript */ }
          const corrections = rematchCorrections([...(old?.captionCorrections ?? []),...(old?.unmatchedCorrections ?? [])],words)
          return publish({engine:raw.engine,createdAt:new Date().toISOString(),timingClock:'recording-v2',schemaVersion:2,locale:raw.locale,
            engineVersion:typeof raw.engineVersion === 'string' ? raw.engineVersion : 'apple-speech-26',configVersion:'pcm-10ms-hysteresis-v1',sourceFingerprint:initialStamp,segments,
            silence:raw.silence,sentences:mapSentences(words,keptEnds,raw.silence,segmentWordEnds(cleaned,segments)),captionCorrections:corrections.matched,unmatchedCorrections:corrections.unmatched},words)
        }
        emitProgress(sink, askWords ? 'Running Parakeet transcription with word timings.' : 'Running Parakeet transcription.')
        const args = [cfg.script, wavPath, '-o', srtPath, ...(askWords ? ['--words', wordsTemp] : [])]
        const parakeet = await spawnAndCollect(job, cfg.python, args, sink, undefined, childEnv)
        if (!parakeet.ok) {
          if (parakeet.error === 'cancelled') return { ok: false, error: 'cancelled' }
          return { ok: false, error: humanProcessError('Parakeet transcription failed', parakeet) }
        }
        if (job.cancelled) return { ok: false, error: 'cancelled' }

        if (!existsSync(srtPath)) return { ok: false, error: 'Parakeet finished but did not write an SRT file.' }
        const segments = parseSrt(readFileSync(srtPath, 'utf8'))
        let words: WordTiming[] = []
        if (askWords) {
          if (!existsSync(wordsTemp)) throw new Error('Parakeet did not write the advertised word timings.')
          let payload: unknown
          try { payload = JSON.parse(readFileSync(wordsTemp, 'utf8')) }
          catch { throw new Error('Parakeet wrote invalid word timings JSON.') }
          const list = Array.isArray(payload) ? payload : (payload as { words?: unknown } | null)?.words
          if (!Array.isArray(list) || list.some(item => !item || typeof item.text !== 'string' || !item.text.trim() || typeof item.start !== 'number' || !Number.isFinite(item.start) || typeof item.end !== 'number' || !Number.isFinite(item.end))) {
            throw new Error('Parakeet wrote structurally invalid word timings.')
          }
          words = parseWordsJson(JSON.stringify(list))
        }
        const segmentEnds = segmentWordEnds(words,segments)
        let annotation: Pick<TranscriptJson,'silence'|'sentences'|'acousticMeasurement'> = {
          acousticMeasurement:'unavailable',
          sentences:mapSentences(words,[],[],segmentEnds)
        }
        const helper = deps.nativeHelper?.()
        if (helper && words.length) {
          try {
            files.writeFile(wordsTemp,JSON.stringify(words.map(w=>({text:w.text,startMs:w.start,endMs:w.end}))))
            const result = await spawnAndCollect(job,helper,['--annotate',wavPath,cfg.locale || 'en-US',wordsTemp],null,undefined,undefined,deps.annotationTimeoutMs ?? 30 * 60_000,false)
            if (job.cancelled) return {ok:false,error:'cancelled'}
            if (result.ok) {
              const measured = JSON.parse(result.stdout)
              if (!validSilence(measured.silence) || !validEnds(measured.sentenceEnds,words.length)) throw Error('Invalid acoustic map')
              const trimmed = trimWords(words,measured.silence)
              words = words.map((w,i)=>({...w,trimmedStart:trimmed[i].start,trimmedEnd:trimmed[i].end,timing:trimmed[i].timing}))
              annotation = {acousticMeasurement:'available',silence:measured.silence,sentences:mapSentences(words,measured.sentenceEnds,measured.silence,segmentEnds)}
            }
          } catch { if (job.cancelled) return {ok:false,error:'cancelled'} /* Optional measurement cannot discard Parakeet. */ }
        }
        let previous: TranscriptJson | null = null
        try { previous = normaliseTranscript(JSON.parse(readFileSync(target.path,'utf8'))) } catch { /* first transcript */ }
        const corrections = rematchCorrections([...(previous?.captionCorrections ?? []),...(previous?.unmatchedCorrections ?? [])],words)
        const stored = publish({ engine: 'parakeet', createdAt: new Date().toISOString(), segments, timingClock:'recording-v2', schemaVersion:2, locale:cfg.locale || 'en-US',engineVersion:scriptStamp(cfg.script),configVersion:'parakeet-v1',sourceFingerprint:initialStamp,...annotation,captionCorrections:corrections.matched,unmatchedCorrections:corrections.unmatched }, words)
        if (stored.ok) {
          emitProgress(sink, stored.hasWords
            ? `Transcript written with ${segments.length} segments and ${words.length} word timings.`
            : `Transcript written with ${segments.length} segments.`)
        }
        return stored
      } catch (e) {
        return { ok: false, error: job.cancelled || (e instanceof Error && e.message === 'cancelled') ? 'cancelled' : String(e) }
      } finally {
        signal?.removeEventListener('abort', abort)
        if (activeJob === job) {
          removeTemps(job.tempPaths)
          activeJob = null
        }
      }
    }
  }
}

type IpcSender = { id?: number; send(channel: string, payload: unknown): void; isDestroyed(): boolean }
type IpcMainLike = { handle(channel: string, listener: (event: { sender: IpcSender }, ...args: unknown[]) => unknown): void }

export function registerTranscriptionIpc(ipc: IpcMainLike, deps: TranscriptionDeps): Transcription {
  const transcription = createTranscription(deps)
  const savedDeps = (event: {sender: IpcSender}, sid: unknown) => deps.savedRunDeps ? deps.savedRunDeps(event.sender.id ?? -1,String(sid)) : deps
  ipc.handle('transcript:saved-status', (event, slug, sid) => {
    const scoped = savedDeps(event,sid)
    return scoped ? savedTranscriptionStatus(scoped,String(slug),String(sid)) : {state:'failed',note:'The saved Run is no longer available here. Open the Run to write out words.'}
  })
  ipc.handle('transcript:retry-saved', (event, slug, sid) => {
    const scoped = savedDeps(event,sid)
    return scoped ? transcribeSavedRun(scoped,String(slug),String(sid), note => { if (!event.sender.isDestroyed()) event.sender.send('transcript:progress',{sessionId:String(sid),note}) }) : undefined
  })
  ipc.handle('transcript:attempt', (_event, slug, sid) => readTranscriptionAttempt(deps,String(slug),String(sid)))
  ipc.handle('transcript:get', async (_event, talkSlug: unknown, sessionId: unknown, home:unknown) => {
    if(home===undefined)return transcription.get(talkSlug,sessionId)
    const root=deps.vaultForHome?.(home);if(root===undefined)return null
    const scoped=createTranscription({...deps,vaultRoot:()=>{if(deps.vaultForHome?.(home)!==root)throw Error('Vault unavailable');return root}})
    const result=await scoped.get(talkSlug,sessionId)
    return deps.vaultForHome?.(home)===root?result:null
  })
  ipc.handle('transcript:cancel', () => transcription.cancel())
  ipc.handle('transcript:run', (event, talkSlug: unknown, sessionId: unknown, choice: unknown) => {
    const sid = String(sessionId || '').trim()
    const sink: ProgressSink = (note) => {
      if (!event.sender.isDestroyed()) event.sender.send('transcript:progress', { sessionId: sid, note })
    }
    return transcription.run(talkSlug, sessionId, sink, undefined, choice === 'native' || choice === 'parakeet' ? choice : undefined)
  })
  return transcription
}

export type TranscriptionAttempt = {engine:'native';time:string;reason:string|null}
export function readTranscriptionAttempt(deps: TranscriptionDeps, slug: string, sid: string): TranscriptionAttempt | null {
  const target = transcriptPath(deps,slug,sid)
  if (!target.ok) return null
  try {
    const value = JSON.parse(readFileSync(`${target.path}.attempt.json`,'utf8'))
    return value?.engine === 'native' && typeof value.time === 'string' && (value.reason === null || typeof value.reason === 'string') ? value : null
  } catch { return null }
}
/** Cheap native route probe; model download is deferred to the actual job. */
export async function nativeLocaleAvailable(helper: string | null, locale: string): Promise<boolean> {
  if (!helper) return false
  const job: ActiveJob = {owner:Symbol(),sessionId:'route',child:null,cancelled:false,tempPaths:[]}
  routeJobs.add(job)
  let result: Awaited<ReturnType<typeof spawnAndCollect>>
  try { result = await spawnAndCollect(job,helper,['--route',locale],null,undefined,undefined,5000,false) } finally { routeJobs.delete(job) }
  if (!result.ok) return false
  try { const route=JSON.parse(result.stdout);return ['apple-speech-transcriber','apple-dictation'].includes(route.engine) && validLocale(route.locale) } catch { return false }
}
export type SavedWordsStatus = { state: 'checking' | 'writing' | 'ready' | 'failed' | 'unavailable' | 'none'; note: string }
const savedWords = new Map<string, SavedWordsStatus>()
function savedWordsKey(deps: TranscriptionDeps, slug: string, sid: string): string | null {
  const target = transcriptPath(deps, slug, sid)
  return target.ok ? target.path : null
}
export function savedTranscriptionStatus(deps: TranscriptionDeps, slug: string, sid: string): SavedWordsStatus {
  const key = savedWordsKey(deps, slug, sid)
  const status = key && savedWords.get(key)
  if (status) return status
  if (!recordedSegmentPaths(deps.userDataDir(),sid,readRecordingSource(deps.vaultRoot(),deps.userDataDir(),slug,sid)).length) return {state:'none',note:'This Run has no saved voice to write out.'}
  return { state: 'checking', note: 'Checking built-in words on this Mac.' }
}
/** Automatic means built-in only. Unavailable and busy are silent, with no lasting failure. */
export async function transcribeSavedRun(deps: TranscriptionDeps, slug: string, sid: string, sink: ProgressSink): Promise<void> {
  if (activeJob) return
  const root = deps.vaultRoot(), data = deps.userDataDir()
  const stillCurrent = () => deps.vaultRoot() === root && deps.userDataDir() === data
  const locale = deps.selection?.().locale ?? deps.config().locale ?? 'en-US'
  const key = savedWordsKey(deps, slug, sid)
  const remember = (status: SavedWordsStatus) => {
    if (!key) return
    savedWords.set(key, status)
    if (savedWords.size > 200) savedWords.delete(savedWords.keys().next().value!)
  }
  if (!deps.nativeAvailable || !await deps.nativeAvailable(locale)) {
    remember({state:'unavailable', note:'Built-in words are unavailable on this Mac or for this language. Choose an installed model in Settings → Recording, then write out the Run manually.'})
    return
  }
  if (activeJob || !stillCurrent()) return
  const progress: ProgressSink = note => { remember({state:'writing',note}); sink(note) }
  progress('Words are being written out on this Mac.')
  let finalNote: string | null = 'Words were not written. Retry from the Run.'
  try {
    const result = await createTranscription(deps).run(slug,sid,progress,undefined,'native')
    if (result.ok) finalNote = 'Words are ready.'
    // A manual run that started in the meantime owns Studio's busy state: say nothing.
    if (!result.ok && result.error === 'busy') { finalNote = null; return }
    if (!stillCurrent() || (!result.ok && (result.error === 'busy' || result.error === 'cancelled'))) return
    if (!result.ok) finalNote = `Words could not be written out: ${result.error}. The recording is saved. Retry from the Run.`
    const target=transcriptPath(deps,slug,sid)
    if (target.ok) {
      const temp=`${target.path}.attempt.json.${process.pid}.tmp`
      try {
        mkdirSync(dirname(target.path),{recursive:true})
        writeFileSync(temp,JSON.stringify({engine:'native',time:new Date().toISOString(),reason:result.ok ? null : result.error} satisfies TranscriptionAttempt))
        renameSync(temp,`${target.path}.attempt.json`)
      } catch { /* The saved recording and transcript remain usable if optional status storage fails. */ } finally { try { rmSync(temp,{force:true}) } catch { /* optional status */ } }
    }
  } finally { if (finalNote) { remember({state: finalNote === 'Words are ready.' ? 'ready' : 'failed',note:finalNote}); sink(finalNote) } }
}
