// The Run page's reading of a Run's pre-work (feedback-boards ticket 11; drawings round-3 R2–R5).
// Pure: the pre-work definition (from the talk's outline) and the Run's mirrored entries in, plain
// numbers and lists out. Nothing here writes; nothing here knows Electron.
//
// Counts, not names: a participant is only ever a hash, and a name appears only where someone typed
// one on a question. The quick check's right answer comes from the outline and is shown to the
// author only; it is never part of anything sent to participants (run-prework.ts publicPreworkForm).
import type { PreworkDefinition, PreworkFeed, PreworkStep } from '../../compiler/scripts/lib/prework.mjs'
import { seedCapacity } from '../../worker/board-state.ts'
import type { PreworkPick, RunPrework, RunPreworkEntry } from './run-prework'

export type { PreworkDefinition, PreworkFeed, PreworkStep }

const answerEntries = (prework: RunPrework | null | undefined, stepId: string): RunPreworkEntry[] =>
  (prework?.entries ?? []).filter((entry) => entry.kind === 'answer' && entry.stepId === stepId)

/** The people who took part: the Worker's count at the last pull, or the people the entries name, whichever is more. */
export function startedCount(prework: RunPrework | null | undefined): number {
  const seen = new Set((prework?.entries ?? []).map((entry) => entry.participant))
  return Math.max(prework?.people ?? 0, seen.size)
}

/** Whether an entry finishes its step for a participant (a read, an answer, or a task marked done). */
function completes(step: PreworkStep, entry: RunPreworkEntry): boolean {
  if (entry.stepId !== step.id) return false
  if (step.kind === 'slide') return entry.kind === 'read' || entry.kind === 'answer'
  if (step.kind === 'task') return step.done === false ? entry.kind === 'read' || entry.kind === 'done' : entry.kind === 'done' && entry.done === true
  return entry.kind === 'answer'
}

export interface StepProgress {
  step: PreworkStep
  /** People who read a slide, answered a question or check, or marked a task done. */
  count: number
  /** Questions people asked about the step, and how many are still to answer. */
  asked: number
  toAnswer: number
  /** A quick check: how many of the answers are the right one. */
  rightCount?: number
}

export interface PreworkOverview {
  started: number
  expected: number | null
  /** People who finished every step. */
  finished: number
  steps: StepProgress[]
  /** Tasks marked done, per task, and the sum of people who did so across tasks. */
  tasks: Array<{ step: PreworkStep; done: number }>
  questions: { total: number; toAnswer: number; steps: number }
  /** People starting per day, oldest first (a person counts on the day of their first entry). */
  perDay: Array<{ day: string; count: number }>
  lastActivityAt: number | null
}

/** `YYYY-MM-DD` of a time in the machine's own zone. */
export function dayOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** The option index a compiled option id stands for (`…-option-3` is index 2), or -1. */
export function optionIndexOf(optionId: string): number {
  const match = /-option-(\d+)$/.exec(optionId)
  return match ? Number(match[1]) - 1 : -1
}

/** The quick check's chosen option index in an entry (single choice), or -1. */
function chosenIndex(entry: RunPreworkEntry): number {
  return typeof entry.choice === 'string' ? optionIndexOf(entry.choice) : -1
}

export function preworkOverview(definition: PreworkDefinition, prework: RunPrework | null | undefined, expected?: number): PreworkOverview {
  const entries = prework?.entries ?? []
  const steps: StepProgress[] = definition.steps.map((step) => {
    const done = new Set(entries.filter((entry) => completes(step, entry)).map((entry) => entry.participant))
    const questions = entries.filter((entry) => entry.kind === 'question' && entry.stepId === step.id)
    const progress: StepProgress = { step, count: done.size, asked: questions.length, toAnswer: questions.filter((entry) => !entry.answered).length }
    if (step.kind === 'check' && step.right) {
      progress.rightCount = answerEntries(prework, step.id).filter((entry) => chosenIndex(entry) === step.right!.index).length
    }
    return progress
  })
  const people = new Set(entries.map((entry) => entry.participant))
  const finished = definition.steps.length === 0 ? 0 : [...people].filter((person) => definition.steps.every((step) =>
    entries.some((entry) => entry.participant === person && completes(step, entry)))).length
  const firstSeen = new Map<string, number>()
  for (const entry of entries) firstSeen.set(entry.participant, Math.min(firstSeen.get(entry.participant) ?? Infinity, entry.at))
  const days = new Map<string, number>()
  for (const at of firstSeen.values()) days.set(dayOf(at), (days.get(dayOf(at)) ?? 0) + 1)
  const questions = entries.filter((entry) => entry.kind === 'question')
  return {
    started: startedCount(prework),
    expected: expected && expected > 0 ? expected : null,
    finished,
    steps,
    tasks: steps.filter((progress) => progress.step.kind === 'task').map((progress) => ({ step: progress.step, done: progress.count })),
    questions: { total: questions.length, toAnswer: questions.filter((entry) => !entry.answered).length, steps: new Set(questions.map((entry) => entry.stepId)).size },
    perDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
    lastActivityAt: prework?.lastActivityAt ?? (entries.length ? Math.max(...entries.map((entry) => entry.at)) : null),
  }
}

