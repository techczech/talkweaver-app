// Onboarding 0.38.1 ticket 01: every command has a task group and the palettes list every command.
//   - each registry command (and each shortcut row) has exactly one of the ten task groups and a
//     sub-group, or is a key inside a surface (lock decision 13: 47 of them, in no group);
//   - the command map (docs/design/2026-10-09-onboarding-and-command-help/command-map-talkweaver.json)
//     matches the registries: same ids, labels, groups, sub-groups, except the listed placements;
//   - every command is either in the editor palette or on the written exclusion list; every
//     presenter command is in the presenter palette or on its written list;
//   - the count per group is derived and equals the map plus the listed placements.
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
const { TASK_GROUPS, TASK_GROUP_TABLE, SURFACE_KEYS, taskGroupLabel } = await import(new URL('../src/shared/task-groups.ts', import.meta.url))
const { chordEventInit } = await import(new URL('../src/shared/chord-event.ts', import.meta.url))
const map = JSON.parse(readFileSync(new URL('../docs/design/2026-10-09-onboarding-and-command-help/command-map-talkweaver.json', import.meta.url), 'utf8'))

const results = []
const test = (name, fn) => { try { fn(); results.push([true, name]) } catch (error) { results.push([false, `${name}: ${error.message}`]) } }

// Commands the map leaves out, or marks "Did not fit": placed by the builder from the map's
// neighbours, reported to the owner. Id -> [task, subgroup].
const BUILDER_PLACED = {
  // Plain editing view ticket 01: the two editor tabs sit with the other views.
  'view-plain': ['See the talk', 'Views (editor, strip, grid)'],
  'view-markdown': ['See the talk', 'Views (editor, strip, grid)'],
  // Plain editing view ticket 04: the margin menus' palette entries.
  'change-heading-level': ['Write the outline', 'Headings and levels'],
  'change-slide-layout': ['Build a slide', 'Layouts'],
  'undo': ['Write the outline', 'Undo and redo'],
  'redo': ['Write the outline', 'Undo and redo'],
  'format-strikethrough': ['Write the outline', 'Format text'],
  'format-underline': ['Write the outline', 'Format text'],
  'app.context-menu': ['Set up TalkWeaver', 'Command palette'],
  'get-started-show-example': ['Set up TalkWeaver', 'Get started'],
  'get-started-open-guide': ['Set up TalkWeaver', 'Get started'],
  'get-started-show-guide-button': ['Set up TalkWeaver', 'Get started'],
  'presenter.command-palette': ['Present', 'Help and commands'],
  'presenter.help': ['Present', 'Help and commands'],
  'presenter.rebind': ['Present', 'Help and commands'],
  // Ticket 10: the Guide column's command in the presenter, on C.
  'presenter.guide': ['Present', 'Help and commands'],
  'presenter.pointer': ['Present', 'Display modes'],
  'presenter.pen': ['Present', 'Display modes'],
  'presenter.pen-tool': ['Present', 'Display modes'],
  'presenter.ink-undo': ['Present', 'Display modes'],
  'presenter.ink-clear': ['Present', 'Display modes'],
  'presenter.ink-clear-all': ['Present', 'Display modes'],
  'presenter.embed-fullscreen': ['Present', 'Display modes'],
  'presenter-palette.pen-freehand': ['Present', 'Display modes'],
  'presenter-palette.pen-arrow': ['Present', 'Display modes'],
  'presenter-palette.pen-rectangle': ['Present', 'Display modes'],
  // Collapse all / Expand all sections (the Slides outline and the grid): not in the map, placed with the views.
  'outline-collapse-all': ['See the talk', 'Views (editor, strip, grid)'],
  'outline-expand-all': ['See the talk', 'Views (editor, strip, grid)'],
  // Move slide to… / Move section to… (slide and section context menus, the palette): not in the map, placed with reordering.
  'move-slide-to': ['Write the outline', 'Reorder slides and items'],
  'move-section-to': ['Write the outline', 'Reorder slides and items'],
  // Shift-Enter in a quotation: a key added after the map was drawn, placed with the list keys.
  'editor.quote-paragraph': ['Write the outline', 'Lists'],
  // Quote forms (ADR-0038): "Quote form: Tweet" and its six siblings, the palette's way to set a quote slide's form.
  'quote-form-auto': ['Build a slide', 'Layouts'],
  'quote-form-plain': ['Build a slide', 'Layouts'],
  'quote-form-tweet': ['Build a slide', 'Layouts'],
  'quote-form-video': ['Build a slide', 'Layouts'],
  'quote-form-book': ['Build a slide', 'Layouts'],
  'quote-form-paper': ['Build a slide', 'Layouts'],
  'quote-form-web': ['Build a slide', 'Layouts']
}
// Map records whose label differs from the registry's (value = the registry's label). Ticket 03: ⌘K is
// Actions here, so the map's "Context menu" reads "Actions here" in the registry.
// 'icon-picker': the palette names it "Insert icon…" since plain view ticket 13 (Command-I puts an
// icon on the caret's line); the Insert menu still shows the map's "Icon…" (its toolbar menuLabel).
const KNOWN_LABEL_DIFFERENCES = { 'app.context-menu': 'Actions here', 'icon-picker': 'Insert icon…' }

