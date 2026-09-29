// Select section and the ACROSS buttons (Dominik's 0.34.0-preview.8 check, 28 Sep), end to end in the
// built app. The source talk "Agents in practice" is never open in the editor.
//
//   1. A query typed straight after the session's first opening of the picker leaves one slide of
//      § More practical examples showing. Its heading reads "Select section · 4 slides"; a click
//      selects all 4 (heading slide included, from the whole talk), inserts nothing, and the picker
//      stays open.
//   1b. ⌘↵ straight away, the search still on: the file gets the whole section in talk order.
//   1c. The same selection with no search: the file is byte-identical.
//   2. With no query, all 4 cards show selected; a click takes one out (3 left, the heading
//      button no longer pressed). ⌘↵ inserts the 3 at the caret, in source order, headings as they
//      are in the source (⌘↵'s insert is unchanged by this fix), one ⌘Z removes them.
//   3. ⇧⌘↵ on a focused slide of § Closing words selects that section's 2 slides.
//   4. ACROSS 2–6: every button sits outside the window's drag region (the editor toolbar under the
//      picker is one, and Chromium's drag shape ignores what covers it, so a real click there moved
//      the window instead of pressing the button); a click on each sets that density, only it is
//      pressed, and the grid follows.
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { pickerTalkRow } from './lib/picker-tree.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-select-section-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
let edited = 0
function writeTalk(rel, slug, text) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${slug}-outline.md`)
  writeFileSync(file, text)
  const at = new Date(Date.now() - 3600_000 * ++edited)
  utimesSync(file, at, at)
  return file
}

const HEAD = ['## More practical examples', '{id=mpe01}', '', 'Why these examples matter.'].join('\n')
const WHAT = ['### What you can do with this', '{id=wyc01}', '', 'Plenty.'].join('\n')
const FOLLOW = ['### Follow-up prompts', '{id=fup01}', '', 'Ask again.'].join('\n')
const YORK = ['#### York expenses: from email to completed forms', '{id=york1}', '', '- one', '- two'].join('\n')
const sourceText = [
  '---', 'outline_version: 2', 'title: Agents in practice', '---', '',
  '## Opening', '{id=open1}', '', '### Hello', '{id=hel01}', '', 'Hello.', '',
  HEAD, '', WHAT, '', FOLLOW, '', YORK, '', '',
  '## Closing words', '{id=close}', '', '### Thanks', '{id=thx01}', '', 'Thanks.', '',
].join('\n')
writeTalk('agents-presentations', 'agents-in-practice', sourceText)
const working = [
  '---', 'outline_version: 2', 'title: Working talk', '---', '',
  '## A new section', '{id=ans01}', '',
  '### Test html', '{id=tht01}', '',
  '## About me', '{id=abt01}', '',
  '### AI Trends Tracking', '{id=trd01}', '', 'Trends.', '',
].join('\n')
const workingFile = writeTalk('drafts', 'working-talk', working)
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const shots = process.env.TW_SHOTS
if (shots) mkdirSync(shots, { recursive: true })
await ensureFreshBuild(resolve('.'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: resolve('.'), env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
})
const page = await app.firstWindow()
page.setDefaultTimeout(10000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.setViewportSize({ width: 1512, height: 948 }).catch(() => {})

const B = '.lt-browser-root'
const readBuffer = () => page.evaluate(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString() ?? null)
const waitBuffer = (text) => page.waitForFunction((t) => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString() === t, text, { timeout: 10000 })
const setCaret = (offset) => page.evaluate((at) => {
  const view = document.querySelector('.cm-content')?.cmTile?.root?.view
  view.dispatch({ selection: { anchor: at } })
  return view.state.selection.main.head
}, offset)
async function waitForFile(file, want, ms = 10000) {
  const until = Date.now() + ms
  let now = readFileSync(file, 'utf8')
  while (Date.now() < until && now !== want) { await page.waitForTimeout(150); now = readFileSync(file, 'utf8') }
  return now
}
const settle = () => page.waitForFunction(() => !/searching/.test(document.querySelector('.lt-browser-root .lt-topbar')?.textContent ?? ''), null, { timeout: 15000 })
const selSec = (name) => page.locator(`${B} .lt-sec-head`, { hasText: name }).locator('.lt-sel-sec')
const trayCount = async () => (await page.locator(`${B} .lt-tray .lt-n`).count()) ? Number(await page.locator(`${B} .lt-tray .lt-n`).textContent()) : 0
const selectedTitles = () => page.locator(`${B} .lt-card.selected .lt-l-title`).allTextContents()
// After a ⌘↵: the talk as saved (waits for the save), checked to equal the editor, and the text put in
// at the caret — the talk around the caret untouched. ⌘↵'s insert is unchanged by these fixes: the
// slides go in with the caret insert's own blank-line padding, so the insert is read between the
// two untouched halves of the talk.
async function insertedAtCaret(caret) {
  const [before, after] = [working.slice(0, caret), working.slice(caret)]
  await page.waitForFunction((t) => (document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString() ?? '') !== t, working)
  const buffer = await readBuffer()
  const onDisk = await waitForFile(workingFile, buffer) // polls past a save caught mid-write
  assert.equal(onDisk, buffer, 'the file holds what the editor holds')
  assert.ok(onDisk.startsWith(before) && onDisk.endsWith(after), 'the talk around the caret is untouched')
  return { file: onDisk, inserted: onDisk.slice(before.length, onDisk.length - after.length).trim() }
}
async function undoInsert() {
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Meta+z')
  await waitBuffer(working)
  assert.equal(await waitForFile(workingFile, working), working, 'one ⌘Z removes the insert; the file follows')
}
async function pickerOnSource() {
  await page.keyboard.press('Meta+s')
  await page.locator(B).waitFor()
  await settle()
  await (await pickerTalkRow(page, 'agents-in-practice')).click()
  await selSec('More practical examples').waitFor()
}
async function closePicker() {
  for (let i = 0; i < 6 && await page.locator(B).count(); i += 1) { await page.keyboard.press('Escape'); await page.waitForTimeout(200) }
  await page.locator(B).waitFor({ state: 'detached' })
}
// Whether (x, y) falls in the window's drag region as Chromium builds it: every box with an
// -webkit-app-region, in document order, a later no-drag cutting out of an earlier drag — whatever
// is painted on top.
const draggableAt = (x, y) => page.evaluate(([px, py]) => {
  let drag = false
  for (const el of document.querySelectorAll('*')) {
    const region = getComputedStyle(el).getPropertyValue('-webkit-app-region')
    if (region !== 'drag' && region !== 'no-drag') continue
    for (const r of el.getClientRects()) {
      if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) drag = region === 'drag'
    }
  }
  return drag
}, [x, y])

try {
  await openTalkByTitle(page, 'Working talk')
  await waitBuffer(working)
  const caret = working.indexOf('{id=tht01}') + '{id=tht01}'.length
  assert.equal(await setCaret(caret), caret)

  // ── 1. a query typed at once leaves one slide showing; Select section takes the whole section ──
  await page.keyboard.press('Meta+s')
  await page.locator(B).waitFor()
  await page.waitForFunction(() => document.activeElement?.matches?.('.lt-browser-root .lt-searchfield input') ?? false, null, { timeout: 5000 })
  await page.keyboard.type('York expenses') // inside the debounce: the unqueried search never lands
  await settle()
  await (await pickerTalkRow(page, 'agents-in-practice')).click()
  await selSec('More practical examples').waitFor()
  await page.waitForFunction(() => {
    const head = [...document.querySelectorAll('.lt-browser-root .lt-sec-head')].find((e) => /More practical examples/.test(e.textContent ?? ''))
    return /Select section · 4 slides/.test(head?.textContent ?? '')
  }, null, { timeout: 10000 }).catch(() => {})
  assert.equal((await selSec('More practical examples').textContent())?.trim(), 'Select section · 4 slides', 'the heading names the whole section')
  assert.equal(await page.locator(`${B} .lt-card:not(.skeleton)`).count(), 1, 'the query left one slide showing')
  assert.equal(await page.locator(`${B} .lt-ins-sec`).count(), 0, 'no heading offers Insert section any more')
  await selSec('More practical examples').click()
  await page.waitForTimeout(300)
  assert.equal(await page.locator(B).count(), 1, 'the picker stays open')
  assert.equal(await trayCount(), 4, 'all 4 slides of the section are selected, not only the one showing')
  assert.equal(await selSec('More practical examples').getAttribute('aria-pressed'), 'true', 'the button shows the whole section selected')
  assert.equal(await readBuffer(), working, 'nothing was inserted')
  console.log('PASS Select section: the whole section (4) is selected though one slide shows; nothing inserted')

  // ── 1b. ⌘↵ straight away, the search still showing one slide: the section goes in in talk order ──
  const SECTION = [HEAD, WHAT, FOLLOW, YORK].join('\n\n')
  await page.keyboard.press('Meta+Enter')
  await page.locator(B).waitFor({ state: 'detached' })
  await page.waitForFunction(() => /Inserted 4 slides/.test(document.querySelector('[role="status"]')?.textContent ?? ''))
  const withSearch = await insertedAtCaret(caret)
  assert.equal(withSearch.inserted, SECTION, '⌘↵ with a search showing one slide: the whole section, heading slide first, in talk order')
  await undoInsert()
  console.log('PASS ⌘↵ after Select section with a search active: the section goes in in its order')

  // ── 1c. the same selection with no search: byte for byte the same talk ──
  assert.equal(await setCaret(caret), caret)
  await pickerOnSource()
  await selSec('More practical examples').click()
  await page.waitForFunction(() => document.querySelectorAll('.lt-browser-root .lt-card.selected').length === 4, null, { timeout: 10000 })
  await page.keyboard.press('Meta+Enter')
  await page.locator(B).waitFor({ state: 'detached' })
  const noSearch = await insertedAtCaret(caret)
  assert.equal(noSearch.file, withSearch.file, 'the talk is byte-identical whether or not a search was active')
  await undoInsert()
  console.log('PASS the same selection inserts byte-identical text with and without a search')

  // ── 2. every card selected; one taken out; ⌘↵ inserts the rest in order ──
  assert.equal(await setCaret(caret), caret)
  await pickerOnSource()
  await selSec('More practical examples').click()
  await page.waitForFunction(() => document.querySelectorAll('.lt-browser-root .lt-card.selected').length === 4, null, { timeout: 10000 })
  assert.deepEqual(await selectedTitles(), ['More practical examples', 'What you can do with this', 'Follow-up prompts', 'York expenses: from email to completed forms'],
    'the four selected cards: the heading slide and every slide under it')
  if (shots) { await page.waitForTimeout(1000); await page.screenshot({ path: join(shots, 'select-section-whole-section-selected.png') }) }
  await page.locator(`${B} .lt-card.selected`, { hasText: 'Follow-up prompts' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.lt-browser-root .lt-card.selected').length === 3)
  assert.equal(await trayCount(), 3, 'one click takes a single slide out')
  assert.equal(await selSec('More practical examples').getAttribute('aria-pressed'), 'false', 'the button is no longer pressed')
  if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: join(shots, 'select-section-one-slide-taken-out.png') }) }
  await page.keyboard.press('Meta+Enter')
  await page.locator(B).waitFor({ state: 'detached' })
  await page.waitForFunction(() => /Inserted 3 slides/.test(document.querySelector('[role="status"]')?.textContent ?? ''))
  assert.equal((await insertedAtCaret(caret)).inserted, [HEAD, WHAT, YORK].join('\n\n'),
    '⌘↵ put the three slides at the caret in source order, each as in its source (levels unchanged)')
  await undoInsert()
  console.log('PASS unselect + ⌘↵: 3 slides inserted at the caret in order, levels as in the source; one ⌘Z removes them')

  // ── 3. ⇧⌘↵ on a focused slide selects its whole section ──
  await page.keyboard.press('Meta+s')
  await page.locator(B).waitFor()
  await settle()
  await (await pickerTalkRow(page, 'agents-in-practice')).click()
  await selSec('Closing words').waitFor()
  const thanks = page.locator(`${B} .lt-card`, { hasText: 'Thanks' }).first()
  if (await page.evaluate(() => document.activeElement?.tagName === 'INPUT')) await page.keyboard.press('ArrowDown')
  await thanks.hover()
  await page.waitForFunction(() => [...document.querySelectorAll('.lt-browser-root .lt-card.focused')].some((e) => /Thanks/.test(e.textContent ?? '')))
  await page.keyboard.press('Meta+Shift+Enter')
  await page.waitForFunction(() => document.querySelectorAll('.lt-browser-root .lt-card.selected').length === 2)
  assert.deepEqual(await selectedTitles(), ['Closing words', 'Thanks'], '⇧⌘↵ selects the focused slide’s section, heading slide included')
  assert.equal(await selSec('Closing words').getAttribute('aria-pressed'), 'true')
  assert.equal(await readBuffer(), working, 'and inserts nothing')
  console.log('PASS ⇧⌘↵: the focused slide’s whole section is selected')

  // ── 4. ACROSS 2–6 ──
  const steps = page.locator(`${B} .lt-topbar .lt-density .lt-steps button`)
  assert.equal(await steps.count(), 5)
  const toolbarRegion = await page.locator('.workspace-toolbar').first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
  assert.equal(toolbarRegion, 'drag', 'the editor toolbar under the picker is a drag region (the probe reads it)')
  for (const d of [2, 3, 4, 5, 6]) {
    const btn = steps.filter({ hasText: String(d) })
    const box = await btn.boundingBox()
    assert.equal(await draggableAt(box.x + box.width / 2, box.y + box.height / 2), false, `ACROSS ${d} is outside the window drag region, so a real click reaches it`)
  }
  for (const d of [2, 5, 6, 4, 3]) {
    await steps.filter({ hasText: String(d) }).click()
    await page.waitForFunction((n) => document.querySelector('.lt-browser-root .lt-grid')?.classList.contains(`g${n}`), d)
    const pressed = await steps.evaluateAll((els) => els.filter((e) => e.classList.contains('active')).map((e) => e.textContent))
    assert.deepEqual(pressed, [String(d)], `after a click on ${d}, only ${d} is pressed`)
    if (shots && d === 5) {
      await page.mouse.move(700, 500) // off the buttons: no hover tint
      await page.waitForTimeout(500) // past the pressed-state transition
      await page.locator(`${B} .lt-topbar`).screenshot({ path: join(shots, 'across-5-pressed.png') })
      await page.screenshot({ path: join(shots, 'across-5-grid.png') })
    }
  }
  await page.keyboard.press('Escape') // the selection
  await page.keyboard.press('6')
  await page.waitForFunction(() => document.querySelector('.lt-browser-root .lt-grid')?.classList.contains('g6'))
  assert.deepEqual(await steps.evaluateAll((els) => els.filter((e) => e.classList.contains('active')).map((e) => e.textContent)), ['6'], 'the key 6 moves the pressed button too')
  console.log('PASS ACROSS: every button outside the drag region; a click sets its density, only it pressed, the grid follows')
  await closePicker()

  assert.deepEqual(errors, [], 'no renderer errors')
  console.log('PASS select section e2e')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
