import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {
  COMMAND_REGISTRY,
  commandShortcutLabel,
  menuCommands,
  objectPaletteCommands,
  paletteCommands,
  toolbarCommands,
} = await import(
  new URL('../src/shared/command-registry.ts', import.meta.url)
)
const { LAYOUTS } = await import(
  new URL('../src/shared/layout-registry/entries.ts', import.meta.url)
)
const { SHORTCUT_REGISTRY } = await import(
  new URL('../src/shared/shortcut-registry.ts', import.meta.url)
)

const tableObject = LAYOUTS.find((entry) => entry.name === 'table')
assert(tableObject?.object, 'the constructed-entry tests need the registered table object')
const futureObject = {
  ...tableObject,
  name: 'future-object',
  label: 'Future object',
  trigger: '{future-object}',
  aliases: [],
  triggerWords: ['future-object'],
  sample: '### Future object\n{future-object}\n\n- Value',
}

const ids = new Set()
for (const command of COMMAND_REGISTRY) {
  assert(command.id?.trim(), 'command id is required')
  assert(!ids.has(command.id), `duplicate command id: ${command.id}`)
  ids.add(command.id)
  assert(command.label?.trim(), `${command.id}: label is required`)
  assert(command.scope?.trim(), `${command.id}: scope is required`)
  assert(command.handlerId?.trim(), `${command.id}: renderer handler id is required`)
  assert.equal(typeof command.palette.visible, 'boolean', `${command.id}: palette visibility is required`)
  assert(Array.isArray(command.palette.keywords), `${command.id}: palette keywords are required`)
  assert(command.menu === null || (command.menu.path.length > 0 && Number.isFinite(command.menu.order)), `${command.id}: invalid menu placement`)
  assert(command.toolbar === undefined || (
    ['insert', 'deck', 'tools', 'present'].includes(command.toolbar.menu) &&
    Number.isFinite(command.toolbar.order) &&
    command.toolbar.icon?.trim()
  ), `${command.id}: invalid toolbar placement`)
}

const shortcutIds = new Set(SHORTCUT_REGISTRY.map((entry) => entry.id))
for (const command of COMMAND_REGISTRY) {
  if (command.shortcutId) assert(shortcutIds.has(command.shortcutId), `${command.id}: unknown shortcutId ${command.shortcutId}`)
}
for (const shortcut of SHORTCUT_REGISTRY) {
  assert(COMMAND_REGISTRY.some((command) => command.shortcutId === shortcut.id), `shortcut action has no command: ${shortcut.id}`)
}

const expectedPaletteIds = [
  'refresh', 'optimize-images', 'ocr-index', 'check-embeds', 'layout-doctor', 'where-used', 'focus-slide',
  'toggle-inspector', 'studio', 'history', 'importer', 'plan-run', 'pathways', 'new-window', 'new-talk', 'new-folder',
  'refresh-talks', 'change-vault', 'search-talks',
  'find-talk', 'add-talk-beside', 'talk-beside', 'close-talk-beside', 'select-whole-section',
  'present-window', 'present-presenter',
  'present-from-here', 'present-audience', 'handout', 'build', 'publish-handout', 'share-for-comments', 'copy-venue-screen-link', 'layout',
  'image', 'search', 'icon-picker', 'insert-object-table', 'insert-object-mindmap',
  'insert-object-chart', 'insert-object-mermaid', 'insert-object-diagram', 'insert-object-svg',
  'format-bold', 'format-italic', 'format-inline-code', 'format-highlight', 'format-link',
  'deck-design', 'metadata', 'tag-slide', 'abstract',
  'view-editor', 'view-both', 'view-strip', 'view-grid', 'fold-all', 'unfold-all',
  'normalize-triggers', 'undo', 'redo', 'new-slide', 'promote-heading', 'demote-heading', 'bulleted-list', 'numbered-list', 'delete-slide', 'app.command-palette', 'help', 'settings'
]
assert.deepEqual(paletteCommands().map((command) => command.id), expectedPaletteIds, 'palette is generated in its existing order')
assert.equal(typeof objectPaletteCommands, 'function', 'object palette commands derive from the layout registry')
assert.deepEqual(
  objectPaletteCommands(LAYOUTS).map((command) => command.id),
  [
    'insert-object-table',
    'insert-object-mindmap',
    'insert-object-chart',
    'insert-object-mermaid',
    'insert-object-diagram',
    'insert-object-svg',
  ],
  'object palette command ids and order stay byte-identical'
)

