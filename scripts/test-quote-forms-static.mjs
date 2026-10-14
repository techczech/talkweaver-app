// Quote forms, tickets 05 and 07 (the source-styled quote slides design, spec section 9): the handout, a
// shared talk, the venue page and print keep the form, with the source as a link. Plain Node, no browser
// (the drawn result is photographed by a development-only handout print script).
//
// Seams under test: the compile stamps the side payload; the share builder (buildShareHtml, the handout, share
// and venue page) writes `qf-static` and the link in the right element for each form and in the phone text;
// no link when the source has none; the video `t=` rule; the stage markup is unchanged; no editor placeholder in
// static output; the print and static rules in the stylesheets.
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { quoteFormHref, quoteFormLinkText, quoteFormStatic } from '../compiler/scripts/lib/quote-forms-static.mjs'
import { parseSourceLine } from '../compiler/scripts/lib/quote-forms.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-quote-forms-static-'))
mkdirSync(join(dir, 'assets'))
writeFileSync(join(dir, 'assets/page.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const WEB = 'https://www.samplesite.example/posts/a-sample-post'
const X = 'https://x.com/techczech/status/1234567890123456789'
const YT = 'https://www.youtube.com/watch?v=XXXXXXXXXXX'
const CH = 'https://www.youtube.com/channel/abc?x=1&y=2'
const DOI = 'https://doi.org/10.1093/mind/LIX.236.433'
const words = 'Sample quotation for the handout.'
const turing = 'A. M. Turing, "Computing Machinery and Intelligence", *Mind* 59(236), 1950, p. 460'
const slides = [
  ['tw', `{quote}\n\n> ${words}\n\n- Dominik Lukeš (@techczech), 4 Oct 2026, 2:33 PM ${X}`],
  ['tw-nodate', `{quote}\n\n> ${words}\n\n- Dominik Lukeš ${X}`],
  ['tw-nolink', `{quote form=tweet}\n\n> ${words}\n\n- Sample Name (@samplehandle), 1 Jan 2026`],
  ['tw-empty', `{quote form=tweet}\n\n- Sample Name (@samplehandle) ${X}`],
  ['vid', `{quote}\n\n> ${words}\n\n- Sample channel, Sample talk title, 12:34 / 48:10 ${YT}`],
  ['vid-t', `{quote}\n\n> ${words}\n\n- Sample channel, Sample talk title, 12:34 / 48:10 ${YT}&t=90`],
  ['vid-notime', `{quote}\n\n> ${words}\n\n- Sample channel, Sample talk title ${YT}`],
  ['vid-nolink', `{quote form=video}\n\n> ${words}\n\n- Sample channel, Sample talk title, 12:34`],
  ['book', `{quote form=book}\n\n> ${words}\n\n- George Lakoff and Mark Johnson, *Metaphors We Live By*, University of Chicago Press, 1980, p. 5 https://example.org/metaphors-we-live-by`],
  ['book-nolink', `{quote form=book}\n\n> ${words}\n\n- George Lakoff and Mark Johnson, *Metaphors We Live By*, University of Chicago Press, 1980, p. 5`],
  ['paper', `{quote form=paper}\n\n> ${words}\n\n- ${turing} ${DOI}`],
  ['paper-nolink', `{quote form=paper}\n\n> ${words}\n\n- ${turing}`],
  ['web', `{quote form=web}\n\n> ${words}\n\n- Sample Author, "A sample headline", *Sample Site*, 3 Sep 2026 ${WEB}`],
  ['web-only', `{quote form=web}\n\n> ${words}\n\n- ${WEB}`],
  ['web-panel', `{quote form=web}\n\n![Screenshot of the post](assets/page.png)\n\n> ${words}\n\n- Sample Author, "A sample headline", *Sample Site*, 3 Sep 2026 ${WEB}`],
  ['web-nolink', `{quote form=web}\n\n> ${words}\n\n- Sample Author, "A sample headline", *Sample Site*, 3 Sep 2026`],
  ['web-plain-link', `{quote}\n\n> ${words}\n\n- Sample Author ${WEB}`],
  ['quoted-form', `{quote form=book}\n\n> "Sample ‘inner’ words."\n\n- George Lakoff, *Metaphors*, Chicago, 1980, p. 5`],
  ['quoted-curly', `{quote form=book}\n\n> “First paragraph.\n>\n> Second paragraph.”\n\n- George Lakoff, *Metaphors*, Chicago, 1980, p. 5`],
  ['quoted-plain', `{quote}\n\n> "Sample words."\n\n- George Lakoff, 1980`],
  ['plain', `{quote}\n\n> The essence of metaphor.\n\n- George Lakoff, 1980`],
  ['doi-plain', `{quote}\n\n> ${words}\n\n- ${turing} ${DOI}`],
  ['plain-bare', `{quote}\n\n> ${words}\n\n- Sample Channel ${CH}`],
  ['plain-titled', `{quote}\n\n> ${words}\n\n- Sample Channel [A channel title](${CH}) and [${WEB}](${WEB})`]
]
const md = `# Talk\n\n## Section\n\n${slides.map(([id, body]) => `### Slide ${id} {id=${id}}\n${body}`).join('\n\n')}\n`
const path = join(dir, 'talk.md')
writeFileSync(path, md)
const model = await prepareSource(path, md, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
const deck = await buildDeckHtmlFromModel(model)
const stage = extractSlides(deck)
const byId = (list, id) => list.find((slide) => slide.id === id)
const make = (opts = {}) => {
  const html = buildShareHtml({ title: 'Talk', slug: 't', includeNotes: false, license: null, slides: extractSlides(deck), styles: extractStyles(deck), ...opts })
  const share = (id) => html.match(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''
  const script = JSON.parse(html.match(/var SLIDE_SCRIPT = (\[[\s\S]*?\]);\n/)?.[1].replace(/\\u003c/g, '<') ?? '[]')
  const phone = (id) => script[stage.findIndex((slide) => slide.id === id)]
  return { html, share, phone }
}
const handout = make()
const link = (href, extra = '') => `<a class="qf-source-link${extra}" href="${href}" target="_blank" rel="noopener">${quoteFormLinkText(href)}</a>`

// ── 1. The stage is unchanged ─────────────────────────────────────────────────────────────────
for (const id of ['tw', 'vid', 'book', 'paper', 'web', 'web-only', 'web-panel']) {
  const html = byId(stage, id).html
  assert(html.includes('<figure class="qf '), `${id}: draws as a form`)
  assert(!/qf-static|qf-source-link|<a[\s>]|href=/.test(html), `${id}: the stage carries no link, no underline marker and no static class`)
}
assert(byId(stage, 'paper').html.includes('<span class="qf-doi">doi:10.1093/mind/LIX.236.433</span>'), 'a DOI stays as doi: text on stage')
assert(byId(stage, 'tw').html.includes('<div class="qf-x-time">2:33 PM · 4 Oct 2026</div>'), 'the tweet date row stays as it was')
assert(byId(stage, 'vid').html.includes('qf-yt-subscribe'), 'the Subscribe pill stays on stage')
assert.equal(quoteFormStatic(byId(stage, 'tw').html, null), byId(stage, 'tw').html, 'no payload entry: nothing changes')
assert(deck.includes('id="twQuoteSources"'), 'the compile stamps the side payload')

// ── 2. Where the link goes, per form ──────────────────────────────────────────────────────────
{
  const tw = handout.share('tw')
  assert(/^<section class="slide[^"]* qf-static"/.test(tw), 'class qf-static on the slide')
  assert(tw.includes(`<div class="qf-x-time">2:33 PM · 4 Oct 2026 · ${link(X)}</div>`), 'tweet: the link joins the date row after " · "')
  assert(handout.share('tw-nodate').includes(`<div class="qf-x-time">${link(X)}</div>`), 'tweet with no date: the link stands alone in the row')
  assert(handout.share('tw-empty').includes(link(X)), 'a tweet with no words still gets its link')

  const vid = handout.share('vid')
  const at = 'https://www.youtube.com/watch?v=XXXXXXXXXXX&amp;t=754'
  assert(vid.includes(`<a class="qf-source-link qf-yt-link" href="${at}" target="_blank" rel="noopener">youtube.com</a></div></figcaption>`), 'video: the link ends the channel row, with t= in the href and the site alone as the text')
  assert(!/qf-yt-subscribe|qf-yt-likes|qf-yt-sep/.test(vid), 'video: the Subscribe and like pills are gone')
  assert(vid.includes('<b>Sample channel</b>'), 'video: the channel stays')

  const book = handout.share('book')
  assert(book.includes(`<div class="qf-source-id">${link('https://example.org/metaphors-we-live-by')}</div></figcaption>`), 'book: the link is the last line of the source block')
  assert(book.indexOf('qf-pill') < book.indexOf('qf-source-link'), 'book: after the page pill')

  const paper = handout.share('paper')
  assert(paper.includes(`<span class="qf-doi">${link(DOI)}</span>`) && paper.split('doi:10.1093').length === 2, 'paper page: the link replaces the doi: text in the footer, and reads the DOI itself (once)')
  assert(paper.includes('<span class="qf-page-number"><span class="qf-sr">page </span>460</span>'), 'paper page: the page number stays')

  // The web page (spec 9): the link replaces the domain in the address pill, which widens; a link-only window loses its domain line.
  const web = handout.share('web')
  assert(web.includes(`<a class="qf-source-link qf-web-host" href="${WEB}" target="_blank" rel="noopener">samplesite.example</a></span></div>`), 'web window: the link is in the address pill, in the host element, showing the site alone')
  assert(!web.includes('<span class="qf-web-host">') && web.includes('<rect width="18" height="11"'), 'web window: the domain text is replaced, the lock stays')
  assert(web.includes('qf-web-site">Sample Site') && web.includes('qf-web-headline'), 'web window: the masthead and the headline are the stage\'s')
  const only = handout.share('web-only')
  assert(only.includes(`<a class="qf-source-link qf-web-host" href="${WEB}"`) && !only.includes('qf-web-domain'), 'web link-only window: the pill holds the address and the domain line is left out')
  const panel = handout.share('web-panel')
  assert(panel.includes('<span class="qf-web-host">samplesite.example</span>'), 'web panel: the pill keeps the domain')
  assert(panel.includes(`<div class="qf-source-id">${link(WEB)}</div></figcaption>`), 'web panel: the link is the last line of the source block')
  assert(panel.indexOf('qf-source-where') < panel.indexOf('qf-source-link'), 'web panel: after the where lines')
  assert(!handout.share('web-plain-link').includes('qf-static'), 'an ordinary link on a plain quote stays a plain quote in the handout')
  assert(!handout.share('doi-plain').includes('qf-static') && !handout.share('doi-plain').includes('qf-paper'), 'a DOI on a plain quote stays a plain quote in the handout')
  // Plain quotes: the visible text of an address link is the site; the href is the full address; a titled link is left alone.
  const bare = handout.share('plain-bare')
  assert(bare.includes(`href="${CH.replace('&', '&amp;')}" target="_blank" rel="noopener">youtube.com</a>`), 'plain quote: a bare address shows the site, the href is the full address')
  const titled = handout.share('plain-titled')
  assert(titled.includes(`href="${CH.replace('&', '&amp;')}" target="_blank" rel="noopener">A channel title</a>`), 'plain quote: a link with a title keeps its title')
  assert(titled.includes(`href="${WEB}" target="_blank" rel="noopener">samplesite.example</a>`), 'plain quote: a Markdown link whose text is its own address shows the site')
  assert(!/>https?:\/\//.test(bare + titled), 'no address is shown as text')
  assert(handout.phone('plain-bare').some((block) => block.type === 'attrib' && block.html.includes('>youtube.com</a>') && !/>https?:/.test(block.html)), 'the phone text of a plain quote shows the site too')
  assert(byId(stage, 'plain-bare').html.includes('>youtube.com</a>'), 'plain quote on stage: the text is the site too (nothing is styled as a link there)')
}

// ── 3. The href rules ─────────────────────────────────────────────────────────────────────────
{
  const hrefOf = (form, fields, line) => quoteFormHref(form, fields, parseSourceLine(line).link)
  assert.equal(quoteFormHref('paper', { doi: '10.1002/(SICI)1097-4571(199009)41:6<391::AID-ASI1>3.0.CO;2-9' }, null), 'https://doi.org/10.1002/%28SICI%291097-4571%28199009%2941:6%3C391::AID-ASI1%3E3.0.CO;2-9', 'a DOI href: ( ) < > percent-encoded, ; : kept')
  assert.equal(quoteFormHref('paper', { doi: '10.1093/mind/LIX.236.433' }, null), 'https://doi.org/10.1093/mind/LIX.236.433', 'an ordinary DOI href is unchanged')
  assert.equal(hrefOf('video', { time: '12:34' }, `a ${YT}`), `${YT}&t=754`, 'video: t=<seconds> added when a time is known')
  assert.equal(hrefOf('video', { time: '1:02:03' }, 'a https://youtu.be/XXXXXXXXXXX'), 'https://youtu.be/XXXXXXXXXXX?t=3723', 'youtu.be: a query is started')
  assert.equal(hrefOf('video', { time: '12:34' }, `a ${YT}&t=90`), `${YT}&t=90`, 'the typed t= stands')
  assert.equal(hrefOf('video', { time: '' }, `a ${YT}`), YT, 'no time known: the link as typed')
  assert.equal(hrefOf('video', { time: '12:34' }, `a ${YT}#top`), `${YT}&t=754#top`, 't= goes before a fragment')
  assert.equal(hrefOf('paper', { doi: '10.1093/mind/LIX.236.433' }, `a ${DOI}`), DOI, 'a DOI is https://doi.org/<doi>')
  assert.equal(hrefOf('tweet', {}, `a ${X}`), X)
  assert.equal(hrefOf('tweet', {}, 'a ftp://example.org/x'), '', 'only http(s) is ever written')
  assert.equal(hrefOf('tweet', {}, 'a javascript:alert(1)'), '', 'a script address is never written')
  assert.equal(hrefOf('tweet', {}, 'Name, 1 Jan 2026'), '', 'no link, no href')
  // Link text is the site alone (2026-10-12): no scheme, www, port, path, query or fragment; the href keeps the full address.
  assert.equal(quoteFormLinkText('https://www.example.org/a?b=1'), 'example.org')
  assert.equal(quoteFormLinkText('http://Sub.Example.org:8080/a#top'), 'sub.example.org')
  assert.equal(quoteFormLinkText(DOI), `doi:${DOI.replace(/^https?:\/\/doi\.org\//, '')}`, 'a DOI address reads the DOI itself, as the slide footer does')
  assert.equal(quoteFormLinkText('https://doi.org/10.1093/mind/LIX.236.433'), 'doi:10.1093/mind/LIX.236.433')
  assert.equal(quoteFormLinkText('http://DX.DOI.ORG/10.1093/mind/LIX.236.433'), 'doi:10.1093/mind/LIX.236.433', 'host in any case, dx. too')
  assert.equal(quoteFormLinkText('https://doi.org/10.1002/(SICI)1097%2D4571'), 'doi:10.1002/(SICI)1097-4571', 'decoded')
  assert.equal(quoteFormLinkText('https://doi.orgx.example/10.1/a'), 'doi.orgx.example', 'only the doi host, not a look-alike')
  assert.equal(quoteFormLinkText(YT), 'youtube.com')
  assert.equal(quoteFormLinkText(X), 'x.com')
  const vidT = handout.share('vid-t')
  assert(vidT.includes('href="https://www.youtube.com/watch?v=XXXXXXXXXXX&amp;t=90"') && !vidT.includes('t=754'), 'compiled: a typed t= is not overwritten')
  assert(handout.share('vid-notime').includes(`href="${YT}"`), 'compiled: no time, the link as typed')
}

// ── 4. No link: the slide is the stage's, with the static class only ──────────────────────────
for (const id of ['tw-nolink', 'vid-nolink', 'book-nolink', 'paper-nolink', 'web-nolink']) {
  const out = handout.share(id)
  assert(out.includes('qf-static'), `${id}: still static`)
  assert(!/<a[\s>]/.test(out.replace(/<section[^>]*>/, '')) && !out.includes('qf-source-link'), `${id}: no link element`)
  const stageSection = byId(stage, id).html
  assert.equal(out.replace(' qf-static"', '"').replace(/ data-share-index="\d+"/, ''), stageSection.trim(), `${id}: identical to the stage`)
}
assert(handout.share('vid-nolink').includes('qf-yt-subscribe'), 'no link: the Subscribe pill stays')
assert(handout.share('paper-nolink').includes('qf-doi') === byId(stage, 'paper-nolink').html.includes('qf-doi'), 'no link: the footer is the stage footer')
assert(!handout.share('plain').includes('qf-static'), 'a plain quote is not a form and is not touched')

// ── 5. The phone text ─────────────────────────────────────────────────────────────────────────
{
  const attrib = (id) => handout.phone(id)?.find((block) => block.type === 'attrib')
  assert.equal(attrib('tw').html, `Dominik Lukeš (@techczech), 2:33 PM · 4 Oct 2026 · ${link(X)}`, 'tweet: fields joined with commas, then · and the link')
  assert.equal(attrib('vid').html, `Sample channel, Sample talk title, at 12:34 · ${link('https://www.youtube.com/watch?v=XXXXXXXXXXX&amp;t=754')}`)
  assert.equal(attrib('book').html, `George Lakoff and Mark Johnson, Metaphors We Live By, University of Chicago Press, 1980, page 5 · ${link('https://example.org/metaphors-we-live-by')}`)
  assert.equal(attrib('paper').html, `A. M. Turing, Computing Machinery and Intelligence, Mind 59 (236), 1950, page 460 · ${link(DOI)}`)
  assert.equal(attrib('web').html, `Sample Author, A sample headline, Sample Site, 3 Sep 2026 · ${link(WEB)}`, 'web: author, headline, site name, date, then · and the link')
  assert.equal(attrib('web-nolink').html, 'Sample Author, A sample headline, Sample Site, 3 Sep 2026', 'web with no link: the fields alone')
  assert(!attrib('web-plain-link').noDash && !attrib('web-plain-link').html.includes('qf-source-link'), 'a plain quote with an ordinary link keeps its source line as typed')
  assert(attrib('tw').noDash, 'the dash lead is dropped when the line is rewritten')
  assert(!attrib('tw-nolink')?.html.includes('<a'), 'no link in the source: no link element in the line')
  // Spec 9: a drawn form with no link still gets the parsed fields joined with commas, without the dash lead.
  assert.equal(attrib('book-nolink').html, 'George Lakoff and Mark Johnson, Metaphors We Live By, University of Chicago Press, 1980, page 5', 'book with no link: parsed fields, page 5, no dash')
  assert(attrib('book-nolink').noDash, 'book with no link: no dash lead')
  assert.equal(attrib('vid-nolink').html, 'Sample channel, Sample talk title, at 12:34')
  assert.equal(attrib('plain').html, 'George Lakoff, 1980', 'a plain quote keeps its source line as typed')
  assert(!attrib('plain').noDash, 'a plain quote keeps the dash lead')
  // Links in the form open in a new tab, as the plain quote\'s cite link does.
  for (const id of ['tw', 'vid', 'book', 'paper', 'web', 'web-panel']) {
    assert(/<a class="qf-source-link[^"]*" href="[^"]+" target="_blank" rel="noopener">/.test(handout.share(id)), `${id}: the slide link opens in a new tab`)
    assert(/<a class="qf-source-link" href="[^"]+" target="_blank" rel="noopener">/.test(attrib(id).html), `${id}: the phone link opens in a new tab`)
  }
  // The outer typed quotation marks: dropped from the phone words of a drawn form, as on the slide; plain quotes unchanged.
  assert.equal(handout.phone('quoted-form').find((block) => block.type === 'quote').html, 'Sample ‘inner’ words.', 'drawn form: outer straight marks dropped, inner kept')
  assert.equal(handout.phone('quoted-curly').filter((block) => block.type === 'quote').map((block) => block.html).join('|'), 'First paragraph.|Second paragraph.', 'drawn form: outer curly marks dropped across paragraphs')
  assert.equal(handout.phone('quoted-plain').find((block) => block.type === 'quote').html, '&quot;Sample words.&quot;', 'plain quote: marks stay')
  assert.equal(handout.phone('tw').find((block) => block.type === 'quote').html, words, 'no marks typed: unchanged')
  assert(handout.html.includes('(block.noDash ? "" : "— ")'), 'the runtime honours noDash')
}

// ── 6. The venue and the share page use the same rendering ────────────────────────────────────
{
  const venue = make({ venue: true })
  assert(venue.share('tw').includes(link(X)) && venue.share('tw').includes('qf-static'), 'venue page: static and linked')
  assert(venue.share('paper').includes(link(DOI)), 'venue page: the paper link')
}

// ── 7. No editor placeholder in static output ─────────────────────────────────────────────────
{
  const placeholders = ['tw-awaiting', 'vid-awaiting', 'book-awaiting', 'paper-awaiting']
  const awaiting = `# Talk\n\n## Section\n\n### A {id=tw-awaiting}\n{quote form=tweet}\n\n- ${X}\n\n### B {id=vid-awaiting}\n{quote form=video}\n\n- ${YT}\n\n### C {id=book-awaiting}\n{quote form=book}\n\n- George Lakoff, *Metaphors We Live By*, 1980\n\n### D {id=paper-awaiting}\n{quote form=paper}\n\n- ${turing} ${DOI}\n\n### E {id=tw-noname}\n{quote form=tweet}\n\n> Words.\n\n- ${X.replace('techczech/', 'i/')}\n`
  const p2 = join(dir, 'awaiting.md')
  writeFileSync(p2, awaiting)
  const m2 = await prepareSource(p2, awaiting, 'Talk', statSync(p2), undefined, { allowedAssetRoots: [dir] })
  const d2 = await buildDeckHtmlFromModel(m2)
  assert(/qf-placeholder/.test(d2), 'on stage the placeholders are emitted (hidden, shown only while editing)')
  const out = buildShareHtml({ title: 'Talk', slug: 't', includeNotes: false, license: null, slides: extractSlides(d2), styles: extractStyles(d2) })
  const sections = (out.match(/<section class="slide[\s\S]*?<\/section>/g) ?? []).filter((section) => /data-id="(?:tw-awaiting|vid-awaiting|book-awaiting|paper-awaiting|tw-noname)"/.test(section))
  assert.equal(sections.length, 5)
  for (const section of sections) {
    assert(section.includes('qf-static'), 'static')
    assert(!/qf-placeholder|qf-ph\b|Quoted words go here|Name and handle/.test(section), 'no editor placeholder in a handout, a shared talk or the venue page')
  }
  assert(!placeholders.some((id) => !out.includes(`data-id="${id}"`)), 'every slide is there')
}

// ── 8. The stylesheets ────────────────────────────────────────────────────────────────────────
{
  const skin = readFileSync(new URL('../compiler/assets/styles/skin/quote.css', import.meta.url), 'utf8')
  const layout = readFileSync(new URL('../compiler/assets/styles/layouts/quote.css', import.meta.url), 'utf8')
  assert(/\.qf-static \.qf-source-link \{[^}]*color: var\(--accent\)[^}]*text-decoration: underline[^}]*text-decoration-thickness: \.07em[^}]*text-underline-offset: \.16em[^}]*overflow-wrap: anywhere/.test(skin), 'the link: accent, underlined .07em at .16em, wraps anywhere')
  assert(/\.qf-static \.qf-x-card[^{]*\{ box-shadow: none; \}/.test(skin) && skin.includes('.qf-static .qf-page') && skin.includes('.qf-static .qf-paper.qf-side .qf-panel'), 'shadows removed in the static rendering')
  assert(/\.qf-static \.qf-placeholder \{ display: none !important; \}/.test(skin), 'placeholders are hidden whatever the host')
  assert(skin.includes('.qf-static .qf-web.qf-full .qf-web-pill { width: auto; min-width: 32.2917cqw; }') && skin.includes('.qf-static .qf-web.qf-full .qf-web-host { white-space: normal; overflow: visible; }'), 'the address pill widens to its link and wraps')
  assert(skin.includes('.qf-static .qf-web-win') && skin.includes('.qf-static .qf-web.qf-side .qf-panel'), 'web window and panel shadows are removed in the static rendering')
  const print = skin.slice(skin.indexOf('@media print'))
  assert(print.includes('.qf-static .qf-yt-player { background: #fff; box-shadow: inset 0 0 0 0.157cqw #101418; }'), 'print: player white with a 3 ink outline')
  assert(print.includes('.qf-static .qf-yt-captions span { color: #101418; background: #eceef1; }'), 'print: captions ink on light boxes')
  assert(print.includes('.qf-static .qf-yt-controls { background: none; color: #101418; }') && print.includes('.qf-static .qf-yt-controls .qf-ic { stroke: #101418; }'), 'print: controls in ink')
  assert(print.includes('.qf-static .qf-yt-track { background: #d5d8dd; }'), 'print: track')
  assert(!/qf-yt-played|qf-yt-knob/.test(print), 'print: the red played part is left alone')
  assert(print.includes('.is-dark .qf-static') && print.includes('print-color-adjust: exact'), 'print: dark skin prints light; backgrounds print')
  assert(!/box-shadow: [^i;]*(?:rgba|#)[^;]*;/.test(print.replace(/inset 0 0 0 0\.157cqw #101418/, '')), 'print adds no shadow')
  assert(layout.includes('.qf-yt-link { margin-left: auto;'), 'the video link sits at the right end of the channel row')
}

console.log('quote forms (handout and print): static class, links per form, href rules, phone text, no link, no placeholders, stylesheet rules pass')
