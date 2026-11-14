// Neutral regression cases for printing (R1, review of PR 358) and late images (R2); outputs stay in
// a git-ignored folder in this worktree. Printing goes through page.pdf() with no media emulation, so
// the browser's own event order applies: beforeprint fires while the screen layout still holds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs';
import { buildShareHtml, injectEmbeddedSource } from '../compiler/scripts/lib/09-output-builders.mjs';

const keep = process.env.FIT_PRINT_OUT;
// FIT_ONLY=print|quote|late|deadline runs one section (used for mutation checks).
const only = process.env.FIT_ONLY;
const runs = (section) => !only || only === section;
const dir = keep ? resolve(keep) : mkdtempSync(resolve('.tw-fit-print-'));
mkdirSync(dir, { recursive: true });
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const hardStop = setTimeout(() => { console.error('test-fit-print-readiness: hard timeout'); process.exit(2); }, 600_000);
const pageCount = (pdf) => Number(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]);
const pageText = (pdf, n, crop = []) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), ...crop, pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
const pageSize = (pdf) => execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }).match(/Page size:\s+([\d.]+) x ([\d.]+)/).slice(1).map(Number);

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const source = resolve('scripts/fixtures/ocean-look/talk-combinations-outline.md');
    const markdown = readFileSync(source, 'utf8');
    const model = await prepareSource(source, markdown, 'Probe', statSync(source), undefined, { allowedAssetRoots: [resolve('scripts/fixtures')] });
    const slides = extractSlides(model.fullHtml);
    const firstId = slides[0].id;
    const outputs = [
        ['handout', buildShareHtml({ title: 'Probe', slug: 'probe', slides, styles: extractStyles(model.fullHtml) })],
        ['deck', model.fullHtml],
        ['single-file', injectEmbeddedSource(model.fullHtml, markdown)],
    ];
    const target = 'tc-long-items';
    for (const [kind, html] of runs('print') ? outputs : []) {
        const file = resolve(dir, kind + '.html');
        writeFileSync(file, html);
        const states = {};
        // never viewed; viewed then left; on screen while printing; a second print without afterprint.
        for (const visit of ['never', 'left', 'active', 'no-afterprint']) {
            const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
            try {
                await page.goto(pathToFileURL(file).href);
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(400);
                if (visit !== 'never') {
                    await page.evaluate(id => { location.hash = id; }, target);
                    await page.waitForTimeout(500);
                    if (visit === 'left') {
                        await page.evaluate(id => { location.hash = id; }, firstId);
                        await page.waitForTimeout(500);
                    }
                }
                const snapshot = (id) => { const walk = e => e.nodeType === 3 ? e.data : [e.nodeName, [...(e.attributes || [])].filter(a => a.name !== 'style' || a.value.trim()).map(a => [a.name, a.value]).sort(), [...e.childNodes].map(walk)]; return walk(document.querySelector(`.slide[data-id="${id}"]`)); };
                const screen = await page.evaluate(snapshot, target);
                const emptyStyles = () => document.querySelectorAll('.stage [style=""]').length;
                const emptyBefore = await page.evaluate(emptyStyles);
                const screenLook = await page.evaluate(id => document.querySelector(`.slide[data-id="${id}"]`).dataset.look, target);
                if (visit === 'no-afterprint')
                    await page.evaluate(() => dispatchEvent(new Event('beforeprint')));
                await page.evaluate(id => addEventListener('beforeprint', () => {
                    const s = document.querySelector(`.slide[data-id="${id}"]`);
                    window.printProbe = { media: matchMedia('print').matches, look: s.dataset.look };
                }), target);
                const pdf = resolve(dir, `${kind}-${visit}.pdf`);
                await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
                const probe = await page.evaluate(() => window.printProbe);
                check(probe && probe.media === false, `${kind}/${visit}: beforeprint ran in the screen layout (real order)`);
                if (screenLook === 'ocean-safe')
                    check(probe.look === 'ocean-safe', `${kind}/${visit}: the screen fallback is kept for print`);
                const endings = await page.evaluate(id => [...document.querySelectorAll(`.slide[data-id="${id}"] li`)].map(e => e.textContent.trim().split(/\s+/).slice(-3).join(' ')), target);
                const title = await page.evaluate(id => document.querySelector(`.slide[data-id="${id}"] h1`).textContent.trim().replace(/\s+/g, ' '), target);
                let found = 0;
                for (let n = 1; n <= pageCount(pdf); n++) if (pageText(pdf, n).includes(title)) found = n;
                check(found > 0, `${kind}/${visit}: printed page found`);
                if (found) {
                    // Text inside the printed slide area only: every page is one 16:9 slide inside 8 mm margins.
                    const [w] = pageSize(pdf);
                    const m = 8 * 72 / 25.4;
                    const crop = ['-x', String(Math.round(m)), '-y', String(Math.round(m)), '-W', String(Math.round(w - 2 * m)), '-H', String(Math.round((w - 2 * m) * 9 / 16))];
                    const visible = pageText(pdf, found, ['-r', '72', ...crop]);
                    const missing = endings.filter(e => !visible.includes(e));
                    check(endings.length === 4 && missing.length === 0, `${kind}/${visit}: every bullet ending prints inside the slide (missing ${JSON.stringify(missing)})`);
                    // The rasterised page, read back: all four bullets are drawn.
                    const png = resolve(dir, `${kind}-${visit}`);
                    execFileSync('pdftoppm', ['-f', String(found), '-l', String(found), '-r', '200', '-singlefile', '-png', pdf, png]);
                    const ocr = execFileSync('tesseract', [png + '.png', '-', '--psm', '3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\s+/g, ' ').toLowerCase();
                    const lastWords = endings.map(e => e.split(' ').slice(-1)[0].replace(/[^\p{L}\p{N}]/gu, '').toLowerCase());
                    const unread = lastWords.filter(word => !ocr.includes(word));
                    check(unread.length === 0, `${kind}/${visit}: rasterised page shows every bullet's last word (unread ${JSON.stringify(unread)})`);
                    states[visit] = { look: probe.look, missing, unread };
                }
                const restored = await page.evaluate(snapshot, target);
                await page.waitForTimeout(300);
                const emptyAfter = await page.evaluate(emptyStyles);
                check(emptyAfter <= emptyBefore, `${kind}/${visit}: print leaves no empty style attributes (${emptyBefore} before, ${emptyAfter} after)`);
                check(JSON.stringify(restored) === JSON.stringify(screen), `${kind}/${visit}: afterprint restores the screen state`);
            } finally {
                await page.close();
            }
        }
        console.log(kind, JSON.stringify(states));
    }

    // Quote forms keep their fitted step on paper (review finding 6). The step starts below what the
    // words need (a compiler underestimate); the screen fit raises it, and print must not lower it.
    if (runs('quote')) {
        const words = Array.from({ length: 70 }, (_, i) => ['neutral', 'sample', 'words', 'for', 'a', 'card'][i % 6]).join(' ');
        const md = `# Probe\n## Section\n### Before {id=qbefore}\n\nA short line.\n\n### Quote {id=qform}\n{quote form=tweet}\n\n> ${words}\n\n- Sample Name (@samplehandle), 1 Jan 2026\n`;
        const p = resolve(dir, 'quote.md');
        writeFileSync(p, md);
        const quote = await prepareSource(p, md, 'Probe', statSync(p));
        const qslides = extractSlides(quote.fullHtml);
        for (const [kind, html] of [['handout', buildShareHtml({ title: 'Probe', slug: 'probe', slides: qslides, styles: extractStyles(quote.fullHtml) })], ['deck', quote.fullHtml]]) {
            const file = resolve(dir, 'quote-' + kind + '.html');
            writeFileSync(file, html.replace(/(<figure class="qf qf-tweet[^"]*") data-step="\d"/, '$1 data-step="1"'));
            for (const visit of ['never', 'left']) {
                const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
                try {
                    await page.goto(pathToFileURL(file).href);
                    await page.evaluate(() => document.fonts.ready);
                    await page.waitForTimeout(300);
                    let screenStep = 1;
                    if (visit === 'left') {
                        await page.evaluate(() => { location.hash = 'qform'; });
                        await page.waitForTimeout(500);
                        screenStep = await page.evaluate(() => Number(document.querySelector('.slide[data-id="qform"] figure.qf').dataset.step));
                        await page.evaluate(() => { location.hash = 'qbefore'; });
                        await page.waitForTimeout(400);
                    }
                    await page.evaluate(() => addEventListener('beforeprint', () => { window.printStep = Number(document.querySelector('.slide[data-id="qform"] figure.qf').dataset.step); }));
                    await page.pdf({ path: resolve(dir, `quote-${kind}-${visit}.pdf`), preferCSSPageSize: true });
                    const printStep = await page.evaluate(() => window.printStep);
                    console.log('quote form', kind, visit, { screenStep, printStep });
                    check(printStep > 1, `quote ${kind}/${visit}: the print pass fits the quote form (step ${printStep})`);
                    check(printStep >= screenStep, `quote ${kind}/${visit}: print keeps the fitted step (${screenStep} → ${printStep})`);
                } finally {
                    await page.close();
                }
            }
        }
    }

    // Late images (R2). The fit must follow from the picture alone: the document has finished loading
    // (fonts.ready and window load already fired), the stage size is held still and the fit count is
    // steady; then a picture on the active slide changes and arrives late. Removing the deck, preview
    // or handout image listener fails this.
    const md = '# Probe\n## Section\n### A picture\n{statement}{id=late}\n\nA neutral sentence beside a picture.\n\n![A rectangle](https://example.invalid/first.svg)\n';
    const p = resolve(dir, 'late.md');
    writeFileSync(p, md);
    const late = await prepareSource(p, md, 'Probe', statSync(p));
    const lateSlides = extractSlides(late.fullHtml);
    // Every fit the runtime asks for: the deck's autofit passes its card preparation (refresh), the preview frames do not.
    const counting = (html) => html.replace(/slideFit\.fitContent\(content(?:, \{ refresh: densifyActiveCards \})?\);/g, (call) => 'window.fitCalls=(window.fitCalls||0)+1;' + call);
    const deckFile = resolve(dir, 'late.html');
    writeFileSync(deckFile, counting(late.fullHtml));
    const handoutFile = resolve(dir, 'late-handout.html');
    writeFileSync(handoutFile, buildShareHtml({ title: 'Probe', slug: 'probe', slides: lateSlides, styles: extractStyles(late.fullHtml) }).replace('if (content) slideFit.fitContent(content);', 'if (content) { window.fitCalls=(window.fitCalls||0)+1; slideFit.fitContent(content); }'));
    const previousId = lateSlides[lateSlides.findIndex(s => s.id === 'late') - 1].id;
    const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`;
    for (const [label, url] of !runs('late') ? [] : [['deck', pathToFileURL(deckFile).href + '#late'], ['presenter current', pathToFileURL(deckFile).href + '?presenter=1#late'], ['presenter next', pathToFileURL(deckFile).href + '?presenter=1#' + previousId], ['handout', pathToFileURL(handoutFile).href + '#late']]) {
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        let release;
        try {
            await page.route('https://example.invalid/first.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: svg(400, 300) }));
            const held = new Promise(r => { release = r; });
            await page.route('https://example.invalid/late.svg', async (route) => { await held; await route.fulfill({ contentType: 'image/svg+xml', body: svg(1200, 2400) }); });
            await page.goto(url, { waitUntil: 'load' });
            await page.evaluate(() => document.fonts.ready);
            // The frame under test: the main document, or a preview frame that shows the picture.
            let frame = null;
            for (let i = 0; i < 20 && !frame; i++) {
                for (const f of (label.startsWith('presenter') ? page.frames().slice(1) : [page.mainFrame()])) {
                    if (await f.evaluate(() => Boolean(document.querySelector('.slide.active img[src*="first.svg"]'))).catch(() => false)) { frame = f; break; }
                }
                if (!frame) await page.waitForTimeout(150);
            }
            check(Boolean(frame), `${label}: a view shows the picture`);
            if (!frame) continue;
            await frame.evaluate(() => new Promise(r => { if (document.readyState === 'complete') r(); else addEventListener('load', r, { once: true }); }));
            await frame.evaluate(() => document.fonts.ready);
            // Wait for the fit count to settle.
            let last = -1, steady = 0;
            for (let i = 0; i < 40 && steady < 4; i++) {
                const n = await frame.evaluate(() => window.fitCalls || 0);
                steady = n === last ? steady + 1 : 0;
                last = n;
                await page.waitForTimeout(150);
            }
            const stage = () => { const r = document.querySelector('.stage').getBoundingClientRect(); return [r.width, r.height].join('x'); };
            const stageBefore = await frame.evaluate(stage);
            await frame.evaluate(() => { document.querySelector('.slide.active img[src*="first.svg"]').src = 'https://example.invalid/late.svg'; });
            await page.waitForTimeout(500);
            const whileHeld = await frame.evaluate(() => window.fitCalls || 0);
            release();
            await frame.waitForFunction(() => document.querySelector('.slide.active img[src*="late.svg"]')?.naturalHeight === 2400, null, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(300);
            const after = await frame.evaluate(() => window.fitCalls || 0);
            check(await frame.evaluate(stage) === stageBefore, `${label}: stage size held still`);
            console.log('late image', label, { steady: last, whileHeld, after });
            check(whileHeld === last, `${label}: nothing refits while the picture is held`);
            check(after > whileHeld, `${label}: the picture's arrival refits the slide`);
        } finally {
            release?.();
            await page.close();
        }
    }

    // Deadline requests from slides already left are dropped, and the deck coalesces its scheduled
    // fit (review finding 5). A hundred slides, each with a picture whose request never answers.
    if (runs('deadline')) {
        const many = '# Probe\n## Section\n' + Array.from({ length: 100 }, (_, i) => `### Picture ${i + 1} {id=pic-${i + 1}}\n\nA neutral sentence beside picture ${i + 1}.\n\n![A shape](https://example.invalid/hang-${i + 1}.svg)\n`).join('\n');
        const mp = resolve(dir, 'many.md');
        writeFileSync(mp, many);
        const manyModel = await prepareSource(mp, many, 'Probe', statSync(mp));
        // Count deadlines as their timers fire, and fit requests as the deck's refit callback receives them.
        const timerHook = 'wait.timer = setTimeout(() => {';
        const refitHook = 'createSlideFit({ refit: () => scheduleAutofit() })';
        check(manyModel.fullHtml.includes(timerHook) && manyModel.fullHtml.includes(refitHook), 'deadline hooks present in the compiled deck');
        const counted = counting(manyModel.fullHtml)
            .replace(timerHook, timerHook + ' window.deadlines = (window.deadlines || 0) + 1;')
            .replace(refitHook, 'createSlideFit({ refit: () => { window.deadlineRefits = (window.deadlineRefits || 0) + 1; scheduleAutofit(); } })');
        const manyFile = resolve(dir, 'many.html');
        writeFileSync(manyFile, counted);
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        try {
            await page.route('https://example.invalid/**', () => new Promise(() => {}));
            await page.goto(pathToFileURL(manyFile).href + '#pic-1', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(500);
            for (let i = 2; i <= 100; i++) { await page.evaluate((h) => { location.hash = h; }, `pic-${i}`); await page.waitForTimeout(60); }
            await page.waitForTimeout(2000);
            const r = await page.evaluate(() => ({ deadlines: window.deadlines || 0, refits: window.deadlineRefits || 0 }));
            console.log('deadline requests while stepping 100 slides', r);
            check(r.deadlines >= 50, `the hanging pictures started deadline waits (${r.deadlines})`);
            check(r.refits <= 1, `only the slide on screen asks for a fit at its deadline (${r.refits} of ${r.deadlines})`);
            // Twenty fit requests in one frame make one fit.
            const before = await page.evaluate(() => window.fitCalls || 0);
            await page.evaluate(() => { for (let i = 0; i < 20; i++) document.fonts.dispatchEvent(new Event('loadingdone')); });
            await page.waitForTimeout(400);
            const after = await page.evaluate(() => window.fitCalls || 0);
            console.log('fits for twenty requests in one frame', after - before);
            check(after - before === 1, `the deck coalesces fit requests (${after - before} fits for 20 requests)`);
            // A stream of requests, one per frame, keeps fitting while it lasts (it never holds the fit off).
            const streamStart = await page.evaluate(() => window.fitCalls || 0);
            await page.evaluate(() => new Promise((done) => { let n = 0; const tick = () => { document.fonts.dispatchEvent(new Event('loadingdone')); if (++n < 30) requestAnimationFrame(tick); else done(); }; requestAnimationFrame(tick); }));
            const during = await page.evaluate(() => window.fitCalls || 0) - streamStart;
            console.log('fits during thirty frames of requests', during);
            check(during >= 5, `a stream of fit requests still fits while it lasts (${during} fits in 30 frames)`);
        } finally {
            await page.close();
        }
    }
    const page = await browser.newPage();
    await page.setContent('<div class="stage"><div class="slide" style="display:none"><div class="slide-content"></div></div></div>');
    await page.addScriptTag({ content: readFileSync('compiler/assets/runtime/slide-fit.js', 'utf8') });
    check(await page.evaluate(() => createSlideFit().fitContent(document.querySelector('.slide-content'))) === null, 'hidden slide remains undecided');
    await page.close();
    assert.deepEqual(failures, []);
}
finally {
    clearTimeout(hardStop);
    await browser?.close();
    if (!keep) rmSync(dir, { recursive: true, force: true });
}
