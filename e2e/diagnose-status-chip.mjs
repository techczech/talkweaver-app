// Work-files-and-sessions ticket 21: the status bar chip, in the real app.
// Hidden-window Electron against an isolated temp userData and a temp vault. One launch holds four
// talks, one per drawn state, so each talk opens its own chip:
//   upcoming  "Saïd workshop · <day> · pre-work 7/18"          (blue)
//   closed    "... · pre-work closed 16/18"                    (amber)
//   post-work "Saïd workshop · post-work 5/18 · closes <day>"  (blue)
//   absent    a Run nobody has been sent: no chip
// Clicking the upcoming chip opens the Tools window on Sessions with that Run selected (never History).
// TW_SHOTS_DIR saves one screenshot per state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })
let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
await ensureFreshBuild(process.cwd())

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const pad = (n) => String(n).padStart(2, '0')
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayOf = (n) => local(new Date(Date.now() + n * 86_400_000)).slice(0, 10)
const hoursAgo = (n) => local(new Date(Date.now() - n * 3_600_000))
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \\d{1,2} [A-Z][a-z]{2}'
const PUB = new Date(Date.now() - 86_400_000).toISOString()
const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens, closes, timeZone: ZONE, ...extra })
const post = (closes, extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes, timeZone: ZONE, ...extra })
const base = (slug, id, title, extra) => ({ id, talkSlug: slug, talkTitle: title, kind: 'delivery', slideSet: { kind: 'full' }, startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], eventTitle: 'Saïd workshop', timeZone: ZONE, expectedPeople: 18, ...extra })

const TALKS = [['t-upcoming', 'Upcoming talk'], ['t-closed', 'Closed talk'], ['t-post', 'Post talk'], ['t-absent', 'Absent talk']]
const RUNS = [
  base('t-upcoming', 'said', 'Upcoming talk', { status: 'planned', plannedDate: dayOf(7), startTime: '14:00', handoutUrl: 'https://handouts.fyi/dl/said', prework: { entries: [], people: 7 },
    work: { pre: pre(`${dayOf(-1)}T09:00`, `${dayOf(7)}T13:00`, { publishedAt: PUB }) } }),
  base('t-closed', 'closed', 'Closed talk', { status: 'planned', plannedDate: dayOf(0), startTime: '23:30', handoutUrl: 'https://handouts.fyi/dl/closed', prework: { entries: [], people: 16 },
    work: { pre: pre(`${dayOf(-3)}T09:00`, hoursAgo(1), { publishedAt: PUB }) } }),
  base('t-post', 'post', 'Post talk', { status: 'delivered', plannedDate: dayOf(0), startTime: '09:00', handoutUrl: 'https://handouts.fyi/dl/post', prework: { entries: [], people: 16 }, postwork: { entries: [], people: 5 },
    startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), endedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    work: { pre: pre(`${dayOf(-3)}T09:00`, hoursAgo(3), { publishedAt: PUB }), post: post(`${dayOf(14)}T17:00`, { publishedAt: PUB }) } }),
  base('t-absent', 'absent', 'Absent talk', { status: 'planned', plannedDate: dayOf(7), startTime: '14:00',
    work: { pre: pre(`${dayOf(-1)}T09:00`, `${dayOf(7)}T13:00`) } })
]
const WORK_FILE = ['---', 'id: research-teams-intake', 'title: Research teams intake', 'revision: 1', '---', '', '### Watch', '{id=watch}{video}', ''].join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-status-chip-e2e-'))
const vault = join(root, 'vault'); const ud = join(root, 'userData')
mkdirSync(ud, { recursive: true })
for (const [slug, title] of TALKS) {
  mkdirSync(join(vault, slug), { recursive: true })
  writeFileSync(join(vault, slug, `${slug}-outline.md`), `---\ntitle: ${title}\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Opening\n{id=open}\n\nHello.\n`)
}
mkdirSync(join(vault, 'Work files'), { recursive: true })
writeFileSync(join(vault, 'Work files', 'research-teams-intake.md'), WORK_FILE)
for (const run of RUNS) {
  mkdirSync(join(vault, '_PRESENTATIONS', run.talkSlug), { recursive: true })
  writeFileSync(join(vault, '_PRESENTATIONS', run.talkSlug, `${run.id}.json`), JSON.stringify(run, null, 2))
}
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try { app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }) }
  catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
}
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  const chip = page.locator('[data-testid="status-run"]')
  const shot = async (name) => { if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {}) }
  const openTalk = async (title) => {
    await page.getByText(title, { exact: true }).first().click()
    await page.waitForSelector('.workspace')
    await page.waitForTimeout(1200)
  }

  await openTalk('Absent talk')
  rec('absent: a Run nobody has been sent shows no chip', await chip.count() === 0)
  rec('absent: the old nudge and Run chips are gone', await page.locator('[data-testid="status-run-nudge"], [data-testid="status-prework"]').count() === 0)
  await shot('6-absent')

  await openTalk('Closed talk')
  await chip.waitFor({ timeout: 8000 }).catch(() => {})
  const closedText = (await chip.innerText().catch(() => '')).trim()
  rec('pre-work closed: text and amber tone', new RegExp(`^Saïd workshop · ${DAY} · pre-work closed 16/18$`).test(closedText) && await chip.getAttribute('data-tone') === 'amber', closedText)
  await shot('6-pre-work-closed')

  await openTalk('Post talk')
  await chip.waitFor({ timeout: 8000 }).catch(() => {})
  const postText = (await chip.innerText().catch(() => '')).trim()
  rec('post-work open: text and blue tone', new RegExp(`^Saïd workshop · post-work 5/18 · closes ${DAY}$`).test(postText) && await chip.getAttribute('data-tone') === 'blue', postText)
  await shot('6-post-work-open')

  await openTalk('Upcoming talk')
  await chip.waitFor({ timeout: 8000 }).catch(() => {})
  const upText = (await chip.innerText().catch(() => '')).trim()
  rec('upcoming: text and blue tone', new RegExp(`^Saïd workshop · ${DAY} · pre-work 7/18$`).test(upText) && await chip.getAttribute('data-tone') === 'blue', upText)
  const box = await chip.boundingBox()
  rec('the chip sits at the right end of the status bar', !!box && box.x + box.width > 1280 - 40 && box.y > 760, JSON.stringify(box))
  await shot('6-upcoming')

  const pending = app.waitForEvent('window')
  await chip.click()
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await tools.waitForSelector('[data-sessions-detail="t-upcoming/said"]', { timeout: 10_000 }).catch(() => {})
  rec('clicking the chip opens Sessions on that Run', await tools.locator('[data-tools-view="sessions"]').count() === 1 && await tools.locator('[data-sessions-detail="t-upcoming/said"]').count() === 1)
  rec('the Run is selected in the list', await tools.locator('[data-sessions-row="t-upcoming/said"][aria-current="true"]').count() === 1)
  rec('it is not History', await tools.locator('.twhistory, [data-prework-page]').count() === 0)
} finally { await app.close().catch(() => {}) }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
