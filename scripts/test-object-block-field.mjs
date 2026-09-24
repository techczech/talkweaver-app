import { strict as assert } from 'node:assert'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { focusScopeExtension } from '../src/renderer/src/extensions/focusScope.ts'
import * as objectField from '../src/renderer/src/extensions/objectBlocks/field.ts'
import {
  closeOpenObject,
  ObjectEditorWidget,
  objectBlocksExtension,
  objectBlocksIn,
  openSelectedObject,
  setOpenObjectBlock,
  setRawObjectBlock,
  toggleRawObjectAtSelection
} from '../src/renderer/src/extensions/objectBlocks/field.ts'
import { ObjectWidget } from '../src/renderer/src/extensions/objectBlocks/widgets.ts'
import { installTestDom, TestEvent } from './test-dom.mjs'

function objectDecorations(state) {
  const found = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    source.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget instanceof ObjectWidget) {
        found.push({ from, to, widget: value.spec.widget })
      }
    })
  }
  return found
}

function editorDecorations(state) {
  const found = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    source.between(0, state.doc.length, (from, to, value) => {
      if (value.spec.widget instanceof ObjectEditorWidget) {
        found.push({ from, to, widget: value.spec.widget })
      }
    })
  }
  return found
}

function markupEditor(shell) {
  const mounted = shell.querySelector('.oe-markup')
  if (mounted) return mounted
  const markupTab = shell.querySelector('.oe-tabs')?.querySelectorAll('button')
    .find((button) => button.textContent === 'Markup')
  assert(markupTab, 'an editor shell with a visual surface exposes its Markup tab')
  markupTab.dispatchEvent(new TestEvent('click'))
  const markup = shell.querySelector('.oe-markup')
  assert(markup, 'the Markup tab mounts the source textarea')
  return markup
}

function fakeView(state) {
  return {
    state,
    transactions: [],
    dispatch(spec) {
      const transaction = spec?.state && spec?.startState ? spec : this.state.update(spec)
      this.transactions.push(transaction)
      this.state = transaction.state
    },
    coordsAtPos: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
    focus() {}
  }
}

function inputText(view, from, to, text, applyDefault = true) {
  const defaultTransaction = () => view.state.update({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: 'input'
  })
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, defaultTransaction))
  if (!handled && applyDefault) view.dispatch(defaultTransaction())
  return handled
}

function runKey(view, key) {
  const binding = view.state.facet(keymap).flat().find((candidate) => candidate.key === key)
  assert(binding, `expected a ${key} object-block key binding`)
  return binding.run(view)
}

const table = '| a | b |\n| --- | --- |\n| c | d |\n'
let state = EditorState.create({
  doc: table,
  extensions: [objectBlocksExtension({})]
})
assert.equal(objectBlocksIn(state).length, 1, 'the StateField exposes the detected object blocks')
assert.deepEqual(
  objectDecorations(state).map(({ from, to }) => ({ from, to })),
  [{ from: 0, to: table.length - 1 }],
  'the visual replacement stops at the last line end and leaves the newline outside'
)

state = state.update({ effects: setRawObjectBlock.of({ from: 0, raw: true }) }).state
assert.equal(objectDecorations(state)[0].widget.raw, true, 'raw state rebuilds the widget in place')

state = state.update({ effects: setOpenObjectBlock.of({ from: 0, to: table.length }) }).state
assert.equal(objectDecorations(state).length, 0, 'an open object removes its closed preview widget')
assert.equal(editorDecorations(state).length, 1, 'an open object is replaced by its mounted editor')
assert.equal(
  typeof objectField.canRunInlineFormatting,
  'function',
  'the object field exports the real Editor formatting gate'
)
assert.equal(
  objectField.canRunInlineFormatting(state),
  false,
  'the real Editor formatting gate refuses formatting while an object editor shell is open'
)
assert.equal(
  objectField.canRunInlineFormatting(state.update({ effects: setOpenObjectBlock.of(null) }).state),
  true,
  'the real Editor formatting gate re-enables formatting after the object shell closes'
)

