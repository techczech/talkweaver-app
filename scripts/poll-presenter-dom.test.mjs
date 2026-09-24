import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { DOMParser } from '@xmldom/xmldom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const source = [
  '---',
  'title: Presenter poll test',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  '---',
  '',
  '### Choose one {id=slide-choice poll=single pollresults=held}',
  '',
  '- Alpha',
  '- Beta',
  '',
  '### What matters? {id=slide-open poll=open pollresults=live}',
  '',
  'Tell us what matters.',
].join('\n')

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-poll-presenter-'))
const sourcePath = join(scratch, 'poll-presenter.md')
await writeFile(sourcePath, source)
const model = await prepareSource(sourcePath, source, 'poll-presenter', statSync(sourcePath))
const htmlPath = join(scratch, 'poll-presenter.html')
await writeFile(htmlPath, model.fullHtml)

const heldState = {
  type: 'poll.state', pollId: 'poll-slide-choice', pollType: 'single', question: 'Choose one',
  options: [
    { optionId: 'poll-slide-choice-option-1', label: 'Alpha' },
    { optionId: 'poll-slide-choice-option-2', label: 'Beta' },
  ],
  visibility: 'held', open: true, revealed: false,
  tallies: { 'poll-slide-choice-option-1': 3, 'poll-slide-choice-option-2': 1 },
}

