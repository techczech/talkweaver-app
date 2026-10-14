// What it connects to (onboarding 0.38.1 ticket 11; locked drawing states 11 and 18, lock decisions 4 and 5;
// re-based on Settings → Cloudflare in 0.38.2).
//
// Ten rows. Each says what the connection is needed for, what happens without it, a state and at most
// one action. The Cloudflare, going-live, share-address, recording-storage and transcription rows do
// not judge anything themselves: they take the very status objects Settings shows (CloudflareStatus,
// GoingLiveRow, RecordingStorageRow, TranscriptionRow) and word them with the same functions Settings
// uses (publishingRowEdge, goingLiveRowEdge, shareLinkRowEdge, recordingRowEdge, transcriptionRowEdge),
// so the Guide and Settings cannot disagree. The rest (LibreOffice, agents, synced folder, backups,
// SlideWell) are pure functions over facts read from this Mac by src/main/guide-connections.ts, with
// read-only, time-bounded probes; no secret's value is ever read. Every action on a Cloudflare row opens
// Settings → Cloudflare. Names, needs and "without it" lines are CONNECTS' in the drawing's text module
// except where the set-up changed (the transcription row: ffmpeg ships with the app); the test says which.

import {
  DEFAULT_PAGES_PROJECT, connectionLabel, publishingRowEdge, shareLinkRowEdge, unknownPublishing, unknownShareLink, UNKNOWN_LIVE_SERVICE,
  type CloudflareStatus, type RowEdge
} from './cloudflare-status.ts'
import { GOING_LIVE_ELSEWHERE_DETAIL, GOING_LIVE_REMOVED_DETAIL, goingLiveRowEdge, unknownGoingLive, type GoingLiveRow } from './live-service-status.ts'
import { recordingRowEdge, recordingStorageRow, type RecordingStorageRow } from './recording-storage-status.ts'
import { transcriptionRowEdge, type TranscriptionRow } from './transcription-status.ts'

export type ConnectionId =
  | 'pages' | 'live' | 'share' | 'r2' | 'transcription' | 'office' | 'agent' | 'synced' | 'backups' | 'slidewell'

/** Row tone: found or set up, partly, not, or not available yet. */
export type ConnectionState = 'on' | 'part' | 'off' | 'wait'

/** What an action does. The renderer names one of these; main holds every URL and the Settings route. */
export type ConnectionActionId = 'open-settings' | 'open-cloudflare' | 'get-slidewell' | 'none'

export interface ConnectionAction { id: ConnectionActionId; label: string; enabled: boolean }

export interface ConnectionRow {
  id: ConnectionId
  /** The lucide icon's name. */
  icon: string
  name: string
  need: string
  without: string
  state: ConnectionState
  stateText: string
  action: ConnectionAction | null
  /** For "Show what is missing": the things not found, in the order they are listed. */
  missing: string[]
}

/** The facts the rows are computed from. No secret value is ever in here. */
export interface ConnectionSources {
  /** What Settings → Cloudflare shows: the connection, Publishing handouts and Share-link domain rows. */
  cloudflare: CloudflareStatus
  /** The Going live and sharing row. */
  goingLive: GoingLiveRow
  /** The Recording storage row. */
  recording: RecordingStorageRow
  /** The Transcription row (Python, script and the ffmpeg that ships with the app). */
  transcription: TranscriptionRow
  /** On this Mac: a program found where the app looks for it. */
  tools: { libreoffice: boolean; poppler: boolean; agents: string[] }
  /** The person's own open vaults (never the example) and what each sits in or holds. */
  vaults: Array<{ name: string; service: string | null; git: boolean }>
  /** Settings → Backup. */
  backup: { enabled: boolean; folderName: string | null; folderExists: boolean }
  slidewell: boolean
}

export const NO_SOURCES: ConnectionSources = {
  cloudflare: {
    connection: { state: 'no-token' }, publishing: unknownPublishing(DEFAULT_PAGES_PROJECT), liveService: UNKNOWN_LIVE_SERVICE,
    shareLink: unknownShareLink(), busy: false, checkedAt: null, notice: null, details: null
  },
  goingLive: unknownGoingLive(''),
  recording: recordingStorageRow({ endpoint: '', bucket: '', hasKeys: false }),
  transcription: { state: 'not-set-up', pythonVersion: null, ffmpeg: null, ffmpegConfigured: false },
  tools: { libreoffice: false, poppler: false, agents: [] },
  vaults: [],
  backup: { enabled: false, folderName: null, folderExists: false },
  slidewell: false
}

