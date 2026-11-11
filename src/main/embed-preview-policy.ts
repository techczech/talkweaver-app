// Compiler-generated authoring markup only; remote pages are represented by pixels.
import { DOMParser } from '@xmldom/xmldom'
import { parseLivePageUrl } from './live-page-policy.ts'

const escapeAttribute = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function iframeAttributes(markup: string): Map<string, string> | null {
  let valid = true
  try {
    const parser = new DOMParser({ errorHandler: { warning: () => {}, error: () => { valid = false }, fatalError: () => { valid = false } } })
    const element = parser.parseFromString(markup, 'text/html').documentElement
    if (!element || element.tagName.toLowerCase() !== 'iframe') return null
    const attrs = new Map<string, string>()
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes.item(i)!
      const name = attr.name.toLowerCase()
      if (attrs.has(name)) valid = false
      attrs.set(name, attr.value)
    }
    return valid ? attrs : null
  } catch { return null }
}

/** The compiler normalises players to these two exact HTTPS provider endpoints. */
function playerUrl(raw: string): boolean {
  const url = parseLivePageUrl(raw)
  if (!url || url.protocol !== 'https:' || url.port) return false
  return ((url.hostname === 'youtube-nocookie.com' || url.hostname === 'www.youtube-nocookie.com') && /^\/embed\/[\w-]{11}$/.test(url.pathname))
    || (url.hostname === 'player.vimeo.com' && /^\/video\/\d+$/.test(url.pathname))
}

const FRAME_PATTERN = /<iframe\b(?:[^"'<>]|"[^"]*"|'[^']*')*>\s*<\/iframe\s*>/gi

/** A frame the preview keeps as it is: a local compiler widget or an unrelated empty deck frame, or a
 *  validated video player. Every other frame becomes pixels (or a poster). */
function frameKept(attrs: Map<string, string> | null, addresses: string[]): boolean {
  if (attrs && !addresses.length && !attrs.has('srcdoc')) return true
  return attrs?.get('data-embed-video') === '1' && !attrs.has('srcdoc') && addresses.length > 0 && addresses.every(address => address === addresses[0] && playerUrl(address))
}
function frameAddresses(attrs: Map<string, string> | null): string[] {
  return attrs ? ['src', 'data-src', 'data-embed-url'].map(name => attrs.get(name)).filter((value): value is string => !!value) : []
}

/** Whether replaceRemoteEmbedFrames would change this document at all. False means the document is
 *  already its own preview (no remote page to turn into pixels), so a variant marked from it ahead of
 *  time (prepare-talk-worker.ts) is exactly what the preview and thumbnails would build. */
export function hasRemoteEmbedFrames(html: string): boolean {
  for (const match of html.matchAll(FRAME_PATTERN)) {
    const attrs = iframeAttributes(match[0])
    if (!frameKept(attrs, frameAddresses(attrs))) return true
  }
  return false
}

/** Only actual attributes and validated player URLs can retain a video frame. Everything else is pixels. */
export async function replaceRemoteEmbedFrames(
  html: string,
  artwork: (url: string, signal?: AbortSignal) => Promise<string | null>,
  signal?: AbortSignal,
  shouldCancel?: () => boolean,
  budgetMs = 6000
): Promise<string> {
  const frames = [...html.matchAll(FRAME_PATTERN)]
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  let expired = false
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => { expired = true; controller.abort(); resolve(null) }, budgetMs) })
  try {
    let count = 0
    for (const match of frames) {
      if (signal?.aborted || shouldCancel?.()) throw new Error('Embed preview cancelled')
      const attrs = iframeAttributes(match[0])
      const addresses = frameAddresses(attrs)
      // Local compiler widgets, unrelated empty deck frames and validated players keep their existing policy.
      if (frameKept(attrs, addresses)) continue
      const url = parseLivePageUrl(attrs?.get('data-embed-url') || attrs?.get('data-src') || attrs?.get('src'))
      const image = url && !expired && count++ < 8
        ? await Promise.race([artwork(url.href, controller.signal).catch(() => null), deadline]) : null
      if (signal?.aborted || shouldCancel?.()) throw new Error('Embed preview cancelled')
      const replacement = image
        ? `<img data-tw-embed-artwork src="${escapeAttribute(image)}" alt="Web page preview" style="width:100%;height:100%;object-fit:contain">`
        : '<span class="embed-poster" style="display:flex">Web page preview unavailable. Use Capture embed to open the page.</span>'
      html = html.replace(match[0], replacement)
    }
    return html
  } finally { clearTimeout(timer!); controller.abort(); signal?.removeEventListener('abort', cancel) }
}
