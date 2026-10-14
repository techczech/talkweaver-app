/**
 * The outline editor's two views (plain editing view, spec T3).
 *
 * `editorViewMode` is one per-user setting in the main-process config: unset means Plain, after that
 * the tab last used. It applies to every talk and every window. Names live here so the main process,
 * the preload bridge and the renderer cannot drift.
 */
export type EditorViewMode = 'plain' | 'markdown'

/** The config.json key holding the editor's view. */
export const EDITOR_VIEW_MODE_KEY = 'editorViewMode'

export const EDITOR_VIEW_MODE_DEFAULT: EditorViewMode = 'plain'

/** Read the stored value tolerantly: anything but the two names means "never set" → Plain. */
export function editorViewModeFrom(stored: unknown): EditorViewMode {
  return stored === 'plain' || stored === 'markdown' ? stored : EDITOR_VIEW_MODE_DEFAULT
}
