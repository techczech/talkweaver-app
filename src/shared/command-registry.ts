import {
  SHORTCUT_REGISTRY,
  shortcutById,
  type ShortcutScope
} from './shortcut-registry.ts'
import {
  componentInsertEntries,
  objectInsertEntries,
  type LayoutDef
} from './layout-registry/entries.ts'
import { TASK_GROUPS, taskGroupFields, type TaskGroup, type TaskGroupFields } from './task-groups.ts'
import { PRESENTER_PALETTE } from './presenter-palette.ts'
import { placeDeclarationFor, type PlaceDeclaration } from './command-places.ts'

// Renderer command surfaces already bundle LAYOUTS through their layout-registry consumers. Keep
// this direct registry dependency until the C-D restructure can split it without duplicating truth.

export type CommandScope = ShortcutScope | 'deck' | 'tools'

export interface CommandMenuPlacement {
  path: string[]
  order: number
}

export type ToolbarMenuName = 'insert' | 'deck' | 'tools' | 'present'
export type ToolbarIconToken =
  | 'layout' | 'image' | 'slides' | 'sparkles' | 'board'
  | 'design' | 'pane-strip' | 'handout' | 'abstract' | 'refresh' | 'tools' | 'trash'
  | 'present' | 'settings' | 'keyboard' | 'window' | 'presenter' | 'audience'
  | 'table' | 'mindmap' | 'chart' | 'mermaid' | 'diagram' | 'svg'
  | 'code' | 'qr' | 'action' | 'embed' | 'countdown' | 'comment'
  | 'strip' | 'publish' | 'calendar' | 'command' | 'undo' | 'redo' | 'newslide' | 'promote' | 'demote' | 'bullets' | 'numbered' | 'bold' | 'italic' | 'link' | 'more'

export interface CommandToolbarPlacement {
  menu: ToolbarMenuName
  order: number
  icon: ToolbarIconToken
  actionBarOnly?: true
  /** Commands sharing a group render under one hairline separator before the group's first item. */
  group?: string
  /** The label the TOOLBAR MENU shows, when it differs from the palette label (e.g. "Table" vs
   *  the palette's "Insert table"). */
  menuLabel?: string
}

/** A command as declared; the task group and sub-group are added from the command map (task-groups.ts). */
export interface CommandInput {
  id: string
  label: string
  scope: CommandScope
  shortcutId?: string
  menu: CommandMenuPlacement | null
  toolbar?: CommandToolbarPlacement
  palette: {
    visible: boolean
    keywords: string[]
  }
  handlerId: string
}

/** Where Actions here and the status-bar chip offer the command (command-places.ts); null = undeclared. */
export interface CommandPlaceFields {
  places: PlaceDeclaration | null
}

export interface CommandDefinition extends CommandInput, TaskGroupFields, CommandPlaceFields {}

const OBJECT_PALETTE_COMMAND_IDS = [
  'insert-object-table',
  'insert-object-mindmap',
  'insert-object-chart',
  'insert-object-mermaid',
  'insert-object-diagram',
  'insert-object-svg'
] as const

type ObjectPaletteCommandId = (typeof OBJECT_PALETTE_COMMAND_IDS)[number]

interface ObjectPaletteCommand {
  id: ObjectPaletteCommandId
  shortcutId?: string
  label: string
  scope: 'app'
  menu: null
  toolbar: {
    menu: 'insert'
    order: number
    icon: ToolbarIconToken
    group: 'object'
    menuLabel: string
  }
  palette: {
    visible: true
    keywords: string[]
  }
  handlerId: ObjectPaletteCommandId
}

// The optional fields stay readable on every entry of the derived unions (an entry that omits `toolbar` or
// `shortcutId` still has the property, typed optional).
const command = <const T extends CommandInput>(definition: T): T & Partial<Pick<CommandDefinition, 'shortcutId' | 'toolbar'>> => definition
const objectPaletteCommandIds: ReadonlySet<string> = new Set(OBJECT_PALETTE_COMMAND_IDS)

function objectPaletteCommandId(id: string): ObjectPaletteCommandId | null {
  if (!objectPaletteCommandIds.has(id)) {
    console.error(
      `Registry-derived object command has no finite handler id: ${id}. Skipping the command.`
    )
    return null
  }
  return id as ObjectPaletteCommandId
}

// T27: every object insert also lives in the Insert TOOLBAR menu, after the four built-in items,
// under one separator, in the registry's existing order. No keyboard shortcut — the palette keeps
// them reachable by keyboard through ⌘⇧P. The menu shows the entry's MENU-LABEL variant ("Table",
// "Diagram…"); the palette keeps the verb labels ("Insert table").
const OBJECT_TOOLBAR_ICON: Record<ObjectPaletteCommandId, ToolbarIconToken> = {
  'insert-object-table': 'table',
  'insert-object-mindmap': 'mindmap',
  'insert-object-chart': 'chart',
  'insert-object-mermaid': 'mermaid',
  'insert-object-diagram': 'diagram',
  'insert-object-svg': 'svg'
}

export function objectPaletteCommands(
  layouts?: readonly LayoutDef[]
): ObjectPaletteCommand[] {
  const entries = layouts ? objectInsertEntries(layouts) : objectInsertEntries()
  return entries.flatMap((entry, index) => {
    const id = objectPaletteCommandId(entry.commandId)
    if (!id) return []
    return [command({
      id,
      label: entry.commandLabel,
      scope: 'app',
      menu: null,
      toolbar: {
        menu: 'insert',
        order: 100 + index * 10,
        icon: OBJECT_TOOLBAR_ICON[id],
        group: 'object',
        // The menu shows the entry's menu-label variant; where the entry's own command label
        // carries the ellipsis ("Insert diagram…"), the menu keeps it. Chart stays plain — that is
        // what INSERT_PRESENTATION/LAYOUT_FAMILY_INSERTS declare.
        menuLabel: entry.commandLabel.endsWith('…') ? `${entry.menuLabel}…` : entry.menuLabel
      },
      palette: { visible: true, keywords: entry.keywords },
      handlerId: id
    })]
  })
}

const OBJECT_PALETTE_COMMANDS = objectPaletteCommands()

// ADR-0032 §4: component-kind entries with no object declaration leave the layout picker and are
// inserted at the cursor from the Insert menu (own group, after the objects) and the action bar.
// Command ids are the finite list below because handlers are declared, not generated; a component
// added to the registry without a row here is logged and skipped, like an object without a handler.
const COMPONENT_INSERT_COMMAND_IDS = [
  'insert-component-code',
  'insert-component-qr',
  'insert-component-action',
  'insert-component-embed',
  'insert-component-auto-embed',
  'insert-component-countdown',
  'insert-component-notes'
] as const

type ComponentInsertCommandId = (typeof COMPONENT_INSERT_COMMAND_IDS)[number]

const COMPONENT_TOOLBAR_ICON: Record<string, ToolbarIconToken> = {
  code: 'code',
  qr: 'qr',
  action: 'action',
  embed: 'embed',
  'auto-embed': 'embed',
  countdown: 'countdown',
  notes: 'comment'
}

const componentInsertCommandIds: ReadonlySet<string> = new Set(COMPONENT_INSERT_COMMAND_IDS)

