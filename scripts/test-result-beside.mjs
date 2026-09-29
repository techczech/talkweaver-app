// A slide-search result's talk beside the results (talk search 06; ADR-0029 §4; frame K5). Seam:
// the picker main area's view model (src/renderer/src/components/talkBesideModel.ts) — results only
// or results plus a talk; which talk and slide are open; what Esc restores; the talk's outline plan
// and header; arrows across the split; the rows an insert takes. Imports the real module (Node
// strips its erasable TypeScript). The in-app check (a real search, the slide in view) is
// e2e/diagnose-result-beside.mjs.
import { strict as assert } from 'node:assert'
import {
  RESULTS_ONLY, besideAvailable, besideHeaderText, besidePlan, besideScrollTop, closeBeside, mainView,
  openBeside, selectedRowsFor, splitNavigate, talkDeck
} from '../src/renderer/src/components/talkBesideModel.ts'

// ── fixture: K5's "mondai" results and the talk "AI 2026: Agents = Files in folders" ──
const FILES = 'ai-2026-agents-files-in-folders'
const row = (talkSlug, order, section, title, talkTitle) => ({ talkSlug, order, section, slide_id: `${talkSlug}-${order}`, title, talkTitle })
const filesTitle = 'AI 2026: Agents = Files in folders'
const deckRows = [
  row(FILES, 0, '', 'AI 2026', filesTitle), // title slide, before any section
  row(FILES, 1, 'introduction', 'Introduction', filesTitle),
  row(FILES, 2, 'introduction', 'Formerly founded and ran', filesTitle),
  row(FILES, 3, 'content', 'Content', filesTitle),
  row(FILES, 4, 'content', 'Step 3', filesTitle),
  row(FILES, 5, 'content', 'Old ways', filesTitle),
  row(FILES, 6, 'content', 'MondAI RoundUp', filesTitle),
  row(FILES, 7, 'content', 'Come by to MondAI', filesTitle),
  row(FILES, 8, '', 'Thank you', filesTitle) // closing slide, after the sections
]
const other = [
  row('current-state', 3, 'state', 'Join MondAI for Latest News', 'The current state of AI agents'),
  row('agent-architecture', 9, 'context', 'MondAI RoundUp', 'Agent Architecture and Context Engineering')
]
// The index snapshot holds every talk, in no particular order.
const snapshot = [...other, ...[...deckRows].reverse()]
// The "mondai" results (what the left side shows).
const results = [other[0], deckRows[6], deckRows[7], other[1]]
const labels = { introduction: 'Introduction', content: 'Content', state: 'The State of AI in September 2026', context: 'Context' }
const secLabel = (_slug, sec) => labels[sec] ?? sec
const titleOf = (slug) => (slug === FILES ? filesTitle : '')

// ── results only vs results plus talk; which talk and slide; Esc restores ──
{
  assert.equal(mainView(RESULTS_ONLY), 'results')
  const before = { scrollTop: 480, activeKey: `${FILES}:${FILES}-6` }
  let main = openBeside(RESULTS_ONLY, results[1], before)
  assert.equal(mainView(main), 'results+talk', 'one key on a result splits the main area')
  assert.deepEqual(main.beside, { slug: FILES, order: 6 }, 'the result’s talk, at the result’s slide')
  assert.deepEqual(main.saved, before, 'the results as they were are kept for Esc')
  assert.deepEqual(Object.keys(main).sort(), ['beside', 'saved'], 'the selection is not part of this state, so opening and closing never touch it')

  // Opening a second result's talk replaces the right side; Esc still returns to the first state.
  const later = { scrollTop: 900, activeKey: 'agent-architecture:agent-architecture-9' }
  main = openBeside(main, results[3], later)
  assert.deepEqual(main.beside, { slug: 'agent-architecture', order: 9 }, 'a second result’s talk replaces the first')
  assert.deepEqual(main.saved, before, 'replacing keeps the snapshot from before the first open')

  const closed = closeBeside(main)
  assert.equal(mainView(closed.main), 'results', 'Esc closes the right side')
  assert.deepEqual(closed.restore, before, 'Esc gives back the results’ scroll position and focus')
  assert.deepEqual(closeBeside(closed.main).restore, null, 'nothing to restore when nothing is open')
  const plain = openBeside(RESULTS_ONLY, results[0], { scrollTop: 0, activeKey: null })
  assert.deepEqual(closeBeside(plain).restore, { scrollTop: 0, activeKey: null })

  assert.equal(besideAvailable('grouped'), true)
  assert.equal(besideAvailable('outline'), true)
  assert.equal(besideAvailable('side'), false, 'columns already fill the main area')
  console.log('PASS state: open splits, a second open replaces, Esc restores the first snapshot; selection untouched')
}

