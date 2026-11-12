// Readability of the slide being shown, measured in Chromium the way the audience sees it (0.44 Ocean look checks).
//
// `readabilityProbe` runs inside the page (pass it to page.evaluate) and reports, for the active slide:
//   - contrast: every visible text run whose contrast against the colour actually painted behind it is under WCAG AA
//     (4.5:1; 3:1 for large text: 24px bold or 32px regular and above, measured at the presented size). The colour
//     behind a run is composited from the run's own background (a highlight), then each ancestor's, down to the
//     page; the type's own opacity and its ancestors' are blended in. Runs a reveal or {focus} dims on purpose
//     before it is shown (fuzzy, hidden) are skipped; a passed item (soft) is held to 3:1. A run drawn over a picture is reported as `overImage`
//     (its contrast cannot be computed from colours alone); a run over a background image or gradient is returned in
//     `unresolved` (its own fault kind, never a pass). Every ancestor's opacity is blended into the run, opaque fills or not.
//   - floor: running text under `floorPx` at the presented size (sources, captions and footers have `smallFloorPx`).
//   - emptyShare: the share of the band between the title (or the top margin) and the bottom margin that no
//     visible content covers, by rows of 8px; emptyBand: the largest single uncovered stretch of that band.
// `walkSlides` presses Next from the first slide to the last through every reveal step (as ocean-clip-walk does)
// and calls `perState(page, state)` at each.
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'

