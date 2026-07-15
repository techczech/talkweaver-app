import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scriptDir, escapeHtml } from "./01-cli-utils.mjs";

// =============================================================================
// 5. Icon System v3 — Vendored Lucide + svgl brands + extra supplementary set,
// semantic matching, deck-level uniqueness. (F2)
//
// Sources:
//   assets/icons/lucide.json  — lucide-static@1.17.0 (ISC licence)
//   assets/icons/svgl.json    — github.com/pheralb/svgl full library (MIT licence;
//                               logos are trademarks of their owners)
//   assets/icons/extra.json   — accumulative supplementary set (Simple Icons CC0 +
//                               Iconify fallback; licenses recorded per entry).
//                               Extends svgl; svgl wins on key collision.
//                               Grows via scripts/add-icon.mjs when builds emit
//                               icon-gap:<term> warnings.
// =============================================================================

// Load vendored icon data at startup (sync — small well-formed JSON, committed).
const _iconsDir = resolve(scriptDir, "..", "assets/icons");
let _lucide = {};
let _svgl = {};
let _extra = {};
try {
  _lucide = JSON.parse(readFileSync(join(_iconsDir, "lucide.json"), "utf8"));
} catch { /* graceful: matching will return no lucide candidates */ }
try {
  _svgl = JSON.parse(readFileSync(join(_iconsDir, "svgl.json"), "utf8"));
} catch { /* graceful: matching will return no svgl candidates */ }
try {
  _extra = JSON.parse(readFileSync(join(_iconsDir, "extra.json"), "utf8"));
} catch { /* graceful: extra.json is optional */ }

// Merged brand set: svgl wins on collision; extra extends.
// _brandIndex maps key → entry with a `_source` tag for iconSvg().
const _brandIndex = {};
for (const [k, v] of Object.entries(_extra)) {
  if (k !== "_meta") _brandIndex[k] = { ...v, _source: "extra" };
}
for (const [k, v] of Object.entries(_svgl)) {
  if (k !== "_meta") _brandIndex[k] = { ...v, _source: "svgl" };
}

