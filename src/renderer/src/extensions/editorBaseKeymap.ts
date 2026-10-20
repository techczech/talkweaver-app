// The editor's ordinary key bindings below the app's own: CodeMirror's default keymap (which holds
// the macOS Emacs-style keys: Ctrl-H, Ctrl-D, Ctrl-K, Ctrl-O, Ctrl-T and the rest), undo and redo,
// folding and Find. One list, because two places read it: Editor.tsx installs it, and the Plain
// view's guard (plainView/guardKeys.ts) is built from it, so a key added here is guarded without
// being named there.
import type { KeyBinding } from '@codemirror/view'
import { defaultKeymap, historyKeymap, redo, redoSelection, undo, undoSelection } from '@codemirror/commands'
import { foldKeymap } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { redoWithSave, undoWithSave } from './savedTextAdoption'

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

export const editorBaseKeymap: readonly KeyBinding[] = [...defaultKeymap, ...editorHistoryKeymap, ...foldKeymap, ...searchKeymap]
