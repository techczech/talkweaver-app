import { WidgetType, type EditorView } from '@codemirror/view'
import type { Transformer } from 'markmap-lib'
import {
  parseChartListSource,
  renderChartBlock,
} from '../../../../../compiler/scripts/lib/06-chart-renderer.mjs'
import { objectLayoutEntryForBlockKind } from '../../../../shared/layout-registry/entries.ts'
import { escapeHtml } from '../../../../shared/html-escape.ts'
import { parseTable, type TableModel } from '../../../../shared/objects/object-markup.ts'
import {
  sanitiseRenderedSvg,
  sanitiseSvg
} from '../../../../shared/objects/sanitise-svg.ts'
import { renderMermaid } from '../../objects/mermaid-render.ts'
import { chartShapeForBlock } from '../../objects/chart-model.ts'
import { objectBlockEditableSource, type ObjectBlock } from './detect.ts'
import { setRawObjectBlock } from './effects.ts'
import { deleteObjectBlock } from './remove.ts'

/** Async widgets remember rendered height per source so re-renders do not jump the caret (WriteFlex C4). */
export class BoundedHeightCache {
  readonly limit: number
  private readonly values = new Map<string, number>()

  constructor(limit = 128) {
    this.limit = Math.max(1, limit)
  }

  get size(): number {
    return this.values.size
  }

  get(source: string): number | undefined {
    return this.values.get(source)
  }

  set(source: string, height: number): void {
    this.values.delete(source)
    this.values.set(source, height)
    while (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value
      if (oldest === undefined) break
      this.values.delete(oldest)
    }
  }
}

const asyncHeights = new BoundedHeightCache()

function reserveHeight(shell: HTMLElement, source: string): void {
  shell.style.minHeight = `${asyncHeights.get(source) ?? 120}px`
}

function recordHeight(shell: HTMLElement, source: string): void {
  shell.style.minHeight = ''
  const height = shell.offsetHeight
  if (height > 0) asyncHeights.set(source, height)
}

/**
 * Run once the host has non-zero width. d3/markmap throw from a timer tick when asked to render
 * into an unsized block, outside the caller's try/catch, so waiting is the only safe guard.
 */
function whenSized(el: HTMLElement, render: () => void): () => void {
  if (el.clientWidth > 0) {
    render()
    return () => {}
  }
  const observer = new ResizeObserver(() => {
    if (el.clientWidth > 0) {
      observer.disconnect()
      render()
    }
  })
  observer.observe(el)
  return () => observer.disconnect()
}

function fillCell(cell: HTMLElement, value: string): void {
  value.split(/<br\s*\/?>|\n/gi).forEach((part, index) => {
    if (index) cell.appendChild(document.createElement('br'))
    cell.appendChild(document.createTextNode(part))
  })
}

function tableElement(model: TableModel, style?: ObjectBlock['tableStyle']): HTMLTableElement {
  const table = document.createElement('table')
  table.className = 'tw-obj-table'
  table.classList.toggle('tw-obj-table-accent-first', style?.firstColumnAccent !== false)
  const columns = model.cells[0] ?? []
  const addRow = (section: HTMLTableSectionElement, values: string[], tag: 'th' | 'td') => {
    const row = section.insertRow()
    columns.forEach((_column, index) => {
      const cell = document.createElement(tag)
      cell.style.textAlign = model.alignments[index] ?? 'left'
      fillCell(cell, values[index] ?? '')
      row.appendChild(cell)
    })
  }
  const header = style?.header !== false
  if (header) addRow(table.createTHead(), columns, 'th')
  const body = table.createTBody()
  model.cells.slice(header ? 1 : 0).forEach(row => addRow(body, row, 'td'))
  return table
}

type ListNode = { text: string; children: ListNode[] }
type MarkmapRoot = ReturnType<Transformer['transform']>['root']

function stripListItemIconToken(text: string): string {
  const explicit = text.match(/\s*\{\s*icon\s*=\s*[^}]+?\s*\}\s*$/i)
  if (explicit) return text.slice(0, explicit.index).trim()
  // The compiler resolves only drawable bare names. The widget does not load the multi-megabyte icon
  // registry, so it recognises the same compact NAME token grammar while preserving ordinary braces.
  const bare = text.match(/\s*\{\s*(?:[A-Za-z][\w-]*:)?[A-Za-z][\w-]*\s*\}\s*$/)
  return bare ? text.slice(0, bare.index).trim() : text
}

