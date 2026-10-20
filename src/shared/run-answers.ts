// What the Run page's answer sections show (work-files-and-sessions ticket 18; locked mockup S4).
// Pure: a phase's steps (from the attached work file, or from the talk's `{prework}` section for a Run
// that predates work files) and the Run's mirrored answers for that phase in; one section model out:
// the header numbers, then per step a summary line and the body its poll type calls for.
//
//   read / watch / task   a count only ("watched by 6 of 7")
//   quick check, single,  the spread over its options, the quick check's right answer marked
//   multiple, ranking,    (author only), other choices labelled by option number
//   rating, categories
//   open, board, other    every text answer, oldest first, each with a star
//
// Counting is run-prework-results.ts's (started, per-step completion, questions); nothing here re-derives
// it. Untrusted text is carried as strings for the renderer to show as text.
import type { PreworkDefinition, PreworkStep } from '../../compiler/scripts/lib/prework.mjs'
import { preworkFromOutline } from '../../compiler/scripts/lib/prework.mjs'
import { readWorkFile } from './work-file.ts'
import { answerRows, optionIndexOf, preworkOverview, questionGroups, checkSummary, type AnswerRow, type StepQuestion } from './run-prework-results.ts'
import type { RunPrework, RunPreworkEntry } from './run-prework.ts'

export type AnswerStepKind = 'video' | 'slide' | 'check' | 'question' | 'task'

/** A step as the answer sections need it: plain data that crosses to the window. */
export interface AnswerStep {
  id: string
  n: number
  title: string
  kind: AnswerStepKind
  pollType?: string
  minutes?: number
  done?: boolean
  options?: string[]
  right?: { index: number; label: string } | null
  /** `{local}`: Local only, nothing about the step is sent (a task, quick check or question only). */
  local?: true
}

export interface PhaseSteps {
  /** Where the steps came from: the attached work file, or the talk's own `{prework}` section. */
  source: 'file' | 'outline'
  steps: AnswerStep[]
}

const CHOICE_POLLS = new Set(['single', 'multiple', 'ranking', 'rating', 'categorisation'])

/** One compiled or parsed step as the answer sections carry it; the optional fields are present only when the step has them. */
function toAnswerStep(step: Omit<AnswerStep, 'id' | 'n' | 'pollType' | 'local'> & { pollType?: string | null; local?: boolean }, id: string, n: number): AnswerStep {
  return {
    id, n, title: step.title, kind: step.kind,
    ...(step.pollType ? { pollType: step.pollType } : {}),
    ...(step.minutes !== undefined ? { minutes: step.minutes } : {}),
    ...(step.done !== undefined ? { done: step.done } : {}),
    ...(step.options ? { options: step.options } : {}),
    ...(step.right !== undefined ? { right: step.right } : {}),
    ...(step.local === true && step.kind !== 'slide' && step.kind !== 'video' ? { local: true as const } : {})
  }
}

/** The steps of a work file's text (steps whose id is not a plain name are left out: nothing can be filed under them). */
export function stepsFromWorkFile(text: string): AnswerStep[] {
  const steps: AnswerStep[] = []
  for (const step of readWorkFile(text).definition.steps) {
    if (step.id) steps.push(toAnswerStep(step, step.id, steps.length + 1))
  }
  return steps
}

/** The steps of a talk's `{prework}` section (a Run made before work files). Empty when it has none. */
export function stepsFromOutline(markdown: string): AnswerStep[] {
  return (preworkFromOutline(markdown)?.steps ?? []).map((step) => toAnswerStep(step, step.id, step.n))
}

/** The shape the counting module reads: a video is a slide that is watched. */
function asDefinition(steps: readonly AnswerStep[]): PreworkDefinition {
  return {
    sectionId: '', title: '', intro: '', sourceLine: null,
    steps: steps.map((step): PreworkStep => ({
      ...step, kind: step.kind === 'video' ? 'slide' : step.kind, questions: true, sourceLine: null
    }))
  }
}

export interface SpreadRow { key: string; label: string; count: number; percent: number; right: boolean }

export interface StarRow extends AnswerRow {
  starred: boolean
  /** Arrived since the presenter last looked, or kept unread by its dot. */
  isNew: boolean
}

export type StepBody =
  | { type: 'count' }
  | { type: 'spread'; answered: number; rows: SpreadRow[] }
  | { type: 'answers'; rows: StarRow[] }
  /** `{local}`: nothing about the step reaches the speaker, so there is nothing to show. */
  | { type: 'local' }

/** Where a step's answers go, as the Run page tags it: Sent to you, Local only, or (slide, video) a bare count. */
export type StepRoute = 'sent' | 'local' | 'counts'

