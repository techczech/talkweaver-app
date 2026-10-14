// Plain view, ticket 07 (eleventh round): the plain view and the compiler read GENERATED documents
// the same way. Hand-picked cases found one more document shape per review; this test draws
// thousands of documents from a library of line snippets that covers every block kind the
// compiler's lexer knows, in random order, with and without blank lines between them.
//
// For each document:
//   the compiler's truth   outlineCompilerBody + blankHtmlComments, parseOutlineTree,
//                          classifyContentLines and the compiler's own lexer entry
//                          (03-markdown-lexer.mjs, bound to the real icon vocabulary);
//   the plain view's       the shared pure helpers the editor runs (plainViewFacts,
//                          hiddenLayoutLines, headingTail), with the editor's key normaliser.
//
// THE INVARIANT, asserted on every document (default on, no flag turns it off):
//   The plain view hides or protects a span only if the compiler consumes exactly that span (does
//   not print it as slide text).
// The reverse is allowed and only counted: where the compiler consumes something and the plain view
// shows it as ordinary text ("fail open"). For LAYOUT LINES the reverse is asserted too (ticket 11):
// every line the compiler removes and reads whole is hidden; the one class left shown is counted
// by name (a line partly inside an HTML comment).
//
// What is compared for it, per kind of hidden span:
//   layout lines   BOTH WAYS. Every line Plain hides (hiddenLayoutLines: the rule hiddenLines.ts,
//                  placeholders.ts, the margin and the layout verbs read) is a line the compiler
//                  takes out of the content (parseOutlineTree's triggerLineIndexes,
//                  classifyContentLines' stray lines), read whole. And every line the compiler takes
//                  out and reads whole is hidden by Plain, wherever in its slide it stands.
//   heading tails  the groups Plain hides are exactly the groups the compiler takes off the title
//                  (headingBraceGroups), and the text Plain leaves visible is exactly the title the
//                  outline tree made of the line (node.title; the talk's: meta.title).
//   icon tokens    every item (the span iconPictures.ts hides and protects: [textEnd, to)) has the
//                  compiler's token on the same line, same kind, same key, drawn or not, and is the
//                  end of its line; THE SPAN IS PINNED to the offsets the compiler's own token
//                  readers give (paragraphIconTokenAt, listItemIconTokenAt, with the real icon
//                  vocabulary): the item's `{` is the compiler's, the span ends at the line's end,
//                  and it starts at the ONE whitespace character before `{` when the compiler
//                  consumed whitespace there, at `{` when it consumed none: never earlier (visible
//                  text would be protected), never later (the separating space would be left to a
//                  single key); a list item's text starts where the compiler's mark ends; and the
//                  lexer gives the same text for the slide with every such
//                  span cut out as with it (the span is all the lexer consumed, and no more).
//   compiled talk  adaptMarkdownOutlineV2 (the compiler's whole pipeline): no hidden `{…}` group is
//                  in the title, the kicker or the blocks of its compiled slide, unless the same
//                  group is also written in the document where Plain shows it. (The document, not
//                  the slide: a compiled slide's blocks hold text from other slides' lines too, and
//                  a fence straight under a paragraph is text for the lexer. Those are counted.)
// The protected regions (protectedRegion.ts) are built in hiddenLines.ts and iconPictures.ts, which
// need CodeMirror; they are made of exactly the three things read here (headingTail's textEnd to
// the line's end, the hiddenLayoutLines run, an item's textEnd to its `to`).
//
// Also asserted equal: each heading's title icon; no plain-view fact on a line outside the outline.
//
// Differences that are counted and printed, never silent. Each runs ONE way, the compiler consumes
// and the plain view shows text, and that is asserted where it is counted (nothing of Plain's is
// hidden on the line); --examples=N prints the first N of each:
//   comment      a comment removed characters from the line, so the token (or a heading's tail)
//                cannot be located: the plain view shows text (the one class the ticket permits);
//   split        an icon token broken over two lines of a paragraph: the same fail-open rule;
//   vocabulary   a BARE unprefixed `{name}` on a list item that the compiler finds in its icon
//                sets: the editor has no vocabulary (plain-view-compiler-facts.ts editorIconKey);
//   layout       a Trigger line the compiler removes that is partly inside an HTML comment (the
//                compiler reads fewer characters than are written): Plain shows it. No other
//                removed line is shown: asserted.
//
//   node scripts/test-plain-view-compiler-parity-generated.mjs [--seed=N] [--documents=N] [--examples=N]
import assert from 'node:assert/strict'
import { blankHtmlComments } from '../compiler/scripts/lib/html-comments.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { listItemIconTokenAt, paragraphIconTokenAt } from '../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { classifyContentLines, parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { headingBraceGroups, parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { normalizeIconOverrideKey } from '../compiler/scripts/lib/05-icons.mjs'
import { outlineCompilerBody } from '../src/shared/slide-source-text.ts'
import { plainViewFacts } from '../src/shared/plain-view-icon-items.ts'
import { headingLine } from '../src/shared/plain-view-heading-line.ts'
import { headingTail } from '../src/shared/plain-view-heading-tail.ts'
import { hiddenLayoutLines } from '../src/shared/plain-view-margin.ts'
import { isHeadingTailLine } from '../src/shared/plain-view-outline-lines.ts'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const SEED = Number(arg('seed') ?? 20261012) >>> 0
const DOCUMENTS = Number(arg('documents') ?? 3000)
const EXAMPLES = Number(arg('examples') ?? 0)

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
const random = mulberry32(SEED)
const pick = (list) => list[Math.floor(random() * list.length)]
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))

