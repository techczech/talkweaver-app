#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

/*
 * Rendered-layout thresholds live here so the Doctor has one inspectable policy.
 * - Content ink below 35% is underfilled, except for the named sparse slide roles.
 * - Running text must compute to at least 31px at the 1600px reference stage; the floor scales
 *   with the rendered stage so smaller viewports apply the same authored-size policy.
 * - Small presentation chrome remains visible in the report but is separated from running text.
 * - A title, statement, or quote with more than three words may not contain an internal one-word
 *   line. A lone final one-word line is a lower-severity widow.
 * - Any visible box outside the stage, or clipped by its own overflow box, is a clip.
 * `emptyRectCellPx` is measurement resolution, not a pass/fail threshold.
 */
const THRESHOLDS = Object.freeze({
  coverageMinimumPercent: 35,
  coverageExemptRoles: new Set(['section-title', 'title', 'closing', 'poll']),
  coverageExemptLayouts: new Set(['section-title', 'title', 'closing', 'poll']),
  typeFloorPx: 31,
  typeFloorReferenceStageWidthPx: 1600,
  // Deliberate presentation chrome. These selectors stay out of `sub-floor-text` and are
  // reported as informational `small-chrome` findings instead.
  smallChromeSelectors: Object.freeze([
    '.kicker',
    '.kicker *',
    // Locked mockup .t-half .half .lab: the .58em compare label is presentation chrome.
    '.compare-label',
    // ADR-0023 §9: the "n / N" continuation mark on a split quote's panel.
    '.quote-continuation',
    '.code-lang',
    '.code-lang *',
    '.poll-frame-eyebrow',
    '.poll-frame-kind',
    '.poll-frame-sep',
    '.poll-frame-chip',
    '.poll-frame-join-note',
    '.slide-qr .qr-caption',
    '.slide-qr .qr-caption *',
    '.footer',
    '.footer *',
    '.gallery-nav',
    '.gallery-nav *',
    '.lightbox-nav',
    '.lightbox-nav *'
  ]),
  oneWordLineBlockMinimumWords: 4,
  geometryTolerancePx: 1,
  emptyRectCellPx: 20
})

const DEFAULT_VIEWPORT = Object.freeze({ width: 1600, height: 900 })
const SMALL_VIEWPORT = Object.freeze({ width: 1280, height: 720 })
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const IMAGE_ASSET_EXTENSIONS = Object.freeze(['webp', 'png', 'jpg', 'jpeg', 'gif'])

