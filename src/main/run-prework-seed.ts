// A board slide fed by a pre-work step opens with the Run's picked answers (feedback-boards ticket 11).
//
// The slide is fed by `{results=<step id>}` on a board slide of the talk. The step is found from the
// compiler's own model (`model.prework.feeds`), whose slide ids are the ones the presenter and the live
// session use. The answers come from the Run the live session is bound to: the starred ones, or every
// one, as the Run page says. They ride on the board's `poll.open` as `seed`, which the Worker takes
// into the board's first column when the board has never held a card. Only main adds a seed: any
// `seed` a window sends is dropped first (`withoutSeed`).
import type { PollDefinition } from '../../worker/protocol.ts'
import { BOARD_DEFAULTS, BOARD_SEED_MAX } from '../../worker/board-protocol.ts'
import type { PreworkFeed } from '../../compiler/scripts/lib/prework.mjs'
import { preworkSeedTexts, stepFeedingSlide } from '../shared/run-prework-results.ts'
import type { RunPrework } from '../shared/run-prework.ts'
import { readRunForTalk } from './runs.ts'

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

export interface SeedDeps {
  vaultRoot(): string | null
  /** The talk's outline text as the presenter compiled it, or null. */
  readOutline(): string | null
  /** The compiler's feeds for that outline (`model.prework.feeds`), or null when it cannot be compiled. */
  feeds(outline: string): Promise<readonly PreworkFeed[] | null>
}

/**
 * The glue `poll.open` goes through in the app: the Run the live session is bound to, its pre-work, the
 * compiled feeds, then `seedBoardFromPrework`. Best effort: anything that cannot be read opens the board
 * empty, as any board opens.
 */
export async function seedPollForRun(poll: PollDefinition, bound: { talkSlug: string; runId?: string } | null, deps: SeedDeps): Promise<PollDefinition> {
  const clean = withoutSeed(poll)
  try {
    if (clean.type !== 'board' || !bound?.runId) return clean
    const vaultRoot = deps.vaultRoot()
    const run = vaultRoot ? readRunForTalk(vaultRoot, bound.talkSlug, bound.runId) : null
    if (!run?.prework) return clean
    const outline = deps.readOutline()
    const feeds = outline === null ? null : await deps.feeds(outline)
    return seedBoardFromPrework(clean, run.prework, feeds)
  } catch { return clean }
}
