// Print lifecycle (deck and handout): a print arrangement never outlives its print. A beforeprint with no
// afterprint is undone by the first input; a second beforeprint undoes the first before preparing (so the
// deck's notes and video stand-ins are placed again); the clean-up runs once. A real page.pdf() after an
// abandoned print gives the pages of a first print. A mind map drawn ahead of time is destroyed, once,
// when its slide is first shown, and the map on show is drawn. Neutral fixture; outputs in an ignored
// temporary folder (FIT_LIFECYCLE_OUT=<dir> keeps them).
//   node scripts/test-print-lifecycle.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs';
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs';

const keep = process.env.FIT_LIFECYCLE_OUT;
const dir = keep ? resolve(keep) : mkdtempSync(resolve('.tw-print-lifecycle-'));
mkdirSync(dir, { recursive: true });
const hardStop = setTimeout(() => { console.error('test-print-lifecycle: hard timeout'); process.exit(2); }, 300_000);
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const pageCount = (pdf) => Number(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]);
const pageText = (pdf, n) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ').trim();

// The serialised document: every node, attributes sorted (a restored attribute may come back in another
// order), an empty style attribute counted as none. Scripts and styles are static and left out.
function serialise() {
  const walk = (n) => {
    if (n.nodeType === 3) return n.data;
    if (n.nodeType === 8) return ['#comment', n.data];
    if (n.nodeType !== 1) return null;
    if (n.nodeName === 'SCRIPT' || n.nodeName === 'STYLE') return [n.nodeName];
    const attrs = [...n.attributes].filter((a) => a.name !== 'style' || a.value.trim()).map((a) => [a.name, a.value]).sort();
    return [n.nodeName, attrs, [...n.childNodes].map(walk)];
  };
  return JSON.stringify(walk(document.body));
}
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i >= a.length && a.length === b.length ? '' : `at ${i}: …${a.slice(Math.max(0, i - 80), i + 80)}… vs …${b.slice(Math.max(0, i - 80), i + 80)}…`; };

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const compile = async (md, path) => (await prepareSource(path, md, 'Probe', statSync(path), undefined, { allowedAssetRoots: [dir] })).fullHtml;
  // A real clip (a test pattern), so a printed frame can be told from a blank page.
  copyFileSync(resolve('e2e/fixtures/video-playback-12s.webm'), resolve(dir, 'clip.webm'));
  const md = ['# Probe', '', '## Section', '', '### First point {id=p1}', '', 'A visible sentence.', '', ':::notes', 'A spoken reminder for the first point.', ':::', '',
    '### Two cards {id=car}', '{carousel}', '', '#### First card', '', 'The first card words.', '', '#### Second card', '', 'The second card words.', '',
    '### A clip {id=clip}', '', '![A neutral clip](clip.webm)', '', ':::notes', 'A note beside the clip.', ':::', '',
    '### Last point {id=p2}', '', '- One item', '- Another item', ''].join('\n');
  const mdPath = resolve(dir, 'lifecycle.md');
  writeFileSync(mdPath, md);
  const deck = await compile(md, mdPath);
  const slides = extractSlides(deck);
  const outputs = { deck, handout: buildShareHtml({ title: 'Probe', slug: 'probe', slides, styles: extractStyles(deck) }) };

  const open = async (file, suffix = '') => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.consoleErrors = [];
    page.pageErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') page.consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => page.pageErrors.push(String(error)));
    await page.route(/^https?:\/\//, (route) => route.abort());
    await page.goto(pathToFileURL(file).href + suffix);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    return page;
  };
  const settle = (page) => page.waitForTimeout(500);

  for (const [kind, html] of Object.entries(outputs)) {
    const file = resolve(dir, `lifecycle-${kind}.html`);
    writeFileSync(file, html);

    // 1. beforeprint, no afterprint, then a key that does nothing else: the document is as before printing.
    let page = await open(file);
    try {
      const before = await page.evaluate(serialise);
      await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
      const held = await page.evaluate(() => document.querySelectorAll('.tw-print-canvas').length);
      check(held > 0, `${kind}: beforeprint arranges the document for paper (${held} canvases)`);
      await page.keyboard.press('Shift');
      await settle(page);
      const after = await page.evaluate(serialise);
      check(after === before, `${kind}: beforeprint without afterprint, then a key press: the document is as before printing (${firstDiff(before, after)})`);
    } finally { await page.close(); }

    // 1b. ... and a navigation key: the document is as after the same key on a page never printed.
    const navigated = [];
    for (const printed of [true, false]) {
      page = await open(file);
      try {
        if (printed) await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(900);
        navigated.push(await page.evaluate(serialise));
      } finally { await page.close(); }
    }
    check(navigated[0] === navigated[1], `${kind}: beforeprint without afterprint, then a navigation key: the document is as after that key with no print (${firstDiff(navigated[1], navigated[0])})`);

    // 1c. ... and a pointer press (no key): the document is as after the same press on a page never printed.
    const pressed = [];
    for (const printed of [true, false]) {
      page = await open(file);
      try {
        if (printed) await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
        await page.mouse.move(6, 450);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(900);
        pressed.push({ canvases: await page.evaluate(() => document.querySelectorAll('.tw-print-canvas').length), markup: await page.evaluate(serialise) });
      } finally { await page.close(); }
    }
    check(pressed[0].canvases === 0 && pressed[0].markup === pressed[1].markup, `${kind}: beforeprint without afterprint, then a pointer press: the document is as after that press with no print (${pressed[0].canvases} canvases; ${firstDiff(pressed[1].markup, pressed[0].markup)})`);

    // 1d. A clean-up step that throws does not stop the others; the arrangement counts as undone and the
    // first error goes to the console once. Fault in the fitter's restore (one canvas cannot be unwrapped).
    page = await open(file);
    try {
      await page.evaluate(() => {
        dispatchEvent(new Event('beforeprint'));
        // The unwrap moves the slide out and then removes its canvas: the removal fails, the canvas stays.
        document.querySelector('.tw-print-canvas').remove = () => { throw new Error('injected canvas fault'); };
        dispatchEvent(new Event('afterprint'));
      });
      await settle(page);
      const left = await page.evaluate(() => ({
        canvases: document.querySelectorAll('.tw-print-canvas').length,
        carouselPages: document.querySelectorAll('.carousel-print-page, .carousel-print-src').length,
        notesInside: document.querySelectorAll('.slide > aside.notes').length,
        standIns: document.querySelectorAll('.tw-print-video').length,
      }));
      const errors = page.consoleErrors.filter((e) => /injected canvas fault/.test(e));
      check(left.canvases === 1 && left.carouselPages === 0 && left.standIns === 0 && (kind !== 'deck' || left.notesInside === 2) && errors.length === 1,
        `${kind}: a canvas that fails to unwrap leaves every other part restored, reported once (${JSON.stringify(left)}; ${errors.length} console errors)`);
      const again = await page.evaluate(async () => {
        let count = 0;
        const observer = new MutationObserver((records) => { count += records.length; });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        dispatchEvent(new Event('afterprint'));
        await new Promise((r) => setTimeout(r, 700));
        observer.disconnect();
        return count;
      });
      check(again === 0 && page.consoleErrors.filter((e) => /injected canvas fault/.test(e)).length === 1, `${kind}: after a failed step the clean-up is used up (${again} mutations on a second afterprint)`);
    } finally { await page.close(); }

    if (kind === 'deck') {
      // Fault in one of the deck's own steps (one note cannot go back): the fitter, the other note and the
      // video stand-in are still restored.
      page = await open(file);
      try {
        await page.evaluate(() => {
          dispatchEvent(new Event('beforeprint'));
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
          for (let node; (node = walker.nextNode());) if (node.data === 'notes') { node.replaceWith = () => { throw new Error('injected notes fault'); }; break; }
          dispatchEvent(new Event('afterprint'));
        });
        await settle(page);
        const left = await page.evaluate(() => ({
          canvases: document.querySelectorAll('.tw-print-canvas').length,
          carouselPages: document.querySelectorAll('.carousel-print-page, .carousel-print-src').length,
          notesInside: document.querySelectorAll('.slide > aside.notes').length,
          standIns: document.querySelectorAll('.tw-print-video').length,
        }));
        const errors = page.consoleErrors.filter((e) => /injected notes fault/.test(e));
        check(left.canvases === 0 && left.carouselPages === 0 && left.standIns === 0 && left.notesInside === 1 && errors.length === 1,
          `deck: a note that fails to go back leaves every other part restored, reported once (${JSON.stringify(left)}; ${errors.length} console errors)`);
      } finally { await page.close(); }

      // 1e. A peer's state change (the presenter moves on; delivered through shared storage, as the
      // audience window's storage sync takes it) ends the held arrangement before the new slide shows.
      const followed = [];
      for (const printed of [true, false]) {
        page = await open(file, '?audience=1&session=lifecycle');
        try {
          if (printed) await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
          const seen = await page.evaluate(async () => {
            // Record whether the page is still arranged for paper whenever a slide becomes the one on show.
            const shown = [];
            const add = DOMTokenList.prototype.add;
            const toggle = DOMTokenList.prototype.toggle;
            const owner = new WeakMap();
            document.querySelectorAll('.slide').forEach((slide) => owner.set(slide.classList, slide));
            DOMTokenList.prototype.add = function (...tokens) {
              const slide = owner.get(this);
              if (slide && tokens.includes('active') && !this.contains('active')) shown.push({ id: slide.dataset.id, canvases: document.querySelectorAll('.tw-print-canvas').length });
              return add.apply(this, tokens);
            };
            DOMTokenList.prototype.toggle = function (token, force) {
              const slide = owner.get(this);
              if (slide && token === 'active' && force !== false && !this.contains('active')) shown.push({ id: slide.dataset.id, canvases: document.querySelectorAll('.tw-print-canvas').length });
              return toggle.call(this, token, force);
            };
            const deckId = document.body.dataset.deckId || location.pathname;
            const key = `html-presentations:${deckId}:lifecycle:state`;
            const current = JSON.parse(localStorage.getItem(key) || '{}');
            localStorage.setItem(key, JSON.stringify({ ...current, index: (Number(current.index) || 0) + 1, beat: null, reveal: 0, seq: (Number(current.seq) || 0) + 5, updatedAt: Date.now() + 1000 }));
            await new Promise((r) => setTimeout(r, 1200));
            DOMTokenList.prototype.add = add;
            DOMTokenList.prototype.toggle = toggle;
            return { shown, active: document.querySelector('.slide.active')?.dataset.id, canvases: document.querySelectorAll('.tw-print-canvas').length };
          });
          followed.push({ seen, markup: await page.evaluate(serialise) });
        } finally { await page.close(); }
      }
      const [held, plain] = followed;
      check(held.seen.active === plain.seen.active && held.seen.active !== slides[0].id && held.seen.canvases === 0 && held.seen.shown.length > 0 && held.seen.shown.every((s) => s.canvases === 0),
        `deck: a peer's state change ends a held print before the new slide shows (${JSON.stringify(held.seen)} vs ${JSON.stringify(plain.seen)})`);
      check(held.markup === plain.markup, `deck: after a peer's state change the document is as with no print (${firstDiff(plain.markup, held.markup)})`);
    }

    // 2. beforeprint twice, then afterprint: the second preparation finds every slide (notes under their
    // slide, videos with their stand-ins); afterprint leaves the document as before. 3. The clean-up runs once.
    page = await open(file);
    try {
      const before = await page.evaluate(serialise);
      await page.evaluate(() => { dispatchEvent(new Event('beforeprint')); dispatchEvent(new Event('beforeprint')); });
      const second = await page.evaluate(() => ({
        canvases: document.querySelectorAll('.tw-print-canvas').length,
        nested: document.querySelectorAll('.tw-print-canvas .tw-print-canvas').length,
        notesUnder: [...document.querySelectorAll('aside.notes')].filter((n) => n.previousElementSibling?.matches('.tw-print-canvas') && !n.closest('.slide')).map((n) => n.previousElementSibling.querySelector('.slide')?.dataset.id),
        notesInside: document.querySelectorAll('.slide > aside.notes').length,
        videos: document.querySelectorAll('figure.slide-video > video').length,
        standIns: document.querySelectorAll('figure.slide-video > .tw-print-video').length,
      }));
      check(second.canvases > 0 && second.nested === 0, `${kind}: a second beforeprint wraps every slide once (${JSON.stringify(second)})`);
      if (kind === 'deck') check(JSON.stringify(second.notesUnder) === JSON.stringify(['p1', 'clip']) && second.notesInside === 0, `deck: on a second beforeprint the notes sit below their slides (${JSON.stringify(second)})`);
      check(second.videos === 1 && second.standIns === 1, `${kind}: on a second beforeprint the video has its stand-in (${JSON.stringify(second)})`);
      await page.evaluate(() => dispatchEvent(new Event('afterprint')));
      await settle(page);
      const after = await page.evaluate(serialise);
      check(after === before, `${kind}: beforeprint twice, then afterprint: the document is as before printing (${firstDiff(before, after)})`);
      // The clean-up again (a second afterprint): nothing changes, and no fit is scheduled.
      const mutations = await page.evaluate(async () => {
        const seen = [];
        const observer = new MutationObserver((records) => records.forEach((r) => seen.push(`${r.type} ${r.target.nodeName}.${r.target.className || ''} ${r.attributeName || ''}`)));
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        dispatchEvent(new Event('afterprint'));
        await new Promise((r) => setTimeout(r, 700));
        observer.disconnect();
        return seen;
      });
      check(mutations.length === 0, `${kind}: the clean-up called a second time changes nothing (${mutations.length} mutations: ${JSON.stringify(mutations.slice(0, 5))})`);
    } finally { await page.close(); }

    // 4. A real print after an abandoned one (beforeprint, a key press, then page.pdf()) gives the pages
    // of a first print.
    const pdfs = {};
    for (const history of ['first', 'after-abandoned']) {
      page = await open(file);
      try {
        // Both prints after the idle preparation has laid out the video's slide (its frame then prints).
        await page.waitForTimeout(3000);
        if (history === 'after-abandoned') {
          await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
          await page.keyboard.press('Shift');
          await settle(page);
        }
        const pdf = resolve(dir, `lifecycle-${kind}-${history}.pdf`);
        await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
        const pages = pageCount(pdf);
        const prefix = resolve(dir, `lifecycle-${kind}-${history}`);
        execFileSync('pdftoppm', ['-r', '30', '-png', pdf, prefix]);
        pdfs[history] = { pages, texts: Array.from({ length: pages }, (_, i) => pageText(pdf, i + 1)), prefix };
      } finally { await page.close(); }
    }
    const { first, 'after-abandoned': again } = pdfs;
    check(first.pages === again.pages && JSON.stringify(first.texts) === JSON.stringify(again.texts),
      `${kind}: a print after an abandoned print has the pages of a first print (${first.pages} vs ${again.pages}; ${JSON.stringify(first.texts.find((t, i) => t !== again.texts[i]) ?? '')} vs ${JSON.stringify(again.texts.find((t, i) => t !== first.texts[i]) ?? '')})`);
    if (first.pages === again.pages) {
      const width = String(first.pages).length;
      const differing = Array.from({ length: first.pages }, (_, i) => String(i + 1).padStart(width, '0'))
        .filter((n) => !readFileSync(`${first.prefix}-${n}.png`).equals(readFileSync(`${again.prefix}-${n}.png`)));
      check(differing.length === 0, `${kind}: a print after an abandoned print draws the same pages as a first print (pages differing: ${differing.join(', ')})`);
    }
    if (kind === 'deck') check(first.texts.some((t) => /spoken reminder for the first point/.test(t)), `deck: the first print has its notes (${JSON.stringify(first.texts)})`);
  }

  // 6. Paper shows the slides and nothing else, and the video prints its frame: the saved presentation,
  // the presenter window (with the app's last-slide notice laid over it, as its preload does) and the
  // handout, by a real page.pdf(). Every word on every page is the talk's own; the video's page is drawn.
  {
    const vocabulary = new Set();
    const addWords = (text) => { for (const w of String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) vocabulary.add(w); };
    addWords(md);
    // What the deck adds itself: the placeholder's word, the closing slide, section numbers and carousel "n / m".
    ['video', 'probe', 'section', 'thank you'].forEach(addWords);
    // A page as raw pixels (PPM), for the share of strongly coloured pixels below the title band.
    const colourShare = (pdf, n) => {
      const prefix = resolve(dir, `colour-${n}`);
      execFileSync('pdftoppm', ['-f', String(n), '-l', String(n), '-r', '40', '-singlefile', pdf, prefix]);
      const ppm = readFileSync(prefix + '.ppm');
      const head = ppm.toString('latin1', 0, 64).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
      const [w, h, offset] = [Number(head[1]), Number(head[2]), head[0].length];
      let strong = 0, all = 0;
      for (let y = Math.round(h * 0.2); y < Math.round(h * 0.95); y++) for (let x = 0; x < w; x++) {
        const i = offset + (y * w + x) * 3;
        const v = [ppm[i], ppm[i + 1], ppm[i + 2]];
        all++;
        if (Math.max(...v) - Math.min(...v) > 120) strong++;
      }
      return strong / all;
    };
    for (const [kind, suffix] of [['deck', ''], ['presenter', '?presenter=1'], ['handout', '']]) {
      const file = resolve(dir, `lifecycle-${kind === 'handout' ? 'handout' : 'deck'}.html`);
      const page = await open(file, suffix);
      try {
        // The idle preparation lays out the never-shown video slide once its frame has loaded.
        await page.waitForTimeout(3500);
        if (kind === 'presenter') {
          await page.evaluate(() => {
            const notice = document.createElement('div');
            notice.className = 'twrec-toast twrec-save-offer show';
            notice.style.cssText = 'position:fixed;top:24px;left:30%;z-index:2147483000;background:#111;color:#fff;padding:12px 18px;font:16px sans-serif';
            notice.innerHTML = '<b>Last slide.</b> Save this run to History?';
            document.body.appendChild(notice);
          });
        }
        // The stand-in's picture lies exactly where the video's own picture lies on paper (print media on).
        await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
        await page.emulateMedia({ media: 'print' });
        const placed = await page.evaluate(() => {
          const fig = document.querySelector('.slide[data-id="clip"] figure.slide-video');
          const standIn = fig?.querySelector('.tw-print-video');
          const video = fig?.querySelector('video');
          if (!standIn || !video) return { standIn: standIn?.tagName || null };
          const content = (el, ratio) => {
            const r = el.getBoundingClientRect();
            const f = fig.getBoundingClientRect();
            let w = r.width, h = r.height;
            if (w / h > ratio) w = h * ratio; else h = w / ratio;
            return [(r.left + (r.width - w) / 2 - f.left) / f.width, (r.top + (r.height - h) / 2 - f.top) / f.height, w / f.width, h / f.height].map((v) => Math.round(v * 1000) / 1000);
          };
          const ratio = video.videoWidth / video.videoHeight || 4 / 3;
          const out = { standIn: standIn.tagName, ratio, videoShown: getComputedStyle(video).display };
          out.standInBox = content(standIn, standIn.tagName === 'CANVAS' ? standIn.width / standIn.height : ratio);
          fig.classList.remove('tw-print-video-on');
          standIn.style.display = 'none';
          out.videoBox = content(video, ratio);
          fig.classList.add('tw-print-video-on');
          standIn.style.display = '';
          return out;
        });
        // Back to no emulation (page.pdf() would otherwise print the screen media).
        await page.emulateMedia({ media: null });
        await page.evaluate(() => dispatchEvent(new Event('afterprint')));
        await settle(page);
        const pdf = resolve(dir, `paper-${kind}.pdf`);
        await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
        const pages = Array.from({ length: pageCount(pdf) }, (_, i) => pageText(pdf, i + 1));
        const foreign = pages.map((t, i) => [i + 1, (t.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !vocabulary.has(w) && !/^\d+$/.test(w))]).filter(([, words]) => words.length);
        check(foreign.length === 0, `${kind}: every printed word is the talk's own, nothing of the window's chrome prints (${JSON.stringify(foreign.slice(0, 4))})`);
        check(!pages.some((t) => /history/i.test(t)), `${kind}: the last-slide notice does not print`);
        const clipPage = pages.findIndex((t) => /A clip/.test(t)) + 1;
        const share = clipPage > 0 ? colourShare(pdf, clipPage) : 0;
        check(clipPage > 0 && share > 0.03, `${kind}: the video's page prints the video's picture (page ${clipPage}, ${Math.round(share * 1000) / 10}% strongly coloured)`);
        const off = placed.standInBox && placed.videoBox ? Math.max(...placed.standInBox.map((v, i) => Math.abs(v - placed.videoBox[i]))) : 1;
        check(placed.standIn === 'CANVAS' && placed.videoShown === 'none' && off <= 0.01, `${kind}: the video prints as its frame (no player, no controls), laid exactly over the video's picture (${JSON.stringify(placed)})`);
      } finally { await page.close(); }
    }
  }

  // 5. A mind map drawn ahead of time (idle preparation) is destroyed once when its slide is first shown,
  // and the map on show is drawn.
  const mapMd = '# Probe\n## Section\n### First {id=m0}\n\nA short line.\n\n### A map {id=mmap}\n{mindmap}\n\n- Centre idea\n  - Northbranch\n  - Southbranch\n';
  const mapPath = resolve(dir, 'map.md');
  writeFileSync(mapPath, mapMd);
  const mapDeck = await compile(mapMd, mapPath);
  const mapSlides = extractSlides(mapDeck);
  for (const [kind, html] of [['deck', mapDeck], ['handout', buildShareHtml({ title: 'Probe', slug: 'probe', slides: mapSlides, styles: extractStyles(mapDeck) })]]) {
    const file = resolve(dir, `map-${kind}.html`);
    writeFileSync(file, html);
    const page = await open(file);
    try {
      const ahead = await page.waitForFunction(() => { const h = document.querySelector('.mindmap-mm'); return !!(h && h.__mmAhead && h.__mmInstance); }, null, { timeout: 20000 }).then(() => true, () => false);
      check(ahead, `${kind}: the mind map is drawn ahead of time`);
      if (!ahead) continue;
      await page.evaluate(() => {
        const host = document.querySelector('.mindmap-mm');
        const old = host.__mmInstance;
        window.__mm = { old, destroyed: 0, fitsAfter: 0 };
        const destroy = old.destroy.bind(old);
        old.destroy = () => { window.__mm.destroyed++; destroy(); };
        const fit = old.fit.bind(old);
        old.fit = (...a) => { if (window.__mm.destroyed) window.__mm.fitsAfter++; return fit(...a); };
        // A render of the old instance already under way across the replacement: Markmap's own
        // renderData, held at its animation-frame step until released below.
        const raf = window.requestAnimationFrame;
        const heldFrames = [];
        window.requestAnimationFrame = (callback) => { heldFrames.push(callback); return 0; };
        try { window.__mm.render = Object.getPrototypeOf(old).renderData.call(old).then(() => 'done', (error) => 'rejected: ' + error); }
        finally { window.requestAnimationFrame = raf; }
        window.__mm.heldFrames = heldFrames;
      });
      await page.evaluate((id) => { location.hash = id; }, 'mmap');
      await page.waitForTimeout(2500);
      const shown = await page.evaluate(() => {
        const host = document.querySelector('.mindmap-mm');
        return { destroyed: window.__mm.destroyed, fitsAfter: window.__mm.fitsAfter, fresh: host.__mmInstance && host.__mmInstance !== window.__mm.old,
          svgs: host.querySelectorAll(':scope > svg').length, text: host.textContent.replace(/\s+/g, ' ').trim(), ahead: !!host.__mmAhead };
      });
      check(shown.destroyed === 1 && shown.fitsAfter === 0, `${kind}: the map drawn ahead of time is destroyed once when its slide is shown (${JSON.stringify(shown)})`);
      check(shown.fresh && shown.svgs === 1 && /Northbranch/.test(shown.text) && /Southbranch/.test(shown.text) && !shown.ahead, `${kind}: the map on show is drawn afresh (${JSON.stringify(shown)})`);
      // The held render then finishes on the destroyed instance: the map on show is untouched.
      const mapState = () => {
        const host = document.querySelector('.mindmap-mm');
        const svg = host.querySelector(':scope > svg');
        return { svgs: host.querySelectorAll(':scope > svg').length, markup: svg ? svg.outerHTML : '', box: svg ? svg.getBoundingClientRect().toJSON() : null,
          labels: [...host.querySelectorAll('foreignObject')].map((f) => Number(f.getAttribute('width')) || 0) };
      };
      const beforeRelease = await page.evaluate(mapState);
      const released = await page.evaluate(async () => {
        const frames = window.__mm.heldFrames;
        frames.forEach((callback) => callback(performance.now()));
        const outcome = await Promise.race([window.__mm.render, new Promise((r) => setTimeout(() => r('pending'), 3000))]);
        await new Promise((r) => setTimeout(r, 1200));
        return { frames: frames.length, outcome };
      });
      const afterRelease = await page.evaluate(mapState);
      check(released.frames >= 1 && released.outcome !== 'pending' && afterRelease.markup === beforeRelease.markup && JSON.stringify(afterRelease.box) === JSON.stringify(beforeRelease.box) && page.pageErrors.length === 0,
        `${kind}: a render of the old map under way across the replacement leaves the map on show untouched (${JSON.stringify(released)}; ${afterRelease.markup === beforeRelease.markup ? 'same' : 'changed'} markup; errors ${JSON.stringify(page.pageErrors)})`);
      // Leave and come back: the fresh map stays, whole (labels measured), and is not replaced again.
      await page.evaluate((id) => { location.hash = id; }, mapSlides[0].id);
      await page.waitForTimeout(800);
      await page.evaluate((id) => { location.hash = id; }, 'mmap');
      await page.waitForTimeout(1500);
      const revisited = await page.evaluate(() => {
        const host = document.querySelector('.mindmap-mm');
        return { destroyed: window.__mm.destroyed, same: host.__mmInstance !== window.__mm.old, svgs: host.querySelectorAll(':scope > svg').length,
          text: host.textContent.replace(/\s+/g, ' ').trim().slice(-60), labels: [...host.querySelectorAll('foreignObject')].map((f) => Number(f.getAttribute('width')) || 0) };
      });
      check(revisited.destroyed === 1 && revisited.same && revisited.svgs === 1 && /Northbranch/.test(revisited.text) && revisited.labels.length >= 3 && revisited.labels.every((w) => w > 0),
        `${kind}: the fresh map, left and shown again, stays whole (${JSON.stringify(revisited)})`);
    } finally { await page.close(); }
  }

  console.log(JSON.stringify({ failures: failures.length }));
  for (const f of failures) console.error('FAIL ' + f.slice(0, 1200));
  assert.equal(failures.length, 0);
} finally {
  clearTimeout(hardStop);
  await browser?.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
