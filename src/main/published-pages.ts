// What the Published pages view reads (work-files-and-sessions ticket 22): every Run with a link and every
// talk with `handout_url`, in every open vault, each with the folder of the site it lives in, and this
// computer's copy of the site, as plain data for src/shared/published-pages.ts. Read-only: nothing is
// written. Which folder a page lives in is decided from its own facts (run-unpublish.ts runSiteFolder,
// talk-unpublish.ts talkSiteFolder), the same functions Unpublish binds with, never from the listing.
//
// No Electron import and erasable TypeScript only: scripts/test-published-pages.mjs imports it as it is.
import { existsSync, lstatSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { publishedFolders } from './handout-publishing.ts'
import { readHandoutUrl, siteFolder } from './publishing-logic.ts'
import { runSiteFolder, type RunSiteFolder } from './run-unpublish.ts'
import { listRuns, type RunRecord } from './runs.ts'
import { sessionSource, type SentPhasesOf } from './sessions-list.ts'
import { siteEntry, talkSiteFolder, type SiteClaims, type TalkSiteFolder } from './talk-unpublish.ts'
import { SITE_LIST_ERROR, type PageFolder, type PublishedPagesInput, type PublishedTalkSource, type SiteListing } from '../shared/published-pages.ts'

/** An open vault as the list and the ownership check see it. `unavailable`: its folder did not answer, so it is not read. */
export type PagesVault = { id: string; root: string; unavailable?: true }

/**
 * Every OPEN vault of the registry, an unavailable one included and marked (review round 3, finding 1): its
 * folder could hold a talk or Run claiming a folder of the site, so it counts as unknown evidence, never as
 * absent. What publishedPagesDeps (index.ts) hands the list and the talk-handout unpublish.
 */
export function openVaults(list: Array<{ id: string; root: string; open: boolean }>, isUnavailable: (id: string) => boolean): PagesVault[] {
  return list.filter((v) => v.open).map((v) => (isUnavailable(v.id) ? { id: v.id, root: v.root, unavailable: true as const } : { id: v.id, root: v.root }))
}

export interface PublishedPagesDeps {
  /** Every open vault (openVaults below): one marked unavailable is never read, only counted as unreadable. */
  vaults(): PagesVault[]
  /** A vault's talks. */
  talks(root: string): Array<{ slug: string; title: string; outlinePath: string }>
  /** A talk's outline text (the open editor's buffer when there is one), or null. */
  readOutline(outlinePath: string): string | null
  /** The folder the whole site is kept in. */
  siteDir(): string
  readRegistry(): Record<string, string>
  /** THE sent set of a Run (run-unpublish.ts sentPhases over the work service). */
  sentPhases?: SentPhasesOf
}

export interface PublishedPagesIpcDeps extends PublishedPagesDeps {
  ipcMain: { handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void }
}

/**
 * This computer's copy of the site: whether it is there, and its handout folders with when each home page
 * was written. A copy that is there but cannot be listed says so (`error`), never an empty site.
 */
export function siteListing(siteDir: string): SiteListing {
  let exists = false
  try { exists = existsSync(siteDir) && lstatSync(siteDir).isDirectory() } catch { exists = false }
  if (!exists) return { exists: false, folders: [] }
  let names: string[]
  try { names = publishedFolders(siteDir) } catch { return { exists: true, folders: [], error: SITE_LIST_ERROR } }
  const folders = names.map((name) => {
    const folder = siteFolder(siteDir, name)
    let modifiedAt: string | undefined
    try { if (folder) modifiedAt = statSync(join(folder, 'index.html')).mtime.toISOString() } catch { /* no date */ }
    return modifiedAt ? { name, modifiedAt } : { name }
  })
  return { exists: true, folders }
}

const asPageFolder = (bound: RunSiteFolder): PageFolder =>
  bound.kind === 'found' || bound.kind === 'missing' ? { kind: 'named', name: bound.name } : { kind: 'unclear' }

/** A talk's folder as the list shows it: "here" by what is at its name (talk-unpublish.ts siteEntry), as Unpublish decides. */
const asTalkFolder = (bound: TalkSiteFolder): PageFolder =>
  bound.kind === 'found' ? { kind: 'named', name: bound.name, here: true }
    : bound.kind === 'missing' ? { kind: 'named', name: bound.name, here: false }
      : bound.kind === 'not-a-folder' ? { kind: 'not-a-folder', name: bound.name }
        : { kind: 'unclear' }

type TalkWithLink = Omit<PublishedTalkSource, 'folder'>

/**
 * Every Run with a link and every talk with `handout_url`, in every open vault, and how many talks could not
 * be read (an outline that reads as null or throws; a vault whose talks or Runs cannot be listed, or that is
 * unavailable and so not read at all: one each): never silently left out, since each could hold a folder of
 * the site (review round 2, finding 1; round 3).
 */
function linkedPages(deps: Pick<PublishedPagesDeps, 'vaults' | 'talks' | 'readOutline'>, except?: { vaultId: string; outlinePath: string }): { runs: Array<{ vaultId: string; root: string; run: RunRecord }>; talks: TalkWithLink[]; unreadable: number } {
  const runs: Array<{ vaultId: string; root: string; run: RunRecord }> = []
  const talks: TalkWithLink[] = []
  let unreadable = 0
  for (const vault of deps.vaults()) {
    // Unavailable: its disk is not touched (invariant 5), and what it holds is unknown.
    if (vault.unavailable) { unreadable += 1; continue }
    try {
      for (const run of listRuns(vault.root)) if (run.handoutUrl) runs.push({ vaultId: vault.id, root: vault.root, run })
    } catch { unreadable += 1 /* counted, and the list still shows the rest */ }
    let found: Array<{ slug: string; title: string; outlinePath: string }>
    try { found = deps.talks(vault.root) } catch { unreadable += 1; continue }
    for (const talk of found) {
      // The talk being unpublished is read by its own job (through the writer), not here.
      if (except && vault.id === except.vaultId && talk.outlinePath === except.outlinePath) continue
      let text: string | null
      try { text = deps.readOutline(talk.outlinePath) } catch { text = null }
      if (text === null) { unreadable += 1; continue }
      const url = readHandoutUrl(text)
      if (url && url.trim()) talks.push({ vaultId: vault.id, outline: relative(vault.root, talk.outlinePath), slug: talk.slug, title: talk.title, outlinePath: talk.outlinePath, handoutUrl: url.trim() })
    }
  }
  return { runs, talks, unreadable }
}

/**
 * What else holds a folder of the site, for the talk-handout unpublish (talk-unpublish.ts talkSiteFolder):
 * every Run with a link and every talk with a link other than the one outline `except` names, in every
 * open vault (another outline of the same name, in this vault or another, is a claim), and how many talks
 * could not be read (the unpublish is refused while any could not).
 */
export function siteClaims(deps: Pick<PublishedPagesDeps, 'vaults' | 'talks' | 'readOutline'>, except: { vaultId: string; outlinePath: string }): SiteClaims {
  const { runs, talks, unreadable } = linkedPages(deps, except)
  return {
    runs: runs.map(({ run }) => ({ handoutUrl: run.handoutUrl, handoutFolder: run.handoutFolder })),
    talks: talks.map((talk) => ({ slug: talk.slug, handoutUrl: talk.handoutUrl })),
    unreadable,
  }
}

export function collectPublishedPages(deps: PublishedPagesDeps): PublishedPagesInput {
  const siteDir = deps.siteDir()
  const site = siteListing(siteDir)
  const published = site.folders.map((entry) => entry.name)
  let registry: Record<string, string> = {}
  try { registry = deps.readRegistry() } catch { registry = {} }
  const { runs, talks, unreadable } = linkedPages(deps)

  const runClaims: SiteClaims['runs'] = runs.map(({ run }) => ({ handoutUrl: run.handoutUrl, handoutFolder: run.handoutFolder }))
  return {
    site,
    // Talks that could not be read: the list says so, and no talk handout is offered for Unpublish meanwhile.
    ...(unreadable > 0 ? { unreadable } : {}),
    runs: runs.map(({ vaultId, root, run }) => {
      let sent: ReturnType<SentPhasesOf> = []
      try { sent = deps.sentPhases?.(run, root) ?? [] } catch { /* the list still shows the Run */ }
      return { ...sessionSource(vaultId, run, sent), folder: asPageFolder(runSiteFolder(run, published, registry)) }
    }),
    talks: talks.map((talk) => {
      const others = talks.filter((other) => other !== talk).map((other) => ({ slug: other.slug, handoutUrl: other.handoutUrl }))
      return { ...talk, folder: asTalkFolder(talkSiteFolder(talk, published, registry, { runs: runClaims, talks: others, unreadable }, (name) => siteEntry(siteDir, name))) }
    }),
  }
}

export function registerPublishedPagesIpc(deps: PublishedPagesIpcDeps): void {
  deps.ipcMain.handle('published:list', () => collectPublishedPages(deps))
}
