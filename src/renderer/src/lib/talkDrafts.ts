// Unsaved edits of the Talk tab, kept for the talk that is open while the tab or its Advanced disclosure is away (collapsing
// Advanced or switching to another sidebar tab unmounts the panels). Rules:
//  - one talk only: the entry belongs to one outline path and is cleared whenever the open talk changes (another talk opened,
//    the window's talk replaced, its path changed by a rename or move, or it was deleted): `clearDrafts(openPath)` from the
//    workspace is the only reset, and it names the talk that owns the store from then on. A call for any other path is a
//    stale caller (a save for a talk that is no longer open) and is ignored, even while the store is empty, so it can never
//    claim the store or wipe the open talk's edits. Nothing survives into another talk, so nothing is migrated;
//  - only the fields that differ from what was last read are kept, each with the saved value it was edited from and whether
//    the key was in the outline at all (absent is not the same as written empty). A draft is never restored over a changed
//    baseline: the field's draft is dropped and the panel says so (`discardedNotice`). Save (the panels' existing writers)
//    is the only thing that writes; a saved or reverted field drops out;
//  - the discard notice is kept here too, until dismissed, until that panel's save, or until the talk changes.
export type DraftPart = 'design' | 'advanced'
export interface Baseline { value: string; present: boolean }
type Kept = Record<string, { value: string; base: Baseline }>
let current: { path: string; parts: Partial<Record<DraftPart, Kept>>; notices: Partial<Record<DraftPart, string>> } | null = null

/** Remember the fields of `draft` that differ from `baseline` (with `present`: which baseline keys were in the outline). */
export function keepDraft(part: DraftPart, talkPath: string, draft: Record<string, string>, baseline: Record<string, string>, present: Record<string, boolean>): void {
  const kept: Kept = {}
  for (const key of Object.keys(draft)) if (draft[key] !== baseline[key]) kept[key] = { value: draft[key], base: { value: baseline[key] ?? '', present: present[key] ?? false } }
  if (!entryFor(talkPath)) return
  if (Object.keys(kept).length === 0) delete current!.parts[part]
  else current!.parts[part] = kept
}

/**
 * Whether `talkPath` owns the store. Ownership is set only by the workspace's `clearDrafts(openPath)` on a talk change, so
 * a call for any other talk (a save for talk A resolving after talk B was opened, even before B's text has loaded) is
 * a stale caller and is ignored; it can neither claim the store nor replace B's entry. No open talk: nothing is kept.
 */
function entryFor(talkPath: string): boolean {
  return current !== null && current.path === talkPath
}

/**
 * `values` (just read from the talk) with this talk's kept edits laid over the fields they were made in, but only where the
 * saved value, and whether it was written at all, is still what the edit started from. `discarded` lists the other keys.
 */
export function restoreDraft(part: DraftPart, talkPath: string, values: Record<string, string>, present: Record<string, boolean>): { draft: Record<string, string>; discarded: string[] } {
  const kept = current && current.path === talkPath ? current.parts[part] : undefined
  const draft = { ...values }
  const discarded: string[] = []
  if (kept) for (const key of Object.keys(kept)) {
    if (!(key in values)) continue
    const base = kept[key].base
    if (values[key] === base.value && (present[key] ?? false) === base.present) draft[key] = kept[key].value
    else discarded.push(key)
  }
  return { draft, discarded }
}

/** A panel's discard notice, kept beside its drafts so it outlives the panel (an Inspector round-trip, an Advanced collapse). '' clears it. */
export function setStoredNotice(part: DraftPart, talkPath: string, text: string): void {
  if (!entryFor(talkPath)) return
  if (text) current!.notices[part] = text
  else delete current!.notices[part]
}
export function storedNotice(part: DraftPart, talkPath: string): string {
  return current && current.path === talkPath ? current.notices[part] ?? '' : ''
}

/** The open talk changed (or was renamed, moved or deleted): nothing kept may reach whatever is open next. */
export function clearDrafts(openPath: string | null): void {
  current = openPath ? { path: openPath, parts: {}, notices: {} } : null
}

/** "Your unsaved change to Title was discarded because the talk changed." */
export function discardedNotice(labels: readonly string[]): string {
  if (labels.length === 0) return ''
  const names = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
  return `Your unsaved change${labels.length === 1 ? '' : 's'} to ${names} ${labels.length === 1 ? 'was' : 'were'} discarded because the talk changed.`
}
