// User keymap overrides — persisted in renderer localStorage, applied live.
//
// The Settings panel writes overrides here; the Editor rebuilds its CodeMirror keymap (in a
// Compartment) whenever they change. Only the KEY of a command can be overridden — never the
// command's behaviour — so a bad override can shadow a binding but can't break the command itself.
import type { KeyBinding } from '@codemirror/view'
import { displayKeys, EDITOR_COMMANDS, NON_CONSUMING } from './registry'
import { commandShortcutLabel, type CommandDefinition } from '../../../shared/command-registry'
import { shortcutById, shortcutEventMatches } from '../../../shared/shortcut-registry'

const STORAGE_KEY = 'tw-keymap-overrides'
// Fires (window event) whenever overrides change, so a mounted Editor reconfigures its keymap.
export const KEYMAP_CHANGED_EVENT = 'tw-keymap-changed'

export type Overrides = Record<string, string>

export function readOverrides(): Overrides {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Overrides) : {}
  } catch {
    return {}
  }
}

function writeOverrides(o: Overrides): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(o))
  } catch {
    // ignore persistence failures — the in-memory keymap still updates this session
  }
  window.dispatchEvent(new Event(KEYMAP_CHANGED_EVENT))
}

export function setOverride(commandId: string, keys: string): void {
  const o = readOverrides()
  o[commandId] = keys
  writeOverrides(o)
}

export function clearOverride(commandId: string): void {
  const o = readOverrides()
  delete o[commandId]
  writeOverrides(o)
}

export function clearAllOverrides(): void {
  writeOverrides({})
}

// Accept either the local editor command id or its shared shortcut-registry id. Palette and ⌘K
// surfaces carry shortcut ids, while Settings persists overrides under the local command id.
export function effectiveKeys(commandId: string): string {
  const cmd = EDITOR_COMMANDS.find((candidate) =>
    candidate.id === commandId || candidate.shortcutId === commandId
  )
  const override = readOverrides()[cmd?.id ?? commandId]
  return isValidKeyString(override) ? override.trim() : cmd?.keys ?? ''
}

// Build the CodeMirror key bindings from the registry + current overrides. Used by the editor's
// keymap Compartment so customised chords take effect without a reload.
// A plausible CodeMirror key string: a base key after optional modifiers (e.g. 'Mod-Alt-ArrowUp',
// 'b', 'Enter'). Empty/garbage overrides are REJECTED so a bad Settings entry can never throw inside
// keymap.of() and take down EVERY outliner shortcut (a real "shortcuts stopped working" cause).
export function isValidKeyString(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t || t.endsWith('-')) return false
  const base = t.split('-').pop() || ''
  return /^(?:[A-Za-z0-9]|F\d{1,2}|Arrow(?:Up|Down|Left|Right)|Enter|Tab|Space|Escape|Backspace|Delete|Home|End|PageUp|PageDown|[`~!@#$%^&*()_=+[\]{}\\|;:'",.<>/?-])$/.test(base)
}

export function liveShortcutLabel(registryId: string): string {
  const command = EDITOR_COMMANDS.find((candidate) => candidate.shortcutId === registryId)
  const override = readOverrides()[command?.id ?? registryId]
  if (isValidKeyString(override)) return displayKeys(override.trim()).join('')
  const shortcut = shortcutById(registryId)
  return shortcut.unbound ? 'no default' : shortcut.keys
}

export function liveCommandShortcutLabel(command: CommandDefinition): string {
  if (!command.shortcutId) return ''
  return commandShortcutLabel(command, liveShortcutLabel(command.shortcutId))
}

export function onKeymapChanged(listener: () => void): () => void {
  window.addEventListener(KEYMAP_CHANGED_EVENT, listener)
  return () => window.removeEventListener(KEYMAP_CHANGED_EVENT, listener)
}

export function eventMatchesEffectiveShortcut(
  event: KeyboardEvent,
  registryId: string,
  overrideId = registryId
): boolean {
  const override = readOverrides()[overrideId]
  return shortcutEventMatches(
    event,
    registryId,
    isValidKeyString(override) ? override.trim() : undefined
  )
}

export function buildEditorKeyBindings(): KeyBinding[] {
  const o = readOverrides()
  return EDITOR_COMMANDS.flatMap((c) => {
    const override = o[c.id]
    // Only honour a VALID override; otherwise fall back to the registry default. An invalid override
    // is ignored (not allowed to break the binding) — the Settings "Reset all" also clears them.
    const validOverride = isValidKeyString(override) ? override.trim() : null
    if (c.unbound && validOverride == null) return []
    const key = validOverride ?? c.keys
    return { key, preventDefault: !NON_CONSUMING.has(c.id), run: c.run }
  })
}

// Convert a keydown event into a CodeMirror key string (e.g. 'Mod-Alt-ArrowUp'). Returns null for
// a modifier pressed alone. macOS: Cmd → 'Mod'. Modifier order matches the registry convention.
export function eventToCMKey(e: KeyboardEvent): string | null {
  let key = e.key
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift' || key === 'OS') {
    return null
  }
  const parts: string[] = []
  if (e.metaKey) parts.push('Mod')
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  // Normalise the base key to CodeMirror's names.
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toLowerCase()
  // Arrow*, Enter, Tab, Escape, Home, End, etc. already match CodeMirror's KeyboardEvent.key names.
  parts.push(key)
  return parts.join('-')
}
