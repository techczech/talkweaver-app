// Onboarding 0.38.1 ticket 01: every command has a task group and the palettes list every command.
//   - each registry command (and each shortcut row) has exactly one of the current task groups and a
//     sub-group, or is a key inside a surface (lock decision 13: 52 of them, in no group);
//   - the command map (docs/design/2026-10-09-onboarding-and-command-help/command-map-talkweaver.json)
//     matches the registries: same ids, labels, groups, sub-groups, except the listed placements;
//   - every command is either in the editor palette or on the written exclusion list; every
//     presenter command is in the presenter palette or on its written list;
//   - the count per group covers all registered commands and unkeyed presenter entries.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const {
  COMMAND_REGISTRY, PALETTE_EXCLUSIONS, paletteExclusion, listedPaletteCommands, paletteCommands, taskGroupCounts
} = await import(new URL('../src/shared/command-registry.ts', import.meta.url))
const { SHORTCUT_REGISTRY, shortcutEventMatches } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const { PRESENTER_PALETTE, KEYS_NOT_IN_PALETTE, presenterPaletteEntries, presenterPaletteData } = await import(new URL('../src/shared/presenter-palette.ts', import.meta.url))
const { TASK_GROUPS, TASK_GROUP_ICONS, TASK_GROUP_TABLE, SURFACE_KEYS, taskGroupLabel } = await import(new URL('../src/shared/task-groups.ts', import.meta.url))
const { chordEventInit } = await import(new URL('../src/shared/chord-event.ts', import.meta.url))
const map = JSON.parse(readFileSync(new URL('../docs/design/2026-10-09-onboarding-and-command-help/command-map-talkweaver.json', import.meta.url), 'utf8'))

const results = []
const test = (name, fn) => { try { fn(); results.push([true, name]) } catch (error) { results.push([false, `${name}: ${error.message}`]) } }

// Exceptions to the original design snapshot. New commands declare their group in task-groups.ts.
const KNOWN_GROUP_DIFFERENCES = {
  'undo': ['Outlining', 'Undo and redo'],
  'redo': ['Outlining', 'Undo and redo'],
  'app.context-menu': ['Set up TalkWeaver', 'Command palette'],
  'editor.jump-prev': ['Outlining', 'Headings and levels'],
  'editor.jump-next': ['Outlining', 'Headings and levels'],
  'presenter.command-palette': ['Present', 'Help and commands'],
  'presenter.help': ['Present', 'Help and commands'],
  'present-from-here': ['Present', 'Start presenting'],
  'present-presenter': ['Present', 'Start presenting'],
  'present-window': ['Present', 'Start presenting'],
  'present-audience': ['Present', 'Start presenting'],
  'plan-run': ['Present', 'Plan a session']
}
const CURRENT_SUBGROUP_NAMES = {
  'Views (slides, grid, strip)': 'Views',
  'Importer, Studio, History': 'Importer, Studio, Runs',
  'Plan a run': 'Plan a Run'
}

// Map records whose label differs from the registry's (value = the registry's label). Ticket 03: ⌘K is
// Actions here, so the map's "Context menu" reads "Actions here" in the registry.
// 'icon-picker': the palette names it "Insert icon…" since plain view ticket 13 (Command-I puts an
// icon on the caret's line); the Insert menu still shows the map's "Icon…" (its toolbar menuLabel).
// The editor's Present menu renamed its launch and planning commands in November 2026.
// history: the old name of the Runs command, kept as an alias (R5).
const KNOWN_LABEL_DIFFERENCES = {
  'promote-heading': 'One level up',
  'demote-heading': 'One level down',
  'editor.promote': 'One level up',
  'editor.demote': 'One level down',
  'view-slides': 'View: Slide',
  'view-plain': 'View: Outline',
  'view-markdown': 'View: Markdown', 'app.context-menu': 'Actions here', 'icon-picker': 'Insert icon…', history: 'TalkWeaver Runs… (History)',
  'present-from-here': 'Presenter view from this slide',
  'present-presenter': 'Presenter view from the start',
  'present-window': 'Present in single screen from the start',
  'plan-run': 'Plan a session with an audience…'
}

