import { type EditorView } from '@codemirror/view'
import {
  type EditorState,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state'
import {
  logicalTriggerBlockAfterHeading,
  parseTriggerLine
} from '../../../shared/trigger-line.ts'

export type TriggerEchoRange = { from: number; to: number }
export type TriggerEchoChange = TriggerEchoRange & {
  token: string
  occurrence: number
}

export const setTriggerEcho = StateEffect.define<TriggerEchoRange | null>({
  map: (range, changes) => range && ({
    from: changes.mapPos(range.from, -1),
    to: changes.mapPos(range.to, 1),
  })
})

const triggerEchoField = StateField.define<TriggerEchoRange | null>({
  create: () => null,
  update(value, transaction) {
    let next = value && transaction.docChanged
      ? {
          from: transaction.changes.mapPos(value.from, -1),
          to: transaction.changes.mapPos(value.to, 1),
        }
      : value
    for (const effect of transaction.effects) {
      if (effect.is(setTriggerEcho)) next = effect.value
    }
    return next
  }
})

export const triggerEchoState: Extension = triggerEchoField

export function triggerEchoRange(state: EditorState): TriggerEchoRange | null {
  return state.field(triggerEchoField, false) ?? null
}

export function triggerEchoRangeAt(
  doc: EditorState['doc'],
  position: number,
  triggerToken: string
): TriggerEchoRange | null {
  if (!triggerToken) return null
  const lineNumber = doc.lineAt(Math.max(0, Math.min(position, doc.length))).number
  let headingLine = -1
  for (let number = lineNumber; number >= 1; number -= 1) {
    if (/^#{1,6}\s/.test(doc.line(number).text)) {
      headingLine = number
      break
    }
  }
  if (headingLine < 0) return null
  const lines = Array.from({ length: doc.lines }, (_unused, index) => doc.line(index + 1).text)
  const block = logicalTriggerBlockAfterHeading(lines, headingLine - 1)
  if (!block) return null
  let match: TriggerEchoRange | null = null
  let distance = Number.POSITIVE_INFINITY
  for (let index = block.start; index < block.end; index += 1) {
    const line = doc.line(index + 1)
    for (const token of parseTriggerLine(line.text)) {
      if (token.raw === triggerToken) {
        const candidate = {
          from: line.from + token.groupStart,
          to: line.from + token.groupEnd
        }
        const candidateDistance = position < candidate.from
          ? candidate.from - position
          : position > candidate.to
            ? position - candidate.to
            : 0
        if (candidateDistance < distance) {
          match = candidate
          distance = candidateDistance
        }
      }
    }
  }
  return match
}

const echoTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()

export function triggerEchoChange(before: string, after: string): TriggerEchoChange | null {
  let changedFrom = 0
  while (
    changedFrom < before.length
    && changedFrom < after.length
    && before[changedFrom] === after[changedFrom]
  ) changedFrom += 1

  let beforeEnd = before.length
  let afterEnd = after.length
  while (
    beforeEnd > changedFrom
    && afterEnd > changedFrom
    && before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  if (afterEnd <= changedFrom) return null

  const tokens = parseTriggerLine(after)
  const changed = tokens.find((token) =>
    token.groupEnd > changedFrom && token.groupStart < afterEnd
  )
  if (!changed) return null
  const occurrence = tokens
    .slice(0, tokens.indexOf(changed))
    .filter((token) => token.raw === changed.raw)
    .length
  return {
    token: changed.raw,
    occurrence,
    from: changed.groupStart,
    to: changed.groupEnd
  }
}

export function triggerEchoTokenChanged(before: string, after: string): string | null {
  return triggerEchoChange(before, after)?.token ?? null
}

function editorViewIsDestroyed(view: EditorView): boolean {
  // CodeMirror exposes this runtime state but marks it private in its TypeScript surface.
  return (view as unknown as { readonly destroyed: boolean }).destroyed
}

export function flashTriggerEchoAt(
  view: EditorView,
  position: number,
  triggerToken: string
): void {
  const range = triggerEchoRangeAt(view.state.doc, position, triggerToken)
  if (!range) return
  const previous = echoTimers.get(view)
  if (previous) clearTimeout(previous)
  view.dispatch({ effects: setTriggerEcho.of(range) })
  const timer = setTimeout(() => {
    echoTimers.delete(view)
    if (!editorViewIsDestroyed(view) && view.dom.isConnected) {
      view.dispatch({ effects: setTriggerEcho.of(null) })
    }
  }, 1200)
  echoTimers.set(view, timer)
}
