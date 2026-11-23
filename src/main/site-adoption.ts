// Portable, non-secret evidence for a legacy site's first shared record. A person explicitly imports
// and approves it; a bare file inventory can never prove the old redirect/header text.
import { createHash } from 'node:crypto'
import { buildRedirects } from './publishing-logic.ts'
import { publicationBinding, type PreservationInventory } from './publication-preservation.ts'
import { manifestFolders, parseSiteRecord, type SiteRecord } from './site-record.ts'

export interface SiteRecoveryProof {
  format: 'talkweaver-site-recovery'
  version: 1
  site: string
  revision: string
  candidateDigest?: string
  record: SiteRecord
  controls: Record<string, string>
}

/** Parse without retaining arbitrary imported fields (in particular, never retain credentials). */
export function parseSiteRecoveryProof(text: string): SiteRecoveryProof | null {
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) return null
  try {
    const value = JSON.parse(text)
    if (value?.format !== 'talkweaver-site-recovery' || value.version !== 1 || typeof value.site !== 'string' || !/^cf-pages:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/u.test(value.site)
      || typeof value.revision !== 'string' || !value.revision || value.revision.length > 200) return null
    // The strict site parser enforces unique ids, safe folder names and bounded headers.
    const parsed = parseSiteRecord(JSON.stringify({ ...value.record, format: 'talkweaver-site-record', version: 1 }))
    if (!parsed.ok || !value.controls || typeof value.controls !== 'object' || Array.isArray(value.controls)) return null
    const entries = Object.entries(value.controls)
    if (entries.some(([name, digest]) => !['/_redirects', '/_headers'].includes(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) return null
    const candidateDigest = typeof value.candidateDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.candidateDigest) ? value.candidateDigest : undefined
    return { format: 'talkweaver-site-recovery', version: 1, site: value.site, revision: value.revision,
      ...(candidateDigest ? { candidateDigest } : {}), record: parsed.record, controls: Object.fromEntries(entries) as Record<string, string> }
  } catch { return null }
}

/** Bind the imported controls to this very site's production snapshot; a moved site needs a new preview. */
export function siteRecoveryRecord(proof: SiteRecoveryProof, inventory: PreservationInventory): SiteRecord | null {
  // Re-validate ports too: the real import parses once, but tests/other callers are not trust boundaries.
  const checked = parseSiteRecoveryProof(JSON.stringify(proof))
  if (!checked || checked.site !== inventory.site || checked.revision !== inventory.revision || !inventory.files
    || (checked.candidateDigest !== undefined && checked.candidateDigest !== inventory.candidateDigest)) return null
  const redirects = buildRedirects(checked.record.registry, manifestFolders(inventory.files.map(([path]) => path)))
  const digest = (name: string, text: string): string | undefined => text ? publicationBinding([[name, createHash('sha256').update(text).digest('hex')]]) : undefined
  if (digest('/_redirects', redirects) !== checked.controls['/_redirects'] || digest('/_headers', checked.record.headers) !== checked.controls['/_headers']) return null
  return checked.record
}
