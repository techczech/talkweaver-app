// What the Tools window's commands do right now (work-files ticket 30).
//
// The Tools window's views own their state (the selected Run, a draft, a confirmation), so each view says
// which of the Tools commands it can carry out at this moment and how. The window's palette and its keys read
// this one list, so a command runs the same function as its button, and is enabled exactly when that
// button is: a view never registers an action its button would refuse.
//
// Registration is per render and removed when the view goes (`useToolsActions`). Nothing here holds
// state of its own beyond that list.
import { useEffect } from 'react'

export interface ToolsAction {
  /** Whether the button this command mirrors would be enabled now. */
  enabled: boolean
  /** Does what the button does. */
  run: () => void
}

const actions = new Map<string, ToolsAction>()

/** The action a command has now, or undefined when no view in the window offers it. */
export function toolsAction(commandId: string): ToolsAction | undefined {
  return actions.get(commandId)
}

/** Whether the command can run now. */
export function toolsActionEnabled(commandId: string): boolean {
  return actions.get(commandId)?.enabled === true
}

/** Carry out a command if it is enabled; returns whether it ran. */
export function runToolsAction(commandId: string): boolean {
  const action = actions.get(commandId)
  if (!action || !action.enabled) return false
  action.run()
  return true
}

/** Offer these actions for as long as the caller is mounted (each render replaces the last offer). */
export function useToolsActions(offered: Readonly<Record<string, ToolsAction>>): void {
  useEffect(() => {
    for (const [id, action] of Object.entries(offered)) actions.set(id, action)
    return () => { for (const [id, action] of Object.entries(offered)) if (actions.get(id) === action) actions.delete(id) }
  })
}
