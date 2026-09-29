import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ENDED_LABEL, feedbackRailView, PAUSED_LABEL,
  type FeedbackFilter, type FeedbackList, type RailAction, type RailRow, type RailSlide,
} from '../../../shared/feedback'

// Feedback rail (ticket 05): docs/design/2026-09-28-shared-talk/LOCKED-feedback-rail-and-markers.html
// frames 1 and 3. It takes the Inspector's slot beside the outline. Items are text separated by
// hairlines, newest first: kind, who, when, slide, then the note, a two-line diff, her reason for a
// deletion, or a preview of a proposed new slide with where it goes. Everything shown comes from
// the talk's feedback file (via main); nothing here talks to the Worker.
//
// Ticket 06 (frame 2): Accept, and for an item whose slide changed since she wrote it, Compare —
// yours now (lines changed since highlighted), hers, and the slide as she saw it — with Keep mine,
// Use hers and Open slide to merge. Accepted items keep Undo. Opened from a slide's marker, the rail
// shows that slide's items with Compare expanded; from a ghost row, it scrolls to that item.

/** Where the rail was opened: a slide's marker (filter to it) or a ghost row (that item). */
export interface FeedbackFocus { slideId?: string | null; itemId?: string | null; nonce: number }

interface Props {
  list: FeedbackList | null
  slides: RailSlide[]
  outline: string
  activeSlideId: string | null
  error: string | null
  focus: FeedbackFocus | null
  /** The item an Accept / Undo is running for (its buttons wait). */
  busy: string | null
  onSetStatus: (itemId: string, status: 'done' | 'dismissed') => void
  onAccept: (itemId: string) => void
  onUndo: (itemId: string) => void
  onOpenSlide: (slideId: string) => void
  onClose: () => void
}

interface RowProps {
  row: RailRow
  busy: boolean
  expanded: boolean
  highlighted: boolean
  onToggleCompare: () => void
  onAct: (id: RailAction['id']) => void
  onOpenSlide: () => void
}

function Compare({ row, busy, onAct, onOpenSlide }: { row: RailRow; busy: boolean; onAct: RowProps['onAct']; onOpenSlide: () => void }) {
  const c = row.compare!
  return (
    <div className="fr-compare" data-testid="feedback-compare">
      <div className="fr-cmp-l">{c.yoursLabel}</div>
      <div className="fr-cmp-box" data-testid="feedback-compare-yours">
        {c.yours.map((line, i) => (
          <div key={i} className={line.changed ? 'fr-cmp-chg' : undefined}>{line.text || '\u00a0'}</div>
        ))}
      </div>
      {c.hers && (
        <>
          <div className="fr-cmp-l">{c.hersLabel}</div>
          <div className="fr-cmp-box" data-testid="feedback-compare-hers">
            {c.hers.map((line, i) => <div key={i}>{line || '\u00a0'}</div>)}
          </div>
        </>
      )}
      <details className="fr-cmp-base">
        <summary>{c.baseLabel}</summary>
        {c.base
          ? <div className="fr-cmp-box" data-testid="feedback-compare-base">{c.base.map((line, i) => <div key={i}>{line || '\u00a0'}</div>)}</div>
          : <div className="fr-cmp-none">Not kept on this Mac.</div>}
      </details>
      <div className="fr-cmp-note">{c.useHersNote}</div>
      <div className="fr-acts">
        <button type="button" className="fr-btn" disabled={busy} data-testid="feedback-keep-mine" onClick={() => onAct('dismiss')}>Keep mine</button>
        <button type="button" className="fr-btn fr-btn--primary" disabled={busy} data-testid="feedback-use-hers" onClick={() => onAct('accept')}>Use hers</button>
        {row.slideId && <button type="button" className="fr-btn fr-btn--quiet" data-testid="feedback-open-slide" onClick={onOpenSlide}>Open slide to merge</button>}
      </div>
    </div>
  )
}

