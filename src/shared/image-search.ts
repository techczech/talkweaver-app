// The image search seam's wire shapes (ticket 10). One search, two providers behind it:
//   - SlideWell's shared store (read-only): screenshots, added images, talk images and
//     old-PowerPoint images, with app / window / date / used-in fields, and picture matches
//     ("meaning") when SlideWell's own process is running;
//   - the old-PowerPoint archive alone (today's OCR search), when SlideWell is absent.
// Pure types only, so main, preload and renderer share one definition.

/** Where an image comes from. 'old-slide' is a whole slide of an old PowerPoint (the Old slides tab). */
import type { OldSlideRecord } from './old-slide.ts'

export type ImageSource = 'screenshot' | 'added-image' | 'talk-image' | 'archive-image' | 'old-slide' | 'vault-image'

/** Words: text match only. Meaning: picture match only. Both: words first, then picture matches. */
export type MatchMode = 'words' | 'meaning' | 'both'

/** One talk that uses an image. slide is 1-based, 0 when SlideWell is not certain of it. */
export type ImageUse = { talkTitle: string; talkPath: string; slide: number }

export type ImageSearchHit = {
  /** Stable across searches: 'archive:<sha256>', 'well:<id>' or 'triage:<hash>'. */
  key: string
  source: ImageSource
  /** Renderable thumbnail URL; also the handle passed back to importImage. */
  thumbUrl: string
  /** Caption lines: title (window title, file name, presentation title) and detail (app · date). */
  title: string
  detail: string
  /** Recognised text in the picture ('' when none). */
  ocrText: string
  /** Which band found it and how strongly, 0..1 (words: share of the query words in its title). */
  match: 'words' | 'meaning'
  score: number
  usedIn: ImageUse[]
  app?: string
  windowTitle?: string
  /** YYYY-MM-DD when known. */
  date?: string
  /** Old-PowerPoint images: the presentation it came from (readable names only). */
  presentationTitle?: string
  /** Old-PowerPoint images: where the archive registry files it (today's palette fields). */
  /** Old slides: what the archive holds for the slide (thumbUrl is its render), enough to build an editable slide. */
  oldSlide?: OldSlideRecord
  archive?: { presentationId: string; relPath: string; sha256: string }
}

export type ImageSearchProviderName = 'slidewell' | 'archive'

export type ImageSearchResult = {
  provider: ImageSearchProviderName
  /** Words hits first, then picture matches not already among them. */
  hits: ImageSearchHit[]
  /** used: picture matches asked for and answered; off: not asked (Words, or no SlideWell);
   *  unavailable: asked, but SlideWell's process was not running or did not answer in time. */
  meaning: 'used' | 'off' | 'unavailable'
}

export type ImageSearchStatus = {
  /** null when no provider can search (no SlideWell store and no archive). */
  provider: ImageSearchProviderName | null
  /** Is an old-PowerPoint archive folder chosen and readable? Old slides and old-PowerPoint images come only from it. */
  archive: boolean
}

export type ImportedImage = { id: string; ext: string; path: string }

/** `images:search-vault`: the pictures in the `_assets` of every open vault. vaults is how many are open (0: none). */
export type VaultPictureResult = { vaults: number; hits: ImageSearchHit[] }
