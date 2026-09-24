import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installTestDom, TestKeyboardEvent } from './test-dom.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { SHORTCUT_REGISTRY, SHORTCUT_SCOPES, shortcutEventMatches } = await import(
  new URL('../src/shared/shortcut-registry.ts', import.meta.url)
)
const dom = installTestDom()
try {
  assert.equal(
    typeof shortcutEventMatches,
    'function',
    'the shortcut registry exposes platform-aware event matching for DOM-owned editors'
  )
  assert.equal(
    shortcutEventMatches(
      new TestKeyboardEvent('keydown', { key: 'Enter', metaKey: true }),
      'editor.object-finish'
    ),
    true,
    'Mod-Enter matches Command on macOS'
  )
  assert.equal(
    shortcutEventMatches(
      new TestKeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
      'editor.object-finish'
    ),
    true,
    'Mod-Enter matches Control on Windows and Linux'
  )
  assert.equal(
    shortcutEventMatches(
      new TestKeyboardEvent('keydown', { key: 'F8' }),
      'editor.object-finish',
      'F8'
    ),
    true,
    'an object-finish rebind takes effect in the DOM-owned shell'
  )
  assert.equal(
    shortcutEventMatches(
      new TestKeyboardEvent('keydown', { key: 'Enter', metaKey: true }),
      'editor.object-finish',
      'F8'
    ),
    false,
    'the replaced default no longer finishes after a rebind'
  )
  for (const modifier of ['metaKey', 'ctrlKey']) {
    assert.equal(
      shortcutEventMatches(
        new TestKeyboardEvent('keydown', { key: '/', [modifier]: true }),
        'app.help'
      ),
      true,
      `keyboard help accepts ${modifier === 'metaKey' ? 'Command' : 'Control'} + /`
    )
  }
} finally {
  dom.restore()
}
const rendererRegistry = readFileSync(join(root, 'src/renderer/src/keymap/registry.ts'), 'utf8')
const objectBlockField = readFileSync(
  join(root, 'src/renderer/src/extensions/objectBlocks/field.ts'),
  'utf8'
)

function declaredEditorCommands(source) {
  const block = source.match(/export const EDITOR_COMMANDS: EditorCommand\[\] = \[([\s\S]*?)\n\]/)?.[1] ?? ''
  return block.split('\n').flatMap((line) => {
    const commandId = line.match(/^\s*command\('([^']+)'/)?.[1]
    if (!commandId) return []
    const explicitRegistryId = line.match(/,\s*'([^']+)'\),?\s*$/)?.[1]
    return [{ id: commandId, registryId: explicitRegistryId ?? `editor.${commandId}` }]
  })
}

