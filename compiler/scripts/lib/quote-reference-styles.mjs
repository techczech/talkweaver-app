// Quote forms: references pasted from a reference manager (Chicago, MLA, APA), and the quoted words' outer marks.
//
// The spec's own source-line syntax (`Author, "Title", *Journal* 59(236), 1950, pp. 1-9 doi`, spec 2.3) is read by
// quote-forms.mjs and is not touched here. This module is asked first whether the line is written in a
// sentence-per-part reference style; if it is, it returns the fields, otherwise null and the caller reads the line as
// before. One entry: readPastedReference(parsed). The other export, stripOuterQuotes, is for the quoted words.
//
// Every pattern here is linear: the line is capped at 2,000 characters by the parser, scanning uses indexOf and
// anchored or non-nested patterns, and no pattern nests a quantifier inside a quantifier.

const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const MONTH_WORD_RE = new RegExp(`^(?:${MONTHS})\\.?$`, 'i')
const YEAR_RE = /(?<!\d)(1[5-9]\d\d|20\d\d)(?!\d)/g
const BOUNDARY_RE = /\.\s+(?=["“*_])/
const APA_YEAR_RE = /\((\d{4})[a-z]?\)\.\s*/
const INITIALS_RE = /^(?:\p{Lu}\.[\s-]?)+$/u
const ARXIV_ID_RE = /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i
const ARXIV_ANY_RE = /\barXiv:\s*\S+/gi
const PREPRINT_RE = /\bPreprint\b[,.:]?\s+([^,.;]+)/i
const SERVERS = Object.freeze({
  arxiv: 'arXiv', biorxiv: 'bioRxiv', medrxiv: 'medRxiv', chemrxiv: 'ChemRxiv', ssrn: 'SSRN', osf: 'OSF',
  'osf preprints': 'OSF', psyarxiv: 'PsyArXiv', socarxiv: 'SocArXiv', 'research square': 'Research Square', zenodo: 'Zenodo', hal: 'HAL'
})
const SERVER_START_RE = /^(arXiv|bioRxiv|medRxiv|ChemRxiv|SSRN|OSF Preprints|OSF|PsyArXiv|SocArXiv|Research Square|Zenodo|HAL)\b/i
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'der', 'den', 'di', 'da', 'la', 'le', 'du', 'bin', 'al', 'el', 'ter', 'ten', 'dos', 'das'])

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const unmark = (text) => text.replace(/[*_]/g, '')

/** A title's own end punctuation: one trailing full stop or comma goes; ? and ! stay. */
const tidyTitle = (text) => squash(text).replace(/[.,]$/, '').trim()

function lastYearIn(text) {
  const cut = text.search(/\b(?:accessed|retrieved)\b/i)
  const scan = (cut >= 0 ? text.slice(0, cut) : text)
    .replace(ARXIV_ANY_RE, ' ')
    .replace(/\b\d+\s*[–—-]\s*\d+/g, ' ')
  let last = ''
  for (const match of scan.matchAll(YEAR_RE)) last = match[1]
  return last
}

function monthFor(text, year) {
  if (!year) return ''
  const monthFirst = new RegExp(`(?<![A-Za-z])(${MONTHS})\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?${year}`, 'i').exec(text)
  const dayFirst = monthFirst ? null : new RegExp(`\\d{1,2}\\s+(${MONTHS})\\.?,?\\s+${year}`, 'i').exec(text)
  return (monthFirst ?? dayFirst)?.[1] ?? ''
}

// ---- authors ---------------------------------------------------------------------------------

const capitalWords = (text) => text.split(' ').filter((word) => !PARTICLES.has(word.toLowerCase()))

function surnameThenGiven(first, second) {
  if (!first || !second) return false
  if (capitalWords(first).length > 1) return false
  return second.split(' ').length <= 2
}

function tidyName(token) {
  const words = token.split(' ')
  const last = words[words.length - 1]
  if (last.endsWith('.') && last.replace(/\.$/, '').length > 2) words[words.length - 1] = last.replace(/\.$/, '')
  return words.join(' ')
}

