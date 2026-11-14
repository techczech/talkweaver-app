// PDF evidence uses only the repository's neutral fixture. Keep it with FIT_PDF_OUT.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const hardStop = setTimeout(() => { console.error('test-fit-print-pdf: hard timeout'); process.exit(2); }, 600_000);
const out = process.env.FIT_PDF_OUT ? resolve(process.env.FIT_PDF_OUT) : mkdtempSync(resolve('.tw-fit-pdf-'));
mkdirSync(out, { recursive: true });
const baseline = resolve(out, 'baseline043');
mkdirSync(baseline, { recursive: true });
let browser;
try {
    execFileSync('tar', ['-x', '-C', baseline], { input: execFileSync('git', ['archive', 'v0.43.0', 'compiler'], { maxBuffer: 64 * 1024 * 1024 }) });
    try {
        symlinkSync(resolve('node_modules'), resolve(baseline, 'node_modules'), 'dir');
    }
    catch (e) {
        if (e.code !== 'EEXIST')
            throw e;
    }
    browser = await chromium.launch({ headless: true });
    const printedPages = {};
    const pdfClips = {};
    let authoredPages;
    for (const [name, root] of [['v043', baseline], ['fixed', resolve('.')]]) {
        const { prepareSource } = await import(pathToFileURL(resolve(root, 'compiler/scripts/lib/08-source-adapters.mjs')));
        const { extractSlides, extractStyles } = await import(pathToFileURL(resolve(root, 'compiler/scripts/lib/04-html-extraction.mjs')));
        const { buildShareHtml } = await import(pathToFileURL(resolve(root, 'compiler/scripts/lib/09-output-builders.mjs')));
        const source = resolve('scripts/fixtures/ocean-look/talk-combinations-outline.md');
        const stats = await prepareSource(source, '---\npalette: classic\n---\n# Probe\n## Section\n### Stats {stats}\n\n- 40 min: the route\n', 'Probe', statSync(source));
        assert(stats.fullHtml.includes(name === 'v043' ? 'class="stat-value">40</span>' : 'class="stat-value">40 min</span>'), name + ' numeric-colon stats exception');
        const model = await prepareSource(source, readFileSync(source, 'utf8'), 'Probe', statSync(source), undefined, { allowedAssetRoots: [resolve('scripts/fixtures')] });
        const slides = extractSlides(model.fullHtml);
        const index = slides.findIndex(s => s.id === 'tc-long-items');
        const html = buildShareHtml({ title: 'Probe', slug: 'probe', slides, styles: extractStyles(model.fullHtml) });
        const file = resolve(out, name + '.html');
        writeFileSync(file, html);
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        if (name === 'fixed')
            authoredPages = await page.locator('.slide').evaluateAll(slides => slides.map(s => s.textContent));
        // No media emulation: page.pdf() fires beforeprint in the screen layout, as a real print does.
        await page.evaluate(() => addEventListener('beforeprint', () => {
            const slide = document.querySelector('.slide[data-id="tc-long-items"]');
            window.printProbe = { print: matchMedia('print').matches, look: slide.dataset.look, styles: [slide, ...slide.querySelectorAll('.slide-content,ul,li')].map(e => ({ tag: e.tagName, style: e.getAttribute('style') })) };
        }));
        const pdf = resolve(out, name + '.pdf');
        await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
        const probe = await page.evaluate(() => window.printProbe);
        console.log(name, JSON.stringify(probe));
        assert.equal(probe.print, false, name + ' beforeprint runs in the screen layout (real event order)');
        const bbox = execFileSync('pdftotext', ['-bbox-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        const margin = 8 * 72 / 25.4;
        pdfClips[name] = [...bbox.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)].map(page => {
            const right = Number(page[1]) - margin, bottom = margin + (Number(page[1]) - 2 * margin) * 9 / 16;
            return [...page[3].matchAll(/<word\s+([^>]+)>/g)].filter(word => {
                const b = Object.fromEntries([...word[1].matchAll(/(xMin|xMax|yMin|yMax)="([\d.-]+)"/g)].map(m => [m[1], Number(m[2])]));
                return b.xMin < margin - 1.5 || b.yMin < margin - 1.5 || b.xMax > right + 1.5 || b.yMax > bottom + 1.5;
            }).length;
        });
        // Locate by the neutral slide's title: 0.43 itself crops the first bullet.
        const target = await page.evaluate(() => document.querySelector('.slide[data-id="tc-long-items"] h1').textContent.trim());
        const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
        const pages = Number(info.match(/Pages:\s+(\d+)/)[1]);
        let found = 0;
        printedPages[name] = [];
        for (let n = 1; n <= pages; n++) {
            const text = execFileSync('pdftotext', ['-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
            printedPages[name].push(text);
            if (text.includes(target.replace(/\s+/g, ' ')))
                found = n;
        }
        assert(found, name + ' contains target');
        execFileSync('pdftoppm', ['-f', String(found), '-l', String(found), '-scale-to', '1600', '-singlefile', '-png', pdf, resolve(out, name + '-long-items')]);
        console.log(name, 'target page', found, 'slide index', index);
        if (name === 'fixed') {
            const text = execFileSync('pdftotext', ['-f', String(found), '-l', String(found), pdf, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
            const endings = await page.evaluate(() => [...document.querySelectorAll('.slide[data-id="tc-long-items"] li')].map(e => e.textContent.trim().split(/\s+/).slice(-5).join(' ')));
            endings.forEach(end => assert(text.includes(end), 'PDF preserves bullet ending: ' + end));
        }
        await page.close();
    }
    const losses = [];
    const words = text => { const counts = new Map(); for (const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
        counts.set(word, (counts.get(word) || 0) + 1); return counts; };
    printedPages.v043.forEach((text, i) => {
        const after = words(printedPages.fixed[i] || '');
        const authored = words(authoredPages[i] || '');
        for (const [word, count] of words(text))
            if (authored.has(word) && (after.get(word) || 0) < Math.min(count, authored.get(word)))
                losses.push({ page: i + 1, word, count, after: after.get(word) || 0 });
    });
    const newlyClipped = pdfClips.fixed.flatMap((n, i) => n > 0 && !pdfClips.v043[i] ? [i + 1] : []);
    writeFileSync(resolve(out, 'pdf-bounds.json'), JSON.stringify({ before: pdfClips.v043, after: pdfClips.fixed, newlyClipped }, null, 2));
    console.log('PDF glyph bounds', JSON.stringify({ before: pdfClips.v043, after: pdfClips.fixed, newlyClipped }));
    assert.deepEqual(newlyClipped, [], 'no fixture PDF page newly clips glyphs against the printed stage');
    writeFileSync(resolve(out, 'word-losses.json'), JSON.stringify(losses, null, 2));
    console.log('0.43 to fixed PDF word losses', JSON.stringify(losses));
    assert.deepEqual(losses, [], 'no authored word printed by 0.43 is lost or split in the fixed fixture');
}
finally {
    clearTimeout(hardStop);
    await browser?.close();
    rmSync(baseline, { recursive: true, force: true });
    if (!process.env.FIT_PDF_OUT)
        rmSync(out, { recursive: true, force: true });
}
