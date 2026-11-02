// The results (echo → grid tools → grid or columns): the grouped view (no scope), the outline view
// (one talk, or 2–3 in Sequential, or >3), side-by-side sticky-headed columns (2–3 talks), and —
// beside any list view — one result's whole talk (K5). The empty states sit under the grid.
import { type ReactNode, type RefObject, useMemo, useRef } from 'react'
import { Columns2, Rows3 } from 'lucide-react'
import EchoLine from '../browser-rail/EchoLine'
import type { RailFacets } from '../browser-rail/railModel'
import type { FacetKind } from '../browser-rail/railTypes'
import TalkBeside from '../TalkBeside'
import { type buildDisplayModel, type DisplayCard, sectionKey, stripAnchorPercent } from '../slideBrowserModel'
import type { BesidePlan } from '../talkBesideModel'
import { SectionHead, TalkChunks, TalkZero, cardElement } from './CardGrid'
import { EmptyStates } from './EmptyStates'
import { type GridCtx, type OutlineTalkPlan, type SearchResult, STAGGER_CAP } from './types'
import { VirtualGrid } from './VirtualGrid'
import { type GridLine, buildGridLines } from './gridWindowing'

type EmptyStateProps = Parameters<typeof EmptyStates>[0]

export interface ResultsPaneProps {
  ctx: GridCtx
  facets: RailFacets
  onToggleFacet: (kind: FacetKind, value: string) => void
  onClearFacets: () => void
  sideEligible: boolean
  scopedCount: number
  viewPref: 'side' | 'seq'
  onSetView: (v: 'side' | 'seq') => void
  gridMode: 'grouped' | 'outline' | 'side'
  outlinePlan: OutlineTalkPlan[]
  groups: ReturnType<typeof buildDisplayModel>['groups']
  groupTotals: Map<string, number>
  secName: (key: string, fallback: string) => string
  /** The authored section names secName reads (identity changes when they do). */
  sectionNames: unknown
  density: number
  loading: boolean
  resultCount: number
  unavailable: boolean
  query: string
  leftCards: DisplayCard[]
  besidePlanNow: BesidePlan<SearchResult> | null
  besideOrder: number
  onCloseBeside: () => void
  tableScrollRef: RefObject<HTMLDivElement>
  empty: EmptyStateProps
}

