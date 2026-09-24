import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

// Drive the real presenter preload, main IPC, WebSocket client and local Worker.
// No production credentials, remote session or user vault are used.
const root = mkdtempSync(join(tmpdir(), 'tw-poll-launch-'))
const ud = join(root, 'userData'), vault = join(root, 'vault'), deck = join(vault, 'poll-launch')
mkdirSync(ud, { recursive: true }); mkdirSync(deck, { recursive: true })
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const handout = join(deck, 'handout.html')
writeFileSync(handout, '<!doctype html><title>Local poll probe</title>')
const source = `---
outline_version: 2
title: Extended poll launch
handout_url: ${pathToFileURL(handout).href}
auto_title_slide: false
auto_thanks_slide: false
---

### Rank these approaches
{id=rank poll=ranking pollresults=held}

- Read
- Discuss
- Practise

### Rate these approaches
{id=rate poll=rating}

[scale: 1, 2, 3]

- Read
- Discuss
- Practise
`
const outlinePath = join(deck, 'poll-launch-outline.md')
writeFileSync(outlinePath, source)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, liveWorkerBaseUrl: `http://127.0.0.1:${port}` }))
const executablePath = process.env.TW_TEST_APP_EXECUTABLE
const app = await electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [...(executablePath ? [] : ['.']), '--user-data-dir=' + ud],
  cwd: resolve('.'), env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', TW_LIVE_LOCAL: '1' }
})
try {
  await app.evaluate(({ app, BrowserWindow }) => {
    const hide = win => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    app.on('browser-window-created', (_event, win) => hide(win))
  })
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  const win = app.waitForEvent('window')
  const opened = main.evaluate(({ outlinePath, source }) => window.tw.talk.present(outlinePath, source, 'presenter', 'rank'), { outlinePath, source })
  const presenter = await win
  assert.equal((await opened).success, true)
  await presenter.waitForLoadState('domcontentloaded')
  presenter.setDefaultTimeout(45000)
  const errors = []; presenter.on('pageerror', error => errors.push(error.message))
  await presenter.locator('#liveGoButton').click()
  await presenter.waitForFunction(() => document.querySelector('#liveGoButton')?.classList.contains('is-live'))
  await presenter.locator('#liveGoPanelClose').click()
  for (const [slide, type] of [['rank', 'ranking'], ['rate', 'rating']]) {
    if (slide === 'rate') await presenter.keyboard.press('ArrowRight')
    await presenter.waitForFunction(id => document.querySelector('.slide.active')?.dataset.id === id, slide)
    await presenter.locator('#presenterPollOpen').click()
    await presenter.waitForFunction(() => document.querySelector('#presenterPollChip')?.textContent === 'Poll open · 0')
    assert.equal(await presenter.locator('#presenterPollType').textContent(), type.toUpperCase())
    assert.match(await presenter.locator('#presenterPollDisplayStatus').textContent(), /Accepting responses/)
    assert.equal(await presenter.locator('#presenterPollOperation').isVisible(), false)
    console.log(`PASS ${type}: actual presenter click received local Worker confirmation`)
    await presenter.locator('#presenterPollClose').click()
    await presenter.waitForFunction(() => document.querySelector('#presenterPollChip')?.textContent === 'Poll closed · 0')
  }
  assert.deepEqual(errors, [])
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())))
} finally {
  // This fixture tests poll delivery, not the interactive recording/close workflow.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(win => win.destroy())).catch(() => {})
  await app.close()
  rmSync(root, { recursive: true, force: true })
}