// ── the right side: the whole talk in outline order, scrolled section, highlight, header (K5) ──
{
  const plan = besidePlan({ slug: FILES, order: 6 }, snapshot, results, secLabel, titleOf)
  assert.deepEqual(plan.deck.map((r) => r.order), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'the whole talk, in outline order, not only its matching slides')
  assert.deepEqual(plan.chunks.map((c) => [c.section, c.label, c.start, c.rows.length]), [
    ['', '', 0, 1], ['introduction', 'Introduction', 1, 2], ['content', 'Content', 3, 5], ['', '', 8, 1]
  ], 'section by section; the title and closing slides are unheaded chunks of their own')
  assert.equal(plan.deck[plan.hl].title, 'MondAI RoundUp', 'the result’s slide is the highlighted one')
  assert.equal(plan.hl, 6)
  assert.equal(plan.hlChunk, 2, 'the right side scrolls to § Content')
  assert.equal(besideHeaderText(plan.header), 'AI 2026: Agents = Files in folders · § Content · slide 7 of 9 · Esc close')

  // A slide before the first section has no § part.
  const first = besidePlan({ slug: FILES, order: 0 }, snapshot, results, secLabel, titleOf)
  assert.equal(besideHeaderText(first.header), 'AI 2026: Agents = Files in folders · slide 1 of 9 · Esc close')
  // The talk's title falls back to the rows' own when the vault list lacks it.
  const arch = besidePlan({ slug: 'agent-architecture', order: 9 }, snapshot, results, secLabel, titleOf)
  assert.equal(besideHeaderText(arch.header), 'Agent Architecture and Context Engineering · § Context · slide 1 of 1 · Esc close')
  // A slide the index no longer has: the talk still opens, at its first slide.
  assert.equal(besidePlan({ slug: FILES, order: 99 }, snapshot, results, secLabel, titleOf).hl, 0)
  // Before the snapshot has the talk, the live results stand in; a talk in neither opens nothing.
  assert.deepEqual(talkDeck(FILES, other, results).map((r) => r.order), [6, 7])
  assert.equal(besidePlan({ slug: 'gone', order: 0 }, snapshot, results, secLabel, titleOf), null)
  console.log('PASS plan: whole talk in outline order, § Content, MondAI RoundUp highlighted, K5 header')
}

// ── where the right side scrolls: the section's top, or the slide centred if that hides it ──
{
  assert.equal(besideScrollTop({ sectionTop: 600, cardTop: 900, cardBottom: 1100, viewport: 700 }), 600, 'section top when the slide is then in view')
  assert.equal(besideScrollTop({ sectionTop: 600, cardTop: 2000, cardBottom: 2200, viewport: 700 }), 1750, 'a slide deep in a long section is centred instead')
  assert.equal(besideScrollTop({ sectionTop: -4, cardTop: 10, cardBottom: 200, viewport: 700 }), 0)
  console.log('PASS scroll: section top, or the slide centred when the section is taller than the view')
}

// ── arrows across the split: results 2 across, the talk 3 across in section rows ──
{
  // Results: 5 cards (rows [0 1] [2 3] [4]); talk: chunks of 1, 2, 5, 1 → positions 5 | 6 7 | 8 9 10 / 11 12 | 13.
  const L = { left: 5, leftCols: 2, rightChunks: [1, 2, 5, 1], rightCols: 3, rightEntry: 5 + 6, leftEntry: 1 }
  const nav = (p, k) => splitNavigate(p, k, L)
  assert.equal(nav(0, 'ArrowRight'), 1)
  assert.equal(nav(1, 'ArrowRight'), 11, '→ at the results’ right edge enters the talk at the highlighted slide')
  assert.equal(nav(4, 'ArrowRight'), 11, 'from the last result too')
  assert.equal(nav(0, 'ArrowLeft'), 0, '← at the results’ left edge stays')
  assert.equal(nav(0, 'ArrowDown'), 2)
  assert.equal(nav(3, 'ArrowDown'), 4, '↓ clamps onto the last result')
  assert.equal(nav(4, 'ArrowDown'), 4, '↓ never falls into the talk')
  assert.equal(nav(2, 'ArrowUp'), 0)
  assert.equal(nav(10, 'ArrowLeft'), 9)
  assert.equal(nav(11, 'ArrowLeft'), 1, '← at a talk row’s left edge (a second row too) returns to the result')
  assert.equal(nav(11, 'ArrowRight'), 12)
  assert.equal(nav(12, 'ArrowRight'), 12, '→ stops at the end of a section row')
  assert.equal(nav(8, 'ArrowLeft'), 1, '← at the talk’s left edge returns to the result it opened from')
  assert.equal(nav(9, 'ArrowDown'), 12, '↓ within a section')
  assert.equal(nav(12, 'ArrowDown'), 13, '↓ from a section’s last row enters the next section')
  assert.equal(nav(7, 'ArrowDown'), 9, '↓ keeps the column into the next section')
  assert.equal(nav(8, 'ArrowUp'), 6, '↑ from a section’s first row goes to the previous section’s last row')
  assert.equal(nav(5, 'ArrowUp'), 5, '↑ at the top of the talk stays')
  assert.equal(nav(13, 'ArrowDown'), 13)
  assert.equal(splitNavigate(0, 'ArrowRight', { ...L, left: 1, rightChunks: [] }), 0, 'no talk: nothing to cross into')
  console.log('PASS arrows: each side moves on its own; ←→ cross at the edges, to the highlighted slide and back to its result')
}