// ── Open questions: every answer, stars ─────────────────────────────────────────────────────

export interface AnswerRow {
  /** The entry id that stands for the row (a starred row is picked by it). */
  id: string
  text: string
  at: number
  /** Entry ids of every answer with the same text (this row included); one when nothing is grouped. */
  ids: string[]
  picked: boolean
}

const sameText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** The text answers to an open question, oldest first, optionally with identical answers merged into one row. */
export function answerRows(prework: RunPrework | null | undefined, stepId: string, options: { group?: boolean; query?: string } = {}): AnswerRow[] {
  const pick = prework?.picks?.[stepId]
  const picked = new Set(pick?.mode === 'picked' ? pick.ids : [])
  const answers = answerEntries(prework, stepId).filter((entry) => typeof entry.text === 'string' && entry.text.trim())
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const rows: AnswerRow[] = []
  const byText = new Map<string, AnswerRow>()
  for (const entry of answers) {
    const text = entry.text as string
    const key = sameText(text)
    const existing = options.group ? byText.get(key) : undefined
    if (existing) {
      existing.ids.push(entry.id)
      existing.picked ||= picked.has(entry.id)
      continue
    }
    const row: AnswerRow = { id: entry.id, text, at: entry.at, ids: [entry.id], picked: picked.has(entry.id) }
    rows.push(row)
    if (options.group) byText.set(key, row)
  }
  const query = options.query?.trim().toLowerCase()
  return query ? rows.filter((row) => row.text.toLowerCase().includes(query)) : rows
}

/** The mode a step's board opens with: every answer until something is starred. */
export function pickMode(prework: RunPrework | null | undefined, stepId: string): 'picked' | 'all' {
  return prework?.picks?.[stepId]?.mode ?? 'all'
}

/** The starred answers of a step, in the order they will open on the board. */
export function pickedAnswers(prework: RunPrework | null | undefined, stepId: string): Array<{ id: string; text: string }> {
  const pick = prework?.picks?.[stepId]
  if (!pick || pick.mode !== 'picked') return []
  const byId = new Map(answerEntries(prework, stepId).map((entry) => [entry.id, entry]))
  return pick.ids.flatMap((id) => {
    const entry = byId.get(id)
    return entry && typeof entry.text === 'string' && entry.text.trim() ? [{ id, text: entry.text }] : []
  })
}

/** Star or unstar an answer. Starring the first one switches the step to "Only the answers I pick". */
export function togglePick(prework: RunPrework | null | undefined, stepId: string, entryId: string): PreworkPick {
  const current = prework?.picks?.[stepId]
  const ids = current?.ids ?? []
  return { mode: 'picked', ids: ids.includes(entryId) ? ids.filter((id) => id !== entryId) : [...ids, entryId] }
}

/** Move a picked answer one place earlier (-1) or later (1) in the order the board takes them. */
export function movePick(pick: PreworkPick, entryId: string, by: -1 | 1): PreworkPick {
  const index = pick.ids.indexOf(entryId)
  const to = index + by
  if (index < 0 || to < 0 || to >= pick.ids.length) return pick
  const ids = [...pick.ids]
  ;[ids[index], ids[to]] = [ids[to], ids[index]]
  return { ...pick, ids }
}

/**
 * The texts a step's board slide opens with: the picked answers in pick order, or every answer
 * (oldest first) when the Run page says so. Empty when the step has no text answers or nothing is
 * picked in "Only the answers I pick".
 */
export function preworkSeedTexts(prework: RunPrework | null | undefined, stepId: string): string[] {
  if (pickMode(prework, stepId) === 'picked') return pickedAnswers(prework, stepId).map((answer) => answer.text)
  return answerRows(prework, stepId).map((row) => row.text)
}

// ── The quick check ────────────────────────────────────────────────────────────────────────

export interface CheckOptionRow { index: number; label: string; count: number; percent: number; right: boolean }

export interface CheckSummary {
  answered: number
  options: CheckOptionRow[]
  /** A right answer is marked in the outline. */
  hasRight: boolean
  rightCount: number
  rightPercent: number
  /** The wrong answer most people chose, when any was chosen. */
  commonWrong: CheckOptionRow | null
}

