// Work-files-and-sessions ticket 10: a Run's page in Sessions, in the real app.
// Hidden-window Electron against an isolated temp userData and a temp vault holding the drawn example
// Runs (dated from today) and their talks.
//   (a) select a row: the header, the pill, the checklist with its "N of M" and each drawn step state
//       (Medical Sciences 2 of 8, Saïd 3 of 8, Keble 3 of 6, ITLC 6 of 6);
//   (b) Edit plan opens the plan sheet for that Run; Cancel closes it;
//   (c) Go live starts the presenter bound to the Run, before its date; Open results is disabled before
//       the session with "Available after the session"; Publish is shown and not wired yet;
//   (d) Open file: the attached file opens, a missing one says so on the page;
//   (e) Mark as delivered writes the Run (delivered on disk), the page and the list follow;
//   (f) pre-work closed, post-work open and unpublished: the checklist matches the drawn state.
// TW_SHOTS_DIR saves one screenshot per drawn state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens, closes, timeZone: ZONE, ...extra })
const post = (closes, extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes, timeZone: ZONE, ...extra })
const base = (slug, id, title, event, extra) => ({ id, talkSlug: slug, talkTitle: title, kind: 'delivery', slideSet: { kind: 'full' }, startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], eventTitle: event, timeZone: ZONE, ...extra })
const PUB = new Date(Date.now() - 86_400_000).toISOString()
const planned = (slug, id, title, event, day, extra) => base(slug, id, title, event, { status: 'planned', plannedDate: dayOf(day), startTime: '14:00', ...extra })
const T1 = 'AI for research teams'
const T2 = 'Generative AI in teaching'
const WORK_FILE = ['---', 'id: research-teams-intake', 'title: Research teams intake', 'revision: 1', '---', '', '### Watch', '{id=watch}{video}', '', '### Try', '{id=try}{task}', ''].join('\n')

function seed(runs) {
  const root = mkdtempSync(join(tmpdir(), 'tw-run-page-e2e-'))
  const vault = join(root, 'vault'); const ud = join(root, 'userData')
  mkdirSync(ud, { recursive: true })
  for (const [slug, title] of [['ai-research', T1], ['ai-teaching', T2]]) {
    mkdirSync(join(vault, slug), { recursive: true })
    writeFileSync(join(vault, slug, `${slug}-outline.md`), `---\ntitle: ${title}\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Opening\n{id=open}\n\nHello.\n`)
  }
  mkdirSync(join(vault, 'Work files'), { recursive: true })
  writeFileSync(join(vault, 'Work files', 'research-teams-intake.md'), WORK_FILE)
  for (const run of runs) {
    mkdirSync(join(vault, '_PRESENTATIONS', run.talkSlug), { recursive: true })
    writeFileSync(join(vault, '_PRESENTATIONS', run.talkSlug, `${run.id}.json`), JSON.stringify(run, null, 2))
  }
  writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
  return { ud, vault }
}

async function launch(runs) {
  const { ud, vault } = seed(runs)
  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return { app: await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }), vault } }
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
  await tools.waitForSelector('[data-sessions-row]', { timeout: 10_000 })
  return { tools, main: page }
}
const shot = async (tools, name) => { if (shotsDir) await tools.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {}) }
const select = async (tools, key) => {
  await tools.locator(`[data-sessions-row="${key}"]`).click()
  await tools.waitForSelector(`[data-sessions-detail="${key}"]`, { timeout: 5000 })
  await tools.waitForTimeout(250)
}
const counter = (tools) => tools.locator('[data-run-counter]').innerText()
const steps = (tools) => tools.evaluate(() => [...document.querySelectorAll('[data-run-step]')].map((el) => `${el.getAttribute('data-run-step')}:${el.getAttribute('data-state')}`).join(' '))
const actionsOf = (tools, step) => tools.evaluate((id) => [...document.querySelectorAll(`[data-run-step="${id}"] [data-run-action]`)].map((b) => `${b.getAttribute('data-run-action')}${b.disabled ? '!' : ''}`).join(' '), step)

