import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'

import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { codeLayoutForBlock } from '../compiler/scripts/lib/code-layout.mjs'
import { doctorDeck } from './layout-doctor-render.mjs'

const wrappedWidthLayout = codeLayoutForBlock({ text: ['x'.repeat(80), 'y'.repeat(80)].join('\n') })
assert.equal(wrappedWidthLayout.lines, 2, 'code layout retains the authored line count')
assert.equal(wrappedWidthLayout.wrappedLines, 4, 'code layout estimates visual lines from the floor-size panel measure')
assert(!wrappedWidthLayout.tooLongAtFloor, '80-character lines wrap without producing a width warning')
const overHeightLayout = codeLayoutForBlock({ text: Array.from({ length: 40 }, (_, index) => `line${index + 1}()`).join('\n') })
assert.equal(overHeightLayout.wrappedLines, 40, 'short authored lines each occupy one estimated visual line')
assert(overHeightLayout.tooLongAtFloor, 'a 40-line code block produces a height warning')

const samplerSource = readFileSync(new URL('../docs/layout-sampler-outline.md', import.meta.url), 'utf8')
for (const id of [
  'doctor-underfill',
  'doctor-type-floor',
  'doctor-one-word-line',
  'doctor-stage-clip',
  'doctor-panel-figure',
  'doctor-last-step'
]) {
  assert(samplerSource.includes(`{id=${id}}`), `${id}: the sampler carries the rendered-geometry fixture`)
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'talkweaver-layout-doctor-'))
const fixturePath = join(fixtureRoot, 'layout-doctor-fixture.html')
const outputDir = join(fixtureRoot, 'report')
const vaultRoot = join(fixtureRoot, 'vault')
const talkDir = join(vaultRoot, 'talk')
mkdirSync(join(vaultRoot, '_assets'), { recursive: true })
mkdirSync(join(talkDir, 'assets'), { recursive: true })
writeFileSync(
  join(vaultRoot, '_assets', 'img-abc1234.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
)

writeFileSync(fixturePath, `<!doctype html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
.stage { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
.slide { display: none; position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; background: white; }
.slide.active { display: block; }
.slide-content { position: absolute; inset: 50px; }
.fill { position: absolute; inset: 0; background: #dce8ff; }
.ink { position: relative; color: #101418; font: 36px/1.3 sans-serif; }
.underfill-dot { width: 50px; height: 50px; background: #101418; }
  .small-text { font: 20px/1.3 sans-serif; }
  .scaled-running-text { font: 1.875vw/1.3 sans-serif; }
  .line-target { width: 500px; font: 40px/1.25 sans-serif; }
  .asset-image { display: block; width: 100%; height: 100%; object-fit: cover; }
  .chrome { font: 18px/1.3 sans-serif; }
.clipped-box { position: absolute; left: calc(100% - 15px); top: 120px; width: 120px; height: 100px; background: #101418; }
.quote-panel { position: absolute; left: 5%; top: 15%; width: 62%; height: 60%; background: #dce8ff; padding: 40px; font: 36px/1.3 sans-serif; }
.slide-figure { position: absolute; right: 3%; top: 15%; width: 26%; height: 60%; margin: 0; background: #b9c9e8; }
.last-step-only { display: none; font: 20px/1.3 sans-serif; }
.layout-doctor-last-step .last-step-only { display: block; }
</style></head><body><main class="stage">
<section class="slide active" data-id="underfill" data-layout="list" data-role="content" data-title-layout="left" data-nav-title="Underfill"><div class="slide-content"><div class="underfill-dot"></div></div></section>
<section class="slide" data-id="subfloor" data-layout="list" data-role="content" data-title-layout="left" data-nav-title="Subfloor"><div class="slide-content"><div class="fill"></div><p class="ink small-text">This text is deliberately below the floor.</p></div></section>
  <section class="slide" data-id="one-word" data-layout="statement" data-role="content" data-title-layout="hidden" data-nav-title="One word"><div class="slide-content layout-statement"><div class="fill"></div><p class="ink line-target">Alpha<br>beta gamma delta</p></div></section>
  <section class="slide" data-id="widow" data-layout="statement" data-role="content" data-title-layout="hidden" data-nav-title="Widow"><div class="slide-content layout-statement"><div class="fill"></div><p class="ink line-target">Alpha beta gamma<br>delta</p></div></section>
  <section class="slide" data-id="clip" data-layout="list" data-role="content" data-title-layout="top" data-nav-title="Clip"><div class="slide-content"><div class="fill"></div><div class="clipped-box"></div></div></section>
  <section class="slide" data-id="clean" data-layout="image-quote" data-role="content" data-title-layout="hidden" data-nav-title="Clean"><div class="slide-content layout-image-quote"><div class="fill"></div><blockquote class="quote-panel">Four words fit one line.</blockquote><figure class="slide-figure"></figure></div></section>
  <section class="slide" data-id="last-step" data-layout="list" data-role="content" data-title-layout="left" data-mode="reveal" data-nav-title="Last step"><div class="slide-content"><div class="fill"></div><p class="last-step-only" data-fragment>Only visible at the last step.</p></div></section>
  <section class="slide" data-id="asset-loaded" data-layout="media" data-role="content" data-title-layout="top" data-nav-title="Asset loaded"><div class="slide-content"><img class="asset-image" src="img-abc1234" alt="Loaded fixture"></div></section>
  <section class="slide" data-id="asset-missing" data-layout="media" data-role="content" data-title-layout="top" data-nav-title="Asset missing"><div class="slide-content"><img class="asset-image" src="img-def5678" alt="Missing fixture"></div></section>
  <section class="slide" data-id="chrome" data-layout="list" data-role="content" data-title-layout="top" data-nav-title="Chrome"><div class="slide-content"><div class="fill"></div><p class="kicker chrome">Section label</p><p class="content-p scaled-running-text">Running content stays subject to the floor.</p><div class="poll-frame"><p class="poll-frame-eyebrow chrome">Audience poll <span class="poll-frame-sep">·</span> <span class="poll-frame-kind">Single choice</span></p><p class="poll-frame-join-note chrome">Join when ready</p><span class="poll-frame-chip chrome">Ready</span></div><figure class="slide-qr"><figcaption class="qr-caption chrome">QR caption</figcaption></figure><nav class="footer chrome">Next slide</nav></div></section>
  </main></body></html>`, 'utf8')

const result = await doctorDeck(fixturePath, {
  outputDir,
  viewports: [{ width: 1600, height: 900 }, { width: 1280, height: 720 }],
  vaultRoot,
  talkDir,
  assetWaitTimeoutMs: 100
})

assert.equal(result.slides.length, 10, 'the doctor records all ten fixture slides')
const slide = (id) => result.slides.find((candidate) => candidate.id === id)
const classes = (id) => new Set(slide(id)?.failures.map((failure) => failure.class))

assert.equal(slide('underfill').layout, 'list', 'the compiled layout is recorded')
assert.equal(slide('underfill').titleRegime, 'left', 'the resolved title regime is recorded')
assert(classes('underfill').has('underfilled'), 'coverage below 35% is caught')
assert(classes('subfloor').has('sub-floor-text'), 'computed text below 31px is caught')
assert(classes('one-word').has('one-word-line'), 'a non-final one-word statement line is caught')
assert(!classes('one-word').has('widow'), 'a non-final one-word line is not a widow')
assert(classes('widow').has('widow'), 'a final one-word statement line is reported as a widow')
assert(!classes('widow').has('one-word-line'), 'a lone final one-word line is not a one-word-line defect')
assert(classes('clip').has('clip'), 'geometry outside the stage is caught')
assert(classes('last-step').has('sub-floor-text'), 'reveal slides are inspected at their last step')
assert.deepEqual([...classes('clean')], [], 'the clean slide is not reported')
assert.deepEqual([...classes('asset-loaded')], [], 'a resolved alias contributes its image area and is not underfilled')
assert(classes('asset-missing').has('asset-missing'), 'an unresolved alias is reported as a missing asset')
assert(!classes('asset-missing').has('underfilled'), 'a missing asset is never also reported as underfilled')
assert(classes('chrome').has('small-chrome'), 'allowlisted small chrome is reported informationally')
assert(classes('chrome').has('sub-floor-text'), 'running content below the scaled floor remains a violation')
assert.equal(slide('chrome').viewports['1600x900'].subFloorText.length, 1, 'chrome is excluded from running-content floor findings')
assert.equal(slide('chrome').viewports['1280x720'].subFloorText.length, 1, 'the floor scales with the stage at 1280x720')
assert(slide('chrome').viewports['1600x900'].smallChrome.some((finding) => finding.element === 'p.kicker.chrome'), 'kickers remain deliberately small chrome')

assert.equal(result.assets.served, 1, 'the deck reports one resolved asset')
assert.deepEqual(result.assets.missed, ['img-def5678'], 'the deck reports unresolved asset references')
assert(result.census, 'the report includes a reference-viewport census')
assert.equal(result.census.viewport, '1600x900', 'the summary census uses the reference viewport')
assert.equal(result.census.offendingSlides, 8, 'the summary counts unique offending slides at the reference viewport')
assert.equal(result.census.classes.widow, 1, 'the summary counts each class at the reference viewport')

assert((slide('clean').viewports['1600x900'].panels[0]?.widthPx ?? 0) > 0, 'quote panel width is measured')
assert((slide('clean').viewports['1600x900'].panels[0]?.fontPx ?? 0) >= 31, 'quote panel computed font size is measured')
assert(slide('clean').viewports['1600x900'].figures[0].widthPx > 0, 'figure size is measured')
assert(result.offenders.some((offender) => offender.id === 'clip'), 'offenders contain failing slides')
assert(!result.offenders.some((offender) => offender.id === 'clean'), 'offenders exclude clean slides')

const reportJson = JSON.parse(readFileSync(join(outputDir, 'layout-doctor-fixture.json'), 'utf8'))
assert.equal(reportJson.slides.length, 10, 'the JSON report is emitted')
assert.equal(reportJson.assets.served, 1, 'the JSON report includes the asset census')
const contactSheet = readFileSync(join(outputDir, 'layout-doctor-fixture-offenders.html'), 'utf8')
assert.match(contactSheet, /grid-template-columns:\s*repeat\(6,/, 'the offender contact sheet uses six columns')
assert.match(contactSheet, /Subfloor/, 'the contact sheet prints failing metrics beside thumbnails')

const parcelFixtureMatch = samplerSource.match(/<!-- ticket-17-fixtures:start -->([\s\S]*?)<!-- ticket-17-fixtures:end -->/)
assert(parcelFixtureMatch, 'the sampler carries the Ticket 17 type-floor and portrait fixtures')
const parcelOutline = [
  '---',
  'title: Ticket 17 fixture deck',
  'author: Dominik Lukeš',
  'affiliation: University of Oxford',
  'web: https://dominiklukes.net',
  'auto_title_slide: true',
  'auto_thanks_slide: true',
  '---',
  '# Ticket 17 fixture deck',
  '',
  '## Cases',
  parcelFixtureMatch[1].trim(),
  ''
].join('\n')
const parcelTalkDir = join(fixtureRoot, 'parcel-talk')
mkdirSync(join(parcelTalkDir, 'assets'), { recursive: true })
copyFileSync(
  new URL('../scripts/fixtures/layout/07-minister-portrait.png', import.meta.url),
  join(parcelTalkDir, 'assets', '07-minister-portrait.png')
)
const parcelOutlinePath = join(parcelTalkDir, 'ticket-17-fixtures.md')
const parcelHtmlPath = join(parcelTalkDir, 'ticket-17-fixtures.html')
writeFileSync(parcelOutlinePath, parcelOutline, 'utf8')
const parcelModel = await prepareSource(
  parcelOutlinePath,
  parcelOutline,
  'Ticket 17 fixture deck',
  statSync(parcelOutlinePath)
)
writeFileSync(parcelHtmlPath, parcelModel.fullHtml, 'utf8')

const parcelResult = await doctorDeck(parcelHtmlPath, {
  outputDir: join(fixtureRoot, 'parcel-report'),
  viewports: [{ width: 1600, height: 900 }, { width: 1280, height: 720 }],
  talkDir: parcelTalkDir
})
assert(
  parcelModel.warnings.includes('code-too-long:type-floor-code-too-long'),
  'a code block that cannot fit at the shared floor emits code-too-long'
)
const parcelIds = [
  'type-floor-nested',
  'type-floor-key-value',
  'type-floor-table',
  'type-floor-cite',
  'type-floor-statement',
  'type-floor-card',
  'type-floor-timeline',
  'type-floor-portrait',
  'type-floor-compare',
  'type-floor-code',
  'type-floor-code-wrap',
  'type-floor-links',
  'deck-title',
  'deck-thanks'
]
for (const id of parcelIds) {
  const record = parcelResult.slides.find((candidate) => candidate.id === id)
  assert(record, `${id}: compiled sampler fixture is present in the doctor report`)
  for (const viewport of ['1600x900', '1280x720']) {
    assert.equal(record.viewports[viewport].subFloorText.length, 0, `${id} ${viewport}: no running content is below the scaled type floor`)
    assert.equal(record.viewports[viewport].clips.length, 0, `${id} ${viewport}: content stays inside the stage`)
  }
}

const compareRecord = parcelResult.slides.find((candidate) => candidate.id === 'type-floor-compare')
const compareChrome = compareRecord.viewports['1600x900'].smallChrome.filter((finding) => finding.element === 'div.compare-label')
assert.equal(compareChrome.length, 2, 'the mockup .t-half .lab labels are allowlisted as deliberate small chrome')
assert(compareChrome.every((finding) => finding.px < 31), 'compare labels stay below the running-text floor at the reference stage')

for (const viewport of ['1600x900', '1280x720']) {
  const codeRecord = parcelResult.slides.find((candidate) => candidate.id === 'type-floor-code')
  assert(
    codeRecord.viewports[viewport].smallChrome.some((finding) => finding.element === 'span.code-lang'),
    `${viewport}: the code language badge is allowlisted as genuine small chrome`
  )
}
const longCodeRecord = parcelResult.slides.find((candidate) => candidate.id === 'type-floor-code-too-long')
for (const viewport of ['1600x900', '1280x720']) {
  assert.equal(longCodeRecord.viewports[viewport].subFloorText.length, 0, `${viewport}: overlong code remains at the scaled type floor`)
}

const mutatedParcelHtmlPath = join(parcelTalkDir, 'ticket-17-fixtures-mutated.html')
writeFileSync(
  mutatedParcelHtmlPath,
  parcelModel.fullHtml.replace('</head>', '<style>.link-url{font-size:calc(var(--type-floor) * .5)!important}</style></head>'),
  'utf8'
)
const mutatedParcelResult = await doctorDeck(mutatedParcelHtmlPath, {
  outputDir: join(fixtureRoot, 'parcel-mutated-report'),
  viewports: [{ width: 1600, height: 900 }, { width: 1280, height: 720 }],
  talkDir: parcelTalkDir
})
for (const viewport of ['1600x900', '1280x720']) {
  const mutatedLinks = mutatedParcelResult.slides.find((candidate) => candidate.id === 'type-floor-links')
  assert(
    mutatedLinks.viewports[viewport].subFloorText.some((finding) => finding.element === 'span.link-url'),
    `${viewport}: mutating the URL below the floor is caught as sub-floor-text`
  )
}

const geometryBrowser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await geometryBrowser.newPage({ viewport })
    await page.goto(new URL(`file://${parcelHtmlPath}`).href, { waitUntil: 'load' })
    const metrics = await page.evaluate(() => {
      const activate = (id) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const target = slides.find((slide) => slide.dataset.id === id)
        slides.forEach((slide) => slide.classList.toggle('active', slide === target))
        window.__autofitForTest?.()
        return target
      }
      const style = (element) => getComputedStyle(element)
      const luminance = (colour) => {
        const channels = colour.match(/[\d.]+/g).slice(0, 3).map((channel) => Number(channel) / 255)
        const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
      }
      const contrast = (foreground, background) => {
        const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
        return (light + 0.05) / (dark + 0.05)
      }
      const textMetric = (selector) => {
        const element = document.querySelector(selector)
        return {
          px: Number.parseFloat(style(element).fontSize),
          colour: style(element).color,
          family: style(element).fontFamily
        }
      }
      const codeMetric = (id) => {
        activate(id)
        const panel = document.querySelector('.slide.active .slide-code')
        const code = panel.querySelector('code')
        const head = document.querySelector('.slide.active .slide-head')
        const stage = document.querySelector('.stage')
        const marker = document.querySelector('.slide.active .code-overflow-marker')
        const panelRect = panel.getBoundingClientRect()
        const headRect = head.getBoundingClientRect()
        const stageRect = stage.getBoundingClientRect()
        const panelStyle = style(panel)
        const codeStyle = style(code)
        const chromeBand = 59
        const bandTop = headRect.bottom
        const bandBottom = stageRect.bottom - chromeBand
        const lineHeight = Number.parseFloat(panelStyle.lineHeight)
        return {
          px: Number.parseFloat(panelStyle.fontSize),
          fit: panel.dataset.codeFit,
          marker: marker?.textContent?.trim() || '',
          markerVisible: Boolean(marker && marker.getBoundingClientRect().width > 0),
          panel: { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height },
          topAir: panelRect.top - bandTop,
          bottomAir: bandBottom - panelRect.bottom,
          bandHeight: bandBottom - bandTop,
          horizontalOverflow: code.scrollWidth - code.clientWidth,
          whiteSpace: codeStyle.whiteSpace,
          overflowWrap: codeStyle.overflowWrap,
          wrappedLines: Math.round(code.scrollHeight / lineHeight)
        }
      }
      activate('type-floor-nested')
      const parent = textMetric('.slide.active .fl-text')
      const nested = [...document.querySelectorAll('.slide.active .fl-subtext')].map((element) => ({
        px: Number.parseFloat(style(element).fontSize),
        colour: style(element).color,
        family: style(element).fontFamily,
        contrast: contrast(style(element).color, style(document.body).backgroundColor)
      }))
      activate('type-floor-key-value')
      const annotatedLead = textMetric('.slide.active .fl-lead .fl-text')
      const annotatedItems = [...document.querySelectorAll('.slide.active .fl-subtext')].map((element) => Number.parseFloat(style(element).fontSize))
      activate('deck-title')
      const poster = {
        name: textMetric('.slide.active .tp-name'),
        affiliation: textMetric('.slide.active .tp-soft'),
        web: textMetric('.slide.active .tp-web')
      }
      const wrappedCode = codeMetric('type-floor-code-wrap')
      const longCode = codeMetric('type-floor-code-too-long')
      activate('type-floor-portrait')
      const portrait = document.querySelector('.slide.active .slide-figure img')
      const portraitRect = portrait.getBoundingClientRect()
      const contentRect = portrait.closest('.slide-content').getBoundingClientRect()
      activate('type-floor-compare')
      const compareHalves = [...document.querySelectorAll('.slide.active .compare-half')]
      const compareCopy = [...document.querySelectorAll('.slide.active .compare-inner .content-p')]
      const compareLabels = [...document.querySelectorAll('.slide.active .compare-label')]
      const stageRect = document.querySelector('.stage').getBoundingClientRect()
      return {
        parent,
        nested,
        annotatedLead,
        annotatedItems,
        poster,
        wrappedCode,
        longCode,
        portrait: {
          renderedAspect: portraitRect.width / portraitRect.height,
          naturalAspect: portrait.naturalWidth / portrait.naturalHeight,
          top: portraitRect.top,
          bottom: portraitRect.bottom,
          contentTop: contentRect.top,
          contentBottom: contentRect.bottom,
          objectFit: style(portrait).objectFit
        },
        compare: {
          widths: compareHalves.map((half) => half.getBoundingClientRect().width),
          heights: compareHalves.map((half) => half.getBoundingClientRect().height),
          stageWidth: stageRect.width,
          stageHeight: stageRect.height,
          backgrounds: compareHalves.map((half) => style(half).backgroundColor),
          paper: style(document.body).backgroundColor,
          copyFonts: compareCopy.map((paragraph) => Number.parseFloat(style(paragraph).fontSize)),
          copyWeights: compareCopy.map((paragraph) => style(paragraph).fontWeight),
          copyMaxWidths: compareCopy.map((paragraph) => Number.parseFloat(style(paragraph).maxWidth)),
          labelFonts: compareLabels.map((label) => Number.parseFloat(style(label).fontSize)),
          centreOffsets: compareHalves.map((half) => {
            const halfRect = half.getBoundingClientRect()
            const innerRect = half.querySelector('.compare-inner').getBoundingClientRect()
            return Math.abs((halfRect.top + halfRect.bottom - innerRect.top - innerRect.bottom) / 2)
          })
        }
      }
    })
    const floor = 31 * viewport.width / 1600
    assert(metrics.nested.every((item) => item.px + 0.01 >= floor), `${viewport.width}x${viewport.height}: every nested level meets the ${floor}px floor`)
    assert(metrics.nested.every((item) => item.colour === metrics.parent.colour), `${viewport.width}x${viewport.height}: nested content uses parent ink`)
    assert(metrics.nested.every((item) => item.family === metrics.parent.family), `${viewport.width}x${viewport.height}: nested content uses the parent family`)
    assert(metrics.nested.every((item) => item.contrast >= 7), `${viewport.width}x${viewport.height}: nested content contrast is at least 7:1 on paper`)
    assert(metrics.annotatedItems.every((px) => Math.abs(px - metrics.annotatedLead.px) <= 0.01), `${viewport.width}x${viewport.height}: key/value items use body size`)
    assert(metrics.poster.name.px > metrics.poster.affiliation.px, `${viewport.width}x${viewport.height}: poster name is larger than affiliation`)
    assert(metrics.poster.affiliation.px + 0.01 >= metrics.poster.web.px, `${viewport.width}x${viewport.height}: poster affiliation is at least as large as the web address`)
    assert.equal(metrics.wrappedCode.whiteSpace, 'pre-wrap', `${viewport.width}x${viewport.height}: code uses soft wrapping`)
    assert.equal(metrics.wrappedCode.overflowWrap, 'anywhere', `${viewport.width}x${viewport.height}: long code tokens may wrap anywhere`)
    assert(metrics.wrappedCode.horizontalOverflow <= 1, `${viewport.width}x${viewport.height}: 80-character code lines do not overflow horizontally`)
    assert(metrics.wrappedCode.wrappedLines >= 4, `${viewport.width}x${viewport.height}: both 80-character source lines wrap`)
    assert.equal(metrics.wrappedCode.fit, 'base', `${viewport.width}x${viewport.height}: width wrapping does not trigger code fitting`)
    assert(!metrics.wrappedCode.markerVisible, `${viewport.width}x${viewport.height}: width wrapping does not show Code too long`)
    assert(Math.abs(metrics.wrappedCode.topAir - metrics.wrappedCode.bottomAir) <= 4, `${viewport.width}x${viewport.height}: wrapped code is vertically centred in the title-to-chrome band`)
    assert(metrics.longCode.px + 0.01 >= floor, `${viewport.width}x${viewport.height}: overlong code never shrinks below the floor`)
    assert.equal(metrics.longCode.fit, 'too-long', `${viewport.width}x${viewport.height}: overlong code is marked too-long after fitting reaches the floor`)
    assert(metrics.longCode.markerVisible && metrics.longCode.marker === 'Code too long', `${viewport.width}x${viewport.height}: overlong code has a visible marker`)
    assert(Math.abs(metrics.longCode.topAir) <= 4, `${viewport.width}x${viewport.height}: code taller than the band starts at the top`)
    console.log(JSON.stringify({ viewport, wrappedCode: metrics.wrappedCode, longCode: metrics.longCode }))

    await page.addStyleTag({ content: '.slide-code code { white-space: pre !important; }' })
    const mutatedWrap = await page.evaluate(() => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((candidate) => candidate.dataset.id === 'type-floor-code-wrap')
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === slide))
      window.__autofitForTest?.()
      const code = slide.querySelector('.slide-code code')
      return code.scrollWidth - code.clientWidth
    })
    assert(mutatedWrap > 1, `${viewport.width}x${viewport.height}: mutating soft-wrap back to pre recreates horizontal overflow`)
    assert.equal(metrics.portrait.objectFit, 'contain', `${viewport.width}x${viewport.height}: portrait media uses object-fit contain`)
    assert(Math.abs(metrics.portrait.renderedAspect - metrics.portrait.naturalAspect) <= 0.01, `${viewport.width}x${viewport.height}: portrait aspect ratio is preserved`)
    assert(metrics.portrait.top >= metrics.portrait.contentTop - 1 && metrics.portrait.bottom <= metrics.portrait.contentBottom + 1, `${viewport.width}x${viewport.height}: portrait stays inside its content band`)
    const expectedCompareCopyPx = Math.min(48, viewport.width * 0.034)
    assert(metrics.compare.copyFonts.every((px) => Math.abs(px - expectedCompareCopyPx) <= 0.1), `${viewport.width}x${viewport.height}: compare copy follows clamp(1.7rem, 3.4vw, 3rem)`)
    assert.deepEqual(metrics.compare.copyWeights, ['500', '500'], `${viewport.width}x${viewport.height}: compare copy uses weight 500`)
    assert(metrics.compare.copyMaxWidths.every((px) => Math.abs(px - expectedCompareCopyPx * 12) <= 0.1), `${viewport.width}x${viewport.height}: compare copy uses the 12em measure`)
    assert(metrics.compare.labelFonts.every((px) => Math.abs(px - expectedCompareCopyPx * 0.58) <= 0.1), `${viewport.width}x${viewport.height}: compare labels use the mockup .58em scale`)
    assert(Math.abs(metrics.compare.widths[0] - metrics.compare.widths[1]) <= 1, `${viewport.width}x${viewport.height}: compare columns are equal width`)
    assert(metrics.compare.widths.every((width) => Math.abs(width - metrics.compare.stageWidth / 2) <= 1), `${viewport.width}x${viewport.height}: each compare column occupies half the stage`)
    assert(metrics.compare.heights.every((height) => Math.abs(height - metrics.compare.stageHeight) <= 1), `${viewport.width}x${viewport.height}: compare backgrounds fill the stage height`)
    assert.notEqual(metrics.compare.backgrounds[0], metrics.compare.backgrounds[1], `${viewport.width}x${viewport.height}: only the left compare column carries tint`)
    assert.equal(metrics.compare.backgrounds[1], metrics.compare.paper, `${viewport.width}x${viewport.height}: the right compare column stays on paper`)
    assert(metrics.compare.centreOffsets.every((offset) => offset <= 1), `${viewport.width}x${viewport.height}: both compare columns are vertically centred`)
    await page.close()
  }
} finally {
  await geometryBrowser.close()
}

