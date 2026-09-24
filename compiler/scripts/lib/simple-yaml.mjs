// The frontmatter reader (moved verbatim out of 08-source-adapters.mjs, T32, 2026-09-23).
// Pure — no node: imports — so the app's renderer reads a deck's `defaults:` / `sections:` maps
// with the compiler's own parser instead of a copy (src/shared/deck-frame.ts).

function parseYamlScalar(value) {
  const trimmed = String(value).trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "[]") return [];
  if (/^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseInlineMap(s) {
  const body = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  const obj = {};
  for (const pair of body.split(",")) {
    const i = pair.indexOf(":"); if (i < 0) continue;
    obj[pair.slice(0, i).trim()] = parseYamlScalar(pair.slice(i + 1).trim());
  }
  return obj;
}

export function parseSimpleYaml(value) {
  const data = {};
  let parentKey = null;
  for (const rawLine of value.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const childMatch = rawLine.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (childMatch && parentKey && typeof data[parentKey] === "object" && !Array.isArray(data[parentKey])) {
      const childScalar = childMatch[2];
      data[parentKey][childMatch[1]] = (childScalar.startsWith("{") && childScalar.trimEnd().endsWith("}"))
        ? parseInlineMap(childScalar)
        : parseYamlScalar(childScalar);
      continue;
    }
    const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const scalar = match[2];
    if (scalar.startsWith("{") && scalar.trimEnd().endsWith("}")) {
      data[key] = parseInlineMap(scalar);
      parentKey = null;
    } else if (scalar === "") {
      data[key] = {};
      parentKey = key;
    } else {
      data[key] = parseYamlScalar(scalar);
      parentKey = null;
    }
  }
  return data;
}
