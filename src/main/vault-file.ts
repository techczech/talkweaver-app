// The vault file (several-vaults ticket 04; design: docs/design/2026-09-29-multi-vault/architecture.md,
// "Model"): `<root>/.talkweaver/vault.json`, the part of a vault's settings everyone who opens the
// folder shares. It travels with the folder (OneDrive, Dropbox, Git), so it is what two machines agree
// on: the vault's `id` (invariant 6), its name, whether it is shared, and the affiliation, style and
// logo new talks in it start with.
//
//   { "schema": 1, "id": "<uuid>", "name": "Oxford AICC", "shared": true,
//     "affiliation": "University of Oxford", "style": "green", "logo": "_assets/logos/oxford.svg",
//     "created_by": "Dominik Lukeš", "created_at": "2026-09-29T17:00:00.000Z" }
//
// Rules this module holds:
//   - Read never writes. The file is written only from Create vault and from Save in Edit this vault
//     (the registry's add-with-create and saveFile); never on upgrade, open or list.
//   - Unknown keys (a newer build's, a colleague's) are kept on write, in their place.
//   - Nothing in the file is an absolute path (invariant 1); `logo` is vault-relative with '/'
//     separators and must resolve inside the vault, symlinks included.
//   - The write is atomic (temp file + fsync + rename, via config-file.ts) and its target goes
//     through pathStaysInside(root, …): a `.talkweaver` that is a link out of the vault is refused.
import * as nodeFs from 'fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { createConfigFile, type ConfigFs } from './config-file.ts'
import { pathStaysInside } from './path-containment.ts'
import { isSafeVaultRelativePath } from '../shared/vault-defaults.ts'

export const VAULT_FILE_DIR = '.talkweaver'
export const VAULT_FILE_NAME = 'vault.json'
export const VAULT_FILE_SCHEMA = 1

/** The file as stored. Every key is kept verbatim (a newer build may store other types), except an
 *  unsafe `logo`, which reads as unset. Read the known fields through fileText / fileShared /
 *  fileSchemaIsOurs, never directly. */
export type VaultFile = {
  id: string
  schema?: unknown
  name?: unknown
  shared?: unknown
  affiliation?: unknown
  style?: unknown
  logo?: unknown
  created_by?: unknown
  created_at?: unknown
  [key: string]: unknown
}

/** A known text field ('' when absent or not a string). */
export function fileText(file: VaultFile | null | undefined, key: 'name' | 'affiliation' | 'style' | 'logo' | 'created_by' | 'created_at'): string {
  const v = file?.[key]
  return typeof v === 'string' ? v.trim() : ''
}
export function fileShared(file: VaultFile | null | undefined): boolean {
  return file?.shared === true
}
/** Schema absent or 1: ours to write. A number above 1, or any non-number, is a newer build's. */
export function fileSchemaIsOurs(file: VaultFile): boolean {
  return file.schema === undefined || file.schema === VAULT_FILE_SCHEMA
}

/** Vault ids this build accepts from a vault file. */
export const VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** A vault file larger than this is not read (H2). */
export const VAULT_FILE_MAX_BYTES = 1024 * 1024

/** The shared group of the Edit this vault sheet: what Save may change. */
export type VaultFileFields = {
  name: string
  shared: boolean
  affiliation: string
  style: string
  logo: string
}

export type VaultFileRead =
  | { state: 'none' }
  | { state: 'ok'; file: VaultFile }
  | { state: 'invalid'; reason: 'unreadable' | 'not-json' | 'no-id' | 'bad-id' | 'outside-vault' | 'too-large' }

export type VaultFileErrorReason = 'no-name' | 'absolute-path' | 'logo-outside' | 'too-long' | 'outside-vault' | 'not-an-image' | 'logo-missing' | 'vault-unavailable'

/** A vault-file write into a vault whose folder is missing (ticket 07): refused, nothing re-created. */
export const VAULT_UNAVAILABLE_MESSAGE = 'The vault’s folder is not there.'