// ── The snippet library ─────────────────────────────────────────────────────────────────────────
const ICONS = ['{icon=lucide:star}', '{icon=star}', '{icon=lucide:no-such-name}', '{icon=zzzq}', '{ icon = lucide:route }', '{icon=svgl:github}', '{icon=tabler:mood-confused}']
const BARE = ['{lucide:star}', '{svgl:github}', '{lucide:no-such-name}', '{star}', '{brain}', '{a, b}', '{zzzq}']
const TAILS = ['', '', ' {id=s1}', ' {reveal}', ' {iconlist}', ' {icon=lucide:route}', ' {icon=lucide:route title-icon=above}', ' {reveal}{id=ab_1}',
  ' {id=x9} {icon=star}', ' {icon=lucide:a} {cards} {icon=lucide:star}', '{reveal}', ' \\{reveal}', ' https://example.org/{icon=lucide:bike}',
  ' {note="icon=lucide:x"}', ' {icon=}', ' {reveal} ', ' {reveal} <!-- why -->', ' <!-- c --> more {reveal}', ' {rev<!-- x -->eal}', ' {icon=lucide:star} <!-- c -->']
const TRIGGERS = ['{reveal}', '{iconlist}', '{id=abc_12}', '{cards} {reveal}', '{layout=compare}{reveal}', '{icon=lucide:star}', '{poll}', '{prework}',
  '{reveal} <!-- reveal items -->', '<!-- c --> {reveal}', '{rev<!-- c -->eal}', '{reveal} <!-- open', '{chart=bar}', '  {reveal}  ', '{id=q1} {id=q2}']
const WORDS = ['Alpha', 'Beta gamma', 'A longer line of plain words', 'Text with `code` and *marks*', 'Ends in braces {a, b}', 'See https://example.org/x', 'After', '+ plus mark', '1) not. a list']
const fenceMark = () => pick(['`', '~']).repeat(int(3, 5))
const withIcon = (text) => (random() < 0.5 ? `${text} ${pick(ICONS)}` : text)
const comment = () => pick(['<!-- note -->', '<!-- ## Not a heading -->', '<!-- {icon=lucide:star} -->'])

