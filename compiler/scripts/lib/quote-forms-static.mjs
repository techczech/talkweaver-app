/**
 * Quote forms in the handout, the shared talk, the venue page and print (spec section 9).
 *
 * One static rendering, as for the simulation layouts (`simulationStatic`): the slide gains `qf-static`
 * (shadows off, the source link underlined; styles in layouts/quote.css and skin/quote.css, the same
 * rules again under `@media print`). The stage markup never carries the link, so the compiler stamps
 * a small side payload into the deck (`twQuoteSources`, see `quoteFormSources`), the handout builder
 * reads it back and calls `quoteFormStatic` on each slide's HTML and `quoteFormScriptBlocks` on its
 * phone text. A slide with no payload entry, or an entry with no link, gets no link element.
 */
import {
  classifyLink,
  doiTextOfAddress,
  esc,
  paperJournalLine,
  parseSourceLine,
  publisherYear,
  secondsFromClock,
  siteOf
} from './quote-forms.mjs'
import { stripOuterQuotes } from './quote-reference-styles.mjs'

export const QUOTE_SOURCES_ELEMENT_ID = 'twQuoteSources'

/** Serialise the payload into a script tag safe to sit inside an HTML document. */
export function renderQuoteSourcesTag(payload) {
  return `<script type="application/json" id="${QUOTE_SOURCES_ELEMENT_ID}">${JSON.stringify(payload).replace(/</g, '\\u003c')}<\/script>`
}