function createAssetResolver(sourcePath, { vaultRoot, talkDir } = {}) {
  const sourceDir = dirname(sourcePath)
  const resolvedVaultRoot = vaultRoot ? resolve(vaultRoot) : null
  const resolvedTalkDir = talkDir ? resolve(talkDir) : null
  const served = new Set()
  const missed = new Set()

  const findPoolAsset = (id) => {
    if (!resolvedVaultRoot) return null
    const extensions = id.startsWith('vid-') ? ['jpg'] : IMAGE_ASSET_EXTENSIONS
    for (const extension of extensions) {
      const candidate = join(resolvedVaultRoot, '_assets', `${id}.${extension}`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  const resolveRequest = (requestUrl) => {
    if (!requestUrl.startsWith('file:')) return null
    const pathname = decodeURIComponent(new URL(requestUrl).pathname)
    const name = basename(pathname).replace(/^img-img-/, 'img-')
    if (/^(?:img|vid)-[0-9a-f]{7}$/.test(name)) {
      return { ref: name, path: findPoolAsset(name) }
    }
    const sourceRelative = relative(sourceDir, pathname)
    if (!resolvedTalkDir || !/^assets(?:\/|$)/.test(sourceRelative)) return null
    const candidate = resolve(resolvedTalkDir, sourceRelative)
    if (candidate !== resolvedTalkDir && !candidate.startsWith(`${resolvedTalkDir}/`)) return null
    return { ref: sourceRelative, path: existsSync(candidate) ? candidate : null }
  }

  return {
    async route(route) {
      const asset = resolveRequest(route.request().url())
      if (!asset) return route.fallback()
      if (asset.path) {
        served.add(asset.ref)
        missed.delete(asset.ref)
        return route.fulfill({ path: asset.path })
      }
      missed.add(asset.ref)
      return route.abort('failed')
    },
    summary() {
      return { served: served.size, missed: [...missed].sort() }
    }
  }
}

async function waitForDeckAssets(page, timeoutMs) {
  await page.evaluate(async (timeout) => {
    const images = [...document.querySelectorAll('img')]
    const posterChecks = [...document.querySelectorAll('video[poster]')].map((video) => {
      const probe = new Image()
      probe.src = video.getAttribute('poster')
      return { video, probe }
    })
    const ready = () => images.every((image) => image.complete && image.naturalWidth > 0)
      && posterChecks.every(({ probe }) => probe.complete && probe.naturalWidth > 0)
    if (!ready()) {
      await Promise.race([
        new Promise((resolveReady) => {
          const check = () => ready() ? resolveReady() : setTimeout(check, 20)
          check()
        }),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeout))
      ])
    }
    for (const image of images) {
      image.toggleAttribute('data-layout-doctor-asset-missing', !image.complete || image.naturalWidth === 0)
    }
    for (const { video, probe } of posterChecks) {
      video.toggleAttribute('data-layout-doctor-asset-missing', !probe.complete || probe.naturalWidth === 0)
    }
  }, timeoutMs)
}

function deckSlug(htmlPath) {
  return basename(htmlPath, '.html')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'deck'
}

function viewportKey(viewport) {
  return `${viewport.width}x${viewport.height}`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normaliseViewports(viewports) {
  const input = Array.isArray(viewports) && viewports.length ? viewports : [DEFAULT_VIEWPORT]
  const seen = new Set()
  return input.map(({ width, height }) => ({ width: Number(width), height: Number(height) }))
    .filter(({ width, height }) => width > 0 && height > 0)
    .filter((viewport) => {
      const key = viewportKey(viewport)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function buildCensus(slides, viewport) {
  const offendingSlideIds = new Set()
  const slidesByClass = new Map()
  for (const slide of slides) {
    for (const failure of slide.failures.filter((finding) => finding.viewport === viewport)) {
      offendingSlideIds.add(slide.id)
      if (!slidesByClass.has(failure.class)) slidesByClass.set(failure.class, new Set())
      slidesByClass.get(failure.class).add(slide.id)
    }
  }
  return {
    viewport,
    offendingSlides: offendingSlideIds.size,
    classes: Object.fromEntries([...slidesByClass].map(([name, ids]) => [name, ids.size]))
  }
}

async function navigateToLastStep(page, slideId, slideIndex) {
  await page.evaluate(({ id, index }) => {
    location.hash = `#${id}`
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    const slides = [...document.querySelectorAll('.stage > .slide')]
    if (!slides[index]?.classList.contains('active')) {
      slides.forEach((slide, candidateIndex) => slide.classList.toggle('active', candidateIndex === index))
    }
  }, { id: slideId, index: slideIndex })
  await page.waitForTimeout(50)

  const authoredMode = await page.evaluate((id) => {
    const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.id === id)
    return slide?.dataset.mode === 'reveal' || slide?.dataset.mode === 'focus'
  }, slideId)

  if (authoredMode) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await page.evaluate((id) => {
        const active = document.querySelector('.stage > .slide.active')
        const target = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.id === id)
        const units = target ? [...target.querySelectorAll('.mode-el')] : []
        return {
          stillActive: active === target,
          hasUnits: units.length > 0,
          full: units.length > 0 && units.every((unit) => unit.dataset.modeState === 'full')
        }
      }, slideId)
      if (!state.stillActive || state.full) break
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(20)
      if (!state.hasUnits && attempt > 2) break
    }
  } else {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await page.evaluate((id) => {
        const active = document.querySelector('.stage > .slide.active')
        const target = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.id === id)
        const hidden = target?.querySelectorAll('[data-fragment].hidden-fragment').length ?? 0
        return { stillActive: active === target, hidden }
      }, slideId)
      if (!state.stillActive || state.hidden === 0) break
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(20)
    }
  }

  // Static fixture decks have no presenter runtime. This marker is also a stable hook for
  // reproducing a last-step-only defect without exporting the presenter's internal state.
  await page.evaluate((id) => {
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const target = slides.find((node) => node.dataset.id === id)
    slides.forEach((slide) => slide.classList.toggle('active', slide === target))
    target?.classList.add('layout-doctor-last-step')
    target?.querySelectorAll('[data-fragment].hidden-fragment').forEach((node) => node.classList.remove('hidden-fragment'))
  }, slideId)
  await page.waitForTimeout(30)
}

