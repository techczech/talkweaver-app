// Work-files-and-sessions ticket 22: the Published pages view in the real app.
// Hidden-window Electron against an isolated temp userData (with a copy of the site in its default place,
// cloudflare-pages-site) and a temp vault holding the drawn example Runs and talks. TW_REC_TEST=1: a
// publish or unpublish builds and checks on this computer and uploads nothing (the app's rehearsal).
//   (a) the list matches the site folder: Run pages then Talk handouts, every live page listed once; a Run's
//       pre-work page is in its row, not a row; a page whose folder the site's copy lacks says so;
//       Medical Sciences (not published) and an unpublished Run are not listed;
//   (b) a Run row's detail: handout, pre-work and post-work links, post-work "opens after the session";
//   (c) Unpublish a talk handout: the confirmation, then only that talk's folder leaves the site's copy,
//       the talk's Run handout is byte for byte as it was, handout_url leaves the outline, the row goes;
//   (d) nothing published: the empty state;
//   (f) the only published outline unreadable: the error with Retry (never "Nothing is published"); Retry lists it;
//   (e) the site's copy there but unreadable: a loading error with Retry, never "Nothing is published"; Retry lists it.
// TW_SHOTS_DIR saves one screenshot per drawn state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
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
const pre = (opens, closes, extra = {}) => ({ fileId: 'research-teams-intake', opens, closes, timeZone: ZONE, ...extra })
const post = (closes, extra = {}) => ({ fileId: 'session-feedback', opens: 'session-end', closes, timeZone: ZONE, ...extra })
const base = (slug, id, title, event, extra) => ({ id, talkSlug: slug, talkTitle: title, kind: 'delivery', slideSet: { kind: 'full' }, startedAt: '', endedAt: '', recordingMs: 0, wallClockMs: 0, timerTargetMin: 0, context: null, pathwayId: null, audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [], eventTitle: event, timeZone: ZONE, ...extra })
const PUB = new Date(Date.now() - 86_400_000).toISOString()
const planned = (slug, id, title, event, day, extra) => base(slug, id, title, event, { status: 'planned', plannedDate: dayOf(day), startTime: '14:00', ...extra })
const T1 = 'AI for research teams'
const T2 = 'Generative AI in teaching'
const SITE_URL = 'https://handouts.example'

const RUNS = [
  planned('ai-research', 'said', T1, 'Saïd workshop', 7, {
    expectedPeople: 18, handoutUrl: `${SITE_URL}/ai-research-said-workshop/`, handoutFolder: 'ai-research-said-workshop', prework: { entries: [], people: 7 },
    work: { pre: pre(`${dayOf(-1)}T09:00`, `${dayOf(7)}T10:00`, { publishedAt: PUB }), post: post(`${dayOf(21)}T17:00`, { publishedAt: PUB }) },
  }),
  planned('ai-teaching', 'keble', T2, 'Keble', 14, {
    handoutUrl: `${SITE_URL}/ai-teaching-keble/`, handoutFolder: 'ai-teaching-keble', work: { pre: pre(`${dayOf(-2)}T09:00`, `${dayOf(14)}T10:00`, { publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }) },
  }),
  planned('ai-research', 'med', T1, 'Medical Sciences', 21, { work: { pre: pre(`${dayOf(7)}T09:00`, `${dayOf(21)}T09:00`) } }),
  planned('ai-teaching', 'gone', T2, 'Unpublished run', 3, {
    handoutUrl: `${SITE_URL}/ai-teaching-gone/`, handoutFolder: 'ai-teaching-gone', unpublishedAt: new Date().toISOString(),
    work: { pre: pre(`${dayOf(-2)}T09:00`, `${dayOf(3)}T10:00`, { publishedAt: PUB, unpublishedAt: new Date().toISOString() }) },
  }),
]
/** The site's copy on this computer: the Saïd Run's pages and AI for research teams' handout. Keble's folder and Generative AI in teaching's are not here. */
const SITE_FILES = {
  'ai-research/index.html': '<!doctype html><title>AI for research teams</title>', 'ai-research/ai-research.html': 'the talk handout',
  'ai-research-said-workshop/index.html': '<!doctype html><title>Saïd</title>', 'ai-research-said-workshop/pre-work/index.html': 'pre-work page',
  'ai-research-said-workshop/post-work/index.html': 'post-work page', 'ai-research-said-workshop/assets/a.png': 'png',
  'ai-teaching-gone/index.html': 'This page is not available',
}
const outline = (title, url) => `---\ntitle: ${title}\n${url ? `handout_url: ${url}\n` : ''}auto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Opening\n{id=open}\n\nHello.\n`

