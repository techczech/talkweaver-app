// Paper prints the screen slide, scaled: every word prints where it sits on screen at 1280x720 (so
// line breaks are the same),
// in the compiled deck and the handout, in the Ocean and Classic looks. Also: the sampler's link slide
// prints whole, never-visited diagrams print drawn, and a video prints a stand-in, never a black box.
// Real PDFs through page.pdf() with no media emulation. Neutral fixtures and the bundled demo sampler.
//   node scripts/test-print-no-reflow.mjs   (NO_REFLOW_OUT=<dir> keeps the PDFs)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs';
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs';
import { inClassicLook } from './lib/slide-markup-identity.mjs';

const keep = process.env.NO_REFLOW_OUT;
const dir = keep ? resolve(keep) : mkdtempSync(resolve('.tw-no-reflow-'));
mkdirSync(dir, { recursive: true });
const hardStop = setTimeout(() => { console.error('test-print-no-reflow: hard timeout'); process.exit(2); }, 840_000);
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const norm = (w) => String(w).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const pageCount = (pdf) => Number(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]);
const pageText = (pdf, n, crop = []) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), ...crop, pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
// Every word on a printed page, as a fraction of the page's 16:9 slide box (8 mm margins, landscape).
function pdfWords(pdf, n) {
  const xml = execFileSync('pdftotext', ['-f', String(n), '-l', String(n), '-bbox-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const w = Number(xml.match(/<page width="([\d.]+)"/)[1]);
  const m = 8 * 72 / 25.4, bw = w - 2 * m, bh = bw * 9 / 16;
  return [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map((x) => ({ w: norm(x[5].replace(/&amp;/g, '&')), x: (Number(x[1]) - m) / bw, y: (Number(x[2]) - m) / bh, y2: (Number(x[4]) - m) / bh })).filter((x) => x.w);
}
// Every displayed word of one slide on screen, as a fraction of the slide's box.
function screenWordsSource() {
  return (slide) => {
    const norm = (w) => String(w).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const skip = '.sr-only, .qf-sr, aside.notes, script, style, template, .slide-qr-corner, .carousel-print-count, svg';
    const box = slide.getBoundingClientRect();
    const out = [];
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const el = node.parentElement;
      if (!el || el.closest(skip) || !el.checkVisibility()) continue;
      for (const m of node.data.matchAll(/\S+/g)) {
        const w = norm(m[0]);
        if (!w) continue;
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getClientRects()[0];
        if (!r || !(r.width > 0)) continue;
        // Only words drawn inside the slide; a word the screen already clips is not compared.
        if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
        out.push({ w, x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, y2: (r.bottom - box.top) / box.height });
      }
    }
    return out;
  };
}
// A word is in place when the page has the same word within 1% across and 2% down (a line is 4% or more).
function displaced(screenWords, paperWords) {
  return screenWords.filter((s) => !paperWords.some((p) => p.w === s.w && Math.abs(p.x - s.x) < 0.01
    && p.y < s.y2 + 0.02 && p.y2 > s.y - 0.02 && Math.abs((p.y + p.y2) / 2 - (s.y + s.y2) / 2) < 0.02));
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const source = resolve('scripts/fixtures/ocean-look/talk-combinations-outline.md');
  const markdown = readFileSync(source, 'utf8');
  const compile = async (md, path = source, roots = [resolve('scripts/fixtures'), dir]) => (await prepareSource(path, md, 'Probe', statSync(path), undefined, { allowedAssetRoots: roots })).fullHtml;

  // 1. Words in place: paper equals screen.
  // Deliberate paper exceptions, where the screen itself loses something:
  // - Classic rail statements with a picture: on screen the picture (or later paragraphs) sit off the
  //   canvas, as in 0.44.0; on paper the paragraphs stack under the picture (base.css), so all print.
  // - Ocean tc-iconrow-rail: on screen a label breaks mid-word; on paper that counts as a failed fit and
  //   the slide prints its safe drawing (slide-fit.js, oceanFallBack).
  // For these, every word of the slide must still print inside its box.
  const exceptions = new Set(['classic:tc-title-paras-picture', 'classic:tc-title-para-picture', 'classic:tc-quote-picture', 'ocean:tc-iconrow-rail']);
  for (const look of ['ocean', 'classic']) {
    const deck = await compile(look === 'classic' ? inClassicLook(markdown) : markdown);
    const slides = extractSlides(deck);
    const outputs = [['deck', deck], ['handout', buildShareHtml({ title: 'Probe', slug: 'probe', slides, styles: extractStyles(deck) })]];
    for (const [kind, html] of outputs) {
      const file = resolve(dir, `${look}-${kind}.html`);
      writeFileSync(file, html);
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        const screen = [];
        for (const s of slides) {
          await page.evaluate((id) => { location.hash = id; }, s.id);
          await page.waitForTimeout(250);
          screen.push(await page.evaluate(`(${screenWordsSource()})(document.querySelector('.stage .slide[data-id="${s.id}"]'))`));
        }
        await page.evaluate((id) => { location.hash = id; }, slides[0].id);
        await page.waitForTimeout(300);
        const pdf = resolve(dir, `${look}-${kind}.pdf`);
        await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
        check(pageCount(pdf) === slides.length, `${look} ${kind}: ${slides.length} slides on ${slides.length} pages (got ${pageCount(pdf)})`);
        let moved = 0;
        slides.forEach((s, i) => {
          if (exceptions.has(`${look}:${s.id}`)) {
            const inBox = new Set(pdfWords(pdf, i + 1).filter((p) => p.x >= -0.005 && p.x <= 1.005 && p.y >= -0.005 && p.y2 <= 1.005).map((p) => p.w));
            const missing = [...new Set(screen[i].map((x) => x.w))].filter((w) => !inBox.has(w));
            check(!missing.length, `${look} ${kind}: ${s.id} (paper exception) prints all its words inside the slide (missing ${JSON.stringify(missing.slice(0, 4))})`);
            return;
          }
          const off = displaced(screen[i], pdfWords(pdf, i + 1));
          if (off.length) moved++;
          check(!off.length, `${look} ${kind}: ${s.id} prints every word where it sits on screen (${off.length} of ${screen[i].length} displaced, e.g. ${JSON.stringify(off.slice(0, 3).map((o) => o.w))})`);
        });
        console.log(look, kind, 'slides', slides.length, 'with displaced words', moved);
      } finally {
        await page.close();
      }
    }
  }

  // 2. The sampler's link slide prints whole (its first link was cut at the top when the content took
  // the slide's padding on paper).
  {
    const samplerPath = resolve('demo-vault/layout-sampler/layout-sampler-outline.md');
    const deck = await compile(readFileSync(samplerPath, 'utf8'), samplerPath, [dirname(samplerPath)]);
    const file = resolve(dir, 'sampler.html');
    writeFileSync(file, deck);
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    try {
      await page.route(/^https?:\/\//, (route) => route.abort());
      await page.goto(pathToFileURL(file).href);
      await page.waitForTimeout(600);
      const label = await page.evaluate(() => document.querySelector('.slide[data-id="doctor-stage-clip"] a')?.textContent.trim().replace(/\s+/g, ' '));
      const pdf = resolve(dir, 'sampler.pdf');
      await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
      let found = 0;
      for (let n = 1; n <= pageCount(pdf); n++) if (pageText(pdf, n).includes('Doctor fixture') && pageText(pdf, n).includes('stage clipping')) found = n;
      check(found > 0 && label, 'sampler: the stage-clipping slide prints');
      if (found && label) {
        const xml = execFileSync('pdftotext', ['-f', String(found), '-l', String(found), '-bbox-layout', pdf, '-'], { encoding: 'utf8' });
        const page0 = xml.match(/<page width="([\d.]+)" height="([\d.]+)">/);
        const m = 8 * 72 / 25.4, w = Number(page0[1]);
        const top = m, bottom = m + (w - 2 * m) * 9 / 16;
        const first = norm(label.split(' ')[0]);
        const box = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].find((x) => norm(x[5]) === first);
        const text = pageText(pdf, found);
        check(label.split(' ').every((word) => text.includes(word)), `sampler: every word of the first link prints (${label})`);
        check(box && Number(box[2]) >= top - 0.5 && Number(box[4]) <= bottom + 0.5, 'sampler: the first link sits inside the slide box, not cut at its top');
        execFileSync('pdftoppm', ['-f', String(found), '-l', String(found), '-r', '80', '-singlefile', '-png', pdf, resolve(dir, 'sampler-stage-clip')]);
      }
    } finally {
      await page.close();
    }
  }

  // 3. Never-visited diagrams print drawn; 4. a video prints a stand-in.
  {
    writeFileSync(resolve(dir, 'clip.mp4'), Buffer.alloc(64));
    const md = '# Probe\n## Section\n### First {id=d0}\n\nA short line.\n\n### A map {id=dmap}\n{mindmap}\n\n- Centre idea\n  - Northbranch\n  - Southbranch\n\n### A flow {id=dflow}\n\n```mermaid\nflowchart LR\n  A[Draftstep] --> B[Feedbackstep]\n```\n\n### A clip {id=dvideo}\n\n![A neutral clip](clip.mp4)\n';
    const mdPath = resolve(dir, 'diagrams.md');
    writeFileSync(mdPath, md);
    const deck = await compile(md, mdPath);
    const slides = extractSlides(deck);
    for (const [kind, html] of [['deck', deck], ['handout', buildShareHtml({ title: 'Probe', slug: 'probe', slides, styles: extractStyles(deck) })]]) {
      const file = resolve(dir, `diagrams-${kind}.html`);
      writeFileSync(file, html);
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      try {
        await page.goto(pathToFileURL(file).href);
        // The deck draws the never-visited diagrams during idle time after load.
        await page.waitForFunction(() => [...document.querySelectorAll('.mindmap-mm, .mermaid-mm')].every((h) => h.querySelector('svg')), null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(500);
        const visible = await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id);
        check(visible === slides[0].id, `${kind}: the first slide stays on screen while diagrams draw (${visible})`);
        const pdf = resolve(dir, `diagrams-${kind}.pdf`);
        await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
        const pages = Array.from({ length: pageCount(pdf) }, (_, i) => pageText(pdf, i + 1));
        const all = pages.join(' ');
        check(/Northbranch/.test(all) && /Southbranch/.test(all), `${kind}: a never-visited mind map prints its branches`);
        check(/Draftstep/.test(all) && /Feedbackstep/.test(all), `${kind}: a never-visited Mermaid diagram prints its nodes`);
        if (kind === 'deck') {
          const n = pages.findIndex((t) => /A clip/.test(t)) + 1;
          // The neutral clip is inlined (a data: URL) and has no caption, so its placeholder reads "Video".
          check(n > 0 && /\bVideo\b/.test(pages[n - 1]) && !/base64/.test(pages[n - 1]), 'deck: a video without a poster or frame prints its placeholder');
          if (n > 0) execFileSync('pdftoppm', ['-f', String(n), '-l', String(n), '-r', '60', '-singlefile', '-png', pdf, resolve(dir, 'deck-video')]);
          const mapPage = pages.findIndex((t) => /Northbranch/.test(t)) + 1;
          if (mapPage > 0) execFileSync('pdftoppm', ['-f', String(mapPage), '-l', String(mapPage), '-r', '60', '-singlefile', '-png', pdf, resolve(dir, 'deck-mindmap')]);
        }
      } finally {
        await page.close();
      }
      // A mind map whose slide was shown and then left prints whole too (leaving used to re-measure its
      // labels at zero, so it printed collapsed, as in 0.44.0).
      const left = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      try {
        await left.goto(pathToFileURL(file).href + '#dmap');
        await left.waitForTimeout(2500);
        await left.evaluate((id) => { location.hash = id; }, slides[0].id);
        await left.waitForTimeout(1000);
        const pdf = resolve(dir, `diagrams-${kind}-left.pdf`);
        await left.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
        const all = Array.from({ length: pageCount(pdf) }, (_, i) => pageText(pdf, i + 1)).join(' ');
        check(/Northbranch/.test(all) && /Southbranch/.test(all), `${kind}: a mind map shown and then left prints its branches`);
      } finally {
        await left.close();
      }
    }
  }
  console.log(JSON.stringify({ failures: failures.length }));
  assert.deepEqual(failures, []);
} finally {
  clearTimeout(hardStop);
  await browser?.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
