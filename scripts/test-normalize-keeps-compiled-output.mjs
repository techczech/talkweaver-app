// The save-time tidy-up (src/shared/outline-normalize.ts normalizePositions, run by the editor at
// every autosave, flush and whole-buffer save) never changes what the compiler produces.
//
// It moves the `{…}` groups written after a slide title down to the line under it. The compiler
// reads a title's own icon (`### Title {icon=lucide:star}`) from the heading line only
// (02-triggers-layout.mjs headingIconGroups), so that group must stay where it is: build
// 0.39.0-preview.6 moved it and the icon went from the slide at the next autosave.
//
// The invariant, for any document:
//   compile(tidy(text)) equals compile(text)   slides, titles, title icons, layouts, blocks
//   tidy(tidy(text)) === tidy(text)
//
// 1. A table: the exact text the tidy-up leaves, and the invariant, for each named case.
// 2. Generated documents (the generator of scripts/test-plain-view-layout-verbs-generated.mjs, with
//    groups written after titles far more often, title icons among them): the invariant on each.
//    Counted, and a zero is a failure: documents the tidy-up changed, documents with a title icon,
//    headings that kept a title icon while other groups moved off them.
//    ALLOWANCES names the kinds of document where the tidy-up changes the compiled talk for a
//    reason other than a title icon. Each is counted and printed; a document that differs and
//    matches none of them is a failure, and so is an allowance that matched no document.
//
//   node scripts/test-normalize-keeps-compiled-output.mjs [--seed=N] [--documents=N] [--survey]
// Without --seed it runs the seeds 20261012, 41, 42, 43 and 44. --survey prints every kind of
// difference found, with the smallest document that shows it, instead of failing on the first.
import assert from 'node:assert/strict'
import { normalizePositions, normalizeTriggerLines } from '../src/shared/outline-normalize.ts'
import { isSettableLayout, entryTriggerBody } from '../src/shared/slide-authored-layout.ts'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'
import { headingIconGroups } from '../compiler/scripts/lib/02-triggers-layout.mjs'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const SEEDS = arg('seed') ? [Number(arg('seed')) >>> 0] : [20261012, 41, 42, 43, 44]
const DOCUMENTS = Number(arg('documents') ?? 800)
const SURVEY = process.argv.includes('--survey')

// ── The real compiler, before and after ─────────────────────────────────────────────────────────

/** Positions move when a group goes to a line of its own; the two quoted fields hold the outline's own text. */
const POSITIONAL = new Set(['sourceLine', 'sourceLines', 'line', 'startLine', 'endLine', 'sourceMarkdown', 'scriptSourceMarkdown'])
const unplaced = (value) => (Array.isArray(value) ? value.map(unplaced)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !POSITIONAL.has(key)).map(([key, v]) => [key, unplaced(v)]))
    : value)
const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
/** Every heading of the outline tree: its level, title, own icon and folded attrs. */
function headingsOf(text) {
  const tree = parseOutlineTree(text)
  const out = []
  const walk = (node) => {
    if (node.level > 0) out.push({ level: node.level, title: node.title, titleIcon: node.titleIcon ?? '', id: node.id ?? '', attrs: sorted(node.attrs) })
    node.children.forEach(walk)
  }
  walk(tree.root)
  return { headings: out, deckTitleIcon: tree.deckTitleIcon, deckTitle: tree.meta.title }
}
const compile = (text) => ({ slides: unplaced(adaptMarkdownOutlineV2(text, 'Fallback', {}).slides), outline: headingsOf(text) })

/** Every path at which two compiled values differ. */
function differences(was, now, path = '', out = []) {
  if (JSON.stringify(was) === JSON.stringify(now)) return out
  if (was && now && typeof was === 'object' && typeof now === 'object' && Array.isArray(was) === Array.isArray(now)) {
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) differences(was[key], now[key], `${path}.${key}`, out)
  } else out.push({ path, was, now })
  return out
}
const show = (text) => text.split('\n').map((line, i) => `${String(i + 1).padStart(3)} ${JSON.stringify(line)}`).join('\n')