export class VaultFileError extends Error {
  readonly reason: VaultFileErrorReason
  constructor(reason: VaultFileErrorReason, message: string) {
    super(message)
    this.name = 'VaultFileError'
    this.reason = reason
  }
}

/** Where a vault's file lives (never shown to the user). */
export function vaultFilePath(root: string): string {
  return join(root, VAULT_FILE_DIR, VAULT_FILE_NAME)
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────────────

const MAX_TEXT = 200

/** True for a string that reads as an absolute path on any platform: `/…`, `~/…`, `C:\…`, `\\server`. */
export function looksAbsolute(value: string): boolean {
  const v = value.trim()
  return v.startsWith('/') || v.startsWith('~') || v.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
}

/** Parse the text of a vault file. Anything but a JSON object with a non-empty string id is invalid. */
export function parseVaultFile(text: string): VaultFileRead {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { state: 'invalid', reason: 'not-json' } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'invalid', reason: 'not-json' }
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id) return { state: 'invalid', reason: 'no-id' }
  if (!VAULT_ID_PATTERN.test(obj.id)) return { state: 'invalid', reason: 'bad-id' }
  // Kept verbatim (a newer build's types included), into an object with no prototype to reach.
  const file = Object.assign(Object.create(null), obj) as VaultFile
  // A logo that could leave the vault (.., /, \, a drive letter, a scheme) reads as unset (S1).
  if (typeof file.logo === 'string' && file.logo.trim() && !isSafeVaultRelativePath(file.logo)) delete file.logo
  return { state: 'ok', file }
}

function cleanText(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.trim() : ''
  if (v.length > MAX_TEXT) throw new VaultFileError('too-long', `${label} is too long.`)
  if (v && looksAbsolute(v)) throw new VaultFileError('absolute-path', `${label} cannot be a folder path.`)
  return v
}

/** Check the text fields of a patch the way buildVaultFile will (name required when given), without
 *  the logo — so a Save that would be refused copies nothing into the vault first. */
export function validateVaultFields(patch: Partial<VaultFileFields>, requireName: boolean): void {
  if (patch.name !== undefined || requireName) {
    if (!cleanText(patch.name ?? '', 'The name')) throw new VaultFileError('no-name', 'A vault needs a name.')
  }
  cleanText(patch.affiliation ?? '', 'The affiliation')
  cleanText(patch.style ?? '', 'The style')
}

/** A logo as the vault file stores it: vault-relative, '/'-separated, inside the vault. Accepts a
 *  vault-relative path or an absolute path inside the root (the file picker's answer). '' = no logo.
 *  Throws VaultFileError('logo-outside') for anything that leaves the vault, lexically or through a
 *  link. */
export function vaultRelativeLogo(root: string, input: unknown): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  if (raw.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new VaultFileError('logo-outside', 'The logo must be a file inside this vault.')
  }
  const r = resolve(root)
  const candidate = isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) ? resolve(raw) : resolve(r, raw.split('/').join(sep))
  const lexical = relative(r, candidate)
  if (!lexical || lexical === '..' || lexical.startsWith('..' + sep) || isAbsolute(lexical)) {
    // An absolute pick may name the vault through a link (/var vs /private/var): judge it by real paths.
    const real = pathStaysInside(r, candidate)
    if (!real) throw new VaultFileError('logo-outside', 'The logo must be a file inside this vault.')
    let realRoot = r
    try { realRoot = nodeFs.realpathSync(r) } catch { /* judged lexically below */ }
    const rel = relative(realRoot, real)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new VaultFileError('logo-outside', 'The logo must be a file inside this vault.')
    return rel.split(sep).join('/')
  }
  if (!pathStaysInside(r, candidate)) throw new VaultFileError('logo-outside', 'The logo must be a file inside this vault.')
  return lexical.split(sep).join('/')
}

