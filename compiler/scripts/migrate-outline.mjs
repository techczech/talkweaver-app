// =============================================================================
// One-time outline migration: LEGACY grammar → heading-is-slide grammar.
// =============================================================================
//
// Runs across Dominik's whole talks library, so BYTE-PRESERVATION of untouched
// lines and of every `{id=…}` token is a hard requirement — this operates
// line-wise and only ever edits heading lines, their Trigger lines, or the
// frontmatter version stamp. Nothing else is rewritten.
//
// LEGACY grammar being parsed (do NOT confuse with the new one this produces):
//   #    deck title
//   ##   section divider
//   ## X {sub}   subsection ({sub} may sit on the heading OR on the {…}-only
//                Trigger line directly below it)
//   ###  slide
//   #### card inside the preceding ### slide
//
// NEW grammar: hierarchy IS heading depth. A subsection becomes ### (one deeper
// than its ## section) and its slides/cards demote with it; legacy cards stay at
// their depth but the parent slide is marked a {carousel} container; every
// heading carries an id.
//
// Transform order (spec §6): version guard → {sub} re-level → cards → id stamping.
//
// CLI:  node compiler/scripts/migrate-outline.mjs <file...> [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseHeadingAttrs, parseTriggerLine } from "./lib/02-triggers-layout.mjs";
import { mintId, ID_TOKEN_RE } from "./lib/13-slide-ledger.mjs";

// Global id scan (ID_TOKEN_RE itself is un-anchored + no /g — reuse its source).
const ID_TOKEN_RE_G = new RegExp(ID_TOKEN_RE.source, "g");

// The four container triggers (15-sequencer.mjs containerMode). A slide already
// carrying one of these must NOT be re-flagged {carousel}.
function hasContainerTrigger(attrs) {
  return (
    attrs.carousel === true ||
    attrs["grid-linear"] === true ||
    attrs["grid-zoom"] === true ||
    attrs.contents === true
  );
}

