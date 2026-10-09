// The pen's stroke model (ticket 08): shapes from drags, validation of received ink, the per-slide
// store with undo and clear, the size caps, and drawing with fixed primitives.
import assert from 'node:assert/strict';
import {
  PEN_LIMITS, penShape, penTooSmall, penSimplify, penStroke, penInkView, penLayerKey, createPenStore, penDraw, penCursor, penPoint,
  createPenGesture, penPictureRect
} from '../compiler/assets/runtime/pen-ink.js';

const rect = { left: 100, top: 50, width: 1280 * 0.75, height: 720 * 0.75 };
const at = (x, y) => [rect.left + x * 0.75, rect.top + y * 0.75];
const near = (a, b, d = 0.11) => Math.abs(a - b) <= d;

// Arrow: the head is where the drag began, the tail where it ended (Dev Traffic Control's markup).
{
  const arrow = penShape('arrow', at(600, 300), at(900, 500), { rect, space: 'slide' });
  assert.deepEqual(arrow, [[600, 300], [900, 500]]);
  // Shift: 45° steps, the head stays put.
  const flat = penShape('arrow', at(600, 300), at(900, 320), { rect, space: 'slide', shift: true });
  assert.deepEqual(flat[0], [600, 300]);
  assert.ok(near(flat[1][1], 300), `a near-horizontal Shift arrow is horizontal: ${flat[1]}`);
  const diagonal = penShape('arrow', at(600, 300), at(700, 390), { rect, space: 'slide', shift: true });
  assert.ok(near(diagonal[1][0] - 600, diagonal[1][1] - 300, 0.2), `a Shift arrow near 45° is at 45°: ${diagonal[1]}`);
  // Under 1% of the slide's width (12.8 canvas px) is a click: nothing.
  assert.equal(penShape('arrow', at(600, 300), at(610, 305), { rect, space: 'slide' }), null);
  assert.ok(penShape('arrow', at(600, 300), at(614, 300), { rect, space: 'slide' }));
  // A drag beyond the slide is clamped to its edge.
  assert.deepEqual(penShape('arrow', at(600, 300), [rect.left + rect.width + 300, rect.top - 40], { rect, space: 'slide' })[1], [1280, 0]);
}
// Rectangle: corner to opposite corner, any direction; Shift a square, the longer side wins.
{
  assert.deepEqual(penShape('rectangle', at(900, 500), at(600, 300), { rect, space: 'slide' }), [[900, 500], [600, 300]]);
  const square = penShape('rectangle', at(600, 300), at(800, 350), { rect, space: 'slide', shift: true });
  assert.ok(near(square[1][0] - 600, square[1][1] - 300, 0.2), `Shift draws a square: ${square}`);
  const upLeft = penShape('rectangle', at(600, 300), at(500, 280), { rect, space: 'slide', shift: true });
  assert.ok(upLeft[1][0] < 600 && upLeft[1][1] < 300, 'a Shift square keeps the dragged direction');
  // Narrower than 13 or lower than 7.2 canvas px: nothing.
  assert.equal(penShape('rectangle', at(600, 300), at(610, 400), { rect, space: 'slide' }), null);
  assert.equal(penShape('rectangle', at(600, 300), at(700, 306), { rect, space: 'slide' }), null);
  assert.ok(penShape('rectangle', at(600, 300), at(614, 308), { rect, space: 'slide' }));
  // At the slide's edge the square shrinks both sides to the room there is: still a square.
  for (const [from, to] of [[at(1200, 300), at(1500, 600)], [at(100, 650), at(-200, 900)], [at(1250, 40), at(1600, -300)]]) {
    const edge = penShape('rectangle', from, to, { rect, space: 'slide', shift: true });
    const [w, h] = [Math.abs(edge[1][0] - edge[0][0]), Math.abs(edge[1][1] - edge[0][1])];
    assert.ok(w > 0 && near(w, h, 0.2), `a Shift square at the edge stays square: ${JSON.stringify(edge)}`);
  }
  assert.deepEqual(penShape('rectangle', at(1200, 300), at(1500, 600), { rect, space: 'slide', shift: true }), [[1200, 300], [1280, 380]]);
}
// On a zoomed image the units are the image's own (0–1), so marks land on the same detail.
{
  const image = { left: 300, top: 40, width: 500, height: 800 };
  const shape = penShape('arrow', [550, 440], [800, 840], { rect: image, space: 'image' });
  assert.deepEqual(shape, [[0.5, 0.5], [1, 1]]);
  assert.deepEqual(penPoint(300, 40, image, 'image'), [0, 0]);
}
// Freehand: a scribble inside 1% each way is a click; a stroke is simplified before it is sent.
{
  assert.equal(penTooSmall([[600, 300], [605, 303], [610, 302]], 'slide'), true);
  assert.equal(penTooSmall([[600, 300], [630, 303]], 'slide'), false);
  const line = Array.from({ length: 200 }, (_, i) => [i * 2, 100 + (i % 2) * 0.1]);
  const simple = penSimplify(line, 0.6);
  assert.ok(simple.length < 5, `a straight line keeps its ends (${simple.length} points)`);
  assert.deepEqual(simple[0], line[0]);
  assert.deepEqual(simple.at(-1), line.at(-1));
  const corner = penSimplify([[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]], 0.6);
  assert.deepEqual(corner, [[0, 0], [100, 0], [100, 100]]);
}
// Where a picture sits in its element, for replaying a zoomed image's ink over it on the slide.
{
  const box = { left: 10, top: 20, width: 300, height: 300 };
  const pic = [600, 400];
  // cover: 450×300; contain: 300×200.
  assert.deepEqual(penPictureRect(box, pic, 'cover', '50% 50%'), { left: 10 - 75, top: 20, width: 450, height: 300 }, 'cover, centred');
  assert.deepEqual(penPictureRect(box, pic, 'cover', 'left top'), { left: 10, top: 20, width: 450, height: 300 }, 'cover, left top: left 0');
  assert.deepEqual(penPictureRect(box, pic, 'cover', '0% 0%'), { left: 10, top: 20, width: 450, height: 300 }, 'computed form of left top');
  assert.deepEqual(penPictureRect(box, pic, 'cover', 'top left'), { left: 10, top: 20, width: 450, height: 300 }, 'keywords in either order');
  assert.deepEqual(penPictureRect(box, pic, 'cover', '100% 0%'), { left: 10 - 150, top: 20, width: 450, height: 300 }, 'cover, right');
  assert.deepEqual(penPictureRect(box, pic, 'cover', '25% 50%'), { left: 10 - 37.5, top: 20, width: 450, height: 300 }, 'cover, 25%');
  assert.deepEqual(penPictureRect(box, pic, 'contain', '50% 50%'), { left: 10, top: 20 + 50, width: 300, height: 200 }, 'contain, centred');
  assert.deepEqual(penPictureRect(box, pic, 'contain', '0% 100%'), { left: 10, top: 20 + 100, width: 300, height: 200 }, 'contain, bottom');
  assert.deepEqual(penPictureRect(box, pic, 'contain', '10px 30px'), { left: 20, top: 50, width: 300, height: 200 }, 'contain, px');
  assert.deepEqual(penPictureRect(box, pic, 'contain', 'right 10px bottom 20px'), { left: 10 - 10, top: 20 + 80, width: 300, height: 200 }, 'edge offsets');
  assert.deepEqual(penPictureRect(box, pic, 'fill', '0% 0%'), { left: 10, top: 20, width: 300, height: 300 }, 'fill: the whole box');
  assert.equal(penPictureRect(box, [0, 0], 'cover', '0% 0%'), box, 'not loaded: the box');
}
console.log('PASS pen shapes: arrow head at the press, Shift 45° and squares, the 1% click rule, edges and zoomed images');

