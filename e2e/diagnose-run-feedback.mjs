// Reactions ticket 06, History's Run card (drawing R1, docs/design/2026-09-28-reactions-questions/round-2):
// a delivered Run holding questions and reactions shows "Questions · n" (slide, time, name if given,
// answered or not) and "Reactions by slide" (each slide's net counts, slides with none left out).
// Audience text renders as text only. Viewing never rewrites the Run file; an old Run without the
// fields shows neither section. Isolated temp vault and userData; no network. Screenshots go to
// TW_SHOTS (default <OS temp>/tw-r06-shots).
// Run: npm run test:run-feedback:e2e
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = process.cwd()
const shots = process.env.TW_SHOTS || join(tmpdir(), 'tw-r06-shots')
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-feedback-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
const talkSlug = 'feedback-probe'
const talkDir = join(vault, talkSlug)
const ledgerDir = join(vault, '_PRESENTATIONS', talkSlug)
for (const dir of [talkDir, ledgerDir, userData, shots]) mkdirSync(dir, { recursive: true })

const slide = (id, title) => `### ${title}\n{id=${id}}\n\n${title} body.\n`
writeFileSync(join(talkDir, `${talkSlug}-outline.md`), [
  '---', 'title: Feedback probe', 'outline_version: 2', '---', '',
  slide('s1', 'Opening'), slide('s2', 'What makes something an agent?'), slide('s3', 'The pace check'),
  slide('s4', 'Among the agents'), slide('s5', 'Not all agents are agents'), slide('s6', 'Close'),
].join('\n'), 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

const startedAt = new Date(Date.now() - 86_400_000)
startedAt.setHours(14, 0, 0, 0)
const base = (id, minutesAgo) => ({
  id, talkSlug, talkTitle: 'Feedback probe', kind: 'delivery', status: 'delivered', slideSet: { kind: 'full' },
  startedAt: new Date(startedAt.getTime() - minutesAgo * 60_000).toISOString(),
  endedAt: new Date(startedAt.getTime() - minutesAgo * 60_000 + 34 * 60_000).toISOString(),
  recordingMs: 0, wallClockMs: 34 * 60_000, timerTargetMin: 30, context: 'Feedback seminar', pathwayId: null,
  audio: null, transcript: null, slideTimeIndex: [], polls: [], pollResponses: [],
})
const min = (m, s = 0) => (m * 60 + s) * 1000
let seq = 0
const tap = (reaction, slideId, tMs, withdrawn = false) => ({ id: `sess:r${++seq}`, reaction, slideId, tMs, ...(withdrawn ? { withdrawn: true } : {}) })
const run = {
  ...base('run-feedback', 0),
  instantSlides: [{ id: 'link-1', kind: 'link', shownAt: startedAt.getTime() + min(12), afterSlideId: 's3', url: 'https://example.org/reading' }],
  questions: [
    { id: 'sess:question-1', text: 'Is the “plan” step something I can see and correct before it acts?', slideId: 's2', tMs: min(9), answered: true },
    { id: 'sess:question-2', text: 'Where would you put Copilot in these three stages?', name: 'Tom', slideId: 's4', tMs: min(26), answered: false },
    { id: 'sess:question-3', text: '<img src=x onerror="document.title=\'pwned\'"> is this shown as text?', name: 'Priya', slideId: 's6', tMs: min(31), answered: true },
  ],
  reactions: [
    tap('puzzled', 's2', min(8)), tap('puzzled', 's2', min(8, 5)), tap('helped', 's2', min(8, 20)), tap('bookmark', 's2', min(9)),
    tap('puzzled', 's2', min(9, 30), true), // one person moved from Puzzled…
    tap('helped', 's2', min(9, 30)), // …to Helped
    tap('custom:Too fast', 's3', min(11)), tap('custom:Just right', 's3', min(11)), tap('custom:Just right', 's3', min(11, 2)),
    tap('puzzled', 's4', min(20)), tap('puzzled', 's4', min(20, 4)), tap('puzzled', 's4', min(20, 9)), tap('bookmark', 's4', min(21)),
    tap('agree', 's5', min(24)), tap('agree', 's5', min(24, 10), true), // taps and its undo: nets to nothing
    tap('helped', 'gone-slide', min(30)),
  ],
}
const runPath = join(ledgerDir, 'run-feedback.json')
const runBytes = `${JSON.stringify(run, null, 2)}\n`
writeFileSync(runPath, runBytes, 'utf8')
const oldPath = join(ledgerDir, 'run-old.json')
const oldBytes = `${JSON.stringify(base('run-old', 60 * 24 * 3), null, 2)}\n`
writeFileSync(oldPath, oldBytes, 'utf8')

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const text = async (locator) => ((await locator.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()

await ensureFreshBuild(repo)
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' } })
try {
  const editor = await app.firstWindow()
  await editor.waitForLoadState('domcontentloaded')
  await editor.waitForTimeout(1000)
  const toolsPromise = app.waitForEvent('window')
  await editor.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
  const history = await toolsPromise
  await history.waitForSelector('.twhistory')
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().includes('history') || win.getTitle().includes('History')) win.setSize(1440, 900) })
  await history.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  await history.waitForSelector('[data-history-sid="run-feedback"]')

  await history.locator('[data-history-sid="run-old"]').click()
  await history.waitForTimeout(400)
  record('an old Run without the fields shows neither section',
    await history.locator('[data-history-sid="run-old"] [data-history-questions], [data-history-sid="run-old"] [data-history-reactions]').count() === 0)

  await history.locator('[data-history-sid="run-feedback"]').click()
  const card = history.locator('[data-history-sid="run-feedback"]')
  await card.locator('[data-history-questions]').waitFor()
  // Slide numbers and titles resolve against the talk as it is now.
  await history.waitForFunction(() => document.querySelector('[data-history-questions] .isl-kind')?.textContent?.includes('What makes'), null, { timeout: 15_000 }).catch(() => {})

  const qHead = await text(card.locator('[data-history-questions] .isl-h'))
  record('Questions header counts the questions and the answered ones', qHead.includes('Questions · 3') && qHead.includes('2 marked answered.'), qHead)
  const qRows = card.locator('[data-history-questions] .isl-row')
  const rows = []
  for (let i = 0; i < await qRows.count(); i++) rows.push(await text(qRows.nth(i)))
  const clock = (ms) => { const d = new Date(startedAt.getTime() + ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  record('questions are listed latest first with slide, title, time and name', rows.length === 3
    // The compiled talk opens with its title slide, so outline slide s6 is slide 7.
    && rows[0].startsWith('7Slide 7 · Close') && rows[0].includes(`${clock(min(31))} · Priya`)
    && rows[1].includes('Slide 5 · Among the agents') && rows[1].includes(`${clock(min(26))} · Tom`)
    && rows[2].includes('Slide 3 · What makes something an agent?') && rows[2].includes(`${clock(min(9))} · no name`), JSON.stringify(rows))
  record('answered and not answered are marked', rows[0].endsWith('Answered') && rows[1].endsWith('Not answered') && rows[2].endsWith('Answered'))
  record('question text renders as text, never markup',
    rows[0].includes('<img src=x onerror="document.title=\'pwned\'"> is this shown as text?')
    && await card.locator('[data-history-questions] img').count() === 0
    && !(await history.title()).includes('pwned'))

  const rHead = await text(card.locator('[data-history-reactions] .isl-h'))
  // Net: s2 puzzled 1, helped 2, bookmark 1 = 4; s3 Too fast 1, Just right 2 = 3; s4 puzzled 3, bookmark 1 = 4; gone helped 1 = 1.
  record('Reactions header totals the net counts and the bookmarks', rHead.includes('Reactions by slide · 12') && rHead.includes('2 bookmarks were saved on phones.'), rHead)
  const rRows = card.locator('[data-history-reactions] .rr-row')
  const reactionRows = []
  for (let i = 0; i < await rRows.count(); i++) {
    const r = rRows.nth(i)
    const chips = []
    for (let j = 0; j < await r.locator('.rr-c').count(); j++) chips.push(`${await r.locator('.rr-c').nth(j).getAttribute('data-reaction')}=${(await text(r.locator('.rr-c').nth(j))).replace(/^.*?(\d+)$/, '$1')}`)
    reactionRows.push({ slide: await r.getAttribute('data-reaction-slide'), n: await text(r.locator('.rr-n')), t: await text(r.locator('.rr-t')), chips })
  }
  record('slides are listed in talk order; a slide that nets to nothing is left out', JSON.stringify(reactionRows.map((r) => r.slide)) === JSON.stringify(['s2', 's3', 's4', 'gone-slide']), JSON.stringify(reactionRows.map((r) => r.slide)))
  record('each slide shows its net count per reaction (a withdrawal takes one away)',
    JSON.stringify(reactionRows[0]?.chips) === JSON.stringify(['puzzled=1', 'helped=2', 'bookmark=1'])
    && JSON.stringify(reactionRows[1]?.chips) === JSON.stringify(['custom:Too fast=1', 'custom:Just right=2'])
    && JSON.stringify(reactionRows[2]?.chips) === JSON.stringify(['puzzled=3', 'bookmark=1']), JSON.stringify(reactionRows.map((r) => r.chips)))
  record('custom labels show their words; registered reactions their icons', (await text(rRows.nth(1).locator('.rr-c').nth(0))) === 'Too fast 1'
    && await rRows.nth(0).locator('.rr-c svg').count() === 3)
  record('the slide with the most Puzzled is flagged', reactionRows[2]?.t.endsWith('most puzzled') && !reactionRows[0]?.t.includes('most puzzled'), reactionRows[2]?.t)
  record('a slide no longer in the talk is named as such', reactionRows[3]?.n === '–' && reactionRows[3]?.t === 'A slide no longer in the talk', JSON.stringify(reactionRows[3]))
  record('the footnote says slides with none are left out', (await text(card.locator('.rr-foot'))) === 'Slides with no reactions are not listed.')

  await card.locator('[data-history-questions]').scrollIntoViewIfNeeded()
  await history.evaluate(() => { const el = document.querySelector('[data-history-sid="run-feedback"]'); el?.scrollIntoView({ block: 'start' }) })
  await history.waitForTimeout(250)
  await history.screenshot({ path: join(shots, 'R1-history-run-card-1440x900.png') })
  await history.evaluate(() => document.querySelector('[data-history-reactions]')?.scrollIntoView({ block: 'start' }))
  await history.waitForTimeout(250)
  await history.screenshot({ path: join(shots, 'R1-history-run-card-reactions-1440x900.png') })
  await card.screenshot({ path: join(shots, 'R1-history-run-card-full.png') })

  record('viewing the Run never rewrites it', readFileSync(runPath, 'utf8') === runBytes && readFileSync(oldPath, 'utf8') === oldBytes)
} finally {
  await app.close()
}
if (failures) {
  console.error(`Run feedback gate failed: ${failures} assertion${failures === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log('Run feedback gate passed')
}
