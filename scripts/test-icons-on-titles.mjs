// test:icons-on-titles — plain view ticket 07 (spec T14): an icon on a slide title (before it, or
// above it with {title-icon=above}) and an icon in a column beside a paragraph.
//
//   lexer     a paragraph's trailing {icon=NAME} is stripped and carried; nothing else is
//   renderer  the HTML of the three positions, with the list's own fl-icon span and iconSvg()
//   registry  title-icon is an option group in the Title section and resolves as a trigger
//   compile   one sample talk (scripts/fixtures/icons-on-titles/) through the real pipeline:
//             slides, the handout page built from them, no raw token anywhere a person reads
//   styles    the new rules select only what the new syntax emits
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { lexMarkdownBlocks, takeParagraphIcon } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { renderBlock } from '../compiler/scripts/lib/06-block-renderers.mjs'
import { iconSvg } from '../compiler/scripts/lib/05-icons.mjs'
import { parseHeadingAttrs, headingIconIsAuthored } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'
import { GLOBAL_OPTION_GROUPS } from '../src/shared/layout-registry/entries.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
let checks = 0
const ok = (cond, label) => { assert.ok(cond, label); checks += 1 }
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks += 1 }

// ── Lexer ────────────────────────────────────────────────────────────────────
eq(takeParagraphIcon('A safe lane. {icon=lucide:route}'), { text: 'A safe lane.', icon: 'lucide:route' }, 'trailing token stripped and carried')
eq(takeParagraphIcon('A safe lane. {icon=route}'), { text: 'A safe lane.', icon: 'lucide:route' }, 'an unprefixed name resolves as on a list item')
eq(takeParagraphIcon('Unknown. {icon=lucide:no-such-icon}'), { text: 'Unknown.', icon: 'fallback:lucide:no-such-icon' }, 'an unknown prefixed name is the list item\'s fallback key')
eq(takeParagraphIcon('Unknown. {icon=zzzz-not-an-icon}'), { text: 'Unknown.', icon: null }, 'an unresolvable bare name: stripped, no icon')
eq(takeParagraphIcon('Ends in a set {a, b}'), { text: 'Ends in a set {a, b}', icon: null }, 'ordinary trailing braces are text')
eq(takeParagraphIcon('Shorthand {bike}'), { text: 'Shorthand {bike}', icon: null }, 'the bare {name} shorthand is not read on a paragraph')
eq(takeParagraphIcon('Mid {icon=lucide:bike} sentence.'), { text: 'Mid {icon=lucide:bike} sentence.', icon: null }, 'only a trailing token counts')

const lex = (text) => lexMarkdownBlocks(text.split('\n'))
eq(lex('Line one\nline two. {icon=lucide:route}'), [{ type: 'paragraph', text: 'Line one line two.', icon: 'lucide:route' }], 'a two-line paragraph: token on its last line')
eq(lex('Plain paragraph.'), [{ type: 'paragraph', text: 'Plain paragraph.' }], 'a paragraph with no token is lexed exactly as before (no icon key)')
eq(lex('Ends in a set {a, b}'), [{ type: 'paragraph', text: 'Ends in a set {a, b}' }], 'trailing ordinary braces: unchanged block')
{
  const quote = lex('> A quotation {icon=lucide:bike}')[0]
  eq(quote.type, 'quote', 'a > line is still a quote')
  ok(quote.text.includes('{icon=lucide:bike}') && !('icon' in quote), 'a quote is not changed by the token')
  const list = lex('- item {icon=lucide:bike}\n- two')[0]
  eq([list.type, list.items, list.iconOverrides], ['list', ['item', 'two'], ['lucide:bike', null]], 'list items keep their own icon handling')
  const table = lex('| Cell {icon=lucide:bike} | b |\n|---|---|\n| a | b |')[0]
  ok(table.type === 'table' && table.header[0] === 'Cell {icon=lucide:bike}', 'a table cell is not changed')
  const code = lex('```\ntext {icon=lucide:bike}\n```')[0]
  ok(code.type !== 'paragraph' && JSON.stringify(code).includes('{icon=lucide:bike}'), 'fenced code is not changed')
  ok(lex('**A bold claim.** {icon=lucide:bike}')[0].type === 'paragraph', 'bold text with a token is a paragraph with an icon, not a claim')
}

