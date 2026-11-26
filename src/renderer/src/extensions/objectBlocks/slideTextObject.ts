import { markerCountLabel, videoFileName } from '../../../../shared/video-marker-edits.ts'
import { isolateHistory } from '@codemirror/commands'
import type { Text } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { cardKind, EMBED_LABELS } from '../../../../shared/objects/card-kinds.ts'
import { objectLayoutEntryForBlockKind } from '../../../../shared/layout-registry/entries.ts'
import { TRIGGER_LINE_RE } from '../../../../shared/trigger-line.ts'
import { notify } from '../../lib/notify.ts'
import { currentFocusRange, type FocusRange } from '../focusScope.ts'
import { detectObjectBlocks, type ObjectBlock } from './detect.ts'
import { deleteObjectBlock } from './remove.ts'
import { exactTextWrite, setOpenObjectBlock } from './effects.ts'

type Direction = -1 | 1
type Span = { from: number; to: number }
type Line = ReturnType<Text['line']>

function contentSpan(doc: Text, block: ObjectBlock): Span {
  return { from: block.from, to: doc.lineAt(Math.max(block.from, block.to - 1)).to }
}

function isBodyLine(line: Line, range: FocusRange): boolean {
  const text = line.text.trim()
  return line.from > range.from && line.to <= range.to && text !== '' &&
    !/^#{1,6}\s/.test(line.text) && !TRIGGER_LINE_RE.test(text)
}

/** Move past one neighbouring object or prose/list block, keeping its own bytes and the separator. */
function adjacent(doc: Text, block: Span, blocks: readonly ObjectBlock[], range: FocusRange, direction: Direction): Span | null {
  let number = doc.lineAt(direction < 0 ? block.from : block.to).number + direction
  while (number > 0 && number <= doc.lines && doc.line(number).text.trim() === '') number += direction
  if (number < 1 || number > doc.lines) return null
  const first = doc.line(number)
  if (!isBodyLine(first, range)) return null
  const ownerAt = (line: Line) => blocks.find(candidate => candidate.from <= line.from && candidate.to > line.from)
  const object = ownerAt(first)
  if (object) {
    const span = contentSpan(doc, object)
    return object.kind !== 'notes' && span.from > range.from && span.to <= range.to ? span : null
  }
  let last = first
  for (number += direction; number > 0 && number <= doc.lines; number += direction) {
    const line = doc.line(number)
    if (line.from === block.from || !isBodyLine(line, range) || ownerAt(line)) break
    last = line
  }
  return { from: Math.min(first.from, last.from), to: Math.max(first.to, last.to) }
}

function moveObject(view: EditorView, block: ObjectBlock, blocks: readonly ObjectBlock[], direction: Direction): void {
  const { doc } = view.state
  const range = currentFocusRange(view.state)
  if (!range || doc.sliceString(block.from, block.to) !== block.source) return
  const here = contentSpan(doc, block)
  const there = adjacent(doc, here, blocks, range, direction)
  if (!there) return
  const [left, right] = direction < 0 ? [there, here] : [here, there]
  const leftText = doc.sliceString(left.from, left.to)
  const rightText = doc.sliceString(right.from, right.to)
  const gap = doc.sliceString(left.to, right.from)
  const insert = rightText + gap + leftText
  const anchor = direction < 0 ? left.from : left.from + rightText.length + gap.length
  const next = doc.sliceString(0, left.from) + insert + doc.sliceString(right.to)
  const parsed = detectObjectBlocks(next, true)
  const movedText = doc.sliceString(here.from, here.to)
  const hasObject = (from: number, kind: ObjectBlock['kind'], body: string): boolean => parsed.some(candidate =>
    candidate.from === from && candidate.kind === kind && candidate.source.replace(/\r?\n$/, '') === body
  )
  const neighbour = blocks.find(candidate => candidate.from === there.from)
  const neighbourAnchor = direction < 0 ? left.from + rightText.length + gap.length : left.from
  if (!hasObject(anchor, block.kind, movedText) || (neighbour &&
      !hasObject(neighbourAnchor, neighbour.kind, doc.sliceString(there.from, there.to)))) {
    notify('This object needs to stay with its source lines.', 'info', 'object-move')
    return
  }
  view.dispatch({
    changes: { from: left.from, to: right.to, insert },
    selection: { anchor },
    userEvent: 'move.object',
    annotations: [isolateHistory.of('full'), exactTextWrite.of(true)],
    scrollIntoView: true
  })
  view.focus()
}

