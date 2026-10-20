// What the image drawer shows, as pure functions (ImageDrawer.tsx draws it). The drawer asks the one
// image search (window.tw.images) and this module decides: which tab a hit belongs to, how it is
// captioned, how results are grouped, what the quiet lines say and how arrow keys move through a grid.
import type { ImageSearchHit, ImageSearchResult, ImageSearchStatus, VaultPictureResult } from '../../../shared/image-search'
import { shortcutEventMatches } from '../../../shared/shortcut-registry.ts'
import { canBuildEditable } from '../../../shared/old-slide.ts'

export type DrawerTab = 'images' | 'old-slides' | 'in-talks'

/** Cards across in the drawer's grid (432 px drawer, two columns). */
export const DRAWER_COLUMNS = 2

export const DRAWER_COPY = {
  title: 'Find images',
  searchPlaceholder: 'Search screenshots and images',
  tabImages: 'SlideWell',
  tabOldSlides: 'PowerPoint Imports',
  tabInTalks: 'TalkWeaver Vaults',
  // Where each tab's pictures come from (read from the code: SlideWell's library for the first tab, the
  // old-PowerPoint archive folder from Settings for old PowerPoint images and for the Old slides tab).
  sourceLine: 'From your SlideWell library: screenshots, added images and the pictures in your talks, plus images from your old PowerPoints',
  sourceLineNoArchive: 'From your SlideWell library: screenshots, added images and the pictures in your talks',
  noSlideWell: 'SlideWell is not set up, so screenshots and the pictures in your talks cannot be found here. Only images from your old PowerPoints can.',
  nothingToSearch: 'SlideWell is not set up and no old-PowerPoint archive is chosen, so there is nothing to search. Screenshots and images need SlideWell; the archive folder is chosen in Settings.',
  idle: 'Type to search. A picture pasted into a talk appears here only once SlideWell has filed it.',
  searching: 'Searching…',
  unavailable: 'Image search is not available right now.',
  oldSlidesLine: 'Slides from your old PowerPoints, from the archive folder chosen in Settings. SlideWell is not needed.',
  oldSlidesNoArchive: 'No old-PowerPoint archive is chosen, so there are no old slides to search. Choose the archive folder in Settings.',
  inTalksLine: 'Pictures already in your talks, from your open vaults. SlideWell is not needed.',
  inTalksNone: 'No pictures in your talks match that.',
  inTalksNoVault: 'Open a vault to see the pictures in its talks.',
  inTalksPlaceholder: 'Search the pictures in your talks',
  idleOldSlides: 'Type to search slides from your old PowerPoints.',
  meaningOff: 'Picture matching is not running, so only word matches are shown.',
  inserted: 'Inserted',
  groupThisTalk: 'In this talk',
  groupOldPowerPoints: 'From old PowerPoints'
} as const

/** The inline choice shown when an old slide is inserted (locked frame 2). */
export const CHOICE_COPY = {
  heading: 'Use this slide as',
  editable: 'Editable slide',
  picture: 'Picture of the slide',
  pictureHint: 'Placed on this slide as one image, as it looked',
  cancels: 'cancels',
  pictureOnly: 'This slide has no text or pictures to edit, so it can only go in as a picture.'
} as const

export function editableHint(afterSlide: number | null): string {
  return `${afterSlide && afterSlide > 0 ? `Added after slide ${afterSlide}` : 'Added after this slide'}; text and images stay editable`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-10-08' → '8 Oct 2026'; anything else is returned as it came (no guessing at time zones). */
export function formatDay(day: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '')
  if (!m) return day ?? ''
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : (day ?? '')
}

/** One talk is one talk however many slides of it use the picture. */
export function usedInTalks(hit: ImageSearchHit): number {
  return new Set(hit.usedIn.map((u) => u.talkPath || u.talkTitle)).size
}

export function usedInLabel(hit: ImageSearchHit): string | null {
  const n = usedInTalks(hit)
  return n === 0 ? null : `Used in ${n} ${n === 1 ? 'talk' : 'talks'}`
}

export type HitCaption = { title: string; detail: string; usedIn: string | null }

/** The caption under a card: app · date for screenshots and added images; talk · year for a talk's own
 *  pictures ('This talk · slide N' when the open talk uses it); the presentation for old-PowerPoint images. */
