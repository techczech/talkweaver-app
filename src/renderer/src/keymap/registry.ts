import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { shortcutById } from '../../../shared/shortcut-registry'
import {
  moveNode,
  reLevel,
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
  run: (view: EditorView) => boolean
}

export function toggleBold(view: EditorView): boolean {
  const tr = view.state.changeByRange((range) => {
    if (range.empty) {
      return { changes: { from: range.from, insert: '****' }, range: EditorSelection.cursor(range.from + 2) }
    }
    const selection = view.state.sliceDoc(range.from, range.to)
    if (selection.length >= 4 && selection.startsWith('**') && selection.endsWith('**')) {
      const inner = selection.slice(2, -2)
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length)
      }
    }
    return {
      changes: { from: range.from, to: range.to, insert: `**${selection}**` },
      range: EditorSelection.range(range.from + 2, range.to + 2)
    }
  })
  view.dispatch(view.state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
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
  return { id, label: shortcut.label, category: shortcut.group, keys: shortcut.codes[0], run }
}

// shortcut-id: app.sidebar-talks app.sidebar-outline app.sidebar-toggle
// shortcut-id: editor.move-up editor.move-down editor.promote editor.demote
// shortcut-id: editor.promote-subtree editor.demote-subtree editor.heading-same editor.heading-sub
// shortcut-id: editor.jump-prev editor.jump-next editor.delete-slide editor.list-continue
// shortcut-id: editor.list-indent editor.list-outdent editor.bold
export const EDITOR_COMMANDS: EditorCommand[] = [
  command('sidebar.talks', () => false, 'app.sidebar-talks'),
  command('sidebar.outline', () => false, 'app.sidebar-outline'),
  command('sidebar.toggle', () => false, 'app.sidebar-toggle'),
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
  command('list-continue', (view) => continueList(view)),
  command('list-indent', (view) => indentList(view)),
  command('list-outdent', (view) => outdentList(view)),
  command('bold', (view) => toggleBold(view))
]

export const NON_CONSUMING = new Set(['list-continue'])

const GLYPH: Record<string, string> = {
  Mod: '⌘', Cmd: '⌘', Meta: '⌘', Ctrl: '⌃', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Backspace: '⌫',
  Delete: '⌦', Tab: 'Tab', Escape: 'Esc'
}

export function displayKeys(cmKey: string): string[] {
  return cmKey.split('-').map((part) => GLYPH[part] ?? (part.length === 1 ? part.toUpperCase() : part))
}
