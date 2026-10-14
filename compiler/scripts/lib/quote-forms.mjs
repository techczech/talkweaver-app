// Quote forms (spec: docs/design/2026-10-11-source-styled-quote-slides/…-locked-spec.md; ADR-0038).
//
// One deep module behind a small interface. A quote slide's ONE source line (the cite the author
// would write anyway) is read into fields, the form is detected (never Web: that is read from the
// `form=web` token only), the words take the largest step that fits, and the form renders. Plain
// is today's quote and lives in 06-block-renderers.mjs; this module only decides whether a quote
// is a form and draws the forms that exist.
//
// Interface (everything else is private):
//   parseSourceLine(raw)                  → source line read into a link, an ISBN and typed segments
//   readFields(form, parsed)              → the fields of one form (spec 2.4) + `missing`
//   classifyLink(link)                    → 'x-status' | 'youtube' | 'doi' | 'web' | null
//   detectQuoteForm(parsed)               → { form, detectedBy }             (spec 3, rows 1 to 6)
//   resolveQuoteForm({ token, cite })     → { form, chosen, detectedBy, parsed, fields }
//   quoteFormPlan({ token, cite, paragraphs, picture })
//                                         → everything a surface needs: form, whether it renders,
//                                           step, fit, awaiting words, refusal (spec 7)
//   adoptAddressUnderQuote(blocks, lines, attrs)              compiler hook: the address on its own line under the
//                                                            quotation of a slide with a form is its source line
//   annotateQuoteForm(blocks, layout, attrs, slideId, warn)   compiler hook (08-source-adapters)
//   renderQuoteForm(block, helpers)       → the figure markup, or null when the block is Plain
//
// Pure: no I/O, no DOM, no imports beyond the line estimator in quote-layout.mjs. The renderer and
// the Inspector (src/shared/layout-verbs.ts `describe-quote-source`) call the same functions.
//
// Each form has a renderer: its name is in BUILT_FORMS and its draw function in DRAWERS. A form added later
// without one renders as Plain and
// the Inspector says so (UNBUILT_NOTE).
import { visibleQuoteText, wrappedLineCount } from './quote-layout.mjs'
import { scanQuotes, takeParagraph, QUOTE_DASH_LEAD_RE } from './quote-grammar.mjs'
import { isBareUrl, normalizeEmbedUrl } from './02-triggers-layout.mjs'
import { IMAGE_SYNTAX_RE, imageSyntaxIsAudio, imageSyntaxIsVideo, isImageBlockLine } from './image-line-rules.mjs'
import { plainInlineText } from './00-inline-render.mjs'
import { readPastedReference, stripOuterQuotes } from './quote-reference-styles.mjs'

export const QUOTE_FORM_VALUES = Object.freeze(['auto', 'plain', 'tweet', 'video', 'book', 'paper', 'web'])
const FORM_LABELS = Object.freeze({ plain: 'Plain', tweet: 'Tweet', video: 'Video', book: 'Book', paper: 'Paper', web: 'Web' })
export const quoteFormLabel = (form) => FORM_LABELS[form] ?? 'Plain'
/** Does the `form=` value name a form (any of them, Plain included; not Automatic, not an unknown word)? */
export const quoteFormIsSet = (token) => Object.hasOwn(FORM_LABELS, String(token ?? '').trim().toLowerCase())

// The forms with a renderer. Each later ticket adds its form here (and its drawer below).
export const BUILT_FORMS = Object.freeze(new Set(['tweet', 'video', 'book', 'paper', 'web']))
export const unbuiltFormNote = (form) => `${quoteFormLabel(form)} is not built yet; showing as a plain quote.`

// Words steps (spec 6.1) in px at 1920, with their cqw twins used by the stylesheet.
export const QF_STEPS = Object.freeze({ 1: 65.28, 2: 57.6, 3: 49.92, 4: 44.16 })

// ---------------------------------------------------------------------------------------------
// The source line (spec 2.3)
// ---------------------------------------------------------------------------------------------

const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/
const BARE_URL_RE = /https?:\/\/[^\s<>)\]"“”]+/
const DOI_PREFIXED_RE = /\bdoi:\s*(10\.\d{4,9}\/\S+)/i
const DOI_BARE_RE = /(?<![\w/.])(10\.\d{4,9}\/\S+)/
const ISBN_RE = /\bISBN(?:-1[03])?:?\s*((?:97[89][- ]?)?(?:\d[- ]?){9}[\dX])\b/i
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

// A DOI runs to the next whitespace, so a `;` or `,` inside it (`...CO;2-9`) stays. Only the very end is trimmed: the
// sentence punctuation `.,;:!?`, and a `)` that closes a bracket the DOI did not open.
function trimDoi(doi) {
  let end = doi.length
  for (;;) {
    const head = doi.slice(0, end)
    if (/[.,;:!?]$/.test(head)) { end -= 1; continue }
    if (head.endsWith(')') && (head.match(/\(/g) ?? []).length < (head.match(/\)/g) ?? []).length) { end -= 1; continue }
    return head
  }
}
function doiCandidate(match, group) {
  const doi = trimDoi(group)
  return { index: match.index, length: match[0].length - (group.length - doi.length), url: `https://doi.org/${doi}` }
}

function firstLink(text) {
  const candidates = []
  let match = MD_LINK_RE.exec(text)
  if (match) candidates.push({ index: match.index, length: match[0].length, url: match[2] })
  match = BARE_URL_RE.exec(text)
  if (match) {
    const url = match[0].replace(TRAILING_PUNCT_RE, '')
    candidates.push({ index: match.index, length: url.length, url })
  }
  match = DOI_PREFIXED_RE.exec(text)
  if (match) candidates.push(doiCandidate(match, match[1]))
  else {
    match = DOI_BARE_RE.exec(text)
    if (match) candidates.push(doiCandidate(match, match[1]))
  }
  // A Markdown link whose text is itself a bare URL is one link, not two: the earliest wins.
  candidates.sort((a, b) => a.index - b.index || b.length - a.length)
  return candidates[0] ?? null
}

function urlParts(url) {
  try {
    const parsed = new URL(url)
    return { url, scheme: parsed.protocol.replace(':', ''), host: parsed.hostname.toLowerCase(), urlPath: parsed.pathname, search: parsed.searchParams }
  } catch {
    return { url, scheme: '', host: '', urlPath: '', search: new URLSearchParams() }
  }
}

// Marked spans: *container title*, _container title_, "article title" (spec 2.3 rule 2).
const SPAN_RE = /\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])|"([^"]+)"|“([^”]+)”/g
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const MAX_SOURCE_LINE = 2000
const OPEN = '\u0001'
const CLOSE = '\u0002'

function segmentOf(raw, spans) {
  let container = null
  let article = null
  const restored = raw.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_all, index) => {
    const span = spans[Number(index)]
    if (!span) return ''
    if (span.kind === 'container' && container == null) container = span.text
    if (span.kind === 'article' && article == null) article = span.text
    return span.text
  })
  const rest = raw.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), '').replace(/\s+/g, ' ').trim()
  return { text: restored.replace(/\s+/g, ' ').trim(), container, article, rest }
}

// The rest of the compiler's inline grammar (~~, ++, ==, Markdown links, key caps) is turned into plain text
// by plainInlineText, the compiler's own text-stripper. The marked title spans the parser reads (*title*,
// _title_) are held back from it as inert tokens and put back after, so books and papers keep their title.
const HELD_OPEN = '\uE000'
const HELD_CLOSE = '\uE001'
function plainSourceText(text) {
  const held = []
  const masked = text.replace(/\*([^*]+)\*|(?<![\w])_([^_]+)_(?![\w])/g, (all) => {
    held.push(all)
    return `${HELD_OPEN}${held.length - 1}${HELD_CLOSE}`
  })
  return plainInlineText(masked).replace(new RegExp(`${HELD_OPEN}(\\d+)${HELD_CLOSE}`, 'g'), (_all, index) => held[Number(index)])
}

/**
 * The source line, read (spec 2.3). `link` is the first URL (bare, Markdown, or a DOI), removed
 * from the text; `isbn` is kept for detection only; `segments` are the comma-separated rest, with
 * marked titles recognised and their marks stripped.
 */
export function parseSourceLine(raw) {
  // C0 controls are removed first, so the \u0001/\u0002 markers below cannot occur in the input; the
  // length is capped so no pattern below runs over a hostile line (a real source line is far shorter).
  let text = String(raw ?? '').replace(CONTROL_RE, '').slice(0, MAX_SOURCE_LINE).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
  let link = null
  const found = firstLink(text)
  if (found) {
    link = urlParts(found.url)
    text = `${text.slice(0, found.index)} ${text.slice(found.index + found.length)}`
  }
  text = plainSourceText(text)
  let isbn = null
  const isbnMatch = ISBN_RE.exec(text)
  if (isbnMatch) {
    const digits = isbnMatch[1].replace(/[^0-9X]/gi, '')
    if (digits.length === 10 || digits.length === 13) {
      isbn = digits
      text = text.replace(isbnMatch[0], ' ')
    }
  }
  const spans = []
  const marked = text.replace(SPAN_RE, (_all, star, under, straight, curly) => {
    const kind = star != null || under != null ? 'container' : 'article'
    spans.push({ kind, text: String(star ?? under ?? straight ?? curly).trim() })
    return `${OPEN}${spans.length - 1}${CLOSE}`
  })
  const segments = marked
    .split(',')
    .map((part) => segmentOf(part, spans))
    // A segment that is nothing but link residue or dashes is empty.
    .filter((segment) => segment.text.replace(/^[\s\-–—|·]+|[\s\-–—|·]+$/g, '') !== '')
    .map((segment) => ({ ...segment, text: segment.text.replace(/^[\s\-–—|·]+|[\s\-–—|·]+$/g, ''), rest: segment.rest.replace(/^[\s\-–—|·]+|[\s\-–—|·]+$/g, '') }))
  return { raw: String(raw ?? ''), link, isbn, segments, text }
}

/**
 * Where the source line's link sits in `raw` as written: `{ index, length }` of the Markdown link,
 * bare URL, `doi:` reference or bare DOI that `parseSourceLine` takes as the link, or null. The same
 * locator, run on the line unchanged so the span indexes the author's own text (a writer that keeps or
 * replaces the link needs the original characters, not the cleaned copy `parseSourceLine` reads).
 */
export function sourceLinkSpan(raw) {
  const found = firstLink(String(raw ?? '').slice(0, MAX_SOURCE_LINE))
  return found ? { index: found.index, length: found.length } : null
}

// ---------------------------------------------------------------------------------------------
// Link classification and detection (spec 3)
// ---------------------------------------------------------------------------------------------

const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
const DOI_HOSTS = new Set(['doi.org', 'dx.doi.org', 'www.doi.org'])

export function classifyLink(link) {
  if (!link || !link.host) return null
  if (X_HOSTS.has(link.host) && /^\/(?:i\/web\/status\/\d+|i\/status\/\d+|[^/]+\/status\/\d+)(?:[/?]|$)/.test(link.urlPath)) return 'x-status'
  if (link.host === 'youtu.be' && link.urlPath.length > 1) return 'youtube'
  if (YT_HOSTS.has(link.host) && ((link.urlPath === '/watch' && link.search.get('v')) || /^\/(?:live|shorts|embed)\/[^/]+/.test(link.urlPath))) return 'youtube'
  if (DOI_HOSTS.has(link.host)) return 'doi'
  if (link.scheme === 'http' || link.scheme === 'https') return 'web'
  return null
}

