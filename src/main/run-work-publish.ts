// Publish for this run: a Run's pre-work and post-work pages (work-files ticket 16; ADR-0040 decision 4).
//
// The Run's handout publish (`run:publish-handout`, through the handout publishing queue) calls this
// module in three steps, so that nothing is pinned, pushed or written before the publish has its turn and
// its leave to publish:
//   1. planRunWork (the job's `begin`): which phases go out, and the refusals that need no network: a
//      window that closes before it opens, a work file that is missing or reads with a blocking finding
//      (refused with the finding, in words). Reads only; writes nothing.
//   2. sendRunWork (the job's `prepare`, before the pages): for each phase, pin the work file (ticket 14),
//      compile the pinned copy (ticket 05) and push its public form and window to the phase's object on
//      the Worker (ticket 13). The Worker's address must be one others can reach. A phase withdrawn by
//      Unpublish (ticket 17) is served again here.
//   3. writeRunWorkPages (the job's `prepare`, after the handout's pages): the participant page of each
//      phase (ticket 15) written to `<run folder>/pre-work/index.html` and `<run folder>/post-work/index.html`
//      inside the Run's own folder of the site; a phase the Run no longer has loses its old page.
// And, outside publishing, buildRunWorkPreview: the participant page built on this computer and written
// into the Run's own folder in the vault, asking nothing of the Worker (Preview page).
//
// What holds: the pages carry the PUBLIC form only (publicPreworkForm via compileWorkFile; the page builder
// refuses a right answer); the Worker address in a page is never on this computer (liveAddressForPages);
// a page is written only inside the Run's site folder the caller has checked (writableSiteFolder), through
// a temporary file and a rename, and a link at a page's folder name is unlinked, never followed.
import { lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileWorkFile, type CompiledWorkFile, type CompiledWorkFinding } from './work-file-compile.ts'
import { buildParticipantWorkPage } from './work-page.ts'
import { decodeUtf8, pinRunWork, readPinnedWork, readWorkFileBytes, runFolder, workFilePath, type PinError } from './run-work-pin.ts'
import { workPushWindowMs, type RunPreworkService, type RunPreworkState } from './run-prework.ts'
import { liveAddressForPages } from './handout-publishing.ts'
import type { RunRecord } from './runs.ts'
import { readWorkFile, type WorkFileFinding } from '../shared/work-file.ts'
import { findingText } from '../shared/run-page.ts'
import { dayLabel } from '../shared/run-checklist.ts'
import { zonedLocalToMs } from '../shared/run-prework.ts'
import { LEGACY_SECTION_FILE_ID, SESSION_END, WORK_PAGE_FOLDER, type Phase, type PinnedRevision, type RunWork } from '../shared/run-work.ts'

export const WORK_PAGE_LOCAL_REFUSED = 'Publishing stopped: the pre-work and post-work pages would use a live service on this computer, which nobody else can reach. Set up going live in Settings → Cloudflare and publish again. Nothing was uploaded.'
export const WORK_LEGACY_NOT_PUBLISHED = 'The pre-work written in the talk itself was not published. Move it to a work file to publish it with this run.'
export const WORK_PREVIEW_NONE = 'This run has no pre-work or post-work file to preview.'
/** The object id and address a preview page names: it never asks them anything. */
export const WORK_PREVIEW_ID = 'preview'
export const WORK_PREVIEW_WORKER = 'https://preview.invalid'

const PHASES: readonly Phase[] = ['pre', 'post']
const name = (phase: Phase): string => (phase === 'post' ? 'post-work' : 'pre-work')
const Name = (phase: Phase): string => (phase === 'post' ? 'Post-work' : 'Pre-work')

/** A pin or read failure, in words for the person publishing. */
export function pinErrorText(code: string, phase: Phase, fileId: string): string {
  const file = `The ${name(phase)} file “${fileId}”`
  switch (code as PinError) {
    case 'work-file-missing': return `${file} was not found in the Work files folder.`
    case 'work-file-path-unsafe': return `${file} is not a plain file inside the vault, so it was not read.`
    case 'work-file-not-utf8': return `${file} is not plain text (UTF-8).`
    case 'work-file-not-ready': return `${file} is not ready.`
    case 'work-file-id-mismatch': return `${file} names a different id inside it.`
    case 'work-file-revision-missing': return `${file} has no revision number.`
    case 'work-pin-copy-exists': return `A different copy of the ${name(phase)} file is already in this run's folder. Move it away and publish again.`
    case 'work-pin-copy-changed': return `The copy of the ${name(phase)} sent with this run has changed on disk since it was sent.`
    case 'work-pin-copy-missing': return `The copy of the ${name(phase)} sent with this run is missing from its folder.`
    case 'work-pin-copy-unsafe': return `The copy of the ${name(phase)} sent with this run is not where it should be.`
    case 'run-folder-unsafe': return 'This run\'s folder is a link or is outside the vault, so nothing was written to it.'
    case 'work-pin-file-mismatch': return `This run's ${name(phase)} was sent with another file; plan it again to change the file.`
    case 'work-not-attached': return `This run has no ${name(phase)} file.`
    default: return `The ${name(phase)} for this run could not be prepared.`
  }
}

