// ADR-0028 §10, ticket 02 (Dominik, 29 Sep, no design round): a statement slide's options are
// separate choices, each its own trigger key. ONE resolver decides what a slide's tokens mean; the
// compiler (08-source-adapters) renders from it and the Inspector (src/shared/statement-options.ts)
// lights its buttons and writes its tokens from it, so the two can never disagree.
//
//   {statement-sidebar=on|off}          the coloured title sidebar (the rail), or full width
//   {statement-bg=halo|full|none}       the panel round the text, the whole slide, or no colour
//   {statement-align=left|centred}      aligned left, or centred with balanced lines
//   {statement-bar=none|left|top|bottom} the accent bar beside, above or below the text
//   {accent=<name>}                     the sidebar colour (rail, halo, full colour and bar) — the
//                                       section-accent vocabulary, pinned on this one slide
//
// The older one-word options stay valid and are PRESETS over the same dimensions:
//   {statement}/{statement=default|poster}, {claim=plain}  → Halo, Aligned, no bar
//   {statement=centred}                                     → Halo, Centred (only without a title,
//                                                             as preview.11 rendered it), no bar
//   {statement=tint}                                        → Halo, Aligned, Left bar
//   {statement=bar}, {claim=bar}, deck `claim_style: bar`   → no colour, Aligned, Left bar
//   {statement=full}                                        → Full, Aligned, no bar
// A per-dimension token overrides only its own dimension of the preset. The deck's claim_style
// applies only to a slide that carries no statement or claim token of its own.

export const STATEMENT_DIMENSION_KEYS = Object.freeze({
  sidebar: "statement-sidebar",
  bg: "statement-bg",
  align: "statement-align",
  bar: "statement-bar",
});

/** The values each dimension accepts, canonical first; synonyms map onto a canonical value. */
export const STATEMENT_DIMENSION_VALUES = Object.freeze({
  sidebar: ["on", "off"],
  bg: ["halo", "full", "none"],
  align: ["left", "centred"],
  bar: ["none", "left", "top", "bottom"],
});
const SYNONYMS = {
  sidebar: { with: "on", yes: "on", none: "off", without: "off", no: "off" },
  bg: { panel: "halo", default: "halo" },
  align: { aligned: "left", centre: "centred", center: "centred", centered: "centred" },
  bar: { off: "none", above: "top", below: "bottom" },
};

/** The look with no token at all. `sidebar: ""` = follows the title (a rail beside a title). */
export const STATEMENT_DEFAULTS = Object.freeze({ sidebar: "", bg: "halo", align: "left", bar: "none" });

export const STATEMENT_PRESETS = Object.freeze({
  default: Object.freeze({ bg: "halo", align: "left", bar: "none" }),
  centred: Object.freeze({ bg: "halo", align: "centred", bar: "none" }),
  tint: Object.freeze({ bg: "halo", align: "left", bar: "left" }),
  bar: Object.freeze({ bg: "none", align: "left", bar: "left" }),
  full: Object.freeze({ bg: "full", align: "left", bar: "none" }),
});

function text(value) {
  return value == null ? "" : String(value).trim().toLowerCase();
}

/** A dimension value as authored → its canonical value, or null when it is not one. */
export function canonicalStatementValue(dimension, value) {
  const raw = text(value);
  if (STATEMENT_DIMENSION_VALUES[dimension]?.includes(raw)) return raw;
  return SYNONYMS[dimension]?.[raw] ?? null;
}

/** Whether a trigger key is one of the statement dimension keys. */
export function isStatementDimensionKey(key) {
  return Object.values(STATEMENT_DIMENSION_KEYS).includes(key);
}

/**
 * What a statement slide's tokens mean.
 *
 * attrs: the slide's trigger attrs as a key → value map (last one wins, as the compiler parses
 *   them): `statement` (true for bare, else the value), `claim`, the four dimension keys, `accent`.
 * deckClaimStyle: the deck's `claim_style:` (only "bar" changes anything).
 *
 * Returns { sidebar, bg, align, bar, accent, preset, centredNeedsNoTitle, explicit, warnings }:
 *   sidebar  "on" | "off" | "" (follows the title)
 *   preset   the older one-word option the look starts from ("default" when none)
 *   centredNeedsNoTitle  true when Centred comes ONLY from {statement=centred}: preview.11 rendered
 *            that as the Default beside a title, and the old option keeps rendering exactly so
 *   explicit {dimension: true} for each dimension a per-dimension token set
 *   warnings ["statement-unknown:<token>", …]
 */
export function resolveStatementOptions(attrs = {}, { deckClaimStyle = "" } = {}) {
  const warnings = [];
  const explicit = {};
  const hasDimension = Object.values(STATEMENT_DIMENSION_KEYS).some((key) => attrs[key] != null && attrs[key] !== true);

  let preset = "default";
  if (attrs.statement != null) {
    const named = attrs.statement === true ? "default" : text(attrs.statement);
    if (named === "poster" || named === "default") preset = "default";
    else if (STATEMENT_PRESETS[named]) preset = named;
    else warnings.push(`statement-unknown:${named}`);
  } else if (text(attrs.claim) === "bar" || text(attrs.claim) === "plain") {
    preset = text(attrs.claim) === "bar" ? "bar" : "default";
  } else if (!hasDimension && text(deckClaimStyle) === "bar") {
    // A bare {statement} is the layout word, not a choice (it reaches here as attrs.layout), so
    // the deck's claim treatment still decides for it, exactly as in preview.11.
    preset = "bar";
  }

  const look = { sidebar: STATEMENT_DEFAULTS.sidebar, ...STATEMENT_PRESETS[preset] };
  for (const [dimension, key] of Object.entries(STATEMENT_DIMENSION_KEYS)) {
    const raw = attrs[key];
    if (raw == null) continue;
    const value = raw === true ? null : canonicalStatementValue(dimension, raw);
    if (value == null) {
      warnings.push(`statement-unknown:${key}=${raw === true ? "" : text(raw)}`);
      continue;
    }
    look[dimension] = value;
    explicit[dimension] = true;
  }
  const accent = attrs.accent != null && attrs.accent !== true ? text(attrs.accent) : "";
  return {
    ...look,
    accent,
    preset,
    centredNeedsNoTitle: preset === "centred" && !explicit.align,
    explicit,
    warnings,
  };
}

/**
 * The per-dimension tokens that write `look` from nothing, shortest form: a dimension at its
 * default is left out. `pinAgainstDeck` (the deck's claim_style: bar would otherwise decide) keeps
 * at least one token so the slide stops following the deck.
 */
export function statementDimensionTokens(look, { pinAgainstDeck = false, keep = "" } = {}) {
  const tokens = [];
  for (const [dimension, key] of Object.entries(STATEMENT_DIMENSION_KEYS)) {
    const value = look[dimension];
    if (!value) continue;
    if (value === STATEMENT_DEFAULTS[dimension] && !(pinAgainstDeck && dimension === keep)) continue;
    tokens.push(`${key}=${value}`);
  }
  if (pinAgainstDeck && tokens.length === 0) {
    const dimension = keep && STATEMENT_DIMENSION_KEYS[keep] ? keep : "bar";
    tokens.push(`${STATEMENT_DIMENSION_KEYS[dimension]}=${look[dimension] || STATEMENT_DEFAULTS[dimension]}`);
  }
  return tokens;
}
