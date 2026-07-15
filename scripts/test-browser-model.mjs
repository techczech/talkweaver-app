// Tests for the Slide Browser's pure model (src/renderer/src/components/slideBrowserModel.ts).
// Imports the REAL module — Node ≥23.6 strips erasable TypeScript natively — so unlike the
// older mirror-style logic guards this cannot drift from the shipped code.
import {
  selRowKey, rangeKeys, sectionKeysAt, isSingleTalk, groupBySection,
  layoutOf, isIconSlide, isTitleOnly, sectionKey,
  emptyFilters, anyFilterActive, filterRows, groupByTalkSection, gridNavigate, sectionNamesByKey,
  stripAnchorPercent, canonicalVersion, versionBadgeParts, versionBadgeLabel, stampedIdOf,
  propagationSummaryLabel, splitDiffColumns,
  clusterRows, identityCanon, mergeTargetsFromCluster,
  clusterAlreadyOneSlide, clusterMergeable, buildDisplayModel,
  inTalksLabel, nearCountLabel, mergeConfirmTitle, mergeNudgeLabel, mergeSuccessLabel, joinTalkNames,
  parseSearchQuery, rankBySearch, scopeNoun
} from '../src/renderer/src/components/slideBrowserModel.ts'

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }
const eq = (a, b, m) => ck(JSON.stringify(a) === JSON.stringify(b), `${m} — got ${JSON.stringify(a)}`)

/* ---------- moved selection helpers still behave (regression) ---------- */
const selRows = [
  { talkSlug: 'a', slide_id: 's0', section: 'Intro' },
  { talkSlug: 'a', slide_id: 's1', section: 'Intro' },
  { talkSlug: 'a', slide_id: 's2', section: 'Body' },
  { talkSlug: 'a', slide_id: 's3', section: 'Body' }
]
ck(selRowKey(selRows, 1) === 'a:s1', 'selRowKey uses slide_id')
ck(selRowKey([{ talkSlug: 'a' }], 0) === 'a:0', 'selRowKey falls back to index')
eq(rangeKeys(selRows, 3, 1), ['a:s1', 'a:s2', 'a:s3'], 'rangeKeys reversed = same range')
eq(sectionKeysAt(selRows, 2), ['a:s2', 'a:s3'], 'sectionKeysAt Body')
ck(isSingleTalk(selRows) === true, 'isSingleTalk true')
ck(isSingleTalk([...selRows, { talkSlug: 'b' }]) === false, 'isSingleTalk false across talks')
const gs = groupBySection(selRows)
ck(gs.length === 2 && gs[0].section === 'Intro' && gs[1].section === 'Body', 'groupBySection order')

/* ---------- fixture rows for filterRows ---------- */
const NOW = 1_760_000_000_000
const DAY = 86400000
const rows = [
  { talkSlug: 'ai2026', talkTitle: 'AI 2026', section: 'Where we are', subsection: '', slide_id: 'x1',
    layout: 'statement', triggers: {}, source_markdown: '### Agents are loops\n', image_count: 0,
    bullet_count: 0, word_count: 9, talkMeta: 'audience: it-pros', talkMtimeMs: NOW - 2 * DAY },
  { talkSlug: 'ai2026', talkTitle: 'AI 2026', section: 'Agents', subsection: 'Anatomy', slide_id: 'x2',
    layout: '', triggers: { layout: 'iconrow' }, source_markdown: '### Anatomy\n', image_count: 0,
    bullet_count: 4, word_count: 22, talkMeta: 'audience: it-pros', talkMtimeMs: NOW - 2 * DAY },
  { talkSlug: 'claw', talkTitle: 'The Age of the Claw', section: 'Claws', subsection: '', slide_id: 'x3',
    layout: 'image', triggers: {}, source_markdown: '### The claw\n![](img-1)\n', image_count: 1,
    bullet_count: 0, word_count: 12, talkMeta: 'keynote', talkMtimeMs: NOW - 40 * DAY },
  // A section divider: the compiler carries this on `role` (derived from isSection); the
  // `section-title` LAYOUT is no longer emitted for content-bearing dividers (heading-is-slide model).
  { talkSlug: 'claw', talkTitle: 'The Age of the Claw', section: 'Claws', subsection: '', slide_id: 'x4',
    layout: '', role: 'section-title', triggers: {}, source_markdown: '## Claws\n', image_count: 0,
    bullet_count: 0, word_count: 1, talkMeta: 'keynote', talkMtimeMs: NOW - 40 * DAY },
  { talkSlug: 'meta', talkTitle: 'Metaphors', section: 'Frames', subsection: '', slide_id: 'x5',
    layout: 'default', triggers: {}, source_markdown: '### Frames {icon=box}\n- a\n', image_count: 0,
    bullet_count: 1, word_count: 15, talkMeta: '', talkMtimeMs: NOW - 100 * DAY }
]
const folders = new Map([['ai2026', 'training'], ['claw', 'keynotes'], ['meta', 'training']])
const ids = (out) => out.map((r) => r.slide_id)
const F = emptyFilters

