import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { pollFrameRuntimeSource } from '../compiler/scripts/lib/poll-frame.mjs'
import { buildDeckStyles } from './build-deck-styles.mjs'
const runtime = readFileSync(new URL('../compiler/assets/runtime/poll-display.js', import.meta.url), 'utf8')
// Ticket 23: the live poll IS the compiled frame (poll-frame.mjs) with its state filled; the frame
// renderer is injected ahead of poll-display.js exactly as 01-cli-utils does for the deck.
const frame = pollFrameRuntimeSource()
const deckCss = buildDeckStyles()
const api = vm.runInNewContext(`${frame}; ${runtime}; createPollDisplay()`, { URL })
const plain = value => JSON.parse(JSON.stringify(value))
const options = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label, i) => ({ optionId: String(i), label }))
const ranking = { pollId: 'rank', pollType: 'ranking', question: 'Which approaches would you prioritise?', options, visibility: 'held', revealed: false, open: true, rankCount: 2,
  tallies: { 0: 5, 1: 9, 2: 9, 3: 0 }, firstPlaces: { 0: 0, 1: 2, 2: 3, 3: 0 }, responseCount: 8 }
const matrix = { ...ranking, pollId: 'matrix', pollType: 'rating', labels: [{ optionId: 'yes', label: 'Useful' }, { optionId: 'no', label: 'Less useful' }], allowSkip: true,
  categoryTallies: { 0: { yes: 3, no: 1 }, 1: { yes: 0, no: 0 } } }

const realReadingItems = [
  "I don't have time to read it all.",
  "I read but I can't understand what it's all about.",
  "I get stuck on words and sentences and can't continue until I look them up.",
  "I forget what I read by the time I have to use it.",
  'None of the above.',
]
const realRating = { ...matrix, question: 'Which of these reading problems do you identify with (max 3)',
  options: realReadingItems.map((label, index) => ({ optionId: String(index), label })),
  labels: ['1', '2', '3'].map(label => ({ optionId: label, label })), revealed: true, responseCount: 24,
  categoryTallies: Object.fromEntries(realReadingItems.map((_, index) => [String(index), { 1: 5, 2: 12, 3: 7 }])) }
const sixRanking = { ...ranking, rankCount: undefined, revealed: true, options: [
  'Preview the structure', 'Set a reading purpose', 'Find the main claim', 'Check the evidence',
  'Connect with other sources', 'Summarise from memory',
].map((label, index) => ({ optionId: String(index), label })) }

const wideBoundaryStates = [
  { ...sixRanking, options: Array.from({ length: 6 }, (_, index) => ({ optionId: String(index), label: 'W'.repeat(96) })) },
  ...['rating', 'categorisation'].map(pollType => ({ ...realRating, pollType,
    options: Array.from({ length: 6 }, (_, index) => ({ optionId: String(index), label: 'W'.repeat(76) })) })),
]

// A slide skeleton with the deck's own stylesheet: the frame lays out inside `.slide-content`, where
// the compiled frame lives, so what is measured here is the composition the audience sees.
const stage = (markup, width, height) => `<style>${deckCss} html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden} .stage{width:${width}px;height:${height}px} .slide{display:grid !important}</style><main class="deck"><div class="stage"><section class="slide active" data-layout="statement"><div class="slide-content">${markup}</div></section></div></main>`

test('options and matrix rows never page: the live frame shows every row, as the compiled frame does', () => {
  for (const state of [...wideBoundaryStates, realRating, sixRanking]) for (const view of ['question', 'results']) {
    const info = api.pageInfo(state, view)
    assert.equal(info.pages, 1)
    assert.deepEqual(plain(info.items).map(item => item.label).sort(), state.options.map(item => item.label).sort())
    const html = api.markup(state, { view, started: true })
    const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    for (const option of state.options) assert.ok(html.includes(escape(option.label)), `${state.pollType} ${view}: every authored option is on the one page`)
    assert.doesNotMatch(html, /poll-frame-page|Page \d+ of/)
  }
})

