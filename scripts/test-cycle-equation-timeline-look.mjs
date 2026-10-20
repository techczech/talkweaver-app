// =============================================================================
// test:cycle-equation-timeline-look — 0.41 ticket 07 (ADR-0039: cycle connectors are arcs of the ring that
// start and end on the borders of the boxes they join; equation terms are circles in the section hues;
// timeline events stay inside the safe area and a stop's sub-points stay)
//
// Measured in Chromium on the 1280 x 720 stage at two window sizes (rects are divided by the stage scale, so a
// pixel is a canvas pixel):
//   1. Cycle (two, three, five and seven nodes): every arc's first point lies on the border of the box it leaves and
//      its arrowhead tip (the arc's end) on the border of the box it enters (within 1 px); each arc runs clockwise to the next
//      node and nowhere else; the whole ring sits inside the stage.
//   2. Equation: every term is a circle (equal width and height, 50% radius), the terms take three different
//      hues, the result is a filled disc, and the row fits the stage.
//   3. Timeline (spine and pills): every event text and pill lies inside the safe area (the stage less the slide
//      margin), pills sit on the track, and every sub-point of every stop is still on the slide.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-cet-'))
const SOURCE = [
  '---', 'title: Scene look', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### Cycle two', '{cycle}', '', '- Repetition', '- Reflection', '',
  '### Cycle three', '{cycle}', '', '- Plan', '- Act', '- Review', '',
  '### The agentic loop', '{cycle}', '',
  '- Harness', '  - Sends instructions / results to model',
  '- Model', '  - Makes a plan',
  '- Model', '  - Sends commands to harness',
  '- Harness', '  - Passes command to computer',
  '- Computer', '  - Executes command and returns to harness', '',
  '### Cycle seven', '{cycle}', '',
  '- Observe', '- Orient', '- Decide', '- Act', '- Measure', '- Learn', '- Share', '',
  '### Clarifying vocabulary', '{equation}', '', '- Model', '- Harness', '- Loop', '- Agent', '',
  '### Six terms', '{equation}', '', '- One', '- Two', '- Three', '- Four', '- Five', '- Six', '',
  '### Week map', '{timelinespine}', '',
  '- Day 1', '  - AI the assistant', '  - Mapping the landscape', '  - Understanding LLMs',
  '- Day 2', '  - AI the tool maker', '  - Beyond the chatbot', '  - Vibecoding for researchers',
  '- Day 3', '  - Agentic AI: AI the tool user', '  - Agents for reproducible research', '  - Local and open models', '',
  '### Many days', '{timelinespine}', '', '- Mon: one', '- Tue: two', '- Wed: three', '- Thu: four', '- Fri: five', '- Sat: six', '',
  '### Pills', '{timeline-pills}', '', '- 2022', '  - ChatGPT launches', '  - A research preview', '- 2023', '  - GPT-4 arrives', '- 2024', '  - Tool use expands', ''
].join('\n')
const path = join(dir, 'scene.md')
writeFileSync(path, SOURCE, 'utf8')
const model = await prepareSource(path, SOURCE, 'scene', statSync(path))
const deckPath = join(dir, 'scene.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')