const view = fakeView(
  EditorState.create({
    doc: table,
    selection: { anchor: 0 },
    extensions: [objectBlocksExtension({})]
  })
)
assert.equal(toggleRawObjectAtSelection(view), true, 'registered raw command toggles the selected widget')
assert.equal(objectDecorations(view.state)[0].widget.raw, true, 'registered raw command exposes markup')
assert.equal(toggleRawObjectAtSelection(view), true, 'registered raw command toggles back to the rendering')
assert.equal(openSelectedObject(view), true, 'Enter-chain command opens a closed selected object')
assert.equal(objectDecorations(view.state).length, 0, 'the command removes the closed rendering')
assert.equal(editorDecorations(view.state).length, 1, 'the command swaps the block for its editor')
assert.equal(openSelectedObject(view), false, 'Enter falls through when the selected object is already open')
assert.equal(closeOpenObject(view), true, 'Escape or Mod-Enter closes the open object')
assert.equal(objectDecorations(view.state).length, 1, 'closing restores the rendered widget')
assert.equal(closeOpenObject(view), false, 'close falls through when no object is open')

const unfinishedFence = '```mermaid'
const fenceView = fakeView(EditorState.create({
  doc: unfinishedFence,
  selection: { anchor: unfinishedFence.length },
  extensions: [objectBlocksExtension({})]
}))
assert.equal(
  openSelectedObject(fenceView),
  false,
  'Enter after a hand-typed unterminated fence header falls through to normal editing'
)
fenceView.dispatch(fenceView.state.update({
  changes: { from: unfinishedFence.length, insert: '\n' },
  selection: { anchor: unfinishedFence.length + 1 },
  userEvent: 'input'
}))
assert.equal(
  fenceView.state.doc.toString(),
  '```mermaid\n',
  'Enter after a hand-typed fence header inserts a normal newline'
)

const unfinishedBody = '```mermaid\nflowchart LR\n  A --> B'
const bodyInsertAt = unfinishedBody.indexOf('LR') + 2
const bodyView = fakeView(EditorState.create({
  doc: unfinishedBody,
  selection: { anchor: bodyInsertAt },
  extensions: [objectBlocksExtension({})]
}))
assert.equal(
  inputText(bodyView, bodyInsertAt, bodyInsertAt, 'X'),
  false,
  'typing inside an unterminated fence body is not intercepted as a closed object'
)
assert.equal(
  bodyView.state.doc.toString(),
  `${unfinishedBody.slice(0, bodyInsertAt)}X${unfinishedBody.slice(bodyInsertAt)}`,
  'the keystroke remains at its typed position inside an unfinished fence body'
)

const secondTable = '| x | y |\n| --- | --- |\n| z | q |\n'
const twoTables = `${table}\n${secondTable}`
const secondFrom = twoTables.indexOf(secondTable)
const otherClosedView = fakeView(EditorState.create({
  doc: twoTables,
  selection: { anchor: secondFrom },
  extensions: [objectBlocksExtension({})]
}))
otherClosedView.dispatch({
  effects: setOpenObjectBlock.of({ from: 0, to: table.length }),
  selection: { anchor: secondFrom }
})
assert.equal(
  inputText(otherClosedView, secondFrom, secondFrom, 'X'),
  true,
  'an open first object does not disable type escape on a different closed object'
)
assert.equal(
  otherClosedView.state.doc.sliceString(secondFrom, secondFrom + secondTable.length),
  secondTable,
  'typing at closed block B is intercepted instead of changing its source while block A is open'
)
assert.equal(
  otherClosedView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'type escape dispatches an input user event for focus, undo, and protection guards'
)

const reanchorView = fakeView(EditorState.create({
  doc: table,
  selection: { anchor: 0 },
  extensions: [objectBlocksExtension({})]
}))
assert.equal(openSelectedObject(reanchorView), true, 'the table opens before the start-edge edit')
reanchorView.dispatch(reanchorView.state.update({
  changes: { from: 0, insert: '\n' },
  selection: { anchor: 1 },
  userEvent: 'input'
}))
assert.equal(
  editorDecorations(reanchorView.state).length,
  1,
  'an open block start edit re-anchors the editor record on the same block'
)
assert.equal(
  inputText(reanchorView, 1, 1, 'X', false),
  false,
  'type escape stays disabled for the re-anchored open block under the caret'
)

