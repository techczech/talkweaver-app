// "Find a talk" in the slide picker (talk search ticket 05; ADR-0029 §4; frames K1–K4), end to
// end in the built app: the two boxes (Find a talk above Search slides), the hint row, "claw"
// listing the three talks K3 draws with match lines and in the file list's order, ↵ scoping to a
// talk whole while the slide search keeps its words, the chip and its ×, ⌘↵ adding columns (a
// fourth as ⌘-click: no fourth column), and the slide search without talk-name hits.
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { pickerTalkRow } from './lib/picker-tree.mjs'
import { openTalkByTitle, talkSearchInput } from './lib/talklist.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-find-a-talk-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
let edited = 0
function talk(rel, slug, fm, sections) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  const body = sections.map(([name, slides]) => [`## ${name}`, '', ...slides.map((s) => `### ${s}\n\nText for ${s}\n`)].join('\n')).join('\n')
  const file = join(dir, `${slug}-outline.md`)
  writeFileSync(file, `---\noutline_version: 2\n${fm}\n---\n\n${body}\n`)
  // Edited times fall back from the first talk: title-match ties rank the newer first (K3's order).
  const at = new Date(Date.now() - 3600_000 * ++edited)
  utimesSync(file, at, at)
}
talk('agents-2026', 'the-age-of-the-claw', 'title: The Age of the Claw\ndate: 2026', [['Opening', ['Welcome']]])
talk('agents-2026', 'year-of-agents', 'title: AI 2026 - Year of Agents and Claws\nevent: ICTF', [['Opening', ['Why now', 'The reveal']], ['Claws', ['Claw one', 'Claw two']]])
talk('agents-presentations', 'files-in-folders', 'title: "AI 2026: Agents = Files in folders"', [['Introduction', ['Formerly founded']], ['Content', ['Open Claw files', 'SOUL.md', 'HEARTBEAT.md']]])
talk('agents-presentations', 'agent-architecture', 'title: Agent architecture and context engineering', [['Opening', ['Vivians claim']]])
talk('external-workshops/York-July-2026/day-2', 'york-workshop', 'title: York Workshop', [['Hands on', ['Try it']]])
talk('external-workshops/York-July-2026/day-3', 'york-closing', 'title: York Closing Panel', [['Panel', ['Panel slide']]])
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
const findBox = page.locator(`${B} .lt-find input[data-find-talk="1"]`)
const slideBox = page.locator(`${B} .lt-searchfield input`)
const results = page.locator(`${B} .lt-find-row`)
const scopeNames = () => page.locator(`${B} .lt-scope-row .lt-scope-nm`).allTextContents()
const chips = () => page.locator(`${B} .lt-find-chip`).evaluateAll((els) => els.map((e) => e.getAttribute('data-chip-talk')))
const columns = () => page.locator(`${B} .lt-colwrap .lt-col`).count()
// Find a talk's results once they answer exactly this query (not a partial one typed on the way).
const answered = (q) => page.locator(`${B} .lt-find-results[data-answered="${q}"]`).waitFor({ timeout: 30000 })
const settle = async () => {
  await page.waitForFunction(() => !/searching/.test(document.querySelector('.lt-browser-root .lt-topbar')?.textContent ?? ''), null, { timeout: 15000 })
  await page.waitForTimeout(300)
}

