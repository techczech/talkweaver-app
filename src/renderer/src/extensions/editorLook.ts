// The Markdown tab's look: today's warm-paper code-font theme and highlight, unchanged. Moved out of
// components/Editor.tsx so the Plain view's switch (plainView/index.ts) and its test can name them.
import { EditorView } from '@codemirror/view'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

export const CODE_FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace"

// Warm paper theme — matches the slide palette from html-presentations
export const twTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    fontFamily: CODE_FONT,
    background: '#f7f3ea'
  },
  '.cm-content': {
    padding: '16px 20px',
    caretColor: '#0b3a6b'
  },
  '.cm-line': { lineHeight: '1.7', color: '#17202a' },
  '.cm-gutters': {
    backgroundColor: '#f0ebe0',
    borderRight: '1px solid #d9d0c1',
    color: '#8a9099'
  },
  '.cm-activeLineGutter': { backgroundColor: '#e4ddd0' },
  '.cm-activeLine': { backgroundColor: '#e8e3d6' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#0b3a6b', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#0b3a6b22'
  },
  '.cm-matchingBracket': { backgroundColor: '#0b3a6b15', outline: '1px solid #0b3a6b30' }
}, { dark: false })

/** What the Markdown tab holds for the things Plain replaces: the highlight and the theme. */
export function markdownLookExtension(): Extension {
  return [syntaxHighlighting(defaultHighlightStyle), twTheme]
}
