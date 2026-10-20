// =============================================================================
// Per-item icon override (the icon picker's write): setListItemIcon
// =============================================================================
//
// Pins (or, with iconKey=null, clears) the icon on ONE top-level list item of a slide, by writing
// the `{icon=KEY}` token at the end of that item's line. A write path into the person's outline,
// under the contract written above setHeadingIcon in 12-outline-edit.mjs (issue #120: this verb
// used to find its line with a scan of its own, which also counted list-shaped lines in the front
// matter, in speaker notes and in fenced code, and could write there):
//
//   1. LOCATE on the compiler's own reading (outline-compiled-view.mjs). A slide is a heading node
//      of the outline tree; its list items are the top-level rows of the `list` blocks the lexer
//      makes of that slide's content lines (`itemRows`, 03-markdown-lexer-core.mjs). So a line in
//      the front matter, in an HTML comment, in `:::notes`, in a fence (code, a chart, a chat or
//      terminal simulation, raw HTML), a chart token's own rows, a timeline's rows, a row under
//      another row and a line before the first slide are never items: they are not counted and
//      cannot be addressed.
//   2. SPLICE one line. Only the token changes:
//        set      one space and `{icon=KEY}` go in after the last non-space character of the row;
//        replace  only the key's characters change (the short form `{name}` becomes `{icon=KEY}`
//                 inside its own braces); a row that already draws the icon asked for, however
//                 its token is written, is left as it is;
//        remove   the token goes, with the one space before it.
//      Everything else on the line (indentation, mark, text, other braces, trailing spaces, a CRLF
//      line's `\r`) and every other line stays byte for byte.
//   3. VERIFY by compiling, twice over.
//      a. The tree and the lexer. The outline is read again, and the edit goes on only when that
//         item, on the same source line, now reports exactly the requested icon (none after a
//         remove), and the slide's title, title icon, attributes, notes, every other block, every
//         other item and this item's text are identical, the visible text holds no new `{icon=`,
//         and every other slide is identical.
//      b. The FULL compiler (adaptMarkdownOutlineV2, the model the slides are rendered from). A
//         list row is not always a list item of the finished slide: under a chart, a timeline, a
//         pyramid, a table and other layouts the rows become that layout's own parts, and an icon
//         token on one draws nothing. So the whole talk is compiled before and after the edit, and
//         the edit is kept only when the two models differ in exactly this: an icon value that
//         stands beside this item's text (the item's place in a list's icons, or a card's icon)
//         was the item's icon before and is the requested one now (none after a remove). The only
//         other difference allowed is a copy of the outline's source that differs by the edited
//         line, whole. No layout is named here: what the model shows decides, with one exception.
//         A contrast block holds every row's icon by pair whether or not it is drawn, so a
//         contrast row's icon counts only where vs-panels.mjs (contrastRowDrawsIcon) says the
//         panels draw it; anywhere else the write is refused (`icon-not-drawn-here`). A write the
//         model does not show is refused (`icon-not-drawn-here`); so is a remove or a replace of a
//         token the model does not show.
//      Otherwise the verb REFUSES: the outline comes back unchanged.
//
// Addressing. `ref` names the slide and `item` the item:
//   ref   { heading, occurrence }  the verbatim heading line and its 1-based position among the
//                                  slides with that heading line (the tree's slides: a `###` line
//                                  in the front matter or in code is not one);
//         { id }                   the slide's id; { headingLine } the heading's 1-based line.
//         Several may be given; all must hold. With no `occurrence`, a ref that fits more than one
//         slide is refused (`slide-ambiguous`): the verb never picks one of two.
//   item  a number                 0-based position among the slide's items as read in 1;
//         { line }                 the item's 1-based source line (what the editor knows: its own
//                                  count of list lines is not the compiler's). The slide is then
//                                  the one that holds the line; `ref`, when given, must fit it
//                                  (`occurrence` is not read: the line already says which slide).
//
// Result: { ok: true, text, changed } (changed false: there was nothing to change), or
// { ok: false, text (the outline as given), reason }. Reasons:
//   slide-not-found     no slide fits `ref` (or the slide that holds the line does not);
//   slide-ambiguous     more than one slide fits `ref` and no `occurrence` says which;
//   not-a-list-item     the slide has no such item, or the line is not a top-level list item of a
//                       slide's content;
//   unknown-icon        the key names no icon the compiler can resolve, so it would draw nothing;
//   icon-set-elsewhere  after the edit the compiler still reports a different icon there;
//   icon-not-drawn-here the row is a list row, but the compiled talk is the same with and without
//                       the token: the slide's layout makes something else of its rows (a chart's
//                       points, a timeline's entries, a pyramid's levels, a table's cells). Also
//                       the answer when a row already carries a token for the icon asked for and
//                       the compiled talk does not show exactly that: this item's icon, none
//                       without the token and that icon with it (the same icon beside the same
//                       words elsewhere, in another list, slide or title, does not count);
//   cannot-place-here   anything else the check rejects, and a row that carries an HTML comment (a
//                       new token is not written beside a comment).
// A key that is not icon-shaped, and an `item` or `ref` of the wrong type, throw before any text
// is read.