// Validation: whatever arrives from another window or the worker is checked field by field.
{
  const good = { tool: 'freehand', ink: 'red', width: 'thin', points: [[1, 2], [1280, 720]] };
  assert.deepEqual(penStroke(good, 'slide'), good);
  assert.deepEqual(penStroke({ ...good, extra: '<script>' }, 'slide'), good, 'unknown fields are dropped');
  for (const bad of [
    null, [], 'x', { ...good, tool: 'text' }, { ...good, ink: 'purple' }, { ...good, ink: '#ff0000' }, { ...good, width: 3 },
    { ...good, ink: 'constructor' }, { ...good, ink: '__proto__' }, { ...good, points: [] }, { ...good, points: [[1, 2, 3]] },
    { ...good, points: [[NaN, 1]] }, { ...good, points: [[Infinity, 1]] }, { ...good, points: [[-1, 1]] }, { ...good, points: [[1281, 1]] },
    { ...good, points: [['1', 1]] }, { ...good, points: Array.from({ length: PEN_LIMITS.pointsPerStroke + 1 }, () => [1, 1]) },
    { ...good, tool: 'arrow', points: [[1, 1]] }, { ...good, tool: 'rectangle', points: [[1, 1], [2, 2], [3, 3]] }
  ]) assert.equal(penStroke(bad, 'slide'), null, JSON.stringify(bad)?.slice(0, 80));
  assert.equal(penStroke({ ...good, points: [[1.5, 1]] }, 'image'), null, 'image units are 0–1');
  assert.ok(penStroke({ ...good, points: [[1, 0.5]] }, 'image'));

  const view = { slideId: 'text', space: 'slide', strokes: [good], draft: null };
  assert.deepEqual(penInkView(view), view);
  assert.deepEqual(penInkView({ slideId: 'p', space: 'image', image: 2, strokes: [], draft: { ...good, points: [[0.2, 0.3]] } }).image, 2);
  for (const bad of [
    { ...view, slideId: '' }, { ...view, slideId: 'x'.repeat(101) }, { ...view, slideId: 7 }, { ...view, space: 'page' },
    { ...view, image: 1 }, { ...view, space: 'image' }, { ...view, space: 'image', image: -1 }, { ...view, space: 'image', image: 1.5 },
    { ...view, strokes: 'x' }, { ...view, strokes: [{ ...good, ink: 'mauve' }] }, { ...view, draft: { tool: 'freehand' } },
    { ...view, strokes: Array.from({ length: PEN_LIMITS.strokesPerLayer + 1 }, () => good) },
    { ...view, strokes: Array.from({ length: 7 }, () => ({ ...good, points: Array.from({ length: 400 }, () => [1, 1]) })) }
  ]) assert.equal(penInkView(bad), null, JSON.stringify(bad).slice(0, 80));
  // Strings before the palette lookup; values that cannot become a key are refused, never thrown.
  const plain = { toString: null, valueOf: null };
  for (const bad of [{ ...good, ink: ['red'] }, { ...good, width: ['thick'] }, { ...good, ink: plain }, { ...good, width: plain }, { ...good, tool: plain }]) {
    assert.equal(penStroke(bad, 'slide'), null, 'a non-string palette key');
    assert.equal(penInkView({ ...view, strokes: [bad] }), null);
  }
  for (const bad of [plain, { ...view, slideId: plain }, { ...view, space: plain }, { ...view, strokes: [plain] }, { ...view, draft: plain }]) {
    assert.doesNotThrow(() => penInkView(bad));
    assert.equal(penInkView(bad), null);
  }
  const cyclic = { ...view }; cyclic.self = cyclic;
  assert.equal(penInkView(cyclic), null, 'a value that cannot be a message is refused');
  // The byte cap on the message: six valid 400-point strokes with long decimals are too big.
  const heavy = { ...view, strokes: Array.from({ length: 6 }, () => ({ ...good, points: Array.from({ length: 400 }, (_, i) => [100 + i / 1000 + 0.1234567890123, 200 + i / 1000 + 0.9876543210987]) })) };
  assert.ok(new TextEncoder().encode(JSON.stringify({ type: 'ink.live', ink: heavy })).length > PEN_LIMITS.bytes);
  assert.equal(penInkView(heavy), null, 'over the byte cap');
}
console.log('PASS pen validation: tools, inks, widths, ranges, point and stroke caps, unknown fields dropped');