/**
 * The site of an address: host without `www.`, no scheme, port, path, query or fragment (`youtube.com`, `doi.org`). The one
 * function every visible address goes through (the web form's pill, the handout link text, a plain quote's link text).
 * '' when `address` holds no host.
 */
export function siteOf(address) {
  const rest = String(address ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const host = rest.split(/[/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d*$/, '').toLowerCase()
  return host.replace(/^www\./, '')
}

const DOI_ADDRESS_RE = /^https?:\/\/(?:www\.|dx\.)?doi\.org\/(.+)$/i

/** A DOI as the slide's paper footer writes it: `doi:` and the DOI, percent-escapes decoded. */
export function doiText(doi) {
  const raw = String(doi ?? '').trim()
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* a stray % stays as typed */ }
  return `doi:${decoded}`
}

/** `doi:<doi>` for a DOI address (`https://doi.org/…`, `http://dx.doi.org/…`, host in any case), else ''. */
export function doiTextOfAddress(address) {
  const match = DOI_ADDRESS_RE.exec(String(address ?? '').trim())
  return match ? doiText(match[1]) : ''
}

/**
 * A rendered source line (`<cite>` content) with every link whose visible text is its own address cut to the site
 * (`<a href="https://youtu.be/x?t=3">https://youtu.be/x?t=3</a>` becomes `youtu.be`). The `href` is untouched, so the
 * full address stays the link; a link with any other text (a title, a name) is left alone.
 */
export function shortenAddressLinks(html) {
  const bare = (text) => String(text).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
  return String(html ?? '').replace(/(<a href=")([^"]*)("[^>]*>)([^<]*)(<\/a>)/g, (all, open, href, mid, text, close) => {
    if (!/^https?:\/\//i.test(href) || bare(text) !== bare(href)) return all
    const doi = doiTextOfAddress(href)
    if (doi) return `${open}${href}${mid}${esc(doi)}${close}`
    const site = siteOf(href)
    return /^[a-z0-9.-]+$/.test(site) ? `${open}${href}${mid}${site}${close}` : all
  })
}

const YEAR_SEGMENT_RE = /^(?:[A-Za-z]+\.?\s+)?(\d{4})$/
const PAGE_SEGMENT_RE = /^(?:pp?\.|pages?)\s*(\d[\d–—-]*\d|\d)$/i

const isYear = (segment) => YEAR_SEGMENT_RE.test(segment.rest || segment.text)
const isPage = (segment) => PAGE_SEGMENT_RE.test(segment.rest || segment.text)

export function detectQuoteForm(parsed) {
  const kind = classifyLink(parsed.link)
  if (kind === 'x-status') return { form: 'tweet', detectedBy: 'x-link' }
  if (kind === 'youtube') return { form: 'video', detectedBy: 'youtube-link' }
  // A DOI no longer makes a paper by itself (Dominik 2026-10-12): the editor writes `form=paper` when the DOI is added,
  // as it writes `form=web` for a web link (spec 3.1). A quote with a DOI and no `form` is Plain.
  if (parsed.isbn) return { form: 'book', detectedBy: 'isbn' }
  const hasContainer = parsed.segments.some((segment) => segment.container != null)
  const hasArticle = parsed.segments.some((segment) => segment.article != null)
  if (hasContainer && !hasArticle && parsed.segments.some(isYear) && parsed.segments.some(isPage)) {
    return { form: 'book', detectedBy: 'book-reference' }
  }
  return { form: 'plain', detectedBy: 'none' }
}

// ---------------------------------------------------------------------------------------------
// Fields per form (spec 2.4)
// ---------------------------------------------------------------------------------------------

const AVATAR_FILLS = Object.freeze(['#0f766e', '#6d47c9', '#b45309', '#a21caf', '#0f4bd8', '#3b434c'])

/**
 * Stable hash of a name, mod 6 (spec 6.4). Same source, same colour, every compile. A tweet's hash is
 * offset by 3 so the two drawn tweet samples (@techczech, @samplehandle) keep their drawn fills; the
 * video's channel is not offset (offset 0), which is what draws "Sample channel" purple as in the mockup.
 */
export function avatarFill(key, offset = 3) {
  const text = String(key ?? '').trim().toLowerCase()
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return AVATAR_FILLS[(hash + offset) % AVATAR_FILLS.length]
}

export function avatarInitials(name) {
  const words = String(name ?? '').split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  const letter = (word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? ''
  if (words.length === 1) return Array.from(words[0].replace(/[^\p{L}\p{N}]/gu, '')).slice(0, 2).join('').toUpperCase()
  return `${letter(words[0])}${letter(words[words.length - 1])}`.toUpperCase()
}

const CLOCK_RE = /^\d{1,2}:\d{2}(?:\s?[AP]M)?$/i

function readTweet(parsed) {
  const segments = parsed.segments
  let name = ''
  let handle = ''
  const first = segments[0]?.text ?? ''
  if (first) {
    const bracketed = first.match(/\(@([A-Za-z0-9_]+)\)/)
    const trailing = first.match(/(?:^|\s)@([A-Za-z0-9_]+)\s*$/)
    if (bracketed) {
      handle = bracketed[1]
      name = first.replace(bracketed[0], '').trim()
    } else if (trailing) {
      handle = trailing[1]
      name = first.replace(trailing[0], '').trim()
    } else {
      name = first
    }
  }
  if (!handle && parsed.link && classifyLink(parsed.link) === 'x-status') {
    const owner = parsed.link.urlPath.split('/')[1]
    if (owner && owner !== 'i') handle = owner
  }
  const rest = segments.slice(1).map((segment) => segment.text)
  const clocks = rest.filter((part) => CLOCK_RE.test(part))
  const dates = rest.filter((part) => !CLOCK_RE.test(part))
  const date = [...clocks, ...dates].join(' · ')
  const identity = name || handle
  return {
    name,
    handle,
    date,
    displayName: name || handle,
    initials: avatarInitials(identity),
    fill: identity ? avatarFill(handle || name) : '',
    missing: [!name && !handle ? 'name' : null, !handle ? 'handle' : null, !date ? 'date' : null].filter(Boolean)
  }
}

const people = (text) => String(text ?? '').split(/\s*(?:,|&|\band\b)\s*/i).map((part) => part.trim()).filter(Boolean)

export function displayPeople(list, othersUnknown = false) {
  const named = list.filter(Boolean)
  // `et al.` pasted from a reference manager: the number of other authors is not known, so none is given.
  if (othersUnknown) return named.length ? `${named.slice(0, 3).join(', ')} and others` : ''
  if (named.length <= 3) {
    if (named.length <= 1) return named[0] ?? ''
    return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  }
  return `${named.slice(0, 3).join(', ')} and ${named.length - 3} more`
}

function clockFromSeconds(total) {
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = Math.floor(total % 60)
  const two = (n) => String(n).padStart(2, '0')
  return hours ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`
}

function secondsFromTimeParam(value) {
  const text = String(value ?? '').trim()
  if (/^\d+$/.test(text)) return Number(text)
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/)
  if (!match || !match[0]) return null
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
}

const TIME_RE = /^(?:at\s+)?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*\/\s*((?:\d{1,2}:)?\d{1,2}:\d{2}))?$/i
const LENGTH_ONLY_RE = /^\/\s*((?:\d{1,2}:)?\d{1,2}:\d{2})$/

export function secondsFromClock(text) {
  const parts = String(text ?? '').split(':').map(Number)
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

/** Progress bar position in per cent (one decimal) from the time and the length; null draws an empty bar. */
export function videoProgress(time, length) {
  const at = time ? secondsFromClock(time) : null
  const total = length ? secondsFromClock(length) : null
  if (at == null || total == null || total <= 0 || at > total) return null
  return Math.round((at / total) * 1000) / 10
}

function readVideo(parsed) {
  const segments = [...parsed.segments]
  let time = ''
  let length = ''
  const last = segments[segments.length - 1]?.text ?? ''
  const timeMatch = last.match(TIME_RE)
  const lengthOnly = last.match(LENGTH_ONLY_RE)
  if (timeMatch) {
    time = timeMatch[1]
    length = timeMatch[2] ?? ''
    segments.pop()
  } else if (lengthOnly) {
    length = lengthOnly[1]
    segments.pop()
  }
  if (!time && parsed.link) {
    const param = parsed.link.search.get('t') ?? parsed.link.search.get('start')
    const seconds = param == null ? null : secondsFromTimeParam(param)
    if (seconds != null) time = clockFromSeconds(seconds)
  }
  const texts = segments.map((segment) => segment.text)
  let channel = ''
  let title = ''
  if (texts.length >= 2) {
    channel = texts[0]
    title = texts.slice(1).join(', ')
  } else if (texts.length === 1) {
    title = texts[0]
  }
  return {
    channel,
    title,
    time,
    length: time ? length : '',
    lengthWithoutTime: !time && length ? length : '',
    progress: videoProgress(time, time ? length : ''),
    initials: avatarInitials(channel),
    fill: channel ? avatarFill(channel, 0) : '',
    missing: [!channel ? 'channel' : null, !title ? 'title' : null, !time ? 'time' : null, time && !length ? 'length' : null].filter(Boolean)
  }
}

const MONTH_RE = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i

function readYearAndMonth(segments) {
  const segment = segments.find(isYear)
  if (!segment) return { year: '', month: '' }
  const text = segment.rest || segment.text
  const match = text.match(YEAR_SEGMENT_RE)
  const month = text.replace(match[1], '').trim()
  return { year: match[1], month: MONTH_RE.test(month) ? month.replace(/\.$/, '') : '' }
}

function readBook(parsed) {
  const segments = parsed.segments
  const titleIndex = segments.findIndex((segment) => segment.container != null)
  const index = titleIndex >= 0 ? titleIndex : (segments.length > 1 ? 1 : -1)
  const legacyTitle = index >= 0 ? (segments[index].container ?? segments[index].text) : ''
  const authorSegments = (index >= 0 ? segments.slice(0, index) : segments.slice(0, 1)).filter((segment) => !isYear(segment) && !isPage(segment))
  let authors = authorSegments.flatMap((segment) => people(segment.text))
  const after = index >= 0 ? segments.slice(index + 1) : segments.slice(1)
  let { year } = readYearAndMonth(after.concat(segments))
  const pageSegment = segments.find(isPage)
  const pageMatch = pageSegment ? (pageSegment.rest || pageSegment.text).match(PAGE_SEGMENT_RE) : null
  let publisher = after.filter((segment) => !isYear(segment) && !isPage(segment)).map((segment) => segment.text).join(', ')
  const pasted = readPastedReference(parsed)
  let title = legacyTitle
  let othersUnknown = false
  if (pasted) ({ authors, othersUnknown, title, year, publisher } = pasted)
  const pages = pageMatch ? pageMatch[1] : ''
  const page = pages ? (/[–—-]/.test(pages) ? `pages ${pages}` : `page ${pages}`) : ''
  return {
    authors,
    othersUnknown,
    authorsDisplay: displayPeople(authors, othersUnknown),
    title,
    year,
    publisher,
    page,
    isbn: parsed.isbn ?? '',
    missing: [!authors.length ? 'authors' : null, !title ? 'title' : null, !year && !publisher ? 'publisher' : null, !page ? 'page' : null].filter(Boolean)
  }
}

function readPaper(parsed) {
  const segments = parsed.segments
  const articleIndex = segments.findIndex((segment) => segment.article != null)
  const titleIndex = articleIndex >= 0 ? articleIndex : (segments.length > 1 ? 1 : -1)
  let title = titleIndex >= 0 ? (segments[titleIndex].article ?? segments[titleIndex].text) : ''
  const authorSegments = (titleIndex >= 0 ? segments.slice(0, titleIndex) : segments.slice(0, 1)).filter((segment) => !isYear(segment))
  let authors = authorSegments.flatMap((segment) => people(segment.text))
  const journalSegment = segments.find((segment) => segment.container != null)
  let journal = journalSegment?.container ?? ''
  const tail = [journalSegment?.rest ?? '', ...segments.filter((segment) => segment !== journalSegment).map((segment) => segment.text)].join(' ')
  let volume = ''
  let issue = ''
  const volIssue = tail.match(/\b(\d+)\s*\((\d+)\)/)
  if (volIssue) { volume = volIssue[1]; issue = volIssue[2] }
  else {
    volume = tail.match(/\bvol(?:ume)?\.?\s*(\d+)/i)?.[1] ?? ''
    issue = tail.match(/\b(?:no|issue)\.?\s*(\d+)/i)?.[1] ?? ''
  }
  let { year, month } = readYearAndMonth(segments)
  let othersUnknown = false
  let identifier = ''
  let range = ''
  const pasted = readPastedReference(parsed)
  if (pasted) ({ authors, othersUnknown, title, year, month, container: journal, volume, issue, identifier, pages: range } = pasted)
  range = range || (segments.map((segment) => (segment.rest || segment.text).match(/^pp\.\s*(\d+\s*[–—-]\s*\d+)$/i)?.[1]).find(Boolean) ?? '')
  const quotationPage = segments.map((segment) => (segment.rest || segment.text).match(/^(?:p\.|page)\s*(\d+)$/i)?.[1]).find(Boolean) ?? ''
  const doi = classifyLink(parsed.link) === 'doi' ? parsed.link.url.replace(/^https?:\/\/(?:dx\.|www\.)?doi\.org\//i, '') : ''
  return {
    authors,
    othersUnknown,
    authorsDisplay: displayPeople(authors, othersUnknown),
    title,
    journal,
    identifier,
    volume,
    issue,
    year,
    month,
    pages: range.replace(/\s+/g, ''),
    page: quotationPage,
    doi,
    missing: [!authors.length ? 'authors' : null, !title ? 'title' : null, !journal ? 'journal' : null, !doi ? 'doi' : null, !quotationPage ? 'page' : null].filter(Boolean)
  }
}

// The masthead tint of each site-mark fill (spec 17.2): the fill at 10% on white.
const WEB_TINTS = Object.freeze({ '#0f766e': '#e7f1f1', '#6d47c9': '#f0edfa', '#b45309': '#f8eee6', '#a21caf': '#f6e8f7', '#0f4bd8': '#e7edfb', '#3b434c': '#ebeced' })

const DATE_SEGMENT_RE =/^(?:\d{4}-\d{2}-\d{2}|(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,2})?(?:,?\s+\d{4})?|\d{4})$/i

function readWeb(parsed) {
  const segments = parsed.segments
  const link = parsed.link && (parsed.link.scheme === 'http' || parsed.link.scheme === 'https') ? parsed.link : null
  const domain = link ? siteOf(link.host) : ''
  const headlineIndex = segments.findIndex((segment) => segment.article != null)
  const headline = headlineIndex >= 0 ? segments[headlineIndex].article : ''
  const isDate = (segment) => DATE_SEGMENT_RE.test(segment.rest || segment.text)
  const plain = segments.filter((segment) => segment.container == null && segment.article == null)
  const markedSite = segments.find((segment) => segment.container != null)?.container ?? ''
  let site = markedSite
  let authorSegments
  if (headlineIndex >= 0) {
    authorSegments = segments.slice(0, headlineIndex).filter((segment) => !isDate(segment) && segment.container == null)
    if (!site) site = segments.slice(headlineIndex + 1).filter((segment) => !isDate(segment) && segment.container == null).map((segment) => segment.text).join(', ')
  } else {
    const unmarked = plain.filter((segment) => !isDate(segment))
    // One unmarked segment and no headline is the author; a second one is the site.
    authorSegments = unmarked.slice(0, 1)
    if (!site) site = unmarked[1]?.text ?? ''
  }
  const authors = authorSegments.flatMap((segment) => people(segment.text))
  const author = displayPeople(authors)
  const date = segments.filter(isDate).map((segment) => segment.rest || segment.text).join(', ')
  const siteShown = site || domain
  const details = Boolean(headline || site || author || date)
  const fill = siteShown ? avatarFill(domain || site) : ''
  return {
    link: link?.url ?? '',
    domain,
    headline,
    site,
    siteShown,
    author,
    date,
    // Something besides the link is typed: a masthead may stand on the domain, and the pill shows a lock (spec 17.2, assumption 14).
    details,
    secure: link?.scheme === 'https' && details,
    mark: siteShown ? Array.from(siteShown.replace(/^[^\p{L}\p{N}]+/u, ''))[0]?.toUpperCase() ?? '' : '',
    fill,
    tint: WEB_TINTS[fill] ?? '',
    // The byline's avatar: initials of the first author on a fill from the same palette (offset 5 draws "Sample Author" as in the mockup).
    authorInitials: authors.length ? avatarInitials(authors[0]) : '',
    authorFill: authors.length ? avatarFill(authors[0], 5) : '',
    missing: [!headline ? 'headline' : null, !site ? 'site' : null, !author ? 'author' : null, !date ? 'date' : null].filter(Boolean)
  }
}

/** The web page's masthead is drawn when a site name is typed, or when the link's domain can stand in for it and some other detail is typed (spec 5). */
export const webHasMast = (fields) => Boolean(fields.site || (fields.domain && fields.details))

const READERS = { tweet: readTweet, video: readVideo, book: readBook, paper: readPaper, web: readWeb }

/** The fields one form reads from a parsed source line, with `missing` (spec 2.4 and 5). */
export function readFields(form, parsed) {
  const reader = READERS[form]
  return reader ? reader(parsed) : { missing: [] }
}

// ---------------------------------------------------------------------------------------------
// Resolving the form (spec 2.2 and 3)
// ---------------------------------------------------------------------------------------------

const explicitForm = (token) => {
  const value = String(token ?? '').trim().toLowerCase()
  return QUOTE_FORM_VALUES.includes(value) && value !== 'auto' ? value : null
}

/**
 * Which form a source line takes. `token` is the `form=` value ('' / 'auto' = Automatic).
 * An explicit form always wins over the link (spec 3).
 */
export function resolveQuoteForm({ token = '', cite = '' } = {}) {
  const parsed = parseSourceLine(cite)
  const explicit = explicitForm(token)
  const detected = detectQuoteForm(parsed)
  const form = explicit ?? detected.form
  const webLink = (() => {
    const link = parsed.link
    return link && classifyLink(link) === 'web' ? siteOf(link.host) : null
  })()
  // A DOI in the source line, whatever the form: the Inspector offers Paper for it, as it offers Web for a web link.
  const doiLink = Boolean(parsed.link && classifyLink(parsed.link) === 'doi')
  return {
    form,
    chosen: explicit != null,
    detectedBy: explicit != null ? detected.detectedBy : detected.detectedBy,
    parsed,
    fields: readFields(form, parsed),
    webLink,
    doiLink
  }
}

// ---------------------------------------------------------------------------------------------
// Fit (spec 7)
// ---------------------------------------------------------------------------------------------

// X card geometry (spec 6.2): 1380 wide, border 3 and padding 72 each side → 1230 of words; the
// card may be 900 high. The glyph width is the measured 0.435em of the interface face (the spec's
// capacities 293 · 398 · 516 characters reproduce at 6 · 7 · 8 lines).
const TWEET_WORDS_WIDTH = 1380 - 2 * 3 - 2 * 72
const TWEET_GLYPH_EM = 0.435
const TWEET_LINE_HEIGHT = 1.33
const TWEET_MAX_HEIGHT = 900
const TWEET_STEPS = [2, 3, 4]

// Width of one character in units of the average glyph (TWEET_GLYPH_EM), so a run of ordinary letters costs one unit
// each as before and wide or narrow ones cost what they are. Calibrated against the interface face (Helvetica-class
// advances): narrow `ilIj.,:;'|!` are about 0.26em (0.6), `mwMW@%` about 0.8em (1.9), other capitals about 0.68em
// (1.5), digits about 0.556em (1.25), CJK and full-width forms 1em (2.3); the rest is 1. In English prose the narrow
// and wide classes roughly cancel, so prose keeps the step the single average gave.
const NARROW_RE = /[ilIj.,:;'|!]/
const WIDE_RE = /[mwMW@%]/
const CAPITAL_RE = /\p{Lu}/u
const DIGIT_RE = /\d/
const FULL_WIDTH_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u
export function glyphUnits(char) {
  if (NARROW_RE.test(char)) return 0.6
  if (WIDE_RE.test(char)) return 1.9
  if (FULL_WIDTH_RE.test(char)) return 2.3
  if (CAPITAL_RE.test(char)) return 1.5
  if (DIGIT_RE.test(char)) return 1.25
  return 1
}
const wordUnits = (word) => { let sum = 0; for (const char of word) sum += glyphUnits(char); return sum }

// Greedy word wrap of one paragraph into lines of `unitsPerLine` average glyphs (the width-aware twin of quote-layout's
// wrappedLineCount, which counts every character as one).
function wrappedLinesByWidth(paragraph, unitsPerLine) {
  const words = visibleQuoteText(paragraph).split(/\s+/).filter(Boolean)
  if (!words.length) return 0
  let lines = 1
  let used = 0
  for (const word of words) {
    const length = wordUnits(word)
    const next = used === 0 ? length : used + 1 + length
    if (next <= unitsPerLine) { used = next; continue }
    lines += used === 0 ? Math.ceil(length / unitsPerLine) - 1 : Math.ceil(length / unitsPerLine)
    used = length % unitsPerLine || unitsPerLine
    if (used === unitsPerLine) used = 0
  }
  return lines
}

function tweetHeight(lines, step, hasDate) {
  const words = lines * QF_STEPS[step] * TWEET_LINE_HEIGHT
  // border 6 + padding 96 + head 96 + words 40 above + date row (34 + 28 × 1.3) + actions (30 + 3 + 28 + 46)
  return 6 + 96 + 96 + (lines ? 40 + words : 0) + (hasDate ? 34 + 28 * 1.3 : 0) + (30 + 3 + 28 + 46)
}

function tweetFit(paragraphs, hasDate) {
  if (!paragraphs.length) return { step: 2, fits: true, height: tweetHeight(0, 2, hasDate) }
  for (const step of TWEET_STEPS) {
    const perLine = Math.max(8, Math.floor(TWEET_WORDS_WIDTH / (TWEET_GLYPH_EM * QF_STEPS[step])))
    const lines = paragraphs.reduce((sum, paragraph) => sum + wrappedLinesByWidth(paragraph, perLine), 0)
    // Paragraph gaps (.6em) are charged as an extra line each, the same slack the estimate carries elsewhere.
    const height = tweetHeight(lines + Math.max(0, paragraphs.length - 1) * 0.6, step, hasDate)
    if (height <= TWEET_MAX_HEIGHT) return { step, fits: true, height }
  }
  const last = TWEET_STEPS[TWEET_STEPS.length - 1]
  return { step: last, fits: false, height: null }
}

// Video player (spec 6.3 and 7): captions sit in a 1100 wide box (1320 less 110 each side, less the 16 of
// padding at each end of a line), line-height 1.62, 49.92 then 44.16; the block may be 400 high. The glyph
// width is the measured 0.46em of the caption face (the capacities 185 and 265 characters reproduce at 4 and 5 lines).
const PLAYER_CAPTION_WIDTH = 1100 - 32
const PLAYER_GLYPH_EM = 0.46
const PLAYER_LINE_HEIGHT = 1.62
const PLAYER_MAX_CAPTIONS = 400
const PLAYER_STEPS = [3, 4]

function playerFit(paragraphs) {
  if (!paragraphs.length) return { step: 3, fits: true, height: 0 }
  for (const step of PLAYER_STEPS) {
    const perLine = Math.max(8, Math.floor(PLAYER_CAPTION_WIDTH / (PLAYER_GLYPH_EM * QF_STEPS[step])))
    const lines = paragraphs.reduce((sum, paragraph) => sum + wrappedLinesByWidth(paragraph, perLine), 0)
    const height = (lines * PLAYER_LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * 0.6) * QF_STEPS[step]
    if (height <= PLAYER_MAX_CAPTIONS) return { step, fits: true, height }
  }
  return { step: PLAYER_STEPS[PLAYER_STEPS.length - 1], fits: false, height: null }
}

// The left side panel (spec 6.6 and 7), shared by video, book, paper and web (tickets 02, 03, 04, 07):
// the words column is 1119 wide (1920 less the 653 panel and 72 + 76 of padding), line-height 1.42, steps
// 1 to 4, and the words plus the source block may be 864 high. The glyph width is the measured 0.47em of
// --sans (217 · 286 · 391 · 489 characters reproduce at 6 · 7 · 8 · 9 lines with a three-line source block and a pill).
const PANEL_WORDS_WIDTH = 1920 - 653 - 72 - 76
const PANEL_GLYPH_EM = 0.47
const PANEL_LINE_HEIGHT = 1.42
const PANEL_MAX_HEIGHT = 864
const PANEL_STEPS = [1, 2, 3, 4]
const PANEL_FLOOR = 37.2
const PANEL_SOURCE_GAP = 52

/**
 * Height of the source block beside the words: `who` (a line), `wheres` (how many where lines), `pill`
 * (whether a pill follows) and `extra` (lines of DOI or link). 0 when the block is not drawn.
 */
export function panelSourceHeight(step, { who = false, wheres = 0, pill = false, extra = 0 } = {}) {
  if (!who && !wheres && !pill && !extra) return 0
  const whoLine = who ? Math.max(PANEL_FLOOR, 0.58 * QF_STEPS[step]) * 1.3 : 0
  const whereLines = wheres * (6 + PANEL_FLOOR * 1.3)
  const pillRow = pill ? 20 + PANEL_FLOOR * 1.3 + 9 : 0
  const idLines = extra * (16 + PANEL_FLOOR * 1.3)
  return PANEL_SOURCE_GAP + whoLine + whereLines + pillRow + idLines
}

/** The words take the largest step at which words and source block fit 864; the same rule for every panel form. */
export function panelFit(paragraphs, source) {
  if (!paragraphs.length) return { step: 1, fits: true, height: panelSourceHeight(1, source) }
  for (const step of PANEL_STEPS) {
    const perLine = Math.max(8, Math.floor(PANEL_WORDS_WIDTH / (PANEL_GLYPH_EM * QF_STEPS[step])))
    const lines = paragraphs.reduce((sum, paragraph) => sum + wrappedLinesByWidth(paragraph, perLine), 0)
    const words = (lines * PANEL_LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * 0.6) * QF_STEPS[step]
    const height = words + panelSourceHeight(step, source)
    if (height <= PANEL_MAX_HEIGHT) return { step, fits: true, height }
  }
  return { step: PANEL_STEPS[PANEL_STEPS.length - 1], fits: false, height: null }
}

// What the video's source block holds (spec 5): the channel is the who line, else the title; the title is
// the where line when the channel is there; the time is the pill.
function videoSourceParts(fields) {
  const who = fields.channel || fields.title
  return { who: Boolean(who), wheres: fields.channel && fields.title ? 1 : 0, pill: Boolean(fields.time), extra: 0 }
}

// What the book's source block holds (spec 5, 6.6): authors are the who line, else the title; the title is the
// first where line when authors are there; then publisher and year on one line; the page is the pill.
export const publisherYear = (fields) => [fields.publisher, fields.year].filter(Boolean).join(', ')
function bookSourceParts(fields) {
  const who = fields.authorsDisplay || fields.title
  const wheres = (fields.authorsDisplay && fields.title ? 1 : 0) + (publisherYear(fields) ? 1 : 0)
  return { who: Boolean(who), wheres, pill: Boolean(fields.page), extra: 0 }
}

// What the paper's source block holds in the left panel (spec 2.4, 5, 6.6): authors are the who line, else the
// title; the title is the first where line when authors are there; then the journal line; the quotation page is
// the pill; the DOI is the link line.
export function paperJournalLine(fields) {
  if (!fields.journal) return ''
  const volume = fields.volume ? ` ${fields.volume}` : ''
  const issue = fields.issue ? ` (${fields.issue})` : ''
  return `${fields.journal}${volume}${issue}${fields.year ? `, ${fields.year}` : ''}`
}
function paperSourceParts(fields) {
  const who = fields.authorsDisplay || fields.title
  const wheres = (fields.authorsDisplay && fields.title ? 1 : 0) + (paperJournalLine(fields) ? 1 : 0)
  return { who: Boolean(who), wheres, pill: Boolean(fields.page), extra: fields.doi ? 1 : 0 }
}

// The journal page (spec 6.5 and 7): 900 x 980 with a 3 border and 50 70 40 of padding, so 754 wide and 884 high
// inside. Words are --sans 400 at steps 3 then 4, line-height 1.36 (glyph width 0.47em, which reproduces the measured
// 179 and 249 characters at 6 and 7 lines). Filler lines go from below first, then from above, down to 1 and 1.
const PAGE_WIDTH = 900 - 6 - 140
const PAGE_HEIGHT = 980 - 6 - 90
const PAGE_GAP = 26
const PAGE_STEPS = [3, 4]
const PAGE_WORDS_LINE_HEIGHT = 1.36
const PAGE_TITLE_GLYPH_EM = 0.49
const PAGE_AUTHORS_GLYPH_EM = 0.47
const PAGE_FOOTER_HEIGHT = 3 + 14 + 34 * 1.3
const PAGE_FILLER_ABOVE = 5
const PAGE_FILLER_BELOW = 4
const fillerHeight = (lines) => lines * 16 + Math.max(0, lines - 1) * 20

/** The filler line counts the page tries, in order: 5 and 4, then below down to 1, then above down to 1. */
export const PAGE_FILLER_LADDER = Object.freeze([
  ...[4, 3, 2, 1].map((below) => [PAGE_FILLER_ABOVE, below]),
  ...[4, 3, 2, 1].map((above) => [above, 1])
])

/** The second step's rungs: 1 and 1, then no filler lines at all, so the quoted words have the room the lines held. */
export const PAGE_FILLER_LAST_STEP = Object.freeze([[1, 1], [0, 0]])

/** The head, title and authors of a journal page: which are drawn, and the issue line (spec 2.4). */
export function pageHeadParts(fields) {
  const parts = []
  if (fields.volume) parts.push(`Volume ${fields.volume}`)
  if (fields.issue) parts.push(`Issue ${fields.issue}`)
  if (fields.identifier) parts.push(fields.identifier)
  const date = [fields.month, fields.year].filter(Boolean).join(' ')
  if (date) parts.push(date)
  if (fields.pages) parts.push(`pp. ${fields.pages}`)
  return { journal: fields.journal, issueLine: parts.join(' · '), title: fields.title, authors: fields.authorsDisplay }
}

function pageCaptionHeight(fields) {
  const { journal, issueLine, title, authors } = pageHeadParts(fields)
  const blocks = []
  if (journal) blocks.push(44.2 + (issueLine ? 2 + 33.8 : 0) + 20)
  if (title) blocks.push(wrappedLineCount(title, Math.floor(PAGE_WIDTH / (PAGE_TITLE_GLYPH_EM * 42))) * 42 * 1.2)
  if (authors) blocks.push(wrappedLineCount(authors, Math.floor(PAGE_WIDTH / (PAGE_AUTHORS_GLYPH_EM * 28))) * 28 * 1.35 - (title || journal ? 10 : 0))
  return blocks.length ? blocks.reduce((sum, h) => sum + h, 0) + (blocks.length - 1) * PAGE_GAP : 0
}

function pageFit(paragraphs, fields) {
  const caption = pageCaptionHeight(fields)
  const footer = fields.doi || fields.page ? PAGE_FOOTER_HEIGHT : 0
  if (!paragraphs.length) return { step: PAGE_STEPS[0], fits: true, height: null, filler: { above: PAGE_FILLER_ABOVE, below: PAGE_FILLER_BELOW } }
  // The page's capacities (spec 6.5) were measured with the plain character count, so it keeps that count.
  for (const step of PAGE_STEPS) {
    const perLine = Math.max(8, Math.floor(PAGE_WIDTH / (PANEL_GLYPH_EM * QF_STEPS[step])))
    const lines = paragraphs.reduce((sum, paragraph) => sum + wrappedLineCount(paragraph, perLine), 0)
    const words = (lines * PAGE_WORDS_LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * 0.6) * QF_STEPS[step]
    // At the second step the page has already given up room: it is drawn with 1 and 1 (paper-page-long).
    // The last rung of all, after the second step at 1 and 1: the grey lines go (Dominik 2026-10-12), 0 and 0.
    for (const [above, below] of step === PAGE_STEPS[0] ? PAGE_FILLER_LADDER : PAGE_FILLER_LAST_STEP) {
      const children = [caption, fillerHeight(above), words, fillerHeight(below), footer].filter((h) => h > 0)
      const height = children.reduce((sum, h) => sum + h, 0) + (children.length - 1) * PAGE_GAP
      if (height <= PAGE_HEIGHT) return { step, fits: true, height, filler: { above, below } }
    }
  }
  return { step: PAGE_STEPS[PAGE_STEPS.length - 1], fits: false, height: null, filler: { above: 1, below: 1 } }
}

// What the web page's source block holds in the left panel (spec 17.2): the author is the who line (else the site, or the
// domain standing in for it); the headline is a where line; then the site and date joined with ", " (with no author the
// site took the who line, so the date stands alone).
export function webSourceLines(fields) {
  const site = fields.siteShown || ''
  const who = fields.author || site
  const wheres = []
  if (fields.headline) wheres.push(fields.headline)
  if (fields.author) {
    const line = [site, fields.date].filter(Boolean).join(', ')
    if (line) wheres.push(line)
  } else if (fields.date) wheres.push(fields.date)
  return { who, wheres }
}
function webSourceParts(fields) {
  const { who, wheres } = webSourceLines(fields)
  return { who: Boolean(who), wheres: wheres.length, pill: false, extra: 0 }
}

// The browser window (spec 17.2 and 7): 1560 wide with a 3 border, so 1394 of words inside the 80 side padding; the words
// are --sans 400 at steps 2 to 4, line-height 1.4 (glyph width 0.47em reproduces the measured 258 · 364 · 480 characters at
// 5 · 6 · 7 lines); the window may be 940 high. Above the words: the 92 bar, the 92 masthead and the post head (52 padding,
// the headline at 38 / 1.25 cut at 3 lines, the 48 high byline 20 below it). 44 above the words and 60 below (64 above when
// nothing but the bar is over them); only the link known: 40 and a 35 high domain line under them.
const WEB_WINDOW_BORDER = 6
const WEB_WORDS_WIDTH = 1560 - WEB_WINDOW_BORDER - 160
const WEB_GLYPH_EM = 0.47
const WEB_LINE_HEIGHT = 1.4
const WEB_MAX_HEIGHT = 940
const WEB_STEPS = [2, 3, 4]
const WEB_HEADLINE_GLYPH_EM = 0.5
const WEB_HEADLINE_UNITS = Math.floor(WEB_WORDS_WIDTH / (WEB_HEADLINE_GLYPH_EM * 38))

function webChromeHeight(fields) {
  const bar = fields.link ? 92 : 0
  const mast = webHasMast(fields) ? 92 : 0
  const byline = fields.author || fields.date
  let post = 0
  if (fields.headline || byline) {
    const headlineLines = fields.headline ? Math.min(3, wrappedLinesByWidth(fields.headline, WEB_HEADLINE_UNITS)) : 0
    post = 52 + headlineLines * 38 * 1.25 + (byline ? (fields.headline ? 20 : 0) + 48 : 0)
  }
  const above = bar + mast + post
  const linkOnly = fields.link && !fields.details
  const top = !mast && !post ? 64 : 44  // 64 when nothing but the bar (or nothing) is above the words
  return { above, top, bottom: 60 + (linkOnly ? 40 + 35 : 0) }
}

function webFit(paragraphs, fields) {
  const chrome = webChromeHeight(fields)
  const fixed = WEB_WINDOW_BORDER + chrome.above + chrome.top + chrome.bottom
  if (!paragraphs.length) return { step: WEB_STEPS[0], fits: true, height: null }
  for (const step of WEB_STEPS) {
    const perLine = Math.max(8, Math.floor(WEB_WORDS_WIDTH / (WEB_GLYPH_EM * QF_STEPS[step])))
    const lines = paragraphs.reduce((sum, paragraph) => sum + wrappedLinesByWidth(paragraph, perLine), 0)
    const words = (lines * WEB_LINE_HEIGHT + Math.max(0, paragraphs.length - 1) * 0.6) * QF_STEPS[step]
    const height = fixed + words
    if (height <= WEB_MAX_HEIGHT) return { step, fits: true, height }
  }
  return { step: WEB_STEPS[WEB_STEPS.length - 1], fits: false, height: null }
}

const FITTERS = {
  web: (plan) => (plan.picture ? panelFit(plan.paragraphs, webSourceParts(plan.fields)) : webFit(plan.paragraphs, plan.fields)),
  tweet: (plan) => tweetFit(plan.paragraphs, Boolean(plan.fields.date)),
  video: (plan) => (plan.picture ? panelFit(plan.paragraphs, videoSourceParts(plan.fields)) : playerFit(plan.paragraphs)),
  book: (plan) => panelFit(plan.paragraphs, bookSourceParts(plan.fields)),
  paper: (plan) => (plan.picture ? panelFit(plan.paragraphs, paperSourceParts(plan.fields)) : pageFit(plan.paragraphs, plan.fields))
}

const PRESENTATION = { tweet: 'card', video: 'player', book: 'panel', paper: 'page', web: 'window', plain: 'plain' }
// The picture decides (spec 1, decision 6): a form that has both draws the left panel when the slide has one.
const PANEL_WITH_PICTURE = new Set(['video', 'paper', 'web'])  // book is always a panel (PRESENTATION)

// The one place the drawers (and the fit) take the quoted words from: a quotation typed inside one outer pair of
// quotation marks is shown without that pair.
const cleanParagraphs = (paragraphs) => stripOuterQuotes((Array.isArray(paragraphs) ? paragraphs : []).map((p) => String(p ?? '').trim()).filter(Boolean))

/**
 * Everything a surface needs about one quote slide. `renders` is true when this module draws the
 * slide; false means it is today's Plain quote (Plain chosen, nothing detected, an unbuilt form,
 * or a form that refuses). `refusal` names the form that refused, for the warning.
 */
export function quoteFormPlan({ token = '', cite = '', paragraphs = [], picture = false } = {}) {
  const resolved = resolveQuoteForm({ token, cite })
  const words = cleanParagraphs(paragraphs)
  const awaiting = words.length === 0
  const plan = { ...resolved, paragraphs: words, awaiting, picture, built: false, renders: false, refused: false, step: 0, fits: true, presentation: 'plain', note: '' }
  if (resolved.form === 'plain') return plan
  if (!BUILT_FORMS.has(resolved.form)) {
    plan.note = unbuiltFormNote(resolved.form)
    return plan
  }
  plan.built = true
  plan.presentation = PANEL_WITH_PICTURE.has(resolved.form) && picture ? 'panel' : PRESENTATION[resolved.form]
  const fit = FITTERS[resolved.form](plan)
  plan.step = fit.step
  plan.fits = fit.fits
  if (fit.filler) plan.filler = fit.filler
  if (!fit.fits) {
    plan.refused = true
    plan.presentation = 'plain'
    return plan
  }
  plan.renders = true
  return plan
}

// ---------------------------------------------------------------------------------------------
// Reading a slide from its outline lines (the Inspector's verbs; the compiler reads blocks instead)
// ---------------------------------------------------------------------------------------------

const IMAGE_LINE_RE = /!\[[^\]]*\]\(([^)]*)\)/
const IMAGE_LINES_RE = /!\[[^\]]*\]\(([^)]*)\)/g
// A video in the talk's media pool is written by its id; the app resolves it to the video file before the lexer reads it.
const POOLED_VIDEO_RE = /^vid-[0-9a-f]{7}$/i