/**
 * The file Save (or Create) writes: `existing` with the shared fields from `patch` applied. Unknown
 * keys stay, in their place; a blank affiliation, style or logo removes that key; the name is
 * required. A new file (existing null) gets schema, id, created_by and created_at from `init`.
 * Throws VaultFileError when a value is not allowed (no name, a path, a logo outside the vault).
 */
export function buildVaultFile(
  root: string,
  existing: VaultFile | null,
  patch: Partial<VaultFileFields>,
  init: { id: string; createdBy?: string; createdAt: string }
): VaultFile {
  const base: VaultFile = existing
    ? { ...existing }
    : { schema: VAULT_FILE_SCHEMA, id: init.id, name: '', shared: false }
  // A value a newer build stored as another type is shown blank in the sheet; a blank that comes back
  // leaves it as it is (H4). Only a real value replaces it.
  const keepsOther = (key: string, value: string): boolean => !value && existing != null && key in existing && typeof existing[key] !== 'string' && typeof existing[key] !== 'undefined'
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, 'The name')
    if (!keepsOther('name', name)) base.name = name
  }
  if (typeof base.name === 'string' || base.name === undefined) {
    const name = typeof base.name === 'string' ? base.name : ''
    if (!name.trim()) throw new VaultFileError('no-name', 'A vault needs a name.')
    if (looksAbsolute(name)) throw new VaultFileError('absolute-path', 'The name cannot be a folder path.')
  }
  if (patch.shared !== undefined && (typeof base.shared === 'boolean' || base.shared === undefined || patch.shared === true)) base.shared = patch.shared === true
  const optional = (key: 'affiliation' | 'style', label: string): void => {
    if (patch[key] === undefined) return
    const v = cleanText(patch[key], label)
    if (keepsOther(key, v)) return
    if (v) base[key] = v
    else delete base[key]
  }
  optional('affiliation', 'The affiliation')
  optional('style', 'The style')
  if (patch.logo !== undefined) {
    const logo = vaultRelativeLogo(root, patch.logo)
    if (!keepsOther('logo', logo)) {
      if (logo) base.logo = logo
      else delete base.logo
    }
  }
  if (!existing) {
    const by = cleanText(init.createdBy ?? '', 'The author')
    if (by) base.created_by = by
    base.created_at = init.createdAt
  }
  return base
}

/** The bytes the store writes for a file (config-file.ts's format). */
export function vaultFileBytes(file: VaultFile): string {
  return JSON.stringify(file, null, 2)
}

/** Same content, key for key (order ignored). */
export function sameVaultFile(a: VaultFile, b: VaultFile): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false
  return true
}

// ── Logo from outside the vault ───────────────────────────────────────────────────────────────

/** The image types a title-slide logo may be (the compiler's MIME_TYPES in 08-source-adapters.mjs). */
export const LOGO_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'] as const
export const VAULT_LOGO_DIR = '_assets/logos'

export function isLogoFile(path: string): boolean {
  return (LOGO_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase())
}

