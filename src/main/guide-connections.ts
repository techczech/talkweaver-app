// The machine-state probes behind the Guide's What it connects to rows (onboarding 0.38.1 ticket 11,
// lock decision 5). Read-only: a program is looked for by statting the folders on PATH (and the places
// the Importer already looks); a file is statted; a secret is never read, only whether its blob or id is
// held. Nothing is spawned, no shell runs, no network is touched, no file's contents are read.
//
// Every disk question is asked through `deps.stat`, and every answer is time-bounded: a stat that has
// not come back in `timeoutMs` counts as "not there", so a hung network or cloud folder cannot hold the
// Guide. The rows are computed from the facts by src/shared/guide-connections.ts.
//
// Run when the Features segment is opened and on the refresh button, never at startup (the renderer asks).
import { delimiter, join } from 'node:path'
import { AGENT_COMMANDS, NO_SOURCES, connectionRows, type ConnectionRow, type ConnectionSources } from '../shared/guide-connections.ts'
import type { CloudflareStatus } from '../shared/cloudflare-status.ts'
import type { GoingLiveRow } from '../shared/live-service-status.ts'
import type { RecordingStorageRow } from '../shared/recording-storage-status.ts'
import type { TranscriptionRow } from '../shared/transcription-status.ts'

/** The fixed place a row action opens. The renderer names it by id; the URL is held here, never passed in. */
export const GUIDE_LINKS = {
  'online-content-report': 'https://github.com/techczech/talkweaver-app/issues',
  'slidewell-download': 'https://github.com/techczech/slidewell/releases/latest'
} as const
export type GuideLinkId = keyof typeof GUIDE_LINKS
export const isGuideLinkId = (value: unknown): value is GuideLinkId => typeof value === 'string' && Object.hasOwn(GUIDE_LINKS, value)

export interface StatResult { isFile: boolean; isDirectory: boolean; executable: boolean }

/** The facts main holds, as plain values and thunks (no secret values: only whether they are held). */
export interface ProbeDeps {
  platform: NodeJS.Platform
  home: string
  /** process.env.PATH. */
  pathEnv: string | undefined
  /** Stat one path; null when it is not there. */
  stat: (path: string) => Promise<StatResult | null>
  timeoutMs: number
  config: {
    backupEnabled?: boolean
    backupFolder?: string
  }
  /** The statuses Settings shows. Each is read as it stands: none of them asks the network or reads a secret. */
  cloudflare: () => CloudflareStatus
  goingLive: () => GoingLiveRow
  recording: () => RecordingStorageRow
  transcription: () => Promise<TranscriptionRow>
  /** The person's own vaults as the Talks panel shows them (the example is left out by the caller). */
  vaults: () => Array<{ name: string; service: string }>
}

/** Resolve with the promise's value, or `fallback` once `ms` has passed. */
export function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then((value) => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

const expandHome = (path: string, home: string): string => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path)

/** The folders a program is looked for in: PATH, and the places a GUI app's short PATH leaves out. */
export function searchDirs(deps: Pick<ProbeDeps, 'platform' | 'home' | 'pathEnv'>): string[] {
  const fromPath = (deps.pathEnv ?? '').split(delimiter).filter(Boolean)
  const extra = deps.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/Applications/LibreOffice.app/Contents/MacOS', join(deps.home, '.local', 'bin')]
    : deps.platform === 'win32' ? [] : ['/usr/local/bin', '/usr/bin', join(deps.home, '.local', 'bin')]
  return [...new Set([...fromPath, ...extra])]
}

/** Is a program called one of `names` in any search folder (a file the person could run)? */
export async function findProgram(names: readonly string[], deps: ProbeDeps): Promise<boolean> {
  const suffixes = deps.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const candidates: string[] = []
  for (const dir of searchDirs(deps)) for (const name of names) for (const suffix of suffixes) candidates.push(join(dir, name + suffix))
  const hits = await Promise.all(candidates.map(async (path) => {
    const stat = await bounded(deps.stat(path), deps.timeoutMs, null)
    return !!stat && stat.isFile && (deps.platform === 'win32' || stat.executable)
  }))
  return hits.some(Boolean)
}

const isFolder = async (path: string, deps: ProbeDeps): Promise<boolean> => {
  const stat = await bounded(deps.stat(path), deps.timeoutMs, null)
  return !!stat && stat.isDirectory
}
/** Gather every fact the ten rows need. Never throws: a failed probe is "not found", a failed status is "not set up". */
export async function gatherConnectionSources(deps: ProbeDeps): Promise<ConnectionSources> {
  const c = deps.config
  const none = <T>(value: T): Promise<T> => Promise.resolve(value)
  const [libreoffice, poppler, slidewell, backupExists, agents, transcription] = await Promise.all([
    findProgram(['soffice', 'libreoffice'], deps),
    findProgram(['pdftoppm'], deps),
    deps.platform === 'darwin'
      ? Promise.all(['/Applications/SlideWell.app', join(deps.home, 'Applications', 'SlideWell.app')].map((p) => isFolder(p, deps))).then((r) => r.some(Boolean))
      : none(false),
    (c.backupFolder ?? '').trim() ? isFolder(expandHome((c.backupFolder ?? '').trim(), deps.home), deps) : none(false),
    Promise.all(AGENT_COMMANDS.map(async (name) => ((await findProgram([name], deps)) ? name : null))).then((r) => r.filter((n): n is string => n !== null)),
    bounded(Promise.resolve().then(() => deps.transcription()), TRANSCRIPTION_BOUND_MS, NO_SOURCES.transcription)
  ])
  const backupFolder = (c.backupFolder ?? '').trim()
  let vaults: ConnectionSources['vaults'] = []
  try {
    vaults = deps.vaults()
      .filter((v) => v.service && v.service !== 'Local')
      .map((v) => v.service === 'Git' ? { name: v.name, service: null, git: true } : { name: v.name, service: v.service, git: false })
  } catch { vaults = [] }
  return {
    cloudflare: attempt(deps.cloudflare, NO_SOURCES.cloudflare),
    goingLive: attempt(deps.goingLive, NO_SOURCES.goingLive),
    recording: attempt(deps.recording, NO_SOURCES.recording),
    transcription,
    tools: { libreoffice, poppler, agents },
    vaults,
    backup: {
      enabled: c.backupEnabled === true,
      folderName: backupFolder ? (backupFolder.split(/[\\/]/).filter(Boolean).pop() ?? backupFolder) : null,
      folderExists: backupExists
    },
    slidewell
  }
}

/** A status Settings shows, or the "nothing set up" one when it cannot be read. */
function attempt<T>(read: () => T, fallback: T): T {
  try { return read() } catch { return fallback }
}

// The transcription row may ask a Python for its version (src/main/transcription-setup.ts); not for long.
const TRANSCRIPTION_BOUND_MS = 4000

/** The ten rows for this Mac. */
export async function probeConnections(deps: ProbeDeps): Promise<ConnectionRow[]> {
  return connectionRows(await gatherConnectionSources(deps))
}
