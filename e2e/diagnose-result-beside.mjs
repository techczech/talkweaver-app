// A slide-search result's talk beside the results (talk search ticket 06; ADR-0029 §4; frame K5),
// end to end in the built app with a real search: on "mondai", O on "MondAI RoundUp" shows "AI 2026:
// Agents = Files in folders" beside the results, scrolled to § Content, the slide highlighted and in
// view, under the K5 header; the results two across; the card's "In talk" opens another result's
// talk in place of the first; Esc closes it with the results, their scroll position, focus and
// selection unchanged; slides insert from both sides.
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { pickerTalkRow } from './lib/picker-tree.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-result-beside-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
let edited = 0
function talk(rel, slug, fm, sections) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  const body = sections.map(([name, slides]) => [`## ${name}`, '', ...slides.map(([t, text]) => `### ${t}\n\n${text ?? `Text for ${t}`}\n`)].join('\n')).join('\n')
  const file = join(dir, `${slug}-outline.md`)
  writeFileSync(file, `---\noutline_version: 2\n${fm}\n---\n\n${body}\n`)
  const at = new Date(Date.now() - 3600_000 * ++edited)
  utimesSync(file, at, at)
  return file
}
const n = (prefix, count) => Array.from({ length: count }, (_v, i) => [`${prefix} ${i + 1}`])
const working = talk('drafts', 'working-talk', 'title: Working talk', [['Start', [['Where we begin']]]])
// K5's talk: a long Introduction pushes § Content below the fold, so opening must scroll to it.
talk('agents-presentations', 'files-in-folders', 'title: "AI 2026: Agents = Files in folders"', [
  ['Introduction', n('Intro point', 12)],
  ['Content', [['Step 3'], ['Old ways'], ['The new paradigm'], ['MondAI RoundUp', 'Every Monday the MondAI news round-up, files first'], ['Clawey – Nanoclaw powered agent'], ['How I used Clawey today'], ['Come by to MondAI', 'Drop in to MondAI at the centre on Mondays']]],
  ['Wrap-up', n('Wrap point', 3)]
])
talk('agents-presentations', 'current-state', 'title: The current state of AI agents', [
  ['The State of AI in September 2026', [['Join MondAI for Latest News', 'Join the MondAI list for the latest agent news'], ['What changed']]]
])
talk('agents-presentations', 'agent-architecture', 'title: Agent Architecture and Context Engineering', [
  ['Context', [['Context windows'], ['MondAI RoundUp', 'Architecture notes as told at MondAI, context engineering']]]
])
// Many "weekly" slides: a result list long enough to scroll, for the scroll-position check.
talk('archive', 'weekly-notes', 'title: Weekly notes', [['Weeks', n('Weekly note', 24).map(([t]) => [t, `A weekly note about ${t}`])]])
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
const slideBox = page.locator(`${B} .lt-searchfield input`)
const left = page.locator(`${B} .lt-table-scroll .lt-card:not(.skeleton)`)
const beside = page.locator(`${B} .lt-beside`)
const header = () => page.locator(`${B} .lt-beside-head`).getAttribute('title')
const titles = (loc) => loc.evaluateAll((els) => els.map((e) => e.querySelector('.lt-l-title')?.textContent ?? ''))
const selectedTitles = () => titles(page.locator(`${B} .lt-table-scroll .lt-card.selected`))
const focusedTitle = async () => (await titles(page.locator(`${B} .lt-table-scroll .lt-card.focused`)))[0] ?? null
const settle = async () => {
  await page.waitForFunction(() => !/searching/.test(document.querySelector('.lt-browser-root .lt-topbar')?.textContent ?? ''), null, { timeout: 15000 })
  await page.waitForTimeout(400)
}
// The result card for a slide title, by the talk named in its origin line.
async function resultPos(title, talkTitle) {
  const all = await left.evaluateAll((els) => els.map((e) => ({
    pos: Number(e.getAttribute('data-pos')),
    title: e.querySelector('.lt-l-title')?.textContent ?? '',
    origin: e.querySelector('.lt-origin')?.textContent ?? ''
  })))
  const hit = all.find((c) => c.title === title && c.origin.startsWith(talkTitle))
  assert.ok(hit, `result "${title}" from "${talkTitle}" in ${JSON.stringify(all)}`)
  return hit.pos
}
const card = (pos) => page.locator(`${B} .lt-card[data-pos="${pos}"]`)
// Focus a card the way the keyboard user does: ↓ out of the search box, then hover to the card.
async function focusCard(pos) {
  if (await page.evaluate(() => document.activeElement?.tagName === 'INPUT')) await page.keyboard.press('ArrowDown')
  await card(pos).hover()
  await page.waitForFunction((p) => document.querySelector(`.lt-browser-root .lt-card[data-pos="${p}"]`)?.classList.contains('focused'), pos)
}
// The highlighted slide lies wholly inside the right side's visible box.
async function hlInView() {
  return page.evaluate(() => {
    const box = document.querySelector('.lt-browser-root .lt-beside-scroll')?.getBoundingClientRect()
    const hl = document.querySelector('.lt-browser-root .lt-beside .lt-card.hl .lt-print')?.getBoundingClientRect()
    return Boolean(box && hl && hl.top >= box.top - 1 && hl.bottom <= box.bottom + 1)
  })
}