/** The invariant on one document. Returns the differences in the compiled talk (none: it holds). */
function compiledDifferences(text) {
  const tidy = normalizePositions(text)
  assert.equal(normalizePositions(tidy), tidy, `the tidy-up is not idempotent:\n${show(text)}\n\nonce:\n${show(tidy)}\n\ntwice:\n${show(normalizePositions(tidy))}`)
  if (tidy === text) return []
  return differences(compile(text), compile(tidy))
}

// ── 1. The table ────────────────────────────────────────────────────────────────────────────────

const doc = (...lines) => ['# Talk', '', '## Part', '', ...lines].join('\n')
/** [name, lines before, lines after the tidy-up, the title icon of the slide titled `Title` (null: none)]. */
const TABLE = [
  ['a title icon alone stays on the title',
    ['### Title {icon=lucide:star}', 'Text.'],
    ['### Title {icon=lucide:star}', 'Text.'], 'lucide:star'],
  ['a title icon with no body',
    ['### Title {icon=lucide:star}'],
    ['### Title {icon=lucide:star}'], 'lucide:star'],
  ['a title icon stays; the id after it moves down',
    ['### Title {icon=lucide:star} {id=a1}', 'Text.'],
    ['### Title {icon=lucide:star}', '{id=a1}', 'Text.'], 'lucide:star'],
  ['a title icon stays; the id before it moves down',
    ['### Title {id=a1} {icon=lucide:star}', 'Text.'],
    ['### Title {icon=lucide:star}', '{id=a1}', 'Text.'], 'lucide:star'],
  ['a title icon stays; the id written against it moves down',
    ['### Title {id=a1}{icon=lucide:star}', 'Text.'],
    ['### Title {icon=lucide:star}', '{id=a1}', 'Text.'], 'lucide:star'],
  ['a title icon stays; the id joins the id line already there',
    ['### Title {icon=lucide:flag} {reveal}', '{id=t4itm}', 'Text.'],
    ['### Title {icon=lucide:flag}', '{reveal}{id=t4itm}', 'Text.'], 'lucide:flag'],
  ['a title icon stays; reveal and a layout move down',
    ['### Title {icon=lucide:star} {reveal} {statement}', 'Text.'],
    ['### Title {icon=lucide:star}', '{reveal} {statement}', 'Text.'], 'lucide:star'],
  ['a title icon between two groups: both move, in order',
    ['### Title {reveal}{icon=lucide:star}{statement}', 'Text.'],
    ['### Title {icon=lucide:star}', '{reveal}{statement}', 'Text.'], 'lucide:star'],
  ['a title icon and a layout line that is not the first line under it',
    ['### Title {icon=lucide:star}', '', '', '{cards}', '- A', '- B'],
    ['### Title {icon=lucide:star}', '{cards}', '- A', '- B'], 'lucide:star'],
  ['a title icon, a moved group, and a layout line after blank lines',
    ['### Title {icon=lucide:star} {reveal}', '', '{cards}', '- A', '- B'],
    ['### Title {icon=lucide:star}', '{reveal}{cards}', '- A', '- B'], 'lucide:star'],
  ['two title icons both stay: the last one is drawn',
    ['### Title {icon=lucide:star} {icon=lucide:flag}', 'Text.'],
    ['### Title {icon=lucide:star} {icon=lucide:flag}', 'Text.'], 'lucide:flag'],
  ['two title icons around another group',
    ['### Title {icon=lucide:star}{reveal}{icon=lucide:flag}', 'Text.'],
    ['### Title {icon=lucide:star}{icon=lucide:flag}', '{reveal}', 'Text.'], 'lucide:flag'],
  ['an icon in one group with another token: the line is left as written',
    ['### Title {quote} {icon=lucide:star statement}', 'Text.'],
    ['### Title {quote} {icon=lucide:star statement}', 'Text.'], 'lucide:star'],
  ['braces written against the title text are not its icon: they move as before',
    ['### See https://example.org/{icon=lucide:star}', 'Text.'],
    ['### See https://example.org/', '{icon=lucide:star}', 'Text.'], null],
  ['no icon: every group moves, as before',
    ['### Title {statement} {id=a1}', 'Text.'],
    ['### Title', '{statement} {id=a1}', 'Text.'], null],
  ['an icon on a section title',
    ['## Title {icon=lucide:star} {id=s1}', '', '### Inside', 'Text.'],
    ['## Title {icon=lucide:star}', '{id=s1}', '', '### Inside', 'Text.'], 'lucide:star'],
  ['an icon on the title of a carousel item',
    ['### Deck {carousel}', '', '#### Title {icon=lucide:star} {id=c1}', 'Text.', '', '#### Other {icon=lucide:flag}', 'More.'],
    ['### Deck', '{carousel}', '', '#### Title {icon=lucide:star}', '{id=c1}', 'Text.', '', '#### Other {icon=lucide:flag}', 'More.'], 'lucide:star'],
  ['a heading inside a code fence is code',
    ['### Real', '```', '### Title {icon=lucide:star} {id=a1}', '```'],
    ['### Real', '```', '### Title {icon=lucide:star} {id=a1}', '```'], null]
]

