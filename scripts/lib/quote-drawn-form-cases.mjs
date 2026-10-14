// Fifth review round of quote forms ticket 10 (13 October). Run by scripts/test-quote-forms-address-under-quote.mjs
// (section C2 and section F). Plain Node.
//
//   C2 (extended). Whatever the link-edit rule writes, the FULL compiler draws: over a quote slide for every token of
//       the layout registry, met every way (scripts/lib/quote-drawn-form-slides.mjs), with a source line and with a
//       bare address, each form written recompiles (`prepareSource`, the page built too) to a slide of its own with
//       the quote layout, that form on its one quotation, the words compiled before the edit, the typed link, no
//       card, and the form's figure on the page.
//   F1. The reviewer's reproduction: `{quote carousel}` with no child headings. The compiler makes every block a
//       sub-slide, so no form is drawn and none is written; the check says so as a disagreement (`withheld`).
//   F2. A quick check, a poll that is not valid, and a list item ending in `{name}` or `{icon=name}` are read, and
//       take the form where the compiler draws it. A valid poll's page shows the poll's frame in place of the
//       quotation, so no form is written there.
//   F3. The check's three answers: `withheld` only when the compiler was read and disagrees; `unread` (no slide on
//       that line, more `{name}` endings than are tried) leaves a FORM to the verbs' reader: the check does not
//       stop that write. (Sixth round: a source line is not written on a slide that cannot be read.)
//   F4. `set-quote-source` writes what it wrote before the check on several quotations, on a poll and a quick
//       check, and beside a list with icons; a wrong write is still withheld. (Sixth round: several quotations are
//       read and compared, scripts/lib/quote-source-words-and-icon-link-cases.mjs.)
import { strict as assert } from 'node:assert'
import { setFormOnLinkEdits, setQuoteSource } from '../../src/shared/layout-verbs.ts'
import { compiledQuoteAt, quoteFormWriteHolds, quoteFormWriteVerdict, quoteSourceWriteHolds, quoteSourceWriteVerdict } from '../../src/shared/quote-write-check.ts'
import { setQuoteSource as setQuoteSourceAtBase } from './quote-forms-07-base-layout-verbs.ts'
import { DOI, VARIANTS, WEB, comboSlides, compiledWords, compilerIn, drawnForm, formOnModel, formWritten, inDecks, outlineOf, pageSection, registryLayoutTokens, registryTokens } from './quote-drawn-form-slides.mjs'

const HEAD = '# Talk\n\n## Section\n\n'
const LINE = 5
const slide = (trigger, body) => `${HEAD}### Q\n{id=q ${trigger}}\n\n${body}\n`

/** The rule run as the editor runs it: the layouts are the ones the compiler gave the text after the edit. */
async function typed(compileText, before, after) {
  const compiledAfter = await compileText(after)
  const layoutAt = new Map(compiledAfter.slides.map((candidate) => [candidate.sourceLine, candidate.layout]))
  return { written: setFormOnLinkEdits(before, after, (line) => layoutAt.get(line)), compiledAfter }
}

// ── C2, extended: every registry token beside {quote} ────────────────────────────────────────────────────────────────

