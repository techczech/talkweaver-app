// The editor's ordinary key bindings below the app's own: CodeMirror's default keymap (which holds
// the macOS Emacs-style keys: Ctrl-H, Ctrl-D, Ctrl-K, Ctrl-O, Ctrl-T and the rest), undo and redo,
// folding and Find. One list, because two places read it: Editor.tsx installs it, and the Plain
// view's guard (plainView/guardKeys.ts) is built from it, so a key added here is guarded without
// being named there.
import type { KeyBinding } from '@codemirror/view'
import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { foldKeymap } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'

/** Undo and redo: part of the base keymap, and the part the Plain guard leaves alone. */
export const editorHistoryKeymap: readonly KeyBinding[] = historyKeymap

export const editorBaseKeymap: readonly KeyBinding[] = [...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]