export interface StepBlock {
  id: string
  n: number
  kind: AnswerStepKind
  /** The kind in words: "Video", "Quick check", "Task", "Open question", "Rating", "Question", "Slide". */
  label: string
  /** The step's own title, or "6 min" for a video or task with a time. */
  title: string
  /** Right-hand summary: "watched by 6 of 7", "7 answers", "12 completed". */
  sum: string
  body: StepBody
  /** Questions people asked about the step, oldest first. */
  questions: StepQuestion[]
  route: StepRoute
  /** New responses on the step: its answers and the questions asked about it. */
  fresh: number
  /** Ids of the questions about the step that are new. */
  newQuestions: string[]
}

export interface AnswerSection {
  /** People who took part, and the people expected (null when the Run has no number). */
  answered: number
  expected: number | null
  /** 0 to 100, for the 64px bar. */
  percent: number
  /** Starred answers across the section's steps. */
  starred: number
  /** Questions still to answer, across steps. */
  toAnswer: number
  /** New responses across the section (answers and questions since the presenter last looked). */
  fresh: number
  /** Steps marked Local only, and steps that take an answer or a tick (not slides or videos). */
  localSteps: number
  answerSteps: number
  steps: StepBlock[]
}

// ── Read state (2026-10-19 prework-responses, decision 14) ───────────────────────────────────────
// A response is an answer or a question; reads and done marks are progress, never "new". One is new when
// its time is later than the Run's seen-through mark, or the presenter kept it unread by its dot.

type ReadState = Pick<RunPrework, 'entries' | 'seen' | 'unread'>

export function isResponse(entry: Pick<RunPreworkEntry, 'kind'>): boolean {
  return entry.kind === 'answer' || entry.kind === 'question'
}

/** Whether an entry is new to the presenter. */
export function isNewEntry(entry: Pick<RunPreworkEntry, 'id' | 'kind' | 'at'>, prework: Pick<RunPrework, 'seen' | 'unread'> | null | undefined): boolean {
  if (!isResponse(entry)) return false
  if (prework?.unread?.includes(entry.id)) return true
  return entry.at > (prework?.seen?.through ?? -1)
}

/** New responses on the Run's phase. */
export function newResponseCount(prework: ReadState | null | undefined): number {
  return (prework?.entries ?? []).filter((entry) => isNewEntry(entry, prework)).length
}

/** The latest response time on the phase: what "seen through" moves to. */
export function latestResponseAt(prework: Pick<RunPrework, 'entries'> | null | undefined): number {
  let latest = 0
  for (const entry of prework?.entries ?? []) if (isResponse(entry) && entry.at > latest) latest = entry.at
  return latest
}

/** A change to the read state, as the Run page asks for it. */
export type SeenChange = { type: 'leave' } | { type: 'all' } | { type: 'keep'; id: string; unread: boolean }

/**
 * The phase's pre-work with its read state changed. Leaving the Run moves the seen-through mark to the
 * latest response and keeps the rows kept unread; Mark all read also clears those; a dot keeps one
 * response unread (or lets it go). `at` is now on this machine. Null when nothing changes.
 */
export function applySeenChange(prework: RunPrework, change: SeenChange, at: number): RunPrework | null {
  const ids = new Set(prework.entries.filter(isResponse).map((entry) => entry.id))
  const unread = (prework.unread ?? []).filter((id) => ids.has(id))
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, index) => id === b[index])
  if (change.type === 'keep') {
    if (!ids.has(change.id)) return null
    const next = change.unread ? [...new Set([...unread, change.id])] : unread.filter((id) => id !== change.id)
    return same(next, prework.unread ?? []) ? null : { ...prework, unread: next.length ? next : undefined }
  }
  const through = Math.max(latestResponseAt(prework), prework.seen?.through ?? 0)
  const keep = change.type === 'leave' ? unread : []
  if (prework.seen?.through === through && same(keep, prework.unread ?? [])) return null
  if (!ids.size && !prework.seen) return null
  return { ...prework, seen: { through, at }, unread: keep.length ? keep : undefined }
}

// ── Copy and Export (decision 15) ─────────────────────────────────────────────────────────────────
// Built from the section as the page shows it: step, text, time, starred, read. Never an entry id (its
// first part stands for the participant) and never a name, except the one a person typed on a question.

const iso = (ms: number): string => new Date(ms).toISOString()
const stepName = (block: StepBlock): string => `${block.n} · ${block.label}${block.title ? `: ${block.title}` : ''}`

/** Every text answer in the section, one per line under its step; `starredOnly` keeps the starred ones. */
export function answersText(section: Pick<AnswerSection, 'steps'>, starredOnly = false): string {
  const parts: string[] = []
  for (const block of section.steps) {
    if (block.body.type !== 'answers') continue
    const rows = block.body.rows.filter((row) => !starredOnly || row.starred)
    if (!rows.length) continue
    parts.push([stepName(block), ...rows.map((row) => row.text.replace(/\s+/g, ' ').trim())].join('\n'))
  }
  return parts.join('\n\n')
}

