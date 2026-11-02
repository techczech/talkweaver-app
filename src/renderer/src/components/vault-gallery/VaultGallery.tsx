import { ArrowLeft, ChevronRight, FolderOpen, LayoutGrid, List, PanelLeft, PanelRight, RefreshCw, Ruler, Search, Settings, Unplug, X, Library, FolderClosed } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TalkInfo } from '../../../../preload'
import { acceptsGalleryReply, galleryIdentity, type GalleryCatalogue, type GalleryTalk } from '../../../../shared/vault-gallery'
import { ancestorsOf, compareBy, crumbParts, folderPaths, inspectOnlyPath, knownTalkCount, leafName, nextSort, parentOf, plural, readView, talkFolder, type BrowseScope, type BrowseView, type SortState } from '../../../../shared/vault-gallery-browse'
import type { GalleryOpenGuard } from '../../lib/talkSelection'
import { setWorkspaceCovered } from '../../lib/workspaceCover'
import GalleryDetails, { type DetailsTarget } from './GalleryDetails'
import GalleryHandoutSheet from './GalleryHandoutSheet'
import GalleryList from './GalleryList'
import GalleryManagement, { NO_MANAGEMENT, type FolderOperation, type GalleryManagementProps, type ManagementSelection, type MenuRequest } from './GalleryManagement'
import GalleryOverview, { vaultState } from './GalleryOverview'
import { useGalleryInventory } from './GalleryStorage'
import GalleryTiles from './GalleryTiles'
import GalleryTree from './GalleryTree'
import { buildItems, folderKey, isDirectoryKind, listRank, UI, type GalleryItem } from './galleryItems'
import { rowFacts, sizeCell, type Known } from './galleryValues'
import { useGalleryFacts } from './useGalleryFacts'
import './vault-gallery.css'

interface Props {
  management?: GalleryManagementProps
  revision: unknown
  onClose(): void
  onOpen(talk: TalkInfo, guard?: GalleryOpenGuard<TalkInfo>): Promise<boolean>
}
const VIEW_KEY = 'tw.vaultGallery.view', DETAILS_KEY = 'tw.vaultGallery.details'
const stored = (key: string): string | null => { try { return window.localStorage.getItem(key) } catch { return null } }
const remember = (key: string, value: string) => { try { window.localStorage.setItem(key, value) } catch { /* not remembered this time */ } }
const NARROW = 900
const VAULT_CHANGED = 'The vault changed while opening this talk. Choose it again from the current catalogue.'

