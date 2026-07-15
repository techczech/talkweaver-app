import { parseHeadingAttrs, parseTriggerLine } from "./02-triggers-layout.mjs";

// =============================================================================
// 14. Outline → tree parser — every heading is a node (heading-slide-model, Task 1)
// =============================================================================
//
// Pure structural parse: `##`–`######` headings become a tree of Nodes; no roles, no
// layouts, no carousel arrays are decided here (that is later tasks' job — this module only
// answers "what is nested under what, and what raw lines/attrs does each node own").
//
// Reuses (does not reimplement):
//   - parseHeadingAttrs (02-triggers-layout.mjs) for heading-attr resolution (`{…}` trailer →
//     title + attrs + warnings) — same resolver the compiler's slide scanner uses.
//   - parseTriggerLine (02-triggers-layout.mjs) for the ADR-0015 Trigger line (a body line that
//     is ONLY `{…}` groups) right after a heading.
//   - The length-aware code-fence guard, copied verbatim (adjusted variable names only) from
//     08-source-adapters.mjs:1168-1189 — a closing fence must be a backticks-only line at least
//     as long as the opener, so a nested fence (e.g. inside a ```md wrapper) never closes early.

// Fold a heading's attr-resolver warnings into the deck-level warnings list, mirroring the
// non-exported `parseHeading` helper in 08-source-adapters.mjs (built from the same
// parseHeadingAttrs call) — every heading goes through this so a bad bare word is never
// silently dropped (ADR-0004).
function parseHeadingWithWarnings(raw, warnings) {
  const parsed = parseHeadingAttrs(raw);
  for (const w of parsed.warnings || []) warnings.push(w);
  return parsed;
}

function makeNode(level, title, attrs, sourceLine, headingLine) {
  return {
    level,
    title,
    attrs,
    id: typeof attrs.id === "string" ? attrs.id : "",
    contentLines: [],
    notesLines: [],
    children: [],
    sourceLine,
    headingLine,
    triggerLine: ""
  };
}

// ADR-0015 — Trigger line lookahead. From a heading at line `headingIdx`, the first NON-BLANK
// following line is the heading's Trigger line iff it consists only of `{…}` groups. Blank
// lines between heading and Trigger line are tolerated; a fence opener is never a Trigger line
// (matches 08-source-adapters.mjs's triggerLineAfter). Returns { attrs, warnings, index } or
// null.
function triggerLineAfter(lines, headingIdx) {
  let j = headingIdx + 1;
  while (j < lines.length && !lines[j].trim()) j += 1;
  if (j >= lines.length || /^`{3,}/.test(lines[j].trim())) return null;
  const parsed = parseTriggerLine(lines[j]);
  return parsed ? { ...parsed, index: j } : null;
}

// parseOutlineTree(text) → { meta: {rawFrontmatter, title}, root, warnings }
//
// `root` is a synthetic level-0 Node holding any preamble content before the first heading.
// A single `#` line sets meta.title and is never a child node. Every `##`–`######` heading
// opens a Node; nesting is by heading depth (a level-n heading closes all open nodes of level
// >= n). A skipped level (e.g. `####` directly under `##`) still nests as a direct child —
// depth is relative, gaps are tolerated — but emits `heading-level-gap:<line>` (1-indexed).
// The gap check only applies between real heading nodes (level >= 2): the root → first `##`
// step is never a gap, since level 1 (`#`) is reserved for the deck title, not a node level.
export function parseOutlineTree(text) {
  const warnings = [];
  const raw = String(text ?? "");

  // Same frontmatter-fence convention as parseMarkdownSource in 08-source-adapters.mjs: a
  // leading `---` block, closed by the next `\n---`. Kept raw (unparsed) — later tasks decide
  // what to do with the YAML; this module only needs it out of the heading scan.
  let rawFrontmatter = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end >= 0) {
      rawFrontmatter = raw.slice(3, end).trim();
      body = raw.slice(end + 4).replace(/^\r?\n/, "");
    }
  }
  const lines = body.split(/\r?\n/);

  const root = makeNode(0, "", {}, 0, "");
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const consumedTriggerLines = new Set();

  let deckTitle = "";
  let inNotes = false;
  let inFence = false;
  let fenceMark = "";

  const pushLine = (line) => {
    if (inNotes) top().notesLines.push(line);
    else top().contentLines.push(line);
  };

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const t = line.trim();
    let m;

    // Fence guard (LENGTH-AWARE, copied from 08-source-adapters.mjs:1168-1189): while inside a
    // fence EVERY line goes to the current node's body untouched — never matched as a heading
    // or a :::notes marker — so `#`/`##` lines in code/trace blocks stay out of the scanner. A
    // closing fence must be a backticks-only line at least as long as the opener.
    if (inFence) {
      pushLine(line);
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) {
      pushLine(line);
      inFence = true; fenceMark = open[1];
      continue;
    }

    // A consumed Trigger line is folded into its heading's attrs and excluded entirely — never
    // content, never a notes line.
    if (consumedTriggerLines.has(li)) continue;

    // Single `#` — deck title; never a node.
    if ((m = line.match(/^#\s+(.+)/)) && !line.startsWith("##")) {
      deckTitle = parseHeadingWithWarnings(m[1], warnings).title;
      continue;
    }

    // `##`–`######` — opens a Node. A new heading implicitly closes an unterminated
    // `:::notes` block (same reset as the reference scan loop's `##`/`###` handlers in
    // 08-source-adapters.mjs) — otherwise the new node's body would leak into notesLines.
    if ((m = line.match(/^(#{2,6})\s+(.+)/))) {
      inNotes = false;
      const level = m[1].length;
      while (stack.length > 1 && top().level >= level) stack.pop();
      const parent = top();
      if (parent.level !== 0 && level - parent.level > 1) {
        warnings.push(`heading-level-gap:${li + 1}`);
      }
      const parsed = parseHeadingWithWarnings(m[2], warnings);
      const node = makeNode(level, parsed.title, parsed.attrs, li + 1, line);
      parent.children.push(node);
      stack.push(node);

      const tl = triggerLineAfter(lines, li);
      if (tl) {
        consumedTriggerLines.add(tl.index);
        for (const w of tl.warnings || []) warnings.push(w);
        Object.assign(node.attrs, tl.attrs);
        node.triggerLine = lines[tl.index];
        // {id=…} may ride the Trigger line instead of the heading — Node.id is the token's
        // value wherever it sits (string values only; a bare {id} boolean never counts),
        // matching extractIdSlides in 13-slide-ledger.mjs.
        node.id = (typeof node.attrs.id === "string" ? node.attrs.id : "") || node.id || "";
      }
      continue;
    }

    // `:::notes` / `:::` fences route subsequent lines to notesLines instead of contentLines
    // (same as the compiler's scan loop); the markers themselves are structural, not content.
    if (t.toLowerCase() === ":::notes") { inNotes = true; continue; }
    if (t === ":::" && inNotes) { inNotes = false; continue; }

    pushLine(line);
  }

  return { meta: { rawFrontmatter, title: deckTitle }, root, warnings };
}
