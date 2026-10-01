// Shared types and constants for the Slide Browser modules (SlideBrowser.tsx is the thin shell).
import type { LedgerVersion, ProjectionRow } from '../../../../preload/index'
import type { AdoptVersion } from '../PropagationChecklist'
import type { DisplayCard, MergeRequest, SlideCluster } from '../slideBrowserModel'
import type { SlidePickerCommands } from '../slidePickerCommands'

export type SearchResult = ProjectionRow & {
  talkSlug: string
  talkTitle: string
  outlinePath: string
  talkMtimeMs?: number
  talkMeta?: string
  /** Set by main: did the query match this slide's title? Drives title-priority ranking. */
  titleHit?: boolean
  /** The vault the slide's talk lives in (main sets it on every search row). */
  vaultId?: string
}

export interface SlideBrowserProps {
  isOpen: boolean
  onClose: () => void
  onInsert: (markdown: string, fromSlug: string, sourceOutlinePath: string) => void
  onInsertMany?: (items: { markdown: string; fromSlug: string; sourceOutlinePath: string }[]) => void
  currentTalkSlug: string
  /** Absolute vault root — resolves a version's vault-relative `outline` for asset
   *  materialisation on version-insert (the ledger stores POSIX-relative paths). */
  vaultRoot: string
  /** The `?` chrome button — opens the app's keyboard cheat-sheet. */
  onOpenHelp: () => void
  /** True while another overlay (the cheat-sheet or the propagation checklist) is above the
   *  Browser — suspends ALL Browser keys + the focus trap so Esc/Space/arrows reach only the
   *  top overlay. */
  suspendKeys?: boolean
  context?: 'insert'
  /** When provided, every filmstrip print grows a secondary 'Adopt this version in…' action
   *  (PRD A5) — the host mounts the PropagationChecklist over the Browser. */
  onAdoptVersion?: (slideId: string, version: AdoptVersion) => void
  /** Registers a "focus + select the search field" fn with the host. The workspace's global
   *  ⌘S calls it when the Browser is ALREADY open (re-focus, don't toggle closed). */
  registerFocusSearch?: (fn: () => void) => void
  /** Registers the picker's talk-search actions with the host, so the command palette can run
   *  them (talk search 08). Registered once; each call reaches the picker's live state. */
  registerCommands?: (commands: SlidePickerCommands) => void
  /** Opens the merge-into-one-slide confirm (host-mounted, like PropagationChecklist) for a
   *  byte-identical cluster. Triggered by the locations panel's 'Merge into one slide' AND by
   *  the insert-time nudge — the latter fires as the Browser closes, so the confirm MUST live
   *  above the Browser (a sibling overlay), not inside it. */
  onRequestMerge?: (req: MergeRequest) => void
  /** Bumped by the host after a successful merge — re-runs the current search so the merged
   *  cluster now shows its shared id (the stack reads 'already one slide'). */
  refreshNonce?: number
  /** The open talk's outline and vault (ticket 06): its vault's chip and results come first. */
  currentOutlinePath?: string
  currentTalkVaultId?: string
}

export const DEBOUNCE_MS = 200
export const DEFAULT_LAYOUT = 'default'
export const DENSITY_STORAGE_KEY = 'tw-browser-density'
export const VIEW_STORAGE_KEY = 'tw-browser-multiview' // side ⇄ seq preference for 2–3 scoped talks
export const DENSITY_DEFAULT = 3
export const STAGGER_CAP = 12 // cap the cardIn stagger so huge grids don't crawl in
export const SIDE_MAX = 3 // >3 scoped talks fall back to sequential (columns would starve)

/** The open version filmstrip (ONE at a time): keyed by the expanded card's rowKey so it
 *  survives re-renders and filter churn; versions/thumbs fill in as the fetches land
 *  (versions === null → strip shows loading prints; thumbs === null → shimmer per print). */
export interface OpenStrip {
  id: string
  rowKey: string
  versions: LedgerVersion[] | null
  thumbs: Record<string, string> | null
}

/** The ONE open identical-stack locations panel, keyed by the stack card's rowKey. */
export interface OpenLoc {
  rowKey: string
  cluster: SlideCluster
}

export interface TalkChunkPlan {
  section: string
  label: string
  cards: DisplayCard[]
}

/** One talk's outline-ordered plan (scoped views, and the talk opened beside the results). */
export interface OutlineTalkPlan {
  slug: string
  title: string
  total: number
  chunks: TalkChunkPlan[]
}

export interface VersionCounts {
  versions: number
  talks: number
}

/** Everything a card, a grid and a talk's chunks read from the Browser's live state. The shell
 *  rebuilds it every render, so a card always sees the current selection, focus and expansion. */
export interface GridCtx {
  vRows: SearchResult[]
  selected: Set<string>
  activePos: number
  expandedRowKey: string | null
  expandedPos: number
  leftCount: number
  /** The visual position of the talk-beside's highlighted slide, or null with no talk beside. */
  hlPos: number | null
  /** True while the results are one list a talk can open beside. */
  besideOk: boolean
  sectionNoByKey: Map<string, number>
  thumbNonces: Record<string, number>
  regenTalk: string | null
  noteThumbUnavailable: (row: SearchResult) => void
  getCounts: (id: string) => VersionCounts | undefined
  rowsByTalk: Map<string, SearchResult[]>
  onCardClick: (pos: number, shift: boolean) => void
  onCardEnter: (pos: number) => void
  openBesideAt: (pos: number) => void
  toggleStrip: (pos: number) => Promise<void>
  toggleLocations: (pos: number) => void
  toggleNear: (pos: number) => void
  selectWholeSection: (talkSlug: string, section: string) => number
  renderExpansion: (anchor: number, row: SearchResult) => React.ReactElement | null
  /** With several open vaults (ticket 06): a result's vault, for its label. */
  vaultOf?: (vaultId: string | undefined) => import('./vaultChipsModel').ChipVault | undefined
}