const presenterNoKey = presenterPaletteEntries().filter((entry) => !entry.shortcut)
const registryLabels = new Map([
  ...COMMAND_REGISTRY.map((command) => [command.id, command.label]),
  ...presenterNoKey.map((entry) => [`presenter-palette.${entry.id}`, entry.name])
])

test('Outlining and Formatting replace Write the outline in the historical task order', () => {
  const historicalOrder = map.tasks.map((task) => task.name)
  assert.deepEqual([...TASK_GROUPS], historicalOrder.flatMap((task) =>
    task === 'Write the outline' ? ['Outlining', 'Formatting'] : [task]))
  assert.ok(TASK_GROUP_ICONS.Outlining && TASK_GROUP_ICONS.Formatting)
  assert.notEqual(TASK_GROUP_ICONS.Outlining, TASK_GROUP_ICONS.Formatting)
})

const FORMATTING_COMMANDS = new Set([
  'format-bold', 'editor.bold', 'format-italic', 'editor.italic',
  'format-inline-code', 'editor.inline-code', 'format-highlight', 'editor.highlight',
  'format-strikethrough', 'editor.strikethrough', 'format-underline', 'editor.underline',
  'format-link', 'editor.link', 'bulleted-list', 'editor.bulleted-list',
  'numbered-list', 'editor.numbered-list'
])

test('Formatting contains text styling, links and list styles', () => {
  const formatting = Object.entries(TASK_GROUP_TABLE).filter(([, [group]]) => group === 'Formatting')
  assert.deepEqual(new Set(formatting.map(([id]) => id)), FORMATTING_COMMANDS)
})

test('list structure, folding and heading navigation are in Outlining', () => {
  for (const id of ['editor.list-continue', 'editor.quote-paragraph', 'editor.list-indent',
    'editor.list-outdent', 'fold-all', 'unfold-all', 'editor.jump-prev', 'editor.jump-next']) {
    assert.equal(TASK_GROUP_TABLE[id]?.[0], 'Outlining', id)
  }
})

test('every registry command has exactly one of the current task groups and a sub-group, or is a key inside a surface', () => {
  let surfaceKeys = 0
  for (const command of COMMAND_REGISTRY) {
    if (command.surface) {
      surfaceKeys += 1
      assert.equal(command.taskGroup, null, `${command.id}: a surface key has no task group`)
      continue
    }
    assert(TASK_GROUPS.includes(command.taskGroup), `${command.id} ("${command.label}") has no task group; add it to src/shared/task-groups.ts`)
    assert(typeof command.subgroup === 'string' && command.subgroup.length > 0, `${command.id} has no sub-group`)
  }
  assert.equal(surfaceKeys, 50, 'the 50 keys inside a surface are the registry rows marked so in the map')
})

test('the keys inside a surface are exactly the map\'s 50 records of that class', () => {
  const mapped = map.records.filter((record) => record.class !== 'command')
  assert.equal(mapped.length, 50)
  assert.deepEqual(Object.keys(SURFACE_KEYS).sort(), mapped.map((record) => record.id).sort())
  for (const record of mapped) assert.equal(SURFACE_KEYS[record.id], record.surface, record.id)
})

test('every shortcut row has a task group (app and presenter scopes) or is a key inside a surface, and agrees with its command', () => {
  for (const row of SHORTCUT_REGISTRY) {
    if (row.surface) { assert.equal(row.taskGroup, null); assert(SURFACE_KEYS[row.id], `${row.id}: surface not in SURFACE_KEYS`); continue }
    assert(TASK_GROUPS.includes(row.taskGroup), `${row.id} ("${row.label}") has no task group`)
    assert(row.subgroup, `${row.id} has no sub-group`)
    const owner = COMMAND_REGISTRY.find((command) => command.shortcutId === row.id)
    assert(owner, `${row.id}: no command carries this shortcut`)
    assert.deepEqual([owner.taskGroup, owner.subgroup], [row.taskGroup, row.subgroup], `${row.id} and ${owner.id} disagree`)
  }
})

