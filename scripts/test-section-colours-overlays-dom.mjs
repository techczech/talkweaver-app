// =============================================================================
// Section lead colours: every piece of text and every icon that can sit on a lead ground, in each of the five leads.
//
// scripts/fixtures/ocean-look/section-colours-overlays-outline.md holds a section divider, full statements (with a link,
// inline code, key words, a quote and its attribution, a kicker title, steps in turn), a side rail with a QR code and its
// address, icons beside the rail in a reveal, a per-slide countdown under a title tab, a poll, a chart under a tab, and
// sections with an audience section timer, plus the generated title and closing slides. The deck's own bar (counter,
// controls, section label, progress line) is drawn over every slide. The fixture is compiled once per lead
// (`section-colours: <lead>`, so every slide takes that lead) and walked with Next through every state at 1600x900.
//
// Contrast. At each state every visible text run and every painted icon shape in the active slide, in the floating timer
// and in the deck's bar is measured against the ground actually painted under it: the page is screenshotted with all
// text and icons hidden, the run's own line boxes (an icon shape's box) are sampled point by point, the contrast of the
// run's colour (its computed colour with every ancestor's opacity, blended over that point) is taken at each point, and
// the run scores the 10th percentile of those: text that vanishes against part of its ground fails, antialiasing at a
// few edge points does not. Required: 4.5:1, or 3:1 for text of 32px and over, 24px and over in bold, and for icons.
// An icon's colour is read from each painted shape (the stroke and fill of its paths, circles, lines…), not its root.
// A calibration run checks the scoring first: black text on a ground 40% black and 60% white must fail.
//
// Inventory. Every run is counted by family (divider title, statement text, key words, link, inline code, quote,
// attribution, kicker, steps, rail title, tab title, QR caption, list text, icons, countdown, poll, chart labels, title
// slide, closing slide, timer, control bar), nothing is skipped silently: a run that is transparent, hidden, off the
// stage or of a colour that cannot be read is counted as such. At every state each lead must hold the same families with
// the same number of runs as the blue lead, and no run may be unreadable or vanished where blue's is not. The audience
// timer, which the runtime makes a moment after a section is entered, is compared on every slide but the dividers.
//
// Named exclusions, counted in the output and not asserted: text over a picture, a video or an embedded page; SC-6, the
// floating timer drawn over the deck's control bar while the bar shows (every lead and the classic look); SC-7, a reveal's
// steps that are not the current one, faint by design, which must read within 10% of the same step in blue.
//
// Mutations (run after the walk, amber only, each must fail): the rail title made transparent (inventory), the rail title
// given white type (contrast, 2.05:1 on amber), one icon path given the light panel's colour (contrast, read per shape).
//
// Stated limits: shadow roots, iframes and pseudo-element text (the divider's number, CSS `content`) are not read; hover,
// focus and tooltip states are not entered; opacity groups are composited as a product of opacities, not as layers.
// Not measured: the pointer and pen draw a dot and ink, no text; the presenter's chips are drawn in the presenter window.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { writeDeckStyles } from './build-deck-styles.mjs'
import { walkSlides } from './lib/slide-readability.mjs'