export function triggerTable(source: string): TableModel {
  const roots: ListNode[] = []
  const stack: Array<{ indent: number; node: ListNode }> = []
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    const match = /^(\s*)(?:[-*]\s+|\d+[.)]\s+)(.+)$/.exec(line)
    if (!match) continue
    const indent = match[1].replace(/\t/g, '  ').length
    const node = { text: stripListItemIconToken(match[2].trim()), children: [] }
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ indent, node })
  }

  // Mirrors compiler 06-block-renderers.mjs:1561-1570: roots are column headers, each root's
  // direct children are that column's cells, and short columns pad with an empty string.
  const header = roots.map((node) => node.text)
  const columns = roots.map((node) => node.children.filter((child) => child.text).map((child) => child.text))
  const depth = Math.max(0, ...columns.map((column) => column.length))
  const rows = Array.from({ length: depth }, (_unused, row) =>
    columns.map((column) => column[row] ?? '')
  )
  return {
    cells: [header, ...rows],
    alignments: header.map(() => 'left')
  }
}

function fenceBody(source: string): string {
  return source.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
}

export function emptyObjectPrompt(kind: 'mermaid' | 'svg', source: string): string | null {
  if (source.trim()) return null
  return kind === 'mermaid'
    ? 'Empty Mermaid object — press ↵ to type the diagram source.'
    : 'Empty SVG object — press ↵ to type the SVG markup.'
}

export async function transformMindmapSource(source: string, title?: string): Promise<MarkmapRoot> {
  const { Transformer } = await import('markmap-lib')
  const transformer = new Transformer()
  // markmap-lib 0.18 enables markdown-it HTML by default, and markmap-view inserts node content as
  // HTML. Disable authored HTML before transforming imported or pasted outline content.
  transformer.md.set({ html: false })
  const { root } = transformer.transform(source.trimEnd())
  // Match the slide's synthetic root for multiple top-level subtrees.
  const branches = root.children ?? []
  if (title && !root.content && branches.length > 1 && branches.some(branch => branch.children?.length)) {
    root.content = escapeHtml(title)
  }
  return root
}

function bodyElement(): HTMLDivElement {
  const body = document.createElement('div')
  body.className = 'tw-obj-body'
  return body
}

export abstract class ObjectWidget extends WidgetType {
  readonly block: ObjectBlock
  readonly selected: boolean
  readonly raw: boolean
  readonly onZoom?: (block: ObjectBlock) => void
  stopSizing: (() => void) | null = null

  constructor(
    block: ObjectBlock,
    selected: boolean,
    raw: boolean,
    onZoom?: (block: ObjectBlock) => void
  ) {
    super()
    this.block = block
    this.selected = selected
    this.raw = raw
    this.onZoom = onZoom
  }

  eq(other: WidgetType): boolean {
    return other instanceof ObjectWidget
      && other.constructor === this.constructor
      && other.block.kind === this.block.kind
      && other.block.from === this.block.from
      && other.block.to === this.block.to
      && other.block.source === this.block.source
      && other.block.triggerToken === this.block.triggerToken
      && other.block.tableStyle?.header === this.block.tableStyle?.header
      && other.block.tableStyle?.firstColumnAccent === this.block.tableStyle?.firstColumnAccent
      && other.block.mindmapTitle === this.block.mindmapTitle
      && other.block.simulationVersion === this.block.simulationVersion
      && other.selected === this.selected
      && other.raw === this.raw
      && other.onZoom === this.onZoom
  }

  get estimatedHeight(): number {
    return asyncHeights.get(this.block.source) ?? 120
  }

