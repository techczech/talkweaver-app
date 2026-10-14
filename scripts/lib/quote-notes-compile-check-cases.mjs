// Fourth review round of quote forms ticket 10 (13 October): speaker notes, and the check by compiling.
// Run by scripts/test-quote-forms-address-under-quote.mjs (section E). Plain Node.
//
//   E1. Speaker notes are not content. Over generated slides (a `>` quotation and a quoted paragraph; a `{reveal}`
//       line or none; a notes block before the quotation, between it and the link with and without blank lines
//       around, and after the link; a bare address and a source line; LF and CRLF; the layouts the compiler gave and
//       a caller that says `quote` for every slide) the link-edit rule either writes nothing, or writes a form after
//       which the compiler reads the words it read before the edit, draws that form and cites the typed link.
//       The reviewer's two reproductions (the address typed straight under the notes of a quoted paragraph) write
//       nothing. `set-quote-source` on the same slides: unchanged, or the same words and the source that was set.
//       And the reader alone, with the form set by hand on every slide: `describe-quote-source` says what the compiler
//       draws (a form with words, a form waiting for words, or a plain quote), notes or no notes.
//       Sixth round: `set-quote-source` on the slides that already hold the link (the address under the quotation, or
//       a source line; with no form and with the form set by hand): unchanged, or the full compiler shows the same
//       displayed words without the source (`displayedWords`), the same words for every quotation, and the source
//       that was set. The words are compared in full: a slide the compiler reads as one paragraph has no quotation
//       whose words could be compared.
//   E2. The check by compiling, asked directly (src/shared/quote-write-check.ts): told that a slide is a quotation
//       with its address where the compiler reads one paragraph, it says no; so it does for a card that is still
//       drawn, another link and other content. (Fifth round: a slide it cannot read at all is not a "no"; that, the
//       containers and the poll and icon shapes are in scripts/lib/quote-drawn-form-cases.mjs.)
import { strict as assert } from 'node:assert'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSource } from '../../compiler/scripts/lib/08-source-adapters.mjs'
import { parseSourceLine } from '../../compiler/scripts/lib/quote-forms.mjs'
import { LayoutVerbError, describeQuoteSource, setFormOnLinkEdits, setQuoteSource } from '../../src/shared/layout-verbs.ts'
import { compiledQuoteAt, quoteFormWriteHolds, quoteSourceWriteHolds } from '../../src/shared/quote-write-check.ts'
import { compiledQuotations, displayedWords } from './quote-drawn-form-slides.mjs'

const WEB = 'https://example.org/schemas-and-propositions'
const DOI = 'https://doi.org/10.1000/xyz123'
const HEAD = '# Talk\n\n## Section\n\n'
export const NOTES = ':::notes\nsecret words for the speaker\n:::'

/** The quotation of a compiled slide: its words, paragraph by paragraph ([] when it has none). */
export const compiledWords = (slide) => {
  const quote = slide?.blocks?.find((block) => block.type === 'quote' && !block.practice)
  if (!quote) return []
  return (Array.isArray(quote.paragraphs) && quote.paragraphs.length ? quote.paragraphs : [quote.text ?? '']).filter((paragraph) => String(paragraph).trim())
}
export const compiledLink = (slide) => parseSourceLine(slide?.blocks?.find((block) => block.type === 'quote' && !block.practice)?.cite ?? '').link?.url ?? ''

