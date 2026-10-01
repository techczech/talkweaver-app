// The Inspector's "Before the session" section (ADR-0032 amendment point 5; round-2 E1–E4,
// round-3 P5; ticket 08): what it shows for the inspected slide, read from the outline with the
// compiler's own reader (prework.mjs), so the section and the compiled pre-work never disagree.
// Trigger-line settings write through the ordinary option commit (the registry's prework-* groups
// and the `{results=…}` group built here); the right answer writes the slide body through
// `applyRightAnswerToOutline`.
import {
  PREWORK_KIND_LABELS, preworkFromOutline, resultsSteps,
  type PreworkDefinition, type PreworkKind, type PreworkStep
} from '../../../../compiler/scripts/lib/prework.mjs'
import type { OptionGroup } from '../../../shared/layout-registry/entries.ts'
import { parseTriggerLine } from '../../../shared/trigger-line.ts'
import { preworkWindow, shortDate, dayAndTime, type PlanRunLike } from '../../../shared/plan-run.ts'

export { PREWORK_KIND_LABELS }

export type InspectorPreworkMode = 'section' | 'step' | 'results'

export interface InspectorPreworkModel {
  mode: InspectorPreworkMode
  definition: PreworkDefinition
  /** The inspected step (mode 'step'). */
  step: PreworkStep | null
  /** The chip in the Inspector's jump row. */
  chip: string
  /** The section's heading. */
  heading: string
  /** "This slide": what the slide is to participants. */
  thisSlide: string
  /** Mode 'results': the step the slide names, the steps it may name, and the group that writes it. */
  results: { stepId: string; step: PreworkStep | null; choices: PreworkStep[]; group: OptionGroup } | null
}

const POLL_TYPE_WORDS: Record<string, string> = {
  single: 'single choice', multiple: 'multiple choice', open: 'open answer', ranking: 'ranking',
  rating: 'rating', categorisation: 'categorisation', board: 'board'
}

function describeStep(step: PreworkStep, count: number): string {
  const where = `Step ${step.n} of ${count}`
  const notPresented = 'It is not presented in the talk.'
  switch (step.kind) {
    case 'check':
      return `${where}: a quick knowledge check. Participants choose one answer on the pre-work page and get no marks. ${notPresented}`
    case 'question':
      return `${where}: a question (${POLL_TYPE_WORDS[step.pollType ?? ''] ?? step.pollType}). Participants answer it on the pre-work page. ${notPresented}`
    case 'task':
      return `${where}: a pre-task. Participants read its list as the instructions${step.done ? ' and mark it done' : ''}. ${notPresented}`
    default:
      return `${where}: a slide with instructions. Participants read it on the pre-work page. ${notPresented}`
  }
}

/** "Before the session › 4 · What AI tools do you already use?" */
export function stepChoiceLabel(definition: PreworkDefinition, step: PreworkStep): string {
  return `${definition.title} › ${step.n} · ${step.title}`
}

function resultsTokenOf(triggerLine: string): string {
  const token = parseTriggerLine(triggerLine).find((candidate) => /^results=/.test(candidate.raw))
  return token ? token.raw.slice('results='.length).trim() : ''
}

/**
 * The `{results=…}` choosing group for a talk slide: one value per step whose answers a slide can
 * show, plus the slide's own value when it names no such step (so re-choosing replaces it).
 */
export function resultsGroup(definition: PreworkDefinition, current: string): OptionGroup {
  const values = resultsSteps(definition).map((step) => ({ token: `results=${step.id}`, label: stepChoiceLabel(definition, step) }))
  if (current && !values.some((value) => value.token === `results=${current}`)) {
    values.push({ token: `results=${current}`, label: `${current} (not a step)` })
  }
  return { key: 'prework-results', label: 'Shows', values, appliesTo: {} }
}

/**
 * The section for the inspected slide: the pre-work section itself, one of its steps, or a talk
 * slide carrying `{results=…}`; null for any other slide (or a talk without pre-work, unless the
 * slide names a step anyway). `headingLine` is the slide's 1-based outline line.
 */
export function inspectorPreworkModel(
  outline: string,
  headingLine: number | null,
  triggerLine: string,
  definition: PreworkDefinition | null = preworkFromOutline(outline)
): InspectorPreworkModel | null {
  if (headingLine == null) return null
  const resultsId = resultsTokenOf(triggerLine)
  if (definition && definition.sourceLine === headingLine) {
    return {
      mode: 'section', definition, step: null, chip: 'Pre-work', heading: 'Before the session',
      thisSlide: `The pre-work form: its introduction and ${definition.steps.length} ${definition.steps.length === 1 ? 'step' : 'steps'}. Participants see it at the top of the pre-work page. It is not presented in the talk.`,
      results: null
    }
  }
  const step = definition?.steps.find((candidate) => candidate.sourceLine === headingLine) ?? null
  if (definition && step) {
    const chip = step.kind === 'check' ? 'Check' : step.kind === 'task' ? 'Pre-task' : 'Pre-work'
    const heading = step.kind === 'check' ? 'Quick check' : step.kind === 'task' ? 'Pre-task' : 'Before the session'
    return { mode: 'step', definition, step, chip, heading, thisSlide: describeStep(step, definition.steps.length), results: null }
  }
  if (resultsId) {
    const form: PreworkDefinition = definition ?? { sectionId: '', title: 'Before the session', intro: '', sourceLine: null, steps: [] }
    const target = form.steps.find((candidate) => candidate.id === resultsId && candidate.kind !== 'slide') ?? null
    return {
      mode: 'results', definition: form, step: null, chip: 'Results', heading: 'Answers from pre-work',
      thisSlide: target
        ? `This talk slide shows the answers to step ${target.n}, “${target.title}”, given before the session.`
        : `This talk slide names “${resultsId}”, which is not a step of the talk’s pre-work.`,
      results: { stepId: resultsId, step: target, choices: resultsSteps(form), group: resultsGroup(form, resultsId) }
    }
  }
  return null
}

/** The step's kind for option applicability (prework-* groups); null when the slide is no step. */
export function preworkKindOf(model: InspectorPreworkModel | null): PreworkKind | null {
  return model?.mode === 'step' && model.step ? model.step.kind : null
}

// ── The form's Run (round-2 E1, round-3 P5) ─────────────────────────────────────────────────

export type PreworkRunLine =
  | { kind: 'window'; runId: string; opens: string; closes: string; run: string; closesAtStart: boolean }
  | { kind: 'no-window'; runId: string; run: string }
  | { kind: 'no-run' }

/**
 * What the form says about its planned Run: the next Run's pre-work window, a next Run that has
 * none, or none planned (the round-3 P5 nudge: nobody can reach the form).
 */
export function preworkRunLine(next: PlanRunLike | null): PreworkRunLine {
  if (!next) return { kind: 'no-run' }
  const run = `${next.eventTitle || 'Run'}, ${shortDate(next.plannedDate ?? '')}`
  const window = preworkWindow(next)
  if (!window) return { kind: 'no-window', runId: next.id, run }
  return { kind: 'window', runId: next.id, opens: dayAndTime(window.opens), closes: dayAndTime(window.closes), run, closesAtStart: !next.preworkCloses }
}
