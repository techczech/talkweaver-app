// THE slide-id resolver (architecture ruling, 2026-09-30). A slide's id is the LAST id in its
// Trigger block: the heading's own `{id=…}` wins outright; otherwise the id-bearing line nearest the
// end of the heading's pre-content window (the heading, then blank, Trigger-only or still-being-typed
// `{…` lines up to the first content line). On that line the first `{id=…}` token counts, exactly as
// the slide ledger has always read it.
//
// Why the last: a commit path that inserts a fresh Trigger line under the heading pushes the original
// Trigger line down, so the last id is the original one, the id history and recordings are keyed to.
//
// Invariant: every reader and writer resolves a slide's id here — the ledger (13-slide-ledger.mjs),
// the tree parser (14-outline-tree.mjs, and through it readOutlineSlides/findSlide), the layout verbs
// and both Trigger-block merge writers (trigger-line.ts, 12-outline-edit.mjs) — and a merge never
// changes the id this resolved for the slide before the merge. Pure: no fs, safe in the renderer.

export const ID_TOKEN_RE = /\{id=([A-Za-z0-9_-]+)\}/;
const ID_TOKEN_GLOBAL_RE = /\{id=([A-Za-z0-9_-]+)\}/g;

// A line that is ONLY `{…}` groups — the ADR-0015 Trigger line shape.
export const TRIGGER_ONLY_RE = /^\s*(\{[^}]*\}\s*)+$/;

// Edit-tolerant pre-content window. While a Trigger is being typed, a brace-leading line may be
// incomplete and therefore fail TRIGGER_ONLY_RE. It still belongs to the heading prelude until the
// first real content line (non-blank, non-Trigger-only, non-brace-leading).
export function preContentWindow(lines, headingIdx, endIdx = lines.length) {
  let end = headingIdx + 1;
  while (end < endIdx) {
    const trimmed = lines[end].trim();
    if (trimmed !== "" && !TRIGGER_ONLY_RE.test(trimmed) && !trimmed.startsWith("{")) break;
    end += 1;
  }
  return { start: headingIdx, end };
}

// Index of the line carrying this block's id — the heading itself, else the LAST id-bearing line of
// its pre-content window — or -1 when the block is unstamped.
export function idLineIndex(lines, headingIdx, endIdx = lines.length) {
  if (ID_TOKEN_RE.test(lines[headingIdx])) return headingIdx;
  const window = preContentWindow(lines, headingIdx, endIdx);
  for (let line = window.end - 1; line > headingIdx; line -= 1) {
    if (ID_TOKEN_RE.test(lines[line])) return line;
  }
  return -1;
}

// The slide's resolved id and the line it sits on, or null when unstamped.
export function resolveSlideId(lines, headingIdx, endIdx = lines.length) {
  const line = idLineIndex(lines, headingIdx, endIdx);
  if (line < 0) return null;
  return { id: lines[line].match(ID_TOKEN_RE)[1], line };
}

// Every `{id=…}` in the heading and its pre-content window, in reading order (with its line).
export function slideIdsInPrelude(lines, headingIdx, endIdx = lines.length) {
  const { end } = preContentWindow(lines, headingIdx, endIdx);
  const out = [];
  for (let line = headingIdx; line < end; line += 1) {
    for (const m of String(lines[line]).matchAll(ID_TOKEN_GLOBAL_RE)) out.push({ id: m[1], line });
  }
  return out;
}

// Which id tokens of a Trigger block a merge keeps. `tokens` are the block's raw token bodies in reading
// order (`id=a1`, `cards`, …); `resolved` is resolveSlideId() for the slide before the merge, and
// `headingIdx` its heading line. Keeps at most one id token and drops every other:
//   - the resolved id sits on the heading (or on a later prelude line outside this block) → no block
//     id is kept: the slide's id is elsewhere and stays there;
//   - the resolved id sits in the block → its token is kept (the first on the resolved line, as the
//     ledger reads it; the same id repeated is the same identity);
//   - no ledger-visible id (e.g. an `id=` inside a many-token group) → the last id token is kept, as
//     before this ruling, so nothing the author wrote as an id is lost.
// Returns { keep: Set<index>, kept: id | '', dropped: id[] } (dropped: distinct ids, reading order).
export function idTokensToKeep(tokens, resolved, headingIdx = -1) {
  const idAt = [];
  tokens.forEach((token, index) => {
    const m = /^id=([A-Za-z0-9_-]+)$/.exec(String(token).trim());
    if (m) idAt.push({ index, id: m[1] });
  });
  const keep = new Set();
  const dropped = [];
  let keeper;
  let kept = "";
  if (resolved) {
    // On the heading, or on a Trigger-only line further down the prelude than this block: the block's
    // own ids are not the slide's, and all go.
    keeper = resolved.line === headingIdx ? undefined : idAt.find((entry) => entry.id === resolved.id);
    kept = resolved.id;
  } else {
    keeper = idAt.at(-1);
    kept = keeper?.id ?? "";
  }
  if (keeper) keep.add(keeper.index);
  for (const entry of idAt) {
    if (entry === keeper || entry.id === kept) continue;
    if (!dropped.includes(entry.id)) dropped.push(entry.id);
  }
  return { keep, kept, dropped };
}

// The heading's visible title: `#`s and trailing `{…}` groups off.
export function headingTitle(line) {
  return String(line ?? "")
    .replace(/\r$/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/(?:\s*\{[^}]*\})+\s*$/, "")
    .trim();
}

// The warning-register code for ids a merge (or a read) set aside:
// `duplicate-slide-id-merged:kept a2, dropped a1 (Heading)` (warning-registry.mjs formats it).
export function duplicateIdWarning(kept, dropped, headingLine) {
  const title = headingTitle(headingLine);
  return `duplicate-slide-id-merged:kept ${kept}, dropped ${dropped.join(", ")}${title ? ` (${title})` : ""}`;
}
