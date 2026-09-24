import { strict as assert } from 'node:assert'
import { installTestDom, TestEvent } from './test-dom.mjs'

const { mountTableEditor, moveColumn, moveRow } =
  await import(new URL('../src/renderer/src/objects/table-editor.ts', import.meta.url))
const {
  mountObjectEditor,
  objectEditorCommitRefusal,
  objectEditorReplacement,
} =
  await import(new URL('../src/renderer/src/objects/registry.ts', import.meta.url))
const { detectObjectBlocks } =
  await import(new URL('../src/renderer/src/extensions/objectBlocks/detect.ts', import.meta.url))
const { LAYOUTS } =
  await import(new URL('../src/shared/layout-registry/entries.ts', import.meta.url))

const table = {
  cells: [['A', 'B'], ['1', '2'], ['3', '4']],
  alignments: ['left', 'right'],
}
const right = moveColumn(table, 0, 1)
assert.deepEqual(right.cells[0], ['B', 'A'])
assert.deepEqual(right.alignments, ['right', 'left'], 'alignment travels with its column')
assert.equal(moveColumn(table, 1, 1), table, 'edge move is a no-op returning the same object')
assert.equal(moveRow(table, 0, 1), table, 'the header row never moves')
assert.deepEqual(moveRow(table, 1, 1).cells, [['A', 'B'], ['3', '4'], ['1', '2']])

const dom = installTestDom()
try {
  const ordinarySource = '| a | b |\n| --- | --- |\n| c | d |\n'
  let ordinaryCommit = null
  const ordinaryShell = mountObjectEditor(
    { kind: 'gfm-table', from: 0, to: ordinarySource.length, source: ordinarySource },
    {
      commit: (next) => {
        ordinaryCommit = objectEditorReplacement(
          { kind: 'gfm-table', from: 0, to: ordinarySource.length, source: ordinarySource },
          next
        )
        return { ok: true }
      },
    }
  )
  const ordinaryCell = ordinaryShell.querySelector('.tge')
    ?.querySelectorAll('textarea')
    .find((area) => area.dataset.row === '0' && area.dataset.column === '0')
  assert(ordinaryCell, 'the ordinary pipe table mounts cell (0,0)')
  ordinaryCell.value = 'A'
  ordinaryCell.dispatchEvent(new TestEvent('input'))
  ordinaryShell.querySelector('.oe-done').dispatchEvent(new TestEvent('click'))
  assert.equal(
    ordinaryCommit,
    '| A | b |\n| --- | --- |\n| c | d |\n',
    'editing one cell changes only that line and preserves the separator row'
  )

  const escapeEditor = mountTableEditor(ordinarySource)
  const escapeParent = document.createElement('div')
  escapeParent.append(escapeEditor.element)
  let bubbledCellEscapes = 0
  escapeParent.addEventListener('keydown', () => { bubbledCellEscapes += 1 })
  const escapeCell = escapeEditor.element.querySelector('.tge')?.querySelector('textarea')
  assert(escapeCell, 'the Escape routing probe mounts a table cell')
  escapeCell.focus()
  escapeCell.dispatchEvent(new TestEvent('keydown', {
    key: 'Escape',
    bubbles: true,
  }))
  assert.equal(
    bubbledCellEscapes,
    0,
    'Escape from a focused table cell is consumed locally before the shell leave handler'
  )
  assert.equal(
    document.activeElement,
    escapeEditor.element,
    'the first focused-cell Escape deterministically enters table browse mode'
  )
  escapeEditor.destroy?.()

  const source = '| a | b |\n|-|-|\n| 1 | 2 |\n'
  const documentSource = `intro\n\n${source}\noutro\n`
  const [block] = detectObjectBlocks(documentSource)
  assert.equal(block?.kind, 'gfm-table', 'the legal short-separator table is detected as an object')
  assert.equal(block?.source, source, 'detection preserves the complete table source')
  let committedDocument = null
  const shell = mountObjectEditor(block, {
    commit: (next) => {
      const replacement = objectEditorReplacement(block, next)
      const refusal = objectEditorCommitRefusal(block, documentSource, replacement, next)
      if (refusal) return { ok: false, reason: refusal }
      committedDocument =
        `${documentSource.slice(0, block.from)}${replacement}${documentSource.slice(block.to)}`
      return { ok: true }
    },
  })
  assert(shell, 'the detected GFM table mounts an editor shell')
  assert(
    shell.querySelector('.tge-wrap'),
    'a legal short-separator GFM table mounts the visual grid'
  )
  const shortCell = shell.querySelector('.tge')
    ?.querySelectorAll('textarea')
    .find((area) => area.dataset.row === '0' && area.dataset.column === '0')
  assert(shortCell, 'the short-separator grid exposes cell (0,0)')
  shortCell.value = 'aX'
  shortCell.dispatchEvent(new TestEvent('input'))
  shell.querySelector('.oe-done').dispatchEvent(new TestEvent('click'))
  assert.equal(
    committedDocument,
    'intro\n\n| aX | b |\n|-|-|\n| 1 | 2 |\n\noutro\n',
    'typing and committing the grid preserves the legal short separator and every byte outside it'
  )

  const spacedShortSource = '| a | b |\n| - | - |\n| 1 | 2 |\n'
  const spacedShortEditor = mountTableEditor(spacedShortSource)
  assert(spacedShortEditor, 'the spaced one-dash separator mounts the visual grid')
  assert.equal(
    spacedShortEditor.serialise(),
    spacedShortSource,
    'the spaced one-dash separator round-trips byte-for-byte through the grid'
  )
  spacedShortEditor.destroy?.()

  const raggedSource = '| a | b |\n| - | - |\n| short |\n| x | y | overflow |\n'
  const raggedEditor = mountTableEditor(raggedSource)
  assert(raggedEditor, 'a ragged GFM table mounts the visual grid')
  assert(
    raggedEditor.serialise().includes('| x | y | overflow |'),
    'the mounted ragged grid keeps its overflow cell'
  )
  raggedEditor.destroy?.()

  const unparseableSource = '| a | b |\n| :: | -- |\n| c | d |\n'
  assert.equal(
    mountTableEditor(unparseableSource),
    null,
    'the table editor never fabricates a grid for content it cannot parse'
  )
  const [unparseableBlock] = detectObjectBlocks(unparseableSource)
  assert.equal(unparseableBlock?.kind, 'gfm-table', 'the compiler-mirroring detector keeps the block')
  const unparseableShell = mountObjectEditor(
    unparseableBlock,
    { commit: () => ({ ok: true }) }
  )
  assert.equal(
    unparseableShell.querySelector('.tge-wrap'),
    null,
    'a genuinely unparseable detected table mounts markup-only'
  )
  assert.equal(
    unparseableShell.querySelector('.oe-markup')?.value,
    unparseableSource.trimEnd(),
    'the markup-only fallback retains every unparseable byte'
  )

  const tableEntry = LAYOUTS.find((entry) => entry.name === 'table')
  const originalEditor = tableEntry.object.editor
  try {
    tableEntry.object.editor = 'outline'
    const triggerSource = '- Root\n  - Branch\n'
    const registryShell = mountObjectEditor(
      {
        kind: 'trigger-table',
        from: 0,
        to: triggerSource.length,
        source: triggerSource,
        triggerLine: 1,
      },
      { commit: () => ({ ok: true }) }
    )
    assert(
      registryShell.querySelector('.oe-outline'),
      'the registry editor declaration selects the object editor'
    )
    registryShell.__twCommit?.()
  } finally {
    tableEntry.object.editor = originalEditor
  }
} finally {
  dom.restore()
}

console.log('test:table-editor OK')
