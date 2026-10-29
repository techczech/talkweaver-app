// The Slide Scratchpad panel: candidates for the open talk (picked slides and agent visuals) to look at,
// sort and decide on. Floating over the workspace (header drags it, the corner resizes it), docked to the
// right, or collapsed to a pill. Keep and Reject only change an item's status. The two Insert buttons (ticket 2) are
// and card drags ask the workspace to change the outline (`insert`, ScratchpadInsert.tsx);
// no agent file is ever touched. Spec: docs/design/2026-10-27-slide-scratchpad/.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Search } from 'lucide-react'
import {
  LISTS, LIST_LABEL, TYPE_LABEL, scratchOrder, batchSections, groupCounts, listCounts, parseQuery, toggleTypeInQuery, typeCounts, visibleItems,
  type ScratchGroupFilter, type ScratchItem, type ScratchList, type ScratchTypeKey
} from '../../../../shared/scratchpad'
import { useSlideSelection } from '../../lib/useSlideSelection'
import { DOCK_WIDTH } from '../../../../shared/scratchpad-layout'
import type { ScratchpadData } from '../../lib/useScratchpad'
import type { ScratchpadLayoutApi } from '../../lib/useScratchpadLayout'
import { notify } from '../../lib/notify'
import { ScratchpadCard } from './ScratchpadCard'
import { ScratchpadEmpty } from './ScratchpadEmpty'
import { ScratchpadGroupMenu, type GroupMenuRow } from './ScratchpadGroupMenu'
import { ScratchpadPreview } from './ScratchpadPreview'
import { ScratchpadCompare } from './ScratchpadCompare'
import { ScratchpadInsertButtons, ScratchpadPlaceNote, type ScratchpadInsertApi } from './ScratchpadInsert'
import { scratchVisuals, placeRows } from '../../../../shared/scratchpad-insert'
import '../../scratchpad.css'

/** What the command registry's Slide Scratchpad commands run (WorkspaceLayout's handler map calls these). */
export interface ScratchpadActions {
  'scratchpad-move-up'?: () => void
  'scratchpad-move-down'?: () => void
  'scratchpad-keep'?: () => void
  'scratchpad-reject'?: () => void
  'scratchpad-move-back'?: () => void
  'scratchpad-move-to-group'?: () => void
  'scratchpad-new-group'?: () => void
  'scratchpad-remove-missing'?: () => void
  'scratchpad-insert-slide'?: () => void
  'scratchpad-insert-visual'?: () => void
  'scratchpad-compare'?: () => void
  'scratchpad-change-place'?: () => void
}

/** Compare side by side takes this many ticked items. */
export const COMPARE_MIN = 2
export const COMPARE_MAX = 4

const TYPE_CHIPS: ScratchTypeKey[] = ['slide', 'svg', 'html', 'pic']
const plural = (n: number): string => (n === 1 ? '1 item' : `${n} items`)

