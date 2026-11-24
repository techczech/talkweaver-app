import DOMPurify from 'dompurify'
import { splitSegments } from '../../../../../compiler/scripts/lib/simulation-segments.mjs'
import { objectBlockEditableSource, type ObjectBlock } from './detect.ts'

export type CardPreviewKind = 'chat' | 'terminal' | 'trace' | 'page'

export function cardPreviewKind(block: ObjectBlock): CardPreviewKind | null {
  if (block.kind === 'chat' || block.kind === 'terminal' || block.kind === 'trace') return block.kind
  const variant = block.embed?.variant
  return variant === 'local' || variant === 'simulation' ? 'page' : null
}

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const CHAT_LABELS: Record<string, string> = {
  user: 'You',
  bot: 'Assistant',
  'model-reasoning': 'Reasoning',
  'context-retrieval': 'Context',
  'tool-call': 'Tool call',
  'tool-results': 'Tool results'
}

export function simulationPreview(block: ObjectBlock, kind: Exclude<CardPreviewKind, 'page'>): HTMLElement {
  const preview = div(`tw-obj-preview tw-obj-preview-${kind}`)
  const source = objectBlockEditableSource(block)
  if (kind === 'chat') {
    const { preamble, rows } = splitSegments('turns', source, { version: block.simulationVersion })
    appendIfText(preview, 'tw-obj-preview-text', preamble.join('\n'))
    for (const row of rows) {
      const message = div('tw-obj-preview-turn')
      message.dataset.role = row.role
      const label = row.label || CHAT_LABELS[row.role] || row.role
      message.append(div('tw-obj-preview-label', row.duration ? `${label} (${row.duration})` : label))
      appendIfText(message, 'tw-obj-preview-text', row.content)
      appendIfText(message, 'tw-obj-preview-detail', row.detail)
      preview.append(message)
    }
  } else if (kind === 'terminal') {
    const { preamble, rows } = splitSegments('shell', source)
    appendIfText(preview, 'tw-obj-preview-text', preamble.join('\n'))
    for (const row of rows) {
      preview.append(div('tw-obj-preview-command', [row.path, '$', row.command].filter(Boolean).join(' ')))
      appendIfText(preview, 'tw-obj-preview-text', row.output)
    }
  } else {
    const { preamble, rows } = splitSegments('trace', source)
    appendIfText(preview, 'tw-obj-preview-text', preamble.join('\n'))
    for (const row of rows) {
      const entry = div('tw-obj-preview-turn')
      entry.append(div('tw-obj-preview-label', row.header))
      appendIfText(entry, 'tw-obj-preview-text', row.content)
      preview.append(entry)
    }
  }
  if (!preview.hasChildNodes()) preview.append(div('tw-obj-preview-text', 'This simulation is empty.'))
  return preview
}

function appendIfText(parent: HTMLElement, className: string, text?: string): void {
  if (text?.trim()) parent.append(div(className, text))
}

const PAGE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

/** Parse in a template first. A detached HTMLDocument can still request resources while it parses.
 *  Template contents stay inert through sanitisation. The live frame has its own stricter CSP. */
function staticPageDocument(html: string): string | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const body = template.content.ownerDocument.createElement('div')
  body.append(template.content)
  DOMPurify.sanitize(body, {
    IN_PLACE: true,
    FORBID_TAGS: ['script', 'meta', 'base', 'link', 'iframe', 'frame', 'object', 'embed', 'template', 'audio', 'video', 'source'],
    FORBID_ATTR: ['href', 'xlink:href', 'srcdoc', 'srcset', 'action', 'formaction', 'autofocus', 'tabindex', 'contenteditable']
  })
  for (const item of body.querySelectorAll('[src]')) {
    if (!/^data:image\//i.test(item.getAttribute('src') ?? '')) item.removeAttribute('src')
  }
  const styles = Array.from(body.querySelectorAll('style'), (style) => {
    style.remove()
    return style.outerHTML
  }).join('')
  if (!body.textContent?.trim() && !body.querySelector('img[src], svg, table, input, canvas, [style]')) return null
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">${styles}<body>${body.innerHTML}</body>`
}

/** CodeMirror creates widgets around its viewport. Defer file reads and frame creation until
 *  this preview actually enters it, and drop any reply after CodeMirror removes the card. */
export function showPagePreview(
  host: HTMLElement,
  name: string,
  read: () => Promise<string | null>
): () => void {
  let disposed = false
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry?.isIntersecting || disposed) return
    observer.disconnect()
    void (async () => {
      let source: string | null = null
      try { source = await read() } catch { /* the card still shows the source or Open action */ }
      if (disposed || !host.isConnected) return
      const html = source === null ? null : staticPageDocument(source)
      if (html === null) {
        host.textContent = source === null ? 'Preview unavailable. Open the page to view it.' : 'Open the page to see its interactive content.'
        return
      }
      const frame = document.createElement('iframe')
      frame.className = 'tw-obj-preview-page'
      frame.title = `Preview of ${name}`
      frame.setAttribute('sandbox', '')
      frame.referrerPolicy = 'no-referrer'
      frame.inert = true
      frame.tabIndex = -1
      frame.srcdoc = html
      host.replaceChildren(frame)
    })()
  })
  observer.observe(host)
  return () => {
    disposed = true
    observer.disconnect()
  }
}
