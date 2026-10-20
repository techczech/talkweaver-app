// What the Run page asks main for (work-files-and-sessions ticket 10). The renderer names a Run by its
// vault, talk slug and Run id; main checks all three before it reads or writes anything, and the renderer
// never supplies a path or a work-file id.
//   sessions:run-files        how each attached work file reads (title, steps, first blocking finding)
//   sessions:run-answers      each attached phase's steps (from its work file, or the talk's `{prework}` section
//                             for a Run made before work files) and the Run's answers for it (ticket 18)
//   sessions:mark-delivered   a planned Run given without presenting from the app becomes delivered
//   sessions:open-work-file   the Run's attached file for one phase: checked, and its name returned so the Work files view shows it
//   sessions:open-live-view   the presenter window of the Run's live session, brought forward
//   sessions:preview-page     Preview page (ticket 16): the participant page built on this computer into the
//                             Run's own folder and opened, nothing uploaded and nothing asked of the Worker
//   sessions:run-qr           the QR code of one of the Run's published links, as SVG (ticket 16)
//   sessions:set-extras       Extras for this run (ticket 24): the intro note and links, checked and kept on the Run
//                             (planned or delivered); they show on the Run's handout from its next publish
//   sessions:extra-slides     Extras for this run (ticket 25): the Run's extra slides, kept on the Run record,
//                             with the Run's slides for "Place after"
//   sessions:save-extra-slide one extra slide added (no id: main makes its id) or changed (the id of one the Run
//                             has), checked, then kept on the Run (planned or delivered)
//   sessions:remove-extra-slide  one taken away; the last one takes the field away, so the Run's file is byte
//                             for byte what it was. The talk's outline is never written for any of these.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markRunDelivered, readRunForTalk, resolveRunSlideSet, setRunExtras, updateRunExtraSlides, type RunRecord } from './runs.ts'
import { EXTRA_SLIDE_ID_RE, RUN_EXTRA_SLIDE_LIMITS, checkExtraSlideInput, checkRunExtrasInput, mintExtraSlideId, type RunExtraSlide, type RunExtras } from '../shared/run-extras.ts'
import { decideShellPath } from './shell-path-policy.ts'
import { workFileState } from '../shared/run-page.ts'
import { stepsFromOutline, stepsFromWorkFile, type PhaseSteps } from '../shared/run-answers.ts'
import type { RunPrework } from '../shared/run-prework.ts'
import { LEGACY_SECTION_FILE_ID, WORK_FILE_ID, type Phase } from '../shared/run-work.ts'
import { parseToolsRunRef } from '../shared/tools-views.ts'
import { EXTRA_SLIDES_NEED_NEW_FORMAT, extraSlideViews, type RunExtraSlidesState, type RunSlideChoice } from '../shared/run-extra-slides.ts'
import { readPathwayManifest } from './pathways.ts'
import type { WorkFileState } from '../shared/run-checklist.ts'

/** Where a vault keeps its work files (ticket 06 lists the same folder). */
export const WORK_FILES_FOLDER = 'Work files'

export interface RunPageDeps {
  ipcMain: { handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void }
  /** The open vaults whose folders are there. */
  vaults(): Array<{ id: string; root: string }>
  /** Hands a vetted absolute path to the OS; resolves to '' on success or an error text. */
  openPath(path: string): Promise<string>
  /** Brings the presenter window of a live Run forward; false when it has none. */
  /** Bring forward the presenter window of this Run of the vault at `vaultRoot`, if there is one. */
  focusLive(talkSlug: string, runId: string, vaultRoot: string): boolean
  /** The text of a talk's outline, or null: the steps of a Run made before work files are in its `{prework}` section. */
  readOutline?(vaultRoot: string, talkSlug: string): string | null
  /** Whether the vault of this id can be written now (open, and its folder is there): a Run's pulls and marks go to its own vault. */
  writableVault?(vaultId: string): boolean
  /** A Run was marked delivered (post-work that opens "when the session ends" may open now). */
  onDelivered?(talkSlug: string, runId: string, vaultRoot: string): void
  /** Build the Run's participant page on this computer (run-work-publish.ts buildRunWorkPreview): the file written, or the refusal. */
  previewPage?(root: string, run: RunRecord): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** The QR code of an address, as SVG; null when it cannot be made. */
  qrSvg?(url: string): Promise<string | null> | string | null
  /**
   * The talk's slides as its own compile has them, and its pre-work steps; null when the talk is not in that
   * vault or does not compile. Main finds the talk in the vault (findTalks). `legacy`: the outline compiles in
   * the older format, which never takes a Run's extra slides.
   */
  talkSlides?(vaultRoot: string, talkSlug: string): Promise<TalkSlides | null>
  /**
   * The Run's phases whose only object is one published before 0.41 that records no vault (run-prework.ts
   * `ownerUnknown`): the Run page says it is not pulled, reused or withdrawn from here.
   */
  ownerUnknown?(vaultRoot: string, run: RunRecord): Array<'pre' | 'post'>
}

