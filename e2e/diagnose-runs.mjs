// Host gate for ADR-0038 parcel 2. Runs against an isolated temp Vault/userData only.
// TW_REC_TEST stubs the Cloudflare deploy seam; no network request is made.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-runs-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
const talkSlug = 'run-probe'
const talkDir = join(vault, talkSlug)
const outlinePath = join(talkDir, `${talkSlug}-outline.md`)
const ledgerDir = join(vault, '_PRESENTATIONS', talkSlug)
mkdirSync(talkDir, { recursive: true })
mkdirSync(ledgerDir, { recursive: true })
mkdirSync(userData, { recursive: true })

const slide = (id, title) => `### ${title}\n{id=${id}}\n\n${title} body.\n`
const originalOutline = [
  '---', 'title: Run probe', 'handout_url: https://evergreen.example/run-probe', 'outline_version: 2', '---', '',
  slide('s1', 'One'), slide('s2', 'Two'), slide('s3', 'Three'), slide('s4', 'Four')
].join('\n')
writeFileSync(outlinePath, originalOutline, 'utf8')
writeFileSync(join(ledgerDir, 'manifest.json'), JSON.stringify({ pathways: [{ id: 'short', name: 'Short route', slideIds: ['s3', 'missing', 's1'] }] }, null, 2), 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  vaultRoot: vault,
  publishBaseUrl: 'https://mock-run-handouts.test',
  cfPagesProject: 'talkweaver-test'
}, null, 2), 'utf8')

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' } })
const editor = await app.firstWindow()
await editor.waitForLoadState('domcontentloaded')
await editor.getByText('Run probe', { exact: true }).first().click()
await editor.waitForSelector('.workspace')

const toolsPromise = app.waitForEvent('window')
await editor.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
const history = await toolsPromise
await history.waitForSelector('.twhistory')
await history.locator('.twh-plan-button').click()
const sheet = history.locator('[data-testid="plan-run-sheet"]')
await sheet.waitFor()

const future = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10)
await sheet.locator('[data-field="date"]').fill(future)
await sheet.locator('[data-field="event"]').fill('Dept. seminar')
await sheet.locator('[data-field="audience"]').fill('Continuing Education')
await sheet.locator('[data-field="slide-set"] option[value="short"]').waitFor({ state: 'attached' })
await sheet.locator('[data-field="slide-set"]').selectOption('short')
await sheet.locator('[data-testid="plan-run-save"]').click()
await history.waitForSelector('[data-planned-run]')

const files = readdirSync(ledgerDir).filter((name) => name.endsWith('.json') && name !== 'manifest.json')
const plannedPath = join(ledgerDir, files[0])
const planned = JSON.parse(readFileSync(plannedPath, 'utf8'))
record('History plan sheet creates a planned Run', planned.status === 'planned' && planned.eventTitle === 'Dept. seminar')
// Reactions ticket 06 fix round: a live session may already have written into the planned Run before
// the delivery is saved onto it; the save must keep all of it.
const seeded = {
  polls: [{ id: 'seed-poll', type: 'single', question: 'Choose', options: [{ optionId: 'a', label: 'A' }], visibility: 'live' }],
  pollResponses: [{ responseId: 'seed:1', pollId: 'seed-poll', choice: 'a', tMs: 5, slideId: 's3' }],
  instantSlides: [{ id: 'text-1', kind: 'text', shownAt: 1, afterSlideId: 's3', text: 'Seeded' }],
  reactions: [{ id: 'seed:r1', reaction: 'puzzled', slideId: 's3', tMs: 1000 }, { id: 'seed:r2', reaction: 'puzzled', slideId: 's3', tMs: 2000, withdrawn: true }],
  questions: [{ id: 'seed:question-1', text: 'Seeded question?', slideId: 's3', tMs: 1500, answered: true }],
}
writeFileSync(plannedPath, JSON.stringify({ ...planned, ...seeded }, null, 2), 'utf8')
record('Planned row renders the pathway slide-set chip', (await history.locator(`[data-planned-run="${planned.id}"] .twh-slide-set`).textContent()).includes('Short route'))

