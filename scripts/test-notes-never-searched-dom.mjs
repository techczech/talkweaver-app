#!/usr/bin/env node
// Speaker notes never reach the audience through the outline search (found in review of ticket 2b, 28 Oct).
// Compiles a fixture talk whose notes hold a sentinel word found nowhere else, then drives the REAL emitted pages in
// Playwright's chromium headless shell (never the real Chrome; PLAYWRIGHT_BROWSERS_PATH picks the install).
//   Audience pages (plain deck, share page with notes, share page without): searching the sentinel gives 0 hits,
//   no "in notes:" text anywhere in the DOM, no page text of the sentinel in the outline list.
//   Presenter view (?presenter=1): the same search hits the slide and quotes "in notes: ...".
//   Carousel child: a child-only hit gets a snippet line and a thumbnail like a top-level hit (audience page).
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, '.tw-2b-check', 'notes-privacy')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const SECRET = 'quokkasentinel'
const ALT_WORD = 'altsentinelzx'
const PIC_WORD = 'picsentinelzx'
const outline = ['---', 'title: Privacy fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Section One', '',
  '### Open {id=p1}', '', '- hello there', '', `:::notes`, `private ${SECRET} reminder`, ':::', '',
  '### Gallery {id=p2 carousel}', '', '#### First card', '', '- plain card text', '',
  '#### Second card', '', '- the narwhalchild detail', '', ''].join('\n')
const outlinePath = join(dir, 'privacy-outline.md')
writeFileSync(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, 'privacy', statSync(outlinePath), undefined, { allowedAssetRoots: [dir] })
// Notes carrying an image alt and a data-picture-text element (a JSON import can put raw html in notes).
const notesHtml = `<aside class="notes"><p>private ${SECRET} reminder</p><img alt="${ALT_WORD}" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><span data-picture-text="${PIC_WORD}">x</span></aside>`
const patched = model.fullHtml.replace(/<aside class="notes"[^>]*>[\s\S]*?<\/aside>/, notesHtml)
assert.notEqual(patched, model.fullHtml, 'fixture: the notes aside was replaced')
model.fullHtml = patched
const deckPath = join(dir, 'deck.html')
writeFileSync(deckPath, model.fullHtml)
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const sharePath = join(dir, 'share.html')
writeFileSync(sharePath, buildShareHtml({ title: 'Privacy fixture', slides, styles, includeNotes: true, slug: 'privacy' }))
const shareNoPath = join(dir, 'share-no-notes.html')
writeFileSync(shareNoPath, buildShareHtml({ title: 'Privacy fixture', slides, styles, includeNotes: false, slug: 'privacy' }))
assert.ok(model.fullHtml.includes(SECRET), 'fixture: the compiled deck carries the notes in its presenter aside')

