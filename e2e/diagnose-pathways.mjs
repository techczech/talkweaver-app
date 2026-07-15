// Host gate for ADR-0038 parcel 1. Runs only against an isolated temp Vault/userData.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = process.cwd()
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-pathways-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
const talkDir = join(vault, 'pathway-probe')
const outlinePath = join(talkDir, 'pathway-probe-outline.md')
mkdirSync(talkDir, { recursive: true })
mkdirSync(userData, { recursive: true })

const slide = (id, title, body) => `### ${title}\n{id=${id}}\n\n${body}\n`
const originalOutline = [
  '---', 'title: Pathway probe', 'outline_version: 2', '---', '',
  '## Opening', '',
  slide('s1', 'One', 'First slide.'),
  slide('s2', 'Two', 'Second slide.'),
  '## Cases', '',
  slide('s3', 'Three', 'Third slide.'),
  slide('s4', 'Four', 'Fourth slide.'),
  slide('s5', 'Five', 'Unticked slide.')
].join('\n')
writeFileSync(outlinePath, originalOutline, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const waitForManifest = async (predicate, timeout = 8000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (predicate(manifest)) return manifest
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for pathway manifest')
}

const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, TW_REC_TEST: '1' } })
const editor = await app.firstWindow()
await editor.waitForLoadState('domcontentloaded')
await editor.getByText('Pathway probe', { exact: true }).first().click()
await editor.waitForSelector('.workspace')

// The in-app Deck menu is generated from the command register and must expose Pathways
// (Pathways is a per-deck surface, so it lives in Deck alongside Deck design / Metadata).
await editor.getByRole('button', { name: 'Deck', exact: true }).click()
const toolbarPathways = editor.getByRole('menuitem', { name: /Pathways/ })
record('in-app Deck menu contains registered Pathways command', await toolbarPathways.count() === 1)
const toolbarPathwayWindowPromise = app.waitForEvent('window')
await toolbarPathways.click()
const toolbarPathwayPage = await toolbarPathwayWindowPromise
await toolbarPathwayPage.waitForSelector('.twp')
record('in-app Deck Pathways command opens the separate window', (await app.windows()).length >= 2)
await toolbarPathwayPage.close()
await editor.bringToFront()

// Open through the registered command palette channel (not a direct IPC shortcut).
await editor.keyboard.press('Meta+Shift+P')
await editor.locator('.command-menu-input').fill('Pathways')
const pathwayWindowPromise = app.waitForEvent('window')
await editor.locator('.command-menu-item', { hasText: 'Pathways' }).first().click()
let pathwayPage = await pathwayWindowPromise
await pathwayPage.waitForSelector('.twp')
record('registered command opens a separate Pathway window', (await app.windows()).length >= 2)

await pathwayPage.getByRole('button', { name: /New pathway/ }).first().click()
await pathwayPage.getByLabel('Name').fill('Short route')
await pathwayPage.getByLabel('Note').fill('Host-gate pathway')
await pathwayPage.getByRole('button', { name: 'Create pathway' }).click()
await pathwayPage.waitForSelector('.twp-list button.selected')

await editor.bringToFront()
const pathwayBadge = editor.getByRole('button', { name: 'Open pathways for Pathway probe' })
await pathwayBadge.waitFor({ timeout: 8000 }).catch(() => {})
record('pathway mutation push shows the Talk badge with count one', await pathwayBadge.textContent().catch(() => '') === '1')
record('pathway badge tooltip lists manifest names', await pathwayBadge.getAttribute('title').catch(() => '') === 'Pathways: Short route')
await pathwayBadge.click().catch(() => {})
await pathwayPage.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 }).catch(() => {})
record('clicking the Talk badge opens that Talk in the Pathway window', await pathwayPage.evaluate(() => document.hasFocus()).catch(() => false))

for (const id of ['s1', 's2', 's3']) {
  await pathwayPage.locator(`.twp-card[data-slide-id="${id}"]`).click()
  await pathwayPage.locator(`.twp-card[data-slide-id="${id}"][data-ticked="true"]`).waitFor()
}
const manifestPath = join(vault, '_PRESENTATIONS', 'pathway-probe', 'manifest.json')
const manifestAfterGrid = await waitForManifest((manifest) => manifest.pathways?.[0]?.slideIds?.length === 3)
record('Grid ticks three slides and persists manifest order', JSON.stringify(manifestAfterGrid.pathways[0].slideIds) === JSON.stringify(['s1', 's2', 's3']), JSON.stringify(manifestAfterGrid.pathways[0].slideIds))

