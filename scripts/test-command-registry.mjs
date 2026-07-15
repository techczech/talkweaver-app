import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { COMMAND_REGISTRY, commandShortcutLabel, paletteCommands, menuCommands, toolbarCommands } = await import(
  new URL('../src/shared/command-registry.ts', import.meta.url)
)
const { SHORTCUT_REGISTRY } = await import(
  new URL('../src/shared/shortcut-registry.ts', import.meta.url)
)

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
  'refresh', 'optimize-images', 'ocr-index', 'check-embeds', 'where-used', 'focus-slide',
  'toggle-inspector', 'studio', 'history', 'plan-run', 'pathways', 'new-window', 'new-talk', 'new-folder',
  'refresh-talks', 'change-vault', 'search-talks', 'present-window', 'present-presenter',
  'present-from-here', 'present-audience', 'handout', 'build', 'publish-handout', 'layout',
  'image', 'search', 'icon-picker', 'deck-design', 'metadata', 'tag-slide', 'abstract',
  'view-editor', 'view-both', 'view-strip', 'view-grid', 'fold-all', 'unfold-all',
  'normalize-triggers', 'delete-slide', 'help', 'settings'
]
assert.deepEqual(paletteCommands().map((command) => command.id), expectedPaletteIds, 'palette is generated in its existing order')

assert.deepEqual(
  menuCommands().map((command) => [command.menu.path.join('/'), command.id]),
  [['Deck', 'toggle-inspector'], ['Deck', 'pathways']],
  'native custom menu keeps its existing structure'
)

const expectedToolbarIds = {
  insert: ['layout', 'image', 'search', 'icon-picker'],
  deck: ['deck-design', 'toggle-inspector', 'pathways', 'metadata', 'abstract', 'refresh', 'normalize-triggers', 'delete-slide'],
  tools: ['studio', 'history', 'settings', 'help'],
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
    command.shortcutId ? SHORTCUT_REGISTRY.find((shortcut) => shortcut.id === command.shortcutId)?.keys : '',
    `${command.id}: toolbar hint resolves from the shortcut registry`
  )
}
assert(workspace.includes('hint: commandShortcutLabel(registered) || undefined'), 'toolbar hints use the shortcut registry helper')
assert(workspace.includes('if (import.meta.env.DEV) throw new Error(`Toolbar command has no renderer handler:'), 'missing toolbar handlers fail loudly in development')

const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
assert(!main.includes("label: 'Inspector mode'"), 'main menu item must be generated from the command register')
assert(main.includes('menuCommands()'), 'main menu builder consumes the command register')
const osRoleAllowlist = new Map([
  ['appMenu', 'macOS-standard application menu, including About and Quit'],
  ['fileMenu', 'Electron-standard File menu'],
  ['editMenu', 'OS-standard undo, cut, copy, paste and selection roles'],
  ['viewMenu', 'Electron-standard View menu'],
  ['windowMenu', 'OS-standard window management roles']
])
const nativeRoles = [...main.matchAll(/\{ role: '([^']+)'(?: as const)? \}/g)].map((match) => match[1])
assert.deepEqual(nativeRoles.filter((role) => !osRoleAllowlist.has(role)), [], 'native menu role needs a command or justified OS allowlist entry')

console.log(`command registry parity: ${COMMAND_REGISTRY.length} commands, ${expectedPaletteIds.length} palette entries, ${menuCommands().length} custom menu item`)
