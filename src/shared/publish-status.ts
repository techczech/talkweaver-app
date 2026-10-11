// What Publish handout and Publish Run handout say when publishing cannot start, and what a publish
// that went up without live features says (spec docs/plans/cloudflare-setup-in-app, D7 and the table
// "What each user action does when its feature is not ready"). Pure, importing only the Cloudflare
// states: the main process decides which of these applies, the windows show it, and the tests read
// the same sentences.
import {
  PAGES_PERMISSION, STORAGE_UNAVAILABLE_READ, STORAGE_UNAVAILABLE_SAVE, type CloudflareStatus,
} from './cloudflare-status.ts'

/** Decision D7, word for word. */
export const PUBLISHED_WITHOUT_LIVE = 'Published. Going live is not set up: Settings → Cloudflare'
/** The sheet for "Not connected", word for word. */
export const NOT_CONNECTED_TITLE = 'Publishing needs a Cloudflare account'
export const OPEN_SETTINGS = 'Open Settings'
export const SAVE_AS_FILE = 'Save as a file instead'

/**
 * Why publishing cannot start. `not-connected`: no token (the sheet, with "Save as a file
 * instead"). `not-ready`: connected, and one named thing is missing, with the one button that
 * fixes it.
 */
export type PublishNotReady = {
  kind: 'not-connected' | 'not-ready'
  /** The missing thing, named. */
  title: string
  detail: string | null
  fix: { action: 'open-settings' | 'create-site'; label: string }
}

const inSettings = { action: 'open-settings', label: OPEN_SETTINGS } as const
const notReady = (title: string, detail: string | null): PublishNotReady => ({ kind: 'not-ready', title, detail, fix: inSettings })

/**
 * From a completed check to what stops a publish, or null when nothing does. Takes what the CHECK
 * found: a row turned to "The token cannot publish pages" by an earlier refused publish does not
 * stop the next attempt (the person may have added the permission at Cloudflare since).
 */
export function publishNotReady(status: CloudflareStatus): PublishNotReady | null {
  const { connection, publishing } = status
  switch (connection.state) {
    case 'no-token':
      return { kind: 'not-connected', title: NOT_CONNECTED_TITLE, detail: null, fix: inSettings }
    case 'storage-unavailable':
      return { kind: 'not-connected', title: NOT_CONNECTED_TITLE, detail: `${connection.doing === 'read' ? STORAGE_UNAVAILABLE_READ : STORAGE_UNAVAILABLE_SAVE}.`, fix: inSettings }
    case 'checking':
      return notReady('Cloudflare is still being checked', 'Try again in a moment.')
    case 'rejected':
      return notReady('Cloudflare did not accept this token', 'Replace the token in Settings → Cloudflare.')
    case 'unreachable':
      return notReady('Cloudflare could not be reached', 'Try again when this computer is online.')
    case 'choose-account':
      return notReady('Choose a Cloudflare account', 'The token can see several accounts. Choose the one to publish to in Settings → Cloudflare.')
    case 'connected':
      break
  }
  switch (publishing.state) {
    case 'ready':
      return null
    case 'no-site':
      return {
        kind: 'not-ready', title: 'No site yet', detail: `Handouts are published to the Cloudflare Pages site ${publishing.project}, which does not exist yet.`,
        fix: { action: 'create-site', label: `Create ${publishing.project}` },
      }
    case 'no-permission':
      return notReady('The token cannot publish pages', `Add this permission to the token: ${publishing.permission ?? PAGES_PERMISSION}.`)
    case 'creating':
      return notReady('The site is being created', 'Try again in a moment.')
    case 'unknown':
      return notReady('Publishing is not ready', status.notice ?? 'Check the connection in Settings → Cloudflare.')
  }
}

/** The notice for a handout that went up without live features; `reason` is a sorted sentence or null. */
export function publishedWithoutLiveText(reason: string | null): string {
  return reason ? `${PUBLISHED_WITHOUT_LIVE}. ${reason}` : PUBLISHED_WITHOUT_LIVE
}

/**
 * Handouts an earlier version published with an address on this computer as their live address are
 * still on the site. They do not stop a publish; this is the one sentence that says how many there are.
 */
export function earlierHandoutsText(count: number): string {
  return count === 1
    ? '1 earlier handout on this site still carries an address on this computer, so its live features cannot work. Publish it again.'
    : `${count} earlier handouts on this site still carry an address on this computer, so their live features cannot work. Publish them again.`
}