import { listItemIconTokenSpanAt } from "./03-markdown-lexer-core.mjs";
import { normalizeIconOverrideKey } from "./05-icons.mjs";
import { adaptMarkdownOutlineV2 } from "./08-source-adapters.mjs";
import { contrastRowDrawsIcon } from "./vs-panels.mjs";
import {
  NO_EDIT, applyLineEdit, assertIconKey, compileView, countIconBraces, outsideOf, readSlide,
  resolvedIconKey, sameValue, splitCarriageReturn
} from "./outline-compiled-view.mjs";

// The top-level list items of one slide (readSlide's answer), in document order: for each, its
// block and position in that block, its line among the slide's lexed lines and in the source,
// where its text starts on the line, its text and its icon ("" when none).
export function slideListItems(slide) {
  const out = [];
  slide.blocks.forEach((block, blockIndex) => {
    if (block?.type !== "list") return;
    (block.itemRows || []).forEach((row, item) => {
      out.push({
        block: blockIndex, item, lexed: row.line, source: slide.lexed[row.line].source,
        textFrom: row.indentLength + row.markLength,
        text: block.items[item], icon: block.iconOverrides?.[item] || ""
      });
    });
  });
  return out;
}

const headingLineOf = (view, node) => view.lines[node.sourceLine - 1].replace(/\r$/, "");

// The parts of a ref that are given, checked for type.
function readRef(ref) {
  const given = {};
  if (ref == null) return given;
  if (typeof ref !== "object") throw new Error(`outline-edit: not a slide ref: ${JSON.stringify(ref)}`);
  if (ref.heading != null) given.heading = String(ref.heading).replace(/\r$/, "");
  if (ref.id != null && ref.id !== "") given.id = String(ref.id);
  if (ref.headingLine != null) {
    if (!Number.isInteger(ref.headingLine)) throw new Error(`outline-edit: headingLine is a 1-based line number, not ${JSON.stringify(ref.headingLine)}`);
    given.headingLine = ref.headingLine;
  }
  if (ref.occurrence != null) {
    if (!Number.isInteger(ref.occurrence) || ref.occurrence < 1) throw new Error(`outline-edit: occurrence is 1-based, not ${JSON.stringify(ref.occurrence)}`);
    given.occurrence = ref.occurrence;
  }
  return given;
}

const fits = (view, node, given) => (given.heading === undefined || headingLineOf(view, node) === given.heading)
  && (given.id === undefined || node.id === given.id)
  && (given.headingLine === undefined || node.sourceLine === given.headingLine);

// The one slide a ref names: { node } or { reason }.
function slideOfRef(view, given) {
  if (given.heading === undefined && given.id === undefined && given.headingLine === undefined) {
    throw new Error("outline-edit: a slide ref needs a heading, an id or a headingLine");
  }
  const found = view.nodes.filter((node) => fits(view, node, given));
  if (given.occurrence !== undefined) {
    return found[given.occurrence - 1] ? { node: found[given.occurrence - 1] } : { reason: "slide-not-found" };
  }
  if (!found.length) return { reason: "slide-not-found" };
  return found.length === 1 ? { node: found[0] } : { reason: "slide-ambiguous" };
}