export type RunPageResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string }

/** The Run as asked for: `talkSlug`/`runId` are the requested ones (the file was checked to name them), and writes use these. */
interface Located { root: string; talkSlug: string; runId: string; run: RunRecord }

/** Publish or Unpublish named a vault that is not open (or is not there, or cannot be written now). */
export const RUN_VAULT_NOT_OPEN = 'That Run\'s vault is not open on this computer, so nothing was changed.'

/**
 * The vault a Run publish or unpublish acts in (ticket 17 round 3). With a `vaultId` (the Sessions view
 * always sends the selected Run's): that open vault, and only while it can be written; an unknown, closed
 * or missing one is refused, never replaced by the first writable vault. Without one (an older caller):
 * `fallback`, the first writable vault, as before.
 */
export function runVaultRoot(
  vaults: ReadonlyArray<{ id: string; root: string }>, vaultId: unknown,
  fallback: () => string | undefined, writable: (root: string) => string | undefined,
): { root: string | undefined } | { error: string } {
  if (vaultId === undefined) return { root: fallback() }
  if (typeof vaultId !== 'string' || !vaultId) return { error: RUN_VAULT_NOT_OPEN }
  const vault = vaults.find((candidate) => candidate.id === vaultId)
  const root = vault ? writable(vault.root) : undefined
  return root ? { root } : { error: RUN_VAULT_NOT_OPEN }
}

function locate(deps: RunPageDeps, payload: unknown): Located | { error: string } {
  const ref = parseToolsRunRef(payload)
  const vaultId = (payload as { vaultId?: unknown } | null)?.vaultId
  if (!ref || typeof vaultId !== 'string') return { error: 'Unknown Run.' }
  const vault = deps.vaults().find((candidate) => candidate.id === vaultId)
  if (!vault) return { error: 'That vault is not open.' }
  // Only from the talk's own folder, and only a file that names itself as the Run asked for: a file whose
  // JSON names another talk or Run is not that Run, so nothing reads or writes through it.
  const run = readRunForTalk(vault.root, ref.talkSlug, ref.runId)
  return run ? { root: vault.root, talkSlug: ref.talkSlug, runId: ref.runId, run } : { error: 'That Run is no longer there.' }
}

function readFiles(root: string, run: RunRecord): { pre?: WorkFileState; post?: WorkFileState } {
  const files: { pre?: WorkFileState; post?: WorkFileState } = {}
  for (const phase of ['pre', 'post'] as const) {
    const work = run.work?.[phase]
    if (!work || !WORK_FILE_ID.test(work.fileId)) continue
    try { files[phase] = workFileState(readFileSync(join(root, WORK_FILES_FOLDER, `${work.fileId}.md`), 'utf8')) } catch { /* absent: the checklist says "not found" */ }
  }
  return files
}