/* ---------- predicates ---------- */
ck(layoutOf(rows[1]) === 'iconrow', 'layoutOf prefers triggers.layout')
ck(layoutOf(rows[0]) === 'statement', 'layoutOf falls back to layout')
ck(isIconSlide(rows[1]) === true, 'isIconSlide via layout')
ck(isIconSlide(rows[4]) === true, 'isIconSlide via {icon=} token')
ck(isIconSlide(rows[2]) === false, 'isIconSlide false')
ck(isTitleOnly(rows[3]) === true, 'isTitleOnly section role')
ck(isTitleOnly(rows[1]) === false, 'isTitleOnly false with bullets')

/* ---------- filterRows: each filter ---------- */
eq(ids(filterRows(rows, F(), folders, NOW)), ['x1', 'x2', 'x3', 'x4', 'x5'], 'no filters = all rows')
eq(ids(filterRows(rows, { ...F(), folderQ: 'keynote' }, folders, NOW)), ['x3', 'x4'], 'folderQ substring')
eq(ids(filterRows(rows, { ...F(), talkSet: new Set(['claw']) }, folders, NOW)), ['x3', 'x4'], 'talkSet single')
eq(ids(filterRows(rows, { ...F(), talkSet: new Set(['claw', 'meta']) }, folders, NOW)), ['x3', 'x4', 'x5'], 'talkSet multi (OR)')
eq(ids(filterRows(rows, { ...F(), sectionQ: 'anatomy' }, folders, NOW)), ['x2'], 'sectionQ matches subsection too')
eq(ids(filterRows(rows, { ...F(), sectionSet: new Set([sectionKey('claw', 'Claws')]) }, folders, NOW)), ['x3', 'x4'], 'sectionSet exact talk+section')
eq(ids(filterRows(rows, { ...F(), sectionSet: new Set([sectionKey('ai2026', 'Claws')]) }, folders, NOW)), [], 'sectionSet is per-talk (no cross-talk match)')
eq(ids(filterRows(rows, { ...F(), metaQ: 'it-pros' }, folders, NOW)), ['x1', 'x2'], 'metaQ substring')
eq(ids(filterRows(rows, { ...F(), layoutSet: new Set(['statement', 'image']) }, folders, NOW)), ['x1', 'x3'], 'layoutSet multi (OR)')
eq(ids(filterRows(rows, { ...F(), hasImage: true }, folders, NOW)), ['x3'], 'hasImage')
eq(ids(filterRows(rows, { ...F(), hasIcons: true }, folders, NOW)), ['x2', 'x5'], 'hasIcons (layout + token)')
eq(ids(filterRows(rows, { ...F(), excludeSections: true }, folders, NOW)), ['x1', 'x2', 'x3', 'x5'], 'excludeSections drops dividers')
eq(ids(filterRows(rows, { ...F(), excludeTitleOnly: true }, folders, NOW)), ['x1', 'x2', 'x3', 'x5'], 'excludeTitleOnly (x1 word_count 9 stays)')
eq(ids(filterRows(rows, { ...F(), modifiedDays: 7 }, folders, NOW)), ['x1', 'x2'], 'modifiedDays 7 window')
eq(ids(filterRows(rows, { ...F(), modifiedDays: 60 }, folders, NOW)), ['x1', 'x2', 'x3', 'x4'], 'modifiedDays 60 window')
eq(ids(filterRows(rows, { ...F(), talkSet: new Set(['claw']), hasImage: true }, folders, NOW)), ['x3'], 'filters combine (AND)')

/* ---------- anyFilterActive ---------- */
ck(anyFilterActive(F()) === false, 'anyFilterActive false when empty')
ck(anyFilterActive({ ...F(), hasImage: true }) === true, 'anyFilterActive boolean')
ck(anyFilterActive({ ...F(), talkSet: new Set(['a']) }) === true, 'anyFilterActive set')
ck(anyFilterActive({ ...F(), folderQ: '  ' }) === false, 'anyFilterActive ignores whitespace-only query')

/* ---------- groupByTalkSection: first-appearance order ---------- */
const interleaved = [rows[0], rows[2], rows[1], rows[3], rows[4]] // ai§Where, claw§Claws, ai§Agents, claw§Claws, meta§Frames
const groups = groupByTalkSection(interleaved)
eq(groups.map((g) => `${g.talkSlug}·${g.section}`),
  ['ai2026·Where we are', 'claw·Claws', 'ai2026·Agents', 'meta·Frames'],
  'groupByTalkSection first-appearance order')
eq(groups[1].indices, [1, 3], 'group indices point into the filtered rows')
ck(groups[0].talkTitle === 'AI 2026', 'group carries talkTitle')

/* ---------- sectionNamesByKey: slug → authored display name ---------- */
const named = sectionNamesByKey([
  { talkSlug: 'ai2026', section: 'deep-dive', role: 'section-title', nav_title: 'Deep dive', title: 'Deep dive' },
  { talkSlug: 'ai2026', section: 'deep-dive', role: 'content', nav_title: 'Numbers' },
  { talkSlug: 'claw', section: 'deep-dive', role: 'section-title', title: 'A different deep dive' }
])
ck(named.get(sectionKey('ai2026', 'deep-dive')) === 'Deep dive', 'sectionNamesByKey maps slug to authored name')
ck(named.get(sectionKey('claw', 'deep-dive')) === 'A different deep dive', 'sectionNamesByKey is per-talk')
ck(named.size === 2, 'sectionNamesByKey ignores content rows')

