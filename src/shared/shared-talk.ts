// Share for comments (ticket 03): the types main, preload and renderer share, plus the pure pieces
// the share sheet and the main-process module both lean on — the link builder and the sheet's
// view model. Plain erasable TypeScript: imported by Node tests under native type stripping.

/** One slide as the shared-talk Worker stores it: the proposal editor edits and diffs `text`. */
export interface SharedTalkSlide {
  slideId: string
  title: string
  /** The slide's outline source (heading, Trigger line, body), speaker notes and comments removed. */
  text: string
}

/** A shared talk as the renderer sees it. The owner token never leaves the main process. */
export interface SharedTalkState {
  /** The talk's identity (the outline writer's outlineIdentity key): one talk, one share. */
  key: string
  slug: string
  outlinePath: string
  /** The outline's real path, for matching a talk-list row to its share. */
  realPath: string
  shareId: string
  /** The link to hand out (drafts host when configured, else the Worker origin). */
  url: string
  /** The Worker runs on this Mac (a local test Worker): the link opens nowhere else. */
  localOnly: boolean
  /** Last revision the Worker confirmed (0 = nothing pushed yet). */
  revision: number
  /** Switch 1: push every save in the background. */
  liveUpdates: boolean
  /** Switch 2: they may propose slide text, deletions and new slides, not only notes. */
  proposals: boolean
  createdAt: string
  lastPushedAt: string | null
  /** A push is queued or running. */
  pushing: boolean
  /** The last push or stop failure, cleared by the next success. Never blocks a save. */
  lastError: string | null
  /** The QR code for `url`, as an SVG string ('' when the compiler could not draw one). */
  qrSvg: string
  /** The link has ended: stopped elsewhere, retired, or the owner credential refused. */
  ended?: SharedTalkEnded | null
}

export type SharedTalkEnded = 'stopped' | 'retired' | 'refused'
export const SHARE_ENDED_MESSAGE = 'Sharing has ended for this link. Stop sharing to clear it, or share again for a new link.'

/** What the sheet needs before it shares: the share this Mac holds, or a `share_url` the outline
 *  carries that this Mac did not create (shared from another Mac). */
export interface SharedTalkInspection {
  share: SharedTalkState | null
  foreignShareUrl: string | null
}

export interface SharedTalkStopResult {
  /** The Worker closed the share. False: stopped here only (the Worker refused the owner token). */
  serverClosed: boolean
  /** Said to the person when the stop was local only. */
  message: string | null
}

export const STOPPED_LOCALLY_MESSAGE = 'Could not stop it on the server; the link retires on its own.'
export const FOREIGN_SHARE_WARNING = 'Already shared from another Mac; sharing here replaces that link.'

/** True for a Worker origin on this machine (127.0.0.1, localhost, ::1). */
export function isLocalOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch { return false }
}

const IPV4_SHAPE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const HOSTNAME_LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

/** True for a bare hostname fit to be a Workers Custom Domain route pattern (ticket 07 Settings'
 *  "Share link domain"): dot-separated RFC 1035 labels only — no scheme, port, path, spaces,
 *  wildcard, IP literal or localhost. Settings refuses anything else before it is ever saved
 *  (src/main/index.ts `publish:set-config`); `sharedTalkLink` below re-checks the stored value so
 *  one written before this rule existed, or edited by hand, never silently breaks a link. */
export function isValidShareDomain(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const hostname = value.trim().toLowerCase()
  if (!hostname || hostname.length > 253) return false
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false
  if (IPV4_SHAPE.test(hostname)) return false
  const labels = hostname.split('.')
  // A colon (scheme, port, IPv6), a slash (path), a space or a `*` (wildcard) all fail here too:
  // none of those characters is ever valid inside a label, so the per-label check below already
  // refuses them — no separate character-class check is needed.
  return labels.length >= 2 && labels.every((label) => HOSTNAME_LABEL.test(label))
}

/** The link colleagues open. `linkBase` (config `sharedTalkLinkBase`, e.g. https://drafts.handouts.fyi)
 *  serves shares at /<id> once ticket 07's route exists; without it, or when its hostname fails
 *  isValidShareDomain, the Worker origin serves them at /shares/<id>. */
export function sharedTalkLink(workerBaseUrl: string, shareId: string, linkBase?: string | null): string {
  const base = String(linkBase ?? '').trim().replace(/\/+$/, '')
  const hostname = base ? shareLinkHostname(base) : null
  if (base && hostname && isValidShareDomain(hostname)) return `${base}/${shareId}`
  return `${String(workerBaseUrl).replace(/\/+$/, '')}/shares/${shareId}`
}

function shareLinkHostname(base: string): string | null {
  try { return new URL(base).hostname } catch { return null }
}