const SNIPPETS = {
  heading: () => [`${'#'.repeat(int(2, 6))} ${pick(WORDS)}${pick(TAILS)}`],
  headingAndTrigger: () => [`${'#'.repeat(int(2, 4))} ${pick(WORDS)}${pick(TAILS)}`, ...Array.from({ length: int(1, 3) }, () => pick(TRIGGERS))],
  headingBlankTrigger: () => [`### ${pick(WORDS)}`, '', pick(TRIGGERS)],
  emptyHeading: () => [pick(['## ', '###', '###  ', '####### Seven', ' ## Indented'])],
  trigger: () => [pick(TRIGGERS)],
  paragraph: () => [withIcon(pick(WORDS))],
  paragraphLines: () => { const n = int(2, 3); return Array.from({ length: n }, (_, k) => (k === n - 1 ? withIcon(pick(WORDS)) : pick([pick(WORDS), withIcon(pick(WORDS))]))) },
  paragraphSplitToken: () => [`${pick(WORDS)} {icon=`, 'star}'],
  paragraphComment: () => [pick([`${pick(WORDS)} <!-- c --> ${pick(ICONS)}`, `${pick(WORDS)} ${pick(ICONS)} <!-- c -->`, `${pick(WORDS)} {icon=lu<!-- c -->cide:star}`, `<!-- c -->${pick(WORDS)} ${pick(ICONS)}`])],
  paragraphGlued: () => [pick([`${pick(WORDS)}{icon=lucide:star}`, `${pick(WORDS)} \\{icon=lucide:star}`, `[link](https://example.org/{icon=x})`, `${pick(WORDS)} {lucide:star}`, `${pick(WORDS)} {icon=lucide:star} tail`])],
  list: () => Array.from({ length: int(1, 4) }, () => `${pick(['-', '*', '-'])} ${random() < 0.5 ? `${pick(WORDS)} ${pick([...ICONS, ...BARE])}` : pick(WORDS)}`),
  numbered: () => Array.from({ length: int(1, 3) }, (_, k) => `${k + 1}${pick(['.', ')'])} ${withIcon(pick(WORDS))}`),
  nested: () => [`- ${withIcon(pick(WORDS))}`, `  - ${pick(WORDS)} ${pick([...ICONS, ...BARE])}`, `\t- ${withIcon(pick(WORDS))}`, `    * ${withIcon(pick(WORDS))}`, `- ${withIcon(pick(WORDS))}`],
  listOnlyToken: () => [`- ${pick([...ICONS, ...BARE])}`, `-  ${pick(WORDS)}  ${pick(ICONS)}  `],
  listComment: () => [`- ${pick(WORDS)} ${pick(ICONS)} <!-- c -->`, `- <!-- c --> ${pick(WORDS)} ${pick(ICONS)}`],
  plusList: () => [`+ ${withIcon(pick(WORDS))}`],
  qr: () => [pick(['[QR: https://example.org]', '[QR: https://example.org | Scan me]', '[QR:]'])],
  embed: () => [pick(['[Embed: https://example.org/page]', '[Simulation: assets/sim.html]', '[Embed: assets/x.html] {icon=lucide:star}'])],
  video: () => [pick(['[Video: assets/clip.mp4]', '[Video: https://youtu.be/abc123] {play-on-next}', '[Video: assets/clip.mp4] {play-on-next}'])],
  action: () => [pick(['[Action: Open → https://example.org]', '[Action: Open](https://example.org)', '[Action: Go -> https://example.org]'])],
  image: () => [pick(['![Alt](assets/a.png)', '![Alt](assets/a.png "Caption")', '![Clip](assets/c.mp4){autoplay}{loop}', '![Sound](assets/s.mp3){autoplay}', '![Alt](assets/a.png) {icon=lucide:star}', '![Alt](assets/a.png){play-on-next}'])],
  bareUrl: () => [pick(['https://example.org/page', 'https://youtu.be/abc123', 'https://example.org/page {icon=lucide:star}'])],
  quote: () => [`> ${pick(WORDS)}`, ...(random() < 0.5 ? ['>', `> ${pick(WORDS)}`] : []), ...(random() < 0.4 ? ['> — Jane Doe'] : [])],
  quoteAttribution: () => [`> ${pick(WORDS)}`, pick(['— Jane Doe', '– Jane Doe, *Book*', '-- Jane Doe', '— Jane Doe {icon=lucide:star}'])],
  quotePractice: () => ['> **Try it.** Press <kbd>⌘K</kbd> now', '— Not a cite'],
  quotedParagraph: () => [pick(['"A wholly quoted statement."', '“Curly quoted statement.”', '"Quoted." {icon=lucide:star}']), ...(random() < 0.6 ? ['— Jane Doe'] : [])],
  claim: () => [pick(['**A wholly bold claim.**', '**Bold claim** {icon=lucide:star}', '**Partly** bold {icon=lucide:star}'])],
  table: () => ['| A | B |', '|---|---|', `| 1 | ${pick(WORDS)} |`, ...(random() < 0.5 ? ['| 2 | x {icon=lucide:star} |'] : [])],
  tableLoose: () => [`| ${pick(WORDS)} | not a table |`],
  timeline: () => ['**Timeline:**', ...(random() < 0.5 ? [''] : []), `- 2020: ${pick(WORDS)}`, `- 2021: ${withIcon(pick(WORDS))}`],
  chartToken: () => [pick(['{chart=bar}', '{chart=pie}']), `- ${pick(WORDS)}: 3`, `- Second: 5 ${pick(ICONS)}`],
  chartFence: () => ['```chart bar', '- A: 1', '- B: 2 {icon=lucide:star}', '```'],
  fence: () => { const m = fenceMark(); return [`${m}${pick(['', 'js', ' text', 'trace'])}`, pick(['code {icon=lucide:star}', '## Not a heading', '{reveal}', '- item {icon=lucide:star}', ':::notes', '<!-- c -->']), pick(WORDS), ...(random() < 0.75 ? [m] : [])] },
  fenceShortClose: () => ['````', 'inside', '```', `still ${pick(ICONS)}`, '````'],
  fenceIndented: () => ['  ```', `x ${pick(ICONS)}`, '  ```'],
  notes: () => [pick([':::notes', ':::Notes', '  :::notes']), pick([`Said aloud ${pick(ICONS)}`, '{reveal}', `- note item ${pick(ICONS)}`, '# Title in notes']), ...(random() < 0.8 ? [':::'] : [])],
  strayNotesEnd: () => [':::'],
  commentLine: () => [comment()],
  commentBlock: () => ['<!--', `${pick(WORDS)} ${pick(ICONS)}`, '## Not a heading', '-->'],
  commentUnclosed: () => [`<!-- never closed ${pick(WORDS)}`],
  rule: () => ['---'],
  blank: () => ['']
}
const KINDS = Object.keys(SNIPPETS)