// ---------------------------------------------------------------------------
// Curated concept→icon map (assets/icons/concept-icons.json). A high-priority
// SEMANTIC layer the matcher consults for ALL feature-list items, AFTER exact
// brand/alias and BEFORE generic Lucide scoring. Two jobs:
//   1. Resolve `icon-semantic-needed` gaps — an icon-resolvable list (≥2 genuine
//      matches, only 1–2 unmatched) whose unmatched item is a hand-curated
//      concept here gets a deliberate, human/agent-chosen icon so the whole list
//      renders as icons instead of dropping to plain.
//   2. Steer ANY item — a curated choice overrides the generic Lucide guess
//      everywhere it appears, not only at gaps.
// Entry value: { key: "lucide:name" | "svgl:name", note: "<reasoning>" }.
// Lookup key: normalizeConceptPhrase(itemText). Grows via the semantic-icon
// resolution procedure (see references/slide-design-language.md).
// ---------------------------------------------------------------------------
let _conceptIconsRaw = {};
try {
  _conceptIconsRaw = JSON.parse(readFileSync(join(_iconsDir, "concept-icons.json"), "utf8"));
} catch { /* graceful: concept layer is optional */ }
// Normalize an item text to the concept-map lookup key: strip markdown emphasis,
// list markers and numbering, lowercase, collapse all non-alphanumeric runs to a
// single space, trim. Both authored phrases and runtime items pass through here.
function normalizeConceptPhrase(text) {
  return String(text)
    .replace(/[*`_]/g, "")
    .replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
// Built lookup: normalized phrase → { key, note }. Keys are re-normalized so a
// slightly loose authored phrase still resolves.
const _conceptIconMap = new Map();
for (const [phrase, entry] of Object.entries(_conceptIconsRaw)) {
  if (phrase === "_meta" || !entry || typeof entry.key !== "string") continue;
  _conceptIconMap.set(normalizeConceptPhrase(phrase), { key: entry.key, note: entry.note || "" });
}
// A concept key is usable only if it resolves to a renderable icon: a "lucide:NAME"
// whose NAME exists in _lucide, or an "svgl:NAME" that is a renderable brand. This
// guards a typo'd or stale curated key from becoming a blank slot.
function isConceptKeyRenderable(key) {
  if (typeof key !== "string") return false;
  if (key.startsWith("lucide:")) return Boolean(_lucide[key.slice(7)]);
  if (key.startsWith("svgl:")) return isBrandRenderable(key.slice(5));
  return false;
}
// Return the curated icon key for an item text, or null. Consulted by the matcher
// after brand/alias and before generic Lucide scoring.
export function conceptIconMatch(text) {
  const hit = _conceptIconMap.get(normalizeConceptPhrase(text));
  if (hit && isConceptKeyRenderable(hit.key)) return hit.key;
  return null;
}

// ---------------------------------------------------------------------------
// Brand matching — svgl full library, data-derived tokens (strongest signal).
//
// Each svgl entry carries a `tokens` array derived from its title and key at
// vendor time. We build a reverse index (token → svgl key) at startup, then
// test each whole word in item text against the index.
//
// Guards for ambiguous tokens:
//   ALIAS_MAP   — hard aliases for surface forms not in svgl titles
//                 (chatgpt→openai, tweet→twitter, k8s→kubernetes, etc.)
//   TOKEN_AMBIG — tokens that are too short or generic to fire on their own;
//                 require the FULL original pattern to match exactly (not just
//                 a word-boundary hit on the ambiguous token).
//   AMBIG_GUARDS — for each ambiguous token: the full regex that must match
//                 the item text for the token to fire. A stray "go" in prose
//                 won't match Golang unless the item says "golang" or "go lang".
// ---------------------------------------------------------------------------

// Explicit alias map: surface patterns → svgl key.
// These cover aliases, product-name variants, and common surface forms that
// are NOT present as title tokens in svgl (chatgpt, tweets, k8s, etc.).
// Only fires when the svgl key actually exists in _svgl.
// Checked BEFORE the data-derived index so they always win.
const ALIAS_MAP = [
  [/\bchatgpt\b/i,                  "openai"],
  [/\banthrop[io]c\b/i,             "anthropic"],
  [/\bclaude\b/i,                   "claude-ai"],
  // Gemini: pin the surface form to the actual Gemini mark. The svgl `gemini` key carries the
  // four-point spark logo; without this alias the resolver depends on token-index priority and
  // a phrase like "Google Gemini" could fall through to the plain Google "G" tile.
  [/\bgemini\b/i,                   "gemini"],
  // DeepMind: "Google DeepMind" must NOT collapse to the bare Google tile — it is a distinct
  // brand. Pin it to the DeepMind spiral (extra.json, Simple Icons). Checked before the token
  // index, so the "google" token in "Google DeepMind" never wins.
  [/\bdeep\s*mind\b/i,              "deepmind"],
  // Copilot: the product, not its parent. "GitHub Copilot"/"Microsoft Copilot"/bare "Copilot"
  // resolve to the Copilot marks (svgl) instead of the github/microsoft parent tiles that the
  // fewest-token index would otherwise pick.
  [/\bmicrosoft\s+copilot\b/i,      "microsoft-copilot"],
  [/\bcopilot\b/i,                  "github-copilot"],
  [/\bperplexit/i,                  "perplexity-ai"],
  [/\bmistral\b/i,                  "mistral-ai"],
  [/\bhugging\s*face\b/i,           "hugging-face"],
  [/\bstabilit/i,                   "stability-ai"],
  [/\bcolab\b|google\s+colab/i,     "google-colaboratory"],
  [/\btweets?\b|twitter\b|\bx\.com\b|\bx\/twitter\b/i, "twitter"],
  [/\bkubernetes\b|\bk8s\b/i,       "kubernetes"],
  [/\bpostgres/i,                   "postgresql"],
  [/\bnode\.?js\b/i,                "node-js"],
  [/\bnext\.?js\b/i,                "next-js"],
  [/\btailwind\b/i,                 "tailwind-css"],
  [/\bgolang\b|\bgo\s+lang\b/i,     "go"],
  [/\bd3\.?js\b/i,                  "d3-js"],
  [/\bllama\b/i,                    "meta"],
  [/\baws\b/i,                      "amazon-web-services"],
  [/\bamazon\s+q\b/i,               "amazon-q"],
  [/\bgcp\b|\bgoogle\s+cloud\b/i,   "google-cloud"],
  [/\bwikipedia\b/i,                 "wikipedia"],   // extra.json (Simple Icons W)
  [/\bmediawiki\b/i,                 "mediawiki"],   // svgl MediaWiki software logo
  // "Medium" as a brand: capitalised only ("Medium"), never as adjective ("medium-term").
  // The strict pattern matches "Medium" standing alone or followed by a space/end only.
  [/\bMedium\b(?![-\w])/,           "medium"],
  [/\bsubstack\b/i,                  "substack"],    // extra.json (Simple Icons)
  [/\bpowerpoint\b|\bpptx\b/i,      "microsoft-powerpoint"],
  [/\bbsky\b/i,                      "bluesky"],
  [/\bdocx\b/i,                      "microsoft-word"],
];

// Tokens excluded from the generic reverse-index because they are common English
// words or generic tech terms that produce false positives in presentation prose.
// Strategy: exclude tokens that are short (≤3 chars, non-distinctive acronyms),
// generic English nouns/verbs, or multi-brand tokens with ambiguous precedence.
// Distinctive brand names (discord, slack, figma, obsidian, ollama, etc.) are
// left in the index — they are uncommon enough to safely match on whole-word hits.
// For each excluded token, the alias map above handles the cases that should fire.
const AMBIG_SKIP_TOKENS = new Set([
  // Too short or acronym-overloaded (covered via ALIAS_MAP or not needed)
  "go",  "ai",  "js",  "css", "net", "sql", "com", "dev", "api",
  "ide", "lua", "lit", "lit",
  // Generic English words that happen to be brand names — too risky in prose
  "meta",      // common prefix/word (meta-analysis, metadata); covered by ALIAS_MAP
  "next",      // "next steps", "next.js" → alias
  "node",      // "node in a graph", "node.js" → alias
  "base",      // "base case", "database" → Base UI brand ambiguous
  "link",      // "link to source", "hyperlink" → Link brand ambiguous
  "flow",      // "workflow", "information flow" → Flow Launcher ambiguous
  "edge",      // "cutting edge", "edge case" → Microsoft Edge ambiguous
  "text",      // "in text", "text analysis" → Sublime Text ambiguous
  "paper",     // "research paper", "a paper on..." → Paper app ambiguous
  "design",    // "by design", "research design" → Ant Design ambiguous
  "stack",     // "technology stack", "full stack" → Stack Overflow ambiguous
  "prime",     // "prime example" → Prime Video / Captivate Prime ambiguous
  "signal",    // "signal vs noise" (Signal is messaging app — low risk; keep excluded)
  "chain",     // "supply chain" → LangChain ambiguous (but langchain in alias)
  "forge",     // "to forge" → various forge brands
  "light",     // "light version", "in light of" → ambiguous
  "dark",      // "dark matter", "dark side" → ambiguous
  "orbit",     // "in orbit" → ambiguous
  "wave",      // "a wave of" → ambiguous
  "pixel",     // "at the pixel level" → ambiguous
  "point",     // "data point" → ambiguous
  "gate",      // "Watergate" → ambiguous
  "core",      // "at the core of" → ambiguous
  "mark",      // "benchmark", "landmark" → ambiguous
  "nest",      // "nested" → NestJS ambiguous
  "peak",      // "at its peak" → ambiguous
  "port",      // "reporting", "support" → ambiguous
  "pool",      // "resource pool" → ambiguous
  "root",      // "root cause" → ambiguous
  "ship",      // "to ship features" → ambiguous
  "snap",      // "snapshot" → ambiguous
  "sort",      // "to sort" → ambiguous
  "spin",      // "to spin up" → ambiguous
  "spot",      // "spot check" → ambiguous
  "swap",      // "to swap" → ambiguous
  "sync",      // "to sync" → ambiguous
  "task",      // "task management" → ambiguous
  "time",      // "over time" → ambiguous
  "tool",      // "tool use" → ambiguous
  "tree",      // "decision tree" → ambiguous
  "type",      // "data type" → ambiguous
  "unit",      // "unit of analysis" → ambiguous
  "view",      // "overview", "worldview" → ambiguous
  "well",      // "works well" → ambiguous
  "wrap",      // "to wrap up" → ambiguous
  "zero",      // "from zero" → ambiguous
  "zone",      // "time zone", "comfort zone" → ambiguous
  "dash",      // "dashboard" → ambiguous
  "mint",      // "to mint" (crypto) → ambiguous
  "hub",       // "skill hub" → ambiguous
  "pop",       // "pop-up" → ambiguous
  "run",       // "to run" → ambiguous
  "lab",       // "AI lab" → common in presentations
  "pro",       // "professional" → ambiguous
  "map",       // "roadmap", "to map" → ambiguous
  "cut",       // "budget cut" → ambiguous
  "bit",       // "a little bit" → ambiguous
  "sky",       // "blue sky" → ambiguous
  "fly",       // "to fly" → ambiguous
  "arc",       // "narrative arc" → ambiguous
  "amp",       // "to amplify" → ambiguous
  "ant",       // "an ant" → Ant Design ambiguous
  "ton",       // "a ton of" → Ton (crypto) ambiguous
  "tor",       // "tor network" (Tor is a privacy tool; covered by specificity)
  "orm",       // "object relational mapping" → Drizzle ORM ambiguous
  "pdf",       // "PDF document" → ambiguous but distinctive; keep? No — too generic
  "vpn",       // "using a VPN" → ambiguous (Proton VPN)
  "discourse", // "discourse analysis" → Discourse forum software ambiguous
  "linear",    // "linear algebra", "linear model" → Linear app ambiguous
  "formerly",  // from "X (formerly Twitter)" — too generic
  "services",  // from "Amazon Web Services" — too generic
  "workers",   // from "Cloudflare Workers" — too generic
  "music",     // from "YouTube Music" — too generic
  "query",     // from "React Query" — too generic
  "router",    // from "React Router" — too generic
  "model",     // from "Model Context Protocol" — too generic in AI context
  "video",     // from "Presenter Video Express" — too generic
  "picker",    // from "React Wheel Picker" — too generic
  "wheel",     // from "React Wheel Picker" — too generic
  "protocol",  // from "Model Context Protocol" — too generic
  "context",   // from "Model Context Protocol" — too generic
  "wallet",    // from "Trust Wallet" — too generic
  "trust",     // from "TrustPilot" / "Trust Wallet" — too generic
  "express",   // various "Express" brands — too generic
  "launcher",  // from "Flow Launcher" — too generic
  "media",     // various brands — too generic in presentations
  "classic",   // various brands — too generic
  "starter",   // various brands — too generic
]);

// Build the reverse token index at startup: token → svgl key.
//
// Priority for a given token T: the entry whose key IS T (exact slug match)
// wins over all others. If no entry has key === T, the entry with the fewest
// tokens wins (fewest tokens = most specific brand name for that token, e.g.
// "GitHub" has 1 token "github" and beats "GitHub Copilot" with 2 tokens for
// the "github" token). Title length is the tiebreaker (shorter = more canonical).
// brandStore: any object mapping key → { tokens, title } (svgl, _brandIndex, etc.)
function buildSvglTokenIndex(brandStore) {
  const index = new Map(); // token → brand key
  const entries = Object.entries(brandStore)
    .filter(([k]) => k !== "_meta" && brandStore[k]?.tokens)
    // Sort: fewest tokens first, then shortest title — most canonical wins.
    .sort((a, b) => {
      const ta = (a[1].tokens?.length ?? 99);
      const tb = (b[1].tokens?.length ?? 99);
      if (ta !== tb) return ta - tb;
      return (a[1].title?.length ?? 0) - (b[1].title?.length ?? 0);
    });

  for (const [key, entry] of entries) {
    for (const token of (entry.tokens ?? [])) {
      if (AMBIG_SKIP_TOKENS.has(token)) continue;
      // Exact key match always wins (overwrite any existing mapping).
      if (token === key || !index.has(token)) {
        index.set(token, key);
      }
    }
  }
  return index;
}

// Build token index over the merged brand set (svgl + extra; svgl wins collisions).
const _svglTokenIndex = buildSvglTokenIndex(_brandIndex);

// ---------------------------------------------------------------------------
// Common-word brand guard (false-positive bug: "summarise material …" → Material UI).
//
// Some brand tokens ARE ordinary English words: material, medium, notion, arc,
// slack, go, post, page, paper, stack… When such a token appears in generic
// lowercase prose ("summarise material into notes") the reverse index fires the
// brand even though the author meant the common word. AMBIG_SKIP_TOKENS removes
// the worst offenders entirely, but that also kills legitimate brand hits.
//
// Approach (dictionary-derived, not hand-enumerated): build an English common-word
// lexicon from the Lucide icon vocabulary — every Lucide icon NAME word and TAG word
// is, by construction, a generic English concept (lucide tags are common nouns/verbs:
// "file", "note", "material" appears via "layers"/"box" tags, etc.). A brand token is
// "common" iff it is present in that lexicon. We then require such a token to read AS
// a brand before it may fire:
//   - the brand's TITLE appears capitalised-as-brand in the original text
//     ("Material UI", "Notion", "Medium"), OR
//   - the token is the single-word head of the item (a one-word list entry like
//     "Material" standing alone — the author is naming the product), OR
//   - the matched word itself is Capitalised in the source AND not a sentence opener.
// A bare lowercase common word in running prose never fires the brand.
//
// Distinctive brand tokens (figma, obsidian, substack, github, youtube…) are NOT in
// the Lucide lexicon, so they keep matching on a plain whole-word hit as before.
// ---------------------------------------------------------------------------
const _LUCIDE_WORD_LEXICON = (() => {
  const lex = new Set();
  for (const [name, entry] of Object.entries(_lucide)) {
    if (name.startsWith("_")) continue;
    for (const w of name.split("-")) { if (w.length >= 3) lex.add(w.toLowerCase()); }
    for (const tag of (entry.tags || [])) {
      for (const w of String(tag).toLowerCase().split(/\s+/)) { if (w.length >= 3) lex.add(w); }
    }
  }
  // A few common words Lucide does not tag but that are real brand tokens (safety net).
  for (const w of ["material", "medium", "notion", "arc", "stack", "post", "page",
                   "paper", "craft", "loop", "raycast", "linear", "things", "reflect",
                   "framer", "render", "replit", "expo", "deno", "bun", "nuxt"]) lex.add(w);
  return lex;
})();

// The set of brand tokens that are also common English words. Derived: any token in
// the reverse index that the Lucide lexicon contains.
const COMMON_WORD_BRAND_TOKENS = (() => {
  const s = new Set();
  for (const token of _svglTokenIndex.keys()) {
    if (_LUCIDE_WORD_LEXICON.has(token)) s.add(token);
  }
  return s;
})();

// Capital-as-brand guard for a common-word token. `word` is the lowercase matched
// token, `key` the resolved brand key, `text` the original (case-preserving) item text.
function commonWordBrandGuardPasses(word, key, text) {
  const entry = _brandIndex[key];
  const title = (entry && entry.title) ? entry.title : word;
  // 1. Brand title appears as a capitalised phrase in the source ("Material UI", "Notion").
  const titleRe = new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  if (titleRe.test(text)) return true;
  // 2. Single-word item head: the whole (stripped) item is just this one word — the
  //    author is naming the product ("Material", "Notion", "Arc").
  const stripped = String(text).replace(/[*`_]/g, "").replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "").trim();
  if (stripped.split(/\s+/).length === 1 && stripped.toLowerCase().replace(/[^a-z0-9]/g, "") === word) return true;
  // 3. The matched word is Capitalised in the source AND not at sentence start / not a
  //    generic opener — a capitalised mid-sentence "Notion"/"Arc" reads as a proper noun.
  const capRe = new RegExp(`\\b${word.charAt(0).toUpperCase()}${word.slice(1)}\\b`);
  if (capRe.test(text)) {
    // Reject if it's the FIRST word of the item (capitalisation there is just sentence case).
    const firstWord = stripped.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") || "";
    if (firstWord !== word) return true;
  }
  return false;
}

// Tokenise item text to a set of lowercase alphanumeric words (length >= 2).
function textWords(text) {
  return new Set(
    String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 2)
  );
}