const rawTransplantDoc = `${table}\n${secondTable}`
const rawTransplantView = fakeView(EditorState.create({
  doc: rawTransplantDoc,
  extensions: [objectBlocksExtension({})]
}))
rawTransplantView.dispatch({ effects: setRawObjectBlock.of({ from: 0, raw: true }) })
assert.equal(objectDecorations(rawTransplantView.state)[0].widget.raw, true, 'the first object starts raw')
rawTransplantView.dispatch({
  changes: { from: 0, to: table.length + 1 },
  userEvent: 'delete'
})
assert.equal(
  objectDecorations(rawTransplantView.state)[0].widget.raw,
  false,
  'deleting a raw object prunes its offset instead of transplanting raw mode to the next object'
)

const focusedDoc = [
  '### Hidden slide',
  table.trimEnd(),
  '',
  '### Visible slide',
  table.trimEnd(),
  ''
].join('\n')
const visibleFrom = focusedDoc.indexOf('### Visible slide')
state = EditorState.create({
  doc: focusedDoc,
  extensions: [
    focusScopeExtension(() => ({ from: visibleFrom, to: focusedDoc.length })),
    objectBlocksExtension({})
  ]
})
assert.equal(objectBlocksIn(state).length, 2, 'detection still reports the whole canonical document')
assert.deepEqual(
  objectDecorations(state).map(({ widget }) => widget.block.from),
  [focusedDoc.lastIndexOf('| a | b |')],
  'widget decoration is omitted for an object in the Slide Focus hidden band'
)

const hiddenTableFrom = focusedDoc.indexOf('| a | b |')
const hiddenCaretView = fakeView(EditorState.create({
  doc: focusedDoc,
  selection: { anchor: hiddenTableFrom },
  extensions: [
    focusScopeExtension(() => ({ from: visibleFrom, to: focusedDoc.length })),
    objectBlocksExtension({})
  ]
}))
assert.equal(
  openSelectedObject(hiddenCaretView),
  false,
  'activeBlock ignores objects in the Slide Focus hidden band'
)
hiddenCaretView.dispatch({
  effects: setOpenObjectBlock.of({ from: hiddenTableFrom, to: hiddenTableFrom + table.length })
})
assert.equal(
  editorDecorations(hiddenCaretView.state).length,
  0,
  'an open effect cannot paint an editor outside the Slide Focus band'
)
assert.equal(
  inputText(hiddenCaretView, hiddenTableFrom, hiddenTableFrom, 'X'),
  false,
  'type escape ignores objects in the Slide Focus hidden band'
)
assert.equal(
  hiddenCaretView.state.doc.toString(),
  focusedDoc,
  'the focus guard rejects the ordinary input transaction in the hidden band'
)

const focusedTableFrom = focusedDoc.lastIndexOf('| a | b |')
const focusedTypeView = fakeView(EditorState.create({
  doc: focusedDoc,
  selection: { anchor: focusedTableFrom },
  extensions: [
    focusScopeExtension(() => ({ from: visibleFrom, to: focusedDoc.length })),
    objectBlocksExtension({})
  ]
}))
assert.equal(
  inputText(focusedTypeView, focusedTableFrom, focusedTableFrom, 'Y'),
  true,
  'type escape still handles a closed object inside the visible focus range'
)
assert.equal(
  focusedTypeView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'the focus-visible type escape write is annotated as input'
)

const openFirstArrowDownView = fakeView(EditorState.create({
  doc: twoTables.trimEnd(),
  selection: { anchor: secondFrom },
  extensions: [objectBlocksExtension({})]
}))
openFirstArrowDownView.dispatch({
  effects: setOpenObjectBlock.of({ from: 0, to: table.length }),
  selection: { anchor: secondFrom }
})
assert.equal(
  runKey(openFirstArrowDownView, 'ArrowDown'),
  true,
  'an open first object does not disable ArrowDown escape on a different closed trailing object'
)
assert.equal(
  openFirstArrowDownView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'the closed-block ArrowDown escape is annotated as input'
)

const openFirstArrowRightView = fakeView(EditorState.create({
  doc: twoTables.trimEnd(),
  selection: { anchor: secondFrom },
  extensions: [objectBlocksExtension({})]
}))
openFirstArrowRightView.dispatch({
  effects: setOpenObjectBlock.of({ from: 0, to: table.length }),
  selection: { anchor: secondFrom }
})
assert.equal(
  runKey(openFirstArrowRightView, 'ArrowRight'),
  true,
  'an open first object does not disable ArrowRight escape on a different closed trailing object'
)
assert.equal(
  openFirstArrowRightView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'the closed-block ArrowRight escape is annotated as input'
)

