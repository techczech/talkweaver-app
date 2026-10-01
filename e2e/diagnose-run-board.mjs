// Feedback-boards ticket 06 in the real app (journey 5; drawings D20, R1, R3–R9, H1 in
// docs/design/2026-09-28-feedback-boards/round-2/shots). Everything local: an isolated temp vault
// and userData, a `wrangler dev` live Worker started here (throwaway secrets, nothing deployed),
// windows hidden.
//
// Part 1, live: a planned Run is presented and goes live; a board poll opens; two phones add cards.
// End live asks, with the board still open, "Close the board now" or "Keep it open for late cards"
// (D20); Keep. A phone joins after the end and adds a late card. The Run is saved at close. History:
// the Run card shows the board (R1) left open (R3) with the ledger badge (R9); Re-check live pulls
// the late card in (LATE); Refresh from the board (R4); Copy as Markdown (R5); Share a read-only link
// (R7) served by the worker, read on a phone (R6), Stop sharing; Close it now.
// Part 2, a seeded Run: hidden cards listed apart and Put back (R8), poll results (H1).
// Screenshots: TW_SHOTS (default <OS temp>/tw-b06-shots).
// Run: npm run build && node e2e/diagnose-run-board.mjs
import { _electron as electron, chromium } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { startLiveWorker } from '../scripts/lib/live-worker-harness.mjs'

const repo = process.cwd()
const shots = process.env.TW_SHOTS || join(tmpdir(), 'tw-b06-shots')
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-board-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
const talkSlug = 'board-probe'
const talkDir = join(vault, talkSlug)
const ledgerDir = join(vault, '_PRESENTATIONS', talkSlug)
for (const dir of [talkDir, ledgerDir, userData, shots]) mkdirSync(dir, { recursive: true })

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const text = async (locator) => ((await locator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
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
writeFileSync(handout, '<!doctype html><title>Board probe handout</title>')
const slide = (id, title) => `### ${title}\n{id=${id}}\n\n${title} body.\n`
const outlinePath = join(talkDir, `${talkSlug}-outline.md`)
const source = ['---', 'title: The current state of AI agents', 'outline_version: 2', `handout_url: ${pathToFileURL(handout).href}`,
  'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  slide('s1', 'Opening'), slide('rating', 'How confident are you with AI at work?'), slide('board', 'What should we keep, change, try?'), slide('s4', 'Close')].join('\n')
writeFileSync(outlinePath, source, 'utf8')

const worker = await startLiveWorker()
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, liveWorkerBaseUrl: worker.baseUrl }, null, 2), 'utf8')

const plannedDate = new Date().toISOString().slice(0, 10)
const plannedRun = { id: 'run-oct', talkSlug, talkTitle: 'The current state of AI agents', kind: 'delivery', status: 'planned', plannedDate,
  eventTitle: 'ITSS Briefing', audience: 'Oxford', slideSet: { kind: 'full' }, startedAt: `${plannedDate}T00:00:00.000Z`, endedAt: '',
  recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [] }
const plannedPath = join(ledgerDir, 'run-oct.json')
writeFileSync(plannedPath, `${JSON.stringify(plannedRun, null, 2)}\n`, 'utf8')

