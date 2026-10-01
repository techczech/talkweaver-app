// =============================================================================
// BOARD SLIDE — the one reading (and writing) of a `{poll=board}` slide's source (ADR-0032 §2,
// round-3 rules 1–5; ticket 01 of the feedback-boards build).
//
// The slide text is the truth:
//   heading            → the question
//   a paragraph        → the instructions (the first paragraph under the trigger line)
//   a `>` line         → the example card ("> Example: …"; the "Example:" prefix is optional)
//   the list           → the columns (2–4); a nested bullet under a column is its hint
// and the settings are trigger-line tokens written only when they differ from the default:
//   {limit=12|36|all}  big screen shows (default 24)
//   {length=60|100|200} card length in characters (default 140)
//   {cards=1|3|10}     cards per phone (default 5)
//   {names}            names optional (default off)
//   {closes=1d|30d}    a board left open closes after (default 7d)
//
// The compiler (poll-authoring.mjs) builds the board definition from `readBoardBody` and
// `readBoardSettings`; the Inspector's Board section reads the SAME functions and writes through
// `applyBoardEdit`, so what the Inspector shows is what the compiler emits. Plain ESM with no
// imports beyond the tokenizer: the renderer imports it too (board-slide.d.mts).
// =============================================================================
import { TRIGGER_LINE_RE } from "./trigger-tokenizer.mjs";

export const BOARD_TEXT_LIMITS = Object.freeze({ name: 16, hint: 60, instructions: 160, example: 140 });
export const BOARD_COLUMN_RANGE = Object.freeze({ min: 2, max: 4 });

// Each setting: its trigger key, the values the Inspector offers (in order), the default (never
// written), the definition field it fills and how a value reads into it. `names` is written bare
// ({names}, read as optional); `names=optional` / `names=off` stay legal spellings.
export const BOARD_SETTINGS = Object.freeze([
  { key: "limit", values: ["12", "24", "36", "all"], fallback: "24", field: "limit", read: (value) => (value === "all" ? null : Number(value)) },
  { key: "length", values: ["60", "100", "140", "200"], fallback: "140", field: "cardChars", read: Number },
  { key: "cards", values: ["1", "3", "5", "10"], fallback: "5", field: "cardsPerPhone", read: Number },
  { key: "names", values: ["off", "optional"], fallback: "off", field: "names", read: (value) => value === "optional" },
  { key: "closes", values: ["1d", "7d", "30d"], fallback: "7d", field: "closesAfterDays", read: (value) => Number(value.slice(0, -1)) },
]);

// What the live worker refuses (worker/board-protocol.ts BOARD_LIMITS on next/0.36): above these
// the whole board is refused when the session opens it, so the compiler reports an error.
export const BOARD_LIVE_LIMITS = Object.freeze({ instructions: 1000, example: 500, hint: 300 });

// The settings as the poll definition carries them (the live worker's BoardSettings,
// worker/board-protocol.ts): limit null is "All"; names true is "optional".
export const BOARD_DEFAULTS = Object.freeze({
  limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7,
});

// Insert › Board slide (round-3 A1): the starter the menu writes after the current slide.
export const BOARD_STARTER = Object.freeze({
  question: "What should we keep, change, try?",
  instructions: "Add what you would keep, change or try. One idea per card; no names are shown.",
  columns: [
    { label: "Keep", hint: "What worked for you?" },
    { label: "Change", hint: "What should be different?" },
    { label: "Try", hint: "What could we do next time?" },
  ],
});

/** The starter slide's lines at heading level `level` (3 unless the caller says otherwise). A
 *  given `id` is stamped on the trigger line, so the new slide is editable before its first save. */