function declaredNonConsuming(source) {
  const body = source.match(/export const NON_CONSUMING = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ''
  return new Set([...body.matchAll(/'([^']+)'/g)].map((match) => match[1]))
}

const editorCommands = declaredEditorCommands(rendererRegistry)
const nonConsumingCommands = declaredNonConsuming(rendererRegistry)
assert.deepEqual(
  editorCommands
    .filter((command) => (
      command.registryId === 'editor.object-edit'
      || command.registryId === 'editor.title-continue'
      || command.registryId === 'editor.protected-line-continue'
      || command.registryId === 'editor.list-continue'
    ))
    .map((command) => command.id),
  ['object-edit', 'title-continue', 'protected-line-continue', 'list-continue'],
  'Enter fall-through chain follows EDITOR_COMMANDS declaration order: object before title before protected line before list'
)
assert.deepEqual(
  SHORTCUT_REGISTRY
    .filter((entry) => entry.id === 'editor.object-finish' || entry.id === 'editor.object-leave')
    .map((entry) => [entry.id, entry.codes]),
  [
    ['editor.object-finish', ['Mod-Enter']],
    ['editor.object-leave', ['Escape']]
  ],
  'object finish and commit-and-leave have editor-scope shortcut declarations'
)
assert.deepEqual(
  editorCommands
    .filter((command) => (
      command.registryId === 'editor.object-finish'
      || command.registryId === 'editor.object-leave'
    ))
    .map((command) => command.id),
  ['object-finish', 'object-leave'],
  'object finish and commit-and-leave route through EDITOR_COMMANDS for rebinding and discovery'
)
assert.equal(
  /key:\s*['"](?:Mod-Enter|Escape)['"]/.test(objectBlockField),
  false,
  'object finish and commit-and-leave are not hard-coded in the object-block extension'
)
assert.equal(
  objectBlockField.includes('// shortcut-id: browser.move editor.protect-heading-delete'),
  true,
  'the object-block binding comment names only the local arrow and deletion guards'
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
  SHORTCUT_REGISTRY.filter((entry) => entry.id.startsWith('presenter.poll-')).map((entry) => [entry.id, entry.keys]),
  [['presenter.poll-primary', 'Q'], ['presenter.poll-reveal', '⇧ Q'], ['presenter.poll-compose', 'K']],
  'Presenter poll click targets have registered and discoverable keyboard paths'
)
assert.deepEqual(
  SHORTCUT_REGISTRY.filter((entry) => entry.scope === 'pathway').map((entry) => entry.id),
  ['pathway.move', 'pathway.toggle', 'pathway.grid', 'pathway.list', 'pathway.matrix', 'pathway.previews', 'pathway.reorder', 'pathway.move-item', 'pathway.present', 'pathway.new', 'pathway.rename', 'pathway.delete', 'pathway.drop-missing', 'pathway.help'],
  'Pathway window keyboard parity is fully registered'
)
assert.deepEqual(
  SHORTCUT_REGISTRY.filter((entry) => entry.unbound).map((entry) => entry.id),
  ['editor.new-slide', 'editor.bulleted-list', 'editor.numbered-list', 'editor.italic', 'editor.inline-code', 'editor.highlight'],
  'unbound commands include the new slide and list actions alongside the existing text-formatting residents'
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

function sharedBindingConflicts(entries, commands, nonConsuming, directNonConsuming = new Set()) {
  const groups = new Map()
  for (const entry of entries) {
    if (entry.unbound) continue
    const pair = `${entry.scope}\0${entry.codes.join('|')}`
    const sharers = groups.get(pair) ?? []
    sharers.push(entry)
    groups.set(pair, sharers)
  }

  const conflicts = []
  for (const sharers of groups.values()) {
    if (sharers.length < 2) continue
    const idsInGroup = new Set(sharers.map((entry) => entry.id))
    const declarationChain = [
      ...commands.filter((command) => idsInGroup.has(command.registryId)),
      ...sharers
        .filter((entry) => directNonConsuming.has(entry.id))
        .map((entry) => ({ id: entry.id, registryId: entry.id }))
    ]
    const isDeterministicFallThrough =
      declarationChain.length === sharers.length
      && declarationChain.slice(0, -1).every((command) =>
        nonConsuming.has(command.id) || directNonConsuming.has(command.registryId)
      )
    if (isDeterministicFallThrough) continue
    for (const current of sharers.slice(1)) {
      conflicts.push(
        `conflict: ${sharers[0].id} and ${current.id} share (${current.scope}, ${current.codes.join(' / ')})`
      )
    }
  }
  return conflicts
}

assert.deepEqual(
  sharedBindingConflicts(
    [
      { id: 'editor.object-edit', scope: 'editor', codes: ['Enter'] },
      { id: 'editor.title-continue', scope: 'editor', codes: ['Enter'] },
      { id: 'editor.protected-line-continue', scope: 'editor', codes: ['Enter'] },
      { id: 'editor.list-continue', scope: 'editor', codes: ['Enter'] }
    ],
    [
      { id: 'object-edit', registryId: 'editor.object-edit' },
      { id: 'title-continue', registryId: 'editor.title-continue' },
      { id: 'protected-line-continue', registryId: 'editor.protected-line-continue' },
      { id: 'list-continue', registryId: 'editor.list-continue' }
    ],
    new Set(['object-edit', 'title-continue', 'protected-line-continue'])
  ),
  [],
  'a four-command chain is legal when every sharer except the last falls through'
)

assert.deepEqual(
  sharedBindingConflicts(
    [
      { id: 'editor.first-consuming', scope: 'editor', codes: ['Enter'] },
      { id: 'editor.second-consuming', scope: 'editor', codes: ['Enter'] }
    ],
    [
      { id: 'first-consuming', registryId: 'editor.first-consuming' },
      { id: 'second-consuming', registryId: 'editor.second-consuming' }
    ],
    new Set()
  ),
  ['conflict: editor.first-consuming and editor.second-consuming share (editor, Enter)'],
  'two consuming commands sharing a binding remain an illegal duplicate'
)

assert.deepEqual(
  sharedBindingConflicts(
    [
      { id: 'editor.rollback-trigger', scope: 'editor', codes: ['Escape'] },
      { id: 'editor.object-leave', scope: 'editor', codes: ['Escape'] }
    ],
    [{ id: 'object-leave', registryId: 'editor.object-leave' }],
    new Set(['object-leave']),
    new Set(['editor.rollback-trigger'])
  ),
  [],
  'the rollback trigger falls through first, then object leave handles Escape'
)

console.log('Registry hygiene:')
const legalScopes = new Set(SHORTCUT_SCOPES)
const ids = new Set()
for (const entry of SHORTCUT_REGISTRY) {
  if (!entry.id?.trim()) fail('entry missing id')
  else if (ids.has(entry.id)) fail(`duplicate id "${entry.id}"`)
  else ids.add(entry.id)
  if (!entry.keys?.trim()) fail(`${entry.id}: missing display keys`)
  if (!entry.unbound && (!Array.isArray(entry.codes) || entry.codes.length === 0 || entry.codes.some((code) => !code.trim()))) {
    fail(`${entry.id}: codes must be a non-empty string array`)
  }
  if (!legalScopes.has(entry.scope)) fail(`${entry.id}: illegal scope "${entry.scope}"`)
  if (!entry.label?.trim()) fail(`${entry.id}: missing label`)
  if (!entry.explanation?.trim()) fail(`${entry.id}: missing explanation`)
  if (!entry.group?.trim()) fail(`${entry.id}: missing group`)
}
const directEditorFallthrough = new Set(['editor.rollback-trigger'])
for (const conflict of sharedBindingConflicts(
  SHORTCUT_REGISTRY,
  editorCommands,
  nonConsumingCommands,
  directEditorFallthrough
)) fail(conflict)
if (failures === 0) ok(`${SHORTCUT_REGISTRY.length} entries are well-formed with no illegal binding conflicts`)

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
  ['src/preload/present-live-bridge.ts', ['presenter.live', 'presenter.close']],
  ['src/preload/present-recorder.ts', ['presenter.timer', 'presenter.close', 'presenter.next', 'presenter.previous']],
  ['src/renderer/src/App.tsx', ['app.sidebar-talks', 'app.sidebar-outline', 'app.sidebar-toggle', 'app.settings']],
  ['src/renderer/src/components/ArchiveImageSearch.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/CommandMenu.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/CommandPalette.tsx', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.toggle']],
  ['src/renderer/src/components/Editor.tsx', ['app.help', 'editor.rollback-trigger', 'editor.list-continue']],
  ['src/renderer/src/components/GridView.tsx', ['browser.move', 'browser.open']],
  ['src/renderer/src/components/History.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/Importer.tsx', ['importer.move', 'importer.flagged', 'importer.search', 'importer.apply', 'importer.reset', 'importer.views', 'importer.help', 'importer.close']],
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
  ['src/renderer/src/components/TalkText.tsx', ['talktext.notes', 'talktext.script', 'talktext.rewrite', 'talktext.show-slide', 'talktext.previous-slide', 'talktext.next-slide', 'talktext.copy', 'talktext.help', 'talktext.close']],
  ['src/renderer/src/components/TagPicker.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/WorkspaceLayout.tsx', ['app.slide-search', 'app.context-menu', 'app.layout-picker', 'app.icon-picker', 'app.image-search', 'app.where-used', 'app.slide-focus', 'app.command-palette', 'app.new-window', 'app.help', 'app.toggle-inspector', 'app.view-editor', 'app.view-split', 'app.view-strip', 'app.view-grid', 'app.present', 'app.present-current']],
  ['src/renderer/src/components/talklist/TalkList.tsx', ['browser.open']],
  ['src/renderer/src/components/talklist/menus.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/talklist/modals.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/talklist/useKeyboard.ts', ['browser.move', 'browser.open', 'browser.close', 'browser.talk-view', 'browser.talk-names', 'browser.filter', 'browser.sort', 'browser.rename', 'browser.duplicate', 'browser.move-talk', 'browser.delete-talk']],
  ['src/renderer/src/extensions/triggerComplete.ts', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.back', 'picker.digit']],
  ['src/renderer/src/extensions/idProtect.ts', ['editor.protect-heading-delete']],
  ['src/renderer/src/extensions/objectBlocks/field.ts', ['browser.move', 'editor.protect-heading-delete']],
  ['src/renderer/src/objects/shell.ts', ['app.help', 'editor.object-finish', 'editor.object-leave']],
  ['src/renderer/src/objects/table-editor.ts', ['picker.navigate', 'picker.close']]
])

// Generic handlers are deliberately not shortcut commands. Each ignored file must still produce a
// scan hit, so deleting the handler makes this list fail as stale.
const SCAN_IGNORE = new Map([
  ['src/renderer/src/components/actionBar/ActionBar.tsx', 'Escape only dismisses the visible tooltip or overflow menu; no shortcut is bound'],
  ['src/renderer/src/components/AbstractPanel.tsx', 'Escape-only modal dismissal and Enter on a native form control'],
  ['src/renderer/src/components/DeckDesignPanel.tsx', 'Escape-only modal dismissal'],
  ['src/renderer/src/components/EmbedCheckPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/ExplainPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/ImageMetaPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/KeyboardHelp.tsx', 'Escape only closes the shortcut dialog; the opening command is app.help'],
  ['src/renderer/src/components/LayoutDoctorPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/NewTalkDialog.tsx', 'Escape dismissal and native form Enter submission'],
  ['src/preload/present-close-flow.ts', 'Escape-only dismissal and a Tab focus trap inside the close-presentation dialog; no app shortcut is bound'],
  ['src/renderer/src/components/ToolbarMenu.tsx', 'Escape-only generic toolbar-menu dismissal'],
  ['src/renderer/src/extensions/frontmatterTable.ts', 'Escape-only dismissal of the metadata row\'s "?" help block (T27); no shortcut is bound'],
  ['src/renderer/src/components/WhereUsedPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/keymap/store.ts', 'keymap.of appears only in an explanatory comment; bindings are created from EDITOR_COMMANDS'],
  ['src/renderer/src/objects/chart-editor.ts', 'Outline-node Enter, Tab, arrow and Alt-arrow handling is local text-field editing semantics, not an app command'],
  ['src/renderer/src/objects/markmap-editor.ts', 'Outline-node Enter, Tab, arrow and Alt-arrow handling is local text-field editing semantics, not an app command'],
  ['src/shared/metadata-registry.ts', 'e.key is a metadata entry comparison, not a KeyboardEvent']
])

assert.deepEqual(
  BINDING_MAP.get('src/renderer/src/objects/table-editor.ts'),
  ['picker.navigate', 'picker.close'],
  'the column menu maps its arrow and Escape handling to the shared picker commands'
)
assert.equal(
  SCAN_IGNORE.has('src/renderer/src/objects/table-editor.ts'),
  false,
  'the table editor no longer hides all keyboard handling behind a blanket scan ignore'
)
assert.equal(
  SCAN_IGNORE.has('src/renderer/src/objects/markmap-editor.ts'),
  true,
  'the markmap text-field transformations keep their narrow local-semantics justification'
)
assert.equal(
  BINDING_MAP.get('src/renderer/src/components/Editor.tsx')?.includes('app.help'),
  true,
  'the object-editor help hook is declared in the Editor binding map'
)

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

assert(!rendererRegistry.includes('APP_SHORTCUTS'), 'APP_SHORTCUTS hand-maintained list must be removed')

// T27: ⌘⇧P is owned by an explicit, palette-hidden, toolbar-placed command — never the generic
// shortcut-only fallthrough — so the Tools menu and the capture-phase key share one handler.
const { COMMAND_REGISTRY: commandRegistry } = await import(new URL('../src/shared/command-registry.ts', import.meta.url))
const paletteShortcutCommands = commandRegistry.filter((entry) => entry.shortcutId === 'app.command-palette')
assert.equal(paletteShortcutCommands.length, 1, 'app.command-palette is registered exactly once (no fallthrough duplicate)')
assert.equal(paletteShortcutCommands[0].handlerId, 'app.command-palette', 'the ⌘⇧P command dispatches through its own handler id')
assert.equal(paletteShortcutCommands[0].palette.visible, false, 'the palette does not list itself')
assert.equal(paletteShortcutCommands[0].toolbar?.menu, 'tools', '⌘⇧P lives in the Tools menu as All commands…')

const { renderTemplateWithShortcutHelp } = await import('./build-shortcut-help.mjs')
const templatePath = join(root, 'compiler/assets/templates/presenter-popup-single-html.html')
const template = readFileSync(templatePath, 'utf8')
assert.equal(template, await renderTemplateWithShortcutHelp(template), 'Generated presenter shortcut help is stale')

if (failures > 0) {
  console.error(`\ntest-shortcut-registry: ${failures} failure(s).`)
  process.exit(1)
}
console.log('\ntest-shortcut-registry: all checks passed.')