export function checkSummary(step: PreworkStep, prework: RunPrework | null | undefined): CheckSummary {
  const labels = step.options ?? []
  const counts = labels.map(() => 0)
  let answered = 0
  for (const entry of answerEntries(prework, step.id)) {
    const index = chosenIndex(entry)
    if (index < 0 || index >= labels.length) continue
    counts[index] += 1
    answered += 1
  }
  const percent = (count: number) => answered ? Math.round((count / answered) * 100) : 0
  const options = labels.map((label, index) => ({ index, label, count: counts[index], percent: percent(counts[index]), right: step.right?.index === index }))
  const rightCount = step.right ? counts[step.right.index] ?? 0 : 0
  const wrong = options.filter((option) => !option.right && option.count > 0).sort((a, b) => b.count - a.count || a.index - b.index)
  return { answered, options, hasRight: Boolean(step.right), rightCount, rightPercent: percent(rightCount), commonWrong: wrong[0] ?? null }
}

// ── Questions about steps ──────────────────────────────────────────────────────────────────

export interface StepQuestion {
  id: string
  stepId: string
  text: string
  name?: string
  at: number
  answered: boolean
  inTalk: boolean
}

export type QuestionFilter = 'all' | 'to-answer' | 'answered' | 'in-talk'

export interface QuestionGroup { stepId: string; step: PreworkStep | null; questions: StepQuestion[] }

/** Questions grouped by step, in the order of the form's steps; within a step the newest is last. */
export function questionGroups(definition: PreworkDefinition, prework: RunPrework | null | undefined, filter: QuestionFilter = 'all'): QuestionGroup[] {
  const questions = (prework?.entries ?? []).filter((entry) => entry.kind === 'question' && typeof entry.text === 'string')
    .map((entry): StepQuestion => ({ id: entry.id, stepId: entry.stepId, text: entry.text as string, ...(entry.name ? { name: entry.name } : {}),
      at: entry.at, answered: entry.answered === true, inTalk: entry.inTalk !== undefined }))
    .filter((question) => filter === 'all' || (filter === 'to-answer' ? !question.answered : filter === 'answered' ? question.answered : question.inTalk))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const order = new Map(definition.steps.map((step, index) => [step.id, index]))
  const byStep = new Map<string, StepQuestion[]>()
  for (const question of questions) byStep.set(question.stepId, [...(byStep.get(question.stepId) ?? []), question])
  return [...byStep.entries()]
    .sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
    .map(([stepId, list]) => ({ stepId, step: definition.steps.find((step) => step.id === stepId) ?? null, questions: list }))
}

export function questionCounts(definition: PreworkDefinition, prework: RunPrework | null | undefined): Record<QuestionFilter, number> {
  const count = (filter: QuestionFilter) => questionGroups(definition, prework, filter).reduce((sum, group) => sum + group.questions.length, 0)
  return { all: count('all'), 'to-answer': count('to-answer'), answered: count('answered'), 'in-talk': count('in-talk') }
}

// ── The slide a step feeds ─────────────────────────────────────────────────────────────────

/**
 * A board slide of the talk that takes a step's answers (`{results=<step id>}` on a board slide).
 * The list comes from the compiler's own model (`model.prework.feeds`), so `slideId` is the id the
 * compiled deck and the live session use, however the outline repeats titles. Nothing here derives one.
 */
export type FedSlide = PreworkFeed

export const feedsForStep = (feeds: readonly PreworkFeed[] | null | undefined, stepId: string): FedSlide[] => (feeds ?? []).filter((feed) => feed.stepId === stepId)

/** The step a board slide (by its compiled id) is fed by, or null. */
export function stepFeedingSlide(feeds: readonly PreworkFeed[] | null | undefined, slideId: string): string | null {
  return (feeds ?? []).find((feed) => feed.slideId === slideId)?.stepId ?? null
}

// ── Picks: one change at a time ────────────────────────────────────────────────────────────

/** One change to a step's picks, applied by the main process to a fresh read of the Run. */
export type PickChange =
  | { type: 'toggle'; id: string }
  | { type: 'move'; id: string; by: -1 | 1 }
  | { type: 'mode'; mode: 'picked' | 'all' }

/** The step's picks after one change. Two quick clicks are two changes, each on the Run as it then is. */
export function applyPickChange(prework: RunPrework | null | undefined, stepId: string, change: PickChange): PreworkPick {
  const current = prework?.picks?.[stepId] ?? { mode: 'all' as const, ids: [] }
  if (change.type === 'toggle') return togglePick(prework, stepId, change.id)
  if (change.type === 'move') return movePick(current, change.id, change.by)
  return { mode: change.mode, ids: current.ids }
}

/** The seed a step's board would open with, and how many of its cards the board can hold (the rest are left off). */
export function seedPlan(prework: RunPrework | null | undefined, stepId: string): { texts: string[]; fits: number } {
  const texts = preworkSeedTexts(prework, stepId)
  return { texts, fits: seedCapacity(texts.map((text) => ({ column: '', text }))) }
}