const FOUR = [
  planned('ai-research', 'said', T1, 'Saïd workshop', 7, {
    expectedPeople: 18, handoutUrl: 'https://handouts.fyi/dl/said-21-oct', prework: { entries: [], people: 7 },
    work: { pre: pre(`${dayOf(-1)}T09:00`, `${dayOf(7)}T10:00`, { publishedAt: PUB }), post: post(`${dayOf(21)}T17:00`, { publishedAt: PUB }) }
  }),
  planned('ai-teaching', 'keble', T2, 'Keble', 14, {
    expectedPeople: 40, handoutUrl: 'https://handouts.fyi/dl/keble-28-oct', prework: { entries: [], people: 31 }, work: { pre: pre(`${dayOf(-2)}T09:00`, `${dayOf(14)}T10:00`, { publishedAt: PUB }) }
  }),
  planned('ai-research', 'med', T1, 'Medical Sciences', 21, { expectedPeople: 24, work: { pre: pre(`${dayOf(7)}T09:00`, `${dayOf(21)}T09:00`), post: post(`${dayOf(35)}T17:00`) } }),
  base('ai-teaching', 'itlc', T2, 'ITLC lunchtime', {
    status: 'delivered', plannedDate: dayOf(-5), startTime: '12:30', expectedPeople: 15, handoutUrl: 'https://handouts.fyi/dl/itlc-9-oct',
    startedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), endedAt: new Date(Date.now() - 5 * 86_400_000 + 3_600_000).toISOString(),
    prework: { entries: [], people: 12 }, work: { pre: pre(`${dayOf(-13)}T09:00`, `${dayOf(-5)}T10:00`, { publishedAt: PUB }) }
  })
]

