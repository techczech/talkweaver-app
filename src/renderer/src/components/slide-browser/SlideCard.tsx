// One card in the Slide Browser grid: the print, its label row, and the badges that open the
// versions filmstrip / locations panel / near-stack toggle.
import React, { useState } from 'react'
import { Check, ChevronsDownUp, ChevronsUpDown, GitBranch, Layers, PanelRight } from 'lucide-react'
import { liveShortcutLabel } from '../../keymap/store'
import {
  type DisplayCard, inTalksLabel, layoutOf, nearCountLabel, stampedIdOf, versionBadgeParts
} from '../slideBrowserModel'
import { cardTitleFor, rowTitle } from './browserHelpers'
import { Thumb } from './Thumbs'
import { VaultLabel } from './VaultChips'
import type { ChipVault } from './vaultChipsModel'
import { DEFAULT_LAYOUT, type SearchResult, STAGGER_CAP, type VersionCounts } from './types'

/** What a card can do — one object for the Browser's whole life (its functions read the live
 *  state through a ref), so it never breaks the card memo. */
export interface CardActions {
  onCardClick: (pos: number, shift: boolean) => void
  onCardEnter: (pos: number) => void
  openBesideAt: (pos: number) => void
  toggleStrip: (pos: number) => Promise<void>
  toggleLocations: (pos: number) => void
  toggleNear: (pos: number) => void
  noteThumbUnavailable: (row: SearchResult) => void
}

export interface SlideCardProps {
  c: DisplayCard
  p: number
  /** Outline views only: the slide's REAL outline position in its talk — the position badge the lock demands. */
  ordinal?: number
  isSel: boolean
  isFocused: boolean
  isExpanded: boolean
  /** The talk beside the results: its result's slide is highlighted (K5). */
  isHl: boolean
  /** A result offers "In talk". */
  canOpenBeside: boolean
  secNo?: number
  thumbNonce: number
  regenerating: boolean
  /** The version-badge counts of the card's stamped id; undefined until fetched. */
  vCounts?: VersionCounts
  /** With several open vaults (ticket 06): the result's vault, for its label. */
  vault?: ChipVault
  /** The row's curated tags, one per line: the chips' data as a value. Tagging updates a row's
   *  `tags` in place (useTagging), so the display card keeps its identity; this prop is what tells
   *  the memo the chips changed. */
  tagsKey: string
  /** The entry animation's stagger step, or null for no entry animation (a card scrolled into view).
   *  Read when the card mounts: a later change neither re-renders the card nor replays its entry. */
  stagger: number | null
  actions: CardActions
}

