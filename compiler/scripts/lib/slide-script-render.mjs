/**
 * Phone text view renderer: turns the slide-script payload (slide-script.mjs, ADR-0018) and the
 * slide's nav title into display HTML for the audience page's phone text (buildShareHtml).
 *
 * The payload carries the slide's OUTLINE text, so it holds authoring syntax: `**bold**`,
 * `*italic*`, `` `code` ``, links, `{icon=…}` tokens and `[QR: …]` directives. Shown with
 * textContent, all of that reached the audience raw (found 2026-09-28).
 *
 * One left-to-right pass splits a line into typed tokens: text, code span, backslash escape,
 * `[QR: …]`, Markdown link, bare URL, and dropped authoring tokens. Each non-text token is
 * rendered ONCE, from its own raw source fields, into a finished fragment. An href is only ever
 * built from a link/URL/QR token's raw target text, validated by isPhoneHref, so no rendered
 * fragment can ever be placed inside an attribute value. (The previous multi-pass design held
 * rendered QR anchors as placeholders that a later link pass put inside href="…"; restoring them
 * closed the attribute and ran the author's text as event handlers — found in review 2026-09-28.)
 *
 * Emphasis (`**`, `*`, `__`, `_`, `==mark==`, `~~strike~~`, `++underline++`) is the compiler's own grammar
 * (renderEmphasisEscaped, replaceInlineMarks) applied to the escaped text with each finished
 * fragment standing as one opaque U+FFFC character. Those passes only wrap text in bare
 * <strong>/<em> tags and the constant <mark class="ink-marker">, <s> and <u>, so a fragment is swapped back
 * in, in order, at a position that is always element content.
 *
 * Braces follow the lexer (03-markdown-lexer.mjs, takeItemIcon): a `{key=value}` token is
 * authoring syntax and removed; a bare `{NAME}` that resolves to an icon is removed only as the
 * trailing token of a list item; everything else in braces (`{username}`, `{x}` mid-line,
 * `{a, b}`) is prose and stays. Link and URL targets are never altered.
 *
 * Deliberately NOT the stripper in 10-projections.mjs: that deletes every `*`, `_`, `~` and
 * backtick, damaging snake_case words and code.
 */
import { escapeHtml } from './00-html.mjs'
import { isSafeLinkUrl, renderEmphasisEscaped } from './00-inline-render.mjs'
import {
  bareUrlAt,
  codeSpanAt,
  indexCodeSpanClosers,
  markdownLinkAt,
  replaceInlineMarks
} from './00-inline-protection.mjs'
import { normalizeIconOverrideKey } from './05-icons.mjs'

