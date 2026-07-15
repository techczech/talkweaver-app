import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { SHORTCUT_REGISTRY, SHORTCUT_SCOPES } = await import(
  new URL('../src/shared/shortcut-registry.ts', import.meta.url)
)
assert.equal(
  SHORTCUT_REGISTRY.some((entry) => entry.id === 'app.toggle-inspector' && entry.keys === '⌘P'),
  true,
  'app shortcut registry declares Toggle Inspector on ⌘P'
)
assert.equal(
  SHORTCUT_REGISTRY.some((entry) => entry.id === 'app.pathways' && entry.keys === '⌘⌥P' && entry.codes.includes('Mod-Alt-p')),
  true,
  'app shortcut registry declares Pathway view on the free mnemonic ⌘⌥P chord'
)
assert.deepEqual(
  SHORTCUT_REGISTRY.filter((entry) => entry.scope === 'pathway').map((entry) => entry.id),
  ['pathway.move', 'pathway.toggle', 'pathway.grid', 'pathway.list', 'pathway.matrix', 'pathway.previews', 'pathway.reorder', 'pathway.move-item', 'pathway.present', 'pathway.new', 'pathway.rename', 'pathway.delete', 'pathway.drop-missing', 'pathway.help'],
  'Pathway window keyboard parity is fully registered'
)
assert.deepEqual(
  SHORTCUT_REGISTRY.find((entry) => entry.id === 'pathway.list'),
  {
    id: 'pathway.list', keys: 'L', codes: ['l'], scope: 'pathway', label: 'List view',
    explanation: 'Shows the pathway as a numbered running order with slide previews', group: 'View'
  },
  'Pathway List command uses the locked L binding and description'
)
assert.deepEqual(
  SHORTCUT_REGISTRY.find((entry) => entry.id === 'pathway.previews'),
  {
    id: 'pathway.previews', keys: 'P', codes: ['p'], scope: 'pathway', label: 'Toggle previews',
    explanation: 'Show or hide slide previews in List and Matrix.', group: 'View'
  },
  'Pathway Previews command uses the free pathway-scope P binding'
)