// ── Renderer: the paragraph ──────────────────────────────────────────────────
{
  const html = renderBlock({ type: 'paragraph', text: 'A **safe** lane.', icon: 'lucide:route' })
  eq(html, `<p class="content-p" data-para-icon><span class="fl-icon para-icon">${iconSvg('lucide:route')}</span><span class="para-icon-text">A <strong>safe</strong> lane.</span></p>`, 'paragraph with an icon: two columns, the list\'s fl-icon span and iconSvg()')
  eq(renderBlock({ type: 'paragraph', text: 'A safe lane.' }), '<p class="content-p">A safe lane.</p>', 'paragraph with no icon: the markup it always had')
  ok(renderBlock({ type: 'paragraph', text: 'x', icon: 'fallback:lucide:nope' }).includes('data-icon-fallback="lucide:nope"'), 'unknown name: the list item\'s placeholder')
}

// ── Registry and trigger resolution ──────────────────────────────────────────
{
  const group = GLOBAL_OPTION_GROUPS.find((g) => g.key === 'title-icon')
  ok(group && group.section === 'title', 'title-icon is an option group in the Title section')
  eq(group.values.map((v) => v.token), ['', 'title-icon=above'], 'Before stores nothing; Above stores title-icon=above')
  eq(VALUE_TRIGGER_DICTIONARY['title-icon'], ['above'], 'the compiler knows the value')
  const above = parseHeadingAttrs('How it works {icon=lucide:route} {title-icon=above}')
  eq([above.title, above.attrs.icon, above.attrs['title-icon'], above.warnings], ['How it works', 'lucide:route', 'above', []], 'both tokens are consumed, with no warning')
  const shared = parseHeadingAttrs('How it works {icon=lucide:route title-icon=above}')
  eq([shared.title, shared.attrs.icon, shared.attrs['title-icon'], shared.warnings], ['How it works', 'lucide:route', 'above', []], 'one brace group holding both reads the same')
  eq(parseHeadingAttrs('T {title-icon=sideways}').warnings, ['unresolved-trigger:title-icon=sideways'], 'any other value warns as an unknown option value does')
}

