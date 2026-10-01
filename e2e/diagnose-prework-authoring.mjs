// Real-Electron gate for ticket 08 (ADR-0032 amendment point 5; round-2 E1–E4, round-3 P5): a
// talk's pre-work is written in the Inspector, and presenting leaves it out.
// HOST-RUN ONLY, one Electron run at a time: node e2e/diagnose-prework-authoring.mjs
//
//   1. The pre-work tokens never blank the Inspector; a step's "Before the session" section says
//      what the slide is, lists the form's steps and, with no Run planned, nudges to plan one (P5).
//   2. Plan a run… opens the plan sheet; once saved, the form shows its opening, closing and Run (E1).
//   3. The quick check's right answer is chosen in the Inspector and lands on the option (E2).
//   4. A pre-task's Mark as done and time, and questions off, write their tokens (E3).
//   5. A talk slide's {results=…} names a step, chosen from the steps (E4).
//   6. Presenting the talk shows no pre-work slide.
// TW_SHOTS_DIR=<dir> saves a screenshot of the window per state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const FIXTURE = `---
title: The current state of AI agents
outline_version: 2
---

# The current state of AI agents

## Where we are
{id=where}

### What changed this year
{id=changed}

- Agents act, chats answer

## Before the session
{id=pwform}{prework}

Five short steps: two slides, a quick check, a question and a task. About 20 minutes in all.

### Welcome: three things before Monday
{id=pwwelcome}

- Read two short slides
- Answer two quick questions
- Try a small task and mark it done

### What an agent is, in one slide
{id=pwagent}

- A chat answers: you copy the result into your work
- An agent acts: it opens files and tools and does the steps

### Quick check: what makes something an agent?
{poll=single}{id=pwquiz}{check}

- It answers questions in full sentences
- It uses tools to carry out steps for you
- It runs on a bigger model
- Not sure yet

### What AI tools do you already use?
{poll=multiple}{id=pwtools}

- ChatGPT
- Microsoft Copilot
- None yet

### Task 1: draft one real email with Copilot
{id=pwtask1}{task}

- Pick an email you need to send this week
- Ask Copilot to draft it from your notes
- Write down one thing it got wrong

## Your turn
{id=fbsec}

### What AI tools do you already use?
{id=r1tools}{results=pwtools}

- The room adds to the answers from before the session

### What comes next
{id=next01}