export function readabilityProbe({ floorPx = 30, smallFloorPx = 24 } = {}) {
  const slide = document.querySelector('.stage > .slide.active')
  if (!slide) return null
  const srect = slide.getBoundingClientRect()
  const scale = (srect.width / (slide.offsetWidth || srect.width)) * (1600 / srect.width)
  const toScreen = srect.width / (slide.offsetWidth || srect.width)
  const parse = (c) => {
    const text = String(c)
    const srgb = text.match(/color\(srgb\s+([^)]+)\)/)
    if (srgb) {
      const [r, g, b, a = 1] = srgb[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return { r: r * 255, g: g * 255, b: b * 255, a }
    }
    const m = text.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return { r, g, b, a }
  }
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
  const lum = ({ r, g, b }) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  // Not yet revealed (blurred or hidden) is skipped; a passed item (soft) is measured, at 3:1 (dimmed on purpose, but
  // it must stay readable).
  const dimmed = (e) => !!e.closest('[data-mode-state="fuzzy"], [data-mode-state="hidden"], [data-mode-state="before"]')
  const passed = (e) => !!e.closest('[data-mode-state="soft"]')
  const visible = (e) => {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
    }
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > srect.top && r.top < srect.bottom
  }
  // What is painted under a run: the stack of boxes at the run's centre (document.elementsFromPoint, with pointer
  // events forced on so decorative layers count), from the run's own element down, composited until an opaque
  // fill. A box's ::before/::after laid over its whole box counts as its fill (the title tab draws its shape so).
  // A picture met in the stack before an opaque fill makes the run "over a picture".
  const pseudoFill = (n) => {
    for (const pseudo of ['::after', '::before']) {
      const ps = getComputedStyle(n, pseudo)
      const pbg = parse(ps.backgroundColor)
      if (ps.content !== 'none' && ps.position === 'absolute' && ps.display !== 'none' && pbg && pbg.a > 0 && ['top', 'right', 'bottom', 'left'].every((side) => ps[side] === '0px')) return pbg
    }
    return null
  }
  // The colour a single hard-stop linear gradient paints at a point, or null (smooth, several images, or unknown units).
  const hardStopAt = (n, image, at) => {
    const m = image.match(/^linear-gradient\(to (right|left|bottom|top),\s*(.*)\)$/)
    if (!m || /url\(|gradient\([^]*gradient\(/.test(image)) return null
    const parts = m[2].split(/,(?![^()]*\))/).map((part) => part.trim())
    const stops = parts.map((part) => { const mm = part.match(/^(.*\))\s+(-?[\d.]+)px$/); return mm ? { colour: mm[1], pos: Number(mm[2]) } : null })
    if (!stops.length || stops.some((stop) => !stop)) return null
    const r = n.getBoundingClientRect()
    const horizontal = m[1] === 'right' || m[1] === 'left'
    const size = horizontal ? n.offsetWidth : n.offsetHeight
    const scale = (horizontal ? r.width : r.height) / (size || 1)
    let along = horizontal ? (at.x - r.left) / scale : (at.y - r.top) / scale
    if (m[1] === 'left' || m[1] === 'top') along = size - along
    let before = stops[0]
    let after = stops[stops.length - 1]
    for (let i = 0; i < stops.length; i += 1) { if (stops[i].pos <= along) before = stops[i]; else { after = stops[i]; break } }
    if (along >= stops[stops.length - 1].pos) return parse(stops[stops.length - 1].colour)
    return before.colour === after.colour ? parse(before.colour) : null
  }
  const backdrop = (e, at) => {
    let opacity = 1
    for (let n = e; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity)
    const stack = document.elementsFromPoint(at.x, at.y)
    const from = stack.indexOf(e)
    const below = from >= 0 ? stack.slice(from) : [e, ...stack]
    // what is painted over the run first (elements above it in the stack that are not its own children): a fill there
    // is laid over the ink and the ground alike (a near-opaque white sheet leaves white on white); a picture or a
    // gradient there leaves the run unresolved
    const above = []
    let covered = false
    for (const n of (from > 0 ? stack.slice(0, from) : []).reverse()) {
      if (e.contains(n) || n.contains(e)) continue
      // the deck's own controls (the auto-hiding footer bar, outside the slide) are not slide content
      if (!slide.contains(n) || n.closest('.tw-chrome, .slide-controls')) continue
      let alpha = 1
      for (let m = n; m && !m.contains(e); m = m.parentElement) {
        const ms = getComputedStyle(m)
        if (ms.visibility === 'hidden') alpha = 0
        alpha *= Number(ms.opacity)
      }
      if (!(alpha > 0.01)) continue
      const ns = getComputedStyle(n)
      if (n.matches('img, video, canvas, picture, image') || (ns.backgroundImage && ns.backgroundImage !== 'none')) { covered = true; continue }
      const fill = parse(ns.backgroundColor)
      if (fill && fill.a > 0) above.push({ ...fill, a: fill.a * alpha })
    }
    const layers = []
    let overImage = false
    let unresolved = false
    for (const n of below) {
      if (n.matches('img, video, canvas, picture, image') || (n.tagName === 'svg' && !n.closest('.slide-head') && n.getBoundingClientRect().width > 160)) { overImage = layers.every((l) => l.a < 1); break }
      const cs = getComputedStyle(n)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      // a background image or gradient under the run (before an opaque fill above it) cannot be read as one colour:
      // reported as unresolved, never as a pass
      // a gradient sized to a thin line (a rule or a kicker's lead-in, under 12px across) paints no ground for text
      const thinLine = (cs.backgroundSize || '').split(/\s+/).some((token) => /^[\d.]+px$/.test(token) && parseFloat(token) < 12)
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !thinLine && layers.every((l) => l.a < 1)) {
        // a gradient whose stops are all one colour is that colour (a flat fill drawn as a gradient); anything else is
        // unresolved
        const stops = [...cs.backgroundImage.matchAll(/(?:rgba?|color)\([^()]*\)/g)].map((m) => m[0])
        let flat = !/url\(/.test(cs.backgroundImage) && stops.length > 0 && stops.every((stop) => stop === stops[0]) ? parse(stops[0]) : null
        // a hard-stop band (a rail drawn as `linear-gradient(to right, c 0, c 448px, transparent 448px)`): the colour
        // of the band the run sits in, when that band is one colour
        if (!flat) flat = hardStopAt(n, cs.backgroundImage, at)
        if (!flat) { unresolved = true; break }
        layers.push(flat)
        if (flat.a >= 1) break
      }
      const fill = pseudoFill(n)
      if (fill) { layers.push(fill); if (fill.a >= 1) break }
      const bg = parse(cs.backgroundColor)
      if (bg && bg.a > 0) layers.push(bg)
      if (bg && bg.a >= 1) break
    }
    let colour = { r: 255, g: 255, b: 255, a: 1 }
    for (const layer of layers.reverse()) colour = over(layer, colour)
    return { colour, opacity, overImage, unresolved: unresolved || covered, above }
  }
  const forceHits = document.createElement('style')
  forceHits.textContent = '.stage > .slide.active, .stage > .slide.active * { pointer-events: auto !important; }'
  document.head.appendChild(forceHits)
  const smallKinds = 'cite, .cite-text, .qr-caption, .slide-source, .statement-source, figcaption, footer, .kicker, .fl-source, .chart-source, small, .sr-only'
  const contrast = []
  const unresolvedRuns = []
  const floor = []
  const seen = new Set()
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue
    const e = t.parentElement
    if (!e || seen.has(e) || e.closest('.notes, .sr-only, script, style, svg, iframe, .tw-chrome, .slide-controls')) continue
    seen.add(e)
    if (!visible(e) || dimmed(e)) continue
    const cs = getComputedStyle(e)
    const text = t.textContent.replace(/\s+/g, ' ').trim().slice(0, 48)
    const px = parseFloat(cs.fontSize) * toScreen * (1600 / srect.width)
    const weight = Number(cs.fontWeight) || 400
    const range = document.createRange(); range.selectNodeContents(t)
    const tr = range.getBoundingClientRect()
    const isSmall = !!e.closest(smallKinds)
    // named chrome, not content: a code block's language label (.code-lang)
    const chrome = !!e.closest('.code-lang')
    if (!chrome && px < (isSmall ? smallFloorPx : floorPx) - 0.5) floor.push({ text, px: Math.round(px * 10) / 10, small: isSmall })
    const ink = parse(cs.color)
    if (!ink) continue
    const { colour: under, opacity, overImage, unresolved, above } = backdrop(e, { x: (tr.left + tr.right) / 2, y: (tr.top + tr.bottom) / 2 })
    // a run inside a layer at opacity 0 (a timeline detail not yet shown) is not drawn at all: nothing to read
    if (opacity === 0) continue
    let shown = over({ ...ink, a: ink.a * opacity }, under)
    let colour = under
    for (const layer of above) { shown = over(layer, shown); colour = over(layer, colour) }
    const value = ratio(shown, colour)
    const large = px >= 32 || (px >= 24 && weight >= 700)
    const need = large || passed(e) ? 3 : 4.5
    if (unresolved) { unresolvedRuns.push({ text }); continue }
    if (value < need - 0.01 || overImage) contrast.push({ text, ratio: Math.round(value * 100) / 100, need, overImage, ink: cs.color, behind: `rgb(${colour.r | 0}, ${colour.g | 0}, ${colour.b | 0})` })
  }
  forceHits.remove()
  // empty share of the content band
  const head = slide.querySelector('.slide-head:not(.slide-head-quiet)')
  const headRect = head?.getBoundingClientRect()
  const titleOnTop = slide.dataset.titleLayout === 'top' && headRect && headRect.height > 0
  const top = titleOnTop ? headRect.bottom : srect.top + srect.height * 0.06
  const bottom = srect.bottom - srect.height * 0.06
  let left = srect.left + srect.width * 0.04
  if (slide.dataset.titleLayout === 'left' && headRect && headRect.width > 0) left = Math.max(left, headRect.right)
  const right = srect.right - srect.width * 0.04
  const content = [...slide.querySelectorAll('.slide-content *')].filter((n) => !n.closest('.slide-head') && n.children.length === 0 && visible(n))
    .map((n) => n.getBoundingClientRect())
  const rows = Math.max(1, Math.floor((bottom - top) / 8))
  let filled = 0
  let run = 0
  let longest = 0
  for (let i = 0; i < rows; i += 1) {
    const y = top + i * 8 + 4
    if (content.some((r) => r.top <= y && r.bottom >= y && r.right > left && r.left < right)) { filled += 1; run = 0 }
    else { run += 1; longest = Math.max(longest, run) }
  }
  return {
    id: slide.dataset.id,
    layout: slide.dataset.layout,
    titleLayout: slide.dataset.titleLayout || '',
    mode: slide.dataset.mode || '',
    ground: getComputedStyle(slide).backgroundColor,
    contrast,
    unresolved: unresolvedRuns,
    floor,
    emptyShare: Math.round((1 - filled / rows) * 100) / 100,
    // the largest single empty band across the content area (gaps between evenly spread items do not add up)
    emptyBand: Math.round((longest / rows) * 100) / 100,
    scale,
  }
}

