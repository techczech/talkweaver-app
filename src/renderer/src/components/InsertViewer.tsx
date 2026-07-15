// The INSERT-DECISION VIEWER (v0.15.x live-test decision): ↵ on any Browser slide opens
// this — never the editor, never a talk switch. A self-contained overlay layer INSIDE the
// Slide Browser: the slide rendered large, the source talk's whole deck as a filmstrip in
// outline order (full context — ←/→ walks it), and a metadata rail to decide with. The only
// actions are Insert-at-caret and Esc-back-to-the-Browser; there is deliberately NO edit
// affordance and NO "open in its talk" (the Talks panel is where talks are opened).
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, GitBranch, X } from 'lucide-react'
import type { SearchResult } from './SlideBrowser'
import { stampedIdOf } from './slideBrowserModel'
import { tagsOfBlock } from '../../../shared/tags'

interface Props {
  /** The source talk's slides in OUTLINE ORDER (from the search index — no compile needed). */
  deck: SearchResult[]
  initialIndex: number
  talkTitle: string
  /** Authored section name for a row (slug fallback). */
  sectionLabel: (r: SearchResult) => string
  /** e.g. "4d ago" from talkMeta.editedMs; null when unknown. */
  editedLabel: string | null
  /** Version/where-used counts for a stamped id — the Browser's cached fetch. */
  fetchCounts: (id: string) => Promise<{ versions: number; talks: number } | null>
  /** Insert these rows at the caret via the Browser's existing insert flow. */
  onInsert: (rows: SearchResult[]) => void
  /** Esc — back to the Browser exactly where it was. */
  onClose: () => void
  /** Progressive-thumbnail hooks (the Browser's per-talk regen chain). */
  regenNonce: number
  regenerating: boolean
  onThumbUnavailable: (row: SearchResult) => void
  /** True while the cheat-sheet or another overlay sits above the viewer. */
  suspendKeys?: boolean
}

function rowTitle(r: SearchResult): string {
  return r.nav_title || r.title || '(untitled)'
}

// A twthumb print with shimmer → schematic-title fallback (Browser Thumb pattern, resized
// by the wrapping class). Keyed by src + regen nonce at the call site.
function Print({ row, big, regenerating, onUnavailable }: {
  row: SearchResult
  big?: boolean
  regenerating: boolean
  onUnavailable: (row: SearchResult) => void
}) {
  const hasHash = Boolean(row.content_hash)
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>(hasHash ? 'loading' : 'failed')
  return (
    <div className={`lt-iv-print${big ? ' big' : ''}`}>
      {hasHash && state !== 'failed' && (
        <img
          src={`twthumb://${row.talkSlug}/${row.render_hash || row.content_hash}`}
          alt={rowTitle(row)}
          loading={big ? 'eager' : 'lazy'}
          decoding="async"
          onLoad={() => setState('ok')}
          onError={() => { setState('failed'); onUnavailable(row) }}
        />
      )}
      {state === 'loading' && <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>}
      {state === 'failed' && (hasHash && regenerating
        ? <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>
        : <div className="lt-iv-fallback">{rowTitle(row)}</div>)}
    </div>
  )
}