// -----------------------------------------------------------------------------
// Opaque-line map: fence (LENGTH-AWARE) + HTML comment. Copied in spirit from
// 13-slide-ledger.mjs fencedLineFlags — a `#`-looking line inside a code fence
// (python comment, fenced markdown) or an HTML comment is NEVER a structural
// heading. A closing fence must be a backticks-only line at least as long as the
// opener, so a ``` inside a ````md wrapper does not close it. `:::notes` lines
// are NOT treated as opaque here for the same reason the compiler and
// parseOutlineTree don't: a heading resets notes, and this tool only edits
// heading lines + their trigger lines, so notes CONTENT (non-heading lines) is
// never touched anyway.
//
// REVIEW RULING (2026-07-09, do not "fix"): heading-like lines inside :::notes
// blocks ARE stamped/transformed here — deliberately. In this grammar any
// heading resets notes state in BOTH the compiler (08-source-adapters.mjs) and
// the tree parser (14-outline-tree.mjs), so a `##`–`######` line after
// :::notes is real structure, not notes text. Making :::notes opaque would
// desynchronise this tool from the parsers it feeds.
// -----------------------------------------------------------------------------
function computeOpaque(lines) {
  const flags = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceMark = "";
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    const visibleAtStart = !inComment;
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

const HEADING_RE = /^(#{1,6})(?=\s)/;
const headingLevel = (text) => { const m = text.match(HEADING_RE); return m ? m[1].length : 0; };
const headingBody = (text) => text.replace(/^#{1,6}\s+/, "").replace(/\s+$/, "");
const headingTitle = (text) => parseHeadingAttrs(headingBody(text)).title;

// Add one `#` to a heading line (## → ###). Leading position, so a trailing \r is
// left in place untouched.
const addHash = (text) => text.replace(/^(#{1,6})/, (m) => m + "#");

// Append a `{…}` token to an existing Trigger line, inserting before a trailing
// \r so CRLF files keep their line ending.
function appendToken(text, token) {
  const cr = text.endsWith("\r") ? "\r" : "";
  const core = cr ? text.slice(0, -1) : text;
  return `${core} ${token}${cr}`;
}

const isBlankOrEmptyTrigger = (text) => text.trim() === "";

// Does this heading line carry a bare `{sub}`? headingBody strips trailing
// whitespace INCLUDING a CRLF `\r` — parseHeadingAttrs's trailer peel anchors on
// `}$`, so `## X {sub}\r` would otherwise escape detection: the subsection would
// never re-level while the file still got version-stamped (silent, permanent
// hierarchy corruption; caught in review 2026-07-09).
function headingHasSub(text) {
  return parseHeadingAttrs(headingBody(text)).attrs.sub === true;
}

// Remove ONLY the `{sub}` token, preserving every other byte (other triggers,
// ids). Handles: a standalone `{sub}` group (dropped with one leading space), and
// `sub` as one token among others inside a group (`{id=x sub}` → `{id=x}`).
function removeSubToken(text) {
  const standalone = /(\s*)\{\s*sub\s*\}/;
  if (standalone.test(text)) return text.replace(standalone, "");
  return text.replace(/\{([^}]*)\}/g, (full, inner) => {
    if (!/(^|[\s,])sub($|[\s,])/.test(inner)) return full;
    let ni = inner.replace(/[\s,]sub(?=$|[\s,])/, "");   // preceding separator + sub
    if (ni === inner) ni = inner.replace(/^sub[\s,]/, ""); // sub at start + following separator
    if (ni === inner) ni = inner.replace(/^sub$/, "");     // sole token (standalone already handled)
    return `{${ni}}`;
  });
}

// From heading at recs[i], the first NON-BLANK following line is its Trigger line
// iff it is a `{…}`-only line and not opaque/a fence opener (mirrors
// triggerLineAfter in 14-outline-tree.mjs). Returns index or null.
function triggerIndexAfter(recs, opaque, i) {
  let j = i + 1;
  while (j < recs.length && recs[j].t.trim() === "") j += 1;
  if (j >= recs.length) return null;
  if (opaque[j]) return null;
  if (/^`{3,}/.test(recs[j].t.trim())) return null;
  return parseTriggerLine(recs[j].t) ? j : null;
}

// -----------------------------------------------------------------------------
// Legacy card-parent detection — MUST run on the ORIGINAL levels, before {sub}
// re-levelling, because a subsection (## {sub} → ###) and its slides (### → ####)
// end up looking exactly like a legacy ### slide with #### cards. Only a heading
// that is LITERALLY `###` with a `####` in its block is a card slide. Returns a
// Set of original 1-indexed file line numbers.
// -----------------------------------------------------------------------------
function detectCardParents(recs, opaque) {
  const parents = new Set();
  for (let i = 0; i < recs.length; i += 1) {
    if (opaque[i]) continue;
    if (headingLevel(recs[i].t) !== 3) continue;
    let hasCard = false;
    for (let j = i + 1; j < recs.length; j += 1) {
      if (opaque[j]) continue;
      const lvl = headingLevel(recs[j].t);
      if (lvl === 0) continue;
      if (lvl <= 3) break;         // next slide/section ends this block
      if (lvl === 4) { hasCard = true; break; } // a legacy #### card
    }
    if (hasCard) parents.add(recs[i].o);
  }
  return parents;
}

// =============================================================================
// migrateOutline(text) → { text, changed, report }
// =============================================================================
export function migrateOutline(text) {
  const src = String(text ?? "");
  const report = []; // { line: number, msg: string }

  const lines = src.split("\n"); // split on \n only: any \r stays in the line text (byte-preserving)

  // Dominant line ending, detected once: newly INSERTED lines ({carousel} / {id=…}
  // trigger lines, created frontmatter) carry a trailing `\r` in a CRLF document so
  // the migration never produces mixed endings. Existing lines keep their own bytes.
  const nlCount = lines.length - 1;
  const crCount = lines.slice(0, Math.max(0, nlCount)).filter((l) => l.endsWith("\r")).length;
  const eol = nlCount > 0 && crCount > nlCount / 2 ? "\r" : "";

  // --- Frontmatter locate + version guard -----------------------------------
  const fmClose = (() => {
    if (!lines.length || !/^---\s*$/.test(lines[0])) return -1;
    for (let j = 1; j < lines.length; j += 1) if (/^---\s*$/.test(lines[j])) return j;
    return -1; // unterminated → treat as no frontmatter
  })();

  let bodyStart;
  let fmLines; // the (possibly edited) frontmatter block lines, or [] when created
  let createdFrontmatter = false;

  if (fmClose >= 0) {
    fmLines = lines.slice(0, fmClose + 1);
    bodyStart = fmClose + 1;
    // Look for an existing outline_version key.
    let verIdx = -1;
    let verVal = null;
    let indent = "";
    for (let i = 1; i < fmClose; i += 1) {
      const m = fmLines[i].match(/^(\s*)outline_version\s*:\s*(.*?)\s*$/);
      if (m) { verIdx = i; verVal = m[2]; indent = m[1]; }
    }
    if (verVal === "2") {
      return { text: src, changed: false, report: [] }; // already migrated — exact no-op
    }
    if (verIdx >= 0) {
      // Preserve the replaced line's own ending (it may differ in a mixed file).
      const lineCr = fmLines[verIdx].endsWith("\r") ? "\r" : "";
      fmLines[verIdx] = `${indent}outline_version: 2${lineCr}`;
      report.push({ line: verIdx + 1, msg: `set outline_version: 2` });
    } else {
      fmLines.splice(fmClose, 0, `outline_version: 2${eol}`); // insert before the closing ---
      report.push({ line: fmClose + 1, msg: `added outline_version: 2 to frontmatter` });
    }
  } else {
    fmLines = [`---${eol}`, `outline_version: 2${eol}`, `---${eol}`];
    bodyStart = 0;
    createdFrontmatter = true;
    report.push({ line: 1, msg: `created frontmatter with outline_version: 2` });
  }

  // Body records carry their ORIGINAL 1-indexed file line number for reporting.
  const recs = lines.slice(bodyStart).map((t, k) => ({ t, o: bodyStart + k + 1 }));

  // Card parents on ORIGINAL levels (before any re-levelling).
  const cardParents = detectCardParents(recs, computeOpaque(recs.map((r) => r.t)));

  // --- Pass A: {sub} re-level -----------------------------------------------
  {
    const opaque = computeOpaque(recs.map((r) => r.t));
    const del = new Set();
    let demote = false;
    for (let i = 0; i < recs.length; i += 1) {
      if (opaque[i]) continue;
      const level = headingLevel(recs[i].t);
      if (level === 0 || level === 1) continue; // deck title / non-heading: leave demote state alone
      if (level === 2) {
        const onHeading = headingHasSub(recs[i].t);
        const tj = triggerIndexAfter(recs, opaque, i);
        const onTrigger = tj != null && parseTriggerLine(recs[tj].t)?.attrs.sub === true;
        if (onHeading || onTrigger) {
          const title = headingTitle(recs[i].t);
          recs[i].t = addHash(recs[i].t); // ## → ###
          if (onHeading) recs[i].t = removeSubToken(recs[i].t);
          if (onTrigger) {
            const cleaned = removeSubToken(recs[tj].t);
            if (isBlankOrEmptyTrigger(cleaned)) {
              del.add(tj);
              report.push({ line: recs[tj].o, msg: `removed empty {sub} trigger line` });
            } else {
              recs[tj].t = cleaned;
              report.push({ line: recs[tj].o, msg: `removed {sub} from trigger line` });
            }
          }
          demote = true;
          report.push({ line: recs[i].o, msg: `{sub} subsection re-levelled ##→### (${title})` });
        } else {
          demote = false; // a plain section closes the current subsection block
        }
      } else if (demote) {
        // level >= 3 inside an open subsection block: demote one level.
        const title = headingTitle(recs[i].t);
        recs[i].t = addHash(recs[i].t);
        report.push({ line: recs[i].o, msg: `demoted ${"#".repeat(level)}→${"#".repeat(level + 1)} (${title})` });
      }
    }
    if (del.size) {
      const kept = recs.filter((_, i) => !del.has(i));
      recs.length = 0;
      recs.push(...kept);
    }
  }

  // --- Pass B: legacy cards → {carousel} on the parent slide ----------------
  {
    const opaque = computeOpaque(recs.map((r) => r.t));
    const ops = []; // { kind: 'append'|'insert', idx, o, title }
    for (let i = 0; i < recs.length; i += 1) {
      if (opaque[i]) continue;
      if (!cardParents.has(recs[i].o)) continue;
      const hAttrs = parseHeadingAttrs(headingBody(recs[i].t)).attrs;
      const tj = triggerIndexAfter(recs, opaque, i);
      const tAttrs = tj != null ? parseTriggerLine(recs[tj].t)?.attrs || {} : {};
      if (hasContainerTrigger(hAttrs) || hasContainerTrigger(tAttrs)) continue; // already a container
      const title = headingTitle(recs[i].t);
      if (tj != null) ops.push({ kind: "append", idx: tj, o: recs[i].o, title });
      else ops.push({ kind: "insert", idx: i, o: recs[i].o, title });
    }
    // Apply high index → low so earlier indices stay valid across splices.
    ops.sort((a, b) => b.idx - a.idx);
    for (const op of ops) {
      if (op.kind === "append") recs[op.idx].t = appendToken(recs[op.idx].t, "{carousel}");
      else recs.splice(op.idx + 1, 0, { t: `{carousel}${eol}`, o: op.o });
      report.push({ line: op.o, msg: `added {carousel} to card slide (${op.title})` });
    }
  }

  // --- Pass C: stamp {id=…} on every un-stamped heading, on its TRIGGER line -
  // Per spec §6.4 the id lands on the Trigger line (created if absent), so the
  // heading text itself stays clean (`### History`, not `### History {id=…}`).
  // Existing ids on either the heading OR the trigger line are honoured and never
  // duplicated. Reuses a {carousel} trigger line minted in Pass B when present.
  {
    const opaque = computeOpaque(recs.map((r) => r.t));
    const taken = new Set();
    for (const r of recs) for (const m of r.t.matchAll(ID_TOKEN_RE_G)) taken.add(m[1]);
    for (const line of fmLines) for (const m of line.matchAll(ID_TOKEN_RE_G)) taken.add(m[1]);

    const ops = []; // { kind: 'append'|'insert', idx, o, id, title }
    for (let i = 0; i < recs.length; i += 1) {
      if (opaque[i]) continue;
      const level = headingLevel(recs[i].t);
      if (level < 2) continue; // deck title (#) is never a node
      if (ID_TOKEN_RE.test(recs[i].t)) continue; // id already on the heading
      const tj = triggerIndexAfter(recs, opaque, i);
      if (tj != null && ID_TOKEN_RE.test(recs[tj].t)) continue; // id already on the trigger line
      const id = mintId(Math.random, taken);
      taken.add(id);
      const title = headingTitle(recs[i].t);
      if (tj != null) ops.push({ kind: "append", idx: tj, o: recs[i].o, id, title });
      else ops.push({ kind: "insert", idx: i, o: recs[i].o, id, title });
    }
    ops.sort((a, b) => b.idx - a.idx); // high → low so splices don't shift pending indices
    for (const op of ops) {
      if (op.kind === "append") recs[op.idx].t = appendToken(recs[op.idx].t, `{id=${op.id}}`);
      else recs.splice(op.idx + 1, 0, { t: `{id=${op.id}}${eol}`, o: op.o });
      report.push({ line: op.o, msg: `stamped {id=${op.id}} (${op.title})` });
    }
  }

  // --- Reassemble -----------------------------------------------------------
  const bodyText = recs.map((r) => r.t);
  const outLines = createdFrontmatter ? [...fmLines, ...bodyText] : [...fmLines, ...bodyText];
  const out = outLines.join("\n");

  report.sort((a, b) => a.line - b.line);
  const reportStrings = report.map((r) => `line ${r.line}: ${r.msg}`);
  return { text: out, changed: reportStrings.length > 0, report: reportStrings };
}

// =============================================================================
// CLI
// =============================================================================
function main(argv) {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const files = args.filter((a) => a !== "--check");
  if (files.length === 0) {
    console.error("usage: node compiler/scripts/migrate-outline.mjs <file...> [--check]");
    process.exit(2);
  }
  let failed = 0;
  let changedFiles = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      console.error(`${file}: cannot read: ${err.message}`);
      failed += 1;
      continue;
    }
    let result;
    try {
      result = migrateOutline(text);
    } catch (err) {
      console.error(`${file}: FAILED to migrate: ${err.message}`);
      failed += 1;
      continue;
    }
    console.log(`\n${file}${check ? " (check)" : ""}:`);
    for (const line of result.report) console.log(`  ${line}`);
    if (!result.changed) {
      console.log("  summary: no changes (already migrated or nothing to do)");
      continue;
    }
    changedFiles += 1;
    console.log(`  summary: ${result.report.length} change(s)`);
    if (!check) {
      try {
        writeFileSync(`${file}.bak`, text); // .bak written BEFORE overwriting
        writeFileSync(file, result.text);
        console.log(`  wrote ${file} (backup: ${file}.bak)`);
      } catch (err) {
        console.error(`${file}: write failed: ${err.message}`);
        failed += 1;
      }
    }
  }
  console.log(
    `\n${check ? "checked" : "migrated"} ${files.length} file(s), ${changedFiles} would${check ? "" : " and did"} change, ${failed} failed`
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