// ── T28 — icon lists: nested icons stay in their box, no counters, >3 items take the rows ──
const iconListOutline = [
  '---',
  'title: T28 icon-list fixtures',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '### Nested icons boxes',
  '{icons=all}{id=t28-nested-boxes}',
  '',
  '- Chat answers questions',
  '    - great for thinking out loud',
  '    - you copy the results back yourself',
  '- Codex changes the code',
  '    - it acts in the repo and makes commits',
  '    - you review the diff',
  '',
  '### Three items keep boxes',
  '{iconlist}{id=t28-three}',
  '',
  '- Translate {icon=lucide:languages}',
  '- Structure {icon=lucide:boxes}',
  '- Build {icon=lucide:hammer}',
  '',
  '### Four items take rows',
  '{iconlist}{id=t28-four}',
  '',
  '- Translate {icon=lucide:languages}',
  '- Structure {icon=lucide:boxes}',
  '- Build {icon=lucide:hammer}',
  '- Ship {icon=lucide:rocket}',
  '',
  '### Four boxes pinned',
  '{iconlist=boxes}{id=t28-boxes-four}',
  '',
  '- Translate {icon=lucide:languages}',
  '- Structure {icon=lucide:boxes}',
  '- Build {icon=lucide:hammer}',
  '- Ship {icon=lucide:rocket}',
  ''
].join('\n')
const iconListTalkDir = join(fixtureRoot, 't28-talk')
mkdirSync(join(iconListTalkDir, 'assets'), { recursive: true })
const iconListOutlinePath = join(iconListTalkDir, 't28-icon-lists.md')
const iconListHtmlPath = join(iconListTalkDir, 't28-icon-lists.html')
writeFileSync(iconListOutlinePath, iconListOutline, 'utf8')
const iconListModel = await prepareSource(
  iconListOutlinePath,
  iconListOutline,
  'T28 icon-list fixtures',
  statSync(iconListOutlinePath)
)
writeFileSync(iconListHtmlPath, iconListModel.fullHtml, 'utf8')

