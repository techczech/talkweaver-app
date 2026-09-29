import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The slide picker's Files tree is the file list's tree (ticket talk-search 04; ADR-0029 §4;
// frame K1): nested folders at their real depth, the Archive last and collapsed, the same folder
// memory, slide counts (per talk; per folder including subfolders). The picker's behaviours stay:
// click replaces the scope, ⌘-click toggles, columns for two and three talks, a talk expands to
// its sections, the current talk is marked. Seams: the shared tree model's count mode, the
// picker's rows over it, its scope model, and the Files tree render.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(root, '.test-picker-tree-'))
const bundle = join(dir, 'bundle.mjs')

const vault = '/vault'
const talk = (folder, slug, title) => ({
  name: slug, slug, title,
  path: `${vault}/${folder}/${slug}`,
  outlinePath: `${vault}/${folder}/${slug}/${slug}-outline.md`
})
const YORK = 'external-workshops/York-July-2026'
const ARCHIVE = 'z-old-powerpoint-imports'
const claw = talk('agents-2026', 'the-age-of-the-claw', 'The Age of the Claw')
const year = talk('agents-2026', 'year-of-agents', 'AI 2026 - Year of Agents and Claws')
const day1 = talk(`${YORK}/day-1`, 'york-opening', 'York Opening Keynote')
const day2 = talk(`${YORK}/day-2`, 'york-workshop', 'York Workshop')
const day3 = talk(`${YORK}/day-3`, 'york-closing', 'York Closing Panel')
const otherDay3 = talk('ai-in-education/day-3', 'edu-day-three', 'Education Day Three')
const imported = talk(`${ARCHIVE}/ai-for-research`, 'old-research', 'Old Research Deck')
const talks = [claw, year, day1, day2, day3, otherDay3, imported]
const slides = { [claw.slug]: 26, [year.slug]: 57, [day1.slug]: 10, [day2.slug]: 20, [day3.slug]: 30, [otherDay3.slug]: 5, [imported.slug]: 7 }
const sections = { [year.slug]: [{ sec: 'opening', label: 'Opening', count: 12 }, { sec: 'claws', label: 'Claws', count: 45 }] }
const folders = ['agents-2026', 'external-workshops', YORK, `${YORK}/day-1`, `${YORK}/day-2`, `${YORK}/day-3`, 'ai-in-education', 'ai-in-education/day-3', ARCHIVE, `${ARCHIVE}/ai-for-research`]
const source = {
  talks, folders, vaultRoot: vault, sortKey: 'name', meta: {}, delivered: {},
  slidesOf: (slug) => slides[slug] ?? 0,
  sectionsOf: (slug) => sections[slug] ?? [],
  currentTalkSlug: claw.slug
}

// A stand-in for the preload bridge: records what the folder memory persists.
const persisted = []
globalThis.window = { tw: { talks: {
  folderState: async () => ({}),
  setFolderState: async (changes) => { persisted.push(changes); return changes }
} } }

try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import { FilesTree } from './src/renderer/src/components/browser-rail/BrowseTabs.tsx'",
        "export { filesTreeRows, folderPathOf } from './src/renderer/src/components/browser-rail/filesTreeModel.ts'",
        "export { gridModeFor, rowInScope, scopeDisplayName, scopedTalkSlugs, toggleScope, inFolder } from './src/renderer/src/components/browser-rail/railModel.ts'",
        "export { folderTotals, talkTree } from './src/renderer/src/components/talklist/model.ts'",
        "export { chooseFolders } from './src/renderer/src/components/talklist/folderMemory.ts'",
        "export const files = (source, scoped = []) => renderToStaticMarkup(React.createElement(FilesTree, { source, isScoped: (k) => scoped.includes(k), onScope: () => {} }))"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-picker-tree-entry.tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle,
    logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const brief = (r) => r.kind === 'folder' ? `${'  '.repeat(r.depth)}[${r.name}] ${r.count}` : r.kind === 'talk' ? `${'  '.repeat(r.depth)}${r.title} ${r.count}${r.current ? ' current' : ''}` : `${'  '.repeat(r.depth)}§ ${r.label} ${r.count}`

  // ── the shared tree's count mode: talks for the file list, slides for the picker ──
  const tree = m.talkTree(talks, folders, vault)
  const talkTotals = m.folderTotals(tree, 'talks')
  const slideTotals = m.folderTotals(tree, 'slides', (t) => slides[t.slug])
  assert.equal(talkTotals.get('external-workshops'), 3, 'talks mode: a folder counts the talks in its subfolders')
  assert.equal(talkTotals.get(`${YORK}/day-3`), 1)
  assert.equal(slideTotals.get('external-workshops'), 60, 'slides mode: 10 + 20 + 30 across day-1..day-3')
  assert.equal(slideTotals.get(YORK), 60)
  assert.equal(slideTotals.get('ai-in-education'), 5)
  assert.equal(slideTotals.get(ARCHIVE), 7)
  console.log('PASS shared tree: one tree, two count modes (talks; slides including subfolders)')

  // ── the picker's rows: nested York days, Archive last and collapsed, slide counts ──
  // Every folder starts closed, the Archive too (one default and one folder memory with the file
  // list; Dominik, 0.34.0-preview.2 check): first launch shows the top-level folders only.
  assert.deepEqual(m.filesTreeRows(source, {}, new Set()).map(brief), [
    '[agents-2026] 83', '[ai-in-education] 5', '[external-workshops] 60', '[Archive · old PowerPoint imports] 7'
  ], 'first launch: every folder closed, top-level folders only, the Archive last')
  // Opened by the user (every folder but the Archive), as the rows below read.
  const opened = Object.fromEntries(['agents-2026', 'ai-in-education', 'ai-in-education/day-3', 'external-workshops', YORK,
    `${YORK}/day-1`, `${YORK}/day-2`, `${YORK}/day-3`].map((p) => [p, true]))
  const rows = m.filesTreeRows(source, opened, new Set())
  assert.deepEqual(rows.map(brief), [
    '[agents-2026] 83',
    '  AI 2026 - Year of Agents and Claws 57',
    '  The Age of the Claw 26 current',
    '[ai-in-education] 5',
    '  [day-3] 5',
    '    Education Day Three 5',
    '[external-workshops] 60',
    '  [York-July-2026] 60',
    '    [day-1] 10',
    '      York Opening Keynote 10',
    '    [day-2] 20',
    '      York Workshop 20',
    '    [day-3] 30',
    '      York Closing Panel 30',
    '[Archive · old PowerPoint imports] 7'
  ], 'K1: nested folders at their real depth, slide counts, the Archive last and collapsed')
  const day3Rows = rows.filter((r) => r.kind === 'folder' && r.name === 'day-3')
  assert.deepEqual(day3Rows.map((r) => r.path), ['ai-in-education/day-3', `${YORK}/day-3`], 'the two day-3 folders stay apart')
  const archiveRow = rows.at(-1)
  assert.ok(archiveRow.archive && !archiveRow.open, 'the Archive row is marked and closed')
  console.log('PASS picker rows: York day folders nested, two day-3 apart, slide totals, Archive last and collapsed')

  // Folder memory applies (a closed folder hides its subtree; the opened Archive shows its folder).
  const memoryRows = m.filesTreeRows(source, { ...opened, [YORK]: false, [ARCHIVE]: true }, new Set())
  assert.deepEqual(memoryRows.slice(6).map(brief), [
    '[external-workshops] 60',
    '  [York-July-2026] 60',
    '[Archive · old PowerPoint imports] 7',
    '  [ai-for-research] 7'
  ], 'stored choices close York and open the Archive; its folders stay closed until opened (L2)')

  // A talk expands to its sections, one level below it; the current talk stays marked.
  const expanded = m.filesTreeRows(source, opened, new Set([year.slug]))
  const at = expanded.findIndex((r) => r.kind === 'talk' && r.slug === year.slug)
  assert.deepEqual(expanded.slice(at, at + 3).map(brief), [
    '  AI 2026 - Year of Agents and Claws 57',
    '    § Opening 12',
    '    § Claws 45'
  ], 'a talk still expands to its sections')
  assert.ok(expanded[at].open && expanded[at].hasSections)
  // Talks sit in the file list's sort.
  const edited = m.filesTreeRows({ ...source, sortKey: 'edited', meta: { [claw.slug]: { editedMs: 2 }, [year.slug]: { editedMs: 1 } } }, opened, new Set())
  assert.deepEqual(edited.slice(1, 3).map((r) => r.slug), [claw.slug, year.slug], 'the file list\'s sort orders the talks')
  console.log('PASS picker rows: folder memory applies, a talk expands to its sections, the file list\'s sort')

  // ── scope over the new tree: click replaces, ⌘-click toggles, columns for two and three ──
  const t = (x) => ({ kind: 'talk', talk: x.slug, talkTitle: x.title })
  let scope = m.toggleScope([], t(day1), false)
  scope = m.toggleScope(scope, t(day2), false)
  assert.deepEqual(scope.map((e) => e.talk), [day2.slug], 'a click replaces the scope')
  scope = m.toggleScope(scope, t(day3), true)
  assert.equal(m.gridModeFor(scope.length, true), 'side', 'two talks: columns')
  scope = m.toggleScope(scope, t(year), true)
  assert.equal(m.gridModeFor(scope.length, true), 'side', 'three talks: columns')
  scope = m.toggleScope(scope, t(otherDay3), true)
  assert.equal(m.gridModeFor(scope.length, true), 'outline', 'a fourth talk: sequential, no fourth column')
  scope = m.toggleScope(scope, t(otherDay3), true)
  scope = m.toggleScope(scope, t(day3), true)
  assert.deepEqual(scope.map((e) => e.talk), [day2.slug, year.slug], '⌘-click removes a talk')
  assert.deepEqual(m.toggleScope([t(day2)], t(day2), false), [], 're-clicking the sole talk clears the scope')

  // A folder scope uses the full path and takes in its subfolders; the two day-3 stay apart.
  const folderOf = (slug) => m.folderPathOf(talks.find((x) => x.slug === slug), vault)
  const row = (slug) => ({ talkSlug: slug, section: '' })
  const york3 = [{ kind: 'folder', folder: `${YORK}/day-3` }]
  assert.ok(m.rowInScope(row(day3.slug), york3, folderOf))
  assert.ok(!m.rowInScope(row(otherDay3.slug), york3, folderOf), 'York day-3 is not ai-in-education/day-3')
  const inWorkshops = talks.filter((x) => m.rowInScope(row(x.slug), [{ kind: 'folder', folder: 'external-workshops' }], folderOf)).map((x) => x.slug)
  assert.deepEqual(inWorkshops, [day1.slug, day2.slug, day3.slug], 'a folder scope takes in its subfolders, as its total does')
  const talksIn = (f) => talks.filter((x) => m.inFolder(folderOf(x.slug), f)).map((x) => x.slug)
  assert.deepEqual(m.scopedTalkSlugs([{ kind: 'folder', folder: YORK }], talksIn), [day1.slug, day2.slug, day3.slug])
  assert.equal(m.scopeDisplayName(york3[0]), 'external-workshops › York-July-2026 › day-3')
  assert.ok(!m.inFolder('agents-2026', ''), 'the vault root is never a folder scope')
  console.log('PASS scope: click replaces, ⌘-click toggles, columns for 2 and 3, folder scope by full path with subfolders')

  // ── the Files tree render ──
  // First launch: every folder closed, the Archive too.
  const fresh = m.files(source)
  assert.deepEqual([...fresh.matchAll(/aria-expanded="(true|false)" data-folder-path="([^"]+)"/g)].map((x) => `${x[2]} ${x[1]}`),
    ['agents-2026 false', 'ai-in-education false', 'external-workshops false', `${ARCHIVE} false`], 'rendered at first launch: top-level folders only, every one closed')
  // The user opens every folder but the Archive.
  m.chooseFolders(vault, opened)
  const html = m.files(source, [`talk:${day3.slug}`])
  const folderRows = [...html.matchAll(/<button[^>]*aria-level="(\d+)"[^>]*aria-expanded="(true|false)"[^>]*data-folder-path="([^"]+)"[^>]*class="([^"]+)"[^>]*style="padding-left:(\d+)px"[^>]*>.*?<span class="lt-tn">([^<]*)<\/span><span class="lt-tc">(\d+)<\/span><\/button>/g)]
    .map((x) => ({ level: Number(x[1]), open: x[2] === 'true', path: x[3], cls: x[4], pad: Number(x[5]), name: x[6], count: Number(x[7]) }))
  assert.deepEqual(folderRows.filter((f) => f.path.startsWith('external-workshops')).map((f) => `${f.level} ${f.name} ${f.count}`), [
    '1 external-workshops 60', '2 York-July-2026 60', '3 day-1 10', '3 day-2 20', '3 day-3 30'
  ], 'rendered: York day folders nested three levels down, with slide totals')
  assert.ok(folderRows.find((f) => f.name === 'day-1').pad > folderRows.find((f) => f.name === 'York-July-2026').pad, 'deeper rows indent further')
  const archive = folderRows.at(-1)
  assert.equal(archive.path, ARCHIVE)
  assert.equal(archive.name, 'Archive · old PowerPoint imports')
  assert.ok(!archive.open && /\barchive\b/.test(archive.cls), 'rendered: the Archive is last, dimmed and collapsed')
  assert.match(html, /data-talk-slug="the-age-of-the-claw" class="lt-trow talk current"[^>]*>.*?<span class="lt-current-tag">current<\/span><span class="lt-tc">26<\/span>/, 'the current talk is marked, with its slide count')
  assert.match(html, /data-talk-slug="york-closing" class="lt-trow talk scoped"/, 'a scoped talk row is marked scoped')
  console.log('PASS Files tree render: nested York folders with totals, Archive last dimmed and closed, current and scoped talks')

  // ── one folder memory: a choice made anywhere redraws the picker's tree and is persisted ──
  m.chooseFolders(vault, { [YORK]: false })
  assert.deepEqual(persisted.at(-1), { [YORK]: false }, 'the choice is persisted through the file list\'s store')
  const after = m.files(source)
  assert.match(after, /aria-expanded="false" data-folder-path="external-workshops\/York-July-2026"/, 'the picker draws the folder as closed')
  assert.doesNotMatch(after, /data-folder-path="external-workshops\/York-July-2026\/day-1"/, 'and hides its subfolders')
  console.log('PASS folder memory: one store for the file list and the picker, persisted')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('PASS picker Files tree = the file list\'s tree, with slide counts')
