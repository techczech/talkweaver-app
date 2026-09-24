import { EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { runActionBarEditing } from '../components/actionBar/editing-command'
import { EditorSelection, type StateCommand } from '@codemirror/state'
import { shortcutById } from '../../../shared/shortcut-registry'
import { notify } from '../lib/notify'
import {
  closeOpenObject,
  hasOpenObjectBlock,
  openSelectedObject,
  toggleRawObjectAtSelection
} from '../extensions/objectBlocks/field'
import {
  moveNode,
  reLevel,
  enterFromHeading,
  enterFromProtectedLine,
  continueList,
  indentList,
  outdentList,
  setHeadingFromPrevious,
  jumpHeading,
  deleteSlideAtCursor
} from '../extensions/outliner'

export interface EditorCommand {
  id: string
  label: string
  category: string
  keys: string
  shortcutId: string
  unbound: boolean
  run: (view: EditorView) => boolean
}

function delimiterRunFromStart(text: string, character: string): number {
  let length = 0
  while (text[length] === character) length += 1
  return length
}

function delimiterRunFromEnd(text: string, character: string): number {
  let length = 0
  while (text[text.length - length - 1] === character) length += 1
  return length
}

function delimiterRunBefore(view: EditorView, position: number, character: string): number {
  let length = 0
  while (
    position - length - 1 >= 0
    && view.state.sliceDoc(position - length - 1, position - length) === character
  ) length += 1
  return length
}

function delimiterRunAfter(view: EditorView, position: number, character: string): number {
  let length = 0
  while (
    position + length < view.state.doc.length
    && view.state.sliceDoc(position + length, position + length + 1) === character
  ) length += 1
  return length
}

function hasExactMarkerLayer(marker: string, before: number, after: number): boolean {
  // Three stars are bold + italic, while two are bold only. Odd star runs therefore carry the
  // single-star layer; removing one preserves every paired bold layer underneath.
  if (marker === '*') return before === after && before % 2 === 1
  // A paired layer also exists inside a longer balanced run: *** is bold wrapped around italic,
  // so removing ** leaves *, symmetrically with removing * from the same run.
  if (marker === '**') return before === after && before >= marker.length
  return before === marker.length && after === marker.length
}

function markerLayerRuns(text: string, marker: string): Array<{ from: number; to: number }> {
  const character = marker[0]
  const runs = []
  let cursor = 0
  while (cursor < text.length) {
    if (text[cursor] !== character) {
      cursor += 1
      continue
    }
    const from = cursor
    while (text[cursor] === character) cursor += 1
    const length = cursor - from
    const carriesLayer = marker === '*'
      ? length % 2 === 1
      : marker === '**'
        ? length >= marker.length
        : length === marker.length
    if (carriesLayer) runs.push({ from, to: cursor })
  }
  return runs
}

function toggleInlineMarker(
  marker: string,
  invalidSelection?: { test: (selection: string) => boolean; message: string }
) {
  return (view: EditorView): boolean => {
    const n = marker.length
    const isPairedSurroundingLayer = (
      range: typeof view.state.selection.main,
      selection: string,
      before: number,
      after: number
    ): boolean => {
      if (
        selection.includes(marker)
        || !hasExactMarkerLayer(marker, before, after)
      ) return false
      const line = view.state.doc.lineAt(range.from)
      if (range.to > line.to) return false
      const pairedRuns = markerLayerRuns(line.text, marker)
        .map((run) => ({ from: line.from + run.from, to: line.from + run.to }))
      const beforeIndex = pairedRuns.findIndex((run) => run.to === range.from)
      const afterIndex = pairedRuns.findIndex((run) => run.from === range.to)
      return beforeIndex >= 0
        && beforeIndex % 2 === 0
        && afterIndex === beforeIndex + 1
    }
    const canUnwrap = (range: typeof view.state.selection.main): boolean => {
      if (range.empty) return false
      const selection = view.state.sliceDoc(range.from, range.to)
      const character = marker[0]
      return (
        selection.length >= 2 * n
        && hasExactMarkerLayer(
          marker,
          delimiterRunFromStart(selection, character),
          delimiterRunFromEnd(selection, character)
        )
      ) || isPairedSurroundingLayer(
        range,
        selection,
        delimiterRunBefore(view, range.from, character),
        delimiterRunAfter(view, range.to, character)
      )
    }
    let refusedRange = false
    const tr = view.state.changeByRange((range) => {
      if (range.empty) {
        return { changes: { from: range.from, insert: marker + marker }, range: EditorSelection.cursor(range.from + n) }
      }
      const selection = view.state.sliceDoc(range.from, range.to)
      if (invalidSelection?.test(selection) && !canUnwrap(range)) {
        refusedRange = true
        return { range }
      }
      const character = marker[0]
      const selectedLayer = selection.length >= 2 * n && hasExactMarkerLayer(
        marker,
        delimiterRunFromStart(selection, character),
        delimiterRunFromEnd(selection, character)
      )
      if (selectedLayer) {
        const inner = selection.slice(n, -n)
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length)
        }
      }
      const surroundingLayer = isPairedSurroundingLayer(
        range,
        selection,
        delimiterRunBefore(view, range.from, character),
        delimiterRunAfter(view, range.to, character)
      )
      if (surroundingLayer) {
        return {
          changes: [
            { from: range.from - n, to: range.from },
            { from: range.to, to: range.to + n }
          ],
          range: EditorSelection.range(range.from - n, range.to - n)
        }
      }
      const whitespace = selection.match(/^(\s*)([\s\S]*?\S)(\s*)$/)
      if (whitespace) {
        const [, leading, inner, trailing] = whitespace
        const insert = `${leading}${marker}${inner}${marker}${trailing}`
        const innerFrom = range.from + leading.length + n
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.range(innerFrom, innerFrom + inner.length)
        }
      }
      return {
        changes: { from: range.from, to: range.to, insert: `${marker}${selection}${marker}` },
        range: EditorSelection.range(range.from + n, range.to + n)
      }
    })
    if (refusedRange && invalidSelection) notify(invalidSelection.message, 'warning')
    view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

