// 0.37 preview.5: a slide title carries the same inline formatting as body text (**bold**, *italic*,
// `code`) in every place the compiler paints it — top bar, sidebar, title looks, section and
// subsection dividers, statement slides (painted heading and heading-as-statement), the kicker, the
// nav-only (sr-only) heading — and in the handout built from the same HTML. Markup in a title stays
// escaped text. The short-word binding (ADR-0033 §7) still applies to a formatted title. Places that
// show a title as plain text (the <title> element, data-nav-label) carry no markers.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { tieShortWords } from '../compiler/scripts/lib/no-lone-word.mjs'

const NBSP = '&nbsp;'
// Pure: binding works through inline formatting, never into code or links.
assert.equal(tieShortWords('Use a <strong>tool</strong> for <em>the</em> job'), `Use a${NBSP}<strong>tool</strong> for${NBSP}<em>the</em>${NBSP}job`)
assert.equal(tieShortWords('Read <code>the docs</code> and <a href="#">a link</a>'), 'Read <code>the docs</code> and <a href="#">a link</a>', 'code and links are not bound into')

const source = [
  '---', 'title: Deck with **bold** title', 'auto_title_slide: false', 'auto_thanks_slide: false', 'section_labels: true', '---', '',
  '## Section **one**', '',
  '### **About** this `showcase`', '{list}{title=side}{id=side}', '', '- item one', '- item two', '',
  '### Top *italic* title of the thing', '{list}{title=top}{id=top}', '', '- a', '',
  '### Tab **look** here', '{list}{title=top}{titlelook=tab}{id=tab}', '', '- x', '',
  '#### Subsection *two*', '',
  '### A **strong** statement', '{statement}{id=stmt}', '', 'Some statement text here.', '',
  '### Just **one** claim to make', '{statement}{id=bare}', '',
  '### Quoted **heading**', '{quote}{id=quote}', '', '> A quote body.', '',
  '### <script>alert(1)</script> **bad** <img src=x onerror=alert(1)>', '{id=hostile}', '', '- y', ''
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'tw-slide-title-inline-'))
try {
  const path = join(dir, 'deck.md')
  writeFileSync(path, source)
  const model = await prepareSource(path, source, '', statSync(path))
  const html = model.fullHtml
  const section = (id) => {
    const at = html.indexOf(`data-id="${id}"`)
    assert(at >= 0, `slide ${id} compiled`)
    return html.slice(html.lastIndexOf('<section', at), html.indexOf('</section>', at))
  }
  const sectionByTitle = (fragment) => {
    const at = html.indexOf(fragment)
    assert(at >= 0, `found ${fragment}`)
    return html.slice(html.lastIndexOf('<section', at), html.indexOf('</section>', at))
  }
  const h1 = (slide) => slide.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ''

  assert.equal(h1(section('side')), '<strong>About</strong> this <code>showcase</code>', 'sidebar title')
  assert.match(section('side'), /data-title-layout="left"/)
  assert.equal(h1(section('top')), `Top <em>italic</em> title of${NBSP}the${NBSP}thing`, 'top title, short words still bound')
  assert.match(h1(section('tab')), /^Tab <strong>look<\/strong>/, 'title look (tab)')
  assert.match(section('tab'), /data-title-look="tab"/)
  assert(section('side').includes('<p class="kicker">Section <strong>one</strong></p>'), 'the kicker (section name) renders inline too')
  assert.equal(h1(section('stmt')), `A${NBSP}<strong>strong</strong> statement`, 'statement heading: "A" binds across <strong>')
  assert(section('bare').includes('<p>Just <strong>one</strong> claim to&nbsp;make</p>'), 'heading promoted to the statement paragraph keeps its bold')
  assert.match(section('bare'), /<h1 class="sr-only">Just <strong>one<\/strong> claim to make<\/h1>/, 'nav-only heading')
  assert.match(section('quote'), /<h1 class="sr-only">Quoted <strong>heading<\/strong><\/h1>/, 'hidden-regime (quote) heading')
  assert.match(h1(sectionByTitle('data-nav-title="Section **one**"')), /^Section(&nbsp;| )<strong>one<\/strong>$/, 'section divider')
  assert.match(h1(sectionByTitle('data-nav-title="Subsection *two*"')), /^Subsection(&nbsp;| )<em>two<\/em>$/, 'subsection divider')

  const hostile = section('hostile')
  assert(!/<script|<img/i.test(hostile), 'markup in a title stays text')
  assert(h1(hostile).includes('&lt;script&gt;alert(1)&lt;/script&gt;') && h1(hostile).includes('<strong>bad</strong>'))

  // Plain-text places.
  assert.equal(html.match(/<title>([^<]*)<\/title>/)[1], 'Deck with bold title', 'the <title> element has no markers')
  assert.match(html, /<meta name="deck-title" content="Deck with bold title">/)
  assert.match(section('side'), /data-nav-title="\*\*About\*\* this `showcase`" data-nav-label="About this showcase"/, 'nav title kept as written, nav label plain')
  assert.match(section('top'), /data-nav-label="Top italic title of the thing"/)

  // The handout is built from the same slide HTML: the formatting travels with it.
  const share = buildShareHtml({ title: model.title, slides: extractSlides(html), styles: extractStyles(html), includeNotes: false, slug: 't' })
  assert(share.includes('<h1><strong>About</strong> this <code>showcase</code></h1>'), 'handout slide title is formatted')
  assert(!share.includes('**About**</h1>') && !share.includes('<h1>**About**'), 'no raw markers in a handout heading')
  assert.equal(share.match(/<title>([^<]*)<\/title>/)[1], 'Deck with bold title')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('PASS slide title inline: every title placement renders inline formatting, markup stays text, short words still bind, plain-text places carry no markers')