/** The payload back from compiled deck HTML (`{}` when absent or unreadable). */
export function extractQuoteSources(html) {
  const match = String(html).match(/<script[^>]*id=["']twQuoteSources["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!match) return {}
  try {
    const parsed = JSON.parse(match[1].replace(/\\u003c/g, '<'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const isHttp = (url) => /^https?:\/\//i.test(String(url ?? '').trim())

/**
 * The address the written-out link points at, or '' when the source has none (spec 9 "Link", "Video link target").
 * Only http(s) is ever returned. A DOI is `https://doi.org/<doi>`; a video whose time is known and whose typed
 * link has no `t=` (or `start=`) gains `t=<seconds>`.
 */
export function quoteFormHref(form, fields, link) {
  // Characters that cannot stand in an address are percent-encoded (an existing %XX stays); a DOI may hold ( ) < > ; : in its suffix.
  if (fields?.doi) return `https://doi.org/${String(fields.doi).replace(/[\s<>()"\\{}|^`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}`
  if (!link || !isHttp(link.url)) return ''
  let url = String(link.url).trim()
  if (form === 'video' && classifyLink(link) === 'youtube' && fields?.time && !link.search.has('t') && !link.search.has('start')) {
    const seconds = secondsFromClock(fields.time)
    if (seconds != null) {
      const hash = url.indexOf('#')
      const head = hash >= 0 ? url.slice(0, hash) : url
      const tail = hash >= 0 ? url.slice(hash) : ''
      url = `${head}${head.includes('?') ? '&' : '?'}t=${seconds}${tail}`
    }
  }
  return url
}

/** Link text (spec 9, amended 2026-10-12): the site alone, never the address (`youtube.com`); the href keeps the full address.
 *  A DOI address reads the DOI itself, as the slide's paper footer does (`doi:10.1093/mind/LIX.236.433`). */
export const quoteFormLinkText = (href) => doiTextOfAddress(href) || siteOf(href) || String(href)

/** The parsed fields of the source as one line, joined with commas (spec 9, phone handout text). */
export function quoteFormAttribution(form, fields) {
  const f = fields ?? {}
  let parts = []
  if (form === 'tweet') {
    const who = f.name && f.handle ? `${f.name} (@${f.handle})` : (f.name || (f.handle ? `@${f.handle}` : ''))
    parts = [who, f.date]
  } else if (form === 'video') {
    parts = [f.channel, f.title, f.time ? `at ${f.time}` : '']
  } else if (form === 'book') {
    parts = [f.authorsDisplay, f.title, publisherYear(f), f.page]
  } else if (form === 'paper') {
    parts = [f.authorsDisplay, f.title, paperJournalLine(f), f.year && !f.journal ? f.year : '', f.page ? `page ${f.page}` : '']
  } else if (form === 'web') {
    parts = [f.author, f.headline, f.site, f.date]
  }
  return parts.filter(Boolean).join(', ')
}

/**
 * The side payload for a deck: `{ slideId: { form, presentation, href, attribution } }` for every slide that
 * draws a quote form. `href` is '' when the source holds no link.
 */
export function quoteFormSources(slides) {
  const out = {}
  for (const slide of slides || []) {
    const block = Array.isArray(slide?.blocks) ? slide.blocks.find((b) => b && b.type === 'quote' && b.quoteForm) : null
    if (!block || !slide.id) continue
    const { form, presentation, fields } = block.quoteForm
    const href = quoteFormHref(form, fields, parseSourceLine(block.cite ?? '').link)
    out[slide.id] = { form, presentation: presentation ?? '', href, attribution: quoteFormAttribution(form, fields) }
  }
  return out
}

function linkMarkup(href) {
  return `<a class="qf-source-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(quoteFormLinkText(href))}</a>`
}

const PLACEHOLDER_RE = /<(span|div)\b[^>]*\bqf-placeholder\b[^>]*>[^<]*<\/\1>/g

function placeLink(html, source, link) {
  const { form, presentation } = source
  // Function replacers throughout: an address may hold `$&` or `$1`, which a string replacement would expand.
  if (form === 'tweet') {
    if (/<div class="qf-x-time">/.test(html)) return html.replace(/(<div class="qf-x-time">[^<]*)<\/div>/, (_all, date) => `${date} · ${link}</div>`)
    return html.replace('<div class="qf-x-actions"', () => `<div class="qf-x-time">${link}</div><div class="qf-x-actions"`)
  }
  if (form === 'web' && presentation !== 'panel') {
    // The browser window: the link replaces the domain in the address pill, which widens to its text. The domain line of a
    // link-only window is left out, since the pill now holds the address. A window with no address bar has no link to place.
    const mark = link.replace('class="qf-source-link"', 'class="qf-source-link qf-web-host"')
    return html
      .replace(/<span class="qf-web-host">[^<]*<\/span>/, () => mark)
      .replace(/<div class="qf-web-domain">[\s\S]*?<\/span><\/div>/, '')
  }
  if (form === 'paper' && presentation !== 'panel') {
    if (/<span class="qf-doi">/.test(html)) return html.replace(/<span class="qf-doi">[^<]*<\/span>/, () => `<span class="qf-doi">${link}</span>`)
    if (/<footer class="qf-page-foot">/.test(html)) return html.replace('<footer class="qf-page-foot">', () => `<footer class="qf-page-foot"><span class="qf-doi">${link}</span>`)
    return html.replace(/<\/div><\/figure>/, () => `<footer class="qf-page-foot"><span class="qf-doi">${link}</span></footer></div></figure>`)
  }
  if (form === 'video' && presentation !== 'panel') {
    const mark = link.replace('class="qf-source-link"', 'class="qf-source-link qf-yt-link"')
    if (/<span class="qf-yt-subscribe"/.test(html)) {
      return html.replace(/<span class="qf-yt-subscribe"[^>]*>[^<]*<\/span><span class="qf-yt-likes"[^>]*>[\s\S]*?<span class="qf-yt-sep"><\/span>[\s\S]*?<\/svg><\/span>/, () => mark)
    }
    if (/<div class="qf-yt-channel">/.test(html)) return html.replace(/(<div class="qf-yt-channel">[\s\S]*?)<\/div><\/figcaption>/, (_all, row) => `${row}${mark}</div></figcaption>`)
    if (/<figcaption>/.test(html)) return html.replace(/<\/figcaption><\/div><\/figure>/, () => `<div class="qf-yt-channel">${mark}</div></figcaption></div></figure>`)
    return html.replace(/<\/div><\/figure>/, () => `<figcaption><div class="qf-yt-channel">${mark}</div></figcaption></div></figure>`)
  }
  // The side panel forms (video, paper and web with a picture, book): the last line of the source block;
  // for a paper it takes the place of the `doi:` text.
  const line = `<div class="qf-source-id">${link}</div>`
  if (/<div class="qf-source-id">/.test(html)) return html.replace(/<div class="qf-source-id">[^<]*<\/div>/, () => line)
  if (/<figcaption class="qf-source">/.test(html)) return html.replace(/(<figcaption class="qf-source">[\s\S]*?)<\/figcaption>/, (_all, head) => `${head}${line}</figcaption>`)
  return html.replace(/<\/div><\/div><\/figure>/, () => `<figcaption class="qf-source">${line}</figcaption></div></div></figure>`)
}

/**
 * The static rendering of one slide's HTML: `qf-static` on the slide, the editor placeholders gone, and the
 * source link written where spec 9 puts it. `source` is the slide's payload entry; without one the HTML is
 * returned unchanged. Idempotent.
 */
export function quoteFormStatic(html, source) {
  const text = String(html ?? '')
  if (!source || !source.form || !/<figure class="qf /.test(text) || /<section\b[^>]*\bqf-static\b/.test(text)) return text
  let out = text.replace(/<section\b([^>]*?)\bclass="([^"]*)"/, (_all, before, classes) => `<section${before}class="${classes} qf-static"`)
  out = out.replace(PLACEHOLDER_RE, '')
  if (isHttp(source.href)) out = placeLink(out, source, linkMarkup(source.href))
  return out
}

/**
 * The quoted words of the phone text without the outer typed quotation marks, as the drawn slide drops them
 * (spec 9). Quote blocks hold rendered HTML, where a straight mark is `&quot;`: it is read as `"` for the test
 * and written back as `&quot;`. Blocks are returned as they were when the words are not wrapped in one pair.
 */
function withoutOuterQuotes(blocks) {
  const at = []
  blocks.forEach((block, index) => { if (block && block.type === 'quote' && String(block.html ?? '').trim()) at.push(index) })
  if (!at.length) return blocks
  const words = at.map((index) => String(blocks[index].html).trim().replace(/&quot;/g, '"'))
  const stripped = stripOuterQuotes(words)
  if (stripped === words) return blocks
  const next = blocks.slice()
  at.forEach((index) => { next[index] = null })
  // A paragraph that was only a mark is gone; the rest keep their places.
  const kept = stripped.map((text) => text.replace(/"/g, '&quot;'))
  at.slice(0, kept.length).forEach((index, n) => { next[index] = { ...blocks[index], html: kept[n] } })
  return next.filter(Boolean)
}

/**
 * The phone text blocks of a slide that draws a quote form (rendered by renderScriptBlocks): the quoted words
 * without their outer typed quotation marks, and the source line rewritten as the parsed fields joined with
 * commas, then ` · ` and the same link when the source has one (spec 9). Blocks are returned unchanged when
 * there is no payload entry; the source line stays as typed when no attribution block exists or no field parsed.
 */
export function quoteFormScriptBlocks(blocks, source) {
  if (!Array.isArray(blocks) || !source || !source.form) return blocks
  const quoted = withoutOuterQuotes(blocks)
  const at = quoted.findIndex((block) => block && block.type === 'attrib')
  if (at < 0) return quoted
  const linked = isHttp(source.href)
  if (!linked && !source.attribution) return quoted
  const lead = source.attribution ? esc(source.attribution) : ''
  const html = linked ? `${lead ? `${lead} · ` : ''}${linkMarkup(source.href)}` : lead
  const next = quoted.slice()
  next[at] = { ...quoted[at], noDash: true, html }
  return next
}