// ── One compiled sample talk ─────────────────────────────────────────────────
const samplePath = join(REPO, 'scripts', 'fixtures', 'icons-on-titles', 'icons-on-titles-outline.md')
const sample = readFileSync(samplePath, 'utf8')
const model = await prepareSource(samplePath, sample, 'icons-on-titles', statSync(samplePath))
const dom = new JSDOM(model.fullHtml)
const slide = (id) => dom.window.document.querySelector(`section.slide[data-id="${id}"]`)
// The DOM re-serialises an SVG's empty elements, so icons are compared in that same form.
const asDom = (html) => { const el = dom.window.document.createElement('div'); el.innerHTML = html; return el.innerHTML }
const route = asDom(iconSvg('lucide:route'))
const bike = asDom(iconSvg('lucide:bike'))
{
  // Before the title (the default).
  const h1 = slide('s-ask').querySelector('.slide-head > h1')
  eq(h1.innerHTML, `<span class="title-with-icon" data-title-icon="before"><span class="fl-icon title-icon">${bike}</span><span class="title-text">What riders ask&nbsp;for</span></span>`, 'icon before the title')
  ok(model.fullHtml.includes(`<h1><span class="title-with-icon" data-title-icon="before"><span class="fl-icon title-icon">${iconSvg('lucide:bike')}</span><span class="title-text">What riders ask&nbsp;for</span></span></h1>`), 'the exact title markup as compiled')
  eq(slide('s-ask').dataset.navTitle, 'What riders ask for', 'the navigation title is the words alone')
  // Above the title, on a section heading.
  const sec = slide('s-how')
  const span = sec.querySelector('.slide-head > h1 > .title-with-icon')
  eq([span.dataset.titleIcon, span.querySelector('.title-icon').innerHTML, span.querySelector('.title-text').textContent], ['above', route, 'How it works'], 'icon above the title, on a section heading')
  eq(sec.dataset.role, 'section-title', 'the section heading is still the section\'s title slide')
  // Beside paragraphs.
  const paras = [...slide('s-lane').querySelectorAll('p.content-p')]
  eq(paras.map((p) => p.hasAttribute('data-para-icon')), [true, true], 'both paragraphs carry an icon column')
  eq(paras[0].querySelector('.para-icon').innerHTML, route, 'first paragraph: its icon')
  eq(paras[0].querySelector('.para-icon-text').textContent.replace(/ /g, ' '), 'A safe lane for the whole trip is the request riders make most often, ahead of price and dock position.', 'first paragraph: its text, token gone')
  eq(paras[1].querySelector('.para-icon-text').textContent.replace(/ /g, ' '), 'The set {a, b} is written as it is.', 'braces in the text stay')
  ok(!slide('s-lane').querySelector('.title-with-icon'), 'a title with no icon has none')
  // What is not a top-level paragraph is unchanged.
  const plain = slide('s-plain')
  ok(plain.querySelector('blockquote').textContent.includes('{icon=lucide:bike}'), 'quotation: as written')
  ok(plain.querySelector('table').textContent.includes('{icon=lucide:bike}'), 'table cell: as written')
  ok(!plain.querySelector('[data-para-icon], .title-with-icon'), 'no icon column and no title icon on that slide')
  // Unknown names: the list item's behaviour, and no warning (a list item raises none).
  const unknown = slide('s-unknown')
  ok(unknown.querySelector('h1 .title-icon svg[data-icon-fallback="lucide:no-such-icon"]'), 'unknown title icon: the placeholder')
  const up = [...unknown.querySelectorAll('p.content-p')]
  ok(up[0].querySelector('.para-icon svg[data-icon-fallback="lucide:no-such-icon"]'), 'unknown paragraph icon: the placeholder')
  ok(!up[1].hasAttribute('data-para-icon') && up[1].textContent.replace(/ /g, ' ') === 'A paragraph whose bare name resolves to nothing.', 'unresolvable bare name: no icon, token gone')
  // A bad position reads as the default and warns.
  eq(slide('s-bad').querySelector('.title-with-icon').dataset.titleIcon, 'before', 'another title-icon value is the default')
  eq(model.warnings.filter((w) => /icon/.test(String(w))), ['unresolved-trigger:title-icon=sideways'], 'the only icon warning is the unknown option value')
  // A bodyless heading is painted as the slide's statement: the icon goes with it.
  const closing = slide('s-close')
  ok(closing.querySelector('.slide-content > p > .title-with-icon[data-title-icon="before"] > .title-icon svg'), 'a bodyless section heading keeps its icon where its title is painted')
  eq(closing.querySelector('h1').className, 'sr-only', 'its navigation h1 carries no icon')
  ok(!closing.querySelector('h1 svg'), 'no icon in the hidden h1')
  // The talk's own title: the token is consumed.
  const opening = slide('deck-title')
  eq(opening.dataset.navTitle, 'Ten years of bike hire', 'the talk title has no token')
  ok(!opening.textContent.includes('{icon'), 'the opening poster shows the title without the token')
  // S6: the poster's VISIBLE title (h2.tp-title; its .slide-head is hidden by the poster styles) draws the icon.
  const posterTitle = opening.querySelector('h2.tp-title > .title-with-icon[data-title-icon="before"]')
  ok(posterTitle && posterTitle.querySelector('.title-icon').innerHTML === bike, 'S6: the opening poster draws the talk title\'s icon in its visible title')
  eq(posterTitle.querySelector('.title-text').textContent, 'Ten years of bike hire', 'S6: beside the title\'s words')
}
{
  // Nothing a person reads shows a raw token: every slide, and the handout page built from them.
  const visible = (root) => [...root.querySelectorAll('section.slide')].map((s) => s.textContent).join('\n')
  const tokens = (text) => (text.match(/\{(?:icon|title-icon)=[^}]*\}/g) ?? [])
  // The quotation, the list item's neighbour and the table cell above are written with a token on purpose.
  eq(tokens(visible(dom.window.document)).sort(), ['{icon=lucide:bike}', '{icon=lucide:bike}'], 'slides: only the quotation and the table cell show a token')
  const handout = buildShareHtml({ title: model.title, slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'icons-on-titles' })
  const hd = new JSDOM(handout).window.document
  ok(hd.querySelector('.title-with-icon[data-title-icon="above"] .title-icon svg'), 'handout: the title icon is there')
  eq(hd.querySelectorAll('p.content-p[data-para-icon] > .para-icon svg').length >= 3, true, 'handout: the paragraph icons are there')
  ok(/\.title-with-icon/.test(handout) && /data-para-icon/.test(handout), 'handout: carries the icon styles')
  eq(tokens(visible(hd)).length, 2, 'handout slides: no other raw token')
  // The phone text view of the handout is rendered from the outline: no token there either.
  const script = handout.match(/var SLIDE_SCRIPT = (\[[\s\S]*?\]);\n/)
  ok(script, 'handout: the phone text view payload is there')
  ok(!/\{icon=lucide:route\}|title-icon=/.test(script[1]), 'handout phone text view: no title or paragraph icon token')
}

