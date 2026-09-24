import { strict as assert } from 'node:assert'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, chromium } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import sharp from 'sharp'
import ts from 'typescript'
import { buildLayoutSampler, samplerArtefactsDir, samplerOutlinePath } from '../scripts/build-layout-sampler.mjs'
import { reportRowsAfterSeparator } from './lib/layout-sampler-report.mjs'

const repo = resolve(new URL('..', import.meta.url).pathname)
const sampleImage = join(repo, 'scripts/fixtures/layout/sample-image.png')
const measuredVideoFixture = join(repo, 'e2e/fixtures/media-row-4x3.mp4')
const samplerMediaAssets = ['sample-image.png', 'slide_0010.webp', '07-minister-portrait.png']
const registryPath = join(repo, 'src/shared/layout-registry/entries.ts')
const reportPath = join(repo, 'docs/layout-sampler-unverified-report.md')
const screenshotsDir = join(samplerArtefactsDir, 'screenshots')

const explicitHosts = {
  section: 'section-divider',
  '2col': 'columns'
}

function normalise(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue)
  return undefined
}

function registryEntries() {
  const sourceText = readFileSync(registryPath, 'utf8')
  const source = ts.createSourceFile(registryPath, sourceText, ts.ScriptTarget.Latest, true)
  let layouts
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'LAYOUTS' && ts.isArrayLiteralExpression(declaration.initializer)) {
        layouts = declaration.initializer
      }
    }
  })
  assert(layouts, 'LAYOUTS registry is present')
  return layouts.elements.map((entry) => {
    assert(ts.isObjectLiteralExpression(entry), 'registry entry is an object literal')
    const out = {}
    for (const property of entry.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
      if (key) out[key] = literalValue(property.initializer)
    }
    return out
  })
}

function hostFor(entry, slides) {
  const explicit = explicitHosts[entry.name]
  if (explicit) return slides.find((slide) => slide.id === explicit)
  const key = normalise(entry.name)
  return slides.find((slide) => normalise(slide.id).includes(key))
    ?? slides.find((slide) => normalise(slide.title).includes(key))
    ?? slides.find((slide) => normalise(slide.layout) === key)
}

function safeFileName(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'slide'
}

assert(existsSync(sampleImage), 'layout sampler must ship its committed sample image asset')
assert(existsSync(measuredVideoFixture), 'layout sampler must ship its non-16:9 local video fixture')
const imageMetadata = await sharp(sampleImage).metadata()
assert(imageMetadata.format === 'png' && imageMetadata.width > 1 && imageMetadata.height > 1, 'sample image is a decodable PNG placeholder')
assert(existsSync(reportPath), 'unverified sampler report is present')

const { model, html, outPath } = await buildLayoutSampler()
assert(existsSync(outPath) && statSync(outPath).size > 1000, 'sampler bundle is written by the real compiler')
assert(html.includes('<section'), 'sampler bundle contains compiled slide sections')
const unknownWarnings = (model.warnings ?? []).filter((warning) => String(warning).startsWith('unknown-trigger:'))
assert.deepEqual(unknownWarnings, [], `sampler has no unknown trigger warnings: ${unknownWarnings.join(', ')}`)

function samplerSection(title) {
  return [...html.matchAll(/<section class="slide"[\s\S]*?<\/section>/g)]
    .map((match) => match[0])
    .find((section) => section.includes(`<h1>${title}</h1>`)) ?? ''
}