/* ---------- gridNavigate edges ---------- */
// 3 columns, 8 cards: rows are [0 1 2] [3 4 5] [6 7]
ck(gridNavigate(4, 'ArrowLeft', 3, 8) === 3, '← steps -1')
ck(gridNavigate(4, 'ArrowRight', 3, 8) === 5, '→ steps +1')
ck(gridNavigate(2, 'ArrowRight', 3, 8) === 3, '→ flows across a row edge')
ck(gridNavigate(3, 'ArrowLeft', 3, 8) === 2, '← flows back across a row edge')
ck(gridNavigate(0, 'ArrowLeft', 3, 8) === 0, '← clamps at the first card')
ck(gridNavigate(7, 'ArrowRight', 3, 8) === 7, '→ clamps at the last card')
ck(gridNavigate(4, 'ArrowUp', 3, 8) === 1, '↑ steps -columns')
ck(gridNavigate(1, 'ArrowUp', 3, 8) === 1, '↑ on the top row stays put')
ck(gridNavigate(1, 'ArrowDown', 3, 8) === 4, '↓ steps +columns')
ck(gridNavigate(5, 'ArrowDown', 3, 8) === 7, '↓ off the bottom edge clamps to the last card')
ck(gridNavigate(7, 'ArrowDown', 3, 8) === 7, '↓ on the last card stays')
ck(gridNavigate(0, 'ArrowDown', 2, 1) === 0, 'single card is stable')
ck(gridNavigate(0, 'ArrowDown', 6, 0) === 0, 'empty grid returns 0')
// densities 2–6 up/down stay column-aligned
for (const cols of [2, 3, 4, 5, 6]) {
  ck(gridNavigate(cols + 1, 'ArrowUp', cols, cols * 3) === 1, `↑ column-aligned at g${cols}`)
  ck(gridNavigate(1, 'ArrowDown', cols, cols * 3) === cols + 1, `↓ column-aligned at g${cols}`)
}

/* ---------- stripAnchorPercent: filmstrip anchor caret (Task 6) ---------- */
const near = (a, b, m) => ck(Math.abs(a - b) < 1e-9, `${m} — got ${a}`)
near(stripAnchorPercent(0, 2), 25, 'anchor: first of 2 columns')
near(stripAnchorPercent(1, 2), 75, 'anchor: last of 2 columns')
near(stripAnchorPercent(0, 3), 100 / 6, 'anchor: first of 3 columns')
near(stripAnchorPercent(1, 3), 50, 'anchor: middle of 3 columns')
near(stripAnchorPercent(2, 3), 500 / 6, 'anchor: last of 3 columns')
near(stripAnchorPercent(0, 4), 12.5, 'anchor: first of 4 columns')
near(stripAnchorPercent(3, 4), 87.5, 'anchor: last of 4 columns')
near(stripAnchorPercent(2, 5), 50, 'anchor: centre of 5 columns')
near(stripAnchorPercent(0, 6), 100 / 12, 'anchor: first of 6 columns')
near(stripAnchorPercent(5, 6), 1100 / 12, 'anchor: last of 6 columns')
near(stripAnchorPercent(9, 3), 500 / 6, 'anchor clamps past the last column')
near(stripAnchorPercent(-1, 3), 100 / 6, 'anchor clamps below the first column')
near(stripAnchorPercent(0, 0), 50, 'anchor degenerates to centre with zero columns')

/* ---------- canonicalVersion: newest sealed wins, else head ---------- */
const v = (file, sealed) => ({ file, sealed })
eq(canonicalVersion([v('c', false), v('b', true), v('a', true)])?.file, 'b',
  'canonical: newest SEALED version wins over an unsealed head')
eq(canonicalVersion([v('c', true), v('b', false), v('a', true)])?.file, 'c',
  'canonical: sealed head is canonical')
eq(canonicalVersion([v('c', false), v('b', false)])?.file, 'c',
  'canonical: no sealed version → head')
ck(canonicalVersion([]) === null, 'canonical: empty list → null')

/* ---------- versionBadgeParts / versionBadgeLabel ---------- */
eq(versionBadgeParts(4, 3), { base: '4 versions', long: ' · 3 talks' }, 'badge parts: versions + talks')
eq(versionBadgeParts(2, 1), { base: '2 versions', long: '' }, 'badge parts: single talk hides the talks span')
eq(versionBadgeParts(1, 1), { base: '1 version', long: '' }, 'badge parts: singular version')
ck(versionBadgeParts(0, 3) === null, 'badge parts: zero versions → null')
ck(versionBadgeLabel(4, 3) === '4 versions · 3 talks', 'badge label: full')
ck(versionBadgeLabel(2, 1) === '2 versions', 'badge label: no talks suffix')
ck(versionBadgeLabel(0, 0) === null, 'badge label: null when no versions')