function seed({ runs, talks, site }) {
  const root = mkdtempSync(join(tmpdir(), 'tw-published-pages-e2e-'))
  const vault = join(root, 'vault'); const ud = join(root, 'userData')
  mkdirSync(ud, { recursive: true })
  for (const [slug, title, url] of talks) {
    mkdirSync(join(vault, slug), { recursive: true })
    writeFileSync(join(vault, slug, `${slug}-outline.md`), outline(title, url))
  }
  for (const run of runs) {
    mkdirSync(join(vault, '_PRESENTATIONS', run.talkSlug), { recursive: true })
    writeFileSync(join(vault, '_PRESENTATIONS', run.talkSlug, `${run.id}.json`), JSON.stringify(run, null, 2))
  }
  const siteDir = join(ud, 'cloudflare-pages-site')
  for (const [file, text] of Object.entries(site)) { mkdirSync(join(siteDir, file, '..'), { recursive: true }); writeFileSync(join(siteDir, file), text) }
  writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
  return { ud, vault, siteDir }
}
async function launch(world) {
  const seeded = seed(world)
  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return { app: await electron.launch({ args: ['.', '--user-data-dir=' + seeded.ud], cwd: process.cwd(), env, timeout: 60_000 }), ...seeded } }
    catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
  }
}
async function openPublished(app, waitFor) {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  const pending = app.waitForEvent('window')
  await page.evaluate(() => window.tw.tools.open('published'))
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await tools.waitForSelector('[data-tools-view="published"]', { timeout: 10_000 })
  await tools.waitForSelector(waitFor, { timeout: 10_000 })
  return { tools, main: page }
}
const shot = async (tools, name) => { if (shotsDir) await tools.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {}) }
const filesUnder = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath ?? e.path, e.name))).sort() : []
const rows = (tools) => tools.evaluate(() => [...document.querySelectorAll('[data-published-row]')].map((el) => `${el.getAttribute('data-published-row')}:${el.getAttribute('data-published-site')}`))

// ---- (a) (b) (c)
{
  const { app, vault, siteDir } = await launch({
    runs: RUNS,
    talks: [['ai-research', T1, `${SITE_URL}/ai-research/`], ['ai-teaching', T2, `${SITE_URL}/ai-teaching/`], ['unpublished', 'Not published', null]],
    site: SITE_FILES,
  })
  try {
    const { tools } = await openPublished(app, '[data-published-row]')
    const vaultId = await tools.evaluate(async () => (await window.tw.published.list()).runs[0]?.vaultId ?? '')
    const want = [
      `${vaultId}|run|ai-research/said:found`, `${vaultId}|run|ai-teaching/keble:folder-missing`,
      `${vaultId}|talk|ai-research/ai-research-outline.md:found`, `${vaultId}|talk|ai-teaching/ai-teaching-outline.md:folder-missing`,
    ]
    const got = await rows(tools)
    rec('the list matches the site folder: every live page once, each found or not on this computer', JSON.stringify(got) === JSON.stringify(want), got.join(' '))
    const groups = await tools.locator('[data-published-group]').evaluateAll((els) => els.map((el) => el.getAttribute('data-published-group')).join(','))
    rec('Run pages, then Talk handouts', groups === 'runs,talks', groups)
    rec('the header counts the pages', (await tools.locator('[data-published-count]').innerText()) === '4')
    rec('the site folder\'s own folders each lead to a row (or to no live page)', ['ai-research', 'ai-research-said-workshop'].every((folder) => existsSync(join(siteDir, folder))))
    rec('no pre-work or post-work row of its own', !got.some((key) => /pre-work|post-work/.test(key)))
    rec('a page this computer does not have says so', (await tools.locator(`[data-published-row="${vaultId}|talk|ai-teaching/ai-teaching-outline.md"]`).innerText()).includes('Not on this computer'))
    await shot(tools, '8-list')

    // (b) the Saïd row's detail
    await tools.locator(`[data-published-row="${vaultId}|run|ai-research/said"] .tw-pub-pick`).click()
    await tools.waitForSelector(`[data-published-detail="${vaultId}|run|ai-research/said"]`, { timeout: 5000 })
    const links = await tools.locator('[data-published-link]').evaluateAll((els) => els.map((el) => `${el.getAttribute('data-published-link')}=${el.querySelector('b')?.textContent}`))
    rec('a Run row\'s detail: handout, pre-work and post-work links', JSON.stringify(links) === JSON.stringify(['handout=Handout link', 'pre-work=Pre-work link', 'post-work=Post-work link · opens after the session']), links.join(' | '))
    rec('Open run is offered', await tools.locator('[data-published-open="run"]').count() === 1)
    await tools.locator(`[data-published-unpublish="${vaultId}|run|ai-research/said"]`).click()
    await tools.waitForSelector('[data-unpublish-confirm]', { timeout: 5000 })
    rec('a Run\'s Unpublish asks with ticket 17\'s words', (await tools.locator('#tw-unpub-body').innerText()).startsWith('The handout, the pre-work page and the post-work page will show'), await tools.locator('#tw-unpub-body').innerText())
    await shot(tools, '12-from-published-pages')
    await tools.locator('[data-unpublish-action="cancel"]').click()
    rec('Cancel closes it, nothing changed', await tools.locator('[data-unpublish-confirm]').count() === 0 && (await rows(tools)).length === 4)

    // (c) Unpublish the talk handout AI for research teams
    const runBefore = Object.fromEntries(filesUnder(join(siteDir, 'ai-research-said-workshop')).map((file) => [file, readFileSync(join(siteDir, 'ai-research-said-workshop', file), 'utf8')]))
    const talkKey = `${vaultId}|talk|ai-research/ai-research-outline.md`
    await tools.locator(`[data-published-unpublish="${talkKey}"]`).click()
    await tools.waitForSelector('[data-unpublish-confirm]', { timeout: 5000 })
    rec('the talk confirmation', (await tools.locator('#tw-unpub-title').innerText()) === `Unpublish the handout for ${T1}?` && (await tools.locator('#tw-unpub-body').innerText()).startsWith('The handout will be taken off the site'), await tools.locator('#tw-unpub-body').innerText())
    await shot(tools, '8-unpublish-confirm')
    await tools.locator('[data-unpublish-action="confirm"]').click()
    await tools.waitForSelector(`[data-published-row="${talkKey}"]`, { state: 'detached', timeout: 20_000 }).catch(() => {})
    rec('the row goes', await tools.locator(`[data-published-row="${talkKey}"]`).count() === 0, (await rows(tools)).join(' '))
    rec('only the talk\'s folder left the site\'s copy', !existsSync(join(siteDir, 'ai-research')) && existsSync(join(siteDir, 'ai-teaching-gone', 'index.html')))
    const runAfter = Object.fromEntries(filesUnder(join(siteDir, 'ai-research-said-workshop')).map((file) => [file, readFileSync(join(siteDir, 'ai-research-said-workshop', file), 'utf8')]))
    rec('the talk\'s Run handout is byte for byte as it was', JSON.stringify(runAfter) === JSON.stringify(runBefore) && Object.keys(runAfter).length === 4)
    const text = readFileSync(join(vault, 'ai-research', 'ai-research-outline.md'), 'utf8')
    rec('handout_url left the outline, nothing else did', text === outline(T1, null), JSON.stringify(text.slice(0, 80)))
    rec('the Run row stays', (await rows(tools)).includes(`${vaultId}|run|ai-research/said:found`))
    const notice = await tools.locator('[data-published-notice]').count()
    rec('no notice: it went through', notice === 0)
  } finally { await app.close().catch(() => {}) }
}

