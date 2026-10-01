// =============================================================================
// Narrow columns change shape (ADR-0033 §5, slide design round 2, ticket 07)
//
// A column that would be narrower than 22cqw (about 12 characters at body size) cannot hold its
// words, so the compiler changes the SHAPE of the slide's columns instead of squeezing them:
//
//   {iconrow}, five or more items  → the row reflows into rows of three (3 + 2), labels on one line
//   icon-list / logolist CARDS beside a rail → the icon-list ROW shape ({iconlist=list})
//
// This module is the one place that decides it. It is pure: the caller (07-assembly) supplies the
// title placement and the item count, and stamps the answer as a class the stylesheet reads
// (skin/narrow-columns.css). An authored shape always wins — {iconlist=boxes|list} is honoured by the
// renderer before this is consulted — and the whole behaviour is a setting: on by default,
// switchable per slide ({narrowcols=off}) and talk-wide (`narrow_columns: off`).
// =============================================================================

import { readDeckFlag } from "./deck-settings.mjs";

/** A column narrower than this (in cqw of the 1280-wide slide canvas) changes shape. */
export const NARROW_COLUMN_CQW = 22;
/** Icon rows reflow from this many items up (the ADR names five). */
export const ICON_ROW_MIN_ITEMS = 5;
/** Three or four icon-row columns reshape into list rows only when each is under this (cqw). */
export const ICON_ROW_SEVERE_CQW = 18;
export const ICON_ROW_FEW_MIN_ITEMS = 3;
/** Never more than this many icon-row columns per row. */
export const ICON_ROW_MAX_PER_ROW = 3;

// Measured on the 1920px render of the round-2 specimens (it107, ex42): a slide with a left rail
// starts its content 5cqw right of the rail and ends 5.6cqw short of the right edge; the same
// insets apply to a full-width slide. Card columns sit .94cqw apart, icon-row columns 2.2cqw.
const CONTENT_INSET_CQW = 10.6;
const CARD_GAP_CQW = 0.94;
const ICON_ROW_GAP_CQW = 2.2;

/**
 * Read the setting for one slide: slide token `{narrowcols=on|off}` → deck `narrow_columns:` → on.
 * Anything unreadable falls through to the next level, so a typo keeps today's default (on) and
 * never fails a build.
 *
 * @param {Record<string, unknown>|undefined} attrs the slide's trigger attributes
 * @param {Record<string, unknown>|undefined} meta the deck frontmatter
 * @returns {boolean}
 */
export function resolveNarrowColumns(attrs, meta) {
  const slide = readDeckFlag(attrs?.narrowcols);
  if (slide.state === "on") return true;
  if (slide.state === "off") return false;
  const deck = readDeckFlag(meta?.narrow_columns ?? meta?.["narrow-columns"]);
  return deck.state !== "off";
}

/**
 * The width, in cqw, available to the slide's column row: the whole slide minus the left rail
 * (when the title sits in one) and the content insets.
 *
 * @param {{mode?: string, split?: string|number}} titlePlacement from titlePlacementFor
 */
export function usableWidthCqw(titlePlacement) {
  const rail = titlePlacement?.mode === "left" ? Number(titlePlacement.split) || 35 : 0;
  return 100 - rail - CONTENT_INSET_CQW;
}

/** The width of one card column when `count` cards share `usable` cqw. */
export function cardColumnCqw(count, usable) {
  const n = Math.max(1, count);
  return (usable - (n - 1) * CARD_GAP_CQW) / n;
}

/** True when `count` cards in `usable` cqw would each be narrower than 22cqw. */
export function cardsTooNarrow(count, usable) {
  return count >= 2 && cardColumnCqw(count, usable) < NARROW_COLUMN_CQW;
}

/**
 * How many icon-row columns fit on one row of the reshaped icon row, or 0 when the row keeps its
 * single line (fewer than three items, every column already wide enough, or three or four columns
 * that are not severely narrow). Three or four severely narrow columns answer 1: list rows.
 */
export function iconRowPerRow(count, usable) {
  const column = (usable - (count - 1) * ICON_ROW_GAP_CQW) / count;
  if (count >= ICON_ROW_FEW_MIN_ITEMS && count < ICON_ROW_MIN_ITEMS) {
    // Three or four columns are left alone until they are severely narrow (three beside a rail:
    // 16.7cqw, "Epiphenomenal" was cut at the slide edge); then they become list rows, one per row.
    return column < ICON_ROW_SEVERE_CQW ? 1 : 0;
  }
  if (count < ICON_ROW_MIN_ITEMS) return 0;
  if (column >= NARROW_COLUMN_CQW) return 0;
  const fits = Math.floor((usable + ICON_ROW_GAP_CQW) / (NARROW_COLUMN_CQW + ICON_ROW_GAP_CQW));
  return Math.min(ICON_ROW_MAX_PER_ROW, Math.max(2, fits));
}

/**
 * Mark the top-level blocks whose columns the renderer may reshape with the width they have. The
 * renderer alone knows which list is a card grid (icon style, no authored treatment), so this only
 * hands it the number; nothing changes when the setting is off.
 *
 * @param {object[]} blocks the slide's body blocks
 * @param {{enabled: boolean, titlePlacement: object}} options
 * @returns {object[]} the same array when nothing was marked
 */
export function withColumnWidth(blocks, { enabled, titlePlacement }) {
  if (!enabled || !Array.isArray(blocks)) return blocks;
  const usable = usableWidthCqw(titlePlacement);
  let changed = false;
  const next = blocks.map((block) => {
    if (!block || (block.type !== "feature-list" && block.type !== "iconrow")) return block;
    changed = true;
    return { ...block, columnsUsableCqw: usable };
  });
  return changed ? next : blocks;
}