async function runBrowserTest() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // Mock the preload's contextBridge API (present-live-bridge.ts exposes twLivePollBridge). The
  // template MUST reach the bridge through this — window events don't cross context isolation in
  // the real app, so testing that path here is what guards against the silent-no-op regression.
  await page.addInitScript(() => {
    window.__pollActions = []
    window.__pollStateApply = () => {}
    window.__pollStatusApply = () => {}
    window.twLivePollBridge = {
      action: async (message) => { window.__pollActions.push(message); return { success: true, status: 'confirmed' } },
      onState: (cb) => { window.__pollStateApply = cb },
      onStatus: (cb) => { window.__pollStatusApply = cb },
    }
  })
  try {
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1&session=poll-test#slide-choice`)
    const panel = page.locator('#presenterPollPanel')
    assert.equal(await panel.isVisible(), true)
    assert.match(await panel.textContent(), /Choose one/)
    assert.match(await panel.textContent(), /CHOICE · SINGLE/)
    assert.match(await panel.textContent(), /HELD/)
    assert.equal(await panel.locator('#presenterPollOpen').isVisible(), true)

    const compose = page.locator('#presenterQuickPollCompose')
    await page.locator('#presenterQuickPollButton').click()
    assert.equal(await compose.isVisible(), true)
    const quickOpen = compose.locator('#quickPollOpen')
    assert.equal(await quickOpen.isDisabled(), true, 'an empty Quick poll is invalid')
    await compose.locator('#quickPollQuestion').fill('What should we discuss next?')
    assert.equal(await quickOpen.isDisabled(), true, 'choice polls require at least two non-empty options')
    const optionInputs = compose.locator('.quick-poll-option-row input')
    await optionInputs.nth(0).fill('Testing')
    assert.equal(await quickOpen.isDisabled(), true)
    await optionInputs.nth(1).fill('Deployment')
    await compose.locator('[data-quick-poll-type="multiple"]').click()
    await compose.locator('[data-quick-poll-visibility="held"]').click()
    await compose.locator('#quickPollMaxSelections').fill('3')
    assert.equal(await quickOpen.isDisabled(), true, 'cannot ask for more selections than options')
    await compose.locator('#quickPollMaxSelections').fill('1')
    assert.equal(await quickOpen.isEnabled(), true)
    await quickOpen.click()
    const quickAction = (await page.evaluate(() => window.__pollActions)).at(-1)
    assert.equal(quickAction.type, 'poll.open')
    assert.equal(quickAction.poll.maxSelections, 1)
    assert.match(quickAction.poll.pollId, /^quick-/)
    assert.deepEqual({
      type: quickAction.poll.type,
      question: quickAction.poll.question,
      labels: quickAction.poll.options.map((option) => option.label),
      visibility: quickAction.poll.visibility,
    }, {
      type: 'multiple', question: 'What should we discuss next?', labels: ['Testing', 'Deployment'], visibility: 'held',
    })

    await page.locator('#presenterQuickPollDismiss').click()
    await panel.locator('#presenterPollOpen').click()
    assert.deepEqual((await page.evaluate(() => window.__pollActions)).at(-1), {
      type: 'poll.open',
      poll: {
        pollId: 'poll-slide-choice', type: 'single', question: 'Choose one', slideId: 'slide-choice',
        options: [
          { optionId: 'poll-slide-choice-option-1', label: 'Alpha' },
          { optionId: 'poll-slide-choice-option-2', label: 'Beta' },
        ],
        visibility: 'held',
      },
    })

    await page.evaluate((message) => window.__pollStateApply(message), heldState)
    assert.match(await panel.locator('#presenterPollChip').textContent(), /Poll open · 4/)
    assert.equal(await panel.locator('.presenter-poll-bar').count(), 2)
    assert.match(await panel.locator('.presenter-poll-bar').first().textContent(), /Alpha.*75%.*3/s)
    assert.equal(await panel.locator('#presenterPollReveal').isVisible(), true)
    assert.equal(await panel.locator('#presenterPollHeldNote').isVisible(), true)

    await panel.locator('#presenterPollReveal').click()
    assert.deepEqual((await page.evaluate(() => window.__pollActions)).at(-1), {
      type: 'poll.reveal', pollId: 'poll-slide-choice',
    })
    await page.evaluate((message) => window.__pollStateApply(message), {
      ...heldState, revealed: true,
    })
    assert.equal(await panel.locator('#presenterPollReveal').isVisible(), false)
    assert.equal(await panel.locator('#presenterPollHeldNote').isVisible(), false)

    await panel.locator('#presenterPollClose').click()
    assert.deepEqual((await page.evaluate(() => window.__pollActions)).at(-1), {
      type: 'poll.close', pollId: 'poll-slide-choice',
    })
    await page.evaluate((message) => window.__pollStateApply(message), {
      ...heldState, open: false, revealed: true,
    })
    assert.match(await panel.textContent(), /Poll closed · 4/)
    assert.equal(await panel.locator('.presenter-poll-bar').count(), 2, 'closed poll freezes final bars')
    // A closed poll can be re-opened (mis-click recovery); the Worker keeps its votes.
    assert.equal(await panel.locator('#presenterPollOpen').isVisible(), true, 'a closed poll offers re-open')
    assert.equal(await panel.locator('#presenterPollOpen').textContent(), 'Reopen responses')
    assert.equal(await panel.locator('#presenterPollClose').isVisible(), false)

    await page.evaluate(() => { location.hash = '#slide-open' })
    await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'slide-open')
    await page.evaluate((message) => window.__pollStateApply(message), {
      type: 'poll.state', pollId: 'poll-slide-open', pollType: 'open', question: 'What matters?',
      options: [], visibility: 'live', open: true, revealed: true,
      responses: [
        { responseId: 'connection-1', text: 'Accountability' },
        { responseId: 'connection-2', text: 'Judgement', name: 'Priya' },
      ],
    })
    assert.equal(await panel.locator('.presenter-poll-response').count(), 2)
    assert.equal(await panel.locator('.presenter-poll-response .presenter-poll-hide').count(), 2)
    await panel.locator('.presenter-poll-response .presenter-poll-hide').first().click()
    assert.deepEqual((await page.evaluate(() => window.__pollActions)).at(-1), {
      type: 'poll.hide', pollId: 'poll-slide-open', responseId: 'connection-1', hidden: true,
    })
    await page.evaluate((message) => window.__pollStateApply(message), {
      type: 'poll.state', pollId: 'poll-slide-open', pollType: 'open', question: 'What matters?',
      options: [], visibility: 'live', open: true, revealed: true,
      responses: [
        { responseId: 'connection-1', text: 'Accountability', hidden: true },
        { responseId: 'connection-2', text: 'Judgement', name: 'Priya' },
      ],
    })
    assert.equal(await panel.locator('.presenter-poll-response.is-hidden').count(), 1)
    await panel.locator('.presenter-poll-response.is-hidden .presenter-poll-hide').click()
    assert.deepEqual((await page.evaluate(() => window.__pollActions)).at(-1), {
      type: 'poll.hide', pollId: 'poll-slide-open', responseId: 'connection-1', hidden: false,
    })
    assert.equal(await panel.locator('#presenterPollReveal').isVisible(), false, 'live polls never show Reveal')

    const focusability = await panel.locator('button:visible').evaluateAll((buttons) => buttons.map((button) => ({
      tag: button.tagName, disabled: button.disabled, tabIndex: button.tabIndex,
    })))
    assert.equal(focusability.every((button) => button.tag === 'BUTTON' && !button.disabled && button.tabIndex >= 0), true)

    await page.evaluate(() => window.__pollStateApply({
      type: 'poll.state', pollId: 'poll-slide-open', pollType: 'open', question: 'What matters?',
      options: [], visibility: 'live', open: false, revealed: true, responses: [],
    }))
    await page.evaluate(() => { location.hash = '#slide-choice' })
    await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'slide-choice')
    await page.evaluate((message) => window.__pollStateApply(message), heldState)
    await page.keyboard.press('Shift+Q')
    assert.deepEqual((await page.evaluate(() => window.__pollActions)).at(-1), {
      type: 'poll.reveal', pollId: 'poll-slide-choice',
    })

    // Presenter dismiss clears the panel — the reported "poll overlay won't close, even on
    // slides with no polls". The panel is visible here (slide-choice, held state).
    assert.equal(await panel.isVisible(), true, 'panel visible before dismiss')
    await panel.locator('#presenterPollDismiss').click()
    assert.equal(await panel.isVisible(), false, 'presenter dismiss hides the poll panel')
    await page.locator('#presenterQuickPollButton').click()
    await compose.locator('[data-quick-poll-type="open"]').click()
    await compose.locator('#quickPollMaxSubmissions').fill('3')
    await quickOpen.click()
    assert.equal((await page.evaluate(() => window.__pollActions)).at(-1).poll.maxSubmissions, 3)
    await page.locator('#presenterQuickPollButton').click()
    await compose.locator('[data-quick-poll-type="open"]').click()
    await compose.locator('#quickPollUnlimited').check()
    await quickOpen.click()
    assert.equal((await page.evaluate(() => window.__pollActions)).at(-1).poll.maxSubmissions, null)
  } finally {
    await browser.close()
  }
}

