// test:quote-forms-base-regression — quote forms ticket 10, fifth review round (13 October). Plain Node: no browser, no network.
//
// Ticket 10 put a check by compiling in front of every write the quote verbs make. Each review round found shapes
// where that check, or the reading under it, took away a write the base made and the compiler drew. This states the
// whole of it against the base itself: `scripts/lib/quote-forms-07-base-*.{ts,mjs}` are the verbs of
// `origin/ticket/quote-forms-07-web-form` (quote forms ticket 07), frozen.
//
//   A. The link-edit rule. Over generated slides WITH ids where a link is typed on a source line (no bare address:
//      the base did not know it), scripts/lib/quote-base-regression-slides.mjs:
//        - wherever the base wrote a form AND the full compiler draws that form for the base's result, the rule
//          writes the same form now. There is no such slide the rule now leaves unwritten;
//        - wherever the rule writes now, the full compiler draws the form, with the words compiled before the edit.
//      "Draws" is asked of `prepareSource` and the page built from it (`drawnForm`): a slide of its own, the quote
//      layout, the form on its one quotation, no card, the typed link, and the form's figure on the page.
//   B. `set-quote-source`. On the same slides before the link is typed, on slides with no source line, and (sixth
//      round) on slides the compiler reads no quotation on, several quotations and an address already under the
//      quotation:
//        - wherever the verb writes now, the FULL compiler reads the same displayed words without the source
//          (`displayedWords`: every quotation's words, every paragraph, list item and card, folded children too) and
//          the same words for every quotation as before the write, and the source that was set on one quotation.
//          There is no call where the verb writes and a displayed word changes;
//        - the verb returns what the base verb returned, except: where it writes nothing and the base's result
//          changes the displayed words or a quotation's words, as the full compiler reads it (corrections; a slide
//          with no quotation to the compiler is among them, since there is no quotation to attribute); where the
//          compiler does not read the source the base wrote; where only the form differs and the form statement of A
//          holds for it; and on the shapes ticket 10 reads differently on purpose (a Trigger line or speaker notes
//          among the content, a video or an audio file, a picture with braces, an address under the quotation).
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFormOnLinkEdits, setQuoteSource } from '../src/shared/layout-verbs.ts'
import { setFormOnLinkEdits as setFormOnLinkEditsAtBase, setQuoteSource as setQuoteSourceAtBase } from './lib/quote-forms-07-base-layout-verbs.ts'
import { DOI, WEB, compiledQuotations, compiledWords, compilerIn, displayedWords, drawnForm, formOnModel, formWritten, inDecks, outlineOf, rowSlides } from './lib/quote-drawn-form-slides.mjs'
import { regressionRows, sectionOf, sourceRows } from './lib/quote-base-regression-slides.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-quote-base-'))
const compileText = compilerIn(dir)
// The verbs read the whole outline for every slide they write on, so the slides are compiled in small talks.
const DECK = 60
const tally = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1 }
const listed = (labels, most = 12) => `${labels.slice(0, most).join(' | ')}${labels.length > most ? ` | … ${labels.length - most} more` : ''}`