// ── Review round 1 ───────────────────────────────────────────────────────────
// B3: an authoring token is a brace group that ends the text AND follows whitespace. Braces glued
// to text (a URL's tail, an escaped brace) and braces inside a link, a code span or a tag are text.
const LITERAL = [
  'See https://example.org/{icon=lucide:bike}',
  'Use literal \\{icon=lucide:bike}',
  'Link [a](https://example.org/{icon=lucide:bike})',
  'Auto <https://example.org/{icon=lucide:bike}>',
  'Code `x {icon=lucide:bike}`',
  'Tag <span title="x {icon=lucide:bike}">y</span>',
  'Glued{icon=lucide:bike}'
]
for (const text of LITERAL) {
  eq(takeParagraphIcon(text), { text, icon: null }, `B3: not a token: ${text}`)
  eq(lex(text), [{ type: 'paragraph', text }], `B3: lexed as the paragraph it always was: ${text}`)
}
eq(takeParagraphIcon('See https://example.org/ {icon=lucide:bike}'), { text: 'See https://example.org/', icon: 'lucide:bike' }, 'B3: after whitespace it is a token, also after a URL')
eq(takeParagraphIcon('Tabbed.\t{ icon = lucide:bike }  '), { text: 'Tabbed.', icon: 'lucide:bike' }, 'B3: any whitespace before, spaces inside and after')
eq(headingIconIsAuthored('How it works {icon=lucide:route} {id=a}'), true, 'heading: a group after a space is authored')
eq(headingIconIsAuthored('How it works {reveal}{icon=lucide:route}'), true, 'heading: also right after another authored group')
eq(headingIconIsAuthored('See https://example.org/{icon=lucide:route}'), false, 'heading: glued to a URL is not')
eq(headingIconIsAuthored('See https://example.org/{reveal}{icon=lucide:route} {id=a}'), false, 'heading: nor through a group that is itself glued')
eq(headingIconIsAuthored('Literal \\{icon=lucide:route}'), false, 'heading: an escaped brace is not')
eq(headingIconIsAuthored('Plain {id=a}'), null, 'heading: no icon token')

