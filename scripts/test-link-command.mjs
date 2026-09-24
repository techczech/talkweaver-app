import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { installTestDom } from './test-dom.mjs'

// Node cannot resolve the renderer's extensionless TypeScript imports directly. Bundle the real
// modules into an OS-temporary file, import them, then remove the directory immediately.
const bundleDir = mkdtempSync(join(tmpdir(), 'talk-weaver-link-command-'))
const bundleUrl = pathToFileURL(join(bundleDir, 'bundle.mjs'))
let registry
try {
  await build({
    stdin: {
      contents: [
        "export { EditorState, EditorSelection } from '@codemirror/state'",
        "export * from './src/renderer/src/keymap/registry.ts'",
        "export { objectBlocksExtension, setOpenObjectBlock } from './src/renderer/src/extensions/objectBlocks/field.ts'"
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'test-link-command-entry.ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: fileURLToPath(bundleUrl)
  })
  registry = await import(`${bundleUrl.href}?t=${Date.now()}`)
} finally {
  rmSync(bundleDir, { recursive: true, force: true })
}
const {
  EditorSelection,
  EditorState,
  insertLink,
  insertMarkdownLinkFromClipboard,
  isHttpUrl,
  objectBlocksExtension,
  setOpenObjectBlock,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic
} = registry

assert.equal(typeof isHttpUrl, 'function', 'link command exports its URL predicate')
assert.equal(typeof insertMarkdownLinkFromClipboard, 'function', 'link command exports its pure transaction core')
assert.equal(isHttpUrl('https://example.org/x'), true)
assert.equal(isHttpUrl('not a url'), false)
assert.equal(isHttpUrl(' https://padded.example '), false)

function run(doc, from, to, clip) {
  let out = null
  const state = EditorState.create({ doc, selection: { anchor: from, head: to } })
  insertMarkdownLinkFromClipboard(clip)({ state, dispatch: (tr) => { out = tr.state } })
  return out
}

// Locked mockup: selection + URL in clipboard composes the link and parks the caret after it.
let s = run('formative feedback', 0, 18, 'https://eef.example/feedback')
assert.equal(s.doc.toString(), '[formative feedback](https://eef.example/feedback)')
assert.deepEqual(
  [s.selection.main.from, s.selection.main.to],
  [s.doc.length, s.doc.length]
)
// selection + junk clipboard → empty target, caret parked in the URL slot
s = run('feedback', 0, 8, 'not a url')
assert.equal(s.doc.toString(), '[feedback]()')
assert.equal(s.selection.main.from, 11)
// empty selection + URL → empty label selected for typing
s = run('', 0, 0, 'https://x.example')
assert.equal(s.doc.toString(), '[](https://x.example)')

function commandView(doc, from, to) {
  return {
    state: EditorState.create({ doc, selection: { anchor: from, head: to } }),
    dispatch(transaction) {
      this.state = transaction.state
    },
    focus() {}
  }
}

function multiCommandView(doc, ranges) {
  return {
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(
        ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))
      ),
      extensions: [EditorState.allowMultipleSelections.of(true)]
    }),
    dispatch(transaction) {
      this.state = transaction.state
    },
    focus() {}
  }
}

function toggle(command, doc, from, to) {
  const view = commandView(doc, from, to)
  command(view)
  return view
}

let formatted = toggle(toggleItalic, '**x**', 0, 5)
assert.equal(formatted.state.doc.toString(), '***x***', 'Italic on a selected bold span adds italic without destroying bold')
formatted = toggle(toggleItalic, '***x***', 0, 7)
assert.equal(formatted.state.doc.toString(), '**x**', 'Italic on a selected bold+italic span removes only italic')
formatted = toggle(toggleItalic, '**x**', 2, 3)
assert.equal(formatted.state.doc.toString(), '***x***', 'Italic on text immediately inside bold delimiters adds an independent layer')
formatted = toggle(toggleItalic, '***x***', 3, 4)
assert.equal(formatted.state.doc.toString(), '**x**', 'Italic on text immediately inside triple delimiters removes only the italic layer')
formatted = toggle(toggleBold, '***x***', 0, 7)
assert.equal(formatted.state.doc.toString(), '*x*', 'Bold on a selected bold+italic span removes only bold')
formatted = toggle(toggleItalic, '***x***', 0, 7)
assert.equal(formatted.state.doc.toString(), '**x**', 'Italic on a selected bold+italic span removes only italic')

for (const applied of [
  [toggleBold, toggleItalic],
  [toggleItalic, toggleBold]
]) {
  for (const removed of [
    [toggleBold, toggleItalic],
    [toggleItalic, toggleBold]
  ]) {
    const view = commandView('x', 0, 1)
    for (const command of applied) command(view)
    assert.equal(view.state.doc.toString(), '***x***', 'bold and italic compose to one symmetric triple-star run')
    for (const command of removed) command(view)
    assert.equal(view.state.doc.toString(), 'x', 'bold and italic round-trip when removed in either order')
  }
}

for (const [marker, command] of [
  ['**', toggleBold],
  ['*', toggleItalic],
  ['`', toggleInlineCode],
  ['==', toggleHighlight]
]) {
  const view = commandView('formative', 0, 'formative'.length)
  command(view)
  assert.equal(view.state.doc.toString(), `${marker}formative${marker}`, `${marker} wraps the selected text`)
  command(view)
  assert.equal(view.state.doc.toString(), 'formative', `${marker} toggles the immediately surrounding markers back off`)
  assert.deepEqual(
    [view.state.selection.main.from, view.state.selection.main.to],
    [0, 'formative'.length],
    `${marker} preserves the inner selection after the second toggle`
  )
}

