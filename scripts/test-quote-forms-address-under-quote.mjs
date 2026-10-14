// test:quote-forms-address-under-quote — quote forms ticket 10 (issue 139). Plain Node: no browser, no network.
//
//   A. A web address on a line of its own directly under the one quotation sets the form (web, paper), and the address
//      line is left as typed: LF and CRLF, any number of blank lines; nothing is set when the address is not directly
//      under the quotation, when there are two, when anything else is beside the quote, when there is a source line,
//      when there are two quotations, or for an X or YouTube address (the source-line rule writes no token for those).
//   B. A quote slide with no `{id=…}` yet takes its form, from a source line and from a bare address.
//   C. The compiler: with a form, the address is the quote's source link and compiles exactly as `- <address>` does
//      (no embed card); with no form, every slide compiles as it did before the ticket (recorded hashes).
//   D. Removal, a source line added, idempotence, the save-time tidy-up, the verbs, and the cost on a 300-slide talk.
//   Review round (13 October), each a reproduced finding:
//   B2. A slide with no id is paired with a slide of the text before only when that is certain. Stated without the
//       rule's own code: over generated pairs where slides are added, removed and moved, a slide with no id whose
//       lines are byte for byte a slide of the text before is never written.
//   C2. Whatever the editor's rule writes, the compiler draws: for a table and a generated set of slides (pictures,
//       video and audio files in image syntax, `[Video: …]`, both kinds of quotation), a written form recompiles to a
//       quote slide with that form and no embed card. A video or an audio file is content, not a picture.
//   C3. A quoted paragraph (a promoted quotation) with the address under it compiles as with the address on a source
//       line, phone text included, and that phone text is the `>` quotation's: the words as a quote, the source under it.
//   Second review round (13 October):
//   B2. A slide with no id is paired by one rule: the edit changed nothing outside that one slide. The reviewer's two
//       reproductions (a slide moved past one that gains or loses an id, or whose heading gains a space) write nothing;
//       the generated statement now says: a slide with no id is written ONLY IF the two texts are identical outside it
//       (sliced here, by the generated blocks) AND its source link differs between its span before and its span after.
//   D2. A form the slide inherits from the talk's `triggers:` is a set form to the verbs, as it is to the compiler:
//       describe and set-quote-source give the same result for the address on its own line and on a source line, with
//       the form on the slide and inherited; the link-edit rule writes no token on a slide that inherits a form.
//       Third review round (13 October): a Trigger line among the slide's content (`{form=web}`, `{reveal}`), which
//       the compiler folds into the slide and takes out before it reads the quotation, is not content to the verbs
//       either: describe and set-quote-source agree for both shapes wherever the line stands, the line is never
//       moved or rewritten, and what is written recompiles to a web page citing the source, with no card. C2's
//       generated statement holds such lines too.
//   Fourth review round (13 October):
//   C2. For every form the rule writes, the recompiled quotation's words are not empty and are the words compiled
//       before the edit, and the source link the compiler reads is the typed link. The generated slides hold speaker
//       notes too, alone and with Trigger lines among the content.
//   E.  Speaker notes are dropped by the verbs' reader as the compiler drops them (E1); every write is checked by
//       compiling and withheld when the compiler disagrees (E2); `set-quote-picture` never writes to a Trigger line
//       among the content, and returns what it did before on a slide that has none (E3). The cases are in
//       scripts/lib/quote-notes-compile-check-cases.mjs and scripts/lib/quote-picture-verb-cases.mjs.
//   C4. A slide that existed before the ticket keeps its thumbnail: the picture key of every slide of the
//       fixture talks equals the key of a copy without `quoteFormSet`, and changes when another property is added.
//   Fifth review round (13 October), in scripts/lib/quote-drawn-form-cases.mjs:
//   C2. The generated statement is asked of the full compiler and the page it builds, over a quote slide for every
//       token of the layout registry (beside `quote`, among the content, with child headings and without, on the
//       heading above): a written form is a slide of its own, a quote slide, that form, the same words.
//   F.  A flat carousel, a folded slide and a valid poll take no form; a quick check, a poll that is not valid and a
//       list item ending in an icon group are read and take it; a slide the check cannot read at all is not refused;
//       `set-quote-source` writes what it wrote before the check wherever the compiler does not disagree.
//       (What the base wrote and the compiler drew is still written: scripts/test-quote-forms-base-regression.mjs.)
//   Sixth review round (13 October), in scripts/lib/quote-source-words-and-icon-link-cases.mjs:
//   G.  `set-quote-source` changes the source and nothing else: no write on a slide the compiler reads no quotation
//       on, nor where a displayed word or a quotation's words would change, however many quotations there are. A
//       link an icon name could cut short (`- https://example.org/{zap}`) takes no form.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { pictureKeyForSlide } from '../compiler/scripts/lib/10-projections.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { quoteFormScriptBlocks, quoteFormSources } from '../compiler/scripts/lib/quote-forms-static.mjs'
import { buildSlideScriptPayload } from '../compiler/scripts/lib/slide-script.mjs'
import { renderScriptBlocks } from '../compiler/scripts/lib/slide-script-render.mjs'
import { readQuoteSlideLines } from '../compiler/scripts/lib/quote-forms.mjs'
import { describeQuoteSource, setFormOnLinkEdit, setFormOnLinkEdits, setQuoteSource } from '../src/shared/layout-verbs.ts'
import { collapseDuplicateKeys, collapseDuplicateLayouts, normalizePositions } from '../src/shared/outline-normalize.ts'
import { EXISTING_TALKS, FORMLESS_SLIDES, formlessHashes } from './lib/quote-address-under-quote-fixture.mjs'
import { NOTES, compileCheckCases, compiledLink, compiledWords, notesCases } from './lib/quote-notes-compile-check-cases.mjs'
import { pictureVerbCases } from './lib/quote-picture-verb-cases.mjs'
import { sourceWordsAndIconLinkCases } from './lib/quote-source-words-and-icon-link-cases.mjs'
import { drawnFormCases, registryCombinationCases } from './lib/quote-drawn-form-cases.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const WEB = 'https://example.org/schemas-and-propositions'
const DOI = 'https://doi.org/10.1000/xyz123'
const HEAD = '# Talk\n\n## Section\n\n'
const QUOTE = '### Quote\n{id=q1}\n\n> Words of the quotation.\n'
const doc = (slide, eol = '\n') => `${HEAD}${slide}`.replace(/\n/g, eol)
/** The outline without its layout lines (a `{…}` line): what the rule must leave byte for byte. */
const lessLayoutLines = (text) => text.split('\n').filter((line) => !/^\{.*\}\r?$/.test(line)).join('\n')
const formsIn = (text) => (text.match(/form=\w+/g) ?? []).join(',')
/** The rule as the editor runs it: every slide compiled as `layout`. */
const typed = (before, after, layout) => setFormOnLinkEdits(before, after, layout === undefined ? undefined : () => layout)

// ── A. The editor's rule ───────────────────────────────────────────────────────────────────────────────────────────

// `quote` is the layout of a quote-only slide compiled before the address was typed; `copy-visual` is what the compiler
// gives the quotation with the address as an embed card beside it (compiled after the address, before the form).
for (const [address, form] of [[WEB, 'web'], [DOI, 'paper'], ['https://arxiv.org/abs/1706.03762', 'web'], ['http://dx.doi.org/10.1000/abc', 'paper']]) {
  for (const eol of ['\n', '\r\n']) {
    for (const gap of ['', '\n', '\n\n\n']) {
      for (const layout of ['quote', 'copy-visual']) {
        const before = doc(QUOTE, eol)
        const after = doc(`${QUOTE}${gap}${address}\n`, eol)
        const label = `${form} ${JSON.stringify(eol)} gap ${gap.length} compiled ${layout}`
        const written = typed(before, after, layout)
        assert.equal(written.set, true, `${label}: a form is set`)
        assert.equal(written.form, form, label)
        assert.equal(lessLayoutLines(written.outline), lessLayoutLines(after), `${label}: only the layout line changed; the address line is as typed`)
        assert(written.outline.includes(`{id=q1} {form=${form}}${eol === '\r\n' ? '\r' : ''}\n`), `${label}: the token joins the layout line, with the slide's line ending`)
        assert.deepEqual(typed(after, written.outline, layout), { outline: written.outline, set: false, form: null }, `${label}: running the rule again writes nothing`)
        assert.equal(typed(written.outline, written.outline, 'quote').set, false, `${label}: nothing is set with no edit`)
      }
    }
  }
}
{
  // An authored {quote} token needs no compiled layout; `form=auto` is replaced; a picture before the quotation or after the address is allowed.
  const before = doc('### Quote\n{id=q1 quote form=auto}\n\n![The page](assets/page.png)\n\n> Words.\n')
  const written = typed(before, `${before}\n${WEB}\n`, undefined)
  assert.equal(formsIn(written.outline), 'form=web', 'form=auto is replaced by form=web')
  assert.equal(typed(doc('### Quote\n{quote}\n\n> Words.\n'), doc(`### Quote\n{quote}\n\n> Words.\n\n${WEB}\n\n![The page](assets/page.png)\n`), undefined).form, 'web', 'a picture after the address')
  const promoted = doc('### Quote\n{id=q1}\n\n"Words of the quotation."\n')
  assert.equal(typed(promoted, `${promoted}\n${WEB}\n`, 'copy-visual').form, 'web', 'a quoted paragraph is a quotation too')
  // The one-slide rule (the verbs' entry) reads the address the same way.
  assert.equal(setFormOnLinkEdit(doc(QUOTE), doc(`${QUOTE}\n${WEB}\n`), 'q1', 'copy-visual').form, 'web')
}