export const CONNECTION_TEXT = {
  notSetUp: 'Not set up',
  found: 'Found on this Mac',
  notFound: 'Not found on this Mac',
  setUpInSettings: 'Set up in Settings',
  notAvailableYet: 'Not available yet',
  chooseFolder: 'Choose a folder…',
  getSlideWell: 'Get SlideWell',
  withoutIt: 'Without it:',
  refresh: 'Check again',
  checking: 'Reading this Mac…',
  unavailable: 'This Mac could not be read just now.'
} as const

const AGENT_NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }
export const AGENT_COMMANDS: readonly string[] = Object.keys(AGENT_NAMES)

/** "Partly found: Python, ffmpeg. No speech model" (the drawing's form). */
function partly(found: string[], missing: string[]): string {
  return `Partly found: ${found.join(', ')}. ${missing.map((m, i) => (i === 0 ? `No ${m}` : `no ${m}`)).join(', ')}`
}

export function connectionRows(sources: ConnectionSources): ConnectionRow[] {
  const T = CONNECTION_TEXT
  const settings: ConnectionAction = { id: 'open-settings', label: T.setUpInSettings, enabled: true }
  // Every Cloudflare-backed row (Pages, live, share address, recording storage, transcription) opens Settings → Cloudflare.
  const cloudflare: ConnectionAction = { id: 'open-cloudflare', label: T.setUpInSettings, enabled: true }
  const base = (id: ConnectionId, icon: string, name: string, need: string, without: string): ConnectionRow =>
    ({ id, icon, name, need, without, state: 'off', stateText: T.notSetUp, action: null, missing: [] })

  // The rows that follow Settings take its words and its tone; an action is offered when the row is not Ready.
  const follow = (row: ConnectionRow, edge: RowEdge, fallback: string = T.notSetUp): ConnectionRow => {
    if (edge.kind === 'state') {
      row.stateText = edge.text
      // Settings' quiet tone is either "nothing there" (Not set up, None) or "under way" (Setting up…, Checking…, Keys saved, not checked).
      row.state = edge.tone === 'good' ? 'on' : edge.tone === 'quiet' && /^(Not set up|None)/.test(edge.text) ? 'off' : 'part'
    } else row.stateText = fallback
    if (row.state !== 'on') row.action = cloudflare
    return row
  }

  // 1. Cloudflare Pages: the connection, then Settings' Publishing handouts row.
  const cf = sources.cloudflare
  const pages = base('pages', 'cloud', 'Cloudflare Pages', 'Publishing handouts, short links', 'Handout and HTML deck save as files')
  if (cf.connection.state === 'no-token') pages.action = cloudflare
  else if (cf.connection.state !== 'connected') {
    pages.state = 'part'; pages.stateText = connectionLabel(cf.connection); pages.action = cloudflare
  } else {
    // Connected: the Publishing handouts row says the rest. A connection with no site (or nothing said
    // yet) is partly set up, never "Not set up".
    const edge = publishingRowEdge(cf.publishing)
    follow(pages, edge, edge.kind === 'action' ? 'No site yet' : connectionLabel(cf.connection))
    if (pages.state === 'off') pages.state = 'part'
  }

  // 2. Cloudflare live service: Settings' Going live and sharing row.
  const live = base('live', 'radio', 'Cloudflare live service',
    'Going live, polls, questions, reactions, boards, venue screen, share for comments',
    'Presenting works; nothing is lost if the connection drops')
  const liveEdge = goingLiveRowEdge(sources.goingLive)
  // A row whose edge is a button reads Not set up here, except a computer that is not (or no longer)
  // one the live service accepts: that says which, as Settings does.
  const liveState = sources.goingLive.state
  follow(live, liveState === 'set-up-elsewhere' ? { kind: 'state', text: GOING_LIVE_ELSEWHERE_DETAIL, tone: 'warn' }
    : liveState === 'access-removed' ? { kind: 'state', text: GOING_LIVE_REMOVED_DETAIL, tone: 'warn' }
      : liveEdge.kind === 'action' ? { kind: 'none' } : liveEdge)

  // 3. The share address: Settings' Share-link domain row.
  const share = base('share', 'link', 'Share-link address', 'Shared talk and Share for comments links on your own address', 'Links use the live service’s own address')
  follow(share, shareLinkRowEdge(cf.shareLink))

  // 4. Cloudflare R2: Settings' Recording storage row.
  const r2 = base('r2', 'upload', 'Cloudflare R2', 'Uploading recordings', 'Recordings stay on the Mac')
  follow(r2, recordingRowEdge(sources.recording))
  if (sources.recording.checking) r2.state = 'part'

  // 5. Local transcription: Settings' Transcription row (ffmpeg ships with the app).
  const transcription = base('transcription', 'mic', 'Local transcription',
    'Scripts and notes from a recording (Python and a speech model; ffmpeg ships with TalkWeaver)', 'Recording and playback work')
  follow(transcription, transcriptionRowEdge(sources.transcription))

  const t = sources.tools
  // 5. LibreOffice and Poppler: both, for pictures of the original slides.
  const officeParts = [['LibreOffice', t.libreoffice], ['Poppler', t.poppler]] as const
  const officeFound = officeParts.filter(([, ok]) => ok).map(([name]) => name)
  const officeMissing = officeParts.filter(([, ok]) => !ok).map(([name]) => name)
  const office = base('office', 'file-text', 'LibreOffice and Poppler', 'Pictures of the original slides in the Importer', 'Text, notes and media still import')
  office.missing = officeMissing
  if (officeMissing.length === 0) { office.state = 'on'; office.stateText = T.found }
  else { office.state = officeFound.length ? 'part' : 'off'; office.stateText = officeFound.length ? partly(officeFound, officeMissing) : T.notFound }

  // 6. Your own agent: a known agent program on this Mac (TalkWeaver has no agent setting).
  const agent = base('agent', 'sparkles', 'Your own agent', 'Import clean-up, write-ups', 'Raw script, manual corrections')
  if (t.agents.length) { agent.state = 'on'; agent.stateText = `${T.found}: ${t.agents.map((a) => AGENT_NAMES[a] ?? a).join(', ')}` }
  else agent.action = settings

  // 7. A synced folder: a vault in a OneDrive, Dropbox, Google Drive or iCloud folder, or one that holds .git.
  const synced = base('synced', 'git-branch', 'A synced folder',
    'Vaults on several machines; conflict copies are recognised (OneDrive, Dropbox, Google Drive, Git)', 'A local folder')
  const syncedBits: string[] = []
  for (const vault of sources.vaults) {
    const kinds = [...(vault.service ? [vault.service] : []), ...(vault.git ? ['Git'] : [])]
    if (kinds.length) syncedBits.push(`${kinds.join(' and ')}, on vault ${vault.name}`)
  }
  if (syncedBits.length) { synced.state = 'on'; synced.stateText = `${T.found}: ${syncedBits.join('; ')}` }

  // 8. Single-HTML backups: a folder chosen in Settings, backups on.
  const backups = base('backups', 'copy', 'Single-HTML backups',
    'Presenting from any computer if the Mac fails (a folder for a playable copy of each talk)', 'Nothing else changes')
  const b = sources.backup
  if (b.folderName && b.enabled && b.folderExists) { backups.state = 'on'; backups.stateText = `Set up: ${b.folderName}` }
  else if (b.folderName) {
    backups.state = 'part'
    backups.stateText = !b.folderExists ? `Partly set up: the folder ${b.folderName} is not there` : 'Partly set up: a folder is chosen; backups are off'
    backups.action = { id: 'open-settings', label: T.chooseFolder, enabled: true }
  } else backups.action = { id: 'open-settings', label: T.chooseFolder, enabled: true }

  // 9. SlideWell: a separate app.
  const slidewell = base('slidewell', 'layout-grid', 'SlideWell (separate app)', 'Browsing and reusing old PowerPoint decks', 'The Importer still brings decks in')
  if (sources.slidewell) { slidewell.state = 'on'; slidewell.stateText = T.found }
  else { slidewell.stateText = T.notFound; slidewell.action = { id: 'get-slidewell', label: T.getSlideWell, enabled: true } }

  return [pages, live, share, r2, transcription, office, agent, synced, backups, slidewell]
}