let checks = 0
const pass = (name) => { checks++; console.log(`PASS ${name}`) }
const browser = await chromium.launch()
try {
  const open = {
    deck: async (page) => { await page.evaluate(() => document.querySelector('#overviewBtn')?.click()); await page.locator('#overviewSearch').waitFor() },
    share: async (page) => { await page.locator('#overviewBtn').click(); await page.locator('#navSearch').waitFor() },
    presenter: async (page) => { await page.locator('#outlineBtn').click(); await page.locator('#presenterSearch').waitFor() },
  }
  async function run(name, url, kind, search, list, expectNotes) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.waitForLoadState('domcontentloaded')
    await open[kind](page)
    await page.locator(search).fill(SECRET)
    const hits = await page.locator(`${list} .slide-link.tw-hit`).count()
    const snippets = await page.locator(`${list} .tw-snippet`).allInnerTexts()
    if (expectNotes) {
      assert.equal(hits, 1, `${name}: presenter finds the notes-only word`)
      assert.ok(snippets.some((t) => t.startsWith('in notes: ') && t.includes(SECRET)), `${name}: quotes "in notes:"`)
      pass(`${name}: notes searched and quoted`)
    } else {
      assert.equal(hits, 0, `${name}: a notes-only word is not a hit`)
      assert.equal(await page.locator(`${list} .tw-hit-detail`).count(), 0, `${name}: no hit detail`)
      assert.equal(snippets.length, 0, `${name}: no snippet line`)
      const listText = await page.locator(list).innerText()
      assert.ok(!listText.includes('in notes:') && !listText.includes(SECRET), `${name}: no "in notes:" text and no notes text in the list`)
      assert.equal(await page.locator(`${list} :text("in notes:")`).count(), 0, `${name}: no "in notes:" node anywhere in the outline`)
      pass(`${name}: notes neither searched nor shown`)
    }
    // Alt text and picture text inside the notes: same invariant.
    for (const word of [ALT_WORD, PIC_WORD]) {
      await page.locator(search).fill(word)
      const h = await page.locator(`${list} .slide-link.tw-hit`).count()
      const sn = await page.locator(`${list} .tw-snippet`).allInnerTexts()
      if (expectNotes) {
        assert.equal(h, 1, `${name}: presenter finds ${word} in the notes`)
        assert.ok(sn.some((t) => t.includes(word)), `${name}: presenter quotes ${word}`)
      } else {
        assert.equal(h, 0, `${name}: ${word} in the notes is not a hit`)
        assert.equal(sn.length, 0, `${name}: no snippet for ${word}`)
        assert.ok(!(await page.locator(list).innerText()).includes(word), `${name}: ${word} absent from the outline text`)
        assert.equal(await page.locator(`${list} :text("in picture:")`).count(), 0, `${name}: no "in picture:" line`)
      }
    }
    pass(`${name}: notes pictures ${expectNotes ? 'searched in presenter' : 'never searched'}`)
    // A carousel child-only hit: snippet line and thumbnail, in every mode.
    await page.locator(search).fill('narwhalchild')
    const childHit = page.locator(`${list} .slide-sublink.tw-hit`)
    assert.equal(await childHit.count(), 1, `${name}: the child is a hit`)
    const det = childHit.locator('xpath=following-sibling::*[1][contains(@class, "tw-hit-detail")]')
    assert.equal(await det.count(), 1, `${name}: child hit has a detail row`)
    assert.match(await det.locator('.tw-snippet').innerText(), /^in text: .*narwhalchild/s, `${name}: child snippet line`)
    assert.equal(await det.locator('.tw-thumb').count(), 1, `${name}: child hit has a thumbnail`)
    assert.equal(await det.locator('.tw-thumb .carousel-subslide.active-card').evaluate((el) => el.dataset.subIndex), '1', `${name}: thumbnail shows the matching child`)
    pass(`${name}: child-only hit carries snippet and thumbnail`)
    assert.deepEqual(errors, [], `${name}: no page errors`)
    await page.close()
  }
  await run('plain deck', pathToFileURL(deckPath).href, 'deck', '#overviewSearch', '#overviewList', false)
  await run('share page with notes', pathToFileURL(sharePath).href, 'share', '#navSearch', '#navList', false)
  await run('share page without notes', pathToFileURL(shareNoPath).href, 'share', '#navSearch', '#navList', false)
  await run('presenter view', `${pathToFileURL(deckPath).href}?presenter=1&session=npriv`, 'presenter', '#presenterSearch', '#presenterOutline', true)
  // Fix round 3: notes holding a carousel child, a heading and a loose sentinel, on a slide with no public heading
  // or nav title. After a public-word search the audience overview DOM (thumbnails included) has no sentinel
  // and no aside.notes; the presenter view still finds the notes.
  const H_WORD = 'headsentinelzx', C_WORD = 'cardsentinelzx', T_WORD = 'thumbsentinelzx'
  const r3Notes = `<aside class="notes"><h2>${H_WORD}</h2><div class="carousel-subslide" data-sub-title="${C_WORD}" data-sub-index="7">${C_WORD} body</div><p>${T_WORD}</p></aside>`
  let r3 = model.fullHtml.replace(/<aside class="notes"[^>]*>[\s\S]*?<\/aside>/, r3Notes)
  r3 = r3.replace(/(<section class="slide" data-id="p1"[^>]*?) data-nav-title="[^"]*"/, '$1').replace(/<header class="slide-head"><h1>Open<\/h1><\/header>/, '')
  assert.ok(!/data-id="p1"[^>]*data-nav-title/.test(r3) && r3.includes(H_WORD), 'fixture r3: no public heading, sentinels in notes')
  const r3Deck = join(dir, 'deck-r3.html')
  writeFileSync(r3Deck, r3)
  const r3Share = join(dir, 'share-r3.html')
  writeFileSync(r3Share, buildShareHtml({ title: 'r3', slides: extractSlides(r3), styles, includeNotes: true, slug: 'r3' }))
  async function r3Run(name, url, kind, search, list) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.waitForLoadState('domcontentloaded')
    await open[kind](page)
    for (const q of ['hello', H_WORD, C_WORD, T_WORD, 'hello']) {
      await page.locator(search).fill(q)
      if (q === 'hello') {
        // expand to the thumbnail grid so thumbnails are in the DOM
        const exp = page.locator('#overviewExpand, #navExpand').first()
        if (await exp.count() && await exp.isVisible()) await exp.click().catch(() => {})
      } else {
        assert.equal(await page.locator(`${list} .slide-link.tw-hit, ${list} .slide-sublink.tw-hit`).count(), 0, `${name}: ${q} is not a hit`)
      }
    }
    await page.locator(search).fill('hello')
    assert.ok(await page.locator(`${list} .slide-link.tw-hit`).count() >= 1, `${name}: the public word hits`)
    const html = await page.evaluate(() => document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, ''))
    const live = await page.evaluate((l) => document.querySelector(l).innerHTML, list)
    for (const w of [H_WORD, C_WORD, T_WORD]) assert.ok(!live.includes(w), `${name}: ${w} absent from the overview DOM`)
    assert.equal(await page.locator(`${list} aside.notes, ${list} .notes`).count(), 0, `${name}: no aside.notes in the overview`)
    assert.equal(await page.locator(`${list} .tw-thumb`).evaluateAll((n) => n.filter((t) => t.querySelector('aside.notes, .carousel-subslide')).length), 0, `${name}: thumbnails carry no notes content`)
    void html
    assert.deepEqual(errors, [], `${name}: no page errors`)
    await page.close()
    pass(`${name}: notes heading, carousel child and sentinel never reach the overview`)
  }
  await r3Run('r3 plain deck', pathToFileURL(r3Deck).href, 'deck', '#overviewSearch', '#overviewList')
  await r3Run('r3 share page', pathToFileURL(r3Share).href, 'share', '#navSearch', '#navList')
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(`${pathToFileURL(r3Deck).href}?presenter=1&session=r3`)
    await open.presenter(page)
    for (const w of [H_WORD, T_WORD]) {
      await page.locator('#presenterSearch').fill(w)
      assert.equal(await page.locator('#presenterOutline .slide-link.tw-hit').count(), 1, `r3 presenter finds ${w} in notes`)
    }
    await page.close()
    pass('r3 presenter view still finds the notes')
  }
} finally {
  await browser.close()
}
console.log(`${checks} checks passed`)