const hardStop = setTimeout(() => { console.error('test-section-colours-overlays-dom: hard timeout'); process.exit(124) }, 25 * 60 * 1000)
hardStop.unref()

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repo, '.audit-local'), { recursive: true })
const work = mkdtempSync(join(repo, '.audit-local/section-colours-overlays-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))
writeDeckStyles()
const FIXTURE = join(repo, 'scripts/fixtures/ocean-look/section-colours-overlays-outline.md')
const LEADS = ['blue', 'amber', 'light', 'deep-blue', 'light-amber']
const PERCENTILE = 0.1

// In page: every text run and painted icon shape of the active slide, the floating timer and the deck's bar, each with
// its family, its boxes and its effective colour, or the reason it cannot be measured (counted, never dropped).
function collect() {
  const slide = document.querySelector('.stage > .slide.active')
  if (!slide) return null
  const box = slide.getBoundingClientRect()
  const parse = (c) => { const m = /^rgba?\(([^)]+)\)$/.exec(String(c || '').trim()); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null; return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o }
  const hiddenBy = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none') return 'display' ; if (cs.visibility === 'hidden') return 'visibility' } return '' }
  const media = [...slide.querySelectorAll('img, video, iframe, canvas, object, picture')].filter((m) => !hiddenBy(m)).map((m) => m.getBoundingClientRect()).filter((r) => r.width > 4 && r.height > 4)
  const meets = (r, m) => r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top
  const overMedia = (rects) => rects.some((r) => media.some((m) => meets(r, m)))
  const inStage = (r) => r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom
  const pathOf = (el) => { const parts = []; for (let e = el; e && e !== document.body && parts.length < 5; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '')); return parts.join('>') }
  const bar = document.querySelector('main.deck > footer.footer')
  const barRect = bar && !hiddenBy(bar) && Number(getComputedStyle(bar).opacity) > 0.05 ? bar.getBoundingClientRect() : null
  const overBar = (el, rects) => Boolean(barRect) && !bar.contains(el) && rects.some((r) => meets(r, barRect))
  const head = slide.querySelector(':scope > .slide-content > .slide-head')
  const familyOf = (el, kind) => {
    if (el.closest('.section-timer-float')) return 'timer'
    if (el.closest('main.deck > footer.footer, .progress')) return 'control bar'
    if (slide.dataset.id === 'deck-title') return kind === 'icon' ? 'title slide icon' : 'title slide'
    if (slide.dataset.id === 'deck-thanks') return 'closing slide'
    if (kind === 'icon') return 'icons'
    if (el.closest('.countdown')) return 'countdown'
    if (el.closest('.qr-caption, .slide-qr')) return 'QR caption'
    if (head && head.contains(el)) {
      if (slide.dataset.role === 'section-title') return 'divider title'
      if (slide.dataset.titleLook === 'kicker') return 'kicker'
      return slide.dataset.titleLayout === 'left' ? 'rail title' : slide.dataset.titleLayout === 'top' ? 'tab title' : 'title'
    }
    if (slide.dataset.role === 'section-title') return 'divider text'
    if (el.closest('[class*="poll"]')) return 'poll'
    if (el.closest('[class*="chart"]')) return 'chart labels'
    if (el.closest('.mode-el') && slide.dataset.layout === 'statement') return 'steps'
    if (el.closest('cite, .cite-text, footer, .statement-source')) return 'attribution'
    if (el.closest('blockquote')) return 'quote'
    if (el.closest('code')) return 'inline code'
    if (el.closest('a')) return 'link'
    if (el.closest('strong, b, mark')) return 'key words'
    if (slide.dataset.layout === 'statement') return 'statement text'
    return 'list text'
  }
  const roots = [slide, ...document.querySelectorAll('body > .section-timer-float, main.deck > footer.footer, .progress')]
  const out = []
  const seen = new Set()
  const push = (item) => out.push(item)
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!el || !node.textContent.trim() || seen.has(node)) continue
      seen.add(node)
      // not text the audience reads: notes, scripts, icon glyph text, the deck's screen-reader-only and aria-hidden helpers
      if (el.closest('svg, .notes, script, style, template, [aria-hidden="true"]:not(.section-timer-float):not(.countdown)')) continue
      const family = familyOf(el, 'text')
      const base = { kind: 'text', family, where: root === slide ? 'slide' : pathOf(root), path: pathOf(el), text: node.textContent.trim().slice(0, 40) }
      const hidden = hiddenBy(el)
      if (hidden) { push({ ...base, state: `hidden (${hidden})` }); continue }
      const cs = getComputedStyle(el)
      if ((cs.clip !== 'auto' && cs.clip !== '') || /inset\(50%/.test(cs.clipPath)) { push({ ...base, state: 'screen-reader only' }); continue }
      const range = document.createRange(); range.selectNodeContents(node)
      const all = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1)
      const rects = all.filter(inStage)
      if (!rects.length) { push({ ...base, state: all.length ? 'off the stage' : 'no box' }); continue }
      const fill = cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color && !/0\)$/.test(cs.webkitTextFillColor) ? cs.webkitTextFillColor : cs.color
      const colour = parse(fill)
      if (!colour) { push({ ...base, state: `colour not read (${fill})` }); continue }
      const opacity = opacityOf(el)
      if (opacity < 0.02) { push({ ...base, state: 'not painted at this step (opacity 0)' }); continue }
      const alpha = colour.a * opacity
      const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400
      const dimmed = Boolean(el.closest('.mode-el')) && opacity < 0.95
      push({ ...base, state: alpha < 0.02 ? 'transparent' : 'measured', rects: rects.map((r) => [r.left, r.top, r.width, r.height]), colour: [colour.r, colour.g, colour.b], alpha, large: size >= 32 || (size >= 24 && weight >= 700), dimmed, overMedia: overMedia(rects), overBar: overBar(el, rects) })
    }
    for (const svg of root.querySelectorAll('svg')) {
      // pictures, charts, QR codes and figures are graphics of their own, not icons on the ground
      if (svg.closest('.qr-code, .chart, .chart-cols, .slide-figure, figure, .notes') || svg.parentElement?.closest('svg')) continue
      const family = familyOf(svg, 'icon')
      const base = { kind: 'icon', family, where: root === slide ? 'slide' : pathOf(root), path: pathOf(svg), text: '(icon)' }
      const hidden = hiddenBy(svg)
      const r = svg.getBoundingClientRect()
      if (hidden) { push({ ...base, state: `hidden (${hidden})` }); continue }
      if (r.width < 8 || r.height < 8) { push({ ...base, state: 'no box' }); continue }
      if (!inStage(r)) { push({ ...base, state: 'off the stage' }); continue }
      if (opacityOf(svg) < 0.02) { push({ ...base, state: 'not painted at this step (opacity 0)' }); continue }
      // one measurement per painted shape and paint: stroke and fill as the shape is drawn
      const shapes = [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')]
      const paints = []
      for (const shape of shapes) {
        const ss = getComputedStyle(shape)
        if (ss.display === 'none' || ss.visibility === 'hidden') continue
        const sr = shape.getBoundingClientRect()
        const area = sr.width < 2 && sr.height < 2 ? r : sr
        for (const [what, value, width] of [['stroke', ss.stroke, parseFloat(ss.strokeWidth)], ['fill', ss.fill, 1]]) {
          if (!value || value === 'none' || !(width > 0)) continue
          const colour = parse(value)
          if (!colour) { paints.push({ state: `colour not read (${what} ${value})` }); continue }
          const alpha = colour.a * opacityOf(shape) * Number(ss[what === 'stroke' ? 'strokeOpacity' : 'fillOpacity'] || 1)
          if (alpha < 0.02) continue
          paints.push({ state: 'measured', what, colour: [colour.r, colour.g, colour.b], alpha, rect: [area.left, area.top, Math.max(area.width, 2), Math.max(area.height, 2)] })
        }
      }
      if (!paints.length) { push({ ...base, state: 'transparent' }); continue }
      const dimmed = Boolean(svg.closest('.mode-el')) && opacityOf(svg) < 0.95
      // the icon counts once in the inventory; each of its paints is measured
      paints.forEach((paint, i) => push({ ...base, part: i, inventory: i === 0, state: paint.state, rects: paint.rect ? [paint.rect] : undefined, colour: paint.colour, alpha: paint.alpha, large: true, dimmed, overMedia: overMedia([r]), overBar: false }))
    }
  }
  return { id: slide.dataset.id, lead: slide.dataset.lead, role: slide.dataset.role, ground: slide.dataset.ground || '', titleLayout: slide.dataset.titleLayout || '', items: out }
}

