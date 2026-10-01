// The Inspector's Audience › Reactions group (ticket 04; round-2 drawings I1–I4): what it shows for
// the slide's Trigger line and the one token each action writes. The meaning of a token and the
// token for a choice both come from compiler/scripts/lib/reaction-sets.mjs, so the Inspector and
// the compiler never disagree about a {reactions=…} value. Pure: the component
// (ReactionsControl.tsx) holds only which mode the author has opened but not yet written.
import {
  MAX_REACTIONS, REACTIONS_KEY, STANDARD_REACTIONS, customLabelsProblem, reactionLabel, reactionsToken,
  readReactionsValue, registeredReactions, type ReactionsMode, type RegisteredReaction
} from '../../../../compiler/scripts/lib/reaction-sets.mjs'

export type { ReactionsMode, RegisteredReaction }
export { MAX_REACTIONS, STANDARD_REACTIONS, registeredReactions }

export interface ReactionsControlView {
  /** The mode lit in the Standard · Choose · Custom · Off row. */
  mode: ReactionsMode
  /** What the slide offers now, as stored ids (`agree`, `custom:Too fast`). */
  ids: string[]
  /** The registered ids chosen, in order (Choose's lit chips and their numbers). */
  chosen: string[]
  /** The custom labels as the Custom field shows them ("Too fast, Just right, Too slow"). */
  labelsText: string
  /** The canonical token for what the line means ('' for Standard), shown as "Trigger line". */
  token: string
}

/** The value of the group's selected token (`reactions=…` as the tokenizer reads it), or undefined. */
function valueOf(selectedToken: string): string | undefined {
  const prefix = `${REACTIONS_KEY}=`
  return selectedToken.startsWith(prefix) ? selectedToken.slice(prefix.length) : undefined
}

/**
 * The view for a selected token and, when the author has opened Choose or Custom without writing
 * yet, that pending mode. A pending mode shows its (empty) chips or field; the line is unchanged.
 */
export function reactionsControlView(selectedToken: string, pending: ReactionsMode | null = null): ReactionsControlView {
  const read = readReactionsValue(valueOf(selectedToken))
  const mode = pending ?? read.mode
  const chosen = read.mode === 'choose' || read.mode === 'custom' ? read.ids.filter((id) => !id.startsWith('custom:')) : []
  const labels = read.mode === 'custom' ? read.ids.filter((id) => id.startsWith('custom:')).map(reactionLabel) : []
  const token = read.mode === 'off' ? reactionsToken({ mode: 'off' })
    : read.mode === 'choose' ? reactionsToken({ mode: 'choose', ids: read.ids })
      : read.mode === 'custom' ? `${REACTIONS_KEY}=${read.ids.map((id) => id.startsWith('custom:') ? `"${reactionLabel(id)}"` : id).join(',')}`
        : ''
  return { mode, ids: read.ids, chosen, labelsText: labels.join(', '), token }
}

/** Standard writes no token; Off writes {reactions=off}. Choose and Custom open without writing. */
export function reactionsModeToken(mode: ReactionsMode): string | null {
  if (mode === 'standard') return ''
  if (mode === 'off') return reactionsToken({ mode: 'off' })
  return null
}

/**
 * The token a chip click writes: the chip added at the end, or taken out. Nothing chosen is
 * Standard (''). A fifth chip is refused (null): at most four reactions on a slide.
 */
export function reactionsChipToken(chosen: readonly string[], id: string): string | null {
  const next = chosen.includes(id) ? chosen.filter((candidate) => candidate !== id) : [...chosen, id]
  if (next.length > MAX_REACTIONS) return null
  return reactionsToken({ mode: 'choose', ids: next })
}

/** The Custom field's text split into labels: commas separate, spaces around a label go. */
export function splitLabels(text: string): string[] {
  return text.split(',').map((label) => label.trim()).filter(Boolean)
}

/**
 * The token the Custom field writes, or why it cannot: `{ token }` or `{ problem }`. An empty field
 * writes Standard ('').
 */
export function reactionsLabelsToken(text: string): { token: string; problem?: undefined } | { token?: undefined; problem: string } {
  const labels = splitLabels(text)
  if (!labels.length) return { token: '' }
  const problem = customLabelsProblem(labels)
  if (problem) return { problem }
  return { token: reactionsToken({ mode: 'custom', labels }) }
}
