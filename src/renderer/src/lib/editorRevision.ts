// The editor's revision (ADR-0044 §6, rules B and D): one number per window, raised by every change the person (or a
// command acting for them) makes to the talk's text, and never lowered, so a save from an earlier talk or an earlier
// editor in this window can never be taken for a later one. Every save sends the revision of the text it sent; a
// close confirms the revision the frozen editor holds; main accepts the close only when that revision is the one it
// wrote (src/main/editor-revisions.ts). Loading a talk, Reload from disk and adopting the ids a save stamped are not
// changes of the person's and do not raise it.
let revision = 0

export const editorRevision = {
  current: (): number => revision,
  /** A change of the person's: the text is now at a new revision. */
  bump: (): number => ++revision,
}
