// Real compiler + browser regressions for stage embeds, grid galleries and static conversations.
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(join(root, '.tw-share-display-'))
const failures = []
let checks = 0
const check = (ok, label) => { checks++; if (!ok) failures.push(label); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`) }
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null
let browser
try {
  if (shots) await mkdir(shots, { recursive: true })
  const turns = Array.from({ length: 12 }, (_, i) => `user: Question ${i + 1}: explain the policy and its history in detail.\nmodel-reasoning: Check the policy changes carefully.\nbot: Answer ${i + 1}: the policy changed last month. Here is the full explanation and the reason that the policy was changed.`).join('\n')
  const shell = Array.from({ length: 30 }, (_, i) => `$ command-${i}\nOutput ${i}: completed successfully`).join('\n')
  const md = `---\ntitle: Display regressions\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n` +
    ['hid', 'top', 'ctr'].map((id, i) => `### Embed ${id} {id=${id}}${['{notitle}', '{titletop}', ''][i]}\n\n[Embed: page.html]\n`).join('\n') +
    `\n### Hidden body {id=body}{notitle}\n\nA normal paragraph must remain visible.\n\n### Grid {id=grid}\n{image-grid}\n\n![One](one.svg)\n- First cell\n\n![Two](two.svg)\n- Second cell\n\n### Plain {id=plain}\n\n![One](one.svg)\n\n` +
    [['chat','chat',turns], ['lanes','chat-lanes',turns], ['terminal','terminal',shell], ['agent','terminal-agent',turns]].map(([id, layout, text]) => `### ${id} {id=${id}}\n{${layout}}\n\n\`\`\`${layout.startsWith('terminal') ? 'terminal' : 'chat'}\n${text}\n\`\`\`\n`).join('\n')
  const outline = join(dir, 'outline.md')
  await writeFile(outline, md)
  await writeFile(join(dir, 'page.html'), '<!doctype html><title>Embed fixture</title><p>Full stage embed</p>')
  for (const [name, color] of [['one','green'], ['two','blue']]) await writeFile(join(dir, name + '.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${color}"/></svg>`)
  const model = await prepareSource(outline, md, null, statSync(outline), {}, {})
  const slides = extractSlides(model.fullHtml), styles = extractStyles(model.fullHtml)
  const share = join(dir, 'share.html'), deck = join(dir, 'deck.html')
  await writeFile(share, buildShareHtml({ title: 'Display regressions', slug: 'display-regressions', includeNotes: false, license: null, styles, slides }))
  await writeFile(deck, model.fullHtml)
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const errors = []
  for (const [width,height] of [[1440,900], [390,844]]) {
    const context = await browser.newContext({ viewport: { width,height }, hasTouch: width < 500, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    page.on('pageerror', e => errors.push(e.message))
    const open = async id => { await page.goto('about:blank'); await page.goto(pathToFileURL(share).href + '#' + id); await page.locator(`.slide.active[data-id="${id}"]`).waitFor(); await page.waitForTimeout(250) }
    for (const id of ['hid','top','ctr']) {
      await open(id)
      const r = await page.locator('.slide.active').evaluate(slide => {
        const frame = slide.querySelector('figure.slide-embed iframe').getBoundingClientRect(), stage = slide.getBoundingClientRect()
        return { w: frame.width, h: frame.height, sw: stage.width, sh: stage.height }
      })
      check(id === 'hid' ? r.h / r.sh > .98 && r.w / r.sw > .98 : r.h / r.sh > .6 && r.h / r.sh < .9, `${width}/${id}: stage embed geometry ${JSON.stringify(r)}`)
      if (id === 'hid') {
        await page.locator('.slide.active .embed-interact-chip').click()
        await page.frameLocator('.slide.active figure.slide-embed iframe').locator('p').waitFor()
        await page.locator('#shareEmbedReturn').click()
        check(await page.frameLocator('.slide.active figure.slide-embed iframe').locator('p').isVisible(), `${width}: embed content remains visible after returning to stage`)
        if (shots) await page.screenshot({ path: join(shots, `embed-${width}.png`) })
      }
    }
    await open('body')
    check(await page.locator('.slide.active .content-p').isVisible(), `${width}: hidden-title body remains visible`)
    await open('grid')
    const images = page.locator('.slide.active .image-grid .ig-media img')
    await images.nth(1).click()
    const opened = await page.locator('#lightbox').evaluate(el => el.classList.contains('open'))
    check(opened, `${width}: second grid image opens gallery`)
    if (opened) {
      check((await page.locator('#lightboxCounter').textContent()).trim() === '2 / 2', `${width}: gallery starts at clicked index`)
      check(await page.locator('#lightboxImg').getAttribute('src') === await images.nth(1).getAttribute('src'), `${width}: gallery shows second image`)
      if (width > 500) await page.locator('#lightboxPrev').click()
      else await page.keyboard.press('ArrowLeft')
      check((await page.locator('#lightboxCounter').textContent()).trim() === '1 / 2', `${width}: previous reaches first image`)
      check(await page.locator('#lightboxImg').getAttribute('src') === await images.first().getAttribute('src'), `${width}: gallery preserves grid order`)
      await page.keyboard.press('ArrowRight')
      check((await page.locator('#lightboxCounter').textContent()).trim() === '2 / 2', `${width}: next returns to second image`)
      if (width > 500) {
        await page.locator('#lightboxClose').click()
        check(!await page.locator('#lightbox').isVisible(), `${width}: close button dismisses gallery`)
        await images.nth(1).click()
      }
      await page.keyboard.press('Escape')
      check(!await page.locator('#lightbox').isVisible(), `${width}: Escape closes gallery`)
    }
    await page.locator('#myNotesBtn').click()
    // The drawer can cover the right-hand grid cell on a phone; use the exposed first cell.
    await images.first().click({ force: true })
    check(!await page.locator('#lightbox').isVisible(), `${width}: notes mode keeps gallery closed`)
    check((await page.locator('#myNotesBody').textContent()).includes('One'), `${width}: notes mode anchors the grid image`)
    await open('plain')
    await page.locator('.slide.active figure.slide-figure img').click()
    check(await page.locator('#lightbox').isVisible(), `${width}: ordinary image gallery still opens`)
    for (const id of ['chat','lanes','terminal','agent']) {
      await open(id)
      const scroll = page.locator('.slide.active .sim-scroll')
      check(await scroll.evaluate(el => el.scrollHeight > el.clientHeight), `${width}/${id}: fixture overflows`)
      check(await scroll.evaluate(el => el.scrollTop === 0), `${width}/${id}: arrival anchors newest content`)
      const box = await scroll.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, -300)
      const moved = await page.waitForFunction(() => document.querySelector('.slide.active .sim-scroll').scrollTop < -10, null, { timeout: 1500 }).then(() => true).catch(() => false)
      check(moved, `${width}/${id}: real wheel reaches earlier content`)
      check(await page.locator(`.slide.active[data-id="${id}"]`).count() === 1, `${width}/${id}: scroll preserves slide`)
      if (width < 500 && id === 'chat') {
        await scroll.evaluate(el => { el.scrollTop = 0 })
        const cdp = await context.newCDPSession(page)
        const x = box.x + box.width / 2, y = box.y + box.height / 3
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x,y }] })
        for (let i = 1; i <= 8; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * box.height / 20 }] })
          await page.waitForTimeout(25)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        check(await scroll.evaluate(el => el.scrollTop < -10), 'phone/chat: touch gesture reaches earlier messages')
        check(await page.locator('.slide.active[data-id="chat"]').count() === 1, 'phone/chat: touch preserves slide')
        await cdp.detach()
      }
      if (shots && id === 'chat') await page.screenshot({ path: join(shots, `chat-${width}.png`) })
      await page.emulateMedia({ media: 'print' })
      check(await scroll.evaluate(el => getComputedStyle(el).overflowY === 'hidden'), `${width}/${id}: print retains static overflow`)
      await page.emulateMedia({ media: 'screen' })
    }
    // The app's compiled deck surface and presenter audience use the same generated stage CSS.
    await page.goto(pathToFileURL(deck).href + '#hid')
    await page.locator('.slide.active[data-id="hid"] iframe').waitFor()
    const deckFill = await page.locator('.slide.active').evaluate(el => el.querySelector('iframe').getBoundingClientRect().height / el.getBoundingClientRect().height)
    check(deckFill > .98, `${width}: compiled deck hidden-title embed fills stage`)
    // FixedDeckPreview gives the editor a physical 1280 x 720 iframe, independent of its scale.
    await page.setContent(`<iframe width="1280" height="720" src="${pathToFileURL(deck).href}#hid"></iframe>`)
    const preview = page.frameLocator('iframe').locator('.slide.active[data-id="hid"]')
    await preview.waitFor()
    check(await preview.evaluate(el => el.querySelector('iframe').getBoundingClientRect().height / el.getBoundingClientRect().height > .98), `${width}: editor fixed viewport fills hidden-title stage`)
    await page.goto(pathToFileURL(deck).href + '?presenter=1#hid')
    const current = page.frameLocator('#currentPreview iframe').first().locator('.slide[data-id="hid"]')
    await current.waitFor()
    check(await current.evaluate(el => el.querySelector('iframe').getBoundingClientRect().height / el.getBoundingClientRect().height > .98), `${width}: presenter Current preview fills hidden-title stage`)
    await context.close()
  }
  check(errors.length === 0, `no browser exceptions: ${errors.join('; ')}`)
} finally {
  await browser?.close()
  await rm(dir, { recursive: true, force: true })
}
console.log(`${checks - failures.length}/${checks} checks passed`)
assert.deepEqual(failures, [])