let failures = 0
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`) }
const ok = (message) => console.log(`  ✓ ${message}`)

console.log('Registry hygiene:')
const legalScopes = new Set(SHORTCUT_SCOPES)
const ids = new Set()
const pairs = new Map()
for (const entry of SHORTCUT_REGISTRY) {
  if (!entry.id?.trim()) fail('entry missing id')
  else if (ids.has(entry.id)) fail(`duplicate id "${entry.id}"`)
  else ids.add(entry.id)
  if (!entry.keys?.trim()) fail(`${entry.id}: missing display keys`)
  if (!Array.isArray(entry.codes) || entry.codes.length === 0 || entry.codes.some((code) => !code.trim())) {
    fail(`${entry.id}: codes must be a non-empty string array`)
  }
  if (!legalScopes.has(entry.scope)) fail(`${entry.id}: illegal scope "${entry.scope}"`)
  if (!entry.label?.trim()) fail(`${entry.id}: missing label`)
  if (!entry.explanation?.trim()) fail(`${entry.id}: missing explanation`)
  if (!entry.group?.trim()) fail(`${entry.id}: missing group`)
  const pair = `${entry.scope}\0${entry.codes.join('|')}`
  const previous = pairs.get(pair)
  if (previous) fail(`conflict: ${previous} and ${entry.id} share (${entry.scope}, ${entry.codes.join(' / ')})`)
  else pairs.set(pair, entry.id)
}
if (failures === 0) ok(`${SHORTCUT_REGISTRY.length} entries are well-formed and conflict-free`)

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

// Files with real commands map to one or more declared ids. Context-local arrow/Enter/Escape
// handling shares the generic browser/picker declarations instead of inventing duplicate commands.
const BINDING_MAP = new Map([
  ['src/main/index.ts', ['app.toggle-inspector']],
  ['src/preload/present-edit-bridge.ts', ['app.deck-edit']],
  ['src/preload/present-recorder.ts', ['presenter.timer', 'presenter.close', 'presenter.next', 'presenter.previous']],
  ['src/renderer/src/App.tsx', ['app.sidebar-talks', 'app.sidebar-outline', 'app.sidebar-toggle', 'app.settings']],
  ['src/renderer/src/components/ArchiveImageSearch.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/CommandMenu.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/CommandPalette.tsx', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.toggle']],
  ['src/renderer/src/components/Editor.tsx', ['editor.rollback-trigger', 'editor.list-continue']],
  ['src/renderer/src/components/GridView.tsx', ['browser.move', 'browser.open']],
  ['src/renderer/src/components/History.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/IconPicker.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/Inspector.tsx', ['app.inspector-slides', 'app.inspector-steps']],
  ['src/renderer/src/components/InsertViewer.tsx', ['browser.move', 'browser.open', 'browser.close', 'browser.insert', 'browser.toggle-selection']],
  ['src/renderer/src/components/MergeConfirm.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/MetadataPanel.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/Pathways.tsx', ['pathway.move', 'pathway.toggle', 'pathway.grid', 'pathway.list', 'pathway.matrix', 'pathway.previews', 'pathway.reorder', 'pathway.move-item', 'pathway.present', 'pathway.new', 'pathway.rename', 'pathway.delete', 'pathway.drop-missing', 'pathway.help']],
  ['src/renderer/src/components/PropagationChecklist.tsx', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.toggle']],
  ['src/renderer/src/components/SearchPalette.tsx', ['browser.move', 'browser.insert', 'browser.preview', 'browser.toggle-selection', 'browser.close']],
  ['src/renderer/src/components/SettingsPanel.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/SlideBrowser.tsx', ['browser.move', 'browser.open', 'browser.close', 'browser.insert', 'browser.toggle-selection', 'browser.tags', 'browser.preview', 'browser.rail', 'browser.edit-source', 'browser.where-used', 'browser.clear-scope']],
  ['src/renderer/src/components/SlideFocus.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/SlidesOrganizer.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/Studio.tsx', ['app.help', 'browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/TagPicker.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/WorkspaceLayout.tsx', ['app.slide-search', 'app.context-menu', 'app.layout-picker', 'app.icon-picker', 'app.image-search', 'app.where-used', 'app.slide-focus', 'app.command-palette', 'app.new-window', 'app.help', 'app.toggle-inspector', 'app.view-editor', 'app.view-split', 'app.view-strip', 'app.view-grid', 'app.present', 'app.present-current']],
  ['src/renderer/src/components/talklist/TalkList.tsx', ['browser.open']],
  ['src/renderer/src/components/talklist/menus.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/talklist/modals.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/talklist/useKeyboard.ts', ['browser.move', 'browser.open', 'browser.close', 'browser.talk-view', 'browser.talk-names', 'browser.filter', 'browser.sort', 'browser.rename', 'browser.duplicate', 'browser.move-talk', 'browser.delete-talk']],
  ['src/renderer/src/extensions/triggerComplete.ts', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.back', 'picker.digit']],
  ['src/renderer/src/extensions/idProtect.ts', ['editor.protect-heading-delete']]
])

// Generic handlers are deliberately not shortcut commands. Each ignored file must still produce a
// scan hit, so deleting the handler makes this list fail as stale.
const SCAN_IGNORE = new Map([
  ['src/renderer/src/components/AbstractPanel.tsx', 'Escape-only modal dismissal and Enter on a native form control'],
  ['src/renderer/src/components/DeckDesignPanel.tsx', 'Escape-only modal dismissal'],
  ['src/renderer/src/components/EmbedCheckPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/ExplainPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/ImageMetaPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/KeyboardHelp.tsx', 'Escape only closes the shortcut dialog; the opening command is app.help'],
  ['src/renderer/src/components/NewTalkDialog.tsx', 'Escape dismissal and native form Enter submission'],
  ['src/renderer/src/components/ToolbarMenu.tsx', 'Escape-only generic toolbar-menu dismissal'],
  ['src/renderer/src/components/WhereUsedPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/keymap/store.ts', 'keymap.of appears only in an explanatory comment; bindings are created from EDITOR_COMMANDS'],
  ['src/shared/metadata-registry.ts', 'e.key is a metadata entry comparison, not a KeyboardEvent']
])

const patterns = [
  ['keymap.of', /keymap\.of\s*\(/g],
  ['accelerator', /accelerator\s*:/g],
  ['addEventListener:keydown', /addEventListener\s*\(\s*['"]keydown['"]/g],
  ['e.key', /\b(?:e|event)\.key\s*===/g]
]
const hits = []
for (const file of walk(join(root, 'src'))) {
  const source = readFileSync(file, 'utf8')
  const rel = relative(root, file)
  const lines = source.split('\n')
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length
      hits.push({ rel, line, kind })
    }
  }
}

console.log('Static scan (src keyboard binding sites):')
let covered = 0
let declaredCount = 0
let ignoredCount = 0
for (const hit of hits) {
  const declared = BINDING_MAP.get(hit.rel)
  if (declared) {
    covered += 1
    declaredCount += 1
    for (const id of declared) if (!ids.has(id)) fail(`${hit.rel}:${hit.line}: mapped shortcut id "${id}" is not declared`)
    continue
  }
  if (SCAN_IGNORE.has(hit.rel)) {
    covered += 1
    ignoredCount += 1
    continue
  }
  fail(`${hit.rel}:${hit.line}: ${hit.kind} binding site has no nearby shortcut-id declaration or SCAN_IGNORE justification`)
}
for (const [file] of [...BINDING_MAP, ...SCAN_IGNORE]) {
  if (!hits.some((hit) => hit.rel === file)) fail(`stale binding map or SCAN_IGNORE entry "${file}"`)
}
if (covered === hits.length) ok(`${hits.length} binding sites found; ${declaredCount} declared, ${ignoredCount} explicitly ignored`)

const rendererRegistry = readFileSync(join(root, 'src/renderer/src/keymap/registry.ts'), 'utf8')
assert(!rendererRegistry.includes('APP_SHORTCUTS'), 'APP_SHORTCUTS hand-maintained list must be removed')

const { renderTemplateWithShortcutHelp } = await import('./build-shortcut-help.mjs')
const templatePath = join(root, 'compiler/assets/templates/presenter-popup-single-html.html')
const template = readFileSync(templatePath, 'utf8')
assert.equal(template, await renderTemplateWithShortcutHelp(template), 'Generated presenter shortcut help is stale')

if (failures > 0) {
  console.error(`\ntest-shortcut-registry: ${failures} failure(s).`)
  process.exit(1)
}
console.log('\ntest-shortcut-registry: all checks passed.')
