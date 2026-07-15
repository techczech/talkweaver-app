// Verifies the one-time outline migration tool (compiler/scripts/migrate-outline.mjs).
// Same fail-counting convention as scripts/test-tree.mjs / test-sequencer.mjs.
//
// Migration converts LEGACY outlines (## section, ## X {sub} subsection, #### cards
// under a ### slide) to the heading-is-slide grammar (hierarchy == heading depth),
// stamping ids on every heading and byte-preserving every untouched line.

import { migrateOutline } from '../compiler/scripts/migrate-outline.mjs'
import { parseOutlineTree } from '../compiler/scripts/lib/14-outline-tree.mjs'

let fail = 0
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++ } }

const walk = (n, out = []) => (n.children.forEach((c) => { out.push(c); walk(c, out) }), out)
const allNodes = (text) => walk(parseOutlineTree(text).root)
// Per spec §6.4 ids are stamped on the Trigger line. The frozen 14-outline-tree.mjs
// folds a trigger-line id into Node.attrs (not Node.id), so the true "has an id"
// invariant is Node.id (heading-borne) OR Node.attrs.id (trigger-borne).
const nodeHasId = (n) => Boolean(n.id || (n.attrs && n.attrs.id))

// ---------------------------------------------------------------------------
// Brief's canonical test (import path corrected to the real layout).
// ---------------------------------------------------------------------------
{
  const legacy = `---
title: Cats
---
# Cats
## Types of Cats
### Tabby {id=aaaaa}
#### Stripes
body
#### Whiskers
## History {sub}
### Ancient Cats {id=bbbbb}
`
  const r1 = migrateOutline(legacy)
  assert(r1.changed, 'brief: changed')
  assert(r1.text.includes('outline_version: 2'), 'brief: version stamped')
  assert(!r1.text.includes('{sub}'), 'brief: sub removed')
  assert(/^### History$/m.test(r1.text), 'brief: subsection re-levelled to ###')
  assert(/^#### Ancient Cats/m.test(r1.text), 'brief: subsection slide demoted')
  assert(r1.text.includes('{id=aaaaa}') && r1.text.includes('{id=bbbbb}'), 'brief: ids byte-preserved')
  const tabbyIdx = r1.text.indexOf('### Tabby')
  assert(r1.text.slice(tabbyIdx, tabbyIdx + 200).includes('{carousel}'), 'brief: card slide gains carousel')
  assert(allNodes(r1.text).every(nodeHasId), 'brief: all headings stamped')
  // idempotent
  const r2 = migrateOutline(r1.text)
  assert(!r2.changed && r2.text === r1.text, 'brief: second run is a no-op')
}

// ---------------------------------------------------------------------------
// {sub} carried on the TRIGGER line (not the heading).
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## History
{sub}
### Old Thing
`
  const r = migrateOutline(legacy)
  assert(r.changed, 'sub-on-trigger: changed')
  assert(/^### History$/m.test(r.text), 'sub-on-trigger: heading re-levelled to ###')
  assert(!/^\{sub\}/m.test(r.text) && !r.text.includes('{sub}'), 'sub-on-trigger: empty trigger line deleted, sub gone')
  assert(/^#### Old Thing/m.test(r.text), 'sub-on-trigger: child slide demoted')
  assert(allNodes(r.text).every(nodeHasId), 'sub-on-trigger: all stamped')
}

// ---------------------------------------------------------------------------
// {id}-bearing trigger line survives {sub} removal (id byte-preserved).
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## Chapter
{sub id=keepme}
### Slide One
`
  const r = migrateOutline(legacy)
  assert(/^### Chapter$/m.test(r.text), 'sub+id trigger: heading re-levelled')
  assert(r.text.includes('{id=keepme}'), 'sub+id trigger: id preserved')
  assert(!r.text.includes('{sub'), 'sub+id trigger: sub token gone')
  // the trigger line kept its id, was not deleted
  assert(/^\{id=keepme\}$/m.test(r.text), 'sub+id trigger: trigger line retained with id only')
}

// ---------------------------------------------------------------------------
// Fenced fake headings are content and must be untouched (no demote, no id, no carousel).
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## Section {sub}
### Real Slide
\`\`\`\`md
## Not A Section
#### Not A Card
\`\`\`\`
`
  const r = migrateOutline(legacy)
  // the fenced lines survive verbatim
  assert(r.text.includes('## Not A Section'), 'fence: fake ## untouched')
  assert(r.text.includes('#### Not A Card'), 'fence: fake #### untouched')
  // fenced fake heading was NOT treated as a card parent (no carousel injected inside the fence)
  const fenceStart = r.text.indexOf('```md')
  const fenceEnd = r.text.indexOf('```\n', fenceStart + 3)
  const inFence = r.text.slice(fenceStart, fenceEnd)
  assert(!inFence.includes('{carousel}') && !inFence.includes('{id='), 'fence: no tokens injected inside fence')
  // real headings still migrated
  assert(/^### Section$/m.test(r.text), 'fence: real {sub} section re-levelled')
  assert(/^#### Real Slide/m.test(r.text), 'fence: real slide demoted under subsection')
}

// ---------------------------------------------------------------------------
// A slide with BOTH body content and cards: content stays put, parent gains carousel,
// cards keep their level.
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## Sec
### Gallery
intro paragraph before the cards
#### Card A
a
#### Card B
b
`
  const r = migrateOutline(legacy)
  const gIdx = r.text.indexOf('### Gallery')
  assert(r.text.slice(gIdx, gIdx + 120).includes('{carousel}'), 'body+cards: carousel added')
  assert(r.text.includes('intro paragraph before the cards'), 'body+cards: lead-in content preserved')
  assert(/^#### Card A/m.test(r.text) && /^#### Card B/m.test(r.text), 'body+cards: cards keep #### level')
  // content stays BEFORE the first card
  assert(r.text.indexOf('intro paragraph') < r.text.indexOf('#### Card A'), 'body+cards: content stays before cards')
  assert(allNodes(r.text).every(nodeHasId), 'body+cards: all stamped')
}

// ---------------------------------------------------------------------------
// Empty-frontmatter file (no frontmatter at all) gains a minimal block.
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## Only Section
### Only Slide
`
  const r = migrateOutline(legacy)
  assert(r.changed, 'no-fm: changed')
  assert(r.text.startsWith('---\noutline_version: 2\n---\n'), 'no-fm: minimal frontmatter block created')
  assert(r.text.includes('# Deck'), 'no-fm: body preserved')
  assert(allNodes(r.text).every(nodeHasId), 'no-fm: all stamped')
  const r2 = migrateOutline(r.text)
  assert(!r2.changed && r2.text === r.text, 'no-fm: idempotent')
}

// ---------------------------------------------------------------------------
// Existing container trigger is NOT overwritten with {carousel}.
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## Sec
### Grid Slide {grid-zoom}
#### A
#### B
`
  const r = migrateOutline(legacy)
  assert(!r.text.includes('{carousel}'), 'container: existing grid-zoom kept, no carousel added')
  assert(r.text.includes('{grid-zoom}'), 'container: grid-zoom preserved')
}

// ---------------------------------------------------------------------------
// BLANK-separated existing id must NOT be double-stamped (id-churn hotfix cross-check, 2026-07-10).
// migrate's triggerIndexAfter skips blank lines, so a `### H\n\n{…} {id=x}` slide already counts as
// stamped — Pass C must honour it and never append a SECOND id on a fresh trigger line.
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck
## Sec

{id=sect0}

### You cannot build muscle this way

{image-claim} {id=musc1}

- body
`
  const r = migrateOutline(legacy)
  const ids = [...r.text.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)].map((m) => m[1])
  assert(ids.filter((x) => x === 'musc1').length === 1, 'blank-sep: existing slide id not duplicated')
  assert(ids.filter((x) => x === 'sect0').length === 1, 'blank-sep: existing section id not duplicated')
  assert(ids.length === 2, `blank-sep: exactly the two existing ids, no fresh stamps (got ${JSON.stringify(ids)})`)
  assert(allNodes(r.text).every(nodeHasId), 'blank-sep: every heading is identifiable')
}

// ---------------------------------------------------------------------------
// Already-migrated file: exact no-op.
// ---------------------------------------------------------------------------
{
  const migrated = `---
outline_version: 2
title: X
---
# X
## Sec {id=zzzzz}
### Slide {id=yyyyy}
`
  const r = migrateOutline(migrated)
  assert(!r.changed, 'guard: already migrated -> not changed')
  assert(r.text === migrated, 'guard: byte-identical')
  assert(r.report.length === 0, 'guard: empty report')
}

// ---------------------------------------------------------------------------
// CRLF file: {sub} on the heading is still detected (the trailing \r must not
// defeat parseHeadingAttrs's `}$` anchor), demotion happens, and every INSERTED
// line uses CRLF so the document keeps uniform endings. Idempotent.
// ---------------------------------------------------------------------------
{
  const legacy = `# Deck\r\n## X {sub}\r\n### S\r\n#### Card A\r\n#### Card B\r\n`
  const r = migrateOutline(legacy)
  assert(r.changed, 'crlf: changed')
  assert(!r.text.includes('{sub}'), 'crlf: sub removed despite trailing \\r')
  assert(/^### X\r$/m.test(r.text), 'crlf: subsection re-levelled to ### with \\r kept')
  assert(/^#### S\r$/m.test(r.text), 'crlf: child slide demoted with \\r kept')
  assert(/^##### Card A\r$/m.test(r.text) && /^##### Card B\r$/m.test(r.text), 'crlf: cards demoted with subsection')
  assert(r.text.includes('{carousel}'), 'crlf: card slide gains carousel')
  // no mixed endings: every line (except a possible final fragment) ends with \r
  const crlfLines = r.text.split('\n')
  const bad = crlfLines.filter((l, i) => i < crlfLines.length - 1 && !l.endsWith('\r'))
  assert(bad.length === 0, `crlf: no LF-only lines inserted (found ${JSON.stringify(bad)})`)
  assert(r.text.startsWith('---\r\noutline_version: 2\r\n---\r\n'), 'crlf: created frontmatter uses CRLF')
  const r2 = migrateOutline(r.text)
  assert(!r2.changed && r2.text === r.text, 'crlf: idempotent second run')
}

if (fail) { console.error(`\n${fail} assertion(s) failed`); process.exit(1) }
console.log('test-migrate: all assertions passed')
