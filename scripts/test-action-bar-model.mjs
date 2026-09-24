// =============================================================================
// Action bar model (ADR-0025): the default set, and resolving a stored list against the registry.
//
// The bar reads ONE ordered list of command ids with '|' separator tokens; the section structure is
// derived from that array at resolution time. These gates pin the rules the bar can never break:
// the default resolves to its two sections in order, an unknown id is dropped from the render but
// kept in storage, a duplicate keeps its first place, separators collapse, an icon-less command
// wears the one neutral mark, and tooltip content is `label` or `label (chord)`.
// =============================================================================
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { SHORTCUT_REGISTRY } from '../src/shared/shortcut-registry.ts'
import { COMMAND_REGISTRY, paletteCommands } from '../src/shared/command-registry.ts'
import {
  ACTION_BAR_SEPARATOR,
  actionBarItemsFrom,
  isActionBarSeparator,
  parseActionBarItems,
  actionBarVisibleFrom
} from '../src/shared/action-bar-settings.ts'
import {
  ACTION_BAR_FALLBACK_ICON,
  DEFAULT_ACTION_BAR_ITEMS,
  resolveActionBarItems,
  tooltipFor
} from '../src/renderer/src/components/actionBar/model.ts'

// The runnable universe exactly as the workspace builds it: one row per command the palette lists,
// keyed by command id. Chords come from the live keymap in the app; here they are explicit inputs.
const runnable = new Map(
  paletteCommands().map((command) => [
    command.id,
    {
      label: command.label,
      ...(command.toolbar ? { icon: command.toolbar.icon } : {}),
      run: () => {}
    }
  ])
)

assert.equal(actionBarVisibleFrom(undefined), true, 'unset visibility shows the bar by default')
assert.equal(actionBarVisibleFrom(false), false, 'an explicit stored false keeps the bar hidden')

// -- The default resolves to the two sections in order ----------------------------------------
const defaultSections = resolveActionBarItems(DEFAULT_ACTION_BAR_ITEMS, runnable)
assert.equal(defaultSections.length, 2, 'the default resolves to two sections — discovery first, editing second')
assert.deepEqual(
  defaultSections[0].items.map((item) => item.commandId),
  [
    'layout', 'icon-picker', 'image', 'search',
    'insert-object-table', 'insert-object-chart', 'insert-object-diagram', 'insert-object-mindmap',
    'toggle-inspector', 'view-strip', 'present-presenter', 'handout', 'publish-handout',
    'app.command-palette'
  ],
  'section one carries the discovery commands in the drawn order'
)
assert.deepEqual(
  defaultSections[1].items.map((item) => item.commandId),
  ['undo', 'redo', 'new-slide', 'delete-slide', 'promote-heading', 'demote-heading', 'bulleted-list', 'numbered-list'],
  'section two carries all eight everyday editing commands'
)
assert.deepEqual(
  DEFAULT_ACTION_BAR_ITEMS.filter((item) => isActionBarSeparator(item)),
  [ACTION_BAR_SEPARATOR],
  'the default is ONE flat array with exactly one separator between the sections'
)

// Registry-level backing for the default: every id is a registered command, and one the palette
// can run (which is what the bar resolves against) — so no default button is drawn dead.
for (const id of DEFAULT_ACTION_BAR_ITEMS) {
  if (isActionBarSeparator(id)) continue
  assert(
    COMMAND_REGISTRY.some((command) => command.id === id),
    `${id}: a default action-bar id must be a registered command`
  )
  assert(runnable.has(id), `${id}: a default action-bar id must resolve to a runnable command`)
}

const seven = ['undo', 'redo', 'new-slide', 'promote-heading', 'demote-heading', 'bulleted-list', 'numbered-list']
for (const id of seven) {
  const command = COMMAND_REGISTRY.find((entry) => entry.id === id)
  assert(command?.palette.visible, `${id}: visible in the command palette`)
  assert(SHORTCUT_REGISTRY.some((entry) => entry.id === command.shortcutId), `${id}: represented in the shortcut sheet`)
}
assert(readFileSync(new URL('../src/renderer/src/components/KeyboardHelp.tsx', import.meta.url), 'utf8').includes("SHORTCUT_REGISTRY.filter((shortcut) => shortcut.scope !== 'presenter')"), 'the app shortcut sheet renders the registry rows')

