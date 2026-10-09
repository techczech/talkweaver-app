// The Pen in a recording's replay (ticket 08): ink drawn on a zoomed image is replayed over that
// image where it sits on the slide (the replay does not zoom), for any zoomable picture, including
// an image-grid cell, and at the place the picture is drawn inside its element: object-fit and
// object-position decide it. A plain grid cell is contain, centred; a framed screenshot row is
// cover pinned left top (the deck's own rule), set here on the cell as that rule sets it.
// Headless chrome-headless-shell (Playwright's bundled Chromium); the replay deck is driven with the
// same tw-replay-state messages Studio sends.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';

const dir = await mkdtemp(join(tmpdir(), 'tw-pen-replay-'));
const outline = `---
title: Pen replay
auto_title_slide: false
auto_thanks_slide: false
---

### Text
{id=text}

- Words on a slide

### Grid
{image-grid} {id=grid}

![One](one.svg)
- First cell

![Two](two.svg)
- Second cell
`;
const path = join(dir, 'pen-replay.md');
await writeFile(path, outline);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#234"/></svg>';
for (const name of ['one.svg', 'two.svg']) await writeFile(join(dir, name), svg);
const prepared = await prepareSource(path, outline, null, await stat(path), {}, {});
const server = createServer((req, res) => {
  const image = req.url.endsWith('.svg');
  res.setHeader('content-type', image ? 'image/svg+xml' : 'text/html');
  res.end(image ? svg : prepared.fullHtml);
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
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/deck?replay=1&audience=1`);
  await page.waitForSelector('.slide.active');
  const full = { tool: 'rectangle', ink: 'blue', width: 'thick', points: [[0, 0], [1, 1]] };
  const replay = (state) => page.evaluate((state) => window.postMessage({ type: 'tw-replay-state', hiddenCount: 0, highlights: [], ...state }, '*'), state);
  // The drawn rectangle (its fill, without the stroke) and the cell's element box, in page pixels.
  const measure = () => page.evaluate(() => {
    const root = document.querySelector('.tw-live-overlay');
    const shown = root && getComputedStyle(root).display !== 'none' ? [...root.querySelectorAll('[data-pen-stroke]')] : [];
    const img = document.querySelectorAll('.slide.active .image-grid .ig-media img')[0];
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
    return { strokes: shown.length, ink: shown.length ? r([...shown[0].children].at(-1)) : null, box: img ? r(img) : null,
      natural: img ? [img.naturalWidth, img.naturalHeight] : null, fit: img && getComputedStyle(img).objectFit, position: img && getComputedStyle(img).objectPosition };
  });
  const near = (a, b, label) => {
    for (const k of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(a[k] - b[k]) < 1.5, `${label}: ${k} ${a[k].toFixed(1)} vs ${b[k].toFixed(1)}`);
  };
  const waitInk = (n) => page.waitForFunction((n) => {
    const root = document.querySelector('.tw-live-overlay');
    const count = root && getComputedStyle(root).display !== 'none' ? root.querySelectorAll('[data-pen-stroke]').length : 0;
    return count === n;
  }, n, { timeout: 4000 });
  // Frame the first cell as the screenshot row does (cover, pinned by object-position) in a 300 px
  // square box (a 600×400 picture is cropped at the sides), so where it is pinned shows.
  const frame = (position) => page.evaluate((position) => {
    const img = document.querySelectorAll('.slide.active .image-grid .ig-media img')[0];
    img.style.setProperty('height', '300px', 'important');
    img.style.setProperty('width', '300px', 'important');
    img.style.setProperty('object-fit', 'cover', 'important');
    img.style.setProperty('object-position', position, 'important');
  }, position);
  const drawn = (m, fx, fy) => {
    const k = (m.fit === 'cover' ? Math.max : Math.min)(m.box.width / m.natural[0], m.box.height / m.natural[1]);
    const w = m.natural[0] * k, h = m.natural[1] * k;
    return { left: m.box.left + (m.box.width - w) * fx, top: m.box.top + (m.box.height - h) * fy, width: w, height: h };
  };

  await check('an image-grid cell is a zoomable picture: its zoomed ink replays over the cell on the slide', async () => {
    await replay({ slideId: 'grid', ink: [full], inkSpace: 'image', inkImage: 0 });
    await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'grid');
    await page.waitForFunction(() => document.querySelectorAll('.slide.active .image-grid .ig-media img')[0]?.naturalWidth > 0);
    await waitInk(1);
    const m = await measure();
    assert.ok(m.box && m.ink, JSON.stringify(m));
    assert.equal(m.fit, 'contain', 'a grid cell shows its whole picture');
    near(m.ink, drawn(m, 0.5, 0.5), 'grid cell, contain, centred ' + JSON.stringify(m));
  });

  await check('a framed picture (cover, pinned left top): the ink starts at the picture\'s left-top corner, at the cropped picture\'s size', async () => {
    await frame('left top');
    await replay({ slideId: 'grid', ink: [{ ...full, ink: 'red' }], inkSpace: 'image', inkImage: 0 });
    await waitInk(1);
    await page.waitForTimeout(100);
    const m = await measure();
    assert.equal(m.fit, 'cover');
    near(m.ink, drawn(m, 0, 0), 'left top ' + JSON.stringify(m));
    assert.ok(m.ink.width > m.box.width + 20, 'the picture is cropped (wider than its box)');
  });

  await check('centred and percentage object-position move the replayed ink with the picture', async () => {
    for (const [position, fx, fy] of [['50% 50%', 0.5, 0.5], ['center', 0.5, 0.5], ['30% 80%', 0.3, 0.8]]) {
      await frame(position);
      await replay({ slideId: 'grid', ink: [{ ...full, ink: position.length % 2 ? 'green' : 'yellow' }], inkSpace: 'image', inkImage: 0 });
      await waitInk(1);
      await page.waitForTimeout(100);
      const m = await measure();
      near(m.ink, drawn(m, fx, fy), position + ' ' + JSON.stringify(m));
    }
  });

  await check('the second cell has its own place; a slide-layer mark (unzoomed) hides the image ink', async () => {
    await replay({ slideId: 'grid', ink: [full], inkSpace: 'image', inkImage: 1 });
    await waitInk(1);
    const second = await page.evaluate(() => {
      const r = (b) => ({ left: b.left, top: b.top, width: b.width, height: b.height });
      const img = document.querySelectorAll('.slide.active .image-grid .ig-media img')[1];
      const ink = [...document.querySelector('.tw-live-overlay [data-pen-stroke]').children].at(-1);
      return { box: r(img.getBoundingClientRect()), ink: r(ink.getBoundingClientRect()), natural: [img.naturalWidth, img.naturalHeight], fit: getComputedStyle(img).objectFit };
    });
    near(second.ink, drawn(second, 0.5, 0.5), 'second cell ' + JSON.stringify(second));
    await replay({ slideId: 'grid', ink: [] });
    await waitInk(0);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser?.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(`pen replay DOM: ${results.length} checks passed${process.exitCode ? ', some failed' : ''}`);
