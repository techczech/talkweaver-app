import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { extendedPollRuntimeSource } from '../compiler/assets/runtime/poll-extended.js'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true })
page.setDefaultTimeout(8000)
const options = ['a', 'b', 'c'].map(optionId => ({ optionId, label: optionId.toUpperCase() }))
const ranking = { pollType: 'ranking', options }
try {
  await page.setContent('<div id="ballot"></div><button id="submit">Submit</button>')
  await page.addStyleTag({ path: new URL('../compiler/assets/styles/poll-extended.css', import.meta.url).pathname })
  await page.addScriptTag({ content: extendedPollRuntimeSource() })
  async function mount(poll) {
    await page.evaluate(poll => {
      window.ballot?.destroy?.()
      window.changes = []
      window.ballot = createExtendedBallot(document.querySelector('#ballot'), poll, value => {
        window.changes.push(value)
        document.querySelector('#submit').disabled = !value
      })
    }, poll)
  }
  await mount(ranking)
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), ['a','b','c'])
  await page.getByRole('button', { name: 'Move C up', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), ['a','c','b'])
  await page.getByRole('button', { name: 'Reorder C', exact: true }).focus()
  await page.keyboard.press('Home')
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), ['c','a','b'])
  assert.match(await page.locator('[role=status]').innerText(), /C.*1/)
  await page.locator('[data-rank-id="b"] .poll-rank-handle').dragTo(page.locator('[data-rank-id="c"]'))
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), ['b','c','a'])
  const touch = await page.context().newCDPSession(page)
  const source = await page.locator('[data-rank-id="a"] .poll-rank-handle').boundingBox()
  const target = await page.locator('[data-rank-id="b"]').boundingBox()
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: source.x + source.width / 2, y: source.y + source.height / 2 }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x + 20, y: target.y + 5 }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), ['a','b','c'])
  await mount({ ...ranking, rankCount: 3 })
  assert.equal(await page.evaluate(() => window.ballot.value()), null)
  assert.equal(await page.locator('[data-rank-add]').count(), 3)
  await mount({ ...ranking, rankCount: 2 })
  assert.equal(await page.evaluate(() => window.ballot.value()), null)
  await page.getByRole('button', { name: 'Rank C', exact: true }).click()
  assert.equal(await page.evaluate(() => window.ballot.value()), null)
  await page.getByRole('button', { name: 'Rank A', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), ['c','a'])
  await page.getByRole('button', { name: 'Remove C from ranking', exact: true }).click()
  assert.equal(await page.evaluate(() => window.ballot.value()), null)

  const matrix = { pollType: 'rating', options, labels: [{ optionId: 'often', label: 'A lot' }, { optionId: 'never', label: 'Never' }] }
  await mount(matrix)
  await page.getByRole('group', { name: 'A', exact: true }).getByRole('radio', { name: 'A lot', exact: true }).check()
  assert.equal(await page.evaluate(() => window.ballot.value()), null)
  await page.getByRole('group', { name: 'B', exact: true }).getByRole('radio', { name: 'Never', exact: true }).check()
  await page.getByRole('group', { name: 'C', exact: true }).getByRole('radio', { name: 'A lot', exact: true }).check()
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), { a: 'often', b: 'never', c: 'often' })
  await mount({ ...matrix, allowSkip: true })
  await page.getByRole('group', { name: 'C', exact: true }).getByRole('radio', { name: 'Never', exact: true }).check()
  assert.deepEqual(await page.evaluate(() => window.ballot.value()), { c: 'never' })
  await page.getByRole('button', { name: 'Clear answer for C', exact: true }).click()
  assert.equal(await page.evaluate(() => window.ballot.value()), null)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const readingOptions = ["I don't have time to read it all.", "I read but I can't understand what it's all about.", "I get stuck on words and sentences and can't continue until I look them up.", "I forget what I read by the time I have to use it.", 'None of the above'].map((label, i) => ({ optionId: 'reading-' + i, label }))
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    await mount({ ...matrix, options: readingOptions, labels: ['1','2','3'].map(label => ({ optionId: label, label })) })
    const rows = await page.locator('.poll-matrix-item').evaluateAll(items => items.map(item => ({
      bounds: item.getBoundingClientRect().toJSON(),
      labels: [...item.querySelectorAll('label')].map(label => label.getBoundingClientRect().toJSON()),
    })))
    assert.equal(rows.length, 5)
    for (const row of rows) {
      assert.equal(row.labels.length, 3)
      assert.ok(Math.max(...row.labels.map(label => label.y)) - Math.min(...row.labels.map(label => label.y)) < 2, `Three short scale choices must share a row at ${width}px`)
      assert.ok(row.labels.every(label => label.height >= 44 && label.width >= 44), 'Scale choices need usable pointer/touch targets')
      assert.ok(row.labels.every(label => label.x >= row.bounds.x && label.x + label.width <= row.bounds.x + row.bounds.width + 1), 'Scale choices stay inside the item')
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  }
  console.log('Extended ballot controls: ordering, native drag, keyboard, exact Top N, matrix labels and skip passed')
} finally { await browser.close() }
