import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { flattenSearchHits, quietSearchLine } from '../src/renderer/src/components/talklist/model.ts'
import { buildLayout, heightOf } from '../src/renderer/src/components/talklist/window.ts'
import { slashFocusesFileListSearch } from '../src/renderer/src/components/talklist/useKeyboard.ts'
import { highlightSegments, readingLine, resultsHeaderModel } from '../src/shared/talk-search.ts'
import {
  applyCompletion, completionAt, folderCompletions, insertPrefix, nearestFolder, noResultSuggestions, talksForFolderTerm
} from '../src/renderer/src/components/talklist/prefixAssist.ts'

// Talk search in the Talks browser (ticket 01; frames L5, L7, L8, L9, L10): result rows, the
// match line in Ledger and Shelf, the results header, the still-reading line and no results.
// Ticket 02 (frames L3, L4, L8): the prefix hint row, completion and no-results suggestions.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vault = '/vault'
const talk = (slug, title, folder) => ({ name: slug, slug, title, path: `${vault}/${folder}/${slug}`, outlinePath: `${vault}/${folder}/${slug}/${slug}-outline.md` })
const hit = (t, folder, extra = {}) => ({ ...t, folder, editedMs: 1, tier: 3, titleHighlights: [], match: null, lastGiven: null, ...extra })

const teaching = talk('teaching', 'Teaching During The Cognitive Revolution', 'ai-in-education')
const intern = talk('intern', 'From Intern To Toolmaker - Jersey', 'ai-in-education/jersey-2026')
const lab = talk('lab', 'Vibecoding Lab: Prototyping Research Tools', 'external-workshops/York-July-2026/day-2')
const gone = talk('gone', 'Deleted since', 'misc')
const eventLine = { field: 'details', label: 'event', text: 'Jersey College for Girls AI in Education conference', highlights: [[0, 6]] }
const hits = [
  hit(intern, 'ai-in-education/jersey-2026', { tier: 0, titleHighlights: [[27, 33]] }),
  hit(teaching, 'ai-in-education', { match: eventLine }),
  hit(gone, 'misc', { tier: 5 }),
  hit(lab, 'external-workshops/York-July-2026/day-2', { tier: 0, titleHighlights: [[0, 10]], lastGiven: '2026-07-21' })
]

// ── model: rows keep the search's order and drop talks the list no longer has ──
const listed = new Map([intern, teaching, lab].map((t) => [t.outlinePath, t]))
const rows = flattenSearchHits(hits, listed)
assert.deepEqual(rows.map((r) => r.talk.slug), ['intern', 'teaching', 'lab'])
assert(rows.every((r) => r.kind === 'talk' && r.depth === 0 && r.hit), 'every result row carries its hit')
assert.equal(rows[0].talk, intern, 'the row uses the listed TalkInfo, not the hit copy')
assert.equal(quietSearchLine(hits[0], '', 2026), 'ai-in-education / jersey-2026', 'L5: a title match shows its folder')
assert.equal(quietSearchLine(hits[3], 'external-workshops/York-July-2026', 2026), 'day-2 · given 21 Jul', 'L7: folder relative to the drilled-in one, last given')
assert.equal(quietSearchLine(hits[3], '', 2027), 'external-workshops / York-July-2026 / day-2 · given 21 Jul 2026', 'another year keeps the year')
console.log('PASS model: ranked result rows, stale hits dropped, quiet line relative to the folder')

// ── window: result rows are two-line rows ──
const heights = { ledger: 26, shelf: 55, fhead: 24, ledgerTwo: 36, shelfTwo: 69 }
assert.equal(heightOf(rows[0], 'ledger', heights), 36)
assert.equal(heightOf(rows[0], 'shelf', heights), 69)
assert.equal(heightOf({ kind: 'talk', key: 'k', talk: intern, depth: 0 }, 'ledger', heights), 26, 'a tree row stays 26 px')
assert.equal(heightOf(rows[0], 'ledger', { ledger: 26, shelf: 55, fhead: 24 }), 36, 'unmeasured two-line rows fall back to +10 px')
assert.deepEqual(buildLayout(rows, 'ledger', heights).offsets, [0, 36, 72])
console.log('PASS window: result rows measure 36 px (Ledger) / 69 px (Shelf)')

