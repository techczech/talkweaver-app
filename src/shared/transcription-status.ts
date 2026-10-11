// Transcription, in words: the states of the one row in Settings → Transcription, and what a
// transcription action says when it cannot run (spec docs/plans/cloudflare-setup-in-app, D16).
// Pure, with no imports but a type, so the main process (which decides the row,
// src/main/transcription-setup.ts), Settings and Studio use the same states and the same sentences.
//
// Transcription is optional: "Not set up — optional" is a calm state, not a warning, and nothing
// else in the app waits for it. Nothing here names a folder or a tool on any particular computer;
// paths are shown only in the Settings fields the person fills in.
import type { RowEdge } from './cloudflare-status.ts'

export const TRANSCRIPTION_ROW_NAME = 'Transcription'

/** Which ffmpeg the row found: the one set in Settings, the one that ships with TalkWeaver, or one installed on the system. */
export type TranscriptionFfmpeg = 'configured' | 'shipped' | 'system'

export type TranscriptionState =
  | 'not-set-up' // neither the Python nor the script is set
  | 'python-not-set'
  | 'python-not-found'
  | 'script-not-set'
  | 'script-not-found'
  | 'ffmpeg-not-found'
  | 'ready'

export const TRANSCRIPTION_STATES: readonly TranscriptionState[] = [
  'not-set-up', 'python-not-set', 'python-not-found', 'script-not-set', 'script-not-found', 'ffmpeg-not-found', 'ready',
]

export type TranscriptionRow = {
  state: TranscriptionState
  /** "3.11" when it could be told, else null. */
  pythonVersion: string | null
  /** The ffmpeg that will be used, when one was found. */
  ffmpeg: TranscriptionFfmpeg | null
  /** For ffmpeg-not-found: a path was set in Settings and is not there (else none shipped or installed). */
  ffmpegConfigured: boolean
}

/** "3.11.7", "3.12.1.final.0" or "Python 3.13.0" → "3.11" / "3.12" / "3.13"; anything else → null. */
export function shortPythonVersion(text: string | null | undefined): string | null {
  const match = /(\d+)\.(\d+)/.exec(String(text ?? ''))
  return match ? `${match[1]}.${match[2]}` : null
}

const MISSING: Record<Exclude<TranscriptionState, 'not-set-up' | 'ready'>, string> = {
  'python-not-set': 'Python not set',
  'python-not-found': 'Python not found',
  'script-not-set': 'Script not set',
  'script-not-found': 'Script not found',
  'ffmpeg-not-found': 'ffmpeg not found',
}

export const NOT_SET_UP_OPTIONAL = 'Not set up — optional'

/** The row's right-hand edge: its state in words. */
export function transcriptionRowEdge(row: TranscriptionRow): RowEdge {
  switch (row.state) {
    case 'not-set-up': return { kind: 'state', text: NOT_SET_UP_OPTIONAL, tone: 'quiet' }
    case 'ready': return { kind: 'state', text: 'Ready', tone: 'good' }
    default: return { kind: 'state', text: MISSING[row.state], tone: 'warn' }
  }
}

function readyParts(row: TranscriptionRow): string {
  const python = row.pythonVersion ? `Python ${row.pythonVersion}` : 'Python found'
  const ffmpeg = row.ffmpeg === 'shipped' ? 'ffmpeg found (shipped with TalkWeaver)' : 'ffmpeg found'
  return `${python}, script found, ${ffmpeg}`
}

/** The row's one line of detail, at the left under its name. */
export function transcriptionRowDetail(row: TranscriptionRow): string {
  switch (row.state) {
    case 'not-set-up': return 'Transcribes recorded Runs on this computer. Nothing else needs it. Use Set-up steps, or ask your agent to set it up.'
    case 'python-not-set': return 'Enter the path of the Python that runs the script below.'
    case 'python-not-found': return 'There is no file at the Python path below.'
    case 'script-not-set': return 'Enter the path of the transcription script below.'
    case 'script-not-found': return 'There is no file at the script path below.'
    case 'ffmpeg-not-found': return row.ffmpegConfigured
      ? 'There is no file at the ffmpeg path below. Clear it to use the ffmpeg that ships with TalkWeaver.'
      : 'This copy of TalkWeaver has no ffmpeg of its own. Enter the path of one below.'
    case 'ready': return readyParts(row)
  }
}

/** The row in one line, as D16 words it: what `setup status` prints and the window shows together. */
export function transcriptionRowLabel(row: TranscriptionRow): string {
  switch (row.state) {
    case 'not-set-up': return NOT_SET_UP_OPTIONAL
    case 'ready': return `Ready (${readyParts(row)})`
    default: return MISSING[row.state]
  }
}

/** What a transcription action (Studio's Transcribe) says when the row is not Ready: where to set it up. */
export function transcriptionActionMessage(row: TranscriptionRow): string | null {
  switch (row.state) {
    case 'ready': return null
    case 'not-set-up': return 'Transcription is not set up. It is optional: Settings → Transcription has the set-up steps.'
    default: return `Transcription is not ready: ${MISSING[row.state]}. Fix it in Settings → Transcription.`
  }
}

/** The steps shown under "Set-up steps", for a person doing it by hand or watching an agent do it. */
export const TRANSCRIPTION_SETUP_STEPS: readonly string[] = [
  'Transcription runs on this computer: a Python environment, the transcription script that ships with TalkWeaver, and a speech model of about 2.5 GB.',
  'The speech engine that ships with TalkWeaver needs a Mac with Apple silicon. Elsewhere, point TalkWeaver at an engine of your own that takes the same arguments.',
  'The quickest way: press "Copy instructions for your agent" and paste them to your coding agent. It creates the environment in TalkWeaver\'s own folder and fetches the model.',
  'By hand: open the set-up folder and follow SETUP.md in it, then paste the Python and script paths below and press Save.',
  'ffmpeg ships with TalkWeaver. Leave its field empty unless you want to use your own.',
]
