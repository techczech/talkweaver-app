import { strict as assert } from 'node:assert'
import { EditorState } from '@codemirror/state'
import {
  flashTriggerEchoAt,
  setTriggerEcho,
  triggerEchoChange,
  triggerEchoTokenChanged,
  triggerEchoRange,
  triggerEchoRangeAt,
  triggerEchoState,
} from '../src/renderer/src/extensions/triggerEcho.ts'

const doc = '### Chart\n{chart=bar}{id=abc12}\n\n- Alpha: 40\n'
let state = EditorState.create({
  doc,
  extensions: [triggerEchoState],
})
const range = triggerEchoRangeAt(state.doc, doc.indexOf('Alpha'), 'chart=bar')
assert.deepEqual(
  range && state.doc.sliceString(range.from, range.to),
  '{chart=bar}',
  'the amber echo targets only the newly written token, not the neighbouring slide id'
)
state = state.update({ effects: setTriggerEcho.of(range) }).state
assert.deepEqual(triggerEchoRange(state), range, 'the transient echo range enters editor state')

state = state.update({ changes: { from: 0, insert: '# Deck\n\n' } }).state
assert.deepEqual(
  triggerEchoRange(state),
  { from: range.from + 8, to: range.to + 8 },
  'the amber range maps with later document changes until its timeout clears it'
)
assert.equal(
  triggerEchoRangeAt(state.doc, 0, 'chart=bar'),
  null,
  'content with no owning slide Trigger line never manufactures an echo'
)
assert.equal(
  triggerEchoTokenChanged('{id=abc12}{chart=pie}', '{id=abc12}{chart=bar}'),
  'chart=bar',
  'trigger replacement identifies the newly written token without echoing the stable id'
)
assert.equal(
  triggerEchoTokenChanged('{id=abc12}{chart=bar}', '{id=abc12}'),
  null,
  'a token removal does not invent a token to echo'
)

const duplicateDoc = '### Chart\n{chart=bar}{chart=bar}\n\n- Alpha: 40\n'
const duplicateState = EditorState.create({ doc: duplicateDoc })
const firstChartToken = duplicateDoc.indexOf('{chart=bar}')
const duplicateChange = triggerEchoChange(
  '{mindmap}{chart=bar}',
  '{chart=bar}{chart=bar}'
)
assert.deepEqual(
  duplicateChange,
  { token: 'chart=bar', occurrence: 0, from: 0, to: 11 },
  'the positional diff identifies the newly written first copy of an otherwise identical token'
)
const duplicateRange = triggerEchoRangeAt(
  duplicateState.doc,
  firstChartToken + duplicateChange.from,
  'chart=bar'
)
assert.equal(
  duplicateRange?.from,
  firstChartToken,
  'two identical tokens echo the newly written first occurrence, not the later stable occurrence'
)

const originalSetTimeout = globalThis.setTimeout
let clearTimer = null
globalThis.setTimeout = (callback) => {
  clearTimer = callback
  return 1
}
try {
  let destroyedState = EditorState.create({
    doc,
    extensions: [triggerEchoState],
  })
  let dispatches = 0
  const view = {
    get state() { return destroyedState },
    dom: { isConnected: true },
    destroyed: false,
    dispatch(spec) {
      dispatches += 1
      destroyedState = destroyedState.update(spec).state
    },
  }
  flashTriggerEchoAt(view, doc.indexOf('Alpha'), 'chart=bar')
  assert.equal(dispatches, 1, 'flashing the token enters the echo state once')
  view.destroyed = true
  clearTimer()
  assert.equal(
    dispatches,
    1,
    'the echo timeout does not dispatch into a destroyed CodeMirror view'
  )
} finally {
  globalThis.setTimeout = originalSetTimeout
}

console.log('test:trigger-echo OK')
