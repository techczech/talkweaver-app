import { chartObjectTokenAt, parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from "./03-object-token.mjs";
import { parseHeadingAttrs, parseTriggerLine } from "./02-triggers-layout.mjs";
import { TRIGGER_ONLY_RE, duplicateIdWarning, resolveSlideId, slideIdsInPrelude } from "./slide-id.mjs";

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
//   - Shared Markdown fence parsing (03-object-token.mjs), matching the content lexer for
//     both backticks and tildes, including marker character and opening length.

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

// The rest of the heading's Trigger block: the Trigger-only lines CONSECUTIVE with the Trigger line,
// stopping at the first blank or content line — the block the editor reads
// (logicalTriggerBlockAfterHeading, src/shared/trigger-line.ts). A commit path that inserted a fresh
// Trigger line under the heading leaves the original one right below it; both belong to the heading.
// A `{…}` line after a blank is content (a block-scoped `{chart=bar}`, a `{prework}` marker), never
// folded into the slide's attrs. One exception inside the run: a chart token that owns the list below
// it (chartObjectTokenAt) is a content object, as the lexer reads it — the Doctor reports the Trigger
// line's chart form as shadowed by it — so the block ends there.
function furtherTriggerLines(lines, firstIndex) {
  const out = [];
  for (let j = firstIndex + 1; j < lines.length; j += 1) {
    if (chartObjectTokenAt(lines, j)) break;
    const parsed = TRIGGER_ONLY_RE.test(lines[j].trim()) ? parseTriggerLine(lines[j]) : null;
    if (!parsed) break;
    out.push({ ...parsed, index: j });
  }
  return out;
}

// A line whose every `{…}` group is an `{id=…}` token — the one kind of line past the Trigger block
// the tree still treats as the heading's (the resolver may find the slide's id there).
const ID_ONLY_LINE_RE = /^\s*(\{id=[A-Za-z0-9_-]+\}\s*)+$/;

// parseOutlineTree(text) → { meta: {rawFrontmatter, title}, root, warnings, notesLineIndexes }
//
// `notesLineIndexes`: 0-based indexes (into the parsed body's lines) of every speaker-notes line
// this parse routed away from slide content — the `:::notes` / `:::` markers and every line
// between them (a notes block also ends at the next heading).
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
  let fenceOpening = null;
  const notesLineIndexes = [];
  let lineIndex = 0;

  const pushLine = (line) => {
    if (inNotes) { top().notesLines.push(line); notesLineIndexes.push(lineIndex); }
    else top().contentLines.push(line);
  };

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const t = line.trim();
    lineIndex = li;
    let m;

    // Fence guard: while inside a
    // fence EVERY line goes to the current node's body untouched — never matched as a heading
    // or a :::notes marker — so `#`/`##` lines in code/trace blocks stay out of the scanner. A
    // closing fence must use the same marker character and be at least as long as the opener.
    if (fenceOpening) {
      pushLine(line);
      if (isMarkdownFenceClosingLine(line, fenceOpening)) fenceOpening = null;
      continue;
    }
    const open = parseMarkdownFenceOpeningLine(line);
    if (open) {
      pushLine(line);
      fenceOpening = open;
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
        for (const part of [tl, ...furtherTriggerLines(lines, tl.index)]) {
          consumedTriggerLines.add(part.index);
          for (const w of part.warnings || []) warnings.push(w);
          Object.assign(node.attrs, part.attrs);
        }
        node.triggerLine = lines[tl.index];
      }
      // One id per slide, resolved as every reader and writer resolves it (slide-id.mjs): the
      // heading's own id, else the LAST id-bearing line of its pre-content window — which may lie
      // past a blank line, beyond the Trigger block. Such a line is the heading's only when it is
      // id-only: it is then set aside like a Trigger line; any other `{…}` line past the block stays
      // content, its tokens never folded into the slide's attrs. Several ids: the others are
      // reported through the warning register, never silently kept or silently lost. No
      // ledger-visible id (a bare `{id}`, an `id=` inside a many-token group): the folded attrs'
      // string id, as before the resolver.
      const resolved = resolveSlideId(lines, li);
      if (resolved) {
        node.id = resolved.id;
        node.attrs.id = resolved.id;
        if (resolved.line !== li && ID_ONLY_LINE_RE.test(lines[resolved.line])) consumedTriggerLines.add(resolved.line);
        const dropped = [...new Set(slideIdsInPrelude(lines, li).map((entry) => entry.id))]
          .filter((id) => id !== resolved.id);
        if (dropped.length) warnings.push(duplicateIdWarning(resolved.id, dropped, line));
      } else {
        node.id = typeof node.attrs.id === "string" ? node.attrs.id : "";
      }
      continue;
    }

    // `:::notes` / `:::` fences route subsequent lines to notesLines instead of contentLines
    // (same as the compiler's scan loop); the markers themselves are structural, not content.
    if (t.toLowerCase() === ":::notes") { inNotes = true; notesLineIndexes.push(li); continue; }
    if (t === ":::" && inNotes) { inNotes = false; notesLineIndexes.push(li); continue; }

    pushLine(line);
  }

  return { meta: { rawFrontmatter, title: deckTitle }, root, warnings, notesLineIndexes };
}