// One rendered fragment in the escaped line; never produced by escapeHtml or the emphasis passes.
const ATOM = '\ufffc'
// CommonMark: a backslash before ASCII punctuation makes that character literal.
const ESCAPABLE_RE = /[!-/:-@[-`{-~]/
// The lexer's own-line QR directive (03-markdown-lexer.mjs), here also matched inside a line.
const QR_AT_RE = /^\[QR:\s*([^\]|]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]/i
const QR_LINE_RE = /^\[QR:\s*([^\]|]+?)\s*(?:\|\s*(.+?)\s*)?\]$/i
const BRACE_AT_RE = /^\{([^{}\n]*)\}/
// Characters no phone href may contain: whitespace, C0/C1 controls, quotes, angle brackets,
// backtick, zero-width and bidi controls, the fragment marker, private-use code points.
const UNSAFE_HREF_CHAR_RE = /[\s\u0000-\u001f\u007f-\u009f"'<>`\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff0-\uffff\ue000-\uf8ff\u{f0000}-\u{10ffff}]/u

/**
 * Whether a raw link target may become a phone href. The slide's own rule (isSafeLinkUrl) plus
 * a character check, so the phone is never more permissive than the slide for the same input.
 * @param {string} url raw, undecoded target text
 */
export function isPhoneHref(url) {
  const value = String(url ?? '')
  return value.length > 0 && !UNSAFE_HREF_CHAR_RE.test(value) && isSafeLinkUrl(value)
}

function anchor(url, labelHtml) {
  const href = isPhoneHref(url) ? url : '#'
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${labelHtml}</a>`
}

/**
 * Split one line into tokens in a single left-to-right pass. At each position the first
 * construct that starts there wins: escape, code span, QR directive, Markdown link, bare URL,
 * authoring brace token; otherwise the character is text.
 */
function tokenize(source, { listItem }) {
  const tokens = []
  const closers = indexCodeSpanClosers(source)
  let text = ''
  const flushText = () => {
    if (text) tokens.push({ kind: 'text', value: text })
    text = ''
  }
  const push = (token) => {
    flushText()
    tokens.push(token)
  }
  let cursor = 0
  while (cursor < source.length) {
    const ch = source[cursor]
    if (ch === '\\' && cursor + 1 < source.length && ESCAPABLE_RE.test(source[cursor + 1])) {
      push({ kind: 'escape', ch: source[cursor + 1] })
      cursor += 2
      continue
    }
    const code = codeSpanAt(source, cursor, closers)
    if (code) {
      push({ kind: 'code', content: code.content })
      cursor = code.to
      continue
    }
    if (ch === '[') {
      const qr = source.slice(cursor).match(QR_AT_RE)
      if (qr) {
        push({ kind: 'qr', url: qr[1].trim(), label: (qr[2] || qr[1]).trim() })
        cursor += qr[0].length
        continue
      }
      const link = markdownLinkAt(source, cursor)
      if (link) {
        push({ kind: 'link', url: link.url, label: link.label })
        cursor = link.to
        continue
      }
    }
    const url = bareUrlAt(source, cursor)
    if (url) {
      push({ kind: 'url', url: url.url })
      cursor = url.to
      continue
    }
    if (ch === '{') {
      const brace = source.slice(cursor).match(BRACE_AT_RE)
      if (brace) {
        const body = brace[1]
        const end = cursor + brace[0].length
        const trailing = listItem && source.slice(end).trim() === ''
        if (body.includes('=') || (trailing && normalizeIconOverrideKey(body.trim()))) {
          // An authoring token disappears together with the spaces before it.
          text = text.replace(/[ \t]+$/, '')
          cursor = end
          continue
        }
      }
    }
    text += ch
    cursor += 1
  }
  flushText()
  return tokens
}

/**
 * @param {string} text one line of outline text
 * @param {{links?: boolean, listItem?: boolean}} [options] links: false renders link, URL and
 *   QR tokens as their text with no anchor; listItem: the line is a list item's (last) text, so
 *   a trailing `{NAME}` icon token is removed as the lexer removes it
 */
function renderLine(text, { links = true, listItem = false } = {}) {
  const source = String(text ?? '').replace(/\ufffc/g, '\ufffd')
  const fragments = []
  let line = ''
  const atom = (html) => {
    fragments.push(html)
    line += ATOM
  }
  for (const token of tokenize(source, { listItem })) {
    if (token.kind === 'text') line += escapeHtml(token.value)
    else if (token.kind === 'escape') atom(escapeHtml(token.ch))
    else if (token.kind === 'code') atom(`<code>${escapeHtml(token.content)}</code>`)
    else if (token.kind === 'link') {
      const labelHtml = renderLine(token.label, { links: false })
      atom(links ? anchor(token.url, labelHtml) : labelHtml)
    } else if (token.kind === 'url') {
      atom(links ? anchor(token.url, escapeHtml(token.url)) : escapeHtml(token.url))
    } else if (token.kind === 'qr') {
      atom(links ? anchor(token.url, escapeHtml(token.label)) : escapeHtml(token.label))
    }
  }
  const marked = replaceInlineMarks(line.trim())
  const emphasised = renderEmphasisEscaped(marked)
  let next = 0
  const html = emphasised.replace(/\ufffc/g, () => fragments[next++] ?? '')
  if (next !== fragments.length) throw new Error('phone text renderer lost a fragment')
  return html
}

/**
 * Render one line of outline text as inline HTML for the phone text view.
 * @param {string} text
 * @param {{links?: boolean, listItem?: boolean}} [options]
 * @returns {string}
 */
export function renderScriptInline(text, options) {
  return renderLine(text, options)
}

function renderQrLine(url, label) {
  return anchor(url, escapeHtml(label))
}

/**
 * The payload blocks for one slide, rendered for the phone text view. Text fields become `html`
 * (safe to assign to innerHTML: every tag in it was built by renderLine).
 * @param {import('./slide-script.mjs').ScriptBlock[] | null} blocks
 */
export function renderScriptBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return null
  const out = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'list') {
      out.push({
        type: 'list',
        items: (block.items || []).map((item) => ({
          depth: item.depth,
          html: renderLine(item.text, { listItem: !item.pair }),
          ...(item.pair ? { pairHtml: renderLine(item.pair, { listItem: true }) } : {}),
        })),
      })
    } else if (block.type === 'table') {
      out.push({ type: 'table', rows: (block.rows || []).map((row) => row.map((cell) => renderLine(cell))) })
    } else if (block.type === 'media') {
      out.push({ type: 'media', alt: String(block.alt || '') })
    } else if (block.type === 'audio') {
      out.push({ type: 'audio', title: String(block.title || '') })
    } else if (block.type === 'diagram') {
      out.push({ type: 'diagram' })
    } else if (block.type === 'code') {
      out.push({ type: 'code', text: String(block.text ?? '') })
    } else {
      const text = String(block.text ?? '')
      const qr = block.type === 'p' ? text.trim().match(QR_LINE_RE) : null
      if (qr) {
        const url = qr[1].trim()
        out.push({ type: 'qr', html: renderQrLine(url, (qr[2] || url).trim()) })
        continue
      }
      const html = renderLine(text)
      if (html) out.push({ type: block.type === 'quote' || block.type === 'attrib' ? block.type : 'p', html })
    }
  }
  return out.length ? out : null
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeAttribute(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (match, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return ENTITY[name.toLowerCase()] ?? match
  })
}

/**
 * The phone title for one slide: its `data-nav-title` (the outline heading text, which the
 * runtime reads through dataset.navTitle) rendered as inline HTML. The attribute is decoded
 * once, then rendered, so every href check sees the decoded text.
 * @param {string} slideHtml the slide's `<section …>` markup
 * @param {{links?: boolean}} [options] links: false for a title inside a tappable row or the bar,
 *   where an anchor would swallow the tap meant for the row
 */
export function renderSlideNavTitle(slideHtml, { links = true } = {}) {
  const tag = String(slideHtml ?? '').match(/<section\b[^>]*>/i)?.[0] || ''
  const raw = tag.match(/\bdata-nav-title="([^"]*)"/i)?.[1] ?? tag.match(/\bdata-nav-title='([^']*)'/i)?.[1] ?? ''
  return renderLine(decodeAttribute(raw), { links })
}
