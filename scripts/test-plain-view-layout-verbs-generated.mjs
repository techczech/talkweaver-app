// Plain view, ticket 11 (second round): the margin's layout label and the layout menu's verbs,
// held to the compiler on generated documents.
//
// For every slide of every generated document:
//   - the margin label is the layout the slide's tokens name by the compiler's own resolution
//     (authored-layout.mjs, the function 08-source-adapters.mjs inferLayout runs), "Auto" when the
//     slide writes none; and where that resolution names a layout, the REAL compiled slide
//     (adaptMarkdownOutlineV2) has it, apart from the counted cases where the compiler overrides
//     an authored layout by structure (a section that is a divider, a slide made only of charts);
//   - the divider fact (`slideLayouts` `divider`, the compiler's own sectionDividerDecision and
//     childFoldKind) is true exactly where the real compiled slide is a divider the author did not
//     ask for, and the margin calls such a heading a Section, never a layout.
// For a seeded sample of slides per document, chooseLayout to a seeded random layout and clearLayout:
//   ok:true  → the rules are checked here, independently of the verb: exactly one (or no)
//              layout-writing token on the slide; the real compiler gives the slide the chosen
//              layout, with NO exception (a heading kept as a divider is refused: asserted zero
//              "ok but the compiler disagrees"); line endings are the document's own (no lone
//              carriage return); every other `{…}` token of the slide's lines is still there; the text
//              outside the slide's lines is the same byte for byte; every other compiled slide is
//              the same; the front matter is the same;
//   ok:false → the text is returned unchanged, with a reason; counted by reason.
//
//   node scripts/test-plain-view-layout-verbs-generated.mjs [--seed=N] [--documents=N]
// Without --seed it runs the seeds 20261012, 21, 22, 23 and 24.
import assert from 'node:assert/strict'
import { chooseLayout, clearLayout } from '../src/shared/layout-verbs.ts'
import { marginLabels } from '../src/shared/plain-view-margin.ts'
import { compilerFacts } from '../src/shared/plain-view-compiler-facts.ts'
import { layoutEntryFor } from '../src/shared/layout-registry/options.ts'
import { drawnLayoutOf, entryTriggerBody, isSettableLayout, layoutDecisionOfEntry } from '../src/shared/slide-authored-layout.ts'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { tokenizeTriggerBody } from '../compiler/scripts/lib/trigger-tokenizer.mjs'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const SEEDS = arg('seed') ? [Number(arg('seed')) >>> 0] : [20261012, 21, 22, 23, 24]
const DOCUMENTS = Number(arg('documents') ?? 400)
const QUIET_TABLE = process.argv.includes('--no-table')
const SAMPLE = 3

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SETTABLE = LAYOUTS.filter(isSettableLayout)
// Every form of a layout the registry declares, plus the explicit layout= form.
const FORMS = [...new Set(SETTABLE.flatMap((entry) => [
  entryTriggerBody(entry), ...entry.aliases.map((a) => a.replace(/^\{|\}$/g, '')), ...entry.triggerWords,
  ...(entry.kind === 'layout' && !entry.resolvesTo ? [`layout=${entry.name}`] : []),
  ...(entry.resolvesTo ? [`${entry.resolvesTo.key}=${entry.resolvesTo.value}`] : [])
]))].filter(Boolean)
const OTHER = ['reveal', 'id=a1', 'id=b_2', 'nostep', 'accent=cobalt', 'icon=lucide:star', 'statement-bg=full', 'cards=stepped', 'cols=3', 'blocks:2x3', 'unknownword', 'note="a, b"']
const WORDS = ['Alpha', 'Beta gamma', 'A longer line of plain words', 'Text with `code`', 'After']
const DECK = ['', '', '', 'triggers: reveal', 'triggers: iconlist', 'triggers: "{numbered} {reveal}"', 'triggers: cols=2', 'triggers: statement=poster', 'triggers: layout=cards']

