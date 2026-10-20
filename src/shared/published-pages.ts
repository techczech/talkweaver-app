// The Published pages list as a pure model (work-files-and-sessions ticket 22; locked mockup S8).
// Every open vault's published Runs and talk handouts go in, with the site folder's listing on this
// computer and the time now; the rows come out, Run pages first, then Talk handouts. No Electron, no fs,
// no clock.
//
//   ONE ROW PER PAGE A PERSON CAN UNPUBLISH. A talk's evergreen handout is one row. A Run is one row,
//   whatever it sent: its handout, pre-work and post-work links are in that row's detail, never rows of
//   their own (a Run's pages go together: ticket 17 unpublishes them together).
//   A Run is listed while its pages are up (run-checklist.ts runPublication 'published', with a link); an
//   unpublished Run (its pages "not available") is not. A talk is listed while its front matter has
//   `handout_url`.
//
//   CHECKED AGAINST THE SITE FOLDER. Which folder a page lives in is decided in main from the page's own
//   facts (run-unpublish.ts runSiteFolder, talk-unpublish.ts talkSiteFolder), never from the listing; this
//   model only looks the name up in the listing. A page whose folder is not in this computer's copy of the
//   site says so, in ticket 17's words, and is never offered "Publish again" (ticket 17 D3: every upload is
//   the whole site folder, so publishing from an incomplete copy takes other pages down).
//
//   UNPUBLISH. A Run row goes through ticket 17's path unchanged (`run:unpublish-handout`); a talk row
//   through the talk-handout unpublish (`published:unpublish-talk`). `blocked` is the sentence when main
//   would refuse it before doing anything: the site's copy missing, or a link that names no folder of its
//   own (both kinds); a Run that sent work pages whose folder is not here (17 refuses: no page could be
//   replaced). A handout (talk, or Run with its handout only) whose folder is not here goes ahead, as 17's
//   REMOVE does, and says only that this computer does not have it.
import { dayLabel, localTimeIn, postWorkWindow, runPublication, whenLabel } from './run-checklist.ts'
import { unpublishConfirmText } from './run-page.ts'
import { SESSION_END, workPageUrl } from './run-work.ts'
import type { SessionSource } from './sessions-list.ts'

/**
 * The page's folder in the site, as main decided it from the page's own facts. `here` (talk handouts):
 * whether a real folder is at the name, home page or not, as the talk unpublish decides it; a Run's folder
 * is looked up in the listing. `not-a-folder` (talk handouts): a link, a file or anything else at the name.
 */
export type PageFolder = { kind: 'named'; name: string; here?: boolean } | { kind: 'not-a-folder'; name: string } | { kind: 'unclear' }

/** A Run as main sends it (sessions-list.ts sessionSource), with its folder. */
export interface PublishedRunSource extends SessionSource {
  folder: PageFolder
}

/** A talk whose front matter has `handout_url`. */
export interface PublishedTalkSource {
  vaultId: string
  /** The outline, relative to its vault's folder: what Unpublish names the talk by (two outlines may share a slug). */
  outline: string
  slug: string
  title: string
  /** For Open talk (the Work files view hands the renderer the same). */
  outlinePath: string
  handoutUrl: string
  folder: PageFolder
}

/** This computer's copy of the site: whether it is there, and its handout folders (a home page in each). */
export interface SiteListing {
  exists: boolean
  /** `modifiedAt`: when the folder's home page was last written (ISO), the published date when nothing else records one. */
  folders: Array<{ name: string; modifiedAt?: string }>
  /** The copy is there but could not be listed: the view says so and offers Retry, never "Nothing is published". */
  error?: string
}

export interface PublishedPagesInput {
  runs: PublishedRunSource[]
  talks: PublishedTalkSource[]
  site: SiteListing
  /** How many talks of the open vaults could not be read (main's collector); absent when every one could. */
  unreadable?: number
}

/** Where the page stands in this computer's copy of the site. */
export type PageOnSite = 'found' | 'folder-missing' | 'site-missing' | 'unclear' | 'not-a-folder'

export interface PublishedPageLink { kind: 'handout' | 'pre-work' | 'post-work'; label: string; url: string }

export type PublishedPageUnpublish =
  | { kind: 'run'; vaultId: string; talkSlug: string; runId: string; blocked: string | null }
  | { kind: 'talk'; vaultId: string; outline: string; blocked: string | null }

export interface PublishedPageRow {
  /** Unique across vaults. */
  key: string
  vaultId: string
  kind: 'run' | 'talk'
  /** The Run's event (or its talk's title); the talk's title. */
  title: string
  /** "Run page · AI for research teams" or "Talk handout". */
  sub: string
  /** The handout's link, and as shown: without its scheme and trailing slash. */
  link: string
  linkShown: string
  /** ISO instant, or null when nothing records it. */
  publishedAt: string | null
  /** "Published Wed 14 Oct", or "Published" when the date is not known. */
  published: string
  /** The detail's links, each with its own Copy: the handout, then pre-work and post-work for a Run that sent them. */
  links: PublishedPageLink[]
  site: PageOnSite
  /** What the site check found, in words; null when the page is found. */
  note: string | null
  unpublish: PublishedPageUnpublish
  /** The confirmation's title and sentence. */
  confirm: { title: string; body: string }
  /** For Open talk (talk rows only). */
  outlinePath?: string
}

