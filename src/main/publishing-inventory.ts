// Preservation contract: talkweaver-handouts/docs/specs/specification-handouts-publication-preservation-2026-10-31.md.
// Vendored read-only query follows the standalone writer's exact request, parser and size limits.
import { CLOUDFLARE_API_BASE, queryProductionInventory } from './observation/cloudflare-inventory.ts'
import type { PublishAuthorisation } from './cloudflare-connection.ts'
import { PreservationRefusal, type PreservationInventory } from './publication-preservation.ts'

/**
 * `standIn`: the stand-in API's loopback address, which index.ts passes only when `standInApiBase` allows it
 * (an unpackaged app started with TW_E2E=1), so the check asks the same API as the rest of publishing.
 * Null (a packaged build, or any ordinary run) keeps the check on Cloudflare's own address.
 */
/** The "revision" of a site that has no production deployment yet: what the check before upload and the check just before launch compare. */
export const NO_PRODUCTION_REVISION = 'no-production-deployment'

/**
 * A site Cloudflare says, for this very project, has no production deployment (a site just made, never published to) has nothing
 * to lose: its complete inventory is empty and the publish goes ahead. Only that explicit answer counts. Cloudflare unreachable, a
 * refusal, a project that is not found, a reply that does not read, or a reply that merely lacks the field is still `null`, and
 * the publish is refused (PUBLISH_INVENTORY_UNAVAILABLE). If a deployment appears between the two reads, the revision differs and the
 * publish is refused as changed.
 */
export async function readPublishingInventory(authorisation: PublishAuthorisation, standIn: string | null = null): Promise<PreservationInventory | null> {
  try {
    const read = await authorisation.run(credentials => queryProductionInventory({
      fetch, apiBase: standIn ?? CLOUDFLARE_API_BASE, allowLoopbackForTests: standIn !== null, token: credentials.CLOUDFLARE_API_TOKEN,
      accountId: authorisation.accountId, projectName: authorisation.project,
      clock: Date.now, deadlineAt: Date.now() + 45_000,
    }))
    if (read.superseded) return null
    if (read.result.outcome === 'incomplete' && read.result.noProductionDeployment === true) {
      return { complete: true, site: `cf-pages:${authorisation.accountId}:${authorisation.project}`, revision: NO_PRODUCTION_REVISION, paths: [] }
    }
    if (read.result.outcome === 'incomplete' && read.result.unsupportedPath) throw new PreservationRefusal('PUBLISH_INVENTORY_UNAVAILABLE', read.result.unsupportedPath)
    if (read.result.outcome !== 'complete') return null
    return { complete: true, site: `cf-pages:${authorisation.accountId}:${authorisation.project}`,
      revision: read.result.production.deploymentId, candidateDigest: read.result.production.candidateDigest, paths: read.result.files.map(([path]) => path) }
  } catch (error) { if (error instanceof PreservationRefusal) throw error; return null }
}
