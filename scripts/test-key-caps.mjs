// test:key-caps — onboarding 0.38.1 ticket 05: key caps and practice quotations.
//
// What must hold:
//   1. `<kbd>⌘K</kbd>` in outline text becomes <kbd class="key-cap">⌘K</kbd> in slide HTML
//      (renderInline), in the phone text view (renderScriptInline) and in plain text (its content).
//   2. Exactly `<kbd>` with plain-text content is allowed, nothing else: attributes, children,
//      other tags, upper case, empty content, a `<kbd>` inside a code span all stay escaped as
//      before. No output tag carries an attribute taken from the outline.
//   2a. Review round 1 (2026-10-09): a run (the string one renderer call receives) that carries
//      link syntax of any kind gets NO key caps: its output is byte-identical to the renderer
//      before ticket 05, every anchor keeps target and rel, and no kbd sits in an attribute.
//   3. A `>` quotation carrying a key cap is a practice quotation: class practice-quote, the slide
//      title stays visible (not used as a cite), never the quote-only layout, kept after a list.
//      A quotation without a key cap renders exactly as before.
//   4. The compiled deck, the handout and the venue page carry the same key cap markup and the
//      key cap CSS; speaker notes still reach no audience page; compiling never changes the
//      outline's bytes.
import { strict as assert } from 'node:assert'
import { JSDOM } from 'jsdom'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderInline, plainInlineText, isSafeLinkUrl, renderEmphasisEscaped } from '../compiler/scripts/lib/00-inline-render.mjs'
import { keyCapRanges, hasKeyCap, hasLinkSyntax, keyCapsToText, protectInlineSegments, replaceInlineMarks } from '../compiler/scripts/lib/00-inline-protection.mjs'
import { escapeHtml } from '../compiler/scripts/lib/00-html.mjs'
import { renderScriptInline } from '../compiler/scripts/lib/slide-script-render.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'

let passed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

