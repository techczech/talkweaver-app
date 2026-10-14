// Going live and sharing, in words: the states of its row in Settings → Cloudflare, and what Go live
// and Share for comments say when the live service is not set up (spec docs/plans/cloudflare-setup-in-app,
// D9, the "Per feature" table and the "What each user action does" table; ticket 05; and spec
// docs/plans/going-live-from-several-macs, "States", for a second computer on one account). Pure, with no
// imports but types and constants, so the main process (which works the row out), Settings, the
// share sheet and the presenter window use the same states and the same sentences.
//
// Nothing here holds or names a secret. A row carries the live service's address (a workers.dev
// address, not a secret), the build deployed, and fixed sentences.
import { WORKERS_PERMISSION, type RowEdge } from './cloudflare-status.ts'

export const GOING_LIVE_ROW_NAME = 'Going live and sharing'
/** The Worker the live service is: worker/wrangler.jsonc `name` (a test holds the two together). */
export const LIVE_WORKER_NAME = 'talkweaver-live-sessions'

/**
 * The row's states, the spec's "Going live and sharing" cell in order:
 *   not-set-up     "Set up going live"
 *   setting-up     Setting up… (`phase`: checking, the upload, this computer's key, waiting to be accepted)
 *   ready          Ready, the build shown in Details; "Ready · this computer and N others" when the
 *                  live service lists other computers
 *   updating       Updating… (an update before the next use, or one asked for)
 *   no-permission  "The token cannot run the live service" (names the permission)
 *   failed         "Set-up failed" with the reason and Try again
 *   set-up-elsewhere  "Set up on another computer", with "Set up going live on this computer": the
 *                  account has a live service and this computer has not been added to it
 *   access-removed "This computer's access was removed", with the same button: the live service
 *                  refuses the key this computer holds
 * and `unknown`: nothing to say yet (no working connection, and nothing deployed from here).
 */
export type GoingLiveState = 'unknown' | 'not-set-up' | 'setting-up' | 'ready' | 'updating' | 'no-permission' | 'failed' | 'set-up-elsewhere' | 'access-removed'

export type GoingLiveRow = {
  state: GoingLiveState
  /** While setting up or updating: what is being done now. */
  phase: 'checking' | 'upload' | 'secrets' | 'access' | null
  /** The permission the token lacks, when `state` is `no-permission`. */
  permission: string | null
  /** A fixed sentence: why a set-up failed (`failed`), or what else the row has to say. */
  reason: string | null
  /** Why the row reads `not-set-up` when Settings had an address: none found at Cloudflare, or one for another account. */
  note: 'not-found' | 'other-account' | null
  /** The live service's address (workers.dev), when one is recorded. */
  address: string | null
  /** The build deployed there, when recorded. */
  build: string | null
  /** The build this TalkWeaver carries: when it differs from `build`, the next use updates first. */
  appBuild: string
  /** How many OTHER computers the live service lists, when this computer has its own key and it said; else null. */
  others: number | null
  /** `set-up-elsewhere` only: the live service is an older build, so setting up here updates it first. */
  updatesFirst: boolean
  /** For "Details": the build and address, or which step of a set-up failed and what Cloudflare answered in numbers. */
  details: string | null
}

export const GOING_LIVE_IDLE_DETAIL = 'Polls, questions, reactions, the venue screen, Share for comments'
export const GOING_LIVE_NOT_FOUND_DETAIL = 'The live service was not found at Cloudflare: it may have been deleted there'
export const GOING_LIVE_OTHER_ACCOUNT_DETAIL = 'The live service was set up for another Cloudflare account'
export const SET_UP_GOING_LIVE = 'Set up going live'
export const TRY_AGAIN = 'Try again'
/** The button of a computer that is not (or no longer) one the live service accepts. */
export const SET_UP_ON_THIS_COMPUTER = 'Set up going live on this computer'
export const GOING_LIVE_ELSEWHERE_DETAIL = 'Set up on another computer'
export const GOING_LIVE_ELSEWHERE_UPDATES_DETAIL = 'Set up on another computer · setting up here updates the live service first'
export const GOING_LIVE_REMOVED_DETAIL = 'This computer\'s access was removed'
/** What a person is told when the app updates the live service before using it (D9). */
export const LIVE_UPDATING_NOTICE = 'Updating the live service…'
export const LIVE_SETTING_UP_NOTICE = 'Setting up going live…'

