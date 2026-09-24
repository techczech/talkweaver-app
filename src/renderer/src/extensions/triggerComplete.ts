// {-triggered autocomplete for TalkWeaver's outline editor (Tier 1 slide-management).
// Fires when the cursor is inside an open-brace token, e.g. `{state` or `{title=`.
// The popup lists registry-backed layouts, elements, modifiers, and the identity sigil (#id).
// On apply, the token is inserted and - if the char after the cursor is not already `}` -
// a closing brace is appended, so the author always gets `{statement}` not `{statement`.
import {
  autocompletion,
  closeCompletion,
  CompletionContext,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionSection,
  type CompletionResult
} from '@codemirror/autocomplete'
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { LAYOUTS, braceAutocompleteLabel, isFencedObjectLayout } from '../data/layouts'
import type { LayoutDef, OptionGroup, OptionValue } from '../data/layouts'
import {
  commitLayoutSelection,
  commitSlideOption,
  digitPickForOptionStep,
  headingContextForDoc,
  inlineLayoutPickerModel,
  inlineOptionPickerStep,
  selectionFromTriggerLine,
  toggleLayoutSelection
} from '../components/layoutPickerModel'
import { commitInlineTriggerSelection } from './inlineTriggerCommitModel'
import { deckCommitContext } from '../../../shared/deck-frame'
import { flashTriggerEchoAt, triggerEchoTokenChanged } from './triggerEcho'
import type { ObjectInsertRequest } from '../../../shared/objects/insert-objects'

export type TriggerCompleteOptions = {
  onInsertObject?: (
    kind: 'chart' | 'mermaid' | 'svg',
    request?: ObjectInsertRequest
  ) => void
}

type InlineOptionState = {
  entry: LayoutDef
  group: OptionGroup
  entryFrom: number
  queryFrom: number
  originalTokenText: string
}

type InlineCompletion = Completion & { optionDigit?: number }

const setInlineOptionState = StateEffect.define<InlineOptionState | null>()
const inlineOptionState = StateField.define<InlineOptionState | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setInlineOptionState)) return effect.value
    }
    if (!value || !transaction.docChanged) return value
    const mapped = {
      ...value,
      entryFrom: transaction.changes.mapPos(value.entryFrom, -1),
      queryFrom: transaction.changes.mapPos(value.queryFrom, -1)
    }
    // The editor's click-away/blur guard may roll the provisional token back outside this field.
    return transaction.newDoc.sliceString(mapped.entryFrom, mapped.entryFrom + 1) === '{'
      ? mapped
      : null
  }
})

function optionState(view: EditorView): InlineOptionState | null {
  return view.state.field(inlineOptionState, false) ?? null
}

function optionQuery(view: EditorView, state: InlineOptionState): string {
  return view.state.doc.sliceString(state.queryFrom, view.state.selection.main.head)
}

/**
 * ADR-0020 §5: the inline `{` palette judges option relevance with the same heading context the
 * Inspector uses, so a container's options never appear on a leaf `###` here either.
 */
function slideContextAt(doc: { toString(): string }, lineNumber: number) {
  return headingContextForDoc(doc.toString().split('\n'), lineNumber - 1)
}

function optionStep(view: EditorView, state: InlineOptionState) {
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  return inlineOptionPickerStep(
    state.entry,
    line.text,
    optionQuery(view, state),
    slideContextAt(view.state.doc, line.number)
  )
}

function commitInlineOption(
  view: EditorView,
  state: InlineOptionState,
  value: OptionValue,
  completion?: Completion,
  options: TriggerCompleteOptions = {}
): void {
  const head = view.state.selection.main.head
  const closesAtHead = view.state.doc.sliceString(head, head + 1) === '}'
  const removeTo = head + (closesAtHead ? 1 : 0)
  if (state.entry.name === 'chart' && options.onInsertObject) {
    view.dispatch({
      effects: setInlineOptionState.of(null),
      annotations: completion ? pickedCompletion.of(completion) : undefined
    })
    options.onInsertObject?.('chart', {
      triggerToken: value.token || 'chart',
      replace: { from: state.entryFrom, to: removeTo }
    })
    setTimeout(() => closeCompletion(view), 0)
    return
  }
  let echoToken: string | null = null
  const plan = commitInlineTriggerSelection(
    view.state.doc.toString(),
    state.entryFrom,
    removeTo,
    (triggerLine, headingLine) => {
      const explicitShape = (
        state.group.key === `${state.entry.name}-shape`
        && value.token
      ) ? value.token : undefined
      // ADR-0011: the chained palette reaches the same byte-preserving writer as ⌘L — and, T32,
      // the same deck-aware sweep.
      const next = commitSlideOption(
        view.state.doc.toString(), headingLine, triggerLine, state.entry, state.group, value.token, explicitShape
      )
      echoToken = triggerEchoTokenChanged(triggerLine, next)
      return next
    }
  )
  view.dispatch({
    changes: plan.changes,
    ...(plan.changes.length === 1 ? { selection: { anchor: plan.selection } } : {}),
    effects: setInlineOptionState.of(null),
    annotations: completion ? pickedCompletion.of(completion) : undefined
  })
  if (echoToken) {
    flashTriggerEchoAt(view, view.state.selection.main.head, echoToken)
  }
  setTimeout(() => closeCompletion(view), 0)
}

