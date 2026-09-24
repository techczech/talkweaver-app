import { strict as assert } from 'node:assert'
import { installTestDom, TestEvent, TestKeyboardEvent } from './test-dom.mjs'

const { mountShell, textareaEditor } =
  await import(new URL('../src/renderer/src/objects/shell.ts', import.meta.url))

function mountWithParent(options = {}) {
  const parent = document.createElement('div')
  let committed = null
  const shell = mountShell({
    kind: 'Test',
    editor: options.editor ?? textareaEditor('source'),
    foot: 'test',
    api: {
      preflight: () => options.preflightResult ?? { ok: true },
      commit: (source) => {
        committed = source
        return { ok: true }
      },
    },
    cheatSheet: options.cheatSheet,
  })
  parent.append(shell)
  return {
    parent,
    shell,
    committed: () => committed,
  }
}

const dom = installTestDom()
try {
  {
    let commitCalls = 0
    const reason = 'replacement could not be parsed back as gfm-table without changing its bytes'
    const shell = mountShell({
      kind: 'Test',
      editor: textareaEditor('source'),
      foot: 'test',
      api: {
        preflight: () => ({ ok: false, reason }),
        commit: () => {
          commitCalls += 1
          return { ok: false, reason }
        },
      },
    })
    shell.querySelector('.oe-done').dispatchEvent(new TestEvent('click'))
    assert.equal(commitCalls, 1)
    assert.equal(shell.classList.contains('oe-commit-refused'), true)
    assert.match(
      shell.querySelector('.oe-parse-note')?.textContent ?? '',
      new RegExp(reason),
      'a refusal shows the actual commit reason'
    )
  }

  {
    const { shell, committed } = mountWithParent({
      cheatSheet: {
        isShortcut: () => false,
        request: () => {},
        isLeaveShortcut: (event) => event.key === 'Escape',
        isFinishShortcut: () => false,
      },
    })
    shell.querySelector('.oe-markup').dispatchEvent(
      new TestKeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    )
    assert.equal(committed(), 'source', 'Escape commits and leaves from inside the shell')
  }

  {
    let browse = false
    const editor = textareaEditor('source')
    editor.onEscape = () => {
      if (browse) return false
      browse = true
      return true
    }
    const { shell, committed } = mountWithParent({
      editor,
      cheatSheet: {
        isShortcut: () => false,
        request: () => {},
        isLeaveShortcut: (event) => event.key === 'Escape',
        isFinishShortcut: () => false,
      },
    })
    editor.element.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(committed(), null, 'the first table Escape remains owned by browse mode')
    editor.element.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert.equal(committed(), 'source', 'the second table Escape commits and leaves inside the shell')
  }

  for (const modifier of ['metaKey', 'ctrlKey']) {
    const { shell, committed } = mountWithParent({
      cheatSheet: {
        isShortcut: () => false,
        request: () => {},
        isLeaveShortcut: () => false,
        isFinishShortcut: (event) => event.key === 'Enter' && event[modifier],
      },
    })
    shell.querySelector('.oe-markup').dispatchEvent(new TestKeyboardEvent('keydown', {
      key: 'Enter',
      [modifier]: true,
      bubbles: true,
    }))
    assert.equal(committed(), 'source', `${modifier} + Enter commits locally inside the shell`)
  }

  {
    const { shell, committed } = mountWithParent({
      cheatSheet: {
        isShortcut: () => false,
        request: () => {},
        isLeaveShortcut: () => false,
        isFinishShortcut: () => false,
      },
    })
    const event = new TestKeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    shell.querySelector('.oe-markup').dispatchEvent(event)
    assert.equal(event.defaultPrevented, false, 'plain Enter remains ordinary input inside an open object editor')
    assert.equal(committed(), null, 'plain Enter never closes or commits an open object editor')
  }

  {
    const { shell, committed } = mountWithParent({
      cheatSheet: {
        isShortcut: () => false,
        request: () => {},
        isLeaveShortcut: () => false,
        isFinishShortcut: (event) => event.key === 'F8',
      },
    })
    shell.querySelector('.oe-markup').dispatchEvent(
      new TestKeyboardEvent('keydown', { key: 'F8', bubbles: true })
    )
    assert.equal(committed(), 'source', 'a rebound finish key commits locally inside the shell')
  }

  {
    const reason = 'the object block no longer matches the active document'
    const { shell, committed } = mountWithParent({
      preflightResult: { ok: false, reason },
    })
    const result = shell.__twPreflightTeardown()
    assert.deepEqual(result, { ok: false, reason })
    assert.equal(shell.classList.contains('oe-commit-refused'), true)
    assert.match(shell.querySelector('.oe-parse-note')?.textContent ?? '', new RegExp(reason))
    assert.equal(committed(), null, 'a teardown preflight never mutates the document')
  }

} finally {
  dom.restore()
}

console.log('test:object-editor-shell OK')
