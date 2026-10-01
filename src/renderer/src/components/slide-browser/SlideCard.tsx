// One card in the Slide Browser grid: the print, its label row, and the badges that open the
// versions filmstrip / locations panel / near-stack toggle.
import { Check, ChevronsDownUp, ChevronsUpDown, GitBranch, Layers, PanelRight } from 'lucide-react'
import { liveShortcutLabel } from '../../keymap/store'
import {
  type DisplayCard, inTalksLabel, layoutOf, nearCountLabel, sectionKey, selRowKey, stampedIdOf, versionBadgeParts
} from '../slideBrowserModel'
import { cardTitleFor, rowTagsOf, rowTitle } from './browserHelpers'
import { Thumb } from './Thumbs'
import { VaultLabel } from './VaultChips'
import { DEFAULT_LAYOUT, type GridCtx, type SearchResult, STAGGER_CAP } from './types'

// One card at visual position `p`. `ordinal` (outline views only) is the slide's REAL
// outline position in its talk — the position badge the lock demands.
export function SlideCard({ c, p, ordinal, ctx }: { c: DisplayCard; p: number; ordinal?: number; ctx: GridCtx }) {
  const row = c.row as SearchResult
  const rowKey = selRowKey(ctx.vRows, p)
  const isSel = ctx.selected.has(rowKey)
  const isFocused = p === ctx.activePos
  const isExpanded = ctx.expandedRowKey === rowKey
  const isIdentical = c.kind === 'identical'
  const isNear = c.kind === 'near'
  const isVariant = c.kind === 'near-variant'
  // The talk beside the results: its result's slide is highlighted (K5); a result offers "In talk".
  const isHl = ctx.hlPos !== null && p === ctx.hlPos
  const canOpenBeside = p < ctx.leftCount && ctx.besideOk
  const layout = layoutOf(row)
  const showTag = layout && layout !== DEFAULT_LAYOUT
  const ledgerId = stampedIdOf(row.source_markdown)
  const vCounts = ledgerId ? ctx.getCounts(ledgerId) : undefined
  const badgeParts = vCounts ? versionBadgeParts(vCounts.versions, vCounts.talks) : null
  // A collapsed stack shows the "in N talks" pill (not a version badge — which
  // copy's versions would it be?); singles and near-variants show it as before.
  const showVersionBadge = !isIdentical && !isNear
  const secNo = ctx.sectionNoByKey.get(sectionKey(row.talkSlug, row.section ?? ''))
  // The active talk's rows are never on the table, so origin is always another talk.
  const origin = row.talkTitle + (secNo ? ` · §${secNo}` : '')
  const cardTitle = cardTitleFor(c.kind, c.count)
  const vaultOfRow = ctx.vaultOf?.(row.vaultId)
  return (
    <div
      data-pos={p}
      data-kind={c.kind}
      className={`lt-card${isSel ? ' selected' : ''}${isFocused ? ' focused' : ''}${isExpanded ? ' expanded' : ''}${isIdentical ? ' stack' : ''}${isNear ? ' nearstack' : ''}${isVariant ? ' variant' : ''}${isHl ? ' hl' : ''}`}
      style={{ ['--i' as string]: Math.min(p, STAGGER_CAP) }}
      title={cardTitle}
      onClick={(e) => ctx.onCardClick(p, e.shiftKey)}
      onMouseEnter={() => ctx.onCardEnter(p)}
    >
      <div className="lt-sel-mark"><Check className="lt-icon" /></div>
      {ordinal != null && <span className="lt-ordn">{String(ordinal).padStart(2, '0')}</span>}
      <div className="lt-print">
        <Thumb
          key={`${row.talkSlug}/${row.render_hash || row.content_hash}:${ctx.thumbNonces[row.talkSlug] ?? 0}`}
          row={row}
          regenerating={ctx.regenTalk === row.talkSlug}
          onUnavailable={ctx.noteThumbUnavailable}
        />
        {canOpenBeside && (
          <button
            type="button"
            className="lt-inctx"
            title={`Show this slide in its talk, beside the results (${liveShortcutLabel('slide-picker.talk-beside')})`}
            onClick={(e) => { e.stopPropagation(); ctx.openBesideAt(p) }}
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
          {rowTagsOf(row).map((t) => (
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
              onClick={(e) => { e.stopPropagation(); void ctx.toggleStrip(p) }}
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
              onClick={(e) => { e.stopPropagation(); ctx.toggleLocations(p) }}
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
              onClick={(e) => { e.stopPropagation(); ctx.toggleNear(p) }}
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
              onClick={(e) => { e.stopPropagation(); ctx.toggleNear(p) }}
            >
              <ChevronsDownUp className="lt-icon" />
              collapse
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