const iconListBrowser = await chromium.launch({ headless: true })
try {
  const page = await iconListBrowser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(new URL(`file://${iconListHtmlPath}`).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const iconList = await page.evaluate(() => {
    const activate = (id) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const target = slides.find((slide) => slide.dataset.id === id)
      slides.forEach((slide) => slide.classList.toggle('active', slide === target))
      window.__autofitForTest?.()
      return target
    }
    const rectsIntersect = (a, b) =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
    const variantOf = (id) => {
      const list = activate(id)?.querySelector('ul.feature-list')
      if (!list) return 'none'
      return list.classList.contains('fl-iconlist-list') ? 'list' : 'boxes'
    }
    // (b) no li::after content on an icon list — either variant.
    const counterContent = (id) => {
      const list = activate(id)?.querySelector('ul.feature-list')
      return [...list.querySelectorAll(':scope > li')].map((li) => getComputedStyle(li, '::after').content)
    }
    // (a) every nested sub-icon svg sits INSIDE its .fl-sub-icon box and never intersects
    // the sibling sub-text box.
    activate('t28-nested-boxes')
    const subIcons = [...document.querySelectorAll('.slide.active .fl-sub-icon')].map((box) => {
      const svg = box.querySelector('svg')
      const text = box.parentElement.querySelector('.fl-subtext')
      const boxRect = box.getBoundingClientRect()
      const svgRect = svg?.getBoundingClientRect()
      const textRect = text?.getBoundingClientRect()
      return {
        hasSvg: Boolean(svg),
        insideBox: Boolean(svgRect)
          && svgRect.left >= boxRect.left - 0.5 && svgRect.right <= boxRect.right + 0.5
          && svgRect.top >= boxRect.top - 0.5 && svgRect.bottom <= boxRect.bottom + 0.5,
        clearsText: Boolean(svgRect && textRect) ? !rectsIntersect(svgRect, textRect) : false,
        svgWidth: svgRect?.width ?? 0,
        boxWidth: boxRect.width
      }
    })
    return {
      variants: {
        three: variantOf('t28-three'),
        four: variantOf('t28-four'),
        boxesFour: variantOf('t28-boxes-four')
      },
      counterContent: { boxes: counterContent('t28-three'), list: counterContent('t28-four') },
      subIcons
    }
  })
  assert.deepEqual(iconList.variants, { three: 'boxes', four: 'list', boxesFour: 'boxes' },
    '(c)+(d): bare {iconlist} flips to the vertical rows only over three items; {iconlist=boxes} pins the card grid')
  for (const [variant, contents] of Object.entries(iconList.counterContent)) {
    assert(contents.every((content) => content === 'none'),
      `(b): no li::after counter content on the ${variant} icon-list variant`)
  }
  assert(iconList.subIcons.length >= 4, '(a): the {icons=all} fixture resolves nested sub-icons to measure')
  assert(iconList.subIcons.every((sub) => sub.hasSvg && sub.insideBox),
    '(a): every .fl-sub-icon svg renders inside its own 20px box (no 1.8em bleed)')
  assert(iconList.subIcons.every((sub) => sub.clearsText),
    '(a): no sub-icon svg intersects its sibling sub-text box')
  console.log(JSON.stringify({ t28: iconList.variants, subIconWidths: iconList.subIcons.map((sub) => sub.svgWidth) }))
  await page.close()
} finally {
  await iconListBrowser.close()
}

console.log('rendered layout doctor: PASS')