// The store: per layer (a slide, or one zoomed image of it), undo, clear, clear all, caps.
{
  const store = createPenStore();
  const slide = penLayerKey('a'), zoomed = penLayerKey('a', 'image', 0), other = penLayerKey('b');
  const stroke = (n = 2, x = 10) => ({ tool: 'freehand', ink: 'blue', width: 'thick', points: Array.from({ length: n }, (_, i) => [x + i, 10]) });
  assert.ok(store.add(slide, stroke()));
  assert.ok(store.add(slide, stroke(2, 50)));
  assert.ok(store.add(zoomed, stroke()));
  assert.ok(store.add(other, stroke()));
  assert.equal(store.strokes(slide).length, 2);
  assert.ok(store.undo(slide));
  assert.deepEqual(store.strokes(slide)[0].points[0], [10, 10], 'undo removes the last stroke');
  assert.ok(store.clear(slide));
  assert.equal(store.has(slide), false);
  assert.equal(store.has(zoomed), true, 'clearing the slide leaves its zoomed image');
  assert.equal(store.slideHas('a'), true);
  assert.equal(store.undo(slide), false, 'nothing to undo');
  assert.ok(store.clearAll());
  assert.equal(store.size(), 0);
  // Caps: strokes per layer, and points per layer with room left for the stroke being drawn.
  for (let i = 0; i < PEN_LIMITS.strokesPerLayer; i++) assert.ok(store.add(slide, stroke(1)));
  assert.equal(store.add(slide, stroke(1)), false);
  store.clearAll();
  for (let i = 0; i < 5; i++) assert.ok(store.add(slide, stroke(400)));
  assert.equal(store.add(slide, stroke(1)), false, `committed points stop at ${PEN_LIMITS.pointsPerLayer - PEN_LIMITS.pointsPerStroke}`);
  // One gesture is one undo unit: a long line's pieces come out together.
  store.clearAll();
  assert.ok(store.add(slide, stroke(3)));
  assert.ok(store.add(slide, [stroke(400), stroke(400, 500), stroke(50, 900)]));
  assert.equal(store.strokes(slide).length, 4);
  assert.ok(store.undo(slide));
  assert.equal(store.strokes(slide).length, 1, 'undo removes every piece of the last gesture');
  assert.ok(store.undo(slide));
  assert.equal(store.has(slide), false);
  // A gesture goes in whole or not at all, within the caps.
  for (let i = 0; i < 4; i++) assert.ok(store.add(slide, stroke(400)));
  assert.equal(store.add(slide, [stroke(300), stroke(300)]), false);
  assert.equal(store.strokes(slide).length, 4);
}
console.log('PASS pen store: per-slide and per-image layers, undo, clear this slide, clear all, caps');

