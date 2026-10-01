// What the Talks panel knows about a vault (several-vaults ticket 03): the registry's entry plus a
// name, a badge (colour and initial) and a service label. Ticket 04: the name and the shared mark
// come from the vault file when there is one (else the folder's name, private); the badge colour and
// initial are this person's own choice when set (else a palette colour by order and the name's first
// letter). The service label looks only at where the folder lives.
import { basename, join, dirname, relative, sep, isAbsolute } from 'node:path'
import type { Vault, VaultPersonal } from './vault-registry'
import { fileShared, fileText, type VaultFileRead } from './vault-file.ts'
import type { VaultUnavailable } from './vault-availability.ts'

export type VaultService = 'OneDrive' | 'Dropbox' | 'Google Drive' | 'Git' | 'Local'

export type VaultView = {
  id: string
  /** Absolute folder. The panel uses it to place talks in folders; it never shows it. */
  root: string
  open: boolean
  order: number
  /** What every surface calls the vault: its name, and `Name · Service` when another vault has the
   *  same name (LOCKED-sidebar frame 3g). */
  name: string
  /** The vault's own name, without any service suffix (what Edit this vault edits). */
  baseName: string
  initial: string
  color: string
  service: VaultService
  /** From the vault file: others can open it (people mark) or not (padlock). */
  shared: boolean
  /** The vault file exists (else a plain folder: the file is written on first Save). */
  hasFile: boolean
  /** Who set the vault up (vault file `created_by`), when known. */
  createdBy: string | null
  /** Closed because it carries the vault id of this other vault (the duplicate state). */
  duplicateOf: { id: string; name: string } | null
  /** The folder is missing or unreadable right now (ticket 07). It stays in the list, lists no talks. */
  unavailable: VaultUnavailable | null
}

/** What the view needs beyond the registry entry; both optional (a vault with neither is a plain
 *  folder with default badge). */
export type VaultExtras = {
  file?: VaultFileRead | null
  /** The name to use when there is no vault file to read (an unavailable vault's last-seen name). */
  name?: string
  personal?: VaultPersonal
  duplicateOf?: { id: string; name: string } | null
  unavailable?: VaultUnavailable | null
  service?: VaultService
}

/** Default badge colours, taken in vault order, and the swatches Edit this vault offers (the LOCKED
 *  edit-vault sheet's six). */
export const VAULT_PALETTE = ['#c2410c', '#0b3a6b', '#6d28d9', '#0f766e', '#be185d', '#4d5b6b'] as const

export type ServiceProbe = {
  home: string
  exists: (path: string) => boolean
  /** Symlink-resolved path, so a link into a cloud folder still reads as that service. */
  realpath?: (path: string) => string
}

/** Where a vault folder lives: OneDrive, Dropbox or Google Drive by folder; else Git when a `.git`
 *  sits at the vault root or in a folder above it (below the home folder); else Local. */
export function serviceFor(root: string, probe: ServiceProbe): VaultService {
  const candidates = [root]
  try {
    const real = probe.realpath?.(root)
    if (real && real !== root) candidates.push(real)
  } catch { /* an unreadable folder is classified by its plain path */ }
  for (const candidate of candidates) {
    const fromHome = isAbsolute(candidate) ? relative(probe.home, candidate).split(sep) : []
    const insideHome = fromHome[0] !== '..' && fromHome[0] !== ''
    const cloud = insideHome && fromHome[0] === 'Library' && fromHome[1] === 'CloudStorage' ? fromHome[2] ?? '' : ''
    if (/^OneDrive/i.test(cloud)) return 'OneDrive'
    if (/^Dropbox/i.test(cloud)) return 'Dropbox'
    if (/^GoogleDrive/i.test(cloud)) return 'Google Drive'
    if (insideHome && fromHome[0] === 'Dropbox') return 'Dropbox'
    if (insideHome && (fromHome[0] === 'Google Drive' || fromHome[0] === 'My Drive')) return 'Google Drive'
    if (insideHome && /^OneDrive( - .*)?$/i.test(fromHome[0])) return 'OneDrive'
  }
  for (const candidate of candidates) {
    let dir = candidate
    for (let i = 0; i < 12; i += 1) {
      if (probe.exists(join(dir, '.git'))) return 'Git'
      const up = dirname(dir)
      if (up === dir || dir === probe.home) break
      dir = up
    }
  }
  return 'Local'
}

export function vaultName(root: string): string {
  return basename(root.replace(/[\\/]+$/, '')) || root
}

export function vaultInitial(name: string): string {
  const first = [...name.trim()][0]
  return first ? first.toUpperCase() : '?'
}

export function viewVaults(vaults: Vault[], probe: ServiceProbe, extras: (v: Vault) => VaultExtras = () => ({})): VaultView[] {
  const views: VaultView[] = [...vaults]
    .sort((a, b) => a.order - b.order)
    .map((v, i) => {
      const { file, name: keptName, personal, duplicateOf, unavailable, service } = extras(v)
      const f = file && file.state === 'ok' ? file.file : null
      const name = fileText(f, 'name') || keptName?.trim() || vaultName(v.root)
      return {
        id: v.id,
        root: v.root,
        open: v.open,
        order: v.order,
        name,
        baseName: name,
        initial: personal?.badgeInitial || vaultInitial(name),
        color: personal?.badgeColour || VAULT_PALETTE[i % VAULT_PALETTE.length],
        service: service ?? serviceFor(v.root, probe),
        shared: fileShared(f),
        hasFile: !!f,
        createdBy: fileText(f, 'created_by') || null,
        duplicateOf: duplicateOf ?? null,
        unavailable: unavailable ?? null
      }
    })
  return withDisplayNames(views)
}