// Capture the shared slide set the Grid renders (every outline slide incl. auto title/section/
// thanks — ADR-0012: List uses the SAME 'all outline slides' model as Grid), then compare List.
const gridSlideIds = await pathwayPage.locator('.twp-card[data-slide-id]').evaluateAll((c) => c.map((x) => x.dataset.slideId))
const ROW_N = gridSlideIds.length
await pathwayPage.keyboard.press('l')
await pathwayPage.waitForSelector('[data-pathway-view="list"]')
record('L opens List with the same outline-order slide set as Grid', JSON.stringify(await pathwayPage.locator('.twp-list-row').evaluateAll((rows) => rows.map((row) => row.dataset.slideId))) === JSON.stringify(gridSlideIds), `${ROW_N} rows`)
record('List shows ticked rows numbered in pathway order', JSON.stringify(await pathwayPage.locator('.twp-list-row[data-ticked="true"] .twp-list-order').allTextContents()) === JSON.stringify(['1', '2', '3']))
await pathwayPage.locator('.twp-list-row[data-slide-id="s5"]').click()
await waitForManifest((manifest) => manifest.pathways?.[0]?.slideIds?.includes('s5'))
record('List row click uses the shared tick model', await pathwayPage.locator('.twp-list-row[data-slide-id="s5"][data-ticked="true"]').count() === 1)
await pathwayPage.locator('.twp-list-row[data-slide-id="s5"]').click()
await waitForManifest((manifest) => !manifest.pathways?.[0]?.slideIds?.includes('s5'))
record('List row click unticks through the same model', await pathwayPage.locator('.twp-list-row[data-slide-id="s5"][data-ticked="false"]').count() === 1)
record('List previews default on — one per row', await pathwayPage.locator('.twp-list-preview').count() === ROW_N)
const previewsToggle = pathwayPage.locator('[data-pathway-previews-toggle]')
record('List exposes the pressed Previews control', await previewsToggle.getAttribute('aria-pressed') === 'true')
await previewsToggle.click()
record('Previews off removes List thumbnails', await pathwayPage.locator('.twp-list-preview').count() === 0)
record('Previews off removes List snippets', await pathwayPage.locator('.twp-list-snippet').count() === 0)

await pathwayPage.keyboard.press('m')
await pathwayPage.waitForSelector('[data-pathway-view="matrix"]')
record('shared previews-off preference removes Matrix outline thumbnails', await pathwayPage.locator('.twp-matrix-preview').count() === 0)
await pathwayPage.keyboard.press('p')
record('P restores Matrix outline thumbnails — one per row', await pathwayPage.locator('.twp-matrix-preview').count() === ROW_N)
await pathwayPage.keyboard.press('l')
record('shared previews-on preference restores List thumbnails', await pathwayPage.locator('.twp-list-preview').count() === ROW_N)
await pathwayPage.keyboard.press('p')
record('P switches List previews off for persistence probe', await pathwayPage.locator('.twp-list-preview').count() === 0)

await pathwayPage.close()
await editor.bringToFront()
await editor.keyboard.press('Meta+Shift+P')
await editor.locator('.command-menu-input').fill('Pathways')
const reopenedPathwayWindowPromise = app.waitForEvent('window')
await editor.locator('.command-menu-item', { hasText: 'Pathways' }).first().click()
pathwayPage = await reopenedPathwayWindowPromise
await pathwayPage.waitForSelector('[data-pathway-view="list"]')
record('List view mode persists across Pathway window reopen', await pathwayPage.locator('[data-pathway-view="list"]').count() === 1)
record('previews-off preference persists across Pathway window reopen', await pathwayPage.locator('.twp-list-preview').count() === 0 && await pathwayPage.locator('[data-pathway-previews-toggle]').getAttribute('aria-pressed') === 'false')

await pathwayPage.keyboard.press('g')
await pathwayPage.waitForSelector('[data-pathway-view="grid"]')
record('Grid never exposes the Previews control', await pathwayPage.locator('[data-pathway-previews-toggle]').count() === 0)

await pathwayPage.keyboard.press('m')
await pathwayPage.waitForSelector('[data-pathway-view="matrix"]')
record('Matrix shows the same three ticks', await pathwayPage.locator('.twp-matrix td.selected .box.ticked').count() === 3)
await pathwayPage.locator('.twp-matrix button[data-slide-id="s4"]').first().click()
await pathwayPage.keyboard.press('g')
record('Matrix toggle agrees in Grid', await pathwayPage.locator('.twp-card[data-slide-id="s4"][data-ticked="true"]').count() === 1)

await pathwayPage.keyboard.press('Alt+r')
await pathwayPage.locator('.twp-card[data-slide-id="s4"]').focus()
await pathwayPage.keyboard.press('Meta+ArrowUp')
await pathwayPage.waitForTimeout(300)
const reordered = JSON.parse(readFileSync(manifestPath, 'utf8')).pathways[0].slideIds
record('⌘↑ reorders pathway order', JSON.stringify(reordered) === JSON.stringify(['s1', 's2', 's4', 's3']), JSON.stringify(reordered))
record('Grid order badge reflects reordered position', await pathwayPage.locator('.twp-card[data-slide-id="s4"] .twp-order').textContent() === '3')
await pathwayPage.keyboard.press('l')
record('List keeps outline row order after pathway reorder', JSON.stringify(await pathwayPage.locator('.twp-list-row').evaluateAll((rows) => rows.map((row) => row.dataset.slideId))) === JSON.stringify(gridSlideIds))
record('List always shows pathway order on ticked rows', await pathwayPage.locator('.twp-list-row[data-slide-id="s4"] .twp-list-order').textContent() === '3' && await pathwayPage.locator('.twp-list-row[data-slide-id="s3"] .twp-list-order').textContent() === '4')
await pathwayPage.keyboard.press('p')
record('List previews return after the persistence probe', await pathwayPage.locator('.twp-list-preview').count() === ROW_N)