export default function ScratchpadPanel({ data, layoutApi, registerActions, onOpenSlideBrowser, insert, outlineText = '' }: {
  outlineText?: string
  data: ScratchpadData
  layoutApi: ScratchpadLayoutApi
  registerActions: (actions: ScratchpadActions) => void
  onOpenSlideBrowser: () => void
  /** Inserting (ticket 2): what the workspace offers; without it the panel shows no Insert buttons. */
  insert?: ScratchpadInsertApi
}): JSX.Element {
  const { layout } = layoutApi
  const { items, groups } = data.snapshot
  const [query, setQuery] = useState('')
  const [list, setList] = useState<ScratchList>('all')
  const [group, setGroup] = useState<ScratchGroupFilter>('all')
  const inTalkIds = new Set([...outlineText.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)].map(match => match[1]))
  const inTalk = (item: ScratchItem): boolean => Boolean(item.slide?.slideId && inTalkIds.has(item.slide.slideId))
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [menu, setMenu] = useState<'filter' | 'move' | 'new' | null>(null)
  /** Compare side by side: the items in the columns, in the order they were ticked; null shows the list. */
  const [compareIds, setCompareIds] = useState<string[] | null>(null)
  /** Change place is open (from the note's link or the command). */
  const [placeOpen, setPlaceOpen] = useState(false)

  // A choice that points at an item or group that is gone is dropped.
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id))
    setPreviewId((p) => (p && !ids.has(p) ? null : p))
    setCompareIds((c) => (c && c.some((id) => !ids.has(id)) ? (c.filter((id) => ids.has(id)).length > 0 ? c.filter((id) => ids.has(id)) : null) : c))
  }, [items])
  useEffect(() => {
    if (group !== 'all' && group !== 'ungrouped' && !groups.some((g) => g.id === group)) setGroup('all')
  }, [groups, group])

  const counts = useMemo(() => listCounts(items), [items])
  const types = useMemo(() => typeCounts(items), [items])
  const gCounts = useMemo(() => groupCounts(items, groups), [items, groups])
  const parsed = useMemo(() => parseQuery(query), [query])
  const manual = data.snapshot.sort === 'manual'
  const visible = useMemo(() => {
    const result = visibleItems(items, { list, group, query })
    if (!manual) return result
    const order = scratchOrder(items, data.snapshot.order)
    const rank = new Map(order.map((id, index) => [id, index]))
    return result.sort((a,b) => rank.get(a.id)! - rank.get(b.id)!)
  }, [items, list, group, query, manual, data.snapshot.order])
  const sections = useMemo(() => (manual || list === 'kept' || list === 'rejected' ? null : batchSections(visible)), [visible, list, manual])
  const displayed = useMemo(() => sections ? sections.flatMap(section => section.items) : visible, [sections, visible])
  const selection = useSlideSelection(displayed.map(item => item.id))
  const selectedIds = selection.pickedIndices.map(index => displayed[index].id)
  const batchIds = displayed.filter(item => selectedIds.includes(item.id)).map(item => item.id)
  const batchSlideCount = batchIds.reduce((count, id) => { const item = items.find(candidate => candidate.id === id); return count + (item?.kind === 'slide' ? placeRows(item.slide?.markdown ?? '').filter(row => row.level >= 2).length : 1) }, 0)
  const focusedId = selection.focusedIndex == null ? null : displayed[selection.focusedIndex].id
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const groupOf = (id: string | null) => groups.find((g) => g.id === id) ?? null
  const groupName = group === 'ungrouped' ? 'Ungrouped' : groups.find((g) => g.id === group)?.name ?? ''

  const targetIds = useCallback((): string[] => (selectedIds.length > 0 ? selectedIds : focusedId ? [focusedId] : []), [selectedIds, focusedId])
  const orderDrag = useRef<string[] | null>(null)
  const arrange = (picked: string[], target: string, after = false): void => {
    if (insert?.busy || picked.includes(target)) return
    const ids = displayed.map(item => item.id)
    const moving = ids.filter(id => picked.includes(id))
    const next = ids.filter(id => !picked.includes(id))
    const at = next.indexOf(target)
    if (!moving.length || at < 0) return
    next.splice(at + (after ? 1 : 0), 0, ...moving)
    if (next.some((id, index) => id !== ids[index])) void data.reorder(ids, next)
  }
  const moveSelected = (down: boolean): void => {
    const picked = targetIds(); const ids = displayed.map(item => item.id)
    const indices = ids.map((id,index) => picked.includes(id) ? index : -1).filter(index => index >= 0)
    if (!indices.length) return
    const edge = down ? indices[indices.length - 1] + 1 : indices[0] - 1
    if (ids[edge]) arrange(picked, ids[edge], down)
  }
  const clearSelection = (): void => { selection.clear(); setMenu(null) }

  const keep = useCallback(async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    if (await data.setStatus(ids, 'kept')) { notify(ids.length === 1 ? 'Kept for the library' : `${ids.length} items kept for the library`, 'info', 'scratchpad'); clearSelection(); setPreviewId(null) }
  }, [data])
  const reject = useCallback(async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    const one = ids.length === 1
    if (await data.setStatus(ids, 'rejected')) { notify(one ? 'Rejected. You can move it back from Rejected.' : `${ids.length} items rejected. You can move them back from Rejected.`, 'info', 'scratchpad'); clearSelection(); setPreviewId(null) }
  }, [data])
  const moveBack = useCallback(async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    if (await data.setStatus(ids, 'active')) { notify('Moved back to the Slide Scratchpad', 'info', 'scratchpad'); clearSelection(); setPreviewId(null) }
  }, [data])
  const moveToGroup = useCallback(async (ids: string[], target: string | null): Promise<void> => {
    if (ids.length === 0) return
    if (await data.setGroup(ids, target)) {
      const name = target ? groups.find((g) => g.id === target)?.name ?? 'the group' : 'Ungrouped'
      notify(`Moved ${plural(ids.length)} to ${name}`, 'info', 'scratchpad'); clearSelection()
    }
  }, [data, groups])
  const removeMissing = useCallback(async (ids: string[]): Promise<void> => {
    const gone = ids.filter((id) => byId.get(id)?.missing)
    if (gone.length === 0) { notify('Choose an item whose file is missing.', 'info', 'scratchpad'); return }
    if (await data.removeMissing(gone)) clearSelection()
  }, [data, byId])

  // The registry's commands act on the current selection and say so when there is none.
  const needSelection = (run: (ids: string[]) => void, what: string) => (): void => {
    const ids = targetIds()
    if (ids.length === 0) notify(`Select Slide Scratchpad items to ${what} first.`, 'info', 'scratchpad')
    else run(ids)
  }
  // The insert commands act on the one item selected (or shown in the big preview).
  const insertOne = (mode: 'slide' | 'visual'): void => {
    const ids = previewId ? [previewId] : targetIds()
    if (mode === 'slide' && ids.length > 1 && insert) { void insert.insertMany(displayed.filter(item => ids.includes(item.id)).map(item => item.id)).then(ok => { if (ok) clearSelection() }); return }
    const item = ids.length === 1 ? byId.get(ids[0]) : undefined
    if (!insert) return
    if (!item) { notify('Select one Slide Scratchpad item to insert first.', 'info', 'scratchpad'); return }
    if (mode === 'slide' && item.kind !== 'slide') { notify('Only a slide picked from a talk can go in whole. Use Insert visual only.', 'info', 'scratchpad'); return }
    if (mode === 'visual' && item.kind === 'slide') {
      const visuals = scratchVisuals(item.slide?.markdown ?? '')
      if (visuals.length > 1) { notify(`This slide shows ${visuals.length} visuals: choose one with Insert visual only in the Slide Scratchpad.`, 'info', 'scratchpad'); selection.reset(displayed.findIndex(i => i.id === item.id)); return }
      void insert.insert(item, 'visual', visuals[0] ?? null)
      return
    }
    void insert.insert(item, mode)
  }
  const compareTicked = (): void => {
    const ids = selectedIds
    if (ids.length < COMPARE_MIN || ids.length > COMPARE_MAX) { notify('Tick 2 to 4 Slide Scratchpad items to compare them side by side.', 'info', 'scratchpad'); return }
    setPreviewId(null); setMenu(null); setCompareIds(ids)
  }
  const actionsRef = useRef<ScratchpadActions>({})
  actionsRef.current = {
    'scratchpad-move-up': () => moveSelected(false),
    'scratchpad-move-down': () => moveSelected(true),
    'scratchpad-keep': needSelection((ids) => void keep(ids), 'keep'),
    'scratchpad-reject': needSelection((ids) => void reject(ids), 'reject'),
    'scratchpad-move-back': needSelection((ids) => void moveBack(ids), 'move back'),
    'scratchpad-move-to-group': needSelection(() => setMenu('move'), 'move'),
    'scratchpad-new-group': () => setMenu('new'),
    'scratchpad-remove-missing': needSelection((ids) => void removeMissing(ids), 'clean up'),
    'scratchpad-insert-slide': () => insertOne('slide'),
    'scratchpad-insert-visual': () => insertOne('visual'),
    'scratchpad-compare': () => compareTicked(),
    'scratchpad-change-place': () => { if (insert) { setPreviewId(null); setPlaceOpen(true) } }
  }
  useEffect(() => {
    registerActions({
      'scratchpad-move-up': () => actionsRef.current['scratchpad-move-up']?.(),
      'scratchpad-move-down': () => actionsRef.current['scratchpad-move-down']?.(),
      'scratchpad-keep': () => actionsRef.current['scratchpad-keep']?.(),
      'scratchpad-reject': () => actionsRef.current['scratchpad-reject']?.(),
      'scratchpad-move-back': () => actionsRef.current['scratchpad-move-back']?.(),
      'scratchpad-move-to-group': () => actionsRef.current['scratchpad-move-to-group']?.(),
      'scratchpad-new-group': () => actionsRef.current['scratchpad-new-group']?.(),
      'scratchpad-remove-missing': () => actionsRef.current['scratchpad-remove-missing']?.(),
      'scratchpad-insert-slide': () => actionsRef.current['scratchpad-insert-slide']?.(),
      'scratchpad-insert-visual': () => actionsRef.current['scratchpad-insert-visual']?.(),
      'scratchpad-compare': () => actionsRef.current['scratchpad-compare']?.(),
      'scratchpad-change-place': () => actionsRef.current['scratchpad-change-place']?.()
    })
  }, [registerActions])

  const toggleTick = (id: string): void => {
    selection.toggle(displayed.findIndex(item => item.id === id))
  }
  const showFolder = (): void => { void window.tw.scratchpad.revealFolder().then((r) => { if (!r.ok) notify(r.error, 'warning', 'scratchpad') }) }

  const createGroupThen = async (name: string, then: (id: string) => void): Promise<boolean> => {
    const created = await data.createGroup(name)
    if (!created) return false
    then(created.id)
    return true
  }
  const filterRows: GroupMenuRow[] = [
    { id: 'all', label: 'All items', count: gCounts.all, current: group === 'all' },
    { id: 'ungrouped', label: 'Ungrouped', count: gCounts.ungrouped, current: group === 'ungrouped' },
    ...groups.map((g) => ({ id: g.id, label: g.name, count: gCounts.byId[g.id] ?? 0, current: group === g.id }))
  ]
  const moveRows: GroupMenuRow[] = [{ id: '', label: 'Ungrouped' }, ...groups.map((g) => ({ id: g.id, label: g.name }))]

  // ── Pointer drag (header) and resize (corner) of the floating box ──────────────────────────────
  const drag = (e: React.PointerEvent, mode: 'move' | 'size'): void => {
    if (layout.mode !== 'float' || e.button !== 0) return
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, box: layout.box }
    const next = (m: PointerEvent) => (mode === 'move'
      ? { ...start.box, x: start.box.x + m.clientX - start.x, y: start.box.y + m.clientY - start.y }
      : { ...start.box, w: start.box.w + m.clientX - start.x, h: start.box.h + m.clientY - start.y })
    const move = (m: PointerEvent): void => layoutApi.setBox(next(m), false)
    const up = (m: PointerEvent): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up)
      layoutApi.setBox(next(m), true)
    }
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up)
  }

  if (layout.mode === 'collapsed') {
    return (
      <button type="button" className="sp-pill" onClick={layoutApi.expand} title="Show the Slide Scratchpad">
        Slide Scratchpad · {data.activeCount} <span>Expand</span>
      </button>
    )
  }

  const docked = layout.mode === 'docked'
  const style = docked ? { width: DOCK_WIDTH, flexBasis: DOCK_WIDTH } : { left: layout.box.x, top: layout.box.y, width: layout.box.w, height: layout.box.h }
  const empty = items.length === 0 && !data.loading
  const previewItem = previewId ? byId.get(previewId) ?? null : null
  const selectedOne = !previewItem && selectedIds.length < 2 ? byId.get(selectedIds[0] ?? focusedId ?? '') ?? null : null
  const listIsTriage = list !== 'kept' && list !== 'rejected'
  const itemActions = (ids: string[], item?: ScratchItem, withMove = true): JSX.Element => (
    item && item.status !== 'active'
      ? <button type="button" className="sp-btn sp-btn--sm" onClick={() => void moveBack(ids)}>Move back</button>
      : (
        <>
          {insert && item && ids.length === 1 && <ScratchpadInsertButtons api={insert} item={item} />}
          <button type="button" className="sp-btn sp-btn--sm" onClick={() => void keep(ids)}>Keep for library</button>
          <button type="button" className="sp-btn sp-btn--sm" onClick={() => void reject(ids)}>Reject</button>
          {withMove && <span className="sp-anchor">
            <button type="button" className="sp-btn sp-btn--sm" aria-haspopup="menu" aria-expanded={menu === 'move'} onClick={() => setMenu(menu === 'move' ? null : 'move')}>Move to group… ▾</button>
            {menu === 'move' && (
              <ScratchpadGroupMenu
                heading={`Move ${plural(ids.length)} to`} rows={moveRows}
                onPick={(id) => void moveToGroup(ids, id === '' ? null : id)}
                onNewGroup={(name) => createGroupThen(name, (id) => void moveToGroup(ids, id))}
                onClose={() => setMenu(null)}
              />
            )}
          </span>}
        </>
      )
  )
  const placeNote = (item: ScratchItem | null): JSX.Element | null => (insert ? <ScratchpadPlaceNote api={insert} item={item} open={placeOpen} onOpenChange={setPlaceOpen} /> : null)
  const compareItems = compareIds ? compareIds.map((id) => byId.get(id)).filter((i): i is ScratchItem => Boolean(i)) : null
  const insertedNote = (item: ScratchItem): string | null => {
    if (!item.insertedAt) return null
    // By title, not number: a number goes stale with the next edit above it. Gone from the talk (an Undo, a delete):
    // said so, and the item can be inserted again as before.
    if (!item.insertedInto) return 'Inserted'
    return insert && !insert.hasSlideTitled(item.insertedInto) ? 'Inserted before · not in the talk now' : `Inserted · ‘${item.insertedInto}’`
  }

  return (
    <section
      className={`sp-panel sp-panel--${docked ? 'docked' : 'float'}${empty ? ' is-empty' : ''}`}
      style={style}
      aria-label="Slide Scratchpad"
    >
      <div className="sp-head" onPointerDown={(e) => drag(e, 'move')}>
        <GripVertical size={14} className="sp-grip" aria-hidden="true" />
        <b>Slide Scratchpad</b>
        <span className="sp-count">{data.activeCount}</span>
        <span className="sp-flex" />
        <button type="button" className="sp-btn sp-btn--sm" onClick={docked ? layoutApi.float : layoutApi.dock}>{docked ? 'Float' : 'Dock to the right'}</button>
        <button type="button" className="sp-btn sp-btn--sm" onClick={layoutApi.collapse}>Collapse</button>
      </div>

      {empty ? (
        <ScratchpadEmpty onShowFolder={showFolder} onOpenSlideBrowser={onOpenSlideBrowser} />
      ) : previewItem ? (
        <ScratchpadPreview
          item={previewItem} inTalk={inTalk(previewItem)}
          group={groupOf(previewItem.group)}
          onBack={() => setPreviewId(null)}
          actions={itemActions([previewItem.id], previewItem)}
          note={previewItem.status === 'active' ? placeNote(previewItem) : null}
        />
      ) : compareItems && compareItems.length > 0 ? (
        <ScratchpadCompare
          items={compareItems} inTalk={inTalk}
          groupOf={groupOf}
          onBack={() => setCompareIds(null)}
          onTakeOut={(id) => setCompareIds((c) => { const next = (c ?? []).filter((x) => x !== id); return next.length > 0 ? next : null })}
          onOpen={(id) => setPreviewId(id)}
          actions={(item) => itemActions([item.id], item, false)}
          note={placeNote(null)}
        />
      ) : (
        <>
          <div className="sp-top">
            <div className="sp-order-controls">
              <label>Order <select aria-label="Scratchpad sort order" value={manual ? 'manual' : 'newest'} disabled={insert?.busy} onChange={event => void data.setSort(event.target.value as 'manual' | 'newest')}><option value="newest">Newest first</option><option value="manual">Your order</option></select></label>
              <button type="button" className="sp-btn sp-btn--sm" aria-label="Move selected items up" disabled={insert?.busy || targetIds().length === 0} onClick={() => moveSelected(false)}>Move up</button>
              <button type="button" className="sp-btn sp-btn--sm" aria-label="Move selected items down" disabled={insert?.busy || targetIds().length === 0} onClick={() => moveSelected(true)}>Move down</button>
            </div>
            <div className="sp-searchrow">
              <label className="sp-search">
                <Search size={14} aria-hidden="true" />
                <input
                  value={query} spellCheck={false} aria-label="Search the Slide Scratchpad"
                  placeholder="Search titles, text inside visuals, talks and slide text"
                  title="Type a kind before your words: slide: svg: html: pic: — or from: and a talk name for one talk"
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && <button type="button" className="sp-link" onClick={() => setQuery('')}>Clear</button>}
              </label>
              <span className="sp-anchor">
                <button type="button" className="sp-btn" aria-haspopup="menu" aria-expanded={menu === 'filter' || menu === 'new'} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}>
                  {group === 'all' ? 'All items' : groupName} ▾
                </button>
                {(menu === 'filter' || menu === 'new') && (
                  <ScratchpadGroupMenu
                    startNaming={menu === 'new'}
                    heading="Show group" rows={filterRows}
                    onPick={(id) => { setGroup(id); if (!listIsTriage) setList('all') }}
                    onNewGroup={(name) => createGroupThen(name, (id) => { setGroup(id); if (!listIsTriage) setList('all') })}
                    onClose={() => setMenu(null)}
                  />
                )}
              </span>
            </div>
            <div className="sp-row2">
            <div className="sp-chips" role="group" aria-label="Show only">
              {TYPE_CHIPS.map((type) => (
                <button key={type} type="button" className={`sp-chip${parsed.types.includes(type) ? ' is-on' : ''}`} aria-pressed={parsed.types.includes(type)} onClick={() => setQuery(toggleTypeInQuery(query, type))}>
                  {TYPE_LABEL[type]}<em>{types[type]}</em>
                </button>
              ))}
            </div>
            <div className="sp-tabs" role="tablist">
            {LISTS.map((l) => (
              <button key={l} type="button" role="tab" aria-selected={list === l} className={list === l ? 'is-on' : ''} onClick={() => { setList(l); clearSelection() }}>
                {LIST_LABEL[l]}<em>{counts[l]}</em>
              </button>
            ))}
            </div>
            </div>
          </div>

          <div className="sp-main">
            {query ? (
              <div className="sp-res"><b>{visible.length}</b> match &ldquo;{query}&rdquo;{group !== 'all' && listIsTriage ? <> in <b>{groupName}</b></> : null} · {manual ? 'your order' : 'newest first'}</div>
            ) : list === 'kept' ? (
              <div className="sp-note">Kept items are marked for your library, which all your talks will share. Move one back to use it in this talk.</div>
            ) : list === 'rejected' ? (
              <div className="sp-note">Rejected items are never deleted. Move one back to bring it into the Slide Scratchpad again.</div>
            ) : group === 'all' ? (
              <div className="sp-res"><b>{visible.length}</b> {visible.length === 1 ? 'item' : 'items'}, {manual ? 'your order' : 'newest first'}</div>
            ) : (
              <div className="sp-res"><b>{groupName}</b> · {plural(visible.length)}, {manual ? 'your order' : 'newest first'}</div>
            )}
            {visible.length === 0 ? (
              <div className="sp-none">
                {query || group !== 'all' ? <>Nothing matches. {query && <button type="button" className="sp-link" onClick={() => setQuery('')}>Clear the search</button>}{query && group !== 'all' ? ' or ' : ''}{group !== 'all' && <button type="button" className="sp-link" onClick={() => setGroup('all')}>show All items</button>}.</> : 'Nothing here.'}
              </div>
            ) : (
              <div className="sp-grid">
                {(sections ?? [{ key: 'flat', day: '', label: '', items: visible }]).map((section, index, all) => (
                  <div className="sp-section" key={section.key}>
                    {sections && section.day !== all[index - 1]?.day && <div className="sp-day">{section.day}</div>}
                    {sections && <div className="sp-batch">{section.label}<em>{section.items.length}</em></div>}
                    <div className="sp-cards">
                      {section.items.map((item) => (
                        <div key={item.id} className="sp-order-card"
                          onDragOver={event => { if (orderDrag.current) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move' } }}
                          onDrop={event => { const moving = orderDrag.current; orderDrag.current = null; if (!moving) return; event.preventDefault(); event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); arrange(moving, item.id, event.clientY > box.top + box.height / 2) }}>
                        <button type="button" className="sp-order-handle" aria-label={`Arrange ${item.title}`} title="Drag to arrange in Your order" draggable={!insert?.busy}
                          onDragStart={event => { event.stopPropagation(); orderDrag.current = selectedIds.includes(item.id) ? batchIds : [item.id]; event.dataTransfer.setData('application/x-talkweaver-scratchpad-order', item.id); event.dataTransfer.effectAllowed = 'move' }}
                          onDragEnd={() => { orderDrag.current = null }}><GripVertical size={14} aria-hidden="true" /></button>
                        <ScratchpadCard item={item} terms={parsed.terms}
                          ticked={selectedIds.includes(item.id)} selected={focusedId === item.id && selectedIds.length === 0}
                          groupTag={group === 'all' ? groupOf(item.group) : null}
                          onSelect={(event) => { const index = displayed.findIndex(i => i.id === item.id); if (event?.shiftKey) selection.extendTo(index, selection.focusedIndex ?? index); else if (event?.metaKey || event?.ctrlKey) selection.toggle(index); else selection.reset(index); setMenu(null) }}
                          onTick={() => toggleTick(item.id)}
                          onOpen={() => setPreviewId(item.id)}
                          onMoveBack={() => void moveBack([item.id])}
                          onRemoveMissing={() => void removeMissing([item.id])}
                          insertedNote={insertedNote(item)}
                          inTalk={inTalk(item)}
                        />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {listIsTriage && (
            <div className="sp-foot">
              {selectedIds.length >= 2 ? (
                <>
                  <div className="sp-batchbar">
                    <b>{selectedIds.length} selected</b>
                    {insert && <button type="button" className="sp-btn sp-btn--sm sp-btn--primary" disabled={insert.busy || selectedIds.some(id => byId.get(id)?.missing)} onClick={() => void insert.insertMany(batchIds).then(ok => { if (ok) clearSelection() })}>{selectedIds.every(id => byId.get(id)?.kind === 'slide') ? `Insert ${batchSlideCount} slides` : 'Insert selection as slides'}</button>}
                    {itemActions(selectedIds)}
                    <button type="button" className="sp-btn sp-btn--sm sp-btn--primary" disabled={selectedIds.length > COMPARE_MAX} onClick={compareTicked}>Compare side by side</button>
                    <span className="sp-flex" />
                    <button type="button" className="sp-link" onClick={clearSelection}>Clear selection</button>
                  </div>
                  {placeNote(null)}
                  {selectedIds.length > COMPARE_MAX && <div className="sp-why">Compare side by side takes 2 to 4 items. Untick some to compare.</div>}
                </>
              ) : selectedOne ? (
                <div className="sp-single">
                  <div className="sp-who">Selected: {selectedOne.title}<span className="sp-flex" /><button type="button" className="sp-link" onClick={() => setPreviewId(selectedOne.id)}>Open big preview</button></div>
                  <div className="sp-actions">{itemActions([selectedOne.id], selectedOne)}</div>
                  {selectedOne.status === 'active' && placeNote(selectedOne)}
                </div>
              ) : (
                <>
                  <div className="sp-idle">Click an item to see what you can do with it. Tick several to act on them together or compare them side by side.</div>
                  {placeNote(null)}
                </>
              )}
            </div>
          )}
        </>
      )}
      {!docked && <div className="sp-resize" onPointerDown={(e) => drag(e, 'size')} aria-hidden="true" />}
    </section>
  )
}
