// The editor keymap's overrides (src/renderer/src/keymap/store.ts) and where they are kept since
// 0.42: the settings store, in two places (orchestrator decision, 2026-10-20).
//
//   - A rebindable command whose new key is a chord (a key with ⌘, ⌃ or ⌥) is a shortcut of the
//     command registry: the store's `keys`, under the registry id, so the Settings window's
//     Shortcuts page, the menu bar and `talkweaver settings` see it.
//   - Everything else is the app's own keymap layer: a bare key (Enter, Tab, a letter), ⇧ alone, or a
//     key of a command the registry has no chord for (Undo, the list's Tab keys, the object keys).
//     @app-patterns/commands refuses bare-key overrides, so these are one app-owned setting,
//     KEYMAP_SETTING, holding { local id: key string } as JSON, never registry `keys`.
//
// A key string '' is a shortcut removed on purpose: it stays removed (registry '' = no shortcut; the
// app layer keeps the ''), it never falls back to the default.
//
// Pure; erasable TypeScript only (node tests import it as it is).
import { chordFromKeyString, keyStringFromChord } from './bridle-chords.ts'

/** local keymap id → CodeMirror key string ('' = removed). */
export type Overrides = Record<string, string>

export const KEYMAP_SETTING = 'writing.editorKeys'

/** The localStorage key the renderer kept its overrides under before 0.42 (moved once). */
export const LEGACY_KEYMAP_STORAGE = 'tw-keymap-overrides'

/** The registry's view: local id ↔ registry id for the rebindable commands (bridle-commands.ts). */
export interface KeymapIds {
  bridleIdOfKeymapId(localId: string): string | null
  keymapIdOf(bridleId: string): string | null
}

/** A key the registry can hold as a chord: it has ⌘, ⌃ or ⌥ and spells as one. */
export function isRegistryChord(keyString: string): boolean {
  const t = keyString.trim()
  if (!/(^|-)(Mod|Cmd|Meta|Ctrl|Alt)-/.test(t)) return false
  return chordFromKeyString(t) !== ''
}

// CodeMirror's modifier names (@codemirror/view normalizeKeyName): any other word before a '-'
// makes CodeMirror's keymap builder throw "Unrecognized modifier name", which takes down every editor key.
const CM_MODIFIER: ReadonlyArray<[RegExp, string]> = [
  [/^(cmd|meta|m)$/i, 'meta'], [/^a(lt)?$/i, 'alt'], [/^(c|ctrl|control)$/i, 'ctrl'], [/^s(hift)?$/i, 'shift'], [/^mod$/i, 'mod']
]
// The base keys the editor binds (the renderer's eventToCMKey writes these).
const CM_BASE = /^(?:[A-Za-z0-9]|F\d{1,2}|Arrow(?:Up|Down|Left|Right)|Enter|Tab|Space|Escape|Backspace|Delete|Home|End|PageUp|PageDown|[`~!@#$%^&*()_=+[\]{}\\|;:'",.<>/?])$/

/**
 * True when `s` is one CodeMirror key (Sol review 1, #7): known modifiers, each once, then one base
 * key, nothing else (no second stroke, no trailing '-'). '' is not a key (a removed key is stored as
 * '' and checked by the caller). Every route that keeps an editor key checks it: the store's
 * `validate` (Settings, the CLI, import), main's keymap handlers, and the renderer before it builds the editor keymap.
 */
export function isEditorKeyString(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t || t.length > 100 || /\s/.test(t) || t.endsWith('-')) return false
  const parts = t.split('-')
  const base = parts.pop() ?? ''
  if (!CM_BASE.test(base)) return false
  const seen = new Set<string>()
  for (const part of parts) {
    const mod = CM_MODIFIER.find(([re]) => re.test(part))?.[1]
    if (!mod || seen.has(mod)) return false
    seen.add(mod)
  }
  return true
}

/** An override value that may be kept: a key, or '' (removed on purpose). */
const keepableKey = (s: unknown): s is string => s === '' || isEditorKeyString(s)

/** The app layer's setting value, read tolerantly: anything that is not { string: key } counts as none; a value that is not a key is dropped. */
export function parseAppKeys(text: unknown): Overrides {
  if (typeof text !== 'string' || !text.trim()) return {}
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Overrides = {}
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (keepableKey(s)) out[k] = s
    return out
  } catch { return {} }
}

/** The `validate` of KEYMAP_SETTING: { command: key } where every key is a whole CodeMirror key or ''. */
export function appKeysError(text: unknown): string | null {
  if (typeof text !== 'string') return 'Must be text'
  if (!text.trim()) return null
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.values(v as object).some((s) => typeof s !== 'string')) return 'Must be a list of keys'
    const bad = Object.entries(v as Record<string, string>).find(([, s]) => !keepableKey(s))
    return bad ? `"${bad[1].slice(0, 40)}" is not a key the editor knows` : null
  } catch { return 'Must be a list of keys' }
}

const canonical = (o: Overrides): string => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

/** What the editor applies: the app layer, and the registry's shortcut overrides (as key strings) over it. */
export function overridesFromStore(keys: Readonly<Record<string, string>>, appKeys: unknown, ids: KeymapIds): Overrides {
  const out: Overrides = {}
  for (const [bridleId, chord] of Object.entries(keys)) {
    const local = ids.keymapIdOf(bridleId)
    if (!local) continue
    const k = chord === '' ? '' : keyStringFromChord(chord)
    if (chord === '' || k) out[local] = k
  }
  // The registry wins: a rebind in the Settings window replaces an older app-layer key for the same command.
  return { ...parseAppKeys(appKeys), ...out }
}

/**
 * The store writes that make `wanted` the overrides: registry shortcuts to set (registry id → chord,
 * '' = none), registry shortcuts to put back to their default, and the app layer's new value.
 */
export function storeWritesFor(wanted: Overrides, currentKeys: Readonly<Record<string, string>>, ids: KeymapIds): {
  rebind: { commandId: string; chord: string }[]
  reset: string[]
  appKeys: string
} {
  const registryWanted: Record<string, string> = {}
  const app: Overrides = {}
  for (const [local, keyString] of Object.entries(wanted)) {
    const bridleId = ids.bridleIdOfKeymapId(local)
    if (bridleId && keyString === '') registryWanted[bridleId] = ''
    else if (bridleId && isRegistryChord(keyString)) registryWanted[bridleId] = chordFromKeyString(keyString.trim())
    else app[local] = keyString
  }
  const rebind = Object.entries(registryWanted).filter(([id, chord]) => currentKeys[id] !== chord).map(([commandId, chord]) => ({ commandId, chord }))
  const reset = Object.keys(currentKeys).filter((id) => ids.keymapIdOf(id) !== null && !Object.hasOwn(registryWanted, id))
  return { rebind, reset, appKeys: Object.keys(app).length ? canonical(app) : '' }
}