const CAP = (text) => `<kbd class="key-cap">${text}</kbd>`
// Every tag in renderer output, with its attributes. Key caps may only ever be the constant form.
const ALLOWED_TAGS = new Set(['strong', 'em', 'code', 'a', 'mark', 's', 'u', 'kbd'])
function assertOnlyAllowedMarkup(html, label) {
  for (const match of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, tag, attrs] = match
    assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${label}: unexpected <${tag}> in ${html}`)
    if (tag === 'kbd' && !match[0].startsWith('</')) assert.equal(attrs, ' class="key-cap"', `${label}: key cap carries only its class: ${html}`)
    if (tag === 'kbd') continue
    assert.ok(!/\bon\w+=/i.test(attrs), `${label}: no event handler attribute: ${html}`)
  }
  // A key cap tag is never inside another tag (an href or title).
  assert.ok(!/<[^>]*<kbd/.test(html), `${label}: <kbd inside a tag: ${html}`)
}

// The inline renderer exactly as it was before ticket 05 (commit 8a2b690b), the oracle for
// byte-identity. Its helpers (escapeHtml, renderEmphasisEscaped, isSafeLinkUrl,
// protectInlineSegments, replaceInlineMarks) were not changed by ticket 05.
function renderInlinePre05(text) {
  const renderLegacyEscaped = (source) => {
    let out = renderEmphasisEscaped(source)
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
    out = out.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (_, label, url, title) => {
      const safe = isSafeLinkUrl(url) ? url : '#'
      const titleAttr = title ? ` title="${title}"` : ''
      return `<a href="${safe}"${titleAttr} target="_blank" rel="noopener">${label}</a>`
    })
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:)\]]*)(?=\s|$|<)/g,
      (_, lead, url, trail) => `${lead}<a href="${url}" target="_blank" rel="noopener">${url}</a>${trail}`)
    return out
  }
  const escaped = escapeHtml(text)
  if (!/==|\+\+|~~/.test(escaped)) return renderLegacyEscaped(escaped)
  const { masked, restore } = protectInlineSegments(escaped, (segment) =>
    segment.kind === 'code'
      ? `<code>${renderLegacyEscaped(segment.content)}</code>`
      : renderLegacyEscaped(segment.source))
  return restore(renderLegacyEscaped(replaceInlineMarks(masked)))
}

// DOM checks on rendered HTML: every anchor keeps target and rel, and no attribute value of any
// element carries key cap markup (the author's own literal `<kbd>` text in a title is fine).
const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>')
const host = dom.window.document.getElementById('host')
function assertAnchorsIntact(html, label) {
  host.innerHTML = html
  for (const a of host.querySelectorAll('a')) {
    assert.equal(a.getAttribute('target'), '_blank', `${label}: anchor target in ${html}`)
    assert.equal(a.getAttribute('rel'), 'noopener', `${label}: anchor rel in ${html}`)
  }
  for (const el of host.querySelectorAll('*')) {
    if (el.tagName === 'KBD') {
      assert.deepEqual([...el.attributes].map((attr) => `${attr.name}=${attr.value}`), ['class=key-cap'], `${label}: key cap form: ${html}`)
      continue
    }
    for (const attr of el.attributes) {
      assert.ok(!/kbd class|key-cap/i.test(attr.value), `${label}: kbd inside ${el.tagName} ${attr.name}: ${html}`)
    }
  }
  return host
}

console.log('key caps: inline renderer')

await test('a key cap becomes the constant key cap element', () => {
  assert.equal(renderInline('<kbd>⌘K</kbd>'), CAP('⌘K'))
  assert.equal(renderInline('Press <kbd>⌘⇧↓</kbd> now'), `Press ${CAP('⌘⇧↓')} now`)
  assert.equal(renderInline('<kbd>O</kbd> and <kbd>0</kbd>'), `${CAP('O')} and ${CAP('0')}`)
})

await test('modifier glyphs show as written, content is escaped', () => {
  assert.equal(renderInline('<kbd>⌘⌥⇧⌃</kbd>'), CAP('⌘⌥⇧⌃'))
  assert.equal(renderInline('<kbd>&</kbd>'), CAP('&amp;'))
  assert.equal(renderInline('<kbd>"</kbd>'), CAP('&quot;'))
  assert.equal(renderInline('<kbd>&amp;</kbd>'), CAP('&amp;amp;'))
})

await test('key caps sit inside bold, marks and the practice lead-in', () => {
  assert.equal(
    renderInline('**Try it.** Press <kbd>→</kbd> for the next slide, <kbd>←</kbd> to go back, and the letter **O** for the outline.'),
    `<strong>Try it.</strong> Press ${CAP('→')} for the next slide, ${CAP('←')} to go back, and the letter <strong>O</strong> for the outline.`
  )
  assert.equal(renderInline('**press <kbd>F5</kbd>**'), `<strong>press ${CAP('F5')}</strong>`)
  assert.equal(renderInline('==press <kbd>K</kbd>=='), `<mark class="ink-marker">press ${CAP('K')}</mark>`)
  // Key cap content is literal: no emphasis, mark or code inside or across it.
  assert.equal(renderInline('<kbd>**</kbd> and <kbd>**</kbd>'), `${CAP('**')} and ${CAP('**')}`)
  assert.equal(renderInline('<kbd>_</kbd> x <kbd>_</kbd>'), `${CAP('_')} x ${CAP('_')}`)
  // Code spans are found first (as for marks): two backticks pair up as code, so no key cap.
  assert.equal(renderInline('<kbd>`</kbd> and <kbd>`</kbd>'), '&lt;kbd&gt;<code>&lt;/kbd&gt; and &lt;kbd&gt;</code>&lt;/kbd&gt;')
  assert.equal(renderInline('one <kbd>`</kbd> key'), `one ${CAP('`')} key`)
})

