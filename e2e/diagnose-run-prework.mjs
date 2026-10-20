// Work-files-and-sessions ticket 18 (was feedback-boards ticket 11): a Run's pre-work and post-work answers
// on the Run page in Sessions, in the real app. Hidden-window Electron against an isolated
// temp Vault/userData on seeded Runs; no network.
//   (a) the way in (tools.openRun, what "Review pre-work" and History's planned-row Review call) opens Sessions on the Run's page;
//   (b) the Pre-work answers section counts who started, and lists the four steps with their counts;
//   (c) an open question lists its answers as text (markup shown, never interpreted), three at first and
//       "Show all" for the rest; stars are kept on the Run in order, and "Use N starred on a board" counts them;
//   (d) the quick check shows the spread with the right answer marked (author only);
//   (e) questions about steps: Put in the talk's questions and Mark answered (and Undo) reach the Run;
//   (f) the section folds and unfolds; a Run with no post-work file shows no Post-work answers section;
//   (g) a delivered Run with post-work open: the pre-work section starts folded, post-work answers are read
//       from its file, stars are kept on the post-work section, and its numbers are its own;
//   (h) a Run's own numbers survive: nothing of the page is written to the outline.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OUTLINE, RUN_ID, SLUG, entry, plannedRun } from '../scripts/lib/prework-run-fixture.mjs'

const repo = process.cwd()
const shots = join(tmpdir(), 'tw-b18-shots')
mkdirSync(shots, { recursive: true })
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-answers-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
mkdirSync(userData, { recursive: true })
const plusDays = (n) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

const talkDir = join(vault, SLUG)
mkdirSync(talkDir, { recursive: true })
mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
mkdirSync(join(vault, 'Work files'), { recursive: true })
const outlinePath = join(talkDir, `${SLUG}-outline.md`)
writeFileSync(outlinePath, OUTLINE, 'utf8')
const runPath = join(vault, '_PRESENTATIONS', SLUG, `${RUN_ID}.json`)
writeFileSync(runPath, JSON.stringify(plannedRun({ plannedDate: plusDays(10), preworkOpens: `${plusDays(-8)}T09:00`, preworkCloses: `${plusDays(10)}T10:00` }), null, 2), 'utf8')

// A delivered Run whose post-work is open: its answers are read from a work file, not the talk's section.
const POST_RUN = 'run-post-answers'
const FEEDBACK = ['---', 'id: session-feedback', 'title: Session feedback', 'revision: 1', '---', '',
  '### One thing you will try', '{id=try}{poll=open}', '',
  '### Anything unclear?', '{id=unclear}{poll=open}', ''].join('\n')