// ── The share sheet's view model ────────────────────────────────────────────────────────────────

export type ShareSheetPhase = 'loading' | 'confirm-replace' | 'creating' | 'ready' | 'stopping' | 'error'

export interface ShareSheetModel {
  phase: ShareSheetPhase
  share: SharedTalkState | null
  /** The outline's share_url from another Mac (phase confirm-replace). */
  foreignShareUrl: string | null
  /** A failure to create or stop (a push failure lives on share.lastError). */
  error: string | null
  /** Copy link just succeeded (the button says so briefly). */
  copied: boolean
}

export type ShareSheetEvent =
  | { type: 'inspected'; share: SharedTalkState | null; foreignShareUrl: string | null }
  | { type: 'creating' }
  | { type: 'created'; share: SharedTalkState }
  | { type: 'changed'; share: SharedTalkState | null }
  | { type: 'failed'; error: string }
  | { type: 'copied' }
  | { type: 'copy-reset' }
  | { type: 'stopping' }

export function initialShareSheet(): ShareSheetModel {
  return { phase: 'loading', share: null, foreignShareUrl: null, error: null, copied: false }
}

export function shareSheetReducer(model: ShareSheetModel, event: ShareSheetEvent): ShareSheetModel {
  switch (event.type) {
    case 'inspected':
      if (event.share) return { ...model, phase: 'ready', share: event.share, foreignShareUrl: null, error: null }
      return { ...model, phase: event.foreignShareUrl ? 'confirm-replace' : 'creating', share: null, foreignShareUrl: event.foreignShareUrl, error: null }
    case 'creating':
      return { ...model, phase: 'creating', error: null }
    case 'created':
      return { ...model, phase: 'ready', share: event.share, foreignShareUrl: null, error: null }
    case 'changed':
      // A broadcast for this talk: a null share means it was stopped (here or in another window).
      if (!event.share) return model.phase === 'ready' ? { ...model, share: null } : model
      if (model.phase === 'loading' || model.phase === 'confirm-replace') return model
      return { ...model, share: event.share, phase: model.phase === 'creating' || model.phase === 'error' ? 'ready' : model.phase }
    case 'failed':
      return { ...model, phase: model.share ? 'ready' : 'error', error: event.error }
    case 'copied':
      return { ...model, copied: true }
    case 'copy-reset':
      return { ...model, copied: false }
    case 'stopping':
      return { ...model, phase: 'stopping', error: null }
  }
}

export interface ShareSheetView {
  link: string
  canCopy: boolean
  copyLabel: string
  /** The paste hint ("Paste it into Teams or an email.") — hidden when the link opens only here. */
  showPasteHint: boolean
  /** Said under the link when the Worker is local to this Mac. */
  localNote: string
  /** The confirm step before replacing another Mac's share. */
  replaceWarning: string
  /** "Update shared copy" shows only with switch 1 off: saves no longer push on their own. */
  showUpdate: boolean
  canStop: boolean
  switchesEnabled: boolean
  /** One status line under the link: creating, pushing, failures. Empty when all is well. */
  status: string
  statusTone: 'quiet' | 'error'
}

export function shareSheetView(model: ShareSheetModel): ShareSheetView {
  const share = model.share
  const ready = model.phase === 'ready' && !!share
  let status = ''
  let statusTone: 'quiet' | 'error' = 'quiet'
  if (model.phase === 'loading') status = ''
  else if (model.phase === 'creating') status = 'Creating the link…'
  else if (model.phase === 'stopping') status = 'Stopping…'
  else if (model.error) { status = model.error; statusTone = 'error' }
  else if (share?.ended) { status = SHARE_ENDED_MESSAGE; statusTone = 'error' }
  else if (share?.lastError) { status = `Their page is not up to date: ${share.lastError}`; statusTone = 'error' }
  else if (share?.pushing) status = 'Updating their page…'
  else if (share && share.revision === 0) status = 'Their page is not ready yet.'
  const localOnly = Boolean(share?.localOnly)
  return {
    link: share?.url ?? '',
    canCopy: ready,
    copyLabel: model.copied ? 'Copied' : 'Copy link',
    showPasteHint: !localOnly,
    localNote: localOnly ? 'This link works only on this Mac: sharing is running on a local test service.' : '',
    replaceWarning: model.phase === 'confirm-replace' ? FOREIGN_SHARE_WARNING : '',
    showUpdate: ready && !share!.liveUpdates,
    canStop: ready,
    switchesEnabled: ready,
    status,
    statusTone,
  }
}

/** Status-bar chip text for a shared talk. */
export function sharedStatusLabel(share: Pick<SharedTalkState, 'url'>): string {
  return `Shared for comments · ${share.url.replace(/^https?:\/\//, '')}`
}
