export type PreworkKind = 'slide' | 'check' | 'question' | 'task'
export const PREWORK_KINDS: readonly PreworkKind[]
export const PREWORK_KIND_LABELS: Readonly<Record<PreworkKind, string>>
export const PREWORK_MINUTES: Readonly<{ values: readonly string[]; fallback: string }>
export const PREWORK_STEP_TOKENS: readonly string[]

export interface PreworkStep {
  /** 1-based position in the form. */
  n: number
  /** The step slide's id: what `{results=<id>}` names. */
  id: string
  title: string
  kind: PreworkKind
  /** Participants may ask about this step (no `{noask}`). */
  questions: boolean
  sourceLine: number | null
  /** `{local}` on a task, quick check or question: nothing about the step is sent (absent: sent to the speaker). */
  local?: boolean
  /** The poll type of a question or quick check. */
  pollType?: string
  /** A pre-task: participants get "Mark as done" (the default); false with `{readonly}`. */
  done?: boolean
  /** A pre-task: the time it takes, in minutes (default 10). */
  minutes?: number
  /** A quick check: its options (first list) and the right one, if marked. */
  options?: string[]
  right?: { index: number; label: string } | null
}

export interface PreworkFeed {
  stepId: string
  /** Set when the slide names a work-file step (`{results=<file id>/<step id>}`); absent for a step of the talk's own pre-work section. */
  fileId?: string
  slideId: string
  title: string
  /** 1-based position of the slide in the compiled deck, when it was emitted. */
  number?: number
}

export interface PreworkDefinition {
  sectionId: string
  title: string
  /** The section's own paragraph: the form's introduction. */
  intro: string
  sourceLine: number | null
  steps: PreworkStep[]
  /** Compiled model only: every emitted slide of the section (the section slide included). */
  slideIds?: string[]
  /** Compiled model only: the board slides that take a step's answers, with the compiler's own slide ids. */
  feeds?: PreworkFeed[]
}

export type PreworkFindingCode =
  | 'prework-section-duplicate' | 'prework-section-empty' | 'prework-token-outside' | 'prework-kind-conflict'
  | 'prework-readonly-without-task' | 'prework-minutes-invalid' | 'prework-check-not-single'
  | 'prework-check-right-missing' | 'prework-check-right-many' | 'prework-right-misplaced' | 'prework-results-unknown' | 'prework-results-invalid'
  | 'prework-local-on-slide' | 'prework-results-local'

export function isPreworkSection(node: { level: number; attrs?: Record<string, unknown> } | null | undefined): boolean
export function takeRightMarkers(lines?: readonly string[], options?: { throughHeadings?: boolean }): { lines: string[]; options: Array<{ label: string; right: boolean }>; rightCount: number; misplaced: number }
export function preworkFromTree(root: unknown): PreworkDefinition | null
export function preworkFromOutline(markdown: string): PreworkDefinition | null
export function parseResultsToken(raw: unknown): { fileId: string | null; stepId: string } | null
export function resultsSteps(definition: PreworkDefinition | null | undefined): PreworkStep[]
export function preworkFindings(root: unknown, definition?: PreworkDefinition | null): Array<{ code: PreworkFindingCode; slideId: string; detail: string }>
export function preworkOutlineTree(markdown: string): { children?: unknown[] } | null
export function preworkFeedsFromTree(root: unknown): PreworkFeed[]

/** The one finding for a retired `{prework}` section (move it to a work file); null when the talk has none. */
export function preworkRetiredFinding(root: unknown): { code: 'prework-section-retired'; slideId: string; detail: string } | null
