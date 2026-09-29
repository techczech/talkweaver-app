// The slide picker's Files tree is the file list's tree (talk search ticket 04; ADR-0029 §4;
// frame K1), end to end in the built app: the York day folders nested at their real depth (two
// `day-3` folders stay apart), slide counts on talks and folder totals including subfolders, the
// Archive last and collapsed, click / ⌘-click scoping with columns for two and three talks, a
// talk expanding to its sections, and one folder memory shared with the file list.
// Fixture vault and a throwaway --user-data-dir; set TW_SHOTS=<dir> to save screenshots.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openPickerFolders } from './lib/picker-tree.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tw-picker-tree-'))
const userData = join(root, 'userData'), vault = join(root, 'vault')
mkdirSync(userData, { recursive: true })
function talk(rel, slug, title, sections) {
  const dir = join(vault, rel, slug)
  mkdirSync(dir, { recursive: true })
  const body = sections.map(([name, n]) => [`## ${name}`, '', ...Array.from({ length: n }, (_, i) => `### ${name} slide ${i + 1}\n\nText ${i + 1}\n`)].join('\n')).join('\n')
  writeFileSync(join(dir, `${slug}-outline.md`), `---\noutline_version: 2\ntitle: ${title}\n---\n\n${body}\n`)
}
const YORK = 'external-workshops/York-July-2026'
const ARCHIVE = 'z-old-powerpoint-imports'
talk('agents-2026', 'the-age-of-the-claw', 'The Age of the Claw', [['Opening', 2]])
talk('agents-2026', 'year-of-agents', 'AI 2026 - Year of Agents and Claws', [['Opening', 1], ['Claws', 2]])
talk(`${YORK}/day-1`, 'york-opening', 'York Opening Keynote', [['Welcome', 1]])
talk(`${YORK}/day-2`, 'york-workshop', 'York Workshop', [['Hands on', 2]])
talk(`${YORK}/day-3`, 'york-closing', 'York Closing Panel', [['Panel', 3]])
talk('ai-in-education/day-3', 'edu-day-three', 'Education Day Three', [['Morning', 1]])
talk(`${ARCHIVE}/ai-for-research`, 'old-research', 'Old Research Deck', [['Old', 1]])
const configFile = join(userData, 'config.json')
writeFileSync(configFile, JSON.stringify({ vaultRoot: vault }))

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

const tree = '.lt-browser-root .lt-ftree'
const folder = (path) => page.locator(`${tree} [data-folder-path="${path}"]`)
const talkRow = (slug) => page.locator(`${tree} [data-talk-slug="${slug}"]`)
const countOf = async (loc) => Number((await loc.locator('.lt-tc').textContent())?.trim())
const storedState = () => {
  try { return JSON.parse(readFileSync(configFile, 'utf8')).talkListFolders?.[vault] ?? {} } catch { return {} }
}

