// Share for comments (ticket 03): the types main, preload and renderer share, plus the pure pieces
// the share sheet and the main-process module both lean on — the link builder and the sheet's
// view model. Plain erasable TypeScript: imported by Node tests under native type stripping.
import { liveSetupPromptCopy, type LiveSetupPrompt } from './live-service-status.ts'

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
  /** The talk had a share when the look began and a Stop closed it before the answer (ticket 12
   *  round 2): the sheet says the talk is no longer shared and does not share it again. */
  stopped?: { shareId: string }
  /** A create of this talk from before (the app quit while its reply was awaited) was never
   *  registered: a share may still be open on the service. What to say; the sheet asks before it
   *  shares, and that Share replaces it (ticket 12 round 2, design note [s]). */
  interruptedShare?: string
}

export interface SharedTalkStopResult {
  /** The Worker closed the share. False: stopped here only (the Worker refused the owner token). */
  serverClosed: boolean
  /** Said to the person when the stop was local only. */
  message: string | null
}

/** A Share that was stopped part-way (ticket 12): neither a link nor a failure. `shareId` is the share
 *  this Share made and that was then closed, or null when none was made. Never a closed link. */
export interface SharedTalkStopped {
  stopped: true
  shareId: string | null
}

export function isSharedTalkStopped(value: unknown): value is SharedTalkStopped {
  return Boolean(value) && (value as SharedTalkStopped).stopped === true
}

export const SHARE_STOPPED_MESSAGE = 'This talk is no longer shared.'

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

/** The link colleagues open. `linkBase` (the attached share-link address, e.g. https://drafts.handouts.fyi)
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

export type ShareSheetPhase = 'loading' | 'confirm-replace' | 'creating' | 'ready' | 'stopping' | 'error' | 'stopped'

export interface ShareSheetModel {
  phase: ShareSheetPhase
  share: SharedTalkState | null
  /** The outline's share_url from another Mac (phase confirm-replace). */
  foreignShareUrl: string | null
  /** A failure to create or stop (a push failure lives on share.lastError). */
  error: string | null
  /** Copy link just succeeded (the button says so briefly). */
  copied: boolean
  /** The share could not be made because going live is not set up: the sheet offers Open Settings (ticket 05). */
  setup: LiveSetupPrompt | null
  /** The share this sheet was told is closed (a null broadcast, a stopped reply): a later message
   *  carrying it never brings it back (ticket 12 round 2, finding 1). */
  goneShareId: string | null
  /** A share from before may still be open (inspected `interruptedShare`, phase confirm-replace). */
  interruptedShare?: string | null
}

export type ShareSheetEvent =
  | { type: 'inspected'; share: SharedTalkState | null; foreignShareUrl: string | null; stopped?: { shareId: string }; interruptedShare?: string }
  | { type: 'creating' }
  | { type: 'created'; share: SharedTalkState }
  | { type: 'changed'; share: SharedTalkState | null }
  | { type: 'failed'; error: string; setup?: LiveSetupPrompt }
  | { type: 'copied' }
  | { type: 'copy-reset' }
  | { type: 'stopping' }
  /** The sheet's own Share was stopped part-way (the share() reply `{ stopped: true, shareId }`). */
  | { type: 'share-stopped'; shareId: string | null }

export function initialShareSheet(): ShareSheetModel {
  return { phase: 'loading', share: null, foreignShareUrl: null, error: null, copied: false, setup: null, goneShareId: null }
}