function beginInlineOptions(
  view: EditorView,
  entry: LayoutDef,
  group: OptionGroup,
  tokenFrom: number,
  segmentFrom: number,
  to: number,
  label: string,
  completion: Completion
): void {
  const originalTokenText = view.state.doc.sliceString(tokenFrom, to)
  // Scene C keeps the layout token provisional until a value is picked; no half-chain can autosave.
  view.dispatch({
    changes: { from: segmentFrom, to, insert: label },
    selection: { anchor: segmentFrom + label.length },
    annotations: pickedCompletion.of(completion),
    effects: setInlineOptionState.of({
      entry,
      group,
      entryFrom: tokenFrom,
      queryFrom: segmentFrom + label.length,
      originalTokenText
    })
  })
  setTimeout(() => startCompletion(view), 0)
}

function backToInlineEntries(view: EditorView): boolean {
  const state = optionState(view)
  if (!state) return false
  const head = view.state.selection.main.head
  view.dispatch({
    changes: { from: state.entryFrom, to: head, insert: state.originalTokenText },
    selection: { anchor: state.entryFrom + state.originalTokenText.length },
    effects: setInlineOptionState.of(null)
  })
  setTimeout(() => startCompletion(view), 0)
  return true
}

function inlineOptionKeys(options: TriggerCompleteOptions): Extension {
  return Prec.highest(keymap.of([
  { key: 'Escape', run: backToInlineEntries },
  {
    key: 'Backspace',
    run: (view) => {
      const state = optionState(view)
      return state != null && view.state.selection.main.head === state.queryFrom
        ? backToInlineEntries(view)
        : false
    }
  },
  {
    any: (view, event) => {
      if (!/^[1-9]$/.test(event.key)) return false
      const state = optionState(view)
      if (!state) return false
      const step = optionStep(view, state)
      const value = step ? digitPickForOptionStep(step, Number(event.key)) : undefined
      if (!value) return false
      commitInlineOption(view, state, value, undefined, options)
      return true
    }
  }
  ]))
}

function optionSection(entry: LayoutDef): CompletionSection {
  return {
    name: `${entry.name}-options`,
    rank: 0,
    header: () => {
      const header = document.createElement('li')
      header.className = 'tw-inline-option-crumb'
      header.textContent = `{  ›  ${entry.name}  ›  options`
      const back = document.createElement('span')
      back.textContent = 'esc backs up'
      header.appendChild(back)
      return header
    }
  }
}

