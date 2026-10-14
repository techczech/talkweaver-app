// The one image search seam TalkWeaver's main process calls (ticket 10). It asks SlideWell's store
// first and falls back to the old-PowerPoint archive alone, per call:
//   - SlideWell's store on disk and readable  → provider 'slidewell' (which includes the archive)
//   - otherwise                               → provider 'archive', today's search exactly
// The ⌘⇧I palette keeps its old wire shape through paletteSearch; the drawer (ticket 11) uses
// search() and the full hit.

import type { ImageSearchHit, ImageSearchResult, ImageSearchStatus } from '../../shared/image-search.ts'
import type { ArchiveProvider } from './archive-provider.ts'
import type { ImageFile, ImageSearchProvider, SearchOptions } from './provider.ts'

/** The palette's hit shape (preload ArchiveImageHit), unchanged since before the seam. */
export type PaletteHit = {
  assetKey: string
  presentationId: string
  relPath: string
  sha256?: string
  ocrText: string
  thumbUrl: string
  deckTitle?: string
}

export interface ImageSearch {
  status(): Promise<ImageSearchStatus>
  search(query: string, opts?: SearchOptions): Promise<ImageSearchResult | null>
  /** The file behind a thumbUrl a search returned, with its provenance; null when refused. */
  fileFor(thumbUrl: string): Promise<ImageFile | null>
  /** The palette's search: today's archive hits unchanged; SlideWell hits in the same shape. */
  paletteSearch(query: string): Promise<PaletteHit[] | null>
}

/** One hit in the palette's shape. Archive hits map back field for field to what the palette always got. */
export function toPaletteHit(hit: ImageSearchHit): PaletteHit {
  if (hit.archive) {
    // The palette's caption field keeps its historical name (the preload type predates the seam).
    return {
      assetKey: hit.archive.sha256,
      presentationId: hit.archive.presentationId,
      relPath: hit.archive.relPath,
      sha256: hit.archive.sha256,
      ocrText: hit.ocrText,
      thumbUrl: hit.thumbUrl,
      deckTitle: hit.presentationTitle
    }
  }
  const caption = [hit.title, hit.detail].filter(Boolean).join(' · ')
  return {
    assetKey: hit.key,
    presentationId: '',
    relPath: '',
    ocrText: hit.ocrText,
    thumbUrl: hit.thumbUrl,
    ...(caption ? { deckTitle: caption } : {})
  }
}

export function createImageSearch(providers: { slidewell: ImageSearchProvider | null; archive: ArchiveProvider }): ImageSearch {
  const { slidewell, archive } = providers

  const search = async (query: string, opts?: SearchOptions): Promise<ImageSearchResult | null> => {
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
      if (slidewell && (await slidewell.available().catch(() => false))) return { provider: 'slidewell' }
      if (await archive.available()) return { provider: 'archive' }
      return { provider: null }
    },
    search,
    async fileFor(thumbUrl) {
      return ((slidewell ? await slidewell.fileFor(thumbUrl).catch(() => null) : null) ?? (await archive.fileFor(thumbUrl).catch(() => null)))
    },
    async paletteSearch(query) {
      const res = await search(query)
      return res === null ? null : res.hits.map(toPaletteHit)
    }
  }
}
