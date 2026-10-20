// Work-files ticket 06: the Tools window's Work files view in the real app (hidden window, temp vault,
// isolated userData, no network).
//   (a) the list shows the files with the drawn "Used as pre-work in N talks · as post-work in M" lines;
//   (b) opening a file shows its steps (kind, layout, id) and the talks and Runs using it;
//   (c) a file with findings says so on its row and lists them when open;
//   (d) Open run switches to Sessions on that Run;
//   (e) an empty vault shows the drawn empty state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPlannedRun } from '../src/main/runs.ts'

const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })
let failures = 0
const rec = (name, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
await ensureFreshBuild(process.cwd())

const head = (id, title) => ['---', `id: ${id}`, `title: ${title}`, 'revision: 1', '---', ''].join('\n')
const RTI = head('research-teams-intake', 'Research teams intake') + ['Short steps.', '', '### Watch', '{id=watch}{video}', '![](https://youtu.be/dQw4w9WgXcQ)', '### Quick check', '{id=check}{check}{poll=single}', '- One {right}', '- Two', '### Try a prompt', '{id=try}{task}', '1. Pick', '2. Try', '### Want', '{id=want}{poll=open}', ''].join('\n')
const SFB = head('session-feedback', 'Session feedback') + ['### Useful?', '{id=useful}{poll=rating}', '### Unclear?', '{id=unclear}{poll=open}', ''].join('\n')
const BROKEN = ['---', 'title: Broken one', '---', '', '### Table {id=tab}', '| a | b |', '|--|--|', '| 1 | 2 |', ''].join('\n')

function makeVault(withFiles) {
  const root = mkdtempSync(join(tmpdir(), 'tw-work-files-e2e-'))
  const vault = join(root, 'vault'); const ud = join(root, 'userData')
  mkdirSync(vault, { recursive: true }); mkdirSync(ud, { recursive: true })
  writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
  if (withFiles) {
    mkdirSync(join(vault, 'Work files'))
    writeFileSync(join(vault, 'Work files', 'research-teams-intake.md'), RTI)
    writeFileSync(join(vault, 'Work files', 'session-feedback.md'), SFB)
    writeFileSync(join(vault, 'Work files', 'broken-one.md'), BROKEN)
    mkdirSync(join(vault, 'ai-for-research-teams'))
    writeFileSync(join(vault, 'ai-for-research-teams', 'ai-for-research-teams-outline.md'), ['---', 'title: AI for research teams', 'prework: research-teams-intake', 'postwork: session-feedback', '---', '', '## One', ''].join('\n'))
    createPlannedRun(vault, { talkSlug: 'ai-for-research-teams', talkTitle: 'AI for research teams', plannedDate: '2026-11-02', eventTitle: 'Medical Sciences', slideSet: { kind: 'full' },
      work: { pre: { fileId: 'research-teams-intake', opens: '2026-10-20T09:00', closes: '2026-11-01T09:00' } } }, () => 'med')
  }
  return { vault, ud }
}

async function launch(ud) {
  const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }) }
    catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
  }
}
async function openWorkFiles(app) {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  const pending = app.waitForEvent('window')
  await page.evaluate(() => window.tw.tools.open('workfiles'))
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  await tools.waitForSelector('[data-tools-view="workfiles"]', { timeout: 10_000 })
  return tools
}

{
  const { ud } = makeVault(true)
  const app = await launch(ud)
  try {
    const tools = await openWorkFiles(app)
    tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
    await tools.waitForSelector('[data-wf-row]', { timeout: 10_000 }).catch(() => {})
    const rows = await tools.locator('[data-wf-row]').allTextContents()
    rec('three files listed', rows.length === 3, String(rows.length))
    const rti = tools.locator('[data-wf-row="research-teams-intake.md"]')
    const rtiText = (await rti.textContent()) ?? ''
    rec('row reads the drawn used-by line', rtiText.includes('Used as pre-work in 1 talk · as post-work in 0'), rtiText)
    rec('row shows file name and run count', rtiText.includes('research-teams-intake.md') && rtiText.includes('1 run'))
    const sfbText = (await tools.locator('[data-wf-row="session-feedback.md"]').textContent()) ?? ''
    rec('post-work file reads 0 · 1', sfbText.includes('Used as pre-work in 0 talks · as post-work in 1'), sfbText)
    rec('file with findings says so on its row', ((await tools.locator('[data-wf-row="broken-one.md"] [data-wf-findings-pill]').textContent().catch(() => '')) ?? '').includes('finding'))
    rec('no file is open at first', (await tools.locator('.tw-tools-none').textContent()).includes('No work file selected'))
    if (shotsDir) await tools.screenshot({ path: join(shotsDir, 'wf-list.png') }).catch(() => {})

    await rti.click()
    await tools.waitForSelector('[data-wf-detail="research-teams-intake.md"]', { timeout: 5000 })
    const steps = await tools.locator('[data-wf-step]').allTextContents()
    rec('four steps listed', steps.length === 4, steps.join(' | '))
    rec('step rows show kind, layout and id', steps[0].includes('1 · Watch') && steps[0].includes('Video') && steps[0].includes('id watch') && steps[2].includes('Task · slide, numbered steps') && steps[1].includes('Quick check · 2 options'), steps.join(' | '))
    rec('video and slide steps have thumbnails', await tools.locator('[data-thumb="video"]').count() === 1 && await tools.locator('[data-thumb="slide"]').count() === 1)
    const side = (await tools.locator('.tw-wf-side').textContent()) ?? ''
    rec('used by names the talk and its role', side.includes('AI for research teams') && side.includes('Pre-work, in its metadata'), side)
    rec('used by lists the unsent Run', side.includes('Medical Sciences') && side.includes('Run · pre-work · not sent yet'), side)
    if (shotsDir) await tools.screenshot({ path: join(shotsDir, 'wf-open.png') }).catch(() => {})

    await tools.locator('[data-wf-row="broken-one.md"]').click()
    await tools.waitForSelector('[data-wf-findings]', { timeout: 5000 }).catch(() => {})
    const findings = (await tools.locator('[data-wf-findings]').textContent().catch(() => '')) ?? ''
    rec('findings are listed when the file is open', /layout/i.test(findings) && /table/.test(findings), findings)

    await rti.click()
    await tools.locator('[data-wf-run="ai-for-research-teams/med"] button').click()
    await tools.waitForSelector('[data-tools-view="sessions"][data-run="ai-for-research-teams/med"]', { timeout: 5000 }).catch(() => {})
    rec('Open run opens Sessions on that Run', await tools.locator('[data-tools-view="sessions"][data-run="ai-for-research-teams/med"]').count() === 1)
  } finally { await app.close().catch(() => {}) }
}

{
  const { ud } = makeVault(false)
  const app = await launch(ud)
  try {
    const tools = await openWorkFiles(app)
    await tools.waitForSelector('.tw-tools-empty', { timeout: 8000 }).catch(() => {})
    const body = (await tools.locator('[data-tools-view="workfiles"]').textContent()) ?? ''
    if (shotsDir) await tools.screenshot({ path: join(shotsDir, 'wf-empty.png') }).catch(() => {})
    rec('an empty vault shows the drawn empty state', ['No work files', 'A work file holds the steps of a pre-work or a post-work.', 'No work file selected'].every((t) => body.includes(t)), body.trim().slice(0, 120))
  } finally { await app.close().catch(() => {}) }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
