import { invertedEffects } from '@codemirror/commands'
import { MapMode, StateEffect, StateField, type ChangeDesc, type EditorState, type Text } from '@codemirror/state'
import { listSlideBlocks } from '../../../../compiler/scripts/lib/slide-blocks.mjs'
import { idLineIndex, ID_TOKEN_RE } from '../../../../compiler/scripts/lib/slide-id.mjs'
import { MAX_OUTLINE_SAVE_IDS, MAX_OUTLINE_SAVE_ID_LENGTH, type OutlineSaveIdentity } from '../../../shared/outline-save-identity'
import { savedTextAdopted } from './savedTextAdoption'
import { saveFollowsUndoOrRedo } from './saveTidyUp'

interface Heading {
  at: number
  id: string | null
  owner: object
}

function headings(text: string) {
  const lines = text.split('\n')
  return listSlideBlocks(text).map(({ start, end }) => {
    const line = idLineIndex(lines, start, end)
    return { line: start + 1, id: line < 0 ? null : lines[line].match(ID_TOKEN_RE)?.[1] ?? null }
  })
}

function mapHeadings(before: readonly Heading[], changes: ChangeDesc): Heading[] {
  const result: Heading[] = []
  for (const heading of before) {
    // The byte to the right belongs to the heading. Deleting the preceding slide can
    // move this byte to its position, but can never transfer the preceding slide's owner.
    const at = changes.mapPos(heading.at, 1, MapMode.TrackAfter)
    if (at !== null) result.push(at === heading.at ? heading : { ...heading, at })
  }
  return result
}

const restoreHeadings = StateEffect.define<readonly Heading[]>({ map: mapHeadings })
export const preserveHeadingOwners = StateEffect.define<readonly number[]>()

function readHeadings(doc: Text, previous: readonly Heading[], byOrder = false, known = previous): Heading[] {
  const byPosition = new Map(previous.map(heading => [heading.at, heading]))
  const byId = new Map(known.flatMap(heading => heading.id ? [[heading.id, heading] as const] : []))
  const next = headings(doc.toString())
  return next.map(({ line, id }, index) => {
    const at = doc.line(line).from
    const candidate = byOrder && previous.length === next.length ? previous[index] : byPosition.get(at)
    // A replacement carrying a different explicit ID (e.g. Fork) starts a different identity.
    const same = candidate && (!id || !candidate.id || candidate.id === id) ? candidate : undefined
    return { at, id, owner: same?.owner ?? (id ? byId.get(id)?.owner : undefined) ?? {} }
  })
}

const headingOwners = StateField.define<readonly Heading[]>({
  create: state => readHeadings(state.doc, []),
  update(before, tr) {
    if (!tr.docChanged) return before
    // CodeMirror stores effects in reverse order when it joins typing transactions. The last
    // snapshot is the one before the entire group. Redo stores and restores the opposite end.
    const restored = tr.effects.filter(effect => effect.is(restoreHeadings)).at(-1)
    if (restored) return readHeadings(tr.newDoc, restored.value)
    if (tr.annotation(savedTextAdopted)) return readHeadings(tr.newDoc, before, true)
    const order = tr.effects.find(effect => effect.is(preserveHeadingOwners))?.value
    if (order?.length && order.every(index => index >= 0 && index < before.length)) {
      return readHeadings(tr.newDoc, order.map(index => before[index]), true)
    }
    return readHeadings(tr.newDoc, mapHeadings(before, tr.changes), false, before)
  }
})

export const outlineSaveIdentity = [
  headingOwners,
  invertedEffects.of(tr => {
    if (!tr.docChanged) return []
    const before = tr.startState.field(headingOwners)
    const after = tr.state.field(headingOwners)
    // Body and title edits usually leave the heading marker and its owner intact.
    // Undo can map those markers back without retaining a heading list for each keystroke.
    if (before.length === after.length && before.every((heading, index) =>
      heading.owner === after[index].owner &&
      tr.changes.mapPos(heading.at, 1, MapMode.TrackAfter) === after[index].at
    )) return []
    return [restoreHeadings.of(before)]
  })
]

export interface OutlineIdentityReceipt {
  options(): OutlineSaveIdentity
  acknowledge(saved: string): void
}

/** Capture the heading owners of this write before entering the queue. An older reply can
 * bind IDs to those owners even when typing or history replay has changed the live buffer. */
export function captureOutlineIdentity(
  state: EditorState,
  sent: string,
  acknowledged: WeakMap<object, string>
): OutlineIdentityReceipt {
  const owners = state.field(headingOwners)
  // Save normalisation moves only braces and blank lines. If a brace-only title ceased to
  // be a heading, decline positional reuse for this write rather than shifting any ID.
  const count = headings(sent).length
  const replay = saveFollowsUndoOrRedo(state)
  const hasPositions = owners.length === count && count <= MAX_OUTLINE_SAVE_IDS
  return {
    options: () => ({
      ids: hasPositions ? owners.map(({ id, owner }) => {
        const known = id ?? acknowledged.get(owner)
        return known && known.length <= MAX_OUTLINE_SAVE_ID_LENGTH ? known : null
      }) : [],
      replay
    }),
    acknowledge(saved) {
      const written = headings(saved)
      if (owners.length !== count || written.length !== count) return
      for (const [index, { id }] of written.entries()) {
        if (id) acknowledged.set(owners[index].owner, id)
      }
    }
  }
}
