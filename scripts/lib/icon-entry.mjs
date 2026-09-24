// Pure helpers for icon acquisition. Kept free of network and filesystem access so
// the acquisition scripts stay thin and these rules are testable directly.

const REQUIRED_PROVENANCE = ["source", "license", "date"];

// Collapse whitespace BETWEEN tags only. Attribute and path data are never touched:
// a `d` attribute is whitespace-significant and rewriting it would corrupt the glyph.
export function normaliseSvg(svg) {
  return String(svg).replace(/>\s+</g, "><").trim();
}

// Brand title → lookup tokens. Punctuation splits ("Z.Ai" → z, ai) because brand
// names carry dots and hyphens that the token index stores as separate words.
export function deriveTokens(title) {
  return String(title).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Build an extra.json entry. Refuses to produce one whose provenance is incomplete or
// whose payload is not an SVG — an unrecorded or failed acquisition must never be
// committed, because a 404 body written as an icon fails silently at render time.
export function buildIconEntry({ key, title, tokens, svg, source, license, date }) {
  const missing = REQUIRED_PROVENANCE.filter((f) => !{ source, license, date }[f]);
  if (missing.length) throw new Error(`refusing to write ${key}: missing provenance field(s): ${missing.join(", ")}`);
  const cleaned = normaliseSvg(svg);
  if (!/^<svg[\s>]/i.test(cleaned)) throw new Error(`refusing to write ${key}: payload is not an SVG element`);
  return {
    title: String(title),
    tokens: Array.isArray(tokens) && tokens.length ? tokens : deriveTokens(title),
    svg: cleaned,
    source: String(source),
    license: String(license),
    date: String(date),
  };
}