try {
  await openTalkByTitle(page, 'The Age of the Claw')
  await page.waitForTimeout(400)
  if (shots) await page.locator('aside.talk-list.tl-panel').first().screenshot({ path: join(shots, 'file-list-tree.png') })
  await page.keyboard.press('Meta+s')
  await page.locator('.lt-browser-root').waitFor()
  await page.locator(tree).waitFor()

  // ── every folder starts closed, the Archive too (one default and one folder memory with the
  //    file list; 0.34.0-preview.2 check); then the user opens them, the Archive excepted ──
  await folder('external-workshops').waitFor()
  const firstLaunch = await page.locator(`${tree} [data-folder-path]`).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-folder-path')} ${e.getAttribute('aria-expanded')}`))
  assert.deepEqual(firstLaunch, ['agents-2026 false', 'ai-in-education false', 'external-workshops false', `${ARCHIVE} false`],
    'first launch: only the top-level folders show, every one closed')
  if (shots) {
    await page.waitForFunction(() => !/searching/.test(document.querySelector('.lt-browser-root .lt-topbar')?.textContent ?? ''), null, { timeout: 15000 })
    await page.waitForTimeout(600)
    await page.locator('.lt-browser-root .lt-urail').first().screenshot({ path: join(shots, 'picker-files-start-collapsed.png') })
  }
  await openPickerFolders(page)
  console.log('PASS the picker’s Files tree starts with every folder closed, the Archive too')

  // ── K1: the York day folders nested, not a flat "day-3" ──
  for (const [path, level] of [['external-workshops', 1], [YORK, 2], [`${YORK}/day-1`, 3], [`${YORK}/day-2`, 3], [`${YORK}/day-3`, 3], ['ai-in-education/day-3', 2]]) {
    assert.equal(await folder(path).getAttribute('aria-level'), String(level), `${path} sits at level ${level}`)
  }
  const day3Names = await page.locator(`${tree} [data-folder-path$="/day-3"] .lt-tn`).allTextContents()
  assert.deepEqual(day3Names, ['day-3', 'day-3'], 'two day-3 folders, each in its own place')
  const order = await page.locator(`${tree} [data-folder-path]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-folder-path')))
  assert.ok(order.indexOf(YORK) < order.indexOf(`${YORK}/day-1`) && order.indexOf(`${YORK}/day-1`) < order.indexOf(`${YORK}/day-3`), 'York, then its days in order')
  const pad = async (path) => folder(path).evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft))
  assert.ok(await pad(`${YORK}/day-1`) > await pad(YORK) && await pad(YORK) > await pad('external-workshops'), 'each level indents further')
  console.log('PASS York day folders nested three levels deep; the two day-3 folders stay apart')

  // ── slide counts: talks, and folder totals including subfolders ──
  // Counts are the picker's own slide counts (the compiled projection: the title slide and
  // section dividers count, as in today's picker), so the fixture's 1/2/3 authored slides read
  // as three consecutive numbers.
  await page.waitForFunction(() => Number(document.querySelector('.lt-ftree [data-talk-slug="york-closing"] .lt-tc')?.textContent) > 0, null, { timeout: 20000 })
  const days = [await countOf(talkRow('york-opening')), await countOf(talkRow('york-workshop')), await countOf(talkRow('york-closing'))]
  assert.ok(days[0] > 0 && days[1] === days[0] + 1 && days[2] === days[1] + 1, `talk rows show their slide counts (${days})`)
  const yorkTotal = days[0] + days[1] + days[2]
  assert.equal(await countOf(folder(`${YORK}/day-3`)), days[2], 'a day folder totals its talk')
  assert.equal(await countOf(folder(YORK)), yorkTotal, 'York-July-2026 totals its three day folders')
  assert.equal(await countOf(folder('external-workshops')), yorkTotal, 'external-workshops totals its subfolders')
  assert.equal(await countOf(folder('agents-2026')), await countOf(talkRow('year-of-agents')) + await countOf(talkRow('the-age-of-the-claw')), 'agents-2026 totals its two talks')
  console.log('PASS slide counts on talks; folder totals include subfolders')

  // ── the Archive last, dimmed and collapsed ──
  assert.equal(order.at(-1), ARCHIVE, 'the Archive is the last folder')
  const archive = folder(ARCHIVE)
  assert.equal(await archive.locator('.lt-tn').textContent(), 'Archive · old PowerPoint imports')
  assert.equal(await archive.getAttribute('aria-expanded'), 'false', 'the Archive starts collapsed')
  assert.ok(Number(await archive.evaluate((e) => getComputedStyle(e).opacity)) < 1, 'the Archive is dimmed')
  assert.equal(await talkRow('old-research').count(), 0, 'nothing inside the Archive shows until it is opened')
  // The current talk stays listed, marked "current".
  assert.match(await talkRow('the-age-of-the-claw').textContent(), /current/)
  if (shots) {
    // Shoot once the table has settled (the whole Browser dims while a search is in flight).
    await page.waitForFunction(() => !/searching/.test(document.querySelector('.lt-browser-root .lt-topbar')?.textContent ?? ''), null, { timeout: 15000 })
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(shots, 'picker-files-tree.png') })
    await page.locator('.lt-browser-root .lt-urail').first().screenshot({ path: join(shots, 'picker-rail.png') })
  }
  console.log('PASS Archive last, dimmed and collapsed; the current talk is marked')

  // ── scope: click replaces, ⌘-click adds/removes, columns for two and three talks ──
  const scopeNames = () => page.locator('.lt-browser-root .lt-scope-row .lt-scope-nm').allTextContents()
  const columns = () => page.locator('.lt-browser-root .lt-colwrap .lt-col').count()
  await talkRow('york-opening').click()
  await talkRow('york-workshop').click()
  assert.deepEqual(await scopeNames(), ['York Workshop'], 'a click replaces the scope')
  await talkRow('york-closing').click({ modifiers: ['Meta'] })
  await page.waitForTimeout(300)
  assert.equal(await columns(), 2, 'two talks side by side')
  await talkRow('year-of-agents').click({ modifiers: ['Meta'] })
  await page.waitForTimeout(300)
  assert.equal(await columns(), 3, 'three talks side by side')
  if (shots) await page.screenshot({ path: join(shots, 'picker-three-columns.png') })
  await talkRow('york-closing').click({ modifiers: ['Meta'] })
  await page.waitForTimeout(300)
  assert.deepEqual(await scopeNames(), ['York Workshop', 'AI 2026 - Year of Agents and Claws'], '⌘-click removes a talk')
  assert.equal(await columns(), 2)
  // A folder scope takes in its subfolders: York day-3 alone, never ai-in-education/day-3.
  await folder(`${YORK}/day-3`).click()
  assert.deepEqual(await scopeNames(), ['external-workshops › York-July-2026 › day-3'])
  await page.waitForTimeout(300)
  const table = await page.locator('.lt-browser-root .lt-table-scroll').innerText()
  assert.ok(table.includes('York Closing Panel'), 'York day-3 scope shows the York day-3 talk')
  assert.ok(!table.includes('Education Day Three') && !table.includes('York Workshop'), 'and never the other day-3 or another York day')
  await page.locator('.lt-browser-root .lt-scope-rm').first().click()
  console.log('PASS click replaces, ⌘-click adds and removes; two and three columns; folder scope by full path')

  // ── a talk still expands to its sections ──
  await talkRow('year-of-agents').locator('.lt-disc').click()
  const secs = await page.locator(`${tree} [data-section-of="year-of-agents"] .lt-tn`).allTextContents()
  assert.deepEqual(secs, ['Opening', 'Claws'], 'the talk expands to its sections')
  assert.equal(await page.locator('.lt-browser-root .lt-scope-row').count(), 0, 'expanding does not scope')
  console.log('PASS a talk expands to its sections without scoping')

  // ── one folder memory with the file list ──
  await folder(YORK).locator('.lt-disc').click()
  assert.equal(await folder(YORK).getAttribute('aria-expanded'), 'false')
  assert.equal(await folder(`${YORK}/day-1`).count(), 0, 'closing York hides its days')
  await page.waitForTimeout(300)
  assert.equal(storedState()[YORK], false, 'the choice is stored with the file list\'s folder state')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  if (await page.locator('.lt-browser-root').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
  // Folders start closed in the file list (0.34.0-preview.2 check), so York's parent, untouched,
  // is closed there: open it to see York.
  const parent = YORK.split('/').slice(0, -1).join('/')
  if (parent && await page.locator(`.tl-tree [data-folder-path="${parent}"]`).getAttribute('aria-expanded') === 'false') {
    await page.locator(`.tl-tree [data-folder-path="${parent}"]`).click()
  }
  const listHeader = page.locator(`.tl-tree [data-folder-path="${YORK}"]`)
  assert.equal(await listHeader.getAttribute('aria-expanded'), 'false', 'the file list shows York closed too')
  console.log('PASS one folder memory: a folder closed in the picker is closed in the file list, and stored')

  assert.deepEqual(errors, [], 'no renderer errors')
  console.log('PASS picker Files tree e2e')
} finally {
  await app.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
