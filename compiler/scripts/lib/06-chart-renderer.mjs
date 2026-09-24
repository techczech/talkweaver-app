import { escapeHtml } from "./00-html.mjs";
import { renderInline } from "./00-inline-render.mjs";

// Shared chart renderer for the compiler and the renderer-process RIVER widget. This module stays
// browser-safe: it depends only on the compiler's extracted pure inline and escaping helpers.
export function renderChartBlock(block) {
  const shape = block.shape === "pie" || block.shape === "line" ? block.shape : "bar";
  const pts = (block.points || []).filter((p) => p && Number.isFinite(p.value));
  if (!pts.length) return "";
  if (shape === "bar") {
    // Vertical columns, bottom-aligned (the {steps} grammar): height % of max computed at
    // build time; authored value text above the column, label beneath.
    const max = Math.max(...pts.map((p) => Math.abs(p.value))) || 1;
    const cols = pts.map((p) => {
      const h = Math.max(3, Math.round((Math.abs(p.value) / max) * 100));
      return `<div class="chart-col"><div class="chart-col-plot"><span class="chart-val">${renderInline(p.valueText)}</span><div class="chart-bar" style="height:${h}%"></div></div><span class="chart-label">${renderInline(p.label || "")}</span></div>`;
    }).join("");
    return `<div class="chart-cols count-${pts.length}">${cols}</div>`;
  }
  const COLOURS = ["#0b3a6b", "#9f1239", "#166534", "#c08a1d", "#7c3aed", "#be185d"];
  if (shape === "pie") {
    // Build-time SVG arcs from percentage shares + a legend column (label · value · %).
    const total = pts.reduce((sum, p) => sum + Math.abs(p.value), 0) || 1;
    const cx = 200, cy = 200, r = 184;
    let angle = -90;
    const slices = pts.map((p, i) => {
      const share = Math.abs(p.value) / total;
      if (share >= 0.9999) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${COLOURS[i % COLOURS.length]}"/>`;
      const a0 = angle;
      const a1 = angle + share * 360;
      angle = a1;
      const pt = (a) => `${(cx + r * Math.cos((a * Math.PI) / 180)).toFixed(2)} ${(cy + r * Math.sin((a * Math.PI) / 180)).toFixed(2)}`;
      return `<path d="M ${cx} ${cy} L ${pt(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)} Z" fill="${COLOURS[i % COLOURS.length]}"/>`;
    }).join("");
    const legend = pts.map((p, i) => {
      const pc = Math.round((Math.abs(p.value) / total) * 100);
      return `<li><span class="chart-swatch" style="background:${COLOURS[i % COLOURS.length]}"></span><span class="chart-leg-label">${renderInline(p.label || "")}</span><span class="chart-leg-val">${renderInline(p.valueText)} · ${pc}%</span></li>`;
    }).join("");
    return `<div class="chart-pie"><svg viewBox="0 0 400 400" role="img" aria-label="Pie chart">${slices}</svg><ul class="chart-legend">${legend}</ul></div>`;
  }
  // line: build-time SVG polyline + dots, x labels beneath, y scaled to max, baseline rule.
  const max = Math.max(...pts.map((p) => p.value), 0) || 1;
  const min = Math.min(...pts.map((p) => p.value), 0);
  const span = max - min || 1;
  const X0 = 60, X1 = 940, Y0 = 60, Y1 = 360;
  const x = (i) => (pts.length === 1 ? (X0 + X1) / 2 : X0 + (i * (X1 - X0)) / (pts.length - 1));
  const y = (v) => Y1 - ((v - min) / span) * (Y1 - Y0);
  const linePts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const dots = pts.map((p, i) => `<circle class="chart-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="9"/><text class="chart-val-svg" x="${x(i).toFixed(1)}" y="${(y(p.value) - 22).toFixed(1)}" text-anchor="middle">${escapeHtml(p.valueText)}</text>`).join("");
  const labels = pts.map((p, i) => `<text class="chart-label-svg" x="${x(i).toFixed(1)}" y="404" text-anchor="middle">${escapeHtml(p.label || "")}</text>`).join("");
  return `<div class="chart-line"><svg viewBox="0 0 1000 430" role="img" aria-label="Line chart"><line class="chart-baseline" x1="${X0}" y1="${Y1}" x2="${X1}" y2="${Y1}"/><polyline class="chart-poly" points="${linePts}"/>${dots}${labels}</svg></div>`;
}