export interface PublishedPagesGroup { id: 'runs' | 'talks'; label: string; rows: PublishedPageRow[] }
export interface PublishedPagesList {
  groups: PublishedPagesGroup[]; rows: PublishedPageRow[]; total: number
  /** The site's copy could not be listed, or talks could not be read and no page is listed: no rows, and this sentence (with Retry) instead of "Nothing is published". */
  error: string | null
  /** Talks could not be read but some pages are listed: they are shown, with this sentence (and Retry) above them. */
  notice: string | null
}

// Ticket 17's wording (run-unpublish.ts UNPUBLISH_SITE_MISSING, UNPUBLISH_FOLDER_MISSING), said of a page.
export const PAGE_SITE_MISSING = 'The copy of the site on this computer is missing, so this page cannot be unpublished from here. Unpublish it from the computer that published it.'
export const PAGE_FOLDER_MISSING = 'The copy of the site on this computer does not have this page, so it cannot be unpublished from here. Unpublish it from the computer that published it.'
export const PAGE_FOLDER_UNCLEAR = 'This page\'s link does not name one folder of the site that is its own, so it cannot be unpublished from here.'
export const PAGE_NOT_A_FOLDER = 'What is at this page\'s place in the copy of the site on this computer is not a folder (it is a link or a file), so it cannot be unpublished from here.'
/** The site's copy is there but could not be read (main's listing failed), or the list did not arrive. */
export const SITE_LIST_ERROR = 'The copy of the site on this computer could not be read, so the published pages cannot be listed.'
export const LIST_LOAD_ERROR = 'The published pages could not be loaded.'
/** Talks of the open vaults could not be read (review round 2): the list may be incomplete. */
export const TALKS_UNREADABLE = 'Some talks in the open vaults could not be read, so the published pages may not all be listed.'
/** A talk handout while talks could not be read: main refuses it (talk-unpublish.ts TALK_UNPUBLISH_CLAIMS_UNREAD). */
export const PAGE_TALKS_UNREADABLE = 'Some talks in the open vaults could not be read, so it is not certain this handout\'s folder is its own. It cannot be unpublished until they can be read.'
/** A Run with its handout only, whose folder is not here: ticket 17 still takes it off the site (REMOVE). */
export const PAGE_NOT_HERE = 'The copy of the site on this computer does not have this page.'

/** The link as the list shows it: no scheme, no trailing slash. */
export function shownLink(url: string): string {
  return url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')
}

function siteState(folder: PageFolder, site: SiteListing): PageOnSite {
  if (!site.exists) return 'site-missing'
  if (folder.kind === 'not-a-folder') return 'not-a-folder'
  if (folder.kind !== 'named') return 'unclear'
  if (folder.here !== undefined) return folder.here ? 'found' : 'folder-missing'
  return site.folders.some((entry) => entry.name === folder.name) ? 'found' : 'folder-missing'
}

const REFUSAL: Record<Exclude<PageOnSite, 'found'>, string> = {
  'site-missing': PAGE_SITE_MISSING, 'folder-missing': PAGE_FOLDER_MISSING, unclear: PAGE_FOLDER_UNCLEAR, 'not-a-folder': PAGE_NOT_A_FOLDER,
}

function folderTime(folder: PageFolder, site: SiteListing): string | null {
  if (folder.kind !== 'named') return null
  const at = site.folders.find((entry) => entry.name === folder.name)?.modifiedAt
  return at && Number.isFinite(Date.parse(at)) ? at : null
}

function publishedLabel(at: string | null, timeZone?: string): string {
  if (!at) return 'Published'
  const local = localTimeIn(new Date(at), timeZone)
  return local ? `Published ${dayLabel(local.slice(0, 10))}` : 'Published'
}

/** A Run's pages are up: it has a link and its stamps say published (an unpublished Run shows "not available"). */
export function runIsLive(run: Pick<SessionSource, 'handoutUrl' | 'unpublishedAt' | 'work'>): boolean {
  return !!run.handoutUrl && runPublication(run) === 'published'
}