/** How many answers `answersText(section, true)` copies. */
export function starredCount(section: Pick<AnswerSection, 'steps'>): number {
  return section.steps.reduce((sum, block) => sum + (block.body.type === 'answers' ? block.body.rows.filter((row) => row.starred).length : 0), 0)
}

/** One CSV field: quoted, and a leading = + - @ made inert so a spreadsheet does not run it. */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/g, '""')}"`
}

/** The section as CSV: step, kind, answer, time, starred, read, name (a question's own, else empty). No participant ids. */
export function answersCsv(section: Pick<AnswerSection, 'steps'>): string {
  const lines = [['step', 'kind', 'answer', 'time', 'starred', 'read', 'name'].join(',')]
  for (const block of section.steps) {
    const step = stepName(block)
    if (block.body.type === 'answers') {
      for (const row of block.body.rows) lines.push([step, 'answer', row.text, iso(row.at), row.starred ? 'yes' : 'no', row.isNew ? 'no' : 'yes', ''].map(csvField).join(','))
    } else if (block.body.type === 'spread') {
      for (const row of block.body.rows) lines.push([step, 'choice', `${row.label}: ${row.count} of ${block.body.answered}`, '', 'no', 'yes', ''].map(csvField).join(','))
    }
    const fresh = new Set(block.newQuestions)
    for (const question of block.questions) {
      lines.push([step, 'question', question.text, iso(question.at), 'no', fresh.has(question.id) ? 'no' : 'yes', question.name ?? ''].map(csvField).join(','))
    }
  }
  return lines.join('\r\n') + '\r\n'
}

/** The section as Markdown, grouped per step, for notes or a slide. No participant ids. */
export function answersMarkdown(section: Pick<AnswerSection, 'steps'>, title: string): string {
  const out = [`# ${title}`]
  const line = (text: string): string => text.replace(/\s+/g, ' ').trim()
  for (const block of section.steps) {
    out.push('', `## ${stepName(block)}`, '')
    if (block.body.type === 'local') out.push('Local only: nothing is collected for this step.')
    else if (block.body.type === 'count') out.push(block.sum)
    else if (block.body.type === 'spread') {
      if (!block.body.rows.length) out.push('No answers.')
      for (const row of block.body.rows) out.push(`- ${line(row.label)}: ${row.count} of ${block.body.answered}`)
    } else {
      if (!block.body.rows.length) out.push('No answers.')
      for (const row of block.body.rows) out.push(`- ${row.starred ? '★ ' : ''}${line(row.text)}`)
    }
    if (block.questions.length) {
      out.push('', 'Questions about this step:', '')
      for (const question of block.questions) out.push(`- ${line(question.text)}${question.name ? ` (${line(question.name)})` : ''}`)
    }
  }
  return out.join('\n') + '\n'
}


const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function kindLabel(step: AnswerStep): string {
  if (step.kind === 'video') return 'Video'
  if (step.kind === 'slide') return 'Slide'
  if (step.kind === 'check') return 'Quick check'
  if (step.kind === 'task') return 'Task'
  if (step.pollType === 'open') return 'Open question'
  if (step.pollType === 'rating') return 'Rating'
  if (step.pollType === 'board') return 'Board'
  return 'Question'
}

/** The option keys one answer chose: one for a single choice, each for a multiple or ranking, each label for a rating or categories. */
function choiceKeys(entry: RunPreworkEntry): string[] {
  const choice = entry.choice
  if (typeof choice === 'string') return [choice]
  if (Array.isArray(choice)) return choice.filter((value): value is string => typeof value === 'string')
  if (choice && typeof choice === 'object') return Object.values(choice).filter((value): value is string => typeof value === 'string')
  return []
}

/** The spread of a choice question over what people chose. Labels come from the file where it lists options, else "Option N". */
function choiceSpread(step: AnswerStep, prework: RunPrework | null | undefined): { answered: number; rows: SpreadRow[] } {
  const entries = (prework?.entries ?? []).filter((entry) => entry.kind === 'answer' && entry.stepId === step.id && entry.choice !== undefined)
  const counts = new Map<string, number>()
  for (const entry of entries) for (const key of new Set(choiceKeys(entry))) counts.set(key, (counts.get(key) ?? 0) + 1)
  const answered = entries.length
  const rows = [...counts.entries()].map(([key, count]) => {
    // `…-option-3` is the third option; a rating's or categories' `…-label-4` is the fourth label of its scale.
    const labelled = /-label-(\d+)$/.exec(key)
    const index = optionIndexOf(key) >= 0 ? optionIndexOf(key) : labelled ? Number(labelled[1]) - 1 : -1
    const label = index >= 0 ? (labelled ? `Label ${index + 1}` : step.options?.[index] ?? `Option ${index + 1}`) : key.length > 60 ? `${key.slice(0, 57)}…` : key
    return { key, index, label, count, percent: answered ? Math.round((count / answered) * 100) : 0, right: false }
  }).sort((a, b) => (a.index < 0 ? Infinity : a.index) - (b.index < 0 ? Infinity : b.index) || a.key.localeCompare(b.key))
  return { answered, rows: rows.map(({ index: _index, ...row }) => row) }
}

