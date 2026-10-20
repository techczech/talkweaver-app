// A board slide fed by a pre-work step opens with the Run's picked answers (feedback-boards ticket 11).
//
// The slide is fed by `{results=<step id>}` on a board slide of the talk. The step is found from the
// compiler's own model (`model.prework.feeds`), whose slide ids are the ones the presenter and the live
// session use. The answers come from the Run the live session is bound to: the starred ones, or every
// one, as the Run page says. They ride on the board's `poll.open` as `seed`, which the Worker takes
// into the board's first column when the board has never held a card. Only main adds a seed: any
// `seed` a window sends is dropped first (`withoutSeed`).
//
// Work files (0.40 ticket 27): `{results=<file id>/<step id>}` names a step of a work file instead. The
// Run's attachment says which phase the file is in, the step is looked up in that phase's PINNED
// revision, and `resultsBoardSeed` (src/shared/results-seed.ts) decides the cards or the finding. Every
// edge case opens the board empty (with the finding handed to `onFinding`); none throws.
//
// Authority (ticket 27 review): the Run is read only from the vault the live session recorded when it
// was bound, and only while that vault is open and its folder is there; and the section form seeds
// only a Run whose pre-work is the talk's own section (no work file, or `legacy-section`).
import type { PollDefinition } from '../../worker/protocol.ts'
import { BOARD_DEFAULTS, BOARD_SEED_MAX } from '../../worker/board-protocol.ts'
import type { PreworkFeed } from '../../compiler/scripts/lib/prework.mjs'
import { preworkSeedTexts, stepFeedingSlide, workFeedFor } from '../shared/run-prework-results.ts'
import type { RunPrework } from '../shared/run-prework.ts'
import { resultsBoardSeed, type ResultsFinding } from '../shared/results-seed.ts'
import { stepsFromWorkFile } from '../shared/run-answers.ts'
import { LEGACY_SECTION_FILE_ID, type Phase } from '../shared/run-work.ts'
import { readPinnedWork } from './run-work-pin.ts'
import { readRunForTalk, type RunRecord } from './runs.ts'

/** `poll` with no `seed`: a window may not put cards on a board. */
export function withoutSeed(poll: PollDefinition): PollDefinition {
  if (!('seed' in poll)) return poll
  const { seed: _seed, ...rest } = poll
  return rest
}

/**
 * `poll` with the seed cards its slide is owed, or `poll` itself (never one carrying a seed it was
 * handed) when it is not a board, its slide is fed by no step, or the step has no answers to open with.
 * Each text is cut to the board's card length, as the Worker would.
 */
export function seedBoardFromPrework(poll: PollDefinition, prework: RunPrework | null | undefined, feeds: readonly PreworkFeed[] | null | undefined): PollDefinition {
  const clean = withoutSeed(poll)
  if (clean.type !== 'board' || !clean.slideId || !prework || !clean.options.length) return clean
  const step = stepFeedingSlide(feeds, clean.slideId)
  if (!step) return clean
  const column = clean.options[0].optionId
  const cardChars = clean.board?.cardChars ?? BOARD_DEFAULTS.cardChars
  const seed = preworkSeedTexts(prework, step).slice(0, BOARD_SEED_MAX)
    .map((text) => ({ column, text: [...text.trim()].slice(0, cardChars).join('').trim() })).filter((card) => card.text)
  return seed.length ? { ...clean, seed } : clean
}

/**
 * `poll` with the seed a work-file step's board is owed, or `poll` unchanged (no seed) with the finding
 * that says why. `pinnedSteps` gives the step ids of the revision the Run pinned for a phase, or null.
 */
