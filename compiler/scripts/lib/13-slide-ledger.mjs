// Slide Ledger (ADR-0032): the in-Vault append-only per-slide version store.
// Everything here is plain Node — no Electron — so scripts/test-ledger.mjs can
// exercise it directly. Only this module touches _ledger/ on disk.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { parseOutlineTree } from "./14-outline-tree.mjs";

export const ID_TOKEN_RE = /\{id=([A-Za-z0-9_-]+)\}/;
export const COALESCE_WINDOW_MS = 3_600_000;

// A line that is ONLY `{…}` groups — the ADR-0015 Trigger line shape. Same shape as the editor's
// TRIGGER_LINE_RE (outliner.ts) and 12-outline-edit.mjs's TRIGGER_LINE_RE.
export const TRIGGER_ONLY_RE = /^\s*(\{[^}]*\}\s*)+$/;

// THE shared Trigger-line READ rule (id-churn hotfix, 2026-07-10). From a heading at `headingIdx`,
// the FIRST non-blank line within [headingIdx+1, endIdx) is the heading's Trigger line iff it is a
// `{…}`-only line — blank lines between the heading and it are TOLERATED. This matches exactly what
// the tree parser (parseOutlineTree.triggerLineAfter), the compiler scan, the migrate tool
// (triggerIndexAfter), and the WRITE path (mergeTriggerAtLine) already do; the save-path id readers
// used to look only at the line directly below the heading, so a blank-separated `{id=…}` was invisible
// to them while mergeTriggerAtLine still found and clobbered it — the id-churn bug. A fence opener or
// any content line means there is no Trigger line. Returns its index, or -1.
export function triggerLineIndex(lines, headingIdx, endIdx = lines.length) {
  for (let i = headingIdx + 1; i < endIdx; i += 1) {
    const t = lines[i].trim();
    if (t === "") continue;
    return TRIGGER_ONLY_RE.test(t) ? i : -1;
  }
  return -1;
}

// The full consecutive Trigger-only block after a heading. The first non-blank line starts it;
// every immediately following Trigger-only line belongs to the same logical Trigger line.
export function triggerLineBlock(lines, headingIdx, endIdx = lines.length) {
  const start = triggerLineIndex(lines, headingIdx, endIdx);
  if (start < 0) return null;
  let end = start + 1;
  while (end < endIdx && TRIGGER_ONLY_RE.test(lines[end].trim())) end += 1;
  return { start, end };
}

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

export function lineHasUnclosedBrace(line) {
  let depth = 0;
  for (const char of String(line)) {
    if (char === "{") depth += 1;
    else if (char === "}" && depth > 0) depth -= 1;
  }
  return depth > 0;
}

// Index of the line carrying this block's `{id=…}` — the heading itself, else its (possibly
// blank-separated) Trigger line — or -1 when the block is unstamped. The single source of truth every
// reader/writer shares so "is this slide stamped, and where does its id live?" always has one answer.
export function idLineIndex(lines, headingIdx, endIdx = lines.length) {
  if (ID_TOKEN_RE.test(lines[headingIdx])) return headingIdx;
  const window = preContentWindow(lines, headingIdx, endIdx);
  for (let line = window.end - 1; line > headingIdx; line -= 1) {
    if (ID_TOKEN_RE.test(lines[line])) return line;
  }
  return -1;
}

// 5-char base36 id, identical recipe to the editor's {-autocomplete
// (triggerComplete.ts). `taken` guards against the (rare) same-outline collision.
export function mintId(rng = Math.random, taken = new Set()) {
  for (;;) {
    const id = rng().toString(36).slice(2, 7);
    if (id.length === 5 && !taken.has(id)) return id;
  }
}

