// =============================================================================
// test:image-claim-links — 0.41 ticket 12 (ADR-0039: each claim box is joined to the picture by a line that touches
// both, head on the picture; drawing after/21-image-claim.html)
//
// Measured in Chromium on the 1280 x 720 stage at two window sizes (rects are divided by the stage scale, so a pixel
// is a canvas pixel), after the deck's own fit pass (window.__autofitForTest, which runs runtime/slide-fit.js). The
// link's two ends are read from two 0 x 0 probes the test puts inside it (left and right, at mid-height), so a
// rotated link is measured where it paints. For every claim of an {image-claim} slide:
//   1. the link's shaft starts on the claim box's outer left border at the box's mid-height (within 1 px);
//   2. the arrowhead's tip lands on the picture's outer right border (within 1 px; 2 px for an angled link) at
//      y = clamp(picture top + 24/1920 of the stage, box mid, picture bottom - the same);
//   3. a claim whose mid-height lies inside that range keeps a horizontal link (angle 0, no runtime properties);
//      one beyond it is angled, and its head turns with the shaft (the svg is a child of the link);
//   4. the arrowhead is whole (the svg lies inside the link's box and is not clipped).
// Also: the boxes sit to the right of the picture, the whole block sits inside the stage, and a plain claim count of
// two, three and four, a wide short picture, and a very short wide picture with claims above and below it, all
// hold; a resize re-runs the pass; with no script every link stays horizontal. The share page (handout, venue
// screen) runs the same pass and is measured on the very short picture.
// =============================================================================

import { strict as assert } from 'node:assert'
import { copyFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'tw-image-claim-'))
copyFileSync(join(repo, 'scripts/fixtures/layout/sample-image.png'), join(dir, 'tall.png'))
await sharp({ create: { width: 2000, height: 800, channels: 3, background: '#3a6b9c' } }).png().toFile(join(dir, 'wide.png'))
// 2000 x 300: on the stage it is about 666 x 100 canvas px, shorter than a column of three claims, so the first and
// last claims' mid-heights fall above and below it and the middle one stays level with it.
await sharp({ create: { width: 2000, height: 300, channels: 3, background: '#6b3a9c' } }).png().toFile(join(dir, 'strip.png'))

const SOURCE = [
  '---', 'title: Claims', '---', '# Deck', '## Section', '',
  '### Two claims', '{image-claim}', '', '![sample](tall.png)', '', '- Simpler harness', '- More tools', '',
  '### Three claims', '{image-claim}', '', '![sample](tall.png)', '', '- Simpler harness', '- Shorter system prompt', '- More tools', '',
  '### Four claims', '{image-claim}', '', '![sample](tall.png)', '', '- Simpler harness', '- Shorter system prompt', '- More tools', '- Fewer rules', '',
  '### Wide picture', '{image-claim}', '', '![wide](wide.png)', '', '- Simpler harness', '- Shorter system prompt', '- More tools', '',
  '### Long claims', '{image-claim}', '', '![sample](tall.png)', '',
  '- A harness that does much less than it used to do, on purpose', '- A system prompt a tenth of the length it was a year ago', '- More tools, each one doing one thing', '',
  '### Strip picture', '{image-claim}', '', '![strip](strip.png)', '', '- Simpler harness', '- Shorter system prompt', '- More tools', '',
  '### Strip picture five', '{image-claim}', '', '![strip](strip.png)', '', '- Simpler harness', '- Shorter system prompt', '- More tools', '- Fewer rules', '- Less code', ''
].join('\n')

const path = join(dir, 'claims.md')
writeFileSync(path, SOURCE, 'utf8')
const model = await prepareSource(path, SOURCE, 'claims', statSync(path), undefined, { allowedAssetRoots: [dir] })
const deckPath = join(dir, 'claims.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')

const TOL = 1
const ANGLED_TOL = 2
let checks = 0
function check(condition, label) {
  checks += 1
  assert.ok(condition, label)
}
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol

