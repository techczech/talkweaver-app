// What the Tools window's commands do right now (work-files ticket 30).
//
// The Tools window's views own their state (the selected Run, a draft, a confirmation), so each view says
// which of the Tools commands it can carry out at this moment and how. The window's palette and its keys read
// this one list, so a command runs the same function as its button, and is enabled exactly when that
// button is: a view never registers an action its button would refuse.
//
// Registration is per render and removed when the view goes (`useToolsActions`). Nothing here holds
// state of its own beyond that list; deferred video menu intent is local to Studio.
import { useCallback, useEffect, useState } from 'react'
import { recordingRunHome, recordingRunKey, type RecordingRunLocation } from '../../../shared/recording-run-home'

export interface ToolsAction {
  /** Whether the button this command mirrors would be enabled now. */
  enabled: boolean
  /** Does what the button does. */
  run: () => void
}

const actions = new Map<string, ToolsAction>()
export type VideoRequestTarget = { talk:string; home:string|null|undefined; recordingRunKey:string }

/** A menu request binds once Studio has selected its Run, then belongs only to that selection. */
export function useVideoMenuRequest(request:number|null,run:RecordingRunLocation|null,onRegistered:()=>void):[VideoRequestTarget|null,()=>void] {
  const [pending,setPending]=useState<VideoRequestTarget|null>(null)
  const talk=run?.talkSlug,home=run?recordingRunHome(run):undefined,key=run?recordingRunKey(run):null
  const clear=useCallback(()=>setPending(null),[])
  useEffect(()=>{
    if(request===null||talk===undefined||key===null)return
    setPending({talk,home,recordingRunKey:key})
    onRegistered()
  },[request,talk,home,key,onRegistered])
  useEffect(()=>{
    setPending(current=>current&&(current.talk!==talk||current.home!==home||current.recordingRunKey!==key)?null:current)
  },[talk,home,key])
  // State disappears on Studio unmount; a target mismatch is cancelled before its action can fire.
  return [pending&&pending.talk===talk&&pending.home===home&&pending.recordingRunKey===key?pending:null,clear]
}

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
