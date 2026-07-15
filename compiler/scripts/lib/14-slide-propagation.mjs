// Slide propagation engine (ADR-0032): where-used status, human-readable line
// diff, and the loss-proof adoptVersion. Plain Node — no Electron — so
// scripts/test-propagation.mjs exercises it directly; Task 3's IPC layer is a
// thin wrapper. Depends on 13-slide-ledger only (never 12-outline-edit: block
// location comes from extractIdSlides, which already handles ids on the
// heading or Trigger line).
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  extractIdSlides, normalizeDepth, listVersions,
  recordOutlineSave, sealSlideHead, whereUsed, ID_TOKEN_RE, idLineIndex,
} from "./13-slide-ledger.mjs";

const HEADING_RE = /^(#{1,6})\s/;

// Comparison canon — MUST be exactly the rule recordOutlineSave stores with,
// or status judgements would disagree with the ledger byte-for-byte.
const canon = (md) => normalizeDepth(md).replace(/\n+$/, "");

// Local copy of 13's writeFileAtomic (not exported there): temp + rename so a
// crash mid-write can never leave a truncated outline behind.
function writeFileAtomic(path, data) {
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort: never strand a .tmp next to the outline on failure.
    try { unlinkSync(tmp); } catch { /* tmp may not exist; original error wins */ }
    throw err;
  }
}

// Local copy of 13's per-line fence + comment flags (not exported there):
// length-aware ``` fences, HTML-comment state machine. Needed so re-depthing
// and deep-block location never mistake fenced/commented `#` lines for headings.
function fencedLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceMark = "";
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const visibleAtStart = !inComment;
    if (!inFence) {
      let pos = 0;
      for (;;) {
        if (inComment) {
          const close = line.indexOf("-->", pos);
          if (close === -1) break;
          inComment = false;
          pos = close + 3;
        } else {
          const open = line.indexOf("<!--", pos);
          if (open === -1) break;
          inComment = true;
          pos = open + 4;
        }
      }
    }
    if (!visibleAtStart) { flags[i] = true; continue; }
    if (inFence) {
      flags[i] = true;
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) { inFence = true; fenceMark = open[1]; flags[i] = true; }
  }
  return flags;
}

// Shift a block so its root heading sits at `targetDepth` — same delta logic
// as 13's normalizeDepth (which is fixed at depth 3); fenced lines are opaque.
function redepthTo(markdown, targetDepth) {
  const lines = String(markdown).split("\n");
  const fenced = fencedLineFlags(lines);
  const root = fenced[0] ? null : lines[0]?.match(HEADING_RE);
  if (!root) return markdown;
  const delta = targetDepth - root[1].length;
  if (delta === 0) return markdown;
  return lines
    .map((l, i) => {
      const h = fenced[i] ? null : l.match(HEADING_RE);
      if (!h) return l;
      const depth = Math.min(6, Math.max(1, h[1].length + delta));
      return "#".repeat(depth) + l.slice(h[1].length);
    })
    .join("\n");
}

// Locate the id's block as line range [start, bodyEnd) — bodyEnd excludes the
// trailing blank lines that separate it from the next block, so a splice
// leaves every byte outside the block (including that separation) untouched.
function locateBlock(lines, id) {
  // Canonical path: extractIdSlides (### blocks, comment/fence-safe).
  const text = lines.join("\n");
  const hit = extractIdSlides(text).find((s) => s.id === id);
  if (hit) {
    const heading = lines[hit.headingLine]?.match(HEADING_RE);
    return {
      start: hit.headingLine,
      bodyEnd: hit.headingLine + hit.markdown.split("\n").length,
      depth: heading ? heading[1].length : 3,
    };
  }
  // Fallback: a block whose root heading sits deeper than ### (re-indented
  // placement, ADR-0033 readiness) is invisible to extractIdSlides; scan for
  // any deeper heading carrying the id on itself or its Trigger line.
  const fenced = fencedLineFlags(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const m = fenced[i] ? null : lines[i].match(HEADING_RE);
    if (!m || m[1].length < 3) continue;
    const depth = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const h = fenced[j] ? null : lines[j].match(HEADING_RE);
      if (h && h[1].length <= depth) { end = j; break; }
    }
    // Shared blank-tolerant read (idLineIndex, id-churn hotfix 2026-07-10): the id sits on the
    // heading or its (possibly blank-separated) Trigger line, bounded to [i, end). A heading line
    // is never `{…}`-only, so an adjacent stamped heading can never be misread as this block's
    // Trigger line — the rule subsumes the old nextIsHeading guard.
    const idIdx = idLineIndex(lines, i, end);
    const idMatch = idIdx >= 0 ? lines[idIdx].match(ID_TOKEN_RE) : null;
    if (idMatch && idMatch[1] === id) {
      let bodyEnd = end;
      while (bodyEnd > i + 1 && lines[bodyEnd - 1] === "") bodyEnd -= 1;
      return { start: i, bodyEnd, depth };
    }
  }
  return null;
}

