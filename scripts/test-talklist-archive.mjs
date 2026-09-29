import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildTree } from '../src/renderer/src/components/talkTreeNav.ts'
import {
  ARCHIVE_FOLDER, collapsedFrom, deliveryPhrase, flattenTree, folderChoices, secondLines
} from '../src/renderer/src/components/talklist/model.ts'
import { heightOf, buildLayout } from '../src/renderer/src/components/talklist/window.ts'
import { createTalkFolderStateStore, TALK_FOLDER_STATE_KEY } from '../src/main/talk-folder-state.ts'

// File list tidy (ticket 03; ADR-0029 §3; frames L1, L2): the Archive last and collapsed, a
// second line on every Ledger row at rest, folders remembered across restarts.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vault = '/vault'
const talk = (folder, slug, title, outline = `${slug}-outline.md`) => ({
  name: slug, slug, title,
  path: `${vault}/${folder ? folder + '/' : ''}${slug}`,
  outlinePath: `${vault}/${folder ? folder + '/' : ''}${slug}/${outline}`
})

const clinical = talk('ai-in-education', 'vibecoding-as-pedagogy-neurology-workshop', 'Vibecoding As Pedagogy')
const jersey = talk('ai-in-education/jersey-2026', 'vibecoding-as-pedagogy', 'Vibecoding As Pedagogy')
const summer = talk('AI Foundations - 2026 Summer School', 'agent-architecture', 'Agent Architecture and Context Engineering')
const claws = talk('agents-2026', 'ai-2026-agents', 'AI 2026 - What Should IT Professionals know About AI Agents')
const old = talk('agents-2026', 'old-one', 'An Old Delivery')
const imported = [
  talk(`${ARCHIVE_FOLDER}/ai-mapping-the-landscape`, 'alternatives-to-chatgpt', 'Alternatives to ChatGPT'),
  talk(`${ARCHIVE_FOLDER}/ai-mapping-the-landscape`, 'custom-bots', 'Custom Bots: From GPTs to AI apps'),
  talk(`${ARCHIVE_FOLDER}/ai-for-research`, 'research-a', 'Research A'),
  talk(`${ARCHIVE_FOLDER}/ai-for-research`, 'research-b', 'Research B'),
  talk(`${ARCHIVE_FOLDER}/ai-for-students`, 'students-a', 'Students A'),
  talk(`${ARCHIVE_FOLDER}/ai-overviews-webinars`, 'webinar-a', 'Webinar A')
]
// Two same-titled talks in one folder with nothing else to tell them apart.
const twinA = talk('misc', 'twin-a', 'Twin Talk')
const twinB = talk('misc', 'twin-b', 'Twin Talk', 'twin-b-v2-outline.md')
const zebra = talk('zebra', 'stripes', 'Stripes')
const all = [clinical, jersey, summer, claws, old, ...imported, twinA, twinB, zebra]
const folders = ['ai-in-education', 'ai-in-education/jersey-2026', 'agents-2026', 'AI Foundations - 2026 Summer School', ARCHIVE_FOLDER, 'misc', 'zebra']
const tree = buildTree(all, folders, vault)

