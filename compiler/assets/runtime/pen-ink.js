// The pen's live ink (ticket 08, ADR-0037): a plain stroke model, a per-slide store with undo and
// clear, the drag gesture, validation of ink received from another window, and drawing with fixed
// SVG primitives. Ink is held in the presenter's memory for the talk only; nothing here writes it
// anywhere. Units are the pointer's: 1280×720 canvas units on a slide, 0–1 on a zoomed image.
//
// A stroke is { tool, ink, width, points } with
//   tool   'freehand' | 'arrow' | 'rectangle'
//   ink    'red' | 'yellow' | 'green' | 'blue'
//   width  'thin' | 'thick'
//   points [[x, y], ...]: a freehand line; an arrow's [head, tail]; a rectangle's two opposite corners.
// That is the shape authored markup (roadmap image-editing-crop-and-markup) could store as it is.
// The wire view of one layer is { slideId, space, image?, strokes, draft }.

/** Caps. The worker (worker/protocol.ts INK_LIMITS) enforces the same numbers. */
export const PEN_LIMITS = { pointsPerStroke: 400, strokesPerLayer: 100, pointsPerLayer: 2400, bytes: 64000, slideIdChars: 100, images: 1000 };
export const PEN_TOOLS = ['freehand', 'arrow', 'rectangle'];
export const PEN_INKS = { red: '#ff3b30', yellow: '#ffd60a', green: '#34c759', blue: '#0a84ff' };
export const PEN_WIDTHS = { thin: 4, thick: 9 };
export const PEN_HEAD = { thin: 20, thick: 32 };

/** The extent of a space in its own units. */
export function penSpaceSize(space) {
  return space === 'image' ? [1, 1] : [1280, 720];
}

/** One coordinate, rounded to what the screen can show (keeps messages small). */
export function penRound(value, space) {
  const k = space === 'image' ? 10000 : 10;
  return Math.round(value * k) / k;
}

/** A client point in a surface's units, clamped to its edge (a drag may leave the slide). */
export function penPoint(clientX, clientY, rect, space) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const [w, h] = penSpaceSize(space);
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return [penRound(x * w, space), penRound(y * h, space)];
}

/** Ramer–Douglas–Peucker: fewer points along the same line. */
export function penSimplify(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let far = -1, best = epsilon;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const d = len ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
      if (d > best) { best = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * A shape from a drag, in client pixels (so Shift's 45° steps and squares are true on screen),
 * returned in the surface's units; null for a drag under 1% of the slide (a click makes nothing).
 * The arrow's head is where the drag began, its tail where it is now (Dev Traffic Control's markup).
 */
export function penShape(tool, from, to, { rect, space, shift = false }) {
  if (!from || !to || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  const clampX = (x) => Math.min(rect.left + rect.width, Math.max(rect.left, x));
  const clampY = (y) => Math.min(rect.top + rect.height, Math.max(rect.top, y));
  const ax = clampX(from[0]), ay = clampY(from[1]);
  let bx = clampX(to[0]), by = clampY(to[1]);
  if (shift && tool === 'arrow') {
    const len = Math.hypot(bx - ax, by - ay);
    const angle = Math.round(Math.atan2(by - ay, bx - ax) / (Math.PI / 4)) * (Math.PI / 4);
    bx = clampX(ax + Math.cos(angle) * len); by = clampY(ay + Math.sin(angle) * len);
  } else if (shift && tool === 'rectangle') {
    // The longer side wins, shrunk to what the slide has room for both ways, so it stays square.
    const sx = Math.sign(bx - ax || 1), sy = Math.sign(by - ay || 1);
    const roomX = sx > 0 ? rect.left + rect.width - ax : ax - rect.left;
    const roomY = sy > 0 ? rect.top + rect.height - ay : ay - rect.top;
    const side = Math.min(Math.max(Math.abs(bx - ax), Math.abs(by - ay)), roomX, roomY);
    bx = ax + sx * side; by = ay + sy * side;
  }
  const minX = rect.width / 100, minY = rect.height / 100;
  if (tool === 'arrow' && Math.hypot(bx - ax, by - ay) < minX) return null;
  if (tool === 'rectangle' && (Math.abs(bx - ax) < minX || Math.abs(by - ay) < minY)) return null;
  return [penPoint(ax, ay, rect, space), penPoint(bx, by, rect, space)];
}

/** True when a freehand line spans less than 1% of the slide each way: a click, which makes nothing. */
export function penTooSmall(points, space) {
  const [w, h] = penSpaceSize(space);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return Math.max(...xs) - Math.min(...xs) < w / 100 && Math.max(...ys) - Math.min(...ys) < h / 100;
}

/**
 * A stroke checked field by field; a new object from the checked values only, or null.
 * @returns {import('../../../worker/protocol').InkStroke | null}
 */
export function penStroke(value, space) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Strings first: a palette lookup with an array or an object key would coerce it (['red'] is 'red').
  if (typeof value.tool !== 'string' || typeof value.ink !== 'string' || typeof value.width !== 'string') return null;
  if (!PEN_TOOLS.includes(value.tool) || !Object.hasOwn(PEN_INKS, value.ink) || !Object.hasOwn(PEN_WIDTHS, value.width)) return null;
  const points = value.points;
  if (!Array.isArray(points) || points.length < 1 || points.length > PEN_LIMITS.pointsPerStroke) return null;
  if (value.tool !== 'freehand' && points.length !== 2) return null;
  const [w, h] = penSpaceSize(space);
  /** @type {Array<[number, number]>} */
  const clean = [];
  for (const point of points) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [x, y] = point;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > w || y > h) return null;
    clean.push([x, y]);
  }
  return { tool: value.tool, ink: value.ink, width: value.width, points: clean };
}