/** The Ready row's one line of detail. The service's address is shown under Details. */
export const GOING_LIVE_READY_DETAIL = 'Live sessions run on your Cloudflare account'

const PHASE_DETAIL = { checking: 'Checking the live service', upload: 'Uploading the live service', secrets: 'Setting its keys', access: 'Waiting for the live service to accept this computer' } as const

/** The row's one line of detail. */
export function goingLiveRowDetail(row: GoingLiveRow): string {
  switch (row.state) {
    case 'unknown': return GOING_LIVE_IDLE_DETAIL
    case 'not-set-up':
      return row.note === 'not-found' ? GOING_LIVE_NOT_FOUND_DETAIL : row.note === 'other-account' ? GOING_LIVE_OTHER_ACCOUNT_DETAIL : GOING_LIVE_IDLE_DETAIL
    case 'setting-up':
    case 'updating': return PHASE_DETAIL[row.phase ?? 'checking']
    case 'ready': {
      // The audience never sees the service's address (the handout page connects to it behind the
      // scenes), so the row says what it is in plain words; the address is in Details (Dominik, 10 Oct).
      const where = row.address ? GOING_LIVE_READY_DETAIL : GOING_LIVE_IDLE_DETAIL
      return row.build !== row.appBuild ? `${where} · updated before the next use` : where
    }
    case 'no-permission': return `Missing permission: ${row.permission ?? WORKERS_PERMISSION}`
    case 'failed': return row.reason ?? 'The live service could not be set up.'
    case 'set-up-elsewhere': return row.updatesFirst ? GOING_LIVE_ELSEWHERE_UPDATES_DETAIL : GOING_LIVE_ELSEWHERE_DETAIL
    case 'access-removed': return GOING_LIVE_REMOVED_DETAIL
  }
}

/** "Ready", or "Ready · this computer and 2 others" when the live service lists other computers. */
export function readyText(others: number | null): string {
  if (!Number.isInteger(others) || (others as number) < 1) return 'Ready'
  return `Ready · this computer and ${others} ${others === 1 ? 'other' : 'others'}`
}

/** The row's right-hand edge, word for word as in the spec. `failed` also offers Try again (beside it). */
export function goingLiveRowEdge(row: GoingLiveRow): RowEdge {
  switch (row.state) {
    case 'unknown': return { kind: 'none' }
    case 'not-set-up': return { kind: 'action', label: SET_UP_GOING_LIVE }
    case 'setting-up': return { kind: 'state', text: 'Setting up…', tone: 'quiet' }
    case 'ready': return { kind: 'state', text: readyText(row.others), tone: 'good' }
    case 'updating': return { kind: 'state', text: 'Updating…', tone: 'quiet' }
    case 'no-permission': return { kind: 'state', text: 'The token cannot run the live service', tone: 'warn' }
    case 'failed': return { kind: 'state', text: 'Set-up failed', tone: 'warn' }
    case 'set-up-elsewhere':
    case 'access-removed': return { kind: 'action', label: SET_UP_ON_THIS_COMPUTER }
  }
}

/** Whether the row offers Try again beside its state. */
export const goingLiveRowRetries = (row: GoingLiveRow): boolean => row.state === 'failed'

/**
 * What Go live or Share for comments shows when there is no live service to use (the spec's "What
 * each user action does" table): "Going live is not set up" with Open Settings, connected or not.
 * The live service is set up only from the Settings row (fix round 2): a slide's content can reach
 * the presenter window and the share sheet's page, never Settings, so nothing there can deploy it.
 * Presenting and editing go on either way: the prompt holds nothing up.
 */
export type LiveSetupPrompt = 'open-settings'

export function liveSetupPromptCopy(_prompt: LiveSetupPrompt): { title: string; action: string } {
  return { title: 'Going live is not set up', action: 'Open Settings' }
}

export function unknownGoingLive(appBuild: string): GoingLiveRow {
  return { state: 'unknown', phase: null, permission: null, reason: null, note: null, address: null, build: null, appBuild, others: null, updatesFirst: false, details: null }
}
