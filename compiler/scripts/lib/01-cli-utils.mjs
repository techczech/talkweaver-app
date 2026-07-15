import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// 1. CLI utils + offline QR encoder — arg parsing, slugify, shared QR source (build-time + injected runtime)
// =============================================================================

export const args = process.argv.slice(2);
export const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function usage() {
  console.error(`Usage: node scripts/generate-presentation-bundle.mjs <source.html> <target-dir> [options]

Options:
  --title <title>                 Override presentation title.
  --slug <slug>                   Override folder/URL slug.
  --hosting-policy <policy>       local-only or cloudflare-candidate. Default: local-only.
  --notes-policy <policy>         private or public. Default: private.
  --embed-source                  Embed the outline behind "View source" in the full HTML
                                  (demo/showcase decks only — the source carries speaker notes).
  --notes-from-source             Put each slide's own Markdown into its speaker notes
                                  (demo/showcase decks only).
  --video-inline-limit <MB>       Local videos at/under this size are base64-inlined into the
                                  single-file outputs; larger ones stay app/full-only and the
                                  share exports show their poster/placeholder. Default: 10.
`);
  process.exit(2);
}

export function option(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "presentation";
}

// Balanced auto-layout for an item grid (grid / tiles / system-map satellites).
//
// Picks the number of COLUMNS for N items so the arrangement is even — never a lonely orphan
// (a final row holding a single item when there is more than one row), and as close to a square
// block as the count allows. Capped at `max` columns (default 4) so a long list still wraps to
// readable rows rather than one impossibly wide strip.
//
// Examples (max=4):  1→1  2→2  3→3  4→2 (2×2)  5→3 (3+2)  6→3 (3×3→ here 3×2)  7→4 (4+3)
//                    8→4 (4×4→4×2)  9→3 (3×3)  10→… (no lonely tail)
// The contract is the test surface: see scripts/test-feature-showcase.mjs.
export function chooseBalancedColumns(n, max = 4) {
  const count = Math.max(0, Math.floor(n));
  if (count <= 1) return Math.max(1, count);
  if (count <= max) {
    // A small set: a 2×2 reads better than a 4-wide strip; a perfect square wins.
    if (count === 4) return 2;
    return count;
  }
  // Score every column count in [2,max]. Reject any that leaves a LONELY orphan (rows>1 and a
  // single item in the final row). Among the rest prefer, in order:
  //   1. a FULL rectangle (no partial last row, remainder===0) — the cleanest block;
  //   2. the MOST SQUARE shape (smallest gap between column and row counts);
  //   3. fewer rows, then more columns (a wider, shorter block).
  // So 4→2 (2×2), 6→3 (3×2), 8→4 (4×2), 9→3 (3×3) come out as full rectangles, while 5→3 (3+2)
  // and 7→4 (4+3) take the squarest non-orphaning partial layout.
  let best = null;
  for (let cols = 2; cols <= max; cols += 1) {
    const rows = Math.ceil(count / cols);
    const remainder = count % cols;
    if (rows > 1 && remainder === 1) continue; // lonely orphan — skip
    if (rows > cols + 1) continue; // too tall/narrow a strip (e.g. 10 as 2×5) — skip if a wider one exists
    const cand = { cols, rows, full: remainder === 0, squareGap: Math.abs(cols - rows) };
    const better =
      !best ||
      (cand.full && !best.full) ||
      (cand.full === best.full && cand.squareGap < best.squareGap) ||
      (cand.full === best.full && cand.squareGap === best.squareGap && cand.rows < best.rows) ||
      (cand.full === best.full && cand.squareGap === best.squareGap && cand.rows === best.rows && cand.cols > best.cols);
    if (better) best = cand;
  }
  // Fallback: nothing avoided an orphan within [2,max] (only possible at very small max); take the
  // widest row so the tail is least ragged.
  return best ? best.cols : Math.min(max, count);
}

