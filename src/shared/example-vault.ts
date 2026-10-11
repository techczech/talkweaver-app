// The example vault (onboarding ticket 06): the strings the locked drawing fixes, and what the
// renderer hears back from "Open example vault". The writer is main's `src/main/example-vault.ts`.
//
// Strings are copied from TEXT in docs/design/2026-10-09-onboarding-and-command-help/
// mockup-onboarding-talkweaver-text.mjs (states 01 to 03); scripts/test-example-vault.mjs checks
// them against that file, so a wording change happens there first.

export const EXAMPLE_VAULT_TEXT = {
  /** TEXT.vaultExample: the vault's name in the Talks panel. */
  name: 'Example vault',
  /** TEXT.exampleMark: the pill on the card and on the vault header. */
  mark: 'Example',
  /** The header's second line, beside the graduation cap (state 03). */
  subline: 'Removable · local folder',
  /** TEXT.firstLaunch.or / exTitle / exSub / exBtn / exPath. */
  or: 'or look around first',
  title: 'Open the example vault',
  sub: 'Five short demo talks with a practice slide for each of ten tasks. The vault sits in its own folder and can be removed whenever you like.',
  button: 'Open example vault',
  path: '~/Documents/TalkWeaver/Example vault · 5 talks',
} as const

/** Why "Open example vault" wrote nothing. Every case leaves the app usable and shows one sentence. */
export type ExampleVaultRefusal =
  /** No home folder for this run (a test run without its stand-in home). */
  | 'unavailable'
  /** A folder (or file) is already at the path, and it is not the example vault: left alone. */
  | 'in-the-way'
  /** A symlink, or a part of the path that is not a plain folder: nothing written. */
  | 'refused'
  /** The vault list says no: the path sits inside, or contains, a vault already in the list. */
  | 'nested'
  /** The bundle, the disk or the vault list failed part-way; what is written is left as it is. */
  | 'failed'

export type ExampleVaultResult =
  | {
    ok: true
    vaultId: string
    /** written: created now. reopened: already in the list (opened again if closed). adopted: the
     *  folder held the example vault file but was not in the list (an earlier write whose last step,
     *  adding it to the list, failed); it was added, nothing written. */
    outcome: 'written' | 'reopened' | 'adopted'
    /** The start talk's outline (The Saturday market), when it is there; the renderer opens it. */
    startTalk: string | null
  }
  | { ok: false; reason: ExampleVaultRefusal; message: string }
