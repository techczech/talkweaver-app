// What the Cloudflare screen shows: the states of the connection and of each feature row, and the
// exact words for each (spec docs/plans/cloudflare-setup-in-app, "States"). Pure, with no imports,
// so the main process (which produces a status), the Settings window (which shows it) and the
// command line of a later ticket all use the same states and the same sentences.
//
// Nothing here holds or names a secret. The only text in a status that did not come from this file
// is an account's name and id (shown as "Connected · <account name>"), which the main process cuts
// to plain printable text before it is put in a status.

/** The Pages site the app offers to create when none is named in Settings (decision D5). */
export const DEFAULT_PAGES_PROJECT = 'talkweaver-handouts'

export type CloudflareAccount = { id: string; name: string }

export type CloudflareConnection =
  | { state: 'no-token' }
  /** A token is saved and no check has finished yet. */
  | { state: 'checking' }
  /** `account` is null only when the token is valid but shows no account at all. */
  | { state: 'connected'; account: CloudflareAccount | null }
  | { state: 'choose-account'; accounts: CloudflareAccount[] }
  | { state: 'rejected' }
  /** `lastCheckedAt`: when a check last got an answer (ms since 1970), or null when none has. */
  | { state: 'unreachable'; lastCheckedAt: number | null }
  /** `doing`: whether it is saving a token or reading the saved one that cannot be done. */
  | { state: 'storage-unavailable'; doing: 'save' | 'read' }

export type CustomDomainState = 'none' | 'set' | 'not-reachable'

export type PublishingRow = {
  /**
   * `unknown`: nothing to say yet (not connected, no account chosen, or not answered). `ready`: the
   * token was accepted and the site was found (a read); that it may publish is proven by the first publish.
   */
  state: 'unknown' | 'ready' | 'no-permission' | 'no-site' | 'creating'
  /** The Pages site the row is about: the one named in Settings, or the default. */
  project: string
  /** The permission the token lacks, when `state` is `no-permission`. */
  permission: string | null
  customDomain: CustomDomainState
  /**
   * The handout web address itself, as a bare hostname: the custom domain the handouts are served
   * on (the one in Settings when it is active on the site, else the site's first active custom
   * domain), or the site's own pages.dev address when it has none active. Null when not known.
   */
  address: string | null
  /** The last known state, shown greyed, because the latest check got no answer. */
  stale: boolean
}

/**
 * Only what a read can tell about going live. `not-refused`: Cloudflare did not refuse a read of
 * the account's Workers; whether the token may deploy is proven by the first set-up, not here.
 */
export type LiveServiceRow = {
  state: 'unknown' | 'not-refused' | 'no-permission'
  permission: string | null
  stale: boolean
}

/**
 * The Share-link domain row (spec "Per feature"): the address typed in Settings and what Cloudflare
 * says about it. `none`: no address set. `attached`: it is a Workers custom domain of this account.
 * `not-on-account`: no zone of this account contains it. `no-permission`: the token cannot attach a
 * domain (it was refused the zone or its Workers routes). `not-attached`: its zone is on this
 * account, the token was not refused the zone's Workers routes, and the address is not yet a Workers
 * custom domain ("Not attached yet"). `unknown`: nothing to say yet (not connected, not answered).
 */
export type ShareLinkRow = {
  state: 'unknown' | 'none' | 'attached' | 'not-on-account' | 'no-permission' | 'not-attached'
  /** The bare hostname in Settings, or ''. */
  host: string
  /**
   * With no address in Settings (`none`) and a custom domain on the publishing site: the address the
   * row suggests typing (share.<custom domain>), and the zone it would be in. Text only: nothing is
   * read, set or attached for it.
   */
  suggested: { host: string; zone: string } | null
  /** The permission the token lacks, when `state` is `no-permission`. */
  permission: string | null
  /** The last known state, shown greyed, because the latest check got no answer. */
  stale: boolean
}

export type CloudflareStatus = {
  connection: CloudflareConnection
  publishing: PublishingRow
  liveService: LiveServiceRow
  shareLink: ShareLinkRow
  /** A check, an account choice or a site creation is under way. */
  busy: boolean
  /** When a check last got an answer (ms since 1970). */
  checkedAt: number | null
  /** A fixed sentence about the last thing asked for that did not work, or null. */
  notice: string | null
  /** For "Details": request names, HTTP statuses and Cloudflare error numbers. Never reply text. */
  details: string | null
}

export type ConnectionAction = 'paste-token' | 'how-to' | 'check-again' | 'replace-token' | 'disconnect' | 'choose-account'

export const PAGES_PERMISSION = 'Account · Cloudflare Pages · Edit'
export const WORKERS_PERMISSION = 'Account · Workers Scripts · Edit'
export const ROUTES_PERMISSION = 'Zone · Workers Routes · Edit'

