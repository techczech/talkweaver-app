// =============================================================================
// PRE-WORK — the one reading of a talk's "Before the session" section (ADR-0032 point 5 and its
// 2026-09-30 amendment point 5; ticket 08 of the feedback-boards build).
//
// The outline is the truth:
//   ## Before the session {prework}   the section (a `##` heading only); its paragraph is the intro
//   ### …                             each child slide is one STEP, in outline order
//     {task}                          a pre-task: its list is the instructions; participants get
//                                     "Mark as done" (round-2 E3 draws `{task}` with it selected)
//       {readonly}                    …no Mark as done: participants only read the task
//       {minutes=5|20|30}             …the time it takes (default 10, never written)
//     {check}                         a quick knowledge check: a {poll=single} whose right option
//       - an option {right}             carries `{right}` at the end of its list item
//     {poll=…}                        a question (any poll type)
//     (none of these)                 a slide participants read
//     {noask}                         any step: participants cannot ask about it (default: they can)
//   {results=<step id>}               on a TALK slide: the slide shows that step's answers
//
// The compiler (08-source-adapters.mjs) builds `model.prework` with `preworkFromTree` on its own
// id-resolved tree, strips `{right}` from what participants see (`takeRightMarkers`) and reports
// `preworkFindings`; the app reads the SAME definition from the outline text with
// `preworkFromOutline` (the Inspector's "Before the session" section, the plan sheet, the status
// bar), and presenting leaves the section's slides out (src/main/pathways.ts). Plain ESM that the
// renderer imports too (prework.d.mts): no Node APIs.
// =============================================================================
import { parseOutlineTree } from "./14-outline-tree.mjs";
import { blankHtmlComments } from "./html-comments.mjs";

export const PREWORK_KINDS = Object.freeze(["slide", "check", "question", "task"]);
export const PREWORK_KIND_LABELS = Object.freeze({ slide: "Slide", check: "Quick check", question: "Question", task: "Pre-task" });
/** A pre-task's "Time it takes" (round-2 E3): the values offered; the default is never written. */
export const PREWORK_MINUTES = Object.freeze({ values: Object.freeze(["5", "10", "20", "30"]), fallback: "10" });
/** The tokens that only mean something on a step of the pre-work section. */
export const PREWORK_STEP_TOKENS = Object.freeze(["task", "check", "readonly", "minutes", "noask"]);

// `{right}` anywhere in a line (any case, spaces inside the braces): the right-answer marker. It is
// taken out of every line of a quick check outside code fences, wherever it was written.
const RIGHT_ANY_RE = /[ \t]*\{[ \t]*right[ \t]*\}/gi;
// Where the Inspector writes it: at the end of a top-level item of the first list.
const RIGHT_END_RE = /\S[ \t]*\{[ \t]*right[ \t]*\}[ \t]*$/i;
const ITEM_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

function stripEol(line) {
  return String(line ?? "").replace(/\r$/, "");
}

