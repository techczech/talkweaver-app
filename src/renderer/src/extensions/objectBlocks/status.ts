// File status for object cards (src/main/object-status.ts answers it): which references a card names,
// the statuses the editor holds for them, and the words a card shows. The request itself is made by
// objectStatusRequests (commands.ts), debounced after edits, for the talk this window has open.
// A status is shown, never trusted: Open and Reveal ask main again at the moment of the operation.
import { Facet, StateEffect, StateField } from '@codemirror/state'
import type { ObjectBlock } from './detect.ts'

export type CardFileState = 'present' | 'missing' | 'outside' | 'remote' | 'invalid' | 'unchecked'
export type CardFileStatus = { state: CardFileState; path?: string }

/**
 * How this editor asks main for statuses; null (the default) asks nothing. `scope` names what the
 * answers belong to (the open talk), so the same references in another talk are asked again.
 */
export type ObjectStatusSource = {
  scope: () => string
  ask: (refs: string[]) => Promise<Map<string, CardFileStatus> | null>
}
export const objectStatusSource = Facet.define<ObjectStatusSource | null, ObjectStatusSource | null>({
  combine: (values) => values[values.length - 1] ?? null
})

export const setObjectStatuses = StateEffect.define<Map<string, CardFileStatus>>()

export const objectStatusField = StateField.define<Map<string, CardFileStatus>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (!effect.is(setObjectStatuses)) continue
      if (next === value) next = new Map(value)
      for (const [ref, status] of effect.value) next.set(ref, status)
    }
    return next
  }
})

/** The local file references a card names: its page or clip file, and its saved-view pictures. */
export function cardStatusRefs(block: ObjectBlock): string[] {
  const facts = block.embed
  if (!facts) return []
  const refs: string[] = []
  if (facts.variant === 'local' || facts.variant === 'simulation' || facts.variant === 'video') refs.push(facts.src)
  for (const capture of facts.captures) refs.push(capture.src)
  return refs
}

/** What a card says about its own file, or null when there is nothing to say. */
export function cardFileNote(status: CardFileStatus | undefined): string | null {
  switch (status?.state) {
    case 'missing': return 'File not found'
    case 'outside': return 'Outside this talk’s vault: the deck will not show it'
    case 'invalid': return 'Not a file this slide can show'
    default: return null
  }
}