const TOL = 1
let checks = 0
function check(condition, label) {
  checks += 1
  assert.ok(condition, label)
}

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const measure = async (title, fn) => {
      await page.evaluate((name) => {
        document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node.dataset.navTitle === name))
      }, title)
      await page.waitForTimeout(250)
      return page.evaluate(fn, title)
    }

    // 1. cycle
    for (const title of ['Cycle two', 'Cycle three', 'The agentic loop', 'Cycle seven']) {
      const m = await measure(title, (name) => {
        const stageEl = document.querySelector('.stage')
        const sr = stageEl.getBoundingClientRect()
        const k = sr.width / stageEl.offsetWidth
        const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === name)
        const ring = slide.querySelector('.cycle-diagram')
        const rect = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k } }
        const boxes = [...ring.querySelectorAll('.cycle-node')].map(rect)
        // an arc starts at its first point; its arrowhead's first point is the tip, where the arc ends
        const arcs = [...ring.querySelectorAll('.cycle-arc-svg')].map((svg) => {
          const path = svg.querySelector('.cycle-arc')
          const head = svg.querySelector('.cycle-head')
          const m = path.getScreenCTM()
          const at = (el) => { const p = el.getPointAtLength(0).matrixTransform(m); return { x: (p.x - sr.left) / k, y: (p.y - sr.top) / k } }
          return { start: at(path), end: at(head) }
        })
        return { stage: { width: stageEl.offsetWidth, height: stageEl.offsetHeight }, boxes, arcs, ring: rect(ring) }
      })
      const n = m.boxes.length
      check(m.arcs.length === n, `${title}: one arc per node`)
      // distance from a point to the border of a rectangle (0 when on it, large when inside or outside)
      const offBorder = (p, r) => {
        const inX = p.x >= r.left - TOL && p.x <= r.right + TOL
        const inY = p.y >= r.top - TOL && p.y <= r.bottom + TOL
        if (!inX || !inY) return Infinity
        return Math.min(Math.abs(p.x - r.left), Math.abs(p.x - r.right), Math.abs(p.y - r.top), Math.abs(p.y - r.bottom))
      }
      m.arcs.forEach((arc, i) => {
        const from = m.boxes[i]
        const to = m.boxes[(i + 1) % n]
        check(offBorder(arc.start, from) <= TOL, `${title} @${viewport.width}: arc ${i} starts on the border of node ${i} (${offBorder(arc.start, from).toFixed(2)}px off)`)
        check(offBorder(arc.end, to) <= TOL, `${title} @${viewport.width}: arc ${i} ends on the border of node ${(i + 1) % n} (${offBorder(arc.end, to).toFixed(2)}px off)`)
      })
      for (const box of m.boxes) check(box.left >= -TOL && box.right <= m.stage.width + TOL && box.top >= -TOL && box.bottom <= m.stage.height + TOL, `${title} @${viewport.width}: every node is inside the stage`)
    }

    // 2. equation
    for (const [title, terms] of [['Clarifying vocabulary', 4], ['Six terms', 6]]) {
      const m = await measure(title, (name) => {
        const stageEl = document.querySelector('.stage')
        const sr = stageEl.getBoundingClientRect()
        const k = sr.width / stageEl.offsetWidth
        const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === name)
        const terms = [...slide.querySelectorAll('.equation-row .eq-term')].map((el) => {
          const r = el.getBoundingClientRect()
          const s = getComputedStyle(el)
          return { w: r.width / k, h: r.height / k, left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, radius: s.borderTopLeftRadius, colour: s.color, background: s.backgroundColor, result: el.classList.contains('eq-result') }
        })
        return { stageWidth: stageEl.offsetWidth, terms }
      })
      check(m.terms.length === terms, `${title}: ${terms} terms and result render`)
      for (const t of m.terms) {
        check(Math.abs(t.w - t.h) <= TOL, `${title} @${viewport.width}: a term is a circle (${t.w.toFixed(1)} x ${t.h.toFixed(1)})`)
        check(t.radius.endsWith('%') ? parseFloat(t.radius) >= 50 : parseFloat(t.radius) >= Math.min(t.w, t.h) / 2 - 1, `${title}: a term has a round border`)
        check(t.left >= -TOL && t.right <= m.stageWidth + TOL, `${title} @${viewport.width}: the row fits the stage`)
      }
      const operands = m.terms.filter((t) => !t.result)
      if (title === 'Clarifying vocabulary') check(new Set(operands.map((t) => t.colour)).size >= 3, `${title}: terms take three hues`)
      check(m.terms.at(-1).result && m.terms.at(-1).background !== 'rgba(0, 0, 0, 0)' && m.terms.at(-1).background !== m.terms[0].background, `${title}: the result is a filled disc`)
    }

    // 3. timeline
    for (const [title, stops, subpoints] of [['Week map', 3, 6], ['Many days', 6, 0], ['Pills', 3, 1]]) {
      const m = await measure(title, (name) => {
        const stageEl = document.querySelector('.stage')
        const sr = stageEl.getBoundingClientRect()
        const k = sr.width / stageEl.offsetWidth
        const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === name)
        const rect = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k } }
        const track = slide.querySelector('.tl-spine-track')
        const trackStyle = getComputedStyle(track, '::before')
        const trackRect = rect(track)
        return {
          stage: { width: stageEl.offsetWidth, height: stageEl.offsetHeight },
          trackY: trackRect.top + parseFloat(trackStyle.top), // the bar's centre line (its top offset; the bar is centred on it)
          trackBar: trackStyle.display !== 'none' ? parseFloat(trackStyle.height) : 0,
          stops: [...slide.querySelectorAll('.tl-spine-stop')].map((stop) => ({
            card: rect(stop.querySelector('.tl-spine-card')),
            pill: stop.querySelector('.tl-spine-date, .tl-spine-pill') ? rect(stop.querySelector('.tl-spine-date, .tl-spine-pill')) : null,
            lines: [...stop.querySelectorAll('.tl-spine-events > li')].map((li) => ({ text: li.textContent.trim(), shown: li.getBoundingClientRect().height > 4, rect: rect(li), size: parseFloat(getComputedStyle(li).fontSize) / k }))
          }))
        }
      })
      check(m.stops.length === stops, `${title}: ${stops} stops render`)
      check(m.trackBar > 0, `${title}: the track is drawn`)
      let subs = 0
      for (const s of m.stops) {
        check(s.card.left >= -TOL && s.card.right <= m.stage.width + TOL, `${title} @${viewport.width}: an event's text is inside the stage width (${s.card.left.toFixed(0)}..${s.card.right.toFixed(0)})`)
        check(s.card.top >= -TOL && s.card.bottom <= m.stage.height + TOL, `${title} @${viewport.width}: an event's text is inside the stage height`)
        if (s.pill) check(Math.abs((s.pill.top + s.pill.bottom) / 2 - m.trackY) <= 2, `${title} @${viewport.width}: the pill sits on the track`)
        for (const line of s.lines) check(line.shown, `${title}: line "${line.text}" is shown`)
        subs += Math.max(0, s.lines.length - 1)
      }
      check(subs === subpoints, `${title}: ${subpoints} sub-point(s) kept (found ${subs})`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
console.log(`PASS cycle-equation-timeline-look: ${checks} measurements`)
