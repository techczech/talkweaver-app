// After a print, every stateful slide is as it was (deck): a stepped terminal at its step position, a
// carousel on a later card, a reveal part-way, a stepped trace window, a scrolled code block, a video
// paused at a time or playing, a zoomed and panned mind map, and an embedded page scrolled, not reloaded.
// Two print paths: the events a browser sends around window.print() with print media switched on and
// off between them, and a real page.pdf(). No PDF tools needed. Neutral fixture, served from 127.0.0.1;
// outputs in an ignored temporary folder (PRINT_STATE_OUT=<dir> keeps them).
//   node scripts/test-print-restores-state.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';

const keep = process.env.PRINT_STATE_OUT;
const dir = keep ? resolve(keep) : mkdtempSync(resolve('.tw-print-state-'));
mkdirSync(resolve(dir, 'assets'), { recursive: true });
const hardStop = setTimeout(() => { console.error('test-print-restores-state: hard timeout'); process.exit(2); }, 300_000);
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

const TURNS = [
  'user: user', 'Make a chart of monthly visitors from data.csv',
  'model: model → harness', 'read_file({"path": "data.csv"})',
  'harness: harness → model', 'month,visitors', '2026-01,1240', '2026-02,1387', '2026-03,1522', '2026-04,1498',
  'reasoning: model · reasoning', 'The April dip is small; a line chart with a zero baseline shows the trend fairly.',
  'model: model → harness', 'run_python({"file": "plot.py"})',
  'harness: harness → model', 'saved figures/visitors.png',
  'model: model → user', 'Saved figures/visitors.png. It shows steady growth, with a dip in April.',
  'user: user', 'Now add a second line for returning visitors and label both lines at their right end.',
  'model: model → harness', 'read_file({"path": "returning.csv"})',
  'harness: harness → model', 'month,returning', '2026-01,410', '2026-02,455', '2026-03,502', '2026-04,488',
  'model: model → user', 'Done. Two lines, each labelled at its right end. Returning visitors follow the same April dip.',
];
const outline = [
  '---', 'title: Print state', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### Start {id=start}', '', 'A short line.', '',
  '### Long shell {id=longshell}', '{terminal reveal=steps}', '', '```terminal',
  ...Array.from({ length: 22 }, (_, i) => `$ step-${i + 1} --run\noutput line for step ${i + 1}`), '```', '',
  '### Three cards {id=car}', '{carousel}', '', '#### First card', '', 'The first card words.', '', '#### Second card', '', 'The second card words.', '', '#### Third card', '', 'The third card words.', '',
  '### Reveal list {id=rev}', '{mode=reveal}', '', '- First point', '- Second point', '- Third point', '- Fourth point', '- Fifth point', '',
  '### Visualise data {id=trace}', '{trace mode=reveal}', '', '```trace', ...TURNS, '```', '',
  '### Code {id=code}', '', '```python', ...Array.from({ length: 70 }, (_, i) => `value_${i} = compute(${i})  # line ${i + 1}`), '```', '',
  '### Clip {id=clip}', '', '![Clip](clip.webm){controls}', '',
  '### Map {id=map}', '{mindmap}', '', '- Centre idea', '  - Northbranch', '    - Leaf one', '  - Southbranch', '    - Leaf two', '',
  '### Widget {id=widget}', '', '[Embed: assets/widget.html]', '',
  '### End {id=end}', '', 'Done.', '',
].join('\n');