const dom = installTestDom()
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
try {
  const toasts = []
  dom.window.addEventListener('tw-toast', (event) => toasts.push(event.detail))

  const selectedMarker = commandView('==x==', 0, 5)
  toggleHighlight(selectedMarker)
  assert.equal(selectedMarker.state.doc.toString(), 'x', 'selecting the complete ==marker== unwraps it')
  assert.equal(toasts.length, 0, 'whole-marker unwrap does not show the equals-refusal toast')

  for (const invalidSelection of ['a=b', 'first\nsecond']) {
    const view = commandView(invalidSelection, 0, invalidSelection.length)
    toggleHighlight(view)
    assert.equal(view.state.doc.toString(), invalidSelection, 'invalid highlight selection leaves outline bytes unchanged')
  }
  assert.deepEqual(
    toasts.slice(0, 2).map((toast) => [toast.message, toast.level]),
    [
      ["Highlight can't span = characters / line breaks", 'warning'],
      ["Highlight can't span = characters / line breaks", 'warning']
    ],
    'invalid highlight selections notify through the shared renderer channel'
  )

  for (const [marker, command] of [
    ['**', toggleBold],
    ['*', toggleItalic],
    ['`', toggleInlineCode],
    ['==', toggleHighlight]
  ]) {
    const doc = `${marker}a${marker} b ${marker}c${marker}`
    const gapFrom = marker.length * 2 + 1
    const gapTo = gapFrom + 3
    const view = commandView(doc, gapFrom, gapTo)
    command(view)
    assert.equal(
      view.state.doc.toString(),
      `${marker}a${marker} ${marker}b${marker} ${marker}c${marker}`,
      `${marker} wraps text between two unrelated pairs instead of merging the pairs`
    )

    const prefix = `${marker}orphan\n`
    const pairedOnNextLine = commandView(
      `${prefix}${marker}x${marker}`,
      prefix.length + marker.length,
      prefix.length + marker.length + 1
    )
    command(pairedOnNextLine)
    assert.equal(
      pairedOnNextLine.state.doc.toString(),
      `${prefix}x`,
      `${marker} pairing is line-local, so an orphan on an earlier line cannot block a valid unwrap`
    )
  }

  const codeWithBacktick = commandView('use a ` delimiter', 0, 17)
  toggleInlineCode(codeWithBacktick)
  assert.equal(
    codeWithBacktick.state.doc.toString(),
    'use a ` delimiter',
    'inline code refuses a selection containing a backtick'
  )
  assert.deepEqual(
    toasts.at(-1),
    {
      message: "Inline code can't contain backticks",
      level: 'warning',
      key: undefined,
      action: undefined
    },
    'inline-code refusal uses the shared notification channel'
  )

  const partialCode = multiCommandView('good\nbad`range', [[0, 4], [5, 14]])
  toggleInlineCode(partialCode)
  assert.equal(
    partialCode.state.doc.toString(),
    '`good`\nbad`range',
    'a multi-cursor inline-code command applies valid ranges and leaves invalid ranges untouched'
  )
  const partialHighlight = multiCommandView('good\nbad=range', [[0, 4], [5, 14]])
  toggleHighlight(partialHighlight)
  assert.equal(
    partialHighlight.state.doc.toString(),
    '==good==\nbad=range',
    'a multi-cursor highlight command applies valid ranges and leaves invalid ranges untouched'
  )

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { readText: () => Promise.reject(new Error('denied')) } }
  })
  const rejected = commandView('label', 0, 5)
  insertLink(rejected)
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(rejected.state.doc.toString(), 'label', 'a rejected clipboard read does not compose an empty-target link')
  assert.deepEqual(
    toasts.at(-1),
    {
      message: 'Couldn’t read the clipboard — paste with ⌘V instead.',
      level: 'warning',
      key: undefined,
      action: undefined
    },
    'a rejected link clipboard read surfaces the same warning as paste'
  )

  let releaseClipboard
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        readText: () => new Promise((resolvePromise) => { releaseClipboard = resolvePromise })
      }
    }
  })
  const table = '| a |\n| --- |\n| b |\n'
  const raceDoc = `label\n\n${table}`
  const racing = {
    state: EditorState.create({
      doc: raceDoc,
      selection: { anchor: 0, head: 5 },
      extensions: [objectBlocksExtension({})]
    }),
    dispatch(spec) {
      const transaction = spec?.state && spec?.startState ? spec : this.state.update(spec)
      this.state = transaction.state
    },
    focus() {}
  }
  insertLink(racing)
  racing.dispatch({
    effects: setOpenObjectBlock.of({ from: 7, to: raceDoc.length })
  })
  releaseClipboard('https://eef.example/report')
  await new Promise((resolvePromise) => setImmediate(resolvePromise))
  assert.equal(
    racing.state.doc.toString(),
    raceDoc,
    'a link command re-checks the open object shell after the awaited clipboard read'
  )
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  dom.restore()
}

console.log('format pins: exact paired layers; unrelated pairs stay separate; invalid ranges notify without blocking valid cursors')
console.log('test:link-command OK')