export async function registryCombinationCases(dir) {
  const compileText = compilerIn(dir)
  const tokens = registryTokens()
  const layoutTokens = registryLayoutTokens()
  assert(tokens.length >= 150 && layoutTokens.every((token) => tokens.includes(token)), 'the tokens are read from the registry: every layout and container entry is among them')
  for (const named of ['carousel', 'cards', 'columns', 'compare', 'contrast', 'image-grid', 'cards=grid', 'cards=rows', 'cards=stepped', '2col', 'poll=open', 'check']) assert(tokens.includes(named), `the registry holds {${named}}`)
  const linkOf = (index) => (index % 3 === 2 ? DOI : WEB)
  const SHAPES = [
    ['a source line', 's', (link) => ['> Words of the quotation.', '', link ? `- Jane Example ${link}` : '- Jane Example']],
    ['a bare address', 'a', (link) => ['> Words of the quotation.', ...(link ? ['', link] : [])]]
  ]
  const counts = { slides: 0, written: 0, web: 0, paper: 0, notWritten: 0, withChildren: 0, layoutTokenWritten: 0 }
  const unwritten = new Map()
  for (const [shape, prefix, content] of SHAPES) {
    const rows = comboSlides(prefix, tokens, VARIANTS, content, linkOf)
    for (const deck of inDecks(rows)) {
      const before = outlineOf(deck, false)
      const after = outlineOf(deck, true)
      const compiledBefore = await compileText(before)
      const { written } = await typed(compileText, before, after)
      const recompiled = await compileText(written.outline)
      for (const row of deck) {
        counts.slides += 1
        const form = formWritten(written.outline, row.id)
        const label = `${shape}, ${row.label}: ${JSON.stringify(row.text(true))}`
        if (!form) {
          counts.notWritten += 1
          unwritten.set(`${row.token} ${row.variant}`, (unwritten.get(`${row.token} ${row.variant}`) ?? 0) + 1)
          continue
        }
        const wordsBefore = compiledWords(compiledBefore.slides.find((candidate) => candidate.id === row.id))
        assert.equal(drawnForm(recompiled, row.id, form, { link: row.link }), '', `the editor wrote ${form} and the compiler does not draw it: ${label}`)
        assert(wordsBefore.length > 0, `the editor wrote ${form} on a slide that had no quotation of its own before the edit: ${label}`)
        assert.equal(drawnForm(recompiled, row.id, form, { wordsBefore }), '', `the editor wrote ${form} and the quotation's words changed: ${label}`)
        assert.equal(form, row.link === DOI ? 'paper' : 'web')
        counts.written += 1
        counts[form] += 1
        if (row.variant.endsWith('child headings')) counts.withChildren += 1
        if (layoutTokens.includes(row.token)) counts.layoutTokenWritten += 1
      }
    }
  }
  // Not an empty statement, and the containers are in it: no form on a carousel (with child headings and without),
  // on cards over child headings, or on a slide a heading above folds in.
  for (const [token, variant] of [['carousel', 'after quote'], ['carousel', 'before quote'], ['carousel', 'among the content'], ['carousel', 'after quote, child headings'], ['cards=grid', 'after quote, child headings'], ['cards=rows', 'before quote, child headings'], ['carousel', 'on the heading above'], ['compare', 'on the heading above'], ['columns', 'on the heading above'], ['2col', 'on the heading above'], ['image-grid', 'on the heading above'], ['contrast', 'on the heading above'], ['poll=open', 'after quote']]) {
    assert.equal(unwritten.get(`${token} ${variant}`), SHAPES.length, `no form is written with {${token}} ${variant}`)
  }
  // And a token that moves nothing takes the form every way it is met.
  for (const token of ['reveal', 'notitle', 'nostep', 'bg=cobalt', 'check', 'pollskip']) for (const variant of VARIANTS.filter((name) => name !== 'alone')) assert(!unwritten.has(`${token} ${variant}`), `{${token}} ${variant} keeps the form from no slide`)
  assert(counts.written >= 1500 && counts.web >= 500 && counts.paper >= 400 && counts.notWritten >= 300 && counts.withChildren >= 400 && counts.layoutTokenWritten >= 100, `the statement is not empty: ${JSON.stringify(counts)}`)
  return `every registry token beside {quote}: ${tokens.length} tokens (${layoutTokens.length} layout and container entries) × ${VARIANTS.length} ways × ${SHAPES.length} shapes = ${counts.slides} slides; a form written on ${counts.written} (web ${counts.web}, paper ${counts.paper}; ${counts.withChildren} with child headings under the slide), nothing on ${counts.notWritten}; every written form is drawn by the full compiler, page included, with the words compiled before the edit`
}

// ── F. The reproductions, and the check's three answers ──────────────────────────────────────────────────────────────

