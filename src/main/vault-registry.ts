// Vault registry (several-vaults ticket 01; design: docs/design/2026-09-29-multi-vault/architecture.md,
// "The seam"). The ONE main-process owner of which folders are vaults. Everything else asks it for a
// root; nothing else reads `vaultRoot` from config.json.
//
// Stored in app config (never inside a vault folder):
//   vaults: [{ id, root, open, order }]
//   vaultRoot: kept as a mirror of the first open vault, so an older build (0.35 beta, 0.36 previews)
//              running on the same user-data dir still finds its vault. Never deleted.
//   vaultRootMirrored: the `vaultRoot` value this registry last wrote. When `vaultRoot` differs from
//              it, someone else (an older build, or a test harness writing a fresh config) chose a
//              vault root, and the registry adopts it as the first open vault.
//
// Invariants: roots never nest (add/setOpen refuse a root inside, or containing, another vault's
// root); ids are unique; the stored list is always ordered 0..n-1; reading is idempotent (migrating
// an already-migrated config changes nothing).
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { buildVaultFile, fileSchemaIsOurs, sameVaultFile, type VaultFile, type VaultFileFields, type VaultFileRead, type VaultFileStore } from './vault-file.ts'

export type Vault = { id: string; root: string; open: boolean; order: number }

/** The slice of config.json the registry owns. */
export type VaultConfigSlice = {
  vaultRoot?: string
  vaults?: Vault[]
  vaultRootMirrored?: string
  /** Personal per-vault settings (ticket 04), keyed by vault id. Never written into a vault. */
  vaultPersonal?: Record<string, VaultPersonal>
}

/** "Just for me" in Edit this vault: stays on this Mac, in app config, by vault id. */
export type VaultPersonal = { author?: string; badgeColour?: string; badgeInitial?: string }

export type VaultRefusalReason =
  | 'not-absolute' | 'duplicate' | 'inside-another' | 'contains-another' | 'unknown-vault'
  /** A second folder carries the vault file id of a vault already in the list (the duplicate state). */
  | 'duplicate-id'
  /** Create vault on a folder that already has a vault file (it should be joined instead). */
  | 'has-vault-file'
  /** The folder's vault file cannot be read; it is never overwritten. */
  | 'unreadable-file'
  /** The vault file was written by a newer TalkWeaver (schema above ours); it is never overwritten. */
  | 'newer-schema'
  /** The folder's vault file names another vault id than the registry's; it is never overwritten. */
  | 'id-mismatch'
  /** config.json cannot be written, so this vault's id is not stable yet (ticket 01 review). */
  | 'config-unwritable'
  /** Part of a change landed and part did not; the message says exactly what is left. */
  | 'partial-write'

export class VaultRefusal extends Error {
  readonly reason: VaultRefusalReason
  /** The existing vault the refusal is about (duplicate / nesting), when there is one. */
  readonly other: Vault | null
  constructor(reason: VaultRefusalReason, message: string, other: Vault | null = null) {
    super(message)
    this.name = 'VaultRefusal'
    this.reason = reason
    this.other = other
  }
}

export type ResolvedPath = { vault: Vault; rel: string }

