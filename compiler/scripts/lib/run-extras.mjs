// =============================================================================
// A RUN'S EXTRA SLIDES IN A COMPILE FOR THAT RUN (work-files ticket 25; journeys S9).
//
// The slides are kept on the Run record (`extraSlides: [{ id, title, text, after? }]`, beside ticket 24's
// `extras`; src/shared/run-extras.ts reads and checks them, src/main/runs.ts writes them). The talk's
// outline never holds them and is never written for them.
//
// Who reads them here:
//   - a compile FOR A RUN (`prepareSource(..., { run: { id, slideIds, extraSlides } })`): after the outline's
//     tree is id-resolved, `runExtraSlideNodes` makes one slide node per extra slide DIRECTLY from its title
//     and text (the text is never read as outline, so `###`, `{…}`, `<!--`, fences or `---` in it are its
//     words, not structure), and `placeRunExtraNodes` puts each after its chosen slide (or at the end);
//   - every other compile (the talk's presenting, handout, pathways, strip, Layout Doctor, search) has no
//     `run` option and so never sees them.
// Pure: no Node APIs (the renderer may import it).
// =============================================================================

/** The same limits as src/shared/run-extras.ts RUN_EXTRA_SLIDE_LIMITS (this module is vendored and cannot import it). */
const LIMITS = Object.freeze({ title: 200, text: 2000, slides: 10 });
/** A Run id as runs.ts accepts it (SAFE_RUN_ID_RE). */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A slide id as `{id=…}` accepts it: an extra slide's own id and its "Place after". */
export const EXTRA_SLIDE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function capPoints(text, max) {
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("") : text;
}

/** Plain text: line endings as `\n`, no control characters but line breaks and tabs. */
function cleanText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * `options.run` as a compile takes it: `{ id, slideIds, extraSlides }` with a well-formed Run id, the Run's
 * pathway slide ids (null: the whole talk) and its extra slides checked again (the compiler trusts no caller:
 * entries that are not well formed are left out). Null without a Run id or without an extra slide, so such a
 * compile is the talk's own.
 */
export function runCompileOption(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !RUN_ID_RE.test(value.id)) return null;
  const slideIds = Array.isArray(value.slideIds) ? value.slideIds.filter((id) => typeof id === "string") : null;
  const extraSlides = [];
  const seen = new Set();
  for (const entry of Array.isArray(value.extraSlides) ? value.extraSlides : []) {
    if (extraSlides.length >= LIMITS.slides) break;
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !EXTRA_SLIDE_ID_RE.test(entry.id) || seen.has(entry.id)) continue;
    const title = capPoints(cleanText(entry.title).replace(/\s+/g, " ").trim(), LIMITS.title);
    if (!title) continue;
    const text = capPoints(typeof entry.text === "string" ? cleanText(entry.text).trim() : "", LIMITS.text);
    const after = typeof entry.after === "string" && EXTRA_SLIDE_ID_RE.test(entry.after) ? entry.after : "";
    seen.add(entry.id);
    extraSlides.push({ id: entry.id, title, text, after });
  }
  if (!extraSlides.length) return null;
  return { id: value.id, slideIds, extraSlides };
}

/**
 * The text as the compiler's paragraph blocks: one per non-blank line, its words as typed. Each is `plain`: the
 * deck renders it escaped and nothing more (06-block-renderers.mjs renderBlock), never as inline markdown, so no
 * emphasis, link or auto-linked address is made from it; no line is ever read as a heading, a Trigger, a fence, a
 * comment or front matter.
 */
export function extraSlideBlocks(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => ({ type: "paragraph", text: line, plain: true }));
}

/**
 * One slide node per extra slide, in the shape the id-resolved tree holds (as 08-source-adapters.mjs
 * dedupeTreeIdsAndInsertSequenceSplits builds them): a `###` leaf with its title, no outline lines (its
 * paragraphs ride on `_runExtraBlocks`, which flushSlide uses instead of lexing) and no source line. An id
 * the talk already uses gets `-2`, `-3`… so the deck never has two slides with one id; `_runExtraAfter` is
 * its chosen slide.
 */
export function runExtraSlideNodes(extraSlides, takenIds = new Set()) {
  const taken = new Set(takenIds);
  return (extraSlides || []).map((extra) => {
    let id = extra.id;
    for (let n = 2; taken.has(id); n += 1) id = `${extra.id}-${n}`;
    taken.add(id);
    return {
      level: 3,
      title: extra.title,
      attrs: { id },
      id,
      contentLines: [],
      notesLines: [],
      children: [],
      sourceLine: null,
      headingLine: "",
      triggerLine: "",
      _runExtraAfter: extra.after || "",
      _runExtraBlocks: extraSlideBlocks(extra.text),
    };
  });
}

/** Every slide id in the tree. */
function treeIds(nodes, out = new Set()) {
  for (const node of nodes || []) {
    if (node.id) out.add(node.id);
    treeIds(node.children, out);
  }
  return out;
}

