// Trigger values written in any case, with spaces or underscores for hyphens, for keys whose values are names rather than
// exact tokens. One rule, used by the compiler's validator and resolver (02-triggers-layout.mjs, section-leads.mjs) and
// by the editor's validator (src/shared/layout-registry/vocabulary.ts), so `{section-colour=Light_Amber}` both draws and
// validates as `light-amber`. Every other key keeps its value exactly as written.
const SPELLING_KEYS = new Set(["section-colour"]);

/** The value as the registry spells it: lower case, hyphens for spaces and underscores (for the keys above only). */
export function normaliseTriggerValue(key, value) {
  if (!SPELLING_KEYS.has(key) || typeof value !== "string") return value;
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}