const compileText = async (text) => {
  const m = await prepareSource('/nowhere/t-outline.md', text, 't', { isDirectory: () => false })
  const d = new JSDOM(m.fullHtml).window.document
  return { model: m, doc: d, slide: (id) => d.querySelector(`section.slide[data-id="${id}"]`), byTitle: (t) => [...d.querySelectorAll('section.slide')].find((s) => s.dataset.navTitle === t) }
}
const rawTokens = (root) => (root.textContent.match(/\{(?:icon|title-icon)=[^}]*\}/g) ?? [])
{
  const { model: m, slide: s } = await compileText([
    '---', 'title: Literal braces', '---', '',
    '### Paragraphs {id=s-lit}', '', ...LITERAL.slice(0, 2).flatMap((t) => [t, '']),
    '### See https://example.org/{icon=lucide:bike}', '', 'Body one.', '',
    '### Literal \\{icon=lucide:bike}', '', 'Body two.', '',
    '### Trigger line https://example.org/{icon=lucide:bike}', '{icon=lucide:route} {id=s-trig}', '', 'Body three.', '',
    '### Own icon {icon=lucide:bike}', '{icon=lucide:route} {id=s-own}', '', 'Body four.', '',
    '### Placed by the Trigger line {icon=lucide:bike}', '{title-icon=above} {id=s-placed}', '', 'Body five.', ''
  ].join('\n'))
  eq(m.adapter, 'markdown-outline-v2', 'front matter selects the v2 adapter')
  const lit = s('s-lit')
  ok(!lit.querySelector('[data-para-icon]'), 'B3: a paragraph ending in a URL with braces, or in an escaped brace, gets no icon')
  ok(lit.textContent.includes('https://example.org/{icon=lucide:bike}'), 'B3: the URL is shown whole')
  ok([...lit.querySelectorAll('p.content-p')][1].textContent.includes('{icon=lucide:bike}'), 'B3: the escaped braces are shown')
  const glued = [...new JSDOM(m.fullHtml).window.document.querySelectorAll('section.slide')].filter((x) => /Body\s(one|two)\./.test(x.textContent))
  eq(glued.length, 2, 'the two headings with glued braces compiled')
  ok(glued.every((x) => !x.querySelector('.title-with-icon')), 'B3: a heading whose braces are glued to its text draws no title icon')
  // Fix round 2 (review 2, finding 3 and 5): a title's icon comes only from the heading's own line.
  // An `icon=` on the slide's Trigger line drew nothing before the ticket and draws nothing now; it
  // does not override the heading's icon either. Placement (`title-icon=above`) may come from the
  // Trigger line: it only places an icon the heading has.
  ok(!s('s-trig').querySelector('.title-with-icon'), 'an icon named on the Trigger line is not a title icon')
  const own = s('s-own').querySelector('h1 .title-icon')
  const svgOf = (key) => { const el = new JSDOM('').window.document.createElement('div'); el.innerHTML = iconSvg(key); return el.innerHTML }
  ok(own && own.innerHTML === svgOf('lucide:bike'), 'the heading\'s own icon is drawn, not the Trigger line\'s')
  eq(s('s-placed').querySelector('h1 .title-with-icon')?.getAttribute('data-title-icon'), 'above', 'a Trigger line may place the heading\'s icon above')
}
{
  // Review 2 finding 3: a front-matter `triggers:` default never puts an icon in a title, and a
  // heading's own icon is drawn (and placed by a deck-wide `title-icon=above`) under one.
  const { slide: s } = await compileText([
    '---', 'outline_version: 2', 'triggers: icon=lucide:bike title-icon=above', '---', '# Talk', '',
    '### A {id=s-plain}', '', 'Body.', '',
    '### B {icon=lucide:route} {id=s-authored}', '', 'Body.', ''
  ].join('\n'))
  ok(!s('s-plain').querySelector('.title-with-icon, [data-para-icon]'), 'a deck default `icon=` draws nothing on a slide that asks for no icon')
  eq(s('s-authored').querySelector('h1 .title-with-icon')?.getAttribute('data-title-icon'), 'above', 'the heading\'s own icon is drawn, placed by the deck default')
}
{
  // B2: the legacy adapter (an outline with no front matter, no `####`, no heading or Trigger-line
  // token, no directive) draws no paragraph icon, and never prints the token.
  const { model: m, doc: d } = await compileText('# Talk\n\n### A\n\nHello. {icon=lucide:bike}\n\nSee https://example.org/{icon=lucide:bike}\n\n:::notes\nA note. {icon=lucide:bike}\n:::\n')
  eq(m.adapter, 'markdown-outline-v1', 'B2: this outline goes through the legacy adapter')
  const a = [...d.querySelectorAll('section.slide')].find((x) => x.textContent.includes('Hello.'))
  const body = a.cloneNode(true)
  body.querySelectorAll('aside, .notes, [data-notes]').forEach((n) => n.remove())
  ok(/Hello\.\s/.test(body.textContent) && !/Hello\. \{icon/.test(a.textContent), 'B2: v1 slide shows the paragraph without its token')
  ok(!a.querySelector('[data-para-icon]'), 'B2: v1 draws no paragraph icon')
  ok(a.textContent.includes('https://example.org/{icon=lucide:bike}'), 'B2: braces that are not a token stay as written in v1 too')
  const handout = buildShareHtml({ title: m.title, slides: extractSlides(m.fullHtml), styles: extractStyles(m.fullHtml), includeNotes: false, slug: 't' })
  const hd = new JSDOM(handout).window.document
  ok(![...hd.querySelectorAll('section.slide')].some((x) => /Hello\. \{icon/.test(x.textContent)), 'B2: nor does the v1 handout')
  ok(!/Hello\. \{icon=/.test(handout), 'B2: the token is nowhere in the v1 handout page')
}
{
  // S6: posters draw the icon in their visible title. S7 and S8: where no icon is drawn in this
  // release (spec T14, "Not drawn in this release"), the token is still consumed.
  const { doc: d, slide: s, byTitle } = await compileText([
    '---', 'title: Front matter title', 'auto_thanks_slide: false', '---', '',
    '# The talk {icon=lucide:route title-icon=above}', '',
    '### Welcome {title icon=lucide:route} {id=s-welcome}', '', 'Subtitle. {icon=lucide:bike}', '',
    '### Cards {cards=grid} {id=s-cards}', '', '#### Card one {icon=lucide:bike}', '', 'Card prose.', '', '#### Card two', '', 'More prose.', '',
    '### Carousel {carousel} {id=s-carousel}', '', 'Source line. {icon=lucide:route}', '', '#### Frame {icon=lucide:bike}', '', 'Frame body.', '',
    '### Columns {columns} {id=s-columns}', '', '#### Left {icon=lucide:bike}', '', 'Left prose.', '', '#### Right', '', 'Right prose.', '',
    '### Goodbye {closing icon=lucide:bike title-icon=above} {id=s-bye}', ''
  ].join('\n'))
  const welcome = s('s-welcome')
  const wt = welcome.querySelector('h2.tp-title > .title-with-icon')
  ok(wt && wt.dataset.titleIcon === 'before' && wt.querySelector('.title-icon').innerHTML === route, 'S6: an authored {title} poster draws the icon in its visible title')
  eq(wt.querySelector('.title-text').textContent, 'Welcome', 'S6: with the title\'s words')
  const bye = s('s-bye').querySelector('h2.tp-title > .title-with-icon')
  ok(bye && bye.dataset.titleIcon === 'above' && bye.querySelector('.title-icon').innerHTML === bike, 'S6: an authored {closing} poster too, above when asked')
  // S8 (limit): a paragraph taken by the poster's subtitle slot.
  const sub = welcome.querySelector('.tp-sub')
  eq(sub.textContent, 'Subtitle.', 'S8: poster subtitle: the token is not shown')
  ok(!sub.querySelector('svg') && !welcome.querySelector('[data-para-icon]'), 'S8: poster subtitle: no icon is drawn')
  // S8 (limit): a carousel's source line.
  const carousel = s('s-carousel')
  ok(carousel, 'the carousel compiled')
  eq(rawTokens(carousel), [], 'S8 and S7: carousel: no token is shown (source line, frame heading)')
  ok(/Source line\.(?! \{)/.test(carousel.textContent), 'S8: carousel source line: its text is there')
  ok(!carousel.querySelector('[data-para-icon], .para-icon, .title-with-icon'), 'S8 and S7: carousel: no paragraph icon and no title icon is drawn')
  // S7 (limit): an icon on a child heading folded into its parent (card, column).
  for (const id of ['s-cards', 's-columns']) {
    const folded = s(id)
    ok(folded && /(Card one|Left)/.test(folded.textContent), `S7: ${id} compiled with its child headings folded in`)
    eq(rawTokens(folded), [], `S7: ${id}: the child heading's token is not shown`)
    ok(!folded.querySelector('.title-with-icon, .title-icon, [data-para-icon]'), `S7: ${id}: no icon is drawn for the child heading`)
  }
  eq([...d.querySelectorAll('section.slide')].flatMap((x) => rawTokens(x)), [], 'no raw icon token anywhere on these slides')
  void byTitle
}
{
  // S6: the opening poster built from the `#` line; a front-matter title does not lose the icon.
  const { slide: s } = await compileText('---\ntitle: From front matter\n---\n\n# The talk {icon=lucide:route title-icon=above}\n\n### A {id=a1}\n\nBody.\n')
  const t = s('deck-title').querySelector('h2.tp-title > .title-with-icon')
  ok(t && t.dataset.titleIcon === 'above' && t.querySelector('.title-icon').innerHTML === route, 'S6: `# Talk {icon=… title-icon=above}` draws the icon above the opening poster\'s title')
  const none = await compileText('---\ntitle: T\n---\n\n# See https://example.org/{icon=lucide:route}\n\n### A {id=a1}\n\nBody.\n')
  ok(!none.slide('deck-title').querySelector('.title-with-icon'), 'B3: braces glued to the talk title draw no icon')
  const plain = await compileText('---\ntitle: T\n---\n\n# The talk\n\n### A {id=a1}\n\nBody.\n')
  ok(plain.slide('deck-title').querySelector('h2.tp-title') && !plain.slide('deck-title').querySelector('.title-with-icon'), 'a poster with no icon has the title markup it always had')
}

// ── Styles: only the new markup is selected ─────────────────────────────────
{
  const css = readFileSync(join(REPO, 'compiler', 'assets', 'styles', 'layouts', 'title-and-paragraph-icons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim())
  ok(selectors.length >= 6, 'the stylesheet has its rules')
  for (const sel of selectors) ok(/\.title-with-icon|\[data-para-icon\]/.test(sel), `selector names only new markup: ${sel}`)
  ok(model.fullHtml.includes('.title-with-icon'), 'the compiled deck carries the rules')
}

console.log(`test:icons-on-titles — ${checks} checks passed`)
