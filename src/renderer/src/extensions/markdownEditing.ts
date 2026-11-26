import { Compartment, Prec, type Extension } from '@codemirror/state'
import { keymap, ViewPlugin, type EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { outlineParagraphFolds } from './outlineFold'
import { buildEditorKeyBindings, KEYMAP_CHANGED_EVENT } from '../keymap/store'

export const markdownEditingLanguage = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: [outlineParagraphFolds]
})

// These registered commands work on text alone. Slide structure, object navigation and other
// workspace commands belong to the containing editor.
const textCommands = new Set([
  'undo', 'redo', 'list-continue', 'quote-paragraph', 'list-indent', 'list-outdent',
  'move-up', 'move-down', 'promote', 'demote', 'promote-subtree', 'demote-subtree',
  'bold', 'italic', 'inline-code', 'highlight', 'strikethrough', 'underline', 'link'
])

export function markdownEditingKeymap(scope: 'outline' | 'draft'): Extension {
  const compartment = new Compartment()
  const bindings = () => Prec.highest(keymap.of(buildEditorKeyBindings(
    scope === 'draft' ? textCommands : undefined
  )))
  return [
    compartment.of(bindings()),
    ViewPlugin.fromClass(class {
      private readonly view: EditorView
      private readonly window: Window | null

      constructor(view: EditorView) {
        this.view = view
        this.window = view.dom.ownerDocument.defaultView
        this.window?.addEventListener(KEYMAP_CHANGED_EVENT, this.reconfigure)
      }

      private reconfigure = (): void => {
        this.view.dispatch({ effects: compartment.reconfigure(bindings()) })
      }

      destroy(): void {
        this.window?.removeEventListener(KEYMAP_CHANGED_EVENT, this.reconfigure)
      }
    })
  ]
}
