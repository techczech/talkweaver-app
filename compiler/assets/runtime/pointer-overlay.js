// Live marks never enter slide markup or preview documents. The SVG has independent ink and
// pointer groups: the Pen can append shapes to strokes without rebuilding the Ring or capture.
export function pointerPoint(clientX, clientY, rect, space = 'slide') {
  if (!rect || rect.width <= 0 || rect.height <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: x * (space === 'image' ? 1 : 1280), y: y * (space === 'image' ? 1 : 720), space };
}
export function pointerPixels(point, rect) {
  return { x: rect.left + point.x / (point.space === 'image' ? 1 : 1280) * rect.width,
    y: rect.top + point.y / (point.space === 'image' ? 1 : 720) * rect.height };
}
export function validPointer(value) {
  if (value === 'gone') return true;
  if (!value || !['slide', 'image'].includes(value.space) || typeof value.slideId !== 'string'
    || !value.slideId.trim() || value.slideId.length > 100) return false;
  return typeof value.x === 'number' && Number.isFinite(value.x) && value.x >= 0 && value.x <= (value.space === 'image' ? 1 : 1280)
    && typeof value.y === 'number' && Number.isFinite(value.y) && value.y >= 0 && value.y <= (value.space === 'image' ? 1 : 720);
}
// `drawInk(group, view, { rect, canvasScale })` draws the Pen's ink (pen-ink.js penDraw); the overlay
// shows a view only on the surface it belongs to (same slide, same space, same zoomed image).
export function createPointerOverlay({ document, surface, onMove = undefined, staleMs = 0, drawInk = undefined }) {
  const win = document.defaultView;
  const ns = 'http://www.w3.org/2000/svg';
  const node = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, value);
    return el;
  };
  const root = node('svg', {
    class: 'tw-live-overlay', 'aria-hidden': 'true', viewBox: '0 0 1280 720', preserveAspectRatio: 'none'
  });
  root.style.cssText = 'position:fixed;z-index:10000;pointer-events:none;overflow:hidden;';
  const strokes = node('g', { 'data-overlay-layer': 'strokes' });
  const ring = node('g', { 'data-overlay-layer': 'pointer', class: 'tw-pointer-ring' });
  for (const [width, colour] of [[11, '#0006'], [8, '#fff'], [4, '#ff3b30']]) {
    ring.append(node('circle', { r: 21, fill: 'none', stroke: colour, 'stroke-width': width }));
  }
  root.append(strokes, ring);
  document.body.append(root);
  const style = document.createElement('style');
  style.textContent = '@media print{.tw-live-overlay{display:none!important}}';
  document.head.append(style);
  /** @type {import('../../../worker/protocol.ts').PointerMessage['pointer']} */
  let point = 'gone';
  let armed = false, timer, frame, observed;
  let penArmed = false, penCursorCss = '', inkView = null, inkVersion = 0, inkDrawn = '';
  // Ink is redrawn only when the view or the surface's geometry changed: observers elsewhere in
  // the deck call refresh() on DOM changes, and an unconditional redraw would feed them forever.
  const drawInkOnce = (view, rect, canvasScale) => {
    if (!drawInk) return;
    const signature = view ? [inkVersion, rect.left, rect.top, rect.width, rect.height, canvasScale].join(',') : '';
    if (signature === inkDrawn) return;
    inkDrawn = signature;
    drawInk(strokes, view, { rect, canvasScale });
  };
  const inkShown = (s) => Boolean(inkView && s && inkView.slideId === s.slideId && inkView.space === s.space
    && (s.space !== 'image' || inkView.image === (s.image ?? 0)) && (inkView.strokes.length || inkView.draft));
  function refresh() {
    const s = surface();
    const rect = s?.rect;
    if ((armed || penArmed || point !== 'gone' || inkView) && s?.element && s.element !== observed) {
      watch.disconnect();
      watch.observe(document.body);
      observed = s.element;
      watch.observe(observed);
      if (observed.parentElement) watch.observe(observed.parentElement);
    }
    const visible = point !== 'gone' && point.slideId === s?.slideId && point.space === s?.space;
    const usable = rect && rect.width > 0 && rect.height > 0;
    const ink = usable && inkShown(s);
    root.style.display = usable && (armed || penArmed || visible || ink) ? '' : 'none';
    root.style.pointerEvents = (armed || penArmed) && usable ? 'all' : 'none';
    root.style.cursor = armed && usable ? 'none' : penArmed && usable ? penCursorCss : '';
    ring.style.display = visible ? '' : 'none';
    if (!usable) { drawInkOnce(null); return; }
    Object.assign(root.style, {
      left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px'
    });
    const clip = s.captureRect;
    const edges = clip ? [clip.top - rect.top, rect.left + rect.width - clip.right,
      rect.top + rect.height - clip.bottom, clip.left - rect.left].map(value => Math.max(0, value) + 'px') : null;
    root.style.clipPath = edges ? `inset(${edges.join(' ')})` : 'none';
    drawInkOnce(ink ? inkView : null, rect, s.canvasScale ?? rect.width / 1280);
    if (point !== 'gone') {
      const pixelScale = s.canvasScale ?? rect.width / 1280;
      const x = point.x * (point.space === 'image' ? 1280 : 1);
      const y = point.y * (point.space === 'image' ? 720 : 1);
      // Position uses the image rect; size always uses the slide canvas, independently on both axes.
      ring.setAttribute('transform', `translate(${x} ${y}) scale(${pixelScale * 1280 / rect.width} ${pixelScale * 720 / rect.height})`);
    }
  }
  function show(next) {
    if (!validPointer(next)) return;
    point = next;
    if (next === 'gone' && !armed && !penArmed && !inkView) { watch.disconnect(); observed = null; }
    clearTimeout(timer);
    if (staleMs && next !== 'gone') timer = setTimeout(() => show('gone'), staleMs);
    refresh();
  }
  function move(event) {
    if (!armed) return;
    const s = surface();
    const p = s && pointerPoint(event.clientX, event.clientY, s.rect, s.space);
    const next = p ? { ...p, slideId: s.slideId } : 'gone';
    show(next);
    onMove?.(next);
  }
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', () => {
    if (armed) { show('gone'); onMove?.('gone'); }
  });
  root.addEventListener('pointerdown', event => {
    if (armed) { event.preventDefault(); event.stopPropagation(); }
  });
  win.addEventListener('resize', refresh);
  const watch = new win.ResizeObserver(() => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(refresh);
  });
  document.addEventListener('load', refresh, true);
  refresh();
  return {
    show, refresh, strokes, root,
    /** The Pen's view of one layer ({ slideId, space, image?, strokes, draft }), or null. */
    ink(view) { inkView = view || null; inkVersion++; refresh(); },
    /** Pen capture: the overlay takes presses over the slide and shows the pen's cursor. */
    armPen(on, cursor = '') {
      penArmed = Boolean(on); penCursorCss = cursor;
      if (!penArmed && !armed) { watch.disconnect(); observed = null; win.cancelAnimationFrame(frame); }
      refresh();
    },
    arm(on) {
      armed = Boolean(on);
      if (!armed && !penArmed) { watch.disconnect(); observed = null; win.cancelAnimationFrame(frame); }
      refresh();
    },
    destroy() {
      clearTimeout(timer);
      win.cancelAnimationFrame(frame);
      watch.disconnect();
      win.removeEventListener('resize', refresh);
      document.removeEventListener('load', refresh, true);
      root.remove();
      style.remove();
    }
  };
}
export function pointerOverlayRuntimeSource() {
  return [pointerPoint, pointerPixels, validPointer, createPointerOverlay].map(fn => fn.toString()).join('\n');
}