// Pure text op: replace the {id=…} block for `id` inside outline text with
// versionMarkdown, re-depthed to the block's existing root depth. Byte-precise
// outside the block. Returns new text, or null when the id is not in the text.
export function replaceSlideBlock(text, id, versionMarkdown) {
  const lines = String(text).split("\n");
  const loc = locateBlock(lines, id);
  if (!loc) return null;
  const replacement = redepthTo(String(versionMarkdown), loc.depth)
    .replace(/\n+$/, "")
    .split("\n");
  return [...lines.slice(0, loc.start), ...replacement, ...lines.slice(loc.bodyEnd)].join("\n");
}

// One where-used row per outline carrying the id, judged against the ledger
// (ADR-0032): 'identical' to the version being adopted, 'behind' (matches an
// older recorded version), or 'diverged' (matches no recorded version).
export function slideStatus(vaultRoot, id, adoptMarkdown) {
  const adopt = canon(adoptMarkdown);
  const history = listVersions(vaultRoot, id).map((v) => v.markdown);
  const rows = [];
  for (const { talk, outline } of whereUsed(vaultRoot, id)) {
    const slide = extractIdSlides(readFileSync(join(vaultRoot, outline), "utf8"))
      .find((s) => s.id === id);
    if (!slide) continue; // outline changed between scan and read: skip
    const current = canon(slide.markdown);
    const status = current === adopt ? "identical"
      : history.includes(current) ? "behind"
      : "diverged";
    rows.push({ talk, outline, status, currentMarkdown: slide.markdown, headingLine: slide.headingLine });
  }
  return rows;
}

// Side-by-side line diff via classic LCS: [{ kind: 'same'|'del'|'add', text }].
// Slides are tiny, so O(n·m) table + backtrack is plenty (ADR-0032: human-read
// diff, no three-way merge).
export function lineDiff(a, b) {
  const A = String(a).split("\n");
  const B = String(b).split("\n");
  const n = A.length;
  const m = B.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ kind: "same", text: A[i] }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: "del", text: A[i] }); i += 1; }
    else { out.push({ kind: "add", text: B[j] }); j += 1; }
  }
  while (i < n) { out.push({ kind: "del", text: A[i] }); i += 1; }
  while (j < m) { out.push({ kind: "add", text: B[j] }); j += 1; }
  return out;
}

// The loss-proof adoption (ADR-0032). Per target, in this exact order:
//   1. pre-record the target's CURRENT content — versions any unsaved drift
//   2. sealSlideHead — closes the coalesce window, so a post-adoption record
//      can never coalesce over (and destroy) the content just replaced
//   3. replace the block, write the outline atomically
//   4. post-record — the adopted state becomes the (fresh, unsealed) head
// Per-target isolation: one failing target must not abort the rest.
// `targetOutlines` are vault-relative paths, as returned by whereUsed/slideStatus.
export function adoptVersion(vaultRoot, id, versionMarkdown, targetOutlines, { now = Date.now() } = {}) {
  const replaced = [];
  const failed = [];
  for (const outline of targetOutlines) {
    const talk = basename(outline).replace(/-outline\.md$/, "");
    try {
      const abs = join(vaultRoot, outline);
      const current = readFileSync(abs, "utf8");
      const pre = recordOutlineSave(vaultRoot, abs, current, { now });
      if (pre.collisions.includes(id)) {
        throw new Error(`duplicate {id=${id}} in ${outline}: current content cannot be versioned, not adopting`);
      }
      const next = replaceSlideBlock(current, id, versionMarkdown);
      if (next === null) throw new Error(`{id=${id}} not found in ${outline}`);
      sealSlideHead(vaultRoot, id, "replaced-by-adoption");
      writeFileAtomic(abs, next);
      recordOutlineSave(vaultRoot, abs, next, { now });
      replaced.push({ talk, outline });
    } catch (err) {
      failed.push({ talk, outline, error: String(err?.message ?? err) });
    }
  }
  return { replaced, failed };
}