// ---- (a) (b) (c) (d) (e)
{
  const { app, vault } = await launch(FOUR)
  try {
    const { tools, main } = await openSessions(app)
    rec('no run selected: no Run page', await tools.locator('[data-run-checklist]').count() === 0)

    await select(tools, 'ai-research/med')
    rec('Medical Sciences: 2 of 8, not published', (await counter(tools)) === '2 of 8' && (await tools.locator('[data-run-pill]').innerText()) === 'Not published')
    rec('Medical Sciences steps', (await steps(tools)) === 'planned:done pre-ready:done published:current pre-closes:todo delivered:todo post-open:todo post-closes:todo results:todo', await steps(tools))
    rec('Medical Sciences: Publish for this run and Preview page are wired', (await actionsOf(tools, 'published')) === 'publish preview-page', await actionsOf(tools, 'published'))
    rec('Delivered step offers Go live and Mark as delivered', (await actionsOf(tools, 'delivered')) === 'go-live mark-delivered', await actionsOf(tools, 'delivered'))
    rec('Open results is disabled before the session, with its reason', (await actionsOf(tools, 'results')) === 'open-results!' && await tools.locator('[data-run-action="open-results"][title="Available after the session"]').count() === 1)
    rec('sections: pre-work answers, post-work answers and extras', await tools.locator('[data-run-section]').evaluateAll((els) => els.map((el) => el.getAttribute('data-run-section')).join(',')) === 'pre-answers,post-answers,extras')
    await shot(tools, '3-not-published')

    await select(tools, 'ai-research/said')
    rec('Saïd: 3 of 8, published, pre-work closes is current', (await counter(tools)) === '3 of 8' && (await tools.locator('[data-run-pill]').innerText()) === 'Published'
      && (await steps(tools)) === 'planned:done pre-ready:done published:done pre-closes:current delivered:todo post-open:todo post-closes:todo results:todo', await steps(tools))
    rec('Saïd: handout, pre-work and post-work links', await tools.locator('[data-run-link]').count() === 3)
    await tools.waitForSelector('[data-run-qr] img', { timeout: 5000 }).catch(() => {})
    rec('Saïd: the published block has its QR code (pre-work open: the pre-work link)', await tools.locator('[data-run-qr="pre-work"] img').count() === 1)
    rec('Saïd: Copy invitation text and Unpublish', await tools.locator('[data-run-published-block] [data-run-action="copy-invitation"]').count() === 1 && await tools.locator('[data-run-published-block] [data-run-action="unpublish"]').count() === 1)
    rec('Saïd: step text', (await tools.locator('[data-run-step="pre-ready"] .ss').innerText()) === '2 steps · file “Research teams intake”', await tools.locator('[data-run-step="pre-ready"] .ss').innerText())
    await shot(tools, '3-published')

    // (b) Edit plan
    await tools.locator('[data-run-action="edit-plan"]').click()
    await tools.waitForSelector('[data-testid="plan-run-sheet"]', { timeout: 5000 }).catch(() => {})
    rec('Edit plan opens the plan sheet', await tools.locator('[data-testid="plan-run-sheet"]').count() === 1)
    rec('the sheet is for this Run', ((await tools.locator('[data-testid="plan-run-sheet"] input').first().inputValue().catch(() => '')) === 'Saïd workshop'))
    await shot(tools, 'edit-plan-sheet')
    await tools.locator('[data-testid="plan-run-cancel"]').click()
    rec('Cancel closes the sheet', await tools.locator('[data-testid="plan-run-sheet"]').count() === 0)
    await tools.locator('[data-run-step="pre-closes"] [data-run-action="change-pre-time"]').click()
    await tools.waitForSelector('[data-testid="plan-run-sheet"]', { timeout: 5000 }).catch(() => {})
    rec('Change time opens the same sheet', await tools.locator('[data-testid="plan-run-sheet"]').count() === 1)
    await tools.keyboard.press('Escape')

    // (c) Go live: the presenter is asked for, bound to this Run, before the session date
    await app.evaluate(({ ipcMain }) => {
      globalThis.__presented = []
      ipcMain.removeHandler('talk:present')
      ipcMain.handle('talk:present', (_e, outlinePath, _content, mode, startSlideId, pathwayId, plannedRunId) => { globalThis.__presented.push({ outlinePath, mode, startSlideId, pathwayId, plannedRunId }); return { success: true } })
    })
    await tools.locator('[data-run-action="go-live"]').click()
    await tools.waitForTimeout(600)
    const presented = await app.evaluate(() => globalThis.__presented)
    rec('Go live presents the talk, bound to the Run, before its date', presented.length === 1 && presented[0].plannedRunId === 'said' && presented[0].mode === 'presenter' && presented[0].outlinePath.endsWith('ai-research-outline.md'), JSON.stringify(presented))

    // (d) Open file
    await tools.locator('[data-run-action="open-pre-file"]').click()
    await tools.waitForTimeout(300)
    rec('Open file: the attached file opens without a notice', await tools.locator('[data-run-notice]').count() === 0)
    await tools.locator('[data-run-action="open-post-file"]').click()
    await tools.waitForSelector('[data-run-notice]', { timeout: 3000 }).catch(() => {})
    rec('Open file: a file that is not there says so', (await tools.locator('[data-run-notice]').innerText().catch(() => '')).includes('session-feedback'), await tools.locator('[data-run-notice]').innerText().catch(() => ''))
    rec('Open file: post-work step reports the missing file', (await tools.locator('[data-run-step="post-open"] .ss').innerText()).includes('file session-feedback not found'))

    await select(tools, 'ai-teaching/keble')
    rec('Keble: 3 of 6', (await counter(tools)) === '3 of 6' && await tools.locator('[data-run-notice]').count() === 0, await counter(tools))
    await shot(tools, '7-row-selected')

    await select(tools, 'ai-teaching/itlc')
    rec('ITLC: 6 of 6, delivered, no Mark as delivered', (await counter(tools)) === '6 of 6' && (await tools.locator('[data-run-pill]').innerText()) === 'Delivered' && (await actionsOf(tools, 'delivered')) === '', await actionsOf(tools, 'delivered'))
    rec('ITLC: Open results is enabled', (await actionsOf(tools, 'results')) === 'open-results')
    await shot(tools, '3-delivered')

    // (e) Mark as delivered
    await select(tools, 'ai-research/med')
    await tools.locator('[data-run-action="mark-delivered"]').click()
    await tools.waitForSelector('[data-run-pill]:text("Delivered")', { timeout: 5000 }).catch(() => {})
    const stored = JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', 'ai-research', 'med.json'), 'utf8'))
    rec('Mark as delivered writes the Run', stored.status === 'delivered' && !!stored.endedAt && stored.eventTitle === 'Medical Sciences' && stored.work?.pre?.fileId === 'research-teams-intake', stored.status)
    rec('the page follows: Delivered, no Mark as delivered, results open', (await tools.locator('[data-run-pill]').innerText()) === 'Delivered' && (await actionsOf(tools, 'delivered')) === '' && (await actionsOf(tools, 'results')) === 'open-results', await actionsOf(tools, 'delivered'))
    rec('the list follows: Medical Sciences moved under Past', await tools.evaluate(() => { const g = [...document.querySelectorAll('[data-sessions-group]')].find((el) => el.getAttribute('data-sessions-group') === 'past'); return !!g && g.parentElement.textContent.includes('Medical Sciences') }))
    await main.close().catch(() => {})
  } finally { await app.close().catch(() => {}) }
}