try {
  await openTalkByTitle(page, 'Working talk')
  await page.keyboard.press('Meta+s')
  await page.locator(B).waitFor()
  await slideBox.fill('mondai')
  await settle()
  assert.equal(await left.count(), 4, 'four slides match "mondai"')
  assert.equal(await beside.count(), 0, 'results only to begin with')

  // ── O on "MondAI RoundUp": its talk beside, scrolled to § Content, the slide highlighted ──
  const roundup = await resultPos('MondAI RoundUp', 'AI 2026: Agents = Files in folders')
  await focusCard(roundup)
  await page.keyboard.press('o')
  await beside.waitFor()
  assert.equal(await page.locator(`${B} .lt-split.open`).count(), 1, 'the main area splits')
  const hl = page.locator(`${B} .lt-beside .lt-card.hl`)
  assert.equal(await hl.count(), 1, 'one slide highlighted')
  assert.equal(await hl.locator('.lt-l-title').textContent(), 'MondAI RoundUp')
  const talkTitles = await titles(page.locator(`${B} .lt-beside .lt-card`))
  const treeCount = Number(await (await pickerTalkRow(page, 'files-in-folders')).locator('.lt-tc').textContent())
  assert.equal(talkTitles.length, treeCount, `the whole talk (${talkTitles.length} of ${treeCount}), not only its matching slides`)
  const hlIndex = talkTitles.indexOf('MondAI RoundUp')
  assert.equal(await header(), `AI 2026: Agents = Files in folders · § Content · slide ${hlIndex + 1} of ${treeCount} · Esc close`, 'the K5 header')
  await page.waitForTimeout(700) // the cards' entry animation settles
  assert.equal(await hlInView(), true, 'the highlighted slide is in view')
  const scrolled = await page.locator(`${B} .lt-beside-scroll`).evaluate((el) => el.scrollTop)
  assert.ok(scrolled > 0, `the talk scrolled past its Introduction (scrollTop ${scrolled})`)
  const sectionAtTop = await page.evaluate(() => {
    const box = document.querySelector('.lt-browser-root .lt-beside-scroll').getBoundingClientRect()
    const heads = [...document.querySelectorAll('.lt-browser-root .lt-beside .lt-sec-head')]
    const content = heads.find((h) => h.textContent.startsWith('§ Content'))
    const r = content.getBoundingClientRect()
    return r.top >= box.top - 1 && r.top < box.top + 60
  })
  assert.equal(sectionAtTop, true, 'the right side opens at § Content')
  assert.equal(await page.locator(`${B} .lt-table-scroll .lt-grid.g2`).count(), 1, 'the results stay on the left, two across')
  assert.equal(await left.count(), 4, 'the results are unchanged')
  assert.match(await page.locator(`${B} .lt-beside-lh`).textContent(), /4 slides match “mondai”/)
  if (shots) { await page.waitForTimeout(1500); await page.screenshot({ path: join(shots, 'K5-result-beside.png') }) }
  console.log('PASS K5: "MondAI RoundUp" shows its talk beside, § Content, the slide highlighted and in view')

  // ── Opening a second result's talk (the card's "In talk") replaces the first ──
  const arch = await resultPos('MondAI RoundUp', 'Agent Architecture and Context Engineering')
  await card(arch).hover()
  await card(arch).locator('.lt-inctx').click()
  await page.waitForFunction(() => /^Agent Architecture/.test(document.querySelector('.lt-browser-root .lt-beside-head')?.getAttribute('title') ?? ''))
  assert.equal(await beside.count(), 1, 'still one talk beside')
  const archTitles = await titles(page.locator(`${B} .lt-beside .lt-card`))
  assert.equal(await header(), `Agent Architecture and Context Engineering · § Context · slide ${archTitles.indexOf('MondAI RoundUp') + 1} of ${archTitles.length} · Esc close`)
  assert.equal(await page.locator(`${B} .lt-beside .lt-card.hl .lt-l-title`).textContent(), 'MondAI RoundUp')
  if (shots) { await page.waitForTimeout(1500); await page.screenshot({ path: join(shots, 'K5-second-replaces.png') }) }
  console.log('PASS replace: another result\'s talk takes the right side')

  // ── Esc: the right side closes; results, focus and selection unchanged ──
  await page.keyboard.press('Escape')
  await beside.waitFor({ state: 'detached' })
  assert.equal(await page.locator(B).count(), 1, 'the picker stays open')
  assert.equal(await left.count(), 4)
  const come = await resultPos('Come by to MondAI', 'AI 2026: Agents = Files in folders')
  await focusCard(come)
  await page.keyboard.press('x')
  const selBefore = await selectedTitles()
  assert.deepEqual(selBefore, ['Come by to MondAI'])
  await page.keyboard.press('o')
  await beside.waitFor()
  assert.equal(await header(), `AI 2026: Agents = Files in folders · § Content · slide ${talkTitles.indexOf('Come by to MondAI') + 1} of ${treeCount} · Esc close`)
  assert.equal(await hlInView(), true)
  await page.keyboard.press('Escape')
  await beside.waitFor({ state: 'detached' })
  assert.deepEqual(await selectedTitles(), selBefore, 'Esc leaves the selection as it was')
  assert.equal(await focusedTitle(), 'Come by to MondAI', 'and the focus on the result')
  assert.equal(await page.locator(`${B} .lt-table-scroll .lt-grid.g2`).count(), 0, 'the results are back at their own density')
  console.log('PASS Esc: closes the talk; results, focus and selection unchanged')

  // ── Esc restores the results' scroll position ──
  await slideBox.fill('weekly')
  await settle()
  assert.ok(await left.count() >= 24, 'a long result list')
  await focusCard(0)
  const scroller = page.locator(`${B} .lt-table-scroll`)
  await scroller.evaluate((el) => { el.scrollTop = 320 })
  await page.waitForTimeout(200)
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop)
  assert.ok(scrollBefore > 200, `the results scrolled (${scrollBefore})`)
  const visiblePos = await page.evaluate(() => {
    const box = document.querySelector('.lt-browser-root .lt-table-scroll').getBoundingClientRect()
    const c = [...document.querySelectorAll('.lt-browser-root .lt-table-scroll .lt-card')]
      .find((e) => { const r = e.getBoundingClientRect(); return r.top > box.top + 10 && r.bottom < box.bottom - 10 })
    return Number(c.getAttribute('data-pos'))
  })
  await card(visiblePos).hover()
  await page.keyboard.press('o')
  await beside.waitFor()
  assert.match(await header(), /^Weekly notes · § Weeks · slide \d+ of \d+ · Esc close$/)
  await page.keyboard.press('Escape')
  await beside.waitFor({ state: 'detached' })
  assert.equal(await scroller.evaluate((el) => el.scrollTop), scrollBefore, 'Esc returns the results to their scroll position')
  console.log(`PASS Esc: the results' scroll position comes back (${scrollBefore}px)`)

  // ── Insert from both sides ──
  await page.keyboard.press('Escape') // clear the selection
  await slideBox.fill('mondai')
  await settle()
  await page.locator(`${B} .lt-tray .lt-t-clear`).click().catch(() => {})
  const joinPos = await resultPos('Join MondAI for Latest News', 'The current state of AI agents')
  await card(roundup).hover()
  await card(roundup).locator('.lt-inctx').click()
  await beside.waitFor()
  await card(joinPos).click() // a result, left
  await page.locator(`${B} .lt-beside .lt-card`).filter({ hasText: 'Old ways' }).first().click() // its talk, right
  assert.equal(await page.locator(`${B} .lt-tray .lt-n`).textContent(), '2', 'one slide selected on each side')
  const before = readFileSync(working, 'utf8')
  await page.keyboard.press('Meta+Enter')
  await page.locator(B).waitFor({ state: 'detached' })
  let after = before
  for (let i = 0; i < 40 && after === before; i++) { await page.waitForTimeout(250); after = readFileSync(working, 'utf8') }
  assert.match(after, /^### Join MondAI for Latest News$/m, 'the result from the left is inserted')
  assert.match(after, /^### Old ways$/m, 'the slide from the talk beside is inserted')
  console.log('PASS insert: a slide from each side lands in the talk')

  assert.deepEqual(errors, [], 'no renderer errors')
  console.log('PASS result beside e2e')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
