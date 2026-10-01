// What a new talk in a vault starts with (several-vaults ticket 04; architecture.md, "Defaults").
// One pure resolver, in this order:
//   1. the vault file — affiliation, style and logo (shared with everyone who opens the vault);
//   2. this person's settings for the vault — author (Edit this vault › Just for me);
//   3. the app's Presenter identity and deck defaults (Settings) — everything else, and any of the
//      above the vault leaves blank.
// The result feeds applyMetadataDefaults(fill-missing), so nothing already in a talk is replaced.
//
// "Style" in the vault file is the deck's `palette` (the accent cycle the compiler honours); its
// choices are the registry's palette options, with '' shown as "TalkWeaver default".
// The vault file's logo is vault-relative; a talk's `logo` resolves from the talk's own folder, so
// the resolver rewrites it relative to the new talk's folder.
import { METADATA_REGISTRY } from './metadata-registry.ts'

export type DefaultSource = 'vault' | 'personal' | 'app'

/** The frontmatter key the vault file's `style` fills. */
export const VAULT_STYLE_KEY = 'palette'

export type VaultDefaultsInput = {
  /** The vault file's shared values (absent or blank = not set). */
  vaultFile?: { affiliation?: unknown; style?: unknown; logo?: unknown } | null
  /** This person's settings for the vault. */
  personal?: { author?: unknown } | null
  /** Settings › Presenter identity and deck defaults (already normalised). */
  app?: Record<string, string> | null
  /** The new talk's folder, vault-relative with '/' ('' = the vault root). Without it the logo is
   *  left vault-relative. */
  talkFolderRel?: string
}

export type VaultDefaults = {
  defaults: Record<string, string>
  sources: Record<string, DefaultSource>
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** A path that can only name something inside the vault: relative, no '..' segment, no leading '/'
 *  or '\\', no drive letter, no scheme, no backslash, no NUL. A vault file's logo that fails this
 *  is treated as unset wherever it is read. */
export function isSafeVaultRelativePath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v || v.includes('\0') || v.includes('\\')) return false
  if (v.startsWith('/') || v.startsWith('~') || /^[a-zA-Z]:/.test(v) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return false
  return v.split('/').every((segment) => segment !== '..')
}

/** posix relative path from folder `from` to `to` (both vault-relative, '/'-separated). */
export function relativeWithinVault(from: string, to: string): string {
  const a = from.split('/').filter((p) => p && p !== '.')
  const b = to.split('/').filter((p) => p && p !== '.')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

export function resolveNewTalkDefaults(input: VaultDefaultsInput): VaultDefaults {
  const defaults: Record<string, string> = {}
  const sources: Record<string, DefaultSource> = {}
  for (const [key, value] of Object.entries(input.app ?? {})) {
    const v = text(value)
    if (v) { defaults[key] = v; sources[key] = 'app' }
  }
  const author = text(input.personal?.author)
  if (author) { defaults.author = author; sources.author = 'personal' }
  const file = input.vaultFile ?? {}
  const affiliation = text(file.affiliation)
  if (affiliation) { defaults.affiliation = affiliation; sources.affiliation = 'vault' }
  const style = text(file.style)
  if (style) { defaults[VAULT_STYLE_KEY] = style; sources[VAULT_STYLE_KEY] = 'vault' }
  const logo = isSafeVaultRelativePath(file.logo) ? text(file.logo) : ''
  if (logo) {
    defaults.logo = input.talkFolderRel === undefined ? logo : relativeWithinVault(input.talkFolderRel, logo)
    sources.logo = 'vault'
  }
  return { defaults, sources }
}

/** The Style menu in Edit this vault: the registry's palette choices. */
export function vaultStyleOptions(): Array<{ value: string; label: string }> {
  const entry = METADATA_REGISTRY.find((candidate) => candidate.key === VAULT_STYLE_KEY)
  const vocab = entry?.vocabulary as { kind?: string; options?: Array<{ value: string; label: string }> } | undefined
  const options = vocab?.kind === 'closed' && Array.isArray(vocab.options) ? vocab.options : [{ value: '', label: 'Default' }]
  return options.map((o) => ({ value: o.value, label: o.value === '' ? 'TalkWeaver default' : o.label }))
}

/** The label for a stored style value (an unknown value is shown as written). */
export function vaultStyleLabel(value: string | undefined | null): string {
  const v = text(value)
  return vaultStyleOptions().find((o) => o.value === v)?.label ?? v
}