const HIDE_ID = 'tw-contrast-ground'
const HIDE_CSS = `*, *::before, *::after { transition: none !important; }
  .stage *, body > .section-timer-float, main.deck > footer.footer, main.deck > footer.footer * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }
  .stage svg:not(.qr-code svg), main.deck > footer.footer svg { visibility: hidden !important; }
  body > .section-timer-float, .stage .countdown { visibility: hidden !important; }`

const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => v / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/** The ground points under each run's boxes: about 400 samples a run, every point kept. */
async function groundPoints(png, rects) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return rects.map((rs) => {
    const pixels = []
    for (const [x, y, w, h] of rs ?? []) {
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y)), x1 = Math.min(info.width, Math.ceil(x + w)), y1 = Math.min(info.height, Math.ceil(y + h))
      const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 400)))
      for (let yy = y0; yy < y1; yy += step) for (let xx = x0; xx < x1; xx += step) { const i = (yy * info.width + xx) * info.channels; pixels.push([data[i], data[i + 1], data[i + 2]]) }
    }
    return pixels
  })
}

/** A run's score: the contrast at the given low percentile of its ground points, and the ground point there. */
export function scoreRun(colour, alpha, points, percentile = PERCENTILE) {
  if (!points.length) return null
  const scored = points.map((ground) => { const fg = colour.map((v, k) => alpha * v + (1 - alpha) * ground[k]); return { value: ratio(fg, ground), ground, fg } })
  scored.sort((p, q) => p.value - q.value)
  return scored[Math.min(scored.length - 1, Math.floor(scored.length * percentile))]
}