/* ---------- stampedIdOf: ledger id from the heading or Trigger line only ---------- */
ck(stampedIdOf('### Pricing {id=ab1_c}\n\nBody') === 'ab1_c', 'stampedIdOf reads the heading token')
ck(stampedIdOf('### Pricing\n{statement} {id=x9-2z}\n\nBody') === 'x9-2z', 'stampedIdOf reads the Trigger line')
ck(stampedIdOf('### Pricing\n\nBody with {id=nope} deeper down') === null, 'stampedIdOf ignores ids in the body')
ck(stampedIdOf('### Pricing\n{statement}\n') === null, 'stampedIdOf null when unstamped')
ck(stampedIdOf(undefined) === null, 'stampedIdOf null on missing markdown')

/* ---------- propagationSummaryLabel: the checklist confirm button (Task 7) ---------- */
ck(propagationSummaryLabel(2, 1) === 'Replace in 2 presentations · skip 1', 'summary: plural replace + skip')
ck(propagationSummaryLabel(1, 0) === 'Replace in 1 presentation', 'summary: singular replace, no skip suffix')
ck(propagationSummaryLabel(1, 2) === 'Replace in 1 presentation · skip 2', 'summary: singular replace + skip')
ck(propagationSummaryLabel(0, 1) === 'Nothing to replace · skip 1', 'summary: N=0 reads Nothing to replace')
ck(propagationSummaryLabel(0, 3) === 'Nothing to replace · skip 3', 'summary: N=0 with several skips')
ck(propagationSummaryLabel(0, 0) === 'Nothing to replace', 'summary: nothing at all')
ck(propagationSummaryLabel(3, 0) === 'Replace in 3 presentations', 'summary: plural replace only')

/* ---------- splitDiffColumns: two-column drawer feed (Task 7) ---------- */
const diff = [
  { kind: 'same', text: '## Agents' },
  { kind: 'del', text: '- old line' },
  { kind: 'add', text: '- new line' },
  { kind: 'same', text: '- kept' },
  { kind: 'add', text: '- appended' }
]
const cols = splitDiffColumns(diff)
eq(cols.left, [
  { kind: 'same', text: '## Agents' },
  { kind: 'del', text: '- old line' },
  { kind: 'same', text: '- kept' }
], 'splitDiffColumns left = same + del, order preserved')
eq(cols.right, [
  { kind: 'same', text: '## Agents' },
  { kind: 'add', text: '- new line' },
  { kind: 'same', text: '- kept' },
  { kind: 'add', text: '- appended' }
], 'splitDiffColumns right = same + add, order preserved')
eq(splitDiffColumns([]), { left: [], right: [] }, 'splitDiffColumns empty diff')
eq(splitDiffColumns([{ kind: 'del', text: 'x' }]), { left: [{ kind: 'del', text: 'x' }], right: [] },
  'splitDiffColumns pure deletion leaves the right column empty')

/* ---------- identityCanon: the ENGINE identity mirror (15-slide-merge.mjs identityKey) ---------- */
ck(identityCanon('### Pricing\n- a') === '### Pricing\n- a', 'identityCanon: a plain block is verbatim')
ck(identityCanon('### Pricing {id=ab12c}\n- a') === '### Pricing\n- a', 'identityCanon: a heading id is stripped')
ck(identityCanon('### Pricing\n{statement} {id=x9}\n- a') === '### Pricing\n{statement}\n- a', 'identityCanon: an id in a trigger group leaves the trigger')
ck(identityCanon('### Pricing\n{id=lonely}\n- a') === '### Pricing\n- a', 'identityCanon: a lone-id trigger line drops entirely')
ck(identityCanon('## Pricing\n- a') === '### Pricing\n- a', 'identityCanon: normalizeDepth re-levels the root heading to ###')
ck(identityCanon('### x\n- a\n\n') === identityCanon('### x\n- a'), 'identityCanon: trailing newlines stripped')
ck(identityCanon('### One\n- x') !== identityCanon('### one\n- x'), 'identityCanon: PRESERVES case (unlike content_hash)')
ck(identityCanon('### x\n- **b**') !== identityCanon('### x\n- b'), 'identityCanon: PRESERVES inline markdown (unlike content_hash)')

