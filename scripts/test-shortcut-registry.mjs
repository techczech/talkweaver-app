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
  ['editor.new-slide', 'editor.bulleted-list', 'editor.numbered-list', 'editor.italic', 'editor.inline-code', 'editor.highlight', 'editor.strikethrough', 'editor.underline'],
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
  for (const group of groups.values()) {
    // A direct fall-through acts only in its own narrow state and otherwise leaves the key to the
    // rest of the group (its surface's handler checks it first), so it claims nothing from them.
    // (Talk search 08: a DOM surface's fall-through — the picker's add-beside, close-beside,
    // remove-chip — may share its key with a consuming DOM command, not only with an editor one.)
    const sharers = group.filter((entry) => !directNonConsuming.has(entry.id))
    if (sharers.length < 2) continue
    const idsInGroup = new Set(sharers.map((entry) => entry.id))
    const declarationChain = commands.filter((command) => idsInGroup.has(command.registryId))
    const isDeterministicFallThrough =
      declarationChain.length === sharers.length
      && declarationChain.slice(0, -1).every((command) => nonConsuming.has(command.id))
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

// Talk search 08: a DOM fall-through beside a consuming DOM command is legal; two consuming DOM
// commands on one key in one scope are still a conflict.
assert.deepEqual(
  sharedBindingConflicts(
    [
      { id: 'slide-picker.insert', scope: 'slide-picker', codes: ['Mod-Enter'] },
      { id: 'slide-picker.add-beside', scope: 'slide-picker', codes: ['Mod-Enter'] }
    ],
    [],
    new Set(),
    new Set(['slide-picker.add-beside'])
  ),
  [],
  'add beside falls through to insert outside the Find a talk box'
)
assert.deepEqual(
  sharedBindingConflicts(
    [
      { id: 'slide-picker.select-section', scope: 'slide-picker', codes: ['s'] },
      { id: 'slide-picker.sort', scope: 'slide-picker', codes: ['s'] }
    ],
    [],
    new Set()
  ),
  ['conflict: slide-picker.select-section and slide-picker.sort share (slide-picker, s)'],
  'two consuming DOM commands on one key in one scope remain an illegal duplicate (the S conflict, had both stayed in one scope)'
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
// A command in this set acts only in its own narrow state and otherwise leaves its key to the other
// commands sharing it (its handler checks it first and falls through).
const directEditorFallthrough = new Set([
  'editor.rollback-trigger',
  // Talk search 08, the slide picker. Add beside acts only in Find a talk while it lists talks;
  // elsewhere ⌘↵ inserts the selected slides.
  'slide-picker.add-beside',
  // Esc closes the talk beside as one step of the picker's close ladder (slide-picker.close).
  'slide-picker.close-beside',
  // ⌫ removes a talk chip only in an empty Find a talk box; elsewhere it clears the rail's scope.
  'slide-picker.remove-chip',
  // 0.38 ticket 13: Z is the slide's zoom. The presenter's handler gives it to the picture where
  // the slide has one (presenter.gallery); the embedded page takes it only on a slide with a page
  // and no picture.
  'presenter.embed-fullscreen',
  // 0.38 ticket 08: ⌘Z undoes the Pen's last stroke only while the pen is on; the board panel,
  // while it shows, takes ⌘Z first (presenter.board-undo).
  'presenter.ink-undo'
])
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
  ['src/main/index.ts', ['app.toggle-inspector', 'presenter.refresh', 'presenter.audience']],
  ['src/preload/present-edit-bridge.ts', ['presenter.edit']],
  ['src/preload/present-live-bridge.ts', ['presenter.live', 'presenter.close']],
  ['src/preload/present-rec-ui.ts', ['presenter.record', 'presenter.record-pause', 'presenter.save-run-as', 'presenter.save-run', 'presenter.close', 'presenter.next', 'presenter.previous']],
  ['src/renderer/src/App.tsx', ['app.sidebar-talks', 'app.sidebar-outline', 'app.sidebar-toggle', 'app.settings']],
  ['src/renderer/src/components/ArchiveImageSearch.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/CommandMenu.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  // The option controls the Inspector draws (the file no longer holds the ⌘L palette): ← → Space Enter within a group.
  ['src/renderer/src/components/CommandPalette.tsx', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.toggle']],
  ['src/renderer/src/components/Editor.tsx', ['app.help', 'editor.rollback-trigger', 'editor.list-continue']],
  ['src/renderer/src/components/GridView.tsx', ['browser.move', 'browser.open']],
  // The docked layout picker (ADR-0032): its own scope, the keyboard map of the locked mockup.
  ['src/renderer/src/components/LayoutPickerColumn.tsx', ['layout-picker.try', 'layout-picker.along', 'layout-picker.next-group', 'layout-picker.keep', 'layout-picker.keep-starter', 'layout-picker.put-back']],
  ['src/renderer/src/components/History.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/Importer.tsx', ['importer.move', 'importer.flagged', 'importer.search', 'importer.apply', 'importer.reset', 'importer.views', 'importer.help', 'importer.close']],
  ['src/renderer/src/components/IconPicker.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/Inspector.tsx', ['app.inspector-slides', 'app.inspector-steps']],
  // The Inspector's option pictures (ADR-0032 §7): ← → within a group, ↵/Space choose — the same keys as its other option controls.
  ['src/renderer/src/components/InspectorOptionPictures.tsx', ['picker.navigate', 'picker.choose', 'picker.toggle']],
  ['src/renderer/src/components/InsertViewer.tsx', ['browser.move', 'browser.open', 'browser.close', 'browser.insert', 'browser.toggle-selection']],
  ['src/renderer/src/components/MergeConfirm.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/MetadataPanel.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/Pathways.tsx', ['pathway.move', 'pathway.toggle', 'pathway.grid', 'pathway.list', 'pathway.matrix', 'pathway.previews', 'pathway.reorder', 'pathway.move-item', 'pathway.present', 'pathway.new', 'pathway.rename', 'pathway.delete', 'pathway.drop-missing', 'pathway.help']],
  ['src/renderer/src/components/PropagationChecklist.tsx', ['picker.navigate', 'picker.choose', 'picker.close', 'picker.toggle']],
  ['src/renderer/src/components/SearchPalette.tsx', ['browser.move', 'browser.insert', 'browser.preview', 'browser.toggle-selection', 'browser.close']],
  ['src/renderer/src/components/SettingsPanel.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  // The ⌘S slide picker: its own scope; the key-truth check below holds it to exactly these keys.
  ['src/renderer/src/components/slide-browser/useSlideBrowserKeys.ts', ['slide-picker.move', 'slide-picker.extend', 'slide-picker.view', 'slide-picker.tab', 'slide-picker.close', 'slide-picker.clear-scope', 'slide-picker.toggle-selection', 'slide-picker.select-section', 'slide-picker.insert', 'slide-picker.select-whole-section', 'slide-picker.tags', 'slide-picker.preview', 'slide-picker.versions', 'slide-picker.near', 'slide-picker.density', 'slide-picker.rail', 'slide-picker.talk-beside', 'slide-picker.close-beside']],
  ['src/renderer/src/components/SlideFocus.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/SlidesOrganizer.tsx', ['browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/Studio.tsx', ['app.help', 'browser.move', 'browser.open', 'browser.close']],
  ['src/renderer/src/components/TalkText.tsx', ['talktext.notes', 'talktext.script', 'talktext.rewrite', 'talktext.show-slide', 'talktext.previous-slide', 'talktext.next-slide', 'talktext.copy', 'talktext.help', 'talktext.close']],
  ['src/renderer/src/components/TagPicker.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/WorkspaceLayout.tsx', ['app.slide-search', 'app.find-talk', 'app.context-menu', 'app.layout-picker', 'app.icon-picker', 'app.image-search', 'app.where-used', 'app.slide-focus', 'app.command-palette', 'app.new-window', 'app.help', 'app.toggle-inspector', 'app.view-editor', 'app.view-split', 'app.view-strip', 'app.view-grid', 'app.present', 'app.present-current']],
  ['src/renderer/src/components/talklist/TalkList.tsx', ['browser.open']],
  // Talk search completion (ADR-0029 §2): ↑↓ move, ↵/Tab complete, Esc dismisses — a picker.
  ['src/renderer/src/components/talklist/SearchAssist.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  // Find a talk (talk search 05): ↑↓ move its results, ↵ shows a talk, Esc clears; ⌘↵ adds beside
  // and ⌫ in the empty box removes the last chip (talk search 08).
  ['src/renderer/src/components/browser-rail/FindTalk.tsx', ['picker.navigate', 'picker.choose', 'picker.close', 'slide-picker.add-beside', 'slide-picker.remove-chip']],
  ['src/renderer/src/components/talklist/menus.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/talklist/modals.tsx', ['picker.navigate', 'picker.choose', 'picker.close']],
  ['src/renderer/src/components/talklist/useKeyboard.ts', ['browser.move', 'browser.open', 'browser.close', 'browser.talk-view', 'browser.talk-names', 'browser.filter', 'browser.sort', 'browser.open-talk', 'browser.up-level', 'browser.fold-all', 'browser.rename', 'browser.duplicate', 'browser.move-talk', 'browser.delete-talk']],
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
  ['src/renderer/src/components/InspectorBoard.tsx', 'The Board section’s fields keep their own typing (Enter stays in the one-line instructions; ↑ ↓ on a column’s handle moves that column, ADR-0032 round-3 A2); ⌥↑/⌥↓ still reach the Inspector’s slide navigation; no shortcut is bound'],
  ['src/renderer/src/components/ReactionsControl.tsx', 'Enter on the native custom-labels field commits it (ticket 04); no shortcut is bound'],
  ['src/renderer/src/components/EmbedCheckPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/ExplainPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/extensions/imageFullScreenPreview.ts', 'Escape-only dismissal of the full-screen image view; no shortcut is bound'],
  ['src/renderer/src/components/ImageMetaPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/KeyboardHelp.tsx', 'Escape only closes the shortcut dialog; the opening command is app.help'],
  ['src/renderer/src/components/LayoutDoctorPanel.tsx', 'Escape-only panel dismissal'],
  ['src/renderer/src/components/NewTalkDialog.tsx', 'Escape dismissal and native form Enter submission'],
  ['src/renderer/src/components/OutlineDiskChangeBar.tsx', 'Escape-only dismissal of the changed-on-disk sheet (answers Stay here); no shortcut is bound'],
  ['src/preload/present-close-flow.ts', 'Escape-only dismissal and a Tab focus trap inside the close-presentation dialog; no app shortcut is bound'],
  ['src/renderer/src/components/ToolbarMenu.tsx', 'Escape-only generic toolbar-menu dismissal'],
  ['src/renderer/src/components/slide-browser/TopBar.tsx', 'Enter on the settings-glimpse gear (a role=button div) toggles its popover; no shortcut is bound'],
  ['src/renderer/src/components/talklist/VaultSheet.tsx', 'Escape dismissal and Cmd+Enter to submit the Add vault / Edit this vault sheet (several-vaults ticket 04, modal, local); no shortcut is bound'],
  ['src/renderer/src/components/ConflictCompare.tsx', 'Escape-only dismissal of the conflict compare screen (several-vaults ticket 10; same as Cancel, writes nothing); no shortcut is bound'],
  ['src/renderer/src/components/talklist/ShowFilter.tsx', 'Escape-only dismissal of the Show menu popover (several-vaults ticket 07); no shortcut is bound'],
  ['src/renderer/src/components/PlanRunSheet.tsx', 'Escape dismissal, Enter in the event field and Cmd+Enter to save in the plan sheet (modal, local)'],
  ['src/renderer/src/components/RunStatusChips.tsx', 'Escape-only dismissal of the Run chip popover'],
  ['src/renderer/src/components/HistoryRunBoard.tsx', 'Escape-only dismissal of the Copy as Markdown popover and the share-link dialog (feedback-boards ticket 06); no shortcut is bound'],
  ['src/preload/present-end-live-boards.ts', 'Escape cancels and Enter confirms the End live board question (D20, modal, local); no app shortcut is bound'],
  ['src/renderer/src/components/ShareSheet.tsx', 'Escape-only share-sheet dismissal (share for comments)'],
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

// ── Presenter key truth (presenter redesign ticket 07) ──────────────────────────────────────────
// The presenter's ? sheet and command palette list the registry's presenter scope, so that scope
// must be exactly the keys the presenter binds. Every key comparison in the presenter's key
// handlers (the template's handleKey as it runs in the presenter, the palette's own keys, and the
// preloads' handlers) must be claimed below by a registry id, or marked as not reaching the
// presenter (`!isPresenter`); every presenter-scope entry must be claimed by a binding that
// exists. A listed key with no binding fails ("listed but not bound"); a binding with no listed
// key fails ("bound but not listed").
console.log('Presenter key truth:')
const { deckWindowKeyAction } = await import(new URL('../src/main/deck-window-keys.ts', import.meta.url))
const { PRESENTER_KEY_NEEDS } = await import(new URL('../src/shared/presenter-palette.ts', import.meta.url))
const presenterTemplate = readFileSync(join(root, 'compiler/assets/templates/presenter-popup-single-html.html'), 'utf8')
function sourceRegion(source, from, to, { skipBlocks = [] } = {}) {
  const start = source.indexOf(from)
  if (start < 0) return null
  const end = source.indexOf(to, start + from.length)
  if (end < 0) return null
  let text = source.slice(start, end + to.length)
  // Blocks that never run in the presenter (the audience branch): cut from their opening brace
  // to the matching closing one.
  for (const opener of skipBlocks) {
    const at = text.indexOf(opener)
    if (at < 0) return null
    let depth = 0
    let i = at + opener.length - 1
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') { depth -= 1; if (depth === 0) break }
    }
    text = text.slice(0, at) + text.slice(i + 1)
  }
  return text
}
const PRESENTER_KEY_REGIONS = [
  ['template handleKey', presenterTemplate, 'function handleKey(event) {', 'else if (isPresenter) return;', { skipBlocks: ['if (isAudience) {'] }],
  ['template isTalkQrKey', presenterTemplate, 'function isTalkQrKey(event) {', '\n  }'],
  ['template paletteKey', presenterTemplate, 'function paletteKey(event) {', '\n  }'],
  // ⌘V is the system paste: the presenter binds the paste event, not a key.
  ['template paste', presenterTemplate, "window.addEventListener('paste', (event) => {", '\n  });'],
  ['present-rec-ui', readFileSync(join(root, 'src/preload/present-rec-ui.ts'), 'utf8'), "window.addEventListener('keydown', (e: KeyboardEvent) => {", '}, true)'],
  ['present-live-bridge', readFileSync(join(root, 'src/preload/present-live-bridge.ts'), 'utf8'), "window.addEventListener('keydown', (event) => {", '}, true)'],
  ['present-edit-bridge', readFileSync(join(root, 'src/preload/present-edit-bridge.ts'), 'utf8'), "'keydown',", 'true\n  )'],
  ['deck-window-keys', readFileSync(join(root, 'src/main/deck-window-keys.ts'), 'utf8'), 'export function', '\n}'],
  // The board panel (feedback-boards ticket 05): inlined into the presenter template, so its keys are
  // the template's own (no preload needed).
  ['template board panel', readFileSync(join(root, 'compiler/assets/runtime/board-panel.js'), 'utf8'), 'function boardUndoKey(event) {', '\n  return {']
]
const KEY_COMPARISON = /event\.key\.toLowerCase\(\) === 'i'|\b(?:key|code|e\.key|event\.key|event\.code|input\.key)(?:\.toLowerCase\(\))?\s*[!=]==\s*['"]|\.test\((?:key|e\.key|event\.key)\)|new Set\(\[\s*["']|(?<!function )isTalkQrKey\(event\)|addEventListener\('paste'/
// [region, line pattern, registry ids]. An empty id list needs `!isPresenter` in the line.
const PRESENTER_KEY_CLAIMS = [
  ['template handleKey', /event\.metaKey && event\.shiftKey && !event\.altKey && event\.key\.toLowerCase\(\) === 'p'/, ['presenter.command-palette']],
  ['template handleKey', /event\.metaKey && event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === 'i'/, ['presenter.instant-compose']],
  ['template handleKey', /event\.key === ["']Escape["']/, ['presenter.close']],
  // ↵ in the instant and Quick-poll composers acts as their Show / Open poll button: composer-local.
  ['template handleKey', /event\.key === ["']Enter["'] && !event\.shiftKey/, ['picker.choose']],
  ['template handleKey', /instantActive && event\.key === 'ArrowRight'/, ['presenter.instant-return']],
  ['template handleKey', /event\.key === "F5"/, ['presenter.audience']],
  ['template handleKey', /event\.key === "\?"/, ['presenter.help']],
  ['template handleKey', /key === "k" \|\| key === "K"/, ['presenter.poll-compose']],
  ['template handleKey', /key === "a" \|\| key === "A"/, ['presenter.questions']],
  ['template handleKey', /key === "q" \|\| key === "Q"/, ['presenter.poll-primary', 'presenter.poll-reveal']],
  ['template handleKey', /const nextKeys = |const nextCodes = /, ['presenter.next']],
  ['template handleKey', /const previousKeys = |const previousCodes = /, ['presenter.previous']],
  // While the talk QR is up: Esc or U return; navigation is swallowed there.
  ['template handleKey', /key === "Escape" \|\| \(isPresenter && isTalkQrKey\(event\)\)/, ['presenter.close', 'presenter.talk-qr']],
  ['template handleKey', /if \(isNextKey \|\| isPreviousKey \|\| key === "Home" \|\| key === "End"\)/, ['presenter.talk-qr']],
  ['template handleKey', /if \(isPresenter && isTalkQrKey\(event\)\)/, ['presenter.talk-qr']],
  ['template handleKey', /key === "Escape" \|\| key === "Enter" \|\| key === " " \|\| code === "Space"\) \{ event\.preventDefault\(\); closeQrFullscreen/, ['presenter.close']],
  // The open gallery: Esc / Z close, V full screen, Home / End first and last image.
  ['template handleKey', /key === "Escape" \|\| key === "z" \|\| key === "Z"/, ['presenter.gallery', 'presenter.close']],
  ['template handleKey', /\(key === "v" \|\| key === "V"\) && slideVideos\(\)\.length > 0\) \{ event\.preventDefault\(\); videoFullscreenCommand\(\); return; \}/, ['presenter.video-fullscreen']],
  ['template handleKey', /if \(key === "(?:Home|End)"\) \{ event\.preventDefault\(\); publish\(\{ lightbox/, ['presenter.gallery']],
  ['template handleKey', /key === "Escape" && interactingFrame/, ['presenter.close']],
  // Esc puts the slide back when its embedded page is full screen and not in use (ticket 13).
  ['template handleKey', /key === "Escape" && embedFullScreenOn\(\)/, ['presenter.close']],
  ['template handleKey', /key === "e" \|\| key === "E"/, ['presenter.embed']],
  ['template handleKey', /\/\^\[1-9\]\$\/\.test\(key\)/, ['presenter.grid-child']],
  ['template handleKey', /isPresenter && key === "Escape"/, ['presenter.close']],
  ['template handleKey', /key === "j" \|\| key === "J"/, ['presenter.notes-scroll']],
  ['template handleKey', /\.presenter-notes-more/, ['presenter.notes-scroll']],
  ['template handleKey', /key === "r" \|\| key === "R"/, ['presenter.reveal']],
  ['template handleKey', /key === "f" \|\| key === "F"/, ['presenter.focus']],
  ['template handleKey', /if \(key === "Escape"\) \{ event\.preventDefault\(\); exitMode/, ['presenter.close']],
  ['template handleKey', /if \(key === "Home"\) \{ event\.preventDefault\(\); goTo\(0, 0\)|else if \(key === "Home"\)/, ['presenter.first']],
  ['template handleKey', /if \(key === "End"\) \{ event\.preventDefault\(\); goTo\(total - 1, 0\)|else if \(key === "End"\)/, ['presenter.last']],
  ['template handleKey', /isPresenter && key === "\+"/, ['presenter.font-larger']],
  ['template handleKey', /isPresenter && key === "-"/, ['presenter.font-smaller']],
  ['template handleKey', /key === "o" \|\| key === "O"/, ['presenter.overview']],
  ['template handleKey', /isPresenter && key === "[[\]]"/, ['presenter.preview-size']],
  ['template handleKey', /key === "t" \|\| key === "T"/, ['presenter.duration']],
  ['template handleKey', /key === "p" \|\| key === "P"/, ['presenter.timer']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'i'/, ['presenter.pointer']],
  ['template handleKey', /event\.key === 'Escape' && pointerArmed/, ['presenter.close']],
  // The Pen (0.38 ticket 08): Esc abandons a drag or turns it off; D, W / ⇧W, X / ⇧X, ⌘Z while on.
  ['template handleKey', /event\.key === 'Escape' && penArmed/, ['presenter.close']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'd'/, ['presenter.pen']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'w'/, ['presenter.pen-tool']],
  ['template handleKey', /event\.key\.toLowerCase\(\) === 'x'/, ['presenter.ink-clear', 'presenter.ink-clear-all']],
  ['template handleKey', /penArmed && \(event\.metaKey \|\| event\.ctrlKey\).*event\.key\.toLowerCase\(\) === 'z'/, ['presenter.ink-undo']],
  ['template handleKey', /key === "h" \|\| key === "H"/, ['presenter.highlight']],
  ['template handleKey', /key === "m" \|\| key === "M"/, ['presenter.media']],
  ['template handleKey', /isPresenter && \(key === "z" \|\| key === "Z"\)/, ['presenter.gallery', 'presenter.embed-fullscreen']],
  ['template handleKey', /isPresenter && \(key === "v" \|\| key === "V"\)/, ['presenter.video-fullscreen']],
  ['template handleKey', /key === "s" \|\| key === "S"/, ['presenter.skip']],
  ['template handleKey', /key === "b" \|\| key === "B"/, ['presenter.return']],
  // Keys that are not the presenter's: C pins the deck's control bar, N steps a mode, Enter / Space
  // open a slide's QR code, all in the audience and plain deck windows only.
  ['template handleKey', /!isPresenter && /, []],
  ['template isTalkQrKey', /event\.key === "u" \|\| event\.key === "U"/, ['presenter.talk-qr']],
  ['template paste', /addEventListener\('paste'/, ['presenter.instant-paste']],
  ['template paletteKey', /key === ',' && paletteHighlight/, ['presenter.rebind']],
  ['template paletteKey', /key === 'Escape'/, ['picker.close']],
  ['template paletteKey', /key === 'ArrowDown' \|\| key === 'ArrowUp'/, ['picker.navigate']],
  ['template paletteKey', /key === 'Enter'/, ['picker.choose']],
  // Tab is held in the search field (no focus walk out of the open palette).
  ['template paletteKey', /key === 'Tab'/, ['picker.close']],
  // The short-recording question on the cluster: ↵ keeps, Esc discards.
  ['present-rec-ui', /e\.key === 'Enter'\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); void controller\.confirmSave\(true\)/, ['picker.choose']],
  ['present-rec-ui', /e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); void controller\.confirmSave\(false\)/, ['picker.close']],
  ['present-rec-ui', /e\.key === 'L' \|\| e\.key === 'l'/, ['presenter.save-run-as']],
  ['present-rec-ui', /saveToast\.classList\.contains\('show'\) && e\.key === 'Enter'/, ['presenter.save-run']],
  ['present-rec-ui', /e\.key === 'R' \|\| e\.key === 'r'/, ['presenter.record']],
  ['present-rec-ui', /e\.key === 'P' \|\| e\.key === 'p'/, ['presenter.record-pause']],
  ['present-live-bridge', /event\.key === 'Escape' && !panel\.hidden/, ['presenter.close']],
  ['present-live-bridge', /event\.key === 'g' \|\| event\.key === 'G'/, ['presenter.live']],
  ['present-edit-bridge', /e\.key !== 'e' && e\.key !== 'E'/, ['presenter.edit']],
  // F5 opens the audience view; ⇧F5 refreshes (the routes themselves: deckWindowKeyTruth below).
  // The board panel: ⌘Z undoes the last board change while it shows; ⌥↵ picks up and drops; Esc
  // closes its menu, puts a held card down or leaves full screen; ↵ / Space on a card open its menu
  // (on a button they press it); in the board's own window Q opens or closes the board, as beside the slide.
  ['template board panel', /event\.key\.toLowerCase\(\) === 'z'/, ['presenter.board-undo']],
  ['template board panel', /event\.key === 'Enter'\) \{/, ['presenter.board-pick']],
  ['template board panel', /event\.key === 'Enter' \|\| event\.key === ' '/, ['picker.choose']],
  ['template board panel', /event\.key === 'q' \|\| event\.key === 'Q'/, ['presenter.poll-primary']],
  ['template board panel', /event\.key === 'Escape'/, ['presenter.close']],
  ['deck-window-keys', /input\.key === 'F5'/, ['presenter.audience', 'presenter.refresh']],
  ['deck-window-keys', /input\.key\.toLowerCase\(\) === 'r'/, ['presenter.refresh']]
]
const PRESENTER_ALLOWED_CLAIM_SCOPES = new Set(['presenter', 'picker'])
// A key set literal (the template's nextKeys / nextCodes …) names DOM key values and codes; the
// registry names codes. Space has three spellings, and the keypad's Enter is Enter.
const SET_KEY_SPELLING = { ' ': 'Space', Spacebar: 'Space', NumpadEnter: 'Enter' }
// Ticket 08: a presenter key set (nextKeys …) must list only keys its claimed entries list (Return
// advanced the slide unlisted), and a key bound only by a preload or the main process must name
// that preload in PRESENTER_KEY_NEEDS, so the ? sheet hides it where the preload is absent (G was
// listed in a presenter window opened without the live preload). `needs` turns the second check on.
function presenterKeyTruth(registry, regions, claims, { needs } = {}) {
  const problems = []
  const lines = []
  const boundIn = new Map()
  for (const [name, source, from, to, options] of regions) {
    const text = sourceRegion(source, from, to, options)
    if (text == null) { problems.push(`presenter key region "${name}" not found`); continue }
    text.split('\n').forEach((line, index) => { if (KEY_COMPARISON.test(line)) lines.push({ name, index, line: line.trim() }) })
  }
  const used = new Set()
  const bound = new Set()
  for (const hit of lines) {
    const matched = claims.filter(([region, pattern]) => region === hit.name && pattern.test(hit.line))
    if (!matched.length) { problems.push(`bound but not listed: ${hit.name}: ${hit.line.slice(0, 140)}`); continue }
    for (const claim of matched) {
      used.add(claim)
      if (claim[2].length === 0 && !/!isPresenter/.test(hit.line)) problems.push(`${hit.name}: a claim with no key must be guarded by !isPresenter: ${hit.line.slice(0, 140)}`)
      for (const id of claim[2]) {
        bound.add(id)
        if (!boundIn.has(id)) boundIn.set(id, new Set())
        boundIn.get(id).add(hit.name)
      }
    }
    const set = /new Set\(\[([^\]]*)\]\)/.exec(hit.line)
    if (set) {
      const ids = matched.flatMap((claim) => claim[2])
      const codes = new Set(ids.flatMap((id) => registry.find((item) => item.id === id)?.codes ?? []))
      for (const [, literal] of set[1].matchAll(/["']([^"']*)["']/g)) {
        const code = SET_KEY_SPELLING[literal] ?? literal
        if (!codes.has(code)) problems.push(`bound but not listed: ${hit.name}: key "${literal}" in ${hit.line.slice(0, 60)}… is not a key of ${ids.join(', ')}`)
      }
    }
  }
  for (const claim of claims) {
    if (!used.has(claim)) problems.push(`stale presenter key claim ${claim[0]} ${claim[1]} (no such binding)`)
    for (const id of claim[2]) {
      const entry = registry.find((item) => item.id === id)
      if (!entry) problems.push(`bound but not listed: ${claim[0]} ${claim[1]} → "${id}" is not in the registry`)
      else if (!PRESENTER_ALLOWED_CLAIM_SCOPES.has(entry.scope)) problems.push(`${claim[0]} ${claim[1]} → "${id}" is a ${entry.scope} key, not the presenter's`)
    }
  }
  for (const entry of registry.filter((item) => item.scope === 'presenter' && !item.unbound)) {
    if (!bound.has(entry.id)) problems.push(`listed but not bound: presenter key ${entry.keys} (${entry.id}, "${entry.label}") has no binding in the presenter`)
    const where = [...(boundIn.get(entry.id) ?? [])]
    if (needs && where.length && where.every((name) => !name.startsWith('template')) && !needs[entry.id]) {
      problems.push(`listed without its preload: presenter key ${entry.keys} (${entry.id}) is bound only in ${where.join(', ')}; name that preload in PRESENTER_KEY_NEEDS`)
    }
  }
  return { problems, lines }
}
// The main process's deck-window keys (src/main/deck-window-keys.ts), by what the module does
// rather than how it reads: every key it routes in a presenter window must be a key of the
// registry entry for that action (⇧F5 refreshed a presenter window unlisted until ticket 08).
const DECK_ACTION_IDS = { 'open-audience': 'presenter.audience', refresh: 'presenter.refresh' }
const DECK_PROBE_KEYS = [...Array.from({ length: 12 }, (_, i) => `F${i + 1}`), ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'Enter', 'Escape', 'Tab', 'Backspace', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
function deckWindowKeyTruth(registry, action) {
  const problems = []
  let routed = 0
  for (const key of DECK_PROBE_KEYS) {
    for (let mods = 0; mods < 16; mods += 1) {
      const input = { type: 'keyDown', key, shift: Boolean(mods & 1), meta: Boolean(mods & 2), control: Boolean(mods & 4), alt: Boolean(mods & 8) }
      const result = action('presenter', input)
      if (!result) continue
      routed += 1
      const named = `${input.control ? '⌃' : ''}${input.alt ? '⌥' : ''}${input.shift ? '⇧' : ''}${input.meta ? '⌘' : ''}${key.length === 1 ? key.toUpperCase() : key}`
      const id = DECK_ACTION_IDS[result]
      const entry = id ? registry.find((item) => item.id === id) : null
      const event = { key: input.shift && key.length === 1 ? key.toUpperCase() : key, shiftKey: input.shift, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt }
      if (!entry) problems.push(`bound but not listed: deck-window-keys routes ${named} in a presenter window to "${result}", which is no presenter key`)
      else if (!entry.codes.some((code) => shortcutEventMatches(event, id, code))) problems.push(`bound but not listed: deck-window-keys routes ${named} in a presenter window to "${result}", but ${id} lists only ${entry.keys}`)
    }
  }
  return { problems, routed }
}
// The checker itself: a listed key with no binding and a binding with no listed key both fail.
{
  const fakeRegistry = [
    { id: 'presenter.a', scope: 'presenter', keys: 'A', label: 'A' },
    { id: 'presenter.orphan', scope: 'presenter', keys: 'X', label: 'Listed, unbound' }
  ]
  const fakeSource = 'function handleKey(event) {\n  if (key === "a") a();\n  if (key === "z") z();\n  else if (isPresenter) return;'
  const { problems } = presenterKeyTruth(fakeRegistry, [['fake', fakeSource, 'function handleKey(event) {', 'else if (isPresenter) return;']], [['fake', /key === "a"/, ['presenter.a']]])
  assert(problems.some((p) => p.startsWith('listed but not bound: presenter key X')), 'the key-truth check fails on a listed key with no binding')
  assert(problems.some((p) => p.startsWith('bound but not listed: fake: if (key === "z")')), 'the key-truth check fails on a binding with no listed key')
  // A key set with a key its entry does not list (Return in nextKeys before ticket 08).
  const setSource = 'function handleKey(event) {\n  const nextKeys = new Set(["ArrowRight", " ", "Enter"]);\n  else if (isPresenter) return;'
  const setTruth = presenterKeyTruth([{ id: 'presenter.a', scope: 'presenter', keys: '→ Space', label: 'A', codes: ['ArrowRight', 'Space'] }], [['fake', setSource, 'function handleKey(event) {', 'else if (isPresenter) return;']], [['fake', /const nextKeys = /, ['presenter.a']]])
  assert.deepEqual(setTruth.problems.map((p) => p.replace(/ in .*? is/, ' is')), ['bound but not listed: fake: key "Enter" is not a key of presenter.a'], 'the key-truth check fails on a key in a key set that its entry does not list')
  // A key bound only by a preload, listed with no PRESENTER_KEY_NEEDS entry (G before ticket 08).
  const preloadSource = "window.addEventListener('keydown', (event) => {\n  if (event.key === 'g' || event.key === 'G') live()\n}, true)"
  const preloadRegion = ['preload', preloadSource, "window.addEventListener('keydown', (event) => {", '}, true)']
  const preloadRegistry = [{ id: 'presenter.live', scope: 'presenter', keys: 'G', label: 'Live', codes: ['g'] }]
  const preloadClaims = [['preload', /event\.key === 'g'/, ['presenter.live']]]
  assert(presenterKeyTruth(preloadRegistry, [preloadRegion], preloadClaims, { needs: {} }).problems.some((p) => p.startsWith('listed without its preload: presenter key G')), 'the key-truth check fails on a preload-only key the sheet would list without its preload')
  assert.deepEqual(presenterKeyTruth(preloadRegistry, [preloadRegion], preloadClaims, { needs: { 'presenter.live': '[data-live]' } }).problems, [], 'a preload-only key named in PRESENTER_KEY_NEEDS passes')
  // The deck-window module's ⇧F5 route, against a registry whose refresh lists only ⌘R.
  const staleRegistry = [
    { id: 'presenter.audience', scope: 'presenter', keys: 'F5', codes: ['F5'] },
    { id: 'presenter.refresh', scope: 'presenter', keys: '⌘R', codes: ['Mod-r'] }
  ]
  const stale = deckWindowKeyTruth(staleRegistry, deckWindowKeyAction)
  assert.deepEqual(stale.problems, ['bound but not listed: deck-window-keys routes ⇧F5 in a presenter window to "refresh", but presenter.refresh lists only ⌘R'], 'the key-truth check fails on the deck-window module\'s unlisted ⇧F5 route')
}
const truth = presenterKeyTruth(SHORTCUT_REGISTRY, PRESENTER_KEY_REGIONS, PRESENTER_KEY_CLAIMS, { needs: PRESENTER_KEY_NEEDS })
for (const problem of truth.problems) fail(problem)
if (truth.problems.length === 0) ok(`${truth.lines.length} presenter key bindings claimed; every presenter key in the registry is bound; preload-only keys name their preload`)
const deckTruth = deckWindowKeyTruth(SHORTCUT_REGISTRY, deckWindowKeyAction)
for (const problem of deckTruth.problems) fail(problem)
if (deckTruth.problems.length === 0) ok(`${deckTruth.routed} presenter-window key routes in the main process are all listed`)
// ── Slide picker and file list key truth (talk search 08) ────────────────────────────────────
// The ⌘S slide picker (its capture handler and the Find a talk box) and the file list (the Talks
// panel's key handler) bind exactly the keys the registry lists for them: every key comparison in
// those handlers is claimed by a registry id (or, with no id, carries the reason it binds nothing),
// every claim still matches a line, and every key the registry lists for the surface is claimed.
// A rebindable key is compared through surfaceKey(event, '<local id>'); its claim must name the
// registry id that local id stands for (src/renderer/src/keymap/surfaceKeys.ts).
console.log('Slide picker and file list key truth:')
const slideBrowserSource = readFileSync(join(root, 'src/renderer/src/components/slide-browser/useSlideBrowserKeys.ts'), 'utf8')
const findTalkSource = readFileSync(join(root, 'src/renderer/src/components/browser-rail/FindTalk.tsx'), 'utf8')
const talkPanelSource = readFileSync(join(root, 'src/renderer/src/components/talklist/useKeyboard.ts'), 'utf8')
const surfaceKeysSource = readFileSync(join(root, 'src/renderer/src/keymap/surfaceKeys.ts'), 'utf8')
const SURFACE_KEY_IDS = Object.fromEntries(
  [...(surfaceKeysSource.match(/export const SURFACE_KEYS = \{([\s\S]*?)\}/)?.[1] ?? '').matchAll(/'([^']+)':\s*'([^']+)'/g)]
    .map((match) => [match[1], match[2]])
)
assert.equal(Object.keys(SURFACE_KEY_IDS).length, 5, 'the five rebindable surface keys are read from surfaceKeys.ts')
const SURFACE_KEY_COMPARISON = /\be\.key\s*[!=]==|\.includes\(e\.key\)|\.test\(e\.key\)|surfaceKey\(|findBoxOwnsKey\(e\.key/
const PICKER_REGIONS = [
  ['picker', slideBrowserSource, 'function handleKey(e: KeyboardEvent): void {', "window.addEventListener('keydown', handleKey, { capture: true })"],
  ['find box', findTalkSource, 'function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {', "if (e.key === 'Enter') choose(activeRow(), false)"]
]
const FILE_LIST_REGIONS = [
  ['file list', talkPanelSource, 'return function handlePanelKey(e: ReactKeyboardEvent<HTMLElement>): void {', '\n  }\n}']
]
// [region, line pattern, registry ids, reason when the ids are empty]
const PICKER_CLAIMS = [
  ['picker', /findBoxOwnsKey\(e\.key/, [], 'hands ↑↓ ↵ Esc to Find a talk while it lists talks (the find-box claims below)'],
  ['picker', /e\.key === 'Tab' && rootRef\.current/, ['slide-picker.tab']],
  ['picker', /e\.key === 'Escape' && el instanceof HTMLInputElement && el\.dataset\.railEsc === '1'/, [], 'hands Esc to a rail vocabulary input, which clears its own words first'],
  ['picker', /e\.key !== 'Escape' && besideOn && keyFree && surfaceKey\(e, 'close-beside'\)/, ['slide-picker.close-beside']],
  ['picker', /^if \(e\.key === 'Escape'\) \{$/, ['slide-picker.close', 'slide-picker.close-beside']],
  ['picker', /surfaceKey\(e, 'select-whole-section'\)/, ['slide-picker.select-whole-section']],
  ['picker', /surfaceKey\(e, 'talk-beside'\)/, ['slide-picker.talk-beside']],
  ['picker', /mod && !e\.shiftKey && e\.key === 'Enter'/, ['slide-picker.insert']],
  ['picker', /^if \(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp' \|\| e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\) \{$/, ['slide-picker.move', 'slide-picker.extend']],
  ['picker', /inField && \(e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowRight'\)\) return/, [], '← → move the caret while typing'],
  ['picker', /e\.key === 'Backspace' && !mod && !e\.altKey/, ['slide-picker.clear-scope']],
  ['picker', /\['2', '3', '4', '5', '6'\]\.includes\(e\.key\)/, ['slide-picker.density']],
  ['picker', /e\.key === 'x' \|\| e\.key === 'X'/, ['slide-picker.toggle-selection']],
  ['picker', /e\.key === 's' \|\| e\.key === 'S'/, ['slide-picker.select-section']],
  ['picker', /e\.key === 't' \|\| e\.key === 'T'/, ['slide-picker.tags']],
  ['picker', /plain && e\.key === ' ' && onButton\) return/, [], 'Space on a focused button is that button’s click'],
  ['picker', /e\.key === ' ' \|\| e\.key === 'p' \|\| e\.key === 'P'/, ['slide-picker.preview']],
  ['picker', /e\.key === 'i' \|\| e\.key === 'I'/, ['slide-picker.rail']],
  ['picker', /e\.key === 'e' \|\| e\.key === 'E'/, ['slide-picker.versions']],
  ['picker', /e\.key === 'u' \|\| e\.key === 'U'/, ['slide-picker.near']],
  ['picker', /plain && e\.key === 'Enter'/, ['slide-picker.view']],
  ['find box', /e\.key === 'Backspace' && query === '' && props\.chips\.length > 0/, ['slide-picker.remove-chip']],
  ['find box', /surfaceKey\(e\.nativeEvent, 'add-beside'\)/, ['slide-picker.add-beside']],
  ['find box', /findBoxOwnsKey\(e\.key/, [], 'the keys below are the box’s only while it lists talks, completes or holds words'],
  ['find box', /e\.key === 'Escape'\) \{ onQueryChange\(''\)/, ['picker.close']],
  ['find box', /e\.key === 'Arrow(?:Down|Up)'\) \{ setActive/, ['picker.navigate']],
  ['find box', /e\.key === 'Enter'\) choose\(activeRow\(\), false\)/, ['picker.choose']]
]
const FILE_LIST_CLAIMS = [
  ['file list', /t\.tagName === 'BUTTON' && \(e\.key === 'Enter' \|\| e\.key === ' '\)\) return/, [], 'a focused toolbar button keeps its own ↵ and Space'],
  ['file list', /e\.key === 'v' \|\| e\.key === 'V'/, ['browser.talk-view']],
  ['file list', /e\.key === 'n' \|\| e\.key === 'N'/, ['browser.talk-names']],
  ['file list', /e\.key === 's' \|\| e\.key === 'S'/, ['browser.sort']],
  ['file list', /d\.sortPopOpen && \/\^\[1-5\]\$\/\.test\(e\.key\)/, ['browser.sort']],
  ['file list', /e\.key === 'm' \|\| e\.key === 'M'/, ['browser.move-talk']],
  ['file list', /e\.key === '\/'/, ['browser.filter']],
  ['file list', /^if \(e\.key === 'Escape'\) \{$/, ['browser.close']],
  ['file list', /^if \(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'\) \{$/, ['browser.move']],
  ['file list', /^const dir = e\.key === 'ArrowDown'/, ['browser.move']],
  ['file list', /^if \(e\.key === 'Arrow(?:Right|Left)'\) \{$/, ['browser.move']],
  ['file list', /^if \(e\.key === 'Enter'\) \{$/, ['browser.open']],
  ['file list', /e\.key === 'F2'/, ['browser.rename']],
  ['file list', /e\.key === 'o' \|\| e\.key === 'O'/, ['browser.open-talk']],
  ['file list', /e\.key === 'ArrowUp'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); d\.upOneLevel/, ['browser.up-level']],
  ['file list', /e\.key === 'Arrow(?:Left|Right)'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); d\.(?:collapse|expand)AllInView/, ['browser.fold-all']],
  ['file list', /e\.key === 'd' \|\| e\.key === 'D'/, ['browser.duplicate']],
  ['file list', /e\.key === 'Backspace'\) \{ e\.preventDefault\(\); d\.startDelete/, ['browser.delete-talk']]
]
function surfaceKeyTruth(registry, regions, claims, { owns, scopes }) {
  const problems = []
  const lines = []
  for (const [name, source, from, to] of regions) {
    const text = sourceRegion(source, from, to)
    if (text == null) { problems.push(`key region "${name}" not found`); continue }
    text.split('\n').forEach((line) => { if (SURFACE_KEY_COMPARISON.test(line)) lines.push({ name, line: line.trim() }) })
  }
  const used = new Set()
  const bound = new Set()
  for (const hit of lines) {
    const matched = claims.filter(([region, pattern]) => region === hit.name && pattern.test(hit.line))
    if (!matched.length) { problems.push(`bound but not listed: ${hit.name}: ${hit.line.slice(0, 140)}`); continue }
    const local = /surfaceKey\([^,]+,\s*'([^']+)'\)/.exec(hit.line)?.[1]
    for (const claim of matched) {
      used.add(claim)
      if (claim[2].length === 0 && !claim[3]) problems.push(`${hit.name}: a claim with no key must say why: ${hit.line.slice(0, 140)}`)
      if (local && !claim[2].includes(SURFACE_KEY_IDS[local])) problems.push(`${hit.name}: surfaceKey '${local}' is ${SURFACE_KEY_IDS[local] ?? 'no surface key'}, but the line is claimed for ${claim[2].join(', ')}`)
      for (const id of claim[2]) bound.add(id)
    }
  }
  for (const claim of claims) {
    if (!used.has(claim)) problems.push(`stale key claim ${claim[0]} ${claim[1]} (no such binding)`)
    for (const id of claim[2]) {
      const entry = registry.find((item) => item.id === id)
      if (!entry) problems.push(`bound but not listed: ${claim[0]} ${claim[1]} → "${id}" is not in the registry`)
      else if (!scopes.has(entry.scope)) problems.push(`${claim[0]} ${claim[1]} → "${id}" is a ${entry.scope} key, not this surface's`)
    }
  }
  for (const entry of registry.filter((item) => owns(item) && !item.unbound)) {
    if (!bound.has(entry.id)) problems.push(`listed but not bound: ${entry.keys} (${entry.id}, "${entry.label}") has no binding`)
  }
  return { problems, lines }
}
// The checker itself fails on a listed key with no binding, a binding with no listed key, and a
// rebindable key claimed for the wrong command.
{
  const fakeRegistry = [
    { id: 'slide-picker.a', scope: 'slide-picker', keys: 'A', label: 'A' },
    { id: 'slide-picker.orphan', scope: 'slide-picker', keys: 'W', label: 'Listed, unbound' },
    { id: 'slide-picker.talk-beside', scope: 'slide-picker', keys: 'O', label: 'Beside' }
  ]
  const fakeSource = "function handleKey(e: KeyboardEvent): void {\n  if (e.key === 'a') a()\n  if (e.key === 'z') z()\n  if (surfaceKey(e, 'talk-beside')) beside()\n  window.addEventListener('keydown', handleKey, { capture: true })"
  const fakeRegion = [['picker', fakeSource, 'function handleKey(e: KeyboardEvent): void {', "window.addEventListener('keydown', handleKey, { capture: true })"]]
  const owns = (entry) => entry.scope === 'slide-picker'
  const scopes = new Set(['slide-picker'])
  const { problems } = surfaceKeyTruth(fakeRegistry, fakeRegion, [['picker', /e\.key === 'a'/, ['slide-picker.a']], ['picker', /surfaceKey\(e, 'talk-beside'\)/, ['slide-picker.a']]], { owns, scopes })
  assert(problems.some((p) => p.startsWith('listed but not bound: W (slide-picker.orphan')), 'the picker key-truth check fails on a listed key with no binding')
  assert(problems.some((p) => p.startsWith("bound but not listed: picker: if (e.key === 'z')")), 'the picker key-truth check fails on a binding with no listed key')
  assert(problems.some((p) => p.startsWith("picker: surfaceKey 'talk-beside' is slide-picker.talk-beside, but the line is claimed for slide-picker.a")), 'the picker key-truth check fails on a rebindable key claimed for the wrong command')
}
const pickerTruth = surfaceKeyTruth(SHORTCUT_REGISTRY, PICKER_REGIONS, PICKER_CLAIMS, {
  owns: (entry) => entry.scope === 'slide-picker',
  scopes: new Set(['slide-picker', 'picker'])
})
for (const problem of pickerTruth.problems) fail(problem)
if (pickerTruth.problems.length === 0) ok(`${pickerTruth.lines.length} slide picker key bindings claimed; every slide picker key in the registry is bound`)
const fileListTruth = surfaceKeyTruth(SHORTCUT_REGISTRY, FILE_LIST_REGIONS, FILE_LIST_CLAIMS, {
  owns: (entry) => entry.scope === 'browser' && entry.group === 'Talks panel',
  scopes: new Set(['browser'])
})
for (const problem of fileListTruth.problems) fail(problem)
if (fileListTruth.problems.length === 0) ok(`${fileListTruth.lines.length} file list key bindings claimed; every Talks panel key in the registry is bound`)

// Talk search 08's keys. The S conflict: the picker's select section and the file list's sort are
// two surfaces' keys, each listed in its own scope — never one scope's key claimed twice.
const talkSearchKeys = [
  ['app.find-talk', 'app', '⇧⌘S', ['Mod-Shift-s']],
  ['slide-picker.add-beside', 'slide-picker', '⌘↵', ['Mod-Enter']],
  ['slide-picker.talk-beside', 'slide-picker', 'O', ['o']],
  ['slide-picker.close-beside', 'slide-picker', 'Esc', ['Escape']],
  ['slide-picker.select-whole-section', 'slide-picker', '⇧⌘↵', ['Mod-Shift-Enter']],
  ['app.sidebar-talks', 'app', '⌘⇧T', ['Mod-Shift-t']],
  ['browser.filter', 'browser', '/', ['/']]
]
for (const [id, scope, keys, codes] of talkSearchKeys) {
  const entry = SHORTCUT_REGISTRY.find((candidate) => candidate.id === id)
  assert.deepEqual([entry?.scope, entry?.keys, entry?.codes], [scope, keys, codes], `${id} is registered in ${scope} as ${keys}`)
}
assert.deepEqual(
  SHORTCUT_REGISTRY.filter((entry) => entry.codes.includes('s') && !entry.unbound).map((entry) => [entry.scope, entry.id]),
  [['browser', 'browser.sort'], ['slide-picker', 'slide-picker.select-section'], ['presenter', 'presenter.skip'], ['talktext', 'talktext.script']],
  'S is the file list’s sort and the slide picker’s select section, in their own scopes'
)
// ADR-0011: the universal keymap's reserved chords. Only their reserved surface may hold them (a
// reserved chord with no surface stays unbound); each holder below is that surface.
const RESERVED_CHORDS = new Map([
  ['Mod-Shift-p', ['app.command-palette', 'presenter.command-palette']],
  ['Mod-Shift-k', []],
  ['Mod-k', ['app.context-menu']],
  ['Mod-p', ['app.toggle-inspector']],
  ['Mod-f', ['app.find', 'importer.search']],
  // Pre-existing, not moved by talk search 08: ⌘⇧F is ADR-0011's "search everything" but TalkWeaver
  // binds it to Focus current slide. Reported for its own decision.
  ['Mod-Shift-f', ['app.slide-focus']],
  ['Mod-,', ['app.settings']],
  ['Mod-/', ['app.help']],
  ['Mod-Shift-,', ['presenter.rebind']]
])
const reservedHolders = SHORTCUT_REGISTRY.flatMap((entry) => entry.codes
  .filter((code) => RESERVED_CHORDS.has(code) && !RESERVED_CHORDS.get(code).includes(entry.id))
  .map((code) => `${entry.id} holds ${code}`))
assert.deepEqual(reservedHolders, [], 'no command takes an ADR-0011 reserved chord from its surface')
{
  const probe = [{ id: 'slide-picker.find-talk', codes: ['Mod-Shift-k'] }]
  const hits = probe.flatMap((entry) => entry.codes.filter((code) => RESERVED_CHORDS.has(code) && !RESERVED_CHORDS.get(code).includes(entry.id)))
  assert.deepEqual(hits, ['Mod-Shift-k'], 'the reserved-chord check fails on a command given ⌘⇧K')
}

// Ticket 07's keys: ⇧R, ⇧P, L, ⌘E, ⌘R registered for the presenter; N and C no longer listed.
// Ticket 08's: ⇧F5 (refresh) and ↵ (next).
const presenterScope = SHORTCUT_REGISTRY.filter((entry) => entry.scope === 'presenter')
for (const [id, keys] of [['presenter.record', '⇧R'], ['presenter.record-pause', '⇧P'], ['presenter.save-run-as', 'L'], ['presenter.save-run', '↵'], ['presenter.edit', '⌘E'], ['presenter.refresh', '⌘R / ⇧F5'], ['presenter.next', '→ Space ↓ PgDn ↵']]) {
  assert.equal(presenterScope.find((entry) => entry.id === id)?.keys, keys, `${id} is registered in the presenter scope as ${keys}`)
}
assert.equal(presenterScope.some((entry) => entry.keys === 'N' || entry.keys === 'C'), false, 'the presenter scope does not list N or C (they do nothing in the presenter)')
const { PRESENTER_CONTROLS: presenterControls } = await import(new URL('../src/shared/presenter-controls.ts', import.meta.url))
assert.equal(presenterControls.some((control) => 'unregisteredKeys' in control), false, 'every presenter control takes its keys from the registry (no unregisteredKeys)')

// Fix round 4: the Inspector's option pictures declare their own shortcut ids, not the pickers'.
{
  const pictures = readFileSync(join(root, 'src/renderer/src/components/InspectorOptionPictures.tsx'), 'utf8')
  const declared = [...pictures.matchAll(/shortcut-id:\s*([^\n—]+)/g)].flatMap((match) => match[1].trim().split(/\s+/))
  assert.deepEqual(declared.sort(), ['inspector.option-pictures-choose', 'inspector.option-pictures-move'], 'option pictures declare only their own ids')
  for (const id of declared) {
    const entry = SHORTCUT_REGISTRY.find((candidate) => candidate.id === id)
    assert.equal(entry?.scope, 'inspector', `${id} is registered in the inspector scope`)
  }
}

const { renderTemplateWithShortcutHelp, renderIconsModule, iconsModulePath } = await import('./build-shortcut-help.mjs')
const templatePath = join(root, 'compiler/assets/templates/presenter-popup-single-html.html')
const template = readFileSync(templatePath, 'utf8')
assert.equal(template, await renderTemplateWithShortcutHelp(template), 'Generated presenter shortcut help is stale')
assert.equal(readFileSync(iconsModulePath, 'utf8'), await renderIconsModule(), 'Generated presenter icons are stale')

if (failures > 0) {
  console.error(`\ntest-shortcut-registry: ${failures} failure(s).`)
  process.exit(1)
}
console.log('\ntest-shortcut-registry: all checks passed.')