writeFileSync(join(vault, 'Work files', 'session-feedback.md'), FEEDBACK, 'utf8')
const postPath = join(vault, '_PRESENTATIONS', SLUG, `${POST_RUN}.json`)
writeFileSync(postPath, JSON.stringify(plannedRun({
  id: POST_RUN, status: 'delivered', plannedDate: plusDays(-1), startTime: '10:00', eventTitle: 'Feedback workshop',
  startedAt: new Date(Date.now() - 86_400_000).toISOString(), endedAt: new Date(Date.now() - 82_800_000).toISOString(),
  preworkOpens: `${plusDays(-9)}T09:00`, preworkCloses: `${plusDays(-1)}T10:00`,
  work: { post: { fileId: 'session-feedback', opens: 'session-end', closes: `${plusDays(6)}T17:00`, timeZone: 'Europe/London' } },
  postwork: {
    people: 3, lastActivityAt: Date.now(),
    entries: [
      entry(1, 'answer', 'try', { text: 'Keep a shared prompt file' }), entry(2, 'answer', 'try', { text: 'Ask the library about <i>citations</i>' }),
      entry(3, 'answer', 'try', { text: 'Review my methods section' }), entry(1, 'answer', 'unclear', { text: 'Does the licence cover unpublished data?' }),
      entry(2, 'question', 'try', { text: 'Is there a template?', submissionId: 'p' })
    ]
  }
}), null, 2), 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')
const readRun = () => JSON.parse(readFileSync(runPath, 'utf8'))
const readPost = () => JSON.parse(readFileSync(postPath, 'utf8'))

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

await ensureFreshBuild(repo)
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }, timeout: 60000 })
  } catch (error) {
    if (attempt === 3) throw error
    console.log(`launch attempt ${attempt} failed (${error.message}); retrying`)
  }
}
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  // (a) the way in: the same call the status bar's "Review pre-work" and History's planned-row "Review" make
  // (the chip itself is hidden from the renderer while the pre-work flag is a constant there).
  const toolsPromise = app.waitForEvent('window')
  await page.evaluate(([slug, id]) => window.tw.tools.openRun(slug, id), [SLUG, RUN_ID])
  const tools = await toolsPromise
  await tools.waitForSelector(`[data-sessions-detail="${SLUG}/${RUN_ID}"]`, { timeout: 20_000 })
  record('Sessions opens on the Run page', true)
  tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await tools.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  const pre = tools.locator('[data-run-section="pre-answers"]')
  const rowsOf = (section, step) => section.locator(`[data-run-answer-step="${step}"] [data-run-answer]`)

  // (b) the section and its steps
  await pre.locator('[data-run-answer-step="pwhope"]').waitFor({ timeout: 20_000 })
  record('the section counts nine of twelve answered, with a 64px bar', (await pre.locator('[data-run-answered]').innerText()) === '9/12 answered' && await pre.locator('header .bar').evaluate((el) => el.getBoundingClientRect().width === 64))
  record('four steps are listed', await pre.locator('[data-run-answer-step]').count() === 4)
  record('each step says how many took part', JSON.stringify(await pre.locator('[data-run-answer-step] .sum').allInnerTexts()) === JSON.stringify(['read by 9 of 9', '8 completed', '6 answers', '4 marked done of 9']), (await pre.locator('[data-run-answer-step] .sum').allInnerTexts()).join(' | '))
  record('the Run has no post-work file: no Post-work answers section', await tools.locator('[data-run-section="post-answers"]').count() === 0)
  record('"Use starred on a board" waits for a star', await pre.locator('[data-run-use-starred]').isDisabled())
  await tools.screenshot({ path: join(shots, 'S4-some-in.png') })

  // (c) open answers and stars
  record('three answers show at first, with Show all', await rowsOf(pre, 'pwhope').count() === 3 && (await pre.locator('[data-run-show-all="pwhope"]').innerText()) === 'Show all 6')
  await pre.locator('[data-run-show-all="pwhope"]').click()
  record('Show all lists every answer', await rowsOf(pre, 'pwhope').count() === 6)
  record('markup in an answer is shown as text, never interpreted', await tools.evaluate(() => {
    const row = [...document.querySelectorAll('[data-run-answer] .tx')].find((node) => node.textContent.includes('Bold hopes'))
    return Boolean(row) && row.textContent === '<b>Bold hopes</b> & more' && row.querySelector('b') === null && !window.__pwned
  }))
  await rowsOf(pre, 'pwhope').nth(2).locator('[data-run-star]').click()
  await tools.waitForFunction(() => document.querySelectorAll('[data-run-answer].starred').length === 1)
  await rowsOf(pre, 'pwhope').nth(0).locator('[data-run-star]').click()
  await tools.waitForFunction(() => document.querySelectorAll('[data-run-answer].starred').length === 2)
  const run1 = readRun()
  const ids = run1.prework.entries.filter((e) => e.kind === 'answer' && e.stepId === 'pwhope').sort((a, b) => a.at - b.at).map((e) => e.id)
  record('stars are kept on the Run, in the order they were given', JSON.stringify(run1.prework.picks?.pwhope) === JSON.stringify({ mode: 'picked', ids: [ids[2], ids[0]] }), JSON.stringify(run1.prework.picks))
  record('the header counts the starred answers', (await pre.locator('[data-run-use-starred]').innerText()) === 'Use 2 starred on a board' && await pre.locator('[data-run-use-starred]').isEnabled())
  await pre.locator('[data-run-use-starred]').click()
  await pre.locator('[data-run-answers-notice]').waitFor()
  const noticeText = await pre.locator('[data-run-answers-notice]').innerText()
  record('"Use 2 starred on a board" names the board slide that takes them', /2 starred answers open the board “What do you hope for today\?”/.test(noticeText), noticeText)
  await rowsOf(pre, 'pwhope').nth(2).locator('[data-run-star]').click()
  await tools.waitForFunction(() => document.querySelectorAll('[data-run-answer].starred').length === 1)
  record('a second click takes the star off, and the Run follows', JSON.stringify(readRun().prework.picks.pwhope.ids) === JSON.stringify([ids[0]]) && (await pre.locator('[data-run-use-starred]').innerText()) === 'Use 1 starred on a board')
  await tools.screenshot({ path: join(shots, 'S4-answers-and-stars.png') })

  // (d) the quick check
  const spread = pre.locator('[data-run-answer-step="pwquiz"] [data-run-spread]')
  record('the quick check lists its four options with counts', await spread.count() === 4 && JSON.stringify(await spread.locator('.v').allInnerTexts()) === JSON.stringify(['2 of 8', '5 of 8', '0 of 8', '1 of 8']), (await spread.locator('.v').allInnerTexts()).join(' | '))
  record('the right answer is marked', await pre.locator('[data-run-answer-step="pwquiz"] .qrow.right').count() === 1 && (await pre.locator('[data-run-answer-step="pwquiz"] .qrow.right').innerText()).includes('Uses tools to carry out steps'))

  // (e) questions about steps
  await pre.locator('[data-run-questions-toggle="pwtask1"]').click()
  record('two questions about the task, one with a typed name', await pre.locator('[data-run-answer-step="pwtask1"] [data-run-question]').count() === 2 && (await pre.locator('[data-run-answer-step="pwtask1"]').innerText()).includes('Sam') && (await pre.locator('[data-run-answer-step="pwtask1"]').innerText()).includes('no name'))
  const first = pre.locator('[data-run-answer-step="pwtask1"] [data-run-question]').first()
  await first.locator('[data-run-question-answered]').click()
  await first.locator('[data-run-question-undo]').waitFor()
  record('Mark answered reaches the Run', readRun().prework.entries.filter((e) => e.kind === 'question' && e.answered).length === 1)
  await first.locator('[data-run-question-undo]').click()
  await first.locator('[data-run-question-answered]').waitFor()
  record('Undo takes the mark off again', readRun().prework.entries.every((e) => !e.answered))
  await pre.locator('[data-run-answer-step="pwtask1"] [data-run-question]').first().locator('[data-run-question-intalk]').click()
  await tools.waitForFunction(() => document.querySelectorAll('[data-run-question] [data-run-question-intalk]').length === 1)
  const inTalk = readRun().prework.entries.filter((e) => e.inTalk)
  record('Put in the talk’s questions records it on the Run', inTalk.length === 1, JSON.stringify(inTalk.map((e) => e.inTalk)))

  // (f) folding
  await pre.locator('[data-run-fold="pre"]').click()
  record('the chevron folds the section to its header', await pre.locator('[data-run-answer-step]').count() === 0 && (await pre.locator('[data-run-fold="pre"]').getAttribute('aria-expanded')) === 'false')
  await pre.locator('[data-run-fold="pre"]').click()
  record('and unfolds it', await pre.locator('[data-run-answer-step]').count() === 4)

  // (g) post-work open
  await tools.locator(`[data-sessions-row="${SLUG}/${POST_RUN}"]`).click()
  await tools.waitForSelector(`[data-sessions-detail="${SLUG}/${POST_RUN}"]`)
  const post = tools.locator('[data-run-section="post-answers"]')
  await post.locator('[data-run-answer-step="try"]').waitFor({ timeout: 20_000 })
  const folded = tools.locator('[data-run-section="pre-answers"]')
  record('while post-work is open the pre-work section starts folded', (await folded.getAttribute('data-folded')) === 'true' && await folded.locator('[data-run-answer-step]').count() === 0)
  record('the Post-work section counts its own people', (await post.locator('[data-run-answered]').innerText()) === '3/12 answered')
  record('its two steps read from the work file are listed', await post.locator('[data-run-answer-step]').count() === 2 && (await post.locator('[data-run-answer-step="try"] .sum').innerText()) === '3 answers')
  record('post-work answers are shown as text too', await tools.evaluate(() => {
    const row = [...document.querySelectorAll('[data-run-section="post-answers"] [data-run-answer] .tx')].find((node) => node.textContent.includes('citations'))
    return Boolean(row) && row.textContent === 'Ask the library about <i>citations</i>' && row.querySelector('i') === null
  }))
  await post.locator('[data-run-answer-step="try"] [data-run-answer] [data-run-star]').nth(1).click()
  await tools.waitForFunction(() => document.querySelectorAll('[data-run-section="post-answers"] [data-run-answer].starred').length === 1)
  const stored = readPost()
  record('a star on a post-work answer is kept on the post-work section', stored.postwork.picks?.try?.ids?.length === 1 && stored.prework?.picks === undefined, JSON.stringify(stored.postwork.picks))
  record('and counted in the post-work header', (await post.locator('[data-run-use-starred]').innerText()) === 'Use 1 starred on a board')
  await post.locator('[data-run-questions-toggle="try"]').click()
  await post.locator('[data-run-question-answered]').click()
  await post.locator('[data-run-question-undo]').waitFor()
  record('Mark answered works on a post-work question', readPost().postwork.entries.some((e) => e.kind === 'question' && e.answered === true))
  record('post-work offers no "Put in the talk’s questions"', await post.locator('[data-run-question-intalk]').count() === 0)
  await tools.screenshot({ path: join(shots, 'S4-post-work-some-in.png') })
  await folded.locator('[data-run-fold="pre"]').click()
  record('the folded pre-work section unfolds on its chevron', await folded.locator('[data-run-answer-step]').count() > 0 || await folded.locator('.tw-ans-empty').count() > 0)

  // (h) nothing reached the outline; nothing ran
  record('nothing of the Run page reached the outline', readFileSync(outlinePath, 'utf8') === OUTLINE)
  record('no script ran from any answer or question', await tools.evaluate(() => !window.__pwned))
} finally {
  await app.close().catch(() => {})
}
console.log(failures ? `run-prework e2e: ${failures} FAILED` : 'run-prework e2e: all passed')
process.exit(failures ? 1 : 0)