export const compilerIn = (dir) => async (text) => {
  const path = join(dir, `e-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(path, text)
  return prepareSource(path, text, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
}

// Where the notes block stands. `q` is the quotation with any `{reveal}` line under it, `link` the link's line (absent
// in the text before the edit).
const PLACES = [
  ['before the quotation', (q, link) => [NOTES, '', ...q, '', ...link]],
  ['before the quotation, no blank line', (q, link) => [NOTES, ...q, '', ...link]],
  ['between, a blank line each side', (q, link) => [...q, '', NOTES, '', ...link]],
  ['between, a blank line before only', (q, link) => [...q, '', NOTES, ...link]],
  ['between, a blank line after only', (q, link) => [...q, NOTES, '', ...link]],
  ['between, no blank line', (q, link) => [...q, NOTES, ...link]],
  ['after the link', (q, link) => [...q, '', ...link, '', NOTES]],
  ['after the link, no blank line', (q, link) => [...q, '', ...link, NOTES]],
  ['after the link, never closed', (q, link) => [...q, '', ...link, '', ':::notes', 'secret words']]
]

export async function notesCases(dir) {
  const compileText = compilerIn(dir)
  const rows = []
  for (const trigger of ['{id=ID quote}', '{id=ID}']) for (const reveal of [false, true]) for (const words of ['> Words of the quotation.', '"Words of the quotation."']) for (const [place, lay] of PLACES) for (const shape of ['address', 'source']) rows.push({ trigger, reveal, words, place, lay, shape })
  const linkOf = (index) => (index % 4 === 3 ? DOI : WEB)
  const linkLine = (row, index) => (row.shape === 'address' ? linkOf(index) : `- Jane Example ${linkOf(index)}`)
  const slideText = (row, index, withLink) => ['### Quote', row.trigger.replace('ID', `n${index}`), '', ...row.lay([row.words, ...(row.reveal ? ['{reveal}'] : [])], withLink ? [linkLine(row, index)] : [])].join('\n')
  const label = (row, index) => `${row.words[0] === '>' ? 'a > quotation' : 'a quoted paragraph'}, ${row.trigger}, ${row.reveal ? '{reveal}, ' : ''}notes ${row.place}, ${row.shape}: ${JSON.stringify(slideText(row, index, true))}`
  const counts = { slides: 0, written: 0, notWritten: 0, forced: 0, crlf: 0, source: 0, sourceUnchanged: 0, described: 0, describedAwaiting: 0, describedPlain: 0, edited: 0, editedAddress: 0, editedParagraph: 0, editedUnchanged: 0 }
  const OTHER = 'https://other.example/another-page'
  for (const eol of ['\n', '\r\n']) {
    const text = (withLink) => `${HEAD}${rows.map((row, index) => slideText(row, index, withLink)).join('\n\n')}\n`.replace(/\n/g, eol)
    const before = text(false)
    const after = text(true)
    assert.equal(before.includes('\r'), eol === '\r\n')
    const compiledBefore = await compileText(before)
    const compiledAfter = await compileText(after)
    const layoutAt = new Map(compiledAfter.slides.map((slide) => [slide.sourceLine, slide.layout]))
    for (const [caller, layout] of [['the compiler\'s layouts', (line) => layoutAt.get(line)], ['a caller that says quote', () => 'quote']]) {
      const written = setFormOnLinkEdits(before, after, layout)
      const recompiled = await compileText(written.outline)
      rows.forEach((row, index) => {
        const id = `n${index}`
        const form = written.outline.match(new RegExp(`\\{id=${id}\\b[^\\n]*?form=(web|paper)`))?.[1] ?? null
        counts.slides += 1
        // The reviewer's reproduction, and every shape of it: the address typed straight under the notes of a quoted
        // paragraph is one paragraph to the compiler (the notes are dropped), so there is no quotation to keep.
        if (row.words[0] === '"' && row.shape === 'address' && row.place === 'between, no blank line') assert.equal(form, null, `no form is written (${caller}): ${label(row, index)}`)
        // And the plain case stays written: notes with a blank line each side of them are not content.
        if (row.place === 'between, a blank line each side' && (row.trigger.includes('quote') || row.shape === 'source')) assert.notEqual(form, null, `notes between blank lines are not content, the form is written (${caller}): ${label(row, index)}`)
        if (!form) return void (counts.notWritten += 1)
        const slide = recompiled.slides.find((candidate) => candidate.id === id)
        const wordsBefore = compiledWords(compiledBefore.slides.find((candidate) => candidate.id === id))
        assert(wordsBefore.length > 0, `the slide had a quotation before the edit: ${label(row, index)}`)
        assert.deepEqual(compiledWords(slide), wordsBefore, `the editor wrote ${form} (${caller}) and the quotation's words changed: ${label(row, index)}`)
        assert.equal(slide.layout, 'quote', `the editor wrote ${form} (${caller}) on a slide the compiler does not make a quote slide: ${label(row, index)}`)
        const quote = slide.blocks.find((block) => block.type === 'quote')
        assert.deepEqual([quote.quoteForm?.form, quote.quoteForm?.awaiting], [form, false], `the editor wrote ${form} (${caller}) and the compiler does not draw it with its words: ${label(row, index)}`)
        assert.equal(compiledLink(slide), linkOf(index), `the editor wrote ${form} (${caller}) and the compiler cites another link: ${label(row, index)}`)
        assert(!slide.blocks.some((block) => ['embed', 'video', 'audio'].includes(block.type)), `the editor wrote ${form} (${caller}) and a card is still drawn: ${label(row, index)}`)
        counts.written += 1
        if (caller !== 'the compiler\'s layouts') counts.forced += 1
        if (eol === '\r\n') counts.crlf += 1
      })
    }
    // The verbs' reader on its own: with the form set by hand, what `describe-quote-source` reports is what the
    // compiler draws. (Notes blanked instead of dropped would report words where the compiler finds none.)
    const chosen = after.replace(/\{id=(n\d+)[^}\n]*\}/g, '{id=$1 quote form=web}')
    const compiledChosen = await compileText(chosen)
    rows.forEach((row, index) => {
      const id = `n${index}`
      const drawn = compiledChosen.slides.find((candidate) => candidate.id === id).blocks.find((block) => block.type === 'quote' && !block.practice)?.quoteForm
      const described = describeQuoteSource(chosen, id, 'quote')
      assert.deepEqual([described.presentation !== 'plain', described.awaitingWords], [Boolean(drawn), drawn ? drawn.awaiting : described.awaitingWords], `describe-quote-source and the compiler disagree (the compiler: ${drawn ? `${drawn.form}${drawn.awaiting ? ', no words' : ''}` : 'a plain quote'}): ${label(row, index)}`)
      counts.described += 1
      if (drawn?.awaiting) counts.describedAwaiting += 1
      if (!drawn) counts.describedPlain += 1
    })
    // set-quote-source on the slides before the link: every slide in turn on the one text, then one compile.
    const layoutBefore = new Map(compiledBefore.slides.map((slide) => [slide.id, slide.layout]))
    let sourced = before
    const set = new Set()
    rows.forEach((row, index) => {
      const id = `n${index}`
      try {
        const next = setQuoteSource(sourced, id, { text: 'Jane Example', link: linkOf(index) }, layoutBefore.get(id)).outline
        if (next !== sourced) set.add(id)
        else counts.sourceUnchanged += 1
        sourced = next
      } catch (error) {
        if (!(error instanceof LayoutVerbError)) throw error
        counts.sourceUnchanged += 1
      }
    })
    assert.equal(sourced.split('\n').filter((line) => /notes|secret|^:::/.test(line)).join('\n'), before.split('\n').filter((line) => /notes|secret|^:::/.test(line)).join('\n'), 'set-quote-source leaves every notes line as typed')
    const compiledSourced = await compileText(sourced)
    rows.forEach((row, index) => {
      const id = `n${index}`
      if (!set.has(id)) return
      const slide = compiledSourced.slides.find((candidate) => candidate.id === id)
      assert.deepEqual(compiledWords(slide), compiledWords(compiledBefore.slides.find((candidate) => candidate.id === id)), `set-quote-source changed the quotation's words: ${label(row, index)}`)
      assert.deepEqual(displayedWords(slide), displayedWords(compiledBefore.slides.find((candidate) => candidate.id === id)), `set-quote-source changed the slide's displayed words: ${label(row, index)}`)
      const cite = slide.blocks.find((block) => block.type === 'quote')?.cite ?? ''
      assert(cite.includes('Jane Example') && cite.includes(linkOf(index)), `set-quote-source wrote a source the compiler does not read (${JSON.stringify(cite)}): ${label(row, index)}`)
      counts.source += 1
    })
    // Sixth round: the source edited where the link is already there (a bare address under the quotation, or a
    // source line), notes before, between and after. Every slide in turn on the one text, then one compile.
    for (const [state, start, compiledStart] of [['no form', after, compiledAfter], ['the form set by hand', chosen, compiledChosen]]) {
      const layoutStart = new Map(compiledStart.slides.map((slide) => [slide.id, slide.layout]))
      let edited = start
      const set = new Set()
      rows.forEach((row, index) => {
        const id = `n${index}`
        let next = edited
        try {
          next = setQuoteSource(edited, id, { text: 'Ann Other', link: OTHER }, layoutStart.get(id)).outline
        } catch (error) {
          if (!(error instanceof LayoutVerbError)) throw error
        }
        if (next !== edited) set.add(id)
        else counts.editedUnchanged += 1
        edited = next
      })
      assert.equal(edited.split('\n').filter((line) => /notes|secret|^:::/.test(line)).join('\n'), start.split('\n').filter((line) => /notes|secret|^:::/.test(line)).join('\n'), 'set-quote-source leaves every notes line as typed')
      const compiledEdited = await compileText(edited)
      rows.forEach((row, index) => {
        const id = `n${index}`
        const was = compiledStart.slides.find((candidate) => candidate.id === id)
        const why = `(${state}): ${label(row, index)}`
        // The reviewer's reproduction, every shape of it: one paragraph to the compiler, so no quotation to attribute.
        if (state === 'no form' && compiledQuotations(was).length === 0) assert(!set.has(id), `set-quote-source wrote on a slide the compiler reads no quotation on ${why}`)
        if (state === 'no form' && row.words[0] === '"' && row.shape === 'address' && row.place === 'between, no blank line') assert(!set.has(id) && compiledQuotations(was).length === 0, `the address joined to a quoted paragraph across its notes: nothing is written ${why}`)
        if (!set.has(id)) return
        const slide = compiledEdited.slides.find((candidate) => candidate.id === id)
        assert.deepEqual(displayedWords(slide), displayedWords(was), `set-quote-source changed the slide's displayed words ${why}`)
        assert.deepEqual(compiledQuotations(slide).map((quote) => quote.words), compiledQuotations(was).map((quote) => quote.words), `set-quote-source changed a quotation's words ${why}`)
        assert(compiledQuotations(slide).some((quote) => quote.cite.includes('Ann Other') && quote.cite.includes(OTHER)), `set-quote-source wrote a source the compiler does not read ${why}`)
        counts.edited += 1
        if (row.shape === 'address') counts.editedAddress += 1
        if (row.words[0] === '"') counts.editedParagraph += 1
      })
    }
  }
  assert(counts.written >= 150 && counts.notWritten >= 16 && counts.forced >= 60 && counts.crlf >= 60 && counts.source >= 150 && counts.described >= 280 && counts.describedAwaiting >= 8 && counts.edited >= 150 && counts.editedAddress >= 60 && counts.editedParagraph >= 60 && counts.editedUnchanged >= 60, `the statement is not empty: ${JSON.stringify(counts)}`)
  return `speaker notes: ${rows.length} slides × LF/CRLF × 2 callers, a form written on ${counts.written} (${counts.forced} of them for a caller that says quote, ${counts.crlf} CRLF) and nothing on ${counts.notWritten}; every written form recompiles to the same words, that form and the typed link; set-quote-source wrote ${counts.source} sources the compiler reads with the same words (${counts.sourceUnchanged} left unchanged); describe-quote-source agrees with the compiler on ${counts.described} slides with the form set (${counts.describedAwaiting} of them with no words to the compiler); set-quote-source on the slides that already hold the link wrote ${counts.edited} sources (${counts.editedAddress} where a bare address stood, ${counts.editedParagraph} on a quoted paragraph) with the same displayed words to the full compiler, and left ${counts.editedUnchanged} unchanged`
}