const presenterPromise = app.waitForEvent('window')
await history.locator(`[data-planned-run="${planned.id}"] summary`).click()
await history.locator(`[data-planned-run="${planned.id}"] button`, { hasText: 'Present' }).click()
const presenter = await presenterPromise
await presenter.waitForSelector('#stage .slide', { state: 'attached' })
await presenter.waitForSelector('#presenterRoot', { state: 'visible' })
const played = await presenter.evaluate(() => ({
  pathway: window.__talkWeaverPathway,
  slides: Array.from(document.querySelectorAll('#stage .slide')).map((node) => node.dataset.id)
}))
record('Presenting a planned pathway uses its ordered slide set', JSON.stringify(played.slides) === JSON.stringify(['s3', 's1']), JSON.stringify(played.slides))

// Reach the final slide so the normal close-save offer gate fires. Presenter's stage is display:none;
// #presenterRoot visibility + runtime state are the correct assertions.
await presenter.keyboard.press('ArrowRight')
await presenter.waitForTimeout(350)
await presenter.evaluate(() => window.close())
await presenter.waitForSelector('.twrec-close-modal')
const preferred = presenter.locator(`[data-planned-run="${planned.id}"]`)
record('save offer preselects the directly presented planned Run', await preferred.count() === 1 && await preferred.evaluate((node) => node.classList.contains('active')))
// Subscribe to close BEFORE clicking: the save+close completes fast enough that a
// waitForEvent registered after the click can miss the event and hang forever.
const presenterClosed = presenter.waitForEvent('close', { timeout: 15000 }).catch(() => {})
await preferred.click()
await presenterClosed
if (!presenter.isClosed()) throw new Error('presenter window did not close after attaching the delivery')

const delivered = JSON.parse(readFileSync(plannedPath, 'utf8'))
record('save offer attaches instead of minting a second Run', delivered.status === 'delivered' && readdirSync(ledgerDir).filter((name) => name.endsWith('.json') && name !== 'manifest.json').length === 1)
record('the save keeps the polls, answers, instant slides, reactions and questions a live session flushed into the planned Run',
  JSON.stringify(['polls', 'pollResponses', 'instantSlides', 'reactions', 'questions'].map((key) => (delivered[key] ?? []).map((entry) => entry.id ?? entry.responseId)))
    === JSON.stringify([['seed-poll'], ['seed:1'], ['text-1'], ['seed:r1', 'seed:r2'], ['seed:question-1']]),
  JSON.stringify({ polls: delivered.polls?.length, reactions: delivered.reactions?.length, questions: delivered.questions?.length }))
record('the saved Run file is complete JSON with no temporary file left beside it', readdirSync(ledgerDir).every((name) => !name.endsWith('.tmp')))
record('attached Run keeps its event metadata', delivered.eventTitle === 'Dept. seminar' && delivered.plannedDate === future)

const local = await history.evaluate(async ({ talkSlug, runId }) => window.tw.history.buildRunHandout(talkSlug, runId), { talkSlug, runId: planned.id })
record('local Run handout build succeeds', local.success && !!local.path && existsSync(local.path), local.error || '')
record('Run handout slide ids equal the pathway set and skip missing ids', JSON.stringify(local.slideIds) === JSON.stringify(['s3', 's1']), JSON.stringify(local.slideIds))
const localHtml = local.path ? readFileSync(local.path, 'utf8') : ''
record('Run handout cover carries the event title', localHtml.includes('Dept. seminar'))

const published = await history.evaluate(async ({ talkSlug, runId }) => window.tw.history.publishRunHandout(talkSlug, runId), { talkSlug, runId: planned.id })
const afterPublish = JSON.parse(readFileSync(plannedPath, 'utf8'))
record('dry-run publish stores an own Run URL without network', published.success && afterPublish.handoutUrl?.startsWith('https://mock-run-handouts.test/'), published.error || '')
await history.reload()
await history.waitForSelector(`[data-history-sid="${planned.id}"] .badge-run`)
record('History lists the published handout against the delivered Run', await history.locator(`[data-history-sid="${planned.id}"] .badge-run`).count() === 1)

const unpublished = await history.evaluate(async ({ talkSlug, runId }) => window.tw.history.unpublishRunHandout(talkSlug, runId), { talkSlug, runId: planned.id })
const afterUnpublish = JSON.parse(readFileSync(plannedPath, 'utf8'))
record('Run handout can be unpublished', unpublished.success && !afterUnpublish.handoutUrl, unpublished.error || '')
record('evergreen outline frontmatter is byte-identical through the Run publish cycle', readFileSync(outlinePath, 'utf8') === originalOutline)

await app.close()
if (failures) {
  console.error(`Runs gate failed: ${failures} assertion${failures === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log('Runs gate passed')
}
