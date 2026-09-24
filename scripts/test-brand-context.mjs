// Brand ambiguity is CONTEXT-DEPENDENT. In prose, "meta" means metadata and must not
// summon Meta's logo. In a logolist — a slide whose entire job is naming companies —
// it is unambiguously the company. The blocklist therefore applies to prose only.
import { svglBrandMatch, decideFeatureListStyle } from "../compiler/scripts/lib/05-icons.mjs";

let fail = 0;
const ck = (c, m) => { if (!c) { console.error("FAIL:", m); fail++; } };

// (1) Prose behaviour is unchanged — the blocklist still protects it.
ck(svglBrandMatch("metadata in the frontmatter") === null, "prose: metadata does not resolve to Meta");
ck(svglBrandMatch("the technology stack") === null, "prose: stack does not resolve to Stack Overflow");
ck(svglBrandMatch("in light of this") === null, "prose: light does not resolve");

// (2) In a brand context the blocklisted tokens resolve.
ck(svglBrandMatch("Meta", { brandContext: true }) === "meta", "brand context: Meta resolves");
ck(svglBrandMatch("Edge", { brandContext: true }) === "edge", "brand context: Edge resolves");
ck(svglBrandMatch("Linear", { brandContext: true }) === "linear", "brand context: Linear resolves");

// (3) Brand context does NOT abandon the substantive check — a long prose line that
// merely mentions the word still refuses, so {logolist} stays honest if misused.
ck(svglBrandMatch("we should think about metadata when we design the export format", { brandContext: true }) === null,
  "brand context still requires a substantive, label-like mention");

// (4) Unblocked tokens that were always fine are untouched.
ck(svglBrandMatch("OpenAI") === "openai", "unblocked brands unchanged in prose");
ck(svglBrandMatch("OpenAI", { brandContext: true }) === "openai", "unblocked brands unchanged in brand context");

// (5) A logolist resolves Meta to its mark rather than a monogram.
const logos = decideFeatureListStyle(["Meta", "OpenAI", "Google"], false, null, "logos");
ck(Array.isArray(logos.icons) && logos.icons[0] === "svgl:meta",
  `logolist resolves Meta to its mark (got ${logos.icons && logos.icons[0]})`);

// --- Simple Icons tier ----------------------------------------------------
// Below svgl: svgl wins on collision, Simple Icons fills brands svgl lacks.
import { iconSvg as _svg } from "../compiler/scripts/lib/05-icons.mjs";
ck(svglBrandMatch("MiniMax", { brandContext: true }) === "minimax", "Simple Icons fills a brand svgl lacks");
ck(svglBrandMatch("OpenAI", { brandContext: true }) === "openai", "svgl still wins where it has the mark");
ck(/^<svg/.test(_svg("svgl:minimax")), "a Simple Icons brand renders");

// Brands resolve by the spelling that actually appears on a slide.
ck(svglBrandMatch("MiniMax", { brandContext: true }) === "minimax", "MiniMax resolves");
ck(svglBrandMatch("ElevenLabs", { brandContext: true }) === "elevenlabs", "ElevenLabs resolves");
ck(svglBrandMatch("Alibaba Cloud", { brandContext: true }) === "alibabacloud", "a compound slug resolves from its human spelling");
// Ordinary prose must not acquire logos from the new tier.
for (const prose of [
  "the research design of the study",
  "we ran the analysis in a notebook",
  "a short history of the field",
  "the next steps for the project",
]) ck(svglBrandMatch(prose) === null, `prose stays clean: ${prose}`);

// --- Task 8: frontier labs (Moonshot, Z.ai, Liquid AI) --------------------
// Three marks with no bulk-set token surface: Moonshot reaches its vendored Simple Icons mark via
// a brand-context-only compound head; Z.ai and Liquid AI enter through extra.json + an alias.
ck(svglBrandMatch("Moonshot", { brandContext: true }) === "moonshotai", "Moonshot resolves in brand context");
ck(svglBrandMatch("Z.ai", { brandContext: true }) === "zai", "Z.ai resolves in brand context");
ck(svglBrandMatch("Z.Ai", { brandContext: true }) === "zai", "Z.Ai (mixed case) resolves in brand context");
ck(svglBrandMatch("LiquidAI", { brandContext: true }) === "liquidai", "LiquidAI resolves in brand context");
ck(svglBrandMatch("Liquid AI", { brandContext: true }) === "liquidai", "Liquid AI (spaced) resolves in brand context");
ck(/^<svg/.test(_svg("svgl:moonshotai")), "the Moonshot mark renders");
ck(/^<svg/.test(_svg("svgl:zai")), "the Z.ai mark renders");
ck(/^<svg/.test(_svg("svgl:liquidai")), "the Liquid AI mark renders");
// Prose safety: these common words must NOT summon a frontier logo outside a logolist.
ck(svglBrandMatch("a moonshot goal") === null, "prose: 'a moonshot goal' does not resolve");
ck(svglBrandMatch("moonshot thinking") === null, "prose: 'moonshot thinking' does not resolve");
ck(svglBrandMatch("liquid") === null, "prose: bare 'liquid' does not resolve");
ck(svglBrandMatch("liquid cooling") === null, "prose: 'liquid cooling' does not resolve");
// Alias tightness: the Z.ai pattern must not fire inside ordinary words.
ck(svglBrandMatch("zaire", { brandContext: true }) === null, "brand context: 'zaire' does not resolve to Z.ai");
ck(svglBrandMatch("the z axis", { brandContext: true }) === null, "brand context: 'the z axis' does not resolve to Z.ai");

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1); }
console.log("PASS: context-aware brand matching");
