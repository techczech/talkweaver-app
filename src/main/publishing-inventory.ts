// Preservation contract: talkweaver-handouts/docs/specs/specification-handouts-publication-preservation-2026-10-31.md.
// Vendored read-only query follows the standalone writer's exact request, parser and size limits.
import { CLOUDFLARE_API_BASE, queryProductionInventory } from './observation/cloudflare-inventory.ts'
import type { PublishAuthorisation } from './cloudflare-connection.ts'
import { PreservationRefusal, type PreservationInventory } from './publication-preservation.ts'

export async function readPublishingInventory(authorisation: PublishAuthorisation): Promise<PreservationInventory | null> {
  try {
    const read = await authorisation.run(credentials => queryProductionInventory({
      fetch, apiBase: CLOUDFLARE_API_BASE, token: credentials.CLOUDFLARE_API_TOKEN,
      accountId: authorisation.accountId, projectName: authorisation.project,
      clock: Date.now, deadlineAt: Date.now() + 45_000,
    }))
    if (read.superseded) return null
    if (read.result.outcome === 'incomplete' && read.result.unsupportedPath) throw new PreservationRefusal('PUBLISH_INVENTORY_UNAVAILABLE', read.result.unsupportedPath)
    if (read.result.outcome !== 'complete') return null
    return { complete: true, site: `cf-pages:${authorisation.accountId}:${authorisation.project}`,
      revision: read.result.production.deploymentId, candidateDigest: read.result.production.candidateDigest, paths: read.result.files.map(([path]) => path) }
  } catch (error) { if (error instanceof PreservationRefusal) throw error; return null }
}
