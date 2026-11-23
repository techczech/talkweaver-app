// The Markdown tab's theme and syntax highlighting. Moved out of
// components/Editor.tsx so the Plain view's switch (plainView/index.ts) and its test can name them.
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

export const CODE_FONT = 'var(--font-mono)'

export const twTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.8125rem',
    fontFamily: CODE_FONT,
    background: 'var(--panel)'
  },
  '.cm-content': {
    padding: '16px 20px',
    caretColor: 'var(--accent-text)'
  },
  '.cm-line': { lineHeight: '1.7', color: 'var(--ink)' },
  '.cm-content.cm-lineWrapping': { minWidth: '0' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    borderRight: '1px solid var(--line)',
    color: 'var(--faint)'
  },
  '.cm-lineNumbers': { flex: '0 0 110px', width: '110px' },
  '.cm-lineNumbers .cm-gutterElement': { boxSizing: 'border-box', width: '100%', overflow: 'hidden', color: 'var(--accent-text)', fontSize: '0.6875rem' },
  '.cm-md-heading-marker': { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-md-heading-number': { marginInlineStart: '0.5ch' },
  '.cm-md-heading-abbreviation': { display: 'none' },
  '.cm-scroller::-webkit-scrollbar-corner': { backgroundColor: 'var(--panel)' },
  '@media (max-width: 1199px)': {
    '.cm-lineNumbers': { flex: '0 0 39px', width: '39px' },
    '.cm-md-heading-name': { display: 'none' },
    '.cm-md-heading-abbreviation': { display: 'inline' },
    '.cm-md-heading-number': { marginInlineStart: '0' },
    '.cm-fm-header': { flexWrap: 'wrap', gap: '4px' },
    '.cm-fm-label': { flexBasis: 'min(110px, 35%)' },
    '.cm-fm-add': { maxWidth: 'calc(100% - 20px)' }
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active)', color: 'var(--muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-line.cm-picture-drop-target': {
    backgroundColor: 'var(--accent-soft)',
    boxShadow: 'inset 0 -2px var(--accent)'
  },
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