const firstClosedSecondOpen = `${table}${secondTable}`
const secondOpenFrom = firstClosedSecondOpen.indexOf(secondTable)
const arrowUpView = fakeView(EditorState.create({
  doc: firstClosedSecondOpen,
  selection: { anchor: 0 },
  extensions: [objectBlocksExtension({})]
}))
arrowUpView.dispatch({
  effects: setOpenObjectBlock.of({ from: secondOpenFrom, to: firstClosedSecondOpen.length }),
  selection: { anchor: 0 }
})
assert.equal(
  runKey(arrowUpView, 'ArrowUp'),
  true,
  'an open later object does not disable ArrowUp escape on a different closed leading object'
)
assert.equal(
  arrowUpView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'the closed-block ArrowUp escape is annotated as input'
)

const backspaceView = fakeView(EditorState.create({
  doc: twoTables,
  selection: { anchor: secondFrom + secondTable.length },
  extensions: [objectBlocksExtension({})]
}))
backspaceView.dispatch({
  effects: setOpenObjectBlock.of({ from: 0, to: table.length }),
  selection: { anchor: secondFrom + secondTable.length }
})
assert.equal(
  runKey(backspaceView, 'Backspace'),
  true,
  'an open first object does not disable Backspace protection after a different closed object'
)

const rawOtherView = fakeView(EditorState.create({
  doc: twoTables,
  selection: { anchor: secondFrom },
  extensions: [objectBlocksExtension({})]
}))
rawOtherView.dispatch({
  effects: setOpenObjectBlock.of({ from: 0, to: table.length }),
  selection: { anchor: secondFrom }
})
assert.equal(
  toggleRawObjectAtSelection(rawOtherView),
  true,
  'an open first object does not disable the raw toggle on a different closed object'
)

let insertMenuOpened = false
const fenceTriggerView = fakeView(EditorState.create({
  doc: '``',
  selection: { anchor: 2 },
  extensions: [objectBlocksExtension({ onInsertMenu: () => { insertMenuOpened = true } })]
}))
assert.equal(inputText(fenceTriggerView, 2, 2, '`'), true, 'the third backtick opens the insert menu')
assert.equal(insertMenuOpened, true, 'the fence-trigger callback ran')
assert.equal(
  fenceTriggerView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'the fence-trigger rewrite is annotated as input'
)

const arrowView = fakeView(EditorState.create({
  doc: table.trimEnd(),
  selection: { anchor: 0 },
  extensions: [objectBlocksExtension({})]
}))
assert.equal(runKey(arrowView, 'ArrowDown'), true, 'ArrowDown escapes a trailing closed object')
assert.equal(
  arrowView.transactions.at(-1)?.annotation(Transaction.userEvent),
  'input',
  'the ArrowDown escape write is annotated as input'
)

