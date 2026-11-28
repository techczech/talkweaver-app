// The modifier stays in the icon value so every existing icon carrier can read it.
export const iconIsCrossed = (key) => key.endsWith("!");
export const iconBaseKey = (key) => iconIsCrossed(key) ? key.slice(0, -1) : key;
export const withIconCross = (key, crossed) => `${iconBaseKey(key)}${crossed ? "!" : ""}`;

// Draw in the glyph's own coordinates, including non-square and offset brand viewBoxes.
export function crossIconSvg(svg) {
  const opening = /^<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!opening) return svg;
  const box = /\bviewBox\s*=\s*(["'])(.*?)\1/i.exec(opening)?.[2];
  const [x, y, w, h] = box?.trim().split(/[\s,]+/).map(Number) ?? [0, 0, 24, 24];
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return svg;
  const width = Math.min(w, h) / 9;
  const haloWidth = width * 1.45;
  const inset = haloWidth / 2;
  const line = `x1="${x + inset}" y1="${y + h - inset}" x2="${x + w - inset}" y2="${y + inset}" stroke-linecap="round"`;
  return svg.replace(/<\/svg>\s*$/i,
    `<line data-icon-cross-halo ${line} stroke="#fff" stroke-width="${haloWidth}" />` +
    `<line data-icon-cross ${line} stroke="#e03131" stroke-width="${width}" /></svg>`);
}
