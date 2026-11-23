import { strict as assert } from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', { pretendToBeVisual: true, url: 'https://talkweaver.test/' })
for (const name of ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] })
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
const [{ EditorView }, { EditorState }, { history, undo, redo }, { runActionBarEditing }, { runActionBarEditorCommand }, { paletteCommands }] = await Promise.all([
  import('@codemirror/view'), import('@codemirror/state'), import('@codemirror/commands'),
  import('../src/renderer/src/components/actionBar/editing-command.ts'),
  import('../src/renderer/src/components/actionBar/command-runner.ts'),
  import('../src/shared/command-registry.ts')
])
const view = new EditorView({ parent: document.getElementById('editor'), state: EditorState.create({ doc: '## Slide\n\nAlpha\n', extensions: [history()] }) })
view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Alpha') } })
view.focus()
assert.equal(document.activeElement, view.contentDOM, 'outline editor is focused')
const commands = {
  undo: () => { undo(view) }, redo: () => { redo(view) },
  newSlide: () => { runActionBarEditing(view, 'new-slide') },
  promoteHeading: () => {}, demoteHeading: () => {},
  bulletedList: () => { runActionBarEditing(view, 'bulleted-list') },
  numberedList: () => { runActionBarEditing(view, 'numbered-list') }
}
for (const id of ['bulleted-list', 'undo']) {
  const registered = paletteCommands().find((command) => command.id === id)
  assert(registered, `${id} is registered for the bar and palette`)
  runActionBarEditorCommand(commands, registered.handlerId)
  assert.equal(document.activeElement, view.contentDOM, `${id} retains editor focus`)
  assert.equal(view.state.doc.toString().includes('- Alpha'), id === 'bulleted-list', `${id} changes the real CodeMirror document`)
}
for (const [id, marker] of [['bulleted-list', '- '], ['numbered-list', '1. ']]) {
  runActionBarEditorCommand(commands, id)
  const { selection, doc } = view.state
  assert.equal(selection.main.empty, true, id + ' leaves a caret')
  assert.equal(selection.main.head, doc.line(3).to, id + ' leaves the caret at the line end')
  view.dispatch(view.state.replaceSelection(' Beta'))
  assert.equal(view.state.doc.line(3).text, marker + 'Alpha Beta')
  runActionBarEditorCommand(commands, 'undo')
  runActionBarEditorCommand(commands, 'undo')
}
view.destroy()
console.log('action bar command path: focused editor, bullet, undo passed')
