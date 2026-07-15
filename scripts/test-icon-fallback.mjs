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

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: explicit-icon fallback (ADR-0005 Task 7)");