// Part 2's Run: a board with hidden cards and two polls, delivered two days ago.
const seededStart = new Date(Date.now() - 2 * 86_400_000)
seededStart.setHours(14, 0, 0, 0)
const t = (m) => seededStart.getTime() + m * 60_000
const seededCards = [
  ['c1', 'keep', 'More time for hands-on', 1, 1], ['c2', 'keep', 'Hands-on, please', 1, 2], ['c3', 'keep', 'More hands-on, less talk', 1, 3],
  ['c4', 'keep', 'The live demo of the expenses form', 4, 4], ['c5', 'keep', 'Live demo was great', 4, 5],
  ['c6', 'keep', 'The pace of the first half', null, 6], ['c7', 'keep', 'Real prompts on the slides', null, 7],
  ['c8', 'change', 'Shorter breaks', 2, 8], ['c9', 'change', 'Shorter breaks please', 2, 9], ['c10', 'change', 'Less jargon', null, 10],
  ['c11', 'change', 'Does anyone know the wifi password?', null, 11, true], ['c12', 'keep', 'This is a waste of a morning', null, 12, true],
  ['c13', 'try', 'Try pair work', 3, 13], ['c14', 'try', 'Pair work next time', 3, 14], ['c15', 'try', '<img src=x onerror="document.title=\'pwned\'"> as text', null, 15],
]
const seeded = {
  id: 'run-sep', talkSlug, talkTitle: 'The current state of AI agents', kind: 'delivery', status: 'delivered', slideSet: { kind: 'full' },
  eventTitle: 'Digital Education Day', audience: 'York', startedAt: seededStart.toISOString(), endedAt: new Date(t(62)).toISOString(),
  recordingMs: 0, wallClockMs: 62 * 60_000, timerTargetMin: 60, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [],
  polls: [
    { id: 'poll-rating', slideId: 'rating', type: 'rating', question: 'How confident are you with AI at work?', visibility: 'live',
      options: [{ optionId: 'w', label: 'Writing and editing' }, { optionId: 'f', label: 'Finding sources' }],
      labels: [{ optionId: 'n', label: 'Not yet' }, { optionId: 'a', label: 'A little' }, { optionId: 'v', label: 'Very' }] },
    { id: 'poll-board', slideId: 'board', type: 'board', question: 'What should we keep, change, try?', visibility: 'live',
      options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }] },
  ],
  pollResponses: [
    { responseId: 's:1', pollId: 'poll-rating', choice: { w: 'a', f: 'n' }, tMs: 1000, slideId: 'rating' },
    { responseId: 's:2', pollId: 'poll-rating', choice: { w: 'v', f: 'a' }, tMs: 2000, slideId: 'rating' },
    { responseId: 's:3', pollId: 'poll-rating', choice: { w: 'v', f: 'v' }, tMs: 3000, slideId: 'rating' },
  ],
  boards: [{ id: 'poll-board', slideId: 'board', question: 'What should we keep, change, try?', sessionId: 'session-sep', liveEndedAt: t(62),
    columns: [{ id: 'keep', label: 'Keep' }, { id: 'change', label: 'Change' }, { id: 'try', label: 'Try' }],
    cards: seededCards.map(([id, column, cardText, group, m, hidden]) => ({ id, column, text: cardText, acceptedAt: t(40 + m), ...(group ? { group } : {}), ...(hidden ? { hidden: true } : {}) })),
    groups: [{ n: 1, column: 'keep', cardIds: ['c1', 'c2', 'c3'] }, { n: 4, column: 'keep', cardIds: ['c4', 'c5'] }, { n: 2, column: 'change', cardIds: ['c8', 'c9'] }, { n: 3, column: 'try', cardIds: ['c13', 'c14'] }] }],
}
const seededPath = join(ledgerDir, 'run-sep.json')
writeFileSync(seededPath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')

await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo,
  env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', TALKWEAVER_LIVE_ADMIN_SECRET: worker.adminSecret } })
const phones = []
let phoneBrowser = null
try {
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    electronApp.on('browser-window-created', (_event, win) => hide(win))
  })
  const editor = await app.firstWindow()
  await editor.waitForLoadState('domcontentloaded')
  await editor.waitForTimeout(800)

  // ── Part 1: live ─────────────────────────────────────────────────────────────────────────
  const presenterPromise = app.waitForEvent('window')
  const opened = editor.evaluate(({ outlinePath: path, source: text }) => window.tw.talk.present(path, text, 'presenter', undefined, 'run-oct'), { outlinePath, source })
  const presenter = await presenterPromise
  record('the planned Run is presented', (await opened).success === true)
  await presenter.waitForLoadState('domcontentloaded')
  presenter.setDefaultTimeout(45_000)
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.setSize(1440, 900) })
  await presenter.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  const errors = []
  presenter.on('pageerror', (error) => errors.push(error.message))
  await presenter.locator('#presenterMenuLive').click()
  await presenter.locator('#liveGoButton').click()
  await presenter.waitForFunction(() => document.querySelector('#liveGoButton')?.classList.contains('is-live'))
  await presenter.locator('#liveGoPanelClose').click().catch(() => {})
  const discovery = await until(() => fetch(`${worker.baseUrl}/session/${talkSlug}`).then((r) => r.json()), (d) => d.live, 10_000, 'session discovery')
  const sessionId = discovery.sessionId
  record('going live registers the talk\'s session on the local worker', !!sessionId)

  const boardDefinition = { pollId: 'poll-board-live', slideId: 'board', type: 'board', question: 'What should we keep, change, try?', visibility: 'live',
    options: [{ optionId: 'keep', label: 'Keep' }, { optionId: 'change', label: 'Change' }, { optionId: 'try', label: 'Try' }], board: { closesAfterDays: 7 } }
  const openResult = await presenter.evaluate((poll) => window.twLivePollBridge.action({ type: 'poll.open', poll }), boardDefinition)
  record('a board poll opens through the presenter\'s live bridge', openResult.success === true, JSON.stringify(openResult))

  async function phone(name) {
    const socket = new WebSocket(`${worker.wsUrl}/sessions/${sessionId}/audience?protocol=2&participantId=participant-${name}-e2e`)
    phones.push(socket)
    const inbox = []
    socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data))))
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let n = 0
    return {
      inbox,
      add: async (column, cardText) => {
        const submissionId = `${name}-submission-${++n}`
        socket.send(JSON.stringify({ type: 'card.add', submissionId, pollId: 'poll-board-live', column, text: cardText }))
        return until(() => inbox.find((m) => m.type === 'card.ack' && m.submissionId === submissionId), Boolean, 5000, `ack ${submissionId}`)
      },
    }
  }
  const ann = await phone('ann')
  const ben = await phone('ben')
  // The board is open on the worker once the presenter's operation is confirmed; a phone's sync shows it.
  let syncs = 0
  await until(async () => {
    const syncId = `sync-board-${++syncs}`
    phones[0].send(JSON.stringify({ type: 'session.sync', syncId }))
    await sleep(300)
    return ann.inbox.find((m) => (m.type === 'session.snapshot' && m.polls?.some((p) => p.pollId === 'poll-board-live' && p.open))
      || (m.type === 'poll.state' && m.pollId === 'poll-board-live' && m.open))
  }, Boolean, 10_000, 'phones see the board')
  record('phone cards are taken', (await ann.add('keep', 'More time for hands-on')).status === 'confirmed'
    && (await ben.add('change', 'Shorter breaks')).status === 'confirmed' && (await ben.add('try', 'Try pair work')).status === 'confirmed')

  // End live with the board open: the D20 question.
  await presenter.evaluate(() => { const el = document.querySelector('#presenterEndLive'); if (el) el.hidden = false })
  await presenter.locator('#presenterEndLive').click()
  const popover = presenter.locator('#twEndLiveBoards')
  await popover.waitFor()
  const popText = await text(popover)
  record('End live asks: close the board now or keep it open for late cards (D20)',
    popText.includes('End the live session?') && popText.includes('One board is still open: “What should we keep, change, try?” (3 cards).')
    && popText.includes('Close the board now') && popText.includes('Keep it open for late cards'), popText)
  record('Keep it open is selected, as drawn', await popover.locator('input[value="keep"]').isChecked())
  await presenter.screenshot({ path: join(shots, 'D20-end-live-keep-open-1440x900.png') })
  await popover.locator('.tw-elb-end').click()
  await until(() => fetch(`${worker.baseUrl}/sessions/${sessionId}/status`).then((r) => r.json()), (s) => s.status === 'ended', 10_000, 'session ended')
  record('the question goes away and the session ends', await popover.count() === 0)

  const cat = await phone('cat').catch(() => null)
  record('a phone can still join after the end', !!cat)
  const lateAck = cat ? await cat.add('keep', 'Recording of the demo, please') : null
  record('a late card lands on the board left open', lateAck?.status === 'confirmed', JSON.stringify(lateAck))

  // Save the Run at close, on the planned Run.
  for (let i = 0; i < 4; i++) { await presenter.keyboard.press('ArrowRight'); await presenter.waitForTimeout(150) }
  await presenter.evaluate(() => window.close())
  await presenter.waitForSelector('.twrec-close-modal')
  const presenterClosed = presenter.waitForEvent('close', { timeout: 20_000 }).catch(() => {})
  await presenter.locator('[data-planned-run="run-oct"]').click()
  await presenterClosed
  record('no page error in the presenter', errors.length === 0, errors.join(' | '))
  const saved = await until(() => JSON.parse(readFileSync(plannedPath, 'utf8')), (run) => run.status === 'delivered', 10_000, 'the Run saved as delivered')
  let savedBoard = await until(() => JSON.parse(readFileSync(plannedPath, 'utf8')).boards?.[0], Boolean, 10_000, 'the board on the saved Run').catch(() => null)
  record('the board is on the Run once it is saved (every card, open until its time)',
    savedBoard?.cards?.length === 3 && typeof savedBoard?.openUntil === 'number' && typeof savedBoard?.liveEndedAt === 'number',
    JSON.stringify({ status: saved.status, cards: savedBoard?.cards?.length, openUntil: savedBoard?.openUntil }))

  // History.
  const historyPromise = app.waitForEvent('window')
  await editor.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
  const history = await historyPromise
  await history.waitForSelector('.twhistory')
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.setSize(1440, 900) })
  await history.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  // A hidden window has no focus, so the web clipboard refuses it; the page's writes are recorded instead.
  await history.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__copied = value } } })
  })
  const copied = () => history.evaluate(() => window.__copied ?? '')
  const card = history.locator('[data-history-sid="run-oct"]')
  await card.waitFor()
  record('the ledger row says the board is open (R9)', (await text(card.locator('[data-board-badge]'))).startsWith('Board open'), await text(card.locator('[data-board-badge]')))
  await history.locator('.twh-tool', { hasText: 'Re-check live' }).click()
  await until(() => text(card.locator('[data-board-badge]')), (value) => value === 'Board open · 1 late card', 15_000, 'late card on the ledger')
  record('Re-check live pulls the late card in: "Board open · 1 late card" (R9)', true)
  savedBoard = JSON.parse(readFileSync(plannedPath, 'utf8')).boards[0]
  record('the late card is on the Run file', savedBoard.cards.some((c) => c.text === 'Recording of the demo, please'))
  // R9 is drawn with the row closed: select the other Run for the shot.
  await history.locator('[data-history-sid="run-sep"]').click()
  await history.waitForTimeout(300)
  await card.evaluate((node) => node.scrollIntoView({ block: 'center' }))
  await history.screenshot({ path: join(shots, 'R9-late-cards-in-the-ledger-1440x900.png') })

  await card.click()
  const block = card.locator('[data-history-board="poll-board-live"]')
  await block.waitFor()
  const head = await text(block.locator('.rb-h'))
  record('the Run card shows the board: cards, question, still open (R1/R3)', head.includes('Board · 4 cards') && head.includes('What should we keep, change, try?') && head.includes('still open'), head)
  const banner = await text(block.locator('[data-board-banner="open"]'))
  record('"Still open for late cards" with when it closes by itself (R3)', banner.includes('Still open for late cards.') && banner.includes('closes by itself on'), banner)
  record('the late card is marked LATE', (await text(block.locator('.rb-card.late'))).includes('LATE'))
  await block.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await history.screenshot({ path: join(shots, 'R3-board-left-open-1440x900.png') })

  // A fourth phone card, then Refresh from the board (R4).
  const dan = await phone('dan')
  await dan.add('try', 'An online follow-up for those who missed it')
  await block.locator('.rb-bt', { hasText: 'Refresh from the board' }).click()
  await block.locator('[data-board-banner="pulled"]').waitFor()
  const pulled = await text(block.locator('[data-board-banner="pulled"]'))
  record('Refresh from the board pulls the new card in (R4)', pulled.includes('1 late card pulled in just now.'), pulled)
  record('both late cards are marked LATE', await block.locator('.rb-card.late').count() === 2)
  await history.screenshot({ path: join(shots, 'R4-after-refresh-1440x900.png') })

  // Copy as Markdown (R5).
  await block.locator('[data-board-copy]').click()
  await block.locator('[data-board-markdown]').waitFor()
  const clip = await copied()
  record('Copy as Markdown copies the board: question, columns with counts, cards (R5)',
    clip.startsWith('## What should we keep, change, try?') && clip.includes('### Keep (2)') && clip.includes('- More time for hands-on'), clip.slice(0, 200))
  await history.screenshot({ path: join(shots, 'R5-copy-as-markdown-1440x900.png') })
  await history.keyboard.press('Escape')

  // Share a read-only link (R7), read it on a phone (R6), stop it.
  await block.locator('[data-board-share]').click()
  const dialog = history.locator('[data-share-dialog]')
  await dialog.waitFor()
  record('the share dialog: the board ticked, pre-work off, 30 days by default (R7)',
    await dialog.locator('[data-share-board]').isChecked() && !(await dialog.locator('[data-share-prework]').isChecked())
    && (await dialog.locator('[data-share-lifetime="30"]').getAttribute('class'))?.includes('active'))
  await history.screenshot({ path: join(shots, 'R7-share-read-only-link-1440x900.png') })
  await dialog.locator('[data-share-copy]').click()
  await dialog.waitFor({ state: 'detached' })
  const link = await copied()
  record('Copy the link copies the worker\'s read-only link', link.startsWith(`${worker.baseUrl}/results/`), link)
  const shared = await (await fetch(link)).text()
  record('the link shows the board and says it is still open', shared.includes('More time for hands-on') && shared.includes('An online follow-up for those who missed it') && shared.includes('Still open for cards'))
  phoneBrowser = await chromium.launch()
  const phonePage = await phoneBrowser.newPage({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 })
  await phonePage.goto(link)
  record('on a phone the page has no horizontal scroll', await phonePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await phonePage.screenshot({ path: join(shots, 'R6-share-read-only-360x740.png') })
  await block.locator('[data-board-share]').click()
  await dialog.waitFor()
  const again = await until(() => text(dialog.locator('[data-share-url]')), (value) => value !== 'Checking…', 5000, 'the link in the dialog')
  record('the dialog shows the same address again', again === link.replace(/^https?:\/\//, ''), again)
  await dialog.locator('[data-share-stop]').click()
  await until(() => fetch(link).then((r) => r.status), (status) => status === 410, 5000, 'link revoked')
  record('Stop sharing revokes the link (410)', true)
  await history.keyboard.press('Escape')

  // Close it now.
  await block.locator('.rb-bt', { hasText: 'Close it now' }).click()
  await until(() => text(block.locator('.rb-h')), (value) => value.includes('closed'), 15_000, 'board closed on the Run card')
  record('Close it now: the card says closed; no banner', await block.locator('.rb-banner').count() === 0)
  record('the ledger badge goes', await card.locator('[data-board-badge]').count() === 0)
  const tooLate = await phone('eve').then((p) => p.add('keep', 'Too late')).catch(() => ({ status: 'refused' }))
  record('the board takes no card after Close it now', tooLate.status !== 'confirmed', JSON.stringify(tooLate))
  savedBoard = JSON.parse(readFileSync(plannedPath, 'utf8')).boards[0]
  record('the Run records when it closed', typeof savedBoard.closedAt === 'number')
  await history.screenshot({ path: join(shots, 'R1-run-card-board-closed-1440x900.png') })

  // ── Part 2: a seeded Run ──────────────────────────────────────────────────────────────────
  const seededBytes = readFileSync(seededPath, 'utf8')
  const sep = history.locator('[data-history-sid="run-sep"]')
  await sep.click()
  const sepBoard = sep.locator('[data-history-board="poll-board"]')
  await sepBoard.waitFor()
  await history.waitForFunction(() => document.querySelector('[data-history-board="poll-board"] .rb-h .q')?.textContent?.includes('slide'), null, { timeout: 15_000 }).catch(() => {})
  const sepHead = await text(sepBoard.locator('.rb-h'))
  record('the board header counts visible cards and names its slide (R1)', sepHead.includes('Board · 13 cards') && sepHead.includes('slide 3') && sepHead.includes('closed at End live'), sepHead)
  const keep = await text(sepBoard.locator('[data-board-column="keep"] .rb-col-h'))
  record('columns count visible cards only', keep === 'Keep7', keep)
  const firstGroup = await text(sepBoard.locator('[data-board-column="keep"] .rb-card').first())
  record('groups first, numbered, with their counts', firstGroup === '1More time for hands-on×3', firstGroup)
  record('card text is shown as text, never markup', (await text(sepBoard.locator('[data-board-column="try"]'))).includes('<img src=x onerror=')
    && await sepBoard.locator('img').count() === 0 && !(await history.title()).includes('pwned'))
  const hiddenLine = await text(sepBoard.locator('.rb-hidden-line'))
  record('"2 hidden cards, kept here and never on the share link"', hiddenLine.startsWith('2 hidden cards, kept here and never on the share link.'), hiddenLine)
  record('viewing never rewrites the Run', readFileSync(seededPath, 'utf8') === seededBytes)
  const polls = sep.locator('[data-history-polls]')
  record('the poll results show on the Run card (H1)', (await text(polls)).includes('How confident are you with AI at work?') && (await text(polls)).includes('rating · 3 people'), await text(polls.locator('.rp-h').first()))
  await sep.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await history.screenshot({ path: join(shots, 'H1-run-card-polls-1440x900.png') })
  await sepBoard.evaluate((node) => node.scrollIntoView({ block: 'start' }))
  await history.screenshot({ path: join(shots, 'R1-run-card-board-1440x900.png') })
  await sepBoard.locator('.rb-hidden-line button').click()
  await sepBoard.locator('[data-hidden-card="c11"]').waitFor()
  await sepBoard.locator('.rb-hidden').evaluate((node) => node.scrollIntoView({ block: 'center' }))
  await history.screenshot({ path: join(shots, 'R8-hidden-cards-shown-1440x900.png') })
  await sepBoard.locator('[data-hidden-card="c11"] button').click()
  await until(() => JSON.parse(readFileSync(seededPath, 'utf8')).boards[0].cards.find((c) => c.id === 'c11').putBack, Boolean, 5000, 'put back on disk')
  const backOn = await until(async () => [await text(sepBoard.locator('[data-board-column="change"]')), await text(sepBoard.locator('.rb-hidden-line'))],
    ([column, line]) => column.includes('Does anyone know the wifi password?') && line.startsWith('1 hidden card'), 5000, 'the card back on the board').catch((error) => error.message)
  record('Put back: the card is back on the board and stays on the Run (R8)', Array.isArray(backOn), String(backOn))
  await history.screenshot({ path: join(shots, 'R8-after-put-back-1440x900.png') })
  await sepBoard.locator('[data-put-back="c11"] button').click()
  await until(() => JSON.parse(readFileSync(seededPath, 'utf8')).boards[0].cards.find((c) => c.id === 'c11').putBack, (v) => !v, 5000, 'hidden again on disk')
  record('Hide again undoes it', true)
  const refresh = await history.evaluate(() => window.tw.history.boardRefresh('board-probe', 'run-sep'))
  record('a board not left open from this computer cannot be refreshed; said plainly', refresh.ok === false && /not left open/.test(refresh.error), JSON.stringify(refresh))
} catch (error) {
  console.error(error)
  failures += 1
} finally {
  for (const socket of phones) { try { socket.close() } catch {} }
  await phoneBrowser?.close().catch(() => {})
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.destroy())).catch(() => {})
  await app.close().catch(() => {})
  await worker.stop()
  rmSync(tempRoot, { recursive: true, force: true })
}
if (failures) {
  console.error(`Run board gate failed: ${failures} assertion${failures === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log('Run board gate passed')
}
