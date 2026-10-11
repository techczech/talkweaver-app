// Onboarding 0.38.1 ticket 04: ⌘/ opens the keyboard sheet on where you are.
//   - the data function (place, registry, overrides in, sections out): Here first and equal to the
//     Actions-here list, then the ten task groups with counts and sub-groups, then the surfaces;
//   - rebound chords, "no key" with a Run action, the filter, no talk open;
//   - the sheet is generated: a command added to the registry adds a row;
//   - the render (Here first, counts, rows).
// The keys in the real app are e2e/diagnose-keyboard-sheet.mjs.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { keyboardSheet, searchSheet, hereHeading } from '../src/shared/keyboard-sheet.ts'
import { actionRowsAt } from '../src/shared/actions-here.ts'
import { PLACES } from '../src/shared/command-places.ts'
import { COMMAND_REGISTRY, listedPaletteCommands } from '../src/shared/command-registry.ts'
import { SHORTCUT_REGISTRY } from '../src/shared/shortcut-registry.ts'
import { TASK_GROUPS, SURFACE_KEYS } from '../src/shared/task-groups.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const test = (name, fn) => { try { fn(); results.push([true, name]) } catch (error) { results.push([false, `${name}: ${error.message}`]) } }

const defaults = (id) => { const s = SHORTCUT_REGISTRY.find((row) => row.id === id); return !s || s.unbound ? 'no default' : s.keys }
const runnable = new Set(listedPaletteCommands().map((command) => command.id))
const input = (extra = {}) => ({
  place: 'slide-heading', chordOf: defaults, defaultChordOf: defaults, canRun: (id) => runnable.has(id),
  canRunCarried: (key) => key === 'explain-rendering' || key === 'present-from-here', ...extra
})

test('the first section is Here, and it is the list Actions here shows for the same place', () => {
  for (const place of PLACES) {
    const context = place === 'vault' ? { row: 'vault' } : {}
    const sheet = keyboardSheet(input({ place, context }))
    assert.equal(sheet.opensOn, 'here', place)
    assert.deepEqual(sheet.here.rows.map((row) => row.key), actionRowsAt(place, context).map((row) => row.key), place)
    assert.equal(sheet.here.count, sheet.here.rows.length, place)
  }
})

test('Here names the place', () => {
  assert.equal(hereHeading('slide-heading'), 'Here: on a slide heading')
  assert.equal(hereHeading('slide-text'), 'Here: in slide text')
  assert.equal(hereHeading('talk'), 'Here: on a talk')
  assert.equal(keyboardSheet(input()).here.heading, 'Here: on a slide heading')
})

test('with no talk open there is no Here and the sheet opens on the first task group', () => {
  const sheet = keyboardSheet(input({ place: null }))
  assert.equal(sheet.here, null)
  assert.equal(sheet.opensOn, TASK_GROUPS[0])
})

test('then the ten task groups, in order, each with its count and sub-groups', () => {
  const sheet = keyboardSheet(input())
  assert.deepEqual(sheet.groups.map((group) => group.taskGroup), [...TASK_GROUPS])
  for (const group of sheet.groups) {
    assert.equal(group.count, group.rows.length, group.taskGroup)
    assert.ok(group.count > 0, group.taskGroup)
    assert.equal(group.subgroups.reduce((sum, sub) => sum + sub.count, 0), group.count, `${group.taskGroup} sub-groups add up`)
    assert.ok(group.rows.every((row) => row.taskGroup === group.taskGroup))
  }
})

test('the old group names are gone: every heading is a task group or a surface', () => {
  const sheet = keyboardSheet(input())
  for (const group of sheet.groups) assert.ok(TASK_GROUPS.includes(group.taskGroup))
  const surfaces = new Set(Object.values(SURFACE_KEYS))
  for (const surface of sheet.surfaces) assert.ok(surfaces.has(surface.surface), surface.surface)
  for (const old of ['Navigation', 'Talks panel', 'Sidebar', 'Editor', 'Slides', 'Audience']) {
    assert.ok(!sheet.groups.some((group) => group.taskGroup === old), old)
  }
})

test('every editor command is in exactly one group; surface keys are in none (decision 13)', () => {
  const sheet = keyboardSheet(input())
  const grouped = sheet.groups.flatMap((group) => group.rows.map((row) => row.key))
  assert.equal(new Set(grouped).size, grouped.length, 'a command appears in two groups')
  const expected = COMMAND_REGISTRY.filter((command) => command.taskGroup && command.scope !== 'presenter').map((command) => command.id)
  assert.deepEqual([...grouped].sort(), [...expected].sort())
  const surfaceKeys = sheet.surfaces.flatMap((surface) => surface.rows.map((row) => row.key))
  assert.ok(surfaceKeys.length > 0)
  assert.ok(surfaceKeys.every((key) => !grouped.includes(key)))
  assert.equal(surfaceKeys.length, COMMAND_REGISTRY.filter((command) => command.surface && !command.taskGroup && command.scope !== 'presenter').length)
})

