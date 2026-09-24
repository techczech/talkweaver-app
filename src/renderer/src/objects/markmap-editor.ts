import type { MountedEditor } from './shell.ts'
import type { Transformer } from 'markmap-lib'

type MarkmapRoot = ReturnType<Transformer['transform']>['root']

export async function transformEditorMindmap(source: string): Promise<MarkmapRoot> {
  const { Transformer } = await import('markmap-lib')
  const transformer = new Transformer()
  // markmap-view injects transformed node content as HTML. Authored/imported HTML is disabled at
  // the markdown-it boundary before any node reaches that renderer.
  transformer.md.set({ html: false })
  return transformer.transform(source.trimEnd()).root
}

function whenSized(element: HTMLElement, render: () => void): () => void {
  if (element.clientWidth > 0) {
    render()
    return () => {}
  }
  const observer = new ResizeObserver(() => {
    if (element.clientWidth > 0) {
      observer.disconnect()
      render()
    }
  })
  observer.observe(element)
  return () => observer.disconnect()
}

function lines(text: string): string[] {
  return text.replace(/\r/g, '').split('\n')
}
function depth(line: string): number {
  return Math.floor((/^\s*/.exec(line)?.[0].length ?? 0) / 2)
}
function nodeLine(line: string): { indent: string; marker: string; text: string } {
  const match = /^(\s*)((?:[-*]|\d+[.)]))\s+(.*)$/.exec(line)
  return match
    ? { indent: match[1], marker: match[2], text: match[3] }
    : { indent: /^\s*/.exec(line)?.[0] ?? '', marker: '-', text: line.trimStart() }
}
export function nodeText(line: string): string {
  return nodeLine(line).text
}
export function replaceNodeText(line: string, text: string): string {
  const item = nodeLine(line)
  return `${item.indent}${item.marker} ${text}`
}
function subtreeEnd(items: string[], index: number): number {
  const base = depth(items[index] ?? '')
  let end = index + 1
  while (end < items.length && depth(items[end]) > base) end += 1
  return end
}

export function newSibling(text: string, index: number): { text: string; index: number } {
  const items = lines(text)
  const at = index + 1
  // Inherit the following line's depth when it is deeper: Enter below a parent creates a child
  // instead of a root-level line that silently adopts the parent's existing children.
  const own = depth(items[index] ?? '')
  const next = at < items.length ? depth(items[at]) : own
  const prefix = '  '.repeat(Math.max(own, next))
  const marker = nodeLine(items[index] ?? '').marker
  const numbered = /^(\d+)([.)])$/.exec(marker)
  // Advance only the inserted marker. Later authored ordinals remain byte-authored even when this
  // creates two `2.` lines: Markdown renumbers them for rendering, while the editor's standing
  // contract is to preserve every existing marker rather than normalise the author's source.
  const siblingMarker = numbered
    ? `${Number(numbered[1]) + 1}${numbered[2]}`
    : marker
  items.splice(at, 0, `${prefix}${siblingMarker} `)
  return { text: items.join('\n'), index: at }
}

export function indentNode(text: string, index: number): string {
  const items = lines(text)
  if (index <= 0) return text
  const end = subtreeEnd(items, index)
  const currentDepth = depth(items[index])
  const targetDepth = Math.min(currentDepth + 1, depth(items[index - 1]) + 1)
  const shift = targetDepth - currentDepth
  if (!shift) return text
  items.splice(
    index,
    end - index,
    ...items.slice(index, end).map((line) =>
      `${'  '.repeat(Math.max(0, depth(line) + shift))}${line.trimStart()}`
    )
  )
  return items.join('\n')
}

export function outdentNode(text: string, index: number): string {
  const items = lines(text)
  if (!/^\s{2}/.test(items[index] ?? '')) return text
  const end = subtreeEnd(items, index)
  items.splice(index, end - index, ...items.slice(index, end).map((line) => line.slice(2)))
  return items.join('\n')
}

export function moveNode(text: string, index: number, delta: -1 | 1): string {
  const items = lines(text)
  const end = subtreeEnd(items, index)
  const block = items.slice(index, end)
  const base = depth(items[index] ?? '')
  if (delta < 0) {
    let previous = index - 1
    while (previous >= 0 && depth(items[previous]) > base) previous -= 1
    if (previous < 0 || depth(items[previous]) !== base) return text
    items.splice(index, block.length)
    items.splice(previous, 0, ...block)
  } else {
    let next = end
    while (next < items.length && depth(items[next]) > base) next += 1
    if (next >= items.length || depth(items[next]) !== base) return text
    const nextEnd = subtreeEnd(items, next)
    const nextBlock = items.slice(next, nextEnd)
    items.splice(index, nextEnd - index, ...nextBlock, ...block)
  }
  return items.join('\n')
}

export function mountMarkmapEditor(source: string): MountedEditor {
  let value = source
  let active = 0
  let generation = 0
  let stopSizing: (() => void) | null = null
  const root = document.createElement('div')
  root.className = 'oe-outline'
  const tree = document.createElement('div')
  tree.className = 'oe-outline-tree'
  const preview = document.createElement('div')
  preview.className = 'oe-markmap-preview'
  preview.textContent = 'rendering diagram…'
  root.append(tree, preview)
  const renderPreview = (): void => {
    const requested = ++generation
    stopSizing?.()
    stopSizing = null
    void Promise.all([transformEditorMindmap(value), import('markmap-view')])
      .then(([markmapRoot, { Markmap }]) => {
        if (requested !== generation) return
        stopSizing = whenSized(preview, () => {
          if (requested !== generation) return
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('width', '100%')
          svg.setAttribute('height', '260')
          preview.replaceChildren(svg)
          // d3-zoom would otherwise swallow double-clicks before the block editor can own them.
          const map = Markmap.create(svg, { zoom: false, pan: false }, markmapRoot)
          void map.fit()
        })
      })
      .catch((reason) => {
        if (requested !== generation) return
        const error = document.createElement('div')
        error.className = 'tw-obj-error'
        error.textContent = reason instanceof Error ? reason.message : String(reason)
        preview.replaceChildren(error)
      })
  }
  const focus = (): void => {
    tree.querySelector<HTMLInputElement>(`input[data-node="${active}"]`)?.focus()
  }
  const render = (): void => {
    tree.replaceChildren()
    lines(value).forEach((line, index) => {
      const row = document.createElement('div')
      row.className = 'oe-node'
      row.style.setProperty('--depth', String(depth(line)))
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
        const all = lines(value)
        // The compiler accepts unordered and numbered markers. Editing changes only node text;
        // preserving the authored marker prevents a marker from becoming part of that text.
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
          active = Math.max(0, Math.min(lines(value).length - 1, index + delta))
          render()
          focus()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          active = Math.max(
            0,
            Math.min(lines(value).length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))
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
    destroy: () => {
      generation += 1
      stopSizing?.()
    },
  }
}