export function captionFor(hit: ImageSearchHit, currentTalkPath: string | null, withSourceWord: boolean): HitCaption {
  const usedIn = usedInLabel(hit)
  if (hit.source === 'archive-image') {
    const name = hit.presentationTitle || hit.title
    return {
      title: name || 'Image from an old PowerPoint',
      detail: withSourceWord ? 'Old PowerPoint' : '',
      usedIn
    }
  }
  if (hit.source === 'talk-image') {
    const here = currentTalkPath ? hit.usedIn.find((u) => u.talkPath === currentTalkPath) : undefined
    if (here) {
      return { title: hit.title, detail: here.slide > 0 ? `This talk · slide ${here.slide}` : 'This talk', usedIn: null }
    }
    const talk = hit.usedIn[0]?.talkTitle
    const year = (hit.date ?? hit.detail ?? '').slice(0, 4)
    return { title: hit.title, detail: [talk && talk !== hit.title ? talk : 'Talk', year].filter(Boolean).join(' · '), usedIn }
  }
  if (hit.source === 'vault-image') {
    const here = currentTalkPath ? hit.usedIn.some((u) => u.talkPath === currentTalkPath) : false
    return { title: hit.title, detail: here ? 'This talk' : hit.detail, usedIn: here && usedInTalks(hit) === 1 ? null : usedIn }
  }
  if (hit.source === 'old-slide') {
    return { title: hit.title || 'Slide from an old PowerPoint', detail: hit.presentationTitle ?? '', usedIn }
  }
  const detail = [hit.app, formatDay(hit.date)].filter(Boolean).join(' · ') || hit.detail
  return { title: hit.title, detail, usedIn }
}

/** Is this hit one of the open talk's own pictures? */
export function isInThisTalk(hit: ImageSearchHit, currentTalkPath: string | null): boolean {
  return Boolean(currentTalkPath) && hit.source === 'talk-image' && hit.usedIn.some((u) => u.talkPath === currentTalkPath)
}

/** The first tab holds everything except old slides; the second holds only old slides. */
export function hitsForTab(result: ImageSearchResult | null, tab: DrawerTab): ImageSearchHit[] {
  if (!result) return []
  return result.hits.filter((h) => (tab === 'old-slides' ? h.source === 'old-slide' : h.source !== 'old-slide'))
}

export type HitGroup = { label: string | null; hits: ImageSearchHit[] }

/** With SlideWell the list is flat, in the order the search returned it (words first, then picture
 *  matches). Without it the list is grouped: this talk's own pictures, then old PowerPoints. */
export function groupHits(hits: ImageSearchHit[], slideWell: boolean, currentTalkPath: string | null): HitGroup[] {
  if (hits.length === 0) return []
  if (slideWell) return [{ label: null, hits }]
  const here = hits.filter((h) => isInThisTalk(h, currentTalkPath))
  const rest = hits.filter((h) => !isInThisTalk(h, currentTalkPath))
  const out: HitGroup[] = []
  if (here.length) out.push({ label: DRAWER_COPY.groupThisTalk, hits: here })
  if (rest.length) out.push({ label: DRAWER_COPY.groupOldPowerPoints, hits: rest })
  return out
}

/** Hits in the order the cards are drawn (groups flattened); arrow keys and ⌘↵ index into this. */
export function flatOrder(groups: HitGroup[]): ImageSearchHit[] {
  return groups.flatMap((g) => g.hits)
}

export type DrawerView =
  | { kind: 'idle' }
  | { kind: 'no-vault' }
  | { kind: 'searching' }
  | { kind: 'unavailable' }
  | { kind: 'none'; query: string }
  | { kind: 'results'; groups: HitGroup[]; count: number }

export type DrawerInput = {
  tab: DrawerTab
  query: string
  loading: boolean
  /** null: no answer yet (before the first search, or the search failed). */
  result: ImageSearchResult | null
  /** The In your talks tab's own answer (images:search-vault); null: none yet. */
  vault?: VaultPictureResult | null
  failed: boolean
  status: ImageSearchStatus | null
  currentTalkPath: string | null
}

