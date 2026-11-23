// Opt-in chat rows. Pure source reading shared by compiler and lossless editor.
export const NATIVE_TURN_KINDS = Object.freeze(['user', 'answer', 'thought', 'tool-call', 'tool-result', 'status', 'files']);
const QUOTED = '"(?:[^"\\\\]|\\\\["\\\\])*"';
const HEADER = new RegExp(`^turn ([a-z][a-z0-9-]*) (${QUOTED})((?:[ \\t]+[a-z][a-z0-9-]*=(?:${QUOTED}|[^\\s:"]+))*)[ \\t]*:(.*)$`, 'i');
const OPTION = new RegExp(`([a-z][a-z0-9-]*)=(${QUOTED}|[^\\s:"]+)`, 'gi');
const unquote = (value) => value.startsWith('"') ? value.slice(1, -1).replace(/\\(["\\])/g, '$1') : value;
export const quoteTurnLabel = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function readTurnHeader(line, warn = () => {}) {
  const m = String(line).match(HEADER);
  if (!m) {
    if (/^turn [a-z][a-z0-9-]* "/i.test(line)) warn(['sim-turn-invalid-header']);
    return null;
  }
  const kind = m[1].toLowerCase();
  if (!NATIVE_TURN_KINDS.includes(kind)) {
    warn(['sim-turn-unknown-kind', kind]);
    return null;
  }
  const options = {};
  const warnings = [];
  for (const item of m[3].matchAll(OPTION)) {
    const name = item[1].toLowerCase();
    if (Object.hasOwn(options, name)) warnings.push(['sim-turn-duplicate-option', name]);
    options[name] = unquote(item[2]);
    if (!['open', 'id', 'ref', 'state'].includes(name)) warnings.push(['sim-turn-option-unsupported', name]);
  }
  if (options.open && !['on', 'off'].includes(options.open)) warnings.push(['sim-turn-invalid-open', options.open]);
  return { kind, label: unquote(m[2]), options, optionSource: m[3].trim(), head: m[4].replace(/^[ \t]+/, ''), warnings };
}

export function readTurnBody(head, continuation) {
  const body = head ? [head] : [];
  const detail = [];
  const warnings = [];
  let field = null;
  let details = 0;
  for (const raw of continuation) {
    // The outline counts a leading tab as two spaces; payload tabs outside the indent stay verbatim.
    const line = raw.replace(/^[ \t]*/, (indent) => indent.replace(/\t/g, '  '));
    if (/^  detail:[ \t]*$/.test(line)) {
      if (++details > 1) warnings.push(['sim-turn-duplicate-field', 'detail']);
      field = 'detail';
      continue;
    }
    if (/^  object:[ \t]*$/.test(line)) {
      warnings.push(['sim-turn-object-unsupported']);
      field = null;
      body.push('object:');
      continue;
    }
    if (field && (line.startsWith('    ') || !line.trim())) {
      detail.push(line.slice(Math.min(4, line.length)));
      continue;
    }
    field = null;
    body.push(line.replace(/^  /, '').replace(/^\\((?:detail:|object:)[ \t]*)$/, '$1'));
  }
  const trimEdges = (lines) => {
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return lines.join('\n');
  };
  return { body: trimEdges(body), detail: trimEdges(detail), warnings };
}