test('the sheet is generated: a command added to the registry adds a row to its group', () => {
  const before = keyboardSheet(input())
  const extra = { ...COMMAND_REGISTRY.find((command) => command.id === 'layout'), id: 'brand-new-command', label: 'A brand new command', shortcutId: undefined }
  const after = keyboardSheet(input({ registry: [...COMMAND_REGISTRY, extra] }))
  const group = (sheet) => sheet.groups.find((candidate) => candidate.taskGroup === extra.taskGroup)
  assert.equal(group(after).count, group(before).count + 1)
  assert.ok(group(after).rows.some((row) => row.key === 'brand-new-command' && row.chord === 'no key'))
})

test('a rebound chord is marked rebound with what it was', () => {
  const rebound = (id) => (id === 'app.layout-picker' ? '⌘⌥L' : defaults(id))
  const sheet = keyboardSheet(input({ chordOf: rebound }))
  const here = sheet.here.rows.find((row) => row.key === 'layout')
  assert.equal(here.chord, '⌘⌥L')
  assert.equal(here.was, '⌘L')
  const grouped = sheet.groups.flatMap((group) => group.rows).find((row) => row.key === 'layout')
  assert.equal(grouped.was, '⌘L')
  const untouched = sheet.here.rows.find((row) => row.key === 'promote-heading')
  assert.equal(untouched.was, null)
})

test('a command with no chord shows "no key" and a Run action where the shared route can run it', () => {
  const sheet = keyboardSheet(input())
  const rows = sheet.groups.flatMap((group) => group.rows)
  const noKey = rows.filter((row) => row.chord === 'no key')
  assert.ok(noKey.length > 0)
  for (const row of noKey) assert.equal(row.run, runnable.has(row.commandId), row.key)
  assert.ok(noKey.some((row) => row.run), 'some no-key command can be run')
  // A command with a chord shows no Run action.
  assert.ok(rows.filter((row) => row.chord !== 'no key').every((row) => !row.run))
  // A carried row (Explain rendering) with no chord can be run from the sheet; a talk row's carried rows cannot.
  assert.equal(sheet.here.rows.find((row) => row.key === 'explain-rendering').run, true)
  assert.equal(keyboardSheet(input({ place: 'talk', context: { row: 'talk' } })).here.rows.find((row) => row.key === 'talk.reveal').run, false)
})

test('a chord the person unbound reads "no key" and was its default', () => {
  const unbound = (id) => (id === 'app.layout-picker' ? '' : defaults(id))
  const row = keyboardSheet(input({ chordOf: unbound })).here.rows.find((candidate) => candidate.key === 'layout')
  assert.equal(row.chord, 'no key')
  assert.equal(row.was, '⌘L')
  assert.equal(row.run, true)
})

test('the filter searches every command by label and keywords, and by group', () => {
  const sheet = keyboardSheet(input())
  assert.deepEqual(searchSheet(sheet, ''), [])
  assert.ok(searchSheet(sheet, 'bold').some((row) => row.key === 'format-bold'))
  assert.ok(searchSheet(sheet, 'strong').some((row) => row.key === 'format-bold'), 'a keyword matches')
  assert.ok(searchSheet(sheet, 'layout doctor').some((row) => row.key === 'layout-doctor'))
  assert.ok(searchSheet(sheet, 'check and repair').every((row) => row.taskGroup === 'Check and repair'))
  assert.deepEqual(searchSheet(sheet, 'zzzz nothing'), [])
  // A command outside the current place is found too.
  const text = keyboardSheet(input({ place: 'slide-text' }))
  assert.ok(searchSheet(text, 'promote heading').some((row) => row.key === 'promote-heading'))
})

// ── render ─────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(root, '.test-keyboard-sheet-'))
try {
  const bundle = join(dir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import KeyboardHelp from './src/renderer/src/components/KeyboardHelp.tsx'",
        "export const sheet = (props) => renderToStaticMarkup(React.createElement(KeyboardHelp, { isOpen: true, onClose: () => {}, ...props }))"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-keyboard-sheet-entry.tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"test"' }
  })
  const { sheet } = await import(pathToFileURL(bundle).href)
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null } }

  test('the sheet opens on Here with its count, then the ten task groups with counts, and a filter', () => {
    const html = sheet({ place: 'slide-heading' })
    const data = keyboardSheet(input())
    assert.match(html, /aria-label="Keyboard shortcuts"/)
    assert.match(html, /placeholder="Filter all commands"/)
    assert.match(html, /data-sheet-pane="here"/)
    assert.ok(text(html).includes('Here: on a slide heading'))
    assert.match(html, new RegExp(`data-sheet-count="here">${data.here.count}<`))
    for (const group of data.groups) assert.match(html, new RegExp(`data-sheet-count="${group.taskGroup}">${group.count}<`), group.taskGroup)
    assert.ok(html.indexOf('data-sheet-section="here"') < html.indexOf('data-sheet-section="Write the outline"'), 'Here comes first')
    assert.equal((html.match(/data-sheet-row="/g) ?? []).length, data.here.count, 'the pane lists exactly the Here rows')
  })

  test('with no talk open the sheet has no Here item and opens on the first task group', () => {
    const html = sheet({ place: null })
    assert.ok(!html.includes('data-sheet-section="here"'))
    assert.match(html, /data-sheet-pane="section"/)
    assert.ok(text(html).includes('Write the outline'))
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

for (const [pass, name] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
const failed = results.filter(([pass]) => !pass).length
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
