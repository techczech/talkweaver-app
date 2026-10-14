// Plain view, ticket 13: the verbs behind Command-I (src/shared/icon-verbs.ts), held to the compiler.
//
// 1. A table: a title, a paragraph, a list item; replace and remove; the lines that take no icon;
//    CRLF and a lone carriage return; other trailing tokens; a paragraph with a continuation line;
//    an item inside a carousel and inside cards; a key that is not in the icon set.
// 2. Generated documents. For every line of every document, setLineIcon either
//      refuses  → the text comes back unchanged, with a reason (counted by reason); or
//      succeeds → the REAL compiler (adaptMarkdownOutlineV2) is run on the outline before and
//                 after, and the two results differ in icon fields only, on the one slide that
//                 holds the line, with the icon asked for; no line but the one written changed;
//                 line endings are as they were; a paragraph's token is where the compiler's own
//                 verb writes it (12-outline-edit.mjs setParagraphIcon, the same text byte for
//                 byte) and a title's where setHeadingIcon writes it; and on a line that had no
//                 icon, clearLineIcon gives back the original outline exactly.
//    clearLineIcon on every line that carries an icon: refused with the text unchanged, or the
//    real compiler shows that icon gone and nothing else moved.
//    The counts of successes and refusals are printed, and no successes is a failure.
//
//   node scripts/test-plain-view-icon-verbs.mjs [--seed=N] [--documents=N]
// Without --seed it runs the seeds 20261012, 31, 32 and 33.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ICON_KEY_RE, clearLineIcon, iconLineAt, lineIconState, setLineIcon } from '../src/shared/icon-verbs.ts'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { setHeadingIcon, setParagraphIcon } from '../compiler/scripts/lib/12-outline-edit.mjs'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const SEEDS = arg('seed') ? [Number(arg('seed')) >>> 0] : [20261012, 31, 32, 33]
const DOCUMENTS = Number(arg('documents') ?? 500)

const LUCIDE = new Set(Object.keys(JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))).filter((name) => !name.startsWith('_')))
const known = (key) => key.startsWith('lucide:') && LUCIDE.has(key.slice(7))
const NAMES = [...LUCIDE]

// ── The real compiler, before and after ─────────────────────────────────────────────────────────

const compile = (text) => adaptMarkdownOutlineV2(text, 'Fallback', {}).slides
/** The two fields that quote the outline's own text. */
const QUOTED = new Set(['sourceMarkdown', 'scriptSourceMarkdown'])
const SAME = 'the compiled talk is the same'
/** Every path at which two compiled values differ, with the value after. */
function differences(was, now, path = '', out = []) {
  if (JSON.stringify(was) === JSON.stringify(now)) return out
  if (was && now && typeof was === 'object' && typeof now === 'object' && Array.isArray(was) === Array.isArray(now)) {
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) if (!QUOTED.has(key)) differences(was[key], now[key], `${path}.${key}`, out)
  } else out.push({ path, was, now })
  return out
}
/** A path that ends in an icon field: a paragraph's or a card's `icon`, a list's `iconOverrides`, a title's `titleIcon`. */
const ICON_PATH = /\.(icon|titleIcon|titleIconAt|iconOverrides(\.\d+)?)$/
const holds = (value, icon) => (Array.isArray(value) ? value.includes(icon) : value === icon)
/** The index of the compiled slide whose lines hold 0-based `line` (the talk's title: its first slide). */
function slideIndexOf(slides, line) {
  let found = -1
  slides.forEach((slide, index) => { if (typeof slide.sourceLine === 'number' && slide.sourceLine - 1 <= line) found = index })
  return found
}

/**
 * The compiled talk changed in icons only, on the one slide of `line`: `icon` is there now (null:
 * what was there is gone). Returns the reason it is not so, or null.
 */
