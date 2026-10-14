// Quote forms, tickets 01 (tweet), 02 (video) and 07 (web page), in a browser (Playwright's chromium headless shell, never the real Chrome):
// the tweet card is over the whole slide at the drawn geometry, quoted words are weight 400, the
// editing-only placeholders show only under .qf-authoring, the runtime steps the words down when the
// real box is taller than the compiler thought, and the plain quote beside it is not touched.
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

writeDeckStyles()
const X = 'https://x.com/techczech/status/1234567890123456789'
const filler = (n) => {
  const base = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ')
  const out = []
  for (let i = 0; out.join(' ').length < n; i += 1) out.push(base[i % base.length])
  return out.join(' ').slice(0, n).replace(/\s\S*$/, '')
}
const md = `# Talk

## Section

### Normal {id=d-normal}
{quote}

> ${filler(200)} **bold typed inside** and more words.

- Dominik Lukeš, 4 Oct 2026, 2:33 PM ${X}

### Mid {id=d-mid}
{quote}

> ${filler(330)}

- Dominik Lukeš, 4 Oct 2026 ${X}

### Awaiting {id=d-awaiting}
{quote}

- https://x.com/i/status/1234567890123456789

### Player {id=v-player}
{quote}

> Sample quotation spoken in a video, with **bold typed inside** it. It runs to two sentences so the design is tested at a realistic length.

- Sample channel, Sample talk title goes here, 12:34 / 48:10 https://www.youtube.com/watch?v=XXXXXXXXXXX

### Panel {id=v-panel}
{quote}

![Speaker on stage](assets/speaker.png)

> Sample quotation spoken in a video, with **bold typed inside** it. It runs to two sentences so the design is tested at a realistic length.

- Sample channel, Sample talk title goes here, 12:34 / 48:10 https://www.youtube.com/watch?v=XXXXXXXXXXX

### Player awaiting {id=v-awaiting}
{quote}

- Sample channel, Sample talk title goes here, 12:34 / 48:10 https://www.youtube.com/watch?v=XXXXXXXXXXX

### Long token {id=d-long}
{quote}

> Look at ${'a1b2c3d4e5'.repeat(9)} for the whole story.

- Dominik Lukeš, 4 Oct 2026 ${X}

### Web window {id=w-win}
{quote form=web}

> Sample quotation from a blog post, with **bold typed inside** it. It runs to two sentences so the design is tested at a realistic length.

- Sample Author, "A sample blog post headline that runs to a second line", *Sample Site*, 3 Sep 2026 https://www.samplesite.example/posts/a-sample-post

### Web panel {id=w-panel}
{quote form=web}

![Screenshot of the post](assets/speaker.png)

> Sample quotation from a blog post. It runs to two sentences so the design is tested at a realistic length.

- Sample Author, "A sample blog post headline that runs to a second line", *Sample Site*, 3 Sep 2026 https://www.samplesite.example/posts/a-sample-post

### Web only link {id=w-only}
{quote form=web}

> Sample quotation from a blog post. It runs to two sentences so the design is tested at a realistic length.

- https://www.samplesite.example/posts/a-sample-post

### Web long tokens {id=w-tokens}
{quote form=web}

> Look at ${'a1b2c3d4e5'.repeat(9)} for the whole story.

- Sample Author, "${'Supercalifragilistic'.repeat(6)}", *${'Antidisestablishment'.repeat(4)}*, 3 Sep 2026 https://www.samplesite.example/${'a'.repeat(160)}

### Web awaiting {id=w-awaiting}
{quote form=web}

- Sample Author, "A sample blog post headline that runs to a second line", *Sample Site*, 3 Sep 2026 https://www.samplesite.example/posts/a-sample-post

### Web long {id=w-long}
{quote form=web}

> ${filler(300)}

- Sample Author, "A sample blog post headline that runs to a second line", *Sample Site*, 3 Sep 2026 https://www.samplesite.example/posts/a-sample-post

### Plain {id=d-plain}
{quote}

> The essence of metaphor is understanding and experiencing one kind of thing in terms of another.

- George Lakoff and Mark Johnson, 1980

### Plain italic source {id=p-italic}
{quote}

> We can only see a short distance ahead, but we can see plenty there that needs to be done.

- A. M. Turing, "Computing Machinery and Intelligence", *Mind* 59 (236), 1950, pp. 433–460, p. 460, doi:10.1093/mind/LIX.236.433

### Plain link source {id=p-link}
{quote}

> We can only see a short distance ahead, but we can see plenty there that needs to be done.

- Dominik Lukeš, **a post** on his blog, 4 Oct 2026 https://www.samplesite.example/posts/a-sample-post

### Plain long source {id=p-longsrc}
{quote}

> We can only see a short distance ahead, but we can see plenty there that needs to be done.

- A. M. Turing, "Computing Machinery and Intelligence", *Mind* 59 (236), 1950, pp. 433–460, reprinted in a long and carefully annotated collected edition, with a long editorial introduction, *Collected Works*, vol. 1, pp. 1–40, doi:10.1093/mind/LIX.236.433
`
const dir = mkdtempSync(join(tmpdir(), 'tw-quote-forms-dom-'))
mkdirSync(join(dir, 'assets'))
writeFileSync(join(dir, 'assets/speaker.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
const path = join(dir, 'dom.md')
writeFileSync(path, md)
const model = await prepareSource(path, md, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
const htmlPath = join(dir, 'dom.html')
const deckHtml = await buildDeckHtmlFromModel(model)
writeFileSync(htmlPath, deckHtml)
// The app's editing previews (thumbnails, the Inspector stage, Slide Focus) are the deck marked by markSlidePreviewHtml.
const previewPath = join(dir, 'dom-preview.html')
writeFileSync(previewPath, markSlidePreviewHtml(deckHtml))

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const tag = `${viewport.width}x${viewport.height}`
    const measure = (id, extra) => page.evaluate(([slideId, authoring]) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((candidate) => candidate.dataset.id === slideId)
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
      slide.classList.toggle('qf-authoring', Boolean(authoring))
      window.__autofitForTest?.()
      const figure = slide.querySelector('figure.qf')
      const slideRect = slide.getBoundingClientRect()
      if (!figure) return { slideRect: slideRect.toJSON() }
      const card = figure.querySelector('.qf-x-card')
      const words = figure.querySelector('.qf-words')
      const strong = figure.querySelector('.qf-words strong')
      const ph = figure.querySelector('.qf-ph-words')
      return {
        slideRect: slideRect.toJSON(),
        figureRect: figure.getBoundingClientRect().toJSON(),
        cardRect: card.getBoundingClientRect().toJSON(),
        wordsScrollWidth: words ? words.scrollWidth : null,
        wordsClientWidth: words ? words.clientWidth : null,
        step: figure.dataset.step,
        wordsWeight: words ? getComputedStyle(words).fontWeight : null,
        wordsSize: words ? parseFloat(getComputedStyle(words).fontSize) : null,
        wordsStyle: words ? getComputedStyle(words).fontStyle : null,
        strongWeight: strong ? getComputedStyle(strong).fontWeight : null,
        strongBackground: strong ? getComputedStyle(strong).backgroundColor : null,
        beforeContent: words ? getComputedStyle(words, '::before').content : null,
        placeholderDisplay: ph ? getComputedStyle(ph).display : null,
        cardBorder: parseFloat(getComputedStyle(card).borderTopWidth),
        iconWidth: parseFloat(getComputedStyle(figure.querySelector('.qf-x-actions .qf-ic')).width),
        slideScale: slideRect.width / slide.offsetWidth
      }
    }, [id, extra])

    const normal = await measure('d-normal')
    const k = normal.slideRect.width / 1920
    const near = (a, b, tolerance, message) => assert(Math.abs(a - b) <= tolerance, `${tag}: ${message} (got ${a}, wanted ${b})`)
    near(normal.figureRect.width, normal.slideRect.width, 1, 'the form is over the whole slide, wide')
    near(normal.figureRect.height, normal.slideRect.height, 1, 'the form is over the whole slide, high')
    near(normal.figureRect.x, normal.slideRect.x, 1, 'the form starts at the slide edge')
    near(normal.cardRect.width, 1380 * k, 2, 'the card is 1380 wide at 1920')
    assert(normal.cardRect.height <= 900 * k + 1, `${tag}: the card fits its 900 limit`)
    near((normal.cardRect.x + normal.cardRect.width / 2), (normal.slideRect.x + normal.slideRect.width / 2), 2, 'the card is centred across')
    near((normal.cardRect.y + normal.cardRect.height / 2), (normal.slideRect.y + normal.slideRect.height / 2), 2, 'the card is centred down')
    assert.equal(normal.step, '2', `${tag}: 200 characters hold the first step`)
    near(normal.wordsSize * normal.slideScale, 57.6 * k, 0.6, 'the words are 57.6 at 1920')
    assert.equal(normal.wordsWeight, '400', `${tag}: quoted words are never bold`)
    assert.equal(normal.wordsStyle, 'normal', `${tag}: no italics`)
    assert.equal(normal.strongWeight, '700', `${tag}: **bold** typed inside is bold only`)
    assert.equal(normal.strongBackground, 'rgba(0, 0, 0, 0)', `${tag}: no accent chip inside the card`)
    assert(['none', 'normal'].includes(normal.beforeContent), `${tag}: no quotation mark device on the card (${normal.beforeContent})`)
    near(normal.cardBorder * normal.slideScale, 3 * k, 0.6, 'the card border is 3 at 1920 (not floored to 1)')
    near(normal.iconWidth * normal.slideScale, 46 * k, 0.6, 'the action icons are 46 at 1920')

    // The compiler estimated step 3 for 330 characters; the runtime keeps it (the real box agrees).
    const mid = await measure('d-mid')
    assert.equal(mid.step, '3', `${tag}: 330 characters step down once`)
    assert(mid.cardRect.height <= 900 * k + 1, `${tag}: the stepped card fits`)

    // The runtime steps down when the compiler's estimate was too generous, and never below step 4.
    const forced = await page.evaluate(() => {
      const slide = [...document.querySelectorAll('.stage > .slide')].find((candidate) => candidate.dataset.id === 'd-mid')
      const figure = slide.querySelector('figure.qf')
      figure.dataset.step = '1'
      window.__autofitForTest?.()
      const after = figure.dataset.step
      figure.querySelector('.qf-words p').textContent = Array.from({ length: 160 }, () => 'overflowing words').join(' ')
      figure.dataset.step = '2'
      window.__autofitForTest?.()
      return { after, floor: figure.dataset.step }
    })
    assert.equal(forced.after, '3', `${tag}: a step-1 guess is brought back to what fits`)
    assert.equal(forced.floor, '4', `${tag}: never below step 4`)

    // Last resort: a card still taller than its box at step 4 is scaled down uniformly from its centre, never below 0.6.
    const scaled = await page.evaluate(() => {
      const slide = [...document.querySelectorAll('.stage > .slide')].find((candidate) => candidate.dataset.id === 'd-mid')
      const figure = slide.querySelector('figure.qf')
      const card = figure.querySelector('.qf-x-card')
      const slideScale = slide.getBoundingClientRect().width / 1920
      const real = card.getBoundingClientRect.bind(card)
      const run = (designHeight) => {
        // The measured height is stubbed in design px (the runtime measures with its own transform cleared).
        card.getBoundingClientRect = () => {
          const rect = real()
          const height = designHeight * slideScale
          return { ...rect.toJSON(), height, top: rect.top, bottom: rect.top + height, toJSON: () => ({}) }
        }
        figure.dataset.step = '4'
        window.__autofitForTest?.()
        return { transform: card.style.transform, attr: figure.dataset.qfScaled ?? null, origin: getComputedStyle(card).transformOrigin, transition: getComputedStyle(card).transitionDuration }
      }
      const mild = run(1200)
      const severe = run(3000)
      const fits = run(800)
      card.getBoundingClientRect = real
      return { mild, severe, fits }
    })
    assert.match(scaled.mild.transform, /scale\(0\.75/, `${tag}: 1200 in a 900 box scales to 0.75`)
    assert.equal(scaled.mild.attr !== null, true, `${tag}: data-qf-scaled is set`)
    assert.match(scaled.severe.transform, /scale\(0\.6\)/, `${tag}: never below 0.6`)
    assert.equal(scaled.fits.transform, '', `${tag}: a card that fits is not scaled`)
    assert.equal(scaled.fits.attr, null, `${tag}: and carries no data-qf-scaled`)
    assert.match(scaled.mild.origin, /^[\d.]+px [\d.]+px/, `${tag}: scaled from its centre`)
    assert(/^0s(, 0s)*$/.test(scaled.mild.transition), `${tag}: no transition on the scale`)

    // Awaiting words: dashed boxes only where the host marks the slide .qf-authoring.
    const presenting = await measure('d-awaiting', false)
    assert.equal(presenting.placeholderDisplay, 'none', `${tag}: presenting shows no placeholder`)
    const editing = await measure('d-awaiting', true)
    assert.equal(editing.placeholderDisplay, 'flex', `${tag}: the editing view shows the dashed boxes`)
    assert(editing.cardRect.height >= 250 * k, `${tag}: the words box is at least 250 high`)

    // Video (ticket 02): the player and the left panel at the drawn geometry.
    const video = (id, authoring = false) => page.evaluate(([slideId, authoringMark]) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((candidate) => candidate.dataset.id === slideId)
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
      slide.classList.toggle('qf-authoring', Boolean(authoringMark))
      window.__autofitForTest?.()
      const rect = (selector) => { const el = slide.querySelector(selector); return el ? el.getBoundingClientRect().toJSON() : null }
      const style = (selector, pseudo) => { const el = slide.querySelector(selector); return el ? getComputedStyle(el, pseudo) : null }
      const slideRect = slide.getBoundingClientRect()
      const figure = slide.querySelector('figure.qf')
      return {
        slideRect: slideRect.toJSON(),
        figureRect: figure.getBoundingClientRect().toJSON(),
        step: figure.dataset.step,
        player: rect('.qf-yt-player'),
        captions: rect('.qf-yt-captions'),
        panel: rect('.qf-panel'),
        picture: rect('.qf-picture'),
        body: rect('.qf-body-in'),
        pictureFit: style('.qf-picture')?.objectFit ?? null,
        wordsWeight: style('.qf-words')?.fontWeight ?? null,
        wordsStyle: style('.qf-words')?.fontStyle ?? null,
        wordsSize: style('.qf-words') ? parseFloat(style('.qf-words').fontSize) : null,
        captionWeight: style('.qf-yt-captions span')?.fontWeight ?? null,
        strongWeight: style('.qf-words strong')?.fontWeight ?? null,
        strongBackground: style('.qf-words strong')?.backgroundColor ?? null,
        sourceRule: style('.qf-source') ? parseFloat(style('.qf-source').borderLeftWidth) : null,
        edge: style('.qf-panel', '::after')?.width ?? null,
        placeholderDisplay: style('.qf-ph-words')?.display ?? null,
        scale: slideRect.width / slide.offsetWidth
      }
    }, [id, authoring])
    const player = await video('v-player')
    near(player.figureRect.width, player.slideRect.width, 1, 'the player form is over the whole slide')
    near(player.player.width, 1320 * k, 2, 'the player is 1320 wide at 1920')
    near(player.player.height, 743 * k, 2, 'the player is 743 high at 1920')
    near(player.player.x + player.player.width / 2, player.slideRect.x + player.slideRect.width / 2, 2, 'the player is centred across')
    assert.equal(player.step, '3', `${tag}: two sentences take caption step 3`)
    near(player.wordsSize * player.scale, 49.92 * k, 0.6, 'the captions are 49.92 at 1920')
    assert.equal(player.wordsWeight, '400', `${tag}: the quoted words are weight 400 (the caption face is 500 on the spans)`)
    assert.equal(player.captionWeight, '500', `${tag}: caption spans are 500`)
    assert.equal(player.wordsStyle, 'normal', `${tag}: no italics`)
    assert.equal(player.strongBackground, 'rgba(0, 0, 0, 0)', `${tag}: **bold** in the captions is bold only, no accent chip`)
    assert.equal(player.strongWeight, '700')
    assert(player.captions.bottom <= player.player.bottom - 190 * k + 2 && player.captions.bottom >= player.player.bottom - 190 * k - 2, `${tag}: captions sit 190 above the foot of the player`)
    const panel = await video('v-panel')
    near(panel.panel.width, 653 * k, 2, 'the panel is 653 wide at 1920')
    near(panel.panel.height, panel.slideRect.height, 2, 'the panel is full height')
    near(panel.panel.x, panel.slideRect.x, 1, 'the panel is at the left edge')
    near(panel.picture.width, panel.panel.width, 1, 'the picture fills the panel')
    assert.equal(panel.pictureFit, 'cover', `${tag}: the picture covers the panel`)
    assert.equal(panel.step, '1')
    near(panel.wordsSize * panel.scale, 65.28 * k, 0.6, 'the words are 65.28 at 1920')
    assert.equal(panel.wordsWeight, '400', `${tag}: words beside the panel are never bold`)
    assert.notEqual(panel.strongBackground, 'rgba(0, 0, 0, 0)', `${tag}: **bold** beside the panel keeps today's accent chip`)
    near(panel.sourceRule * panel.scale, 8 * k, 0.6, 'the accent rule is 8 at 1920')
    assert(panel.body.height <= 864 * k + 1, `${tag}: words and source block fit 864`)
    // The runtime steps the words down when the compiler's estimate was too generous, and never below step 4.
    const forcedVideo = await page.evaluate(() => {
      const run = (id, selector, text) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((candidate) => candidate.dataset.id === id)
        slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
        const figure = slide.querySelector('figure.qf')
        const target = figure.querySelector(selector)
        target.textContent = text
        figure.dataset.step = id === 'v-player' ? '3' : '1'
        window.__autofitForTest?.()
        return figure.dataset.step
      }
      const long = Array.from({ length: 60 }, () => 'overflowing words').join(' ')
      return { player: run('v-player', '.qf-yt-captions span', long), panel: run('v-panel', '.qf-words p', long) }
    })
    assert.equal(forcedVideo.player, '4', `${tag}: the player steps down, never below 4`)
    assert.equal(forcedVideo.panel, '4', `${tag}: the panel steps down, never below 4`)
    const waiting = await video('v-awaiting')
    assert.equal(waiting.placeholderDisplay, 'none', `${tag}: presenting shows no caption placeholder`)
    const waitingEditing = await video('v-awaiting', true)
    assert.equal(waitingEditing.placeholderDisplay, 'flex', `${tag}: the editing view shows the dashed box`)
    assert(waitingEditing.captions.height >= 190 * k - 1, `${tag}: the caption box is at least 190 high`)


    // Web (ticket 07): the browser window and the left panel with an address bar, at the drawn geometry.
    const web = (id, authoring = false) => page.evaluate(([slideId, authoringMark]) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((candidate) => candidate.dataset.id === slideId)
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
      slide.classList.toggle('qf-authoring', Boolean(authoringMark))
      window.__autofitForTest?.()
      const rect = (selector) => { const el = slide.querySelector(selector); return el ? el.getBoundingClientRect().toJSON() : null }
      const style = (selector, pseudo) => { const el = slide.querySelector(selector); return el ? getComputedStyle(el, pseudo) : null }
      const px = (selector, property) => { const cs = style(selector); return cs ? parseFloat(cs[property]) : null }
      const slideRect = slide.getBoundingClientRect()
      const figure = slide.querySelector('figure.qf')
      const words = slide.querySelector('.qf-words')
      return {
        slideRect: slideRect.toJSON(),
        figureRect: figure.getBoundingClientRect().toJSON(),
        step: figure.dataset.step,
        win: rect('.qf-web-win'),
        bar: rect('.qf-web-bar'),
        pill: rect('.qf-web-pill'),
        mast: rect('.qf-web-mast'),
        mark: rect('.qf-web-mark'),
        headline: rect('.qf-web-headline'),
        by: rect('.qf-web-by'),
        avatar: rect('.qf-avatar-xs'),
        words: rect('.qf-words'),
        panel: rect('.qf-panel'),
        picture: rect('.qf-picture'),
        body: rect('.qf-body-in'),
        wordsSize: words ? parseFloat(getComputedStyle(words).fontSize) : null,
        wordsWeight: words ? getComputedStyle(words).fontWeight : null,
        wordsStyle: words ? getComputedStyle(words).fontStyle : null,
        wordsLineHeight: words ? parseFloat(getComputedStyle(words).lineHeight) / parseFloat(getComputedStyle(words).fontSize) : null,
        wordsScrollWidth: words ? words.scrollWidth : null,
        wordsClientWidth: words ? words.clientWidth : null,
        headlineSize: px('.qf-web-headline', 'fontSize'),
        headlineWeight: style('.qf-web-headline')?.fontWeight ?? null,
        headlineLines: (() => { const h = slide.querySelector('.qf-web-headline'); return h ? Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight) / (slideRect.width / slide.offsetWidth)) : null })(),
        siteWeight: style('.qf-web-site')?.fontWeight ?? null,
        siteSize: px('.qf-web-site', 'fontSize'),
        pillSize: px('.qf-web-pill', 'fontSize'),
        pillWeight: style('.qf-web-pill')?.fontWeight ?? null,
        authorWeight: style('.qf-web-by b')?.fontWeight ?? null,
        bylineSize: px('.qf-web-by', 'fontSize'),
        dateWeight: style('.qf-web-by > span:last-child')?.fontWeight ?? null,
        barBackground: style('.qf-web-bar')?.backgroundColor ?? null,
        mastBackground: style('.qf-web-mast')?.backgroundColor ?? null,
        markBackground: style('.qf-web-mark')?.backgroundColor ?? null,
        winRadius: px('.qf-web-win', 'borderTopLeftRadius'),
        winBorder: px('.qf-web-win', 'borderTopWidth'),
        winShadow: style('.qf-web-win')?.boxShadow ?? null,
        panelShadow: style('.qf-panel')?.boxShadow ?? null,
        strongWeight: style('.qf-words strong')?.fontWeight ?? null,
        decoration: [...slide.querySelectorAll('.qf *')].some((el) => getComputedStyle(el).textDecorationLine !== 'none'),
        links: slide.querySelectorAll('a').length,
        overflowHost: (() => { const h = slide.querySelector('.qf-web-host'); return h ? h.scrollWidth <= h.clientWidth + 1 || getComputedStyle(h).textOverflow === 'ellipsis' : null })(),
        placeholderDisplay: style('.qf-ph-words')?.display ?? null,
        scale: slideRect.width / slide.offsetWidth
      }
    }, [id, authoring])
    const win = await web('w-win')
    near(win.figureRect.width, win.slideRect.width, 1, 'the web form is over the whole slide')
    near(win.win.width, 1560 * k, 2, 'the window is 1560 wide at 1920')
    near(win.win.x + win.win.width / 2, win.slideRect.x + win.slideRect.width / 2, 2, 'the window is centred across')
    near(win.win.y + win.win.height / 2, win.slideRect.y + win.slideRect.height / 2, 2, 'the window is centred down')
    assert(win.win.height <= 940 * k + 1, `${tag}: the window fits its 940 limit`)
    near(win.bar.height, 92 * k, 1.5, 'the address bar is 92 high')
    near(win.pill.width, 620 * k, 2, 'the address pill is 620 wide')
    near(win.pill.height, 56 * k, 2, 'the address pill is 56 high')
    near(win.mast.height, 92 * k, 1.5, 'the masthead is 92 high')
    near(win.mark.width, 48 * k, 1, 'the site mark is 48')
    near(win.avatar.width, 48 * k, 1, 'the byline avatar is 48')
    near(win.words.x - win.win.x, 83 * k, 2, 'the words start 80 in (3 border)')
    assert.equal(win.step, '2', `${tag}: two sentences take step 2`)
    near(win.wordsSize * win.scale, 57.6 * k, 0.6, 'the words are 57.6 at 1920')
    near(win.wordsLineHeight, 1.4, 0.01, 'the words are line-height 1.4')
    assert.equal(win.wordsWeight, '400', `${tag}: the quoted words are never bold`)
    assert.equal(win.wordsStyle, 'normal', `${tag}: no italics`)
    assert.equal(win.strongWeight, '700', `${tag}: **bold** typed inside is bold only`)
    near(win.headlineSize * win.scale, 38 * k, 0.5, 'the headline is 38')
    assert.equal(win.headlineWeight, '700', `${tag}: the headline is 700`)
    assert(win.headlineSize < win.wordsSize, `${tag}: the headline is smaller than the words`)
    near(win.siteSize * win.scale, 32 * k, 0.5, 'the site name is 32')
    assert.equal(win.siteWeight, '700', `${tag}: the site name is 700`)
    near(win.pillSize * win.scale, 28 * k, 0.5, 'the address is 28')
    assert.equal(win.pillWeight, '500', `${tag}: the address is 500`)
    near(win.bylineSize * win.scale, 28 * k, 0.5, 'the byline is 28')
    assert.equal(win.authorWeight, '600', `${tag}: the author is 600`)
    assert.equal(win.dateWeight, '400', `${tag}: the date is 400`)
    assert.equal(win.barBackground, 'rgb(233, 236, 239)', `${tag}: the bar is #e9ecef`)
    assert.equal(win.mastBackground, 'rgb(231, 237, 251)', `${tag}: the masthead is the tint of the site mark`)
    assert.equal(win.markBackground, 'rgb(15, 75, 216)', `${tag}: the site mark is #0f4bd8`)
    near(win.winRadius * win.scale, 28 * k, 0.6, 'the window radius is 28')
    near(win.winBorder * win.scale, 3 * k, 0.6, 'the window border is 3 (not floored to 1)')
    assert.notEqual(win.winShadow, 'none', `${tag}: the window has its shadow on stage`)
    assert.equal(win.decoration, false, `${tag}: nothing is underlined on stage`)
    assert.equal(win.links, 0, `${tag}: nothing is a link on stage`)
    assert.equal(win.overflowHost, true, `${tag}: the address fits or is cut with an ellipsis`)
    const webPanel = await web('w-panel')
    near(webPanel.panel.width, 653 * k, 2, 'the web panel is 653 wide')
    near(webPanel.panel.height, webPanel.slideRect.height, 2, 'the web panel is full height')
    near(webPanel.bar.height, 92 * k, 1.5, 'the bar tops the panel at 92')
    near(webPanel.bar.y, webPanel.panel.y, 1.5, 'the bar is at the top of the panel')
    near(webPanel.pill.width, 597 * k, 2, 'the pill fills the bar (597)')
    near(webPanel.picture.y, webPanel.bar.y + webPanel.bar.height, 1.5, 'the picture starts under the bar')
    near(webPanel.picture.height, 988 * k, 2, 'the picture fills the rest of the panel (988)')
    near(webPanel.picture.width, 653 * k, 1.5, 'edge to edge')
    assert.equal(webPanel.step, '1', `${tag}: the panel words are 65.28`)
    assert.equal(webPanel.wordsWeight, '400', `${tag}: words beside the panel are never bold`)
    assert.notEqual(webPanel.panelShadow, 'none', `${tag}: the web panel casts its shadow`)
    assert(webPanel.body.height <= 864 * k + 1, `${tag}: words and source block fit 864`)
    const onlyLink = await web('w-only')
    assert.equal(onlyLink.mast, null, `${tag}: only the link: no masthead`)
    assert.equal(onlyLink.headline, null, `${tag}: and no headline`)
    near(onlyLink.words.y - onlyLink.bar.y - onlyLink.bar.height, 64 * k, 1.5, 'nothing but the bar above the words: 64 clear')
    // Long unbroken tokens wrap inside the words, the headline and the address.
    const tokens = await web('w-tokens')
    assert(tokens.wordsScrollWidth <= tokens.wordsClientWidth, `${tag}: a 90-character token does not run out of the words`)
    assert(tokens.win.x >= tokens.slideRect.x - 1 && tokens.win.x + tokens.win.width <= tokens.slideRect.x + tokens.slideRect.width + 1, `${tag}: the long-token window stays inside the slide across`)
    assert(tokens.win.y >= tokens.slideRect.y - 1 && tokens.win.y + tokens.win.height <= tokens.slideRect.y + tokens.slideRect.height + 1, `${tag}: and down`)
    assert(tokens.headlineLines <= 3, `${tag}: the headline is cut at three lines (${tokens.headlineLines})`)
    assert(tokens.headline.x + tokens.headline.width <= tokens.win.x + tokens.win.width, `${tag}: the headline does not run out of the window`)
    assert(tokens.pill.x + tokens.pill.width <= tokens.bar.x + tokens.bar.width + 1, `${tag}: the address pill does not run out of the bar`)
    // The runtime steps the window's words down when the estimate was generous, and never below step 4.
    const forcedWeb = await page.evaluate(() => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((candidate) => candidate.dataset.id === 'w-long')
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
      const figure = slide.querySelector('figure.qf')
      figure.dataset.step = '2'
      window.__autofitForTest?.()
      const settled = figure.dataset.step
      const height = slide.querySelector('.qf-web-win').getBoundingClientRect().height / (slide.getBoundingClientRect().width / 1920)
      figure.querySelector('.qf-words p').textContent = Array.from({ length: 120 }, () => 'overflowing words').join(' ')
      figure.dataset.step = '2'
      window.__autofitForTest?.()
      return { settled, height, floor: figure.dataset.step }
    })
    assert.equal(forcedWeb.settled, '3', `${tag}: a step-2 guess is brought back to what fits (945 high at 57.6)`)
    assert(forcedWeb.height <= 941, `${tag}: and the window then fits 940 (${forcedWeb.height})`)
    assert.equal(forcedWeb.floor, '4', `${tag}: never below step 4`)
    const webWaiting = await web('w-awaiting')
    assert.equal(webWaiting.placeholderDisplay, 'none', `${tag}: presenting shows no placeholder`)
    assert.equal((await web('w-awaiting', true)).placeholderDisplay, 'flex', `${tag}: the editing view shows the dashed box`)

    // One unbroken token of 90 characters wraps inside the words, as the fit estimate assumes.
    const long = await measure('d-long')
    assert(long.wordsClientWidth > 0, `${tag}: the long-token card has words`)
    assert(long.wordsScrollWidth <= long.wordsClientWidth, `${tag}: a 90-character token does not run out of the words (${long.wordsScrollWidth} > ${long.wordsClientWidth})`)
    assert(long.cardRect.x >= long.slideRect.x - 1 && long.cardRect.x + long.cardRect.width <= long.slideRect.x + long.slideRect.width + 1, `${tag}: the long-token card stays inside the slide across`)
    assert(long.cardRect.y >= long.slideRect.y - 1 && long.cardRect.y + long.cardRect.height <= long.slideRect.y + long.slideRect.height + 1, `${tag}: and down`)

    // The plain quote beside it is untouched.
    const plain = await measure('d-plain')
    assert.equal(plain.figureRect, undefined, `${tag}: a plain quote has no form`)

    // A plain quote's source line is one flowing line: the cite lays out as the accent bar and ONE text
    // container, and an italic word, a bold run or a link shares line boxes with the text around it.
    for (const id of ['p-italic', 'p-link', 'p-longsrc']) {
      const src = await page.evaluate((slideId) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((candidate) => candidate.dataset.id === slideId)
        slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
        window.__autofitForTest?.()
        const cite = slide.querySelector('blockquote cite')
        const text = cite.querySelector(':scope > .cite-text')
        const inline = text.querySelector('em, strong, a')
        const rects = (node) => [...node.getClientRects()].map((r) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: r.left, right: r.right }))
        const textRect = text.getBoundingClientRect()
        // Line count: distinct line tops over every text rect of the container (line pitch is far above 12px).
        const all = document.createRange()
        all.selectNodeContents(text)
        const tops = []
        for (const r of all.getClientRects()) if (!tops.some((t) => Math.abs(t - r.top) < 12) && r.width > 0) tops.push(r.top)
        // The last character before the inline element, and the inline element's first rect.
        const prev = inline.previousSibling
        const lastChar = document.createRange()
        lastChar.setStart(prev, prev.textContent.length - 1)
        lastChar.setEnd(prev, prev.textContent.length)
        const prevRect = lastChar.getBoundingClientRect()
        const inlineRect = inline.getClientRects()[0]
        const barStyle = getComputedStyle(cite, '::before')
        return {
          children: [...cite.children].map((child) => child.className),
          childNodes: [...cite.childNodes].map((node) => node.nodeType),
          textLeft: textRect.left, textRight: textRect.right,
          citeRight: cite.getBoundingClientRect().right,
          lines: tops.length,
          sameLineAsPrevious: Math.abs(inlineRect.top - prevRect.top) < 12 || inlineRect.top > prevRect.top,
          prevRight: prevRect.right, inlineLeft: inlineRect.left, sameRow: Math.abs(prevRect.top - inlineRect.top) < 12,
          bar: { width: barStyle.width, height: barStyle.height, color: barStyle.backgroundColor },
          cursor: getComputedStyle(text).textDecorationLine,
          anchorDecoration: text.querySelector('a') ? getComputedStyle(text.querySelector('a')).textDecorationLine : null
        }
      }, id)
      assert.deepEqual(src.children, ['cite-text'], `${tag} ${id}: the cite's only element child is one text container`)
      assert.deepEqual(src.childNodes, [1], `${tag} ${id}: nothing else sits beside the text container (the bar is a pseudo-element)`)
      assert.equal(src.bar.height, '2px', `${tag} ${id}: the accent bar is unchanged in height`)
      assert(parseFloat(src.bar.width) > 40, `${tag} ${id}: and in width (${src.bar.width})`)
      assert(src.textRight <= src.citeRight + 1, `${tag} ${id}: the text stays inside the cite`)
      // The text is wide (most of the cite), not a squeezed column.
      assert(src.textRight - src.textLeft > 0.5 * (src.citeRight - src.textLeft - 0) , `${tag} ${id}: the text takes the width beside the bar`)
      // One flowing run: the inline element starts where the text before it ends (same row, no column gap),
      // or at the start of the next line when the text wrapped there.
      assert(src.sameRow ? src.inlineLeft - src.prevRight < 20 : src.sameLineAsPrevious, `${tag} ${id}: the inline element follows the text before it (gap ${src.inlineLeft - src.prevRight}px)`)
      if (id === 'p-longsrc') assert(src.lines >= 2, `${tag} ${id}: a long source wraps as text (${src.lines} lines)`)
      else assert(src.lines <= 3, `${tag} ${id}: a source of this length is a few lines at most (${src.lines})`)
      // The text container adds no decoration of its own (a link keeps the underline the browser gave it before this change).
      assert.equal(src.cursor, 'none', `${tag} ${id}: the text container is not underlined`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
{
  // An editing preview shows the dashed boxes without anyone marking the slide; the presented deck does not.
  const browser2 = await chromium.launch({ headless: true })
  try {
    const read = async (file) => {
      const page = await browser2.newPage({ viewport: { width: 1280, height: 720 } })
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
      const value = await page.evaluate(() => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((candidate) => candidate.dataset.id === 'd-awaiting')
        slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
        return getComputedStyle(slide.querySelector('.qf-ph-words')).display
      })
      await page.close()
      return value
    }
    assert.equal(await read(htmlPath), 'none', 'the presented deck shows no placeholder')
    assert.equal(await read(previewPath), 'flex', 'an editing preview document shows the dashed boxes')
  } finally {
    await browser2.close()
  }
}
console.log('quote forms dom: geometry, weight 400, placeholders, runtime step-down (tweet, video and web page) and the plain quote pass')
