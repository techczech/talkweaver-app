// Unpublish a Run (work-files ticket 17; ADR-0040 decision 9): the job the `run-unpublish` entry of the
// handout publishing sequence runs (handout-publishing.ts; `run:unpublish-handout` in index.ts).
//
// ONE "SENT" SET (D1). `sentPhases` = the phases with `publishedAt` on the Run's current attachments
// ∪ the phases the work service holds an object for (`phasesSent`, its record of what went out, whatever
// the Run says now). That one set decides everything below: which phases are withdrawn, REPLACE or
// REMOVE, and the missing-site and missing-folder refusals. Nothing reads the attachment stamps alone.
//
// TWO WAYS, chosen when the job's turn begins from the Run as it stands then:
//   - REPLACE, when the sent set is not empty: every page in the Run's own folder of the site (the
//     handout, its home page, `pre-work/`, `post-work/`, the download page, the venue screen, the 404
//     page) is overwritten with the one "This page is not available" page, and everything else in that
//     folder (pictures, scripts) is taken away; the page of each sent phase is there afterwards whatever
//     was there before. The addresses stay, so the links participants hold show that page, and Publish
//     again writes the Run's pages back at the SAME addresses: the Run keeps its link, its folder, its
//     short id and its line in the redirect file. Once the site is up the Run itself is stamped
//     `unpublishedAt` (runs.ts `stampRunUnpublished`) beside the stamp on each attached sent phase, so
//     a Run whose sent set comes only from the service's record still reads "Unpublished" on the Run
//     checklist (run-checklist.ts reads both; a publish takes the Run's stamp away).
//   - REMOVE, when the sent set is empty (a handout only, as before 0.40): the Run's folder is taken
//     out of the site and its short id out of the redirect file, and the Run forgets its link, exactly
//     as Unpublish Run handout always did.
//
// WITHDRAWN FIRST, both ways. Before anything is written, every phase of the sent set is withdrawn on
// the Worker (run-prework.ts `withdraw`). Its public routes answer "not available" and its answers stay,
// still pulled onto the Run. A withdraw that fails stops the unpublish there and nothing is written or
// uploaded: the Run is still published and Unpublish can be pressed again. Its sentence is the work
// service's fixed one (NO RAW TEXT: what the Worker said is only Details, cleaned there). The service
// notes each withdraw before it asks (`withdrawAskedAt`), so one whose answer was lost is still undone by
// Publish again.
//
// THE RUN'S FOLDER IS DECIDED FROM THE RUN'S OWN FACTS, NEVER FROM WHAT EXISTS ON THIS COMPUTER (D2,
// `runSiteFolder`). The link's LAST segment, decoded, is read the ways a publish writes it (as a folder
// name, or as a short id the redirect registry gives a folder). A path is never made from the link.
//   - `handoutFolder` recorded (every publish since the fix round writes it with the link): that is the
//     folder, and only when the segment names it either way; otherwise RUN_FOLDER_UNCLEAR.
//   - Not recorded (a Run published before), the segment a REGISTERED short id: the folder the registry
//     gives it, and only that; a folder that happens to share the id's name is never a candidate. One id
//     given to two folders: RUN_FOLDER_UNCLEAR.
//   - Not recorded, the segment not a registered short id: the segment itself is the folder name.
// Which folder it is never depends on which folders exist here. Only then is the site's copy looked at:
// `found` when it holds that folder, `missing` when it does not. What cannot be bound refuses, before anything is withdrawn,
// written or uploaded:
//   - RUN_FOLDER_UNCLEAR, both ways (and Publish again refuses the same way);
//   - a sent phase with no usable owner key on this computer (workKeyMissing): it cannot be withdrawn,
//     and a phase whose state is unknown is never reported as withdrawn;
//   - the sent set is not empty and the site's copy on this computer is missing (UNPUBLISH_SITE_MISSING)
//     or does not hold the Run's folder (UNPUBLISH_FOLDER_MISSING): no page could be replaced, so the
//     deployed pages would stay readable.
//   NEVER "PUBLISH AGAIN" AS THE WAY OUT (D3). A deploy uploads the whole of the site's copy
//   (handout-publishing.ts `uploadSite`), so publishing from an incomplete copy takes other Runs' pages
//   down. Both refusals say the Run cannot be unpublished from this computer and to unpublish it from
//   the computer that published it. (REMOVE with the folder missing goes ahead: there is nothing of the
//   Run's to replace, and the upload of the site without it takes the pages down.)
//
// PUBLISH AGAIN WRITES INTO THE RECORDED FOLDER (D4, `runPublishFolder`, used by `run:publish-handout`).
// A Run whose folder is found is written there. A Run whose recorded `handoutFolder` is missing on this
// computer is written into that SAME name, not a fresh one, so its link and short id still lead to it,
// provided the name is a folder name a publish makes (RUN_FOLDER_NAME, and `writableSiteFolder` takes it)
// and no other Run has recorded it; otherwise RUN_FOLDER_UNCLEAR. A Run from before the folder was
// recorded whose folder is missing gets a new folder, as a first publish does.
//
// What holds, both ways:
//   - Inside the Run's folder nothing is followed: a link (to a file or a folder, inside the site or not)
//     is unlinked, never written through; pages are written through a temporary file and a rename.
//   - The site's other pages, and its redirect file in REPLACE, are not touched.
//   - Nothing about the Run is written before the upload has completed (`record`), so a failed or
//     superseded unpublish leaves the Run as it was.
//
// No Electron import and erasable TypeScript only: scripts/test-handout-publishing.mjs runs this job in the
// real publishing sequence against the fake Cloudflare API.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishedFolders, removeSiteFolder, writableSiteFolder, type PublishBegin, type PublishBuild, type PublishJob } from './handout-publishing.ts'
import { buildRedirects, siteFolder } from './publishing-logic.ts'
import type { RunWorkWithdraw } from './run-prework.ts'
import { clearRunHandoutUrl, stampRunUnpublished, stampRunWork, type RunRecord } from './runs.ts'
import { LEGACY_SECTION_FILE_ID, WORK_PAGE_FOLDER, workKeyMissing, workOwnerUnknown, type Phase } from '../shared/run-work.ts'

