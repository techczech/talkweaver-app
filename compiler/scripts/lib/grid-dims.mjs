// The `{blocks:RxC}` grid dimension. No file or Node access: the layout inference the app shares reads it.

// Parse an explicit `{blocks:RxC}` grid dimension (rows × cols) the author sets on a grid/tiles
// heading. Tolerant of the `x` separator in lower/upper case and the unicode `×`, plus surrounding
// whitespace; both numbers must be ≥1. Returns { rows, cols } or null when it does not parse (the
// caller then falls back to the auto-balanced column count). The contract is the test surface.
export function parseGridDims(value) {
  if (value == null || value === true) return null;
  const m = String(value).trim().match(/^(\d+)\s*[x×X]\s*(\d+)$/);
  if (!m) return null;
  const rows = parseInt(m[1], 10);
  const cols = parseInt(m[2], 10);
  if (!(rows >= 1) || !(cols >= 1)) return null;
  return { rows, cols };
}
