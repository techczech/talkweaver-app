import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { makeQrSvg } from '../compiler/scripts/lib/01-cli-utils.mjs'

// Ticket 23: the live projection is the compiled poll frame (poll-frame.mjs) with its state filled —
// mounted INSIDE .slide-content next to the compiled frame, never as an overlay. Every locator below
// reads the frame's grammar (`[data-poll-frame="live"]`, .poll-frame-*).
const source = `---
title: Audience poll display
auto_title_slide: false
auto_thanks_slide: false
---

### Introduction {id=intro}

We will discuss reading strategies.

### Which reading task takes you the most time? {id=reading poll=single pollresults=held}

- Finding relevant sources
- Understanding difficult passages
- Taking useful notes
- Remembering what I read

### Discussion {id=discussion}

What could you try differently?

### What helps you read? {id=text-poll poll=open pollresults=held}

### Which of these reading problems do you identify with (max 3) {id=rate poll=rating pollskip=true pollresults=held}

[scale: 1, 2, 3]

- I don't have time to read it all.
- I read but I can't understand what it's all about.
- I get stuck on words and sentences and can't continue until I look them up.
- I forget what I read by the time I have to use it.
- None of the above.

### Which strategies would most improve your reading? {id=rank poll=ranking pollresults=held}

- Preview the structure
- Set a reading purpose
- Find the main claim
- Check the evidence
- Connect with other sources
- Summarise from memory
`
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-poll-projection-'))
const sourcePath = join(scratch, 'audience-polls.md')
await writeFile(sourcePath, source)
const model = await prepareSource(sourcePath, source, 'audience-polls', statSync(sourcePath))
const htmlPath = join(scratch, 'audience-polls.html')
await writeFile(htmlPath, model.fullHtml)
const errors = []
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
context.setDefaultTimeout(5000)
const watch = (page) => page.on('pageerror', (error) => errors.push(error.message))
context.on('page', watch)
await context.addInitScript(() => {
  if (!location.search.includes('presenter=1')) return;
  window.__pollActions = [];
  window.twLivePollBridge = {
    action: async (message) => { window.__pollActions.push(message); return window.__pollActionResult || { success: true, status: 'confirmed' }; },
    onState: (cb) => { window.__pollStateApply = cb; },
    onStatus: (cb) => { window.__pollStatusApply = cb; },
    onJoin: (cb) => { window.__pollJoinApply = cb; },
    onOperation: (cb) => { window.__pollOperationApply = cb; },
  };
})
const LIVE = '.slide.active .slide-content > [data-poll-frame="live"]'
const presenter = await context.newPage()
try {
  await presenter.goto(`${pathToFileURL(htmlPath).href}?presenter=1&session=projection-test#reading`)
  const poll = await presenter.locator('.slide[data-id="reading"]').evaluate((el) => JSON.parse(el.dataset.poll))
  const held = { ...poll, type: 'poll.state', pollType: poll.type, slideId: 'reading', open: true, revealed: false,
    tallies: Object.fromEntries(poll.options.map((option, i) => [option.optionId, [8, 4, 6, 2][i]])) };
  await presenter.evaluate((message) => window.__pollStateApply(message), held)
  const audiencePromise = context.waitForEvent('page')
  await presenter.locator('#presenterAudienceApp').click()
  const audience = await audiencePromise
  await audience.waitForLoadState()
  await audience.setViewportSize({ width: 1920, height: 1080 })
  const canvas = audience.locator(LIVE)
  await canvas.waitFor({ state: 'visible', timeout: 3000 })
  assert.equal(await canvas.getAttribute('data-poll-view'), 'question')
  assert.match(await canvas.textContent(), /Finding relevant sources/)
  // The live frame lives in the slide's own content column: the compiled frame is hidden beside it,
  // nothing floats over the slide, and the slide's other content is untouched.
  const readingFrameHidden = () => audience.locator('.slide[data-id="reading"] [data-poll-frame="compiled"]').evaluate((el) => el.hidden)
  assert.equal(await readingFrameHidden(), true, 'the compiled frame is hidden while the live frame is mounted')
  assert.equal(await audience.locator('.slide.active > .slide-content').isVisible(), true, 'the live frame is part of the slide content, not a replacement layer')
  assert.equal(await audience.locator('.slide.active .poll-display-host, .slide.active .poll-frame-host').count(), 0, 'no overlay host on a framed slide')
  assert.equal(await canvas.locator('.poll-frame-bar').count(), 0)
  assert.equal(await canvas.locator('.poll-frame-option').count(), 4, 'every option on the one page')

  const shots = process.env.TW_POLL_SHOTS
  if (shots) await mkdir(shots, { recursive: true })
  assert.match(await canvas.textContent(), /Join link appears when the session is live/)
  const joining = { shortUrl: 'https://example.test/read', qrSvg: makeQrSvg('https://example.test/read') }
  await presenter.evaluate((value) => window.__pollJoinApply(value), joining)
  await audience.waitForFunction(() => document.querySelector('.slide.active .poll-frame-join .poll-frame-qr svg'))
  assert.match(await canvas.textContent(), /example.test\/read/)
  assert.doesNotMatch(await canvas.textContent(), /Join link appears/)
  if (shots) await audience.screenshot({ path: join(shots, 'talkweaver-poll-question-1920.png') })
  const stored = await audience.evaluate(() => Object.values(localStorage).join('\n'))
  assert.doesNotMatch(stored, /"tallies"|"responses"/, 'held data is absent from paired browser storage')

  await presenter.evaluate(() => { window.__pollActionResult = { success: true, status: 'pending', operationId: 'operation-close' } })
  await presenter.locator('#presenterPollClose').click()
  assert.equal(await presenter.locator('#presenterPollClose').isDisabled(), true)
  assert.match(await presenter.locator('#presenterPollOperation').textContent(), /Waiting for confirmation/)
  assert.match(await canvas.textContent(), /Accepting responses/)
  const pendingActionCount = await presenter.evaluate(() => window.__pollActions.length)
  await presenter.keyboard.press('q')
  assert.equal(await presenter.evaluate(() => window.__pollActions.length), pendingActionCount, 'keyboard shortcuts cannot replace a pending operation')
  await presenter.evaluate((pollId) => window.__pollOperationApply({ operationId: 'operation-close', status: 'rejected', message: { type: 'poll.close', pollId }, error: 'Session unavailable. Try again.' }), poll.pollId)
  assert.match(await presenter.locator('#presenterPollOperation').textContent(), /Session unavailable/)
  assert.equal(await presenter.locator('#presenterPollClose').isEnabled(), true)
  await presenter.evaluate(() => { window.__pollActionResult = { success: true, status: 'confirmed' } })
  await presenter.locator('#presenterPollClose').click()
  const closed = { ...held, open: false }
  await presenter.evaluate((message) => window.__pollStateApply(message), closed)
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"] .poll-frame-chip')?.textContent === 'Responses closed')
  assert.equal(await canvas.getAttribute('data-poll-view'), 'question')
  await presenter.locator('#presenterPollReveal').click()
  await presenter.evaluate((message) => window.__pollStateApply(message), { ...closed, revealed: true })
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'results')
  assert.equal(await canvas.locator('.poll-frame-option > .poll-frame-bar').count(), 4, 'results are bars in the option rows')
  assert.match(await canvas.textContent(), /20 votes/)
  assert.equal(await readingFrameHidden(), true)

  if (shots) {
    await audience.screenshot({ path: join(shots, 'talkweaver-poll-results-1920.png') })
    await presenter.screenshot({ path: join(shots, 'talkweaver-poll-presenter.png') })
  }
  // Long labels never page: the frame shows them all and the deck's own fit keeps them on the stage.
  const longLabel = 'Understanding complex arguments and evaluating the evidence while keeping track of unfamiliar terminology and connecting ideas across several different sources.'
  await audience.setViewportSize({ width: 1280, height: 720 })
  await presenter.evaluate((message) => window.__pollStateApply(message), { ...closed, revealed: true, options: closed.options.map((o) => ({ ...o, label: longLabel })) })
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"] .poll-frame-option-label')?.textContent.includes('Understanding complex'))
  const fits = () => audience.evaluate(() => {
    const slide = document.querySelector('.slide.active'); const frame = slide.querySelector('[data-poll-frame="live"]')
    const s = slide.getBoundingClientRect(); const r = frame.getBoundingClientRect()
    const clipped = [frame, ...frame.querySelectorAll('.poll-frame-question, .poll-frame-answers, .poll-frame-foot')].some((el) => el.scrollWidth > el.clientWidth + 2)
    return r.bottom <= s.bottom + 1 && r.right <= s.right + 1 && !clipped
  })
  assert.equal(await fits(), true, 'long result labels fit the stage')
  assert.equal(await canvas.locator('.poll-frame-option').count(), 4)
  await presenter.locator('#presenterPollShowQuestion').click()
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'question')
  assert.equal(await fits(), true, 'long question options fit the stage')
  assert.equal(await presenter.locator('#presenterPollNextPage').isVisible(), false, 'options never page')
  await presenter.locator('#presenterPollShowResults').click()
  await presenter.evaluate((message) => window.__pollStateApply(message), { ...closed, revealed: true })
  await audience.setViewportSize({ width: 1920, height: 1080 })
  const actionCount = await presenter.evaluate(() => window.__pollActions.length)
  await presenter.keyboard.press('ArrowRight')
  await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'discussion')
  assert.equal(await audience.locator('.slide.active [data-poll-frame="live"]').count(), 0)
  // …and the compiled frame comes BACK when the projection leaves the slide, so a poll slide never goes blank.
  assert.equal(await readingFrameHidden(), false, 'the compiled frame returns when the projection leaves the slide')
  await presenter.keyboard.press('ArrowLeft')
  await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'reading')
  assert.equal(await canvas.getAttribute('data-poll-view'), 'results')
  assert.equal(await readingFrameHidden(), true, 'returning to the poll re-mounts the live frame beside the compiled one')
  assert.equal(await presenter.evaluate(() => window.__pollActions.length), actionCount, 'navigation never sends poll commands')
  await presenter.locator('#presenterPollShowQuestion').click()
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'question')
  await audience.reload()
  await canvas.waitFor({ state: 'visible' })
  assert.equal(await canvas.getAttribute('data-poll-view'), 'question', 'audience reload restores explicit question view')
  assert.equal(await canvas.locator('.poll-frame-qr svg').count(), 1)
  await presenter.locator('#presenterPollShowResults').click()
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'results')

  // A late-opened window must restore the final results without requiring a new vote or click.
  const late = await context.newPage()
  await late.goto(`${pathToFileURL(htmlPath).href}?audience=1&session=projection-test#reading`)
  assert.equal(await late.locator(LIVE).getAttribute('data-poll-view'), 'results')
  await late.close()

  await presenter.locator('#presenterQuickPollButton').click()
  await presenter.locator('[data-quick-poll-preset="Yes|No"]').click()
  await presenter.locator('#quickPollQuestion').fill('Should we try this together?')
  await presenter.locator('#quickPollOpen').click()
  const quick = await presenter.evaluate(() => window.__pollActions.at(-1).poll)
  await presenter.evaluate((definition) => window.__pollStateApply({ ...definition, type: 'poll.state', pollType: definition.type, open: true, revealed: true, tallies: {} }), quick)
  const popup = audience.locator('#audienceQuickPollPopup')
  await popup.waitFor({ state: 'visible' })
  assert.match(await popup.textContent(), /Should we try this together/)
  assert.equal(await popup.locator('.poll-frame[data-poll-frame="live"]').count(), 1, 'the Quick popup carries the same frame')
  if (shots) await audience.screenshot({ path: join(shots, 'talkweaver-quick-poll-popup-1920.png') })
  assert.equal(await audience.locator('.slide').count(), 6, 'Quick polls never insert a slide')
  await presenter.locator('#presenterQuickPollDismiss').click()
  await popup.waitFor({ state: 'hidden' })
  await presenter.evaluate((definition) => window.__pollStateApply({ ...definition, type: 'poll.state', pollType: definition.type, open: true, revealed: true, tallies: {} }), quick)
  assert.equal(await popup.isVisible(), false, 'a vote never reopens a dismissed Quick popup')
  await presenter.locator('#presenterQuickPollRestore').click()
  await popup.waitFor({ state: 'visible' })
  await presenter.locator('#presenterQuickPollDismiss').click()

  await presenter.evaluate(() => { location.hash = '#text-poll' })
  await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'text-poll')
  const textDefinition = await presenter.locator('.slide[data-id="text-poll"]').evaluate((el) => JSON.parse(el.dataset.poll))
  const textState = { ...textDefinition, type: 'poll.state', pollType: 'open', slideId: 'text-poll', open: false, revealed: true, responses: [
    { responseId: 'private', text: 'NEVER PROJECT THIS RESPONSE', name: 'Private person', hidden: true },
    ...Array.from({ length: 6 }, (_, i) => ({ responseId: String(i), text: `Reading strategy ${i + 1}`, name: 'Name must stay private' })),
  ] }
  await presenter.evaluate((message) => window.__pollStateApply(message), textState)
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'results')
  assert.equal(await canvas.locator('.poll-frame-response').count(), 4)
  assert.doesNotMatch(await audience.locator('body').textContent(), /NEVER PROJECT|Private person|Name must stay private/)
  assert.doesNotMatch(await audience.evaluate(() => Object.values(localStorage).join('\n')), /NEVER PROJECT|Private person|Name must stay private/)
  await presenter.locator('#presenterPollNextPage').click()
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollPage === '1')
  assert.match(await canvas.textContent(), /Reading strategy 5/)
  assert.match(await canvas.textContent(), /Page 2 of 2/, 'response pages are the one thing that pages')
  await audience.setViewportSize({ width: 1280, height: 720 })
  if (shots) await audience.screenshot({ path: join(shots, 'talkweaver-poll-responses-1280.png') })
  assert.equal(await fits(), true, 'projection content fits 1280x720')
  await presenter.evaluate((pollId) => window.__pollOperationApply({ operationId: 'restored-action', status: 'pending', message: { type: 'poll.open', poll: { pollId } } }), textDefinition.pollId)
  assert.match(await presenter.locator('#presenterPollOperation').textContent(), /Waiting for confirmation/)
  assert.equal(await presenter.locator('#presenterPollOpen').isDisabled(), true, 'reloaded pending controls cannot be duplicated')
  await presenter.evaluate(() => window.__pollStatusApply('expired'))
  await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"] .poll-frame-chip')?.textContent === 'Ready to open')
  assert.doesNotMatch(await audience.evaluate(() => Object.values(localStorage).join('\n')), /Reading strategy 5|example.test\/read/, 'expiry removes old session results and joining data')
  await presenter.evaluate((value) => window.__pollJoinApply(value), joining)
  for (const id of ['rate', 'rank']) {
    await presenter.evaluate((id) => { location.hash = `#${id}` }, id)
    await audience.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, id)
    const definition = await presenter.locator(`.slide[data-id="${id}"]`).evaluate(el => JSON.parse(el.dataset.poll))
    const state = { ...definition, type: 'poll.state', pollType: definition.type, slideId: id, open: true, revealed: false,
      responseCount: 24, tallies: Object.fromEntries(definition.options.map((option, index) => [option.optionId, [98, 98, 74, 66, 52, 34][index]])),
      firstPlaces: Object.fromEntries(definition.options.map(option => [option.optionId, 4])),
      ...(id === 'rate' ? { categoryTallies: Object.fromEntries(definition.options.map(option => [option.optionId,
        Object.fromEntries(definition.labels.map((label, index) => [label.optionId, [5, 12, 7][index]]))])) } : {}) }
    await presenter.evaluate(message => window.__pollStateApply(message), state)
    await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'question')
    assert.doesNotMatch(await canvas.textContent(), /ballots|points|answered|first-place|phone/)
    assert.equal(await presenter.locator('#presenterPollNextPage').isVisible(), false)
    assert.equal(await fits(), true)
    if (shots) await audience.screenshot({ path: join(shots, `talkweaver-${id}-comparison-question-1280.png`) })
    await presenter.evaluate(message => window.__pollStateApply(message), { ...state, revealed: true, open: false })
    await audience.waitForFunction(() => document.querySelector('.slide.active [data-poll-frame="live"]')?.dataset.pollView === 'results')
    assert.equal(await canvas.locator(id === 'rate' ? '.poll-frame-matrix-row' : '.poll-frame-option > .poll-frame-bar').count(), id === 'rate' ? 5 : 6)
    assert.match(await canvas.textContent(), id === 'rate' ? /24 answered/ : /Joint 1/)
    assert.equal(await fits(), true)
    if (shots) await audience.screenshot({ path: join(shots, `talkweaver-${id}-comparison-results-1280.png`) })
    const lateExtended = await context.newPage()
    await lateExtended.goto(`${pathToFileURL(htmlPath).href}?audience=1&session=projection-test#${id}`)
    assert.equal(await lateExtended.locator(LIVE).getAttribute('data-poll-view'), 'results')
    assert.equal(await lateExtended.locator('.slide.active .poll-frame-qr svg').count(), 1)
    await lateExtended.close()
    await audience.reload()
    await canvas.waitFor({ state: 'visible' })
    assert.equal(await canvas.getAttribute('data-poll-view'), 'results')
    // Create a Quick identity through the existing composer before delivering its state.
    await presenter.locator('#presenterQuickPollButton').click()
    await presenter.locator(`[data-quick-poll-type="${definition.type}"]`).click()
    await presenter.locator('#quickPollQuestion').fill(state.question)
    const quickRows = presenter.locator('.quick-poll-option-row input')
    for (let index = 0; index < definition.options.length; index++) {
      if (index > 1) await presenter.locator('#quickPollAddOption').click()
      await quickRows.nth(index).fill(definition.options[index].label)
    }
    if (id === 'rate') await presenter.locator('[data-quick-matrix-labels]').fill('1, 2, 3')
    await presenter.locator('#quickPollOpen').click()
    const extendedQuick = await presenter.evaluate(() => window.__pollActions.at(-1).poll)
    const quickState = { ...state, ...extendedQuick, type: 'poll.state', pollType: definition.type, slideId: undefined, revealed: true,
      tallies: Object.fromEntries(extendedQuick.options.map((option, index) => [option.optionId, [98, 98, 74, 66, 52, 34][index]])),
      ...(id === 'rate' ? { categoryTallies: Object.fromEntries(extendedQuick.options.map(option => [option.optionId,
        Object.fromEntries(extendedQuick.labels.map((label, index) => [label.optionId, [5, 12, 7][index]]))])) } : {}) }
    await presenter.evaluate(message => window.__pollStateApply(message), quickState)
    await presenter.locator('#presenterPollShowResults').click()
    await popup.locator(`.poll-frame[data-poll-type="${definition.type}"][data-poll-view="results"]`).waitFor({ state: 'visible' })
    assert.equal(await popup.locator(id === 'rate' ? '.poll-frame-matrix-row' : '.poll-frame-option > .poll-frame-bar').count(), id === 'rate' ? 5 : 6)
    assert.equal(await audience.locator('.slide').count(), 6)
    if (shots) await audience.screenshot({ path: join(shots, `talkweaver-${id}-quick-comparison-1280.png`) })
    await presenter.locator('#presenterQuickPollDismiss').click()
    await popup.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(errors, [], 'no generated runtime errors')
  console.log('poll projection DOM: real paired windows, in-content live frame, privacy, close/reveal, navigation/revisit, late/reload, Quick popups and response paging passed (Playwright)')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