export function compileCheckCases() {
  const slide = (body, trigger = '{id=q quote}') => `${HEAD}### Q\n${trigger}\n\n${body}\n`
  const web = (body) => slide(body, '{id=q quote form=web}')
  const LINE = 5
  // A reader that says "a quotation and its address" for the reviewer's slide: the compiler drops the notes and
  // reads one paragraph, so the words would become part of the source. The check says no.
  const body = `"Words."\n${NOTES}\nhttps://example.org`
  const wrong = { headingLine: LINE, written: web(body), withoutToken: slide(body), withoutLink: slide(`"Words."\n${NOTES}`), form: 'web', link: 'https://example.org', quotation: true }
  assert.deepEqual([compiledQuoteAt(wrong.written, LINE).words, compiledQuoteAt(wrong.written, LINE).awaiting, compiledQuoteAt(wrong.withoutLink, LINE).words], [[], true, ['Words.']], 'the compiler reads no words once the form is written, and the words without the link')
  assert.equal(quoteFormWriteHolds(wrong), false, 'a reader that reports a quotation and its address where the compiler reads one paragraph: no write')
  // The same slide claimed as a source line alone: the words would still be lost, so no.
  assert.equal(quoteFormWriteHolds({ ...wrong, quotation: false }), false, 'nor as a slide that is only its source line: a quotation is there without the link')
  // What the rule means, and each way the compiler can disagree with it.
  const good = (over = {}) => ({ headingLine: LINE, written: web(`> Words.\n\n${WEB}`), withoutToken: slide(`> Words.\n\n${WEB}`), withoutLink: slide('> Words.\n'), form: 'web', link: WEB, quotation: true, ...over })
  assert.equal(quoteFormWriteHolds(good()), true, 'a quotation and its address: written')
  assert.equal(quoteFormWriteHolds(good({ written: web(`> Words.\n\n- Jane Example ${WEB}`), withoutToken: slide(`> Words.\n\n- Jane Example ${WEB}`) })), true, 'a quotation and its source line: written')
  assert.equal(quoteFormWriteHolds(good({ written: slide(`- Jane Example ${WEB}`, '{id=q quote form=web}'), withoutToken: slide(`- Jane Example ${WEB}`), withoutLink: slide(''), quotation: false })), true, 'a quote slide that is only its source line: written, with no words before or after')
  for (const [why, over] of [
    ['another link is cited', { link: DOI }],
    ['the form is not the one in effect', { form: 'paper' }],
    ['the slide takes its child headings into a carousel', { written: web(`> Words.\n\n${WEB}\n\n{carousel}\n\n#### One\n\nText.`) }],
    ['a video is drawn', { written: web(`![Video](movie.mp4)\n\n> Words.\n\n${WEB}`) }],
    ['the card is still drawn (a source line and an address)', { written: web(`> Words.\n\n- Jane Example\n\n${WEB}`) }],
    ['there is other content', { written: web(`> Words.\n\n${WEB}\n\nA paragraph.`) }],
    ['there are two quotations', { written: web(`> Words.\n\n${WEB}\n\n> More.`) }],
    ['the words are not the words without the token', { withoutToken: slide(`> Other words.\n\n${WEB}`) }],
    ['the words are not the words without the link', { withoutLink: slide('> Words.\n> More words.\n') }],
    ['the slide is not a quote slide', { written: `${HEAD}### Q\n{id=q form=web}\n\n- Jane Example ${WEB}\n`, quotation: false, withoutLink: slide('') }],
    ['the token is undone by a Trigger line among the content', { written: web(`> Words.\n{form=auto}\n\n${WEB}`) }]
  ]) assert.equal(quoteFormWriteHolds(good(over)), false, `no write when ${why}`)
  // The source line: the same words, and a source that holds what was written.
  const source = (over = {}) => ({ headingLine: LINE, before: slide('> Words.'), written: slide('> Words.\n\n- Jane Example https://example.org'), text: 'Jane Example', link: 'https://example.org', ...over })
  assert.equal(quoteSourceWriteHolds(source()), true, 'a source line under a quotation: written')
  // (Sixth round.) A slide that is only a list has no quotation to the compiler: there is none to attribute. With a
  // form it is a form waiting for words, the list item its source, and the source is written.
  assert.equal(quoteSourceWriteHolds(source({ before: slide('- Old'), written: slide('- Jane Example https://example.org') })), false, 'no quotation to the compiler: no write')
  assert.equal(quoteSourceWriteHolds(source({ before: web('- Old'), written: web('- Jane Example https://example.org') })), true, 'the source line of a slide that is only that, drawn in a form')
  assert.equal(quoteSourceWriteHolds(source({ written: slide('> Words.\n- Jane Example https://example.org\n> and more') })), false, 'no write when the words change')
  assert.equal(quoteSourceWriteHolds(source({ written: slide('> Words.\n\n- Somebody Else https://example.org') })), false, 'no write when the compiler reads another source')
  assert.equal(quoteSourceWriteHolds(source({ before: slide(`"Words."\n${NOTES}`), written: slide(`"Words."\n${NOTES}\n- Jane Example https://example.org`) })), true, 'a source line straight under the notes of a quoted paragraph is its attribution to the compiler')
  assert.equal(quoteSourceWriteHolds(source({ before: slide(`"Words."\n${NOTES}`), written: slide(`"Words."\n${NOTES}\nJane Example https://example.org`) })), false, 'a bare line there joins the paragraph: the words would be lost, no write')
  return 'the check by compiling: a wrong report of "a quotation and its address" is refused, with 11 other ways the compiler can disagree; the source-line check likewise'
}