/** `{ authors, othersUnknown }` in Given Surname order from a Chicago, MLA or APA author block. */
function readAuthors(block) {
  let text = squash(block)
  let othersUnknown = false
  const at = text.toLowerCase().lastIndexOf('et al')
  if (at >= 0 && /^[\s.,;]*$/.test(text.slice(at + 5))) {
    othersUnknown = true
    text = text.slice(0, at)
  }
  const tokens = text
    .replace(/\s+(?:and|&)\s+/gi, ',')
    .replace(/^(?:and|&)\s+/i, '')
    .split(',')
    .map((token) => squash(token))
    .filter(Boolean)
  const authors = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const next = tokens[index + 1]
    if (next && INITIALS_RE.test(next)) { authors.push(`${next} ${tidyName(token)}`); index += 2; continue }
    if (index === 0 && surnameThenGiven(token, next)) { authors.push(`${tidyName(next)} ${tidyName(token)}`); index += 2; continue }
    authors.push(tidyName(token))
    index += 1
  }
  return { authors: authors.filter(Boolean), othersUnknown }
}

// ---- title and container -----------------------------------------------------------------------

/** A title opening `text`: a quoted or marked span, else none. */
function leadingTitle(text) {
  const open = text[0]
  const close = open === '“' ? '”' : open === '"' ? '"' : open === '*' || open === '_' ? open : ''
  if (!close) return null
  const end = text.indexOf(close, 1)
  if (end < 1) return null
  return { title: tidyTitle(text.slice(1, end)), marked: open === '*' || open === '_', rest: text.slice(end + 1) }
}

function preprintFor(text, containerGuess) {
  let server = ''
  const preprint = PREPRINT_RE.exec(text)
  if (preprint) server = SERVERS[preprint[1].trim().toLowerCase()] ?? squash(preprint[1])
  const id = ARXIV_ID_RE.exec(text)
  if (!server && id) server = 'arXiv'
  if (!server && containerGuess) {
    const start = SERVER_START_RE.exec(containerGuess)
    if (start) server = SERVERS[start[1].toLowerCase()] ?? start[1]
  }
  return { server, identifier: id && server === 'arXiv' ? `arXiv:${id[1]}` : '' }
}

