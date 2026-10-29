// The app's commands as one @app-patterns/commands registry: the menu bar, Settings › Shortcuts, the
// settings file's shortcut overrides and the settings CLI read it. It is DERIVED from the app's own
// command registry (command-registry.ts, the one list every command is typed in), so nothing is
// declared twice.
//
// Research uses the shared registry's named scope for its panel/picker keys. Other contextual keys
// that work only inside one window (presenter, Pathways, Notes and script, Importer, Studio) or
// where the focus is (the Talks panel's rows, the slide picker, the outline's Enter and Tab keys).
// Those stay with the surface that handles them and are listed by the app's own ⌘/ sheet; here
// they have no chord, cannot be rebound and are not in the menu bar (`noMenu`, with the window or
// focus they need as the reason). See WINDOW_SCOPES, focusKeyReason().
//
// Pure; erasable TypeScript only (node tests import it as it is).
import { defineRegistry, type CommandDef, type MenuDecl } from '@app-patterns/commands'
import { COMMAND_REGISTRY, PALETTE_EXCLUSIONS, type CommandDefinition } from './command-registry.ts'
import { shortcutById } from './shortcut-registry.ts'
import { TASK_GROUPS, type TaskGroup } from './task-groups.ts'
import { chordFromKeyString } from './bridle-chords.ts'

export const APP_ID = 'talkweaver'
export const APP_NAME = 'TalkWeaver'

/** Commands that run in a window of their own, and that window's name. */
const WINDOW_SCOPES: Readonly<Record<string, string>> = {
  presenter: 'the presenter window',
  pathway: 'the Pathways window',
  talktext: 'the Notes and script window',
  importer: 'the Importer window',
  studio: 'the Studio window'
}

/**
 * The app's commands whose key the person may change: the ones the editor keymap and the surfaces
 * read overrides for (src/renderer/src/keymap/registry.ts, EDITOR_COMMANDS), by shortcut id, with
 * the local id the renderer's keymap uses. scripts/test-shared-settings.mjs checks it against that file.
 */
export const REBINDABLE: Readonly<Record<string, string>> = {
  'app.check-for-updates': 'check-for-updates',
  'app.whats-new': 'whats-new',
  'app.research-panel': 'research-panel',
  'app.research-find': 'research-find',
  'app.set-aside': 'set-aside-slides',
  'app.grid-search': 'search-slides-grid',
  'app.search-next': 'search-next',
  'app.search-previous': 'search-previous',
  'research.insert': 'research-insert',
  'research.make-slide': 'research-make-slide',
  'research.open': 'research-open',
  'research.previous': 'research-previous',
  'research.next': 'research-next',
  'research.scope': 'research-scope',
  'research.close': 'research-close',
  'research.copy-reference': 'research-copy-reference',
  'research.reveal': 'research-reveal',
  'research.source': 'research-source',
  'research.used-in': 'research-used-in',
  'research.scope-talk': 'research-scope-talk',
  'research.scope-research': 'research-scope-research',
  'research.scope-everything': 'research-scope-everything',
  'research.rename': 'research-rename',
  'research.change-kind': 'research-change-kind',
  'research.delete': 'research-delete',
  'research.move': 'research-move',
  'research.copy': 'research-copy',
  'research.insert-here': 'research-insert-here',
  'research.retry': 'research-retry',

  'app.sidebar-talks': 'sidebar.talks',
  'app.sidebar-outline': 'sidebar.outline',
  'app.sidebar-toggle': 'sidebar.toggle',
  'editor.new-slide': 'new-slide',
  'editor.bulleted-list': 'bulleted-list',
  'editor.numbered-list': 'numbered-list',
  'editor.move-up': 'move-up',
  'editor.move-down': 'move-down',
  'editor.promote': 'promote',
  'editor.demote': 'demote',
  'editor.promote-subtree': 'promote-subtree',
  'editor.demote-subtree': 'demote-subtree',
  'editor.heading-same': 'heading-same',
  'editor.heading-sub': 'heading-sub',
  'editor.jump-prev': 'jump-prev',
  'editor.jump-next': 'jump-next',
  'editor.delete-slide': 'delete-slide',
  'editor.bold': 'bold',
  'editor.italic': 'italic',
  'editor.inline-code': 'inline-code',
  'editor.highlight': 'highlight',
  'editor.strikethrough': 'strikethrough',
  'editor.underline': 'underline',
  'editor.link': 'link',
  'editor.object-expand': 'object-expand',
  'editor.object-discard': 'object-discard',
  'editor.delete-comment': 'delete-comment',
  'editor.insert-notes': 'insert-notes',
  'app.find-talk': 'find-talk',
  'slide-picker.add-beside': 'add-beside',
  'slide-picker.talk-beside': 'talk-beside',
  'slide-picker.close-beside': 'close-beside',
  'slide-picker.select-whole-section': 'select-whole-section'
}

/**
 * Chords that moved because they are kept for the same job in every app (reserved estate chords).
 * Shortcut id → its new default, or '' for none. The shortcut registry carries the new default too.
 */
export const MOVED_FOR_RESERVED: Readonly<Record<string, { was: string; reason: string }>> = {
  'app.slide-focus': { was: '⌘⇧F', reason: '⌘⇧F is kept for “Search everything” in every app' }
}

/** Commands the app ID differs from the frame's for: the ⌘/ sheet is the frame's `cheat`. */
const BRIDLE_ID: Readonly<Record<string, string>> = { help: 'cheat' }
const APP_ID_OF: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(BRIDLE_ID).map(([a, b]) => [b, a]))

