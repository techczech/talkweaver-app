// The `setup` command (spec docs/plans/cloudflare-setup-in-app, D14; ticket 07): what the Cloudflare
// screen, Recording storage and Transcription can do, done by an agent without a window.
//
//   TalkWeaver setup status [--json]
//   TalkWeaver setup cloudflare connect                       token on standard input
//   TalkWeaver setup cloudflare account <id>
//   TalkWeaver setup cloudflare create-site [name]
//   TalkWeaver setup cloudflare live
//   TalkWeaver setup cloudflare share-domain <host> | --clear
//   TalkWeaver setup cloudflare disconnect
//   TalkWeaver setup recording --endpoint <url> --bucket <name>   keys on standard input
//   TalkWeaver setup transcription --python <path> --script <path> [--ffmpeg <path>]
//
// Every command takes --json. Exit codes: 0 ready, 1 not ready (the state is printed), 2 usage error.
// The JSON is documented in resources/agent-setup/setup-command.md.
//
// This file is argument parsing and printing only (the spec's impact surface): arguments and
// standard input in, lines and an exit code out. What each command DOES is a SetupOperations port,
// which the main process builds from the very functions the window calls (setup-operations.ts), so
// there is one implementation with two callers.
//
// Secrets. A token or an access key is read from standard input only. No argument is a free text:
// each one is checked, as typed (nothing trimmed), against its own strict format (a bucket name, an
// R2 endpoint, a hostname, a site name, a 32-hex account id, an absolute path), and anything else is
// a usage error (exit 2) before anything else happens. No argument is ever repeated back in a
// message (an unknown command is "Unknown command", not the text typed). What standard input held
// is never printed: it is handed to the operation and nothing else. Every status this prints is
// built from the shared wording modules, which hold no secret.
//
// Electron's own switches go AFTER `setup …` (`TalkWeaver setup status --user-data-dir=/x`): the
// command is recognised only at the command position, and the two switches the app is run with
// under test are passed over there (ELECTRON_SWITCHES).
//
// No Electron import and erasable TypeScript only: scripts/test-setup-cli.mjs imports it as it is.
import { posix, win32 } from 'node:path'
import {
  connectionLabel, publishingLabel, publishingRowDetail, publishingRowEdge, shareLinkRowDetail, shareLinkRowEdge,
  type CloudflareStatus, type RowEdge,
} from '../shared/cloudflare-status.ts'
import { goingLiveRowDetail, goingLiveRowEdge, SET_UP_GOING_LIVE, type GoingLiveRow } from '../shared/live-service-status.ts'
import { recordingRowDetail, recordingRowEdge, type RecordingStorageRow } from '../shared/recording-storage-status.ts'
import { transcriptionRowDetail, transcriptionRowLabel, type TranscriptionRow } from '../shared/transcription-status.ts'
import { isValidShareDomain } from '../shared/shared-talk.ts'
import { SecretInputError } from './setup-stdin.ts'

// ── Finding the command in the process's arguments ──────────────────────────────────────────────

/** The form of the argument macOS's Finder may add after the executable (`-psn_0_1234`). */
const MAC_PROCESS_SERIAL = /^-psn_\d+_\d+$/

/**
 * Chromium and Electron switches that may follow `setup …` and are not the command's: the user-data
 * folder (in its one-argument `=` form) and the keychain stand-in of the test harness. Chromium
 * reads them wherever they stand; the command passes over them.
 */
const ELECTRON_SWITCHES = /^(--user-data-dir=.+|--use-mock-keychain)$/

/**
 * The arguments after `setup`, when this launch is the setup command; otherwise null. `argv` is
 * `process.argv`. `setup` counts only at the command position: a packaged app's first argument
 * (`<exe> setup …`, after a `-psn_…` macOS may add), and an unpackaged one's first argument after
 * the app's path (`electron <app> setup …`, `defaultApp`). Nothing is scanned past: a switch, a
 * file to open or anything else in that position means this is an ordinary launch.
 */
