import { readPresenterTemplate } from '../compiler/scripts/lib/presenter-template.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { toAccelerator } from '@app-patterns/commands'
import { SHORTCUT_REGISTRY, SHORTCUT_SCOPES, shortcutEventMatches } from '../src/shared/shortcut-registry.ts'
import { COMMAND_REGISTRY, listedPaletteCommands, paletteExclusion, toolsWindowCommands } from '../src/shared/command-registry.ts'
import { EVERYWHERE, NOT_BY_PLACE, PLACES, offeredAt } from '../src/shared/command-places.ts'
import { appCommandIdOf, bridleIdOf, bridleIdOfKeymapId, keymapIdOf, registry } from '../src/shared/bridle-commands.ts'
import { overridesFromStore, storeWritesFor } from '../src/shared/keymap-overrides.ts'
import { keyboardSheet } from '../src/shared/keyboard-sheet.ts'
import { viewKeySections } from '../src/shared/view-keys.ts'
import { PRESENTER_KEY_NEEDS } from '../src/shared/presenter-palette.ts'
import { updateCheckMenuTemplate } from '../src/main/settings-update-menu.ts'
import { renderTemplateWithShortcutHelp, renderIconsModule, iconsModulePath } from './build-shortcut-help.mjs'

const shortcuts = new Map(SHORTCUT_REGISTRY.map(entry => [entry.id, entry]))
const commands = new Map(COMMAND_REGISTRY.map(command => [command.id, command]))
const palette = new Map(listedPaletteCommands().map(command => [command.id, command]))
const defaultLabel = id => shortcuts.get(id).unbound ? 'no default' : shortcuts.get(id).keys

function nativeMenu(keys = {}, editorKeys) {
  const flatten = items => items.flatMap(item => [item, ...flatten(item.submenu ?? [])])
  return flatten(updateCheckMenuTemplate({ platform: 'darwin', keys, editorKeys, run() {}, log() {} }))
}

function sheetRows(chordOf = defaultLabel) {
  const sheet = keyboardSheet({ place: null, chordOf, defaultChordOf: defaultLabel, canRun: id => palette.has(id) })
  return [...sheet.groups, ...sheet.surfaces].flatMap(section => section.rows)
}

const template = readPresenterTemplate()

function generatedPresenterData(name) {
  // The generator serialises these values as one JSON declaration per line.
  const prefix = `  const ${name} = `
  const declaration = template.split('\n').find(line => line.startsWith(prefix))
  assert.ok(declaration?.endsWith(';'), `missing generated presenter data: ${name}`)
  return JSON.parse(declaration.slice(prefix.length, -1))
}