/**
 * Is the target of an image-syntax reference a picture? Decided by the lexer's own rules (image-line-rules.mjs:
 * a video file is a video block, an audio file an audio block), so the editing side and the compiler cannot disagree
 * about which image-syntax lines are pictures. `target` is what stands in the parentheses (a "caption" may follow).
 */
function isPictureTarget(target) {
  const src = String(target ?? '').trim().split(/\s+/)[0] ?? ''
  return !imageSyntaxIsVideo(src) && !imageSyntaxIsAudio(src) && !POOLED_VIDEO_RE.test(src)
}

/**
 * A line that holds only image syntax: 'picture' when it is a picture (or several), 'media' when it is a video or an
 * audio file written in image syntax, which the lexer makes a video or audio block: content beside the quotation, as
 * any other block is. Null when the line holds anything else. A line the lexer reads as one image-syntax block
 * (IMAGE_SYNTAX_RE, playback tokens included) is classified by the lexer's own test, isImageBlockLine.
 */
function imageOnlyLine(trimmed) {
  if (IMAGE_SYNTAX_RE.test(trimmed)) return isImageBlockLine(trimmed) && isPictureTarget(IMAGE_SYNTAX_RE.exec(trimmed)[2]) ? 'picture' : 'media'
  if (trimmed.replace(IMAGE_LINES_RE, '').trim()) return null
  return [...trimmed.matchAll(IMAGE_LINES_RE)].every((match) => isPictureTarget(match[1])) ? 'picture' : 'media'
}

