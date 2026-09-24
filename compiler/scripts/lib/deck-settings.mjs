// =============================================================================
// Deck setting readers (Composition Programme, Ticket 10)
//
// ONE place decides what a deck-level frontmatter VALUE means. Before this module each key
// invented its own reading: `links_index` tested `=== true` (so a quoted `"true"` was dead),
// `auto_title_slide` tested `!== false` (so a quoted `"false"` was dead), `section_labels`
// accepted `on|true|yes|show`, `hide_email` accepted `true|yes|on|1`, and every closed vocabulary
// fell back in silence when it did not recognise a value. The surfaces that write these keys
// (Deck settings, the frontmatter table) could therefore write bytes the compiler ignored.
//
// Each reader returns a small record rather than a bare value: the caller decides what to do with
// an unreadable or undocumented value (always: raise a registered warning), so the warning text
// stays with the key it belongs to and this module stays free of the warnings array.
//
// The readers take the RAW value, never `meta`. Keeping `meta.<key>` at the call site is what lets
// scripts/test-metadata-registry.mjs and scripts/test-deck-options-parity.mjs keep scanning the
// compiler for the keys it reads.
// =============================================================================

// ── The closed vocabularies the deck keys accept ─────────────────────────────
// Each mirrors a closed vocabulary in src/shared/metadata-registry.ts; scripts/test-settings-
// honoured.mjs enumerates the registry and fails when a documented value has no effect here.

/** Alternate section-accent cycles a deck can switch to. "" (absent) is the default cycle. */
export const DECK_PALETTES = ["green"];
/** Deck faces. `trebuchet` is the locked house face — a real choice that stamps no attribute. */
export const DECK_FONTS = ["trebuchet", "gill-sans", "verdana"];
/** How a mixed logo row is painted. */
export const DECK_LOGO_COLOURS = ["unified", "brand"];

/** Written forms that mean "on". `show` is kept because `section_labels: show` already worked. */
export const DECK_FLAG_ON = ["true", "yes", "on", "show", "1"];
/** Written forms that mean "off". */
export const DECK_FLAG_OFF = ["false", "no", "off", "hide", "0"];

/**
 * Read a deck-level boolean.
 *
 * Deck flags are TRI-STATE: absent is not off. `auto_title_slide` absent means "generate the
 * title slide"; `auto_title_slide: false` means "do not". Callers must branch on `state`, never
 * coerce the record.
 *
 * @param {unknown} raw the frontmatter value, or undefined when the key is absent
 * @returns {{state: 'absent'|'on'|'off'|'unreadable', raw: string}}
 */
export function readDeckFlag(raw) {
  if (raw == null || raw === "") return { state: "absent", raw: "" };
  if (raw === true) return { state: "on", raw: "true" };
  if (raw === false) return { state: "off", raw: "false" };
  const text = String(raw).trim();
  if (!text) return { state: "absent", raw: "" };
  const normalised = text.toLowerCase();
  if (DECK_FLAG_ON.includes(normalised)) return { state: "on", raw: text };
  if (DECK_FLAG_OFF.includes(normalised)) return { state: "off", raw: text };
  return { state: "unreadable", raw: text };
}

/** Convenience for the common `flag is on` test. Absent and unreadable both read as off. */
export const deckFlagOn = (flag) => flag.state === "on";

/**
 * Read a deck-level value against a CLOSED vocabulary — the documented option list the Deck
 * settings and frontmatter surfaces offer for that key.
 *
 * @param {unknown} raw the frontmatter value, or undefined when the key is absent
 * @param {string[]} allowed the documented values, lower-case
 * @param {{aliases?: Record<string,string>}} [options] written forms that map onto a documented
 *        value (e.g. `trebuchet-ms` → `trebuchet`)
 * @returns {{state: 'absent'|'known'|'unknown', value: string, raw: string}} `value` is the
 *          documented value when known and "" otherwise, so a caller can use it directly.
 */
export function readDeckChoice(raw, allowed, { aliases = {} } = {}) {
  if (raw == null || raw === true || raw === false) {
    return raw === true || raw === false
      ? { state: "unknown", value: "", raw: String(raw) }
      : { state: "absent", value: "", raw: "" };
  }
  const text = String(raw).trim();
  if (!text) return { state: "absent", value: "", raw: "" };
  const normalised = aliases[text.toLowerCase()] ?? text.toLowerCase().replace(/\s+/g, "-");
  const resolved = aliases[normalised] ?? normalised;
  if (allowed.includes(resolved)) return { state: "known", value: resolved, raw: text };
  return { state: "unknown", value: "", raw: text };
}

/**
 * Read a deck-level whole-minute threshold (`warn-at:` / `urgent-at:`).
 *
 * `Number()` used to coerce these straight into the deck, so `warn-at: soon` reached the presenter
 * clock as `data-warn-at="NaN"`.
 *
 * @param {unknown} raw
 * @returns {{state: 'absent'|'number'|'unreadable', minutes: number|null, raw: string}}
 */
export function readDeckMinutes(raw) {
  if (raw == null || raw === "") return { state: "absent", minutes: null, raw: "" };
  const text = String(raw).trim();
  if (!text) return { state: "absent", minutes: null, raw: "" };
  const minutes = Number(text.replace(/\s*min(ute)?s?$/i, ""));
  if (!Number.isFinite(minutes) || minutes < 0) return { state: "unreadable", minutes: null, raw: text };
  return { state: "number", minutes, raw: text };
}