function unmarkedContainer(text) {
  const match = /^([^\d():,.;]+?)(?=\s+\d|\s*[,:(.;]|$)/.exec(text)
  const name = match ? squash(match[1]) : ''
  if (!name || MONTH_WORD_RE.test(name) || /^(?:accessed|retrieved|available|in)$/i.test(name) || name.split(' ').length > 12) return ''
  return name
}

function readVolumeIssuePages(tail) {
  let volume = ''
  let issue = ''
  const volumeWord = /\bvol(?:ume)?\.?\s*(\d+)/i.exec(tail)
  if (volumeWord) {
    volume = volumeWord[1]
    issue = /\b(?:no|issue)\.?\s*(\d+)/i.exec(tail)?.[1] ?? ''
  } else {
    const noForm = /\b(\d{1,4})\s*,?\s*(?:no|issue)\.?\s*(\d+)/i.exec(tail)
    const parens = noForm ? null : /\b(\d{1,4})\s*\((\d{1,4})\)/.exec(tail)
    if (noForm) { volume = noForm[1]; issue = noForm[2] }
    else if (parens) { volume = parens[1]; issue = /^(?:1[5-9]\d\d|20\d\d)$/.test(parens[2]) ? '' : parens[2] }
    else volume = /^[\s,]*(\d{1,4})(?=[\s:,(.]|$)/.exec(tail)?.[1] ?? ''
  }
  const range = /(?::|\bpp?\.|,)\s*(\d+)\s*[–—-]+\s*(\d+)(?!\d)/.exec(tail)
  let pages = ''
  if (range) {
    const [, from, to] = range
    pages = `${from}–${to.length < from.length ? from.slice(0, from.length - to.length) + to : to}`
  }
  return { volume, issue, pages }
}

function publisherOf(text, year) {
  let rest = text.replace(/^[\s.,;]+/, '').replace(/\(\d+(?:st|nd|rd|th)? ed\.\)\.?/gi, ' ')
  if (year) {
    const at = rest.search(new RegExp(`(?<!\\d)${year}(?!\\d)`))
    if (at >= 0) rest = rest.slice(0, at)
  }
  rest = rest.replace(/[\s.,;(]+$/, '')
  const colon = rest.indexOf(': ')
  if (colon >= 0) rest = rest.slice(colon + 2)
  return squash(rest.replace(/^[\s.,;]+|[\s.,;]+$/g, ''))
}

/**
 * The fields of a reference written in a reference-manager style, or null when the line is not in one (it has
 * neither an `Authors. "Title."` / `Authors. *Title*.` opening nor APA's `(2019).`). Names are Given Surname.
 * Returns { authors, othersUnknown, title, year, month, container, volume, issue, pages, publisher, identifier }.
 */
export function readPastedReference(parsed) {
  const text = squash(parsed?.text)
  if (!text) return null
  const apa = APA_YEAR_RE.exec(text)
  const chicago = BOUNDARY_RE.exec(text)
  let authorBlock
  let rest
  let apaYear = ''
  let title = ''
  let marked = false
  if (apa && (!chicago || apa.index < chicago.index)) {
    authorBlock = text.slice(0, apa.index)
    apaYear = apa[1]
    rest = text.slice(apa.index + apa[0].length)
    const lead = leadingTitle(rest)
    if (lead) { ({ title, marked, rest } = lead) }
    else {
      const end = /[.?!](?=\s|$)/.exec(rest)
      title = tidyTitle(end ? rest.slice(0, end.index + (end[0] === '.' ? 0 : 1)) : rest)
      rest = end ? rest.slice(end.index + 1) : ''
    }
  } else if (chicago) {
    authorBlock = text.slice(0, chicago.index + 1)
    rest = text.slice(chicago.index + chicago[0].length)
    const lead = leadingTitle(rest)
    if (lead) { ({ title, marked, rest } = lead) }
  } else return null

  const { authors, othersUnknown } = readAuthors(authorBlock)
  rest = rest.replace(/^[\s.,;:]+/, '')
  const year = apaYear || lastYearIn(unmark(rest))
  const month = apaYear ? '' : monthFor(unmark(rest), year)

  // Where it was published: a marked journal first; else a preprint server; else the name before the volume.
  let container = ''
  let tail = rest
  const markedContainer = rest[0] === '*' || rest[0] === '_' ? leadingTitle(rest) : null
  if (markedContainer) { container = markedContainer.title; tail = markedContainer.rest }
  const guess = markedContainer ? '' : unmarkedContainer(rest)
  const { server, identifier } = preprintFor(rest, guess)
  if (server && !markedContainer) container = server
  else if (!container) container = guess
  if (!markedContainer && container && !server) tail = rest.slice(rest.indexOf(container) + container.length)
  const volumeText = unmark(tail).replace(ARXIV_ANY_RE, ' ')
  const { volume, issue, pages } = marked && !server ? { volume: '', issue: '', pages: '' } : readVolumeIssuePages(volumeText)
  return {
    authors,
    othersUnknown,
    title,
    year,
    month,
    container: marked && !markedContainer && !server ? '' : container,
    volume,
    issue,
    pages,
    publisher: publisherOf(rest, year),
    identifier
  }
}

// ---- the quoted words ----------------------------------------------------------------------------

const OPEN_CURLY = '“'
const CLOSE_CURLY = '”'

function wrappedInOnePair(paragraphs) {
  const first = paragraphs[0]
  const last = paragraphs[paragraphs.length - 1]
  if (first.length < 2 && paragraphs.length === 1) return false
  if (first[0] === '"') {
    if (last[last.length - 1] !== '"') return false
    let count = 0
    for (const paragraph of paragraphs) for (const char of paragraph) if (char === '"') count += 1
    return count === 2
  }
  if (first[0] !== OPEN_CURLY || last[last.length - 1] !== CLOSE_CURLY) return false
  let depth = 0
  const joined = paragraphs.join('\n')
  for (let index = 0; index < joined.length; index += 1) {
    if (joined[index] === OPEN_CURLY) depth += 1
    else if (joined[index] === CLOSE_CURLY) {
      depth -= 1
      if (depth < 0 || (depth === 0 && index < joined.length - 1)) return false
    }
  }
  return depth === 0
}

/**
 * The quoted words without one outer pair of typed double quotation marks (straight or curly) wrapped around the
 * whole quotation, across paragraphs; inner marks stay. `paragraphs` are already trimmed and non-empty.
 */
export function stripOuterQuotes(paragraphs) {
  if (!paragraphs.length || !wrappedInOnePair(paragraphs)) return paragraphs
  const out = paragraphs.slice()
  out[0] = out[0].slice(1)
  out[out.length - 1] = out[out.length - 1].slice(0, -1)
  return out.map((paragraph) => paragraph.trim()).filter(Boolean)
}