  // WriteFlex C1: selection belongs on the widget class, never on a line decoration inside a
  // replaced range. C4: only mousedown and dblclick pass through to CodeMirror's block handler.
  ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown' && event.type !== 'dblclick'
  }

  destroy(_dom: HTMLElement): void {
    this.stopSizing?.()
    this.stopSizing = null
  }

  protected shell(
    view: EditorView,
    kind: string,
    stepModel: string,
    showRawToggle = true
  ): HTMLDivElement {
    const shell = document.createElement('div')
    shell.className = `tw-obj tw-obj-${kind}${this.selected ? ' tw-obj-selected' : ''}`
    shell.dataset.objectBlock = kind

    const header = document.createElement('div')
    header.className = 'tw-obj-head'

    const kindLabel = document.createElement('span')
    kindLabel.className = 'tw-obj-kind'
    kindLabel.textContent = kind

    const step = document.createElement('span')
    step.className = 'tw-obj-step'
    step.textContent = stepModel

    const slot = document.createElement('span')
    slot.className = 'tw-obj-slot'
    slot.textContent = 'whole slide'

    // Fidelity zoom is parked by the objects/layouts convergence plan; C-A5 omits its affordance.
    const raw = document.createElement('button')
    raw.type = 'button'
    raw.className = `tw-obj-raw${this.raw ? ' is-active' : ''}`
    raw.textContent = '</>'
    raw.title = this.raw ? 'Show rendered object' : 'Show markup'
    raw.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({
        effects: setRawObjectBlock.of({ from: this.block.from, raw: !this.raw })
      })
      view.focus()
    })

    // Delete: the whole object, one undo step (as Backspace or Delete on the selected object).
    const actions = document.createElement('span')
    actions.className = 'tw-obj-actions'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'tw-obj-action tw-obj-action-remove'
    remove.textContent = 'Delete'
    remove.title = 'Delete this object (Undo restores it)'
    remove.setAttribute('aria-label', remove.title)
    remove.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      deleteObjectBlock(view, this.block)
      view.focus()
    })
    actions.append(remove)

    header.append(kindLabel, step, slot, actions)
    if (showRawToggle) header.append(raw)
    shell.appendChild(header)

    const hint = document.createElement('span')
    hint.className = 'tw-obj-hint'
    hint.textContent = '↵ edit · ⌫ delete'
    shell.appendChild(hint)

    return shell
  }

  protected rawSource(shell: HTMLElement): void {
    const source = document.createElement('pre')
    source.className = 'tw-obj-rawsrc'
    source.textContent = this.block.source
    shell.appendChild(source)
  }

  protected ready(shell: HTMLElement, prompt: string): void {
    shell.classList.add('tw-obj-empty')
    const body = bodyElement()
    body.classList.add('tw-obj-ready')
    body.textContent = prompt
    shell.appendChild(body)
  }

  protected fail(shell: HTMLElement, message: string): void {
    // ADR-0019: the outline is never hostage. A failed render shows the exact raw source and a
    // human-readable error, never a blank block.
    shell.classList.add('tw-obj-failed')
    shell.querySelector('.tw-obj-body')?.remove()
    shell.querySelector('.tw-obj-rawsrc')?.remove()
    shell.querySelector('.tw-obj-error')?.remove()
    this.rawSource(shell)
    const note = document.createElement('div')
    note.className = 'tw-obj-error'
    note.textContent = message
    shell.appendChild(note)
  }
}

export class GfmTableWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell(view, 'table', 'steps by row')
    if (this.raw) {
      this.rawSource(shell)
      return shell
    }
    const parsed = parseTable(this.block.source)
    if (!parsed) {
      this.fail(shell, 'This is not a well-formed pipe table — press ↵ to fix the markup.')
      return shell
    }
    const body = bodyElement()
    body.appendChild(tableElement(parsed, this.block.tableStyle))
    shell.appendChild(body)
    return shell
  }
}

export class TriggerTableWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell(view, 'table', 'steps by row')
    if (this.raw) {
      this.rawSource(shell)
      return shell
    }
    const body = bodyElement()
    body.appendChild(tableElement(triggerTable(this.block.source), this.block.tableStyle))
    shell.appendChild(body)
    return shell
  }
}

export class MindmapWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell(view, 'mindmap', 'unfolds by branch · markmap')
    if (this.raw) {
      this.rawSource(shell)
      return shell
    }
    reserveHeight(shell, this.block.source)
    const body = bodyElement()
    body.textContent = 'rendering diagram…'
    shell.appendChild(body)

    let disposed = false
    let stopWaiting: (() => void) | undefined
    let disposeMap: (() => void) | undefined
    this.stopSizing = () => {
      disposed = true
      stopWaiting?.()
      disposeMap?.()
    }
    void Promise.all([transformMindmapSource(this.block.source, this.block.mindmapTitle), import('markmap-view')])
      .then(([root, { Markmap }]) => {
        if (disposed) return
        // CodeMirror can build a widget ahead of mounting its DOM. Keep waiting for its size.
        stopWaiting = whenSized(shell, () => {
          if (disposed || !shell.isConnected) return
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('width', '100%')
          svg.setAttribute('height', '340')
          body.replaceChildren(svg)
          // WriteFlex C4: d3-zoom otherwise swallows dblclick before the editor can open the block.
          const map = new Markmap(svg, { zoom: false, pan: false, duration: 0 })
          const { width, height } = svg.getBoundingClientRect()
          // CodeMirror can detach the SVG between layout and the D3 fit callback.
          map.zoom.extent([[0, 0], [width, height]])
          disposeMap = () => map.destroy()
          void map.setData(root).then(async () => {
            if (!svg.isConnected) return
            await map.fit()
            if (svg.isConnected) recordHeight(shell, this.block.source)
          }).catch(error => {
            if (svg.isConnected) this.fail(shell, error instanceof Error ? error.message : String(error))
          })
        })
      })
      .catch((error) => {
        if (shell.isConnected) this.fail(shell, error instanceof Error ? error.message : String(error))
      })
    return shell
  }
}