const PHASES: readonly Phase[] = ['pre', 'post']

export const RUN_FOLDER_UNCLEAR = 'Stopped: this Run\'s link does not name one folder of the site that is this Run\'s own (it names more than one, or not the one this Run was published to), so nothing was withdrawn, written or removed.'
export const UNPUBLISH_SITE_MISSING = 'Unpublishing stopped: the copy of the site on this computer is missing, so this Run cannot be unpublished from here. Unpublish it from the computer that published it. Nothing was withdrawn, changed or uploaded.'
export const UNPUBLISH_FOLDER_MISSING = 'Unpublishing stopped: the copy of the site on this computer does not have this Run\'s pages, so this Run cannot be unpublished from here. Unpublish it from the computer that published it. Nothing was withdrawn, changed or uploaded.'

export const UNPUBLISH_FOLDER_CHANGED = 'Unpublishing stopped: this Run\'s folder changed on this computer while it was being unpublished, so its pages were not replaced. Its pre-work and post-work stay withdrawn. Press Unpublish again.'

/** The phases of the Run whose work page went out with a publish (a work file, not the talk's own section). */
export function sentWorkPhases(run: Pick<RunRecord, 'work'> | null | undefined): Phase[] {
  return PHASES.filter((phase) => {
    const work = run?.work?.[phase]
    return !!work && work.fileId !== LEGACY_SECTION_FILE_ID && !!work.publishedAt
  })
}