// ── tree model: the Archive is last and collapsed; unknown stored paths are ignored ──
assert.ok(ARCHIVE_FOLDER.localeCompare('zebra') < 0, 'by name alone the Archive would sort before "zebra"')
const collapsedAtFirstLaunch = collapsedFrom(tree, {})
assert.ok([ARCHIVE_FOLDER, `${ARCHIVE_FOLDER}/ai-for-research`, `${ARCHIVE_FOLDER}/ai-for-students`,
  `${ARCHIVE_FOLDER}/ai-mapping-the-landscape`, `${ARCHIVE_FOLDER}/ai-overviews-webinars`].every((p) => collapsedAtFirstLaunch.has(p)),
'first launch: the Archive and its folders are closed')
const firstRows = flattenTree(tree, collapsedAtFirstLaunch)
const topFolders = firstRows.filter((r) => r.kind === 'folder' && r.depth === 0).map((r) => r.path)
assert.equal(topFolders.at(-1), ARCHIVE_FOLDER, 'the Archive is the last top-level folder')
assert.equal(firstRows.at(-1).key, `f:${ARCHIVE_FOLDER}`, 'nothing of the Archive shows until it is opened')
const opened = collapsedFrom(tree, { [ARCHIVE_FOLDER]: true, 'no/such/folder': false, 'agents-2026': false })
const openRows = flattenTree(tree, opened)
const archiveAt = openRows.findIndex((r) => r.key === `f:${ARCHIVE_FOLDER}`)
assert.deepEqual(openRows.slice(archiveAt + 1).map((r) => `${r.kind}:${r.path ?? r.talk.slug}`), [
  `folder:${ARCHIVE_FOLDER}/ai-for-research`, `folder:${ARCHIVE_FOLDER}/ai-for-students`,
  `folder:${ARCHIVE_FOLDER}/ai-mapping-the-landscape`, `folder:${ARCHIVE_FOLDER}/ai-overviews-webinars`
], 'L2: opening the Archive shows its four folders, each still closed')
assert.ok(opened.has('agents-2026') && !opened.has('no/such/folder'), 'a stored choice applies; an unknown stored path is ignored')
assert.deepEqual(folderChoices(['a', '', 'a/b'], false), { a: false, 'a/b': false })
console.log('PASS tree model: Archive last, closed with its folders on first launch, opens to its four folders; unknown paths ignored')

// ── every folder starts closed — the file list and the picker's Files tab share this default and one
//    folder memory (Dominik, 0.34.0-preview.2 check); a remembered choice wins ──
{
  const everyFolder = []
  const walk = (node) => { for (const c of node.children) { everyFolder.push(c.path); walk(c) } }
  walk(tree)
  const fileListFirst = collapsedFrom(tree, {})
  assert.deepEqual([...fileListFirst].sort(), [...everyFolder].sort(), 'first launch: every folder is closed, nested ones and the Archive too')
  const rows = flattenTree(tree, fileListFirst)
  assert.deepEqual(rows.filter((r) => r.kind === 'talk'), [], 'no talk inside a folder shows until its folder is opened')
  assert.ok(rows.every((r) => r.kind === 'folder' && r.depth === 0), 'only the top-level folder rows show')
  assert.deepEqual(rows.map((r) => r.path).sort(), tree.children.map((c) => c.path).sort(), 'every top-level folder shows')
  assert.equal(rows.at(-1).path, ARCHIVE_FOLDER, 'the Archive still last')
  const chosen = collapsedFrom(tree, { 'ai-in-education': true, 'ai-in-education/jersey-2026': true, zebra: false })
  assert.ok(!chosen.has('ai-in-education') && !chosen.has('ai-in-education/jersey-2026'), 'a folder once opened stays open (the remembered choice wins)')
  assert.ok(chosen.has('zebra') && chosen.has('misc'), 'a folder closed by choice, or never touched, is closed')
  const openedRows = flattenTree(tree, chosen).map((r) => r.kind === 'talk' ? `talk:${r.talk.slug}` : `folder:${r.path}`)
  assert.ok(openedRows.includes('talk:vibecoding-as-pedagogy') && openedRows.includes('talk:vibecoding-as-pedagogy-neurology-workshop'), 'the opened folders show their talks')
}
console.log('PASS every folder starts closed (file list and picker alike); a remembered open or closed choice wins')