export function componentInsertCommands(layouts?: readonly LayoutDef[]) {
  const entries = layouts ? componentInsertEntries(layouts) : componentInsertEntries()
  return entries.flatMap((entry, index) => {
    if (!componentInsertCommandIds.has(entry.commandId)) {
      console.error(
        `Registry-derived component command has no finite handler id: ${entry.commandId}. Skipping the command.`
      )
      return []
    }
    return [command({
      id: entry.commandId as ComponentInsertCommandId,
      label: entry.commandLabel,
      scope: 'app' as const,
      menu: null,
      toolbar: {
        menu: 'insert' as const,
        order: 200 + index * 10,
        icon: COMPONENT_TOOLBAR_ICON[entry.name] ?? 'tools',
        group: 'component',
        menuLabel: entry.menuLabel
      },
      palette: { visible: true as const, keywords: entry.keywords },
      handlerId: entry.commandId as ComponentInsertCommandId
    })]
  })
}

const COMPONENT_INSERT_COMMANDS = componentInsertCommands()

// Quote form commands, one per choice of the quote layout's `quote-form` group (the registry's values are
// the source of the words). The handler writes the form through `set-quote-form` on the slide at the caret.
export const QUOTE_FORM_COMMAND_IDS = [
  'quote-form-auto',
  'quote-form-plain',
  'quote-form-tweet',
  'quote-form-video',
  'quote-form-book',
  'quote-form-paper',
  'quote-form-web'
] as const

/** Move slide to… and Move section to…: offered by Actions here on every place of a slide and on its card in the strip. */
export const MOVE_TO_COMMAND_IDS = ['move-slide-to', 'move-section-to'] as const

export type QuoteFormCommandId = (typeof QUOTE_FORM_COMMAND_IDS)[number]

// Each form has its own words besides the shared ones, so typing a form's name ranks that command first
// while the shared words ("quote form") still list all seven.
const QUOTE_FORM_OWN_KEYWORDS: Record<QuoteFormCommandId, string[]> = {
  'quote-form-auto': ['automatic', 'auto'],
  'quote-form-plain': ['plain'],
  'quote-form-tweet': ['tweet', 'x post'],
  'quote-form-video': ['video'],
  'quote-form-book': ['book'],
  'quote-form-paper': ['paper'],
  'quote-form-web': ['web', 'web page']
}

const QUOTE_FORM_COMMANDS = QUOTE_FORM_COMMAND_IDS.map((id) => command({
  id,
  label: `Quote form: ${id === 'quote-form-auto' ? 'Automatic' : id.slice('quote-form-'.length).replace(/^./, (letter) => letter.toUpperCase())}`,
  scope: 'editor' as const,
  menu: null,
  palette: { visible: true as const, keywords: ['quote', 'form', 'source', ...QUOTE_FORM_OWN_KEYWORDS[id]] },
  handlerId: id
}))

