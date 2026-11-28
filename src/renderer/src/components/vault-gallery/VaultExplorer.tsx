import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { ChevronRight, ExternalLink, Folder, FolderPlus, GraduationCap, HardDrive, LayoutGrid, List, ListFilter, PanelLeft, Plus, Search, Wrench, X } from 'lucide-react'
import type { TalkInfo } from '../../../../preload'
import { galleryIdentity } from '../../../../shared/vault-gallery'
import { ancestorsOf, crumbParts, folderTalks, leafName, parentOf, plural, readView, treeNodes, type BrowseView } from '../../../../shared/vault-gallery-browse'
import { plainTalkTitle } from '../../../../shared/plain-title'
import type { OpenSlideTarget } from '../../../../shared/open-in-new-window'
import type { GalleryOpenGuard } from '../../lib/talkSelection'
import { useTalkFacts } from '../../lib/talkFacts'
import { setWorkspaceCovered } from '../../lib/workspaceCover'
import { effectiveKeys, liveShortcutLabel, onKeymapChanged } from '../../keymap/store'
import { isTypingKey, surfaceKey } from '../../keymap/surfaceKeys'
import ModeBack from '../ModeBack'
import { VaultBadge } from '../talklist/VaultRows'
import { PromptModal } from '../talklist/modals'
import ExplorerStart, { type ExplorerStartActions } from './ExplorerStart'
import ExplorerRows, { ExplorerFolderCards, resultKey, vaultLocation } from './ExplorerRows'
import { explorerVaults, offlineExplorerTalks, readExplorerHistory, writeExplorerHistory, type ExplorerHistory, type ExplorerPlace, type ExplorerResult, type ExplorerTalk, type ExplorerVault } from './explorerModel'
import GalleryHandoutSheet from './GalleryHandoutSheet'
import GalleryManagement, { NO_MANAGEMENT, type GalleryManagementProps, type ManagementSelection, type MenuRequest } from './GalleryManagement'
import ManagementLayer from './ManagementLayer'
import { openGalleryTalk } from './openGalleryTalk'
import { useExplorerSearch, type ExplorerSearchScope } from './useExplorerSearch'
import { useGalleryFacts } from './useGalleryFacts'
import './vault-gallery.css'
import './vault-explorer.css'

export type ExplorerSlideTarget = OpenSlideTarget
interface Props {
  management?: GalleryManagementProps
  actions: ExplorerStartActions
  searchRef: RefObject<HTMLInputElement>
  preferredVaultId?: string | null
  initialLocation?: ExplorerPlace
  activeTitle?: string
  onClose?(): void
  onOpen(talk: TalkInfo, guard: GalleryOpenGuard<TalkInfo>, slide?: ExplorerSlideTarget, recent?: boolean): Promise<boolean>
  onStorage?(place: ExplorerPlace | null): void
  onDefaultVault(): Promise<string | null>
  onSettings(): void
}

const NARROW = '(max-width: 999px)'
const VIEW = 'tw.vaultGallery.view'
const EMPTY = NO_MANAGEMENT
const SLIDE_PAGE_SIZE = 200
const FOUND_IN = [['title', 'Slide title'], ['text', 'Text'], ['picture', 'Image'], ['widget', 'Widget']] as const
type FoundField = typeof FOUND_IN[number][0]
let windowScope: ExplorerSearchScope = 'titles'
const usable = (item: ExplorerVault): boolean => item.vault.open && !item.vault.unavailable
const slideTarget = (row: ExplorerResult): ExplorerSlideTarget | undefined => row.slide && ({
  line: row.slide.source_line ?? undefined, index: row.slide.order, slideId: row.slide.slide_id || undefined
})