export interface VaultRegistry {
  /** Every vault, open or closed, by order. */
  list(): Vault[]
  get(id: string): Vault | null
  /** The vault whose root contains absPath (open vaults win), and the vault-relative path with '/'
   *  separators ('' for the root itself). null when the path is in no vault. */
  resolve(absPath: string): ResolvedPath | null
  /** Add a folder as a new open vault at the end. Refuses duplicates and nested roots. A folder with a
   *  vault file joins with the file's id (refused as 'duplicate-id' when that id is already in the
   *  list). With `create`, a folder with no vault file gets one, written before config is. */
  add(root: string, opts?: { create?: { fields: Partial<VaultFileFields>; createdBy?: string } }): Vault
  /** What adding root would meet, without writing anything: the resolved folder and its vault file.
   *  Throws the same refusals as add. */
  probe(root: string): { root: string; file: VaultFileRead }
  /** The vault's file as it is on disk now (reading never writes). null for an unknown vault. */
  readFile(id: string): VaultFileRead | null
  /** Apply the shared fields to the vault's file and write it (creating it for a plain folder).
   *  Unknown keys kept; nothing written when nothing changed. Returns the file as stored. */
  saveFile(id: string, patch: Partial<VaultFileFields>, opts?: { createdBy?: string }): VaultFile
  /** Personal settings for the vault on this Mac ({} when none). */
  personal(id: string): VaultPersonal
  /** Merge personal settings (a blank value removes that setting). Returns what is stored. */
  setPersonal(id: string, patch: VaultPersonal): VaultPersonal
  /** The open vault this one was closed as a copy of, when load found both carrying one vault id
   *  (the duplicate state); null otherwise. */
  duplicateOf(id: string): Vault | null
  setOpen(id: string, open: boolean): Vault
  /** Called after every change the registry writes. Returns an unsubscribe function. */
  onChange(cb: (vaults: Vault[]) => void): () => void
  /** SHIM-ONLY: the first open vault, which the single-vault shims (vault:get-root and friends)
   *  answer with. Remove with the vault:get-root / set-root / choose-root shims. */
  primary(): Vault | null
  /** SHIM-ONLY (remove with the vault:set-root / choose-root shims): for vault:set-root / choose-root, make root the first open vault (reusing a vault with that
   *  root, else adding one) and close the previous first open vault. Nesting with a now-closed vault
   *  is allowed here; any open vault nesting with root is closed. */
  adoptRoot(root: string): Vault
}

export type VaultRegistryDeps = {
  read: () => VaultConfigSlice
  write: (patch: Partial<VaultConfigSlice>) => void
  newId?: () => string
  /** The vault file on disk. Without it the registry never looks inside a vault (ids come from config). */
  files?: VaultFileStore
  now?: () => Date
  /** Symlink-resolving path. `add` stores the resolved folder and refuses one whose resolved path equals,
   *  contains or sits inside an existing vault's resolved path. Unresolvable paths are used as given. */
  realpath?: (path: string) => string
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────

const norm = (p: string): string => {
  const r = resolve(p)
  return r.length > 1 && r.endsWith(sep) ? r.slice(0, -1) : r
}
const sameRoot = (a: string, b: string): boolean => norm(a) === norm(b)
/** True when child is strictly inside parent. */
const isInside = (child: string, parent: string): boolean => {
  const c = norm(child)
  const p = norm(parent)
  return c !== p && c.startsWith(p === sep ? p : p + sep)
}

function sanitize(raw: unknown): Vault[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Vault[] = []
  raw.forEach((v, i) => {
    if (!v || typeof v !== 'object') return
    const { id, root, open, order } = v as Partial<Vault>
    if (typeof id !== 'string' || !id || typeof root !== 'string' || !root || seen.has(id)) return
    seen.add(id)
    out.push({ id, root, open: open !== false, order: typeof order === 'number' && Number.isFinite(order) ? order : i })
  })
  return renumber(out)
}

function renumber(vaults: Vault[]): Vault[] {
  return [...vaults]
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.order - b.v.order || a.i - b.i)
    .map(({ v }, order) => ({ ...v, order }))
}

const firstOpen = (vaults: Vault[]): Vault | null => vaults.find((v) => v.open) ?? null