const NOTHING = [
  ['not directly under: a paragraph between', `${QUOTE}\nA sentence about it.\n\n${WEB}\n`],
  ['not directly under: a picture between', `### Quote\n{id=q1 quote}\n\n> Words.\n\n![The page](assets/page.png)\n\n${WEB}\n`],
  ['the address above the quotation', `### Quote\n{id=q1}\n\n${WEB}\n\n> Words of the quotation.\n`],
  ['two addresses', `${QUOTE}\n${WEB}\n\n${DOI}\n`],
  ['two addresses on following lines', `${QUOTE}\n${WEB}\n${DOI}\n`],
  ['the address and a list', `${QUOTE}\n${WEB}\n\n- one\n- two\n`],
  ['the address and a paragraph after it', `${QUOTE}\n${WEB}\n\nA sentence about it.\n`],
  ['a source line and the address', `${QUOTE}\n- Author Name, 2024\n\n${WEB}\n`],
  ['an in-block source and the address', `### Quote\n{id=q1}\n\n> Words.\n> — Author Name\n\n${WEB}\n`],
  ['two quotations', `${QUOTE}\n> A second quotation.\n\n${WEB}\n`],
  ['a practice quotation beside it', `${QUOTE}\n> Press [[Cmd+K]] now.\n\n${WEB}\n`],
  ['the address in a sentence', `${QUOTE}\nSee ${WEB} for more.\n`],
  ['an [Embed: …] line', `${QUOTE}\n[Embed: ${WEB}]\n`],
  ['a Markdown link on its own line', `${QUOTE}\n[the page](${WEB})\n`],
  // The source-line rule writes no token for these either: the compiler finds a tweet or a video from a source line by
  // itself, and a bare YouTube address under a quote is a player card. A book needs an ISBN or a reference, not an address.
  ['a post on X', `${QUOTE}\nhttps://x.com/sample/status/1234567890123456789\n`],
  ['a YouTube video', `${QUOTE}\nhttps://www.youtube.com/watch?v=XXXXXXXXXXX\n`],
  ['a form already chosen: plain', `### Quote\n{id=q1 quote form=plain}\n\n> Words.\n\n${WEB}\n`],
  ['a form already chosen: paper', `### Quote\n{id=q1 quote form=paper}\n\n> Words.\n\n${WEB}\n`]
]
for (const [label, slide] of NOTHING) {
  const after = doc(slide)
  for (const layout of ['quote', 'copy-visual']) {
    for (const before of [doc(QUOTE), doc('### Quote\n{id=q1}\n')]) {
      assert.deepEqual(typed(before, after, layout), { outline: after, set: false, form: null }, `${label} (compiled ${layout}): nothing is set`)
    }
  }
}
{
  const after = doc(`${QUOTE}\n${WEB}\n`)
  // Ticket 11: a compiled layout that does not make this a quote slide is the last compile's answer for that line,
  // which for a slide typed since is none, or another slide's. The compiler's own reading of the slide decides then.
  for (const layout of [undefined, 'list', 'statement', 'media', 'columns']) {
    assert.deepEqual(typed(doc(QUOTE), after, layout), typed(doc(QUOTE), after, 'copy-visual'), `compiled ${layout}, no {quote} token: the compiler reads a quotation with its address, so the form is set as with copy-visual`)
    const list = doc('### Points\n{id=q1}\n\n- one point\n- another point\n')
    assert.equal(typed(list, `${list}\n${WEB}\n`, layout).set, false, `compiled ${layout}, no {quote} token, a list with an address under it: not a quote slide`)
    assert.equal(typed(list, list.replace('another point', `another point ${WEB}`), layout).set, false, `compiled ${layout}, no {quote} token, a list with a link: not a quote slide`)
  }
  assert.equal(typed(doc(QUOTE), after, 'copy-visual').set, true)
  // With a picture and no {quote} token the compiled `copy-visual` may be the picture's, so nothing is set.
  const pictured = doc(`### Quote\n{id=q1}\n\n![The page](assets/page.png)\n\n> Words.\n`)
  assert.equal(typed(pictured, `${pictured}\n${WEB}\n`, 'copy-visual').set, false)
  // Only an edit to the address sets it: the words edited on a slide that already had the address.
  assert.equal(typed(after, after.replace('Words of', 'Other words of'), 'copy-visual').set, false, 'an address that was already there')
  assert.equal(typed(after, after.replace(WEB, `${WEB}-two`), 'copy-visual').form, 'web', 'the address changed')
  assert.equal(typed(doc(`${QUOTE}\n- ${WEB}\n`), after, 'quote').set, false, 'the same link moved from a source line to its own line is not a new link')
}

// ── B. A slide with no id yet ──────────────────────────────────────────────────────────────────────────────────────

{
  const first = '### First\n\n> First words.\n\n- First Author https://example.org/first\n\n'
  const second = '### Second\n\n> Second words.\n'
  const before = doc(`${first}${second}`)
  for (const [label, source, form] of [['a source line', `\n- Author Name ${WEB}\n`, 'web'], ['a bare address', `\n${WEB}\n`, 'web'], ['a DOI source line', '\n- Author Name doi:10.1000/abc\n', 'paper'], ['a bare DOI address', `\n${DOI}\n`, 'paper']]) {
    for (const eol of ['\n', '\r\n']) {
      const after = `${before}${source}`.replace(/\r?\n/g, eol)
      const written = typed(before.replace(/\r?\n/g, eol), after, 'quote')
      assert.equal(written.form, form, `no id, ${label}: the form is set`)
      const lines = written.outline.split('\n').map((line) => line.replace(/\r$/, ''))
      assert.equal(lines[lines.indexOf('### Second') + 1], `{form=${form}}`, `no id, ${label}: the token is written under the edited slide's heading`)
      assert.equal(lines[lines.indexOf('### First') + 1], '', `no id, ${label}: the first slide with no id is left alone`)
      assert.equal(lessLayoutLines(written.outline), after, `no id, ${label}: nothing else changed`)
      assert.equal(typed(after, written.outline, 'quote').set, false, `no id, ${label}: running the rule again writes nothing`)
    }
  }
  // Nothing edited: no slide with no id is given a form because another's link differs from its own.
  assert.equal(typed(before, before, 'quote').set, false)
  const single = doc('### Quote\n\n> Words.\n')
  assert.equal(typed(single, `${single}\n${WEB}\n`, 'copy-visual').outline, doc(`### Quote\n{form=web}\n\n> Words.\n\n${WEB}\n`), 'the issue as typed, with no id')
}

// ── B2. A slide with no id is paired only when the pairing is certain ──────────────────────────────────────────────