function blockingText(phase: Phase, title: string, findings: ReadonlyArray<WorkFileFinding | CompiledWorkFinding>): string | null {
  const blocking = findings.find((finding) => finding.severity === 'blocking')
  if (!blocking) return null
  // findingText words the reader's findings; the two blocking findings of the compile are worded here.
  const step = blocking.stepId ? `Step “${blocking.stepId}”` : 'The file'
  const words = blocking.code === 'work-file-media-outside' ? `${step} uses a picture or video from outside the Work files folder`
    : blocking.code === 'work-file-step-unmatched' ? `${step} could not be drawn`
    : findingText(blocking as WorkFileFinding)
  return `The ${name(phase)} file “${title}” is not ready: ${words}.`
}

export type RunWorkPlan = { ok: true; phases: Phase[]; warning?: string } | { ok: false; error: string }

/**
 * What a Run sends with its handout, read before anything is written: the phases with a work file, or
 * the refusal. A phase already pinned is ready (its copy was ready when it was pinned; the copy itself is
 * checked when it is read). Pre-work written in the talk (a 0.39 Run) is not sent, with a warning.
 */
export function planRunWork(vaultRoot: string, run: Pick<RunRecord, 'work'>, status?: (phase: Phase) => Pick<RunPreworkState, 'opensAt' | 'closesAt'> | null): RunWorkPlan {
  const phases: Phase[] = []
  let warning: string | undefined
  for (const phase of PHASES) {
    const work = run.work?.[phase]
    if (!work) continue
    if (work.fileId === LEGACY_SECTION_FILE_ID) { warning = WORK_LEGACY_NOT_PUBLISHED; continue }
    if (!workPushWindowMs(work, status?.(phase) ?? null)) return { ok: false, error: `${Name(phase)} closes before it opens; fix the dates in the plan.` }
    if (!work.pinned) {
      let text: string | null
      try { text = decodeUtf8(readWorkFileBytes(vaultRoot, work.fileId)) } catch (error) {
        return { ok: false, error: pinErrorText(error instanceof Error ? error.message : '', phase, work.fileId) }
      }
      if (text === null) return { ok: false, error: pinErrorText('work-file-not-utf8', phase, work.fileId) }
      const reading = readWorkFile(text)
      const refused = blockingText(phase, reading.definition.title || work.fileId, reading.findings)
      if (refused) return { ok: false, error: refused }
    }
    phases.push(phase)
  }
  return { ok: true, phases, ...(warning ? { warning } : {}) }
}

export interface SentWork {
  phase: Phase
  pinned: PinnedRevision
  compiled: CompiledWorkFile
  preworkId: string
  /** The Worker's address as the page carries it: never on this computer. */
  workerBaseUrl: string
  /** False when the Worker no longer has the object (purged): its page says it is not available. */
  open: boolean
}

export interface SendRunWorkInput {
  vaultRoot: string
  talkSlug: string
  runId: string
  phases: Phase[]
  compilerDir: string
  service: Pick<RunPreworkService, 'publish' | 'status' | 'withdraw'>
  now?: () => Date
}

/** Compile a pinned copy, as its page is built: media resolve beside the work file, in the Work files folder. */
async function compilePinned(vaultRoot: string, compilerDir: string, fileId: string, text: string): Promise<CompiledWorkFile> {
  const path = workFilePath(vaultRoot, fileId) ?? join(vaultRoot, 'Work files', 'work.md')
  return compileWorkFile({ compilerDir, path, text })
}

/**
 * Pin, compile and push each phase. A refusal is `{ ok: false, error }` in words; a Worker that cannot be
 * reached throws with the service's own sentence (the publish stops, as any build failure does).
 */