/** Two vaults with one name show `Name · Service` (Workshops · OneDrive, Workshops · Git) wherever a
 *  vault name appears; a vault with a name of its own keeps it. Names compare without case. Two with
 *  one name AND one service add a folder name as well (`Workshops · OneDrive · Teaching`): the
 *  nearest folder name, walking up from the vault folder, that tells them apart (never a path). A
 *  duplicate-vault note names the first vault by the same label. */
export function withDisplayNames<T extends { id?: string; root?: string; name: string; baseName: string; service: string; duplicateOf?: { id: string; name: string } | null }>(views: T[]): T[] {
  const groups = new Map<string, T[]>()
  const key = (v: T): string => v.baseName.trim().toLowerCase()
  for (const v of views) groups.set(key(v), [...(groups.get(key(v)) ?? []), v])
  const labelled = views.map((v) => {
    const group = groups.get(key(v)) ?? []
    if (group.length < 2) return { ...v, name: v.baseName }
    const sameService = group.filter((o) => o.service === v.service)
    const extra = sameService.length > 1 ? folderTell(v, sameService) : ''
    return { ...v, name: `${v.baseName} · ${v.service}${extra ? ` · ${extra}` : ''}` }
  })
  const byId = new Map(labelled.filter((v) => v.id).map((v) => [v.id as string, v.name]))
  return labelled.map((v) => (v.duplicateOf && byId.has(v.duplicateOf.id) ? { ...v, duplicateOf: { ...v.duplicateOf, name: byId.get(v.duplicateOf.id)! } } : v))
}

/** The folder name that tells v apart from the others: the vault folder's own name, else its parent's,
 *  and so on (four levels); else its place in the list (2, 3, …). */
function folderTell<T extends { root?: string }>(v: T, group: T[]): string {
  const parts = (r: string | undefined): string[] => String(r ?? '').split(/[\\/]+/).filter(Boolean).reverse()
  for (let level = 0; level < 4; level += 1) {
    const names = group.map((o) => parts(o.root)[level] ?? '')
    if (names.every((n) => n) && new Set(names.map((n) => n.toLowerCase())).size === names.length) return parts(v.root)[level]
  }
  return String(group.indexOf(v) + 1)
}

export type AddVaultOutcome =
  | { ok: true; vault: VaultView }
  | {
    ok: false
    reason: 'not-a-folder' | 'duplicate' | 'inside-another' | 'contains-another' | 'not-absolute' | 'unknown-vault' | 'last-open'
      | 'duplicate-id' | 'has-vault-file' | 'unreadable-file' | 'newer-schema' | 'id-mismatch' | 'config-unwritable'
      | 'no-name' | 'absolute-path' | 'logo-outside' | 'too-long' | 'outside-vault' | 'expired' | 'write-failed' | 'not-an-image' | 'logo-missing' | 'partial-write' | 'vault-unavailable'
    message: string
    /** The vault the refusal is about (already open, or the one this folder sits inside / copies). */
    other?: { id: string; name: string; initial: string; color: string; service: VaultService } | null
  }

/** The sentence shown for a registry refusal. It names the other vault, never a folder path. */
export function refusalMessage(reason: string, otherName: string | null): string {
  switch (reason) {
    case 'duplicate': return otherName ? `That folder is already a vault (${otherName}).` : 'That folder is already a vault.'
    case 'inside-another': return otherName ? `That folder is inside another vault (${otherName}). Add the outer vault instead.` : 'That folder is inside another vault.'
    case 'contains-another': return otherName ? `That folder contains another vault (${otherName}). Close or remove it first.` : 'That folder contains another vault.'
    case 'not-a-folder': return 'Choose a folder.'
    case 'not-absolute': return 'Choose a folder.'
    case 'unknown-vault': return 'That vault is not in the list any more.'
    case 'last-open': return 'Keep at least one vault open.'
    case 'duplicate-id': return otherName ? `This folder is a copy of a vault you already have (${otherName}). Nothing was added.` : 'This folder is a copy of a vault you already have.'
    case 'has-vault-file': return 'This folder is already a vault. Choose it again to open it.'
    case 'unreadable-file': return 'This folder has a vault file TalkWeaver cannot read. Nothing was changed.'
    case 'newer-schema': return 'This vault was set up by a newer TalkWeaver. Update TalkWeaver to change it.'
    case 'id-mismatch': return 'This folder now holds another vault’s file. Nothing was changed.'
    case 'config-unwritable': return 'TalkWeaver cannot save its settings right now. Nothing was changed.'
    case 'expired': return 'Choose the folder again.'
    default: return 'Could not add that folder.'
  }
}
