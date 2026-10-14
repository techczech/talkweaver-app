// Sixth review round of quote forms ticket 10 (13 October). Run by scripts/test-quote-forms-address-under-quote.mjs
// (section G). Plain Node.
//
//   G1. A source write changes the source and nothing else. The reviewer's two reproductions: a quoted paragraph the
//       compiler joins to the address under it across its notes (no quotation to the compiler: `set-quote-source`
//       replaced both visible lines), and a quoted paragraph with its source after a dash beside a second quotation
//       (the new source became part of the first quotation's words). Both now return the outline unchanged. The
//       check's answer for a source write: `holds` only when the full list of displayed words without the source is
//       the same before and after, every quotation has the words it had, and the written source is on one quotation;
//       no quotation before the write is `withheld`; no slide at that heading is `unread`, and is not written either.
//       Two quotations with a source added to the first are still written (fifth round).
//   G2. A link the icon catalogue could cut short takes no form. `- https://example.org/{zap}` is the link
//       `https://example.org/` to the compiler when `zap` is an icon, so one of the readings disagrees: `withheld`,
//       whatever the catalogue holds. Every form that is written is drawn by the full compiler with the typed link in
//       full (`{icon=name}`, the group in the middle of the address, a name that is no icon, a group after a space).
import { strict as assert } from 'node:assert'
import { parseSourceLine } from '../../compiler/scripts/lib/quote-forms.mjs'
import { setFormOnLinkEdits, setQuoteSource } from '../../src/shared/layout-verbs.ts'
import { quoteFormWriteVerdict, quoteSourceWriteHolds, quoteSourceWriteVerdict } from '../../src/shared/quote-write-check.ts'
import { compiledQuotations, compilerIn, displayedWords, drawnForm } from './quote-drawn-form-slides.mjs'

const HEAD = '# Talk\n\n## Part\n\n'
const LINE = 5
const slide = (trigger, body) => `${HEAD}### Q\n{id=q ${trigger}}\n\n${body}\n`
const NOTES = ':::notes\nsecret\n:::'