// ── second line: event or folder, then the last delivery; same titles read apart ──
const at = (y, m, d) => new Date(y, m - 1, d, 9, 30).getTime()
const meta = {
  [clinical.slug]: { event: 'Clinical Neuroscience' },
  [jersey.slug]: { event: 'Jersey College for Girls AI in Education conference' },
  [summer.slug]: { event: 'Summer School' }
}
const lastDelivered = { [clinical.slug]: at(2026, 7, 10), [summer.slug]: at(2026, 7, 8), [old.slug]: at(2025, 3, 4) }
const lines = secondLines(all, { vaultRoot: vault, meta, lastDelivered, currentYear: 2026 })
assert.equal(lines.get(clinical.outlinePath), 'ai-in-education · Clinical Neuroscience · given 10 Jul', 'Journey 3 right-when')
assert.equal(lines.get(jersey.outlinePath), 'jersey-2026 · Jersey College for Girls AI in Education conference · no delivery recorded')
assert.notEqual(lines.get(clinical.outlinePath), lines.get(jersey.outlinePath), 'the two "Vibecoding As Pedagogy" rows differ')
assert.equal(lines.get(summer.outlinePath), 'Summer School · given 8 Jul', 'L1: the event, then the last delivery')
assert.equal(lines.get(claws.outlinePath), 'agents-2026 · no delivery recorded', 'L1: no event → the folder')
assert.equal(lines.get(old.outlinePath), 'agents-2026 · given 4 Mar 2025', 'another year keeps the year')
assert.equal(lines.get(imported[0].outlinePath), 'imported · no delivery recorded', 'L2: an Archive talk says it was imported')
assert.equal(lines.get(twinA.outlinePath), 'twin-a-outline.md', 'identical lines for one title → the file name')
assert.equal(lines.get(twinB.outlinePath), 'twin-b-v2-outline.md')
assert.equal(lines.get(zebra.outlinePath), 'zebra · no delivery recorded')
assert.equal(lines.size, all.length, 'every talk row has a line')
assert.equal(deliveryPhrase(undefined, 2026), 'no delivery recorded')
const lineRows = flattenTree(tree, new Set(), lines)
assert.ok(lineRows.filter((r) => r.kind === 'talk').every((r) => typeof r.line === 'string'), 'tree rows carry their line')
console.log('PASS second line: "ai-in-education · Clinical Neuroscience · given 10 Jul" vs "jersey-2026 · Jersey College… · no delivery recorded"; event/folder/imported/file name')

// ── window: at-rest rows are 36 px in Ledger; Shelf rows keep their height ──
const heights = { ledger: 26, shelf: 55, fhead: 24, ledgerTwo: 36, shelfTwo: 69 }
const talkRow = lineRows.find((r) => r.kind === 'talk')
assert.equal(heightOf(talkRow, 'ledger', heights), 36)
assert.equal(heightOf(talkRow, 'shelf', heights), 55, 'Shelf keeps its current rows')
assert.equal(heightOf({ kind: 'folder', key: 'f:x/y', path: 'x/y', depth: 1 }, 'ledger', heights), 26, 'nested folder rows stay 26 px')
assert.equal(heightOf(talkRow, 'ledger', { ledger: 26, shelf: 55, fhead: 24 }), 36, 'unmeasured: 26 + 10')
const layout = buildLayout(lineRows, 'ledger', heights)
assert.equal(layout.total, lineRows.reduce((sum, r) => sum + heightOf(r, 'ledger', heights), 0))
console.log('PASS window: Ledger talk rows 36 px at rest, Shelf 55 px, folder rows unchanged')