// The edit that sets, replaces or removes the icon token at the end of a list row, on the row's
// (blanked) line, and the token the compiler reads there now (null when none). The row's text is
// read as the lexer reads it: from `textFrom`, trimmed.
function listItemIconEdit(blanked, textFrom, key, wanted) {
  const rest = blanked.slice(textFrom);
  const at = textFrom + (rest.length - rest.trimStart().length);
  const token = listItemIconTokenSpanAt(rest.trim(), normalizeIconOverrideKey);
  const deleted = new Set();
  const inserted = new Map();
  if (token) {
    if (key) {
      // The row already draws that icon, however its token is written: nothing is rewritten.
      if ((token.icon || "") === wanted) return { edit: NO_EDIT, token };
      for (let i = at + token.keyFrom; i < at + token.keyTo; i += 1) deleted.add(i);
      inserted.set(at + token.keyFrom, token.explicit ? key : `icon=${key}`);
    } else {
      // The one space before the token goes with it when it is the text's (not the mark's).
      const from = token.tokenFrom > 0 && blanked[at + token.tokenFrom - 1] === " " ? token.tokenFrom - 1 : token.tokenFrom;
      for (let i = at + from; i < at + token.tokenTo; i += 1) deleted.add(i);
    }
    return { edit: { deleted, inserted }, token };
  }
  if (!key) return { edit: NO_EDIT, token };
  inserted.set(blanked.replace(/\s+$/, "").length, ` {icon=${key}}`);
  return { edit: { deleted, inserted }, token };
}

// A list block without the icon of one of its items (every other item's icon kept, in place).
function withoutItemIcon(block, item) {
  const { iconOverrides, ...rest } = block || {};
  return { ...rest, icons: (block?.items || []).map((_, i) => (i === item ? null : iconOverrides?.[i] || null)) };
}

// The full compiler's model of an outline (the one the slides are rendered from), or null when it
// cannot be compiled.
function fullModelOf(text) {
  try { return adaptMarkdownOutlineV2(text, "outline"); } catch { return null; }
}

// Every place two compiled models differ, at the deepest value that differs: its two values and
// the chain of objects that hold it (`trail`: for each step the key and the two holders).
function modelDifferences(a, b, trail = [], out = []) {
  if (a === b) return out;
  const nested = a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b);
  if (!nested) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ a, b, trail: trail.slice() });
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    trail.push({ key, a, b });
    modelDifferences(a[key], b[key], trail, out);
    trail.pop();
  }
  return out;
}

const rtrim = (value) => String(value).replace(/\s+$/, "");

// Whether a difference is a copy of the outline's source that differs by the edited line, whole:
// a text (or one line of a list of lines) in which exactly one line changed, from the line as it
// was to the line as it is (as written, or as the compiler reads it with comments blanked).
function isSourceCopy(difference, linePairs) {
  if (typeof difference.a !== "string" || typeof difference.b !== "string") return false;
  const was = difference.a.split(/\r?\n/);
  const now = difference.b.split(/\r?\n/);
  if (was.length !== now.length) return false;
  const changed = was.flatMap((line, i) => (line === now[i] ? [] : [i]));
  if (changed.length !== 1) return false;
  const at = changed[0];
  return linePairs.some(([from, to]) => from !== to
    && (was[at] === from || rtrim(was[at]) === rtrim(from)) && (now[at] === to || rtrim(now[at]) === rtrim(to)));
}

