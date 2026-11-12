// Walks a compiled deck in Chromium the way a presenter does — Next from the first slide to the last, through
// every reveal step — and records, for each slide and step, which elements are clipped: outside the stage, or
// hiding their own content (overflow hidden/clip with more content than box). Each clipped element is keyed by
// its tag and the start of its text (`li|Search files finds and…`), so the same element is recognised in the
// classic look, the Ocean look and an older compiler's output, whatever classes they carry.
//
// Used by test-ocean-look-dom.mjs (and its --record-main mode, which writes the origin/main reference).
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'

export async function clipWalk(htmlPath, { viewport = { width: 1600, height: 900 }, settleMs = 140, maxPresses = 4000, maxStepsPerSlide = 60 } = {}) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.waitForTimeout(400)
    const out = {}
    let lastSignature = ''
    let stuck = 0
    let steps = new Map()
    for (let press = 0; press <= maxPresses; press += 1) {
      const state = await page.evaluate(() => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((s) => s.classList.contains('active'))
        if (!slide) return null
        const signature = `${slides.indexOf(slide)}|${[...slide.querySelectorAll('[data-mode-state]')].map((e) => e.dataset.modeState).join(',')}`
        const stage = slide.getBoundingClientRect()
        const tolerance = 1.5
        const visible = (e) => {
          const cs = getComputedStyle(e)
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }
        const keyOf = (e) => `${e.tagName.toLowerCase()}|${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48) || [...e.classList].slice(0, 2).join('.')}`
        const clips = []
        for (const e of slide.querySelectorAll('*')) {
          if (e.closest('.notes, .sr-only, iframe, svg') && e.tagName.toLowerCase() !== 'svg') continue
          if (!visible(e)) continue
          const r = e.getBoundingClientRect()
          const outside = r.left < stage.left - tolerance || r.top < stage.top - tolerance || r.right > stage.right + tolerance || r.bottom > stage.bottom + tolerance
          const cs = getComputedStyle(e)
          const hides = (['hidden', 'clip'].includes(cs.overflowX) && e.scrollWidth > e.clientWidth + tolerance)
            || (['hidden', 'clip'].includes(cs.overflowY) && e.scrollHeight > e.clientHeight + tolerance)
          if (outside || hides) clips.push(keyOf(e))
        }
        return { id: slide.dataset.id, signature, clips }
      })
      if (!state) break
      if (state.signature === lastSignature) {
        // Nothing moved: a slow step, or focus inside an embed. Take focus back and try twice more before
        // deciding this is the end of the deck.
        stuck += 1
        if (stuck > 3) break
        if (stuck === 3) {
          // Next does not leave this slide (a step that waits on media, say): go to the next slide by its address.
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
      lastSignature = state.signature
      const step = steps.get(state.id) ?? 0
      steps.set(state.id, step + 1)
      if (step >= maxStepsPerSlide) {
        // a slide whose state keeps changing on Next (a deck ending on a {focus} slide): go on by address, or stop
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
      out[`${state.id}#${step}`] = state.clips.sort()
      await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.() })
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(settleMs)
    }
    return out
  } finally {
    await browser.close()
  }
}

/**
 * Keys clipped in `now` that are not clipped (as often) in `before`: [{ at, key }]. A state the reference
 * does not have is compared with nothing, so anything clipped there counts as new (the comparison fails
 * closed); states the reference has and the walk did not reach are reported by `unreachedStates`.
 */
export function newlyClipped(now, before) {
  const out = []
  for (const [at, keys] of Object.entries(now)) {
    const was = before[at] ?? []
    const left = new Map()
    for (const key of was) left.set(key, (left.get(key) ?? 0) + 1)
    for (const key of keys) {
      const n = left.get(key) ?? 0
      if (n > 0) left.set(key, n - 1)
      else out.push({ at, key })
    }
  }
  return out
}


/** States in the reference that the walk never reached: a renamed slide, a lost reveal step or a walk cut short. */
export function unreachedStates(now, before) {
  return Object.keys(before).filter((at) => !(at in now)).sort()
}