export function setupArguments(argv: readonly string[], defaultApp: boolean): string[] | null {
  let index = 1
  if (defaultApp) {
    // The app's path itself, which is never a switch.
    const appPath = argv[index]
    if (appPath === undefined || String(appPath).startsWith('-')) return null
    index += 1
  } else if (MAC_PROCESS_SERIAL.test(String(argv[index] ?? ''))) {
    index += 1
  }
  if (argv[index] !== 'setup') return null
  return argv.slice(index + 1).map(String).filter((arg) => !ELECTRON_SWITCHES.test(arg))
}

// ── What a command is ───────────────────────────────────────────────────────────────────────────

export type SetupCommand =
  | { kind: 'help' }
  | { kind: 'status'; json: boolean }
  | { kind: 'connect'; json: boolean }
  | { kind: 'account'; id: string; json: boolean }
  | { kind: 'create-site'; name: string | null; json: boolean }
  | { kind: 'live'; json: boolean }
  | { kind: 'share-domain'; host: string | null; json: boolean }
  | { kind: 'disconnect'; json: boolean }
  | { kind: 'recording'; endpoint: string; bucket: string; json: boolean }
  | { kind: 'transcription'; python: string; script: string; ffmpeg: string | undefined; json: boolean }

export type ParsedSetup = { ok: true; command: SetupCommand } | { ok: false; error: string; json: boolean }

export const USAGE: readonly string[] = [
  'Usage: TalkWeaver setup <command> [--json]',
  '',
  '  status                                         every row of Settings → Cloudflare, Transcription and the Importer',
  '  cloudflare connect                             the token is read from standard input',
  '  cloudflare account <id>                        choose the account when the token sees several',
  '  cloudflare create-site [name]                  make the Pages site (default talkweaver-handouts)',
  '  cloudflare live                                set up or update the live service',
  '  cloudflare share-domain <host> | --clear       attach or remove the share-link address',
  '  cloudflare disconnect                          remove the token (the live service is left alone)',
  '  recording --endpoint <url> --bucket <name>     the access key id and secret are read from standard input',
  '  transcription --python <path> --script <path> [--ffmpeg <path>]',
  '',
  'Exit codes: 0 ready, 1 not ready (the state is printed), 2 usage error.',
  'Secrets are read from standard input only, never from an argument.',
  '"setup" comes straight after the executable; switches for TalkWeaver itself go after the command.',
]

export const SECRET_ARGUMENT_ERROR = 'Secrets are read from standard input only, never from an argument: nothing was done. Treat that value as exposed (your shell may have kept it in its history) and replace it.'
export const UNKNOWN_COMMAND_ERROR = 'Unknown command. Run "setup help" for the list.'
export const CONNECT_ARGUMENT_ERROR = '"cloudflare connect" takes no argument: the token is read from standard input.'
export const NO_TOKEN_INPUT_ERROR = 'No token on standard input. Pipe it in, or run the command in a terminal and paste it when asked (it is not shown).'
export const ONE_TOKEN_ERROR = 'Give the token alone, on one line, on standard input.'
export const KEYS_INPUT_ERROR = 'Give the access key id and the secret access key on standard input: two lines, or {"accessKeyId": …, "secretAccessKey": …}.'
export const ACCOUNT_ID_ERROR = 'An account id is the 32 characters 0-9 and a-f that the Cloudflare dashboard shows.'
export const SITE_NAME_ERROR = 'A site name is lowercase letters, digits and hyphens, not starting or ending with a hyphen, at most 58 characters.'
export const SHARE_DOMAIN_ERROR = 'The share-link address is a bare hostname, like drafts.example.com: no https://, port, path, space, wildcard, IP address or localhost.'
export const ENDPOINT_ERROR = 'The endpoint is the S3 API address R2 shows for the account: https://<account id>.r2.cloudflarestorage.com (or with .eu or .fedramp before .r2), with nothing after it.'
export const BUCKET_ERROR = 'A bucket name is 3 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.'
export const PATH_ERROR = 'Give each transcription path as a full path from the top of the disk (like /Users/you/venv/bin/python or C:\\Tools\\python.exe).'
export const INPUT_FAILED_ERROR = 'Standard input could not be read. Nothing was done.'