// The gesture: a long freehand line is one gesture; nothing reaches the store before release, Esc
// abandons all of it, every piece shown or sent is within the wire cap, and a full layer stops it.
{
  const listeners = {};
  const win = { addEventListener() {}, removeEventListener() {} };
  const root = { ownerDocument: { defaultView: win }, addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {} };
  const surfaceRect = { left: 0, top: 0, width: 1280, height: 720 };
  const store = createPenStore();
  const key = penLayerKey('s');
  let draft = null, pieces = [], commits = 0;
  const gesture = createPenGesture({ root, surface: () => ({ rect: surfaceRect, space: 'slide', slideId: 's' }),
    settings: () => ({ tool: 'freehand', ink: 'red', width: 'thin' }),
    onDraft: (stroke, p) => { draft = stroke; pieces = p; },
    onCommit: (strokes, k) => { commits++; store.add(k, strokes); },
    fits: (k, n, points) => store.fits(k, n, points) });
  const ev = (x, y) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, shiftKey: false, preventDefault() {}, stopPropagation() {} });
  // A zigzag that simplification cannot shorten: about 1,000 points.
  const zig = (i) => [20 + (i % 600) * 2, 100 + (i % 2) * 40 + Math.floor(i / 600) * 200];
  const drawLong = (n) => { listeners.pointerdown(ev(...zig(0))); for (let i = 1; i < n; i++) listeners.pointermove(ev(...zig(i))); };
  drawLong(1000);
  assert.equal(store.has(key), false, 'nothing is committed while drawing');
  assert.ok(pieces.length >= 2, `a long line shows as pieces (${pieces.length})`);
  for (const piece of [...pieces, draft]) assert.ok(piece.points.length <= PEN_LIMITS.pointsPerStroke, 'every piece is within the wire cap');
  assert.ok(gesture.cancel());
  assert.equal(draft, null); assert.deepEqual(pieces, [], 'Esc abandons the whole line');
  assert.equal(store.has(key), false); assert.equal(commits, 0);
  drawLong(1000);
  listeners.pointerup(ev(...zig(999)));
  assert.equal(commits, 1, 'one gesture, one commit');
  const kept = store.strokes(key);
  assert.ok(kept.length >= 3 && kept.every((s) => s.points.length <= PEN_LIMITS.pointsPerStroke), `${kept.length} pieces kept`);
  assert.ok(store.add(key, { tool: 'arrow', ink: 'red', width: 'thin', points: [[1, 1], [100, 100]] }));
  assert.ok(store.undo(key)); assert.ok(store.undo(key));
  assert.equal(store.has(key), false, 'two undos: the arrow, then the whole long line');
  // A line that would overflow the layer stops growing: what is shown is what is kept.
  drawLong(4000);
  const shown = pieces.reduce((sum, p) => sum + p.points.length, 0) + draft.points.length;
  assert.ok(shown <= PEN_LIMITS.pointsPerLayer - PEN_LIMITS.pointsPerStroke, `shown ${shown}`);
  listeners.pointerup(ev(...zig(3999)));
  const total = store.strokes(key).reduce((sum, p) => sum + p.points.length, 0);
  assert.ok(total > 0 && total <= shown, `kept ${total} of ${shown}`);
  const view = { slideId: 's', space: 'slide', strokes: store.strokes(key), draft: null };
  assert.ok(penInkView(view), 'the full layer is still one valid message');
}
console.log('PASS pen gesture: a long line is one undo unit, Esc abandons all of it, pieces within the wire cap, a full layer stops it');