/**
 * The quotations the compiler would count on the slide's body lines: `>` blocks and promoted quoted paragraphs,
 * found by the lexer's own grammar (quote-grammar.mjs), less practice quotes (annotateQuoteForm skips them).
 */
function eligibleQuotes(clean) {
  return scanQuotes(clean).filter((found) => !found.block.practice)
}

const cleanLines = (lines) => lines.map((line) => String(line ?? '').replace(/\r$/, ''))

/** How many separate quotations the body lines hold, counted as annotateQuoteForm counts them. */
export function countQuoteBlocks(lines) {
  return eligibleQuotes(cleanLines(lines)).length
}

/**
 * Where a promoted quote's tail source sits: after the closing quote on the paragraph itself (a dash or a
 * parenthetical), lines `start` to `end - 1` of `clean`. Returns the source the writer replaces in place:
 * `endIndex`, `prefix` (the line's text before the lead), `lead` (the dash or parenthesis as written), `suffix`.
 * Null when the lead cannot be placed on a line.
 */
function promotedTailSource(clean, start, end, cite) {
  const joined = clean.slice(start, end).map((line) => line.trim()).join(' ')
  const text = joined.trim()
  const closeIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf('”'))
  const tail = text.slice(closeIdx + 1)
  const leadMatch = tail.match(/^[.,;:!?]*\s*([—–-]\s*|\()/)
  const leadAt = closeIdx + 1 + (leadMatch ? leadMatch[0].length - leadMatch[1].length : 0)
  let offset = 0
  for (let i = start; i < end; i += 1) {
    const line = clean[i].trim()
    if (leadAt < offset + line.length || (leadAt === offset + line.length && i === end - 1)) {
      const column = Math.max(0, leadAt - offset)
      const rawLine = clean[i]
      const shift = rawLine.length - rawLine.trimStart().length
      const lead = leadMatch ? leadMatch[1] : '— '
      const paren = lead.startsWith('(')
      const suffix = paren ? (/\)\.$/.test(text) ? ').' : ')') : ''
      return { index: i, endIndex: end - 1, kind: 'promoted-tail', prefix: rawLine.slice(0, shift + column), lead: paren ? '(' : lead, suffix }
    }
    offset += line.length + 1
  }
  return null
}

