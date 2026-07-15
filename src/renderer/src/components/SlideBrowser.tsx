// Slide Browser — the Light Table (ADR-0034, PRD A1/A2/A6). Full-workspace overlay on ⌘S.
// v0.15 wave-1 (ADR-0009): the left side is the UNIFIED RAIL — Search finds · Scope pins
// places · Browse walks them · Filters narrow by property — and the grid answers the scope:
// no scope = grouped by talk·section; one talk = outline order with position badges; 2–3
// talks = side-by-side sticky-headed columns (toggleable to sequential); >3 = sequential.
// The plumbing (insert contract, selection tray, filmstrip, adopt, merge, tags, progressive
// thumbnails) is unchanged from the pre-rail Browser. v0.15.x: the ACTIVE talk's slides are
// never on the table (the grid/strip serves them), and ↵ opens the INSERT-DECISION VIEWER —
// never the editor, never a talk switch.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArrowDown, Check, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown,
  Columns2, FolderOpen, GitBranch, GitMerge, Layers, LayoutGrid, Rows3,
  SearchX, Settings2, Star, Tag, X
} from 'lucide-react'
import type {
  LedgerVersion, ProjectionRow, RecordingSession, TagCount, TalkInfo, TalkMeta
} from '../../../preload/index'
import { notify } from '../lib/notify'
import { tagsOfBlock } from '../../../shared/tags'
import { LAYOUTS } from '../data/layouts'
import type { AdoptVersion } from './PropagationChecklist'
import TagPicker from './TagPicker'
import InsertViewer from './InsertViewer'
import BrowserRail from './browser-rail/BrowserRail'
import EchoLine from './browser-rail/EchoLine'
import {
  type ContentKey, type RailFacets, type ScopeEntry,
  CONTENT_KEYS, CONTENT_LABELS, agoLabel, anyFacetActive, emptyFacets, facetKindBases,
  facetLayoutOf, gridModeFor, outlineChunks, passesFacets, rowHasContent, rowInScope,
  rowInScopeEntry, scopedTalkSlugs, talkTitleHits, toggleScope
} from './browser-rail/railModel'
import type {
  CollectionRow, ContentItem, FacetItem, FacetKind, TreeFolder
} from './browser-rail/railTypes'
import {
  type DisplayCard, type MergeRequest, type SlideCluster,
  buildDisplayModel, canonicalVersion, clusterAlreadyOneSlide, clusterMergeable,
  gridNavigate, inTalksLabel, layoutOf, mergeNudgeLabel,
  mergeTargetsFromCluster, nearCountLabel, parseSearchQuery, rangeKeys, rankBySearch, scopeNoun,
  sectionKey, sectionKeysAt, sectionNamesByKey, selRowKey, stampedIdOf, stripAnchorPercent,
  tagTargetsFromRows, versionBadgeParts
} from './slideBrowserModel'

export type SearchResult = ProjectionRow & {
  talkSlug: string
  talkTitle: string
  outlinePath: string
  talkMtimeMs?: number
  talkMeta?: string
  /** Set by main: did the query match this slide's title? Drives title-priority ranking. */
  titleHit?: boolean
}

interface Props {
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
  /** Opens the merge-into-one-slide confirm (host-mounted, like PropagationChecklist) for a
   *  byte-identical cluster. Triggered by the locations panel's 'Merge into one slide' AND by
   *  the insert-time nudge — the latter fires as the Browser closes, so the confirm MUST live
   *  above the Browser (a sibling overlay), not inside it. */
  onRequestMerge?: (req: MergeRequest) => void
  /** Bumped by the host after a successful merge — re-runs the current search so the merged
   *  cluster now shows its shared id (the stack reads 'already one slide'). */
  refreshNonce?: number
  /** Tag write safety (ADR-0037): awaited BEFORE tags:apply so the host can flush the active
   *  talk's pending autosave when it is among the target outlines (the detach/adopt rule). */
  flushBeforeTagWrite?: (outlinePaths: string[]) => Promise<void>
  /** Called AFTER a successful tags:apply with the rewritten outlines' absolute paths — the
   *  host re-reads + adopts the active talk's text if it was touched (handleAdopted pattern). */
  onTagsApplied?: (outlinePaths: string[]) => void | Promise<void>
}

const DEBOUNCE_MS = 200
const DEFAULT_LAYOUT = 'default'
const DENSITY_STORAGE_KEY = 'tw-browser-density'
const VIEW_STORAGE_KEY = 'tw-browser-multiview' // side ⇄ seq preference for 2–3 scoped talks
const DENSITY_DEFAULT = 3
const STAGGER_CAP = 12 // cap the cardIn stagger so huge grids don't crawl in
const SIDE_MAX = 3 // >3 scoped talks fall back to sequential (columns would starve)

function readDensity(): number {
  try {
    const n = parseInt(window.localStorage.getItem(DENSITY_STORAGE_KEY) ?? '', 10)
    return Number.isFinite(n) ? Math.min(6, Math.max(2, n)) : DENSITY_DEFAULT
  } catch {
    return DENSITY_DEFAULT
  }
}

function topicOf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts.length >= 2 ? parts[parts.length - 2] : '(root)'
}
function rowMarkdown(row: SearchResult): string {
  return row.source_markdown && row.source_markdown.trim() !== ''
    ? row.source_markdown
    : `### ${row.nav_title || row.title || 'Untitled'}\n`
}
function rowTitle(row: SearchResult): string {
  return row.nav_title || row.title || '(untitled)'
}

// Real 16:9 print: shimmer while the twthumb:// render decodes, schematic title fallback
// when it 404s (GridView CellThumb pattern). Keyed by src + regen nonce at the call site so
// a re-render with a new hash (or a fresh background thumbnail run) restarts cleanly.
// `onUnavailable` reports a 404 upward so the Browser can queue a background per-talk
// thumbnail run (Gate-4 bug 4); while that run is in flight (`regenerating`) the failed
// print shows the shimmer, not the schematic — it will resolve either way in a moment.
function Thumb({ row, regenerating, onUnavailable }: {
  row: SearchResult
  regenerating: boolean
  onUnavailable: (row: SearchResult) => void
}) {
  const hasHash = Boolean(row.content_hash)
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>(hasHash ? 'loading' : 'failed')
  return (
    <div className="lt-thumb">
      {hasHash && state !== 'failed' && (
        <img
          src={`twthumb://${row.talkSlug}/${row.render_hash || row.content_hash}`}
          alt={rowTitle(row)}
          loading="lazy"
          decoding="async"
          onLoad={() => setState('ok')}
          onError={() => { setState('failed'); onUnavailable(row) }}
        />
      )}
      {state === 'loading' && <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>}
      {state === 'failed' && (hasHash && regenerating
        ? <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>
        : <div className="lt-thumb-fallback">{rowTitle(row)}</div>)}
    </div>
  )
}

// A version print's 16:9 thumbnail: real render from the versionThumbnails batch, shimmer
// while the batch promise is in flight (`urls === null`), schematic title fallback when the
// batch resolved without this version's key (or the image itself fails to decode).
function VersionThumb({ url, pending, title }: { url?: string; pending: boolean; title: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="lt-vthumb">
      {url && !failed && <img src={url} alt={title} decoding="async" onError={() => setFailed(true)} />}
      {pending && <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>}
      {!pending && (!url || failed) && <div className="lt-vthumb-fallback">{title}</div>}
    </div>
  )
}

// Full-grid-width expansion row. Mounted closed and flipped to .open a frame later so the
// max-height/opacity transition actually plays on expand (mockup 457-462).
function StripRow({ anchor, children }: { anchor: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className={`lt-strip-row${open ? ' open' : ''}`} style={{ ['--anchor' as string]: `${anchor}%` }}>
      {children}
    </div>
  )
}

// 'd MMM yyyy' (en-GB): 28 Jun 2026 — mono in the print caption.
const VDATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

