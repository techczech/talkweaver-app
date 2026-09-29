// The talk-search keys and commands (talk search ticket 08; ADR-0029; estate ADR-0011), end to end
// in the built app, through the real key path:
//   1. ⇧⌘S from the editor opens the slide picker with the cursor in Find a talk; ⌘↵ there adds the
//      highlighted talk beside (a chip); ⌫ in the empty box takes it out again.
//   2. ⇧⌘↵ on a focused slide selects its whole section (as its heading's Select section button
//      does; nothing is inserted, the picker stays open); ⌘↵ then inserts the selection; one ⌘Z
//      removes it.
//   3. The command palette, opened above the picker, runs "Show the focused result's talk beside"
//      and "Close the talk beside the results"; Esc closes the talk beside too.
//   4. Rebound in the keymap store (what Settings writes), talk beside answers ⌘⌥O and no longer O,
//      and the hint bar shows ⌘⌥O. A plain O typed in the editor is still an O.
//   5. The cheat sheet (⌘/, else ⌃/) lists the Slide picker keys.
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots (the ticket's
// build shots: the picker hint bar and the cheat sheet).
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-talk-search-keys-'))
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
const working = '---\noutline_version: 2\ntitle: Working talk\n---\n\n## Start\n{id=st001}\n\n### Where we begin\n{id=wwb01}\n\nThe first words.\n'
writeTalk('drafts', 'working-talk', working)
writeTalk('agents-presentations', 'agents-in-practice', [
  '---', 'outline_version: 2', 'title: Agents in practice', '---', '',
  '## Opening', '{id=op001}', '', '### Hello there', '{id=ht001}', '', 'A greeting.', '',
  '## More examples', '{id=me001}', '', '### Example one', '{id=ex001}', '', 'The first example.', '', '### Example two', '{id=ex002}', '', 'The second example.', '',
  '## Closing words', '{id=cw001}', '', '### Thank you', '{id=ty001}', '', 'Goodbye.', ''
].join('\n'))
writeTalk('agents-presentations', 'agent-architecture', [
  '---', 'outline_version: 2', 'title: Agent Architecture', '---', '',
  '## Context', '{id=cx001}', '', '### Example windows', '{id=ew001}', '', 'Context windows, by example.', ''
].join('\n'))
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
const findBox = page.locator(`${B} input[data-find-talk="1"]`)
const slideBox = page.locator(`${B} .lt-searchfield input`)
const beside = page.locator(`${B} .lt-beside`)
const chips = page.locator(`${B} .lt-find-chip`)
const readBuffer = () => page.evaluate(() => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString() ?? null)
const waitBuffer = (text) => page.waitForFunction((t) => document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString() === t, text, { timeout: 10000 })
const setCaretToEnd = () => page.evaluate(() => {
  const view = document.querySelector('.cm-content')?.cmTile?.root?.view
  view.focus()
  view.dispatch({ selection: { anchor: view.state.doc.length } })
})
const settle = async () => {
  await page.waitForFunction(() => !/searching/.test(document.querySelector('.lt-browser-root .lt-topbar')?.textContent ?? ''), null, { timeout: 15000 })
  await page.waitForTimeout(400)
}
async function cardPos(title) {
  const all = await page.locator(`${B} .lt-card:not(.skeleton)`).evaluateAll((els) => els.map((e) => ({
    pos: Number(e.getAttribute('data-pos')), title: e.querySelector('.lt-l-title')?.textContent ?? '', inBeside: !!e.closest('.lt-beside')
  })))
  const hit = all.find((c) => c.title === title && !c.inBeside)
  assert.ok(hit, `a card "${title}" in ${JSON.stringify(all)}`)
  return hit.pos
}
// Focus a card the way the keyboard user does: ↓ out of a text box, then hover to the card.
async function focusCard(title) {
  const pos = await cardPos(title)
  if (await page.evaluate(() => document.activeElement?.tagName === 'INPUT')) await page.keyboard.press('ArrowDown')
  await page.locator(`${B} .lt-card[data-pos="${pos}"]`).hover()
  await page.waitForFunction((p) => document.querySelector(`.lt-browser-root .lt-card[data-pos="${p}"]`)?.classList.contains('focused'), pos)
}
async function closePicker() {
  for (let i = 0; i < 6 && await page.locator(B).count(); i += 1) { await page.keyboard.press('Escape'); await page.waitForTimeout(200) }
  await page.locator(B).waitFor({ state: 'detached' })
}
async function runFromPalette(words, label) {
  await page.keyboard.press('Meta+Shift+p')
  const input = page.locator('.command-menu input')
  await input.waitFor()
  await input.fill(words)
  const first = page.locator('.command-menu-item').first()
  assert.equal((await first.locator('.command-menu-title').textContent())?.trim(), label, `the palette's first row for "${words}" is "${label}"`)
  const hint = (await first.locator('.command-menu-hint').textContent())?.trim()
  await page.keyboard.press('Enter')
  await page.locator('.command-menu').waitFor({ state: 'detached' })
  return hint
}
const hintKeys = (id) => page.locator(`${B} .lt-hintbar [data-hint="${id}"] kbd`).allTextContents()

try {
  await openTalkByTitle(page, 'Working talk')
  await waitBuffer(working)

  // ── 1. ⇧⌘S from the editor: the picker, the cursor in Find a talk; ⌘↵ adds beside; ⌫ removes ──
  await setCaretToEnd()
  await page.keyboard.press('Meta+Shift+s')
  await page.locator(B).waitFor()
  await page.waitForFunction(() => document.activeElement?.matches?.('.lt-browser-root input[data-find-talk="1"]') ?? false, null, { timeout: 5000 })
  console.log('PASS ⇧⌘S: the slide picker opens with the cursor in Find a talk')
  await settle()
  await findBox.pressSequentially('agents in practice')
  await page.locator(`${B} .lt-find-row`).first().waitFor()
  await page.keyboard.press('Meta+Enter')
  await chips.first().waitFor()
  assert.equal(await chips.count(), 1, '⌘↵ adds the talk beside as a chip')
  assert.equal(await findBox.inputValue(), '', 'the box empties after adding')
  await page.keyboard.press('Backspace')
  await page.waitForFunction(() => document.querySelectorAll('.lt-browser-root .lt-find-chip').length === 0)
  console.log('PASS ⌘↵ adds the highlighted talk beside; ⌫ in the empty box takes it out')

  // ── 2. ⇧⌘↵ on a focused slide: its whole section joins the selection; ⌘↵ inserts; one ⌘Z ──
  await findBox.pressSequentially('agents in practice')
  await page.locator(`${B} .lt-find-row`).first().waitFor()
  await page.keyboard.press('Enter')
  const selSec = page.locator(`${B} .lt-sec-head`, { hasText: 'More examples' }).locator('.lt-sel-sec')
  await selSec.waitFor()
  await settle()
  assert.deepEqual(await hintKeys('slide-picker.select-whole-section'), ['⇧⌘↵'], 'the hint bar names ⇧⌘↵ for select whole section')
  assert.equal((await page.locator(`${B} .lt-hintbar [data-hint="slide-picker.select-whole-section"] b`).textContent())?.trim(), 'select whole section')
  assert.deepEqual(await hintKeys('slide-picker.talk-beside'), ['O'], 'and O for talk beside')
  assert.deepEqual(await hintKeys('app.find-talk'), ['⇧⌘S'], 'and ⇧⌘S for Find a talk')
  if (shots) {
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(shots, 'picker-with-hint-bar.png') })
    await page.locator(`${B} .lt-hintbar`).screenshot({ path: join(shots, 'picker-hint-bar.png') })
  }
  await focusCard('Example one')
  await page.keyboard.press('Meta+Shift+Enter')
  await page.locator(`${B} .lt-tray .lt-n`).waitFor()
  assert.equal(await page.locator(`${B} .lt-tray .lt-n`).textContent(), '3', '⇧⌘↵ selects the 3 slides of the section, heading slide included')
  assert.equal(await selSec.getAttribute('aria-pressed'), 'true', 'the heading’s Select section shows the whole section selected')
  assert.equal(await readBuffer(), working, 'nothing is inserted by ⇧⌘↵')
  await page.keyboard.press('Meta+Enter')
  await page.locator(B).waitFor({ state: 'detached' })
  await page.waitForFunction(() => /Inserted 3 slides/.test(document.querySelector('[role="status"]')?.textContent ?? ''))
  const inserted = await readBuffer()
  const section = '## More examples\n{id=me001}\n\n### Example one\n{id=ex001}\n\nThe first example.\n\n### Example two\n{id=ex002}\n\nThe second example.'
  assert.ok(inserted.startsWith(working.trimEnd()) && inserted.includes(section), `the whole section went in at the caret, heading slide first:\n${inserted}`)
  assert.ok(!/Opening|Closing words/.test(inserted), 'and nothing of the other sections')
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Meta+z')
  await waitBuffer(working)
  console.log('PASS ⇧⌘↵ selects the focused slide’s section (3 slides, nothing inserted); ⌘↵ inserts them at the caret; one ⌘Z removes it')

  // ── 3. The palette above the picker runs talk beside and close beside; Esc closes it too ──
  await page.keyboard.press('Meta+s')
  await page.locator(B).waitFor()
  await settle()
  await slideBox.fill('example')
  await settle()
  await focusCard('Example one')
  const besideHint = await runFromPalette('focused result', 'Show the focused result’s talk beside the results')
  assert.equal(besideHint, 'O', 'the palette row shows the O key')
  await beside.waitFor()
  assert.equal(await page.locator(`${B} .lt-beside .lt-card.hl .lt-l-title`).textContent(), 'Example one', 'the palette opened the focused result’s talk, the slide highlighted')
  const closeHint = await runFromPalette('close the talk beside', 'Close the talk beside the results')
  assert.equal(closeHint, 'Esc', 'the palette row shows Esc')
  await beside.waitFor({ state: 'detached' })
  assert.equal(await page.locator(B).count(), 1, 'the picker stays open')
  await focusCard('Example one')
  await page.keyboard.press('o')
  await beside.waitFor()
  await page.keyboard.press('Escape')
  await beside.waitFor({ state: 'detached' })
  console.log('PASS the palette runs talk beside and close beside above the picker; O and Esc do the same')

  // ── 4. Rebound: ⌘⌥O opens the talk beside, O no longer does; the hint bar follows ──
  await page.evaluate(() => {
    window.localStorage.setItem('tw-keymap-overrides', JSON.stringify({ 'talk-beside': 'Mod-Alt-o' }))
    window.dispatchEvent(new Event('tw-keymap-changed'))
  })
  await page.waitForFunction(() => document.querySelector('.lt-browser-root .lt-hintbar [data-hint="slide-picker.talk-beside"] kbd')?.textContent === '⌘⌥O')
  await focusCard('Example one')
  await page.keyboard.press('o')
  await page.waitForTimeout(600)
  assert.equal(await beside.count(), 0, 'the old O no longer opens the talk beside')
  await page.keyboard.press('Meta+Alt+o')
  await beside.waitFor()
  console.log('PASS rebound to ⌘⌥O: the new key opens the talk beside, O does not, the hint bar shows ⌘⌥O')
  await page.evaluate(() => {
    window.localStorage.setItem('tw-keymap-overrides', '{}')
    window.dispatchEvent(new Event('tw-keymap-changed'))
  })
  await closePicker()
  await setCaretToEnd()
  await page.keyboard.type('o')
  await waitBuffer(`${working}o`)
  await page.keyboard.press('Meta+z')
  await waitBuffer(working)
  console.log('PASS a plain O typed in the editor is an O (the picker’s O is not an editor binding)')

  // ── 5. The cheat sheet lists the Slide picker keys ──
  await page.locator('.cm-content').evaluate((el) => el.blur())
  await page.keyboard.press('Meta+/')
  const sheet = page.locator('[role="dialog"][aria-label="Keyboard shortcuts"]')
  let opener = '⌘/'
  if (!await sheet.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) {
    opener = '⌃/'
    await page.keyboard.press('Control+/')
    await sheet.waitFor()
  }
  const sheetText = (await sheet.textContent()) ?? ''
  for (const expected of ['Slide picker · Talks', 'Show the result’s talk beside', 'Close the talk beside', 'Add the talk beside', 'Select whole section', 'Find a talk', 'Select section', 'Sort talks']) {
    assert.ok(sheetText.includes(expected), `the cheat sheet lists “${expected}”`)
  }
  assert.ok(!sheetText.includes('Insert section'), 'no cheat-sheet row still says Insert section')
  if (shots) {
    await sheet.getByText('Slide picker · Select & insert').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'cheat-sheet-slide-picker.png') })
  }
  console.log(`PASS the cheat sheet (opened with ${opener}) lists the Slide picker keys`)

  assert.deepEqual(errors, [], 'no renderer errors')
  console.log('PASS talk search keys e2e')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