export async function sendRunWork(input: SendRunWorkInput): Promise<{ ok: true; sent: SentWork[]; warnings: string[] } | { ok: false; error: string }> {
  const sent: SentWork[] = []
  const warnings: string[] = []
  for (const phase of input.phases) {
    let pinned
    try {
      pinned = pinRunWork(input.vaultRoot, input.talkSlug, input.runId, phase, input.now)
    } catch (error) {
      const fileId = pinnedFileId(input.vaultRoot, input.talkSlug, input.runId, phase)
      return { ok: false, error: pinErrorText(error instanceof Error ? error.message : '', phase, fileId) }
    }
    const work = pinned.run.work?.[phase] as RunWork
    const compiled = await compilePinned(input.vaultRoot, input.compilerDir, pinned.pinned.fileId, pinned.text)
    const refused = blockingText(phase, pinned.pinned.title, compiled.findings)
    if (refused) return { ok: false, error: refused }
    if (!compiled.form) return { ok: false, error: `The ${name(phase)} file “${pinned.pinned.title}” is not ready: it has no step participants can open.` }
    const window = workPushWindowMs(work, input.service.status(input.talkSlug, input.runId, phase, input.vaultRoot))
    if (!window) return { ok: false, error: `${Name(phase)} closes before it opens; fix the dates in the plan.` }
    // The vault the Run is published from is recorded on the object's row (ticket 19 review round 2): post-work
    // opens on its own only for the Run in that vault.
    const published = await input.service.publish(input.talkSlug, input.runId, compiled.form, window, phase, input.vaultRoot)
    if (published.warning) warnings.push(published.warning)
    if (published.open) {
      const served = await serveWorkAgain(input.service, input.talkSlug, input.runId, phase, work, input.vaultRoot)
      if (!served.ok) return served
    }
    const address = liveAddressForPages(published.workerBaseUrl)
    if (!address) return { ok: false, error: WORK_PAGE_LOCAL_REFUSED }
    sent.push({ phase, pinned: pinned.pinned, compiled, preworkId: published.preworkId, workerBaseUrl: address, open: published.open })
  }
  return { ok: true, sent, warnings }
}

/**
 * Publish again after Unpublish (ticket 17): a push does not serve withdrawn work again, so the phase is put
 * back here, after its push and before any page is written. Asked when this computer withdrew it, when it
 * ASKED to withdraw it and no answer said it was done (run-prework.ts writes `withdrawAskedAt` before the
 * request goes out, so a withdraw the Worker applied but whose answer was lost is still undone), or when the
 * Run was unpublished after it last went out; otherwise nothing is asked. A refusal is the service's fixed
 * sentence, and the publish stops.
 */
export async function serveWorkAgain(service: Pick<RunPreworkService, 'status' | 'withdraw'>, talkSlug: string, runId: string, phase: Phase,
  work: Pick<RunWork, 'publishedAt' | 'unpublishedAt'>, vaultRoot?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  // The Run's own vault's object (issue 256), as it was just pushed.
  const status = service.status(talkSlug, runId, phase, vaultRoot)
  if (status?.withdrawnAt === undefined && status?.withdrawAskedAt === undefined && !unpublishedSincePublished(work)) return { ok: true }
  const served = await service.withdraw(talkSlug, runId, phase, false, vaultRoot)
  return served.ok ? { ok: true } : { ok: false, error: served.error }
}

/** Whether the phase was unpublished after it last went out (or went out and was never stamped again). */
function unpublishedSincePublished(work: Pick<RunWork, 'publishedAt' | 'unpublishedAt'>): boolean {
  const unpublished = Date.parse(work.unpublishedAt ?? '')
  const published = Date.parse(work.publishedAt ?? '')
  return Number.isFinite(unpublished) && (!Number.isFinite(published) || unpublished >= published)
}

function pinnedFileId(vaultRoot: string, talkSlug: string, runId: string, phase: Phase): string {
  try { return readPinnedWork(vaultRoot, talkSlug, runId, phase).pinned.fileId } catch { /* not pinned yet */ }
  return phase
}

/** "Saïd workshop · Wed 21 Oct, 14:00": the Run as its work page names it (raw text). */
export function runLineFor(run: Pick<RunRecord, 'eventTitle' | 'plannedDate' | 'startTime'>): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(run.plannedDate ?? '') ? dayLabel(run.plannedDate!) : ''
  const when = [date, /^\d{2}:\d{2}$/.test(run.startTime ?? '') ? run.startTime : ''].filter(Boolean).join(', ')
  return [(run.eventTitle ?? '').trim(), when].filter(Boolean).join(' · ')
}

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