export default function InsertViewer({
  deck, initialIndex, talkTitle, sectionLabel, editedLabel, fetchCounts,
  onInsert, onClose, regenNonce, regenerating, onThumbUnavailable, suspendKeys
}: Props) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(initialIndex, deck.length - 1)))
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [counts, setCounts] = useState<{ versions: number; talks: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const viewed = deck[index]
  const viewedId = viewed ? stampedIdOf(viewed.source_markdown) : null
  const tags = useMemo(
    () => (viewed ? (viewed.tags ?? tagsOfBlock(viewed.source_markdown)) : []),
    [viewed]
  )

  // Take keyboard focus on open so Tab starts inside the viewer (the Browser's search field
  // would otherwise keep it behind the overlay).
  useEffect(() => {
    requestAnimationFrame(() => rootRef.current?.focus())
  }, [])

  // Centre the viewed cell as ←/→ walk the deck.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-cell="${index}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [index])

  // Version / where-used state for the viewed slide (cached in the Browser — one IPC per id).
  useEffect(() => {
    setCounts(null)
    if (!viewedId) return
    let live = true
    fetchCounts(viewedId).then((c) => { if (live) setCounts(c) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedId])

  function toggleSelect(i: number): void {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })
  }
  // ⌘↵ ONLY (accidental-insertion guard — Dominik's correction): the selected filmstrip
  // slides in outline order, or the viewed slide if none are selected.
  function insertNow(): void {
    const rows = selected.size > 0
      ? [...selected].sort((a, b) => a - b).map((i) => deck[i]).filter(Boolean)
      : viewed ? [viewed] : []
    if (rows.length > 0) onInsert(rows)
  }

  // The viewer owns EVERY key while open (the Browser's handler stands down): Esc back,
  // ←/→ walk, Space/X/↵ select the viewed slide, ⌘↵ ONLY inserts (plain ↵ deliberately
  // never inserts — the accidental-insertion guard), Tab trapped inside.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (suspendKeys) return
      const el = document.activeElement
      const onButton = el instanceof HTMLButtonElement
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = [...rootRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
          .filter((f) => f.offsetParent !== null)
        if (focusables.length > 0) {
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && (el === first || !rootRef.current.contains(el))) { e.preventDefault(); e.stopPropagation(); last.focus() }
          else if (!e.shiftKey && (el === last || !rootRef.current.contains(el))) { e.preventDefault(); e.stopPropagation(); first.focus() }
        }
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); e.stopPropagation()
        setIndex((i) => Math.max(0, Math.min(deck.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1))))
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); e.stopPropagation(); insertNow(); return
      }
      // Plain ↵ NEVER inserts (accidental-insertion guard). Judgement call: it toggles
      // selection of the centred slide instead — same gesture as Space/X, so walking the
      // deck with arrows and marking keepers needs one hand.
      if ((e.key === 'Enter' || e.key === ' ' || e.key === 'x' || e.key === 'X') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if ((e.key === ' ' || e.key === 'Enter') && onButton) return // a Tab-focused button keeps its own activation
        e.preventDefault(); e.stopPropagation(); toggleSelect(index); return
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspendKeys, index, selected, deck, onClose])

  if (!viewed) return null
  const insertCount = selected.size > 0 ? selected.size : 1

  return (
    <div ref={rootRef} className="lt-viewer" role="dialog" aria-modal="true" aria-label="Insert from talk" tabIndex={-1}>
      <header className="lt-iv-top">
        <span className="lt-iv-room">Insert from</span>
        <span className="lt-iv-talk" title={talkTitle}>{talkTitle}</span>
        <span className="lt-iv-pos">{index + 1} / {deck.length}</span>
        <span className="lt-iv-spacer" />
        <button type="button" className="lt-btn" onClick={onClose} title="Back to the Browser (Esc)">
          <X className="lt-icon" /> Back to Browser <kbd>Esc</kbd>
        </button>
      </header>

      <div className="lt-iv-body">
        <div className="lt-iv-main">
          <div className="lt-iv-stage">
            <Print
              key={`stage:${viewed.talkSlug}/${viewed.render_hash || viewed.content_hash}:${regenNonce}`}
              row={viewed}
              big
              regenerating={regenerating}
              onUnavailable={onThumbUnavailable}
            />
          </div>
          {/* The source deck in outline order — full context around the slide you came for.
              Click/Space SELECTS (multi — the neighbours often belong too); ←/→ views. */}
          <div className="lt-iv-strip" ref={stripRef} aria-label="Source talk filmstrip">
            {deck.map((r, i) => (
              <button
                key={`${r.slide_id}@${i}`}
                type="button"
                data-cell={i}
                className={`lt-iv-cell${i === index ? ' viewed' : ''}${selected.has(i) ? ' picked' : ''}`}
                title="Click selects for insert · ←/→ views"
                onClick={() => toggleSelect(i)}
              >
                <span className="lt-iv-ord">{String(i + 1).padStart(2, '0')}</span>
                {selected.has(i) && <span className="lt-iv-pick"><Check className="lt-icon" /></span>}
                <Print
                  key={`${r.talkSlug}/${r.render_hash || r.content_hash}:${regenNonce}`}
                  row={r}
                  regenerating={regenerating}
                  onUnavailable={onThumbUnavailable}
                />
              </button>
            ))}
          </div>
        </div>

        {/* The decision rail — metadata, never editing. */}
        <aside className="lt-iv-rail" aria-label="Slide details">
          <h3 className="lt-iv-title">{rowTitle(viewed)}</h3>
          <dl className="lt-iv-meta">
            <dt>Talk</dt>
            <dd className="serif">{talkTitle}</dd>
            <dt>Section</dt>
            <dd>{sectionLabel(viewed) || '—'}</dd>
            <dt>Tags</dt>
            <dd>
              {tags.length > 0
                ? tags.map((t) => <span key={t} className="lt-minitag">{t}</span>)
                : <span className="lt-iv-dim">untagged</span>}
            </dd>
            <dt>Slide id</dt>
            <dd>
              {viewedId
                ? <code className="lt-iv-id">{viewedId}</code>
                : <span className="lt-iv-dim">unstamped — id assigned on save</span>}
            </dd>
            {viewedId && (
              <>
                <dt>Versions</dt>
                <dd>
                  <GitBranch className="lt-icon lt-iv-ic" />
                  {counts === null
                    ? '…'
                    : counts.versions === 0
                      ? 'no versions yet'
                      : `${counts.versions} version${counts.versions === 1 ? '' : 's'} · used in ${counts.talks} talk${counts.talks === 1 ? '' : 's'}`}
                </dd>
              </>
            )}
            <dt>Last edited</dt>
            <dd>{editedLabel ?? '—'}</dd>
          </dl>
          <div className="lt-iv-actions">
            <button type="button" className="lt-btn primary" onClick={insertNow}>
              <ArrowDown className="lt-icon" />
              Insert {selected.size > 0 ? `${insertCount} selected` : 'this slide'} at caret <kbd>⌘↵</kbd>
            </button>
            {selected.size > 0 && (
              <button type="button" className="lt-btn" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            )}
          </div>
          <p className="lt-iv-note">
            Inserting places a copy at your caret in the current talk. Nothing here edits the
            source — talks are opened from the Talks panel.
          </p>
        </aside>
      </div>

      <footer className="lt-iv-hints">
        <span className="lt-h"><kbd>←</kbd><kbd>→</kbd> <b>walk the deck</b></span>
        <span className="lt-h"><kbd>↵</kbd> / <kbd>Space</kbd> / click <b>select</b></span>
        <span className="lt-h"><kbd>X</kbd> <b>select</b></span>
        <span className="lt-h"><kbd>⌘↵</kbd> <b>insert at caret</b></span>
        <span className="lt-h lt-push"><kbd>Esc</kbd> <b>back to Browser</b></span>
      </footer>
    </div>
  )
}
