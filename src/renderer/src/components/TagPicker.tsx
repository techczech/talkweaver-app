// Tag picker (ADR-0037 / ADR-0009 design lock — docs/design/2026-07-11-v015-tags-metadata/
// direction-a-rail.html, carried over unchanged). Tray-anchored on `t` in the Slide Browser;
// the same surface serves "Tag current slide…" anchored near the toolbar. Behaviour is the
// locked mockup's exactly: type-to-filter the vault vocabulary (with counts), toggle existing
// tags on/off, a mixed state with an honest "on 2 of 3" when only part of the selection carries
// a tag (toggling COMPLETES the set first, never silently strips), a create row with the
// lowercase-kebab hint, merge-not-replace stated at the point of write, ↑↓ ↵ ⎋.
//
// The picker owns NO writes: every toggle/create is delegated up as onToggle(tag, 'add'|'remove')
// — the host runs tags:apply (flush → write → adopt) and updates `tagLists`, so the checkbox
// states always reflect what the host believes is on disk.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Minus, Plus, Search, Tag } from 'lucide-react'
import type { TagCount } from '../../../preload/index'
import { normalizeTag } from '../../../shared/tags'

interface Props {
  isOpen: boolean
  /** How many slides the write targets — the header's "Tag N slides". */
  count: number
  /** Current tags per targeted slide (drives on/mixed/off states). */
  tagLists: string[][]
  /** Apply one tag across the whole selection. 'add' completes the set; 'remove' strips it. */
  onToggle: (tag: string, action: 'add' | 'remove') => void
  onClose: () => void
  /** 'tray' = anchored above the Slide Browser's selection tray (absolute, bottom-centre);
   *  'toolbar' = anchored under the workspace toolbar (fixed, top-centre). */
  anchor: 'tray' | 'toolbar'
  /** True while a tags:apply is in flight — rows stay visible but inert. */
  busy?: boolean
}

type PickerRow =
  | { kind: 'tag'; name: string; count: number; state: 'on' | 'off' | 'mixed'; withTag: number }
  | { kind: 'create'; name: string }

export default function TagPicker({ isOpen, count, tagLists, onToggle, onClose, anchor, busy }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // null = vocabulary still loading (the list shows nothing yet, no flicker for tiny vaults).
  const [vocab, setVocab] = useState<TagCount[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setActive(0)
    setVocab(null)
    window.tw.tags.vocabulary().then((v) => setVocab(v ?? [])).catch(() => setVocab([]))
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [isOpen])

  // The vault vocabulary plus any tag the selection already carries that the index has not
  // ripened yet (a just-created tag must not vanish from the list before the re-index lands).
  const names = useMemo(() => {
    const out: TagCount[] = vocab ? [...vocab] : []
    const known = new Set(out.map((t) => t.name))
    for (const tags of tagLists) {
      for (const t of tags) {
        if (!known.has(t)) { known.add(t); out.push({ name: t, count: 0 }) }
      }
    }
    return out
  }, [vocab, tagLists])

  const rows = useMemo<PickerRow[]>(() => {
    const q = query.trim().toLowerCase()
    const out: PickerRow[] = names
      .filter((t) => q === '' || t.name.includes(q))
      .map((t) => {
        const withTag = tagLists.filter((tags) => tags.includes(t.name)).length
        const state = withTag === 0 ? ('off' as const) : withTag === tagLists.length ? ('on' as const) : ('mixed' as const)
        // A count of 0 (not yet indexed) shows the selection's own share so it never reads as unused.
        return { kind: 'tag' as const, name: t.name, count: Math.max(t.count, withTag), state, withTag }
      })
    const kebab = normalizeTag(query)
    if (kebab !== '' && !names.some((t) => t.name === kebab)) out.push({ kind: 'create', name: kebab })
    return out
  }, [names, query, tagLists])

  useEffect(() => {
    if (active > rows.length - 1) setActive(Math.max(0, rows.length - 1))
  }, [rows.length, active])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, rows])

  function runRow(row: PickerRow | undefined): void {
    if (!row || busy) return
    if (row.kind === 'create') {
      onToggle(row.name, 'add')
      setQuery('')
      setActive(0)
      return
    }
    // Merge-not-replace: mixed → complete the set; on → remove from all; off → add to all.
    onToggle(row.name, row.state === 'on' ? 'remove' : 'add')
  }

  // One capture-level handler owns the picker's keys wherever focus sits (input or a clicked
  // row button); everything it does not claim falls through to the input for typing. The host
  // overlay (Slide Browser) suspends its own keys while the picker is open, so nothing races.
  useEffect(() => {
    if (!isOpen) return
    function handle(e: KeyboardEvent): void {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.min(rows.length - 1, a + 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((a) => Math.max(0, a - 1)); return }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runRow(rows[active]); return }
    }
    window.addEventListener('keydown', handle, { capture: true })
    return () => window.removeEventListener('keydown', handle, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, rows, active, busy])

  if (!isOpen) return null

  return (
    <div
      className={`lt-tagpicker anchor-${anchor}${busy ? ' busy' : ''}`}
      role="dialog"
      aria-label="Tag slides"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tp-head">
        <Tag className="lt-icon tp-ic" />
        <span className="tp-title">Tag {count} slide{count === 1 ? '' : 's'}</span>
        <span className="tp-note">writes to {'{id=… tags=…}'}</span>
      </div>
      <div className="tp-input">
        <Search className="lt-icon" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Filter tags, or type a new one…"
          autoComplete="off"
          aria-label="Filter or create tags"
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
        />
      </div>
      <div className="tp-list" ref={listRef}>
        {rows.length === 0 && (
          <div className="tp-empty">{vocab === null ? 'Reading the vault’s tags…' : 'No tags yet — type to create one.'}</div>
        )}
        {rows.map((row, i) =>
          row.kind === 'create' ? (
            <button
              key="create"
              type="button"
              data-row={i}
              className={`tp-row create${i === active ? ' active' : ''}`}
              disabled={busy}
              onClick={() => runRow(row)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="tp-box"><Plus className="lt-icon" /></span>
              <span className="tp-name create">create “{row.name}” and tag the selection</span>
            </button>
          ) : (
            <button
              key={row.name}
              type="button"
              data-row={i}
              className={`tp-row ${row.state}${i === active ? ' active' : ''}`}
              disabled={busy}
              title={row.state === 'on' ? 'Remove from all selected slides' : 'Add to all selected slides'}
              onClick={() => runRow(row)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="tp-box">
                {row.state === 'on' && <Check className="lt-icon" />}
                {row.state === 'mixed' && <Minus className="lt-icon" />}
              </span>
              <span className="tp-name">{row.name}</span>
              {row.state === 'mixed' && <span className="tp-state">on {row.withTag} of {tagLists.length}</span>}
              <span className="tp-count">{row.count}</span>
            </button>
          )
        )}
      </div>
      <div className="tp-foot">
        <span className="tp-hint">Tags <b>merge</b> with what each slide already carries — nothing is replaced.</span>
        <span className="tp-keys"><kbd>↑↓</kbd> <kbd>↵</kbd> toggle <kbd>⎋</kbd></span>
      </div>
    </div>
  )
}
