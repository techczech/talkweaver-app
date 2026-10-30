// The simulation readings the deck and the app's editor share, with no rendering and no file access:
// a labelled-turn body as parseSimulationTurns reads it, a shell session (parseShellSession), and how many
// rows the deck reads in a body (compiledRowCount). simulation-layout.mjs draws from these.
import { parseTrace } from "./02-triggers-layout.mjs";
import { LABEL_RE, PROMPT_ONLY_RE, COMMAND_RE } from "./simulation-segments.mjs";

const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/** Strip the indent common to every non-blank line. */
export function dedent(lines) {
  let min = Infinity;
  for (const line of lines) if (line.trim()) min = Math.min(min, indentOf(line));
  if (!Number.isFinite(min) || min === 0) return lines.slice();
  return lines.map((line) => line.slice(Math.min(min, indentOf(line))));
}

/** A labelled-turn body as parseSimulationTurns reads it: line endings unified, common indent removed. */
export function turnSource(text) {
  return dedent(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

/**
 * Parse a shell session (spec 1.6). Returns { cmds, cursor, warnings }.
 * cmd = { prompt, command|null, out[] }: `command` is null for output that precedes any command.
 * cursor = { prompt }: the closing prompt with the block cursor (the fence's own last prompt-only
 * line, or one added automatically with the current path).
 */
export function parseShellSession(text) {
  const warnings = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) {
    warnings.push(["sim-empty"]);
    return { cmds: [], cursor: { prompt: "$" }, warnings };
  }
  const promptFor = (path) => (path ? `${path} $` : "$");
  let path = "";
  const cmds = [];
  let cursor = null;
  lines.forEach((raw, i) => {
    const escaped = raw.startsWith("\\") && (PROMPT_ONLY_RE.test(raw.slice(1)) || COMMAND_RE.test(raw.slice(1)));
    const line = escaped ? raw.slice(1) : raw;
    const bare = !escaped && line.match(PROMPT_ONLY_RE);
    const typed = !escaped && !bare && line.match(COMMAND_RE);
    if (bare || typed) {
      const match = bare || typed;
      if (match[1]) path = match[1];
      if (bare && i === lines.length - 1) { cursor = { prompt: promptFor(path) }; return; }
      cmds.push({ prompt: promptFor(path), command: bare ? "" : match[2], out: [] });
      return;
    }
    if (!cmds.length) cmds.push({ prompt: "", command: null, out: [] });
    cmds[cmds.length - 1].out.push(line);
  });
  return { cmds, cursor: cursor || { prompt: promptFor(path) }, warnings };
}

/**
 * How many rows the deck reads in a simulation body, by the readings that draw it: labelled turns as
 * parseSimulationTurns opens them (one per label line), terminal commands as parseShellSession reads
 * them (each prompt line, the closing prompt-only line included; output before any prompt is not a
 * command), trace turns as parseTrace opens them. The editor's row model is checked against this, so a
 * row the deck would split or merge is never written. `kind`: "turns" | "shell" | "trace".
 */
export function compiledRowCount(kind, text) {
  if (kind === "turns") return turnSource(text).filter((line) => LABEL_RE.test(line)).length;
  if (kind === "shell") {
    const session = parseShellSession(text);
    const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const closing = lines.length > 0 && PROMPT_ONLY_RE.test(lines[lines.length - 1]) ? 1 : 0;
    return session.cmds.filter((cmd) => cmd.command !== null).length + closing;
  }
  return parseTrace(String(text ?? "").split("\n")).length;
}
