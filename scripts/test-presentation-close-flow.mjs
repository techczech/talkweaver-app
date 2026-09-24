import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'

assert.ok(existsSync('src/preload/present-close-flow.ts'), 'shared presentation close flow exists')
const bundled = await build({ entryPoints: ['src/preload/present-close-flow.ts'], bundle: true, write: false, format: 'iife', globalName: 'CloseFlow', platform: 'browser' })
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage()
try {
  async function open(offer, options = {}) {
    await page.setContent('<button id="present">Present</button>')
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.evaluate(({ offer, options }) => {
      window.calls = []
      window.recState = options.state ?? 'idle'
      window.failSave = options.failSave ?? false
      window.failClose = options.failClose ?? false
      const controller = {
        getState: () => window.recState,
        runGate: () => ({ audioArmed: ['recording', 'paused', 'confirm', 'saving'].includes(window.recState) }),
        plannedRuns: async () => options.planned ?? [],
        currentKind: () => 'delivery',
        saveRun: async (...args) => { calls.push(['saveRun', ...args]); return { ok: !window.failSave } },
        stop: async (keep) => { calls.push(['stop', keep]); window.recState = 'confirm'; return null },
        confirmSave: async (keep) => { calls.push(['confirmSave', keep]); if (!window.failSave) window.recState = 'saved'; return { ok: !window.failSave } },
        closeWindow: async (action) => { calls.push(['close', action ?? null]); if (window.failClose) throw new Error('Could not end live session') },
      }
      document.querySelector('#present').focus()
      CloseFlow.showPresentationCloseOffer(controller, offer)
      window.offerAgain = () => CloseFlow.showPresentationCloseOffer(controller, offer)
    }, { offer, options })
  }
  const calls = () => page.evaluate(() => window.calls)
  const click = (name) => page.getByRole('button', { name, exact: true }).click()
  await open({ live: true, offerRunSave: false })
  assert.equal(await page.getByRole('dialog').count(), 1)
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel')
  await page.evaluate(() => window.offerAgain())
  assert.equal(await page.getByRole('dialog').count(), 1, 'repeated close has one prompt')
  await page.keyboard.press('Escape')
  assert.deepEqual(await calls(), [], 'Escape cancels without closing')
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.evaluate(() => document.activeElement.id), 'present')
  for (const [name, action] of [['Close and end session', 'end'], ['Close presentation, keep live', 'keep']]) {
    await open({ live: true, offerRunSave: false })
    await click(name)
    assert.deepEqual(await calls(), [['close', action]])
  }
  await open({ live: true, offerRunSave: true })
  assert.equal(await page.getByRole('button', { name: 'Save delivery', exact: true }).isDisabled(), true, 'live action requires explicit selection')
  await page.getByLabel('Keep live session').check()
  await click('Save delivery')
  assert.deepEqual(await calls(), [['saveRun', 'delivery'], ['close', 'keep']])
  await open({ live: true, offerRunSave: true })
  await page.getByLabel('End live session').check()
  await click("Don't save")
  assert.deepEqual(await calls(), [['close', 'end']])
  await open({ live: true, offerRunSave: true })
  await page.getByLabel('Keep live session').check()
  await click('Save as…')
  assert.equal(await page.getByRole('dialog').count(), 1, 'kind picker stays in the same confirmation')
  await page.getByLabel('Run kind').selectOption('rehearsal')
  await click('Save selected kind')
  assert.deepEqual(await calls(), [['saveRun', 'rehearsal'], ['close', 'keep']])
  await open({ live: false, offerRunSave: true }, { planned: [{ id: 'plan-1', eventTitle: 'Workshop', preferred: true }] })
  await click('Workshop')
  assert.deepEqual(await calls(), [['saveRun', 'delivery', 'plan-1'], ['close', null]])
  await open({ live: true, offerRunSave: true }, { failSave: true })
  await page.getByLabel('End live session').check()
  await click('Save delivery')
  assert.deepEqual(await calls(), [['saveRun', 'delivery']])
  assert.equal(await page.getByRole('dialog').count(), 1, 'failed save retains presentation')
  assert.match(await page.getByRole('alert').textContent(), /saved/i)
  await page.evaluate(() => { window.failSave = false })
  await click('Save delivery')
  assert.equal((await calls()).at(-1)[0], 'close', 'save can be retried')
  await open({ live: true, offerRunSave: false }, { failClose: true })
  await click('Close and end session')
  assert.equal(await page.getByRole('dialog').count(), 1)
  assert.match(await page.getByRole('alert').textContent(), /Could not end live session/)
  for (const state of ['recording', 'paused', 'confirm']) {
    await open({ live: true, offerRunSave: false, audioArmed: true }, { state })
    await page.getByLabel('Keep live session').check()
    assert.equal(await page.getByRole('button', { name: "Don't save", exact: true }).count(), 0)
    await click('Stop and save recording')
    const expected = state === 'confirm' ? [] : [['stop', true]]
    assert.deepEqual(await calls(), [...expected, ['confirmSave', true], ['close', 'keep']], 'short audio is explicitly kept before close')
  }
  await open({ live: false, offerRunSave: false, audioArmed: true }, { state: 'recording', failSave: true })
  await click('Stop and save recording')
  assert.deepEqual(await calls(), [['stop', true], ['confirmSave', true]])
  assert.equal(await page.getByRole('dialog').count(), 1, 'audio save failure blocks window destruction')
  console.log('presentation close flow: headless Chrome choices, cancellation, combined saves, planned delivery, failure retry and active audio passed')
} finally {
  await browser.close()
}