await test('script, attributes and children inside or on <kbd> stay escaped', () => {
  const cases = {
    '<kbd><script>alert(1)</script></kbd>': '&lt;kbd&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/kbd&gt;',
    '<kbd onclick=alert(1)>x</kbd>': '&lt;kbd onclick=alert(1)&gt;x&lt;/kbd&gt;',
    '<kbd onclick="alert(1)">x</kbd>': '&lt;kbd onclick=&quot;alert(1)&quot;&gt;x&lt;/kbd&gt;',
    '<kbd class="x">x</kbd>': '&lt;kbd class=&quot;x&quot;&gt;x&lt;/kbd&gt;',
    '<kbd><b>x</b></kbd>': '&lt;kbd&gt;&lt;b&gt;x&lt;/b&gt;&lt;/kbd&gt;',
    '<kbd><kbd>x</kbd></kbd>': `&lt;kbd&gt;${CAP('x')}&lt;/kbd&gt;`,
    '<KBD>x</KBD>': '&lt;KBD&gt;x&lt;/KBD&gt;',
    '<kbd >x</kbd>': '&lt;kbd &gt;x&lt;/kbd&gt;',
    '<kbd>x</kbd >': '&lt;kbd&gt;x&lt;/kbd &gt;',
    '<kbd></kbd>': '&lt;kbd&gt;&lt;/kbd&gt;',
    '<kbd> </kbd>': '&lt;kbd&gt; &lt;/kbd&gt;',
    '<kbd>x': '&lt;kbd&gt;x',
    'x</kbd>': 'x&lt;/kbd&gt;',
    '<b>bold</b>': '&lt;b&gt;bold&lt;/b&gt;',
    '<img src=x onerror=alert(1)>': '&lt;img src=x onerror=alert(1)&gt;',
    '<span>x</span>': '&lt;span&gt;x&lt;/span&gt;'
  }
  for (const [input, expected] of Object.entries(cases)) {
    const html = renderInline(input)
    assert.equal(html, expected, input)
    assertOnlyAllowedMarkup(html, input)
  }
  assert.ok(!renderInline('<kbd><script>alert(1)</script></kbd>').includes('<script'))
})

await test('a <kbd> in a code span stays as typed', () => {
  assert.equal(renderInline('`<kbd>K</kbd>`'), '<code>&lt;kbd&gt;K&lt;/kbd&gt;</code>')
  assert.equal(renderInline('type `<kbd>K</kbd>` for <kbd>K</kbd>'), `type <code>&lt;kbd&gt;K&lt;/kbd&gt;</code> for ${CAP('K')}`)
})

// Review round 1: Sol's input, where masking let a malformed link match and emphasis put a tag
// into its href, so a restored key cap's quotes broke the attribute.
const SOL_INPUT = '[x](https://e/**b**<kbd>a b</kbd>)'
const LINK_RUNS = [
  SOL_INPUT,
  `${SOL_INPUT} and press <kbd>K</kbd>`,
  '[x](https://e/**b** "<kbd>t</kbd>") and <kbd>K</kbd>',
  '[x](https://e/**b** "**t**<kbd>a b</kbd>")',
  '[press <kbd>K</kbd>](https://example.com)',
  '[x](./<kbd>a</kbd>)',
  '[x](https://example.com "<kbd>t</kbd>")',
  '![alt <kbd>K</kbd>](https://e/**b**<kbd>a b</kbd>.png) press <kbd>K</kbd>',
  '![<kbd>K</kbd>](img.png "<kbd>t</kbd>")',
  '<https://e/**b**<kbd>a b</kbd>> press <kbd>K</kbd>',
  '<mailto:a@b.c> press <kbd>K</kbd>',
  '[guide][ref] press <kbd>K</kbd>',
  '[ref]: https://e/**b**<kbd>a b</kbd>',
  'https://example.com/<kbd>a</kbd>',
  'see https://example.com<kbd>a</kbd>',
  'see https://e/**b**<kbd>a b</kbd> now',
  '**Try it.** Press <kbd>K</kbd> then open [the guide](https://example.com/guide).',
  '==see [x](https://e/**b**<kbd>a b</kbd>)== and <kbd>K</kbd>',
  '[QR: https://e/<kbd>a</kbd>] press <kbd>K</kbd>'
]