const HEADING_RE = /^(#{1,6})\s/;

// Per-line fence + comment flags. Mirrors 12-outline-edit's LENGTH-AWARE fence
// guard (an opening ``` fence of length N is closed only by a bare fence line of
// length >= N) and its HTML-comment state machine (structuralHeadings): a line
// that STARTS inside an open <!-- comment is opaque, so a heading hidden in a
// comment never terminates a block. Kept local so 13- imports nothing from 12-
// (12- imports from here; a reverse import would create a cycle). A `#` line
// inside a fence (python comments, fenced markdown) must never count as a heading.
function fencedLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceMark = "";
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const visibleAtStart = !inComment;
    // advance comment state through this line (comments may open/close mid-line,
    // span lines); comment scanning is suspended inside code fences
    if (!inFence) {
      let pos = 0;
      for (;;) {
        if (inComment) {
          const close = line.indexOf("-->", pos);
          if (close === -1) break;
          inComment = false;
          pos = close + 3;
        } else {
          const open = line.indexOf("<!--", pos);
          if (open === -1) break;
          inComment = true;
          pos = open + 4;
        }
      }
    }
    if (!visibleAtStart) { flags[i] = true; continue; }
    if (inFence) {
      flags[i] = true;
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = ""; }
      continue;
    }
    const open = t.match(/^(`{3,})/);
    if (open) { inFence = true; fenceMark = open[1]; flags[i] = true; }
  }
  return flags;
}

// Per-id `{ function: 'section'|'leaf', hasContent }` derived from the STRUCTURAL tree
// (parseOutlineTree, heading-is-slide model): a node is a 'section' iff it has children at
// record time, a 'leaf' otherwise. hasContent is true iff the node owns any non-blank line of
// its own (contentLines/notesLines) beyond its heading/Trigger line — a title-only section (all
// of its body belongs to its children) is hasContent:false. Keyed by id, not position, so the
// separate line-based block scan below (extractIdSlides) can stay untouched and merely look this
// up — the two scans may disagree on line indices (the tree strips frontmatter, normalises EOLs)
// but never on which ids exist, since both read the same {id=…} tokens.
function nodeMetaById(text) {
  const { root } = parseOutlineTree(text);
  const meta = new Map();
  const walk = (node) => {
    if (node.id) {
      const hasContent =
        node.contentLines.some((l) => l.trim() !== "") || node.notesLines.some((l) => l.trim() !== "");
      meta.set(node.id, { function: node.children.length > 0 ? "section" : "leaf", hasContent });
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return meta;
}

// Every ##–###### slide block carrying {id=…} — id read from the heading itself or the Trigger
// line (the line immediately below, ADR-0015). Heading-is-slide model (Task 8): a block runs from
// its heading to the NEXT heading of ANY depth (or EOF) — nested headings are their own separate
// blocks/ids now, never absorbed into a parent's markdown. Duplicated ids are returned as-is;
// callers decide. `function`/`hasContent` come from nodeMetaById (see above); an id with no
// matching tree node (should not happen — same text, same {id=…} tokens) falls back to a safe
// leaf/no-content default rather than throwing.
export function extractIdSlides(text) {
  const lines = String(text).split("\n");
  const fenced = fencedLineFlags(lines);
  const meta = nodeMetaById(text);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = fenced[i] ? null : lines[i].match(HEADING_RE);
    if (!m || m[1].length < 2) continue; // depth-1 `#` is the deck title, never a node
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const h = fenced[j] ? null : lines[j].match(HEADING_RE);
      if (h) { end = j; break; }
    }
    // Trigger line lookup (idLineIndex) is BOUNDED to [i, end): an adjacent stamped heading is the
    // NEXT block's heading, not this block's Trigger line; and a `{id=…}` may sit on the heading or on
    // a blank-separated `{…}`-only Trigger line below it (shared read rule — matches the tree parser
    // and the write path, so a blank-separated id is never missed and re-minted).
    const idIdx = idLineIndex(lines, i, end);
    const idMatch = idIdx >= 0 ? lines[idIdx].match(ID_TOKEN_RE) : null;
    if (idMatch) {
      const markdown = lines.slice(i, end).join("\n").replace(/\n+$/, "");
      const nodeMeta = meta.get(idMatch[1]) ?? { function: "leaf", hasContent: false };
      out.push({ id: idMatch[1], markdown, headingLine: i, function: nodeMeta.function, hasContent: nodeMeta.hasContent });
    }
    i = end - 1;
  }
  return out;
}

// Shift a block so its root heading sits at ### (ADR-0033 readiness: slides are
// stored at canonical depth; placement re-indents). Fenced lines are opaque:
// a `####`-looking line inside a code fence is content, never re-depthed.
export function normalizeDepth(markdown) {
  const lines = String(markdown).split("\n");
  const fenced = fencedLineFlags(lines);
  const root = fenced[0] ? null : lines[0]?.match(HEADING_RE);
  if (!root) return markdown;
  const delta = 3 - root[1].length;
  if (delta === 0) return markdown;
  return lines
    .map((l, i) => {
      const h = fenced[i] ? null : l.match(HEADING_RE);
      if (!h) return l;
      const depth = Math.min(6, Math.max(1, h[1].length + delta));
      return "#".repeat(depth) + l.slice(h[1].length);
    })
    .join("\n");
}