/**
 * The Run's folder in the site, decided from the Run's own facts (D2):
 *   found   — the folder, one of `published` (the site folder's own real folders);
 *   missing — the Run's folder by name, which `published` does not hold; `recorded` when the Run wrote it down;
 *   unclear — the link does not name the folder the Run recorded, or (no record) its short id is given to two folders;
 *   none    — the Run has no link, or a link that names nothing.
 * The link's LAST path segment, decoded (publishing-logic.ts publishUrl writes a folder name or a short
 * id). With a record: the recorded folder, if the segment names it either way. Without: a registered short
 * id means the registry's folder only; anything else is the folder name itself. Which folder never
 * depends on `published`: that is looked at only once the one folder is decided. A path is never made
 * from the link.
 */
export type RunSiteFolder =
  | { kind: 'found'; name: string }
  | { kind: 'missing'; name: string; recorded: boolean }
  | { kind: 'unclear' }
  | { kind: 'none' }

export function runSiteFolder(run: Pick<RunRecord, 'handoutUrl' | 'handoutFolder'>, published: readonly string[], registry: Readonly<Record<string, string>>): RunSiteFolder {
  const url = run.handoutUrl
  if (typeof url !== 'string' || !url) return { kind: 'none' }
  let last: string | undefined
  try { last = new URL(url).pathname.split('/').filter(Boolean).at(-1) } catch { return { kind: 'none' } }
  if (last === undefined) return { kind: 'none' }
  let segment: string
  try { segment = decodeURIComponent(last) } catch { return { kind: 'none' } }
  if (!segment) return { kind: 'none' }
  // The folders the redirect registry gives this segment as a short id, whether or not this computer has them.
  const mapped = [...new Set(Object.entries(registry).filter(([, id]) => id === segment).map(([key]) => key))]
  const recorded = typeof run.handoutFolder === 'string' && run.handoutFolder ? run.handoutFolder : null
  let name: string
  if (recorded !== null) {
    // The recorded folder, when the link names it either way.
    if (recorded !== segment && !mapped.includes(recorded)) return { kind: 'unclear' }
    name = recorded
  } else if (mapped.length) {
    // A Run from before the folder was recorded, linked by a registered short id: the registry's folder
    // and only that (a folder that happens to share the id's name is never this Run's). One id given to
    // two folders names neither.
    if (mapped.length !== 1) return { kind: 'unclear' }
    name = mapped[0]
  } else {
    // Not a registered short id: the segment is the folder name.
    name = segment
  }
  return published.includes(name) ? { kind: 'found', name } : { kind: 'missing', name, recorded: recorded !== null }
}

/** A folder name a Run publish makes (runs.ts runHandoutSlug): lower-case letters and digits in hyphenated parts. */
export const RUN_FOLDER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Where Publish (again) writes the Run's pages (D4): the Run's own folder, a new one, or nowhere. */
export type RunPublishFolder = { kind: 'same'; name: string } | { kind: 'new' } | { kind: 'unclear' }

/**
 * Publish (again): a found folder is written into; a RECORDED folder missing on this computer is written
 * into by that same name, when it is a name a Run publish makes, `writableSiteFolder` takes it and no
 * other Run (`recordedElsewhere`: every other Run's recorded folder) holds it; otherwise unclear. A
 * missing folder that was never recorded, or no link at all, gets a new folder.
 */
export function runPublishFolder(siteDir: string, bound: RunSiteFolder, recordedElsewhere: Iterable<string>): RunPublishFolder {
  if (bound.kind === 'unclear') return { kind: 'unclear' }
  if (bound.kind === 'found') return { kind: 'same', name: bound.name }
  if (bound.kind === 'missing' && bound.recorded) {
    const taken = new Set(recordedElsewhere)
    if (!RUN_FOLDER_NAME.test(bound.name) || writableSiteFolder(siteDir, bound.name) === null || taken.has(bound.name)) return { kind: 'unclear' }
    return { kind: 'same', name: bound.name }
  }
  return { kind: 'new' }
}

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function writeAtomically(path: string, text: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, path)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
    throw error
  }
}

const isPage = (name: string): boolean => /\.html?$/i.test(name)

export type ReplacedFolder = { kind: 'replaced'; pages: string[] } | { kind: 'unlinked' } | { kind: 'absent' }

