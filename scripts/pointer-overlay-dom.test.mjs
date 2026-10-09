import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs';
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts';
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs';
const dir = await mkdtemp(join(tmpdir(), 'tw-pointer-'));
const outline = `---
title: Pointer
auto_title_slide: false
auto_thanks_slide: false
---

### Text
{id=text}

- Words on a slide

### Image
{id=image}

![Detail](image.svg)

### Page
{id=page}

[Embed: https://embed.example.test/page]

### End
{id=end}

- End
`;
const path = join(dir, 'pointer.md');
await writeFile(path, outline);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">'
    + '<rect width="600" height="400" fill="#abc"/><circle cx="180" cy="320" r="15" fill="red"/></svg>';
await writeFile(join(dir, 'image.svg'), svg);
const prepared = await prepareSource(path, outline, null, await stat(path), {}, {});
const share = buildShareHtml({ title: 'Pointer', slug: 'pointer', includeNotes: false, license: null,
        styles: '',
        slides: [{ html: '<section class="slide" data-id="text"><h1>Text</h1></section>',
        notes: '' }] });
const server = createServer((req, res) => {
    res.setHeader('content-type', req.url.startsWith('/image.svg') ? 'image/svg+xml' : 'text/html');
    const body = req.url.startsWith('/preview') ? markSlidePreviewHtml(prepared.fullHtml)
        : req.url.startsWith('/share') ? share : req.url.startsWith('/image.svg') ? svg : prepared.fullHtml;
    res.end(body);
});
let browser;
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const [w, h, aw, ah] of [[1280, 800, 1440, 900], [1440, 900, 900, 1000]]) {
        const context = await browser.newContext();
        await context.addInitScript(() => {
            window.__pointerPeerSends = [];
            window.__pointerObservers = [];
            const NativeObserver = window.MutationObserver;
            window.MutationObserver = class extends NativeObserver {
                observe(target, options) {
                    if (target === document.body && options.attributes && options.childList) {
                        this.active = true;
                        if (!window.__pointerObservers.includes(this)) window.__pointerObservers.push(this);
                    }
                    super.observe(target, options);
                }
                disconnect() { this.active = false; super.disconnect(); }
            };
            const Native = window.BroadcastChannel;
            window.BroadcastChannel = class extends Native {
                postMessage(message) {
                    if (message.command === 'pointer') window.__pointerPeerSends.push({ message, at: Date.now() });
                    super.postMessage(message);
                }
            };
        });
        await context.route('https://embed.example.test/page', route => route.fulfill({
            contentType: 'text/html', body: '<html><body><input aria-label="Embedded field"></body></html>'
        }));
        const presenter = await context.newPage(), audience = await context.newPage();
        await presenter.setViewportSize({ width: w, height: h });
        await audience.setViewportSize({ width: aw, height: ah });
        const errors = [];
        for (const p of [presenter, audience])
            p.on('pageerror', e => errors.push(e.message));
        const session = `pointer-${w}`;
        await audience.goto(`${origin}/deck?audience=1&session=${session}`);
        await presenter.goto(`${origin}/deck?presenter=1&session=${session}`);
        await presenter.waitForSelector('#currentPreview iframe');
        const ring = audience.locator('.tw-pointer-ring');
        const gone = async () => {
            await audience.waitForFunction(() => {
                const r = document.querySelector('.tw-pointer-ring');
                return r && getComputedStyle(r).display === 'none';
            }, null, { timeout: 2500 });
        };
        const point = async (space = 'slide') => {
            const rect = await presenter.locator(space === 'image' ? '#lightboxImg' : '#currentPreview iframe').boundingBox();
            await presenter.mouse.move(rect.x + rect.width * .31, rect.y + rect.height * .8);
            await presenter.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .8);
            await audience.waitForFunction(() => {
                const r = document.querySelector('.tw-pointer-ring');
                return r && getComputedStyle(r).display !== 'none';
            });
            await audience.waitForFunction(space => {
                const circle = document.querySelector('.tw-pointer-ring circle');
                const target = document.querySelector(space === 'image' ? '#lightboxImg' : '.stage');
                const a = circle.getBoundingClientRect(), b = target.getBoundingClientRect();
                return Math.abs(a.x + a.width / 2 - b.x - b.width * .3) < 1;
            }, space);
            const actual = await ring.evaluate(el => {
                const circle = el.querySelector('circle[stroke="#ff3b30"]');
                const r = circle.getBoundingClientRect();
                const outer = 1 + Number(circle.getAttribute('stroke-width')) / (2 * Number(circle.getAttribute('r')));
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width * outer, height: r.height * outer };
            });
            assert.ok(Math.abs(actual.width - 46 * Math.min(aw / 1280, ah / 720)) < 1, 'Ring diameter follows the canvas');
            assert.ok(Math.abs(actual.width - actual.height) < 1, 'the Ring stays circular on a non-widescreen image');
            const target = await audience.locator(space === 'image' ? '#lightboxImg' : '.stage').boundingBox();
            assert.ok(Math.abs(actual.x - (target.x + target.width * .3)) < 1, JSON.stringify({ actual, target }));
            assert.ok(Math.abs(actual.y - (target.y + target.height * .8)) < 1, JSON.stringify({ actual, target }));
            const local = await presenter.locator('.tw-pointer-ring circle[stroke="#ff3b30"]').evaluate(el => {
                const box = el.getBoundingClientRect();
                const stroke = Number(el.getAttribute('stroke-width')) / (2 * Number(el.getAttribute('r')));
                return { x: box.x - box.width * stroke / 2, y: box.y - box.height * stroke / 2,
                    width: box.width * (1 + stroke), height: box.height * (1 + stroke) };
            });
            const localScale = space === 'image' ? Math.min(w / 1280, h / 720) : rect.width / 1280;
            assert.ok(Math.abs(local.width - 46 * localScale) < 1, JSON.stringify({ local, localScale, rect, space }));
            assert.ok(Math.abs(local.width - local.height) < 1, 'presenter Ring stays circular');
            assert.ok(Math.abs(local.x + local.width / 2 - (rect.x + rect.width * .3)) < 1);
            assert.ok(Math.abs(local.y + local.height / 2 - (rect.y + rect.height * .8)) < 1);
        };
        await presenter.keyboard.press('i');
        await point();
        for (const selector of ['#presenterBottomBar', '#presenterStatus', '#nextPreview']) {
            const hit = await presenter.locator(selector).evaluate(el => {
                const box = el.getBoundingClientRect();
                return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.tw-live-overlay');
            });
            assert.equal(hit, null, `${selector} is outside Pointer capture`);
        }
        await presenter.keyboard.press('Meta+Shift+p');
        await gone();
        assert.equal(await presenter.locator('.tw-live-overlay').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
        await presenter.locator('#presenterCommandSearch').fill('Next');
        await presenter.locator('#palette-next').click();
        await audience.waitForSelector('.slide.active[data-id=image]');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'true');
        await point();
        await presenter.keyboard.press('ArrowLeft');
        await audience.waitForSelector('.slide.active[data-id=text]');
        await point();
        await presenter.keyboard.press('?');
        await gone();
        await presenter.locator('.tw-shortcuts-row').first().click();
        await presenter.keyboard.press('Escape');
        await point();
        await presenter.click('#navInstant');
        await gone();
        await presenter.mouse.move(w / 2, h / 3);
        await gone();
        await presenter.locator('#instantText').fill('Typed while Pointer stays armed');
        await presenter.keyboard.press('Escape');
        await point();
        await presenter.evaluate(() => { window.__pointerPeerSends = []; });
        await presenter.waitForTimeout(6000);
        const keepAlives = await presenter.evaluate(() => window.__pointerPeerSends);
        assert.ok(keepAlives.length >= 5, 'peer receives resting keep-alives');
        assert.ok(keepAlives.length <= 7, 'peer receives one keep-alive a second');
        await audience.evaluate(() => {
            window.__ringPositionUpdates = 0;
            window.__ringPositionObserver = new MutationObserver(records => {
                window.__ringPositionUpdates += records.length;
            });
            window.__ringPositionObserver.observe(document.querySelector('.tw-pointer-ring'), {
                attributes: true, attributeFilter: ['transform']
            });
        });
        const counts = await presenter.evaluate(async () => {
            window.__pointerPeerSends = [];
            let writes = 0;
            const observer = new MutationObserver(records => { writes += records.length; });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tw-live-pointer'] });
            const overlay = document.querySelector('.tw-live-overlay');
            const box = overlay.getBoundingClientRect();
            const start = performance.now();
            let latestX;
            await new Promise(resolve => {
                let lastMove = 0;
                function move(now) {
                    // Pace input batches at 60 Hz even on this Mac's 120 Hz headless display.
                    if (now - lastMove >= 1000 / 60 - 1) {
                        lastMove = now;
                        for (let i = 0; i < 3; i++) {
                            latestX = .2 + (now - start) / 2000 + i / 1000;
                            overlay.dispatchEvent(new PointerEvent('pointermove', {
                                clientX: box.x + box.width * latestX, clientY: box.y + box.height * .3
                            }));
                        }
                    }
                    if (now - start < 1000) requestAnimationFrame(move); else resolve();
                }
                requestAnimationFrame(move);
            });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            observer.disconnect();
            return { latestX, writes, sends: window.__pointerPeerSends.filter(row => row.message.pointer !== 'gone').length };
        });
        await audience.waitForFunction(x => {
            const red = document.querySelector('.tw-pointer-ring circle');
            const r = red.getBoundingClientRect(), canvas = document.querySelector('.stage').getBoundingClientRect();
            return Math.abs(r.x + r.width / 2 - canvas.x - canvas.width * x) < 1;
        }, counts.latestX);
        counts.projectorUpdates = await audience.evaluate(() => {
            window.__ringPositionObserver.disconnect();
            return window.__ringPositionUpdates;
        });
        assert.ok(counts.sends >= 40, JSON.stringify(counts));
        assert.ok(counts.sends <= 65, 'latest move wins within each 60 Hz input batch');
        assert.ok(counts.projectorUpdates >= 40, JSON.stringify(counts));
        console.log(`PASS Pointer rate: ${counts.projectorUpdates} projector updates, ${counts.writes} live slot writes in 1 s`);
        assert.ok(counts.writes <= 16, JSON.stringify(counts));
        for (const attrs of [{ id: 'twEndLiveBoards', role: 'dialog' },
            { id: 'presenterBoardPanel', role: 'dialog' }, { role: 'dialog' }, { 'aria-modal': 'true' }]) {
            await presenter.evaluate(attrs => {
                const node = document.createElement('div'); node.dataset.pointerProbe = 'true';
                for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
                document.body.append(node);
            }, attrs);
            await gone();
            assert.equal(await presenter.locator('.tw-live-overlay').evaluate(el => el.style.pointerEvents), 'none');
            await presenter.evaluate(() => document.querySelector('[data-pointer-probe]').remove());
            await point();
        }

        // The real board panel element: covering (full) suspends capture, beside the slide does not.
        const overlayEvents = () => presenter.locator('.tw-live-overlay').evaluate(el => el.style.pointerEvents);
        await presenter.evaluate(() => {
            const panel = document.getElementById('presenterBoardPanel');
            panel.dataset.mode = 'beside'; panel.hidden = false;
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.notEqual(await overlayEvents(), 'none', 'a board beside the slide leaves Pointer capturing');
        assert.equal(await ring.isVisible(), true, 'the Ring stays while the board is beside the slide');
        await presenter.evaluate(() => { document.getElementById('presenterBoardPanel').dataset.mode = 'full'; });
        await gone();
        assert.equal(await overlayEvents(), 'none', 'a full-screen board suspends capture');
        await presenter.evaluate(() => { document.getElementById('presenterBoardPanel').hidden = true; });
        await point();
        assert.notEqual(await overlayEvents(), 'none', 'hiding the board resumes capture');
        await presenter.evaluate(() => { document.getElementById('presenterBoardPanel').dataset.mode = 'beside'; });
        console.log('PASS board panel: full-screen suspends Pointer, beside the slide does not');

        assert.equal(await ring.isVisible(), true, 'a resting pointer survives six seconds');
        assert.equal(await presenter.locator('#presenterPointerChip').innerText(), 'Pointer on');
        const nested = await presenter.locator('#currentPreview iframe')
            .evaluate(el => el.contentDocument.querySelector('.tw-live-overlay'));
        assert.equal(nested, null);
        await presenter.mouse.move(0, 0);
        await gone();
        await point();
        await presenter.keyboard.press('Escape');
        await gone();
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        assert.equal(await presenter.evaluate(() => window.__pointerObservers.some(observer => observer.active)), false);
        await presenter.click('#presenterPointer');
        await point();
        await presenter.click('#presenterPointer');
        await gone();
        await presenter.keyboard.press('i');
        await point();
        await presenter.keyboard.press('ArrowRight');
        await gone();
        await audience.waitForSelector('.slide.active[data-id=image]');
        await point();
        await presenter.keyboard.press('z');
        await audience.waitForSelector('#lightbox.open');
        await point('image');
        for (const [iw, ih] of [[300, 1500], [1500, 300], [600, 600]]) {
            const imageSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}"/>`;
            const src = `data:image/svg+xml,${encodeURIComponent(imageSvg)}`;
            for (const page of [presenter, audience]) {
                await page.locator('#lightboxImg').evaluate((el, url) => { el.src = url; }, src);
                await page.waitForFunction(width => document.querySelector('#lightboxImg').naturalWidth === width, iw);
            }
            await point('image');
        }
        await presenter.keyboard.press('Escape');
        await gone();
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('ArrowRight');
        await presenter.waitForSelector('#currentPreview iframe[data-remote-embed]');
        await presenter.keyboard.press('i');
        await presenter.keyboard.press('e');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        assert.equal(await presenter.locator('body').evaluate(el => el.classList.contains('embed-interacting')), true);
        await presenter.click('#presenterPointer');
        assert.equal(await presenter.locator('body').evaluate(el => el.classList.contains('embed-interacting')), false);
        await presenter.click('#presenterMore');
        await presenter.click('#moreEmbed');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        await presenter.click('#presenterPointer');
        await presenter.keyboard.press('ArrowLeft');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('h');
        assert.equal(await presenter.locator('#presenterHighlight').getAttribute('aria-pressed'), 'true');
        await presenter.keyboard.press('i');
        assert.equal(await presenter.locator('#presenterHighlight').getAttribute('aria-pressed'), 'false');
        await presenter.keyboard.press('h');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        await presenter.keyboard.press('i');
        await point();
        await audience.emulateMedia({ media: 'print' });
        assert.equal(await audience.locator('.tw-live-overlay').isVisible(), false);
        const phone = await context.newPage();
        await phone.goto(`${origin}/share`);
        assert.equal(await phone.locator('.tw-live-overlay').count(), 0);
        await phone.goto(`${origin}/preview?audience=1&session=${session}`);
        await phone.keyboard.press('i');
        assert.equal(await phone.locator('.tw-live-overlay').count(), 0, 'thumbnail and editor preview has no live overlay');
        await phone.goto(`${origin}/deck?audience=1&replay=1&session=${session}`);
        assert.equal(await phone.locator('.tw-live-overlay').count(), 0, 'a replay has no Pointer');
        const bar = await presenter.locator('#presenterBottomBar').evaluate(el => ({
            width: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight
        }));
        assert.ok(bar.scroll <= bar.width, JSON.stringify(bar));
        // Command discovery and one real rebind, including persisted dispatch and help parity.
        await audience.emulateMedia({ media: 'screen' });
        await presenter.keyboard.press('Escape');
        await presenter.click('#presenterMenuView');
        await presenter.click('#viewPointer');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'true');
        await presenter.click('#presenterMore');
        await presenter.click('#morePointer');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        await presenter.keyboard.press('Meta+Shift+p');
        await presenter.locator('#presenterCommandSearch').fill('Pointer');
        await presenter.keyboard.press('Enter');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'true');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('Meta+Shift+p');
        await presenter.locator('#presenterCommandSearch').fill('Pointer');
        await presenter.keyboard.press('Meta+Shift+,');
        await presenter.waitForSelector('#presenterRebind');
        const previewHandle = await presenter.locator('#currentPreview iframe').elementHandle();
        const previewFrame = await previewHandle.contentFrame();
        await previewFrame.evaluate(() => {
            const field = document.createElement('input');
            document.body.append(field);
            field.focus();
        });
        await presenter.waitForFunction(() => document.activeElement.id === 'presenterRebind', null, { timeout: 1000 });
        assert.equal(await presenter.evaluate(() => document.activeElement.id), 'presenterRebind');
        await presenter.keyboard.press('Escape');
        await presenter.waitForSelector('#presenterRebind', { state: 'detached' });
        await presenter.keyboard.press('Meta+Shift+,');
        await presenter.waitForSelector('#presenterRebind');
        for (const key of ['h', '1', '0', '-', '=', 'Shift+?', 'Meta+z', 'Space', 'Tab', 'Enter', 'Meta+a', 'Meta+c', 'Meta+w', 'Meta+q', 'Control+c', 'Alt+ArrowLeft',
            'Shift+ArrowRight', 'Shift+Space', 'Shift+PageDown', 'Shift+Enter', 'Delete', 'Shift+Tab']) {
            await presenter.keyboard.press(key);
            assert.match(await presenter.locator('#presenterRebind').innerText(), /already used|reserved/);
        }
        await presenter.keyboard.press('c');
        await presenter.waitForSelector('#presenterRebind', { state: 'detached' });
        assert.equal(await presenter.locator('#palette-pointer').getAttribute('data-keys'), 'C / I');
        await presenter.keyboard.press('Meta+Shift+,');
        await presenter.keyboard.press('y');
        await presenter.waitForSelector('#presenterRebind', { state: 'detached' });
        assert.equal(await presenter.locator('#palette-pointer').getAttribute('data-keys'), 'Y / I');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('i');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'true');
        await presenter.keyboard.press('i');
        await presenter.keyboard.press('c');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        await presenter.keyboard.press('y');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'true');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('?');
        const shortcut = await presenter.locator('.tw-shortcuts-row').filter({ hasText: 'Pointer' }).first().innerText();
        assert.match(shortcut, /Y/);
        await presenter.keyboard.press('Escape');
        await presenter.reload();
        await presenter.keyboard.press('y');
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'true');
        assert.equal(await presenter.locator('#viewPointer .tw-mi-key').innerText(), 'Y / I');
        assert.equal(await presenter.locator('#morePointer .tw-mi-key').innerText(), 'Y / I');
        await presenter.hover('#presenterPointer');
        await presenter.locator('.tw-tip').waitFor({ state: 'visible' });
        assert.match(await presenter.locator('.tw-tip').innerText(), /Pointer: show your mouse on every screen/);
        assert.match(await presenter.locator('.tw-tip').innerText(), /Y/);
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('Meta+Shift+p');
        await presenter.locator('#presenterCommandSearch').fill('Focus mode');
        await presenter.keyboard.press('Meta+Shift+,');
        await presenter.keyboard.press('c');
        await presenter.waitForSelector('#presenterRebind', { state: 'detached' });
        assert.equal(await presenter.locator('#palette-focus').getAttribute('data-keys'), 'C / F');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('c');
        assert.equal(await presenter.locator('#presenterFocus').getAttribute('aria-pressed'), 'true');
        await presenter.keyboard.press('c');
        assert.equal(await presenter.locator('#presenterFocus').getAttribute('aria-pressed'), 'false');
        await presenter.keyboard.press('f');
        assert.equal(await presenter.locator('#presenterFocus').getAttribute('aria-pressed'), 'true');
        await presenter.keyboard.press('f');
        await presenter.keyboard.press('?');
        assert.match(await presenter.locator('.tw-shortcuts-row').filter({ hasText: 'Focus mode' }).innerText(), /C/);
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('k');
        await presenter.locator('#quickPollQuestion').fill('Select this whole question');
        await presenter.keyboard.press('Meta+a');
        assert.equal(await presenter.locator('#quickPollQuestion').evaluate(el => el.selectionEnd - el.selectionStart),
            'Select this whole question'.length);
        assert.equal(await presenter.locator('#presenterPointer').getAttribute('aria-pressed'), 'false');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('Home');
        await presenter.keyboard.press('Meta+Shift+p');
        await presenter.locator('#presenterCommandSearch').fill('Next');
        await presenter.keyboard.press('Meta+Shift+,');
        await presenter.keyboard.press('n');
        assert.equal(await presenter.locator('#palette-next').getAttribute('data-keys'), 'N / → Space ↓ PgDn ↵');
        assert.equal(await presenter.locator('#presenterNext').getAttribute('data-key'), 'N / → Space ↓ PgDn ↵');
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('?');
        assert.match(await presenter.locator('.tw-shortcuts-row').filter({ hasText: 'Next' }).first().innerText(), /N.*Space.*PgDn.*↵/);
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('n');
        await audience.waitForSelector('.slide.active[data-id=image]');
        await presenter.keyboard.press('ArrowRight');
        await audience.waitForSelector('.slide.active[data-id=page]');
        await presenter.keyboard.press('Home');
        await presenter.keyboard.press('Space');
        await audience.waitForSelector('.slide.active[data-id=image]');
        await presenter.keyboard.press('Meta+Shift+p');
        await presenter.locator('#presenterCommandSearch').fill('Next');
        await presenter.keyboard.press('Meta+Shift+,');
        await presenter.getByRole('button', { name: 'Reset to default', exact: true }).click();
        await presenter.keyboard.press('Escape');
        await presenter.keyboard.press('Home');
        await presenter.keyboard.press('n');
        assert.equal(await audience.locator('.slide.active').getAttribute('data-id'), 'text');
        await presenter.keyboard.press('y');
        await point();
        await presenter.reload();
        await gone();
        await presenter.keyboard.press('y');
        await point();
        await presenter.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await gone();
        assert.equal(await presenter.locator('.tw-live-overlay').count(), 0);
        assert.equal(await presenter.evaluate(() => window.__pointerObservers.some(observer => observer.active)), false);
        await presenter.evaluate(() => { window.__pointerPeerSends = []; });
        await presenter.waitForTimeout(1100);
        assert.equal(await presenter.evaluate(() => window.__pointerPeerSends.length), 0, 'pagehide stops timers and frames');
        await presenter.close();
        await gone();
        const silent = await context.newPage();
        silent.on('pageerror', error => errors.push(error.message));
        await silent.addInitScript(() => {
            window.__intervals = [];
            const schedule = window.setInterval.bind(window);
            window.setInterval = (...args) => {
                const id = schedule(...args);
                window.__intervals.push(id);
                return id;
            };
        });
        await silent.goto(`${origin}/deck?presenter=1&session=${session}`);
        await silent.keyboard.press('y');
        const surface = await silent.locator('#currentPreview iframe').boundingBox();
        await silent.mouse.move(surface.x + surface.width * .3, surface.y + surface.height * .8);
        await audience.locator('.tw-pointer-ring').waitFor({ state: 'visible' });
        await silent.evaluate(() => window.__intervals.forEach(id => window.clearInterval(id)));
        await gone();
        await silent.close();
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`PASS Pointer pair ${w}×${h} / ${aw}×${ah}: slide, image, lightbox, clear, modes, print and share`);
    }
}
finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
}