await test('review round 1: no key caps on a run with link syntax, byte-identical to before 05', () => {
  assert.equal(renderInline(SOL_INPUT),
    '[x](<a href="https://e/" target="_blank" rel="noopener">https://e/</a><strong>b</strong>&lt;kbd&gt;a b&lt;/kbd&gt;)')
  for (const input of LINK_RUNS) {
    assert.ok(hasLinkSyntax(input), `link syntax seen: ${input}`)
    assert.equal(keyCapRanges(input).length, 0, `no key cap ranges: ${input}`)
    assert.equal(keyCapsToText(input), input, `plain text keeps the source: ${input}`)
    const html = renderInline(input)
    assert.equal(html, renderInlinePre05(input), `byte-identical to pre-05: ${input}`)
    assert.ok(!html.includes('<kbd'), `no kbd element: ${input}`)
    const parsed = assertAnchorsIntact(html, input)
    assert.equal(parsed.querySelectorAll('kbd').length, 0, input)
    assertOnlyAllowedMarkup(html, input)
    const phone = renderScriptInline(input)
    assert.ok(!phone.includes('<kbd'), `phone: no kbd element: ${input}`)
    assertAnchorsIntact(phone, `phone: ${input}`)
  }
})

await test('review round 1: a run without link syntax still gets its key caps', () => {
  assert.equal(hasLinkSyntax('**Try it.** Press <kbd>⌘[</kbd> or <kbd>⌘]</kbd>'), false)
  assert.equal(renderInline('Press <kbd>⌘[</kbd> or <kbd>⌘]</kbd>'), `Press ${CAP('⌘[')} or ${CAP('⌘]')}`)
  assert.equal(renderInline('Press <kbd>:</kbd>'), `Press ${CAP(':')}`)
  assert.equal(renderScriptInline('Press <kbd>K</kbd>'), `Press ${CAP('K')}`)
})

await test('review round 1: a practice quotation is judged on the runs it renders', () => {
  const [linked] = lexMarkdownBlocks(['> Press <kbd>K</kbd> and see [x](https://e).'])
  assert.equal('practice' in linked, false)
  const [joined] = lexMarkdownBlocks(['> Press <kbd>K</kbd>', '> and see https://example.com'])
  assert.equal('practice' in joined, false, 'two lines of one paragraph are one run')
  const [split] = lexMarkdownBlocks(['> Press <kbd>K</kbd>.', '>', '> See https://example.com'])
  assert.equal(split.practice, true, 'a separate paragraph keeps its own key cap')
})

await test('text with no key cap renders as before (fast path byte for byte)', () => {
  for (const input of ['plain', '**b** *i* `c`', '==m== ~~s~~ ++u++', '[l](https://x.y "t")', 'a < b > c', '&lt;kbd&gt;']) {
    assert.equal(keyCapRanges(input).length, 0, input)
  }
  assert.equal(renderInline('a < b > c'), 'a &lt; b &gt; c')
  assert.equal(renderInline('&lt;kbd&gt;'), '&amp;lt;kbd&amp;gt;')
})

await test('control characters in the source cannot forge a key cap token', () => {
  const html = renderInline('\u0003\u00030\u0004 and <kbd>K</kbd> \u00030\u0004')
  assert.equal((html.match(/<kbd/g) || []).length, 1, html)
  assertOnlyAllowedMarkup(html, 'control characters')
})