const root = fileURLToPath(new URL('../', import.meta.url))
const renderer = async () => {
  // The renderer resolves extensionless imports through its bundler. Keep CodeMirror instances shared.
  const { outputFiles } = await build({
    stdin: {
      contents: `
        export { EDITOR_COMMANDS, NON_CONSUMING } from './src/renderer/src/keymap/registry'
        export * from './src/renderer/src/keymap/store'
        export { resolveActionBarItems } from './src/renderer/src/components/actionBar/model'
        export { EditorView, keymap } from '@codemirror/view'
        export { EditorState } from '@codemirror/state'
      `,
      resolveDir: root
    },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['@codemirror/*', 'react', 'react/*']
  })
  const dir = mkdtempSync(join(tmpdir(), 'tw-test-shortcuts-'))
  try {
    // Resolve the external renderer packages from the checkout when importing the scratch bundle.
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction')
    const bundle = join(dir, 'renderer.mjs')
    writeFileSync(bundle, outputFiles[0].contents)
    return await import(pathToFileURL(bundle).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('registry entries have unique ids, valid scopes and display metadata', () => {
  assert.equal(shortcuts.size, SHORTCUT_REGISTRY.length, 'duplicate shortcut id')
  assert.equal(commands.size, COMMAND_REGISTRY.length, 'duplicate command id')
  for (const entry of SHORTCUT_REGISTRY) {
    assert.ok(SHORTCUT_SCOPES.includes(entry.scope), `${entry.id}: unknown scope ${entry.scope}`)
    for (const field of ['id', 'label', 'group', 'explanation', 'keys']) {
      assert.ok(entry[field]?.trim(), `${entry.id}: missing ${field}`)
    }
    assert.equal(entry.codes.length === 0, Boolean(entry.unbound), `${entry.id}: bound state disagrees with codes`)
    assert.ok(entry.codes.every(code => code.trim()), `${entry.id}: blank code`)
  }
})

// Each allowance names a pair and its one shared chord, so a third owner still causes a failure.
const contextPairs = [
  ['Escape', 'editor.rollback-trigger', 'editor.object-leave'], // Trigger rollback gets first refusal.
  ['Backspace', 'editor.protect-heading-delete', 'editor.object-delete'], // Heading guard vs selected object.
  ['Escape', 'slide-picker.close', 'slide-picker.close-beside'], // Close the talk beside first.
  ['Backspace', 'slide-picker.clear-scope', 'slide-picker.remove-chip'], // Empty Find a talk box owns its chips.
  ['Mod-Enter', 'slide-picker.insert', 'slide-picker.add-beside'], // Find a talk results vs selected slides.
  ['ArrowRight', 'presenter.next', 'presenter.instant-return'], // Return first while on an instant slide.
  ['Enter', 'presenter.next', 'presenter.save-run'], // The run-save offer takes Enter while visible.
  ['Mod-z', 'presenter.ink-undo', 'presenter.board-undo'], // Pen and board each have their own undo.
  ['digit1-digit9', 'presenter.grid-child', 'presenter.video-marker'], // Grid beats keep the digits.
  ['z', 'presenter.gallery', 'presenter.embed-fullscreen'] // The slide's picture takes precedence over its embed.
]

function bindingKey(code, primary) {
  const base = code.replace(/^(?:(?:Mod|Ctrl|Alt|Shift)-)*/, '')
  const mods = new Set(code.slice(0, code.length - base.length).split('-').filter(Boolean))
  if (mods.delete('Mod')) mods.add(mods.has('Ctrl') ? 'Meta' : primary)
  return [...mods].sort().concat(base.toLowerCase()).join('+')
}

test('each chord has one owner per scope and platform, except documented context overlaps', async () => {
  const { EDITOR_COMMANDS, NON_CONSUMING } = await renderer()
  const editorOrder = new Map(EDITOR_COMMANDS.filter(command => !command.surface)
    .map((command, index) => [command.shortcutId, { index, fallsThrough: NON_CONSUMING.has(command.id) }]))
  const conflicts = []
  for (const primary of ['Meta', 'Ctrl']) {
    const overlaps = new Map()
    const pairKey = (code, a, b) => JSON.stringify([bindingKey(code, primary), ...[a, b].sort()])
    const allowed = new Set(contextPairs.map(([code, a, b]) => pairKey(code, a, b)))
    for (const entry of SHORTCUT_REGISTRY) {
      for (const code of entry.codes) {
        const binding = bindingKey(code, primary)
        const key = `${entry.scope}: ${binding}`
        const sharers = overlaps.get(key) ?? new Set()
        for (const other of sharers) {
          if (other === entry.id || allowed.has(pairKey(code, other, entry.id))) continue
          const previous = editorOrder.get(other)
          const current = editorOrder.get(entry.id)
          if (entry.scope === 'editor' && previous && current &&
            (previous.index < current.index ? previous : current).fallsThrough) continue
          conflicts.push(`${primary} ${key}: ${other} and ${entry.id} both claim ${code}`)
        }
        sharers.add(entry.id)
        overlaps.set(key, sharers)
      }
    }
  }
  assert.deepEqual(conflicts, [], 'duplicate shortcut bindings')
})

test('every command has a menu, palette or documented place to use it', () => {
  const menu = nativeMenu()
  const inMenu = new Set(menu.filter(item => item.id).map(item => appCommandIdOf(item.id)))
  const toolPalette = new Set(toolsWindowCommands().map(command => command.id))
  const presenterPalette = new Set(generatedPresenterData('PRESENTER_PALETTE')
    .flatMap(([, entries]) => entries.map(entry => entry.shortcut)))
  const missing = COMMAND_REGISTRY.filter(command => {
    if (inMenu.has(command.id) || palette.has(command.id) || toolPalette.has(command.id) ||
      presenterPalette.has(command.shortcutId)) return false
    if (command.places === EVERYWHERE || PLACES.some(place => offeredAt(command.places, place))) return false
    // NOT_BY_PLACE is a declaration of scope, not a route on its own.
    return !(command.places === NOT_BY_PLACE && paletteExclusion(command)?.trim())
  })
  assert.deepEqual(missing.map(command => command.id), [], 'commands with no menu, palette or documented place')
  for (const def of registry.defs) {
    if (def.noMenu) {
      assert.ok(def.noMenuReason?.trim(), `${def.id}: missing menu exclusion reason`)
      continue
    }
    // App Patterns' native frame uses roles and label-only Settings/Help items.
    assert.ok(menu.some(item => item.id === def.id || item.role === def.id ||
      (!item.id && !item.role && item.label === def.label)), `${def.id}: missing native menu item`)
  }
})

test('every bound shortcut has its registry label in the keyboard sheet or presenter help', () => {
  const byShortcut = new Map()
  for (const row of sheetRows()) {
    const id = commands.get(row.commandId)?.shortcutId
    if (!id) continue
    assert.equal(row.chord, shortcuts.get(id).unbound ? 'no key' : defaultLabel(id), `${id}: sheet chord`)
    byShortcut.set(id, row.chord)
  }
  for (const section of viewKeySections()) {
    for (const row of section.rows) {
      if (!row.shortcutId) continue // Literal gesture help.
      assert.equal(row.keys, defaultLabel(row.shortcutId), `${row.shortcutId}: view help chord`)
      byShortcut.set(row.shortcutId, row.keys)
    }
  }
  const presenter = new Map(generatedPresenterData('SHORTCUTS_LIST').flatMap(([, rows]) =>
    rows.map(([keys, , needs, id]) => [id, { keys, needs }])))
  for (const entry of SHORTCUT_REGISTRY) {
    if (entry.unbound) continue
    const chord = entry.scope === 'presenter' ? presenter.get(entry.id)?.keys : byShortcut.get(entry.id)
    assert.equal(chord, entry.keys, `${entry.id}: missing or wrong chord in keyboard sheet/help`)
    if (entry.scope === 'presenter') {
      assert.equal(presenter.get(entry.id).needs, PRESENTER_KEY_NEEDS[entry.id] ?? null, `${entry.id}: help preload gate`)
    }
  }
})

test('a persisted rebind updates menu, palette, keyboard sheet, tooltip and the focused editor', async () => {
  const dom = new JSDOM('<!doctype html>', { url: 'https://talkweaver.test/', pretendToBeVisual: true })
  const globals = ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'Element', 'Node', 'Event']
  const previous = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] })
  }
  let view
  try {
    const ui = await renderer()
    const command = palette.get('format-bold')
    const menuId = bridleIdOf(command.id)
    const ids = { bridleIdOfKeymapId, keymapIdOf }
    const current = nativeMenu().find(item => item.id === menuId)
    const override = 'Mod-Alt-b'
    let keys = {}, appKeys = ''
    dom.window.tw = { keymap: {
      get: async () => ({}),
      onChanged: () => () => {},
      set: async overrides => {
        const writes = storeWritesFor(overrides, keys, ids)
        keys = Object.fromEntries(writes.rebind.map(({ commandId, chord }) => [commandId, chord]))
        appKeys = writes.appKeys
        return { ok: true, overrides: overridesFromStore(keys, appKeys, ids) }
      }
    } }
    const unsubscribe = ui.startKeymapSync()
    // Let the get() response and its store adoption settle before rebinding.
    await Promise.resolve()
    await Promise.resolve()
    let changed = 0
    const stopWatching = ui.onKeymapChanged(() => { changed += 1 })
    ui.setOverride('bold', override)
    await Promise.resolve()
    stopWatching()
    unsubscribe()
    assert.ok(changed, 'live surfaces receive the keymap change')
    assert.equal(ui.effectiveKeys(command.shortcutId), override, 'renderer reads stored rebind')
    const menu = nativeMenu(keys, appKeys).find(item => item.id === menuId)
    assert.notEqual(menu.accelerator, current.accelerator)
    assert.equal(menu.accelerator, toAccelerator('⌘⌥B'), 'native menu accelerator')
    assert.equal(menu.registerAccelerator, false, 'the menu displays the chord without stealing dispatch')
    const hint = ui.liveCommandShortcutLabel(command)
    assert.equal(hint, '⌘⌥B', 'palette hint')
    const row = sheetRows(ui.liveShortcutLabel).find(row => row.commandId === command.id)
    assert.deepEqual([row.chord, row.was], [hint, defaultLabel(command.shortcutId)], 'keyboard sheet chord and previous default')
    const buttons = resolveButtons(ui, command, hint)
    assert.equal(buttons[0].tooltip, `${command.label} (⌘⌥B)`, 'action bar tooltip')

    view = new ui.EditorView({
      parent: document.body,
      state: ui.EditorState.create({ doc: 'word', selection: { anchor: 0, head: 4 },
        extensions: [ui.keymap.of(ui.buildEditorKeyBindings())] })
    })
    view.focus()
    assert.equal(document.activeElement, view.contentDOM)
    const press = altKey => view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'b', code: 'KeyB', bubbles: true, cancelable: true, altKey,
      metaKey: process.platform === 'darwin', ctrlKey: process.platform !== 'darwin'
    }))
    press(false)
    assert.equal(view.state.doc.toString(), 'word', 'the old chord leaves the document alone')
    press(true)
    assert.equal(view.state.doc.toString(), '**word**', 'the rebound chord actually bolds the selection')
  } finally {
    view?.destroy()
    dom.window.close()
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
})