const titleIconOf = (text, title) => parseOutlineTree(text).root.children.flatMap(function flat(node) { return [node, ...node.children.flatMap(flat)] }).find((node) => node.title === title)?.titleIcon ?? null
let tableChanged = 0
for (const [name, before, after, icon] of TABLE) {
  for (const eol of ['\n', '\r\n']) {
    const label = `${name}${eol === '\r\n' ? ' (CRLF)' : ''}`
    const text = doc(...before).split('\n').join(eol)
    const tidy = normalizePositions(text)
    // Line endings: the tidy-up has always written a moved line without its carriage return; the
    // lines are compared without them and the compiled talks in full.
    assert.equal(tidy.replace(/\r/g, ''), doc(...after), `${label}: the text after the tidy-up`)
    assert.equal(titleIconOf(text, 'Title'), icon, `${label}: the title's icon before the tidy-up`)
    assert.equal(titleIconOf(tidy, 'Title'), icon, `${label}: the title's icon after the tidy-up`)
    assert.deepEqual(compiledDifferences(text), [], `${label}: the compiled talk is the same`)
    assert.equal(normalizeTriggerLines(tidy), tidy, `${label}: the first pass alone has nothing left to move`)
    if (tidy !== text) tableChanged += 1
  }
}
// The outline the packaged smoke of 0.39.0-preview.6 lost its icon from, at its first save.
{
  const smoke = ['---', 'title: "Icon smoke"', 'outline_version: 2', '---', '', '# Icon smoke', '', '## First part', '', '### Paragraph slide', 'Hello.', '', '### Starred slide {icon=lucide:star}', 'This title already has an icon.', '', '### Closing slide', '{id=t4itm}', 'Thanks.', ''].join('\n')
  assert.equal(normalizePositions(smoke), smoke, 'the smoke outline is left exactly as written')
  assert.equal(adaptMarkdownOutlineV2(normalizePositions(smoke), 'F', {}).slides.find((slide) => slide.title === 'Starred slide')?.titleIcon, 'lucide:star')
}
console.log(`table: ${TABLE.length} cases × LF and CRLF, ${tableChanged} changed by the tidy-up, the compiled talk the same in all`)

