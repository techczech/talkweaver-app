// Real-Electron gate for a talk that still has a 0.37 `{prework}` section (ticket 08, reworked by
// work-files ticket 29: pre-work is written in a work file; ADR-0040 decision 6).
// HOST-RUN ONLY, one Electron run at a time: node e2e/diagnose-prework-authoring.mjs
//
//   1. The pre-work tokens never blank the Inspector, and a step of the section gets no "Before the
//      session" section, no step rows and no right-answer select: nothing writes the section.
//   2. Presenting the talk shows no pre-work slide; present from a step starts after the section.
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
  const title = async () => ((await page.locator('.tw-inspector-title').textContent()) ?? '').trim()
  const waitTitle = async (text) => { for (let wait = 0; wait < 25 && await title() !== text; wait += 1) await page.waitForTimeout(300) }
  const chips = async () => (await page.locator('.tw-inspector-jumplist button').allTextContents()).map((chip) => chip.trim())

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.locator('.tl-row').first().dblclick()
  await page.waitForTimeout(3000)
  await page.keyboard.press('Meta+p') // Inspector mode
  await page.waitForTimeout(1500)

  // ── 1. A leftover {prework} section is not written in the Inspector (work-files ticket 29) ──
  for (const [line, heading] of [['Read two short slides', 'Welcome: three things before Monday'], ['It runs on a bigger model', 'Quick check: what makes something an agent?'], ['Pick an email you need to send this week', 'Task 1: draft one real email with Copilot']]) {
    await page.locator('.cm-line', { hasText: line }).first().click()
    await waitTitle(heading)
    rec(`the Inspector follows the caret to “${heading}”`, await title() === heading, await title())
    rec(`${heading}: the Inspector does not blank`, await page.locator('.tw-inspector-unresolved').count() === 0)
    rec(`${heading}: no Pre-work, Check or Pre-task chip`, !(await chips()).some((chip) => ['Pre-work', 'Check', 'Pre-task'].includes(chip)), JSON.stringify(await chips()))
    rec(`${heading}: no Before the session section`, await page.locator('[data-testid="inspector-prework"], [data-testid="prework-right-answer"], [data-testid="prework-nudge"], [data-group^="prework-"]').count() === 0)
  }
  await shoot('1-section-step-no-prework-section')
  rec('no {right} was written by opening a check', !onDisk().includes('{right}'))
  rec('no pre-work token is unresolved anywhere (Layout Doctor clean)', !/Unresolved trigger|Unknown trigger/.test(await page.locator('body').innerText()))

  // ── 2. Presenting leaves the pre-work out ────────────────────────────────────────────────────
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
  // No Run is planned in this test any more (ticket 29 took out the Inspector's Plan a run…), so there is none.
  const runFiles = readdirSync(join(vault, '_PRESENTATIONS', 'agents-now')).filter((name) => name.endsWith('.json') && name !== 'manifest.json')
  rec('no stray Run file from a closed quick peek', runFiles.length === 0, JSON.stringify(runFiles))
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(failures ? `prework authoring e2e: ${failures} failure(s)` : 'prework authoring e2e: all checks passed')
process.exit(failures ? 1 : 0)