const types = { '.html': 'text/html', '.webm': 'video/webm', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let server;
let browser;
try {
  copyFileSync(resolve('e2e/fixtures/video-playback-12s.webm'), resolve(dir, 'clip.webm'));
  writeFileSync(resolve(dir, 'assets/widget.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}p{height:60px;margin:0}</style>'
    + Array.from({ length: 60 }, (_, i) => `<p>Widget row ${i + 1}</p>`).join(''));
  const mdPath = resolve(dir, 'talk.md');
  writeFileSync(mdPath, outline);
  const model = await prepareSource(mdPath, outline, 'Probe', statSync(mdPath), undefined, { allowedAssetRoots: [dir] });
  writeFileSync(resolve(dir, 'deck.html'), model.fullHtml);
  server = createServer((req, res) => {
    // The request's path, relative to the fixture folder (a file path, not a URL's).
    const relative = decodeURIComponent(String(req.url).split(/[?#]/)[0]).replace(/^\/+/, '');
    const path = resolve(dir, ...relative.split('/'));
    if (!path.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try { const body = readFileSync(path); res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/deck.html`;
  browser = await chromium.launch({ headless: true });

  // The state of the slide on show: its markup (attributes sorted, empty style as none), every scroll
  // position in it, its videos, its mind map's zoom and the embedded page's scroll and life.
  const snapshot = async (page) => {
    const inPage = await page.evaluate(() => {
      const slide = document.querySelector('.slide.active');
      const walk = (n) => {
        if (n.nodeType === 3) return n.data;
        if (n.nodeType !== 1) return null;
        if (n.nodeName === 'IFRAME') return ['IFRAME', n.getAttribute('src')];
        const attrs = [...n.attributes].filter((a) => a.name !== 'style' || a.value.trim()).map((a) => [a.name, a.value]).sort();
        return [n.nodeName, attrs, [...n.childNodes].map(walk)];
      };
      const all = [slide, ...slide.querySelectorAll('*')];
      return {
        id: slide.dataset.id,
        markup: JSON.stringify(walk(slide)),
        scrolls: all.map((el, i) => [i, el.className && String(el.className).slice(0, 40), Math.round(el.scrollTop), Math.round(el.scrollLeft)]).filter(([, , t, l]) => t || l),
        videos: [...slide.querySelectorAll('video')].map((v) => ({ paused: v.paused, t: Math.round(v.currentTime * 10) / 10 })),
        map: [...slide.querySelectorAll('.mindmap-mm svg > g')].map((g) => g.getAttribute('transform')),
        canvases: document.querySelectorAll('.tw-print-canvas').length,
      };
    });
    const frame = await (await page.$('.slide.active figure.slide-embed iframe'))?.contentFrame();
    inPage.frame = frame ? await frame.evaluate(() => ({ y: Math.round(scrollY), alive: window.__alive === 1 })).catch(() => 'gone') : null;
    return inPage;
  };
  const printEvents = async (page) => {
    await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(150);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => dispatchEvent(new Event('afterprint')));
  };
  const printPdf = async (page) => { await page.pdf({ path: resolve(dir, 'print.pdf'), preferCSSPageSize: true, printBackground: true }); };

  const cases = [
    ['longshell', 'a stepped terminal at step 1', async (p) => { await p.keyboard.press('ArrowRight'); }],
    ['car', 'a carousel on its second card', async (p) => { await p.keyboard.press('ArrowRight'); }],
    ['rev', 'a reveal at its second step', async (p) => { await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); }],
    ['trace', 'a stepped trace window at its sixth turn', async (p) => { for (let i = 0; i < 6; i++) await p.keyboard.press('ArrowRight'); }],
    ['code', 'a scrolled code block', async (p) => p.evaluate(() => {
      const box = [...document.querySelectorAll('.slide.active *')].find((el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible');
      if (box) box.scrollTop = 90;
      window.__codeScrollable = Boolean(box);
    })],
    ['clip', 'a video paused at 3.2 s', async (p) => p.evaluate(async () => {
      const v = document.querySelector('.slide.active video');
      v.muted = true;
      await new Promise((r) => { if (v.readyState >= 1) r(); else v.addEventListener('loadedmetadata', r, { once: true }); });
      v.currentTime = 3.2;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      v.pause();
    })],
    ['map', 'a mind map zoomed and panned', async (p) => p.evaluate(async () => {
      const host = document.querySelector('.slide.active .mindmap-mm');
      for (let i = 0; i < 40 && !host.__mmInstance; i++) await new Promise((r) => setTimeout(r, 100));
      await host.__mmDrawn;
      const inst = host.__mmInstance;
      inst.svg.call(inst.zoom.transform, window.d3.zoomIdentity.translate(60, 40).scale(1.7));
    })],
    ['widget', 'an embedded page scrolled', async (p) => {
      // A local page is inlined (srcdoc) and starts when its slide is shown.
      const frame = await (async () => {
        for (let i = 0; i < 50; i++) {
          const f = await (await p.$('.slide.active figure.slide-embed iframe'))?.contentFrame();
          if (f && await f.evaluate(() => document.querySelectorAll('p').length >= 60).catch(() => false)) return f;
          await p.waitForTimeout(100);
        }
        return null;
      })();
      check(Boolean(frame), 'widget: the embedded page loads');
      if (frame) await frame.evaluate(() => { window.__alive = 1; scrollTo(0, 300); });
    }],
  ];

  const results = [];
  for (const [id, label, setUp] of cases) {
    for (const [how, print] of [['events', printEvents], ['page.pdf', printPdf]]) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      try {
        await page.goto(`${base}#${id}`);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(900);
        await setUp(page);
        await page.waitForTimeout(900);
        if (id === 'code' && !(await page.evaluate(() => window.__codeScrollable))) { results.push(`${id}: not scrollable on screen, nothing to keep`); continue; }
        const before = await snapshot(page);
        await print(page);
        await page.waitForTimeout(1200);
        const after = await snapshot(page);
        const same = (k) => JSON.stringify(before[k]) === JSON.stringify(after[k]);
        const differing = ['id', 'markup', 'scrolls', 'videos', 'map', 'canvases', 'frame'].filter((k) => !same(k));
        results.push(`${id}/${how}: ${differing.length ? 'differs in ' + differing.join(', ') : 'as before'}`);
        check(differing.length === 0, `${label}, printed by ${how}: as before printing (differs in ${differing.join(', ')}: ${differing.filter((k) => k !== 'markup').map((k) => `${k} ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`).join('; ')})`);
      } finally { await page.close(); }
    }
  }
  // A video that was playing keeps playing through a print.
  for (const [how, print] of [['events', printEvents], ['page.pdf', printPdf]]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    try {
      await page.goto(`${base}#clip`);
      await page.waitForTimeout(900);
      const t0 = await page.evaluate(async () => { const v = document.querySelector('.slide.active video'); v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 500)); return v.currentTime; });
      await print(page);
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => { const v = document.querySelector('.slide.active video'); return { paused: v.paused, t: v.currentTime }; });
      results.push(`clip playing/${how}: ${after.paused ? 'paused' : 'playing'}`);
      check(!after.paused && after.t > t0, `a playing video, printed by ${how}: still playing (${JSON.stringify(after)}, from ${t0})`);
    } finally { await page.close(); }
  }

  console.log(results.join('\n'));
  console.log(JSON.stringify({ failures: failures.length }));
  for (const f of failures) console.error('FAIL ' + f.slice(0, 900));
  assert.equal(failures.length, 0);
} finally {
  clearTimeout(hardStop);
  await browser?.close();
  server?.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