// ---- (f) pre-work closed, post-work open, unpublished
{
  const closed = planned('ai-research', 'said', T1, 'Saïd workshop', 0, {
    startTime: '23:30', expectedPeople: 18, handoutUrl: 'https://handouts.fyi/dl/said-21-oct', prework: { entries: [], people: 16 },
    work: { pre: pre(`${dayOf(-7)}T09:00`, hoursAgo(1), { publishedAt: PUB }), post: post(`${dayOf(14)}T17:00`, { publishedAt: PUB }) }
  })
  const postOpen = base('ai-teaching', 'keble', T2, 'Keble', {
    status: 'delivered', plannedDate: dayOf(-1), startTime: '14:00', expectedPeople: 18, handoutUrl: 'https://handouts.fyi/dl/keble',
    startedAt: new Date(Date.now() - 86_400_000).toISOString(), endedAt: new Date(Date.now() - 86_400_000 + 3_600_000).toISOString(),
    prework: { entries: [], people: 16 }, postwork: { entries: [], people: 5 },
    work: { pre: pre(`${dayOf(-9)}T09:00`, `${dayOf(-1)}T13:00`, { publishedAt: PUB }), post: post(`${dayOf(13)}T17:00`, { publishedAt: PUB }) }
  })
  const unpublished = planned('ai-research', 'med', T1, 'Medical Sciences', 21, {
    expectedPeople: 24, handoutUrl: 'https://handouts.fyi/dl/med', prework: { entries: [], people: 7 },
    work: { pre: pre(`${dayOf(7)}T09:00`, `${dayOf(21)}T09:00`, { publishedAt: PUB, unpublishedAt: new Date().toISOString() }) }
  })
  const { app } = await launch([closed, postOpen, unpublished])
  try {
    const { tools } = await openSessions(app)
    await select(tools, 'ai-research/said')
    rec('pre-work closed: Delivered is current, 4 of 8', (await counter(tools)) === '4 of 8' && (await steps(tools)) === 'planned:done pre-ready:done published:done pre-closes:done delivered:current post-open:todo post-closes:todo results:todo', `${await counter(tools)} ${await steps(tools)}`)
    rec('pre-work closed: the pre-work link says closed', (await tools.locator('[data-run-link="pre-work"] .lk').innerText()) === 'Pre-work · closed')
    await shot(tools, '3-pre-work-closed')
    await select(tools, 'ai-teaching/keble')
    rec('post-work open: Post-work closes is current, 6 of 8', (await counter(tools)) === '6 of 8' && (await steps(tools)) === 'planned:done pre-ready:done published:done pre-closes:done delivered:done post-open:done post-closes:current results:todo', `${await counter(tools)} ${await steps(tools)}`)
    rec('post-work open: answered count', (await tools.locator('[data-run-step="post-closes"] .ss').innerText()).includes('5/18 answered'))
    rec('post-work open: Open results is enabled', (await actionsOf(tools, 'results')) === 'open-results')
    await shot(tools, '3-post-work-open')
    await select(tools, 'ai-research/med')
    rec('unpublished: warn step, Publish again', (await steps(tools)).includes('published:warn') && (await actionsOf(tools, 'published')) === 'publish-again preview-page', await actionsOf(tools, 'published'))
    rec('unpublished pill is amber', (await tools.locator('[data-run-pill]').innerText()) === 'Unpublished')
    await shot(tools, '3-unpublished')
  } finally { await app.close().catch(() => {}) }
}