// ── 2. Generated documents ──────────────────────────────────────────────────────────────────────

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
const FORMS = [...new Set(SETTABLE.flatMap((entry) => [
  entryTriggerBody(entry), ...entry.aliases.map((a) => a.replace(/^\{|\}$/g, '')), ...entry.triggerWords,
  ...(entry.kind === 'layout' && !entry.resolvesTo ? [`layout=${entry.name}`] : []),
  ...(entry.resolvesTo ? [`${entry.resolvesTo.key}=${entry.resolvesTo.value}`] : [])
]))].filter(Boolean)
const OTHER = ['reveal', 'id=a1', 'id=b_2', 'nostep', 'accent=cobalt', 'icon=lucide:star', 'statement-bg=full', 'cards=stepped', 'cols=3', 'blocks:2x3', 'unknownword', 'note="a, b"', 'title-icon=above']
const ICONS = ['{icon=lucide:star}', '{icon=lucide:flag}', '{icon=svgl:moon}', '{icon="lucide:sun"}', '{ icon=lucide:star }', '{icon=}', '{icon=lucide:star title-icon=above}']
const WORDS = ['Alpha', 'Beta gamma', 'A longer line of plain words', 'Text with `code`', 'After', 'See https://example.org/']
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
  // What is written after a title: nothing, or one to four groups (a title icon, an id, any other
  // group), spaced or written against each other, now and then written against the title's text.
  const tail = () => {
    if (random() < 0.4) return ''
    const parts = Array.from({ length: int(1, 4) }, () => { const r = random(); return r < 0.4 ? pick(ICONS) : r < 0.55 ? `{id=${pick(['a1', 'b_2', 'c3'])}}` : group() })
    return (random() < 0.06 ? '' : pick([' ', ' ', '  '])) + parts.reduce((line, part) => line + (line ? pick(['', ' ', ' ']) : '') + part, '') + (random() < 0.05 ? '  ' : '')
  }
  const body = () => pick([
    ['- A', '- B', '- C'], ['- A: 1', '- B: 2'], ['A paragraph.'], ['> A quotation'], ['![x](a.png)', '![y](b.png)'], ['- A', '  - sub', '- B', '  - sub'],
    ['```', '{cards}', '```'], ['{chart=bar}', '- A: 1', '- B: 2'], [':::notes', '{cards}', ':::'], []
  ])
  const plain = () => pick([
    ['A paragraph.'], ['A paragraph.', '', 'Another one.'], ['- A', '- B', '- C'], ['1. A', '2. B'], ['![x](a.png)'], ['![x](a.png)', '![y](b.png)'],
    ['{chart=bar}', '- A: 1', '- B: 2'], ['{chart=pie}', '- A: 1', '- B: 2', '', '{chart=bar}', '- C: 3'],
    ['A paragraph.', '', '- A', '- B'], ['![x](a.png)', '', '- A', '- B'], ['![x](a.png)', '', 'A paragraph.'], ['> A quotation', '', '- A'],
    ['A paragraph. {icon=lucide:star}'], ['- A {icon=lucide:flag}', '- B']
  ])
  const slide = (level) => {
    const lines = [`${'#'.repeat(level)} ${pick(WORDS)}${tail()}`]
    if (random() < 0.25) lines.push('')
    for (let k = int(0, 2); k > 0; k -= 1) lines.push(layoutLine())
    if (random() < 0.3) lines.push('')
    if (random() < 0.5) { lines.push(...plain()); return lines }
    lines.push(...body())
    if (random() < 0.45) { if (random() < 0.5) lines.push(''); lines.push(layoutLine()); lines.push(...body()) }
    if (random() < 0.2) lines.push(layoutLine())
    return lines
  }
  return () => {
    const lines = []
    const deck = pick(DECK)
    if (deck || random() < 0.2) lines.push('---', 'title: Generated', ...(deck ? [deck] : []), '---')
    lines.push(`# Talk${random() < 0.15 ? ` ${pick(ICONS)}` : ''}`, '', `## Part one${random() < 0.3 ? tail() : ''}`, '')
    for (let k = int(2, 9); k > 0; k -= 1) {
      lines.push(...slide(random() < 0.12 ? 2 : random() < 0.8 ? 3 : 4))
      lines.push(...(random() < 0.8 ? [''] : []))
    }
    const r = random()
    const eol = r < 0.125 ? () => '\r\n' : r < 0.17 ? () => (random() < 0.5 ? '\r\n' : '\n') : () => '\n'
    return lines.map((line, index) => (index + 1 < lines.length || random() < 0.5 ? line + eol() : line)).join('')
  }
}