// ── persisted folder-state store: write, read on (re)launch, unknown/malformed ignored ──
const userData = mkdtempSync(join(tmpdir(), 'tw-folder-state-'))
try {
  const configFile = join(userData, 'config.json')
  writeFileSync(configFile, JSON.stringify({ vaultRoot: vault, actionBarVisible: true }))
  // The same read/merge-write main does over config.json (index.ts readConfig / writeConfig).
  const readConfig = () => { try { return JSON.parse(readFileSync(configFile, 'utf8')) } catch { return {} } }
  const launch = (vaultRoot = () => readConfig().vaultRoot ?? null) => createTalkFolderStateStore({
    vaultRoot,
    readValue: () => readConfig()[TALK_FOLDER_STATE_KEY],
    writeValue: (value) => writeFileSync(configFile, JSON.stringify({ ...readConfig(), [TALK_FOLDER_STATE_KEY]: value }, null, 2))
  })
  const first = launch()
  assert.deepEqual(first.read(), {}, 'nothing stored on first launch')
  assert.deepEqual(first.write({ [ARCHIVE_FOLDER]: true, 'agents-2026': false }), { [ARCHIVE_FOLDER]: true, 'agents-2026': false })
  assert.deepEqual(first.write({ 'agents-2026': true, '../escape': false, '/abs': true, 'a//b': true, bad: 'yes' }),
    { [ARCHIVE_FOLDER]: true, 'agents-2026': true }, 'malformed paths and values are dropped')
  const relaunched = launch()
  assert.deepEqual(relaunched.read(), { [ARCHIVE_FOLDER]: true, 'agents-2026': true }, 'a relaunch reads what was left')
  const onDisk = readConfig()
  assert.equal(onDisk.actionBarVisible, true, 'other preferences survive')
  assert.deepEqual(Object.keys(onDisk[TALK_FOLDER_STATE_KEY]), [vault], 'keyed by vault root, then vault-relative path')
  // A hand-edited or older file: junk entries are ignored, good ones kept.
  onDisk[TALK_FOLDER_STATE_KEY][vault]['gone/folder'] = false
  onDisk[TALK_FOLDER_STATE_KEY][vault].junk = 3
  writeFileSync(configFile, JSON.stringify(onDisk))
  const stored = launch().read()
  assert.deepEqual(stored, { [ARCHIVE_FOLDER]: true, 'agents-2026': true, 'gone/folder': false })
  assert.ok(!collapsedFrom(tree, stored).has('gone/folder') && !collapsedFrom(tree, stored).has(ARCHIVE_FOLDER),
    'the renderer applies only paths its tree has')
  assert.deepEqual(launch(() => '/other-vault').read(), {}, 'another vault has its own state')
  assert.deepEqual(launch(() => null).write({ a: true }), {}, 'no vault: nothing written')
  writeFileSync(configFile, JSON.stringify({ vaultRoot: vault, [TALK_FOLDER_STATE_KEY]: 'garbage' }))
  assert.deepEqual(launch().read(), {}, 'a malformed stored value reads as nothing stored')
  assert.ok(existsSync(configFile))
  console.log('PASS folder-state store: written to config.json, read on relaunch, malformed and unknown entries ignored, per vault')
} finally {
  rmSync(userData, { recursive: true, force: true })
}

