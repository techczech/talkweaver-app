// Deck printing (compiled deck, single-file export, presenter route): one whole slide per page and no
// slide text lost. Real PDFs through page.pdf() with no media emulation, so beforeprint fires in the
// screen layout as in a real print. Neutral fixtures only; outputs stay in an ignored folder.
//   node scripts/test-deck-print.mjs            (FIT_DECK_OUT=<dir> keeps the PDFs and rasters)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs';
import { injectEmbeddedSource } from '../compiler/scripts/lib/09-output-builders.mjs';
import { inClassicLook } from './lib/slide-markup-identity.mjs';
import { carouselOutline, png } from './lib/handout-carousel-fixture.mjs';

const keep = process.env.FIT_DECK_OUT;
const dir = keep ? resolve(keep) : mkdtempSync(resolve('.tw-deck-print-'));
mkdirSync(dir, { recursive: true });
const hardStop = setTimeout(() => { console.error('test-deck-print: hard timeout'); process.exit(2); }, 840_000);
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const pageCount = (pdf) => Number(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]);
const pageText = (pdf, n) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf8' });
const pageSize = (pdf) => execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/Page size:\s+([\d.]+) x ([\d.]+)/).slice(1).map(Number);
const words = (text) => {
  const counts = new Map();
  for (const w of String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) counts.set(w, (counts.get(w) || 0) + 1);
  return counts;
};
const missingWords = (expected, printed) => {
  const have = words(printed), out = [];
  for (const [w, n] of words(expected)) if ((have.get(w) || 0) < n) out.push(w);
  return out;
};

// Each printable slide's own displayed text, read on screen with that slide shown (hidden reveal
// steps keep their text; every carousel card counts). Screen-reader-only text, notes and screen-only
// controls are left out.
async function slideTexts(page) {
  return page.evaluate(() => {
    const skip = '.sr-only, .qf-sr, aside.notes, script, style, template, .embed-interact-chip, .video-enlarge, .media-step-mark, .media-step-tap, .gallery-nav, .slide-qr-corner';
    return [...document.querySelectorAll('.deck > .stage > .slide')].map((slide) => {
      const prior = [slide.style.getPropertyValue('display'), slide.style.getPropertyPriority('display')];
      slide.style.setProperty('display', 'grid', 'important');
      const parts = [];
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const el = node.parentElement;
        if (!el || el.closest(skip)) continue;
        if (!el.closest('.card-gallery.carousel[data-exclusive] > .card') && !el.checkVisibility()) continue;
        parts.push(node.data);
      }
      if (prior[0]) slide.style.setProperty('display', prior[0], prior[1]); else slide.style.removeProperty('display');
      return { id: slide.dataset.id, text: parts.join(' ') };
    });
  });
}

