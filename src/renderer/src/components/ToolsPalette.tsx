// The Tools window's keys and command palette (work-files ticket 30).
//
// ⌘⇧P opens a palette of the Tools-window commands (the same CommandMenu the editor uses); each
// command's own chord runs it directly. Both go through `runToolsAction`, the one function the view's
// button calls (see lib/toolsActions.ts), so a command is enabled exactly when its button is, and a
// chord whose command is disabled does nothing. The commands, their keywords and their keys come from
// the command registry; this file types none of them. The ids below are the ones the registry
// declares (the Guide's "command ran" report names them literally, scripts/test-command-ran.mjs).
import { useEffect, useMemo, useState } from 'react'
import { commandShortcutLabel, toolsWindowCommands } from '../../../shared/command-registry'
import { shortcutById, shortcutEventMatches } from '../../../shared/shortcut-registry'
import CommandMenu, { type Command } from './CommandMenu'
import { runToolsAction, toolsActionEnabled } from '../lib/toolsActions'
import { commandRan } from '../commands/command-ran'

/** The commands this window carries out, as the registry names them. */
export const TOOLS_COMMAND_IDS = [
  'tools-view-sessions', 'tools-view-published', 'tools-view-workfiles', 'tools-plan-run', 'tools-edit-plan',
  'tools-plan-like-this', 'tools-publish', 'tools-unpublish', 'tools-go-live', 'tools-open-run', 'tools-copy-link',
  'tools-copy-invitation', 'tools-new-work-file'
] as const

/** Run a Tools command if it is enabled, and report it to the Guide when it ran. */
export function runToolsCommand(commandId: string): boolean {
  const ran = runToolsAction(commandId)
  if (ran) commandRan(commandId)
  return ran
}

/**
 * Does this key event press the chord of this shortcut row? The registry's match reads `event.key`; with ⌥ held
 * on a Mac that is the composed character (⌥N is a dead key, ⌥O is ø), so a chord with a letter or digit is also
 * matched by the physical key (`event.code`), with the same modifiers.
 */
function pressed(event: KeyboardEvent, shortcutId: string): boolean {
  if (shortcutEventMatches(event, shortcutId)) return true
  for (const code of shortcutById(shortcutId).codes) {
    const parts = code.split('-')
    const base = parts[parts.length - 1]
    const modifiers = new Set(parts.slice(0, -1))
    if (base.length !== 1) continue
    if (event.code !== (/[a-z]/i.test(base) ? `Key${base.toUpperCase()}` : `Digit${base}`)) continue
    if ((event.metaKey || event.ctrlKey) !== modifiers.has('Mod') || event.altKey !== modifiers.has('Alt') || event.shiftKey !== modifiers.has('Shift')) continue
    return true
  }
  return false
}

export function ToolsPalette({ active }: { active: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!active) return
    const commands = toolsWindowCommands().filter((command) => command.shortcutId)
    const onKey = (event: KeyboardEvent): void => {
      // A sheet or the palette itself has the keyboard: leave its keys alone.
      if (document.querySelector('[aria-modal="true"]')) return
      if (pressed(event, 'app.command-palette')) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
        return
      }
      for (const command of commands) {
        if (!command.shortcutId || !pressed(event, command.shortcutId)) continue
        // A disabled command leaves its chord alone (the view's own keys may use it).
        if (!toolsActionEnabled(command.id)) return
        event.preventDefault()
        event.stopPropagation()
        runToolsCommand(command.id)
        return
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [active])

  // Read when the palette opens: which commands the window can carry out right now.
  const rows = useMemo<Command[]>(() => !open ? [] : toolsWindowCommands().map((command) => ({
    id: command.id,
    title: command.label,
    hint: command.shortcutId ? commandShortcutLabel(command) : '',
    group: command.taskGroup ?? undefined,
    keywords: command.palette.keywords,
    disabled: !toolsActionEnabled(command.id),
    run: () => { runToolsCommand(command.id) }
  })), [open])

  if (!active) return null
  return <CommandMenu isOpen={open} onClose={() => setOpen(false)} commands={rows} />
}