/** Each attached phase's steps. A file that cannot be read gives no steps (the section says so); nothing here throws. */
export function readPhaseSteps(root: string, run: RunRecord, readOutline?: (vaultRoot: string, talkSlug: string) => string | null): { pre?: PhaseSteps; post?: PhaseSteps } {
  const out: { pre?: PhaseSteps; post?: PhaseSteps } = {}
  for (const phase of ['pre', 'post'] as const) {
    const work = run.work?.[phase]
    if (!work) continue
    try {
      if (work.fileId === LEGACY_SECTION_FILE_ID) {
        const text = readOutline?.(root, run.talkSlug)
        out[phase] = { source: 'outline', steps: text ? stepsFromOutline(text) : [] }
      } else if (WORK_FILE_ID.test(work.fileId)) {
        out[phase] = { source: 'file', steps: stepsFromWorkFile(readFileSync(join(root, WORK_FILES_FOLDER, `${work.fileId}.md`), 'utf8')) }
      }
    } catch { out[phase] = { source: work.fileId === LEGACY_SECTION_FILE_ID ? 'outline' : 'file', steps: [] } }
  }
  return out
}

/** The Run's slides (its pathway's, in the pathway's order, or the whole talk's), pre-work steps left out. */
export function runSlideChoices(root: string, run: RunRecord, talk: { slides: RunSlideChoice[]; preworkIds: string[] }): RunSlideChoice[] {
  const prework = new Set(talk.preworkIds)
  const rows = talk.slides.filter((slide) => !prework.has(slide.id)).map((slide) => ({ slide_id: slide.id, title: slide.title }))
  const pathways = run.slideSet.kind === 'pathway' ? readPathwayManifest(root, run.talkSlug).pathways : []
  return resolveRunSlideSet(run.slideSet, pathways, rows).rows.map((row) => ({ id: row.slide_id, title: row.title }))
}

/** The talk's slides for a Run's extra slides (RunPageDeps.talkSlides). */
export type TalkSlides = { slides: RunSlideChoice[]; preworkIds: string[]; legacy?: boolean }

const EXTRA_SLIDES_UNAVAILABLE = 'The talk of this run could not be read, so its extra slides cannot be shown.'
const SLIDE_GONE = 'That slide is no longer there.'
/** A change to a Run's extra slides refused in words (shown on the Run page); any other error is a failed save. */
class RefusedChange extends Error {}