// A brand key is usable only if its entry exists AND its SVG is renderable
// (not an empty/no-geometry SVG). White-mono SVGs ARE usable — iconSvg recolours
// them. This keeps the invisible-icon guard in front of candidate selection so a
// non-renderable brand never becomes a blank icon slot (the all-or-nothing list
// would otherwise emit an empty `.fl-icon`).
const _brandRenderable = new Map();
function isBrandRenderable(key) {
  const entry = _brandIndex[key];
  if (!entry) return false;
  if (_brandRenderable.has(key)) return _brandRenderable.get(key);
  const ok = classifyBrandSvg(entry.svg) !== "empty";
  _brandRenderable.set(key, ok);
  return ok;
}

// Function words ignored when judging whether a brand mention is the SUBJECT of an
// item or just an incidental word inside a longer instruction.
const BRAND_SUBSTANTIVE_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with",
  "your", "my", "our", "his", "her", "their", "its", "you", "we", "it", "is", "are",
  "be", "has", "have", "was", "were", "this", "that", "as", "from", "into", "via",
]);

// A brand mention only earns the logo when it is SUBSTANTIVE — the item is about the
// brand, not merely mentioning it ("Sign in with your ChatGPT Edu account" must NOT
// get the OpenAI logo; "ChatGPT", "Codex has usage limits", "Claude Code" must).
// Substantive = short label-like item (≤3 content words), OR a multi-word brand
// phrase matched, OR the brand is the item's first content word (named up front).
export function brandMatchIsSubstantive(text, matchText) {
  const stripped = String(text)
    .replace(/[*`_]/g, "")
    .replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");
  const contentWords = stripped.split(/\s+/).filter((w) => w.length >= 2 && !BRAND_SUBSTANTIVE_STOP_WORDS.has(w));
  if (contentWords.length <= 3) return true;
  const matchWords = String(matchText).toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (matchWords.length >= 2) return true;
  return contentWords[0] === matchWords[0];
}

// Returns the brand key for an item text if a brand alias or token is found
// in the merged brand index (svgl + extra), else null.
export function svglBrandMatch(text) {
  const t = String(text);

  // 1. Explicit alias map (handles chatgpt, tweet, k8s, node.js, etc.)
  for (const [re, key] of ALIAS_MAP) {
    const m = re.exec(t);
    if (m && _brandIndex[key] && isBrandRenderable(key) && brandMatchIsSubstantive(t, m[0])) return key;
  }

  // 2. Data-derived token index: test each whole word in item text against index.
  //    A token must appear as a WHOLE WORD (word boundary) in the item text.
  //    Common-word brand tokens (material, medium, notion, arc…) only fire when the
  //    brand also reads AS a brand in the text — see commonWordBrandGuardPasses.
  const words = textWords(t);
  for (const word of words) {
    const key = _svglTokenIndex.get(word);
    if (!key || !_brandIndex[key] || !isBrandRenderable(key)) continue;
    if (COMMON_WORD_BRAND_TOKENS.has(word) && !commonWordBrandGuardPasses(word, key, t)) continue;
    if (!brandMatchIsSubstantive(t, word)) continue;
    return key;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Lucide semantic scoring — name + tags, with a real threshold.
// Scoring: icon name exact word match = 3; tag exact word match = 2; partial = 1.
// Threshold = 2 (a tag word must at minimum exactly match a word in the item).
// This ensures "landmark" does NOT score for "knowledge" or "judgement".
// ---------------------------------------------------------------------------
// Threshold: must have at least one exact name-word match (score 3) OR two exact tag-word
// matches (score 4) to be "genuine". Partial/prefix matches score only 1 and don't suffice.
// This prevents "checklists" scoring "badge-check" or "knowledge" scoring "book".
const LUCIDE_THRESHOLD = 3;

// High-value semantic rules that map content concepts to specific Lucide names.
// Ordered from most-specific to most-general. These complement tag-scoring.
const LUCIDE_RULES = [
  [/\bbrain|neuron|neural|cortex|synap/i,           ["brain", "network", "atom"]],
  [/\bmind\b|think|cognit|mental|conscious|reason|intellect/i, ["brain", "lightbulb", "eye"]],
  [/\bmachine\b|processor|chip|silicon|hardware\b/i, ["cpu", "circuit-board", "microchip"]],
  [/\brobot|android|\bbot\b|automat/i,              ["bot", "cpu", "settings-2"]],
  [/\bagent\b/i,                                    ["bot", "user-cog", "workflow"]],
  [/\blanguage\b|word\b|narrative|story|chat|dialogue|convers|linguist/i, ["message-square", "book-open", "pen-line"]],
  [/\btime\b|year\b|date\b|epoch|moment/i,          ["clock", "timer", "history"]],
  [/\bhistor|period|era\b|\bage\b|prehistor|ancient|medieval/i, ["history", "scroll", "archive"]],
  [/\bpeople\b|human\b|person\b|society|tribe|communit/i, ["users", "user-check", "hand"]],
  [/\bdata\b|information\b|record|dataset|corpus|archive/i, ["database", "file-text", "layers"]],
  [/\bsignal|transmi|channel|telegraph/i,           ["share-2", "radio", "wifi"]],
  [/\bidea|imagin|insight|inspir|creativ/i,          ["lightbulb", "sparkles", "flame"]],
  [/\btheory|axiom|proof|theorem|logic|formal/i,    ["sigma", "function-square", "scale"]],
  [/\bmath|calcul|arithmet|number\b|count|algebra/i, ["calculator", "sigma", "percent"]],
  [/\bnetwork\b|net\b|connection\b|distribut|parallel|graph\b/i, ["network", "share-2", "git-branch"]],
  [/\bbook\b|read\b|literatur|publicat|paper\b|essay|treatise/i, ["book", "book-open", "file-text"]],
  [/\bscroll|manuscript|document|writing\b/i,       ["scroll", "file-text", "pen"]],
  [/\bwrite|author|composit|draft\b|edit\b/i,       ["pen-line", "edit", "file-text"]],
  [/\bsee\b|sight|vision|visual|observ|watch|look/i, ["eye", "search", "camera"]],
  [/\bhear\b|sound\b|audio\b|listen|acoustic|speech/i, ["ear", "mic", "volume-2"]],
  [/\bhand\b|craft\b|manual\b|gestur|touch/i,       ["hand", "wrench", "pointer"]],
  [/\btool\b|build\b|engineer|construct/i,           ["wrench", "settings", "hammer"]],
  [/\bsystem|mechanis|apparatus|configur|setting|control/i, ["settings", "sliders", "cpu"]],
  [/\blayer|stage\b|level\b|struct|architect|\bstack\b|tier\b/i, ["layers", "layout", "boxes"]],
  [/\bmap\b|geograph|territor|landscape|terrain/i,  ["map", "compass", "navigation"]],
  [/\bnavig|direction|orient|explor|guide\b/i,      ["compass", "navigation", "map-pin"]],
  [/\bgoal\b|target\b|aim\b|objective|focus\b|purpose/i, ["target", "crosshair", "flag"]],
  [/\bmilestone|checkpoint\b/i,                     ["flag", "milestone", "map-pin"]],
  [/\bkey\b|unlock|cipher|crypt|secret|access|password/i, ["key", "lock", "shield"]],
  [/\blink\b|connect|join\b|relate|associat|bond/i, ["link", "network", "git-merge"]],
  [/\bsearch\b|find\b|discover|query|lookup|retriev/i, ["search", "telescope", "magnify"]],
  [/\bvoice|microphone|podcast|talk\b|interview/i,  ["mic", "radio", "headphones"]],
  [/\bcamera|photo\b|image\b|picture|snapshot/i,    ["camera", "image", "film"]],
  [/\bfilm\b|movie|video\b|cinema|footage|newsreel/i, ["film", "video", "camera"]],
  [/\bmusic|melody|harmon|tune\b|song\b/i,          ["music", "headphones", "radio"]],
  [/\bchemist|experiment|lab\b|flask|reaction|trial/i, ["flask-conical", "test-tube", "microscope"]],
  [/\batom\b|physic|particle|quantum|molecul/i,     ["atom", "circle-dot", "globe-2"]],
  [/\bcode\b|program|script|command|console|shell/i, ["terminal", "code-2", "braces"]],
  [/\bfile\b|page\b|text\b|essay|report\b|memo\b/i, ["file-text", "book", "clipboard"]],
  [/\bworld\b|global|earth|planet|internation/i,    ["globe", "map", "earth"]],
  [/\binstitut|govern|state\b|nation|civic|building|college|universit/i, ["landmark", "building-2", "scale"]],
  [/\blaw\b|justice|ethic|fair|balance|regulat|\bjudicial\b|\bjuridical\b|\bjurisprud/i, ["scale", "gavel", "shield-check"]],
  [/\benerg|power\b|electric|fast\b|speed|instant|charge/i, ["zap", "bolt", "battery"]],
  [/\bpuzzle|problem\b|piece\b|solve|riddle/i,      ["puzzle", "brain", "lightbulb"]],
  [/\bpreprint|arxiv\b|paper\b/i,                   ["file-text", "scroll", "book-open"]],
  [/\bbenchmark|evaluat|assess|metric|measure/i,    ["bar-chart", "gauge", "chart-line"]],
  [/\bstudy\b|research\b|academic|scholarly/i,      ["book-open", "microscope", "graduation-cap"]],
  [/\btrend\b|growth\b|increas|statistic|chart/i,   ["trending-up", "bar-chart", "line-chart"]],
  [/\balgorithm|model\b|weight\b|training\b|fine.?tun/i, ["cpu", "brain", "workflow"]],
  [/\bembedding|vector\b|latent|represent/i,        ["grid", "hash", "waypoints"]],
  [/\btransform|attention|gpt|bert|t5\b/i,          ["brain", "cpu", "workflow"]],
  [/\bcloud\b|server\b|hosting\b|infrastruc/i,      ["cloud", "server", "database"]],
  [/\bsecuri|safety\b|privacy\b|protect|guard/i,    ["shield", "lock", "eye-off"]],
  [/\bcritiq|crit\b|evaluat|review\b|assess/i,      ["search", "eye", "check-circle"]],
  [/\btrust\b|reliab|credib|verif/i,                ["shield-check", "check-circle", "badge-check"]],
  [/\bhype\b|claim\b|market|advertis/i,             ["megaphone", "trending-up", "alert-circle"]],
  [/\berror\b|mistake\b|hallucin|wrong\b|bias/i,    ["alert-triangle", "x-circle", "bug"]],
  [/\bspeed\b|latency\b|fast\b|realtime/i,          ["gauge", "zap", "timer"]],
  [/\bcost\b|money\b|price\b|budget|token/i,        ["coins", "credit-card", "banknote"]],
  [/\bsubstack|newsletter|blog\b|rss\b/i,            ["rss", "newspaper", "mail-open"]],
];

// Generic English words that ALSO happen to be a Lucide icon NAME word or TAG word, but are
// never the author's icon intent when they appear in prose. The landmine: "spray-can" carries
// the name-word "can"; an item like "…just something general models CAN do" exact-matches that
// name-word, scores 3 = LUCIDE_THRESHOLD, and the slide gets a spray-bottle icon. These are
// ordinary function words / weak verbs / fillers — a whole-word hit on one of them must NOT
// count toward an icon score. (The brand path has the analogous AMBIG_SKIP_TOKENS guard; this
// is its Lucide equivalent.) Distinctive concept words ("brain", "history", "search") are not
// here, so genuine semantic matches are unaffected.
const LUCIDE_GENERIC_WORDS = new Set([
  // modal / auxiliary / common verbs that collide with icon names (can→spray-can, do, get…)
  "can", "do", "does", "did", "done", "get", "got", "let", "use", "used", "make", "made",
  "put", "set", "go", "going", "come", "take", "give", "want", "need", "see", "say", "know",
  // generic adjectives / quantifiers / fillers
  "just", "some", "something", "general", "more", "most", "many", "much", "such", "very",
  "each", "every", "any", "all", "one", "two", "new", "old", "good", "bad", "big", "small",
  // generic nouns that are Lucide names but read as plain prose
  "thing", "things", "stuff", "part", "parts", "way", "ways", "lot", "lots", "kind", "kinds",
  "models", "model", "people", "person", "place", "case", "fact", "point",
]);

// Score an item text against a Lucide icon name and its tags.
// Returns score: 0 = no match; >=LUCIDE_THRESHOLD = genuine match.
function lucideScore(itemTokens, lucideKey, lucideTags) {
  let score = 0;
  // Name: split hyphenated lucide name into words ("book-open" → ["book","open"])
  const nameWords = lucideKey.split("-");
  for (const nw of nameWords) {
    if (LUCIDE_GENERIC_WORDS.has(nw)) continue; // generic word — never a genuine icon signal
    if (itemTokens.has(nw)) score += 3;
    else if ([...itemTokens].some((t) => t.startsWith(nw) || nw.startsWith(t))) score += 1;
  }
  // Tags
  for (const tag of (lucideTags || [])) {
    const tagWords = tag.toLowerCase().split(/\s+/);
    for (const tw of tagWords) {
      if (LUCIDE_GENERIC_WORDS.has(tw)) continue;
      if (itemTokens.has(tw)) score += 2;
      else if ([...itemTokens].some((t) => t.startsWith(tw) || tw.startsWith(t))) score += 1;
    }
  }
  return score;
}

// Tokenise item text: lowercase words >= 3 chars, no punctuation, no stop words.
const _STOP = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "with", "not", "is", "are", "was", "by", "from", "its", "it", "be"]);
function tokenize(text) {
  return new Set(
    String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !_STOP.has(w))
  );
}

// Rule-based Lucide candidates: score 5 (strong) for a rule match, as a bonus on top of
// name/tag scoring. Returns an ordered array of {key, score} for items above threshold.
function lucideCandidatesForItem(text) {
  const tokens = tokenize(text);
  // Step 1: rule-based priority candidates (scored as 5 + tag-score so they always beat tag-only)
  const rulePriority = [];
  for (const [re, names] of LUCIDE_RULES) {
    if (re.test(text)) {
      for (const name of names) {
        if (_lucide[name]) {
          const base = lucideScore(tokens, name, _lucide[name].tags);
          rulePriority.push({ key: `lucide:${name}`, score: 5 + base });
        }
      }
    }
  }
  // Step 2: score ALL lucide icons against token set (for very specific matches)
  // Only consider icons with base score >= LUCIDE_THRESHOLD (real threshold).
  // For performance: skip this pass if rule priority already covers the item.
  const byScore = [];
  for (const [name, entry] of Object.entries(_lucide)) {
    if (name.startsWith("_")) continue; // skip _meta
    const sc = lucideScore(tokens, name, entry.tags);
    if (sc >= LUCIDE_THRESHOLD) byScore.push({ key: `lucide:${name}`, score: sc });
  }
  // Merge: rule-priority entries first (higher score), then remaining by score desc.
  const seen = new Set(rulePriority.map((x) => x.key));
  const merged = [
    ...rulePriority,
    ...byScore.filter((x) => !seen.has(x.key)).sort((a, b) => b.score - a.score)
  ];
  // Deduplicate keys (rule entries may repeat from the full scan)
  const deduped = [];
  const dedupSeen = new Set();
  for (const x of merged) {
    if (!dedupSeen.has(x.key)) { deduped.push(x); dedupSeen.add(x.key); }
  }
  return deduped; // [{key: "lucide:brain", score: N}, …]
}

// Full candidate list for an item: svgl brand (score=100) then lucide by score.
// Returns [{key, score, source}] — key is "svgl:name" or "lucide:name".
export function iconCandidatesV3(text) {
  const out = [];
  const brand = svglBrandMatch(text);
  if (brand) out.push({ key: `svgl:${brand}`, score: 100, source: "svgl" });
  // Curated concept layer (score 90): a hand-chosen icon for this exact concept.
  // After brand (a brand mention is the strongest, most literal signal) and before
  // generic Lucide scoring so a deliberate choice always beats the heuristic guess.
  const concept = conceptIconMatch(text);
  if (concept && concept !== `svgl:${brand}`) out.push({ key: concept, score: 90, source: "concept" });
  const lucide = lucideCandidatesForItem(text);
  for (const { key, score } of lucide) out.push({ key, score, source: "lucide" });
  return out;
}

// Free-text icon search for the Edit-icons picker (so a bullet can take ANY glyph, not only the
// ranked auto-matches). Scores Lucide (names + tags) and brands (key + title + tokens) by
// exact(3) / prefix(2) / substring(1) and returns the top `limit` as {key, source}. Pure read of
// the vendored sets; fast enough to call per keystroke locally.
export function searchIcons(query, limit = 40) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const scoreName = (name) => (name === q ? 3 : name.startsWith(q) ? 2 : name.includes(q) ? 1 : 0);
  const pool = [];
  for (const [name, entry] of Object.entries(_lucide)) {
    let s = scoreName(name);
    if (!s && Array.isArray(entry.tags) && entry.tags.some((t) => String(t).toLowerCase().includes(q))) s = 1;
    if (s) pool.push({ key: `lucide:${name}`, source: "lucide", s });
  }
  for (const [key, entry] of Object.entries(_brandIndex)) {
    let s = Math.max(scoreName(key.toLowerCase()), scoreName(String(entry.title || "").toLowerCase()));
    if (!s && Array.isArray(entry.tokens) && entry.tokens.some((t) => String(t).toLowerCase().includes(q))) s = 1;
    if (s) pool.push({ key: `svgl:${key}`, source: "svgl", s });
  }
  pool.sort((a, b) => b.s - a.s || a.key.length - b.key.length);
  return pool.slice(0, limit).map(({ key, source }) => ({ key, source }));
}

// "Genuine" test for v3: brand hit OR curated concept OR lucide score >= LUCIDE_THRESHOLD.
export function isGenuineV3(text) {
  if (isNameLike(text)) return false;
  return iconCandidatesV3(text).length > 0;
}

// E6 — NAME DETECTION. A feature-list item that reads as a proper name (or a name list
// entry) is NOT a semantic icon target: "Minsky", "Abelson / Schank", an author—topic line
// like "Brooks — Robotics — model free". Such items must never pull an icon.
// People names (personal names) are filtered. Brand names like "Google" or "GitHub" are
// NOT filtered by this — they are caught first by svglBrandMatch above.
const COMMON_OPENERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "how", "why", "what", "when", "where",
  "who", "first", "second", "third", "early", "late", "single", "solving", "beyond",
  "logical", "classical", "knowledge", "making", "problem", "from", "to", "of", "in", "on",
  "and", "or", "with", "without", "into"
]);
function isNameLike(rawText) {
  let t = String(rawText).replace(/[*`_]/g, "").replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "").trim();
  if (!t) return false;
  const head = t.split(/\s*[—–/]\s*|\s*-\s+/)[0].trim();
  const firstWord = head.split(/\s+/)[0]?.replace(/[.,]$/, "") || "";
  const startsCapital = /^[A-Z][a-z]+/.test(firstWord);
  if (!startsCapital) return false;
  // If the first capitalised word matches a known brand alias, it’s NOT a personal name.
  for (const [re] of ALIAS_MAP) {
    if (re.test(firstWord)) return false;
  }
  // Also check data-derived token index for the first word.
  if (_svglTokenIndex.has(firstWord.toLowerCase())) return false;
  if (COMMON_OPENERS.has(firstWord.toLowerCase())) return false;
  if (/^[A-Z][a-z]+,/.test(t)) return true;
  const words = head.split(/\s+/);
  // A SINGLE capitalised word that semantically matches a Lucide rule is a common
  // noun ("Preprints", "Tweets", "Substack"), not a person name. Multi-word
  // name-shaped heads ("Marvin Minsky") keep the name verdict.
  if (words.length === 1 && t.split(/\s+/).length === 1
      && LUCIDE_RULES.some(([re]) => re.test(t))) return false;
  const nameShapedHead = words.length >= 1 && words.length <= 3
    && words.every((w) => /^[A-Z][a-z’’.]*$/.test(w));
  if (!nameShapedHead) return false;
  return true;
}

