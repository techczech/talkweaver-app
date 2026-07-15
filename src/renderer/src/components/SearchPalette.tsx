import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectionRow, TalkInfo } from '../../../preload/index'
import { selRowKey, rangeKeys, sectionKeysAt, isSingleTalk, groupBySection } from './searchPaletteSelection'

type SearchResult = ProjectionRow & {
  talkSlug: string
  talkTitle: string
  outlinePath: string
  talkMtimeMs?: number
  talkMeta?: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onInsert: (markdown: string, fromSlug: string, sourceOutlinePath: string) => void
  onInsertMany?: (items: { markdown: string; fromSlug: string; sourceOutlinePath: string }[]) => void
  currentTalkSlug: string
}

const DEFAULT_LAYOUT = 'default'
const DEBOUNCE_MS = 200
const ICON_LAYOUTS = new Set(['iconrow', 'iconlist'])
const DAY_MS = 86400000

function topicOf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts.length >= 2 ? parts[parts.length - 2] : '(root)'
}
function rowMarkdown(row: SearchResult): string {
  return row.source_markdown && row.source_markdown.trim() !== ''
    ? row.source_markdown
    : `### ${row.nav_title || row.title || 'Untitled'}\n`
}
function layoutOf(r: SearchResult): string { return (r.triggers?.layout || r.layout || '') as string }
function isIconSlide(r: SearchResult): boolean {
  return ICON_LAYOUTS.has(layoutOf(r)) || /\{icon[=}]/.test(r.source_markdown || '')
}
// A section divider (heading-is-slide model): keyed off `role` (the compiler's faithful proxy for
// isSection — subsection-title LAYOUT is no longer emitted for content-bearing dividers).
function isSectionRow(r: SearchResult): boolean {
  return r.role === 'section-title' || r.role === 'subsection-title'
}
function isTitleOnly(r: SearchResult): boolean {
  if (isSectionRow(r) || layoutOf(r) === 'title') return true
  return (r.image_count ?? 0) === 0 && (r.bullet_count ?? 0) === 0 && (r.word_count ?? 0) <= 4
}

