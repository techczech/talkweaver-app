// What the Run page needs on top of the Run checklist (work-files-and-sessions ticket 10): how a work file
// reads as a checklist file state, what each checklist action does, and the checklist for one Run.
// Pure: no Electron, no fs, no clock (`now` is passed). The states themselves come from run-checklist.ts;
// nothing here re-derives one.
import { answersKept, runChecklist, type ActionId, type ChecklistOptions, type RunChecklist, type WorkFileState } from './run-checklist.ts'
import { readWorkFile, type WorkFileFinding } from './work-file.ts'
import type { SessionSource } from './sessions-list.ts'
import type { Phase } from './run-work.ts'

/** What an action does. `null` (see runActionEffect) means it is not wired yet. */
export type RunPageEffect =
  | { kind: 'plan-sheet' }
  /** The Run page header's "Plan the next run like this" (not a checklist action). */
  | { kind: 'plan-like-this' }
  | { kind: 'open-work-file'; phase: Phase }
  | { kind: 'go-live' }
  | { kind: 'open-live-view' }
  | { kind: 'open-results' }
  | { kind: 'mark-delivered' }
  | { kind: 'publish' }
  | { kind: 'preview-page' }

const EFFECTS: Partial<Record<ActionId, RunPageEffect>> = {
  'edit-plan': { kind: 'plan-sheet' },
  'change-pre-time': { kind: 'plan-sheet' },
  'change-post-time': { kind: 'plan-sheet' },
  'open-pre-file': { kind: 'open-work-file', phase: 'pre' },
  'open-post-file': { kind: 'open-work-file', phase: 'post' },
  'go-live': { kind: 'go-live' },
  'open-live-view': { kind: 'open-live-view' },
  'open-results': { kind: 'open-results' },
  'mark-delivered': { kind: 'mark-delivered' },
  publish: { kind: 'publish' },
  'publish-again': { kind: 'publish' },
  'preview-page': { kind: 'preview-page' }
}

/** The effect of a checklist action, or null for one no feature wires yet. */
export function runActionEffect(id: ActionId): RunPageEffect | null {
  return EFFECTS[id] ?? null
}

/** A blocking finding in words, for the "Pre-work ready" step. */
export function findingText(finding: WorkFileFinding): string {
  const at = finding.stepId ? `Step “${finding.stepId}”` : 'The file'
  switch (finding.code) {
    case 'work-file-id-missing': return 'The file has no id'
    case 'work-file-id-invalid': return 'The file id is not a plain name'
    case 'work-file-title-missing': return 'The file has no title'
    case 'work-file-revision-invalid': return 'The file revision is not a whole number'
    case 'work-file-no-steps': return 'The file has no steps'
    case 'work-file-step-level': return `${at} is at the wrong heading level`
    case 'work-file-step-id-missing': return `A step has no id${finding.line ? ` (line ${finding.line})` : ''}`
    case 'work-file-step-id-invalid': return `${at} has an id that is not a plain name`
    case 'work-file-step-id-duplicate': return `Two steps share the id “${finding.detail}”`
    case 'work-file-layout-unsupported': return `${at} uses a layout work files cannot show${finding.detail ? ` (${finding.detail})` : ''}`
    case 'work-file-h1-unsupported': return `The file has a # heading${finding.line ? ` on line ${finding.line}` : ''}`
    case 'work-file-poll-unknown': return `${at} names a question type that does not exist`
    default: return `${at} has a problem${finding.line ? ` on line ${finding.line}` : ''}`
  }
}

/** A work file's text as the checklist reads it: its title, its step count and its first blocking finding. */
export function workFileState(text: string): WorkFileState {
  const reading = readWorkFile(text)
  const blocking = reading.findings.find((finding) => finding.severity === 'blocking')
  return {
    title: reading.definition.title || reading.definition.id || 'Untitled',
    steps: reading.definition.steps.length,
    ...(blocking ? { blocking: findingText(blocking) } : {})
  }
}

/** The Run page's checklist for one Run of the Sessions list. */
export function runPageChecklist(source: SessionSource, now: Date, options: Pick<ChecklistOptions, 'live' | 'liveSince' | 'files' | 'publishing'> = {}): RunChecklist {
  return runChecklist(source, now, { ...options, answers: source.answers })
}

/**
 * The Unpublish confirmation (ticket 17; locked mockup state 12): its title and its one sentence. The pages
 * named are the ones the job will make "not available": the handout, and the pre-work and post-work pages of
 * `source.sent`, THE sent set main computed (run-unpublish.ts sentPhases, D1: the Run's stamps and the work
 * service's record), never read again from the attachments here. With nothing sent, the handout is taken
 * off the site (run-unpublish.ts, REMOVE).
 */
export function unpublishConfirmText(source: Pick<SessionSource, 'eventTitle' | 'talkTitle' | 'sent' | 'answers'>): { title: string; body: string } {
  const title = `Unpublish ${(source.eventTitle || source.talkTitle || 'this run').trim()}?`
  const pre = !!source.sent?.includes('pre')
  const post = !!source.sent?.includes('post')
  if (!pre && !post) return { title, body: 'The handout will be taken off the site.' }
  const pages = pre && post ? 'The handout, the pre-work page and the post-work page'
    : pre ? 'The handout and the pre-work page' : 'The handout and the post-work page'
  const kept = answersKept(source.answers)
  const answers = kept === 0 ? '' : kept === 1 ? ' The 1 answer is kept.' : ` The ${kept} answers are kept.`
  return { title, body: `${pages} will show \u201cThis page is not available\u201d.${answers}` }
}
