// The one image search seam TalkWeaver's main process calls (ticket 10). It asks SlideWell's store
// first and falls back to the old-PowerPoint archive alone, per call:
//   - SlideWell's store on disk and readable  → provider 'slidewell' (which includes the archive)
//   - otherwise                               → provider 'archive', today's search exactly
// The drawer (ticket 11) uses search() and the full hit.

import type { ImageSearchResult, ImageSearchStatus } from '../../shared/image-search.ts'
import type { ArchiveProvider } from './archive-provider.ts'
import type { ImageFile, ImageSearchProvider, SearchOptions } from './provider.ts'

export interface ImageSearch {
  status(): Promise<ImageSearchStatus>
  search(query: string, opts?: SearchOptions): Promise<ImageSearchResult | null>
  /** The file behind a thumbUrl a search returned, with its provenance; null when refused. */
  fileFor(thumbUrl: string): Promise<ImageFile | null>
}

export function createImageSearch(providers: { slidewell: ImageSearchProvider | null; archive: ArchiveProvider }): ImageSearch {
  const { slidewell, archive } = providers

  // Old slides ride along with whichever provider answers: they come from the archive's own slide index.
  const withOldSlides = async (query: string, res: ImageSearchResult | null): Promise<ImageSearchResult | null> => {
    if (!res || !archive.slideHits) return res
    const slides = await archive.slideHits(query).catch(() => [])
    return slides.length ? { ...res, hits: [...res.hits, ...slides] } : res
  }

  const search = async (query: string, opts?: SearchOptions): Promise<ImageSearchResult | null> =>
    withOldSlides(query, await searchImages(query, opts))

  const searchImages = async (query: string, opts?: SearchOptions): Promise<ImageSearchResult | null> => {
    if (slidewell) {
      try {
        const res = await slidewell.search(query, opts)
        if (res) return res
      } catch (e) {
        console.error('[image-search] SlideWell provider failed; using the archive', e)
      }
    }
    return archive.search(query, opts)
  }

  return {
    async status() {
      const archiveThere = await archive.available().catch(() => false)
      if (slidewell && (await slidewell.available().catch(() => false))) return { provider: 'slidewell', archive: archiveThere }
      if (archiveThere) return { provider: 'archive', archive: true }
      return { provider: null, archive: false }
    },
    search,
    async fileFor(thumbUrl) {
      return ((slidewell ? await slidewell.fileFor(thumbUrl).catch(() => null) : null) ?? (await archive.fileFor(thumbUrl).catch(() => null)))
    }
  }
}