// Application commands are declared once here. The palette and native custom menus retain their
// existing order, but now render this data instead of maintaining parallel title/shortcut lists.
const PALETTE_COMMANDS = [
  // Research repeat actions are palette-only: their keys belong to the picker, never native menus.
  command({ id: 'research-panel', label: 'Research', scope: 'app', shortcutId: 'app.research-panel', menu: { path: ['View'], order: 180 }, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-panel' }),
  command({ id: 'research-find', label: 'Find in research…', scope: 'app', shortcutId: 'app.research-find', menu: { path: ['View'], order: 181 }, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-find' }),
  command({ id: 'research-rename', label: 'Rename research…', scope: 'research', shortcutId: 'research.rename', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-rename' }),
  command({ id: 'research-change-kind', label: 'Change research kind…', scope: 'research', shortcutId: 'research.change-kind', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-change-kind' }),
  command({ id: 'research-delete', label: 'Delete research…', scope: 'research', shortcutId: 'research.delete', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-delete' }),
  command({ id: 'research-move', label: 'Move research to another talk…', scope: 'research', shortcutId: 'research.move', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-move' }),
  command({ id: 'research-copy', label: 'Copy research to another talk…', scope: 'research', shortcutId: 'research.copy', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-copy' }),
  command({ id: 'research-insert-here', label: 'Insert research from another talk', scope: 'research', shortcutId: 'research.insert-here', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-insert-here' }),
  command({ id: 'research-insert', label: 'Insert research at cursor', scope: 'research', shortcutId: 'research.insert', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-insert' }),
  command({ id: 'research-make-slide', label: 'Make slide from research', scope: 'research', shortcutId: 'research.make-slide', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-make-slide' }),
  command({ id: 'research-open', label: 'Open research item', scope: 'research', shortcutId: 'research.open', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-open' }),
  command({ id: 'research-previous', label: 'Previous research item', scope: 'research', shortcutId: 'research.previous', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-previous' }),
  command({ id: 'research-next', label: 'Next research item', scope: 'research', shortcutId: 'research.next', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-next' }),
  command({ id: 'research-scope', label: 'Change research scope', scope: 'research', shortcutId: 'research.scope', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-scope' }),
  command({ id: 'research-close', label: 'Close research', scope: 'research', shortcutId: 'research.close', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-close' }),
  command({ id: 'research-copy-reference', label: 'Copy research reference', scope: 'research', shortcutId: 'research.copy-reference', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-copy-reference' }),
  command({ id: 'research-reveal', label: 'Reveal research item', scope: 'research', shortcutId: 'research.reveal', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-reveal' }),
  command({ id: 'research-source', label: 'Open research source', scope: 'research', shortcutId: 'research.source', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-source' }),
  command({ id: 'research-used-in', label: 'Jump to research use', scope: 'research', shortcutId: 'research.used-in', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-used-in' }),
  command({ id: 'research-scope-talk', label: 'Research scope: This talk', scope: 'research', shortcutId: 'research.scope-talk', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-scope-talk' }),
  command({ id: 'research-scope-research', label: 'Research scope: All research', scope: 'research', shortcutId: 'research.scope-research', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-scope-research' }),
  command({ id: 'research-scope-everything', label: 'Research scope: Everything', scope: 'research', shortcutId: 'research.scope-everything', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-scope-everything' }),
  command({ id: 'research-retry', label: 'Reload research', scope: 'research', shortcutId: 'research.retry', menu: null, palette: { visible: true, keywords: ['research', 'scout'] }, handlerId: 'research-retry' }),
  command({ id: 'refresh', label: 'Rebuild preview', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 50, icon: 'refresh' }, palette: { visible: true, keywords: ['refresh', 'preview', 'thumbnail', 'compile'] }, handlerId: 'refresh' }),
  command({ id: 'optimize-images', label: 'Optimise images to WebP (smaller, faster previews)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['optimise', 'images', 'webp', 'compress'] }, handlerId: 'optimize-images' }),
  command({ id: 'ocr-index', label: 'Index image text (OCR) for search', scope: 'tools', menu: null, palette: { visible: true, keywords: ['ocr', 'index', 'image', 'search'] }, handlerId: 'ocr-index' }),
  command({ id: 'check-embeds', label: 'Check embeds (will videos & sites load when presenting?)', scope: 'tools', menu: null, palette: { visible: true, keywords: ['embed', 'video', 'site', 'check'] }, handlerId: 'check-embeds' }),
  command({ id: 'layout-doctor', label: 'Layout Doctor (trigger-line health)…', scope: 'tools', menu: null, palette: { visible: true, keywords: ['doctor', 'trigger', 'layout', 'health', 'unresolved'] }, handlerId: 'layout-doctor' }),
  // Knowledge step two: the research folder beside a talk. Capture is a content command (verb research.capture);
  // Reveal is chrome (ui-navigation): both in src/main/agent-verbs.ts.
  command({ id: 'research-capture', label: 'Capture to research…', scope: 'app', menu: null, palette: { visible: true, keywords: ['capture', 'research', 'evidence', 'file', 'save', 'scout', 'table', 'snippet'] }, handlerId: 'research-capture' }),
  command({ id: 'research-reveal-folder', label: 'Reveal research folder', scope: 'app', menu: null, palette: { visible: true, keywords: ['reveal', 'research', 'folder', 'finder', 'show'] }, handlerId: 'research-reveal-folder' }),
  // Slide Scratchpad (docs/design/2026-10-27-slide-scratchpad): candidates for this talk. Actions act on the
  // panel's current selection; only the two Insert commands change the outline.
  command({ id: 'scratchpad-panel', label: 'Slide Scratchpad', scope: 'app', menu: { path: ['View'], order: 182 }, palette: { visible: true, keywords: ['scratchpad', 'slide', 'candidates', 'collect', 'agent', 'visuals', 'triage'] }, handlerId: 'scratchpad-panel' }),
  command({ id: 'scratchpad-dock', label: 'Dock Slide Scratchpad to the right', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'dock', 'right', 'panel'] }, handlerId: 'scratchpad-dock' }),
  command({ id: 'scratchpad-float', label: 'Float Slide Scratchpad over the workspace', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'float', 'panel', 'window'] }, handlerId: 'scratchpad-float' }),
  command({ id: 'scratchpad-collapse', label: 'Collapse Slide Scratchpad to a pill', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'collapse', 'pill', 'hide', 'minimise'] }, handlerId: 'scratchpad-collapse' }),
  command({ id: 'scratchpad-add-slides', label: 'Add selected slides to Slide Scratchpad', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'add', 'slides', 'picker', 'browser', 'selected', 'candidates'] }, handlerId: 'scratchpad-add-slides' }),
  command({ id: 'scratchpad-keep', label: 'Keep selected Slide Scratchpad items for the library', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'keep', 'library', 'save'] }, handlerId: 'scratchpad-keep' }),
  command({ id: 'scratchpad-reject', label: 'Reject selected Slide Scratchpad items', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'reject', 'discard', 'no'] }, handlerId: 'scratchpad-reject' }),
  command({ id: 'scratchpad-move-back', label: 'Move selected Slide Scratchpad items back', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'move', 'back', 'restore', 'kept', 'rejected'] }, handlerId: 'scratchpad-move-back' }),
  command({ id: 'scratchpad-move-to-group', label: 'Move Slide Scratchpad items to a group…', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'group', 'move', 'sort'] }, handlerId: 'scratchpad-move-to-group' }),
  command({ id: 'scratchpad-new-group', label: 'New Slide Scratchpad group…', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'group', 'new', 'create'] }, handlerId: 'scratchpad-new-group' }),
  command({ id: 'scratchpad-remove-missing', label: 'Remove missing files from Slide Scratchpad', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'missing', 'file', 'remove', 'clean'] }, handlerId: 'scratchpad-remove-missing' }),
  // Ticket 2: the only Slide Scratchpad actions that change the outline (the two Insert commands), and comparing.
  command({ id: 'scratchpad-insert-slide', label: 'Insert whole slide from Slide Scratchpad', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'insert', 'slide', 'whole', 'add', 'reuse'] }, handlerId: 'scratchpad-insert-slide' }),
  command({ id: 'scratchpad-insert-visual', label: 'Insert visual only from Slide Scratchpad', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'insert', 'visual', 'picture', 'svg', 'html', 'page', 'image'] }, handlerId: 'scratchpad-insert-visual' }),
  command({ id: 'scratchpad-compare', label: 'Compare Slide Scratchpad items side by side', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'compare', 'side by side', 'columns'] }, handlerId: 'scratchpad-compare' }),
  command({ id: 'scratchpad-change-place', label: 'Change where Slide Scratchpad inserts…', scope: 'app', menu: null, palette: { visible: true, keywords: ['scratchpad', 'place', 'insert', 'after', 'slide', 'position', 'where'] }, handlerId: 'scratchpad-change-place' }),
  command({ id: 'where-used', label: 'Slide: where used & versions', scope: 'app', shortcutId: 'app.where-used', menu: null, palette: { visible: true, keywords: ['slide', 'usage', 'versions'] }, handlerId: 'where-used' }),
  command({ id: 'focus-slide', label: 'Focus on this slide (scoped editing + live preview)', scope: 'app', shortcutId: 'app.slide-focus', menu: null, palette: { visible: true, keywords: ['focus', 'slide', 'preview'] }, handlerId: 'focus-slide' }),
  command({ id: 'toggle-inspector', label: 'Inspector mode', scope: 'app', shortcutId: 'app.toggle-inspector', menu: { path: ['Deck'], order: 10 }, toolbar: { menu: 'deck', order: 20, icon: 'pane-strip' }, palette: { visible: true, keywords: ['inspector', 'slide strip', 'pane'] }, handlerId: 'toggle-inspector' }),
  command({ id: 'studio', label: 'TalkWeaver Studio…', scope: 'tools', menu: null, toolbar: { menu: 'tools', order: 10, icon: 'present' }, palette: { visible: true, keywords: ['studio', 'recordings', 'play'] }, handlerId: 'studio' }),
  command({ id: 'history', label: 'TalkWeaver History…', scope: 'tools', menu: null, toolbar: { menu: 'tools', order: 20, icon: 'slides' }, palette: { visible: true, keywords: ['history', 'ledger', 'delivered'] }, handlerId: 'history' }),
  command({ id: 'importer', label: 'TalkWeaver Importer…', scope: 'tools', menu: null, toolbar: { menu: 'tools', order: 30, icon: 'slides' }, palette: { visible: true, keywords: ['import', 'powerpoint', 'pptx', 'slides'] }, handlerId: 'importer' }),
  command({ id: 'plan-run', label: 'Plan a run…', scope: 'deck', menu: null, toolbar: { menu: 'present', order: 50, icon: 'calendar', group: 'plan' }, palette: { visible: true, keywords: ['plan', 'run', 'event', 'audience', 'delivery'] }, handlerId: 'plan-run' }),
  // Work files ticket 30: the strips under the Metadata table (work-files ticket 08) have a command each. They
  // press the strip's own Attach button, so the same menu, the same write and the same refusals apply. No default key:
  // they need the Metadata table on show and are used once per talk.
  command({ id: 'attach-prework', label: 'Attach a pre-work file…', scope: 'deck', menu: null, palette: { visible: true, keywords: ['attach', 'pre-work', 'prework', 'work file', 'before the session', 'participants'] }, handlerId: 'attach-prework' }),
  command({ id: 'attach-postwork', label: 'Attach a post-work file…', scope: 'deck', menu: null, palette: { visible: true, keywords: ['attach', 'post-work', 'postwork', 'work file', 'after the session', 'follow-up'] }, handlerId: 'attach-postwork' }),
  command({ id: 'pathways', label: 'Pathways…', scope: 'deck', shortcutId: 'app.pathways', menu: { path: ['Deck'], order: 20 }, toolbar: { menu: 'deck', order: 25, icon: 'slides' }, palette: { visible: true, keywords: ['pathway', 'variant', 'custom show', 'slides'] }, handlerId: 'pathways' }),
  command({ id: 'new-window', label: 'New window (work on another presentation)', scope: 'app', shortcutId: 'app.new-window', menu: null, palette: { visible: true, keywords: ['new', 'window', 'presentation'] }, handlerId: 'new-window' }),
  command({ id: 'open-in-new-window', label: 'Open selected talk or folder in a new window', scope: 'app', menu: null, palette: { visible: true, keywords: ['open', 'new', 'window', 'talk', 'folder', 'file list'] }, handlerId: 'open-in-new-window' }),
  command({ id: 'new-talk', label: 'New presentation…', scope: 'app', menu: null, palette: { visible: true, keywords: ['new', 'talk', 'presentation'] }, handlerId: 'new-talk' }),
  command({ id: 'new-folder', label: 'New folder…', scope: 'app', menu: null, palette: { visible: true, keywords: ['new', 'folder'] }, handlerId: 'new-folder' }),
  command({ id: 'refresh-talks', label: 'Refresh talk list (re-scan vault)', scope: 'app', menu: null, palette: { visible: true, keywords: ['refresh', 'talks', 'vault', 'scan'] }, handlerId: 'refresh-talks' }),
  // The id stays (old palette history, keymaps); the command is Add vault (ticket 07): it never
  // replaces the vault list's first vault.
  command({ id: 'change-vault', label: 'Add vault…', scope: 'app', menu: null, palette: { visible: true, keywords: ['add', 'vault', 'folder', 'change'] }, handlerId: 'change-vault' }),
  command({ id: 'search-talks', label: 'Search presentations…', scope: 'app', shortcutId: 'app.sidebar-talks', menu: null, palette: { visible: true, keywords: ['search', 'talks', 'presentations', 'file list', 'find'] }, handlerId: 'search-talks' }),
  // Talk search 08: the slide picker's talk-search actions. Each runs against the open picker (the
  // palette opens above it); with the picker closed, Find a talk opens it and the others say why
  // they have nothing to act on.
  command({ id: 'find-talk', label: 'Find a talk (slide picker)', scope: 'app', shortcutId: 'app.find-talk', menu: null, palette: { visible: true, keywords: ['find', 'talk', 'picker', 'search', 'slides'] }, handlerId: 'find-talk' }),
  command({ id: 'add-talk-beside', label: 'Add the highlighted talk beside (Find a talk)', scope: 'slide-picker', shortcutId: 'slide-picker.add-beside', menu: null, palette: { visible: true, keywords: ['add', 'beside', 'column', 'talk', 'find', 'picker'] }, handlerId: 'add-talk-beside' }),
  command({ id: 'talk-beside', label: 'Show the focused result’s talk beside the results', scope: 'slide-picker', shortcutId: 'slide-picker.talk-beside', menu: null, palette: { visible: true, keywords: ['talk', 'beside', 'context', 'result', 'open', 'picker'] }, handlerId: 'talk-beside' }),
  command({ id: 'close-talk-beside', label: 'Close the talk beside the results', scope: 'slide-picker', shortcutId: 'slide-picker.close-beside', menu: null, palette: { visible: true, keywords: ['close', 'talk', 'beside', 'picker'] }, handlerId: 'close-talk-beside' }),
  command({ id: 'select-whole-section', label: 'Select the focused slide’s whole section', scope: 'slide-picker', shortcutId: 'slide-picker.select-whole-section', menu: null, palette: { visible: true, keywords: ['select', 'section', 'whole', 'heading', 'slides', 'picker'] }, handlerId: 'select-whole-section' }),
  command({ id: 'present-window', label: 'Presentation window', scope: 'deck', menu: null, toolbar: { menu: 'present', order: 10, icon: 'window' }, palette: { visible: true, keywords: ['present', 'window'] }, handlerId: 'present-window' }),
  command({ id: 'present-presenter', label: 'Presenter view', scope: 'deck', shortcutId: 'app.present', menu: null, toolbar: { menu: 'present', order: 20, icon: 'presenter' }, palette: { visible: true, keywords: ['present', 'presenter', 'view'] }, handlerId: 'present-presenter' }),
  command({ id: 'present-from-here', label: 'Presenter from current slide', scope: 'deck', shortcutId: 'app.present-current', menu: null, toolbar: { menu: 'present', order: 30, icon: 'presenter' }, palette: { visible: true, keywords: ['present', 'current', 'slide', 'here'] }, handlerId: 'present-from-here' }),
  command({ id: 'present-audience', label: 'Audience view', scope: 'deck', menu: null, toolbar: { menu: 'present', order: 40, icon: 'audience' }, palette: { visible: true, keywords: ['present', 'audience'] }, handlerId: 'present-audience' }),
  command({ id: 'handout', label: 'Share: handout (reveal in Finder)', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 80, icon: 'handout', actionBarOnly: true }, palette: { visible: true, keywords: ['share', 'handout', 'finder', 'export'] }, handlerId: 'handout' }),
  command({ id: 'build', label: 'Share: HTML presentation (reveal in Finder)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['share', 'html', 'presentation', 'build'] }, handlerId: 'build' }),
  command({ id: 'publish-handout', label: 'Share: publish to Cloudflare Pages…', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 90, icon: 'publish', actionBarOnly: true }, palette: { visible: true, keywords: ['share', 'publish', 'cloudflare', 'handout'] }, handlerId: 'publish-handout' }),
  command({ id: 'share-for-comments', label: 'Share: for comments…', scope: 'deck', menu: null, palette: { visible: true, keywords: ['share', 'comments', 'feedback', 'colleague', 'review', 'link'] }, handlerId: 'share-for-comments' }),
  command({ id: 'copy-venue-screen-link', label: 'Copy venue-screen link', scope: 'deck', menu: null, palette: { visible: true, keywords: ['venue', 'screen', 'projector', 'copy', 'link'] }, handlerId: 'copy-venue-screen-link' }),
  command({ id: 'layout', label: 'Layout…', scope: 'app', shortcutId: 'app.layout-picker', menu: null, toolbar: { menu: 'insert', order: 10, icon: 'layout' }, palette: { visible: true, keywords: ['insert', 'layout'] }, handlerId: 'layout' }),
  // Quote forms (ADR-0038): choose how the quote on the current slide is drawn, from the palette.
  // One command per choice, so each is reachable by name ("Quote form: Tweet") and, while the caret is on a quote slide, in Actions here (command-places.ts, actions-here.ts).
  ...QUOTE_FORM_COMMANDS,
  command({ id: 'image', label: 'Image…', scope: 'app', shortcutId: 'app.image-search', menu: null, toolbar: { menu: 'insert', order: 20, icon: 'image' }, palette: { visible: true, keywords: ['insert', 'image', 'screenshot', 'powerpoint', 'archive', 'slidewell'] }, handlerId: 'image' }),
  command({ id: 'search', label: 'Slides from other talks…', scope: 'app', shortcutId: 'app.slide-search', menu: null, toolbar: { menu: 'insert', order: 30, icon: 'slides' }, palette: { visible: true, keywords: ['insert', 'slides', 'search', 'talks'] }, handlerId: 'search' }),
  // ADR-0032 (round-3 A1): Insert › Board slide writes the starter board after the current slide.
  command({ id: 'insert-board-slide', label: 'Board slide', scope: 'editor', menu: null, toolbar: { menu: 'insert', order: 35, icon: 'board' }, palette: { visible: true, keywords: ['insert', 'board', 'feedback', 'cards', 'columns', 'poll', 'keep', 'change', 'try'] }, handlerId: 'insert-board-slide' }),
  command({ id: 'icon-picker', label: 'Insert icon…', scope: 'app', shortcutId: 'app.icon-picker', menu: null, toolbar: { menu: 'insert', order: 40, icon: 'sparkles', menuLabel: 'Icon…' }, palette: { visible: true, keywords: ['insert', 'icon', 'bullet', 'title', 'paragraph', 'list item', 'picture'] }, handlerId: 'icon-picker' }),
  ...OBJECT_PALETTE_COMMANDS,
  ...COMPONENT_INSERT_COMMANDS,
  // Insert › HTML page…: a native file picker for an HTML file, copied into the talk's assets folder when
  // it is outside the talk, then an `[Embed: assets/…]` line at the caret (src/main/html-page-import.ts).
  // Listed with the components, right after Embed, whose template line it fills in.
  command({ id: 'insert-html-page', label: 'Insert HTML page…', scope: 'app', menu: null, toolbar: { menu: 'insert', order: 235, icon: 'embed', group: 'component', menuLabel: 'HTML page…' }, palette: { visible: true, keywords: ['insert', 'html', 'page', 'file', 'embed', 'simulation', 'interactive', 'widget', 'import', 'picker'] }, handlerId: 'insert-html-page' }),
  // Capture embed… (lib/captureEmbed.ts, src/main/live-page-capture-window.ts): a window for the inspected slide's web page; keyless by design (owner 2026-10-27: no guessed shortcut).
  command({ id: 'capture-embed', label: 'Capture embed…', scope: 'app', menu: null, palette: { visible: true, keywords: ['capture', 'embed', 'web', 'page', 'live', 'screenshot', 'saved', 'view', 'entire', 'before', 'presenting'] }, handlerId: 'capture-embed' }),
  command({ id: 'format-bold', label: 'Bold', scope: 'editor', shortcutId: 'editor.bold', menu: null, toolbar: { menu: 'deck', order: 170, icon: 'bold', actionBarOnly: true }, palette: { visible: true, keywords: ['format', 'bold', 'strong', 'markdown'] }, handlerId: 'format-bold' }),
  command({ id: 'format-italic', label: 'Italic', scope: 'editor', shortcutId: 'editor.italic', menu: null, toolbar: { menu: 'deck', order: 180, icon: 'italic', actionBarOnly: true }, palette: { visible: true, keywords: ['format', 'italic', 'emphasis', 'markdown'] }, handlerId: 'format-italic' }),
  command({ id: 'format-inline-code', label: 'Inline code', scope: 'editor', shortcutId: 'editor.inline-code', menu: null, palette: { visible: true, keywords: ['format', 'inline', 'code', 'backtick', 'markdown'] }, handlerId: 'format-inline-code' }),
  command({ id: 'format-highlight', label: 'Highlight', scope: 'editor', shortcutId: 'editor.highlight', menu: null, palette: { visible: true, keywords: ['format', 'highlight', 'marker', 'yellow', 'markdown'] }, handlerId: 'format-highlight' }),
  command({ id: 'format-strikethrough', label: 'Strikethrough', scope: 'editor', shortcutId: 'editor.strikethrough', menu: null, palette: { visible: true, keywords: ['format', 'strikethrough', 'strike', 'cross out', 'delete', 'markdown'] }, handlerId: 'format-strikethrough' }),
  command({ id: 'format-underline', label: 'Underline', scope: 'editor', shortcutId: 'editor.underline', menu: null, palette: { visible: true, keywords: ['format', 'underline', 'emphasis', 'markdown'] }, handlerId: 'format-underline' }),
  command({ id: 'format-link', label: 'Insert link (clipboard-aware)', scope: 'editor', shortcutId: 'editor.link', menu: null, toolbar: { menu: 'deck', order: 190, icon: 'link', actionBarOnly: true }, palette: { visible: true, keywords: ['format', 'link', 'url', 'clipboard', 'markdown'] }, handlerId: 'format-link' }),
  command({ id: 'deck-design', label: 'Deck design…', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 10, icon: 'design' }, palette: { visible: true, keywords: ['deck', 'design', 'theme'] }, handlerId: 'deck-design' }),
  command({ id: 'metadata', label: 'Metadata…', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 30, icon: 'handout' }, palette: { visible: true, keywords: ['metadata', 'frontmatter', 'talk'] }, handlerId: 'metadata' }),
  command({ id: 'tag-slide', label: 'Tag current slide… (curated labels, shared vault-wide)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['tag', 'slide', 'labels', 'vault'] }, handlerId: 'tag-slide' }),
  command({ id: 'abstract', label: 'Edit abstract', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 40, icon: 'abstract' }, palette: { visible: true, keywords: ['edit', 'abstract'] }, handlerId: 'abstract' }),
  command({ id: 'view-editor', label: 'View: Editor only', scope: 'app', shortcutId: 'app.view-editor', menu: null, palette: { visible: true, keywords: ['view', 'editor'] }, handlerId: 'view-editor' }),
  command({ id: 'view-both', label: 'View: Editor + slides', scope: 'app', shortcutId: 'app.view-split', menu: null, palette: { visible: true, keywords: ['view', 'editor', 'slides', 'split'] }, handlerId: 'view-both' }),
  command({ id: 'view-plain', label: 'Show the plain view', scope: 'editor', menu: null, palette: { visible: true, keywords: ['plain', 'view', 'editor', 'tab', 'markdown'] }, handlerId: 'view-plain' }),
  command({ id: 'view-markdown', label: 'Show the Markdown view', scope: 'editor', menu: null, palette: { visible: true, keywords: ['markdown', 'view', 'editor', 'tab', 'plain', 'source'] }, handlerId: 'view-markdown' }),
  command({ id: 'change-heading-level', label: "Change this heading's level…", scope: 'editor', menu: null, palette: { visible: true, keywords: ['heading', 'level', 'section', 'slide', 'talk', 'title', 'promote', 'demote'] }, handlerId: 'change-heading-level' }),
  command({ id: 'change-slide-layout', label: "Change this slide's layout…", scope: 'editor', menu: null, palette: { visible: true, keywords: ['slide', 'layout', 'cards', 'list', 'compare', 'auto', 'margin'] }, handlerId: 'change-slide-layout' }),
  command({ id: 'view-strip', label: 'View: Slide strip', scope: 'app', shortcutId: 'app.view-strip', menu: null, toolbar: { menu: 'deck', order: 75, icon: 'strip', actionBarOnly: true }, palette: { visible: true, keywords: ['view', 'slide', 'strip'] }, handlerId: 'view-strip' }),
  command({ id: 'view-grid', label: 'View: Grid', scope: 'app', shortcutId: 'app.view-grid', menu: null, palette: { visible: true, keywords: ['view', 'grid'] }, handlerId: 'view-grid' }),
  command({ id: 'fold-all', label: 'Fold all sections', scope: 'editor', menu: null, palette: { visible: true, keywords: ['fold', 'collapse', 'sections'] }, handlerId: 'fold-all' }),
  command({ id: 'unfold-all', label: 'Unfold all sections', scope: 'editor', menu: null, palette: { visible: true, keywords: ['unfold', 'expand', 'sections'] }, handlerId: 'unfold-all' }),
  // The Slides outline and the grid share one set of collapsed sections (renderer lib/outlineCollapseStore.ts).
  // Keyless on purpose: the palette and the two header buttons are the way in.
  command({ id: 'outline-collapse-all', label: 'Collapse all sections', scope: 'app', menu: null, palette: { visible: true, keywords: ['collapse', 'fold', 'sections', 'outline', 'slides', 'grid'] }, handlerId: 'outline-collapse-all' }),
  command({ id: 'outline-expand-all', label: 'Expand all sections', scope: 'app', menu: null, palette: { visible: true, keywords: ['expand', 'unfold', 'open', 'sections', 'outline', 'slides', 'grid'] }, handlerId: 'outline-expand-all' }),
  // Move slide to… / Move section to…: a destination list for the slide or section at the caret or selected
  // in the Slides outline or the grid (renderer components/SlideRowMenus.tsx). Keyless: the keyboard document
  // assigns them no chord; the palette, Actions here and the slide and section context menus are the way in.
  command({ id: 'move-slide-to', label: 'Move slide to…', scope: 'app', menu: null, palette: { visible: true, keywords: ['move', 'slide', 'reorder', 'section', 'start', 'end', 'before', 'after'] }, handlerId: 'move-slide-to' }),
  command({ id: 'move-section-to', label: 'Move section to…', scope: 'app', menu: null, palette: { visible: true, keywords: ['move', 'section', 'reorder', 'start', 'end', 'before', 'after'] }, handlerId: 'move-section-to' }),
  // Select several slides in the grid (slide handling 1b): the commands behind the "Select section" link, Esc and the batch bar's Move to….
  command({ id: 'select-section', label: 'Select section', scope: 'app', menu: null, palette: { visible: true, keywords: ['select', 'section', 'slides', 'grid', 'several'] }, handlerId: 'select-section' }),
  command({ id: 'clear-slide-selection', label: 'Clear slide selection', scope: 'app', menu: null, palette: { visible: true, keywords: ['clear', 'deselect', 'selection', 'slides', 'grid'] }, handlerId: 'clear-slide-selection' }),
  command({ id: 'set-aside-slides', label: 'Set aside in Scratchpad', scope: 'app', shortcutId: 'app.set-aside', menu: { path: ['Slides'], order: 85 }, palette: { visible: true, keywords: ['set aside', 'scratchpad', 'park', 'selected', 'slides'] }, handlerId: 'set-aside-slides' }),
  command({ id: 'move-selected-slides-to', label: 'Move selected slides to…', scope: 'app', menu: null, palette: { visible: true, keywords: ['move', 'selected', 'slides', 'reorder', 'section', 'grid'] }, handlerId: 'move-selected-slides-to' }),
  // Search the slides (slide handling 2): the grid's search box, and Next / Previous through the hits of whichever search is showing (grid first, else the outline's).
  command({ id: 'search-slides-grid', label: 'Search slides in the grid', scope: 'app', shortcutId: 'app.grid-search', menu: null, palette: { visible: true, keywords: ['search', 'find', 'slides', 'grid', 'dim', 'highlight'] }, handlerId: 'search-slides-grid' }),
  command({ id: 'search-next', label: 'Next search result', scope: 'app', shortcutId: 'app.search-next', menu: null, palette: { visible: true, keywords: ['search', 'next', 'result', 'hit', 'slides', 'outline', 'grid'] }, handlerId: 'search-next' }),
  command({ id: 'search-previous', label: 'Previous search result', scope: 'app', shortcutId: 'app.search-previous', menu: null, palette: { visible: true, keywords: ['search', 'previous', 'result', 'hit', 'slides', 'outline', 'grid'] }, handlerId: 'search-previous' }),
  command({ id: 'normalize-triggers', label: 'Normalize trigger lines', scope: 'editor', menu: null, toolbar: { menu: 'deck', order: 60, icon: 'tools' }, palette: { visible: true, keywords: ['normalise', 'trigger', 'lines'] }, handlerId: 'normalize-triggers' }),
  command({ id: 'undo', label: 'Undo', scope: 'editor', shortcutId: 'editor.undo', menu: null, toolbar: { menu: 'deck', order: 100, icon: 'undo', actionBarOnly: true }, palette: { visible: true, keywords: ['undo', 'history'] }, handlerId: 'undo' }),
  command({ id: 'redo', label: 'Redo', scope: 'editor', shortcutId: 'editor.redo', menu: null, toolbar: { menu: 'deck', order: 110, icon: 'redo', actionBarOnly: true }, palette: { visible: true, keywords: ['redo', 'history'] }, handlerId: 'redo' }),
  command({ id: 'new-slide', label: 'New slide', scope: 'editor', shortcutId: 'editor.new-slide', menu: null, toolbar: { menu: 'deck', order: 120, icon: 'newslide', actionBarOnly: true }, palette: { visible: true, keywords: ['new', 'slide', 'heading'] }, handlerId: 'new-slide' }),
  command({ id: 'promote-heading', label: 'Promote heading', scope: 'editor', shortcutId: 'editor.promote', menu: null, toolbar: { menu: 'deck', order: 130, icon: 'promote', actionBarOnly: true }, palette: { visible: true, keywords: ['promote', 'heading'] }, handlerId: 'promote-heading' }),
  command({ id: 'demote-heading', label: 'Demote heading', scope: 'editor', shortcutId: 'editor.demote', menu: null, toolbar: { menu: 'deck', order: 140, icon: 'demote', actionBarOnly: true }, palette: { visible: true, keywords: ['demote', 'heading'] }, handlerId: 'demote-heading' }),
  command({ id: 'bulleted-list', label: 'Bulleted list', scope: 'editor', shortcutId: 'editor.bulleted-list', menu: null, toolbar: { menu: 'deck', order: 150, icon: 'bullets', actionBarOnly: true }, palette: { visible: true, keywords: ['bullets', 'list'] }, handlerId: 'bulleted-list' }),
  command({ id: 'numbered-list', label: 'Numbered list', scope: 'editor', shortcutId: 'editor.numbered-list', menu: null, toolbar: { menu: 'deck', order: 160, icon: 'numbered', actionBarOnly: true }, palette: { visible: true, keywords: ['numbered', 'list'] }, handlerId: 'numbered-list' }),
  command({ id: 'delete-slide', label: 'Delete current slide', scope: 'editor', shortcutId: 'editor.delete-slide', menu: null, toolbar: { menu: 'deck', order: 70, icon: 'trash' }, palette: { visible: true, keywords: ['delete', 'current', 'slide'] }, handlerId: 'delete-slide' }),
  // T27: ⌘⇧P is promoted from the shortcut-only fallthrough to an explicit command so the Tools
  // menu can open the palette too. Palette-hidden: the palette must not list itself.
  command({ id: 'app.command-palette', label: 'All commands…', scope: 'app', shortcutId: 'app.command-palette', menu: null, toolbar: { menu: 'tools', order: 45, icon: 'command' }, palette: { visible: false, keywords: [] }, handlerId: 'app.command-palette' }),
  command({ id: 'help', label: 'Keyboard shortcuts', scope: 'app', shortcutId: 'app.help', menu: { path: ['Help'], order: 30 }, toolbar: { menu: 'tools', order: 50, icon: 'keyboard' }, palette: { visible: true, keywords: ['help', 'keyboard', 'shortcuts'] }, handlerId: 'help' }),
  command({ id: 'settings', label: 'Settings', scope: 'app', shortcutId: 'app.settings', menu: null, toolbar: { menu: 'tools', order: 40, icon: 'settings' }, palette: { visible: true, keywords: ['settings', 'preferences', 'about', 'updates', 'version', 'check for new versions'] }, handlerId: 'settings' }),
  // Update notices (ADR-0041): both commands have no default key, are rebindable, and sit in the Help menu
  // (Check for Updates… sits in the TalkWeaver menu under About on macOS: src/main/app-menu.ts).
  command({ id: 'check-for-updates', label: 'Check for Updates…', scope: 'app', shortcutId: 'app.check-for-updates', menu: { path: ['Help'], order: 10 }, palette: { visible: true, keywords: ['update', 'updates', 'new version', 'upgrade', 'download', 'latest', 'check'] }, handlerId: 'check-for-updates' }),
  command({ id: 'whats-new', label: "What's new in TalkWeaver", scope: 'app', shortcutId: 'app.whats-new', menu: { path: ['Help'], order: 20 }, palette: { visible: true, keywords: ['whats new', 'release notes', 'changes', 'version', 'updated', 'notes'] }, handlerId: 'whats-new' }),
  // Onboarding ticket 12: first of the three Get started rows (state 16b); it brings the removed example vault back.
  command({ id: 'get-started-show-example', label: 'Get started: show the example vault again', scope: 'app', menu: null, palette: { visible: true, keywords: ['get started', 'example', 'example vault', 'restore', 'bring back', 'onboarding'] }, handlerId: 'example.restore' }),
  // Onboarding ticket 07: the Guide's two palette rows (state 16b). No key, no menu, no toolbar placement.
  command({ id: 'get-started-open-guide', label: 'Get started: open the Guide', scope: 'app', menu: null, palette: { visible: true, keywords: ['get started', 'guide', 'onboarding', 'learn', 'first steps', 'tour'] }, handlerId: 'guide.open' }),
  command({ id: 'get-started-show-guide-button', label: 'Get started: show the Guide button', scope: 'app', menu: null, palette: { visible: true, keywords: ['get started', 'guide', 'button', 'sidebar', 'onboarding'] }, handlerId: 'guide.show-button' })
] as const

/**
 * The Tools window's own commands (work-files ticket 30): the three views behind pre-work and what
 * the Run on show can do. They are listed in the Tools window's palette (⌘⇧P there) and on the ⌘/ sheet, never in the
 * editor's palette (its window has no Run page to act on). Ids start `tools-`; the keys are the `tools.*` rows of
 * the shortcut registry, each with its reason. A command that acts on the Run on show is
 * `needsRun`: the window offers it only while a Run page shows and its button would be enabled.
 */
const TOOLS_WINDOW_COMMANDS = [
  command({ id: 'tools-view-sessions', label: 'Sessions', scope: 'tools', shortcutId: 'tools.view-sessions', menu: null, palette: { visible: true, keywords: ['sessions', 'runs', 'upcoming', 'planned', 'delivered', 'calendar'] }, handlerId: 'tools-view-sessions' }),
  command({ id: 'tools-view-published', label: 'Published pages', scope: 'tools', shortcutId: 'tools.view-published', menu: null, palette: { visible: true, keywords: ['published', 'pages', 'handouts', 'live pages', 'web', 'unpublish'] }, handlerId: 'tools-view-published' }),
  command({ id: 'tools-view-workfiles', label: 'Work files', scope: 'tools', shortcutId: 'tools.view-workfiles', menu: null, palette: { visible: true, keywords: ['work files', 'pre-work', 'post-work', 'prework', 'postwork', 'files'] }, handlerId: 'tools-view-workfiles' }),
  command({ id: 'tools-plan-run', label: 'Plan a run…', scope: 'tools', shortcutId: 'tools.plan-run', menu: null, palette: { visible: true, keywords: ['plan', 'run', 'new run', 'session', 'event', 'schedule'] }, handlerId: 'tools-plan-run' }),
  command({ id: 'tools-edit-plan', label: 'Edit plan', scope: 'tools', shortcutId: 'tools.edit-plan', menu: null, palette: { visible: true, keywords: ['edit', 'plan', 'change', 'date', 'time', 'run', 'event'] }, handlerId: 'tools-edit-plan' }),
  command({ id: 'tools-plan-like-this', label: 'Plan the next run like this', scope: 'tools', shortcutId: 'tools.plan-like-this', menu: null, palette: { visible: true, keywords: ['plan', 'next run', 'copy', 'duplicate', 'repeat', 'again', 'like this'] }, handlerId: 'tools-plan-like-this' }),
  command({ id: 'tools-publish', label: 'Publish for this run', scope: 'tools', shortcutId: 'tools.publish', menu: null, palette: { visible: true, keywords: ['publish', 'page', 'put online', 'upload', 'run', 'handout'] }, handlerId: 'tools-publish' }),
  command({ id: 'tools-unpublish', label: 'Unpublish', scope: 'tools', menu: null, palette: { visible: true, keywords: ['unpublish', 'take down', 'remove page', 'offline', 'run'] }, handlerId: 'tools-unpublish' }),
  command({ id: 'tools-go-live', label: 'Go live', scope: 'tools', shortcutId: 'tools.go-live', menu: null, palette: { visible: true, keywords: ['live', 'go live', 'start', 'present', 'run', 'audience'] }, handlerId: 'tools-go-live' }),
  command({ id: 'tools-open-run', label: 'Open run', scope: 'tools', shortcutId: 'tools.open-run', menu: null, palette: { visible: true, keywords: ['open', 'run', 'session', 'show run', 'published page'] }, handlerId: 'tools-open-run' }),
  command({ id: 'tools-copy-link', label: 'Copy link', scope: 'tools', shortcutId: 'tools.copy-link', menu: null, palette: { visible: true, keywords: ['copy', 'link', 'url', 'page link', 'share', 'run'] }, handlerId: 'tools-copy-link' }),
  command({ id: 'tools-copy-invitation', label: 'Copy invitation text', scope: 'tools', shortcutId: 'tools.copy-invitation', menu: null, palette: { visible: true, keywords: ['copy', 'invitation', 'invite', 'email', 'text', 'message', 'run'] }, handlerId: 'tools-copy-invitation' }),
  command({ id: 'tools-new-work-file', label: 'New work file…', scope: 'tools', shortcutId: 'tools.new-work-file', menu: null, palette: { visible: true, keywords: ['new', 'work file', 'pre-work', 'post-work', 'create', 'file'] }, handlerId: 'tools-new-work-file' })
] as const

/** The Tools-window commands that act on the Run page on show (disabled while none shows or its button is disabled). */
export const TOOLS_RUN_COMMAND_IDS: readonly string[] = [
  'tools-edit-plan', 'tools-plan-like-this', 'tools-publish', 'tools-unpublish', 'tools-go-live', 'tools-copy-link', 'tools-copy-invitation'
]

export type PaletteCommandHandlerId = (typeof PALETTE_COMMANDS)[number]['handlerId']

const withTaskGroup = <T extends { id: string }>(definition: T): T & TaskGroupFields & CommandPlaceFields => {
  const fields = taskGroupFields(definition.id)
  return { ...definition, ...fields, places: placeDeclarationFor(definition.id, fields.taskGroup, fields.surface) }
}

const STAMPED_PALETTE_COMMANDS = PALETTE_COMMANDS.map(withTaskGroup)
const STAMPED_TOOLS_COMMANDS = TOOLS_WINDOW_COMMANDS.map(withTaskGroup)

const claimedShortcuts = new Set([...PALETTE_COMMANDS, ...TOOLS_WINDOW_COMMANDS].flatMap((entry) => entry.shortcutId ? [entry.shortcutId] : []))
const shortcutOnlyCommands: CommandDefinition[] = SHORTCUT_REGISTRY
  .filter((shortcut) => !claimedShortcuts.has(shortcut.id))
  .map((shortcut) => withTaskGroup({
    id: shortcut.id,
    label: shortcut.label,
    scope: shortcut.scope,
    shortcutId: shortcut.id,
    menu: null,
    palette: { visible: false, keywords: [] },
    handlerId: shortcut.id
  }))

export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  ...STAMPED_PALETTE_COMMANDS,
  ...STAMPED_TOOLS_COMMANDS,
  ...shortcutOnlyCommands
]

/** The commands the Tools window's palette lists, in the order above. */
export function toolsWindowCommands(): readonly CommandDefinition[] {
  return STAMPED_TOOLS_COMMANDS
}

export function paletteCommands(): readonly (typeof STAMPED_PALETTE_COMMANDS)[number][] {
  return STAMPED_PALETTE_COMMANDS
}

/**
 * The commands the ⌘⇧P palette does not list, each with its reason (onboarding 01: the palette
 * lists every command; this is the written exclusion list). A command is excluded when the palette
 * cannot give it what it needs: a key that works inside a surface, a window of its own, a focused
 * row, or the key's own context. scripts/test-task-groups.mjs fails when a command is neither
 * listed nor here, or when an entry here is not a command.
 */
export const PALETTE_EXCLUSIONS: Readonly<Record<string, string>> = {
  'app.command-palette': 'the palette does not list itself',
  'app.context-menu': 'opens at the caret or the pointer; Actions here (⌘K) replaces it',
  'app.inspector-slides': 'works only with keyboard focus in the Inspector',
  'app.inspector-steps': 'works only with keyboard focus in the Inspector',
  'editor.title-continue': 'the Enter key from a title: acts on the key press itself',
  'editor.protected-line-continue': 'the Enter key from a protected line: acts on the key press itself',
  'editor.list-continue': 'the Enter key in a list: acts on the key press itself',
  'editor.quote-paragraph': 'the Shift-Enter key in a quotation: acts on the key press itself',
  'editor.list-indent': 'the Tab key in a list: acts on the key press itself',
  'editor.list-outdent': 'the ⇧Tab key in a list: acts on the key press itself',
  'editor.protect-heading-delete': 'the Delete key on a heading: acts on the key press itself',
  'editor.object-edit': 'needs an object at the caret and the Enter key',
  'editor.object-raw': 'needs an object widget under the caret',
  'editor.object-finish': 'needs an open object editor',
  'editor.object-discard': 'needs an open object editor',
  'editor.object-row-up': 'works only with focus in a chat, terminal or trace editor row',
  'editor.object-row-down': 'works only with focus in a chat, terminal or trace editor row',
  'editor.insert-notes': 'the same as Insert speaker notes (listed once, from the Insert menu); this row is its rebindable key'
}

// Whole windows and panels whose keys act on their own focused row or state; the palette in the
// editor window has no such row to give them.
const EXCLUDED_PREFIXES: readonly (readonly [string, string])[] = [
  ['pathway.', 'works inside the Pathways window'],
  ['talktext.', 'works inside the Notes and script window'],
  ['importer.', 'works inside the Importer window'],
  ['studio.', 'works inside the Studio window'],
  ['tools-', 'works inside the Tools window: it acts on the view or the Run page on show; listed in that window\'s own palette'],
  ['browser.', 'acts on the focused row of the Talks panel']
]

/** Why the ⌘⇧P palette (the editor window's) does not list this command, or null when it does. */
export function paletteExclusion(command: CommandDefinition): string | null {
  if (command.surface) return `a key inside ${command.surface}`
  if (command.scope === 'presenter') return 'runs in the presenter window; listed in its own palette'
  const written = PALETTE_EXCLUSIONS[command.id]
  if (written) return written
  const prefixed = EXCLUDED_PREFIXES.find(([prefix]) => command.id.startsWith(prefix))
  return prefixed ? prefixed[1] : null
}

/** Every command the editor palette lists: the declared palette commands first, then the rest. */
export function listedPaletteCommands(): CommandDefinition[] {
  return COMMAND_REGISTRY.filter((command) => paletteExclusion(command) === null)
}

/**
 * How many commands each task group holds, counted from the registries and never typed: every
 * registry command that is not a key inside a surface, plus the presenter palette's entries that
 * have no key of their own (they are commands the registry has no row for). Later tickets read this.
 */
export function taskGroupCounts(): Record<TaskGroup, number> {
  const counts = Object.fromEntries(TASK_GROUPS.map((group) => [group, 0])) as Record<TaskGroup, number>
  for (const command of COMMAND_REGISTRY) if (command.taskGroup) counts[command.taskGroup] += 1
  for (const group of PRESENTER_PALETTE) {
    for (const entry of group[1]) {
      if (entry.shortcut) continue
      const fields = taskGroupFields(`presenter-palette.${entry.id}`)
      if (fields.taskGroup) counts[fields.taskGroup] += 1
    }
  }
  return counts
}

export function menuCommands(): CommandDefinition[] {
  return COMMAND_REGISTRY
    .filter((entry) => entry.menu !== null)
    .sort((a, b) => {
      const pathOrder = (a.menu?.path.join('/') ?? '').localeCompare(b.menu?.path.join('/') ?? '')
      return pathOrder || (a.menu?.order ?? 0) - (b.menu?.order ?? 0)
    })
}

export function toolbarCommands(menu: ToolbarMenuName): CommandDefinition[] {
  return COMMAND_REGISTRY
    .filter((entry) => entry.toolbar?.menu === menu && !entry.toolbar.actionBarOnly)
    .sort((a, b) => (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0))
}

export function commandShortcutLabel(command: CommandDefinition, overrideLabel?: string): string {
  if (!command.shortcutId) return ''
  if (overrideLabel !== undefined) return overrideLabel
  const shortcut = shortcutById(command.shortcutId)
  return shortcut.unbound ? 'no default' : shortcut.keys
}

export function commandElectronAccelerator(command: CommandDefinition): string | undefined {
  if (!command.shortcutId) return undefined
  const code = shortcutById(command.shortcutId).codes[0]
  if (!code || /(?:Arrow|Digit|Bracket|Backspace|Escape|Enter|Space)/.test(code)) return undefined
  return code
    .split('-')
    .map((part) => part === 'Mod' ? 'CommandOrControl' : part === 'Alt' ? 'Alt' : part.length === 1 ? part.toUpperCase() : part)
    .join('+')
}