// Every view the store allows fits one message, at the longest coordinates each space has.
{
  for (const [space, x, y, extra] of [['slide', 1279.9, 719.9, {}], ['image', 0.9999, 0.9999, { image: PEN_LIMITS.images - 1 }]]) {
    const store = createPenStore();
    const key = penLayerKey('s'.repeat(PEN_LIMITS.slideIdChars), space, extra.image);
    const big = { tool: 'freehand', ink: 'yellow', width: 'thick', points: Array.from({ length: 20 }, () => [x, y]) };
    while (store.add(key, big));
    let n = store.strokes(key).length;
    while (store.add(key, { ...big, points: [[x, y]] })) n++;
    const draft = { ...big, points: Array.from({ length: PEN_LIMITS.pointsPerStroke }, () => [x, y]) };
    const view = { slideId: 's'.repeat(PEN_LIMITS.slideIdChars), space, ...extra, strokes: store.strokes(key), draft };
    assert.ok(penInkView(view), `${space}: a full layer is valid`);
    const bytes = new TextEncoder().encode(JSON.stringify({ type: 'ink.live', ink: view })).length;
    assert.ok(bytes <= PEN_LIMITS.bytes, `${space}: a full layer is ${bytes} bytes`);
    assert.ok(n > 0);
  }
}
console.log('PASS pen messages: a full layer and its draft fit the byte cap');

// Drawing: fixed tags, numeric attributes and palette colours only.
{
  const made = [];
  const node = (tag) => ({ tag, attrs: {}, children: [], parent: null,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    append(child) { child.parent = this; this.children.push(child); },
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
    get firstChild() { return this.children[0] || null; } });
  const document = { createElementNS(ns, tag) { const n = node(tag); made.push(n); return n; } };
  const group = node('g'); group.ownerDocument = document;
  const view = { slideId: 'a', space: 'slide', strokes: [
    { tool: 'freehand', ink: 'yellow', width: 'thin', points: [[10, 10], [20, 30]] },
    { tool: 'arrow', ink: 'red', width: 'thick', points: [[640, 360], [940, 360]] },
    { tool: 'rectangle', ink: 'green', width: 'thin', points: [[100, 100], [50, 60]] }
  ], draft: { tool: 'freehand', ink: 'blue', width: 'thin', points: [[1, 1]] } };
  penDraw(group, view, { rect: { left: 0, top: 0, width: 640, height: 360 }, canvasScale: 0.5 });
  assert.deepEqual([...new Set(made.map((n) => n.tag))].sort(), ['g', 'path', 'polygon', 'rect']);
  assert.equal(group.children.length, 4);
  assert.equal(group.children[3].attrs.opacity, '0.7', 'the stroke being drawn shows at 70%');
  const colours = new Set(made.flatMap((n) => [n.attrs.stroke, n.attrs.fill]).filter((c) => c && c !== 'none'));
  for (const c of colours) assert.ok(['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', 'rgba(12,16,24,.92)', 'rgba(255,255,255,.96)'].includes(c), c);
  for (const n of made) for (const [name, value] of Object.entries(n.attrs)) {
    if (['d', 'points'].includes(name)) assert.match(value, /^[-0-9.,ML ]+$/, `${name}: ${value}`);
  }
  // The arrowhead's tip is at the head; its length is 32 canvas px at Thick (16 CSS px at half scale).
  const tip = group.children[1].children.find((n) => n.tag === 'polygon' && n.attrs.fill === '#ff3b30').attrs.points.split(' ').map((p) => p.split(',').map(Number));
  assert.deepEqual(tip[0], [640, 360]);
  assert.ok(near(tip[1][0], 640 + 32 * Math.cos(Math.PI / 7), 0.05), `head length: ${tip[1]}`);
  // The rectangle is drawn from its two corners in either order, with an 8% tint.
  const box = group.children[2].children[1].attrs;
  assert.deepEqual([box.x, box.y, box.width, box.height, box['fill-opacity']], ['50', '60', '50', '40', '0.08']);
  // Yellow ink has the dark outline, the others the white.
  assert.equal(group.children[0].children[0].attrs.stroke, 'rgba(12,16,24,.92)');
  penDraw(group, null, {});
  assert.equal(group.children.length, 0, 'no view: nothing drawn');
  assert.match(penCursor('arrow', 'blue', 9), /^url\("data:image\/svg\+xml,[^"]+"\) 14 14, crosshair$/);
  assert.match(penCursor('freehand', 'not-an-ink', 4), /%23ff3b30/, 'an unknown ink falls back to red');
}
console.log('PASS pen drawing: fixed primitives, palette colours, arrowhead at the head, rectangle tint, draft at 70%');