const missingOutline = originalOutline.replace(/### Two\n\{id=s2\}\n\nSecond slide\.\n\n/, '')
// Remove the slide the way a user does: an in-app save through the editor's write channel,
// which pushes pathways:changed to the open Pathway window (the poll was removed by design;
// external non-app file edits are covered by the focus safety net, not exercised here).
await editor.evaluate(async ({ outlinePath, content }) => window.tw.talk.writeOutline(outlinePath, content), { outlinePath, content: missingOutline })
await pathwayPage.waitForSelector('[data-pathway-warning]', { timeout: 12000 })
record('removed heading produces missing-id warning bar', (await pathwayPage.locator('[data-pathway-warning]').textContent()).includes('no longer exist'))
record('List shows the removed slide as a struck, dashed-preview row', await pathwayPage.locator('.twp-list-row.missing[data-slide-id="s2"] .twp-list-preview').count() === 1)
await pathwayPage.keyboard.press('m')
record('Matrix shows a struck missing row and crimson cell', await pathwayPage.locator('.twp-matrix tr.missing td.missing-cell').count() === 1)
await pathwayPage.locator('[data-pathway-warning] button').click()
await pathwayPage.waitForTimeout(300)
record('drop action clears missing id', !JSON.parse(readFileSync(manifestPath, 'utf8')).pathways[0].slideIds.includes('s2'))
record('drop action clears warning', await pathwayPage.locator('[data-pathway-warning]').count() === 0)

const presenterWindowPromise = app.waitForEvent('window')
await pathwayPage.getByRole('button', { name: /Present this pathway/ }).click()
const presenter = await presenterWindowPromise
// Present opens PRESENTER mode (?presenter=1): main.deck is display:none by design, so the
// stage slides are attached but never "visible". Boot proof = the presenter chrome paints.
await presenter.waitForSelector('#stage .slide', { state: 'attached' })
await presenter.waitForSelector('#presenterRoot', { state: 'visible' })
const played = await presenter.evaluate(() => ({
  pathway: window.__talkWeaverPathway,
  slides: Array.from(document.querySelectorAll('#stage .slide')).map((slide) => slide.dataset.id),
  beats: (window.__deckBeats || []).map((beat) => beat.slideId)
}))
record('presenter records the pathway id', played.pathway?.id === manifestAfterGrid.pathways[0].id, JSON.stringify(played.pathway))
record('only ticked slides remain, in pathway order', JSON.stringify(played.slides) === JSON.stringify(['s1', 's4', 's3']), JSON.stringify(played.slides))
record('presenter beats follow pathway order', JSON.stringify(played.beats) === JSON.stringify(['s1', 's4', 's3']), JSON.stringify(played.beats))
record('filtered presenter file exists beside the Talk', existsSync(join(talkDir, `pathway-probe-pathway-${manifestAfterGrid.pathways[0].id}-present.html`)))

// A 50ms main-process ticker catches app-wide stalls while the open Pathway window sits idle.
// The test-only miss counter proves that idle time does not re-enter prepareSource even if event-loop
// drift happens to stay below the threshold on a fast host.
const idleProbe = await app.evaluate(async () => {
  const counter = () => globalThis.__twPrepareCount
  const before = counter()
  const intervalMs = 50
  let expected = Date.now() + intervalMs
  let maxDriftMs = 0
  const ticker = setInterval(() => {
    const now = Date.now()
    maxDriftMs = Math.max(maxDriftMs, now - expected)
    expected = now + intervalMs
  }, intervalMs)
  await new Promise((resolve) => setTimeout(resolve, 15_000))
  clearInterval(ticker)
  return { before, after: counter(), maxDriftMs }
})
record('TW_REC_TEST exposes the prepareSource miss counter', Number.isFinite(idleProbe.before), JSON.stringify(idleProbe))
record('idle Pathway window keeps main-process drift below 250ms', idleProbe.maxDriftMs < 250, `${idleProbe.maxDriftMs}ms`)
record('idle Pathway window does not run prepareSource', idleProbe.after === idleProbe.before, JSON.stringify(idleProbe))

await app.close()
if (failures) {
  console.error(`Pathway gate failed: ${failures} assertion${failures === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log('Pathway gate passed')
}
