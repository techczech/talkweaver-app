// Verifies the explicit-icon fallback behaviour (ADR-0005, Task 7): an author who pins a fully
// qualified but UNKNOWN icon name gets a neutral placeholder that preserves alignment, instead of
// null (which would silently fall through to a different auto-picked concept icon). Explicit VALID
// names and the no-explicit-icon auto path are unchanged.
import {
  normalizeIconOverrideKey,
  iconSvg,
  createIconVocabulary,
  decideFeatureListStyle,
} from "../compiler/scripts/lib/05-icons.mjs";

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

// (1) Explicit UNKNOWN prefixed name → a fallback key whose SVG carries data-icon-fallback.
const unknownKey = normalizeIconOverrideKey("lucide:no-such-name");
ck(unknownKey !== null, "unknown explicit name no longer resolves to null");
ck(typeof unknownKey === "string" && unknownKey.startsWith("fallback:"), "unknown explicit name → fallback: sentinel key");
const unknownSvg = iconSvg(unknownKey);
ck(/data-icon-fallback/.test(unknownSvg), "unknown explicit name → SVG carries data-icon-fallback");
ck(/<circle\b/.test(unknownSvg), "fallback SVG is a plain circle outline");
ck(/viewBox="0 0 24 24"/.test(unknownSvg), "fallback SVG uses Lucide box metrics (viewBox 0 0 24 24)");
ck(/stroke="currentColor"/.test(unknownSvg), "fallback SVG strokes currentColor");
ck(/data-icon-fallback="lucide:no-such-name"/.test(unknownSvg), "fallback SVG records the requested-but-missing name");
// An unknown svgl brand pin also falls back.
const unknownBrand = normalizeIconOverrideKey("svgl:no-such-brand");
ck(typeof unknownBrand === "string" && unknownBrand.startsWith("fallback:"), "unknown explicit svgl brand → fallback sentinel");
ck(/data-icon-fallback/.test(iconSvg(unknownBrand)), "unknown explicit svgl brand → SVG carries data-icon-fallback");

// (2) Explicit VALID name → unchanged real icon, NO fallback marker.
ck(normalizeIconOverrideKey("lucide:brain") === "lucide:brain", "valid lucide name resolves unchanged");
const brainSvg = iconSvg("lucide:brain");
ck(brainSvg.length > 0, "valid lucide name renders a real icon");
ck(!/data-icon-fallback/.test(brainSvg), "valid lucide name → NO fallback marker");
ck(!/fl-svg-fallback/.test(brainSvg), "valid lucide name → NO fallback class");
// A bare unresolvable token (not the {icon=} explicit form) stays null so literal `{a, b}` and the
// {name} shorthand are unaffected.
ck(normalizeIconOverrideKey("a, b") === null, "bare unresolvable token stays null (literal braces preserved)");

// (3) Item with NO explicit icon → auto-assignment unchanged (captured 2026-07-10 pre-change):
//     ["Brain and memory","Search the web for sources","Secure the private data"]
//       → style "icons", icons ["lucide:brain","lucide:search","lucide:database"].
//     The auto path never emits a fallback key.
const autoItems = ["Brain and memory", "Search the web for sources", "Secure the private data"];
const auto = decideFeatureListStyle(autoItems, false, createIconVocabulary(), "icons", null);
ck(auto.style === "icons", "auto list still resolves to icon style");
ck(JSON.stringify(auto.icons) === JSON.stringify(["lucide:brain", "lucide:search", "lucide:database"]),
  "auto assignment unchanged for no-explicit-icon items");
ck(!auto.icons.some((k) => String(k).startsWith("fallback:")), "auto path never produces a fallback key");

// --- Tabler gap-fill tier -------------------------------------------------
// Tabler may ONLY fill what Lucide leaves empty. "confused" has no Lucide icon and
// must now resolve to Tabler; "brain" has one and must stay on Lucide.
import { iconCandidatesV3 as _cands, conceptIconMatch } from "../compiler/scripts/lib/05-icons.mjs";
const topKey = (t) => { const c = _cands(t); return c.length ? c[0].key : null; };
ck(topKey("confused") === "tabler:mood-confused", `Lucide gap fills from Tabler (got ${topKey("confused")})`);
ck(String(topKey("neural networks")).startsWith("lucide:"), "an item Lucide can draw stays on Lucide");
const tablerSvg = iconSvg("tabler:mood-confused");
ck(/^<svg/.test(tablerSvg), "tabler key renders an svg");
ck(/viewBox="0 0 24 24"/.test(tablerSvg), "tabler svg uses 24px box metrics");
ck(/stroke="currentColor"/.test(tablerSvg), "tabler svg inherits colour");
ck(!/stroke-width="2"[^>]*stroke-width="2"/.test(tablerSvg), "tabler svg is not double-wrapped with paint attrs");
ck(iconSvg("tabler:no-such-glyph") === "", "unknown tabler name renders empty");

