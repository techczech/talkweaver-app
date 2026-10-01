// The results (echo → grid tools → grid or columns): the grouped view (no scope), the outline view
// (one talk, or 2–3 in Sequential, or >3), side-by-side sticky-headed columns (2–3 talks), and —
// beside any list view — one result's whole talk (K5). The empty states sit under the grid.
import type { RefObject } from 'react'
import { Columns2, Rows3 } from 'lucide-react'
import EchoLine from '../browser-rail/EchoLine'
import type { RailFacets } from '../browser-rail/railModel'
import type { FacetKind } from '../browser-rail/railTypes'
import TalkBeside from '../TalkBeside'
import { type buildDisplayModel, type DisplayCard, sectionKey } from '../slideBrowserModel'
import type { BesidePlan } from '../talkBesideModel'
import { CardGrid, TalkChunks } from './CardGrid'
import { EmptyStates } from './EmptyStates'
import { type GridCtx, type OutlineTalkPlan, type SearchResult, STAGGER_CAP } from './types'

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

      {besidePlanNow
        ? (
            // With a talk beside them, the results read as one list, two across (K5).
            <div className="lt-group lt-beside-results">
              <div className="lt-beside-lh">
                {leftCount} slide{leftCount === 1 ? '' : 's'}
                {p.query.trim() ? <> match “{p.query.trim()}”</> : null}
              </div>
              <CardGrid cards={leftCards} base={0} cols={2} ordinals={false} ctx={ctx} />
            </div>
          )
        : p.gridMode === 'grouped'
        ? (() => {
            // No scope: today's grouped-by-talk·section view, duplicate-collapsed.
            let base = 0
            return p.groups.map((g) => {
              const gKey = sectionKey(g.talkSlug, g.section)
              const total = p.groupTotals.get(gKey) ?? g.units
              const b = base
              base += g.cards.length
              return (
                <div key={gKey} className="lt-group">
                  <div className="lt-group-head">
                    <span className="lt-g-talk">{g.talkTitle}</span>
                    {g.section && <span className="lt-g-sep">·</span>}
                    {g.section && <span className="lt-g-section">{p.secName(gKey, g.section)}</span>}
                    <span className="lt-g-count">{g.units === total ? `${total} shown` : `${g.units} of ${total} shown`}</span>
                  </div>
                  <CardGrid cards={g.cards} base={b} cols={p.density} ordinals={false} ctx={ctx} />
                </div>
              )
            })
          })()
        : (() => {
            // Scoped (1 talk, or 2–3 in Sequential, or >3): each talk in OUTLINE
            // ORDER, §-headed sections, position badges (ADR-0009 grid law).
            let base = 0
            return p.outlinePlan.map((t) => {
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
                  <TalkChunks t={t} base={b} cols={p.density} ctx={ctx} />
                </div>
              )
            })
          })()}

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