// ---- calibration: the scoring itself --------------------------------------------------------------------------------
{
  const black = [22, 24, 29], white = [255, 255, 255]
  const split = [...Array(40).fill(black), ...Array(60).fill(white)]
  const score = scoreRun(black, 1, split)
  assert.ok(score.value < 1.1, `black text on a ground 40% black must score as unreadable (got ${score.value})`)
  assert.ok(ratio(black, white) > 17, 'and on white alone it reads')
  const antialiased = [...Array(96).fill(white), ...Array(4).fill([128, 128, 128])]
  assert.ok(scoreRun(black, 1, antialiased).value > 17, 'a few edge points do not decide a run')
}

async function measureDeck(lead, { css = '', calibrate = false } = {}) {
  const text = readFileSync(FIXTURE, 'utf8').replace(/^title: .*$/m, (line) => `${line}\nsection-colours: ${lead}`)
  const model = await prepareSource(FIXTURE, text, `overlays-${lead}`, statSync(FIXTURE), undefined, { allowedAssetRoots: [dirname(FIXTURE)] })
  const html = join(work, `overlays-${lead}${css ? '-mutated' : ''}.html`)
  writeFileSync(html, css ? String(model.fullHtml).replace('</head>', `<style>${css}</style></head>`) : String(model.fullHtml))
  const results = []
  let calibrated = null
  const coverage = await walkSlides(html, async (page, state) => {
    // the deck's bar held shown (its own pinned state) and still, so it is measured the same way at every state; the
    // audience timer waited for, since the runtime makes it a moment after the slide changes
    await page.evaluate(async () => {
      document.body.classList.add('chrome-pinned')
      if (!document.getElementById('tw-contrast-still')) { const st = document.createElement('style'); st.id = 'tw-contrast-still'; st.textContent = 'main.deck > footer.footer { transition: none !important; }'; document.head.appendChild(st) }
      const slide = document.querySelector('.stage > .slide.active')
      if (slide?.dataset.sectionTimerShow === 'audience') for (let i = 0; i < 30 && !document.querySelector('body > .section-timer-float'); i += 1) await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    })
    const measure = async (label, calibrating = false) => {
      if (calibrating) {
        // end to end: a run on a split ground, put on the slide for one measurement
        await page.evaluate(() => {
          const el = document.createElement('div'); el.id = 'tw-calibration'
          el.style.cssText = 'position:absolute;left:10%;top:10%;z-index:99;font:400 40px/1.2 sans-serif;color:#16181D;background:linear-gradient(to right,#16181D 0 40%,#FFFFFF 40% 100%);padding:0'
          el.textContent = 'Calibration text that must fail'
          document.querySelector('.stage > .slide.active').appendChild(el)
        })
      }
      const got = await page.evaluate(collect)
      if (!got) return
      await page.addStyleTag({ content: HIDE_CSS }).then((h) => h.evaluate((el, id) => { el.id = id }, HIDE_ID))
      const png = await page.screenshot()
      await page.evaluate((id) => document.getElementById(id)?.remove(), HIDE_ID)
      if (calibrating) await page.evaluate(() => document.getElementById('tw-calibration')?.remove())
      const points = await groundPoints(png, got.items.map((item) => item.rects))
      got.items.forEach((item, i) => {
        const base = { lead, at: state.at + label, slide: got.id, role: got.role, ground: got.ground, titleLayout: got.titleLayout, ...item }
        if (calibrating) {
          // a measurement of its own: only the calibration run counts
          if (item.text.startsWith('Calibration text')) { const score = scoreRun(item.colour, item.alpha, points[i]); calibrated = score ? score.value : 0 }
          return
        }
        if (item.state !== 'measured') { results.push({ ...base, ok: item.state === 'transparent' ? false : null }); return }
        const score = scoreRun(item.colour, item.alpha, points[i])
        if (!score) { results.push({ ...base, state: 'no ground', ok: null }); return }
        const need = item.large ? 3 : 4.5
        results.push({ ...base, groundHex: hex(score.ground), fgHex: hex(score.fg), ratio: Math.round(score.value * 100) / 100, need, ok: score.value >= need - 0.005 })
      })
    }
    if (calibrate && calibrated === null) await measure('+calibration', true)
    await measure('')
    // the section timer in its last ten seconds
    if (await page.evaluate(() => Boolean(document.querySelector('body > .section-timer-float')))) {
      await page.evaluate(() => document.querySelector('body > .section-timer-float').classList.add('countdown-final'))
      await measure('+timer-final')
      await page.evaluate(() => document.querySelector('body > .section-timer-float').classList.remove('countdown-final'))
    }
  })
  assert.ok(coverage.complete, `${lead}: incomplete walk ${JSON.stringify(coverage.issues)}`)
  if (calibrate) assert.ok(calibrated !== null && calibrated < 1.5, `the split-ground calibration run must fail in the page (scored ${calibrated})`)
  return results
}

