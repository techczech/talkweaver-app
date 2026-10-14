// =============================================================================
// The compiler's reading of an outline, for the verbs that write one token into it
// =============================================================================
//
// Moved out of 12-outline-edit.mjs unchanged (issue #120), so that the list-item icon verb
// (outline-list-item-icon.mjs) reads an outline exactly as setHeadingIcon and setParagraphIcon do.
// The contract these helpers serve is written above setHeadingIcon in 12-outline-edit.mjs: LOCATE
// on the compiler's own reading, SPLICE one line, VERIFY by compiling.

import { lexMarkdownBlocks } from "./03-markdown-lexer.mjs";
import { blankHtmlComments } from "./html-comments.mjs";
import { normalizeIconOverrideKey, titleIconOfNode } from "./05-icons.mjs";
import { parseOutlineTree, classifyContentLines } from "./14-outline-tree.mjs";
import { scanLines } from "./slide-blocks.mjs";

export const ICON_KEY_RE = /^[A-Za-z0-9:._-]+$/;

export function assertIconKey(iconKey) {
  if (iconKey == null) return;
  if (typeof iconKey !== "string" || !ICON_KEY_RE.test(iconKey)) {
    throw new Error(`outline-edit: not an icon key: ${JSON.stringify(iconKey)}`);
  }
}

// A line without its CRLF `\r` (scanLines splits on "\n" only), and the `\r` to put back.
export function splitCarriageReturn(line) {
  return line.endsWith("\r") ? { body: line.slice(0, -1), cr: "\r" } : { body: line, cr: "" };
}

// The outline as the compiler's v2 adapter hands it to parseOutlineTree: the front matter's and
// every HTML comment's characters removed, newlines kept, so a line index is still the true
// source line. `kept[i]` is the offset in `text` of the body's i-th character: blanking REMOVES
// characters, so an offset in a blanked line is mapped back to the source through it.
export function compilerBodyOf(text) {
  const source = String(text ?? "");
  let kept = Array.from({ length: source.length }, (_, i) => i);
  let body = source;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) {
      const fmEnd = end + 4;
      kept = kept.filter((i) => i >= fmEnd || source[i] === "\n");
      body = body.slice(0, fmEnd).replace(/[^\n]/g, "") + body.slice(fmEnd);
    }
  }
  const drop = new Set();
  for (const m of body.matchAll(/<!--[\s\S]*?-->/g)) {
    for (let i = 0; i < m[0].length; i += 1) if (m[0][i] !== "\n") drop.add(m.index + i);
  }
  if (drop.size) kept = kept.filter((_, i) => !drop.has(i));
  body = blankHtmlComments(body);
  return { body, kept };
}

// The compiler's reading of an outline: the source lines, the tree, and its slides (every heading
// node) in document order. For each source line, `offsets[line]` maps a character of the blanked
// line to its offset in the source line.
export function compileView(text) {
  const lines = scanLines(text);
  const { body, kept } = compilerBodyOf(text);
  if (body.length !== kept.length) return null;
  const tree = parseOutlineTree(body);
  const nodes = [];
  const walk = (node) => { for (const child of node.children) { nodes.push(child); walk(child); } };
  walk(tree.root);
  nodes.sort((a, b) => a.sourceLine - b.sourceLine);
  const offsets = lines.map(() => []);
  let line = 0;
  let lineStart = 0;
  for (let i = 0, k = 0; i < text.length; i += 1) {
    if (kept[k] === i) {
      if (text[i] !== "\n") offsets[line].push(i - lineStart);
      k += 1;
    }
    if (text[i] === "\n") { line += 1; lineStart = i + 1; }
  }
  const bodyLines = body.split("\n").map((entry) => entry.replace(/\r$/, ""));
  return { lines, bodyLines, offsets, tree, nodes };
}

// One slide as the compiler reads it: the lines the lexer sees (each with its 0-based source
// line), the lexer's blocks, and everything else of the slide a writer must leave alone.
export function readSlide(view, node) {
  const indexes = view.tree.contentLineIndexes.get(node) || [];
  const classified = classifyContentLines(node.contentLines);
  const lexed = classified.filter((entry) => !entry.stray).map((entry) => ({ line: entry.line, source: indexes[entry.index] }));
  return {
    lexed,
    blocks: lexMarkdownBlocks(lexed.map((entry) => entry.line)),
    title: node.title,
    titleIcon: titleIconOfNode(node),
    rest: JSON.stringify([
      Object.entries(node.attrs || {}).filter(([key]) => key !== "icon"),
      node.notesLines,
      classified.filter((entry) => entry.stray).map((entry) => entry.line),
      node.level, node.id, node.triggerLine
    ])
  };
}

export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const withoutIcon = (block) => { const { icon, ...rest } = block || {}; return rest; };
export const countIconBraces = (value) => (JSON.stringify(value).match(/\{\s*icon\s*=/gi) || []).length;

// Everything outside one slide, as the tree reads it: the other slides (heading, attrs, content,
// notes), the talk title and the lines before the first slide.
export function outsideOf(view, node) {
  return JSON.stringify([
    view.tree.meta.title, view.tree.deckTitleIcon, view.tree.root.contentLines, view.tree.root.notesLines,
    view.nodes.map((other) => (other === node
      ? [other.sourceLine, other.level]
      : [other.sourceLine, other.level, other.title, other.titleIcon || "", other.attrs, other.contentLines, other.notesLines]))
  ]);
}

// Apply an edit made on a BLANKED line to its source line. `deleted` is a set of character
// indexes and `inserted` a map (index → text put in before that character), both in the blanked
// line. Returns the new source line, or null when the edit would fall inside a comment.
export function applyLineEdit(source, blanked, offsets, { deleted, inserted }) {
  if (offsets.length < blanked.length) return null;
  const sourceDeleted = new Set();
  for (const i of deleted) sourceDeleted.add(offsets[i]);
  const sourceInserted = new Map();
  for (const [at, value] of inserted) {
    // After the character before it, so a token lands before a comment that follows the text.
    const position = at > 0 ? offsets[at - 1] + 1 : blanked.length ? offsets[0] : source.length;
    sourceInserted.set(position, value);
  }
  let out = "";
  for (let i = 0; i <= source.length; i += 1) {
    if (sourceInserted.has(i)) out += sourceInserted.get(i);
    if (i < source.length && !sourceDeleted.has(i)) out += source[i];
  }
  return out;
}

export const NO_EDIT = { deleted: new Set(), inserted: new Map() };

// The slide a ref names: { heading (the source line, without a CRLF `\r`), occurrence (1-based
// among identical heading lines) }. The renderer's buffer has LF endings, so a ref has no `\r`.
export function findNodeByRef(view, ref) {
  const occurrence = ref?.occurrence || 1;
  const want = String(ref?.heading ?? "").replace(/\r$/, "");
  let seen = 0;
  for (const node of view.nodes) {
    if (view.lines[node.sourceLine - 1].replace(/\r$/, "") !== want) continue;
    seen += 1;
    if (seen === occurrence) return node;
  }
  return null;
}

export function resolvedIconKey(iconKey) {
  return iconKey ? normalizeIconOverrideKey(iconKey) || "" : "";
}
