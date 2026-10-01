// The owner's private record of where a cross-vault slide came from (several-vaults ticket 06):
// `userData/provenance.json`, keyed by `<targetVaultId>/<slideId>`. It holds the source talk's title
// and outline path, which must never be written into a vault (architecture.md invariant 1); the vault
// itself records only the source vault's id and name and the source slide id.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { PrivateProvenance, SlideOrigin } from './cross-vault-insert.ts'

export type ProvenanceFile = { schema: 1; entries: Record<string, PrivateProvenance> }

export function provenanceKey(targetVaultId: string, slideId: string): string {
  return `${targetVaultId}/${slideId}`
}

export function createProvenanceStore(filePath: string) {
  const read = (): ProvenanceFile => {
    try {
      if (!existsSync(filePath)) return { schema: 1, entries: {} }
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {}
      return { schema: 1, entries }
    } catch { return { schema: 1, entries: {} } }
  }
  return {
    /** Every record, read from disk once (a snapshot). */
    entries(): Record<string, PrivateProvenance> {
      return read().entries
    },
    get(targetVaultId: string, slideId: string): PrivateProvenance | null {
      const hit = read().entries[provenanceKey(targetVaultId, slideId)]
      return hit && typeof hit === 'object' ? hit : null
    },
    record(targetVaultId: string, slideId: string, entry: PrivateProvenance): void {
      const file = read()
      file.entries[provenanceKey(targetVaultId, slideId)] = entry
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
      renameSync(tmp, filePath)
    }
  }
}

/** The vault-safe origin rebuilt from a private record: source vault id and name, source slide id,
 *  who inserted it. The talk title and path stay behind. */
export function originFromPrivate(rec: PrivateProvenance | null): SlideOrigin | null {
  if (!rec || typeof rec.source_vault_id !== 'string' || !rec.source_vault_id) return null
  return {
    vault_id: rec.source_vault_id,
    vault_name: typeof rec.source_vault_name === 'string' ? rec.source_vault_name : '',
    slide_id: typeof rec.source_slide_id === 'string' ? rec.source_slide_id : '',
    ...(typeof rec.inserted_by === 'string' && rec.inserted_by.trim() ? { inserted_by: rec.inserted_by.trim() } : {})
  }
}

/**
 * The origin hints a save in one vault hands the slide ledger (read only for an id's FIRST record
 * there): the origin an insert promised in this session, else one rebuilt from this Mac's private
 * record — so a promised origin survives a refused save or a restart before the first save.
 */
export function originHintsFor(
  vaultId: string | null,
  pending: ReadonlyMap<string, SlideOrigin> | null | undefined,
  store: { entries(): Record<string, PrivateProvenance> }
): { get(id: string): SlideOrigin | null } {
  // provenance.json is read at most once per save (on the first id that needs it), not per id.
  let snapshot: Record<string, PrivateProvenance> | null = null
  return {
    get(id: string): SlideOrigin | null {
      const promised = pending?.get(id)
      if (promised) return promised
      if (!vaultId) return null
      try {
        snapshot ??= store.entries()
        const hit = snapshot[provenanceKey(vaultId, id)]
        return originFromPrivate(hit && typeof hit === 'object' ? hit : null)
      } catch { return null }
    }
  }
}