/** Personal settings as stored: author (trimmed, ≤ 120), a #rrggbb colour, one upper-case character. */
export function cleanPersonal(raw: unknown): VaultPersonal {
  const out: VaultPersonal = {}
  if (!raw || typeof raw !== 'object') return out
  const { author, badgeColour, badgeInitial } = raw as Record<string, unknown>
  if (typeof author === 'string' && author.trim()) out.author = author.trim().slice(0, 120)
  if (typeof badgeColour === 'string' && /^#[0-9a-fA-F]{6}$/.test(badgeColour.trim())) out.badgeColour = badgeColour.trim().toLowerCase()
  if (typeof badgeInitial === 'string') {
    const first = [...badgeInitial.trim()][0]
    if (first && /[\p{L}\p{N}]/u.test(first)) out.badgeInitial = first.toUpperCase()
  }
  return out
}

/** Make root the first open vault; close the previous first open vault and any open vault nesting
 *  with root. Returns the new list (renumbered) and the adopted vault. */
function adopt(vaults: Vault[], root: string, newId: () => string): { vaults: Vault[]; vault: Vault } {
  const previous = firstOpen(vaults)
  const existing = vaults.find((v) => sameRoot(v.root, root))
  const target: Vault = existing ? { ...existing, open: true, order: -1 } : { id: newId(), root, open: true, order: -1 }
  const rest = vaults
    .filter((v) => v.id !== target.id)
    .map((v) => {
      const nests = isInside(v.root, root) || isInside(root, v.root)
      const close = v.open && ((previous && v.id === previous.id) || nests)
      return close ? { ...v, open: false } : v
    })
  const next = renumber([target, ...rest])
  return { vaults: next, vault: next[0] }
}

/** Config migration (pure). A config with only `vaultRoot` becomes one open vault with a generated
 *  id; a `vaultRoot` changed since the registry last mirrored it is adopted; `vaultRoot` is then
 *  mirrored from the first open vault (left untouched when none is open — never deleted). Running
 *  it on its own output changes nothing. */
export function migrateVaultConfig(slice: VaultConfigSlice, newId: () => string = randomUUID): { slice: MigratedSlice; changed: boolean } {
  let vaults = sanitize(slice.vaults)
  const legacy = typeof slice.vaultRoot === 'string' && slice.vaultRoot.trim() ? slice.vaultRoot : undefined
  if (legacy !== undefined && legacy !== slice.vaultRootMirrored) vaults = adopt(vaults, legacy, newId).vaults
  const out = mirror(vaults, slice)
  const changed =
    JSON.stringify(out.vaults) !== JSON.stringify(slice.vaults ?? []) || // no vaults key and none to add: nothing to write
    out.vaultRoot !== slice.vaultRoot ||
    out.vaultRootMirrored !== slice.vaultRootMirrored
  return { slice: out, changed }
}

type MigratedSlice = Required<Pick<VaultConfigSlice, 'vaults'>> & Pick<VaultConfigSlice, 'vaultRoot' | 'vaultRootMirrored'>

/** With an open vault, vaultRoot (and its marker) mirror the first one. With none open, the stored
 *  vaultRoot / vaultRootMirrored are carried through exactly as stored — including a non-string or
 *  blank value — so a read never rewrites them and `changed` stays false. Undefined keys are left
 *  out, so a merging writer can never erase an existing vaultRoot. */
function mirror(vaults: Vault[], stored: VaultConfigSlice): MigratedSlice {
  const p = firstOpen(vaults)
  if (p) return { vaults, vaultRoot: p.root, vaultRootMirrored: p.root }
  const out: MigratedSlice = { vaults }
  if (stored.vaultRoot !== undefined) out.vaultRoot = stored.vaultRoot
  if (stored.vaultRootMirrored !== undefined) out.vaultRootMirrored = stored.vaultRootMirrored
  return out
}

function checkNesting(vaults: Vault[], root: string, ignoreId: string | null, onlyOpen: boolean, canon: (p: string) => string = (p) => p): void {
  const target = canon(root)
  for (const v of vaults) {
    if (v.id === ignoreId || (onlyOpen && !v.open)) continue
    const other = canon(v.root)
    if (sameRoot(other, target) || sameRoot(v.root, root)) throw new VaultRefusal('duplicate', `This folder is already a vault (${v.root}).`, v)
    if (isInside(target, other) || isInside(root, v.root)) throw new VaultRefusal('inside-another', `This folder is inside another vault (${v.root}).`, v)
    if (isInside(other, target) || isInside(v.root, root)) throw new VaultRefusal('contains-another', `This folder contains another vault (${v.root}).`, v)
  }
}

/** registry.resolve over a list already in hand (one config read for many paths): the vault whose
 *  root contains absPath (open vaults win, then the deepest root) and the '/'-separated relative path. */
export function resolveInVaults(vaults: Vault[], absPath: string): ResolvedPath | null {
  if (typeof absPath !== 'string' || !absPath || !isAbsolute(absPath)) return null
  const p = norm(absPath)
  const hits = vaults.filter((v) => p === norm(v.root) || isInside(p, v.root))
  if (!hits.length) return null
  hits.sort((a, b) => Number(b.open) - Number(a.open) || norm(b.root).length - norm(a.root).length)
  const vault = hits[0]
  return { vault: { ...vault }, rel: relative(norm(vault.root), p).split(sep).join('/') }
}

// ── The registry ──────────────────────────────────────────────────────────────────────────────

export function createVaultRegistry(deps: VaultRegistryDeps): VaultRegistry {
  const newId = deps.newId ?? randomUUID
  const canon = (p: string): string => { try { return deps.realpath ? deps.realpath(p) : p } catch { return p } }
  const listeners = new Set<(vaults: Vault[]) => void>()

  const emit = (vaults: Vault[]): void => {
    for (const cb of listeners) {
      try { cb(vaults.map((v) => ({ ...v }))) } catch { /* a listener never breaks the registry */ }
    }
  }
  // A migration whose write failed (read-only disk, disk full, no permission): served from memory
  // for as long as config.json still holds what it was migrated from, so ids stay stable and reads
  // never throw. The next mutation writes the whole slice, which retries it.
  let unwritten: { from: string; slice: MigratedSlice } | null = null
  let loggedWriteFailure = false
  const persist = (vaults: Vault[], stored: VaultConfigSlice): void => {
    deps.write(mirror(vaults, stored)) // a mutation's write failure reaches the caller
    unwritten = null
    emit(vaults)
  }
  /** Current list, migrating (and writing the migration) when config needs it. Never throws on a
   *  failed write. */
  const writeOrHold = (from: string, slice: MigratedSlice): void => {
    try {
      deps.write(slice)
      unwritten = null
    } catch (err) {
      if (!loggedWriteFailure) {
        loggedWriteFailure = true
        console.error('[vault-registry] could not save the vault list to config.json; using it from memory:', err)
      }
      unwritten = { from, slice }
    }
  }
  // Duplicate state (S5): two open vaults carrying one vault id. Checked once per config state (the
  // vault files of open vaults are read then); the later one is closed in config, never in the vault.
  let dupCheckedFrom: string | null = null
  const duplicates = new Map<string, string>() // closed copy's id → id of the vault it copies
  const closeDuplicates = (from: string, slice: MigratedSlice): MigratedSlice => {
    if (!deps.files || dupCheckedFrom === from) return slice
    dupCheckedFrom = from
    const seen = new Map<string, string>()
    const closing = new Set<string>()
    for (const v of slice.vaults) {
      if (!v.open) continue
      const read = deps.files.read(v.root)
      const key = read.state === 'ok' ? read.file.id : v.id
      const first = seen.get(key)
      if (first) { closing.add(v.id); duplicates.set(v.id, first) } else seen.set(key, v.id)
    }
    if (!closing.size) return slice
    const next = mirror(slice.vaults.map((v) => (closing.has(v.id) ? { ...v, open: false } : v)), slice)
    writeOrHold(from, next)
    if (!unwritten) dupCheckedFrom = JSON.stringify(deps.read() ?? {})
    emit(next.vaults)
    return next
  }
  const load = (): MigratedSlice => {
    const raw = deps.read() ?? {}
    const from = JSON.stringify(raw)
    if (unwritten && unwritten.from === from) return unwritten.slice
    const { slice, changed } = migrateVaultConfig(raw, newId)
    if (changed) {
      writeOrHold(from, slice)
      emit(slice.vaults)
    }
    return closeDuplicates(from, slice)
  }
  const copy = (v: Vault | null | undefined): Vault | null => (v ? { ...v } : null)
  const now = (): Date => (deps.now ? deps.now() : new Date())
  const readFileAt = (root: string): VaultFileRead => (deps.files ? deps.files.read(root) : { state: 'none' })
  /** An id taken from a migration config.json has not accepted yet is not stable: before anything is
   *  keyed by it (personal settings, a vault file), the migration must be written. */
  const ensureWritten = (): MigratedSlice => {
    const stored = load()
    if (!unwritten) return stored
    try {
      deps.write(unwritten.slice)
      unwritten = null
    } catch {
      throw new VaultRefusal('config-unwritable', 'TalkWeaver cannot save its settings right now, so this vault cannot be changed yet.')
    }
    return stored
  }
  const needVault = (vaults: Vault[], id: string): Vault => {
    const v = vaults.find((x) => x.id === id)
    if (!v) throw new VaultRefusal('unknown-vault', `No vault with id ${id}.`)
    return v
  }
  /** The vault file at root names an id another vault in the list already has (the duplicate state). */
  const duplicateOf = (vaults: Vault[], read: VaultFileRead, selfId: string | null): Vault | null => {
    if (read.state !== 'ok') return null
    return vaults.find((v) => v.id === read.file.id && v.id !== selfId) ?? null
  }
  const refuseDuplicateId = (other: Vault): never => {
    throw new VaultRefusal('duplicate-id', 'This folder is a copy of a vault that is already in the list.', other)
  }
  /** The stored map, copied into an object with no prototype, so no id (say '__proto__') reaches one. */
  const personalMap = (): Record<string, VaultPersonal> => {
    const raw = (deps.read() ?? {}).vaultPersonal
    const out = Object.create(null) as Record<string, VaultPersonal>
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) out[k] = v
    return out
  }

  return {
    list: () => load().vaults.map((v) => ({ ...v })),
    get: (id) => copy(load().vaults.find((v) => v.id === id)),
    primary: () => copy(firstOpen(load().vaults)),
    resolve: (absPath) => resolveInVaults(load().vaults, absPath),
    probe(root) {
      if (typeof root !== 'string' || !isAbsolute(root)) throw new VaultRefusal('not-absolute', 'A vault root must be an absolute folder path.')
      const { vaults } = load()
      const storedRoot = canon(root)
      checkNesting(vaults, storedRoot, null, false, canon)
      const file = readFileAt(storedRoot)
      const dup = duplicateOf(vaults, file, null)
      if (dup) refuseDuplicateId(dup)
      return { root: storedRoot, file }
    },
    add(root, opts) {
      if (typeof root !== 'string' || !isAbsolute(root)) throw new VaultRefusal('not-absolute', 'A vault root must be an absolute folder path.')
      // Create keys a vault file by a new id: the vault list must be writable first (S3).
      const stored = opts?.create ? ensureWritten() : load()
      const { vaults } = stored
      const storedRoot = canon(root)
      checkNesting(vaults, storedRoot, null, false, canon)
      const file = readFileAt(storedRoot)
      const dup = duplicateOf(vaults, file, null)
      if (dup) refuseDuplicateId(dup)
      let id: string
      let created: VaultFile | null = null
      if (file.state === 'invalid') throw new VaultRefusal('unreadable-file', 'This folder has a vault file TalkWeaver cannot read.')
      if (opts?.create) {
        if (file.state === 'ok') throw new VaultRefusal('has-vault-file', 'This folder is already a vault.')
        if (!deps.files) throw new VaultRefusal('unreadable-file', 'Vault files are not available here.')
        id = newId()
        // The file first: when it cannot be written, nothing is added.
        created = buildVaultFile(storedRoot, null, opts.create.fields, { id, createdBy: opts.create.createdBy, createdAt: now().toISOString() })
        deps.files.write(storedRoot, created)
      } else {
        id = file.state === 'ok' ? file.file.id : newId()
      }
      const vault: Vault = { id, root: storedRoot, open: true, order: vaults.length }
      const next = renumber([...vaults, vault])
      try {
        persist(next, stored)
      } catch (err) {
        if (!created || !deps.files) throw err
        // The vault file landed but the list did not: take back exactly what was written (S3).
        const removed = deps.files.removeIfUnchanged(storedRoot, created)
        throw new VaultRefusal('partial-write', removed
          ? 'TalkWeaver could not save its settings, so the vault was not added. The vault file it had just written was removed again.'
          : 'TalkWeaver could not save its settings, so the vault was not added. The vault file it had just written (.talkweaver/vault.json in that folder) was left in place because it has changed since.')
      }
      duplicates.delete(id)
      return { ...vault }
    },
    readFile(id) {
      const v = load().vaults.find((x) => x.id === id)
      return v ? readFileAt(v.root) : null
    },
    saveFile(id, patch, opts) {
      const { vaults } = ensureWritten()
      const vault = needVault(vaults, id)
      if (!deps.files) throw new VaultRefusal('unreadable-file', 'Vault files are not available here.')
      const current = deps.files.read(vault.root)
      if (current.state === 'invalid') throw new VaultRefusal('unreadable-file', 'This vault has a vault file TalkWeaver cannot read, so it is left as it is.')
      const existing = current.state === 'ok' ? current.file : null
      if (existing && !fileSchemaIsOurs(existing)) throw new VaultRefusal('newer-schema', 'This vault was set up by a newer TalkWeaver. Update TalkWeaver to change it.')
      if (existing && existing.id !== vault.id) throw new VaultRefusal('id-mismatch', 'This folder now holds another vault’s file, so it is left as it is.')
      const next = buildVaultFile(vault.root, existing, patch, { id: vault.id, createdBy: opts?.createdBy, createdAt: now().toISOString() })
      if (existing && sameVaultFile(existing, next)) return existing
      deps.files.write(vault.root, next)
      emit(vaults)
      return next
    },
    personal(id) {
      return cleanPersonal(personalMap()[id])
    },
    setPersonal(id, patch) {
      const { vaults } = ensureWritten()
      needVault(vaults, id)
      const map = personalMap()
      const merged: Record<string, unknown> = { ...cleanPersonal(map[id]) }
      for (const key of ['author', 'badgeColour', 'badgeInitial'] as const) {
        if (patch && key in patch) merged[key] = patch[key]
      }
      const clean = cleanPersonal(merged)
      const nextMap: Record<string, VaultPersonal> = { ...map }
      if (Object.keys(clean).length) nextMap[id] = clean
      else delete nextMap[id]
      if (JSON.stringify(nextMap) !== JSON.stringify(map)) {
        deps.write({ vaultPersonal: nextMap })
        emit(vaults)
      }
      return clean
    },
    setOpen(id, open) {
      const stored = load()
      const { vaults } = stored
      const target = vaults.find((v) => v.id === id)
      if (!target) throw new VaultRefusal('unknown-vault', `No vault with id ${id}.`)
      if (target.open === open) return { ...target }
      if (open) {
        checkNesting(vaults, target.root, id, true, canon)
        const dup = duplicateOf(vaults, readFileAt(target.root), id)
        if (dup) { duplicates.set(id, dup.id); refuseDuplicateId(dup) }
        duplicates.delete(id)
      }
      const next = vaults.map((v) => (v.id === id ? { ...v, open } : v))
      persist(next, stored)
      return { ...target, open }
    },
    adoptRoot(root) {
      if (typeof root !== 'string' || !isAbsolute(root)) throw new VaultRefusal('not-absolute', 'A vault root must be an absolute folder path.')
      const stored = load()
      const { vaults } = stored
      const { vaults: next, vault } = adopt(vaults, root, newId)
      if (JSON.stringify(next) !== JSON.stringify(vaults)) persist(next, stored)
      return { ...vault }
    },
    duplicateOf(id) {
      const firstId = duplicates.get(id)
      return firstId ? copy(load().vaults.find((v) => v.id === firstId)) : null
    },
    onChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    }
  }
}
