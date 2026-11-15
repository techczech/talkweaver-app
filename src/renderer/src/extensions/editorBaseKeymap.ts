// The editor's ordinary key bindings below the app's own: CodeMirror's default keymap (which holds
// the macOS Emacs-style keys: Ctrl-H, Ctrl-D, Ctrl-K, Ctrl-O, Ctrl-T and the rest), undo and redo,
// folding and Find. One list, because two places read it: Editor.tsx installs it, and the Plain
// view's guard (plainView/guardKeys.ts) is built from it, so a key added here is guarded without
// being named there.
import type { KeyBinding } from '@codemirror/view'
import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  historyKeymap,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  redo,
  redoSelection,
  toggleBlockComment,
  toggleComment,
  toggleLineComment,
  undo,
  undoSelection
} from '@codemirror/commands'
import type { Command } from '@codemirror/view'
import { foldKeymap } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { redoWithSave, undoWithSave } from './savedTextAdoption'
import { runLineCommand } from './objectBlocks/field'

/** Undo and redo: part of the base keymap, and the part the Plain guard leaves alone. CodeMirror's
 *  history keys, with ⌘Z and the redo keys (⇧⌘Z; Ctrl-Y elsewhere) running the undo and redo that take
 *  a save's step together with the user's change it was made for (savedTextAdoption.ts). The
 *  selection-only undo and redo keys (Mod-u / Alt-u and their redo partners) are dropped: Mod-u
 *  would undo a save step on its own, and Mod-Shift-u belongs to app.where-used. */
export const editorHistoryKeymap: readonly KeyBinding[] = historyKeymap
  .filter((binding) => binding.run !== undoSelection && binding.run !== redoSelection)
  .map((binding) =>
    binding.run === undo ? { ...binding, run: undoWithSave } : binding.run === redo ? { ...binding, run: redoWithSave } : binding
  )

/** CodeMirror's commands that work on "the caret's line": under an object they act on a new line below
 *  it, and on a selected object they do nothing (runLineCommand, objectBlocks/field.ts). */
const LINE_COMMANDS: ReadonlySet<Command> = new Set([
  deleteLine, moveLineUp, moveLineDown, copyLineUp, copyLineDown, indentMore, indentLess,
  toggleComment, toggleLineComment, toggleBlockComment
])
/** The command a line-command binding wraps (the Plain view's guard tests that command on the new line). */
export const lineCommandOf = new WeakMap<Command, Command>()
const lineCommand = (run: Command | undefined): Command | undefined => {
  if (!run || !LINE_COMMANDS.has(run)) return run
  const wrapped: Command = (view) => runLineCommand(view, run)
  lineCommandOf.set(wrapped, run)
  return wrapped
}

const editorDefaultKeymap: readonly KeyBinding[] = defaultKeymap.map((binding) =>
  LINE_COMMANDS.has(binding.run as Command) || LINE_COMMANDS.has(binding.shift as Command)
    ? { ...binding, run: lineCommand(binding.run), shift: lineCommand(binding.shift) }
    : binding
)

export const editorBaseKeymap: readonly KeyBinding[] = [...editorDefaultKeymap, ...editorHistoryKeymap, ...foldKeymap, ...searchKeymap]