// Schematic fallback title for a version print: the heading text without tokens.
function versionTitle(markdown: string): string {
  const first = (markdown.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').replace(/\{[^}]*\}/g, '').trim()
  return first || '(untitled)'
}

export default function SlideBrowser({
  isOpen, onClose, onInsert, onInsertMany, currentTalkSlug, vaultRoot, onOpenHelp, suspendKeys,
  onAdoptVersion, registerFocusSearch, onRequestMerge, refreshNonce, flushBeforeTagWrite, onTagsApplied
}: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  // The UNQUERIED index snapshot — captured whenever an empty-query search lands (the open
  // itself runs one). Feeds the Files tree, scope-row counts and facet vocabularies, so
  // browsing structure stays stable while the user types a query.
  const [fullRows, setFullRows] = useState<SearchResult[]>([])
  const [unavailable, setUnavailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [talks, setTalks] = useState<TalkInfo[]>([])
  const [talkMeta, setTalkMeta] = useState<TalkMeta>({})
  const [tagVocab, setTagVocab] = useState<TagCount[]>([])
  const [deliverySessions, setDeliverySessions] = useState<RecordingSession[]>([])
  // The unified rail's compositional state (ADR-0009): pinned scope + property facets.
  const [scope, setScope] = useState<ScopeEntry[]>([])
  const [facets, setFacets] = useState<RailFacets>(emptyFacets)
  // Side-by-side ⇄ sequential preference for a 2–3-talk scope (persisted).
  const [viewPref, setViewPref] = useState<'side' | 'seq'>(() => {
    try { return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'seq' ? 'seq' : 'side' } catch { return 'side' }
  })
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [activePos, setActivePos] = useState(0)
  const [preview, setPreview] = useState(false)
  const [density, setDensityState] = useState<number>(readDensity)
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [openPop, setOpenPop] = useState<string | null>(null)
  // settings-glimpse local state (real settings land in Task 11)
  const [glimpseDensity, setGlimpseDensity] = useState<number>(readDensity)
  const [glimpseLastFilters, setGlimpseLastFilters] = useState(true)
  const [glimpseScoped, setGlimpseScoped] = useState(false)
  // The open version filmstrip (ONE at a time): keyed by the expanded card's rowKey so it
  // survives re-renders and filter churn; versions/thumbs fill in as the fetches land
  // (versions === null → strip shows loading prints; thumbs === null → shimmer per print).
  const [openStrip, setOpenStrip] = useState<{
    id: string; rowKey: string; versions: LedgerVersion[] | null; thumbs: Record<string, string> | null
  } | null>(null)
  // Which version print just inserted — its button reads 'Inserted ✓' for 900ms (mockup 2159-2165).
  const [flashFile, setFlashFile] = useState<string | null>(null)
  // Duplicate collapse (Task 9): near-cluster keys the user has UNcollapsed (variants shown inline);
  // and the ONE open identical-stack locations panel (keyed by the stack card's rowKey), sharing the
  // expansion slot with the version filmstrip so only one thing expands at a time.
  const [nearExpanded, setNearExpanded] = useState<Set<string>>(() => new Set())
  const [openLoc, setOpenLoc] = useState<{ rowKey: string; cluster: SlideCluster } | null>(null)
  // Tag picker (ADR-0037, `t`): tray-anchored, writes via tags:apply. `tagBusy` guards one
  // in-flight write; `tagsVersion` bumps after an optimistic per-row `tags` update (the rows
  // are mutated in place — the same objects the display model holds — so applying a tag never
  // re-runs the whole search or reflows the grid).
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  const [, setTagsVersion] = useState(0)
  // The INSERT-DECISION VIEWER (↵ on a card): a self-contained overlay layer inside the
  // Browser — never the editor, never a talk switch. Holds the source talk + the deck index
  // to open on; the deck itself derives from the full index snapshot.
  const [viewer, setViewer] = useState<{ slug: string; order: number } | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqIdRef = useRef(0)
  const anchorRef = useRef(0)
  const prevFocusRef = useRef<HTMLElement | null>(null)
  // Badge counts cache: id → {versions, talks}. Fills LAZILY (on expansion + an idle
  // background sweep) — NEVER one ledger IPC per card per keystroke. Shared across
  // searches and across openings (the component stays mounted while closed).
  const countsRef = useRef(new Map<string, { versions: number; talks: number }>())
  const countsFetchingRef = useRef(new Set<string>())
  const [, setCountsNonce] = useState(0)

  // Progressive real-thumbnail fill-in (Gate-4 bug 4, ADR-0034 demands real prints): talks
  // whose twthumb:// prints 404 (their thumbnail cache was never built — only talks opened
  // in the editor get a tw.talk.thumbnails run) are rendered in the background from the
  // Browser, strictly ONE talk at a time (each run opens a hidden window). When a talk's run
  // resolves, its nonce bumps and that talk's <img>s remount and retry. Guards: chain runs
  // only while the Browser is open; a talk is requested at most once per session.
  const [thumbNonces, setThumbNonces] = useState<Record<string, number>>({})
  const [regenTalk, setRegenTalk] = useState<string | null>(null)
  const missingThumbTalksRef = useRef(new Map<string, string>()) // slug → outlinePath
  const requestedThumbTalksRef = useRef(new Set<string>()) // once per session, ever
  const regenRunningRef = useRef(false)
  const isOpenRef = useRef(isOpen)
  useEffect(() => {
    isOpenRef.current = isOpen
    if (!isOpen) missingThumbTalksRef.current.clear() // stop the chain's queue on close
  }, [isOpen])

  async function runThumbRegenChain(): Promise<void> {
    if (regenRunningRef.current) return
    regenRunningRef.current = true
    try {
      while (isOpenRef.current) {
        const first = missingThumbTalksRef.current.entries().next()
        if (first.done) break
        const [slug, outlinePath] = first.value
        missingThumbTalksRef.current.delete(slug)
        if (requestedThumbTalksRef.current.has(slug)) continue
        requestedThumbTalksRef.current.add(slug)
        setRegenTalk(slug)
        try {
          const content = await window.tw.talk.readOutline(outlinePath)
          if (!isOpenRef.current) break
          if (content != null) await window.tw.talk.thumbnails(outlinePath, content)
          if (isOpenRef.current) setThumbNonces((n) => ({ ...n, [slug]: (n[slug] ?? 0) + 1 }))
        } catch { /* one bad talk must not stall the rest of the chain */ }
        setRegenTalk(null)
      }
    } finally {
      regenRunningRef.current = false
      setRegenTalk(null)
    }
  }
  function noteThumbUnavailable(row: SearchResult): void {
    if (!row.outlinePath || requestedThumbTalksRef.current.has(row.talkSlug)) return
    if (!isOpenRef.current) return
    missingThumbTalksRef.current.set(row.talkSlug, row.outlinePath)
    void runThumbRegenChain()
  }

  // Reset on open (SearchPalette semantics); density + rail UI state persist across openings,
  // scope and facets do NOT (a fresh opening starts from the whole vault).
  useEffect(() => {
    if (!isOpen) return
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery(''); setUnavailable(false); setSelected(new Set()); setActivePos(0)
    setPreview(false); setOpenPop(null); setScope([]); setFacets(emptyFacets()); anchorRef.current = 0
    setOpenStrip(null); setFlashFile(null); setNearExpanded(new Set()); setOpenLoc(null)
    setTagPickerOpen(false)
    setViewer(null)
    // Badge counts refetch per opening: an adoption/save between openings changes the
    // version/talk counts, so a cache carried across openings would show stale badges.
    countsRef.current.clear()
    requestAnimationFrame(() => inputRef.current?.focus())
    // One-time-per-opening reference fetches for the rail (never in the filter hot path):
    // vault talks, per-talk meta (covers, editedMs), the tag vocabulary, delivery sessions.
    window.tw.vault.listTalks().then((t) => setTalks(t || [])).catch(() => setTalks([]))
    try { window.tw.vault.talkMeta().then((m) => setTalkMeta(m || {})).catch(() => setTalkMeta({})) } catch { setTalkMeta({}) }
    try { window.tw.tags.vocabulary().then((v) => setTagVocab(v || [])).catch(() => setTagVocab([])) } catch { setTagVocab([]) }
    try {
      window.tw.recording.listAllSessions()
        .then((s) => setDeliverySessions((s || []).filter((x) => x.kind === 'delivery')))
        .catch(() => setDeliverySessions([]))
    } catch { setDeliverySessions([]) }
    return () => { prevFocusRef.current?.focus?.() }
  }, [isOpen])

  // ⌘S while the Browser is already open re-focuses + selects the search field (the workspace's
  // global handler calls this via the registered fn) instead of toggling the overlay closed —
  // Esc stays the only close path. Reads inputRef lazily so it always targets the live input.
  useEffect(() => {
    registerFocusSearch?.(() => {
      // The search field lives in the rail now — a collapsed rail must reopen first.
      setRailCollapsed(false)
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
  }, [registerFocusSearch])

  // The query parsed into scope/exact/terms — sent to main (scoped matching) and read by the
  // zero-results copy (which field the empty search looked in).
  const parsedQuery = useMemo(() => parseSearchQuery(query), [query])

  // Debounced search with a request-id guard (ported from SearchPalette).
  useEffect(() => {
    if (!isOpen) return
    const reqId = ++reqIdRef.current
    setLoading(true)
    const handle = setTimeout(async () => {
      const rows = await window.tw.search.allSlides(parsedQuery)
      if (reqId !== reqIdRef.current) return
      setLoading(false)
      if (rows === null) { setUnavailable(true); setResults([]); return }
      setUnavailable(false); setResults(rows as SearchResult[]); setActivePos(0)
      // An empty query returns the WHOLE index — snapshot it for the rail's stable
      // structure (tree, counts, vocabularies) so typing never reshapes Browse.
      if (parsedQuery.terms.length === 0 && parsedQuery.text.trim() === '') {
        setFullRows(rows as SearchResult[])
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(handle)
    // refreshNonce re-runs the search after a merge so the cluster reflects its new shared id.
  }, [parsedQuery, isOpen, refreshNonce])

  useEffect(() => {
    try { window.localStorage.setItem(DENSITY_STORAGE_KEY, String(density)) } catch { /* ignore */ }
  }, [density])

  function setDensity(d: number): void {
    setDensityState(Math.min(6, Math.max(2, d)))
  }

  const folderBySlug = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of talks) m.set(t.slug, topicOf(t.path))
    return m
  }, [talks])
  const folderOf = (slug: string): string => folderBySlug.get(slug) || '(root)'
  const talksByFolder = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const t of talks) {
      const f = topicOf(t.path)
      const list = m.get(f)
      if (list) list.push(t.slug)
      else m.set(f, [t.slug])
    }
    return m
  }, [talks])

  // The projection's `section` is a slug — show the AUTHORED section names (from the
  // section-title rows), resolved over the FULL snapshot (stable while a query narrows
  // `results`) with the live results as fallback.
  const sectionNames = useMemo(() => {
    const m = sectionNamesByKey(fullRows)
    for (const [k, v] of sectionNamesByKey(results)) if (!m.has(k)) m.set(k, v)
    return m
  }, [fullRows, results])
  const secName = (key: string, fallback: string): string => sectionNames.get(key) ?? fallback
  // A row's section as the Sections facet sees it — the display label (observed identity,
  // stage-3-lite: the section STRING across the scoped set, not per-talk identity).
  const secLabelOf = (r: SearchResult): string => secName(sectionKey(r.talkSlug, r.section ?? ''), r.section ?? '')

  // ---------- the active talk is NEVER on the table (v0.15.x decision) ----------
  // The Browser's corpus is every talk EXCEPT the one being edited — its own slides live in
  // the grid/strip and were only ever confusing here. Applies to every result view (grouped,
  // searched, filtered, scoped); the Files tree still lists it (dimmed, non-scoping) because
  // the tree tells disk truth.
  const visibleResults = useMemo(
    () => (currentTalkSlug ? results.filter((r) => r.talkSlug !== currentTalkSlug) : results),
    [results, currentTalkSlug]
  )

  // ---------- scope + facets + duplicate collapse into the display model ----------
  // The composition law: main's search already applied the query; scope and facets AND on
  // top as a passing-set predicate. Cluster over the FULL unfiltered visible set (occurrence-
  // exactness — engine caveat F3) and collapse byte-identical / near clusters into stacks.
  const passingSet = useMemo(() => {
    const s = new Set<SearchResult>()
    for (const r of visibleResults) {
      if (rowInScope(r, scope, folderOf) && passesFacets(r, facets, secLabelOf, rowTags)) s.add(r)
    }
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleResults, scope, facets, folderBySlug, sectionNames])
  // Title-priority ordering (only with a query active): float title-hit rows to the front BEFORE
  // grouping/clustering, so within each talk·section group the title matches surface first. Same
  // row objects, reordered — passingSet membership (object identity) is unaffected.
  const ranked = useMemo(
    () => (query.trim() !== '' ? rankBySearch(visibleResults) : visibleResults),
    [visibleResults, query]
  )
  const display = useMemo(
    () => buildDisplayModel(ranked, (r) => passingSet.has(r as SearchResult), nearExpanded),
    [ranked, passingSet, nearExpanded]
  )
  const groupTotals = useMemo(() => {
    const totals = buildDisplayModel(visibleResults, () => true, new Set<string>())
    const m = new Map<string, number>()
    for (const g of totals.groups) m.set(sectionKey(g.talkSlug, g.section), g.units)
    return m
  }, [visibleResults])
  const groups = display.groups

  // ---------- grid mode (ADR-0009): scope decides how the grid reads ----------
  // A saved scope that pins the active talk drops it SILENTLY from the effective scope
  // (folders containing it simply expand without it).
  const scopedSlugs = useMemo(
    () => scopedTalkSlugs(scope, (f) => talksByFolder.get(f) ?? []).filter((s) => s !== currentTalkSlug),
    [scope, talksByFolder, currentTalkSlug]
  )
  const gridMode = gridModeFor(scopedSlugs.length, viewPref === 'side')
  const sideEligible = scopedSlugs.length >= 2 && scopedSlugs.length <= SIDE_MAX

  // Scoped views show the talk AS IT RUNS: every passing occurrence is its own card in
  // outline order (no duplicate collapse — position badges need the real sequence).
  interface OutlineTalkPlan {
    slug: string
    title: string
    total: number
    chunks: Array<{ section: string; label: string; cards: DisplayCard[] }>
  }
  const outlinePlan = useMemo<OutlineTalkPlan[]>(() => {
    if (gridMode === 'grouped') return []
    return scopedSlugs.map((slug) => {
      const mine = visibleResults.filter((r) => r.talkSlug === slug && passingSet.has(r))
      const chunks = outlineChunks(mine).map((c) => ({
        section: c.section,
        label: secName(sectionKey(slug, c.section), c.section),
        cards: c.rows.map((row) => ({ row, kind: 'single' as const }))
      }))
      const title = mine[0]?.talkTitle || talks.find((t) => t.slug === slug)?.title || slug
      return { slug, title, total: mine.length, chunks }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridMode, scopedSlugs, visibleResults, passingSet, talks, sectionNames])

  // The grid's VISUAL order (one entry per rendered card; side-by-side flattens column-
  // major). Selection, ranges and keyboard nav all run over this order.
  const vCards = useMemo<DisplayCard[]>(
    () => (gridMode === 'grouped'
      ? display.cards
      : outlinePlan.flatMap((t) => t.chunks.flatMap((c) => c.cards))),
    [gridMode, display, outlinePlan]
  )
  const vRows = useMemo(() => vCards.map((c) => c.row) as SearchResult[], [vCards])
  // row → its display card, so an insert can spot a mergeable identical stack (the merge nudge).
  const cardByRow = useMemo(() => {
    const m = new Map<SearchResult, DisplayCard>()
    for (const c of vCards) m.set(c.row as SearchResult, c)
    return m
  }, [vCards])

  // §-numbers for card origins + the locations panel, per talk in first-appearance order.
  const sectionNoByKey = useMemo(() => {
    const m = new Map<string, number>()
    const perTalk = new Map<string, number>()
    for (const r of visibleResults) {
      const key = sectionKey(r.talkSlug, r.section ?? '')
      if (m.has(key)) continue
      const n = (perTalk.get(r.talkSlug) ?? 0) + 1
      perTalk.set(r.talkSlug, n)
      m.set(key, n)
    }
    return m
  }, [visibleResults])

  // Display titles: vault list first (covers talks with no matching rows), results fallback.
  const titleBySlug = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of talks) m.set(t.slug, t.title || t.slug)
    for (const r of results) if (!m.has(r.talkSlug)) m.set(r.talkSlug, r.talkTitle || r.talkSlug)
    return m
  }, [talks, results])

  const sectionCount = display.sectionCount
  const facetsOn = anyFacetActive(facets)
  const scopeOn = scope.length > 0
  const filtersOn = facetsOn || scopeOn
  const vaultEmpty = !loading && !unavailable && results.length === 0 && query.trim() === '' && !facetsOn
  const zeroResults = !loading && !unavailable && !vaultEmpty && vRows.length === 0

  useEffect(() => {
    if (activePos > vRows.length - 1) setActivePos(Math.max(0, vRows.length - 1))
  }, [vRows.length, activePos])
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(`[data-pos="${activePos}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activePos, vRows])

  // ---------- selection (over the visual order) ----------
  function toggleAt(pos: number): void {
    if (!vRows[pos]) return
    const k = selRowKey(vRows, pos)
    setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
    anchorRef.current = pos
  }
  function extendTo(pos: number): void {
    const keys = rangeKeys(vRows, anchorRef.current, pos)
    setSelected((prev) => { const n = new Set(prev); for (const k of keys) n.add(k); return n })
  }
  function selectActiveSection(): void {
    const keys = sectionKeysAt(vRows, activePos)
    setSelected((prev) => { const n = new Set(prev); for (const k of keys) n.add(k); return n })
    anchorRef.current = activePos
  }

  // ---------- duplicate merge (Task 9) ----------
  // Build the host-mounted MergeConfirm's request from an identical cluster: occurrence-exact
  // targets over ALL copies, the distinct talks' display names, the copy count, and a title.
  function mergeRequestFromCluster(cluster: SlideCluster): MergeRequest {
    const talkTitles = cluster.kind === 'identical'
      ? cluster.talks.map((slug) => titleBySlug.get(slug) ?? slug)
      : []
    return {
      targets: mergeTargetsFromCluster(cluster),
      talkTitles,
      count: cluster.rows.length,
      title: rowTitle(cluster.rows[0] as SearchResult)
    }
  }
  function requestMerge(cluster: SlideCluster): void {
    if (!onRequestMerge || !clusterMergeable(cluster)) return
    onRequestMerge(mergeRequestFromCluster(cluster))
  }

  // ---------- slide tags (ADR-0037, `t`) ----------
  // The current tag list of one result row: the projection's `tags` (post-tags index rows),
  // falling back to a source parse for rows from a pre-tags cached index.
  function rowTags(row: SearchResult): string[] {
    return row.tags ?? tagsOfBlock(row.source_markdown)
  }
  // The selected rows in visual order — recomputed per render so the optimistic in-place
  // `tags` mutations (versioned via tagsVersion) are always reflected in the picker states.
  const selectedRows = vRows.filter((_r, pos) => selected.has(selRowKey(vRows, pos)))
  const selectedTagLists = selectedRows.map(rowTags)

  function openTagPicker(): void {
    if (selected.size === 0) {
      notify('Select slides first — X selects, ⇧-click ranges, S takes a section.', 'info')
      return
    }
    setTagPickerOpen(true)
  }
  // Selection emptied (Esc / Clear) → the picker has nothing to write to.
  useEffect(() => {
    if (selected.size === 0) setTagPickerOpen(false)
  }, [selected])

  // One tag across the whole selection (merge-only; per-occurrence targets — an identical
  // stack's card targets the SELECTED occurrence, aggregation-by-identity is a read concern).
  async function applyTag(tag: string, action: 'add' | 'remove'): Promise<void> {
    const rows = selectedRows
    if (rows.length === 0 || tagBusy) return
    const targets = tagTargetsFromRows(rows)
    const outlines = [...new Set(targets.map((t) => t.outline))]
    setTagBusy(true)
    try {
      // The active talk may be among the targets — its pending autosave must land first
      // (the detach/adopt flush rule), or the write would race a stale buffer.
      await flushBeforeTagWrite?.(outlines)
      const res = await window.tw.tags.apply(
        targets,
        action === 'add' ? [tag] : [],
        action === 'remove' ? [tag] : []
      )
      if (!res || res.ok !== true) {
        notify('Couldn’t write the tags — nothing was changed.', 'error')
        return
      }
      // Optimistic row update so the picker/chips reflect the write instantly (the search
      // index catches up in the background — tags:apply invalidated the touched talks).
      for (const r of rows) {
        const cur = rowTags(r)
        r.tags = action === 'add' ? (cur.includes(tag) ? cur : [...cur, tag]) : cur.filter((t) => t !== tag)
      }
      setTagsVersion((n) => n + 1)
      if (res.failed.length > 0) {
        notify(`Tagged, but ${res.failed.length} outline${res.failed.length === 1 ? '' : 's'} failed — see the log.`, 'error')
        console.error('[tags] failed outlines', res.failed)
      }
      const written = res.applied.map((a) => a.outline)
      if (written.length > 0) await onTagsApplied?.(written)
    } finally {
      setTagBusy(false)
    }
  }

  // ---------- insert (contract identical to SearchPalette) ----------
  function insertRows(rows: SearchResult[]): void {
    const items = rows.map((r) => ({ markdown: rowMarkdown(r), fromSlug: r.talkSlug, sourceOutlinePath: r.outlinePath }))
    if (items.length === 0) return
    if (items.length > 1 && onInsertMany) onInsertMany(items)
    else items.forEach((it) => onInsert(it.markdown, it.fromSlug, it.sourceOutlinePath))
    onClose()
    // Insert-time merge nudge (Dominik's explicit ask): if any inserted slide is a byte-identical
    // stack of ≥2 that is not already one slide, offer to merge — non-blocking, one nudge, and the
    // action survives this close because it opens the host-mounted confirm.
    if (onRequestMerge) {
      const dupe = rows
        .map((r) => cardByRow.get(r))
        .find((c): c is DisplayCard => Boolean(c && c.kind === 'identical' && c.cluster && clusterMergeable(c.cluster)))
      if (dupe?.cluster) {
        const req = mergeRequestFromCluster(dupe.cluster)
        notify(mergeNudgeLabel(req.count - 1), 'info', 'merge-nudge', {
          label: 'Merge into one',
          onAction: () => onRequestMerge(req)
        })
      }
    }
  }
  function doInsert(): void {
    const chosen = vRows.filter((_r, pos) => selected.has(selRowKey(vRows, pos)))
    insertRows(chosen.length > 0 ? chosen : (vRows[activePos] ? [vRows[activePos]] : []))
  }

  // ---------- version filmstrip (A3 — the signature) + badge counts ----------
  // Fetch versions+whereUsed counts for ONE id and cache them. Used by the strip expansion
  // and the idle background sweep; never called per-card-per-render.
  async function fetchCounts(id: string): Promise<{ versions: number; talks: number } | null> {
    const cached = countsRef.current.get(id)
    if (cached) return cached
    if (countsFetchingRef.current.has(id)) return null
    countsFetchingRef.current.add(id)
    try {
      const [vers, used] = await Promise.all([window.tw.ledger.versions(id), window.tw.ledger.whereUsed(id)])
      const c = { versions: (vers ?? []).length, talks: new Set((used ?? []).map((u) => u.talk)).size }
      countsRef.current.set(id, c)
      setCountsNonce((n) => n + 1)
      return c
    } catch {
      return null
    } finally {
      countsFetchingRef.current.delete(id)
    }
  }

  // Opportunistic badge fill: one uncached id at a time on a 300ms timer, so badges ripen
  // without a burst of IPC on search. NOT requestIdleCallback: verified live that rIC never
  // fires in this Electron renderer window (Chromium idle-period starvation), so the timer
  // is the real path, not the fallback.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    let handle: number | undefined
    const cancel = (h: number): void => window.clearTimeout(h)
    const schedule = (fn: () => void): void => { handle = window.setTimeout(fn, 300) }
    const step = (): void => {
      if (cancelled) return
      const next = vRows
        .map((r) => stampedIdOf(r.source_markdown))
        .find((id): id is string => Boolean(id && !countsRef.current.has(id) && !countsFetchingRef.current.has(id)))
      if (!next) return
      fetchCounts(next).finally(() => { if (!cancelled) schedule(step) })
    }
    schedule(step)
    return () => { cancelled = true; if (handle !== undefined) cancel(handle) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, vRows])

  function closeStrip(): void {
    setOpenStrip(null)
  }
  function closeLoc(): void {
    setOpenLoc(null)
  }

  // Expand/collapse the identical-stack LOCATIONS panel (the "in N talks" pill or E on an identical
  // stack). Shares the expansion slot with the filmstrip, so only one thing is open at a time.
  function toggleLocations(pos: number): void {
    const card = vCards[pos]
    if (!card || card.kind !== 'identical' || !card.cluster) return
    const rowKey = selRowKey(vRows, pos)
    setOpenStrip(null)
    setOpenLoc((cur) => (cur?.rowKey === rowKey ? null : { rowKey, cluster: card.cluster! }))
  }
  // Uncollapse / re-collapse a near cluster (the Uncollapse control or U on a near card/variant).
  function toggleNear(pos: number): void {
    const key = vCards[pos]?.nearKey
    if (!key) return
    setNearExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }

  // Expand/collapse the filmstrip for the card at `pos` (badge click or E). One strip open
  // at a time; expanding another card replaces the first. Thumbnails render in ONE hidden-
  // window batch per id (content-cached server-side), fired once per expansion.
  async function toggleStrip(pos: number): Promise<void> {
    const row = vRows[pos]
    if (!row) return
    const id = stampedIdOf(row.source_markdown)
    if (!id) return // unstamped — no badge, nothing to expand
    const rowKey = selRowKey(vRows, pos)
    if (openStrip?.rowKey === rowKey) { closeStrip(); return }
    setOpenLoc(null)
    setOpenStrip({ id, rowKey, versions: null, thumbs: null })
    try {
      const [vers, used] = await Promise.all([window.tw.ledger.versions(id), window.tw.ledger.whereUsed(id)])
      const list = vers ?? []
      countsRef.current.set(id, { versions: list.length, talks: new Set((used ?? []).map((u) => u.talk)).size })
      setCountsNonce((n) => n + 1)
      if (list.length === 0) {
        setOpenStrip((s) => (s?.rowKey === rowKey ? null : s))
        notify('No versions yet — versions appear when you save changes.', 'info')
        return
      }
      setOpenStrip((s) => (s?.rowKey === rowKey ? { ...s, versions: list } : s))
      window.tw.ledger.versionThumbnails(id)
        .then((t) => setOpenStrip((s) => (s?.rowKey === rowKey ? { ...s, thumbs: t ?? {} } : s)))
        .catch(() => setOpenStrip((s) => (s?.rowKey === rowKey ? { ...s, thumbs: {} } : s)))
    } catch {
      setOpenStrip((s) => (s?.rowKey === rowKey ? null : s))
    }
  }

  // Insert ONE recorded version at the caret. The version's own vault-relative `outline`
  // (its source talk) resolves against vaultRoot for asset materialisation — an old
  // version's relative images live in ITS talk, not the card's current one; the card's
  // outlinePath is only the fallback for pre-outline ledger records. Mockup behaviour:
  // the button flashes 'Inserted ✓' and the Browser STAYS OPEN (unlike the tray insert).
  function insertVersion(v: LedgerVersion, row: SearchResult): void {
    const sourceOutlinePath = v.outline ? `${vaultRoot.replace(/\/$/, '')}/${v.outline}` : row.outlinePath
    onInsert(v.markdown, v.talk ?? row.talkSlug, sourceOutlinePath)
    setFlashFile(v.file)
    window.setTimeout(() => setFlashFile((f) => (f === v.file ? null : f)), 900)
  }

  // The filmstrip itself — versions as archival prints, newest first, canonical starred.
  function renderStrip(anchor: number, row: SearchResult): React.ReactElement | null {
    if (!openStrip || !row) return null
    const versions = openStrip.versions
    const canon = versions ? canonicalVersion(versions) : null
    return (
      <StripRow key={`strip:${openStrip.rowKey}`} anchor={anchor}>
        <div className="lt-strip-inner" onClick={(e) => e.stopPropagation()}>
          <div className="lt-strip-head">
            <span className="lt-sh-title">Versions — newest first</span>
            <span className="lt-sh-id">id={openStrip.id}</span>
            <button type="button" className="lt-sh-close" title="Close versions (Esc)" onClick={closeStrip}>
              <X className="lt-icon" />
            </button>
          </div>
          <div className="lt-strip">
            {versions === null &&
              [0, 1].map((i) => (
                <div key={i} className="lt-vprint">
                  <div className="lt-vframe"><div className="lt-vthumb"><div className="lt-sk-thumb" /></div></div>
                </div>
              ))}
            {versions?.map((v, idx) => {
              const isCanon = canon !== null && v.file === canon.file
              // Unsealed but superseded = a later save replaced it without a presenting/
              // export/publish seal; only the head is genuinely 'current session'.
              const seal = v.sealedBy
                ? `sealed by ${v.sealedBy === 'present' ? 'presenting' : v.sealedBy}`
                : idx === 0 ? 'current session' : 'sealed by later edit'
              const srcTalk = (v.talk && (titleBySlug.get(v.talk) ?? v.talk)) || row.talkTitle
              return (
                <div key={v.file} className={`lt-vprint${isCanon ? ' canonical' : ''}`}>
                  <div className="lt-vframe">
                    <VersionThumb
                      url={openStrip.thumbs?.[v.file]}
                      pending={openStrip.thumbs === null}
                      title={versionTitle(v.markdown)}
                    />
                  </div>
                  <div className="lt-vcap">
                    <div className="lt-vdate">
                      {isCanon && <span className="lt-star"><Star className="lt-icon" /></span>}
                      {VDATE_FMT.format(new Date(v.savedAt))}{isCanon ? ' · canonical' : ''}
                    </div>
                    <div className="lt-vsrc" title={srcTalk}>{srcTalk}</div>
                    <div className="lt-vseal">{seal}</div>
                  </div>
                  <button
                    type="button"
                    className="lt-vact"
                    onClick={(e) => { e.stopPropagation(); insertVersion(v, row) }}
                  >
                    {flashFile === v.file ? 'Inserted ✓' : 'Insert this version ↵'}
                  </button>
                  {onAdoptVersion && (
                    <button
                      type="button"
                      className="lt-vact lt-vact-adopt"
                      title="Replace this slide with this version in other presentations (A5)"
                      onClick={(e) => {
                        e.stopPropagation()
                        onAdoptVersion(openStrip!.id, {
                          file: v.file,
                          markdown: v.markdown,
                          savedAt: v.savedAt,
                          talk: v.talk ?? row.talkSlug,
                          canonical: isCanon
                        })
                      }}
                    >
                      Adopt this version in…
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </StripRow>
    )
  }

  // The identical-stack LOCATIONS panel — the where-used list for a byte-identical cluster, in the
  // same expansion slot as the filmstrip. Each copy: talk (serif, authored case) · §section · slide,
  // a real thumbnail, insert-this-copy + Show in Finder, and a prominent Merge-into-one action.
  function renderLocations(anchor: number): React.ReactElement | null {
    if (!openLoc || openLoc.cluster.kind !== 'identical') return null
    const cluster = openLoc.cluster
    const rows = cluster.rows as SearchResult[]
    const mergeable = clusterMergeable(cluster)
    const alreadyOne = clusterAlreadyOneSlide(cluster)
    return (
      <StripRow key={`loc:${openLoc.rowKey}`} anchor={anchor}>
        <div className="lt-strip-inner lt-locs" onClick={(e) => e.stopPropagation()}>
          <div className="lt-strip-head">
            <span className="lt-sh-title">
              Where this slide lives — {cluster.count} identical {cluster.count === 1 ? 'copy' : 'copies'}
            </span>
            <span className="lt-sh-id">{inTalksLabel(cluster.talks.length)}</span>
            <button type="button" className="lt-sh-close" title="Close locations (Esc)" onClick={closeLoc}>
              <X className="lt-icon" />
            </button>
          </div>
          <div className="lt-loc-list">
            {rows.map((r, i) => {
              const sk = sectionKey(r.talkSlug, r.section ?? '')
              const secNo = sectionNoByKey.get(sk)
              return (
                <div key={`${r.outlinePath}#${i}`} className="lt-loc-row">
                  <div className="lt-loc-thumb">
                    <Thumb
                      key={`${r.talkSlug}/${r.render_hash || r.content_hash}:${thumbNonces[r.talkSlug] ?? 0}`}
                      row={r}
                      regenerating={regenTalk === r.talkSlug}
                      onUnavailable={noteThumbUnavailable}
                    />
                  </div>
                  <div className="lt-loc-meta">
                    <div className="lt-loc-talk" title={r.talkTitle || r.talkSlug}>{r.talkTitle || r.talkSlug}</div>
                    <div className="lt-loc-where">
                      {r.section
                        ? <>{secNo ? <span className="lt-loc-sec">§{secNo}</span> : null} {secName(sk, r.section)} · {rowTitle(r)}</>
                        : rowTitle(r)}
                    </div>
                  </div>
                  <div className="lt-loc-acts">
                    <button type="button" className="lt-loc-btn" onClick={() => insertRows([r])}>
                      <ArrowDown className="lt-icon" /> Insert this copy
                    </button>
                    <button
                      type="button"
                      className="lt-loc-btn ghost"
                      title="Reveal the outline in Finder"
                      onClick={() => void window.tw.shell.showInFolder(r.outlinePath)}
                    >
                      <FolderOpen className="lt-icon" /> Finder
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="lt-loc-foot">
            {alreadyOne ? (
              <span className="lt-loc-oneslide">
                <Check className="lt-icon" /> Already one slide — every copy shares a ledger id.
              </span>
            ) : (
              <>
                <span className="lt-loc-reassure">
                  Merging stamps every copy with one shared id, so they become a single slide — searches
                  show it once. Nothing is lost; each copy’s content is unchanged.
                </span>
                <span className="lt-loc-spacer" />
                <button
                  type="button"
                  className="lt-btn primary"
                  disabled={!mergeable || !onRequestMerge}
                  onClick={() => requestMerge(cluster)}
                >
                  <GitMerge className="lt-icon" /> Merge into one slide
                </button>
              </>
            )}
          </div>
        </div>
      </StripRow>
    )
  }

  // Whichever expansion is open (versions filmstrip or identical-stack locations) fills the slot.
  function renderExpansion(anchor: number, row: SearchResult): React.ReactElement | null {
    if (openStrip) return renderStrip(anchor, row)
    if (openLoc) return renderLocations(anchor)
    return null
  }

  // ---------- rail: scope + facet handlers ----------
  function handleScope(entry: ScopeEntry, additive: boolean): void {
    // The active talk is never scopeable — its slides are never on the table. The tree's
    // row for it is non-scoping anyway; this backstops any other path.
    if (entry.talk && entry.talk === currentTalkSlug) return
    setScope((s) => toggleScope(s, entry, additive))
  }
  function removeScopeAt(i: number): void {
    setScope((s) => s.filter((_e, idx) => idx !== i))
  }
  function clearScope(): void {
    setScope([])
  }
  function toggleFacet(kind: FacetKind, value: string): void {
    setFacets((f) => {
      const key = kind === 'tag' ? 'tagSet' : kind === 'sec' ? 'sectionSet' : kind === 'lay' ? 'layoutSet' : 'contentSet'
      const n = new Set(f[key] as Set<string>)
      if (n.has(value)) n.delete(value)
      else n.add(value)
      return { ...f, [key]: n } as RailFacets
    })
  }
  function clearFacets(): void {
    setFacets(emptyFacets())
  }
  function setView(v: 'side' | 'seq'): void {
    setViewPref(v)
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, v) } catch { /* ignore */ }
  }

  // ---------- rail: derived data (all over in-memory rows — no IPC in the hot path) ----------
  const countBySlug = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of fullRows) m.set(r.talkSlug, (m.get(r.talkSlug) ?? 0) + 1)
    return m
  }, [fullRows])

  // Files tree: disk truth (vault talk list) for folders/talks; sections observed from the
  // full index snapshot, in outline order, with authored labels.
  const fileTree = useMemo<TreeFolder[]>(() => {
    const secsBySlug = new Map<string, Array<{ sec: string; label: string; count: number }>>()
    for (const r of fullRows) {
      const sec = r.section ?? ''
      if (sec === '') continue
      let list = secsBySlug.get(r.talkSlug)
      if (!list) { list = []; secsBySlug.set(r.talkSlug, list) }
      const hit = list.find((s) => s.sec === sec)
      if (hit) hit.count++
      else list.push({ sec, label: secName(sectionKey(r.talkSlug, sec), sec), count: 1 })
    }
    const folders: TreeFolder[] = []
    for (const t of talks) {
      const fname = topicOf(t.path)
      let folder = folders.find((f) => f.name === fname)
      if (!folder) { folder = { name: fname, count: 0, talks: [] }; folders.push(folder) }
      const count = countBySlug.get(t.slug) ?? talkMeta[t.slug]?.slideCount ?? 0
      folder.count += count
      folder.talks.push({ slug: t.slug, title: t.title || t.slug, count, sections: secsBySlug.get(t.slug) ?? [] })
    }
    return folders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talks, fullRows, countBySlug, talkMeta, sectionNames])

  // Search reports both kinds: talks whose TITLE matches the query cluster above the results.
  // The active talk never appears — its rows are never on the table, so scoping to it would
  // only ever produce an empty grid.
  const talkHits = useMemo(() => {
    if (query.trim() === '') return []
    const hits = talkTitleHits(
      talks.filter((t) => t.slug !== currentTalkSlug).map((t) => ({ slug: t.slug, title: t.title || t.slug })),
      parsedQuery.terms
    )
    return hits.slice(0, 12).map((h) => ({ ...h, count: countBySlug.get(h.slug) ?? talkMeta[h.slug]?.slideCount ?? 0 }))
  }, [query, talks, parsedQuery, countBySlug, talkMeta, currentTalkSlug])

  const scopeCounts = useMemo(
    () => scope.map((e) => fullRows.reduce((n, r) => n + (rowInScopeEntry(r, e, folderOf) ? 1 : 0), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, fullRows, folderBySlug]
  )
  function coverUrlFor(e: ScopeEntry): string | null {
    if (!e.talk) return null
    const key = talkMeta[e.talk]?.coverKey
    return key ? `twthumb://${e.talk}/${key}` : null
  }

  // Collections: lenses over the vault (recently edited via talkMeta; recently delivered
  // via the recording ledger's delivery sessions, latest first).
  const recentEdits = useMemo<CollectionRow[]>(() => {
    return Object.entries(talkMeta)
      .filter(([, m]) => (m.editedMs ?? 0) > 0)
      .sort((a, b) => b[1].editedMs - a[1].editedMs)
      .slice(0, 6)
      .map(([slug, m]) => ({
        key: `edit:${slug}`,
        slug,
        title: titleBySlug.get(slug) ?? slug,
        when: agoLabel(m.editedMs)
      }))
  }, [talkMeta, titleBySlug])
  const deliveries = useMemo<CollectionRow[]>(() => {
    return [...deliverySessions]
      .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
      .slice(0, 8)
      .map((s) => ({
        key: `run:${s.id}`,
        slug: s.talkSlug,
        title: s.talkTitle || titleBySlug.get(s.talkSlug) || s.talkSlug,
        sub: s.context ?? undefined,
        when: agoLabel(Date.parse(s.endedAt))
      }))
  }, [deliverySessions, titleBySlug])

  // Facet vocabularies + counts. Scope + search always condition everything; on top of that
  // (v0.15.2 tweak) each kind's counts are CONDITIONED BY THE OTHER ACTIVE KINDS — leave-one-
  // out, the standard faceted-search law — so combining filters can never dead-end
  // unannounced (layout=list 576 + has-code 60 → zero was exactly this lie). A chip whose
  // conditioned count is 0 renders dimmed (still clickable) with "0". All in-memory: one
  // pass per facet-state change over the already-filtered rows, memoised — no IPC.
  const baseRows = useMemo(
    () => visibleResults.filter((r) => rowInScope(r, scope, folderOf)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleResults, scope, folderBySlug]
  )
  const facetBases = useMemo(
    () => facetKindBases(baseRows, facets, secLabelOf, rowTags),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseRows, facets, sectionNames]
  )
  const layoutItems = useMemo<FacetItem[]>(() => {
    const names = new Set<string>(LAYOUTS.filter((l) => l.kind === 'layout').map((l) => l.name))
    for (const r of fullRows) names.add(facetLayoutOf(r))
    const counts = new Map<string, number>()
    for (const r of facetBases.lay) counts.set(facetLayoutOf(r), (counts.get(facetLayoutOf(r)) ?? 0) + 1)
    return [...names]
      .map((value) => ({ value, count: counts.get(value) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }, [fullRows, facetBases])
  const contentItems = useMemo<ContentItem[]>(
    () => CONTENT_KEYS.map((key) => ({
      key,
      label: CONTENT_LABELS[key],
      count: facetBases.ct.reduce((n, r) => n + (rowHasContent(r, key) ? 1 : 0), 0)
    })),
    [facetBases]
  )
  const tagItems = useMemo<FacetItem[]>(() => {
    const vault = new Map<string, number>(tagVocab.map((t) => [t.name, t.count]))
    for (const r of fullRows) for (const t of rowTags(r)) if (!vault.has(t)) vault.set(t, 0)
    const counts = new Map<string, number>()
    for (const r of facetBases.tags) for (const t of rowTags(r)) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...vault.entries()]
      .map(([value, vaultCount]) => ({ value, count: counts.get(value) ?? 0, vaultCount }))
      .sort((a, b) => b.count - a.count || b.vaultCount - a.vaultCount || a.value.localeCompare(b.value))
      .map(({ value, count }) => ({ value, count }))
  }, [tagVocab, fullRows, facetBases])
  const sectionItems = useMemo<FacetItem[]>(() => {
    // Vocabulary from the scope+search base (a section zeroed by OTHER kinds must still be
    // LISTED — dimmed with 0, never vanished); counts from the leave-Sections-out base.
    const counts = new Map<string, number>()
    for (const r of baseRows) {
      const label = secLabelOf(r)
      if (label !== '' && !counts.has(label)) counts.set(label, 0)
    }
    for (const r of facetBases.secs) {
      const label = secLabelOf(r)
      if (label === '') continue
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    // Active selections stay listed (and removable) even when the scope no longer shows them.
    for (const s of facets.sectionSet) if (!counts.has(s)) counts.set(s, 0)
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRows, facetBases, facets.sectionSet, sectionNames])

  // ---------- the insert-decision viewer (↵ on a card) ----------
  // The viewed slide's source talk, WHOLE deck, in outline order — from the index snapshot
  // (no compile). The query-narrowed results are only the fallback for a talk the snapshot
  // hasn't caught yet.
  const viewerDeck = useMemo<SearchResult[]>(() => {
    if (!viewer) return []
    const src = fullRows.some((r) => r.talkSlug === viewer.slug) ? fullRows : results
    return src
      .filter((r) => r.talkSlug === viewer.slug)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }, [viewer, fullRows, results])
  const viewerIndex = viewer
    ? Math.max(0, viewerDeck.findIndex((r) => (r.order ?? 0) === viewer.order))
    : 0

  function openViewer(row: SearchResult): void {
    // The viewer is the topmost Browser layer — anything floating (settings popover, Space
    // preview) closes first; the grid itself (scroll, expansion, selection) stays put so
    // Esc lands back exactly where the user was.
    setOpenPop(null)
    setPreview(false)
    setViewer({ slug: row.talkSlug, order: row.order ?? 0 })
  }
  // The viewer's ⌘↵: the existing insert flow (caret splice, merge nudge, Browser close),
  // then the confirmation toast the spec asks for.
  function viewerInsert(rows: SearchResult[]): void {
    setViewer(null)
    insertRows(rows)
    notify(
      `Inserted ${rows.length} slide${rows.length === 1 ? '' : 's'} at the caret.`,
      'success'
    )
  }

  // ---------- keyboard (capture; ⌘S + ? are handled by the workspace's global handler) ----------
  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent): void {
      // The cheat-sheet (or another overlay) sits above the Browser: hand it EVERY key,
      // including Esc and Tab — otherwise Esc would run both close paths at once.
      if (suspendKeys) return
      // The tag picker owns every key while open (its own capture handler registered after
      // this one takes ↑↓ ↵ ⎋; everything else is typing in its filter input).
      if (tagPickerOpen) return
      // The insert-decision viewer owns EVERY key while open (its own capture handler,
      // registered on mount, handles Esc/arrows/⌘↵ and traps Tab inside itself).
      if (viewer) return
      const el = document.activeElement
      const inSearch = el === inputRef.current
      const inField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      // Keyboard parity (Gate-5): a Tab-focused BUTTON (rail chip, scope ×, tree row, tray
      // action) must keep its own ↵/Space activation — the grid never steals those from the
      // control the keyboard user just reached.
      const onButton = el instanceof HTMLButtonElement
      const mod = e.metaKey || e.ctrlKey

      // Basic focus trap: Tab cycles within the overlay (visible controls only —
      // closed .lt-pop popovers are focusable in the DOM but hidden).
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = [...rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
        )].filter((f) => {
          const style = window.getComputedStyle(f)
          return style.visibility !== 'hidden' && style.display !== 'none' && f.offsetParent !== null
        })
        if (focusables.length > 0) {
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && el === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && el === last) { e.preventDefault(); first.focus() }
          else if (!el || !rootRef.current.contains(el)) { e.preventDefault(); first.focus() }
        }
        return
      }

      // The rail's inline vocabulary inputs own their Esc (clear the query first, THEN blur —
      // taste rule): let the event through untouched so their own handler runs.
      if (e.key === 'Escape' && el instanceof HTMLInputElement && el.dataset.railEsc === '1') return

      // Esc ladder: popover → preview → filmstrip → locations → clear search (typing) → selection → close.
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        if (openPop) { setOpenPop(null); return }
        if (preview) { setPreview(false); return }
        if (openStrip) { closeStrip(); return }
        if (openLoc) { closeLoc(); return }
        if (inSearch && query) { setQuery(''); return }
        if (selected.size > 0) { setSelected(new Set()); return }
        onClose(); return
      }
      if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doInsert(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // ←/→ keep moving the caret while typing; only ↑↓ pull focus into the grid.
        if (inField && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
        e.preventDefault(); e.stopPropagation()
        if (inField) (el as HTMLElement).blur()
        setActivePos((p) => {
          // Side-by-side columns are 2 cards across — ↑↓ must step by the REAL row width.
          const next = gridNavigate(p, e.key, gridMode === 'side' ? 2 : density, vRows.length)
          if (e.shiftKey) extendTo(next)
          else anchorRef.current = next
          return next
        })
        return
      }
      if (inField) return // the rest are grid-only — never hijack typing
      // ⌫ clears the scope (the rail's key — mirrors the Clear-scope row).
      if (e.key === 'Backspace' && !mod && !e.altKey) {
        if (scope.length > 0) { e.preventDefault(); e.stopPropagation(); clearScope() }
        return
      }
      if (['2', '3', '4', '5', '6'].includes(e.key) && !mod && !e.altKey) {
        e.preventDefault(); e.stopPropagation(); setDensity(Number(e.key)); return
      }
      // Letter/plain keys never fire with a modifier held — ⌘I (icon picker), ⌘E etc. belong
      // to the workspace's own bindings.
      const plain = !mod && !e.altKey
      if (plain && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); e.stopPropagation(); toggleAt(activePos); return }
      if (plain && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation(); selectActiveSection(); return }
      // T: tag the selection (ADR-0037) — opens the tray-anchored picker.
      if (plain && (e.key === 't' || e.key === 'T')) { e.preventDefault(); e.stopPropagation(); openTagPicker(); return }
      // Space previews, with P as its SearchPalette-parity alias (⌘Y deliberately dropped — redundant).
      // Space on a focused button is that button's click — leave it alone.
      if (plain && e.key === ' ' && onButton) return
      if (plain && (e.key === ' ' || e.key === 'p' || e.key === 'P')) { e.preventDefault(); e.stopPropagation(); setPreview((p) => !p); return }
      if (plain && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); e.stopPropagation(); setRailCollapsed((c) => !c); return }
      // E: an identical stack opens its locations panel; any other stamped card opens its versions
      // filmstrip; a collapsed near stack ignores E (U is its key).
      if (plain && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault(); e.stopPropagation()
        const card = vCards[activePos]
        if (card?.kind === 'identical') toggleLocations(activePos)
        else if (card?.kind !== 'near') void toggleStrip(activePos)
        return
      }
      // U: uncollapse / re-collapse a near cluster (from its collapsed card or any of its variants).
      // [Task 12: fold E=versions/locations and U=uncollapse into the app-wide cheat-sheet.]
      if (plain && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault(); e.stopPropagation()
        toggleNear(activePos)
        return
      }
      // ↵ opens the INSERT-DECISION VIEWER for the slide under the cursor — never the
      // editor, never a talk switch (v0.15.x decision).
      if (plain && e.key === 'Enter') {
        if (onButton) return // ↵ on a focused button is that button's click — leave it alone
        e.preventDefault(); e.stopPropagation()
        if (vRows[activePos]) openViewer(vRows[activePos])
        return
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, suspendKeys, tagPickerOpen, viewer, vCards, vRows, activePos, density, gridMode, scope, preview, openPop, openStrip, openLoc, query, selected, onClose])

  if (!isOpen) return null
  const activeRow = vRows[activePos]

  // ---------- card + grid renderers (shared by all three view modes) ----------
  // Where the open expansion (version filmstrip OR identical-stack locations) sits in the
  // visual order (or -1: the card was filtered away, so the panel just doesn't render).
  const expandedRowKey = openStrip?.rowKey ?? openLoc?.rowKey ?? null
  const expandedPos = expandedRowKey
    ? vRows.findIndex((_r, i) => selRowKey(vRows, i) === expandedRowKey)
    : -1

  // One card at visual position `p`. `ordinal` (outline views only) is the slide's REAL
  // outline position in its talk — the position badge the lock demands.
  function renderCard(c: DisplayCard, p: number, ordinal?: number): React.ReactElement {
    const row = c.row as SearchResult
    const rowKey = selRowKey(vRows, p)
    const isSel = selected.has(rowKey)
    const isFocused = p === activePos
    const isExpanded = expandedRowKey === rowKey
    const isIdentical = c.kind === 'identical'
    const isNear = c.kind === 'near'
    const isVariant = c.kind === 'near-variant'
    const layout = layoutOf(row)
    const showTag = layout && layout !== DEFAULT_LAYOUT
    const ledgerId = stampedIdOf(row.source_markdown)
    const vCounts = ledgerId ? countsRef.current.get(ledgerId) : undefined
    const badgeParts = vCounts ? versionBadgeParts(vCounts.versions, vCounts.talks) : null
    // A collapsed stack shows the "in N talks" pill (not a version badge — which
    // copy's versions would it be?); singles and near-variants show it as before.
    const showVersionBadge = !isIdentical && !isNear
    const secNo = sectionNoByKey.get(sectionKey(row.talkSlug, row.section ?? ''))
    // The active talk's rows are never on the table, so origin is always another talk.
    const origin = row.talkTitle + (secNo ? ` · §${secNo}` : '')
    const cardTitle = isIdentical
      ? `${c.count} byte-identical copies — E for where they live`
      : isNear
        ? `${c.count} near-identical variants — U to uncollapse and compare`
        : 'Click selects · ⇧-click range · Space preview · ↵ view & insert'
    return (
      // Keyed by rowKey + position: outline views render EVERY occurrence (no duplicate
      // collapse), and byte-identical copies inside one talk can share a derived slide_id.
      <div
        key={`${rowKey}@${p}`}
        data-pos={p}
        data-kind={c.kind}
        className={`lt-card${isSel ? ' selected' : ''}${isFocused ? ' focused' : ''}${isExpanded ? ' expanded' : ''}${isIdentical ? ' stack' : ''}${isNear ? ' nearstack' : ''}${isVariant ? ' variant' : ''}`}
        style={{ ['--i' as string]: Math.min(p, STAGGER_CAP) }}
        title={cardTitle}
        onClick={(e) => {
          if (e.shiftKey) { setActivePos(p); extendTo(p) } else toggleAt(p)
          setActivePos(p)
        }}
        onMouseEnter={() => setActivePos(p)}
      >
        <div className="lt-sel-mark"><Check className="lt-icon" /></div>
        {ordinal != null && <span className="lt-ordn">{String(ordinal).padStart(2, '0')}</span>}
        <div className="lt-print">
          <Thumb
            key={`${row.talkSlug}/${row.render_hash || row.content_hash}:${thumbNonces[row.talkSlug] ?? 0}`}
            row={row}
            regenerating={regenTalk === row.talkSlug}
            onUnavailable={noteThumbUnavailable}
          />
        </div>
        <div className="lt-label">
          <div className="lt-l-title">{rowTitle(row)}</div>
          <div className="lt-l-meta">
            {showTag && <span className="lt-tag">{layout}</span>}
            {isVariant && <span className="lt-tag lt-variant-tag">variant {c.variantIndex}</span>}
            {/* Curated tags (ADR-0037): small filled mono chips, mockup grammar. */}
            {rowTags(row).map((t) => (
              <span key={`tag:${t}`} className="lt-minitag">{t}</span>
            ))}
            <span className="lt-origin" title={origin}>{origin}</span>
            {/* Version badge: only stamped rows (a real {id=…}) carry one.
                Counts ripen lazily from the cache — no per-card IPC.
                Gate-4 honesty: before this id's counts are actually in the
                cache the badge says NOTHING (silent shimmer pill) — the
                dashed 'no versions yet' means a fetch confirmed zero. */}
            {showVersionBadge && ledgerId && !vCounts && <span className="lt-vbadge-sk" aria-hidden="true" />}
            {showVersionBadge && ledgerId && vCounts && vCounts.versions === 0 && (
              <span className="lt-vbadge novers" title="No versions yet — versions appear when you save changes">
                <GitBranch className="lt-icon" />
                no versions yet
              </span>
            )}
            {showVersionBadge && ledgerId && vCounts && vCounts.versions > 0 && (
              <button
                type="button"
                className="lt-vbadge"
                title="Show versions (E)"
                onClick={(e) => { e.stopPropagation(); void toggleStrip(p) }}
              >
                <GitBranch className="lt-icon" />
                {badgeParts ? badgeParts.base : 'versions'}
                {badgeParts?.long ? <span className="long">{badgeParts.long}</span> : null}
              </button>
            )}
            {/* Identical stack: the "in N talks" pill opens the where-used
                locations panel (also E) — the merge action lives inside it. */}
            {isIdentical && (
              <button
                type="button"
                className={`lt-clusterbadge${isExpanded ? ' on' : ''}`}
                title="Where this slide lives — and merge into one (E)"
                onClick={(e) => { e.stopPropagation(); toggleLocations(p) }}
              >
                <Layers className="lt-icon" />
                {inTalksLabel(c.talks?.length ?? 0)}
              </button>
            )}
            {/* Near stack: an obvious Uncollapse control (also U). */}
            {isNear && (
              <button
                type="button"
                className="lt-nearbadge"
                title="Uncollapse to compare the variants (U)"
                onClick={(e) => { e.stopPropagation(); toggleNear(p) }}
              >
                <ChevronsUpDown className="lt-icon" />
                {nearCountLabel(c.count ?? 0)} · uncollapse
              </button>
            )}
            {/* Near variant: a re-collapse affordance (also U). */}
            {isVariant && (
              <button
                type="button"
                className="lt-nearbadge ghost"
                title="Collapse these variants back (U)"
                onClick={(e) => { e.stopPropagation(); toggleNear(p) }}
              >
                <ChevronsDownUp className="lt-icon" />
                collapse
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // A grid of cards starting at visual position `base`, `cols` across, with the open
  // expansion (filmstrip / locations) inserted after the end of the grid row holding the
  // expanded card — its ::before caret pointing at the card's centre. The same renderer
  // serves the grouped view (density cols), outline view (density cols + ordinals) and
  // side-by-side columns (2 cols + ordinals).
  function renderGrid(cards: DisplayCard[], base: number, cols: number, ordinals: boolean): React.ReactElement {
    const jExp = expandedPos >= base && expandedPos < base + cards.length ? expandedPos - base : -1
    const expAfter = jExp >= 0
      ? Math.min(cards.length - 1, (Math.floor(jExp / cols) + 1) * cols - 1)
      : -1
    return (
      <div className={`lt-grid g${cols}`}>
        {cards.map((c, j) => {
          const p = base + j
          const card = renderCard(c, p, ordinals ? ((c.row as SearchResult).order ?? 0) + 1 : undefined)
          if (j !== expAfter) return card
          return (
            <Fragment key={`${selRowKey(vRows, p)}@${p}+exp`}>
              {card}
              {renderExpansion(stripAnchorPercent(jExp % cols, cols), vRows[expandedPos])}
            </Fragment>
          )
        })}
      </div>
    )
  }

  // One talk's outline-ordered, section-headed chunks (outline + side-by-side views).
  function renderTalkChunks(t: { slug: string; title: string; total: number; chunks: Array<{ section: string; label: string; cards: DisplayCard[] }> }, base: number, cols: number): React.ReactNode {
    let b = base
    return (
      <>
        {t.chunks.map((c) => {
          const chunkBase = b
          b += c.cards.length
          return (
            <div key={`${t.slug}\n${c.section}`} className="lt-outline-sec">
              {c.section !== '' && (
                <div className="lt-sec-head">
                  <span>§ {c.label}</span>
                  <span className="lt-sec-n">{c.cards.length}</span>
                </div>
              )}
              {renderGrid(c.cards, chunkBase, cols, true)}
            </div>
          )
        })}
        {t.total === 0 && (
          <div className="lt-col-zero">
            No slides in <b>{t.title}</b> match the current search and filters.
          </div>
        )}
      </>
    )
  }

  const nVisibleTalks = new Set(vRows.map((r) => r.talkSlug)).size
  const countLabel = unavailable
    ? 'search unavailable'
    : loading
      ? 'searching…'
      : gridMode === 'grouped'
        ? `${display.slideCount} slide${display.slideCount === 1 ? '' : 's'} · ${sectionCount} section${sectionCount === 1 ? '' : 's'}`
        : `${vRows.length} slide${vRows.length === 1 ? '' : 's'} · ${nVisibleTalks} talk${nVisibleTalks === 1 ? '' : 's'}`

  return (
    <div
      ref={rootRef}
      className="lt lt-browser-root"
      role="dialog"
      aria-modal="true"
      aria-label="Slide Browser"
      onClick={() => setOpenPop(null)}
    >
      {/* ================= top chrome ================= */}
      <header className="lt-topbar">
        <div className="lt-brand">
          <span className="lt-wordmark">TalkWeaver</span>
          <span className="lt-room">Slide Browser</span>
        </div>
        {/* ↵ opens the insert-decision viewer (v0.15.x) — the old "Focus" tab promised a
            talk-switching flow that no longer exists, so the nav is just the room label. */}
        <nav className="lt-viewtabs" aria-label="View">
          <button className="active" type="button">
            <LayoutGrid className="lt-icon" /> Browser <kbd>⌘S</kbd>
          </button>
        </nav>
        <div className="lt-top-spacer" />
        <span className="lt-result-count">{countLabel}</span>
        <div className="lt-density">
          <span>Across</span>
          <div className="lt-steps">
            {[2, 3, 4, 5, 6].map((d) => (
              <button
                key={d}
                type="button"
                className={density === d ? 'active' : ''}
                title={`${d} across (${d})`}
                onClick={() => setDensity(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div
          className="lt-tool-btn iconbtn"
          role="button"
          tabIndex={0}
          title="Browser settings — full settings in Settings (⌘,)"
          style={{ cursor: 'pointer' }}
          onClick={(e) => { e.stopPropagation(); setOpenPop((p) => (p === 'settings' ? null : 'settings')) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setOpenPop((p) => (p === 'settings' ? null : 'settings')) } }}
        >
          <Settings2 className="lt-icon" />
          {/* settings glimpse: these options LIVE in Settings (Task 11); the popover is a shortcut */}
          <div className={`lt-pop${openPop === 'settings' ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="lt-pop-title">Slide Browser settings</div>
            <div className="lt-pop-sub">A glimpse of Settings → Slide Browser. Nothing is configured from the chrome itself.</div>
            <div className="lt-prow">
              <span className="lt-pl">Default density<span className="lt-ph">Used when the Browser opens fresh</span></span>
              <div className="lt-steps-sm">
                {[2, 3, 4, 5, 6].map((d) => (
                  <button key={d} type="button" className={glimpseDensity === d ? 'active' : ''} onClick={() => setGlimpseDensity(d)}>{d}</button>
                ))}
              </div>
            </div>
            <div className="lt-prow">
              <span className="lt-pl">Reopen with last filters<span className="lt-ph">Remember search, Talk and layout filters between openings</span></span>
              <button type="button" className={`lt-switch${glimpseLastFilters ? ' on' : ''}`} title="Toggle" onClick={() => setGlimpseLastFilters((v) => !v)} />
            </div>
            <div className="lt-prow">
              <span className="lt-pl">Open scoped to current Talk<span className="lt-ph">⌘S from the editor pre-filters to the Talk you are in</span></span>
              <button type="button" className={`lt-switch${glimpseScoped ? ' on' : ''}`} title="Toggle" onClick={() => setGlimpseScoped((v) => !v)} />
            </div>
            <div className="lt-pop-foot">Full page, searchable, with the settings changelog: <b>Settings ⌘,</b> → Slide Browser.</div>
          </div>
        </div>
        <button
          type="button"
          className="lt-tool-btn iconbtn lt-help-btn"
          title="Keyboard cheat-sheet (?)"
          onClick={(e) => { e.stopPropagation(); onOpenHelp() }}
        >
          ?
        </button>
      </header>

      {/* ================= browser view ================= */}
      <section className="lt-view">
        <div className="lt-browser-body">
          <button
            type="button"
            className={`lt-rail-reopen${railCollapsed ? ' show' : ''}`}
            title="Show rail (I)"
            onClick={() => setRailCollapsed(false)}
          >
            <ChevronRight className="lt-icon" />
          </button>

          {/* ---------- the unified rail (ADR-0009) ---------- */}
          <aside className={`lt-urail${railCollapsed ? ' collapsed' : ''}`} aria-label="Browser rail">
            <div className="lt-rail-head">
              <span className="lt-rail-title">Browser</span>
              <button type="button" className="lt-rail-collapse" title="Collapse rail (I)" onClick={() => setRailCollapsed(true)}>
                <ChevronLeft className="lt-icon" />
              </button>
            </div>
            <BrowserRail
              inputRef={inputRef}
              query={query}
              onQueryChange={setQuery}
              talkHits={talkHits}
              currentTalkSlug={currentTalkSlug}
              scope={scope}
              scopeCounts={scopeCounts}
              coverUrlFor={coverUrlFor}
              onScope={handleScope}
              onRemoveScope={removeScopeAt}
              onClearScope={clearScope}
              tree={fileTree}
              recentEdits={recentEdits}
              deliveries={deliveries}
              facets={facets}
              layoutItems={layoutItems}
              contentItems={contentItems}
              tagItems={tagItems}
              sectionItems={sectionItems}
              onToggleFacet={toggleFacet}
              onClearFacets={clearFacets}
              anyFacetOn={facetsOn}
            />
          </aside>

          {/* ---------- the results (echo → grid tools → grid or columns) ---------- */}
          <main className="lt-results">
            <EchoLine facets={facets} onToggle={toggleFacet} onClearFacets={clearFacets} />
            {sideEligible && (
              <div className="lt-gridtools">
                <span className="lt-gridnote">
                  {scopedSlugs.length} talks in scope — each in outline order
                </span>
                <div className="lt-vseg" role="group" aria-label="Multi-talk view">
                  <button
                    type="button"
                    className={viewPref === 'side' ? 'on' : ''}
                    onClick={() => setView('side')}
                  >
                    <Columns2 className="lt-icon" /> Side by side
                  </button>
                  <button
                    type="button"
                    className={viewPref === 'seq' ? 'on' : ''}
                    onClick={() => setView('seq')}
                  >
                    <Rows3 className="lt-icon" /> Sequential
                  </button>
                </div>
              </div>
            )}
            {gridMode === 'side' ? (
              // 2–3 talks: side-by-side sticky-headed columns, each in outline order with
              // its own scroll — the shared comparison anatomy Pathway view (v0.16) and
              // family compare (v0.17) will reuse.
              <div className="lt-colwrap">
                {(() => {
                  let base = 0
                  return outlinePlan.map((t) => {
                    const colBase = base
                    base += t.total
                    return (
                      <section key={t.slug} className="lt-col" aria-label={t.title}>
                        <div className="lt-col-head">
                          <span className="lt-col-talk" title={t.title}>{t.title}</span>
                          <span className="lt-col-ord">outline order</span>
                          <span className="lt-col-n">{t.total}</span>
                        </div>
                        <div className="lt-col-scroll">{renderTalkChunks(t, colBase, 2)}</div>
                      </section>
                    )
                  })
                })()}
              </div>
            ) : (
            <div className="lt-table-scroll">
            {loading && results.length === 0 && !unavailable && (
              <div className="lt-group">
                <div className={`lt-grid g${density}`}>
                  {Array.from({ length: density * 2 }, (_v, i) => (
                    <div key={i} className="lt-card skeleton" style={{ ['--i' as string]: Math.min(i, STAGGER_CAP) }}>
                      <div className="lt-print">
                        <div className="lt-sk-thumb" />
                        <div className="lt-sk-line" />
                        <div className="lt-sk-line short" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {gridMode === 'grouped'
              ? (() => {
                  // No scope: today's grouped-by-talk·section view, duplicate-collapsed.
                  let base = 0
                  return groups.map((g) => {
                    const gKey = sectionKey(g.talkSlug, g.section)
                    const total = groupTotals.get(gKey) ?? g.units
                    const b = base
                    base += g.cards.length
                    return (
                      <div key={gKey} className="lt-group">
                        <div className="lt-group-head">
                          <span className="lt-g-talk">{g.talkTitle}</span>
                          {g.section && <span className="lt-g-sep">·</span>}
                          {g.section && <span className="lt-g-section">{secName(gKey, g.section)}</span>}
                          <span className="lt-g-count">{g.units === total ? `${total} shown` : `${g.units} of ${total} shown`}</span>
                        </div>
                        {renderGrid(g.cards, b, density, false)}
                      </div>
                    )
                  })
                })()
              : (() => {
                  // Scoped (1 talk, or 2–3 in Sequential, or >3): each talk in OUTLINE
                  // ORDER, §-headed sections, position badges (ADR-0009 grid law).
                  let base = 0
                  return outlinePlan.map((t) => {
                    const b = base
                    base += t.total
                    return (
                      <div key={t.slug} className="lt-group">
                        <div className="lt-group-head">
                          <span className="lt-g-talk">{t.title}</span>
                          <span className="lt-g-sep">·</span>
                          <span className="lt-g-section">outline order</span>
                          <span className="lt-g-count">{t.total} slide{t.total === 1 ? '' : 's'}</span>
                        </div>
                        {renderTalkChunks(t, b, density)}
                      </div>
                    )
                  })
                })()}

            {/* zero-results (A6) */}
            <div className={`lt-empty${zeroResults ? ' show' : ''}`}>
              <div className="lt-e-frame"><SearchX className="lt-icon" /></div>
              <h3>Nothing on the table</h3>
              {parsedQuery.scope === 'all' && !parsedQuery.exact ? (
                <p>
                  No slides match {query.trim() ? <span className="lt-q">“{query.trim()}”</span> : 'the current filters'}
                  {query.trim() ? ' within the current filters' : ''}. Loosen the Talk filters, or clear the search to lay everything back out.
                </p>
              ) : (
                <p>
                  No slides with {scopeNoun(parsedQuery)}
                  {parsedQuery.text.trim() ? <> — <span className="lt-q">“{parsedQuery.text.trim()}”</span></> : null}
                  {filtersOn ? ' within the current filters' : ''}. Drop the{' '}
                  <span className="lt-q">{parsedQuery.exact ? 'e:' : parsedQuery.scope === 'title' ? 't:' : parsedQuery.scope === 'body' ? 's:' : 'i:'}</span>{' '}
                  prefix to search everywhere, or clear the search.
                </p>
              )}
              <div className="lt-e-actions">
                {query.trim() !== '' && (
                  <button type="button" className="lt-btn" onClick={() => { setQuery(''); inputRef.current?.focus() }}>
                    Clear search <kbd>Esc</kbd>
                  </button>
                )}
                {filtersOn && (
                  <button type="button" className="lt-btn" onClick={() => { clearFacets(); clearScope(); setQuery('') }}>
                    Clear filters &amp; scope
                  </button>
                )}
              </div>
            </div>

            {/* empty vault (A6) */}
            <div className={`lt-empty${vaultEmpty ? ' show' : ''}`}>
              <div className="lt-e-frame"><Archive className="lt-icon" /></div>
              <h3>The vault is empty</h3>
              <p>
                Slides gather here as you author and present Talks — every saved slide becomes searchable,
                with its full history kept. Open a Talk and this table fills itself.
              </p>
              <div className="lt-e-actions">
                <button
                  type="button"
                  className="lt-btn primary"
                  onClick={() => { window.dispatchEvent(new Event('tw-search-talks')); onClose() }}
                >
                  Open a Talk
                </button>
                <button
                  type="button"
                  className="lt-btn"
                  onClick={() => { window.dispatchEvent(new Event('tw-new-talk')); onClose() }}
                >
                  New Talk
                </button>
              </div>
            </div>

            {/* search unavailable (compiler missing) — preserved from SearchPalette */}
            <div className={`lt-empty${unavailable ? ' show' : ''}`}>
              <div className="lt-e-frame"><SearchX className="lt-icon" /></div>
              <h3>Search unavailable</h3>
              <p>The html-presentations compiler wasn’t found, so the vault index can’t be searched. Check the compiler bundle, then reopen the Browser.</p>
            </div>
            </div>
            )}
          </main>

          {/* ---------- action tray (A4, insert context; mockup 545-561/1506-1516) ----------
              Floats bottom-centre INSIDE the browser body (bottom:18px), so it never
              overlaps the hint bar below. Appears whenever anything is selected. */}
          {selected.size > 0 && (
            <div className="lt-tray" role="toolbar" aria-label="Selection actions">
              <div className="lt-t-count">
                <span className="lt-n">{selected.size}</span>
                <span className="lt-w">{selected.size === 1 ? 'slide selected' : 'slides selected'}</span>
              </div>
              <div className="lt-t-sep" />
              <button type="button" className="lt-t-clear" title="Clear selection (Esc)" onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <span className="lt-t-hint">⇧-click for a range · S selects a section</span>
              <button type="button" className="lt-btn" onClick={openTagPicker} title="Tag the selected slides (T)">
                <Tag className="lt-icon" />
                Tag <kbd>T</kbd>
              </button>
              <button type="button" className="lt-btn primary" onClick={doInsert}>
                <ArrowDown className="lt-icon" />
                Insert {selected.size} selected at caret <kbd>⌘↵</kbd>
              </button>
            </div>
          )}

          {/* ---------- tag picker (ADR-0037) — anchored above the tray it came from ---------- */}
          <TagPicker
            isOpen={tagPickerOpen && selected.size > 0}
            count={selectedRows.length}
            tagLists={selectedTagLists}
            onToggle={(tag, action) => void applyTag(tag, action)}
            onClose={() => setTagPickerOpen(false)}
            anchor="tray"
            busy={tagBusy}
          />
        </div>

        {/* ---------- keyboard hint footer (mockup 1532-1542) ---------- */}
        <footer className="lt-hintbar">
          <span className="lt-h"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> <b>navigate</b></span>
          <span className="lt-h"><kbd>⇧</kbd>+click <b>range select</b></span>
          <span className="lt-h"><kbd>X</kbd> <b>select</b></span>
          <span className="lt-h"><kbd>S</kbd> <b>select section</b></span>
          <span className="lt-h"><kbd>T</kbd> <b>tag selection</b></span>
          <span className="lt-h"><kbd>E</kbd> <b>versions / where-used</b></span>
          <span className="lt-h"><kbd>U</kbd> <b>uncollapse</b></span>
          <span className="lt-h"><kbd>Space</kbd> <b>preview</b></span>
          <span className="lt-h"><kbd>↵</kbd> <b>view &amp; insert</b></span>
          <span className="lt-h"><kbd>2</kbd>–<kbd>6</kbd> <b>density</b></span>
          <span className="lt-h"><kbd>I</kbd> <b>rail</b></span>
          <span className="lt-h">click <b>scopes</b> · <kbd>⌘</kbd>+click <b>adds</b></span>
          <span className="lt-h"><kbd>⌫</kbd> <b>clear scope</b></span>
          <span className="lt-h lt-push"><kbd>Esc</kbd> <b>close</b></span>
          <span className="lt-h"><kbd>?</kbd> <b>all shortcuts</b></span>
        </footer>
      </section>

      {/* Insert-decision viewer (↵ on a card): a self-contained layer inside the Browser —
          Esc returns here exactly as it was. Keyed per opening so its index/selection reset. */}
      {viewer && viewerDeck.length > 0 && (
        <InsertViewer
          key={`${viewer.slug}#${viewer.order}`}
          deck={viewerDeck}
          initialIndex={viewerIndex}
          talkTitle={titleBySlug.get(viewer.slug) ?? viewer.slug}
          sectionLabel={secLabelOf}
          editedLabel={
            talkMeta[viewer.slug]?.editedMs
              ? agoLabel(talkMeta[viewer.slug].editedMs)
              : viewerDeck[0]?.talkMtimeMs
                ? agoLabel(viewerDeck[0].talkMtimeMs)
                : null
          }
          fetchCounts={fetchCounts}
          onInsert={viewerInsert}
          onClose={() => setViewer(null)}
          regenNonce={thumbNonces[viewer.slug] ?? 0}
          regenerating={regenTalk === viewer.slug}
          onThumbUnavailable={noteThumbUnavailable}
          suspendKeys={suspendKeys}
        />
      )}

      {/* Space preview lightbox (ported from SearchPalette; .preview-lightbox sits above the .lt root) */}
      {preview && activeRow && activeRow.content_hash && (
        <div className="preview-lightbox" onClick={() => setPreview(false)} role="dialog" aria-label="Slide preview">
          <img
            src={`twthumb://${activeRow.talkSlug}/${activeRow.render_hash || activeRow.content_hash}`}
            alt={rowTitle(activeRow)}
          />
          <div className="preview-lightbox-cap">{rowTitle(activeRow)} — {activeRow.talkTitle}</div>
        </div>
      )}
    </div>
  )
}