function Row({ row, busy, expanded, highlighted, onToggleCompare, onAct, onOpenSlide }: RowProps) {
  const actions = row.actions.filter((action) => action.id !== 'undo')
  return (
    <div
      className={`fr-item${row.handled ? ' is-handled' : ''}${highlighted ? ' is-focused' : ''}`}
      data-testid="feedback-item" data-kind={row.kind} data-item-id={row.itemId} data-handled={row.handled ? 'true' : 'false'}
      data-flagged={row.flag ? 'true' : undefined}
    >
      <div className="fr-who">
        {row.isNew && <span className="fr-new-dot" aria-label="New" />}
        <span className={`fr-kind${row.kindClass ? ` fr-kind--${row.kindClass}` : ''}`} data-testid="feedback-kind">{row.kindLabel}</span>
        <span>{row.who}</span>
        <span className="fr-when">{row.when}</span>
      </div>
      {row.slideRef && (
        <div className="fr-slideref"><b>{row.slideRef.number}</b>{row.slideRef.title}</div>
      )}
      {row.insertRef && (
        <div className="fr-slideref">
          {row.insertRef.after ? <>after slide <b>{row.insertRef.after}</b></> : 'at the start'}
          {row.insertRef.section && <> · <span className="fr-ins-sec">new section: {row.insertRef.section}</span></>}
        </div>
      )}
      {row.text != null && <div className="fr-text">{row.text}</div>}
      {row.reason && <div className="fr-text"><i>Reason:</i> {row.reason}</div>}
      {row.diff && (
        <div className="fr-diff" data-testid="feedback-diff">
          {row.diff.lines.map((line, i) => (
            <div key={i} className={line.op === 'del' ? 'fr-d' : 'fr-a'}>{line.op === 'del' ? <span>{line.text}</span> : line.text}</div>
          ))}
          {row.diff.more > 0 && <div className="fr-more">{row.diff.more} more changed line{row.diff.more === 1 ? '' : 's'}</div>}
        </div>
      )}
      {row.preview && (
        <div className="fr-preview" data-testid="feedback-preview">
          <div className="fr-slide">
            <div className="fr-slide-in">
              {row.preview.kicker && <div className="fr-slide-k">{row.preview.kicker}</div>}
              <h2>{row.preview.title}</h2>
              {row.preview.paras.map((p, i) => <p key={`p${i}`}>{p}</p>)}
              {row.preview.bullets.length > 0 && <ul>{row.preview.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>}
            </div>
          </div>
        </div>
      )}
      {row.hint && <div className="fr-hint">{row.hint}</div>}
      {row.flag && <div className="fr-flag" data-testid="feedback-flag">{row.flag}</div>}
      {row.compare && expanded && <Compare row={row} busy={busy} onAct={onAct} onOpenSlide={onOpenSlide} />}
      {actions.length > 0 && !(row.compare && expanded) && (
        <div className="fr-acts">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`fr-btn${action.tone === 'quiet' ? ' fr-btn--quiet' : ''}`}
              aria-disabled={action.disabled || busy || undefined}
              aria-expanded={action.id === 'compare' ? expanded : undefined}
              title={action.title}
              data-testid={`feedback-${action.id}`}
              onClick={() => {
                if (action.disabled || busy) return
                if (action.id === 'compare') onToggleCompare()
                else onAct(action.id)
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {row.stamp && (
        <div className={`fr-stamp fr-stamp--${row.stamp.tone}`} data-testid="feedback-stamp">
          <span data-testid="feedback-stamp-text">{row.stamp.text}</span>
          {row.undo && (
            <button type="button" className="fr-undo" disabled={busy} data-testid="feedback-undo" onClick={() => onAct('undo')}>Undo</button>
          )}
        </div>
      )}
    </div>
  )
}

export default function FeedbackRail({ list, slides, outline, activeSlideId, error, focus, busy, onSetStatus, onAccept, onUndo, onOpenSlide, onClose }: Props) {
  // Opened from a marker, the first render is already on that slide (no frame on "All slides").
  const [filter, setFilter] = useState<FeedbackFilter>(() => (focus?.slideId ? 'slide' : 'all'))
  const [fromMarker, setFromMarker] = useState(() => Boolean(focus?.slideId))
  // The marker's slide: the scope shows it at once, whatever the editor's active slide is doing.
  const [scopeSlideId, setScopeSlideId] = useState<string | null>(() => focus?.slideId ?? null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [highlight, setHighlight] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const body = useRef<HTMLDivElement | null>(null)
  // Times read "08:14 today" / "Sun 23:47": keep them true across midnight and as items arrive.
  useEffect(() => { setNow(Date.now()) }, [list])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const view = useMemo(
    () => feedbackRailView({ list, slides, outline, filter, activeSlideId, now, fromMarker, scopeSlideId }),
    [list, slides, outline, filter, activeSlideId, now, fromMarker, scopeSlideId],
  )
  // Opened from a marker: that slide's items, Compare expanded on the flagged ones (frame 2). From a
  // ghost row: every item, scrolled to that one.
  const focusNonce = focus?.nonce ?? 0
  useEffect(() => {
    if (!focus) return
    if (focus.itemId) {
      setFilter('all'); setFromMarker(false); setScopeSlideId(null); setHighlight(focus.itemId)
    } else if (focus.slideId) {
      setFilter('slide'); setFromMarker(true); setScopeSlideId(focus.slideId); setHighlight(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce])
  useEffect(() => {
    if (!focus) return
    if (focus.slideId && fromMarker) {
      const flagged = view.rows.filter((row) => row.compare && row.slideId === focus.slideId).map((row) => row.itemId)
      if (flagged.length) setExpanded((prev) => new Set([...prev, ...flagged]))
    }
    if (focus.itemId) {
      const el = body.current?.querySelector(`[data-item-id="${CSS.escape(focus.itemId)}"]`)
      el?.scrollIntoView({ block: 'center' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce, fromMarker, view.rows.length])
  const toggle = (itemId: string): void => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId)
    return next
  })
  const act = (row: RailRow, id: RailAction['id']): void => {
    if (id === 'accept') onAccept(row.itemId)
    else if (id === 'undo') onUndo(row.itemId)
    else if (id === 'done' || id === 'dismiss') onSetStatus(row.itemId, id === 'done' ? 'done' : 'dismissed')
  }
  return (
    <aside className="feedback-rail" data-testid="feedback-rail" aria-label="Feedback" data-filter={view.scope.find((s) => s.on)?.id}>
      <div className="fr-head">
        <div className="fr-row">
          <span className="fr-label">Feedback</span>
          <span className="fr-count" data-testid="feedback-rail-count">{view.countLabel}</span>
          <button type="button" className="fr-x" onClick={onClose} title="Close feedback" aria-label="Close feedback">×</button>
        </div>
        {view.paused ? (
          <>
            <div className="fr-sub"><span className="fr-chip-paused" data-testid="feedback-paused"><span className="fr-dot" />{PAUSED_LABEL}</span></div>
            <div className="fr-sub fr-sub--note">{view.pausedNote}</div>
          </>
        ) : (
          <>
            {view.ended && (
              <>
                <div className="fr-sub"><span className="fr-chip-ended" data-testid="feedback-ended"><span className="fr-dot" />{ENDED_LABEL}</span></div>
                <div className="fr-sub fr-sub--note">{view.endedNote}</div>
              </>
            )}
            {view.sub && <div className="fr-sub">{view.sub}</div>}
            <div className="fr-scope" role="group" aria-label="Show">
              {view.scope.map((scope) => (
                <button
                  key={scope.id}
                  type="button"
                  className={scope.on ? 'is-on' : ''}
                  aria-pressed={scope.on}
                  disabled={scope.disabled}
                  data-testid={`feedback-filter-${scope.id}`}
                  onClick={() => { setFilter(scope.id); setFromMarker(false); setScopeSlideId(null) }}
                >
                  {scope.label}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <div className="fr-error">{error}</div>}
      </div>
      <div className="fr-body" ref={body}>
        {view.group && (
          <div className="fr-group" data-testid="feedback-group"><b>{view.group.number}</b>{view.group.title}</div>
        )}
        {view.rows.map((row) => (
          <Row
            key={row.itemId}
            row={row}
            busy={busy === row.itemId}
            expanded={expanded.has(row.itemId)}
            highlighted={highlight === row.itemId}
            onToggleCompare={() => toggle(row.itemId)}
            onAct={(id) => act(row, id)}
            onOpenSlide={() => { if (row.slideId) onOpenSlide(row.slideId) }}
          />
        ))}
        {view.empty && <div className="fr-empty">{view.empty}</div>}
      </div>
    </aside>
  )
}