const key = (r) => `${r.at}|${r.family}`
const inventoryOf = (results) => {
  const counts = new Map()
  for (const r of results) {
    if (r.kind === 'icon' && !r.inventory && r.part !== undefined) continue
    const k = key(r); counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}
/** What fails for one lead, measured against blue: contrast, vanished or unreadable runs, inventory differences. */
function judge(results, blue) {
  const problems = []
  for (const r of results) {
    if (r.state === 'transparent') problems.push(`vanished: ${r.at} ${r.family} "${r.text}" (${r.path})`)
    else if (r.state?.startsWith('colour not read')) problems.push(`colour not read: ${r.at} ${r.family} ${r.state}`)
    else if (r.ok === false && !r.overMedia && !r.dimmed && !r.overBar) problems.push(`contrast: ${r.at} ${r.family} ${r.kind} "${r.text}" ${r.fgHex} on ${r.groundHex} ${r.ratio}:1 < ${r.need} (${r.path})`)
  }
  if (blue && blue !== results) {
    const ours = inventoryOf(results), theirs = inventoryOf(blue)
    // the audience timer is made by the runtime a moment after a section is entered, so on the section's divider it may or
    // may not be there yet: it is compared exactly on every other slide, and the dividers are left out of that count
    for (const k of new Set([...ours.keys(), ...theirs.keys()])) if (!k.endsWith('|timer') && (ours.get(k) ?? 0) !== (theirs.get(k) ?? 0)) problems.push(`inventory: ${k} has ${ours.get(k) ?? 0} runs, blue has ${theirs.get(k) ?? 0}`)
    const timers = (rs) => rs.filter((r) => r.family === 'timer' && r.state === 'measured' && r.role !== 'section-title').map((r) => r.at).sort().join(' ')
    if (timers(results) !== timers(blue)) problems.push(`inventory: the timer is measured at other states than in blue (${timers(results).split(' ').length} against ${timers(blue).split(' ').length})`)
    // the off-stage, hidden and no-box runs of blue may not become measured-and-missing elsewhere: the state of each run must match blue's
    const state = (rs) => { const m = new Map(); for (const r of rs) { const k = `${key(r)}|${r.state}`; m.set(k, (m.get(k) ?? 0) + 1) } return m }
    const os = state(results), ts = state(blue)
    for (const k of new Set([...os.keys(), ...ts.keys()])) if (!k.endsWith('|measured') && !k.includes('|timer|') && (os.get(k) ?? 0) !== (ts.get(k) ?? 0)) problems.push(`run state: ${k} ${os.get(k) ?? 0} (blue ${ts.get(k) ?? 0})`)
    const blueDim = new Map(blue.filter((r) => r.dimmed && r.ratio).map((r) => [`${r.at}|${r.path}|${r.text}|${r.part ?? ''}`, r.ratio]))
    for (const r of results) {
      const b = blueDim.get(`${r.at}|${r.path}|${r.text}|${r.part ?? ''}`)
      if (r.dimmed && !r.ok && b !== undefined && r.ratio < b * 0.9) problems.push(`dimmed step fainter than in blue: ${r.at} "${r.text}" ${r.ratio}:1 (blue ${b}:1)`)
    }
  }
  return problems
}

console.log('section colours: text and icons on every lead ground (dom)')
const byLead = {}
for (const lead of LEADS) byLead[lead] = await measureDeck(lead, { calibrate: lead === 'blue' })
console.log('  calibration: black text on a ground 40% black scores under 1.5:1 in the page and in the scoring (fails, as it must)')
writeFileSync(join(repo, '.audit-local/section-colours-overlays.json'), JSON.stringify(byLead, null, 1))
const failures = []
for (const lead of LEADS) {
  const results = byLead[lead]
  const measured = results.filter((r) => r.state === 'measured')
  const families = [...new Set(results.map((r) => r.family))].sort()
  const counted = (pred) => results.filter(pred).length
  console.log(`  ${lead}: ${measured.length} runs measured in ${families.length} families; left out and counted: ${counted((r) => r.overMedia)} over pictures, ${counted((r) => r.ok === false && r.overBar)} SC-6 timer over the control bar, ${counted((r) => r.dimmed)} SC-7 faint reveal steps, ${counted((r) => r.state && r.state !== 'measured' && r.state !== 'transparent')} hidden, off the stage or screen-reader only`)
  const problems = judge(results, lead === 'blue' ? null : byLead.blue)
  if (problems.length) failures.push(`${lead}:\n    ${problems.slice(0, 40).join('\n    ')}${problems.length > 40 ? `\n    … ${problems.length - 40} more` : ''}`)
}
console.log(`  families: ${[...new Set(byLead.blue.map((r) => r.family))].sort().join(', ')}`)

// ---- mutations: each must fail ----------------------------------------------------------------------------------
const MUTATIONS = [
  ['the rail title made transparent', '#stage > .slide[data-lead][data-title-layout="left"] > .slide-content > .slide-head :is(h1, h1 *) { color: transparent !important; -webkit-text-fill-color: transparent !important; }', /vanished: .*rail title|inventory: .*rail title/],
  ['the rail title in white type on amber', '#stage > .slide[data-lead][data-title-layout="left"] > .slide-content > .slide-head :is(h1, h1 *) { color: #FFFFFF !important; -webkit-text-fill-color: #FFFFFF !important; }', /contrast: .*rail title/],
  ['one icon path in the light panel colour', '.slide[data-lead] .feature-list .fl-icon svg path:first-of-type { stroke: #F2F4F7 !important; }', /contrast: .*icons .*icon/],
]
for (const [name, css, expected] of MUTATIONS) {
  const problems = judge(await measureDeck('amber', { css }), byLead.blue)
  const caught = problems.filter((p) => expected.test(p))
  if (caught.length) console.log(`  mutation fails as it must: ${name} (${caught.length} findings, first: ${caught[0].slice(0, 110)})`)
  else failures.push(`mutation not caught: ${name}${problems.length ? ` (other findings: ${problems.slice(0, 3).join('; ')})` : ''}`)
}

if (failures.length) {
  console.error(`\nsection colours (text and icons on every lead ground): failed\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('section colours (text and icons on every lead ground): all pass')
process.exit(0)