export function boardStarterLines(level = 3, id = "") {
  const hashes = "#".repeat(Math.min(6, Math.max(1, level)));
  return [
    `${hashes} ${BOARD_STARTER.question}`,
    id ? `{poll=board} {id=${id}}` : "{poll=board}",
    "",
    BOARD_STARTER.instructions,
    "",
    ...boardListLines(BOARD_STARTER.columns),
  ];
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

/**
 * Read the board's settings from a slide's parsed trigger attrs (parseHeadingAttrs), by the
 * BOARD_SETTINGS declarations. Absent keys take the default; an unreadable value takes the default
 * and is reported in `issues` as `key=value` (the compiler's `board-setting-invalid` warning).
 */
export function readBoardSettings(attrs = {}) {
  const issues = [];
  const settings = { ...BOARD_DEFAULTS };
  for (const setting of BOARD_SETTINGS) {
    if (!Object.hasOwn(attrs, setting.key)) continue;
    const raw = attrs[setting.key];
    const value = setting.key === "names" && raw === true ? "optional" : String(raw).trim().toLowerCase();
    if (setting.values.includes(value)) settings[setting.field] = setting.read(value);
    else issues.push(`${setting.key}=${raw}`);
  }
  return { settings, issues };
}

// ── The slide's structure: headings, fences, notes ──────────────────────────────────────────

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])(?:(\s+)(.*))?$/;
const EXAMPLE_PREFIX_RE = /^example\s*:\s*/i;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
// Lines that are slide media or directives, never the instructions (S4): an image, an embed-style
// directive, a poll directive, a bare link (an auto-embed) or an HTML comment.
const MEDIA_LINE_RE = /^(?:!\[[^\]]*\]\(.*\)|\[(?:embed|video|simulation|qr|action|scale|categories)\s*:.*|https?:\/\/\S+|<!--.*)$/i;

function stripEol(line) {
  return String(line ?? "").replace(/\r$/, "");
}

function isHeading(line) {
  return /^#{1,6}\s/.test(line);
}

function fenceOpening(line) {
  const match = line.trim().match(FENCE_RE);
  return match ? match[1] : null;
}