const dom = installTestDom()
const originalConsoleError = console.error
try {
  const legalGfm = '| a | b |\n|-|-|\n| 1 | 2 |\n'
  const refusalView = fakeView(EditorState.create({
    doc: legalGfm,
    selection: { anchor: 0 },
    extensions: [objectBlocksExtension({})]
  }))
  assert.equal(openSelectedObject(refusalView), true)
  const originalWidget = editorDecorations(refusalView.state)[0].widget
  const shell = originalWidget.toDOM(refusalView)
  const markup = markupEditor(shell)
  markup.value = ''
  markup.dispatchEvent(new TestEvent('input'))

  console.error = () => {}
  const autosaveStamp = '<!-- autosave stamp -->\n'
  refusalView.dispatch({
    changes: { from: 0, insert: autosaveStamp },
    selection: { anchor: autosaveStamp.length },
    userEvent: 'input'
  })
  const shiftedWidget = editorDecorations(refusalView.state)[0].widget
  const beforeTeardownRefusal = refusalView.state.doc.toString()
  assert.equal(
    shiftedWidget.updateDOM(shell, refusalView, originalWidget),
    true,
    'a refused teardown reuses the existing editor DOM instead of destroying the shell'
  )
  assert.equal(
    markup.value,
    '',
    'a refused teardown leaves the user’s typed pane content in the live shell'
  )
  assert.equal(
    shell.querySelector('.oe-parse-note').hidden,
    false,
    'a refused teardown shows its commit reason in the still-open shell'
  )
  assert.match(
    shell.querySelector('.oe-parse-note').textContent,
    /not saved.*inner source was empty.*text is still here/i,
    'the teardown refusal names the reason and says the text remains'
  )
  assert.equal(
    refusalView.state.doc.toString(),
    beforeTeardownRefusal,
    'the refused teardown leaves the canonical document byte-unchanged'
  )
  assert.equal(
    shell.querySelector('.oe-discard'),
    null,
    'the abandoned pending-restore design no longer adds a discard affordance'
  )
  assert.equal(
    'pending' in shiftedWidget,
    false,
    'the open widget carries no pending edit record'
  )

  const unstampedPrefix = '## Objects\n\n'
  const stampedPrefix = '## Objects\n{id=objects}\n\n'
  const rawStampView = fakeView(EditorState.create({
    doc: `${unstampedPrefix}${legalGfm}`,
    selection: { anchor: unstampedPrefix.length },
    extensions: [objectBlocksExtension({})]
  }))
  const beforeStampWidget = objectDecorations(rawStampView.state)[0].widget
  rawStampView.dispatch({
    changes: {
      from: '## Objects\n'.length,
      to: unstampedPrefix.length,
      insert: '{id=objects}\n\n'
    }
  })
  const afterStampWidget = objectDecorations(rawStampView.state)[0].widget
  assert.equal(
    rawStampView.state.doc.toString(),
    `${stampedPrefix}${legalGfm}`,
    'the regression fixture models save-time heading-id insertion above the object'
  )
  assert.equal(
    afterStampWidget.eq(beforeStampWidget),
    false,
    'a shifted object widget rebuilds its DOM so the raw button dispatches the new offset'
  )

  const unrecoverable = []
  dom.window.addEventListener('tw-toast', (event) => unrecoverable.push(event.detail))
  const deletedView = fakeView(EditorState.create({
    doc: legalGfm,
    selection: { anchor: 0 },
    extensions: [objectBlocksExtension({})]
  }))
  assert.equal(openSelectedObject(deletedView), true)
  const deletedWidget = editorDecorations(deletedView.state)[0].widget
  const deletedShell = deletedWidget.toDOM(deletedView)
  markupEditor(deletedShell).value = ''
  deletedView.dispatch({
    changes: { from: 0, to: deletedView.state.doc.length, insert: 'The object was deleted.' }
  })
  deletedWidget.destroy(deletedShell)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(
    unrecoverable.length,
    1,
    'destroying a refused edit whose block was deleted raises one visible failure'
  )
  assert.match(
    unrecoverable[0].message,
    /unsaved.*could not be kept.*object block no longer exists/i,
    'the visible failure names why the typed content became unrecoverable'
  )
  assert.equal(unrecoverable[0].level, 'error', 'the unrecoverable edit raises a persistent error toast')

  const diagnosticView = fakeView(EditorState.create({
    doc: legalGfm,
    selection: { anchor: 0 },
    extensions: [objectBlocksExtension({})]
  }))
  assert.equal(openSelectedObject(diagnosticView), true)
  const diagnosticWidget = editorDecorations(diagnosticView.state)[0].widget
  const diagnosticShell = diagnosticWidget.toDOM(diagnosticView)
  markupEditor(diagnosticShell).value =
    '| changed | b |\n|-|-|\n| 1 | 2 |'
  const ordinaryDispatch = diagnosticView.dispatch.bind(diagnosticView)
  diagnosticView.dispatch = (spec) => {
    ordinaryDispatch(spec)
    diagnosticView.state = diagnosticView.state.update({
      changes: { from: 2, to: 3, insert: '!' }
    }).state
  }
  const diagnostics = []
  console.error = (message) => diagnostics.push(String(message))
  diagnosticShell.querySelector('.oe-done').dispatchEvent(new TestEvent('click'))
  assert.equal(
    diagnosticShell.classList.contains('oe-commit-refused'),
    false,
    'a post-dispatch diagnostic does not report the already-landed write as refused'
  )
  assert.equal(
    diagnostics.some((message) => message.includes('rejected by a document guard')),
    true,
    'a post-dispatch mismatch remains a loud diagnostic'
  )
} finally {
  console.error = originalConsoleError
  dom.restore()
}

console.log('test:object-block-field OK')