// === {chart} item parsing (layout batch 2, 2026-06-12) ===
// A chart point is one depth-0 list item in one of three authored shapes:
//   - a bare numeric item whose FIRST CHILD is the label (Dominik's outline shape);
//   - `label · 30` / `30 · label` — the side containing a digit is the value;
//   - `value label` / `label value` single-line (the parseStatItem grammar).
// The DISPLAY text stays AS AUTHORED ("2,000+" math-parses as 2000 but renders "2,000+").
// Items with no parseable number land in `unparsed` so flushSlide can warn
// (`chart-unparsed:<line>`) — never a silent skip.
export function parseChartItems(items, childTrees) {
  const kids = Array.isArray(childTrees) ? childTrees : [];
  const points = [];
  const unparsed = [];
  const numberOf = (s) => {
    const m = String(s).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  // A VALUE-shaped token starts with a digit (optionally signed/currency-prefixed): "80",
  // "2,000+", "£2m", "95%". "Q3" or "v2" merely CONTAIN digits — they are labels.
  const isValueish = (s) => /^[£$€+~-]?\d/.test(String(s).trim());
  (items || []).forEach((raw, i) => {
    const t = String(raw || "").trim();
    const childText = (Array.isArray(kids[i]) ? kids[i] : []).filter((c) => c && c.text).map((c) => c.text).join(" · ");
    // Separators (2026-06-12): the middot was untypeable — any space-surrounded dash family,
    // `=`, or `:` splits label/value too ("Writing the outline - 50", "Q3 = 31", "2024: 60").
    const sepMatch = t.match(/\s[·—–=:-]\s|:\s+/);
    if (sepMatch) {
      const left = t.slice(0, sepMatch.index).trim();
      const right = t.slice(sepMatch.index + sepMatch[0].length).trim();
      const leftValue = isValueish(left);
      const rightValue = isValueish(right);
      if (leftValue !== rightValue) {
        const valueSide = leftValue ? left : right;
        points.push({ value: numberOf(valueSide), valueText: valueSide, label: leftValue ? right : left });
        return;
      }
      // BOTH sides value-shaped (`2023 · 10` — a year label and its value, the canonical
      // line-chart shape): reading order wins, left = label, right = value. Neither → unparsed.
      if (leftValue && rightValue) {
        points.push({ value: numberOf(right), valueText: right, label: left });
        return;
      }
      unparsed.push(t);
      return;
    }
    if (/^\S+$/.test(t) && isValueish(t) && numberOf(t) != null) {
      points.push({ value: numberOf(t), valueText: t, label: childText });
      return;
    }
    const m = t.match(/^(\S+)\s+(.+)$/) || [];
    if (m.length) {
      const a = m[1].trim();
      const b = m[2].trim();
      if (isValueish(a) && !isValueish(b)) {
        points.push({ value: numberOf(a), valueText: a, label: b });
        return;
      }
      const tail = b.match(/^(.+?)\s+(\S+)$/);
      const lastTok = tail ? tail[2] : b;
      const head = tail ? `${a} ${tail[1]}` : a;
      if (!isValueish(a) && isValueish(lastTok) && /^\S+$/.test(lastTok)) {
        points.push({ value: numberOf(lastTok), valueText: lastTok, label: head });
        return;
      }
    }
    unparsed.push(t);
  });
  return { points, unparsed };
}

/**
 * Browser-safe adapter from the authored nested-list bytes stored by TalkWeaver to the exact
 * compiler chart-point parser above. The compiler already owns a richer Markdown lexer; this
 * deliberately mirrors only its unordered/ordered list marker and indentation grammar so the
 * renderer can use the same point semantics without importing Node-only compiler modules.
 */
export function parseChartListSource(source) {
  const roots = [];
  const stack = [];
  const invalidLines = [];
  String(source).replace(/\r/g, "").split("\n").forEach((line) => {
    if (!line.trim()) return;
    const match = /^(\s*)(?:[-*]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (!match) {
      invalidLines.push(line);
      return;
    }
    const indent = match[1].replace(/\t/g, "  ").length;
    const node = { text: match[2].trim(), children: [] };
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  });
  const parsed = parseChartItems(
    roots.map((node) => node.text),
    roots.map((node) => node.children)
  );
  return { ...parsed, invalidLines };
}