// ---- (d) the empty state
{
  const { app } = await launch({ runs: [RUNS[2]], talks: [['unpublished', 'Not published', null]], site: {} })
  try {
    const { tools } = await openPublished(app, '[data-published-empty]')
    const body = (await tools.locator('[data-tools-view="published"]').textContent()) ?? ''
    rec('nothing published: the empty state', body.includes('Nothing is published') && body.includes('No page selected'), body.trim().slice(0, 80))
    await shot(tools, '8-empty')
  } finally { await app.close().catch(() => {}) }
}

// ---- (e) a listing that fails: the error and Retry, never the empty state
{
  const { app, siteDir } = await launch({ runs: [], talks: [['ai-research', T1, `${SITE_URL}/ai-research/`]], site: { 'ai-research/index.html': 'x' } })
  chmodSync(siteDir, 0o000)
  try {
    const { tools } = await openPublished(app, '[data-published-error]')
    const body = (await tools.locator('[data-tools-view="published"]').textContent()) ?? ''
    rec('an unreadable site: the loading error, not "Nothing is published"', !body.includes('Nothing is published') && body.includes('could not be read') && await tools.locator('[data-published-retry]').count() === 1, body.trim().slice(0, 120))
    chmodSync(siteDir, 0o755)
    await tools.locator('[data-published-retry]').click()
    await tools.waitForSelector('[data-published-row]', { timeout: 10_000 }).catch(() => {})
    rec('Retry lists the pages once the site can be read', (await rows(tools)).length === 1 && await tools.locator('[data-published-error]').count() === 0, (await rows(tools)).join(' '))
  } finally { try { chmodSync(siteDir, 0o755) } catch { /* gone */ } await app.close().catch(() => {}) }
}

// ---- (f) the only published outline cannot be read: the error and Retry, never the empty state
{
  const { app, vault } = await launch({ runs: [], talks: [['ai-research', T1, `${SITE_URL}/ai-research/`]], site: { 'ai-research/index.html': 'x' } })
  const file = join(vault, 'ai-research', 'ai-research-outline.md')
  chmodSync(file, 0o000)
  try {
    const { tools } = await openPublished(app, '[data-published-error], [data-published-empty], [data-published-row]')
    const body = (await tools.locator('[data-tools-view="published"]').textContent()) ?? ''
    rec('an unreadable outline: the error with Retry, not "Nothing is published"', !body.includes('Nothing is published') && body.includes('could not be read') && await tools.locator('[data-published-retry]').count() === 1, body.trim().slice(0, 120))
    chmodSync(file, 0o644)
    await tools.locator('[data-published-retry]').click()
    await tools.waitForSelector('[data-published-row]', { timeout: 10_000 }).catch(() => {})
    rec('Retry lists it once it can be read', (await rows(tools)).length === 1, (await rows(tools)).join(' '))
  } finally { try { chmodSync(file, 0o644) } catch { /* gone */ } await app.close().catch(() => {}) }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