// ---------------------------------------------------------------------------
// ICON MODEL — Layer 1 (deterministic, build-time). Consistency, not uniqueness.
// (Revised 2026-06-09; supersedes the deck-level no-repeat rule AND the short-lived
//  per-slide logo flag. See references/slide-design-language.md → "Icon vocabulary".)
//
// CONCEPT KEY. Every {iconlist} item is resolved to a CONCEPT KEY — the normalised
// concept it maps to, NOT its raw text. The algorithmic resolver's top candidate IS
// that concept identity: two items whose best semantic candidate is the same key
// (e.g. both resolve to "lucide:brain", or a curated "lucide:zap") name the same
// concept. The key comes from the SAME concept/semantic resolver used everywhere
// (concept-icons.json phrase match, then lucide tag/name match) — see
// iconCandidatesV3 / conceptIconMatch.
//
// PER-DECK CONCEPT→ICON VOCABULARY. The deck carries a lexicon (createIconVocabulary):
//   byConcept: concept key → assigned icon key
//   byIcon:    icon key     → concept key   (reverse, to keep it ≈ one-to-one)
// First occurrence of a concept ASSIGNS its icon; every later item with the SAME
// concept REUSES that icon (deck-wide consistency — same idea, same glyph). Distinct
// concepts get DISTINCT icons (an icon maps to one concept deck-wide), so within a
// slide distinct concepts are automatically distinct. A concept that legitimately
// recurs on one slide KEEPS its icon (consistency wins; rare, acceptable).
//
// LOGOS HAVE NO UNIQUENESS AT ALL. {logolist} brand logos never touch this vocabulary
// (see resolveBrandLogos): a brand → its logo every time it appears, repeatable across
// slides AND within one slide. They neither consult nor register the lexicon.
//
// LAYER 2 HOOK. `overrides` (an array aligned to items) lets a future agent-enrichment
// pass stamp an explicit icon key per item ({icon=name} on the item, or a deck `icons:`
// block). A present override WINS over the algorithmic assignment and is recorded in
// the vocabulary as that concept's icon. Layer 2 builds these overrides; Layer 1 only
// consumes them. Implemented now so Layer 2 is a drop-in; no agent pass is built here.
// ---------------------------------------------------------------------------