function compiledIconChange(before, after, line, icon, isTalkTitle) {
  const was = compile(before)
  const now = compile(after)
  if (was.length !== now.length) return `${was.length} slides became ${now.length}`
  const diffs = differences(was, now)
  if (!diffs.length) return SAME
  const other = diffs.find((d) => !ICON_PATH.test(d.path))
  if (other) return `more than an icon changed: ${other.path} ${JSON.stringify(other.was)} → ${JSON.stringify(other.now)}`
  const slides = new Set(diffs.map((d) => d.path.split('.')[1]))
  if (slides.size !== 1) return `icons changed on ${slides.size} slides`
  const expected = isTalkTitle ? was.findIndex((slide) => slide.layout === 'title') : slideIndexOf(was, line)
  if (Number([...slides][0]) !== expected) return `the icon changed on slide ${[...slides][0]}, the line is in slide ${expected}`
  if (icon ? !diffs.some((d) => holds(d.now, icon)) : diffs.some((d) => d.now != null && !(Array.isArray(d.now) && d.now.every((v) => v == null)) && d.was != null && typeof d.now === 'string')) {
    return icon ? `the compiled slide does not show ${icon}: ${JSON.stringify(diffs)}` : `an icon is still there: ${JSON.stringify(diffs)}`
  }
  return null
}

/** Exactly one line differs, and only inside it (its line ending is as it was). */
function oneLineChanged(before, after, line) {
  const was = before.split('\n')
  const now = after.split('\n')
  assert.equal(now.length, was.length, 'the number of lines')
  was.forEach((text, i) => { if (i !== line) assert.equal(now[i], text, `line ${i + 1} is untouched`) })
  assert.notEqual(now[line], was[line], `line ${line + 1} is the one written`)
  assert.equal(now[line].endsWith('\r'), was[line].endsWith('\r'), `line ${line + 1} keeps its line ending`)
  assert.equal((after.match(/\r/g) ?? []).length, (before.match(/\r/g) ?? []).length, 'no carriage return was written or removed')
}

// ── 1. The table ────────────────────────────────────────────────────────────────────────────────

