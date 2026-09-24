// =============================================================================
// T27 — poll frames must not overflow at 1280×720. A long matrix poll (5 items × 7 scale labels)
// and long choice/ranking polls overflowed the slide at small stages, and the deck fell back to
// the whole-slide zoom (autofitContent), shrinking the frame below the ADR-0005 type floor.
// The fix (same Ticket 18 ladder the deck runs on lists, wired into poll-frame.css): fitLists now
// treats ol.poll-frame-options and ol.poll-frame-matrix as fittable lists — leading → gap → body
// type down to --type-floor, then one question notch (data-question-fit="stepped") — BEFORE the
// whole-slide zoom is allowed to touch the slide. Options and matrix rows still never paginate
// (poll-display.js pageInfo).
//
// This gate compiles the three T27 fixtures and asserts, per fixture, per viewport (1280×720 and
// 1600×900), on the compiled frame (bare and with the join slot) AND the live projection (the same
// two states: before the join link arrives and after):
//   1. the slide is not overflowed (scrollHeight/scrollWidth <= clientHeight/clientWidth);
//   2. the slide's autofit zoom stays 1 — the ladder spent the slack, not the whole-slide zoom;
//   3. every option and matrix-item label renders at >= --type-floor; scale chips keep their own
//      20px floor and at least one full line of label;
//   4. no option row or chip is clipped by the slide;
//   5. COMPILED/LIVE PARITY (T27b, sharpens ADR-0023): each compiled variant and its live twin
//      measure the SAME box — zoom, listFit, question font size (±1px) and data-question-fit are
//      EQUAL on both sides. A notch that fires on one side only means the question visibly changes
//      size the moment the presenter goes live; that is a failure, not a report line. (The T27b
//      defect was the audience stage's min-height: with container-type:size an auto height resolved
//      through min-height is indefinite, every cqh in the live frame collapsed to its clamp
//      minimum, and the ladder settled elsewhere; base.css now gives the audience stage a definite
//      height: 100vh.)
// Mutation: with the fitLists guard narrowed back (TW_REINSTATE_POLL_FIT_DEFECT=1 strips the poll
// selectors from the guard), every zoom assertion FAILS.
// TW_POLL_SHOTS=<dir> saves hidden-window screenshots.
// =============================================================================
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { makeQrSvg } from '../compiler/scripts/lib/01-cli-utils.mjs'
import { renderPollFrame } from '../compiler/scripts/lib/poll-frame.mjs'

const isMutant = process.env.TW_REINSTATE_POLL_FIT_DEFECT === '1'
const shots = process.env.TW_POLL_SHOTS
if (shots) await mkdir(shots, { recursive: true })

// The fitLists guard selector this ticket added. The mutation strips it from the compiled deck
// (with the comma that separates it from the previous selector), which is exactly "reinstating the
// old guard" — the ladder then never runs on poll frames.
const FIT_GUARD_NEEDLE = ', :scope > .poll-frame ol.poll-frame-options, :scope > .poll-frame ol.poll-frame-matrix'

const HEAD = `---
title: Poll fit probe
auto_title_slide: false
auto_thanks_slide: false
---

`

// (a) rating: 5 items, 7 scale labels — the fixture that overflowed at 1280×720.
const RATING = `${HEAD}
### How useful was each part of the session? {id=fit-rating poll=rating}

- Opening remarks
- The live demo
- Group exercise
- Discussion
- Closing summary

[scale: Not at all, Slightly, Moderately, Somewhat, Very, Highly, Extremely]
`

// (b) single choice: 8 options of ~40 characters each.
const SINGLE = `${HEAD}
### Which of these best describes how you currently prepare your session materials? {id=fit-single poll=single}

- I build every slide by hand from a blank deck
- I reuse last year's deck and edit what changed
- I keep notes in documents and paste them in
- I write an outline and let tooling expand it
- I read a script aloud over a single slide
- I start from a colleague's deck and adapt it
- I fill in a template library from my faculty
- I pay a designer because slides take too long
`

// (c) ranking: 6 options.
const RANKING = `${HEAD}
### Rank what you most want to take away from today {id=fit-rank poll=ranking}

- Fewer meetings
- Faster feedback
- Better templates
- A calmer inbox
- Clearer goals
- More autonomy
`

const FIXTURES = [
  { id: 'fit-rating', type: 'rating', options: 5, source: RATING },
  { id: 'fit-single', type: 'single', options: 8, source: SINGLE },
  { id: 'fit-rank', type: 'ranking', options: 6, source: RANKING },
]
const VIEWPORTS = [[1280, 720], [1600, 900]]