// The kinds of document where the tidy-up changes the compiled talk for a reason that is not a
// title icon. Each `matches(text, tidy, diffs)` says whether a differing document is of that kind.
// These are defects of the tidy-up as it was before title icons existed; they are listed here so
// that the invariant is still asserted on every other document, not to bless them.
//
// Both were found by this pass (2026-10-12) and neither involves a title icon: an allowance only
// covers differences in the id and accent fields named in its `paths`, so a title icon, a title,
// a layout or a block that changed is a failure whatever else the document holds.
const TRAILING_GROUPS = /\s*(\{[^}]*\}(?:\s*\{[^}]*\})*)\s*$/
/** Each slide heading with groups after its title: those groups, and the lines under it up to the next heading. */
function headingsWithGroups(text) {
  const lines = text.replace(/\r/g, '').split('\n')
  const out = []
  lines.forEach((line, index) => {
    const groups = /^#{2,6} /.test(line) ? line.match(TRAILING_GROUPS)?.[1] : null
    if (!groups) return
    let end = index + 1
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1
    out.push({ groups, under: lines.slice(index + 1, end) })
  })
  return out
}
const onlyPaths = (diffs, pattern) => diffs.every((d) => pattern.test(d.path))
const ALLOWANCES = [
  {
    // ### Title {id=c3}        before: the slide's id is c3 (an id on the heading wins)
    // {layout=sigmoid}         after:  `### Title` / `{id=c3}{layout=sigmoid}` / `{id=b_2}`,
    // {id=b_2}                         and the slide's id is b_2 (the last id line under it wins)
    name: 'an id moved off the title while another id is written under it',
    why: 'the slide takes the other id (slide-id.mjs: an id on the heading wins; under it, the last id line wins)',
    paths: /\.(id|section|subsection)$/,
    matches: (text, _tidy, diffs) => onlyPaths(diffs, /\.(id|section|subsection)$/)
      && headingsWithGroups(text).some((heading) => /\bid=/.test(heading.groups) && heading.under.some((line) => /\bid=/.test(line)))
  },
  {
    // ## Title {note="a, b"}   before: the section's accent is cobalt
    // <!-- c -->               after:  `## Title` / `{note="a, b"}` / `<!-- c -->` / `{accent=cobalt}`,
    // {accent=cobalt}                  and the section has no accent: the moved groups went onto a new
    //                                  line above the comment, and the line after it is no longer the
    //                                  title's own. The same with `<!-- c --> {accent=cobalt}` on one line.
    name: 'groups moved off a title whose first line under it holds an HTML comment',
    why: 'the groups go onto a new line above the comment, and the tokens after the comment (an id, a section accent) stop being the title\'s',
    paths: /\.(id|section|subsection|sectionAccent)$/,
    matches: (text, _tidy, diffs) => onlyPaths(diffs, /\.(id|section|subsection|sectionAccent)$/)
      && headingsWithGroups(text).some((heading) => (heading.under.find((line) => line.trim() !== '') ?? '').includes('<!--'))
  }
]