/**
 * One layer's ink as received from another window or the worker: checked and copied, or null.
 * The same verdicts as the worker's parseInkMessage (worker/protocol.ts), byte cap included: the
 * message `{ type: 'ink.live', ink: value }` must serialise within PEN_LIMITS.bytes. Never throws.
 * @returns {import('../../../worker/protocol').InkView | null}
 */
export function penInkView(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const wire = JSON.stringify({ type: 'ink.live', ink: value });
    if (typeof wire !== 'string' || new TextEncoder().encode(wire).length > PEN_LIMITS.bytes) return null;
    return penInkViewChecked(JSON.parse(wire).ink);
  } catch {
    return null;
  }
}

/** penInkView's field checks, on plain data (a JSON round trip of what arrived). */
function penInkViewChecked(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { slideId, space } = value;
  if (typeof slideId !== 'string' || !slideId.trim() || slideId.length > PEN_LIMITS.slideIdChars) return null;
  if (space !== 'slide' && space !== 'image') return null;
  if (space === 'image' ? !Number.isSafeInteger(value.image) || value.image < 0 || value.image >= PEN_LIMITS.images : value.image !== undefined) return null;
  if (!Array.isArray(value.strokes) || value.strokes.length > PEN_LIMITS.strokesPerLayer) return null;
  const strokes = [];
  let total = 0;
  for (const raw of value.strokes) {
    const stroke = penStroke(raw, space);
    if (!stroke) return null;
    total += stroke.points.length;
    strokes.push(stroke);
  }
  let draft = null;
  if (value.draft != null) {
    draft = penStroke(value.draft, space);
    if (!draft) return null;
    total += draft.points.length;
  }
  if (total > PEN_LIMITS.pointsPerLayer) return null;
  return { slideId, space, ...(space === 'image' ? { image: value.image } : {}), strokes, draft };
}

/**
 * Where a picture is drawn inside its element: `box` is the element's rect, `natural` the picture's
 * own [width, height], `fit` and `position` the computed object-fit and object-position. A zoomed
 * image shows the whole picture, so its 0–1 units are this rect's (replay draws a zoomed image's
 * ink over the image on the slide). Contain and scale-down leave bands, cover crops; the position
 * places the picture in the free space (keywords, percentages and px, with edge offsets).
 */
