// =============================================================================
// Timeline modes — Composition Ticket 22 (ADR-0005 timelines = sequence; type floor; both-axis
// balance; ADR-0023 §2 full-band structures take the top title).
//
// The contract this guards, on the real sampler deck rendered in Chromium:
//   1. a plain dated list (`- 2022: ChatGPT launches`) and the `**Timeline:**` block form yield the
//      SAME model — stops with date + text (+ detail lines);
//   2. every mode over the same five-entry list (fixtures t22-<mode>) renders FIVE stops, each with
//      a date node and a text node, at 1600×900 and 1280×720;
//   3. every rendered text sits at or above the stage type floor; the presenter's whole-slide zoom
//      stays 1 (nothing is shrunk under the floor to fit);
//   4. the composition ends above the fixed footer band and sits centred in the band: the air
//      between title and track equals the air between track and footer (±6px); nothing clips;
//   5. pills and horizontal timelines over their measured stop caps split into balanced
//      continuation slides (8 stops → 4 + 4) through the spine's continuation mechanism;
//   6. dynamic mode shows all five stops at its LAST reveal step;
//   7. mutation: with the model collapsed to one stop (TW_REINSTATE_TIMELINE_DEFECT=1) this gate FAILS.
// =============================================================================
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { mapBlocksToLayout } from '../compiler/scripts/lib/06-block-renderers.mjs'
import {
  TIMELINE_REFERENCE_VIEWPORTS, TIMELINE_STOPS_PER_SLIDE, timelineGeometricCap, timelineStopChunks
} from '../compiler/scripts/lib/timeline-layout.mjs'

const MODES = ['auto', 'rail', 'columns', 'compact', 'horizontal', 'spine', 'pills', 'dynamic']
const FOOTER_BAND_PX = 61
const AIR_TOLERANCE_PX = 6
const isMutant = process.env.TW_REINSTATE_TIMELINE_DEFECT === '1'

// --- 1. one model for both source forms ----------------------------------------------------------
const listSource = ['- 2022: ChatGPT launches', '- 2023: GPT-4 arrives', '- 2024: Tool use expands']
const blockSource = ['**Timeline:**', '', '- 2022', '  - ChatGPT launches', '- 2023', '  - GPT-4 arrives', '- 2024', '  - Tool use expands']
const fromList = mapBlocksToLayout('timeline', lexMarkdownBlocks(listSource)).find((b) => b.type === 'timeline')
const fromBlock = lexMarkdownBlocks(blockSource).find((b) => b.type === 'timeline')
assert(fromList && fromBlock, 'both source forms lex to a timeline block')
assert.deepEqual(fromList.stops, fromBlock.stops, 'the dated list and the Timeline: block yield the same stops')
assert.deepEqual(fromList.groups, fromBlock.groups, 'the derived group view agrees too')
if (!isMutant) {
  assert.deepEqual(fromList.stops.map((s) => [s.date, s.text]), [['2022', 'ChatGPT launches'], ['2023', 'GPT-4 arrives'], ['2024', 'Tool use expands']], 'each entry is its own stop with the date attached to its text')
}
const withDetail = lexMarkdownBlocks(['**Timeline:**', '', '- 2022', '  - ChatGPT launches', '  - A research preview becomes a product']).find((b) => b.type === 'timeline')
assert.deepEqual(withDetail.stops[0].details, ['A research preview becomes a product'], 'further lines under a stop are its detail lines')

// --- 5. caps: measured geometry admits the constants; cuts are balanced --------------------------
for (const [mode, cap] of Object.entries(TIMELINE_STOPS_PER_SLIDE)) {
  for (const viewport of TIMELINE_REFERENCE_VIEWPORTS) {
    assert(timelineGeometricCap(mode, viewport) >= cap, `${mode}: the ${viewport.width}px stage admits ${cap} stops (geometry allows ${timelineGeometricCap(mode, viewport)})`)
  }
  assert(cap >= 5, `${mode}: the five-stop showcase list fits one slide (cap ${cap})`)
}
assert.deepEqual(timelineStopChunks([1, 2, 3, 4, 5, 6], 5).map((c) => c.length), [3, 3], 'six stops at cap five cut 3 + 3, never 5 + 1')
assert.equal(timelineStopChunks([1, 2, 3, 4, 5], 5), null, 'five stops at cap five stay one slide')

