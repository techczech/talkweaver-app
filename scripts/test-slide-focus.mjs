// Tests for the Slide Focus pure model (src/renderer/src/components/slideFocusModel.ts).
// Imports the REAL module — Node ≥23.6 strips erasable TypeScript natively — so these can't drift
// from the shipped helpers. Everything here is pure (no CodeMirror/DOM), so it runs headless.
import {
  slideBlockBounds, focusRangeForSlideLine, extractSlideBlock, slideRefForLine,
  slideIdOf, isFocusable, nextFocusableSlide, firstFocusableFrom, paneFootState,
  readableSectionLabel
} from '../src/renderer/src/components/slideFocusModel.ts'

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }
const eq = (a, b, m) => ck(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}`)

// Fixture: frontmatter + section + three slides, matching the focus-scope harness shape. Line
// numbers are 1-based; blank line 6, 11, 16, and trailing 21 are the boundaries.
const LINES = [
  '---',                        // 1
  'title: FS Fixture',          // 2
  '---',                        // 3
  '',                           // 4
  '## Section',                 // 5
  '',                           // 6
  '### Slide One',              // 7
  '{statement}{id=aaa111}',     // 8
  '',                           // 9
  'Body of slide one alpha.',   // 10
  '',                           // 11
  '### Slide Two',              // 12
  '{cards}{id=bbb222}',         // 13
  '',                           // 14
  'Body of slide two beta.',    // 15
  '',                           // 16
  '### Slide Three',            // 17
  '{plain}{id=ccc333}',         // 18
  '',                           // 19
  'Body of slide three gamma.', // 20
  ''                            // 21
]
const FIX = LINES.join('\n')

// ── slideBlockBounds: block runs heading→next heading, trailing blanks trimmed ──
{
  const b = slideBlockBounds(FIX, 12) // ### Slide Two
  ck(b !== null, 'bounds: Slide Two resolves')
  // from = start of line 12; slice should be exactly the block text with no trailing blank.
  const slice = FIX.slice(b.from, b.to)
  eq(slice, '### Slide Two\n{cards}{id=bbb222}\n\nBody of slide two beta.', 'bounds: Slide Two block slice')
  ck(b.startLine === 12 && b.endLine === 15, 'bounds: Slide Two start/end lines (trailing blank 16 excluded)')
  // The `to` offset lands where the focus-scope harness put RANGE_TO (end of the body text).
  ck(b.to === FIX.indexOf('Body of slide two beta.') + 'Body of slide two beta.'.length, 'bounds: to == end of body content')
  ck(b.from === FIX.indexOf('### Slide Two'), 'bounds: from == start of heading')
}

// last slide runs to EOF (trailing blank line 21 trimmed off)
{
  const b = slideBlockBounds(FIX, 17)
  eq(FIX.slice(b.from, b.to), '### Slide Three\n{plain}{id=ccc333}\n\nBody of slide three gamma.', 'bounds: last slide to EOF, trailing blank trimmed')
}

// heading-only block (no body): a lone heading followed immediately by another heading
{
  const HO = '### A\n### B\nbody b\n'
  const b = slideBlockBounds(HO, 1)
  eq(HO.slice(b.from, b.to), '### A', 'bounds: heading-only block is just the heading line')
}

// null / out-of-range / non-heading line → null
ck(slideBlockBounds(FIX, null) === null, 'bounds: null line → null')
ck(slideBlockBounds(FIX, 0) === null, 'bounds: line 0 → null')
ck(slideBlockBounds(FIX, 999) === null, 'bounds: past EOF → null')
ck(slideBlockBounds(FIX, 15) === null, 'bounds: a body line is not a heading → null')
ck(slideBlockBounds(FIX, 5) !== null, 'bounds: a ## section heading IS a block boundary (resolves)')

// ── focusRangeForSlideLine mirrors bounds {from,to} ──
{
  const r = focusRangeForSlideLine(FIX, 12)
  const b = slideBlockBounds(FIX, 12)
  eq(r, { from: b.from, to: b.to }, 'range: equals bounds from/to')
  ck(focusRangeForSlideLine(FIX, null) === null, 'range: null line → null')
}

// ── extractSlideBlock ──
eq(extractSlideBlock(FIX, 7), '### Slide One\n{statement}{id=aaa111}\n\nBody of slide one alpha.', 'extract: Slide One block')
ck(extractSlideBlock(FIX, null) === '', 'extract: null → empty string')

// ── slideRefForLine: verbatim heading line + occurrence among identical lines ──
eq(slideRefForLine(FIX, 12), { heading: '### Slide Two', occurrence: 1 }, 'ref: verbatim heading + occurrence 1')
{
  const DUP = '### New slide\nbody 1\n\n### New slide\nbody 2\n'
  eq(slideRefForLine(DUP, 1), { heading: '### New slide', occurrence: 1 }, 'ref: first duplicate heading → occurrence 1')
  eq(slideRefForLine(DUP, 4), { heading: '### New slide', occurrence: 2 }, 'ref: second duplicate heading → occurrence 2')
}
ck(slideRefForLine(FIX, 15) === null, 'ref: body line → null')
ck(slideRefForLine(FIX, null) === null, 'ref: null line → null')

// ── slideIdOf: reads {id=…} from heading or Trigger line, null when unstamped ──
ck(slideIdOf(extractSlideBlock(FIX, 12)) === 'bbb222', 'id: reads {id=…} from the Trigger line')
ck(slideIdOf('### Fresh slide\n\n- a bullet\n') === null, 'id: unstamped slide → null')
ck(slideIdOf('### Heading {id=xyz999}\n\nbody\n') === 'xyz999', 'id: reads {id=…} straight off the heading')
ck(slideIdOf('') === null, 'id: empty block → null')
ck(slideIdOf(null) === null, 'id: null → null')

// ── isFocusable / nextFocusableSlide / firstFocusableFrom over a compiled slideLines array ──
// index:      0     1    2     3    4      (2 & 4 are synthesized cover/section rows → null)
const SL = [7, 12, null, 17, null]
ck(isFocusable(SL, 0) === true, 'focusable: content slide is focusable')
ck(isFocusable(SL, 2) === false, 'focusable: synthesized row is not focusable')
ck(isFocusable(SL, 9) === false, 'focusable: out-of-range is not focusable')

ck(nextFocusableSlide(SL, 0, 1) === 1, 'next: forward from 0 → 1')
ck(nextFocusableSlide(SL, 1, 1) === 3, 'next: forward skips the synthesized row (1 → 3)')
ck(nextFocusableSlide(SL, 3, 1) === 0, 'next: forward wraps past trailing synthesized row (3 → 0)')
ck(nextFocusableSlide(SL, 1, -1) === 0, 'next: backward from 1 → 0')
ck(nextFocusableSlide(SL, 0, -1) === 3, 'next: backward wraps to the last focusable (0 → 3)')
ck(nextFocusableSlide([12, null, null], 0, 1) === 0, 'next: single focusable slide stays put')
ck(nextFocusableSlide([], 0, 1) === 0, 'next: empty slideLines stays put')

ck(firstFocusableFrom(SL, 2) === 3, 'first: from a synthesized row lands on the next focusable')
ck(firstFocusableFrom(SL, 0) === 0, 'first: an already-focusable index returns itself')
ck(firstFocusableFrom([null, null], 0) === null, 'first: no focusable slide → null')

// ── paneFootState copy ──
{
  const ok = paneFootState(true)
  ck(ok.tone === 'ok' && ok.text.startsWith('Compiled'), 'foot: stamped → green Compiled line')
  const dirty = paneFootState(false)
  ck(dirty.tone === 'dirty' && dirty.text.startsWith('Unsaved'), 'foot: unstamped → amber Unsaved line')
}

// ── readableSectionLabel: prefer the section-title row, else de-slug ──
{
  const rows = [
    { role: 'opening', section: '' },
    { role: 'section-title', nav_title: 'What is actually an agent?', section: 'what-is-actually-an-agent' },
    { role: 'content', section: 'what-is-actually-an-agent' },
    { role: 'content', section: 'what-is-actually-an-agent' }
  ]
  ck(readableSectionLabel(rows, 2) === 'What is actually an agent?', 'section: prefers the preceding section-title row title')
  ck(readableSectionLabel(rows, 1) === 'What is actually an agent?', 'section: the section-title row uses its own title')
  // No section-title row → de-slug the slug section.
  const noTitle = [{ role: 'content', section: 'historical-context' }]
  ck(readableSectionLabel(noTitle, 0) === 'historical context', 'section: de-slugs when no section-title row')
  // Already-readable section (has spaces) is left intact.
  ck(readableSectionLabel([{ role: 'content', section: 'Deep dive' }], 0) === 'Deep dive', 'section: readable section left intact')
  ck(readableSectionLabel(null, 0) === '', 'section: null rows → empty')
  ck(readableSectionLabel([], 0) === '', 'section: empty rows → empty')
}

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('test-slide-focus: all checks passed')