// A difference read as the icon of one item: { was, now, drawn } (was and now "" for none), when
// the value that differs is an icon standing beside `text` in both models. Two shapes are read: one
// place in a list of icons whose holder has, in a list of the same place, that text (a list's item,
// or a contrast block's [left, right] pair whose non-empty sides joined with " / " are that text);
// and a value of an object that also holds that text (a card made of the item). null for anything
// else. `drawn` is false only for a contrast pair whose icon the slide does not draw (vs-panels.mjs
// contrastRowDrawsIcon: a contrast variant, the panel heads, an empty right side).
function itemIconChange(difference, text) {
  const { a, b, trail } = difference;
  const frame = trail[trail.length - 1];
  if (!frame) return null;
  const icon = (value) => (value == null ? "" : typeof value === "string" && value ? value : null);
  // true: the text stands at that place; "undrawn": a contrast pair there is that text, but its
  // icon is not drawn; false: neither.
  const besideAt = (holder, index) => {
    if (!holder || typeof holder !== "object") return false;
    if (Object.values(holder).some((value) => Array.isArray(value) && (value[index] === text || (value[index] && typeof value[index] === "object" && value[index].text === text)))) return true;
    const pair = holder.type === "contrast" && Array.isArray(holder.pairs) ? holder.pairs[index] : null;
    if (!Array.isArray(pair) || pair.filter(Boolean).join(" / ") !== text) return false;
    return contrastRowDrawsIcon(holder, index) ? true : "undrawn";
  };
  const beside = (holder) => !!holder && typeof holder === "object" && !Array.isArray(holder)
    && Object.values(holder).some((value) => value === text);
  // A whole list of icons that is there in one model only: all of it empty but one place.
  if ((a == null) !== (b == null) && Array.isArray(a ?? b)) {
    const list = a ?? b;
    const filled = list.flatMap((value, i) => (value == null ? [] : [i]));
    if (filled.length !== 1 || !icon(list[filled[0]])) return null;
    const holders = [besideAt(frame.a, filled[0]), besideAt(frame.b, filled[0])];
    if (!holders[0] || !holders[1]) return null;
    return { was: a ? list[filled[0]] : "", now: b ? list[filled[0]] : "", drawn: holders[0] === true && holders[1] === true };
  }
  if (icon(a) === null || icon(b) === null) return null;
  // One place in a list of icons.
  if (Array.isArray(frame.a) && Array.isArray(frame.b)) {
    const up = trail[trail.length - 2];
    const index = Number(frame.key);
    const holders = up && Number.isInteger(index) ? [besideAt(up.a, index), besideAt(up.b, index)] : [false, false];
    if (!holders[0] || !holders[1]) return null;
    return { was: icon(a), now: icon(b), drawn: holders[0] === true && holders[1] === true };
  }
  // The icon of an object that holds the item's text.
  if (!beside(frame.a) || !beside(frame.b)) return null;
  return { was: icon(a), now: icon(b), drawn: true };
}

// 3b. Whether the full compiler shows the edit as this item's icon and as nothing else: null when
// it does, else the reason to refuse.
function refusedByFullModel(source, result, target, wanted, linePairs) {
  const before = fullModelOf(source);
  const after = fullModelOf(result);
  if (!before || !after) return "cannot-place-here";
  const differences = modelDifferences(before, after).filter((entry) => !isSourceCopy(entry, linePairs));
  if (!differences.length) return "icon-not-drawn-here";
  let drawn = true;
  for (const entry of differences) {
    const change = itemIconChange(entry, target.text);
    if (!change || change.was !== target.icon || change.now !== wanted || change.was === change.now) return "cannot-place-here";
    if (!change.drawn) drawn = false;
  }
  // The model holds the token, but on a contrast row whose icon the slide does not draw.
  return drawn ? null : "icon-not-drawn-here";
}