export async function sourceWordsAndIconLinkCases(dir) {
  const compileText = compilerIn(dir)
  const compiled = async (text) => (await compileText(text)).slides.find((candidate) => candidate.id === 'q')

  // ── G1. The blocker: source edits that deleted displayed words ─────────────────────────────────────────────────────
  {
    // The first reproduction: one paragraph to the compiler, no quotation.
    const before = slide('quote', `"Words."\n${NOTES}\nhttps://example.org`)
    const shown = await compiled(before)
    assert.deepEqual([displayedWords(shown), compiledQuotations(shown)], [['[paragraph]', '"Words." https://example.org'], []], 'the compiler shows one paragraph and no quotation')
    for (const source of [{ text: 'Jane', link: 'https://other.org' }, { text: 'Jane' }, { link: 'https://other.org' }]) {
      assert.deepEqual(setQuoteSource(before, 'q', source, 'quote'), { outline: before, formSet: null }, `a slide the compiler reads no quotation on, ${JSON.stringify(source)}: nothing is written`)
    }
    // What the verb wrote for it before this round, asked of the check: a disagreement.
    const destroyed = slide('quote', `Jane https://other.org\n${NOTES}`)
    assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before, written: destroyed, text: 'Jane', link: 'https://other.org' }), 'withheld', 'no quotation before the write: there is none to attribute')
    assert.notDeepEqual(displayedWords(await compiled(destroyed)), displayedWords(shown), 'and the full compiler shows other words for that result')

    // The second: several quotations, the new source taken into the first one's words.
    const several = slide('quote', '"First." — Jane\n\n> Second.')
    assert.deepEqual(compiledQuotations(await compiled(several)).map((quote) => quote.words), [['First.'], ['Second.']])
    assert.deepEqual(setQuoteSource(several, 'q', { text: '"New source"' }, 'quote'), { outline: several, formSet: null }, 'a source in quotation marks after a quoted paragraph: nothing is written')
    const joined = several.replace('— Jane', '— "New source"')
    assert.deepEqual(compiledQuotations(await compiled(joined)).map((quote) => quote.words), [['First." — "New source'], ['Second.']], 'the full compiler reads that source as words of the first quotation')
    assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before: several, written: joined, text: '"New source"', link: '' }), 'withheld', 'several quotations are compared too: a quotation\'s words changed')
    // A source it does read there is written, the second quotation left alone.
    const renamed = setQuoteSource(several, 'q', { text: 'Ann Other' }, 'quote').outline
    assert.equal(renamed, several.replace('— Jane', '— Ann Other'))
    assert.deepEqual(compiledQuotations(await compiled(renamed)), [{ words: ['First.'], cite: 'Ann Other' }, { words: ['Second.'], cite: '' }])

    // The fifth round's case stays written: two quotations, the source added to the first, both with their words.
    const two = slide('quote', '> First.\n\n> Second.')
    const sourced = setQuoteSource(two, 'q', { text: 'Jane Example' }, 'quote').outline
    assert.notEqual(sourced, two, 'two quotations and no source: the source is written')
    assert.deepEqual(compiledQuotations(await compiled(sourced)), [{ words: ['First.'], cite: 'Jane Example' }, { words: ['Second.'], cite: '' }], 'on the first quotation, both with their words')
    assert.deepEqual(displayedWords(await compiled(sourced)), displayedWords(await compiled(two)))
    assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before: two, written: sourced, text: 'Jane Example', link: '' }), 'holds')

    // The check's answers, one condition at a time.
    const check = (over = {}) => ({ headingLine: LINE, before: slide('quote', '> Words.\n\nA paragraph beside it.\n\n- One\n- Two'), written: slide('quote', '> Words.\n> — Jane Example\n\nA paragraph beside it.\n\n- One\n- Two'), text: 'Jane Example', link: '', ...over })
    assert.equal(quoteSourceWriteVerdict(check()), 'holds', 'a source inside the block, the paragraph and the list as they were')
    for (const [why, over] of [
      ['a paragraph beside the quotation is gone', { written: slide('quote', '> Words.\n> — Jane Example\n\n- One\n- Two') }],
      ['a paragraph beside the quotation has other words', { written: slide('quote', '> Words.\n> — Jane Example\n\nA paragraph beside it, and more.\n\n- One\n- Two') }],
      ['a list item is gone', { written: slide('quote', '> Words.\n> — Jane Example\n\nA paragraph beside it.\n\n- One') }],
      ['a list of two items became the source', { before: slide('quote', '> Words.\n\n- One\n- Two'), written: slide('quote', '> Words.\n\n- Jane Example') }],
      ['a paragraph was added', { written: slide('quote', '> Words.\n\nJane Example\n\nA paragraph beside it.\n\n- One\n- Two') }],
      ['a second quotation appeared', { written: slide('quote', '> Words.\n> — Jane Example\n\n> More.\n\nA paragraph beside it.\n\n- One\n- Two') }],
      ['two quotations changed their source', { before: slide('quote', '> First.\n\n> Second.'), written: slide('quote', '> First.\n> — Jane Example\n\n> Second.\n> — Jane Example') }],
      ['the source is on no quotation', { text: 'Somebody Else' }],
      ['the slide has no quotation', { before: slide('quote', 'A paragraph.'), written: slide('quote', 'A paragraph.\n\n- Jane Example') }],
      ['the slide has only a list', { before: slide('quote', '- Old'), written: slide('quote', '- Jane Example') }]
    ]) {
      assert.equal(quoteSourceWriteVerdict(check(over)), 'withheld', `withheld when ${why}`)
      assert.equal(quoteSourceWriteHolds(check(over)), false)
    }
    // No slide at that heading: unread, and a source line is not written there (a form still is: section F3).
    assert.equal(quoteSourceWriteVerdict(check({ headingLine: LINE + 1 })), 'unread')
    assert.equal(quoteSourceWriteHolds(check({ headingLine: LINE + 1 })), false, 'a slide the compiler cannot be read on takes no source line')
  }

  // ── G2. The should-fix: a link the icon catalogue could cut short ──────────────────────────────────────────────────
  const counts = { written: 0, withheld: 0 }
  // (Under a quotation the source line is the quotation's attribution, which is no list item: no icon is read
  // there, and the link is drawn in full.)
  for (const [label, was, now, expected] of [
    ['the reviewer\'s reproduction: {zap} at the end of the address', '- Jane', '- https://example.org/{zap}', null],
    ['{icon=zap} at the end of the address', '- Jane', '- https://example.org/{icon=zap}', null],
    ['{zap} in the middle of the address', '- Jane', '- https://example.org/{zap}/page', 'web'],
    ['a name that is no icon at the end of the address', '- Jane', '- https://example.org/{no-such-icon-name}', undefined],
    ['{zap} at the end of the address under a quotation', '> Words.\n\n- Jane', '> Words.\n\n- Jane https://example.org/{zap}', 'web'],
    ['{icon=zap} at the end of the address under a quotation', '> Words.\n\n- Jane', '> Words.\n\n- Jane https://example.org/{icon=zap}', 'web'],
    ['{zap} after a space', '> Words.\n\n- Jane', '> Words.\n\n- Jane https://example.org/a {zap}', 'web'],
    ['{zap} at the end of the address and {github} after a space', '- Jane', '- https://example.org/{zap} {github}', 'web'],
    ['a bare address ending in {zap} under a quotation', '> Words.', '> Words.\n\nhttps://example.org/{zap}', 'web']
  ]) {
    const before = slide('quote', was)
    const after = slide('quote', now)
    const compiledAfter = await compileText(after)
    // The real mapping from heading line to layout, from compiling the text after the edit.
    const layoutAt = new Map(compiledAfter.slides.map((candidate) => [candidate.sourceLine, candidate.layout]))
    const written = setFormOnLinkEdits(before, after, (line) => layoutAt.get(line))
    if (expected !== undefined) assert.equal(written.form, expected, `${label}: ${expected ?? 'no form'}`)
    if (!written.set) {
      assert.equal(written.outline, after, `${label}: nothing is written`)
      counts.withheld += 1
      continue
    }
    // The link as typed: every character of it up to the next space, braces included.
    const typedLink = now.match(/https?:\/\/\S+/)[0]
    assert.equal(parseSourceLine(now.split('\n').pop().replace(/^- /, '')).link?.url.startsWith('https://example.org/'), true)
    const model = await compileText(written.outline)
    assert.equal(drawnForm(model, 'q', written.form, { link: typedLink }), '', `${label}: the written form is drawn with the typed link in full`)
    counts.written += 1
  }
  {
    // Asked of the check directly, as the rule asks it for the reproduction: a disagreement, not a slide that cannot be read.
    const cut = (ending, kids = '') => ({ headingLine: LINE, written: slide('quote form=web', `- https://example.org/${ending}${kids}`), withoutToken: slide('quote', `- https://example.org/${ending}${kids}`), withoutLink: slide('quote', ''), form: 'web', link: `https://example.org/${ending}`, quotation: false })
    assert.equal(quoteFormWriteVerdict(cut('{zap}')), 'withheld', 'one reading cuts the link short: withheld')
    assert.equal(quoteFormWriteVerdict(cut('{icon=zap}')), 'withheld', '{icon=name} leaves the item whatever the catalogue says')
    assert.equal(quoteFormWriteVerdict(cut('{zap}/page')), 'holds', 'a group in the middle of the address ends no item')
    assert.equal(quoteFormWriteVerdict(cut('page')), 'holds')
    // More names than are read every way: withheld when the link's own line holds a group, unread when it holds none.
    const kids = '\n  - one {alpha}\n  - two {beta}\n  - three {gamma}\n  - four {delta}'
    assert.equal(quoteFormWriteVerdict(cut('{zap}', kids)), 'withheld', 'five names and a group on the link\'s line: withheld')
    assert.equal(quoteFormWriteVerdict(cut('page', kids)), 'unread', 'four names and none on the link\'s line: not read every way, as before')
  }
  assert(counts.written >= 6 && counts.withheld >= 2, `the statement is not empty: ${JSON.stringify(counts)}`)
  return `the sixth round's reproductions: set-quote-source writes nothing on a slide the compiler reads no quotation on, nor a source the compiler takes into a quotation's words, and still writes the source of the first of two quotations (the displayed words compared in full, with the full compiler); a link an icon name could cut short takes no form (${counts.withheld} shapes), and ${counts.written} written forms are drawn with the typed link in full`
}
