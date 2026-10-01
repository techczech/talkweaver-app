// The unified rail's compositional state (ADR-0009): pinned scope + property facets, "Find a talk"
// (ADR-0029 §4), and the side-by-side ⇄ sequential preference for a 2–3-talk scope.
import { useEffect, useRef, useState } from 'react'
import {
  type RailFacets, type ScopeEntry, emptyFacets, toggleScope
} from '../browser-rail/railModel'
import {
  type FindScope, addTalkBeside, pickTalk, prunePicked, removeFindChip
} from '../browser-rail/findTalkModel'
import type { FacetKind } from '../browser-rail/railTypes'
import type { FindTalkCommands } from '../slidePickerCommands'
import { toggleFacetValue } from './browserHelpers'
import { VIEW_STORAGE_KEY } from './types'

export function useRailState(currentTalkSlug: string) {
  const [scope, setScope] = useState<ScopeEntry[]>([])
  // "Find a talk" (ADR-0029 §4): its own query (never the slide search's) and which scope
  // entries it picked — those show as chips in its box.
  const [findQuery, setFindQuery] = useState('')
  const [findPicked, setFindPicked] = useState<string[]>([])
  // Find a talk's focus and add-beside, for the palette (talk search 08); and a request to put the
  // cursor there, honoured after the render that shows the box (the rail may have been collapsed,
  // or the picker only now opening).
  const findCmdRef = useRef<FindTalkCommands | null>(null)
  const [findFocusReq, setFindFocusReq] = useState(0)
  const [facets, setFacets] = useState<RailFacets>(emptyFacets)
  // Side-by-side ⇄ sequential preference for a 2–3-talk scope (persisted).
  const [viewPref, setViewPref] = useState<'side' | 'seq'>(() => {
    try { return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'seq' ? 'seq' : 'side' } catch { return 'side' }
  })

  /** A fresh opening starts from the whole vault: scope, facets and Find a talk are cleared. */
  function resetRail(): void {
    setScope([]); setFacets(emptyFacets())
    setFindQuery(''); setFindPicked([])
  }

  function handleScope(entry: ScopeEntry, additive: boolean): void {
    // The active talk is never scopeable — its slides are never on the table. The tree's
    // row for it is non-scoping anyway; this backstops any other path.
    if (entry.talk && entry.talk === currentTalkSlug) return
    setScope((s) => toggleScope(s, entry, additive))
  }
  // "Find a talk": ↵ picks (replaces the scope), ⌘↵ adds beside, a chip's × removes. The slide
  // search query is never touched. The active talk is never scoped, as in the tree.
  const findState = (): FindScope => ({ scope, picked: findPicked })
  function applyFind(next: FindScope): void {
    setScope(next.scope)
    setFindPicked(next.picked)
  }
  function pickFromFind(entry: ScopeEntry): void {
    if (entry.talk && entry.talk === currentTalkSlug) return
    applyFind(pickTalk(findState(), entry))
  }
  function addBesideFromFind(entry: ScopeEntry): void {
    if (entry.talk && entry.talk === currentTalkSlug) return
    applyFind(addTalkBeside(findState(), entry))
  }
  function removeFindChipKey(key: string): void {
    applyFind(removeFindChip(findState(), key))
  }
  // A pick whose talk left the scope some other way (the tree replaced it, a scope row's ×)
  // stops being a chip.
  useEffect(() => {
    setFindPicked((picked) => prunePicked({ scope, picked }))
  }, [scope])
  function removeScopeAt(i: number): void {
    setScope((s) => s.filter((_e, idx) => idx !== i))
  }
  function clearScope(): void {
    setScope([])
  }
  function toggleFacet(kind: FacetKind, value: string): void {
    setFacets((f) => toggleFacetValue(f, kind, value))
  }
  function clearFacets(): void {
    setFacets(emptyFacets())
  }
  function setView(v: 'side' | 'seq'): void {
    setViewPref(v)
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, v) } catch { /* ignore */ }
  }

  return {
    scope, findQuery, setFindQuery, findPicked, findCmdRef, findFocusReq, setFindFocusReq,
    facets, viewPref, resetRail,
    handleScope, pickFromFind, addBesideFromFind, removeFindChipKey, removeScopeAt, clearScope,
    toggleFacet, clearFacets, setView
  }
}
