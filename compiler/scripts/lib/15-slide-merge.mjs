// Duplicate-slide merge (ADR-0032): unify byte-identical slide copies scattered across talks under
// ONE shared {id=…}, so the Slide Ledger holds a single entry (where-used across N talks) and
// future searches show just one card. Plain Node — no Electron — so scripts/test-merge.mjs
// exercises it directly; Task 8's IPC layer is a thin wrapper. Depends on 12-outline-edit (block
// location + setSlideId) and 13-slide-ledger (id tokens, ledger record, version counts). Never
// imports 14-slide-propagation.
//
// Loss-proofness: every re-id goes through recordOutlineSave, so the pre-merge content is versioned
// first and the post-merge content becomes the (fresh) head — nothing is discarded. Old ids' ledger
// dirs are LEFT IN PLACE as orphaned history (greppable; the change's lineage rides on the canonical
// id's first version via lineageHints). We never delete a version folder.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listSlideBlocks, setSlideId } from "./12-outline-edit.mjs";
import {
  extractIdSlides, normalizeDepth, listVersions, recordOutlineSave, mintId, ID_TOKEN_RE, idLineIndex,
} from "./13-slide-ledger.mjs";

// Local copy of 13's writeFileAtomic (not exported there): temp + rename so a crash mid-write can
// never leave a truncated outline behind. Same discipline as 14-slide-propagation's local copy.
// (The fence/comment scanner 14 also copies is NOT needed here: block location comes from
// listSlideBlocks and current ids from the heading/Trigger line only — both already fence-safe.)
function writeFileAtomic(path, data) {
  const tmp = path + ".tmp";
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist; original error wins */ }
    throw err;
  }
}

// Comparison canon — MUST be exactly the rule recordOutlineSave stores with (normalizeDepth then
// strip trailing newlines), so a block's stored version and its in-outline form agree byte-for-byte.
const canon = (md) => normalizeDepth(md).replace(/\n+$/, "");

// The identity key for the merge guard: a block's canon markdown with every {id=…} token removed,
// so copies that differ ONLY in which id they carry (or carry none) compare EQUAL, while any real
// content/trigger/whitespace difference does not. This is STRICTER than the projection's content_hash
// (10-projections.mjs — lowercased, whitespace-collapsed, markdown-stripped, id-independent): it
// PRESERVES case, inline markdown, non-id triggers and line structure. The Browser mirrors THIS key
// (slideBrowserModel.ts identityCanon) to cluster its "identical" (mergeable) bucket — so the guard
// below never refuses in normal use — and uses the looser content_hash only for its separate
// "near-identical" (uncollapsible, no-merge) bucket. A line that holds an id token has its whitespace
// collapsed after the token is stripped (a lone-id Trigger line drops entirely; an id trailing a
// shared `{layout id=…}` group leaves `{layout}`); prose lines never carry id tokens and so compare
// verbatim. Deliberately strict: a content_hash cluster whose sources are NOT truly identical (e.g.
// same text, different layout trigger) yields differing keys and the whole merge is refused — never a
// silent mis-merge.
function identityKey(md) {
  const out = [];
  for (const raw of canon(md).split("\n")) {
    if (!ID_TOKEN_RE.test(raw)) { out.push(raw); continue; }
    const stripped = raw.replace(new RegExp(ID_TOKEN_RE.source, "g"), "").replace(/\s+/g, " ").trim();
    if (stripped === "") continue; // the line was only the id token (a lone-id Trigger line)
    out.push(stripped);
  }
  return out.join("\n");
}

// Locate a block by { heading, occurrence } — replicates 12-outline-edit's (unexported) findBlock.
function findBlockByRef(text, ref) {
  const occurrence = ref.occurrence || 1;
  const found = listSlideBlocks(text).find((b) => b.heading === ref.heading && b.occurrence === occurrence);
  if (!found) {
    throw new Error(`slide-merge: block not found (heading=${JSON.stringify(ref.heading)} occurrence=${occurrence})`);
  }
  return found;
}

