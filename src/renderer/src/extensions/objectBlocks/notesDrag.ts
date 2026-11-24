import { isolateHistory } from '@codemirror/commands'
import { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { planNotesMove } from '../../../../shared/objects/notes-planner.ts'
import type { ObjectBlock } from './detect.ts'
import { exactTextWrite } from './effects.ts'
import { notify } from '../../lib/notify.ts'

const dragType = 'application/x-talkweaver-speaker-notes'

export function notesMoveHandle(view: EditorView, block: ObjectBlock): HTMLButtonElement {
  const handle = document.createElement('button')
  handle.type = 'button'
  handle.className = 'tw-notes-move'
  handle.dataset.notesFrom = String(block.from)
  handle.draggable = true
  handle.title = 'Move speaker notes within this slide. Drag or use the Up and Down arrows.'
  handle.setAttribute('aria-label', 'Move speaker notes')
  handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown')
  handle.addEventListener('mousedown', event => event.stopPropagation())

  function move(beforeLine: number): boolean {
    const source = view.state.doc.toString()
    const plan = planNotesMove(source, block.from, block.source, beforeLine - 1)
    if (!plan) return false
    const insert = Text.of(plan.insert.split('\n'))
    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert },
      selection: { anchor: plan.at },
      annotations: [exactTextWrite.of(true), isolateHistory.of('full')],
      userEvent: 'move.notes',
      scrollIntoView: true
    })
    view.dom.querySelector<HTMLButtonElement>(`[data-notes-from="${plan.at}"]`)?.focus({ preventScroll: true })
    return view.state.doc.toString() === source.slice(0, plan.from) + plan.insert + source.slice(plan.to)
  }

  handle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    const old = view.state.doc
    const up = event.key === 'ArrowUp'
    const edge = up ? old.lineAt(block.from).number : old.lineAt(block.to - 1).number
    let adjacent = edge + (up ? -1 : 1)
    while (adjacent > 0 && adjacent <= old.lines && !old.line(adjacent).text.trim()) {
      adjacent += up ? -1 : 1
    }
    if (adjacent > 0 && adjacent <= old.lines) move(adjacent + (up ? 0 : 1))
  })

  handle.addEventListener('dragstart', event => {
    const transfer = event.dataTransfer
    if (!transfer) return
    transfer.setData(dragType, '')
    transfer.effectAllowed = 'move'
    const listeners = new AbortController()
    const capture = { capture: true, signal: listeners.signal }
    view.dom.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes(dragType)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
    }, capture)
    view.dom.addEventListener('drop', event => {
      if (!event.dataTransfer?.types.includes(dragType)) return
      event.preventDefault()
      event.stopPropagation()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      const line = pos == null ? null : view.state.doc.lineAt(pos)
      const rect = pos == null ? null : view.coordsAtPos(pos)
      const before = line && rect ? line.number + (event.clientY > (rect.top + rect.bottom) / 2 ? 1 : 0) : null
      if (before == null || !move(before)) {
        notify('Move speaker notes to a line between blocks on this slide.', 'info', 'notes-move')
      }
      listeners.abort()
    }, capture)
    handle.addEventListener('dragend', () => listeners.abort(), { once: true, signal: listeners.signal })
  })
  return handle
}
