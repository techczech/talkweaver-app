// Walks a compiled deck in Chromium the way a presenter does — Next from the first slide to the last, through
// every reveal step — and records, for each slide and step, which elements are clipped: outside the stage, or
// hiding their own content (overflow hidden/clip with more content than box). Each clipped element is keyed by
// its tag and the start of its text (`li|Search files finds and…`), so the same element is recognised in the
// classic look, the Ocean look and an older compiler's output, whatever classes they carry.
//
// Used by test-ocean-look-dom.mjs (and its --record-main mode, which writes the origin/main reference).
import { walkSlides } from './slide-readability.mjs'

function clippingProbe() {
  const slide = document.querySelector('.stage > .slide.active')
  if (!slide) throw new Error('no active slide to measure clipping')
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
  return { id: slide.dataset.id, clips: clips.sort() }
}

/**
 * Clipped elements per state (`<slide id>#<n>`, and `<slide id>@card<n>#<k>` for a carousel card Next never shows).
 * Throws when the walk is incomplete, except for slides named in `allowUnreached` (a reference recorded from an older
 * compiler whose Next skips them, each listed with its reason by the caller): those may be unreached.
 */
export async function clipWalk(htmlPath, { allowUnreached = [], ...options } = {}) {
  const out = {}
  const coverage = await walkSlides(htmlPath, async (page, state) => {
    const got = await page.evaluate(clippingProbe)
    if (got.id !== state.id) throw new Error(`active slide changed during clipping measurement: ${state.at}`)
    out[state.at] = got.clips
  }, { settleMs: 140, ...options })
  const allowed = new Set(allowUnreached.map((id) => `unreached slide: ${id}`))
  const issues = coverage.issues.filter((issue) => !allowed.has(issue))
  if (issues.length) throw new Error(`clipping walk incomplete: ${issues.join('; ')}`)
  const unreachedNow = coverage.issues.filter((issue) => allowed.has(issue)).map((issue) => issue.slice('unreached slide: '.length))
  const stale = allowUnreached.filter((id) => !unreachedNow.includes(id))
  if (stale.length) throw new Error(`slides listed as unreached were reached: ${stale.join(', ')}`)
  return out
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

/**
 * The never-worse check with known failures, for one outline in one look. `known` lists real faults still on main:
 * { outline, look, state, key, count, reason }; `count` (default 1) is how many elements with that key clip in that
 * state. Known failures are consumed as a multiset: each listed occurrence waives one newly clipped element, and the
 * walk must clip exactly `count` of them (more is a new failure, fewer means the list is out of date). Returns the
 * problems, empty when the walk is no worse.
 */
export function knownClipProblems(walked, reference, known, outline, look) {
  const allowance = new Map()
  for (const entry of known) {
    if (entry.outline !== outline || entry.look !== look) continue
    const id = `${entry.state}\n${entry.key}`
    allowance.set(id, (allowance.get(id) ?? 0) + (entry.count ?? 1))
  }
  const problems = []
  for (const [id, count] of allowance) {
    const [state, key] = id.split('\n')
    const clipped = (walked[state] || []).filter((k) => k === key).length
    if (clipped < count) problems.push(`known failure clips ${clipped} of ${count} listed times (lower its count or take it off known-clip-failures.json): ${outline} ${look} ${state}: ${key}`)
    if (clipped > count) problems.push(`known failure clips ${clipped} times, ${count} listed: ${outline} ${look} ${state}: ${key}`)
  }
  const left = new Map(allowance)
  for (const { at, key } of newlyClipped(walked, reference)) {
    const id = `${at}\n${key}`
    const n = left.get(id) ?? 0
    if (n > 0) left.set(id, n - 1)
    else problems.push(`newly clipped (no matching historical measurement, not on the known list): ${outline} ${look} ${at}: ${key}`)
  }
  return problems
}
