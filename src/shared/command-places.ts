// Where each command is offered (onboarding 0.38.1 ticket 02; lock decision 15). Data only: no
// registry import, so command-registry.ts can stamp each command's places beside its task group.
//
// A command declares one of three things:
//   - a list of places: Actions here (⌘K) and the status-bar chip offer it there;
//   - EVERYWHERE: offered at every place;
//   - NOT_BY_PLACE: never offered by place; reached through All commands… (⇧⌘P), its key, a menu
//     or its own window. Deck-wide commands (Present, Share, Pathways, Manage talks) are here at an
//     outline place (lock decision 11), and so is anything the drawn state 12 leaves out.
//
// The ORDER of this table is the order Actions here lists a place's commands in, inside each task
// group (groups follow TASK_GROUPS). The rows for a slide heading are the drawing's (state 12), in
// the drawing's order: 14 of them.
//
// Every command of the registry has a row here or takes its task group's default
// (GROUP_PLACE_DEFAULTS); keys inside a surface are never offered by place. scripts/test-places.mjs
// fails when a command has neither, or when a row names a command the registry does not have.

export const PLACES = [
  'slide-heading',
  'talk-title',
  'layout-line',
  'slide-text',
  'list',
  'quotation',
  'metadata',
  'strip-slide',
  'talk',
  'vault'
] as const

export type Place = (typeof PLACES)[number]

/** The chip's words for each place (lock decision 15), capitalised as the drawing shows them. */
export const PLACE_LABELS: Readonly<Record<Place, string>> = {
  'slide-heading': 'On a slide heading',
  'talk-title': 'On the talk title',
  'layout-line': 'On a layout line',
  'slide-text': 'In slide text',
  list: 'In a list',
  quotation: 'In a quotation',
  metadata: 'In the metadata',
  'strip-slide': 'On a slide in the strip',
  talk: 'On a talk',
  vault: 'On a vault'
}

export const EVERYWHERE = 'everywhere' as const
export const NOT_BY_PLACE = 'not-by-place' as const

export type PlaceDeclaration = readonly Place[] | typeof EVERYWHERE | typeof NOT_BY_PLACE

const FORMAT: readonly Place[] = ['slide-text', 'list', 'quotation']
const SLIDE_WIDE: readonly Place[] = ['slide-heading', 'layout-line', 'slide-text', 'list', 'quotation', 'strip-slide']

