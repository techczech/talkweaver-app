// Work-files-and-sessions ticket 09: the Sessions list, in the real app.
// Hidden-window Electron against an isolated temp userData and a temp vault seeded with four Runs
// (the drawn examples, dated from today): Saïd workshop +7 days, Keble +14, Medical Sciences +21, ITLC lunchtime -5.
//   (a) the list: Upcoming (Saïd, Keble, Medical Sciences) then Past (ITLC), with pills and "pre-work n/N";
//   (b) each filter shows exactly the drawn rows; a second click on the chip clears it;
//   (c) selecting a row selects the Run (detail head, aria-current, data-run);
//   (d) a vault with post-work open: the delivered Run sits under Past with "post-work 5/18";
//   (e) a vault with no Runs shows the empty state.
// TW_SHOTS_DIR saves one screenshot per drawn state.
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
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayOf = (n) => { const d = new Date(Date.now() + n * 86_400_000); return { iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, label: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}` } }
const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens: `${dayOf(opens).iso}T09:00`, closes: `${dayOf(closes).iso}T10:00`, timeZone: ZONE, ...extra })
const base = (slug, id, title, event, extra) => ({ id, talkSlug: slug, talkTitle: title, kind: 'delivery', slideSet: { kind: 'full' }, startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], eventTitle: event, timeZone: ZONE, ...extra })
const PUB = new Date(Date.now() - 86_400_000).toISOString()
const planned = (slug, id, title, event, day, extra) => base(slug, id, title, event, { status: 'planned', plannedDate: dayOf(day).iso, startTime: '14:00', ...extra })

function seed(root, runs) {
  const vault = join(root, 'vault'); const ud = join(root, 'userData')
  mkdirSync(ud, { recursive: true })
  for (const run of runs) {
    mkdirSync(join(vault, '_PRESENTATIONS', run.talkSlug), { recursive: true })
    writeFileSync(join(vault, '_PRESENTATIONS', run.talkSlug, `${run.id}.json`), JSON.stringify(run, null, 2))
  }
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
  return ud
}

async function launch(runs) {
  const root = mkdtempSync(join(tmpdir(), 'tw-sessions-e2e-'))
  const ud = seed(root, runs)
  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }) }
    catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
  }
}

async function openSessions(app) {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  const pending = app.waitForEvent('window')
  await page.evaluate(() => window.tw.tools.open('sessions'))
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await tools.waitForSelector('[data-tools-view="sessions"]', { timeout: 10_000 })
  return tools
}
const shot = async (tools, name) => { if (shotsDir) await tools.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {}) }
// "Upcoming: a, b | Past: c" read from the page (names, in order).
const shown = (tools) => tools.evaluate(() => [...document.querySelectorAll('[data-sessions-group]')].map((g) => {
  const rows = [...g.parentElement.querySelectorAll('.tw-sess-row .nm')].map((n) => n.textContent)
  return `${g.textContent}: ${rows.join(', ')}`
}).join(' | '))
const rowText = (tools, key) => tools.locator(`[data-sessions-row="${key}"]`).innerText().then((t) => t.replace(/\s+/g, ' ').trim())
const waitRows = (tools) => tools.waitForSelector('[data-sessions-row]', { timeout: 10_000 })

const FOUR = [
  planned('ai-research', 'said', 'AI for research teams', 'Saïd workshop', 7, {
    expectedPeople: 18, handoutUrl: 'https://handouts.fyi/dl/said', prework: { entries: [], people: 7 },
    work: { pre: pre(-1, 7, { publishedAt: PUB }), post: { fileId: 'session-feedback', opens: 'session-end', closes: `${dayOf(21).iso}T17:00`, timeZone: ZONE, publishedAt: PUB } }
  }),
  planned('ai-teaching', 'keble', 'Generative AI in teaching', 'Keble', 14, {
    expectedPeople: 40, handoutUrl: 'https://handouts.fyi/dl/keble', prework: { entries: [], people: 31 }, work: { pre: pre(-2, 14, { publishedAt: PUB }) }
  }),
  planned('ai-research', 'med', 'AI for research teams', 'Medical Sciences', 21, { expectedPeople: 24, work: { pre: pre(7, 21) } }),
  base('ai-teaching', 'itlc', 'Generative AI in teaching', 'ITLC lunchtime', {
    status: 'delivered', plannedDate: dayOf(-5).iso, startTime: '12:30', expectedPeople: 15, handoutUrl: 'https://handouts.fyi/dl/itlc',
    startedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), endedAt: new Date(Date.now() - 5 * 86_400_000 + 3_600_000).toISOString(),
    prework: { entries: [], people: 12 }, work: { pre: pre(-13, -5, { publishedAt: PUB }) }
  })
]

// ---- (a) (b) (c)
{
  const app = await launch(FOUR)
  try {
    const tools = await openSessions(app)
    await waitRows(tools)
    const UP = 'Upcoming: Saïd workshop, Keble, Medical Sciences'
    rec('list: Upcoming then Past', await shown(tools) === `${UP} | Past: ITLC lunchtime`, await shown(tools))
    rec('Saïd row text', (await rowText(tools, 'ai-research/said')) === `Saïd workshop Published ${dayOf(7).label} · 14:00 pre-work 7/18 AI for research teams`, await rowText(tools, 'ai-research/said'))
    rec('Keble row text', (await rowText(tools, 'ai-teaching/keble')).includes('pre-work 31/40'))
    rec('Medical Sciences row: not published, pre-work not open', (await rowText(tools, 'ai-research/med')).includes('Not published') && (await rowText(tools, 'ai-research/med')).includes('pre-work not open'))
    rec('ITLC row: delivered, pre-work closed 12/15', (await rowText(tools, 'ai-teaching/itlc')).includes('Delivered') && (await rowText(tools, 'ai-teaching/itlc')).includes('pre-work closed 12/15'))
    rec('four filters, none on', await tools.locator('[data-sessions-filter]').count() === 4 && await tools.locator('[data-sessions-filter].on').count() === 0)
    rec('no row selected, detail says so', await tools.locator('.tw-sess-row.on').count() === 0 && (await tools.locator('.tw-tools-none').innerText()).includes('No run selected'))
    await shot(tools, 'list')

    const expectFilter = async (id, shotName, want) => {
      await tools.locator(`[data-sessions-filter="${id}"]`).click()
      await tools.waitForTimeout(150)
      const got = await shown(tools)
      rec(`filter ${id}`, got === want, got)
      rec(`filter ${id} chip is on`, await tools.locator(`[data-sessions-filter="${id}"].on`).count() === 1)
      await shot(tools, shotName)
    }
    await expectFilter('upcoming', 'filter-upcoming', UP)
    await expectFilter('live', 'filter-live-now', '')
    rec('Live now with nothing live says so', (await tools.locator('.tw-sess-none').innerText()).includes('No runs match'))
    await expectFilter('past', 'filter-past', 'Past: ITLC lunchtime')
    await expectFilter('published', 'filter-published-only', 'Upcoming: Saïd workshop, Keble | Past: ITLC lunchtime')
    await tools.locator('[data-sessions-filter="published"]').click()
    await tools.waitForTimeout(150)
    rec('clicking the chip again clears it', await shown(tools) === `${UP} | Past: ITLC lunchtime`)

    await tools.locator('[data-sessions-row="ai-research/said"]').click()
    await tools.waitForSelector('[data-sessions-detail="ai-research/said"]', { timeout: 3000 }).catch(() => {})
    rec('selecting a row selects the Run', await tools.locator('[data-tools-view="sessions"][data-run="ai-research/said"]').count() === 1
      && await tools.locator('[data-sessions-row="ai-research/said"][aria-current="true"]').count() === 1)
    rec('detail names the Run and its talk', (await tools.locator('[data-sessions-detail] h1').innerText()) === 'Saïd workshop' && (await tools.locator('[data-sessions-detail] .sub').innerText()).includes('AI for research teams'))
    await shot(tools, 'row-selected')
    // a Run asked for by id from outside (History, the status bar) is the selected one
    const asked = await (await app.firstWindow()).evaluate(() => window.tw.tools.openRun('ai-teaching', 'itlc'))
    await tools.waitForSelector('[data-sessions-row="ai-teaching/itlc"][aria-current="true"]', { timeout: 5000 }).catch(() => {})
    rec('asking for a Run selects its row', asked.success && await tools.locator('[data-sessions-row="ai-teaching/itlc"][aria-current="true"]').count() === 1)
  } finally { await app.close().catch(() => {}) }
}

// ---- (d) post-work open
{
  const delivered = { ...planned('ai-research', 'said', 'AI for research teams', 'Saïd workshop', -1, { expectedPeople: 18, handoutUrl: 'https://handouts.fyi/dl/said' }),
    status: 'delivered', startedAt: new Date(Date.now() - 86_400_000).toISOString(), endedAt: new Date(Date.now() - 86_400_000 + 3_600_000).toISOString(),
    prework: { entries: [], people: 16 }, postwork: { entries: [], people: 5 },
    work: { pre: pre(-9, -1, { publishedAt: PUB }), post: { fileId: 'session-feedback', opens: 'session-end', closes: `${dayOf(13).iso}T17:00`, timeZone: ZONE, publishedAt: PUB } } }
  const app = await launch([delivered, FOUR[1], FOUR[2]])
  try {
    const tools = await openSessions(app)
    await waitRows(tools)
    const got = await shown(tools)
    rec('post-work open: delivered Run moves under Past', got === 'Upcoming: Keble, Medical Sciences | Past: Saïd workshop', got)
    const text = await rowText(tools, 'ai-research/said')
    rec('row reads "post-work 5/18"', text.includes('post-work 5/18') && text.includes('Delivered'), text)
    await shot(tools, 'post-work-open')
  } finally { await app.close().catch(() => {}) }
}

// ---- (e) empty
{
  const app = await launch([])
  try {
    const tools = await openSessions(app)
    await tools.waitForSelector('.tw-tools-empty', { timeout: 10_000 })
    const body = await tools.locator('[data-tools-view="sessions"]').innerText()
    rec('empty state', body.includes('No runs yet') && body.includes('No run selected') && await tools.locator('[data-sessions-filter]').count() === 0, body.replace(/\s+/g, ' '))
    await shot(tools, 'empty')
  } finally { await app.close().catch(() => {}) }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