function runGeneratedDocumentFallback() {
  const parsed = new DOMParser({ errorHandler: () => {} }).parseFromString(model.fullHtml, 'text/html')
  assert.ok(parsed.getElementById('presenterPollPanel'))
  assert.match(model.fullHtml, /data-poll="\{&quot;pollId&quot;:&quot;poll-slide-choice&quot;/)
  assert.match(model.fullHtml, /id="presenterPollOpen"[^>]*>Open poll</)
  assert.match(model.fullHtml, /id="presenterPollReveal"[^>]*>Reveal to everyone</)
  assert.match(model.fullHtml, /id="presenterPollClose"[^>]*>Close poll</)
  assert.match(model.fullHtml, /id="presenterQuickPollButton"[^>]*>Quick poll</)
  assert.match(model.fullHtml, /id="presenterQuickPollCompose"/)
  assert.match(model.fullHtml, /data-quick-poll-type="single"/)
  assert.match(model.fullHtml, /id="quickPollQuestion"/)
  assert.match(model.fullHtml, /id="quickPollOptions"/)
  assert.match(model.fullHtml, /id="quickPollOpen"/)
  assert.match(model.fullHtml, /presenter-poll-hide/)
  assert.match(model.fullHtml, /type: "poll.hide"/)
  assert.match(model.fullHtml, /\["Q","Open or close current poll"\]/)
  assert.match(model.fullHtml, /\["⇧ Q","Reveal held poll results"\]/)
  assert.match(model.fullHtml, /\["K","Compose a Quick poll"\]/)

  const script = [...model.fullHtml.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)?.[1] ?? ''
  assert.doesNotThrow(() => new Function(script), 'the generated presenter runtime parses as JavaScript')
  const start = script.indexOf('// PRESENTER_POLL_VIEW_MODEL_START')
  const end = script.indexOf('// PRESENTER_POLL_VIEW_MODEL_END', start)
  assert.ok(start >= 0 && end > start)
  const source = script.slice(start, end)
  const viewModel = new Function(`${source}; return presenterPollViewModel`)()
  const held = viewModel(heldState)
  assert.deepEqual({ count: held.count, reveal: held.showReveal, phase: held.phase }, { count: 4, reveal: true, phase: 'open' })
  const revealed = viewModel({ ...heldState, revealed: true })
  assert.equal(revealed.showReveal, false)
  const closed = viewModel({ ...heldState, open: false })
  assert.equal(closed.phase, 'closed')
  assert.equal(closed.showResults, true)
  const live = viewModel({ ...heldState, visibility: 'live', revealed: true })
  assert.equal(live.showReveal, false)
}

let usedBrowser = true
try {
  await runBrowserTest()
} catch (error) {
  const message = String(error?.message || error)
  if (!/MachPortRendezvousServer|bootstrap_check_in[^\n]*Permission denied/.test(message)) throw error
  usedBrowser = false
  runGeneratedDocumentFallback()
} finally {
  await rm(scratch, { recursive: true, force: true })
}

console.log(`presenter poll DOM: armed/open/results/reveal/closed, choice bars, open board and keyboard parity passed (${usedBrowser ? 'Playwright' : 'generated-document fallback'})`)