/**
 * REPLACE: every page under the Run's folder `name` of the site becomes `html`, and everything else there
 * is taken away. The folder is chosen by membership (the site folder's own listing, and `siteFolder` must
 * take the name); a link at that name is unlinked and nothing is written. Inside it, a link is unlinked,
 * never followed. The home page and the pages of `phases` are there afterwards whatever was there before.
 * Answers the pages written, relative to the Run's folder, with forward slashes.
 */
export function replaceRunPages(siteDir: string, name: string, html: string, phases: readonly Phase[] = []): ReplacedFolder {
  if (!existsSync(siteDir) || !readdirSync(siteDir).includes(name)) return { kind: 'absent' }
  const folder = siteFolder(siteDir, name)
  if (folder === null) return { kind: 'absent' }
  const stat = lstatSync(folder)
  if (stat.isSymbolicLink()) { unlinkSync(folder); return { kind: 'unlinked' } }
  if (!stat.isDirectory()) return { kind: 'absent' }
  const pages: string[] = []
  // Depth first: what is not a page goes; a folder left empty goes.
  const sweep = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) { unlinkSync(path); continue }
      if (entry.isDirectory()) {
        sweep(path, relative)
        if (readdirSync(path).length === 0) rmdirSync(path)
        continue
      }
      if (entry.isFile() && isPage(entry.name)) { pages.push(relative); continue }
      rmSync(path, { force: true })
    }
  }
  sweep(folder, '')
  for (const must of ['index.html', ...phases.map((phase) => `${WORK_PAGE_FOLDER[phase]}/index.html`)]) {
    if (pages.includes(must)) continue
    const parent = must.includes('/') ? join(folder, must.split('/')[0]) : folder
    if (lexists(parent) && !lstatSync(parent).isDirectory()) rmSync(parent, { force: true })
    if (!lexists(parent)) mkdirSync(parent)
    pages.push(must)
  }
  for (const page of pages) writeAtomically(join(folder, ...page.split('/')), html)
  return { kind: 'replaced', pages: pages.sort() }
}

/** The work service as Unpublish uses it (run-prework.ts). */
export interface RunUnpublishService {
  /** `vaultRoot`: the Run's own vault (issue 256: the same talk and Run id in another vault is another object). */
  withdraw(talkSlug: string, runId: string, phase: Phase, withdrawn?: boolean, vaultRoot?: string | null): Promise<RunWorkWithdraw>
  /** The phases the service holds an object for, for this Run of this vault: sent at some time, whatever the Run says now. */
  phasesSent(talkSlug: string, runId: string, vaultRoot?: string | null): Phase[]
  /** Whether this computer holds a usable owner key for the phase ('none': no row, or no key for it). */
  ownerRecord(talkSlug: string, runId: string, phase: Phase, vaultRoot?: string | null): 'usable' | 'locked' | 'none'
  /** The phase has no object of this vault's, only one from before 0.41 that records no vault (run-prework.ts). */
  ownerUnknown?(talkSlug: string, runId: string, phase: Phase, vaultRoot?: string | null): boolean
}

/**
 * THE sent set (D1): every phase this Run ever sent, stamped published on its current attachment or with
 * an object in the work service. Withdrawal, REPLACE or REMOVE and the missing-site refusals all read it.
 */
export function sentPhases(service: Pick<RunUnpublishService, 'phasesSent'>, run: Pick<RunRecord, 'talkSlug' | 'id' | 'work'>, vaultRoot?: string | null): Phase[] {
  const sent = new Set([...sentWorkPhases(run), ...service.phasesSent(run.talkSlug, run.id, vaultRoot)])
  return PHASES.filter((phase) => sent.has(phase))
}

const DETAILS_CHARS = 600

