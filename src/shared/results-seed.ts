// A board slide fed by a work-file step (`{results=<file id>/<step id>}`; ADR-0040 Consequences,
// work-files-and-sessions ticket 27). Pure: no Electron, no fs.
//
// The bound Run says which phase the file is attached to; the step is looked up in the PINNED revision
// of that phase (never the current file); the answers are that phase's, starred ones first as the Run
// page says. The result is the cards the board opens with, or an empty board and the finding that says
// why. Nothing here throws: every edge case is a value. Only the main process puts a seed on a board
// (src/main/run-prework-seed.ts); the renderer never calls this to add one.
import { BOARD_DEFAULTS, BOARD_SEED_MAX } from '../../worker/board-protocol.ts'
import { seedCapacity } from '../../worker/board-state.ts'
import { preworkSeedTexts } from './run-prework-results.ts'
import type { RunPrework } from './run-prework.ts'
import type { Phase, RunWorkSet } from './run-work.ts'

export type ResultsFindingCode =
  | 'results-file-not-attached'
  | 'results-file-not-sent'
  | 'results-step-missing'
  /** The step is Local only (`{local}`) in the pinned revision: its answers never leave participants' phones. */
  | 'results-step-local'
  | 'results-no-answers'
  | 'results-over-cap'
  /** The vault the live session was bound in is closed or not there: nothing is read from any other vault. */
  | 'results-vault-unavailable'
  /** A `{results=<step id>}` (section form) board on a Run whose pre-work is a work file: the section form never reads file answers. */
  | 'results-section-step-on-file-run'

export interface ResultsFinding { code: ResultsFindingCode; slideId: string; detail: string }

export interface ResultsSeedInput {
  fileId: string
  stepId: string
  slideId: string
  /** The bound Run's attachments, with their pins. */
  work: RunWorkSet | null | undefined
  /** Step ids of each phase's PINNED revision; null or absent when the copy cannot be read. */
  pinnedSteps: Partial<Record<Phase, readonly string[] | null>>
  /** Step ids marked Local only (`{local}`) in each phase's pinned revision; absent when not known. */
  localSteps?: Partial<Record<Phase, readonly string[] | null>>
  /** The Run's answers per phase (`prework`, `postwork`), with the stars. */
  answers: Partial<Record<Phase, RunPrework | null | undefined>>
  /** The board's card length; the Worker's default when unset. */
  cardChars?: number
}

export interface ResultsSeed {
  /** The card texts in order; empty means an empty board. */
  texts: string[]
  /** The phase the answers were read from; null when none was. */
  phase: Phase | null
  /** Why the board is empty or short, or null. An over-cap board still opens, with the cards that fit. */
  finding: ResultsFinding | null
}

const PHASES: readonly Phase[] = ['post', 'pre'] // when both phases name the file and both have answers, the later phase wins

const cut = (text: string, chars: number): string => [...text.trim()].slice(0, chars).join('').trim()

/**
 * The cards a results-fed board opens with. The phase is the one whose attachment names the file; a
 * Run that carries the file in both phases reads the phase that has answers for the step (post-work
 * when both do). Each text is cut to the card length and the list to what the board holds.
 */
export function resultsBoardSeed(input: ResultsSeedInput): ResultsSeed {
  const label = `${input.fileId}/${input.stepId}`
  const finding = (code: ResultsFindingCode, detail = label): ResultsSeed => ({ texts: [], phase: null, finding: { code, slideId: input.slideId, detail } })
  const attached = PHASES.filter((phase) => input.work?.[phase]?.fileId === input.fileId)
  if (!attached.length) return finding('results-file-not-attached')
  const sent = attached.filter((phase) => input.work?.[phase]?.pinned?.fileId === input.fileId)
  if (!sent.length) return finding('results-file-not-sent')
  const withStep = sent.filter((phase) => input.pinnedSteps[phase]?.includes(input.stepId))
  if (!withStep.length) return finding('results-step-missing')
  if (withStep.every((phase) => input.localSteps?.[phase]?.includes(input.stepId))) return finding('results-step-local')
  const phase = withStep.find((candidate) => preworkSeedTexts(input.answers[candidate], input.stepId).some((text) => text.trim())) ?? null
  if (!phase) return finding('results-no-answers')
  const chars = input.cardChars ?? BOARD_DEFAULTS.cardChars
  const texts = preworkSeedTexts(input.answers[phase], input.stepId).map((text) => cut(text, chars)).filter(Boolean)
  const fits = Math.min(seedCapacity(texts.map((text) => ({ column: '', text }))), BOARD_SEED_MAX)
  if (fits >= texts.length) return { texts, phase, finding: null }
  return { texts: texts.slice(0, fits), phase, finding: { code: 'results-over-cap', slideId: input.slideId, detail: `${label}:${texts.length}:${fits}` } }
}

// ── Authoring time ──────────────────────────────────────────────────────────────────────────

export type ResultsAuthoringCode = 'results-work-unknown' | 'results-work-step-unknown' | 'results-work-step-local'

export interface ResultsAuthoringFinding { code: ResultsAuthoringCode; slideId: string; detail: string }

/**
 * What is wrong with the work-file feeds of a talk before any Run exists, read against the work files
 * in the vault NOW (`files`: file id to its current step ids). A Run still reads its pinned revision;
 * this only tells the author the name does not resolve today. Feeds with no `fileId` are the talk's
 * own pre-work steps and are not looked at.
 */
export function resultsAuthoringFindings(
  feeds: ReadonlyArray<{ fileId?: string; stepId: string; slideId: string }> | null | undefined,
  files: Readonly<Record<string, readonly string[]>>,
  /** File id to its current Local only step ids: a feed naming one shows nothing. */
  localSteps: Readonly<Record<string, readonly string[]>> = {}
): ResultsAuthoringFinding[] {
  const out: ResultsAuthoringFinding[] = []
  for (const feed of feeds ?? []) {
    if (!feed.fileId) continue
    const steps = Object.hasOwn(files, feed.fileId) ? files[feed.fileId] : null
    if (!steps) out.push({ code: 'results-work-unknown', slideId: feed.slideId, detail: feed.fileId })
    else if (!steps.includes(feed.stepId)) out.push({ code: 'results-work-step-unknown', slideId: feed.slideId, detail: `${feed.fileId}:${feed.stepId}` })
    else if (Object.hasOwn(localSteps, feed.fileId) && localSteps[feed.fileId].includes(feed.stepId)) {
      out.push({ code: 'results-work-step-local', slideId: feed.slideId, detail: `${feed.fileId}:${feed.stepId}` })
    }
  }
  return out
}