function closesFence(line, opening) {
  const text = line.trim();
  return /^(`+|~+)$/.test(text) && text[0] === opening[0] && text.length >= opening.length;
}

// The compiler's own fallback id (01-cli-utils.mjs slugify), for a heading written without
// `{id=…}`; repeated here because that module is Node-only. The compiler passes its resolved tree,
// so this only matters to the app's reading of an unsaved heading.
function fallbackId(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "presentation";
}

function nodeId(node) {
  return (typeof node.id === "string" && node.id.trim()) || (typeof node.attrs?.id === "string" && node.attrs.id.trim()) || fallbackId(node.title);
}

/** A `##` heading whose own trigger tokens carry `{prework}`. */
export function isPreworkSection(node) {
  return Boolean(node) && node.level === 2 && node.attrs?.prework === true;
}

// ── The quick check's options and the {right} marker ─────────────────────────────────────────

/**
 * The ONE walk over a quick check's body that both the reader (`takeRightMarkers`) and the writer
 * (`applyRightAnswerToOutline`) use, so where a marker counts and where the Inspector writes it can
 * never drift. `lines` start after the heading; the walk stops at the next heading outside a fence.
 * Each line outside a fence is visited as `{ index, line, item, choice }`: `item` is the list-item
 * match (any indent), `choice` the 0-based option index of a top-level item of the FIRST list (the
 * poll's options), else -1.
 */
function walkCheckBody(lines, visit, { throughHeadings = false } = {}) {
  let fence = null;
  let listState = "before"; // before → in → after (only the first list is the choice list)
  let option = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripEol(lines[index]);
    if (fence) { if (closesFence(line, fence)) fence = null; continue; }
    const open = line.trim().match(FENCE_RE);
    if (open) { fence = open[1]; continue; }
    if (/^#{1,6}\s/.test(line)) {
      if (!throughHeadings) break;
      listState = listState === "in" ? "after" : listState;
      continue;
    }
    const item = line.match(ITEM_RE);
    let choice = -1;
    if (item && !item[1] && listState !== "after") { listState = "in"; option += 1; choice = option; }
    else if (!item && listState === "in" && line.trim() && !/^\s/.test(line)) listState = "after";
    visit({ index, line, item, choice });
  }
}

function withoutMarkers(line) {
  const item = line.match(ITEM_RE);
  if (item) return `${item[1]}${item[2]}${item[3]}${item[4].replace(RIGHT_ANY_RE, "").trim()}`;
  const indent = line.match(/^[ \t]*/)[0];
  const rest = line.replace(RIGHT_ANY_RE, "").trim();
  return rest ? indent + rest : "";
}

/**
 * A quick check's body as participants and the room see it, and what its markers say.
 *   lines        the body with every `{right}` removed, wherever it was written (any list item at
 *                any indent, at its start, middle or end, or a plain line), code fences untouched
 *   options      the top-level items of the first list, each with whether it carries a marker
 *   rightCount   every marker in the body
 *   misplaced    markers the Inspector would not have written (not at the end of an option)
 * `throughHeadings` reads a slide's whole source (its heading line included) instead of stopping.
 */
export function takeRightMarkers(lines = [], { throughHeadings = false } = {}) {
  const out = [...lines];
  const options = [];
  let rightCount = 0;
  let misplaced = 0;
  walkCheckBody(lines, ({ index, line, item, choice }) => {
    const markers = (line.match(RIGHT_ANY_RE) || []).length;
    rightCount += markers;
    const wellPlaced = choice >= 0 && markers === 1 && RIGHT_END_RE.test(line);
    if (markers && !wellPlaced) misplaced += markers;
    if (choice >= 0) options.push({ label: item[4].replace(RIGHT_ANY_RE, "").trim(), right: markers > 0 });
    if (markers) out[index] = withoutMarkers(line) + (String(lines[index]).endsWith("\r") ? "\r" : "");
  }, { throughHeadings });
  return { lines: out, options, rightCount, misplaced };
}

// ── The definition ──────────────────────────────────────────────────────────────────────────

function minutesText(value) {
  return value == null || value === true ? "" : String(value).trim();
}

function readMinutes(value) {
  const text = minutesText(value);
  return Number(PREWORK_MINUTES.values.includes(text) ? text : PREWORK_MINUTES.fallback);
}

function introOf(lines = []) {
  const paragraph = [];
  for (const raw of lines) {
    const line = stripEol(raw).trim();
    if (!line) { if (paragraph.length) break; continue; }
    if (/^([-*+>#|!]|\d+[.)]|```|~~~|\[|<)/.test(line)) { if (paragraph.length) break; continue; }
    paragraph.push(line);
  }
  return paragraph.join(" ");
}

function stepOf(node, index) {
  const attrs = node.attrs || {};
  const pollType = typeof attrs.poll === "string" && attrs.poll.trim() ? attrs.poll.trim() : "";
  const kind = attrs.task === true ? "task" : attrs.check === true ? "check" : pollType ? "question" : "slide";
  const step = {
    n: index + 1,
    id: nodeId(node),
    title: String(node.title ?? ""),
    kind,
    questions: attrs.noask !== true,
    sourceLine: node.sourceLine || null,
  };
  if (pollType) step.pollType = pollType;
  if (kind === "task") {
    step.done = attrs.readonly !== true;
    step.minutes = readMinutes(attrs.minutes);
  }
  if (kind === "check") {
    const { options } = takeRightMarkers(node.contentLines);
    step.options = options.map((option) => option.label);
    const rightIndex = options.findIndex((option) => option.right);
    step.right = rightIndex >= 0 ? { index: rightIndex, label: options[rightIndex].label } : null;
  }
  return step;
}

/**
 * The talk's pre-work form read from an outline tree (parseOutlineTree's root, or the compiler's
 * id-resolved tree): the first `##` section carrying `{prework}` and its child slides as steps.
 * Null when the talk has no pre-work section.
 */
export function preworkFromTree(root) {
  const section = (root?.children || []).find(isPreworkSection);
  if (!section) return null;
  return {
    sectionId: nodeId(section),
    title: String(section.title ?? ""),
    intro: introOf(section.contentLines),
    sourceLine: section.sourceLine || null,
    steps: (section.children || []).map(stepOf),
  };
}

/**
 * The board slides of the talk that take a pre-work step's answers (`{results=<step id>}` on a slide
 * that is a board), as `{ stepId, slideId, title }` in reading order. Read from the compiler's own
 * id-resolved tree, so a slide id is the one the compiled deck and the live session use (a repeated
 * title is already `hopes-2`); the app never derives one itself.
 */
export function preworkFeedsFromTree(root) {
  const feeds = [];
  for (const { node } of walk(root?.children)) {
    const stepId = typeof node.attrs?.results === "string" ? node.attrs.results.trim() : "";
    if (!stepId || String(node.attrs?.poll ?? "").trim().toLowerCase() !== "board") continue;
    feeds.push({ stepId, slideId: nodeId(node), title: String(node.title ?? "") });
  }
  return feeds;
}

/** Blank the front matter and HTML comments in place, so tree lines are outline lines. */
function outlineBody(markdown) {
  let body = String(markdown ?? "");
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) body = body.slice(0, end + 4).replace(/[^\n]/g, "") + body.slice(end + 4);
  }
  return blankHtmlComments(body);
}

/** The outline tree the app reads pre-work from (front matter and comments blanked): what `{results=…}` slides are found in. */
export function preworkOutlineTree(markdown) {
  return parseOutlineTree(outlineBody(markdown)).root;
}

/** The pre-work definition read from the outline text, as the compiler reads it. */
export function preworkFromOutline(markdown) {
  return preworkFromTree(parseOutlineTree(outlineBody(markdown)).root);
}

/** Steps a talk slide can show the answers of with `{results=<step id>}` (a slide has none). */
export function resultsSteps(definition) {
  return (definition?.steps || []).filter((step) => step.kind !== "slide");
}

function* walk(nodes, ancestors = []) {
  for (const node of nodes || []) {
    yield { node, ancestors };
    yield* walk(node.children, [...ancestors, node]);
  }
}

/**
 * What is wrong with the pre-work as written, as `{ code, slideId, detail }` (warning-registry
 * ids). Read against the definition `preworkFromTree` returned for the same tree.
 */
export function preworkFindings(root, definition = preworkFromTree(root)) {
  const findings = [];
  const add = (code, slideId, detail = "") => findings.push({ code, slideId, detail });
  const sections = (root?.children || []).filter(isPreworkSection);
  for (const extra of sections.slice(1)) add("prework-section-duplicate", nodeId(extra), extra.title);
  if (definition && definition.steps.length === 0) add("prework-section-empty", definition.sectionId, definition.title);
  const primary = sections[0] ?? null;
  const stepIds = new Set((definition?.steps || []).map((step) => step.id));
  for (const { node, ancestors } of walk(root?.children)) {
    const attrs = node.attrs || {};
    const id = nodeId(node);
    const isStep = Boolean(primary) && ancestors.length === 1 && ancestors[0] === primary;
    if (!isStep) {
      for (const token of PREWORK_STEP_TOKENS) {
        if (Object.hasOwn(attrs, token)) add("prework-token-outside", id, token);
      }
    } else {
      const pollType = typeof attrs.poll === "string" ? attrs.poll : "";
      if (attrs.task === true && (attrs.check === true || pollType)) add("prework-kind-conflict", id, attrs.check === true ? "check" : "poll");
      if (attrs.readonly === true && attrs.task !== true) add("prework-readonly-without-task", id, "readonly");
      if (Object.hasOwn(attrs, "minutes") && attrs.task !== true) add("prework-readonly-without-task", id, "minutes");
      if (attrs.task === true && Object.hasOwn(attrs, "minutes") && !PREWORK_MINUTES.values.includes(minutesText(attrs.minutes))) {
        add("prework-minutes-invalid", id, `minutes=${minutesText(attrs.minutes)}`);
      }
      if (attrs.check === true && attrs.task !== true) {
        if (pollType !== "single") add("prework-check-not-single", id, pollType || "none");
        const { rightCount, misplaced } = takeRightMarkers(node.contentLines);
        if (rightCount === 0) add("prework-check-right-missing", id);
        else if (rightCount > 1) add("prework-check-right-many", id, String(rightCount));
        if (misplaced > 0) add("prework-right-misplaced", id, String(misplaced));
      }
    }
    if (typeof attrs.results === "string" && attrs.results.trim()) {
      const target = attrs.results.trim();
      if (!stepIds.has(target)) add("prework-results-unknown", id, target);
    }
  }
  return findings;
}

// ── Writing the right answer (the Inspector's Quick check section) ───────────────────────────

/**
 * The outline with the `{right}` marker on the inspected check's option `optionIndex` (0-based,
 * in the first list) and on no other option; -1 clears it. `headingLine` is the slide's 1-based
 * heading line. Every other byte is kept.
 */
export function applyRightAnswerToOutline(content, headingLine, optionIndex) {
  const lines = String(content).split("\n");
  const start = headingLine - 1;
  if (!/^#{1,6}\s/.test(stripEol(lines[start] ?? ""))) return content;
  let changed = false;
  const body = lines.slice(start + 1);
  walkCheckBody(body, ({ index, line, choice }) => {
    const markers = (line.match(RIGHT_ANY_RE) || []).length;
    const want = choice >= 0 && choice === optionIndex;
    // Already written where the Inspector writes it: keep its bytes.
    if (want && markers === 1 && RIGHT_END_RE.test(line)) return;
    if (!want && !markers) return;
    const eol = lines[start + 1 + index].endsWith("\r") ? "\r" : "";
    const bare = markers ? withoutMarkers(line) : line;
    lines[start + 1 + index] = (want ? bare.replace(/\s+$/, "") + " {right}" : bare) + eol;
    changed = true;
  });
  return changed ? lines.join("\n") : content;
}
