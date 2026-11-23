// The Markdown tab's theme and syntax highlighting. Moved out of
// components/Editor.tsx so the Plain view's switch (plainView/index.ts) and its test can name them.
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

export const CODE_FONT = 'var(--font-mono)'

export const twTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    fontFamily: CODE_FONT,
    background: 'var(--panel)'
  },
  '.cm-content': {
    padding: '16px 20px',
    caretColor: 'var(--accent-text)'
  },
  '.cm-line': { lineHeight: '1.7', color: 'var(--ink)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    borderRight: '1px solid var(--line)',
    color: 'var(--faint)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active)', color: 'var(--muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent-text)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection)'
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--line-strong)' }
}, { dark: false })

// Preserve CodeMirror’s token roles and typographic marks with readable ink in both schemes.
const markdownHighlight = HighlightStyle.define(defaultHighlightStyle.specs.map((spec) => ({
  ...spec,
  ...(typeof spec.color === 'string' && {
    color: `light-dark(color-mix(in srgb, ${spec.color} 80%, #111827), color-mix(in srgb, ${spec.color} 35%, #e9ecf1))`
  })
})))

/** What the Markdown tab holds for the things Plain replaces: the highlight and the theme. */
export function markdownLookExtension(): Extension {
  return [syntaxHighlighting(markdownHighlight), twTheme]
}