// One card at visual position `p`. Memoised (identity contract): every prop is a primitive, a value
// object that keeps its identity until its data changes (the display card, counts, vault), or the
// one stable `actions` object — so a selection, focus or loading change re-renders only the cards
// whose own props changed. scripts/test-slide-browser-render-budget.mjs counts it.
export const SlideCard = React.memo(function SlideCard({
  c, p, ordinal, isSel, isFocused, isExpanded, isHl, canOpenBeside, secNo, thumbNonce, regenerating,
  vCounts, vault, tagsKey, stagger: staggerProp, actions
}: SlideCardProps) {
  const [stagger] = useState(staggerProp)
  const row = c.row as SearchResult
  const isIdentical = c.kind === 'identical'
  const isNear = c.kind === 'near'
  const isVariant = c.kind === 'near-variant'
  const layout = layoutOf(row)
  const showTag = layout && layout !== DEFAULT_LAYOUT
  const ledgerId = stampedIdOf(row.source_markdown)
  const badgeParts = vCounts ? versionBadgeParts(vCounts.versions, vCounts.talks) : null
  // A collapsed stack shows the "in N talks" pill (not a version badge — which
  // copy's versions would it be?); singles and near-variants show it as before.
  const showVersionBadge = !isIdentical && !isNear
  // The active talk's rows are never on the table, so origin is always another talk.
  const origin = row.talkTitle + (secNo ? ` · §${secNo}` : '')
  const cardTitle = cardTitleFor(c.kind, c.count)
  const vaultOfRow = vault
  return (
    <div
      data-pos={p}
      data-kind={c.kind}
      className={`lt-card${isSel ? ' selected' : ''}${isFocused ? ' focused' : ''}${isExpanded ? ' expanded' : ''}${isIdentical ? ' stack' : ''}${isNear ? ' nearstack' : ''}${isVariant ? ' variant' : ''}${isHl ? ' hl' : ''}${stagger === null ? ' no-enter' : ''}`}
      style={stagger === null ? undefined : { ['--i' as string]: Math.min(stagger, STAGGER_CAP) }}
      title={cardTitle}
      onClick={(e) => actions.onCardClick(p, e.shiftKey)}
      onMouseEnter={() => actions.onCardEnter(p)}
    >
      <div className="lt-sel-mark"><Check className="lt-icon" /></div>
      {ordinal != null && <span className="lt-ordn">{String(ordinal).padStart(2, '0')}</span>}
      <div className="lt-print">
        <Thumb
          key={`${row.talkSlug}/${row.render_hash || row.content_hash}:${thumbNonce}`}
          row={row}
          regenerating={regenerating}
          onUnavailable={actions.noteThumbUnavailable}
        />
        {canOpenBeside && (
          <button
            type="button"
            className="lt-inctx"
            title={`Show this slide in its talk, beside the results (${liveShortcutLabel('slide-picker.talk-beside')})`}
            onClick={(e) => { e.stopPropagation(); actions.openBesideAt(p) }}
          >
            <PanelRight className="lt-icon" /> In talk
          </button>
        )}
      </div>
      <div className="lt-label">
        <div className="lt-l-title">{rowTitle(row)}</div>
        <div className="lt-l-meta">
          {showTag && <span className="lt-tag">{layout}</span>}
          {isVariant && <span className="lt-tag lt-variant-tag">variant {c.variantIndex}</span>}
          {/* Curated tags (ADR-0037): small filled mono chips, mockup grammar. */}
          {(tagsKey === '' ? [] : tagsKey.split('\n')).map((t) => (
            <span key={`tag:${t}`} className="lt-minitag">{t}</span>
          ))}
          <span className="lt-origin" title={origin}>{origin}</span>
          {vaultOfRow && <VaultLabel vault={vaultOfRow} />}
          {/* Version badge: only stamped rows (a real {id=…}) carry one.
              Counts ripen lazily from the cache — no per-card IPC.
              Gate-4 honesty: before this id's counts are actually in the
              cache the badge says NOTHING (silent shimmer pill) — the
              dashed 'no versions yet' means a fetch confirmed zero. */}
          {showVersionBadge && ledgerId && !vCounts && <span className="lt-vbadge-sk" aria-hidden="true" />}
          {showVersionBadge && ledgerId && vCounts && vCounts.versions === 0 && (
            <span className="lt-vbadge novers" title="No versions yet — versions appear when you save changes">
              <GitBranch className="lt-icon" />
              no versions yet
            </span>
          )}
          {showVersionBadge && ledgerId && vCounts && vCounts.versions > 0 && (
            <button
              type="button"
              className="lt-vbadge"
              title="Show versions (E)"
              onClick={(e) => { e.stopPropagation(); void actions.toggleStrip(p) }}
            >
              <GitBranch className="lt-icon" />
              {badgeParts ? badgeParts.base : 'versions'}
              {badgeParts?.long ? <span className="long">{badgeParts.long}</span> : null}
            </button>
          )}
          {/* Identical stack: the "in N talks" pill opens the where-used
              locations panel (also E) — the merge action lives inside it. */}
          {isIdentical && (
            <button
              type="button"
              className={`lt-clusterbadge${isExpanded ? ' on' : ''}`}
              title="Where this slide lives — and merge into one (E)"
              onClick={(e) => { e.stopPropagation(); actions.toggleLocations(p) }}
            >
              <Layers className="lt-icon" />
              {inTalksLabel(c.talks?.length ?? 0)}
            </button>
          )}
          {/* Near stack: an obvious Uncollapse control (also U). */}
          {isNear && (
            <button
              type="button"
              className="lt-nearbadge"
              title="Uncollapse to compare the variants (U)"
              onClick={(e) => { e.stopPropagation(); actions.toggleNear(p) }}
            >
              <ChevronsUpDown className="lt-icon" />
              {nearCountLabel(c.count ?? 0)} · uncollapse
            </button>
          )}
          {/* Near variant: a re-collapse affordance (also U). */}
          {isVariant && (
            <button
              type="button"
              className="lt-nearbadge ghost"
              title="Collapse these variants back (U)"
              onClick={(e) => { e.stopPropagation(); actions.toggleNear(p) }}
            >
              <ChevronsDownUp className="lt-icon" />
              collapse
            </button>
          )}
        </div>
      </div>
    </div>
  )
}, sameCardExceptStagger)

function sameCardExceptStagger(a: SlideCardProps, b: SlideCardProps): boolean {
  for (const k in a) {
    if (k !== 'stagger' && a[k as keyof SlideCardProps] !== b[k as keyof SlideCardProps]) return false
  }
  for (const k in b) if (!(k in a)) return false
  return true
}
