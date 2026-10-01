// The palette's picker commands (talk search 08): they reach the live state through a ref
// refreshed every render, and are registered with the host once.
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef } from 'react'
import { liveShortcutLabel } from '../../keymap/store'
import {
  type FindTalkCommands, NOTHING_BESIDE, type PickerCommandOutcome, type SlidePickerCommands
} from '../slidePickerCommands'
import { besideAvailable } from '../talkBesideModel'
import type { SearchResult } from './types'

export function usePickerCommands({
  registerCommands, gridMode, besideOn, activePos, leftCount, vRows, rowsByTalk, findCmdRef,
  selectWholeSection, openBesideAt, closeBesideNow, setRailCollapsed, setFindFocusReq
}: {
  registerCommands?: (commands: SlidePickerCommands) => void
  gridMode: Parameters<typeof besideAvailable>[0]
  besideOn: boolean
  activePos: number
  leftCount: number
  vRows: SearchResult[]
  rowsByTalk: Map<string, SearchResult[]>
  findCmdRef: MutableRefObject<FindTalkCommands | null>
  selectWholeSection: (talkSlug: string, section: string) => number
  openBesideAt: (pos: number) => void
  closeBesideNow: () => void
  setRailCollapsed: Dispatch<SetStateAction<boolean>>
  setFindFocusReq: Dispatch<SetStateAction<number>>
}) {
  // ⇧⌘↵: the focused slide's whole section joins the selection, as its heading's "Select section"
  // button does (both call selectWholeSection over the same whole-talk rows).
  function selectWholeSectionAt(pos: number): PickerCommandOutcome {
    const row = vRows[pos]
    if (!row) return 'No slide is focused.'
    if (!row.section) return 'This slide is not in a section.'
    if (!rowsByTalk.has(row.talkSlug)) return 'The slide’s whole talk is still loading — try again in a moment.'
    if (selectWholeSection(row.talkSlug, row.section) === 0) return 'This slide’s section has no heading slide to select it by.'
    return true
  }
  // The palette's picker commands reach the live state through this ref, refreshed every render.
  const liveCommandsRef = useRef<SlidePickerCommands | null>(null)
  liveCommandsRef.current = {
    focusFindTalk: () => { setRailCollapsed(false); setFindFocusReq((n) => n + 1) },
    addTalkBeside: () => findCmdRef.current?.addActiveBeside() ?? `Find a talk is hidden — show the rail (${liveShortcutLabel('slide-picker.rail')}) first.`,
    talkBeside: () => {
      if (!besideAvailable(gridMode)) return 'A talk opens beside the results only while the results are one list, not columns.'
      if (activePos >= leftCount || !vRows[activePos]) return 'Focus a slide-search result first.'
      openBesideAt(activePos)
      return true
    },
    closeTalkBeside: () => {
      if (!besideOn) return NOTHING_BESIDE
      closeBesideNow()
      return true
    },
    selectWholeSection: () => selectWholeSectionAt(activePos)
  }
  useEffect(() => {
    registerCommands?.({
      focusFindTalk: () => liveCommandsRef.current?.focusFindTalk(),
      addTalkBeside: () => liveCommandsRef.current?.addTalkBeside() ?? 'The slide picker is not open.',
      talkBeside: () => liveCommandsRef.current?.talkBeside() ?? 'The slide picker is not open.',
      closeTalkBeside: () => liveCommandsRef.current?.closeTalkBeside() ?? 'The slide picker is not open.',
      selectWholeSection: () => liveCommandsRef.current?.selectWholeSection() ?? 'The slide picker is not open.'
    })
  }, [registerCommands])

  return { selectWholeSectionAt }
}