const STAR = 'lucide:star'
const table = (name, run) => { try { run() } catch (error) { console.error(`FAILED: ${name}`); throw error } }
const doc = (...lines) => lines.join('\n')
/** setLineIcon on the line that holds `needle`, expected to write `written` on (0-based) line `carrier`. */
function sets(text, needle, written, { icon = STAR, carrier = null, kind = null } = {}) {
  const line = text.split('\n').findIndex((entry) => entry.includes(needle))
  assert.ok(line >= 0, `the table's own line: ${needle}`)
  const result = setLineIcon(text, line, icon, known)
  assert.ok(result.ok, `set on ${JSON.stringify(needle)}: ${result.ok ? '' : result.reason}`)
  assert.equal(result.text.split('\n')[result.line], written)
  if (carrier !== null) assert.equal(result.line, carrier)
  if (kind) assert.equal(result.kind, kind)
  oneLineChanged(text, result.text, result.line)
  assert.equal(result.text, text.slice(0, result.change.from) + result.change.insert + text.slice(result.change.to), 'the change is the write')
  assert.equal(iconLineAt(text, result.change.from), result.line, 'the change is in the line written')
  assert.equal(compiledIconChange(text, result.text, line, icon, /^#\s/.test(text.split('\n')[line])), null)
  return result
}
function refuses(text, needle, reason, verb = 'set') {
  const line = typeof needle === 'number' ? needle : text.split('\n').findIndex((entry) => entry.includes(needle))
  const result = verb === 'set' ? setLineIcon(text, line, STAR, known) : clearLineIcon(text, line)
  assert.equal(result.ok, false, `${verb} on ${JSON.stringify(needle)} is refused`)
  assert.equal(result.reason, reason)
  assert.ok(result.detail)
  assert.equal(result.text, text, 'refused: the text is unchanged')
  if (verb === 'set') assert.equal(lineIconState(text, line).ok, false, 'the line cannot take an icon')
}

const BASE = doc(
  '---', 'title: Bikes', '---', '# Bike share {reveal}', '',
  '## How it works', '',
  '### What riders ask for {#s1 reveal}', '{iconlist}', '- Bikes that are there', '- A safe lane {icon=lucide:route}', '  - nested row', '1. Numbered row', '',
  'A paragraph that starts here', 'and continues here.', '',
  'Another one. {icon=lucide:sun}', '',
  '![picture](a.png)', '',
  '```', 'code line', '```', '',
  '> A quotation', '— Someone', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  ':::notes', 'a note', ':::', '',
  '### Steps {carousel}', '#### First', '- in the carousel', '#### Second', 'Text in the carousel', '',
  '### Prices {cards}', '- Day: three pounds', '- Year: sixty pounds'
)

table('title, paragraph, list item', () => {
  sets(BASE, '# Bike share', '# Bike share {icon=lucide:star} {reveal}', { kind: 'heading' })
  sets(BASE, '### What riders', '### What riders ask for {icon=lucide:star} {#s1 reveal}', { kind: 'heading' })
  sets(BASE, '- Bikes that', '- Bikes that are there {icon=lucide:star}', { kind: 'item' })
  sets(BASE, '1. Numbered', '1. Numbered row {icon=lucide:star}', { kind: 'item' })
  sets(BASE, '### Prices', '### Prices {icon=lucide:star} {cards}', { kind: 'heading' })
})
table('a paragraph with a continuation line: the token ends the paragraph', () => {
  const last = BASE.split('\n').indexOf('and continues here.')
  sets(BASE, 'A paragraph that starts', 'and continues here. {icon=lucide:star}', { carrier: last, kind: 'paragraph' })
  sets(BASE, 'and continues here.', 'and continues here. {icon=lucide:star}', { carrier: last, kind: 'paragraph' })
  const two = setLineIcon(BASE, last - 1, STAR, known)
  assert.deepEqual(lineIconState(two.text, last - 1), { ok: true, kind: 'paragraph', key: STAR }, 'the first line reports the paragraph\'s icon')
  assert.equal(clearLineIcon(two.text, last - 1).text, BASE, 'and clears it from the first line')
})
table('replace in place', () => {
  sets(BASE, '- A safe lane', '- A safe lane {icon=lucide:star}')
  sets(BASE, 'Another one.', 'Another one. {icon=lucide:star}')
  const titled = BASE.replace('{#s1 reveal}', '{#s1 icon=lucide:route reveal}')
  sets(titled, '### What riders', '### What riders ask for {#s1 icon=lucide:star reveal}')
  const short = BASE.replace('{icon=lucide:route}', '{lucide:route}')
  sets(short, '- A safe lane', '- A safe lane {icon=lucide:star}')
  const same = setLineIcon(BASE, BASE.split('\n').findIndex((l) => l.startsWith('- A safe')), 'lucide:route', known)
  assert.deepEqual([same.ok, same.changed, same.text === BASE, same.change], [true, false, true, null], 'the same icon: nothing to write')
})
table('remove: the token and its one space', () => {
  const at = (needle) => BASE.split('\n').findIndex((entry) => entry.includes(needle))
  for (const [needle, written] of [['- A safe lane', '- A safe lane'], ['Another one.', 'Another one.']]) {
    const result = clearLineIcon(BASE, at(needle))
    assert.ok(result.ok && result.changed)
    assert.equal(result.text.split('\n')[result.line], written)
    oneLineChanged(BASE, result.text, result.line)
    assert.equal(compiledIconChange(BASE, result.text, at(needle), null, false), null)
  }
  const titled = BASE.replace('{#s1 reveal}', '{#s1 icon=lucide:route reveal}')
  assert.equal(clearLineIcon(titled, at('### What riders')).text, BASE.replace('{#s1 reveal}', '{#s1 reveal}'), 'a title\'s token leaves its group')
  const alone = BASE.replace('ask for {#s1 reveal}', 'ask for {icon=lucide:route} {#s1 reveal}')
  assert.equal(clearLineIcon(alone, at('### What riders')).text, BASE, 'a title\'s own group goes whole')
  // A nested row's token draws nothing, and is removed all the same.
  const nested = BASE.replace('  - nested row', '  - nested row {icon=lucide:sun}')
  assert.equal(clearLineIcon(nested, at('nested row')).text, BASE)
  refuses(BASE, '- Bikes that', 'no-icon', 'clear')
})
table('lines that take no icon', () => {
  refuses(BASE, 'title: Bikes', 'not-here')
  refuses(BASE, 4, 'not-here') // blank
  refuses(BASE, '{iconlist}', 'not-here')
  refuses(BASE, '![picture]', 'not-here')
  refuses(BASE, 'code line', 'not-here')
  refuses(BASE, '```', 'not-here')
  refuses(BASE, '> A quotation', 'not-here')
  refuses(BASE, '— Someone', 'not-here')
  refuses(BASE, '| a | b |', 'not-here')
  refuses(BASE, '| 1 | 2 |', 'not-here')
  refuses(BASE, 'a note', 'not-here')
  refuses(BASE, 'nested row', 'nested-item')
  refuses(BASE, '## How it works', 'section-title')
  refuses(BASE, '#### First', 'folded-title')
  refuses(BASE, 999, 'no-such-line')
  refuses(BASE, -1, 'no-such-line')
  refuses(doc('Before any slide', '', '## A', '', '### B', 'text'), 'Before any slide', 'not-here')
  refuses(doc('## A', '', '### B', '- the set {a, b}'), '- the set', 'ends-in-braces')
  refuses(doc('## A', '', '### B', '- Thinking {brain}'), '- Thinking', 'ends-in-braces')
  refuses(doc('## A', '', '### B', 'Half <!-- a comment --> commented'), 'Half', 'not-here')
})
table('inside a carousel and inside cards', () => {
  sets(BASE, '- in the carousel', '- in the carousel {icon=lucide:star}', { kind: 'item' })
  sets(BASE, 'Text in the carousel', 'Text in the carousel {icon=lucide:star}', { kind: 'paragraph' })
  sets(BASE, '- Day: three', '- Day: three pounds {icon=lucide:star}', { kind: 'item' })
})
table('line endings', () => {
  const crlf = BASE.replace(/\n/g, '\r\n')
  const line = crlf.split('\n').findIndex((entry) => entry.startsWith('- Bikes that'))
  const result = setLineIcon(crlf, line, STAR, known)
  assert.ok(result.ok)
  assert.equal(result.text.split('\n')[line], '- Bikes that are there {icon=lucide:star}\r')
  assert.equal(result.text.replace(/\r\n/g, '\n'), setLineIcon(BASE, line, STAR, known).text, 'the same write as with line feeds')
  assert.equal(clearLineIcon(result.text, line).text, crlf)
  const heading = crlf.split('\n').findIndex((entry) => entry.startsWith('### What riders'))
  assert.equal(setLineIcon(crlf, heading, STAR, known).text.split('\n')[heading], '### What riders ask for {icon=lucide:star} {#s1 reveal}\r')
  // A lone carriage return is no line break for the compiler: the line that holds one is left alone.
  const lone = doc('## A', '', '### B', '- one\r- two', '- three')
  refuses(lone, '- one', 'line-ending')
  assert.ok(setLineIcon(lone, 4, STAR, known).ok, 'the row after it is written')
  // Trailing spaces stay after the token's place, as the compiler's verb leaves them.
  sets(doc('## A', '', '### B', 'Text with spaces  ', '', 'more'), 'Text with spaces', 'Text with spaces {icon=lucide:star}  ')
})
table('only keys of the icon set are written', () => {
  const line = BASE.split('\n').findIndex((entry) => entry.startsWith('- Bikes that'))
  for (const key of ['lucide:not-an-icon-at-all', 'star', 'lucide:star}', 'lucide:star} {cards', 'lucide:star\n## New', '', 'LUCIDE:STAR', 'lucide: star', null, undefined, 7]) {
    const result = setLineIcon(BASE, line, key, known)
    assert.deepEqual([result.ok, result.reason, result.text === BASE], [false, 'unknown-icon', true], `key ${JSON.stringify(key)}`)
  }
  assert.ok(ICON_KEY_RE.test(STAR))
  // `known` is asked: a well-formed key it does not know is refused.
  assert.equal(setLineIcon(BASE, line, 'svgl:github', known).reason, 'unknown-icon')
  assert.ok(setLineIcon(BASE, line, 'svgl:github', () => true).ok)
})
table('what Command-I finds on a line', () => {
  const at = (needle) => BASE.split('\n').findIndex((entry) => entry.includes(needle))
  assert.deepEqual(lineIconState(BASE, at('- A safe lane')), { ok: true, kind: 'item', key: 'lucide:route' })
  assert.deepEqual(lineIconState(BASE, at('- Bikes that')), { ok: true, kind: 'item', key: null })
  assert.deepEqual(lineIconState(BASE, at('Another one.')), { ok: true, kind: 'paragraph', key: 'lucide:sun' })
  assert.deepEqual(lineIconState(BASE, at('# Bike share')), { ok: true, kind: 'heading', key: null })
  assert.equal(iconLineAt(BASE, BASE.indexOf('- A safe lane') + 3), at('- A safe lane'))
  assert.equal(iconLineAt('a\r\nb\r\nc', 4), 1)
})
console.log('icon verbs: the table passed')

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

const GROUPS = ['{reveal}', '{#a1}', '{id=b_2 reveal}', '{cards}', '{iconlist}', '{carousel}', '{columns}', '{compare}', '{nostep}', '{statement}', '{icon=lucide:route}', '{reveal icon=lucide:zap}', '{icon=lucide:sun title-icon=above}', '{note="a, b"}', '{unknownword}']
const TEXTS = ['Alpha', 'Beta gamma', 'A longer line of plain words', 'Text with `code` in it', 'A link https://example.org/{x}', 'Ends in a brace \\{icon=x}', 'Colon: after', '**Bold claim**']
const TAILS = ['', '', '', '', ' {icon=lucide:sun}', ' {icon=lucide:zap}', ' {lucide:star}', ' {brain}', ' {a, b}', ' {icon=nope}', '  ', ' <!-- c -->', ' {icon=lucide:sun} <!-- c -->', '{icon=lucide:sun}', ' { icon = lucide:zap }']

function generator(seed) {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const text = () => pick(TEXTS) + pick(TAILS)
  const body = () => pick([
    () => [`- ${text()}`, `- ${text()}`, `- ${text()}`],
    () => [`- ${text()}`, `  - ${text()}`, `- ${text()}`, `    - ${text()}`],
    () => [`1. ${text()}`, `2. ${text()}`],
    () => [`- A: ${text()}`, `- B: ${text()}`],
    () => [text()],
    () => [pick(TEXTS), text()],
    () => [pick(TEXTS), pick(TEXTS), text(), '', text()],
    () => [`> ${text()}`, `— ${pick(TEXTS)}`],
    () => ['![x](a.png)', '', text()],
    () => ['```', `- ${text()}`, '```'],
    () => [pick(TEXTS), '```', text(), '```'],
    () => ['{chart=bar}', `- A: 1${pick(TAILS)}`, '- B: 2'],
    () => [':::notes', text(), ':::'],
    () => ['| a | b |', '|---|---|', `| 1 | ${text()} |`],
    () => [`* ${text()}`, '', pick(GROUPS), '', text()],
    () => [text(), pick(GROUPS), text()],
    () => []
  ])()
  const heading = (level) => `${'#'.repeat(level)} ${pick(TEXTS)}${random() < 0.45 ? ` ${Array.from({ length: int(1, 2) }, () => pick(GROUPS)).join(pick(['', ' ']))}` : ''}`
  return () => {
    const lines = []
    if (random() < 0.3) lines.push('---', 'title: Generated', ...(random() < 0.5 ? [pick(['triggers: reveal', 'triggers: iconlist', 'triggers: layout=cards'])] : []), '---')
    if (random() < 0.1) lines.push(text(), '')
    lines.push(`# Talk${random() < 0.3 ? ` ${pick(GROUPS)}` : ''}`, '', '## Part one', '')
    for (let k = int(2, 7); k > 0; k -= 1) {
      const level = random() < 0.12 ? 2 : random() < 0.75 ? 3 : 4
      lines.push(heading(level))
      if (random() < 0.3) lines.push(pick(GROUPS))
      if (random() < 0.3) lines.push('')
      lines.push(...body())
      if (random() < 0.35) lines.push('', ...body())
      if (random() < 0.8) lines.push('')
    }
    // Line endings: LF, CRLF (one document in eight), or mixed; now and then a lone carriage return in a line.
    const r = random()
    const eol = r < 0.125 ? () => '\r\n' : r < 0.2 ? () => (random() < 0.5 ? '\r\n' : '\n') : () => '\n'
    const written = lines.map((line) => (line && random() < 0.01 ? `${line.slice(0, 2)}\r${line.slice(2)}` : line))
    return { text: written.map((line, index) => (index + 1 < written.length || random() < 0.5 ? line + eol() : line)).join(''), random }
  }
}

const total = { documents: 0, lines: 0, set: 0, setNotDrawn: 0, replaced: 0, unchanged: 0, refused: 0, cleared: 0, clearedUndrawn: 0, clearRefused: 0, roundTrips: 0, crlfWrites: 0 }
const byKind = { heading: 0, paragraph: 0, item: 0 }
const drawn = { heading: 0, paragraph: 0, item: 0 }
const reasons = {}
const notDrawn = {}
const compilerAgrees = { paragraph: 0, heading: 0, headingNotDrawn: 0, paragraphOnlyCompiler: 0, headingOnlyCompiler: {} }
const started = Date.now()
for (const SEED of SEEDS) {
  const next = generator(SEED)
  for (let n = 0; n < DOCUMENTS; n += 1) {
    const { text, random } = next()
    const written = text.split('\n')
    total.documents += 1
    const fail = (message) => { console.error(`\nFAILED on document ${n + 1} of seed ${SEED} (reproduce: --seed=${SEED})\n${message}\n\n${written.map((line, i) => `${String(i).padStart(3)}  ${JSON.stringify(line)}`).join('\n')}`); process.exit(1) }
    for (let line = 0; line < written.length; line += 1) {
      const icon = `lucide:${NAMES[Math.floor(random() * NAMES.length)]}`
      total.lines += 1
      try {
        const state = lineIconState(text, line)
        const result = setLineIcon(text, line, icon, known)
        assert.equal(state.ok, result.ok, `line ${line}: lineIconState says ${state.ok ? 'it can' : state.reason}, setLineIcon ${result.ok ? 'wrote' : result.reason}`)
        const body = written[line].replace(/\r$/, '')
        const isTalkTitle = /^#\s/.test(body)
        if (!result.ok) {
          assert.equal(result.text, text, `line ${line}: refused, the text is unchanged`)
          assert.ok(result.reason && result.detail, `line ${line}: a reason`)
          reasons[result.reason] = (reasons[result.reason] ?? 0) + 1
          total.refused += 1
          // The compiler's own paragraph verb, where it would have written: counted, never a failure.
          if (/^[A-Za-z*]/.test(body)) { try { if (setParagraphIcon(text, line + 1, icon).changed) compilerAgrees.paragraphOnlyCompiler += 1 } catch { /* not a line it takes */ } }
          if (/^#{2,6}\s/.test(body) && state.reason !== 'not-here') {
            const occurrence = written.slice(0, line + 1).filter((entry) => entry.replace(/\r$/, '') === body).length
            try { if (setHeadingIcon(text, { heading: body, occurrence }, icon).changed) compilerAgrees.headingOnlyCompiler[result.reason] = (compilerAgrees.headingOnlyCompiler[result.reason] ?? 0) + 1 } catch { /* not found */ }
          }
        } else if (!result.changed) {
          assert.equal(result.text, text)
          total.unchanged += 1
        } else {
          total.set += 1
          byKind[result.kind] += 1
          if (state.key) total.replaced += 1
          if (written[result.line].endsWith('\r')) total.crlfWrites += 1
          oneLineChanged(text, result.text, result.line)
          assert.equal(result.text, text.slice(0, result.change.from) + result.change.insert + text.slice(result.change.to), `line ${line}: the change is the write`)
          assert.ok(result.text.split('\n')[result.line].includes(`icon=${icon}`), `line ${line}: the token is on line ${result.line}`)
          const wrong = compiledIconChange(text, result.text, line, icon, isTalkTitle)
          // The compiler consumed the token and the slide's layout draws no icon there (a chart's
          // rows, a panel of a comparison): the compiled talk is the same. Counted by layout.
          if (wrong === SAME) {
            const slides = compile(text)
            const key = `${result.kind} in ${slides[slideIndexOf(slides, line)]?.layout}`
            notDrawn[key] = (notDrawn[key] ?? 0) + 1
            total.setNotDrawn += 1
          } else {
            assert.equal(wrong, null, `line ${line} (${result.kind}, written on ${result.line}): ${wrong}`)
            drawn[result.kind] += 1
          }
          assert.deepEqual(lineIconState(result.text, line), { ok: true, kind: result.kind, key: icon }, `line ${line}: the line now reports the icon`)
          // The compiler's own verbs write the same text.
          if (result.kind === 'paragraph' && !state.key) {
            const theirs = setParagraphIcon(text, line + 1, icon)
            assert.ok(theirs.ok, `line ${line}: the compiler's setParagraphIcon refuses (${theirs.reason})`)
            assert.equal(theirs.text, result.text, `line ${line}: the compiler's setParagraphIcon writes the same`)
            compilerAgrees.paragraph += 1
          }
          if (result.kind === 'heading' && !isTalkTitle) {
            const occurrence = written.slice(0, line + 1).filter((entry) => entry.replace(/\r$/, '') === body).length
            const theirs = setHeadingIcon(text, { heading: body, occurrence }, icon)
            if (theirs.ok) { assert.equal(theirs.text, result.text, `line ${line}: the compiler's setHeadingIcon writes the same`); compilerAgrees.heading += 1 }
            else { assert.equal(theirs.reason, 'title-not-shown', `line ${line}: the compiler's setHeadingIcon refuses (${theirs.reason})`); compilerAgrees.headingNotDrawn += 1 }
          }
          if (!state.key) {
            const back = clearLineIcon(result.text, line)
            assert.ok(back.ok, `line ${line}: clear after set is refused (${back.reason})`)
            assert.equal(back.text, text, `line ${line}: clear after set gives back the original`)
            total.roundTrips += 1
          }
        }
        // Remove, on a line that carries an icon.
        if (state.ok && state.key) {
          const gone = clearLineIcon(text, line)
          if (!gone.ok) { assert.equal(gone.text, text); total.clearRefused += 1; reasons[`clear: ${gone.reason}`] = (reasons[`clear: ${gone.reason}`] ?? 0) + 1 }
          else {
            total.cleared += 1
            oneLineChanged(text, gone.text, gone.line)
            // A token whose name is in no icon set draws nothing: without it the compiled talk is the same.
            const wrong = compiledIconChange(text, gone.text, line, null, isTalkTitle)
            if (wrong === SAME && !known(state.key)) total.clearedUndrawn += 1
            else if (wrong === SAME) {
              const slides = compile(text)
              const key = `clear ${gone.kind} in ${slides[slideIndexOf(slides, line)]?.layout}`
              notDrawn[key] = (notDrawn[key] ?? 0) + 1
            }
            else assert.equal(wrong, null, `clear line ${line}: ${wrong}`)
            assert.equal(lineIconState(gone.text, line).key ?? null, null, `clear line ${line}: no icon is reported`)
          }
        }
      } catch (error) {
        fail(`line ${line} ${JSON.stringify(written[line])}, icon ${icon}\n${error?.message ?? error}`)
      }
    }
  }
}

console.log(`icon verbs, generated: ${total.documents} documents, ${total.lines} lines, seeds ${SEEDS.join(', ')} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
console.log(`  set: ${total.set} successes checked against the real compiler (${byKind.heading} titles, ${byKind.paragraph} paragraphs, ${byKind.item} list items; ${total.replaced} replaced an icon; ${total.crlfWrites} on a CRLF line)`)
console.log(`    the compiled slide shows the icon and nothing else changed: ${total.set - total.setNotDrawn} (${drawn.heading} titles, ${drawn.paragraph} paragraphs, ${drawn.item} list items)`)
console.log(`    the token is consumed and the compiled talk is the same (the slide's layout draws no icon there): ${total.setNotDrawn}  ${JSON.stringify(notDrawn)}`)
console.log(`  set then clear gave back the original: ${total.roundTrips}; already that icon: ${total.unchanged}`)
console.log(`  clear: ${total.cleared} successes checked against the real compiler (${total.clearedUndrawn} of a token that drew nothing), ${total.clearRefused} refused`)
console.log(`  refused with the text unchanged: ${total.refused}`)
for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${reason}: ${count}`)
console.log(`  the compiler's own verbs wrote the same text: ${compilerAgrees.paragraph} paragraphs, ${compilerAgrees.heading} titles (${compilerAgrees.headingNotDrawn} titles it refuses as not shown)`)
console.log(`  refused here, written by the compiler's verb: ${compilerAgrees.paragraphOnlyCompiler} paragraphs; titles by reason ${JSON.stringify(compilerAgrees.headingOnlyCompiler)}`)
assert.ok(total.set > 0 && drawn.heading > 0 && drawn.paragraph > 0 && drawn.item > 0, 'no successes were checked')
assert.ok(total.setNotDrawn * 10 < total.set, 'more than one write in ten draws nothing')
assert.ok(total.refused > 0 && total.cleared > 0 && total.roundTrips > 0 && total.replaced > 0 && total.crlfWrites > 0, 'a kind of case was never checked')
console.log('icon verbs: passed')