function resolveButtons(ui, command, keys) {
  const runnable = new Map([[command.id, { label: command.label, keys, run() {} }]])
  return ui.resolveActionBarItems([command.id], runnable).flatMap(section => section.items)
}

test('ControlOrMeta selects the platform primary modifier and a combined chord requires both', () => {
  const event = (key, modifiers) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers })
  for (const primary of ['metaKey', 'ctrlKey']) {
    assert.ok(shortcutEventMatches(event('/', { [primary]: true }), 'app.help'), `${primary} + / opens help`)
    assert.ok(shortcutEventMatches(event('Enter', { [primary]: true }), 'editor.object-finish'), `${primary} + Enter finishes an object`)
    assert.equal(shortcutEventMatches(event('s', { [primary]: true }), 'editor.new-section'), false, `${primary} alone leaves the other S chord alone`)
  }
  assert.equal(shortcutEventMatches(event('Enter'), 'editor.object-finish'), false)
  assert.ok(shortcutEventMatches(event('s', { metaKey: true, ctrlKey: true }), 'editor.new-section'))
  assert.ok(shortcutEventMatches(event('F8'), 'editor.object-finish', 'F8'), 'F8 finishes an object after rebinding')
  assert.equal(shortcutEventMatches(event('Enter', { metaKey: true }), 'editor.object-finish', 'F8'), false,
    'the old Command+Enter no longer finishes an object after rebinding')
})

