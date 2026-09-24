import { strict as assert } from 'node:assert'
import { installTestDom, TestEvent } from './test-dom.mjs'

const { mountMarkmapEditor, newSibling, indentNode, outdentNode, moveNode } =
  await import(new URL('../src/renderer/src/objects/markmap-editor.ts', import.meta.url))
const { mountObjectEditor } =
  await import(new URL('../src/renderer/src/objects/registry.ts', import.meta.url))

const text = '- root\n  - child a\n  - child b'
assert.equal(newSibling(text, 0).text, '- root\n  - \n  - child a\n  - child b')
assert.equal(
  newSibling('1. a\n2. b', 0).text,
  '1. a\n2. \n2. b',
  'a numbered sibling advances its own ordinal without rewriting the following authored marker'
)
assert.equal(
  newSibling('* Root\n  * Child', 0).text,
  '* Root\n  * \n  * Child',
  'a nested sibling inherits the authored unordered marker'
)
assert.equal(indentNode(text, 2), '- root\n  - child a\n    - child b')
assert.equal(outdentNode(text, 1), '- root\n- child a\n  - child b')
const two = '- a\n  - a1\n- b'
assert.equal(moveNode(two, 0, 1), '- b\n- a\n  - a1')
assert.equal(moveNode(two, 2, 1), two)

const dom = installTestDom()
try {
  const editor = mountMarkmapEditor('* Root\n  * Child\n1. Third')
  const root = editor.element.querySelector('input[data-node="0"]')
  assert.equal(root?.value, 'Root', 'the mounted input excludes the unordered-list marker')
  root.value = 'Root EDITED'
  root.dispatchEvent(new TestEvent('input'))
  const third = editor.element.querySelector('input[data-node="2"]')
  assert.equal(third?.value, 'Third', 'the mounted input excludes the numbered-list marker')
  third.value = 'Third EDITED'
  third.dispatchEvent(new TestEvent('input'))
  assert.equal(
    editor.serialise(),
    '* Root EDITED\n  * Child\n1. Third EDITED',
    'editing node text preserves each authored list marker'
  )
  root.dispatchEvent(new TestEvent('keydown', {
    key: 'Enter',
    metaKey: true,
  }))
  root.dispatchEvent(new TestEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
  }))
  assert.equal(
    editor.serialise(),
    '* Root EDITED\n  * Child\n1. Third EDITED',
    'modified Enter never inserts a mindmap sibling before the shell handles finish'
  )
  editor.destroy?.()

  const source = '- Root\n  - Child\n'
  const shell = mountObjectEditor(
    { kind: 'mindmap', from: 0, to: source.length, source },
    { commit: () => ({ ok: true }) }
  )
  assert.deepEqual(
    shell.querySelector('.oe-tabs').querySelectorAll('button').map((button) => button.textContent),
    ['Editor', 'Markup'],
    'the mindmap shell follows the locked Editor|Markup tab labels'
  )
  shell.__twCommit?.()
} finally {
  dom.restore()
}

console.log('test:markmap-editor OK')