export class ChartWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    const shape = chartShapeForBlock(this.block)
    const shell = this.shell(
      view,
      'chart',
      shape ? `${shape} · steps by row` : 'unresolved trigger'
    )
    if (this.raw) {
      this.rawSource(shell)
      return shell
    }
    if (!shape) {
      this.fail(
        shell,
        `This chart trigger is not registered: ${this.block.triggerToken ?? '(missing)'}.`
      )
      return shell
    }
    const source = objectBlockEditableSource(this.block)
    if (!source.trim()) {
      this.ready(shell, 'Empty chart — press ↵ to add a label and numeric value.')
      return shell
    }
    const parsed = parseChartListSource(source)
    if (parsed.invalidLines.length > 0) {
      this.fail(
        shell,
        `This chart contains a line that is not a list item: ${parsed.invalidLines[0]}`
      )
      return shell
    }
    if (parsed.unparsed.length > 0 || parsed.points.length === 0) {
      this.fail(
        shell,
        `This chart needs a numeric value in every item: ${parsed.unparsed[0] ?? 'add a value'}.`
      )
      return shell
    }
    const body = bodyElement()
    body.classList.add('tw-obj-chart-body')
    body.innerHTML = renderChartBlock({ type: 'chart', shape, points: parsed.points })
    shell.appendChild(body)
    return shell
  }
}

export class MermaidWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell(view, 'mermaid', 'flowchart · steps by node')
    if (this.raw) {
      this.rawSource(shell)
      return shell
    }
    const source = fenceBody(this.block.source)
    const empty = emptyObjectPrompt('mermaid', source)
    if (empty) {
      this.ready(shell, empty)
      return shell
    }
    reserveHeight(shell, this.block.source)
    const body = bodyElement()
    body.textContent = 'rendering diagram…'
    shell.appendChild(body)
    void renderMermaid(source).then((result) => {
      if (!shell.isConnected) return
      if ('error' in result) {
        this.fail(shell, result.error)
        return
      }
      const safe = sanitiseRenderedSvg(result.svg)
      if ('error' in safe) {
        this.fail(shell, safe.error)
        return
      }
      body.innerHTML = safe.svg
      requestAnimationFrame(() => recordHeight(shell, this.block.source))
    })
    return shell
  }
}

export class SvgWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell(view, 'svg', 'vector · one object')
    if (this.raw) {
      this.rawSource(shell)
      return shell
    }
    const source = fenceBody(this.block.source)
    const empty = emptyObjectPrompt('svg', source)
    if (empty) {
      this.ready(shell, empty)
      return shell
    }
    reserveHeight(shell, this.block.source)
    const body = bodyElement()
    body.textContent = 'rendering SVG…'
    shell.appendChild(body)
    const result = sanitiseSvg(source)
    this.stopSizing = whenSized(shell, () => {
      if (!shell.isConnected) return
      if ('error' in result) {
        this.fail(shell, result.error)
        return
      }
      body.innerHTML = result.svg
      requestAnimationFrame(() => recordHeight(shell, this.block.source))
    })
    return shell
  }
}

export class RawMarkupWidget extends ObjectWidget {
  toDOM(view: EditorView): HTMLElement {
    // ADR-0019 header-grammar exception: fallback already displays raw source, so an inert `</>`
    // toggle would duplicate the only available state instead of switching between two states.
    const shell = this.shell(view, this.block.kind, 'markup only', false)
    this.fail(
      shell,
      'TalkWeaver cannot render this object kind. Its markup remains available.'
    )
    return shell
  }
}

export function widgetForObjectBlock(
  block: ObjectBlock,
  selected: boolean,
  raw: boolean,
  onZoom?: (block: ObjectBlock) => void
): ObjectWidget {
  const declaration = objectLayoutEntryForBlockKind(block.kind)?.object
  const factory = declaration ? OBJECT_WIDGETS[declaration.widget] : undefined
  if (!factory) {
    console.error(
      `No registry-declared widget for object block ${block.kind}. Showing raw markup instead.`
    )
    return new RawMarkupWidget(block, selected, raw, onZoom)
  }
  return factory(block, selected, raw, onZoom)
}

type ObjectWidgetFactory = (
  block: ObjectBlock,
  selected: boolean,
  raw: boolean,
  onZoom?: (block: ObjectBlock) => void
) => ObjectWidget

const OBJECT_WIDGETS: Record<string, ObjectWidgetFactory> = {
  table: (block, selected, raw, onZoom) => block.kind === 'gfm-table'
    ? new GfmTableWidget(block, selected, raw, onZoom)
    : new TriggerTableWidget(block, selected, raw, onZoom),
  mindmap: (block, selected, raw, onZoom) =>
    new MindmapWidget(block, selected, raw, onZoom),
  chart: (block, selected, raw, onZoom) =>
    new ChartWidget(block, selected, raw, onZoom),
  mermaid: (block, selected, raw, onZoom) =>
    new MermaidWidget(block, selected, raw, onZoom),
  svg: (block, selected, raw, onZoom) =>
    new SvgWidget(block, selected, raw, onZoom)
}
