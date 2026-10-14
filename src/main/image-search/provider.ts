// The image search seam (ticket 10): what every provider offers. Two providers implement it —
// SlideWell's shared store (slidewell-provider.ts) and the old-PowerPoint archive alone
// (archive-provider.ts) — and image-search.ts picks between them per call.

import type { ImageSearchProviderName, ImageSearchResult, MatchMode } from '../../shared/image-search.ts'

export type SearchOptions = { match?: MatchMode }

/** A file a provider will hand over for import, and the provenance the vault sidecar records. */
export type ImageFile = {
  absPath: string
  provenance: { source: string; note: string }
}

export interface ImageSearchProvider {
  readonly name: ImageSearchProviderName
  /** Can this provider search now (its store is on disk and sqlite3 is present)? */
  available(): Promise<boolean>
  /** Words and/or picture matches; [] for an empty query; null when the provider cannot search. */
  search(query: string, opts?: SearchOptions): Promise<ImageSearchResult | null>
  /** The file behind a thumbUrl this provider serves, or null when it refuses it. Read-only.
   *  Decided at request time (an item hidden since the search is refused), hence async. */
  fileFor(thumbUrl: string): Promise<ImageFile | null>
}