/**
 * The one content block of a slide that has no quotation: a one-item bullet list or a paragraph (pictures aside).
 * Null when the slide holds none or several blocks, or a block of another kind.
 */
function lonelyContent(clean) {
  const items = []
  let i = 0
  while (i < clean.length) {
    const t = clean[i].trim()
    if (!t || !t.replace(IMAGE_LINE_RE, '').trim()) { i += 1; continue }
    if (/^[-*]\s+/.test(t)) {
      const start = i
      let rows = 0
      while (i < clean.length && /^\s*([-*]\s+|\d+[.)]\s+)/.test(clean[i])) { rows += 1; i += 1 }
      items.push({ kind: 'list', rows, start, text: t.replace(/^[-*]\s+/, '').replace(IMAGE_LINE_RE, '').trim() })
      continue
    }
    const paragraph = takeParagraph(clean, i)
    if (!paragraph.parts.length) { items.push({ kind: 'other' }); i += 1; continue }
    items.push({ kind: 'paragraph', start: i, end: paragraph.end, text: paragraph.parts.join(' ').replace(IMAGE_LINE_RE, '').trim() })
    i = paragraph.end
  }
  if (items.length !== 1 || items[0].kind === 'other' || (items[0].kind === 'list' && items[0].rows !== 1)) return null
  return items[0]
}