/**
 * Withdraw each phase on the Worker, one after the other; the first refusal stops it. The sentence is the
 * service's fixed one; what the Worker said is only Details (cleaned by the service, cut again here).
 * UNKNOWN IS NOT WITHDRAWN: before any phase is asked, every phase must have a usable owner record on
 * this computer. A sent phase with none (its key gone from secure storage, or no row here at all: a stamp
 * from another computer) refuses with workKeyMissing, and nothing is withdrawn.
 * NO VAULT'S OBJECT IS LEFT LIVE QUIETLY: a phase of the Run that has only an object from before 0.41 recording no
 * vault refuses with workOwnerUnknown, sent or not (its attachment may have been removed or replaced, so the Run's
 * stamps no longer name it), and nothing is withdrawn. With no phases at all this is the whole check (REMOVE).
 */
export async function withdrawRunWork(
  service: Pick<RunUnpublishService, 'withdraw' | 'ownerRecord' | 'ownerUnknown'>, talkSlug: string, runId: string, phases: readonly Phase[], vaultRoot?: string | null,
): Promise<{ ok: true } | { ok: false; error: string; details?: string }> {
  for (const phase of phases) {
    if (service.ownerRecord(talkSlug, runId, phase, vaultRoot) !== 'none') continue
    // An object from before 0.41 that records no vault is no vault's to withdraw (issue 256): said as such.
    return { ok: false, error: service.ownerUnknown?.(talkSlug, runId, phase, vaultRoot) ? workOwnerUnknown(phase, true) : workKeyMissing(phase) }
  }
  // The registry, not the attachment stamp: every phase, whatever the sent set says.
  for (const phase of PHASES) {
    if (service.ownerUnknown?.(talkSlug, runId, phase, vaultRoot)) return { ok: false, error: workOwnerUnknown(phase, true) }
  }
  for (const phase of phases) {
    const result = await service.withdraw(talkSlug, runId, phase, true, vaultRoot)
    if (!result.ok) {
      // eslint-disable-next-line no-control-regex
      const details = typeof result.details === 'string' ? result.details.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(-DETAILS_CHARS) : ''
      return { ok: false, error: result.error, ...(details ? { details } : {}) }
    }
  }
  return { ok: true }
}

/** What an unpublish did, for the reply and the tests. */
export interface RunUnpublished {
  way: 'replaced' | 'removed' | 'nothing'
  /** The Run's folder in the site, when one was found. */
  folder: string | null
  /** REPLACE: the pages now "not available", relative to the Run's folder. */
  pages: string[]
  /** The phases withdrawn on the Worker. */
  phases: Phase[]
}

export interface RunUnpublishDeps {
  /** The Run as it stands now (read again at each step: an earlier publish may have changed it). */
  run(): RunRecord
  /** Whether the site folder exists on this computer. */
  siteExists(): boolean
  readRegistry(): Record<string, string>
  writeRegistry(registry: Record<string, string>): void
  /** The "This page is not available" page (work-page.ts buildNotAvailablePage). */
  notAvailablePage(): Promise<string>
  /** The run work service (run-prework.ts): `withdraw` and `phasesSent`. */
  service: RunUnpublishService
  /** The vault the Run is in: its objects are that vault's (issue 256). None: the service's current vault. */
  vaultRoot?: string
  /** Write the Run back (the atomic Run writer). */
  persist(run: RunRecord): void
  now?(): Date
}

/**
 * The job for `publish({ entry: 'run-unpublish', ...runUnpublishJob(deps) })`. `begin` reads the Run at
 * its turn; `prepare` binds the Run's folder, withdraws and writes; `record`, once the site without the
 * Run's pages is up, writes the Run.
 */