// -- An unknown id is dropped from the render but kept in storage ------------------------------
const stored = ['layout', 'no-such-command', 'image']
assert.deepEqual(
  actionBarItemsFrom(stored, DEFAULT_ACTION_BAR_ITEMS),
  ['layout', 'no-such-command', 'image'],
  'storage keeps an id naming a command this build cannot run'
)
assert.deepEqual(
  resolveActionBarItems(stored, runnable).flatMap((section) => section.items.map((item) => item.commandId)),
  ['layout', 'image'],
  'an unrunnable id renders no button and leaves no gap'
)

// -- A duplicate keeps its first position ------------------------------------------------------
assert.deepEqual(
  resolveActionBarItems(['image', ACTION_BAR_SEPARATOR, 'layout', 'image'], runnable)
    .flatMap((section) => section.items.map((item) => item.commandId)),
  ['image', 'layout'],
  'one command is one button: a repeat is dropped and the first placement wins'
)

// -- Leading, doubled and trailing separators collapse -----------------------------------------
assert.deepEqual(
  resolveActionBarItems([ACTION_BAR_SEPARATOR, 'layout', ACTION_BAR_SEPARATOR, ACTION_BAR_SEPARATOR, 'image', ACTION_BAR_SEPARATOR], runnable)
    .map((section) => section.items.map((item) => item.commandId)),
  [['layout'], ['image']],
  'separators only bound sections: leading, doubled and trailing ones draw no empty section'
)

// -- A user-added command with no toolbar.icon gets the single neutral fallback ---------------------------
assert.equal(
  resolveActionBarItems(['fold-all'], runnable)[0].items[0].icon,
  ACTION_BAR_FALLBACK_ICON,
  'a user-added command with no icon wears the one neutral mark'
)
assert.equal(
  resolveActionBarItems(['layout'], runnable)[0].items[0].icon,
  'layout',
  'a command with its own toolbar icon keeps it'
)

const icons = defaultSections.flatMap((section) => section.items.map((item) => item.icon))
assert(!icons.includes(ACTION_BAR_FALLBACK_ICON), 'no default button uses the fallback icon')
assert.equal(new Set(icons).size, icons.length, 'every default button has a distinct icon')

// -- The tooltip is label-only without a chord, `label (chord)` with one -----------------------
assert.equal(tooltipFor('Layout…'), 'Layout…', 'no shortcut — the tooltip is the label alone')
assert.equal(tooltipFor('Layout…', '⌘L'), 'Layout… (⌘L)', 'the effective chord rides in brackets')
const withChord = resolveActionBarItems(
  ['layout'],
  new Map([['layout', { label: 'Layout…', keys: '⌘⇧L', run: () => {} }]])
)[0].items[0]
assert.equal(withChord.tooltip, 'Layout… (⌘⇧L)', 'the resolved tooltip uses the chord the caller resolved as effective')
assert.equal(withChord.keys, '⌘⇧L', 'the chord is kept alongside for the overflow menu')

// -- Stored-list parsing is tolerant of a missing, malformed or empty value --------------------
const DEFAULT_FALLBACK = ['layout', ACTION_BAR_SEPARATOR, 'delete-slide']
for (const broken of [undefined, null, '', '   ', 'not json', '"a bare string"', '[]', `["${ACTION_BAR_SEPARATOR}"]`, '["|","|"]', 42, {}]) {
  assert.deepEqual(
    parseActionBarItems(broken),
    null,
    `nothing usable in ${JSON.stringify(broken)} reads as "never set", not as an empty bar`
  )
  assert.deepEqual(actionBarItemsFrom(broken, DEFAULT_FALLBACK), DEFAULT_FALLBACK, `a broken stored value (${String(broken)}) falls back to the default`)
}
assert.deepEqual(
  parseActionBarItems(['layout', 42, '', 'delete-slide']),
  ['layout', 'delete-slide'],
  'a usable list keeps its string entries and drops foreign items rather than poisoning the list'
)
assert.deepEqual(
  parseActionBarItems(JSON.stringify(['layout', 'delete-slide'])),
  ['layout', 'delete-slide'],
  'a doubly-encoded (string) stored value still parses'
)
assert.deepEqual(
  actionBarItemsFrom('["layout","delete-slide"]', DEFAULT_FALLBACK),
  ['layout', 'delete-slide'],
  'the string form falls through to the real list'
)

console.log('action bar model: all assertions passed')
