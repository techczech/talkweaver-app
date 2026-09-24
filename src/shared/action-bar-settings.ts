/**
 * The action bar's persisted state (ADR-0025).
 *
 * Visibility is ONE app-wide setting (decision 6): not per window, not per talk, and ON by default. A toggle in one window's Settings reaches the others
 * through the main process's `action-bar:changed` broadcast, so two open windows can never
 * disagree and no restart is needed.
 *
 * Both values live in the app-level JSON config (`src/main/index.ts` → `userData/config.json`).
 * Their NAMES live here, in shared, so the main process, the preload bridge and the renderer that
 * reads them cannot drift apart. The ordered button list persists beside the visibility flag under
 * its own key; only the default populates it today — the configure sheet is a later parcel.
 */

/** The config.json key holding the action bar's visibility. App-wide, not per window. */
export const ACTION_BAR_VISIBLE_KEY = 'actionBarVisible'

/** ADR-0025 decision 6: the bar is on until explicitly switched off. */
export const ACTION_BAR_VISIBLE_DEFAULT = true

/** Read the stored value tolerantly: anything that is not a boolean means "never set" → default. */
export function actionBarVisibleFrom(stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : ACTION_BAR_VISIBLE_DEFAULT
}

/** The config.json key holding the bar's ordered items, beside the visibility flag. */
export const ACTION_BAR_ITEMS_KEY = 'actionBarItems'

/**
 * The item that draws a section boundary. `|` can never collide with a command id (registry ids
 * are dotted or hyphenated identifiers), so a stored list needs no escaping and no second field to
 * tell the two apart.
 */
export const ACTION_BAR_SEPARATOR = '|'

/** Is this stored item a separator rather than a command id? */
export function isActionBarSeparator(item: string): boolean {
  return item === ACTION_BAR_SEPARATOR
}

/**
 * Read the stored list, or null when there is nothing usable in it.
 *
 * THE STORED LIST IS NEVER ALLOWED TO BREAK THE BAR. A missing value, a non-array, malformed JSON
 * or a list with no usable string in it — every one of those reads as "never set", and the caller
 * falls back to the default rather than rendering an empty row. An array keeps only its non-empty
 * string entries; a number or an object among them is dropped rather than poisoning the whole list.
 * (A plain string is additionally given one JSON.parse chance, so a legacy doubly-encoded value
 * still reads — but a string that does not parse as an array is simply "never set".)
 *
 * An id naming a command this build no longer has is NOT dropped here: it is dropped later, when
 * the list is resolved against the runnable commands (see the action bar model in the renderer).
 * Keeping it in storage means a command that comes back returns to the writer's bar in its old
 * place rather than being quietly forgotten.
 */
export function parseActionBarItems(stored: unknown): string[] | null {
  let value: unknown = stored
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!Array.isArray(value)) return null
  const items = value.filter((item): item is string => typeof item === 'string' && item !== '')
  // Nothing usable is damage, not a decision: a writer who wants no bar hides the bar.
  if (items.length === 0 || items.every((item) => isActionBarSeparator(item))) return null
  return items
}

/** What to write back: the list as stored — a fresh ordered array of ids and separator tokens. */
export function serialiseActionBarItems(items: readonly string[]): string[] {
  return [...items]
}

/** The stored list if there is one usable, else the default the caller passes in. */
export function actionBarItemsFrom(stored: unknown, fallback: readonly string[]): string[] {
  return parseActionBarItems(stored) ?? [...fallback]
}