// An explicit author pin and a curated concept entry must both accept a tabler key.
ck(normalizeIconOverrideKey("tabler:mood-confused") === "tabler:mood-confused", "explicit tabler pin is accepted");
ck(String(normalizeIconOverrideKey("tabler:no-such-glyph")).startsWith("fallback:"), "unknown tabler pin falls back visibly");
ck(normalizeIconOverrideKey("brain") === "lucide:brain", "a bare name still prefers Lucide");

// A real committed concept-icons.json entry ("a lawyer" -> tabler:gavel) exercises the curation
// path end to end: neither Lucide nor the Tabler word-scorer resolves "lawyer" on its own.
ck(conceptIconMatch("a lawyer") === "tabler:gavel", "curated profession phrase resolves to its tabler glyph");
ck(topKey("a lawyer") === "tabler:gavel", "the curated tabler entry wins the item's top candidate");

// --- TASK B: emotions the mood-* gate cannot reach on its own ------------
// The gate resolves an emotion only when the English word IS the Tabler name (happy, confused,
// surprised). "anxious", "sceptical" and "tired" have no such literal match — Tabler names them
// mood-nervous, mood-unamused and mood-empty — so they reach a mood glyph only through the
// concept-icons.json curation layer. Asserted via BOTH conceptIconMatch (the curation lookup
// itself) and topKey (the curated entry actually wins the item's top candidate end to end).
for (const [word, key] of [["anxious", "tabler:mood-nervous"], ["sceptical", "tabler:mood-unamused"], ["tired", "tabler:mood-empty"]]) {
  ck(conceptIconMatch(word) === key, `curated emotion "${word}" resolves via concept layer to ${key} (got ${conceptIconMatch(word)})`);
  ck(topKey(word) === key, `curated emotion "${word}" wins the item's top candidate (got ${topKey(word)})`);
}

// --- TASK C: lock the gate in both directions -----------------------------
// (1) The one auto-match this tier exists for must keep working.
ck(topKey("confused") === "tabler:mood-confused", `literal mood word still auto-matches (got ${topKey("confused")})`);

// (2) Nothing outside `mood-*` (and nothing this gate deliberately excludes) may auto-match. Each
// of these previously drew a confidently wrong glyph under the old unrestricted-name matcher
// (soccer-field, http-get, and so on — see the WHY ONLY `mood-*` comment in 05-icons.mjs) and must
// now yield NO candidate whose key starts with "tabler:", regardless of what Lucide independently
// resolves for the same text.
const noTablerCandidate = (text) => !_cands(text).some((c) => c.key.startsWith("tabler:"));
for (const text of ["a teacher", "API", "Constantly changing field", "Doesn't get tired"]) {
  ck(noTablerCandidate(text), `"${text}" must yield no tabler candidate (got ${JSON.stringify(_cands(text).map((c) => c.key))})`);
}
// The narrowed-gate exclusions from Task A: modifier-suffix tails never auto-match, and neither
// does the "empty" collision. Real prose, not synthetic — each phrase is realistic bullet text.
for (const text of [
  "Empty object {} is the default stub",
  "Check the output",
  "Share your findings",
  "Search the web",
  "Edit the outline",
]) {
  ck(noTablerCandidate(text), `Task A exclusion: "${text}" must yield no tabler candidate (got ${JSON.stringify(_cands(text).map((c) => c.key))})`);
}

// (3) The collection stays fully available by deliberate choice — auto-match never widens, but an
// explicit pin still reaches any of the 6,166 names, including ones far outside mood-*.
ck(normalizeIconOverrideKey("tabler:soccer-field") === "tabler:soccer-field", "an explicit pin still reaches the full Tabler collection");

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: explicit-icon fallback (ADR-0005 Task 7)");