/* ---------- clusterRows: keyed on ENGINE identity, not content_hash (Task 9 fix) ---------- */
const cr = (hash, md, talk, outline) => ({
  content_hash: hash, source_markdown: md, talkSlug: talk, outlinePath: outline
})
// A byte-identical pair (t1,t2 — same identityCanon → IDENTICAL/mergeable); a NEAR pair (t3,t4 —
// SAME content_hash 'HN' but sources differ in case → different identityCanon → NEAR, no merge); one
// true single. Interleaved so first-appearance ordering is exercised.
const cRows = [
  cr('H1', '### Pricing\n- a\n- b', 't1', 't1/t1-outline.md'),
  cr('HN', '### Note\n- One point', 't3', 't3/t3-outline.md'),
  cr('H1', '### Pricing\n- a\n- b', 't2', 't2/t2-outline.md'),
  cr('HN', '### Note\n- one point', 't4', 't4/t4-outline.md'),
  cr('H5', '### Unique\n- solo', 't5', 't5/t5-outline.md')
]
const clusters = clusterRows(cRows)
eq(clusters.map((c) => c.kind), ['identical', 'near', 'single'], 'clusterRows: kinds in first-appearance order')
ck(clusters[0].kind === 'identical' && clusters[0].count === 2, 'identical cluster count 2')
eq(clusters[0].rows.map((r) => r.talkSlug), ['t1', 't2'], 'identical cluster keeps row order')
eq(clusters[0].talks, ['t1', 't2'], 'identical cluster lists distinct talks')
ck(clusters[0].key === '### Pricing\n- a\n- b', 'identical cluster keyed by identityCanon (engine identity)')
ck(clusters[1].kind === 'near' && clusters[1].count === 2, 'near cluster count 2')
ck(clusters[1].key === 'HN', 'near cluster keyed by the SHARED content_hash')
eq(clusters[1].rows.map((r) => r.talkSlug), ['t3', 't4'], 'near cluster keeps row order')
eq(clusters[2].rows.map((r) => r.talkSlug), ['t5'], 'the loner is a single')

/* two rows with the SAME content_hash but DIFFERENT identityCanon → near, not identical, not mergeable */
ck(!clusterMergeable(clusters[1]), 'a near cluster is never mergeable')
eq(mergeTargetsFromCluster(clusters[1]), [], 'a near cluster yields no merge targets')

/* a truly byte-identical pair → identical + mergeable */
const truePair = clusterRows([
  cr('HH', '### Same\n- x', 'ta', 'ta/o.md'), cr('HH', '### Same\n- x', 'tb', 'tb/o.md')
])[0]
ck(truePair.kind === 'identical' && clusterMergeable(truePair), 'a byte-identical pair is identical + mergeable')

/* identity wins over near: a content_hash-mate of the identical rows, ALONE, is a single (not near) */
const cRows2 = [
  cr('H1', '### Pricing\n- a\n- b', 't1', 't1/t1-outline.md'),
  cr('H1', '### pricing\n- a\n- b', 't9', 't9/t9-outline.md'), // same content_hash, DIFFERENT identityCanon (case)
  cr('H1', '### Pricing\n- a\n- b', 't2', 't2/t2-outline.md')
]
const clusters2 = clusterRows(cRows2)
eq(clusters2.map((c) => c.kind), ['identical', 'single'], 'identity wins: the engine-identical pair claims first; the lone case-variant is a single, not near')
eq(clusters2[0].rows.map((r) => r.talkSlug), ['t1', 't2'], 'identical cluster unaffected by the content_hash-mate')

/* TWO content_hash-mates that are not engine-identical DO form a near cluster alongside the identical one */
const cRows3 = [
  cr('H1', '### Pricing\n- a', 't1', 't1/o.md'),
  cr('H1', '### Pricing\n- a', 't2', 't2/o.md'),
  cr('HZ', '### Z\n- One', 't3', 't3/o.md'),
  cr('HZ', '### Z\n- one', 't4', 't4/o.md') // same content_hash HZ, different case → near-mate of t3
]
eq(clusterRows(cRows3).map((c) => c.kind), ['identical', 'near'], 'identical + near buckets coexist')

/* a single input row never clusters */
eq(clusterRows([cr('H1', '### Solo\n- a', 't1', 't1/t1-outline.md')]).map((c) => c.kind), ['single'],
  'clusterRows: one row → one single')
/* rows with empty source never identity-cluster; but two rows with IDENTICAL source cluster identical
   (identity is source-based, NOT content_hash-based) even with empty content_hash */
eq(clusterRows([cr('', '### A\n- a', 't1', 'x'), cr('', '### A\n- a', 't2', 'y')]).map((c) => c.kind),
  ['identical'], 'clusterRows: empty content_hash but engine-identical source → identical')

/* ---------- mergeTargetsFromCluster ---------- */
const idc = clusterRows([
  cr('H1', '### Pricing\n- a\n- b', 't1', 't1/t1-outline.md'),
  cr('H1', '### Pricing\n- a\n- b', 't2', 't2/t2-outline.md')
])[0]
eq(mergeTargetsFromCluster(idc), [
  { outline: 't1/t1-outline.md', heading: '### Pricing', occurrence: 1 },
  { outline: 't2/t2-outline.md', heading: '### Pricing', occurrence: 1 }
], 'mergeTargetsFromCluster: one target per copy, heading from source, occurrence 1 across talks')

/* two identical copies in the SAME outline → occurrence 1, 2 */
const sameOutline = clusterRows([
  cr('H1', '### Dup\n- a', 't1', 't1/t1-outline.md'),
  cr('H1', '### Dup\n- a', 't1', 't1/t1-outline.md')
])[0]
eq(mergeTargetsFromCluster(sameOutline).map((t) => t.occurrence), [1, 2],
  'mergeTargetsFromCluster: co-located copies get ascending occurrence')