// ── insert takes each selected slide once, and a selected slide the closed talk had ──
{
  const key = (r) => `${r.talkSlug}:${r.slide_id}`
  const visible = [...results, ...deckRows] // results, then the talk beside them
  const keyAt = (pos) => key(visible[pos])
  // "MondAI RoundUp" selected (it shows on both sides) plus "Old ways" from the talk.
  const selected = new Set([key(deckRows[6]), key(deckRows[5])])
  assert.deepEqual(selectedRowsFor(visible, keyAt, selected, snapshot).map((r) => r.title), ['Old ways', 'MondAI RoundUp'],
    'a slide shown as a result and in its talk inserts once, in talk order')
  // The talk beside closed: only the results are on screen, and the selection is unchanged.
  const keyAtResults = (pos) => key(results[pos])
  assert.deepEqual(selectedRowsFor(results, keyAtResults, selected, snapshot).map((r) => r.title), ['Old ways', 'MondAI RoundUp'],
    'a slide selected in the closed talk still inserts (found in the index snapshot), in talk order')
  assert.deepEqual(selectedRowsFor(results, keyAtResults, new Set(), snapshot), [], 'nothing selected, nothing taken')
  console.log('PASS insert: each selected slide once, including one selected in the talk beside after it closed')
}

// ── insert order is talk order, whatever is showing (Select whole section, 0.34.0-preview.8) ──
{
  const key = (r) => `${r.talkSlug}:${r.slide_id}`
  // The whole "content" section selected (heading slide first, as Select whole section adds it),
  // while a search shows only one of its slides — the last one.
  const section = [deckRows[3], deckRows[4], deckRows[5], deckRows[6], deckRows[7]]
  const selected = new Set(section.map(key))
  const titles = (visible) => selectedRowsFor(visible, (pos) => key(visible[pos]), selected, snapshot).map((r) => r.title)
  const inOrder = ['Content', 'Step 3', 'Old ways', 'MondAI RoundUp', 'Come by to MondAI']
  assert.deepEqual(titles([deckRows[7]]), inOrder, 'a search showing only the last slide: the section still goes in in its order')
  assert.deepEqual(titles(results), inOrder, 'the mondai results showing two of them: the same order')
  assert.deepEqual(titles(deckRows), inOrder, 'no search, the whole talk showing: the same order')
  assert.deepEqual(titles([]), inOrder, 'nothing showing (the snapshot alone): the same order')
  assert.deepEqual(titles([...deckRows].reverse()), inOrder, 'shown in reverse: still talk order')
  // Two talks: in the order the user added them; each in its own order.
  const two = new Set([key(other[1]), key(deckRows[6]), key(deckRows[3])])
  assert.deepEqual(selectedRowsFor(results, (pos) => key(results[pos]), two, snapshot).map((r) => `${r.talkSlug} ${r.title}`),
    ['agent-architecture MondAI RoundUp', `${FILES} Content`, `${FILES} MondAI RoundUp`],
    'talks in the order their first slide was selected; within a talk, talk order')
  const twoLater = new Set([key(deckRows[6]), key(other[1]), key(deckRows[3])])
  assert.deepEqual(selectedRowsFor(results, (pos) => key(results[pos]), twoLater, snapshot).map((r) => r.talkSlug),
    [FILES, FILES, 'agent-architecture'], 'the talk added first goes first')
  // Visible rows are the on-screen objects (the tag picker updates those in place).
  const shown = selectedRowsFor(results, (pos) => key(results[pos]), selected, snapshot)
  assert.equal(shown.find((r) => r.title === 'MondAI RoundUp'), results[1], 'a showing slide is its on-screen row')
  console.log('PASS insert order: talk order within a talk, talks as added; the same whether or not a search shows them')
}

console.log('PASS result beside: state, plan, scroll, arrows, insert rows')