async function measureActiveSlide(page, slideId, thresholds) {
  return page.evaluate(({ id, thresholds }) => {
    const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.id === id)
    if (!slide) throw new Error(`Slide not found: ${id}`)
    const stage = slide.closest('.stage') || slide
    const content = slide.querySelector('.slide-content') || slide
    const stageRect = stage.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const tolerance = thresholds.geometryTolerancePx
    const round = (number, places = 2) => Number(Number(number).toFixed(places))
    const alpha = (colour) => {
      const match = String(colour).match(/rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/)
      return match ? Number(match[1] ?? 1) : colour && colour !== 'transparent' ? 1 : 0
    }
    const visible = (element) => {
      if (!(element instanceof Element) || element.closest('.notes, .sr-only')) return false
      let current = element
      while (current && current !== slide.parentElement) {
        const style = getComputedStyle(current)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
        current = current.parentElement
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0.5 && rect.height > 0.5
    }
    const descriptor = (element) => {
      const tag = element.tagName.toLowerCase()
      const idPart = element.id ? `#${element.id}` : ''
      const classPart = [...element.classList].slice(0, 3).map((name) => `.${name}`).join('')
      return `${tag}${idPart}${classPart}`
    }
    const clipRect = (rect, bounds) => {
      const left = Math.max(rect.left, bounds.left)
      const top = Math.max(rect.top, bounds.top)
      const right = Math.min(rect.right, bounds.right)
      const bottom = Math.min(rect.bottom, bounds.bottom)
      return right > left && bottom > top ? { left, top, right, bottom } : null
    }
    const textNodes = []
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!node.textContent.trim() || !visible(node.parentElement)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      if (![...range.getClientRects()].some((rect) => rect.width > 0.5 && rect.height > 0.5)) continue
      textNodes.push(node)
    }

    const inkRects = []
    for (const node of textNodes) {
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        const clipped = clipRect(rect, contentRect)
        if (clipped) inkRects.push(clipped)
      }
    }
    for (const element of slide.querySelectorAll('*')) {
      if (!visible(element) || element === content) continue
      const style = getComputedStyle(element)
      const painted = alpha(style.backgroundColor) > 0
        || parseFloat(style.borderTopWidth) > 0
        || parseFloat(style.borderRightWidth) > 0
        || parseFloat(style.borderBottomWidth) > 0
        || parseFloat(style.borderLeftWidth) > 0
        || /^(IMG|SVG|VIDEO|CANVAS|PICTURE)$/.test(element.tagName)
      if (!painted) continue
      const clipped = clipRect(element.getBoundingClientRect(), contentRect)
      if (clipped) inkRects.push(clipped)
    }

    const unionArea = (rects) => {
      const xs = [...new Set(rects.flatMap((rect) => [rect.left, rect.right]))].sort((a, b) => a - b)
      let area = 0
      for (let index = 0; index < xs.length - 1; index += 1) {
        const left = xs[index]
        const right = xs[index + 1]
        if (right <= left) continue
        const intervals = rects
          .filter((rect) => rect.left < right && rect.right > left)
          .map((rect) => [rect.top, rect.bottom])
          .sort((a, b) => a[0] - b[0])
        let covered = 0
        let start = null
        let end = null
        for (const [top, bottom] of intervals) {
          if (start == null) { start = top; end = bottom; continue }
          if (top <= end) end = Math.max(end, bottom)
          else { covered += end - start; start = top; end = bottom }
        }
        if (start != null) covered += end - start
        area += (right - left) * covered
      }
      return area
    }

    const cell = thresholds.emptyRectCellPx
    const cols = Math.max(1, Math.ceil(stageRect.width / cell))
    const rows = Math.max(1, Math.ceil(stageRect.height / cell))
    const occupied = Array.from({ length: rows }, () => new Uint8Array(cols))
    for (const rect of inkRects) {
      const stageClipped = clipRect(rect, stageRect)
      if (!stageClipped) continue
      const x0 = Math.max(0, Math.floor((stageClipped.left - stageRect.left) / cell))
      const x1 = Math.min(cols - 1, Math.ceil((stageClipped.right - stageRect.left) / cell) - 1)
      const y0 = Math.max(0, Math.floor((stageClipped.top - stageRect.top) / cell))
      const y1 = Math.min(rows - 1, Math.ceil((stageClipped.bottom - stageRect.top) / cell) - 1)
      for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) occupied[y][x] = 1
    }
    const heights = new Uint16Array(cols)
    let largestCells = 0
    for (let y = 0; y < rows; y += 1) {
      const stack = []
      for (let x = 0; x <= cols; x += 1) {
        if (x < cols) heights[x] = occupied[y][x] ? 0 : heights[x] + 1
        const height = x < cols ? heights[x] : 0
        let start = x
        while (stack.length && stack.at(-1).height > height) {
          const prior = stack.pop()
          largestCells = Math.max(largestCells, prior.height * (x - prior.start))
          start = prior.start
        }
        if (!stack.length || stack.at(-1).height < height) stack.push({ start, height })
      }
    }

    const scaledTypeFloorPx = thresholds.typeFloorPx * stageRect.width / thresholds.typeFloorReferenceStageWidthPx
    const smallChrome = []
    const subFloorText = textNodes.flatMap((node) => {
      const px = parseFloat(getComputedStyle(node.parentElement).fontSize)
      if (!(px + 0.01 < scaledTypeFloorPx)) return []
      const finding = { element: descriptor(node.parentElement), px: round(px), text: node.textContent.trim().slice(0, 120) }
      if (thresholds.smallChromeSelectors.some((selector) => node.parentElement.closest(selector))) {
        smallChrome.push(finding)
        return []
      }
      return [finding]
    })

    const lineBlocks = [...slide.querySelectorAll('h1, .layout-statement > .content-p, .layout-statement > p, .statement, .layout-quote blockquote, blockquote')]
      .filter((element, index, all) => visible(element) && all.indexOf(element) === index)
    const oneWordLines = []
    const widows = []
    for (const block of lineBlocks) {
      const words = []
      const blockWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      while (blockWalker.nextNode()) {
        const node = blockWalker.currentNode
        for (const match of node.textContent.matchAll(/\S+/g)) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          const rect = range.getBoundingClientRect()
          if (rect.width > 0.5 && rect.height > 0.5) words.push({ word: match[0], top: rect.top })
        }
      }
      if (words.length < thresholds.oneWordLineBlockMinimumWords) continue
      const lines = []
      for (const word of words) {
        const line = lines.find((candidate) => Math.abs(candidate.top - word.top) <= 2)
        if (line) line.words.push(word.word)
        else lines.push({ top: word.top, words: [word.word] })
      }
      const singleWordLines = lines.filter((candidate) => candidate.words.length === 1)
      for (const line of singleWordLines) {
        const finding = { element: descriptor(block), word: line.words[0], blockWords: words.length }
        const isLastLine = line === lines.at(-1)
        if (!isLastLine || singleWordLines.length > 1) oneWordLines.push(finding)
        if (isLastLine) widows.push(finding)
      }
    }

    const assetMissing = [...slide.querySelectorAll('[data-layout-doctor-asset-missing]')]
      .map((element) => ({
        element: descriptor(element),
        ref: element.getAttribute(element.tagName === 'VIDEO' ? 'poster' : 'src') || ''
      }))

    const clips = []
    for (const element of slide.querySelectorAll('*')) {
      if (!visible(element) || element.closest('.notes, .sr-only')) continue
      const rect = element.getBoundingClientRect()
      const outside = rect.left < stageRect.left - tolerance
        || rect.top < stageRect.top - tolerance
        || rect.right > stageRect.right + tolerance
        || rect.bottom > stageRect.bottom + tolerance
      const style = getComputedStyle(element)
      const clipsOwnContent = ['hidden', 'clip'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + tolerance
        || ['hidden', 'clip'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + tolerance
      if (!outside && !clipsOwnContent) continue
      clips.push({
        element: descriptor(element),
        outsideStage: outside,
        clippedContent: clipsOwnContent,
        rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) }
      })
    }

    const panels = []
    if (slide.dataset.layout === 'quote' || slide.dataset.layout === 'image-quote' || slide.dataset.layout === 'statement') {
      const selector = slide.dataset.layout === 'quote' || slide.dataset.layout === 'image-quote'
        ? '.layout-quote > blockquote, .layout-image-quote blockquote, blockquote'
        : '.statement, .layout-statement > .content-p, .layout-statement > p'
      for (const panel of slide.querySelectorAll(selector)) {
        if (!visible(panel)) continue
        const rect = panel.getBoundingClientRect()
        panels.push({
          element: descriptor(panel),
          fontPx: round(parseFloat(getComputedStyle(panel).fontSize)),
          widthPx: round(rect.width),
          stageWidthPx: round(stageRect.width),
          widthPercent: round(rect.width / stageRect.width * 100)
        })
      }
    }
    const figures = [...slide.querySelectorAll('figure, img:not(figure img), video:not(figure video), canvas:not(figure canvas), .mindmap-mm > svg, .mermaid > svg')]
      .filter((element) => visible(element))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          element: descriptor(element),
          widthPx: round(rect.width),
          heightPx: round(rect.height),
          stageWidthPercent: round(rect.width / stageRect.width * 100),
          stageHeightPercent: round(rect.height / stageRect.height * 100)
        }
      })

    const contentArea = Math.max(1, contentRect.width * contentRect.height)
    const coveragePercent = round(unionArea(inkRects) / contentArea * 100)
    const stageArea = Math.max(1, stageRect.width * stageRect.height)
    const largestEmptyRectanglePercent = round(Math.min(stageArea, largestCells * cell * cell) / stageArea * 100)
    const role = slide.dataset.role || 'content'
    const layout = slide.dataset.layout || ''
    const coverageExempt = thresholds.coverageExemptRoles.includes(role)
      || thresholds.coverageExemptLayouts.includes(layout)
      || slide.hasAttribute('data-poll')
    const failures = []
    if (!assetMissing.length && !coverageExempt && coveragePercent < thresholds.coverageMinimumPercent) {
      failures.push({ class: 'underfilled', coveragePercent, minimumPercent: thresholds.coverageMinimumPercent })
    }
    if (assetMissing.length) failures.push({ class: 'asset-missing', assets: assetMissing })
    if (subFloorText.length) failures.push({ class: 'sub-floor-text', nodes: subFloorText })
    if (smallChrome.length) failures.push({ class: 'small-chrome', nodes: smallChrome, severity: 'informational' })
    if (oneWordLines.length) failures.push({ class: 'one-word-line', lines: oneWordLines })
    if (widows.length) failures.push({ class: 'widow', lines: widows, severity: 'lower' })
    if (clips.length) failures.push({ class: 'clip', elements: clips })

    return {
      stage: { widthPx: round(stageRect.width), heightPx: round(stageRect.height) },
      contentArea: { widthPx: round(contentRect.width), heightPx: round(contentRect.height) },
      coveragePercent,
      largestEmptyRectanglePercent,
      typeFloorPx: round(scaledTypeFloorPx),
      subFloorText,
      smallChrome,
      oneWordLines,
      widows,
      assetMissing,
      clips,
      panels,
      figures,
      failures
    }
  }, {
    id: slideId,
    thresholds: {
      ...thresholds,
      coverageExemptRoles: [...thresholds.coverageExemptRoles],
      coverageExemptLayouts: [...thresholds.coverageExemptLayouts]
    }
  })
}