export async function drawnFormCases(dir) {
  const compileText = compilerIn(dir)
  const URL = 'https://example.org'

  // F1. The blocker: a flat carousel.
  {
    const before = slide('quote carousel', '> Words.\n\n- Author')
    const after = slide('quote carousel', `> Words.\n\n- Author ${URL}`)
    for (const layout of ['carousel', 'quote', undefined]) assert.deepEqual(setFormOnLinkEdits(before, after, () => layout), { outline: after, set: false, form: null }, `{quote carousel}, compiled layout ${layout}: no form is written`)
    const sourced = setQuoteSource(before, 'q', { text: 'Author', link: URL }, 'quote')
    assert.deepEqual([sourced.outline, sourced.formSet], [after, null], 'set-quote-source writes the source line and sets no form')
    const forced = slide('quote carousel form=web', `> Words.\n\n- Author ${URL}`)
    const compiled = (await compileText(forced)).slides.find((candidate) => candidate.id === 'q')
    assert.deepEqual([compiled.layout, compiled.blocks.length, compiled.carousel?.[0]?.blocks?.[0]?.quoteForm], ['carousel', 0, undefined], 'the compiler makes it a carousel: the quotation is a sub-slide with no form')
    assert.equal(compiledQuoteAt(forced, LINE).layout, 'carousel', 'and the shared reading says so')
    const check = { headingLine: LINE, written: forced, withoutToken: after, withoutLink: slide('quote carousel', '> Words.\n'), form: 'web', link: URL, quotation: true }
    assert.equal(quoteFormWriteVerdict(check), 'withheld', 'a carousel is a disagreement, not a slide that cannot be read')
    // The same for a slide a heading above folds in, and for one that takes its child headings in.
    const under = `${HEAD}### Parent\n{id=p compare}\n\n#### Q\n{id=q quote form=web}\n\n> Words.\n\n- Author ${URL}\n\n#### Other\n\nText.\n`
    assert.equal(compiledQuoteAt(under, 8).notDrawn, 'folded')
    assert.equal(quoteFormWriteVerdict({ ...check, headingLine: 8, written: under, withoutToken: under.replace(' form=web', ''), withoutLink: under.replace(' form=web', '').replace(`\n- Author ${URL}\n`, '\n') }), 'withheld', 'a slide folded into the heading above: a disagreement')
    const over = slide('quote cards=grid form=web', `> Words.\n\n- Author ${URL}\n\n#### One\n\nText.`)
    assert.equal(compiledQuoteAt(over, LINE).notDrawn, 'child-fold')
    assert.equal(quoteFormWriteVerdict({ ...check, written: over, withoutToken: over.replace(' form=web', ''), withoutLink: over.replace(' form=web', '').replace(`\n- Author ${URL}\n`, '\n') }), 'withheld', 'a slide that takes its child headings in: a disagreement')
  }

  // F2. A quick check, a poll that is not valid, and icon endings: read, and written where the compiler draws the form.
  const counts = { written: 0, pollFrames: 0 }
  for (const [token, expected] of [['check', 'web'], ['check=false', 'web'], ['polltop=2', 'web'], ['pollskip', 'web'], ['poll=open', null], ['poll=single', null], ['poll=board', null]]) {
    const before = slide(`quote ${token}`, '> Words.')
    const after = slide(`quote ${token}`, `> Words.\n\n- Author ${URL}`)
    const { written } = await typed(compileText, before, after)
    assert.equal(written.form, expected, `{quote ${token}} with a source link typed: ${expected ?? 'no form'}`)
    if (expected) {
      assert.equal(drawnForm(await compileText(written.outline), 'q', expected, { wordsBefore: ['Words.'], link: URL }), '', `{quote ${token}}: the written form is drawn`)
      counts.written += 1
      continue
    }
    // A valid poll: the model still carries the form, and the page shows the poll's frame in place of the quotation.
    const forced = slide(`quote ${token} form=web`, `> Words.\n\n- Author ${URL}`)
    const model = await compileText(forced)
    assert(formOnModel(model, 'q', 'web') && pageSection(model, 'q').includes('class="poll-frame"') && !pageSection(model, 'q').includes('class="qf '), `{quote ${token}}: the page shows the poll frame and no form`)
    assert.equal(compiledQuoteAt(forced, LINE).notDrawn, 'poll-frame')
    assert.equal(quoteFormWriteVerdict({ headingLine: LINE, written: forced, withoutToken: after, withoutLink: before, form: 'web', link: URL, quotation: true }), 'withheld')
    counts.pollFrames += 1
  }
  for (const [label, was, now, words] of [
    ['only a source line ending in {zap}', '- Author {zap}', `- Author ${URL} {zap}`, []],
    ['only a source line ending in {icon=zap}', '- Author {icon=zap}', `- Author ${URL} {icon=zap}`, []],
    ['only a source line ending in a {name} that is no icon', '- Author {nonsense}', `- Author ${URL} {nonsense}`, []],
    ['a quotation and a source line ending in {zap}', '> Words.\n\n- Author {zap}', `> Words.\n\n- Author ${URL} {zap}`, ['Words.']],
    ['a quotation and a source line ending in {icon=zap}', '> Words.\n\n- Author {icon=zap}', `> Words.\n\n- Author ${URL} {icon=zap}`, ['Words.']]
  ]) {
    const before = slide('quote', was)
    const after = slide('quote', now)
    const { written } = await typed(compileText, before, after)
    assert.equal(written.form, 'web', `${label}: the form is written`)
    const model = await compileText(written.outline)
    assert.equal(drawnForm(model, 'q', 'web', { link: URL }), '', `${label}: and drawn`)
    assert.deepEqual(compiledWords(model.slides.find((candidate) => candidate.id === 'q')), words, `${label}: with the words it had`)
    // Read every way the icon catalogue could answer, and the same answer each way: a reading, not a fallback.
    const withoutLink = words.length ? slide('quote', '> Words.\n') : slide('quote', '')
    assert.equal(quoteFormWriteVerdict({ headingLine: LINE, written: written.outline, withoutToken: after, withoutLink, form: 'web', link: URL, quotation: words.length > 0 }), 'holds', `${label}: the compiler was read`)
    counts.written += 1
  }
  // The reading with the catalogue's answer handed in is the compiler's: `{zap}` leaves the item's text only when it is an icon.
  assert.deepEqual([compiledQuoteAt(slide('quote', `- Author ${URL} {zap}`), LINE, (name) => name === 'zap').cite, compiledQuoteAt(slide('quote', `- Author ${URL} {zap}`), LINE).cite], [`Author ${URL}`, `Author ${URL} {zap}`])

  // F3. The three answers.
  const good = (over = {}) => ({ headingLine: LINE, written: slide('quote form=web', `> Words.\n\n- Author ${URL}`), withoutToken: slide('quote', `> Words.\n\n- Author ${URL}`), withoutLink: slide('quote', '> Words.\n'), form: 'web', link: URL, quotation: true, ...over })
  assert.equal(quoteFormWriteVerdict(good()), 'holds')
  assert.equal(quoteFormWriteVerdict(good({ link: DOI })), 'withheld', 'another link: the compiler was read and disagrees')
  assert.equal(quoteFormWriteVerdict(good({ headingLine: LINE + 1 })), 'unread', 'no slide on that line: nothing to disagree with')
  // The speaker-notes case of the fourth round is a disagreement, as it was.
  const NOTES = ':::notes\nsecret words for the speaker\n:::'
  assert.equal(quoteFormWriteVerdict(good({ written: slide('quote form=web', `"Words."\n${NOTES}\n${URL}`), withoutToken: slide('quote', `"Words."\n${NOTES}\n${URL}`), withoutLink: slide('quote', `"Words."\n${NOTES}`) })), 'withheld', 'an address joined to a quoted paragraph across its notes: a disagreement')
  {
    // More `{name}` endings than are read every way: `unread`. The verbs' reader decides then, as it did before the
    // check: the check does not stop the write. (No slide the link-edit rule writes on has been found that reads so;
    // the rule's own reader refuses a source line with items under it.)
    const kids = '  - one {alpha}\n  - two {beta}\n  - three {gamma}\n  - four {delta}'
    const many = { headingLine: LINE, written: slide('quote form=web', `- Author ${URL}\n${kids}`), withoutToken: slide('quote', `- Author ${URL}\n${kids}`), withoutLink: slide('quote', ''), form: 'web', link: URL, quotation: false }
    assert.equal(quoteFormWriteVerdict(many), 'unread', 'four {name} endings: not read every way')
    assert.equal(quoteFormWriteVerdict({ ...many, written: many.written.replace(' {delta}', ''), withoutToken: many.withoutToken.replace(' {delta}', '') }), 'holds', 'three are')
    for (const unread of [many, good({ headingLine: LINE + 1 })]) assert.equal(quoteFormWriteHolds(unread), true, 'a slide that cannot be read is not a refusal: the reader\'s decision stands')
    assert.equal(quoteFormWriteHolds(good({ link: DOI })), false, 'a disagreement is')
    // (Sixth round.) A source line replaces lines of the slide, so it is written only where the compiler was read.
    assert.equal(quoteSourceWriteHolds({ headingLine: LINE + 1, before: slide('quote', '> Words.'), written: slide('quote', '> Words.\n\n- Jane Example'), text: 'Jane Example', link: '' }), false)
  }

  // F4. set-quote-source: what the base wrote, wherever the compiler does not disagree.
  for (const [label, trigger, body] of [
    ['two quotations', 'quote', '> First.\n\n> Second.'],
    ['a poll', 'quote poll=open', '> Words.'],
    ['a quick check', 'quote check', '> Words.'],
    ['a list with icons after the quotation', 'quote', '> Words.\n- One {zap}\n- Two {github}'],
    ['three quotations and a list', 'quote', '> First.\n\n> Second.\n\n> Third.\n\n- One {zap}']
  ]) {
    const outline = slide(trigger, body)
    const base = setQuoteSourceAtBase(outline, 'q', { text: 'Jane Example' }, 'quote')
    const now = setQuoteSource(outline, 'q', { text: 'Jane Example' }, 'quote')
    assert.notEqual(base.outline, outline, `${label}: the base wrote the source`)
    assert.deepEqual(now, base, `${label}: set-quote-source writes what it wrote before the check`)
    assert(now.outline.includes('Jane Example') && now.outline.split('\n').filter((line) => line.startsWith('>') && !line.includes('Jane')).join('\n') === outline.split('\n').filter((line) => line.startsWith('>')).join('\n'), `${label}: every quotation is kept`)
  }
  assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before: slide('quote', '> First.\n\n> Second.'), written: slide('quote', '> First.\n\n- Jane Example\n\n> Second.'), text: 'Jane Example', link: '' }), 'holds', 'several quotations: each has the words it had, and the first the source')
  assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before: slide('quote', '> Words.'), written: slide('quote', '> Words.\n- Jane Example\n> and more'), text: 'Jane Example', link: '' }), 'withheld', 'one quotation whose words change: a disagreement')
  assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before: slide('quote', '> Words.'), written: slide('quote', '> Words.\n\n- Somebody Else'), text: 'Jane Example', link: '' }), 'withheld', 'one quotation, another source: a disagreement')
  assert.equal(quoteSourceWriteVerdict({ headingLine: LINE, before: slide('quote poll=open', '> Words.'), written: slide('quote poll=open', '> Words.\n\n- Jane Example'), text: 'Jane Example', link: '' }), 'holds', 'a poll is read')
  return `the fifth round's reproductions: a flat carousel, a folded slide and a slide over cards take no form (a disagreement, not a slide that cannot be read); ${counts.written} quick-check, invalid-poll and icon-ending slides take the form and the compiler draws it; ${counts.pollFrames} valid polls take none (the page shows the poll frame); a slide that cannot be read is not refused; set-quote-source writes what the base wrote on 5 shapes the fourth round left unchanged`
}
