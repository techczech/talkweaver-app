import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const source = `---
title: Extended presenter polls
auto_title_slide: false
auto_thanks_slide: false
---

### Discussion {id=intro}

Discuss your priorities.

### Rank all approaches {id=rank-all poll=ranking pollresults=held}

- Read
- Discuss
- Practise

### Pick your top two {id=rank-top poll=ranking polltop=2 pollresults=held}

- Read
- Discuss
- Practise

### Rate the approaches {id=rating poll=rating pollskip=true}

[scale: Useful, Less useful]

- Read
- Discuss

### Categorise the approaches {id=category poll=categorisation pollskip=false}

[categories: Individual, Shared]

- Read
- Discuss
`
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-extended-presenter-'))
let browser
const errors = []
try {
  const sourcePath = join(scratch, 'extended-presenter-polls.md')
  await writeFile(sourcePath, source)
  const model = await prepareSource(sourcePath, source, 'extended-presenter-polls', statSync(sourcePath))
  assert.deepEqual(model.warnings.filter(warning => /^poll-authoring-invalid:/.test(warning)), [])
  const htmlPath = join(scratch, 'extended-presenter-polls.html')
  await writeFile(htmlPath, model.fullHtml)
  // Browser launch failures must fail this test; generated markup is not equivalent evidence.
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    window.__pollActions = []
    window.twLivePollBridge = {
      action: async message => { window.__pollActions.push(message); return { success: true, status: 'confirmed' } },
      onState: callback => { window.__pollStateApply = callback },
      onStatus: callback => { window.__pollStatusApply = callback },
      onJoin: callback => { window.__pollJoinApply = callback },
      onOperation: callback => { window.__pollOperationApply = callback },
    }
  })
  await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1&session=extended-presenter-test#intro`)
  const panel = page.locator('#presenterPollPanel')
  const compose = page.locator('#presenterQuickPollCompose')
  const latestAction = () => page.evaluate(() => window.__pollActions.at(-1))

  async function checkIncomingResults(poll) {
    const ranking = poll.type === 'ranking'
    const options = poll.options
    const points = poll.rankCount === 2 ? [5, 4, 3] : [9, 8, 7]
    const state = { ...poll, type: 'poll.state', pollType: poll.type, open: true, revealed: false,
      responseCount: ranking ? 4 : 5,
      ...(ranking ? {
        tallies: Object.fromEntries(options.map((option, i) => [option.optionId, points[i]])),
        firstPlaces: Object.fromEntries(options.map((option, i) => [option.optionId, [2, 1, 1][i]])),
      } : {
        categoryTallies: Object.fromEntries(options.map((option, i) => [option.optionId,
          Object.fromEntries(poll.labels.map((label, j) => [label.optionId, [[3, 1], [1, 4], [2, 3]][i][j]]))])),
      }),
    }
    await page.evaluate(message => window.__pollStateApply(message), state)
    assert.match(await panel.locator('#presenterPollChip').textContent(), new RegExp(`Poll open · ${state.responseCount}$`))
    assert.match(await panel.locator('#presenterPollCount').textContent(), new RegExp(`· ${state.responseCount} `))
    const results = panel.locator('#presenterPollResults')
    assert.equal(await results.isVisible(), true)
    if (ranking) {
      assert.notEqual(await panel.locator('#presenterPollChip').textContent(), `Poll open · ${points.reduce((sum, value) => sum + value, 0)}`)
      assert.match(await results.textContent(), /4 ballots/)
      assert.match(await results.locator('.poll-score-row').first().textContent(), new RegExp(`Read.*${points[0]} points · 2 first-place votes`))
      assert.equal(await results.locator('.poll-score-row').count(), options.length)
    } else {
      assert.match(await results.textContent(), /5 ballots/)
      const row = results.locator('.poll-matrix-result').first()
      assert.match(await row.textContent(), /Read.*4 answered/)
      assert.match(await row.locator('.poll-score-row').first().textContent(), /3 · 75%/)
      assert.match(await row.locator('.poll-score-row').nth(1).textContent(), /1 · 25%/)
      assert.deepEqual(await row.locator('.poll-score-label > span:first-child').allTextContents(), poll.labels.map(label => label.label))
      if (poll.allowSkip) assert.match(await row.textContent(), /1 skipped/)
      else assert.doesNotMatch(await results.textContent(), /skipped/)
    }
    await page.evaluate(message => window.__pollStateApply(message), { ...state, open: false, revealed: true })
    assert.match(await panel.locator('#presenterPollChip').textContent(), new RegExp(`Poll closed · ${state.responseCount}$`))
    assert.equal(await results.isVisible(), true)
  }

  const quickCases = [
    { type: 'ranking' },
    { type: 'ranking', rankCount: 2 },
    { type: 'rating', labels: ['Useful', 'Less useful'], allowSkip: true },
    { type: 'categorisation', labels: ['Individual', 'Shared'], allowSkip: false },
  ]
  for (const spec of quickCases) {
    await page.locator('#presenterQuickPollButton').click()
    assert.equal(await compose.isVisible(), true)
    await compose.locator(`[data-quick-poll-type="${spec.type}"]`).click()
    await compose.locator('#quickPollQuestion').fill(`Quick ${spec.type}`)
    const rows = compose.locator('.quick-poll-option-row input')
    await rows.nth(0).fill('Read')
    await rows.nth(1).fill('Discuss')
    await compose.locator('#quickPollAddOption').click()
    await rows.nth(2).fill('Practise')
    await compose.locator('[data-quick-poll-visibility="held"]').click()
    if (spec.type === 'ranking') {
      assert.equal(await compose.locator('[data-rank-mode="all"]').isChecked(), true, 'new ranking defaults to rank all')
      if (spec.rankCount) {
        await compose.locator('[data-rank-mode="top"]').check()
        await compose.locator('[data-quick-rank-count]').fill('4')
        assert.equal(await compose.locator('#quickPollOpen').isDisabled(), true, 'top count cannot exceed options')
        await compose.locator('[data-quick-rank-count]').fill(String(spec.rankCount))
      }
    } else {
      await compose.locator('[data-quick-matrix-labels]').fill(spec.labels.join(', '))
      await compose.locator('[data-quick-matrix-skip]').setChecked(spec.allowSkip)
    }
    assert.equal(await compose.locator('#quickPollOpen').isEnabled(), true)
    const before = await page.evaluate(() => window.__pollActions.length)
    await compose.locator('#quickPollOpen').click()
    await page.waitForFunction(count => window.__pollActions.length === count + 1, before)
    const action = await latestAction()
    assert.equal(action.type, 'poll.open')
    assert.match(action.poll.pollId, /^quick-/)
    assert.equal(action.poll.type, spec.type)
    assert.equal(action.poll.visibility, 'held')
    assert.deepEqual(action.poll.options.map(option => option.label), ['Read', 'Discuss', 'Practise'])
    assert.equal(action.poll.rankCount, spec.rankCount)
    if (spec.labels) {
      assert.deepEqual(action.poll.labels, spec.labels.map((label, index) => ({ optionId: `${action.poll.pollId}-label-${index + 1}`, label })))
      assert.equal(action.poll.allowSkip, spec.allowSkip)
    } else assert.equal(Object.hasOwn(action.poll, 'rankCount'), spec.rankCount !== undefined)
    await checkIncomingResults(action.poll)
    await page.locator('#presenterQuickPollDismiss').click()
  }

  for (const spec of [
    { id: 'rank-all', type: 'ranking' },
    { id: 'rank-top', type: 'ranking', rankCount: 2 },
    { id: 'rating', type: 'rating', labels: ['Useful', 'Less useful'], allowSkip: true },
    { id: 'category', type: 'categorisation', labels: ['Individual', 'Shared'], allowSkip: false },
  ]) {
    await page.evaluate(id => { location.hash = `#${id}` }, spec.id)
    await page.waitForFunction(id => document.querySelector('.slide.active')?.dataset.id === id, spec.id)
    const definition = await page.locator(`.slide[data-id="${spec.id}"]`).evaluate(slide => JSON.parse(slide.dataset.poll))
    assert.equal(definition.type, spec.type)
    assert.equal(definition.rankCount, spec.rankCount)
    if (spec.labels) {
      assert.deepEqual(definition.labels.map(label => label.label), spec.labels)
      assert.equal(definition.allowSkip, spec.allowSkip)
    }
    await panel.locator('#presenterPollOpen').click()
    const action = await latestAction()
    assert.deepEqual(action, { type: 'poll.open', poll: { ...definition, slideId: spec.id } }, 'authored metadata crosses the presenter bridge unchanged')
    await checkIncomingResults(action.poll)
  }
  assert.deepEqual(errors, [], 'generated presenter runtime has no browser exceptions')
  console.log('extended presenter browser: Quick rank-all/top-N, rating/category labels and skipping, authored metadata, incoming ballot totals/first places/category percentages passed (headless Playwright)')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