test('every presenter palette entry has a task group, and the generated rows carry it', () => {
  for (const entry of presenterPaletteEntries()) {
    assert(TASK_GROUPS.includes(entry.shortcut ? taskGroupLabel(entry.shortcut) : taskGroupLabel(`presenter-palette.${entry.id}`)), `${entry.id}: no task group`)
  }
  const rows = presenterPaletteData(SHORTCUT_REGISTRY).flatMap(([, entries]) => entries)
  assert(rows.length > 0 && rows.every((row) => TASK_GROUPS.includes(row.task)), 'every generated row names its task group')
})

test('the map matches the registries: ids, labels, groups and sub-groups', () => {
  for (const record of map.records.filter((r) => r.class === 'command')) {
    assert(registryLabels.has(record.id), `map record ${record.id} is in no registry`)
    const known = KNOWN_LABEL_DIFFERENCES[record.id]
    assert.equal(registryLabels.get(record.id), known ?? record.label, `label of ${record.id}`)
    const group = record.task === 'Write the outline'
      ? (FORMATTING_COMMANDS.has(record.id) ? 'Formatting' : 'Outlining')
      : record.task
    const placement = KNOWN_GROUP_DIFFERENCES[record.id] ??
      [group, CURRENT_SUBGROUP_NAMES[record.subgroup] ?? record.subgroup]
    assert.deepEqual(TASK_GROUP_TABLE[record.id], placement, `group of ${record.id}`)
  }
})

test('every command is in the editor palette or on the written exclusion list', () => {
  const listed = new Set(listedPaletteCommands().map((command) => command.id))
  for (const command of COMMAND_REGISTRY) {
    const reason = paletteExclusion(command)
    assert(listed.has(command.id) !== (reason !== null), `${command.id}: listed and excluded, or neither`)
    if (reason !== null) assert(reason.length > 0)
  }
  for (const id of Object.keys(PALETTE_EXCLUSIONS)) assert(COMMAND_REGISTRY.some((command) => command.id === id), `exclusion ${id} is not a command`)
  // Every command the palette showed before still shows, except the palette itself.
  for (const command of paletteCommands()) {
    if (command.palette.visible) assert(listed.has(command.id), `${command.id} was in the palette and no longer is`)
  }
  assert(listed.size > paletteCommands().filter((c) => c.palette.visible).length, 'the palette lists more commands than before')
  assert(!listed.has('app.command-palette'), 'the palette does not list itself')
  assert(listedPaletteCommands().every((command) => command.scope !== 'presenter'), 'presenter commands are in the presenter palette')
})

test('every presenter command is in the presenter palette or on its written list', () => {
  const inPalette = new Set(presenterPaletteEntries().map((entry) => entry.shortcut).filter(Boolean))
  for (const row of SHORTCUT_REGISTRY.filter((r) => r.scope === 'presenter')) {
    assert(inPalette.has(row.id) || KEYS_NOT_IN_PALETTE[row.id], `${row.id} ("${row.label}") is in neither`)
  }
  for (const id of Object.keys(KEYS_NOT_IN_PALETTE)) assert(SHORTCUT_REGISTRY.some((row) => row.id === id), `${id} is not a presenter key`)
})

test('each group count includes every assigned command or unkeyed presenter entry once', () => {
  const expected = Object.fromEntries(TASK_GROUPS.map((group) => [group, 0]))
  for (const id of registryLabels.keys()) {
    if (Object.hasOwn(SURFACE_KEYS, id)) continue
    assert(Object.hasOwn(TASK_GROUP_TABLE, id), `${id}: add a placement in src/shared/task-groups.ts`)
    expected[TASK_GROUP_TABLE[id][0]] += 1
  }
  assert.deepEqual(taskGroupCounts(), expected)
})

