import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'
import { readFileSync, writeFileSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { readabilityProbe } from './lib/slide-readability.mjs'
import { setLayoutOption } from '../src/shared/layout-verbs.ts'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'

const repo = resolve(import.meta.dirname, '..')
const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const baseline = option('compiler'), evidence = option('evidence')
const captureOnly = baseline && !process.argv.includes('--verify-baseline')
if (!baseline) writeDeckStyles()
const { prepareSource, adaptMarkdownOutlineV2 } = await import(pathToFileURL(join(baseline || repo, 'compiler/scripts/lib/08-source-adapters.mjs')))
const fixture = join(repo, 'scripts/fixtures/ocean-look/title-clear/outline.md')
let source = readFileSync(fixture, 'utf8')
mkdirSync(join(repo, '.audit-local'), { recursive: true })
const work = mkdtempSync(join(repo, '.audit-local/title-media-'))
if (evidence) mkdirSync(evidence, { recursive: true })
const video = join(work, 'synthetic.mp4')
const generated = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x1275bd:s=320x180:r=1', '-frames:v', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' })
assert.equal(generated.status, 0, `synthetic video fixture: ${generated.stderr}`)
source += `\n### A tiny source without a title\n{media}{notitle}{id=tiny-source}\n\n![](tiny.svg)\n\n### A video below its title\n{image-claim}{id=video}\n\n![](${video})\n\n### A band on a video\n{media}{media-title=overlay}{id=video-overlay}\n\n![](${video})\n`

const url = 'https://researchsnacks.semanticmachines.fyi/2026/11/17/a-long-synthetic-path-for-a-fixture?view=full#details'
let checks = 0

// Deliberately checks the whole title box, rather than just a sampled point on its letters.
function titleGeometry(slide) {
  const stage = slide.getBoundingClientRect()
  const media = [...slide.querySelectorAll('figure img, figure video, figure iframe')].filter(e => !e.closest('.carousel-subslide:not(.active-card)') && getComputedStyle(e).display !== 'none')
  const pictures = media.map(e => e.getBoundingClientRect())
  const outside = pictures.filter(r => r.width > 1 && r.height > 1 && (r.left < stage.left - 1 || r.right > stage.right + 1 || r.top < stage.top - 1 || r.bottom > stage.bottom + 1)).length
  const empty = media.length > 0 && pictures.every(r => r.width < 2 || r.height < 2)
  const cropped = media.filter((element, index) => {
    if (!element.parentElement.matches('.media-stage > figure')) return false
    const frame = element.parentElement.getBoundingClientRect(), r = pictures[index]
    return r.width > 1 && r.height > 1 && (r.left < frame.left - 1 || r.right > frame.right + 1 || r.top < frame.top - 1 || r.bottom > frame.bottom + 1)
  }).length
  let intersections = 0, scrim = true, visible = false
  for (const title of slide.querySelectorAll('.slide-head:not(.slide-head-quiet) > h1')) {
    if (title.closest('.carousel-subslide:not(.active-card)') || getComputedStyle(title).clipPath === 'inset(50%)') continue
    const t = title.getBoundingClientRect(), cs = getComputedStyle(title)
    if (t.width < 2 || t.height < 2) continue
    visible = true
    for (const r of pictures) {
      if (Math.min(r.right, t.right) - Math.max(r.left, t.left) > 1 && Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top) > 1) {
        intersections++
        scrim &&= cs.backgroundColor === 'rgb(21, 32, 43)' && cs.color === 'rgb(255, 255, 255)'
      }
    }
  }
  return { intersections, scrim, visible, outside, empty, cropped, mediaCount: media.length, fillsStage: pictures.some(r => r.width >= stage.width * .95 && r.height >= stage.height * .95) }
}

