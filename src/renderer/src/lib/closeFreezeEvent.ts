// The window event that freezes and unfreezes the editor for a close (lib/closeFreeze.ts; Editor.tsx listens).
export const CLOSE_FREEZE_EVENT = 'tw-close-freeze'
/** frozen: the editor refuses the person's edits and says why; update: an update's restart asked for the close. */
export interface CloseFreezeDetail { frozen: boolean; update: boolean }
/** What the editor says while frozen for a close. */
export const closeFreezeText = (update: boolean): string => (update ? 'Saving before the update…' : 'Saving before closing…')
export function dispatchCloseFreeze(detail: CloseFreezeDetail): void {
  window.dispatchEvent(new CustomEvent<CloseFreezeDetail>(CLOSE_FREEZE_EVENT, { detail }))
}
