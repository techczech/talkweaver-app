// Readability of the slide being shown, measured in Chromium the way the audience sees it (0.44 Ocean look checks).
//
// `readabilityProbe` runs inside the page (pass it to page.evaluate) and reports, for the active slide:
//   - contrast: every visible text run whose contrast against the colour actually painted behind it is under WCAG AA
//     (4.5:1; 3:1 for large text: 24px bold or 32px regular and above, measured at the presented size). The colour
//     behind a run is composited from the run's own background (a highlight), then each ancestor's, down to the
//     page; the type's own opacity and its ancestors' are blended in. Runs a reveal or {focus} dims on purpose
//     before it is shown (fuzzy, hidden) are skipped; a passed item (soft) is held to 3:1. Pictures and gradients
//     whose painted colour cannot be resolved are returned in `unresolved` (its own fault kind, never a pass).
//     Every ancestor's opacity is blended into the run, opaque fills or not.
//   - floor: running text under `floorPx` at the presented size (sources, captions and footers have `smallFloorPx`).
//     Generated labels are not running text: a code block's language badge and a QR code's address caption are left out
//     of the floor (counted in `exclusions`; contrast still measured). Text broken only by <wbr> is one run.
//   - emptyShare: the share of the band between the title (or the top margin) and the bottom margin that no
//     visible content covers, by rows of 8px; emptyBand: the largest single uncovered stretch of that band.
// `walkSlides` presses Next from the first slide to the last through every reveal step (as ocean-clip-walk does)
// and calls `perState(page, state)` at each.
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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
  // Visually hidden text (a screen-reader caption: 1px box, `clip-path: inset(50%)` or `clip: rect(0 0 0 0)`) is
  // not painted for the audience, so it is not measured; counted as the exclusion `visuallyHidden`. `count` is false
  // when the empty-band measure asks, so exclusions count text runs only.
  const clippedAway = (cs) => /inset\(\s*50%/.test(cs.clipPath || '') || /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(cs.clip || '')
  const visible = (e, count = true) => {
    for (let n = e; n; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (Number(cs.opacity) === 0) { if (count) exclusions.zeroOpacity += 1; return false }
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      if (n !== document.body && n !== document.documentElement && clippedAway(cs)) { if (count) exclusions.visuallyHidden += 1; return false }
    }
    const r = e.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && (r.width <= 1 || r.height <= 1)) { if (count) exclusions.visuallyHidden += 1; return false }
    return r.width > 1 && r.height > 1 && r.bottom > srect.top && r.top < srect.bottom
  }
  // What is painted under a line fragment: the stack of boxes at each sampled intersection (document.elementsFromPoint, with pointer
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
    // A point cannot certify a run straddling a band, even when both endpoints have the same colour.
    if (at.rect) {
      const lo = horizontal ? at.rect.left : at.rect.top
      const hi = horizontal ? at.rect.right : at.rect.bottom
      const origin = horizontal ? r.left : r.top
      if (stops.some(stop => {
        const edge = origin + (['left', 'top'].includes(m[1]) ? size - stop.pos : stop.pos) * scale
        return edge > lo && edge < hi
      })) return null
    }
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
    // what is painted over the run first (elements above it in the stack, including painted children): a fill there
    // is laid over the ink and the ground alike (a near-opaque white sheet leaves white on white); a picture or a
    // gradient there leaves the run unresolved
    const above = []
    let covered = false
    for (const n of (from > 0 ? stack.slice(0, from) : []).reverse()) {
      if (n.contains(e)) continue
      // the deck's own controls (the auto-hiding footer bar, outside the slide) are not slide content
      if (!slide.contains(n) || n.closest('.tw-chrome, .slide-controls')) { exclusions.outsideSlidePaint += 1; continue }
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
      // A large drawing counts as a picture only where one of its painted shapes is under the point: the svg root is
      // hit everywhere in its box, so a label beside a cycle or loop diagram would otherwise sit "over a picture".
      if (n.tagName === 'svg' && !n.closest('.slide-head') && n.getBoundingClientRect().width > 160) {
        if (stack.some((hit) => hit !== n && n.contains(hit))) { overImage = layers.every((l) => l.a < 1); break }
        continue
      }
      if (n.matches('img, video, canvas, picture, image')) { overImage = layers.every((l) => l.a < 1); break }
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
  const exclusions = { codeLanguageFloor: 0, qrCaptionFloor: 0, outsideSlidePaint: 0, zeroOpacity: 0, visuallyHidden: 0, mediaControl: 0 }
  const paintedSiblings = [...slide.querySelectorAll('*')].filter(n => {
    const cs = getComputedStyle(n)
    return (parse(cs.backgroundColor)?.a > 0) || cs.backgroundImage !== 'none' || n.matches('img, video, canvas, picture, image')
  })
  // Text broken only by <wbr> elements inside one inline parent (an address that may wrap after its slashes) is one
  // run with the joined text, and zero-width spaces are left out of its text, so its key is the key the unbroken text
  // had. `continues` marks a text node that an earlier node's run already took in; the run's child index counts
  // neither the <wbr> elements nor the nodes taken in.
  const isBreak = (n) => n?.nodeType === 1 && n.tagName === 'WBR'
  const continues = (n) => {
    let p = n.previousSibling, saw = false
    while (isBreak(p)) { saw = true; p = p.previousSibling }
    return saw && p?.nodeType === 3
  }
  const runOf = (n) => {
    const nodes = [n]
    for (let q = n.nextSibling; q;) {
      let r = q, saw = false
      while (isBreak(r)) { saw = true; r = r.nextSibling }
      if (!saw || r?.nodeType !== 3) break
      nodes.push(r); q = r.nextSibling
    }
    return nodes
  }
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (continues(t)) continue
    const nodes = runOf(t)
    const joined = nodes.map((n) => n.textContent).join('').replace(/\u200B/g, '')
    if (!joined.trim()) continue
    const e = t.parentElement
    if (!e || e.closest('.notes, .sr-only, script, style, svg, iframe, .tw-chrome, .slide-controls')) continue
    // the deck's own control on a video or picture (the ⤢ enlarge button) is media chrome, not slide text
    if (e.closest('.video-enlarge, button[aria-label^="Enlarge"]')) { exclusions.mediaControl += 1; continue }
    if (!visible(e) || dimmed(e)) continue
    const cs = getComputedStyle(e)
    const text = joined.replace(/\s+/g, ' ').trim().slice(0, 48)
    const px = parseFloat(cs.fontSize) * toScreen * (1600 / srect.width)
    const weight = Number(cs.fontWeight) || 400
    const isSmall = !!e.closest(smallKinds)
    // named chrome, not content: a code block's language label (.code-lang)
    const chrome = !!e.closest('.code-lang')
    if (chrome) exclusions.codeLanguageFloor += 1
    // the address caption the compiler writes under a QR code: a generated label under a code the audience scans (the
    // address is shown large when the code is expanded), not running text; contrast still measured
    const qrCaption = !chrome && !!e.closest('.qr-caption')
    if (qrCaption) exclusions.qrCaptionFloor += 1
    const siblingsBefore = [...e.childNodes].slice(0, [...e.childNodes].indexOf(t)).filter((c) => !isBreak(c) && !(c.nodeType === 3 && continues(c)))
    const key = `${e.tagName}|${[...slide.querySelectorAll(e.tagName)].indexOf(e)}|${siblingsBefore.length}|${joined.trim()}`
    if (!chrome && !qrCaption && px < (isSmall ? smallFloorPx : floorPx) - 0.5) floor.push({ key, text, px: Math.round(px * 10) / 10, small: isSmall })
    const ink = parse(cs.color)
    if (!ink) continue
    const fragments = nodes.flatMap((n) => { const range = document.createRange(); range.selectNodeContents(n); return [...range.getClientRects()] })
    const samples = []
    // Partition each line at painted boxes' edges. Sampling both the intersection and
    // its complement matters: the midpoint may be readable while an uncovered end is not.
    const siblings = paintedSiblings.filter(n => n !== e && !n.contains(e))
    for (const rect of fragments) {
      const xs = new Set([rect.left, rect.right]), ys = new Set([rect.top, rect.bottom])
      for (const n of siblings) {
        const r = n.getBoundingClientRect()
        const left = Math.max(r.left, rect.left), right = Math.min(r.right, rect.right)
        const top = Math.max(r.top, rect.top), bottom = Math.min(r.bottom, rect.bottom)
        if (right > left && bottom > top) { xs.add(left); xs.add(right); ys.add(top); ys.add(bottom) }
      }
      const x = [...xs].sort((a, b) => a - b), y = [...ys].sort((a, b) => a - b)
      for (let i = 1; i < x.length; i += 1) for (let j = 1; j < y.length; j += 1) {
        samples.push({ x: (x[i - 1] + x[i]) / 2, y: (y[j - 1] + y[j]) / 2, rect })
      }
    }
    let fault = null
    let unknown = false
    for (const at of samples) {
      const { colour: under, opacity, overImage, unresolved, above } = backdrop(e, at)
      if (opacity === 0) continue
      let shown = over({ ...ink, a: ink.a * opacity }, under)
      let colour = under
      for (const layer of above) { shown = over(layer, shown); colour = over(layer, colour) }
      const value = ratio(shown, colour)
      const need = px >= 32 || (px >= 24 && weight >= 700) || passed(e) ? 3 : 4.5
      unknown ||= unresolved || overImage
      // the lowest ratio over the run's samples is its ratio
      if ((value < need - 0.01 || overImage) && (!fault || value < fault.ratio)) fault = { key, text, ratio: Math.round(value * 100) / 100, need, overImage, ink: cs.color, behind: `rgb(${colour.r | 0}, ${colour.g | 0}, ${colour.b | 0})` }
    }
    if (unknown) unresolvedRuns.push({ key, text })
    else if (fault) contrast.push(fault)
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
  // a leaf is an element with no children but <wbr> break opportunities (which have no box of their own)
  const content = [...slide.querySelectorAll('.slide-content *')].filter((n) => !isBreak(n) && !n.closest('.slide-head') && [...n.children].every(isBreak) && visible(n, false))
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
    exclusions,
    contrast,
    unresolved: unresolvedRuns,
    floor,
    emptyShare: Math.round((1 - filled / rows) * 100) / 100,
    // the largest single empty band across the content area (gaps between evenly spread items do not add up)
    emptyBand: Math.round((longest / rows) * 100) / 100,
    scale,
  }
}