export function penPictureRect(box, natural, fit, position) {
  const [nw, nh] = natural || [];
  if (!box || !(box.width > 0) || !(box.height > 0) || !(nw > 0) || !(nh > 0)) return box;
  let width = box.width, height = box.height;
  if (fit === 'contain' || fit === 'cover' || fit === 'scale-down') {
    const k = (fit === 'cover' ? Math.max : Math.min)(box.width / nw, box.height / nh);
    const scale = fit === 'scale-down' ? Math.min(1, k) : k;
    width = nw * scale; height = nh * scale;
  } else if (fit === 'none') {
    width = nw; height = nh;
  }
  const free = [box.width - width, box.height - height];
  // One offset along an axis: a keyword, a percentage of the free space, or px.
  const along = (token, axis) => {
    if (token === 'left' || token === 'top') return 0;
    if (token === 'right' || token === 'bottom') return free[axis];
    if (token === 'center' || token === undefined) return free[axis] / 2;
    const n = parseFloat(token);
    if (!Number.isFinite(n)) return free[axis] / 2;
    return token.endsWith('%') ? free[axis] * n / 100 : n;
  };
  const isY = (t) => t === 'top' || t === 'bottom';
  const isX = (t) => t === 'left' || t === 'right';
  const tokens = String(position || '50% 50%').trim().split(/\s+/);
  let x = free[0] / 2, y = free[1] / 2;
  if (tokens.length === 4) {
    // Edge offsets: "right 10px bottom 20%".
    for (const [edge, offset] of [[tokens[0], tokens[1]], [tokens[2], tokens[3]]]) {
      const axis = isY(edge) ? 1 : 0;
      const d = offset.endsWith('%') ? free[axis] * parseFloat(offset) / 100 : parseFloat(offset) || 0;
      const at = edge === 'right' || edge === 'bottom' ? free[axis] - d : d;
      if (axis) y = at; else x = at;
    }
  } else if (tokens.length === 1) {
    if (isY(tokens[0])) y = along(tokens[0], 1); else x = along(tokens[0], 0);
  } else {
    const [a, b] = isY(tokens[0]) || isX(tokens[1]) ? [tokens[1], tokens[0]] : [tokens[0], tokens[1]];
    x = along(a, 0); y = along(b, 1);
  }
  return { left: box.left + x, top: box.top + y, width, height };
}

/** The key of one layer: a slide's own, or one zoomed image of it. */
export function penLayerKey(slideId, space = 'slide', image = 0) {
  return space === 'image' ? `${slideId}\u0000image\u0000${image}` : `${slideId}\u0000slide`;
}

/**
 * The presenter's ink, per layer, for the talk. Memory only: it ends with the window. A layer takes
 * at most strokesPerLayer strokes and leaves room for one stroke being drawn within pointsPerLayer,
 * so every view of it fits one message.
 *
 * One gesture is one undo unit: `add(key, strokes)` with an array keeps a long freehand line's
 * pieces (each at most pointsPerStroke points, the wire cap) together, and `undo` removes them all.
 */
export function createPenStore() {
  const layers = new Map(); // key → [{ stroke, gesture }]
  const room = PEN_LIMITS.pointsPerLayer - PEN_LIMITS.pointsPerStroke;
  let gestures = 0;
  const count = (list) => list.reduce((sum, entry) => sum + entry.stroke.points.length, 0);
  const asList = (strokes) => (Array.isArray(strokes) ? strokes : [strokes]);
  return {
    strokes(key) { return (layers.get(key) || []).map((entry) => entry.stroke); },
    /** Whether `strokeCount` more strokes of `pointCount` points in all fit the layer. */
    fits(key, strokeCount, pointCount) {
      const list = layers.get(key) || [];
      return list.length + strokeCount <= PEN_LIMITS.strokesPerLayer && count(list) + pointCount <= room;
    },
    canAdd(key, strokes) {
      const list = asList(strokes);
      return list.length > 0 && this.fits(key, list.length, list.reduce((sum, stroke) => sum + stroke.points.length, 0));
    },
    /** One stroke, or one gesture's strokes: all of them or none. */
    add(key, strokes) {
      if (!this.canAdd(key, strokes)) return false;
      const list = layers.get(key) || [];
      const gesture = ++gestures;
      for (const stroke of asList(strokes)) list.push({ stroke, gesture });
      layers.set(key, list);
      return true;
    },
    /** Removes the last gesture: every piece of it. */
    undo(key) {
      const list = layers.get(key);
      if (!list?.length) return false;
      const gesture = list[list.length - 1].gesture;
      while (list.length && list[list.length - 1].gesture === gesture) list.pop();
      if (!list.length) layers.delete(key);
      return true;
    },
    clear(key) { return layers.delete(key); },
    clearAll() { const had = layers.size > 0; layers.clear(); return had; },
    has(key) { return Boolean(layers.get(key)?.length); },
    /** Whether any layer of a slide (its own or a zoomed image's) has ink. */
    slideHas(slideId) {
      for (const key of layers.keys()) if (key.split('\u0000')[0] === slideId) return true;
      return false;
    },
    size() { return layers.size; }
  };
}