/** "How to make a token": the permissions each of the four features needs from the one token. */
export const TOKEN_PERMISSIONS: ReadonlyArray<{ feature: string; permissions: readonly string[]; note?: string }> = [
  { feature: 'Publishing handouts', permissions: [PAGES_PERMISSION] },
  { feature: 'Going live and sharing', permissions: [WORKERS_PERMISSION] },
  { feature: 'Share-link domain', permissions: [ROUTES_PERMISSION], note: 'for the zone the domain is in' },
  { feature: 'Recording storage', permissions: [], note: 'none from this token: recordings use their own access keys, entered under Recording storage' },
]

export const HOW_TO_MAKE_A_TOKEN: readonly string[] = [
  'In the Cloudflare dashboard open My Profile → API Tokens → Create Token → Create Custom Token.',
  'Add the permissions below, and under Account Resources choose the account TalkWeaver should use.',
  'Create the token, copy it (Cloudflare shows it once) and paste it here.',
]

export const STORAGE_UNAVAILABLE_SAVE = "This computer's secure storage is unavailable, so the token cannot be saved"
export const STORAGE_UNAVAILABLE_READ = "This computer's secure storage is unavailable, so the token cannot be read"
export const LIVE_NO_PERMISSION = 'The token cannot run the live service'

const two = (value: number): string => String(value).padStart(2, '0')
/** 09:14, in this computer's time. */
export function clockTime(at: number): string {
  const date = new Date(at)
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}

/** The connection header, word for word as in the spec's "Cloudflare connection" table. */
export function connectionLabel(connection: CloudflareConnection, formatTime: (at: number) => string = clockTime): string {
  switch (connection.state) {
    case 'no-token': return 'Not connected'
    case 'checking': return 'Checking…'
    case 'connected': return connection.account ? `Connected · ${connection.account.name}` : 'Connected'
    case 'choose-account': return 'Choose an account'
    case 'rejected': return 'Cloudflare did not accept this token'
    case 'unreachable':
      return connection.lastCheckedAt === null ? 'Could not check (offline?)' : `Could not check (offline?) · last checked ${formatTime(connection.lastCheckedAt)}`
    case 'storage-unavailable': return connection.doing === 'read' ? STORAGE_UNAVAILABLE_READ : STORAGE_UNAVAILABLE_SAVE
  }
}

/** The actions the spec's table offers in each connection state, in its order. */
export function connectionActions(connection: CloudflareConnection): ConnectionAction[] {
  switch (connection.state) {
    case 'no-token': return ['paste-token', 'how-to']
    case 'connected': return ['check-again', 'replace-token', 'disconnect']
    case 'choose-account': return ['choose-account']
    case 'rejected': return ['replace-token']
    case 'unreachable': return ['check-again']
    case 'checking':
    case 'storage-unavailable': return []
  }
}

/** The Publishing handouts row. `unknown` has no sentence in the spec: it shows as a dash. */
export function publishingLabel(row: PublishingRow): string {
  switch (row.state) {
    case 'ready': return 'Ready'
    case 'no-permission': return 'The token cannot publish pages'
    case 'no-site': return `No site yet — Create ${row.project}`
    case 'creating': return 'Creating…'
    case 'unknown': return '—'
  }
}

// ── The feature rows on the screen ──────────────────────────────────────────────────────────────
// Each row of Settings → Cloudflare is its name and ONE line of detail at the left, and its state
// or its one action at the right-hand edge (the approved sketch; Dominik, 8 Oct). A row with nothing
// to report shows no state at all: never a dash.

/** What a feature row shows at its right-hand edge: a state in words, the one action, or nothing. */
export type RowEdge = { kind: 'state'; text: string; tone: 'good' | 'warn' | 'quiet' } | { kind: 'action'; label: string } | { kind: 'none' }

export const PUBLISHING_ROW_NAME = 'Publishing handouts'
export const SHARE_LINK_ROW_NAME = 'Share-link domain'
// The Going live and sharing row's words are in live-service-status.ts (ticket 05).

/**
 * The handout web address the Publishing handouts row shows as a link, or null. Shown only when the
 * row is Ready and the address is reachable: a custom domain in Settings that is not active on the
 * site reads "Custom domain: not reachable" instead.
 */
export function publishingRowLink(row: PublishingRow): { label: string; href: string } | null {
  if (row.state !== 'ready' || row.customDomain === 'not-reachable' || !row.address) return null
  return { label: row.address, href: `https://${row.address}/` }
}

