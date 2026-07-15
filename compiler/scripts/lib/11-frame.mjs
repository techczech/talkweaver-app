// Frame resolution (Wave 1). Pure: turns raw heading attrs + deck/section defaults into a
// FrameDescriptor. Precedence: slide attr > section default > deck default > built-in.
// MUST match the replica in scripts/test-frame.mjs.

export const FRAME_BUILTINS = { title: "top", section: "off", image: "left", align: "center", icons: "off" };

// Per-key normalisers: map any accepted spelling/alias to the canonical value, or null if unset.
function normTitle(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (v === true || s === "side" || s === "sidebar") return "side";
  if (s === "off" || s === "none" || s === "hide") return "off";
  if (s === "top") return "top";
  return null;
}
function normSection(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (s === "corner" || v === true || s === "on" || s === "show") return "corner";
  if (s === "off" || v === false || s === "none" || s === "hide") return "off";
  return null;
}
function normImage(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  return s === "right" ? "right" : s === "left" ? "left" : null;
}
function normAlign(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  return s === "top" ? "top" : (s === "center" || s === "centre" || s === "middle") ? "center" : null;
}
function normIcons(v) {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (s === "all") return "all";
  if (s === "off" || s === "none" || v === false) return "off";
  if (v === true || s === "on" || s === "top" || s === "yes") return "top";
  return null;
}

const NORMALISERS = { title: normTitle, section: normSection, image: normImage, align: normAlign, icons: normIcons };

// Read a key from a source dict honouring aliases: {sidebar} -> title:side, {media=..} -> image.
function readKey(key, src) {
  if (!src || typeof src !== "object") return undefined;
  if (key in src) return src[key];
  if (key === "title" && "sidebar" in src) return src.sidebar; // legacy alias
  if (key === "image" && "media" in src) return src.media;      // alias
  return undefined;
}

export function resolveSlideFrame(slideAttrs = {}, sectionDefaults = {}, deckDefaults = {}) {
  const out = {};
  for (const key of Object.keys(FRAME_BUILTINS)) {
    const norm = NORMALISERS[key];
    let value = null;
    for (const src of [slideAttrs, sectionDefaults, deckDefaults]) {
      const v = norm(readKey(key, src));
      if (v != null) { value = v; break; }
    }
    out[key] = value != null ? value : FRAME_BUILTINS[key];
  }
  return out;
}
