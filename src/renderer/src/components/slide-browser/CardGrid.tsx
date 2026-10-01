// A grid of cards, and one talk's outline-ordered, section-headed chunks of grids. Shared by the
// grouped view (density columns), the outline view, side-by-side columns and the talk beside.
import { Fragment } from 'react'
import { ListChecks } from 'lucide-react'
import { liveShortcutLabel } from '../../keymap/store'
import {
  type DisplayCard, sectionSelectionKeys, selRowKey, selectSectionLabel, stripAnchorPercent
} from '../slideBrowserModel'
import { expansionAfterIndex, sectionSourceFor } from './browserHelpers'
import { SlideCard } from './SlideCard'
import type { GridCtx, OutlineTalkPlan, SearchResult } from './types'

// A grid of cards starting at visual position `base`, `cols` across, with the open
// expansion (filmstrip / locations) inserted after the end of the grid row holding the
// expanded card — its ::before caret pointing at the card's centre.
export function CardGrid({ cards, base, cols, ordinals, ctx }: {
  cards: DisplayCard[]
  base: number
  cols: number
  ordinals: boolean
  ctx: GridCtx
}) {
  const { jExp, expAfter } = expansionAfterIndex(ctx.expandedPos, base, cards.length, cols)
  return (
    <div className={`lt-grid g${cols}`}>
      {cards.map((c, j) => {
        const p = base + j
        // Keyed by rowKey + position: outline views render EVERY occurrence (no duplicate
        // collapse), and byte-identical copies inside one talk can share a derived slide_id.
        const card = (
          <SlideCard
            key={`${selRowKey(ctx.vRows, p)}@${p}`}
            c={c}
            p={p}
            ordinal={ordinals ? ((c.row as SearchResult).order ?? 0) + 1 : undefined}
            ctx={ctx}
          />
        )
        if (j !== expAfter) return card
        return (
          <Fragment key={`${selRowKey(ctx.vRows, p)}@${p}+exp`}>
            {card}
            {ctx.renderExpansion(stripAnchorPercent(jExp % cols, cols), ctx.vRows[ctx.expandedPos])}
          </Fragment>
        )
      })}
    </div>
  )
}

// One talk's outline-ordered, section-headed chunks (outline + side-by-side views).
// Chunks are keyed by their index too: a talk's unsectioned chunks (title slide, closing slide)
// share the section '' and would otherwise share a key, leaving a stale card behind.
export function TalkChunks({ t, base, cols, countSuffix = '', ctx }: {
  t: OutlineTalkPlan
  base: number
  cols: number
  countSuffix?: string
  ctx: GridCtx
}) {
  let b = base
  return (
    <>
      {t.chunks.map((c, ci) => {
        const chunkBase = b
        b += c.cards.length
        return (
          <div key={`${t.slug}\n${ci}\n${c.section}`} className="lt-outline-sec" data-chunk={ci}>
            {c.section !== '' && (
              <div className="lt-sec-head">
                <span>§ {c.label}</span>
                {(() => {
                  const src = sectionSourceFor(ctx.rowsByTalk, t.slug, c.section)
                  if (!src) return null
                  const secKeys = sectionSelectionKeys(ctx.rowsByTalk.get(t.slug) ?? [], t.slug, c.section)
                  const allIn = secKeys.length > 0 && secKeys.every((k) => ctx.selected.has(k))
                  return (
                    <button
                      type="button"
                      className={`lt-sel-sec${allIn ? ' on' : ''}`}
                      aria-pressed={allIn}
                      title={`Select “${c.label}” — its heading slide and every slide under it (${liveShortcutLabel('slide-picker.select-whole-section')} on a slide). Take single slides out with ${liveShortcutLabel('slide-picker.toggle-selection')} or a click; ${liveShortcutLabel('slide-picker.insert')} inserts the selection.`}
                      onClick={(e) => {
                        e.stopPropagation()
                        ctx.selectWholeSection(t.slug, c.section)
                      }}
                    >
                      <ListChecks className="lt-icon" /> {selectSectionLabel(src.slides)}
                    </button>
                  )
                })()}
                <span className="lt-sec-n">{c.cards.length}{countSuffix}</span>
              </div>
            )}
            <CardGrid cards={c.cards} base={chunkBase} cols={cols} ordinals ctx={ctx} />
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
