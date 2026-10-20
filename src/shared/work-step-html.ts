// The one rule for a work-file step's HTML before it is published on a public page (work-files
// ticket 05, fix round after review). A DOM allowlist, not a pattern: DOMPurify parses the compiler's
// slide HTML the way a browser does and keeps only the HTML and SVG profiles; this module then applies
// what a public step page needs on top:
//
//   - no script, style, base, meta, link, form controls, object, embed, frame, template, MathML;
//   - no event handler, `srcdoc`, `srcset`, form action, ping or nonce attribute, and none of the
//     compiler's local-only attributes (`data-embed-doc`, the inlined page of a local embed;
//     `data-video-ref`, the file name as authored);
//   - every address (`href`, `src`, `poster`, `data-src`, `data-lazy-src`, …) is http(s), relative or a
//     #fragment; `data:` only for an image's or a video's own bytes, which is how the compiler inlines
//     media. A protocol-relative address (`//host/path`) has no scheme and passes as relative: it is
//     the page's own scheme (https on a published page) to another host, like any http(s) link;
//   - an `<iframe>` stays only as the compiler draws an allowed video player (YouTube no-cookie or
//     Vimeo, `data-embed-video="1"`, address in `data-src`, `allow` holding only the compiler's own
//     tokens); any other frame is removed;
//   - a link that opens a new tab gets `rel="noopener noreferrer"`; an SVG link loses `target`
//     (SVG has no `rel` a browser honours);
//   - CSS in `style` (and SVG paint attributes) may not load anything: `url()` only to a #fragment or
//     an inlined image, no `image-set`, `expression`, `@import`, binding or CSS escapes.
//
// The result is checked again after serialising; if anything executable survived, the step's HTML is
// '' rather than a hole. Text in attributes (alt, title, data-mmd-src) is kept exactly.
//
// Pure: the caller passes a window (jsdom in the main process and in tests, via the compiler's vendored
// bundle `compiler/assets/vendor/svg-sanitiser.mjs`; a browser window anywhere else).
import DOMPurify, { type Config, type WindowLike } from 'dompurify'

export interface SanitisedStepHtml {
  /** Safe to insert as HTML on a public page. */
  html: string
  /** What was taken out, as `tag` or `tag@attribute`, deduplicated; [] when nothing was. */
  removed: string[]
}

export type StepHtmlSanitiser = (html: string) => SanitisedStepHtml

const SVG_NS = 'http://www.w3.org/2000/svg'

const FORBID_TAGS = [
  'script', 'style', 'base', 'meta', 'link', 'noscript', 'template',
  'form', 'input', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'output', 'fieldset',
  'object', 'embed', 'applet', 'param', 'frame', 'frameset', 'portal', 'audio', 'track',
  'math', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'feimage',
]
const FORBID_ATTR = [
  'srcdoc', 'srcset', 'imagesrcset', 'action', 'formaction', 'form', 'ping', 'nonce', 'integrity',
  'data-embed-doc', 'data-video-ref', 'xlink:actuate', 'xlink:show',
]
const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['iframe'],
  ADD_ATTR: ['allow', 'allowfullscreen', 'loading', 'target', 'scrolling'],
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_DOM_FRAGMENT: true,
}

/** Attributes whose value is an address a browser or the page's runtime may load or follow. */
const URL_ATTRS = new Set([
  'href', 'src', 'xlink:href', 'poster', 'cite', 'background', 'data-src', 'data-href', 'data-url',
  'data-embed-url', 'data-poster', 'data-qr-url', 'data-full', 'data-original',
  'data-lazy-src', 'data-lazy-poster', 'data-lazy-url',
])

/** Attributes that only ever carry text a person reads. */
const TEXT_ATTRS = new Set(['alt', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'aria-placeholder'])

/** Text-only attributes whose values DOMPurify must not trim or drop (see createStepHtmlSanitiser). */
function textAttribute(name: string): boolean {
  if (URL_ATTRS.has(name) || FORBID_ATTR.includes(name)) return false
  return TEXT_ATTRS.has(name) || /^data-[a-z0-9-]+$/.test(name)
}