export const toggleBold = toggleInlineMarker('**')
export const toggleItalic = toggleInlineMarker('*')
export const toggleInlineCode = toggleInlineMarker('`', {
  test: (selection) => selection.includes('`'),
  message: "Inline code can't contain backticks"
})
export const toggleHighlight = toggleInlineMarker(
  '==',
  {
    test: (selection) => /[=\n]/.test(selection),
    message: "Highlight can't span = characters / line breaks"
  }
)

export function isHttpUrl(text: string): boolean {
  if (!text || text !== text.trim() || /\s/.test(text)) return false
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Clipboard I/O stays outside this transaction so every caller shares one formatting path. */
export function insertMarkdownLinkFromClipboard(clipboardText: string): StateCommand {
  return ({ state, dispatch }) => {
    const useClipboard = isHttpUrl(clipboardText)
    const target = useClipboard ? clipboardText : ''
    const transaction = state.changeByRange((range) => {
      const label = state.sliceDoc(range.from, range.to)
      const insert = `[${label}](${target})`
      const labelFrom = range.from + 1
      const urlFrom = range.from + label.length + 3
      return {
        changes: { from: range.from, to: range.to, insert },
        range: useClipboard && !range.empty
          ? EditorSelection.cursor(range.from + insert.length)
          : useClipboard || range.empty
            ? EditorSelection.range(labelFrom, labelFrom + label.length)
            : EditorSelection.cursor(urlFrom)
      }
    })
    dispatch(state.update(transaction, {
      userEvent: 'input',
      scrollIntoView: true
    }))
    return true
  }
}

export function insertLink(view: EditorView): boolean {
  void (navigator.clipboard?.readText?.() ?? Promise.resolve(''))
    .then(
      (clip) => {
        // Clipboard access yields to the event loop; object editing can open while it is pending.
        // Re-check at dispatch time so inline formatting never lands inside the newly open shell.
        if (hasOpenObjectBlock(view.state)) return
        insertMarkdownLinkFromClipboard(clip)(view)
      },
      () => notify('Couldn’t read the clipboard — paste with ⌘V instead.', 'warning')
    )
  return true
}

const consume =
  (fn: (view: EditorView) => unknown) =>
  (view: EditorView): boolean => {
    fn(view)
    return true
  }

function command(id: string, run: (view: EditorView) => boolean, registryId = `editor.${id}`): EditorCommand {
  const shortcut = shortcutById(registryId)
  return {
    id,
    label: shortcut.label,
    category: shortcut.group,
    keys: shortcut.codes[0] ?? '',
    shortcutId: registryId,
    unbound: shortcut.unbound === true,
    run
  }
}

// shortcut-id: app.sidebar-talks app.sidebar-outline app.sidebar-toggle
// shortcut-id: editor.move-up editor.move-down editor.promote editor.demote
// shortcut-id: editor.promote-subtree editor.demote-subtree editor.heading-same editor.heading-sub
// shortcut-id: editor.jump-prev editor.jump-next editor.delete-slide editor.object-edit editor.object-raw editor.object-finish editor.object-leave editor.title-continue editor.protected-line-continue editor.list-continue
// shortcut-id: editor.list-indent editor.list-outdent editor.bold
// shortcut-id: editor.italic editor.inline-code editor.highlight editor.link
export const EDITOR_COMMANDS: EditorCommand[] = [
  command('sidebar.talks', () => false, 'app.sidebar-talks'),
  command('sidebar.outline', () => false, 'app.sidebar-outline'),
  command('sidebar.toggle', () => false, 'app.sidebar-toggle'),
  command('undo', undo),
  command('redo', redo),
  command('new-slide', (view) => runActionBarEditing(view, 'new-slide')),
  command('bulleted-list', (view) => runActionBarEditing(view, 'bulleted-list')),
  command('numbered-list', (view) => runActionBarEditing(view, 'numbered-list')),
  command('move-up', consume((view) => moveNode(view, 'up'))),
  command('move-down', consume((view) => moveNode(view, 'down'))),
  command('promote', consume((view) => reLevel(view, -1, false))),
  command('demote', consume((view) => reLevel(view, 1, false))),
  command('promote-subtree', consume((view) => reLevel(view, -1, true))),
  command('demote-subtree', consume((view) => reLevel(view, 1, true))),
  command('heading-same', (view) => setHeadingFromPrevious(view, 'same')),
  command('heading-sub', (view) => setHeadingFromPrevious(view, 'sub')),
  command('jump-prev', (view) => jumpHeading(view, 'up')),
  command('jump-next', (view) => jumpHeading(view, 'down')),
  command('delete-slide', consume((view) => deleteSlideAtCursor(view))),
  command('object-edit', (view) => openSelectedObject(view)),
  command('object-raw', (view) => toggleRawObjectAtSelection(view)),
  command('object-finish', (view) => closeOpenObject(view)),
  command('object-leave', (view) => closeOpenObject(view)),
  command('title-continue', (view) => enterFromHeading(view)),
  command('protected-line-continue', (view) => enterFromProtectedLine(view)),
  command('list-continue', (view) => continueList(view)),
  command('list-indent', (view) => indentList(view)),
  command('list-outdent', (view) => outdentList(view)),
  command('bold', toggleBold),
  command('italic', toggleItalic),
  command('inline-code', toggleInlineCode),
  command('highlight', toggleHighlight),
  command('link', insertLink)
]

export const NON_CONSUMING = new Set([
  'object-edit',
  'object-finish',
  'object-leave',
  'title-continue',
  'protected-line-continue',
  'list-continue'
])

const GLYPH: Record<string, string> = {
  Mod: '⌘', Cmd: '⌘', Meta: '⌘', Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Backspace: '⌫',
  Delete: '⌦', Tab: 'Tab', Escape: 'Esc'
}

export function displayKeys(cmKey: string): string[] {
  return cmKey.split('-').map((part) => GLYPH[part] ?? (part.length === 1 ? part.toUpperCase() : part))
}