/** Take away whatever is at a page folder's name: a link is unlinked (never followed), a folder or file removed. */
function clearAt(path: string): void {
  if (!lexists(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) unlinkSync(path)
  else rmSync(path, { recursive: true, force: true })
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

export interface WriteRunWorkPagesInput {
  compilerDir: string
  /** The Run's folder in the site, as writableSiteFolder gave it. */
  folder: string
  sent: SentWork[]
  talkTitle: string
  runLine: string
  /** The Run's handout link (checked by the publish's `link` before anything is written). */
  handoutUrl: string
}

/**
 * Write each sent phase's page into the Run's site folder, and take away the page of a phase the Run
 * no longer has. Every page is built before the first is written, so a page that cannot be built
 * (a right answer, an address that is not one) leaves the folder as it was.
 */
export async function writeRunWorkPages(input: WriteRunWorkPagesInput): Promise<void> {
  const pages = new Map<Phase, string>()
  for (const work of input.sent) {
    const page = await buildParticipantWorkPage({
      compilerDir: input.compilerDir, compiled: work.compiled, phase: work.phase,
      preworkId: work.preworkId, workerBaseUrl: work.workerBaseUrl,
      talkTitle: input.talkTitle, runLine: input.runLine, handoutUrl: input.handoutUrl,
    })
    pages.set(work.phase, page.html)
  }
  for (const phase of PHASES) {
    const at = join(input.folder, WORK_PAGE_FOLDER[phase])
    const html = pages.get(phase)
    if (html === undefined) { clearAt(at); continue }
    if (lexists(at)) {
      const stat = lstatSync(at)
      if (stat.isSymbolicLink() || !stat.isDirectory()) clearAt(at)
    }
    if (!lexists(at)) mkdirSync(at)
    writeAtomically(join(at, 'index.html'), html)
  }
}

export type RunWorkPreview = { ok: true; path: string; phase: Phase } | { ok: false; error: string }

/**
 * Preview page: the participant page of the Run's first phase (pre-work, else post-work) built on this
 * computer from the copy the Run was sent with, or from the work file when it has not been sent, and
 * written into the Run's own folder in the vault as `preview-<phase>.html`. Nothing is pinned, pushed or
 * uploaded, and the page asks nothing of the Worker.
 */
export async function buildRunWorkPreview(input: { vaultRoot: string; run: RunRecord; compilerDir: string; talkTitle: string }): Promise<RunWorkPreview> {
  const { vaultRoot, run } = input
  const phase = PHASES.find((candidate) => run.work?.[candidate] && run.work[candidate]!.fileId !== LEGACY_SECTION_FILE_ID)
  if (!phase) return { ok: false, error: WORK_PREVIEW_NONE }
  const work = run.work![phase]!
  let text: string | null
  try {
    text = work.pinned ? readPinnedWork(vaultRoot, run.talkSlug, run.id, phase).text : decodeUtf8(readWorkFileBytes(vaultRoot, work.fileId))
  } catch (error) {
    return { ok: false, error: pinErrorText(error instanceof Error ? error.message : '', phase, work.fileId) }
  }
  if (text === null) return { ok: false, error: pinErrorText('work-file-not-utf8', phase, work.fileId) }
  const compiled = await compilePinned(vaultRoot, input.compilerDir, work.fileId, text)
  const refused = blockingText(phase, compiled.title || work.fileId, compiled.findings)
  if (refused) return { ok: false, error: refused }
  if (!compiled.form) return { ok: false, error: `The ${name(phase)} file “${compiled.title || work.fileId}” is not ready: it has no step participants can open.` }
  // The page shows the Run's own opening and closing times (post-work that opens at the session's end shows as open now).
  const own = workPushWindowMs(work, null)
  const closesAt = zonedLocalToMs(work.closes, work.timeZone)
  const previewWindow = work.opens === SESSION_END
    ? (Number.isSafeInteger(closesAt) ? { opensAt: Date.now() - 60_000, closesAt } : undefined)
    : own ? { opensAt: own.opensAt, closesAt: own.closesAt } : undefined
  const page = await buildParticipantWorkPage({
    compilerDir: input.compilerDir, compiled, phase, preworkId: WORK_PREVIEW_ID, workerBaseUrl: WORK_PREVIEW_WORKER,
    talkTitle: input.talkTitle, runLine: runLineFor(run), handoutUrl: run.handoutUrl ?? '', preview: true,
    ...(previewWindow ? { previewWindow } : {}),
  })
  const folder = runFolder(vaultRoot, run.talkSlug, run.id, true)
  if (!folder) return { ok: false, error: pinErrorText('run-folder-unsafe', phase, work.fileId) }
  const path = join(folder, `preview-${phase}.html`)
  if (lexists(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, error: pinErrorText('run-folder-unsafe', phase, work.fileId) }
  }
  writeAtomically(path, page.html)
  return { ok: true, path, phase }
}
