import {
  SHORTCUT_REGISTRY,
  shortcutById,
  type ShortcutScope
} from './shortcut-registry.ts'

export type CommandScope = ShortcutScope | 'deck' | 'tools'

export interface CommandMenuPlacement {
  path: string[]
  order: number
}

export type ToolbarMenuName = 'insert' | 'deck' | 'tools' | 'present'
export type ToolbarIconToken =
  | 'layout' | 'image' | 'slides' | 'sparkles'
  | 'design' | 'pane-strip' | 'handout' | 'abstract' | 'refresh' | 'tools' | 'trash'
  | 'present' | 'settings' | 'keyboard' | 'window' | 'presenter' | 'audience'

export interface CommandToolbarPlacement {
  menu: ToolbarMenuName
  order: number
  icon: ToolbarIconToken
}

export interface CommandDefinition {
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

const command = <const T extends CommandDefinition>(definition: T): T => definition

// Application commands are declared once here. The palette and native custom menus retain their
// existing order, but now render this data instead of maintaining parallel title/shortcut lists.
const PALETTE_COMMANDS = [
  command({ id: 'refresh', label: 'Rebuild preview', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 50, icon: 'refresh' }, palette: { visible: true, keywords: ['refresh', 'preview', 'thumbnail', 'compile'] }, handlerId: 'refresh' }),
  command({ id: 'optimize-images', label: 'Optimise images to WebP (smaller, faster previews)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['optimise', 'images', 'webp', 'compress'] }, handlerId: 'optimize-images' }),
  command({ id: 'ocr-index', label: 'Index image text (OCR) for search', scope: 'tools', menu: null, palette: { visible: true, keywords: ['ocr', 'index', 'image', 'search'] }, handlerId: 'ocr-index' }),
  command({ id: 'check-embeds', label: 'Check embeds (will videos & sites load when presenting?)', scope: 'tools', menu: null, palette: { visible: true, keywords: ['embed', 'video', 'site', 'check'] }, handlerId: 'check-embeds' }),
  command({ id: 'where-used', label: 'Slide: where used & versions', scope: 'app', shortcutId: 'app.where-used', menu: null, palette: { visible: true, keywords: ['slide', 'usage', 'versions'] }, handlerId: 'where-used' }),
  command({ id: 'focus-slide', label: 'Focus on this slide (scoped editing + live preview)', scope: 'app', shortcutId: 'app.slide-focus', menu: null, palette: { visible: true, keywords: ['focus', 'slide', 'preview'] }, handlerId: 'focus-slide' }),
  command({ id: 'toggle-inspector', label: 'Inspector mode', scope: 'app', shortcutId: 'app.toggle-inspector', menu: { path: ['Deck'], order: 10 }, toolbar: { menu: 'deck', order: 20, icon: 'pane-strip' }, palette: { visible: true, keywords: ['inspector', 'slide strip', 'pane'] }, handlerId: 'toggle-inspector' }),
  command({ id: 'studio', label: 'TalkWeaver Studio…', scope: 'tools', menu: null, toolbar: { menu: 'tools', order: 10, icon: 'present' }, palette: { visible: true, keywords: ['studio', 'recordings', 'play'] }, handlerId: 'studio' }),
  command({ id: 'history', label: 'TalkWeaver History…', scope: 'tools', menu: null, toolbar: { menu: 'tools', order: 20, icon: 'slides' }, palette: { visible: true, keywords: ['history', 'ledger', 'delivered'] }, handlerId: 'history' }),
  command({ id: 'plan-run', label: 'Plan a Run', scope: 'tools', menu: null, palette: { visible: true, keywords: ['plan', 'run', 'event', 'audience', 'delivery'] }, handlerId: 'plan-run' }),
  command({ id: 'pathways', label: 'Pathways…', scope: 'deck', shortcutId: 'app.pathways', menu: { path: ['Deck'], order: 20 }, toolbar: { menu: 'deck', order: 25, icon: 'slides' }, palette: { visible: true, keywords: ['pathway', 'variant', 'custom show', 'slides'] }, handlerId: 'pathways' }),
  command({ id: 'new-window', label: 'New window (work on another presentation)', scope: 'app', shortcutId: 'app.new-window', menu: null, palette: { visible: true, keywords: ['new', 'window', 'presentation'] }, handlerId: 'new-window' }),
  command({ id: 'new-talk', label: 'New presentation…', scope: 'app', menu: null, palette: { visible: true, keywords: ['new', 'talk', 'presentation'] }, handlerId: 'new-talk' }),
  command({ id: 'new-folder', label: 'New folder…', scope: 'app', menu: null, palette: { visible: true, keywords: ['new', 'folder'] }, handlerId: 'new-folder' }),
  command({ id: 'refresh-talks', label: 'Refresh talk list (re-scan vault)', scope: 'app', menu: null, palette: { visible: true, keywords: ['refresh', 'talks', 'vault', 'scan'] }, handlerId: 'refresh-talks' }),
  command({ id: 'change-vault', label: 'Change vault folder…', scope: 'app', menu: null, palette: { visible: true, keywords: ['change', 'vault', 'folder'] }, handlerId: 'change-vault' }),
  command({ id: 'search-talks', label: 'Search presentations…', scope: 'app', shortcutId: 'app.sidebar-talks', menu: null, palette: { visible: true, keywords: ['search', 'talks', 'presentations'] }, handlerId: 'search-talks' }),
  command({ id: 'present-window', label: 'Presentation window', scope: 'deck', menu: null, toolbar: { menu: 'present', order: 10, icon: 'window' }, palette: { visible: true, keywords: ['present', 'window'] }, handlerId: 'present-window' }),
  command({ id: 'present-presenter', label: 'Presenter view', scope: 'deck', shortcutId: 'app.present', menu: null, toolbar: { menu: 'present', order: 20, icon: 'presenter' }, palette: { visible: true, keywords: ['present', 'presenter', 'view'] }, handlerId: 'present-presenter' }),
  command({ id: 'present-from-here', label: 'Presenter from current slide', scope: 'deck', shortcutId: 'app.present-current', menu: null, toolbar: { menu: 'present', order: 30, icon: 'presenter' }, palette: { visible: true, keywords: ['present', 'current', 'slide', 'here'] }, handlerId: 'present-from-here' }),
  command({ id: 'present-audience', label: 'Audience view', scope: 'deck', menu: null, toolbar: { menu: 'present', order: 40, icon: 'audience' }, palette: { visible: true, keywords: ['present', 'audience'] }, handlerId: 'present-audience' }),
  command({ id: 'handout', label: 'Share: handout (reveal in Finder)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['share', 'handout', 'finder', 'export'] }, handlerId: 'handout' }),
  command({ id: 'build', label: 'Share: HTML presentation (reveal in Finder)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['share', 'html', 'presentation', 'build'] }, handlerId: 'build' }),
  command({ id: 'publish-handout', label: 'Share: publish to Cloudflare Pages…', scope: 'deck', menu: null, palette: { visible: true, keywords: ['share', 'publish', 'cloudflare', 'handout'] }, handlerId: 'publish-handout' }),
  command({ id: 'layout', label: 'Layout…', scope: 'app', shortcutId: 'app.layout-picker', menu: null, toolbar: { menu: 'insert', order: 10, icon: 'layout' }, palette: { visible: true, keywords: ['insert', 'layout'] }, handlerId: 'layout' }),
  command({ id: 'image', label: 'Image…', scope: 'app', shortcutId: 'app.image-search', menu: null, toolbar: { menu: 'insert', order: 20, icon: 'image' }, palette: { visible: true, keywords: ['insert', 'image', 'powerpoint', 'archive'] }, handlerId: 'image' }),
  command({ id: 'search', label: 'Slides from other talks…', scope: 'app', shortcutId: 'app.slide-search', menu: null, toolbar: { menu: 'insert', order: 30, icon: 'slides' }, palette: { visible: true, keywords: ['insert', 'slides', 'search', 'talks'] }, handlerId: 'search' }),
  command({ id: 'icon-picker', label: 'Icon…', scope: 'app', shortcutId: 'app.icon-picker', menu: null, toolbar: { menu: 'insert', order: 40, icon: 'sparkles' }, palette: { visible: true, keywords: ['insert', 'icon', 'bullet'] }, handlerId: 'icon-picker' }),
  command({ id: 'deck-design', label: 'Deck design…', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 10, icon: 'design' }, palette: { visible: true, keywords: ['deck', 'design', 'theme'] }, handlerId: 'deck-design' }),
  command({ id: 'metadata', label: 'Metadata…', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 30, icon: 'handout' }, palette: { visible: true, keywords: ['metadata', 'frontmatter', 'talk'] }, handlerId: 'metadata' }),
  command({ id: 'tag-slide', label: 'Tag current slide… (curated labels, shared vault-wide)', scope: 'deck', menu: null, palette: { visible: true, keywords: ['tag', 'slide', 'labels', 'vault'] }, handlerId: 'tag-slide' }),
  command({ id: 'abstract', label: 'Edit abstract', scope: 'deck', menu: null, toolbar: { menu: 'deck', order: 40, icon: 'abstract' }, palette: { visible: true, keywords: ['edit', 'abstract'] }, handlerId: 'abstract' }),
  command({ id: 'view-editor', label: 'View: Editor only', scope: 'app', shortcutId: 'app.view-editor', menu: null, palette: { visible: true, keywords: ['view', 'editor'] }, handlerId: 'view-editor' }),
  command({ id: 'view-both', label: 'View: Editor + slides', scope: 'app', shortcutId: 'app.view-split', menu: null, palette: { visible: true, keywords: ['view', 'editor', 'slides', 'split'] }, handlerId: 'view-both' }),
  command({ id: 'view-strip', label: 'View: Slide strip', scope: 'app', shortcutId: 'app.view-strip', menu: null, palette: { visible: true, keywords: ['view', 'slide', 'strip'] }, handlerId: 'view-strip' }),
  command({ id: 'view-grid', label: 'View: Grid', scope: 'app', shortcutId: 'app.view-grid', menu: null, palette: { visible: true, keywords: ['view', 'grid'] }, handlerId: 'view-grid' }),
  command({ id: 'fold-all', label: 'Fold all sections', scope: 'editor', menu: null, palette: { visible: true, keywords: ['fold', 'collapse', 'sections'] }, handlerId: 'fold-all' }),
  command({ id: 'unfold-all', label: 'Unfold all sections', scope: 'editor', menu: null, palette: { visible: true, keywords: ['unfold', 'expand', 'sections'] }, handlerId: 'unfold-all' }),
  command({ id: 'normalize-triggers', label: 'Normalize trigger lines', scope: 'editor', menu: null, toolbar: { menu: 'deck', order: 60, icon: 'tools' }, palette: { visible: true, keywords: ['normalise', 'trigger', 'lines'] }, handlerId: 'normalize-triggers' }),
  command({ id: 'delete-slide', label: 'Delete current slide', scope: 'editor', shortcutId: 'editor.delete-slide', menu: null, toolbar: { menu: 'deck', order: 70, icon: 'trash' }, palette: { visible: true, keywords: ['delete', 'current', 'slide'] }, handlerId: 'delete-slide' }),
  command({ id: 'help', label: 'Keyboard shortcuts', scope: 'app', shortcutId: 'app.help', menu: null, toolbar: { menu: 'tools', order: 50, icon: 'keyboard' }, palette: { visible: true, keywords: ['help', 'keyboard', 'shortcuts'] }, handlerId: 'help' }),
  command({ id: 'settings', label: 'Settings', scope: 'app', shortcutId: 'app.settings', menu: null, toolbar: { menu: 'tools', order: 40, icon: 'settings' }, palette: { visible: true, keywords: ['settings', 'preferences'] }, handlerId: 'settings' })
] as const

export type PaletteCommandHandlerId = (typeof PALETTE_COMMANDS)[number]['handlerId']

const claimedShortcuts = new Set(PALETTE_COMMANDS.flatMap((entry) => entry.shortcutId ? [entry.shortcutId] : []))
const shortcutOnlyCommands: CommandDefinition[] = SHORTCUT_REGISTRY
  .filter((shortcut) => !claimedShortcuts.has(shortcut.id))
  .map((shortcut) => ({
    id: shortcut.id,
    label: shortcut.label,
    scope: shortcut.scope,
    shortcutId: shortcut.id,
    menu: null,
    palette: { visible: false, keywords: [] },
    handlerId: shortcut.id
  }))

export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  ...PALETTE_COMMANDS,
  ...shortcutOnlyCommands
]

export function paletteCommands(): readonly (typeof PALETTE_COMMANDS)[number][] {
  return PALETTE_COMMANDS
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
    .filter((entry) => entry.toolbar?.menu === menu)
    .sort((a, b) => (a.toolbar?.order ?? 0) - (b.toolbar?.order ?? 0))
}

export function commandShortcutLabel(command: CommandDefinition): string {
  return command.shortcutId ? shortcutById(command.shortcutId).keys : ''
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