// The {id=…} of a located block: heading line, or its (possibly BLANK-separated) Trigger line —
// the SHARED read rule (idLineIndex, id-churn hotfix 2026-07-10), the same one extractIdSlides and
// setSlideId use. The old one-line-below read missed blank-separated ids, so a merge whose targets
// all carried them saw existingIds=[] and minted a fresh canonical id, orphaning every target's
// ledger history in one shot. null when unstamped. Fence-safe by construction: listSlideBlocks
// yields only real headings, and an id can sit only on the heading or its Trigger line.
function blockIdOf(lines, block) {
  const idx = idLineIndex(lines, block.start, block.end);
  return idx >= 0 ? lines[idx].match(ID_TOKEN_RE)[1] : null;
}

// Merge byte-identical slide copies to one shared id.
//   vaultRoot   absolute vault root.
//   targets     [{ outline /* vault-relative */, heading /* verbatim ### line */, occurrence }].
//   returns     { ok:false, reason, offending[] }                      — refused (see reasons below)
//            or { ok:true, canonicalId, merged:[{outline, oldId|null}], failed:[{outline, error}] }
// Refusal reasons: 'no-targets' (empty input), 'no-located-targets' (none could be read/located),
// 'not-identical' (located blocks are not byte-identical modulo their ids — `offending` lists the
// targets that differ from the first). Per-target isolation applies only AFTER the identity guard:
// a target whose outline cannot be read (Phase 1) or written (Phase 2) lands in `failed`, and the
// rest proceed.
// `_setSlideId` is a test seam (defaults to the real stamp) — the F5 read-back test injects a
// broken stamp through it to prove a stamp that does not read back becomes an honest failure.
export function mergeDuplicateSlides(vaultRoot, targets, { now = Date.now(), _setSlideId = setSlideId } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, reason: "no-targets", offending: [] };
  }

  // Read each outline at most once; the map is also the live buffer Phase 2 writes back into.
  const contentByOutline = new Map();
  const readOutline = (rel) => {
    if (!contentByOutline.has(rel)) contentByOutline.set(rel, readFileSync(join(vaultRoot, rel), "utf8"));
    return contentByOutline.get(rel);
  };

  // ── Phase 1: read + locate every target (per-target isolation on read/locate failures) ──
  const located = []; // { target, outline, start, key, id }
  const failed = [];  // { outline, error }
  for (const target of targets) {
    const outline = target.outline;
    try {
      const text = readOutline(outline);
      const block = findBlockByRef(text, target);
      const lines = text.split("\n");
      located.push({
        target,
        outline,
        start: block.start,
        key: identityKey(lines.slice(block.start, block.end).join("\n")),
        id: blockIdOf(lines, block),
      });
    } catch (err) {
      failed.push({ outline, error: String(err?.message ?? err) });
    }
  }
  if (located.length === 0) {
    return { ok: false, reason: "no-located-targets", offending: [], failed };
  }

  // ── Phase 2: identity guard — refuse the WHOLE merge if any located block differs ──
  const key0 = located[0].key;
  const offending = located.filter((l) => l.key !== key0).map((l) => l.target);
  if (offending.length > 0) {
    return { ok: false, reason: "not-identical", offending };
  }

  // ── Phase 3: choose the canonical id ──
  const existingIds = [];
  for (const l of located) if (l.id && !existingIds.includes(l.id)) existingIds.push(l.id);
  let canonicalId;
  if (existingIds.length > 0) {
    // The id with the most recorded ledger versions wins (it carries the richest history);
    // ties break to the lexicographically first id, purely for determinism.
    canonicalId = existingIds
      .map((id) => ({ id, n: listVersions(vaultRoot, id).length }))
      .sort((a, b) => (b.n - a.n) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0].id;
  } else {
    // No copy carries an id — mint a fresh one, guarded against EVERY id already present anywhere
    // in the located target outlines so the new id cannot collide with an unrelated slide.
    const taken = new Set();
    for (const rel of new Set(located.map((l) => l.outline))) {
      for (const m of readOutline(rel).matchAll(new RegExp(ID_TOKEN_RE.source, "g"))) taken.add(m[1]);
    }
    canonicalId = mintId(Math.random, taken);
  }

  // ── Phase 4: stamp every located target with canonicalId — one atomic write + one ledger
  //    record per outline (a shared write makes isolation per-outline for co-located targets) ──
  // NOTE: two targets in the SAME outline both stamped canonicalId create an intra-outline id
  // collision, which ADR-0032's recordOutlineSave detects and declines to version (leaving that
  // outline's canonical unversioned). Duplicate merge is a CROSS-talk affordance, so this only
  // arises for two identical copies inside one talk; the stamp still succeeds and other outlines
  // version the id cleanly. We do not attempt to further de-duplicate within a single outline.
  const merged = [];
  const byOutline = new Map();
  for (const l of located) {
    if (!byOutline.has(l.outline)) byOutline.set(l.outline, []);
    byOutline.get(l.outline).push(l);
  }
  for (const [outline, group] of byOutline) {
    try {
      const original = readOutline(outline);
      let text = original;
      // Stamp bottom-to-top so an inserted Trigger line / rewritten heading below never disturbs a
      // not-yet-stamped block above. The ref is re-derived from the CURRENT text at each block's
      // tracked start line (occurrence recomputed by listSlideBlocks, so it stays exact).
      const sorted = [...group].sort((a, b) => b.start - a.start);
      const verified = new Map(); // located → did canonicalId read back on its block?
      for (const l of sorted) {
        const block = listSlideBlocks(text).find((b) => b.start === l.start);
        if (!block) throw new Error(`slide-merge: block at line ${l.start} vanished before stamping`);
        text = _setSlideId(text, { heading: block.heading, occurrence: block.occurrence }, canonicalId);
        // Verify the stamp is visible to the ledger readers AT THIS block, right now — before a
        // later (higher) insertion can shift its heading. setSlideId only ever writes at/below the
        // heading, so the block's heading is still at l.start here. A stamp that does not read back
        // is an honest failure, never a silent success.
        const readBack = extractIdSlides(text).find((s) => s.headingLine === l.start);
        verified.set(l, Boolean(readBack && readBack.id === canonicalId));
      }
      // Lineage: canonical ← a prior id of a re-stamped block in this outline. recordOutlineSave
      // writes it only onto the canonical id's FIRST version, so it is a no-op once canonical has
      // history — but it captures the origin when canonical is newly established.
      const priorForLineage = group.map((l) => l.id).find((id) => id && id !== canonicalId) ?? null;
      const lineageHints = priorForLineage ? new Map([[canonicalId, priorForLineage]]) : null;
      const absOutline = join(vaultRoot, outline);
      if (text !== original) writeFileAtomic(absOutline, text);
      recordOutlineSave(vaultRoot, absOutline, text, { now, lineageHints });
      contentByOutline.set(outline, text);
      for (const l of group) {
        if (verified.get(l)) merged.push({ outline, oldId: l.id });
        else failed.push({
          outline,
          error: `slide-merge: {id=${canonicalId}} did not read back on the stamped block `
            + `(heading=${JSON.stringify(l.target.heading)} occurrence=${l.target.occurrence || 1})`,
        });
      }
    } catch (err) {
      for (const l of group) failed.push({ outline, error: String(err?.message ?? err) });
    }
  }

  return { ok: true, canonicalId, merged, failed };
}

// Re-export so callers reaching for a post-merge sanity check (every outline now reports canonical)
// need not also import 13. Thin passthrough — the source of truth stays in 13-slide-ledger.
export { extractIdSlides };