- Something after the pre-work
`
const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-prework-authoring-e2e-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'agents-now')
mkdirSync(dir, { recursive: true })
mkdirSync(join(vault, '_PRESENTATIONS', 'agents-now'), { recursive: true })
const outlinePath = join(dir, 'agents-now-outline.md')
writeFileSync(outlinePath, FIXTURE)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
await ensureFreshBuild(process.cwd())

// A launch timeout is contention with other builders' Electron runs: wait and retry (three tries).
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try {
    app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env: { ...process.env, TW_E2E: '1' }, timeout: 60_000 })
  } catch (error) {
    console.log(`[e2e] launch attempt ${attempt} failed: ${String(error?.message ?? error).slice(0, 120)}`)
    if (attempt === 3) throw error
    await new Promise((resolve) => setTimeout(resolve, 20_000))
  }
}
let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const plusDays = (n) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  const shoot = async (name) => {
    if (!shotsDir) return
    await page.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {})
  }
  const onDisk = () => readFileSync(outlinePath, 'utf8')
  const lineAfter = (heading) => {
    const lines = onDisk().split('\n')
    return lines[lines.findIndex((line) => line === heading) + 1] ?? ''
  }
  const settle = async (ms = 2600) => { await page.waitForTimeout(ms) }
  const title = async () => ((await page.locator('.tw-inspector-title').textContent()) ?? '').trim()
  const waitTitle = async (text) => { for (let wait = 0; wait < 25 && await title() !== text; wait += 1) await page.waitForTimeout(300) }
  const openSection = async (chip) => {
    await page.locator('.tw-inspector-jumplist button', { hasText: new RegExp(`^${chip}$`) }).click()
    await page.waitForTimeout(500)
  }
  const chips = async () => (await page.locator('.tw-inspector-jumplist button').allTextContents()).map((chip) => chip.trim())

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.locator('.tl-row').first().dblclick()
  await page.waitForTimeout(3000)
  await page.keyboard.press('Meta+p') // Inspector mode
  await page.waitForTimeout(1500)

  // ── 1. A slide step, no Run planned (E1, P5) ─────────────────────────────────────────────────
  await page.locator('.cm-line', { hasText: 'Read two short slides' }).first().click()
  await waitTitle('Welcome: three things before Monday')
  rec('the Inspector follows the caret to the first step', await title() === 'Welcome: three things before Monday', await title())
  rec('the Inspector does not blank on a pre-work step', await page.locator('.tw-inspector-unresolved').count() === 0)
  rec('the Pre-work chip comes last', (await chips()).at(-1) === 'Pre-work', JSON.stringify(await chips()))
  await openSection('Pre-work')
  const section = page.locator('[data-testid="inspector-prework"]')
  rec('This slide says what the step is', (await section.locator('[data-testid="prework-this-slide"]').innerText()).includes('Step 1 of 5: a slide with instructions'))
  rec('the form lists its five steps with kinds', JSON.stringify(await section.locator('.tw-prework-steps small').allTextContents()) === JSON.stringify(['· Slide', '· Slide', '· Quick check', '· Question', '· Pre-task']))
  rec('the current step is marked', (await section.locator('.tw-prework-steps [aria-current="step"]').innerText()).includes('Welcome'))
  rec('P5: no Run planned — the nudge says so', (await section.locator('[data-testid="prework-nudge"]').innerText()).includes('Pre-work needs a planned Run.'))
  rec('the status bar nudges too', await page.locator('[data-testid="status-run-nudge"]').count() === 1)
  await shoot('P5-prework-needs-a-run')

  // Questions about it: Off writes {noask}; On removes it.
  await section.locator('[data-group="prework-ask"] button', { hasText: /^Off$/ }).click()
  await settle()
  rec('Questions Off writes {noask}', lineAfter('### Welcome: three things before Monday') === '{id=pwwelcome} {noask}', lineAfter('### Welcome: three things before Monday'))
  await section.locator('[data-group="prework-ask"] button', { hasText: /^On$/ }).click()
  await settle()
  rec('Questions On writes nothing', lineAfter('### Welcome: three things before Monday') === '{id=pwwelcome}', lineAfter('### Welcome: three things before Monday'))

  // ── 2. Plan a run… from the nudge ────────────────────────────────────────────────────────────
  await section.locator('[data-testid="prework-plan-run"]').click()
  const sheet = page.locator('[data-testid="plan-run-sheet"]')
  await sheet.waitFor()
  rec('Plan a run… opens the plan sheet with pre-work on', await sheet.locator('[data-field="prework-toggle"]').getAttribute('aria-checked') === 'true')
  await sheet.locator('[data-field="event"]').fill('ITSS Briefing, October')
  await sheet.locator('[data-field="date"]').fill(plusDays(6))
  await sheet.locator('[data-testid="plan-run-save"]').click()
  await sheet.waitFor({ state: 'detached' })
  await page.locator('[data-testid="prework-window"]').waitFor({ timeout: 10_000 }).catch(() => {})
  const windowText = await section.locator('[data-testid="prework-window"]').innerText().catch(() => '')
  rec('E1: the form shows its opening, closing and Run', /Opens[\s\S]*Closes[\s\S]*when the talk starts[\s\S]*Run[\s\S]*ITSS Briefing, October/.test(windowText), JSON.stringify(windowText))
  rec('the nudge is gone', await section.locator('[data-testid="prework-nudge"]').count() === 0)
  await shoot('E1-prework-section-slide')

  // ── 3. The quick check (E2) ─────────────────────────────────────────────────────────────────
  await section.locator('.tw-prework-steps button', { hasText: 'Quick check' }).click()
  await waitTitle('Quick check: what makes something an agent?')
  rec('a step in the form opens that step', await title() === 'Quick check: what makes something an agent?', await title())
  rec('the check’s chip is Check', (await chips()).includes('Check'), JSON.stringify(await chips()))
  await openSection('Check')
  const right = page.locator('[data-testid="prework-right-answer"]')
  rec('no right answer yet: the select asks for one', (await right.inputValue()) === '-1')
  const warningTitle = await page.locator('.tw-inspector-warning').first().getAttribute('title').catch(() => '')
  rec('the Inspector warns the check has no right answer', (warningTitle ?? '').includes('has no right answer'), warningTitle)
  await right.selectOption('1')
  await settle()
  rec('choosing the right answer marks that option in the file', onDisk().includes('- It uses tools to carry out steps for you {right}\n') && onDisk().split('{right}').length === 2)
  await page.waitForTimeout(800)
  rec('the Inspector reads it back', (await right.inputValue()) === '1')
  await right.selectOption('3')
  await settle()
  rec('choosing another moves the marker', onDisk().includes('- Not sure yet {right}\n') && onDisk().split('{right}').length === 2)
  await right.selectOption('1')
  await settle()
  await openSection('Check')
  await shoot('E2-prework-quick-check')
  // The room never sees the marker: the Inspector's own preview (the compiled deck) has none.
  let markerInPreview = false
  for (const frame of page.frames().filter((candidate) => candidate !== page.mainFrame())) {
    if (await frame.evaluate(() => document.body?.innerHTML.includes('{right}')).catch(() => false)) markerInPreview = true
  }
  rec('the compiled preview never shows {right}', !markerInPreview)

  // ── 4. The pre-task (E3) ────────────────────────────────────────────────────────────────────
  await page.locator('.tw-prework-steps button', { hasText: 'Task 1' }).click()
  await waitTitle('Task 1: draft one real email with Copilot')
  await openSection('Pre-task')
  const task = page.locator('[data-testid="inspector-prework"]')
  const participants = task.locator('[data-group="prework-participants"] button')
  rec('E3: a bare {task} lights Mark as done', /Mark as done/.test(await task.locator('[data-group="prework-participants"] button[aria-pressed="true"], [data-group="prework-participants"] button.is-selected, [data-group="prework-participants"] button[aria-checked="true"]').first().innerText().catch(() => '')))
  await participants.filter({ hasText: 'Read only' }).click()
  await settle()
  rec('Read only writes {readonly} after {task}', lineAfter('### Task 1: draft one real email with Copilot') === '{id=pwtask1}{task}{readonly}', lineAfter('### Task 1: draft one real email with Copilot'))
  await participants.filter({ hasText: 'Mark as done' }).click()
  await settle()
  await task.locator('[data-group="prework-minutes"] button', { hasText: '20 min' }).click()
  await settle()
  rec('Mark as done writes nothing; 20 min writes {minutes=20} after {task}', lineAfter('### Task 1: draft one real email with Copilot') === '{id=pwtask1}{task}{minutes=20}', lineAfter('### Task 1: draft one real email with Copilot'))
  rec('In the talk names the results token', (await task.innerText()).includes('{results=pwtask1}'))
  await openSection('Pre-task')
  await shoot('E3-prework-task')

  // ── 5. A talk slide showing a step's answers (E4) ─────────────────────────────────────────────
  await page.locator('.cm-line', { hasText: 'The room adds to the answers' }).first().click()
  await waitTitle('What AI tools do you already use?')
  rec('the results slide’s chip is Results', (await chips()).at(-1) === 'Results', JSON.stringify(await chips()))
  await openSection('Results')
  const shows = page.locator('[data-testid="prework-results"]')
  rec('Shows names the step', (await shows.locator('option:checked').textContent()) === 'Before the session › 4 · What AI tools do you already use?')
  await shows.selectOption('results=pwquiz')
  await settle()
  rec('choosing another step rewrites {results=…}', lineAfter('### What AI tools do you already use?').includes('{results=pwquiz}') || onDisk().includes('{id=r1tools} {results=pwquiz}'), onDisk().match(/\{id=r1tools\}.*/)?.[0])
  await shows.selectOption('results=pwtools')
  await settle()
  await openSection('Results')
  await shoot('E4-talk-slide-shows-prework')
  rec('no pre-work token is unresolved anywhere (Layout Doctor clean)', !/Unresolved trigger|Unknown trigger/.test(await page.locator('body').innerText()))

  // ── 6. Presenting leaves the pre-work out ────────────────────────────────────────────────────
  const deckPromise = app.waitForEvent('window', { timeout: 30_000 })
  const presented = await page.evaluate(async ({ path, content }) => window.tw.talk.present(path, content, 'window'), { path: outlinePath, content: onDisk() })
  rec('the talk presents', presented?.success === true, JSON.stringify(presented))
  const deck = await deckPromise
  await deck.waitForSelector('#stage .slide', { state: 'attached', timeout: 30_000 })
  const presentedIds = await deck.evaluate(() => [...document.querySelectorAll('#stage > .slide, #stage .slide[data-id]')].map((node) => node.dataset.id))
  const preworkIds = ['pwform', 'pwwelcome', 'pwagent', 'pwquiz', 'pwtools', 'pwtask1']
  rec('the presented deck has no pre-work slide', presentedIds.length > 0 && presentedIds.every((id) => !preworkIds.includes(id)), JSON.stringify(presentedIds))
  rec('the talk’s own slides are all there', ['changed', 'r1tools', 'next01'].every((id) => presentedIds.includes(id)), JSON.stringify(presentedIds))
  const beats = await deck.evaluate(() => (window.__deckBeats || []).map((beat) => beat.slideId))
  rec('the presented sequence has no pre-work beat', beats.length > 0 && beats.every((id) => !preworkIds.includes(id)), JSON.stringify(beats))
  await deck.evaluate(() => window.close()).catch(() => {})
  await page.waitForTimeout(1500)
  for (const window_ of app.windows()) if (window_ !== page) await window_.close().catch(() => {})

  // Fix round S4: present from here on a pre-work step starts at the first talk slide after it.
  const hereDeckPromise = app.waitForEvent('window', { timeout: 30_000 })
  const fromHere = await page.evaluate(async ({ path, content }) => window.tw.talk.present(path, content, 'window', 'pwquiz'), { path: outlinePath, content: onDisk() })
  rec('present from a pre-work step succeeds', fromHere?.success === true, JSON.stringify(fromHere))
  const hereDeck = await hereDeckPromise
  await hereDeck.waitForSelector('#stage .slide', { state: 'attached', timeout: 30_000 })
  await hereDeck.waitForTimeout(1500)
  const here = await hereDeck.evaluate(() => ({ hash: decodeURIComponent(location.hash.slice(1)), notice: document.querySelector('[data-prework-notice]')?.textContent ?? '' }))
  rec('it starts at the first talk slide after the pre-work', here.hash === 'fbsec', JSON.stringify(here))
  rec('the status line says why', here.notice === 'Pre-work is answered before the session and is not presented; starting at “Your turn”.', here.notice)
  await hereDeck.evaluate(() => window.close()).catch(() => {})
  await page.waitForTimeout(1500)
  for (const window_ of app.windows()) if (window_ !== page) await window_.close().catch(() => {})
  rec('no stray Run file from a closed quick peek', readdirSync(join(vault, '_PRESENTATIONS', 'agents-now')).filter((name) => name.endsWith('.json') && name !== 'manifest.json').length === 1)
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(failures ? `prework authoring e2e: ${failures} failure(s)` : 'prework authoring e2e: all checks passed')
process.exit(failures ? 1 : 0)