// A searchable dropdown: type to filter, click to pick, (clear) to reset. The chosen value is a
// substring filter, so partial typing also narrows results directly.
function Combobox({ value, onChange, options, placeholder, width }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder: string; width?: number
}) {
  const [open, setOpen] = useState(false)
  const filtered = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(value.toLowerCase())).slice(0, 60),
    [options, value]
  )
  return (
    <div style={{ position: 'relative', flex: width ? `0 0 ${width}px` : '0 1 130px', minWidth: 70 }}>
      <input
        style={comboInput}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (filtered.length > 0 || value) && (
        <div style={comboDropdown}>
          {value && <div style={comboOpt} onMouseDown={() => { onChange(''); setOpen(false) }}>✕ clear</div>}
          {filtered.map((o) => (
            <div key={o} style={comboOpt} onMouseDown={() => { onChange(o); setOpen(false) }}>{o}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// Multi-select layout filter (this OR that): a button + a checkbox panel of layouts present.
function LayoutFilter({ options, selected, onToggle, onClear }: {
  options: string[]; selected: Set<string>; onToggle: (l: string) => void; onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <button style={comboInput} onClick={() => setOpen((o) => !o)}>
        {selected.size ? `Layouts (${selected.size})` : 'Any layout'} ▾
      </button>
      {open && (
        <div style={{ ...comboDropdown, padding: 6 }}>
          {selected.size > 0 && <div style={comboOpt} onMouseDown={onClear}>✕ clear layouts</div>}
          {options.map((l) => (
            <label key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(l)} onChange={() => onToggle(l)} /> {l}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SearchPalette({ isOpen, onClose, onInsert, onInsertMany, currentTalkSlug }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [unavailable, setUnavailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [talks, setTalks] = useState<TalkInfo[]>([])
  const [preview, setPreview] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Filters
  const [folderQ, setFolderQ] = useState('')
  const [talkQ, setTalkQ] = useState('')
  const [sectionQ, setSectionQ] = useState('')
  const [metaQ, setMetaQ] = useState('')
  const [layoutSet, setLayoutSet] = useState<Set<string>>(() => new Set())
  const [hasImage, setHasImage] = useState(false)
  const [hasIcons, setHasIcons] = useState(false)
  const [excludeSections, setExcludeSections] = useState(false)
  const [excludeTitleOnly, setExcludeTitleOnly] = useState(false)
  const [modifiedDays, setModifiedDays] = useState(0) // 0 = any

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const reqIdRef = useRef(0)
  const anchorRef = useRef<number>(0)

  useEffect(() => {
    if (!isOpen) return
    setQuery(''); setActiveIndex(0); setUnavailable(false); setPreview(false); setSelected(new Set()); anchorRef.current = 0
    setFolderQ(''); setTalkQ(''); setSectionQ(''); setMetaQ(''); setLayoutSet(new Set())
    setHasImage(false); setHasIcons(false); setExcludeSections(false); setExcludeTitleOnly(false); setModifiedDays(0)
    requestAnimationFrame(() => inputRef.current?.focus())
    window.tw.vault.listTalks().then((t) => setTalks(t || [])).catch(() => setTalks([]))
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const reqId = ++reqIdRef.current
    setLoading(true)
    const handle = setTimeout(async () => {
      const rows = await window.tw.search.allSlides(query)
      if (reqId !== reqIdRef.current) return
      setLoading(false)
      if (rows === null) { setUnavailable(true); setResults([]); return }
      setUnavailable(false); setResults(rows as SearchResult[]); setActiveIndex(0)
    }, DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query, isOpen])

  const folderBySlug = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of talks) m.set(t.slug, topicOf(t.path))
    return m
  }, [talks])

  // Distinct option lists for the comboboxes / layout filter (from the current result set).
  const folderOptions = useMemo(() => [...new Set(results.map((r) => folderBySlug.get(r.talkSlug) || '').filter(Boolean))].sort(), [results, folderBySlug])
  const talkOptions = useMemo(() => [...new Set(results.map((r) => r.talkTitle).filter(Boolean))].sort(), [results])
  const sectionOptions = useMemo(() => [...new Set(results.map((r) => r.section || '').filter(Boolean))].sort(), [results])
  const layoutOptions = useMemo(() => [...new Set(results.map(layoutOf).filter(Boolean))].sort(), [results])

  const shown = useMemo(() => {
    const f = folderQ.toLowerCase().trim(), tq = talkQ.toLowerCase().trim()
    const sq = sectionQ.toLowerCase().trim(), mq = metaQ.toLowerCase().trim()
    const cutoff = modifiedDays > 0 ? Date.now() - modifiedDays * DAY_MS : 0
    return results.filter((r) => {
      if (f && !((folderBySlug.get(r.talkSlug) || '').toLowerCase().includes(f))) return false
      if (tq && !(`${r.talkTitle} ${r.talkSlug}`.toLowerCase().includes(tq))) return false
      if (sq && !(`${r.section || ''} ${r.subsection || ''}`.toLowerCase().includes(sq))) return false
      if (mq && !((r.talkMeta || '').includes(mq))) return false
      if (layoutSet.size > 0 && !layoutSet.has(layoutOf(r))) return false
      if (hasImage && !((r.image_count ?? 0) > 0)) return false
      if (hasIcons && !isIconSlide(r)) return false
      if (excludeSections && isSectionRow(r)) return false
      if (excludeTitleOnly && isTitleOnly(r)) return false
      if (cutoff && !((r.talkMtimeMs ?? 0) >= cutoff)) return false
      return true
    })
  }, [results, folderQ, talkQ, sectionQ, metaQ, layoutSet, hasImage, hasIcons, excludeSections, excludeTitleOnly, modifiedDays, folderBySlug])

  useEffect(() => { if (activeIndex > shown.length - 1) setActiveIndex(Math.max(0, shown.length - 1)) }, [shown.length, activeIndex])
  useEffect(() => {
    listRef.current?.querySelector<HTMLLIElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, shown])

  function toggleLayout(l: string): void {
    setLayoutSet((prev) => { const n = new Set(prev); if (n.has(l)) n.delete(l); else n.add(l); return n })
  }
  function insertRows(rows: SearchResult[]): void {
    const items = rows.map((r) => ({ markdown: rowMarkdown(r), fromSlug: r.talkSlug, sourceOutlinePath: r.outlinePath }))
    if (items.length === 0) return
    if (items.length > 1 && onInsertMany) onInsertMany(items)
    else items.forEach((it) => onInsert(it.markdown, it.fromSlug, it.sourceOutlinePath))
    onClose()
  }
  // ⌘-Enter / "Insert N selected": the selected set in shown-order, else the active slide.
  function doInsert(): void {
    const chosen = shown.filter((r, i) => selected.has(selRowKey(shown, i)))
    insertRows(chosen.length > 0 ? chosen : (shown[activeIndex] ? [shown[activeIndex]] : []))
  }
  function toggleAt(idx: number): void {
    const k = selRowKey(shown, idx)
    setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
    anchorRef.current = idx
  }
  function extendTo(idx: number): void {
    const keys = rangeKeys(shown, anchorRef.current, idx)
    setSelected((prev) => { const n = new Set(prev); for (const k of keys) n.add(k); return n })
  }
  function selectActiveSection(): void {
    const keys = sectionKeysAt(shown, activeIndex)
    setSelected((prev) => { const n = new Set(prev); for (const k of keys) n.add(k); return n })
    anchorRef.current = activeIndex
  }
  // Toggle-select every shown slide in a section (clicking a section header). If all are already
  // selected, deselect them; else select them all.
  function toggleSectionIndices(indices: number[]): void {
    const keys = indices.map((i) => selRowKey(shown, i))
    setSelected((prev) => {
      const n = new Set(prev)
      const allSel = keys.every((k) => n.has(k))
      for (const k of keys) { if (allSel) n.delete(k); else n.add(k) }
      return n
    })
  }

  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent): void {
      const el = document.activeElement
      const inField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (preview) setPreview(false); else onClose(); return }
      if (mod && e.key === 'Enter') { e.preventDefault(); doInsert(); return }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); setPreview((p) => !p); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Let ← → move the caret while typing in the search box; only ↑↓ pull focus into the grid.
        if (inField && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
        e.preventDefault(); inputRef.current?.blur()
        const delta = e.key === 'ArrowDown' ? 2 : e.key === 'ArrowUp' ? -2 : e.key === 'ArrowRight' ? 1 : -1
        setActiveIndex((i) => {
          const next = Math.max(0, Math.min(i + delta, shown.length - 1))
          if (e.shiftKey) extendTo(next)
          else anchorRef.current = next
          return next
        })
        return
      }
      if (inField) return // remaining shortcuts are grid-only (don't hijack typing)
      if (e.key === ' ') { e.preventDefault(); toggleAt(activeIndex); return }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setPreview((p) => !p); return }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); selectActiveSection(); return }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, shown, activeIndex, onClose, preview, selected])

  if (!isOpen) return null
  const activeRow = shown[activeIndex]

  return (
    <>
      <div className="search-palette-backdrop" />
      <div className="search-palette" role="dialog" aria-modal="true" aria-label="Search slides across all talks">
        <input
          ref={inputRef} autoFocus className="search-palette-input" type="text" value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search slides — all words, across titles + content…" aria-label="Search query"
        />

        {/* Row 1: searchable folder / talk / section + layouts + metadata. */}
        <div className="search-palette-filters">
          <Combobox value={folderQ} onChange={setFolderQ} options={folderOptions} placeholder="Folder…" />
          <Combobox value={talkQ} onChange={setTalkQ} options={talkOptions} placeholder="Talk…" />
          <Combobox value={sectionQ} onChange={setSectionQ} options={sectionOptions} placeholder="Section…" />
          <LayoutFilter options={layoutOptions} selected={layoutSet} onToggle={toggleLayout} onClear={() => setLayoutSet(new Set())} />
          <Combobox value={metaQ} onChange={setMetaQ} options={[]} placeholder="Metadata…" width={130} />
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>{shown.length} / {results.length}</span>
        </div>

        {/* Row 2: quick toggles + date. */}
        <div className="search-palette-filters" style={{ paddingTop: 0 }}>
          <label style={toggle}><input type="checkbox" checked={hasImage} onChange={(e) => setHasImage(e.target.checked)} /> image</label>
          <label style={toggle}><input type="checkbox" checked={hasIcons} onChange={(e) => setHasIcons(e.target.checked)} /> icons</label>
          <label style={toggle}><input type="checkbox" checked={excludeSections} onChange={(e) => setExcludeSections(e.target.checked)} /> no sections</label>
          <label style={toggle}><input type="checkbox" checked={excludeTitleOnly} onChange={(e) => setExcludeTitleOnly(e.target.checked)} /> content only</label>
          <select style={comboInput} value={modifiedDays} onChange={(e) => setModifiedDays(Number(e.target.value))} aria-label="Filter by modified date">
            <option value={0}>Any time</option>
            <option value={1}>Today</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>

        <ul ref={listRef} className="search-palette-results" role="listbox" aria-label="Slide results">
          {(() => {
            function renderCell(row: SearchResult, idx: number): React.ReactElement {
              const isActive = idx === activeIndex
              const key = selRowKey(shown, idx)
              const isSel = selected.has(key)
              const slideNum = row.order ?? idx + 1
              const breadcrumb = row.section ? row.section + (row.subsection ? ` › ${row.subsection}` : '') : ''
              const meta = (row.talkSlug === currentTalkSlug ? 'this talk' : row.talkTitle) + (breadcrumb ? ` · ${breadcrumb}` : '')
              const layout = layoutOf(row)
              const isNonDefaultLayout = layout && layout !== DEFAULT_LAYOUT && layout !== ''
              return (
                <li
                  key={key}
                  className={`search-result-item${isActive ? ' search-result-item--active' : ''}${isSel ? ' search-result-item--selected' : ''}`}
                  role="option" aria-selected={isActive} data-active={isActive ? 'true' : 'false'} data-selected={isSel ? 'true' : 'false'}
                  onClick={(e) => { if (e.shiftKey) { setActiveIndex(idx); extendTo(idx) } else toggleAt(idx); }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  title="Click selects · Shift+click range · Space select · ⌘↵ insert · P/⌘Y preview"
                >
                  <div className="search-result-thumb">
                    <input type="checkbox" className="search-result-check" checked={isSel} onClick={(e) => e.stopPropagation()} onChange={() => toggleAt(idx)} aria-label="Select slide" />
                    {row.content_hash && (
                      <img src={`twthumb://${row.talkSlug}/${row.render_hash || row.content_hash}`} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                    )}
                    {isNonDefaultLayout && <span className="search-result-layout">{layout}</span>}
                  </div>
                  <div className="search-result-foot">
                    <span className="search-result-num">{slideNum}</span>
                    <span className="search-result-title">{row.nav_title || row.title || '(untitled)'}</span>
                    <span className="search-result-meta" title={meta}>{meta}</span>
                  </div>
                </li>
              )
            }
            if (unavailable) return <li style={emptyStyle}>Search unavailable (compiler missing)</li>
            if (shown.length === 0) return <li style={emptyStyle}>{loading ? 'Searching…' : 'No slides match the search + filters'}</li>
            if (isSingleTalk(shown)) {
              return groupBySection(shown).flatMap((g, gi) => {
                const allSel = g.indices.every((i) => selected.has(selRowKey(shown, i)))
                const header = (
                  <li key={`sec:${gi}:${g.section}`} className="search-result-section-head" style={{ gridColumn: '1 / -1' }}>
                    <button style={sectionHeadBtn} onClick={() => toggleSectionIndices(g.indices)} title="Select / deselect this whole section">
                      {allSel ? '☑' : '☐'} {g.section || '(no section)'} <span style={{ color: 'var(--faint)' }}>· {g.indices.length}</span>
                    </button>
                  </li>
                )
                return [header, ...g.indices.map((i) => renderCell(shown[i], i))]
              })
            }
            return shown.map((row, idx) => renderCell(row, idx))
          })()}
        </ul>

        <div className="search-palette-footer">
          {selected.size > 0 ? (
            <>
              <button style={insertBtn} onClick={doInsert}>Insert {selected.size} selected (⌘↵)</button>
              <button style={clearBtn} onClick={() => setSelected(new Set())}>Clear</button>
              <span style={{ marginLeft: 'auto' }}><kbd style={kbdStyle}>⌘↵</kbd> insert selected</span>
            </>
          ) : (
            <>
              <span><kbd style={kbdStyle}>↑↓←→</kbd> navigate</span>
              <span><kbd style={kbdStyle}>Space</kbd> select</span>
              <span><kbd style={kbdStyle}>⇧↑↓←→</kbd> range</span>
              <span><kbd style={kbdStyle}>S</kbd> section</span>
              <span><kbd style={kbdStyle}>P</kbd>/<kbd style={kbdStyle}>⌘Y</kbd> preview</span>
              <span style={{ marginLeft: 'auto' }}><kbd style={kbdStyle}>⌘↵</kbd> insert · <kbd style={kbdStyle}>Esc</kbd> close</span>
            </>
          )}
        </div>
      </div>

      {preview && activeRow && activeRow.content_hash && (
        <div className="preview-lightbox" onClick={() => setPreview(false)} role="dialog" aria-label="Slide preview">
          <img src={`twthumb://${activeRow.talkSlug}/${activeRow.render_hash || activeRow.content_hash}`} alt={activeRow.nav_title || activeRow.title || ''} />
          <div className="preview-lightbox-cap">{activeRow.nav_title || activeRow.title} — {activeRow.talkTitle}</div>
        </div>
      )}
    </>
  )
}

const emptyStyle: React.CSSProperties = { gridColumn: '1 / -1', padding: '20px 16px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }
const kbdStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 3, padding: '2px 5px', color: 'var(--ink)', display: 'inline-block', margin: '0 1px' }
const comboInput: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--hover)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 7px', fontSize: 12, color: 'var(--ink)', cursor: 'pointer' }
const comboDropdown: React.CSSProperties = { position: 'absolute', top: 'calc(100% + 2px)', left: 0, minWidth: '100%', maxHeight: 220, overflowY: 'auto', zIndex: 50, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, boxShadow: '0 8px 24px #17202a2e' }
const comboOpt: React.CSSProperties = { padding: '5px 9px', fontSize: 12, color: 'var(--ink)', cursor: 'pointer', whiteSpace: 'nowrap' }
const toggle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }
const insertBtn: React.CSSProperties = { fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid var(--oxford)', background: 'var(--oxford)', color: '#fff', cursor: 'pointer' }
const clearBtn: React.CSSProperties = { fontSize: 12, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }
const sectionHeadBtn: React.CSSProperties = { background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--ink)', font: '700 12px/1.2 var(--font-ui)', padding: '4px 6px', borderRadius: 4 }
