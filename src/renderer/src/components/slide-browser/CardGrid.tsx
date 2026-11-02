// A grid of cards, and one talk's outline-ordered, section-headed chunks of grids. The grouped and
// outline views and the results beside a talk draw through VirtualGrid (only what is on screen);
// these whole grids remain for the side-by-side columns and the talk beside (one talk each).
import { Fragment, type ReactElement } from 'react'
import { ListChecks } from 'lucide-react'
import { liveShortcutLabel } from '../../keymap/store'
import {
  type DisplayCard, sectionKey, sectionSelectionKeys, selRowKey, selectSectionLabel, stampedIdOf, stripAnchorPercent
} from '../slideBrowserModel'
import { cardTagsKey, expansionAfterIndex, sectionSourceFor } from './browserHelpers'
import { SlideCard } from './SlideCard'
import { type GridCtx, type OutlineTalkPlan, type SearchResult, STAGGER_CAP } from './types'

/** One card at visual position `p`, with only its own props taken from the Browser's state. Keyed
 *  by rowKey + position: outline views render EVERY occurrence (no duplicate collapse), and
 *  byte-identical copies inside one talk can share a derived slide_id. */
export function cardElement(ctx: GridCtx, c: DisplayCard, p: number, ordinal: number | undefined, stagger: number | null): ReactElement {
  const row = c.row as SearchResult
  const rowKey = selRowKey(ctx.vRows, p)
  const ledgerId = stampedIdOf(row.source_markdown)
  return (
    <SlideCard
      key={`${rowKey}@${p}`}
      c={c}
      p={p}
      ordinal={ordinal}
      isSel={ctx.selected.has(rowKey)}
      isFocused={p === ctx.activePos}
      isExpanded={ctx.expandedRowKey === rowKey}
      isHl={ctx.hlPos !== null && p === ctx.hlPos}
      canOpenBeside={p < ctx.leftCount && ctx.besideOk}
      secNo={ctx.sectionNoByKey.get(sectionKey(row.talkSlug, row.section ?? ''))}
      thumbNonce={ctx.thumbNonces[row.talkSlug] ?? 0}
      regenerating={ctx.regenTalk === row.talkSlug}
      vCounts={ledgerId ? ctx.getCounts(ledgerId) : undefined}
      vault={ctx.vaultOf?.(row.vaultId)}
      tagsKey={cardTagsKey(row)}
      stagger={stagger}
      actions={ctx.actions}
    />
  )
}

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
        const card = cardElement(ctx, c, p, ordinals ? ((c.row as SearchResult).order ?? 0) + 1 : undefined, Math.min(p, STAGGER_CAP))
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

/** A section heading in an outline view: § name, "Select section · N slides", and the count. */
export function SectionHead({ slug, section, label, count, countSuffix = '', ctx }: {
  slug: string
  section: string
  label: string
  count: number
  countSuffix?: string
  ctx: GridCtx
}) {
  const src = sectionSourceFor(ctx.rowsByTalk, slug, section)
  let button: ReactElement | null = null
  if (src) {
    const secKeys = sectionSelectionKeys(ctx.rowsByTalk.get(slug) ?? [], slug, section)
    const allIn = secKeys.length > 0 && secKeys.every((k) => ctx.selected.has(k))
    button = (
      <button
        type="button"
        className={`lt-sel-sec${allIn ? ' on' : ''}`}
        aria-pressed={allIn}
        title={`Select “${label}” — its heading slide and every slide under it (${liveShortcutLabel('slide-picker.select-whole-section')} on a slide). Take single slides out with ${liveShortcutLabel('slide-picker.toggle-selection')} or a click; ${liveShortcutLabel('slide-picker.insert')} inserts the selection.`}
        onClick={(e) => {
          e.stopPropagation()
          ctx.selectWholeSection(slug, section)
        }}
      >
        <ListChecks className="lt-icon" /> {selectSectionLabel(src.slides)}
      </button>
    )
  }
  return (
    <div className="lt-sec-head">
      <span>§ {label}</span>
      {button}
      <span className="lt-sec-n">{count}{countSuffix}</span>
    </div>
  )
}

// One talk's outline-ordered, section-headed chunks (side-by-side columns + the talk beside).
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
              <SectionHead slug={t.slug} section={c.section} label={c.label} count={c.cards.length} countSuffix={countSuffix} ctx={ctx} />
            )}
            <CardGrid cards={c.cards} base={chunkBase} cols={cols} ordinals ctx={ctx} />
          </div>
        )
      })}
      {t.total === 0 && <TalkZero title={t.title} />}
    </>
  )
}

export function TalkZero({ title }: { title: string }) {
  return (
    <div className="lt-col-zero">
      No slides in <b>{title}</b> match the current search and filters.
    </div>
  )
}