/** The Publishing handouts row's one line of detail. Ready: the site and the handout web address ("Site my-handouts · handouts.example"). */
export function publishingRowDetail(row: PublishingRow): string {
  switch (row.state) {
    case 'ready': {
      const link = publishingRowLink(row)
      return `Site ${row.project} · ${link ? link.label : customDomainLabel(row.customDomain)}`
    }
    case 'no-permission': return `Missing permission: ${row.permission ?? PAGES_PERMISSION}`
    case 'no-site': return 'No site yet'
    case 'creating': return `Making the site ${row.project}`
    case 'unknown': return 'Handouts are published to your own Cloudflare Pages site'
  }
}

/** The Publishing handouts row's right-hand edge. "No site yet" offers its one action: Create <site>. */
export function publishingRowEdge(row: PublishingRow): RowEdge {
  switch (row.state) {
    case 'ready': return { kind: 'state', text: 'Ready', tone: 'good' }
    case 'no-permission': return { kind: 'state', text: 'The token cannot publish pages', tone: 'warn' }
    case 'no-site': return row.stale ? { kind: 'none' } : { kind: 'action', label: `Create ${row.project}` }
    case 'creating': return { kind: 'state', text: 'Creating…', tone: 'quiet' }
    case 'unknown': return { kind: 'none' }
  }
}

export function customDomainLabel(state: CustomDomainState): string {
  return `Custom domain: ${state === 'not-reachable' ? 'not reachable' : state}`
}

export function unknownPublishing(project: string): PublishingRow {
  return { state: 'unknown', project, permission: null, customDomain: 'none', address: null, stale: false }
}
export const UNKNOWN_LIVE_SERVICE: LiveServiceRow = { state: 'unknown', permission: null, stale: false }

export function unknownShareLink(host = ''): ShareLinkRow {
  return { state: 'unknown', host, suggested: null, permission: null, stale: false }
}

/** The label of the share-link address the row suggests on the handout web address: handouts.fyi → share.handouts.fyi. */
export const SHARE_SUBDOMAIN_LABEL = 'share'

/**
 * The share-link address the row suggests from the handout web address (a bare hostname), or null:
 * none for no address, for a pages.dev address (not a zone of the person's account), or when the
 * result would not be a usable hostname. The live service cannot share a hostname with the Pages
 * site, so the suggestion is a subdomain of it. Pure; a suggestion only.
 */
export function suggestedShareHost(address: string | null): { host: string; zone: string } | null {
  if (!address) return null
  const zone = address.trim().toLowerCase()
  if (!zone || zone === 'pages.dev' || zone.endsWith('.pages.dev')) return null
  const host = `${SHARE_SUBDOMAIN_LABEL}.${zone}`
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  return host.length <= 253 && host.split('.').length >= 3 && host.split('.').every((part) => label.test(part)) ? { host, zone } : null
}

/** The Share-link domain row's one action, with no address set and one suggested: save and attach it. */
export function shareLinkUseLabel(suggested: { host: string }): string {
  return `Use ${suggested.host}`
}
/** Pressed when the row no longer offers it (it changed under the press). */
export const SHARE_LINK_NOT_NOW = 'There is no suggested share-link address just now. Check again.'
/** The token may not attach a domain: what to do, in plain words, with the permission as the app names it everywhere. */
export const SHARE_LINK_ADD_PERMISSION = (permission: string): string => `Add the permission ${permission} to your Cloudflare token, then press Check again`

/** The Share-link domain row's one line of detail. */
export function shareLinkRowDetail(row: ShareLinkRow): string {
  switch (row.state) {
    case 'attached': return row.host
    case 'none': return row.suggested
      ? `Share for comments links can use ${row.suggested.host}, on your handout domain ${row.suggested.zone}. The token needs the permission ${ROUTES_PERMISSION}`
      : 'No address set in Settings'
    case 'not-on-account': return `${row.host} is in no zone of this account`
    case 'no-permission': return SHARE_LINK_ADD_PERMISSION(row.permission ?? ROUTES_PERMISSION)
    case 'not-attached': return row.host
    case 'unknown': return row.host || 'The address your shared talk links use'
  }
}

/** The Share-link domain row's right-hand edge, word for word as in the spec. */
export function shareLinkRowEdge(row: ShareLinkRow): RowEdge {
  switch (row.state) {
    case 'attached': return { kind: 'state', text: 'Attached', tone: 'good' }
    // A suggestion is offered as the row's one button; nothing is saved or attached until it is pressed.
    case 'none': return row.suggested && !row.stale ? { kind: 'action', label: shareLinkUseLabel(row.suggested) } : { kind: 'state', text: 'None', tone: 'quiet' }
    case 'not-on-account': return { kind: 'state', text: 'This domain is not on this Cloudflare account', tone: 'warn' }
    case 'no-permission': return { kind: 'state', text: 'The token cannot attach a domain', tone: 'warn' }
    case 'not-attached': return { kind: 'state', text: 'Not attached yet', tone: 'quiet' }
    case 'unknown': return { kind: 'none' }
  }
}
