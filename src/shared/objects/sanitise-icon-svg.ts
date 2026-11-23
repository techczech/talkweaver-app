import DOMPurify from 'dompurify'
import { renderedSvgPreflightError, sanitiseRenderedSvg, type SanitisedSvg } from './sanitise-svg'

// Kept out of sanitise-svg.ts on purpose: that module is bundled into the compiler's vendored
// sanitiser (scripts/build-compiler-svg-sanitiser.mjs), which this picker-only path does not need.
const RASTER_DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const IMAGE_HREF = /(<image\b[^>]*?\s(?:xlink:)?href\s*=\s*)(["'])([^"']*)\2/gi
const LOCAL_FRAGMENT = /^#([A-Za-z_][\w:.-]*)$/
const XLINK_NS = 'http://www.w3.org/1999/xlink'

// For an icon that reuses its own shapes with <use> (DOMPurify leaves <use> out by default because
// it can pull in another document). SVG only: no HTML, no foreignObject. Every <use> is then
// checked to point at an element of the same, already sanitised, picture.
const ICON_WITH_USE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  FORBID_TAGS: [
    'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'foreignobject',
    'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'source'
  ],
  FORBID_ATTR: ['srcdoc']
}

/**
 * An icon from the catalogue, before it reaches innerHTML. The same checks as sanitiseRenderedSvg,
 * with two shapes the catalogue's own marks use (the compiler draws them on slides, 05-icons.mjs):
 *   - a PNG, JPEG or WebP as a base64 data URL on an `<image>` element (METR, Developer Student Club);
 *   - `<use>` whose href is `#id` of an element inside the same picture.
 * Any other reference, external URL, SVG-in-image or `<use>` of another document is still refused.
 */
export function sanitiseIconSvg(source: string): SanitisedSvg {
  const rasters: string[] = []
  const masked = source.replace(IMAGE_HREF, (whole, lead: string, quote: string, value: string) => {
    if (!RASTER_DATA_URL.test(value.trim())) return whole
    rasters.push(value.trim())
    return `${lead}${quote}#tw-raster-${rasters.length - 1}${quote}`
  })
  const result = /<\s*use\b/i.test(masked) ? sanitiseWithLocalUse(masked) : sanitiseRenderedSvg(masked)
  if (!('svg' in result)) return result
  const svg = result.svg.replace(IMAGE_HREF, (whole, lead: string, quote: string, value: string) => {
    const match = /^#tw-raster-(\d+)$/.exec(value)
    return match && rasters[Number(match[1])] ? `${lead}${quote}${rasters[Number(match[1])]}${quote}` : whole
  })
  return svg.includes('#tw-raster-') ? { error: 'Generated SVG references must stay inside the diagram.' } : { svg }
}

function sanitiseWithLocalUse(source: string): SanitisedSvg {
  const before = renderedSvgPreflightError(source)
  if (before) return { error: before }
  if (typeof DOMParser === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    return { error: 'Generated SVG can only be verified where the SVG sanitiser is available.' }
  }
  const svg = String(DOMPurify.sanitize(source, ICON_WITH_USE_CONFIG)).trim()
  if (!svg || droppedElement()) return { error: 'Unsafe SVG content was removed. Edit the source before it can be previewed.' }
  const after = renderedSvgPreflightError(svg)
  if (after) return { error: after }
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') {
    return { error: 'The SVG markup is not well formed.' }
  }
  for (const use of Array.from(document.getElementsByTagName('use'))) {
    const hrefs = [use.getAttribute('href'), use.getAttributeNS(XLINK_NS, 'href')].filter((value): value is string => value !== null)
    if (hrefs.length === 0) return { error: 'An SVG <use> must point at a shape inside the picture.' }
    for (const href of hrefs) {
      const id = LOCAL_FRAGMENT.exec(href.trim())?.[1]
      const target: Element | null = id ? document.getElementById(id) : null
      if (!target || target === use || target.contains(use)) return { error: 'An SVG <use> must point at a shape inside the picture.' }
    }
  }
  return { svg }
}

function droppedElement(): boolean {
  return DOMPurify.removed.some((entry) => {
    const element = (entry as { element?: { nodeName?: string; localName?: string } }).element
    if (!element) return false
    const name = String(element.nodeName ?? element.localName ?? '').toUpperCase()
    return name !== 'BODY' && name !== 'HTML' && name !== 'HEAD'
  })
}