function closesFence(line, opening) {
  const match = line.trim().match(/^(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === opening[0] && match[1].length >= opening.length);
}

/**
 * What each line of a slide body is, as the compiler routes it (14-outline-tree.mjs): "fence"
 * (inside a code fence, markers included), "notes" (a `:::notes` block, markers included; it also
 * ends at a heading), "heading" (the next slide starts: the body ends there) or "text".
 */
function classifyBody(body) {
  const kinds = [];
  let fence = null;
  let notes = false;
  for (const line of body) {
    if (fence) {
      kinds.push(notes ? "notes" : "fence");
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpening(line);
    if (open) { fence = open; kinds.push(notes ? "notes" : "fence"); continue; }
    if (isHeading(line)) { kinds.push("heading"); notes = false; continue; }
    const text = line.trim();
    if (text.toLowerCase() === ":::notes") { notes = true; kinds.push("notes"); continue; }
    if (text === ":::" && notes) { notes = false; kinds.push("notes"); continue; }
    kinds.push(notes ? "notes" : "text");
  }
  return kinds;
}

/**
 * The index of the line after a slide's block: the next heading outside a code fence, or the end.
 * `headingIndex` is the slide's own heading. (The Inspector's block extraction reads the same end.)
 */
export function slideBlockEnd(lines, headingIndex) {
  let fence = null;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = stripEol(lines[index]);
    if (fence) { if (closesFence(line, fence)) fence = null; continue; }
    const open = fenceOpening(line);
    if (open) { fence = open; continue; }
    if (isHeading(line)) return index;
  }
  return lines.length;
}

// ── Instructions that read back as instructions (S1) ────────────────────────────────────────

// A line that would not read as a paragraph: a list item, a quote, a heading, a fence, a trigger
// line or directive, a notes marker, a table row, HTML, or media. Instructions starting like that
// are written with a leading backslash, which the reader removes; so is a leading backslash itself.
function startsAsNonParagraph(text) {
  return /^[-*+>#`~{[!:|<\\]/.test(text) || /^\d+[.)]/.test(text) || MEDIA_LINE_RE.test(text);
}

function escapeInstructions(text) {
  return startsAsNonParagraph(text) ? `\\${text}` : text;
}

function unescapeInstructions(text) {
  return text.startsWith("\\") && startsAsNonParagraph(text.slice(1)) ? text.slice(1) : text;
}

// ── Reading the body ────────────────────────────────────────────────────────────────────────

/**
 * Read a board slide's body. `lines` are the slide's own lines AFTER its heading. Trigger lines,
 * blank lines, media lines, code fences and `:::notes` blocks are never board content. Returns the
 * text of each part and, for the writer, the half-open line range [start, end) it occupies.
 * A column carries `raw`, its own item and hint lines as written, so the writer keeps their bytes.
 *
 * @returns {{
 *   instructions: { text: string, start: number, end: number } | null,
 *   example: { text: string, start: number, end: number } | null,
 *   list: { start: number, end: number, marker: string, hintIndent: string,
 *           columns: Array<{ label: string, hint: string, extra: string[], raw: { item: string, hint: string | null } }> } | null
 * }}
 */
export function readBoardBody(lines = []) {
  const body = lines.map(stripEol);
  const kinds = classifyBody(body);
  const isText = (at) => kinds[at] === "text";
  let instructions = null;
  let example = null;
  let list = null;
  let index = 0;
  while (index < body.length) {
    if (kinds[index] === "heading") break;
    const line = body[index];
    const text = line.trim();
    if (!isText(index) || !text || TRIGGER_LINE_RE.test(text) || MEDIA_LINE_RE.test(text)) { index += 1; continue; }
    if (text.startsWith(">")) {
      const start = index;
      const parts = [];
      while (index < body.length && isText(index) && body[index].trim().startsWith(">")) {
        parts.push(body[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      if (!example) example = { text: parts.join(" ").trim().replace(EXAMPLE_PREFIX_RE, "").trim(), start, end: index };
      continue;
    }
    const item = line.match(LIST_ITEM_RE);
    if (item) {
      const start = index;
      const baseIndent = item[1].length;
      const columns = [];
      let hintIndent = "";
      while (index < body.length && isText(index)) {
        const current = body[index];
        if (!current.trim()) {
          // A blank line inside a list continues it only when another item follows.
          let next = index + 1;
          while (next < body.length && isText(next) && !body[next].trim()) next += 1;
          if (next < body.length && isText(next) && LIST_ITEM_RE.test(body[next])) { index = next; continue; }
          break;
        }
        const match = current.match(LIST_ITEM_RE);
        if (match && match[1].length <= baseIndent) {
          columns.push({ label: (match[4] ?? "").trim(), hint: "", extra: [], raw: { item: current, hint: null } });
        } else if (match && columns.length) {
          const column = columns[columns.length - 1];
          // The first nested bullet is the hint — an empty one holds a cleared hint's place (S5).
          if (column.raw.hint === null && !column.extra.length) {
            column.hint = (match[4] ?? "").trim();
            column.raw.hint = current;
            if (!hintIndent) hintIndent = `${match[1]}${match[2]}${match[3] ?? " "}`;
          } else {
            column.extra.push(current);
          }
        } else if (columns.length && /^\s+\S/.test(current)) {
          columns[columns.length - 1].extra.push(current);
        } else {
          break;
        }
        index += 1;
      }
      if (!list) list = { start, end: index, marker: item[2], hintIndent, columns };
      continue;
    }
    // Paragraph: consecutive text lines that are none of the above.
    const start = index;
    const parts = [];
    while (index < body.length && isText(index)) {
      const trimmed = body[index].trim();
      if (!trimmed || trimmed.startsWith(">") || LIST_ITEM_RE.test(body[index])
        || TRIGGER_LINE_RE.test(trimmed) || MEDIA_LINE_RE.test(trimmed)) break;
      parts.push(trimmed);
      index += 1;
    }
    if (!instructions && !list) instructions = { text: unescapeInstructions(parts.join(" ")), start, end: index };
  }
  return { instructions, example, list };
}

/** The board's authored parts, without line ranges — what the Inspector edits. */
export function boardSource(lines = []) {
  const read = readBoardBody(lines);
  return {
    instructions: read.instructions?.text ?? "",
    example: read.example ? read.example.text : null,
    columns: (read.list?.columns ?? []).map(({ label, hint, extra, raw }) => ({ label, hint, extra: [...extra], raw: { ...raw } })),
  };
}

/**
 * Length and count findings for a board's authored parts, as warning payload parts. The compiler
 * prefixes the slide id; the Inspector shows the same findings beside the fields. The
 * `board-live-limit` findings are errors: above them the live session refuses the whole board.
 */
export function boardFindings(source) {
  const findings = [];
  const columns = source.columns ?? [];
  const instructions = source.instructions ?? "";
  const example = source.example ?? "";
  if (columns.length < BOARD_COLUMN_RANGE.min) findings.push({ code: "board-columns-few", detail: String(columns.length) });
  if (columns.length > BOARD_COLUMN_RANGE.max) findings.push({ code: "board-columns-many", detail: String(columns.length) });
  for (const column of columns) {
    if (column.label.length > BOARD_TEXT_LIMITS.name) findings.push({ code: "board-column-name-long", detail: column.label });
    if (column.hint.length > BOARD_TEXT_LIMITS.hint) findings.push({ code: "board-column-hint-long", detail: column.label });
  }
  if (instructions.length > BOARD_TEXT_LIMITS.instructions) findings.push({ code: "board-instructions-long", detail: String(instructions.length) });
  if (example.length > BOARD_TEXT_LIMITS.example) findings.push({ code: "board-example-long", detail: String(example.length) });
  if (instructions.length > BOARD_LIVE_LIMITS.instructions) findings.push({ code: "board-live-limit", detail: `instructions:${instructions.length}:${BOARD_LIVE_LIMITS.instructions}` });
  if (example.length > BOARD_LIVE_LIMITS.example) findings.push({ code: "board-live-limit", detail: `example:${example.length}:${BOARD_LIVE_LIMITS.example}` });
  for (const column of columns.slice(0, BOARD_COLUMN_RANGE.max)) {
    if (column.hint.length > BOARD_LIVE_LIMITS.hint) findings.push({ code: "board-live-limit", detail: `hint for ${column.label}:${column.hint.length}:${BOARD_LIVE_LIMITS.hint}` });
  }
  return findings;
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────

function oneLine(text) {
  return String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function itemLabel(line) {
  return (stripEol(line).match(LIST_ITEM_RE)?.[4] ?? "").trim();
}

/**
 * The list's lines for `columns`. An item or hint whose text is unchanged keeps its bytes (its
 * marker included: an ordered list keeps 1. 2. 3.); a new or edited item takes the list's marker
 * (numbered by its place in an ordered list). A cleared hint with nested lines after it leaves an
 * empty bullet in its place, so the next nested line never becomes the hint (S5).
 */
function boardListLines(columns, marker = "-", hintIndent = "  - ") {
  const ordered = /^\d+[.)]$/.test(marker);
  const lines = [];
  let place = 0;
  for (const column of columns) {
    const label = oneLine(column.label);
    if (!label) continue;
    place += 1;
    const raw = column.raw;
    lines.push(raw?.item && itemLabel(raw.item) === label ? stripEol(raw.item) : `${ordered ? `${place}${marker.slice(-1)}` : marker} ${label}`);
    const hint = oneLine(column.hint);
    const extra = column.extra ?? [];
    if (hint) lines.push(raw?.hint && itemLabel(raw.hint) === hint ? stripEol(raw.hint) : `${hintIndent}${hint}`);
    else if (extra.length) lines.push(hintIndent.trimEnd());
    for (const line of extra) lines.push(line);
  }
  return lines;
}

// Replace body[start, end) with `insert`, keeping exactly one blank line between the new lines
// and any neighbouring text, and never leaving a doubled blank line where lines were removed.
function spliceBody(body, start, end, insert) {
  const before = body.slice(0, start);
  const after = body.slice(end);
  const blank = (line) => line !== undefined && !line.trim();
  if (insert.length) {
    const lead = before.length && !blank(before[before.length - 1]) ? [""] : [];
    const trail = after.length && !blank(after[0]) ? [""] : [];
    return [...before, ...lead, ...insert, ...trail, ...after];
  }
  if (blank(before[before.length - 1]) && (blank(after[0]) || !after.length)) {
    return after.length ? [...before, ...after.slice(1)] : before.slice(0, -1);
  }
  return [...before, ...after];
}

// Where a part goes when it is absent: after the parts before it in the board's order, else after
// the heading's trigger lines — always on a text line's boundary, never inside a fence or notes.
function insertionIndex(body, afterParts) {
  const ends = afterParts.filter(Boolean).map((part) => part.end);
  if (ends.length) return Math.max(...ends);
  const kinds = classifyBody(body);
  let index = 0;
  while (index < body.length && kinds[index] === "text" && (TRIGGER_LINE_RE.test(body[index].trim()) || !body[index].trim())) index += 1;
  if (index < body.length) return index;
  // Nothing but triggers and blanks: straight after the last trigger line.
  let last = -1;
  body.forEach((line, at) => { if (kinds[at] === "text" && TRIGGER_LINE_RE.test(line.trim())) last = at; });
  return last + 1;
}

function headingParts(heading) {
  const match = stripEol(heading).match(/^(#{1,6})\s+(.*)$/);
  if (!match) return null;
  let title = match[2].trimEnd();
  let trailer = "";
  for (;;) {
    const group = title.match(/^([\s\S]*?)(\s*\{[^}]*\})$/);
    if (!group) break;
    trailer = group[2] + trailer;
    title = group[1].trimEnd();
  }
  return { hashes: match[1], title, trailer };
}

/** The question: the heading's text without its trailing `{…}` groups. */
export function boardQuestionOf(heading) {
  return headingParts(heading)?.title ?? "";
}

/**
 * Apply one Inspector edit to a board slide's lines (heading first, then its body up to the next
 * heading). Returns the new lines; every line the edit does not concern keeps its bytes, and
 * nothing is ever written inside a code fence or a `:::notes` block.
 *
 * @param {string[]} slideLines  heading + body, without line terminators
 * @param {{ kind: 'question', text: string }
 *   | { kind: 'instructions', text: string }
 *   | { kind: 'example', text: string | null }
 *   | { kind: 'columns', columns: Array<{ label: string, hint?: string, extra?: string[], raw?: { item: string, hint: string | null } }> }} edit
 */
export function applyBoardEdit(slideLines, edit) {
  const [heading, ...rest] = slideLines;
  let body = rest.map(stripEol);
  if (edit.kind === "question") {
    const parts = headingParts(heading);
    if (!parts) return slideLines;
    const text = oneLine(edit.text);
    if (!text) return slideLines;
    return [`${parts.hashes} ${text}${parts.trailer}`, ...rest];
  }
  const read = readBoardBody(body);
  if (edit.kind === "instructions") {
    const text = oneLine(edit.text);
    const lines = text ? [escapeInstructions(text)] : [];
    if (read.instructions) body = spliceBody(body, read.instructions.start, read.instructions.end, lines);
    else if (lines.length) {
      const at = insertionIndex(body, []);
      body = spliceBody(body, at, at, lines);
    }
  } else if (edit.kind === "example") {
    const text = edit.text == null ? "" : oneLine(edit.text);
    const lines = text ? [`> Example: ${text}`] : [];
    if (read.example) body = spliceBody(body, read.example.start, read.example.end, lines);
    else if (lines.length) {
      const at = read.list && (!read.instructions || read.list.start < read.instructions.start)
        ? read.list.start
        : insertionIndex(body, [read.instructions]);
      body = spliceBody(body, at, at, lines);
    }
  } else if (edit.kind === "columns") {
    const lines = boardListLines(edit.columns, read.list?.marker ?? "-", read.list?.hintIndent || "  - ");
    if (read.list) body = spliceBody(body, read.list.start, read.list.end, lines);
    else if (lines.length) {
      const at = insertionIndex(body, [read.instructions, read.example]);
      body = spliceBody(body, at, at, lines);
    }
  } else {
    return slideLines;
  }
  return [heading, ...body];
}

/**
 * Apply a board edit to a whole outline, to the slide whose heading is at 1-based `headingLine`
 * (the slide ends at the next heading outside a code fence). Line terminators (`\n` or `\r\n`) are
 * kept; returns the outline unchanged when the line is not a heading.
 */
export function applyBoardEditToOutline(content, headingLine, edit) {
  const lines = String(content).split("\n");
  const start = headingLine - 1;
  if (!isHeading(stripEol(lines[start] ?? ""))) return content;
  const end = slideBlockEnd(lines, start);
  const crlf = lines[start].endsWith("\r") ? "\r" : "";
  const slide = lines.slice(start, end).map(stripEol);
  const next = applyBoardEdit(slide, edit);
  if (next.length === slide.length && next.every((line, index) => line === slide[index])) return content;
  const written = next.map((line, index) => {
    const original = index < slide.length && line === slide[index] ? lines[start + index] : null;
    return original ?? line + crlf;
  });
  lines.splice(start, end - start, ...written);
  return lines.join("\n");
}

/** The outline's headings — outside its front matter and outside code fences — as offsets. */
function outlineHeadings(text) {
  const headings = [];
  const lines = String(text).split("\n");
  let offset = 0;
  let index = 0;
  if (stripEol(lines[0] ?? "") === "---") {
    for (let at = 1; at < lines.length; at += 1) {
      if (stripEol(lines[at]) === "---" || stripEol(lines[at]) === "...") { index = at + 1; break; }
    }
    for (let at = 0; at < index; at += 1) offset += lines[at].length + 1;
  }
  let fence = null;
  for (; index < lines.length; index += 1) {
    const line = stripEol(lines[index]);
    if (fence) { if (closesFence(line, fence)) fence = null; }
    else if (fenceOpening(line)) fence = fenceOpening(line);
    else {
      const match = line.match(/^(#{1,6})\s/);
      if (match) headings.push({ offset, level: match[1].length });
    }
    offset += lines[index].length + 1;
  }
  return headings;
}

/** A 5-character slide id (the editor's recipe, triggerComplete.ts) not yet used in `text`. */
export function mintBoardSlideId(text, rng = Math.random) {
  const taken = new Set([...String(text).matchAll(/\{id=([^}\s]+)\}|\bid=([A-Za-z0-9-]+)/g)].map((match) => match[1] ?? match[2]));
  for (;;) {
    const id = rng().toString(36).slice(2, 7);
    if (id.length === 5 && !taken.has(id)) return id;
  }
}

/**
 * Where Insert › Board slide puts the starter: after the slide the caret is in (and its child
 * slides), at that slide's heading level — `###` when the caret is above any slide or in a `#`/`##`
 * heading, so the new board is always a slide. Headings in the front matter or in code fences do not
 * count. The starter carries `id` on its trigger line when one is given. Returns the offset to
 * insert at, the text, and the offsets of the question in the new document (to select it).
 */
export function boardStarterInsertion(text, caret, id = "") {
  const source = String(text);
  const headings = outlineHeadings(source);
  const current = headings.filter((heading) => heading.offset <= caret).at(-1);
  const currentLevel = current?.level ?? 0;
  const level = Math.max(3, currentLevel);
  let at = source.length;
  if (current) {
    // A slide's children belong to it: insert before the next heading at the same level or above.
    // A `#`/`##` heading's board becomes its first child, straight after its own lines.
    const bound = currentLevel >= 3 ? currentLevel : 6;
    const next = headings.find((heading) => heading.offset > current.offset && heading.level <= bound);
    if (next) at = next.offset;
  }
  const before = source.slice(0, at);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const insert = `${lead}${boardStarterLines(level, id).join("\n")}\n${at < source.length ? "\n" : ""}`;
  const questionFrom = at + lead.length + level + 1;
  return { at, insert, questionFrom, questionTo: questionFrom + BOARD_STARTER.question.length };
}
