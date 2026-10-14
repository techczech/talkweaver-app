// Quote forms, ticket 01 (the source-styled quote slides design, ADR-0038): the tweet form
// and the machinery every later form uses. Plain Node, no browser (scripts/quote-forms-dom.test.mjs draws it).
//
// Seams under test, in this order:
//   1. the source-line parser (spec 2.3, 2.4 and 5 tables), every form's reader
//   2. detection (spec 3 table, rows 1 to 6) and "an explicit form wins"
//   3. fit steps and the refusal (spec 7), the estimate against the spec's measured capacities
//   4. the compile: the tweet renders as the card, refuses to Plain with quote-form-too-long, awaits words
//      with quote-form-no-words, drops a picture with a hint; Video/Book/Paper/Web still draw as Plain
//   5. the registry: the quote-form group, the generated dictionary's `form` key, trigger validation
//   6. the verbs describe-quote-source, set-quote-form, set-quote-source, and the Inspector's note lines
//   7. the warning registry wording; the palette commands
//   8. every existing quote slide in the sampler and the demo vault renders byte for byte as before
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILT_FORMS, avatarFill, avatarInitials, detectQuoteForm, pageHeadParts, parseSourceLine, quoteFormPlan, readFields,
  countQuoteBlocks, readQuoteSlideLines, renderQuoteForm, resolveQuoteForm, shortenAddressLinks, siteOf, doiTextOfAddress
} from '../compiler/scripts/lib/quote-forms.mjs'
import { plainInlineText } from '../compiler/scripts/lib/00-inline-render.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/triggers.mjs'
import { formatWarning, warningDefinition } from '../compiler/scripts/lib/warning-registry.mjs'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { describeQuoteSource, isQuoteSlide, setQuoteForm, setQuotePicture, setQuoteSource, setFormOnLinkEdit, setFormOnLinkEdits } from '../src/shared/layout-verbs.ts'
import { quoteFormNotes, UNBUILT_FORM_NOTE_FORMS } from '../src/shared/quote-form-notes.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { quoteSlideHashes } from './quote-slide-baseline.mjs'

const tweetFields = (line) => readFields('tweet', parseSourceLine(line))
const X = 'https://x.com/techczech/status/1234567890123456789'

// ── 1. The source line: tweet (spec 2.4, section 5) ───────────────────────────────────────────

