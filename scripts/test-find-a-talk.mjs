import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createTalkSearch } from '../src/main/talk-search.ts'
import { createVaultIndex } from '../src/main/vault-index.mjs'

// "Find a talk" in the slide picker (ticket talk-search 05; ADR-0029 §4; frames K1–K4). Seams:
// the shared talk-search call (one query through the real search module gives the file list's
// rows and Find a talk's rows, asserted together: same talks, same order); the picker's scope
// state (↵ picks and replaces, ⌘↵ adds beside, a chip's × removes); the keys the box keeps from
// the grid; and the rail's render (two boxes, the slide search without talk-name hits).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(root, '.test-find-a-talk-'))
const bundle = join(dir, 'bundle.mjs')
const vault = mkdtempSync(join(tmpdir(), 'tw-find-a-talk-'))
const cacheDir = mkdtempSync(join(tmpdir(), 'tw-find-a-talk-cache-'))
const base = Date.parse('2026-09-01T10:00:00Z')

function talk(rel, slug, { frontmatter, body = '### Opening\n\nWelcome\n', edited }) {
  const d = join(vault, rel, slug)
  mkdirSync(d, { recursive: true })
  const outlinePath = join(d, `${slug}-outline.md`)
  writeFileSync(outlinePath, `---\noutline_version: 2\n${frontmatter}\n---\n\n${body}`)
  const at = new Date(base + edited * 60_000)
  utimesSync(outlinePath, at, at)
  return outlinePath
}

// ── fixture vault: the three talks K3 draws for "claw", and talks that must not match ──
const ageOfClaw = talk('agents-2026', 'the-age-of-the-claw', { frontmatter: 'title: The Age of the Claw\ndate: 2026', edited: 50 })
const yearOfAgents = talk('agents-2026', 'ai-2026-year-of-agents', { frontmatter: 'title: AI 2026 - Year of Agents and Claws\nevent: ICTF', edited: 40 })
const filesInFolders = talk('agents-presentations', 'ai-2026-agents-files-in-folders', {
  frontmatter: 'title: "AI 2026: Agents = Files in folders"',
  body: '### Introduction\n\nHello\n\n## Content\n\n### Open Claw files\n\n- SOUL.md\n\n### HEARTBEAT.md\n\n- beats\n',
  edited: 60
})
talk('agents-presentations', 'agent-architecture', { frontmatter: 'title: Agent architecture and context engineering', edited: 30 })
talk('external-workshops/York-July-2026/day-3', 'york-closing', { frontmatter: 'title: York Closing Panel\ndate: 2026-07-22', edited: 20 })
talk('external-workshops/York-July-2026/day-2', 'york-workshop', { frontmatter: 'title: York Workshop\nevent: Festival of AI Competency', edited: 10 })

const indexVault = { id: 'test-vault', root: vault }
const index = createVaultIndex({ dir: join(cacheDir, 'vault-index') })
const listedTalks = await index.refresh(indexVault)
const { prepareSource } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
const { buildPerSlideProjections } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/10-projections.mjs')).href)
const compiled = new Map()
for (const t of listedTalks) {
  const model = await prepareSource(t.outlinePath, readFileSync(t.outlinePath, 'utf8'), t.slug, statSync(t.outlinePath), undefined, { projectionsOnly: true })
  compiled.set(t.outlinePath, buildPerSlideProjections(model, t.slug))
}
const search = createTalkSearch({
  vaultRoot: () => vault,
  talks: () => index.cached(indexVault),
  slideRows: (p) => compiled.get(p) ?? [],
  onSlideTextMissing: () => {}
}, { revalidateMs: 0 })