/** The players the compiler emits for a video embed (06-block-renderers.mjs). */
const VIDEO_PLAYER = /^https:\/\/(?:(?:www\.)?youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+)(?:[?#][^\s"'<>]*)?$/
const IFRAME_ATTRS = new Set(['class', 'data-src', 'data-embed-url', 'data-embed-video', 'title', 'loading', 'allow', 'allowfullscreen', 'scrolling'])
/** The permissions the compiler's video player asks for (06-block-renderers.mjs); an `allow` may hold only these. */
export const VIDEO_PLAYER_ALLOW = ['autoplay', 'encrypted-media', 'picture-in-picture', 'fullscreen'] as const

/** Whether an iframe's `allow` value names only the compiler's own permissions, with no origin list. */
export function videoAllowOk(value: string | null): boolean {
  if (value === null) return true
  return value.split(';').every((part) => {
    const token = part.trim().toLowerCase()
    return token === '' || (VIDEO_PLAYER_ALLOW as readonly string[]).includes(token)
  })
}

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i
const DATA_VIDEO = /^data:video\/(?:mp4|webm|ogg|quicktime|x-m4v)[;,]/i

/** Whitespace and control characters a browser ignores inside a scheme ("java\tscript:"). */
const IGNORED_IN_SCHEME = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g

/** Whether an address may stay on `tag`'s `attr`. Empty is allowed: the compiler blanks refused media. */
export function stepUrlAllowed(tag: string, attr: string, value: string, svg = false): boolean {
  const compact = value.replace(IGNORED_IN_SCHEME, '')
  if (compact === '') return true
  if (svg) {
    if (compact.startsWith('#')) return true
    if (tag === 'image' && (attr === 'href' || attr === 'xlink:href')) return DATA_IMAGE.test(compact)
    if (tag === 'a' && (attr === 'href' || attr === 'xlink:href')) return /^https?:/i.test(compact)
    return false
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)
  if (!scheme) return !compact.includes('\\')
  const name = scheme[1].toLowerCase()
  if (name === 'http' || name === 'https') return true
  if (name !== 'data') return false
  if (tag === 'img' && attr === 'src') return DATA_IMAGE.test(compact)
  if ((tag === 'video' || tag === 'source') && attr === 'src') return DATA_VIDEO.test(compact)
  if (tag === 'video' && attr === 'poster') return DATA_IMAGE.test(compact)
  return false
}

/** Whether CSS (a `style` value or an SVG paint attribute) could load or run anything. */
export function stepCssUnsafe(css: string): boolean {
  if (/\\|@import|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|image-set\s*\(|(?:^|[^-\w])image\s*\(|(?:^|[^-\w])src\s*\(|cross-fade\s*\(|element\s*\(/i.test(css)) return true
  for (const match of css.matchAll(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    const target = match[2].trim()
    if (!target.startsWith('#') && !DATA_IMAGE.test(target)) return true
  }
  // An unterminated or oddly quoted url( the pattern above could not read.
  return /url\s*\(/i.test(css.replace(/url\s*\(\s*(['"]?)[^)'"]*\1\s*\)/gi, ''))
}

interface AttrLike { name: string; value: string }
interface ElementLike {
  localName: string
  namespaceURI: string | null
  attributes: ArrayLike<AttrLike>
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  remove(): void
  querySelectorAll(selector: string): ArrayLike<ElementLike>
}
interface FragmentLike { querySelectorAll(selector: string): ArrayLike<ElementLike> }
interface TemplateLike { innerHTML: string; content: FragmentLike & { appendChild(node: unknown): unknown } }
interface DocumentLike { createElement(name: 'template'): TemplateLike }
type StepWindow = WindowLike & { document: DocumentLike }

function videoPlayerFrame(frame: ElementLike): boolean {
  if (frame.getAttribute('data-embed-video') !== '1') return false
  const src = frame.getAttribute('data-src') ?? ''
  const shown = frame.getAttribute('data-embed-url')
  if (!VIDEO_PLAYER.test(src)) return false
  if (shown !== null && shown !== src) return false
  if (!videoAllowOk(frame.getAttribute('allow'))) return false
  return Array.from(frame.attributes).every((attr) => IFRAME_ATTRS.has(attr.name.toLowerCase()))
}

/** Executable or loading markup left in `fragment`, as `tag@attr` strings; [] when clean. */
function residue(fragment: FragmentLike): string[] {
  const found: string[] = []
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    const tag = element.localName.toLowerCase()
    const svg = element.namespaceURI === SVG_NS
    if (FORBID_TAGS.includes(tag)) found.push(tag)
    if (tag === 'iframe' && !videoPlayerFrame(element)) found.push('iframe')
    if (tag === 'a' && svg && element.getAttribute('target') !== null) found.push('a@target')
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (/^on/.test(name) || FORBID_ATTR.includes(name)) found.push(`${tag}@${name}`)
      else if (URL_ATTRS.has(name) && tag !== 'iframe' && !stepUrlAllowed(tag, name, attr.value, svg)) found.push(`${tag}@${name}`)
      else if ((name === 'style' || (svg && /url\s*\(/i.test(attr.value))) && stepCssUnsafe(attr.value)) found.push(`${tag}@${name}`)
    }
  }
  return found
}

/** A sanitiser bound to `window` (one DOMPurify instance, reused for every step). */
export function createStepHtmlSanitiser(window: WindowLike): StepHtmlSanitiser {
  const purify = DOMPurify(window)
  const document = (window as StepWindow).document
  // DOMPurify trims attribute values and its XML-safety rule drops any value holding `-->` or `]>`,
  // which is ordinary text in a Mermaid source (`A-->B`), an alt or a title. Text attributes are inert
  // in HTML, so their values are held aside while DOMPurify runs (a per-call token stands in) and put
  // back exactly afterwards; DOMPurify still decides whether the attribute itself may stay, and the
  // check after serialising still runs.
  let held = new Map<string, string>()
  let token = ''
  purify.addHook('beforeSanitizeAttributes', (node) => {
    const element = node as unknown as ElementLike
    if (!element.attributes) return
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (!textAttribute(name) || attr.value === '') continue
      const key = `${token}${held.size}`
      held.set(key, attr.value)
      element.setAttribute(attr.name, key)
    }
  })
  return (input: string): SanitisedStepHtml => {
    held = new Map()
    token = `tw-held-${Math.random().toString(36).slice(2)}-`
    const removed = new Set<string>()
    const fragment = purify.sanitize(String(input ?? ''), CONFIG) as unknown as FragmentLike
    for (const entry of purify.removed) {
      if ('attribute' in entry && entry.attribute) {
        const from = (entry.from as unknown as { localName?: string } | undefined)?.localName ?? '?'
        removed.add(`${from}@${entry.attribute.name.toLowerCase()}`)
      } else if ('element' in entry) {
        const name = String((entry.element as unknown as { localName?: string; nodeName?: string }).localName ?? (entry.element as unknown as { nodeName?: string }).nodeName ?? '').toLowerCase()
        if (name && !['body', 'html', 'head', '#text', '#comment'].includes(name)) removed.add(name)
      }
    }

    for (const element of Array.from(fragment.querySelectorAll('*'))) {
      for (const attr of Array.from(element.attributes)) {
        const original = held.get(attr.value)
        if (original !== undefined && textAttribute(attr.name.toLowerCase())) element.setAttribute(attr.name, original)
      }
    }
    held = new Map()

    for (const element of Array.from(fragment.querySelectorAll('*'))) {
      const tag = element.localName.toLowerCase()
      const svg = element.namespaceURI === SVG_NS
      if (tag === 'iframe') {
        if (!videoPlayerFrame(element)) {
          element.remove()
          removed.add('iframe')
        }
        continue
      }
      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase()
        const bad = (URL_ATTRS.has(name) && !stepUrlAllowed(tag, name, attr.value, svg))
          || ((name === 'style' || (svg && /url\s*\(/i.test(attr.value))) && stepCssUnsafe(attr.value))
        if (bad) {
          element.removeAttribute(attr.name)
          removed.add(`${tag}@${name}`)
        }
      }
      if (tag === 'a' && svg && element.getAttribute('target') !== null) {
        element.removeAttribute('target')
        removed.add('a@target')
      } else if (tag === 'a' && !svg && element.getAttribute('target') !== null) {
        const rel = new Set((element.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean))
        rel.add('noopener')
        rel.add('noreferrer')
        element.setAttribute('rel', [...rel].join(' '))
      }
    }

    const holder = document.createElement('template')
    holder.content.appendChild(fragment)
    const html = holder.innerHTML
    // Belt and braces: parse what will be published and look again; fail closed.
    const check = document.createElement('template')
    check.innerHTML = html
    const left = residue(check.content)
    // Serialising and parsing again must give the same markup (no mutation on the way to the page).
    if (check.innerHTML !== html) left.push('unstable markup')
    if (left.length) return { html: '', removed: [...new Set([...removed, ...left])] }
    return { html, removed: [...removed] }
  }
}