// Parse an explicit `{blocks:RxC}` grid dimension (rows × cols) the author sets on a grid/tiles
// heading. Tolerant of the `x` separator in lower/upper case and the unicode `×`, plus surrounding
// whitespace; both numbers must be ≥1. Returns { rows, cols } or null when it does not parse (the
// caller then falls back to the auto-balanced column count). The contract is the test surface.
export function parseGridDims(value) {
  if (value == null || value === true) return null;
  const m = String(value).trim().match(/^(\d+)\s*[x×X]\s*(\d+)$/);
  if (!m) return null;
  const rows = parseInt(m[1], 10);
  const cols = parseInt(m[2], 10);
  if (!(rows >= 1) || !(cols >= 1)) return null;
  return { rows, cols };
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// QR code generator — SINGLE SOURCE OF TRUTH for both build-time and runtime QR.
//
// The algorithm (Version-4, byte mode, EC level L, mask 0 — capacity 78 UTF-8 bytes) is a pure
// function of its input text: no DOM, no network, only `TextEncoder` (present in Node and the
// browser). It is authored ONCE here as a string and used two ways:
//   1) BUILD TIME — `makeQrSvg(text, { label })` (built from this source via `new Function`)
//      encodes a `[QR: url]` directive's URL into an inline SVG at generation time.
//   2) RUNTIME — the local-launch tools panel injects this same source into its inline <script>
//      (so the presenter's CURRENT local URL — unknown at build time — is encoded live).
// Reusing one source keeps the two encoders bit-for-bit identical and adds no dependency.
//
// `aria` is interpolated into the SVG's aria-label so each call site can describe its own code.
// The vendored, battle-tested encoder (qrcode-generator v1.4.4) — the previous home-grown
// implementation produced codes that phone scanners could not decode (2026-06-10 incident).
// Shared bit-for-bit between build time and the injected runtime, as before. The vendor
// source is concatenated as a VALUE (never re-quoted), so its content needs no escaping.
const QRCODE_VENDOR_SOURCE = readFileSync(join(scriptDir, "..", "assets", "vendor", "qrcode-generator.js"), "utf8");
// Pure presenter timer core (fmtClock / bigTimerState). Injected verbatim into the presenter
// template at build time via the `<!--TIMER_RUNTIME-->` placeholder — SINGLE SOURCE OF TRUTH,
// also loaded directly by scripts/test-timers.mjs. No `export` in the file so it inlines cleanly.
export const timerRuntimeSource = readFileSync(join(scriptDir, "..", "assets", "runtime", "timer.js"), "utf8");
// Shared overview runtime (rankSlides / deriveSlideStatus / createOverview). Injected verbatim into
// the presenter template AND the handout via the `<!--OVERVIEW_RUNTIME-->` placeholder — SINGLE
// SOURCE OF TRUTH, also loaded directly by scripts/test-overview.mjs. No `export` so it inlines cleanly.
export const overviewRuntimeSource = readFileSync(join(scriptDir, "..", "assets", "runtime", "overview.js"), "utf8");
// Vendored markmap runtime for the {mindmap} layout (ADR-0005: "Mindmaps are rendered by markmap …
// never hand-positioned"). Three minified browser builds, concatenated as VALUES (never re-quoted)
// into ONE <script> that runs at document top-level so each vendor IIFE sees `this === window`:
//   d3@7.9.0 (UMD → window.d3) · markmap-view@0.18.12 (this.markmap.{Markmap,deriveOptions}, needs d3)
//   · markmap-lib@0.18.12 (this.markmap.Transformer, katex optional).
// Load order matters: d3 → view (consumes d3) → lib. Both markmap builds MERGE into `this.markmap`
// (`this.markmap = this.markmap || {}`), so Transformer and Markmap coexist on one global. No CDN —
// the deck stays a self-contained single HTML file. Injected via the `<!--MARKMAP_VENDOR-->`
// placeholder in the presenter template and inlined verbatim into the share/export runtime.
const MARKMAP_VENDOR_DIR = join(scriptDir, "..", "assets", "vendor", "markmap");
export const markmapVendorSource = [
  "<script>/* BEGIN VENDOR markmap (d3@7.9.0 + markmap-view@0.18.12 + markmap-lib@0.18.12, minified) */",
  "/* --- BEGIN VENDOR d3@7.9.0 --- */",
  readFileSync(join(MARKMAP_VENDOR_DIR, "d3.min.js"), "utf8"),
  "/* --- END VENDOR d3 --- */",
  "/* --- BEGIN VENDOR markmap-view@0.18.12 --- */",
  readFileSync(join(MARKMAP_VENDOR_DIR, "markmap-view.min.js"), "utf8"),
  "/* --- END VENDOR markmap-view --- */",
  "/* --- BEGIN VENDOR markmap-lib@0.18.12 --- */",
  readFileSync(join(MARKMAP_VENDOR_DIR, "markmap-lib.min.js"), "utf8"),
  "/* --- END VENDOR markmap-lib --- */",
  "/* END VENDOR markmap */</script>",
].join("\n");
export function qrGeneratorSource(ariaExpr) {
  return "\n  const qrcode = (() => {\n    const module = { exports: {} };\n    (function (module, exports) {\n"
    + QRCODE_VENDOR_SOURCE
    + "\n    })(module, module.exports);\n    return typeof module.exports === \"function\" ? module.exports : module.exports.qrcode;\n  })();\n"
    + "  function makeQrSvg(text) {\n"
    + "    let qr;\n"
    + "    try {\n"
    + "      qr = qrcode(0, \"M\");\n"
    + "      qr.addData(String(text));\n"
    + "      qr.make();\n"
    + "    } catch (e) { if (typeof console !== \"undefined\") console.error(\"QR-FAIL:\", e && e.message); return null; }\n"
    + "    const count = qr.getModuleCount();\n"
    + "    const view = count + 8;\n"
    + "    const rects = [];\n"
    + "    for (let row = 0; row < count; row += 1) {\n"
    + "      for (let column = 0; column < count; column += 1) {\n"
    + "        if (qr.isDark(row, column)) rects.push('<rect x=\"' + (column + 4) + '\" y=\"' + (row + 4) + '\" width=\"1\" height=\"1\"/>');\n"
    + "      }\n"
    + "    }\n"
    + "    return '<svg viewBox=\"0 0 ' + view + ' ' + view + '\" role=\"img\" aria-label=\"' + (" + ariaExpr + ") + '\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"' + view + '\" height=\"' + view + '\" fill=\"#fff\"/><g fill=\"#17202a\">' + rects.join(\"\") + '</g></svg>';\n"
    + "  }";
}

// Build-time QR encoder. Returns an inline SVG string, or null when the URL exceeds the
// Version-4 byte-mode capacity (78 UTF-8 bytes). The aria-label is fixed at build time.
const buildTimeMakeQrSvg = new Function(
  "text",
  `${qrGeneratorSource(JSON.stringify("QR code"))}\n  return makeQrSvg(text);`
);
export function makeQrSvg(text) {
  return buildTimeMakeQrSvg(String(text == null ? "" : text));
}

// QR caption URL cleaning (refinement 6, 2026-06-09). The QR slide shows the linked URL in small
// type beneath the code, CLEANED for reading: strip the scheme (`http://`, `https://`, also
// scheme-relative `//`) and a leading `www.`, and drop a trailing slash. If the cleaned string is
// longer than `maxLen`, truncate and append an ellipsis `…` (the ellipsis counts toward maxLen, so
// the result never exceeds maxLen). A non-URL caption (an author-supplied label) is returned as-is
// apart from the same length cap — labels read cleaner short too. Pure + deterministic.
export const QR_URL_MAX_LEN = 42;
export function cleanQrUrl(raw, maxLen = QR_URL_MAX_LEN) {
  let s = String(raw == null ? "" : raw).trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme://
  s = s.replace(/^\/\//, "");                    // strip scheme-relative //
  s = s.replace(/^www\./i, "");                  // strip leading www.
  s = s.replace(/\/+$/, "");                     // drop trailing slash(es)
  if (maxLen > 0 && s.length > maxLen) {
    s = s.slice(0, Math.max(0, maxLen - 1)).replace(/\s+$/, "") + "…";
  }
  return s;
}