const presenterNoKey = presenterPaletteEntries().filter((entry) => !entry.shortcut)
const registryLabels = new Map([
  ...COMMAND_REGISTRY.map((command) => [command.id, command.label]),
  ...presenterNoKey.map((entry) => [`presenter-palette.${entry.id}`, entry.name])
])

test('the ten task groups are the map\'s, in its order', () => {
  assert.deepEqual([...TASK_GROUPS], map.tasks.map((task) => task.name))
})

test('every registry command has exactly one of the ten task groups and a sub-group, or is a key inside a surface', () => {
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
  assert.equal(surfaceKeys, 47, 'the 47 keys inside a surface are the registry rows marked so in the map')
})

test('the keys inside a surface are exactly the map\'s 47 records of that class', () => {
  const mapped = map.records.filter((record) => record.class !== 'command')
  assert.equal(mapped.length, 47)
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
    if (BUILDER_PLACED[record.id]) continue
    assert.deepEqual([...TASK_GROUP_TABLE[record.id]], [record.task, record.subgroup], `group of ${record.id}`)
  }
  for (const [id, placed] of Object.entries(BUILDER_PLACED)) assert.deepEqual([...TASK_GROUP_TABLE[id]], placed, `builder placement of ${id}`)
})

test('every registry command and presenter entry without a key is in the map or a builder placement', () => {
  const mapIds = new Set(map.records.map((record) => record.id))
  for (const id of registryLabels.keys()) assert(mapIds.has(id) || BUILDER_PLACED[id], `${id} is neither mapped nor placed`)
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

test('the count per task group is derived and equals the map plus the builder\'s placements', () => {
  const counts = taskGroupCounts()
  const expected = Object.fromEntries(TASK_GROUPS.map((group) => [group, 0]))
  for (const record of map.records.filter((r) => r.class === 'command' && !BUILDER_PLACED[r.id])) expected[record.task] += 1
  for (const [, [task]] of Object.entries(BUILDER_PLACED)) expected[task] += 1
  assert.deepEqual(counts, expected)
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 232) // ticket 12 adds get-started-show-example; plain view adds view-plain, view-markdown and the two margin-menu commands; quote forms add seven; collapse all and expand all add two; Move slide to… and Move section to… add two (merged: base 225 + plain view 4 + Move-to 2); Shift-Enter in a quotation adds one
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

  test('a palette row shows its task group beside its key', () => {
    const html = ui.renderMenu([{ id: 'undo', title: 'Undo', hint: '⌘Z', group: 'Write the outline', run() {} }, { id: 'x', title: 'No group', run() {} }])
    const doc = new JSDOM(html).window.document
    const rows = [...doc.querySelectorAll('.command-menu-item')]
    assert.equal(rows.length, 2)
    assert.equal(rows[0].querySelector('.command-menu-group')?.textContent, 'Write the outline')
    assert.equal(rows[0].querySelector('.command-menu-hint')?.textContent, '⌘Z')
    assert.equal(rows[1].querySelector('.command-menu-group'), null)
  })

  test('the palette as WorkspaceLayout builds it lists every listed command with its task group', () => {
    const commands = listedPaletteCommands().map((command) => ({ id: command.id, title: command.label, group: command.taskGroup ?? undefined, run() {} }))
    const doc = new JSDOM(ui.renderMenu(commands)).window.document
    const rows = [...doc.querySelectorAll('.command-menu-item')]
    assert.equal(rows.length, commands.length)
    for (const row of rows) assert(TASK_GROUPS.includes(row.querySelector('.command-menu-group')?.textContent), `${row.textContent} shows a task group`)
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