export function ResultsPane(p: ResultsPaneProps) {
  const { ctx, besidePlanNow, leftCards } = p
  const leftCount = ctx.leftCount
  // The results as lines (headings, card rows, the open expansion): only those near the viewport
  // are drawn (VirtualGrid). The talk beside and the side-by-side columns draw whole (one talk each).
  const secNameRef = useRef(p.secName)
  secNameRef.current = p.secName
  const besideOn = besidePlanNow !== null
  const lines = useMemo(() => {
    if (p.gridMode === 'side') return []
    const resultsExpandedPos = ctx.expandedPos < leftCount ? ctx.expandedPos : -1
    if (besideOn) return buildGridLines({ mode: 'beside', cards: leftCards, cols: 2, expandedPos: resultsExpandedPos })
    if (p.gridMode === 'grouped') {
      return buildGridLines({
        mode: 'grouped', groups: p.groups, groupTotals: p.groupTotals, cols: p.density, expandedPos: resultsExpandedPos,
        groupKey: (g) => sectionKey(g.talkSlug, g.section), secName: (k, f) => secNameRef.current(k, f)
      })
    }
    return buildGridLines({ mode: 'outline', plan: p.outlinePlan, cols: p.density, expandedPos: resultsExpandedPos })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.gridMode, besideOn, leftCards, p.groups, p.groupTotals, p.outlinePlan, p.density, ctx.expandedPos, leftCount, p.sectionNames])

  function renderLine(line: GridLine, stagger: (pos: number) => number | null): ReactNode {
    switch (line.kind) {
      case 'group-head':
        return (
          <div className="lt-group-head">
            <span className="lt-g-talk">{line.talkTitle}</span>
            {line.section && <span className="lt-g-sep">·</span>}
            {line.section && <span className="lt-g-section">{line.sectionLabel}</span>}
            <span className="lt-g-count">{line.countLabel}</span>
          </div>
        )
      case 'talk-head':
        return (
          <div className="lt-group-head">
            <span className="lt-g-talk">{line.title}</span>
            <span className="lt-g-sep">·</span>
            <span className="lt-g-section">outline order</span>
            <span className="lt-g-count">{line.total} slide{line.total === 1 ? '' : 's'}</span>
          </div>
        )
      case 'sec-head':
        return <SectionHead slug={line.slug} section={line.section} label={line.label} count={line.count} ctx={ctx} />
      case 'beside-head':
        return (
          <div className="lt-beside-lh">
            {leftCount} slide{leftCount === 1 ? '' : 's'}
            {p.query.trim() ? <> match “{p.query.trim()}”</> : null}
          </div>
        )
      case 'row':
        return (
          <div className={`lt-grid g${line.cols}`}>
            {line.cards.map((c, j) => {
              const pos = line.base + j
              return cardElement(ctx, c, pos, line.ordinals ? ((c.row as SearchResult).order ?? 0) + 1 : undefined, stagger(pos))
            })}
          </div>
        )
      case 'expansion':
        return (
          <div className={`lt-grid g${line.cols}`}>
            {ctx.renderExpansion(stripAnchorPercent(line.anchorIndex % line.cols, line.cols), ctx.vRows[line.pos])}
          </div>
        )
      case 'zero':
        return <TalkZero title={line.title} />
    }
  }

  return (
    <main className="lt-results">
      <EchoLine facets={p.facets} onToggle={p.onToggleFacet} onClearFacets={p.onClearFacets} />
      {p.sideEligible && (
        <div className="lt-gridtools">
          <span className="lt-gridnote">
            {p.scopedCount} talks in scope — each in outline order
          </span>
          <div className="lt-vseg" role="group" aria-label="Multi-talk view">
            <button
              type="button"
              className={p.viewPref === 'side' ? 'on' : ''}
              onClick={() => p.onSetView('side')}
            >
              <Columns2 className="lt-icon" /> Side by side
            </button>
            <button
              type="button"
              className={p.viewPref === 'seq' ? 'on' : ''}
              onClick={() => p.onSetView('seq')}
            >
              <Rows3 className="lt-icon" /> Sequential
            </button>
          </div>
        </div>
      )}
      {p.gridMode === 'side' ? (
        // 2–3 talks: side-by-side sticky-headed columns, each in outline order with
        // its own scroll — the shared comparison anatomy Pathway view (v0.16) and
        // family compare (v0.17) will reuse.
        <div className="lt-colwrap">
          {(() => {
            let base = 0
            return p.outlinePlan.map((t) => {
              const colBase = base
              base += t.total
              return (
                <section key={t.slug} className="lt-col" aria-label={t.title}>
                  <div className="lt-col-head">
                    <span className="lt-col-talk" title={t.title}>{t.title}</span>
                    <span className="lt-col-ord">outline order</span>
                    <span className="lt-col-n">{t.total}</span>
                  </div>
                  <div className="lt-col-scroll"><TalkChunks t={t} base={colBase} cols={2} ctx={ctx} /></div>
                </section>
              )
            })
          })()}
        </div>
      ) : (
      // The results and, when open, a result's talk beside them (K5). The results' scroll box
      // stays the same element either way, so closing the talk leaves it where it was.
      <div className={`lt-split${besidePlanNow ? ' open' : ''}`}>
      <div className="lt-table-scroll" ref={p.tableScrollRef}>
      {p.loading && p.resultCount === 0 && !p.unavailable && (
        <div className="lt-group">
          <div className={`lt-grid g${p.density}`}>
            {Array.from({ length: p.density * 2 }, (_v, i) => (
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

      <VirtualGrid
        lines={lines}
        scrollRef={p.tableScrollRef}
        renderLine={renderLine}
        focusPos={ctx.activePos}
        focusDeps={ctx.vRows}
        entryKey={leftCards}
      />

      <EmptyStates {...p.empty} />
      </div>
      {besidePlanNow && (
        <TalkBeside
          // One mount per opening; again when the whole deck replaces the live stand-in, so
          // it scrolls to the section once the full talk is there.
          key={`${besidePlanNow.slug}#${p.besideOrder}#${besidePlanNow.deck.length}`}
          header={besidePlanNow.header}
          hlChunk={besidePlanNow.hlChunk}
          hlPos={leftCount + besidePlanNow.hl}
          onClose={p.onCloseBeside}
        >
          <TalkChunks
            t={{
              slug: besidePlanNow.slug,
              title: besidePlanNow.title,
              total: besidePlanNow.deck.length,
              chunks: besidePlanNow.chunks.map((c) => ({
                section: c.section,
                label: c.label,
                cards: c.rows.map((row) => ({ row, kind: 'single' as const }))
              }))
            }}
            base={leftCount}
            cols={3}
            countSuffix=" shown"
            ctx={ctx}
          />
        </TalkBeside>
      )}
      </div>
      )}
    </main>
  )
}
