// ADR-0033 §1: an amber mark on the heading line of a slide whose text cannot fit at the readable
// minimum, with an inline note giving the registry message and how much too tall it is. Driven by a
// StateEffect (`setTextFitNotes`) so the editor never remounts; inert while no note is set.
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { textFitNoteLabel, type TextFitNote } from '../../../shared/text-fit-notes.ts'

const setNotes = StateEffect.define<readonly TextFitNote[]>()

const lineMark = Decoration.line({ class: 'cm-text-too-long-line', attributes: { 'data-text-too-long': 'true' } })

class TextFitNoteWidget extends WidgetType {
  constructor(private readonly note: TextFitNote) { super() }

  eq(other: TextFitNoteWidget): boolean {
    return other.note.line === this.note.line
      && other.note.tooTallPercent === this.note.tooTallPercent
      && other.note.message === this.note.message
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-text-too-long-note'
    el.dataset.textTooLongNote = 'true'
    el.setAttribute('role', 'note')
    el.title = `${this.note.message} ${this.note.remedy}`
    el.textContent = `⚠ ${textFitNoteLabel(this.note)}`
    return el
  }

  ignoreEvent(): boolean { return true }
}

function decorationsFor(state: import('@codemirror/state').EditorState, notes: readonly TextFitNote[]): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  for (const note of notes) {
    if (note.line < 1 || note.line > state.doc.lines) continue
    const line = state.doc.line(note.line)
    ranges.push(lineMark.range(line.from))
    ranges.push(Decoration.widget({ widget: new TextFitNoteWidget(note), side: 2 }).range(line.to))
  }
  return Decoration.set(ranges, true)
}

const textFitField = StateField.define<{ notes: readonly TextFitNote[]; decorations: DecorationSet }>({
  create: () => ({ notes: [], decorations: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setNotes)) return { notes: effect.value, decorations: decorationsFor(transaction.state, effect.value) }
    }
    if (transaction.docChanged && value.notes.length) return { notes: value.notes, decorations: value.decorations.map(transaction.changes) }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

const textFitTheme = EditorView.baseTheme({
  '.cm-line.cm-text-too-long-line': {
    boxShadow: 'inset 3px 0 0 #b7791f',
    backgroundColor: 'rgba(183, 121, 31, 0.07)'
  },
  '.cm-text-too-long-note': {
    marginLeft: '10px',
    padding: '0 6px',
    borderRadius: '4px',
    fontSize: '0.78em',
    fontWeight: '600',
    color: '#92600a',
    backgroundColor: 'rgba(183, 121, 31, 0.14)',
    whiteSpace: 'nowrap'
  }
})

export const textFitWarningExtension: Extension = [textFitField, textFitTheme]

export function setTextFitNotes(view: EditorView, notes: readonly TextFitNote[]): void {
  view.dispatch({ effects: setNotes.of(notes) })
}
