// The Inspector's Results section for a talk slide carrying `{results=…}` (ADR-0040 Consequences:
// results slides name a step as work file + step id; work-files ticket 27). The 0.37 "Before the
// session" section (a talk's own `{prework}` section and its steps, written in the Inspector) is gone
// (work-files ticket 29, ADR-0040 decision 6): pre-work is written in a work file, and a talk that
// still has a `{prework}` section is offered "Move to a work file" by the Layout Doctor.
// The token is written through the ordinary option commit with the group built here.
import { parseResultsToken } from '../../../../compiler/scripts/lib/prework.mjs'
import type { OptionGroup } from '../../../shared/layout-registry/entries.ts'
import { parseTriggerLine } from '../../../shared/trigger-line.ts'

export interface InspectorPreworkModel {
  mode: 'results'
  /** The chip in the Inspector's jump row. */
  chip: string
  /** The section's heading. */
  heading: string
  /** "This slide": what the slide shows. */
  thisSlide: string
  /** The step the slide names (`<file id>/<step id>`, or an old section step id) and the group that writes it. */
  results: { stepId: string; workFile: boolean; group: OptionGroup }
}

function resultsTokenOf(triggerLine: string): string {
  const token = parseTriggerLine(triggerLine).find((candidate) => /^results=/.test(candidate.raw))
  return token ? token.raw.slice('results='.length).trim() : ''
}

/**
 * The `{results=…}` group for a talk slide: the slide's own value, so the select shows it. No step
 * of a talk's `{prework}` section is offered as a choice: that section is no longer an entry point.
 */
export function resultsGroup(current: string): OptionGroup {
  const values = current
    ? [{ token: `results=${current}`, label: parseResultsToken(current)?.fileId ? `${current} (work file step)` : `${current} (old pre-work section step)` }]
    : []
  return { key: 'prework-results', label: 'Shows', values, appliesTo: {} }
}

/** The Results section for a talk slide that carries `{results=…}`; null for any other slide. */
export function inspectorPreworkModel(headingLine: number | null, triggerLine: string): InspectorPreworkModel | null {
  if (headingLine == null) return null
  const resultsId = resultsTokenOf(triggerLine)
  if (!resultsId) return null
  const workToken = parseResultsToken(resultsId)
  const workFile = Boolean(workToken?.fileId)
  return {
    mode: 'results', chip: 'Results', heading: 'Answers from pre-work',
    thisSlide: workFile
      ? `This talk slide shows the answers to step “${workToken!.stepId}” of the work file “${workToken!.fileId}”, from the Run it is presented for.`
      : `This talk slide names “${resultsId}”, a step of the talk’s old pre-work section. Move that section to a work file (Layout Doctor) and name the step as work file/step.`,
    results: { stepId: resultsId, workFile, group: resultsGroup(resultsId) }
  }
}
