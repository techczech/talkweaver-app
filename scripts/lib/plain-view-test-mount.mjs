// What every plain-view test mount that binds the app's keys shares (ticket 07, sixth fix round).
// Bundled into the page with the test's own entry.
//
//   appKeyState()            the state the app's bound commands read. `openSelectedObject`, the
//                            first command of the app's Enter chain, reads the object blocks'
//                            fields when installed, and otherwise falls through to source editing.
//                            sourceOnly mounts isolate inline decorations from object cards.
//   appEnterBindings()       the app's own Enter chain, as Editor.tsx installs it: every command
//                            keymap/registry.ts binds to Enter, in the registry's order.
//   failOnCaughtExceptions() collects every exception CodeMirror catches (a command, a plugin or a
//                            listener that threw) into `window.__caught`. The test file asserts
//                            that list empty at its end: a `pageerror` listener never sees them.
import { EditorView } from '@codemirror/view'
import { objectBlocksExtension } from '../../src/renderer/src/extensions/objectBlocks/field.ts'
import { buildEditorKeyBindings } from '../../src/renderer/src/keymap/store.ts'

const caught = []
window.__caught = caught

export function appKeyState({ sourceOnly = false } = {}) {
  // Inline-source suites inspect literal fence/note lines. Object-card behaviour is covered by
  // test:object-block-field and the object DOM suites; ordinary app mounts keep cards by default.
  return sourceOnly ? [] : [objectBlocksExtension({})]
}

export function appEnterBindings() {
  return buildEditorKeyBindings().filter((binding) => binding.key === 'Enter')
}

export function failOnCaughtExceptions() {
  return EditorView.exceptionSink.of((exception) => {
    caught.push(String((exception && exception.stack) || exception).split('\n').slice(0, 3).join(' | '))
  })
}
