// The mark of the app's own key commands (outliner.ts) on a change made for a key press that types. Read by the web
// form's link watch (quoteLinkFormSnapshots.ts) and by Slide Focus (focusScope.ts).
import { StateEffect, type Transaction } from '@codemirror/state'

/**
 * Marks a change one of the key commands of outliner.ts made as the direct result of a key press that types text (Enter on a
 * heading, a protected line or a list item; Shift-Enter in a quotation; Tab on a line that is no list item; Tab or
 * Shift-Tab that indents or outdents the caret's line and no other line): the user's own edit at the keyboard, by
 * another route
 * than CodeMirror's own commands. The web form's link watch (quoteLinkForm.ts) reads it as typing (`isKeyTyped`).
 * It is not a user event on purpose. `userEvent: 'input'` (what CodeMirror's insertNewline carries)
 * starts a new undo step (history joins only `input.type` and `delete`, or a change with no user event), so the list
 * Enter would no longer be undone with the typing before it; and any `input` event sends the change through the
 * protected-token guard (idProtect.ts) and the Slide Focus range guard (focusScope.ts), and counts as the editor being
 * engaged (Editor.tsx), none of which these commands' changes do today. The mark changes none of that.
 * It is a state effect and not an annotation (quote forms ticket 14). In Slide Focus the caret guard (focusScope.ts)
 * rebuilds a transaction whose caret it moves back into the focused slide, from its changes, its effects and its user
 * event: an annotation is lost there, and the second Enter under a source line that ends the slide was then read as a
 * program's change. An effect goes through with the changes it was dispatched with. No field or plugin acts on it, it
 * is not put into the undo history (no `invertedEffects`), so an undo or a redo never carries it.
 * The effect type stays inside this file and `typedByKey` is for the key commands of outliner.ts alone: only their
 * dispatches attach it. The mark has a file of its own because Slide Focus reads it too (focusScope.ts, which outliner.ts
 * reaches through objectBlocks/field.ts: the two could not import each other).
 * Any edit of the user's counts (decided 13 October 2026, quote forms ticket 14): the mark goes on those commands'
 * changes wherever the caret is on its line, with text after it or not. A Shift-Enter, an Enter or a Tab that moves
 * text already on the line is the user's edit as much as a character typed, and a link it makes the slide's source
 * gives the slide its form. Only a program's change (no user event and no mark) never does.
 */
const keyTyped = StateEffect.define<null>()
/** The part of a transaction spec that marks it as typed by a key (see `keyTyped`); a new effect for each dispatch. */
export const typedByKey = (): { effects: StateEffect<null> } => ({ effects: keyTyped.of(null) })
/** The change is one of outliner.ts's key commands' own, made for a key press that types (see `keyTyped`). */
export const isKeyTyped = (tr: Transaction): boolean => tr.effects.some((effect) => effect.is(keyTyped))