function runRow(run: PublishedRunSource, site: SiteListing, now: Date): PublishedPageRow {
  const url = run.handoutUrl as string
  const sent = run.sent ?? []
  const state = siteState(run.folder, site)
  // Ticket 17 refuses a Run that sent work pages unless its folder is here; one with its handout only goes ahead (REMOVE).
  const blocked = state === 'found' ? null : sent.length > 0 || state === 'unclear' ? REFUSAL[state] : null
  const note = state === 'found' ? null : blocked ?? PAGE_NOT_HERE
  const stamps = (['pre', 'post'] as const).map((phase) => run.work?.[phase]?.publishedAt).filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
  const publishedAt = stamps.length ? stamps.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : folderTime(run.folder, site)
  const links: PublishedPageLink[] = [{ kind: 'handout', label: 'Handout link', url }]
  if (sent.includes('pre')) links.push({ kind: 'pre-work', label: 'Pre-work link', url: workPageUrl(url, 'pre') })
  if (sent.includes('post')) {
    const post = run.work?.post
    // THE open test (run-checklist.ts postWorkWindow): "opens after the session" until it has opened.
    const window = postWorkWindow(run, now)
    const label = !post || window.open ? 'Post-work link'
      : window.past ? 'Post-work link · closed'
      : post.opens === SESSION_END ? 'Post-work link · opens after the session'
      : `Post-work link · opens ${whenLabel(post.opens)}`
    links.push({ kind: 'post-work', label, url: workPageUrl(url, 'post') })
  }
  return {
    key: `${run.vaultId}|run|${run.talkSlug}/${run.runId}`, vaultId: run.vaultId, kind: 'run',
    title: (run.eventTitle || run.talkTitle || 'Run').trim(), sub: `Run page · ${run.talkTitle}`,
    link: url, linkShown: shownLink(url), publishedAt, published: publishedLabel(publishedAt, run.timeZone),
    links, site: state, note,
    unpublish: { kind: 'run', vaultId: run.vaultId, talkSlug: run.talkSlug, runId: run.runId, blocked },
    confirm: unpublishConfirmText(run),
  }
}

/** The talk-handout confirmation: what Unpublish does to it (its folder is taken off the site). */
export function talkUnpublishConfirmText(title: string, runPagesStay: boolean): { title: string; body: string } {
  return {
    title: `Unpublish the handout for ${title.trim() || 'this talk'}?`,
    body: `The handout will be taken off the site and its link will stop working.${runPagesStay ? ' Pages published for its runs stay up.' : ''}`,
  }
}

function talkRow(talk: PublishedTalkSource, site: SiteListing, runPagesStay: boolean, talksUnread: boolean): PublishedPageRow {
  const state = siteState(talk.folder, site)
  // Refused (talk-unpublish.ts) when the site's copy is missing, the folder is unclear or something other
  // than a folder is at its name; a folder missing from a copy that is there goes ahead, as 17's REMOVE does.
  // While talks could not be read, main refuses every talk handout (its folder may be one of theirs).
  const blocked = state === 'site-missing' || state === 'unclear' || state === 'not-a-folder' ? REFUSAL[state] : talksUnread ? PAGE_TALKS_UNREADABLE : null
  const note = state === 'found' ? null : blocked ?? PAGE_NOT_HERE
  const publishedAt = folderTime(talk.folder, site)
  return {
    key: `${talk.vaultId}|talk|${talk.outline}`, vaultId: talk.vaultId, kind: 'talk',
    title: talk.title.trim() || talk.slug, sub: 'Talk handout',
    link: talk.handoutUrl, linkShown: shownLink(talk.handoutUrl), publishedAt, published: publishedLabel(publishedAt),
    links: [{ kind: 'handout', label: 'Link', url: talk.handoutUrl }], site: state, note,
    unpublish: { kind: 'talk', vaultId: talk.vaultId, outline: talk.outline, blocked },
    confirm: talkUnpublishConfirmText(talk.title.trim() || talk.slug, runPagesStay),
    outlinePath: talk.outlinePath,
  }
}

/** Newest first; a row with no known date after the dated ones; then by title. */
function byDate(a: PublishedPageRow, b: PublishedPageRow): number {
  const at = (row: PublishedPageRow) => (row.publishedAt ? Date.parse(row.publishedAt) : -Infinity)
  return at(b) - at(a) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
}

export function publishedPages(input: PublishedPagesInput, now: Date): PublishedPagesList {
  // A listing that failed is not an empty site: no rows (each would be checked against nothing), the error instead.
  if (input.site.error) return { groups: [], rows: [], total: 0, error: input.site.error, notice: null }
  const talksUnread = (input.unreadable ?? 0) > 0
  const runs = input.runs.filter(runIsLive).map((run) => runRow(run, input.site, now)).sort(byDate)
  const withRuns = new Set(input.runs.filter(runIsLive).map((run) => `${run.vaultId}|${run.talkSlug}`))
  const talks = input.talks.filter((talk) => !!talk.handoutUrl.trim())
    .map((talk) => talkRow(talk, input.site, withRuns.has(`${talk.vaultId}|${talk.slug}`), talksUnread)).sort(byDate)
  const groups: PublishedPagesGroup[] = []
  if (runs.length) groups.push({ id: 'runs', label: 'Run pages', rows: runs })
  if (talks.length) groups.push({ id: 'talks', label: 'Talk handouts', rows: talks })
  const rows = [...runs, ...talks]
  // Talks that could not be read: never "Nothing is published"; the error when nothing is listed, else a notice.
  if (talksUnread && rows.length === 0) return { groups, rows, total: 0, error: TALKS_UNREADABLE, notice: null }
  return { groups, rows, total: rows.length, error: null, notice: talksUnread ? TALKS_UNREADABLE : null }
}
