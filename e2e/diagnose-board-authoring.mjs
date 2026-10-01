// Real-Electron gate for ticket 01 (ADR-0032; round-3 A1–A6): a board slide is written and edited.
// HOST-RUN ONLY, one Electron run at a time: node e2e/diagnose-board-authoring.mjs
//
//   1. Insert › Board slide writes the starter after the current slide, with its question selected
//      (typing replaces it).
//   2. The Inspector never blanks on the board slide; its Board section edits the columns in place
//      (rename, add, reorder by keyboard and by drag, remove), a hint, the instructions, the example
//      card and the settings — and the file on disk reads back exactly that.
//   3. Before a session is live the preview shows the board frame with its columns and "Join link
//      appears when the session is live".
// TW_SHOTS_DIR=<dir> saves a screenshot of the window per state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const FIXTURE = `---
title: Board authoring
outline_version: 2
---

# Board authoring

## Your turn
{id=sec01}

### How confident are you with AI at work?
{poll=rating}{id=pwconf}

[scale: Not yet, A little, Fairly, Very]

- Writing and editing
- Finding sources

### What comes next
{id=next01}

- Something after the board
`
const QUESTION = 'What should we keep, stop, try?'
const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-board-authoring-e2e-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'board-authoring')
mkdirSync(dir, { recursive: true })
const outlinePath = join(dir, 'board-authoring-outline.md')
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
  const boardBlock = () => {
    const text = onDisk()
    const start = text.indexOf(`### ${QUESTION}`)
    if (start < 0) return ''
    const end = text.indexOf('\n### ', start + 4)
    return text.slice(start, end < 0 ? undefined : end).trimEnd()
  }
  const settle = async (ms = 2600) => { await page.waitForTimeout(ms) }

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.locator('.tl-row').first().dblclick()
  await page.waitForTimeout(3000)
  await page.keyboard.press('Meta+p') // Inspector mode
  await page.waitForTimeout(1500)

  // ── 1. Insert › Board slide ─────────────────────────────────────────────────────────────────
  await page.locator('.cm-line', { hasText: 'Finding sources' }).first().click()
  await page.locator('.toolbar-btn', { hasText: 'Insert' }).first().click()
  await page.waitForTimeout(400)
  const item = page.locator('.toolbar-menu-item', { hasText: 'Board slide' })
  rec('Insert menu offers Board slide', await item.count() === 1)
  await shoot('01-insert-menu')
  await item.click()
  await page.waitForTimeout(300)
  await page.keyboard.type(QUESTION)
  // The id is written with the starter (fix S7), so the Board section can edit it before any save.
  const stampedAtInsert = await page.locator('.cm-line', { hasText: /^\{poll=board\}\s*\{id=[a-z0-9]{5}\}$/ }).count()
  rec('the starter carries its id from insertion, before the first save', stampedAtInsert === 1)
  await settle()
  const afterInsert = onDisk()
  rec('the starter follows the current slide, before the next one',
    afterInsert.indexOf('- Finding sources') < afterInsert.indexOf(`### ${QUESTION}`) && afterInsert.indexOf(`### ${QUESTION}`) < afterInsert.indexOf('### What comes next'))
  rec('the question was selected: typing replaced it', afterInsert.includes(`### ${QUESTION}\n{poll=board}`) && !afterInsert.includes('What should we keep, change, try?'))
  rec('the starter carries instructions and three columns with hints', boardBlock().includes('Add what you would keep, change or try. One idea per card; no names are shown.\n\n- Keep\n  - What worked for you?\n- Change\n  - What should be different?\n- Try\n  - What could we do next time?'), boardBlock())
  const stamped = boardBlock().split('\n')[1] ?? ''
  rec('the saved trigger line carries the id and no setting', /^\{poll=board\}\s*\{id=[A-Za-z0-9-]+\}$/.test(stamped), stamped)

  // ── 2. The Inspector's Board section ────────────────────────────────────────────────────────
  const title = async () => ((await page.locator('.tw-inspector-title').textContent()) ?? '').trim()
  for (let wait = 0; wait < 20 && await title() !== QUESTION; wait += 1) await page.waitForTimeout(300)
  rec('the Inspector follows the caret to the board slide', await title() === QUESTION, await title())
  rec('the Inspector does not blank (no unresolved trigger)', await page.locator('.tw-inspector-unresolved').count() === 0)
  const chips = await page.locator('.tw-inspector-jumplist button').allTextContents()
  rec('the section chips include Board', chips.map((chip) => chip.trim()).includes('Board'), JSON.stringify(chips))
  await page.locator('.tw-inspector-jumplist button', { hasText: /^Board$/ }).click()
  await page.waitForTimeout(500)
  await shoot('02-board-section')
  const names = async () => page.locator('.tw-board-column input[aria-label$=" name"]').evaluateAll((inputs) => inputs.map((input) => input.value))
  rec('the columns read from the slide', JSON.stringify(await names()) === JSON.stringify(['Keep', 'Change', 'Try']), JSON.stringify(await names()))

  // Rename in place, typed key by key (every key writes the slide text).
  const third = page.locator('input[aria-label="Column 3 name"]')
  await third.click()
  await page.keyboard.press('End') // the caret is already at the end: End must not scroll the pane
  await page.keyboard.type(' next')
  await page.waitForTimeout(300)
  const editorHasRename = await page.locator('.cm-line', { hasText: /^- Try next$/ }).count()
  rec('rename in place: the editor shows the slide text already changed', editorHasRename === 1)
  await page.waitForTimeout(1500) // the recompile the rename set off
  const inView = await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Column 3 name"]')
    const pane = document.querySelector('.tw-inspector-pane')
    if (!input || !pane) return { ok: false, why: 'missing' }
    const a = input.getBoundingClientRect(); const b = pane.getBoundingClientRect()
    return { ok: document.activeElement === input && a.top >= b.top - 1 && a.bottom <= b.bottom + 1, top: a.top, paneTop: b.top, paneBottom: b.bottom }
  })
  rec('rename in place: the field keeps focus and stays in view through the recompile', inView.ok, JSON.stringify(inView))
  await shoot('03-rename-in-place')

  // Add a column: nothing is written until it has a name; then a name and a hint.
  await page.locator('.tw-board-add button').click()
  await page.waitForTimeout(300)
  rec('add: the new row is empty and focused', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Column 4 name')
  await settle(1800)
  rec('add: nothing is written until the new column has a name', !boardBlock().includes('- \n') && boardBlock().split('\n').filter((line) => /^- /.test(line)).length === 3)
  await page.keyboard.type('Stop')
  await page.locator('input[aria-label="Column 4 hint"]').fill('What should we drop?')
  rec('add: a fourth column is the most', await page.locator('.tw-board-add button').isDisabled())
  await shoot('04-add-column')

  // Reorder: ↑ on the Stop row's handle moves it above Try next; then drag Keep below Change.
  await page.locator('.tw-board-handle[aria-label^="Move column Stop"]').focus()
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(400)
  rec('reorder by keyboard: ↑ moves the column up', JSON.stringify(await names()) === JSON.stringify(['Keep', 'Change', 'Stop', 'Try next']), JSON.stringify(await names()))
  const keepHandle = page.locator('.tw-board-handle[aria-label^="Move column Keep"]')
  const changeRow = page.locator('.tw-board-column').nth(1)
  const rowBox = await changeRow.boundingBox()
  await keepHandle.dragTo(changeRow, { targetPosition: { x: 20, y: Math.max(2, rowBox.height - 4) } })
  await page.waitForTimeout(500)
  rec('reorder by drag: Keep lands below Change', JSON.stringify(await names()) === JSON.stringify(['Change', 'Keep', 'Stop', 'Try next']), JSON.stringify(await names()))
  await shoot('05-reordered')

  // Remove: Change goes, with its hint.
  await page.locator('.tw-board-remove[aria-label="Remove column Change"]').click()
  await page.waitForTimeout(300)
  rec('remove: the column goes', JSON.stringify(await names()) === JSON.stringify(['Keep', 'Stop', 'Try next']), JSON.stringify(await names()))

  // Hint, instructions, example card.
  await page.locator('input[aria-label="Column 1 hint"]').fill('What worked well for you?')
  await page.locator('textarea[aria-label="Instructions"]').fill('One idea per card; no names are shown.')
  await page.locator('.tw-board-toggle button', { hasText: /^On$/ }).click()
  await page.waitForTimeout(200)
  rec('Example On focuses its field', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Example card')
  await page.keyboard.type('More time to try things ourselves')
  await shoot('06-prompt-and-example')

  // Settings: Big screen 36 and Card length 100; the others stay at their defaults.
  await page.locator('[data-group="board-limit"] button', { hasText: /^36$/ }).click()
  await page.waitForTimeout(400)
  await page.locator('[data-group="board-length"] button', { hasText: /^100$/ }).click()
  await page.waitForTimeout(400)
  const triggerRow = ((await page.locator('.tw-board-trigger code').textContent()) ?? '').trim()
  rec('the Trigger line row shows what is written', triggerRow === '{poll=board} {limit=36} {length=100}', triggerRow)
  await shoot('07-settings')

  // ── The file reads back exactly the edits ───────────────────────────────────────────────────
  await settle()
  const block = boardBlock()
  const lines = block.split('\n')
  rec('the trigger line carries only the changed settings, after {poll=board}', /^\{poll=board\}\{limit=36\}\{length=100\}\{id=[A-Za-z0-9-]+\}$/.test(lines[1] ?? ''), lines[1])
  const body = lines.slice(2).join('\n').trim()
  const expected = [
    'One idea per card; no names are shown.',
    '',
    '> Example: More time to try things ourselves',
    '',
    '- Keep',
    '  - What worked well for you?',
    '- Stop',
    '  - What should we drop?',
    '- Try next',
    '  - What could we do next time?'
  ].join('\n')
  rec('the slide body reads back the Board section’s edits', body === expected, JSON.stringify(body))
  rec('the slides around the board are untouched',
    onDisk().includes('- Writing and editing\n- Finding sources\n\n### ' + QUESTION) && onDisk().includes('### What comes next\n{id=next01}\n\n- Something after the board\n'))
  rec('the Inspector still reads the file', JSON.stringify(await names()) === JSON.stringify(['Keep', 'Stop', 'Try next']))

  // A column typed in the editor reaches the Board section (the text is the truth).
  await page.locator('.cm-line', { hasText: /^- Try next$/ }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' time')
  await page.waitForTimeout(1200)
  rec('an edit in the editor shows in the Board section', (await names()).includes('Try next time'), JSON.stringify(await names()))

  // ── 3. The big screen before a session is live ──────────────────────────────────────────────
  await page.waitForTimeout(2500)
  let frame = null
  for (let wait = 0; wait < 20 && !frame; wait += 1) {
    for (const candidate of page.frames()) {
      const found = await candidate.evaluate(() => {
        const section = [...document.querySelectorAll('.poll-frame[data-poll-type="board"]')].find((el) => el.offsetParent !== null) ?? document.querySelector('.poll-frame[data-poll-type="board"]')
        if (!section) return null
        return {
          columns: [...section.querySelectorAll('.poll-frame-board-label')].map((label) => label.textContent),
          join: section.querySelector('.poll-frame-join-note')?.textContent ?? '',
          example: section.querySelector('.poll-frame-board-card.is-example p')?.textContent ?? ''
        }
      }).catch(() => null)
      if (found) { frame = found; break }
    }
    if (!frame) await page.waitForTimeout(500)
  }
  rec('the preview shows the board frame with its columns', JSON.stringify(frame?.columns) === JSON.stringify(['Keep', 'Stop', 'Try next time']), JSON.stringify(frame))
  rec('before a session is live: "Join link appears when the session is live"', frame?.join === 'Join link appears when the session is live', frame?.join)
  rec('the example card is on the empty board', frame?.example === 'More time to try things ourselves', frame?.example)
  await page.locator('.tw-inspector-jumplist button', { hasText: /^Board$/ }).click()
  await page.waitForTimeout(400)
  await shoot('08-preview')
  await page.locator('.tw-board-phone').scrollIntoViewIfNeeded().catch(() => {})
  await page.waitForTimeout(300)
  await shoot('09-phone-preview')
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(failures ? `board authoring e2e: ${failures} failure(s)` : 'board authoring e2e: all checks passed')
process.exit(failures ? 1 : 0)
