// Lifted from WriteFlex src/shared/sanitise-svg.ts (2026-07-25).

/**
 * The app's ONE rule for untrusted SVG.
 *
 * It lives in `shared/` rather than in the editor because three surfaces now hold the same opinion
 * about the same bytes: the live preview draws a ```svg fence, its object editor validates one as
 * it is typed, and the copy/export emitters turn one into a picture. A second sanitiser is a second
 * opinion, and the weaker of two opinions is the one that gets exploited.
 */
import DOMPurify from 'dompurify'

export type SanitisedSvg = { svg: string } | { error: string }

const FORBIDDEN_TAGS = ['script', 'foreignObject', 'style', 'animate', 'animateMotion', 'animateTransform', 'set']
// The svg + svgFilters profiles are the attribute allow-list that KEEPS geometry/presentation
// (viewBox/width/height/fill/d). Adding ALLOWED_URI_REGEXP or FORBID_ATTR here silently stripped those
// core attributes, blanking every SVG — so URI/handler/external-ref restriction is done by the strict
// source preflight (unsafeSourceError) instead, and DOMPurify keeps FORBID_TAGS as tag-level defence.
const SVG_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [...FORBIDDEN_TAGS],
}

/**
 * Whether a fenced code block is the app's SVG object type. `mermaid` and `markmap` are the other
 * two drawable fences and are deliberately NOT included: they need rendering engines that live in
 * the renderer, so outside it their source is the honest thing to show.
 */
export function isSvgFence(language: string): boolean {
  return language.trim().toLowerCase() === 'svg'
}

function xmlShapeError(source: string): string | null {
  const stack: string[] = []
  let rootCount = 0
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/g) ?? []
  for (const token of tokens) {
    if (/^<!--|^<!\[CDATA\[/.test(token)) continue
    if (/^<\?|^<!/i.test(token)) return 'SVG declarations, doctypes, and entities are not allowed.'
    const close = /^<\s*\/\s*([A-Za-z_][\w:.-]*)\s*>$/.exec(token)
    if (close) {
      if (stack.pop()?.toLowerCase() !== close[1].toLowerCase()) return 'The SVG markup is not well formed.'
      continue
    }
    const open = /^<\s*([A-Za-z_][\w:.-]*)\b[\s\S]*?>$/.exec(token)
    if (!open) return 'The SVG markup is not well formed.'
    const attribute = /[A-Za-z_:][\w:.-]*\s*=\s*(["'])/g
    for (let match = attribute.exec(token); match; match = attribute.exec(token)) {
      const valueEnd = token.indexOf(match[1], attribute.lastIndex)
      if (valueEnd === -1 || !/[\s/>]/.test(token[valueEnd + 1] ?? '>')) {
        return 'The SVG markup is not well formed.'
      }
      attribute.lastIndex = valueEnd + 1
    }
    if (stack.length === 0) {
      rootCount += 1
      if (rootCount > 1) return 'Expected one complete SVG document with an <svg> root.'
    }
    if (!/\/\s*>$/.test(token)) stack.push(open[1])
  }
  return stack.length || rootCount !== 1 ? 'The SVG markup is not well formed.' : null
}

function unsafeSourceError(source: string): string | null {
  const trimmed = source.trim()
  // Deliberate deviation from WriteFlex: reject declarations and doctypes before checking the SVG root.
  if (/<!DOCTYPE|<!ENTITY|<\?xml/i.test(trimmed)) return 'SVG declarations, doctypes, and entities are not allowed.'
  if (!/^<svg(?:\s|>)/i.test(trimmed) || !/(?:<\/svg\s*>|<svg\b[^>]*\/\s*>)$/i.test(trimmed)) {
    return 'Expected one complete SVG document with an <svg> root.'
  }
  if (/<\s*(?:[A-Za-z_][\w.-]*:)?(?:script|foreignObject)\b/i.test(trimmed)) return 'Scripts and foreignObject content are not allowed in SVG.'
  if (/<\s*(?:[A-Za-z_][\w.-]*:)?(?:style|animate|animateMotion|animateTransform|set)\b/i.test(trimmed) || /\sstyle\s*=/i.test(trimmed)) return 'Embedded CSS and animated attribute mutation are not allowed in SVG.'
  if (/\s(?:[A-Za-z_][\w.-]*:)?on[a-z][\w.-]*\s*=/i.test(trimmed)) return 'SVG event-handler attributes are not allowed.'
  for (const match of trimmed.matchAll(/\s(?:xlink:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!/^#[A-Za-z_][\w:.-]*$/.test(value)) return 'SVG references must be local #fragment references; external links and image fetches are not allowed.'
  }
  for (const match of trimmed.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2])) return 'SVG CSS references must be local #fragment references.'
  }
  if (/<style\b[^>]*>[\s\S]*?@import/i.test(trimmed)) return 'External CSS imports are not allowed in SVG.'
  return null
}

function unsafeRenderedCss(css: string): string | null {
  if (/@import|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding/i.test(css)) {
    return 'Generated SVG contains unsafe CSS.'
  }
  for (const match of css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2])) {
      return 'Generated SVG CSS references must stay inside the diagram.'
    }
  }
  return null
}