/** Explicit declarations, in Actions-here order. */
export const COMMAND_PLACES: Readonly<Record<string, PlaceDeclaration>> = {
  // ── Write the outline ──
  'promote-heading': ['slide-heading', 'list'],
  'demote-heading': ['slide-heading', 'list'],
  'editor.move-up': ['slide-heading', 'list'],
  'editor.move-down': ['slide-heading', 'list'],
  'delete-slide': ['slide-heading', 'strip-slide'],
  'editor.heading-same': ['slide-heading', 'slide-text', 'list'],
  'editor.heading-sub': ['slide-heading', 'slide-text', 'list'],
  'editor.promote-subtree': ['list'],
  'editor.demote-subtree': ['list'],
  'new-slide': ['slide-text'],
  'bulleted-list': ['slide-text', 'list'],
  'numbered-list': ['slide-text', 'list'],
  'format-bold': FORMAT,
  'format-italic': FORMAT,
  'format-underline': FORMAT,
  'format-strikethrough': FORMAT,
  'format-highlight': FORMAT,
  'format-inline-code': FORMAT,
  'format-link': FORMAT,
  'undo': NOT_BY_PLACE,
  'redo': NOT_BY_PLACE,
  'fold-all': NOT_BY_PLACE,
  'unfold-all': NOT_BY_PLACE,
  'editor.title-continue': NOT_BY_PLACE,
  'editor.protect-heading-delete': NOT_BY_PLACE,
  'editor.list-continue': NOT_BY_PLACE,
  'editor.list-indent': NOT_BY_PLACE,
  'editor.list-outdent': NOT_BY_PLACE,

  // ── Build a slide ──
  'layout': ['slide-heading', 'layout-line', 'strip-slide'],
  'image': ['slide-heading', 'slide-text', 'list'],
  'icon-picker': ['slide-heading', 'list'],
  'toggle-inspector': ['slide-heading', 'layout-line', 'strip-slide'],
  'insert-board-slide': ['slide-text'],
  'insert-object-table': ['slide-text'],
  'insert-object-mindmap': ['slide-text'],
  'insert-object-chart': ['slide-text'],
  'insert-object-mermaid': ['slide-text'],
  'insert-object-diagram': ['slide-text'],
  'insert-object-svg': ['slide-text'],
  'insert-component-code': ['slide-text'],
  'insert-component-qr': ['slide-text'],
  'insert-component-action': ['slide-text'],
  'insert-component-embed': ['slide-text'],
  'insert-component-auto-embed': ['slide-text'],
  'insert-component-countdown': ['slide-text'],
  'app.inspector-slides': NOT_BY_PLACE,
  'app.inspector-steps': NOT_BY_PLACE,
  'editor.protected-line-continue': NOT_BY_PLACE,
  'editor.object-edit': NOT_BY_PLACE,
  'editor.object-raw': NOT_BY_PLACE,
  'editor.object-finish': NOT_BY_PLACE,

  // ── Reuse slides ──
  'where-used': ['slide-heading', 'layout-line', 'strip-slide'],
  'tag-slide': ['slide-heading', 'strip-slide'],
  'search': ['slide-text'],
  'find-talk': NOT_BY_PLACE,
  'search-talks': NOT_BY_PLACE,
  'add-talk-beside': NOT_BY_PLACE,
  'talk-beside': NOT_BY_PLACE,
  'close-talk-beside': NOT_BY_PLACE,
  'select-whole-section': NOT_BY_PLACE,

  // ── See the talk ──
  'focus-slide': SLIDE_WIDE,
  'refresh': NOT_BY_PLACE,
  'view-editor': NOT_BY_PLACE,
  'view-both': NOT_BY_PLACE,
  'view-strip': NOT_BY_PLACE,
  'view-grid': NOT_BY_PLACE,
  'app.find': NOT_BY_PLACE,
  'app.sidebar-outline': NOT_BY_PLACE,
  'app.sidebar-toggle': NOT_BY_PLACE,
  'editor.jump-prev': NOT_BY_PLACE,
  'editor.jump-next': NOT_BY_PLACE,

  // ── Shape the talk ──
  'metadata': ['talk-title', 'metadata'],
  'abstract': ['talk-title', 'metadata'],
  'deck-design': ['talk-title', 'metadata'],
  'pathways': NOT_BY_PLACE,
  'plan-run': NOT_BY_PLACE,

  // ── Manage talks ── (rows of the Talks panel; deck-wide at an outline place, lock decision 11)
  'browser.open-talk': ['talk'],
  'open-in-new-window': ['talk', 'vault'],
  'browser.rename': ['talk'],
  'browser.move-talk': ['talk'],
  'browser.duplicate': ['talk'],
  'browser.delete-talk': ['talk'],
  'new-talk': ['vault'],
  'new-folder': ['vault'],
  'refresh-talks': ['vault'],
  'change-vault': ['vault'],
  'browser.fold-all': ['vault'],
  'browser.sort': ['vault'],
  'browser.filter': ['vault'],
  'browser.talk-view': ['vault'],
  'browser.talk-names': ['vault'],
  'browser.up-level': NOT_BY_PLACE,
  'new-window': NOT_BY_PLACE,
  'studio': NOT_BY_PLACE,
  'history': NOT_BY_PLACE,
  'importer': NOT_BY_PLACE,

  // ── Check and repair ──
  'layout-doctor': ['layout-line'],
  'normalize-triggers': ['layout-line'],
  'check-embeds': NOT_BY_PLACE,
  'ocr-index': NOT_BY_PLACE,
  'optimize-images': NOT_BY_PLACE,

  // ── Set up TalkWeaver ──
  'settings': NOT_BY_PLACE,
  // Onboarding ticket 07: the Guide opens from anywhere, so it is offered at no place in particular.
  'get-started-open-guide': NOT_BY_PLACE,
  // Onboarding ticket 12: bringing the example vault back is not tied to a place either.
  'get-started-show-example': NOT_BY_PLACE,
  'get-started-show-guide-button': NOT_BY_PLACE,
  'help': NOT_BY_PLACE,
  'app.command-palette': NOT_BY_PLACE,
  'app.context-menu': NOT_BY_PLACE
}

/**
 * Groups whose every command is declared at once. Present and Share are deck-wide (lock decision
 * 11); the commands that work inside the Pathways, Notes and script, Importer and Studio windows are
 * places inside those views, which ticket 02 leaves out. Any explicit row above wins over these.
 */
export const GROUP_PLACE_DEFAULTS: Readonly<Record<string, PlaceDeclaration>> = {
  Present: NOT_BY_PLACE,
  Share: NOT_BY_PLACE
}

/** Id prefixes whose commands work inside their own window; not offered by place (ticket 02 "Not here"). */
export const VIEW_PREFIXES: readonly string[] = ['pathway.', 'talktext.', 'importer.', 'studio.']

/**
 * The declaration a command carries: its own row, else its window's (prefix), else its task
 * group's default, else null (a gap the registry test reports). A key inside a surface is never
 * offered by place.
 */
export function placeDeclarationFor(id: string, taskGroup: string | null, surface: string | null): PlaceDeclaration | null {
  if (surface) return NOT_BY_PLACE
  const own = COMMAND_PLACES[id]
  if (own) return own
  if (VIEW_PREFIXES.some((prefix) => id.startsWith(prefix))) return NOT_BY_PLACE
  if (taskGroup && GROUP_PLACE_DEFAULTS[taskGroup]) return GROUP_PLACE_DEFAULTS[taskGroup]
  return null
}

/** Is a command with this declaration offered at this place? */
export function offeredAt(declaration: PlaceDeclaration | null, place: Place): boolean {
  if (declaration === EVERYWHERE) return true
  if (declaration === NOT_BY_PLACE || declaration === null) return false
  return declaration.includes(place)
}