try {
  // ── A. The link-edit rule against the base ─────────────────────────────────────────────────────────────────────────
  {
    const rows = regressionRows()
    const counts = { both: 0, neither: 0, baseOnlyNeverDrawn: 0, baseOnlyPollFrame: 0, headOnly: 0 }
    const byKind = {}
    const headOnlyKinds = {}
    const neverDrawn = {}
    const lost = []
    for (const deck of inDecks(rows, DECK)) {
      const before = outlineOf(deck, false)
      const after = outlineOf(deck, true)
      const compiledBefore = await compileText(before)
      const compiledAfter = await compileText(after)
      const layoutAt = new Map(compiledAfter.slides.map((slide) => [slide.sourceLine, slide.layout]))
      const now = setFormOnLinkEdits(before, after, (line) => layoutAt.get(line))
      const base = setFormOnLinkEditsAtBase(before, after, (line) => layoutAt.get(line))
      const compiledNow = await compileText(now.outline)
      const compiledBase = await compileText(base.outline)
      for (const row of deck) {
        const label = `${row.label}: ${JSON.stringify(row.text(true))}`
        const formNow = formWritten(now.outline, row.id)
        const formBase = formWritten(base.outline, row.id)
        const wordsBefore = compiledWords(compiledBefore.slides.find((slide) => slide.id === row.id))
        tally(byKind, row.kind)
        // Whatever the rule writes now, the full compiler draws, with the same words.
        if (formNow) assert.equal(drawnForm(compiledNow, row.id, formNow, { wordsBefore, link: row.link }), '', `the rule wrote ${formNow} and the compiler does not draw it: ${label}`)
        if (formNow && formBase) {
          assert.equal(formNow, formBase, `the rule and the base wrote different forms: ${label}`)
          counts.both += 1
        } else if (formBase) {
          const why = drawnForm(compiledBase, row.id, formBase, { link: row.link })
          if (why === '') lost.push(label)
          else {
            counts.baseOnlyNeverDrawn += 1
            tally(neverDrawn, why.replace(/ \(.*\)$/, ''))
            // The model alone would say "drawn" here; the page shows the poll's frame in place of the quotation.
            if (formOnModel(compiledBase, row.id, formBase)) counts.baseOnlyPollFrame += 1
          }
        } else if (formNow) {
          counts.headOnly += 1
          tally(headOnlyKinds, row.kind)
        } else counts.neither += 1
      }
    }
    assert.deepEqual(lost, [], `the base wrote a form the compiler draws, and the rule now writes none, on ${lost.length} slides: ${listed(lost, 6)}`)
    console.log(`the link-edit rule against the base (quote forms 07) on ${rows.length} slides with a link typed on a source line (${Object.entries(byKind).map(([kind, count]) => `${kind} ${count}`).join(', ')}):`)
    console.log(`  both write the same form: ${counts.both}; neither writes: ${counts.neither}`)
    console.log(`  the base wrote and the rule does not: ${counts.baseOnlyNeverDrawn + lost.length}, of them drawn by the compiler: ${lost.length}; never drawn (corrections): ${counts.baseOnlyNeverDrawn} (${Object.entries(neverDrawn).map(([why, count]) => `${count}: ${why}`).join('; ')})`)
    console.log(`    ${counts.baseOnlyPollFrame} of those carry the form on the model, and the page shows the poll's frame in place of the quotation`)
    console.log(`  the rule writes and the base did not (each drawn by the compiler): ${counts.headOnly} (${Object.entries(headOnlyKinds).map(([kind, count]) => `${kind} ${count}`).join(', ')})`)
    assert(counts.both >= 1000 && counts.neither >= 150 && counts.baseOnlyNeverDrawn >= 20 && counts.baseOnlyPollFrame >= 4, `the statement is not empty: ${JSON.stringify(counts)}`)
    // The rule writes where the base did not only on shapes ticket 10 reads on purpose: a Trigger line among the
    // content (third round), and a picture with braces after it (the ticket's listed correction).
    assert.deepEqual(Object.keys(headOnlyKinds).filter((kind) => !['body trigger', 'beside the quotation'].includes(kind)), [], `the rule writes where the base did not on other shapes: ${JSON.stringify(headOnlyKinds)}`)
  }

  // ── B. set-quote-source against the base ───────────────────────────────────────────────────────────────────────────
  {
    const rows = sourceRows()
    const INPUTS = [{ text: 'Ann Other' }, { text: 'Ann Other', link: WEB }, { link: DOI }, { text: '"New source"' }]
    const counts = { calls: 0, written: 0, writtenUndrawn: 0, identicalWritten: 0, identicalUnchanged: 0, withheldCorrection: 0, withheldNoQuotation: 0, withheldShown: 0, formOnlyBase: 0, formOnlyNow: 0, readOnPurpose: 0 }
    const purposeKinds = {}
    const correctionKinds = {}
    const writtenKinds = {}
    // What a source write must leave as it was: the displayed words without the source, and every quotation's words.
    const shown = (slides) => JSON.stringify([displayedWords(slides), compiledQuotations(slides).map((quote) => quote.words)])
    const unexplained = []
    const apply = (verb, outline, id, input, layout) => {
      try {
        return verb(outline, id, input, layout).outline
      } catch (error) {
        if (typeof error?.code !== 'string') throw error
        return outline
      }
    }
    for (const deck of inDecks(rows, DECK)) {
      const start = outlineOf(deck, false)
      const compiledStart = await compileText(start)
      const layoutOf = new Map(compiledStart.slides.map((slide) => [slide.id, slide.layout]))
      for (const input of INPUTS) {
        let now = start
        let base = start
        for (const row of deck) {
          now = apply(setQuoteSource, now, row.id, input, layoutOf.get(row.id))
          base = apply(setQuoteSourceAtBase, base, row.id, input, layoutOf.get(row.id))
        }
        const compiledNow = await compileText(now)
        const compiledBase = await compileText(base)
        for (const row of deck) {
          counts.calls += 1
          const was = sectionOf(start, row.id)
          const sectionNow = sectionOf(now, row.id)
          const sectionBase = sectionOf(base, row.id)
          const label = `${row.label}, ${JSON.stringify(input)}: ${JSON.stringify(was)} → base ${JSON.stringify(sectionBase)}, now ${JSON.stringify(sectionNow)}`
          const formNow = formWritten(now, row.id)
          const slidesStart = rowSlides(compiledStart, row.id)
          const slidesNow = rowSlides(compiledNow, row.id)
          const slidesBase = rowSlides(compiledBase, row.id)
          if (sectionNow !== was) {
            // Whatever the verb writes now, the full compiler shows the words it showed, and reads the source on one quotation.
            assert.equal(shown(slidesNow), shown(slidesStart), `set-quote-source wrote, and the displayed words or a quotation's words changed (${shown(slidesStart)} → ${shown(slidesNow)}): ${label}`)
            const citesStart = compiledQuotations(slidesStart).map((quote) => quote.cite)
            const cites = compiledQuotations(slidesNow).map((quote) => quote.cite)
            const changed = cites.filter((cite, index) => cite !== citesStart[index])
            assert(changed.length <= 1, `set-quote-source changed the source of ${changed.length} quotations: ${label}`)
            const holding = (changed.length ? changed : cites).filter((cite) => (input.text == null || cite.replace(/\s+/g, ' ').includes(input.text)) && (input.link == null || cite.includes(input.link)))
            // (A layout that draws only the slide's child headings draws no quotation of the slide's own: nothing to read.)
            if (cites.length) assert(holding.length >= 1, `set-quote-source wrote a source the compiler reads on no quotation (${JSON.stringify(cites)}): ${label}`)
            else counts.writtenUndrawn += 1
            counts.written += 1
            tally(writtenKinds, row.kind)
          }
          if (formNow && !formWritten(start, row.id)) assert.equal(drawnForm(compiledNow, row.id, formNow, { wordsBefore: compiledWords(compiledStart.slides.find((slide) => slide.id === row.id)) }), '', `set-quote-source set ${formNow} and the compiler does not draw it: ${label}`)
          if (sectionNow === sectionBase) {
            counts[sectionNow === was ? 'identicalUnchanged' : 'identicalWritten'] += 1
            continue
          }
          // The section without its layout line, and that line's tokens without the form: the verb writes the form
          // into the layout line, one token to a brace group.
          const layoutLine = (text) => text.split('\n').find((line) => line.startsWith(`{id=${row.id}`)) ?? ''
          const lessForm = (text) => JSON.stringify([text.split('\n').filter((line) => line !== layoutLine(text)), [...layoutLine(text).matchAll(/[^{}\s]+/g)].map(([token]) => token).filter((token) => !/^form=(?:web|paper)$/.test(token)).sort()])
          if (sectionNow === was) {
            // Withheld, and a correction: the full compiler reads the base's result with other displayed words, or
            // other words for a quotation. A slide with no quotation is one: its only line was replaced.
            if (shown(slidesBase) !== shown(slidesStart)) {
              counts.withheldCorrection += 1
              tally(correctionKinds, row.kind)
              if (compiledQuotations(slidesStart).length === 0) counts.withheldNoQuotation += 1
              continue
            }
            // Withheld: the full compiler reads the source that was written on no quotation of the base's result.
            const cites = compiledQuotations(slidesBase).map((quote) => quote.cite.replace(/\s+/g, ' '))
            if (!cites.some((cite) => (input.text == null || cite.includes(input.text)) && (input.link == null || cite.includes(input.link)))) {
              counts.withheldShown += 1
              continue
            }
          }
          if (lessForm(sectionNow) === lessForm(sectionBase)) {
            // The same source line; only the form differs. The base's form is one the compiler does not draw
            // (statement A), or the rule's is one it does (asserted above).
            const formBase = formWritten(base, row.id)
            if (formBase && !formNow) assert.notEqual(drawnForm(compiledBase, row.id, formBase), '', `set-quote-source no longer sets a form the compiler draws: ${label}`)
            assert.notEqual(formBase, formNow, `only the form differs, and it is the same form: ${label}`)
            counts[formNow ? 'formOnlyNow' : 'formOnlyBase'] += 1
            continue
          }
          // What ticket 10 reads differently on purpose, whatever the check says: a Trigger line or speaker notes
          // among the content are not content, a video or an audio file is, a picture with braces is a picture.
          if (['body trigger', 'notes', 'beside the quotation', 'bare address'].includes(row.kind)) {
            counts.readOnPurpose += 1
            tally(purposeKinds, row.kind)
            continue
          }
          unexplained.push(label)
        }
      }
    }
    assert.deepEqual(unexplained, [], `set-quote-source differs from the base with no disagreement shown on ${unexplained.length} calls: ${listed(unexplained, 4)}`)
    console.log(`set-quote-source against the base on ${rows.length} slides × ${INPUTS.length} sources = ${counts.calls} calls:`)
    console.log(`  identical to the base: ${counts.identicalWritten + counts.identicalUnchanged} (${counts.identicalWritten} written, ${counts.identicalUnchanged} unchanged or refused by both)`)
    console.log(`  written now: ${counts.written} (${Object.entries(writtenKinds).map(([kind, count]) => `${kind} ${count}`).join(', ')}); of them with the displayed words or a quotation's words changed, as the full compiler reads them: 0 (${counts.writtenUndrawn} on a slide whose layout draws only its child headings: no quotation of its own to read)`)
    console.log(`  withheld, and the base's result changes the displayed words or a quotation's words (corrections): ${counts.withheldCorrection} (${Object.entries(correctionKinds).map(([kind, count]) => `${kind} ${count}`).join(', ')}); ${counts.withheldNoQuotation} of them on a slide the compiler reads no quotation on`)
    console.log(`  withheld, and the full compiler reads the written source on no quotation of the base's result: ${counts.withheldShown}`)
    console.log(`  the same source line, only the form differs: ${counts.formOnlyBase + counts.formOnlyNow} (the base set a form the compiler does not draw: ${counts.formOnlyBase}; the verb sets one the compiler draws and the base set none: ${counts.formOnlyNow})`)
    console.log(`  read differently by ticket 10 on purpose: ${counts.readOnPurpose} (${Object.entries(purposeKinds).map(([kind, count]) => `${kind} ${count}`).join(', ')})`)
    assert(counts.identicalWritten >= 3000 && counts.calls >= 7000 && counts.written >= 3000 && counts.withheldCorrection >= 20 && counts.withheldNoQuotation >= 10 && (writtenKinds['several quotations'] ?? 0) >= 10 && (writtenKinds['bare address'] ?? 0) >= 10, `the statement is not empty: ${JSON.stringify(counts)}`)
  }
  console.log('test:quote-forms-base-regression: all assertions passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