function generator(seed) {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const group = () => {
    const tokens = Array.from({ length: int(1, 3) }, () => (random() < 0.55 ? pick(FORMS) : pick(OTHER)))
    return `{${tokens.join(pick([' ', ',', ', ']))}}`
  }
  const layoutLine = () => {
    const line = Array.from({ length: int(1, 3) }, group).join(pick(['', '', ' ']))
    const r = random()
    return r < 0.06 ? `${line} <!-- why -->` : r < 0.1 ? `<!-- c --> ${line}` : r < 0.14 ? `  ${line}  ` : line
  }
  const body = () => pick([
    ['- A', '- B', '- C'], ['- A: 1', '- B: 2'], ['A paragraph.'], ['> A quotation'], ['![x](a.png)', '![y](b.png)'], ['- A', '  - sub', '- B', '  - sub'],
    ['```', '{cards}', '```'], ['{chart=bar}', '- A: 1', '- B: 2'], [':::notes', '{cards}', ':::'], []
  ])
  // One kind of content and nothing else, so that every kind meets every chosen layout.
  const plain = () => pick([
    ['A paragraph.'], ['A paragraph.', '', 'Another one.'], ['- A', '- B', '- C'], ['1. A', '2. B'], ['![x](a.png)'], ['![x](a.png)', '![y](b.png)'],
    ['{chart=bar}', '- A: 1', '- B: 2'], ['{chart=pie}', '- A: 1', '- B: 2', '', '{chart=bar}', '- C: 3'],
    ['A paragraph.', '', '- A', '- B'], ['![x](a.png)', '', '- A', '- B'], ['![x](a.png)', '', 'A paragraph.'], ['> A quotation', '', '- A']
  ])
  const slide = (level) => {
    const lines = [`${'#'.repeat(level)} ${pick(WORDS)}${random() < 0.2 ? ` ${group()}` : ''}`]
    if (random() < 0.25) lines.push('')
    for (let k = int(0, 2); k > 0; k -= 1) lines.push(layoutLine())
    if (random() < 0.3) lines.push('')
    if (random() < 0.5) { lines.push(...plain()); return lines }
    lines.push(...body())
    // Several layout lines on one slide: after a blank line, among the body, after the body.
    if (random() < 0.45) { if (random() < 0.5) lines.push(''); lines.push(layoutLine()); lines.push(...body()) }
    if (random() < 0.2) lines.push(layoutLine())
    return lines
  }
  return () => {
    const lines = []
    const deck = pick(DECK)
    if (deck || random() < 0.2) lines.push('---', 'title: Generated', ...(deck ? [deck] : []), '---')
    lines.push('# Talk', '', '## Part one', '')
    for (let k = int(2, 9); k > 0; k -= 1) {
      lines.push(...slide(random() < 0.12 ? 2 : random() < 0.85 ? 3 : 4))
      lines.push(...(random() < 0.8 ? [''] : []))
    }
    // Line endings: LF, CRLF (one document in eight), or mixed line by line; with or without a last line break.
    const r = random()
    const eol = r < 0.125 ? () => '\r\n' : r < 0.17 ? () => (random() < 0.5 ? '\r\n' : '\n') : () => '\n'
    const text = lines.map((line, index) => (index + 1 < lines.length || random() < 0.5 ? line + eol() : line)).join('')
    return { text, random, endings: r < 0.125 ? 'crlf' : r < 0.17 ? 'mixed' : 'lf' }
  }
}

const compile = (text) => adaptMarkdownOutlineV2(text, 'Fallback', {}).slides
/**
 * A compiled slide without the positions that move when a line above it is removed, and without
 * the two fields that quote the outline's own text (a section's `scriptSourceMarkdown` quotes its
 * whole subtree, the edited slide included): the text outside the slide is compared byte for byte.
 */
const POSITIONAL = new Set(['sourceLine', 'sourceLines', 'line', 'startLine', 'endLine', 'sourceMarkdown', 'scriptSourceMarkdown'])
/**
 * The ids the compiler makes up for a slide with no `{id=…}` number repeated titles in slide order
 * (`alpha`, `alpha-2`). When the edited heading has child headings and its layout takes or gives
 * them back, there are fewer or more slides, so those made-up numbers move on later slides. Only
 * in that case (`childHeadings`) are the id fields left out; the app stamps real ids on save.
 */