async function compile(dir, name, source) {
  const path = join(dir, `${name}.md`)
  await writeFile(path, source)
  const model = await prepareSource(path, source, name, statSync(path))
  let html = model.fullHtml
  if (isMutant) {
    assert.ok(html.includes(FIT_GUARD_NEEDLE), 'the compiled deck carries the T27 fitLists guard')
    html = html.replace(FIT_GUARD_NEEDLE, '')
  }
  const out = join(dir, `${name}.html`)
  await writeFile(out, html)
  return out
}

// Structure = ordered tag + first class below the frame root, state slots aside (the parity gate's
// comparator). Compiled and live must agree on it in the question view.
const STRUCTURE = (root) => [...root.querySelectorAll('*')]
  .filter((el) => !el.closest('.poll-frame-join') && !el.closest('.poll-frame-qr'))
  .map((el) => el.tagName.toLowerCase() + '.' + ((el.getAttribute('class') || '').split(' ').filter((c) => !['is-live', 'is-result'].includes(c))[0] || ''))
  .filter((tag) => !/poll-frame-(count|bar|total|page|instruction|join-note|continued)/.test(tag))

const MEASURE = () => {
  const slide = document.querySelector('.slide.active')
  const content = slide.querySelector('.slide-content')
  const frame = content.querySelector(':scope > .poll-frame:not([hidden])')
  const floor = frame.closest('.stage, body').clientWidth * 31 / 1600
  const inSlide = (el) => {
    const s = slide.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.top >= s.top - 1 && r.left >= s.left - 1 && r.bottom <= s.bottom + 1 && r.right <= s.right + 1
  }
  const optionLabels = [...frame.querySelectorAll('.poll-frame-option-label')].map((el) => parseFloat(getComputedStyle(el).fontSize))
  const matrixTexts = [...frame.querySelectorAll('.poll-frame-matrix-text')].map((el) => parseFloat(getComputedStyle(el).fontSize))
  const chips = [...frame.querySelectorAll('.poll-frame-matrix-label')].map((el) => ({
    px: parseFloat(getComputedStyle(el).fontSize),
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    clipped: el.scrollHeight > el.clientHeight + 2,
    inSlide: inSlide(el),
  }))
  const optionRows = [...frame.querySelectorAll('.poll-frame-option, .poll-frame-matrix-row')]
  return {
    zoom: content.style.zoom || '1',
    listFit: content.dataset.listFit || null,
    questionFit: frame.getAttribute('data-question-fit'),
    slideOverflow: [slide.scrollHeight - slide.clientHeight, slide.scrollWidth - slide.clientWidth],
    questionPx: parseFloat(getComputedStyle(frame.querySelector('.poll-frame-question')).fontSize),
    minOptionPx: optionLabels.length ? Math.min(...optionLabels) : null,
    minMatrixTextPx: matrixTexts.length ? Math.min(...matrixTexts) : null,
    chips,
    rowsClipped: optionRows.filter((el) => !inSlide(el)).length,
    floor,
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'tw-poll-fit-'))
const decks = []
for (const fixture of FIXTURES) decks.push({ ...fixture, deck: pathToFileURL(await compile(scratch, fixture.id, fixture.source)).href })

const errors = []
const browser = await chromium.launch({ headless: true })
const joinSlot = { shortUrl: 'https://handouts.fyi/fit', qrSvg: makeQrSvg('https://handouts.fyi/fit') }

async function openContext(viewport) {
  const context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] } })
  context.setDefaultTimeout(8000)
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
  await context.addInitScript(() => {
    if (!location.search.includes('presenter=1')) return
    window.twLivePollBridge = {
      action: async () => ({ success: true, status: 'confirmed' }),
      onState: (cb) => { window.__pollStateApply = cb },
      onStatus: (cb) => { window.__pollStatusApply = cb },
      onJoin: (cb) => { window.__pollJoinApply = cb },
      onOperation: (cb) => { window.__pollOperationApply = cb },
    }
  })
  return context
}