await test('generated mixes never carry markup other than the allowed tags', () => {
  const parts = ['<kbd>K</kbd>', '<kbd>a b</kbd>', '<kbd onclick=x>y</kbd>', '**', '*', '_', '`', '==', '~~', '++', '[', '](', ')', '![', '][', ']: ', '<https://e>', 'https://e.x/', '"', '<', '>', ' ', 'text', '<script>', '&', '**b**']
  let linked = 0
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let n = 0; n < 4000; n += 1) {
    let input = ''
    const length = 1 + Math.floor(next() * 9)
    for (let k = 0; k < length; k += 1) input += parts[Math.floor(next() * parts.length)]
    const html = renderInline(input)
    assertOnlyAllowedMarkup(html, JSON.stringify(input))
    assert.ok(!/<script/i.test(html), input)
    const phone = renderScriptInline(input)
    assert.ok(!/<script/i.test(phone), `phone: ${input}`)
    assert.ok(!/<kbd(?! class="key-cap">)/.test(phone), `phone kbd form: ${input}`)
    if (hasLinkSyntax(input)) {
      linked += 1
      assert.equal(html, renderInlinePre05(input), `link run byte-identical to pre-05: ${JSON.stringify(input)}`)
      assert.ok(!html.includes('<kbd') && !phone.includes('<kbd'), `link run has no key cap: ${JSON.stringify(input)}`)
    }
    if (html.includes('<kbd')) assertAnchorsIntact(html, JSON.stringify(input))
  }
  assert.ok(linked > 1000, `the mix exercises link syntax (${linked} of 4000)`)
})

console.log('key caps: plain text and phone')

await test('plain text keeps the key text and drops the tags', () => {
  assert.equal(plainInlineText('Press <kbd>⌘K</kbd> to open'), 'Press ⌘K to open')
  assert.equal(keyCapsToText('a <kbd>K</kbd> `<kbd>X</kbd>`'), 'a K `<kbd>X</kbd>`')
  assert.equal(hasKeyCap('> Press <kbd>K</kbd>'), true)
  assert.equal(hasKeyCap('`<kbd>K</kbd>`'), false)
})

await test('the phone text view shows the same key cap and escapes the rest', () => {
  assert.equal(renderScriptInline('**Try it.** Press <kbd>⌘⇧↓</kbd>.'), `<strong>Try it.</strong> Press ${CAP('⌘⇧↓')}.`)
  assert.equal(renderScriptInline('<kbd onclick=x>y</kbd>'), '&lt;kbd onclick=x&gt;y&lt;/kbd&gt;')
  assert.equal(renderScriptInline('<kbd><script>x</script></kbd>'), '&lt;kbd&gt;&lt;script&gt;x&lt;/script&gt;&lt;/kbd&gt;')
  assert.equal(renderScriptInline('`<kbd>K</kbd>`'), '<code>&lt;kbd&gt;K&lt;/kbd&gt;</code>')
})

console.log('key caps: practice quotations')

await test('a `>` block with a key cap is a practice quotation; one without is not', () => {
  const [practice] = lexMarkdownBlocks(['> **Try it.** Press <kbd>K</kbd>.'])
  assert.equal(practice.type, 'quote')
  assert.equal(practice.practice, true)
  const [plain] = lexMarkdownBlocks(['> We think with metaphors.'])
  assert.equal(plain.type, 'quote')
  assert.equal('practice' in plain, false)
  const [coded] = lexMarkdownBlocks(['> Type `<kbd>K</kbd>` to get a key cap.'])
  assert.equal('practice' in coded, false)
})