test('empty rankings are unplaced and positive tied scores say Joint', () => {
  const empty = { ...sixRanking, tallies: {}, firstPlaces: {}, responseCount: 0 }
  assert.ok(api.pageInfo(empty, 'results').items.every(item => item.place == null))
  assert.doesNotMatch(api.markup(empty, { view: 'results' }), /poll-frame-place">[^<]/)
  assert.match(api.markup(sixRanking, { view: 'results' }), /Joint 1\./)
})

test('Top N omitted choices explicitly share their tied place after ballots arrive', () => {
  const state = { ...ranking, revealed: true, responseCount: 1, tallies: { 0: 2, 1: 1, 2: 0, 3: 0 } }
  const html = api.markup(state, { view: 'results' })
  assert.equal((html.match(/Joint 3\./g) || []).length, 2)
})

test('all projected ballot rules and joining details are device neutral', () => {
  for (const pollType of ['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation']) {
    const html = api.markup({ ...realRating, pollType }, { started: true, join: { shortUrl: 'https://example.test/read' } })
    assert.doesNotMatch(html, /phone|on any device/i)
    assert.match(html, /example.test\/read/)
    assert.match(html, /<aside class="poll-frame-join">/, 'a real link takes the frame join slot')
    assert.doesNotMatch(html, /poll-frame-join-note/)
  }
  assert.match(api.markup(realRating, { started: true }), /poll-frame-join-note/, 'no link: the footer note, never an empty join column')
})

test('extended held snapshots retain only validated public metadata', () => {
  for (const state of [ranking, matrix, { ...matrix, pollType: 'categorisation' }]) {
    const safe = api.safeState(state)
    assert.ok(safe)
    assert.equal(safe.pollType, state.pollType)
    assert.doesNotMatch(JSON.stringify(safe), /tallies|firstPlaces|categoryTallies|responseCount/)
    assert.equal(api.pageInfo(state, 'results').view, 'question')
  }
  assert.equal(api.safeState(ranking).rankCount, 2)
  assert.deepEqual(plain(api.safeState(matrix).labels), matrix.labels)
  assert.equal(api.safeState(matrix).allowSkip, true)
  for (const rankCount of [0, 5, 1.2, '2']) assert.equal(api.safeState({ ...ranking, rankCount }), null)
  for (const labels of [[], null, [{ optionId: 'x', label: 'A' }, { optionId: 'x', label: 'B' }]]) assert.equal(api.safeState({ ...matrix, labels }), null)
  assert.equal(api.safeState({ ...matrix, allowSkip: 'yes' }), null)
})

test('revealed aggregates are restricted to authored ids and safe integer counts', () => {
  const safe = api.safeState({ ...matrix, revealed: true, responseCount: -1, categoryTallies: { 0: { yes: 3, no: -1, secret: 88 }, secret: { yes: 99 } } })
  assert.equal(safe.responseCount, 0)
  assert.deepEqual(plain(safe.categoryTallies[0]), { yes: 3, no: 0 })
  assert.equal(safe.tallies, undefined)
  assert.equal(safe.firstPlaces, undefined)
  assert.doesNotMatch(JSON.stringify(safe), /secret/)
  const rank = api.safeState({ ...ranking, revealed: true, firstPlaces: { 0: 1.5, 1: 2, secret: 9 } })
  assert.deepEqual(plain(rank.firstPlaces), { 0: 0, 1: 2, 2: 0, 3: 0 })
  assert.equal(rank.categoryTallies, undefined)
})

test('ranking results share places for tied points, preserve author order and count ballots', () => {
  const state = { ...ranking, revealed: true }
  const items = plain(api.pageInfo(state, 'results').items)
  assert.deepEqual(items.map(item => [item.optionId, item.place]), [['1', 1], ['2', 1], ['0', 3], ['3', 4]])
  const html = api.markup(state, { view: 'results', started: true })
  assert.match(html, /8 ballots/)
  assert.match(html, /9 points/)
  assert.match(html, /2 first-place votes/)
  assert.match(html, /2 points for first.*1 for last/)
  assert.match(html, /Equal points share a place/)
  assert.equal((html.match(/class="poll-frame-bar"/g) || []).length, 4, 'every ranked row carries its bar in the row')
  assert.match(api.markup(ranking), /Rank your top 2 choices/)
  assert.match(api.markup({ ...ranking, rankCount: undefined }), /Rank all 4 choices/)
})

test('matrix results use row denominators, authored label order and skip counts', () => {
  const state = { ...matrix, revealed: true }
  const html = api.markup(state, { view: 'results', started: true })
  assert.match(html, /4 answered.*4 skipped/)
  assert.match(html, /3.*75%/)
  assert.match(html, /1.*25%/)
  assert.ok(html.indexOf('Useful') < html.indexOf('Less useful'))
  assert.match(html, /8 ballots/)
  assert.match(html, /% of answers to this item/)
  assert.doesNotMatch(api.markup({ ...state, allowSkip: false }, { view: 'results' }), /skipped/)
  const empty = api.markup({ ...state, options: [options[1]] }, { view: 'results' })
  assert.match(empty, /0 answered.*8 skipped/)
  assert.doesNotMatch(empty, /NaN|Infinity/)
  const question = api.markup(matrix)
  assert.match(question, /Useful/)
  assert.match(question, /Choose one label for each item/)
  assert.doesNotMatch(question, /75%|answered|ballots/)
})

test('long labels stay whole and escaped on the one page; held snapshots stay private', () => {
  const label = 'A very long label <img src=x onerror=alert(1)> ' .repeat(18) + '終🙂';
  const state = { ...matrix, options: [{ optionId: 'row', label }], labels: [{ optionId: 'label', label }] };
  const html = api.markup(state)
  assert.equal(api.pageInfo(state, 'question').pages, 1)
  assert.doesNotMatch(html, /<img|onerror=alert\(1\)>/);
  assert.equal((html.match(/終🙂/g) || []).length, 2, 'the item and its scale label both carry the full text')
  const rankState = { ...ranking, options: [{ optionId: 'row', label }], rankCount: 1 };
  assert.equal(api.pageInfo(rankState, 'question').pages, 1)
  assert.match(api.markup(rankState), /終🙂/)
  const projection = readFileSync(new URL('../compiler/assets/runtime/poll-projection.js', import.meta.url), 'utf8');
  const paired = vm.runInNewContext(`${frame}; ${runtime}; ${projection}; createPollProjection({storageKey:'test', sessionId:'test', isPresenter:true, isPaired:false})`, { URL });
  for (const poll of [ranking, matrix]) paired.update(poll);
  assert.doesNotMatch(JSON.stringify(paired.snapshot()), /tallies|firstPlaces|categoryTallies|responseCount/);
  for (const poll of [ranking, matrix]) paired.update({ ...poll, revealed: true });
  assert.match(JSON.stringify(paired.snapshot()), /firstPlaces/);
  assert.match(JSON.stringify(paired.snapshot()), /categoryTallies/);
});

// The deck's own fit pass (presenter-popup-single-html.html autofitContent / the preview iframe's
// fit): a slide whose content is taller than the stage band is zoomed as one unit, never below the
// floor. Compiled and live frames go through it identically; the skeleton here runs the same step.
const FIT = () => {
  const content = document.querySelector('.slide-content'); const slide = content.closest('.slide')
  content.style.zoom = ''
  const cs = getComputedStyle(slide)
  const availW = slide.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const availH = slide.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  const prev = content.style.minHeight; content.style.minHeight = '0'
  const cw = content.scrollWidth, ch = content.scrollHeight; content.style.minHeight = prev
  const zoom = ch <= availH && cw <= availW ? 1 : Math.max(0.45, Math.min(availH / ch, availW / cw, 1))
  content.style.zoom = String(zoom)
  const option = content.querySelector('.poll-frame-option, .poll-frame-matrix-item')
  return { zoom, optionPx: option ? parseFloat(getComputedStyle(option).fontSize) : 0, floorPx: parseFloat(getComputedStyle(slide).getPropertyValue('--type-floor')) || parseFloat(getComputedStyle(content).fontSize) }
}

test('representative extended polls fit the 16:9 stage in the frame after the deck fit, nothing clipped', { skip: !process.env.TW_POLL_EXTENDED_DOM }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  const sevenLabels = { ...realRating, labels: ['Never', 'Rarely', 'Sometimes', 'Often', 'Usually', 'Nearly always', 'Always'].map((label, i) => ({ optionId: String(i), label })) }
  // Representative sizes only (extended-polls brief: five items, six rankings). A seven-label scale
  // is a stress case: its results chips wrap and lean on the fit; it stays lossless (test above) and
  // its overflow policy is the frame's autofit, not this parcel's.
  const states = [realRating, sixRanking, { ...realRating, pollType: 'categorisation' }]
  assert.equal(api.pageInfo(sevenLabels, 'results').pages, 1)
  try {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport)
      for (const state of states) for (const view of ['question', 'results']) {
        const markup = api.markup(state, { view, started: true, join: { shortUrl: 'https://example.test/read', qrSvg: '<svg viewBox="0 0 10 10"><path d="M0 0h10v10H0z" fill="#000"/></svg>' } })
        await page.setContent(stage(markup, viewport.width, viewport.height))
        const fit = await page.evaluate(FIT)
        // Five matrix items or six ranked rows lean on the fit at 1280×720 (the compiled frame's density,
        // Ticket 5); the fit may never take the row type below the stage's type floor (ADR-0005).
        assert.ok(fit.optionPx * fit.zoom >= fit.floorPx - 0.5, `${state.pollType} ${view} at ${viewport.width}: fit zoom ${fit.zoom.toFixed(2)} keeps ${fit.optionPx}px rows at or above the ${fit.floorPx}px floor`)
        const failures = await page.locator('.poll-frame').evaluate(root => {
          const stageRect = root.closest('.stage').getBoundingClientRect()
          return [...root.querySelectorAll('.poll-frame-head, .poll-frame-question, .poll-frame-answers, .poll-frame-answers *, .poll-frame-join, .poll-frame-foot')].filter(el => {
            const rect = el.getBoundingClientRect()
            return el.scrollWidth > el.clientWidth + 2 || rect.bottom > stageRect.bottom + 1 || rect.right > stageRect.right + 1
          }).map(el => ({ class: el.className, text: el.textContent.slice(0, 60), bottom: Math.round(el.getBoundingClientRect().bottom) }))
        })
        assert.deepEqual(failures, [], `${state.pollType} ${view} at ${viewport.width}`)
      }
    }
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})

