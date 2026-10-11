// The Guide (onboarding 0.38.1 ticket 07): its strings, its three segments, the first steps and the
// two app-wide values it keeps in app config, beside the vault registry and outside every vault.
//
// Strings are copied from TEXT in docs/design/2026-10-09-onboarding-and-command-help/
// mockup-onboarding-talkweaver-text.mjs (states 02, 03, 16, 16b, 19); scripts/test-guide.mjs checks
// them against that file, so a wording change happens there first.

export const GUIDE_TEXT = {
  /** The button at the foot of the left sidebar, and the tab's name. */
  button: 'Guide',
  /** Beside the button while the tab is up (state 02). */
  buttonOpen: 'open',
  segments: ['Learn the commands', 'How it works', 'Features to delight you'],
  stepsBar: 'First steps',
  steps: [
    { label: 'Choose your own vault', action: 'Add vault…' },
    { label: 'Make your first talk', action: 'New presentation…' },
    { label: 'Open the example talk', action: 'Open' },
  ],
  /** The result a ticked third step shows. */
  openedResult: 'Opened',
  /** Settings → Get started (states 16, 19). */
  settings: {
    section: 'Get started',
    row: 'Get started',
    open: 'Open the Guide',
    switchTitle: 'Show the Guide button in the sidebar',
    switchSub: 'Turn off when you have finished the onboarding. Get started in Settings and the palette still open the Guide.',
  },
  offFlash: 'Guide button removed from the sidebar. Settings → Get started, or the palette, brings it back.',
  /** Not drawn: said when "Get started: show the Guide button" brings the button back. */
  onFlash: 'Guide button is back in the sidebar.',
  /** Learn the commands (ticket 08; states 04 to 06). Copied from TEXT in the drawing's text module. */
  chapters: {
    bar: 'Chapters',
    startHere: 'Start here',
    thisChapter: 'This chapter',
    practiceTalk: 'Practice talk',
    openInExample: 'Open this talk',
    openNow: 'open now',
    /** The back link on a chapter (state 05). */
    allChapters: 'All chapters',
    /** A row with no key (state 05). */
    noKey: 'no key',
    /** The toast on a tick (state 06): "Ticked · Move slide or item down ⌘⇧↓". */
    ticked: 'Ticked',
    /** Not drawn: the button that goes to the chapter after a finished one. */
    next: 'Next chapter',
    /** Not drawn: said when Open this talk finds no example vault in the Talks panel. */
    noExample: 'The example vault is not in the Talks panel. Settings → Get started shows it again.',
    /** The note under the Present chapter (drawn in state 07, beside the presenter column). */
    liveNote: (n: number): { lead: string; rest: string } => ({
      lead: `${n} live commands`,
      rest: ' are listed apart: going live, polls, questions, boards, venue screen. They are practised after the live service is set up.'
    })
  },
  /** The two palette rows (state 16b); the "show the example vault again" row is ticket 12's. */
  paletteOpen: 'Get started: open the Guide',
  paletteShowButton: 'Get started: show the Guide button',
} as const

export type GuideSegment = 'commands' | 'how' | 'features'
export const GUIDE_SEGMENTS: ReadonlyArray<{ id: GuideSegment; label: string }> = [
  { id: 'commands', label: GUIDE_TEXT.segments[0] },
  { id: 'how', label: GUIDE_TEXT.segments[1] },
  { id: 'features', label: GUIDE_TEXT.segments[2] },
]
export const GUIDE_DEFAULT_SEGMENT: GuideSegment = 'commands'

// ── The switch: "Show the Guide button in the sidebar" ──────────────────────────────────────────
// One app-wide value in the app-level JSON config, ON by default, broadcast to every window on
// change, as the place chip's is (place-chip-settings.ts). Off removes the button and the tab from
// every window; the person's progress is kept.

/** The config.json key holding the button's visibility. */
export const GUIDE_BUTTON_VISIBLE_KEY = 'guideButtonVisible'
export const GUIDE_BUTTON_VISIBLE_DEFAULT = true

/** Anything that is not a boolean means "never set" → the default. */
export function guideButtonVisibleFrom(stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : GUIDE_BUTTON_VISIBLE_DEFAULT
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────
// Stored in app config, never in a vault, so that it survives removal and restore of the example
// vault. Ticket 07 keeps one fact; tickets 08 and 11 add their own beside it (ticks, read marks,
// chapter opens): every reader goes through `guideProgressFrom`, so an unknown shape reads as empty.

/** The config.json key holding the Guide's progress. */
export const GUIDE_PROGRESS_KEY = 'guideProgress'

export interface GuideProgress {
  /** A talk of the example vault has been opened, in any window. */
  exampleTalkOpened: boolean
}

export const EMPTY_GUIDE_PROGRESS: GuideProgress = { exampleTalkOpened: false }

export function guideProgressFrom(stored: unknown): GuideProgress {
  if (!stored || typeof stored !== 'object') return { ...EMPTY_GUIDE_PROGRESS }
  const record = stored as Record<string, unknown>
  return { exampleTalkOpened: record.exampleTalkOpened === true }
}

// ── First steps ─────────────────────────────────────────────────────────────────────────────────

export interface GuideStepVault { id: string; name: string; example?: boolean; open?: boolean }
export interface GuideStepTalk { vaultId?: string | null; title: string }

export interface FirstStepsInput {
  vaults: readonly GuideStepVault[]
  talks: readonly GuideStepTalk[]
  progress: GuideProgress
}

export type FirstStepId = 'own-vault' | 'first-talk' | 'example-talk'

export interface FirstStep {
  id: FirstStepId
  label: string
  /** The button on an undone step. */
  action: string
  done: boolean
  /** What a done step shows in place of the button: the vault's name, the talk's name, "Opened". */
  result: string | null
}

/**
 * The three steps, ticked from real state: a vault that is not the example exists; a talk exists in
 * one; the example talk has been opened (progress, kept outside the vault).
 */
export function firstSteps(input: FirstStepsInput): FirstStep[] {
  const own = input.vaults.filter((v) => v.example !== true)
  const ownIds = new Set(own.map((v) => v.id))
  const ownTalk = input.talks.find((t) => t.vaultId != null && ownIds.has(t.vaultId))
  const [s1, s2, s3] = GUIDE_TEXT.steps
  return [
    { id: 'own-vault', label: s1.label, action: s1.action, done: own.length > 0, result: own[0]?.name ?? null },
    { id: 'first-talk', label: s2.label, action: s2.action, done: ownTalk !== undefined, result: ownTalk?.title ?? null },
    { id: 'example-talk', label: s3.label, action: s3.action, done: input.progress.exampleTalkOpened, result: input.progress.exampleTalkOpened ? GUIDE_TEXT.openedResult : null },
  ]
}

/** "1 of 3": the count on the First steps bar. */
export function firstStepsCount(steps: readonly FirstStep[]): string {
  return `${steps.filter((s) => s.done).length} of ${steps.length}`
}

// ── The right column's tab row ──────────────────────────────────────────────────────────────────

export type RightColumnTab = 'guide' | 'slides' | 'inspector'

/**
 * The tab row. Without the Guide there is no row (the column is the strip or the Inspector, as
 * before). With it: Guide first, then Slides and Inspector; with no talk open only the Guide, as
 * there is no slide to show.
 */
export function rightColumnTabs(input: { guideUp: boolean; hasTalk: boolean }): RightColumnTab[] {
  if (!input.guideUp) return []
  return input.hasTalk ? ['guide', 'slides', 'inspector'] : ['guide']
}