/** Flags that would carry a secret on the command line. Refused, whatever their value, with the sentence that says where secrets go. */
const SECRET_FLAGS = /^--?(token|api-token|cloudflare-token|key|keys|secret|secrets|password|access-key|access-key-id|secret-access-key|secret-key)(=|$)/i

// ── The format of every argument, checked on the exact string ───────────────────────────────────

/** A Cloudflare account id: 32 lowercase hex. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/
/** A Pages project name: lowercase letters, digits and hyphens, not at either end, at most 58. */
const SITE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/
/** An R2 bucket name: 3 to 63 lowercase letters, digits and hyphens, not at either end. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
/** R2's S3 API endpoint for an account: the default, EU and FedRAMP jurisdictions. Nothing else. */
const R2_ENDPOINT = /^https:\/\/[0-9a-f]{32}\.(?:eu\.|fedramp\.)?r2\.cloudflarestorage\.com$/
/** Hostname characters: what isValidShareDomain then checks label by label (it would trim; this does not). */
const HOSTNAME_TEXT = /^[A-Za-z0-9.-]{1,253}$/

export function validAccountIdArgument(value: string): boolean { return ACCOUNT_ID.test(value) }
export function validSiteNameArgument(value: string): boolean { return SITE_NAME.test(value) }
export function validBucketArgument(value: string): boolean { return BUCKET_NAME.test(value) }
export function validShareDomainArgument(value: string): boolean { return HOSTNAME_TEXT.test(value) && isValidShareDomain(value) }
/** `allowed`: one more exact endpoint accepted (a test harness's stand-in, from the main process). */
export function validEndpointArgument(value: string, allowed: string | null = null): boolean {
  return R2_ENDPOINT.test(value) || (allowed !== null && allowed !== '' && value === allowed)
}
/**
 * A full path: absolute on macOS (`/…`) or Windows (`C:\…`, `C:/…`), printable, no URL scheme, no
 * network share (`\\server\…`, `//server/…`), no `~`, nothing relative.
 */
