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
  'refresh-talks', 'change-vault', 'search-talks', 'present-window', 'present-presenter',
  'present-from-here', 'present-audience', 'handout', 'build', 'publish-handout', 'layout',
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
        "export * from './src/renderer/src/components/SlideContextMenu.tsx'",
        "export * from './src/renderer/src/keymap/store.ts'",
        "export function renderKeyboardHelp() {",
        "  return renderToStaticMarkup(React.createElement(KeyboardHelp, { isOpen: true, onClose() {} }))",
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