const videoImageRow = samplerSection('Media row — video and image')
assert.match(videoImageRow, /class="figure-row count-2"/, 'sampler video + image fixture renders one media row')
const measuredVideoRow = samplerSection('Media row — measured 4:3 video and image')
assert.match(measuredVideoRow, /data-media-aspect-source="assumed-16:9"/, 'local video without a poster is explicitly assumed at compile time')
assert.match(samplerSection('Media row — image, video and image'), /class="figure-row count-3"/, 'sampler image + video + image fixture renders one media row')
const orientationRow = samplerSection('Media row — portrait and landscape')
assert.match(orientationRow, /--media-aspect:0\.64/, 'sampler portrait fixture carries its narrower intrinsic aspect')
assert.match(orientationRow, /--media-aspect:1\.77/, 'sampler landscape fixture carries its wider intrinsic aspect')
assert.match(samplerSection('Media gallery — four mixed media'), /class="figure-row figure-row-gallery count-4"/, 'sampler four-mixed-media fixture renders one gallery')
const listMediaSlot = samplerSection('Media slot — list, video and image')
assert.match(listMediaSlot, /data-slot-media-count="2"/, 'sampler list + video + image fixture feeds both figures to the media slot')
assert.doesNotMatch(listMediaSlot, /figure-row/, 'sampler list + video + image fixture keeps the B2 stack')
const bareCards = samplerSection('Body-less cards use their labels as claims')
assert.match(bareCards, /class="card card-claim"/, 'body-less card fixture exposes the claim treatment')
assert.doesNotMatch(bareCards, /card-grid cards-numbered/, 'unordered body-less cards do not request ordinals')
assert.match(samplerSection('Numbered body-less cards keep requested ordinals'), /card-grid cards-numbered/, 'the numbered trigger requests card ordinals')
assert.match(samplerSection('Ordered body-less cards keep requested ordinals'), /card-grid cards-numbered/, 'ordered card source requests ordinals')
// Ticket 21: the cards Icons option renders an accent icon on every card, via {icons} and its
// {iconlist} alias alike; the table options render as classes the stylesheet keys off.
for (const title of ['Cards with icons', 'Cards with icons via the iconlist alias']) {
  const cardsWithIcons = samplerSection(title)
  assert.equal((cardsWithIcons.match(/<article class="card/g) || []).length, 3, `${title}: three cards render`)
  assert.equal((cardsWithIcons.match(/<span class="card-icon"><svg/g) || []).length, 3, `${title}: every card carries an icon`)
}
assert.match(samplerSection('Cards with icons'), /card-icon"><svg[^>]*><path d="M4 14a1 1 0 0 1-\.78/, 'a per-item {icon=lucide:zap} pins the card icon')
assert.match(samplerSection('Table without a header row'), /<table class="slide-table table-noheader"[^>]*><tbody>/, '{table-header=off} renders no thead: the first row is a plain row')
assert.match(samplerSection('Table without column rules'), /<table class="slide-table table-nocolumns"[^>]*><thead>/, '{table-columns=off} keeps the header and drops the column rules')
assert.match(samplerSection('Table at the body type with a tinted header'), /<table class="slide-table" style="--table-rows:4"/, 'a table carries its row count for the band-fill padding')
assert.match(samplerSection('Long table steps padding before type'), /data-list-density="dense"/, 'a ten-row table is stamped dense at compile time')

// Ticket 22: every timeline mode over the same five-entry dated list renders five stops, each
// with a date node and a text node — no mode folds the list into one card. The rendered geometry
// (floor, footer clearance, balanced air, dynamic last step) is scripts/test-timeline-modes.mjs.
for (const mode of ['Auto', 'Rail', 'Columns', 'Compact', 'Horizontal', 'Spine', 'Pills', 'Dynamic']) {
  const section = samplerSection(`Five years of AI — ${mode}`)
  assert.equal((section.match(/ data-tl-stop(?=[\s>])/g) || []).length, 5, `${mode}: five timeline stops render`)
  assert.equal((section.match(/data-tl-date/g) || []).length, 5, `${mode}: every stop carries its date`)
  assert.equal((section.match(/data-tl-text/g) || []).length, 5, `${mode}: every stop carries its text`)
  assert.match(section, /data-tl-stops="5"/, `${mode}: the timeline reports five stops`)
}
for (const base of ['t22-pills-split', 't22-horizontal-split']) {
  const parts = model.slides.filter((slide) => slide.id === base || slide.id.startsWith(`${base}-`))
  assert.equal(parts.length, 2, `${base}: eight stops split into two balanced continuation slides`)
  assert.equal(parts[1].id, `${base}-2`, `${base}: the continuation id uses the timeline separator`)
  assert.deepEqual(parts.map((slide) => slide.blocks[0].stops.length), [4, 4], `${base}: the cut is balanced`)
}

const entries = registryEntries()
const missingEntries = entries.filter((entry) => !hostFor(entry, model.slides)).map((entry) => entry.name)
assert.deepEqual(missingEntries, [], `registry entries missing from sampler slide set: ${missingEntries.join(', ')}`)
for (const entry of entries) {
  const host = hostFor(entry, model.slides)
  assert(html.includes(`data-id="${host.id}"`), `${entry.name}: host slide appears in built bundle`)
}

const report = readFileSync(reportPath, 'utf8')
// ADR-0020 D5: the report lists EXACTLY the registry's unverified entries — no stale rows.
const reportRows = reportRowsAfterSeparator(report).sort()
const unverifiedNames = entries.filter((entry) => entry.status === 'unverified').map((entry) => entry.name).sort()
assert.deepEqual(reportRows, unverifiedNames,
  `unverified report rows must exactly match registry unverified entries; stale: ${reportRows.filter((r) => !unverifiedNames.includes(r)).join(', ') || 'none'}`)
for (const entry of entries.filter((entry) => entry.status === 'unverified')) {
  assert(report.includes(`| ${entry.name} | Yes | Yes |`), `${entry.name}: report records compile and render result`)
}

console.log(`PASS compiler fixture: ${entries.length} registry entries, ${model.slides.length} compiled slides, zero unknown triggers`)

const geometryBrowser = await chromium.launch({ headless: true })
try {
  const geometryPage = await geometryBrowser.newPage({ viewport: { width: 1600, height: 900 } })
  await geometryPage.goto(`file://${outPath}`, { waitUntil: 'load' })
  await geometryPage.evaluate(() => {
    document.body.classList.add('chrome-pinned')
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const target = slides.find((slide) => slide.dataset.id === 'media-row-measured-video')
    slides.forEach((slide) => slide.classList.toggle('active', slide === target))
    target?.querySelector('video')?.load()
    window.__autofitForTest?.()
  })
  await geometryPage.waitForFunction(() => {
    const video = document.querySelector('.slide.active .figure-row video')
    return video?.readyState >= 1 && video.closest('figure')?.dataset.mediaAspectSource === 'measured'
  })
  await geometryPage.evaluate(() => window.__autofitForTest?.())
  await geometryPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
  const geometry = await geometryPage.evaluate(() => {
    const slide = document.querySelector('.slide.active')
    const row = slide?.querySelector('.figure-row')
    const video = row?.querySelector('video')
    const head = slide?.querySelector('.slide-head')
    const footer = document.querySelector('.footer')
    if (!slide || !row || !video || !head || !footer) return null
    const rowRect = row.getBoundingClientRect()
    const videoRect = video.getBoundingClientRect()
    const headRect = head.getBoundingClientRect()
    const footerRect = footer.getBoundingClientRect()
    return {
      aspectSource: video.closest('figure')?.dataset.mediaAspectSource,
      boxAspect: videoRect.width / videoRect.height,
      videoAspect: video.videoWidth / video.videoHeight,
      topAir: rowRect.top - headRect.bottom,
      bottomAir: footerRect.top - rowRect.bottom,
      rowBottom: rowRect.bottom,
      navTop: footerRect.top,
      zoom: getComputedStyle(slide.querySelector('.slide-content')).zoom
    }
  })
  assert(geometry, 'measured-video sampler geometry is available')
  assert.equal(geometry.aspectSource, 'measured', 'loadedmetadata marks the video aspect as measured')
  assert(Math.abs(geometry.boxAspect - geometry.videoAspect) < 0.02,
    `video figure follows measured aspect (${geometry.boxAspect.toFixed(3)} vs ${geometry.videoAspect.toFixed(3)})`)
  assert(Math.abs(geometry.topAir - geometry.bottomAir) <= 4,
    `media row balances top and bottom air (${geometry.topAir.toFixed(1)}px vs ${geometry.bottomAir.toFixed(1)}px)`)
  assert(geometry.rowBottom <= geometry.navTop,
    `media row clears fixed navigation (${geometry.rowBottom.toFixed(1)}px <= ${geometry.navTop.toFixed(1)}px)`)
  assert.equal(geometry.zoom, '1', 'presenter autofit leaves the balanced media row at full scale')
  console.log(`MEDIA GEOMETRY 1600x900: top=${geometry.topAir.toFixed(1)}px bottom=${geometry.bottomAir.toFixed(1)}px video=${geometry.boxAspect.toFixed(3)} metadata=${geometry.videoAspect.toFixed(3)}`)

  const activate = async (slideId) => {
    await geometryPage.evaluate((id) => {
      location.hash = `#${id}`
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const target = slides.find((slide) => slide.dataset.id === id)
      slides.forEach((slide) => slide.classList.toggle('active', slide === target))
      window.__autofitForTest?.()
    }, slideId)
    await geometryPage.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
  }
  const bodyFont = async () => geometryPage.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--fs-body)'
    document.querySelector('.slide.active .slide-content')?.append(probe)
    const value = parseFloat(getComputedStyle(probe).fontSize)
    probe.remove()
    return value
  })

  await activate('t19-cards-bare')
  const cardGeometry = await geometryPage.evaluate(() => {
    const slide = document.querySelector('.slide.active')
    const content = slide?.querySelector('.slide-content')
    const head = slide?.querySelector('.slide-head')
    const gallery = slide?.querySelector('.card-gallery')
    const card = slide?.querySelector('.card')
    const heading = card?.querySelector('h4')
    if (!content || !head || !gallery || !card || !heading) return null
    const contentRect = content.getBoundingClientRect()
    const headRect = head.getBoundingClientRect()
    const galleryRect = gallery.getBoundingClientRect()
    return {
      ordinal: getComputedStyle(card, '::after').content,
      headingFont: parseFloat(getComputedStyle(heading).fontSize),
      topAir: galleryRect.top - headRect.bottom,
      bottomAir: contentRect.bottom - galleryRect.bottom,
    }
  })
  assert(cardGeometry, 'body-less cards expose rendered geometry')
  const cardBodyFont = await bodyFont()
  assert.equal(cardGeometry.ordinal, 'none', 'body-less unordered cards paint no ordinal')
  assert(cardGeometry.headingFont >= cardBodyFont * 1.15,
    `body-less card label is claim-sized (${cardGeometry.headingFont.toFixed(1)}px >= ${(cardBodyFont * 1.15).toFixed(1)}px)`)
  assert(Math.abs(cardGeometry.topAir - cardGeometry.bottomAir) <= 4,
    `card row balances top and bottom air (${cardGeometry.topAir.toFixed(1)}px vs ${cardGeometry.bottomAir.toFixed(1)}px)`)

  await activate('t19-cards-numbered')
  const numberedOrdinal = await geometryPage.locator('.slide.active .card').first().evaluate((card) => getComputedStyle(card, '::after').content)
  assert.notEqual(numberedOrdinal, 'none', 'ordered card source paints its requested ordinal')

  await activate('t19-compare-body')
  const compareGeometry = await geometryPage.evaluate(() => {
    const halves = [...document.querySelectorAll('.slide.active .compare-half')]
    const copy = [...document.querySelectorAll('.slide.active .compare-inner .content-p')]
    const labels = [...document.querySelectorAll('.slide.active .compare-label')]
    const bodyBackground = getComputedStyle(document.body).backgroundColor
    const stageRect = document.querySelector('.stage').getBoundingClientRect()
    return {
      widths: halves.map((half) => half.getBoundingClientRect().width),
      heights: halves.map((half) => half.getBoundingClientRect().height),
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      backgrounds: halves.map((half) => getComputedStyle(half).backgroundColor),
      copyFonts: copy.map((paragraph) => parseFloat(getComputedStyle(paragraph).fontSize)),
      copyWeights: copy.map((paragraph) => getComputedStyle(paragraph).fontWeight),
      copyMaxWidths: copy.map((paragraph) => parseFloat(getComputedStyle(paragraph).maxWidth)),
      labelFonts: labels.map((label) => parseFloat(getComputedStyle(label).fontSize)),
      labelFamilies: labels.map((label) => getComputedStyle(label).fontFamily),
      labelLetterSpacing: labels.map((label) => parseFloat(getComputedStyle(label).letterSpacing)),
      labelTransforms: labels.map((label) => getComputedStyle(label).textTransform),
      centreOffsets: halves.map((half) => {
        const halfRect = half.getBoundingClientRect()
        const innerRect = half.querySelector('.compare-inner').getBoundingClientRect()
        return Math.abs((halfRect.top + halfRect.bottom - innerRect.top - innerRect.bottom) / 2)
      }),
      bodyBackground,
    }
  })
  assert.equal(compareGeometry.widths.length, 2, 'compare fixture renders two columns')
  assert(Math.abs(compareGeometry.widths[0] - compareGeometry.widths[1]) <= 1,
    `compare columns have equal widths (${compareGeometry.widths[0].toFixed(1)}px vs ${compareGeometry.widths[1].toFixed(1)}px)`)
  assert(compareGeometry.widths.every((width) => Math.abs(width - compareGeometry.stageWidth / 2) <= 1),
    'each compare column occupies half the stage')
  assert(compareGeometry.heights.every((height) => Math.abs(height - compareGeometry.stageHeight) <= 1),
    'the compare columns carry their backgrounds for the full stage height')
  assert(compareGeometry.copyFonts.every((px) => Math.abs(px - 48) <= 0.1),
    `compare copy uses the mockup's 48px cap (${compareGeometry.copyFonts.join('/')}px)`)
  assert.deepEqual(compareGeometry.copyWeights, ['500', '500'], 'compare copy uses the mockup weight 500')
  assert(compareGeometry.copyMaxWidths.every((px) => Math.abs(px - 576) <= 0.1),
    `compare copy keeps the mockup's 12em measure (${compareGeometry.copyMaxWidths.join('/')}px)`)
  assert(compareGeometry.labelFonts.every((px) => px < 31),
    `compare labels remain deliberate sub-floor chrome (${compareGeometry.labelFonts.join('/')}px)`)
  assert(compareGeometry.labelFonts.every((px, index) => Math.abs(px - compareGeometry.copyFonts[index] * 0.58) <= 0.1),
    'compare labels use the mockup .58em scale')
  assert(compareGeometry.labelFamilies.every((family) => family.includes('monospace')),
    'compare labels use the deck mono face')
  assert(compareGeometry.labelLetterSpacing.every((px, index) => Math.abs(px - compareGeometry.labelFonts[index] * 0.18) <= 0.1),
    'compare labels use the mockup .18em tracking')
  assert.deepEqual(compareGeometry.labelTransforms, ['uppercase', 'uppercase'], 'compare labels are uppercase')
  assert.notEqual(compareGeometry.backgrounds[0], compareGeometry.backgrounds[1], 'the left compare column alone carries the section tint')
  assert.equal(compareGeometry.backgrounds[1], compareGeometry.bodyBackground, 'the right compare column stays on paper')
  assert(compareGeometry.centreOffsets.every((offset) => offset <= 1),
    `both compare columns are vertically centred (${compareGeometry.centreOffsets.map((value) => value.toFixed(1)).join('/')}px offset)`)

  await activate('t19-list-markers')
  const markerGaps = await geometryPage.evaluate(() => [...document.querySelectorAll('.slide.active .fl-sublist > li')].map((item) => ({
    gap: parseFloat(getComputedStyle(item).columnGap),
    font: parseFloat(getComputedStyle(item).fontSize),
    depth: item.closest('.fl-sublist')?.dataset.depth,
  })))
  assert(markerGaps.length >= 4, 'nested-list fixture renders markers at multiple depths')
  for (const marker of markerGaps) {
    assert(marker.gap >= marker.font * 0.4,
      `nested-list marker gap at depth ${marker.depth} is at least 0.4em (${marker.gap.toFixed(1)}px >= ${(marker.font * 0.4).toFixed(1)}px)`)
  }

  await activate('t19-poll-pending')
  const pollGeometry = await geometryPage.evaluate(() => {
    const instruction = document.querySelector('.slide.active .poll-frame-instruction')?.getBoundingClientRect()
    const note = document.querySelector('.slide.active .poll-frame-join-note')?.getBoundingClientRect()
    const chip = document.querySelector('.slide.active .poll-frame-chip')?.getBoundingClientRect()
    const body = document.querySelector('.slide.active .poll-frame-body')
    if (!instruction || !note || !chip || !body) return null
    return {
      instructionLeft: instruction.left,
      instructionBottom: instruction.bottom,
      noteLeft: note.left,
      noteTop: note.top,
      noteBottom: note.bottom,
      chipTop: chip.top,
      noteFont: parseFloat(getComputedStyle(document.querySelector('.slide.active .poll-frame-join-note')).fontSize),
      columns: getComputedStyle(body).gridTemplateColumns.split(' ').length,
    }
  })
  assert(pollGeometry, 'pending poll frame exposes instruction, join note and state chip geometry')
  const pollBodyFont = await bodyFont()
  assert(Math.abs(pollGeometry.noteLeft - pollGeometry.instructionLeft) <= 1,
    `pending join note shares the instruction left edge (${pollGeometry.noteLeft.toFixed(1)}px vs ${pollGeometry.instructionLeft.toFixed(1)}px)`)
  assert(pollGeometry.noteTop >= pollGeometry.instructionBottom, 'pending join note sits below the instruction')
  assert(pollGeometry.chipTop >= pollGeometry.noteBottom, 'poll state chip sits below the pending join note')
  assert.equal(pollGeometry.noteFont, pollBodyFont, 'pending join note uses body-size type')
  assert.equal(pollGeometry.columns, 1, 'poll frame body stays single-column without a real join link')

  console.log(`T19 GEOMETRY 1600x900: cards air=${cardGeometry.topAir.toFixed(1)}/${cardGeometry.bottomAir.toFixed(1)}px claim=${cardGeometry.headingFont.toFixed(1)}px; compare=${compareGeometry.copyFonts.join('/')}px labels=${compareGeometry.labelFonts.join('/')}px widths=${compareGeometry.widths.map((value) => value.toFixed(1)).join('/')}px; marker min=${Math.min(...markerGaps.map((item) => item.gap / item.font)).toFixed(2)}em; poll left=${pollGeometry.instructionLeft.toFixed(1)}/${pollGeometry.noteLeft.toFixed(1)}px`)
  await geometryPage.close()
} finally {
  await geometryBrowser.close()
}