// ── shared helpers: header and reading line ──
const result = { query: 'jersey', terms: [], within: null, hits, everywhereCount: 4, slideText: { read: 74, total: 74 } }
assert.deepEqual(resultsHeaderModel(result, 3), { count: '3 talks', scope: 'everywhere', everywhere: null })
assert.deepEqual(resultsHeaderModel({ ...result, within: 'external-workshops/York-July-2026', everywhereCount: 5 }, 2),
  { count: '2 talks', scope: 'in York-July-2026', everywhere: 5 })
assert.equal(resultsHeaderModel(result, 1).count, '1 talk')
assert.equal(readingLine(result), null)
assert.equal(readingLine({ ...result, slideText: { read: 41, total: 74 } }), 'Reading slide text · 41 of 74 talks. More results may appear.')
assert.deepEqual(highlightSegments('abcdef', [[3, 5], [1, 2], [4, 6]]), [
  { text: 'a', hit: false }, { text: 'b', hit: true }, { text: 'c', hit: false }, { text: 'def', hit: true }
], 'overlapping ranges merge')
console.log('PASS header: "3 talks · everywhere", "in York-July-2026 · search everywhere (5)", reading line')

// ── ticket 02: completion and suggestions (the box's models) ──
// Folder counts as window.tw.talks.folders returns them (talks directly in each folder).
const folders = [
  { path: 'AI Agent Workshops', talks: 4 },
  { path: 'ai-in-education', talks: 5 },
  { path: 'ai-in-education/jersey-2026', talks: 3 },
  { path: 'external-workshops', talks: 1 },
  { path: 'external-workshops/York-July-2026', talks: 0 },
  { path: 'external-workshops/York-July-2026/day-1', talks: 3 },
  { path: 'external-workshops/York-July-2026/day-2', talks: 3 },
  { path: 'external-workshops/York-July-2026/day-3', talks: 3 },
  { path: 'misc/beyond-yonder', talks: 2 }
]
{
  // L4: `f` offers fo: and fi:; `me` offers met:; a word that is no prefix offers nothing.
  const f = completionAt('f', 1, folders)
  assert.equal(f.heading, 'Prefixes')
  assert.deepEqual(f.items.map((i) => [i.label, i.hint]), [['fo:', 'folder'], ['fi:', 'file name']])
  assert.deepEqual(completionAt('agents me', 9, folders).items.map((i) => i.label), ['met:'])
  assert.equal(completionAt('agents', 6, folders), null)
  assert.equal(completionAt('fo', 1, folders), null, 'only the token that ends at the caret completes')
  assert.deepEqual(applyCompletion('agents f', f && completionAt('agents f', 8, folders), f.items[0]), { query: 'agents fo:', caret: 10 })

  // L4: after fo:yo, York-July-2026 and its day folders with talk counts; the name-start match first.
  const yo = completionAt('fo:yo', 5, folders)
  assert.equal(yo.heading, 'Folders')
  assert.deepEqual(yo.items.map((i) => [i.label, i.count]), [
    ['York-July-2026', 9], ['York-July-2026 / day-1', 3], ['York-July-2026 / day-2', 3], ['York-July-2026 / day-3', 3], ['beyond-yonder', 2]
  ])
  assert.deepEqual(applyCompletion('fo:yo', yo, yo.items[0]), { query: 'fo:York-July-2026 ', caret: 18 }, '↵ completes the term and a space')
  assert.deepEqual(applyCompletion('fo:yo da:2026', completionAt('fo:yo da:2026', 5, folders), yo.items[3]), { query: 'fo:York-July-2026/day-3 da:2026', caret: 24 })
  assert.equal(talksForFolderTerm(folders, 'York-July-2026'), 9, 'a folder counts the talks in its subfolders')
  assert.equal(talksForFolderTerm(folders, 'external-workshops'), 10)
  // A folder name with spaces completes quoted; the lone prefix offers the top-level folders.
  const ai = completionAt('fo:ai ag', 8, folders)
  assert.equal(ai, null, 'a space ends the token')
  const q = completionAt('fo:"ai ag', 9, folders)
  assert.deepEqual(q.items.map((i) => i.label), ['AI Agent Workshops'])
  assert.deepEqual(applyCompletion('fo:"ai ag', q, q.items[0]), { query: 'fo:"AI Agent Workshops" ', caret: 24 })
  assert.deepEqual(completionAt('fo:', 3, folders).items.map((i) => i.label), ['AI Agent Workshops', 'ai-in-education', 'external-workshops'])
  assert.equal(completionAt('fo:jersey-2026', 14, folders), null, 'nothing left to complete')
  assert.equal(folderCompletions(folders, 'zzz').length, 0)
  // L3: a hint click types the prefix.
  assert.deepEqual(insertPrefix('', 0, 'fo:'), { query: 'fo:', caret: 3 })
  assert.deepEqual(insertPrefix('agents', 6, 'da:'), { query: 'agents da:', caret: 10 })
  // L8: the nearest folder, Drop <term>, slide text.
  assert.deepEqual(nearestFolder(folders, 'jersy'), { name: 'jersey-2026', count: 3 })
  assert.equal(nearestFolder(folders, 'jersey'), null, 'a term that finds a folder needs no correction')
  assert.equal(nearestFolder(folders, 'qqqqq'), null)
  assert.deepEqual(noResultSuggestions('fo:jersy da:2025', folders).map(({ kind, name, count, label, query }) => ({ kind, name, count, label, query })), [
    { kind: 'folder', name: 'jersey-2026', count: 3, label: undefined, query: 'fo:jersey-2026 da:2025' },
    { kind: 'drop', name: undefined, count: undefined, label: 'Drop da:2025', query: 'fo:jersy' },
    { kind: 'slides', name: undefined, count: undefined, label: 'Search slide text too (co:)', query: 'co:jersy da:2025' }
  ], 'the three suggestions drawn in L8')
  assert.deepEqual(noResultSuggestions('fi:x met:y agents', folders).map((s) => s.query), ['met:y agents', 'fi:x agents', 'co:x co:y agents'])
  assert.deepEqual(noResultSuggestions('co:zzz da:2025', folders).map((s) => s.label), ['Drop co:zzz', 'Drop da:2025'], 'no slide-text offer when co: is already there')
  assert.deepEqual(noResultSuggestions('zzqqxx', folders), [], 'plain words alone: nothing to offer')
  console.log('PASS completion: f → fo: fi:; fo:yo → York-July-2026 (9) + day folders (3); ↵ completes; L8 suggestions')
}

