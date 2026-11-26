import { EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap } from '@codemirror/view'
import { history, toggleTabFocusMode } from '@codemirror/commands'
import { editorBaseKeymap } from '../extensions/editorBaseKeymap'
import { markdownLookExtension } from '../extensions/editorLook'
import { inlineMarkExtension } from '../extensions/inlineMark'
import { keyCapExtension } from '../extensions/keyCap'
import { markdownEditingKeymap, markdownEditingLanguage } from '../extensions/markdownEditing'
import type { MountSourceEditor } from './shell'

export const mountMarkdownSourceEditor: MountSourceEditor = (source, className = 'oe-markup', label = 'Object markup') => {
  // Draft transactions stay separate from the outline until the shell commits the entire text.
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [
        markdownEditingLanguage,
        markdownLookExtension(),
        markdownEditingKeymap('draft'),
        inlineMarkExtension,
        keyCapExtension,
        history(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        EditorView.editorAttributes.of({ class: `${className} oe-markdown` }),
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
        keymap.of([
          // The shell provides a keyboard exit. Consuming an unhandled Tab keeps focus here
          // even at the outermost list level or if the list keys have been rebound.
          ...editorBaseKeymap.filter((binding) => binding.run !== toggleTabFocusMode),
          { key: 'Tab', run: () => true, shift: () => true }
        ])
      ]
    })
  })
  return {
    element: view.dom,
    serialise: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy()
  }
}