test('a chord becomes the key event that matches it', () => {
  const { window } = new JSDOM('')
  for (const row of SHORTCUT_REGISTRY) {
    for (const code of row.codes) {
      if (code.endsWith('-')) continue
      const event = new window.KeyboardEvent('keydown', chordEventInit(code))
      assert(shortcutEventMatches(event, row.id, code), `${row.id}: ${code} does not round-trip`)
    }
  }
})

// Render tests: the palette row, the shortcut sheet and Settings → shortcuts show task groups.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(root, '.test-task-groups-'))
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://talkweaver.test/' })
const saved = ['window', 'document', 'navigator'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
for (const name of ['window', 'document', 'navigator']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name === 'window' ? 'window' : name] })
try {
  const outfile = join(bundleDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import CommandMenu from './src/renderer/src/components/CommandMenu.tsx'",
        "import KeyboardHelp from './src/renderer/src/components/KeyboardHelp.tsx'",
        "export { EDITOR_COMMANDS } from './src/renderer/src/keymap/registry.ts'",
        "export function renderMenu(commands) { return renderToStaticMarkup(React.createElement(CommandMenu, { isOpen: true, onClose() {}, commands })) }",
        "export function renderHelp() { return renderToStaticMarkup(React.createElement(KeyboardHelp, { isOpen: true, onClose() {} })) }"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-task-groups-entry.tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react', '@codemirror/*'],
    outfile
  })
  const ui = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)

  test('empty palette shows distinct task categories with icons instead of command rows', () => {
    const html = ui.renderMenu([{ id: 'undo', title: 'Undo', hint: '⌘Z', group: 'Outlining', run() {} }, { id: 'x', title: 'No group', run() {} }])
    const doc = new JSDOM(html).window.document
    const rows = [...doc.querySelectorAll('.command-menu-item')]
    assert.equal(rows.length, TASK_GROUPS.length)
    assert.equal(doc.querySelectorAll('[data-task-group]').length, TASK_GROUPS.length)
    assert.equal(doc.querySelectorAll('[data-group-icon]').length, TASK_GROUPS.length)
    assert.equal(doc.querySelectorAll('[data-command]').length, 0)
  })

  test('the palette categories count every listed command in the registry', () => {
    const commands = listedPaletteCommands().map((command) => ({ id: command.id, title: command.label, group: command.taskGroup ?? undefined, run() {} }))
    const doc = new JSDOM(ui.renderMenu(commands)).window.document
    const rows = [...doc.querySelectorAll('[data-task-group]')]
    assert.deepEqual(rows.map(row => row.dataset.taskGroup), TASK_GROUPS)
    assert.equal(rows.reduce((sum, row) => sum + Number(row.dataset.count), 0), commands.length)
  })

  test('the shortcut sheet and Settings → shortcuts head their sections by task group, not by the old group names', () => {
    const doc = new JSDOM(ui.renderHelp()).window.document
    const text = doc.body.textContent
    const oldNames = new Set(SHORTCUT_REGISTRY.filter((row) => row.scope !== 'presenter').map((row) => row.group))
    for (const group of TASK_GROUPS) if (SHORTCUT_REGISTRY.some((row) => row.scope !== 'presenter' && row.taskGroup === group)) assert(text.includes(group), `the sheet shows ${group}`)
    assert(!text.includes('Find & insert') && !text.includes('Modes & display'), 'old group names are not shown')
    assert(oldNames.size > 0)
    const surfaces = new Set(Object.values(SURFACE_KEYS))
    for (const command of ui.EDITOR_COMMANDS) assert(TASK_GROUPS.includes(command.category) || surfaces.has(command.category), `Settings category "${command.category}" of ${command.id} is a task group or a surface`)
  })
} finally {
  for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  rmSync(bundleDir, { recursive: true, force: true })
}

let failed = 0
for (const [ok, message] of results) { console.log(`${ok ? 'ok' : 'FAIL'}  ${message}`); if (!ok) failed += 1 }
console.log(failed ? `${failed} of ${results.length} failed` : `task groups: ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
