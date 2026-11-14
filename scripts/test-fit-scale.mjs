import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const runtime = readFileSync(process.env.FIT_RUNTIME || 'compiler/assets/runtime/slide-fit.js', 'utf8');
const hardStop = setTimeout(() => { console.error('test-fit-scale: hard timeout'); process.exit(2); }, 300_000);
const browser = await chromium.launch({ headless: true });
try {
    const looks = [];
    for (const scale of [0.25, 1]) {
        const page = await browser.newPage();
        await page.setContent(`<div style="width:1280px;height:720px;transform:scale(${scale});transform-origin:top left"><section class="slide" data-look="ocean" style="width:1280px;height:720px"><div class="slide-content"><div style="height:100px">First block</div><div style="height:100px;margin-top:-6px">Second block</div></div></section></div>`);
        await page.addScriptTag({ content: runtime });
        looks.push(await page.evaluate(() => { createSlideFit().fitContent(document.querySelector('.slide-content')); return document.querySelector('.slide').dataset.look; }));
        await page.close();
    }
    console.log('overlap decisions at .25 and 1', looks);
    assert.deepEqual(looks, ['ocean-safe', 'ocean-safe']);
    // A layout that needs fallback must wait for the image to settle before that decision.
    const page = await browser.newPage();
    let release;
    const held = new Promise(r => release = r);
    await page.route('https://example.invalid/ready.svg', async (route) => { await held; await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }); });
    await page.setContent('<div style="width:1280px;height:720px"><section class="slide" data-look="ocean" style="width:1280px;height:720px"><div class="slide-content"><div style="height:100px">First block</div><div style="height:100px;margin-top:-6px">Second block</div><img src="https://example.invalid/ready.svg"></div></section></div>', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: runtime });
    const fit = () => { window.probeFit ||= createSlideFit(); window.probeFit.fitContent(document.querySelector('.slide-content')); return document.querySelector('.slide').dataset.look; };
    assert.equal(await page.evaluate(fit), 'ocean', 'no permanent fallback with pending image');
    release();
    await page.locator('img').evaluate(img => img.decode());
    assert.equal(await page.evaluate(fit), 'ocean-safe', 'fresh decision after image readiness');
    await page.close();
    // A picture that never arrives must not hold the fallback (review finding 3). Every picture here
    // hangs; the two blocks overlap, so the slide needs the safe drawing.
    const overlapping = (img) => `<div class="stage" style="width:1280px;height:720px;position:relative"><section class="slide" data-look="ocean" style="width:1280px;height:720px;position:absolute;inset:0;overflow:hidden"><div class="slide-content"><div style="height:100px">First block</div><div style="height:100px;margin-top:-6px">Second block</div>${img}</div></section></div>`;
    const hanging = async (page) => page.route('https://example.invalid/hang.svg', () => new Promise(() => {}));
    const lookAfterFit = () => { window.probeFit ||= createSlideFit(); window.probeFit.fitContent(document.querySelector('.slide-content')); return document.querySelector('.slide').dataset.look; };
    for (const [label, img] of [
        ['hidden lazy picture', '<div style="display:none"><img loading="lazy" src="https://example.invalid/hang.svg"></div>'],
        ['lazy picture out of view', '<div style="overflow:hidden;height:10px"><div style="height:3000px"></div><img loading="lazy" src="https://example.invalid/hang.svg"></div>'],
        ['picture with reserved size', '<img width="200" height="100" src="https://example.invalid/hang.svg">'],
    ]) {
        const page = await browser.newPage();
        await hanging(page);
        await page.setContent(overlapping(img), { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: runtime });
        assert.equal(await page.evaluate(() => [...document.images].every(i => !i.complete)), true, label + ' is still loading');
        assert.equal(await page.evaluate(lookAfterFit), 'ocean-safe', label + ' does not hold the fallback');
        await page.close();
    }
    {
        const page = await browser.newPage();
        await hanging(page);
        await page.setContent(overlapping('<img src="https://example.invalid/hang.svg">'), { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: runtime });
        assert.equal(await page.evaluate(lookAfterFit), 'ocean', 'a picture in flight holds the decision briefly');
        // No further fit is requested: the wait ends on its own and decides with the reserved size.
        await page.waitForFunction(() => document.querySelector('.slide').dataset.look === 'ocean-safe', null, { timeout: 4000 });
        await page.close();
    }
    {
        const page = await browser.newPage();
        await hanging(page);
        await page.setContent(overlapping('<img src="https://example.invalid/hang.svg">'), { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: runtime });
        const printed = await page.evaluate(() => {
            const fit = createSlideFit();
            fit.preparePrint();
            const during = document.querySelector('.slide').dataset.look;
            fit.restorePrint();
            return { during, after: document.querySelector('.slide').dataset.look };
        });
        assert.deepEqual(printed, { during: 'ocean-safe', after: 'ocean' }, 'print never waits for a picture, and restores the screen');
        await page.close();
    }
    // A print whose afterprint never came: the next beforeprint starts from the screen state again.
    {
        const page = await browser.newPage();
        await page.setContent(overlapping(''));
        await page.addScriptTag({ content: runtime });
        const states = await page.evaluate(() => {
            const fit = createSlideFit(), slide = document.querySelector('.slide');
            const state = () => slide.outerHTML;
            const screen = state();
            fit.preparePrint();
            const first = state();
            fit.preparePrint();
            const second = state();
            fit.restorePrint();
            return { screen, first, second, restored: state() };
        });
        assert.notEqual(states.first, states.screen, 'print fits the slide');
        assert.equal(states.second, states.first, 'a second beforeprint prepares the same print fit');
        assert.equal(states.restored, states.screen, 'one afterprint restores the screen state');
        await page.close();
    }
    // The second print must fit afresh: content that changed after the first print (with no afterprint
    // between) gets its own decision, and one afterprint still restores the screen decision.
    {
        const page = await browser.newPage();
        await page.setContent('<div class="stage" style="width:1280px;height:720px;position:relative"><section class="slide" data-look="ocean" style="width:1280px;height:720px;position:absolute;inset:0;overflow:hidden"><div class="slide-content"><div style="height:100px">First block</div></div></section></div>');
        await page.addScriptTag({ content: runtime });
        const looks = await page.evaluate(() => {
            const fit = createSlideFit(), slide = document.querySelector('.slide');
            fit.preparePrint();
            const first = slide.dataset.look;
            const block = document.createElement('div');
            block.style.cssText = 'height:100px;margin-top:-6px';
            block.textContent = 'Second block';
            slide.querySelector('.slide-content').appendChild(block);
            fit.preparePrint();
            const second = slide.dataset.look;
            fit.restorePrint();
            return { first, second, restored: slide.dataset.look };
        });
        assert.deepEqual(looks, { first: 'ocean', second: 'ocean-safe', restored: 'ocean' }, 'a second beforeprint without afterprint fits afresh');
        await page.close();
    }
    const live = await browser.newPage();
    await live.setContent('<div class="stage" style="width:1280px;height:720px"><section class="slide" style="width:1280px;height:720px;padding:0;background:red"><div class="slide-content" style="width:100%;height:100%">A neutral line.</div></section></div>');
    await live.addScriptTag({ content: runtime });
    const colours = await live.evaluate(() => {
        const fit = createSlideFit(), slide = document.querySelector('.slide'), content = slide.querySelector('.slide-content');
        fit.fitContent(content);
        slide.style.backgroundColor = 'blue';
        content.firstChild.data = 'A changed neutral line.';
        fit.preparePrint();
        const during = getComputedStyle(slide).backgroundColor;
        const text = content.textContent;
        fit.restorePrint();
        return { during, after: getComputedStyle(slide).backgroundColor, text };
    });
    assert.deepEqual(colours, { during: 'rgb(0, 0, 255)', after: 'rgb(0, 0, 255)', text: 'A changed neutral line.' }, 'print preserves live styles and wording outside fitter ownership');
    await live.close();
}
finally {
    clearTimeout(hardStop);
    await browser.close();
}