/**
 * Whether the slide's body lines hold anything that paints beside the one quotation `found`, as annotateQuoteForm's
 * rule reads the compiled blocks (paintsBesideQuote): any non-blank line outside the quotation's own lines (its
 * citation, folded or in-block, is inside them) that is not a picture line. Picture lines never count, however many
 * there are (extra pictures are not drawn). A video or an audio file in image syntax is not a picture (imageOnlyLine):
 * it paints, as a practice quote, a list, a paragraph, a table, a fence or a directive does; comments and speaker
 * notes are blank in `clean`.
 */
function otherPaintingContent(clean, found) {
  for (let i = 0; i < clean.length; i += 1) {
    if (i >= found.start && i < found.end) continue
    const t = clean[i].trim()
    if (!t) continue
    if (imageOnlyLine(t) === 'picture') continue
    return true
  }
  return false
}

/**
 * The web address on a line of its own directly under the one quotation `found` (ticket 10): the quotation has no
 * source line, and the only other thing on the slide that paints is one paragraph that is wholly a bare http(s) address
 * (the lexer's `isBareUrl`, which makes it an embed block), after the quotation with nothing but blank lines between.
 * Pictures never count, but one between the quotation and the address means the address is not directly under it.
 * Only a picture is a picture: a video or an audio file in image syntax is other content (imageOnlyLine), so the slide
 * is not the shape, wherever that line stands.
 * Returns `{ index, url }` (`index` into `clean`, `url` as typed), or null. Whether the address stands as the
 * source line is the caller's rule: the compiler and the verbs read it so only on a slide whose `form` is set, and
 * the editor's link rule reads it to set that form.
 */
function addressUnderQuote(clean, found) {
  if (found.block.cite) return null
  let at = -1
  for (let i = 0; i < clean.length; i += 1) {
    if (i >= found.start && i < found.end) continue
    const t = clean[i].trim()
    if (!t) continue
    if (imageOnlyLine(t) === 'picture') {
      if (at < 0 && i >= found.end) return null
      continue
    }
    if (at >= 0 || i < found.end || !isBareUrl(t)) return null
    // The paragraph is that one line: a line joined to it (a picture line straight after) makes it prose.
    if (takeParagraph(clean, i).end !== i + 1) return null
    at = i
  }
  return at < 0 ? null : { index: at, url: clean[at].trim() }
}

/** Where the source of one found quotation sits, and how to write it back (see readQuoteSlideLines). */
function sourceOf(clean, found) {
  if (found.citeLine >= 0) {
    // `> — Name`, `> – Name` or `> - Name` as the block's last line: the prefix is kept as written.
    const raw = clean[found.citeLine]
    const open = raw.match(/^\s*>\s?/)[0]
    const lead = raw.slice(open.length).match(QUOTE_DASH_LEAD_RE)[0]
    return { index: found.citeLine, kind: 'quote-dash', prefix: open + lead }
  }
  if (found.foldedLine >= 0) {
    return { index: found.foldedLine, kind: /^\s*[—–]/.test(clean[found.foldedLine]) ? 'dash' : 'bullet' }
  }
  if (found.kind === 'promoted' && found.block.cite) return promotedTailSource(clean, found.start, found.bodyEnd, found.block.cite)
  return null
}

/**
 * What the compiler would see on a quote slide, read from its body lines (the lines after the Trigger block, comments
 * blanked): the quoted words, the source line and where it sits, and whether there is a picture. The quotation is
 * the first one quote-grammar.mjs finds that the compiler counts (a `>` block or a promoted quoted paragraph, not a
 * practice quote), so the words and the citation are the lexer's own. On a slide with no such quotation the source
 * is its single line (a quote slide made of a link). `source.index` is an index into `lines`; `source.kind` says how
 * to write it back: 'quote-dash' (with `prefix`, the `> - ` as written), 'dash', 'bullet', 'bare', 'promoted-tail'.
 * `otherContent` is true when something else paints on the slide beside the quotation (see otherPaintingContent), which
 * keeps the slide Plain.
 *
 * `address` is the web address on its own line directly under the quotation (addressUnderQuote), or null. Read with
 * no `token` it is other content, as the compiler draws it on a slide with no form (an embed card). Read with the
 * slide's `form=` value, and that value a set form, the address is the source line, as the compiler reads it there:
 * `cite` is the address, `source.kind` is 'address', and `otherContent` is false.
 */
export function readQuoteSlideLines(lines, token = '') {
  const clean = cleanLines(lines)
  let picture = false
  let pictureIndex = -1
  // The first image line anywhere on the slide is the picture (spec 2.5), before or after the quote. A video or an
  // audio file in image syntax is not one (isPictureTarget: the lexer's own rule).
  for (let i = 0; i < clean.length && !picture; i += 1) {
    const image = clean[i].trim().match(IMAGE_LINE_RE)
    if (image && isPictureTarget(image[1])) { picture = true; pictureIndex = i }
  }
  const scanned = scanQuotes(clean)
  const found = scanned.find((entry) => !entry.block.practice)
  if (found) {
    const address = addressUnderQuote(clean, found)
    const shared = { paragraphs: found.block.paragraphs, picture, pictureIndex, hasQuote: true, quoteEnd: found.bodyEnd, address }
    if (address && quoteFormIsSet(token)) return { ...shared, cite: address.url, source: { index: address.index, kind: 'address' }, otherContent: false }
    return { ...shared, cite: found.block.cite, source: sourceOf(clean, found), otherContent: otherPaintingContent(clean, found) }
  }
  // Only a slide holding no quotation at all (not even a practice one) can be a quote slide made of its source line:
  // exactly one content block, a bullet or a paragraph (linkOnlyBlock reads it the same way on the compiled blocks).
  const only = scanned.length ? null : lonelyContent(clean)
  let cite = ''
  let source = null
  if (only?.kind === 'list') {
    cite = only.text
    source = { index: only.start, kind: 'bullet' }
  } else if (only?.kind === 'paragraph') {
    cite = only.text
    source = { index: only.start, endIndex: only.end - 1, kind: 'bare' }
  }
  return { paragraphs: [], cite, picture, pictureIndex, hasQuote: false, quoteEnd: -1, address: null, source, otherContent: false }
}

// ---------------------------------------------------------------------------------------------
// Compiler hook (08-source-adapters.mjs)
// ---------------------------------------------------------------------------------------------

/**
 * The address on its own line under a quotation is the quote's source link on a slide whose `form` is set (ticket 10):
 * the embed block the lexer made of it leaves `blocks`, and the quotation takes the address as its citation, exactly
 * as if it had been written `- https://…`. Every later reader (the title attribution, annotateQuoteForm, the
 * renderers, the handout and print, the projections) then sees a quote with a source line and no embed. `lines` are
 * the lines `blocks` were lexed from; the shape is read from them with the editor's own reader (readQuoteSlideLines)
 * and then checked on the blocks, so nothing is taken that the lexer read differently. A slide with no `form`, with
 * `form=auto`, with a source line, a second quotation, a second address or anything else beside the quotation is
 * left as it is: the address stays an embed card. Mutates `blocks` and returns it.
 */
export function adoptAddressUnderQuote(blocks, lines, attrs) {
  const token = attrs?.form
  if (!Array.isArray(blocks) || !quoteFormIsSet(token)) return blocks
  const bodyLines = Array.isArray(lines) ? lines : []
  const address = countQuoteBlocks(bodyLines) === 1 ? readQuoteSlideLines(bodyLines).address : null
  if (!address) return blocks
  const quotes = blocks.filter((block) => block && block.type === 'quote' && !block.practice)
  const quote = quotes[0]
  if (quotes.length !== 1 || String(quote.cite ?? '').trim()) return blocks
  const embed = blocks.find((block) => block && block.type === 'embed')
  if (!embed || embed.variant !== 'embed' || embed.src !== normalizeEmbedUrl(address.url)) return blocks
  if (blocks.indexOf(embed) < blocks.indexOf(quote)) return blocks
  if (blocks.some((block) => block && block !== quote && block !== embed && block.type !== 'image' && block.type !== 'image-row')) return blocks
  quote.cite = address.url
  blocks.splice(blocks.indexOf(embed), 1)
  return blocks
}

const hasPictureBlock = (blocks) => (blocks || []).some((block) => block && (block.type === 'image' || block.type === 'image-row'))

/**
 * The rule for "something else paints on the slide": any block other than the one quotation and pictures. Pictures
 * never count, however many there are (extra pictures are not drawn). (Comments and speaker notes never become blocks.)
 * otherPaintingContent reads the same rule on lines.
 */
function paintsBesideQuote(blocks, quote) {
  return (blocks || []).some((block) => block && block !== quote && block.type !== 'image' && block.type !== 'image-row')
}

// A quote slide whose only content is the source line (`- link`, a bare paragraph or a bare URL):
// that line is the source line (spec 3, last bullet). Returns the block and its text.
function linkOnlyBlock(blocks) {
  const content = (blocks || []).filter((block) => block && block.type !== 'image' && block.type !== 'image-row')
  if (content.length !== 1) return null
  const block = content[0]
  if (block.type === 'feature-list' && Array.isArray(block.items) && block.items.length === 1) return { block, text: String(block.items[0] ?? '') }
  if (block.type === 'paragraph' && typeof block.text === 'string') return { block, text: block.text }
  if (block.type === 'embed' && typeof block.src === 'string') return { block, text: block.src }
  return null
}

/**
 * Decide each quote block's form on a quote-layout slide and record it on the block
 * (`block.quoteForm`). Mutates `blocks` in place: a Tweet takes no picture (the image is dropped,
 * hint `quote-form-picture-unused`), and a link-only slide gets the quote block it stands for.
 * Warnings go through `warn`; the registry (warning-registry.mjs) owns their wording.
 */