// ---- (g) work-files ticket 30: the Tools window's keys and its palette (⌘⇧P), on the same handlers as the buttons
{
  const { app } = await launch(FOUR)
  try {
    const { tools } = await openSessions(app)
    const press = async (chord) => { await tools.keyboard.press(chord); await tools.waitForTimeout(250) }
    const view = () => tools.evaluate(() => document.querySelector('[data-tools-view]')?.getAttribute('data-tools-view'))
    await press('Meta+Alt+e')
    rec('no Run on show: Edit plan\'s key does nothing', await tools.locator('[data-testid="plan-run-sheet"]').count() === 0)
    await select(tools, 'ai-research/said')
    await press('Meta+Alt+e')
    rec('Edit plan\'s key (⌘⌥E) opens the plan sheet for this Run', await tools.locator('[data-testid="plan-run-sheet"]').count() === 1)
    await tools.keyboard.press('Escape')
    await tools.waitForTimeout(250)
    await press('Meta+Shift+d')
    rec('Plan the next run like this (⌘⇧D) opens the plan sheet', await tools.locator('[data-testid="plan-run-sheet"]').count() === 1)
    await tools.keyboard.press('Escape')
    await tools.waitForTimeout(250)

    await press('Meta+Shift+p')
    rec('⌘⇧P opens the Tools window\'s palette', await tools.locator('[data-command-menu]').count() === 1)
    const listed = await tools.locator('[data-command-menu] [data-command]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-command')}${el.getAttribute('aria-disabled') ? '!' : ''}`))
    rec('the palette lists every Tools command; on a published Run, Publish (no button) and Open run (Published pages only) are disabled', listed.length === 13 && ['tools-edit-plan', 'tools-unpublish', 'tools-go-live', 'tools-copy-link', 'tools-copy-invitation'].every((id) => listed.includes(id)) && listed.includes('tools-publish!') && listed.includes('tools-open-run!'), listed.join(' '))
    rec('the palette shows the keys', (await tools.locator('[data-command-menu] [data-command="tools-go-live"] .command-menu-hint').innerText()) === '⌘⌥L')
    await tools.locator('[data-command-menu] input').fill('invitation')
    rec('palette keywords find a command', await tools.locator('[data-command-menu] [data-command="tools-copy-invitation"]').count() === 1)
    await tools.keyboard.press('Escape')
    await tools.waitForTimeout(250)

    await press('Meta+5')
    rec('⌘5 shows Published pages', (await view()) === 'published')
    await press('Meta+6')
    rec('⌘6 shows Work files', (await view()) === 'workfiles')
    await press('Meta+Shift+n')
    rec('⌘⇧N starts a new work file', await tools.locator('[data-wf-draft-row]').count() === 1)
    await press('Meta+4')
    rec('⌘4 shows Sessions', (await view()) === 'sessions')
    await press('Meta+Shift+p')
    const offered = await tools.locator('[data-command-menu] [data-command]').evaluateAll((els) => els.filter((el) => el.getAttribute('aria-disabled')).map((el) => el.getAttribute('data-command')).sort().join(' '))
    rec('with no Run selected the Run commands are disabled (and so are Open run and New work file)', offered === 'tools-copy-invitation tools-copy-link tools-edit-plan tools-go-live tools-open-run tools-plan-like-this tools-publish tools-unpublish tools-new-work-file'.split(' ').sort().join(' '), offered)
    await tools.keyboard.press('Escape')
    await select(tools, 'ai-research/said')
    await app.evaluate(({ ipcMain }) => {
      globalThis.__presented = []
      ipcMain.removeHandler('talk:present')
      ipcMain.handle('talk:present', (_e, outlinePath, _content, mode, startSlideId, pathwayId, plannedRunId) => { globalThis.__presented.push({ plannedRunId, mode }); return { success: true } })
    })
    await press('Meta+Alt+l')
    const presented = await app.evaluate(() => globalThis.__presented)
    rec('Go live\'s key (⌘⌥L) presents the Run, as the button does', presented.length === 1 && presented[0].plannedRunId === 'said', JSON.stringify(presented))
    await press('Meta+Shift+p')
    await tools.locator('[data-command-menu] input').fill('take down')
    await tools.keyboard.press('Enter')
    await tools.waitForTimeout(300)
    rec('Unpublish from the palette asks first (the button\'s confirmation)', await tools.locator('[data-unpublish-confirm]').count() === 1 && await tools.locator('[data-command-menu]').count() === 0)
  } finally { await app.close().catch(() => {}) }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