// Runs in the page: the geometry of one slide's picture and claims, in canvas px of the slide's stage.
function measureSlide(slide) {
  const stageEl = slide.parentElement
  const sr = stageEl.getBoundingClientRect()
  const k = sr.width / stageEl.offsetWidth
  const C = (el) => {
    const r = el.getBoundingClientRect()
    return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k }
  }
  const P = (el) => {
    const r = el.getBoundingClientRect()
    return { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k }
  }
  const probe = (link, side) => {
    let el = link.querySelector(`:scope > [data-test-probe="${side}"]`)
    if (!el) {
      el = document.createElement('i')
      el.dataset.testProbe = side
      el.style.cssText = `position:absolute;top:50%;${side}:0;width:0;height:0;display:block`
      link.appendChild(el)
    }
    return P(el)
  }
  const picture = slide.querySelector('.evidence-layout > figure.slide-figure')
  return {
    stage: { width: stageEl.offsetWidth, height: stageEl.offsetHeight },
    picture: picture ? C(picture) : null,
    claims: [...slide.querySelectorAll('.evidence-layout > .callouts > li')].map((li) => {
      const link = li.querySelector(':scope > .ic-link')
      const svg = link?.querySelector('svg')
      return {
        box: C(li),
        link: link ? C(link) : null,
        start: link ? probe(link, 'right') : null,
        tip: link ? probe(link, 'left') : null,
        angle: link?.style.getPropertyValue('--ic-angle') || '',
        stretch: link?.style.getPropertyValue('--ic-stretch') || '',
        svgInLink: Boolean(svg && svg.parentElement === link),
        svgWidth: svg ? parseFloat(getComputedStyle(svg).width) : 0,
        linkWidth: link ? parseFloat(getComputedStyle(link).width) : 0,
        svgOverflow: svg ? getComputedStyle(svg).overflow : null
      }
    })
  }
}

// Asserts one measured slide; `angled` is the set of claim indexes expected to be angled (null: work it out).
function assertSlide(m, label, count, expectAngled) {
  assert.ok(m.picture, `${label}: the picture renders`)
  assert.equal(m.claims.length, count, `${label}: ${count} claims`)
  const reach = m.stage.width * 24 / 1920
  const angledSeen = []
  m.claims.forEach((claim, i) => {
    const at = `${label}: claim ${i + 1}`
    check(claim.link, `${at} carries a link`)
    const mid = (claim.box.top + claim.box.bottom) / 2
    const y2 = Math.max(m.picture.top + reach, Math.min(m.picture.bottom - reach, mid))
    const level = Math.abs(y2 - mid) < 0.5
    const tol = level ? TOL : ANGLED_TOL
    if (!level) angledSeen.push(i)
    // 1. the shaft starts on the box's left border at its mid-height
    check(near(claim.start.x, claim.box.left), `${at}: shaft starts on the box's left border (${claim.start.x.toFixed(2)} vs ${claim.box.left.toFixed(2)})`)
    check(near(claim.start.y, mid), `${at}: shaft starts at the box's mid-height (${claim.start.y.toFixed(2)} vs ${mid.toFixed(2)})`)
    // 2. the tip lands on the picture's right border at the clamped height
    check(near(claim.tip.x, m.picture.right, tol), `${at}: tip on the picture's right border (${claim.tip.x.toFixed(2)} vs ${m.picture.right.toFixed(2)})`)
    check(near(claim.tip.y, y2, tol), `${at}: tip at y ${y2.toFixed(2)} (${claim.tip.y.toFixed(2)})`)
    check(claim.tip.y >= m.picture.top + reach - tol && claim.tip.y <= m.picture.bottom - reach + tol, `${at}: tip inside the picture's reach band (${claim.tip.y.toFixed(1)} in ${(m.picture.top + reach).toFixed(1)}..${(m.picture.bottom - reach).toFixed(1)})`)
    if (level) {
      // 3a. level with the picture: the stylesheet's horizontal link, untouched
      check(claim.angle === '' && claim.stretch === '', `${at}: a level claim keeps the horizontal link (angle '${claim.angle}', stretch '${claim.stretch}')`)
      check(near(claim.tip.y, claim.start.y, 0.25), `${at}: the link is horizontal`)
      check(near(claim.link.right, claim.box.left), `${at}: link box ends on the box's left border`)
      check(near(claim.link.left, m.picture.right), `${at}: link box starts on the picture's right border`)
    } else {
      // 3b. beyond it: angled, the head along the shaft
      const deg = parseFloat(claim.angle)
      const expected = Math.atan2(-(y2 - mid), claim.box.left - m.picture.right) * 180 / Math.PI
      check(Number.isFinite(deg) && Math.abs(deg) > 0.5, `${at}: an out-of-range claim is angled (${claim.angle})`)
      check(Math.abs(deg - expected) < 0.5, `${at}: angle ${deg.toFixed(2)} follows the line (${expected.toFixed(2)})`)
      check(Math.sign(deg) === (mid < m.picture.top + reach ? -1 : 1), `${at}: angled toward the picture (a claim above turns its tip down, below up)`)
      check(claim.svgInLink, `${at}: the head turns with the shaft`)
    }
    // 4. the head is whole
    check(claim.svgWidth > 0 && claim.svgWidth <= claim.linkWidth, `${at}: arrowhead is whole (svg inside the link)`)
    check(claim.svgOverflow === 'visible', `${at}: arrowhead svg is not clipped`)
    check(claim.box.left > m.picture.right, `${at}: the box is right of the picture`)
    check(claim.box.right <= m.stage.width + TOL && claim.box.top >= -TOL && claim.box.bottom <= m.stage.height + TOL, `${at}: the box is inside the stage`)
  })
  check(m.picture.left >= -TOL && m.picture.top >= -TOL && m.picture.bottom <= m.stage.height + TOL, `${label}: the picture is inside the stage`)
  if (expectAngled) assert.deepEqual(angledSeen, expectAngled, `${label}: angled claims ${JSON.stringify(angledSeen)}, expected ${JSON.stringify(expectAngled)}`)
  return angledSeen
}