// Temp + rename so a crash mid-write can never leave a truncated version file
// (coalescing rewrites the head in place; losing it would lose history).
function writeFileAtomic(path, data) {
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort: never strand a .tmp next to the store on failure.
    try { unlinkSync(tmp); } catch { /* tmp may not exist; original error wins */ }
    throw err;
  }
}

function utcStamp(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "-" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

export function versionFileName(savedAt, talk) {
  return `${utcStamp(savedAt)}--${talk}.md`;
}

export function formatVersion({
  id, talk, outline, savedAt, sealedBy = null, lineage = null,
  function: fn = null, hasContent = null, markdown,
}) {
  const fm = [
    "---",
    `id: ${id}`,
    `talk: ${talk}`,
    `outline: ${outline}`,
    `saved_at: ${new Date(savedAt).toISOString()}`,
    ...(fn ? [`function: ${fn}`] : []),
    ...(hasContent !== null ? [`has_content: ${hasContent}`] : []),
    ...(sealedBy ? [`sealed_by: ${sealedBy}`] : []),
    ...(lineage ? [`lineage: ${lineage}`] : []),
    "---",
    "",
  ];
  return fm.join("\n") + normalizeDepth(markdown).replace(/\n+$/, "") + "\n";
}

export function parseVersion(fileText) {
  const m = String(fileText).match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = {};
  if (m) for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const markdown = m ? fileText.slice(m[0].length).replace(/^\n/, "").replace(/\n+$/, "") : String(fileText).trim();
  return {
    id: fields.id ?? null,
    talk: fields.talk ?? null,
    outline: fields.outline ?? null,
    savedAt: fields.saved_at ? Date.parse(fields.saved_at) : 0,
    function: fields.function ?? null,
    hasContent: fields.has_content === undefined ? null : fields.has_content === "true",
    sealed: Boolean(fields.sealed_by),
    sealedBy: fields.sealed_by ?? null,
    lineage: fields.lineage ?? null,
    markdown,
  };
}

// The on-disk store: `_SLIDE-VERSIONS/` at the Vault root (renamed from `_ledger` 2026-07-03 —
// the old name showed up in the folder browser and told a visitor nothing). A README lands in
// the folder so anyone browsing the Vault knows what it holds. Legacy `_ledger/` dirs migrate
// by a one-time rename, memoised per vault so the check costs one existsSync per process.
export const STORE_DIR = "_SLIDE-VERSIONS";
const migratedVaults = new Set();

const STORE_README = `# Slide version store (TalkWeaver)

Machine-managed by TalkWeaver — one folder per slide id, one markdown file per saved
version of that slide (ADR-0032 Slide Ledger). Safe to read and grep; do not hand-edit.
Deleting a folder deletes that slide's history. See the where-used & versions panel
(⌘⇧U) in TalkWeaver for the friendly view.
`;

function storeRoot(vaultRoot) {
  const root = join(vaultRoot, STORE_DIR);
  if (!migratedVaults.has(vaultRoot)) {
    migratedVaults.add(vaultRoot);
    try {
      const legacy = join(vaultRoot, "_ledger");
      if (!existsSync(root) && existsSync(legacy)) renameSync(legacy, root);
      mkdirSync(root, { recursive: true });
      if (!existsSync(join(root, "README.md"))) {
        writeFileAtomic(join(root, "README.md"), STORE_README);
      }
    } catch { /* migration is best-effort; a failure just leaves the old path in place */ }
  }
  return root;
}

function ledgerDir(vaultRoot, id) { return join(storeRoot(vaultRoot), id); }

export function listVersions(vaultRoot, id) {
  const dir = ledgerDir(vaultRoot, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((file) => ({ file, ...parseVersion(readFileSync(join(dir, file), "utf8")) }));
}

export function headVersion(vaultRoot, id) {
  return listVersions(vaultRoot, id)[0] ?? null;
}

const canon = (md) => normalizeDepth(md).replace(/\n+$/, "");

export function recordOutlineSave(vaultRoot, outlinePath, content, { now = Date.now(), lineageHints = null } = {}) {
  const result = { versioned: [], coalesced: [], unchanged: [], collisions: [] };
  const slides = extractIdSlides(content);
  const counts = new Map();
  for (const s of slides) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  const talk = basename(outlinePath).replace(/-outline\.md$/, "");
  const outlineRel = relative(vaultRoot, outlinePath).split(sep).join("/");

  for (const slide of slides) {
    if (counts.get(slide.id) > 1) {
      if (!result.collisions.includes(slide.id)) result.collisions.push(slide.id);
      continue;
    }
    try {
      const versions = listVersions(vaultRoot, slide.id);
      const head = versions[0] ?? null;
      const body = canon(slide.markdown);
      if (head && head.markdown === body) { result.unchanged.push(slide.id); continue; }
      const dir = ledgerDir(vaultRoot, slide.id);
      mkdirSync(dir, { recursive: true });
      const coalesce = Boolean(head && !head.sealed && head.talk === talk && now - head.savedAt < COALESCE_WINDOW_MS);
      // Coalescing replaces the head file, so its lineage must ride along or it is lost.
      const lineage = versions.length === 0 ? (lineageHints?.get(slide.id) ?? null) : (coalesce ? head.lineage : null);
      let savedAt = now;
      let file = versionFileName(savedAt, talk);
      // Appends must never overwrite an existing (possibly sealed) same-second file;
      // bump by 1s until free — keeps sort order and append-only semantics.
      if (!coalesce) {
        while (existsSync(join(dir, file))) {
          savedAt += 1000;
          file = versionFileName(savedAt, talk);
        }
      }
      // Write first, unlink second: if the write throws, the old head survives.
      writeFileAtomic(
        join(dir, file),
        formatVersion({
          id: slide.id, talk, outline: outlineRel, savedAt, lineage,
          function: slide.function, hasContent: slide.hasContent, markdown: slide.markdown,
        })
      );
      if (coalesce && head.file !== file) unlinkSync(join(dir, head.file));
      (coalesce ? result.coalesced : result.versioned).push(slide.id);
    } catch (err) {
      /* one broken id must not abort the sweep (ADR-0032: never endanger a save) */
      console.warn("ledger: skipped", slide.id, String(err));
    }
  }
  return result;
}

export function sealOutline(vaultRoot, outlinePath, content, reason, { now = Date.now() } = {}) {
  recordOutlineSave(vaultRoot, outlinePath, content, { now });
  const sealed = [];
  const slides = extractIdSlides(content);
  const counts = new Map();
  for (const s of slides) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  for (const slide of slides) {
    if (counts.get(slide.id) > 1) continue;
    try {
      const head = headVersion(vaultRoot, slide.id);
      if (!head || head.sealed) continue;
      writeFileAtomic(
        join(ledgerDir(vaultRoot, slide.id), head.file),
        formatVersion({ ...head, sealedBy: reason, markdown: head.markdown })
      );
      sealed.push(slide.id);
    } catch { /* per-id isolation, as in recordOutlineSave */ }
  }
  return { sealed };
}

// Seal ONE slide's head version (targeted variant of sealOutline): closes that
// id's coalesce window without touching other slides. Used by adoption so the
// loss-proof pre-record of replaced content can never be coalesced away.
export function sealSlideHead(vaultRoot, id, reason) {
  const head = headVersion(vaultRoot, id);
  if (!head || head.sealed) return false;
  writeFileAtomic(
    join(ledgerDir(vaultRoot, id), head.file),
    formatVersion({ ...head, sealedBy: reason, markdown: head.markdown })
  );
  return true;
}

const SKIP_DIRS = new Set([STORE_DIR, "_ledger", "_assets", "node_modules"]);

export function whereUsed(vaultRoot, id) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith("-outline.md")) {
        const abs = join(dir, entry.name);
        try {
          if (extractIdSlides(readFileSync(abs, "utf8")).some((s) => s.id === id)) {
            hits.push({
              talk: entry.name.replace(/-outline\.md$/, ""),
              outline: relative(vaultRoot, abs).split(sep).join("/"),
            });
          }
        } catch { /* unreadable outline: skip */ }
      }
    }
  };
  walk(vaultRoot);
  return hits;
}
