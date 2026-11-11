// Consistency batch 3, house rule R5 (D2): one Runs view in the Tools window, History merged into it.
// Hidden-window Electron against an isolated temp userData and a temp vault holding three Runs of one talk:
//   a planned Run (+5 days), a delivered Run with audio, polls and a feedback board, and a delivered Run with no audio.
//   (a) a planned Run shows under Upcoming; the delivered Runs show under Past;
//   (b) the Past filter keeps the delivered Runs; selecting the delivered Run with audio shows its ledger
//       (recording, handout, polls and the board) in the detail pane, beside the Run checklist;
//   (c) the Recorded filter keeps the Run with audio only;
//   (d) Studio's left list ("Recorded Runs") shows the same Runs as the Recorded filter, and "Open in Studio" lands on that Run;
//   (e) the old names still open the one view (tools.open('history'), tools.open('sessions')), and no list is called Sessions.
// Run: node e2e/diagnose-runs-view.mjs   (TW_SHOTS_DIR=<dir> saves a screenshot of each state)
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })
let failures = 0
const rec = (name, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
await ensureFreshBuild(process.cwd())

const DAY = 86_400_000
const dayOf = (n) => { const d = new Date(Date.now() + n * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const slug = 'run-view-talk'
const talkTitle = 'Run view talk'
const base = { talkSlug: slug, talkTitle, kind: 'delivery', slideSet: { kind: 'full' }, pathwayId: null, transcript: null }
const started = new Date(Date.now() - 2 * DAY); started.setHours(14, 0, 0, 0)
const given = {
  ...base, id: 'rv-given', status: 'delivered', eventTitle: 'Given workshop', audience: 'Staff', context: 'Morning',
  startedAt: started.toISOString(), endedAt: new Date(started.getTime() + 40 * 60_000).toISOString(), recordingMs: 40 * 60_000, wallClockMs: 40 * 60_000, timerTargetMin: 45,
  audio: { r2Key: `presentations/${slug}/rv-given/audio.webm`, bytes: 12, uploaded: false },
  slideTimeIndex: [{ event: 'enter', slideId: 'opening', tMs: 0 }],
  polls: [{ id: 'poll-rating', slideId: 'opening', type: 'rating', question: 'How confident are you?', visibility: 'live', options: [{ optionId: 'w', label: 'Writing' }], labels: [{ optionId: 'n', label: 'Not yet' }, { optionId: 'v', label: 'Very' }] }],
  pollResponses: [{ responseId: 's:1', pollId: 'poll-rating', choice: { w: 'v' }, tMs: 1000, slideId: 'opening' }],
  boards: [{ id: 'poll-board', slideId: 'opening', question: 'Keep, change, try?', sessionId: 's1', liveEndedAt: started.getTime() + 39 * 60_000,
    columns: [{ id: 'keep', label: 'Keep' }], cards: [{ id: 'c1', column: 'keep', text: 'More hands-on', acceptedAt: started.getTime() + 60_000 }], groups: [] }]
}
const silent = { ...base, id: 'rv-silent', status: 'delivered', eventTitle: 'Silent seminar', startedAt: new Date(Date.now() - 5 * DAY).toISOString(), endedAt: new Date(Date.now() - 5 * DAY + 3_600_000).toISOString(), recordingMs: 0, wallClockMs: 30 * 60_000, timerTargetMin: 30, audio: null, context: null, slideTimeIndex: [], polls: [], pollResponses: [] }
const planned = { ...base, id: 'rv-planned', status: 'planned', eventTitle: 'Planned workshop', plannedDate: dayOf(5), startTime: '14:00', startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, audio: null, context: null, slideTimeIndex: [] }

const root = mkdtempSync(join(tmpdir(), 'tw-runs-view-e2e-'))
const vault = join(root, 'vault'); const ud = join(root, 'userData')
mkdirSync(join(vault, slug), { recursive: true }); mkdirSync(join(ud, 'recordings'), { recursive: true })
writeFileSync(join(vault, slug, `${slug}-outline.md`), ['---', `title: ${talkTitle}`, '---', '', '## Talk', '', '### Opening', '{id=opening}', '', 'Welcome.'].join('\n'))
for (const run of [planned, given, silent]) {
  mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
  writeFileSync(join(vault, '_PRESENTATIONS', slug, `${run.id}.json`), JSON.stringify(run, null, 2))
}
writeFileSync(join(ud, 'recordings', 'rv-given.webm'), 'mock-webm-data')
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, recordingDiscardMs: 800 }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }, timeout: 60_000 })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  const pending = app.waitForEvent('window')
  await page.evaluate(() => window.tw.tools.open('runs'))
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await tools.waitForSelector('[data-tools-view="runs"] [data-sessions-row]', { timeout: 10_000 })
  const shot = async (name) => { if (shotsDir) await tools.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {}) }
  const rowsOf = (group) => tools.evaluate((id) => [...(document.querySelector(`[data-sessions-group="${id}"]`)?.parentElement.querySelectorAll('.tw-sess-row .nm') ?? [])].map((n) => n.textContent), group)

  // (a) the planned Run is Upcoming; the delivered Runs are Past
  rec('a planned Run shows under Upcoming', JSON.stringify(await rowsOf('upcoming')) === JSON.stringify(['Planned workshop']), JSON.stringify(await rowsOf('upcoming')))
  rec('delivered Runs show under Past', JSON.stringify(await rowsOf('past')) === JSON.stringify(['Given workshop', 'Silent seminar']), JSON.stringify(await rowsOf('past')))
  await shot('runs-upcoming-and-past')

  // (b) Past filter, then the delivered Run's detail: ledger + polls + board
  await tools.locator('[data-sessions-filter="past"]').click()
  await tools.waitForTimeout(200)
  rec('the Past filter keeps the delivered Runs and drops the plan', await tools.locator('[data-sessions-row]').count() === 2 && await tools.locator('[data-sessions-row$="/rv-planned"]').count() === 0)
  await tools.locator('[data-sessions-row$="/rv-given"]').click()
  await tools.waitForSelector('[data-sessions-detail$="/rv-given"] [data-run-ledger]', { timeout: 8000 })
  const detail = tools.locator('[data-sessions-detail$="/rv-given"]')
  rec('a delivered Run\'s detail carries its recording, handout and checklist', await detail.locator('[data-run-recording="yes"]').count() === 1 && await detail.locator('[data-run-handout-status]').count() === 1 && await detail.locator('[data-run-checklist]').count() === 1)
  rec('the polls are in the detail', await detail.locator('[data-history-polls]').count() === 1 && (await detail.locator('[data-history-polls]').innerText()).includes('How confident are you?'))
  rec('the feedback board is in the detail', await detail.locator('[data-history-board="poll-board"]').count() === 1 && (await detail.locator('[data-history-board="poll-board"]').innerText()).includes('More hands-on'))
  await shot('runs-past-detail')

  // (c) Recorded filter
  await tools.locator('[data-sessions-filter="past"]').click()
  await tools.locator('[data-sessions-filter="recorded"]').click()
  await tools.waitForTimeout(200)
  const recorded = await tools.evaluate(() => [...document.querySelectorAll('[data-sessions-row]')].map((n) => n.getAttribute('data-sessions-row')))
  rec('the Recorded filter shows the Run with audio only', JSON.stringify(recorded) === JSON.stringify([`${slug}/rv-given`]), JSON.stringify(recorded))
  await shot('runs-recorded')

  // (d) Studio's list is the same Runs
  await tools.locator('[data-tools-rail="studio"]').click()
  await tools.waitForSelector('.twstudio', { timeout: 8000 })
  await tools.waitForSelector('.tws-scard', { timeout: 8000 })
  const studio = await tools.evaluate(() => [...document.querySelectorAll('.tws-scard')].map((n) => n.getAttribute('data-sid')))
  rec('Studio\'s list shows the Runs with audio, the same as the Recorded filter', JSON.stringify(studio) === JSON.stringify(['rv-given']), JSON.stringify(studio))
  rec('Studio\'s list is headed Recorded Runs, never Sessions', await tools.getByRole('heading', { name: 'Recorded Runs' }).count() === 1 && await tools.getByRole('heading', { name: 'Sessions' }).count() === 0)
  await shot('studio-recorded-runs')
  await tools.locator('[data-tools-rail="runs"]').click()
  await tools.waitForSelector('[data-tools-view="runs"] [data-sessions-row]')
  await tools.locator('[data-sessions-row$="/rv-given"]').click()
  await tools.locator('[data-run-open-studio]').click()
  await tools.waitForSelector('.tws-scard.active', { timeout: 8000 })
  rec('Open in Studio from the ledger lands on that Run', (await tools.locator('.tws-scard.active').getAttribute('data-sid')) === 'rv-given')

  // ⌘1 goes back to Studio from the Runs view, through the Tools window's shared key handling (S4).
  await tools.locator('[data-tools-rail="runs"]').click()
  await tools.waitForSelector('[data-tools-view="runs"]')
  await tools.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await tools.keyboard.press('Meta+1')
  await tools.waitForSelector('.twstudio', { timeout: 5000 }).catch(() => {})
  rec('⌘1 from the Runs view returns to Studio', await tools.locator('.twstudio').count() === 1)
  await tools.keyboard.press('Meta+2')
  await tools.waitForSelector('[data-tools-view="runs"]', { timeout: 5000 }).catch(() => {})
  rec('⌘2 shows Runs from Studio', await tools.locator('[data-tools-view="runs"]').count() === 1)

  // (e) the old names open the one view; the rail has no Sessions or History
  const names = (await tools.locator('[data-tools-rail]').allTextContents()).map((t) => t.trim())
  rec('the rail lists Runs and neither History nor Sessions', names.includes('Runs') && !names.includes('History') && !names.includes('Sessions'), names.join(' | '))
  for (const old of ['history', 'sessions']) {
    const opened = await page.evaluate((v) => window.tw.tools.open(v), old)
    await tools.waitForSelector('[data-tools-view="runs"]', { timeout: 5000 }).catch(() => {})
    rec(`tools.open('${old}') opens the Runs view`, opened.success && await tools.locator('[data-tools-view="runs"]').count() === 1)
  }
} finally { await app.close().catch(() => {}) }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