export function seedBoardFromWork(
  poll: PollDefinition,
  run: Pick<RunRecord, 'work' | 'prework' | 'postwork'>,
  feeds: readonly PreworkFeed[] | null | undefined,
  pinnedSteps: (phase: Phase) => readonly string[] | null,
  /** Local only step ids of the pinned revision for a phase (a board on one has nothing to show); none known when absent. */
  pinnedLocal?: (phase: Phase) => readonly string[] | null
): { poll: PollDefinition; finding: ResultsFinding | null } {
  const clean = withoutSeed(poll)
  if (clean.type !== 'board' || !clean.slideId || !clean.options.length) return { poll: clean, finding: null }
  const feed = workFeedFor(feeds, clean.slideId)
  if (!feed) return { poll: clean, finding: null }
  const steps: Partial<Record<Phase, readonly string[] | null>> = {}
  const local: Partial<Record<Phase, readonly string[] | null>> = {}
  for (const phase of ['pre', 'post'] as const) {
    if (!run.work?.[phase]?.pinned) continue
    steps[phase] = pinnedSteps(phase)
    if (pinnedLocal) local[phase] = pinnedLocal(phase)
  }
  const result = resultsBoardSeed({
    fileId: feed.fileId, stepId: feed.stepId, slideId: clean.slideId, work: run.work, pinnedSteps: steps, localSteps: local,
    answers: { pre: run.prework, post: run.postwork }, cardChars: clean.board?.cardChars
  })
  if (!result.texts.length) return { poll: clean, finding: result.finding }
  const column = clean.options[0].optionId
  return { poll: { ...clean, seed: result.texts.map((text) => ({ column, text })) }, finding: result.finding }
}

export interface SeedDeps {
  /**
   * Whether the vault the live session was bound in (its recorded root) is open and readable now. The
   * seed is read from that vault only: never the current primary vault, never another vault that
   * happens to hold the same talk slug and Run id.
   */
  vaultReadable(vaultRoot: string): boolean
  /** The talk's outline text as the presenter compiled it, or null. */
  readOutline(): string | null
  /** The compiler's feeds for that outline (`model.prework.feeds`), or null when it cannot be compiled. */
  feeds(outline: string): Promise<readonly PreworkFeed[] | null>
  /** Step ids of the revision the Run pinned for a phase; defaults to reading the pinned copy beside the Run. */
  pinnedSteps?(vaultRoot: string, talkSlug: string, runId: string, phase: Phase): readonly string[] | null
  /** Told why a results-fed board opened empty or short. */
  onFinding?(finding: ResultsFinding): void
  /**
   * Pull a phase's answers from the live service onto the Run before it is read (2026-10-19 prework-responses:
   * the timer only counts, so the Run on disk is as fresh as its last opening). The same pull, queue and cursor
   * the Run page uses. Best effort: a pull that fails or takes longer than `pullWaitMs` leaves the Run as it is
   * on disk, and the board opens with that.
   */
  pull?(talkSlug: string, runId: string, phase: Phase, vaultRoot: string): Promise<unknown>
  /** How long a board waits for the pulls before it opens with what is on disk (default 5 s). */
  pullWaitMs?: number
}

/** Pull both phases (each its own queue), waiting at most `waitMs`; never throws. */
async function pullFirst(deps: SeedDeps, talkSlug: string, runId: string, vaultRoot: string): Promise<void> {
  if (!deps.pull) return
  const pulls = (['pre', 'post'] as const).map((phase) => Promise.resolve().then(() => deps.pull!(talkSlug, runId, phase, vaultRoot)).catch(() => null))
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.pullWaitMs ?? 5_000) })
  try { await Promise.race([Promise.all(pulls).then(() => undefined), late]) } finally { if (timer) clearTimeout(timer) }
}

/** The live session a board opens in: the talk, the Run it is bound to, and the vault both were found in. */
export interface SeedBinding { talkSlug: string; runId?: string; vaultRoot?: string | null }

/** The step ids of a Run's pinned copy, or null when it cannot be read (a missing, changed or unsafe copy). */
export function readPinnedStepIds(vaultRoot: string, talkSlug: string, runId: string, phase: Phase): string[] | null {
  try { return stepsFromWorkFile(readPinnedWork(vaultRoot, talkSlug, runId, phase).text).map((step) => step.id) } catch { return null }
}