const MADE_UP_IDS = new Set(['id', 'section', 'subsection'])
const unplaced = (value, childHeadings = false) => Array.isArray(value) ? value.map((v) => unplaced(v, childHeadings))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !POSITIONAL.has(key) && !(childHeadings && MADE_UP_IDS.has(key))).map(([key, v]) => [key, unplaced(v, childHeadings)]))
    : value
/** Every token of every `{…}` group on the given lines, as written. */
const tokensOn = (lines) => lines.flatMap((line) => [...line.matchAll(/\{([^}]*)\}/g)].flatMap((group) => tokenizeTriggerBody(group[1]).map((token) => token.source))).sort()
const frontMatter = (text) => (text.startsWith('---') && text.indexOf('\n---', 3) >= 0 ? text.slice(0, text.indexOf('\n---', 3) + 4) : '')

const isListStyle = (entry) => entry.resolvesTo?.key === 'liststyle'
/** The style the REAL compiled slide draws its lists in ('' when it draws none in a style). */
const compiledListStyle = (row) => (row.blocks ?? []).find((block) => block?.type === 'feature-list')?.liststyle ?? ''
/** Whether the REAL compiled slide is drawn in the entry's layout: for a list style, a list in that style. */
const compiledAs = (row, entry) => (isListStyle(entry)
  ? row.layout === 'list' && (row.blocks ?? []).some((block) => block?.type === 'feature-list' && block.liststyle === String(entry.resolvesTo.value))
  : row.layout === layoutDecisionOfEntry(entry)?.layout)
