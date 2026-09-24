import {
  ACTION_BAR_SEPARATOR,
  isActionBarSeparator
} from '../../../../shared/action-bar-settings.ts'
import type { ToolbarIconToken } from '../../../../shared/command-registry.ts'

/**
 * The action bar's command set (ADR-0025 decision 3), as DATA — one flat list, in one place.
 * Two sections separated by one separator token, discovery first; the section structure is DERIVED
 * from this array at resolution time, never restated beside it, so changing the default later is
 * an edit to this array and never a refactor.
 *
 * Section two carries the complete everyday editing set from the 2026-09-23 amendment.
 *
 * `app.command-palette` ("All commands…") is palette-hidden — the palette must not list itself —
 * but it is a registered, runnable command, which is what the bar resolves against.
 */
export const DEFAULT_ACTION_BAR_ITEMS: readonly string[] = [
  // Section one — discovery: what someone who does not already know the app cannot find.
  'layout',
  'icon-picker',
  'image',
  'search',
  'insert-object-table',
  'insert-object-chart',
  'insert-object-diagram',
  'insert-object-mindmap',
  'toggle-inspector',
  'view-strip',
  'present-presenter',
  'handout',
  'publish-handout',
  'app.command-palette',
  // Section two — everyday editing.
  ACTION_BAR_SEPARATOR,
  'undo',
  'redo',
  'new-slide',
  'delete-slide',
  'promote-heading',
  'demote-heading',
  'bulleted-list',
  'numbered-list'
]

/**
 * The ONE neutral mark for a command with no `toolbar.icon` of its own (ADR-0025 decision 4
 * consequence). The configure sheet will later offer all 171 commands, most of which carry no
 * icon — they all wear this single existing token rather than a per-command invention.
 */
export const ACTION_BAR_FALLBACK_ICON: ToolbarIconToken = 'tools'

/** What the bar needs to know about a command it can run — the palette's own row, narrowed. */
export type RunnableActionBarCommand = {
  label: string
  /** The icon token the toolbar menus draw this command with, when it has one. */
  icon?: ToolbarIconToken
  /** The command's EFFECTIVE chord (live rebindings applied), or undefined when it has none. */
  keys?: string
  /**
   * True when the app reports the command unavailable. The palette carries no unavailable state
   * today, so nothing arrives disabled; the bar still renders a disabled command DIMMED IN PLACE
   * rather than hidden, so the bar keeps its shape when a source of availability appears.
   */
  disabled?: boolean
  run: () => void
}

/** One resolved button. `disabled` means visible, in place, and not pressable. */
export type ResolvedActionBarItem = {
  commandId: string
  label: string
  icon: ToolbarIconToken
  keys: string | null
  tooltip: string
  disabled: boolean
  run: () => void
}

/** A section of buttons, separated from its neighbours by a hairline in the stored list. */
export type ActionBarSection = { items: ResolvedActionBarItem[] }

/**
 * App-drawn tooltip content (ADR-0025 amendment): label and live shortcut only, never a
 * description. The bar shows this immediately on hover or keyboard focus.
 */
export function tooltipFor(label: string, keys?: string): string {
  return keys ? `${label} (${keys})` : label
}

/**
 * Resolve a stored (or the default) list against the commands this window can actually run — the
 * SAME rows the palette lists and the handler map fires, so the bar can never disagree with either
 * about what a button does or which key does it.
 *
 * THE STORED LIST IS NEVER ALLOWED TO BREAK THE BAR:
 *  - an id naming a command this window cannot run is dropped SILENTLY — no gap, no dead button,
 *    no error (it stays in storage, so a command that returns returns to its place);
 *  - a repeated id keeps its first place only, so one command is one button;
 *  - separators only ever BOUND sections: leading, trailing and doubled ones collapse, so no empty
 *    section and no orphan hairline can be drawn.
 */
export function resolveActionBarItems(
  items: readonly string[],
  commands: ReadonlyMap<string, RunnableActionBarCommand>
): ActionBarSection[] {
  const sections: ActionBarSection[] = []
  const seen = new Set<string>()
  let current: ResolvedActionBarItem[] = []
  const flush = (): void => {
    if (current.length === 0) return
    sections.push({ items: current })
    current = []
  }
  for (const item of items) {
    if (isActionBarSeparator(item)) {
      flush()
      continue
    }
    if (seen.has(item)) continue
    const command = commands.get(item)
    if (!command) continue
    seen.add(item)
    current.push({
      commandId: item,
      label: command.label,
      icon: command.icon ?? ACTION_BAR_FALLBACK_ICON,
      keys: command.keys ?? null,
      tooltip: tooltipFor(command.label, command.keys),
      disabled: command.disabled === true,
      run: command.run
    })
  }
  flush()
  return sections
}