function generate() {
  const lines = []
  if (random() < 0.3) lines.push('---', 'title: Generated', ...(random() < 0.5 ? ['triggers: "{reveal}"'] : []), '---')
  lines.push(`# Talk title${pick(['', '', ' {icon=lucide:star}', ' {reveal}', ' {icon=lucide:route title-icon=above}'])}`)
  if (random() < 0.5) lines.push('')
  if (random() < 0.85) lines.push(...SNIPPETS.heading())
  const count = int(3, 25)
  for (let k = 0; k < count; k += 1) {
    // Headings often enough that most content lies in a slide.
    const kind = random() < 0.14 ? pick(['heading', 'headingAndTrigger']) : pick(KINDS)
    lines.push(...SNIPPETS[kind]())
    if (random() < 0.5) lines.push('')
  }
  return lines.join('\n')
}

// ── The compiler's truth ────────────────────────────────────────────────────────────────────────
function compilerTruth(text) {
  const written = text.split('\n')
  const { body, fmEnd, newlines } = outlineCompilerBody(text, blankHtmlComments)
  const bodyLines = body.split('\n')
  const tree = parseOutlineTree(body)
  const removed = new Set(tree.triggerLineIndexes)
  const tokens = new Map()
  const outside = new Set(tree.notesLineIndexes)
  for (let i = 0; i < (fmEnd > 0 ? newlines + 1 : 0); i += 1) outside.add(i)
  written.forEach((line, i) => { if (line.trim() !== '' && bodyLines[i].trim() === '') outside.add(i) })
  const headings = new Map()
  const slides = []
  const groupsOf = (i, rest) => headingBraceGroups(rest).map((g) => [g.start + bodyLines[i].length - rest.length, g.end + bodyLines[i].length - rest.length])
  bodyLines.forEach((line, i) => {
    // The talk's title is the LAST `#` line the tree reads (also one inside speaker notes: the
    // tree tests for it before it tests for notes), and the title icon is that line's.
    const m = !line.startsWith('##') && line.match(/^#\s+(.+)/)
    if (m && parseHeadingAttrs(m[1]).title === tree.meta.title) headings.set('title', { line: i, groups: groupsOf(i, m[1]), icon: tree.deckTitleIcon?.icon ?? null, title: tree.meta.title })
  })
  // The lines before the first slide: the compiler makes no slide of them. They are read here as a
  // slide's content would be (the plain view shows their icon tokens as it will once a heading
  // stands above them); they are never Trigger lines the compiler removes.
  const walk = (node, self = false) => {
    for (const child of self ? [node] : node.children) {
      if (!self) {
        const i = child.sourceLine - 1
        const m = bodyLines[i].match(/^(#{2,6})\s+(.+)/)
        assert.ok(m, `the tree's heading is on line ${i + 1}`)
        headings.set(i, { line: i, groups: groupsOf(i, m[2]), icon: child.titleIcon ?? null, title: child.title })
      }
      const indexes = tree.contentLineIndexes.get(child) ?? []
      const lexed = []
      const source = []
      for (const entry of classifyContentLines(child.contentLines)) {
        if (entry.stray) { if (!self) removed.add(indexes[entry.index]) }
        else { lexed.push(entry.line); source.push(indexes[entry.index]) }
      }
      const take = (block) => {
        const [first, last] = block.sourceLines
        // The lexer's own positions, held to the lexer: the block's lines alone lex to the same block.
        assert.equal(JSON.stringify(lexMarkdownBlocks(lexed.slice(first, last + 1))), JSON.stringify([block]), `source lines ${first}-${last} of a ${block.type} block`)
        if (block.type === 'code' || (block.type === 'object-chart' && block.storage === 'fence')) { for (let k = first; k <= last; k += 1) outside.add(source[k]); return }
        if (block.type === 'paragraph') {
          assert.equal(block.icon ?? null, block.iconToken ? block.iconToken.icon : null, 'a paragraph icon is its token')
          if (block.iconToken) tokens.set(source[block.iconToken.line], { kind: 'paragraph', key: block.iconToken.key.trim(), icon: block.iconToken.icon, top: true })
        }
        const list = block.type === 'list' ? block : block.type === 'object-chart' ? block.list : null
        if (list) {
          const top = (list.iconTokens ?? []).filter((t) => t.top)
          assert.deepEqual((list.iconOverrides ?? []).filter(Boolean), top.map((t) => t.icon).filter(Boolean), 'a list icons are its top-level tokens')
          for (const t of list.iconTokens ?? []) tokens.set(source[t.line], { kind: 'item', key: t.key.trim(), icon: t.icon, top: t.top, indentLength: t.indentLength, markLength: t.markLength })
        }
      }
      for (const block of lexMarkdownBlocks(lexed)) take(block)
      slides.push({ lexed, source })
      if (!self) walk(child)
    }
  }
  walk(tree.root, true)
  walk(tree.root)
  return { written, bodyLines, removed, tokens, outside, headings, slides }
}

// ── The comparison ──────────────────────────────────────────────────────────────────────────────
const counts = { comment: 0, split: 0, vocabulary: 0, commentHeading: 0, layoutPartlyCommented: 0, layoutNotUnderHeading: 0, spansPinned: 0, items: 0, headings: 0, groups: 0, removed: 0, hidden: 0, tails: 0, words: 0, compiledSpans: 0, compiledShownTwin: 0, beforeFirstSlide: 0 }
const examples = { comment: [], commentHeading: [], split: [], vocabulary: [], layout: [] }
const example = (kind, written, i) => { if (examples[kind].length < EXAMPLES) examples[kind].push(`line ${i + 1} of ${JSON.stringify(written.slice(Math.max(0, i - 2), i + 2))}`) }

const ICON_KEYS = new Set(['icon', 'titleIcon', 'iconOverrides', 'icons', 'iconToken', 'iconTokens', 'sourceLines'])
/** A value without the fields that hold an icon's name (what the compiler recorded of a token, not text it prints). */
const withoutIcons = (value) => Array.isArray(value) ? value.map(withoutIcons)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !ICON_KEYS.has(key)).map(([key, v]) => [key, withoutIcons(v)]))
    : value
function leaves(value, out = []) {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value))
  else if (Array.isArray(value)) for (const v of value) leaves(v, out)
  else if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) if (!ICON_KEYS.has(key)) leaves(v, out)
  return out
}
const groupsIn = (text) => text.match(/\{[^}]*\}/g) ?? []

