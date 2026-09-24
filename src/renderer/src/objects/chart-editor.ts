import {
  parseChartListSource,
  renderChartBlock,
  type ChartShape,
} from '../../../../compiler/scripts/lib/06-chart-renderer.mjs'
import type { MountedEditor } from './shell.ts'
import {
  indentNode,
  moveNode,
  newSibling,
  nodeText,
  outdentNode,
  replaceNodeText,
} from './markmap-editor.ts'

function sourceLines(text: string): string[] {
  return text.replace(/\r/g, '').split('\n')
}

function lineDepth(line: string): number {
  return Math.floor((/^\s*/.exec(line)?.[0].replace(/\t/g, '  ').length ?? 0) / 2)
}

function readableChart(source: string): boolean {
  const parsed = parseChartListSource(source)
  return (
    parsed.invalidLines.length === 0
    && parsed.unparsed.length === 0
    && parsed.points.length > 0
  )
}

export function mountChartEditor(
  source: string,
  shape: ChartShape
): MountedEditor | null {
  // O-C: do not construct a visual editor for source it cannot parse. The registry will mount the
  // exact markup fallback instead, so an unfamiliar list can never be normalised by this editor.
  if (!readableChart(source)) return null

  let value = source
  let active = 0
  const root = document.createElement('div')
  root.className = 'oe-outline oe-chart-outline'
  const tree = document.createElement('div')
  tree.className = 'oe-outline-tree'
  const preview = document.createElement('div')
  preview.className = 'oe-chart-preview tw-obj-chart'
  root.append(tree, preview)

  const renderPreview = (): void => {
    const parsed = parseChartListSource(value)
    if (
      parsed.invalidLines.length > 0
      || parsed.unparsed.length > 0
      || parsed.points.length === 0
    ) {
      const error = document.createElement('div')
      error.className = 'tw-obj-error'
      const details = [
        ...parsed.invalidLines.map((line) => `Not a list item: ${line}`),
        ...parsed.unparsed.map((line) => `No chart value: ${line}`),
      ]
      error.textContent = details.join(' · ') || 'Add a list item with a numeric chart value.'
      preview.innerHTML = ''
      preview.replaceChildren(error)
      return
    }
    preview.replaceChildren()
    preview.innerHTML = renderChartBlock({ type: 'chart', shape, points: parsed.points })
  }

  const focus = (): void => {
    tree.querySelector<HTMLInputElement>(`input[data-node="${active}"]`)?.focus()
  }

  const render = (): void => {
    tree.replaceChildren()
    sourceLines(value).forEach((line, index) => {
      const row = document.createElement('div')
      row.className = 'oe-node'
      row.style.setProperty('--depth', String(lineDepth(line)))
      const dot = document.createElement('span')
      dot.className = 'oe-node-dot'
      dot.textContent = '•'
      const input = document.createElement('input')
      input.value = nodeText(line)
      input.dataset.node = String(index)
      input.addEventListener('focus', () => {
        active = index
      })
      input.addEventListener('input', () => {
        const all = sourceLines(value)
        all[index] = replaceNodeText(all[index], input.value)
        value = all.join('\n')
        renderPreview()
      })
      input.addEventListener('keydown', (event) => {
        if (
          event.key === 'Enter'
          && !event.metaKey
          && !event.ctrlKey
          && !event.altKey
          && !event.shiftKey
        ) {
          event.preventDefault()
          const result = newSibling(value, index)
          value = result.text
          active = result.index
          render()
          focus()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          value = event.shiftKey ? outdentNode(value, index) : indentNode(value, index)
          render()
          focus()
        } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault()
          const delta = event.key === 'ArrowUp' ? -1 : 1
          value = moveNode(value, index, delta)
          active = Math.max(0, Math.min(sourceLines(value).length - 1, index + delta))
          render()
          focus()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          active = Math.max(
            0,
            Math.min(
              sourceLines(value).length - 1,
              index + (event.key === 'ArrowUp' ? -1 : 1)
            )
          )
          focus()
        }
      })
      row.append(dot, input)
      tree.append(row)
    })
    renderPreview()
  }

  render()
  return {
    element: root,
    serialise: () => value,
    focus,
  }
}