export function triggerSource(
  context: CompletionContext,
  options: TriggerCompleteOptions = {}
): CompletionResult | null {
  const chained = context.state.field(inlineOptionState, false)
  if (chained) {
    const head = context.pos
    if (head < chained.queryFrom) return null
    const line = context.state.doc.lineAt(head)
    const query = context.state.doc.sliceString(chained.queryFrom, head)
    const step = inlineOptionPickerStep(
      chained.entry,
      line.text,
      query,
      slideContextAt(context.state.doc, line.number)
    )
    if (!step || step.rows.length === 0) return null
    const section = optionSection(chained.entry)
    return {
      from: chained.queryFrom,
      options: step.rows.map(({ digit, value }) => ({
        label: value.label,
        detail: value.description,
        section,
        optionDigit: digit,
        apply: (view, completion) => commitInlineOption(view, chained, value, completion, options)
      } satisfies InlineCompletion)),
      filter: false
    }
  }

  // The token from an opening `{` to the cursor. The token can contain multiple comma-separated
  // segments, e.g. `{statement,title=side`; filtering uses the segment after the last comma.
  const token = context.matchBefore(/\{[A-Za-z0-9=#,_-]*$/)
  if (!token) return null

  const fullContent = token.text.slice(1)
  const lastComma = fullContent.lastIndexOf(',')
  const partial = lastComma === -1 ? fullContent : fullContent.slice(lastComma + 1)
  const segmentFrom = token.from + 1 + (lastComma === -1 ? 0 : lastComma + 1)

  const cursorPos = context.pos
  const nextChar = context.state.doc.sliceString(cursorPos, cursorPos + 1)
  const needsClosingBrace = nextChar !== '}'

  const line = context.state.doc.lineAt(context.pos)
  const lines = context.state.doc.toString().split('\n')
  const pickerContext = headingContextForDoc(lines, line.number - 1)
  const filtered = inlineLayoutPickerModel(LAYOUTS, pickerContext)
    .flatMap((section) => section.entries.map((layout) => ({ layout, section: section.label })))
    .filter(({ layout }) => (braceAutocompleteLabel(layout) ?? layout.name).startsWith(partial))
  if (filtered.length === 0) return null

  return {
    from: segmentFrom,
    options: filtered.map(({ layout, section }) => {
      const label = braceAutocompleteLabel(layout) ?? layout.name
      const fencedObject = isFencedObjectLayout(layout)
      const step = inlineOptionPickerStep(layout, line.text, '', pickerContext)
      return {
        label,
        detail: layout.description,
        section,
        type: layout.kind === 'modifier' ? 'property' : 'keyword',
        apply: (view, completion, from, to) => {
          if (fencedObject && !step) {
            const removeTo = to + (!needsClosingBrace ? 1 : 0)
            if (layout.object?.widget === 'chart' && options.onInsertObject) {
              options.onInsertObject('chart', {
                triggerToken: label,
                replace: { from: token.from, to: removeTo }
              })
              setTimeout(() => closeCompletion(view), 0)
              return
            }
            // Use the same provisional-token planner as brace-trigger commits, but leave the
            // canonical Trigger line unchanged: fenced objects belong in the slide body.
            const plan = commitInlineTriggerSelection(
              view.state.doc.toString(),
              token.from,
              removeTo,
              (triggerLine) => triggerLine
            )
            view.dispatch({
              changes: plan.changes,
              ...(plan.changes.length === 1 ? { selection: { anchor: plan.selection } } : {}),
              annotations: pickedCompletion.of(completion)
            })
            options.onInsertObject?.(layout.name as 'mermaid' | 'svg')
            setTimeout(() => closeCompletion(view), 0)
            return
          }
          if (step) {
            beginInlineOptions(view, layout, step.group, token.from, from, to, label, completion)
            return
          }
          const removeTo = to + (!needsClosingBrace ? 1 : 0)
          let echoToken: string | null = null
          const plan = commitInlineTriggerSelection(
            view.state.doc.toString(),
            token.from,
            removeTo,
            (triggerLine, headingLine) => {
              const initial = selectionFromTriggerLine(triggerLine, LAYOUTS)
              const next = commitLayoutSelection(
                triggerLine,
                initial,
                toggleLayoutSelection(initial, layout),
                undefined,
                deckCommitContext(view.state.doc.toString(), headingLine)
              )
              echoToken = triggerEchoTokenChanged(triggerLine, next)
              return next
            }
          )
          view.dispatch({
            changes: plan.changes,
            ...(plan.changes.length === 1 ? { selection: { anchor: plan.selection } } : {})
          })
          if (echoToken) {
            flashTriggerEchoAt(view, view.state.selection.main.head, echoToken)
          }
        }
      }
    }),
    validFor: /^[A-Za-z0-9=#,_-]*$/
  }
}

export function triggerCompleteExtension(options: TriggerCompleteOptions = {}): Extension {
  return [
    inlineOptionState,
    inlineOptionKeys(options),
    autocompletion({
      override: [(context) => triggerSource(context, options)],
      activateOnTyping: true,
      defaultKeymap: true,
      tooltipClass: (state) => state.field(inlineOptionState, false) ? 'tw-inline-option-palette' : '',
      optionClass: (completion) => (completion as InlineCompletion).optionDigit ? 'tw-inline-option-row' : '',
      addToOptions: [{
        position: 10,
        render: (completion) => {
          const digit = (completion as InlineCompletion).optionDigit
          if (!digit) return null
          const marker = document.createElement('span')
          marker.className = 'tw-inline-option-digit'
          marker.textContent = String(digit)
          return marker
        }
      }]
    })
  ]
}