// ── rendering: Ledger and Shelf rows, the header, and no results ──
// Inside the repo so the bundle resolves react from node_modules (as test-command-registry does).
const dir = mkdtempSync(join(root, '.test-talklist-search-'))
const bundle = join(dir, 'bundle.mjs')
try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import LedgerRow from './src/renderer/src/components/talklist/LedgerRow.tsx'",
        "import ShelfRow from './src/renderer/src/components/talklist/ShelfRow.tsx'",
        "import Tree from './src/renderer/src/components/talklist/Tree.tsx'",
        "import { SearchHead } from './src/renderer/src/components/talklist/SearchLine.tsx'",
        "import { PrefixHints, CompletionPop } from './src/renderer/src/components/talklist/SearchAssist.tsx'",
        "export const hints = () => renderToStaticMarkup(React.createElement(PrefixHints, { onPick: noop }))",
        "export const pop = (completion, active) => renderToStaticMarkup(React.createElement(CompletionPop, { completion, active, onPick: noop, onHover: noop }))",
        "const noop = () => {}",
        "const rowProps = (talk, hit, extra = {}) => ({ talk, hit, depth: 0, selected: false, focused: false, menuAnchor: false, warningCount: 0, pathwayCount: 0, pathwayNames: [], pub: 'none', label: talk.title, fileMode: false, rowKey: 't:' + talk.outlinePath, rowRef: noop, onOpen: noop, onContextMenu: noop, onDragStart: noop, onDragEnd: noop, onHoverEnter: noop, onHoverLeave: noop, ...extra })",
        "export const ledger = (talk, hit, extra) => renderToStaticMarkup(React.createElement(LedgerRow, { ...rowProps(talk, hit, extra), slideCount: 52 }))",
        "export const shelf = (talk, hit, extra) => renderToStaticMarkup(React.createElement(ShelfRow, { ...rowProps(talk, hit, extra), slideCount: 52, coverKey: null, deliveredMs: undefined, editedMs: undefined, event: 'Jersey College for Girls AI in Education conference' }))",
        "export const head = (result, shown) => renderToStaticMarkup(React.createElement(SearchHead, { result, shown, onSearchEverywhere: noop }))",
        "export const empty = (query, everywhereCount, suggestions = []) => renderToStaticMarkup(React.createElement(Tree, { searching: true, query, searchSettled: true, everywhereCount, onSearchEverywhere: noop, suggestions, onSuggest: noop, rows: [], trees: new Map(), vaults: [], sectionCollapsed: new Set(), isEmptyVault: false, viewMode: 'ledger', naming: 'title', collapsed: new Set(), focusKey: null, activeTalkPath: null, menuTalkPath: null, dragTopic: null, talkMeta: {}, lastDelivered: {}, pubFor: () => 'none', layout: { offsets: [], heights: [], total: 0, groups: [], stickyHeaderHeight: 24 }, mounted: new Set(), containerRef: { current: null }, onScroll: noop, cb: {} }))"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-talklist-search-entry.tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle,
    logLevel: 'silent'
  })
  const ui = await import(pathToFileURL(bundle).href)

  // L5: event match line under the title; the title-matched row marks the title.
  const eventRow = ui.ledger(teaching, hits[1])
  assert.match(eventRow, /class="tl-row tl-row--two"/)
  assert.match(eventRow, /<span class="tl-row-sub tl-row-match"[^>]*><em>event<\/em> <mark>Jersey<\/mark><span> College for Girls AI in Education conference<\/span><\/span>/)
  const titleRow = ui.ledger(intern, hits[0])
  assert.match(titleRow, /<span class="tl-row-name ">.*<mark>Jersey<\/mark><\/span>/)
  assert.match(titleRow, /<span class="tl-row-sub">ai-in-education \/ jersey-2026<\/span>/)
  // L7: inside the York folder the quiet line is relative and names the last delivery.
  assert.match(ui.ledger(lab, hits[3], { focusPath: 'external-workshops/York-July-2026' }), /<span class="tl-row-sub">day-2 · given 21 Jul/)
  // File-name mode keeps the slug label unmarked.
  assert.doesNotMatch(ui.ledger(intern, hits[0], { label: 'intern', fileMode: true }), /<mark>/)
  // A tree row is unchanged: one line, no wrapper.
  const plain = ui.ledger(teaching, undefined)
  assert.match(plain, /class="tl-row"/)
  assert.doesNotMatch(plain, /tl-row-text|tl-row-sub/)
  console.log('PASS Ledger: match line with field and marks; title marks; quiet folder line; tree rows unchanged')

  // L10: Shelf shows the match line under the event line.
  const shelfRow = ui.shelf(teaching, hits[1])
  assert.match(shelfRow, /class="tl-shrow tl-shrow--two"/)
  assert(shelfRow.indexOf('tl-shrow-event') < shelfRow.indexOf('tl-shrow-match'), 'the match line sits under the event')
  assert.match(shelfRow, /<div class="tl-shrow-match"><span class="tl-row-sub tl-row-match"[^>]*><em>event<\/em> <mark>Jersey<\/mark>/)
  assert.doesNotMatch(ui.shelf(teaching, undefined), /tl-shrow-match/)
  console.log('PASS Shelf: match line under the event line')

  // L5 / L7 / L9 headers.
  const everywhere = ui.head(result, 3)
  assert.match(everywhere, /<div class="tl-res-head"><span>3 talks<\/span><span class="tl-res-scope"><span class="tl-res-where">everywhere<\/span><\/span><\/div>/)
  assert.doesNotMatch(everywhere, /tl-res-note/)
  const scoped = ui.head({ ...result, within: 'external-workshops/York-July-2026', everywhereCount: 5 }, 2)
  assert.match(scoped, /<span>2 talks<\/span><span class="tl-res-scope"><span class="tl-res-where">in York-July-2026 ·<\/span><button type="button" class="tl-res-wide">search everywhere \(5\)<\/button><\/span>/)
  const reading = ui.head({ ...result, slideText: { read: 41, total: 74 } }, 3)
  assert.match(reading, /<div class="tl-res-note" role="status"><svg[^]*<\/svg>Reading slide text · 41 of 74 talks\. More results may appear\.<\/div>/)
  console.log('PASS header: counts, scope with "search everywhere (N)", still-reading line')

  // L8: no results keep the query; inside a folder, the everywhere count is offered.
  const none = ui.empty('fo:jersy da:2025', null)
  assert.match(none, /<p>No talks match <b>“fo:jersy da:2025”<\/b>\.<\/p>/)
  assert.doesNotMatch(none, /Search everywhere/)
  assert.match(ui.empty('agents', 6), /<button type="button" class="tl-res-wide">Search everywhere \(6\)<\/button>/)
  console.log('PASS no results: "No talks match …" with the query kept')

  // L3: the hint row names the five prefixes; the date one explains the date forms.
  const hintRow = ui.hints()
  assert.deepEqual([...hintRow.matchAll(/<b>([a-z]+:)<\/b> ([a-z ]+)<\/button>/g)].map((m) => `${m[1]} ${m[2]}`),
    ['fo: folder', 'fi: file name', 'met: details', 'co: slides', 'da: date'])
  assert.match(hintRow, /data-prefix="da:" title="da: reads 2026 \(a year\), 2026-07 \(a month\), 2026-07-22 \(a day\), or a month name such as jul or july/)
  // L4: heading, first row "9 talks", later rows the bare count, the highlighted row, the footer.
  const popup = ui.pop(completionAt('fo:yo', 5, folders), 0)
  assert.match(popup, /<div class="tl-cpl-h">Folders<\/div><div role="option" aria-selected="true" class="tl-cpl-o is-on"><span>York-July-2026<\/span><i>9 talks<\/i><\/div><div role="option" aria-selected="false" class="tl-cpl-o"><span>York-July-2026 \/ day-1<\/span><i>3<\/i><\/div>/)
  assert.match(popup, /<div class="tl-cpl-f">↵ or Tab completes<\/div>/)
  assert.match(ui.pop(completionAt('f', 1, folders), 1), /<span>fo:<\/span><i>folder<\/i><\/div><div role="option" aria-selected="true" class="tl-cpl-o is-on"><span>fi:<\/span><i>file name<\/i>/)
  // L8: the three suggestions under "No talks match".
  const l8 = ui.empty('fo:jersy da:2025', null, noResultSuggestions('fo:jersy da:2025', folders))
  assert.match(l8, /<p>No talks match <b>“fo:jersy da:2025”<\/b>\.<\/p><p class="tl-empty-sugg" data-suggestion="folder">Did you mean folder <button type="button" class="tl-res-wide">jersey-2026<\/button>\? · 3 talks<\/p><p class="tl-empty-sugg" data-suggestion="drop"><button type="button" class="tl-res-wide">Drop da:2025<\/button><\/p><p class="tl-empty-sugg" data-suggestion="slides"><button type="button" class="tl-res-wide">Search slide text too \(co:\)<\/button><\/p>/)
  console.log('PASS hint row (L3), completion list (L4) and L8 suggestions render')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// / from outside the list (Dominik, 0.34.0-preview.2 check): the caret goes to the search box unless
// the key is text (the talk editor, a field), a modal surface owns the keyboard, or a handler took it.
{
  const base = { key: '/', metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, typing: false, inEditor: false, modalOpen: false }
  assert.equal(slashFocusesFileListSearch(base), true, '/ with focus outside the editor and fields: the search box')
  assert.equal(slashFocusesFileListSearch({ ...base, inEditor: true, typing: true }), false, '/ in the talk editor is text')
  assert.equal(slashFocusesFileListSearch({ ...base, typing: true }), false, '/ in any text field is text')
  assert.equal(slashFocusesFileListSearch({ ...base, modalOpen: true }), false, 'the slide picker or a dialog keeps its keys')
  assert.equal(slashFocusesFileListSearch({ ...base, defaultPrevented: true }), false, 'a key already taken (the list’s own /) is left alone')
  assert.equal(slashFocusesFileListSearch({ ...base, metaKey: true }), false, '⌘/ is the cheat sheet, not the search')
  assert.equal(slashFocusesFileListSearch({ ...base, ctrlKey: true }), false, '⌃/ is the cheat sheet, not the search')
  assert.equal(slashFocusesFileListSearch({ ...base, altKey: true }), false)
  assert.equal(slashFocusesFileListSearch({ ...base, key: '?' }), false, '? is not /')
  console.log('PASS / from outside the list focuses the search box, never from the editor, a field or a dialog')
}

console.log('PASS talk list search rendering: Ledger + Shelf match lines, header, reading and empty states')