// The deck runtime's own account of where Next stands, read through a hook added to the walked copy of the deck (the
// compiled deck itself is never changed). `slideSteps(slide, kind).max` is the slide's last step, the beat list says
// which beats show the slide, and `leaves` is the runtime's decision that the next press leaves the beat (no step,
// card or image left): what the walker must reach, so the expected states do not depend on the walker's own guess.
const AUDIT_HOOK_MARKER = 'window.__advanceTargetForTest = advanceTarget;'
const AUDIT_HOOK = `
  window.__twAuditPosition = function () {
    try {
      const slide = currentSlide();
      const id = slide && slide.dataset.id;
      const kind = (state.mode && state.mode.kind) || null;
      const allCards = activeGalleryCards();
      const childBeats = carouselChildBeatIndex(beats, id, 0) >= 0;
      const cards = childBeats ? [] : allCards;
      const cardIndex = cards.length ? Math.max(0, Math.min(cards.length - 1, state.reveal)) : 0;
      const plan = slideSteps(slide, kind);
      const top = plan.max;
      const step = Math.max(0, Math.min(top, Number(state.mode && state.mode.step) || 0));
      const remaining = intraBeatStepsRemaining({ cardCount: cards.length, cardIndex, modeOn: top > 0, modeTop: top, modeStep: step });
      const lightbox = state.lightbox || {};
      const zoom = typeof imageStepForward === "function" ? imageStepForward({ stops: imageStops(), lightbox, stepsRemaining: remaining }) : null;
      const slideBeats = [];
      beats.forEach(function (beat, index) { if (slideIdForRuntimeBeat(beat) === id) slideBeats.push(index); });
      return { beat: Number(state.beat) || 0, slideBeats, step, max: top, cards: allCards.length, card: allCards.findIndex(function (c) { return c.classList.contains("active-card"); }), lightbox: lightbox.open ? Number(lightbox.index) || 0 : -1, leaves: remaining === 0 && !zoom };
    } catch (error) { return { error: String(error) }; }
  };`

