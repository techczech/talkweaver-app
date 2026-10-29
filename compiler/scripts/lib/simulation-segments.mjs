// Lossless rows of a chat, terminal or trace fence body, for the editor's structured editors
// (ADR-0042; design-fenced-block-objects-and-structured-chat-editor-2026-10-28.md §6.3, §7).
//
// The deck's parsers (parseSimulationTurns, parseShellSession, parseTrace) join paragraphs, dedent and
// trim, so they cannot write text back. These segmenters split the SAME lines with the SAME tests and
// keep every byte: a row's `lines` are the raw lines it owns (a CRLF line keeps its "\r"), the text
// before the first row is the preamble, and joining preamble and rows with "\n" gives the body back.
// An unchanged row is always written back from its own lines. Pure: no fs, no DOM.
import { isTraceHeaderLine } from "./02-triggers-layout.mjs";

export const LABEL_RE = /^(user|bot|model-reasoning|context-retrieval|tool-call|tool-results)(?:[ \t]*\(([^)]*)\))?[ \t]*:(.*)$/i;
export const UNKNOWN_LABEL_RE = /^(assistant|model|agent|ai|system|human|reasoning|thinking|agent-reasoning|tool|tool-use|tool-result|tool-calls|context|retrieval)(?:[ \t]*\([^)]*\))?[ \t]*:/i;
export const NEAREST_LABEL = Object.freeze({
  assistant: "bot", model: "bot", agent: "bot", ai: "bot", system: "user", human: "user",
  reasoning: "model-reasoning", thinking: "model-reasoning", "agent-reasoning": "model-reasoning",
  tool: "tool-call", "tool-use": "tool-call", "tool-calls": "tool-call",
  "tool-result": "tool-results", context: "context-retrieval", retrieval: "context-retrieval"
});
export const TURN_ROLES = Object.freeze(["user", "bot", "model-reasoning", "context-retrieval", "tool-call", "tool-results"]);
export const PROMPT_ONLY_RE = /^(?:(\S+) )?\$\s*$/;
export const COMMAND_RE = /^(?:(\S+) )?\$ (.*)$/;

const stripCr = (line) => line.replace(/\r$/, "");
const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/** The body's line ending for lines the editor writes: CRLF when any line of it ends so. */
export function bodyLineEnding(body) {
  return String(body ?? "").includes("\r\n") ? "\r\n" : "\n";
}

function commonIndent(lines) {
  let min = Infinity;
  for (const line of lines) if (stripCr(line).trim()) min = Math.min(min, indentOf(stripCr(line)));
  return Number.isFinite(min) ? min : 0;
}

/** Split a row's content lines from the blank lines after it (kept with the row, never shown as content). */
function splitGap(lines) {
  let end = lines.length;
  while (end > 0 && !stripCr(lines[end - 1]).trim()) end -= 1;
  return { content: lines.slice(0, end), gap: lines.slice(end) };
}

/**
 * Labelled turns (chat, chat-lanes, terminal-agent), split as parseSimulationTurns reads them: the body
 * is dedented by its common indent, then a line matching LABEL_RE opens a turn; a near-miss label
 * (`assistant:`) stays inside the turn above, as the compiler reads it.
 * → { kind: "turns", indent, preamble: string[], rows: [{ role, duration, content, headOnLabel, lines, gap }] }
 *   `content` is the author's text as written (the label line's text after the colon, then the
 *   continuation lines without the common indent), `duration` the parenthesis text or null.
 */