/** The kind of content a slide holds, from its written lines (layout lines and blank lines apart). */
const KINDS = ['paragraph only', 'list', 'image only', 'chart only', 'mixed']
function contentKind(written, facts, slide) {
  const lines = []
  for (let k = slide.headingLine + 1; k < slide.endLine; k += 1) {
    const line = (written[k] ?? '').replace(/\r$/, '').trim()
    if (line && !facts.layoutLines.has(k)) lines.push(line)
  }
  if (!lines.length) return 'empty'
  const every = (test) => lines.every((line) => test.test(line))
  if (/^\{chart=\w+\}$/.test(lines[0]) && lines.every((line) => /^\{chart=\w+\}$|^- \w: \d$/.test(line))) return 'chart only'
  if (every(/^(?:[-*]|\d+\.) /)) return 'list'
  if (every(/^!\[/)) return 'image only'
  if (every(/^[A-Za-z]/)) return 'paragraph only'
  return 'mixed'
}
/** For each settable layout, the kinds of content it was chosen on, across the seeds. */
const chosenOn = new Map(SETTABLE.map((entry) => [entry.name, new Map()]))
// Cycle separately for each content kind: a global cursor can miss a layout/kind pair
// even across all default seeds. Keep the complete matrix assertion below.
const cursors = new Map()
const total = {}
const table = []
for (const SEED of SEEDS) {
  const next = generator(SEED)
  const started = Date.now()
  const counts = { okOnCrlf: 0, okOnMixed: 0, refusedOn: { lf: {}, crlf: {}, mixed: {} }, crlfDocuments: 0, mixedDocuments: 0, dividers: 0, okButCompilerDisagrees: 0, finalAgree: 0, noSlide: 0, drawnOtherThanWritten: {}, labelled: 0, slides: 0, authored: 0, auto: 0, compiledAgree: 0, structural: {}, explicitForm: 0, severalLayoutLines: 0, chosen: 0, chooseUnchanged: 0, withChildHeadings: 0, clearedToDeckDefault: 0, cleared: 0, clearUnchanged: 0, refused: {} }
  const refuse = (verb, reason) => { counts.refused[`${verb}: ${reason}`] = (counts.refused[`${verb}: ${reason}`] ?? 0) + 1 }
  for (let n = 0; n < DOCUMENTS; n += 1) {
    const { text, random, endings } = next()
    if (endings === 'crlf') counts.crlfDocuments += 1
    if (endings === 'mixed') counts.mixedDocuments += 1
    const fail = (message) => { console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED})\n${message}\n\n${text.split('\n').map((line, i) => `${String(i + 1).padStart(3)} ${JSON.stringify(line)}`).join('\n')}`); process.exit(1) }
    try {
      const facts = compilerFacts(text)
      const compiled = compile(text)
      const bySource = new Map(compiled.filter((slide) => typeof slide.sourceLine === 'number').map((slide) => [slide.sourceLine, slide]))
      const labels = new Map(marginLabels(compiled, text).map((label) => [label.line, label]))
      const uncompiledLabels = new Map(marginLabels(null, text).map((label) => [label.line, label]))
      const headings = [...facts.slideLayouts.keys()]
      for (const h of headings) {
        const slide = facts.slideLayouts.get(h)
        counts.slides += 1
        assert.ok(slide.consistent, `line ${h + 1}: the slide's tokens fold to the attrs the compiler has`)
        const named = drawnLayoutOf(slide)
        const row = bySource.get(h + 1)
        const label = labels.get(h + 1)
        const writing = slide.tokens.filter((token) => token.writesLayout)
        if (writing.some((token) => /^layout=/.test(token.source))) counts.explicitForm += 1
        if (new Set(writing.map((token) => token.line)).size > 1) counts.severalLayoutLines += 1
        // THE TRUTH IS THE REAL COMPILER. The layout the editor's facts say the slide is drawn in is
        // the compiled slide's layout, on every slide, whatever it writes; a heading with no compiled
        // slide of its own (taken into the layout above it) has none.
        assert.equal(slide.final === null, row === undefined, `line ${h + 1}: ${row ? `compiled as ${row.layout}` : 'no compiled slide'}, the facts say ${slide.final ? slide.final.layout : 'no slide'}`)
        if (row) {
          assert.equal(slide.final.layout, row.layout, `line ${h + 1}: the compiled slide is ${row.layout}, the facts say ${slide.final.layout}`)
          if (row.layout === 'list') assert.equal(slide.final.hasList ? slide.final.listStyle : '', compiledListStyle(row), `line ${h + 1}: the style the compiled slide draws its list in`)
          counts.finalAgree += 1
        } else counts.noSlide += 1
        // The label: "Auto" exactly when the slide writes no layout (or is no slide of its own);
        // otherwise the name of the layout the REAL compiler drew, with no skip.
        if (label?.kind === 'slide') {
          assert.equal(label.layoutLabel, named ? named.entry?.label ?? named.name : 'Auto', `line ${h + 1}: margin label`)
          assert.equal(uncompiledLabels.get(h + 1)?.layoutLabel, label.layoutLabel, `line ${h + 1}: the same label before the talk is compiled`)
          assert.equal(label.layoutLabel === 'Auto', writing.length === 0 || !row, `line ${h + 1}: Auto exactly when no layout is written`)
          if (writing.length && row) {
            counts.labelled += 1
            if (named.entry) assert.ok(compiledAs(row, named.entry) || layoutEntryFor(row.layout) === named.entry, `line ${h + 1}: the margin says ${label.layoutLabel}, the compiled slide is ${row.layout} (list style ${JSON.stringify(compiledListStyle(row))})`)
            else assert.equal(named.name, row.layout, `line ${h + 1}: the margin names ${named.name}, the compiled slide is ${row.layout}`)
            // A list drawn in a style the slide writes itself is named by the style, never by the plain word.
            if (row.layout === 'list' && compiledListStyle(row) && slide.listStyle === compiledListStyle(row)) assert.ok(isListStyle(named.entry), `line ${h + 1}: a list drawn with ${compiledListStyle(row)} is named ${label.layoutLabel}`)
          }
        }
        if (writing.length) counts.authored += 1; else counts.auto += 1
        // The divider fact against the real compiler: true exactly where the compiled slide is a
        // divider that no token of the slide asked for by name; and the margin never names a layout there.
        if (row) assert.equal(slide.divider, row.layout === 'section-title' && slide.decision?.layout !== 'section-title', `line ${h + 1}: divider fact ${slide.divider}, the compiled slide is ${row.layout}`)
        if (slide.divider) {
          counts.dividers += 1
          assert.equal(label?.kind, 'section', `line ${h + 1}: a divider heading is a Section in the margin`)
          assert.equal(label?.layoutLabel, undefined, `line ${h + 1}: a divider heading is given no layout name`)
          assert.equal(uncompiledLabels.get(h + 1)?.kind, 'section', `line ${h + 1}: a divider heading is a Section before it is compiled too`)
        }
        // How often the slide is drawn in another layout than its tokens name (the margin names the drawn one).
        if (row && slide.decision && writing.length) {
          if (row.layout === slide.decision.layout) counts.compiledAgree += 1
          else { const key = `${slide.decision.layout} drawn as ${row.layout}`; counts.drawnOtherThanWritten[key] = (counts.drawnOtherThanWritten[key] ?? 0) + 1 }
        }
      }
      // A sample of slides: choose a seeded random layout, and back to Auto.
      const sample = [...headings].sort(() => random() - 0.5).slice(0, SAMPLE)
      for (const h of sample) {
        const was = facts.slideLayouts.get(h)
        const written = text.split('\n')
        // Every settable layout in turn, so each one meets every kind of content.
        const kind = contentKind(written, facts, was)
        const cursor = cursors.get(kind) ?? 0
        cursors.set(kind, cursor + 1)
        for (const entry of [SETTABLE[cursor % SETTABLE.length], null]) {
          const verb = entry ? 'choose' : 'clear'
          if (entry) { const seen = chosenOn.get(entry.name); const cell = seen.get(kind) ?? { ok: 0, refused: 0 }; seen.set(kind, cell); cell.pending = true }
          const w = entry ? chooseLayout(text, { headingLine: h + 1 }, entry.name) : clearLayout(text, { headingLine: h + 1 })
          if (entry) { const cell = chosenOn.get(entry.name).get(kind); cell[w.ok ? 'ok' : 'refused'] += 1; delete cell.pending }
          if (!w.ok) {
            assert.equal(w.text, text, `${verb} line ${h + 1}: refused, the text is unchanged`)
            assert.ok(w.reason && w.detail, `${verb} line ${h + 1}: a reason`)
            // Why a place refusal: the layout stands on a line partly inside a comment (the verb says so), or the check after the edit failed.
            const inComment = was.tokens.some((token) => token.writesLayout && !token.readWhole)
            refuse(verb, w.reason === 'cannot-place-here' ? (inComment ? 'cannot-place-here (layout on a line partly in a comment)' : 'cannot-place-here (the edit did not verify)') : w.reason)
            counts.refusedOn[endings][w.reason] = (counts.refusedOn[endings][w.reason] ?? 0) + 1
            continue
          }
          if (w.text === text) counts[entry ? 'chooseUnchanged' : 'clearUnchanged'] += 1
          if (entry) counts.chosen += 1; else counts.cleared += 1
          if (w.text !== text && endings === 'crlf') counts.okOnCrlf += 1
          if (w.text !== text && endings === 'mixed') counts.okOnMixed += 1
          const after = w.text.split('\n')
          // Line endings: no carriage return without its line feed, anywhere the document had none.
          assert.equal(/\r(?!\n)/.test(w.text), /\r(?!\n)/.test(text), `${verb} line ${h + 1}: a lone carriage return was written`)
          if (endings === 'crlf') assert.equal(/(^|[^\r])\n/.test(w.text), false, `${verb} line ${h + 1}: a bare line feed in a CRLF document`)
          const nowFacts = compilerFacts(w.text)
          const now = nowFacts.slideLayouts.get(h)
          assert.ok(now, `${verb} line ${h + 1}: the slide is still there`)
          // Exactly one layout-writing token (none for Auto).
          const writing = now.tokens.filter((token) => token.writesLayout)
          assert.equal(writing.length, entry ? 1 : 0, `${verb} line ${h + 1}: layout-writing tokens after: ${JSON.stringify(writing.map((t) => t.source))}`)
          // Outside the slide's own lines the text is the same byte for byte; so is the front matter.
          assert.equal(after.slice(0, h).join('\n'), written.slice(0, h).join('\n'), `${verb} line ${h + 1}: the text above the slide`)
          assert.equal(after.slice(now.endLine).join('\n'), written.slice(was.endLine).join('\n'), `${verb} line ${h + 1}: the text below the slide`)
          assert.equal(frontMatter(w.text), frontMatter(text), `${verb} line ${h + 1}: the front matter`)
          // Every other token of the slide's lines is still there, as written; the only one added is the chosen layout's.
          const gone = was.tokens.filter((token) => token.writesLayout).map((token) => token.source)
          const before = tokensOn(written.slice(h, was.endLine))
          const left = tokensOn(after.slice(h, now.endLine))
          const expected = [...before]
          for (const source of gone) expected.splice(expected.indexOf(source), 1)
          if (entry) expected.push(...writing.map((token) => token.source))
          assert.deepEqual(left, expected.sort(), `${verb} line ${h + 1}: the slide's other tokens`)
          // The real compiler: the slide has the chosen layout; every other slide is the same.
          const recompiled = compile(w.text)
          const compiledBefore = compile(text)
          // Slides under the edited heading (its child headings) are the one exception: a layout that
          // takes its children (Compare, Columns, a carousel …) folds them into the slide, and leaving
          // it gives them back. That is the layout's meaning in the compiler, not a side effect of the write.
          let subtreeEnd = was.endLine
          for (const other of headings) { if (other > h) { if (facts.slideLayouts.get(other).level <= was.level) break; subtreeEnd = facts.slideLayouts.get(other).endLine } }
          const shift = after.length - written.length
          // The other direction: a heading above it whose layout takes ITS children ({title}, Compare …)
          // draws the edited slide inside its own compiled slide, so that one shows the change too.
          const ancestors = new Set()
          for (let k = headings.indexOf(h) - 1, level = was.level; k >= 0 && level > 2; k -= 1) {
            const above = facts.slideLayouts.get(headings[k])
            if (above.level < level) { ancestors.add(headings[k] + 1); level = above.level }
          }
          const apart = (slide, end) => typeof slide.sourceLine !== 'number' || (!ancestors.has(slide.sourceLine) && (slide.sourceLine < h + 1 || slide.sourceLine > end))
          const outsideBefore = compiledBefore.filter((slide) => apart(slide, subtreeEnd))
          const outsideAfter = recompiled.filter((slide) => apart(slide, subtreeEnd + shift))
          assert.equal(outsideAfter.length, outsideBefore.length, `${verb} line ${h + 1}: as many compiled slides outside the slide, its child headings and the headings it stands under`)
          outsideAfter.forEach((slide, index) => {
            assert.equal(JSON.stringify(unplaced(slide, subtreeEnd > was.endLine)), JSON.stringify(unplaced(outsideBefore[index], subtreeEnd > was.endLine)), `${verb} line ${h + 1}: compiled slide "${slide.title}" (outside the edited slide) changed`)
          })
          if (subtreeEnd > was.endLine) counts.withChildHeadings += 1
          const mine = recompiled.find((slide) => slide.sourceLine === h + 1)
          if (entry) {
            // ok means the REAL compiler draws the slide in the chosen layout: every ok choice is
            // checked against the compiled slide, a list style included (a list, in that style).
            assert.ok(mine, `choose line ${h + 1}: ok, and there is no compiled slide`)
            if (!compiledAs(mine, entry)) {
              counts.okButCompilerDisagrees += 1
              assert.fail(`choose line ${h + 1}: ok, but the compiled slide is ${mine.layout} (list style ${JSON.stringify(compiledListStyle(mine))}), chosen ${entry.name}`)
            }
            assert.equal(drawnLayoutOf(now)?.entry, entry, `choose line ${h + 1}: the slide's layout is ${entry.name}`)
            assert.equal(now.divider, false, `choose line ${h + 1}: ok on a heading the compiler keeps as a divider`)
          } else {
            assert.equal(now.authored, false, `clear line ${h + 1}: nothing authored`)
            // What is left decides: the content, or a talk-wide `triggers:` default in the front matter (never touched).
            if (now.decision) counts.clearedToDeckDefault += 1
            else if (mine) assert.equal(mine.explicitLayout ?? false, false, `clear line ${h + 1}: the compiled slide has no explicit layout`)
          }
        }
      }
    } catch (error) {
      fail(error.stack ?? error.message)
    }
  }
  assert.ok(counts.authored > DOCUMENTS && counts.explicitForm > DOCUMENTS / 4 && counts.severalLayoutLines > DOCUMENTS / 4 && counts.chosen > DOCUMENTS / 2 && counts.cleared > DOCUMENTS / 2,
    `the generator reaches written layouts, the explicit form and several layout lines: ${JSON.stringify(counts)}`)
  assert.equal(counts.finalAgree + counts.noSlide, counts.slides, 'every slide was checked against the real compiler')
  console.log(`seed ${SEED}: ${DOCUMENTS} documents, ${counts.slides} slides (${counts.authored} with a written layout, ${counts.auto} Auto; ${counts.explicitForm} use layout=…, ${counts.severalLayoutLines} write layouts on several lines)`)
  console.log(`  the layout the facts give = the real compiled layout on ${counts.finalAgree} of ${counts.slides - counts.noSlide} slides (${counts.noSlide} headings are no slide of their own); margin label checked against the compiled slide on ${counts.labelled} slides that write a layout`)
  console.log(`  drawn in another layout than the tokens name: ${JSON.stringify(counts.drawnOtherThanWritten)}`)
  console.log(`  chooseLayout: ${counts.chosen} verified (${counts.chooseUnchanged} already that layout; ok but the compiler disagrees: ${counts.okButCompilerDisagrees}); clearLayout: ${counts.cleared} verified (${counts.clearUnchanged} had nothing to clear, ${counts.clearedToDeckDefault} left to a talk-wide default)`)
  console.log(`  of those writes, ${counts.withChildHeadings} were on a heading with child headings (their compiled slides may fold into the layout)`)
  console.log(`  ok:false, text unchanged: ${JSON.stringify(counts.refused)}`)
  console.log(`  ${counts.dividers} headings kept as dividers (a Section in the margin, no layout name); ${counts.crlfDocuments} CRLF documents (${counts.okOnCrlf} writes made), ${counts.mixedDocuments} with mixed line endings (${counts.okOnMixed} writes made); ${((Date.now() - started) / 1000).toFixed(1)} s`)
  assert.equal(counts.okButCompilerDisagrees, 0, 'no ok write the compiler disagrees with')
  assert.ok(counts.dividers > 0 && counts.okOnCrlf > 20 && counts.okOnMixed > 5 && (counts.refused['choose: layout-not-applied'] ?? 0) > 0, `the generator reaches dividers, CRLF and mixed endings, and a refused divider choice: ${JSON.stringify(counts)}`)
  table.push({ seed: SEED, slides: counts.slides, 'final = compiled': counts.finalAgree, 'labels checked': counts.labelled, 'ok but compiler disagrees': counts.okButCompilerDisagrees, 'chosen ok': counts.chosen, 'cleared ok': counts.cleared, ...counts.refused, seconds: ((Date.now() - started) / 1000).toFixed(1) })
  for (const [key, value] of Object.entries(counts.refused)) total[key] = (total[key] ?? 0) + value
}
if (!QUIET_TABLE) console.table(table)
// Every settable layout was chosen on every kind of content (with the default seeds and size).
const missing = []
for (const [name, seen] of chosenOn) for (const kind of KINDS) if (!seen.has(kind)) missing.push(`${name} on ${kind}`)
const cells = [...chosenOn.values()].flatMap((seen) => KINDS.map((kind) => seen.get(kind)).filter(Boolean))
console.log(`each of ${SETTABLE.length} layouts chosen on each of ${KINDS.length} kinds of content: ${SETTABLE.length * KINDS.length - missing.length} of ${SETTABLE.length * KINDS.length} pairs (${cells.reduce((n, c) => n + c.ok, 0)} ok, ${cells.reduce((n, c) => n + c.refused, 0)} refused)`)
if (SEEDS.length >= 5 && DOCUMENTS >= 400) assert.deepEqual(missing, [], 'a layout never met a kind of content')
console.log(`ok (ok:false across seeds: ${JSON.stringify(total)})`)