/** The generated opening and closing slides (08-source-adapters.mjs E7): not in the tree when extras are placed. */
export const OPENING_SLIDE_ID = "deck-title";
export const CLOSING_SLIDE_ID = "deck-thanks";

/**
 * In the compiler's id-resolved tree (08-source-adapters.mjs, before slides are emitted): the Run's extra
 * slides (`run.extraSlides`, from runCompileOption) are put in after their chosen slides. The chosen slide
 * must be in the tree outside the pre-work section (or be the generated opening or closing slide) and, with
 * `run.slideIds` (the Run's pathway), among them; otherwise the slide goes "at the end". Where each goes:
 *   - after a slide of the talk: a `##` slide with child slides gets it as its first child (after its title
 *     slide); every other slide gets it as the next sibling, after the slide's whole continuation group (a
 *     quote split over `quote`, `quote--2`…), whichever part of the group was chosen;
 *   - after the opening (`deck-title`): before the first slide of the talk, so right after the generated title
 *     slide once it is put in front;
 *   - after the closing (`deck-thanks`): at the very end of the deck (settleRunExtraTail moves it past the
 *     generated closing slides once they are there);
 *   - at the end: after every slide of the Run and every extra slide placed after one, so after all explicitly
 *     placed extra slides (with an extra slide after the closing, after that one too).
 * Several extra slides with one place keep their entry order.
 * Returns what was placed, in entry order: `[{ id, title, after, placed: 'after' | 'end' }]`, `id` as the deck
 * has it.
 */
export function placeRunExtraNodes(root, run) {
  const extras = runExtraSlideNodes(run?.extraSlides, treeIds(root.children));
  if (!extras.length) return [];

  const allowed = Array.isArray(run.slideIds) ? new Set(run.slideIds) : null;
  // Where each slide sits: its parent's child list and its continuation group (a continuation id points at the
  // group's first part). The pre-work section and its steps are never presented, so nothing is placed after
  // (or inside) them.
  const where = new Map();
  const visit = (list, parentNode) => {
    let head = null;
    for (const node of list) {
      if (node.level === 2 && node.attrs?.prework === true) { head = null; continue; }
      if (node._sequenceOnly) {
        if (head && (head.node._sequenceContinuationIds || []).includes(node.id)) where.set(node.id, head);
        continue;
      }
      head = { list, node, parentNode, group: [node.id, ...(node._sequenceContinuationIds || [])] };
      where.set(node.id, head);
      visit(node.children || [], node);
    }
  };
  visit(root.children, root);
  const allowedId = (id) => !allowed || allowed.has(id);
  const usable = (id) => Boolean(id) && where.has(id) && allowedId(id);
  const bookend = (id) => (id === OPENING_SLIDE_ID || id === CLOSING_SLIDE_ID) && !where.has(id) && allowedId(id) ? id : "";

  const placedById = new Map();
  const lastPlaced = new Map();
  const explicitEntries = [];
  // After `entry`'s slide (and its continuation group), or after the extra slides already put there.
  const putAfter = (entry, extra, key, { firstChild }) => {
    const previous = lastPlaced.get(key);
    if (!previous && firstChild && entry.node.level === 2 && (entry.node.children || []).length) {
      entry.node.children.unshift(extra);
      const placedEntry = { list: entry.node.children, node: extra, parentNode: entry.node, group: [extra.id] };
      lastPlaced.set(key, placedEntry);
      return placedEntry;
    }
    const anchor = previous ?? entry;
    const list = anchor.list;
    let index = list.indexOf(anchor.node) + 1;
    // A slide split over several (its continuation slides follow it) is followed after its last part.
    while (index < list.length && list[index]._sequenceOnly) index += 1;
    if (anchor.node.level >= 3) extra.level = anchor.node.level;
    list.splice(index, 0, extra);
    const placedEntry = { list, node: extra, parentNode: anchor.parentNode, group: [extra.id] };
    lastPlaced.set(key, placedEntry);
    return placedEntry;
  };

  // 1. After a slide of the talk.
  for (const extra of extras) {
    const after = extra._runExtraAfter;
    if (!usable(after)) continue;
    const entry = where.get(after);
    explicitEntries.push(putAfter(entry, extra, `after:${entry.node.id}`, { firstChild: true }));
    placedById.set(extra.id, { id: extra.id, title: extra.title, after, placed: "after" });
  }
  // 2. After the opening: in front of the talk's slides, in entry order.
  let openingAt = 0;
  for (const extra of extras) {
    if (placedById.has(extra.id) || bookend(extra._runExtraAfter) !== OPENING_SLIDE_ID) continue;
    root.children.splice(openingAt, 0, extra);
    openingAt += 1;
    placedById.set(extra.id, { id: extra.id, title: extra.title, after: extra._runExtraAfter, placed: "after" });
  }
  // 3. After the closing, then at the end.
  const closing = extras.filter((extra) => !placedById.has(extra.id) && bookend(extra._runExtraAfter) === CLOSING_SLIDE_ID);
  const atEnd = extras.filter((extra) => !placedById.has(extra.id) && !closing.includes(extra));
  for (const extra of closing) placedById.set(extra.id, { id: extra.id, title: extra.title, after: extra._runExtraAfter, placed: "after" });
  for (const extra of atEnd) placedById.set(extra.id, { id: extra.id, title: extra.title, after: extra._runExtraAfter, placed: "end" });
  if (closing.length) {
    // With an extra slide after the closing, those and the end ones are the deck's last slides.
    for (const extra of [...closing, ...atEnd]) {
      extra._runExtraTail = true;
      root.children.push(extra);
    }
  } else if (atEnd.length) {
    // The end: after the last of the Run's slides and of the extra slides placed after one, in the deck's order.
    const placedNodes = new Set(explicitEntries.map((entry) => entry.node));
    let endPoint = null;
    const walk = (list, parentNode) => {
      for (const node of list) {
        if (node._sequenceOnly || (node.level === 2 && node.attrs?.prework === true)) continue;
        const entry = where.get(node.id);
        if (placedNodes.has(node)) endPoint = { list, node, parentNode, group: [node.id] };
        else if (entry && entry.node === node && entry.group.some((id) => usable(id))) endPoint = entry;
        walk(node.children || [], node);
      }
    };
    walk(root.children, root);
    for (const extra of atEnd) {
      if (endPoint) putAfter(endPoint, extra, "end", { firstChild: false });
      else root.children.push(extra);
    }
  }
  return extras.map((extra) => placedById.get(extra.id));
}

