import { DYNAMIC_PATTERNS, TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY } from './lib/trigger-dictionary.generated.mjs';

export { TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY };

// Trigger Dictionary — generated from the shared layout registry (ADR-0004 / ADR-0010).
//
// FOR ME (agent-facing). A bare token inside `{…}` on a slide heading (e.g. `{statement}`,
// `{reveal}`, `{numbered}`) resolves through this map to its canonical `(key, value)` pair —
// exactly what the author could have typed in explicit `{key=value}` form. This map IS the
// resolver: parseHeadingAttrs() looks every bare word up here. A bare word NOT in this map is
// not silently dropped — it produces an `unknown-trigger:<word>` build warning, so the
// dictionary is load-bearing (ADR-0004: "the dictionary is the bare-word resolver, not just
// documentation").
//
// One entry per existing layout and mode plus the standalone flags. Add a layout/mode here the
// moment the compiler grows one, so the bare-word form and the explicit form never diverge.
//
// Shape: bareWord -> { key, value }
//   - { key: "layout", value: "statement" }  → expands to {layout=statement}
//   - { key: "mode",   value: "reveal" }      → expands to {mode=reveal}
//   - { key: "sub",    value: true }          → a bare flag {sub}
//   - { key: "liststyle", value: "numbers" }  → opt-in list styling (icons/logos/numbers)
//
// CONCATENATION (parseHeadingAttrs): multiple triggers combine. `{numbered}{reveal}` (adjacent
// braces), `{numbered,reveal}` (comma) and `{numbered reveal}` (space) all merge into one attrs
// set. If two triggers set the SAME key with different values (e.g. two layouts), LAST WINS and
// a `trigger-conflict:<key>:<old>→<new>` warning is emitted.

/** @typedef {{ key: string, value: string|boolean }} TriggerTarget */

// Keys a bare word may resolve to. A bare token that is NOT in TRIGGER_DICTIONARY but IS a
// recognised explicit key written without `=` (none currently) would still be a flag; we keep
// this list so unknown-trigger detection stays precise.
export const RESOLVABLE_BARE_WORDS = new Set(Object.keys(TRIGGER_DICTIONARY));

// ── Dynamic trigger families (parameterised bare words) ──────────────────────
// {countdown-digits-30s} / {countdown-bar-3min}: the per-slide countdown ELEMENT (not a
// layout) in Dominik's requested sugar form. A dynamic family lives HERE so ADR-0004's
// "the dictionary is the resolver" stays honest — the family entry is part of the
// dictionary file even though its words are generated, not enumerated. The canonical
// explicit forms are `{countdown=30s}` (digits default) and `{countdown=3min
// countdown-style=bar}`; the sugar resolves to exactly those keys. Durations accepted by
// the build: `30s`, bare seconds (`90`), `3min`/`3m`, `m:ss` (`1:30`) — validation +
// `countdown-unparsed:<value>` warnings happen in the compiler, not here.
/**
 * Resolve a DYNAMIC bare word to a LIST of (key, value) pairs, or null when the word does
 * not belong to any family. Checked by parseHeadingAttrs after the dictionary lookup and
 * before unknown-trigger warnings.
 * @param {string} word
 * @returns {TriggerTarget[] | null}
 */
export function resolveDynamicTrigger(word) {
  for (const pattern of DYNAMIC_PATTERNS) {
    const match = new RegExp(pattern.source).exec(word);
    if (match) {
      return pattern.resolution.map(({ key, value }) => ({
        key,
        value: value.replace(/\$(\d+)/g, (_whole, index) => match[Number(index)] ?? ""),
      }));
    }
  }
  return null;
}

/**
 * Resolve a single bare word to its (key, value). Returns null when the word is not in the
 * dictionary (caller emits `unknown-trigger:<word>`).
 * @param {string} word
 * @returns {TriggerTarget | null}
 */
export function resolveTrigger(word) {
  return TRIGGER_DICTIONARY[word] ?? null;
}