// ---------------------------------------------------------------------------------------------
// Drawing. Every element is made from a fixed tag with numeric attributes and a palette colour;
// no text from a stroke reaches the document.

/**
 * Draw one layer's view into `group`, an SVG <g> inside the overlay whose viewBox is 1280×720
 * stretched over `rect`. `canvasScale` is CSS pixels per canvas pixel (the slide's, also on a
 * zoomed image), so widths and arrowheads look the same on every screen.
 */
export function penDraw(group, view, { rect, canvasScale }) {
  const document = group.ownerDocument;
  const ns = 'http://www.w3.org/2000/svg';
  while (group.firstChild) group.firstChild.remove();
  if (!view || !rect || !(rect.width > 0) || !(rect.height > 0) || !(canvasScale > 0)) return;
  const sx = rect.width / 1280, sy = rect.height / 720;
  const [uw, uh] = view.space === 'image' ? [1280, 720] : [1, 1];
  const vb = (p) => [p[0] * uw, p[1] * uh];
  const px = (p) => [p[0] * uw * sx, p[1] * uh * sy];
  const back = (p) => [p[0] / sx, p[1] / sy];
  const num = (n) => (Math.round(n * 100) / 100).toString();
  const el = (tag, attrs, parent) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, typeof value === 'number' ? num(value) : value);
    parent.append(node);
    return node;
  };
  const halo = (ink) => (ink === 'yellow' ? 'rgba(12,16,24,.92)' : 'rgba(255,255,255,.96)');
  const fixed = { 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const drawOne = (stroke, opacity) => {
    const colour = PEN_INKS[stroke.ink], outline = halo(stroke.ink);
    if (!colour) return;
    const width = PEN_WIDTHS[stroke.width] * canvasScale, rim = 2.4 * canvasScale;
    const g = el('g', { 'data-pen-stroke': stroke.tool, opacity }, group);
    if (stroke.tool === 'freehand') {
      const d = stroke.points.map((p, i) => { const [x, y] = vb(p); return `${i ? 'L' : 'M'}${num(x)} ${num(y)}`; }).join(' ')
        + (stroke.points.length === 1 ? ` L${num(vb(stroke.points[0])[0])} ${num(vb(stroke.points[0])[1])}` : '');
      el('path', { ...fixed, d, fill: 'none', stroke: outline, 'stroke-width': width + rim * 2 }, g);
      el('path', { ...fixed, d, fill: 'none', stroke: colour, 'stroke-width': width }, g);
    } else if (stroke.tool === 'arrow') {
      const head = px(stroke.points[0]), tail = px(stroke.points[1]);
      const length = PEN_HEAD[stroke.width] * canvasScale, spread = Math.PI / 7;
      const angle = Math.atan2(head[1] - tail[1], head[0] - tail[0]);
      const c1 = [head[0] - length * Math.cos(angle - spread), head[1] - length * Math.sin(angle - spread)];
      const c2 = [head[0] - length * Math.cos(angle + spread), head[1] - length * Math.sin(angle + spread)];
      const [t, m, h, a, b] = [tail, [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2], head, c1, c2].map(back);
      const shaft = `M${num(t[0])} ${num(t[1])} L${num(m[0])} ${num(m[1])}`;
      const tip = [h, a, b].map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
      el('path', { ...fixed, d: shaft, fill: 'none', stroke: outline, 'stroke-width': width + rim * 2 }, g);
      el('polygon', { ...fixed, points: tip, fill: outline, stroke: outline, 'stroke-width': rim * 2 }, g);
      el('path', { ...fixed, d: shaft, fill: 'none', stroke: colour, 'stroke-width': width }, g);
      el('polygon', { ...fixed, points: tip, fill: colour, stroke: colour, 'stroke-width': canvasScale }, g);
    } else if (stroke.tool === 'rectangle') {
      const [a, b] = stroke.points.map(vb);
      const box = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]),
        rx: 8 * canvasScale / sx, ry: 8 * canvasScale / sy };
      el('rect', { ...fixed, ...box, fill: 'none', stroke: outline, 'stroke-width': width + rim * 2 }, g);
      el('rect', { ...fixed, ...box, fill: colour, 'fill-opacity': 0.08, stroke: colour, 'stroke-width': width }, g);
    }
  };
  for (const stroke of view.strokes || []) drawOne(stroke, 1);
  if (view.draft) drawOne(view.draft, 0.7);
}