/* single cluster yields no merge targets */
eq(mergeTargetsFromCluster(clusters[2]), [], 'mergeTargetsFromCluster: single → no targets')

/* ---------- clusterAlreadyOneSlide / clusterMergeable (Task 9) — over the ENGINE-identity bucket --- */
const crIdc = (md, talk) => ({ content_hash: 'H1', source_markdown: md, talkSlug: talk, outlinePath: `${talk}/o.md` })
// two engine-identical copies, both unstamped → not yet one slide, mergeable
const unstamped = clusterRows([crIdc('### Pricing\n{statement}\n- a', 't1'), crIdc('### Pricing\n{statement}\n- a', 't2')])[0]
ck(unstamped.kind === 'identical', 'unstamped identical pair clusters identical')
ck(clusterAlreadyOneSlide(unstamped) === false, 'clusterAlreadyOneSlide: unstamped copies are not one slide')
ck(clusterMergeable(unstamped) === true, 'clusterMergeable: unstamped identical pair is mergeable')
// both carry the SAME stamped id → already one slide, NOT mergeable
const sameId = clusterRows([crIdc('### Pricing {id=ab12c}\n- a', 't1'), crIdc('### Pricing {id=ab12c}\n- a', 't2')])[0]
ck(clusterAlreadyOneSlide(sameId) === true, 'clusterAlreadyOneSlide: shared id = one slide')
ck(clusterMergeable(sameId) === false, 'clusterMergeable: already-one-slide is not mergeable')
// DIFFERENT stamped ids but identical BODY → identityCanon strips the ids → identical + mergeable
const diffId = clusterRows([crIdc('### Pricing {id=aaaaa}\n- a', 't1'), crIdc('### Pricing {id=bbbbb}\n- a', 't2')])[0]
ck(diffId.kind === 'identical', 'differing-id copies with identical body still cluster identical (ids stripped)')
ck(clusterAlreadyOneSlide(diffId) === false, 'clusterAlreadyOneSlide: differing ids are not one slide')
ck(clusterMergeable(diffId) === true, 'clusterMergeable: differing-id identical pair is mergeable')
// one stamped, one not, identical body → identical, not one slide, mergeable
const mixedId = clusterRows([crIdc('### Pricing {id=aaaaa}\n- a', 't1'), crIdc('### Pricing\n- a', 't2')])[0]
ck(mixedId.kind === 'identical', 'stamped + unstamped with identical body clusters identical')
ck(clusterAlreadyOneSlide(mixedId) === false, 'clusterAlreadyOneSlide: mixed stamped/unstamped not one slide')
ck(clusterMergeable(mixedId) === true, 'clusterMergeable: mixed stamped/unstamped identical pair is mergeable')
// near / single are never mergeable
ck(clusterMergeable(clusters[1]) === false, 'clusterMergeable: near cluster false')
ck(clusterMergeable(clusters[2]) === false, 'clusterMergeable: single false')

/* ---------- copy helpers ---------- */
ck(inTalksLabel(1) === 'in 1 talk', 'inTalksLabel singular')
ck(inTalksLabel(3) === 'in 3 talks', 'inTalksLabel plural')
ck(nearCountLabel(2) === '2 near-identical', 'nearCountLabel')
ck(mergeConfirmTitle(1) === 'Merge 1 identical copy into one slide?', 'mergeConfirmTitle singular')
ck(mergeConfirmTitle(4) === 'Merge 4 identical copies into one slide?', 'mergeConfirmTitle plural')
ck(mergeNudgeLabel(1) === 'This slide is identical to 1 other across your talks — merge into one?', 'mergeNudgeLabel singular')
ck(mergeNudgeLabel(3) === 'This slide is identical to 3 others across your talks — merge into one?', 'mergeNudgeLabel plural')
ck(mergeSuccessLabel(1) === 'Merged 1 copy into one slide', 'mergeSuccessLabel singular')
ck(mergeSuccessLabel(5) === 'Merged 5 copies into one slide', 'mergeSuccessLabel plural')
ck(joinTalkNames([]) === '', 'joinTalkNames empty')
ck(joinTalkNames(['Alpha']) === 'Alpha', 'joinTalkNames one')
ck(joinTalkNames(['Alpha', 'Beta']) === 'Alpha and Beta', 'joinTalkNames two')
ck(joinTalkNames(['Alpha', 'Beta', 'Gamma']) === 'Alpha, Beta and Gamma', 'joinTalkNames three (no oxford comma)')