// ── rendering: the Ledger row's second line and the Archive header ──
const dir = mkdtempSync(join(root, '.test-talklist-archive-'))
const bundle = join(dir, 'bundle.mjs')
try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import LedgerRow from './src/renderer/src/components/talklist/LedgerRow.tsx'",
        "import Tree from './src/renderer/src/components/talklist/Tree.tsx'",
        "import { buildLayout, mountedIndices } from './src/renderer/src/components/talklist/window.ts'",
        "const noop = () => {}",
        "const rowProps = (talk, extra = {}) => ({ talk, depth: 1, selected: false, focused: false, menuAnchor: false, warningCount: 0, pathwayCount: 0, pathwayNames: [], pub: 'none', label: talk.title, fileMode: false, rowKey: 't:' + talk.outlinePath, rowRef: noop, onOpen: noop, onContextMenu: noop, onDragStart: noop, onDragEnd: noop, onHoverEnter: noop, onHoverLeave: noop, ...extra })",
        "export const ledger = (talk, line, extra) => renderToStaticMarkup(React.createElement(LedgerRow, { ...rowProps(talk, extra), slideCount: 52, line }))",
        "const heights = { ledger: 26, shelf: 55, fhead: 24, ledgerTwo: 36, shelfTwo: 69 }",
        "const cb = new Proxy({}, { get: () => () => noop })",
        "export const tree = (view, rows, collapsed, viewMode = 'ledger') => { const layout = buildLayout(rows, viewMode, heights); return renderToStaticMarkup(React.createElement(Tree, { searching: false, query: '', rows, view, isEmptyVault: false, viewMode, naming: 'title', collapsed, focusKey: null, activeTalkPath: null, menuTalkPath: null, dragTopic: null, talkMeta: {}, lastDelivered: {}, pubFor: () => 'none', layout, mounted: mountedIndices(layout, { start: 0, end: rows.length }, new Set()), containerRef: { current: null }, onScroll: noop, cb })) }"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-talklist-archive-entry.tsx'
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

  const row = ui.ledger(clinical, lines.get(clinical.outlinePath))
  assert.match(row, /class="tl-row tl-row--two"/)
  assert.match(row, /<span class="tl-row-text"><span class="tl-row-name ">Vibecoding As Pedagogy<\/span><span class="tl-row-sub tl-row-rest" title="ai-in-education · Clinical Neuroscience · given 10 Jul">ai-in-education · Clinical Neuroscience · given 10 Jul<\/span><\/span>/)
  assert.match(row, /<span class="tl-row-count">52<\/span>/, 'the slide count stays on the row')
  assert.match(ui.ledger(clinical, lines.get(clinical.outlinePath), { label: clinical.slug, fileMode: true }), /tl-row-name tl-row-name--file">vibecoding-as-pedagogy-neurology-workshop</)
  assert.doesNotMatch(ui.ledger(clinical, undefined), /tl-row--two|tl-row-sub/, 'without a line the row stays one line')
  console.log('PASS Ledger row: title, then the quiet second line; slide count kept')

  // Every folder but the Archive opened by the user (folders start closed).
  const allButArchive = collapsedFrom(tree, folderChoices(folders.filter((f) => !f.startsWith(ARCHIVE_FOLDER)), true))
  const html = ui.tree(tree, flattenTree(tree, allButArchive, lines), allButArchive)
  const heads = [...html.matchAll(/<div class="(tl-fhead[^"]*)"[^>]*data-folder-path="([^"]*)"[^>]*>.*?<span class="tl-fname">([^<]*)<\/span><span class="tl-fcount">(\d+)<\/span>/g)]
    .map((m) => ({ cls: m[1], path: m[2], name: m[3], count: Number(m[4]) }))
  const archive = heads.at(-1)
  assert.equal(archive.path, ARCHIVE_FOLDER)
  assert.equal(archive.name, 'Archive · old PowerPoint imports')
  assert.equal(archive.cls, 'tl-fhead is-archive', 'dimmed and collapsed')
  assert.equal(archive.count, imported.length, 'the count includes its subfolders')
  assert.match(html, /data-folder-path="z-old-powerpoint-imports"[^>]*><span class="tl-twist">.*?<\/span><span class="tl-ficon"><svg[^>]*><path d="M3 3h18v5H3z"/, 'archive icon')
  assert.equal(heads.find((h) => h.path === 'ai-in-education').count, 2, 'a folder counts its subfolders\' talks')
  assert.equal((html.match(/tl-row tl-row--two/g) ?? []).length, all.length - imported.length, 'every visible talk row has two lines')
  const openCollapsed = collapsedFrom(tree, { [ARCHIVE_FOLDER]: true })
  const openHtml = ui.tree(tree, flattenTree(tree, openCollapsed, lines), openCollapsed)
  const archiveFolders = [...openHtml.matchAll(/data-folder-path="z-old-powerpoint-imports\/([^"]+)"[^>]*>.*?<span class="tl-fcount">(\d+)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`)
  assert.deepEqual(archiveFolders, ['ai-for-research 2', 'ai-for-students 1', 'ai-mapping-the-landscape 2', 'ai-overviews-webinars 1'], 'L2: four folders with their counts')
  assert.match(openHtml, /class="tl-fhead tl-fhead--expanded is-archive"/)
  const shelfHtml = ui.tree(tree, flattenTree(tree, new Set(), lines), new Set(), 'shelf')
  assert.doesNotMatch(shelfHtml, /tl-row-rest|tl-shrow--two/, 'Shelf rows are unchanged at rest')
  console.log('PASS Tree: Archive header last, labelled, dimmed, archive icon, count 6; opened shows four folders with counts; Shelf unchanged')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('PASS talk list archive + second line + remembered folders')