try {
  await openTalkByTitle(page, 'The Age of the Claw')
  // The file list's answer for "claw" (after the slide-text warm pass has read every talk).
  const listBox = talkSearchInput(page)
  await listBox.fill('claw')
  await page.locator('.tl-row--two[data-talk-slug="files-in-folders"]').waitFor({ timeout: 30000 })
  const fileListOrder = await page.locator('.tl-row--two').evaluateAll((els) => els.map((e) => e.getAttribute('data-talk-slug')))
  await listBox.fill('')

  await page.keyboard.press('Meta+s')
  await page.locator(B).waitFor()
  await findBox.waitFor()

  // ── K1: "Find a talk" above "Search slides"; the slide search still takes ⌘S's focus ──
  const findY = (await findBox.boundingBox()).y
  const slideY = (await slideBox.boundingBox()).y
  assert.ok(findY < slideY, 'Find a talk sits above Search slides')
  assert.equal(await findBox.getAttribute('placeholder'), 'Name, folder, event, date…')
  assert.equal(await slideBox.getAttribute('placeholder'), 'Words on slides — all words match')
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.lt-searchfield') != null), true, 'the slide search is focused on open')
  console.log('PASS K1: Find a talk above Search slides')

  // ── the slide search finds slides only: no talk-name hits for "claw" ──
  await slideBox.fill('claw')
  await settle()
  assert.equal(await page.locator(`${B} .lt-talk-hits, ${B} .lt-th-row`).count(), 0, 'no talk-name hits under the slide search')
  assert.equal(await results.count(), 0, 'and Find a talk lists nothing it was not asked')
  console.log('PASS slide search: no talk-name hits')

  // ── K2: focused and empty, the file list's hint row ──
  await slideBox.fill('')
  await findBox.click()
  const hints = await page.locator(`${B} .lt-find .tl-pfx`).evaluateAll((els) => els.map((e) => e.getAttribute('data-prefix')))
  assert.deepEqual(hints, ['fo:', 'fi:', 'met:', 'co:', 'da:'], 'the five prefixes')
  if (shots) await page.locator(`${B} .lt-urail`).screenshot({ path: join(shots, 'K2-hint-row.png') })
  console.log('PASS K2: the hint row under an empty, focused Find a talk')

  // ── K3: "claw" → the three talks, match lines, the file list's order ──
  await findBox.pressSequentially('claw')
  await answered('claw')
  const findOrder = await results.evaluateAll((els) => els.map((e) => e.getAttribute('data-talk-slug')))
  assert.deepEqual(findOrder, ['the-age-of-the-claw', 'year-of-agents', 'files-in-folders'], 'K3: the three talks, in its order')
  assert.deepEqual(findOrder, fileListOrder, 'the same talks in the same order as the file list')
  assert.match(await results.nth(2).innerText(), /slides\s+“Open Claw files”/, 'the slides match line')
  assert.match(await results.nth(0).innerText(), /current/, 'the current talk is listed and marked')
  assert.equal(await results.nth(1).getAttribute('aria-selected'), 'true', 'the highlight starts on the first talk that can be picked')
  assert.match(await results.nth(1).innerText(), /⌘↵ add beside/)
  assert.equal(await page.locator(`${B} .lt-browse-dim`).count(), 1, 'the Files tree dims under the results')
  assert.equal(await slideBox.inputValue(), '', 'typing here leaves the slide search alone')
  if (shots) { await settle(); await page.screenshot({ path: join(shots, 'K3-find-typed.png') }) }
  console.log('PASS K3: "claw" lists three talks with match lines, in the file list\'s order')

  // ── K4: ↵ shows the talk, whole; the slide search keeps its words; the chip ──
  await slideBox.fill('reveal')
  await findBox.fill('claw')
  await answered('claw')
  await page.keyboard.press('Enter')
  await page.locator(`${B} .lt-find-chip`).waitFor()
  assert.deepEqual(await chips(), ['year-of-agents'], 'the picked talk is a chip')
  assert.deepEqual(await scopeNames(), ['AI 2026 - Year of Agents and Claws'], 'the picker is scoped to it')
  assert.equal(await slideBox.inputValue(), 'reveal', 'the slide search holds exactly what it held')
  assert.equal(await findBox.inputValue(), '', 'the words give way to the chip')
  await settle()
  const filtered = await page.locator(`${B} .lt-table-scroll`).innerText()
  assert.ok(filtered.includes('The reveal') && !filtered.includes('Claw one'), 'the kept slide search still narrows the scoped talk')
  // Emptying the slide search under the picked talk shows each of its slides once, and narrowing
  // it again leaves nothing behind. The outline view's two unsectioned chunks (title and closing
  // slide) once shared a React key; React then lost track of one of them, and the title card stayed
  // on screen as a stale extra copy.
  const treeCountOf = async () => Number(await (await pickerTalkRow(page, 'year-of-agents')).locator('.lt-tc').textContent())
  const cardTitles = () => page.locator(`${B} .lt-table-scroll .lt-card:not(.skeleton)`)
    .evaluateAll((els) => els.map((e) => e.querySelector('.lt-l-title')?.textContent ?? ''))
  for (const round of [1, 2]) {
    await slideBox.fill('')
    await settle()
    await page.waitForTimeout(600)
    const whole = await cardTitles()
    assert.equal(new Set(whole).size, whole.length, `round ${round}: no card twice after emptying the slide search: ${JSON.stringify(whole)}`)
    assert.equal(whole.length, await treeCountOf(), `round ${round}: every slide of the talk once: ${JSON.stringify(whole)}`)
    await slideBox.fill('reveal')
    await settle()
    await page.waitForTimeout(600)
    assert.deepEqual(await cardTitles(), ['The reveal'], `round ${round}: narrowing again shows only the match`)
  }
  console.log('PASS K4: emptying the slide search under a picked talk shows each slide once')
  // Picked afresh with an empty slide search: every slide of the talk in outline order.
  await page.locator(`${B} .lt-find-chip-x`).click()
  await slideBox.fill('')
  await findBox.fill('claw')
  await answered('claw')
  await page.keyboard.press('Enter')
  await page.locator(`${B} .lt-find-chip`).waitFor()
  await settle()
  const sections = await page.locator(`${B} .lt-table-scroll .lt-sec-head span:first-child`).allTextContents()
  assert.deepEqual(sections, ['§ Opening', '§ Claws'], 'the whole talk, section by section in outline order')
  const treeCount = Number(await (await pickerTalkRow(page, 'year-of-agents')).locator('.lt-tc').textContent())
  const cards = page.locator(`${B} .lt-table-scroll .lt-card:not(.skeleton)`)
  const shown = await cards.evaluateAll((els) => els.map((e) => e.innerText.split('\n').filter(Boolean).slice(-2).join(' | ')))
  assert.equal(shown.length, treeCount, `every slide of the talk (${shown.length} of ${treeCount}): ${JSON.stringify(shown)}`)
  if (shots) { await page.waitForTimeout(900); await page.screenshot({ path: join(shots, 'K4-talk-picked.png') }) }
  console.log('PASS K4: ↵ scopes to the talk whole, the slide search untouched, the chip shows')

  // ── ⌘↵ adds beside; columns keep; a fourth as ⌘-click: no fourth column ──
  await findBox.fill('york workshop')
  await answered('york workshop')
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(300)
  assert.deepEqual(await scopeNames(), ['AI 2026 - Year of Agents and Claws', 'York Workshop'], '⌘↵ adds a column and keeps the open one')
  assert.equal(await columns(), 2, 'two talks side by side')
  assert.deepEqual(await chips(), ['year-of-agents', 'york-workshop'])
  if (shots) { await settle(); await page.waitForTimeout(900); await page.screenshot({ path: join(shots, 'K4-second-beside.png') }) }
  await findBox.fill('york closing')
  await answered('york closing')
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(300)
  assert.equal(await columns(), 3, 'three talks side by side')
  await findBox.fill('agent architecture')
  await answered('agent architecture')
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(300)
  assert.equal((await scopeNames()).length, 4)
  assert.equal(await columns(), 0, 'no fourth column: four talks read in sequence, as ⌘-click leaves them')
  console.log('PASS ⌘↵: adds columns up to three; a fourth goes sequential, as ⌘-click does')

  // ── a chip's × removes its talk; the last one gone unscopes ──
  await findBox.fill('')
  for (const slug of ['agent-architecture', 'york-closing', 'york-workshop']) {
    await page.locator(`${B} .lt-find-chip[data-chip-talk="${slug}"] .lt-find-chip-x`).click()
  }
  assert.deepEqual(await scopeNames(), ['AI 2026 - Year of Agents and Claws'])
  await page.locator(`${B} .lt-find-chip-x`).click()
  assert.deepEqual(await scopeNames(), [], 'removing the chip unscopes')
  assert.deepEqual(await chips(), [])
  assert.equal(await page.locator(`${B} .lt-browse-dim`).count(), 0, 'the tree is itself again')
  console.log('PASS chip ×: removes the talk; the last one unscopes')

  // ── Esc clears the words, then the picker's own Esc ladder ──
  await findBox.fill('claw')
  await answered('claw')
  await findBox.press('Escape')
  assert.equal(await findBox.inputValue(), '')
  assert.equal(await page.locator(B).count(), 1, 'Esc with words clears them and keeps the picker open')
  console.log('PASS Esc: clears Find a talk first')

  assert.deepEqual(errors, [], 'no renderer errors')
  console.log('PASS Find a talk e2e')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