export default function VaultGallery({ revision, onClose, onOpen, management }: Props) {
  const [managementRevision, setManagementRevision] = useState(0)
  const [reloads, setReloads] = useState(0)
  const [catalogue, setCatalogue] = useState<GalleryCatalogue | null>(null)
  const [vaultId, setVaultId] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [scope, setScope] = useState<BrowseScope>({ kind: 'folder', path: '' })
  const [view, setViewState] = useState<BrowseView>(() => readView(stored(VIEW_KEY)))
  const [detailsOpen, setDetailsState] = useState(() => stored(DETAILS_KEY) === 'open')
  const [drawer, setDrawer] = useState<'details' | 'folders' | null>(null)
  const [narrow, setNarrow] = useState(false)
  const [showSystem, setShowSystem] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' })
  const [overviewSort, setOverviewSort] = useState<SortState | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [expandedVaults, setExpandedVaults] = useState<ReadonlySet<string>>(new Set())
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set())
  const [sheet, setSheet] = useState<GalleryTalk | null>(null)
  const [preview, setPreview] = useState<GalleryTalk | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuRequest, setMenuRequest] = useState<MenuRequest | null>(null)
  const [focusFirst, setFocusFirst] = useState(false)
  const [measureAfterEntry, setMeasureAfterEntry] = useState(false)
  /** The one in-flight operation. Taken synchronously, so two Enter presses or a double-click and a toolbar click cannot both start. */
  const inFlight = useRef(false)
  /** Orders catalogue requests only: a newer request supersedes an older reply. */
  const generation = useRef(0)
  /** The catalogue this gallery currently stands on, until it unmounts. A running open is tied to this, not to the catalogue requests a window focus makes. */
  const authority = useRef<GalleryCatalogue | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const setView = (next: BrowseView) => { setViewState(next); remember(VIEW_KEY, next) }
  const setDetails = (next: boolean) => { setDetailsState(next); remember(DETAILS_KEY, next ? 'open' : 'closed') }
  const admit = (): (() => void) | null => {
    if (inFlight.current) return null
    inFlight.current = true; setBusy(true)
    let released = false
    return () => { if (!released) { released = true; inFlight.current = false; setBusy(false) } }
  }
  /** Runs a write or other action under the one lock; returns false when something else is already running. */
  const exclusive = (action: () => Promise<void>): boolean => {
    const release = admit()
    if (!release) return false
    setError('')
    void action().catch(e => setError(String(e))).finally(release)
    return true
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const scroller = previous?.closest('.cm-scroller') as HTMLElement | null
    const scroll = scroller ? { top: scroller.scrollTop, left: scroller.scrollLeft } : null
    // The Talks sidebar re-measures its rows when uncovered; put its scroll back like the editor's.
    const sidebar = document.querySelector<HTMLElement>('[data-sidebar] .tl-tree')
    const sidebarTop = sidebar?.scrollTop ?? 0
    setWorkspaceCovered(true)
    panel.current?.focus()
    const siblings = Array.from(panel.current?.parentElement?.children ?? []).filter(el => el !== panel.current)
    const newlyInert = siblings.filter(el => !el.hasAttribute('inert'))
    newlyInert.forEach(el => el.setAttribute('inert', ''))
    return () => {
      newlyInert.forEach(el => el.removeAttribute('inert')); setWorkspaceCovered(false); previous?.focus({ preventScroll: true })
      // CodeMirror's focus handler may scroll the caret after native focus restoration.
      const restore = () => { if (scroller?.isConnected && scroll) { scroller.scrollTop = scroll.top; scroller.scrollLeft = scroll.left } }
      restore(); requestAnimationFrame(restore)
      const restoreSidebar = () => { if (sidebar?.isConnected && sidebarTop && sidebar.scrollTop !== sidebarTop) sidebar.scrollTop = sidebarTop }
      requestAnimationFrame(restoreSidebar); window.setTimeout(restoreSidebar, 120); window.setTimeout(restoreSidebar, 400)
    }
  }, [])
  useEffect(() => {
    const el = panel.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(entries => setNarrow((entries[0]?.contentRect.width ?? NARROW) < NARROW))
    watch.observe(el); setNarrow(el.clientWidth < NARROW)
    return () => watch.disconnect()
  }, [])
  useLayoutEffect(() => {
    const token = ++generation.current
    // A reload for the same registry keeps what is on screen (rows, scroll, focus, finished work) and swaps the catalogue when the reply arrives.
    window.tw.vault.galleryCatalogue(token).then(reply => {
      if (generation.current === token && acceptsGalleryReply(reply, token)) {
        authority.current = reply; setCatalogue(reply); setReloads(n => n + 1)
        setVaultId(id => reply.vaults.some(v => v.id === id) ? id : reply.vaults[0]?.id ?? null)
        setExpandedVaults(old => old.size ? old : new Set(reply.vaults[0] ? [reply.vaults[0].id] : []))
      }
    }).catch(e => { if (generation.current === token) setError(String(e)) })
    return () => { generation.current++ }
  }, [revision, managementRevision])
  useEffect(() => () => { authority.current = null }, [])

  const vault = catalogue?.vaults.find(v => v.id === vaultId)
  const vaultInfo = management?.vaults.find(v => v.id === vaultId)
  const state = catalogue && vault ? vaultState(catalogue, management?.vaults, vault.id) : 'open'
  const browsable = browsing && !!vault && state === 'open'
  const folder = scope.kind === 'folder' ? scope.path : ''
  const inventory = useGalleryInventory(browsable ? vault!.id : null, folder, `${catalogue?.rootGeneration}:${managementRevision}`, query)
  const folders = useMemo(() => vault ? folderPaths(vault.talks, management?.foldersByVault[vault.id] ?? []) : [], [vault, management?.foldersByVault])
  const built = useMemo(() => !vault || !browsable ? { items: [] as GalleryItem[], flat: false }
    : buildItems({ talks: vault.talks, folders, scope, query, listing: inventory.listing, search: inventory.search, showSystem: showSystem || inspectOnlyPath(folder) }), [vault, browsable, folders, scope, query, inventory.listing, inventory.search, showSystem, folder])
  const items = built.items
  const flat = browsable && built.flat
  const mixed = flat && items.some(i => i.kind !== 'talk')
  const overviewTalks = useMemo(() => !browsing && vault && state === 'open' ? vault.talks.slice(0, 4) : [], [browsing, vault, state])
  const talksInView = useMemo(() => browsable ? items.filter((i): i is Extract<GalleryItem, { kind: 'talk' }> => i.kind === 'talk').map(i => i.talk) : overviewTalks, [browsable, items, overviewTalks])
  const covers = browsing ? view === 'Gallery' : true
  const mosaicTalks = (path: string) => (vault?.talks ?? []).filter(t => talkFolder(t) === path || talkFolder(t).startsWith(path + '/')).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 4)
  const mosaicKeys = browsable && view === 'Gallery' ? items.filter(i => i.kind === 'folder').flatMap(i => i.kind === 'folder' ? mosaicTalks(i.path).map(galleryIdentity) : []).join('|') : ''
  const known0 = useGalleryFacts(talksInView, `${catalogue?.rootGeneration}:${vaultId}:${folder}:${scope.kind}:${query}:${browsing}:${view}`, host, covers, mosaicKeys, reloads)
  const known: Known = { facts: known0.facts, handouts: known0.handouts, scans: [inventory.scan, inventory.search] }
  const sorted = useMemo(() => {
    const decorate = (i: GalleryItem) => ({ i, name: i.name, location: i.kind === 'talk' ? talkFolder(i.talk) : parentOf(i.kind === 'folder' ? i.path : i.kind === 'entry' ? i.path : ''), facts: rowFacts(i, known) })
    const order = (list: GalleryItem[]) => list.map(decorate).sort((a, b) => compareBy(sort.key, sort.dir, a, b)).map(x => x.i)
    return [0, 1, 2, 3].flatMap(rank => order(items.filter(i => listRank(i) === rank)))
  }, [items, sort, known0.facts, known0.handouts, inventory.scan, inventory.search])
  const chosen = sorted.find(i => i.key === selected) ?? null
  const chosenTalk = chosen?.kind === 'talk' ? chosen.talk : null
  useEffect(() => { if (chosenTalk && (detailsOpen || drawer === 'details') && view === 'List') known0.wantCover(chosenTalk) }, [chosenTalk, detailsOpen, drawer, view, known0.facts])
  // An open title preview or handouts sheet gets what a reload cancelled.
  useEffect(() => { if (preview) known0.wantCover(preview) }, [preview, known0.facts])
  useEffect(() => { if (sheet) known0.loadHandouts(sheet) }, [sheet, reloads])
  useEffect(() => { setCopied(false) }, [selected])
  // After Enter on a folder the new list's first row takes focus, so arrows and Escape keep working.
  // An empty folder has no row to take it: the panel itself does, so Escape and Tab still work.
  const listed = inventory.listing?.relativePath === folder && inventory.listing.state !== 'running'
  useEffect(() => {
    if (!focusFirst || !browsable) return
    // Someone who moved on while the rows were on their way (into the search box, to a button) keeps their place.
    const here = document.activeElement
    if (here && here !== document.body && here !== panel.current) { setFocusFirst(false); return }
    if (sorted.length) { setFocusKey(sorted[0].key); setFocusFirst(false) }
    else if (listed) { panel.current?.focus(); setFocusFirst(false) }
  }, [focusFirst, browsable, sorted, listed])
  // Focus is one request: it is spent once the list has taken it, so a list mounted later (a cleared search, the other view) never takes focus again.
  useEffect(() => { if (focusKey) setFocusKey(null) }, [focusKey])
  useEffect(() => { if (measureAfterEntry && browsable) { setMeasureAfterEntry(false); inventory.measure('') } }, [measureAfterEntry, browsable])

  const scopeName = scope.kind === 'all' ? UI.allTalks : folder ? leafName(folder) : vault?.name ?? ''
  const reveal = (path: string) => setExpandedFolders(old => new Set([...old, ...ancestorsOf(path), ...(path ? [path] : [])]))
  const go = (next: BrowseScope) => { setScope(next); setSelected(null); setFocusKey(null); setFocusFirst(false); setMenuRequest(null); setQuery(''); setDrawer(null); if (next.kind === 'folder') reveal(next.path) }
  const chooseOverview = () => { setBrowsing(false); go({ kind: 'folder', path: '' }) }
  const chooseVault = (id: string) => { setVaultId(id); setBrowsing(true); setExpandedVaults(old => new Set([...old, id])); go({ kind: 'folder', path: '' }) }
  const chooseFolder = (id: string, path: string) => { setVaultId(id); setBrowsing(true); go({ kind: 'folder', path }) }
  const chooseAll = (id: string) => { setVaultId(id); setBrowsing(true); go({ kind: 'all' }) }
  const toggle = (set: ReadonlySet<string>, value: string) => { const next = new Set(set); if (!next.delete(value)) next.add(value); return next }

  const open = async (talk: GalleryTalk) => {
    const rootGeneration = catalogue?.rootGeneration
    if (rootGeneration == null) return
    // Still the same vault set, and this talk is still in it. A window focus re-reads the catalogue without changing either; main checks both again at every step.
    const isCurrent = () => authority.current?.rootGeneration === rootGeneration && !!authority.current.vaults.find(v => v.id === talk.vaultId)?.talks.some(t => t.relativeOutline === talk.relativeOutline)
    const release = admit()
    if (!release) return
    setError('')
    try {
      let lost = false
      const resolve = async () => {
        const found = await window.tw.vault.galleryTalk(talk.vaultId, talk.relativeOutline, rootGeneration).catch(e => { lost = true; throw e })
        const same = !!found && (found.vaultId ?? talk.vaultId) === talk.vaultId
        if (!same) lost = true
        return same ? found : null
      }
      const target = await resolve()
      if (!isCurrent()) { setError(VAULT_CHANGED); return }
      if (!target) { setError('This talk is no longer available in the known catalogue.'); return }
      const opened = await onOpen(target, {
        settle: async commit => { const result = await window.tw.vault.gallerySettle(commit); if (commit && !result.ok) lost = true; return result },
        isCurrent,
        revalidate: resolve,
        claim: async (path) => {
          // A cancelled response restores the previous window claim through the existing policy.
          if (path !== target.outlinePath) return await window.tw.windows.claimTalk(path)
          const result = await window.tw.vault.galleryClaim(talk.vaultId, talk.relativeOutline, rootGeneration)
          if (!result.ok && result.reason === 'stale') throw new Error(VAULT_CHANGED)
          return result
        }
      })
      if (opened && isCurrent()) onClose()
      else if (!opened && (lost || !isCurrent())) setError(VAULT_CHANGED)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { release() }
  }
  const activate = (item: GalleryItem) => {
    if (item.kind === 'talk') void open(item.talk)
    else if (item.kind === 'folder' || (item.kind === 'entry' && isDirectoryKind(item.entry.kind))) { go({ kind: 'folder', path: item.path }); setFocusFirst(true) }
  }
  /** Right-click: selects the row; opens the actions menu at the pointer unless an action is running or the row has none (anything inspect-only). */
  const menuKeyOf = (key: string | null) => key ? `${vaultId}|${scope.kind}|${folder}|${key}` : null
  const contextMenu = (item: GalleryItem, at: { x: number; y: number }) => {
    if (inFlight.current) return
    setSelected(item.key)
    if (item.kind === 'entry') { setMenuRequest(null); return }
    setMenuRequest(old => ({ id: (old?.id ?? 0) + 1, key: menuKeyOf(item.key)!, x: at.x, y: at.y }))
  }
  const previewItem = (item: GalleryItem) => { if (item.kind === 'talk') { known0.wantCover(item.talk); setPreview(item.talk) } }
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setError('The location could not be copied.')) }
  const selection: ManagementSelection = chosen?.kind === 'talk' ? { kind: 'talk', talk: chosen.talk }
    : chosen?.kind === 'folder' ? { kind: 'folder', path: chosen.path, category: (management?.foldersByVault[vaultId ?? ''] ?? []).includes(chosen.path) && !inspectOnlyPath(chosen.path) }
      : chosen?.kind === 'entry' ? (isDirectoryKind(chosen.entry.kind) ? { kind: 'folder', path: chosen.path, category: false } : { kind: 'entry' }) : null
  const locationText = chosen ? [vault?.name, ...(chosen.kind === 'talk' ? chosen.talk.relativeOutline.split('/').slice(0, -1) : chosen.path.split('/'))].join(' / ') : ''
  const copyLocation = () => copy(vaultInfo?.root && chosen ? `${vaultInfo.root.replace(/\/+$/, '')}/${chosen.kind === 'talk' ? chosen.talk.relativeOutline.split('/').slice(0, -1).join('/') : chosen.path}` : locationText)
  const reconcileFolder = (result: string, op: FolderOperation | null) => {
    if (!op) { go({ kind: 'folder', path: result }); return }
    const inside = folder === op.path || folder.startsWith(op.path + '/')
    // Renaming or binning a folder keeps you where you were unless you were inside it.
    if (op.kind === 'rename') { if (inside) go({ kind: 'folder', path: result + folder.slice(op.path.length) }); else setSelected(folderKey(result)) }
    else if (inside) go({ kind: 'folder', path: parentOf(op.path) })
    else setSelected(null)
  }
  const dropdownTalks = (t: GalleryTalk) => setSheet(t)

  const foldersInside = (path: string) => folders.filter(f => parentOf(f) === path && !inspectOnlyPath(f)).length
  const overviewCount = vault && state === 'open' && vault.status === 'stale' ? vault.talks.length : null
  const target: DetailsTarget = { overview: !browsable, foldersInside, item: browsable ? chosen : null, vaultName: vault?.name ?? '', root: vaultInfo?.root, status: state === 'open' ? 'Open' : state === 'closed' ? 'Closed' : 'Not connected',
    context: browsable ? (scope.kind === 'all' ? { kind: 'all', path: '', count: vault!.talks.length, folders: 0 } : { kind: folder ? 'folder' : 'vault', path: folder, count: knownTalkCount(vault!.talks, folder), folders: foldersInside(folder) })
      : { kind: 'vault', path: '', count: overviewCount, folders: vault && state === 'open' ? foldersInside('') : null } }
  const detailsShown = narrow ? drawer === 'details' : detailsOpen
  const toggleDetails = () => narrow ? setDrawer(d => d === 'details' ? null : 'details') : setDetails(!detailsOpen)
  const sizesMeasured = sorted.filter(i => sizeCell(i, known).state === 'value').length
  const placeholder = !browsing ? UI.searchVaults : scope.kind === 'all' || !folder ? UI.searchVault : UI.searchFolder
  const measureTarget = chosen?.kind === 'talk' ? chosen.talk.relativeOutline.split('/').slice(0, -1).join('/') : chosen?.kind === 'folder' ? chosen.path : chosen?.kind === 'entry' && isDirectoryKind(chosen.entry.kind) ? chosen.path : folder
  const scanning = inventory.scan?.state === 'running'
  const searching = browsable && !!query.trim()
  const searchRunning = searching && (inventory.search?.state === 'running' || (!!folder && !inventory.search))
  const searchIncomplete = searching && !!inventory.search && ['partial', 'cancelled', 'refused', 'stale', 'unavailable'].includes(inventory.search.state)
  const previewUrl = chosenTalk ? known0.facts[galleryIdentity(chosenTalk)]?.coverUrl ?? null : null

  const detailsProps = { target, known, previewUrl, onPreview: () => { if (chosenTalk) previewItem(chosen!) }, onHandouts: dropdownTalks, copy, copied, mosaicTalks,
    onMeasureVault: vault && state === 'open' ? () => { if (browsable) { go({ kind: 'folder', path: '' }); inventory.measure('') } else { chooseVault(vault.id); setMeasureAfterEntry(true) } } : undefined }
  const closeOverlays = () => {
    if (preview) { setPreview(null); return true }
    if (sheet) { setSheet(null); return true }
    if (drawer) { const was = drawer; setDrawer(null); panel.current?.querySelector<HTMLButtonElement>(`button[data-drawer="${was}"]`)?.focus(); return true }
    return false
  }
  const crumb = (label: string, onClick: (() => void) | null, here = false, key?: string) => <Fragment key={key ?? label}><ChevronRight size={14} className="vg-sep" aria-hidden />{onClick ? <button className={`vg-crumb ${here ? 'here' : ''}`} aria-current={here ? 'page' : undefined} onClick={onClick}>{label}</button> : here ? <span className="vg-crumb here" aria-current="page">{label}</span> : <span className="vg-crumb gap" aria-hidden>{label}</span>}</Fragment>

  return <div className={`vault-gallery ${narrow ? 'vg-narrow' : ''} ${detailsShown && !narrow ? 'vg-with-details' : ''}`} role="dialog" aria-modal="true" aria-label="Vault Gallery" tabIndex={-1} ref={panel} onKeyDown={e => {
    // SCAN_IGNORE: local modal dismissal and focus containment; these are not content commands.
    if (e.key === 'Escape' && !busy) {
      e.preventDefault(); e.stopPropagation()
      if (closeOverlays()) return
      if (selected && browsable) { setSelected(null); return }
      onClose()
    }
    if (e.key === 'Tab') {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, summary, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0 && !el.closest('[inert]'))
      const first = controls[0], last = controls.at(-1)
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
  }}>
    <header className="vg-titlebar">
      <div className="vg-tbleft"><button className="vg-return" disabled={busy} onClick={onClose}><ArrowLeft size={16} aria-hidden />{UI.returnToTalk}</button></div>
      <nav className="vg-crumbs" aria-label="Location">
        {browsing && vault ? <>
          <button className="vg-crumb top" onClick={chooseOverview}>{UI.allVaults}</button>
          {crumb(vault.name, () => go({ kind: 'folder', path: '' }), scope.kind === 'folder' && !folder, 'vault')}
          {scope.kind === 'all' ? crumb(UI.allTalks, null, true, 'all') : crumbParts(folder).map((c, i, all) => c.path === null ? crumb(c.label, null, false, 'gap') : crumb(c.label, () => go({ kind: 'folder', path: c.path! }), i === all.length - 1, c.path))}
        </> : <span className="vg-crumb here top">{UI.allVaults}</span>}
      </nav>
      <div className="vg-search"><Search size={16} aria-hidden /><input ref={searchRef} aria-label={placeholder} placeholder={placeholder} value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label={UI.clearSearch} onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={14} aria-hidden /></button>}</div>
    </header>
    {(!narrow || drawer === 'folders') && catalogue && <>
      {narrow && <div className="vg-scrim" onClick={() => setDrawer(null)} />}
      <aside className={`vg-sidebar ${narrow ? 'vg-drawer left' : ''}`} aria-label="Vaults and folders">
        {narrow && <div className="vg-dhead">{UI.folders}<button className="vg-tbtn vg-dclose" aria-label="Close folders" onClick={() => setDrawer(null)}><X size={16} aria-hidden /></button></div>}
        <GalleryTree catalogue={catalogue} vaults={management?.vaults} foldersByVault={management?.foldersByVault ?? {}} vaultId={vaultId} browsing={browsing} scope={scope}
          expandedVaults={expandedVaults} expandedFolders={expandedFolders} toggleVault={id => setExpandedVaults(s => toggle(s, id))} toggleFolder={p => setExpandedFolders(s => toggle(s, p))}
          chooseOverview={chooseOverview} chooseVault={chooseVault} chooseFolder={chooseFolder} chooseAll={chooseAll} showSystem={showSystem} setShowSystem={setShowSystem} addVault={management?.onAddVault} />
      </aside>
    </>}
    <div className="vg-toolbar" role="toolbar" aria-label="Actions">
      {narrow && browsing && <button className="vg-tbtn" data-drawer="folders" aria-expanded={drawer === 'folders'} onClick={() => setDrawer(d => d === 'folders' ? null : 'folders')}><PanelLeft size={16} aria-hidden />{UI.folders}</button>}
      <GalleryManagement toolbar={browsable} menuRequest={menuRequest} menuKey={menuKeyOf(chosen?.key ?? null)} busy={busy} management={management ?? NO_MANAGEMENT} vaultId={vaultId} folder={folder} selection={selection}
        openTalk={t => void open(t)} openFolder={path => { go({ kind: 'folder', path }); setFocusFirst(true) }} showHandouts={dropdownTalks} canPreview={!!chosenTalk && known0.facts[galleryIdentity(chosenTalk)]?.preview !== 'unavailable'} preview={() => chosenTalk && previewItem(chosen!)} copyLocation={copyLocation}
        resolve={t => window.tw.vault.galleryTalk(t.vaultId, t.relativeOutline, catalogue!.rootGeneration)}
        run={exclusive}
        reconcile={({ talk, folder: nextFolder, op }) => {
          if (nextFolder !== undefined) reconcileFolder(nextFolder, op ?? null)
          if (talk) {
            const v = (management ?? NO_MANAGEMENT).vaults.find(v => v.id === talk.vaultId)
            if (v) { const relative = talk.outlinePath.slice(v.root.replace(/\/+$/, '').length + 1); go({ kind: 'folder', path: relative.split('/').slice(0, -2).join('/') }); setSelected(JSON.stringify([v.id, relative])) }
          } else if (nextFolder === undefined) setSelected(null)
          setManagementRevision(n => n + 1)
        }} />
      {!browsable && vault && management && <>
        {state === 'open' && <button className="vg-tbtn primary" disabled={busy || vault.status !== 'stale'} onClick={() => chooseVault(vault.id)}><FolderOpen size={16} aria-hidden />{UI.openVault}</button>}
        {state === 'closed' && <button className="vg-tbtn primary" disabled={busy} onClick={() => { exclusive(() => management.onSetVaultOpen(vault.id, true)) }}><FolderOpen size={16} aria-hidden />{UI.openVault}</button>}
        {state === 'unavailable' && <button className="vg-tbtn primary" disabled={busy} onClick={() => { exclusive(async () => { await (management.onRecheck?.() ?? Promise.resolve()); setManagementRevision(n => n + 1) }) }}><RefreshCw size={16} aria-hidden />Check again</button>}
        <button className="vg-tbtn" disabled={busy} onClick={() => management.onEditVault(vault.id)}><Settings size={16} aria-hidden />{UI.vaultSettings}</button>
        {state === 'open' && <button className="vg-tbtn" disabled={busy} onClick={() => { exclusive(() => management.onSetVaultOpen(vault.id, false)) }}><FolderClosed size={16} aria-hidden />{UI.closeVault}</button>}
      </>}
      <span className="vg-spacer" />
      {browsable && <div className="vg-seg" role="group" aria-label="View">{([['List', List], ['Gallery', LayoutGrid]] as const).map(([m, Icon]) => <button key={m} className={view === m ? 'on' : ''} aria-pressed={view === m} onClick={() => setView(m)}><Icon size={16} aria-hidden />{m}</button>)}</div>}
      <button className={`vg-tbtn ${detailsShown ? 'on' : ''}`} data-drawer="details" aria-pressed={detailsShown} aria-label={UI.details} onClick={toggleDetails}><PanelRight size={16} aria-hidden />{UI.details}</button>
    </div>
    <main className="vg-main">
      <div className="vg-content" ref={host}>
        {error && <div className="vg-banner" role="alert"><span>{error}</span><button className="vg-tbtn" onClick={() => setError('')}>Close</button></div>}
        {searchIncomplete && sorted.length > 0 && <div className="vg-banner" role="status"><span>Search coverage is incomplete: {inventory.search?.reason ?? 'not every stored file was checked'}. Some matches may be missing.</span></div>}
        {inventory.confirming && <div className="vg-banner" role="group" aria-label="Confirm whole-vault measurement"><span>Measure all stored files in this vault? This may take time. You can stop at any point.</span><button className="vg-tbtn" onClick={() => { inventory.setConfirming(false); inventory.run('') }}>Measure whole vault</button><button className="vg-tbtn" onClick={() => inventory.setConfirming(false)}>Cancel</button></div>}
        {searching && flat && !folder && !inventory.search && <div className="vg-banner"><span>Stored-file search covers this directory only. Search the whole vault to include descendants.</span><button className="vg-tbtn" onClick={() => inventory.measure('')}>Search whole vault</button></div>}
        {!catalogue ? <p className="vg-blank" role="status">{error ? 'Catalogue unavailable.' : 'Reading known catalogue…'}</p>
          : !catalogue.vaults.length ? <div className="vg-blank"><Library size={36} aria-hidden /><h2>No vaults yet</h2><p>Add a vault to browse its talks and folders here.</p>{management && <div className="vg-acts"><button className="vg-tbtn primary" onClick={management.onAddVault}>{UI.addVault}</button></div>}</div>
            : !browsing ? <>
              <GalleryOverview catalogue={catalogue} vaults={management?.vaults} vaultId={vaultId} query={query} sort={overviewSort} setSort={k => setOverviewSort(s => nextSort(s ?? { key: 'name', dir: 'desc' }, k))} select={id => { setVaultId(id); setExpandedVaults(old => new Set([...old, id])) }} activate={id => { const s = vaultState(catalogue, management?.vaults, id); if (s === 'open') chooseVault(id) }} />
              {!!catalogue.vaults.length && !catalogue.vaults.some(v => `${v.name} ${management?.vaults.find(i => i.id === v.id)?.root ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p className="vg-blank">Nothing matches “{query}” in vaults.</p>}
              {vault && state === 'open' && vault.status === 'stale' && <>
                <div className="vg-sbar">Talks in {vault.name}<button onClick={() => chooseAll(vault.id)}>{UI.showAllTalks}<ChevronRight size={14} aria-hidden /></button></div>
                <GalleryTiles strip items={overviewTalks.map((t): GalleryItem => ({ kind: 'talk', key: galleryIdentity(t), name: t.title, talk: t }))} known={known} selected={null} select={() => { }} contextMenu={() => { }} dropCover={known0.dropCover}
                  activate={item => { if (item.kind === 'talk') { setBrowsing(true); go({ kind: 'folder', path: talkFolder(item.talk) }); setSelected(item.key) } }} preview={previewItem} />
              </>}
            </>
              : !vault ? null
                : state !== 'open' ? <div className="vg-blank">{state === 'closed' ? <FolderClosed size={36} aria-hidden /> : <Unplug size={36} aria-hidden />}<h2>{vault.name} is {state === 'closed' ? 'closed' : 'not connected'}</h2><p>{state === 'closed' ? 'Its files stay where they are. Open the vault to browse it.' : `Last known location: ${vaultInfo?.root ?? 'unknown'}. Its files have not been read. Connect the drive and check again.`}</p></div>
                  : !sorted.length ? <div className="vg-blank">{query.trim() ? searchRunning ? <div role="status"><Search size={36} aria-hidden /><h2>Searching…</h2><p>Looking through stored files in {scopeName}. Nothing found yet.</p></div> : searchIncomplete ? <div role="status"><Search size={36} aria-hidden /><h2>No results so far</h2><p>Nothing matches “{query}” in what was checked. Coverage is incomplete: {inventory.search?.reason ?? 'not every stored file was checked'}.</p></div> : <><Search size={36} aria-hidden /><h2>No results</h2><p>Nothing matches “{query}” in {scopeName}.</p></> : <><FolderOpen size={36} aria-hidden /><h2>No talks here yet</h2><p>This folder has no known talks or subfolders. The catalogue is cached, so this is not a verified empty folder.</p></>}</div>
                    : view === 'List' ? <GalleryList items={sorted} flat={flat} mixed={mixed} vaultName={vault.name} known={known} sort={sort} setSort={k => setSort(s => nextSort(s, k))} selected={selected} select={setSelected} activate={activate} preview={previewItem} focusKey={focusKey} contextMenu={contextMenu} />
                      : <GalleryTiles mosaicTalks={mosaicTalks} items={sorted} known={known} selected={selected} select={setSelected} activate={activate} preview={previewItem} dropCover={known0.dropCover} focusKey={focusKey} contextMenu={contextMenu} />}
      </div>
      {detailsShown && !narrow && <GalleryDetails {...detailsProps} />}
    </main>
    <footer className="vg-status">
      {browsable ? <>
        <span className="vg-grow">{query.trim() ? `${plural(sorted.length, 'result')} in ${scopeName} and subfolders` : plural(sorted.length, 'item')} · Counts may be incomplete (cached catalogue)</span>
        {/* Refresh re-reads the cached catalogue and the directory listing only; it never lists talks on the host. */}
        <button className="vg-lnk" disabled={scanning || busy} onClick={() => setManagementRevision(n => n + 1)}><RefreshCw size={14} aria-hidden />{UI.refresh}</button>
        <span role="status" className="vg-sizestatus">{scanning ? `${searching && inventory.scan?.relativePath === folder ? 'Searching' : 'Measuring'} ${inventory.scan?.relativePath || vault!.name}… ${inventory.scan?.counted ?? 0} entries checked` : inventory.scan && ['cancelled', 'partial', 'refused', 'unavailable', 'stale'].includes(inventory.scan.state) ? `Size ${inventory.scan.state}: ${inventory.scan.reason ?? 'coverage incomplete'}` : `${sizesMeasured} of ${sorted.length} sizes measured`}</span>
        {scanning ? <button className="vg-lnk" onClick={inventory.stop}>{UI.stop}</button> : <button className="vg-lnk" onClick={() => inventory.measure(measureTarget)}><Ruler size={14} aria-hidden />{measureTarget === folder ? UI.measureFolder : chosen?.kind === 'talk' ? 'Measure this talk' : 'Measure this folder'}</button>}
      </> : <span className="vg-grow">{browsing && vault && state !== 'open' ? target.status : catalogue ? plural(catalogue.vaults.length, 'item') : ''}</span>}
    </footer>
    {narrow && drawer === 'details' && <><div className="vg-scrim" onClick={() => setDrawer(null)} /><div className="vg-drawer right"><div className="vg-dhead">{UI.details}<button className="vg-tbtn vg-dclose" aria-label="Close details" onClick={() => setDrawer(null)}><X size={16} aria-hidden /></button></div><GalleryDetails {...detailsProps} /></div></>}
    {preview && <div className="vg-sheetwrap" onClick={() => setPreview(null)}><div className="vg-sheet wide" role="region" aria-label={`Title preview: ${preview.title}`} onClick={e => e.stopPropagation()}>
      <h2>{preview.title}</h2><div className="vg-slidebox"><span className="vg-thumb">{known0.facts[galleryIdentity(preview)]?.coverUrl ? <img src={known0.facts[galleryIdentity(preview)]!.coverUrl!} alt={`Title slide of ${preview.title}`} /> : <span className="vg-nopreview">{known0.facts[galleryIdentity(preview)]?.preview === 'unavailable' ? 'Title preview unavailable' : 'Title preview pending'}</span>}</span></div>
      <div className="vg-foot"><button className="vg-tbtn" autoFocus onClick={() => setPreview(null)}>Close title preview</button></div></div></div>}
    {sheet && <GalleryHandoutSheet title={sheet.title} value={known0.handouts[galleryIdentity(sheet)]} close={() => setSheet(null)} />}
  </div>
}