export function registerRunPageIpc(deps: RunPageDeps): void {
  const { ipcMain } = deps
  ipcMain.handle('sessions:run-files', (_event, payload): RunPageResult<{ files: { pre?: WorkFileState; post?: WorkFileState } }> => {
    const found = locate(deps, payload)
    return 'error' in found ? { ok: false, error: found.error } : { ok: true, files: readFiles(found.root, found.run) }
  })

  ipcMain.handle('sessions:run-answers', (_event, payload): RunPageResult<{ pre?: PhaseSteps; post?: PhaseSteps; prework?: RunPrework; postwork?: RunPrework; writable: boolean; ownerUnknown?: Array<'pre' | 'post'> }> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    const steps = readPhaseSteps(found.root, found.run, deps.readOutline)
    // Stars, marks and pulls write to the Run's own vault; while that vault cannot be written the Run is read-only here.
    const writable = deps.writableVault ? deps.writableVault((payload as { vaultId: string }).vaultId) : true
    let ownerUnknown: Array<'pre' | 'post'> = []
    try { ownerUnknown = (deps.ownerUnknown?.(found.root, found.run) ?? []).filter((phase) => steps[phase]) } catch { ownerUnknown = [] }
    return { ok: true, writable, ...steps, ...(found.run.prework ? { prework: found.run.prework } : {}), ...(found.run.postwork ? { postwork: found.run.postwork } : {}),
      ...(ownerUnknown.length ? { ownerUnknown } : {}) }
  })

  ipcMain.handle('sessions:mark-delivered', (_event, payload): RunPageResult => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    if (found.run.status !== 'planned') return { ok: false, error: 'That Run is already delivered.' }
    try {
      const next = markRunDelivered(found.root, found.talkSlug, found.runId)
      if (!next) return { ok: false, error: 'That Run is no longer planned.' }
    } catch { return { ok: false, error: 'The Run could not be saved.' } }
    try { deps.onDelivered?.(found.talkSlug, found.runId, found.root) } catch { /* the Run is saved */ }
    return { ok: true }
  })

  ipcMain.handle('sessions:set-extras', (_event, payload): RunPageResult<{ extras: RunExtras | null }> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    const checked = checkRunExtrasInput((payload as { extras?: unknown }).extras)
    if (!checked.ok) return checked
    try {
      const next = setRunExtras(found.root, found.talkSlug, found.runId, checked.extras)
      if (!next) return { ok: false, error: 'That Run is no longer there.' }
      return { ok: true, extras: next.extras ?? null }
    } catch { return { ok: false, error: 'The Run could not be saved.' } }
  })

  // Extra slides (ticket 25), kept on the Run record. The renderer names the Run only; main finds the talk in
  // the Run's own vault for the Run's slides ("Place after"). Ids of new slides are made here, never taken from
  // the renderer; a change or a removal names an id the Run has.
  const talkOf = async (found: Located): Promise<TalkSlides | null> =>
    (await deps.talkSlides?.(found.root, found.talkSlug).catch(() => null)) ?? null
  const choicesOf = (found: Located, run: RunRecord, talk: TalkSlides): RunSlideChoice[] => {
    try { return runSlideChoices(found.root, run, talk) } catch { return [] }
  }
  const stateOf = (found: Located, run: RunRecord, talk: TalkSlides): RunExtraSlidesState => {
    const slides = choicesOf(found, run, talk)
    const extras = (run.extraSlides ?? []).map((slide) => ({ id: slide.id, title: slide.title, text: slide.text, after: slide.after ?? '' }))
    return { slides, extraSlides: extraSlideViews(extras, slides, talk.slides), ...(talk.legacy ? { legacyOutline: true as const } : {}) }
  }
  // `kind` 'save': refused for a talk whose outline is in the older format (its compile never takes extra
  // slides); 'remove' is always allowed, so a Run can be cleared of slides it cannot show.
  const changeExtraSlides = async (found: Located, kind: 'save' | 'remove', change: (current: RunExtraSlide[], choices: Set<string>) => RunExtraSlide[]): Promise<RunPageResult<RunExtraSlidesState>> => {
    // The talk is compiled first (it awaits); the Run is then read, changed and written in one go.
    const talk = await talkOf(found)
    if (!talk) return { ok: false, error: EXTRA_SLIDES_UNAVAILABLE }
    if (kind === 'save' && talk.legacy) return { ok: false, error: EXTRA_SLIDES_NEED_NEW_FORMAT }
    let next: RunRecord | null
    try {
      next = updateRunExtraSlides(found.root, found.talkSlug, found.runId, (current, run) =>
        change(current, new Set(choicesOf(found, run, talk).map((slide) => slide.id))))
    } catch (error) {
      return { ok: false, error: error instanceof RefusedChange ? error.message : 'The Run could not be saved.' }
    }
    if (!next) return { ok: false, error: 'That Run is no longer there.' }
    return { ok: true, ...stateOf(found, next, talk) }
  }

  ipcMain.handle('sessions:extra-slides', async (_event, payload): Promise<RunPageResult<RunExtraSlidesState>> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    const talk = await talkOf(found)
    if (!talk) return { ok: false, error: EXTRA_SLIDES_UNAVAILABLE }
    return { ok: true, ...stateOf(found, found.run, talk) }
  })

  ipcMain.handle('sessions:save-extra-slide', async (_event, payload): Promise<RunPageResult<RunExtraSlidesState>> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    const raw = (payload as { slide?: unknown }).slide
    const checked = checkExtraSlideInput(raw)
    if (!checked.ok) return checked
    const rawId = (raw as { id?: unknown }).id
    if (rawId !== undefined && (typeof rawId !== 'string' || !EXTRA_SLIDE_ID_RE.test(rawId))) return { ok: false, error: SLIDE_GONE }
    const id = rawId as string | undefined
    const { title, text, after } = checked.slide
    return changeExtraSlides(found, 'save', (current, choices) => {
      const existing = id ? current.find((slide) => slide.id === id) : undefined
      if (id && !existing) throw new RefusedChange(SLIDE_GONE)
      // "Place after" offers the Run's slides; a slide kept where it already was may stay there.
      if (after && !choices.has(after) && after !== existing?.after) throw new RefusedChange('That slide is not in this run’s slides.')
      const kept: Omit<RunExtraSlide, 'id'> = { title, text, ...(after ? { after } : {}) }
      if (!existing) {
        if (current.length >= RUN_EXTRA_SLIDE_LIMITS.slides) throw new RefusedChange(`A run can have up to ${RUN_EXTRA_SLIDE_LIMITS.slides} extra slides.`)
        return [...current, { id: mintExtraSlideId(current.map((slide) => slide.id)), ...kept }]
      }
      return current.map((slide) => (slide.id === id ? { id: slide.id, ...kept } : slide))
    })
  })

  ipcMain.handle('sessions:remove-extra-slide', async (_event, payload): Promise<RunPageResult<RunExtraSlidesState>> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    const id = (payload as { id?: unknown }).id
    if (typeof id !== 'string' || !EXTRA_SLIDE_ID_RE.test(id)) return { ok: false, error: SLIDE_GONE }
    return changeExtraSlides(found, 'remove', (current) => {
      if (!current.some((slide) => slide.id === id)) throw new RefusedChange(SLIDE_GONE)
      return current.filter((slide) => slide.id !== id)
    })
  })

  // The file is shown by the Work files view inside TalkWeaver (the OS would hand a .md to whatever app owns it).
  ipcMain.handle('sessions:open-work-file', async (_event, payload): Promise<RunPageResult<{ fileName: string; vaultId: string }>> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    const phase = (payload as { phase?: unknown }).phase
    if (phase !== 'pre' && phase !== 'post') return { ok: false, error: 'Unknown phase.' }
    const work = found.run.work?.[phase as Phase]
    if (!work || !WORK_FILE_ID.test(work.fileId)) return { ok: false, error: 'This Run has no file for that phase.' }
    const wanted = join(found.root, WORK_FILES_FOLDER, `${work.fileId}.md`)
    const target = existsSync(wanted) ? decideShellPath('open', wanted, [found.root]) : null
    if (!target || !target.ok) return { ok: false, error: `The file “${work.fileId}” was not found in the Work files folder.` }
    return { ok: true, fileName: `${work.fileId}.md`, vaultId: (payload as { vaultId: string }).vaultId }
  })

  ipcMain.handle('sessions:preview-page', async (_event, payload): Promise<RunPageResult> => {
    const found = locate(deps, payload)
    if ('error' in found) return { ok: false, error: found.error }
    if (!deps.previewPage) return { ok: false, error: 'Preview is not available.' }
    let built: { ok: true; path: string } | { ok: false; error: string }
    try { built = await deps.previewPage(found.root, found.run) } catch { return { ok: false, error: 'The preview could not be built.' } }
    if (!built.ok) return built
    // Only a file inside the Run's own vault is handed to the OS.
    const target = existsSync(built.path) ? decideShellPath('open', built.path, [found.root]) : null
    if (!target || !target.ok) return { ok: false, error: 'The preview could not be opened.' }
    const failure = await deps.openPath(target.path)
    return failure === '' ? { ok: true } : { ok: false, error: 'The preview could not be opened.' }
  })

  ipcMain.handle('sessions:run-qr', async (_event, payload): Promise<RunPageResult<{ svg: string }>> => {
    const url = (payload as { url?: unknown } | null)?.url
    if (typeof url !== 'string' || url.length > 2000 || !/^https?:\/\/[^\s"'<>\\]+$/i.test(url)) return { ok: false, error: 'Not a link.' }
    let svg: string | null = null
    try { svg = (await deps.qrSvg?.(url)) ?? null } catch { svg = null }
    return svg && /^<svg[\s>]/.test(svg.trim()) ? { ok: true, svg } : { ok: false, error: 'The QR code could not be made.' }
  })

  ipcMain.handle('sessions:open-live-view', (_event, payload): RunPageResult => {
    const ref = parseToolsRunRef(payload)
    if (!ref || !ref.vaultId) return { ok: false, error: 'Unknown Run.' }
    // The Run's own vault (issue 256): another open vault's live session of the same talk and Run id is not this Run's.
    const vault = deps.vaults().find((candidate) => candidate.id === ref.vaultId)
    if (!vault) return { ok: false, error: 'That vault is not open.' }
    return deps.focusLive(ref.talkSlug, ref.runId, vault.root) ? { ok: true } : { ok: false, error: 'The presenter window for this live session is not open.' }
  })
}