function describe(block: ObjectBlock): { label: string; detail: string } {
  if (block.video) {
    return { label: 'Video', detail: `${videoFileName(block.video.ref)} · ${markerCountLabel(block.video.markers.length)}` }
  }
  if (block.media) {
    const label = block.media.kind === 'video' ? 'Video' : block.media.kind === 'audio' ? 'Audio' : 'Picture'
    return { label, detail: block.media.alt || block.media.src.split('/').at(-1) || block.media.src }
  }
  if (block.embed) return { label: EMBED_LABELS[block.embed.variant].label, detail: block.embed.name }
  const label = cardKind(block.kind)?.label ?? objectLayoutEntryForBlockKind(block.kind)?.label ?? 'Object'
  return { label, detail: block.info ?? '' }
}

export class SlideTextObjectWidget extends WidgetType {
  readonly block: ObjectBlock
  readonly selected: boolean
  readonly blocks: readonly ObjectBlock[]
  readonly range: FocusRange

  constructor(block: ObjectBlock, selected: boolean, blocks: readonly ObjectBlock[], range: FocusRange) {
    super()
    this.block = block
    this.selected = selected
    this.blocks = blocks
    this.range = range
  }

  eq(other: SlideTextObjectWidget): boolean {
    return other.block === this.block && other.selected === this.selected && other.range === this.range
  }

  get estimatedHeight(): number { return 34 }

  ignoreEvent(event: Event): boolean { return event.type !== 'mousedown' }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument
    const card = doc.createElement('div')
    const { label, detail } = describe(this.block)
    card.className = 'tw-obj tw-obj-card tw-slide-text-object' + (this.selected ? ' tw-obj-selected' : '')
    card.dataset.objectBlock = this.block.kind
    card.dataset.slideTextObject = this.block.kind
    const head = doc.createElement('div')
    head.className = 'tw-obj-head'
    const name = doc.createElement('span')
    name.className = 'tw-obj-kind'
    name.textContent = label
    const description = doc.createElement('span')
    description.className = 'tw-obj-step'
    description.textContent = detail
    description.title = detail
    head.append(name, description)
    const actions = doc.createElement('span')
    actions.className = 'tw-slide-text-object-actions'
    const button = (wording: string, text: string, run: () => void): HTMLButtonElement => {
      const control = doc.createElement('button')
      control.className = 'toolbar-btn'
      control.type = 'button'
      control.title = wording
      control.setAttribute('aria-label', wording)
      control.textContent = text
      control.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation() })
      control.addEventListener('click', event => { event.stopPropagation(); run() })
      actions.append(control)
      return control
    }
    if (this.block.video) {
      card.classList.add('tw-video-marker-chip')
      name.className = 'tw-video-marker-chip-icon'
      name.textContent = '▶'
      name.setAttribute('aria-hidden', 'true')
      button(this.block.video.markers.length ? 'Remove video and its markers' : 'Remove video', '×', () => {
        const { from, to, source } = this.block
        if (view.state.doc.sliceString(from, to) === source) deleteObjectBlock(view, this.block)
      })
      if (this.block.video.markers.length) {
        head.append(actions)
        card.append(head)
        return card
      }
    }
    for (const direction of [-1, 1] as const) {
      const control = button(direction < 0 ? 'Move up' : 'Move down', direction < 0 ? '↑' : '↓',
        () => moveObject(view, this.block, this.blocks, direction))
      control.disabled = !adjacent(view.state.doc, contentSpan(view.state.doc, this.block), this.blocks, this.range, direction)
    }
    button('Edit ' + label.toLowerCase(), 'Edit', () => {
      const { from, to, source } = this.block
      if (view.state.doc.sliceString(from, to) !== source) return
      view.dispatch({ selection: { anchor: from }, effects: setOpenObjectBlock.of({ from, to }), scrollIntoView: true })
    })
    head.append(actions)
    card.append(head)
    return card
  }
}
