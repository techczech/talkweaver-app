/** Drafts outside the outline revision: ask the person to finish these without saving or discarding. */
export function updateRestartDraft(root: Pick<Document, 'querySelectorAll'>): string | null {
  for (const shell of root.querySelectorAll<HTMLElement & { __twHasDraft?: () => boolean }>('.oe')) {
    if (shell.__twHasDraft?.()) return 'Save or discard your changes in the object editor to restart.'
  }
  return null
}