/** One phase's section: header numbers and a block per step. */
export function answerSection(steps: readonly AnswerStep[], prework: RunPrework | null | undefined, expected?: number | null): AnswerSection {
  const definition = asDefinition(steps)
  const overview = preworkOverview(definition, prework, expected ?? undefined)
  const asked = new Map(questionGroups(definition, prework).map((group) => [group.stepId, group.questions]))
  const fresh = new Set((prework?.entries ?? []).filter((entry) => isNewEntry(entry, prework)).map((entry) => entry.id))
  let starred = 0
  const blocks = steps.map((step, index): StepBlock => {
    const progress = overview.steps[index]
    const questions = asked.get(step.id) ?? []
    const newQuestions = questions.filter((question) => fresh.has(question.id)).map((question) => question.id)
    const freshAnswers = (prework?.entries ?? []).filter((entry) => entry.kind === 'answer' && entry.stepId === step.id && fresh.has(entry.id)).length
    const route: StepRoute = step.kind === 'slide' || step.kind === 'video' ? 'counts' : step.local ? 'local' : 'sent'
    const base = { id: step.id, n: step.n, kind: step.kind, label: kindLabel(step), questions, route, fresh: freshAnswers + newQuestions.length, newQuestions }
    if (route === 'local') return { ...base, title: step.title, sum: 'not collected', body: { type: 'local' } }
    const minutes = step.minutes !== undefined && (step.kind === 'task' || step.kind === 'video') ? `${step.minutes} min` : ''
    const title = step.title
    if (step.kind === 'check') {
      const summary = checkSummary(definition.steps[index], prework)
      return {
        ...base, title, sum: `${summary.answered} completed`,
        body: { type: 'spread', answered: summary.answered, rows: summary.options.map((option) => ({ key: String(option.index), label: option.label, count: option.count, percent: option.percent, right: option.right })) }
      }
    }
    if (step.kind === 'question' && step.pollType && CHOICE_POLLS.has(step.pollType)) {
      const spread = choiceSpread(step, prework)
      return { ...base, title, sum: plural(spread.answered, 'answer'), body: { type: 'spread', ...spread } }
    }
    if (step.kind === 'question') {
      const pick = prework?.picks?.[step.id]
      const chosen = new Set(pick?.ids ?? [])
      const rows = answerRows(prework, step.id).map((row) => ({ ...row, starred: chosen.has(row.id), isNew: row.ids.some((id) => fresh.has(id)) }))
      starred += rows.filter((row) => row.starred).length
      return { ...base, title, sum: plural(rows.length, 'answer'), body: { type: 'answers', rows } }
    }
    const started = overview.started
    const sum = step.kind === 'video' ? `watched by ${progress.count} of ${started}`
      : step.kind === 'task' ? `${progress.count} marked done` + (started ? ` of ${started}` : '')
        : `read by ${progress.count} of ${started}`
    return { ...base, title: minutes ? `${title} · ${minutes}` : title, sum, body: { type: 'count' } }
  })
  const answered = overview.started
  const percent = expected && expected > 0 ? Math.min(100, Math.round((answered / expected) * 100)) : answered > 0 ? 100 : 0
  const answerSteps = steps.filter((step) => step.kind !== 'slide' && step.kind !== 'video')
  return {
    answered, expected: expected && expected > 0 ? expected : null, percent, starred, toAnswer: overview.questions.toAnswer,
    fresh: fresh.size, localSteps: answerSteps.filter((step) => step.local).length, answerSteps: answerSteps.length, steps: blocks
  }
}

/** "7/18 answered", or "7 answered" when the Run has no number expected. */
export function answeredText(section: Pick<AnswerSection, 'answered' | 'expected'>): string {
  return `${section.answered}${section.expected ? `/${section.expected}` : ''} answered`
}

/**
 * Whether a phase's section starts folded: while post-work is open, the pre-work section starts folded
 * (amendment 2). `postOpen` is the Run checklist's phase `post-open`.
 */
export function startsFolded(phase: 'pre' | 'post', hasPost: boolean, postOpen: boolean): boolean {
  return phase === 'pre' && hasPost && postOpen
}