{
  const full = tweetFields(`Dominik Lukeš, 4 Oct 2026, 2:33 PM ${X}`)
  assert.equal(full.name, 'Dominik Lukeš')
  assert.equal(full.handle, 'techczech', 'the handle is read from the link')
  assert.equal(full.date, '2:33 PM · 4 Oct 2026', 'a clock time moves first; the parts join with " · "')
  assert.equal(full.initials, 'DL')
  assert.deepEqual(full.missing, [])
  const parsed = parseSourceLine(`Dominik Lukeš, 4 Oct 2026 [the post](${X}) tail`)
  assert.equal(parsed.link.url, X, 'a Markdown link is the link')
  assert(!parsed.raw.includes('undefined') && parsed.segments.every((segment) => !segment.text.includes('http')), 'the link is removed from the text')
  assert.equal(tweetFields(`Dominik Lukeš, 14:33, 4 Oct 2026 ${X}`).date, '14:33 · 4 Oct 2026', 'a 24-hour clock time moves first too')
}
{
  assert.equal(tweetFields('Sample Name (@samplehandle), 1 Jan 2026').handle, 'samplehandle', '(@handle) typed')
  assert.equal(tweetFields('Sample Name (@samplehandle), 1 Jan 2026').name, 'Sample Name', 'the (@handle) is taken out of the name')
  assert.equal(tweetFields('Sample Name @samplehandle, 1 Jan 2026').handle, 'samplehandle', 'a trailing @handle typed')
  assert.equal(tweetFields('Sample Name @samplehandle, 1 Jan 2026').name, 'Sample Name')
  assert.equal(tweetFields(`Typed Name (@typed) ${X}`).handle, 'typed', 'a typed handle wins over the link')
  for (const link of ['https://x.com/i/status/1234567890123456789', 'https://twitter.com/i/web/status/1234567890123456789']) {
    assert.equal(tweetFields(`Dominik Lukeš ${link}`).handle, '', `${link}: "i" is not a handle`)
  }
  assert.deepEqual(tweetFields(`Dominik Lukeš ${X}`).missing, ['date'], 'no date typed: the date is missing')
  assert.equal(tweetFields(`Dominik Lukeš ${X}`).date, '', 'no date row')
  const handleOnly = tweetFields(X)
  assert.equal(handleOnly.displayName, 'techczech', 'a handle with no name stands as the name, without @')
  assert.equal(handleOnly.initials, 'TE', 'one word: its first two letters')
  const nothing = tweetFields('https://x.com/i/status/1234567890123456789')
  assert.equal(nothing.displayName, '', 'neither name nor handle')
  assert.equal(nothing.initials, '')
  assert.equal(nothing.fill, '', 'no avatar to colour')
  assert.deepEqual(nothing.missing, ['name', 'handle', 'date'])
}
{
  assert.equal(avatarInitials('Ada King Lovelace'), 'AL', 'first and last word')
  assert.equal(avatarInitials('Žofie'), 'ŽO', 'one word: its first two letters, upper-cased')
  assert.equal(avatarFill('techczech'), avatarFill('techczech'), 'the fill is stable')
  assert.equal(avatarFill('techczech'), '#0f766e', 'the drawn sample keeps its drawn fill')
  assert.equal(avatarFill('samplehandle'), '#6d47c9')
  const fills = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(avatarFill))
  assert(fills.size > 1 && [...fills].every((fill) => /^#[0-9a-f]{6}$/.test(fill)), 'one of the six palette fills')
}

// ── 1b. The other forms' readers (spec 2.4, the shared machinery) ─────────────────────────────

{
  const video = (line) => readFields('video', parseSourceLine(line))
  const typed = video('Sample channel, Sample talk title goes here, 12:34 / 48:10 https://www.youtube.com/watch?v=XXXXXXXXXXX')
  assert.deepEqual([typed.channel, typed.title, typed.time, typed.length], ['Sample channel', 'Sample talk title goes here', '12:34', '48:10'])
  assert.equal(video('Sample channel, Sample talk title goes here https://youtu.be/XXXXXXXXXXX?t=754').time, '12:34', 'the link\'s t= is the time')
  assert.equal(video('Sample channel, Title, 1:02:03 https://youtu.be/XXXXXXXXXXX?t=754').time, '1:02:03', 'a typed time wins over the link\'s')
  assert.equal(video('C, T https://www.youtube.com/watch?v=XXXXXXXXXXX&start=1h2m3s').time, '1:02:03', '1h2m3s')
  const oneText = video('Only a title https://youtu.be/XXXXXXXXXXX')
  assert.deepEqual([oneText.channel, oneText.title], ['', 'Only a title'], 'one text segment is the title')
  const lengthOnly = video('Sample channel, Title, / 48:10 https://youtu.be/XXXXXXXXXXX')
  assert.deepEqual([lengthOnly.time, lengthOnly.length, lengthOnly.lengthWithoutTime], ['', '', '48:10'], '"/ length" with no time is a length with no time')
  assert.deepEqual(video('Sample channel, Title, 12:34 https://youtu.be/XXXXXXXXXXX').missing, ['length'], 'no length: the time stands alone')
}
{
  const book = readFields('book', parseSourceLine('George Lakoff and Mark Johnson, *Metaphors We Live By*, University of Chicago Press, 1980, p. 5'))
  assert.deepEqual(book.authors, ['George Lakoff', 'Mark Johnson'])
  assert.equal(book.title, 'Metaphors We Live By')
  assert.equal(book.publisher, 'University of Chicago Press')
  assert.equal(book.year, '1980')
  assert.equal(book.page, 'page 5')
  assert.equal(readFields('book', parseSourceLine('A, *T*, P, 1980, pp. 5–9')).page, 'pages 5–9')
  assert.equal(readFields('book', parseSourceLine('A, *T*, P, 1980, ISBN 978-0-226-46801-1')).isbn, '9780226468011', 'the ISBN is read for detection')
  assert.equal(readFields('book', parseSourceLine('A, B, C, D, E')).authors.length >= 1, true)
  const five = readFields('book', parseSourceLine('A One, B Two, C Three, D Four, E Five, *T*, 1980, p. 5'))
  assert.equal(five.authorsDisplay, 'A One, B Two, C Three and 2 more', '4 or more people: first three, then "and N more"')
  assert.equal(readFields('book', parseSourceLine('A One and B Two and C Three, *T*, 1980, p. 5')).authorsDisplay, 'A One, B Two and C Three')
  assert.equal(readFields('book', parseSourceLine('A et al., *T*, 1980, p. 5')).authors.join(), 'A et al.', '"et al." is kept verbatim')
}
{
  const paper = readFields('paper', parseSourceLine('A. M. Turing, "Computing Machinery and Intelligence", *Mind* 59(236), October 1950, pp. 433–460, p. 460 https://doi.org/10.1093/mind/LIX.236.433'))
  assert.deepEqual(
    [paper.title, paper.journal, paper.volume, paper.issue, paper.year, paper.month, paper.pages, paper.page, paper.doi],
    ['Computing Machinery and Intelligence', 'Mind', '59', '236', '1950', 'October', '433–460', '460', '10.1093/mind/LIX.236.433']
  )
  assert.equal(readFields('paper', parseSourceLine('A, "T", *J* vol. 3, no. 4, 2001, pp. 1–9 doi:10.1000/xyz')).volume, '3')
  assert.equal(readFields('paper', parseSourceLine('A, "T", *J*, 2001, pp. 1–9')).page, '', 'a lone pp. N–M is the article range, not the quotation page')
}
{
  const web = (line) => readFields('web', parseSourceLine(line))
  const full = web('Sample Author, "A sample blog post headline that runs to a second line", *Sample Site*, 3 Sep 2026 https://www.samplesite.example/posts/a-sample-post?x=1')
  assert.deepEqual([full.author, full.headline, full.site, full.date, full.domain], ['Sample Author', 'A sample blog post headline that runs to a second line', 'Sample Site', '3 Sep 2026', 'samplesite.example'], 'domain: no www., no path, no query')
  assert.equal(web('Sample Site https://x.example/p').author, 'Sample Site', 'one unmarked segment and no headline is the author')
  assert.equal(web('*Sample Site* https://x.example/p').site, 'Sample Site', 'marked, it is the site')
  assert.equal(web('https://WWW.Example.org:8080/p').domain, 'example.org', 'lower case, no port, no www.')
  assert.equal(web('https://x.example/p').siteShown, 'x.example', 'the domain stands in for the site name')
  assert.equal(web('Author, "Head", Site, 2026-09-03').date, '2026-09-03', 'an ISO date')
  assert.equal(web('Author, "Head", Site, Sep 2026').date, 'Sep 2026')
  assert.equal(web('Author, "Head", Site').link, '', 'no link')
}

// ── 2. Detection (spec 3) ─────────────────────────────────────────────────────────────────────

{
  const detect = (line) => detectQuoteForm(parseSourceLine(line))
  const row = (line) => detect(line).form
  for (const host of ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    assert.equal(row(`Name https://${host}/someone/status/123`), 'tweet', `row 1: ${host}`)
  }
  assert.equal(row('Name https://x.com/i/status/123'), 'tweet', 'row 1: /i/status/')
  assert.equal(row('Name https://x.com/i/web/status/123'), 'tweet', 'row 1: /i/web/status/')
  assert.equal(row('Name https://x.com/someone'), 'plain', 'a profile is an ordinary web link, so Plain at compile')
  assert.equal(row('Name https://x.com/someone/status/abc'), 'plain', 'a non-numeric status is not a post')
  assert.equal(detect(`Name ${X}`).detectedBy, 'x-link')
  for (const link of ['https://www.youtube.com/watch?v=abc', 'https://m.youtube.com/watch?v=abc', 'https://music.youtube.com/watch?v=abc', 'https://youtube.com/live/abc', 'https://youtube.com/shorts/abc', 'https://youtube.com/embed/abc', 'https://youtu.be/abc']) {
    assert.equal(detect(`C, T ${link}`).form, 'video', `row 2: ${link}`)
    assert.equal(detect(`C, T ${link}`).detectedBy, 'youtube-link')
  }
  assert.equal(row('C https://www.youtube.com/channel/abc'), 'plain', 'a channel is an ordinary web link')
  assert.equal(row('C https://www.youtube.com/playlist?list=abc'), 'plain', 'a playlist too')
  for (const line of ['A, "T" https://doi.org/10.1000/xyz', 'A, "T" https://dx.doi.org/10.1000/xyz', 'A, "T" doi:10.1000/xyz', 'A, "T" 10.1000/xyz']) {
    // 2026-10-12: a DOI no longer makes a paper by itself; the editor writes form=paper (section 4b, 8b).
    assert.equal(detect(line).form, 'plain', `row 3: ${line} stays Plain`)
    assert.equal(detect(line).detectedBy, 'none')
    assert.equal(resolveQuoteForm({ token: 'paper', cite: line }).form, 'paper', `row 3: ${line} is a paper when form=paper is written`)
    assert.equal(resolveQuoteForm({ cite: line }).doiLink, true, `row 3: ${line} is offered as a DOI`)
  }
  assert.equal(resolveQuoteForm({ cite: 'A, "T" https://example.org/x' }).doiLink, false, 'an ordinary web link is not a DOI')
  assert.equal(detect('A, *T*, 1980, ISBN 978-0-226-46801-1 https://doi.org/10.1000/xyz').form, 'book', 'an ISBN is still detected from the text, DOI or not')
  assert.equal(detect('A, *T*, 1980, ISBN 978-0-226-46801-1').form, 'book', 'row 4: ISBN anywhere on the line')
  assert.equal(detect('A, *T*, 1980, ISBN 978-0-226-46801-1').detectedBy, 'isbn')
  assert.equal(detect('A, *T*, 1980, p. 5').form, 'book', 'row 5: a marked title, a year and a page')
  assert.equal(detect('A, *T*, 1980, p. 5').detectedBy, 'book-reference')
  assert.equal(row('A, *T*, 1980'), 'plain', 'row 5 is strict: no page, Plain')
  assert.equal(row('A, *T*, p. 5'), 'plain', 'no year, Plain')
  assert.equal(row('A, "T", *J*, 1980, p. 5'), 'plain', 'a quoted title plus a marked journal is not a book (a chapter has the same shape)')
  assert.equal(row('A, "T", *Journal*, 1980, pp. 1–9'), 'plain', 'a paper with no DOI stays Plain')
  assert.equal(row('A, *T*, 1980, p. 5 https://publisher.example/book'), 'book', 'a book reference that also carries a web link stays Book')
  for (const line of ['Source', '', 'Name, 1 Jan 2026', 'Name https://example.org/page', 'Name ftp://example.org/file', 'Name https://example.org/a-post-on-x.com/status/1']) {
    assert.equal(row(line), 'plain', `row 6: "${line}"`)
  }
  assert.notEqual(row('Name https://example.org/page'), 'web', 'Web is never detected (decision 20)')
  assert.equal(detect('Name https://example.org/page').detectedBy, 'none')
}
{
  const forced = (token, cite) => resolveQuoteForm({ token, cite })
  assert.equal(forced('plain', `Name ${X}`).form, 'plain', 'an explicit form wins over the link')
  assert.equal(forced('plain', `Name ${X}`).chosen, true)
  assert.equal(forced('tweet', 'Sample Name (@samplehandle), 1 Jan 2026').form, 'tweet', 'a chosen tweet needs no link')
  assert.equal(forced('auto', `Name ${X}`).chosen, false, 'form=auto is Automatic')
  assert.equal(forced('', `Name ${X}`).form, 'tweet')
  assert.equal(forced('web', 'Author https://example.org/p').form, 'web', 'Web is read from the token')
  assert.equal(forced('nonsense', `Name ${X}`).form, 'tweet', 'an unknown value is Automatic (the trigger validator warns)')
  assert.equal(forced('', 'Name https://example.org/page').webLink, 'example.org', 'webLink: the domain of an ordinary web link')
  assert.equal(forced('', `Name ${X}`).webLink, null, 'an X post is not an ordinary web link')
}

// ── 3. Fit steps and the refusal (spec 7) ─────────────────────────────────────────────────────

{
  // Words of about 5.5 characters give lines that wrap near the spec's measured capacities
  // (293 characters in 6 lines at 57.6, 398 in 7 at 49.92, 516 in 8 at 44.16).
  const words = (n) => {
    const base = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ')
    const out = []
    for (let i = 0; out.join(' ').length < n; i += 1) out.push(base[i % base.length])
    return out.join(' ').slice(0, n).replace(/\s\S*$/, '')
  }
  const plan = (n) => quoteFormPlan({ token: 'tweet', cite: 'N (@n), 1 Jan 2026', paragraphs: [words(n)] })
  assert.equal(plan(20).step, 2, 'short words never grow past the first step (57.6)')
  assert.equal(plan(240).step, 2, '240 characters fit at 57.6')
  assert.equal(plan(330).step, 3, 'past 293 characters: 49.92')
  assert.equal(plan(450).step, 4, 'past 398 characters: 44.16')
  assert.equal(plan(450).renders, true)
  assert.equal(plan(800).renders, false, 'past 516 characters the form refuses')
  assert.equal(plan(800).refused, true)
  assert.equal(plan(800).presentation, 'plain', 'a refused form is drawn as Plain')
  // Wide glyphs are charged their width: ~450 characters of W overflow the card at step 4, so the form refuses.
  const wide = (n) => quoteFormPlan({ token: 'tweet', cite: 'N (@n), 1 Jan 2026', paragraphs: [Array.from({ length: Math.ceil(n / 9) }, () => 'WWWWWWWW').join(' ').slice(0, n)] })
  assert.equal(wide(450).renders, false, 'a 450-character quote of wide glyphs is refused')
  assert.equal(wide(450).refused, true)
  assert.equal(quoteFormPlan({ token: 'tweet', cite: 'N (@n), 1 Jan 2026', paragraphs: [Array.from({ length: 60 }, () => 'iiiiiii').join(' ')] }).renders, true, 'narrow glyphs are not over-charged')
  assert.equal(plan(450).step, 4, 'ordinary prose keeps its step')
  const dateless = quoteFormPlan({ token: 'tweet', cite: 'N (@n)', paragraphs: [words(298)] })
  const dated = quoteFormPlan({ token: 'tweet', cite: 'N (@n), 1 Jan 2026', paragraphs: [words(298)] })
  assert(dateless.step <= dated.step, 'the date row costs height, so a dateless card holds at least as much')
  const none = quoteFormPlan({ token: 'tweet', cite: `N ${X}`, paragraphs: [] })
  assert.equal(none.awaiting, true, 'no words is awaiting')
  assert.equal(none.step, 2, 'no words: the first step')
  assert.equal(none.renders, true, 'an awaiting form still renders')
}

// ── 3b. Addresses shortened to the site (2026-10-12) ──────────────────────────────────────────
{
  for (const [address, site] of [
    ['https://www.youtube.com/watch?v=abc', 'youtube.com'], ['https://doi.org/10.1000/xyz', 'doi.org'], ['http://X.com/someone/status/1', 'x.com'],
    ['https://www.samplesite.example:8080/posts/a?b=1#c', 'samplesite.example'], ['youtu.be/abc', 'youtu.be'], ['samplesite.example', 'samplesite.example'], ['', '']
  ]) assert.equal(siteOf(address), site, `siteOf(${address})`)
  const cite = (href, text) => `Name <a href="${href}" target="_blank" rel="noopener">${text}</a>`
  assert.equal(shortenAddressLinks(cite('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/watch?v=abc')), cite('https://www.youtube.com/watch?v=abc', 'youtube.com'), 'an address as text becomes the site, the href stays whole')
  assert.equal(shortenAddressLinks(cite('https://example.org/a', 'example.org/a')), cite('https://example.org/a', 'example.org'), 'an address typed without its scheme too')
  assert.equal(shortenAddressLinks(cite('https://doi.org/10.1093/mind/LIX.236.433', 'https://doi.org/10.1093/mind/LIX.236.433')), cite('https://doi.org/10.1093/mind/LIX.236.433', 'doi:10.1093/mind/LIX.236.433'), 'a DOI address reads the DOI itself, the href stays whole')
  assert.equal(shortenAddressLinks(cite('http://DX.DOI.ORG/10.1/a%2Fb', 'DX.DOI.ORG/10.1/a%2Fb')), cite('http://DX.DOI.ORG/10.1/a%2Fb', 'doi:10.1/a/b'), 'any host case, dx. too, decoded')
  assert.equal(shortenAddressLinks(cite('https://doi.org/10.1/x', 'My paper')), cite('https://doi.org/10.1/x', 'My paper'), 'a DOI link with the author\'s own text keeps it')
  assert.equal(doiTextOfAddress('https://example.org/doi.org/10.1/x'), '', 'not a DOI address')
  assert.equal(shortenAddressLinks(cite('https://example.org/a', 'A title')), cite('https://example.org/a', 'A title'), 'a link with a title is left alone')
  assert.equal(shortenAddressLinks(cite('#', 'https://example.org/a')), cite('#', 'https://example.org/a'), 'a link that is not an address is left alone')
}

// ── 4. The compile ────────────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'tw-quote-forms-'))
// A real picture for the panel samples: a 1 x 1 PNG.
mkdirSync(join(dir, 'assets'))
writeFileSync(join(dir, 'assets/sample-speaker.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
async function compile(slides) {
  const md = `# Talk\n\n## Section\n\n${slides.join('\n\n')}\n`
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(path, md)
  const model = await prepareSource(path, md, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
  const html = await buildDeckHtmlFromModel(model)
  const section = (id) => html.match(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''
  return { model, html, section, warnings: model.warnings ?? [] }
}
const words = 'Finally a superhuman who never outsources routine tasks they can do themselves to others. Never uses food delivery services, cleaners, fixes their own cars, computers and more. AI agents are only for incompetents like me.'

{
  const { model, section, warnings } = await compile([
    `### A superhuman {id=t-normal}\n{quote}\n\n> ${words}\n\n- Dominik Lukeš, 4 Oct 2026, 2:33 PM ${X}`,
    `### One line {id=t-short}\n{quote form=tweet}\n\n> Sample one-line post.\n\n- Sample Name (@samplehandle), 1 Jan 2026`,
    `### No date {id=t-nodate}\n{quote}\n\n> ${words}\n\n- Dominik Lukeš ${X}`,
    `### Plain {id=t-plain}\n{quote}\n\n> The essence of metaphor.\n\n- George Lakoff and Mark Johnson, 1980`,
    `### Forced plain {id=t-forced-plain}\n{quote form=plain}\n\n> Words.\n\n- Name ${X}`
  ])
  const normal = section('t-normal')
  assert(normal.includes('class="qf qf-tweet"') && normal.includes('data-step="2"'), 'an X link makes the slide the post card')
  assert(normal.includes('<span class="qf-sr">Post on X.</span>'), 'the hidden source-type line')
  assert(normal.includes('<b class="qf-x-name">Dominik Lukeš</b>') && normal.includes('<span class="qf-x-handle">@techczech</span>'))
  assert(normal.includes('<div class="qf-x-time">2:33 PM · 4 Oct 2026</div>'))
  assert(normal.includes('<span class="qf-avatar" style="background:#0f766e" aria-hidden="true">DL</span>'), 'initials on a flat fill, hidden from assistive technology')
  assert(normal.includes('<blockquote class="qf-words"><p>Finally a superhuman'), 'the words are a blockquote with no bold of their own')
  assert(!/<strong|<b>|<em|<i>/.test(normal.replace(/<b class="qf-x-name">[^<]*<\/b>/, '')), 'quoted words are never bold or italic')
  assert(normal.includes('class="qf-x-actions" aria-hidden="true"') && !/qf-x-count/.test(normal), 'icons only, no counts')
  assert.equal((normal.match(/<svg class="qf-ic"/g) || []).length, 5, 'five action icons')
  assert(normal.includes('role="img" aria-label="X"'), 'the X mark carries its label')
  // Icons only from lucide.json, the X mark as one inline SVG.
  const lucide = JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))
  for (const name of ['message-circle', 'repeat-2', 'heart', 'bookmark', 'share']) {
    assert(normal.includes(lucide[name].body), `the ${name} icon is lucide's own paths`)
  }
  assert.equal((normal.match(/<svg class="qf-x-mark"/g) || []).length, 1, 'one inline X mark')
  assert(!normal.includes('Quoted words go here') && !normal.includes('qf-awaiting'), 'a slide with words carries no placeholder')
  const slide = (id) => model.slides.find((s) => s.id === id)
  assert.equal(slide('t-normal').blocks[0].quoteLayout.parts, 1, 'a form is never split')
  assert.equal(model.slides.filter((s) => s.id.startsWith('t-normal')).length, 1)
  const nodate = section('t-nodate')
  assert(nodate.includes('qf-x-actions') && !nodate.includes('qf-x-time'), 'no date: no date row, and nothing takes its place')
  const short = section('t-short')
  assert(short.includes('Sample one-line post.') && short.includes('@samplehandle') && short.includes('data-step="2"'), 'a chosen tweet needs no link; short words stay at the first step')
  assert(!section('t-plain').includes('qf-'), 'a plain quote draws as before')
  assert(section('t-forced-plain').includes('data-quote-chars') && !section('t-forced-plain').includes('qf-tweet'), 'form=plain wins over the link')
  assert.deepEqual(warnings.filter((w) => w.startsWith('quote-form')), [], 'no warning for a good tweet')
  assert(!warnings.some((w) => w.startsWith('unresolved-trigger')), 'form= is a registered trigger')
}
{
  // Too long: the form refuses, the slide is the Plain quote and splits as a Plain quote does.
  const long = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} is here to take up space in the sample post and to push it past what the card can hold at its smallest size.`).join(' ')
  const { model, section, warnings } = await compile([`### Too long {id=t-long}\n{quote form=tweet}\n\n> ${long}\n\n- Sample Name (@samplehandle), 1 Jan 2026`])
  assert(warnings.includes('quote-form-too-long:t-long:Tweet'), `quote-form-too-long (got ${warnings.join(', ')})`)
  assert(!section('t-long').includes('qf-tweet'), 'drawn as the Plain quote')
  const parts = model.slides.filter((s) => s.id === 't-long' || s.id.startsWith('t-long--'))
  assert(parts.length >= 2, 'split across continuation slides as Plain quotes are')
  assert(!warnings.some((w) => w.startsWith('quote-too-long')), 'the plain split fits: no plain too-long warning')
  assert.equal(formatWarning('quote-form-too-long:t-long:Tweet'), 'Quote on slide t-long is too long for the Tweet form at the 44 px minimum. Shorten the quotation, or set the quote form to Plain, which splits a long quote across slides.')
  assert.equal(warningDefinition('quote-form-too-long:t-long:Tweet').severity, 'warning')
  assert.deepEqual(warningDefinition('quote-form-too-long:t-long:Tweet').surfaces, ['strip-badge', 'inspector', 'doctor'])
}
{
  // Awaiting words: a link only, in every shape the spec names.
  const { section, warnings, html } = await compile([
    `### Dash line {id=a-dash}\n{quote}\n\n- https://x.com/i/status/1234567890123456789`,
    `### Bare paragraph {id=a-bare}\n{quote}\n\nhttps://x.com/i/status/1234567890123456789`,
    `### Empty quote line {id=a-empty}\n{quote}\n\n>\n\n- Dominik Lukeš ${X}`,
    `### Handle in the link {id=a-handle}\n{quote form=tweet}\n\n- ${X}`,
    `### Two bullets {id=a-list}\n{quote}\n\n- https://x.com/i/status/1234567890123456789\n- another point`
  ])
  for (const id of ['a-dash', 'a-bare', 'a-empty', 'a-handle']) {
    const markup = section(id)
    assert(markup.includes('qf-tweet qf-awaiting'), `${id}: awaiting words`)
    assert(markup.includes('<div class="qf-placeholder qf-ph qf-ph-words" aria-hidden="true">Quoted words go here</div>'), `${id}: the words placeholder`)
    assert(markup.includes('No words yet.'), `${id}: the hidden line says so`)
    assert(warnings.includes(`quote-form-no-words:${id}`), `${id}: quote-form-no-words`)
    assert(!/<blockquote/.test(markup), `${id}: no empty words element`)
  }
  assert(section('a-dash').includes('qf-avatar-empty qf-placeholder') && section('a-dash').includes('Name and handle'), 'no name and no handle: the empty circle and the name box')
  assert(section('a-handle').includes('qf-x-name">techczech') && !section('a-handle').includes('qf-ph-who'), 'a handle in the link stands as the name; only the words box is drawn')
  assert(!section('a-list').includes('qf-tweet'), 'a real list is not a source line')
  // Presenting shows none of it: the placeholders are hidden unless an ancestor is .qf-authoring.
  assert(/\.qf-placeholder\s*\{\s*display:\s*none;?\s*\}/.test(html), 'placeholders are display:none by default')
  assert(/\.qf-authoring\s+\.qf-placeholder(?:,\s*\[data-tw-preview\]\s+\.qf-placeholder)?\s*\{[^}]*display:\s*flex/.test(html), 'and shown only under .qf-authoring or in an editing preview document')
  assert(!/class="slide[^"]*qf-authoring/.test(html), 'the compiler never marks a slide .qf-authoring')
}
{
  // A picture on a tweet is not drawn. Web is drawn for form=web only; an ordinary link with no token stays Plain.
  const { section, warnings } = await compile([
    `### With a picture {id=p-pic}\n{quote form=tweet}\n\n![Screenshot of the post](assets/missing.png)\n\n> Words.\n\n- Name (@n), 1 Jan 2026`,
    `### Video {id=p-video}\n{quote}\n\n> Spoken words.\n\n- Sample channel, Talk, 12:34 https://youtu.be/XXXXXXXXXXX`,
    `### Web {id=p-web}\n{quote form=web}\n\n> Words.\n\n- Author, "Head", *Site*, 3 Sep 2026 https://example.org/post`,
    `### Web link, no token {id=p-weblink}\n{quote}\n\n> Words.\n\n- Author https://example.org/post`
  ])
  assert(warnings.includes('quote-form-picture-unused:p-pic'), 'hint quote-form-picture-unused')
  assert(section('p-pic').includes('qf-tweet') && !section('p-pic').includes('slide-figure') && !section('p-pic').includes('missing.png'), 'the image is not drawn')
  assert(section('p-web').includes('qf qf-web qf-full'), 'p-web: form=web draws the browser window')
  assert(!section('p-weblink').includes('class="qf') && section('p-weblink').includes('data-quote-chars'), 'p-weblink: an ordinary web link with no form token is the plain quote (spec 3.1)')
  assert.deepEqual(warnings.filter((w) => /^quote-form-(too-long|no-words)/.test(w)), [], 'no warning for these slides')
  assert([...BUILT_FORMS].join() === 'tweet,video,book,paper,web', 'the tweet, the video, the book, the paper and the web page are built')
  assert(section('p-video').includes('qf qf-video qf-full'), 'a YouTube link without a picture is the player')
}
{
  // {title=show} is ignored by a form (hint) and honoured on Plain.
  const { warnings } = await compile([
    `### Shown {id=ts-form}\n{quote form=tweet}{title=show}\n\n> Words.\n\n- Name (@n), 1 Jan 2026`,
    `### Shown plain {id=ts-plain}\n{quote}{title=show}\n\n> Words.\n\n- Name`
  ])
  assert(warnings.includes('quote-form-title-unpainted:ts-form'))
  assert(!warnings.includes('quote-form-title-unpainted:ts-plain'))
}
{
  // A drawn form keeps the quote layout's hidden title whether or not {title=show} is typed; Plain still shows it.
  const { model, section } = await compile([
    `### Shown {id=th-show}\n{quote form=tweet}{title=show}\n\n> Words.\n\n- Name (@n), 1 Jan 2026`,
    `### Shown {id=th-none}\n{quote form=tweet}\n\n> Words.\n\n- Name (@n), 1 Jan 2026`,
    `### Shown {id=th-plain-show}\n{quote}{title=show}\n\n> Words.\n\n- Name`,
    `### Shown {id=th-plain}\n{quote}\n\n> Words.\n\n- Name`
  ])
  const norm = (id) => section(id).replaceAll(id, 'X')
  assert(section('th-show').includes('qf-tweet'), 'the form is drawn')
  assert.equal(model.slides.find((slide) => slide.id === 'th-show').titleMode, '', 'the typed {title=show} is not carried into the drawn form slide')
  assert.equal(norm('th-show'), norm('th-none'), 'a tweet slide carries the same title state with and without {title=show}')
  assert.notEqual(norm('th-plain-show'), norm('th-plain'), 'a plain quote with {title=show} still shows its title')
}
{
  // The renderer reads only what the compiler marked: an unmarked quote block is Plain.
  assert.equal(renderQuoteForm({ type: 'quote', text: 'x', cite: 'y' }, { renderInline: (t) => t, iconBody: () => '' }), null)
}

{
  // A tweet whose source line is only an X link: the handle stands as the name, bold, without "@" (spec 5, the X name row:
  // "handle (without `@`) stands as the name"); the handle position is empty because the link names the author.
  const { section } = await compile([`### Link only {id=t-link-only}\n{quote}\n\n> ${words}\n\n- ${X}`])
  const card = section('t-link-only')
  assert(card.includes('<b class="qf-x-name">techczech</b>'), 'the handle stands as the name')
  assert(!card.includes('qf-x-handle') && !card.includes('@techczech'), 'no handle line and no "@": the name is the handle')
  assert(!card.includes('qf-ph-who'), 'no name placeholder')
}

{
  // The source-line reader: hostile input never throws, never splices, and stays fast (security review finding).
  const tidy = (line) => parseSourceLine(line).segments.map((segment) => segment.text)
  assert.doesNotThrow(() => parseSourceLine('Name \u00015\u0002, "Title" \u00010\u0002'), 'a marker that matches no span does not throw')
  assert.deepEqual(tidy('Name \u00015\u0002, Place'), ['Name 5', 'Place'], 'control characters are stripped, nothing is spliced')
  assert.doesNotThrow(() => parseSourceLine('\u00010\u0002\u00011\u0002\u00019\u0002'))
  assert.deepEqual(tidy('\u00010\u0002\u00011\u0002'), ['01'], 'a line of only markers leaves their digits')
  assert.deepEqual(tidy('A \u0000\u0007\u007f B'), ['A B'])
  for (const hostile of ['*"_'.repeat(16667), '['.repeat(50000), '"'.repeat(50000), '_ '.repeat(25000), '*a'.repeat(25000), `${'(@'.repeat(25000)}`]) {
    const started = performance.now()
    const parsed = parseSourceLine(hostile)
    assert(performance.now() - started < 500, `a ${hostile.length}-character hostile line parses well under a second`)
    assert(parsed.raw.length === hostile.length && JSON.stringify(parsed.segments).length < 20000, 'the reader considers a bounded length')
  }
  const { section } = await compile([`### Hostile name {id=t-script}\n{quote form=tweet}\n\n> Words.\n\n- <script>alert(1)</script> (@evil"><img src=x>), 1 Jan 2026`])
  const card = section('t-script')
  assert(card.includes('qf-tweet'), 'the card is drawn')
  assert(!card.includes('<script>alert') && !card.includes('<img src=x>'), 'markup in a name or handle is not live')
  assert(card.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the name is escaped')
}

// ── 4b. Video (ticket 02): fields, the picture decides, fit, the drawn states ─────────────────

const YT = 'https://www.youtube.com/watch?v=XXXXXXXXXXX'
const videoWords = 'Sample quotation spoken in a video. It runs to two sentences so the design is tested at a realistic length.'
{
  const fields = (line) => readFields('video', parseSourceLine(line))
  assert.equal(fields(`Sample channel, Sample talk title goes here, 12:34 / 48:10 ${YT}`).progress, 26.1, '12:34 of 48:10 is 26.1 per cent')
  assert.equal(fields(`Sample channel, Title, 12:34 ${YT}`).progress, null, 'no length: no progress (an empty bar)')
  assert.equal(fields(`Sample channel, Title ${YT}`).progress, null, 'no time: no progress')
  assert.equal(fields(`Sample channel, Title, / 48:10 ${YT}`).progress, null, 'a length with no time draws as no time')
  assert.equal(fields(`Sample channel, Title, 50:00 / 48:10 ${YT}`).progress, null, 'a time past the length draws no bar')
  assert.equal(fields(`Sample channel, Title, 1:02:03 / 2:04:06 ${YT}`).progress, 50, 'hours')
  assert.equal(fields(`Sample channel, Title https://youtu.be/XXXXXXXXXXX?t=754`).time, '12:34', 'the link\'s t= is the time')
}
{
  // The picture decides (spec 1, decision 6).
  const base = { token: '', cite: `Sample channel, Title, 12:34 / 48:10 ${YT}`, paragraphs: [videoWords] }
  const noPicture = quoteFormPlan({ ...base, picture: false })
  const withPicture = quoteFormPlan({ ...base, picture: true })
  assert.deepEqual([noPicture.presentation, noPicture.step], ['player', 3], 'no picture: the player at 49.92')
  assert.deepEqual([withPicture.presentation, withPicture.step], ['panel', 1], 'a picture: the left panel at 65.28')
  assert.equal(quoteFormPlan({ ...base, token: 'tweet', picture: true }).presentation, 'card', 'a picture does not turn a tweet into a panel')
  // Words that wrap to about the capacities the spec measured (185 · 265 for the player; 217 · 286 · 391 · 489 for the panel).
  const filler = (n) => {
    const base = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ')
    const out = []
    for (let i = 0; out.join(' ').length < n; i += 1) out.push(base[i % base.length])
    return out.join(' ').slice(0, n).replace(/\s\S*$/, '')
  }
  const player = (n) => quoteFormPlan({ ...base, picture: false, paragraphs: [filler(n)] })
  assert.equal(player(150).step, 3, 'player: 150 characters at 49.92')
  assert.equal(player(230).step, 4, 'player: past 185 characters, 44.16')
  assert.equal(player(250).renders, true, 'player: 250 characters still fit at 44.16')
  assert.equal(player(400).refused, true, 'player: past about 265 characters the form refuses')
  assert.equal(player(400).presentation, 'plain')
  const panel = (n, cite = base.cite) => quoteFormPlan({ ...base, cite, picture: true, paragraphs: [filler(n)] })
  assert.equal(panel(200).step, 1, 'panel: 200 characters at 65.28')
  assert.equal(panel(260).step, 2, 'panel: past 217 characters, 57.6')
  assert.equal(panel(350).step, 3, 'panel: past 286 characters, 49.92')
  assert.equal(panel(450).step, 4, 'panel: past 391 characters, 44.16')
  assert.equal(panel(900).refused, true, 'panel: far past the smallest step the form refuses')
  assert(panel(400, `Sample channel, Title ${YT}`).step <= panel(400).step, 'no pill: at least as much room')
  assert.equal(quoteFormPlan({ ...base, picture: false, paragraphs: [] }).step, 3, 'awaiting words: the player\'s step 3')
  assert.equal(quoteFormPlan({ ...base, picture: true, paragraphs: [] }).step, 1, 'awaiting words: the panel\'s first step')
}
{
  const long = 'Sample quotation spoken in a video, in a longer form. It runs to several sentences so the design is tested at a length that needs a smaller size. A third sentence adds more words to the same sample, and a fourth sentence closes the passage.'
  const line = `Sample channel, Sample talk title goes here, 12:34 / 48:10 ${YT}`
  const { model, section, warnings, html } = await compile([
    `### Player {id=v-player}\n{quote}\n\n> ${videoWords}\n\n- ${line}`,
    `### Panel {id=v-panel}\n{quote}\n\n![Speaker on stage](assets/sample-speaker.png)\n\n> ${videoWords}\n\n- ${line}`,
    `### No length {id=v-nolength}\n{quote}\n\n> ${videoWords}\n\n- Sample channel, Sample talk title goes here https://youtu.be/XXXXXXXXXXX?t=754`,
    `### No time {id=v-notime}\n{quote}\n\n> ${videoWords}\n\n- Sample channel, Sample talk title goes here https://youtu.be/XXXXXXXXXXX`,
    `### Panel no time {id=v-panel-notime}\n{quote}\n\n![Speaker on stage](assets/sample-speaker.png)\n\n> ${videoWords}\n\n- Sample channel, Sample talk title goes here https://youtu.be/XXXXXXXXXXX`,
    `### Player long {id=v-player-long}\n{quote}\n\n> ${long}\n\n- ${line}`,
    `### Panel long {id=v-panel-long}\n{quote}\n\n![Speaker on stage](assets/sample-speaker.png)\n\n> ${long}\n\n- ${line}`,
    `### Awaiting {id=v-awaiting}\n{quote}\n\n>\n\n- Sample channel, Sample talk title goes here, 12:34 / 48:10 ${YT}&t=754`,
    `### Title only {id=v-title-only}\n{quote}\n\n> ${videoWords}\n\n- Only a title ${YT}`,
    `### Panel title only {id=v-panel-title-only}\n{quote}\n\n![Speaker](assets/sample-speaker.png)\n\n> ${videoWords}\n\n- Only a title, 3:00 ${YT}`
  ])
  const player = section('v-player')
  assert(player.includes('class="qf qf-video qf-full" data-step="3"'), 'video-player: the player at step 3')
  assert(player.includes('<span class="qf-sr">From a YouTube video.</span>'), 'the hidden source-type line')
  assert(player.includes('<blockquote class="qf-words qf-yt-captions"><p><span>Sample quotation spoken in a video.'), 'the words are the captions')
  assert(player.includes('<p class="qf-yt-title">Sample talk title goes here</p>') && player.includes('<b>Sample channel</b>'), 'title and channel')
  assert(player.includes('<span class="qf-yt-played" style="width:26.1%"></span><span class="qf-yt-knob" style="left:26.1%"></span>'), 'progress at 26.1 per cent')
  assert(player.includes('<span class="qf-yt-time">12:34 / 48:10</span>'), 'time and length')
  assert(player.includes('class="qf-yt-controls" aria-hidden="true"') && player.includes('class="qf-yt-subscribe" aria-hidden="true"') && player.includes('class="qf-yt-likes" aria-hidden="true"'), 'the controls and pills are decoration')
  assert(!/<iframe|<video|<script|src=|href=/.test(player), 'a still slide: nothing plays, no iframe, no link, no network')
  assert(!/<strong|<b>|<em|<i>/.test(player.replace(/<b>Sample channel<\/b>/, '')), 'captions are never bold or italic')
  const lucide = JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))
  for (const name of ['play', 'skip-forward', 'volume-2', 'captions', 'settings', 'maximize', 'thumbs-up', 'thumbs-down']) assert(player.includes(lucide[name].body), `the ${name} icon is lucide's own paths`)
  assert.equal((player.match(/<svg class="qf-ic"/g) || []).length, 8, 'eight lucide icons in the player')
  const panel = section('v-panel')
  assert(panel.includes('class="qf qf-side qf-video" data-step="1"'), 'video-panel: the left panel at step 1')
  assert(/<div class="qf-panel"><img class="qf-picture" src="[^"]+" alt="Speaker on stage">/.test(panel), 'the picture fills the panel, with the author\'s alt text')
  assert(!panel.includes('slide-figure'), 'the picture is drawn once, in the panel')
  assert(panel.includes('<svg class="qf-yt-mark" width="104" height="74" viewBox="0 0 104 74" role="img" aria-label="YouTube">') && panel.includes('<span class="qf-yt-timepill">12:34</span>'), 'the lozenge and the time on the picture')
  assert(panel.includes('style="width:26.1%"'), 'the bar along the picture\'s foot')
  assert(panel.includes('<blockquote class="qf-words"><p>Sample quotation spoken in a video.'), 'the words, regular weight, beside the panel')
  assert(panel.includes('<div class="qf-source-who">Sample channel</div><div class="qf-source-where">Sample talk title goes here</div><div class="qf-pill-row"><span class="qf-pill">at 12:34</span></div>'), 'who, where and the "at" pill')
  assert(section('v-panel').includes('<figcaption class="qf-source">'), 'the source block is the figcaption')
  const nolength = section('v-nolength')
  assert(nolength.includes('<span class="qf-yt-time">12:34</span>') && nolength.includes('<div class="qf-yt-track"></div>'), 'video-player-no-length: the time alone, an empty bar')
  const notime = section('v-notime')
  assert(!notime.includes('qf-yt-time') && notime.includes('<div class="qf-yt-track"></div>') && notime.includes('qf-yt-title'), 'video-player-no-time: no time label, an empty bar')
  const panelNotime = section('v-panel-notime')
  assert(!panelNotime.includes('qf-yt-timepill') && !panelNotime.includes('qf-pill') && panelNotime.includes('qf-yt-mark') && panelNotime.includes('<div class="qf-yt-track"></div>'), 'video-panel-no-time: no pill, no time on the picture, an empty bar')
  assert(section('v-player-long').includes('data-step="4"'), 'video-player-long: step 4')
  assert(section('v-panel-long').includes('data-step="2"'), 'video-panel-long: step 2')
  const awaiting = section('v-awaiting')
  assert(awaiting.includes('qf-awaiting') && awaiting.includes('<div class="qf-yt-captions qf-placeholder qf-ph qf-ph-words" aria-hidden="true">Quoted words go here</div>') && awaiting.includes('From a YouTube video. No words yet.'), 'video-awaiting-words: the dashed box where the captions go')
  assert(!/<blockquote/.test(awaiting) && warnings.includes('quote-form-no-words:v-awaiting'), 'no empty words element, and the warning')
  const titleOnly = section('v-title-only')
  assert(titleOnly.includes('<p class="qf-yt-title">Only a title</p>') && !titleOnly.includes('qf-yt-channel'), 'one text segment is the title; no channel row')
  const panelTitleOnly = section('v-panel-title-only')
  assert(panelTitleOnly.includes('<div class="qf-source-who">Only a title</div>') && !panelTitleOnly.includes('qf-source-where'), 'one text segment: the title takes the who line')
  assert.equal(model.slides.filter((s) => s.id.startsWith('v-player-long')).length, 1, 'a form is never split')
  assert.deepEqual(warnings.filter((w) => /^quote-form/.test(w)), ['quote-form-no-words:v-awaiting'], 'no hint for a good video slide (alt text present)')
  assert(/\.qf-placeholder\s*\{\s*display:\s*none;?\s*\}/.test(html), 'placeholders stay hidden by default')
}
{
  // The hints: a missing alt, and a second picture.
  const { section, warnings } = await compile([
    `### No alt {id=h-noalt}\n{quote}\n\n![](assets/sample-speaker.png)\n\n> Words.\n\n- Sample channel, Title ${YT}`,
    `### Two pictures {id=h-two}\n{quote}\n\n![One](assets/sample-speaker.png)\n\n![Two](assets/sample-speaker.png)\n\n> Words.\n\n- Sample channel, Title ${YT}`,
    `### One picture {id=h-one}\n{quote}\n\n![One](assets/sample-speaker.png)\n\n> Words.\n\n- Sample channel, Title ${YT}`,
    `### Player no picture {id=h-player}\n{quote}\n\n> Words.\n\n- Sample channel, Title ${YT}`,
    `### Too long {id=h-long}\n{quote form=video}\n\n![One](assets/sample-speaker.png)\n\n> ${'word '.repeat(300)}\n\n- Sample channel, Title ${YT}`
  ])
  assert(warnings.includes('quote-form-picture-no-alt:h-noalt'), 'hint quote-form-picture-no-alt')
  assert(!warnings.includes('quote-form-picture-unused:h-noalt'))
  assert(warnings.includes('quote-form-picture-unused:h-two') && !warnings.includes('quote-form-picture-no-alt:h-two'), 'a second picture is not drawn: quote-form-picture-unused')
  assert.equal((section('h-two').match(/class="qf-picture"/g) || []).length, 1, 'one picture is drawn')
  assert.deepEqual(warnings.filter((w) => /^quote-form-picture/.test(w) && /h-(one|player)$/.test(w)), [], 'one picture with alt text, or none: no hint')
  assert(warnings.includes('quote-form-too-long:h-long:Video'), 'a refused video slide is Plain with the warning')
  assert(!section('h-long').includes('qf-video') && !warnings.includes('quote-form-picture-no-alt:h-long'), 'a refused form draws the picture as Plain does, and hints nothing about it')
  assert.equal(formatWarning('quote-form-picture-no-alt:h-noalt'), 'The picture on quote slide h-noalt has no alt text. Describe the picture in the square brackets of the image line.')
  assert.equal(warningDefinition('quote-form-picture-no-alt:h-noalt').severity, 'hint')
}
{
  // Source-derived values reach the markup only escaped.
  const { section } = await compile([`### Hostile {id=v-hostile}\n{quote}\n\n![x"><img src=y>](assets/sample-speaker.png)\n\n> Words.\n\n- <script>alert(1)</script> channel, <b>title</b>, 1:00 / 2:00 ${YT}`])
  const markup = section('v-hostile')
  assert(markup.includes('qf-video') && !markup.includes('<script>alert') && !markup.includes('<img src=y>') && !markup.includes('<b>title</b>'), 'markup in a channel, a title or an alt is not live')
  assert(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt; channel'))
}

// ── 4c. Book (ticket 03): the panel, the made cover, the weights, fit, the drawn states ─────────

const bookWords = 'The essence of metaphor is understanding and experiencing one kind of thing in terms of another.'
const bookLine = 'George Lakoff and Mark Johnson, *Metaphors We Live By*, University of Chicago Press, 1980, p. 5'
{
  // Fit: a book is always the left panel, with or without a picture; the same ladder as the video panel.
  const plan = (paragraphs, cite = bookLine, picture = false) => quoteFormPlan({ token: '', cite, paragraphs, picture })
  assert.deepEqual([plan([bookWords]).form, plan([bookWords]).presentation, plan([bookWords]).step], ['book', 'panel', 1], 'book-no-cover: panel, 65.28')
  assert.equal(plan([bookWords], bookLine, true).presentation, 'panel', 'book-cover: panel')
  const filler = (n) => 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '.repeat(30).slice(0, n).replace(/\s\S*$/, '')
  assert.equal(plan([filler(260)]).step, 2, 'past 217 characters, 57.6')
  assert.equal(plan([filler(450)]).step, 4)
  assert.equal(plan([filler(900)]).refused, true, 'far past the smallest step the form refuses to Plain')
  assert.equal(plan([filler(900)]).presentation, 'plain')
  assert.equal(quoteFormPlan({ token: '', cite: 'A, *T*, 1980', paragraphs: [bookWords] }).form, 'plain', 'title and year, no page: Plain until Book is chosen')
  assert.equal(quoteFormPlan({ token: 'book', cite: 'A, *T*, 1980', paragraphs: [bookWords] }).renders, true, 'chosen: Book draws')
}
{
  const long = 'Sample quotation from a book, in a longer form. It runs to several sentences so the design is tested at a length that needs a smaller size. A third sentence adds more words to the same sample, and a fourth sentence closes the passage.'
  const five = 'Author One, Author Two, Author Three, Author Four, Author Five, *Sample Book Title*, Sample Press, 2024, p. 12'
  const { default: sharp } = await import('sharp')
  await sharp({ create: { width: 310, height: 500, channels: 3, background: '#7a5c3a' } }).png().toFile(join(dir, 'assets/sample-cover.png'))
  const { section, warnings } = await compile([
    `### Cover {id=b-cover}\n{quote}\n\n![Cover of Metaphors We Live By](assets/sample-cover.png)\n\n> ${bookWords}\n\n- ${bookLine}`,
    `### No cover {id=b-nocover}\n{quote}\n\n> ${bookWords}\n\n- ${bookLine}`,
    `### No page {id=b-nopage}\n{quote form=book}\n\n> ${bookWords}\n\n- George Lakoff and Mark Johnson, *Metaphors We Live By*, University of Chicago Press, 1980`,
    `### Long {id=b-long}\n{quote}\n\n> ${long}\n\n- Author One, *Sample Book Title*, Sample Press, 2024, p. 123`,
    `### Many {id=b-many}\n{quote}\n\n> Sample quotation from a book, one sentence long.\n\n- ${five}`,
    `### Title only {id=b-titleonly}\n{quote form=book}\n\n> ${bookWords}\n\n- *Metaphors We Live By*, 1980, p. 5`,
    `### ISBN {id=b-isbn}\n{quote}\n\n> ${bookWords}\n\n- George Lakoff, Metaphors We Live By, ISBN 978-0-226-46801-1`,
    `### Plain {id=b-plain}\n{quote}\n\n> ${bookWords}\n\n- George Lakoff, *Metaphors We Live By*, 1980`,
    `### Two {id=b-two}\n{quote}\n\n> First words.\n\n> Second words.\n\n- ${bookLine}`,
    `### Awaiting {id=b-awaiting}\n{quote form=book}\n\n- ${bookLine}`,
    `### Hostile {id=b-hostile}\n{quote form=book}\n\n> ${bookWords}\n\n- <b>A</b>, *<i>T</i>*, "P" Press, 1980, p. 5`,
    `### Too long {id=b-toolong}\n{quote form=book}\n\n> ${'word '.repeat(300)}\n\n- ${bookLine}`
  ])
  const cover = section('b-cover')
  assert(cover.includes('class="qf qf-side qf-book" data-step="1"'), 'book-cover: the panel at step 1, no made cover; a cover of the panel\'s shape fills it')
  assert(cover.includes('<img class="qf-picture"') && !cover.includes('qf-cover') && !cover.includes('book-generated'), 'the picture fills the panel; no made cover')
  assert(cover.includes('<span class="qf-sr">From a book.</span>'), 'the hidden source-type line')
  assert(cover.includes('<div class="qf-source-who">George Lakoff and Mark Johnson</div><div class="qf-source-where qf-source-title">Metaphors We Live By</div><div class="qf-source-where">University of Chicago Press, 1980</div><div class="qf-pill-row"><span class="qf-pill">page 5</span></div>'), 'the source block: authors, bold title, publisher and year, the page pill')
  assert(cover.includes('<blockquote class="qf-words"><p>The essence of metaphor'), 'the words, regular weight')
  const noCover = section('b-nocover')
  assert(noCover.includes('qf qf-side qf-book book-generated'), 'book-no-cover: the made cover on sand')
  assert(noCover.includes('<div class="qf-cover-wrap" aria-hidden="true"><div class="qf-cover"><span class="qf-cover-spine"></span><span class="qf-cover-title qf-cover-title-l">Metaphors We Live By</span><span class="qf-cover-authors">George Lakoff<br>Mark Johnson</span></div><div class="qf-cover-pub">University of Chicago Press, 1980</div></div>'), 'the made cover: title, authors one per line, publisher and year under it, aria-hidden')
  assert.equal(noCover.split('qf-pill"').length - 1, 1, 'the page pill appears once, in the source block, never on the cover')
  assert(!noCover.includes('<img'), 'no picture')
  const nopage = section('b-nopage')
  assert(nopage.includes('qf-book') && !nopage.includes('qf-pill'), 'book-no-page: chosen, no pill')
  assert(section('b-long').includes('data-step="2"'), 'book-long: step 2')
  const many = section('b-many')
  assert(many.includes('Author One<br>Author Two<br>Author Three<br>and 2 more</span>'), 'book-many-authors: the made cover lists three and the rest')
  assert(many.includes('<div class="qf-source-who">Author One, Author Two, Author Three and 2 more</div>'), 'and so does the who line')
  const titleOnly = section('b-titleonly')
  assert(titleOnly.includes('<div class="qf-source-who qf-source-title">Metaphors We Live By</div>') && !titleOnly.includes('qf-cover-authors'), 'no authors: the title takes the who line, bold')
  assert(section('b-isbn').includes('qf-book'), 'an ISBN is Book under Automatic')
  assert(!section('b-plain').includes('qf-book') && section('b-plain').includes('data-quote-chars'), 'title and year with no page stays Plain')
  assert(section('b-two').includes('First words') && !section('b-two').includes('qf-book'), 'more than one quote stays plain')
  assert(section('b-awaiting').includes('qf-awaiting') && warnings.includes('quote-form-no-words:b-awaiting'), 'awaiting words: source block alone, with the warning')
  const hostile = section('b-hostile')
  assert(!hostile.includes('<b>A</b>') && !hostile.includes('<i>T</i>') && hostile.includes('&lt;b&gt;A&lt;/b&gt;'), 'markup in the source line is escaped')
  assert(warnings.includes('quote-form-too-long:b-toolong:Book') && !section('b-toolong').includes('qf-book'), 'a refused book is Plain with the warning')
  // Weights (decision 13): the quoted words are never bold. No bold markup or weight class inside the words,
  // and the only 700 elements are the title lines.
  for (const id of ['b-cover', 'b-nocover', 'b-nopage', 'b-long', 'b-many', 'b-titleonly']) {
    const words = section(id).match(/<blockquote class="qf-words">[\s\S]*?<\/blockquote>/)?.[0] ?? ''
    assert(words && !/<(b|strong)\b|font-weight|qf-source-title|qf-cover-title/.test(words), `${id}: the words carry no bold markup or weight`)
  }
  const css = readFileSync(new URL('../compiler/assets/styles/skin/quote.css', import.meta.url), 'utf8')
  assert(/\.qf-source-title\s*\{\s*font-weight:\s*700/.test(css) && /\.qf-cover-title\s*\{\s*font-weight:\s*700/.test(css), 'the book title is 700 on the cover and in the source block')
  assert(/\.qf-source-who\s*\{[^}]*font-weight:\s*600/.test(css), 'the author line is 600')
  assert(!/\.qf-side \.qf-words[^{]*\{[^}]*font-weight:\s*[5-9]00/.test(css), 'the words in a side panel stay 400')
  const book = await compile([`### Whole {id=b-whole}\n{quote}\n\n![Square cover](assets/sample-speaker.png)\n\n> ${bookWords}\n\n- ${bookLine}`])
  assert(book.section('b-whole').includes('qf qf-side qf-book qf-cover-whole'), 'a cover far from the panel\'s shape (square) is shown whole on sand (spec 6.6)')
}

// ── 4b. The paper ─────────────────────────────────────────────────────────────────────────────

const paperWords = 'We can only see a short distance ahead, but we can see plenty there that needs to be done.'
const paperLine = 'A. M. Turing, "Computing Machinery and Intelligence", *Mind* 59(236), October 1950, pp. 433–460, p. 460'
const paperDoi = 'https://doi.org/10.1093/mind/LIX.236.433'
const sevenAuthors = 'Author One, Author Two, Author Three, Author Four, Author Five, Author Six, Author Seven, "A sample paper title that is long enough to wrap onto a second and possibly a third line", *Sample Journal*, 2025'
{
  // Detection and plans: Paper is a written form=paper (a DOI alone is Plain, 2026-10-12); the picture decides.
  const plan = (paragraphs, { cite = `${paperLine} ${paperDoi}`, picture = false, token = 'paper' } = {}) => quoteFormPlan({ token, cite, paragraphs, picture })
  assert.deepEqual([plan([paperWords]).form, plan([paperWords]).presentation, plan([paperWords]).step], ['paper', 'page', 3], 'paper-page: the journal page at step 3')
  assert.deepEqual([plan([paperWords]).filler.above, plan([paperWords]).filler.below], [5, 4], 'paper-page: 5 filler lines above and 4 below')
  assert.deepEqual([plan([paperWords], { picture: true }).presentation, plan([paperWords], { picture: true }).step], ['panel', 1], 'paper-panel: a picture makes the left panel')
  assert.equal(plan([paperWords], { cite: paperLine, token: '' }).form, 'plain', 'no DOI: Plain under Automatic')
  assert.equal(plan([paperWords], { token: '' }).form, 'plain', 'a DOI with no form token: Plain, as before quote forms')
  assert.equal(plan([paperWords], { token: 'auto' }).form, 'plain', 'a DOI with form=auto: Plain')
  assert.equal(plan([paperWords], { token: 'plain' }).form, 'plain', 'Plain chosen stays Plain')
  assert.equal(plan([paperWords], { cite: paperLine, token: 'paper' }).renders, true, 'no DOI: Paper chosen draws (paper-no-doi)')
  // Page fit (spec 7): about 179 characters take 6 lines at step 3, about 249 take 7 lines at step 4; filler goes from below first.
  const chars = (n) => Array.from({ length: Math.ceil(n / 6) }, () => 'words').join(' ').slice(0, n)
  assert.equal(plan([chars(150)]).step, 3, 'page: a short passage stays at 49.92')
  assert.equal(plan([chars(235)]).step, 4, 'page: past 6 lines the words step to 44.16')
  assert.deepEqual([plan([chars(235)]).filler.above, plan([chars(235)]).filler.below], [1, 1], 'page: step 4 keeps one filler line above and below')
  // The last rung of the page's fit ladder (2026-10-12): a length that fits only without the grey lines draws without them.
  assert.deepEqual([plan([chars(252)]).fits, plan([chars(252)]).filler.above, plan([chars(252)]).filler.below], [true, 1, 1], 'page: 252 characters still fit with one line above and below')
  const noLines = plan([chars(260)])
  assert.deepEqual([noLines.fits, noLines.renders, noLines.step, noLines.filler.above, noLines.filler.below], [true, true, 4, 0, 0], 'page: 260 characters fit only without the grey lines, at the smallest step')
  assert.equal(plan([chars(324)]).renders, true, 'page: 324 characters are the last length the lines-free page holds')
  assert.equal(plan([chars(330)]).refused, true, 'page: past the lines-free page at the smallest step the form refuses')
  assert.equal(plan([chars(330)]).presentation, 'plain', 'page: refused is drawn as Plain')
  const mid = plan([chars(170)])
  assert(mid.step === 3 && mid.filler.below <= 4 && mid.filler.above <= 5, 'page: filler never grows past 5 and 4')
  // Panel fit is the shared panel ladder with a DOI line.
  assert(plan([chars(300)], { picture: true }).step >= 2, 'panel: 300 characters step down from 65.28')
  assert.equal(plan([chars(900)], { picture: true }).refused, true, 'panel: far too long refuses')
  assert.equal(plan([], { picture: false }).step, 3, 'page, no words: the first step')
  assert.deepEqual([plan([], { picture: false }).filler.above, plan([], { picture: false }).filler.below], [5, 4], 'page, no words: filler only')
}
{
  // Author-list shortening (spec 5): four or more authors read as the first three and `and N more`.
  const paper = readFields('paper', parseSourceLine(sevenAuthors))
  assert.equal(paper.authors.length, 7)
  assert.equal(paper.authorsDisplay, 'Author One, Author Two, Author Three and 4 more')
  assert.equal(readFields('paper', parseSourceLine('A One, B Two, C Three, D Four, "T", *J*, 2020')).authorsDisplay, 'A One, B Two, C Three and 1 more')
  assert.equal(readFields('paper', parseSourceLine('A One, B Two, C Three, "T", *J*, 2020')).authorsDisplay, 'A One, B Two and C Three')
  // The issue line holds the parts present (spec 2.4).
  assert.equal(pageHeadParts(readFields('paper', parseSourceLine(`${paperLine} ${paperDoi}`))).issueLine, 'Volume 59 · Issue 236 · October 1950 · pp. 433–460')
  assert.equal(pageHeadParts(paper).issueLine, '2025', 'only the year: the year alone')
  assert.equal(pageHeadParts(readFields('paper', parseSourceLine('A, "T", *J*, 2001'))).issueLine, '2001')
  assert.equal(pageHeadParts(readFields('paper', parseSourceLine('A, "T", 2001'))).journal, '', 'no journal: no head')
}
{
  const long = 'Sample quotation from a paper, in a longer form. It runs to several sentences so the design is tested at a length that needs a smaller size. A third sentence adds more words to the same sample, and a fourth sentence closes the passage.'
  const longLine = 'Author One, "Sample paper title", *Sample Journal* 12(3), 2025, pp. 100–120, p. 104 https://doi.org/10.0000/sample.2025.123'
  const { default: sharp } = await import('sharp')
  await sharp({ create: { width: 653, height: 1080, channels: 3, background: '#ffffff' } }).png().toFile(join(dir, 'assets/sample-paper-page.png'))
  const { section, warnings } = await compile([
    `### Page {id=pp-page}\n{quote form=paper}\n\n> ${paperWords}\n\n- ${paperLine} ${paperDoi}`,
    `### Panel {id=pp-panel}\n{quote form=paper}\n\n![First page of the paper](assets/sample-paper-page.png)\n\n> ${paperWords}\n\n- ${paperLine} ${paperDoi}`,
    `### Seven page {id=pp-seven}\n{quote form=paper}\n\n> Sample quotation from a paper, one sentence long.\n\n- ${sevenAuthors}`,
    `### Seven panel {id=pp-seven-panel}\n{quote form=paper}\n\n![First page of the paper](assets/sample-paper-page.png)\n\n> Sample quotation from a paper, one sentence long.\n\n- ${sevenAuthors}`,
    `### No DOI {id=pp-nodoi}\n{quote form=paper}\n\n> ${paperWords}\n\n- ${paperLine}`,
    `### Long page {id=pp-long}\n{quote form=paper}\n\n> ${long}\n\n- ${longLine}`,
    `### Long panel {id=pp-long-panel}\n{quote form=paper}\n\n![First page of the paper](assets/sample-paper-page.png)\n\n> ${long}\n\n- ${longLine}`,
    `### Plain {id=pp-plain}\n{quote}\n\n> ${paperWords}\n\n- ${paperLine}`,
    `### DOI only {id=pp-doi-plain}\n{quote}\n\n> ${paperWords}\n\n- ${paperLine} ${paperDoi}`,
    `### Two {id=pp-two}\n{quote form=paper}\n\n> First words.\n\n> Second words.\n\n- ${paperLine} ${paperDoi}`,
    `### Awaiting {id=pp-awaiting}\n{quote form=paper}\n\n- ${paperLine} ${paperDoi}`,
    `### Hostile {id=pp-hostile}\n{quote form=paper}\n\n> ${paperWords}\n\n- <b>A</b>, "<i>T</i>", *<u>J</u>* 1(2), 1980 https://doi.org/10.1000/<x>`,
    `### No lines {id=pp-nolines}\n{quote form=paper}\n\n> ${Array.from({ length: 47 }, () => 'words').join(' ')}\n\n- ${paperLine} ${paperDoi}`,
    `### Beyond lines {id=pp-beyond}\n{quote form=paper}\n\n> ${Array.from({ length: 56 }, () => 'words').join(' ')}\n\n- ${paperLine} ${paperDoi}`,
    `### Too long {id=pp-toolong}\n{quote form=paper}\n\n> ${'word '.repeat(300)}\n\n- ${paperLine} ${paperDoi}`
  ])
  const page = section('pp-page')
  assert(page.includes('class="qf qf-paper qf-full" data-step="3"'), 'paper-page: the page at step 3')
  assert(page.includes('<span class="qf-sr">From a paper.</span>'), 'the hidden source-type line')
  assert(page.includes('<div class="qf-page-head"><b>Mind</b><span>Volume 59 · Issue 236 · October 1950 · pp. 433–460</span></div><p class="qf-page-title">Computing Machinery and Intelligence</p><p class="qf-page-authors">A. M. Turing</p>'), 'the head, title and authors')
  assert(page.includes('<blockquote class="qf-words"><p><mark>We can only see a short distance ahead'), 'the sentence is highlighted')
  assert(page.includes('<footer class="qf-page-foot"><span class="qf-doi">doi:10.1093/mind/LIX.236.433</span><span class="qf-page-number"><span class="qf-sr">page </span>460</span></footer>'), 'the footer holds the DOI and the page')
  const fillers = page.match(/<div class="qf-page-filler" aria-hidden="true">[\s\S]*?<\/div>/g) ?? []
  assert.deepEqual(fillers.map((f) => f.split('<span').length - 1), [5, 4], 'five filler lines above, four below')
  const panel = section('pp-panel')
  assert(panel.includes('class="qf qf-side qf-paper" data-step="1"') && panel.includes('<img class="qf-picture"'), 'paper-panel: the picture fills the left panel')
  assert(panel.includes('<div class="qf-source-who">A. M. Turing</div><div class="qf-source-where">Computing Machinery and Intelligence</div><div class="qf-source-where">Mind 59 (236), 1950</div><div class="qf-pill-row"><span class="qf-pill">page 460</span></div><div class="qf-source-id">doi:10.1093/mind/LIX.236.433</div>'), 'the source block: authors, title, journal line, page pill, DOI line')
  assert(!panel.includes('qf-page'), 'no journal page beside a picture')
  const seven = section('pp-seven')
  assert(seven.includes('Author One, Author Two, Author Three and 4 more') && !seven.includes('qf-page-foot'), 'paper-page-seven-authors: shortened list, no footer')
  assert(seven.includes('<div class="qf-page-head"><b>Sample Journal</b><span>2025</span></div>'), 'only the year: the year alone')
  const sevenPanel = section('pp-seven-panel')
  assert(sevenPanel.includes('<div class="qf-source-who">Author One, Author Two, Author Three and 4 more</div><div class="qf-source-where">A sample paper title') && sevenPanel.includes('<div class="qf-source-where">Sample Journal, 2025</div>') && !sevenPanel.includes('qf-pill') && !sevenPanel.includes('qf-source-id'), 'paper-panel-seven-authors: no pill, no DOI line')
  const noDoi = section('pp-nodoi')
  assert(noDoi.includes('qf-page-foot"><span class="qf-page-number">') && !noDoi.includes('qf-doi'), 'paper-no-doi: the footer keeps the page number only')
  const longPage = section('pp-long')
  assert(longPage.includes('data-step="4"'), 'paper-page-long: step 4')
  assert.deepEqual((longPage.match(/<div class="qf-page-filler" aria-hidden="true">[\s\S]*?<\/div>/g) ?? []).map((f) => f.split('<span').length - 1), [1, 1], 'one filler line above and one below')
  // The last rung (2026-10-12): 47 words (281 characters) fit only without the grey lines; 56 words (335) do not fit at all.
  const noLines = section('pp-nolines')
  assert(noLines.includes('qf qf-paper qf-full') && noLines.includes('data-step="4"') && !noLines.includes('qf-page-filler') && noLines.includes('qf-page-foot'), 'a length that fits only without the lines draws as a paper without them, footer kept')
  assert(!section('pp-beyond').includes('qf-paper') && warnings.includes('quote-form-too-long:pp-beyond:Paper'), 'longer than the lines-free page: refused with the existing warning')
  assert(section('pp-page').includes('qf-page-filler'), 'a short paper keeps its grey lines')
  assert(section('pp-long-panel').includes('class="qf qf-side qf-paper" data-step="2"'), 'paper-panel-long: step 2')
  assert(!section('pp-plain').includes('qf-paper') && section('pp-plain').includes('data-quote-chars'), 'a paper with no DOI stays Plain under Automatic')
  assert(!section('pp-doi-plain').includes('qf-paper') && section('pp-doi-plain').includes('data-quote-chars'), 'a DOI with no form compiles as Plain (2026-10-12)')
  assert(section('pp-two').includes('First words') && !section('pp-two').includes('qf-paper'), 'more than one quote stays plain')
  const awaiting = section('pp-awaiting')
  assert(awaiting.includes('qf-awaiting') && !awaiting.includes('<mark>') && awaiting.includes('qf-placeholder'), 'no words: filler lines only, no highlight, a placeholder for the editing view')
  assert(warnings.includes('quote-form-no-words:pp-awaiting'), 'quote-form-no-words')
  const hostile = section('pp-hostile')
  assert(!/<b>A<\/b>|<i>T<\/i>|<u>J<\/u>/.test(hostile), 'source text is escaped')
  assert(warnings.includes('quote-form-too-long:pp-toolong:Paper') && !section('pp-toolong').includes('qf-paper'), 'a refused paper is Plain with the warning')
  assert(warnings.includes('quote-form-picture-no-alt:pp-panel') === false, 'a picture with alt text raises no hint')
  // Weights (decision 13): the quoted words are never bold, on the page or in the panel.
  for (const id of ['pp-page', 'pp-panel', 'pp-seven', 'pp-seven-panel', 'pp-nodoi', 'pp-long', 'pp-long-panel', 'pp-nolines']) {
    const words = section(id).match(/<blockquote class="qf-words">[\s\S]*?<\/blockquote>/)?.[0] ?? ''
    assert(words && !/<(b|strong)\b|font-weight|qf-source-title|qf-page-title/.test(words), `${id}: the words carry no bold markup or weight`)
  }
  const css = readFileSync(new URL('../compiler/assets/styles/skin/quote.css', import.meta.url), 'utf8')
  assert(/\.qf-page \.qf-words\s*\{[^}]*font-weight:\s*400/.test(css), 'the words on the page are 400')
  assert(!/\.qf-words mark\s*\{[^}]*font-weight:\s*[5-9]00/.test(css) && !/\.qf-paper[^{]*\.qf-words[^{]*\{[^}]*font-weight:\s*[5-9]00/.test(css), 'nothing makes the highlighted words bold')
  assert(/\.is-dark \.qf-page[^{]*\{[^}]*box-shadow:\s*none/.test(css), 'dark skin: the page stays light and loses its shadow')
  assert(!/\.is-dark \.qf-page[^{]*\{[^}]*background/.test(css), 'dark skin: the page keeps its own light colours')
}

// ── 5. The registry ───────────────────────────────────────────────────────────────────────────

{
  const quote = LAYOUTS.find((entry) => entry.name === 'quote')
  const group = quote.options.find((candidate) => candidate.key === 'quote-form')
  assert.equal(group.label, 'Quote form')
  assert.equal(group.preview, 'segmented')
  assert.deepEqual(group.values.map((value) => value.label), ['Automatic', 'Plain', 'Tweet', 'Video', 'Book', 'Paper', 'Web'])
  assert.deepEqual(group.values.map((value) => value.token), ['', 'form=plain', 'form=tweet', 'form=video', 'form=book', 'form=paper', 'form=web'])
  assert.deepEqual(group.dictionaryTokens, ['form=auto'])
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY.form, ['auto', 'plain', 'tweet', 'video', 'book', 'paper', 'web'], 'the generated dictionary has the seven values')
  assert(/five sources|tweet, a video, a book, a paper or a web page/.test(`${quote.description} ${quote.whenItFits}`), 'description and whenItFits mention the sources')
  assert(!LAYOUTS.some((entry) => /tweet|video-quote|book-quote/.test(entry.name) && entry.name !== 'quote'), 'no new entries and no aliases (decision 1)')
  assert.deepEqual(quote.aliases, [])
  for (const value of ['auto', 'plain', 'tweet', 'video', 'book', 'paper', 'web']) {
    assert.deepEqual(parseHeadingAttrs(`T {quote form=${value}}`).warnings, [], `form=${value} validates`)
  }
  assert.deepEqual(parseHeadingAttrs('T {quote form=banana}').warnings, ['unresolved-trigger:form=banana'], 'an unknown form value is unresolved')
  assert.equal(parseHeadingAttrs('T {quote form=tweet}').attrs.form, 'tweet')
  assert.equal(parseHeadingAttrs('T {tweet}').warnings.length > 0, true, 'no bare alias: {tweet} is not a layout')
}

// ── 6. The verbs and the Inspector's notes ────────────────────────────────────────────────────

const outline = (trigger, body) => `---\ntitle: T\n---\n\n# T\n\n## Section\n\n### A quote\n${trigger}{id=q1}\n\n${body}\n`
const describe = (trigger, body) => describeQuoteSource(outline(trigger, body), 'q1')
const notesOf = (description) => quoteFormNotes(description).map((note) => `${note.lead}${note.text}`)
{
  const tweet = describe('{quote}', `> Words.\n\n- Dominik Lukeš, 4 Oct 2026 ${X}`)
  assert.deepEqual(
    { form: tweet.form, chosen: tweet.chosen, detectedBy: tweet.detectedBy, webLink: tweet.webLink, picture: tweet.picture, presentation: tweet.presentation, fits: tweet.fits, missing: tweet.missing },
    { form: 'tweet', chosen: false, detectedBy: 'x-link', webLink: null, picture: false, presentation: 'card', fits: true, missing: [] }
  )
  assert.equal(tweet.fields.handle, 'techczech')
  assert.deepEqual(notesOf(tweet), ['Showing as Tweet. The source line links to a post on x.com.'], 'inspector-automatic-tweet')

  const none = describe('{quote}', '> Words.\n\n- Just a name')
  assert.equal(none.form, 'plain')
  assert.equal(none.detectedBy, 'none')
  assert.deepEqual(notesOf(none), [
    'Showing as Plain. The source line has no link, and no reference that says what kind of source this is.',
    'Choose Tweet, Video, Book, Paper or Web to set it yourself.'
  ], 'inspector-automatic-could-not-tell')

  const webLink = describe('{quote}', '> Words.\n\n- Author https://www.samplesite.example/post')
  assert.equal(webLink.webLink, 'samplesite.example', 'the domain of an ordinary web link, whatever the form')
  assert.deepEqual(notesOf(webLink), ['Showing as Plain.', 'The source line has a web link. Choose Web to show it as a web page.'], 'inspector-plain-with-web-link')

  const plain = describe('{quote form=plain}', `> Words.\n\n- Name ${X}`)
  assert.deepEqual([plain.form, plain.chosen, plain.token], ['plain', true, 'plain'])
  assert.deepEqual(notesOf(plain), ['Always the plain quote, whatever the source line holds.'], 'inspector-plain')

  const chosen = describe('{quote form=tweet}', '> Words.\n\n- Sample Name (@samplehandle), 1 Jan 2026')
  assert.deepEqual([chosen.form, chosen.chosen, chosen.detectedBy], ['tweet', true, 'none'])
  assert.deepEqual(notesOf(chosen), ['Always a tweet. Name, handle and date are read from the source line.'], 'inspector-tweet')

  // Unbuilt forms say so in one plain sentence, chosen or found.
  const foundBook = describe('{quote}', '> Words.\n\n- A One, *Title*, Press, 1980, p. 5')
  assert.deepEqual([foundBook.form, foundBook.unbuilt, foundBook.presentation], ['book', false, 'panel'])
  assert.deepEqual(notesOf(foundBook), ['Showing as Book. The source line has a title in asterisks, a year and a page.', 'No picture on this slide: a cover is made from the title and authors.'])
  assert.deepEqual(notesOf(describe('{quote}', '![Cover](assets/s.png)\n\n> Words.\n\n- A One, *Title*, Press, 1980, p. 5')), ['Showing as Book. The source line has a title in asterisks, a year and a page.', 'Picture on this slide: it fills the left panel as the cover.'], 'inspector-automatic-book')
  assert.deepEqual(notesOf(describe('{quote form=book}', '> Words.\n\n- A, *T*, 1980')), ['Always a book. Authors, title, publisher, year and page are read from the source line.', 'No picture on this slide: a cover is made from the title and authors.'], 'inspector-book')
  assert.equal(describe('{quote}', '> Words.\n\n- A, *T*, 1980').form, 'plain', 'a title and year with no page stays Plain under Automatic')
  assert.deepEqual(notesOf(describe('{quote form=paper}', '> Words.\n\n- A')), ['Always a paper. Authors, title, journal, year and page are read from the source line.', 'No picture on this slide: the journal page.'], 'inspector-paper')
  const doiLine = '- A One, "Title", *Journal* 1(2), 1980 https://doi.org/10.1000/xyz'
  const plainDoi = describe('{quote}', `> Words.\n\n${doiLine}`)
  assert.deepEqual([plainDoi.form, plainDoi.chosen, plainDoi.doiLink, plainDoi.webLink, plainDoi.presentation], ['plain', false, true, null, 'plain'], 'a DOI with no form is Plain (2026-10-12)')
  assert.deepEqual(notesOf(plainDoi), ['Showing as Plain.', 'The source line has a DOI. Choose Paper to show it as a paper.'], 'inspector-plain-with-doi')
  assert.equal(notesOf(plainDoi)[0], notesOf(describe('{quote}', '> Words.\n\n- Sample Author https://example.org/page'))[0], 'the same lead as a plain quote with a web link')
  const foundPaper = describe('{quote form=paper}', `> Words.\n\n${doiLine}`)
  assert.deepEqual([foundPaper.form, foundPaper.chosen, foundPaper.unbuilt, foundPaper.presentation], ['paper', true, false, 'page'])
  assert.deepEqual(notesOf(foundPaper), ['Set when you added the DOI.', 'No picture on this slide: the journal page.'], 'inspector-paper-set-on-doi')
  assert.deepEqual(notesOf(describe('{quote form=paper}', '![Page](assets/s.png)\n\n> Words.\n\n' + doiLine)), ['Set when you added the DOI.', 'Picture on this slide: it fills the left panel.'], 'the picture decides: the left panel')
  assert.equal(describe('{quote}', '> Words.\n\n- A One, "Title", *Journal* 1(2), 1980').form, 'plain', 'a paper with no DOI stays Plain under Automatic')
  assert.deepEqual(notesOf(describe('{quote form=web}', '> Words.\n\n- A')), ['Always a web page. Site, headline, author and date are read from the source line.', 'No picture on this slide: the page in a browser window.'], 'inspector-web')
  const found = describe('{quote}', '> Words.\n\n- C, T https://youtu.be/XXXXXXXXXXX')
  assert.equal(found.form, 'video')
  assert.equal(found.unbuilt, false, 'the video form is built')
  assert.equal(found.presentation, 'player', 'no picture: the player')
  assert.deepEqual(notesOf(found), ['Showing as Video. The source line links to YouTube.', 'No picture on this slide: the YouTube player. Add a screenshot of the speaker to get the left panel.'], 'inspector-automatic-video')
  const withPicture = describe('{quote form=video}', '![Speaker on stage](assets/s.png)\n\n> Words.\n\n- C, T https://youtu.be/XXXXXXXXXXX')
  assert.deepEqual([withPicture.picture, withPicture.presentation], [true, 'panel'], 'the picture decides: the left panel')
  assert.deepEqual(notesOf(withPicture), ['Always a video. Channel, title and time are read from the source line.', 'Picture on this slide: it fills the left panel.'], 'inspector-video')
  assert.equal(describe('{quote}', '> Words.\n\n- C, T https://youtu.be/XXXXXXXXXXX\n\n![After](assets/s.png)').presentation, 'panel', 'a picture after the quotation counts too')

  // Picture, awaiting words, a refusal.
  const picture = describe('{quote form=tweet}', '![Screenshot of the post](assets/p.png)\n\n> Words.\n\n- Name (@n)')
  assert.equal(picture.picture, true)
  assert(notesOf(picture).some((line) => line.includes('a tweet takes no picture')))
  assert.equal(describe('{quote}', `- ${X}`).awaitingWords, true)
  assert.equal(describe('{quote}', `- ${X}`).form, 'tweet', 'a link-only slide is read as its source line')
  const refused = describe('{quote form=tweet}', `> ${'word '.repeat(200)}\n\n- Name (@n)`)
  assert.equal(refused.fits, false)
  assert.equal(refused.refused, true)
  assert.equal(refused.presentation, 'plain')
  assert(notesOf(refused)[1].includes('too long'))
  assert.throws(() => describeQuoteSource(`# T\n\n## S\n\n### A\n{statement}{id=q1}\n\n- x\n`, 'q1'), /not a quote slide/, 'a slide that is not a quote has no quote source')
}
{
  // set-quote-form: a thin name over set-layout-option; auto removes the token.
  const base = outline('{quote}', `> Words.\n\n- Name ${X}`)
  const tweet = setQuoteForm(base, 'q1', 'tweet')
  assert(/form=tweet/.test(tweet.triggerLine), `form=tweet written (${tweet.triggerLine})`)
  assert(tweet.outline.includes('> Words.') && tweet.outline.includes(X), 'nothing else changes')
  assert.equal(describeQuoteSource(tweet.outline, 'q1').chosen, true)
  const plain = setQuoteForm(tweet.outline, 'q1', 'plain')
  assert(/form=plain/.test(plain.triggerLine) && !/form=tweet/.test(plain.triggerLine), 'one form token at a time')
  const auto = setQuoteForm(plain.outline, 'q1', 'auto')
  assert(!/form=/.test(auto.triggerLine), 'auto removes the token')
  assert.equal(auto.outline, base, 'the round trip is byte for byte')
  assert.equal(setQuoteForm(base, 'q1', 'auto').outline, base, 'auto on an Automatic slide writes nothing')
  assert.throws(() => setQuoteForm(base, 'q1', 'banana'), /unknown quote form/)
  assert.throws(() => setQuoteForm(base, 'nope', 'tweet'), /slide not found/)
  assert.throws(() => setQuoteForm(`# T\n\n## S\n\n### A\n{statement}{id=q1}\n\n- x\n`, 'q1', 'tweet'), /option|quote|applicable/i, 'not offered on a slide that is not a quote')
}
{
  // A quote-only slide with no `{quote}` token is a quote slide for the verbs too: the compiler gives it the layout
  // (08-source-adapters inferLayout), the editor passes that compiled layout in (a projection row's `layout`), and
  // `{form=…}` alone keeps the inference, so nothing but the form token is written.
  const body = `> Words.\n\n- Name ${X}\n`
  const doc = (slide) => `# T\n\n## Section\n\n${slide}\n`
  const compiledLayout = async (slide, id) => (await compile([slide])).model.slides.find((candidate) => candidate.id === id)?.layout
  const bare = doc(`### A quote\n\n${body}`)
  const idOnly = doc(`### A quote\n{id=q1}\n\n${body}`)
  for (const [label, base, ref, layout] of [
    ['no trigger line', bare, { headingLine: 5 }, await compiledLayout(`### A quote {id=q1}\n\n${body}`, 'q1')],
    ['an {id} line only', idOnly, 'q1', await compiledLayout(`### A quote\n{id=q1}\n\n${body}`, 'q1')]
  ]) {
    assert.equal(layout, 'quote', `${label}: the compiler gives the slide the quote layout`)
    assert.equal(isQuoteSlide(base, ref), false, `${label}: with no compiled layout there is no authored layout to go on`)
    assert.equal(isQuoteSlide(base, ref, layout), true, `${label}: a quote-only slide is a quote slide`)
    assert.equal(isQuoteSlide(base, ref, 'list'), false, `${label}: the compiled layout decides`)
    const description = describeQuoteSource(base, ref, layout)
    assert.deepEqual([description.form, description.chosen, description.detectedBy], ['tweet', false, 'x-link'], `${label}: the form the compiled slide detects`)
    assert.deepEqual(notesOf(description), ['Showing as Tweet. The source line links to a post on x.com.'], `${label}: the Inspector's notes`)
    let text = base
    for (const form of ['tweet', 'auto', 'plain', 'tweet', 'web', 'auto', 'video', 'book', 'paper', 'auto']) {
      text = setQuoteForm(text, ref, form, layout).outline
      const line = text.split('\n').find((candidate) => /^\{.*\}$/.test(candidate)) ?? ''
      if (form === 'auto') assert.equal(text, base, `${label}: Automatic returns the outline byte for byte`)
      else assert(line.includes(`form=${form}`) && !line.includes('{quote'), `${label}: ${form} writes only the form token (${line})`)
      assert.equal(describeQuoteSource(text, ref, layout).token, form === 'auto' ? '' : form, `${label}: ${form} is read back`)
    }
    // The line `{form=…}` leaves is still a quote slide to the compiler.
    const { triggerLine } = setQuoteForm(base, ref, 'tweet', layout)
    const written = await compile([`### A quote${triggerLine.includes('id=') ? '' : ' {id=q1}'}\n${triggerLine}\n\n${body}`])
    assert.equal(written.model.slides.find((candidate) => candidate.id === 'q1')?.layout, 'quote', `${label}: ${triggerLine} keeps the quote layout`)
    assert(written.section('q1').includes('qf-tweet'), `${label}: and draws the card`)
    assert.throws(() => setQuoteForm(base, ref, 'tweet'), /not a quote slide/, `${label}: without the compiled layout the command is refused as before`)
  }
  const list = doc('### A list\n\n- a\n- b')
  assert.equal(isQuoteSlide(list, { headingLine: 5 }, await compiledLayout('### A list {id=q1}\n\n- a\n- b', 'q1')), false, 'a list slide is not a quote slide')
  assert.equal(isQuoteSlide(doc('### S\n{statement}\n\n> Words.'), { headingLine: 5 }, 'quote'), false, 'an authored layout other than quote wins over the compiled one')
  assert.throws(() => setQuoteForm(list, { headingLine: 5 }, 'tweet', 'list'), /not a quote slide/)
  // The one-token line really does keep the compiled layout: the card draws from `{form=tweet}` alone.
  const { section } = await compile([`### Inferred {id=i-tweet}\n{form=tweet}\n\n> Words.\n\n- Name (@n), 1 Jan 2026`, `### Inferred plain {id=i-plain}\n{form=plain}\n\n> Words.\n\n- Name ${X}`])
  assert(section('i-tweet').includes('qf-tweet'), '{form=tweet} alone keeps the quote layout and draws the card')
  assert(section('i-plain').includes('data-quote-chars') && !section('i-plain').includes('qf-tweet'), '{form=plain} alone is the plain quote')
}
{
  // With no source line, the compiler hands the slide title to the quotation as its citation (applyQuoteTitleAttribution)
  // before the form is decided; the verb reads the same title, so the notes and the compiled slide agree.
  const titled = `# T\n\n## Section\n\n### Post by Name ${X} {id=q1}\n{quote}\n\n> Words.\n`
  const description = describeQuoteSource(titled, 'q1')
  assert.deepEqual([description.form, description.detectedBy], ['tweet', 'x-link'], 'the slide title is the citation and decides the form')
  const { section } = await compile([`### Post by Name ${X} {id=t-title}\n{quote}\n\n> Words.`])
  assert(section('t-title').includes('qf-tweet'), 'the compiled slide is the Tweet the verb reports')
  const own = describeQuoteSource(`# T\n\n## Section\n\n### Post by Name ${X} {id=q1}\n{quote}\n\n> Words.\n\n- Someone Else\n`, 'q1')
  assert.deepEqual([own.form, own.detectedBy], ['plain', 'none'], 'a source line of its own wins over the title')
  const plainTitle = describeQuoteSource(`# T\n\n## Section\n\n### Just a title {id=q1}\n{quote}\n\n> Words.\n`, 'q1')
  assert.deepEqual([plainTitle.form, plainTitle.detectedBy], ['plain', 'none'])
}
{
  // set-quote-source keeps the link in whatever shape it has: a Markdown link, a bare URL, `doi:` or a bare DOI,
  // verbatim when only the text changes, and replaced as a whole when a link is given.
  const NEW = 'https://example.org/new-link'
  for (const link of [`[post](${X})`, X, 'doi:10.1234/foo', '10.1234/foo']) {
    const base = outline('{quote}', `> Words.\n\n- Old Name ${link}`)
    assert(setQuoteSource(base, 'q1', { text: 'Changed' }).outline.includes(`\n- Changed ${link}\n`), `text changes, ${link} kept verbatim`)
    const replaced = setQuoteSource(base, 'q1', { link: NEW }).outline
    assert(replaced.includes(`\n- Old Name ${NEW}\n`), `${link} is replaced as a whole by a new link (${replaced.split('\n').find((l) => l.startsWith('- ')) })`)
    assert(setQuoteSource(base, 'q1', { text: 'Changed', link: NEW }).outline.includes(`\n- Changed ${NEW}\n`))
  }
}
{
  // set-quote-source: writes the source line in the spec 2.4 shape; creates it when there is none.
  const base = outline('{quote}', '> Words.\n\n- Old Name, 1 Jan 2020')
  const linked = setQuoteSource(base, 'q1', { link: X })
  assert(linked.outline.includes(`- Old Name, 1 Jan 2020 ${X}`), 'the link joins the existing text')
  assert.equal(linked.formSet, null)
  const retyped = setQuoteSource(linked.outline, 'q1', { text: 'Dominik Lukeš, 4 Oct 2026' })
  assert(retyped.outline.includes(`- Dominik Lukeš, 4 Oct 2026 ${X}`), 'the text changes and the link stays')
  assert.equal(describeQuoteSource(retyped.outline, 'q1').form, 'tweet')
  const created = setQuoteSource(outline('{quote}', '> Words.'), 'q1', { text: 'Name (@n)', link: X })
  assert(created.outline.includes(`> Words.\n\n- Name (@n) ${X}`), 'creates the line after the quotation')
  const dashed = setQuoteSource(outline('{quote}', '> Words.\n\n— Old'), 'q1', { text: 'New' })
  assert(dashed.outline.includes('— New'), 'an em dash source line keeps its dash')
  assert.throws(() => setQuoteSource(base, 'q1', { text: 'two\nlines' }), /one line/)
  assert.equal(readQuoteSlideLines(['> A', '> — Cite']).source.kind, 'quote-dash')
}
{
  // The Inspector's note lines are at most two (the fetch block of ticket 06 sits under them).
  for (const [trigger, body] of [['{quote}', `> W\n\n- N ${X}`], ['{quote}', '> W\n\n- N'], ['{quote form=video}', '> W\n\n- N https://youtu.be/XXXXXXXXXXX'], ['{quote}', '> W\n\n- N https://youtu.be/XXXXXXXXXXX']]) {
    assert(quoteFormNotes(describe(trigger, body)).length <= 2)
  }
}

{
  // set-quote-picture: add, replace, remove; the picture decides the presentation.
  const base = outline('{quote}', `> Words.\n\n- Sample channel, Title ${YT}`)
  assert.equal(describeQuoteSource(base, 'q1').presentation, 'player')
  const added = setQuotePicture(base, 'q1', 'assets/speaker.png', 'Speaker on stage')
  assert(added.outline.includes('{quote}{id=q1}\n\n![Speaker on stage](assets/speaker.png)\n\n> Words.'), 'the picture line goes before the quotation')
  assert.equal(describeQuoteSource(added.outline, 'q1').presentation, 'panel', 'adding a picture switches to the left panel')
  const replaced = setQuotePicture(added.outline, 'q1', 'assets/other.png')
  assert(replaced.outline.includes('![Speaker on stage](assets/other.png)'), 'a replaced path keeps the alt text')
  assert(setQuotePicture(added.outline, 'q1', 'assets/other.png', 'New alt').outline.includes('![New alt](assets/other.png)'), 'an alt given replaces the old one')
  const removed = setQuotePicture(replaced.outline, 'q1', null)
  assert.equal(removed.outline, base, 'removing the picture restores the outline byte for byte')
  assert.equal(describeQuoteSource(removed.outline, 'q1').presentation, 'player', 'removing it returns to the player')
  assert.equal(setQuotePicture(base, 'q1', null).outline, base, 'removing a picture that is not there writes nothing')
  const after = outline('{quote}', `> Words.\n\n- Sample channel, Title ${YT}\n\n![After](assets/a.png)`)
  assert(setQuotePicture(after, 'q1', null).outline.includes(`- Sample channel, Title ${YT}\n`) && !setQuotePicture(after, 'q1', null).outline.includes('![After]'), 'a picture after the quotation is found and removed')
  assert(setQuotePicture(after, 'q1', 'assets/b.png').outline.includes('![After](assets/b.png)'), 'and replaced in place')
  const crlf = base.replace(/\n/g, '\r\n')
  assert(setQuotePicture(crlf, 'q1', 'assets/s.png', 'A').outline.includes('![A](assets/s.png)\r\n'), 'line endings are kept')
  assert.throws(() => setQuotePicture(base, 'q1', 'a\nb'), /one line/)
  assert.throws(() => setQuotePicture(base, 'q1', 'a).png'), /path/)
  assert.throws(() => setQuotePicture(`# T\n\n## S\n\n### A\n{statement}{id=q1}\n\n- x\n`, 'q1', 'a.png'), /not a quote slide/)
  assert(setQuotePicture(base, 'q1', 'assets/x.png', 'Evil ] [alt').outline.includes('![Evil  alt](assets/x.png)'), 'brackets in an alt are dropped')
  // A quote-only slide (no {quote} token) is admitted through the compiled layout, as setQuoteSource is.
  const bare = outline('', `> Words.\n\n- Sample channel, Title ${YT}`)
  const bareAdded = setQuotePicture(bare, 'q1', 'assets/speaker.png', 'Speaker', 'quote')
  assert(bareAdded.outline.includes('{id=q1}\n\n![Speaker](assets/speaker.png)\n\n> Words.'), 'a quote-only slide takes the picture line when the compiled layout is quote')
  assert.equal(setQuotePicture(bareAdded.outline, 'q1', null, undefined, 'quote').outline, bare, 'removing the picture restores a quote-only outline byte for byte')
  assert.throws(() => setQuotePicture(bare, 'q1', 'assets/speaker.png', 'Speaker'), /not a quote slide/, 'without the compiled layout a quote-only slide is still refused')
}

// ── 6b. The web page (ticket 07): fit, the drawn states, the link-edit rule, the verbs, the notes ─────────────────

const WEB = 'https://www.samplesite.example/posts/a-sample-post'
const webHead = 'A sample blog post headline that runs to a second line'
const webFull = `Sample Author, "${webHead}", *Sample Site*, 3 Sep 2026 ${WEB}`
const webWords = 'Sample quotation from a blog post. It runs to two sentences so the design is tested at a realistic length.'
const webLong = 'Sample long quotation from a blog post. It runs to four sentences so that the design is tested with a passage of the length people really quote from articles. This is the third sentence of the sample. And this is the fourth, which brings it to about three hundred characters.'
{
  // Fit (spec 7, 17.2): the window ladder 57.6 → 49.92 → 44.16 against 940; the panel is the shared ladder.
  const plan = (paragraphs, { cite = webFull, picture = false, token = 'web' } = {}) => quoteFormPlan({ token, cite, paragraphs, picture })
  const filler = 'It runs to two sentences so the design is tested at a realistic length. '
  const chars = (n) => filler.repeat(Math.ceil(n / filler.length)).slice(0, n).trim()
  assert.deepEqual([plan([webWords]).presentation, plan([webWords]).step], ['window', 2], 'web-normal: the window at 57.6')
  assert.deepEqual([plan([webWords], { picture: true }).presentation, plan([webWords], { picture: true }).step], ['panel', 1], 'web-panel: the left panel at 65.28')
  assert.equal(plan([webLong]).step, 3, 'web-long: the 275-character sample takes 49.92 (945 high at 57.6)')
  assert.equal(plan([webLong], { picture: true }).step, 2, 'web-panel-long: step 2')
  // The spec's measured capacities (258 · 364 · 480 with a one-line headline and a byline, 258 · 364 · 412 with two lines,
  // 359 · 547 · 680 with only the link) were measured with other filler; this filler steps at the same places within 5%.
  for (const [n, step] of [[250, 2], [340, 3], [450, 4]]) assert.equal(plan([chars(n)]).step, step, `window, one-line headline: ${n} characters at step ${step}`)
  assert.equal(plan([chars(500)]).refused, true, 'window: past 7 lines at the smallest step the form refuses')
  const twoLines = `Sample Author, "A sample blog post headline that is long enough to run on to a second line of the page", *Sample Site*, 3 Sep 2026 ${WEB}`
  assert.equal(plan([chars(390)], { cite: twoLines }).step, 4, 'a two-line headline: six lines hold at 44.16')
  assert.equal(plan([chars(450)], { cite: twoLines }).refused, true, 'a two-line headline: the text that fits under a one-line headline does not')
  for (const [n, step] of [[350, 2], [500, 3], [650, 4]]) assert.equal(plan([chars(n)], { cite: WEB }).step, step, `only the link: ${n} characters at step ${step}`)
  assert.equal(plan([chars(720)], { cite: WEB }).refused, true, 'only the link: past 10 lines the form refuses')
  assert.equal(plan([], { picture: false }).step, 2, 'no words: the first step')
  assert.equal(plan([chars(900)], { picture: true }).refused, true, 'panel: far too long refuses')
  // Web is read from the token only.
  assert.equal(plan([webWords], { token: '' }).form, 'plain', 'no token: Plain')
  assert.equal(plan([webWords], { token: 'auto' }).form, 'plain', 'form=auto: Plain')
  // Fields the drawing needs: the lock, the masthead pair, the avatar.
  const f = readFields('web', parseSourceLine(webFull))
  assert.deepEqual([f.secure, f.mark, f.fill, f.tint, f.authorInitials, f.authorFill], [true, 'S', '#0f4bd8', '#e7edfb', 'SA', '#0f766e'], 'the drawn sample: lock, S on blue, SA on teal')
  assert.equal(readFields('web', parseSourceLine(`Author, "Head" http://old.example/p`)).secure, false, 'an http link never shows the lock')
  assert.equal(readFields('web', parseSourceLine(WEB)).secure, false, 'only the link: the globe')
}
{
  const { section, warnings } = await compile([
    `### Normal {id=w-normal}\n{quote form=web}\n\n> ${webWords}\n\n- ${webFull}`,
    `### Panel {id=w-panel}\n{quote form=web}\n\n![Screenshot of the post](assets/sample-speaker.png)\n\n> ${webWords}\n\n- ${webFull}`,
    `### Long {id=w-long}\n{quote form=web}\n\n> ${webLong}\n\n- ${webFull}`,
    `### Panel long {id=w-panel-long}\n{quote form=web}\n\n![Screenshot of the post](assets/sample-speaker.png)\n\n> ${webLong}\n\n- ${webFull}`,
    `### Only link {id=w-only}\n{quote form=web}\n\n> ${webWords}\n\n- ${WEB}`,
    `### Panel only link {id=w-panel-only}\n{quote form=web}\n\n![Screenshot of the post](assets/sample-speaker.png)\n\n> ${webWords}\n\n- ${WEB}`,
    `### No author {id=w-no-author}\n{quote form=web}\n\n> ${webWords}\n\n- "${webHead}", *Sample Site* ${WEB}`,
    `### Panel no author {id=w-panel-no-author}\n{quote form=web}\n\n![Screenshot of the post](assets/sample-speaker.png)\n\n> ${webWords}\n\n- "${webHead}", *Sample Site*, 3 Sep 2026 ${WEB}`,
    `### Long headline {id=w-long-head}\n{quote form=web}\n\n> ${webWords}\n\n- Sample Author, "A sample blog post headline that is long enough to run on to a second line of the page", *Sample Site*, 3 Sep 2026 ${WEB}`,
    `### Awaiting {id=w-awaiting}\n{quote form=web}\n\n- ${webFull}`,
    `### No link {id=w-no-link}\n{quote form=web}\n\n> ${webWords}\n\n- Sample Author, "${webHead}", *Sample Site*, 3 Sep 2026`,
    `### No link no site {id=w-no-link-no-site}\n{quote form=web}\n\n> ${webWords}\n\n- Sample Author`,
    `### Panel no link {id=w-panel-no-link}\n{quote form=web}\n\n![Screenshot of the post](assets/sample-speaker.png)\n\n> ${webWords}\n\n- Sample Author, "${webHead}"`,
    `### Http {id=w-http}\n{quote form=web}\n\n> ${webWords}\n\n- Sample Author http://old.example/p`,
    `### Domain stands in {id=w-domain}\n{quote form=web}\n\n> ${webWords}\n\n- Sample Author, 3 Sep 2026 https://Blog.Example.org:8080/p?x=1`,
    `### Hostile {id=w-hostile}\n{quote form=web}\n\n> ${webWords}\n\n- <b>A</b>, "<i>T</i>", *<u>S</u>*, 3 Sep 2026 https://x.example/<x>`,
    `### Long tokens {id=w-tokens}\n{quote form=web}\n\n> ${webWords} ${'Antidisestablishmentarianism'.repeat(5)}\n\n- Sample Author, "${'Supercalifragilistic'.repeat(8)}", *Sample Site* https://x.example/${'a'.repeat(160)}`,
    `### Too long {id=w-toolong}\n{quote form=web}\n\n> ${'word '.repeat(300)}\n\n- ${webFull}`,
    `### Two {id=w-two}\n{quote form=web}\n\n> First words.\n\n> Second words.\n\n- ${webFull}`,
    `### List {id=w-list}\n{quote form=web}\n\n> Words.\n> — Sample Author ${WEB}\n\n- one\n- two`,
    `### Link no token {id=w-plain-link}\n{quote}\n\n> ${webWords}\n\n- ${webFull}`,
    `### Book and link {id=w-book}\n{quote}\n\n> ${webWords}\n\n- A One, *Title*, Press, 1980, p. 5 ${WEB}`
  ])
  const normal = section('w-normal')
  assert(normal.includes('class="qf qf-web qf-full" data-step="2" style="--qf-web-mark:#0f4bd8;--qf-web-tint:#e7edfb"'), 'web-normal: the window at step 2 with the mark and tint pair')
  assert(normal.includes('<span class="qf-sr">From a web page.</span>'), 'the hidden source-type line')
  assert(normal.includes('<span class="qf-web-pill">') && normal.includes('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>') && normal.includes('<span class="qf-web-host">samplesite.example</span>'), 'the pill: lock and the domain')
  assert(normal.includes('<span class="qf-web-mark" aria-hidden="true">S</span><span class="qf-web-site">Sample Site</span><span class="qf-web-nav" aria-hidden="true"><span></span><span></span><span></span></span>'), 'the masthead: mark, site, three bars')
  assert(normal.includes('<p class="qf-web-headline">A sample blog post headline that runs to a second line</p>'), 'the headline')
  assert(normal.includes('<span class="qf-avatar qf-avatar-xs" style="background:#0f766e" aria-hidden="true">SA</span><b>Sample Author</b><span aria-hidden="true">·</span><span>3 Sep 2026</span>'), 'the byline')
  assert(normal.includes('<blockquote class="qf-words"><p>Sample quotation from a blog post.'), 'the words')
  assert(!normal.includes('qf-web-domain') && !normal.includes('<a ') && !normal.includes('samplesite.example/posts'), 'no domain line, no link and no path on stage')
  const panel = section('w-panel')
  assert(panel.includes('class="qf qf-side qf-web" data-step="1"') && panel.includes('<div class="qf-panel"><div class="qf-web-bar">') && panel.includes('<img class="qf-picture"'), 'web-panel: the bar over the picture in the left panel')
  assert(panel.includes('<figcaption class="qf-source"><div class="qf-source-who">Sample Author</div><div class="qf-source-where">A sample blog post headline that runs to a second line</div><div class="qf-source-where">Sample Site, 3 Sep 2026</div></figcaption>'), 'the source block: author, headline, site and date; no pill')
  assert(!panel.includes('qf-pill') && !panel.includes('qf-web-mast'), 'no pill and no masthead in the panel')
  assert(section('w-long').includes('data-step="3"') && section('w-panel-long').includes('data-step="2"'), 'web-long at 49.92, web-panel-long at 57.6')
  const only = section('w-only')
  assert(only.includes('<circle cx="12" cy="12" r="10"/>') && !only.includes('qf-web-mast') && !only.includes('qf-web-post'), 'web-only-link: the globe, no masthead and no post head')
  assert(only.includes('<div class="qf-web-domain">') && only.includes('<span>samplesite.example</span></div>'), 'and the domain once under the words')
  assert(section('w-panel-only').includes('<figcaption class="qf-source"><div class="qf-source-who">samplesite.example</div></figcaption>'), 'web-panel-only-link: the domain on the who line and nothing else')
  const noAuthor = section('w-no-author')
  assert(noAuthor.includes('qf-web-headline') && !noAuthor.includes('qf-web-by') && noAuthor.includes('qf-web-site">Sample Site'), 'web-no-author: headline and site, no byline')
  assert(section('w-panel-no-author').includes('<div class="qf-source-who">Sample Site</div><div class="qf-source-where">A sample blog post headline that runs to a second line</div><div class="qf-source-where">3 Sep 2026</div>'), 'panel with no author: the site on the who line, the date alone on the last line')
  assert(section('w-long-head').includes('qf-web-headline') && section('w-long-head').includes('data-step="2"'), 'web-long-headline: still step 2')
  const awaiting = section('w-awaiting')
  assert(awaiting.includes('qf-awaiting') && awaiting.includes('qf-placeholder') && !awaiting.includes('<blockquote') && awaiting.includes('From a web page. No words yet.'), 'web-awaiting-words: the placeholder, no words, the hidden line says so')
  assert(warnings.includes('quote-form-no-words:w-awaiting'), 'quote-form-no-words')
  const noLink = section('w-no-link')
  assert(!noLink.includes('qf-web-bar') && noLink.includes('qf-web-mast') && noLink.includes('qf-web-site">Sample Site'), 'chosen by hand with no link: no address bar, the masthead keeps the typed site')
  assert(noLink.includes('<div class="qf-web-body">'), 'and the words follow')
  const bare = section('w-no-link-no-site')
  assert(!bare.includes('qf-web-bar') && !bare.includes('qf-web-mast') && bare.includes('qf-web-by'), 'no link and no site: no bar and no masthead')
  const panelNoLink = section('w-panel-no-link')
  assert(!panelNoLink.includes('qf-web-bar') && panelNoLink.includes('<img class="qf-picture"'), 'panel with no link: no bar, the picture fills the panel')
  assert(section('w-http').includes('<circle cx="12" cy="12" r="10"/>') && !section('w-http').includes('<rect width="18" height="11"'), 'an http link: the globe, never the lock')
  const domain = section('w-domain')
  assert(domain.includes('<span class="qf-web-host">blog.example.org</span>') && domain.includes('<span class="qf-web-site">blog.example.org</span>'), 'the domain: lower case, no port, path or query; it stands in for the site name in the masthead')
  const hostile = section('w-hostile')
  assert(!/<b>A<\/b>|<i>T<\/i>|<u>S<\/u>/.test(hostile) && hostile.includes('&lt;i&gt;T&lt;/i&gt;'), 'source text is escaped')
  assert(section('w-tokens').includes('qf-web-win') && /\.qf-web-host\s*\{[^}]*overflow-wrap:\s*anywhere/.test(readFileSync(new URL('../compiler/assets/styles/layouts/quote.css', import.meta.url), 'utf8')), 'long tokens wrap: the words, the headline and the address')
  assert(warnings.includes('quote-form-too-long:w-toolong:Web') && !section('w-toolong').includes('qf-web'), 'a refused web page is Plain with the warning')
  assert(!section('w-two').includes('qf-web') && warnings.includes('quote-form-several-quotes:w-two'), 'several quotes: stays plain with the hint')
  assert(!section('w-list').includes('qf-web') && warnings.includes('quote-form-other-content:w-list'), 'other content beside the quote: stays plain with the hint')
  assert(!section('w-plain-link').includes('class="qf') && section('w-plain-link').includes('data-quote-chars'), 'an ordinary web link with no token compiles as the plain quote')
  assert(section('w-book').includes('qf-book') && !section('w-book').includes('qf-web'), 'a book reference that also carries a web link stays Book')
  // Weights (decision 13): the quoted words are never bold; nothing is clickable or underlined on stage.
  for (const id of ['w-normal', 'w-panel', 'w-long', 'w-panel-long', 'w-only', 'w-no-author', 'w-no-link']) {
    const wordsMarkup = section(id).match(/<blockquote class="qf-words">[\s\S]*?<\/blockquote>/)?.[0] ?? ''
    assert(wordsMarkup && !/<(b|strong|em|i|a)\b|font-weight|qf-source-title/.test(wordsMarkup), `${id}: the words carry no bold, italic or link markup`)
    assert(!/<a\b|href=/.test(section(id)), `${id}: no link on stage`)
  }
  const css = readFileSync(new URL('../compiler/assets/styles/skin/quote.css', import.meta.url), 'utf8')
  assert(/\.qf-web\.qf-full \.qf-words\s*\{[^}]*font-weight:\s*400/.test(css), 'the words in the window are 400')
  assert(!/\.qf-web[^{]*\.qf-words[^{]*\{[^}]*font-weight:\s*[5-9]00/.test(css), 'nothing makes the web words bold')
  assert(/\.is-dark \.qf-web-win[^{]*\{[^}]*box-shadow:\s*none/.test(css), 'dark skin: the window stays light and loses its shadow')
  assert(!/\.is-dark \.qf-web-win[^{]*\{[^}]*background/.test(css), 'dark skin: the window keeps its own light colours')
}
{
  // The link-edit rule (spec 3.1), over outline pairs. `edited` is the slide after the edit; `before` the slide as it was.
  const doc = (trigger, body) => `# T\n\n## Section\n\n### A quote\n${trigger}{id=q1}\n\n${body}\n`
  const rule = (beforeTrigger, beforeBody, afterTrigger, afterBody, layout) => {
    const before = doc(beforeTrigger, beforeBody)
    const after = doc(afterTrigger, afterBody)
    return { before, after, ...setFormOnLinkEdit(before, after, 'q1', layout) }
  }
  const linkAdded = rule('{quote}', '> Words.\n\n- Sample Author', '{quote}', `> Words.\n\n- Sample Author ${WEB}`)
  assert.equal(linkAdded.set, true, 'a web link added to an Automatic quote sets the form')
  assert.equal(linkAdded.outline, doc('{quote}{form=web}', `> Words.\n\n- Sample Author ${WEB}`), 'form=web joins the layout line and nothing else changes')
  assert.equal(rule('{quote}', `> Words.\n\n- Sample Author ${WEB}`, '{quote}', `> Words.\n\n- Sample Author ${WEB}/changed`).set, true, 'a changed link sets it')
  assert.equal(rule('{quote}', `> Words.\n\n- Sample Author ${WEB}`, '{quote}', `> Edited words.\n\n- Sample Author ${WEB}`).set, false, 'editing the words of a slide that has a link sets nothing')
  assert.equal(rule('{quote}', `> Words.\n\n- Sample Author ${WEB}`, '{quote}', `> Words.\n\n- Sample Author, edited ${WEB}`).set, false, 'editing the rest of the source line sets nothing')
  assert.equal(rule('{quote}', `> Words.\n\n- Sample Author ${WEB}`, '{quote}', `> Words.\n\n![alt](pic.png)\n\n- Sample Author ${WEB}`).set, false, 'adding a picture sets nothing')
  assert.equal(rule('{quote}', `> Words.\n\n- Sample Author ${WEB}`, '{quote}', `> Words.\n\n- Sample Author ${WEB}`).set, false, 'the link unchanged: nothing')
  const auto = rule('{quote form=auto}', '> Words.\n\n- Sample Author', '{quote form=auto}', `> Words.\n\n- Sample Author ${WEB}`)
  assert.equal(auto.outline, doc('{quote}{form=web}', `> Words.\n\n- Sample Author ${WEB}`), 'form=auto is replaced by form=web')
  assert.equal(rule('{quote form=plain}', '> Words.\n\n- Sample Author', '{quote form=plain}', `> Words.\n\n- Sample Author ${WEB}`).set, false, 'form=plain: the author chose, nothing is overridden')
  assert.equal(rule('{quote form=book}', '> Words.\n\n- Sample Author', '{quote form=book}', `> Words.\n\n- Sample Author ${WEB}`).set, false, 'an explicit form is never overridden')
  assert.equal(rule('{quote form=web}', '> Words.\n\n- Sample Author', '{quote form=web}', `> Words.\n\n- Sample Author ${WEB}`).set, false, 'already Web: nothing to write')
  assert.equal(rule('{quote}', '> Words.\n\n- Name', '{quote}', `> Words.\n\n- Name ${X}`).set, false, 'an X link is a tweet, not a web page')
  assert.equal(rule('{quote}', '> Words.\n\n- Name', '{quote}', '> Words.\n\n- Name https://youtu.be/XXXXXXXXXXX').set, false, 'a YouTube link is a video')
  const DOI = 'https://doi.org/10.1000/xyz'
  const doiAdded = rule('{quote}', '> Words.\n\n- Name', '{quote}', `> Words.\n\n- Name ${DOI}`)
  assert.deepEqual([doiAdded.set, doiAdded.form], [true, 'paper'], 'a DOI added to an Automatic quote sets Paper, not Web')
  assert.equal(doiAdded.outline, doc('{quote}{form=paper}', `> Words.\n\n- Name ${DOI}`), 'form=paper joins the layout line and nothing else changes')
  assert.equal(linkAdded.form, 'web', 'a web link still sets Web')
  for (const typed of ['doi:10.1000/xyz', '10.1000/xyz', `[the paper](${DOI})`]) {
    assert.equal(rule('{quote}', '> Words.\n\n- Name', '{quote}', `> Words.\n\n- Name ${typed}`).form, 'paper', `a DOI typed as ${typed} sets Paper`)
  }
  assert.equal(rule('{quote}', `> Words.\n\n- Name ${DOI}`, '{quote}', `> Words.\n\n- Name ${DOI}1`).form, 'paper', 'a changed DOI sets it')
  assert.equal(rule('{quote}', `> Words.\n\n- Name ${DOI}`, '{quote}', `> Edited words.\n\n- Name ${DOI}`).set, false, 'editing the words of a slide that has a DOI sets nothing')
  assert.equal(rule('{quote form=plain}', '> Words.\n\n- Name', '{quote form=plain}', `> Words.\n\n- Name ${DOI}`).set, false, 'form=plain: a DOI overrides nothing the author chose')
  assert.equal(rule('{quote form=web}', '> Words.\n\n- Name', '{quote form=web}', `> Words.\n\n- Name ${DOI}`).set, false, 'form=web: a DOI overrides nothing the author chose')
  assert.equal(rule('{quote form=paper}', '> Words.\n\n- Name', '{quote form=paper}', `> Words.\n\n- Name ${DOI}`).set, false, 'already Paper: nothing to write')
  assert.equal(rule('{quote form=auto}', '> Words.\n\n- Name', '{quote form=auto}', `> Words.\n\n- Name ${DOI}`).outline, doc('{quote}{form=paper}', `> Words.\n\n- Name ${DOI}`), 'form=auto is replaced by form=paper')
  assert.equal(rule('{quote}', '> Words.\n\n- A One, *T*, Press, 1980, p. 5', '{quote}', `> Words.\n\n- A One, *T*, Press, 1980, p. 5 ${DOI}`).set, false, 'a book reference with a DOI stays Book')
  assert.equal(rule('{quote}', '> One.\n\n- Name\n\n> Two.', '{quote}', `> One.\n\n- Name ${DOI}\n\n> Two.`).set, false, 'several quotations with a DOI: no token')
  assert.equal(rule('{quote}', '> Words.\n> — Name\n\n- one\n- two', '{quote}', `> Words.\n> — Name ${DOI}\n\n- one\n- two`).set, false, 'other content beside the quote with a DOI: no token')
  assert.equal(rule('{quote}', '> Words.\n\n- Name', '{quote}', '> Words.\n\n- Name https://x.com/someone').set, true, 'an X profile is an ordinary web link')
  assert.equal(rule('{quote}', '> Words.\n\n- A One, *Title*, Press, 1980, p. 5', '{quote}', `> Words.\n\n- A One, *Title*, Press, 1980, p. 5 ${WEB}`).set, false, 'a book reference with a link stays Book')
  assert.equal(rule('{quote}', '> Words.\n\n- Name', '{quote}', 'mailto:someone@example.org'.length ? '> Words.\n\n- Name ftp://example.org/file' : '').set, false, 'a link that is not http or https is no web link')
  assert.equal(rule('{quote}', '> One.\n\n- Name\n\n> Two.', '{quote}', `> One.\n\n- Name ${WEB}\n\n> Two.`).set, false, 'several quotations: the slide stays plain, so no token')
  assert.equal(rule('{quote}', '> Words.\n> — Name\n\n- one\n- two', '{quote}', `> Words.\n> — Name ${WEB}\n\n- one\n- two`).set, false, 'other content beside the quote: no token')
  const bare = rule('{quote}', `- Sample Author`, '{quote}', `- ${WEB}`)
  assert.equal(bare.outline, doc('{quote}{form=web}', `- ${WEB}`), 'a quote slide whose only content is the link counts')
  // The slide is one the compiler really infers as a quote slide (a quotation and its source line). A slide that is
  // only `- link` with no {quote} token compiles as a list slide, token or no token, so the rule's check by compiling
  // (quote-write-check.ts) writes nothing there: asserted below.
  const inferred = rule('', `> Words.\n\n- Sample Author`, '', `> Words.\n\n- Sample Author ${WEB}`, 'quote')
  assert.equal(rule('', `- Sample Author`, '', `- ${WEB}`, 'quote').set, false, 'only a link, no {quote} token: the compiler draws a list slide whatever the caller says, so nothing is written')
  assert.equal(inferred.set, true, 'a quote-only slide with no {quote} token (the compiler inferred the layout) is set too')
  // Ticket 11: a compiled layout that does not make the slide a quote slide may be the last compile's answer for a
  // slide typed since (none yet, or another slide's), so the compiler's own reading of the slide decides then.
  assert.equal(rule('', '- one\n- two', '', `- one\n- two ${WEB}`, 'list').set, false, 'a slide that is not a quote slide is left alone')
  assert.equal(rule('', '- one\n- two', '', `- one\n- two ${WEB}`).set, false, 'and with no compiled layout')
  for (const stale of [undefined, 'list']) assert.equal(rule('', '> Words.', '', `> Words.\n\n- ${WEB}`, stale).set, true, `a slide the compiler reads as a quote slide is set whatever the last compile said of that line (${stale})`)
  // The whole-outline form the editor uses: matched by id; other slides are untouched.
  const two = (a, b) => `# T\n\n## Section\n\n### One\n{quote}{id=a}\n\n${a}\n\n### Two\n{quote}{id=b}\n\n${b}\n`
  const written = setFormOnLinkEdits(two('> W.\n\n- N', `> W.\n\n- N ${WEB}`), two(`> W.\n\n- N ${WEB}`, `> W.\n\n- N ${WEB}`))
  assert.equal(written.set, true)
  assert.equal(written.outline, `# T\n\n## Section\n\n### One\n{quote}{form=web}{id=a}\n\n> W.\n\n- N ${WEB}\n\n### Two\n{quote}{id=b}\n\n> W.\n\n- N ${WEB}\n`, 'only the slide whose link was edited becomes a web page; the other keeps its link and stays plain')
  // Undo: one outline restores the first (the write is one minimal change; the editor test proves it in one undo step).
  assert.equal(setQuoteForm(linkAdded.outline, 'q1', 'auto').outline.replace(` ${WEB}`, ''), linkAdded.before, 'removing the token and the link returns the first outline')
}
{
  // set-quote-source returns formSet (spec 11).
  const before = outline('{quote}', '> Words.\n\n- Sample Author')
  const withLink = setQuoteSource(before, 'q1', { link: WEB })
  assert.equal(withLink.formSet, 'web', 'a web link added through the verb sets the form too and says so')
  assert.deepEqual([describeQuoteSource(withLink.outline, 'q1').token, describeQuoteSource(withLink.outline, 'q1').form], ['web', 'web'], 'the slide now says form=web and shows as Web')
  assert.equal(setQuoteSource(withLink.outline, 'q1', { text: 'Sample Author, "Head"' }).formSet, null, 'changing the text only: null, the layout line untouched')
  assert.equal(setQuoteSource(withLink.outline, 'q1', { link: `${WEB}/other` }).formSet, null, 'already Web: null')
  assert.equal(setQuoteSource(before, 'q1', { link: X }).formSet, null, 'an X link: null')
  const withDoi = setQuoteSource(before, 'q1', { link: 'https://doi.org/10.1000/xyz' })
  assert.equal(withDoi.formSet, 'paper', 'a DOI added through the verb sets Paper and says so')
  assert.deepEqual([describeQuoteSource(withDoi.outline, 'q1').token, describeQuoteSource(withDoi.outline, 'q1').form], ['paper', 'paper'], 'the slide now says form=paper and shows as Paper')
  assert.equal(setQuoteSource(withDoi.outline, 'q1', { text: 'Someone Else' }).formSet, null, 'a DOI kept as it was: null')
  assert.equal(setQuoteSource(outline('{quote form=plain}', '> Words.\n\n- Sample Author'), 'q1', { link: 'doi:10.1000/xyz' }).formSet, null, 'form=plain with a DOI: null')
  assert.equal(setQuoteSource(outline('{quote form=plain}', '> Words.\n\n- Sample Author'), 'q1', { link: WEB }).formSet, null, 'form=plain: null')
  assert.equal(setQuoteSource(outline('{quote}', '> Words.\n\n- A One, *T*, Press, 1980, p. 5'), 'q1', { link: WEB }).formSet, null, 'a book reference: null')
  assert.equal(setQuoteSource(outline('{quote}', `> Words.\n\n- Sample Author ${WEB}`), 'q1', { text: 'Someone Else' }).formSet, null, 'the link kept as it was: null')
  assert.equal(setQuoteSource(before, 'q1', { text: 'Someone Else' }).formSet, null, 'no link: null')
  // The notes (spec 17.5).
  const set = describe('{quote form=web}', `> Words.\n\n- Sample Author ${WEB}`)
  assert.deepEqual([set.form, set.chosen, set.webLink, set.presentation, set.unbuilt], ['web', true, 'samplesite.example', 'window', false])
  assert.deepEqual(notesOf(set), ['Set when you added the link to samplesite.example.', 'No picture on this slide: the page in a browser window. Add a screenshot of the page to get the left panel.'], 'inspector-web-set-on-edit')
  assert.deepEqual(notesOf(describe('{quote form=web}', `![Shot](assets/s.png)\n\n> Words.\n\n- Sample Author ${WEB}`)), ['Set when you added the link to samplesite.example.', 'Picture on this slide: it fills the left panel under the address bar.'], 'with a picture')
  assert.deepEqual(notesOf(describe('{quote form=web}', '![Shot](assets/s.png)\n\n> Words.\n\n- Sample Author')), ['Always a web page. Site, headline, author and date are read from the source line.', 'Picture on this slide: it fills the left panel under the address bar.'], 'inspector-web with a picture')
  const plainWithLink = describe('{quote}', `> Words.\n\n- Sample Author ${WEB}`)
  assert.deepEqual([plainWithLink.form, plainWithLink.chosen, plainWithLink.webLink], ['plain', false, 'samplesite.example'])
  assert.deepEqual(notesOf(plainWithLink), ['Showing as Plain.', 'The source line has a web link. Choose Web to show it as a web page.'], 'inspector-plain-with-web-link')
  // Choosing Automatic or Plain on a web slide returns it to a plain quote, one edit each, the link and the details kept.
  const web = outline('{quote form=web}', `> Words.\n\n- ${webFull}`)
  const toAuto = setQuoteForm(web, 'q1', 'auto')
  assert(!/form=/.test(toAuto.triggerLine) && toAuto.outline.includes(webFull), 'Automatic removes the token and keeps the link')
  assert.equal(describeQuoteSource(toAuto.outline, 'q1').form, 'plain')
  assert(/form=plain/.test(setQuoteForm(web, 'q1', 'plain').triggerLine), 'Plain writes form=plain')
  assert(/form=web/.test(setQuoteForm(toAuto.outline, 'q1', 'web').triggerLine), 'choosing Web writes form=web')
  assert.deepEqual(UNBUILT_FORM_NOTE_FORMS, [], 'every form is built')
}

// ── 7. Palette commands ───────────────────────────────────────────────────────────────────────

{
  const commands = COMMAND_REGISTRY.filter((command) => command.id.startsWith('quote-form-'))
  assert.deepEqual(commands.map((command) => command.label), [
    'Quote form: Automatic', 'Quote form: Plain', 'Quote form: Tweet', 'Quote form: Video', 'Quote form: Book', 'Quote form: Paper', 'Quote form: Web'
  ], 'the command palette lists "Quote form: …" commands')
  assert(commands.every((command) => command.palette.visible && command.handlerId === command.id))
}

// ── 8. Existing quote slides render exactly as before ─────────────────────────────────────────

{
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
  const recorded = JSON.parse(readFileSync(join(root, 'scripts/fixtures/quote-forms/quote-slide-hashes.json'), 'utf8'))
  const live = await quoteSlideHashes(root)
  const changed = Object.keys(recorded).filter((key) => live[key] !== recorded[key])
  assert.deepEqual(changed, [], `quote slides in the sampler, the showcase and the demo vault render as before (changed: ${changed.join(', ')})`)
  assert(Object.keys(recorded).length >= 50, 'the baseline covers the sampler and the demo vault')
  const added = Object.keys(live).filter((key) => !(key in recorded))
  assert.deepEqual(added.filter((key) => !/#quote-form-(tweet|video-player|video-panel|book|book-cover|paper|paper-panel|web|web-panel)$/.test(key)), [], 'the only new quote slides are the tweet, the two video samples, the two book samples and the two paper samples and the two web samples')
  // The sampler's tweet sample draws as the card.
  const { buildLayoutSampler } = await import('./build-layout-sampler.mjs')
  const sampler = await buildLayoutSampler(join(dir, 'sampler'))
  assert(new RegExp('<section class="slide[^"]*" data-id="quote-form-tweet"[\\s\\S]*?qf-tweet').test(sampler.html), 'the layout sampler has the tweet sample')
  for (const id of ['quote-form-video-player', 'quote-form-video-panel']) {
    assert(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?qf-video`).test(sampler.html), `the layout sampler has the ${id} sample`)
  }
  for (const id of ['quote-form-book', 'quote-form-book-cover']) {
    assert(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?qf-book`).test(sampler.html), `the layout sampler has the ${id} sample`)
  }
  for (const id of ['quote-form-paper', 'quote-form-paper-panel']) {
    assert(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?qf-paper`).test(sampler.html), `the layout sampler has the ${id} sample`)
  }
  for (const id of ['quote-form-web', 'quote-form-web-panel']) {
    assert(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?qf-web`).test(sampler.html), `the layout sampler has the ${id} sample`)
  }
  assert(!(sampler.model.warnings ?? []).some((warning) => warning.startsWith('quote-form')), 'the sample raises no quote-form warning')
}

// ── Other painting content beside the quote keeps the slide plain ──
{
  const body = (trigger, id, extra) => `### Mixed {id=${id}}\n${trigger}\n\n> First words.\n> — Someone ${X}\n\n${extra}`
  const explicit = await compile([body('{quote form=tweet}', 't-mix-tweet', '- one\n- two')])
  assert(!/\bqf\b|qf-/.test(explicit.section('t-mix-tweet')), 'an explicit tweet beside a list is plain')
  assert.deepEqual(explicit.warnings.filter((warning) => warning.startsWith('quote-form')), ['quote-form-other-content:t-mix-tweet'], 'one quote-form-other-content warning')
  assert(formatWarning('quote-form-other-content:t-mix-tweet').startsWith('This slide has other content beside the quote, so it shows as a plain quote.'))
  assert.deepEqual(warningDefinition('quote-form-other-content:t-mix-tweet').surfaces, ['strip-badge', 'inspector', 'doctor'])
  const detected = await compile([body('{quote}', 't-mix-auto', '- one\n- two')])
  assert(!/\bqf\b|qf-/.test(detected.section('t-mix-auto')), 'a detected tweet beside a list is plain')
  assert(!detected.warnings.some((warning) => warning.startsWith('quote-form')), 'a detected form stays silent')
  const plain = await compile([body('{quote form=plain}', 't-mix-plain', '- one\n- two')])
  assert(!plain.warnings.some((warning) => warning.startsWith('quote-form')), 'an explicit Plain raises no warning')
  const alone = await compile([body('{quote form=tweet}', 't-mix-alone', '')])
  assert(alone.section('t-mix-alone').includes('qf-tweet'), 'the same quote alone takes the form')
  // The Inspector's note says Plain.
  const outline = `# T\n\n## Section\n\n### Mixed\n{quote}{id=q3}\n\n> First words.\n> — Someone ${X}\n\n- one\n- two\n`
  const description = describeQuoteSource(outline, 'q3')
  assert.equal(description.presentation, 'plain')
  assert.equal(description.form, 'tweet', 'the form stays the detected one, as for several quotes')
  assert.equal(description.otherContent, true)
  assert.deepEqual(quoteFormNotes(description).map((note) => `${note.lead}${note.text}`), ['Showing as Plain. This slide has other content beside the quote, so it shows as a plain quote.'])
}

// ── Several quotes on one slide stay plain; the Inspector's quote form group never writes {quote} ──
{
  const two = (trigger, id) => `### Two quotes {id=${id}}\n${trigger}\n\n> First words.\n\n> Second words.\n\n- Someone ${X}`
  const auto = await compile([two('{quote}', 't-two-auto')])
  const forcedPlain = await compile([two('{quote form=plain}', 't-two-auto')])
  const autoSection = auto.section('t-two-auto')
  assert(autoSection.includes('First words') && autoSection.includes('Second words'), 'both quotes are drawn')
  assert(!/\bqf\b|qf-/.test(autoSection), 'automatic: no form markup on a slide with two quotes')
  assert.equal(autoSection, forcedPlain.section('t-two-auto'), 'automatic: the slide renders as the plain quote slide')
  assert(!auto.warnings.some((warning) => warning.startsWith('quote-form')), 'automatic: no warning')
  const tweet = await compile([two('{quote form=tweet}', 't-two-tweet')])
  assert(!/\bqf\b|qf-/.test(tweet.section('t-two-tweet')), 'an explicit tweet on two quotes is plain')
  assert.deepEqual(tweet.warnings.filter((warning) => warning.startsWith('quote-form')), ['quote-form-several-quotes:t-two-tweet'], 'one quote-form-several-quotes warning')
  assert(formatWarning('quote-form-several-quotes:t-two-tweet').startsWith('This slide has more than one quote, so it shows as a plain quote.'))
  assert.deepEqual(warningDefinition('quote-form-several-quotes:t-two-tweet').surfaces, ['strip-badge', 'inspector', 'doctor'])
  const plainToken = await compile([two('{quote form=plain}', 't-two-plain')])
  assert(!plainToken.warnings.some((warning) => warning.startsWith('quote-form')), 'an explicit Plain raises no warning')
  const one = await compile([`### One quote {id=t-one}\n{quote form=tweet}\n\n> First words.\n\n- Someone ${X}`])
  assert(one.section('t-one').includes('qf-tweet'), 'one quote still takes the form')
  assert(!one.warnings.some((warning) => warning.startsWith('quote-form-several')), 'and raises no several-quotes warning')
  // The Inspector's note says Plain.
  const outlineOf = (trigger) => `# T\n\n## Section\n\n### Two quotes\n${trigger}{id=q2}\n\n> First words.\n\n> Second words.\n\n- Someone ${X}\n`
  for (const trigger of ['{quote}', '{quote}{form=tweet}']) {
    const note = notesOf(describeQuoteSource(outlineOf(trigger), 'q2'))
    assert.deepEqual(note, ['Showing as Plain. This slide has more than one quote, so it shows as a plain quote.'], `${trigger}: the note says Plain`)
  }
  // The drawn presentation is Plain for two quotes with a Tweet source; one quote keeps its card.
  for (const trigger of ['{quote}', '{quote}{form=tweet}']) {
    assert.equal(describeQuoteSource(outlineOf(trigger), 'q2').presentation, 'plain', `${trigger}: two quotes draw Plain`)
  }
  const oneTweet = `# T\n\n## Section\n\n### One quote\n{quote}{form=tweet}{id=q3}\n\n> First words.\n\n- Someone ${X}\n`
  assert.equal(describeQuoteSource(oneTweet, 'q3').presentation, 'card', 'one quote with a Tweet source keeps the card')
}

{
  const { commitQuoteFormOption } = await import('../src/renderer/src/components/layoutPickerModel.ts')
  const body = `> Words.\n\n- Name ${X}\n`
  const base = `# T\n\n## Section\n\n### A quote\n{id=q1}\n\n${body}`
  const layout = (await compile([`### A quote\n{id=q1}\n\n${body}`])).model.slides.find((candidate) => candidate.id === 'q1')?.layout
  assert.equal(layout, 'quote', 'the slide is an inferred quote slide')
  const plain = commitQuoteFormOption(base, 5, 'form=plain', layout)
  assert(plain.outline.includes('{form=plain}') && !plain.outline.includes('{quote}'), `Plain writes only the form token (${plain.triggerLine})`)
  assert.equal(commitQuoteFormOption(plain.outline, 5, '', layout).outline, base, 'Automatic restores the original text byte for byte')
  // A slide that already has {quote} keeps it.
  const authored = base.replace('{id=q1}', '{quote}{id=q1}')
  const tweet = commitQuoteFormOption(authored, 5, 'form=tweet', layout)
  assert(tweet.outline.includes('{quote}{form=tweet}{id=q1}'), 'an authored {quote} stays')
  assert.equal(commitQuoteFormOption(tweet.outline, 5, '', layout).outline, authored)
  assert.equal(commitQuoteFormOption(`# T\n\n## Section\n\n### A list\n- a\n- b\n`, 5, 'form=plain', 'list'), null, 'a slide that is not a quote falls back')
}

// ── Review findings: promoted prose quotes, and inline marks in source fields ────────────────

{
  const words = '\u201CWords.\u201D'
  const link = 'https://x.com/user/status/1'
  const make = (body, trigger = '') => `# T\n\n## Section\n\n### A quote\n${trigger}{id=q1}\n\n${body}\n`
  for (const [label, body, source] of [
    ['an attribution line right under the quote', `${words}\n\u2014 Name, 4 Oct 2026 ${link}`, '\u2014 '],
    ['an attribution line after a blank line', `${words}\n\n\u2014 Name, 4 Oct 2026 ${link}`, '\u2014 ']
  ]) {
    const base = make(body)
    const layout = (await compile([`### A quote {id=q1}\n\n${body}`])).model.slides.find((candidate) => candidate.id === 'q1')?.layout
    assert.equal(layout, 'quote', `${label}: the compiler gives the slide the quote layout`)
    const found = describeQuoteSource(base, 'q1', layout)
    assert.deepEqual([found.form, found.awaitingWords, found.fields.name], ['tweet', false, 'Name'], `${label}: described as the Tweet the slide shows`)
    const written = setQuoteSource(base, 'q1', { text: 'Other Person, 5 Oct 2026' }, layout).outline
    assert.equal(written.split('\n').filter((line) => line.includes('Other Person')).length, 1, `${label}: one source line`)
    assert(!written.includes('Name,') && written.includes(`${source}Other Person, 5 Oct 2026 ${link}`), `${label}: replaced in place, dash style kept, link kept`)
    assert(!written.includes('\n- '), `${label}: no bullet line added`)
    assert.equal(setQuoteSource(base, 'q1', {}, layout).outline, base, `${label}: writing nothing changes nothing`)
    let text = setQuoteForm(base, 'q1', 'plain', layout).outline
    assert.equal(describeQuoteSource(text, 'q1', layout).form, 'plain', `${label}: Plain is read back`)
    text = setQuoteForm(text, 'q1', 'auto', layout).outline
    assert.equal(text, base, `${label}: Plain then Automatic returns the text byte for byte`)
  }
  const bare = make(words)
  const added = setQuoteSource(bare, 'q1', { text: 'Name', link }, 'quote').outline
  assert(added.includes(`${words}\n\n- Name ${link}\n`), 'a promoted quote with no source gets one bullet line after it')
  assert.deepEqual(readQuoteSlideLines(['> Old words.', '', '- Name']).paragraphs, ['Old words.'], '> quotes read as before')
  const mid = readQuoteSlideLines([`${words} (Name, ${link})`])
  assert.equal(mid.cite, `Name, ${link}`, 'a parenthetical source on the quote line is read')
}

{
  const x = 'https://x.com/user/status/1'
  const name = (line) => readFields('tweet', parseSourceLine(line)).name
  for (const mark of ['~~', '++', '==']) assert.equal(name(`${mark}Dominik Luke\u0161${mark}, 4 Oct 2026 ${x}`), 'Dominik Luke\u0161', `${mark} marks are not shown in the name`)
  assert.equal(name(`Dominik **Luke\u0161**, 4 Oct 2026 ${x}`), 'Dominik Luke\u0161', 'bold still handled')
  assert.equal(name(`Dominik \`Luke\u0161\`, 4 Oct 2026 ${x}`), 'Dominik Luke\u0161', 'code still handled')
  const later = parseSourceLine(`Name, 4 Oct 2026 ${x} and [the thread](https://example.com/t)`)
  assert.equal(later.link.url, x, 'the first link is the link')
  assert(!later.segments.some((segment) => /\]\(|https:\/\/example/.test(segment.text)), 'a later Markdown link leaves its label, not its syntax')
  assert(later.segments.some((segment) => /the thread/.test(segment.text)), 'the later link keeps its label')
  const md = parseSourceLine('Name, [the post](https://x.com/user/status/9), ~~old~~')
  assert.equal(md.link.url, 'https://x.com/user/status/9', 'a Markdown first link is still the link')
  const book = parseSourceLine('George Lakoff, *Metaphors We Live By*, 1980')
  assert.equal(book.segments.find((segment) => segment.container)?.container, 'Metaphors We Live By', 'a title in asterisks is still the title')
  const under = parseSourceLine('George Lakoff, _Metaphors We Live By_, 1980')
  assert.equal(under.segments.find((segment) => segment.container)?.container, 'Metaphors We Live By', 'a title in underscores is still the title')
}

// ── 9. Parity: the outline reader agrees with the compiler's lexer ────────────────────────────
// The compiler's lexer decides what is a quotation and what is its source; the editing side reads the same outline
// with the grammar in compiler/scripts/lib/quote-grammar.mjs. Each snippet below is compiled for real and read by
// the reader, and the two must agree on (a) how many quotations the compiler counts (practice quotes excluded),
// (b) the quoted words, (c) the citation (a title-derived citation reads as none), (d) the form shown. Rows with
// exactly one quotation also go through the writers: Plain then Automatic is byte for byte, and a new source leaves
// one source. A row marked `known` is skipped for the reason given (none are at present, and none is marked).
{
  writeFileSync(join(dir, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  const X2 = 'https://x.com/other/status/42'
  const N = `Name ${X}`
  const W = 'https://www.samplesite.example/posts/a-sample-post'
  const TRY = '> **Try it.** Press <kbd>⌘</kbd>'
  const rows = [
    // `>` quotes and their sources
    ['> quote, bullet source after a blank line', `> Words.\n\n- ${N}`],
    ['> quote, bullet source on the next line', `> Words.\n- ${N}`],
    ['> quote, em dash source on its own line', `> Words.\n\n— ${N}`],
    ['> quote, en dash source on its own line', `> Words.\n– ${N}`],
    ['> quote, * source', `> Words.\n\n* ${N}`],
    ['> quote, + source', `> Words.\n\n+ ${N}`],
    ['> quote, plain-text source (not a source)', `> Words.\n\nNot a source ${X}`],
    ['> quote, bullet source then a second bullet (a list, not a source)', `> Words.\n\n- ${N}\n- Another point`],
    ['> in-block attribution, em dash and space', `> Words.\n> — ${N}`],
    ['> in-block attribution, en dash and space', `> Words.\n> – ${N}`],
    ['> in-block attribution, hyphen and space', `> Words.\n> - ${N}`],
    ['> in-block attribution, em dash, no space', `> Words.\n> —${N}`],
    ['> in-block attribution, en dash, no space', `> Words.\n> –${N}`],
    ['> in-block attribution, hyphen, no space', `> Words.\n> -${N}`],
    ['> in-block attribution, no space after >', `> Words.\n>- ${N}`],
    ['> in-block attribution after a blank > line', `> Words.\n>\n> - ${N}`],
    ['> in-block attribution, indented block', `  > Words.\n  > - ${N}`],
    ['> in-block attribution only (no words)', `> - ${N}`],
    ['> multi-line quote', `> One line\n> and another.\n\n- ${N}`],
    ['> multi-paragraph quote', `> One paragraph.\n>\n> Another paragraph.\n> - ${N}`],
    ['> quote, no source (title-derived citation)', '> Words.'],
    ['> quote, no source, a bullet list follows', '> Words.\n\n- one\n- two'],
    ['> quote, no source, a bullet list follows directly', '> Words.\n- one\n- two'],
    ['promoted, no source, a bullet list follows directly', '“Words.”\n- one\n- two'],
    // promoted prose
    ['promoted, curly marks, dash tail on the same line', `“Words.” — ${N}`],
    ['promoted, curly marks, en dash tail', `“Words.” – ${N}`],
    ['promoted, curly marks, hyphen tail', `“Words.” - ${N}`],
    ['promoted, curly marks, dash tail with no space', `“Words.”—${N}`],
    ['promoted, straight marks, dash tail on the same line', `"Words." — ${N}`],
    ['promoted, straight marks, hyphen tail', `"Words." - ${N}`],
    ['promoted, mixed marks', `"Words.” — ${N}`],
    ['promoted, punctuation outside the closing mark', `“Words”, — ${N}`],
    ['promoted, (Name) tail on the quote line', `“Words.” (${N})`],
    ['promoted, (Name). tail with a full stop', `"Words." (${N}).`],
    ['promoted, em dash source on the next line', `“Words.”\n— ${N}`],
    ['promoted, bullet source on the next line', `“Words.”\n- ${N}`],
    ['promoted, em dash source after a blank line', `“Words.”\n\n— ${N}`],
    ['promoted, bullet source after a blank line', `"Words."\n\n- ${N}`],
    ['promoted, two lines, tail on the second', `“Words on one line\nand on the next.” — ${N}`],
    ['promoted, two lines, tail on its own line inside the paragraph', `“Words on one line\nand on the next.”\n— ${N}`],
    ['promoted, no source (title-derived citation)', '“Words.”'],
    ['prose before the quotation (one paragraph, the whole of it a source)', `Intro\n“Words.” — ${N}`, { linkOnly: true }],
    ['a quotation inside a sentence (a paragraph, not a quote)', `She said “words” and left.`, { linkOnly: true }],
    ['a quotation with trailing prose (a paragraph, not a quote)', `“Words” and more.`, { linkOnly: true }],
    ['an unterminated quotation (a paragraph, the whole of it a source)', `“Words. — ${N}`, { linkOnly: true }],
    // several quotations
    ['two > quotes', `> One.\n\n- ${N}\n\n> Two.\n\n- Other`],
    ['two > quotes, no sources', '> One.\n\n> Two.'],
    ['two promoted quotes', `“One.” — ${N}\n\n“Two.”`],
    ['two promoted quotes, folded sources', `“One.”\n— ${N}\n\n“Two.”\n— Other`],
    ['promoted then >', `“One.” — ${N}\n\n> Two.`],
    ['> then promoted', `> One.\n\n- ${N}\n\n“Two.”`],
    ['the Tweet-source promoted quote beside a second one (Finding B)', `“One.” — Name https://x.com/name/status/123\n\n“Two.”`],
    // practice quotes
    ['a practice quote before the quote', `${TRY}\n\n> Real.\n\n- ${N}`],
    ['a practice quote after the quote', `> Real.\n\n- ${N}\n\n${TRY}`],
    ['a practice quote beside a promoted quote', `${TRY}\n\n“Real.” — ${N}`],
    ['a practice quote and a source line (no quote to attribute to)', `${TRY}\n\n- ${N}`],
    ['a practice quote alone', TRY],
    // pictures
    ['a picture between the words and the source', `> Words.\n\n![alt](pic.png)\n\n- ${N}`],
    ['a picture after the source', `> Words.\n\n- ${N}\n\n![alt](pic.png)`],
    ['a picture before the quote', `![alt](pic.png)\n\n> Words.\n\n- ${N}`],
    // other content beside the quotation: the card would cover it, so the slide stays plain
    ['in-block attribution, then a two-item list (detected)', `> Words.\n> — ${N}\n\n- one\n- two`],
    ['in-block attribution, then a two-item list (explicit tweet)', `> Words.\n> — ${N}\n\n- one\n- two`, { trigger: '{quote form=tweet}' }],
    ['source line, then a one-item list that is not the source', `> Words.\n\n- ${N}\n\n- A later point`, { trigger: '{quote form=tweet}' }],
    ['in-block attribution, then a closing paragraph', `> Words.\n> — ${N}\n\nA closing remark.`],
    ['in-block attribution, then a closing paragraph (explicit tweet)', `> Words.\n> — ${N}\n\nA closing remark.`, { trigger: '{quote form=tweet}' }],
    ['in-block attribution, then a table', `> Words.\n> — ${N}\n\n| a | b |\n|---|---|\n| 1 | 2 |`],
    ['in-block attribution, then a code fence', `> Words.\n> — ${N}\n\n\`\`\`js\nx\n\`\`\``],
    ['in-block attribution and one picture (still draws)', `> Words.\n> — ${N}\n\n![alt](pic.png)`],
    ['in-block attribution, one picture (explicit tweet, still draws)', `> Words.\n> — ${N}\n\n![alt](pic.png)`, { trigger: '{quote form=tweet}' }],
    ['in-block attribution, a picture and a list', `> Words.\n> — ${N}\n\n![alt](pic.png)\n\n- one\n- two`],
    ['in-block attribution, a picture and a list (explicit tweet)', `> Words.\n> — ${N}\n\n![alt](pic.png)\n\n- one\n- two`, { trigger: '{quote form=tweet}' }],
    ['in-block attribution and two pictures (still draws; the extra picture is not drawn)', `> Words.\n> — ${N}\n\n![alt](pic.png)\n\n![alt](pic2.png)`],
    ['promoted quote, then a list', `“Words.” — ${N}\n\n- one\n- two`],
    ['a comment beside the quote is not content', `> Words.\n> — ${N}\n\n<!-- aside -->`],
    // other block constructs around a quotation
    ['a fenced block holding > lines before the quote', `\`\`\`\n> not a quote\n“nor this”\n\`\`\`\n\n> Real.\n\n- ${N}`],
    ['a directive line before a promoted quote', `[Action: Go → https://example.com]\n“Words.” — ${N}`],
    ['a bare URL paragraph', X, { linkOnly: true }],
    // sources that are not tweets
    ['a plain source', '> Words.\n\n- George Lakoff and Mark Johnson, 1980'],
    ['a plain in-block source', '> Words.\n> - George Lakoff, 1980'],
    // explicit form
    ['form=plain on a Tweet source', `> Words.\n\n- ${N}`, { trigger: '{quote form=plain}' }],
    ['form=tweet on a plain source', '> Words.\n\n- Sample Name (@samplehandle), 1 Jan 2026', { trigger: '{quote form=tweet}' }],
    ['form=tweet on two quotes', `> One.\n\n- ${N}\n\n> Two.`, { trigger: '{quote form=tweet}' }],
    // layout inferred, no {quote} token
    ['no {quote} token, > quote and source', `> Words.\n\n- ${N}`, { trigger: '' }],
    ['no {quote} token, promoted quote and tail', `“Words.” — ${N}`, { trigger: '' }],
    ['no {quote} token, a source line alone (the compiler infers a list)', `- ${N}`, { trigger: '', linkOnly: true }],
    ['{quote} token, a source line alone', `- ${N}`, { linkOnly: true }],
    // the web page (ticket 07): drawn only for form=web; never found from the text (spec 3.1)
    ['an ordinary web link, no form token: Plain, as it always was', `> Words.\n\n- Sample Author, "A headline", *Sample Site*, 3 Sep 2026 ${W}`],
    ['an ordinary web link, no {quote} token: Plain', `> Words.\n\n- Sample Author ${W}`, { trigger: '' }],
    ['form=web, a source with all the details', `> Words.\n\n- Sample Author, "A headline", *Sample Site*, 3 Sep 2026 ${W}`, { trigger: '{quote form=web}' }],
    ['form=web, in-block attribution', `> Words.\n> — Sample Author ${W}`, { trigger: '{quote form=web}' }],
    ['form=web, promoted quote with a dash tail', `“Words.” — Sample Author ${W}`, { trigger: '{quote form=web}' }],
    ['form=web, only the link', `> Words.\n\n- ${W}`, { trigger: '{quote form=web}' }],
    ['form=web, no link at all', '> Words.\n\n- Sample Author, "A headline", *Sample Site*', { trigger: '{quote form=web}' }],
    ['form=web, a picture beside the quote', `![Screenshot](pic.png)\n\n> Words.\n\n- Sample Author ${W}`, { trigger: '{quote form=web}' }],
    ['form=web, a source line alone', `- ${W}`, { trigger: '{quote form=web}', linkOnly: true }],
    ['form=web on two quotes: stays plain', `> One.\n\n- Sample Author ${W}\n\n> Two.`, { trigger: '{quote form=web}' }],
    ['form=web, then a list: stays plain', `> Words.\n> — Sample Author ${W}\n\n- one\n- two`, { trigger: '{quote form=web}' }],
    ['a book reference that also carries a web link stays Book', `> Words.\n\n- A One, *Title*, Press, 1980, p. 5 ${W}`],
    // the paper (2026-10-12): drawn only for form=paper; a DOI is never found from the text
    ['a DOI link, no form token: Plain, as it always was', '> Words.\n\n- A One, "Title", *Journal* 1(2), 1980 https://doi.org/10.1000/xyz'],
    ['a DOI link, no {quote} token: Plain', '> Words.\n\n- A One, "Title", *Journal* 1(2), 1980 https://doi.org/10.1000/xyz', { trigger: '' }],
    ['form=paper, a source with a DOI', '> Words.\n\n- A One, "Title", *Journal* 1(2), 1980, p. 5 https://doi.org/10.1000/xyz', { trigger: '{quote form=paper}' }],
    ['form=paper on two quotes: stays plain', '> One.\n\n- A One, "Title", *Journal* 1(2), 1980 https://doi.org/10.1000/xyz\n\n> Two.', { trigger: '{quote form=paper}' }],
    ['form=auto with a DOI: Plain', '> Words.\n\n- A One, "Title", *Journal* 1(2), 1980 https://doi.org/10.1000/xyz', { trigger: '{quote form=auto}' }],
    ['form=auto with an ordinary web link: Plain', `> Words.\n\n- Sample Author ${W}`, { trigger: '{quote form=auto}' }],
    ['form=plain with a web link', `> Words.\n\n- Sample Author ${W}`, { trigger: '{quote form=plain}' }]
  ]
  const slideOf = (index, body, trigger) => `### Row ${index} {id=r${index}}\n${trigger ? `${trigger}\n` : ''}\n${body}`
  const compiled = await compile(rows.map(([, body, options], index) => slideOf(index, body, options?.trigger ?? '{quote}')))
  const doc = (slide) => `# T\n\n## Section\n\n${slide}\n`
  const verdicts = []
  for (const [index, [label, body, options = {}]] of rows.entries()) {
    const id = `r${index}`
    const slide = compiled.model.slides.find((candidate) => candidate.id === id)
    const quotes = (slide.blocks || []).filter((block) => block.type === 'quote' && !block.practice)
    const first = quotes[0]
    const lines = body.split('\n')
    const read = readQuoteSlideLines(lines)
    const outline = doc(slideOf(index, body, options.trigger ?? '{quote}'))
    const reason = (what) => `${label}: ${what}`
    if (options.known) { verdicts.push(`${label}: KNOWN DIFFERENCE, ${options.known}`); continue }
    const layoutIsQuote = slide.layout === 'quote'
    if (!layoutIsQuote) {
      verdicts.push(`${label}: the compiler draws layout ${slide.layout}`)
      // Not a quote slide to the compiler (prose before the quotation, a sentence): the verbs refuse it too.
      assert.equal(isQuoteSlide(outline, id, slide.layout), false, reason('the verbs refuse a slide the compiler does not draw as a quote'))
      continue
    }
    const description = describeQuoteSource(outline, id, slide.layout)
    // (a) how many quotations
    const synthesised = options.linkOnly && quotes.length ? 1 : 0
    assert.equal(countQuoteBlocks(lines), quotes.length - synthesised, reason(`quotation count (compiler ${quotes.length})`))
    assert.equal(description.several, quotes.length > 1, reason('"several" matches the compiler'))
    // (b) the words and (c) the citation of the first quotation
    const compiledWords = first ? first.paragraphs.join(' ') : ''
    const readWords = read.paragraphs.join(' ')
    assert.equal(plainInlineText(readWords), plainInlineText(compiledWords), reason(`quoted words (compiler "${compiledWords}")`))
    const compiledCite = first && !first.citeFromTitle ? first.cite : ''
    // A lone line stands as the source only when it would draw a form (annotateQuoteForm); the reader keeps the line
    // as the source either way, and the form check below shows the two agree on what is drawn.
    if (!options.linkOnly || first) assert.equal(read.cite, compiledCite, reason(`citation (compiler "${compiledCite}")`))
    // (d) the form shown
    const compiledForm = first?.quoteForm?.form ?? 'plain'
    const readForm = description.several || description.otherContent || description.refused || description.unbuilt ? 'plain' : description.form
    assert.equal(readForm, compiledForm, reason(`form shown (compiler ${compiledForm})`))
    // Pictures never count as other content: two pictures beside the quotation still draw the form.
    if (/two pictures/.test(label)) assert.equal(compiledForm, 'tweet', reason('the form draws; extra pictures are not drawn'))
    // The Inspector's presentation is Plain exactly when the compiled slide carries no form.
    assert.equal(description.presentation !== 'plain', Boolean(first?.quoteForm), reason(`presentation ${description.presentation} agrees with the compiled form`))
    verdicts.push(`${label}: ${quotes.length} quote(s), ${compiledForm}`)
    // The writers, on a slide with exactly one quotation (or a source line standing for one).
    if (quotes.length !== 1) continue
    let text = outline
    text = setQuoteForm(text, id, 'plain', slide.layout).outline
    text = setQuoteForm(text, id, 'auto', slide.layout).outline
    // (A row that already carries a form token is cleared by Automatic, so only the others come back unchanged.)
    if (!/form=/.test(options.trigger ?? '')) assert.equal(text, outline, reason('Plain then Automatic returns the outline byte for byte'))
    const newSource = { text: 'New Name', link: X2 }
    const written = setQuoteSource(outline, id, newSource, slide.layout).outline
    const again = (await compile([written.split('\n').slice(4).join('\n').trim()])).model.slides.find((candidate) => candidate.id === id)
    const againQuotes = (again.blocks || []).filter((block) => block.type === 'quote' && !block.practice)
    assert.equal(againQuotes.length, 1, reason('still one quotation after the source is set'))
    assert.equal(againQuotes[0].cite, `New Name ${X2}`, reason(`the new source is the citation (${againQuotes[0].cite})`))
    assert.equal(againQuotes[0].citeFromTitle, undefined, reason('and not the title'))
    assert.equal(againQuotes[0].paragraphs.join(' '), first.paragraphs.join(' '), reason('the quoted words are untouched'))
    const stray = (again.blocks || []).filter((block) => block.type !== 'quote' && block.type !== 'image' && block.type !== 'image-row' && /Name|Lakoff|Sample/.test(JSON.stringify(block)))
    // (When the lexer read no source, a leftover bullet is a list the author wrote, not a source.)
    if (compiledCite) assert.deepEqual(stray, [], reason('no second source line is left beside the quotation'))
    if (/bullet list follows/.test(label)) {
      const listItems = (again.blocks || []).filter((block) => /list/.test(block.type)).flatMap((block) => block.items ?? [])
      assert.equal(listItems.length, 2, reason(`the list still has its two items (${JSON.stringify(listItems)})`))
    }
    if (compiledCite) assert(!written.includes(compiledCite), reason('the old source is gone from the outline'))
    assert.equal(written.split('\n').length - outline.split('\n').length <= 2, true, reason('at most a blank line and a source line are added'))
  }
  assert(verdicts.length >= rows.length - 4, 'the table was read')
  if (process.env.QUOTE_PARITY_VERBOSE) console.log(verdicts.join('\n'))
  // In-block hyphen attribution is replaced in place, keeping the `> - ` as written.
  const hyphen = setQuoteSource(doc(slideOf(0, `> Words.\n> - ${N}`, '{quote}')), 'r0', { text: 'New Name', link: X2 }, 'quote').outline
  assert(hyphen.includes(`\n> Words.\n> - New Name ${X2}\n`) && !hyphen.includes(N), 'a "> - " source is replaced in place, prefix kept')
  const bare = setQuoteSource(doc(slideOf(0, `> Words.\n>—${N}`, '{quote}')), 'r0', { text: 'New Name' }, 'quote').outline
  assert(bare.includes(`\n>—New Name ${X}\n`), 'a "> —" source with no space keeps its prefix and the link it had')
}

{
  // References pasted from a reference manager (Chicago, MLA, APA): quote-reference-styles.mjs. Each row is
  // (source line, authors, othersUnknown, title, year, container, volume/issue/pages, doi).
  const SOL = 'Solaiman, Irene, Miles Brundage, Jack Clark, et al. “Release Strategies and the Social Impacts of Language Models.” arXiv:1908.09203. Preprint, arXiv, November 13, 2019. [https://doi.org/10.48550/arXiv.1908.09203](https://doi.org/10.48550/arXiv.1908.09203)'
  const SOL_DOI = '10.48550/arXiv.1908.09203'
  const SOL_TITLE = 'Release Strategies and the Social Impacts of Language Models'
  const SOL_THREE = ['Irene Solaiman', 'Miles Brundage', 'Jack Clark']
  const MIND = 'https://doi.org/10.1093/mind/LIX.236.433'
  const rows = [
    ['Solaiman Chicago', SOL, SOL_THREE, true, SOL_TITLE, '2019', 'arXiv', '//', SOL_DOI],
    ['Solaiman APA', 'Solaiman, I., Brundage, M., Clark, J., et al. (2019). Release strategies and the social impacts of language models. *arXiv*. https://doi.org/10.48550/arXiv.1908.09203', ['I. Solaiman', 'M. Brundage', 'J. Clark'], true, 'Release strategies and the social impacts of language models', '2019', 'arXiv', '//', SOL_DOI],
    ['Solaiman MLA', 'Solaiman, Irene, et al. “Release Strategies and the Social Impacts of Language Models.” arXiv, 13 Nov. 2019, https://doi.org/10.48550/arXiv.1908.09203.', ['Irene Solaiman'], true, SOL_TITLE, '2019', 'arXiv', '//', SOL_DOI],
    ['et al. without a comma', 'Solaiman, Irene, Miles Brundage et al. “A Title.” *Some Journal* 3 (4): 10–19. ' + MIND, ['Irene Solaiman', 'Miles Brundage'], true, 'A Title', '', 'Some Journal', '3/4/10–19', '10.1093/mind/LIX.236.433'],
    ['Chicago two authors', 'Lakoff, George, and Mark Johnson. “The Metaphorical Structure of the Human Conceptual System.” *Cognitive Science* 4 (2): 195–208. 1980. ' + MIND, ['George Lakoff', 'Mark Johnson'], false, 'The Metaphorical Structure of the Human Conceptual System', '1980', 'Cognitive Science', '4/2/195–208', '10.1093/mind/LIX.236.433'],
    ['Chicago one author, abbreviated pages', 'Turing, Alan M. “Computing Machinery and Intelligence.” *Mind* 59, no. 236 (1950): 433–60. ' + MIND, ['Alan M. Turing'], false, 'Computing Machinery and Intelligence', '1950', 'Mind', '59/236/433–460', '10.1093/mind/LIX.236.433'],
    ['Zotero Chicago, journal not italic', 'Turing, Alan M. “Computing Machinery and Intelligence.” Mind 59 (236): 433–60. 1950. ' + MIND, ['Alan M. Turing'], false, 'Computing Machinery and Intelligence', '1950', 'Mind', '59/236/433–460', '10.1093/mind/LIX.236.433'],
    ['APA, three authors with ampersand', 'Brundage, M., Clark, J., & Solaiman, I. (2020). Is it safe? *Journal of AI*, *12*(3), 100–120. https://doi.org/10.1000/xyz', ['M. Brundage', 'J. Clark', 'I. Solaiman'], false, 'Is it safe?', '2020', 'Journal of AI', '12/3/100–120', '10.1000/xyz'],
    ['MLA vol. and no.', 'Turing, Alan. “Computing Machinery and Intelligence.” Mind, vol. 59, no. 236, 1950, pp. 433–60. ' + MIND, ['Alan Turing'], false, 'Computing Machinery and Intelligence', '1950', 'Mind', '59/236/433–460', '10.1093/mind/LIX.236.433'],
    ['title ends with a question mark', 'Smith, Jane. “Is Metaphor Special?” *Language* 5 (1): 1–9, 2001. ' + MIND, ['Jane Smith'], false, 'Is Metaphor Special?', '2001', 'Language', '5/1/1–9', '10.1093/mind/LIX.236.433'],
    ['the spec Turing line, unchanged', 'A. M. Turing, "Computing Machinery and Intelligence", *Mind* 59(236), October 1950, pp. 433–460, p. 460 ' + MIND, ['A. M. Turing'], false, 'Computing Machinery and Intelligence', '1950', 'Mind', '59/236/433–460', '10.1093/mind/LIX.236.433'],
    ['spec syntax with three authors, no et al.', 'A One, B Two, C Three, "T", *J*, 2020', ['A One', 'B Two', 'C Three'], false, 'T', '2020', 'J', '//', '']
  ]
  for (const [name, line, authors, others, title, year, container, vip, doi] of rows) {
    const f = readFields('paper', parseSourceLine(line))
    assert.deepEqual(f.authors, authors, `${name}: authors`)
    assert.equal(Boolean(f.othersUnknown), others, `${name}: othersUnknown`)
    assert.equal(f.title, title, `${name}: title`)
    assert.equal(f.year, year, `${name}: year`)
    assert.equal(f.journal, container, `${name}: container`)
    assert.equal([f.volume, f.issue, f.pages].join('/'), vip.includes('/') && vip !== '//' ? vip : '//', `${name}: volume/issue/pages`)
    assert.equal(f.doi, doi, `${name}: doi`)
  }
  // Display: unknown others never get a count; known others keep "and N more".
  const sol = readFields('paper', parseSourceLine(SOL))
  assert.equal(sol.authorsDisplay, 'Irene Solaiman, Miles Brundage, Jack Clark and others')
  assert.equal(sol.month, 'November')
  assert.equal(sol.identifier, 'arXiv:1908.09203')
  assert.equal(pageHeadParts(sol).issueLine, 'arXiv:1908.09203 · November 2019', 'the id and the month on the issue line')
  assert.equal(readFields('paper', parseSourceLine('Lakoff, George, et al. “T.” *J*, 2001')).authorsDisplay, 'George Lakoff and others')
  assert.equal(readFields('paper', parseSourceLine('A One, B Two, C Three, D Four, "T", *J*, 2020')).authorsDisplay, 'A One, B Two, C Three and 1 more')
  // A reference that cannot be read draws what it has and does not throw.
  const bare = readFields('paper', parseSourceLine('Solaiman, Irene. 2019. https://doi.org/10.1000/xyz'))
  assert.equal(typeof bare.title, 'string')
  assert.doesNotThrow(() => readFields('paper', parseSourceLine('Smith, J. (2019). ')))
  // Books: the same author and year reading, the publisher without the city; detection is unchanged.
  const lakoff = 'Lakoff, George, and Mark Johnson. *Metaphors We Live By*. Chicago: University of Chicago Press, 1980.'
  const book = readFields('book', parseSourceLine(lakoff))
  assert.deepEqual([book.authors, book.title, book.publisher, book.year], [['George Lakoff', 'Mark Johnson'], 'Metaphors We Live By', 'University of Chicago Press', '1980'])
  assert.equal(detectQuoteForm(parseSourceLine(lakoff)).form, 'plain', 'a pasted book line is still not detected as a book without a page')
  const apaBook = readFields('book', parseSourceLine('Lakoff, G., & Johnson, M. (1980). *Metaphors we live by*. University of Chicago Press.'))
  assert.deepEqual([apaBook.authorsDisplay, apaBook.publisher, apaBook.year], ['G. Lakoff and M. Johnson', 'University of Chicago Press', '1980'])
  // Hostile input stays cheap.
  for (const hostile of ['“,'.repeat(1000), 'a. “'.repeat(500), ',"'.repeat(1000), 'A, a. *'.repeat(300), '(2019). '.repeat(250)]) {
    const t0 = performance.now()
    readFields('paper', parseSourceLine(hostile)); readFields('book', parseSourceLine(hostile))
    assert(performance.now() - t0 < 50, `a 2,000-character hostile line completes in under 50 ms (${(performance.now() - t0).toFixed(1)})`)
  }
  // The renderer: the Solaiman slide as Paper, and the outer marks of the words.
  const typed = '“We believe that a combination of staged release and partnership-based model sharing is likely to be key.”'
  const { section: sec } = await compile([
    `### Pasted {id=pr-sol}\n{quote form=paper}\n\n> ${typed}\n\n- ${SOL}`,
    `### Panel {id=pr-panel}\n{quote form=paper}\n\n![Page](assets/sample-speaker.png)\n\n> ${typed}\n\n- ${SOL}`,
    `### Tweet {id=pr-tweet}\n{quote}\n\n> "Quoted in straight marks."\n\n- Name ${X}`,
    `### Inner {id=pr-inner}\n{quote form=paper}\n\n> “He said “yes” and she said “no”.”\n\n- ${SOL}`,
    `### Two {id=pr-two}\n{quote form=paper}\n\n> “First” and “second”\n\n- ${SOL}`
  ])
  const page = sec('pr-sol')
  assert(page.includes('qf-paper'), 'the Solaiman line is a paper')
  assert(page.includes('<p class="qf-page-authors">Irene Solaiman, Miles Brundage, Jack Clark and others</p>'), 'authors: three and others')
  assert(page.includes('<p class="qf-page-title">Release Strategies and the Social Impacts of Language Models</p>'), 'title without the full stop')
  assert(page.includes('<b>arXiv</b><span>arXiv:1908.09203 · November 2019</span>'), 'head arXiv, id and month on the issue line')
  assert(page.includes('<mark>We believe that') && page.includes('is likely to be key.</mark>') && !page.includes('<mark>“'), 'the highlighted words have no outer marks')
  assert(sec('pr-panel').includes('<p>We believe that') && !sec('pr-panel').includes('<p>“'), 'panel: no outer marks')
  assert(sec('pr-tweet').includes('<p>Quoted in straight marks.</p>'), 'tweet: straight outer marks removed')
  assert(sec('pr-inner').includes('<mark>He said “yes” and she said “no”.</mark>'), 'inner marks stay')
  assert(sec('pr-two').includes('<mark>“First” and “second”</mark>'), 'two pairs are not one outer pair')
}

// A DOI holding ; ( ) < > : runs to whitespace; only the very end loses sentence punctuation or an unopened ).
{
  const SICI = '10.1002/(SICI)1097-4571(199009)41:6<391::AID-ASI1>3.0.CO;2-9'
  const doiOf = (line) => parseSourceLine(line)
  for (const line of [`A, "T", *J* 41(6), 1990, p. 391 doi:${SICI}`, `A, "T", *J* 41(6), 1990, p. 391 ${SICI}`]) {
    const parsed = doiOf(line)
    assert.equal(parsed.link.url, `https://doi.org/${SICI}`, `the whole DOI is the link: ${line}`)
    assert.equal(readFields('paper', parsed).doi, SICI)
    assert.equal(readFields('paper', parsed).page, '391', 'the page is still read, no DOI residue in the text')
  }
  assert.equal(doiOf(`A, "T" doi:${SICI}.`).link.url, `https://doi.org/${SICI}`, 'a closing full stop is trimmed')
  assert.equal(doiOf(`A, "T" doi:${SICI};`).link.url, `https://doi.org/${SICI}`, 'a closing semicolon is trimmed')
  assert.equal(doiOf('A, "T" (doi:10.1000/xyz)').link.url, 'https://doi.org/10.1000/xyz', 'a ) that closes a bracket before the DOI is trimmed')
  assert.equal(doiOf('A, "T" doi:10.1000/a(b)').link.url, 'https://doi.org/10.1000/a(b)', 'a balanced ) stays')
  assert.equal(doiOf('A, "T", p. 5 doi:10.1000/xyz, 1990').link.url, 'https://doi.org/10.1000/xyz', 'a comma then a space ends it')
}

console.log('quote forms: parser, detection, fit and refusal, compile, registry, verbs, notes, palette and the unchanged quote baseline pass')