export function validPathArgument(value: string): boolean {
  if (!value || value.length > 4096 || !/^[^\x00-\x1f\x7f]+$/.test(value)) return false
  if (value.startsWith('//') || value.startsWith('\\\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return win32.isAbsolute(value)
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  return value.startsWith('/') && posix.isAbsolute(value)
}

const VALUE_FLAGS = new Set(['--endpoint', '--bucket', '--python', '--script', '--ffmpeg'])

export interface ParseOptions {
  /** One more exact recording endpoint accepted: a test harness's stand-in (unpackaged, TW_E2E only). */
  testEndpoint?: string | null
}

/**
 * Parse the arguments after `setup`. Every argument is checked as typed against its own format;
 * anything else is a usage error that repeats nothing.
 */
export function parseSetupArguments(args: readonly string[], options: ParseOptions = {}): ParsedSetup {
  const json = args.includes('--json')
  const fail = (error: string): ParsedSetup => ({ ok: false, error, json })
  if (args.some((arg) => SECRET_FLAGS.test(arg))) return fail(SECRET_ARGUMENT_ERROR)

  const positional: string[] = []
  const values = new Map<string, string>()
  let clear = false
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') continue
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (arg === '--clear') { clear = true; continue }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 0 ? arg.slice(0, eq) : arg
    if (VALUE_FLAGS.has(flag)) {
      if (values.has(flag)) return fail(`${flag} is given twice.`)
      const value = eq > 0 ? arg.slice(eq + 1) : args[index + 1]
      if (value === undefined || (eq < 0 && value.startsWith('--'))) return fail(`${flag} needs a value.`)
      if (eq < 0) index += 1
      values.set(flag, value)
      continue
    }
    if (arg.startsWith('-')) return fail('Unknown option. Run "setup help" for the list.')
    positional.push(arg)
  }
  if (help || positional[0] === 'help') return { ok: true, command: { kind: 'help' } }

  const noValues = (): boolean => values.size === 0
  const [area, verb, ...rest] = positional
  if (area === 'status' && positional.length === 1 && noValues() && !clear) return { ok: true, command: { kind: 'status', json } }
  if (area === 'cloudflare') {
    if (!noValues()) return fail('That option does not belong to a cloudflare command.')
    if (clear && verb !== 'share-domain') return fail('--clear belongs to "cloudflare share-domain".')
    if (verb === 'connect') return rest.length === 0 ? { ok: true, command: { kind: 'connect', json } } : fail(CONNECT_ARGUMENT_ERROR)
    if (verb === 'live') return rest.length === 0 ? { ok: true, command: { kind: 'live', json } } : fail('"cloudflare live" takes no argument.')
    if (verb === 'disconnect') return rest.length === 0 ? { ok: true, command: { kind: 'disconnect', json } } : fail('"cloudflare disconnect" takes no argument.')
    if (verb === 'account') {
      if (rest.length !== 1) return fail('Give one account id: setup cloudflare account <id>.')
      if (!validAccountIdArgument(rest[0])) return fail(ACCOUNT_ID_ERROR)
      return { ok: true, command: { kind: 'account', id: rest[0], json } }
    }
    if (verb === 'create-site') {
      if (rest.length > 1) return fail('Give at most one site name.')
      if (rest.length === 1 && !validSiteNameArgument(rest[0])) return fail(SITE_NAME_ERROR)
      return { ok: true, command: { kind: 'create-site', name: rest[0] ?? null, json } }
    }
    if (verb === 'share-domain') {
      if (clear ? rest.length !== 0 : rest.length !== 1) return fail('Give one hostname, or --clear: setup cloudflare share-domain <host> | --clear.')
      if (clear) return { ok: true, command: { kind: 'share-domain', host: null, json } }
      if (!validShareDomainArgument(rest[0])) return fail(SHARE_DOMAIN_ERROR)
      // Checked as typed; a hostname's case carries nothing, and Settings keeps it lowercase.
      return { ok: true, command: { kind: 'share-domain', host: rest[0].toLowerCase(), json } }
    }
    return fail(UNKNOWN_COMMAND_ERROR)
  }
  if (area === 'recording' && verb === undefined && !clear) {
    const endpoint = values.get('--endpoint')
    const bucket = values.get('--bucket')
    if (values.has('--python') || values.has('--script') || values.has('--ffmpeg')) return fail('That option does not belong to "recording".')
    if (endpoint === undefined || bucket === undefined) return fail('Give both: setup recording --endpoint <url> --bucket <name>.')
    if (!validEndpointArgument(endpoint, options.testEndpoint ?? null)) return fail(ENDPOINT_ERROR)
    if (!validBucketArgument(bucket)) return fail(BUCKET_ERROR)
    return { ok: true, command: { kind: 'recording', endpoint, bucket, json } }
  }
  if (area === 'transcription' && verb === undefined && !clear) {
    if (values.has('--endpoint') || values.has('--bucket')) return fail('That option does not belong to "transcription".')
    const python = values.get('--python')
    const script = values.get('--script')
    if (python === undefined || script === undefined) return fail('Give both: setup transcription --python <path> --script <path> [--ffmpeg <path>].')
    const ffmpeg = values.get('--ffmpeg')
    // `--ffmpeg ""` clears the setting (the ffmpeg TalkWeaver ships is used); any other value is a full path.
    if (!validPathArgument(python) || !validPathArgument(script) || (ffmpeg !== undefined && ffmpeg !== '' && !validPathArgument(ffmpeg))) return fail(PATH_ERROR)
    return { ok: true, command: { kind: 'transcription', python, script, ffmpeg, json } }
  }
  return fail(UNKNOWN_COMMAND_ERROR)
}

// ── What the operations are (the main process supplies them) ────────────────────────────────────

/** The Importer's slide pictures (spec D17). `unknown`: it could not be told. */
export type ImporterRow = {
  state: 'ready' | 'not-available' | 'unknown'
  /** The Importer runs on this computer at all (macOS only today). */
  available: boolean
  /** The pointer to the separate PPT Extractor, when slide pictures are not available here. */
  pointer: string | null
  url: string | null
}

/** Everything `setup status` reports. A null row could not be told and prints as "unknown". */
export type SetupSnapshot = {
  cloudflare: CloudflareStatus
  goingLive: GoingLiveRow
  recording: RecordingStorageRow
  transcription: TranscriptionRow | null
  importer: ImporterRow | null
}

export type OpResult = { ok: true } | { ok: false; error: string; usage?: boolean }

export interface SetupOperations {
  /** Ask Cloudflare, the live service and recording storage afresh (reads only), as Check again does. */
  checkAll(): Promise<void>
  /** The rows as they stand now. */
  snapshot(): Promise<SetupSnapshot>
  connect(token: string): Promise<OpResult>
  chooseAccount(id: string): Promise<OpResult>
  createSite(name: string | null, progress: (line: string) => void): Promise<OpResult>
  setUpLive(progress: (line: string) => void): Promise<OpResult>
  setShareDomain(host: string | null, progress: (line: string) => void): Promise<OpResult>
  setRecording(settings: { endpoint: string; bucket: string }, keys: { accessKeyId: string; secretAccessKey: string } | null): Promise<OpResult>
  setTranscription(paths: { python: string; script: string; ffmpeg?: string }): Promise<OpResult>
  disconnect(): Promise<OpResult>
}

export interface SetupIo {
  /** Standard output: one line. */
  out(line: string): void
  /** Standard error: one line. */
  err(line: string): void
  /**
   * What standard input holds: piped text up to its end, or, in a terminal, one answer per prompt
   * typed with nothing shown (joined by line breaks). Null only when the input ended with nothing
   * in it (or Return alone at the first prompt). Rejects with a SecretInputError, whose message is a
   * fixed sentence, when the input was too long, could not be read, was cancelled, or the terminal
   * cannot hide what is typed (`pipeHint` says how to pipe it in). Never printed.
   */
  readSecret(prompts: readonly string[], pipeHint: string): Promise<string | null>
}

// ── Printing ────────────────────────────────────────────────────────────────────────────────────

export const SETUP_JSON_FORMAT = 'talkweaver-setup/1'

export type RowJson = {
  state: string
  /** What the window shows at the row's right-hand edge, or null when it shows nothing there. */
  label: string | null
  /** The row's one line of detail, as the window shows it. */
  detail: string
  ready: boolean
}

function edgeText(edge: RowEdge, actionAs: (label: string) => string): string | null {
  if (edge.kind === 'state') return edge.text
  if (edge.kind === 'action') return actionAs(edge.label)
  return null
}

const iso = (at: number | null): string | null => (at === null || !Number.isFinite(at) ? null : new Date(at).toISOString())

function publishingJson(status: CloudflareStatus): RowJson & Record<string, unknown> {
  const row = status.publishing
  return {
    state: row.state, label: edgeText(publishingRowEdge(row), () => publishingLabel(row)), detail: publishingRowDetail(row),
    ready: row.state === 'ready' && !row.stale && status.connection.state === 'connected',
    project: row.project, permission: row.permission, customDomain: row.customDomain, stale: row.stale,
  }
}
function goingLiveJson(row: GoingLiveRow): RowJson & Record<string, unknown> {
  return {
    state: row.state, label: edgeText(goingLiveRowEdge(row), (action) => (action === SET_UP_GOING_LIVE ? `Not set up — ${action}` : action)),
    detail: goingLiveRowDetail(row), ready: row.state === 'ready',
    address: row.address, build: row.build, appBuild: row.appBuild, updateDue: row.state === 'ready' && row.build !== row.appBuild,
    permission: row.permission, reason: row.reason, details: row.details,
  }
}
function shareLinkJson(status: CloudflareStatus): RowJson & Record<string, unknown> {
  const row = status.shareLink
  return {
    state: row.state, label: edgeText(shareLinkRowEdge(row), (action) => action), detail: shareLinkRowDetail(row),
    ready: row.state === 'attached' && !row.stale, host: row.host, permission: row.permission, stale: row.stale,
  }
}
function recordingJson(row: RecordingStorageRow): RowJson & Record<string, unknown> {
  return {
    state: row.state, label: edgeText(recordingRowEdge(row), (action) => action), detail: recordingRowDetail(row),
    ready: row.state === 'ready', bucket: row.bucket, missing: row.missing, notice: row.notice,
  }
}
function transcriptionJson(row: TranscriptionRow | null): RowJson & Record<string, unknown> {
  if (!row) return { state: 'unknown', label: null, detail: 'Could not be told.', ready: false, pythonVersion: null, ffmpeg: null }
  return { state: row.state, label: transcriptionRowLabel(row), detail: transcriptionRowDetail(row), ready: row.state === 'ready', pythonVersion: row.pythonVersion, ffmpeg: row.ffmpeg }
}
export const IMPORTER_READY_DETAIL = 'Slide pictures are drawn on this computer.'
export const IMPORTER_MAC_ONLY_DETAIL = 'The Importer runs on macOS only.'
function importerJson(row: ImporterRow | null): RowJson & Record<string, unknown> {
  if (!row || row.state === 'unknown') return { state: 'unknown', label: null, detail: 'Could not be told.', ready: false, available: row?.available ?? null, url: row?.url ?? null }
  const detail = !row.available ? IMPORTER_MAC_ONLY_DETAIL : row.state === 'ready' ? IMPORTER_READY_DETAIL : row.pointer ?? ''
  return { state: row.state, label: row.state === 'ready' ? 'Ready' : 'Not available', detail, ready: row.state === 'ready' && row.available, available: row.available, url: row.url }
}

/** The connection, as JSON: its state, the window's words, and the account (an account's name and id are not secrets). */
function connectionJson(status: CloudflareStatus): Record<string, unknown> {
  const at = status.connection
  return {
    state: at.state, label: connectionLabel(at),
    account: at.state === 'connected' ? at.account : null,
    accounts: at.state === 'choose-account' ? at.accounts : [],
    lastCheckedAt: at.state === 'unreachable' ? iso(at.lastCheckedAt) : iso(status.checkedAt),
    ready: at.state === 'connected' && at.account !== null,
  }
}

/** The whole status as JSON: the shape resources/agent-setup/setup-command.md documents. */
export function setupStatusJson(command: SetupCommand['kind'], snapshot: SetupSnapshot, outcome: { ready: boolean; error: string | null }): Record<string, unknown> {
  const { cloudflare } = snapshot
  return {
    format: SETUP_JSON_FORMAT,
    command,
    ready: outcome.ready,
    error: outcome.error,
    cloudflare: { connection: connectionJson(cloudflare), notice: cloudflare.notice, details: cloudflare.details },
    rows: {
      publishing: publishingJson(cloudflare),
      goingLive: goingLiveJson(snapshot.goingLive),
      shareLink: shareLinkJson(cloudflare),
      recording: recordingJson(snapshot.recording),
      transcription: transcriptionJson(snapshot.transcription),
      importer: importerJson(snapshot.importer),
    },
  }
}

const ROW_NAMES: ReadonlyArray<[keyof ReturnType<typeof rowsOf>, string]> = [
  ['publishing', 'Publishing handouts'], ['goingLive', 'Going live and sharing'], ['shareLink', 'Share-link domain'],
  ['recording', 'Recording storage'], ['transcription', 'Transcription'], ['importer', 'Importer slide pictures'],
]
function rowsOf(snapshot: SetupSnapshot) {
  return {
    publishing: publishingJson(snapshot.cloudflare), goingLive: goingLiveJson(snapshot.goingLive), shareLink: shareLinkJson(snapshot.cloudflare),
    recording: recordingJson(snapshot.recording), transcription: transcriptionJson(snapshot.transcription), importer: importerJson(snapshot.importer),
  }
}

/** The status as lines: the connection header, then one line per row, in the window's words. */
export function setupStatusLines(snapshot: SetupSnapshot): string[] {
  const { cloudflare } = snapshot
  const lines = [`Cloudflare: ${connectionLabel(cloudflare.connection)}`]
  if (cloudflare.connection.state === 'choose-account') {
    for (const account of cloudflare.connection.accounts) lines.push(`  account ${account.id} · ${account.name}`)
  }
  if (cloudflare.notice) lines.push(`  ${cloudflare.notice}`)
  const rows = rowsOf(snapshot)
  for (const [key, name] of ROW_NAMES) {
    const row = rows[key]
    const stale = row.stale === true ? ' (last known)' : ''
    lines.push(`${name}: ${row.label ?? '—'}${stale}${row.detail && row.detail !== row.label ? ` · ${row.detail}` : ''}`)
  }
  if (cloudflare.details) lines.push(`Details: ${cloudflare.details}`)
  return lines
}

/** Whether a command's outcome is "ready" (exit 0): the row the command is about. */
export function commandReady(command: SetupCommand, snapshot: SetupSnapshot): boolean {
  const rows = rowsOf(snapshot)
  const connected = snapshot.cloudflare.connection.state === 'connected' && snapshot.cloudflare.connection.account !== null
  switch (command.kind) {
    case 'help': return true
    // Ready to publish and go live: the connection, Publishing handouts and Going live. The other rows are optional.
    case 'status': return connected && rows.publishing.ready && rows.goingLive.ready
    case 'connect':
    case 'account': return connected
    case 'create-site': return rows.publishing.ready
    case 'live': return rows.goingLive.ready
    case 'share-domain': return command.host === null ? snapshot.cloudflare.shareLink.state === 'none' : rows.shareLink.ready
    case 'disconnect': return snapshot.cloudflare.connection.state === 'no-token'
    case 'recording': return rows.recording.ready
    case 'transcription': return rows.transcription.ready
  }
}

// ── Reading what standard input holds ───────────────────────────────────────────────────────────

/** The one token on standard input, or the sentence that says what is wrong. */
export function tokenFromInput(text: string | null): { token: string } | { error: string } {
  const lines = (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return { error: NO_TOKEN_INPUT_ERROR }
  if (lines.length > 1) return { error: ONE_TOKEN_ERROR }
  return { token: lines[0] }
}

/**
 * The two recording keys on standard input: two lines, or a JSON object. Null (input that ended
 * with nothing in it): none given, the saved keys are kept. Input of blank lines is not "none
 * given" (an empty variable piped in): it is an error.
 */
export function keysFromInput(text: string | null): { keys: { accessKeyId: string; secretAccessKey: string } | null } | { error: string } {
  if (text === null) return { keys: null }
  const trimmed = text.trim()
  if (!trimmed) return { error: KEYS_INPUT_ERROR }
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { return { error: KEYS_INPUT_ERROR } }
    const id = (parsed as { accessKeyId?: unknown } | null)?.accessKeyId
    const secret = (parsed as { secretAccessKey?: unknown } | null)?.secretAccessKey
    return typeof id === 'string' && typeof secret === 'string' && id.trim() && secret.trim()
      ? { keys: { accessKeyId: id.trim(), secretAccessKey: secret.trim() } } : { error: KEYS_INPUT_ERROR }
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length === 2 ? { keys: { accessKeyId: lines[0], secretAccessKey: lines[1] } } : { error: KEYS_INPUT_ERROR }
}

// ── Running a command ───────────────────────────────────────────────────────────────────────────

/** What `setup` says when TalkWeaver is open on the same user-data folder (Owner, 10 Oct). */
export const APP_OPEN_ERROR = 'TalkWeaver is open. Quit it and run this again, or use Settings → Cloudflare.'
export const APP_OPEN_STATE = 'app-open'

/**
 * What standard output gets when TalkWeaver is open on this user-data folder (the command could
 * not take the app's single-instance lock). The command then exits 1 having parsed nothing, read
 * nothing from standard input and written nothing. Only `--json` among the arguments is looked at.
 */
export function appOpenRefusal(args: readonly string[]): string {
  return args.includes('--json')
    ? JSON.stringify({ format: SETUP_JSON_FORMAT, command: null, ready: false, state: APP_OPEN_STATE, error: APP_OPEN_ERROR })
    : APP_OPEN_ERROR
}

export const TOKEN_PROMPT = 'Paste the Cloudflare token and press Return (it is not shown):'
export const TOKEN_PIPE_HINT = `printf '%s\\n' "$TOKEN" | TalkWeaver setup cloudflare connect`
export const KEYS_PIPE_HINT = `printf '%s\\n%s\\n' "$KEY_ID" "$SECRET" | TalkWeaver setup recording --endpoint <url> --bucket <name>`
export const KEY_ID_PROMPT = 'Access key id (not shown; Return alone keeps the saved keys):'
export const KEY_SECRET_PROMPT = 'Secret access key (not shown):'

/**
 * Run the setup command: parse, do it through the operations, print the state, and answer the exit
 * code. Never throws: a failure inside an operation is "not ready" with a fixed sentence.
 */
export async function runSetup(args: readonly string[], io: SetupIo, ops: SetupOperations, options: ParseOptions = {}): Promise<number> {
  const parsed = parseSetupArguments(args, options)
  if (!parsed.ok) {
    if (parsed.json) io.out(JSON.stringify({ format: SETUP_JSON_FORMAT, command: null, ready: false, error: parsed.error, usage: true }))
    else { io.err(parsed.error); if (parsed.error === UNKNOWN_COMMAND_ERROR) for (const line of USAGE) io.err(line) }
    return 2
  }
  const { command } = parsed
  if (command.kind === 'help') {
    for (const line of USAGE) io.out(line)
    return 0
  }
  const json = command.json
  // Progress goes to standard error under --json, so standard output is the one JSON document.
  const progress = (line: string): void => { if (json) io.err(line); else io.out(line) }
  const usageError = (error: string): number => {
    if (json) io.out(JSON.stringify({ format: SETUP_JSON_FORMAT, command: command.kind, ready: false, error, usage: true }))
    else io.err(error)
    return 2
  }

  /** Standard input, or the fixed sentence of why it could not be had (never its text). */
  const readInput = async (prompts: readonly string[], hint: string): Promise<{ text: string | null } | { error: string }> => {
    try {
      return { text: await io.readSecret(prompts, hint) }
    } catch (error) {
      return { error: error instanceof SecretInputError ? error.message : INPUT_FAILED_ERROR }
    }
  }

  let result: OpResult = { ok: true }
  try {
    switch (command.kind) {
      case 'status': await ops.checkAll(); break
      case 'connect': {
        const read = await readInput([TOKEN_PROMPT], TOKEN_PIPE_HINT)
        if ('error' in read) return usageError(read.error)
        const input = tokenFromInput(read.text)
        if ('error' in input) return usageError(input.error)
        result = await ops.connect(input.token)
        break
      }
      case 'account': result = await ops.chooseAccount(command.id); break
      case 'create-site': result = await ops.createSite(command.name, progress); break
      case 'live': result = await ops.setUpLive(progress); break
      case 'share-domain': result = await ops.setShareDomain(command.host, progress); break
      case 'disconnect': result = await ops.disconnect(); break
      case 'recording': {
        const read = await readInput([KEY_ID_PROMPT, KEY_SECRET_PROMPT], KEYS_PIPE_HINT)
        if ('error' in read) return usageError(read.error)
        // Only input that ended with nothing in it keeps the saved keys; a failed read never does (above).
        const input = keysFromInput(read.text)
        if ('error' in input) return usageError(input.error)
        result = await ops.setRecording({ endpoint: command.endpoint, bucket: command.bucket }, input.keys)
        break
      }
      case 'transcription':
        result = await ops.setTranscription({ python: command.python, script: command.script, ...(command.ffmpeg === undefined ? {} : { ffmpeg: command.ffmpeg }) })
        break
    }
  } catch {
    result = { ok: false, error: 'Something went wrong. Nothing more was done.' }
  }
  // A usage error has changed nothing (every operation checks its input before it writes).
  if (!result.ok && result.usage) return usageError(result.error)

  let snapshot: SetupSnapshot
  try { snapshot = await ops.snapshot() } catch {
    const error = result.ok ? 'The state could not be read.' : result.error
    if (json) io.out(JSON.stringify({ format: SETUP_JSON_FORMAT, command: command.kind, ready: false, error }))
    else io.err(error)
    return 1
  }
  const ready = result.ok && commandReady(command, snapshot)
  const error = result.ok ? null : result.error
  if (json) io.out(JSON.stringify(setupStatusJson(command.kind, snapshot, { ready, error }), null, 2))
  else {
    if (error) io.err(error)
    for (const line of setupStatusLines(snapshot)) io.out(line)
  }
  return ready ? 0 : 1
}