export default function VaultExplorer({ management = EMPTY, actions, searchRef, preferredVaultId, initialLocation, activeTitle, onClose, onOpen, onStorage, onDefaultVault, onSettings }: Props) {
  const [place, setPlace] = useState<ExplorerPlace | null>(initialLocation ?? null)
  const [destination, setDestination] = useState<ExplorerPlace | null>(null)
  const [all, setAll] = useState(false)
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches)
  const [startOpen, setStartOpen] = useState(() => !activeTitle && !matchMedia(NARROW).matches)
  const [sidebar, setSidebar] = useState(false)
  const [sideMode, setSideMode] = useState<'Folders' | 'Recent'>('Folders')
  const [closedTrees, setClosedTrees] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, Set<string>>>({})
  const [view, setView] = useState<BrowseView>(() => {
    try { return readView(localStorage.getItem(VIEW)) } catch { return readView(null) }
  })
  const [sort, setSort] = useState<'edited' | 'name' | 'slides'>('edited')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ExplorerSearchScope>(windowScope)
  const [wide, setWide] = useState(false)
  const [filterVault, setFilterVault] = useState<string | null>(null)
  const [filterField, setFilterField] = useState<FoundField | null>(null)
  const [position, setPosition] = useState(0)
  const [slideLimit, setSlideLimit] = useState(SLIDE_PAGE_SIZE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [folderPrompt, setFolderPrompt] = useState<ExplorerPlace | null>(null)
  const [menu, setMenu] = useState<{ selection: ManagementSelection; vaultId: string; row?: ExplorerResult; request: MenuRequest } | null>(null)
  const [sheet, setSheet] = useState<ExplorerTalk | null>(null)
  const [preview, setPreview] = useState<ExplorerTalk | null>(null)
  const [tools, setTools] = useState(false)
  const [shortcuts, setShortcuts] = useState(explorerShortcuts)
  const host = useRef<HTMLElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const toolsMenu = useRef<HTMLDivElement>(null)
  const live = useRef(false)
  const acceptedPreferred = useRef<string | null>(null)
  const inFlight = useRef(false)
  const menuId = useRef(0)
  const { meta } = useTalkFacts()
  const vaults = useMemo(() => explorerVaults(management.vaults, management.talks, management.foldersByVault), [management.vaults, management.talks, management.foldersByVault])
  const talks = useMemo(() => vaults.flatMap(item => item.talks), [vaults])
  const vaultIds = useMemo(() => vaults.filter(usable).map(item => item.vault.id), [vaults])
  const latest = useRef(talks)
  latest.current = talks
  const current = vaults.find(item => item.vault.id === place?.vaultId)
  const folder = place?.folder ?? ''
  const inside = current && usable(current) ? folderTalks(current.talks, folder) as ExplorerTalk[] : []
  const direct = all ? inside : inside.filter(talk => talk.folder === folder)
  const [initialHistory] = useState(readExplorerHistory)
  const history = useRef(initialHistory)
  const edited = (talk: ExplorerTalk) => meta[talk.info.outlinePath]?.editedMs ?? talk.cachedEditedMs ?? 0
  const recents = useMemo(() => [...talks, ...vaults.flatMap(item => item.vault.open && item.vault.unavailable
    ? offlineExplorerTalks(item, history.current[item.vault.id]) : [])].sort((a, b) => edited(b) - edited(a)).slice(0, 5), [talks, vaults, meta])
  useEffect(() => {
    if (!vaults.length) return
    const saved = readExplorerHistory()
    const updated: ExplorerHistory = Object.create(null)
    for (const item of vaults) {
      const { id, root } = item.vault
      const previous = saved[id]?.root === root ? saved[id] : history.current[id]?.root === root ? history.current[id] : undefined
      if (!usable(item)) {
        if (previous) updated[id] = previous
        continue
      }
      const previousDates = new Map(Array.isArray(previous?.recent) ? previous.recent.map(entry => [entry?.info?.outlinePath, entry?.editedMs]) : [])
      const recent = item.talks.map(talk => ({ info: talk.info,
        editedMs: meta[talk.info.outlinePath]?.editedMs ?? previousDates.get(talk.info.outlinePath) ?? 0 }))
        .sort((a, b) => b.editedMs - a.editedMs).slice(0, 5)
      updated[id] = { root, count: item.talks.length, recent }
    }
    history.current = updated
    writeExplorerHistory(updated)
  }, [vaults, meta])
  const queried = !!query.trim()
  const queryPlace = wide ? null : place && current && usable(current) ? place : null
  const search = useExplorerSearch(query, talks, vaultIds, queryPlace)
  const searched = scope === 'slides' ? search.slides : search.titles
  const vaultMatches = useMemo(() => filterVault ? searched.filter(row => row.talk.vaultId === filterVault) : searched, [searched, filterVault])
  const matches = useMemo(() => scope === 'slides' && filterField
    ? vaultMatches.filter(({ slide }) => slide?.matchEvidence?.fields[filterField])
    : vaultMatches, [vaultMatches, scope, filterField])
  const results = useMemo(() => scope === 'slides' ? matches.slice(0, slideLimit) : matches, [matches, scope, slideLimit])
  const slideCounts = useMemo(() => {
    const counts = new Map<string, number>()
    if (scope === 'slides') for (const { talk } of matches) {
      counts.set(talk.info.outlinePath, (counts.get(talk.info.outlinePath) ?? 0) + 1)
    }
    return counts
  }, [matches, scope])
  const foundIn = scope === 'slides' ? FOUND_IN.filter(([field]) =>
    vaultMatches.some(({ slide }) => slide?.matchEvidence?.fields[field])) : []
  const pending = scope === 'slides' && search.pending
  const searchUnavailable = scope === 'slides' && search.unavailable
  const alternateCount = scope === 'slides' ? plural(search.titles.length, 'talk') :
    search.pending || search.unavailable ? null : plural(search.slides.length, 'slide')
  const active = results[Math.min(position, results.length - 1)]
  const save = destination && vaultIds.includes(destination.vaultId) ? destination
    : place && vaultIds.includes(place.vaultId) ? place
    : vaultIds.length ? { vaultId: preferredVaultId && vaultIds.includes(preferredVaultId) ? preferredVaultId : vaultIds[0], folder: '' } : null
  const allShown = !queried && !current
  const scopeKey = JSON.stringify([place, all, query, scope, filterVault, filterField, sort, view])
  const known = useGalleryFacts(queried ? results.map(row => row.talk) : allShown ? talks : direct, scopeKey, host, true)
  const currentName = current && (folder ? leafName(folder) : current.vault.name)
  const openCount = vaultIds.length

  useEffect(() => {
    live.current = true
    const previous = document.activeElement as HTMLElement | null
    const siblings = Array.from(frame.current?.parentElement?.children ?? []).filter(node => node !== frame.current && !node.hasAttribute('inert'))
    siblings.forEach(node => node.setAttribute('inert', ''))
    setWorkspaceCovered(true)
    if (onClose) frame.current?.focus({ preventScroll: true })
    return () => {
      live.current = false
      siblings.forEach(node => node.removeAttribute('inert'))
      setWorkspaceCovered(false)
      if (onClose) previous?.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => onKeymapChanged(() => setShortcuts(explorerShortcuts())), [])
  useEffect(() => {
    if (!tools) return
    const close = (event: PointerEvent) => { if (!toolsMenu.current?.contains(event.target as Node)) setTools(false) }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [tools])
  useEffect(() => {
    const media = matchMedia(NARROW)
    const change = () => { setNarrow(media.matches); if (media.matches) { setStartOpen(false); setSidebar(false) } }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    if (!preferredVaultId || acceptedPreferred.current === preferredVaultId || !vaultIds.includes(preferredVaultId)) return
    acceptedPreferred.current = preferredVaultId
    setDestination({ vaultId: preferredVaultId, folder: '' })
  }, [preferredVaultId, vaultIds])
  useEffect(() => { if (sheet) known.loadHandouts(sheet) }, [sheet])
  useEffect(() => { if (preview) known.wantCover(preview) }, [preview])

  const resetPosition = () => { setPosition(0); setSlideLimit(SLIDE_PAGE_SIZE) }
  const chooseVaultFilter = (id: string | null) => { setFilterVault(id); setFilterField(null); resetPosition() }
  const resetQuery = (text: string) => { setQuery(text); chooseVaultFilter(null); setMenu(null) }
  const go = (next: ExplorerPlace | null, showAll = false) => {
    setPlace(next); setAll(showAll); setDestination(next); resetQuery(''); setWide(false)
    if (next) {
      setExpanded(old => ({ ...old, [next.vaultId]: new Set([...(old[next.vaultId] ?? []), ...ancestorsOf(next.folder), next.folder]) }))
      setClosedTrees(old => new Set([...old].filter(id => id !== next.vaultId)))
    }
    if (narrow) setSidebar(false)
    host.current?.scrollTo(0, 0)
  }
  const toggleStart = () => { setStartOpen(!startOpen); if (narrow) setSidebar(false) }
  const toggleSide = () => { setSidebar(!sidebar); if (narrow) setStartOpen(false) }
  const run = (op: () => Promise<unknown>): boolean => {
    if (inFlight.current) return false
    inFlight.current = true; setBusy(true); setError('')
    void op().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => { inFlight.current = false; setBusy(false) })
    return true
  }
  const runStart = (op: () => Promise<string | null>) => { run(async () => { setError(await op() ?? '') }) }
  const open = (row: ExplorerResult, newWindow: boolean, recent = false) => {
    if (row.talk.vault.unavailable) return
    run(async () => {
      const expected = row.talk.info.outlinePath
      const key = galleryIdentity(row.talk)
      const stillHere = () => live.current && latest.current.some(talk => galleryIdentity(talk) === key && talk.info.outlinePath === expected)
      if (!stillHere()) return
      const targetSlide = slideTarget(row)
      if (newWindow) {
        const talk = await window.tw.vault.galleryTalk(row.talk.vaultId, row.talk.relativeOutline)
        if (!stillHere() || !talk || talk.outlinePath !== expected) throw new Error('This talk is no longer available.')
        const reply = await window.tw.windows.openInNewWindow({ kind: 'talk', outlinePath: talk.outlinePath, slide: targetSlide })
        if (!reply.ok) throw new Error('Couldn’t open the talk in a new window.')
      } else {
        const catalogue = await window.tw.vault.galleryCatalogue(0)
        if (await openGalleryTalk(row.talk, catalogue.rootGeneration, stillHere, (talk, guard) => onOpen(talk, guard, targetSlide, recent))) onClose?.()
      }
    })
  }

  const activateRecent = (talk: ExplorerTalk, newWindow: boolean) => open({ talk }, newWindow, true)
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    // SCAN_IGNORE: movement and activation in the focused results list.
    if (event.nativeEvent.isComposing) return
    if (active && !isTypingKey(event.nativeEvent) && surfaceKey(event.nativeEvent, 'vault-explorer.open-window')) {
      event.preventDefault(); event.stopPropagation(); open(active, true); return
    }
    if (event.altKey || event.shiftKey) return
    const modifier = event.metaKey || event.ctrlKey
    if (!modifier && event.key === 'Enter' && active) { event.preventDefault(); event.stopPropagation(); open(active, false) }
    if (modifier || !queried) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(results.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)))
      setPosition(next)
      document.getElementById(`vx-result-${next}`)?.scrollIntoView({ block: 'nearest' })
    }
  }
  const menuAt = (selection: ManagementSelection, id: string, event: MouseEvent<HTMLElement>, row?: ExplorerResult) => {
    event.preventDefault()
    if (inFlight.current) return
    const menuKey = row ? resultKey(row) : JSON.stringify(selection)
    const rect = event.currentTarget.getBoundingClientRect()
    setMenu({ selection, vaultId: id, row, request: { id: ++menuId.current, key: menuKey,
      x: event.type === 'contextmenu' ? event.clientX : rect.left, y: event.type === 'contextmenu' ? event.clientY : rect.bottom } })
  }
  const askForFolder = (at: ExplorerPlace) => setFolderPrompt(at)
  useEffect(() => {
    const newTalk = () => { if (save) { setStartOpen(true); if (narrow) setSidebar(false) } }
    const newFolder = () => { if (save) askForFolder(save) }
    const openWindow = () => { if (active ?? menu?.row) open((active ?? menu?.row)!, true) }
    window.addEventListener('tw-explorer-new-talk', newTalk)
    window.addEventListener('tw-explorer-new-folder', newFolder)
    window.addEventListener('tw-explorer-open-window', openWindow)
    return () => {
      window.removeEventListener('tw-explorer-new-talk', newTalk)
      window.removeEventListener('tw-explorer-new-folder', newFolder)
      window.removeEventListener('tw-explorer-open-window', openWindow)
    }
  })
  const sortTalks = (entries: ExplorerTalk[]) => [...entries].sort((a, b) => sort === 'name'
    ? a.title.localeCompare(b.title, undefined, { numeric: true })
    : sort === 'slides' ? (meta[b.info.outlinePath]?.slideCount ?? 0) - (meta[a.info.outlinePath]?.slideCount ?? 0) : edited(b) - edited(a))
  const rows = (rows: ExplorerResult[], label: string, mode: BrowseView = view, location?: ExplorerPlace, recent = false) => <ExplorerRows rows={rows} group={label} view={mode} location={location}
    known={known} meta={meta} query={query} terms={queried ? scope === 'slides' ? search.slideTerms : search.titleTerms : []}
    slideCounts={slideCounts} active={queried && active ? resultKey(active) : undefined} busy={busy} onOpen={(row, newWindow) => open(row, newWindow, recent)}
    onMenu={(row, event) => menuAt({ kind: 'talk', talk: row.talk }, row.talk.vaultId, event, row)} />
  const folders = (item: ExplorerVault, path: string) => <ExplorerFolderCards item={item} folder={path} known={known}
    onOpen={folder => go({ vaultId: item.vault.id, folder })}
    onMenu={(folder, event) => menuAt({ kind: 'folder', path: folder, category: true }, item.vault.id, event)} />
  const matchVerb = matches.length === 1 ? 'matches' : 'match'
  const status = queried ? scope === 'slides'
    ? `${plural(matches.length, 'slide')} in ${plural(slideCounts.size, 'talk')} ${matchVerb}`
    : `${plural(matches.length, 'talk')} ${matchVerb} “${query.trim()}”`
    : current ? !usable(current) ? 'Vault not reachable' : `${plural(inside.length, 'talk')}${!all && direct.length !== inside.length ? ` · ${direct.length} here, ${inside.length - direct.length} in subfolders` : ''}`
    : !vaults.length ? 'No vault yet' : `${plural(talks.length, 'talk')} in ${plural(openCount, 'vault')}`
  const chooseScope = (next: ExplorerSearchScope) => { windowScope = next; setScope(next); chooseVaultFilter(null); searchRef.current?.focus() }
  const unavailable = (item: ExplorerVault) => {
    const snapshot = history.current[item.vault.id]
    const count = snapshot?.root === item.vault.root && Number.isInteger(snapshot.count) ? snapshot.count : null
    return <div className="vx-unavailable">
      <span>{item.vault.unavailable?.message ?? 'This vault is closed.'}{item.vault.unavailable && <> Nothing has been deleted.
        {count !== null && <small className="vx-last-count">Last seen with {plural(count, 'talk')}.</small>}</>}</span>
      <button className="vx-button" type="button" onClick={() => {
        run(() => item.vault.open ? (management.onRecheck?.() ?? management.onRefresh()) : management.onSetVaultOpen(item.vault.id, true))
      }}>{item.vault.open ? 'Try again' : 'Open vault'}</button>
      <button className="vx-button" type="button" onClick={() => management.onEditVault(item.vault.id)}>Vault settings</button>
    </div>
  }

  return <div className={`vault-gallery vault-explorer${sidebar ? ' vx-with-sidebar' : ''}${startOpen && save ? ' vx-with-start' : ''}`}
    ref={frame} tabIndex={-1} role={onClose ? 'dialog' : 'region'} aria-modal={onClose ? true : undefined} aria-label="Vault Explorer"
    onKeyDown={event => {
      // SCAN_IGNORE: local Escape clears the search or dismisses the top Explorer panel.
      if (event.key !== 'Escape' || busy) return
      if (preview) setPreview(null)
      else if (sheet) setSheet(null)
      else if (tools) setTools(false)
      else if (queried) resetQuery('')
      else if (narrow && startOpen) setStartOpen(false)
      else if (narrow && sidebar) setSidebar(false)
      else if (onClose) onClose()
      else return
      event.preventDefault(); event.stopPropagation()
    }}>
    <header className="vx-titlebar tw-window-drag">
      {onClose && <ModeBack talkTitle={activeTitle} onBack={onClose} disabled={busy} />}
      <button className="vx-button vx-sidebar-toggle" type="button" aria-label="Folders sidebar" aria-expanded={sidebar} disabled={!vaults.length} onClick={toggleSide}><PanelLeft size={17} /></button>
      <nav className="vx-crumbs" aria-label="Location">
        <button type="button" onClick={() => go(null)} aria-current={current ? undefined : 'page'}>{vaults.length ? 'All talks' : 'TalkWeaver'}</button>
        {current && <><ChevronRight size={14} /><button type="button" onClick={() => go({ vaultId: current.vault.id, folder: '' })} aria-current={!folder && !all ? 'page' : undefined}>
          <VaultBadge vault={current.vault} size={16} />{current.vault.name}</button>
          {crumbParts(folder).map(({ label, path }) => <Fragment key={path ?? 'gap'}><ChevronRight size={14} />
            {path === null ? <span>{label}</span> : <button type="button" aria-current={path === folder ? 'page' : undefined} onClick={() => go({ vaultId: current.vault.id, folder: path })}>{label}</button>}
          </Fragment>)}
          {all && <><ChevronRight size={14} /><span aria-current="page">All talks</span></>}
        </>}
      </nav>
      {save && <button className="vx-button" type="button" aria-expanded={startOpen} onClick={toggleStart}><Plus size={16} />New talk</button>}
      <div className="vx-tools" ref={toolsMenu}>
        <button className="vx-button" type="button" aria-expanded={tools} onClick={() => setTools(!tools)}><Wrench size={15} />Tools</button>
        {tools && <div className="vx-popover" role="group" aria-label="Explorer tools">
          {onStorage && <button type="button" onClick={() => { setTools(false); onStorage(place) }}>Details and storage</button>}
          <button type="button" onClick={() => { setTools(false); void window.tw.tools.open('studio') }}>Studio</button>
          <button type="button" onClick={() => { setTools(false); void window.tw.tools.open('runs') }}>Runs</button>
          <button type="button" onClick={() => { setTools(false); onSettings() }}>Settings</button>
        </div>}
      </div>
    </header>
    {sidebar && <aside className="vx-sidebar" aria-label="Vaults and folders">
      <div className="vx-sidebar-bar"><div className="vx-seg" role="group" aria-label="Sidebar view">
        {(['Folders', 'Recent'] as const).map(value => <button key={value} type="button" aria-pressed={sideMode === value} onClick={() => setSideMode(value)}>{value}</button>)}
      </div></div>
      <div className="vx-sidebar-body">{sideMode === 'Recent' ? recents.map(talk => <div className="vx-side-recent" key={galleryIdentity(talk)}>
        <button className="vx-tree-row" type="button" disabled={busy || !!talk.vault.unavailable}
          onContextMenu={event => { if (!talk.vault.unavailable) menuAt({ kind: 'talk', talk }, talk.vaultId, event, { talk }) }}
          onKeyDown={event => {
            // SCAN_IGNORE: modified activation of a focused recent talk.
            if (surfaceKey(event.nativeEvent, 'vault-explorer.open-window')) {
              event.preventDefault(); event.stopPropagation(); activateRecent(talk, true)
            }
          }} onClick={event => activateRecent(talk, event.metaKey || event.ctrlKey)}>
          <VaultBadge vault={talk.vault} />{plainTalkTitle(talk.title)}{talk.vault.unavailable && <small>Vault not reachable</small>}
        </button>
        {!talk.vault.unavailable && <button className="vx-button vx-side-open" type="button" aria-label={`Open ${talk.title} in new window`}
          title="Open in new window" onClick={() => activateRecent(talk, true)} disabled={busy}><ExternalLink size={14} /></button>}
      </div>)
        : vaults.map(item => {
          const { vault } = item, show = usable(item) && !closedTrees.has(vault.id)
          return <section key={vault.id} className="vx-tree-vault" style={{ '--vc': vault.color } as CSSProperties}>
            <button className={`tl-vhead${usable(item) ? '' : ' is-unavailable'}`} type="button" aria-expanded={show} style={{ '--vc': vault.color } as CSSProperties}
              onClick={() => usable(item) ? setClosedTrees(old => { const next = new Set(old); if (!next.delete(vault.id)) next.add(vault.id); return next }) : go({ vaultId: vault.id, folder: '' })}>
              <ChevronRight size={13} className={show ? 'vx-chevron-open' : ''} /><VaultBadge vault={vault} size={22} />
              <span className="tl-vtext"><strong className="tl-vname">{vault.name}</strong><span className={`tl-vsub${vault.unavailable ? ' vx-vault-reason' : ''}`}>{vault.unavailable?.message ?? vaultLocation(item)}</span></span>
            </button>
            {show && <>
              <button className="vx-tree-row" type="button" aria-current={place?.vaultId === vault.id && all ? 'page' : undefined} onClick={() => go({ vaultId: vault.id, folder: '' }, true)}><LayoutGrid size={15} />All talks<span>{item.talks.length}</span></button>
              {treeNodes(item.talks, item.folders, expanded[vault.id] ?? new Set()).map(node => <button key={node.path} type="button" className="vx-tree-row" title={node.path}
                style={{ paddingInlineStart: Math.min(node.depth, 8) * 13 }} aria-current={place?.vaultId === vault.id && !all && folder === node.path ? 'page' : undefined}
                onClick={() => go({ vaultId: vault.id, folder: node.path })} onContextMenu={event => menuAt({kind:'folder', path:node.path, category:true}, vault.id, event)}>
                <Folder size={16} className="vg-ic-folder" />{node.name}<span>{node.count}</span>
              </button>)}
            </>}
          </section>
        })}</div>
      <button className="vx-button vx-sidebar-add" type="button" onClick={management.onAddVault}><Plus size={15} />Add vault…</button>
    </aside>}
    <div className="vx-toolbar" role="toolbar" aria-label="Browse and search">
      <div className="vx-search">
        <Search size={17} /><input ref={searchRef} role="combobox" aria-label="Search talks" aria-expanded={queried && !!results.length}
          aria-controls={queried && results.length ? 'vx-results' : undefined} aria-activedescendant={active ? `vx-result-${Math.min(position, results.length - 1)}` : undefined}
          placeholder={queryPlace && currentName ? `Search in ${currentName}` : 'Search all your talks'} value={query} disabled={!openCount}
          onChange={e => resetQuery(e.currentTarget.value)} onKeyDown={searchKeys} />
        {queried ? <button type="button" aria-label="Clear search" onClick={() => { resetQuery(''); searchRef.current?.focus() }}><X size={14} /></button>
          : shortcuts.search && <kbd>{shortcuts.search}</kbd>}
      </div>
      <div className="vx-seg" role="group" aria-label="Search scope">
        <button type="button" disabled={!openCount} aria-pressed={scope === 'titles'} onClick={() => chooseScope('titles')}>Titles</button>
        <button type="button" disabled={!openCount} aria-pressed={scope === 'slides'} onClick={() => chooseScope('slides')}>Slide content</button>
      </div>
      <span className="vx-grow" />
      <label className="vx-sort" title="Sort talks"><ListFilter size={16} /><select aria-label="Sort talks" value={queried ? 'match' : sort} disabled={!openCount || queried}
        onChange={e => setSort(e.currentTarget.value as typeof sort)}>{queried && <option value="match">Best match</option>}
        <option value="edited">Last edited</option><option value="name">Name</option><option value="slides">Slides</option></select></label>
      <div className="vx-seg" role="group" aria-label="View">{([['List', List], ['Gallery', LayoutGrid]] as const).map(([value, Icon]) =>
        <button key={value} type="button" disabled={!openCount} aria-pressed={view === value} aria-label={value} title={value}
          onClick={() => {
            setView(value)
            try { localStorage.setItem(VIEW, value) } catch { /* this window can still change its view */ }
          }}><Icon size={15} /><span>{value}</span></button>)}</div>
      {current && usable(current) && !queried && <button className="vx-button vx-new-folder" type="button" disabled={busy} aria-label="New folder"
        onClick={() => askForFolder({ vaultId: current.vault.id, folder })}><FolderPlus size={16} /><span>New folder</span></button>}
      <GalleryManagement compact management={management} vaultId={menu?.vaultId ?? null} folder={folder} selection={menu?.selection ?? null}
        menuRequest={menu?.request} menuKey={menu?.request.key} busy={busy} run={run}
        openTalk={() => { if (menu?.row) open(menu.row, false) }} openTalkInNewWindow={() => { if (menu?.row) open(menu.row, true) }} newWindowHint={shortcuts.newWindow}
        openFolder={path => { if (menu) go({ vaultId: menu.vaultId, folder: path }) }}
        showHandouts={talk => setSheet(talks.find(row => galleryIdentity(row) === galleryIdentity(talk)) ?? null)}
        canPreview={!!menu?.row} preview={() => setPreview(menu?.row?.talk ?? null)}
        copyLocation={() => { if (menu) {
          const root = vaults.find(item => item.vault.id === menu.vaultId)?.vault.root
          const path = menu.row?.talk.info.path ?? (root && menu.selection?.kind === 'folder' ? [root, menu.selection.path].join('/') : null)
          if (path) run(() => navigator.clipboard.writeText(path))
        } }}
        resolve={talk => window.tw.vault.galleryTalk(talk.vaultId, talk.relativeOutline)}
        reconcile={({ folder: next, op }) => {
          if (menu && next !== undefined && op && place?.vaultId === menu.vaultId && (folder === op.path || folder.startsWith(op.path + '/'))) {
            go({ vaultId: menu.vaultId, folder: op.kind === 'rename' ? next + folder.slice(op.path.length) : parentOf(op.path) })
          }
          setMenu(null)
        }} />
    </div>
    <main className="vx-content" ref={host}>
      {error && !(startOpen && save) && <p className="vx-error" role="alert">{error}</p>}
      {!vaults.length ? <div className="vx-setup">
        <h1>Choose where to keep your talks</h1><p>TalkWeaver keeps your talks in a folder on your disk, called a vault. You can add more vaults later.</p>
        <button className="vx-button primary" type="button" disabled={busy} onClick={() => runStart(onDefaultVault)}><HardDrive size={21} /><span><strong>Make a vault in Documents</strong><small>Documents/TalkWeaver, on this Mac</small></span><b>Make vault</b></button>
        <button className="vx-button" type="button" disabled={busy} onClick={actions.chooseVault}><Folder size={21} className="vg-ic-folder" /><span><strong>Use a folder you already have</strong><small>A local or synced folder, or a vault from another computer</small></span><b>Choose folder…</b></button>
        <button className="vx-button" type="button" disabled={busy} onClick={() => runStart(actions.examples)}><GraduationCap size={21} /><span><strong>Look at the example talks first</strong><small>Open the example vault to try TalkWeaver.</small></span><b>Open examples</b></button>
      </div> : queried ? <>
        <div className="vx-search-heading"><h2 aria-live="polite">{pending ? 'Searching slides…' : status}</h2>
          {(queryPlace || wide) && <button className="vx-button" type="button" aria-pressed={wide} onClick={() => { setWide(!wide); chooseVaultFilter(null) }}>{wide ? 'Back to this folder' : 'Search all vaults'}</button>}
          {openCount > 1 && !queryPlace && searched.length > 0 && <div className="vx-chips" role="group" aria-label="Filter by vault">
            <button className="vx-button" type="button" aria-pressed={!filterVault} onClick={() => chooseVaultFilter(null)}>All vaults · {searched.length}</button>
            {vaults.map(item => {
              const count = searched.filter(row => row.talk.vaultId === item.vault.id).length
              return count > 0 && <button className="vx-button" type="button" key={item.vault.id} aria-pressed={filterVault === item.vault.id} onClick={() => chooseVaultFilter(item.vault.id)}><VaultBadge vault={item.vault} size={16} />{item.vault.name} · {count}</button>
            })}
          </div>}
        </div>
        {foundIn.length > 0 && <div className="vx-chips vx-found-in" role="group" aria-label="Found in"><span>Found in</span>
          {foundIn.map(([field, label]) => <button className="vx-button" type="button" key={field} aria-pressed={filterField === field}
            onClick={() => { setFilterField(filterField === field ? null : field); resetPosition() }}>{label}</button>)}
        </div>}
        {rows(results, 'Search results')}
        {scope === 'titles' && results.length > 0 && !search.pending && !search.unavailable && <p className="vx-related-results">
          Also on {alternateCount} · <button type="button" onClick={() => chooseScope('slides')}>Search slide content</button>
        </p>}
        {results.length < matches.length && <button className="vx-button vx-show-more" type="button"
          onClick={() => setSlideLimit(limit => limit + SLIDE_PAGE_SIZE)}>Show more · {matches.length - results.length} remaining</button>}
        {!results.length && !pending && <div className="vx-empty"><Search size={30} /><h2>{searchUnavailable ? 'Slide search is unavailable' : 'No matches'}</h2>
          <p>{searchUnavailable ? 'Try the search again or search talk titles.' : `No ${scope === 'slides' ? 'slide content' : 'talk titles or folders'} matched “${query.trim()}”.`}</p>
          {alternateCount !== null && <p>{scope === 'slides' ? `Titles: ${alternateCount}.` : `Slide content: ${alternateCount}.`}</p>}
          <button className="vx-button" type="button" onClick={() => chooseScope(scope === 'slides' ? 'titles' : 'slides')}>{scope === 'slides' ? 'Search titles' : 'Search slide content'}</button>
          <button className="vx-button" type="button" onClick={() => { resetQuery(''); searchRef.current?.focus() }}>Clear search</button>
        </div>}
      </> : current ? usable(current) ? <>
        {!all && current.folders.some(path => parentOf(path) === folder) && <><h2>Folders</h2>{folders(current, folder)}</>}
        {direct.length > 0 && <><div className="vx-section-heading"><h2>Talks in {currentName} · {direct.length}</h2>
          {!all && direct.length !== inside.length && <button className="vx-button" type="button" onClick={() => go(place, true)}>Show all {inside.length} talks</button>}</div>
          {rows(sortTalks(direct).map(talk => ({ talk })), 'Talks in folder', view, place ?? undefined)}</>}
        {!direct.length && !current.folders.some(path => !all && parentOf(path) === folder) && <div className="vx-empty"><Folder size={32} /><h2>No talks here yet</h2><p>Create or import a talk to see it here.</p>
          <button className="vx-button" type="button" onClick={() => { setStartOpen(true); if (narrow) setSidebar(false) }}>Start a new talk</button></div>}
      </> : unavailable(current) : <>
        {recents.length > 0 && <section aria-label="Recent talks"><h2>Recent talks</h2>{rows(recents.map(talk => ({ talk })), 'Recent talks', view, undefined, true)}</section>}
        {vaults.map(item => <section className="vx-vault-section" key={item.vault.id} aria-label={item.vault.name} style={{ '--vc': item.vault.color } as CSSProperties}>
          <button className={`vx-vault-heading${usable(item) ? '' : ' vx-vault-unavailable'}`} type="button" aria-label={`Browse ${item.vault.name}`}
            onClick={() => go({ vaultId: item.vault.id, folder: '' })}><VaultBadge vault={item.vault} size={24} />
            <strong>{item.vault.name}</strong><span className="vx-vault-path" title={item.vault.root}>{vaultLocation(item)}</span>
            <span className="vx-vault-count">{usable(item) ? plural(item.talks.length, 'talk') : item.vault.open ? 'Not reachable' : 'Closed'}</span></button>
          {!usable(item) ? unavailable(item) : <>
            {folders(item, '')}
            {!item.folders.length && !item.talks.length && <div className="vx-empty vx-empty-vault"><h2>No talks in {item.vault.name} yet</h2><p>Start a talk, import PowerPoint, or create a folder.</p>
              <button className="vx-button" type="button" onClick={() => { setDestination({ vaultId: item.vault.id, folder: '' }); setStartOpen(true); if (narrow) setSidebar(false) }}>Start a new talk</button>
              <button className="vx-button" type="button" onClick={actions.importPowerPoint}>Import PowerPoint…</button>
              <button className="vx-button" type="button" onClick={() => askForFolder({ vaultId: item.vault.id, folder: '' })}>New folder</button></div>}
          </>}
        </section>)}
      </>}
    </main>
    {narrow && (sidebar || startOpen) && <button className="vx-scrim" aria-label="Close side panel" type="button" onClick={() => { setSidebar(false); setStartOpen(false) }} />}
    <ExplorerStart actions={actions} place={save} places={vaults} open={startOpen && !!save} setPlace={setDestination} newFolder={askForFolder} busy={busy} run={runStart} error={error} />
    <footer className="vx-status"><span>{status}</span>{queried && !!results.length && <span><kbd>↑ ↓</kbd> move <kbd>↵</kbd> open {shortcuts.newWindow && <><kbd>{shortcuts.newWindow}</kbd> new window</>} <kbd>esc</kbd> clear</span>}</footer>
    {folderPrompt && <ManagementLayer onDismiss={() => setFolderPrompt(null)}>
      <PromptModal label="New folder" kind="folder" mode="new" initial="" cta="Create" onCancel={() => setFolderPrompt(null)}
        onSubmit={name => {
          if (!name.trim()) return
          run(async () => {
            const path = await window.tw.vault.createFolder(name.trim(), folderPrompt.folder, folderPrompt.vaultId)
            if (path === null) throw new Error('Couldn’t create the folder. Check the name and the vault.')
            await management.onRefresh()
            setDestination({ vaultId: folderPrompt.vaultId, folder: path })
            setFolderPrompt(null)
          })
        }} />
    </ManagementLayer>}
    {sheet && <GalleryHandoutSheet title={sheet.title} value={known.handouts[galleryIdentity(sheet)]} close={() => setSheet(null)} />}
    {preview && <div className="vg-sheetwrap" onClick={() => setPreview(null)}><div className="vg-sheet wide" role="region" aria-label={`Title preview: ${preview.title}`} onClick={e => e.stopPropagation()}>
      <h2>{preview.title}</h2><div className="vg-slidebox">
        {known.facts[galleryIdentity(preview)]?.coverUrl ? <img src={known.facts[galleryIdentity(preview)].coverUrl!} alt={`Title slide of ${preview.title}`} /> : 'Title preview unavailable'}
      </div><button className="vg-tbtn" autoFocus onClick={() => setPreview(null)}>Close title preview</button>
    </div></div>}
  </div>
}

function explorerShortcuts() {
  return {
    search: effectiveKeys('sidebar.talks') ? liveShortcutLabel('app.sidebar-talks') : '',
    newWindow: effectiveKeys('vault-explorer.open-window') ? liveShortcutLabel('vault-explorer.open-window') : ''
  }
}
