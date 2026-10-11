// Transcription set-up (spec docs/plans/cloudflare-setup-in-app, D16): whether transcription can
// run on this computer, the one place that says so, and the operations the Settings window and the
// command line share (D14: one implementation, two callers). No Electron import: the caller hands in
// where things are, so tests and the future `setup transcription` command run it under plain Node.
//
//   transcriptionStatus(...)   configured paths + what exists → the row (pure; the seam under test)
//   createTranscriptionSetup() status(), setPaths() (what `setup transcription --python --script
//                              [--ffmpeg]` calls), ffmpeg(), agentPrompt(), setupFolder()
//
// Wording lives in src/shared/transcription-status.ts. Nothing here reads a secret: the three
// settings are local paths, kept in config.json (transcriptionPython / transcriptionScript /
// transcriptionFfmpeg).
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveFfmpeg, type FfmpegResolution } from './ffmpeg-path.ts'
import { shortPythonVersion, type TranscriptionRow } from '../shared/transcription-status.ts'

export type TranscriptionPaths = { python: string; script: string; ffmpeg: string }

/**
 * The row, from the three configured paths and what exists. Pure: `exists` and the Python version
 * are given. The first missing thing is the one named, in the order Python, script, ffmpeg; nothing
 * configured at all is "Not set up — optional", whatever ffmpeg there is.
 */
export function transcriptionStatus(input: {
  paths: TranscriptionPaths
  exists: (path: string) => boolean
  shippedFfmpeg: readonly string[]
  systemFfmpeg: readonly string[]
  /** For the ffmpeg path set in Settings: a regular file that can be run (default: the real file system; see resolveFfmpeg). */
  executable?: (path: string) => boolean
  /** What the Python reported or its environment records, or null when it could not be told. */
  pythonVersion?: string | null
}): { row: TranscriptionRow; ffmpeg: FfmpegResolution } {
  const python = input.paths.python.trim()
  const script = input.paths.script.trim()
  const ffmpeg = resolveFfmpeg({ configured: input.paths.ffmpeg, shipped: input.shippedFfmpeg, system: input.systemFfmpeg, exists: input.exists, executable: input.executable })
  const row = (state: TranscriptionRow['state']): { row: TranscriptionRow; ffmpeg: FfmpegResolution } => ({
    row: {
      state,
      pythonVersion: state === 'ready' ? shortPythonVersion(input.pythonVersion) : null,
      ffmpeg: ffmpeg.found ? ffmpeg.source : null,
      ffmpegConfigured: !ffmpeg.found && ffmpeg.source === 'configured',
    },
    ffmpeg,
  })
  if (!python && !script) return row('not-set-up')
  if (!python) return row('python-not-set')
  if (!input.exists(python)) return row('python-not-found')
  if (!script) return row('script-not-set')
  if (!input.exists(script)) return row('script-not-found')
  if (!ffmpeg.found) return row('ffmpeg-not-found')
  return row('ready')
}

/**
 * The version a Python environment records (`pyvenv.cfg` beside its bin or Scripts folder, written
 * by venv and by uv), read without running anything. Null when there is no such file.
 */
export function recordedPythonVersion(python: string, readFile: (path: string) => string | null = readText): string | null {
  const cfg = readFile(join(dirname(dirname(python)), 'pyvenv.cfg'))
  if (!cfg) return null
  const line = cfg.split(/\r?\n/).find((entry) => /^\s*version(?:_info)?\s*=/.test(entry))
  return line ? shortPythonVersion(line.split('=')[1]) : null
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/** `python --version`, at most 5 s; null on any failure. Only used when no environment records it. */
function askPythonVersion(python: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(python, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
        resolve(error ? null : shortPythonVersion(`${stdout} ${stderr}`))
      })
    } catch {
      resolve(null)
    }
  })
}

/** The words an agent is given by "Copy instructions for your agent": everything it needs, on this computer. */
export function transcriptionAgentPrompt(input: { setupFolder: string; userData: string; platform: NodeJS.Platform }): string {
  const sep = input.platform === 'win32' ? '\\' : '/'
  const env = `${input.userData}${sep}transcription`
  const python = input.platform === 'win32' ? `${env}${sep}venv${sep}Scripts${sep}python.exe` : `${env}${sep}venv${sep}bin${sep}python`
  return [
    'Please set up transcription for TalkWeaver on this computer.',
    '',
    `Follow the steps in ${input.setupFolder}${sep}SETUP.md. Everything you need ships in that folder; do not look for anything else on this computer.`,
    `- The set-up folder: ${input.setupFolder}`,
    `- TalkWeaver's user-data folder: ${input.userData}`,
    `- Create the Python environment in: ${env}${sep}venv`,
    `- When it is done, the Python path is ${python} and the script path is ${input.setupFolder}${sep}parakeet_to_srt.py`,
    '',
    'If you have the TalkWeaver agent skill, its set-up reference describes the same steps.',
    'Transcription needs no token or password: never ask me for one. Ask me before installing Python itself.',
  ].join('\n')
}

export interface TranscriptionSetupDeps {
  /** The three settings, home folder expanded. */
  read: () => TranscriptionPaths
  /** Store the three settings (an empty string clears one). */
  write: (paths: TranscriptionPaths) => void
  shippedFfmpeg: () => readonly string[]
  systemFfmpeg: () => readonly string[]
  /** resources/agent-setup/transcription, in the build or the checkout. */
  setupFolder: () => string
  userData: () => string
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  pythonVersion?: (python: string) => Promise<string | null>
}

export type TranscriptionSetup = {
  /** The row now (asks the Python its version only when its environment does not record it). */
  status: () => Promise<TranscriptionRow>
  /** Set the paths and say the row: what Settings' Save and `setup transcription` call. Undefined leaves a path as it is. */
  setPaths: (paths: Partial<TranscriptionPaths>) => Promise<TranscriptionRow>
  /** The row, without asking the Python anything (for an action about to run). */
  quickStatus: () => { row: TranscriptionRow; ffmpeg: FfmpegResolution; paths: TranscriptionPaths }
  agentPrompt: () => string
  setupFolder: () => string
}

export function createTranscriptionSetup(deps: TranscriptionSetupDeps): TranscriptionSetup {
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const versionOf = deps.pythonVersion ?? (async (python: string) => recordedPythonVersion(python) ?? askPythonVersion(python))
  const quickStatus = (): { row: TranscriptionRow; ffmpeg: FfmpegResolution; paths: TranscriptionPaths } => {
    const paths = deps.read()
    return { ...transcriptionStatus({ paths, exists, shippedFfmpeg: deps.shippedFfmpeg(), systemFfmpeg: deps.systemFfmpeg() }), paths }
  }
  const status = async (): Promise<TranscriptionRow> => {
    const { row, paths } = quickStatus()
    if (row.state !== 'ready') return row
    const version = await versionOf(paths.python.trim()).catch(() => null)
    return transcriptionStatus({ paths, exists, shippedFfmpeg: deps.shippedFfmpeg(), systemFfmpeg: deps.systemFfmpeg(), pythonVersion: version }).row
  }
  return {
    status,
    quickStatus,
    setPaths: async (patch) => {
      const now = deps.read()
      const pick = (key: keyof TranscriptionPaths): string => (patch[key] === undefined ? now[key] : String(patch[key]).trim())
      deps.write({ python: pick('python'), script: pick('script'), ffmpeg: pick('ffmpeg') })
      return status()
    },
    agentPrompt: () => transcriptionAgentPrompt({ setupFolder: deps.setupFolder(), userData: deps.userData(), platform }),
    setupFolder: deps.setupFolder,
  }
}
