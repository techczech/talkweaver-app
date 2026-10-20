// Unpublish a talk's evergreen handout (work-files ticket 22): the job the `talk-unpublish` entry of the
// handout publishing sequence runs (handout-publishing.ts; `published:unpublish-talk` in index.ts).
//
// WHAT IT DOES. The talk's own folder is taken out of this computer's copy of the site, with its short id
// out of the redirect registry and the redirect file, the site goes up without it, and only then is
// `handout_url` taken out of the talk's front matter (through the one outline writer, talk-writer.ts, and
// the front-matter editor, shared/frontmatter-editor.ts: ADR-0001, the outline is canonical). It is the
// talk's counterpart of ticket 17's REMOVE: nothing is replaced, the address simply stops serving the
// handout. Run handouts of the talk are other folders and are not touched; nor is any other page.
//
// THE TALK'S FOLDER IS DECIDED FROM THE TALK'S OWN FACTS (as run-unpublish.ts D2, `talkSiteFolder`). A talk
// publish writes its pages into the folder named by its slug and links it by that name or by the short id
// the registry gives that name (index.ts `talk:publish-handout`). So the folder is the slug, and only when
// the link's last segment names it either way (run-unpublish.ts runSiteFolder with the slug as the
// recorded folder). Never a path made from the link. It is UNCLEAR, and nothing is removed, when:
//   - the link names another folder, or nothing;
//   - the slug's short id is given to more than one folder;
//   - that folder is any Run's (its recorded folder, or the folder its link names), or another talk's
//     with a link (two open vaults with a talk of the same name).
// Only then is the site's copy looked at.
//
// WHAT IS AT THE FOLDER'S NAME decides the rest (review round 1, finding 1), never whether it has a home
// page: the name is the talk's (the slug, as publish names it), so
//   - a real folder there is the talk's and is removed, all of it (a folder without index.html too: what is
//     left in it would otherwise go up again);
//   - a link, a file or anything else there is refused (TALK_UNPUBLISH_NOT_A_FOLDER): nothing removed or
//     uploaded, the link kept (the publishing tool follows links, so what a link points at would go up);
//   - nothing there goes ahead, as ticket 17's REMOVE does: there is nothing of the talk's to remove, and the
//     upload of the site without it takes the handout down.
// The Published pages list decides "here" by the same rule (`siteEntry`, published-pages.ts).
//
// REFUSED, before anything is removed or uploaded:
//   - TALK_FOLDER_UNCLEAR (above);
//   - TALK_UNPUBLISH_NOT_A_FOLDER (above);
//   - TALK_UNPUBLISH_SITE_MISSING: the copy of the site on this computer is missing. Never "publish
//     again" as the way out (ticket 17 D3): every upload is the whole site folder.
//
// THE SHORT ID STAYS IN THE REGISTRY until the site is up without the folder AND the link is out of the
// talk (review round 1, finding 3). Its redirect lines leave the site's copy before the upload, as the
// folder does; the registry entry is what lets a retry still read the talk's short link as this talk's
// folder, so an upload that fails or a link the writer refuses can be finished by asking again (the folder
// then missing: the site goes up, the link is cleared, the entry goes). A kept entry never puts a redirect
// back: buildRedirects writes lines only for folders the site has.
//
// CONTAINMENT. A real folder at the name is removed by `removeSiteFolder` (membership, `lstat`, a link
// unlinked and never followed). Before that, its real path must be the site folder's real path plus its
// name: a folder that resolves anywhere else is not removed (TALK_UNPUBLISH_FOLDER_CHANGED).
//
// No Electron import and erasable TypeScript only: scripts/test-handout-publishing.mjs runs this job in the
// real publishing sequence against the fake Cloudflare API.
import { lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { publishedFolders, removeSiteFolder, type PublishBegin, type PublishBuild, type PublishJob } from './handout-publishing.ts'
import { buildRedirects, siteFolder } from './publishing-logic.ts'
import { runSiteFolder, type RunSiteFolder } from './run-unpublish.ts'
import type { RunRecord } from './runs.ts'

export const TALK_FOLDER_UNCLEAR = 'Stopped: this handout\'s link does not name one folder of the site that is this talk\'s own (it names another folder, or that folder is also a Run\'s or another talk\'s), so nothing was removed or uploaded.'
export const TALK_UNPUBLISH_SITE_MISSING = 'Unpublishing stopped: the copy of the site on this computer is missing, so this handout cannot be unpublished from here. Unpublish it from the computer that published it. Nothing was changed or uploaded.'
export const TALK_UNPUBLISH_FOLDER_CHANGED = 'Unpublishing stopped: this handout\'s folder in the site is not where it should be on this computer, so nothing was removed or uploaded.'
export const TALK_UNPUBLISH_NOT_A_FOLDER = 'Unpublishing stopped: what is at this handout\'s place in the site on this computer is not a folder (it is a link or a file), so nothing was removed or uploaded.'
export const TALK_NAME_SHARED = 'Unpublishing stopped: more than one talk in this vault has this talk\'s file name, so its handout\'s folder cannot be told apart. Nothing was removed or uploaded.'
export const TALK_UNPUBLISH_CLAIMS_UNREAD = 'Unpublishing stopped: some talks in the open vaults could not be read, so it is not certain this handout\'s folder is this talk\'s alone. Nothing was removed or uploaded; try again once they can be read.'
export const TALK_NOT_FOUND = 'That talk is no longer in an open vault.'
/** The upload went up but the link could not be taken out of the talk: said with the writer's reason. */
export const talkLinkNotCleared = (reason: string): string =>
  `The handout was taken off the site, but its link could not be removed from the talk${reason ? `: ${reason}` : '.'}`

/** What else holds a folder of the site: every Run with a link, and every OTHER talk with a link. */
export interface SiteClaims {
  runs: Array<Pick<RunRecord, 'handoutUrl' | 'handoutFolder'>>
  talks: Array<{ slug: string; handoutUrl: string }>
  /**
   * How many talks of the open vaults could not be read (an outline, or a vault's list of talks): each could
   * hold a link to this folder, so while any is unreadable the claims are not known to be complete and the
   * unpublish is refused (TALK_UNPUBLISH_CLAIMS_UNREAD; review round 2, finding 1).
   */
  unreadable: number
}

/** The folder a talk publish uses for this talk, as its link names it (runSiteFolder with the slug recorded). */
function ownFolder(talk: { slug: string; handoutUrl: string | null }, published: readonly string[], registry: Readonly<Record<string, string>>): RunSiteFolder {
  if (!talk.handoutUrl || !talk.slug) return { kind: 'none' }
  return runSiteFolder({ handoutUrl: talk.handoutUrl, handoutFolder: talk.slug }, published, registry)
}

/** What is at a name in the site folder, looked at with `lstat` (a link is never followed). */
export type SiteEntry = 'folder' | 'other' | 'none'

export function siteEntry(siteDir: string, name: string): SiteEntry {
  const folder = siteFolder(siteDir, name)
  if (folder === null) return 'other'
  try {
    const stat = lstatSync(folder)
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'folder' : 'other'
  } catch (error) {
    // Only "nothing there" is nothing; any other failure to look is not a folder this job may pass over.
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'none' : 'other'
  }
}

/** The talk's folder in the site: a Run's kinds, and a name that holds something other than a folder. */
export type TalkSiteFolder = RunSiteFolder | { kind: 'not-a-folder'; name: string }

/**
 * The talk's folder in the site, decided from the talk's own facts and checked against every other claim:
 *   found / missing — the talk's own folder (its slug): a real folder there, or nothing there;
 *   not-a-folder — a link, a file or anything else at that name;
 *   unclear — the link does not name it, its short id is given to two folders, or a Run or another talk claims it;
 *   none — no link.
 * `published` is the site's handout listing (for the claims); `entry` says what is at the talk's own name.
 */
export function talkSiteFolder(
  talk: { slug: string; handoutUrl: string | null }, published: readonly string[], registry: Readonly<Record<string, string>>, claims: SiteClaims,
  entry: (name: string) => SiteEntry,
): TalkSiteFolder {
  const bound = ownFolder(talk, published, registry)
  if (bound.kind !== 'found' && bound.kind !== 'missing') return bound
  const name = bound.name
  // The slug's short id given to another folder as well: the link may name either.
  const id = registry[name]
  if (id !== undefined && Object.entries(registry).some(([folder, other]) => folder !== name && other === id)) return { kind: 'unclear' }
  for (const run of claims.runs) {
    if (run.handoutFolder === name) return { kind: 'unclear' }
    const theirs = run.handoutUrl ? runSiteFolder(run, published, registry) : { kind: 'none' as const }
    if ((theirs.kind === 'found' || theirs.kind === 'missing') && theirs.name === name) return { kind: 'unclear' }
  }
  for (const other of claims.talks) {
    const theirs = ownFolder(other, published, registry)
    if ((theirs.kind === 'found' || theirs.kind === 'missing') && theirs.name === name) return { kind: 'unclear' }
  }
  const at = entry(name)
  return at === 'folder' ? { kind: 'found', name } : at === 'none' ? { kind: 'missing', name, recorded: false } : { kind: 'not-a-folder', name }
}

/**
 * The talk an unpublish request names (review round 1, finding 2): by its OUTLINE, relative to the vault's
 * folder, never by its slug. Taken only when it stays inside the vault (`refusal`, the outline guard) and is
 * one of the vault's talks; refused when another outline of that vault has the same slug (both would
 * publish into one folder, so neither is this talk's alone).
 */
export function talkByOutline<T extends { slug: string; outlinePath: string }>(
  vaultRoot: string, outline: unknown, talks: readonly T[], refusal: (outlinePath: string) => string | null,
): { ok: true; talk: T } | { ok: false; error: string } {
  if (typeof outline !== 'string' || !outline) return { ok: false, error: TALK_NOT_FOUND }
  const requested = resolve(vaultRoot, outline)
  const refused = refusal(requested)
  if (refused) return { ok: false, error: refused }
  const talk = talks.find((candidate) => resolve(candidate.outlinePath) === requested)
  if (!talk) return { ok: false, error: TALK_NOT_FOUND }
  if (talks.filter((candidate) => candidate.slug === talk.slug).length !== 1) return { ok: false, error: TALK_NAME_SHARED }
  return { ok: true, talk }
}

/** The folder's real path is the site folder's real path plus its name, and it is a real folder: nothing escapes. */
export function folderContained(siteDir: string, name: string): boolean {
  const folder = siteFolder(siteDir, name)
  if (folder === null) return false
  try {
    const stat = lstatSync(folder)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    const real = realpathSync(folder)
    return dirname(real) === realpathSync(siteDir) && basename(real) === name
  } catch {
    return false
  }
}

/** What an unpublish did, for the reply and the tests. */
export interface TalkUnpublished {
  way: 'removed' | 'nothing'
  /** The talk's folder in the site, when this computer had it. */
  folder: string | null
  /** Once the site is up: whether `handout_url` was taken out of the talk; the writer's reason when not. */
  linkCleared: boolean
  linkError?: string
  /** The talk's folder name and the short id the registry gave it: the entry is dropped once the link is cleared. */
  registryEntry?: { name: string; id: string }
}

export interface TalkUnpublishDeps {
  /**
   * The talk as it stands now (read at the job's turn): its slug and link; null when it is gone; `error`
   * when it is no longer this talk's alone to unpublish (talkByOutline again: another outline of its slug).
   */
  talk(): Promise<{ slug: string; handoutUrl: string | null } | { error: string } | null>
  /** Whether the site folder exists on this computer. */
  siteExists(): boolean
  readRegistry(): Record<string, string>
  writeRegistry(registry: Record<string, string>): void
  /** Every Run with a link and every other talk with a link, in every open vault, read at the job's turn. */
  claims(): SiteClaims
  /** Take `handout_url` out of the talk's front matter through the outline writer. */
  clearLink(): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * The job for `publish({ entry: 'talk-unpublish', ...talkUnpublishJob(deps) })`. `begin` reads the talk at
 * its turn and refuses a missing site; `prepare` binds the folder and removes it; `record`, once the site
 * without it is up, takes the link out of the talk.
 */
export function talkUnpublishJob(deps: TalkUnpublishDeps): Omit<PublishJob<TalkUnpublished>, 'entry'> {
  const nothing: TalkUnpublished = { way: 'nothing', folder: null, linkCleared: false }
  return {
    begin: async (): Promise<PublishBegin<TalkUnpublished>> => {
      const talk = await deps.talk()
      if (!talk) return { fail: { error: TALK_NOT_FOUND } }
      if ('error' in talk) return { fail: { error: talk.error } }
      // Not published (any more): nothing to take down, and Cloudflare is not asked.
      if (!talk.handoutUrl) return { done: nothing }
      if (!deps.siteExists()) return { fail: { error: TALK_UNPUBLISH_SITE_MISSING } }
      return null
    },
    prepare: async ({ dir: siteDir, redirects }: PublishBuild) => {
      const talk = await deps.talk()
      if (!talk) return { ok: false, error: TALK_NOT_FOUND }
      if ('error' in talk) return { ok: false, error: talk.error }
      if (!talk.handoutUrl) return { ok: true, built: nothing }
      const published = publishedFolders(siteDir)
      const registry = deps.readRegistry()
      // Bound BEFORE anything is removed (D2).
      const claims = deps.claims()
      // A talk that could not be read may hold this folder: refused, never decided on part of the evidence.
      if (claims.unreadable > 0) return { ok: false, error: TALK_UNPUBLISH_CLAIMS_UNREAD }
      const bound = talkSiteFolder(talk, published, registry, claims, (name) => siteEntry(siteDir, name))
      if (bound.kind === 'not-a-folder') return { ok: false, error: TALK_UNPUBLISH_NOT_A_FOLDER }
      if (bound.kind !== 'found' && bound.kind !== 'missing') return { ok: false, error: TALK_FOLDER_UNCLEAR }
      const folder = bound.kind === 'found' ? bound.name : null
      if (folder !== null && !folderContained(siteDir, folder)) return { ok: false, error: TALK_UNPUBLISH_FOLDER_CHANGED }
      // ENTRY FIRST: the redirect file as it will be without this talk, checked before anything is taken away.
      // The registry itself keeps the entry until the link is cleared (`record`): a retry still reads the short link.
      const id = registry[bound.name]
      const without = { ...registry }
      delete without[bound.name]
      const redirectsText = redirects(buildRedirects(without, published.filter((name) => name !== folder)))
      if (folder !== null && removeSiteFolder(siteDir, folder) !== 'removed') return { ok: false, error: TALK_UNPUBLISH_FOLDER_CHANGED }
      writeFileSync(join(siteDir, '_redirects'), redirectsText, 'utf8')
      return { ok: true, built: { way: 'removed', folder, linkCleared: false, ...(id !== undefined ? { registryEntry: { name: bound.name, id } } : {}) } }
    },
    record: async (built) => {
      if (built.way !== 'removed') return
      try {
        const cleared = await deps.clearLink()
        built.linkCleared = cleared.ok
        if (!cleared.ok) built.linkError = cleared.error
      } catch (error) {
        built.linkError = error instanceof Error ? error.message : String(error)
      }
      // The site is up without the folder and the link is out of the talk: only now does the short id go,
      // and only when the registry still gives it to this folder. A kept entry writes no redirect (no folder).
      const entry = built.registryEntry
      if (!built.linkCleared || !entry) return
      try {
        const registry = deps.readRegistry()
        if (registry[entry.name] === entry.id) {
          delete registry[entry.name]
          deps.writeRegistry(registry)
        }
      } catch { /* the entry stays: harmless (no folder, no redirect line), and a later publish of the talk reuses its id */ }
    },
  }
}