/** A copy of the deck beside it with the read-only position hook, or the deck itself when it has no runtime. */
function hookedDeck(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8')
  if (!html.includes(AUDIT_HOOK_MARKER)) return { path: htmlPath, cleanup: () => {} }
  const copy = join(dirname(htmlPath), `.${basename(htmlPath, '.html')}.walk-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.html`)
  writeFileSync(copy, html.replace(AUDIT_HOOK_MARKER, () => AUDIT_HOOK_MARKER + AUDIT_HOOK))
  return { path: copy, cleanup: () => rmSync(copy, { force: true }) }
}

function walkStateProbe() {
  const slides = [...document.querySelectorAll('.stage > .slide')]
  const slide = slides.find((s) => s.classList.contains('active'))
  if (!slide) return null
  const modes = [...slide.querySelectorAll('[data-mode-state]')].map(e => e.dataset.modeState)
  const emphasis = [...slide.querySelectorAll('[data-emph-state]')].map(e => e.dataset.emphState)
  const mediaScope = slide.querySelector('.card-gallery[data-exclusive] > .card.active-card') || slide
  const media = [...mediaScope.querySelectorAll('[data-media-step]')].filter(e => {
    if (e.closest('.hidden-fragment')) return false
    for (let n = e; n && n !== slide; n = n.parentElement) if (getComputedStyle(n).display === 'none') return false
    return true
  }).map(e => e.dataset.mediaStep)
  const galleries = [...slide.querySelectorAll('.card-gallery[data-exclusive]')].map(g => {
    const cards = [...g.querySelectorAll(':scope > .card')]
    return { active: cards.findIndex(c => c.classList.contains('active-card')), last: cards.length - 1 }
  })
  const lightbox = document.getElementById('lightbox')
  const imageOpen = Boolean(lightbox && !lightbox.hidden && getComputedStyle(lightbox).display !== 'none')
  const image = imageOpen ? document.getElementById('lightboxCounter')?.textContent?.trim() || '' : null
  const typing = slide.querySelectorAll('.sim-typing, .sim-typing-wait, .sim-typing-rest').length
  const container = slide.querySelector('.ct-overlay')?.outerHTML || ''
  const position = typeof window.__twAuditPosition === 'function' ? window.__twAuditPosition() : null
  const runtime = position && !position.error ? position : null
  const contentSignature = JSON.stringify([slides.indexOf(slide), modes, emphasis, media, galleries, image, container, runtime && [runtime.beat, runtime.step, runtime.card, runtime.lightbox]])
  // What the audience sees, comparable between two builds of the same talk: reveal, emphasis, file, card and image
  // positions, without build-specific markup or runtime counters.
  const visual = JSON.stringify([modes, emphasis, media, galleries.map(g => g.active), image])
  // The same, by stable identities rather than positions, so states can be paired across builds that split text into
  // more reveal units or return to a container differently: each reveal, emphasis or file unit by its tag and text with
  // its state; the container overlay by its text and the tiles carrying a state class (now, done, ...).
  const words = (e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48)
  const unitKey = (e) => `${e.tagName.toLowerCase()}|${words(e)}`
  const overlay = slide.querySelector('.ct-overlay')
  const ident = {
    units: [...slide.querySelectorAll('[data-mode-state]')].map(e => [unitKey(e), e.dataset.modeState]),
    emphasis: [...slide.querySelectorAll('[data-emph-state]')].map(e => [unitKey(e), e.dataset.emphState]),
    media: [...mediaScope.querySelectorAll('[data-media-step]')].map(e => [unitKey(e), e.dataset.mediaStep]),
    cards: galleries.map(g => g.active),
    image,
    container: overlay ? [words(overlay), ...[...overlay.querySelectorAll('[class]')].flatMap(el => [...el.classList].filter(c => /^(now|next|done|current|active|completed|visited|returning|focus)$/.test(c)).map(c => `${unitKey(el)}=${c}`))] : null,
  }
  // The walker's own guess (decks without the runtime): everything shown, every file started, the last card, no image
  // open. Cards are checked apart (cardsShown), so the guess without them is kept too.
  const shown = modes.every(value => value === 'full') && emphasis.every(value => value === 'on') && media.every(value => value === 'playing' || value === 'played') && !imageOpen && !typing
  const guess = shown && galleries.every(g => g.active === g.last)
  // A final file can still be playing when Next leaves. Other cards' files remain waiting by design.
  const terminal = runtime ? runtime.leaves && !typing : guess
  return { id: slide.dataset.id, index: slides.indexOf(slide), terminal, terminalBesideCards: runtime ? terminal : shown, typing, imageOpen, galleries, runtime, runtimeError: position?.error || null, contentSignature, visual, ident, signature: JSON.stringify([contentSignature, typing]) }
}

