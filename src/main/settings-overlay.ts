// config.json with the preferences laid over it. Main has always read its preferences from
// config.json (readConfig / getConfig / writeConfig in index.ts); since 0.40 they live in the
// settings store (userData/settings.json, @app-patterns/settings). This overlay keeps those readers and
// writers as they were:
//
//   read()   config.json as on disk, its own copies of preferences dropped, the store's values in
//            their place (non-defaults only: a missing key falls back to the reader's own default).
//   write()  the non-preference keys go to config.json; each preference goes to the store (set, or
//            reset when it is back at its default), through the lock and the changelog.
//
// Store writes are asynchronous and config.json writes were synchronous, so a write is visible to
// read() at once (pending) and committed when the store answers; a value the store refuses is
// dropped then and logged. The overlay is made only once the store is open (after the migration):
// nothing reads a preference before that, so startup sees one settings snapshot.
//
// No Electron import: scripts/test-shared-settings.mjs drives it with a fake store and file.
import { configWithSettings, isDefault, splitConfigPatch } from '../shared/settings-schema.ts'

type Bag = Record<string, unknown>
type Result = { ok: true } | { ok: false; error: string }

export interface OverlayStore {
  view(): { settings: Readonly<Bag> }
  set(key: string, value: unknown): Promise<Result>
  reset(key: string): Promise<Result>
}

export interface OverlayFile {
  read(): Bag
  write(patch: Bag): void
}

export interface ConfigOverlay {
  read(): Bag
  write(patch: Bag): void
  /** The store changed (from anywhere): the schema keys whose value changed. */
  storeChanged(settings: Readonly<Bag>): string[]
  /** Resolves when every queued preference write has been answered. */
  settled(): Promise<void>
  /** The preferences a write did not save (refused or failed) since the overlay was made, in order; each key once. */
  unsaved(): string[]
}

const nonDefaults = (settings: Readonly<Bag>): Bag => {
  const out: Bag = {}
  for (const [k, v] of Object.entries(settings)) if (!isDefault(k, v)) out[k] = v
  return out
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function createConfigOverlay(opts: { file: OverlayFile; store: OverlayStore; log?(line: string): void }): ConfigOverlay {
  const log = opts.log ?? ((line: string) => console.warn(line))
  const store = opts.store
  let committed: Bag = nonDefaults(store.view().settings)
  let chain: Promise<void> = Promise.resolve()
  let token = 0
  const notSaved = new Set<string>()
  /** Writes the store has not answered yet: key → the value (undefined: back to default). */
  const pending = new Map<string, { value: unknown; token: number }>()

  const values = (): Bag => {
    const out: Bag = { ...committed }
    for (const [k, p] of pending) {
      if (p.value === undefined || isDefault(k, p.value)) delete out[k]
      else out[k] = p.value
    }
    return out
  }

  return {
    read: () => configWithSettings(opts.file.read(), values()),
    write(patch) {
      const { settings, rest } = splitConfigPatch(patch)
      if (Object.keys(rest).length > 0) opts.file.write(rest)
      for (const [key, value] of Object.entries(settings)) {
        const mine = ++token
        pending.set(key, { value, token: mine })
        chain = chain.then(async () => {
          try {
            const r = value === undefined || isDefault(key, value) ? await store.reset(key) : await store.set(key, value)
            if (!r.ok) { notSaved.add(key); log(`[settings] ${key} was not saved: ${r.error}`) }
          } catch {
            notSaved.add(key)
            log(`[settings] ${key} was not saved`)
          }
          committed = nonDefaults(store.view().settings)
          if (pending.get(key)?.token === mine) pending.delete(key)
        })
      }
    },
    storeChanged(settings) {
      const before = values()
      committed = nonDefaults(settings)
      const after = values()
      const keys = new Set([...Object.keys(before), ...Object.keys(after)])
      return [...keys].filter((k) => !same(before[k], after[k]))
    },
    settled: () => chain,
    unsaved: () => [...notSaved]
  }
}