// The table is the ticket 12 design, section 5 (src/main/shared-talk.ts header). The sheet follows the
// talk, not the request: a broadcast that the share is gone, or a stopped reply, leaves "Creating…"
// for `stopped`, and the sheet never offers a closed link.
export function shareSheetReducer(model: ShareSheetModel, event: ShareSheetEvent): ShareSheetModel {
  const parked = model.phase === 'loading' || model.phase === 'confirm-replace'
  switch (event.type) {
    case 'inspected':
      if (event.stopped) return { ...model, phase: 'stopped', share: null, foreignShareUrl: null, error: null, goneShareId: event.stopped.shareId }
      if (event.share && event.share.shareId === model.goneShareId) return model
      if (event.share) return { ...model, phase: 'ready', share: event.share, foreignShareUrl: null, error: null }
      // Another Mac's share_url, or a share from before this app last quit: asked before sharing.
      if (event.interruptedShare) return { ...model, phase: 'confirm-replace', share: null, foreignShareUrl: event.foreignShareUrl, error: null, interruptedShare: event.interruptedShare }
      return { ...model, phase: event.foreignShareUrl ? 'confirm-replace' : 'creating', share: null, foreignShareUrl: event.foreignShareUrl, error: null }
    case 'creating':
      return { ...model, phase: 'creating', error: null }
    case 'created':
      if (model.phase === 'stopping') return model
      return { ...model, phase: 'ready', share: event.share, foreignShareUrl: null, error: null, setup: null }
    case 'changed':
      if (parked) return model
      // A broadcast for this talk: a null share means it was stopped (here or in another window).
      if (!event.share) {
        if (model.phase === 'error' || model.phase === 'stopped') return model
        return { ...model, phase: 'stopped', share: null, error: null, copied: false, goneShareId: model.share?.shareId ?? model.goneShareId }
      }
      // A share this sheet was told is closed never comes back (a reply captured before the Stop).
      if (event.share.shareId === model.goneShareId) return model
      return { ...model, share: event.share, phase: model.phase === 'stopping' ? 'stopping' : 'ready' }
    case 'share-stopped':
      if (parked || model.phase === 'stopping' || model.phase === 'stopped') return model
      // A newer share the sheet already follows is not the one that was stopped.
      if (model.share && model.share.shareId !== event.shareId) return model
      return { ...model, phase: 'stopped', share: null, error: null, copied: false, setup: null, goneShareId: event.shareId ?? model.goneShareId }
    case 'failed':
      // A failed Stop (or copy, or switch) keeps the share and re-enables its controls; a failed
      // Share has no link to show.
      if (model.phase === 'stopped') return { ...model, error: event.error }
      if ((model.phase === 'ready' || model.phase === 'stopping') && model.share) return { ...model, phase: 'ready', error: event.error, setup: null }
      return { ...model, phase: 'error', error: event.error, setup: event.setup ?? null }
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
  /** Going live is not set up: the prompt (its title and its one button, Open Settings), or null. */
  setupPrompt: { prompt: LiveSetupPrompt; title: string; action: string } | null
}

export function shareSheetView(model: ShareSheetModel): ShareSheetView {
  const share = model.share
  const ready = model.phase === 'ready' && !!share
  let status = ''
  let statusTone: 'quiet' | 'error' = 'quiet'
  if (model.phase === 'loading') status = ''
  else if (model.phase === 'creating') status = 'Creating the link…'
  else if (model.phase === 'stopping') status = 'Stopping…'
  else if (model.phase === 'stopped') { status = model.error ?? SHARE_STOPPED_MESSAGE; statusTone = model.error ? 'error' : 'quiet' }
  else if (model.error) { status = model.error; statusTone = 'error' }
  else if (share?.ended) { status = SHARE_ENDED_MESSAGE; statusTone = 'error' }
  else if (share?.lastError) { status = `Their page is not up to date: ${share.lastError}`; statusTone = 'error' }
  else if (share?.pushing) status = 'Updating their page…'
  else if (share && share.revision === 0) status = 'Their page is not ready yet.'
  const localOnly = Boolean(share?.localOnly)
  return {
    link: share?.url ?? '',
    // An ended share (round 3) is gone: its link is never offered for copying.
    canCopy: ready && !share?.ended,
    copyLabel: model.copied ? 'Copied' : 'Copy link',
    showPasteHint: !localOnly,
    localNote: localOnly ? 'This link works only on this Mac: sharing is running on a local test service.' : '',
    replaceWarning: model.phase !== 'confirm-replace' ? ''
      : model.interruptedShare ? [model.interruptedShare, model.foreignShareUrl ? FOREIGN_SHARE_WARNING : ''].filter(Boolean).join(' ')
        : FOREIGN_SHARE_WARNING,
    showUpdate: ready && !share!.liveUpdates,
    canStop: ready,
    switchesEnabled: ready,
    status,
    statusTone,
    setupPrompt: model.setup && model.phase === 'error' ? { prompt: model.setup, ...liveSetupPromptCopy(model.setup) } : null,
  }
}

/** Status-bar chip text for a shared talk. */
export function sharedStatusLabel(share: Pick<SharedTalkState, 'url'>): string {
  return `Shared for comments · ${share.url.replace(/^https?:\/\//, '')}`
}