function compare(text) {
  const truth = compilerTruth(text)
  const facts = plainViewFacts(text)
  const { written } = truth
  const starts = []
  for (let i = 0, at = 0; i < written.length; i += 1) { starts.push(at); at += written[i].length + 1 }
  const lineOf = (pos) => { let i = starts.length - 1; while (starts[i] > pos) i -= 1; return i }
  const fail = (line, message) => { const error = new Error(`line ${line + 1}: ${message}\n  ${JSON.stringify(written[line])}`); error.line = line; throw error }

  /** Every span Plain hides or protects: { line, from, to (columns), what }. */
  const hiddenSpans = []

  // Headings: the consumed groups and the title's icon.
  const plainTitles = new Map(facts.items.filter((item) => item.kind === 'heading').map((item) => [lineOf(item.lineFrom), item.key]))
  for (const heading of truth.headings.values()) {
    const i = heading.line
    counts.headings += 1
    const tail = isHeadingTailLine(facts.read, i) && facts.read.compilerHeading[i] ? headingTail(0, written[i]) : null
    const shift = written[i].length - truth.bodyLines[i].length
    if (shift && !tail) { if (heading.groups.length) { counts.commentHeading += 1; example('commentHeading', written, i) } if (plainTitles.has(i)) fail(i, 'a title icon is drawn on a heading whose tail is not read'); continue }
    const plain = (tail?.groups ?? []).map((g) => [g.from - shift, g.to - shift])
    counts.groups += plain.length
    if (JSON.stringify(plain) !== JSON.stringify(heading.groups)) fail(i, `heading groups: plain ${JSON.stringify(plain)}, compiler ${JSON.stringify(heading.groups)}`)
    if ((plainTitles.get(i) ?? null) !== heading.icon) fail(i, `title icon: plain ${plainTitles.get(i) ?? null}, compiler ${heading.icon}`)
    // The invariant: what Plain leaves visible of the line is the title the compiler made of it.
    if (tail) {
      counts.tails += 1
      const shown = truth.bodyLines[i].slice(headingLine(truth.bodyLines[i]).textFrom, tail.textEnd - shift).trim()
      if (shown !== heading.title) fail(i, `INVARIANT: Plain hides more or less than the compiler takes off the title: Plain shows ${JSON.stringify(shown)}, the compiler's title is ${JSON.stringify(heading.title)}`)
      hiddenSpans.push({ line: i, from: tail.textEnd, to: written[i].length, what: 'a heading tail' })
    }
    plainTitles.delete(i)
  }
  for (const i of plainTitles.keys()) fail(i, 'a title icon on a line the compiler reads no heading on')
  for (let i = 0; i < written.length; i += 1) {
    if (facts.read.compilerHeading[i] && ![...truth.headings.values()].some((h) => h.line === i) && isHeadingTailLine(facts.read, i) && headingTail(0, written[i]) && i !== truth.headings.get('title')?.line) {
      // A second `#` line: the compiler reads it as the talk's title too (the last one wins).
      if (!/^#\s/.test(written[i])) fail(i, 'a heading tail on a line the compiler reads no heading on')
    }
  }

  // Paragraph and list item icons.
  const shownTokenLines = []
  const plainItems = new Map(facts.items.filter((item) => item.kind !== 'heading').map((item) => [lineOf(item.to), item]))
  for (const [i, token] of truth.tokens) {
    const item = plainItems.get(i)
    if (item) {
      counts.items += 1
      if (item.kind !== token.kind || item.key !== token.key || item.nested !== !token.top) fail(i, `icon item: plain ${item.kind} ${item.key} nested=${item.nested}, compiler ${token.kind} ${token.key} top=${token.top}`)
      if (text.slice(item.tokenFrom, item.to).trimEnd().slice(-1) !== '}' || text[item.tokenFrom] !== '{' || item.to !== starts[i] + written[i].length) fail(i, 'the token is not the end of the line')
      const drawn = normalizeIconOverrideKey(item.key)
      if (drawn !== token.icon) fail(i, `icon key: plain ${drawn}, compiler ${token.icon}`)
      // The protected span, pinned to the compiler's consumed offsets on this line: `consumedFrom`
      // (the start of the whitespace its reader takes with the token) and `braceAt` (the `{`).
      let consumedFrom, braceAt, textFrom
      if (token.kind === 'paragraph') {
        const at = paragraphIconTokenAt(written[i])
        if (!at) fail(i, 'the compiler reads no paragraph token at the end of this line')
        consumedFrom = at.from; braceAt = at.tokenFrom; textFrom = null
      } else {
        textFrom = token.indentLength + token.markLength
        const content = written[i].slice(textFrom)
        const at = listItemIconTokenAt(content, normalizeIconOverrideKey)
        if (!at) fail(i, 'the compiler reads no list item token at the end of this line')
        consumedFrom = textFrom + at.index; braceAt = textFrom + content.indexOf('{', at.index)
      }
      const permittedFrom = consumedFrom < braceAt ? braceAt - 1 : braceAt
      const span = { textEnd: item.textEnd - starts[i], from: item.from - starts[i], tokenFrom: item.tokenFrom - starts[i], to: item.to - starts[i] }
      if (span.tokenFrom !== braceAt) fail(i, `PINNED: the item's token starts at column ${span.tokenFrom}, the compiler's at ${braceAt}`)
      if (span.textEnd !== permittedFrom || span.from !== permittedFrom) fail(i, `PINNED: the protected span starts at column ${span.textEnd} (from ${span.from}); the compiler consumed from ${consumedFrom}, so it must start at ${permittedFrom}`)
      if (span.to !== written[i].length) fail(i, `PINNED: the protected span ends at column ${span.to}, the line at ${written[i].length}`)
      if (JSON.stringify(item.spans.map((s) => [s.from - starts[i], s.tokenFrom - starts[i], s.to - starts[i]])) !== JSON.stringify([[permittedFrom, braceAt, written[i].length]])) fail(i, `PINNED: the item's spans ${JSON.stringify(item.spans)} are not the one protected span`)
      if (/\S/.test(written[i].slice(span.textEnd, span.tokenFrom))) fail(i, 'PINNED: visible text inside the protected span')
      if (textFrom !== null && item.textFrom - starts[i] !== textFrom) fail(i, `PINNED: the item's text starts at column ${item.textFrom - starts[i]}, after the compiler's mark at ${textFrom}`)
      if (item.textFrom > item.textEnd && written[i].slice(textFrom ?? 0, braceAt).trim() !== '') fail(i, 'PINNED: the text ends before it starts')
      counts.spansPinned += 1
      hiddenSpans.push({ line: i, from: item.textEnd - starts[i], to: written[i].length, what: 'an icon token', item })
      plainItems.delete(i)
      continue
    }
    // No item: the compiler consumes the token and Plain shows it. Never the other way: nothing
    // of Plain's is hidden on such a line (asserted below, where the hidden lines are known).
    shownTokenLines.push(i)
    if (written[i] !== truth.bodyLines[i]) { counts.comment += 1; example('comment', written, i); continue }
    const split = token.kind === 'paragraph' && paragraphIconTokenAt(written[i])?.key.trim() !== token.key
    if (split) { counts.split += 1; example('split', written, i); continue }
    const explicit = token.kind === 'item' && listItemIconTokenAt(written[i].slice(token.indentLength + token.markLength), () => null)
    if (token.kind === 'item' && !explicit && !/^(lucide|svgl|tabler):/.test(token.key)) { counts.vocabulary += 1; example('vocabulary', written, i); continue }
    fail(i, `the compiler gives ${token.kind} icon ${token.key}; the plain view has no item`)
  }
  for (const i of plainItems.keys()) fail(i, 'the plain view has an icon item the compiler has none for')

  // Nothing on a line outside the outline.
  const hidden = hiddenLayoutLines(facts, written)
  for (const i of hidden) if (truth.outside.has(i)) fail(i, 'a hidden layout line outside the outline')
  for (const item of facts.items) for (let i = lineOf(item.textEnd); i <= lineOf(item.to); i += 1) if (truth.outside.has(i)) fail(i, 'an icon item outside the outline')

  // Layout lines. The invariant: every line Plain hides is one the compiler removes.
  counts.removed += truth.removed.size
  counts.hidden += hidden.length
  const hiddenSet = new Set(hidden)
  for (const i of hidden) {
    if (!truth.removed.has(i)) fail(i, 'INVARIANT: Plain hides a layout line the compiler keeps as content')
    if (written[i] !== truth.bodyLines[i]) fail(i, 'INVARIANT: Plain hides a layout line the compiler reads fewer characters of')
    hiddenSpans.push({ line: i, from: 0, to: written[i].length, what: 'a layout line' })
  }
  // The other way: every line the compiler removes and reads whole is hidden. The one class shown
  // is a line partly inside an HTML comment; a shown line of any other kind fails.
  const headingAbove = (i) => { let k = i - 1; while (k >= 0 && hiddenSet.has(k)) k -= 1; return k >= 0 && [...truth.headings.values()].some((h) => h.line === k) }
  for (const i of truth.removed) {
    if (hiddenSet.has(i)) { if (!headingAbove(i)) counts.layoutNotUnderHeading += 1; continue }
    if (written[i] !== truth.bodyLines[i]) { counts.layoutPartlyCommented += 1; example('layout', written, i); continue }
    fail(i, 'INVARIANT (the other way): the compiler removes this layout line and reads it whole, and Plain shows it')
  }
  // The counted classes run one way: on a line whose token the compiler consumes and Plain has no
  // item for, Plain hides nothing at all.
  for (const i of shownTokenLines) if (hiddenSpans.some((span) => span.line === i)) fail(i, 'INVARIANT: a counted difference is on a line Plain hides text of')

  // Icon tokens, at the lexer (which no layout changes): in the blocks the slide's content lexes
  // to, the token is not text (unless the same token is also written where Plain shows it), and
  // every word of the line's visible text is. So the lexer took the hidden span and no more.
  const cutOf = new Map()
  for (const span of hiddenSpans) if (span.what === 'an icon token') cutOf.set(span.line, span)
  for (const slide of truth.slides) {
    if (!slide.source.some((i) => cutOf.has(i))) continue
    const printed = leaves(withoutIcons(lexMarkdownBlocks(slide.lexed)))
    const shown = slide.lexed.map((line, k) => (cutOf.has(slide.source[k]) ? line.slice(0, cutOf.get(slide.source[k]).from) : line)).join('\n')
    slide.source.forEach((i, k) => {
      const span = cutOf.get(i)
      if (!span) return
      if (slide.lexed[k] !== written[i]) fail(i, 'INVARIANT: an icon item on a line the lexer reads other characters of')
      const token = text.slice(span.item.tokenFrom, span.item.to).trim()
      if (printed.some((leaf) => leaf.includes(token)) && !shown.includes(token)) fail(i, `INVARIANT: Plain hides the icon token ${token}, and the lexer keeps it as text`)
      const visible = written[i].slice(span.item.kind === 'item' ? span.item.textFrom - starts[i] : 0, span.from)
      for (const word of visible.match(/[\p{L}\p{N}]+/gu) ?? []) {
        counts.words += 1
        if (!printed.some((leaf) => leaf.includes(word))) fail(i, `INVARIANT: the lexer drops ${JSON.stringify(word)} of the text Plain shows beside a hidden icon token`)
      }
    })
  }

  // The compiled talk: no hidden group is printed in its slide.
  const compiled = adaptMarkdownOutlineV2(text, 'Fallback', {})
  const nodeLines = [...truth.headings.keys()].filter((key) => key !== 'title').sort((a, b) => a - b)
  const titleLine = truth.headings.get('title')?.line ?? -1
  const printedOf = new Map()
  for (const slide of compiled.slides) {
    if (typeof slide.sourceLine !== 'number') continue
    const h = slide.sourceLine - 1
    printedOf.set(h, [...(printedOf.get(h) ?? []), ...leaves([slide.title, slide.kicker, slide.blocks])])
  }
  const deckPrinted = leaves([compiled.title, compiled.slides.filter((slide) => typeof slide.sourceLine !== 'number').map((slide) => [slide.title, slide.blocks])])
  // A line as Plain shows it and the compiler reads it: the line the compiler reads (comments
  // blanked) where nothing is hidden, the written line with its hidden spans cut out otherwise.
  let shown = null
  const shownLine = (i) => {
    const spans = hiddenSpans.filter((sp) => sp.line === i).sort((a, b) => b.from - a.from)
    let line = spans.length ? written[i] : truth.bodyLines[i]
    for (const span of spans) line = line.slice(0, span.from) + line.slice(span.to)
    return line
  }
  for (const span of hiddenSpans) {
    const i = span.line
    const h = nodeLines.filter((n) => n <= i).pop()
    const deck = i === titleLine
    if (h === undefined && !deck) { counts.beforeFirstSlide += 1; if (span.what === 'a layout line') fail(i, 'INVARIANT: a layout line is hidden before the first slide'); continue }
    const printed = deck ? deckPrinted : (printedOf.get(h) ?? [])
    for (const group of groupsIn(written[i].slice(span.from, span.to))) {
      counts.compiledSpans += 1
      if (!printed.some((leaf) => leaf.includes(group))) continue
      shown ??= written.map((_, k) => shownLine(k)).join('\n')
      if (!shown.includes(group)) fail(i, `INVARIANT: Plain hides ${span.what} ${group}, and the compiled slide prints it: ${JSON.stringify(printed.find((leaf) => leaf.includes(group)))}`)
      counts.compiledShownTwin += 1
    }
  }
}

console.log(`plain view and compiler on generated documents: seed ${SEED}, ${DOCUMENTS} documents`)
for (let n = 0; n < DOCUMENTS; n += 1) {
  const text = generate()
  try {
    compare(text)
  } catch (error) {
    console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED})\n${error.message}\n`)
    console.error(text.split('\n').map((line, i) => `${i === error.line ? '>' : ' '}${String(i + 1).padStart(3)} ${line}`).join('\n'))
    process.exit(1)
  }
}
assert.ok(counts.items > DOCUMENTS && counts.groups > DOCUMENTS / 2 && counts.removed > DOCUMENTS / 2 && counts.hidden > DOCUMENTS / 2 && counts.tails > DOCUMENTS / 2 && counts.layoutNotUnderHeading > DOCUMENTS / 10 && counts.spansPinned === counts.items, 'the generator reaches icon items, heading groups and Trigger lines')
console.log(`  compared: ${counts.headings} headings (${counts.groups} trailing groups), ${counts.items} paragraph and list icon items, ${counts.removed} Trigger lines`)
console.log(`  invariant held (Plain hides only what the compiler consumes): ${counts.hidden} hidden layout lines, ${counts.tails} heading tails, ${counts.items} icon tokens (${counts.words} words of visible text beside them found in the lexer's blocks)`)
console.log(`  compiled talk: ${counts.compiledSpans} hidden groups looked for in their compiled slides; ${counts.compiledShownTwin} printed there, each also written in the document where Plain shows it (not told apart); ${counts.beforeFirstSlide} icon spans before the first slide (no compiled slide)`)
console.log('  the compiler consumes, Plain shows (counted, allowed):')
console.log(`    a comment removed characters from the line: ${counts.comment} icon tokens, ${counts.commentHeading} heading tails`)
console.log(`    an icon token broken over two lines: ${counts.split}`)
console.log(`    a bare unprefixed {name} on a list item, known to the compiler's icon sets only: ${counts.vocabulary}`)
console.log(`    a Trigger line the compiler removes that is partly inside an HTML comment: ${counts.layoutPartlyCommented}`)
console.log(`    a Trigger line the compiler removes and reads whole that Plain shows: 0 (asserted on every document)`)
console.log(`  hidden both ways: of the ${counts.hidden} hidden layout lines, ${counts.layoutNotUnderHeading} are not in the run directly under a heading (after a blank line, among the body)`)
console.log(`  protected spans pinned to the compiler's consumed token offsets: ${counts.spansPinned} icon items`)
for (const [kind, list] of Object.entries(examples)) for (const line of list) console.log(`    example, ${kind}: ${line}`)
console.log('ok')