/** The Local only step ids of a Run's pinned copy, or null when it cannot be read. */
export function readPinnedLocalStepIds(vaultRoot: string, talkSlug: string, runId: string, phase: Phase): string[] | null {
  try { return stepsFromWorkFile(readPinnedWork(vaultRoot, talkSlug, runId, phase).text).filter((step) => step.local).map((step) => step.id) } catch { return null }
}

/**
 * Whether a Run's pre-work answers belong to the talk's own `{prework}` section (the 0.37 form that
 * `{results=<step id>}` names): the Run attaches no work file for pre-work, or only the derived
 * `legacy-section` one. A Run whose pre-work is a work file never seeds through the section form,
 * whatever step id the slide names; its answers go only through the file's pinned revision.
 */
export function preworkIsSectionBacked(run: Pick<RunRecord, 'work'>): boolean {
  const pre = run.work?.pre
  return !pre || pre.fileId === LEGACY_SECTION_FILE_ID
}

/**
 * The glue `poll.open` goes through in the app: the Run the live session is bound to, read from the
 * vault the session was bound in, its answers, the compiled feeds, then `seedBoardFromWork` for a
 * work-file step or `seedBoardFromPrework` for a section step of a section-backed Run. Best effort:
 * anything that cannot be read opens the board empty, as any board opens.
 */
export async function seedPollForRun(poll: PollDefinition, bound: SeedBinding | null, deps: SeedDeps): Promise<PollDefinition> {
  const clean = withoutSeed(poll)
  const report = (finding: ResultsFinding | null) => { if (finding) { try { deps.onFinding?.(finding) } catch { /* reporting never blocks a board */ } } }
  try {
    if (clean.type !== 'board' || !bound?.runId) return clean
    const compiledFeeds = async () => { const outline = deps.readOutline(); return outline === null ? null : await deps.feeds(outline) }
    const vaultRoot = bound.vaultRoot ?? null
    if (!vaultRoot || !deps.vaultReadable(vaultRoot)) {
      // Said only for a board a step feeds; any other board opens empty without a word, as it always does.
      const feeds = clean.slideId ? await compiledFeeds() : null
      if (clean.slideId && (workFeedFor(feeds, clean.slideId) || stepFeedingSlide(feeds, clean.slideId))) {
        report({ code: 'results-vault-unavailable', slideId: clean.slideId, detail: bound.talkSlug })
      }
      return clean
    }
    const before = readRunForTalk(vaultRoot, bound.talkSlug, bound.runId)
    if (!before || (!before.prework && !before.postwork && !before.work)) return clean
    const feeds = await compiledFeeds()
    // A board a step feeds: pull what waits on the live service first, so it opens with every answer sent so far.
    if (clean.slideId && (workFeedFor(feeds, clean.slideId) || stepFeedingSlide(feeds, clean.slideId))) await pullFirst(deps, bound.talkSlug, bound.runId, vaultRoot)
    const run = readRunForTalk(vaultRoot, bound.talkSlug, bound.runId)
    if (!run || (!run.prework && !run.postwork && !run.work)) return clean
    if (clean.slideId && workFeedFor(feeds, clean.slideId)) {
      const fromWork = seedBoardFromWork(clean, run, feeds, (phase) =>
        (deps.pinnedSteps ?? readPinnedStepIds)(vaultRoot, bound.talkSlug, bound.runId as string, phase),
      // Only the pinned copy on disk says which steps are Local only; a test's own step list says nothing about it.
      deps.pinnedSteps ? undefined : (phase) => readPinnedLocalStepIds(vaultRoot, bound.talkSlug, bound.runId as string, phase))
      report(fromWork.finding)
      return fromWork.poll
    }
    if (!run.prework || !clean.slideId || !stepFeedingSlide(feeds, clean.slideId)) return clean
    if (!preworkIsSectionBacked(run)) {
      report({ code: 'results-section-step-on-file-run', slideId: clean.slideId, detail: stepFeedingSlide(feeds, clean.slideId) ?? '' })
      return clean
    }
    return seedBoardFromPrework(clean, run.prework, feeds)
  } catch { return clean }
}