// The mutant compiles into a scratch directory so the committed sampler artefact stays a true build.
const { model, html, outPath } = await buildLayoutSampler(isMutant ? mkdtempSync(join(tmpdir(), 'tw-timeline-mutant-')) : undefined)
for (const base of ['t22-pills-split', 't22-horizontal-split']) {
  const parts = model.slides.filter((slide) => slide.id === base || slide.id.startsWith(`${base}-`))
  assert.equal(parts.length, 2, `${base}: eight stops split into two continuation slides`)
  assert.deepEqual(parts.map((slide) => slide.blocks[0].stops.length), [4, 4], `${base}: the cut is balanced`)
  assert.equal(parts[1].role, 'content', `${base}: the continuation takes the content role`)
  assert.match(parts[1].title, /\(2\/2\)$/, `${base}: the continuation title carries its marker`)
}
for (const mode of MODES) assert(html.includes(`data-id="t22-${mode}"`), `t22-${mode}: fixture compiles`)

// --- 2–4, 6: rendered contract ------------------------------------------------------------------
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of TIMELINE_REFERENCE_VIEWPORTS) {
    const page = await browser.newPage({ viewport })
    await page.goto(pathToFileURL(outPath).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    await page.evaluate(() => document.body.classList.add('chrome-pinned'))
    // Geometry and state are measured, not motion: settle the dynamic mode's .3s fades at once.
    await page.addStyleTag({ content: '.timeline-dynamic .tl-detail, .timeline-dynamic .tl-group, .timeline-dynamic .tl-group::before { transition: none !important; }' })
    const activate = async (id) => {
      await page.evaluate((slideId) => {
        location.hash = `#${slideId}`
        window.dispatchEvent(new HashChangeEvent('hashchange'))
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const target = slides.find((slide) => slide.dataset.id === slideId)
        slides.forEach((slide) => slide.classList.toggle('active', slide === target))
        window.__autofitForTest?.()
      }, id)
      await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
    }
    // Walk to the LAST reveal step the way the layout doctor does (every .mode-el unit reaches
    // data-mode-state="full"; legacy fragments all revealed), then measure.
    const walkToLastStep = async (id) => {
      for (let step = 0; step < 40; step += 1) {
        const pending = await page.evaluate((slideId) => {
          const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.id === slideId)
          const units = [...(slide?.querySelectorAll('.mode-el') ?? [])]
          const fragments = slide?.querySelectorAll('[data-fragment].hidden-fragment').length ?? 0
          return fragments + units.filter((unit) => unit.dataset.modeState !== 'full').length
        }, id)
        if (pending === 0) break
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(20)
      }
      await page.evaluate(() => window.__autofitForTest?.())
      await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
    }
    const measure = (id) => page.evaluate(({ slideId }) => {
      const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.id === slideId)
      const timeline = slide?.querySelector('.timeline')
      const head = slide?.querySelector('.slide-head')
      const footer = document.querySelector('.footer')
      const content = slide?.querySelector('.slide-content')
      if (!slide || !timeline || !head || !footer || !content) return null
      const stops = [...timeline.querySelectorAll('[data-tl-stop]')]
      const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        && !el.closest('.hidden-fragment') && parseFloat(getComputedStyle(el.closest('.mode-el') || el).opacity) > 0.9
      const textNodes = [...timeline.querySelectorAll('[data-tl-date], [data-tl-text], .tl-spine-events li, .tl-detail-big, .tl-detail-more p')].filter((el) => el.textContent.trim() && visible(el))
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--type-floor)'
      slide.append(probe)
      const floor = parseFloat(getComputedStyle(probe).fontSize)
      probe.remove()
      const stageRect = slide.closest('.stage').getBoundingClientRect()
      const clipped = [...timeline.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && (r.left < stageRect.left - 1 || r.right > stageRect.right + 1 || r.top < stageRect.top - 1 || r.bottom > stageRect.bottom + 1)
      }).length
      const trackRect = timeline.getBoundingClientRect()
      const footerRect = footer.getBoundingClientRect()
      return {
        mode: timeline.dataset.timelineMode,
        stops: stops.length,
        stopsVisible: stops.filter(visible).length,
        stopsWithDate: stops.filter((el) => el.querySelector('[data-tl-date]')).length,
        stopsWithText: stops.filter((el) => el.querySelector('[data-tl-text]')).length,
        minFont: Math.min(...textNodes.map((el) => parseFloat(getComputedStyle(el).fontSize))),
        floor,
        topAir: trackRect.top - head.getBoundingClientRect().bottom,
        bottomAir: footerRect.top - trackRect.bottom,
        trackBottom: trackRect.bottom,
        footerTop: footerRect.top,
        zoom: parseFloat(getComputedStyle(content).zoom || '1'),
        clipped
      }
    }, { slideId: id })

    const table = []
    for (const mode of MODES) {
      const id = `t22-${mode}`
      await activate(id)
      if (mode === 'dynamic') await walkToLastStep(id)
      const m = await measure(id)
      assert(m, `${id}: timeline geometry is available at ${viewport.width}×${viewport.height}`)
      assert.equal(m.stops, 5, `${id}: renders 5 stops (got ${m.stops}) at ${viewport.width}×${viewport.height}`)
      assert.equal(m.stopsVisible, 5, `${id}: all 5 stops are visible at the last step`)
      assert.equal(m.stopsWithDate, 5, `${id}: every stop carries a date node`)
      assert.equal(m.stopsWithText, 5, `${id}: every stop carries a text node`)
      assert(m.minFont >= m.floor - 0.1, `${id}: every text is at the floor (${m.minFont.toFixed(1)}px >= ${m.floor.toFixed(1)}px)`)
      assert(m.zoom >= 0.99, `${id}: the presenter zoom stays at 1 (${m.zoom}) — the composition fits the band`)
      assert(m.trackBottom <= m.footerTop + 0.5, `${id}: the composition ends above the footer (${m.trackBottom.toFixed(1)}px <= ${m.footerTop.toFixed(1)}px)`)
      assert(m.trackBottom <= viewport.height - FOOTER_BAND_PX + 0.5, `${id}: composition bottom <= ${viewport.height - FOOTER_BAND_PX}px (${m.trackBottom.toFixed(1)}px)`)
      assert(Math.abs(m.topAir - m.bottomAir) <= AIR_TOLERANCE_PX, `${id}: air above and below the track is equal (${m.topAir.toFixed(1)}px vs ${m.bottomAir.toFixed(1)}px)`)
      assert.equal(m.clipped, 0, `${id}: nothing clips at the stage edge`)
      if (mode === 'dynamic') {
        const lastStep = await page.evaluate(() => {
          const slide = document.querySelector('.stage > .slide.active')
          const details = [...slide.querySelectorAll('.tl-detail')]
          const shown = details.map((el) => parseFloat(getComputedStyle(el).opacity))
          const units = [...slide.querySelectorAll('.mode-el')].map((el) => el.dataset.modeState)
          return { shown, units }
        })
        assert(lastStep.units.length === 0 || lastStep.units.every((state) => state === 'full'), `${id}: the walk reached the all-full last step (${lastStep.units.join(',')})`)
        assert.equal(lastStep.shown.filter((o) => o > 0.5).length, 1, `${id}: exactly one detail card shows at the last step (${lastStep.shown.join('/')})`)
        assert(lastStep.shown[lastStep.shown.length - 1] > 0.5, `${id}: the LAST stop's detail shows at the last step`)
      }
      table.push(`${id}:${m.mode} stops=${m.stops} min=${m.minFont.toFixed(1)}px air=${m.topAir.toFixed(0)}/${m.bottomAir.toFixed(0)} bottom=${m.trackBottom.toFixed(0)}`)
    }
    for (const id of ['t22-pills-split', 't22-pills-split-2', 't22-horizontal-split', 't22-horizontal-split-2']) {
      await activate(id)
      const m = await measure(id)
      assert(m && m.stops === 4 && m.stopsWithDate === 4 && m.stopsWithText === 4, `${id}: continuation part renders its 4 stops`)
      assert(m.zoom >= 0.99 && m.trackBottom <= m.footerTop + 0.5 && m.clipped === 0, `${id}: continuation part fits the band`)
    }
    console.log(`TIMELINE ${viewport.width}x${viewport.height}: ${table.join(' | ')}`)
    await page.close()
  }
} finally {
  await browser.close()
}

// --- 7. mutation: collapse the model to one stop, the gate must fail -----------------------------
if (!isMutant) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TW_REINSTATE_TIMELINE_DEFECT: '1' },
    encoding: 'utf8'
  })
  assert.notEqual(child.status, 0, 'with the model collapsed to one stop the gate fails')
  assert.match(child.stderr, /renders 5 stops|five stops|same stops|split into two/, `mutant fails on its own contract, not elsewhere:\n${child.stderr.slice(-800)}`)
  console.log('timeline modes mutation (model collapsed to one stop): FAILS as required')
}

console.log(isMutant ? 'timeline modes (mutant): PASS — this must not happen' : 'timeline modes: PASS')