/** `name.ext`, then `name 2.ext`, `name 3.ext`, … — the first not in `taken`. */
export function freeLogoName(fileName: string, taken: (name: string) => boolean): string {
  if (!taken(fileName)) return fileName
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} ${n}${ext}`
    if (!taken(candidate)) return candidate
  }
  throw new VaultFileError('outside-vault', 'Too many logos with that name in this vault.')
}

/**
 * Copy a logo chosen outside the vault into `<root>/_assets/logos/<basename>` (" 2", " 3"… on a name
 * clash; an existing file is never overwritten) and return its vault-relative path. Called only from
 * Save / Create. The folder and the target both go through pathStaysInside; the copy is exclusive
 * (fails rather than replace a file that appears meanwhile).
 */
export function copyLogoIntoVault(root: string, source: string, fs: Pick<typeof nodeFs, 'existsSync' | 'mkdirSync' | 'copyFileSync' | 'statSync'> = nodeFs): string {
  if (!isLogoFile(source)) throw new VaultFileError('not-an-image', 'A logo must be an SVG, PNG, JPEG, WebP or GIF image.')
  let isFile = false
  try { isFile = fs.statSync(source).isFile() } catch { /* missing */ }
  if (!isFile) throw new VaultFileError('logo-missing', 'That logo file is no longer there. Choose it again.')
  const dir = join(root, ...VAULT_LOGO_DIR.split('/'))
  if (!pathStaysInside(root, dir)) throw new VaultFileError('outside-vault', 'The logo would be copied outside the vault.')
  if (!fs.existsSync(root)) throw new VaultFileError('vault-unavailable', VAULT_UNAVAILABLE_MESSAGE) // never re-create a vault folder (ticket 07)
  fs.mkdirSync(dir, { recursive: true })
  if (!pathStaysInside(root, dir)) throw new VaultFileError('outside-vault', 'The logo would be copied outside the vault.')
  const name = freeLogoName(basename(source), (n) => fs.existsSync(join(dir, n)))
  const target = join(dir, name)
  if (!pathStaysInside(root, target)) throw new VaultFileError('outside-vault', 'The logo would be copied outside the vault.')
  fs.copyFileSync(source, target, nodeFs.constants.COPYFILE_EXCL)
  return `${VAULT_LOGO_DIR}/${name}`
}

// ── Disk ──────────────────────────────────────────────────────────────────────────────────────

export type VaultFileFs = ConfigFs

export interface VaultFileStore {
  read(root: string): VaultFileRead
  /** Atomic write of the whole file. Throws VaultFileError('outside-vault') when the target would
   *  leave the vault, or the fs error; the stored file is then unchanged. */
  write(root: string, file: VaultFile): void
  /** Undo a write this build just made: delete the file only while its bytes are exactly `file`'s
   *  (and the .talkweaver folder when that leaves it empty). True when the file is gone. */
  removeIfUnchanged(root: string, file: VaultFile): boolean
}

export function createVaultFileStore(fs: VaultFileFs = nodeFs): VaultFileStore {
  return {
    read(root) {
      const path = vaultFilePath(root)
      if (!fs.existsSync(path)) return { state: 'none' }
      if (!pathStaysInside(root, path)) return { state: 'invalid', reason: 'outside-vault' }
      try {
        if (fs.statSync(path).size > VAULT_FILE_MAX_BYTES) return { state: 'invalid', reason: 'too-large' }
      } catch { return { state: 'invalid', reason: 'unreadable' } }
      let text: string
      try { text = fs.readFileSync(path, 'utf8') as string } catch { return { state: 'invalid', reason: 'unreadable' } }
      return parseVaultFile(text)
    },
    write(root, file) {
      const target = vaultFilePath(root)
      const dir = join(root, VAULT_FILE_DIR)
      if (!pathStaysInside(root, dir) || !pathStaysInside(root, target)) {
        throw new VaultFileError('outside-vault', 'The vault file would be written outside the vault.')
      }
      const text = JSON.stringify(file)
      if (text.includes('\0')) throw new VaultFileError('absolute-path', 'The vault file holds a value it cannot store.')
      // Only into a vault folder that is there: a moved or signed-out vault is never re-created (ticket 07).
      if (!fs.existsSync(root)) throw new VaultFileError('vault-unavailable', VAULT_UNAVAILABLE_MESSAGE)
      createConfigFile<VaultFile>(target, fs).replace(file)
    },
    removeIfUnchanged(root, file) {
      const path = vaultFilePath(root)
      const dir = join(root, VAULT_FILE_DIR)
      if (!pathStaysInside(root, path)) return false
      try {
        if (!fs.existsSync(path)) return true
        if ((fs.readFileSync(path, 'utf8') as string) !== vaultFileBytes(file)) return false
        fs.unlinkSync(path)
      } catch { return false }
      try { if ((fs.readdirSync(dir) as string[]).length === 0) nodeFs.rmdirSync(dir) } catch { /* left in place */ }
      return true
    }
  }
}
