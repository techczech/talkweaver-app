// User keymap overrides, applied live. Since 0.42 they are kept by main in the settings store
// (src/main/settings-keymap.ts; the split between registry shortcuts and the app's own keymap layer
// is src/shared/keymap-overrides.ts). This module holds the last overrides main sent, so every read
// stays synchronous; until main has answered it reads what the renderer kept in localStorage before
// 0.42, which startKeymapSync() moves into the store once. An override '' is a shortcut removed on
// purpose: it stays removed and never falls back to the default.
//
// The Editor rebuilds its CodeMirror keymap (in a Compartment) whenever they change. Only the KEY of a command can be overridden — never the
// command's behaviour — so a bad override can shadow a binding but can't break the command itself.
import type { KeyBinding } from '@codemirror/view'
import { displayKeys, EDITOR_COMMANDS, NON_CONSUMING } from './registry'
import { commandShortcutLabel, type CommandDefinition } from '../../../shared/command-registry'
import { shortcutById, shortcutEventMatches } from '../../../shared/shortcut-registry'
import { commandRan } from '../commands/command-ran'
import { isEditorKeyString } from '../../../shared/keymap-overrides'

const STORAGE_KEY = 'tw-keymap-overrides' // before 0.42 (LEGACY_KEYMAP_STORAGE)
// Fires (window event) whenever overrides change, so a mounted Editor reconfigures its keymap.
export const KEYMAP_CHANGED_EVENT = 'tw-keymap-changed'

export type Overrides = Record<string, string>

/** What main last sent (null until it has answered). */
let fromMain: Overrides | null = null

function readLegacy(): Overrides {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Overrides) : {}
  } catch {
    return {}
  }
}

export function readOverrides(): Overrides {
  return fromMain ?? readLegacy()
}

function adopt(o: Overrides): void {
  fromMain = { ...o }
  window.dispatchEvent(new Event(KEYMAP_CHANGED_EVENT))
}

type KeymapBridge = {
  get(): Promise<Overrides>
  set(o: Overrides): Promise<{ ok: boolean; overrides: Overrides }>
  moveLegacy(o: Overrides): Promise<{ outcome: 'consumed' | 'retry'; overrides: Overrides }>
  onChanged(cb: (o: Overrides) => void): () => void
}
const bridge = (): KeymapBridge | undefined => (window as unknown as { tw?: { keymap?: KeymapBridge } }).tw?.keymap

function writeOverrides(o: Overrides): void {
  const keymap = bridge()
  if (!keymap) {
    // No main process (the browser preview, a node test): kept for this page as before 0.42.
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(o)) } catch { /* the in-memory keymap still updates */ }
    window.dispatchEvent(new Event(KEYMAP_CHANGED_EVENT))
    return
  }
  adopt(o) // at once; main's answer (what the store holds) follows
  void keymap.set(o).then((r) => adopt(r.overrides)).catch(() => { /* kept for this session */ })
}

/**
 * Once per window, at start: read the overrides from main, move the localStorage ones of an earlier
 * version into the store (main does it once for the whole app), and follow every change (the Settings
 * window's Shortcuts page, another window, the settings CLI). Returns the unsubscribe.
 */
export function startKeymapSync(): () => void {
  const keymap = bridge()
  if (!keymap) return () => {}
  const off = keymap.onChanged(adopt)
  const legacy = (() => { try { return window.localStorage.getItem(STORAGE_KEY) } catch { return null } })()
  const first = legacy !== null ? keymap.moveLegacy(readLegacy()) : keymap.get().then((overrides) => ({ outcome: 'retry' as const, overrides }))
  void first.then((r) => {
    adopt(r.overrides)
    // Only when main says the store holds them now (or held its own already) does the old copy go;
    // a move that could not be written ('retry', a held settings lock, say) keeps it for next time.
    if (legacy !== null && r?.outcome === 'consumed') { try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* harmless */ } }
  }).catch(() => { /* main did not answer: the localStorage copy stays in use and is moved next time */ })
  return off
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
  if (override === '') return '' // removed on purpose
  return isValidKeyString(override) ? override.trim() : cmd?.keys ?? ''
}

// Build the CodeMirror key bindings from the registry + current overrides. Used by the editor's
// keymap Compartment so customised chords take effect without a reload.
// A whole CodeMirror key string (e.g. 'Mod-Alt-ArrowUp', 'b', 'Enter'): known modifiers only, then
// one base key (shared/keymap-overrides.ts isEditorKeyString, the check main and the store apply
// too). Anything else is REJECTED so a bad entry can never throw inside keymap.of() ("Unrecognized
// modifier name") and take down EVERY outliner shortcut.
export function isValidKeyString(s: unknown): s is string {
  return isEditorKeyString(s)
}

export function liveShortcutLabel(registryId: string): string {
  const command = EDITOR_COMMANDS.find((candidate) => candidate.shortcutId === registryId)
  const override = readOverrides()[command?.id ?? registryId]
  if (override === '') return 'no shortcut'
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
  if (override === '') return false // removed on purpose
  return shortcutEventMatches(
    event,
    registryId,
    isValidKeyString(override) ? override.trim() : undefined
  )
}

export function buildEditorKeyBindings(): KeyBinding[] {
  const o = readOverrides()
  return EDITOR_COMMANDS.flatMap((c) => {
    // A surface command's key belongs to its DOM owner (the slide picker, the workspace).
    if (c.surface) return []
    const override = o[c.id]
    if (override === '') return [] // removed on purpose: no key, not the default
    // Only honour a VALID override; otherwise fall back to the registry default. An invalid override
    // is ignored (not allowed to break the binding) — the Settings "Reset all" also clears them.
    const validOverride = isValidKeyString(override) ? override.trim() : null
    if (c.unbound && validOverride == null) return []
    const key = validOverride ?? c.keys
    // A key that acted is a run (the Guide ticks it); a key that declined (returned false) is not.
    return {
      key,
      preventDefault: !NON_CONSUMING.has(c.id),
      run: (view) => {
        const acted = c.run(view)
        if (acted) commandRan(c.shortcutId)
        return acted
      }
    }
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