rmSync(screenshotsDir, { recursive: true, force: true })
mkdirSync(screenshotsDir, { recursive: true })
const tempRoot = join(tmpdir(), `tw-layout-sampler-${Date.now()}`)
const vault = join(tempRoot, 'vault')
const talkDir = join(vault, 'layout-sampler')
const userData = join(tempRoot, 'userData')
mkdirSync(join(talkDir, 'assets'), { recursive: true })
mkdirSync(join(vault, 'e2e/fixtures'), { recursive: true })
mkdirSync(userData, { recursive: true })
copyFileSync(samplerOutlinePath, join(talkDir, 'layout-sampler-outline.md'))
for (const asset of samplerMediaAssets) copyFileSync(join(repo, 'scripts/fixtures/layout', asset), join(talkDir, 'assets', asset))
copyFileSync(measuredVideoFixture, join(vault, 'e2e/fixtures/media-row-4x3.mp4'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, TW_E2E: '1' } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1000)
  const outlinePath = join(talkDir, 'layout-sampler-outline.md')
  const content = readFileSync(outlinePath, 'utf8')
  const rows = await page.evaluate(([path, source]) => window.tw.talk.compile(path, source), [outlinePath, content])
  assert(Array.isArray(rows) && rows.length === model.slides.length, 'Electron compiler produces every sampler slide')
  const thumbnails = await page.evaluate(([path, source]) => window.tw.talk.thumbnails(path, source), [outlinePath, content])
  assert(thumbnails && typeof thumbnails === 'object', 'Electron thumbnail renderer returns a map')
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const key = row.render_hash || row.content_hash
    const url = thumbnails[key]
    assert(typeof url === 'string' && url.startsWith('twthumb://'), `slide ${row.slide_id}: thumbnail renders`)
    const loaded = await page.evaluate(async (thumbUrl) => {
      const image = document.createElement('img')
      image.id = 'layout-sampler-shot'
      image.src = thumbUrl
      image.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;background:white;z-index:999999;'
      document.body.append(image)
      await new Promise((resolveImage) => { image.onload = resolveImage; image.onerror = resolveImage })
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight }
    }, url)
    assert(loaded.complete && loaded.width > 0 && loaded.height > 0, `slide ${row.slide_id}: thumbnail is non-empty`)
    await page.locator('#layout-sampler-shot').screenshot({ path: join(screenshotsDir, `${String(index + 1).padStart(3, '0')}-${safeFileName(row.slide_id)}.png`) })
    await page.locator('#layout-sampler-shot').evaluate((image) => image.remove())
  }
} finally {
  await app.close()
}

console.log(`layout sampler: ${entries.length} registry entries, ${model.slides.length} compiled slides, screenshots in ${screenshotsDir}`)