const dir = mkdtempSync(join(tmpdir(), 'tw-key-caps-'))
const source = [
  '---', 'title: Key caps probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## 06 Present', '',
  '### Move through the talk', '{id=practice-present}', '',
  'Open the presenter with <kbd>F5</kbd>.', '',
  '> **Try it.** Press <kbd>→</kbd> for the next slide, <kbd>←</kbd> to go back, and the letter **O** for the outline.', '',
  ':::notes', 'NOTESENTINEL-KEYCAP press <kbd>N</kbd> in the notes', ':::', '',
  '### Four stalls', '{id=practice-list}', '',
  '- Bread and cakes', '- Vegetables', '- Plants', '',
  '> **Try it: move a slide.** Put the caret on the heading above and press <kbd>⌘⇧↓</kbd>.', '',
  '### Only the practice line', '{id=practice-only}', '',
  '> **Try it.** Press <kbd>⌘K</kbd>.', '',
  '### A plain quote', '{id=plain-quote}', '',
  'Some context.', '',
  '> We think with metaphors before we notice them.', '',
  '### Quote only', '{id=quote-only}', '',
  '> We think with metaphors before we notice them.', '',
  '### Link run', '{id=link-run}', '',
  `${SOL_INPUT} and press <kbd>K</kbd>`, '',
  '> **Try it.** Press <kbd>K</kbd> then open [the guide](https://e/**b**<kbd>a b</kbd>).', '',
  '- [x](https://e/**b** "<kbd>t</kbd>") <kbd>L</kbd>', '- Press <kbd>M</kbd>', '',
  '### Hostile', '{id=hostile}', '',
  'Bad: <kbd onclick=alert(1)>x</kbd> and <kbd><script>alert(2)</script></kbd> and <kbd><img src=x onerror=alert(3)></kbd>.', ''
].join('\n')
const path = join(dir, 'key-caps.md')
writeFileSync(path, source, 'utf8')
const bytesBefore = readFileSync(path)
const model = await prepareSource(path, source, 'Key caps probe', statSync(path))
const slideById = new Map(model.slides.map((slide) => [slide.id, slide]))
const sectionHtml = (html, id) => {
  const at = html.indexOf(`data-id="${id}"`)
  assert.ok(at >= 0, `slide ${id} in output`)
  const end = html.indexOf('</section>', at)
  return html.slice(at, end)
}

await test('practice slides keep their title, take the practice style, never the quote layout', () => {
  for (const id of ['practice-present', 'practice-list', 'practice-only']) {
    const slide = slideById.get(id)
    assert.notEqual(slide.layout, 'quote', `${id} layout`)
    const quote = slide.blocks.find((block) => block.type === 'quote')
    assert.equal(quote.practice, true, `${id} practice flag`)
    assert.equal(quote.cite, '', `${id}: no title-as-cite`)
    const html = sectionHtml(model.fullHtml, id)
    assert.match(html, /<blockquote class="practice-quote">/, `${id} practice class`)
    assert.ok(!html.includes('slide-head-quiet'), `${id}: title visible`)
    assert.ok(!html.includes('<cite>'), `${id}: no cite`)
  }
  assert.equal(slideById.get('practice-only').layout, 'list')
  const present = sectionHtml(model.fullHtml, 'practice-present')
  assert.ok(present.includes(`Open the presenter with ${CAP('F5')}.`), 'paragraph key cap')
  assert.ok(present.includes(`<strong>Try it.</strong> Press ${CAP('→')} for the next slide, ${CAP('←')} to go back`), 'quote key caps')
  const list = sectionHtml(model.fullHtml, 'practice-list')
  assert.ok(list.indexOf('feature-list') < list.indexOf('practice-quote'), 'the practice line stays after its list')
  assert.ok(list.includes(CAP('⌘⇧↓')))
})

await test('quotations without a key cap render as before', () => {
  const plain = sectionHtml(model.fullHtml, 'plain-quote')
  assert.ok(plain.includes('<blockquote data-quote-length="short" data-quote-chars="46"><p>We think with metaphors before we notice them.</p><cite>A plain quote</cite></blockquote>'), plain)
  assert.ok(plain.includes('slide-head-quiet'))
  assert.equal(slideById.get('quote-only').layout, 'quote')
  const only = sectionHtml(model.fullHtml, 'quote-only')
  assert.match(only, /<blockquote data-quote-length="short" data-quote-chars="46"[^>]*><p>We think with metaphors before we notice them\.<\/p><cite>Quote only<\/cite><\/blockquote>/)
})

await test('hostile <kbd> forms stay escaped in the compiled deck', () => {
  const hostile = sectionHtml(model.fullHtml, 'hostile')
  assert.ok(hostile.includes('&lt;kbd onclick=alert(1)&gt;x&lt;/kbd&gt;'), hostile)
  assert.ok(hostile.includes('&lt;kbd&gt;&lt;script&gt;alert(2)&lt;/script&gt;&lt;/kbd&gt;'), hostile)
  assert.ok(hostile.includes('&lt;kbd&gt;&lt;img src=x onerror=alert(3)&gt;&lt;/kbd&gt;'), hostile)
  assert.ok(!/<kbd[^>]*onclick|<script>alert|<img src=x/.test(hostile), hostile)
})