export function runUnpublishJob(deps: RunUnpublishDeps): Omit<PublishJob<RunUnpublished>, 'entry'> {
  const stamp = (): string => (deps.now?.() ?? new Date()).toISOString()
  /**
   * What the Run keeps, once its pages are down (or when there was nothing to take down). REPLACE keeps
   * the link and folder and stamps the Run itself as well as each attached sent phase (D1).
   */
  const forget = (replaced: boolean): void => {
    const at = stamp()
    const stamped = stampRunWork(deps.run(), PHASES, 'unpublishedAt', at)
    deps.persist(replaced ? stampRunUnpublished(stamped, at) : clearRunHandoutUrl(stamped))
  }
  const nothing: RunUnpublished = { way: 'nothing', folder: null, pages: [], phases: [] }
  const withdraw = async (run: RunRecord, phases: Phase[]): Promise<{ ok: true; phases: Phase[] } | { ok: false; error: string; details?: string }> => {
    const withdrawn = await withdrawRunWork(deps.service, run.talkSlug, run.id, phases, deps.vaultRoot)
    return withdrawn.ok ? { ok: true, phases } : withdrawn
  }
  return {
    // Nothing published from here (no link, or a handout only and no site folder): the Run only forgets,
    // and Cloudflare is not asked; whatever it sent is still withdrawn. A Run with a link and a sent set
    // whose site's copy is missing is refused (D1, D3): no page could be replaced, and it is not rebuilt here.
    begin: async (): Promise<PublishBegin<RunUnpublished>> => {
      const run = deps.run()
      if (run.handoutUrl && deps.siteExists()) return null
      const sent = sentPhases(deps.service, run, deps.vaultRoot)
      if (run.handoutUrl && sent.length) return { fail: { error: UNPUBLISH_SITE_MISSING } }
      const withdrawn = await withdraw(run, sent)
      if (!withdrawn.ok) return { fail: { error: withdrawn.error, ...(withdrawn.details ? { details: withdrawn.details } : {}) } }
      forget(false)
      return { done: { ...nothing, phases: withdrawn.phases } }
    },
    prepare: async ({ dir: siteDir, redirects }: PublishBuild) => {
      const run = deps.run()
      if (!run.handoutUrl) return { ok: true, built: nothing }
      const published = publishedFolders(siteDir)
      const registry = deps.readRegistry()
      // Bound BEFORE anything is withdrawn or written (D2).
      const bound = runSiteFolder(run, published, registry)
      if (bound.kind === 'unclear') return { ok: false, error: RUN_FOLDER_UNCLEAR }
      const folder = bound.kind === 'found' ? bound.name : null
      // THE sent set (D1), read once: it chooses the way, the refusal and what is withdrawn.
      const sent = sentPhases(deps.service, run, deps.vaultRoot)
      if (sent.length) {
        // REPLACE. The Run's folder must be there (D3: no rebuild from here); the page is built before
        // anything is withdrawn or written.
        if (folder === null) return { ok: false, error: UNPUBLISH_FOLDER_MISSING }
        const html = await deps.notAvailablePage()
        const withdrawn = await withdraw(run, sent)
        if (!withdrawn.ok) return { ok: false, error: withdrawn.error, ...(withdrawn.details ? { details: withdrawn.details } : {}) }
        const replaced = replaceRunPages(siteDir, folder, html, sent)
        if (replaced.kind !== 'replaced') return { ok: false, error: UNPUBLISH_FOLDER_CHANGED }
        return { ok: true, built: { way: 'replaced', folder, pages: replaced.pages, phases: withdrawn.phases } }
      }
      // REMOVE, as Unpublish Run handout always did: nothing was sent, so nothing is withdrawn; an object from
      // before 0.41 that records no vault still refuses (withdrawRunWork with no phases). ENTRY FIRST: the
      // redirect file as it will be without this Run, checked before anything is taken away.
      const unowned = await withdraw(run, [])
      if (!unowned.ok) return { ok: false, error: unowned.error }
      if (folder) delete registry[folder]
      const redirectsText = redirects(buildRedirects(registry, published.filter((name) => name !== folder)))
      if (folder) removeSiteFolder(siteDir, folder)
      if (folder) deps.writeRegistry(registry)
      writeFileSync(join(siteDir, '_redirects'), redirectsText, 'utf8')
      return { ok: true, built: { way: 'removed', folder, pages: [], phases: [] } }
    },
    record: (built) => { forget(built.way === 'replaced') },
  }
}
