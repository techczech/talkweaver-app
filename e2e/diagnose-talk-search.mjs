// Talk search in the Talks browser (ticket 01, ADR-0029 §1), end to end in the built app: plain
// words over details, delivery records and slide text (a talk four folders deep included), the
// match line in Ledger and Shelf, a drilled-in folder with "search everywhere (N)", no results.
// Ticket 02 (ADR-0029 §2): the prefix hint row (L3), completion (L4), prefixed terms (L6) and
// the no-results suggestions (L8).
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-talk-search-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
function talk(rel, slug, fm, body = '### Opening\n\nWelcome\n') {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}-outline.md`), `---\noutline_version: 2\n${fm}\n---\n\n${body}`)
}
talk('ai-in-education/jersey-2026', 'from-intern-to-toolmaker-jersey', 'title: From Intern To Toolmaker - Jersey')
talk('ai-in-education', 'teaching-during-the-cognitive-revolution', 'title: Teaching During The Cognitive Revolution\nevent: Jersey College for Girls AI in Education conference')
talk('ai-in-education', 'vibecoding-as-pedagogy', 'title: Vibecoding As Pedagogy\neventTitle: Jersey College for Girls AI in Education conference')
talk('external-workshops/York-July-2026/day-2', 'vibecoding-lab', 'title: "Vibecoding Lab: Prototyping Research Tools"',
  '### Opening\n\nHello York\n\n## Kaleidoscope prototypes\n\n- build a small tool\n')
talk('external-workshops/York-July-2026/day-2', 'vibecoding-for-researchers', 'title: "Vibecoding for Researchers: App Building 101"')
talk('ai-in-education/clinical', 'vibecoding-clinical', 'title: Vibecoding in the Clinic')
talk('misc', 'quiet-talk', 'title: A Quiet Talk')
mkdirSync(join(vault, '_PRESENTATIONS', 'quiet-talk'), { recursive: true })
writeFileSync(join(vault, '_PRESENTATIONS', 'quiet-talk', 'run-1.json'), JSON.stringify({
  id: 'run-1', talkSlug: 'quiet-talk', kind: 'delivery', status: 'delivered', startedAt: '2026-07-10T09:30:00', eventTitle: 'Clinical Neuroscience away day'
}))
function run(slug, id, startedAt, eventTitle = 'Festival of AI Competency') {
  mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
  writeFileSync(join(vault, '_PRESENTATIONS', slug, `${id}.json`), JSON.stringify({ id, talkSlug: slug, kind: 'delivery', status: 'delivered', startedAt, eventTitle }))
}
// The York festival over three days (ticket 02): day 1 given only, day 3 dated and given.
const york = 'external-workshops/York-July-2026'
talk(`${york}/day-1`, 'frontier', 'title: Research & the Frontier of AI')
run('frontier', 'run-frontier', '2026-07-20T10:00:00')
for (const slug of ['vibecoding-lab', 'vibecoding-for-researchers']) run(slug, `run-${slug}`, '2026-07-21T10:00:00')
for (const [slug, title] of [['agents-research', 'AI Agents for Research: Beyond the Chatbot'], ['inspectable', 'Inspectable AI: Reproducibility & Risk'], ['open-source', 'Open Source & Local AI']]) {
  talk(`${york}/day-3`, slug, `title: "${title}"\ndate: 2026-07-22`)
  run(slug, `run-${slug}`, '2026-07-22T10:00:00')
}
talk('agents', 'mondai-slides', 'title: Agents = Files in folders', '### Opening\n\nHello\n\n## MondAI RoundUp\n\n- weekly news\n')
// Says MondAI in its details only (a talk's title is on its title slide, so not there).
talk('agents', 'mondai-tagged', 'title: Weekly News\ntags: [mondai]')
talk('misc', 'given-last-year', 'title: Given Last Year')
run('given-last-year', 'run-2025', '2025-07-15T10:00:00', 'Summer school')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const shots = process.env.TW_SHOTS
let app
try {
  const executablePath = process.env.TW_TEST_APP_EXECUTABLE
  if (!executablePath) await ensureFreshBuild(resolve('.'))
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${userData}`],
    cwd: resolve('.'), env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1512, height: 948 }).catch(() => {})
  const box = page.locator('[aria-label="Filter talks"]')
  // Folders start closed in the file list, so at rest the tree may show only folder rows.
  await page.locator('.tl-tree [data-folder-path], .tl-tree [data-talk-slug]').first().waitFor()
  const rowText = (slug) => page.locator(`[data-talk-slug="${slug}"]`).innerText()

  // L5 — plain words: three Jersey talks, two with an `event` line, title match first.
  await box.fill('jersey')
  await page.locator('.tl-row--two').nth(2).waitFor()
  assert.equal(await page.locator('.tl-row--two').count(), 3)
  assert.equal(await page.locator('.tl-row--two').first().getAttribute('data-talk-slug'), 'from-intern-to-toolmaker-jersey')
  for (const slug of ['teaching-during-the-cognitive-revolution', 'vibecoding-as-pedagogy']) {
    assert.match(await rowText(slug), /event\s+Jersey College for Girls AI in Education conference/)
  }
  assert.equal(await page.locator('.tl-row--two mark').first().innerText(), 'Jersey')
  assert.match(await page.locator('.tl-res-head').innerText(), /3 talks\s+everywhere/i)
  assert.equal(await page.locator('.tl-row--two').first().evaluate((el) => el.getBoundingClientRect().height), 36)
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L5-ledger-jersey.png') })
  console.log('PASS L5: "jersey" → 3 talks, `event` lines, 36 px rows')

  // A talk four folder levels deep, found by a word only on its slides (after the warm pass).
  await box.fill('kaleidoscope')
  await page.locator('[data-talk-slug="vibecoding-lab"]').waitFor({ timeout: 30000 })
  assert.match(await rowText('vibecoding-lab'), /slides\s+“Kaleidoscope prototypes”/)
  console.log('PASS depth 4: slide-only word finds the York day-2 talk')

  // A delivery record's event: a `given` line.
  await box.fill('neuroscience')
  await page.locator('[data-talk-slug="quiet-talk"]').waitFor()
  assert.match(await rowText('quiet-talk'), /given\s+10 Jul 2026 · Clinical Neuroscience away day/)
  console.log('PASS delivery: `given 10 Jul 2026 · Clinical Neuroscience away day`')

  // L8 — no results: the query stays.
  await box.fill('zzqqxx')
  await page.getByText('No talks match “zzqqxx”.', { exact: true }).waitFor()
  assert.equal(await box.inputValue(), 'zzqqxx')
  console.log('PASS L8: no results keep the query')

  // L7 — inside a drilled-in folder, then "search everywhere (N)".
  await box.fill('')
  // Focus the York folder row (a click also folds it), then ↵ drills in. Folders start closed in
  // the file list, so its parent is opened first.
  if (!await page.locator('.tl-tree [data-folder-path="external-workshops/York-July-2026"]').count()) {
    await page.locator('.tl-tree [data-folder-path="external-workshops"]').click()
  }
  await page.locator('[data-folder-path="external-workshops/York-July-2026"]').click()
  await page.keyboard.press('Enter')
  await page.locator('.tl-crumbs-here', { hasText: 'York-July-2026' }).waitFor()
  await box.fill('vibecoding')
  await page.locator('.tl-res-wide', { hasText: 'search everywhere (4)' }).waitFor()
  assert.equal(await page.locator('.tl-row--two').count(), 2)
  assert.match(await page.locator('.tl-res-head').innerText(), /2 talks\s+in York-July-2026 ·\s*search everywhere \(4\)/i)
  assert.match(await rowText('vibecoding-lab'), /day-2/)
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L7-in-folder.png') })
  await page.locator('.tl-res-wide').click()
  await page.locator('.tl-row--two').nth(3).waitFor()
  assert.equal(await page.locator('.tl-row--two').count(), 4)
  assert.equal(await page.locator('.tl-crumbs').count(), 0, 'searching everywhere leaves the folder')
  assert.equal(await box.inputValue(), 'vibecoding', 'the query is kept')
  console.log('PASS L7: 2 in York-July-2026, "search everywhere (4)" widens to 4')

  // L10 — Shelf shows the match line too.
  await page.getByRole('button', { name: 'Shelf view' }).click()
  await box.fill('jersey')
  // The previous query's rows stay up until the new result lands; wait for the new one.
  await page.locator('[data-talk-slug="vibecoding-as-pedagogy"] .tl-shrow-match', { hasText: 'Jersey College' }).waitFor()
  assert.equal(await page.locator('.tl-shrow--two').count(), 3)
  assert.match(await page.locator('[data-talk-slug="vibecoding-as-pedagogy"] .tl-shrow-match').innerText(), /event\s+Jersey College/)
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L10-shelf-jersey.png') })
  await page.getByRole('button', { name: 'Ledger view' }).click()
  console.log('PASS L10: Shelf rows carry the match line')

  // ── ticket 02 ──
  const hintRow = page.locator('.tl-pfx-row')
  const pop = page.locator('.tl-cpl')
  const slugsShown = async () => (await page.locator('.tl-row--two').evaluateAll((els) => els.map((el) => el.getAttribute('data-talk-slug')))).sort()
  const boxFocused = () => box.evaluate((el) => document.activeElement === el)

  // L3 — the hint row: on focus with an empty box; gone on the first character; a click types.
  await box.fill('')
  await page.locator('.tl-fhead').first().waitFor()
  await box.blur()
  assert.equal(await hintRow.count(), 0, 'no hint row while the box is not focused')
  await box.focus()
  await hintRow.waitFor()
  assert.deepEqual(await hintRow.locator('.tl-pfx').allInnerTexts(), ['fo: folder', 'fi: file name', 'met: details', 'co: slides', 'da: date'])
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L3-hint-row.png') })
  await page.keyboard.type('x')
  assert.equal(await hintRow.count(), 0, 'the first typed character hides the hint row')
  await page.keyboard.press('Backspace')
  await hintRow.waitFor()
  await hintRow.locator('[data-prefix="da:"]').click()
  assert.equal(await box.inputValue(), 'da:', 'a click types the prefix')
  assert(await boxFocused(), 'the box keeps the focus')
  assert.equal(await hintRow.count(), 0)
  await box.fill('')
  await hintRow.locator('[data-prefix="fo:"]').click()
  assert.equal(await box.inputValue(), 'fo:')
  await pop.waitFor()
  assert.match(await pop.locator('.tl-cpl-h').innerText(), /^folders$/i, 'after fo: the box offers folders')
  assert((await pop.locator('.tl-cpl-o span').allInnerTexts()).includes('external-workshops'), 'the top-level folders')
  console.log('PASS L3: hint row on focus + empty, gone on typing, a click types da: / fo: and keeps focus')

  // L4 — completion: f offers fo: and fi:; after fo:yo the York folders with talk counts.
  await box.fill('f')
  await pop.waitFor()
  assert.deepEqual(await pop.locator('.tl-cpl-o span').allInnerTexts(), ['fo:', 'fi:'])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  assert.equal(await box.inputValue(), 'fi:', '↓ then Tab completes the second offer')
  assert(await boxFocused(), 'Tab completes instead of moving the focus')
  await box.fill('fo:yo')
  await pop.locator('.tl-cpl-o', { hasText: 'day-3' }).waitFor()
  const offers = await pop.locator('.tl-cpl-o').evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))
  assert.deepEqual(offers, ['York-July-2026 6 talks', 'York-July-2026 / day-1 1', 'York-July-2026 / day-2 2', 'York-July-2026 / day-3 3'])
  assert.match(await pop.locator('.tl-cpl-f').innerText(), /↵ or Tab completes/)
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L4-completion.png') })
  await page.keyboard.press('Escape')
  assert.equal(await pop.count(), 0, 'Esc dismisses the offer')
  assert.equal(await box.inputValue(), 'fo:yo', '… and keeps the query')
  await page.keyboard.type('r')
  await pop.waitFor()
  await page.keyboard.press('Enter')
  assert.equal(await box.inputValue(), 'fo:York-July-2026 ', '↵ completes the folder')
  assert.equal(await pop.count(), 0)
  await page.locator('[data-talk-slug="open-source"]').waitFor()
  assert.deepEqual(await slugsShown(), ['agents-research', 'frontier', 'inspectable', 'open-source', 'vibecoding-for-researchers', 'vibecoding-lab'])
  console.log('PASS L4: f → fo: fi:; fo:yo → York-July-2026 (6 talks) and day folders; Esc dismisses; ↵ and Tab complete')

  // L6 — prefixed terms stay as text; folder and date narrow to day 3.
  await box.fill('fo:york-july-2026 da:2026-07-22')
  await page.locator('.tl-res-head', { hasText: '3 talks' }).waitFor()
  assert.deepEqual(await slugsShown(), ['agents-research', 'inspectable', 'open-source'])
  assert.match(await rowText('inspectable'), /given\s+22 Jul 2026 · York-July-2026 \/ day-3/)
  assert.equal(await box.inputValue(), 'fo:york-july-2026 da:2026-07-22', 'no chips: the terms stay typed')
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L6-prefixed.png') })
  await box.fill('da:2026-07')
  await page.locator('.tl-res-head', { hasText: '7 talks' }).waitFor()
  assert.deepEqual(await slugsShown(), ['agents-research', 'frontier', 'inspectable', 'open-source', 'quiet-talk', 'vibecoding-for-researchers', 'vibecoding-lab'])
  await box.fill('da:jul')
  await page.locator('[data-talk-slug="given-last-year"]').waitFor()
  await box.fill('mondai')
  await page.locator('[data-talk-slug="mondai-tagged"]').waitFor()
  await page.locator('[data-talk-slug="mondai-slides"]').waitFor({ timeout: 30000 })
  await box.fill('co:mondai')
  await page.locator('.tl-res-head', { hasText: '1 talk' }).waitFor()
  assert.deepEqual(await slugsShown(), ['mondai-slides'], 'co: only slide text (the title-only talk is left out)')
  console.log('PASS L6: fo:york-july-2026 da:2026-07-22 → 3 day-3 talks; da:2026-07 → 7; da:jul includes 2025; co:mondai → slide text only')

  // L8 — nothing found: the nearest folder, Drop <term>, slide text; each works.
  const sugg = (kind, text) => page.locator(`[data-suggestion="${kind}"] button`, text ? { hasText: text } : {})
  await box.fill('fo:jersy da:2025')
  await page.getByText('No talks match “fo:jersy da:2025”.', { exact: true }).waitFor()
  assert.match(await page.locator('[data-suggestion="folder"]').innerText(), /Did you mean folder jersey-2026\? · 1 talk/)
  assert.deepEqual(await page.locator('.tl-empty-sugg').allInnerTexts(), ['Did you mean folder jersey-2026? · 1 talk', 'Drop da:2025', 'Search slide text too (co:)'])
  if (shots) await page.locator('.talk-list').screenshot({ path: join(shots, 'L8-suggestions.png') })
  await sugg('folder').click()
  assert.equal(await box.inputValue(), 'fo:jersey-2026 da:2025')
  await page.getByText('No talks match “fo:jersey-2026 da:2025”.', { exact: true }).waitFor()
  assert.deepEqual(await page.locator('.tl-empty-sugg').allInnerTexts(), ['Drop fo:jersey-2026', 'Drop da:2025', 'Search slide text too (co:)'])
  await sugg('drop', 'Drop da:2025').click()
  assert.equal(await box.inputValue(), 'fo:jersey-2026')
  await page.locator('[data-talk-slug="from-intern-to-toolmaker-jersey"]').waitFor()
  await box.fill('fo:jersy da:2025')
  await sugg('drop').waitFor()
  await sugg('drop').click()
  assert.equal(await box.inputValue(), 'fo:jersy')
  await box.fill('fo:jersy da:2025')
  await sugg('slides').waitFor()
  await sugg('slides').click()
  assert.equal(await box.inputValue(), 'co:jersy da:2025')
  assert(await boxFocused(), 'a suggestion leaves the focus in the box')
  console.log('PASS L8: fo:jersy da:2025 → "Did you mean folder jersey-2026?", "Drop da:2025", "Search slide text too (co:)", each rewrites the query')

  // Clearing the search returns the tree.
  await box.fill('')
  await page.locator('.tl-fhead').first().waitFor()
  assert.equal(await page.locator('.tl-res-head').count(), 0)
  assert.equal(await page.locator('.tw-errbound').count(), 0)
  assert.deepEqual(errors, [])
  console.log('PASS talk search e2e')
} catch (error) {
  if (app) {
    const page = await app.firstWindow()
    console.error('Test window:', (await page.locator('body').innerText()).slice(0, 3000))
  }
  throw error
} finally {
  if (app) await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