// T27: the six object inserts also live in the Insert toolbar menu — after the four built-in
// items, under one group marker, with no keyboard shortcut and their menu-label variants.
const objectCommands = objectPaletteCommands(LAYOUTS)
for (const objectCommand of objectCommands) {
  assert.equal(objectCommand.toolbar?.menu, 'insert', `${objectCommand.id}: carries an Insert toolbar placement`)
  assert.equal(objectCommand.shortcutId, undefined, `${objectCommand.id}: no keyboard shortcut`)
  assert.equal(objectCommand.toolbar?.group, 'object', `${objectCommand.id}: shares one group marker (the menu's separator)`)
  assert.ok(Number.isFinite(objectCommand.toolbar?.order) && objectCommand.toolbar.order >= 100, `${objectCommand.id}: ordered after the built-in insert items`)
  assert.ok(objectCommand.toolbar?.menuLabel, `${objectCommand.id}: carries its menu-label variant`)
  assert.equal(objectCommand.palette.visible, true, `${objectCommand.id}: keeps its palette entry`)
}
assert.deepEqual(
  objectCommands.map((command) => command.toolbar.menuLabel),
  ['Table', 'Mindmap', 'Chart', 'Mermaid', 'Diagram…', 'SVG'],
  'menu labels use the menu-label variants, with the ellipsis exactly where the registry declares it'
)
const insertToolbar = toolbarCommands('insert').map((command) => command.id)
assert.deepEqual(
  insertToolbar,
  ['layout', 'image', 'search', 'icon-picker', 'insert-object-table', 'insert-object-mindmap', 'insert-object-chart', 'insert-object-mermaid', 'insert-object-diagram', 'insert-object-svg'],
  'the Insert toolbar menu is exactly the four built-ins then the six objects, in order'
)

// T27: ⌘⇧P is promoted to an explicit command — the Tools menu's "All commands…" opens the palette,
// the palette does not list itself, and the shortcut stays owned by the command.
const paletteCommand = COMMAND_REGISTRY.filter((command) => command.id === 'app.command-palette')
assert.equal(paletteCommand.length, 1, 'app.command-palette exists exactly once in the registry')
const [commandPalette] = paletteCommand
assert.equal(commandPalette.shortcutId, 'app.command-palette', 'app.command-palette keeps its ⌘⇧P shortcut')
assert.deepEqual(
  [commandPalette.toolbar?.menu, commandPalette.toolbar?.order],
  ['tools', 45],
  'app.command-palette sits in the Tools menu between Settings and Keyboard shortcuts'
)
assert.equal(commandPalette.palette.visible, false, 'the palette does not list itself')
assert.equal(
  COMMAND_REGISTRY.filter((command) => command.shortcutId === 'app.command-palette').length,
  1,
  'no shortcut-only fallthrough duplicates the promoted command'
)
const toolsToolbar = toolbarCommands('tools')
assert.ok(
  toolsToolbar.findIndex((command) => command.id === 'settings') < toolsToolbar.findIndex((command) => command.id === 'app.command-palette')
  && toolsToolbar.findIndex((command) => command.id === 'app.command-palette') < toolsToolbar.findIndex((command) => command.id === 'help'),
  'All commands… sits between Settings and Keyboard shortcuts in the resolved Tools menu'
)
assert.equal(
  objectPaletteCommands(LAYOUTS.map((entry) => entry.name === 'svg'
    ? { ...entry, object: undefined }
    : entry))
    .some((command) => command.id === 'insert-object-svg'),
  false,
  'an entry without an object declaration contributes no palette command'
)
{
  const originalError = console.error
  const errors = []
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  try {
    let derived
    assert.doesNotThrow(() => {
      derived = objectPaletteCommands([...LAYOUTS, futureObject])
    }, 'an object declaration outside the finite handler tuple must not stop module initialisation')
    assert.equal(
      derived.some((command) => command.id === 'insert-object-future-object'),
      false,
      'an object declaration without a finite palette handler is skipped'
    )
    assert.equal(
      errors.some((message) => message.includes('insert-object-future-object')),
      true,
      'the skipped object palette command reports its missing finite handler'
    )
  } finally {
    console.error = originalError
  }
}

