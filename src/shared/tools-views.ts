// The one definition of the Tools window's views. The main process, the preload and the renderer
// all ask this module what a view is, whether it can be opened, and what the left rail shows.

// One Runs view (house rule R5, 2026-11-07): History and Sessions merged into it. `history` and `sessions` stay as
// accepted names so the old command ids, shortcuts, agent verbs and saved links keep working; every surface turns
// them into `runs` with canonicalToolsView before it shows anything.
export const TOOLS_VIEWS = ['studio', 'runs', 'talktext', 'importer', 'published', 'workfiles', 'history', 'sessions'] as const
export type ToolsView = (typeof TOOLS_VIEWS)[number]
/** The views a window actually shows: the old names are folded into Runs. */
export type CanonicalToolsView = Exclude<ToolsView, 'history' | 'sessions'>

/** The view a name stands for: History and Sessions are the Runs view. */
export function canonicalToolsView(view: ToolsView): CanonicalToolsView {
  return view === 'history' || view === 'sessions' ? 'runs' : view
}

/** A Run, named by its talk and its Run id. */
/** A Run by its talk and Run id; `vaultId` picks the vault's Run when more than one vault holds that talk and id. */
export type ToolsRunRef = { talkSlug: string; runId: string; vaultId?: string }

export type ToolsRailItem = { view: CanonicalToolsView; label: string; icon: 'layout-dashboard' | 'calendar-days' | 'file-input' | 'globe' | 'files' }

/** The rail, top to bottom. */
export const TOOLS_RAIL: readonly ToolsRailItem[] = [
  { view: 'studio', label: 'Studio', icon: 'layout-dashboard' },
  { view: 'runs', label: 'Runs', icon: 'calendar-days' },
  { view: 'importer', label: 'Importer', icon: 'file-input' },
  { view: 'published', label: 'Published pages', icon: 'globe' },
  { view: 'workfiles', label: 'Work files', icon: 'files' }
]

export function isToolsView(value: unknown): value is ToolsView {
  return typeof value === 'string' && (TOOLS_VIEWS as readonly string[]).includes(value)
}

/** Whether the generic open may show a Tools view. */
export function isOpenableToolsView(value: unknown): value is ToolsView {
  return isToolsView(value)
}

/** Whether a view can be shown in a window already open (every Tools view). */
export function isShowableToolsView(value: unknown): value is ToolsView {
  return isToolsView(value)
}

/** The rail's items: Studio, Runs, Importer, Published pages, Work files. */
export function toolsRail(): ToolsRailItem[] {
  return [...TOOLS_RAIL]
}

/** A well-formed Run reference, or null. Both parts are non-empty strings without path separators; a
 *  vault id, when given, is one too (a malformed one makes the whole reference null). */
export function parseToolsRunRef(value: unknown): ToolsRunRef | null {
  if (!value || typeof value !== 'object') return null
  const { talkSlug, runId, vaultId } = value as Record<string, unknown>
  const ok = (part: unknown): part is string => typeof part === 'string' && part.length > 0 && part.length < 200 && !/[\\/\0]/.test(part)
  if (!ok(talkSlug) || !ok(runId)) return null
  if (vaultId === undefined) return { talkSlug, runId }
  return ok(vaultId) ? { talkSlug, runId, vaultId } : null
}

/** The rail item a view sits under. The rail has no Talk text (Manage notes) item of its own: it sits under Studio. */
export function railItemFor(view: ToolsView): CanonicalToolsView | null {
  const canonical = canonicalToolsView(view)
  return TOOLS_RAIL.some((item) => item.view === canonical) ? canonical : null
}

/** Said when Open results names a Run of a vault that is not open. */
export const RESULTS_OTHER_VAULT = 'The results of a Run in a vault that is not open cannot be opened. Open that vault first.'

/**
 * Whether History may open a Run's results (`results:<talk>/<run>`) for this reference. The reference names its
 * vault, and History reads that vault's Runs, so any open vault is allowed; a vault that is not open is refused.
 * A reference with no vault is History's own. Null: allowed; else the sentence to show.
 */
export function historyResultsRefusal(run: ToolsRunRef | undefined, isOpen: (vaultId: string) => boolean): string | null {
  if (!run?.vaultId) return null
  return isOpen(run.vaultId) ? null : RESULTS_OTHER_VAULT
}