function contactSheetHtml(slug, offenders, thumbnailDirName) {
  const cards = offenders.map((slide) => {
    const metrics = Object.entries(slide.viewports).map(([viewport, measurement]) => {
      const failures = measurement.failures.map((failure) => failure.class).join(', ')
      return `<li><strong>${escapeHtml(viewport)}</strong>: ${escapeHtml(failures)}; coverage ${measurement.coveragePercent}%; largest empty rectangle ${measurement.largestEmptyRectanglePercent}%.</li>`
    }).join('')
    const thumbnail = slide.thumbnail ? `<img src="${escapeHtml(join(thumbnailDirName, slide.thumbnail))}" alt="${escapeHtml(slide.title)}">` : ''
    return `<article>${thumbnail}<h2>${escapeHtml(slide.index + 1)}. ${escapeHtml(slide.title)}</h2><p>${escapeHtml(slide.layout)} · ${escapeHtml(slide.titleRegime)}</p><ul>${metrics}</ul></article>`
  }).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(slug)} layout offenders</title>
<style>
body{margin:24px;font:14px/1.4 system-ui,sans-serif;color:#101418;background:#f5f5f2}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;align-items:start}article{background:white;border:1px solid #d8d8d2;padding:10px;min-width:0}img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid #ddd}h2{font-size:14px;margin:8px 0 2px}p,ul{margin:4px 0;font-size:11px}ul{padding-left:16px}@media(max-width:1100px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
</style></head><body><h1>${escapeHtml(slug)}: ${offenders.length} offending slides</h1><main class="grid">${cards}</main></body></html>\n`
}

/**
 * Render every slide in one compiled deck and return its geometry plus the failing subset.
 * The function also writes the JSON report, offender thumbnails, and offender contact sheet.
 */
export async function doctorDeck(htmlPath, opts = {}) {
  const sourcePath = resolve(htmlPath)
  const slug = deckSlug(sourcePath)
  const outputDir = resolve(opts.outputDir || join(repoRoot, 'docs', 'layout-doctor'))
  const viewports = normaliseViewports(opts.viewports)
  if (!viewports.length) throw new Error('doctorDeck requires at least one positive viewport')
  mkdirSync(outputDir, { recursive: true })
  const thumbnailDirName = `${slug}-thumbnails`
  const thumbnailDir = join(outputDir, thumbnailDirName)
  mkdirSync(thumbnailDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const slidesById = new Map()
  const assetResolver = createAssetResolver(sourcePath, opts)
  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport })
      await page.route('**/*', (route) => assetResolver.route(route))
      await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      await waitForDeckAssets(page, opts.assetWaitTimeoutMs ?? 2000)
      const slideManifest = await page.locator('.stage > .slide').evaluateAll((slides) => slides.map((slide, index) => {
        const layout = slide.dataset.layout || slide.querySelector('.slide-content')?.className.match(/(?:^|\s)layout-([^\s]+)/)?.[1] || 'unknown'
        const titleRegime = slide.dataset.titleLayout
          || (['title', 'closing', 'opening'].includes(layout) ? 'poster' : '')
          || (slide.querySelector('.slide-head-quiet') ? 'hidden' : '')
          || slide.dataset.titleStyle
          || 'compact'
        return {
          index,
          id: slide.dataset.id || slide.id || `slide-${index + 1}`,
          title: slide.dataset.navTitle || slide.querySelector('h1')?.textContent?.trim() || `Slide ${index + 1}`,
          layout,
          role: slide.dataset.role || 'content',
          titleRegime
        }
      }))
      for (const manifest of slideManifest) {
        await navigateToLastStep(page, manifest.id, manifest.index)
        const measurement = await measureActiveSlide(page, manifest.id, THRESHOLDS)
        const record = slidesById.get(manifest.id) || { ...manifest, viewports: {}, failures: [] }
        const key = viewportKey(viewport)
        record.viewports[key] = measurement
        record.failures.push(...measurement.failures.map((failure) => ({ ...failure, viewport: key })))
        if (measurement.failures.length && !record.thumbnail) {
          const safeId = manifest.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || `slide-${manifest.index + 1}`
          const thumbnail = `${String(manifest.index + 1).padStart(3, '0')}-${safeId}.png`
          await page.screenshot({ path: join(thumbnailDir, thumbnail), fullPage: false })
          record.thumbnail = thumbnail
        }
        slidesById.set(manifest.id, record)
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }

  const slides = [...slidesById.values()].sort((a, b) => a.index - b.index)
  const offenders = slides.filter((slide) => slide.failures.length > 0)
  const census = buildCensus(slides, viewportKey(DEFAULT_VIEWPORT))
  const result = { assets: assetResolver.summary(), census, slides, offenders }
  writeFileSync(join(outputDir, `${slug}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  writeFileSync(join(outputDir, `${slug}-offenders.html`), contactSheetHtml(slug, offenders, thumbnailDirName), 'utf8')
  return result
}