try {
  for (const { id, type, options, deck } of decks) {
    for (const viewport of VIEWPORTS) {
      const [w, h] = viewport
      const tag = `${id}@${w}x${h}`
      const context = await openContext(viewport)
      const url = `${deck}#${id}`
      // --- the compiled frame (editor preview / unpaired deck) ----------------------------------
      const plain = await context.newPage()
      await plain.goto(url)
      await plain.locator(`.slide[data-id="${id}"] .slide-content > [data-poll-frame="compiled"]`).waitFor({ state: 'visible' })
      await plain.waitForTimeout(250)
      const compiledStructure = await plain.locator(`.slide[data-id="${id}"] [data-poll-frame="compiled"]`).evaluate(STRUCTURE)
      const compiled = await plain.evaluate(MEASURE)
      if (shots) await plain.screenshot({ path: join(shots, `fit-${id}-compiled-${w}.png`) })
      await plain.close()

      // --- the compiled frame with the join slot filled — the exact markup the compiler would
      //     emit for a session frame (renderPollFrame from the ONE source, join context), refitted
      const withJoin = await context.newPage()
      await withJoin.goto(url)
      await withJoin.locator(`.slide[data-id="${id}"] .slide-content > [data-poll-frame="compiled"]`).waitFor({ state: 'visible' })
      const definition = await withJoin.locator(`.slide[data-id="${id}"]`).evaluate((el) => JSON.parse(el.dataset.poll))
      const joinHtml = renderPollFrame(definition, { title: definition.question, join: joinSlot })
      await withJoin.evaluate(({ id: slideId, html }) => {
        const slide = document.querySelector(`.slide[data-id="${slideId}"]`)
        slide.querySelector('[data-poll-frame="compiled"]').outerHTML = html
        window.__autofitForTest()
      }, { id, html: joinHtml })
      await withJoin.waitForTimeout(250)
      const compiledJoinStructure = await withJoin.locator(`.slide[data-id="${id}"] [data-poll-frame="compiled"]`).evaluate(STRUCTURE)
      const compiledJoin = await withJoin.evaluate(MEASURE)
      if (shots) await withJoin.screenshot({ path: join(shots, `fit-${id}-compiled-join-${w}.png`) })
      await withJoin.close()

      // --- the live projection: presenter with the preload bridge mocked, paired audience window -
      const presenter = await context.newPage()
      await presenter.goto(`${deck}?presenter=1&session=fit-${id}-${w}#${id}`)
      const audiencePromise = context.waitForEvent('page')
      await presenter.locator('#presenterAudienceApp').click()
      const audience = await audiencePromise
      await audience.waitForLoadState()
      await audience.setViewportSize({ width: w, height: h })
      const poll = await presenter.locator(`.slide[data-id="${id}"]`).evaluate((el) => JSON.parse(el.dataset.poll))
      const state = { ...poll, type: 'poll.state', pollType: poll.type, slideId: id, open: true, revealed: false, tallies: {}, responses: [] }
      await presenter.evaluate((message) => window.__pollStateApply(message), state)
      const live = audience.locator('.slide.active .slide-content > [data-poll-frame="live"]')
      await live.waitFor({ state: 'visible' })
      await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.textContent.includes('Accepting responses'))
      await audience.waitForTimeout(250)
      const livePreJoinStructure = await live.evaluate(STRUCTURE)
      const livePreJoin = await audience.evaluate(MEASURE)
      if (shots) await audience.screenshot({ path: join(shots, `fit-${id}-live-prejoin-${w}.png`) })
      await presenter.evaluate((value) => window.__pollJoinApply(value), joinSlot)
      await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"] .poll-frame-qr svg'))
      await audience.waitForTimeout(250)
      const liveStructure = await live.evaluate(STRUCTURE)
      const liveJoin = await audience.evaluate(MEASURE)
      if (shots) await audience.screenshot({ path: join(shots, `fit-${id}-live-${w}.png`) })

      // 1. nothing overflows the slide
      for (const [label, m] of [['compiled', compiled], ['compiled+join', compiledJoin], ['live', livePreJoin], ['live+join', liveJoin]]) {
        assert.ok(m.slideOverflow[0] <= 0 && m.slideOverflow[1] <= 0, `${tag} ${label}: the slide is not overflowed (h=${m.slideOverflow[0]}, w=${m.slideOverflow[1]})`)
      }
      // 2. the ladder spent the slack — for the bare fixtures the whole-slide zoom never engages;
      //    with the join slot (d) a sub-1% zoom is tolerated and reported
      assert.equal(compiled.zoom, '1', `${tag} compiled: zoom stays 1 (got ${compiled.zoom}, listFit=${compiled.listFit})`)
      for (const [label, m] of [['compiled+join', compiledJoin], ['live+join', liveJoin]]) {
        assert.ok(parseFloat(m.zoom) >= 0.95, `${tag} ${label}: zoom stays negligible (got ${m.zoom}, listFit=${m.listFit})`)
        if (m.zoom !== '1') console.log(`poll fit report: ${tag} ${label} needs zoom ${m.zoom}`)
      }
      for (const [label, m] of [['compiled', compiled], ['compiled+join', compiledJoin], ['live', livePreJoin], ['live+join', liveJoin]]) {
        const ladderOk = ['base', 'leading', 'gap', 'type', 'too-long'].includes(m.listFit)
        assert.ok(ladderOk && !(m.listFit === 'too-long' && m.zoom === '1'), `${tag} ${label}: the ladder resolved the frame (listFit=${m.listFit})`)
      }
      // 3. type floors: options and matrix items at >= --type-floor, chips >= their 20px floor and
      //    at least one full line of label
      for (const [label, m] of [['compiled', compiled], ['compiled+join', compiledJoin], ['live', livePreJoin], ['live+join', liveJoin]]) {
        if (m.minOptionPx !== null) {
          assert.ok(m.minOptionPx >= m.floor - 0.5, `${tag} ${label}: every option label >= type floor (${m.minOptionPx} < ${m.floor})`)
        }
        if (m.minMatrixTextPx !== null) {
          assert.ok(m.minMatrixTextPx >= m.floor - 0.5, `${tag} ${label}: every matrix item label >= type floor (${m.minMatrixTextPx} < ${m.floor})`)
        }
        for (const chip of m.chips) {
          assert.ok(chip.px >= 20 - 0.5, `${tag} ${label}: scale chips keep their 20px floor (${chip.px})`)
          assert.ok(chip.lines >= 1, `${tag} ${label}: scale chips keep at least one full line of label`)
          assert.equal(chip.clipped, false, `${tag} ${label}: no scale chip label is clipped`)
        }
      }
      // 4. no option row or chip is clipped by the slide
      for (const [label, m] of [['compiled', compiled], ['compiled+join', compiledJoin], ['live', livePreJoin], ['live+join', liveJoin]]) {
        assert.equal(m.rowsClipped, 0, `${tag} ${label}: no option or matrix row is clipped by the slide`)
      }
      // 5. compiled/live parity, per join variant (T27b): the live twin of each compiled variant
      //    measures the SAME box and reaches the SAME verdict. Same stage, same markup, same
      //    engine — so zoom, listFit, question size (±1px) and the question notch must be equal.
      //    A notch that fires on one side only changes the question's size the moment the presenter
      //    goes live; that is this gate's failure, never a report line.
      for (const [variant, compiledSide, compiledStructureSide, liveSide, liveStructureSide] of [
        ['bare', compiled, compiledStructure, livePreJoin, livePreJoinStructure],
        ['with join', compiledJoin, compiledJoinStructure, liveJoin, liveStructure],
      ]) {
        assert.deepEqual(liveStructureSide, compiledStructureSide, `${tag} ${variant}: the live frame has the same class structure as the compiled frame`)
        assert.equal(liveSide.zoom, compiledSide.zoom, `${tag} ${variant}: the live frame takes the same whole-slide zoom as the compiled frame (live ${liveSide.zoom}, compiled ${compiledSide.zoom})`)
        assert.equal(liveSide.listFit, compiledSide.listFit, `${tag} ${variant}: the ladder resolves to the same step live and compiled (live ${liveSide.listFit}, compiled ${compiledSide.listFit})`)
        assert.equal(liveSide.questionFit, compiledSide.questionFit, `${tag} ${variant}: the question notch fires on BOTH sides or neither (live ${liveSide.questionFit}, compiled ${compiledSide.questionFit})`)
        assert.ok(Math.abs(liveSide.questionPx - compiledSide.questionPx) <= 1, `${tag} ${variant}: the question reads at the same size live and compiled (live ${liveSide.questionPx}, compiled ${compiledSide.questionPx})`)
        assert.equal(liveSide.chips.length, compiledSide.chips.length, `${tag} ${variant}: the live frame lays out every scale chip`)
        assert.ok(compiledSide.questionPx >= compiledSide.floor - 0.5 && liveSide.questionPx >= liveSide.floor - 0.5, `${tag} ${variant}: the question never drops below the type floor (compiled ${compiledSide.questionPx}, live ${liveSide.questionPx})`)
      }

      await presenter.close()
      await audience.close()
      await context.close()
    }
  }
  assert.deepEqual(errors, [], 'no runtime errors in any window')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

// --- mutation: narrowing the fitLists guard back must fail this gate -----------------------------
if (!isMutant) {
  const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url)], {
    env: { ...process.env, TW_REINSTATE_POLL_FIT_DEFECT: '1', TW_POLL_SHOTS: '' },
    encoding: 'utf8',
  })
  assert.notEqual(child.status, 0, 'with the fitLists guard narrowed back the gate fails')
  assert.match(child.stdout + child.stderr, /zoom stays 1|not overflowed|type floor|clipped/, `mutant fails on its own contract, not elsewhere:\n${(child.stdout + child.stderr).slice(-1200)}`)
  console.log('poll fit mutation (fitLists guard narrowed back): FAILS as required')
}
console.log(isMutant
  ? 'poll fit (mutant): PASS — this must not happen'
  : `poll fit: ${FIXTURES.length} fixtures × ${VIEWPORTS.length} viewports — bare fixtures at zoom 1 with labels on the type floor; join variants fit with at most a reported sub-1 zoom`)
