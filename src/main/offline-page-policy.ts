// Sanitisation is reconstruction from a closed data format. No remote HTML string is stored.
export const OFFLINE_PAGE_MAX_BYTES = 20 * 1024 * 1024
export const OFFLINE_PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const TAGS = new Set('address article aside b blockquote br caption code dd del details div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i li main nav ol p pre s section small span strong sub summary sup table tbody td th thead time tr u ul img'.split(' '))
const STYLES = new Set('display color background-color font-family font-size font-weight font-style line-height text-align white-space border-top-width border-top-style border-top-color border-bottom-width border-bottom-style border-bottom-color border-left-width border-left-style border-left-color border-right-width border-right-style border-right-color border-collapse padding-top padding-right padding-bottom padding-left margin-top margin-right margin-bottom margin-left max-width width height'.split(' '))
const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
export const isOfflineImage = (s: unknown): s is string => typeof s === 'string' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(s)
export interface OfflinePageResult { html: string; title: string; omitted: number; images: number; dataFiles: number }

/** Even a compromised page renderer's answer cannot introduce tags, attributes or active CSS. */
export function buildOfflinePage(raw: unknown, pictures: readonly (string | null)[], data: readonly { url: string; body: string }[] = []): OfflinePageResult {
  const page = raw as Record<string, unknown> | null
  if (!page || typeof page !== 'object') throw Error('The page could not be read.')
  const title = typeof page.title === 'string' ? page.title.slice(0, 200) : 'Offline page'
  let nodes = 0, textBytes = 0, imageCount = 0
  let omitted = typeof page.omitted === 'number' && Number.isFinite(page.omitted) ? Math.max(0, Math.min(12000, page.omitted)) : 0
  const render = (rawNode: unknown, depth: number): string => {
    if (++nodes > 12000 || depth > 80) { omitted++; return '' }
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return ''
    const node = rawNode as Record<string, unknown>
    if (typeof node.text === 'string') {
      textBytes += node.text.length
      if (textBytes > OFFLINE_PAGE_MAX_BYTES) throw Error('This page is too large to save.')
      return escape(node.text)
    }
    if (typeof node.tag !== 'string' || !TAGS.has(node.tag)) { omitted++; return '' }
    const tag = node.tag
    const styles: string[] = []
    if (node.style && typeof node.style === 'object' && !Array.isArray(node.style)) {
      for (const [key, value] of Object.entries(node.style)) {
        // Only computed values for non-resource CSS properties; no escapes, separators or CSS functions
        // capable of referencing a resource. The DOM's style object itself is never trusted.
        if (STYLES.has(key) && typeof value === 'string' && value.length <= 300 && !/[;{}@\\<>\x00-\x1f]/.test(value)
          && !/(?:url|expression|image-set|var)\s*\(/i.test(value)) styles.push(`${key}:${value}`)
      }
    }
    const style = styles.length ? ` style="${escape(styles.join(';'))}"` : ''
    if (tag === 'img') {
      const image = Number.isInteger(node.image) ? pictures[node.image as number] : null
      if (!isOfflineImage(image)) { omitted++; return '<span>[Image omitted]</span>' }
      imageCount++
      return `<img src="${image}" alt="${escape(typeof node.alt === 'string' ? node.alt.slice(0, 300) : '')}"${style}>`
    }
    if (tag === 'br' || tag === 'hr') return `<${tag}${style}>`
    const attrs = node.attrs && typeof node.attrs === 'object' ? Object.entries(node.attrs).filter(([key, value]) => ['colspan', 'rowspan', 'start', 'value'].includes(key) && typeof value === 'string' && /^-?\d{1,5}$/.test(value)).map(([key, value]) => ` ${key}="${value}"`).join('') : ''
    const children = Array.isArray(node.children) ? node.children.map(child => render(child, depth + 1)).join('') : ''
    return `<${tag}${attrs}${style}>${children}</${tag}>`
  }
  const content = render(page.tree, 0)
  const supporting = data.slice(0, 20).map(item => `<details><summary>Supporting data: ${escape(item.url.slice(0, 2048))}</summary><pre>${escape(item.body.slice(0, 2 * 1024 * 1024))}</pre></details>`).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${OFFLINE_PAGE_CSP}"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>html{background:white;color:#222}body{margin:24px}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>${content}${supporting}</body></html>`
  if (Buffer.byteLength(html) > OFFLINE_PAGE_MAX_BYTES) throw Error('This page is too large to save.')
  return { html, title, omitted, images: imageCount, dataFiles: data.length }
}