export function viewFor(i: DrawerInput): DrawerView {
  if (i.tab === 'in-talks') {
    // Searched on opening as well, so an empty query lists the newest pictures; there is no idle state.
    if (i.failed) return { kind: 'unavailable' }
    if (!i.vault) return { kind: 'searching' }
    if (i.vault.vaults === 0) return { kind: 'no-vault' }
    if (i.vault.hits.length === 0) return i.loading ? { kind: 'searching' } : { kind: 'none', query: i.query.trim() }
    return { kind: 'results', groups: [{ label: null, hits: i.vault.hits }], count: i.vault.hits.length }
  }
  if (!i.query.trim()) return { kind: 'idle' }
  if (i.failed) return { kind: 'unavailable' }
  if (!i.result) return { kind: 'searching' }
  const hits = hitsForTab(i.result, i.tab)
  if (hits.length === 0) return i.loading ? { kind: 'searching' } : { kind: 'none', query: i.query.trim() }
  return { kind: 'results', groups: groupHits(hits, i.result.provider === 'slidewell', i.currentTalkPath), count: hits.length }
}

/** The one quiet line under the tabs (never error styling), or null. */
export function quietLine(status: ImageSearchStatus | null, result: ImageSearchResult | null, tab: DrawerTab, vault?: VaultPictureResult | null): { icon: boolean; text: string } | null {
  // The vault tab needs neither SlideWell nor the archive, so it never waits for the status.
  if (tab === 'in-talks') return vault && vault.vaults === 0 ? { icon: true, text: DRAWER_COPY.inTalksNoVault } : { icon: false, text: DRAWER_COPY.inTalksLine }
  // Until the drawer knows which sources exist it says nothing, rather than name one that is not there.
  if (!status) return null
  if (tab === 'old-slides') return status.archive ? { icon: false, text: DRAWER_COPY.oldSlidesLine } : { icon: true, text: DRAWER_COPY.oldSlidesNoArchive }
  if (status.provider === null) return { icon: true, text: DRAWER_COPY.nothingToSearch }
  if (status.provider === 'archive') return { icon: true, text: DRAWER_COPY.noSlideWell }
  if (result?.provider === 'slidewell' && result.meaning === 'unavailable') return { icon: true, text: DRAWER_COPY.meaningOff }
  return { icon: false, text: status.archive ? DRAWER_COPY.sourceLine : DRAWER_COPY.sourceLineNoArchive }
}

/** Arrow-key movement through `count` cards in `columns`; the highlight always sits on a card. */
export function moveIndex(current: number, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', count: number, columns = DRAWER_COLUMNS): number {
  if (count === 0) return 0
  const at = Math.min(Math.max(current, 0), count - 1)
  switch (key) {
    case 'ArrowLeft': return Math.max(at - 1, 0)
    case 'ArrowRight': return Math.min(at + 1, count - 1)
    case 'ArrowDown': return Math.min(at + columns, count - 1)
    case 'ArrowUp': return Math.max(at - columns, 0)
  }
}

/** What the inline choice shows for one old slide. `editable` is false when the record gives nothing to
 *  edit (no text and no pictures, or no record from the provider): then only the picture is offered and
 *  `note` says why. */
export type Choice = { key: string; editable: boolean; note: string | null }

/** The choice for a hit, or null when the hit is not an old slide (those insert at once). */
export function choiceFor(hit: ImageSearchHit): Choice | null {
  if (hit.source !== 'old-slide') return null
  const editable = hit.oldSlide ? canBuildEditable(hit.oldSlide) : false
  return { key: hit.key, editable, note: editable ? null : CHOICE_COPY.pictureOnly }
}

export type ChoiceKeyAction = 'editable' | 'picture' | 'cancel' | 'swallow'

/** What a key does while the choice shows: Enter, P and Esc are the choice's; any other plain key is
 *  swallowed so it does not reach the search box; keys with ⌘ or ⌃ are left to their own handlers.
 *  With no choice showing, Enter and P are not this module's (null). */
export function choiceKeyAction(choice: Choice | null, e: KeyboardEvent): ChoiceKeyAction | null {
  if (!choice) return null
  if (shortcutEventMatches(e, 'image-drawer.close')) return 'cancel'
  if (shortcutEventMatches(e, 'image-drawer.choose-editable')) return choice.editable ? 'editable' : 'swallow'
  if (shortcutEventMatches(e, 'image-drawer.choose-picture')) return 'picture'
  return e.metaKey || e.ctrlKey || e.altKey ? null : 'swallow'
}
