// Onboarding 0.38.1 ticket 03, in the real app: ⌘K opens Actions here at the caret, on the strip and
// on a talk row; a filter with no match plus Return opens the palette with the text kept; Escape
// returns the keyboard; running a row runs the command; right-click opens the same panel; the chip's
// count is the number of rows listed.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle, ensureTalksMode } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Actions Fixture', '---', '', '## Opening', '', '### Four stalls', '', 'Bread and cakes at the first stall.', '', '- Vegetables', '- Plants', '', '### Second slide', '', 'More text.', ''].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-actions-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'actions-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'actions-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const panel = page.locator('[data-actions-here]')
const rowKeys = () => page.$$eval('[data-actions-here-row]', (nodes) => nodes.map((node) => node.getAttribute('data-actions-here-row')))
const chipCount = async () => {
  const text = await page.locator('[data-testid="status-place"]').innerText()
  return Number((text.match(/(\d+) actions?/) ?? [])[1])
}
const gone = async () => page.waitForSelector('[data-actions-here]', { state: 'detached', timeout: 3000 }).then(() => true).catch(() => false)

try {
  await openTalkByTitle(page, 'Actions Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  const line = (text) => page.locator('.cm-content .cm-line', { hasText: text }).first()

  // 1. ⌘K on a slide heading lists heading actions, in task groups, and the chip counts them.
  await line('### Four stalls').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="status-place"]')?.getAttribute('data-place') === 'slide-heading', null, { timeout: 4000 })
  const expected = await chipCount()
  await page.keyboard.press('Meta+k')
  await panel.waitFor({ timeout: 4000 })
  const headingRows = await rowKeys()
  record('⌘K on a heading opens one panel titled Actions here with heading actions',
    headingRows.includes('promote-heading') && headingRows.includes('layout') && headingRows.includes('where-used') && headingRows.includes('explain-rendering') && !headingRows.includes('new-slide'),
    `rows=${headingRows.length}`)
  record('the chip count is the number of rows listed', expected === headingRows.length, `chip=${expected} rows=${headingRows.length}`)
  const groups = await page.$$eval('.actions-here-group', (nodes) => nodes.map((node) => node.textContent))
  record('rows sit under task-group headings in order', groups[0] === 'Write the outline' && groups.includes('Build a slide') && groups.indexOf('Build a slide') < groups.indexOf('Reuse slides'), groups.join(' | '))
  const lastLabel = await page.locator('[data-actions-here-all]').innerText()
  record('the last row is "All commands… ⇧⌘P"', /All commands…\s*⇧⌘P/.test(lastLabel.replace(/\s+/g, ' ')), JSON.stringify(lastLabel))
  const small = await panel.evaluate((node) => { const r = node.getBoundingClientRect(); return { w: r.width, centred: Math.abs(r.left + r.width / 2 - window.innerWidth / 2) < 40 } })
  record('the panel is small and at the caret, not a centred dialog', small.w <= 420 && !small.centred, JSON.stringify(small))

  const iconless = await page.$$eval('[data-actions-here-row], [data-actions-here-all]', (nodes) => nodes.filter((n) => !n.querySelector('.actions-here-icon svg.lucide')).map((n) => n.getAttribute('data-actions-here-row') ?? 'all'))
  record('every row carries a lucide icon (owner check 10 Oct)', iconless.length === 0, iconless.join(', '))
  const universal = await page.$$eval('[data-actions-here-row]', (nodes) => nodes.map((n) => n.getAttribute('data-actions-here-row')).filter((k) => ['cut', 'copy', 'paste', 'undo', 'redo', 'select-all'].includes(k)))
  record('no Cut, Copy, Paste, Undo, Redo or Select all at a heading', universal.length === 0, universal.join(', '))

  // 2. Escape returns the keyboard to the caret.
  await page.keyboard.press('Escape')
  const closed = await gone()
  const focusBack = await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-content')))
  record('Escape closes the panel and returns focus to the editor', closed && focusBack, `closed=${closed} focusInEditor=${focusBack}`)

  // 3. No match: the drawn words; Return opens the palette with the text kept.
  await page.keyboard.press('Meta+k')
  await panel.waitFor({ timeout: 4000 })
  await page.keyboard.type('publish')
  const emptyText = await page.locator('[data-actions-here-empty]').innerText().catch(() => '')
  const allActive = await page.locator('[data-actions-here-all]').getAttribute('data-active')
  record('a filter with no match reads No “publish” action here, All commands… highlighted', emptyText === 'No “publish” action here' && allActive === 'true', JSON.stringify(emptyText))
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-command-menu]', { timeout: 4000 })
  const kept = await page.locator('.command-menu-input').inputValue()
  record('Return opens the palette with “publish” kept', kept === 'publish', JSON.stringify(kept))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-command-menu]', { state: 'detached', timeout: 3000 }).catch(() => {})

  // 4. Running a row runs the command, from the keyboard alone: filter, arrow, Return.
  await line('Bread and cakes').click()
  await page.keyboard.press('Meta+k')
  await panel.waitFor({ timeout: 4000 })
  await page.keyboard.type('numbered')
  await page.keyboard.press('Enter')
  await gone()
  const ran = await page.locator('.cm-content .cm-line', { hasText: 'Bread and cakes' }).first().innerText()
  record('Return on a filtered row runs it (Numbered list)', /^1[.)]\s/.test(ran.trim()) || ran.includes('1.'), JSON.stringify(ran))

  // 5. In a list: the list actions; the old context menu's rows are still there.
  await line('Vegetables').click()
  await page.keyboard.press('Meta+k')
  await panel.waitFor({ timeout: 4000 })
  const listRows = await rowKeys()
  record('in a list ⌘K offers the list actions and keeps Delete and the formats, and no longer lists Cut, Copy, Paste',
    ['editor.promote-subtree', 'delete-slide', 'format-bold', 'insert-object-table', 'present-from-here'].every((key) => listRows.includes(key)) && !['cut', 'copy', 'paste'].some((key) => listRows.includes(key)), `rows=${listRows.length}`)
  await page.keyboard.press('Escape')
  await gone()

  // 6. Right-click opens the same panel.
  await line('Second slide').click({ button: 'right' })
  let rightClicked = false
  try { await panel.waitFor({ timeout: 3000 }); rightClicked = true } catch { /* not opened */ }
  const rightRows = rightClicked ? await rowKeys() : []
  record('right-click in the editor opens Actions here', rightClicked && rightRows.includes('promote-heading'), `rows=${rightRows.length}`)
  await page.keyboard.press('Escape')
  await gone()

  // 7. The strip: ⌘K with a slide card focused, and right-click on a card.
  const card = page.locator('[data-place-region="strip"] [data-slide-index]').first()
  await card.waitFor({ timeout: 5000 })
  await card.click({ button: 'right' })
  let stripOpened = false
  try { await panel.waitFor({ timeout: 3000 }); stripOpened = true } catch { /* not opened */ }
  const stripRows = stripOpened ? await rowKeys() : []
  record('right-click on a slide card opens Actions here with Explain rendering', stripOpened && stripRows.includes('explain-rendering') && stripRows.includes('focus-slide'), `rows=${stripRows.length}`)
  await page.keyboard.press('Escape')
  await gone()

  // 8. A talk row: ⌘K offers what the old row menu offered.
  await ensureTalksMode(page)
  const row = page.locator('aside.talk-list.tl-panel .tl-tree [data-talk-title="Actions Fixture"]').first()
  await row.click({ button: 'right' })
  let talkOpened = false
  try { await panel.waitFor({ timeout: 3000 }); talkOpened = true } catch { /* not opened */ }
  const talkRows = talkOpened ? await rowKeys() : []
  const OLD = ['browser.open-talk', 'open-in-new-window', 'browser.rename', 'browser.move-talk', 'browser.duplicate', 'talk.metadata', 'talk.reveal', 'talk.open-file', 'talk.copy-path', 'browser.delete-talk']
  record('a talk row opens Actions here with every row the old row menu had', talkOpened && OLD.every((key) => talkRows.includes(key)), `rows=${talkRows.join(',')}`)
  await page.keyboard.press('Escape')
  await gone()
  await page.locator('aside.talk-list.tl-panel').first().focus()
  await page.keyboard.press('Meta+k')
  let talkKey = false
  try { await panel.waitFor({ timeout: 3000 }); talkKey = true } catch { /* not opened */ }
  record('⌘K with the Talks panel focused opens it for the focused row', talkKey)
  await page.keyboard.press('Escape')
} catch (e) {
  record('actions-here harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== ACTIONS HERE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