// The deck-level icon lexicon. Threaded through renderModelSlides → renderBlock →
// decideFeatureListStyle so consistency holds across the whole deck.
// `iconMap` (optional, Layer 2): a deck-level `icons:` block — normalised concept phrase → icon key
// — built from frontmatter (see buildDeckIconMap). Rides on the vocabulary so it reaches renderBlock
// without a new parameter; consulted as an override (see resolveIconOverrides).
export function createIconVocabulary(iconMap = null) {
  return { byConcept: new Map(), byIcon: new Map(), iconMap: iconMap || null };
}

// Build the deck `icons:` override map from a frontmatter `icons:` object (Layer 2 drop-in).
// `{ "github": "svgl:github", "memory": "brain", ... }` → Map(normalised phrase → renderable key).
// Unresolvable entries are skipped (a typo never becomes a blank slot).
export function buildDeckIconMap(raw) {
  if (!raw || typeof raw !== "object") return null;
  const map = new Map();
  for (const [phrase, name] of Object.entries(raw)) {
    const key = normalizeIconOverrideKey(name);
    if (key) map.set(normalizeConceptPhrase(phrase), key);
  }
  return map.size ? map : null;
}

// Merge Layer-2 overrides for a list, index-aligned to `items`. Per-item `{icon=name}`
// (perItem[idx]) wins; else the deck `icons:` map matched on the item's normalised concept
// phrase; else null (Layer 1 assigns). Returns null when there are no overrides at all.
export function resolveIconOverrides(items, perItem, deckIconMap) {
  if (!perItem && !deckIconMap) return null;
  let any = false;
  const out = items.map((it, idx) => {
    const own = perItem && perItem[idx];
    if (own) { any = true; return own; }
    if (deckIconMap) {
      const hit = deckIconMap.get(normalizeConceptPhrase(it));
      if (hit) { any = true; return hit; }
    }
    return null;
  });
  return any ? out : null;
}

// Sentinel prefix for an explicit-but-UNKNOWN icon override (ADR-0005, Task 7). An author who
// pins a fully qualified icon name that does not exist (`{icon=lucide:no-such-name}`) made a
// DELIBERATE choice; it should fail visibly-but-gracefully — a neutral placeholder mark that
// preserves list alignment — never be silently swapped for a different auto-picked concept icon.
// iconSvg() renders any `fallback:…` key as a plain circle outline carrying data-icon-fallback.
export const ICON_FALLBACK_PREFIX = "fallback:";

// LAYER 2 OVERRIDE — normalise an authored icon name into a renderable icon key.
// Accepts a bare lucide/brand name ("brain" → "lucide:brain") or an explicit prefixed key
// ("svgl:github", "lucide:zap").
//   - A valid name resolves to its real key (unchanged).
//   - An EXPLICITLY PREFIXED but unknown name ("lucide:no-such-name", "svgl:no-such-brand") is an
//     unambiguous author choice → a `fallback:<name>` sentinel (rendered as a neutral placeholder),
//     so the deliberate pin fails visibly rather than being silently reassigned by Layer 1.
//   - A BARE unresolvable token still returns null: the `{name}` shorthand relies on that to leave
//     ordinary trailing braces ("- the set {a, b}") as literal text, and a bare typo falls through
//     to Layer 1 auto-assignment as before.
export function normalizeIconOverrideKey(raw) {
  const v = String(raw).trim();
  if (!v) return null;
  if (v.startsWith("lucide:")) return _lucide[v.slice(7)] ? v : `${ICON_FALLBACK_PREFIX}${v}`;
  if (v.startsWith("svgl:")) return isBrandRenderable(v.slice(5)) ? v : `${ICON_FALLBACK_PREFIX}${v}`;
  if (_lucide[v]) return `lucide:${v}`;
  if (isBrandRenderable(v)) return `svgl:${v}`;
  return null;
}

// Resolve an item's CONCEPT KEY: the top-ranked candidate (restricted to the allowed
// `sources`) the item maps to. null when the item resolves to nothing.
function conceptKeyForItem(text, sources = null) {
  const sourceOk = (src) => !sources || sources.includes(src);
  for (const { key } of iconCandidatesV3(text)) {
    if (sourceOk(key.startsWith("svgl:") ? "svgl" : key.startsWith("lucide:") ? "lucide" : "concept")) return key;
  }
  return null;
}

// `vocab` (createIconVocabulary or null): the per-deck concept→icon lexicon, mutated in place.
//   - first time a concept is seen → assign + record (concept↔icon).
//   - same concept again (this slide or a later one) → REUSE its icon (consistency).
//   - distinct concepts get distinct icons (an icon is bound to one concept deck-wide).
// `sources` (optional): restrict candidates. `{iconlist}` → SEMANTIC (concept+lucide+svgl-as-icon);
//   the non-applied auto suggestion leaves it unset (all sources).
// `overrides` (optional, Layer 2): array aligned to items; a non-empty entry is an explicit icon
//   key that WINS over the algorithmic pick and is recorded as that item's concept icon.
// Returns array of icon keys (one per item) or null → fall back to plain.
function assignFeatureIconsV3(items, vocab, sources = null, overrides = null) {
  if (!Array.isArray(items) || items.length === 0) return null;
  // When the author EXPLICITLY pins an icon on any item ({icon=name}), the list is icon-mode by
  // intent — a sibling that resolves to nothing must NOT drop the whole list to plain (the
  // all-or-nothing rule is for AUTO lists only). Unresolved slots fall back to a number disc in
  // the renderer, so valid pins always render.
  const hasOverrides = Array.isArray(overrides) && overrides.some(Boolean);
  const lex = vocab || createIconVocabulary();
  const assigned = new Array(items.length).fill(null);
  const sourceOk = (src) => !sources || sources.includes(src);
  const candidatesPerItem = items.map((it) => iconCandidatesV3(it).filter((c) => sourceOk(c.source)));

  // Bind an icon to a concept in the lexicon and return it. The concept may already be
  // bound (reuse) — in that case the existing binding stands.
  const bind = (conceptKey, iconKey) => {
    if (!lex.byConcept.has(conceptKey)) {
      lex.byConcept.set(conceptKey, iconKey);
      lex.byIcon.set(iconKey, conceptKey);
    }
    return lex.byConcept.get(conceptKey);
  };
  // Is `iconKey` free to bind to `conceptKey`? Free when unbound, or already bound to this
  // same concept (idempotent). Bound to a DIFFERENT concept → not free (keeps ≈ one-to-one).
  const iconFree = (iconKey, conceptKey) =>
    !lex.byIcon.has(iconKey) || lex.byIcon.get(iconKey) === conceptKey;

  // WITHIN-LIST DIVERSITY (2026-06-09, review fix): two DIFFERENT items on one slide never
  // show the same glyph, even when both top-pick the same icon ("Run commands" / "Run
  // computer code" both resolve to lucide:terminal; "…local machine" / "…on that machine"
  // both to the cpu chip). Identical item TEXTS still share (a true repeat). The per-slide
  // alternative is NOT bound into the deck lexicon — the concept keeps its canonical icon
  // for later slides; only this list diversifies.
  const usedInList = new Map(); // iconKey → the item text that first used it in this list
  const usableHere = (iconKey, idx) =>
    !usedInList.has(iconKey) || usedInList.get(iconKey) === String(items[idx]);
  const note = (iconKey, idx) => { if (iconKey) usedInList.set(iconKey, String(items[idx])); };

  for (let idx = 0; idx < items.length; idx += 1) {
    // Layer 2 override wins outright: it defines this item's concept icon (even a duplicate —
    // an explicit author choice is never second-guessed).
    const override = overrides && overrides[idx];
    if (override) {
      const conceptKey = `override:${override}`;
      assigned[idx] = bind(conceptKey, override);
      note(assigned[idx], idx);
      continue;
    }
    const conceptKey = conceptKeyForItem(items[idx], sources);
    if (conceptKey == null) { assigned[idx] = null; continue; }
    // Concept already in the lexicon → REUSE its icon (deck-wide consistency) — unless that
    // glyph is already showing on this slide for a different item (→ pass 2 diversifies).
    if (lex.byConcept.has(conceptKey)) {
      const icon = lex.byConcept.get(conceptKey);
      if (usableHere(icon, idx)) {
        assigned[idx] = icon;
        note(icon, idx);
      }
      continue;
    }
    // New concept → assign the best candidate whose icon isn't already owned by ANOTHER
    // concept and isn't already showing on this slide.
    let iconKey = null;
    for (const { key } of candidatesPerItem[idx]) {
      if (iconFree(key, conceptKey) && usableHere(key, idx)) { iconKey = key; break; }
    }
    if (iconKey) {
      assigned[idx] = bind(conceptKey, iconKey);
      note(assigned[idx], idx);
    }
  }

  // Fill any hole (preferred glyph owned by another concept or already on this slide, OR no
  // candidate at all): first retry the item's OWN candidates (better semantics), then a fresh
  // distinct lucide glyph — but only when lucide is an allowed source and the item DID resolve
  // to a concept. A logos-only list, or an item that resolves to nothing, drops the whole list
  // to plain (never a half-iconed list).
  for (let idx = 0; idx < items.length; idx += 1) {
    if (assigned[idx]) continue;
    const override = overrides && overrides[idx];
    if (override) continue; // already handled
    const conceptKey = conceptKeyForItem(items[idx], sources);
    if (conceptKey == null) { if (hasOverrides) continue; return null; } // resolves to nothing → plain (auto only)
    let picked = null;
    for (const { key } of candidatesPerItem[idx]) {
      if (iconFree(key, conceptKey) && usableHere(key, idx)) { picked = key; break; }
    }
    if (!picked && sourceOk("lucide")) for (const name of Object.keys(_lucide)) {
      if (name.startsWith("_")) continue;
      const key = `lucide:${name}`;
      if (iconFree(key, conceptKey) && usableHere(key, idx)) { picked = key; break; }
    }
    if (!picked) { if (hasOverrides) continue; return null; } // truly exhausted (auto only)
    // Bind only when this concept has no canonical icon yet; a per-slide alternative
    // (concept already bound, glyph taken on this slide) stays local to this list.
    assigned[idx] = lex.byConcept.has(conceptKey) ? picked : bind(conceptKey, picked);
    note(assigned[idx], idx);
  }
  return assigned;
}