export function annotateQuoteForm(blocks, layout, attrs, slideId, warn) {
  if (layout !== 'quote' || !Array.isArray(blocks)) return
  const token = String(attrs?.form ?? '').trim().toLowerCase()
  // A form is a full-slide card for one quotation. With two or more quote blocks the slide stays plain
  // (as before this feature); an explicit form other than Plain says so once.
  if (blocks.filter((block) => block && block.type === 'quote' && !block.practice).length > 1) {
    if (token && token !== 'auto' && token !== 'plain') warn(`quote-form-several-quotes:${slideId}`)
    return
  }
  let quote = blocks.find((block) => block && block.type === 'quote' && !block.practice)
  // The card is the whole slide: with a list, a paragraph or any other painting block beside the quotation (or a
  // second picture) the slide stays plain, and an explicit form other than Plain says so once.
  if (quote && paintsBesideQuote(blocks, quote)) {
    if (token && token !== 'auto' && token !== 'plain') warn(`quote-form-other-content:${slideId}`)
    return
  }
  const picture = hasPictureBlock(blocks)
  if (!quote) {
    const only = linkOnlyBlock(blocks)
    if (!only) return
    const probe = quoteFormPlan({ token, cite: only.text, paragraphs: [], picture })
    if (!probe.renders) return
    quote = { type: 'quote', text: '', paragraphs: [], cite: only.text }
    blocks.splice(blocks.indexOf(only.block), 1, quote)
  }
  const paragraphs = Array.isArray(quote.paragraphs) && quote.paragraphs.length ? quote.paragraphs : [quote.text ?? '']
  const plan = quoteFormPlan({ token, cite: quote.cite ?? '', paragraphs, picture })
  if (plan.refused) {
    warn(`quote-form-too-long:${slideId}:${quoteFormLabel(plan.form)}`)
    return
  }
  if (!plan.renders) return
  const sourceHolds = plan.parsed.segments.length > 0 || plan.parsed.link != null
  if (token && !sourceHolds) warn(`quote-form-source-empty:${slideId}`)
  if (plan.awaiting) warn(`quote-form-no-words:${slideId}`)
  if (plan.form === 'tweet') {
    const images = blocks.filter((block) => block && (block.type === 'image' || block.type === 'image-row'))
    const count = images.reduce((sum, block) => sum + (block.type === 'image-row' ? (block.images || []).length : 1), 0)
    if (count > 0) {
      for (const block of images) blocks.splice(blocks.indexOf(block), 1)
      warn(`quote-form-picture-unused:${slideId}`)
    }
  } else if (plan.presentation === 'panel') {
    // The first image is the picture in the left panel (spec 2.5). It stays in the block list so the
    // compiler's asset pass reads it; the renderer hands it to the quote (renderBlocks) and does not
    // draw it as a figure. A second image is never drawn: hint quote-form-picture-unused.
    const images = blocks.filter((block) => block && block.type === 'image')
    const [first, ...others] = images
    if (first) {
      first.quoteFormPicture = true
      if (!String(first.alt ?? '').trim()) warn(`quote-form-picture-no-alt:${slideId}`)
    }
    if (others.length) {
      for (const block of others) blocks.splice(blocks.indexOf(block), 1)
      warn(`quote-form-picture-unused:${slideId}`)
    }
  }
  if (String(attrs?.title ?? '').toLowerCase() === 'show') {
    warn(`quote-form-title-unpainted:${slideId}`)
    // The card is the whole slide: the heading must not be painted around or behind it. Drop the typed value so the
    // quote layout's hidden-title regime stays on, exactly as if {title=show} were absent.
    delete attrs.title
  }
  quote.quoteForm = {
    form: plan.form,
    step: plan.step,
    awaiting: plan.awaiting,
    fields: plan.fields,
    presentation: plan.presentation,
    picture: plan.presentation === 'panel',
    ...(plan.filler ? { filler: plan.filler } : {})
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering (spec 6.2 and the mockup's slide markup)
// ---------------------------------------------------------------------------------------------

const X_MARK_PATH = 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'

export const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function icon(helpers, name, size) {
  const body = helpers.iconBody(name)
  return `<svg class="qf-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

function drawTweet(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = cleanParagraphs(Array.isArray(block.paragraphs) && block.paragraphs.length ? block.paragraphs : [block.text ?? ''])
  const known = Boolean(fields.displayName)
  const mark = `<svg class="qf-x-mark" width="56" height="56" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="X"><path d="${X_MARK_PATH}"/></svg>`
  const head = known
    ? `<span class="qf-avatar" style="background:${fields.fill}" aria-hidden="true">${esc(fields.initials)}</span>`
      + `<span class="qf-x-who"><b class="qf-x-name">${esc(fields.displayName)}</b>${fields.name && fields.handle ? `<span class="qf-x-handle">@${esc(fields.handle)}</span>` : ''}</span>${mark}`
    : `<span class="qf-avatar qf-avatar-empty qf-placeholder" aria-hidden="true"></span><span class="qf-placeholder qf-ph qf-ph-who" aria-hidden="true">Name and handle</span>${mark}`
  const words = awaiting
    ? '<div class="qf-placeholder qf-ph qf-ph-words" aria-hidden="true">Quoted words go here</div>'
    : `<blockquote class="qf-words">${paragraphs.map((p) => `<p>${helpers.renderInline(p)}</p>`).join('')}</blockquote>`
  const date = fields.date ? `<div class="qf-x-time">${esc(fields.date)}</div>` : ''
  const actions = `<div class="qf-x-actions" aria-hidden="true"><span>${icon(helpers, 'message-circle', 46)}</span><span>${icon(helpers, 'repeat-2', 46)}</span><span>${icon(helpers, 'heart', 46)}</span><span class="qf-x-right">${icon(helpers, 'bookmark', 46)}${icon(helpers, 'share', 46)}</span></div>`
  const sr = awaiting ? 'Post on X. No words yet.' : 'Post on X.'
  return `<figure class="qf qf-tweet${awaiting ? ' qf-awaiting' : ''}" data-step="${step}"><span class="qf-sr">${sr}</span><div class="qf-x-card"><figcaption class="qf-x-head">${head}</figcaption>${words}${date}${actions}</div></figure>`
}

// The YouTube lozenge over a panel picture (spec 6.3): one inline SVG, 104 × 74, sized in CSS.
const YT_LOZENGE = '<svg class="qf-yt-mark" width="104" height="74" viewBox="0 0 104 74" role="img" aria-label="YouTube"><rect width="104" height="74" rx="20" fill="#f00"/><path d="M42 21v32l28-16z" fill="#fff"/></svg>'
const PLACEHOLDER_WORDS = 'Quoted words go here'

const wordsParagraphs = (block) => cleanParagraphs(Array.isArray(block.paragraphs) && block.paragraphs.length ? block.paragraphs : [block.text ?? ''])

// The played part of the progress bar: nothing at all (no red, no knob) when the length or the time is not known.
const progressMarkup = (progress) => (progress == null ? '' : `<span class="qf-yt-played" style="width:${progress}%"></span><span class="qf-yt-knob" style="left:${progress}%"></span>`)

function drawVideoPlayer(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const captions = awaiting
    ? `<div class="qf-yt-captions qf-placeholder qf-ph qf-ph-words" aria-hidden="true">${PLACEHOLDER_WORDS}</div>`
    : `<blockquote class="qf-words qf-yt-captions">${paragraphs.map((p) => `<p><span>${helpers.renderInline(p)}</span></p>`).join('')}</blockquote>`
  const timeLabel = fields.time ? `<span class="qf-yt-time">${esc(fields.time)}${fields.length ? ` / ${esc(fields.length)}` : ''}</span>` : ''
  const left = `<span class="qf-yt-left">${icon(helpers, 'play', 40)}${icon(helpers, 'skip-forward', 40)}${icon(helpers, 'volume-2', 40)}${timeLabel}</span>`
  const right = `<span class="qf-yt-right">${icon(helpers, 'captions', 40)}${icon(helpers, 'settings', 40)}${icon(helpers, 'maximize', 40)}</span>`
  const controls = `<div class="qf-yt-controls" aria-hidden="true"><div class="qf-yt-track">${progressMarkup(fields.progress)}</div><div class="qf-yt-row">${left}${right}</div></div>`
  const title = fields.title ? `<p class="qf-yt-title">${esc(fields.title)}</p>` : ''
  const channel = fields.channel
    ? `<div class="qf-yt-channel"><span class="qf-avatar qf-avatar-s" style="background:${fields.fill}" aria-hidden="true">${esc(fields.initials)}</span><b>${esc(fields.channel)}</b><span class="qf-yt-subscribe" aria-hidden="true">Subscribe</span><span class="qf-yt-likes" aria-hidden="true">${icon(helpers, 'thumbs-up', 36)}<span class="qf-yt-sep"></span>${icon(helpers, 'thumbs-down', 36)}</span></div>`
    : ''
  const caption = title || channel ? `<figcaption>${title}${channel}</figcaption>` : ''
  const sr = awaiting ? 'From a YouTube video. No words yet.' : 'From a YouTube video.'
  return `<figure class="qf qf-video qf-full${awaiting ? ' qf-awaiting' : ''}" data-step="${step}"><span class="qf-sr">${sr}</span><div class="qf-yt"><div class="qf-yt-player">${captions}${controls}</div>${caption}</div></figure>`
}

/**
 * The left side panel, shared by video, book, paper and web (spec 6.6; tickets 03, 04 and 07 call this).
 * `panel` is the markup inside the 653 wide panel (the picture and anything over it), `words` the words
 * markup or '' (awaiting), `source` the source block markup or ''. Styles: `.qf-side` in layouts/quote.css.
 */
export function sidePanelFigure({ classes, step, awaiting, sr, panel, words, source }) {
  const placeholder = awaiting ? `<div class="qf-placeholder qf-ph qf-ph-words" aria-hidden="true">${PLACEHOLDER_WORDS}</div>` : ''
  return `<figure class="qf qf-side ${classes}${awaiting ? ' qf-awaiting' : ''}" data-step="${step}"><span class="qf-sr">${sr}</span><div class="qf-panel">${panel}</div><div class="qf-body"><div class="qf-body-in">${placeholder}${words}${source}</div></div></figure>`
}

/** The picture filling a panel; no picture (an unreadable file) leaves the panel's tint. Alt is the author's. */
export function panelPictureMarkup(picture) {
  const src = String(picture?.src ?? '')
  return src ? `<img class="qf-picture" src="${esc(src)}" alt="${esc(picture?.alt ?? '')}">` : ''
}

/** The source block of a side panel: who line, where lines, pill, link line (spec 6.6). Every value is already escaped.
 * A where line is a string or `{ html, className }` (the book's bold title line); `whoClass` styles the who line. */
export function sourceBlockMarkup({ who = '', whoClass = '', wheres = [], pill = '', id = '' }) {
  if (!who && !wheres.length && !pill && !id) return ''
  const whereLine = (line) => (typeof line === 'string' ? `<div class="qf-source-where">${line}</div>` : `<div class="qf-source-where ${line.className}">${line.html}</div>`)
  return `<figcaption class="qf-source">${who ? `<div class="qf-source-who${whoClass ? ` ${whoClass}` : ''}">${who}</div>` : ''}${wheres.map(whereLine).join('')}${pill ? `<div class="qf-pill-row"><span class="qf-pill">${pill}</span></div>` : ''}${id ? `<div class="qf-source-id">${id}</div>` : ''}</figcaption>`
}

function drawVideoPanel(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const base = `<div class="qf-yt-base" aria-hidden="true">${YT_LOZENGE}${fields.time ? `<span class="qf-yt-timepill">${esc(fields.time)}</span>` : ''}<div class="qf-yt-track">${progressMarkup(fields.progress)}</div></div>`
  const parts = videoSourceParts(fields)
  const source = sourceBlockMarkup({
    who: esc(fields.channel || fields.title),
    wheres: parts.wheres ? [esc(fields.title)] : [],
    pill: fields.time ? `at ${esc(fields.time)}` : ''
  })
  const words = awaiting ? '' : `<blockquote class="qf-words">${paragraphs.map((p) => `<p>${helpers.renderInline(p)}</p>`).join('')}</blockquote>`
  return sidePanelFigure({
    classes: 'qf-video',
    step,
    awaiting,
    sr: awaiting ? 'From a YouTube video. No words yet.' : 'From a YouTube video.',
    panel: `${panelPictureMarkup(block.quoteFormPicture)}${base}`,
    words,
    source
  })
}

// The book's left panel (spec 2.4, 6.6): the cover picture fills it, or a small cover made from the title and
// the authors sits on the sand tint. The title is the one bold element (decision 13); the words are never bold.
const COVER_SHAPE_MIN = 0.51
const COVER_SHAPE_MAX = 0.70

/** Made-cover title size class (spec 6.6): 54 up to 40 characters, 44 up to 70, 36 beyond. */
export const coverTitleSize = (title) => (title.length <= 40 ? 'qf-cover-title-l' : title.length <= 70 ? 'qf-cover-title-m' : 'qf-cover-title-s')

function madeCoverMarkup(fields) {
  const authors = fields.authors ?? []
  const lines = authors.length > 3 ? [...authors.slice(0, 3), `and ${authors.length - 3} more`] : authors
  const title = fields.title ? `<span class="qf-cover-title ${coverTitleSize(fields.title)}">${esc(fields.title)}</span>` : ''
  const names = lines.length ? `<span class="qf-cover-authors">${lines.map(esc).join('<br>')}</span>` : ''
  const pub = publisherYear(fields)
  return `<div class="qf-cover-wrap" aria-hidden="true"><div class="qf-cover"><span class="qf-cover-spine"></span>${title}${names}</div>${pub ? `<div class="qf-cover-pub">${esc(pub)}</div>` : ''}</div>`
}

function drawBook(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const picture = block.quoteForm.picture ? block.quoteFormPicture : null
  const hasPicture = Boolean(picture?.src)
  const parts = bookSourceParts(fields)
  const titleOnWho = !fields.authorsDisplay && fields.title
  const pub = publisherYear(fields)
  const source = sourceBlockMarkup({
    who: esc(fields.authorsDisplay || fields.title),
    whoClass: titleOnWho ? 'qf-source-title' : '',
    wheres: [
      ...(parts.wheres && fields.title && fields.authorsDisplay ? [{ html: esc(fields.title), className: 'qf-source-title' }] : []),
      ...(pub ? [esc(pub)] : [])
    ],
    pill: fields.page ? esc(fields.page) : ''
  })
  // A cover whose shape is far from the panel's is shown whole (spec 6.6); the size is the asset pass's.
  const ratio = picture?.width && picture?.height ? picture.width / picture.height : null
  const whole = hasPicture && ratio != null && (ratio > COVER_SHAPE_MAX || ratio < COVER_SHAPE_MIN)
  const words = awaiting ? '' : `<blockquote class="qf-words"><p>${paragraphs.map((p) => helpers.renderInline(p)).join('</p><p>')}</p></blockquote>`
  return sidePanelFigure({
    classes: `qf-book${hasPicture ? '' : ' book-generated'}${whole ? ' qf-cover-whole' : ''}`,
    step,
    awaiting,
    sr: awaiting ? 'From a book. No words yet.' : 'From a book.',
    panel: hasPicture ? panelPictureMarkup(picture) : madeCoverMarkup(fields),
    words,
    source
  })
}

// The paper (spec 2.4, 6.5, 6.6): the journal page with the quoted sentence highlighted, or, when the slide has a
// picture, the picture in the left panel with the words and the reference beside it. The words are never bold.
const fillerMarkup = (widths) => !widths.length ? '' : `<div class="qf-page-filler" aria-hidden="true">${widths.map((w) => `<span style="width:${w}%"></span>`).join('')}</div>`
const FILLER_ABOVE_WIDTHS = [100, 97, 100, 94, 60]
const FILLER_BELOW_WIDTHS = [100, 96, 100, 52]

function drawPaperPage(block, helpers) {
  const { fields, step, awaiting, filler } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const { journal, issueLine, title, authors } = pageHeadParts(fields)
  const head = journal ? `<div class="qf-page-head"><b>${esc(journal)}</b>${issueLine ? `<span>${esc(issueLine)}</span>` : ''}</div>` : ''
  const caption = head || title || authors
    ? `<figcaption>${head}${title ? `<p class="qf-page-title">${esc(title)}</p>` : ''}${authors ? `<p class="qf-page-authors">${esc(authors)}</p>` : ''}</figcaption>`
    : ''
  const above = filler?.above ?? FILLER_ABOVE_WIDTHS.length
  const below = filler?.below ?? FILLER_BELOW_WIDTHS.length
  const words = awaiting
    ? `<div class="qf-placeholder qf-ph qf-ph-words" aria-hidden="true">${PLACEHOLDER_WORDS}</div>`
    : `<blockquote class="qf-words">${paragraphs.map((p) => `<p><mark>${helpers.renderInline(p)}</mark></p>`).join('')}</blockquote>`
  const doi = fields.doi ? `<span class="qf-doi">${esc(doiText(fields.doi))}</span>` : ''
  const number = fields.page ? `<span class="qf-page-number"><span class="qf-sr">page </span>${esc(fields.page)}</span>` : ''
  const foot = doi || number ? `<footer class="qf-page-foot">${doi}${number}</footer>` : ''
  const sr = awaiting ? 'From a paper. No words yet.' : 'From a paper.'
  return `<figure class="qf qf-paper qf-full${awaiting ? ' qf-awaiting' : ''}" data-step="${step}"><span class="qf-sr">${sr}</span><div class="qf-page">${caption}${fillerMarkup((above > 0 ? FILLER_ABOVE_WIDTHS.slice(-above) : []))}${words}${fillerMarkup(FILLER_BELOW_WIDTHS.slice(0, below))}${foot}</div></figure>`
}

function drawPaperPanel(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const journalLine = paperJournalLine(fields)
  const source = sourceBlockMarkup({
    who: esc(fields.authorsDisplay || fields.title),
    wheres: [
      ...(fields.authorsDisplay && fields.title ? [esc(fields.title)] : []),
      ...(journalLine ? [esc(journalLine)] : [])
    ],
    pill: fields.page ? `page ${esc(fields.page)}` : '',
    id: fields.doi ? esc(doiText(fields.doi)) : ''
  })
  const words = awaiting ? '' : `<blockquote class="qf-words">${paragraphs.map((p) => `<p>${helpers.renderInline(p)}</p>`).join('')}</blockquote>`
  return sidePanelFigure({
    classes: 'qf-paper',
    step,
    awaiting,
    sr: awaiting ? 'From a paper. No words yet.' : 'From a paper.',
    panel: panelPictureMarkup(block.quoteFormPicture),
    words,
    source
  })
}

const drawPaper = (block, helpers) => (block.quoteForm.presentation === 'panel' ? drawPaperPanel(block, helpers) : drawPaperPage(block, helpers))

// The web page (spec 17): a browser window, or with a picture the left panel under an address bar. Nothing here is a
// link: the address is the domain as text (the handout writes the link, quote-forms-static.mjs). The words are 400.
const webBarMarkup = (fields, helpers) => (fields.link
  ? `<div class="qf-web-bar"><span class="qf-web-pill">${icon(helpers, fields.secure ? 'lock' : 'globe', 30)}<span class="qf-web-host">${esc(fields.domain)}</span></span></div>`
  : '')

function webHeadMarkup(fields) {
  const mast = webHasMast(fields)
    ? `<div class="qf-web-mast"><span class="qf-web-mark" aria-hidden="true">${esc(fields.mark)}</span><span class="qf-web-site">${esc(fields.siteShown)}</span><span class="qf-web-nav" aria-hidden="true"><span></span><span></span><span></span></span></div>`
    : ''
  const headline = fields.headline ? `<p class="qf-web-headline">${esc(fields.headline)}</p>` : ''
  const byParts = [
    fields.author ? `<span class="qf-avatar qf-avatar-xs" style="background:${fields.authorFill}" aria-hidden="true">${esc(fields.authorInitials)}</span><b>${esc(fields.author)}</b>` : '',
    fields.author && fields.date ? '<span aria-hidden="true">·</span>' : '',
    fields.date ? `<span>${esc(fields.date)}</span>` : ''
  ].join('')
  const post = headline || byParts ? `<div class="qf-web-post">${headline}${byParts ? `<div class="qf-web-by">${byParts}</div>` : ''}</div>` : ''
  return mast || post ? `<figcaption class="qf-web-head">${mast}${post}</figcaption>` : ''
}

function drawWebWindow(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const words = awaiting
    ? `<div class="qf-placeholder qf-ph qf-ph-words" aria-hidden="true">${PLACEHOLDER_WORDS}</div>`
    : `<blockquote class="qf-words">${paragraphs.map((p) => `<p>${helpers.renderInline(p)}</p>`).join('')}</blockquote>`
  // Only the link known: the address is the one detail, so the domain is written once more under the words (spec 5).
  const domain = !awaiting && fields.link && !fields.details
    ? `<div class="qf-web-domain">${icon(helpers, 'globe', 30)}<span>${esc(fields.domain)}</span></div>`
    : ''
  const colours = fields.fill && fields.tint ? ` style="--qf-web-mark:${fields.fill};--qf-web-tint:${fields.tint}"` : ''
  const sr = awaiting ? 'From a web page. No words yet.' : 'From a web page.'
  return `<figure class="qf qf-web qf-full${awaiting ? ' qf-awaiting' : ''}" data-step="${step}"${colours}><span class="qf-sr">${sr}</span><div class="qf-web-win">${webBarMarkup(fields, helpers)}${webHeadMarkup(fields)}<div class="qf-web-body">${words}${domain}</div></div></figure>`
}

function drawWebPanel(block, helpers) {
  const { fields, step, awaiting } = block.quoteForm
  const paragraphs = wordsParagraphs(block)
  const { who, wheres } = webSourceLines(fields)
  const source = sourceBlockMarkup({ who: esc(who), wheres: wheres.map(esc) })
  const words = awaiting ? '' : `<blockquote class="qf-words">${paragraphs.map((p) => `<p>${helpers.renderInline(p)}</p>`).join('')}</blockquote>`
  return sidePanelFigure({
    classes: 'qf-web',
    step,
    awaiting,
    sr: awaiting ? 'From a web page. No words yet.' : 'From a web page.',
    panel: `${webBarMarkup(fields, helpers)}${panelPictureMarkup(block.quoteFormPicture)}`,
    words,
    source
  })
}

const drawWeb = (block, helpers) => (block.quoteForm.presentation === 'panel' ? drawWebPanel(block, helpers) : drawWebWindow(block, helpers))

const drawVideo = (block, helpers) => (block.quoteForm.presentation === 'panel' ? drawVideoPanel(block, helpers) : drawVideoPlayer(block, helpers))

// One drawer per built form. Later tickets add theirs here.
const DRAWERS = { tweet: drawTweet, video: drawVideo, book: drawBook, paper: drawPaper, web: drawWeb }

/**
 * The form's markup for a quote block that `annotateQuoteForm` marked, else null (Plain).
 * `helpers`: { renderInline(text) → html, iconBody(name) → svg inner markup } from the compiler.
 */
export function renderQuoteForm(block, helpers) {
  const form = block?.quoteForm?.form
  const drawer = form && BUILT_FORMS.has(form) ? DRAWERS[form] : null
  return drawer ? drawer(block, helpers) : null
}