export function setListItemIcon(text, ref, item, iconKey) {
  assertIconKey(iconKey);
  const byLine = item !== null && typeof item === "object";
  if (byLine ? !Number.isInteger(item.line) : !Number.isInteger(item) || item < 0) {
    throw new Error(`outline-edit: setListItemIcon takes a 0-based item number or { line } (1-based), not ${JSON.stringify(item)}`);
  }
  const given = readRef(ref);
  const source = String(text ?? "");
  const refuse = (reason) => ({ ok: false, text: source, reason });
  const key = iconKey || null;
  const wanted = resolvedIconKey(key);
  if (key && !wanted) return refuse("unknown-icon");
  const before = compileView(source);
  if (!before) return refuse("cannot-place-here");

  // 1. Locate.
  let node;
  if (byLine) {
    node = before.nodes.find((other) => (before.tree.contentLineIndexes.get(other) || []).includes(item.line - 1));
    if (!node) return refuse("not-a-list-item");
    if (!fits(before, node, given)) return refuse("slide-not-found");
  } else {
    const named = slideOfRef(before, given);
    if (!named.node) return refuse(named.reason);
    node = named.node;
  }
  const was = readSlide(before, node);
  const items = slideListItems(was);
  const position = byLine ? items.findIndex((entry) => entry.source === item.line - 1) : item;
  const target = items[position];
  if (!target) return refuse("not-a-list-item");

  // 2. Splice.
  const index = target.source;
  const { body, cr } = splitCarriageReturn(before.lines[index]);
  const blanked = was.lexed[target.lexed].line;
  const { edit, token } = listItemIconEdit(blanked, target.textFrom, key, wanted);
  if (edit === NO_EDIT) {
    if (target.icon !== wanted) return refuse(key ? "icon-set-elsewhere" : "cannot-place-here");
    if (!wanted) return { ok: true, text: source, changed: false };
    // "It already has that icon" is said only of THIS item, and only when the finished slide shows
    // it there. No search of the model for the item's words: the outline is compiled without this
    // row's token (the verb's own remove) and with it, and the answer is yes only when the two
    // models differ in exactly this item's icon, none without the token and the requested one
    // with it (the check a write goes through, 3b). Nothing is written either way.
    const removal = listItemIconEdit(blanked, target.textFrom, null, "");
    const bare = removal.edit === NO_EDIT ? null : applyLineEdit(body, blanked, before.offsets[index], removal.edit);
    if (bare === null) return refuse("icon-not-drawn-here");
    const bareLines = before.lines.slice();
    bareLines[index] = bare + cr;
    const without = bareLines.join("\n");
    const bareView = compileView(without);
    if (!bareView) return refuse("icon-not-drawn-here");
    const notShown = refusedByFullModel(without, source, { text: target.text, icon: "" }, wanted, [[bare, body], [bareView.bodyLines[index], before.bodyLines[index]]]);
    if (notShown) return refuse("icon-not-drawn-here");
    return { ok: true, text: source, changed: false };
  }
  // A new token is not written on a line that carries a comment; an existing one is edited only
  // through the exact offsets of the characters the compiler read.
  if (!token && blanked !== body) return refuse("cannot-place-here");
  const next = applyLineEdit(body, blanked, before.offsets[index], edit);
  if (next === null) return refuse("cannot-place-here");
  const lines = before.lines.slice();
  lines[index] = next + cr;
  const result = lines.join("\n");

  // 3a. Verify by compiling (tree and lexer): that item reports the requested icon and nothing
  // else moved. In front of the full compile below, which is the check that decides.
  const after = compileView(result);
  const node2 = after?.nodes.find((other) => other.sourceLine === node.sourceLine);
  if (!node2 || after.nodes.length !== before.nodes.length) return refuse("cannot-place-here");
  const now = readSlide(after, node2);
  const items2 = slideListItems(now);
  const target2 = items2[position];
  if (items2.length !== items.length || !target2) return refuse("cannot-place-here");
  if (target2.icon !== wanted) return refuse(key && target2.icon ? "icon-set-elsewhere" : "cannot-place-here");
  const unchanged = now.title === was.title && now.titleIcon === was.titleIcon && now.rest === was.rest
    && now.lexed.length === was.lexed.length && now.blocks.length === was.blocks.length
    && items2.every((entry, i) => sameValue({ ...entry, icon: i === position ? "" : entry.icon }, { ...items[i], icon: i === position ? "" : items[i].icon }))
    && now.blocks.every((entry, k) => (k === target.block
      ? sameValue(withoutItemIcon(entry, target.item), withoutItemIcon(was.blocks[k], target.item))
      : sameValue(entry, was.blocks[k])))
    && outsideOf(after, node2) === outsideOf(before, node)
    && countIconBraces([now.title, now.blocks, node2.notesLines]) <= countIconBraces([was.title, was.blocks, node.notesLines]);
  if (!unchanged) return refuse("cannot-place-here");
  // The full compiler: the finished slide shows this item with that icon, and nothing else moved.
  const reason = refusedByFullModel(source, result, target, wanted, [[body, next], [before.bodyLines[index], after.bodyLines[index]]]);
  if (reason) return refuse(reason);
  return { ok: true, text: result, changed: true };
}