const SLIDES = [
  ['Two claims', 2, []], ['Three claims', 3, []], ['Four claims', 4, []], ['Wide picture', 3, []], ['Long claims', 3, []],
  // (b) and (c): the first and last claims lie beyond the strip and are angled; the middle one is level and is not
  ['Strip picture', 3, [0, 2]], ['Strip picture five', 5, [0, 1, 3, 4]]
]

const browser = await chromium.launch({ headless: true })
try {
  // The deck (presenter, audience window and export run this template's fit pass).
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    for (const [title, count, angled] of SLIDES) {
      await page.evaluate((name) => {
        document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node.dataset.navTitle === name))
        window.__autofitForTest()
      }, title)
      await page.waitForTimeout(250)
      const m = await page.evaluate(({ name, fn }) => {
        const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === name)
        return (0, eval)(`(${fn})`)(slide)
      }, { name: title, fn: measureSlide.toString() })
      assertSlide(m, `${title} @${viewport.width}`, count, angled)
    }
    // A window resize re-runs the pass: the angles follow the new layout (the stage scale cancels out).
    await page.setViewportSize({ width: 1100, height: 700 })
    await page.evaluate(() => {
      document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node.dataset.navTitle === 'Strip picture'))
      window.__autofitForTest()
    })
    await page.waitForTimeout(300)
    const resized = await page.evaluate((fn) => {
      const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === 'Strip picture')
      return (0, eval)(`(${fn})`)(slide)
    }, measureSlide.toString())
    assertSlide(resized, `Strip picture @1100`, 3, [0, 2])
    await page.close()
  }

  // No script: every link stays the stylesheet's horizontal link.
  {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, javaScriptEnabled: false })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    const m = await page.evaluate(() => {
      const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === 'Strip picture')
      document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node === slide))
      return [...slide.querySelectorAll('.ic-link')].map((link) => getComputedStyle(link).transform)
    })
    m.forEach((transform, i) => check(transform === 'none' || /^matrix\(1, 0, 0, 1,/.test(transform), `no script: link ${i + 1} stays horizontal (${transform})`))
    await page.close()
  }

  // The share page (handout and venue screen): the same fit pass, inlined; measured on the strip.
  {
    const slides = extractSlides(model.fullHtml)
    const styles = extractStyles(model.fullHtml)
    const sharePath = join(dir, 'share.html')
    writeFileSync(sharePath, buildShareHtml({ title: 'Claims', slug: 'claims', includeNotes: false, license: null, styles, slides }), 'utf8')
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(`file://${sharePath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const index = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].findIndex((node) => node.dataset.navTitle === 'Strip picture'))
    check(index >= 0, 'share page: the strip slide is there')
    for (let i = 0; i < 60; i++) {
      const at = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].findIndex((node) => node.classList.contains('active')))
      if (at === index) break
      await page.keyboard.press(at < index ? 'ArrowRight' : 'ArrowLeft')
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(400)
    const m = await page.evaluate((fn) => {
      const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === 'Strip picture')
      return slide.classList.contains('active') ? (0, eval)(`(${fn})`)(slide) : null
    }, measureSlide.toString())
    assert.ok(m, 'share page: the strip slide is shown')
    assertSlide(m, 'share page: Strip picture', 3, [0, 2])
    await page.close()
  }
} finally {
  await browser.close()
}
console.log(`PASS image-claim-links: ${checks} measurements, every link starts on its box and its tip lands on the picture (level claims horizontal within ${TOL}px, angled ones within ${ANGLED_TOL}px)`)