test('Tools shortcuts leave the app and system chords free across scopes', () => {
  const protectedKeys = ['n', 'd', 'e', 'r', '1', '2', '3']
  const tools = SHORTCUT_REGISTRY.filter(entry => entry.scope === 'tools')
  for (const primary of ['Meta', 'Ctrl']) {
    const protectedChords = new Set(protectedKeys.map(key => bindingKey(`Mod-${key}`, primary)))
    const conflicts = tools.flatMap(entry => entry.codes
      .filter(code => protectedChords.has(bindingKey(code, primary)))
      .map(code => `${entry.id} claims ${code}`))
    assert.deepEqual(conflicts, [], `Tools cannot take protected chords on ${primary}`)
  }
})

test('ADR-0011 reserved chords keep their designated actions', () => {
  const reserved = new Map([
    ['Mod-Shift-p', ['app.command-palette', 'presenter.command-palette']],
    ['Mod-Shift-k', []], ['Mod-k', ['app.context-menu']], ['Mod-p', ['app.toggle-inspector']],
    ['Mod-f', ['app.find', 'importer.search']], ['Mod-Shift-f', []],
    ['Mod-,', ['app.settings']], ['Mod-/', ['app.help']], ['Mod-Shift-,', ['presenter.rebind']]
  ])
  for (const [chord, ids] of reserved) {
    const holders = SHORTCUT_REGISTRY.filter(entry => entry.codes.some(code =>
      bindingKey(code, 'Meta') === bindingKey(chord, 'Meta'))).map(entry => entry.id)
    assert.deepEqual(holders.sort(), [...ids].sort(), chord)
  }
})

test('Enter falls through an object, title and protected line before continuing a list', async () => {
  const { EDITOR_COMMANDS } = await renderer()
  const chain = ['object-edit', 'title-continue', 'protected-line-continue', 'list-continue']
  assert.deepEqual(EDITOR_COMMANDS.filter(command => chain.includes(command.id)).map(command => command.id), chain)
})

test('the command palette opens from Tools without listing itself', () => {
  const definitions = COMMAND_REGISTRY.filter(command => command.shortcutId === 'app.command-palette')
  assert.equal(definitions.length, 1)
  const [command] = definitions
  assert.equal(command.handlerId, 'app.command-palette')
  assert.equal(command.toolbar?.menu, 'tools')
  assert.equal(palette.has(command.id), false)
})

test('generated presenter help and icons are current', async () => {
  assert.equal(template, await renderTemplateWithShortcutHelp(template), 'Generated presenter shortcut help is stale')
  assert.equal(readFileSync(iconsModulePath, 'utf8'), await renderIconsModule(), 'Generated presenter icons are stale')
})