/** The registry id of an app command id. */
export function bridleIdOf(appCommandId: string): string {
  return BRIDLE_ID[appCommandId] ?? appCommandId
}
/** The registry id of Check for Updates, through the same mapping as the registry (the shortcut id 'app.check-for-updates' is not a registry id). */
export const UPDATE_CHECK_ID = bridleIdOf('check-for-updates')
/** The app command id of a registry id (the menu sends registry ids). */
export function appCommandIdOf(bridleId: string): string {
  return APP_ID_OF[bridleId] ?? bridleId
}

/** The Tools window's own commands (0.41): scope 'tools' is shared with editor-window commands that open a tool, so the id says it. */
function isToolsWindowCommand(c: CommandDefinition): boolean {
  return c.id.startsWith('tools-')
}

/** Holders of an estate or system chord that ARE that chord's job here: fixed, so nothing else can take the chord. */
const FIXED_IDS = new Set(['settings', 'help', 'app.command-palette', 'app.context-menu', 'toggle-inspector', 'app.find', 'undo', 'redo'])

/** Why a command's key is not a menu-bar command, or null when it is. */
function focusKeyReason(c: CommandDefinition): string | null {
  const window = WINDOW_SCOPES[c.scope]
  if (window) return `runs in ${window}`
  if (isToolsWindowCommand(c)) return 'runs in the Tools window'
  if (c.scope === 'research') return 'works inside the research panel or picker'
  if (c.scope === 'browser') return 'acts on the focused row of the Talks panel'
  if (c.scope === 'slide-picker') return 'works inside the slide picker'
  const written = PALETTE_EXCLUSIONS[c.id]
  if (written) return written
  return null
}

function defaultChordOf(c: CommandDefinition): string {
  if (!c.shortcutId) return ''
  const s = shortcutById(c.shortcutId)
  if (s.unbound) return ''
  return chordFromKeyString(s.codes[0] ?? '')
}

export type CommandGroup = TaskGroup

export type TwCommandDef = CommandDef<CommandGroup, undefined>

/** Every command of the app as an App Patterns CommandDef. Keys inside one window or one focus get no chord here (see the header). */
export function bridleDefs(commands: readonly CommandDefinition[] = COMMAND_REGISTRY): TwCommandDef[] {
  const defs: TwCommandDef[] = []
  for (const c of commands) {
    if (c.surface || !c.taskGroup) continue // keys inside a surface are not commands (lock decision 13)
    const id = bridleIdOf(c.id)
    const reason = focusKeyReason(c)
    const rebindable = c.shortcutId !== undefined && Object.hasOwn(REBINDABLE, c.shortcutId)
    const chord = defaultChordOf(c)
    // Keys of another window, of the Talks panel's rows and the outline's Enter / Tab keys have no
    // chord here: they are bare keys or a second use of a chord, which one flat chord space cannot
    // hold. The slide picker's keys keep theirs only because they are rebindable and do not collide.
    const chordless = Boolean(WINDOW_SCOPES[c.scope]) || isToolsWindowCommand(c) || c.scope === 'browser' || (c.scope === 'slide-picker' && !rebindable) ||
      (c.id.startsWith('editor.') && Object.hasOwn(PALETTE_EXCLUSIONS, c.id))
    const key = chordless ? '' : chord
    const def: TwCommandDef = {
      id,
      group: c.taskGroup,
      label: c.label,
      key,
      icon: 'command',
      ...(c.scope === 'research' ? { scope: 'research' } : {}),
      ...(['research-panel', 'research-find'].includes(c.id) ? { group: 'See the talk' as CommandGroup } : {}),
      ...(reason ? { noMenu: true as const, noMenuReason: reason } : {}),
      ...(FIXED_IDS.has(c.id) || !rebindable ? { fixed: true as const } : {}),
      ...(FIXED_IDS.has(c.id) ? { typing: true as const } : {})
    }
    defs.push(def)
  }
  return defs
}

export const registry = defineRegistry<CommandGroup, undefined>(bridleDefs())

/** The menu bar's app menus, by task (the frame supplies the App, Edit, View, Window and Help frames). */
const MENU_PLAN: ReadonlyArray<MenuDecl<CommandGroup>> = [
  { label: 'File', groups: ['Manage talks', 'Share'] },
  { label: 'Edit', groups: ['Write the outline'] },
  { label: 'Slide', groups: ['Build a slide', 'Reuse slides'] },
  { label: 'Talk', groups: ['Shape the talk', 'Check and repair'] },
  { label: 'View', groups: ['See the talk'] },
  { label: 'Present', groups: ['Present'] },
  { label: 'Help', groups: ['Set up TalkWeaver'] }
]

export const MENUS: MenuDecl<CommandGroup>[] = MENU_PLAN
  .map((m) => ({ label: m.label, groups: m.groups.filter((g) => registry.groups.includes(g)) }))
  .filter((m) => m.groups.length > 0)

/** Every task group is in exactly one menu (a command added to a new group would otherwise be dropped). */
export const UNMENUED_GROUPS: readonly string[] = TASK_GROUPS.filter((g) => !MENU_PLAN.some((m) => m.groups.includes(g)))

/** The registry id → the local keymap id the renderer stores an override under, for rebindable commands. */
export function keymapIdOf(bridleId: string): string | null {
  const c = COMMAND_REGISTRY.find((x) => x.id === appCommandIdOf(bridleId))
  if (!c?.shortcutId) return null
  return REBINDABLE[c.shortcutId] ?? null
}

/** The local keymap id → the registry id (for moving the old overrides into the settings file). */
export function bridleIdOfKeymapId(keymapId: string): string | null {
  const shortcutId = Object.keys(REBINDABLE).find((s) => REBINDABLE[s] === keymapId)
  if (!shortcutId) return null
  const c = COMMAND_REGISTRY.find((x) => x.shortcutId === shortcutId && !x.surface)
  return c ? bridleIdOf(c.id) : null
}