export function splitTurnSegments(body) {
  const raw = String(body ?? "").split("\n");
  const indent = commonIndent(raw);
  const preamble = [];
  const rows = [];
  let current = null;
  for (const line of raw) {
    const text = stripCr(line).slice(Math.min(indent, indentOf(stripCr(line))));
    const label = text.match(LABEL_RE);
    if (label) {
      current = { label, lines: [line] };
      rows.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return {
    kind: "turns",
    indent,
    preamble,
    rows: rows.map(({ label, lines }) => {
      const { content, gap } = splitGap(lines);
      const head = label[3].replace(/^[ \t]+/, "");
      const rest = content.slice(1).map((line) => stripCr(line).slice(Math.min(indent, indentOf(stripCr(line)))));
      return {
        role: label[1].toLowerCase(),
        duration: label[2] === undefined ? null : label[2],
        content: [...(head ? [head] : []), ...rest].join("\n"),
        headOnLabel: Boolean(head),
        lines,
        contentLength: content.length,
        gap
      };
    })
  };
}

/** Unknown-label hints for a turn's content (compiler code sim-unknown-label), as `{ line, word, nearest }`. */
export function turnContentHints(content) {
  const out = [];
  String(content ?? "").split("\n").forEach((line, index) => {
    if (index === 0) return;
    const m = line.match(UNKNOWN_LABEL_RE);
    if (m) out.push({ line: index, word: m[1].toLowerCase(), nearest: NEAREST_LABEL[m[1].toLowerCase()] });
  });
  return out;
}

/**
 * A shell session (terminal), split as parseShellSession reads it: a prompt line (`path $ command` or a
 * bare `$`, not `\`-escaped) opens a command block; the lines after it, up to the next prompt line, are its
 * output, verbatim. Output before any prompt is the preamble.
 * → { kind: "shell", preamble, rows: [{ path, command, promptOnly, output, lines }] }
 */
export function splitShellSegments(body) {
  const raw = String(body ?? "").split("\n");
  const preamble = [];
  const rows = [];
  let current = null;
  for (const line of raw) {
    const text = stripCr(line);
    const escaped = text.startsWith("\\") && (PROMPT_ONLY_RE.test(text.slice(1)) || COMMAND_RE.test(text.slice(1)));
    const bare = !escaped && text.match(PROMPT_ONLY_RE);
    const typed = !escaped && !bare && text.match(COMMAND_RE);
    if (bare || typed) {
      const m = bare || typed;
      current = { path: m[1] ?? "", command: bare ? "" : m[2], promptOnly: Boolean(bare), lines: [line] };
      rows.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return {
    kind: "shell",
    preamble,
    rows: rows.map((row) => ({ ...row, output: row.lines.slice(1).map(stripCr).join("\n") }))
  };
}

/**
 * A ```trace body, split on parseTrace's own header test: each row is a header line kept as written and
 * the body lines under it. Lines before the first header are the preamble (the deck ignores them).
 * → { kind: "trace", preamble, rows: [{ header, content, lines }] }
 */
export function splitTraceSegments(body) {
  const raw = String(body ?? "").split("\n");
  const preamble = [];
  const rows = [];
  let current = null;
  for (const line of raw) {
    if (isTraceHeaderLine(stripCr(line))) {
      current = { lines: [line] };
      rows.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return {
    kind: "trace",
    preamble,
    rows: rows.map((row) => ({ header: stripCr(row.lines[0]), content: row.lines.slice(1).map(stripCr).join("\n"), lines: row.lines }))
  };
}

export function splitSegments(kind, body) {
  if (kind === "turns") return splitTurnSegments(body);
  if (kind === "shell") return splitShellSegments(body);
  return splitTraceSegments(body);
}

/**
 * The lines one edited row writes. `row.original` (the row as split) is written back byte for byte when
 * the row's fields equal it; otherwise the row is generated from its fields with `eol` line endings and
 * the common `indent`, and its blank-line gap is kept.
 */
function rowLines(kind, row, eol, indent) {
  const cr = eol === "\r\n" ? "\r" : "";
  const o = row.original;
  if (o && rowUnchanged(kind, row, o)) return o.lines;
  const pad = " ".repeat(indent);
  const gap = o?.gap ?? [];
  if (kind === "turns") {
    const label = `${row.role}${row.duration !== null && row.duration !== undefined ? ` (${row.duration})` : ""}:`;
    const parts = String(row.content ?? "").split("\n");
    const headOnLabel = o ? o.headOnLabel && parts[0] !== "" : parts[0] !== "";
    const out = headOnLabel
      ? [`${pad}${label} ${parts[0]}`, ...parts.slice(1).map((line) => (line ? `${pad}${line}` : line))]
      : [`${pad}${label}`, ...(parts.length === 1 && parts[0] === "" ? [] : parts).map((line) => (line ? `${pad}${line}` : line))];
    return [...out.map((line) => line + cr), ...gap];
  }
  if (kind === "shell") {
    const prompt = `${row.path ? `${row.path} ` : ""}$${row.command ? ` ${row.command}` : ""}`;
    const output = String(row.output ?? "");
    return [prompt, ...(output === "" && !(o && o.lines.length > 1) ? [] : output.split("\n"))].map((line) => line + cr);
  }
  const content = String(row.content ?? "");
  return [row.header, ...(content === "" && !(o && o.lines.length > 1) ? [] : content.split("\n"))].map((line) => line + cr);
}

function rowUnchanged(kind, row, o) {
  if (kind === "turns") return row.role === o.role && (row.duration ?? null) === (o.duration ?? null) && row.content === o.content;
  if (kind === "shell") return row.path === o.path && row.command === o.command && row.output === o.output;
  return row.header === o.header && row.content === o.content;
}

/**
 * The body for edited rows. `split` is what splitSegments returned for the original body; `rows` are the
 * editor's rows, each `{ ...fields, original?: <row of split> }`; `preamble` the lines before the first
 * row as edited. When nothing changed (same preamble, same rows, same order, same fields) the original
 * body is returned unchanged.
 */
export function serialiseSegments(kind, body, split, rows, preamble = split.preamble) {
  const unchanged = preamble.join("\n") === split.preamble.join("\n")
    && rows.length === split.rows.length
    && rows.every((row, index) => row.original === split.rows[index] && rowUnchanged(kind, row, row.original));
  if (unchanged) return String(body ?? "");
  const eol = bodyLineEnding(body);
  const indent = split.indent ?? 0;
  const lines = [...preamble];
  // The body's own last line has no line ending; when rows now follow it, it takes the body's ending
  // (a turn added after the last one in a CRLF body must not leave one LF line behind).
  const lastOriginal = split.rows[split.rows.length - 1];
  rows.forEach((row, index) => {
    const out = rowLines(kind, row, eol, indent);
    if (eol === "\r\n" && index < rows.length - 1 && row.original && row.original === lastOriginal && out === row.original.lines) {
      const end = out.length - 1;
      lines.push(...out.slice(0, end), out[end].endsWith("\r") ? out[end] : `${out[end]}\r`);
    } else lines.push(...out);
  });
  // The body never ends with a line ending of its own (the closing marker's line, and the separator
  // before it, come after it): a last line GENERATED with "\r" drops it. A body that itself ended in "\r"
  // (a caller that cut it with the separator's CR inside) keeps it, so nothing outside the edit changes.
  if (lines.length && !String(body ?? "").endsWith("\r")) lines[lines.length - 1] = lines[lines.length - 1].replace(/\r$/, "");
  return lines.join("\n");
}

/** A short stable hash of a string (FNV-1a, hex), for the agent verbs' expected-content checks. */
export function segmentHash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