async function cli(argv) {
  const args = [...argv]
  let outputDir = join(repoRoot, 'docs', 'layout-doctor')
  let includeSmall = false
  let vaultRoot = null
  let talkDir = null
  const decks = []
  while (args.length) {
    const arg = args.shift()
    if (arg === '--small') includeSmall = true
    else if (arg === '--output') outputDir = resolve(args.shift() || '')
    else if (arg === '--vault-root') vaultRoot = resolve(args.shift() || '')
    else if (arg === '--talk-dir') talkDir = resolve(args.shift() || '')
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/layout-doctor-render.mjs [--small] [--output DIR] [--vault-root DIR] [--talk-dir DIR] DECK.html [DECK.html ...]')
      return
    } else decks.push(arg)
  }
  if (!decks.length) throw new Error('No compiled deck HTML paths supplied. Use --help for usage.')
  const viewports = includeSmall ? [DEFAULT_VIEWPORT, SMALL_VIEWPORT] : [DEFAULT_VIEWPORT]
  for (const deck of decks) {
    const result = await doctorDeck(deck, { outputDir, viewports, vaultRoot, talkDir })
    console.log(`${deck}: ${result.census.offendingSlides}/${result.slides.length} offending slides; ${JSON.stringify(result.census.classes)} at ${result.census.viewport}; assets served=${result.assets.served} missed=${JSON.stringify(result.assets.missed)}; reports in ${relative(process.cwd(), outputDir) || '.'}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli(process.argv.slice(2))
}