await test('review round 1: link runs carry no key cap in deck, handout and venue page', () => {
  const slides = extractSlides(model.fullHtml)
  const styles = extractStyles(model.fullHtml)
  const handout = buildShareHtml({ title: 'Key caps probe', slides, styles, includeNotes: false, slug: 'key-caps', license: null })
  const venue = buildVenuePageHtml({ title: 'Key caps probe', slides, styles, slug: 'key-caps', license: null, workerBaseUrl: 'https://worker.test', qr: '', handoutUrl: 'https://talks.test/key-caps' })
  for (const [name, page] of [['deck', model.fullHtml], ['handout', handout], ['venue', venue]]) {
    const doc = new JSDOM(page).window.document
    const section = doc.querySelector('[data-id="link-run"]')
    assert.ok(section, `${name}: link-run slide present`)
    const anchors = [...section.querySelectorAll('a')]
    assert.ok(anchors.length >= 3, `${name}: anchors present (${anchors.length})`)
    for (const a of anchors) {
      assert.equal(a.getAttribute('target'), '_blank', `${name}: target on ${a.outerHTML}`)
      assert.equal(a.getAttribute('rel'), 'noopener', `${name}: rel on ${a.outerHTML}`)
    }
    for (const el of section.querySelectorAll('*:not(kbd)')) {
      for (const attr of el.attributes) assert.ok(!/kbd class|key-cap/i.test(attr.value), `${name}: kbd in ${el.tagName} ${attr.name}`)
    }
    // Only the list item without link syntax has a key cap.
    assert.deepEqual([...section.querySelectorAll('kbd')].map((k) => `${k.className}:${k.textContent}`), ['key-cap:M'], name)
    assert.equal(section.querySelector('.practice-quote'), null, `${name}: a quote whose key cap is not drawn is not a practice quotation`)
  }
})

await test('the key cap stylesheet ships with the deck', () => {
  assert.match(model.fullHtml, /kbd\.key-cap\s*\{/)
  assert.match(model.fullHtml, /blockquote\.practice-quote/)
})

await test('handout and venue page carry the same key cap; notes reach neither', () => {
  const slides = extractSlides(model.fullHtml)
  const styles = extractStyles(model.fullHtml)
  const handout = buildShareHtml({ title: 'Key caps probe', slides, styles, includeNotes: false, slug: 'key-caps', license: null })
  const venue = buildVenuePageHtml({ title: 'Key caps probe', slides, styles, slug: 'key-caps', license: null, workerBaseUrl: 'https://worker.test', qr: '', handoutUrl: 'https://talks.test/key-caps' })
  const deckPresent = sectionHtml(model.fullHtml, 'practice-present')
  const deckBody = deckPresent.slice(deckPresent.indexOf('<blockquote'), deckPresent.indexOf('</blockquote>'))
  for (const [name, page] of [['handout', handout], ['venue', venue]]) {
    assert.ok(page.includes(deckBody), `${name}: the practice quotation's markup equals the deck's`)
    assert.ok(page.includes(CAP('F5')), `${name}: paragraph key cap`)
    assert.match(page, /kbd\.key-cap\s*\{/, `${name}: key cap CSS`)
    assert.ok(!page.includes('NOTESENTINEL-KEYCAP'), `${name}: notes never published`)
    assert.ok(!/<kbd[^>]*onclick/.test(page), `${name}: no hostile key cap`)
  }
  assert.ok(model.fullHtml.includes('NOTESENTINEL-KEYCAP'), 'the presenter still has its notes')
})

await test('compiling never changes the outline', () => {
  assert.ok(readFileSync(path).equals(bytesBefore))
})

rmSync(dir, { recursive: true, force: true })
console.log(`test:key-caps ${passed} passed`)