/**
 * After the generated opening and closing slides are in (08-source-adapters.mjs, after E7 and the links
 * slide): extra slides placed after the closing, and the end ones after them, move past the closing slides to
 * the very end of the deck, in `slides` and in the tree alike. With no generated closing slide they stay
 * where they are, after the talk's slides, and the ones after the closing are reported as at the end.
 */
export function settleRunExtraTail(slides, rootChildren, placed) {
  const tail = rootChildren.filter((node) => node && node._runExtraTail);
  if (!tail.length) return;
  if (!slides.some((slide) => slide.id === CLOSING_SLIDE_ID)) {
    for (const entry of placed || []) {
      if (entry.placed === "after" && entry.after === CLOSING_SLIDE_ID) entry.placed = "end";
    }
    return;
  }
  const ids = new Set(tail.map((node) => node.id));
  const toEnd = (list, isTail) => {
    const moved = list.filter(isTail);
    for (let index = list.length - 1; index >= 0; index -= 1) if (isTail(list[index])) list.splice(index, 1);
    list.push(...moved);
  };
  toEnd(slides, (slide) => ids.has(slide.id));
  toEnd(rootChildren, (node) => node._runExtraTail === true);
}

/**
 * A Run's slide list with its extra slides put in, from the compile's final slide order (`runExtras.order`,
 * recorded after the generated opening and closing slides and every reordering, so the beats agree).
 * `runExtras` is the compile's `model.runExtras` (`{ slides, order }`); without an order or extra slides (no
 * Run compile) the list is `slideIds` as given.
 * For `slideIds` in the deck's order this is exactly `order.filter((id) => slideIds has id || it is an extra)`.
 * A pathway can be put in its own running order (Pathways → Reorder), which that filter would undo, so each
 * extra slide instead follows the slide of `slideIds` that comes before it in `order` (extra slides before any
 * of them lead), and `slideIds` keep their own order.
 * An extra slide placed at the end (`placed: "end"`) is anchored to no slide: after the pathway and every
 * explicitly placed extra slide, in its `order` order.
 */
export function withRunExtraIds(slideIds, runExtras) {
  const order = Array.isArray(runExtras?.order) ? runExtras.order : null;
  const extraIds = new Set((runExtras?.slides || []).filter((extra) => extra && typeof extra.id === "string").map((extra) => extra.id));
  if (!order || !extraIds.size) return [...slideIds];
  const endIds = new Set((runExtras?.slides || []).filter((extra) => extra && extra.placed === "end" && typeof extra.id === "string").map((extra) => extra.id));
  const wanted = new Set(slideIds.filter((id) => !extraIds.has(id)));
  const lead = [];
  const atEnd = [];
  const following = new Map();
  let anchor = null;
  for (const id of order) {
    if (wanted.has(id)) anchor = id;
    else if (extraIds.has(id)) {
      if (endIds.has(id)) atEnd.push(id);
      else if (anchor == null) lead.push(id);
      else following.set(anchor, [...(following.get(anchor) || []), id]);
    }
  }
  const out = [...lead];
  for (const id of slideIds) {
    if (extraIds.has(id)) continue;
    out.push(id);
    out.push(...(following.get(id) || []));
    following.delete(id);
  }
  out.push(...atEnd);
  return out;
}
