// Pure helper for the add-icon.mjs --svg-file path. Kept separate from icon-entry.mjs
// deliberately: buildIconEntry's `/^<svg[\s>]/i` guard stays strict (a refusal on a
// malformed payload is deliberate and must not be weakened there). Brand SVGs pulled
// from company press kits routinely carry a UTF-8 BOM, an XML prolog and/or a DOCTYPE
// before the `<svg` element — all perfectly valid SVG, just not what the guard accepts
// verbatim — so the acquisition script normalises its own input before handing it to
// buildIconEntry.
export function stripSvgPreamble(text) {
  return String(text)
    .replace(/^\uFEFF/, "")
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(/^\s*<!DOCTYPE[^>[]*(\[[^\]]*\])?\s*>/i, "")
    .replace(/^\s+/, "");
}