export async function walkSlides(htmlPath, perState, { viewport = { width: 1600, height: 900 }, settleMs = 160, maxPresses = 4000, maxStepsPerSlide = 60 } = {}) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(400)
    const steps = new Map()
    let last = ''
    let stuck = 0
    for (let press = 0; press <= maxPresses; press += 1) {
      const state = await page.evaluate(() => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((s) => s.classList.contains('active'))
        if (!slide) return null
        return { id: slide.dataset.id, index: slides.indexOf(slide), signature: `${slides.indexOf(slide)}|${[...slide.querySelectorAll('[data-mode-state]')].map((e) => e.dataset.modeState).join(',')}` }
      })
      if (!state) break
      if (state.signature === last) {
        stuck += 1
        if (stuck > 3) break
        if (stuck === 3) {
          const moved = await page.evaluate(() => {
            const slides = [...document.querySelectorAll('.stage > .slide')]
            const next = slides[slides.findIndex((s) => s.classList.contains('active')) + 1]
            if (!next?.dataset.id) return false
            location.hash = next.dataset.id
            return true
          })
          if (!moved) break
        } else {
          await page.evaluate(() => { document.activeElement?.blur?.(); window.focus() })
          await page.keyboard.press('ArrowRight')
        }
        await page.waitForTimeout(settleMs * 3)
        continue
      }
      stuck = 0
      last = state.signature
      const step = steps.get(state.id) ?? 0
      steps.set(state.id, step + 1)
      if (step >= maxStepsPerSlide) {
        // a slide whose state keeps changing on Next (the deck's last slide in some modes): go on by address, or stop
        const moved = await page.evaluate(() => {
          const slides = [...document.querySelectorAll('.stage > .slide')]
          const next = slides[slides.findIndex((s) => s.classList.contains('active')) + 1]
          if (!next?.dataset.id) return false
          location.hash = next.dataset.id
          return true
        })
        if (!moved) break
        await page.waitForTimeout(settleMs * 3)
        continue
      }
      await page.waitForTimeout(settleMs)
      await perState(page, { ...state, step, at: `${state.id}#${step}` })
      await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.() })
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(settleMs)
    }
  } finally {
    await browser.close()
  }
}