async function openDeck(page, href) {
  await page.goto('about:blank')
  await page.goto(href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(400)
}

/**
 * Presses Next from the first slide to the last through every reveal step and calls `perState(page, state)` at each
 * settled state (`state.at` is `<slide id>#<n>`). Returns coverage: `complete` is false for every tool limit (a cap,
 * a forced escape, a typing timeout, a stuck or cut-short walk, a missed step or beat) and lists why in `issues`.
 * When the deck has the TalkWeaver runtime, a slide's expected beats and steps come from the runtime (beat list and
 * slideSteps().max); otherwise from the walker's guess. A carousel card that Next never shows is a fault of the deck,
 * not of the walk: it is listed in `neverShown`, then shown directly (its dot) and measured as `<id>@card<n>#<k>`; so is
 * a slide the deck's beat list leaves out (`card: null`, measured as `<id>@slide#<k>`).
 */
export async function walkSlides(htmlPath, perState, { viewport = { width: 1600, height: 900 }, settleMs = 160, maxPresses = 4000, maxStepsPerSlide = 1000, typingTimeoutMs = 30000 } = {}) {
  const deck = hookedDeck(htmlPath)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    const href = pathToFileURL(deck.path).href
    await openDeck(page, href)
    const expectedIds = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].map(s => s.dataset.id))
    // the slides the deck's beat list shows (a carousel child beat shows its parent slide); null without a beat list
    const beatIds = await page.evaluate(() => Array.isArray(window.__deckBeats) ? window.__deckBeats.map((b) => b?.context?.container === 'carousel' ? b.context.sectionId : b?.slideId) : null)
    const reached = new Set(), terminal = new Map(), issues = []
    const neverShown = []
    if (!expectedIds.length) return { complete: true, issues, expectedIds, reachedIds: [], neverShown, runtime: false }
    const steps = new Map()
    const signatures = new Map()
    // runtime accounts, per slide: beats expected and reached, beats left by Next, steps per (beat, card), cards shown
    const expectedBeats = new Map(), beatsReached = new Map(), beatsLeft = new Set(), stepGroups = new Map()
    const cardsSeen = new Map()
    let runtimeSeen = false
    const settleTyping = async (initial) => {
      let state = await page.evaluate(walkStateProbe)
      if (state?.typing) {
        try {
          await page.waitForFunction(() => !document.querySelector('.stage > .slide.active')?.querySelector('.sim-typing, .sim-typing-wait, .sim-typing-rest'), null, { timeout: typingTimeoutMs })
        } catch (error) {
          if (error.name !== 'TimeoutError') throw error
          issues.push(`typing settle cap: ${initial.id}`)
        }
        state = await page.evaluate(walkStateProbe)
      }
      return state
    }
    const noteCards = (state) => {
      const g = state.galleries?.[0]
      if (!g || g.last < 1) return
      if (!cardsSeen.has(state.id)) cardsSeen.set(state.id, { last: g.last, shown: new Set() })
      if (g.active >= 0) cardsSeen.get(state.id).shown.add(g.active)
    }
    let last = ''
    let stuck = 0
    let press = 0
    for (; press <= maxPresses; press += 1) {
      let state = await page.evaluate(walkStateProbe)
      if (!state) { issues.push('no active slide'); break }
      if (state.runtimeError) issues.push(`runtime position unreadable: ${state.id}: ${state.runtimeError.slice(0, 120)}`)
      if (state.signature === last) {
        stuck += 1
        if (stuck > 3) { issues.push(`stuck: ${state.id}`); break }
        // the runtime's last beat, finished: the walk is done (DOM slides after it that no beat shows are a deck
        // fault, handled below, not a reason to force navigation)
        if (stuck === 3 && state.terminal && state.runtime && beatIds && state.runtime.beat >= beatIds.length - 1) break
        if (stuck === 3) {
          const moved = await page.evaluate(() => {
            const slides = [...document.querySelectorAll('.stage > .slide')]
            const next = slides[slides.findIndex((s) => s.classList.contains('active')) + 1]
            if (!next?.dataset.id) return false
            location.hash = next.dataset.id
            return true
          })
          if (!moved) { if (!state.terminal || state.index !== expectedIds.length - 1) issues.push(`navigation stopped: ${state.id}`); break }
          issues.push(`forced navigation escape: ${state.id}`)
        } else {
          await page.evaluate(() => { document.activeElement?.blur?.(); window.focus() })
          await page.keyboard.press('ArrowRight')
        }
        await page.waitForTimeout(settleMs * 3)
        continue
      }
      // Some decks reset the final slide's reveal when Next is pressed past the end.
      // A return to an already measured state closes that finite cycle only after its
      // terminal reveal was measured. Intermediate image/card states still run first.
      if (state.index === expectedIds.length - 1 && terminal.get(state.id) && signatures.get(state.id)?.has(state.signature)) break
      stuck = 0
      const step = steps.get(state.id) ?? 0
      if (step >= maxStepsPerSlide) {
        last = state.signature
        issues.push(`state cap: ${state.id}`)
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
      const initial = state
      state = await settleTyping(initial)
      if (!state || state.id !== initial.id || state.contentSignature !== initial.contentSignature) {
        issues.push(`state changed while settling: ${initial.id}`)
        last = ''
        continue
      }
      last = state.signature
      steps.set(state.id, step + 1)
      if (!signatures.has(state.id)) signatures.set(state.id, new Set())
      signatures.get(state.id).add(state.signature)
      reached.add(state.id)
      terminal.set(state.id, Boolean(terminal.get(state.id)) || state.terminalBesideCards)
      noteCards(state)
      const rt = state.runtime
      if (rt) {
        runtimeSeen = true
        if (!expectedBeats.has(state.id)) expectedBeats.set(state.id, rt.slideBeats)
        if (!beatsReached.has(state.id)) beatsReached.set(state.id, new Set())
        beatsReached.get(state.id).add(rt.beat)
        if (rt.leaves) beatsLeft.add(rt.beat)
        const group = `${state.id}|${rt.beat}|${rt.card}`
        if (!stepGroups.has(group)) stepGroups.set(group, { id: state.id, max: rt.max, steps: new Set() })
        stepGroups.get(group).steps.add(rt.step)
        stepGroups.get(group).max = Math.max(stepGroups.get(group).max, rt.max)
      }
      await perState(page, { ...state, step, at: `${state.id}#${step}` })
      await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.() })
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(settleMs)
    }
    if (press > maxPresses) issues.push('overall press cap')
    const slidesNeverShown = []
    for (const id of expectedIds) {
      // a slide the deck's own beat list leaves out: Next can never show it, a fault of the deck (shown directly below)
      if (!reached.has(id) && runtimeSeen && beatIds && !beatIds.includes(id)) { slidesNeverShown.push(id); continue }
      if (!reached.has(id)) { issues.push(`unreached slide: ${id}`); continue }
      if (expectedBeats.has(id)) {
        for (const beat of expectedBeats.get(id)) {
          if (!beatsReached.get(id).has(beat)) issues.push(`unreached beat: ${id} (beat ${beat + 1})`)
          else if (!beatsLeft.has(beat)) issues.push(`unreached terminal reveal: ${id}`)
        }
      } else if (!terminal.get(id)) issues.push(`unreached terminal reveal: ${id}`)
    }
    // every step from arrival to slideSteps().max measured, per beat and card
    for (const group of stepGroups.values()) {
      const lo = Math.min(...group.steps)
      const missed = []
      for (let n = lo; n <= group.max; n += 1) if (!group.steps.has(n)) missed.push(n)
      if (missed.length) issues.push(`missed steps: ${group.id} (${missed.slice(0, 5).join(', ')} of ${group.max})`)
    }
    // Shows a slide (and a card of it) directly and measures it with its own steps, as `<id>@<label>#<k>`, until Next
    // leaves it. False when it could not be shown.
    const measureDirect = async (id, label, card) => {
      await openDeck(page, href)
      await page.evaluate((target) => { location.hash = target }, id)
      await page.waitForTimeout(settleMs * 3)
      if (card != null) {
        const clicked = await page.evaluate((index) => {
          const dot = document.querySelector('.stage > .slide.active')?.querySelector(`.gallery-dot[data-card-index="${index}"]`)
          if (!dot) return false
          dot.click()
          return true
        }, card)
        if (!clicked) return false
        await page.waitForTimeout(settleMs * 2)
      }
      const here = (state) => state?.id === id && (card == null || state.galleries?.[0]?.active === card)
      let state = await page.evaluate(walkStateProbe)
      if (!here(state)) return false
      let previous = ''
      for (let k = 0; ; k += 1) {
        if (k >= maxStepsPerSlide) { issues.push(`state cap: ${id} ${label}`); break }
        state = await settleTyping(state)
        if (!here(state) || state.signature === previous) break
        previous = state.signature
        await perState(page, { ...state, step: k, at: `${id}@${label}#${k}`, direct: true, card })
        if (state.terminal) break
        await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.() })
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(settleMs)
        state = await page.evaluate(walkStateProbe)
      }
      return true
    }
    // Cards Next never shows: a deck fault. Show each one directly (its dot) and measure it with its own steps.
    for (const [id, seen] of cardsSeen) {
      for (let card = 0; card <= seen.last; card += 1) {
        if (seen.shown.has(card)) continue
        neverShown.push({ id, card, cards: seen.last + 1 })
        if (!await measureDirect(id, `card${card}`, card)) issues.push(`card not shown directly: ${id} card ${card + 1}`)
      }
    }
    // Slides the beat list leaves out: shown by address and measured the same way.
    // An older runtime may refuse to show such a slide even by address: then the deck cannot show it at all. Still a
    // deck fault, listed as not measured (`measured: false`), so the other side's states for it stay unmatched.
    for (const id of slidesNeverShown) {
      const entry = { id, card: null, cards: 0 }
      neverShown.push(entry)
      if (!await measureDirect(id, 'slide', null)) entry.measured = false
    }
    return { complete: issues.length === 0, issues, expectedIds, reachedIds: [...reached], neverShown, runtime: runtimeSeen }
  } finally {
    await browser.close()
    deck.cleanup()
  }
}