const kindOf = (diffs) => [...new Set(diffs.map((d) => d.path.replace(/\.\d+/g, '[]')))].sort().join(' ')
/** --survey: the document with lines and `{…}` groups taken out for as long as the same kind of difference shows. */
function smallest(text, kind) {
  const still = (candidate) => { try { return kindOf(compiledDifferences(candidate)) === kind } catch { return false } }
  let lines = text.replace(/\r/g, '').split('\n')
  for (let again = true; again;) {
    again = false
    for (let k = lines.length - 1; k >= 0; k -= 1) {
      const without = [...lines.slice(0, k), ...lines.slice(k + 1)]
      if (still(without.join('\n'))) { lines = without; again = true; continue }
      for (const group of [...lines[k].matchAll(/\s*\{[^}]*\}/g)].reverse()) {
        const shorter = [...lines]
        shorter[k] = lines[k].slice(0, group.index) + lines[k].slice(group.index + group[0].length)
        if (shorter[k] !== lines[k] && still(shorter.join('\n'))) { lines = shorter; again = true }
      }
    }
  }
  return lines.join('\n')
}
const SMALLEST = new Map()
function note(kind, text, diffs) {
  const entry = SMALLEST.get(kind) ?? { count: 0, text: smallest(text, kind), diffs }
  entry.count += 1
  SMALLEST.set(kind, entry)
}
/** A heading line the tidy-up took groups off while its title icon stayed. */
function keptIconWhileMoving(text, tidy) {
  const before = new Set(text.split('\n').map((line) => line.replace(/\r$/, '')))
  return tidy.split('\n').filter((line) => /^#{2,6} /.test(line) && !before.has(line.replace(/\r$/, '')) && headingIconGroups(line.replace(/\r$/, '').replace(/^#{2,6}\s+/, '')).groups.length > 0).length
}

const total = { documents: 0, changed: 0, withTitleIcon: 0, titleIcons: 0, keptWhileMoving: 0, same: 0, allowed: {} }
for (const SEED of SEEDS) {
  const next = generator(SEED)
  const started = Date.now()
  const counts = { changed: 0, withTitleIcon: 0, keptWhileMoving: 0 }
  for (let n = 0; n < DOCUMENTS; n += 1) {
    const text = next()
    total.documents += 1
    const tidy = normalizePositions(text)
    const outline = headingsOf(text)
    const icons = outline.headings.filter((heading) => heading.titleIcon).length
    if (icons) { counts.withTitleIcon += 1; total.titleIcons += icons }
    if (tidy !== text) counts.changed += 1
    counts.keptWhileMoving += keptIconWhileMoving(text, tidy)
    let diffs
    try { diffs = compiledDifferences(text) } catch (error) {
      console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED})\n${error.message}`)
      process.exit(1)
    }
    if (!diffs.length) { total.same += 1; continue }
    const allowance = ALLOWANCES.find((entry) => entry.matches(text, tidy, diffs))
    if (allowance) { total.allowed[allowance.name] = (total.allowed[allowance.name] ?? 0) + 1; continue }
    const kind = kindOf(diffs)
    if (SURVEY) { note(kind, text, diffs); continue }
    console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED})\nThe tidy-up changed the compiled talk: ${JSON.stringify(diffs.slice(0, 6), null, 1)}\n\n${show(text)}\n\nafter the tidy-up:\n${show(tidy)}`)
    process.exit(1)
  }
  total.changed += counts.changed
  total.withTitleIcon += counts.withTitleIcon
  total.keptWhileMoving += counts.keptWhileMoving
  console.log(`seed ${SEED}: ${DOCUMENTS} documents, ${counts.changed} changed by the tidy-up, ${counts.withTitleIcon} with a title icon, ${counts.keptWhileMoving} titles kept their icon while other groups moved (${Date.now() - started} ms)`)
}

if (SURVEY) {
  for (const [kind, entry] of [...SMALLEST].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n── ${entry.count} documents: ${kind}\n${JSON.stringify(compiledDifferences(entry.text).slice(0, 4))}\n${show(entry.text)}\n  after:\n${show(normalizePositions(entry.text))}`)
  }
}
const allowedTotal = Object.values(total.allowed).reduce((sum, n) => sum + n, 0)
console.log(`generated: ${total.documents} documents; the tidy-up changed ${total.changed}; ${total.withTitleIcon} have a title icon (${total.titleIcons} icons); ${total.keptWhileMoving} titles kept their icon while other groups moved; compiled talk the same on ${total.same}; ${allowedTotal} in a named allowance`)
for (const entry of ALLOWANCES) console.log(`  allowance "${entry.name}": ${total.allowed[entry.name] ?? 0} documents — ${entry.why}`)
if (!SURVEY) {
  assert.ok(total.changed > 0, 'the tidy-up changed no generated document: the pass proves nothing')
  assert.ok(total.withTitleIcon > 0, 'no generated document has a title icon: the pass proves nothing')
  assert.ok(total.keptWhileMoving > 0, 'no title kept its icon while other groups moved off it: the pass proves nothing')
  for (const entry of ALLOWANCES) assert.ok((total.allowed[entry.name] ?? 0) > 0, `the allowance "${entry.name}" matched no document: remove it`)
  assert.equal(total.same + allowedTotal, total.documents)
  console.log('PASS test-normalize-keeps-compiled-output')
}
