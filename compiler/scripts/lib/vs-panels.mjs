// The two-panel "vs" drawing shared by compare and contrast (ADR-0039, 0.41 ticket 08): a head and a few
// rows in each panel, each row carrying one icon, the two panels joined by a dark "vs" disc.
//
// This module is the MODEL only: which heads and rows a compare or contrast block draws, which icon each
// row gets, and which rows have none. The markup is written by 06-block-renderers.mjs and the compiler's
// warning for a row without an icon (`vs-row-no-icon`) comes from collectVsRowsWithoutIcon below, which
// reads the same model, so the warning and the render never disagree about which rows are bare.
//
// Icon for a row, in order: the icon the author wrote on it ({icon=name} or {name} at the end of the row;
// on a contrast row the left side takes one right after its text, the right side at the end of the row),
// the deck `icons:` map, then the semantic pick every icon list uses. A row that gets none still renders,
// without an icon, and the compiler warns.
import { listItemIconTokenAt } from "./03-markdown-lexer-core.mjs";
import {
  normalizeIconOverrideKey, resolveIconOverrides, decideFeatureListStyle, iconlistResolves, svglBrandMatch,
} from "./05-icons.mjs";

// A contrast with at least this many pairs writes its panel heads as the first pair ("Chatbot / Agent").
// Five and more already did (the old panel device); four is the drawing's head plus three rows.
export const VS_CONTRAST_HEADS_FROM = 4;
// Five rows a side, or a row longer than this, steps the text down to the drawing's long size.
export const VS_LONG_ROWS = 5;
export const VS_LONG_CHARS = 34;

const textOf = (value) => String(value ?? "").trim();

// A contrast block draws as two panels unless the author chose another contrast device.
export function contrastDrawsAsPanels(block) {
  return Boolean(block) && block.type === "contrast" && Array.isArray(block.pairs) && block.pairs.length > 0 && !block.variant;
}

// {compare}: the first two halves. Drawn as panels only when every line of both halves is a plain row
// (a list item, a paragraph or a claim) with nothing nested under it; a half with a picture, a code
// block or sub-bullets keeps the old halves, so nothing the author wrote is dropped.
export function compareModel(block) {
  if (!block || block.type !== "compare") return null;
  const halves = (block.halves ?? []).slice(0, 2);
  if (halves.length < 2) return null;
  const panels = [];
  for (const half of halves) {
    const rows = [];
    for (const b of half.blocks ?? []) {
      if (!b) continue;
      if (b.type === "feature-list" || b.type === "list") {
        const items = Array.isArray(b.items) ? b.items : [];
        const children = Array.isArray(b.children) ? b.children : [];
        if (children.some((kids) => Array.isArray(kids) && kids.length)) return null;
        items.forEach((text, i) => { if (textOf(text)) rows.push({ text: textOf(text), icon: b.iconOverrides?.[i] || null }); });
      } else if (b.type === "paragraph" || b.type === "claim") {
        if (textOf(b.text)) rows.push({ text: textOf(b.text), icon: b.icon || null });
      } else {
        return null;
      }
    }
    if (!rows.length) return null;
    panels.push({ head: textOf(half.label), rows });
  }
  return finishModel(panels);
}

// {contrast}: "left / right" pairs. With VS_CONTRAST_HEADS_FROM or more pairs the first names the panels.
export function contrastModel(block) {
  if (!contrastDrawsAsPanels(block)) return null;
  const parsed = block.pairs.map(([left, right], i) => {
    const token = listItemIconTokenAt(textOf(left), normalizeIconOverrideKey);
    return {
      left: { text: token ? textOf(left).slice(0, token.index).trim() : textOf(left), icon: token?.icon || null, children: block.pairChildren?.[i]?.[0] },
      right: { text: textOf(right), icon: block.iconOverrides?.[i] || null, children: block.pairChildren?.[i]?.[1] },
    };
  });
  const headed = block.headed ?? (parsed.length >= VS_CONTRAST_HEADS_FROM);
  const body = headed ? parsed.slice(1) : parsed;
  const panels = [
    { head: headed ? parsed[0].left.text : "", rows: body.map((p) => p.left) },
    { head: headed ? parsed[0].right.text : "", rows: body.map((p) => p.right) },
  ];
  return finishModel(panels);
}

// Whether the panels draw the icon of contrast pair `index` (its `iconOverrides[index]`): only a bare
// {contrast} drawn as panels, only a body row (with VS_CONTRAST_HEADS_FROM or more pairs, pair 0 is the
// panel heads, which take an icon only from a brand name), and only when the row's right side has text
// (the icon is drawn on the right side; an empty side draws nothing). The list-item icon verb
// (outline-list-item-icon.mjs) asks this before it writes an icon on a contrast row.
export function contrastRowDrawsIcon(block, index) {
  const model = contrastModel(block);
  if (!model || !Number.isInteger(index)) return false;
  const row = index - (model.headed ? 1 : 0);
  const right = row >= 0 ? model.panels[1].rows[row] : null;
  return Boolean(right && textOf(right.text));
}

function finishModel(panels) {
  const rowCount = Math.max(...panels.map((p) => p.rows.length));
  const longest = Math.max(0, ...panels.flatMap((p) => p.rows.map((r) => r.text.length)));
  return {
    panels,
    rowCount,
    headed: panels.some((p) => p.head),
    long: rowCount >= VS_LONG_ROWS || longest > VS_LONG_CHARS,
  };
}

// The icon key a head carries: a brand named in it ("ChatGPT", "Codex") draws its TalkWeaver logo.
export function headIconKey(head) {
  const brand = head ? svglBrandMatch(head) : null;
  return brand ? `svgl:${brand}` : null;
}

// The icon key for a row, or null. `vocab` is the deck's icon vocabulary at render time (the same
// concept keeps one glyph through the deck), and null in the compiler's check.
export function rowIconKey(row, vocab) {
  if (!row || !textOf(row.text)) return null;
  const own = row.icon || null;
  const overrides = resolveIconOverrides([row.text], [own], vocab && vocab.iconMap);
  if (own) return own;
  if (vocab) return decideFeatureListStyle([row.text], false, vocab, "icons", overrides).icons?.[0] || null;
  return overrides?.[0] || (iconlistResolves([row.text]) ? "auto" : null);
}

// Compiler warnings: one `vs-row-no-icon:<slide-id>:<count>` per slide with compare or contrast rows
// that no icon could be found for. Walks the slides' blocks (post layout mapping).
export function collectVsRowsWithoutIcon(slides) {
  const out = [];
  for (const slide of slides || []) {
    let bare = 0;
    for (const block of slide.blocks || []) {
      const model = block?.type === "compare" ? compareModel(block) : block?.type === "contrast" ? contrastModel(block) : null;
      if (!model) continue;
      for (const panel of model.panels) for (const row of panel.rows) if (row.text && !rowIconKey(row, null)) bare += 1;
    }
    if (bare) out.push(`vs-row-no-icon:${slide.id || ""}:${bare}`);
  }
  return out;
}