const entry = LAYOUTS.find(e => e.name === 'media')
assert.equal(entry.options.find(g => g.key === 'media-title').preview, 'thumbs', 'the picker offers compiled thumbnails')
const written = setLayoutOption(source, 'row', 'media-title', 'media-title=overlay')
assert(written.outline.includes('media-title=overlay'), 'the app option verb writes the compiler token')
if (!baseline) {
  const aliases = adaptMarkdownOutlineV2(source.replaceAll('{media}{notitle}', '{media}{title=off}'), 'Media option aliases', {})
  const children = aliases.slides.find(slide => slide.id === 'tiny-carousel').carousel
  assert.equal(children[0].noTitle, true, 'folding preserves the child title=off alias')
  assert.equal(children[1].mediaTitle, 'overlay', 'folding preserves the child media-title option')
  const shown = adaptMarkdownOutlineV2(source.replaceAll('{media}{notitle}', '{media}{notitle}{title=show}'), 'Explicit child title', {})
  assert.equal(shown.slides.find(slide => slide.id === 'tiny-carousel').carousel[0].noTitle, false, 'an explicit visible title still wins over no-title defaults')
}
const browser = await chromium.launch({ headless: true })
try {
  for (const palette of baseline ? ['ocean'] : ['ocean', 'bold', 'classic', 'green']) {
    for (const look of baseline ? ['kicker'] : ['kicker', 'label', 'tab', 'tab-strip', 'plain']) {
      const text = source.replace('title_look: kicker', `title_look: ${look}${palette === 'ocean' ? '' : `\npalette: ${palette}`}`)
      const model = await prepareSource(fixture, text, 'Title and picture', statSync(fixture), undefined, { allowedAssetRoots: [resolve(fixture, '..'), work] })
      const handout = buildShareHtml({ title: 'Title and picture', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'title-media', license: null })
      for (const [output, html] of baseline ? [['deck', model.fullHtml]] : [['deck', model.fullHtml], ['handout', handout]]) {
        const path = join(work, `${palette}-${look}-${output}.html`); writeFileSync(path, html)
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
        await page.goto(pathToFileURL(path).href); await page.evaluate(() => document.fonts.ready)
        await page.addStyleTag({ content: '.footer { display:none!important }' })
        const ids = await page.locator('.stage > .slide').evaluateAll(ss => ss.map(s => s.dataset.id))
        // Thumbnails are deck canvases; a narrow handout opens its separate phone list UI.
        for (const mode of baseline ? ['light'] : output === 'handout' ? ['light', 'dark', 'print'] : ['light', 'dark', 'print', 'thumbnail']) {
          if (mode === 'print') {
            // Printing first builds the app's 1280x720 canvas wrappers, then switches media.
            await page.emulateMedia({ media: 'screen' })
            await page.evaluate(() => dispatchEvent(new Event('beforeprint')))
            await page.emulateMedia({ media: 'print' })
            const frames = page.locator('.stage > .tw-print-canvas > .slide:not(.carousel-print-src)')
            assert(await frames.count() >= ids.length, 'print prepares every slide and each carousel page')
            for (let index = 0; index < await frames.count(); index++) {
              const geometry = await frames.nth(index).evaluate(titleGeometry)
              const where = `${palette}/${look}/${output}/print/page-${index}`
              assert.equal(geometry.outside, 0, `${where}: picture stays inside the printed stage`)
              assert.equal(geometry.cropped, 0, `${where}: the whole picture is contained`)
              assert(!geometry.empty, `${where}: no newly empty media stage`)
              assert(geometry.intersections === 0 || geometry.scrim, `${where}: title intersects picture without a scrim`)
              checks++
            }
            await page.emulateMedia({ media: 'screen' })
            await page.evaluate(() => dispatchEvent(new Event('afterprint')))
            continue
          }
          await page.emulateMedia({ media: mode === 'print' ? 'print' : 'screen' })
          await page.setViewportSize(mode === 'thumbnail' ? { width: 320, height: 180 } : { width: 1920, height: 1080 })
          await page.evaluate(dark => document.querySelector('.deck')?.classList.toggle('is-dark', dark), mode === 'dark')
          for (const id of ids) {
            await page.evaluate(id => { location.hash = id }, id)
            await page.waitForFunction(id => document.querySelector('.stage > .slide.active')?.dataset.id === id, id)
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
            if (evidence && palette === 'ocean' && look === 'kicker' && output === 'deck' && mode === 'light') await page.screenshot({ path: join(evidence, `${id}.png`) })
            if (captureOnly) continue
            const geometry = await page.locator('.stage > .slide.active').evaluate(titleGeometry)
            assert.equal(geometry.outside, 0, `${palette}/${look}/${output}/${mode}/${id}: picture stays inside the stage`)
            assert.equal(geometry.cropped, 0, `${palette}/${look}/${output}/${mode}/${id}: the whole picture is contained`)
            assert(!geometry.empty, `${palette}/${look}/${output}/${mode}/${id}: the media stage is not empty`)
            if (id !== 'qr' && !id.startsWith('section-')) assert(geometry.mediaCount > 0, `${id}: the expected picture or video is rendered`)
            if (['untitled', 'tiny-source'].includes(id)) assert(geometry.fillsStage, `${id}: no title retains the full-stage image fit`)
            if (id === 'tiny-carousel') {
              const childFit = await page.locator('.stage > .slide.active .active-card img').evaluate(image => {
                const frame = image.closest('figure').getBoundingClientRect(), rect = image.getBoundingClientRect()
                return rect.width >= frame.width * .95 && rect.height >= frame.height * .95
              })
              assert(childFit, 'an untitled carousel picture uses the whole child frame')
              await page.keyboard.press('ArrowRight')
              await page.waitForFunction(() => document.querySelector('.stage > .slide.active .active-card')?.dataset.subIndex === '1')
              const overlayChild = await page.locator('.stage > .slide.active').evaluate(titleGeometry)
              assert(overlayChild.scrim && overlayChild.visible && overlayChild.intersections > 0, 'the child overlay option keeps its title on the readable band')
              assert.equal(overlayChild.outside, 0, 'the overlaid child picture stays in its frame')
            }
            assert(geometry.intersections === 0 || geometry.scrim, `${palette}/${look}/${output}/${mode}/${id}: title intersects picture without an opaque scrim`)
            if (id === 'overlay') assert(geometry.scrim && geometry.visible, 'the explicit overlay has a visible, contrast-safe band')
            if (id === 'inline-band') {
              assert.equal(await page.locator('.stage > .slide.active .slide-head em').evaluate(e => getComputedStyle(e).fontStyle), 'italic', 'the title retains authored italic emphasis')
              if (['classic', 'green'].includes(palette)) {
                const marker = await page.locator('.stage > .slide.active .slide-head mark').evaluate(e => ({ ink: getComputedStyle(e).color, fill: getComputedStyle(e).backgroundImage }))
                assert.equal(marker.ink, 'rgb(21, 32, 43)', 'a legacy highlighter keeps dark readable ink on its yellow sweep over the dark title band')
                assert(marker.fill.includes('255, 228, 94'), 'the distinct highlighter sweep remains intact')
              }
            }
            if (mode === 'light' && id !== 'qr') {
              const reading = await page.evaluate(readabilityProbe)
              assert.deepEqual(reading.contrast.filter(r => r.key.startsWith('H1|')), [], `${palette}/${look}/${output}/${mode}/${id}: title contrast`)
            }
            checks++
          }
        }
        if (!baseline && palette === 'ocean' && look === 'kicker') {
          await page.emulateMedia({ media: 'screen' }); await page.setViewportSize({ width: 1920, height: 1080 })
          await page.evaluate(() => { document.querySelector('.deck')?.classList.remove('is-dark'); location.hash = 'qr' })
          await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'qr')
          const link = page.locator('.stage > .slide.active .qr-caption a')
          assert.equal(await link.textContent(), 'researchsnacks.semanticmachines.fyi')
          for (const attribute of ['href', 'title', 'aria-label']) assert.equal(await link.getAttribute(attribute), url)
          await page.locator('.stage > .slide.active .qr-code').click()
          const expanded = output === 'deck' ? page.locator('.qr-fullscreen .qr-fs-url') : page.locator('.lightbox.qr-focus .lightbox-caption')
          await expanded.waitFor({ state: 'visible' })
          assert.equal(await expanded.textContent(), url, `${output}: enlarged QR retains the full address`)
          assert(await expanded.locator('wbr').count() > 3, 'slashes and hyphens are break opportunities')
          const box = await expanded.boundingBox()
          assert(box.y >= 0 && box.y + box.height <= 1081, `${output}: full address fits the enlarged view`)
          if (evidence && output === 'deck') await page.screenshot({ path: join(evidence, 'qr-zoom.png') })
          if (output === 'deck') {
            await page.keyboard.press('Escape'); await page.keyboard.press('z')
            await page.locator('.lightbox.qr-focus.open').waitFor({ state: 'visible' })
            assert.equal(await page.locator('#lightboxCaption').textContent(), url, 'presenter Z gallery retains the full address too')
          }
        }
        await page.close()
      }
    }
  }
  // Quick slides are a separate runtime surface. Their captions use the same formatter,
  // and their existing room/preview views now offer QR enlargement too.
  const instant = await import(pathToFileURL(join(baseline || repo, 'compiler/assets/runtime/instant-slide.js')))
  const { makeQrSvg } = await import('../compiler/scripts/lib/01-cli-utils.mjs')
  const quick = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await quick.setContent('<!doctype html><html><head></head><body></body></html>')
  await quick.addStyleTag({ content: extractStyles(readFileSync(join(repo, 'compiler/assets/templates/presenter-popup-single-html.html'), 'utf8')) + instant.instantSlideStyles })
  await quick.addScriptTag({ content: instant.instantSlideRuntimeSource() })
  await quick.evaluate(({ url, svg }) => {
    window.quickProof = createInstantSlideSurface(document.body, { showQr: true, clickable: false, qr: () => ({ url, svg, link: true }) })
    window.quickProof.show({ kind: 'text', text: 'Keep the route visible while the group decides where to walk.' })
  }, { url, svg: makeQrSvg(url) })
  if (evidence) await quick.screenshot({ path: join(evidence, 'instant-qr.png') })
  if (!captureOnly) {
    assert.equal(await quick.locator('.instant-slide-text').evaluate(e => getComputedStyle(e).fontWeight), '400')
    const caption = quick.locator('.instant-slide-corner-link')
    assert.equal(await caption.textContent(), 'researchsnacks.semanticmachines.fyi')
    for (const attribute of ['title', 'aria-label']) assert.equal(await caption.getAttribute(attribute), url)
    await quick.locator('.instant-qr-enlarge').click()
    assert.equal(await quick.locator('.qr-fullscreen .qr-fs-url').textContent(), url)
    if (evidence) await quick.screenshot({ path: join(evidence, 'instant-qr-zoom.png') })
    await quick.keyboard.press('Escape')
    assert.equal(await quick.locator('.qr-fullscreen').count(), 0, 'Escape closes only the QR view')
    assert(await quick.locator('.instant-slide-surface').isVisible(), 'the quick slide remains in place')
    await quick.evaluate(url => {
      window.quickProof.destroy()
      window.quickProof = createInstantSlideSurface(document.body, { showQr: false, clickable: false })
      window.quickProof.show({ kind: 'link', url, qrSvg: '' })
    }, url)
    assert.equal(await quick.locator('.instant-slide-link').textContent(), url, 'no QR and no live link: show the complete address')
    checks += 4
  }
  await quick.evaluate(() => window.quickProof.destroy())
  await quick.close()
  console.log(captureOnly ? 'CAPTURE baseline title/media fixture' : `PASS title/media: ${checks} layout checks plus full-address presenter and handout QR zoom`)
} finally { await browser.close(); rmSync(work, { recursive: true, force: true }) }