// Derive the monogram letter for a logolist item that has no real brand mark. Strip
// markdown emphasis, list markers and numbering, then take the FIRST letter or digit,
// uppercased. Falls back to "?" only if the label has no alphanumerics at all (never
// blank). "Vercel" → "V"; "**1Password**" → "1"; "the API" → "T".
function monogramLetter(text) {
  const cleaned = String(text)
    .replace(/[*`_]/g, "")
    .replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "")
    .trim();
  const m = cleaned.match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "?";
}

// {logolist} BRAND LOGOS — ZERO uniqueness. A brand resolves to its logo EVERY time it
// appears: repeatable across slides AND within one slide. Logos never consult or register
// the icon vocabulary (no registry pollution). `overrides` (Layer 2) still win.
//
// MONOGRAM FALLBACK (2026-06-09): a slot with no real brand mark renders an HONEST
// monogram chip — a neutral rounded square holding the company's FIRST LETTER — NOT a
// misleading generic shape and NEVER plain. So a logolist ALWAYS renders every item (real
// logo OR monogram); the old "all-or-plain" drop is retired for logos. resolveBrandLogos
// therefore never returns null for a non-empty list.
function resolveBrandLogos(items, overrides = null) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = new Array(items.length).fill(null);
  for (let idx = 0; idx < items.length; idx += 1) {
    const override = overrides && overrides[idx];
    if (override) { out[idx] = override; continue; }
    const brand = svglBrandMatch(items[idx]);
    out[idx] = brand ? `svgl:${brand}` : `monogram:${monogramLetter(items[idx])}`;
  }
  return out;
}

// E6 — per-list CLASSIFICATION (v3, semantic-gap aware). Pure, deck-state-free.
// Returns { kind, gaps } describing how a list SHOULD render before deck-level
// uniqueness is applied:
//   kind "numbers"        → ordered sequence.
//   kind "plain"          → name-dominated, or too few genuine matches, or a
//                           genuine list with too many (≥3) holes — not iconable.
//   kind "icons"          → every item is genuinely matched (brand/concept/Lucide).
//   kind "icon-resolvable"→ ≥2 genuine matches AND only 1–2 unmatched items.
//                           `gaps` lists those unmatched item texts. Each gap is
//                           either curated in concept-icons.json (then it is in
//                           fact genuine and the list is fully iconable) or NOT
//                           (then it needs a semantic check and the list renders
//                           PLAIN for now while `icon-semantic-needed` is emitted).
// This is the single source of truth shared by decideFeatureListStyle (render)
// and collectSemanticIconNeeds (warning emission) so they never disagree.
const ICON_RESOLVABLE_MAX_GAPS = 2; // 1–2 holes is "resolvable"; 3+ is plain.
const ICON_RESOLVABLE_MIN_GENUINE = 2; // need ≥2 real anchors to carry the list.
export function classifyFeatureList(items, ordered = false) {
  if (!Array.isArray(items) || items.length === 0) return { kind: "plain", gaps: [] };
  if (ordered) return { kind: "numbers", gaps: [] };
  const nameCount = items.filter((it) => isNameLike(it)).length;
  if (nameCount / items.length >= 0.5) return { kind: "plain", gaps: [] };
  const genuine = items.map((it) => isGenuineV3(it));
  const genuineCount = genuine.filter(Boolean).length;
  const gapItems = items.filter((_, i) => !genuine[i]);
  // Fully matched → icons.
  if (gapItems.length === 0 && genuineCount >= 1) return { kind: "icons", gaps: [] };
  // Icon-resolvable: enough genuine anchors AND only a couple of holes. Not
  // name-dominated (guarded above), not ordered (guarded above).
  if (genuineCount >= ICON_RESOLVABLE_MIN_GENUINE && gapItems.length >= 1
      && gapItems.length <= ICON_RESOLVABLE_MAX_GAPS) {
    return { kind: "icon-resolvable", gaps: gapItems };
  }
  // Otherwise keep the legacy ≥60%-genuine gate as a wider net (e.g. a 6-item list
  // with 4 genuine + 2 holes is already caught above as icon-resolvable; a list
  // that falls below 60% genuine with >2 holes stays plain).
  if (genuineCount / items.length >= 0.6 && gapItems.length === 0) {
    return { kind: "icons", gaps: [] };
  }
  return { kind: "plain", gaps: gapItems };
}

// Per-list STYLE DECISION. ICONS ARE OPT-IN (2026-06-08; ADR-0004 + html-presentations-p1 step 2).
//
// DEFAULT (no `forceStyle`): a list is PLAIN, nicely styled, NO auto icons. The ONE auto style
// kept is NUMBERS for an ordered (`1.`/`2.`) source list — that is least surprising (the author
// already typed numbers). The old auto-icon heuristic (classifyFeatureList) no longer DRIVES the
// render; it survives only as a non-applied SUGGESTION emitted as an `icon-suggested:` build hint
// (see collectIconSuggestions), so the intelligence stays but never surprises.
//
// OPT-IN via the `{numbered}` / `{iconlist}` / `{logolist}` / `{plainlist}` triggers, which set
// `forceStyle` to "numbers" | "icons" | "logos" | "plain":
//   numbers → numbered discs (works on any list, ordered or not).
//   icons   → SEMANTIC icons via the per-deck concept→icon VOCABULARY: same concept reuses its
//             glyph deck-wide (consistency), distinct concepts stay distinct (≈ one-to-one).
//   logos   → BRAND logos (svgl) — NO uniqueness at all; a brand → its logo every time, freely
//             repeatable across and within slides; never touches the vocabulary.
//   plain   → force plain even for an ordered list.
// A forced icon/logo list that cannot resolve every slot falls back to plain (never a half-iconed
// list); numbers always succeed.
//
// `vocab` (createIconVocabulary or null): the deck-level concept→icon lexicon, mutated in place by
//   {iconlist}. {logolist} ignores it entirely. (A bare Set is tolerated for back-compat — it is
//   simply not consulted; pass a vocabulary from renderModelSlides for real consistency.)
// `overrides` (optional, Layer 2 hook): array aligned to items; a non-empty entry is an explicit
//   icon key ({icon=name} per item or a deck `icons:` block) that WINS over the algorithmic pick.
export function decideFeatureListStyle(items, ordered = false, vocab = null, forceStyle = "", overrides = null) {
  const lex = vocab && vocab.byConcept ? vocab : null; // only a real vocabulary is consulted
  if (forceStyle === "plain") return { style: "plain", icons: null };
  if (forceStyle === "numbers") {
    return Array.isArray(items) && items.length ? { style: "numbers", icons: null } : { style: "plain", icons: null };
  }
  if (forceStyle === "icons") {
    // {iconlist} = "give this list icons" — the broadest semantic set (brand svgl + curated
    // concept + lucide). The vocabulary assigns/reuses per concept: same idea → same glyph
    // deck-wide; distinct ideas → distinct glyphs. Falls back to plain if any slot cannot be
    // resolved (never a half-iconed list).
    const icons = assignFeatureIconsV3(items, lex, null, overrides);
    return icons ? { style: "icons", icons } : { style: "plain", icons: null };
  }
  if (forceStyle === "logos") {
    // {logolist} = brand logos ONLY (svgl/extra). NO uniqueness whatsoever: a brand resolves to
    // its logo every time it appears, repeatable across slides and within one slide. A non-brand
    // slot drops the whole list to plain. Logos never consult or register the vocabulary.
    const icons = resolveBrandLogos(items, overrides);
    return icons ? { style: "icons", icons } : { style: "plain", icons: null };
  }
  // DEFAULT: numbers stay auto for an ordered list; everything else is plain (icons opt-in only).
  if (ordered && Array.isArray(items) && items.length) return { style: "numbers", icons: null };
  return { style: "plain", icons: null };
}

// Would a forced {iconlist}/{iconrow} over `items` resolve to icons, or fall back
// to plain? Returns true iff assignFeatureIconsV3 produces a full icon set. Shares
// the SAME resolver decideFeatureListStyle uses for forceStyle "icons", so the
// warning emitter and the render agree on the all-fail case. A fresh empty vocab is
// used: the all-fail verdict (some item resolves to NO concept) is independent of
// deck-wide consistency state, so this is a safe build-time test before render.
export function iconlistResolves(items, overrides = null) {
  return assignFeatureIconsV3(items, createIconVocabulary(), null, overrides) != null;
}

// ---------------------------------------------------------------------------
// Brand SVG renderability (build-time validation against the invisible-icon bug).
//
// Some svgl brand SVGs draw their entire geometry in white (fill="#fff" / "white"
// and/or stroke white, with fill="none" elsewhere). On the light icon panel
// (var(--panel)) such an SVG paints white-on-white — a visibly blank slot. The
// per-slot no-empty-string audit passes (the markup is present) yet nothing renders.
//
// classifyBrandSvg() inspects the raw SVG for paint:
//   - "colored"   : has at least one non-white, non-"none" fill or stroke → render as-is.
//   - "white-mono" : the only visible paint is white (#fff/#ffffff/white) → INVISIBLE on
//                    the light panel. We recolour white paint to currentColor so the icon
//                    inherits the accent (same treatment lucide stroke icons get).
//   - "empty"      : no drawable geometry / no visible paint at all → not renderable.
//
// Default-coloured shapes (no explicit fill, inheriting black) count as "colored":
// a path with no fill attribute renders black on the panel, which is visible.
// ---------------------------------------------------------------------------
// White / near-white paint: CSS "white", or an all-`f` hex of any length (#fff, #ffff,
// #ffffff — svgl carries some malformed #ffff values), or #fefefe. These all paint
// white-on-white on the light icon panel.
function isWhitePaint(value) {
  const v = String(value).trim().toLowerCase();
  if (v === "white" || v === "#fefefe") return true;
  const hex = v.startsWith("#") ? v.slice(1) : "";
  return hex.length >= 3 && /^f+$/.test(hex);
}
function classifyBrandSvg(svg) {
  if (typeof svg !== "string" || !/<\s*(path|circle|rect|polygon|polyline|ellipse|line|g)\b/i.test(svg)) {
    return "empty";
  }
  // Collect explicit fill/stroke paint values across the whole document.
  const paints = [];
  for (const m of svg.matchAll(/\b(fill|stroke)\s*=\s*["']([^"']*)["']/gi)) {
    paints.push({ attr: m[1].toLowerCase(), value: m[2].trim() });
  }
  // Also catch inline style="fill:#fff" / style="stroke:white".
  for (const m of svg.matchAll(/style\s*=\s*["']([^"']*)["']/gi)) {
    for (const decl of m[1].split(";")) {
      const [prop, val] = decl.split(":").map((s) => (s || "").trim());
      if (prop === "fill" || prop === "stroke") paints.push({ attr: prop, value: val });
    }
  }
  // Does any drawable element have NO explicit fill? It inherits from the ROOT <svg>
  // when that carries a fill — dark-mode brand marks ship fill="#fff" on the root and
  // paint nothing else, which rendered white-on-white (invisible) until 2026-06-09.
  // Only with no root fill does an unpainted shape inherit the default black.
  // (Stroked-only shapes without fill set fill="none", which IS captured above.)
  const hasUnpaintedShape = /<\s*(path|circle|rect|polygon|polyline|ellipse)\b(?![^>]*\bfill\s*=)(?![^>]*style\s*=\s*["'][^"']*fill)/i.test(svg);
  const rootFill = ((svg.match(/<\s*svg\b[^>]*?\bfill\s*=\s*["']([^"']*)["']/i) || [])[1] || "").trim();
  let sawWhite = false;
  let sawColored = false;
  for (const { value } of paints) {
    if (!value || value.toLowerCase() === "none" || value.toLowerCase() === "currentcolor") continue;
    if (value.toLowerCase().startsWith("url(")) { sawColored = true; continue; } // gradient/pattern
    if (isWhitePaint(value)) sawWhite = true;
    else sawColored = true;
  }
  if (hasUnpaintedShape) {
    if (rootFill && isWhitePaint(rootFill)) sawWhite = true;
    else sawColored = true; // coloured root fill, or no root fill → default black
  }
  if (sawColored) return "colored";
  if (sawWhite) return "white-mono";
  return "empty";
}

// Recolour every white paint token in a white-mono brand SVG to currentColor so the
// icon inherits the panel accent. Touches only white values; leaves geometry intact.
function recolorWhiteToCurrent(svg) {
  return svg
    .replace(/\b(fill|stroke)\s*=\s*["']([^"']*)["']/gi, (m, attr, val) => isWhitePaint(val) ? `${attr}="currentColor"` : m)
    .replace(/(fill|stroke)\s*:\s*([^;"']+)/gi, (m, prop, val) => isWhitePaint(val) ? `${prop}:currentColor` : m);
}

// Render an icon key to HTML.
// "lucide:brain" → Lucide stroke SVG (currentColor)
// "svgl:github"  → brand SVG from svgl or extra (own fill / currentColor, normalised box)
// "monogram:V"   → honest first-letter chip when no real brand mark exists (logolist fallback)
export function iconSvg(key) {
  if (!key) return "";
  if (key.startsWith("monogram:")) {
    // Honest fallback: a neutral rounded-square chip holding the company's first letter.
    // Sits in the same .fl-icon box as a real logo (.fl-svg-brand). Pure render, no network.
    const letter = escapeHtml(key.slice(9) || "?");
    return `<span class="fl-svg fl-svg-mono" aria-hidden="true">${letter}</span>`;
  }
  if (key.startsWith(ICON_FALLBACK_PREFIX)) {
    // Explicit-but-unknown override (ADR-0005). A neutral placeholder: a plain circle outline in
    // the SAME box metrics as a real Lucide glyph (viewBox 0 0 24 24, stroke currentColor, width 2)
    // so alignment is preserved, carrying the requested-but-missing name in data-icon-fallback for
    // author debugging. Never a different concept icon — the author's choice fails visibly.
    const requested = escapeHtml(key.slice(ICON_FALLBACK_PREFIX.length));
    return `<svg class="fl-svg fl-svg-lucide fl-svg-fallback" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-icon-fallback="${requested}"><circle cx="12" cy="12" r="10"/></svg>`;
  }
  if (key.startsWith("lucide:")) {
    const name = key.slice(7);
    const entry = _lucide[name];
    if (!entry) return "";
    return `<svg class="fl-svg fl-svg-lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${entry.body}</svg>`;
  }
  if (key.startsWith("svgl:")) {
    const name = key.slice(5);
    // Look up in merged brand index (covers both svgl and extra entries).
    const entry = _brandIndex[name];
    if (!entry) return "";
    // Build-time renderability guard (invisible-icon bug). A white-mono SVG (e.g. the
    // Markdown logo, drawn entirely in #FFF) would paint white-on-white on the light
    // icon panel — recolour its white paint to currentColor so it inherits the accent.
    // An empty SVG (no drawable geometry / no visible paint) is not renderable → "".
    let rawSvg = entry.svg;
    const klass = classifyBrandSvg(rawSvg);
    if (klass === "empty") return "";
    if (klass === "white-mono") rawSvg = recolorWhiteToCurrent(rawSvg);
    // Wrap the brand SVG in a normalised container. The SVG keeps its own viewBox
    // and fill (brand colour or currentColor) — CSS controls sizing via .fl-svg-brand.
    // Strip any explicit width/height attrs from the outer <svg> tag.
    const cleanSvg = rawSvg.replace(/<svg([^>]*)>/i, (_, attrs) => {
      const cleaned = attrs.replace(/\s*(width|height)\s*=\s*["’][^"’]*["’]/gi, "");
      return `<svg class="fl-svg fl-svg-brand"${cleaned} aria-hidden="true">`;
    });
    return cleanSvg;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Icon-gap detection (build-time, conservative).
//
// Fires for a feature-list item when ALL of the following hold:
//   1. The item is not name-like (would be filtered by isNameLike).
//   2. The item's first capitalised token is not matched by any brand source
//      (svgl, extra, or ALIAS_MAP) AND is not matched semantically by any
//      Lucide rule either.
//   3. The capitalised token LOOKS like a brand: starts with an uppercase letter,
//      followed by at least one lowercase letter (rules out ALL-CAPS acronyms that
//      are generic), and is not a known common English noun.
//
// Returns an array of { item, term } objects for items that look like brand gaps.
// Callers collect terms and emit `icon-gap:<term>` warnings.
// ---------------------------------------------------------------------------
const _COMMON_NOUNS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "with",
  "from", "by", "this", "that", "these", "those", "how", "why", "what", "when",
  "where", "who", "first", "second", "third", "early", "late", "single",
  "solving", "beyond", "logical", "classical", "knowledge", "making", "problem",
  "interviews", "videos", "reports", "publications", "papers", "repositories",
  "sites", "newsletters", "podcasts", "posts", "articles", "blogs", "sources",
  "research", "academic", "papers", "preprints", "benchmarks", "services",
  "platforms", "applications", "tools", "models", "agents", "datasets",
  "information", "data", "results", "evidence", "claims", "findings"
]);

// Common English sentence-opener words that, when capitalised, do NOT indicate brands.
// Also includes common adjective/verb first-words that appear in list-item prose.
const _PROSE_OPENERS = new Set([
  // Question / auxiliary starters
  "what", "who", "when", "where", "why", "how", "which", "can", "could",
  "will", "would", "should", "may", "might", "do", "does", "did", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had",
  // Common list-item openers in presentation prose
  "use", "used", "using", "uses", "new", "make", "need", "needs", "get",
  "keep", "look", "take", "work", "works", "try", "tries", "build", "built",
  "add", "allow", "avoid", "check", "choose", "create", "define", "enable",
  "ensure", "follow", "give", "help", "include", "increase", "introduce",
  "know", "learn", "limit", "manage", "measure", "move", "plan", "provide",
  "reduce", "require", "run", "see", "set", "show", "understand", "update",
  "validate", "verify",
  // Common adjectives that start list items
  "all", "any", "big", "both", "brief", "broad", "clear", "close", "complex",
  "consistent", "core", "current", "different", "direct", "diverse", "each",
  "early", "established", "explicit", "fast", "few", "final", "full", "good",
  "great", "greater", "greatest", "high", "large", "late", "limited", "local",
  "long", "low", "main", "many", "most", "much", "multiple", "new", "next",
  "no", "non", "old", "other", "own", "past", "poor", "possible", "potential",
  "primary", "private", "public", "quick", "rapid", "real", "recent", "same",
  "short", "simple", "slow", "small", "specific", "strong", "top", "true",
  "various", "wide",
  // Common presentation list-item nouns that are NOT brands
  "access", "accuracy", "agent", "analysis", "approach", "aspect", "assumption",
  "attention", "audience", "basis", "behaviour", "benefit", "bias", "capability",
  "capacity", "challenge", "change", "choice", "claim", "class", "comment",
  "concern", "condition", "confidence", "content", "context", "control", "cost",
  "coverage", "criteria", "culture", "decision", "dependency", "deployment",
  "design", "detail", "direction", "discussion", "distribution", "documentation",
  "domain", "element", "endpoint", "error", "evaluation", "example", "exception",
  "expectation", "experience", "expertise", "explanation", "factor", "failure",
  "feature", "feedback", "focus", "format", "foundation", "framework", "function",
  "goal", "guidance", "guideline", "history", "identity", "impact", "implication",
  "improvement", "input", "insight", "integration", "interaction", "interface",
  "interpretation", "issue", "judgement", "language", "layer", "level", "logic",
  "meaning", "mechanism", "method", "methodology", "metric", "model", "module",
  "monitoring", "motivation", "objective", "observation", "operation", "option",
  "output", "overview", "pattern", "performance", "permission", "policy",
  "position", "practice", "principle", "problem", "process", "property",
  "purpose", "quality", "question", "reasoning", "recommendation", "response",
  "restriction", "review", "risk", "role", "scope", "signal", "solution",
  "specification", "standard", "statement", "step", "strategy", "structure",
  "support", "system", "technique", "term", "theme", "theory", "topic",
  "understanding", "usage", "validation", "value", "variability", "variable",
  "version", "workflow"
]);

export function detectIconGaps(featureListItems) {
  const gaps = [];
  for (const item of featureListItems) {
    if (isNameLike(item)) continue;
    // Extract the FIRST capitalised token from the item text
    // (strips markdown, list markers, bold markers)
    const clean = String(item).replace(/\*\*?|`/g, "").replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "").trim();
    const words = clean.split(/\s+/);
    const firstWord = words[0] || "";

    // Must start uppercase + at least one lowercase — rules out ALL-CAPS and single chars.
    // Also rules out compound tokens like "AI" (all caps).
    if (!/^[A-Z][a-z]/.test(firstWord)) continue;
    const term = firstWord.replace(/[^a-zA-Z0-9]/g, "");
    if (term.length < 3) continue;
    const termLc = term.toLowerCase();

    // Skip common English prose openers, nouns, and generic terms
    if (_COMMON_NOUNS.has(termLc) || _PROSE_OPENERS.has(termLc)) continue;

    // Conservative: only fire for SHORT items that look like a brand name or product.
    // A brand-like item is typically: a single word, or 1–2 words where the second word
    // is a generic category noun ("Substack newsletter", "GitHub repositories", etc.).
    // Multi-word prose items ("Understanding the claim") are skipped.
    if (words.length > 3) continue; // "Peer-reviewed publications in CS" → skip
    if (words.length >= 2) {
      // Second/third words should be category-level nouns — not another brand or verb
      const secondWord = (words[1] || "").toLowerCase().replace(/[^a-z]/g, "");
      const thirdWord = (words[2] || "").toLowerCase().replace(/[^a-z]/g, "");
      const OK_CATEGORY_SUFFIXES = new Set([
        "repositories", "videos", "posts", "articles", "newsletters", "podcasts",
        "blog", "platform", "analytics", "ai", "app", "site", "tools", "api",
        "interviews", "sites", "network", "search", "assistant"
      ]);
      if (secondWord && !OK_CATEGORY_SUFFIXES.has(secondWord)) continue;
      if (thirdWord && !OK_CATEGORY_SUFFIXES.has(thirdWord)) continue;
    }

    // Skip if it matches ALIAS_MAP already
    let aliasHit = false;
    for (const [re] of ALIAS_MAP) {
      if (re.test(clean)) { aliasHit = true; break; }
    }
    if (aliasHit) continue;
    // Skip if token index resolves it (brand matched)
    if (_svglTokenIndex.has(termLc) && _brandIndex[_svglTokenIndex.get(termLc)]) continue;
    // Skip if any LUCIDE_RULE matches (semantic match exists)
    let lucideHit = false;
    for (const [re] of LUCIDE_RULES) {
      if (re.test(clean)) { lucideHit = true; break; }
    }
    if (lucideHit) continue;
    // This item is unmatched and looks brand-like
    gaps.push({ item, term: termLc });
  }
  return gaps;
}

// Scan a fully-built model (after blocks are lexed) for icon-gap terms.
// Collects unique terms across all feature-list blocks in all slides.
// Returns sorted deduplicated array of term strings.
export function collectIconGapTerms(slides) {
  const seen = new Set();
  for (const slide of (slides || [])) {
    const blocks = slide.blocks || [];
    function scanBlocks(bks) {
      for (const b of bks) {
        if (!b) continue;
        if ((b.type === "feature-list" || b.type === "list") && Array.isArray(b.items)) {
          for (const { term } of detectIconGaps(b.items)) {
            seen.add(term);
          }
        }
        // Recurse into cards
        if (b.type === "cards" && Array.isArray(b.cards)) {
          for (const card of b.cards) {
            if (Array.isArray(card.blocks)) scanBlocks(card.blocks);
          }
        }
      }
    }
    scanBlocks(blocks);
  }
  return [...seen].sort();
}

// Semantic-icon resolution detection. Scans every feature-list in the model for
// the "icon-resolvable" case (≥2 genuine matches, only 1–2 unmatched items) where
// an unmatched item is NOT yet curated in concept-icons.json. Each such item is a
// gap a human/agent must resolve by MEANING (pick an apt vendored icon, add it to
// concept-icons.json, rebuild). Returns warning strings:
//   `icon-semantic-needed:<slide-id>:<exact item text>`
// While a gap is unresolved the list renders PLAIN (decideFeatureListStyle), so a
// bare/ugly icon never ships. Curated gaps produce NO warning — the list is icons.
// (Mirrors collectIconGapTerms: walks slides + nested card blocks; uses the SAME
// classifyFeatureList predicate the renderer uses, so warnings and render agree.)
export function collectSemanticIconNeeds(slides) {
  const out = [];
  const seen = new Set();
  for (const slide of (slides || [])) {
    const slideId = slide.id || "";
    function scanBlocks(bks) {
      for (const b of bks) {
        if (!b) continue;
        if ((b.type === "feature-list" || b.type === "list") && Array.isArray(b.items)) {
          const { kind, gaps } = classifyFeatureList(b.items, b.ordered);
          if (kind === "icon-resolvable") {
            for (const gap of gaps) {
              if (conceptIconMatch(gap) !== null) continue; // already curated → no warning
              const key = `${slideId}\u0000${gap}`;
              if (seen.has(key)) continue;
              seen.add(key);
              out.push(`icon-semantic-needed:${slideId}:${gap}`);
            }
          }
        }
        if (b.type === "cards" && Array.isArray(b.cards)) {
          for (const card of b.cards) {
            if (Array.isArray(card.blocks)) scanBlocks(card.blocks);
          }
        }
      }
    }
    scanBlocks(slide.blocks || []);
  }
  return out;
}

// ALL-FAIL detection for AUTHOR-FORCED icon lists. When a list is explicitly turned
// into icons ({iconlist} → feature-list with liststyle "icons", or an {iconrow} block)
// but NOT ONE item resolves to a glyph, the renderer silently drops to plain (or, for
// iconrow, to numbered discs). The author asked for icons and got none — a real,
// actionable warning. Emits:
//   `iconlist-no-icons:<slide-id>`
// one per affected block (slide-id carried so TalkWeaver can surface it per-slide).
// Uses the SAME resolver as the render (iconlistResolves → assignFeatureIconsV3), so
// warning and render never disagree. Per-item {icon=name} overrides are honoured (an
// authored override rescues the list); a list that resolves to ANY icons is silent —
// only the total all-fail case warns. (Mirrors collectSemanticIconNeeds: walks slides
// + nested card blocks.)
export function collectIconlistNoIcons(slides) {
  const out = [];
  const seen = new Set();
  for (const slide of (slides || [])) {
    const slideId = slide.id || "";
    function scanBlocks(bks) {
      for (const b of bks) {
        if (!b) continue;
        const isForcedIconList =
          (b.type === "feature-list" || b.type === "list") && b.liststyle === "icons" && Array.isArray(b.items);
        const isIconRow = b.type === "iconrow" && Array.isArray(b.nodes);
        if (isForcedIconList || isIconRow) {
          const items = isIconRow
            ? b.nodes.filter((n) => n && n.text).map((n) => n.text)
            : b.items;
          const overrides = resolveIconOverrides(items, b.iconOverrides, null);
          if (items.length && !iconlistResolves(items, overrides)) {
            if (!seen.has(slideId)) {
              seen.add(slideId);
              out.push(`iconlist-no-icons:${slideId}`);
            }
          }
        }
        if (b.type === "cards" && Array.isArray(b.cards)) {
          for (const card of b.cards) {
            if (Array.isArray(card.blocks)) scanBlocks(card.blocks);
          }
        }
      }
    }
    scanBlocks(slide.blocks || []);
  }
  return out;
}

// ICON SUGGESTION (the auto-detect intelligence kept, but NEVER applied). Icons are opt-in
// (decideFeatureListStyle), so the old auto-icon heuristic no longer drives any render. Instead
// it survives here as a non-applied hint: for every feature-list the heuristic WOULD have iconed
// (and that the author did NOT force to a style), emit `icon-suggested:<slide-id>` so a human/
// agent sees the compiler still has an opinion — "this list could carry icons; add {iconlist} if
// you want them". One hint per qualifying list. A list already forced to a style (any
// `liststyle`) is skipped — the author already decided. (Mirrors collectSemanticIconNeeds:
// walks slides + nested card blocks; uses the SAME classifyFeatureList predicate.)
export function collectIconSuggestions(slides) {
  const out = [];
  const seen = new Set();
  for (const slide of (slides || [])) {
    const slideId = slide.id || "";
    function scanBlocks(bks) {
      for (const b of bks) {
        if (!b) continue;
        if ((b.type === "feature-list" || b.type === "list") && Array.isArray(b.items)) {
          if (!b.liststyle) {
            const { kind } = classifyFeatureList(b.items, b.ordered);
            // "icons" or "icon-resolvable" = the heuristic thinks icons fit. "numbers" is the
            // ordered-list case (auto-applied, no suggestion needed); "plain" = no opinion.
            if (kind === "icons" || kind === "icon-resolvable") {
              if (!seen.has(slideId)) {
                seen.add(slideId);
                out.push(`icon-suggested:${slideId}`);
              }
            }
          }
        }
        if (b.type === "cards" && Array.isArray(b.cards)) {
          for (const card of b.cards) {
            if (Array.isArray(card.blocks)) scanBlocks(card.blocks);
          }
        }
      }
    }
    scanBlocks(slide.blocks || []);
  }
  return out;
}