async function printDeck(browser, file, { suffix = '', name, pdfOptions = { preferCSSPageSize: true }, visit, beforePrint } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  try {
    await page.route(/^https?:\/\//, (route) => route.abort());
    await page.goto(pathToFileURL(file).href + suffix);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    if (visit) {
      for (const id of visit) { await page.evaluate((h) => { location.hash = h; }, id); await page.waitForTimeout(300); }
    }
    const texts = await slideTexts(page);
    if (beforePrint) await beforePrint(page);
    const pdf = resolve(dir, name + '.pdf');
    await page.pdf({ path: pdf, printBackground: true, ...pdfOptions });
    return { pdf, texts, pages: pageCount(pdf) };
  } finally {
    await page.close();
  }
}

// Page-by-page: the n-th page holds the n-th slide; every word of the slide prints on its page.
function checkOnePerPage(label, { pdf, texts, pages }, expectedPages = texts.length) {
  check(pages === expectedPages, `${label}: ${expectedPages} slides print on ${expectedPages} pages (got ${pages})`);
  if (pages !== expectedPages) return;
  texts.forEach((slide, i) => {
    const missing = missingWords(slide.text, pageText(pdf, i + 1));
    check(missing.length === 0, `${label}: slide ${slide.id} keeps its text on page ${i + 1} (missing ${JSON.stringify(missing.slice(0, 8))})`);
  });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const source = resolve('scripts/fixtures/ocean-look/talk-combinations-outline.md');
  const markdown = readFileSync(source, 'utf8');
  const compile = async (md, path = source) => (await prepareSource(path, md, 'Probe', statSync(path), undefined, { allowedAssetRoots: [resolve('scripts/fixtures'), dir] })).fullHtml;
  const deck = await compile(markdown);
  const files = {
    deck: [resolve(dir, 'deck.html'), deck],
    'single-file': [resolve(dir, 'single-file.html'), injectEmbeddedSource(deck, markdown)],
    classic: [resolve(dir, 'classic.html'), await compile(inClassicLook(markdown))],
  };
  for (const [file, html] of Object.values(files)) writeFileSync(file, html);
  const ids = extractSlides(deck).map((s) => s.id);

  // Default print (the deck's own landscape page), never viewed.
  for (const name of ['deck', 'single-file', 'classic']) {
    const out = await printDeck(browser, files[name][0], { name });
    checkOnePerPage(name, out);
    const [w, h] = pageSize(out.pdf);
    check(w > h, `${name}: the deck prints on landscape pages (${w}x${h})`);
    if (name === 'deck') {
      for (const id of ['tc-long-cycle', 'tc-long-items']) {
        const n = out.texts.findIndex((s) => s.id === id) + 1;
        execFileSync('pdftoppm', ['-f', String(n), '-l', String(n), '-r', '110', '-singlefile', '-png', out.pdf, resolve(dir, `deck-${id}`)]);
      }
    }
  }
  // Every paper size and orientation. The deck asks for landscape (@page), which Chromium honours over
  // the dialog's choice; a browser or user that sets another page size gets it here through @page.
  for (const format of ['A4', 'Letter']) {
    for (const orientation of ['portrait', 'landscape']) {
      const name = `deck-${format}-${orientation}`;
      const out = await printDeck(browser, files.deck[0], { name, beforePrint: (page) => page.addStyleTag({ content: `@page { size: ${format} ${orientation}; }` }) });
      const [w, h] = pageSize(out.pdf);
      const want = format === 'A4' ? [595, 842] : [612, 792];
      check(Math.abs(Math.min(w, h) - want[0]) < 2 && Math.abs(Math.max(w, h) - want[1]) < 2 && (orientation === 'landscape' ? w > h : h > w), `${name}: page is ${format} ${orientation} (${w}x${h})`);
      checkOnePerPage(name, out);
    }
  }
  // Print histories: viewed then left; on screen; a second print with no afterprint.
  checkOnePerPage('deck viewed then left', await printDeck(browser, files.deck[0], { name: 'deck-left', visit: ['tc-long-cycle', 'tc-long-items', ids[0]] }));
  checkOnePerPage('deck on screen', await printDeck(browser, files.deck[0], { name: 'deck-active', visit: ['tc-long-cycle'] }));
  checkOnePerPage('deck printed twice', await printDeck(browser, files.deck[0], { name: 'deck-twice', visit: ['tc-long-items'], beforePrint: (page) => page.evaluate(() => dispatchEvent(new Event('beforeprint'))) }));
  // The presenter window prints the deck (it printed one blank page in 0.44.0).
  checkOnePerPage('presenter route', await printDeck(browser, files.deck[0], { name: 'presenter', suffix: '?presenter=1#tc-long-items' }));

  // Carousels: one page per item, as the handout prints them; notes print under their slide.
  writeFileSync(resolve(dir, 'grey.png'), png(320, 180));
  const carouselMd = carouselOutline('grey.png');
  const carouselFile = resolve(dir, 'carousel.md');
  writeFileSync(carouselFile, carouselMd);
  const carouselDeck = resolve(dir, 'carousel.html');
  writeFileSync(carouselDeck, await compile(carouselMd, carouselFile));
  const car = await printDeck(browser, carouselDeck, { name: 'carousel' });
  const items = await (async () => { const page = await browser.newPage(); try { await page.goto(pathToFileURL(carouselDeck).href); return await page.evaluate(() => [...document.querySelectorAll('.deck > .stage > .slide')].map((s) => s.querySelectorAll('.card-gallery.carousel[data-exclusive] > .card').length)); } finally { await page.close(); } })();
  const expectedCarouselPages = items.reduce((sum, n) => sum + (n >= 2 ? n : 1), 0);
  check(car.pages === expectedCarouselPages, `carousel: ${items.length} slides print on ${expectedCarouselPages} pages, one per carousel item (got ${car.pages})`);
  const allCarouselText = Array.from({ length: car.pages }, (_, i) => pageText(car.pdf, i + 1)).join(' ');
  car.texts.forEach((slide) => {
    const missing = missingWords(slide.text, allCarouselText);
    check(missing.length === 0, `carousel: slide ${slide.id} keeps its text across its pages (missing ${JSON.stringify(missing.slice(0, 8))})`);
  });
  const tall = car.texts.findIndex((s) => s.id === 'tall-car');
  const tallPage = items.slice(0, tall).reduce((sum, n) => sum + (n >= 2 ? n : 1), 0) + 2;
  execFileSync('pdftoppm', ['-f', String(tallPage), '-l', String(tallPage), '-r', '110', '-singlefile', '-png', car.pdf, resolve(dir, 'carousel-tall-item')]);

  // A carousel led by a picture written before its first #### card (drawn as its own first card): every card prints,
  // once, on its own page, and the picture is drawn on its page.
  writeFileSync(resolve(dir, 'lead.png'), png(800, 450));
  const leadMd = ['# Probe', '', '## Section', '', '### Pictures first {id=lead-car}', '{carousel}', '', '![A grey picture](lead.png)', '',
    '#### First card', '', 'The first card words after the picture.', '', '#### Second card', '', 'The second card words at the end.', ''].join('\n');
  const leadFile = resolve(dir, 'lead.md');
  writeFileSync(leadFile, leadMd);
  const leadDeck = resolve(dir, 'lead.html');
  writeFileSync(leadDeck, await compile(leadMd, leadFile));
  const lead = await printDeck(browser, leadDeck, { name: 'lead' });
  // The deck adds its own title, section and closing pages; the carousel's pages are those under its title.
  const leadPages = Array.from({ length: lead.pages }, (_, i) => [i + 1, pageText(lead.pdf, i + 1).replace(/\s+/g, ' ')]).filter(([, text]) => text.includes('Pictures first'));
  check(leadPages.length === 3, `picture-led carousel: its three cards print on three pages (got ${leadPages.length})`);
  for (const words of ['The first card words after the picture.', 'The second card words at the end.']) {
    check(leadPages.filter(([, text]) => text.includes(words)).length === 1, `picture-led carousel: "${words}" prints once`);
  }
  const picturePage = leadPages[0]?.[0] ?? 1;
  const leadImages = execFileSync('pdfimages', ['-f', String(picturePage), '-l', String(picturePage), '-list', lead.pdf], { encoding: 'utf8' }).trim().split('\n').slice(2).length;
  check(leadImages >= 1, `picture-led carousel: the picture is drawn on the first card's page (${leadImages} image(s) on page ${picturePage})`);

  const notesMd = '# Probe\n## Section\n### First point {id=n1}\n\nA visible sentence.\n\n:::notes\nA spoken reminder for the first point.\n:::\n\n### Second point {id=n2}\n\n- One item\n- Another item\n\n:::notes\nA second reminder.\n:::\n';
  const notesFile = resolve(dir, 'notes.md');
  writeFileSync(notesFile, notesMd);
  const notesDeck = resolve(dir, 'notes.html');
  writeFileSync(notesDeck, await compile(notesMd, notesFile));
  const notes = await printDeck(browser, notesDeck, { name: 'notes' });
  checkOnePerPage('notes', notes);
  if (notes.pages === notes.texts.length) {
    const n1 = notes.texts.findIndex((s) => s.id === 'n1') + 1;
    check(/spoken reminder for the first point/.test(pageText(notes.pdf, n1).replace(/\s+/g, ' ')), 'notes: a slide\'s notes print on its page');
    // ... under the slide's 16:9 box, not inside it (8 mm margins on a landscape page).
    const [w] = pageSize(notes.pdf);
    const m = 8 * 72 / 25.4;
    const inSlide = execFileSync('pdftotext', ['-f', String(n1), '-l', String(n1), '-r', '72', '-x', String(Math.round(m)), '-y', String(Math.round(m)), '-W', String(Math.round(w - 2 * m)), '-H', String(Math.round((w - 2 * m) * 9 / 16)), notes.pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    check(/A visible sentence/.test(inSlide) && !/spoken reminder/.test(inSlide), 'notes: the slide keeps its box and its notes print below it');
  }
  const notesRestored = await (async () => { const page = await browser.newPage(); try { await page.goto(pathToFileURL(notesDeck).href); await page.evaluate(() => { dispatchEvent(new Event('beforeprint')); dispatchEvent(new Event('afterprint')); }); return await page.evaluate(() => [...document.querySelectorAll('.deck > .stage > .slide')].filter((s) => s.querySelector(':scope > aside.notes')).length); } finally { await page.close(); } })();
  check(notesRestored === 2, `notes: afterprint puts each slide's notes back inside it (${notesRestored} of 2)`);

  console.log(JSON.stringify({ outputs: Object.keys(files), slides: ids.length, carouselPages: car.pages, failures: failures.length }));
  assert.deepEqual(failures, []);
} finally {
  clearTimeout(hardStop);
  await browser?.close();
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