test('rating choices sit under their item, beside each other, in one row of the frame', { skip: !process.env.TW_POLL_EXTENDED_DOM }, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const state = realRating;
    for (const view of ['question', 'results']) {
      const html = api.markup({ ...state, revealed: true }, { view, started: true });
      await page.setContent(stage(html, 1280, 720));
      assert.equal(await page.locator('.poll-frame-matrix-row').count(), 5);
      const row = page.locator('.poll-frame-matrix-row').first();
      const item = await row.locator('.poll-frame-matrix-text').boundingBox();
      const choices = await row.locator('.poll-frame-matrix-label').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
      assert.equal(choices.length, 3);
      assert.ok(choices[0].y >= item.y + item.height - 1, 'the scale sits under its item (the frame grid ADR-0022 locked)');
      assert.ok(Math.abs(choices[0].x - item.x) < 2, 'the scale aligns with the item text column');
      assert.ok(choices.every(choice => Math.abs(choice.y - choices[0].y) < 2), 'scale choices share one horizontal row');
      assert.ok(choices[1].x >= choices[0].x + choices[0].width);
    }
  } finally { await browser.close(); }
});

test('each matrix result retains its label beside the count in the accessibility tree', { skip: !process.env.TW_POLL_EXTENDED_DOM }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.setContent(stage(api.markup({ ...matrix, revealed: true }, { view: 'results' }), 1280, 720))
    const cells = page.locator('.poll-frame-matrix-row').first().locator('.poll-frame-matrix-label')
    assert.match(await cells.nth(0).ariaSnapshot(), /Useful[\s\S]*3[\s\S]*75%/)
    assert.match(await cells.nth(1).ariaSnapshot(), /Less useful[\s\S]*1[\s\S]*25%/)
  } finally { await browser.close() }
})
