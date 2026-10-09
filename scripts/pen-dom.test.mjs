// The Pen in the real presenter and projector windows (ticket 08; ADR-0037; drawn in
// the pointer-and-pen design notes). Headless chrome-headless-shell (Playwright's bundled
// Chromium), a presenter and an audience window paired over the session's BroadcastChannel.
//   Freehand, Arrow and Rectangle with the rubber band, Shift, Esc and the 1% click rule; W and ⇧W;
//   the Pen button's ink dot and glyph; the same place and scale on the projector for a text slide,
//   an image slide and a zoomed image; drawings kept per slide and per zoomed image; Undo, Clear this
//   slide and Clear all on both screens; a late projector gets the current drawing; closing the
//   presenter clears the projector; nothing in localStorage; no ink in print, thumbnails or a handout;
//   ink legibility outlines; a recorded key is added to the default.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts';
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs';

const dir = await mkdtemp(join(tmpdir(), 'tw-pen-'));
const outline = `---
title: Pen
auto_title_slide: false
auto_thanks_slide: false
---

### Text
{id=text}

- Words on a slide

### Image
{id=image}

![Detail](image.svg)

### End
{id=end}

- End
`;
const path = join(dir, 'pen.md');
await writeFile(path, outline);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#234"/><circle cx="180" cy="320" r="15" fill="red"/></svg>';
await writeFile(join(dir, 'image.svg'), svg);
const prepared = await prepareSource(path, outline, null, await stat(path), {}, {});
const share = buildShareHtml({ title: 'Pen', slug: 'pen', includeNotes: false, license: null, styles: '',
  slides: [{ html: '<section class="slide" data-id="text"><h1>Text</h1></section>', notes: '' }] });
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url.startsWith('/image.svg') ? 'image/svg+xml' : 'text/html');
  res.end(req.url.startsWith('/preview') ? markSlidePreviewHtml(prepared.fullHtml)
    : req.url.startsWith('/share') ? share : req.url.startsWith('/image.svg') ? svg : prepared.fullHtml);
});

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(name); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack || error}`); process.exitCode = 1; }
}
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__inkPeerSends = [];
    const Native = window.BroadcastChannel;
    window.BroadcastChannel = class extends Native {
      constructor(name) { super(name); window.__inkChannel = name; }
      postMessage(message) { if (message?.command === 'ink') { window.__inkPeerSends.push(message.ink); window.__inkType = message.type; } super.postMessage(message); }
    };
  });
  const presenter = await context.newPage();
  let audience = await context.newPage();
  await presenter.setViewportSize({ width: 1440, height: 900 });
  await audience.setViewportSize({ width: 1280, height: 800 });
  const errors = [];
  const watch = (page) => page.on('pageerror', (e) => errors.push(e.message));
  watch(presenter); watch(audience);
  await audience.goto(`${origin}/deck?audience=1&session=pen`);
  await presenter.goto(`${origin}/deck?presenter=1&session=pen`);
  await presenter.waitForSelector('#currentPreview iframe');
  await presenter.waitForFunction(() => document.querySelector('#presenterPen svg.tw-ico'));

  const surfaceOf = (page, side) => page.evaluate((side) => {
    const zoomed = document.getElementById('lightbox')?.classList.contains('open') && !document.getElementById('lightboxImg').hidden;
    const el = zoomed ? document.getElementById('lightboxImg') : side === 'presenter' ? document.querySelector('#currentPreview iframe') : document.querySelector('.stage');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, side);
  const liveInk = () => presenter.evaluate(() => JSON.parse(document.documentElement.dataset.twLiveInk || 'null'));
  const strokesOn = (page) => page.locator('.tw-live-overlay [data-pen-stroke]').count();
  const waitStrokes = async (page, n) => page.waitForFunction((n) => {
    const root = document.querySelector('.tw-live-overlay');
    return root && getComputedStyle(root).display !== 'none' ? root.querySelectorAll('[data-pen-stroke]').length === n : n === 0;
  }, n, { timeout: 4000 });
  const waitLive = (fn, arg) => presenter.waitForFunction(fn, arg, { timeout: 4000 });
  // A drag from (fx, fy) to (tx, ty) in fractions of the current drawing surface.
  async function drag(fx, fy, tx, ty, { steps = 8, shift = false, escape = false } = {}) {
    const r = await surfaceOf(presenter, 'presenter');
    await presenter.mouse.move(r.x + r.width * fx, r.y + r.height * fy);
    if (shift) await presenter.keyboard.down('Shift');
    await presenter.mouse.down();
    for (let i = 1; i <= steps; i++) await presenter.mouse.move(r.x + r.width * (fx + (tx - fx) * i / steps), r.y + r.height * (fy + (ty - fy) * i / steps));
    if (escape) await presenter.keyboard.press('Escape');
    await presenter.mouse.up();
    if (shift) await presenter.keyboard.up('Shift');
  }
  // Where a stroke's rendered box sits on a surface, as fractions of that surface.
  const strokeBox = (page, side, index) => page.evaluate(({ side, index }) => {
    const zoomed = document.getElementById('lightbox')?.classList.contains('open') && !document.getElementById('lightboxImg').hidden;
    const el = zoomed ? document.getElementById('lightboxImg') : side === 'presenter' ? document.querySelector('#currentPreview iframe') : document.querySelector('.stage');
    const s = el.getBoundingClientRect();
    const node = document.querySelectorAll('.tw-live-overlay [data-pen-stroke]')[index];
    const ink = [...node.children].at(-1).getBoundingClientRect();
    return { x: (ink.x - s.x) / s.width, y: (ink.y - s.y) / s.height, w: ink.width / s.width, h: ink.height / s.height, scale: s.width / 1280 };
  }, { side, index });
  const sameBox = (a, b, label) => {
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(a[k] - b[k]) < 0.012, `${label}: ${k} ${a[k].toFixed(4)} vs ${b[k].toFixed(4)}`);
  };

  await check('D turns the pen on: pressed button with the ink dot, the "Pen on" chip and the options popover above the Pen button', async () => {
    await presenter.keyboard.press('d');
    assert.equal(await presenter.getAttribute('#presenterPen', 'aria-pressed'), 'true');
    assert.ok(await presenter.isVisible('#presenterPenChip'));
    assert.ok(await presenter.isVisible('#presenterPen .tw-pen-dot'));
    assert.equal(await presenter.isVisible('#presenterPen .tw-pen-glyph'), false, 'Freehand carries no tool glyph');
    const pop = await presenter.locator('#presenterPenPop').boundingBox();
    const pen = await presenter.locator('#presenterPen').boundingBox();
    const bar = await presenter.locator('#presenterBottomBar').boundingBox();
    assert.ok(pop.y + pop.height <= bar.y + 1, `popover clears the bar (${pop.y + pop.height} vs ${bar.y})`);
    assert.ok(Math.abs(pop.x + pop.width - (pen.x + pen.width)) <= 1, 'right edges aligned');
    assert.ok(pop.x >= 0 && pop.y >= 0, 'on screen');
    assert.equal(await presenter.textContent('#presenterPenState'), 'Red · Freehand');
    assert.equal(await presenter.textContent('#presenterPenKey'), 'D');
    const cursor = await presenter.locator('.tw-live-overlay').evaluate((el) => getComputedStyle(el).cursor);
    assert.match(cursor, /^url\("data:image\/svg\+xml/, 'the pen cursor is drawn');
  });

  await check('Freehand on a text slide lands at the same place and scale on the projector; a scribble under 1% makes nothing', async () => {
    await drag(0.2, 0.3, 0.5, 0.45);
    await waitStrokes(audience, 1);
    sameBox(await strokeBox(presenter, 'presenter', 0), await strokeBox(audience, 'audience', 0), 'freehand');
    const p = await strokeBox(presenter, 'presenter', 0), a = await strokeBox(audience, 'audience', 0);
    assert.notEqual(p.scale.toFixed(3), a.scale.toFixed(3), 'the two windows show the slide at different sizes');
    await drag(0.6, 0.6, 0.603, 0.602, { steps: 2 });
    await presenter.waitForTimeout(150);
    assert.equal((await liveInk()).strokes.length, 1, 'a click makes nothing');
    assert.equal(await strokesOn(audience), 1);
  });

  await check('Ink arriving on the channel is checked before the projector draws it: bad shapes, inks and ranges are ignored', async () => {
    const before = await audience.evaluate(() => document.querySelector('.tw-live-overlay').innerHTML);
    await presenter.evaluate(() => {
      const channel = new BroadcastChannel(window.__inkChannel);
      const stroke = { tool: 'freehand', ink: 'red', width: 'thin', points: [[1, 1], [500, 300]] };
      for (const ink of [
        { slideId: 'text', space: 'slide', strokes: [{ ...stroke, ink: 'url(javascript:alert(1))' }], draft: null },
        { slideId: 'text', space: 'slide', strokes: [{ ...stroke, points: [[1, 1], [99999, 3]] }], draft: null },
        { slideId: 'text', space: 'slide', strokes: [{ ...stroke, tool: 'script' }], draft: null },
        { slideId: 'text', space: 'slide', strokes: Array.from({ length: 101 }, () => stroke), draft: null },
        { slideId: 'text', space: 'slide', strokes: [{ ...stroke, ink: ['red'] }], draft: null },
        { slideId: 'text', space: 'slide', strokes: [{ ...stroke, ink: { toString: null, valueOf: null } }], draft: null },
        { slideId: 'text', space: 'slide', strokes: Array.from({ length: 6 }, () => ({ ...stroke, points: Array.from({ length: 400 }, (_, i) => [100 + i / 1000 + 0.1234567890123, 200 + i / 1000 + 0.9876543210987]) })), draft: null },
        '<svg onload=alert(1)>'
      ]) channel.postMessage({ type: window.__inkType, command: 'ink', ink });
      channel.close();
    });
    await audience.waitForTimeout(300);
    assert.equal(await audience.evaluate(() => document.querySelector('.tw-live-overlay').innerHTML), before, 'the projector drew none of them');
  });

  await check('W steps Freehand → Arrow → Rectangle and ⇧W steps back; the Pen button shows the tool glyph', async () => {
    await presenter.keyboard.press('w');
    assert.equal(await presenter.textContent('#presenterPenState'), 'Red · Arrow');
    assert.ok(await presenter.isVisible('#presenterPen .tw-pen-glyph .lucide-move-up-right'));
    assert.match(await presenter.locator('.tw-live-overlay').evaluate((el) => getComputedStyle(el).cursor), / 14 14, crosshair$/);
    await presenter.keyboard.press('w');
    assert.equal(await presenter.textContent('#presenterPenState'), 'Red · Rectangle');
    assert.ok(await presenter.isVisible('#presenterPen .tw-pen-glyph .lucide-square'));
    await presenter.keyboard.press('w');
    assert.equal(await presenter.textContent('#presenterPenState'), 'Red · Freehand');
    await presenter.keyboard.press('Shift+W');
    assert.equal(await presenter.textContent('#presenterPenState'), 'Red · Rectangle');
    await presenter.keyboard.press('Shift+W');
    assert.equal(await presenter.textContent('#presenterPenState'), 'Red · Arrow');
  });

  await check('Arrow: the head where the drag began, a rubber band at 70% while dragging, Shift snaps to 45°, under 1% makes nothing', async () => {
    const r = await surfaceOf(presenter, 'presenter');
    await presenter.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.3);
    await presenter.mouse.down();
    await presenter.mouse.move(r.x + r.width * 0.75, r.y + r.height * 0.5, { steps: 4 });
    await audience.waitForFunction(() => document.querySelector('.tw-live-overlay [data-pen-stroke="arrow"][opacity="0.7"]'));
    assert.equal(await presenter.locator('.tw-live-overlay [data-pen-stroke="arrow"]').getAttribute('opacity'), '0.7');
    await presenter.mouse.up();
    await waitStrokes(audience, 2);
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).strokes.length === 2 && !JSON.parse(document.documentElement.dataset.twLiveInk).draft);
    const ink = await liveInk();
    const arrow = ink.strokes.at(-1);
    assert.equal(arrow.tool, 'arrow');
    assert.ok(Math.abs(arrow.points[0][0] - 0.6 * 1280) < 2 && Math.abs(arrow.points[0][1] - 0.3 * 720) < 2, `head at the press: ${arrow.points[0]}`);
    // The tip of the drawn head is at the press on the projector too.
    const tip = await audience.evaluate(() => {
      const poly = [...document.querySelectorAll('.tw-live-overlay [data-pen-stroke="arrow"] polygon')].at(-1);
      const [x, y] = poly.getAttribute('points').split(' ')[0].split(',').map(Number);
      return { x: x / 1280, y: y / 720 };
    });
    assert.ok(Math.abs(tip.x - 0.6) < 0.002 && Math.abs(tip.y - 0.3) < 0.002, `projector tip ${tip.x}, ${tip.y}`);
    await drag(0.3, 0.7, 0.55, 0.73, { shift: true });
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).strokes.length === 3);
    const flat = (await liveInk()).strokes.at(-1);
    assert.ok(Math.abs(flat.points[1][1] - flat.points[0][1]) < 1, `Shift snaps to horizontal: ${JSON.stringify(flat.points)}`);
    await drag(0.4, 0.4, 0.405, 0.4, { steps: 2 });
    await presenter.waitForTimeout(150);
    assert.equal((await liveInk()).strokes.length, 3, 'an arrow under 1% of the slide makes nothing');
  });

  await check('Rectangle: corner to corner in any direction, Shift a square, Esc abandons the drag, the next Esc turns the pen off', async () => {
    await presenter.keyboard.press('w');
    await drag(0.8, 0.8, 0.65, 0.6);
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).strokes.length === 4);
    const box = (await liveInk()).strokes.at(-1);
    assert.equal(box.tool, 'rectangle');
    await drag(0.1, 0.1, 0.3, 0.2, { shift: true });
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).strokes.length === 5);
    const sq = (await liveInk()).strokes.at(-1).points;
    assert.ok(Math.abs(Math.abs(sq[1][0] - sq[0][0]) - Math.abs(sq[1][1] - sq[0][1])) < 1, `Shift draws a square: ${JSON.stringify(sq)}`);
    await waitStrokes(audience, 5);
    await drag(0.5, 0.5, 0.7, 0.7, { escape: true });
    await presenter.waitForTimeout(200);
    assert.equal((await liveInk()).strokes.length, 5, 'Esc during a drag abandons the shape');
    assert.equal(await presenter.getAttribute('#presenterPen', 'aria-pressed'), 'true', 'the pen stays on');
    await waitStrokes(audience, 5);
    await presenter.keyboard.press('Escape');
    assert.equal(await presenter.getAttribute('#presenterPen', 'aria-pressed'), 'false');
    assert.equal(await presenter.isVisible('#presenterPenPop'), false);
    assert.equal(await strokesOn(presenter), 5, 'the drawing stays when the pen is off');
    assert.ok(await presenter.isVisible('#presenterInkClear'), '"Clear drawing" shows with no tool on');
  });

  await check('Ink reads on light, dark and photographs: a contrasting outline under every stroke (dark under yellow)', async () => {
    await presenter.keyboard.press('d');
    await presenter.click('#penInkYellow');
    await presenter.click('#penToolFreehand');
    await presenter.click('#penWidthThick');
    await drag(0.1, 0.9, 0.4, 0.85);
    await waitStrokes(audience, 6);
    const looks = await audience.evaluate(() => [...document.querySelectorAll('.tw-live-overlay [data-pen-stroke]')].map((g) => [...g.children].map((n) => n.getAttribute('stroke'))));
    assert.deepEqual(looks.at(-1), ['rgba(12,16,24,.92)', '#ffd60a']);
    assert.deepEqual(looks[0], ['rgba(255,255,255,.96)', '#ff3b30']);
    const widths = await audience.evaluate(() => {
      const g = [...document.querySelectorAll('.tw-live-overlay [data-pen-stroke]')].at(-1);
      const scale = document.querySelector('.stage').getBoundingClientRect().width / 1280;
      return [...g.children].map((n) => Number(n.getAttribute('stroke-width')) / scale);
    });
    assert.ok(Math.abs(widths[1] - 9) < 0.05 && Math.abs(widths[0] - 13.8) < 0.05, `thick ink 9 canvas px with its outline: ${widths}`);
  });

  await check('Undo removes the last stroke; an image slide matches the projector; leaving and returning shows the drawing again on both screens; Next shows the pen mark', async () => {
    await presenter.keyboard.press('Meta+z');
    await waitStrokes(audience, 5);
    await waitStrokes(presenter, 5);
    await presenter.keyboard.press('Escape');
    await presenter.keyboard.press('ArrowRight');
    await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'image');
    await waitStrokes(audience, 0);
    await waitStrokes(presenter, 0);
    // The previous slide (drawn) is not Next; draw on the image slide, then come back.
    await presenter.keyboard.press('d');
    await drag(0.3, 0.3, 0.6, 0.5);
    await waitStrokes(audience, 1);
    sameBox(await strokeBox(presenter, 'presenter', 0), await strokeBox(audience, 'audience', 0), 'image slide');
    await presenter.keyboard.press('Escape');
    await presenter.keyboard.press('ArrowLeft');
    await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'text');
    await waitStrokes(audience, 5);
    await waitStrokes(presenter, 5);
    assert.ok(await presenter.isVisible('#nextPreview > .tw-ink-mark'), 'Next (the image slide) carries the pen mark');
    assert.equal(await presenter.isVisible('#followingPreview > .tw-ink-mark'), false, 'Then (End) has no drawing');
  });

  await check('A zoomed image has its own drawing, at the same place on the picture; it returns when the image is zoomed again', async () => {
    await presenter.keyboard.press('ArrowRight');
    await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'image');
    await presenter.keyboard.press('z');
    await audience.waitForFunction(() => document.getElementById('lightbox').classList.contains('open'));
    await waitStrokes(audience, 0);
    await presenter.keyboard.press('d');
    assert.ok(await presenter.isVisible('#presenterPenStrip'), 'the strip sits at the foot of the zoomed view');
    assert.equal(await presenter.isVisible('#presenterPenPop'), false);
    await drag(0.25, 0.25, 0.7, 0.6);
    await waitStrokes(audience, 1);
    const ink = await liveInk();
    assert.equal(ink.space, 'image');
    assert.equal(ink.image, 0);
    sameBox(await strokeBox(presenter, 'presenter', 0), await strokeBox(audience, 'audience', 0), 'zoomed image');
    await presenter.keyboard.press('Escape');
    await presenter.keyboard.press('z');
    await audience.waitForFunction(() => !document.getElementById('lightbox').classList.contains('open'));
    await waitStrokes(audience, 1);
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).space === 'slide');
    assert.equal((await liveInk()).strokes.length, 1, 'unzoomed: the slide layer (its one stroke) shows, not the image layer');
    await presenter.keyboard.press('z');
    await audience.waitForFunction(() => document.getElementById('lightbox').classList.contains('open'));
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).space === 'image');
    await waitStrokes(audience, 1);
    sameBox(await strokeBox(presenter, 'presenter', 0), await strokeBox(audience, 'audience', 0), 'zoomed again');
    // Clear this slide on the zoomed view clears only the image's layer.
    await presenter.keyboard.press('x');
    await waitStrokes(audience, 0);
    await presenter.keyboard.press('z');
    await waitStrokes(audience, 1);
  });

  await check('A projector window that opens late receives the current slide\'s drawing', async () => {
    await audience.close();
    audience = await context.newPage();
    watch(audience);
    await audience.setViewportSize({ width: 1000, height: 700 });
    await audience.goto(`${origin}/deck?audience=1&session=pen`);
    await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'image');
    await waitStrokes(audience, 1);
  });

  await check('Clear this slide and Clear all do what they say on both screens; nothing is kept in localStorage', async () => {
    const stored = await presenter.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'));
    assert.ok(!stored.includes('"strokes"') && !stored.includes('freehand'), 'no ink in the presenter\'s localStorage');
    const storedA = await audience.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'));
    assert.ok(!storedA.includes('"strokes"'), 'no ink in the projector\'s localStorage');
    await presenter.click('#presenterInkClear');
    await waitStrokes(audience, 0);
    await presenter.keyboard.press('ArrowLeft');
    await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'text');
    await waitStrokes(audience, 5);
    await presenter.keyboard.press('Shift+X');
    await waitStrokes(audience, 0);
    await waitStrokes(presenter, 0);
    await presenter.keyboard.press('ArrowRight');
    await presenter.keyboard.press('z');
    await waitStrokes(presenter, 0);
    await presenter.keyboard.press('z');
  });

  await check('Ink never prints and never appears in thumbnails or a handout', async () => {
    await presenter.keyboard.press('ArrowLeft');
    await presenter.keyboard.press('d');
    await drag(0.2, 0.2, 0.6, 0.6);
    await waitStrokes(audience, 1);
    await audience.emulateMedia({ media: 'print' });
    assert.equal(await audience.locator('.tw-live-overlay').evaluate((el) => getComputedStyle(el).display), 'none');
    await audience.emulateMedia({ media: 'screen' });
    const preview = await context.newPage();
    await preview.goto(`${origin}/preview?audience=1&session=pen`);
    await preview.waitForTimeout(500);
    assert.equal(await preview.locator('.tw-live-overlay').count(), 0, 'a thumbnail or preview document has no overlay');
    await preview.close();
    const handout = await context.newPage();
    await handout.goto(`${origin}/share`);
    await handout.waitForTimeout(300);
    assert.equal(await handout.locator('.tw-live-overlay').count(), 0, 'a handout has no overlay');
    assert.equal(await handout.locator('[data-pen-stroke]').count(), 0);
    await handout.close();
  });

  await check('A long freehand line is one gesture: Esc abandons all of it on both screens, Undo removes all of it, every piece within the wire cap', async () => {
    const r = await surfaceOf(presenter, 'presenter');
    const zig = async (n, { escape = false } = {}) => {
      await presenter.mouse.move(r.x + r.width * 0.1, r.y + r.height * 0.4);
      await presenter.mouse.down();
      for (let i = 1; i < n; i++) await presenter.mouse.move(r.x + r.width * (0.1 + 0.8 * i / n), r.y + r.height * (0.4 + (i % 2) * 0.06));
      if (escape) await presenter.keyboard.press('Escape');
      await presenter.mouse.up();
    };
    await zig(900, { escape: true });
    await presenter.waitForTimeout(250);
    assert.equal((await liveInk()).strokes.length, 1, 'Esc: no piece of the long line is kept');
    await waitStrokes(audience, 1);
    assert.equal(await presenter.getAttribute('#presenterPen', 'aria-pressed'), 'true');
    await zig(900);
    await waitLive(() => { const v = JSON.parse(document.documentElement.dataset.twLiveInk); return !v.draft && v.strokes.length >= 4; });
    const kept = await liveInk();
    assert.ok(kept.strokes.every((s) => s.points.length <= 400), 'every piece within the wire cap');
    await waitStrokes(audience, kept.strokes.length);
    await presenter.keyboard.press('Meta+z');
    await waitLive(() => JSON.parse(document.documentElement.dataset.twLiveInk).strokes.length === 1);
    await waitStrokes(audience, 1);
    await waitStrokes(presenter, 1);
  });

  await check('Closing the presenter ends the drawings on the projector', async () => {
    await presenter.close({ runBeforeUnload: false });
    await waitStrokes(audience, 0);
  });

  await check('A recorded key is added to D; D still works', async () => {
    const page = await context.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('talkweaver:presenter:shortcuts', JSON.stringify({ 'presenter.pen': { chord: 'Y', entryId: 'pen' } })));
    await page.goto(`${origin}/deck?presenter=1&session=pen-keys`);
    await page.waitForFunction(() => document.querySelector('#presenterPen svg.tw-ico'));
    await page.keyboard.press('y');
    assert.equal(await page.getAttribute('#presenterPen', 'aria-pressed'), 'true');
    await page.keyboard.press('d');
    assert.equal(await page.getAttribute('#presenterPen', 'aria-pressed'), 'false');
    assert.equal(await page.getAttribute('#presenterPen', 'data-key'), 'Y / D');
    await page.close();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser?.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`pen DOM: ${results.length} checks passed${process.exitCode ? ', some failed' : ''}`);
