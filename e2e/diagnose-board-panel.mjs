// Feedback-boards ticket 05 in the real app (journey 2; drawings D1, D2, D23, D24 in
// docs/design/2026-09-28-feedback-boards/round-2/shots). Everything local: an isolated temp vault and
// userData, a `wrangler dev` live Worker started here (throwaway secrets, nothing deployed), windows
// hidden, one run at a time.
//
// The presenter goes live on a board slide and opens the board with Q; phones add cards. The board
// panel shows them beside the slide; a drag merges two cards and the worker confirms it (the phones
// see the group). Pop out: the board opens in a window of its own, paired with the presenter window
// (a separate BrowserWindow, placed by the main process, named by the board); a drag there goes
// through the presenter's live bridge to the worker; Put back closes it and the panel returns;
// closing the board window does the same; closing the presenter window closes the board window.
// Screenshots: TW_SHOTS (default <OS temp>/tw-b05-shots).
// Run: npm run build && node e2e/diagnose-board-panel.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { startLiveWorker } from '../scripts/lib/live-worker-harness.mjs'

const repo = process.cwd()
const shots = process.env.TW_SHOTS || join(tmpdir(), 'tw-b05-shots')
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-board-panel-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
const talkSlug = 'board-panel-probe'
const talkDir = join(vault, talkSlug)
for (const dir of [talkDir, userData, shots]) mkdirSync(dir, { recursive: true })

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, timeoutMs, label) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}; last: ${JSON.stringify(value)?.slice(0, 400)}`)
    await sleep(100)
  }
}

const handout = join(talkDir, 'handout.html')
writeFileSync(handout, '<!doctype html><title>Board panel probe handout</title>')
const outlinePath = join(talkDir, `${talkSlug}-outline.md`)
const source = ['---', 'title: The current state of AI agents', 'outline_version: 2', `handout_url: ${pathToFileURL(handout).href}`,
  'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### What should we keep, change, try?', '{id=kct poll=board}', '', 'Add what you would keep, change or try.', '', '- Keep', '- Change', '- Try', '',
  '### Thank you', '{id=thanks}', '', 'Questions welcome.', ''].join('\n')
writeFileSync(outlinePath, source, 'utf8')

const worker = await startLiveWorker()
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, liveWorkerBaseUrl: worker.baseUrl }, null, 2), 'utf8')
await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo,
  env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', TALKWEAVER_LIVE_ADMIN_SECRET: worker.adminSecret } })
const phones = []
try {
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    electronApp.on('browser-window-created', (_event, win) => hide(win))
  })
  const editor = await app.firstWindow()
  await editor.waitForLoadState('domcontentloaded')
  await editor.waitForTimeout(800)

  const presenterPromise = app.waitForEvent('window')
  const opened = editor.evaluate(({ path, text }) => window.tw.talk.present(path, text, 'presenter', 'kct'), { path: outlinePath, text: source })
  const presenter = await presenterPromise
  record('the talk is presented', (await opened).success === true)
  await presenter.waitForLoadState('domcontentloaded')
  presenter.setDefaultTimeout(45_000)
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.setSize(1440, 900) })
  await presenter.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  const errors = []
  presenter.on('pageerror', (error) => errors.push(error.message))
  if (await presenter.isVisible('#twResume').catch(() => false)) await presenter.click('#twResumeNo')
  await presenter.locator('#presenterMenuLive').click()
  await presenter.locator('#liveGoButton').click()
  await presenter.waitForFunction(() => document.querySelector('#liveGoButton')?.classList.contains('is-live'))
  await presenter.locator('#liveGoPanelClose').click().catch(() => {})
  const discovery = await until(() => fetch(`${worker.baseUrl}/session/${talkSlug}`).then((r) => r.json()), (d) => d.live, 10_000, 'session discovery')
  const sessionId = discovery.sessionId

  // Q opens the board (the board slide's own poll).
  await presenter.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'kct')
  await presenter.keyboard.press('q')
  await presenter.waitForFunction(() => /Open/.test(document.querySelector('#presenterBoardPanel .bp-chip')?.textContent || ''), null, { timeout: 15_000 })
  record('Q opens the board and the panel says Open', true)
  const pollId = await presenter.evaluate(() => JSON.parse(document.querySelector('.slide[data-id="kct"]').dataset.poll).pollId)
  const columns = await presenter.evaluate(() => JSON.parse(document.querySelector('.slide[data-id="kct"]').dataset.poll).options.map((o) => o.optionId))

  async function phone(name) {
    const socket = new WebSocket(`${worker.wsUrl}/sessions/${sessionId}/audience?protocol=2&participantId=participant-${name}-e2e`)
    phones.push(socket)
    const inbox = []
    socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data))))
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let n = 0
    return {
      inbox,
      add: async (column, text) => {
        const submissionId = `${name}-submission-${++n}`
        socket.send(JSON.stringify({ type: 'card.add', submissionId, pollId, column, text }))
        return until(() => inbox.find((m) => m.type === 'card.ack' && m.submissionId === submissionId), Boolean, 5000, `ack ${submissionId}`)
      },
    }
  }
  const ann = await phone('ann'), ben = await phone('ben'), cat = await phone('cat')
  await ann.add(columns[0], 'More time for hands-on')
  await ben.add(columns[0], 'Hands-on, please')
  await cat.add(columns[0], 'More practice time')
  await ann.add(columns[1], 'Shorter breaks')
  await ben.add(columns[2], 'Try pair work')
  await presenter.waitForFunction(() => document.querySelectorAll('#presenterBoardPanel .bp-card').length >= 5, null, { timeout: 10_000 })
  record('phone cards reach the presenter\'s inbox (D1)', (await presenter.locator('#presenterBoardPanel .bp-inbox .bp-card').count()) === 5)
  await presenter.screenshot({ path: join(shots, 'e2e-D1-board-panel-1440x900.png') })

  const center = async (page, selector) => {
    const box = await page.locator(selector).first().boundingBox()
    return { x: box.x + box.width / 2, y: box.y + Math.min(14, box.height / 2) }
  }
  const drag = async (page, from, to) => {
    const a = await center(page, from), b = await center(page, to)
    await page.mouse.move(a.x, a.y); await page.mouse.down()
    await page.mouse.move(a.x + 12, a.y + 8, { steps: 3 }); await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up()
  }
  const card = (text) => `.bp-card:has(.bp-text:text-is("${text}"))`
  // Merge on the presenter: the worker confirms and the phones see a group of two.
  await drag(presenter, card('Hands-on, please'), card('More time for hands-on'))
  await presenter.waitForFunction(() => document.querySelector('#presenterBoardPanel .bp-card.is-group .bp-x')?.textContent === '×2', null, { timeout: 10_000 })
  const phoneGroup = await until(() => [...ann.inbox].reverse().find((m) => m.type === 'poll.state' && m.pollId === pollId), (m) => m?.boardState?.groups?.[0]?.count === 2, 10_000, 'the phones see the group')
  record('a drag in the panel merges on the worker: the group shows ×2 in the panel and on phones (D2)', phoneGroup?.boardState?.groups?.[0]?.count === 2)

  // D13: the group's wording, set in the panel, reaches the phones.
  await presenter.click('.bp-card.is-group')
  await presenter.click('#boardRelabel')
  await presenter.fill('#boardRelabelInput', 'Hands-on time')
  await presenter.keyboard.press('Enter')
  const worded = await until(() => [...ann.inbox].reverse().find((m) => m.type === 'poll.state' && m.pollId === pollId), (m) => m?.boardState?.groups?.[0]?.label === 'Hands-on time', 10_000, 'the phones see the wording').catch(() => null)
  record('Edit the group\'s wording reaches the worker and every phone (D13)', worded?.boardState?.groups?.[0]?.label === 'Hands-on time')
  // Only the blank page the presenter opens for its board may take the board window's name.
  const countBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const refused = await presenter.evaluate(() => window.open('https://example.com/', 'tw-board-window') === null)
  await sleep(500)
  record('a page other than the blank board page is refused under the board window\'s name', refused && await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === countBefore)

  // Pop out (D23): a window of its own, paired with the presenter window.
  const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const boardWindowPromise = app.waitForEvent('window')
  await presenter.click('#boardPopOut')
  const boardWindow = await boardWindowPromise
  await boardWindow.waitForLoadState('domcontentloaded').catch(() => {})
  await boardWindow.waitForSelector('#boardWindowPanel .bp-card', { timeout: 10_000 })
  const paired = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({ title: win.getTitle(), minimum: win.getMinimumSize() })))
  record('Pop out opens one more BrowserWindow', paired.length === windowsBefore + 1, JSON.stringify(paired.map((w) => w.title)))
  record('the board window is named by the board', paired.some((w) => w.title === 'Board · What should we keep, change, try? · TalkWeaver'), JSON.stringify(paired.map((w) => w.title)))
  record('the main process set the board window up (its minimum size)', paired.some((w) => w.minimum[0] === 900 && w.minimum[1] === 560))
  const bridgeInChild = await boardWindow.evaluate(() => typeof window.twLivePollBridge)
  record('the board window runs no live bridge of its own (the presenter window sends for it)', bridgeInChild === 'undefined', bridgeInChild)
  record('the presenter window is back to its own layout while the board is out (D23)', await presenter.locator('#presenterBoardPanel').isHidden())
  record('the presenter counter says the board is in its own window (D23)', /own window/.test(await presenter.textContent('#presenterBoardCount')))
  await boardWindow.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  await boardWindow.screenshot({ path: join(shots, 'e2e-D23-board-window-1440x900.png') })
  await presenter.screenshot({ path: join(shots, 'e2e-D23-presenter-window-1440x900.png') })
  await drag(boardWindow, card('More practice time'), '.bp-card.is-group')
  await boardWindow.waitForFunction(() => document.querySelector('.bp-card.is-group .bp-x')?.textContent === '×3', null, { timeout: 10_000 }).catch(() => {})
  const phoneThree = await until(() => [...ann.inbox].reverse().find((m) => m.type === 'poll.state' && m.pollId === pollId), (m) => m?.boardState?.groups?.[0]?.count === 3, 10_000, 'the phones see ×3').catch(() => null)
  record('a drag in the board window reaches the worker through the presenter window (×3 on phones)', phoneThree?.boardState?.groups?.[0]?.count === 3)

  // Put back (D24).
  const closed = boardWindow.waitForEvent('close', { timeout: 10_000 }).catch(() => null)
  await boardWindow.click('#boardPutBack')
  await closed
  await presenter.waitForFunction(() => !document.getElementById('presenterBoardPanel').hidden, null, { timeout: 5000 }).catch(() => {})
  record('Put back closes the board window and the panel returns beside the slide (D24)', boardWindow.isClosed() && !(await presenter.locator('#presenterBoardPanel').isHidden()))
  // Closing the board window does the same.
  const second = app.waitForEvent('window')
  await presenter.click('#boardPopOut')
  const boardWindow2 = await second
  await boardWindow2.waitForSelector('#boardWindowPanel .bp-card', { timeout: 10_000 })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((win) => win.getTitle().startsWith('Board ·'))?.close() })
  await presenter.waitForFunction(() => !document.getElementById('presenterBoardPanel').hidden, null, { timeout: 5000 }).catch(() => {})
  record('closing the board window puts the board back beside the slide (D24)', !(await presenter.locator('#presenterBoardPanel').isHidden()))
  // Closing the presenter window closes a board window that is out.
  const third = app.waitForEvent('window')
  await presenter.click('#boardPopOut')
  const boardWindow3 = await third
  await boardWindow3.waitForSelector('#boardWindowPanel .bp-card', { timeout: 10_000 })
  record('no page error in the presenter', errors.length === 0, errors.join(' | '))
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((win) => win.getTitle().startsWith('TalkWeaver Presenter'))?.destroy() })
  const left = await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).map((win) => win.getTitle())), (titles) => !titles.some((t) => t.startsWith('Board ·')), 5000, 'the board window closes with its presenter window').catch((error) => [String(error)])
  record('closing the presenter window closes its board window', !left.some((t) => t.startsWith('Board ·')), JSON.stringify(left))
  record('every window stayed hidden', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((win) => !win.isVisible())))
} catch (error) {
  failures += 1
  console.log(`FAIL harness — ${error?.stack || error}`)
} finally {
  for (const socket of phones) { try { socket.close() } catch { /* closed */ } }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.destroy())).catch(() => {})
  await app.close().catch(() => {})
  await worker.stop()
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} failure(s)` : '\nboard panel e2e: all checks passed')
process.exit(failures ? 1 : 0)