try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import BrowserRail from './src/renderer/src/components/browser-rail/BrowserRail.tsx'",
        "export * from './src/renderer/src/components/browser-rail/findTalkModel.ts'",
        "export * as rail from './src/renderer/src/components/browser-rail/railModel.ts'",
        "export { flattenSearchHits } from './src/renderer/src/components/talklist/model.ts'",
        "export const renderRail = (props) => renderToStaticMarkup(React.createElement(BrowserRail, props))"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-find-a-talk-entry.tsx'
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
  const listed = new Map(listedTalks.map((t) => [t.outlinePath, t]))
  const current = 'the-age-of-the-claw'

  // ── the shared talk-search call: "claw" lists the three talks K3 draws, with match lines ──
  {
    const r = await search.searchTalks('claw')
    const rows = m.findTalkRows(r.hits, listed, current)
    assert.deepEqual(rows.map((row) => row.talk.outlinePath), [ageOfClaw, yearOfAgents, filesInFolders],
      'K3: the two title matches (the newer first), then the talk whose slides say Claw')
    assert.deepEqual(rows.map((row) => row.talk.title), ['The Age of the Claw', 'AI 2026 - Year of Agents and Claws', 'AI 2026: Agents = Files in folders'])
    assert.equal(rows[0].hit.match, null, 'a title match needs no match line')
    assert.deepEqual(rows[1].hit.titleHighlights, [[29, 33]], '"Claws" is marked in the title')
    assert.equal(rows[2].hit.match.label, 'slides')
    assert.equal(rows[2].hit.match.text, '“Open Claw files”', 'K3: slides “Open Claw files”')
    assert.deepEqual(rows.map((row) => row.current), [true, false, false], 'the current talk is listed and marked')
    assert.equal(m.firstPickable(rows), 1, 'the highlight starts on the first talk that can be picked')
    assert.equal(m.firstPickable([]), 0)
    console.log('PASS "claw": the three talks K3 draws, in its order, with the `slides` match line')
  }
  {
    // Same query → same ordered talks in the file list and in Find a talk, for plain words,
    // prefixes and dates alike.
    for (const q of ['claw', 'agents', 'york', 'fo:york', 'da:2026-07', 'co:heartbeat', 'festival', '2026']) {
      const r = await search.searchTalks(q)
      const fileList = m.flattenSearchHits(r.hits, listed).map((row) => row.talk.outlinePath)
      const findATalk = m.findTalkRows(r.hits, listed, current).map((row) => row.talk.outlinePath)
      assert.deepEqual(findATalk, fileList, `"${q}": Find a talk lists what the file list lists, in its order`)
      assert.ok(fileList.length > 0, `"${q}" finds something`)
    }
    // A hit the vault list no longer has drops out of both.
    const r = await search.searchTalks('claw')
    const without = new Map([...listed].filter(([p]) => p !== yearOfAgents))
    assert.deepEqual(m.findTalkRows(r.hits, without, current).map((row) => row.key), m.flattenSearchHits(r.hits, without).map((row) => row.key))
    // Both surfaces ask through the one renderer call.
    const read = (p) => readFileSync(join(root, p), 'utf8')
    assert.match(read('src/renderer/src/components/talklist/TalkList.tsx'), /useTalkSearch\(\{ query, within: focusPath/)
    assert.match(read('src/renderer/src/components/browser-rail/FindTalk.tsx'), /useTalkSearch\(\{ query, talksVersion: talks \}\)/)
    assert.equal((read('src/renderer/src/components/talklist/TalkList.tsx').match(/window\.tw\.talks\.search/g) ?? []).length, 0,
      'the file list no longer calls the search on its own')
    console.log('PASS parity: 8 queries give the same talks in the same order in the file list and Find a talk')
  }

  // ── the picker's scope state ──
  {
    const e = (slug, title = slug) => m.talkEntry({ slug, title })
    const key = (slug) => m.rail.scopeKeyOf(e(slug))
    const folder = { kind: 'folder', folder: 'agents-2026' }
    assert.deepEqual(e('york-workshop', 'York Workshop'), { kind: 'talk', talk: 'york-workshop', talkTitle: 'York Workshop' })

    // ↵ picks: the talk alone replaces whatever was scoped, and becomes the box's chip.
    let s = m.pickTalk({ scope: [folder, e('a')], picked: [] }, e('b'))
    assert.deepEqual(s.scope, [e('b')], 'pick replaces the scope')
    assert.deepEqual(m.findChips(s), [e('b')], 'the picked talk shows as a chip')
    s = m.pickTalk(s, e('c'))
    assert.deepEqual(s, { scope: [e('c')], picked: [key('c')] }, 'a second pick replaces the first')

    // ⌘↵ adds beside: appended, the open columns kept; adding one already open changes nothing.
    s = m.addTalkBeside(s, e('d'))
    assert.deepEqual(s.scope, [e('c'), e('d')], 'add-beside appends')
    assert.equal(m.rail.gridModeFor(s.scope.length, true), 'side', 'two talks: columns')
    const again = m.addTalkBeside(s, e('d'))
    assert.deepEqual(again.scope, s.scope, 'adding an open talk again never toggles it out')
    s = m.addTalkBeside(s, e('e'))
    assert.equal(m.rail.gridModeFor(s.scope.length, true), 'side', 'three talks: columns')
    // A fourth: exactly as ⌘-click does it — the scope takes it, and there is no fourth column.
    const fourth = m.addTalkBeside(s, e('f'))
    assert.deepEqual(fourth.scope, m.rail.toggleScope(s.scope, e('f'), true), 'a fourth goes where ⌘-click puts it')
    assert.equal(m.rail.gridModeFor(fourth.scope.length, true), 'outline', 'no fourth column (sequential, as for ⌘-click)')
    // Add beside keeps a tree-scoped talk and shows a chip only for the talk Find a talk added.
    const mixed = m.addTalkBeside({ scope: [e('tree-talk')], picked: [] }, e('g'))
    assert.deepEqual(mixed.scope, [e('tree-talk'), e('g')])
    assert.deepEqual(m.findChips(mixed), [e('g')], 'a talk the tree scoped shows no chip')

    // A chip's ×: that talk leaves the scope; the last chip gone leaves the picker unscoped.
    const two = { scope: [e('c'), e('d')], picked: [key('c'), key('d')] }
    const one = m.removeFindChip(two, key('c'))
    assert.deepEqual(one, { scope: [e('d')], picked: [key('d')] })
    assert.deepEqual(m.removeFindChip(one, key('d')), { scope: [], picked: [] }, 'removing the chip unscopes')

    // A pick whose talk left the scope another way stops being a chip.
    const replaced = { scope: [folder], picked: [key('c')] }
    assert.deepEqual(m.prunePicked(replaced), [])
    assert.deepEqual(m.findChips(replaced), [])
    const kept = { scope: [e('c')], picked: [key('c')] }
    assert.equal(m.prunePicked(kept), kept.picked, 'unchanged picks keep their identity (no re-render loop)')
    console.log('PASS scope: pick replaces, add-beside appends (a fourth as ⌘-click: no fourth column), chip removal clears')
  }

  // ── the keys the box keeps from the picker's grid keys ──
  {
    const own = (k, box) => m.findBoxOwnsKey(k, { value: '', listing: false, completing: false, ...box })
    assert.equal(own('ArrowDown', { value: 'claw', listing: true }), true, '↓ moves its own list')
    assert.equal(own('Enter', { value: 'claw', listing: true }), true, '↵ and ⌘↵ pick from its list, never insert')
    assert.equal(own('Escape', { value: 'claw', listing: true }), true, 'Esc clears its words first')
    assert.equal(own('Tab', { value: 'fo:', completing: true }), true, 'Tab completes')
    assert.equal(own('Tab', { value: 'claw', listing: true }), false, 'Tab otherwise cycles the picker')
    assert.equal(own('Escape', {}), false, 'an empty box leaves Esc to the picker (closes it)')
    assert.equal(own('ArrowDown', {}), false, 'an empty box leaves ↓ to the grid')
    assert.equal(own('Enter', {}), false, 'an empty box leaves ⌘↵ to insert')
    assert.equal(own('x', { value: 'claw', listing: true }), false)
    console.log('PASS keys: the box keeps ↑↓ ↵ Esc (and Tab while completing); an empty box leaves them to the picker')
  }

  // ── the rail: Find a talk above Search slides; the slide search offers no talk-name hits ──
  {
    const talks = listedTalks
    const props = {
      inputRef: { current: null }, query: 'claw', onQueryChange: () => {},
      find: { query: '', onQueryChange: () => {}, talks, currentTalkSlug: current, slidesOf: () => 5, chips: [], onPick: () => {}, onAddBeside: () => {}, onRemoveChip: () => {} },
      findActive: false,
      currentTalkSlug: current, scope: [], scopeCounts: [], coverUrlFor: () => null,
      onScope: () => {}, onRemoveScope: () => {}, onClearScope: () => {},
      filesSource: { talks: [], folders: [], vaultRoot: vault, sortKey: 'name', meta: {}, delivered: {}, slidesOf: () => 0, sectionsOf: () => [], currentTalkSlug: current },
      recentEdits: [], deliveries: [], facets: m.rail.emptyFacets(), layoutItems: [], contentItems: [], tagItems: [], sectionItems: [],
      onToggleFacet: () => {}, onClearFacets: () => {}, anyFacetOn: false
    }
    // The search-box hook sets the caret in a layout effect; a server render only warns about it.
    const consoleError = console.error
    console.error = (msg, ...rest) => { if (!String(msg).includes('useLayoutEffect does nothing on the server')) consoleError(msg, ...rest) }
    globalThis.window = { localStorage: { getItem: () => null, setItem: () => {} }, tw: { talks: { folderState: async () => ({}), setFolderState: async () => ({}) } } }
    const html = m.renderRail(props)
    const find = html.indexOf('Find a talk</div>')
    const slides = html.indexOf('Search slides</div>')
    assert.ok(find > 0 && slides > find, 'K1: "Find a talk" sits above "Search slides"')
    assert.match(html, /placeholder="Name, folder, event, date…"/)
    assert.match(html, /placeholder="Words on slides — all words match"/)
    assert.equal((html.match(/class="lt-searchfield rail"/g) ?? []).length, 1, 'one slide-search field')
    assert.equal((html.match(/data-find-talk="1"/g) ?? []).length, 1, 'one Find a talk field')
    assert.doesNotMatch(html, /Talks \(|lt-talk-hits|scope →/, 'the slide search offers no talk-name hits for "claw"')
    assert.equal(m.rail.talkTitleHits, undefined, 'the talk-name match is gone from the rail model')
    assert.doesNotMatch(html, /lt-browse-dim/, 'the tree is not dimmed while Find a talk is idle')

    const picked = m.renderRail({ ...props, find: { ...props.find, chips: [m.talkEntry({ slug: 'ai-2026-agents-files-in-folders', title: 'AI 2026: Agents = Files in folders' })] }, findActive: true })
    assert.match(picked, /class="lt-find-chip" data-chip-talk="ai-2026-agents-files-in-folders"/, 'K4: the picked talk is a chip in the box')
    assert.match(picked, /aria-label="Remove AI 2026: Agents = Files in folders from the scope"/, 'the chip has its ×')
    assert.match(picked, /value="claw"/, 'the slide search holds what it held')
    assert.match(picked, /class="lt-browse-dim"/, 'K3/K4: the tree dims under Find a talk')
    console.error = consoleError
    console.log('PASS rail: Find a talk above Search slides, no talk-name hits in the slide search, K4 chip, tree dimmed')
  }

  console.log('PASS find a talk: shared search, scope state, keys, rail')
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(vault, { recursive: true, force: true })
  rmSync(cacheDir, { recursive: true, force: true })
}