/* ---------- buildDisplayModel: collapse identical, hide emptied groups, near expand ---------- */
const dr = (hash, md, talk, section, outline) => ({
  content_hash: hash, source_markdown: md, talkSlug: talk, talkTitle: talk.toUpperCase(),
  section, subsection: '', slide_id: `${talk}-${section}-${hash}`, outlinePath: outline
})
const ALL = () => true
// Two byte-identical copies of Pricing across t1§Intro and t2§Solo; t2§Solo has ONLY that copy.
// A NEAR pair (### Note, SAME content_hash 'N1' but case-differing source) across t1§Body and t3§Body.
// One plain single.
const dRows = [
  dr('H1', '### Pricing\n- a', 't1', 'Intro', 't1/o.md'),
  dr('H2', '### Standalone\n- z', 't1', 'Intro', 't1/o.md'),
  dr('H1', '### Pricing\n- a', 't2', 'Solo', 't2/o.md'),
  dr('N1', '### Note\n- One', 't1', 'Body', 't1/o.md'),
  dr('N1', '### Note\n- one', 't3', 'Body', 't3/o.md')
]
const collapsed = buildDisplayModel(dRows, ALL, new Set())
// t2§Solo held only the absorbed identical copy → its group vanishes.
eq(collapsed.groups.map((g) => `${g.talkSlug}·${g.section}`), ['t1·Intro', 't1·Body'],
  'buildDisplayModel: emptied group (t2·Solo) is hidden; identical stack sits in the rep group')
// t1§Intro shows the identical stack + the standalone single = 2 cards, 2 units.
const intro = collapsed.groups[0]
eq(intro.cards.map((c) => c.kind), ['identical', 'single'], 'Intro group: identical stack then single')
ck(intro.cards[0].count === 2 && JSON.stringify(intro.cards[0].talks) === JSON.stringify(['t1', 't2']),
  'identical card carries count 2 and distinct talks [t1,t2]')
ck(intro.units === 2, 'Intro units = 2')
// t1§Body shows the near cluster collapsed to one card.
const body = collapsed.groups[1]
eq(body.cards.map((c) => c.kind), ['near'], 'Body group: near cluster collapsed to one card')
ck(body.cards[0].count === 2 && typeof body.cards[0].nearKey === 'string', 'near card carries count 2 + nearKey')
ck(collapsed.slideCount === 3, 'slideCount counts collapsed units (2 in Intro + 1 near in Body) = 3')
ck(collapsed.sectionCount === 2, 'sectionCount = 2 groups')

// Uncollapsing the near cluster expands both variants IN PLACE (same group), units unchanged.
const nearKey = body.cards[0].nearKey
const expanded = buildDisplayModel(dRows, ALL, new Set([nearKey]))
const bodyX = expanded.groups[1]
eq(bodyX.cards.map((c) => c.kind), ['near-variant', 'near-variant'], 'uncollapsed near: two variant cards in place')
eq(bodyX.cards.map((c) => c.variantIndex), [1, 2], 'near variants carry 1-based index')
ck(bodyX.units === 1, 'uncollapsed near still counts as ONE unit')
ck(expanded.slideCount === 3, 'slideCount stable across near expand (still 3 units)')

// Uncollapsing reveals ONLY variants that pass the active filter (fix 7) — a filtered-out variant
// (t3) is never surfaced or selectable.
const nearFiltered = buildDisplayModel(dRows, (r) => r.talkSlug !== 't3', new Set([nearKey]))
const bodyFiltered = nearFiltered.groups.find((g) => g.section === 'Body')
eq(bodyFiltered.cards.map((c) => c.kind), ['near-variant'], 'uncollapsed near reveals only filter-passing variants')
eq(bodyFiltered.cards.map((c) => c.row.talkSlug), ['t1'], 'the filtered-out near variant (t3) is not surfaced')

// Filtering: keep only t2 → the identical stack still shows (a t2 copy passes), rep is the t2 copy,
// merge targets STILL cover both copies (occurrence-exact from the full cluster).
const onlyT2 = buildDisplayModel(dRows, (r) => r.talkSlug === 't2', new Set())
eq(onlyT2.groups.map((g) => `${g.talkSlug}·${g.section}`), ['t2·Solo'], 'filter to t2: stack re-homes to the t2 copy group')
ck(onlyT2.groups[0].cards[0].kind === 'identical' && onlyT2.groups[0].cards[0].count === 2,
  'filtered identical stack still reports the full copy count')
eq(mergeTargetsFromCluster(onlyT2.groups[0].cards[0].cluster).map((t) => t.outline), ['t1/o.md', 't2/o.md'],
  'merge targets remain occurrence-exact over ALL copies even when filtered to one talk')

/* ---------- parseSearchQuery: scoped search operators (t:/s:/i:/e:) ---------- */
// no operator → all-fields all-words over the raw string (today's behaviour)
eq(parseSearchQuery('about me'), { scope: 'all', exact: false, text: 'about me', terms: ['about', 'me'] },
  'parseSearchQuery: no operator = scope all, all-words')
eq(parseSearchQuery(''), { scope: 'all', exact: false, text: '', terms: [] }, 'parseSearchQuery: empty query')
// t: → title scope; the remainder (after the colon) is the phrase/terms
eq(parseSearchQuery('t:about me'), { scope: 'title', exact: false, text: 'about me', terms: ['about', 'me'] },
  'parseSearchQuery: t: scopes to title (the exact bug — t:about me now parses)')
// s: → body scope
eq(parseSearchQuery('s:pricing'), { scope: 'body', exact: false, text: 'pricing', terms: ['pricing'] },
  'parseSearchQuery: s: scopes to body')
