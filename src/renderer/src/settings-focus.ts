// Going to one setting in the shared Settings window (0.42): its section opens and its field is
// brought into view with the keyboard in it. @app-patterns/settings-react has no navigation call for a
// page to use; the window is opened at a section through its `initial` state (settings-main.tsx),
// and the field is focused here once the section is on screen. Each row of the generated sections
// carries `data-key` (the setting's key).
//
// Pure DOM; erasable TypeScript only (node tests import it as it is).

/** "Set up recording storage" on the Cloudflare page: Recording, with Storage endpoint focused (Storage bucket is the row under it). */
export const RECORDING_STORAGE_FIELD = { section: 'recording', key: 'recording.endpoint' } as const

interface FocusableLike { focus(options?: { preventScroll?: boolean }): void }
interface RowLike {
  scrollIntoView?(options?: { block?: 'start' | 'center' | 'end' | 'nearest' }): void
  querySelector(selector: string): unknown
}
interface RootLike { querySelector(selector: string): unknown }

/**
 * Brings the row of setting `key` into view and puts the keyboard in its field. False when the row
 * or its field is not on screen (yet).
 */
export function focusSettingField(root: RootLike, key: string): boolean {
  const row = root.querySelector(`[data-key="${key}"]`) as RowLike | null
  if (!row) return false
  const field = row.querySelector('input, select, textarea') as FocusableLike | null
  if (!field) return false
  row.scrollIntoView?.({ block: 'center' })
  field.focus({ preventScroll: true })
  return true
}