/**
 * Boundary check for SVG produced by a renderer such as Mermaid. Unlike authored SVG, generated
 * output may legitimately contain renderer styles and richer SVG geometry, but it may never carry
 * executable elements, event handlers, external resource references, or active CSS.
 */
export function renderedSvgPreflightError(source: string): string | null {
  const trimmed = source.trim()
  if (!/^<svg(?:\s|>)/i.test(trimmed) || !/<\/svg\s*>$/i.test(trimmed)) {
    return 'Expected one complete generated SVG document.'
  }
  if (/<\s*(?:script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|audio|video|source)\b/i.test(trimmed)) {
    return 'Generated SVG contains an unsafe element.'
  }
  if (/\s(?:[A-Za-z_][\w.-]*:)?on[a-z][\w.-]*\s*=/i.test(trimmed) || /\ssrcdoc\s*=/i.test(trimmed)) {
    return 'Generated SVG contains an unsafe event or document attribute.'
  }
  for (const match of trimmed.matchAll(/\s(?:xlink:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (value && !/^#[A-Za-z_][\w:.-]*$/.test(value)) {
      return 'Generated SVG references must stay inside the diagram.'
    }
  }
  for (const match of trimmed.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const unsafe = unsafeRenderedCss(match[1])
    if (unsafe) return unsafe
  }
  for (const match of trimmed.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const unsafe = unsafeRenderedCss(match[1] ?? match[2] ?? '')
    if (unsafe) return unsafe
  }
  return null
}

/** Strict source-only checks, exported so DOM-less unit tests can exercise the preflight directly. */
export function svgPreflightError(source: string): string | null {
  const trimmed = source.trim()
  return unsafeSourceError(trimmed) ?? xmlShapeError(trimmed)
}

function parseError(source: string): string | null {
  if (typeof DOMParser === 'undefined') return null
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  if (document.querySelector('parsererror') || document.documentElement.localName.toLowerCase() !== 'svg') return 'The SVG markup is not well formed.'
  return null
}

function sanitiserDroppedElement(): boolean {
  return DOMPurify.removed.some((entry) => {
    const element = (entry as { element?: { nodeName?: string; localName?: string } }).element
    if (!element) return false
    const name = String(element.nodeName ?? element.localName ?? '').toUpperCase()
    return name !== 'BODY' && name !== 'HTML' && name !== 'HEAD'
  })
}

const RENDERED_SVG_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['foreignobject'],
  FORBID_TAGS: [
    'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'audio', 'video', 'source'
  ],
  FORBID_ATTR: ['srcdoc']
}

/** Sanitise renderer-produced SVG again at the final innerHTML boundary. */
export function sanitiseRenderedSvg(source: string): SanitisedSvg {
  const before = renderedSvgPreflightError(source)
  if (before) return { error: before }
  if (typeof DOMParser === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    return { error: 'Generated SVG can only be verified where the SVG sanitiser is available.' }
  }
  const svg = String(DOMPurify.sanitize(source, RENDERED_SVG_CONFIG)).trim()
  if (!svg || sanitiserDroppedElement()) {
    return { error: 'Unsafe SVG content was removed. Edit the source before it can be previewed.' }
  }
  const after = renderedSvgPreflightError(svg) ?? parseError(svg)
  return after ? { error: after } : { svg }
}

/** Sanitise untrusted SVG before it reaches innerHTML. Any removal is a visible failure, never a hole. */
export function sanitiseSvg(source: string): SanitisedSvg {
  const trimmed = source.trim()
  const unsafe = svgPreflightError(source) ?? parseError(source)
  if (unsafe) return { error: unsafe }
  if (typeof DOMParser === 'undefined') {
    return { error: 'SVG can only be verified where a DOM parser is available.' }
  }
  if (typeof DOMPurify.sanitize !== 'function') {
    return { error: 'SVG can only be verified where the SVG sanitiser is available.' }
  }
  // DOMPurify receives the SVG string and parses it through its HTML path. The SVG profiles preserve
  // geometry and presentation attributes; BODY/HTML/HEAD wrappers created by that path are ignored
  // below, while any removed source element still makes the sanitisation fail visibly.
  const svg = String(DOMPurify.sanitize(trimmed, SVG_CONFIG)).trim()
  // Fail closed if DOMPurify had to drop a real ELEMENT the preflight didn't catch (e.g. a non-SVG
  // <iframe>/<object>). The BODY/HTML/HEAD wrapper is an artifact of parsing the SVG string as HTML,
  // not a real removal. Attribute-level scrubs are the preflight's job (above), so a benign xmlns
  // normalisation never trips this — but a stripped element means the source wasn't clean SVG.
  if (!svg || !/^<svg[\s>]/i.test(svg) || sanitiserDroppedElement()) return { error: 'Unsafe SVG content was removed. Edit the source before it can be previewed.' }
  // Final belt-and-braces: re-run the strict preflight + parse on DOMPurify's OUTPUT, so nothing the
  // preflight would reject can survive even if DOMPurify's profile ever let it through.
  const after = unsafeSourceError(svg) ?? parseError(svg)
  return after ? { error: after } : { svg }
}
