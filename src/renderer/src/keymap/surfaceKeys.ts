// The keys of the rebindable surface commands (talk search 08): the slide picker's talk-search
// actions and the workspace's Find a talk. Each is registered twice over — a shortcut-registry id
// (the default key, the cheat sheet row, the palette hint) and a surface command in EDITOR_COMMANDS
// under the local id below (the Settings row a rebind is stored against). The owner of each key
// asks surfaceKey(), which honours a valid rebind and falls back to the registry default.
import { eventMatchesEffectiveShortcut } from './store'

export const SURFACE_KEYS = {
  'check-for-updates': 'app.check-for-updates',
  'whats-new': 'app.whats-new',
  'research-panel': 'app.research-panel',
  'research-find': 'app.research-find',
  'set-aside-slides': 'app.set-aside',
  'search-slides-grid': 'app.grid-search',
  'search-next': 'app.search-next',
  'search-previous': 'app.search-previous',
  'research-rename': 'research.rename',
  'research-change-kind': 'research.change-kind',
  'research-delete': 'research.delete',
  'research-move': 'research.move',
  'research-copy': 'research.copy',
  'research-insert-here': 'research.insert-here',
  'research-insert': 'research.insert',
  'research-make-slide': 'research.make-slide',
  'research-open': 'research.open',
  'research-previous': 'research.previous',
  'research-next': 'research.next',
  'research-scope': 'research.scope',
  'research-close': 'research.close',
  'research-copy-reference': 'research.copy-reference',
  'research-reveal': 'research.reveal',
  'research-source': 'research.source',
  'research-used-in': 'research.used-in',
  'research-scope-talk': 'research.scope-talk',
  'research-scope-research': 'research.scope-research',
  'research-scope-everything': 'research.scope-everything',
  'research-retry': 'research.retry',
  'find-talk': 'app.find-talk',
  'add-beside': 'slide-picker.add-beside',
  'talk-beside': 'slide-picker.talk-beside',
  'close-beside': 'slide-picker.close-beside',
  'select-whole-section': 'slide-picker.select-whole-section'
} as const

export type SurfaceCommandId = keyof typeof SURFACE_KEYS

export function surfaceKey(event: KeyboardEvent, id: SurfaceCommandId): boolean {
  return eventMatchesEffectiveShortcut(event, SURFACE_KEYS[id], id)
}

/** A plain printable key (no ⌘, ⌃ or ⌥) is typing when a text field has focus, so a surface
 *  command bound to one never fires from a field; a chord fires from anywhere in its surface. */
export function isTypingKey(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1
}