{
  // The review's reproduction: the first of two slides with the same heading is deleted. The survivor was not edited.
  const first = '### Same\n\n> First.\n\n'
  const second = `### Same\n\n> Second.\n\n${WEB}`
  for (const layout of ['copy-visual', 'quote']) {
    for (const head of ['', HEAD]) {
      assert.deepEqual(typed(`${head}${first}${second}`, `${head}${second}`, layout), { outline: `${head}${second}`, set: false, form: null }, `a slide deleted above one with the same heading (compiled ${layout}): the survivor is not written`)
      // A slide typed in above one with the same heading stands on that slide's old heading line: it is new, not edited.
      const added = `### Same\n\n> New words.\n\n${DOI}\n\n`
      assert.equal(typed(`${head}${second}`, `${head}${added}${second}`, layout).set, false, `a slide added above one with the same heading (compiled ${layout}): nothing is written`)
      // Two slides with the same heading change places: each stands where the other stood, and neither was edited.
      const plain = '### Same\n\n> First.\n\n- First Author\n\n'
      const linked = `### Same\n\n> Second.\n\n- Second Author ${WEB}\n\n`
      assert.equal(typed(`${head}${plain}${linked}`, `${head}${linked}${plain}`, layout).set, false, `two slides with the same heading change places (compiled ${layout}): nothing is written`)
    }
  }
  // The slide it was has an id: not the same kind of slide, nothing written. Its own heading may change in the edit.
  assert.equal(typed(doc('### Quote\n{id=q1}\n\n> Words.\n'), doc(`### Quote\n\n> Words.\n\n${WEB}\n`), 'copy-visual').set, false, 'the id removed in the same edit: nothing is written')
  assert.equal(typed(doc('### Quote\n\n> Words.\n'), doc(`### Quote\n{id=q1}\n\n> Words.\n\n${WEB}\n`), 'copy-visual').set, false, 'the id gained in the same edit: a slide with an id that was not there before, nothing is written')
  assert.equal(typed(doc('### Quote\n\n> Words.\n'), doc(`### Quotation\n\n> Words.\n\n${WEB}\n`), 'copy-visual').outline, doc(`### Quotation\n{form=web}\n\n> Words.\n\n${WEB}\n`), 'the heading and the address edited on the one slide: nothing outside it changed, the form is set')

  // The second review's reproductions: position, count and heading text do not say which slide a slide was. A slide
  // moved past another reads, by any of those, as that other slide with its link edited. Nothing may be written.
  for (const [source, layout] of [[(tail) => `https://example.org/${tail}`, 'copy-visual'], [(tail) => `- Author https://example.org/${tail}`, 'quote']]) {
    const A = `### Same\n\n> A.\n\n${source('a')}\n\n`
    const B = `### Same\n\n> B.\n\n${source('b')}\n\n`
    const nothing = (before, after, label) => {
      for (const head of ['', HEAD]) for (const eol of ['\n', '\r\n']) {
        const [from, to] = [`${head}${before}`.replace(/\n/g, eol), `${head}${after}`.replace(/\n/g, eol)]
        assert.deepEqual(typed(from, to, layout), { outline: to, set: false, form: null }, `${label} (compiled ${layout}, ${JSON.stringify(eol)}): nothing is written`)
      }
    }
    nothing(A.replace('### Same', '### Same\n{id=a}') + B, B + A, 'two slides change places and the first loses its id')
    nothing(A + B, B.replace('### Same', '### Same ') + A, 'two slides change places and one heading gains a space')
    nothing(A + B, B + A, 'two slides change places')
    nothing(A + B, B.replace('> B.', '> B, edited.') + A, 'two slides change places and one quotation is edited')
    nothing(A + B, B + A.replace('> A.', '> A, edited.'), 'two slides change places and the other quotation is edited')
    nothing(A + B, B.replace('### Same', '### Same\t') + A.replace('### Same', '###  Same'), 'two slides change places and both headings change their spaces')
    nothing(A.replace('### Same', '### Same\n{id=a}') + B + A.replace('> A.', '> C.'), B + A + A.replace('> A.', '> C.'), 'an id removed from a slide as it is moved, a third slide after them')
    nothing(B + A.replace('### Same', '### Same\n{id=a}'), A + B, 'an id removed from the slide moved up')
    nothing(A + B, A + B + A, 'a slide duplicated at the end')
    // Reads as one slide edited (nothing else changed), and is not: the last slide gone, a copy of another in its place.
    nothing(A + B + '### Other\n\n> C.\n', A + B + A, 'the last slide replaced by a copy of another')
    nothing(A + '### Other\n\n> C.\n\n' + B, A + A + B, 'a slide replaced by a copy of another')
    nothing(A + B, A + A + B, 'a slide duplicated in place')
    nothing(A + B, B, 'the first slide deleted')
    nothing(A + B, A, 'the last slide deleted')
    nothing(A + B + A, A + A, 'the middle slide deleted')
    // The same slides, one of them edited where it stands: that one is written and no other.
    for (const head of ['', HEAD]) {
      const edited = typed(`${head}${A}${B}`, `${head}${A}${B.replace(/example\.org\/b/, 'example.org/b2')}`, layout)
      assert.equal(edited.outline, `${head}${A}${B.replace('### Same\n', '### Same\n{form=web}\n').replace(/example\.org\/b/, 'example.org/b2')}`, `the link of the second of two slides edited (compiled ${layout}): only the second is written`)
      const first = typed(`${head}${A}${B}`, `${head}${A.replace(/example\.org\/a/, 'example.org/a2')}${B}`, layout)
      assert.equal(first.outline, `${head}${A.replace('### Same\n', '### Same\n{form=web}\n').replace(/example\.org\/a/, 'example.org/a2')}${B}`, `the link of the first of two slides edited (compiled ${layout}): only the first is written`)
    }
  }
  {
    // Two quote slides with no id; the address is typed, then pasted, under the second: only the second is written.
    const one = '### Quote\n\n> First words.\n\n'
    const two = '### Quote\n\n> Second words.\n'
    for (const [label, was, now, form] of [['typed', '', `\n${WEB}\n`, 'web'], ['pasted over a placeholder', '\n(link)\n', `\n${WEB}\n`, 'web'], ['a DOI pasted', '', `\n${DOI}\n`, 'paper'], ['completed from a partial one', '\nhttps://exam\n', `\n${WEB}\n`, 'web'], ['on a source line', '\n- Author Name\n', `\n- Author Name ${WEB}\n`, 'web']]) {
      for (const head of ['', HEAD]) {
        const written = typed(`${head}${one}${two}${was}`, `${head}${one}${two}${now}`, was.includes('https://') || now.startsWith('\nhttps') ? 'copy-visual' : 'quote')
        assert.equal(written.outline, `${head}${one}${two.replace('### Quote\n', `### Quote\n{form=${form}}\n`)}${now}`, `two slides with no id, the address ${label} under the second: only the second is written`)
        // And under the first, with the second after it: only the first.
        const above = typed(`${head}${two}${was}\n${one}`, `${head}${two}${now}\n${one}`, was.includes('https://') || now.startsWith('\nhttps') ? 'copy-visual' : 'quote')
        assert.equal(above.outline, `${head}${two.replace('### Quote\n', `### Quote\n{form=${form}}\n`)}${now}\n${one}`, `two slides with no id, the address ${label} under the first: only the first is written`)
      }
    }
  }

  // What Dominik typed (issue 139) still works: a new slide with no id, the quotation, then the address on its own line
  // (absent before, or typed as far as a shorter address), or a source line; other slides around it, lines added above it.
  const around = ['### Opening\n{id=open}\n\n- one\n- two\n\n', '### Same\n\n> Other words.\n\n- Other Author https://example.org/other\n\n']
  for (const [label, was, now, form] of [
    ['the address typed', '', `\n${WEB}\n`, 'web'],
    ['the address completed', '\nhttps://example.o\n', `\n${WEB}\n`, 'web'],
    ['a DOI address typed', '', `\n${DOI}\n`, 'paper'],
    ['a source line typed', '', `\n- Author Name ${WEB}\n`, 'web'],
    ['a link added to a source line', '\n- Author Name\n', `\n- Author Name ${WEB}\n`, 'web']
  ]) {
    for (const eol of ['\n', '\r\n']) {
      const slide = '### Quote\n\n> Words of the quotation.\n'
      const before = doc(`${around[0]}${around[1]}${slide}${was}\n### Same\n\n> Last words.\n`, eol)
      const after = doc(`${around[0]}${around[1]}${slide}${now}\n### Same\n\n> Last words.\n`, eol)
      const written = typed(before, after, was.includes('https://') || now.includes('\nhttps') ? 'copy-visual' : 'quote')
      assert.equal(written.form, form, `no id, ${label} (${JSON.stringify(eol)}): the form is set`)
      const lines = written.outline.split('\n').map((line) => line.replace(/\r$/, ''))
      assert.equal(lines[lines.indexOf('### Quote') + 1], `{form=${form}}`, `no id, ${label}: written under the edited slide's heading`)
      assert.equal(lessLayoutLines(written.outline), lessLayoutLines(after), `no id, ${label}: nothing else changed`)
    }
  }

  // The callback for slides with no id: asked for the one slide the edit lies in (paired), never for another slide
  // with no id; slides with ids are asked about as always; all last to first, with the heading line in `after`.
  const asked = []
  const pair = '### A\n\n> Words.\n\n### B\n{id=b}\n\n> Words.\n\n### C\n\n> Words.\n'
  const ask = (before, after) => { asked.length = 0; setFormOnLinkEdits(before, after, (line) => { asked.push(line); return 'quote' }); return [...asked] }
  assert.deepEqual(ask(pair, `${pair}\n${WEB}\n`), [10, 5], 'an edit in the last slide: that slide, then the slide with an id; the first slide (no id, not edited) is not asked about')
  assert.deepEqual(ask(pair, pair.replace('### A\n\n> Words.', '### A\n\n> Other words.')), [5, 1], 'an edit in the first slide: the slide with an id, then that slide')
  assert.deepEqual(ask(pair, pair.replace('{id=b}\n\n> Words.', '{id=b}\n\n> Other words.')), [5], 'an edit in the slide with an id: no slide with no id is asked about')
  assert.deepEqual(ask(pair, `### New\n\n> Words.\n\n${pair}`), [9], 'a slide added: only the slide with an id is asked about')
  assert.deepEqual(ask(pair, pair), [10, 5, 1], 'no edit: every slide is its own pair, asked about and passed over')
}
{
  // The statement, with none of the rule's code: slides are known here as the blocks they were generated as (a heading
  // to the next heading), `before` and `after` are orders of such blocks, and the result is split at its headings again.
  //   1. A block of `after` with no `{id=` that is, byte for byte, a block of `before` comes back byte for byte.
  //   2. A block of `after` with no `{id=` is written ONLY IF the two texts are identical outside it (the text before
  //      it starts `before`, the text after it ends `before`, and the two do not overlap there) AND the first link in
  //      what `before` holds between them is not the first link in the block.
  // The edits: slides added, removed, moved, duplicated and retitled, ids added and removed, quotations and links
  // edited, addresses typed; one to three of them at once.
  let seed = 20261013
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const pick = (list) => list[Math.floor(random() * list.length)]
  const LINKS = [WEB, DOI, 'https://example.org/one', 'https://example.net/two', 'https://doi.org/10.5555/777']
  const LINK = /https?:\/\/\S+/
  const linkOf = (text) => text.match(LINK)?.[0] ?? ''
  let stamp = 0
  const block = () => {
    stamp += 1
    const heading = `### ${pick(['Same', 'Same', 'Quote', 'Quote', `Slide ${stamp}`])}`
    const trigger = pick([[], [], [], [], [`{id=g${stamp}}`], [`{id=g${stamp} quote}`], ['{quote}']])
    const source = pick([[], [], [pick(LINKS), ''], [`- Author ${stamp}`, ''], [`- Author ${stamp} ${pick(LINKS)}`, ''], [pick(LINKS), ''], ['- one', '- two', '']])
    return [heading, ...trigger, '', `> Words of quotation ${pick([1, 2, 3, stamp])}.`, '', ...source].join('\n')
  }
  const EDITS = {
    remove: (after, at) => { if (after.length > 1) after.splice(at, 1) },
    add: (after, at) => { after.splice(at, 0, block()) },
    move: (after, at) => { after.splice(Math.floor(random() * after.length), 0, ...after.splice(at, 1)) },
    duplicate: (after, at) => { after.splice(at, 0, after[Math.floor(random() * after.length)]) },
    retitle: (after, at) => { after[at] = after[at].replace(/^### [^\n]*/, (heading) => pick([`${heading} `, `${heading} again`, '### Same', '### Quote', heading.replace('### ', '###  ')])) },
    gainId: (after, at) => { if (!after[at].includes('{id=')) { stamp += 1; after[at] = after[at].replace(/^(### [^\n]*)\n/, `$1\n{id=n${stamp}}\n`) } },
    loseId: (after, at) => { after[at] = after[at].replace(/\{id=[^ }]*\}\n/, '').replace(/\{id=[^ }]* /, '{') },
    words: (after, at) => { after[at] = after[at].replace(/(> Words of quotation [^\n]*)\./, '$1, edited.') },
    address: (after, at) => { after[at] = after[at].replace(/\n$/, `\n${pick(LINKS)}\n`) },
    sourceLink: (after, at) => { after[at] = after[at].replace(/(- Author \d+)\n/, `$1 ${pick(LINKS)}\n`) },
    otherLink: (after, at) => { after[at] = after[at].replace(LINK, (link) => pick(LINKS.filter((other) => other !== link))) },
    longerLink: (after, at) => { after[at] = after[at].replace(LINK, (link) => `${link}-two`) }
  }
  const KINDS = Object.keys(EDITS)
  const splitAtHeadings = (text) => text.split(/\n(?=### )/)
  const counts = { pairs: 0, held: 0, written: 0, moved: 0, noId: 0, noIdWritten: 0, outsideSameNotWritten: 0, byEdit: {} }
  for (let round = 0; round < 2500; round += 1) {
    const before = Array.from({ length: 2 + Math.floor(random() * 6) }, block)
    const after = [...before]
    const made = []
    for (let edits = pick([1, 1, 1, 2, 3]); edits > 0; edits -= 1) {
      const kind = pick(KINDS)
      made.push(kind)
      EDITS[kind](after, Math.floor(random() * after.length))
    }
    const beforeText = before.join('\n')
    const afterText = after.join('\n')
    assert.deepEqual(splitAtHeadings(afterText), after, 'the generated blocks are the slides')
    const known = new Set(before)
    for (const layout of ['quote', 'copy-visual']) {
      const written = typed(beforeText, afterText, layout)
      const result = splitAtHeadings(written.outline)
      assert.equal(result.length, after.length)
      counts.pairs += 1
      if (written.set) counts.written += 1
      const show = `(round ${round}, compiled ${layout}, edits ${made.join('+')})\n--- before\n${beforeText}\n--- after\n${afterText}\n--- result\n${written.outline}`
      let from = 0
      after.forEach((text, index) => {
        // The block's own place in `after`, sliced here: the text before its heading, and the text from the next heading on.
        const head = afterText.slice(0, from)
        from += text.length + 1
        const tail = afterText.slice(Math.min(from, afterText.length))
        assert.equal(lessLayoutLines(result[index]), lessLayoutLines(text), `more than a layout line changed on slide ${index} ${show}`)
        if (text.includes('{id=')) return
        counts.noId += 1
        const wasWritten = result[index] !== text
        const outsideSame = beforeText.length >= head.length + tail.length && beforeText.startsWith(head) && beforeText.endsWith(tail)
        const spanBefore = outsideSame ? beforeText.slice(head.length, beforeText.length - tail.length) : null
        if (wasWritten) {
          counts.noIdWritten += 1
          for (const kind of made) counts.byEdit[kind] = (counts.byEdit[kind] ?? 0) + 1
          assert(outsideSame, `a slide with no id was written though the texts differ outside it: slide ${index} ${show}`)
          assert.notEqual(linkOf(spanBefore), linkOf(text), `a slide with no id was written though its source link is the one it had: slide ${index} ${show}`)
          assert(/^### [^\n]*\n\{[^\n]*form=(web|paper)[^\n]*\}\n/.test(result[index]), `the write is a form on the layout line: slide ${index} ${show}`)
        } else if (outsideSame && spanBefore !== `${text}${tail ? '\n' : ''}`) counts.outsideSameNotWritten += 1
        if (!known.has(text)) return
        counts.held += 1
        if (before[index] !== text) counts.moved += 1
        assert.equal(result[index], text, `a slide with no id that was not edited was written: slide ${index} ${show}`)
      })
    }
  }
  console.log(`slides with no id: ${counts.noId} checked in ${counts.pairs} pairs; ${counts.noIdWritten} written, each with the texts identical outside it and its link changed (edits in those pairs: ${JSON.stringify(counts.byEdit)}); ${counts.outsideSameNotWritten} edited in place and rightly not written; ${counts.held} unedited (${counts.moved} of them at another position than before), none written; a form was set somewhere in ${counts.written} pairs`)
  assert(counts.held > 2000 && counts.moved > 500 && counts.written > 50, 'the generated pairs exercised unedited slides with no id, moved ones, and writes')
  assert(counts.noIdWritten > 100 && counts.outsideSameNotWritten > 100, 'the generated pairs wrote slides with no id, and left edited ones unwritten')
  for (const kind of ['address', 'sourceLink', 'otherLink', 'longerLink', 'retitle', 'words']) assert(counts.byEdit[kind] > 0, `no slide with no id was written in a pair with the edit "${kind}"`)
}

// ── C. The compiler ────────────────────────────────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'tw-quote-address-'))
async function compile(slides) {
  const md = `${HEAD}${slides.join('\n\n')}\n`
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(path, md)
  const model = await prepareSource(path, md, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
  const html = await buildDeckHtmlFromModel(model)
  const section = (id) => html.match(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''
  return { model, section, slide: (id) => model.slides.find((candidate) => candidate.id === id), warnings: model.warnings ?? [] }
}
/** The slide's phone text as the handout shows it: read from the slide's text (not its blocks), then given the form's source line. */
const phoneText = (deck, id) => quoteFormScriptBlocks(renderScriptBlocks(buildSlideScriptPayload(deck.model.slides)[id]), quoteFormSources(deck.model.slides)[id] ?? null)
/** Everything a reader of the compiled slide sees: layout, blocks, markup, the handout's and print's source link, the phone text. */
const seen = (deck, id) => JSON.stringify({ layout: deck.slide(id).layout, blocks: deck.slide(id).blocks, section: deck.section(id), handout: quoteFormSources(deck.model.slides)[id] ?? null, phone: phoneText(deck, id), warnings: deck.warnings })

try {
  // With a form, the address under the quotation compiles exactly as the same address on a source line.
  const SHAPES = [['web', '{id=s form=web}', WEB], ['web with {quote}', '{id=s quote form=web}', WEB], ['paper', '{id=s form=paper}', DOI], ['plain', '{id=s quote form=plain}', WEB], ['tweet', '{id=s form=tweet}', 'https://x.com/sample/status/1234567890123456789'], ['video', '{id=s form=video}', 'https://www.youtube.com/watch?v=XXXXXXXXXXX&t=42s'], ['book', '{id=s form=book}', WEB]]
  const shown = []
  for (const [label, trigger, address] of SHAPES) {
    // `>` quotations, and a paragraph wholly in quotation marks (a promoted quotation; a line straight under it would join the paragraph).
    const blockLine = await compile([`### Quote\n${trigger}\n\n> Words of the quotation.\n\n- ${address}`])
    const promotedLine = await compile([`### Quote\n${trigger}\n\n"Words of the quotation."\n\n- ${address}`])
    assert.deepEqual(phoneText(promotedLine, 's'), phoneText(blockLine, 's'), `${label}: a quoted paragraph and its source line read on the phone as the > quotation does`)
    assert.equal(JSON.stringify(promotedLine.slide('s').blocks), JSON.stringify(blockLine.slide('s').blocks), `${label}: a quoted paragraph compiles to the > quotation's blocks`)
    for (const [how, body, line] of [
      ['one blank line', `> Words of the quotation.\n\n${address}`, blockLine],
      ['no blank line', `> Words of the quotation.\n${address}`, blockLine],
      ['a comment between', `> Words of the quotation.\n\n<!-- a comment -->\n\n${address}`, blockLine],
      ['a quoted paragraph, one blank line', `"Words of the quotation."\n\n${address}`, promotedLine],
      ['a quoted paragraph, three blank lines', `"Words of the quotation."\n\n\n\n${address}`, promotedLine],
      ['a quoted paragraph, a comment between', `"Words of the quotation."\n\n<!-- a comment -->\n\n${address}`, promotedLine]
    ]) {
      const bare = await compile([`### Quote\n${trigger}\n\n${body}`])
      assert.equal(seen(bare, 's'), seen(line, 's'), `${label}, ${how}: the address on its own line compiles as the address on a source line`)
      assert.equal(bare.slide('s').layout, 'quote', `${label}: a quote slide`)
      assert(!bare.slide('s').blocks.some((block) => block.type === 'embed') && !/<iframe|class="embed/.test(bare.section('s')), `${label}: no embed card`)
      assert.equal(bare.slide('s').blocks.find((block) => block.type === 'quote').cite, address, `${label}: the address is the quote's source, not the slide title`)
      assert.deepEqual(phoneText(bare, 's').map((block) => block.type), ['quote', 'attrib'], `${label}, ${how}: the phone text has the words and one source line`)
      if (how === 'one blank line') shown.push(`${label}: ${quoteFormSources(bare.model.slides).s?.attribution || '(no attribution line)'}`)
    }
  }
  console.log(`attribution with only a link, on a source line or under the quotation: ${shown.join('; ')}`)
  {
    const web = await compile([`### Quote\n{id=s form=web}\n\n> Words of the quotation.\n\n${WEB}`])
    const figure = web.section('s').match(/<figure class="qf qf-web[\s\S]*<\/figure>/)?.[0] ?? ''
    assert(figure.includes('<span class="qf-web-host">example.org</span>') && !figure.includes('Quote'), 'the web page shows the site in its address pill, and the slide title nowhere')
    const paper = await compile([`### Quote\n{id=s form=paper}\n\n> Words of the quotation.\n\n${DOI}`])
    assert(paper.section('s').includes('<span class="qf-doi">doi:10.1000/xyz123</span>') && !/<figure[\s\S]*Quote[\s\S]*<\/figure>/.test(paper.section('s')), 'the paper shows the DOI in its footer, and the slide title nowhere')
  }

  {
    // C3, the review's reproduction, on the payload itself: the words are a quote and the address its attribution.
    const deck = await compile([`### Quote\n{id=s form=web}\n\n"Words."\n\n${WEB}`, `### Quote\n{id=line form=web}\n\n"Words."\n\n- ${WEB}`, `### Quote\n{id=tail form=web}\n\n"Words." — Jane Example ${WEB}`, `### Quote\n{id=pictured quote form=plain}\n\n![The page](assets/page.png)\n\n"Words."\n\n${WEB}`, `### Jane Example\n{id=titled form=web}\n\n"Words."`])
    const payload = buildSlideScriptPayload(deck.model.slides)
    const asQuote = [{ type: 'quote', text: 'Words.' }, { type: 'attrib', text: WEB }]
    assert.deepEqual(payload.s, asQuote, 'a quoted paragraph and the address under it: a quote and its attribution on the phone')
    assert.deepEqual(payload.line, asQuote, 'a quoted paragraph and a source line: the same')
    assert.deepEqual(payload.tail, [{ type: 'quote', text: 'Words.' }, { type: 'attrib', text: `Jane Example ${WEB}` }], 'the source on the paragraph itself')
    assert.deepEqual(payload.pictured, [{ type: 'media', alt: 'The page' }, ...asQuote], 'the picture keeps its place; Plain is a form too')
    assert.deepEqual(payload.titled, [{ type: 'quote', text: 'Words.' }], 'no source: the slide title is not written into the phone text')
    // With no form the phone text is as it was before the ticket (the recorded hashes below hold the address shape).
    const formless = await compile([`### Quote\n{id=s quote}\n\n"Words."\n\n- Jane Example ${WEB}`, `### Quote\n{id=auto quote form=auto}\n\n"Words."\n\n- Jane Example ${WEB}`])
    for (const id of ['s', 'auto']) assert.deepEqual(buildSlideScriptPayload(formless.model.slides)[id], [{ type: 'p', text: '"Words."' }, { type: 'list', items: [{ depth: 0, text: `Jane Example ${WEB}` }] }], 'no form: unchanged')
    assert(!formless.model.slides.some((slide) => 'quoteFormSet' in slide), 'a slide with no form carries no mark')
  }

  // ── C2. Whatever the editor's rule writes, the compiler draws ────────────────────────────────────────────────────
  {
    const PICTURE = '![The page](assets/page.png)'
    const NOT_PICTURES = ['![Video](movie.mp4)', '![Clip](assets/clip.webm){autoplay}{loop}', '![Film](https://example.org/film.mov?x=1)', '![Sound](assets/sound.mp3)', '![Sound](assets/sound.m4a "A caption")', '![Pooled](vid-abc1234)', '[Video: movie.mp4]']
    // The review's reproduction: a video in image syntax above the quotation, the address appended.
    for (const media of NOT_PICTURES) {
      const start = doc(`### Q\n{id=s}\n\n${media}\n\n> Words.\n`)
      const after = `${start}\nhttps://example.org/page\n`
      for (const layout of ['copy-visual', 'quote']) assert.deepEqual(typed(start, after, layout), { outline: after, set: false, form: null }, `${media} above the quotation (compiled ${layout}): no form is written`)
      const marked = doc(`### Q\n{id=s quote}\n\n> Words.\n`)
      assert.equal(typed(marked, `${marked}\nhttps://example.org/page\n\n${media}\n`, undefined).set, false, `${media} after the address on a {quote} slide: no form is written`)
      assert.equal(readQuoteSlideLines([media, '', '> Words.', '', WEB], 'web').address, null, `${media}: the address is not the source line`)
      assert.equal(readQuoteSlideLines([media, '', '> Words.'], '').picture, false, `${media} is not a picture`)
      assert.equal(readQuoteSlideLines([media, '', '> Words.', '', '- Author'], '').otherContent, true, `${media} is content beside the quotation`)
      // With the form chosen by hand, the verbs say what the compiler does: other content, so the slide is drawn Plain.
      const chosen = doc(`### Q\n{id=s quote form=web}\n\n${media}\n\n> Words.\n\nhttps://example.org/page\n`)
      const described = describeQuoteSource(chosen, 's', 'quote')
      assert.deepEqual([described.otherContent, described.presentation], [true, 'plain'], `${media}: describeQuoteSource reports other content`)
      const deck = await compile([`### Q\n{id=s quote form=web}\n\n${media}\n\n> Words.\n\nhttps://example.org/page`])
      if (!media.includes('vid-')) assert(!deck.slide('s').blocks.some((block) => block.quoteForm), `${media}: and the compiler draws no form`)
    }
    assert.equal(readQuoteSlideLines([PICTURE, '', '> Words.', '', WEB], 'web').address?.url, WEB, 'a picture is still a picture')
    assert.deepEqual([readQuoteSlideLines([PICTURE, '', '> Words.']).picture, readQuoteSlideLines([PICTURE, '', '> Words.', '', '- Author']).otherContent], [true, false])

    // The statement: every slide below is compiled with the address typed, the rule is run with the layouts the
    // compiler gave, and what it wrote is compiled again. A written form must be drawn: a quote slide, that form, no card.
    const table = [
      ['{id=ID}', [], '> Words of the quotation.', []],
      ['{id=ID quote}', [PICTURE], '> Words of the quotation.', []],
      ['{id=ID}', [PICTURE], '> Words of the quotation.', []],
      ['{id=ID}', ['![Video](movie.mp4)'], '> Words.', []],
      ['{id=ID quote}', ['![Video](movie.mp4)'], '> Words.', []],
      ['{id=ID quote form=auto}', ['![Sound](assets/sound.mp3)'], '"Words."', []],
      ['{id=ID}', [], '"Words of the quotation."', ['![Video](movie.mp4)']]
    ]
    const TRIGGERS = ['{id=ID}', '{id=ID quote}', '{id=ID quote form=auto}', '{id=ID form=auto}']
    const ABOVE = [[], [PICTURE], ['![The page](assets/page.png "A caption")'], [PICTURE, '', '![Second](assets/second.png)'], ['![a](assets/a.png) ![b](assets/b.png)'], ...NOT_PICTURES.map((media) => [media]), [PICTURE, '', '![Video](movie.mp4)']]
    const BELOW = [[], [PICTURE], ['![Video](movie.mp4)'], ['![Sound](assets/sound.mp3)']]
    for (const trigger of TRIGGERS) for (const above of ABOVE) for (const words of ['> Words of the quotation.', '"Words of the quotation."']) for (const below of BELOW) table.push([trigger, above, words, below])
    // Trigger lines among the content (third review round): the compiler folds them into the slide and takes them out
    // before it reads the quotation. `between` stands between the quotation and the address.
    const BODY_TRIGGERS = ['{reveal}', '{mode=focus}', '{form=web}', '{form=paper}', '{form=auto}', '{form=plain}', '{quote}', '{cards}', '{copy-visual}', '{2col}']
    const bodyTriggerRows = []
    for (const trigger of TRIGGERS) for (const words of ['> Words of the quotation.', '"Words of the quotation."']) for (const line of BODY_TRIGGERS) {
      bodyTriggerRows.push([trigger, [line], words, [], []], [trigger, [], words, [], [line]], [trigger, [], words, [line], []], [trigger, [PICTURE], words, [], [line]], [trigger, [line], words, [], ['{reveal}']])
    }
    const firstBodyTriggerRow = table.length
    table.push(...bodyTriggerRows)
    // Speaker notes (fourth review round): the compiler drops them, so a notes block is not content wherever it
    // stands, alone or with a Trigger line among the content beside it.
    const notesRows = []
    for (const trigger of TRIGGERS) for (const words of ['> Words of the quotation.', '"Words of the quotation."']) {
      notesRows.push([trigger, [NOTES], words, [], []], [trigger, [], words, [NOTES], []], [trigger, [], words, [], [NOTES]], [trigger, [PICTURE], words, [], [NOTES]], [trigger, [NOTES, PICTURE], words, [NOTES], [NOTES]])
      notesRows.push([trigger, [], words, [], [NOTES, '{reveal}']], [trigger, [], words, [], ['{reveal}', NOTES]], [trigger, [NOTES], words, ['{mode=focus}'], []], [trigger, [], words, [], [NOTES, '{form=web}']], [trigger, [], words, [NOTES], ['{cards}']])
    }
    const firstNotesRow = table.length
    table.push(...notesRows)
    const slideText = ([trigger, above, words, below, between = []], index, address) => ['### Quote', trigger.replace('ID', `g${index}`), '', ...above.flatMap((line) => [line, '']), words, '', ...between.flatMap((line) => [line, '']), ...(address ? [address, ''] : []), ...below.flatMap((line) => [line, ''])].join('\n').trimEnd()
    const addressOf = (index) => (index % 3 === 2 ? DOI : WEB)
    const before = `${HEAD}${table.map((row, index) => slideText(row, index, '')).join('\n\n')}\n`
    const after = `${HEAD}${table.map((row, index) => slideText(row, index, addressOf(index))).join('\n\n')}\n`
    const compileText = async (text) => {
      const path = join(dir, `g-${Math.random().toString(36).slice(2)}.md`)
      writeFileSync(path, text)
      return prepareSource(path, text, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
    }
    const compiledBefore = await compileText(before)
    const compiledAfter = await compileText(after)
    const layoutAt = new Map(compiledAfter.slides.map((slide) => [slide.sourceLine, slide.layout]))
    const written = setFormOnLinkEdits(before, after, (line) => layoutAt.get(line))
    assert.equal(lessLayoutLines(written.outline), lessLayoutLines(after), 'only layout lines changed')
    const recompiled = await compileText(written.outline)
    const counts = { written: 0, web: 0, paper: 0, notWritten: 0, promotedLayout: 0, withPicture: 0, quotedParagraph: 0, bodyTrigger: 0, bodyTriggerBetween: 0, bodyTriggerNotWritten: 0, notes: 0, notesWithTrigger: 0, notesNotWritten: 0 }
    const isBodyTrigger = (line) => BODY_TRIGGERS.includes(line)
    table.forEach((row, index) => {
      const id = `g${index}`
      const form = written.outline.match(new RegExp(`\\{id=${id}\\b[^\\n]*?form=(web|paper)`))?.[1] ?? null
      const label = `${JSON.stringify(slideText(row, index, addressOf(index)))}`
      const notPicture = [...row[1], ...row[3]].some((line) => NOT_PICTURES.includes(line))
      if (!form) {
        counts.notWritten += 1
        if (index >= firstNotesRow) counts.notesNotWritten += 1
        else if (index >= firstBodyTriggerRow) counts.bodyTriggerNotWritten += 1
        return
      }
      if (index >= firstNotesRow) {
        counts.notes += 1
        if ([...row[1], ...row[3], ...(row[4] ?? [])].some(isBodyTrigger)) counts.notesWithTrigger += 1
      }
      if (index >= firstBodyTriggerRow) {
        if (index < firstNotesRow) counts.bodyTrigger += 1
        if (index < firstNotesRow && (row[4] ?? []).length) counts.bodyTriggerBetween += 1
        assert(!recompiled.warnings?.includes(`quote-form-other-content:${id}`), `the editor wrote ${form} and the compiler says there is other content: ${label}`)
      }
      assert(!notPicture, `a form was written on a slide with a video or an audio file: ${label}`)
      const slide = recompiled.slides.find((candidate) => candidate.id === id)
      assert.equal(slide.layout, 'quote', `the editor wrote ${form} but the compiler does not make it a quote slide: ${label}`)
      assert.equal(slide.blocks.find((block) => block.type === 'quote')?.quoteForm?.form, form, `the editor wrote ${form} but the compiler does not draw it: ${label}`)
      assert(!slide.blocks.some((block) => block.type === 'embed' || block.type === 'video' || block.type === 'audio'), `the editor wrote ${form} but the card is still drawn: ${label}`)
      assert.equal(form, addressOf(index) === DOI ? 'paper' : 'web')
      // Writing the form changes nothing about which words are the quotation, and the source is the typed address.
      const wordsBefore = compiledWords(compiledBefore.slides.find((candidate) => candidate.id === id))
      assert(wordsBefore.length > 0 && compiledWords(slide).length > 0, `the editor wrote ${form} on a slide with no quoted words: ${label}`)
      assert.deepEqual(compiledWords(slide), wordsBefore, `the editor wrote ${form} and the quotation's words are not the words compiled before the edit: ${label}`)
      assert.equal(slide.blocks.find((block) => block.type === 'quote').quoteForm.awaiting, false, `the editor wrote ${form} and the compiler finds no words: ${label}`)
      assert.equal(compiledLink(slide), addressOf(index), `the editor wrote ${form} and the compiler cites another link: ${label}`)
      counts.written += 1
      counts[form] += 1
      if (layoutAt.get(compiledAfter.slides.find((candidate) => candidate.id === id).sourceLine) === 'copy-visual') counts.promotedLayout += 1
      if (slide.blocks.some((block) => block.type === 'image' || block.type === 'image-row')) counts.withPicture += 1
      if (row[2].startsWith('"')) counts.quotedParagraph += 1
    })
    // Every slide that is only the quotation and the address is written, so the statement is not empty.
    table.forEach((row, index) => {
      // A Trigger line that sets neither a form nor a layout is not content: with only such lines beside them, the
      // quotation and its address still take the form, wherever the line stands.
      const lines = [...row[1], ...row[3], ...(row[4] ?? [])]
      if (lines.some((line) => !['{reveal}', '{mode=focus}', NOTES].includes(line))) return
      assert(new RegExp(`\\{id=g${index}\\b[^\\n]*?form=(web|paper)`).test(written.outline), `a quotation and its address alone take the form: ${slideText(row, index, addressOf(index))}`)
    })
    // A form among the content is the form in effect (or, as `form=auto`, undoes the token), so nothing is written.
    table.forEach((row, index) => {
      if (![...row[1], ...row[3], ...(row[4] ?? [])].some((line) => /^\{form=/.test(line))) return
      assert(!new RegExp(`\\{id=g${index}\\b[^\\n]*?form=(web|paper)`).test(written.outline), `a form among the content: no token is written: ${slideText(row, index, addressOf(index))}`)
    })
    assert.deepEqual(written.outline.split('\n').filter(isBodyTrigger), after.split('\n').filter(isBodyTrigger), 'every Trigger line among the content is as typed')
    console.log(`what the editor writes, the compiler draws: ${table.length} slides, a form written on ${counts.written} (web ${counts.web}, paper ${counts.paper}; ${counts.promotedLayout} compiled copy-visual before; ${counts.withPicture} with a picture; ${counts.quotedParagraph} quoted paragraphs; ${counts.bodyTrigger} with a Trigger line among the content, ${counts.bodyTriggerBetween} of them between the quotation and the address), nothing on ${counts.notWritten} (${counts.bodyTriggerNotWritten} with such a line)`)
    assert(counts.bodyTrigger >= 30 && counts.bodyTriggerBetween >= 8 && counts.bodyTriggerNotWritten >= 50, 'the statement covers Trigger lines among the content, written and not')
    assert(counts.notes >= 30 && counts.notesWithTrigger >= 12 && counts.notesNotWritten >= 16, `the statement covers speaker notes, alone and with Trigger lines, written and not: ${JSON.stringify(counts)}`)
    console.log(`  with speaker notes: a form written on ${counts.notes} slides (${counts.notesWithTrigger} with a Trigger line among the content too), nothing on ${counts.notesNotWritten}; every written form keeps the words compiled before the edit and cites the typed link`)
    assert(counts.web > 5 && counts.paper > 5 && counts.promotedLayout >= 4 && counts.withPicture > 5 && counts.quotedParagraph > 5 && counts.notWritten > 50)
  }
  // Fifth review round: the same statement over every token of the layout registry, asked of the page too.
  console.log(await registryCombinationCases(dir))

  // With a form, anything outside the rule keeps the address an embed card (and the slide plain, as other content does).
  for (const [label, body] of [['an [Embed: …] line', `> Words.\n\n[Embed: ${WEB}]`], ['two addresses', `> Words.\n\n${WEB}\n\n${DOI}`], ['a source line too', `> Words.\n\n- Author Name\n\n${WEB}`], ['two quotations', `> Words.\n\n> More words.\n\n${WEB}`], ['the address above', `${WEB}\n\n> Words.`], ['a paragraph between', `> Words.\n\nA sentence.\n\n${WEB}`]]) {
    const deck = await compile([`### Quote\n{id=s quote form=web}\n\n${body}`])
    assert(deck.slide('s').blocks.some((block) => block.type === 'embed'), `${label}: the embed card stays`)
    assert(!deck.slide('s').blocks.some((block) => block.quoteForm), `${label}: no form is drawn`)
  }

  // Rule 3: a slide with no form compiles exactly as before the ticket.
  const recorded = JSON.parse(readFileSync(join(root, 'scripts/fixtures/quote-forms/address-under-quote-formless-hashes.json'), 'utf8'))
  const live = await formlessHashes(root)
  assert.deepEqual(Object.keys(live).sort(), Object.keys(recorded).sort(), 'the recorded hashes cover the fixture slides')
  for (const key of Object.keys(recorded)) assert.equal(live[key], recorded[key], `form-less slide ${key} compiles differently from before the ticket`)
  assert(FORMLESS_SLIDES.length >= 15)

  // C4. Thumbnails: the ticket's mark `quoteFormSet` does not enter the picture key (`pictureKeyForSlide`, the
  // projection `render_hash`), so a slide that had a form before the ticket keeps its thumbnail. Computed on the
  // current tree, so it holds beside any other change to the slide model: for every slide of both fixture talks the
  // key equals the key of a copy without the mark, and (sensitivity control) differs from the key of a copy with
  // some other new property.
  let pictures = 0
  let marked = 0
  for (const [talk, text] of EXISTING_TALKS) {
    writeFileSync(join(dir, `${talk}.md`), text)
    const talkModel = await prepareSource(join(dir, `${talk}.md`), text, 'Talk', statSync(join(dir, `${talk}.md`)), undefined, { allowedAssetRoots: [dir] })
    for (const slide of talkModel.slides) {
      const key = pictureKeyForSlide(slide)
      assert.match(key, /^sha256-[0-9a-f]{64}$/)
      const withoutMark = structuredClone(slide)
      delete withoutMark.quoteFormSet
      assert.equal(key, pictureKeyForSlide(withoutMark), `${talk}: slide ${slide.id}: the quoteFormSet mark is part of its picture key, so its thumbnail would be drawn again`)
      const withProbe = structuredClone(slide)
      withProbe.__probe = true
      assert.notEqual(key, pictureKeyForSlide(withProbe), `${talk}: slide ${slide.id}: another new property does not change the picture key, so this check cannot see a mark that enters it`)
      if (slide.quoteFormSet === true) marked += 1
      pictures += 1
    }
  }
  assert(pictures >= 35 && marked >= 14, `the check covers slides with a form (${marked} of ${pictures})`)
  {
    // The proof has teeth: such a slide does carry the ticket's mark in its model (the phone text reads it), and the
    // mark is not part of the picture identity.
    const [, text] = EXISTING_TALKS[0]
    writeFileSync(join(dir, 'existing.md'), text)
    const model = await prepareSource(join(dir, 'existing.md'), text, 'Talk', statSync(join(dir, 'existing.md')), undefined, { allowedAssetRoots: [dir] })
    const markedIds = model.slides.filter((slide) => slide.quoteFormSet === true).map((slide) => slide.id)
    assert(markedIds.includes('web-source-line') && markedIds.includes('plain-source-line') && markedIds.length >= 12, 'slides with a form carry the mark')
    assert(!markedIds.some((id) => /^(formless|automatic|a)-/.test(id)), 'slides with no form do not')
    const inherited = EXISTING_TALKS[1][1]
    writeFileSync(join(dir, 'inherited.md'), inherited)
    const inheritedModel = await prepareSource(join(dir, 'inherited.md'), inherited, 'Talk', statSync(join(dir, 'inherited.md')), undefined, { allowedAssetRoots: [dir] })
    assert.deepEqual(inheritedModel.slides.filter((slide) => slide.quoteFormSet === true).map((slide) => slide.id), ['inherited-source-line', 'inherited-no-quote-word'], 'a form from the talk settings marks its quote slides; form=auto on the slide does not')
  }

  // The proof has teeth: the same slide with a form does compile differently.
  const [, issueSlide] = FORMLESS_SLIDES[0]
  const formless = await compile([issueSlide.replace('f-issue', 's')])
  const formed = await compile([issueSlide.replace('{id=f-issue}', '{id=s form=web}')])
  assert.equal(formless.slide('s').layout, 'copy-visual')
  assert(formless.slide('s').blocks.some((block) => block.type === 'embed') && formless.slide('s').blocks[0].cite === 'Quote', 'with no form: the embed card and the title as attribution, as before')
  assert.notEqual(JSON.stringify(formless.slide('s').blocks), JSON.stringify(formed.slide('s').blocks))

  // ── D. From the editor to the compiler, and afterwards ───────────────────────────────────────────────────────────

  for (const [slideText, address, form] of [[QUOTE, WEB, 'web'], [QUOTE, DOI, 'paper'], ['### Quote\n\n> Words of the quotation.\n', WEB, 'web'], ['### Quote\n{id=q1}\n\n> Words of the quotation.\n\n<!-- a comment -->\n', WEB, 'web']]) {
    const before = doc(slideText)
    const written = typed(before, `${before}\n${address}\n`, 'copy-visual').outline
    writeFileSync(join(dir, 'written.md'), written)
    const model = await prepareSource(join(dir, 'written.md'), written, 'Talk', statSync(join(dir, 'written.md')), undefined, { allowedAssetRoots: [dir] })
    const slide = model.slides.find((candidate) => candidate.title === 'Quote')
    assert.equal(slide.layout, 'quote', `${form}: what the editor wrote is a quote slide to the compiler`)
    assert.equal(slide.blocks.find((block) => block.type === 'quote').quoteForm?.form, form, `${form}: and it draws that form`)
    // The save-time tidy-up leaves it alone, and nothing more is written after it.
    assert.equal(normalizePositions(written), written, 'the tidy-up moves nothing')
    assert.equal(collapseDuplicateLayouts(written).text, written)
    assert.equal(collapseDuplicateKeys(written).text, written)
    assert.equal(typed(written, normalizePositions(written), 'quote').set, false)
  }
  {
    // A heading that carries its tokens: the tidy-up moves them to the layout line; the form and the address stay.
    const before = doc('### Quote {id=q1}\n\n> Words.\n')
    const written = typed(before, `${before}\n${WEB}\n`, 'copy-visual').outline
    const tidy = collapseDuplicateKeys(collapseDuplicateLayouts(normalizePositions(written)).text).text
    assert.equal(formsIn(tidy), 'form=web')
    assert(tidy.includes(`\n\n${WEB}\n`) && normalizePositions(tidy) === tidy, 'tidy once, stable after')
    assert.equal(typed(written, tidy, 'quote').set, false, 'the tidy-up is not an edit to the address')
  }

  const formed1 = typed(doc(QUOTE), doc(`${QUOTE}\n${WEB}\n`), 'copy-visual').outline
  {
    // The verbs read the address as the source line once the form is set.
    const described = describeQuoteSource(formed1, 'q1', 'quote')
    assert.deepEqual([described.form, described.otherContent, described.several, described.webLink, described.fields.link], ['web', false, false, 'example.org', WEB])
    assert.equal(readQuoteSlideLines(['> Words.', '', WEB]).otherContent, true, 'read with no form, the address is other content')
    assert.equal(readQuoteSlideLines(['> Words.', '', WEB], 'auto').cite, '')
    assert.deepEqual(readQuoteSlideLines(['> Words.', '', WEB], 'web').source, { index: 2, kind: 'address' })
    // set-quote-source: text added makes it a source line in place; a link alone stays a line of its own.
    assert(setQuoteSource(formed1, 'q1', { text: 'Jane Example, 2024' }, 'quote').outline.includes(`\n\n- Jane Example, 2024 ${WEB}\n`))
    const relinked = setQuoteSource(formed1, 'q1', { link: 'https://example.org/other' }, 'quote').outline
    assert(relinked.includes('\n\nhttps://example.org/other\n') && !relinked.includes(WEB) && !relinked.includes('- https'))
  }
  {
    // D2. The form in effect is the compiler's: the slide's own token, else the talk's `triggers:`. The verbs read the
    // address under the quotation as the source line under either, and give what the source-line shape gives.
    const PAGE = 'https://example.org/page'
    const SETTINGS = (form) => `---\noutline_version: 2\ntriggers: "{form=${form}}"\n---\n`
    const TALKS = [
      ['the form on the slide', (line, eol = '\n') => `# Talk\n\n### Q\n{id=q quote form=web}\n\n> Words.\n\n${line}\n`.replace(/\n/g, eol)],
      ['the form on the slide, no {quote}', (line, eol = '\n') => `# Talk\n\n### Q\n{id=q form=web}\n\n> Words.\n\n${line}\n`.replace(/\n/g, eol)],
      ['the form from the talk settings', (line, eol = '\n') => `${SETTINGS('web')}# Talk\n\n### Q\n{id=q quote}\n\n> Words.\n\n${line}\n`.replace(/\n/g, eol)],
      ['the form from the talk settings, no {quote}', (line, eol = '\n') => `${SETTINGS('web')}# Talk\n\n### Q\n{id=q}\n\n> Words.\n\n${line}\n`.replace(/\n/g, eol)],
      ['the form from the talk settings, no id', (line, eol = '\n') => `${SETTINGS('web')}# Talk\n\n### Q\n\n> Words.\n\n${line}\n`.replace(/\n/g, eol)]
    ]
    for (const [label, talk] of TALKS) {
      const ref = talk('').includes('{id=q') ? 'q' : { headingLine: talk('').split('\n').indexOf('### Q') + 1 }
      for (const eol of ['\n', '\r\n']) {
        const onItsOwnLine = talk(PAGE, eol)
        const onSourceLine = talk(`- ${PAGE}`, eol)
        const described = describeQuoteSource(onItsOwnLine, ref, 'quote')
        assert.deepEqual(described, describeQuoteSource(onSourceLine, ref, 'quote'), `${label}: describe says the same of the address on its own line as on a source line`)
        assert.deepEqual([described.form, described.chosen, described.presentation, described.otherContent, described.several, described.webLink, described.fields.link], ['web', true, 'window', false, false, 'example.org', PAGE], `${label}: a web page, with no other content`)
        assert.equal(described.token, label.includes('on the slide') ? 'web' : '', `${label}: the token is the slide's own`)
        const named = setQuoteSource(onItsOwnLine, ref, { text: 'Jane' }, 'quote')
        assert.deepEqual(named, setQuoteSource(onSourceLine, ref, { text: 'Jane' }, 'quote'), `${label}: set-quote-source gives the same outline from either shape`)
        assert.deepEqual(named, { outline: talk(`- Jane ${PAGE}`, eol), formSet: null }, `${label}: one source line, the address kept, no token written`)
        // A link alone stays a line of its own; the source line stays a source line.
        assert.deepEqual(setQuoteSource(onItsOwnLine, ref, { link: 'https://example.org/other' }, 'quote'), { outline: talk('https://example.org/other', eol), formSet: null }, `${label}: the address replaced in place`)
        assert.deepEqual(setQuoteSource(onSourceLine, ref, { link: 'https://example.org/other' }, 'quote'), { outline: talk('- https://example.org/other', eol), formSet: null })
      }
      // What the verb wrote compiles to a web page citing Jane, with no card; so does the address alone.
      const withId = (text) => (text.includes('{id=q') ? text : text.replace('### Q\n', '### Q\n{id=q}\n'))
      const named = withId(setQuoteSource(talk(PAGE), ref, { text: 'Jane' }, 'quote').outline)
      for (const [how, text, cite] of [['named', named, `Jane ${PAGE}`], ['the address alone', withId(talk(PAGE)), PAGE]]) {
        writeFileSync(join(dir, 'inherited-form.md'), text)
        const model = await prepareSource(join(dir, 'inherited-form.md'), text, 'Talk', statSync(join(dir, 'inherited-form.md')), undefined, { allowedAssetRoots: [dir] })
        const slide = model.slides.find((candidate) => candidate.id === 'q')
        const quote = slide.blocks.find((block) => block.type === 'quote')
        assert.deepEqual([slide.layout, quote?.quoteForm?.form, quote?.cite, slide.blocks.some((block) => block.type === 'embed')], ['quote', 'web', cite, false], `${label}, ${how}: the compiler draws a web page with that source and no card`)
      }
      // The link-edit rule: a slide whose form is set, its own or inherited, is never given a token.
      for (const layout of ['quote', 'copy-visual']) {
        for (const [what, before, after] of [['the address typed', talk('').replace(/\n\n\n$/, '\n'), talk(PAGE)], ['the address changed', talk(PAGE), talk(`${PAGE}-two`)], ['a link added to a source line', talk('- Jane'), talk(`- Jane ${PAGE}`)], ['a DOI typed', talk('').replace(/\n\n\n$/, '\n'), talk(DOI)]]) {
          assert.deepEqual(typed(before, after, layout), { outline: after, set: false, form: null }, `${label}, ${what} (compiled ${layout}): no token is written`)
        }
      }
    }
    {
      // Third review round: a Trigger line among the content. The compiler folds it into the slide (so `{form=web}`
      // there is the form in effect) and takes it out before it reads the quotation; the verbs read the same lines.
      // `FORM` stands where the label says; `LINE` is the address, on its own line or on a source line.
      const BODY = [
        ['the form before the quotation', '{id=q quote}', ['{form=web}', '', '> Words.', '', 'LINE']],
        ['the form before the quotation, no {quote}', '{id=q}', ['{form=web}', '', '> Words.', '', 'LINE']],
        ['the form between the quotation and the address', '{id=q quote}', ['> Words.', '', '{form=web}', '', 'LINE']],
        ['the form between, no blank lines', '{id=q quote}', ['> Words.', '{form=web}', 'LINE']],
        ['the form between, no {quote}', '{id=q}', ['> Words.', '', '{form=web}', '', 'LINE']],
        ['the form after the address', '{id=q quote}', ['> Words.', '', 'LINE', '', '{form=web}']],
        ['the form after the address, no {quote}', '{id=q}', ['> Words.', '', 'LINE', '{form=web}']],
        ['a Trigger line that is not a form between', '{id=q quote form=web}', ['> Words.', '', '{reveal}', '', 'LINE']],
        ['a Trigger line that is not a form between, the form from the talk settings', '{id=q}', ['> Words.', '', '{reveal}', '', 'LINE'], SETTINGS('web')],
        ['two Trigger lines, the form after the address', '{id=q quote}', ['> Words.', '', '{reveal}', '', 'LINE', '', '{form=web}']],
        ['a quoted paragraph, the form between', '{id=q quote}', ['"Words."', '', '{form=web}', '', 'LINE']]
      ]
      const compiled = async (text) => {
        writeFileSync(join(dir, 'body-trigger.md'), text)
        return prepareSource(join(dir, 'body-trigger.md'), text, 'Talk', statSync(join(dir, 'body-trigger.md')), undefined, { allowedAssetRoots: [dir] })
      }
      const triggerLines = (text) => text.split('\n').map((line, index) => [index, line]).filter(([, line]) => /^\{(form=web|reveal)\}\r?$/.test(line))
      for (const [label, trigger, body, settings = ''] of BODY) {
        const talk = (line, eol = '\n') => `${settings}# Talk\n\n### Q\n${trigger}\n\n${body.join('\n').replace('LINE', line)}\n`.replace(/\n/g, eol)
        for (const eol of ['\n', '\r\n']) {
          const onItsOwnLine = talk(PAGE, eol)
          const onSourceLine = talk(`- ${PAGE}`, eol)
          const described = describeQuoteSource(onItsOwnLine, 'q', 'quote')
          assert.deepEqual(described, describeQuoteSource(onSourceLine, 'q', 'quote'), `${label}: describe says the same of the address on its own line as on a source line`)
          assert.deepEqual([described.form, described.chosen, described.presentation, described.otherContent, described.several, described.webLink, described.fields.link], ['web', true, 'window', false, false, 'example.org', PAGE], `${label}: a web page, with no other content`)
          const named = setQuoteSource(onItsOwnLine, 'q', { text: 'Jane' }, 'quote')
          assert.deepEqual(named, setQuoteSource(onSourceLine, 'q', { text: 'Jane' }, 'quote'), `${label}: set-quote-source gives the same outline from either shape`)
          assert.deepEqual(named, { outline: talk(`- Jane ${PAGE}`, eol), formSet: null }, `${label}: the source line stands where the address stood, and no other line changed`)
          assert.deepEqual(triggerLines(named.outline), triggerLines(onItsOwnLine), `${label}: the Trigger line among the content is untouched and in place`)
          assert(triggerLines(named.outline).length >= 1)
          // A link alone stays a line of its own; and typing the address writes no token (the form is set).
          assert.deepEqual(setQuoteSource(onItsOwnLine, 'q', { link: 'https://example.org/other' }, 'quote'), { outline: talk('https://example.org/other', eol), formSet: null }, `${label}: the address replaced in place`)
          for (const layout of ['quote', 'copy-visual']) {
            const without = onItsOwnLine.replace(`${PAGE}${eol}`, '')
            assert.deepEqual(typed(without, onItsOwnLine, layout), { outline: onItsOwnLine, set: false, form: null }, `${label}, the address typed (compiled ${layout}): no token is written`)
          }
        }
        // What the verb wrote, from either shape, compiles to a web page citing Jane with the address as its link, no
        // card and no "other content" warning; so does the address alone.
        for (const [how, text, cite] of [['named, from the address', setQuoteSource(talk(PAGE), 'q', { text: 'Jane' }, 'quote').outline, `Jane ${PAGE}`], ['named, from the source line', setQuoteSource(talk(`- ${PAGE}`), 'q', { text: 'Jane' }, 'quote').outline, `Jane ${PAGE}`], ['the address alone', talk(PAGE), PAGE]]) {
          const model = await compiled(text)
          const slide = model.slides.find((candidate) => candidate.id === 'q')
          const quote = slide.blocks.find((block) => block.type === 'quote')
          assert.deepEqual([slide.layout, quote?.quoteForm?.form, quote?.cite, quote?.quoteForm?.fields?.link, slide.blocks.some((block) => block.type === 'embed')], ['quote', 'web', cite, PAGE, false], `${label}, ${how}: the compiler draws a web page with that source and no card`)
          assert(!(model.warnings ?? []).includes('quote-form-other-content:q'), `${label}, ${how}: no other-content warning`)
        }
      }
      {
        // The form among the content and no source at all: the source line goes directly after the quotation, above the
        // Trigger line, which stays where it is.
        for (const eol of ['\n', '\r\n']) {
          const bare = '# Talk\n\n### Q\n{id=q quote}\n\n> Words.\n\n{form=web}\n'.replace(/\n/g, eol)
          const named = setQuoteSource(bare, 'q', { text: 'Jane', link: PAGE }, 'quote')
          assert.deepEqual(named, { outline: `# Talk\n\n### Q\n{id=q quote}\n\n> Words.\n\n- Jane ${PAGE}\n\n{form=web}\n`.replace(/\n/g, eol), formSet: null }, 'no source yet: written directly after the quotation')
          const model = await compiled(named.outline)
          const quote = model.slides.find((candidate) => candidate.id === 'q').blocks.find((block) => block.type === 'quote')
          assert.deepEqual([quote?.quoteForm?.form, quote?.cite], ['web', `Jane ${PAGE}`])
        }
        // A source that runs over a Trigger line (a paragraph's tail): rewritten on its first line, the Trigger line kept.
        const tailed = '# Talk\n\n### Q\n{id=q quote form=web}\n\n"Words." — Jane\n{reveal}\nExample\n'
        assert.equal(describeQuoteSource(tailed, 'q', 'quote').otherContent, false, 'the Trigger line inside the paragraph is not content')
        const renamed = setQuoteSource(tailed, 'q', { text: 'John' }, 'quote').outline
        assert.equal(renamed, '# Talk\n\n### Q\n{id=q quote form=web}\n\n"Words." — John\n{reveal}\n', 'the source rewritten where it starts; the Trigger line is not removed')
        assert.equal((await compiled(renamed)).slides.find((candidate) => candidate.id === 'q').blocks.find((block) => block.type === 'quote')?.cite, 'John')
        // With no form, a Trigger line that is not a form between the quotation and a typed address: the compiler, having
        // folded it, sees the address directly under the quotation, so the form is written on the layout line as usual.
        for (const eol of ['\n', '\r\n']) {
          const before = '# Talk\n\n### Q\n{id=q}\n\n> Words.\n\n{reveal}\n'.replace(/\n/g, eol)
          const after = `${before}${eol}${PAGE}${eol}`
          const model = await compiled(after)
          const written = typed(before, after, model.slides.find((candidate) => candidate.id === 'q').layout)
          assert.deepEqual(written, { outline: after.replace('{id=q}', '{id=q} {form=web}'), set: true, form: 'web' }, 'a Trigger line that is not a form between: the form is written on the layout line')
          const slide = (await compiled(written.outline)).slides.find((candidate) => candidate.id === 'q')
          assert.deepEqual([slide.layout, slide.blocks.find((block) => block.type === 'quote')?.quoteForm?.form, slide.blocks.some((block) => block.type === 'embed')], ['quote', 'web', false], 'and the compiler draws it')
          // `form=auto` among the content would undo a token on the layout line, and another layout there is the slide's: nothing is written.
          for (const line of ['{form=auto}', '{cards}']) {
            const [was, now] = [before.replace('{reveal}', line), after.replace('{reveal}', line)]
            for (const layout of ['quote', 'copy-visual']) assert.deepEqual(typed(was, now, layout), { outline: now, set: false, form: null }, `${line} among the content (compiled ${layout}): no token is written`)
          }
        }
      }
    }
    {
      // Inherited forms that are not web: nothing is written over them; Automatic, on the slide or from the talk, is
      // still Automatic, so the form follows the link.
      const slide = (trigger, line) => `# Talk\n\n### Q\n${trigger}\n\n> Words.\n${line ? `\n${line}\n` : ''}`
      for (const form of ['paper', 'plain', 'book', 'tweet', 'video']) {
        const [before, after] = [`${SETTINGS(form)}${slide('{id=q}', '')}`, `${SETTINGS(form)}${slide('{id=q}', PAGE)}`]
        assert.deepEqual(typed(before, after, 'quote'), { outline: after, set: false, form: null }, `the talk gives form=${form}: a web address typed writes no form=web over it`)
        assert.equal(describeQuoteSource(after, 'q', 'quote').otherContent, false, `the talk gives form=${form}: the address is the source line`)
      }
      assert.equal(typed(`${SETTINGS('auto')}${slide('{id=q}', '')}`, `${SETTINGS('auto')}${slide('{id=q}', PAGE)}`, 'copy-visual').outline, `${SETTINGS('auto')}${slide('{id=q} {form=web}', PAGE)}`, 'the talk gives form=auto: Automatic, the form is written on the slide')
      assert.equal(typed(`${SETTINGS('web')}${slide('{id=q form=auto}', '')}`, `${SETTINGS('web')}${slide('{id=q form=auto}', PAGE)}`, 'copy-visual').outline, `${SETTINGS('web')}${slide('{id=q} {form=web}', PAGE)}`, 'form=auto on the slide wins over the talk: Automatic, and it is replaced')
      const automatic = describeQuoteSource(`${SETTINGS('web')}${slide('{id=q quote form=auto}', PAGE)}`, 'q', 'quote')
      assert.deepEqual([automatic.form, automatic.otherContent], ['plain', true], 'form=auto on the slide wins over the talk: the address is a card, as the compiler draws it')
      // A frontmatter with no `triggers:`, or one that is not closed, gives no form.
      for (const settings of ['---\noutline_version: 2\nform: web\n---\n', '---\ntriggers: "{form=web}"\n']) {
        assert.equal(describeQuoteSource(`${settings}${slide('{id=q quote}', PAGE)}`, 'q', 'quote').otherContent, true, 'no form in effect: the address is other content')
      }
    }
  }
  {
    // Removal, a changed address and an added source line follow the source-line rule (spec 3.1): the token is like one
    // chosen by hand, so nothing clears it and nothing overrides it.
    const removed = formed1.replace(`\n${WEB}\n`, '')
    assert.deepEqual(typed(formed1, removed, 'quote'), { outline: removed, set: false, form: null }, 'the address removed: the form stays')
    const noAddress = await compile([`### Quote\n{id=s form=web}\n\n> Words of the quotation.`])
    assert.equal(noAddress.slide('s').blocks[0].quoteForm?.form, 'web', 'a web page with no address bar, as when a source line loses its link')
    assert.equal(typed(formed1, formed1.replace(WEB, 'https://x.com/sample/status/1234567890123456789'), 'quote').set, false, 'the address changed: the form stays')
    const sourced = formed1.replace(`\n${WEB}\n`, `\n- Jane Example\n\n${WEB}\n`)
    assert.equal(typed(formed1, sourced, 'quote').set, false, 'a source line added: nothing is written')
    const both = await compile([`### Quote\n{id=s form=web}\n\n> Words of the quotation.\n\n- Jane Example\n\n${WEB}`])
    assert(both.slide('s').blocks.some((block) => block.type === 'embed') && !both.slide('s').blocks.some((block) => block.quoteForm), 'a source line and the address: a plain quote and the card beside it, as with no form')
    assert.equal(both.slide('s').blocks[0].cite, 'Jane Example')
    const bothQuote = await compile([`### Quote\n{id=s quote form=web}\n\n> Words of the quotation.\n\n- Jane Example\n\n${WEB}`])
    assert(bothQuote.warnings.includes('quote-form-other-content:s'), 'on a {quote} slide the form says why it is not drawn')
    // Automatic chosen afterwards (the token removed): the slide is as it was before the form, and stays so until the address is edited.
    const automatic = formed1.replace(' form=web', '')
    assert.equal(typed(formed1, automatic, 'quote').set, false)
  }

  // ── E. Fourth review round: speaker notes, the check by compiling, the picture verb ─────────────────────────────────
  console.log(await notesCases(dir))
  console.log(compileCheckCases())
  console.log(await drawnFormCases(dir))
  console.log(await sourceWordsAndIconLinkCases(dir))
  console.log(await pictureVerbCases(dir))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── The cost on a long talk: one typed address among 300 slides ────────────────────────────────────────────────────

{
  const slides = Array.from({ length: 300 }, (_, index) => `### Slide ${index}\n{id=s${index}${index % 3 ? '' : ' quote'}}\n\n> Words of quotation ${index}.\n\n${index % 2 ? `- Author ${index} https://example.org/${index}` : '- one\n- two'}\n`)
  slides[150] = '### Slide 150\n{id=s150}\n\n> Words of quotation 150.\n'
  const before = doc(slides.join('\n'))
  const edited = [...slides]
  edited[150] = `${slides[150]}\n${WEB}\n`
  const after = doc(edited.join('\n'))
  const written = typed(before, after, 'copy-visual')
  assert.equal(written.form, 'web')
  const best = (run) => {
    let least = Infinity
    for (let round = 0; round < 9; round += 1) {
      const started = performance.now()
      run()
      least = Math.min(least, performance.now() - started)
    }
    return least
  }
  // The edit that writes the form reads the talk again after the write, as a link typed on a source line does; every
  // other edit (the address is there and has its form, or cannot take one) reads each text once.
  const setting = best(() => typed(before, after, 'copy-visual'))
  const sourceLine = best(() => typed(before, doc(edited.map((slide, index) => (index === 150 ? `${slides[150]}\n- Author ${WEB}\n` : slide)).join('\n')), 'quote'))
  const after2 = written.outline.replace('Words of quotation 150', 'Other words of quotation 150')
  const typing = best(() => typed(written.outline, after2, 'quote'))
  console.log(`300 slides: the edit that sets the form from an address ${setting.toFixed(1)} ms (from a source line ${sourceLine.toFixed(1)} ms); a later typed edit on that slide ${typing.toFixed(1)} ms`)
  assert(typing < 20, `a typed edit on a 300-slide talk took ${typing.toFixed(1)} ms (single digits expected; ceiling 20 ms for a busy machine)`)
  assert(setting < sourceLine * 2 + 5, `setting the form from an address (${setting.toFixed(1)} ms) costs more than from a source line (${sourceLine.toFixed(1)} ms)`)
}

console.log('quote forms, an address on its own line under a quote: editor rule, no-id slides, compiler, unchanged form-less slides and thumbnails, inherited forms, removal, idempotence and tidy-up pass')