// i: → image scope
eq(parseSearchQuery('i:diagram'), { scope: 'image', exact: false, text: 'diagram', terms: ['diagram'] },
  'parseSearchQuery: i: scopes to image text')
// e: → exact phrase (scope stays all)
eq(parseSearchQuery('e:exact phrase'), { scope: 'all', exact: true, text: 'exact phrase', terms: ['exact', 'phrase'] },
  'parseSearchQuery: e: is an exact phrase over all fields')
// e: with surrounding quotes → quotes stripped
eq(parseSearchQuery('e:"exact phrase"'), { scope: 'all', exact: true, text: 'exact phrase', terms: ['exact', 'phrase'] },
  'parseSearchQuery: e: strips surrounding double quotes')
eq(parseSearchQuery("t:'about me'"), { scope: 'title', exact: false, text: 'about me', terms: ['about', 'me'] },
  'parseSearchQuery: single quotes stripped too')
// space after the colon
eq(parseSearchQuery('t: foo'), { scope: 'title', exact: false, text: 'foo', terms: ['foo'] },
  'parseSearchQuery: whitespace after the colon is ignored')
// mixed case operator
eq(parseSearchQuery('T:Foo'), { scope: 'title', exact: false, text: 'Foo', terms: ['foo'] },
  'parseSearchQuery: operator is case-insensitive; text keeps its case, terms lowercase')
eq(parseSearchQuery('E:Exact Words'), { scope: 'all', exact: true, text: 'Exact Words', terms: ['exact', 'words'] },
  'parseSearchQuery: E: uppercase exact operator')
// operator-only → empty terms (matches everything in scope, like an empty query)
eq(parseSearchQuery('t:'), { scope: 'title', exact: false, text: '', terms: [] },
  'parseSearchQuery: operator-only yields empty terms (show all in scope)')
eq(parseSearchQuery('s:  '), { scope: 'body', exact: false, text: '', terms: [] },
  'parseSearchQuery: operator + only whitespace = empty terms')
// a colon inside a word is NOT an operator (only a leading single letter t/s/i/e + colon)
eq(parseSearchQuery('http://example.com'), { scope: 'all', exact: false, text: 'http://example.com', terms: ['http://example.com'] },
  'parseSearchQuery: http://x is NOT an operator (leading letter must be a single t/s/i/e)')
eq(parseSearchQuery('foo:bar'), { scope: 'all', exact: false, text: 'foo:bar', terms: ['foo:bar'] },
  'parseSearchQuery: a multi-letter prefix is not an operator')
eq(parseSearchQuery('x:something'), { scope: 'all', exact: false, text: 'x:something', terms: ['x:something'] },
  'parseSearchQuery: an unrecognised single-letter prefix is not an operator')
// operators only bind at the very start — a mid-string t: is literal text
eq(parseSearchQuery('find t:this'), { scope: 'all', exact: false, text: 'find t:this', terms: ['find', 't:this'] },
  'parseSearchQuery: operator must be at the very start')

/* ---------- scopeNoun: zero-results copy per scope ---------- */
ck(scopeNoun(parseSearchQuery('t:x')) === 'that in the title', 'scopeNoun: title')
ck(scopeNoun(parseSearchQuery('s:x')) === 'that in the slide text', 'scopeNoun: body')
ck(scopeNoun(parseSearchQuery('i:x')) === 'that in image text', 'scopeNoun: image')
ck(scopeNoun(parseSearchQuery('e:x')) === 'that exact phrase', 'scopeNoun: exact')
ck(scopeNoun(parseSearchQuery('plain')) === 'that', 'scopeNoun: default all')

/* ---------- rankBySearch: title-hit rows float to the front, stable otherwise ---------- */
const rk = (id, titleHit) => ({ id, titleHit })
eq(rankBySearch([rk('a', false), rk('b', true), rk('c', false), rk('d', true)]).map((r) => r.id),
  ['b', 'd', 'a', 'c'], 'rankBySearch: title hits first, each side keeps original order')
eq(rankBySearch([rk('a', true), rk('b', true)]).map((r) => r.id), ['a', 'b'],
  'rankBySearch: all title hits stay put')
eq(rankBySearch([rk('a', false), rk('b', false)]).map((r) => r.id), ['a', 'b'],
  'rankBySearch: no title hits stay put')
eq(rankBySearch([]).map((r) => r.id), [], 'rankBySearch: empty is empty')
// rows missing titleHit are treated as non-hits (rank behind explicit hits)
eq(rankBySearch([{ id: 'a' }, rk('b', true), { id: 'c' }]).map((r) => r.id), ['b', 'a', 'c'],
  'rankBySearch: undefined titleHit ranks as a non-hit')
// identity preserved (same objects, reordered — not clones) so passing-set membership survives
const rkRows = [rk('a', false), rk('b', true)]
ck(rankBySearch(rkRows)[0] === rkRows[1] && rankBySearch(rkRows)[1] === rkRows[0],
  'rankBySearch: returns the SAME row objects reordered')

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('test-browser-model: all checks passed')