assert.deepEqual(
  menuCommands().map((command) => [command.menu.path.join('/'), command.id]),
  [['Deck', 'toggle-inspector'], ['Deck', 'pathways']],
  'native custom menu keeps its existing structure'
)

const expectedToolbarIds = {
  insert: ['layout', 'image', 'search', 'icon-picker', 'insert-object-table', 'insert-object-mindmap', 'insert-object-chart', 'insert-object-mermaid', 'insert-object-diagram', 'insert-object-svg'],
  deck: ['deck-design', 'toggle-inspector', 'pathways', 'metadata', 'abstract', 'refresh', 'normalize-triggers', 'delete-slide'],
  tools: ['studio', 'history', 'importer', 'settings', 'app.command-palette', 'help'],
  present: ['present-window', 'present-presenter', 'present-from-here', 'present-audience']
}
for (const [menu, expectedIds] of Object.entries(expectedToolbarIds)) {
  assert.deepEqual(toolbarCommands(menu).map((command) => command.id), expectedIds, `${menu} toolbar menu resolves from the command register`)
}

const workspace = readFileSync(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
assert(!workspace.includes("{ id: 'toggle-inspector', title:"), 'WorkspaceLayout must not hand-maintain palette entries')
assert(workspace.includes('runRegisteredCommand'), 'renderer uses the shared command dispatch channel')
for (const menu of ['Insert', 'Deck', 'Tools', 'Present']) {
  const block = workspace.match(new RegExp(`<ToolbarMenu(?:(?!<ToolbarMenu)[\\s\\S])*?label="${menu}"(?:(?!<ToolbarMenu)[\\s\\S])*?/>`))?.[0] ?? ''
  assert(block, `${menu} ToolbarMenu exists`)
  assert(!/items=\{\[\s*\{[\s\S]*?label:/.test(block), `${menu} ToolbarMenu must not contain a literal inline item array`)
}
assert(workspace.includes("toolbarItems('tools')"), 'Tools toolbar menu is generated from registered placements')
const handlerBlock = workspace.match(/commandHandlersRef\.current = \{([\s\S]*?)\n  \}/)?.[1] ?? ''
const implementedHandlers = [...handlerBlock.matchAll(/^    (?:'([^']+)'|([a-z][\w-]*)):/gm)]
  .map((match) => match[1] ?? match[2])
  .sort()
const registeredHandlers = paletteCommands().map((command) => command.handlerId).sort()
assert.deepEqual(implementedHandlers, registeredHandlers, 'no registered command handler is missing or orphaned')
const implementedHandlerSet = new Set(implementedHandlers)
for (const command of COMMAND_REGISTRY.filter((entry) => entry.toolbar)) {
  assert(implementedHandlerSet.has(command.handlerId), `${command.id}: toolbar placement resolves to a renderer handler`)
  assert.equal(
    commandShortcutLabel(command),
    command.shortcutId ? (SHORTCUT_REGISTRY.find((shortcut) => shortcut.id === command.shortcutId)?.unbound ? 'no default' : SHORTCUT_REGISTRY.find((shortcut) => shortcut.id === command.shortcutId)?.keys) : '',
    `${command.id}: toolbar hint resolves from the shortcut registry`
  )
}
assert(workspace.includes('if (import.meta.env.DEV) throw new Error(`Toolbar command has no renderer handler:'), 'missing toolbar handlers fail loudly in development')

const deleteSlideCommand = paletteCommands().find((command) => command.id === 'delete-slide')
assert(deleteSlideCommand, 'delete-slide command exists')
assert.equal(
  commandShortcutLabel(deleteSlideCommand),
  '⌘⇧⌫',
  'without an override, delete-slide keeps the registry-curated multi-code display string'
)
assert.equal(
  commandShortcutLabel(deleteSlideCommand, '⌘⌥⌫'),
  '⌘⌥⌫',
  'with an override, delete-slide reflects the live override label'
)
for (const id of ['format-italic', 'format-inline-code', 'format-highlight']) {
  const unbound = paletteCommands().find((command) => command.id === id)
  assert(unbound, `${id} command exists`)
  assert.equal(commandShortcutLabel(unbound), 'no default', `${id} palette row says no default`)
}

// Talk search 08: every talk-search action is a palette command carrying its registry key.
const TALK_SEARCH_COMMANDS = [
  ['find-talk', 'app.find-talk', '⇧⌘S'],
  ['add-talk-beside', 'slide-picker.add-beside', '⌘↵'],
  ['talk-beside', 'slide-picker.talk-beside', 'O'],
  ['close-talk-beside', 'slide-picker.close-beside', 'Esc'],
  ['select-whole-section', 'slide-picker.select-whole-section', '⇧⌘↵'],
  ['search-talks', 'app.sidebar-talks', '⌘⇧T']
]
for (const [id, shortcutId, keys] of TALK_SEARCH_COMMANDS) {
  const registered = paletteCommands().find((command) => command.id === id)
  assert(registered, `${id} is a palette command`)
  assert.equal(registered.palette.visible, true, `${id} is listed in the palette`)
  assert.equal(registered.shortcutId, shortcutId, `${id} carries ${shortcutId}`)
  assert.equal(commandShortcutLabel(registered), keys, `${id} shows ${keys} in the palette`)
}
// Dominik, 0.34.0-preview.8 check (28 Sep): the section key selects the whole section, it does not
// insert it; no palette entry still offers to insert a section.
assert.equal(paletteCommands().find((command) => command.id === 'select-whole-section')?.label, 'Select the focused slide’s whole section', 'the palette entry is Select the focused slide’s whole section')
assert.equal(paletteCommands().some((command) => /insert[^.]*section/i.test(command.label)), false, 'no palette entry says it inserts a section')

const uiBundleDir = mkdtempSync(join(root, '.test-command-ui-'))
const uiBundleUrl = pathToFileURL(join(uiBundleDir, 'bundle.mjs'))
let shortcutUi
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://talkweaver.test/' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import KeyboardHelp from './src/renderer/src/components/KeyboardHelp.tsx'",
        "import SlideContextMenu from './src/renderer/src/components/SlideContextMenu.tsx'",
        "import SlidePickerHints from './src/renderer/src/components/SlidePickerHints.tsx'",
        "export * from './src/renderer/src/keymap/surfaceKeys.ts'",
        "export { EDITOR_COMMANDS } from './src/renderer/src/keymap/registry.ts'",
        "export * from './src/renderer/src/components/SlideContextMenu.tsx'",
        "export * from './src/renderer/src/keymap/store.ts'",
        "export function renderKeyboardHelp() {",
        "  return renderToStaticMarkup(React.createElement(KeyboardHelp, { isOpen: true, onClose() {} }))",
        "}",
        "export function renderSlidePickerHints() {",
        "  return renderToStaticMarkup(React.createElement(SlidePickerHints))",
        "}",
        "export function renderSlideContextMenu() {",
        "  return renderToStaticMarkup(React.createElement(SlideContextMenu, {",
        "    x: 0, y: 0, onAction() {}, onSetLayout() {}, onClose() {}",
        "  }))",
        "}"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-command-ui-entry.tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react', '@codemirror/*'],
    outfile: fileURLToPath(uiBundleUrl)
  })

  window.localStorage.setItem('tw-keymap-overrides', JSON.stringify({ highlight: 'Mod-Alt-h' }))
  shortcutUi = await import(`${uiBundleUrl.href}?t=${Date.now()}`)
  assert.equal(
    shortcutUi.effectiveKeys('editor.highlight'),
    'Mod-Alt-h',
    'a valid persisted override is the effective binding'
  )
  assert.equal(
    typeof shortcutUi.liveShortcutLabel,
    'function',
    'the real keymap store exports the shared live shortcut-label resolver'
  )
  assert.equal(
    typeof shortcutUi.onKeymapChanged,
    'function',
    'the real keymap store exports the reactive keymap-change subscription'
  )
  let keymapChanges = 0
  const stopWatchingKeymap = shortcutUi.onKeymapChanged(() => { keymapChanges += 1 })
  window.dispatchEvent(new window.Event(shortcutUi.KEYMAP_CHANGED_EVENT))
  assert.equal(keymapChanges, 1, 'the keymap-change subscription delivers a rebind event')
  stopWatchingKeymap()
  window.dispatchEvent(new window.Event(shortcutUi.KEYMAP_CHANGED_EVENT))
  assert.equal(keymapChanges, 1, 'the keymap-change subscription removes its listener cleanly')
  assert.equal(
    typeof shortcutUi.objectMenuEntries,
    'function',
    'the context menu exposes its guarded registry-to-action projection'
  )
  {
    const originalError = console.error
    const errors = []
    console.error = (...args) => { errors.push(args.map(String).join(' ')) }
    try {
      const objectRows = shortcutUi.objectMenuEntries([...LAYOUTS, futureObject])
      assert.deepEqual(
        objectRows.map((entry) => entry.name),
        ['table', 'mindmap', 'chart', 'mermaid', 'diagram', 'svg'],
        'the guarded context-menu projection keeps the six mockup rows in order'
      )
      assert.equal(
        errors.some((message) => message.includes('insert-future-object')),
        true,
        'an unknown registry-derived context-menu action is reported and filtered'
      )
    } finally {
      console.error = originalError
    }
  }
  assert.equal(
    [...shortcutUi.renderSlideContextMenu().matchAll(/data-slide-action="insert-[^"]+"/g)].length,
    6,
    'the rendered Insert object group remains the six mockup rows'
  )
  assert.equal(
    shortcutUi.liveShortcutLabel('editor.highlight'),
    '⌘⌥H',
    'the shared live label maps a shortcut id to its stored editor-command override'
  )
  assert.equal(
    shortcutUi.liveCommandShortcutLabel({ shortcutId: 'editor.highlight' }),
    '⌘⌥H',
    'toolbar and palette command labels resolve the live override behaviourally'
  )
  assert.match(
    shortcutUi.renderKeyboardHelp(),
    /⌘⌥H/,
    'the cheat sheet renders the live highlight override'
  )
  assert.match(
    shortcutUi.renderSlideContextMenu(),
    /⌘⌥H/,
    'the ⌘K formatting group renders the same live highlight override'
  )

  window.localStorage.setItem('tw-keymap-overrides', JSON.stringify({ highlight: 'Mod-' }))
  assert.equal(
    shortcutUi.effectiveKeys('editor.highlight'),
    '',
    'a malformed persisted override is not displayed as an effective binding'
  )
  assert.equal(
    shortcutUi.buildEditorKeyBindings().some((binding) => binding.key === 'Mod-'),
    false,
    'the same malformed persisted override cannot create a firing binding'
  )
  assert.equal(
    shortcutUi.liveShortcutLabel('editor.highlight'),
    'no default',
    'a malformed override falls back to the command’s truthful unbound label'
  )
  assert.equal(
    shortcutUi.liveCommandShortcutLabel({ shortcutId: 'editor.highlight' }),
    'no default',
    'toolbar and palette command labels reject the same malformed override'
  )

  // ── Talk search 08: the talk-search keys in the cheat sheet and the picker's hint bar, and
  //    rebinding them. ──
  window.localStorage.setItem('tw-keymap-overrides', '{}')
  const sheet = shortcutUi.renderKeyboardHelp()
  const sheetRow = (label) => {
    const at = sheet.indexOf(`>${label}</div>`)
    assert(at > 0, `the cheat sheet lists “${label}”`)
    const rowStart = sheet.lastIndexOf('<div style="display:flex', at)
    return [...sheet.slice(rowStart, at).matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((match) => match[1]).join(' ')
  }
  for (const [label, keys] of [
    ['Find a talk', '⇧⌘S'],
    ['Add the talk beside', '⌘↵'],
    ['Show the result’s talk beside', 'O'],
    ['Close the talk beside', 'Esc'],
    ['Select whole section', '⇧⌘↵'],
    ['Open Talks panel search', '⌘⇧T'],
    ['Focus filter', '/'],
    ['Select section', 'S'],
    ['Sort talks', 'S']
  ]) assert.equal(sheetRow(label), keys, `the cheat sheet row “${label}” shows ${keys}`)
  assert.match(sheet, /Slide picker · Talks/, 'the cheat sheet has a Slide picker section for the talk-search keys')
  const hintKeys = (markup, id) => {
    const span = markup.match(new RegExp(`data-hint="${id.replace('.', '\\.')}">([\\s\\S]*?)<b>`))?.[1] ?? ''
    return [...span.matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((match) => match[1]).join(' ')
  }
  const hints = shortcutUi.renderSlidePickerHints()
  assert.equal(hintKeys(hints, 'slide-picker.talk-beside'), 'O', 'the hint bar shows O for talk beside')
  assert.equal(hintKeys(hints, 'slide-picker.select-whole-section'), '⇧⌘↵', 'the hint bar shows ⇧⌘↵ for select whole section')
  assert.match(hints, /data-hint="slide-picker\.select-whole-section">[\s\S]*?<b>select whole section<\/b>/, 'the hint bar names it select whole section')
  assert.doesNotMatch(hints, /insert section/i, 'no hint still says insert section')
  assert.equal(hintKeys(hints, 'slide-picker.select-section'), 'S', 'the hint bar shows S for select section')
  assert.equal(hintKeys(hints, 'slide-picker.move'), '↑ ↓ ← →', 'the hint bar shows the four arrows as four keys')
  assert.equal(hintKeys(hints, 'app.find-talk'), '⇧⌘S', 'the hint bar shows ⇧⌘S for Find a talk')

  const surface = shortcutUi.EDITOR_COMMANDS.filter((command) => command.surface)
  assert.deepEqual(
    surface.map((command) => [command.id, command.shortcutId, command.category]),
    [
      ['find-talk', 'app.find-talk', 'Slide picker'],
      ['add-beside', 'slide-picker.add-beside', 'Slide picker'],
      ['talk-beside', 'slide-picker.talk-beside', 'Slide picker'],
      ['close-beside', 'slide-picker.close-beside', 'Slide picker'],
      ['select-whole-section', 'slide-picker.select-whole-section', 'Slide picker']
    ],
    'the five talk-search keys are Settings rows (rebindable), grouped under Slide picker'
  )
  assert.deepEqual(
    Object.entries(shortcutUi.SURFACE_KEYS),
    surface.map((command) => [command.id, command.shortcutId]),
    'every rebindable surface key has its Settings row under the same local id'
  )
  const editorKeys = shortcutUi.buildEditorKeyBindings().map((binding) => binding.key)
  for (const key of ['o', 'Mod-Shift-Enter', 'Mod-Shift-s']) {
    assert.equal(editorKeys.includes(key), false, `a surface key (${key}) is never an editor binding, so O still types in the editor`)
  }
  const press = (key, modifiers = {}) => new window.KeyboardEvent('keydown', { key, ...modifiers })
  assert.equal(shortcutUi.surfaceKey(press('o'), 'talk-beside'), true, 'O is talk beside by default')
  assert.equal(shortcutUi.surfaceKey(press('Enter', { metaKey: true, shiftKey: true }), 'select-whole-section'), true, '⇧⌘↵ is select whole section by default')
  assert.equal(shortcutUi.surfaceKey(press('Enter', { metaKey: true }), 'select-whole-section'), false, '⌘↵ alone is not select whole section (it inserts the selected slides)')
  assert.equal(shortcutUi.surfaceKey(press('s', { metaKey: true, shiftKey: true }), 'find-talk'), true, '⇧⌘S is Find a talk by default')
  assert.equal(shortcutUi.surfaceKey(press('Enter', { metaKey: true }), 'add-beside'), true, '⌘↵ is add beside by default')
  assert.equal(shortcutUi.surfaceKey(press('Escape'), 'close-beside'), true, 'Esc closes the talk beside by default')
  assert.equal(shortcutUi.isTypingKey(press('o')), true, 'a plain O is typing in a field')
  assert.equal(shortcutUi.isTypingKey(press('Enter', { metaKey: true })), false, 'a chord is never typing')

  // Rebound in Settings (the override store): the new key acts, the old one no longer does, and the
  // cheat sheet, the hint bar and the palette hint all show the new key.
  window.localStorage.setItem('tw-keymap-overrides', JSON.stringify({ 'talk-beside': 'Mod-Alt-o', 'select-whole-section': 'Alt-Enter' }))
  assert.equal(shortcutUi.surfaceKey(press('o', { metaKey: true, altKey: true }), 'talk-beside'), true, 'a rebound talk beside answers its new key')
  assert.equal(shortcutUi.surfaceKey(press('o'), 'talk-beside'), false, 'and no longer its old O')
  assert.equal(shortcutUi.surfaceKey(press('Enter', { altKey: true }), 'select-whole-section'), true, 'a rebound select whole section answers ⌥↵')
  assert.equal(shortcutUi.surfaceKey(press('Enter', { metaKey: true, shiftKey: true }), 'select-whole-section'), false, 'and no longer ⇧⌘↵')
  assert.equal(shortcutUi.liveShortcutLabel('slide-picker.talk-beside'), '⌘⌥O', 'the live label follows the rebind')
  assert.equal(shortcutUi.liveCommandShortcutLabel(paletteCommands().find((command) => command.id === 'talk-beside')), '⌘⌥O', 'the palette row shows the rebind')
  assert.match(shortcutUi.renderKeyboardHelp(), /<kbd[^>]*>⌘⌥O<\/kbd>/, 'the cheat sheet shows the rebind')
  assert.equal(hintKeys(shortcutUi.renderSlidePickerHints(), 'slide-picker.talk-beside'), '⌘⌥O', 'the hint bar shows the rebind')
  assert.equal(hintKeys(shortcutUi.renderSlidePickerHints(), 'slide-picker.select-whole-section'), '⌥↵', 'the hint bar shows the rebound select whole section')
  assert.equal(shortcutUi.buildEditorKeyBindings().some((binding) => binding.key === 'Mod-Alt-o'), false, 'a rebound surface key is still not an editor binding')

  window.localStorage.setItem('tw-keymap-overrides', '{}')
  assert.match(
    shortcutUi.renderKeyboardHelp(),
    /no default/,
    'the cheat sheet uses the shared no-default vocabulary for unbound commands'
  )
  assert.match(
    shortcutUi.renderSlideContextMenu(),
    /no default/,
    'the ⌘K formatting group uses the shared no-default vocabulary'
  )
} finally {
  dom.window.close()
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete globalThis.window
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete globalThis.document
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete globalThis.navigator
  rmSync(uiBundleDir, { recursive: true, force: true })
}

const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
assert(!main.includes("label: 'Inspector mode'"), 'main menu item must be generated from the command register')
assert(main.includes('menuCommands()'), 'main menu builder consumes the command register')
const osRoleAllowlist = new Map([
  ['appMenu', 'macOS-standard application menu, including About and Quit'],
  ['fileMenu', 'Electron-standard File menu'],
  ['editMenu', 'OS-standard undo, cut, copy, paste and selection roles'],
  ['viewMenu', 'Electron-standard View menu'],
  ['windowMenu', 'OS-standard window management roles'],
  ['close', 'OS-standard Close Window role in the File menu, beside New Window']
])
const nativeRoles = [...main.matchAll(/\{ role: '([^']+)'(?: as const)? \}/g)].map((match) => match[1])
assert.deepEqual(nativeRoles.filter((role) => !osRoleAllowlist.has(role)), [], 'native menu role needs a command or justified OS allowlist entry')

console.log(`command registry parity: ${COMMAND_REGISTRY.length} commands, ${expectedPaletteIds.length} palette entries, ${menuCommands().length} custom menu item`)
