// The editor keymap's overrides kept in the settings store (0.42; split rule in
// src/shared/keymap-overrides.ts). Main is the one writer: the renderer's keymap store asks for the
// overrides, sends a whole new set, and once moves what it kept in localStorage before 0.42.
//
// No Electron import: scripts/test-shared-settings.mjs drives it with a real store in a temporary folder.
import { KEYMAP_SETTING, isEditorKeyString, overridesFromStore, parseAppKeys, storeWritesFor, type KeymapIds, type Overrides } from '../shared/keymap-overrides.ts'

type Result = { ok: true } | { ok: false; error: string; code?: string }

/**
 * A write that did not reach the file: worth trying again. The file locked by another process, the
 * store closed, or the store refusing the file itself (Sol review 2, #9: a newer version's file,
 * another app's, a link, a damaged file not set aside, one too large) rather than one value.
 */
const unwritten = (r: Result): boolean => !r.ok && (r.code === 'locked' || r.code === 'closed' || r.code === 'unwritten' || r.code === 'refused' || r.code === 'too-large')

export interface KeymapStore {
  view(): { settings: Readonly<Record<string, unknown>>; keys: Readonly<Record<string, string>> }
  set(key: string, value: unknown): Promise<Result>
  reset(target: string | { commandId: string }): Promise<Result>
  rebindMany(pairs: { commandId: string; chord: string }[]): Promise<Result>
  /** Why the store may not be used (SettingsStore.problem): while it answers, nothing is written. */
  problem?(): unknown
}

const MAX_ENTRIES = 500
const MAX_TEXT = 100

/** The renderer's overrides, or null when they are not { short id: CodeMirror key or '' } (Sol review 1, #7: a key CodeMirror cannot parse is refused). */
export function overridesArg(value: unknown): Overrides | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) return null
  const out: Overrides = {}
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || k.length === 0 || k.length > MAX_TEXT || v.length > MAX_TEXT) return null
    if (v !== '' && !isEditorKeyString(v)) return null
    out[k] = v
  }
  return out
}

/**
 * The overrides an earlier version kept in localStorage, read leniently: an entry that is not a key
 * is left out rather than refusing the rest. Null when the value is not an object at all.
 */
export function legacyOverridesArg(value: unknown): Overrides | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Overrides = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
    if (typeof v !== 'string' || k.length === 0 || k.length > MAX_TEXT || v.length > MAX_TEXT) continue
    if (v === '' || isEditorKeyString(v)) out[k] = v
  }
  return out
}

/**
 * What became of the localStorage overrides (Sol review 1, #9): `consumed` when the store holds them
 * now, or held overrides of its own already (the old copy may go); `retry` when they could not be
 * written (the settings file locked, the store not open, the store refusing its file): the renderer keeps its copy for next time.
 */
export type LegacyMove = { outcome: 'consumed' | 'retry'; overrides: Overrides }

export interface SettingsKeymap {
  overrides(): Overrides
  /** Makes `wanted` the overrides; answers with what the store holds afterwards. */
  set(wanted: Overrides): Promise<{ ok: boolean; landed: boolean; overrides: Overrides }>
  /** The overrides the renderer kept before 0.42, moved once: only when `alreadyMoved()` is false and the store holds none. */
  moveLegacy(legacy: Overrides, alreadyMoved: () => boolean, markMoved: () => void): Promise<LegacyMove>
  /**
   * The registry's shortcuts changed (the Settings window's Shortcuts page, a reset, an import, the
   * CLI): a command whose registry shortcut changed loses its app-layer key, so a reset shows the
   * default and never an older bare key hidden under the override (Sol review 1, #5). Changes made
   * by `set` itself are left alone: it writes both layers together.
   */
  registryChanged(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): Promise<void>
}

export function createSettingsKeymap(store: KeymapStore, ids: KeymapIds): SettingsKeymap {
  let writing = 0
  const overrides = (): Overrides => {
    const v = store.view()
    return overridesFromStore(v.keys, v.settings[KEYMAP_SETTING], ids)
  }
  const set = async (wanted: Overrides): Promise<{ ok: boolean; landed: boolean; overrides: Overrides }> => {
    writing += 1
    try {
      const writes = storeWritesFor(wanted, store.view().keys, ids)
      let ok = true
      let landed = true
      const take = (r: Result): void => { if (!r.ok) ok = false; if (unwritten(r)) landed = false }
      if (writes.rebind.length) {
        const all = await store.rebindMany(writes.rebind)
        take(all)
        // One refused chord (a clash) refuses the whole batch: the others are tried one by one.
        if (!all.ok && !unwritten(all)) for (const pair of writes.rebind) take(await store.rebindMany([pair]))
      }
      for (const commandId of writes.reset) take(await store.reset({ commandId }))
      const current = store.view().settings[KEYMAP_SETTING]
      if ((typeof current === 'string' ? current : '') !== writes.appKeys) {
        take(writes.appKeys ? await store.set(KEYMAP_SETTING, writes.appKeys) : await store.reset(KEYMAP_SETTING))
      }
      return { ok, landed, overrides: overrides() }
    } finally {
      writing -= 1
    }
  }
  return {
    overrides,
    set,
    async moveLegacy(legacy, alreadyMoved, markMoved) {
      const mark = (): boolean => { try { markMoved(); return true } catch { return false } }
      // A store that may not be used holds nothing of the person's (Sol review 2, #9): the old copy is kept.
      const blocked = (): boolean => { try { return !!store.problem?.() } catch { return true } }
      if (blocked()) return { outcome: 'retry', overrides: overrides() }
      const v = store.view()
      const holds = Object.keys(v.keys).some((id) => ids.keymapIdOf(id) !== null) || Object.keys(parseAppKeys(v.settings[KEYMAP_SETTING])).length > 0
      if (alreadyMoved() || holds) {
        if (!alreadyMoved()) mark()
        return { outcome: 'consumed', overrides: overrides() }
      }
      const r = await set(legacy)
      // A write that did not reach the file is tried again at the next launch; a refused key is not.
      if (!r.landed || blocked()) return { outcome: 'retry', overrides: r.overrides }
      mark() // not marked (config.json unwritable): the store holds them, so the next launch finds them there
      return { outcome: 'consumed', overrides: r.overrides }
    },
    async registryChanged(before, after) {
      if (writing > 0) return
      const touched = new Set<string>()
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[id] === after[id]) continue
        const local = ids.keymapIdOf(id)
        if (local) touched.add(local)
      }
      if (touched.size === 0) return
      const app = parseAppKeys(store.view().settings[KEYMAP_SETTING])
      const left = Object.fromEntries(Object.entries(app).filter(([local]) => !touched.has(local)))
      if (Object.keys(left).length === Object.keys(app).length) return
      const text = Object.keys(left).length ? JSON.stringify(Object.fromEntries(Object.entries(left).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))) : ''
      try { await (text ? store.set(KEYMAP_SETTING, text) : store.reset(KEYMAP_SETTING)) } catch { /* the next change tries again */ }
    }
  }
}