/** The pen's CSS cursor for a tool, ink and on-screen width: an SVG image with its hot spot. */
export function penCursor(tool, ink, widthPx) {
  const colour = PEN_INKS[ink] || PEN_INKS.red;
  const outline = ink === 'yellow' ? '#0c1018' : '#ffffff';
  let svg, hot;
  if (tool === 'arrow' || tool === 'rectangle') {
    const arms = (stroke, w) => ['M14 2v8', 'M14 18v8', 'M2 14h8', 'M18 14h8']
      .map((d) => `<path d='${d}' stroke='${stroke}' stroke-width='${w}' stroke-linecap='round'/>`).join('');
    const glyph = tool === 'arrow' ? 'M27 38L38 27M31 27h7v7' : 'M27.5 27.5h10v10h-10z';
    svg = `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40' fill='none'>${arms(outline, 5.5)}${arms(colour, 2.2)}`
      + `<path d='${glyph}' stroke='${outline}' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/>`
      + `<path d='${glyph}' stroke='${colour}' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/></svg>`;
    hot = [14, 14];
  } else {
    const d = Math.min(60, Math.max(10, Math.round(widthPx)));
    const size = d + 8, c = size / 2;
    svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>`
      + `<circle cx='${c}' cy='${c}' r='${d / 2 + 3}' fill='rgba(0,0,0,.65)'/><circle cx='${c}' cy='${c}' r='${d / 2 + 2}' fill='#ffffff'/>`
      + `<circle cx='${c}' cy='${c}' r='${d / 2}' fill='${colour}'/></svg>`;
    hot = [c, c];
  }
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot[0]} ${hot[1]}, crosshair`;
}

// ---------------------------------------------------------------------------------------------
// The gesture: press, drag, release over the overlay; Shift constrains a shape, Esc abandons.

/**
 * `surface()` gives { rect, space, slideId, image }; `settings()` gives { tool, ink, width }.
 * `onDraft(stroke|null, pieces)` follows the drag: a long freehand line is shown as its finished
 * pieces (each at most pointsPerStroke points) and the piece being drawn; none of it is committed
 * until release, so Esc abandons the whole line. `onCommit(strokes, key)` receives one gesture's
 * strokes for its layer `key` (one undo unit). `fits(key, strokes, points)`, when given, says
 * whether that much more ink fits the layer; a line stops growing when it would not.
 */
export function createPenGesture({ root, surface, settings, onDraft, onCommit, fits = (_key, _strokes, _points) => true }) {
  const win = root.ownerDocument.defaultView;
  let drag = null;
  const epsilon = (space) => (space === 'image' ? 0.0005 : 0.6);
  function shapeNow() {
    if (!drag) return null;
    const { tool, ink, width } = drag.pen;
    if (tool === 'freehand') return drag.points.length ? { tool, ink, width, points: drag.points.slice() } : null;
    const points = penShape(tool, drag.from, drag.to, { rect: drag.rect, space: drag.space, shift: drag.shift });
    // While dragging the band shows even when it is still too small to keep.
    const shown = points || [penPoint(drag.from[0], drag.from[1], drag.rect, drag.space), penPoint(drag.to[0], drag.to[1], drag.rect, drag.space)];
    return { tool, ink, width, points: shown, keep: Boolean(points) };
  }
  function draft() {
    const s = shapeNow();
    onDraft(s ? { tool: s.tool, ink: s.ink, width: s.width, points: s.points } : null, drag ? drag.pieces.slice() : []);
  }
  const piecePoints = () => drag.pieces.reduce((sum, piece) => sum + piece.points.length, 0);
  function finishFreehandPiece() {
    const pts = penSimplify(drag.points, epsilon(drag.space));
    const { tool, ink, width } = drag.pen;
    return { tool, ink, width, points: pts };
  }
  function down(event) {
    if (event.button !== 0 || drag) return;
    // `settings()` is null while the pen is off (the overlay may be capturing for the Pointer).
    const pen = settings();
    if (!pen) return;
    const s = surface();
    if (!s?.rect || !(s.rect.width > 0) || !s.slideId) return;
    const inside = event.clientX >= s.rect.left && event.clientX <= s.rect.left + s.rect.width
      && event.clientY >= s.rect.top && event.clientY <= s.rect.top + s.rect.height;
    if (!inside) return;
    event.preventDefault(); event.stopPropagation();
    try { root.setPointerCapture?.(event.pointerId); } catch {}
    drag = { pen: { tool: pen.tool, ink: pen.ink, width: pen.width }, rect: s.rect, space: s.space, key: penLayerKey(s.slideId, s.space, s.image),
      from: [event.clientX, event.clientY], to: [event.clientX, event.clientY], shift: event.shiftKey, last: [event.clientX, event.clientY],
      points: [penPoint(event.clientX, event.clientY, s.rect, s.space)], pieces: [], pointerId: event.pointerId };
    draft();
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.to = [event.clientX, event.clientY];
    drag.shift = event.shiftKey;
    if (drag.pen.tool === 'freehand') {
      if (Math.hypot(event.clientX - drag.last[0], event.clientY - drag.last[1]) < 2) return;
      // The layer is full: the line (as shown, pieces and all) is what will be kept.
      // (A point that ends a piece also starts the next one, so it counts twice.)
      const split = drag.points.length + 1 >= PEN_LIMITS.pointsPerStroke;
      if (!fits(drag.key, drag.pieces.length + (split ? 2 : 1), piecePoints() + drag.points.length + (split ? 2 : 1))) return;
      drag.last = [event.clientX, event.clientY];
      drag.points.push(penPoint(event.clientX, event.clientY, drag.rect, drag.space));
      if (drag.points.length >= PEN_LIMITS.pointsPerStroke) {
        // A long line goes on as a new piece from the same point; the pieces are committed together.
        drag.pieces.push(finishFreehandPiece());
        drag.points = [drag.points[drag.points.length - 1]];
      }
    }
    draft();
  }
  function up(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.to = [event.clientX, event.clientY];
    const done = drag;
    let strokes = [];
    if (done.pen.tool === 'freehand') {
      const piece = finishFreehandPiece();
      if (done.pieces.length) strokes = piece.points.length > 1 ? [...done.pieces, piece] : done.pieces.slice();
      else if (!penTooSmall(piece.points, done.space)) strokes = [piece];
    } else {
      const s = shapeNow();
      if (s?.keep) strokes = [{ tool: s.tool, ink: s.ink, width: s.width, points: s.points }];
    }
    drag = null;
    try { root.releasePointerCapture?.(event.pointerId); } catch {}
    onDraft(null, []);
    if (strokes.length) onCommit(strokes, done.key);
  }
  function shiftKey(event) {
    if (!drag || event.key !== 'Shift' || drag.pen.tool === 'freehand') return;
    drag.shift = event.type === 'keydown';
    draft();
  }
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', () => api.cancel());
  win.addEventListener('keydown', shiftKey, true);
  win.addEventListener('keyup', shiftKey, true);
  const api = {
    dragging() { return Boolean(drag); },
    /** Esc, a slide change or the pen turned off: the shape being drawn is dropped. */
    cancel() {
      if (!drag) return false;
      try { root.releasePointerCapture?.(drag.pointerId); } catch {}
      drag = null;
      onDraft(null, []);
      return true;
    },
    destroy() {
      api.cancel();
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      win.removeEventListener('keydown', shiftKey, true);
      win.removeEventListener('keyup', shiftKey, true);
    }
  };
  return api;
}

export function penInkRuntimeSource() {
  const constants = [
    `const PEN_LIMITS = ${JSON.stringify(PEN_LIMITS)};`,
    `const PEN_TOOLS = ${JSON.stringify(PEN_TOOLS)};`,
    `const PEN_INKS = ${JSON.stringify(PEN_INKS)};`,
    `const PEN_WIDTHS = ${JSON.stringify(PEN_WIDTHS)};`,
    `const PEN_HEAD = ${JSON.stringify(PEN_HEAD)};`
  ];
  return constants.concat([penSpaceSize, penRound, penPoint, penSimplify, penShape, penTooSmall, penStroke, penInkView,
    penInkViewChecked, penPictureRect, penLayerKey, createPenStore, penDraw, penCursor, createPenGesture].map((fn) => fn.toString())).join('\n');
}
