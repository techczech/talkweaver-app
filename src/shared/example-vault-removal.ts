// Removing the example vault and bringing it back (onboarding 0.38.1 ticket 12): the strings the
// locked drawing fixes (states 15, 16, 16b, 17), and what the renderer hears back. The remover is
// main's `src/main/example-vault-removal.ts`.
//
// Strings are copied from TEXT in docs/design/2026-10-09-onboarding-and-command-help/
// mockup-onboarding-talkweaver-text.mjs (`confirm`, `removedFlash`, `menuRemove`, `removeExample`,
// `settings`, `palette`); scripts/test-example-vault-removal.mjs checks them against that file.

export const EXAMPLE_REMOVAL_TEXT = {
  /** TEXT.menuRemove: the last row of the example vault's ⋯ menu (state 17). */
  menuRemove: 'Remove example vault…',
  /** TEXT.removeExample: the link under the Guide's chapters (states 15, 17). */
  guideRemove: 'Remove the example vault…',
  confirm: {
    title: 'Remove the example vault?',
    lead: 'The example vault folder is moved to the Bin. Your own vaults and talks are not touched. What you have tried and read is kept.',
    binBar: 'Moved to the Bin',
    offBar: 'Taken off the Talks panel',
    // The second line departs from the drawing (TEXT.confirm.off[1], "Any window showing an example
    // talk closes first; its changes are saved before the move"): removal closes no window (ticket 12,
    // review round 1). Recorded in the ticket.
    off: ['The Example vault section, and the Guide’s example steps', 'Nothing is closed for you: close any window showing an example talk first'],
    keptBar: 'Kept',
    kept: ['Every vault, talk and file of your own', 'What you have tried and read in the Guide', 'Your settings and shortcuts'],
    cancel: 'Cancel',
    ok: 'Remove example vault',
  },
  /** TEXT.removedFlash: in the status bar of every open window after the move (state 16). */
  removedFlash: 'Example vault moved to the Bin. Settings → Get started brings it back.',
  /** TEXT.settings.note and b1 (state 16). */
  settingsNote: 'The example vault was removed.',
  settingsShow: 'Show the example vault again',
  /** TEXT.palette.rows[0] (state 16b). */
  paletteShow: 'Get started: show the example vault again',
} as const

/** The second line under the folder in the confirmation: "5 talks, with any change you made to them". */
export function binDetail(talks: number): string {
  return `${talks} ${talks === 1 ? 'talk' : 'talks'}, with any change you made to them`
}

/** What the confirmation shows, read from disk when it opens; the token is what Remove gives back. */
export type ExampleRemovalPreview =
  | { ok: true; /** Home-relative, as it is on disk: "~/Documents/TalkWeaver/Example vault". */ folder: string; talks: number; /** Not a path. */ token: string }
  | { ok: false; message: string }

export type ExampleRemoveResult =
  | { ok: true; outcome: 'moved-to-bin' | 'already-gone' }
  | { ok: false; message: string }

export type ExampleRestoreResult =
  | { ok: true; outcome: 'written' | 'adopted' | 'reopened'; startTalk: string | null }
  | { ok: false; message: string }

/** Settings → Get started reads this: the example was removed and is not in the list now. */
export type ExampleRemovalState = { removed: boolean }
